// User settings: profile customization (all free), account, voice & audio, appearance.
import { h, clear, icon, toast, playSound } from './util.js';
import { api, upload } from './api.js';
import { EVENTS as SOUND_EVENTS, LIBRARY as SOUND_LIBRARY, soundPrefs, setSoundPrefs, resetSoundPrefs, setCustomSound, customSoundName } from './sounds.js';
import * as E2EE from './e2ee.js';
import { profileCard, FONT_STACKS, cropStyle } from './profile-ui.js';
import { openCropper } from './cropper.js';
import { modal, confirmDialog, field } from './ui.js';
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

// ------------------------------------------------------------------ the modal
// Grouped like most chat apps so people can find things: [group label, [[key, label, icon], ...]]
const TAB_GROUPS = [
  ['Account', [['profile', 'Profile', 'user'], ['account', 'Security', 'lock'], ['sessions', 'Sessions', 'monitor']]],
  ['App', [['appearance', 'Appearance', 'palette'], ['layout', 'Layout', 'sidebar'], ['chat', 'Chat', 'message'], ['notifications', 'Notifications', 'bell'], ['voice', 'Voice & video', 'mic'], ['apps', 'Apps & devices', 'download']]],
  ['Privacy', [['privacy', 'Privacy & safety', 'shield']]],
  ['Servers', [['servers', 'Server settings', 'gear']]],
  ['Instance', [['instance', 'Instance', 'monitor']], 'admin'],
];

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
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', text: 'You have profile changes that are not saved yet.', confirm: 'Discard', danger: true }))) return;
    dirty = false;
    m.close();
  }

  const drawNav = () => {
    clear(nav);
    TAB_GROUPS.filter(([, , who]) => who !== 'admin' || app.S.me.instanceAdmin).forEach(([group, tabs]) => {
      nav.append(h('div', { class: 'set-nav-label' }, group));
      tabs.forEach(([k, label, ic]) => nav.append(h('button', {
        class: `set-nav-btn${k === current ? ' active' : ''}`,
        'aria-current': k === current ? 'page' : null,
        onclick: async () => {
          if (k === current) return;
          if (dirty && !(await confirmDialog({ title: 'Discard changes?', text: 'You have profile changes that are not saved yet.', confirm: 'Discard', danger: true }))) return;
          dirty = false;
          current = k;
          draw();
        },
      }, icon(ic), label)));
    });
    nav.append(h('div', { class: 'set-nav-sep' }));
    nav.append(h('button', { class: 'set-nav-btn danger', onclick: async () => {
      if (await confirmDialog({ title: 'Log out?', text: 'Your encryption key is removed from this browser. Log back in with your password to read your DMs again.', confirm: 'Log out', danger: true })) app.logout();
    } }, 'Log out'));
  };

  const draw = () => {
    stopMicTest();
    drawNav();
    clear(content);
    const views = { instance: instanceTab, apps: appsTab, layout: layoutTab, profile: profileTab, account: accountTab, sessions: sessionsTab, voice: voiceTab, appearance: appearanceTab, chat: chatTab, notifications: notificationsTab, privacy: privacyTab, servers: serversTab };
    content.append(views[current](app, (d) => { dirty = d; }));
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
      if (f.size > 12 * 1024 * 1024) return toast('Images can be up to 12 MB.', 'error');
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
      mediaRow('avatar', 'Avatar', 'PNG, JPG, WebP or animated GIF. You can move and zoom it after choosing.'),
      mediaRow('banner', 'Banner', 'Shown across the top of your profile. GIFs animate.'),
      mediaRow('background', 'Profile background', 'Fills your whole profile card behind everything.'),
      toggle('Show banner', draft.showBanner !== false, (v) => { set('showBanner')(v); }, 'Turn this off to let your profile background fill the whole card, top to bottom.'),
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
  const color2Wrap = h('div', { hidden: !gradOn }, colorInput(draft.nameColor2 || '#f2a541', (v) => { draft.nameColor2 = v; changed(); }, 'Second name color'));
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
    h('p', { class: 'muted-p' }, 'Everything here is free, forever. Changes show up live on the right.'),
    section('Pictures', mediaHost),
    profilePageSection(app, draft, set),
    section('About you',
      field('Display name', displayName, 'Shown instead of your username. Your username stays the same.'),
      field('Pronouns', pronouns),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'About me', bioCount), bio),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Custom status'), h('div', { class: 'row gap' }, csEmoji, csText))),
    section('Name style',
      h('div', { class: 'grid-2' },
        field('Name color', colorInput(draft.nameColor, set('nameColor'), 'Name color')),
        h('div', { class: 'field' }, toggle('Gradient name', gradOn, (on) => {
          color2Wrap.hidden = !on;
          draft.nameColor2 = on ? (draft.nameColor2 || '#f2a541') : '';
          changed();
        }), color2Wrap)),
      field('Name font', fontSelect),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Name effect'),
        chips([['none', 'None'], ['glow', 'Glow'], ['shimmer', 'Shimmer'], ['rainbow', 'Rainbow']], draft.nameEffect || 'none', set('nameEffect')))),
    section('Avatar',
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Shape'),
        chips([['circle', 'Circle'], ['rounded', 'Rounded'], ['square', 'Square'], ['hexagon', 'Hexagon']], draft.avatarShape || 'circle', set('avatarShape'))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Ring'),
        chips([['none', 'None'], ['solid', 'Solid'], ['gradient', 'Gradient'], ['rainbow', 'Rainbow'], ['glow', 'Glow'], ['pulse', 'Pulse']], draft.avatarRing || 'none', set('avatarRing'))),
      field('Ring color', colorInput(draft.ringColor, set('ringColor'), 'Ring color'), 'Gradient and glow rings blend this with your accent.')),
    section('Card theme',
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Presets'), presetRow),
      colorsHost,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Card style'),
        chips([['solid', 'Solid'], ['gradient', 'Gradient'], ['glass', 'Glass']], draft.cardStyle || 'gradient', set('cardStyle'))),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Profile effect'),
        chips([['none', 'None'], ['sparkles', '✦ Sparkles'], ['snow', '❄ Snow'], ['hearts', '♥ Hearts'], ['stars', '★ Stars'], ['bubbles', '◯ Bubbles'], ['embers', '🔥 Embers'], ['sakura', '✿ Cherry blossoms'], ['confetti', '🎉 Confetti'], ['rain', '🌧 Rain'], ['fireflies', '✨ Fireflies']], draft.profileEffect || 'none', set('profileEffect')))),
    section('Links', h('p', { class: 'field-hint' }, 'Up to 6. Must start with http:// or https://'), linksHost),
  );

  body = h('div', { class: 'set-profile' },
    form,
    h('aside', { class: 'set-preview' }, h('div', { class: 'set-preview-label' }, 'Preview'), previewHost),
    saveBar);
  refreshMedia();
  return body;
}

