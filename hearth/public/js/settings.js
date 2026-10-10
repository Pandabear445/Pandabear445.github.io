// User settings: profile customization (all free), account, voice & audio, appearance.
import { h, clear, icon, toast, playSound } from './util.js';
import { api, upload } from './api.js';
import { EVENTS as SOUND_EVENTS, LIBRARY as SOUND_LIBRARY, soundPrefs, setSoundPrefs, resetSoundPrefs, setCustomSound, customSoundName } from './sounds.js';
import * as E2EE from './e2ee.js';
import { profileCard, FONT_STACKS, cropStyle, customFxLayer } from './profile-ui.js';
import { pageEditorTab } from './page.js';
import { openCropper } from './cropper.js';
import { modal, confirmDialog, field } from './ui.js';
import { runExport, EXPORT_LIMITS, quietNow } from './usability.js';
import { androidApp } from './android.js';
import { desktopSettingsSection } from './desktop-settings.js';
import { pickGame, gameImg, openActivityPicker, startDesktopDetection } from './activity.js';
import { getKeybinds, saveKeybinds, comboLabel, recordCombo, DEFAULT_KEYBINDS } from './keybinds.js';
import {
  THEMES, BACKGROUNDS, LAYOUT_PRESETS, DEFAULTS, UI_FONTS, CORNERS, loadAppearance, saveAppearance, resetAppearance, applyAppearance,
  gradientCss, canAnimate, isSolid, saveBgImage, loadBgImage, clearBgImage, exportAppearance, importAppearance,
} from './appearance.js';

export { applyAppearance };

// ------------------------------------------------------------------ small form helpers
function chips(options, value, onChange, { render } = {}) {
  const wrap = h('div', { class: 'chips', role: 'radiogroup' });
  const draw = (current) => {
    clear(wrap);
    options.forEach(([val, label]) => wrap.append(h('button', {
      type: 'button',
      class: `chip${val === current ? ' active' : ''}`,
      role: 'radio',
      'aria-checked': String(val === current),
      onclick: () => { draw(val); onChange(val); },
    }, render ? render(val, label) : label)));
  };
  draw(value);
  return wrap;
}

function colorInput(value, onChange, label) {
  const swatch = h('input', { type: 'color', class: 'color-in', value: value || '#000000', 'aria-label': label });
  const text = h('input', { class: 'input hex-in', value: value || '', maxlength: '7', spellcheck: 'false', 'aria-label': `${label} hex` });
  swatch.addEventListener('input', () => { text.value = swatch.value; onChange(swatch.value); });
  text.addEventListener('input', () => {
    let v = text.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) { swatch.value = v; onChange(v.toLowerCase()); }
  });
  return h('div', { class: 'color-row' }, swatch, text);
}

function toggle(label, checked, onChange, hint) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
  return h('label', { class: 'toggle-row' },
    h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, label), hint ? h('span', { class: 'field-hint' }, hint) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch-track' })));
}

function section(title, ...kids) {
  return h('section', { class: 'set-section' }, title ? h('h3', { class: 'set-h' }, title) : null, kids);
}
// A section that starts closed: for the extras most people set once (or never), so a page isn't a wall of options.
function fold(title, hint, ...kids) {
  return h('details', { class: 'set-section set-fold' },
    h('summary', null, h('span', { class: 'set-h' }, title), hint ? h('span', { class: 'set-fold-hint' }, hint) : null, icon('chevronRight')),
    h('div', { class: 'set-fold-body' }, kids));
}

// ------------------------------------------------------------------ the modal
// Grouped like most chat apps so people can find things: [group label, [[key, label, icon], ...]]
// Closely related pages share one entry and switch with tabs at the top (SUBTABS), which keeps the list short.
const TAB_GROUPS = [
  ['Account', [['profile', 'Profile', 'user'], ['account', 'Security', 'lock'], ['privacy', 'Privacy & safety', 'shield'], ['study', 'Study tools', 'graduation']]],
  ['App', [['appearance', 'Appearance', 'palette'], ['chat', 'Chat', 'message'], ['notifications', 'Notifications', 'bell'], ['voice', 'Voice & video', 'mic'], ['keybinds', 'Keybinds', 'monitor'], ['apps', 'Apps & devices', 'download']]],
  ['Servers', [['servers', 'Server settings', 'gear'], ['instance', 'Instance', 'monitor', 'admin']]],
];
const SUBTABS = {
  profile: [['profile', 'Profile card'], ['page', 'Profile page'], ['activity', 'Games & music']],
  account: [['account', 'Security & storage'], ['storage', 'Storage'], ['sessions', 'Signed-in devices']],
  appearance: [['appearance', 'Theme'], ['layout', 'Layout']],
};
const parentTab = (k) => Object.keys(SUBTABS).find((p) => SUBTABS[p].some(([s]) => s === k)) || k;

let micTest = null;
function stopMicTest() {
  if (!micTest) return;
  cancelAnimationFrame(micTest.raf);
  micTest.stream.getTracks().forEach((t) => t.stop());
  micTest.ctx.close().catch(() => {});
  micTest = null;
}

export function openSettings(app, tab = 'profile') {
  let current = tab;
  let dirty = false;
  const nav = h('nav', { class: 'set-nav', 'aria-label': 'Settings sections' });
  const content = h('div', { class: 'set-content' });
  const shell = h('div', { class: 'settings' }, nav, h('div', { class: 'set-main' },
    h('button', { class: 'icon-btn set-close', 'aria-label': 'Close settings', onclick: () => tryClose() }, icon('close')),
    content));

  const m = modal({ size: 'full', className: 'settings-modal', body: shell, onClose: stopMicTest });

  async function tryClose() {
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', text: 'You have changes that are not saved yet.', confirm: 'Discard', danger: true }))) return;
    dirty = false;
    m.close();
  }

  const drawNav = () => {
    clear(nav);
    TAB_GROUPS.forEach(([group, tabs]) => {
      nav.append(h('div', { class: 'set-nav-label' }, group));
      tabs.filter(([, , , who]) => who !== 'admin' || app.S.me.instanceAdmin).forEach(([k, label, ic]) => nav.append(h('button', {
        class: `set-nav-btn${k === parentTab(current) ? ' active' : ''}`,
        'aria-current': k === parentTab(current) ? 'page' : null,
        onclick: () => go(k),
      }, icon(ic), label)));
    });
    nav.append(h('div', { class: 'set-nav-sep' }));
    nav.append(h('button', { class: 'set-nav-btn danger', onclick: async () => {
      if (await confirmDialog({ title: 'Log out?', text: 'Your encryption key is removed from this browser. Log back in with your password to read your DMs again.', confirm: 'Log out', danger: true })) app.logout();
    } }, 'Log out'));
  };

  const go = async (k) => {
    if (k === current) return;
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', text: 'You have profile changes that are not saved yet.', confirm: 'Discard', danger: true }))) return;
    dirty = false;
    current = k;
    draw();
  };

  const draw = () => {
    stopMicTest();
    drawNav();
    clear(content);
    const subs = SUBTABS[parentTab(current)];
    if (subs) {
      content.append(h('div', { class: 'set-subtabs', role: 'tablist' }, subs.map(([k, label]) => h('button', {
        class: `set-subtab${k === current ? ' active' : ''}`, role: 'tab', 'aria-selected': String(k === current), onclick: () => go(k),
      }, label))));
    }
    const views = { study: studyTab, keybinds: keybindsTab, activity: activityTab, page: pageEditorTab, instance: instanceTab, apps: appsTab, layout: layoutTab, profile: profileTab, account: accountTab, storage: storageTab, sessions: sessionsTab, voice: voiceTab, appearance: appearanceTab, chat: chatTab, notifications: notificationsTab, privacy: privacyTab, servers: serversTab };
    content.append(views[current](app, (d) => { dirty = d; }, go));
    content.scrollTop = 0;
  };
  draw();
}

// ------------------------------------------------------------------ profile tab
const PRESETS = [
  { name: 'Ember', bannerColor: '#f2a541', themePrimary: '#3a2418', themeSecondary: '#1b1412', accentColor: '#f2a541' },
  { name: 'Ocean', bannerColor: '#2f8fd8', themePrimary: '#123049', themeSecondary: '#0b1622', accentColor: '#5cc8ff' },
  { name: 'Forest', bannerColor: '#3f9b5a', themePrimary: '#1b3a26', themeSecondary: '#0f1a13', accentColor: '#7fdc8f' },
  { name: 'Sakura', bannerColor: '#f29cc0', themePrimary: '#4a2236', themeSecondary: '#1e1219', accentColor: '#ff9ccf' },
  { name: 'Synthwave', bannerColor: '#ff4fd8', themePrimary: '#2b1050', themeSecondary: '#0d0b2a', accentColor: '#4ff0ff' },
  { name: 'Mono', bannerColor: '#d9d9d9', themePrimary: '#2a2a2a', themeSecondary: '#111111', accentColor: '#ffffff' },
  { name: 'Blood moon', bannerColor: '#b3263a', themePrimary: '#3d0f17', themeSecondary: '#14070a', accentColor: '#ff5c6c' },
  { name: 'Lemonade', bannerColor: '#f5e663', themePrimary: '#3f3a14', themeSecondary: '#17150a', accentColor: '#fff27a' },
];

