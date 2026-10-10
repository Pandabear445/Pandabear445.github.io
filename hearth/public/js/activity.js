// What people are playing and listening to, their favorite games, and the pickers to set them.
import { h, icon, clear, toast } from './util.js';
import { api } from './api.js';
import { modal } from './ui.js';

let token = () => '';
let onChange = () => {};
export function initActivity({ mediaToken, changed }) { token = mediaToken; onChange = changed || onChange; }

export const gameImg = (id, wide = false) => `/media/game/${encodeURIComponent(id)}${wide ? '?w=1' : ''}`;
const artKey = (u) => { let x = 5381; for (let i = 0; i < u.length; i++) x = ((x * 33) ^ u.charCodeAt(i)) >>> 0; return x.toString(36); };
export const artUrl = (u) => (u ? `/media/art/${artKey(u)}?u=${encodeURIComponent(u)}&t=${encodeURIComponent(token())}` : '');

const ago = (since) => {
  const m = Math.max(0, Math.floor((Date.now() - since) / 60000));
  if (m < 1) return 'just started';
  if (m < 60) return `for ${m}m`;
  return `for ${Math.floor(m / 60)}h ${m % 60}m`;
};
const hours = (min) => (min < 60 ? `${Math.max(1, min)} min` : `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`);
// Keep "for 12m" fresh without re-rendering everything.
setInterval(() => document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = ago(+el.dataset.since); }), 30000);

const isOn = (u) => u && u.presence && u.presence !== 'offline';
export const hasActivity = (u) => isOn(u) && u.activity && (u.activity.game || u.activity.music);

function picture(src, cls, fallbackText) {
  const wrap = h('span', { class: `act-pic ${cls}` });
  const ph = h('span', { class: 'act-pic-ph' }, (fallbackText || '?').trim().slice(0, 1).toUpperCase());
  wrap.append(ph);
  if (src) {
    const img = h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => ph.remove());
    img.addEventListener('error', () => img.remove());
    wrap.append(img);
  }
  return wrap;
}

// One short line for lists: "🎮 Playing Elden Ring" / "🎧 Listening to Song".
export function activityLine(u) {
  if (!hasActivity(u)) return null;
  const { game, music } = u.activity;
  if (game) return h('span', { class: 'act-line', title: `Playing ${game.name}` }, icon('gamepad'), h('span', null, 'Playing ', h('b', null, game.name)));
  return h('span', { class: 'act-line music', title: `Listening to ${music.title}${music.artist ? ` by ${music.artist}` : ''}` }, icon('music'), h('span', null, 'Listening to ', h('b', null, music.title)));
}

// Rich cards for profiles: cover art, how long, where.
export function activityCards(u, { compact = false } = {}) {
  if (!hasActivity(u)) return null;
  const { game, music } = u.activity;
  const box = h('div', { class: `act-cards${compact ? ' compact' : ''}` });
  if (game) {
    box.append(h('div', { class: 'act-card game' },
      h('div', { class: 'act-kind' }, 'Playing a game'),
      h('div', { class: 'act-row' },
        picture(game.id ? gameImg(game.id) : '', 'cover', game.name),
        h('div', { class: 'act-text' },
          h('div', { class: 'act-title' }, game.name),
          h('div', { class: 'act-sub', dataset: { since: game.since } }, ago(game.since))))));
  }
  if (music) {
    const where = music.platformName ? ` on ${music.platformName}` : '';
    box.append(h('div', { class: 'act-card music' },
      h('div', { class: 'act-kind' }, `Listening${where}`),
      h('div', { class: 'act-row' },
        picture(artUrl(music.art), 'art', music.title),
        h('div', { class: 'act-text' },
          h('div', { class: 'act-title' }, music.title),
          music.artist ? h('div', { class: 'act-sub' }, `by ${music.artist}`) : null,
          music.album && !compact ? h('div', { class: 'act-sub dim' }, `on ${music.album}`) : null),
        music.url ? (compact
          ? h('a', { class: 'icon-btn sm act-open', href: music.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': music.platformName ? `Open in ${music.platformName}` : 'Open', 'data-tip': music.platformName ? `Open in ${music.platformName}` : 'Open' }, icon('external'))
          : h('a', { class: 'btn sm ghost act-open', href: music.url, target: '_blank', rel: 'noopener noreferrer' }, music.platformName ? `Open in ${music.platformName}` : 'Open')) : null)));
  }
  return box;
}

export function favoriteGamesEl(games, { limit = 12 } = {}) {
  if (!games || !games.length) return null;
  return h('div', { class: 'fav-games' }, games.slice(0, limit).map((g) => h('div', { class: 'fav-game', title: g.name },
    picture(gameImg(g.id), 'cover', g.name), h('span', { class: 'fav-game-name' }, g.name))));
}
export function recentGamesEl(list) {
  if (!list || !list.length) return null;
  return h('div', { class: 'recent-games' }, list.map((g) => h('div', { class: 'recent-game' },
    picture(g.id ? gameImg(g.id, true) : '', 'wide', g.name),
    h('div', { class: 'act-text' }, h('div', { class: 'act-title' }, g.name), h('div', { class: 'act-sub' }, `${hours(g.minutes || 0)} played`)))));
}

// Search for a game (Steam, Wikipedia, RAWG). Calls onPick({ id, name }).
export function pickGame({ title = 'Find a game', onPick, allowCustom = false }) {
  const input = h('input', { class: 'input', placeholder: 'Search games (Minecraft, Fortnite, Elden Ring…)', 'aria-label': 'Search games' });
  const results = h('div', { class: 'game-results' }, h('p', { class: 'field-hint' }, 'Pictures come from Steam and Wikipedia.'));
  let seq = 0; let close;
  const run = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2) return;
    clear(results).append(h('span', { class: 'spinner' }));
    let list = [];
    try { list = await api('GET', `/games/search?q=${encodeURIComponent(q)}`); } catch (e) { if (mine === seq) clear(results).append(h('p', { class: 'form-error' }, e.message)); return; }
    if (mine !== seq) return;
    clear(results);
    for (const g of list) {
      results.append(h('button', { class: 'game-result', onclick: () => { onPick(g); close(); } },
        picture(gameImg(g.id), 'cover', g.name),
        h('span', { class: 'act-text' }, h('span', { class: 'act-title' }, g.name), h('span', { class: 'act-sub' }, [g.year, { steam: 'Steam', wiki: 'Wikipedia', rawg: 'RAWG' }[g.source]].filter(Boolean).join(' · ')))));
    }
    if (allowCustom) results.append(h('button', { class: 'game-result custom', onclick: () => { onPick({ name: q }); close(); } }, picture('', 'cover', q), h('span', { class: 'act-text' }, h('span', { class: 'act-title' }, `Just call it “${q}”`), h('span', { class: 'act-sub' }, 'No picture'))));
    if (!list.length && !allowCustom) results.append(h('p', { class: 'field-hint' }, 'Nothing found. Try the full name.'));
  };
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 350); });
  const m = modal({ title, body: h('div', { class: 'stack' }, input, results), size: 'md', className: 'game-picker' });
  close = m.close;
  setTimeout(() => input.focus(), 50);
}

