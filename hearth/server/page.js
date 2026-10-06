// MySpace-style profile pages: the page theme, blurbs, details and custom CSS.
// Kept apart from the profile (which every client downloads for every user) because it's bigger
// and only needed when someone opens the page.
const { graphemes } = require('./profile');

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (v, d) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const pick = (v, list, d) => (list.includes(v) ? v : d);
const num = (v, min, max, d) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : d);

const LAYOUTS = ['classic', 'mirrored', 'single', 'wide'];
const BG_KINDS = ['color', 'gradient', 'pattern', 'image'];
const PATTERNS = ['stars', 'dots', 'checker', 'stripes', 'hearts', 'grid', 'zigzag', 'plaid'];
const REPEATS = ['tile', 'cover', 'center'];
const BORDERS = ['none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'];
const SHADOWS = ['none', 'soft', 'hard', 'glow'];
const FONTS = ['default', 'system', 'serif', 'mono', 'comic', 'Pacifico', 'Orbitron', 'Press Start 2P', 'Caveat', 'Righteous',
  'Bungee', 'Space Mono', 'Playfair Display', 'Creepster', 'Comfortaa', 'Monoton'];
const COMMENTS = ['everyone', 'friends', 'off'];
const INTERESTS = ['general', 'music', 'movies', 'tv', 'books', 'games', 'heroes'];

const PAGE_DEFAULTS = {
  layout: 'classic',
  bg: { kind: 'gradient', color: '#0d1b3e', color2: '#3a1c71', angle: 160, pattern: 'stars', patternColor: '#ffffff', repeat: 'tile', fixed: true },
  text: '#e8e6f0',
  link: '#7fb8ff',
  heading: '#ffd166',
  boxBg: '#14112a',
  boxAlpha: 85,
  headerBg: '#6a4cff',
  headerText: '#ffffff',
  border: 'solid',
  borderWidth: 1,
  borderColor: '#6a4cff',
  radius: 8,
  shadow: 'soft',
  font: 'default',
  fontSize: 15,
  glitterTitle: false,
  marquee: false,
  cursorTrail: '',
  showViews: true,
  autoplay: false,
  meet: '',
  details: [],
  interests: {},
  comments: 'everyone',
  css: '',
};

// Custom CSS. The browser does the real work (it scopes every rule to the page and drops anything
// that could load something from elsewhere); this is the first line of defence and keeps it small.
function sanitizeCss(css) {
  let s = String(css || '').slice(0, 12000);
  s = s.replace(/\/\*[\s\S]*?\*\//g, '') // comments
    .replace(/\\/g, '') // escapes could hide the words below
    .replace(/<\/?\s*style/gi, '')
    .replace(/@(import|charset|namespace|font-face|property|layer|container|supports|page|document)\b[^;{]*(;|\{[^}]*\})?/gi, '')
    .replace(/\b(url|image-set|image|src|expression|element|cross-fade)\s*\(/gi, 'blocked(')
    .replace(/javascript\s*:/gi, '')
    .replace(/(-moz-binding|behavior)\s*:/gi, 'blocked:');
  return s.slice(0, 10000);
}

function sanitizePage(input, current = {}) {
  const m = { ...PAGE_DEFAULTS, ...current, ...(input || {}) };
  const bg = { ...PAGE_DEFAULTS.bg, ...(current.bg || {}), ...((input && input.bg) || {}) };
  const interests = {};
  INTERESTS.forEach((k) => { const v = str((m.interests || {})[k], 300).trim(); if (v) interests[k] = v; });
  return {
    layout: pick(m.layout, LAYOUTS, 'classic'),
    bg: {
      kind: pick(bg.kind, BG_KINDS, 'gradient'),
      color: hex(bg.color, PAGE_DEFAULTS.bg.color),
      color2: hex(bg.color2, PAGE_DEFAULTS.bg.color2),
      angle: Math.round(num(bg.angle, 0, 360, 160)),
      pattern: pick(bg.pattern, PATTERNS, 'stars'),
      patternColor: hex(bg.patternColor, '#ffffff'),
      repeat: pick(bg.repeat, REPEATS, 'tile'),
      fixed: bg.fixed !== false,
    },
    text: hex(m.text, PAGE_DEFAULTS.text),
    link: hex(m.link, PAGE_DEFAULTS.link),
    heading: hex(m.heading, PAGE_DEFAULTS.heading),
    boxBg: hex(m.boxBg, PAGE_DEFAULTS.boxBg),
    boxAlpha: Math.round(num(m.boxAlpha, 0, 100, 85)),
    headerBg: hex(m.headerBg, PAGE_DEFAULTS.headerBg),
    headerText: hex(m.headerText, PAGE_DEFAULTS.headerText),
    border: pick(m.border, BORDERS, 'solid'),
    borderWidth: Math.round(num(m.borderWidth, 0, 8, 1)),
    borderColor: hex(m.borderColor, PAGE_DEFAULTS.borderColor),
    radius: Math.round(num(m.radius, 0, 30, 8)),
    shadow: pick(m.shadow, SHADOWS, 'soft'),
    font: pick(m.font, FONTS, 'default'),
    fontSize: Math.round(num(m.fontSize, 12, 20, 15)),
    glitterTitle: !!m.glitterTitle,
    marquee: !!m.marquee,
    cursorTrail: graphemes(m.cursorTrail).slice(0, 16),
    showViews: m.showViews !== false,
    autoplay: !!m.autoplay,
    meet: str(m.meet, 2000),
    details: (Array.isArray(m.details) ? m.details : []).slice(0, 10)
      .map((d) => ({ label: str(d && d.label, 24).trim(), value: str(d && d.value, 80).trim() }))
      .filter((d) => d.label && d.value),
    interests,
    comments: pick(m.comments, COMMENTS, 'everyone'),
    css: sanitizeCss(m.css),
  };
}

function parsePage(row) {
  try { return sanitizePage(JSON.parse((row && row.page) || '{}')); } catch { return sanitizePage({}); }
}

module.exports = { sanitizePage, parsePage, sanitizeCss, PAGE_DEFAULTS };