function profileTab(app, setDirty) {
  const S = app.S;
  const CROPS = ['avatarCrop', 'bannerCrop', 'backgroundCrop'];
  const withoutCrops = (p) => { const o = { ...(p || {}) }; CROPS.forEach((k) => delete o[k]); return o; };
  const original = JSON.stringify(withoutCrops(S.me.profile));
  const draft = JSON.parse(original);
  draft.links = Array.isArray(draft.links) ? draft.links : [];
  draft.customStatus = draft.customStatus || { emoji: '', text: '' };

  const previewHost = h('div', { class: 'set-preview-card' });
  const saveBar = h('div', { class: 'save-bar', hidden: true },
    h('span', null, 'Careful — you have unsaved changes.'),
    h('button', { class: 'btn ghost sm', onclick: () => resetAll() }, 'Reset'),
    h('button', { class: 'btn primary sm', onclick: () => save() }, 'Save changes'));

  const changed = () => {
    const d = JSON.stringify(draft) !== original;
    saveBar.hidden = !d;
    setDirty(d);
    redrawPreview();
  };
  const redrawPreview = () => {
    clear(previewHost).append(profileCard({ ...S.me, profile: { ...S.me.profile, ...draft } }, { meId: S.me.id }));
  };
  const set = (k) => (v) => { draft[k] = v; changed(); };

  let body;
  const resetAll = () => {
    Object.keys(draft).forEach((k) => delete draft[k]);
    Object.assign(draft, JSON.parse(original));
    setDirty(false);
    const fresh = profileTab(app, setDirty);
    body.replaceWith(fresh);
  };

  const save = async () => {
    try {
      const u = await api('PATCH', '/me/profile', draft);
      app.onMe(u);
      setDirty(false);
      toast('Profile saved.');
      const fresh = profileTab(app, setDirty);
      body.replaceWith(fresh);
    } catch (e) { toast(e.message, 'error'); }
  };

  // --- media
  const mediaRow = (kind, label, hint) => {
    const has = !!S.me[kind];
    const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
    const prog = h('div', { class: 'upload-progress', hidden: true }, h('div', { class: 'bar' }));
    const shape = () => draft.avatarShape || 'circle';
    // New picture: position it first, then upload it together with its crop.
    fileIn.addEventListener('change', () => {
      const f = fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      if (f.size > (app.S.config.imageMb || 12) * 1024 * 1024) return toast(`Images can be up to ${app.S.config.imageMb || 12} MB.`, 'error');
      const url = URL.createObjectURL(f);
      openCropper({
        src: url, kind, shape: shape(), saveLabel: 'Upload',
        title: `Position your ${label.toLowerCase()}`,
        onSave: async (crop) => {
          const fd = new FormData();
          fd.append('file', f, f.name);
          fd.append('crop', JSON.stringify(crop));
          prog.hidden = false;
          try {
            const u = await upload(`/me/media/${kind}`, fd, (x) => { prog.firstChild.style.width = Math.round(x * 100) + '%'; });
            app.onMe(u);
            toast(`${label} updated.`);
            refreshMedia();
          } finally { prog.hidden = true; URL.revokeObjectURL(url); }
        },
      });
    });
    // Existing picture: re-adjust any time without re-uploading.
    const adjust = () => openCropper({
      src: S.me[kind], kind, shape: shape(), crop: (S.me.profile || {})[kind + 'Crop'],
      onSave: async (crop) => {
        app.onMe(await api('PATCH', '/me/profile', { [kind + 'Crop']: crop }));
        toast(`${label} position saved.`);
        refreshMedia();
      },
    });
    const thumb = h('button', { class: `media-thumb mt-${kind}${kind === 'avatar' ? ' mask-' + shape() : ''}`, 'aria-label': has ? `Adjust ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`, onclick: () => (has ? adjust() : fileIn.click()) },
      has ? h('img', { class: 'cropped', src: S.me[kind], alt: '', style: cropStyle((S.me.profile || {})[kind + 'Crop']) }) : h('span', null, 'None'));
    return h('div', { class: 'media-row' }, thumb,
      h('div', { class: 'media-text' }, h('strong', null, label), h('span', { class: 'field-hint' }, hint), prog),
      h('div', { class: 'media-actions' },
        h('button', { class: 'btn primary sm', onclick: () => fileIn.click() }, has ? 'Change' : 'Upload'),
        has ? h('button', { class: 'btn ghost sm', onclick: adjust }, icon('maximize'), 'Adjust') : null,
        has ? h('button', { class: 'btn ghost sm', onclick: async () => {
          try { app.onMe(await api('DELETE', `/me/media/${kind}`)); refreshMedia(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Remove') : null),
      fileIn);
  };
  const mediaHost = h('div', { class: 'media-list' });
  const refreshMedia = () => {
    clear(mediaHost).append(
      mediaRow('avatar', 'Avatar', 'PNG, JPG, WebP or GIF'),
      mediaRow('banner', 'Banner', 'Across the top of your profile'),
      mediaRow('background', 'Profile background', 'Behind your whole profile card'),
      toggle('Show banner', draft.showBanner !== false, (v) => { set('showBanner')(v); }, 'Off: the background fills the whole card.'),
    );
    redrawPreview();
  };

  // --- identity
  const displayName = h('input', { class: 'input', maxlength: '32', value: draft.displayName || '', oninput: (e) => set('displayName')(e.target.value) });
  const pronouns = h('input', { class: 'input', maxlength: '40', value: draft.pronouns || '', placeholder: 'they/them', oninput: (e) => set('pronouns')(e.target.value) });
  const bioCount = h('span', { class: 'counter' }, `${(draft.bio || '').length}/1200`);
  const bio = h('textarea', { class: 'input', rows: '5', maxlength: '1200', placeholder: 'Tell people about yourself. **Markdown** works.', oninput: (e) => { bioCount.textContent = `${e.target.value.length}/1200`; set('bio')(e.target.value); } });
  bio.value = draft.bio || '';
  const csEmoji = h('input', { class: 'input emoji-input', maxlength: '16', value: draft.customStatus.emoji || '', placeholder: '😊', 'aria-label': 'Status emoji', oninput: (e) => { draft.customStatus = { ...draft.customStatus, emoji: e.target.value }; changed(); } });
  const csText = h('input', { class: 'input', maxlength: '128', value: draft.customStatus.text || '', placeholder: "What's happening?", 'aria-label': 'Status text', oninput: (e) => { draft.customStatus = { ...draft.customStatus, text: e.target.value }; changed(); } });

  // --- name style
  const gradOn = !!draft.nameColor2;
  // Up to four name colors: the 3rd and 4th are optional extras on top of a gradient.
  const extraColors = h('div', { class: 'stack' });
  const drawExtraColors = () => {
    clear(extraColors);
    if (!draft.nameColor2) return;
    [['nameColor3', 'Third color'], ['nameColor4', 'Fourth color']].forEach(([k, label], i) => {
      if (i === 1 && !draft.nameColor3) return;
      extraColors.append(h('div', { class: 'row gap' }, draft[k]
        ? colorInput(draft[k], (v) => { draft[k] = v; changed(); }, label)
        : h('button', { class: 'btn ghost sm', onclick: () => { draft[k] = i ? '#38c6d9' : '#b07cff'; drawExtraColors(); changed(); } }, `+ ${label}`),
      draft[k] ? h('button', { class: 'icon-btn sm', 'aria-label': `Remove ${label.toLowerCase()}`, onclick: () => { draft[k] = ''; if (k === 'nameColor3') draft.nameColor4 = ''; drawExtraColors(); changed(); } }, icon('close')) : null));
    });
  };
  drawExtraColors();
  const color2Wrap = h('div', { hidden: !gradOn }, colorInput(draft.nameColor2 || '#f2a541', (v) => { draft.nameColor2 = v; changed(); }, 'Second name color'), extraColors);
  const glowWrap = h('div', { hidden: !draft.nameGlow }, colorInput(draft.nameGlow || '#ff4fa3', (v) => { draft.nameGlow = v; changed(); }, 'Glow color'));
  const fontSelect = h('select', { class: 'input', onchange: (e) => set('nameFont')(e.target.value) },
    Object.keys(FONT_STACKS).map((f) => h('option', { value: f, style: { fontFamily: FONT_STACKS[f] } }, f === 'default' ? 'Default' : f)));
  fontSelect.value = draft.nameFont || 'default';

  // --- links
  const linksHost = h('div', { class: 'links-edit' });
  const drawLinks = () => {
    clear(linksHost);
    draft.links.forEach((l, i) => linksHost.append(h('div', { class: 'link-edit-row' },
      h('input', { class: 'input', maxlength: '32', placeholder: 'Label', value: l.label || '', 'aria-label': 'Link label', oninput: (e) => { draft.links[i] = { ...draft.links[i], label: e.target.value }; changed(); } }),
      h('input', { class: 'input', maxlength: '300', placeholder: 'https://…', value: l.url || '', 'aria-label': 'Link URL', oninput: (e) => { draft.links[i] = { ...draft.links[i], url: e.target.value.trim() }; changed(); } }),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Remove link', onclick: () => { draft.links.splice(i, 1); drawLinks(); changed(); } }, icon('close')))));
    if (draft.links.length < 6) linksHost.append(h('button', { class: 'btn ghost sm', onclick: () => { draft.links.push({ label: '', url: '' }); drawLinks(); changed(); } }, '+ Add link'));
  };
  drawLinks();

  // ---- build-your-own effect
  const FX_DEFAULT = { glyphs: '✦★', motion: 'fall', count: 16, speed: 5, size: 16, color: '', glow: false };
  draft.customFx = { ...FX_DEFAULT, ...(draft.customFx || {}) };
  const fxDemo = h('div', { class: 'fx-demo', style: { '--c1': draft.themePrimary, '--c2': draft.themeSecondary } });
  const drawDemo = () => { const l = customFxLayer(draft.customFx); clear(fxDemo); if (l) fxDemo.append(l); };
  const setFx = (k) => (v) => { draft.customFx = { ...draft.customFx, [k]: v }; drawDemo(); changed(); };
  const fxColorWrap = h('div', { hidden: !draft.customFx.color }, colorInput(draft.customFx.color || '#ffe27a', setFx('color'), 'Effect color'));
  const fxHost = h('div', { class: 'fx-builder', hidden: draft.profileEffect !== 'custom' },
    h('strong', null, 'Your own effect'),
    fxDemo,
    field('Characters or emoji', h('input', { class: 'input', maxlength: '60', value: draft.customFx.glyphs, placeholder: '🍕👽✨', oninput: (e) => setFx('glyphs')(e.target.value) }), 'Up to 6. They take turns: type 🐸🌈 for frogs and rainbows.'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'How they move'),
      chips([['fall', 'Fall'], ['rise', 'Rise'], ['float', 'Float up'], ['drift', 'Drift sideways'], ['twinkle', 'Twinkle'], ['spin', 'Spin'], ['zoom', 'Zoom'], ['bounce', 'Bounce']], draft.customFx.motion, setFx('motion'))),
    sliderRow('How many', 4, 40, 1, draft.customFx.count, (v) => `${v}`, setFx('count')),
    sliderRow('Speed', 1, 10, 1, draft.customFx.speed, (v) => `${v}`, setFx('speed')),
    sliderRow('Size', 8, 48, 1, draft.customFx.size, (v) => `${v}px`, setFx('size')),
    toggle('Color them (for plain characters like ★ ♥ ✦)', !!draft.customFx.color, (on) => { fxColorWrap.hidden = !on; setFx('color')(on ? '#ffe27a' : ''); }, 'Emoji keep their own colors.'),
    fxColorWrap,
    toggle('Glow', !!draft.customFx.glow, setFx('glow')));
  drawDemo();

  const presetRow = h('div', { class: 'presets' }, PRESETS.map((p) => h('button', {
    type: 'button',
    class: 'preset',
    title: p.name,
    style: { '--p1': p.bannerColor, '--p2': p.themePrimary, '--p3': p.themeSecondary },
    onclick: () => {
      Object.assign(draft, { bannerColor: p.bannerColor, themePrimary: p.themePrimary, themeSecondary: p.themeSecondary, accentColor: p.accentColor });
      colorsHost.replaceWith(colorsHost = drawColors());
      changed();
    },
  }, h('span', { class: 'preset-sw' }), h('span', { class: 'preset-name' }, p.name))));

  const drawColors = () => h('div', { class: 'grid-2' },
    field('Banner color', colorInput(draft.bannerColor, set('bannerColor'), 'Banner color'), 'Used when you have no banner image.'),
    field('Accent', colorInput(draft.accentColor, set('accentColor'), 'Accent color'), 'Borders and highlights on your card.'),
    field('Card color — top', colorInput(draft.themePrimary, set('themePrimary'), 'Card primary color')),
    field('Card color — bottom', colorInput(draft.themeSecondary, set('themeSecondary'), 'Card secondary color')));
  let colorsHost = drawColors();

  const form = h('div', { class: 'set-form' },
    h('h2', { class: 'set-title' }, 'My profile'),
    section('About you',
      field('Display name', displayName, 'Shown instead of your username.'),
      field('Pronouns', pronouns),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'About me', bioCount), bio),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Custom status'), h('div', { class: 'row gap' }, csEmoji, csText))),
    section('Pictures', mediaHost),
    fold('Name style', 'Color, gradient, font and effects',
      h('div', { class: 'grid-2' },
        field('Name color', colorInput(draft.nameColor, set('nameColor'), 'Name color')),
        h('div', { class: 'field' }, toggle('Gradient name', gradOn, (on) => {
          color2Wrap.hidden = !on;
          draft.nameColor2 = on ? (draft.nameColor2 || '#f2a541') : '';
          if (!on) { draft.nameColor3 = ''; draft.nameColor4 = ''; }
          drawExtraColors();
          changed();
        }), color2Wrap)),
      field('Name font', fontSelect),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Name effect'),
        chips([['none', 'None'], ['glow', 'Glow'], ['neon', 'Neon'], ['shimmer', 'Shimmer'], ['rainbow', 'Rainbow'], ['flow', 'Flowing colors'], ['pulse', 'Pulse'], ['wave', 'Wave'], ['glitch', 'Glitch'], ['outline', 'Outline'], ['shadow', 'Retro shadow']], draft.nameEffect || 'none', set('nameEffect'))),
      h('div', { class: 'field' }, toggle('Pick the glow / outline / shadow color', !!draft.nameGlow, (on) => { draft.nameGlow = on ? (draft.nameGlow || '#ff4fa3') : ''; glowWrap.hidden = !on; changed(); }), glowWrap)),
    fold('Avatar shape & ring', null,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Shape'),
        chips([['circle', 'Circle'], ['rounded', 'Rounded'], ['square', 'Square'], ['hexagon', 'Hexagon']], draft.avatarShape || 'circle', set('avatarShape'))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Ring'),
        chips([['none', 'None'], ['solid', 'Solid'], ['gradient', 'Gradient'], ['rainbow', 'Rainbow'], ['glow', 'Glow'], ['pulse', 'Pulse'], ['spin', 'Spinning colors'], ['double', 'Double'], ['dashed', 'Dashed spinner']], draft.avatarRing || 'none', set('avatarRing'))),
      h('div', { class: 'grid-2' },
        field('Ring color', colorInput(draft.ringColor, set('ringColor'), 'Ring color')),
        field('Second color', colorInput(draft.ringColor2 || draft.accentColor || '#f2a541', set('ringColor2'), 'Second ring color'), 'Gradient, glow, double and spinning rings use it.')),
      field('Third color (spinning ring)', colorInput(draft.ringColor3 || '#38c6d9', set('ringColor3'), 'Third ring color')),
      sliderRow('Spin speed', 1, 10, 1, draft.ringSpeed || 4, (v) => `${v}`, (v) => { draft.ringSpeed = v; changed(); })),
    fold('Card theme', 'Presets, colors and effects',
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Presets'), presetRow),
      colorsHost,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Card style'),
        chips([['solid', 'Solid'], ['gradient', 'Gradient'], ['glass', 'Glass']], draft.cardStyle || 'gradient', set('cardStyle'))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Profile effect'),
        chips([['none', 'None'], ['sparkles', '✦ Sparkles'], ['snow', '❄ Snow'], ['hearts', '♥ Hearts'], ['stars', '★ Stars'], ['bubbles', '◯ Bubbles'], ['embers', '🔥 Embers'], ['sakura', '✿ Cherry blossoms'], ['confetti', '🎉 Confetti'], ['rain', '🌧 Rain'], ['fireflies', '✨ Fireflies'], ['custom', '🛠 Make your own']], draft.profileEffect || 'none', (v) => { set('profileEffect')(v); fxHost.hidden = v !== 'custom'; }),
        fxHost)),
    profilePageSection(app, draft, set),
    fold('Links', 'Up to 6', linksHost),
  );

  body = h('div', { class: 'set-profile' },
    form,
    h('aside', { class: 'set-preview' }, h('div', { class: 'set-preview-label' }, 'Preview'), previewHost),
    saveBar);
  refreshMedia();
  return body;
}

// ------------------------------------------------------------------ account tab
function accountTab(app, setDirty, go) {
  const S = app.S;
  const fp = h('code', { class: 'fingerprint' }, '…');
  E2EE.keyFingerprint(S.me).then((f) => { fp.textContent = f; }).catch(() => { fp.textContent = 'Unavailable'; });

  const oldPw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const newPw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const confirmPw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const msg = h('p', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    msg.textContent = '';
    if (newPw.value.length < 8) { msg.textContent = 'Use at least 8 characters for your new password.'; return; }
    if (newPw.value !== confirmPw.value) { msg.textContent = 'The new passwords do not match.'; return; }
    btn.disabled = true;
    btn.textContent = 'Re-encrypting your key…';
    try {
      const salt = E2EE.newKdfSalt();
      const oldParams = S.me.kdf === 'argon2id' ? { kdf: 'argon2id', salt: S.me.kdfSalt } : { kdf: 'pbkdf2' };
      const oldK = await E2EE.deriveKeys(S.me.username, oldPw.value, oldParams);
      const newK = await E2EE.deriveKeys(S.me.username, newPw.value, { kdf: 'argon2id', salt });
      const locked = await lockedKey(oldK.authKey).catch((x) => { throw x.code === 'bad_password' ? new Error('Your current password is not right.') : x; });
      let enc;
      try { enc = await E2EE.rewrapPrivateKey(oldK.wrapKey, newK.wrapKey, locked); } catch { throw new Error('Your current password is not right.'); }
      await withCode((x) => api('POST', '/me/password', { oldAuthKey: oldK.authKey, newAuthKey: newK.authKey, encPrivateKey: enc, salt, ...x }));
      S.me = { ...S.me, kdf: 'argon2id', kdfSalt: salt };
      oldPw.value = ''; newPw.value = ''; confirmPw.value = '';
      toast('Password changed. Other devices were logged out.');
    } catch (e) {
      if (!e.cancelled) msg.textContent = e.message;
    } finally { btn.disabled = false; btn.textContent = 'Change password'; }
  } }, 'Change password');

  // Storage: what you've uploaded against the server's limits.
  const storage = h('div', { class: 'stack' }, h('span', { class: 'field-hint' }, 'Loading\u2026'));
  api('GET', '/me/storage').then((q) => {
    const MB = 1024 * 1024;
    const mb = (b) => `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`;
    const pct = q.quotaMb ? Math.min(100, (q.used / (q.quotaMb * MB)) * 100) : 0;
    const kinds = { attachment: 'Files in messages', image: 'Pictures', song: 'Songs', emoji: 'Emoji', gif: 'GIF library', reserved: 'Uploads in progress' };
    clear(storage).append(...[
      q.blocked ? h('p', { class: 'key-bar bad' }, icon('ban'), 'An admin has turned off uploads for your account.') : null,
      h('div', { class: 'kv' }, h('span', null, 'Used'), h('strong', null, q.quotaMb ? `${mb(q.used)} of ${q.quotaMb} MB` : `${mb(q.used)} (no limit)`)),
      q.quotaMb ? h('div', { class: `storage-bar${pct > 90 ? ' warn' : ''}` }, h('i', { style: { width: `${pct}%` } })) : null,
      h('div', { class: 'kv' }, h('span', null, 'Uploaded today'), h('strong', null, q.dailyMb ? `${mb(q.today)} of ${q.dailyMb} MB` : mb(q.today))),
      h('div', { class: 'kv' }, h('span', null, 'Largest file'), h('strong', null, `${q.fileMb} MB (pictures ${q.imageMb} MB, songs ${q.songMb} MB)`)),
      ...q.byKind.map((k) => h('div', { class: 'kv' }, h('span', null, kinds[k.kind] || k.kind), h('span', null, `${k.files} \u00b7 ${mb(k.bytes)}`))),
      go ? h('button', { class: 'btn ghost sm', onclick: () => go('storage') }, 'See your biggest files') : null].filter(Boolean));
  }).catch((e) => clear(storage).append(h('p', { class: 'form-error' }, e.message)));

  // Change your display name: what people see in chats and member lists (doesn't have to be unique).
  const dnameOf = () => (S.me.profile && S.me.profile.displayName) || S.me.username;
  const dnameEl = h('strong', null, dnameOf());
  const changeDisplayName = () => displayNameDialog(app, () => { dnameEl.textContent = dnameOf(); });
  // Change your username: any free name; the old one becomes free for others. Needs your password.
  const unameEl = h('strong', null, S.me.username);
  function changeUsername() {
    const inp = h('input', { class: 'input', maxlength: '24', value: S.me.username, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const hint = h('span', { class: 'field-hint' }, '2–24 characters: letters, numbers, _ and . You sign in with the new name; your password and everything else stay the same. Your old name becomes free for anyone.');
    modal({ title: 'Change your username', size: 'sm', body: h('div', { class: 'stack' }, field('New username', inp), hint),
      actions: [{ label: 'Cancel' }, { label: 'Change', kind: 'primary', action: async () => {
        const name = inp.value.trim().replace(/^@/, '');
        if (!/^[a-zA-Z0-9_.]{2,24}$/.test(name)) throw new Error('Usernames are 2–24 characters: letters, numbers, _ and . only.');
        if (name === S.me.username) return;
        const u = await confirmedCall(app, (x) => api('POST', '/me/username', { username: name, ...x }), { title: 'Confirm it’s you', text: `Change your username to @${name}?`, button: 'Change username' }).catch((e) => { if (!e.cancelled) throw e; return null; });
        if (!u) return false;
        app.onMe(u); unameEl.textContent = u.username;
        toast(`You’re now @${u.username}. Sign in with it from now on.`);
      } }] });
    setTimeout(() => inp.select(), 50);
  }

  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Account & security'),
    section('Your account',
      h('div', { class: 'kv' }, h('span', null, 'Display name'), h('span', { class: 'row gap tight' }, dnameEl, h('button', { class: 'btn ghost sm', onclick: changeDisplayName }, 'Change'))),
      h('div', { class: 'kv' }, h('span', null, 'Username'), h('span', { class: 'row gap tight' }, unameEl, h('button', { class: 'btn ghost sm', onclick: changeUsername }, 'Change'))),
      h('div', { class: 'kv' }, h('span', null, 'Member since'), h('strong', null, new Date(S.me.createdAt).toLocaleDateString()))),
    ...securitySections(app),
    section('Storage', storage),
    section('Encryption',
      h('p', { class: 'muted-p' }, 'Everything you send \u2014 DMs, server channels and every file \u2014 is end-to-end encrypted on this device before it leaves. The server only stores scrambled data and can\u2019t read it.'),
      h('div', { class: 'kv' }, h('span', null, 'Messages'), h('strong', null, 'AES-256-GCM, new key per message')),
      h('div', { class: 'kv' }, h('span', null, 'Key exchange'), h('strong', null, 'ECDH P-256 + HKDF-SHA256')),
      h('div', { class: 'kv' }, h('span', null, 'Signatures'), h('strong', null, 'ECDSA P-256')),
      h('div', { class: 'kv' }, h('span', null, 'Password hashing'), h('strong', null, S.me.kdf === 'argon2id' ? 'Argon2id, 64 MiB' : 'PBKDF2 (upgrades next login)')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Your key fingerprint'), fp,
        h('span', { class: 'field-hint' }, 'Open a DM and click \u201cEnd-to-end encrypted\u201d to compare safety numbers with a friend.'))),
    section('Change password',
      h('p', { class: 'muted-p' }, 'Your password locks your encryption key, so changing it re-locks the key on this device. Forgot it? Use \u201cForgot your password?\u201d on the sign-in screen (needs a confirmed email; keep a recovery key to keep your old messages).'),
      field('Current password', oldPw), field('New password', newPw), field('Confirm new password', confirmPw), msg,
      h('div', null, btn)),
    section('Session',
      h('button', { class: 'btn danger', onclick: () => app.logout() }, 'Log out of this device'),
      h('p', { class: 'field-hint' }, 'To see or sign out your other devices, open Sessions.')),
    section('Delete account',
      h('p', { class: 'muted-p' }, 'Erases your private keys, email, profile, pictures and friends, takes you out of every server, and signs out every device. Messages you sent stay where they are (still encrypted, readable by the people who could read them before) and show “Deleted user”. This can’t be undone.'),
      h('div', null, h('button', { class: 'btn danger', onclick: () => deleteAccount(app).catch(quiet) }, 'Delete my account'))),
  );
}
async function deleteAccount(app) {
  const S = app.S;
  const keys = await askPassword(app, { title: 'Delete your account?', text: 'This can’t be undone. You won’t be able to read your old messages again; the people you sent them to still can.', button: 'Continue' });
  if (!keys) return;
  const confirmName = h('input', { class: 'input', autocomplete: 'off', placeholder: S.me.username });
  modal({ title: 'Type your username to confirm', size: 'sm',
    body: h('div', { class: 'stack' }, h('p', { class: 'warn-box' }, `Deleting ${S.me.username} for good.`), field('Username', confirmName)),
    actions: [{ label: 'Cancel' }, { label: 'Delete forever', kind: 'danger', action: async () => {
      if (confirmName.value.trim() !== S.me.username) throw new Error('That isn’t your username.');
      await withCode((x) => api('DELETE', '/me', { authKey: keys.authKey, confirm: S.me.username, ...x }));
      sessionStorage.setItem('hearth.signedOutWhy', 'Your account was deleted.');
      app.logout();
    } }] });
}

// ------------------------------------------------------------------ account safety: email, recovery key, 2FA
// Your password-locked private key. The server only hands it out with the password, plus a two-factor code when
// that's on (a session alone isn't enough, so a stolen one can't be used to guess the password offline). A
// wrong password fails here.
async function lockedKey(authKey) {
  try { return (await withCode((x) => api('POST', '/me/keys/wrapped', { authKey, ...x }))).encPrivateKey; } catch (e) {
    if (e.code === 'bad_password') throw Object.assign(new Error('That password isn’t right.'), { code: 'bad_password' });
    throw e;
  }
}
// Asks for the password again (sensitive changes). It must also unlock your key on this device. Resolves with
// the derived keys plus the locked private key (encPrivateKey), or null if cancelled.
function askPassword(app, { title = 'Confirm it’s you', text = '', button = 'Continue' } = {}) {
  const S = app.S;
  return new Promise((resolve) => {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    modal({ title, size: 'sm', onClose: () => resolve(null),
      body: h('div', { class: 'stack' }, text ? h('p', { class: 'muted-p' }, text) : '', field('Your password', pw)),
      actions: [{ label: 'Cancel' }, { label: button, kind: 'primary', action: async () => {
        // (The password hashing library's own message for an empty one means nothing to people.)
        if (!pw.value) throw new Error('Enter your password.');
        const params = S.me.kdf === 'argon2id' ? { kdf: 'argon2id', salt: S.me.kdfSalt } : { kdf: 'pbkdf2' };
        const keys = await E2EE.deriveKeys(S.me.username, pw.value, params);
        const encPrivateKey = await lockedKey(keys.authKey);
        try { await E2EE.unwrapPrivateKey(keys.wrapKey, encPrivateKey); } catch { throw new Error('That password isn’t right.'); }
        resolve({ ...keys, encPrivateKey });
      } }] });
  });
}
// Runs a sensitive request. If the server also wants a two-factor code (it does when two-factor is on, unless
// this device passed it in the last few minutes), asks for one and sends the request again with it.
function withCode(fn) {
  return fn({}).catch((e) => {
    if (e.code !== 'need_2fa') throw e;
    return new Promise((resolve, reject) => {
      const code = h('input', { class: 'input', autocomplete: 'one-time-code', placeholder: '123456 or a backup code' });
      let done = false;
      modal({ title: 'Enter your two-factor code', size: 'sm', onClose: () => { if (!done) reject(Object.assign(new Error('Cancelled.'), { cancelled: true })); },
        body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'This change needs a code from your authenticator app (or one of your backup codes).'), field('Code', code)),
        actions: [{ label: 'Cancel' }, { label: 'Continue', kind: 'primary', action: async () => {
          const c = code.value.trim().replace(/\s/g, '');
          const out = await fn(/^\d{6}$/.test(c) ? { totp: c } : { backupCode: c });
          done = true; resolve(out);
        } }] });
    });
  });
}
const quiet = (e) => { if (!e || !e.cancelled) toast(e.message, 'error'); };
// Change your display name: what people see in chats and member lists (doesn't have to be unique). Used here
// and from the menu under your name.
export function displayNameDialog(app, onDone) {
  const S = app.S;
  const inp = h('input', { class: 'input', maxlength: '32', value: (S.me.profile && S.me.profile.displayName) || '', placeholder: S.me.username });
  modal({ title: 'Change your display name', size: 'sm',
    body: h('div', { class: 'stack' }, field('Display name', inp, 'Up to 32 characters, emoji welcome. It\u2019s what people see in chats and member lists, and it doesn\u2019t have to be unique. Leave it empty to show your username.')),
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: async () => {
      const u = await api('PATCH', '/me/profile', { displayName: inp.value.trim() });
      app.onMe(u); if (onDone) onDone(u);
      toast('Display name saved.');
    } }] });
  setTimeout(() => inp.select(), 50);
}
// Password (and a two-factor code if needed) for a sensitive request: fn gets { authKey, totp|backupCode }.
// Resolves to null if the person cancels.
export async function confirmedCall(app, fn, opts) {
  const keys = await askPassword(app, opts);
  if (!keys) return null;
  return withCode((x) => fn({ authKey: keys.authKey, ...x }));
}
function showSecretOnce({ title, intro, secret, filename, note }) {
  return new Promise((resolve) => {
    const ok = h('input', { type: 'checkbox' });
    let m;
    const done = h('button', { class: 'btn primary', disabled: true, onclick: () => { m.close(); resolve(); } }, 'Done');
    ok.addEventListener('change', () => { done.disabled = !ok.checked; });
    m = modal({ title, size: 'md', dismissable: false,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, intro),
        h('div', { class: 'cmd-box secret-box' }, h('code', null, secret)),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(secret).then(() => toast('Copied.')); } }, icon('copy'), 'Copy'),
          h('button', { class: 'btn', onclick: () => { const url = URL.createObjectURL(new Blob([`${title}\n\n${secret}\n\n${note || ''}\n`], { type: 'text/plain' })); h('a', { href: url, download: filename }).click(); setTimeout(() => URL.revokeObjectURL(url), 5000); } }, icon('download'), 'Download')),
        note ? h('p', { class: 'field-hint' }, note) : '',
        h('label', { class: 'row gap tight' }, ok, h('span', null, 'I saved it somewhere safe')),
        h('div', null, done)) });
  });
}
function securitySections(app) {
  const S = app.S;
  const refresh = (u) => { if (u && u.id) app.onMe(u); drawAll(); };
  // ---- email
  const emailBox = h('div', { class: 'stack' });
  const verifyEmail = (sentTo) => {
    const code = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456' });
    modal({ title: 'Check your email', size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, `We sent a 6-digit code to ${sentTo}. It works for 30 minutes.`), field('Code', code)),
      actions: [{ label: 'Cancel' }, { label: 'Confirm email', kind: 'primary', action: async () => { refresh(await api('POST', '/me/email/verify', { code: code.value })); toast('Email confirmed. You can now reset your password with it.'); } }] });
  };
  const addEmail = async () => {
    const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    modal({ title: S.me.email ? 'Change your email' : 'Add an email', size: 'sm',
      body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'Only used to reset your password and for security notices. Never shown to anyone.'), field('Email', email), field('Your password', pw)),
      actions: [{ label: 'Cancel' }, { label: 'Send code', kind: 'primary', action: async () => {
        if (!pw.value) throw new Error('Enter your password.');
        const params = S.me.kdf === 'argon2id' ? { kdf: 'argon2id', salt: S.me.kdfSalt } : { kdf: 'pbkdf2' };
        const keys = await E2EE.deriveKeys(S.me.username, pw.value, params);
        setTimeout(() => withCode((x) => api('POST', '/me/email', { email: email.value.trim(), authKey: keys.authKey, ...x })).then((r) => verifyEmail(r.sentTo)).catch(quiet), 150);
      } }] });
  };
  const drawEmail = () => {
    clear(emailBox);
    if (S.me.email) {
      emailBox.append(h('div', { class: 'kv' }, h('span', null, 'Email'), h('strong', null, S.me.email, ' ', h('span', { class: 'rpill ok' }, 'Confirmed'))),
        h('div', { class: 'row gap' }, h('button', { class: 'btn sm', onclick: addEmail }, 'Change'),
          h('button', { class: 'btn ghost sm', onclick: async () => { const k = await askPassword(app, { text: 'Without an email you can’t reset a forgotten password.' }); if (!k) return; withCode((x) => api('DELETE', '/me/email', { authKey: k.authKey, ...x })).then((u) => { refresh(u); toast('Email removed.'); }).catch(quiet); } }, 'Remove')));
    } else {
      emailBox.append(h('p', { class: 'muted-p' }, 'Add an email so you can reset your password if you ever forget it.'),
        S.config.emailEnabled ? h('div', null, h('button', { class: 'btn primary', onclick: addEmail }, 'Add an email'))
          : h('p', { class: 'field-hint' }, 'The server owner hasn’t set up email yet (Admin → Owner → Email).'));
    }
  };
  // ---- recovery key
  const recBox = h('div', { class: 'stack' });
  const makeRecovery = async () => {
    const keys = await askPassword(app, { title: 'Create a recovery key', text: S.me.hasRecovery ? 'Your old recovery key will stop working.' : '' });
    if (!keys) return;
    const code = E2EE.newRecoveryCode();
    const salt = E2EE.newKdfSalt();
    const sealed = await E2EE.rewrapPrivateKey(keys.wrapKey, await E2EE.recoveryWrapKey(code, salt), keys.encPrivateKey);
    const u = await withCode((x) => api('PUT', '/me/recovery', { authKey: keys.authKey, encPrivateKeyRecovery: sealed, recoverySalt: salt, ...x }));
    await showSecretOnce({ title: `${S.config.name} recovery key for ${S.me.username}`, intro: 'Save this key. If you forget your password, the email reset plus this key brings back everything, including your old messages. It’s shown only now.',
      secret: code, filename: `${S.config.name.replace(/\W+/g, '-')}-recovery-key-${S.me.username}.txt`, note: 'Anyone with this key AND access to your email could get into your account, so keep it private (a password manager is ideal).' });
    refresh(u);
  };
  const drawRec = () => {
    clear(recBox);
    recBox.append(S.me.hasRecovery
      ? h('div', { class: 'kv' }, h('span', null, 'Recovery key'), h('span', { class: 'rpill ok' }, 'Saved'))
      : h('p', { class: 'warn-box' }, 'No recovery key yet. If you forget your password, an email reset gets you back in, but your old direct messages would be lost for good.'),
    h('div', { class: 'row gap' }, h('button', { class: `btn ${S.me.hasRecovery ? 'sm' : 'primary'}`, onclick: () => makeRecovery().catch(quiet) }, S.me.hasRecovery ? 'Make a new one' : 'Create a recovery key'),
      S.me.hasRecovery ? h('button', { class: 'btn ghost sm', onclick: async () => { const k = await askPassword(app); if (!k) return; withCode((x) => api('DELETE', '/me/recovery', { authKey: k.authKey, ...x })).then((u) => { refresh(u); toast('Recovery key removed.'); }).catch(quiet); } }, 'Remove') : ''));
  };
  // ---- two-factor
  const tfaBox = h('div', { class: 'stack' });
  const qrSvg = async (text) => {
    if (!window.qrcode) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = '/vendor/qrcode.js'; sc.onload = res; sc.onerror = () => rej(new Error('Couldn’t load the QR code.')); document.head.append(sc); });
    const q = window.qrcode(0, 'M'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  };
  const setup2fa = async () => {
    const keys = await askPassword(app, { title: 'Turn on two-factor sign-in' });
    if (!keys) return;
    const r = await api('POST', '/me/2fa/setup', { authKey: keys.authKey });
    const qr = h('div', { class: 'qr-box', html: await qrSvg(r.uri) });
    const code = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456' });
    modal({ title: 'Scan this with your authenticator app', size: 'md',
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted-p' }, 'Use Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden or any app that does 6-digit codes.'),
        h('div', { class: 'tfa-setup' }, qr, h('div', { class: 'stack' }, h('span', { class: 'field-label' }, 'Can’t scan? Type this key:'), h('code', { class: 'mono-sm' }, r.secret), field('Then enter the code it shows', code)))),
      actions: [{ label: 'Cancel' }, { label: 'Turn on', kind: 'primary', action: async () => {
        const res = await api('POST', '/me/2fa/enable', { code: code.value });
        setTimeout(async () => {
          await showSecretOnce({ title: `${S.config.name} backup codes for ${S.me.username}`, intro: 'If you lose your phone, each of these codes signs you in once. Keep them somewhere safe.', secret: res.backupCodes.join('\n'), filename: `${S.config.name.replace(/\W+/g, '-')}-backup-codes-${S.me.username}.txt` });
          refresh(res.user); toast('Two-factor sign-in is on. Other devices were signed out.');
        }, 150);
      } }] });
  };
  // The password and a code in one dialog, sent together. (Asking for the password first with askPassword fetches
  // the locked key, which takes a code of its own once the last one is 10 minutes old. That used up the code on
  // the phone, so the one asked for next was refused until the app showed a new one.) Nothing needs unlocking
  // here, so the password is only checked by the server.
  const disable2fa = () => {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const code = h('input', { class: 'input', autocomplete: 'one-time-code', placeholder: '123456 or a backup code' });
    modal({ title: 'Turn off two-factor sign-in', size: 'sm',
      body: h('div', { class: 'stack' }, field('Your password', pw), field('Code from your app (or a backup code)', code)),
      actions: [{ label: 'Cancel' }, { label: 'Turn off', kind: 'danger', action: async () => {
        if (!pw.value) throw new Error('Enter your password.');
        const c = code.value.trim().replace(/\s/g, '');
        if (!c) throw new Error('Enter the code from your authenticator app (or a backup code).');
        const params = S.me.kdf === 'argon2id' ? { kdf: 'argon2id', salt: S.me.kdfSalt } : { kdf: 'pbkdf2' };
        const { authKey } = await E2EE.deriveKeys(S.me.username, pw.value, params);
        try {
          refresh(await api('POST', '/me/2fa/disable', { authKey, ...(/^\d{6}$/.test(c) ? { totp: c } : { backupCode: c }) }));
        } catch (e) {
          if (e.code === 'bad_password') throw new Error('That password isn’t right.');
          throw e;
        }
        toast('Two-factor sign-in is off.');
      } }] });
  };
  const newCodes = () => {
    const code = h('input', { class: 'input', inputmode: 'numeric', maxlength: '6', placeholder: '123456' });
    modal({ title: 'New backup codes', size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'Your old backup codes stop working.'), field('Code from your app', code)),
      actions: [{ label: 'Cancel' }, { label: 'Make new codes', kind: 'primary', action: async () => {
        const r = await api('POST', '/me/2fa/backup-codes', { code: code.value });
        setTimeout(() => showSecretOnce({ title: `${S.config.name} backup codes for ${S.me.username}`, intro: 'Each code signs you in once.', secret: r.backupCodes.join('\n'), filename: `${S.config.name.replace(/\W+/g, '-')}-backup-codes-${S.me.username}.txt` }).then(() => { S.me.backupCodesLeft = 10; drawAll(); }), 150);
      } }] });
  };
  const draw2fa = () => {
    clear(tfaBox);
    if (S.me.totpEnabled) {
      tfaBox.append(h('div', { class: 'kv' }, h('span', null, 'Two-factor sign-in'), h('span', { class: 'rpill ok' }, 'On')),
        h('p', { class: 'field-hint' }, `${S.me.backupCodesLeft} backup code${S.me.backupCodesLeft === 1 ? '' : 's'} left.`),
        h('div', { class: 'row gap' }, h('button', { class: 'btn sm', onclick: newCodes }, 'New backup codes'), h('button', { class: 'btn ghost sm', onclick: disable2fa }, 'Turn off')));
    } else {
      tfaBox.append(h('p', { class: 'muted-p' }, 'After your password, sign-in asks for a 6-digit code from an app on your phone, so a stolen password alone isn’t enough. It’s also needed to reset your password by email.'),
        h('div', null, h('button', { class: 'btn primary', onclick: () => setup2fa().catch((e) => toast(e.message, 'error')) }, 'Set up two-factor sign-in')));
    }
  };
  // ---- encryption check
  const checkBox = h('div', { class: 'stack' });
  const runCheck = async (btn) => {
    btn.disabled = true; clear(checkBox).append(h('span', { class: 'spinner' }), h('span', { class: 'field-hint' }, 'Testing every lock (about 5 seconds)…'));
    try {
      const { runCryptoChecks, runAccountChecks } = await import('./selftest.js');
      const generic = await runCryptoChecks();
      const serverKeys = S.servers.map((sv) => {
        const st = app.sec.stateOf(sv.id);
        const held = app.sec.heldEpochs(sv.id);
        const ok = !st || !st.keyEpoch || held.includes(st.keyEpoch);
        return { name: sv.name || 'group chat', ok, why: ok ? '' : 'waiting for another member to share it (happens automatically when one is online)' };
      });
      const mine = await runAccountChecks({ me: S.me, privateKey: S.privateKey, signKey: S.signKey, serverKeys });
      const all = [...generic, ...mine];
      const bad = all.filter((x) => !x.ok);
      clear(checkBox).append(h('p', { class: bad.length ? 'warn-box' : 'support-now' }, bad.length ? `${bad.length} of ${all.length} checks need attention.` : `All ${all.length} checks passed. Your encryption is working as it should.`),
        h('ul', { class: 'check-list' }, all.map((x) => h('li', { class: x.ok ? 'ok' : 'bad' }, x.ok ? '✓ ' : '✗ ', x.name, x.detail && !x.ok ? h('span', { class: 'field-hint' }, ` — ${x.detail}`) : ''))));
    } catch (e) { clear(checkBox).append(h('p', { class: 'form-error' }, e.message)); }
    btn.disabled = false;
  };
  const drawAll = () => { drawEmail(); drawRec(); draw2fa(); };
  drawAll();
  return [
    section('Email', emailBox),
    section('Recovery key', recBox),
    section('Two-factor sign-in', tfaBox),
    section('Check my encryption', h('p', { class: 'muted-p' }, 'Runs every lock Hearth uses on this device — including that changed or forged messages are refused — and checks your own keys.'),
      h('div', null, h('button', { class: 'btn', onclick: (e) => runCheck(e.currentTarget) }, icon('shield'), 'Run the check')), checkBox),
  ];
}