// ------------------------------------------------------------------ account tab
function accountTab(app) {
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
      let enc;
      try { enc = await E2EE.rewrapPrivateKey(oldK.wrapKey, newK.wrapKey, S.encPrivateKey); } catch { throw new Error('Your current password is not right.'); }
      await api('POST', '/me/password', { oldAuthKey: oldK.authKey, newAuthKey: newK.authKey, encPrivateKey: enc, salt });
      S.encPrivateKey = enc;
      S.me = { ...S.me, kdf: 'argon2id', kdfSalt: salt };
      oldPw.value = ''; newPw.value = ''; confirmPw.value = '';
      toast('Password changed. Other devices were logged out.');
    } catch (e) {
      msg.textContent = e.message;
    } finally { btn.disabled = false; btn.textContent = 'Change password'; }
  } }, 'Change password');

  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Account & security'),
    section('Your account',
      h('div', { class: 'kv' }, h('span', null, 'Username'), h('strong', null, S.me.username)),
      h('div', { class: 'kv' }, h('span', null, 'Member since'), h('strong', null, new Date(S.me.createdAt).toLocaleDateString()))),
    section('Encryption',
      h('p', { class: 'muted-p' }, 'Everything you send \u2014 DMs, server channels and every file \u2014 is end-to-end encrypted on this device before it leaves. The server only stores scrambled data and can\u2019t read it.'),
      h('div', { class: 'kv' }, h('span', null, 'Messages'), h('strong', null, 'AES-256-GCM, new key per message')),
      h('div', { class: 'kv' }, h('span', null, 'Key exchange'), h('strong', null, 'ECDH P-256 + HKDF-SHA256')),
      h('div', { class: 'kv' }, h('span', null, 'Signatures'), h('strong', null, 'ECDSA P-256')),
      h('div', { class: 'kv' }, h('span', null, 'Password hashing'), h('strong', null, S.me.kdf === 'argon2id' ? 'Argon2id, 64 MiB' : 'PBKDF2 (upgrades next login)')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Your key fingerprint'), fp,
        h('span', { class: 'field-hint' }, 'Open a DM and click \u201cEnd-to-end encrypted\u201d to compare safety numbers with a friend.'))),
    section('Change password',
      h('p', { class: 'muted-p warn' }, 'There is no password reset. If you forget it, your encrypted DMs cannot be recovered — not even by the server owner.'),
      field('Current password', oldPw), field('New password', newPw), field('Confirm new password', confirmPw), msg,
      h('div', null, btn)),
    section('Session',
      h('button', { class: 'btn danger', onclick: () => app.logout() }, 'Log out of this device')),
  );
}

