// Games people are playing and like, and music they're listening to.
//
// Where it comes from:
//  - Games: the desktop app sees the running game (Steam's own "running game" setting, plus a list of
//    popular non-Steam games), or people pick one by hand. Pictures come from Steam, Wikipedia (games
//    that aren't on Steam: Fortnite, Valorant, League…) and, if the owner adds a free key, RAWG.
//  - Music: Last.fm (works with Spotify, Apple Music, YouTube Music, Tidal, Deezer… through their scrobbling),
//    the desktop app (Spotify / Apple Music app / anything that talks to Linux's media controls), or a link
//    someone pastes. Album art comes from the service, or the iTunes search if it has none.
// Activity is shown only while the person is online (not invisible) and only if they share it. It isn't
// end-to-end encrypted (like your online status, the server has to know it to show it).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const BASE = {
  steam: env.STEAM_STORE_BASE || 'https://store.steampowered.com',
  steamCdn: env.STEAM_CDN_BASE || 'https://shared.akamai.steamstatic.com',
  wiki: env.WIKIPEDIA_API || 'https://en.wikipedia.org/w/api.php',
  rawg: env.RAWG_API_BASE || 'https://api.rawg.io/api',
  lastfm: env.LASTFM_API_BASE || 'https://ws.audioscrobbler.com/2.0/',
  itunes: env.ITUNES_API_BASE || 'https://itunes.apple.com',
};
// Pictures are only ever fetched from these hosts (plus ART_PROXY_EXTRA_HOSTS), so the picture proxy can't be
// pointed at anything else.
const ART_HOSTS = /(^|\.)(steamstatic\.com|steampowered\.com|wikimedia\.org|rawg\.io|fastly\.net|last\.fm|lastfm\.freetls\.fastly\.net|mzstatic\.com|scdn\.co|spotifycdn\.com|ytimg\.com|ggpht\.com|googleusercontent\.com|sndcdn\.com|dzcdn\.net|tidal\.com|bcbits\.com)$/i;
const EXTRA_ART_HOSTS = (env.ART_PROXY_EXTRA_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean);
const artAllowed = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' && ART_HOSTS.test(x.hostname)) || EXTRA_ART_HOSTS.includes(x.host); } catch { return false; } };