// ------------------------------------------------------------------ voice tab
function audioPrefs() { try { return JSON.parse(localStorage.getItem('hearth.audio') || '{}'); } catch { return {}; } }
function setAudioPref(k, v) { const p = audioPrefs(); p[k] = v; localStorage.setItem('hearth.audio', JSON.stringify(p)); }

function voiceTab(app) {
  const prefs = audioPrefs();
  // In a call, a new device takes over straight away (same connection, the track is swapped).
  const live = () => app.voice && app.voice.inVoice;
  const inputSel = h('select', { class: 'input', onchange: (e) => {
    setAudioPref('inputId', e.target.value);
    if (micTest) startTest();
    if (live()) app.voice.setInputDevice().then((r) => { if (r === 'mic') toast('Your call now uses this microphone.'); }).catch((err) => toast(err.message, 'error'));
  } });
  const outputSel = h('select', { class: 'input', onchange: (e) => { setAudioPref('outputId', e.target.value); if (live()) app.voice.setOutputDevice(e.target.value); } });
  // Camera: pick a device and preview it.
  const camSel = h('select', { class: 'input', onchange: (e) => {
    setAudioPref('cameraId', e.target.value);
    if (camStream) startCam();
    if (live() && app.voice.camStream) app.voice.setCameraDevice().catch((err) => toast(err.name === 'NotFoundError' ? 'That camera isn\u2019t available.' : err.message, 'error'));
  } });
  const camVideo = h('video', { class: 'cam-preview', autoplay: true, playsinline: true });
  camVideo.muted = true;
  let camStream = null;
  const stopCam = () => { if (camStream) camStream.getTracks().forEach((t) => t.stop()); camStream = null; camVideo.srcObject = null; camBtn.textContent = 'Test camera'; };
  const startCam = async () => {
    stopCam();
    try {
      const id = audioPrefs().cameraId;
      camStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: id ? { ideal: id } : undefined, width: { ideal: 640 } }, audio: false });
      camVideo.srcObject = camStream; camBtn.textContent = 'Stop test';
      fillDevices().catch(() => {});
    } catch (e) { toast(e.name === 'NotAllowedError' ? 'Allow camera access in your browser to test it.' : e.name === 'NotFoundError' ? 'No camera found.' : e.message, 'error'); }
  };
  const camBtn = h('button', { class: 'btn ghost sm', onclick: () => (camStream ? stopCam() : startCam()) }, 'Test camera');
  const camObserver = new MutationObserver(() => { if (!document.body.contains(camVideo)) { stopCam(); camObserver.disconnect(); } });
  setTimeout(() => camObserver.observe(document.body, { childList: true, subtree: true }), 0);
  const outputSupported = 'setSinkId' in HTMLMediaElement.prototype;
  const permNote = h('p', { class: 'field-hint', hidden: true }, 'Device names appear after you allow microphone access. Click "Test microphone" to allow it.');

  const fillDevices = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      permNote.hidden = false;
      permNote.textContent = 'Audio devices need a secure connection (https:// or localhost).';
      return;
    }
    const devs = await navigator.mediaDevices.enumerateDevices();
    const ins = devs.filter((d) => d.kind === 'audioinput');
    const outs = devs.filter((d) => d.kind === 'audiooutput');
    const cams = devs.filter((d) => d.kind === 'videoinput');
    clear(camSel).append(h('option', { value: '' }, 'System default'), ...cams.filter((d) => d.deviceId).map((d, i) => h('option', { value: d.deviceId }, d.label || `Camera ${i + 1}`)));
    camSel.value = prefs.cameraId || '';
    if (camSel.value !== (prefs.cameraId || '')) camSel.value = '';
    permNote.hidden = ins.some((d) => d.label);
    clear(inputSel).append(h('option', { value: '' }, 'System default'), ...ins.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => h('option', { value: d.deviceId }, d.label || `Microphone ${i + 1}`)));
    clear(outputSel).append(h('option', { value: '' }, 'System default'), ...outs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => h('option', { value: d.deviceId }, d.label || `Speaker ${i + 1}`)));
    inputSel.value = prefs.inputId || '';
    outputSel.value = prefs.outputId || '';
    if (inputSel.value !== (prefs.inputId || '')) inputSel.value = '';
  };
  fillDevices().catch(() => {});

  const meterBar = h('div', { class: 'meter-bar' });
  const meter = h('div', { class: 'meter' }, meterBar);
  const testBtn = h('button', { class: 'btn ghost', onclick: () => (micTest ? (stopMicTest(), testBtn.textContent = 'Test microphone', meterBar.style.width = '0') : startTest()) }, 'Test microphone');
  const hear = h('input', { type: 'checkbox' });

  async function startTest() {
    stopMicTest();
    try {
      const p = audioPrefs();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: p.inputId ? { ideal: p.inputId } : undefined,
        echoCancellation: p.echoCancellation !== false,
        noiseSuppression: p.noiseSuppression !== false,
        autoGainControl: p.autoGainControl !== false,
      } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      if (hear.checked) src.connect(ctx.destination);
      const data = new Uint8Array(an.fftSize);
      micTest = { stream, ctx, raf: 0 };
      const tick = () => {
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
        const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
        meterBar.style.width = Math.round(level * 100) + '%';
        meterBar.classList.toggle('hot', level > 0.12);
        micTest.raf = requestAnimationFrame(tick);
      };
      tick();
      testBtn.textContent = 'Stop test';
      fillDevices().catch(() => {});
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Allow microphone access in your browser first.' : e.message, 'error');
    }
  }

  const sensOut = h('span', { class: 'counter' });
  const sensVal = () => Math.round((Math.log(+(audioPrefs().threshold || 0.02) / 0.003) / Math.log(0.2 / 0.003)) * 100);
  const sens = h('label', { class: 'slider-row', hidden: !prefs.gate }, h('span', null, 'Threshold'),
    h('input', { type: 'range', class: 'range', min: '0', max: '100', value: String(sensVal()), 'aria-label': 'Input sensitivity threshold', oninput: (e) => {
      const t = 0.003 * Math.pow(0.2 / 0.003, +e.target.value / 100);
      setAudioPref('threshold', +t.toFixed(4));
      sensOut.textContent = e.target.value;
    } }), sensOut);
  sensOut.textContent = String(sensVal());
  const inVoice = app.voice && app.voice.channelId;
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Voice & video'),
    inVoice ? h('p', { class: 'muted-p warn' }, 'You are in a voice channel. Device and processing changes apply the next time you join.') : null,
    section('Camera', h('div', { class: 'cam-row' }, h('div', { class: 'stack' }, field('Camera', camSel), h('div', null, camBtn)), camVideo),
      h('p', { class: 'field-hint' }, 'Turn your camera on during a call with the camera button. Screen sharing can include your screen\u2019s audio: tick "Share audio" in the browser\u2019s picker (Chrome/Edge).')),
    section('Devices',
      field('Input device', inputSel),
      outputSupported ? field('Output device', outputSel) : h('p', { class: 'field-hint' }, 'This browser does not support picking a speaker; it uses your system default.'),
      permNote),
    section('Mic test',
      h('div', { class: 'row gap' }, testBtn, h('label', { class: 'inline-check' }, hear, 'Hear myself')),
      meter,
      h('p', { class: 'field-hint' }, 'Talk normally — the bar should turn your accent color when you speak. Use headphones if you turn on "Hear myself".')),
    inputModeSection(app, prefs, sens),
    section('Processing',
      toggle('Echo cancellation', prefs.echoCancellation !== false, (v) => setAudioPref('echoCancellation', v), 'Stops others hearing themselves through your speakers.'),
      toggle('Noise suppression', prefs.noiseSuppression !== false, (v) => setAudioPref('noiseSuppression', v), 'Filters out fans, keyboards and background hum.'),
      toggle('Automatic gain control', prefs.autoGainControl !== false, (v) => setAudioPref('autoGainControl', v), 'Keeps your volume steady.')),
    section('Keybinds', keybindsEditor()),
  );
}

