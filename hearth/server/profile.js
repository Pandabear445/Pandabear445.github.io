// Profile customization: validation + defaults. Every option here is free.
const HEX = /^#[0-9a-fA-F]{6}$/;

const FONTS = ['default', 'Pacifico', 'Orbitron', 'Press Start 2P', 'Caveat', 'Righteous',
  'Bungee', 'Space Mono', 'Playfair Display', 'Creepster', 'Comfortaa', 'Monoton'];
const RINGS = ['none', 'solid', 'gradient', 'rainbow', 'glow', 'pulse'];
const CARD_STYLES = ['solid', 'gradient', 'glass'];
const EFFECTS = ['none', 'sparkles', 'snow', 'hearts', 'stars', 'bubbles', 'embers', 'sakura', 'confetti', 'rain', 'fireflies'];
const SHAPES = ['circle', 'rounded', 'square', 'hexagon'];
const NAME_EFFECTS = ['none', 'glow', 'shimmer', 'rainbow'];

const DEFAULTS = {
  displayName: '',
  pronouns: '',
  bio: '',
  customStatus: { emoji: '', text: '' },
  bannerColor: '#f2a541',
  themePrimary: '#2a2438',
  themeSecondary: '#1b1824',
  accentColor: '#f2a541',
  nameColor: '#ffffff',
  nameColor2: '',
  nameFont: 'default',
  nameEffect: 'none',
  avatarRing: 'none',
  ringColor: '#f2a541',
  avatarShape: 'circle',
  cardStyle: 'gradient',
  showBanner: true,
  profileEffect: 'none',
  links: [],
};

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const hex = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

const num = (v, min, max, d) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : d);
const crop = (c) => ({ x: num(c && c.x, -200, 200, 0), y: num(c && c.y, -200, 200, 0), z: num(c && c.z, 1, 5, 1) });

function sanitizeProfile(input, current = {}) {
  const merged = { ...DEFAULTS, ...current, ...(input || {}) };
  const links = Array.isArray(merged.links) ? merged.links : [];
  return {
    displayName: str(merged.displayName, 32).trim(),
    pronouns: str(merged.pronouns, 40),
    bio: str(merged.bio, 1200),
    customStatus: {
      emoji: str(merged.customStatus && merged.customStatus.emoji, 16),
      text: str(merged.customStatus && merged.customStatus.text, 128),
    },
    bannerColor: hex(merged.bannerColor, DEFAULTS.bannerColor),
    themePrimary: hex(merged.themePrimary, DEFAULTS.themePrimary),
    themeSecondary: hex(merged.themeSecondary, DEFAULTS.themeSecondary),
    accentColor: hex(merged.accentColor, DEFAULTS.accentColor),
    nameColor: hex(merged.nameColor, DEFAULTS.nameColor),
    nameColor2: merged.nameColor2 ? hex(merged.nameColor2, '') : '',
    nameFont: pick(merged.nameFont, FONTS, 'default'),
    nameEffect: pick(merged.nameEffect, NAME_EFFECTS, 'none'),
    avatarRing: pick(merged.avatarRing, RINGS, 'none'),
    ringColor: hex(merged.ringColor, DEFAULTS.ringColor),
    avatarShape: pick(merged.avatarShape, SHAPES, 'circle'),
    cardStyle: pick(merged.cardStyle, CARD_STYLES, 'gradient'),
    showBanner: merged.showBanner !== false,
    profileEffect: pick(merged.profileEffect, EFFECTS, 'none'),
    // Where each picture sits inside its frame: offset (% of the frame) and zoom. Non-destructive,
    // so animated GIFs keep animating and people can re-adjust any time.
    avatarCrop: crop(merged.avatarCrop),
    bannerCrop: crop(merged.bannerCrop),
    backgroundCrop: crop(merged.backgroundCrop),
    // MySpace-style extras: about me (Markdown), interests, top friends and the profile song's title.
    aboutMe: String(merged.aboutMe || '').slice(0, 2000),
    interests: (Array.isArray(merged.interests) ? merged.interests : []).map((x) => String(x).trim().slice(0, 24)).filter(Boolean).slice(0, 12),
    topFriends: (Array.isArray(merged.topFriends) ? merged.topFriends : []).map(String).filter((x) => /^[a-z0-9]{6,40}$/.test(x)).slice(0, 8),
    songTitle: String(merged.songTitle || '').slice(0, 80),
    links: links.slice(0, 6)
      .map((l) => ({ label: str(l && l.label, 32), url: str(l && l.url, 300) }))
      .filter((l) => /^https?:\/\/[^\s]+$/i.test(l.url)),
  };
}

function parseProfile(row) {
  try { return sanitizeProfile(JSON.parse(row.profile || '{}')); } catch { return sanitizeProfile({}); }
}

module.exports = { sanitizeProfile, parseProfile, FONTS, DEFAULTS };