const PLATFORMS = {
  spotify: { name: 'Spotify', search: (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}` },
  apple: { name: 'Apple Music', search: (q) => `https://music.apple.com/search?term=${encodeURIComponent(q)}` },
  youtube: { name: 'YouTube Music', search: (q) => `https://music.youtube.com/search?q=${encodeURIComponent(q)}` },
  soundcloud: { name: 'SoundCloud', search: (q) => `https://soundcloud.com/search?q=${encodeURIComponent(q)}` },
  tidal: { name: 'TIDAL', search: (q) => `https://tidal.com/search?q=${encodeURIComponent(q)}` },
  deezer: { name: 'Deezer', search: (q) => `https://www.deezer.com/search/${encodeURIComponent(q)}` },
  amazon: { name: 'Amazon Music', search: (q) => `https://music.amazon.com/search/${encodeURIComponent(q)}` },
  bandcamp: { name: 'Bandcamp', search: (q) => `https://bandcamp.com/search?q=${encodeURIComponent(q)}` },
  other: { name: '', search: null },
};
const GAME_ID = /^(steam:\d{1,10}|wiki:\d{1,12}|rawg:\d{1,10})$/;
// Steam "apps" that aren't games but still show up as running.
const NOT_GAMES = new Set(['431960', '250820', '228980', '1070560', '1391110', '1493710']);

module.exports = function setupActivity(ctx) {
  const { api, app, auth, db, fail, wrap, rateLimit, isOnline, getUserRow, getSetting, setSetting, checkMediaToken, requireInstanceAdmin, checkWords, DATA_DIR, version } = ctx;
  const UA = `Hearth/${version} (self-hosted chat; https://github.com/)`;
  const now = () => Date.now();
  const lastfmKey = () => getSetting('lastfmKey') || env.LASTFM_API_KEY || '';
  const rawgKey = () => getSetting('rawgKey') || env.RAWG_API_KEY || '';

  // Follows up to 3 redirects itself, checking every hop, so a redirect can't send this server somewhere else.
  async function safeFetch(url, ok, opts = {}) {
    let u = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!ok(u)) return null;
      const r = await fetch(u, { ...opts, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).href; continue; }
      return r;
    }
    return null;
  }
  async function getJson(url, { timeout = 8000, headers = {} } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; } finally { clearTimeout(t); }
  }
  async function getText(url, okHost, timeout = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await safeFetch(url, (x) => { try { const h = new URL(x); return h.protocol === 'https:' && okHost(h.hostname); } catch { return false; } }, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'text/html' } });
      if (!r || !r.ok) return '';
      const reader = r.body.getReader(); let out = ''; const dec = new TextDecoder();
      while (out.length < 400000) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
      try { reader.cancel(); } catch { /* done */ }
      return out;
    } catch { return ''; } finally { clearTimeout(t); }
  }

  // ------------------------------------------------------------------ picture cache (data/cache/art)
  const CACHE_DIR = path.join(DATA_DIR, 'cache', 'art');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const CACHE_MAX = (+env.ART_CACHE_MB || 400) * 1024 * 1024;
  const inflight = new Map();
  const cacheKey = (u) => crypto.createHash('sha1').update(u).digest('hex');
  async function fetchImage(url) {
    if (!artAllowed(url)) return null;
    const key = cacheKey(url);
    const file = path.join(CACHE_DIR, key);
    try { const type = fs.readFileSync(file + '.type', 'utf8'); return { file, type }; } catch { /* not cached */ }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10000);
      try {
        const r = await safeFetch(url, artAllowed, { signal: ctl.signal, headers: { 'User-Agent': UA } });
        const type = r ? (r.headers.get('content-type') || '').split(';')[0] : '';
        if (!r || !r.ok || !/^image\//.test(type)) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 6 * 1024 * 1024) return null;
        fs.writeFileSync(file, buf); fs.writeFileSync(file + '.type', type);
        return { file, type };
      } catch { return null; } finally { clearTimeout(t); inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }
  function pruneCache() {
    try {
      const files = fs.readdirSync(CACHE_DIR).filter((f) => !f.endsWith('.type')).map((f) => { const st = fs.statSync(path.join(CACHE_DIR, f)); return { f, size: st.size, t: st.atimeMs || st.mtimeMs }; });
      let total = files.reduce((a, x) => a + x.size, 0);
      for (const x of files.sort((a, b) => a.t - b.t)) {
        if (total <= CACHE_MAX * 0.8) break;
        try { fs.unlinkSync(path.join(CACHE_DIR, x.f)); fs.unlinkSync(path.join(CACHE_DIR, x.f + '.type')); } catch { /* gone */ }
        total -= x.size;
      }
    } catch { /* ignore */ }
  }
  setTimeout(pruneCache, 30000).unref();
  setInterval(pruneCache, 3600000).unref();
  const sendImage = (res, img) => {
    if (!img) return res.status(404).end();
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    fs.createReadStream(img.file).on('error', () => res.destroy()).pipe(res);
  };

  // ------------------------------------------------------------------ game catalog
  const upsertGame = (g) => {
    db.prepare(`INSERT INTO game_catalog (id, name, cover_url, wide_url, link, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, cover_url = COALESCE(excluded.cover_url, game_catalog.cover_url),
      wide_url = COALESCE(excluded.wide_url, game_catalog.wide_url), link = COALESCE(excluded.link, game_catalog.link), updated_at = excluded.updated_at`)
      .run(g.id, String(g.name).slice(0, 120), g.cover || null, g.wide || null, g.link || null, now());
    return g;
  };
  const gameRow = (id) => db.prepare('SELECT * FROM game_catalog WHERE id = ?').get(id);
  const gameOut = (g) => ({ id: g.id, name: g.name, link: g.link || null, year: g.year || undefined, source: g.id.split(':')[0] });
  const steamCover = (id) => `${BASE.steamCdn}/store_item_assets/steam/apps/${id}/library_600x900.jpg`;
  const steamHeader = (id) => `${BASE.steamCdn}/store_item_assets/steam/apps/${id}/header.jpg`;

  async function steamSearch(q) {
    const j = await getJson(`${BASE.steam}/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=US`);
    return ((j && j.items) || []).filter((x) => x.type === 'app' && x.id && x.name && !NOT_GAMES.has(String(x.id))).slice(0, 8)
      .map((x) => ({ id: `steam:${x.id}`, name: x.name, cover: steamCover(x.id), wide: steamHeader(x.id), link: `https://store.steampowered.com/app/${x.id}` }));
  }
  async function wikiSearch(q) {
    const j = await getJson(`${BASE.wiki}?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(q + ' video game')}&gsrlimit=8&prop=pageimages%7Cdescription&piprop=thumbnail&pithumbsize=600`);
    const pages = Object.values((j && j.query && j.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    return pages.filter((p) => /video game|game\b/i.test(p.description || '') && !/series|franchise|company|developer|character/i.test(p.description || ''))
      .slice(0, 5).map((p) => {
        const year = ((p.description || '').match(/\b(19|20)\d\d\b/) || [])[0];
        return { id: `wiki:${p.pageid}`, name: p.title.replace(/ \((\d{4} )?video game\)$/i, ''), cover: p.thumbnail && p.thumbnail.source, wide: p.thumbnail && p.thumbnail.source, link: `https://en.wikipedia.org/?curid=${p.pageid}`, year };
      });
  }
  async function rawgSearch(q) {
    if (!rawgKey()) return [];
    const j = await getJson(`${BASE.rawg}/games?key=${encodeURIComponent(rawgKey())}&search=${encodeURIComponent(q)}&page_size=6`);
    return ((j && j.results) || []).map((x) => ({ id: `rawg:${x.id}`, name: x.name, cover: x.background_image, wide: x.background_image, link: `https://rawg.io/games/${x.slug}`, year: (x.released || '').slice(0, 4) || undefined }));
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[™®©:'’!.,-]/g, '').replace(/\s+/g, ' ').trim();
  const searchCache = new Map();
  async function searchGames(q) {
    q = String(q || '').trim().slice(0, 80);
    if (q.length < 2) return [];
    const ck = norm(q);
    const hit = searchCache.get(ck);
    if (hit && now() - hit.at < 3600000) return hit.list;
    const [steam, wiki, rawg] = await Promise.all([steamSearch(q), wikiSearch(q), rawgSearch(q)]);
    const seen = new Set(); const list = [];
    for (const g of [...steam, ...rawg, ...wiki]) {
      const k = norm(g.name);
      if (seen.has(k)) continue;
      seen.add(k); list.push(g);
    }
    // Exact name matches first.
    list.sort((a, b) => (norm(b.name) === ck) - (norm(a.name) === ck));
    list.slice(0, 12).forEach(upsertGame);
    const out = list.slice(0, 12).map(gameOut);
    searchCache.set(ck, { at: now(), list: out });
    if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
    return out;
  }
  // A game we only know by ID (favorites from before the catalog, or Steam's running-game number).
  async function resolveGame(id) {
    if (!GAME_ID.test(id)) return null;
    const row = gameRow(id);
    if (row) return row;
    const [kind, num] = id.split(':');
    if (kind === 'steam') {
      const j = await getJson(`${BASE.steam}/api/appdetails?appids=${num}&filters=basic`);
      const d = j && j[num] && j[num].success && j[num].data;
      if (!d) return null;
      if (d.type && d.type !== 'game') return { notGame: true };
      upsertGame({ id, name: d.name, cover: steamCover(num), wide: d.header_image || steamHeader(num), link: `https://store.steampowered.com/app/${num}` });
    } else if (kind === 'wiki') {
      const j = await getJson(`${BASE.wiki}?action=query&format=json&pageids=${num}&prop=pageimages&piprop=thumbnail&pithumbsize=600`);
      const p = j && j.query && j.query.pages && j.query.pages[num];
      if (!p || p.missing !== undefined) return null;
      upsertGame({ id, name: p.title, cover: p.thumbnail && p.thumbnail.source, wide: p.thumbnail && p.thumbnail.source, link: `https://en.wikipedia.org/?curid=${num}` });
    } else if (kind === 'rawg' && rawgKey()) {
      const x = await getJson(`${BASE.rawg}/games/${num}?key=${encodeURIComponent(rawgKey())}`);
      if (!x || !x.name) return null;
      upsertGame({ id, name: x.name, cover: x.background_image, wide: x.background_image, link: `https://rawg.io/games/${x.slug}` });
    }
    return gameRow(id);
  }
  // A game the desktop app found by its program name: find it in the catalog or search for it once.
  const nameToGame = new Map();
  async function gameByName(name) {
    const k = norm(name);
    if (nameToGame.has(k)) return nameToGame.get(k);
    let row = db.prepare('SELECT * FROM game_catalog WHERE lower(name) = lower(?)').get(name);
    if (!row) {
      const list = await searchGames(name);
      const pick = list.find((g) => norm(g.name) === k) || list[0];
      row = pick ? gameRow(pick.id) : null;
    }
    const out = row ? { id: row.id, name: row.name } : { name };
    nameToGame.set(k, out);
    return out;
  }

  api.get('/games/search', auth, wrap(async (req, res) => {
    rateLimit('gamesearch:' + req.userId, 40, 60000);
    res.json(await searchGames(req.query.q));
  }));
  // Game pictures, cached on this server. Tall cover by default, ?w=1 for the wide banner.
  app.get('/media/game/:id', wrap(async (req, res) => {
    const id = String(req.params.id).replace(/\.jpg$/, '');
    if (!GAME_ID.test(id)) return res.status(404).end();
    rateLimit('gameimg:' + req.ip, 600, 60000);
    // Only games this server already looked up (through search, favorites or someone playing them), so this
    // public address can't be used to make the server fetch arbitrary things.
    const g = gameRow(id);
    if (!g) return res.status(404).end();
    const urls = req.query.w ? [g.wide_url, g.cover_url] : [g.cover_url, g.wide_url];
    for (const u of urls.filter(Boolean)) {
      const img = await fetchImage(u);
      if (img) return sendImage(res, img);
    }
    res.status(404).end();
  }));
  // Album art and other activity pictures (signed links, only known music/game hosts).
  app.get(['/media/art', '/media/art/:key'], wrap(async (req, res) => {
    if (!checkMediaToken(req.query.t)) return res.status(403).end();
    rateLimit('artimg:' + req.ip, 600, 60000);
    sendImage(res, await fetchImage(String(req.query.u || '')));
  }));

  // ------------------------------------------------------------------ settings per person
  const CFG_DEFAULT = { shareGames: true, shareMusic: true, lastfm: '', platform: 'spotify', recent: [] };
  const cfgOf = (row) => { try { return { ...CFG_DEFAULT, ...JSON.parse((row && row.activity_cfg) || '{}') }; } catch { return { ...CFG_DEFAULT }; } };
  const saveCfg = (uid, cfg) => db.prepare('UPDATE users SET activity_cfg = ? WHERE id = ?').run(JSON.stringify(cfg), uid);
  const cfgCache = new Map(); // userId -> cfg (publicUser runs a lot)
  const cfgFor = (row) => { let c = cfgCache.get(row.id); if (!c || c.raw !== row.activity_cfg) { c = { raw: row.activity_cfg, cfg: cfgOf(row) }; cfgCache.set(row.id, c); } return c.cfg; };

  // ------------------------------------------------------------------ live activity
  const live = new Map(); // userId -> { game, music, offlineAt }
  const entry = (uid) => { let e = live.get(uid); if (!e) { e = {}; live.set(uid, e); } return e; };
  const queue = new Set();
  let timer = null;
  function announce(uid) {
    queue.add(uid);
    if (!timer) timer = setTimeout(() => {
      timer = null;
      const list = [...queue].map((id) => { const row = getUserRow(id); return { id, activity: row ? activityFor(row) : null }; });
      queue.clear();
      if (list.length) ctx.emit('user:activity', list);
    }, 800);
  }
  function activityFor(row) {
    if (!row || !isOnline(row.id) || row.status === 'invisible') return null;
    const e = live.get(row.id);
    if (!e) return null;
    const cfg = cfgFor(row);
    const out = {};
    if (e.game && cfg.shareGames) out.game = { id: e.game.id, name: e.game.name, since: e.game.since };
    if (e.music && cfg.shareMusic) {
      const m = e.music;
      const plat = (Object.hasOwn(PLATFORMS, m.platform) && PLATFORMS[m.platform]) || PLATFORMS.other;
      out.music = { title: m.title, artist: m.artist, album: m.album, art: m.art, platform: m.platform, platformName: plat.name, url: m.url || (plat.search ? plat.search(`${m.title} ${m.artist}`.trim()) : null), since: m.since };
    }
    return out.game || out.music ? out : null;
  }
  // Recently played (shown on profiles): the last 8 games, with rough hours.
  function addPlaytime(uid, game) {
    if (!game || !game.since) return;
    const minutes = Math.max(0, Math.round((now() - game.since) / 60000));
    const row = getUserRow(uid);
    if (!row) return;
    const cfg = cfgOf(row);
    const recent = (cfg.recent || []).filter((r) => r.name !== game.name);
    const prev = (cfg.recent || []).find((r) => r.name === game.name);
    recent.unshift({ id: game.id || null, name: game.name, at: now(), minutes: (prev ? prev.minutes : 0) + minutes });
    cfg.recent = recent.slice(0, 8);
    saveCfg(uid, cfg);
  }
  function setGame(uid, game) {
    const e = entry(uid);
    const same = e.game && game && (e.game.id ? e.game.id === game.id : e.game.name === game.name);
    if (same) { e.game.seen = now(); e.game.source = game.source; return; }
    if (e.game) addPlaytime(uid, e.game);
    e.game = game ? { ...game, since: now(), seen: now() } : null;
    announce(uid);
  }
  function setMusic(uid, music) {
    const e = entry(uid);
    const same = e.music && music && e.music.title === music.title && e.music.artist === music.artist;
    if (same) { e.music.seen = now(); return; }
    e.music = music ? { ...music, since: now(), seen: now() } : null;
    announce(uid);
  }
  // Clean up: the desktop app re-sends every ~30 s (gone after 2 minutes of silence), Last.fm songs
  // after 10 minutes without a "now playing", hand-picked ones after 12 hours, everything 5 minutes after
  // the person goes offline.
  setInterval(() => {
    const t = now();
    for (const [uid, e] of live) {
      if (!isOnline(uid)) { if (!e.offlineAt) e.offlineAt = t; } else e.offlineAt = 0;
      const gone = e.offlineAt && t - e.offlineAt > 5 * 60000;
      const stale = (x) => x && (gone || (x.source === 'desktop' && t - x.seen > 120000) || (x.source === 'lastfm' && t - x.seen > 10 * 60000) || (x.source === 'manual' && t - x.since > 12 * 3600000));
      if (stale(e.game)) setGame(uid, null);
      if (stale(e.music)) setMusic(uid, null);
      if (!e.game && !e.music) live.delete(uid);
    }
  }, 30000).unref();

  // Album art for a song we only know by name (desktop app): ask the iTunes search once.
  const artCache = new Map();
  async function findArt(title, artist) {
    const k = norm(`${artist} ${title}`);
    if (artCache.has(k)) return artCache.get(k);
    const j = await getJson(`${BASE.itunes}/search?term=${encodeURIComponent(`${artist} ${title}`)}&entity=song&limit=1`);
    const r = j && j.results && j.results[0];
    const art = r && r.artworkUrl100 ? r.artworkUrl100.replace(/100x100bb/, '300x300bb') : null;
    artCache.set(k, art);
    if (artCache.size > 2000) artCache.delete(artCache.keys().next().value);
    return art;
  }

  // A pasted song link: Spotify, Apple Music, YouTube (Music), SoundCloud, Deezer, TIDAL, Bandcamp.
  async function fromLink(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { fail(400, 'That isn’t a link.'); }
    if (u.protocol !== 'https:') fail(400, 'Use an https:// link.');
    const host = u.hostname.replace(/^www\./, '');
    const oembed = async (endpoint, platform) => {
      const j = await getJson(`${endpoint}${encodeURIComponent(u.href)}`);
      if (!j || !j.title) fail(400, 'Couldn’t read that link. Is the song public?');
      let title = String(j.title); let artist = String(j.author_name || '');
      const by = title.match(/^(.*) by (.*)$/); // SoundCloud: "Song by Artist"
      if (by && platform === 'soundcloud') { title = by[1]; artist = artist || by[2]; }
      if (platform === 'youtube') { const dash = title.match(/^(.*?) - (.*)$/); if (dash) { artist = dash[1]; title = dash[2]; } artist = artist.replace(/ - Topic$/, ''); }
      return { title, artist, art: j.thumbnail_url && artAllowed(j.thumbnail_url) ? j.thumbnail_url : null, platform, url: u.href };
    };
    const og = async (platform) => {
      const html = await getText(u.href, (host) => host === 'music.apple.com' || /(^|\.)bandcamp\.com$/.test(host));
      const meta = (p) => { const m = html.match(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']+)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${p}["']`, 'i')); return m ? m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, '’').replace(/&quot;/g, '"') : ''; };
      const title = meta('title');
      if (!title) fail(400, 'Couldn’t read that link. Is the song public?');
      const img = meta('image');
      const parts = title.split(/ [-–—] | by /);
      return { title: parts[0], artist: parts[1] || '', art: img && artAllowed(img) ? img : null, platform, url: u.href };
    };
    if (host === 'open.spotify.com') return oembed('https://open.spotify.com/oembed?url=', 'spotify');
    if (host === 'music.youtube.com') {
      const v = u.searchParams.get('v');
      if (!v) fail(400, 'Paste the link to a song (it has ?v= in it).');
      return { ...(await fromLink(`https://www.youtube.com/watch?v=${encodeURIComponent(v)}`)), url: u.href };
    }
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com') return oembed('https://www.youtube.com/oembed?format=json&url=', 'youtube');
    if (host === 'soundcloud.com' || host === 'on.soundcloud.com') return oembed('https://soundcloud.com/oembed?format=json&url=', 'soundcloud');
    if (host === 'deezer.com' || host === 'deezer.page.link') return oembed('https://api.deezer.com/oembed?url=', 'deezer');
    if (host === 'tidal.com' || host === 'listen.tidal.com') return oembed('https://oembed.tidal.com/?url=', 'tidal');
    if (host === 'music.apple.com') return og('apple');
    if (/(^|\.)bandcamp\.com$/.test(host)) return og('bandcamp');
    fail(400, 'Paste a song link from Spotify, Apple Music, YouTube Music, SoundCloud, Deezer, TIDAL or Bandcamp.');
  }

  const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
  api.put('/me/activity', auth, wrap(async (req, res) => {
    rateLimit('activity:' + req.userId, 60, 60000);
    const b = req.body || {};
    const uid = req.userId;
    const source = b.source === 'desktop' ? 'desktop' : 'manual';
    // "Nothing running" from the desktop app only clears what the desktop app itself set.
    const cur = live.get(uid) || {};
    const mayClear = (x) => x && (source !== 'desktop' || x.source === 'desktop');
    if ('game' in b) {
      const g = b.game;
      if (!g) { if (mayClear(cur.game)) setGame(uid, null); }
      else if (g.steamAppId) {
        const id = `steam:${String(g.steamAppId).replace(/\D/g, '').slice(0, 10)}`;
        if (NOT_GAMES.has(id.slice(6))) setGame(uid, null);
        else {
          const row = await resolveGame(id);
          if (row && !row.notGame) setGame(uid, { id, name: row.name, source });
        }
      } else if (g.id) {
        if (!GAME_ID.test(String(g.id))) fail(400, 'Unknown game.');
        const row = await resolveGame(String(g.id));
        if (!row || row.notGame) fail(400, 'Unknown game.');
        setGame(uid, { id: row.id, name: row.name, source });
      } else if (g.name) {
        const name = clean(g.name, 60);
        checkWords(name);
        setGame(uid, { ...(source === 'desktop' ? await gameByName(name) : { name }), source });
      }
    }
    if ('music' in b) {
      const m = b.music;
      if (!m) { if (mayClear(cur.music)) setMusic(uid, null); }
      else if (m.link) setMusic(uid, { ...(await fromLink(m.link)), source: 'manual' });
      else if (m.title) {
        const title = clean(m.title, 120); const artist = clean(m.artist, 120);
        checkWords(title, artist);
        const platform = Object.hasOwn(PLATFORMS, m.platform) ? m.platform : cfgOf(getUserRow(uid)).platform;
        setMusic(uid, { title, artist, album: clean(m.album, 120), platform, art: await findArt(title, artist), source });
      }
    }
    res.json({ activity: activityFor(getUserRow(uid)) });
  }));

  api.get('/me/activity-settings', auth, (req, res) => {
    const c = cfgOf(getUserRow(req.userId));
    res.json({ shareGames: c.shareGames, shareMusic: c.shareMusic, lastfm: c.lastfm, platform: c.platform, lastfmEnabled: !!lastfmKey(), platforms: Object.entries(PLATFORMS).map(([id, p]) => ({ id, name: p.name || 'Other' })), recent: c.recent || [] });
  });
  api.patch('/me/activity-settings', auth, wrap(async (req, res) => {
    const b = req.body || {};
    const row = getUserRow(req.userId);
    const c = cfgOf(row);
    if (b.shareGames !== undefined) c.shareGames = !!b.shareGames;
    if (b.shareMusic !== undefined) c.shareMusic = !!b.shareMusic;
    if (b.platform !== undefined && Object.hasOwn(PLATFORMS, b.platform)) c.platform = b.platform;
    if (b.clearRecent) c.recent = [];
    if (b.lastfm !== undefined) {
      const name = String(b.lastfm || '').trim().slice(0, 40);
      if (name && !/^[A-Za-z][\w-]{1,30}$/.test(name)) fail(400, 'That isn’t a Last.fm username.');
      if (name && lastfmKey()) {
        const j = await getJson(`${BASE.lastfm}?method=user.getinfo&user=${encodeURIComponent(name)}&api_key=${encodeURIComponent(lastfmKey())}&format=json`);
        if (!j || !j.user) fail(400, 'Last.fm doesn’t know that username.');
      }
      c.lastfm = name;
      if (!name && live.get(req.userId) && live.get(req.userId).music && live.get(req.userId).music.source === 'lastfm') setMusic(req.userId, null);
      lastPolled.delete(req.userId);
    }
    saveCfg(req.userId, c);
    announce(req.userId);
    ctx.broadcastUser(req.userId);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ Last.fm "now playing"
  const lastPolled = new Map();
  let polling = false;
  async function pollLastfm() {
    if (polling || !lastfmKey()) return;
    polling = true;
    try {
      const users = db.prepare("SELECT id, status, activity_cfg FROM users WHERE activity_cfg LIKE '%\"lastfm\":\"_%'").all()
        .filter((r) => isOnline(r.id) && r.status !== 'invisible').map((r) => ({ id: r.id, cfg: cfgOf(r) })).filter((u) => u.cfg.lastfm && u.cfg.shareMusic);
      // Stay well under Last.fm's limits: about 3 requests a second at most.
      const every = Math.max(30000, Math.ceil(users.length / 3) * 1000);
      for (const u of users) {
        if (now() - (lastPolled.get(u.id) || 0) < every) continue;
        lastPolled.set(u.id, now());
        const j = await getJson(`${BASE.lastfm}?method=user.getrecenttracks&user=${encodeURIComponent(u.cfg.lastfm)}&api_key=${encodeURIComponent(lastfmKey())}&format=json&limit=1`);
        const tr = j && j.recenttracks && [].concat(j.recenttracks.track || [])[0];
        const e = live.get(u.id);
        if (tr && tr['@attr'] && tr['@attr'].nowplaying === 'true') {
          const title = clean(tr.name, 120); const artist = clean(tr.artist && (tr.artist['#text'] || tr.artist.name), 120);
          let art = ([].concat(tr.image || []).reverse().find((i) => i['#text']) || {})['#text'] || null;
          if (art && /2a96cbd8b46e442fc41c2b86b821562f/.test(art)) art = null; // Last.fm's blank star picture
          if (!(e && e.music && e.music.source !== 'lastfm' && e.music.source !== undefined && now() - e.music.seen < 120000)) {
            setMusic(u.id, { title, artist, album: clean(tr.album && tr.album['#text'], 120), art: art || await findArt(title, artist), platform: u.cfg.platform, source: 'lastfm' });
          }
        } else if (e && e.music && e.music.source === 'lastfm') setMusic(u.id, null);
      }
    } finally { polling = false; }
  }
  setInterval(() => { pollLastfm().catch(() => {}); }, 10000).unref();

  // ------------------------------------------------------------------ admin: keys
  api.get('/admin/activity', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    res.json({ lastfmKeySet: !!lastfmKey(), rawgKeySet: !!rawgKey(), sharing: live.size, games: db.prepare('SELECT COUNT(*) n FROM game_catalog').get().n });
  });
  api.patch('/admin/activity', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const b = req.body || {};
    if (b.lastfmKey !== undefined) setSetting('lastfmKey', String(b.lastfmKey || '').trim().slice(0, 64) || null);
    if (b.rawgKey !== undefined) { setSetting('rawgKey', String(b.rawgKey || '').trim().slice(0, 64) || null); searchCache.clear(); }
    res.json({ ok: true, lastfmKeySet: !!lastfmKey(), rawgKeySet: !!rawgKey() });
  });

  // Recently played, for profiles (only if the person shares games).
  const recentFor = (row) => { const c = cfgFor(row); return c.shareGames && (c.recent || []).length ? c.recent.slice(0, 8).map((r) => ({ id: r.id, name: r.name, at: r.at, minutes: r.minutes })) : undefined; };
  const settingsFor = (row) => { const c = cfgFor(row); return { shareGames: c.shareGames, shareMusic: c.shareMusic }; };

  return { activityFor, recentFor, settingsFor, GAME_ID, searchGames };
};