// Voice activity (talk any time, optional sensitivity gate) or push-to-talk (hold a key), like Discord.
function inputModeSection(app, prefs, sens) {
  const ptt = prefs.mode === 'ptt';
  const vaBox = h('div', { class: 'stack', hidden: ptt },
    toggle('Only send audio when I’m talking', !!prefs.gate, (v) => { setAudioPref('gate', v); sens.hidden = !v; }, 'Cuts background noise between sentences. Applies the next time you join voice.'),
    sens);
  const delay = +(prefs.pttDelay ?? 200);
  const pttBox = h('div', { class: 'stack', hidden: !ptt },
    keyRow('ptt', 'Push-to-talk key', 'Hold it to talk. Works while a game has focus in the desktop app.'),
    sliderRow('Release delay', 0, 1000, 20, delay, (v) => `${v} ms`, (v) => setAudioPref('pttDelay', v)),
    h('p', { class: 'field-hint' }, 'How long your mic stays on after you let go, so the end of a word isn\u2019t cut off.'));
  const apply = () => { const v = app.voice; if (v && v.applyLocalTrackState) { v.pttHeld = false; v.applyLocalTrackState(); v.onChange(); } };
  return section('Input mode',
    chips([['va', 'Voice activity'], ['ptt', 'Push to talk']], ptt ? 'ptt' : 'va', (v) => {
      setAudioPref('mode', v);
      vaBox.hidden = v === 'ptt'; pttBox.hidden = v !== 'ptt';
      if (v === 'ptt' && !getKeybinds().ptt) toast('Now pick a push-to-talk key.');
      apply();
    }),
    vaBox, pttBox);
}

// ------------------------------------------------------------------ keybinds
// One row: what it does, the current key, "Change" (press the new key / mouse button / combo) and "Clear".
function keyRow(name, label, hint) {
  const keyEl = h('kbd', { class: 'kb-key' }, comboLabel(getKeybinds()[name]));
  const btn = h('button', { class: 'btn sm', type: 'button' }, 'Change');
  const status = h('span', { class: 'field-hint' }, hint || '');
  btn.addEventListener('click', async () => {
    btn.disabled = true; keyEl.textContent = 'Press a key\u2026'; keyEl.classList.add('recording');
    status.textContent = name === 'ptt' ? 'Press a key or a mouse side button. Esc cancels.' : 'Press the keys together (e.g. Ctrl + Shift + M). Esc cancels.';
    const combo = await recordCombo({ allowMods: name !== 'ptt' });
    keyEl.classList.remove('recording'); btn.disabled = false; status.textContent = hint || '';
    if (combo) {
      const all = getKeybinds();
      if (name !== 'ptt' && !combo.ctrl && !combo.alt && !combo.meta && !/^F\d+$|^Mouse/.test(combo.code)) {
        toast('Use a combination with Ctrl or Alt (or an F-key), so it doesn\u2019t fire while you type.', 'error');
      } else {
        all[name] = combo;
        const r = await saveKeybinds(all);
        if (r && r.ok === false && r.error) toast(r.error, 'error');
      }
    }
    keyEl.textContent = comboLabel(getKeybinds()[name]);
  });
  const clearBtn = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { const all = getKeybinds(); all[name] = null; await saveKeybinds(all); keyEl.textContent = comboLabel(null); } }, 'Clear');
  return h('div', { class: 'kb-row' }, h('div', { class: 'kb-text' }, h('span', { class: 'toggle-label' }, label), status), keyEl, h('div', { class: 'row gap tight' }, btn, clearBtn));
}
function keybindsEditor() {
  const d = window.hearthDesktop;
  const root = h('div', { class: 'stack' },
    keyRow('ptt', 'Push to talk', 'Only used when Input mode is Push to talk.'),
    keyRow('mute', 'Mute / unmute'),
    keyRow('deafen', 'Deafen / undeafen'),
    h('p', { class: 'field-hint' }, d && d.setKeybinds
      ? 'These work everywhere, even while a game is focused. On a Mac, allow Hearth under System Settings \u2192 Privacy & Security \u2192 Accessibility.'
      : 'In the browser these work while Hearth is the focused window. The desktop app makes them work everywhere, even in games.'),
    h('div', null, h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { await saveKeybinds({ ...DEFAULT_KEYBINDS }); root.replaceWith(keybindsEditor()); toast('Keybinds reset.'); } }, 'Reset to defaults')));
  return root;
}
function keybindsTab() {
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Keybinds'),
    section('Voice', keybindsEditor()),
    section('Everywhere in Hearth',
      ...[['Search everything', 'Ctrl + K'], ['Previous / next channel', 'Alt + \u2191 / \u2193'], ['Close menus, cancel a reply or an edit', 'Esc'], ['New line in a message', 'Shift + Enter'], ['Edit your last message', '\u2191 in an empty box']]
        .map(([a, k]) => h('div', { class: 'kv' }, h('span', null, a), h('kbd', null, k)))));
}

// ------------------------------------------------------------------ appearance tab
const ACCENTS = ['#f2a541', '#ef5466', '#ff7ab6', '#b07cff', '#5c8dff', '#38c6d9', '#3fcf83', '#c4e05a'];

