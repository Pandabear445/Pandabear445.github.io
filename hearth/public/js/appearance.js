// Themes, app backgrounds and other per-device look settings.
// Everything here is stored in this browser only (localStorage + IndexedDB for images).

export const THEMES = [
  { id: 'dark', name: 'Dark', hint: 'The default. Warm, soft dark.' },
  { id: 'midnight', name: 'Midnight', hint: 'True black. Great on OLED screens.' },
  { id: 'dim', name: 'Dim', hint: 'Lower contrast slate for long nights.' },
  { id: 'ember', name: 'Ember', hint: 'Cozy brown dark, like the fireplace.' },
  { id: 'light', name: 'Light', hint: 'Bright and clean for daytime.' },
];

// `css` is any CSS background value. Presets can use theme variables (rgb(var(--bg)), var(--accent-rgb)),
// so the adaptive ones follow your theme and accent color automatically.
export const BACKGROUNDS = [
  { id: 'glow', name: 'Hearth glow', group: 'Adaptive', css: 'radial-gradient(55% 45% at 0% 0%, rgb(var(--accent-rgb) / .20), transparent 70%), radial-gradient(45% 45% at 100% 100%, rgb(var(--accent-rgb) / .13), transparent 70%), rgb(var(--bg))' },
  { id: 'plain', name: 'Plain', group: 'Adaptive', css: 'rgb(var(--bg))', solid: true },
  { id: 'dots', name: 'Dots', group: 'Adaptive', pattern: true, css: 'radial-gradient(rgb(var(--text-rgb) / .10) 1.2px, transparent 1.4px) 0 0 / 22px 22px, rgb(var(--bg))' },
  { id: 'grid', name: 'Grid', group: 'Adaptive', pattern: true, css: 'linear-gradient(rgb(var(--text-rgb) / .05) 1px, transparent 1px) 0 0 / 32px 32px, linear-gradient(90deg, rgb(var(--text-rgb) / .05) 1px, transparent 1px) 0 0 / 32px 32px, rgb(var(--bg))' },
  { id: 'spotlight', name: 'Spotlight', group: 'Adaptive', css: 'radial-gradient(70% 55% at 50% -10%, rgb(var(--accent-rgb) / .28), transparent 70%), rgb(var(--bg))' },

  { id: 'aurora', name: 'Aurora', group: 'Dark gradients', css: 'radial-gradient(60% 55% at 15% 20%, #1fa2ff66, transparent 65%), radial-gradient(55% 55% at 85% 25%, #12d8fa44, transparent 65%), radial-gradient(70% 60% at 50% 105%, #a6ffcb3d, transparent 65%), linear-gradient(160deg, #06121f, #0b2236)' },
  { id: 'nebula', name: 'Nebula', group: 'Dark gradients', css: 'radial-gradient(50% 50% at 22% 30%, #7f00ff70, transparent 70%), radial-gradient(45% 45% at 78% 68%, #e100ff55, transparent 70%), radial-gradient(40% 40% at 62% 12%, #00c6ff45, transparent 70%), linear-gradient(180deg, #0b0618, #170b30)' },
  { id: 'embers', name: 'Embers', group: 'Dark gradients', css: 'radial-gradient(75% 55% at 50% 112%, #ff7a18b0, transparent 70%), radial-gradient(40% 35% at 20% 100%, #ef546670, transparent 70%), linear-gradient(180deg, #110c0b, #1f130f)' },
  { id: 'ocean', name: 'Deep sea', group: 'Dark gradients', css: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { id: 'twilight', name: 'Twilight', group: 'Dark gradients', css: 'linear-gradient(160deg, #141e30 0%, #243b55 50%, #5b2a86 100%)' },
  { id: 'forest', name: 'Forest', group: 'Dark gradients', css: 'linear-gradient(160deg, #0a1c15 0%, #134e3a 60%, #2f6d3c 100%)' },
  { id: 'synthwave', name: 'Synthwave', group: 'Dark gradients', css: 'linear-gradient(180deg, #120338 0%, #41167a 45%, #d53369 82%, #ffb347 100%)' },
  { id: 'graphite', name: 'Graphite', group: 'Dark gradients', css: 'linear-gradient(160deg, #18181b 0%, #2c2c33 100%)' },

  { id: 'sunset', name: 'Sunset', group: 'Bright gradients', css: 'linear-gradient(160deg, #2b1055 0%, #7b2f7f 40%, #f2709c 75%, #ff9472 100%)' },
  { id: 'candy', name: 'Candy', group: 'Bright gradients', css: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' },
  { id: 'lagoon', name: 'Lagoon', group: 'Bright gradients', css: 'linear-gradient(135deg, #43cea2 0%, #185a9d 100%)' },
  { id: 'citrus', name: 'Citrus', group: 'Bright gradients', css: 'linear-gradient(135deg, #f7971e 0%, #ffd200 100%)' },
  { id: 'peach', name: 'Peach', group: 'Bright gradients', css: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)' },
  { id: 'lavender', name: 'Lavender', group: 'Bright gradients', css: 'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)' },
  { id: 'mint', name: 'Mint', group: 'Bright gradients', css: 'linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)' },
  { id: 'cotton', name: 'Cotton candy', group: 'Bright gradients', css: 'radial-gradient(60% 60% at 20% 20%, #ffd1ff, transparent 70%), radial-gradient(60% 60% at 80% 80%, #a1c4fd, transparent 70%), #fbc2eb' },
];

// Interface fonts. All are fonts every device already has (or Hearth already loads), so nothing extra downloads.
export const UI_FONTS = [
  { id: 'default', name: 'Figtree', hint: 'The default', css: null },
  { id: 'system', name: 'System', hint: "Your device's own font", css: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif" },
  { id: 'readable', name: 'Readable', hint: 'Wide, very clear letters', css: "Verdana, Tahoma, 'DejaVu Sans', 'Segoe UI', sans-serif" },
  { id: 'rounded', name: 'Rounded', hint: 'Soft and friendly', css: "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', 'Segoe UI', system-ui, sans-serif" },
  { id: 'serif', name: 'Serif', hint: 'Like a book', css: "Charter, 'Iowan Old Style', Georgia, Cambria, 'Times New Roman', serif" },
  { id: 'mono', name: 'Mono', hint: 'Typewriter style', css: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace" },
];
export const CORNERS = [['sharp', 'Sharp'], ['normal', 'Normal'], ['round', 'Round']];

const KEY = 'hearth.appearance';
export const DEFAULTS = {
  theme: 'dark',
  accent: '#f2a541',
  scale: 100,
  density: 'comfortable', // comfortable | compact | minimal
  reduceMotion: false,
  bg: { kind: 'preset', preset: 'plain', colors: ['#7f00ff', '#e100ff', '#f2a541'], three: false, angle: 135, style: 'linear', animate: false },
  glass: 0.82,
  serverThemes: true, // let servers you visit apply their accent + background
  // Layout: the order of the four columns, where the server bar sits, sizes and panel style.
  layout: { order: ['rail', 'sidebar', 'main', 'panel'], rail: 'side', railSize: 'normal', sideW: 256, panelW: 272, threadW: 400, style: 'floating' },
  imgBlur: 0,
  dim: 0.2,
  font: 'default',
  corners: 'normal',
  performance: 'auto', // auto | on | off
};
// "Auto" turns performance mode on for clearly low-powered devices.
export function lowPowerDevice() {
  const cores = navigator.hardwareConcurrency || 8;
  const mem = navigator.deviceMemory || 8;
  return cores <= 2 || mem <= 2 || matchMedia('(prefers-reduced-transparency: reduce)').matches;
}

export function loadAppearance() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ignore */ }
  const a = { ...DEFAULTS, ...saved, bg: { ...DEFAULTS.bg, ...(saved.bg || {}) } };
  if (saved.compact && !saved.density) a.density = 'compact'; // older setting
  a.layout = { ...DEFAULTS.layout, ...(saved.layout || {}) };
  const valid = ['rail', 'sidebar', 'main', 'panel'];
  if (!Array.isArray(a.layout.order) || a.layout.order.length !== 4 || !valid.every((k) => a.layout.order.includes(k))) a.layout.order = [...DEFAULTS.layout.order];
  return a;
}
export function saveAppearance(a) {
  localStorage.setItem(KEY, JSON.stringify(a));
  applyAppearance();
}
// Share or back up a look: everything above except the background image (that stays in this browser).
export function exportAppearance() {
  const a = loadAppearance();
  return { hearthAppearance: 1, exported: new Date().toISOString(), settings: { ...a, bg: { ...a.bg, kind: a.bg.kind === 'image' ? 'preset' : a.bg.kind } } };
}
// A look file's settings, cleaned: only known keys (also inside bg and layout), each of the expected type,
// and the background checked value by value. Looks get shared with friends, so a file is untrusted input:
// anything that ends up in CSS must be a plain number or one of the known words.
export function cleanAppearance(src) {
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (!Object.hasOwn(src, k)) continue;
    const v = src[k];
    const d = DEFAULTS[k];
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) clean[k] = Object.fromEntries(Object.keys(d).map((x) => [x, Object.hasOwn(v, x) && typeof v[x] === typeof d[x] ? v[x] : d[x]]));
    } else if (typeof v === typeof d) clean[k] = v;
  }
  if (clean.bg) {
    const b = clean.bg;
    if (!['preset', 'gradient'].includes(b.kind)) b.kind = 'preset';
    if (!BACKGROUNDS.some((x) => x.id === b.preset)) b.preset = DEFAULTS.bg.preset;
    const colors = Array.isArray(src.bg.colors) ? src.bg.colors : [];
    b.colors = colors.length >= 3 ? colors.slice(0, 3).map((c) => (HEX.test(c) ? c : '#000000')) : [...DEFAULTS.bg.colors];
    b.angle = cleanAngle(b.angle);
    if (!GRADIENT_STYLES.includes(b.style)) b.style = DEFAULTS.bg.style;
  }
  if (clean.layout) {
    const valid = ['rail', 'sidebar', 'main', 'panel'];
    const order = Array.isArray(src.layout.order) ? src.layout.order : [];
    clean.layout.order = order.length === 4 && valid.every((x) => order.includes(x)) ? [...order] : [...DEFAULTS.layout.order];
  }
  return clean;
}
// Accepts what exportAppearance made. Returns false if the file isn't a Hearth look.
export function importAppearance(data) {
  const src = data && data.hearthAppearance && data.settings;
  if (!src || typeof src !== 'object') return false;
  const clean = cleanAppearance(src);
  const current = loadAppearance();
  saveAppearance({ ...clean, bg: clean.bg ? clean.bg : current.bg.kind === 'image' ? current.bg : DEFAULTS.bg });
  return true;
}
export function resetAppearance() {
  localStorage.removeItem(KEY);
  applyAppearance();
}

