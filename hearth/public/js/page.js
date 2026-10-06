// MySpace-style profile pages: rendering, safe custom CSS, and the editor (Settings → Profile page).
import { h, clear, icon, toast, fmtStamp, fmtDay } from './util.js';
import { api, upload } from './api.js';
import { avatarEl, nameEl, displayName, effectLayer, splitGlyphs, FONT_STACKS, cropStyle, songPlayer } from './profile-ui.js';
import { confirmDialog } from './ui.js';
import { renderDoc, render as md } from './markdown.js';

export const PAGE_FONTS = {
  default: 'inherit',
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
  comic: "'Comic Sans MS', 'Comic Neue', 'Chalkboard SE', cursive",
  ...Object.fromEntries(Object.entries(FONT_STACKS).filter(([k]) => k !== 'default')),
};
export const PATTERNS = ['stars', 'dots', 'checker', 'stripes', 'hearts', 'grid', 'zigzag', 'plaid'];
const INTEREST_ROWS = [['general', 'General'], ['music', 'Music'], ['movies', 'Movies'], ['tv', 'Television'], ['books', 'Books'], ['games', 'Games'], ['heroes', 'Heroes']];

const rgb = (hex) => { const n = parseInt(String(hex || '#000000').slice(1), 16); return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`; };

function patternCss(name, c, base) {
  const a = (x) => `rgb(${rgb(c)} / ${x})`;
  switch (name) {
    case 'dots': return `radial-gradient(${a(0.35)} 2px, transparent 2.5px) 0 0 / 22px 22px, ${base}`;
    case 'checker': return `conic-gradient(${a(0.12)} 25%, transparent 0 50%, ${a(0.12)} 0 75%, transparent 0) 0 0 / 48px 48px, ${base}`;
    case 'stripes': return `repeating-linear-gradient(45deg, ${a(0.12)} 0 12px, transparent 12px 24px), ${base}`;
    case 'hearts': return `radial-gradient(circle at 35% 40%, ${a(0.3)} 4px, transparent 4.5px) 0 0 / 34px 34px, radial-gradient(circle at 65% 40%, ${a(0.3)} 4px, transparent 4.5px) 0 0 / 34px 34px, conic-gradient(from 135deg at 50% 62%, ${a(0.3)} 0 90deg, transparent 0) 0 0 / 34px 34px, ${base}`;
    case 'grid': return `linear-gradient(${a(0.12)} 1px, transparent 1px) 0 0 / 28px 28px, linear-gradient(90deg, ${a(0.12)} 1px, transparent 1px) 0 0 / 28px 28px, ${base}`;
    case 'zigzag': return `linear-gradient(135deg, ${a(0.14)} 25%, transparent 25%) -14px 0 / 28px 28px, linear-gradient(225deg, ${a(0.14)} 25%, transparent 25%) -14px 0 / 28px 28px, linear-gradient(315deg, ${a(0.14)} 25%, transparent 25%) 0 0 / 28px 28px, linear-gradient(45deg, ${a(0.14)} 25%, transparent 25%) 0 0 / 28px 28px, ${base}`;
    case 'plaid': return `repeating-linear-gradient(0deg, ${a(0.1)} 0 8px, transparent 8px 32px), repeating-linear-gradient(90deg, ${a(0.1)} 0 8px, transparent 8px 32px), ${base}`;
    default: return `radial-gradient(${a(0.9)} 1px, transparent 1.5px) 0 0 / 46px 46px, radial-gradient(${a(0.55)} 1px, transparent 1.5px) 23px 19px / 46px 46px, radial-gradient(${a(0.35)} 0.8px, transparent 1.2px) 11px 31px / 31px 31px, ${base}`;
  }
}
function backgroundOf(p, pageBg) {
  const b = p.bg || {};
  if (b.kind === 'image' && pageBg && /^\/uploads\/[a-z0-9]+\.[a-z0-9]+$/i.test(pageBg)) {
    const how = b.repeat === 'cover' ? 'center / cover no-repeat' : b.repeat === 'center' ? 'center no-repeat' : '0 0 repeat';
    return `url("${pageBg}") ${how}, ${b.color}`;
  }
  if (b.kind === 'color') return b.color;
  if (b.kind === 'pattern') return patternCss(b.pattern, b.patternColor, b.color);
  return `linear-gradient(${b.angle}deg, ${b.color}, ${b.color2})`;
}
// The page's look as CSS variables, which the stylesheet (and people's own CSS) can use.
function pageStyle(p, pageBg) {
  const shadow = { none: 'none', soft: '0 8px 24px rgb(0 0 0 / .35)', hard: `5px 5px 0 ${p.borderColor}`, glow: `0 0 16px ${p.borderColor}` }[p.shadow] || 'none';
  return {
    '--pg-bg': backgroundOf(p, pageBg),
    '--pg-attach': p.bg && p.bg.fixed ? 'fixed' : 'scroll',
    '--pg-text': p.text, '--pg-link': p.link, '--pg-heading': p.heading,
    '--pg-box': `rgb(${rgb(p.boxBg)} / ${p.boxAlpha / 100})`,
    '--pg-head-bg': p.headerBg, '--pg-head-text': p.headerText,
    '--pg-border': p.border === 'none' || !p.borderWidth ? 'none' : `${p.borderWidth}px ${p.border} ${p.borderColor}`,
    '--pg-radius': `${p.radius}px`, '--pg-shadow': shadow,
    '--pg-font': PAGE_FONTS[p.font] || 'inherit', '--pg-size': `${p.fontSize}px`,
  };
}

// People's own CSS, made safe: the browser parses it, every rule is limited to this one page, and
// anything that would load from elsewhere (url(), @import…) is dropped. The page also contains its
// own painting, so nothing can cover the rest of the app.
export function scopeCss(css, scope) {
  if (!css || !css.trim() || typeof CSSStyleSheet !== 'function') return '';
  let sheet;
  try { sheet = new CSSStyleSheet(); sheet.replaceSync(css); } catch { return ''; }
  const bad = /url\s*\(|blocked|image-set|expression|javascript:|@import|src\s*\(/i;
  const root = /^(html|body|:root|\.mys-page)(?![\w-])/;
  const sel = (t) => t.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => (root.test(x) ? x.replace(root, scope) : `${scope} ${x}`)).join(', ');
  const walk = (rules) => [...rules].map((r) => {
    if (r instanceof CSSStyleRule) return bad.test(r.style.cssText) || !r.style.cssText ? '' : `${sel(r.selectorText)} { ${r.style.cssText} }`;
    if (r instanceof CSSMediaRule) return `@media ${r.conditionText || r.media.mediaText} { ${walk(r.cssRules)} }`;
    if (typeof CSSKeyframesRule !== 'undefined' && r instanceof CSSKeyframesRule) return bad.test(r.cssText) ? '' : r.cssText;
    return '';
  }).filter(Boolean).join('\n');
  return walk(sheet.cssRules);
}

function box(title, cls, ...kids) {
  return h('section', { class: `mys-box ${cls}` }, title ? h('h3', { class: 'mys-box-h' }, title) : null, h('div', { class: 'mys-box-b' }, kids));
}

// Cursor trail: little copies of the person's characters follow the mouse around their page.
function cursorTrail(el, glyphs) {
  const list = splitGlyphs(glyphs);
  if (!list.length || document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let last = 0; let i = 0;
  el.addEventListener('pointermove', (e) => {
    const t = performance.now();
    if (t - last < 45 || el.querySelectorAll('.mys-trail').length > 24) return;
    last = t;
    const r = el.getBoundingClientRect();
    const s = h('span', { class: 'mys-trail', 'aria-hidden': 'true', style: { left: `${e.clientX - r.left + el.scrollLeft}px`, top: `${e.clientY - r.top + el.scrollTop}px` } }, list[i++ % list.length]);
    el.append(s);
    setTimeout(() => s.remove(), 900);
  });
}

// d: what GET /users/:id/page returns. u: the user. opts: { me, actions, openUser, onEdit, preview, isStaff, onChanged }
export function renderPage(d, u, opts = {}) {
  const p = d.page;
  const prof = u.profile || {};
  const me = opts.me || {};
  const self = me.id === u.id;
  const name = displayName(u);
  const page = h('div', { class: `mys-page lay-${p.layout}${opts.preview ? ' preview' : ''}`, dataset: { page: u.id }, style: pageStyle(p, d.pageBg) });

  // ---- left column
  const title = nameEl(u, { tag: 'h1', cls: `mys-name${p.glitterTitle ? ' glitter' : ''}` });
  const online = u.presence && u.presence !== 'offline';
  const identity = box(null, 'mys-id',
    title,
    h('div', { class: 'mys-id-row' },
      h('div', { class: 'mys-photo' }, avatarEl(u, 150)),
      h('div', { class: 'mys-id-text' },
        prof.headline ? h('p', { class: 'mys-headline' }, `"${prof.headline}"`) : null,
        prof.pronouns ? h('p', null, prof.pronouns) : null,
        prof.mood && (prof.mood.text || prof.mood.emoji) ? h('p', { class: 'mys-mood' }, h('b', null, 'Mood: '), `${prof.mood.text || ''} ${prof.mood.emoji || ''}`.trim()) : null,
        prof.customStatus && prof.customStatus.text ? h('p', null, `${prof.customStatus.emoji || ''} ${prof.customStatus.text}`.trim()) : null,
        h('p', { class: `mys-online${online ? ' on' : ''}` }, online ? '● Online now!' : d.lastSeen ? `Last seen ${fmtDay(d.lastSeen)}` : 'Offline'),
        h('p', { class: 'mys-since' }, `Member since ${fmtDay(u.createdAt)}`),
        u.supporter ? h('p', null, h('span', { class: 'supporter-tag' }, '\uD83D\uDC9C Supporter')) : null,
        p.showViews ? h('p', { class: 'mys-views' }, h('b', null, 'Profile views: '), h('span', { class: 'mys-counter' }, String(d.views).padStart(6, '0'))) : null)));
  const left = [identity];
  if (!self && opts.actions) left.push(box(`Contacting ${name}`, 'mys-contact', h('div', { class: 'mys-contact-grid' }, opts.actions)));
  if (self && !opts.preview && opts.onEdit) left.push(box('Your page', 'mys-contact', h('div', { class: 'mys-contact-grid' }, h('button', { class: 'btn primary sm', onclick: opts.onEdit }, icon('edit'), 'Edit my page'))));
  if (u.song) left.push(box('Now playing', 'mys-song', songPlayer(u, prof)));
  if ((prof.links || []).length) left.push(box(`${name}'s links`, 'mys-links', h('ul', null, prof.links.map((l) => h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, l.label || l.url))))));
  const rows = INTEREST_ROWS.filter(([k]) => p.interests[k]);
  if (rows.length || (prof.interests || []).length) {
    left.push(box(`${name}'s Interests`, 'mys-interests',
      (prof.interests || []).length ? h('div', { class: 'pc-tags' }, prof.interests.map((t) => h('span', { class: 'pc-tag' }, t))) : null,
      rows.length ? h('table', null, rows.map(([k, label]) => h('tr', null, h('th', null, label), h('td', null, p.interests[k])))) : null));
  }
  if (p.details.length) left.push(box(`${name}'s Details`, 'mys-details', h('table', null, p.details.map((x) => h('tr', null, h('th', null, x.label), h('td', null, x.value))))));

  // ---- right column
  const right = [];
  right.push(box(null, 'mys-network', h('p', null, self ? 'This is your page. Everyone who opens your profile sees it like this.'
    : d.isFriend ? h('span', null, h('b', null, name), ' is your friend.') : h('span', null, h('b', null, name), ' is in your extended network.'))));
  const about = prof.aboutMe || prof.bio;
  if (about || p.meet) {
    right.push(box(`${name}'s Blurbs`, 'mys-blurbs',
      about ? h('div', null, h('h4', null, 'About me:'), h('div', { class: 'md', html: renderDoc(about) })) : null,
      p.meet ? h('div', null, h('h4', null, 'Who I’d like to meet:'), h('div', { class: 'md', html: renderDoc(p.meet) })) : null));
  }
  right.push(box(`${name}'s Friend Space`, 'mys-friends',
    h('p', null, h('b', null, name), ` has ${d.friendCount} friend${d.friendCount === 1 ? '' : 's'}.`),
    d.topFriends.length ? h('div', { class: 'mys-friend-grid' }, d.topFriends.map((f) => h('button', { class: 'mys-friend', onclick: () => opts.openUser && opts.openUser(f.id) }, avatarEl(f, 72), h('span', null, displayName(f)))))
      : h('p', { class: 'mys-muted' }, self ? 'Pick your top 8 under Settings → Profile.' : 'No top friends picked yet.')));

  // comments ("Friends' comments")
  const list = h('div', { class: 'mys-comment-list' });
  let comments = d.comments.slice();
  const drawComments = () => {
    clear(list);
    if (!comments.length) list.append(h('p', { class: 'mys-muted' }, 'No comments yet. Be the first!'));
    comments.forEach((c) => {
      const canDelete = !opts.preview && c.author && (c.author.id === me.id || self || opts.isStaff);
      list.append(h('div', { class: 'mys-comment' },
        h('button', { class: 'mys-comment-who', onclick: () => c.author && opts.openUser && opts.openUser(c.author.id) }, c.author ? avatarEl(c.author, 56) : null, h('span', null, c.author ? displayName(c.author) : 'Deleted user')),
        h('div', { class: 'mys-comment-body' },
          h('div', { class: 'mys-comment-meta' }, fmtStamp(c.createdAt),
            canDelete ? h('button', { class: 'mys-del', onclick: async () => {
              if (!(await confirmDialog({ title: 'Delete this comment?', confirm: 'Delete', danger: true }))) return;
              try { await api('DELETE', `/profile-comments/${c.id}`); comments = comments.filter((x) => x.id !== c.id); drawComments(); } catch (e) { toast(e.message, 'error'); }
            } }, 'Delete') : null),
          h('div', { class: 'mys-comment-text', html: md(c.text, { everyone: false }) }))));
    });
  };
  drawComments();
  const form = d.canComment && !opts.preview ? (() => {
    const ta = h('textarea', { class: 'input', rows: '3', maxlength: '1000', placeholder: self ? 'Write on your own wall…' : `Leave ${name} a comment…` });
    return h('div', { class: 'mys-comment-form' }, ta, h('button', { class: 'btn primary sm', onclick: async (e) => {
      if (!ta.value.trim()) return;
      e.currentTarget.disabled = true;
      try { const c = await api('POST', `/users/${u.id}/comments`, { text: ta.value }); comments.unshift(c); ta.value = ''; drawComments(); } catch (x) { toast(x.message, 'error'); }
      e.currentTarget.disabled = false;
    } }, 'Add comment'));
  })() : h('p', { class: 'mys-muted' }, p.comments === 'off' ? `${name} has turned comments off.` : p.comments === 'friends' ? `Only ${name}'s friends can comment.` : '');
  right.push(box(`${name}'s Friends' Comments`, 'mys-comments', h('p', { class: 'mys-muted' }, `Displaying ${comments.length} of ${d.commentCount} comments`), form, list));

  const head = prof.headline && p.marquee ? h('div', { class: 'mys-marquee', 'aria-label': prof.headline }, h('span', null, prof.headline), h('span', { 'aria-hidden': 'true' }, prof.headline)) : null;
  const wrap = h('div', { class: 'mys-wrap' }, head, h('div', { class: 'mys-grid' }, h('div', { class: 'mys-left' }, left), h('div', { class: 'mys-right' }, right)));
  page.append(wrap);
  // The effect sits over the scrolling page (outside it, so it stays put while scrolling).
  const shell = h('div', { class: 'mys-shell' }, page);
  const fx = effectLayer(prof.profileEffect, prof.customFx);
  if (fx) { fx.classList.add('mys-fx'); shell.append(fx); }
  const scoped = scopeCss(p.css, `.mys-page[data-page="${CSS.escape(u.id)}"]`);
  if (scoped) page.append(h('style', null, scoped));
  if (p.cursorTrail) cursorTrail(page, p.cursorTrail);
  if (p.autoplay && u.song && !opts.preview) setTimeout(() => { const b = page.querySelector('.pc-song'); if (b && !b.classList.contains('playing')) b.click(); }, 300);
  return shell;
}