function sliderRow(label, min, max, step, value, fmt, onInput) {
  const out = h('span', { class: 'counter' }, fmt(value));
  const input = h('input', {
    type: 'range', class: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label,
    oninput: (e) => { out.textContent = fmt(+e.target.value); onInput(+e.target.value); },
  });
  return h('label', { class: 'slider-row' }, h('span', null, label), input, out);
}

function themePreview() {
  return h('div', { class: 'tp', 'aria-hidden': 'true' },
    h('div', { class: 'tp-rail' }, h('i'), h('i'), h('i')),
    h('div', { class: 'tp-side' }, h('i'), h('i'), h('i')),
    h('div', { class: 'tp-main' }, h('i'), h('i'), h('i'), h('b')));
}

function appearanceTab(app) {
  const a = loadAppearance();
  const root = h('div', { class: 'set-form narrow' });
  let imageThumb = null;

  const commit = (redraw = false) => { saveAppearance(a); if (redraw) draw(); };

  // ---- background image upload (kept in this browser only)
  const imgInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/avif', hidden: true });
  imgInput.addEventListener('change', async () => {
    const f = imgInput.files[0];
    imgInput.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('Choose an image file.', 'error');
    if (f.size > 15 * 1024 * 1024) return toast('Background images can be up to 15 MB.', 'error');
    try {
      await saveBgImage(f);
      if (imageThumb) URL.revokeObjectURL(imageThumb);
      imageThumb = URL.createObjectURL(f);
      a.bg.kind = 'image';
      if (a.dim < 0.15) a.dim = 0.3;
      commit(true);
      toast('Background updated.');
    } catch (e) { toast('Could not save that image in this browser.', 'error'); }
  });

  function themeSection() {
    return section('Theme',
      h('p', { class: 'set-sub' }, 'Dark is the default. Your choice is saved on this device.'),
      h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme' }, THEMES.map((t) => h('button', {
        class: `theme-card${a.theme === t.id ? ' active' : ''}`,
        dataset: { theme: t.id },
        role: 'radio',
        'aria-checked': String(a.theme === t.id),
        onclick: () => { a.theme = t.id; commit(true); },
      }, themePreview(), h('span', { class: 'theme-name' }, h('strong', null, t.name), h('span', null, t.hint))))));
  }

  function bgTile({ name, css, active, onclick, extraClass = '', content = null }) {
    return h('button', { class: `bg-tile${active ? ' active' : ''} ${extraClass}`.trim(), onclick, 'aria-pressed': String(!!active) },
      h('span', { class: 'bg-sw', style: css ? { background: css } : null }, content),
      h('span', { class: 'bg-tile-name' }, name));
  }

  function backgroundSection() {
    const groups = [...new Set(BACKGROUNDS.map((b) => b.group))];
    const sec = section('Background',
      h('p', { class: 'set-sub' }, 'Shows behind the whole app. Adaptive ones follow your theme and accent color.'));
    for (const g of groups) {
      sec.append(h('div', { class: 'bg-group-label' }, g));
      sec.append(h('div', { class: 'bg-grid' }, BACKGROUNDS.filter((b) => b.group === g).map((b) => bgTile({
        name: b.name,
        css: b.css,
        active: a.bg.kind === 'preset' && a.bg.preset === b.id,
        onclick: () => { a.bg.kind = 'preset'; a.bg.preset = b.id; commit(true); },
      }))));
    }
    sec.append(h('div', { class: 'bg-group-label' }, 'Make your own'));
    const imgTile = bgTile({
      name: a.bg.kind === 'image' ? 'Your image' : 'Upload image',
      css: imageThumb ? `center / cover url("${imageThumb}")` : null,
      active: a.bg.kind === 'image',
      extraClass: imageThumb ? '' : 'add',
      content: imageThumb ? null : icon('plus'),
      onclick: () => {
        if (imageThumb && a.bg.kind !== 'image') { a.bg.kind = 'image'; commit(true); } else imgInput.click();
      },
    });
    sec.append(h('div', { class: 'bg-grid' },
      bgTile({
        name: 'Custom gradient',
        css: gradientCss(a.bg),
        active: a.bg.kind === 'gradient',
        onclick: () => { a.bg.kind = 'gradient'; commit(true); },
      }),
      imgTile, imgInput));
    if (a.bg.kind === 'gradient') sec.append(gradientBuilder());
    if (a.bg.kind === 'image') {
      sec.append(h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost sm', onclick: () => imgInput.click() }, 'Change image'),
        h('button', { class: 'btn ghost sm', onclick: async () => {
          await clearBgImage();
          if (imageThumb) URL.revokeObjectURL(imageThumb);
          imageThumb = null;
          a.bg.kind = 'preset'; a.bg.preset = 'glow';
          commit(true);
        } }, 'Remove image')));
    }
    return sec;
  }

  function gradientBuilder() {
    const preview = h('div', { class: 'grad-preview', style: { background: gradientCss(a.bg) } });
    const refresh = () => { preview.style.background = gradientCss(a.bg); commit(); };
    const colorsHost = h('div', { class: 'grad-colors' });
    const drawColors = () => {
      clear(colorsHost);
      const n = a.bg.three ? 3 : 2;
      for (let i = 0; i < n; i++) {
        colorsHost.append(colorInput(a.bg.colors[i], (v) => { a.bg.colors[i] = v; refresh(); }, `Color ${i + 1}`));
      }
    };
    drawColors();
    const angleRow = sliderRow('Angle', 0, 360, 5, a.bg.angle, (v) => `${v}°`, (v) => { a.bg.angle = v; refresh(); });
    angleRow.hidden = a.bg.style === 'radial' || a.bg.style === 'mesh';
    return h('div', { class: 'grad-builder' },
      preview,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Style'),
        chips([['linear', 'Linear'], ['radial', 'Radial'], ['mesh', 'Mesh'], ['conic', 'Conic']], a.bg.style, (v) => {
          a.bg.style = v;
          angleRow.hidden = v === 'radial' || v === 'mesh';
          refresh();
        })),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Colors'), colorsHost),
      toggle('Use a third color', !!a.bg.three, (on) => { a.bg.three = on; drawColors(); refresh(); }),
      angleRow);
  }

  function effectsSection() {
    if (isSolid(a)) return null;
    const animOk = canAnimate(a);
    return section('Background effects',
      sliderRow('Panel opacity', 35, 100, 1, Math.round(a.glass * 100), (v) => `${v}%`, (v) => { a.glass = v / 100; commit(); }),
      sliderRow(a.theme === 'light' ? 'Fade background' : 'Darken background', 0, 80, 1, Math.round(a.dim * 100), (v) => `${v}%`, (v) => { a.dim = v / 100; commit(); }),
      a.bg.kind === 'image' ? sliderRow('Blur image', 0, 30, 1, a.imgBlur, (v) => `${v}px`, (v) => { a.imgBlur = v; commit(); }) : null,
      animOk ? toggle('Slowly move the background', !!a.bg.animate, (on) => { a.bg.animate = on; commit(); }, 'A gentle drift. Turned off automatically with Reduce motion.') : null);
  }

  function accentSection() {
    const custom = colorInput(a.accent, (v) => { a.accent = v; commit(); drawSwatches(); }, 'Custom accent');
    const swatches = h('div', { class: 'swatches' });
    const drawSwatches = () => {
      clear(swatches);
      ACCENTS.forEach((c) => swatches.append(h('button', {
        class: `swatch${a.accent === c ? ' active' : ''}`,
        style: { background: c },
        'aria-label': `Accent ${c}`,
        onclick: () => {
          a.accent = c; commit();
          custom.querySelector('.color-in').value = c; custom.querySelector('.hex-in').value = c;
          drawSwatches();
        },
      })));
    };
    drawSwatches();
    return section('Accent color', h('p', { class: 'set-sub' }, 'Buttons, highlights and the adaptive backgrounds use it.'), swatches, custom);
  }

  function fontSection() {
    return section('Font and corners',
      h('p', { class: 'set-sub' }, 'The font used across the app. Name fonts on profiles are kept.'),
      h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Interface font' }, UI_FONTS.map((f) => h('button', {
        type: 'button',
        class: `chip${(a.font || 'default') === f.id ? ' active' : ''}`,
        role: 'radio',
        'aria-checked': String((a.font || 'default') === f.id),
        title: f.hint,
        style: f.css ? { fontFamily: f.css } : null,
        onclick: () => { a.font = f.id; commit(true); },
      }, f.name))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Corners'),
        chips(CORNERS, a.corners || 'normal', (v) => { a.corners = v; commit(); }),
        h('span', { class: 'field-hint' }, 'How rounded panels, buttons and text boxes are (on bigger screens).')));
  }

  // Save the look to a file to back it up, move it to another device or give it to a friend.
  const lookInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  lookInput.addEventListener('change', async () => {
    const f = lookInput.files[0];
    lookInput.value = '';
    if (!f) return;
    if (f.size > 64 * 1024) return toast("That file is too big to be a Hearth look.", 'error');
    let data = null;
    try { data = JSON.parse(await f.text()); } catch { /* handled below */ }
    if (!importAppearance(data)) return toast("That file isn't a Hearth look (export one with “Save my look”).", 'error');
    app.rerender();
    Object.assign(a, loadAppearance());
    draw();
    toast('Look loaded.');
  });
  function shareSection() {
    return section('Save or share your look',
      h('p', { class: 'set-sub' }, 'Theme, background, accent, font and layout in one small file. A background image stays on this device.'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost sm', onclick: () => {
          const blob = new Blob([JSON.stringify(exportAppearance(), null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          h('a', { href: url, download: 'hearth-look.json' }).click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        } }, 'Save my look'),
        h('button', { class: 'btn ghost sm', onclick: () => lookInput.click() }, 'Load a look…'),
        lookInput));
  }

  function draw() {
    const top = root.closest('.set-content');
    const scroll = top ? top.scrollTop : 0;
    clear(root).append(
      h('h2', { class: 'set-title' }, 'Appearance'),
      h('p', { class: 'muted-p' }, 'Changes apply instantly — this screen sits on top of your background so you can see it.'),
      themeSection(),
      backgroundSection(),
      effectsSection() || '',
      accentSection(),
      section('Server themes',
        toggle('Show server themes', a.serverThemes !== false, (v) => { a.serverThemes = v; commit(); }, 'Servers can set their own accent color and background. Turn this off to always use yours.')),
      section('Text and layout',
        sliderRow('Text size', 85, 125, 5, a.scale, (v) => `${v}%`, (v) => { a.scale = v; commit(); }),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Message density'),
          chips([['comfortable', 'Comfortable'], ['compact', 'Compact'], ['minimal', 'Minimal']], a.density || 'comfortable', (v) => { a.density = v; commit(); }),
          h('span', { class: 'field-hint' }, 'Comfortable has larger avatars and spacing. Compact fits more on screen. Minimal is dense and text-only.')),
        toggle('Reduce motion', a.reduceMotion, (v) => { a.reduceMotion = v; commit(); }, 'Turns off animated rings, name effects, profile effects and moving backgrounds.')),
      fontSection(),
      section('Performance',
        h('p', { class: 'set-sub' }, 'If Hearth feels slow or your fans spin up, turn this on. It switches off the frosted-glass blur, moving backgrounds and decorative animations (spinning rings, name and profile effects) on this device.'),
        chips([['auto', 'Automatic'], ['on', 'On \u2014 faster'], ['off', 'Off \u2014 all effects']], a.performance || 'auto', (v) => { a.performance = v; commit(); })),
      shareSection(),
      section(null, h('button', { class: 'btn ghost', onclick: async () => {
        if (!(await confirmDialog({ title: 'Reset appearance?', text: 'Theme, background, accent, font and layout go back to the defaults on this device.', confirm: 'Reset' }))) return;
        await clearBgImage();
        resetAppearance();
        app.rerender();
        Object.assign(a, loadAppearance());
        imageThumb = null;
        draw();
        toast('Appearance reset.');
      } }, 'Reset to defaults')),
    );
    if (top) top.scrollTop = scroll;
  }

  loadBgImage().then((blob) => {
    if (blob) { imageThumb = URL.createObjectURL(blob); draw(); }
  });
  draw();
  return root;
}

// ------------------------------------------------------------------ notifications tab
function notificationsTab(app) {
  const supported = 'Notification' in window;
  const state = h('span', { class: 'field-hint' });
  const drawState = () => {
    if (!supported) state.textContent = 'This browser does not support desktop notifications.';
    else if (Notification.permission === 'denied') state.textContent = 'Blocked in your browser settings. Allow notifications for this site to turn them on.';
    else if (Notification.permission === 'default') state.textContent = 'Your browser will ask for permission.';
    else state.textContent = 'Allowed.';
  };
  drawState();
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Notifications'),
    section('Desktop',
      toggle('Desktop notifications', supported && localStorage.getItem('hearth.notify') !== 'off' && Notification.permission === 'granted', async (on) => {
        localStorage.setItem('hearth.notify', on ? 'on' : 'off');
        if (on && supported && Notification.permission === 'default') await Notification.requestPermission();
        drawState();
      }, 'For DMs and @mentions while this tab is in the background. Do Not Disturb silences them.'),
      state),
    soundsSection(),
    quietHoursSection(app),
    section('Push (when Hearth is closed)', pushToggleRow(app), previewsRow(app)),
    perServerNotifications(app),
  );
}
// Quiet hours: Do Not Disturb on a schedule. The server follows it for push; this app follows it for sounds
// and pop-ups. Days are when a quiet period starts (22:00–07:00 on Friday covers Saturday morning).
function quietHoursSection(app) {
  const st = app.S.notifySettings || {};
  const d = { on: false, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6], ...(st.dnd || {}) };
  const status = h('p', { class: 'field-hint', 'aria-live': 'polite' });
  const drawStatus = () => { status.textContent = d.on ? (quietNow({ ...st, dnd: d }) ? 'Quiet hours are on right now.' : 'Not in quiet hours right now.') : ''; };
  const save = async (patch) => {
    Object.assign(d, patch);
    try { await app.setNotifySettings({ dnd: d }); drawStatus(); } catch (e) { toast(e.message, 'error'); }
  };
  const start = h('input', { class: 'input sm', type: 'time', value: d.start, 'aria-label': 'Quiet hours start', onchange: (e) => e.target.value && save({ start: e.target.value }) });
  const end = h('input', { class: 'input sm', type: 'time', value: d.end, 'aria-label': 'Quiet hours end', onchange: (e) => e.target.value && save({ end: e.target.value }) });
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = h('div', { class: 'chips', role: 'group', 'aria-label': 'Days' }, DAYS.map((label, i) => {
    const b = h('button', { type: 'button', class: `chip${d.days.includes(i) ? ' active' : ''}`, 'aria-pressed': String(d.days.includes(i)), onclick: () => {
      const on = !d.days.includes(i);
      const next = on ? [...d.days, i].sort() : d.days.filter((x) => x !== i);
      b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
      save({ days: next });
    } }, label);
    return b;
  }));
  drawStatus();
  return section('Quiet hours',
    toggle('Do Not Disturb on a schedule', !!d.on, (v) => save({ on: v }), 'No sounds, pop-ups or push notifications during these hours. Messages still arrive and show as unread.'),
    h('div', { class: 'row gap' }, h('span', null, 'From'), start, h('span', null, 'to'), end),
    days, status);
}
// What a phone's lock screen shows. Pushes never contain message text (the server can't read it); this decides
// whether they say who and where, or just "New message".
function previewsRow(app) {
  const st = app.S.notifySettings || {};
  return toggle('Show who and where on the lock screen', st.previews === 'names', async (v) => {
    try { await app.setNotifySettings({ previews: v ? 'names' : 'hidden' }); toast(v ? 'Push notifications now show the sender and conversation.' : 'Push notifications now just say \u201cNew message\u201d.'); } catch (e) { toast(e.message, 'error'); }
  }, 'Off by default: notifications on your phone or computer only say \u201cNew message\u201d. Message text is never sent, either way.');
}
function perServerNotifications(app) {
  const servers = app.S.servers.filter((s) => s.kind !== 'group');
  if (!servers.length) return null;
  return section('Per server',
    h('p', { class: 'set-sub' }, 'DMs and replies to you always notify unless you mute that conversation. Channels can override these from their right-click menu. These follow you to all your devices, and push notifications follow them too.'),
    ...servers.map((s) => {
      const pref = app.S.notifyPrefs['s:' + s.id] || {};
      const cur = pref.level && pref.level !== 'default' ? (pref.level === 'none' ? 'muted' : pref.level) : 'default';
      const sel = h('select', { class: 'input sm', 'aria-label': `Notifications for ${s.name}`, onchange: (e) => app.setNotify('s:' + s.id, e.target.value) },
        h('option', { value: 'default' }, 'Pings (default)'), h('option', { value: 'all' }, 'All messages'), h('option', { value: 'mentions' }, 'Only @mentions'), h('option', { value: 'muted' }, 'Nothing'));
      sel.value = cur;
      const everyone = h('label', { class: 'row gap tight field-hint' }, h('input', { type: 'checkbox', checked: !!pref.suppressEveryone, onchange: (e) => app.setNotify('s:' + s.id, undefined, { suppressEveryone: e.target.checked }) }), 'Ignore @everyone');
      return h('div', { class: 'kv' }, h('span', null, s.name), h('span', { class: 'row gap' }, everyone, sel));
    }));
}