export async function setActivity(body) {
  const r = await api('PUT', '/me/activity', body);
  onChange(r.activity);
  return r.activity;
}

// "Set what I'm playing / listening to" — for phones and browsers (the desktop app finds it by itself).
export function openActivityPicker(current) {
  const game = current && current.game; const music = current && current.music;
  const link = h('input', { class: 'input', placeholder: 'Paste a song link (Spotify, Apple Music, YouTube Music, SoundCloud…)' });
  const title = h('input', { class: 'input', placeholder: 'Or type: song title' });
  const artist = h('input', { class: 'input', placeholder: 'Artist' });
  const body = h('div', { class: 'stack' },
    h('h3', { class: 'set-h' }, 'Playing'),
    game ? h('div', { class: 'row gap' }, h('span', null, `Now: ${game.name}`), h('button', { class: 'btn sm ghost', onclick: async () => { await setActivity({ game: null }); toast('Cleared.'); } }, 'Stop')) : null,
    h('div', null, h('button', { class: 'btn', onclick: () => pickGame({ title: 'What are you playing?', allowCustom: true, onPick: async (g) => { try { await setActivity({ game: g.id ? { id: g.id } : { name: g.name } }); toast(`Playing ${g.name}.`); } catch (e) { toast(e.message, 'error'); } } }) }, icon('gamepad'), 'Choose a game')),
    h('h3', { class: 'set-h' }, 'Listening to'),
    music ? h('div', { class: 'row gap' }, h('span', null, `Now: ${music.title}${music.artist ? ` — ${music.artist}` : ''}`), h('button', { class: 'btn sm ghost', onclick: async () => { await setActivity({ music: null }); toast('Cleared.'); } }, 'Stop')) : null,
    link, h('div', { class: 'row gap' }, title, artist),
    h('p', { class: 'field-hint' }, 'Shows on your profile and in member lists while you’re online. Connect Last.fm in Settings → Activity to have it update by itself.'));
  modal({
    title: 'Set an activity', body, size: 'md',
    actions: [{ label: 'Close' }, { label: 'Set song', kind: 'primary', action: async () => {
      if (link.value.trim()) await setActivity({ music: { link: link.value.trim() } });
      else if (title.value.trim()) await setActivity({ music: { title: title.value.trim(), artist: artist.value.trim() } });
      else throw new Error('Paste a link or type a song title.');
      toast('Song set.');
    } }],
  });
}

// ------------------------------------------------------------------ desktop app: automatic detection
let detecting = false; let lastSent = ''; let lastAt = 0;
export function startDesktopDetection(settings) {
  const d = window.hearthDesktop;
  if (!d || !d.detectActivity) return;
  d.detectActivity({ games: !!(settings && settings.shareGames), songs: !!(settings && settings.shareMusic) });
  if (detecting) return;
  detecting = true;
  d.onActivity(async (a) => {
    const body = { source: 'desktop', game: a.game || null, music: a.music || null };
    const key = JSON.stringify(body);
    if (key === lastSent && Date.now() - lastAt < 45000) return; // the server forgets after 2 minutes of silence
    lastSent = key; lastAt = Date.now();
    try { await setActivity(body); } catch { lastSent = ''; }
  });
}