// ------------------------------------------------------------------ editor (Settings → Profile page)
function swatch(value, onChange, label) {
  const sw = h('input', { type: 'color', class: 'color-in', value, 'aria-label': label });
  sw.addEventListener('input', () => onChange(sw.value));
  return h('label', { class: 'pg-color' }, sw, h('span', null, label));
}
function rangeRow(label, min, max, value, unit, onInput) {
  const out = h('span', { class: 'counter' }, `${value}${unit}`);
  return h('label', { class: 'slider-row' }, h('span', null, label),
    h('input', { type: 'range', class: 'range', min: String(min), max: String(max), value: String(value), oninput: (e) => { out.textContent = `${e.target.value}${unit}`; onInput(+e.target.value); } }), out);
}
function chipRow(options, value, onChange) {
  const wrap = h('div', { class: 'chips' });
  const draw = (cur) => clear(wrap).append(...options.map(([v, l]) => h('button', { type: 'button', class: `chip${v === cur ? ' active' : ''}`, onclick: () => { draw(v); onChange(v); } }, l)));
  draw(value);
  return wrap;
}
function tog(label, on, onChange, hint) {
  return h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, label), hint ? h('span', { class: 'field-hint' }, hint) : null),
    h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => onChange(e.target.checked) }), h('span', { class: 'switch-track' })));
}
const sec = (title, ...kids) => h('section', { class: 'set-section' }, h('h3', { class: 'set-h' }, title), kids);
const fld = (label, el, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el, hint ? h('span', { class: 'field-hint' }, hint) : null);

