// Rendering for avatars, styled names and full profile cards.
import { h, hashColor, initials, fmtDay } from './util.js';
import { render as md, renderDoc } from './markdown.js';

export const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible', offline: 'Offline' };

export const FONT_STACKS = {
  default: 'inherit',
  Pacifico: "'Pacifico', cursive",
  Orbitron: "'Orbitron', sans-serif",
  'Press Start 2P': "'Press Start 2P', monospace",
  Caveat: "'Caveat', cursive",
  Righteous: "'Righteous', sans-serif",
  Bungee: "'Bungee', sans-serif",
  'Space Mono': "'Space Mono', monospace",
  'Playfair Display': "'Playfair Display', serif",
  Creepster: "'Creepster', cursive",
  Comfortaa: "'Comfortaa', sans-serif",
  Monoton: "'Monoton', cursive",
};

export function displayName(u) {
  if (!u) return 'Unknown';
  return (u.profile && u.profile.displayName) || u.username;
}

export function presenceOf(u, meId) {
  if (!u) return 'offline';
  if (u.id === meId && u.status) return u.status === 'invisible' ? 'invisible' : u.status;
  return u.presence || 'offline';
}

// <span data-user-av="id"> wrappers get swapped when the user updates.
// Non-destructive crop: offset in % of the frame + zoom, applied with a CSS transform (GIFs keep animating).
export function cropStyle(c) {
  if (!c || (!c.x && !c.y && (!c.z || c.z === 1))) return {};
  return { '--tx': (c.x || 0) + '%', '--ty': (c.y || 0) + '%', '--z': String(c.z || 1) };
}

export function avatarEl(u, size = 40, { status = false, meId = '', speaking = false } = {}) {
  const p = (u && u.profile) || {};
  const shape = p.avatarShape || 'circle';
  const ring = p.avatarRing || 'none';
  const wrap = h('span', {
    class: `av shape-${shape} ring-${ring}${speaking ? ' speaking' : ''}`,
    style: { '--size': size + 'px', '--ring': p.ringColor || '#f2a541', '--ring2': p.accentColor || '#f2a541' },
    dataset: { userAv: u ? u.id : '', size: String(size), status: status ? '1' : '' },
  });
  const inner = h('span', { class: 'av-inner', style: { background: u && u.avatar ? 'transparent' : hashColor(u ? u.id : '?') } });
  if (u && u.avatar) inner.append(h('img', { class: 'cropped', src: u.avatar, alt: '', loading: 'lazy', draggable: 'false', style: cropStyle(p.avatarCrop) }));
  else inner.append(h('span', { class: 'av-initials', style: { fontSize: Math.max(10, size * 0.38) + 'px' } }, initials(displayName(u))));
  wrap.append(inner);
  if (status) wrap.append(h('span', { class: `status-dot st-${presenceOf(u, meId)}`, title: STATUS_LABEL[presenceOf(u, meId)] }));
  return wrap;
}

export function nameEl(u, { tag = 'span', cls = '', roleColor = '' } = {}) {
  const p = (u && u.profile) || {};
  const effect = p.nameEffect || 'none';
  const gradient = !!p.nameColor2;
  // The default white name follows the theme's text color so it stays readable in light mode.
  // Server role colors show for people who haven't picked their own name color.
  const plain = !p.nameColor || p.nameColor.toLowerCase() === '#ffffff';
  const n1 = plain ? (roleColor && !p.nameColor2 ? roleColor : 'var(--text)') : p.nameColor;
  const el = h(tag, {
    class: `uname fx-${effect}${gradient ? ' grad' : ''} ${cls}`.trim(),
    style: {
      '--n1': n1,
      '--n2': p.nameColor2 || n1,
      fontFamily: FONT_STACKS[p.nameFont] || 'inherit',
    },
    dataset: { userName: u ? u.id : '' },
  }, displayName(u));
  if (p.nameFont === 'Press Start 2P') el.classList.add('font-tiny');
  if (p.nameFont === 'Monoton' || p.nameFont === 'Bungee') el.classList.add('font-wide');
  return el;
}

const EFFECT_GLYPHS = { sparkles: '✦', snow: '❄', hearts: '♥', stars: '★', bubbles: '', embers: '', sakura: '✿', confetti: '■', rain: '│', fireflies: '' };
function effectLayer(effect) {
  if (!effect || effect === 'none') return null;
  const layer = h('div', { class: `pfx pfx-${effect}`, 'aria-hidden': 'true' });
  // deterministic positions so re-renders don't jump
  for (let i = 0; i < 16; i++) {
    const x = (i * 37 + 11) % 100;
    const d = ((i * 53) % 40) / 10;
    const s = 0.6 + ((i * 29) % 10) / 10;
    layer.append(h('span', { style: { left: x + '%', animationDelay: `-${d}s`, '--s': s } }, EFFECT_GLYPHS[effect]));
  }
  return layer;
}