// ------------------------------------------------------------------ chat tab
function chatTab(app) {
  const cur = () => ({ enterToSend: true, embeds: true, markdown: true, jumbo: true, compressImages: true, ...JSON.parse(localStorage.getItem('hearth.chat') || '{}') });
  const set = (k, v) => { const c = cur(); c[k] = v; localStorage.setItem('hearth.chat', JSON.stringify(c)); app.rerender(); };
  const c = cur();
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Chat'),
    section('Sending',
      toggle('Enter sends the message', c.enterToSend, (v) => set('enterToSend', v), c.enterToSend ? 'Shift+Enter adds a new line.' : 'Use Ctrl/⌘+Enter to send; Enter adds a new line.'),
      h('div', { class: 'kv' }, h('span', null, 'Edit your last message'), h('kbd', null, '↑ in an empty box')),
      h('div', { class: 'kv' }, h('span', null, 'Mention someone'), h('kbd', null, '@ then a name'))),
    section('Display',
      toggle('Optimize photos before sending', c.compressImages !== false, (v) => set('compressImages', v), 'Big photos are resized to 2560 px and made much smaller (also removing hidden location data). Turn off to always send the original file.'),
      toggle('Show image links as previews', c.embeds, (v) => set('embeds', v), 'Pasted image URLs are loaded from the other site, which can see your IP address.'),
      toggle('Format messages with Markdown', c.markdown, (v) => set('markdown', v), '**bold**, *italic*, `code`, ||spoilers|| and > quotes.'),
      toggle('Large emoji when a message is only emoji', c.jumbo, (v) => set('jumbo', v))),
    section('Screen sharing',
      toggle('Hide DMs while I share my screen', c.hideDmsWhileSharing !== false, (v) => set('hideDmsWhileSharing', v), 'Direct messages and group chats are covered, and their previews and notifications hidden, while you share your screen. You can still open one with \u201cShow while sharing\u201d.')),
  );
}

// ------------------------------------------------------------------ study tools tab
function studyTab(app) {
  return h('div', { class: 'set-form narrow' }, h('h2', { class: 'set-title' }, 'Study tools'),
    app.study().settingsSection({ section, toggle }));
}

// ------------------------------------------------------------------ sessions tab
// Every device signed in to this account: what it is, its IP address, when it was last used. Any of them can be
// signed out from here (it's disconnected right away), or all of them except this one.
const deviceOf = (ua) => {
  ua = String(ua || '');
  const app = /Electron\//.test(ua) ? 'Hearth desktop app' : /HearthAndroid|; wv\)/.test(ua) ? 'Hearth Android app' : '';
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Browser' : 'Unknown device';
  const o = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return { name: app || b, os: o, icon: /Android|iPhone|iPad/.test(ua) ? 'phone' : 'monitor' };
};
const agoText = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString();
};
const ENDED = { logged_out: 'Logged out', revoked: 'Signed out from another device', password_changed: 'Signed out: password changed', password_reset: 'Signed out: password reset', '2fa_enabled': 'Signed out: two-factor turned on', staff: 'Signed out by a server admin', suspended: 'Signed out: account suspended', expired: 'Expired', signed_out: 'Signed out' };
// Settings → Storage: how much room you use, your biggest files and uploads that haven't finished.
// The server knows only sizes, dates and where a file was posted. Names come from the encrypted messages, so
// they're shown for files in conversations this device can open (and "Encrypted file" otherwise).
function storageTab(app) {
  const MB = 1024 * 1024;
  const size = (b) => (b < MB ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 1024 * MB ? `${(b / MB).toFixed(1)} MB` : `${(b / 1024 / MB).toFixed(2)} GB`);
  const summary = h('div', { class: 'stack' }, h('span', { class: 'field-hint' }, 'Loading\u2026'));
  const files = h('div', { class: 'stack' });
  const uploads = h('div', { class: 'stack' });
  const KIND = { image: 'Picture', song: 'Profile song', emoji: 'Emoji', gif: 'GIF library' };
  const where = (f) => {
    const w = f.where;
    if (!w) return KIND[f.kind] || 'File';
    if (w.type === 'unsent') return 'Uploaded, not sent (removed after a day)';
    if (w.type === 'dm') return 'In a direct message';
    const s = (app.S.servers || []).find((x) => x.id === w.serverId);
    const c = s && (s.channels || []).find((x) => x.id === w.channelId);
    return s ? (s.kind === 'group' ? 'In a group chat' : `In #${c ? c.name : 'a channel'} \u00b7 ${s.name}`) : 'In a server you\u2019ve left';
  };
  async function load() {
    let q; let mine;
    try { [q, mine] = await Promise.all([api('GET', '/me/storage'), api('GET', '/me/storage/files')]); } catch (e) { clear(summary).append(h('p', { class: 'form-error' }, e.message)); return; }
    const pct = q.quotaMb ? Math.min(100, (q.used / (q.quotaMb * MB)) * 100) : 0;
    // (Element.append would print a null as "null": h() skips them.)
    clear(summary).append(...[
      q.blocked ? h('p', { class: 'key-bar bad' }, icon('ban'), 'An admin has turned off uploads for your account.') : null,
      h('div', { class: 'kv' }, h('span', null, 'Used'), h('strong', null, q.quotaMb ? `${size(q.used)} of ${q.quotaMb} MB` : `${size(q.used)} (no limit)`)),
      q.quotaMb ? h('div', { class: `storage-bar${pct > 90 ? ' warn' : ''}` }, h('i', { style: { width: `${pct}%` } })) : null,
      h('div', { class: 'kv' }, h('span', null, 'Uploaded today'), h('strong', null, q.dailyMb ? `${size(q.today)} of ${q.dailyMb} MB` : size(q.today))),
      h('div', { class: 'kv' }, h('span', null, 'Largest file'), h('strong', null, `${q.fileMb} MB`))].filter(Boolean));
    clear(files);
    if (!mine.files.length) files.append(h('p', { class: 'field-hint' }, 'You haven\u2019t uploaded anything yet.'));
    const rows = mine.files.map((f) => {
      const name = h('strong', { class: 'file-row-name' }, f.kind === 'attachment' ? 'Encrypted file' : (KIND[f.kind] || 'File'));
      const show = f.where && f.where.messageId ? h('button', { class: 'btn ghost sm', onclick: () => { app.showMessage(f.where); } }, 'Show') : null;
      files.append(h('div', { class: 'file-row' }, icon(f.kind === 'attachment' ? 'lock' : 'image'),
        h('span', { class: 'file-row-text' }, name, h('span', { class: 'field-hint' }, `${size(f.size)} \u00b7 ${new Date(f.createdAt).toLocaleDateString()} \u00b7 ${where(f)}`)), show));
      return { f, name };
    });
    // Names, a few at a time (each may need its message fetched and opened).
    (async () => {
      for (const { f, name } of rows.filter((r) => r.f.kind === 'attachment').slice(0, 25)) {
        try {
          const info = await app.fileInfo(f.url, f.where);
          if (info && info.name) name.textContent = info.preview ? `${info.name} (preview)` : info.name;
        } catch { /* left as "Encrypted file" */ }
      }
    })();
    clear(uploads);
    if (!mine.uploads.length) uploads.append(h('p', { class: 'field-hint' }, 'None right now.'));
    mine.uploads.forEach((u) => uploads.append(h('div', { class: 'file-row' }, icon('download'),
      h('span', { class: 'file-row-text' }, h('strong', null, `${size(u.received)} of ${size(u.size)}`),
        h('span', { class: 'field-hint' }, `Started ${new Date(u.createdAt).toLocaleString()} \u00b7 removed if nothing more arrives by ${new Date(u.expiresAt).toLocaleString()}`)),
      h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
        try { await api('DELETE', `/uploads/${encodeURIComponent(u.id)}`); toast('Upload cancelled. Its room is free again.'); load(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Cancel'))));
  }
  load();
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Storage'),
    section('Your storage', summary),
    section('Biggest files', h('p', { class: 'muted-p' }, 'Your files are end-to-end encrypted: the server knows their sizes but not their names. Names show here for files in conversations this device can open.'), files),
    section('Uploads in progress', h('p', { class: 'muted-p' }, 'Big files go up in pieces, so a dropped connection doesn\u2019t start them over. Unfinished ones are removed after a day without progress.'), uploads),
    section('What happens to your files',
      h('p', { class: 'muted-p' }, 'Deleting a message deletes its files straight away. So does deleting a server or group, for every message in it. When you leave a server, the files you posted stay there for the others. Deleting your account removes your profile pictures and song; the messages you sent stay (still encrypted), with their files.')));
}

function sessionsTab(app) {
  const list = h('div', { class: 'stack' }, h('span', { class: 'spinner' }));
  const ended = h('div', { class: 'stack' });
  const othersBtn = h('button', { class: 'btn danger', hidden: true, onclick: () => {
    modal({ title: 'Log out all other devices?', size: 'sm', body: h('p', { class: 'muted-p' }, 'Every other device is signed out right away and has to sign in again (with your password, and your two-factor code if it’s on). This device stays signed in.'),
      actions: [{ label: 'Cancel' }, { label: 'Log out others', kind: 'danger', action: async () => { const r = await api('POST', '/me/sessions/revoke-others'); toast(r.count ? `Signed out ${r.count} device${r.count === 1 ? '' : 's'}.` : 'No other devices were signed in.'); load(); } }] });
  } }, 'Log out all other devices');
  const row = (x, live) => {
    const d = deviceOf(x.ua);
    const bits = [d.os, x.ip ? `IP ${x.ip}` : ''].filter(Boolean).join(' · ');
    const when = live ? (x.current ? 'This device' : x.online ? 'Online now' : `Last active ${agoText(x.lastUsed)}`) : `${ENDED[x.revokeReason] || 'Ended'} · ${agoText(x.revokedAt || x.lastUsed)}`;
    return h('div', { class: `session-row${live ? '' : ' ended'}` },
      h('span', { class: 'session-ico' }, icon(d.icon)),
      h('span', { class: 'session-text' },
        h('strong', null, d.name, x.current ? h('span', { class: 'rpill ok' }, 'This device') : ''),
        h('span', null, bits),
        h('span', { class: 'field-hint' }, when, live ? ` · signed in ${new Date(x.createdAt).toLocaleDateString()}${x.twoFactor ? ' with two-factor' : ''}` : '')),
      live && !x.current ? h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
        try { await api('DELETE', `/me/sessions/${encodeURIComponent(x.id)}`); toast('Signed out of that device.'); load(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Revoke') : '');
  };
  let info = h('p', { class: 'field-hint' });
  const load = async () => {
    try {
      const r = await api('GET', '/me/sessions');
      clear(list).append(...r.active.map((x) => row(x, true)));
      othersBtn.hidden = r.active.length < 2;
      clear(ended);
      if (r.ended.length) ended.append(h('h4', { class: 'sub-title' }, 'Recently signed out'), ...r.ended.map((x) => row(x, false)));
      info.textContent = `A device that isn’t used for ${r.idleDays} days is signed out automatically, and every sign-in ends after ${r.maxDays} days.`;
    } catch (e) { clear(list).append(h('p', { class: 'form-error' }, e.message)); }
  };
  load();
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Active sessions'),
    h('p', { class: 'muted-p' }, 'Devices signed in to your account. If you don’t recognise one, revoke it and change your password. Signing a device out also removes your encryption keys from it.'),
    section(null, list, h('div', null, othersBtn), info),
    section(null, ended));
}

// ------------------------------------------------------------------ privacy tab
function privacyTab(app) {
  const p = { dms: 'everyone', friendRequests: 'everyone', ...(app.S.me.privacy || {}) };
  const save = async (k, v) => {
    try { const out = await api('PATCH', '/me/privacy', { [k]: v }); app.S.me.privacy = out; toast('Saved.'); } catch (e) { toast(e.message, 'error'); }
  };
  const blockedHost = h('div', { class: 'stack' });
  const drawBlocked = () => {
    clear(blockedHost);
    const ids = [...app.S.blocked];
    if (!ids.length) { blockedHost.append(h('p', { class: 'field-hint' }, 'You haven\u2019t blocked anyone.')); return; }
    ids.forEach((id) => {
      const u = app.S.users[id] || { username: 'unknown', profile: {} };
      blockedHost.append(h('div', { class: 'kv' }, h('span', null, (u.profile && u.profile.displayName) || u.username, ' ', h('span', { class: 'field-hint' }, u.username)),
        h('button', { class: 'btn ghost sm', onclick: async () => { await app.unblock(id); drawBlocked(); } }, 'Unblock')));
    });
  };
  drawBlocked();
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Privacy & safety'),
    section('Direct messages',
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Who can start a DM with you'),
        chips([['everyone', 'Anyone who shares a server'], ['friends', 'Friends only']], p.dms, (v) => save('dms', v)))),
    section('Friend requests',
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Who can send you friend requests'),
        chips([['everyone', 'Everyone'], ['mutual', 'People in my servers'], ['nobody', 'Nobody']], p.friendRequests, (v) => save('friendRequests', v)))),
    section('Blocked people',
      h('p', { class: 'set-sub' }, 'Blocked people can\u2019t DM you or send friend requests. Their messages in shared servers are hidden behind a click. They aren\u2019t notified.'),
      blockedHost),
    exportSection(app),
  );
}
// Export my data: your account, profile, servers and every message you can decrypt, as JSON plus attachments in a
// zip. The server sends ciphertext; it's decrypted and packed on this device. Starting needs your password.
function exportSection(app) {
  const status = h('p', { class: 'field-hint', 'aria-live': 'polite' });
  const bar = h('div', { class: 'export-progress', hidden: true }, h('div', { class: 'bar' }));
  let ctl = null;
  const cancel = h('button', { class: 'btn ghost sm', hidden: true, onclick: () => ctl && ctl.abort() }, 'Cancel');
  const start = h('button', { class: 'btn', onclick: async () => {
    let res;
    try { res = await confirmedCall(app, (x) => api('POST', '/me/export', x), { title: 'Export your data', text: 'This makes a zip of your account and the messages you can read, on this device.', button: 'Start export' }); } catch (e) { quiet(e); return; }
    if (!res) return;
    ctl = new AbortController();
    start.disabled = true; cancel.hidden = false; bar.hidden = false;
    try {
      const { blob, manifest } = await runExport({ token: res.token, S: app.S, sec: app.sec, decryptMessage: app.decryptMessage, signal: ctl.signal,
        onProgress: (text, f) => { status.textContent = text; bar.firstChild.style.width = Math.round(f * 100) + '%'; } });
      const url = URL.createObjectURL(blob);
      h('a', { href: url, download: `hearth-export-${app.S.me.username}-${new Date().toISOString().slice(0, 10)}.zip` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status.textContent = `Done: ${manifest.totals.messages.toLocaleString()} messages and ${manifest.totals.attachments} files (${fmtBytes(blob.size)}).${manifest.skipped.length ? ` ${manifest.skipped.length} item(s) were skipped; see manifest.json.` : ''}`;
    } catch (e) { status.textContent = ctl.signal.aborted ? 'Export cancelled.' : `The export stopped: ${e.message}`; }
    start.disabled = false; cancel.hidden = true; bar.hidden = true; ctl = null;
  } }, icon('download'), 'Export my data');
  return section('Your data',
    h('p', { class: 'set-sub' }, 'Download a copy of your account, profile, the servers and groups you\u2019re in, and every message you can read (with attachments), as JSON files in a zip. It\u2019s put together on this device after decrypting, so the server never sees it. Other people\u2019s private details aren\u2019t included.'),
    h('p', { class: 'field-hint' }, `Up to ${EXPORT_LIMITS.messages.toLocaleString()} messages and ${fmtBytes(EXPORT_LIMITS.attachmentBytes)} of attachments. Keep the page open while it runs.`),
    h('div', { class: 'row gap' }, start, cancel), bar, status);
}
const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ------------------------------------------------------------------ games & music tab
function activityTab(app) {
  const root = h('div', { class: 'set-form narrow' }, h('h2', { class: 'set-title' }, 'Games & music'), h('span', { class: 'spinner' }));
  const draw = async () => {
    let st;
    try { st = await api('GET', '/me/activity-settings'); } catch (e) { clear(root).append(h('p', { class: 'form-error' }, e.message)); return; }
    const save = async (patch, quiet) => {
      try { await api('PATCH', '/me/activity-settings', patch); Object.assign(st, patch); if (!quiet) toast('Saved.'); startDesktopDetection(st); } catch (e) { toast(e.message, 'error'); throw e; }
    };
    // Favorite games (stored on the profile)
    let games = [...((app.S.me.profile || {}).games || [])];
    const favHost = h('div', { class: 'fav-edit' });
    const saveGames = async () => {
      try { const u = await api('PATCH', '/me/profile', { games }); app.onMe(u); } catch (e) { toast(e.message, 'error'); }
    };
    const drawFav = () => {
      clear(favHost);
      games.forEach((g, i) => favHost.append(h('div', { class: 'fav-edit-item' },
        h('img', { src: gameImg(g.id), alt: '', loading: 'lazy' }), h('span', { class: 'fav-game-name' }, g.name),
        h('div', { class: 'fav-edit-btns' },
          i > 0 ? h('button', { class: 'icon-btn sm', 'aria-label': `Move ${g.name} earlier`, onclick: () => { [games[i - 1], games[i]] = [games[i], games[i - 1]]; drawFav(); saveGames(); } }, icon('chevronLeft')) : null,
          h('button', { class: 'icon-btn sm', 'aria-label': `Remove ${g.name}`, onclick: () => { games.splice(i, 1); drawFav(); saveGames(); } }, icon('close'))))));
      if (games.length < 12) favHost.append(h('button', { class: 'fav-edit-add', onclick: () => pickGame({ title: 'Add a favorite game', onPick: (g) => { if (!g.id || games.some((x) => x.id === g.id)) return; games.push({ id: g.id, name: g.name }); drawFav(); saveGames(); } }) }, icon('plus'), 'Add a game'));
    };
    drawFav();
    const lastfm = h('input', { class: 'input', value: st.lastfm || '', placeholder: 'Your Last.fm username', autocomplete: 'off', spellcheck: 'false' });
    const desktop = window.hearthDesktop;
    clear(root).append(h('h2', { class: 'set-title' }, 'Games & music'),
      section('Favorite games',
        h('p', { class: 'set-sub' }, 'Up to 12, shown on your profile card and your page. Pictures come from Steam and Wikipedia.'),
        favHost),
      section('Show what I\u2019m doing',
        toggle('Show the game I\u2019m playing', st.shareGames, (v) => save({ shareGames: v }), 'On your profile and in member lists, while you\u2019re online. Your profile also lists recently played games.'),
        toggle('Show the music I\u2019m listening to', st.shareMusic, (v) => save({ shareMusic: v })),
        h('p', { class: 'field-hint' }, 'Like your online status, this isn\u2019t end-to-end encrypted: the server sees it so it can show it. Turning these off hides it right away.'),
        h('div', null, h('button', { class: 'btn', onclick: () => openActivityPicker(app.S.me.activity) }, icon('gamepad'), 'Set it by hand'))),
      section('Detect it automatically',
        desktop && desktop.detectActivity
          ? h('p', { class: 'muted-p' }, '\u2705 The desktop app detects the game you\u2019re playing (Steam games and popular others like Fortnite, Valorant, League, Minecraft, Roblox) and your music (Spotify app, Apple Music app on Mac, any player on Linux).')
          : h('p', { class: 'muted-p' }, 'The Hearth desktop app detects your game and music by itself. In a browser or on your phone, use Last.fm below for music, or set it by hand.'),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Last.fm (works with Spotify, Apple Music, YouTube Music, TIDAL, Deezer\u2026)'),
          st.lastfmEnabled
            ? h('div', { class: 'row gap' }, lastfm, h('button', { class: 'btn', onclick: async () => { try { await save({ lastfm: lastfm.value.trim() }, true); toast(lastfm.value.trim() ? 'Connected to Last.fm.' : 'Last.fm disconnected.'); } catch { /* shown */ } } }, 'Save'))
            : h('p', { class: 'field-hint' }, 'Ask the server owner to add a free Last.fm API key (Admin \u2192 Owner \u2192 Games & music).'),
          h('p', { class: 'field-hint' }, 'Connect Spotify to Last.fm once at last.fm \u2192 Settings \u2192 Applications. Apple Music and others need a scrobbler app. Hearth only reads what you\u2019re playing right now.')),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Where I listen'),
          chips(st.platforms.map((x) => [x.id, x.name]), st.platform, (v) => save({ platform: v })),
          h('span', { class: 'field-hint' }, 'Used for "Listening on \u2026" and the "Open in" button when Hearth can\u2019t tell.'))),
      (st.recent || []).length ? section('Recently played', h('p', { class: 'set-sub' }, st.recent.map((r) => r.name).join(', ')),
        h('div', null, h('button', { class: 'btn ghost sm', onclick: async () => { await save({ clearRecent: true }); draw(); } }, 'Clear the list'))) : '');
  };
  draw();
  return root;
}

// ------------------------------------------------------------------ servers tab
function serversTab(app) {
  const S = app.S;
  const mine = S.servers.filter((s) => s.kind !== 'group');
  const isAdmin = (s) => s.ownerId === S.me.id || (s.roles || {})[S.me.id] === 'admin';
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Server settings'),
    h('p', { class: 'muted-p' }, 'Overview, roles, members and moderation for servers you manage. Per-server notifications are under Notifications.'),
    section(null, ...(mine.length ? mine.map((s) => h('div', { class: 'kv' },
      h('span', null, s.name, ' ', h('span', { class: 'field-hint' }, s.ownerId === S.me.id ? 'Owner' : isAdmin(s) ? 'Admin' : 'Member')),
      isAdmin(s) ? h('button', { class: 'btn ghost sm', onclick: () => { document.querySelector('.settings-modal')?.closest('.modal-backdrop')?._close?.(); app.openServerSettings(s.id); } }, 'Manage') : h('span', { class: 'field-hint' }, 'No admin access')))
      : [h('p', { class: 'field-hint' }, 'You\u2019re not in any servers yet.')])));
}

// ------------------------------------------------------------------ layout tab
const PART = { rail: 'Servers', sidebar: 'Channels', main: 'Conversation', panel: 'Side panel' };
// A little diagram of an arrangement, drawn with the same grid idea the app uses.
function layoutDiagram(L, big = false) {
  const cols = L.order.filter((k) => !(k === 'rail' && L.rail === 'top'));
  const w = { rail: '12px', sidebar: '1.3fr', main: '3fr', panel: '1.1fr' };
  const bw = { rail: '34px', sidebar: '1.4fr', main: '3fr', panel: '1.2fr' };
  const el = h('div', { class: `lp${big ? ' big' : ''}`, 'aria-hidden': 'true', style: {
    gridTemplateColumns: cols.map((k) => (big ? bw : w)[k]).join(' '),
    gridTemplateRows: L.rail === 'top' ? (big ? '22px 1fr' : '9px 1fr') : '1fr',
  } });
  if (L.rail === 'top') el.append(h('i', { class: 'lp-rail', style: { gridColumn: '1 / -1' } }, big ? PART.rail : ''));
  cols.forEach((k) => el.append(h('i', { class: `lp-${k}` }, big ? PART[k] : '')));
  return el;
}
function layoutTab(app) {
  const root = h('div', { class: 'set-form narrow' });
  const draw = () => {
    const a = loadAppearance();
    const L = a.layout;
    const save = (patch) => { const x = loadAppearance(); x.layout = { ...x.layout, ...patch }; saveAppearance(x); draw(); };
    const same = (p) => p.layout.rail === L.rail && p.layout.order.join() === L.order.join();

    // drag-and-drop arrangement (plus arrow buttons for keyboard and touch)
    const items = L.order.filter((k) => !(k === 'rail' && L.rail === 'top'));
    let dragKey = null;
    const move = (k, dir) => {
      const order = [...L.order];
      const i = order.indexOf(k);
      // skip over the server bar when it lives on top
      let j = i + dir;
      if (L.rail === 'top' && order[j] === 'rail') j += dir;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      save({ order });
    };
    const arrange = h('div', { class: 'arrange', role: 'list', 'aria-label': 'Column order, left to right' }, items.map((k, i) => {
      const it = h('div', { class: 'arrange-item', role: 'listitem', draggable: 'true', dataset: { k } },
        icon('menu', 'ic grip'), h('span', null, PART[k]),
        h('button', { class: 'icon-btn', 'aria-label': `Move ${PART[k]} left`, disabled: i === 0, onclick: () => move(k, -1) }, icon('chevronLeft')),
        h('button', { class: 'icon-btn', 'aria-label': `Move ${PART[k]} right`, disabled: i === items.length - 1, onclick: () => move(k, 1) }, icon('chevronRight')));
      it.addEventListener('dragstart', (e) => { dragKey = k; it.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      it.addEventListener('dragend', () => it.classList.remove('dragging'));
      it.addEventListener('dragover', (e) => { e.preventDefault(); it.classList.add('over'); });
      it.addEventListener('dragleave', () => it.classList.remove('over'));
      it.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragKey || dragKey === k) return;
        const order = L.order.filter((x) => x !== dragKey);
        const at = order.indexOf(k) + (L.order.indexOf(dragKey) < L.order.indexOf(k) ? 1 : 0);
        order.splice(at, 0, dragKey);
        save({ order });
      });
      return it;
    }));

    clear(root).append(
      h('h2', { class: 'set-title' }, 'Layout'),
      h('p', { class: 'muted-p' }, 'Arrange the app the way you like. Saved on this device. On phones the app always uses its mobile layout.'),
      section('Presets', h('div', { class: 'layout-presets' }, LAYOUT_PRESETS.map((p) => h('button', {
        class: `layout-card${same(p) ? ' active' : ''}`, 'aria-pressed': String(same(p)),
        onclick: () => save({ order: [...p.layout.order], rail: p.layout.rail }),
      }, layoutDiagram(p.layout), h('strong', null, p.name), h('span', null, p.hint))))),
      section('Arrange',
        h('p', { class: 'set-sub' }, 'Drag the pieces (or use the arrows) to change their order from left to right.'),
        layoutDiagram(L, true), arrange,
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Server bar'),
          chips([['side', 'Down the side'], ['top', 'Across the top']], L.rail, (v) => save({ rail: v }))),
        toggle('Compact server bar', L.railSize === 'compact', (v) => save({ railSize: v ? 'compact' : 'normal' }), 'Smaller server icons.')),
      section('Sizes',
        sliderRow('Sidebar width', 200, 420, 4, L.sideW, (v) => `${v}px`, (v) => { const x = loadAppearance(); x.layout.sideW = v; saveAppearance(x); }),
        sliderRow('Side panel width', 220, 520, 4, L.panelW, (v) => `${v}px`, (v) => { const x = loadAppearance(); x.layout.panelW = v; saveAppearance(x); }),
        sliderRow('Thread panel width', 300, 680, 4, L.threadW, (v) => `${v}px`, (v) => { const x = loadAppearance(); x.layout.threadW = v; saveAppearance(x); }),
        h('p', { class: 'field-hint' }, 'Tip: you can also drag the inner edge of the sidebar or side panel. Double-click the edge to reset it.')),
      section('Panel style',
        chips([['floating', 'Floating'], ['attached', 'Attached'], ['spacious', 'Spacious']], L.style, (v) => save({ style: v })),
        h('p', { class: 'field-hint' }, 'Floating panels have gaps and rounded corners. Attached panels sit edge to edge. Spacious adds more room around everything.')),
      section(null, h('button', { class: 'btn ghost', onclick: () => { const x = loadAppearance(); x.layout = { ...DEFAULTS.layout }; saveAppearance(x); draw(); toast('Layout reset.'); } }, 'Reset layout')),
    );
  };
  draw();
  return root;
}