// ------------------------------------------------------------------ voice tab
function audioPrefs() { try { return JSON.parse(localStorage.getItem('hearth.audio') || '{}'); } catch { return {}; } }
function setAudioPref(k, v) { const p = audioPrefs(); p[k] = v; localStorage.setItem('hearth.audio', JSON.stringify(p)); }

function voiceTab(app) {
  const prefs = audioPrefs();
  const inputSel = h('select', { class: 'input', onchange: (e) => { setAudioPref('inputId', e.target.value); if (micTest) startTest(); } });
  const outputSel = h('select', { class: 'input', onchange: (e) => setAudioPref('outputId', e.target.value) });
  // Camera: pick a device and preview it.
  const camSel = h('select', { class: 'input', onchange: (e) => { setAudioPref('cameraId', e.target.value); if (camStream) startCam(); } });
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
    section('Input sensitivity',
      toggle('Only send audio when I’m talking', !!prefs.gate, (v) => { setAudioPref('gate', v); sens.hidden = !v; }, 'Cuts background noise between sentences. Applies the next time you join voice.'),
      sens),
    section('Processing',
      toggle('Echo cancellation', prefs.echoCancellation !== false, (v) => setAudioPref('echoCancellation', v), 'Stops others hearing themselves through your speakers.'),
      toggle('Noise suppression', prefs.noiseSuppression !== false, (v) => setAudioPref('noiseSuppression', v), 'Filters out fans, keyboards and background hum.'),
      toggle('Automatic gain control', prefs.autoGainControl !== false, (v) => setAudioPref('autoGainControl', v), 'Keeps your volume steady.')),
    section('Shortcuts',
      h('div', { class: 'kv' }, h('span', null, 'Toggle mute'), h('kbd', null, 'Ctrl / ⌘ + Shift + M')),
      h('div', { class: 'kv' }, h('span', null, 'Toggle deafen'), h('kbd', null, 'Ctrl / ⌘ + Shift + D'))),
  );
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
    section('Push (when Hearth is closed)', pushToggleRow(app)),
    perServerNotifications(app),
  );
}
function perServerNotifications(app) {
  const servers = app.S.servers.filter((s) => s.kind !== 'group');
  if (!servers.length) return null;
  return section('Per server',
    h('p', { class: 'set-sub' }, 'DMs and replies to you always notify unless you mute that conversation. Channels can override these from their right-click menu.'),
    ...servers.map((s) => {
      const sel = h('select', { class: 'input sm', 'aria-label': `Notifications for ${s.name}`, onchange: (e) => {
        const p = app.P.notify;
        if (e.target.value === 'all') delete p['s:' + s.id]; else p['s:' + s.id] = e.target.value;
        app.P.notify = p; app.rerender();
      } }, h('option', { value: 'all' }, 'All messages'), h('option', { value: 'mentions' }, 'Only @mentions'), h('option', { value: 'muted' }, 'Muted'));
      sel.value = app.P.notify['s:' + s.id] || 'all';
      return h('div', { class: 'kv' }, h('span', null, s.name), sel);
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
  );
}

// ------------------------------------------------------------------ sessions tab
function sessionsTab(app) {
  const list = h('div', { class: 'stack' }, h('span', { class: 'spinner' }));
  const describe = (ua) => {
    const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const o = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
    return o ? `${b} on ${o}` : b;
  };
  const load = async () => {
    try {
      const sessions = await api('GET', '/me/sessions');
      clear(list);
      sessions.forEach((x) => list.append(h('div', { class: 'kv session' },
        h('span', { class: 'session-text' }, h('strong', null, describe(x.ua)), h('span', null, x.current ? 'This device' : `Last active ${new Date(x.lastSeen).toLocaleString()}`)),
        x.current ? h('span', { class: 'role-tag role-admin' }, 'Current') : h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
          try { await api('DELETE', `/me/sessions/${x.id}`); toast('Signed out of that device.'); load(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Sign out'))));
    } catch (e) { clear(list).append(h('p', { class: 'form-error' }, e.message)); }
  };
  load();
  return h('div', { class: 'set-form narrow' },
    h('h2', { class: 'set-title' }, 'Sessions'),
    h('p', { class: 'muted-p' }, 'Devices signed in to your account. Signing a device out also removes your encryption keys from it.'),
    section(null, list));
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
  );
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
function appsTab(app) {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const cfg = app.S.config || {};
  const installBox = h('div', { class: 'stack' });
  const drawInstall = () => {
    clear(installBox);
    if (window.hearthDesktop) { installBox.append(h('p', { class: 'muted-p' }, `You\u2019re using the Hearth desktop app (version ${window.hearthDesktop.version}).`)); return; }
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
    section('Desktop app',
      h('p', { class: 'muted-p' }, 'A Windows, Mac and Linux app with a tray icon, unread badge and launch-at-login.'),
      dl.length || cfg.desktopUrl
        ? h('div', null, h('a', { class: 'btn ghost', href: '/download', target: '_blank', rel: 'noopener' }, icon('download'), 'Download page'))
        : h('p', { class: 'field-hint' }, 'The server owner hasn\u2019t published desktop installers yet.')),
    section('Notifications', pushToggleRow(app),
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
        h('p', { class: 'muted-p' }, st.klipyKeySet || st.giphyKeySet ? `GIF search is on, using ${st.gifProvider === 'giphy' ? 'GIPHY' : 'KLIPY'}. Popular results are cached and shared, so they don\u2019t use up your limit.` : 'GIF search is off until you add a free key.'),
        h('div', { class: 'chips' }, [['klipy', 'KLIPY (recommended, free)'], ['giphy', 'GIPHY']].map(([k, l]) => h('button', {
          class: `chip${st.gifProvider === k ? ' active' : ''}`, onclick: async () => { await api('PATCH', '/admin/settings', { gifProvider: k }); toast('Saved.'); draw(); },
        }, l))),
        st.gifProvider === 'giphy' ? h('p', { class: 'field-hint' }, 'GIPHY\u2019s free beta keys allow about 100 searches an hour for the whole server. KLIPY offers free production keys with no limit.') : h('ol', { class: 'steps' },
          h('li', null, 'Sign up at ', h('a', { href: 'https://partner.klipy.com/api-keys', target: '_blank', rel: 'noopener' }, 'partner.klipy.com'), ' (free) and create an API key ("Add platform").'),
          h('li', null, 'Paste it below, click Test, then Save.'),
          h('li', null, 'Test keys allow 100 searches an hour. In the KLIPY panel, ', h('strong', null, 'request production access'), ' \u2014 it\u2019s free and removes the limit.')),
        h('div', { class: 'row gap' }, keyIn, h('button', { class: 'btn ghost', onclick: test }, 'Test')),
        result,
        h('div', { class: 'row gap' },
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
          h('button', { class: 'btn primary', onclick: async () => { await api('PUT', '/admin/turn', { urls: turnUrlsIn.value, ...(turnSecretIn.value.trim() ? { secret: turnSecretIn.value.trim() } : {}) }); toast('Saved.'); draw(); } }, 'Save'),
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
        h('span', { class: 'field-hint' }, has ? 'Plays when someone presses play on your profile (never automatically).' : 'MP3, M4A, OGG or WAV up to 10 MB.')),
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
  return section('Profile page',
    h('p', { class: 'set-sub' }, 'Extra things people see when they open your full profile.'),
    songHost,
    field('More about me', about, 'Shown on your full profile. Markdown works: # headings, - lists, **bold**.'),
    field('Interests', interests, 'Up to 12, separated by commas.'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, `Top friends (${picked.size}/8)`), tf));
}