export const PAGE_THEMES = [
  { name: 'Classic ’06', page: { bg: { kind: 'color', color: '#e5e5e5' }, text: '#000000', link: '#003399', heading: '#ff6600', boxBg: '#ffffff', boxAlpha: 100, headerBg: '#6699cc', headerText: '#ffffff', border: 'solid', borderWidth: 1, borderColor: '#6699cc', radius: 0, shadow: 'none', font: 'system' } },
  { name: 'Emo night', page: { bg: { kind: 'pattern', pattern: 'checker', color: '#0a0a0a', patternColor: '#ff2a6d' }, text: '#e6e6e6', link: '#ff2a6d', heading: '#ff2a6d', boxBg: '#111111', boxAlpha: 92, headerBg: '#1a1a1a', headerText: '#ff2a6d', border: 'dashed', borderWidth: 2, borderColor: '#ff2a6d', radius: 0, shadow: 'hard', font: 'mono' } },
  { name: 'Glitter girl', page: { bg: { kind: 'pattern', pattern: 'hearts', color: '#ff9ccf', patternColor: '#ffffff' }, text: '#5a1840', link: '#c2185b', heading: '#e91e63', boxBg: '#fff0f7', boxAlpha: 90, headerBg: '#ff4fa3', headerText: '#ffffff', border: 'dotted', borderWidth: 3, borderColor: '#ff4fa3', radius: 18, shadow: 'glow', font: 'Comfortaa', glitterTitle: true } },
  { name: 'Space', page: { bg: { kind: 'pattern', pattern: 'stars', color: '#05051a', patternColor: '#ffffff' }, text: '#dfe6ff', link: '#7fb8ff', heading: '#9be7ff', boxBg: '#0b1033', boxAlpha: 80, headerBg: '#2b2f7a', headerText: '#ffffff', border: 'solid', borderWidth: 1, borderColor: '#5a63ff', radius: 10, shadow: 'glow', font: 'Orbitron' } },
  { name: 'Skater', page: { bg: { kind: 'pattern', pattern: 'zigzag', color: '#1e2a1e', patternColor: '#c4e05a' }, text: '#f0f0e0', link: '#c4e05a', heading: '#ffcc00', boxBg: '#111a11', boxAlpha: 90, headerBg: '#c4e05a', headerText: '#111111', border: 'groove', borderWidth: 4, borderColor: '#c4e05a', radius: 4, shadow: 'hard', font: 'Bungee' } },
  { name: 'Vaporwave', page: { bg: { kind: 'gradient', color: '#ff71ce', color2: '#01cdfe', angle: 160 }, text: '#2b1055', link: '#7d00ff', heading: '#b967ff', boxBg: '#fffbff', boxAlpha: 75, headerBg: '#b967ff', headerText: '#ffffff', border: 'solid', borderWidth: 2, borderColor: '#05ffa1', radius: 14, shadow: 'soft', font: 'Press Start 2P', fontSize: 13 } },
];