// ------------------------------------------------------------------ apps & devices tab
function pushToggleRow(app) {
  const note = h('span', { class: 'field-hint' }, 'Checking\u2026');
  const box = h('input', { type: 'checkbox', disabled: true });
  const row = h('label', { class: 'toggle-row' },
    h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, 'Push notifications on this device'), note),
    h('span', { class: 'switch' }, box, h('span', { class: 'switch-track' })));
  const refresh = async () => {
    const st = await app.push.status().catch(() => 'unsupported');
    box.checked = st === 'on';
    box.disabled = st === 'unsupported' || st === 'blocked';
    note.textContent = {
      on: 'You\u2019ll get notified about DMs, mentions and replies even when Hearth is closed. Notifications say who and where, never what \u2014 messages stay encrypted.',
      off: 'Get notified about DMs, mentions and replies even when Hearth is closed.',
      blocked: 'Notifications are blocked for this site. Allow them in your browser\u2019s site settings.',
      unsupported: /iPhone|iPad/.test(navigator.userAgent) && !app.isInstalled ? 'On iPhone and iPad, add Hearth to your Home Screen first, then turn this on inside the app.'
        : !(app.S.config && app.S.config.pushEnabled) ? 'Push notifications are turned off on this server.' : 'This browser doesn\u2019t support push notifications.',
    }[st];
  };
  box.addEventListener('change', async () => {
    box.disabled = true;
    try { if (box.checked) await app.push.enable(); else await app.push.disable(); toast(box.checked ? 'Push notifications are on for this device.' : 'Push notifications are off for this device.'); } catch (e) { toast(e.message, 'error'); }
    refresh();
  });
  refresh();
  return row;
}
// In the Android app: notifications come from the app itself while it's open or in the background.
function androidNotifyRow() {
  const box = h('div', { class: 'stack' });
  const draw = () => {
    clear(box);
    const st = window.Notification ? Notification.permission : 'default';
    box.append(h('p', { class: 'muted-p' }, st === 'granted'
      ? 'Notifications are on. The app notifies you about messages while it\u2019s open or in the background (not after you swipe it away).'
      : st === 'denied' ? 'Notifications are blocked. Turn them on in Android Settings \u2192 Apps \u2192 Hearth \u2192 Notifications.'
        : 'Allow the app to notify you about new messages.'));
    if (st === 'default') box.append(h('div', null, h('button', { class: 'btn primary', onclick: async () => { await Notification.requestPermission(); draw(); } }, 'Allow notifications')));
  };
  draw();
  return box;
}
function appsTab(app) {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const cfg = app.S.config || {};
  const installBox = h('div', { class: 'stack' });
  const drawInstall = () => {
    clear(installBox);
    if (window.hearthDesktop) { installBox.append(h('p', { class: 'muted-p' }, 'You\u2019re using the Hearth desktop app. Its settings are below.')); return; }
    if (androidApp.on) {
      installBox.append(h('p', { class: 'muted-p' }, `You\u2019re using the Hearth Android app${androidApp.version ? ` (version ${androidApp.version})` : ''}. Files you save go to Downloads/Hearth.`),
        h('div', null, h('button', { class: 'btn', onclick: () => androidApp.switchServer() }, 'Switch server')));
      return;
    }
    if (app.isInstalled) { installBox.append(h('p', { class: 'muted-p' }, 'Hearth is installed on this device. \uD83C\uDF89')); return; }
    if (app.canInstall) {
      installBox.append(h('p', { class: 'muted-p' }, 'Install Hearth as an app: it gets its own window and icon, opens instantly and can send notifications.'),
        h('div', null, h('button', { class: 'btn primary', onclick: async () => { await app.install(); drawInstall(); } }, icon('download'), 'Install app')));
    } else if (ios) {
      installBox.append(h('p', { class: 'muted-p' }, 'On iPhone and iPad: open this site in Safari, tap the Share button, then "Add to Home Screen".'));
    } else if (android) {
      installBox.append(h('p', { class: 'muted-p' }, 'On Android: open the browser menu (\u22ee) and tap "Install app" or "Add to Home screen".'));
    } else {
      installBox.append(h('p', { class: 'muted-p' }, 'In Chrome or Edge, use the install icon at the right end of the address bar, or the browser menu \u2192 "Install Hearth". Firefox and Safari on desktop: use the desktop app below.'));
    }
  };
  drawInstall();
  const dl = (cfg.downloads || []);
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Apps & devices'),
    section('Install on this device', installBox),
    window.hearthDesktop ? desktopSettingsSection({ h, section, toggle, field, toast }) : null,
    window.hearthDesktop ? null : section('Desktop app',
      h('p', { class: 'muted-p' }, 'A Windows, Mac and Linux app with a tray icon, unread badge and launch-at-login.'),
      dl.length || cfg.desktopUrl
        ? h('div', null, h('a', { class: 'btn ghost', href: '/download', target: '_blank', rel: 'noopener' }, icon('download'), 'Download page'))
        : h('p', { class: 'field-hint' }, 'The server owner hasn\u2019t published desktop installers yet.')),
    androidApp.on ? section('Notifications', androidNotifyRow())
      : section('Notifications', pushToggleRow(app),
        h('p', { class: 'field-hint' }, 'Turn this on separately on each phone or computer you use.')),
    section('Share', h('p', { class: 'muted-p' }, 'Send friends this link to get the app:'),
      h('div', { class: 'row gap' }, h('input', { class: 'input mono', readonly: true, value: `${location.origin}/download` }),
        h('button', { class: 'btn ghost', onclick: () => { navigator.clipboard.writeText(`${location.origin}/download`).then(() => toast('Link copied.')); } }, 'Copy'))),
  );
}