// ---------------------------------------------------------------- color helpers
const HEX = /^#[0-9a-f]{6}$/i;
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Gradient angles go into CSS: always a whole number of degrees (a look saved before this check, or a
// hand-made file, could hold any text there).
const GRADIENT_STYLES = ['linear', 'radial', 'mesh', 'conic'];
const cleanAngle = (a) => { const n = Number(a); return Number.isFinite(n) ? Math.round(Math.min(360, Math.max(0, n))) : DEFAULTS.bg.angle; };
export function gradientCss(bg) {
  const colors = (bg.three ? bg.colors.slice(0, 3) : bg.colors.slice(0, 2)).map((c) => (HEX.test(c) ? c : '#000000'));
  const angle = cleanAngle(bg.angle);
  if (bg.style === 'radial') return `radial-gradient(circle at 30% 20%, ${colors.join(', ')})`;
  if (bg.style === 'conic') return `conic-gradient(from ${angle}deg at 50% 50%, ${colors.join(', ')}, ${colors[0]})`;
  if (bg.style === 'mesh') {
    const [a, b, c = colors[0]] = colors;
    return `radial-gradient(55% 55% at 15% 20%, ${a}cc, transparent 70%), radial-gradient(55% 55% at 85% 30%, ${b}aa, transparent 70%), radial-gradient(60% 60% at 50% 100%, ${c}99, transparent 70%), rgb(var(--bg))`;
  }
  return `linear-gradient(${angle}deg, ${colors.join(', ')})`;
}

// What the background layer should paint for these settings (image URL handled separately).
export function backgroundCss(a) {
  if (a.bg.kind === 'gradient') return gradientCss(a.bg);
  if (a.bg.kind === 'image') return 'rgb(var(--bg))';
  const p = BACKGROUNDS.find((x) => x.id === a.bg.preset) || BACKGROUNDS[0];
  return p.css;
}
export function canAnimate(a) {
  if (a.bg.kind === 'gradient') return true;
  const p = a.bg.kind === 'preset' && BACKGROUNDS.find((x) => x.id === a.bg.preset);
  return !!(p && !p.pattern && !p.solid);
}
export function isSolid(a) {
  if (a.bg.kind !== 'preset') return false;
  const p = BACKGROUNDS.find((x) => x.id === a.bg.preset);
  return !!(p && p.solid);
}

// ---------------------------------------------------------------- background image (IndexedDB)
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('hearth-ui', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('files', mode);
    const req = fn(t.objectStore('files'));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}
export const saveBgImage = (blob) => tx('readwrite', (s) => s.put(blob, 'background'));
export const loadBgImage = () => tx('readonly', (s) => s.get('background')).catch(() => null);
export const clearBgImage = () => tx('readwrite', (s) => s.delete('background')).catch(() => {});

let imageUrl = null;
let imageToken = 0;

// ---------------------------------------------------------------- apply
function ensureBgLayer() {
  let host = document.getElementById('app-bg');
  if (!host) {
    host = document.createElement('div');
    host.id = 'app-bg';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = '<div class="bg-layer"></div><div class="bg-dim"></div>';
    document.body.prepend(host);
  }
  return host;
}

export const LAYOUT_PRESETS = [
  { id: 'classic', name: 'Classic', hint: 'Servers, channels, chat, then the side panel', layout: { order: ['rail', 'sidebar', 'main', 'panel'], rail: 'side' } },
  { id: 'mirrored', name: 'Mirrored', hint: 'Everything flipped to the right', layout: { order: ['panel', 'main', 'sidebar', 'rail'], rail: 'side' } },
  { id: 'topbar', name: 'Top bar', hint: 'Servers across the top, more room below', layout: { order: ['rail', 'sidebar', 'main', 'panel'], rail: 'top' } },
  { id: 'split', name: 'Panels left', hint: 'Channels and the side panel together on the left', layout: { order: ['rail', 'sidebar', 'panel', 'main'], rail: 'side' } },
];

// Turn the layout into CSS variables + data attributes the stylesheet uses. Narrow screens ignore it.
function applyLayout(root, L) {
  const width = { rail: 'var(--rail-w)', sidebar: 'var(--side-w)', main: 'minmax(0, 1fr)', panel: 'auto' };
  const cols = L.order.filter((k) => !(k === 'rail' && L.rail === 'top'));
  root.style.setProperty('--cols', cols.map((k) => width[k]).join(' '));
  root.style.setProperty('--cols-np', cols.filter((k) => k !== 'panel').map((k) => width[k]).join(' '));
  L.order.forEach((k, i) => root.style.setProperty(`--o-${k}`, String(i)));
  root.style.setProperty('--side-w', `${Math.min(420, Math.max(200, +L.sideW || 256))}px`);
  root.style.setProperty('--members-w', `${Math.min(520, Math.max(220, +L.panelW || 272))}px`);
  root.style.setProperty('--thread-w', `${Math.min(680, Math.max(300, +L.threadW || 400))}px`);
  const main = L.order.indexOf('main');
  root.dataset.rail = L.rail === 'top' ? 'top' : 'side';
  root.dataset.railSize = L.railSize === 'compact' ? 'compact' : 'normal';
  root.dataset.layoutStyle = ['floating', 'attached', 'spacious'].includes(L.style) ? L.style : 'floating';
  root.dataset.sidebarSide = L.order.indexOf('sidebar') < main ? 'left' : 'right';
  root.dataset.panelSide = L.order.indexOf('panel') < main ? 'left' : 'right';
  root.dataset.railSide = L.order.indexOf('rail') < main ? 'left' : 'right';
}

// The server you're looking at can bring its own accent and background (if you allow it).
let serverTheme = null;
let serverThemeKey = 'null';
export function setServerTheme(t) {
  const key = JSON.stringify(t || null);
  if (key === serverThemeKey) return;
  serverThemeKey = key;
  serverTheme = t || null;
  applyAppearance();
}
function serverBackgroundCss(b) {
  if (!b || b.kind === 'none') return null;
  if (b.kind === 'image' && b.image) return `center / cover no-repeat url("${b.image}"), rgb(var(--bg))`;
  if (b.kind === 'gradient' && (b.colors || []).length >= 2) return gradientCss({ ...b, three: (b.colors || []).length > 2 });
  if (b.kind === 'preset') { const p = BACKGROUNDS.find((x) => x.id === b.preset); return p ? p.css : null; }
  return null;
}

export function applyAppearance() {
  const a = loadAppearance();
  const root = document.documentElement;
  root.dataset.theme = THEMES.some((t) => t.id === a.theme) ? a.theme : 'dark';

  const st = a.serverThemes !== false ? serverTheme : null;
  const accent = st && HEX.test(st.accent || '') ? st.accent : HEX.test(a.accent) ? a.accent : DEFAULTS.accent;
  const [r, g, b] = hexToRgb(accent);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-rgb', `${r} ${g} ${b}`);
  root.style.setProperty('--on-accent', luminance(accent) > 0.4 ? '#1a1407' : '#ffffff');
  root.style.fontSize = `${Math.min(125, Math.max(85, +a.scale || 100))}%`;
  root.dataset.density = ['comfortable', 'compact', 'minimal'].includes(a.density) ? a.density : 'comfortable';
  root.classList.toggle('reduce-motion', !!a.reduceMotion);
  const font = UI_FONTS.find((f) => f.id === a.font);
  if (font && font.css) { root.style.setProperty('--font', font.css); root.style.setProperty('--font-display', font.css); }
  else { root.style.removeProperty('--font'); root.style.removeProperty('--font-display'); }
  root.dataset.corners = CORNERS.some(([id]) => id === a.corners) ? a.corners : 'normal';
  root.classList.toggle('lite', a.performance === 'on' || (a.performance !== 'off' && lowPowerDevice()));

  applyLayout(root, a.layout);
  const solid = isSolid(a);
  root.classList.toggle('has-bg', !solid);
  root.style.setProperty('--glass', solid ? '1' : String(Math.min(1, Math.max(0.35, +a.glass || 0.82))));
  root.style.setProperty('--img-blur', `${a.bg.kind === 'image' ? Math.min(30, Math.max(0, +a.imgBlur || 0)) : 0}px`);
  root.style.setProperty('--dim', String(solid ? 0 : Math.min(0.8, Math.max(0, +a.dim || 0))));

  const host = ensureBgLayer();
  const layer = host.firstChild;
  layer.classList.toggle('animate', !!a.bg.animate && canAnimate(a));
  layer.style.background = backgroundCss(a);
  const sbg = st && serverBackgroundCss(st.background);
  if (sbg) {
    layer.classList.remove('animate');
    layer.style.background = sbg;
    root.classList.add('has-bg');
    root.style.setProperty('--glass', String(Math.min(1, Math.max(0.35, +a.glass || 0.82))));
    root.style.setProperty('--dim', String(Math.min(0.8, Math.max(0, +(st.background.dim ?? 0.25)))));
    root.style.setProperty('--img-blur', '0px');
    imageToken++; // cancel any pending personal background image
    return;
  }

  if (a.bg.kind === 'image') {
    const token = ++imageToken;
    loadBgImage().then((blob) => {
      if (token !== imageToken) return;
      if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
      if (blob) {
        imageUrl = URL.createObjectURL(blob);
        layer.style.background = `center / cover no-repeat url("${imageUrl}"), rgb(var(--bg))`;
      }
    });
  } else {
    imageToken++;
  }
}