const CSS_HELP = ['.mys-page', '.mys-box', '.mys-box-h', '.mys-box-b', '.mys-name', '.mys-photo', '.mys-headline', '.mys-mood', '.mys-contact', '.mys-song', '.mys-links', '.mys-interests', '.mys-details', '.mys-network', '.mys-blurbs', '.mys-friends', '.mys-friend', '.mys-comments', '.mys-comment', '.mys-counter', '.mys-marquee'];
const CSS_EXAMPLE = `/* Make every box tilt a tiny bit and wobble when you hover */
.mys-box { transform: rotate(-0.6deg); transition: transform .2s; }
.mys-box:hover { transform: rotate(0.6deg) scale(1.01); }

/* Rainbow box headers */
.mys-box-h { background: linear-gradient(90deg, #ff5f6d, #ffc371, #3fcf83, #38c6d9, #b07cff); }

/* Hide the view counter */
.mys-views { display: none; }`;

export function pageEditorTab(app, setDirty) {
  const S = app.S;
  const root = h('div', { class: 'set-profile pg-editor' });
  root.append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
  api('GET', `/users/${S.me.id}/page`).then((data) => build(data)).catch((e) => clear(root).append(h('p', { class: 'form-error' }, e.message)));

  // data.page is what's saved; `start` is an unsaved starting point (after picking a theme).
  function build(data, start = null) {
    const original = JSON.stringify(data.page);
    const draft = JSON.parse(start ? JSON.stringify(start) : original);
    const profOriginal = JSON.stringify({ headline: S.me.profile.headline || '', mood: S.me.profile.mood || { emoji: '', text: '' } });
    const prof = JSON.parse(profOriginal);
    let pageBg = S.me.pageBg || data.pageBg;
    const preview = h('div', { class: 'pg-preview' });
    const saveBar = h('div', { class: 'save-bar', hidden: true },
      h('span', null, 'You have unsaved changes to your page.'),
      h('button', { class: 'btn ghost sm', onclick: () => { clear(root); setDirty(false); build(data); } }, 'Reset'),
      h('button', { class: 'btn primary sm', onclick: () => save() }, 'Save page'));
    let t = 0;
    const redraw = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const me = { ...S.me, pageBg, profile: { ...S.me.profile, ...prof } };
        clear(preview).append(renderPage({ ...data, page: draft, pageBg }, me, { me: S.me, preview: true }));
      }, 120);
    };
    const changed = () => {
      const d = JSON.stringify(draft) !== original || JSON.stringify(prof) !== profOriginal;
      saveBar.hidden = !d; setDirty(d); redraw();
    };
    const set = (k, v) => { draft[k] = v; changed(); };
    const setBg = (k, v) => { draft.bg = { ...draft.bg, [k]: v }; changed(); };
    const save = async () => {
      try {
        const r = await api('PUT', '/me/page', draft);
        if (JSON.stringify(prof) !== profOriginal) app.onMe(await api('PATCH', '/me/profile', prof));
        data.page = r.page;
        setDirty(false);
        toast('Page saved.');
        clear(root); build(data);
      } catch (e) { toast(e.message, 'error'); }
    };

    // background image (uploaded right away)
    const bgFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: async () => {
      const f = bgFile.files[0]; bgFile.value = '';
      if (!f) return;
      const max = (S.config.imageMb || 12) * 1024 * 1024;
      if (f.size > max) return toast(`Images can be up to ${S.config.imageMb || 12} MB.`, 'error');
      const fd = new FormData(); fd.append('file', f, f.name); fd.append('crop', '{}');
      try { const u = await upload('/me/media/pagebg', fd); app.onMe(u); pageBg = u.pageBg; setBg('kind', 'image'); drawBgExtra(); toast('Background uploaded.'); } catch (e) { toast(e.message, 'error'); }
    } });
    const bgExtra = h('div', { class: 'stack' });
    const drawBgExtra = () => {
      const b = draft.bg;
      clear(bgExtra);
      if (b.kind === 'gradient') bgExtra.append(h('div', { class: 'pg-colors' }, swatch(b.color, (v) => setBg('color', v), 'From'), swatch(b.color2, (v) => setBg('color2', v), 'To')), rangeRow('Angle', 0, 360, b.angle, '°', (v) => setBg('angle', v)));
      if (b.kind === 'color') bgExtra.append(h('div', { class: 'pg-colors' }, swatch(b.color, (v) => setBg('color', v), 'Color')));
      if (b.kind === 'pattern') bgExtra.append(chipRow(PATTERNS.map((x) => [x, x[0].toUpperCase() + x.slice(1)]), b.pattern, (v) => setBg('pattern', v)), h('div', { class: 'pg-colors' }, swatch(b.color, (v) => setBg('color', v), 'Background'), swatch(b.patternColor, (v) => setBg('patternColor', v), 'Pattern')));
      if (b.kind === 'image') {
        bgExtra.append(h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn primary sm', onclick: () => bgFile.click() }, pageBg ? 'Change image' : 'Upload image'),
          pageBg ? h('button', { class: 'btn ghost sm', onclick: async () => { app.onMe(await api('DELETE', '/me/media/pagebg')); pageBg = null; setBg('kind', 'gradient'); drawBgExtra(); } }, 'Remove image') : null),
        chipRow([['tile', 'Tile it'], ['cover', 'Fill the page'], ['center', 'Center once']], b.repeat, (v) => setBg('repeat', v)),
        h('div', { class: 'pg-colors' }, swatch(b.color, (v) => setBg('color', v), 'Color behind it')));
      }
      bgExtra.append(tog('Background stays still while scrolling', b.fixed, (v) => setBg('fixed', v)));
    };
    drawBgExtra();

    const themeRow = h('div', { class: 'presets' }, PAGE_THEMES.map((th) => h('button', {
      type: 'button', class: 'preset', title: th.name,
      style: { '--p1': th.page.headerBg, '--p2': th.page.boxBg, '--p3': th.page.bg.color },
      onclick: () => { clear(root); build(data, { ...draft, glitterTitle: false, fontSize: 15, ...th.page, bg: { ...draft.bg, ...th.page.bg } }); },
    }, h('span', { class: 'preset-sw' }), h('span', { class: 'preset-name' }, th.name))));

    const detailsHost = h('div', { class: 'links-edit' });
    const drawDetails = () => {
      clear(detailsHost);
      draft.details.forEach((x, i) => detailsHost.append(h('div', { class: 'link-edit-row' },
        h('input', { class: 'input', maxlength: '24', placeholder: 'Label (e.g. Location)', value: x.label, oninput: (e) => { draft.details[i] = { ...draft.details[i], label: e.target.value }; changed(); } }),
        h('input', { class: 'input', maxlength: '80', placeholder: 'Value', value: x.value, oninput: (e) => { draft.details[i] = { ...draft.details[i], value: e.target.value }; changed(); } }),
        h('button', { class: 'icon-btn sm', 'aria-label': 'Remove', onclick: () => { draft.details.splice(i, 1); drawDetails(); changed(); } }, icon('close')))));
      if (draft.details.length < 10) detailsHost.append(h('button', { class: 'btn ghost sm', onclick: () => { draft.details.push({ label: '', value: '' }); drawDetails(); } }, '+ Add a detail'));
    };
    drawDetails();

    const meet = h('textarea', { class: 'input', rows: '4', maxlength: '2000', placeholder: 'People who like the same bands as me…', oninput: (e) => set('meet', e.target.value) });
    meet.value = draft.meet;
    const css = h('textarea', { class: 'input mono pg-css', rows: '12', maxlength: '10000', spellcheck: 'false', placeholder: '.mys-box-h { background: hotpink; }', oninput: (e) => set('css', e.target.value) });
    css.value = draft.css;
    const fontSel = h('select', { class: 'input', onchange: (e) => set('font', e.target.value) }, Object.keys(PAGE_FONTS).map((f) => h('option', { value: f, style: { fontFamily: PAGE_FONTS[f] } }, f === 'default' ? 'Default' : f[0].toUpperCase() + f.slice(1))));
    fontSel.value = draft.font;

    const form = h('div', { class: 'set-form' },
      h('h2', { class: 'set-title' }, 'Profile page'),
      h('p', { class: 'muted-p' }, 'Your own MySpace-style page. People open it from your name or avatar → View profile. Changes show live on the right.'),
      data.locked ? h('p', { class: 'key-bar bad' }, icon('lock'), 'An admin has locked your profile, so changes can’t be saved right now.') : null,
      sec('Start from a theme', themeRow),
      sec('Top of the page',
        fld('Headline', h('input', { class: 'input', maxlength: '80', value: prof.headline, placeholder: 'living life one song at a time', oninput: (e) => { prof.headline = e.target.value; changed(); } })),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Mood'), h('div', { class: 'row gap' },
          h('input', { class: 'input emoji-input', maxlength: '16', value: prof.mood.emoji, placeholder: '😎', 'aria-label': 'Mood emoji', oninput: (e) => { prof.mood = { ...prof.mood, emoji: e.target.value }; changed(); } }),
          h('input', { class: 'input', maxlength: '40', value: prof.mood.text, placeholder: 'chillin', 'aria-label': 'Mood', oninput: (e) => { prof.mood = { ...prof.mood, text: e.target.value }; changed(); } }))),
        tog('Scroll the headline across the top', draft.marquee, (v) => set('marquee', v), 'Like a <marquee>, but nicer.'),
        tog('Glitter name', draft.glitterTitle, (v) => set('glitterTitle', v), 'Your name sparkles at the top of your page.')),
      sec('Layout', chipRow([['classic', 'Classic'], ['mirrored', 'Mirrored'], ['wide', 'Two equal columns'], ['single', 'One column']], draft.layout, (v) => set('layout', v))),
      sec('Background',
        chipRow([['gradient', 'Gradient'], ['color', 'Color'], ['pattern', 'Pattern'], ['image', 'Image']], draft.bg.kind, (v) => { setBg('kind', v); drawBgExtra(); }),
        bgExtra, bgFile),
      sec('Boxes',
        h('div', { class: 'pg-colors' }, swatch(draft.boxBg, (v) => set('boxBg', v), 'Box'), swatch(draft.headerBg, (v) => set('headerBg', v), 'Box titles'), swatch(draft.headerText, (v) => set('headerText', v), 'Title text'), swatch(draft.borderColor, (v) => set('borderColor', v), 'Border')),
        rangeRow('Box opacity', 0, 100, draft.boxAlpha, '%', (v) => set('boxAlpha', v)),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Border'), chipRow([['none', 'None'], ['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['double', 'Double'], ['groove', 'Groove'], ['ridge', 'Ridge'], ['inset', 'Inset'], ['outset', 'Outset']], draft.border, (v) => set('border', v))),
        rangeRow('Border width', 0, 8, draft.borderWidth, 'px', (v) => set('borderWidth', v)),
        rangeRow('Rounded corners', 0, 30, draft.radius, 'px', (v) => set('radius', v)),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Shadow'), chipRow([['none', 'None'], ['soft', 'Soft'], ['hard', 'Retro'], ['glow', 'Glow']], draft.shadow, (v) => set('shadow', v)))),
      sec('Text',
        h('div', { class: 'pg-colors' }, swatch(draft.text, (v) => set('text', v), 'Text'), swatch(draft.heading, (v) => set('heading', v), 'Headings'), swatch(draft.link, (v) => set('link', v), 'Links')),
        fld('Font', fontSel), rangeRow('Text size', 12, 20, draft.fontSize, 'px', (v) => set('fontSize', v))),
      sec('Fun stuff',
        fld('Cursor trail', h('input', { class: 'input', maxlength: '40', value: draft.cursorTrail, placeholder: '✨💖⭐ (leave empty for none)', oninput: (e) => set('cursorTrail', e.target.value) }), 'Up to 6 characters or emoji follow the mouse on your page.'),
        tog('Show profile views', draft.showViews, (v) => set('showViews', v)),
        tog('Play my song when someone opens my page', draft.autoplay, (v) => set('autoplay', v), 'Browsers sometimes block this; then it waits for them to press play.'),
        h('p', { class: 'field-hint' }, 'Your profile effect (Settings → Profile) also falls across your whole page — including your own custom effect.')),
      sec('Blurbs and details',
        fld('Who I’d like to meet', meet, 'Markdown works. "About me" comes from Settings → Profile.'),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Details'), detailsHost, h('span', { class: 'field-hint' }, 'Things like Location, Hometown, Zodiac, Fave snack. Up to 10.'))),
      sec('Interests table', ...INTEREST_ROWS.map(([k, label]) => fld(label, h('input', { class: 'input', maxlength: '300', value: draft.interests[k] || '', oninput: (e) => { draft.interests = { ...draft.interests, [k]: e.target.value }; changed(); } })))),
      sec('Comments on your page', chipRow([['everyone', 'Anyone'], ['friends', 'Friends only'], ['off', 'Nobody']], draft.comments, (v) => set('comments', v))),
      sec('Custom CSS',
        h('p', { class: 'field-hint' }, 'For full control, like the old days. It only affects your page. Links to outside images and fonts are removed for everyone’s privacy — upload a background image above instead.'),
        css,
        h('div', { class: 'row gap wrap' }, h('button', { class: 'btn ghost sm', onclick: () => { css.value = (css.value ? css.value + '\n\n' : '') + CSS_EXAMPLE; set('css', css.value); } }, 'Insert an example'), h('span', { class: 'field-hint' }, 'You can also use the variables --pg-text, --pg-link, --pg-box, --pg-head-bg and friends.')),
        h('details', { class: 'pg-help' }, h('summary', null, 'Class names you can style'), h('div', { class: 'pc-tags' }, CSS_HELP.map((c) => h('code', { class: 'pc-tag' }, c))))),
    );
    clear(root).append(form, h('aside', { class: 'set-preview pg-preview-wrap' }, h('div', { class: 'set-preview-label' }, 'Preview'), preview), saveBar);
    if (start) changed(); else redraw();
  }
  return root;
}