// ------------------------------------------------------------------ instance tab (server administrator only)
function instanceTab(app) {
  const root = h('div', { class: 'set-form narrow' });
  const draw = async () => {
    clear(root).append(h('h2', { class: 'set-title' }, 'Instance'), h('span', { class: 'spinner' }));
    let st;
    try { st = await api('GET', '/admin/settings'); } catch (e) { clear(root).append(h('p', { class: 'form-error' }, e.message)); return; }
    const turn = await api('GET', '/admin/turn').catch(() => ({ urls: [], secretSet: false }));
    const turnUrlsIn = h('input', { class: 'input mono', value: turn.urls.join(','), placeholder: 'turn:your-server-ip:3478?transport=udp' });
    const turnSecretIn = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: turn.secretSet ? 'A secret is saved' : 'static-auth-secret' });
    const relayResult = h('div', { class: 'giphy-test' });
    const curHint = st.gifProvider === 'giphy' ? (st.giphyKeySet ? st.giphyKeyHint : '') : (st.klipyKeySet ? st.klipyKeyHint : '');
    const keyIn = h('input', { class: 'input mono', placeholder: curHint ? `Current key ${curHint}` : `Paste your ${st.gifProvider === 'giphy' ? 'GIPHY' : 'KLIPY'} API key`, autocomplete: 'off', spellcheck: 'false' });
    const result = h('div', { class: 'giphy-test' });
    const test = async () => {
      clear(result).append(h('span', { class: 'spinner' }), ' Testing\u2026');
      try {
        const r = await api('POST', '/admin/giphy/test', { key: keyIn.value, provider: st.gifProvider });
        clear(result).append(r.sample ? h('img', { src: r.sample, alt: '' }) : null, h('span', { class: 'ok-text' }, '\u2713 It answered. This key works.'));
        return true;
      } catch (e) { clear(result).append(h('span', { class: 'form-error' }, e.message)); return false; }
    };
    const rating = h('select', { class: 'input sm', onchange: (e) => api('PATCH', '/admin/settings', { giphyRating: e.target.value }).then(() => toast('Saved.')) },
      [['g', 'G \u2014 everyone'], ['pg', 'PG'], ['pg-13', 'PG-13 (default)'], ['r', 'R']].map(([v, l]) => h('option', { value: v }, l)));
    rating.value = st.giphyRating;
    clear(root).append(
      h('h2', { class: 'set-title' }, 'Instance'),
      h('p', { class: 'muted-p' }, 'Settings for this whole Hearth server. Only you see this page.'),
      h('div', null, h('button', { class: 'btn primary', onclick: () => { document.querySelector('.set-close')?.click(); app.openAdmin(); } }, icon('shield'), 'Open admin dashboard')),
      section('GIF search',
        h('p', { class: 'muted-p' }, st.gifProvider === 'library' ? 'Only this server\u2019s own GIF library is used: free, no key, no limits. Add GIFs from the GIF picker \u2192 This server tab.'
          : st.klipyKeySet || st.giphyKeySet ? `GIF search is on, using ${st.gifProvider === 'giphy' ? 'GIPHY' : 'KLIPY'}. Popular results are cached and shared, and if the limit is ever reached the picker switches to this server\u2019s own library instead of failing.` : 'No key yet: the GIF picker uses this server\u2019s own library (free, no limits) until you add one.'),
        h('div', { class: 'chips' }, [['klipy', 'KLIPY (recommended, free)'], ['giphy', 'GIPHY'], ['library', 'Only our own library']].map(([k, l]) => h('button', {
          class: `chip${st.gifProvider === k ? ' active' : ''}`, onclick: async () => { await api('PATCH', '/admin/settings', { gifProvider: k }); toast('Saved.'); draw(); },
        }, l))),
        st.gifProvider === 'library' ? null : st.gifProvider === 'giphy' ? h('p', { class: 'field-hint' }, 'GIPHY\u2019s free beta keys allow about 100 searches an hour for the whole server. KLIPY offers free production keys with no limit.') : h('ol', { class: 'steps' },
          h('li', null, 'Sign up at ', h('a', { href: 'https://partner.klipy.com/api-keys', target: '_blank', rel: 'noopener' }, 'partner.klipy.com'), ' (free) and create an API key ("Add platform").'),
          h('li', null, 'Paste it below, click Test, then Save.'),
          h('li', null, 'Test keys allow 100 searches an hour. In the KLIPY panel, ', h('strong', null, 'request production access'), ' \u2014 it\u2019s free and removes the limit.')),
        st.gifProvider === 'library' ? null : h('div', { class: 'row gap' }, keyIn, h('button', { class: 'btn ghost', onclick: test }, 'Test')),
        st.gifProvider === 'library' ? null : result,
        st.gifProvider === 'library' ? null : h('div', { class: 'row gap' },
          h('button', { class: 'btn primary', onclick: async () => {
            if (!keyIn.value.trim()) return toast('Paste a key first.', 'error');
            if (!(await test())) return;
            await api('PATCH', '/admin/settings', st.gifProvider === 'giphy' ? { giphyKey: keyIn.value.trim() } : { klipyKey: keyIn.value.trim() });
            toast('GIF search is on for everyone.');
            draw();
          } }, 'Save key')),
        st.gifProvider === 'giphy' ? h('div', { class: 'kv' }, h('span', null, 'Content rating'), rating) : null,
        toggle('Load GIFs through this server', st.gifProxy, async (v) => { await api('PATCH', '/admin/settings', { gifProxy: v }); toast('Saved.'); },
          'GIPHY never sees your members\u2019 IP addresses. Uses a little of this server\u2019s bandwidth.')),
      section('Calls (voice & video relay)',
        h('p', { class: 'muted-p' }, turn.urls.length && turn.secretSet
          ? `Relay set up: ${turn.urls[0].replace(/\?.*/, '')}. Calls fall back to it when a direct connection isn\u2019t possible.`
          : 'No relay yet. Without one, people on mobile data, some home internet and school/office Wi-Fi can\u2019t join calls.'),
        h('p', { class: 'field-hint' }, 'Easiest: on the VPS run ', h('code', null, 'bash scripts/setup-turn.sh'), ' \u2014 it installs and secures the relay and connects it here automatically.'),
        field('Relay addresses', turnUrlsIn, 'Comma-separated, e.g. turn:203.0.113.7:3478?transport=udp,turn:203.0.113.7:3478?transport=tcp'),
        field('Shared secret', turnSecretIn, 'The static-auth-secret from coturn. Leave empty to keep the current one.'),
        h('div', { class: 'row gap' },
          // The relay secret and addresses decide where everyone's calls are relayed: saving needs your password again.
          h('button', { class: 'btn primary', onclick: async () => {
            try {
              const r = await confirmedCall(app, (x) => api('PUT', '/admin/turn', { urls: turnUrlsIn.value, ...(turnSecretIn.value.trim() ? { secret: turnSecretIn.value.trim() } : {}), ...x }), { title: 'Save relay settings', button: 'Save' });
              if (r) { toast('Saved.'); draw(); }
            } catch (e) { quiet(e); }
          } }, 'Save'),
          h('button', { class: 'btn ghost', onclick: () => testRelay(relayResult) }, 'Test relay')),
        relayResult)
    );
  };
  draw();
  return root;
}

// ------------------------------------------------------------------ sounds
function soundsSection() {
  const wrap = h('div', { class: 'stack' });
  const groups = [...new Set(SOUND_LIBRARY.map((x) => x.group))];
  const draw = () => {
    const p = soundPrefs();
    const row = ([id, label, hint]) => {
      const cur = p.events[id].sound;
      const fileName = h('span', { class: 'field-hint sound-file' });
      const fileIn = h('input', { type: 'file', accept: 'audio/*', hidden: true, onchange: async () => {
        const f = fileIn.files[0]; fileIn.value = '';
        if (!f) return;
        try { await setCustomSound(id, f); toast(`Using ${f.name} for ${label.toLowerCase()}.`); playSound(id, { force: true }); draw(); } catch (e) { toast(e.message, 'error'); }
      } });
      const sel = h('select', { class: 'input sm sound-pick', 'aria-label': `Sound for ${label}` },
        h('option', { value: 'none' }, 'None (silent)'),
        ...groups.map((g) => h('optgroup', { label: g }, SOUND_LIBRARY.filter((x) => x.group === g).map((x) => h('option', { value: x.id }, x.name)))),
        h('optgroup', { label: 'Your own' }, h('option', { value: 'custom' }, 'Your own sound file\u2026')));
      sel.value = cur;
      sel.onchange = async () => {
        if (sel.value === 'custom') {
          if (await customSoundName(id)) { setSoundPrefs({ event: id, sound: 'custom' }); playSound(id, { force: true }); draw(); } else { sel.value = cur; fileIn.click(); }
          return;
        }
        setSoundPrefs({ event: id, sound: sel.value });
        playSound(id, { force: true, sound: sel.value });
      };
      if (cur === 'custom') customSoundName(id).then((n) => { fileName.textContent = n ? `\u266A ${n}` : ''; });
      return h('div', { class: 'sound-row' },
        h('button', { class: 'icon-btn sm sound-play', 'aria-label': `Preview ${label}`, 'data-tip': 'Preview', onclick: () => playSound(id, { force: true }) }, '\u25B6'),
        h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, label), hint ? h('span', { class: 'field-hint' }, hint) : null, fileName),
        sel,
        h('button', { class: 'icon-btn sm', 'aria-label': `Upload your own sound for ${label}`, 'data-tip': 'Use your own sound file', onclick: () => fileIn.click() }, icon('plus')),
        fileIn);
    };
    const byGroup = (g) => SOUND_EVENTS.filter((e) => e[3] === g);
    clear(wrap).append(
      toggle('Play sounds', p.enabled, (v) => { setSoundPrefs({ enabled: v }); draw(); if (v) playSound('dm', { force: true }); }),
      sliderRow('Volume', 0, 100, 5, Math.round(p.volume * 100), (v) => `${v}%`, (v) => setSoundPrefs({ volume: v / 100 })),
      h('div', { class: `sound-list${p.enabled ? '' : ' off'}` },
        ...['Messages', 'People', 'Voice'].flatMap((g) => [h('div', { class: 'perm-group-label sound-group' }, g), ...byGroup(g).map(row)])),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost sm', onclick: () => { resetSoundPrefs(); draw(); toast('Sounds reset to defaults.'); } }, 'Reset to defaults'),
        h('span', { class: 'field-hint' }, 'Your choices and sound files stay on this device. Do Not Disturb silences message sounds.')));
  };
  draw();
  return section('Sounds', wrap);
}

// Checks from this browser that the relay hands out working relay addresses.
async function testRelay(out) {
  clear(out).append(h('span', { class: 'spinner' }), ' Testing the relay\u2026');
  try {
    const ice = await api('GET', '/ice');
    if (!ice.some((x) => String(x.urls).includes('turn:'))) throw new Error('No relay is configured yet.');
    const pc = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: 'relay' });
    pc.createDataChannel('t');
    const found = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 8000);
      pc.onicecandidate = (e) => { if (e.candidate && / relay /.test(e.candidate.candidate)) { clearTimeout(t); resolve(true); } };
      pc.createOffer().then((o) => pc.setLocalDescription(o));
    });
    pc.close();
    clear(out).append(found ? h('span', { class: 'ok-text' }, '\u2713 The relay works. Calls can connect from any network.')
      : h('span', { class: 'form-error' }, 'The relay didn\u2019t answer. Check that UDP/TCP 3478 and UDP 49160\u201349400 are open (also in your VPS provider\u2019s firewall), and that the secret matches.'));
  } catch (e) { clear(out).append(h('span', { class: 'form-error' }, e.message)); }
}

// ------------------------------------------------------------------ MySpace-style profile page
function profilePageSection(app, draft, set) {
  const S = app.S;
  // Song (uploaded right away, like pictures)
  const songHost = h('div');
  const drawSong = () => {
    const fileIn = h('input', { type: 'file', accept: 'audio/mpeg,audio/mp4,audio/ogg,audio/wav,.mp3,.m4a,.ogg,.wav', hidden: true, onchange: async () => {
      const f = fileIn.files[0]; if (!f) return;
      const fd = new FormData(); fd.append('file', f); fd.append('title', f.name.replace(/\.[^.]+$/, ''));
      try { app.onMe(await upload('/me/song', fd)); draft.songTitle = (S.me.profile || {}).songTitle; toast('Profile song added.'); drawSong(); } catch (e) { toast(e.message, 'error'); }
    } });
    const has = !!S.me.song;
    clear(songHost).append(h('div', { class: 'media-row' },
      h('span', { class: 'media-thumb song-thumb' }, '\u266B'),
      h('div', { class: 'media-text' }, h('strong', null, has ? (S.me.profile.songTitle || 'Profile song') : 'Profile song'),
        h('span', { class: 'field-hint' }, has ? 'Plays when someone presses play on your profile (or by itself, if you turn on autoplay under Profile page).' : `MP3, M4A, OGG or WAV up to ${S.config.songMb || 10} MB.`)),
      h('div', { class: 'media-actions' },
        h('button', { class: 'btn primary sm', onclick: () => fileIn.click() }, has ? 'Change' : 'Upload'),
        has ? h('button', { class: 'btn ghost sm', onclick: async () => { app.onMe(await api('DELETE', '/me/song')); drawSong(); } }, 'Remove') : null),
      fileIn));
  };
  drawSong();
  // About me (Markdown) + interests
  const about = h('textarea', { class: 'input', rows: '6', maxlength: '2000', placeholder: '# Hi!\nA bit about me…\n\n## Favourite things\n- music\n- games', oninput: (e) => set('aboutMe')(e.target.value) });
  about.value = draft.aboutMe || '';
  const interests = h('input', { class: 'input', maxlength: '300', placeholder: 'music, gaming, drawing, cats', value: (draft.interests || []).join(', '),
    oninput: (e) => set('interests')(e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12)) });
  // Top friends: pick up to 8 of your friends
  const friends = Object.values(S.relationships || {}).filter((r) => r.status === 'accepted').map((r) => S.users[r.userId]).filter(Boolean);
  const picked = new Set(draft.topFriends || []);
  const tf = h('div', { class: 'tf-pick' });
  const drawTf = () => clear(tf).append(...(friends.length ? friends.map((u) => h('button', {
    class: `chip${picked.has(u.id) ? ' active' : ''}`,
    onclick: () => { if (picked.has(u.id)) picked.delete(u.id); else if (picked.size < 8) picked.add(u.id); else return toast('You can pick up to 8.', 'error'); set('topFriends')([...picked]); drawTf(); },
  }, (u.profile && u.profile.displayName) || u.username)) : [h('span', { class: 'field-hint' }, 'Add some friends first.')]));
  drawTf();
  return fold('Profile page extras', 'Song, interests and top friends',
    songHost,
    field('More about me', about, 'Shown on your full profile. Markdown works: # headings, - lists, **bold**.'),
    field('Interests', interests, 'Up to 12, separated by commas.'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, `Top friends (${picked.size}/8)`), tf));
}
