// Rendering for avatars, styled names and full profile cards.
import { h, hashColor, initials, fmtDay } from './util.js';
import { render as md, renderDoc } from './markdown.js';
import { activityCards, favoriteGamesEl, recentGamesEl } from './activity.js';

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
    style: {
      '--size': size + 'px', '--ring': p.ringColor || '#f2a541', '--ring2': p.ringColor2 || p.accentColor || '#f2a541',
      '--ring3': p.ringColor3 || p.ringColor2 || p.accentColor || p.ringColor || '#f2a541', '--ring-dur': `${11 - (+p.ringSpeed || 4)}s`,
    },
    dataset: { userAv: u ? u.id : '', size: String(size), status: status ? '1' : '' },
  });
  const inner = h('span', { class: 'av-inner', style: { background: u && u.avatar ? 'transparent' : hashColor(u ? u.id : '?') } });
  if (u && u.avatar) inner.append(h('img', { class: 'cropped', src: u.avatar, alt: '', loading: 'lazy', draggable: 'false', style: cropStyle(p.avatarCrop) }));
  else inner.append(h('span', { class: 'av-initials', style: { fontSize: Math.max(10, size * 0.38) + 'px' } }, initials(displayName(u))));
  wrap.append(inner);
  // The dot's shape differs per status too (ring, moon, bar), and it carries the words for screen readers.
  if (status) wrap.append(h('span', { class: `status-dot st-${presenceOf(u, meId)}`, title: STATUS_LABEL[presenceOf(u, meId)], role: 'img', 'aria-label': STATUS_LABEL[presenceOf(u, meId)] }));
  return wrap;
}

export function nameEl(u, { tag = 'span', cls = '', roleColor = '' } = {}) {
  const p = (u && u.profile) || {};
  const effect = p.nameEffect || 'none';
  const gradient = !!p.nameColor2 || effect === 'flow';
  // The default white name follows the theme's text color so it stays readable in light mode.
  // Server role colors show for people who haven't picked their own name color.
  const plain = !p.nameColor || p.nameColor.toLowerCase() === '#ffffff';
  const n1 = plain ? (roleColor && !p.nameColor2 ? roleColor : 'var(--text)') : p.nameColor;
  const el = h(tag, {
    class: `uname fx-${effect}${gradient ? ' grad' : ''} ${cls}`.trim(),
    style: {
      '--n1': n1,
      '--n2': p.nameColor2 || n1,
      '--n3': p.nameColor3 || p.nameColor2 || n1,
      '--n4': p.nameColor4 || p.nameColor3 || p.nameColor2 || n1,
      '--nglow': p.nameGlow || 'var(--n1x)',
      fontFamily: FONT_STACKS[p.nameFont] || 'inherit',
    },
    dataset: { userName: u ? u.id : '' },
  }, displayName(u));
  if (effect === 'glitch') el.dataset.text = displayName(u);
  if (p.nameColor3) el.classList.add('grad-multi');
  if (p.nameFont === 'Press Start 2P') el.classList.add('font-tiny');
  if (p.nameFont === 'Monoton' || p.nameFont === 'Bungee') el.classList.add('font-wide');
  return el;
}

const EFFECT_GLYPHS = { sparkles: '✦', snow: '❄', hearts: '♥', stars: '★', bubbles: '', embers: '', sakura: '✿', confetti: '■', rain: '│', fireflies: '' };
// Split into characters/emoji the way people see them (a flag or 👍🏽 is one).
export function splitGlyphs(t) {
  t = String(t || '');
  return typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter().segment(t)].map((x) => x.segment).filter((g) => g.trim()) : Array.from(t).filter((g) => g.trim());
}
// A build-your-own effect: the person's own characters, count, motion, speed, size and color.
export function customFxLayer(fx) {
  const f = fx || {};
  const glyphs = splitGlyphs(f.glyphs || '✦');
  if (!glyphs.length) return null;
  const count = Math.min(40, Math.max(4, +f.count || 16));
  const speed = Math.min(10, Math.max(1, +f.speed || 5));
  const layer = h('div', {
    class: `pfx pfx-custom m-${f.motion || 'fall'}${f.glow ? ' glow' : ''}`, 'aria-hidden': 'true',
    style: { '--fx-size': `${Math.min(48, Math.max(8, +f.size || 16))}px`, '--fx-dur': `${(22 - speed * 2)}s`, '--fx-color': f.color || 'currentColor' },
  });
  for (let i = 0; i < count; i++) {
    const x = (i * 37 + 11) % 100;
    const y = (i * 61 + 7) % 100;
    const d = ((i * 53) % 100) / 10;
    const sc = 0.6 + ((i * 29) % 10) / 12;
    const still = ['twinkle', 'spin', 'zoom', 'bounce'].includes(f.motion); // these stay in place, scattered over the card
    layer.append(h('span', { style: { left: x + '%', top: still ? y + '%' : null, animationDelay: `-${d}s`, '--s': sc } }, glyphs[i % glyphs.length]));
  }
  return layer;
}
export function effectLayer(effect, customFx) {
  if (!effect || effect === 'none') return null;
  if (effect === 'custom') return customFxLayer(customFx);
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
export function stopSong() { if (songAudio) songAudio.pause(); }
export function songPlayer(u, p) {
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
  const fx = effectLayer(p.profileEffect, p.customFx);
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
  inner.append(h('div', { class: 'pc-handle' }, u.username, p.pronouns ? h('span', { class: 'pc-pronouns' }, p.pronouns) : null,
    u.supporter ? h('span', { class: 'supporter-tag', title: 'Helps pay for this server' }, '\uD83D\uDC9C Supporter') : null));
  const act = activityCards(u, { compact: true });
  if (act) inner.append(h('div', { class: 'pc-section' }, act));
  if (p.bio) {
    inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'About me'), h('div', { class: 'pc-bio', html: md(p.bio) })));
  }
  if (p.links && p.links.length) {
    inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'Links'),
      h('div', { class: 'pc-links' }, p.links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'pc-link' }, l.label || new URL(l.url).hostname)))));
  }
  if (u.song) inner.append(h('div', { class: 'pc-section' }, songPlayer(u, p)));
  if ((p.interests || []).length) inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'Interests'), h('div', { class: 'pc-tags' }, p.interests.map((t) => h('span', { class: 'pc-tag' }, t)))));
  const fav = favoriteGamesEl(p.games, { limit: compact ? 6 : 12 });
  if (fav) inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'Favorite games'), fav));
  const recent = !compact && recentGamesEl((u.recentGames || []).slice(0, 4));
  if (recent) inner.append(h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'Recently played'), recent));
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