export function bannerEl(u, height = 110) {
  const p = u.profile || {};
  const el = h('div', { class: 'pc-banner', style: { height: height + 'px', background: p.bannerColor || '#f2a541' } });
  if (u.banner) el.append(h('img', { class: 'cropped', src: u.banner, alt: '', draggable: 'false', style: cropStyle(p.bannerCrop) }));
  return el;
}

// Full profile card. `actions` is an optional node (buttons).
// One shared player, so only one profile song plays at a time.
let songAudio = null;
let songOwner = null;
function songPlayer(u, p) {
  const btn = h('button', { class: 'pc-song', 'aria-label': `Play ${p.songTitle || 'profile song'}` },
    h('span', { class: 'pc-song-ic' }, '\u25B6'), h('span', { class: 'pc-song-title' }, p.songTitle || 'Profile song'), h('span', { class: 'pc-song-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  const sync = () => { const on = songOwner === u.id && songAudio && !songAudio.paused; btn.classList.toggle('playing', on); btn.firstChild.textContent = on ? '\u275A\u275A' : '\u25B6'; };
  btn.addEventListener('click', () => {
    if (songOwner === u.id && songAudio && !songAudio.paused) { songAudio.pause(); sync(); return; }
    if (songAudio) songAudio.pause();
    songAudio = new Audio(u.song); songOwner = u.id;
    songAudio.volume = 0.6;
    songAudio.addEventListener('ended', sync); songAudio.addEventListener('pause', sync);
    songAudio.play().then(sync).catch(() => {});
  });
  sync();
  return btn;
}
export function profileCard(u, { meId = '', actions = null, compact = false, mutual = null, topFriends = null } = {}) {
  const p = u.profile || {};
  const style = p.cardStyle || 'gradient';
  const noBanner = p.showBanner === false;
  const card = h('div', {
    class: `pcard pc-${style}${compact ? ' pc-compact' : ''}${noBanner ? ' pc-no-banner' : ''}`,
    style: { '--c1': p.themePrimary, '--c2': p.themeSecondary, '--acc': p.accentColor },
  });
  if (u.background) card.append(h('div', { class: 'pc-bg' }, h('img', { class: 'cropped pc-bg-img', src: u.background, alt: '', draggable: 'false', style: cropStyle(p.backgroundCrop) })));
  const fx = effectLayer(p.profileEffect);
  // With the banner turned off, the profile background shows through the whole card.
  card.append(noBanner ? h('div', { class: 'pc-banner-space' }) : bannerEl(u, compact ? 96 : 120));
  const body = h('div', { class: 'pc-body' });
  const avWrap = h('div', { class: 'pc-av' }, avatarEl(u, 84, { status: true, meId }));
  body.append(avWrap);
  if (p.customStatus && (p.customStatus.text || p.customStatus.emoji)) {
    body.append(h('div', { class: 'pc-bubble' }, p.customStatus.emoji ? h('span', { class: 'pc-bubble-emoji' }, p.customStatus.emoji) : null, p.customStatus.text || ''));
  }
  const inner = h('div', { class: 'pc-inner' });
  inner.append(nameEl(u, { tag: 'div', cls: 'pc-name' }));
  inner.append(h('div', { class: 'pc-handle' }, u.username, p.pronouns ? h('span', { class: 'pc-pronouns' }, p.pronouns) : null));
  if (p.bio) {
    inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'About me'), h('div', { class: 'pc-bio', html: md(p.bio) })));
  }
  if (p.links && p.links.length) {
    inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'Links'),
      h('div', { class: 'pc-links' }, p.links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'pc-link' }, l.label || new URL(l.url).hostname)))));
  }
  if (u.song) inner.append(h('div', { class: 'pc-section' }, songPlayer(u, p)));
  if ((p.interests || []).length) inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'Interests'), h('div', { class: 'pc-tags' }, p.interests.map((t) => h('span', { class: 'pc-tag' }, t)))));
  if (!compact && p.aboutMe) inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'More about me'), h('div', { class: 'pc-about md', html: renderDoc(p.aboutMe) })));
  if (!compact && topFriends) inner.append(topFriends);
  if (mutual) inner.append(mutual);
  inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'Member since'), h('div', { class: 'pc-since' }, fmtDay(u.createdAt))));
  if (actions) inner.append(h('div', { class: 'pc-actions' }, actions));
  body.append(inner);
  card.append(body);
  if (fx) card.append(fx);
  return card;
}
