// The news bot: follows things people care about and posts new items into a server channel.
//
// Sources (no API keys needed): a topic search (Google News), a YouTube channel, a subreddit, a Steam game's
// news, a GitHub project's releases, or any RSS/Atom feed. Each feed checks every 15 minutes.
// Only NEW things get posted: when a feed is added, everything already in it is marked as seen, and
// anything dated before the feed was added is skipped even if the source shuffles it back to the top.
//
// Bot posts are public news, so they're stored like older messages (protected by the server's at-rest
// encryption, not end-to-end) and the app labels them that way. Everything people write stays end-to-end.
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

const BOT_ID = 'newsbot00000000000001';
const KINDS = {
  topic: { name: 'Topic search', url: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en` },
  youtube: { name: 'YouTube channel' },
  reddit: { name: 'Subreddit', url: (q) => `https://www.reddit.com/r/${encodeURIComponent(q.replace(/^\/?r\//i, '').replace(/[^\w]/g, ''))}/new/.rss` },
  steam: { name: 'Steam game news', url: (appid) => `https://store.steampowered.com/feeds/news/app/${appid}/` },
  github: { name: 'GitHub releases', url: (repo) => `https://github.com/${repo}/releases.atom` },
  rss: { name: 'RSS / Atom feed', url: (u) => u },
};
const EVERY_MS = 15 * 60000;
const MAX_POSTS_PER_CHECK = 3;

// ------------------------------------------------------------------ fetching safely
// Feeds are fetched by this server, so addresses inside your network (the VPS itself, the router, cloud
// metadata) are refused, and every redirect is checked again.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('::ffff:') && privateIp(v.slice(7));
}
async function assertPublic(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error('That isn’t a web address.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) addresses.');
  if (process.env.FEED_ALLOW_PRIVATE === '1') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!ips.length) throw new Error(`Couldn’t find ${host}.`);
  if (ips.some(privateIp)) throw new Error('That address is inside a private network.');
  return u;
}
async function safeGet(urlStr, { accept = 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.5, */*;q=0.1', max = 3 * 1024 * 1024, timeout = 12000 } = {}) {
  let url = urlStr;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HearthNewsBot/1.0; +self-hosted chat)', Accept: accept } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), url).href; continue; }
      if (!r.ok) throw new Error(`The site answered ${r.status}.`);
      const reader = r.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { try { reader.cancel(); } catch { /* stop */ } throw new Error('The feed is too big.'); }
        chunks.push(value);
      }
      return { body: Buffer.concat(chunks.map((c) => Buffer.from(c))), type: r.headers.get('content-type') || '', url };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The site took too long to answer.');
      throw e;
    } finally { clearTimeout(t); }
  }
  throw new Error('Too many redirects.');
}

// ------------------------------------------------------------------ reading RSS / Atom
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m));
const stripTags = (s) => decode(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m) => decode(m)).replace(/\s+/g, ' ').trim();
const esc = (n) => n.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
function tag(block, name) {
  const m = block.match(new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, 'i'));
  return m ? m[1] : '';
}
function attr(block, name, a, where = null) {
  const re = new RegExp(`<${esc(name)}\\b([^>]*)/?>`, 'gi');
  let m;
  while ((m = re.exec(block))) {
    const attrs = m[1];
    if (where && !where(attrs)) continue;
    const v = attrs.match(new RegExp(`\\b${esc(a)}\\s*=\\s*["']([^"']*)["']`, 'i'));
    if (v) return decode(v[1]);
  }
  return '';
}
function parseFeed(xml) {
  const text = String(xml);
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const blocks = text.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  const head = text.slice(0, text.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i) >>> 0 || 4000);
  const title = stripTags(tag(head, 'title')).slice(0, 120);
  const items = blocks.slice(0, 60).map((b) => {
    const link = isAtom ? (attr(b, 'link', 'href', (a) => !/rel=["'](?!alternate)/i.test(a)) || attr(b, 'link', 'href')) : stripTags(tag(b, 'link')) || attr(b, 'link', 'href');
    const id = stripTags(tag(b, 'guid') || tag(b, 'id')) || link;
    const date = Date.parse(stripTags(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'))) || null;
    const rawSummary = tag(b, 'description') || tag(b, 'summary') || tag(b, 'media:description') || tag(b, 'content:encoded') || tag(b, 'content');
    const image = attr(b, 'media:thumbnail', 'url') || attr(b, 'media:content', 'url', (a) => /image|\.(jpe?g|png|webp|gif)/i.test(a)) || attr(b, 'enclosure', 'url', (a) => /image\//i.test(a))
      || (decode(rawSummary).match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || '';
    const source = stripTags(tag(b, 'source')) || '';
    return { id: String(id).slice(0, 500), title: stripTags(tag(b, 'title')).slice(0, 300), link: String(link).trim().slice(0, 1000), date, summary: stripTags(rawSummary).slice(0, 400), image: /^https?:\/\//.test(image) ? image.slice(0, 1000) : '', source: source.slice(0, 80) };
  }).filter((i) => i.title && /^https?:\/\//.test(i.link));
  return { title, items };
}

module.exports = function setupNewsbot(ctx) {
  const { api, app, auth, db, fail, wrap, rateLimit, seal, newId, requireServer, canManageServer, serializeMessage, toChannel, checkMediaToken, emitServerFeeds, searchSteam } = ctx;
  const now = () => Date.now();

  // The bot's account: can't sign in (no password), shows a BOT tag.
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(BOT_ID)) {
    // Someone may already be called "news-bot"; then use the first free name like it.
    let name = 'news-bot';
    for (let i = 2; db.prepare('SELECT 1 FROM users WHERE lower(username) = ?').get(name); i++) name = `news-bot-${i}`;
    db.prepare(`INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, profile, created_at, is_bot) VALUES (?, ?, ?, '', '', ?, ?, 1)`)
      .run(BOT_ID, name, `!${crypto.randomBytes(16).toString('hex')}`, JSON.stringify({ displayName: 'News', bio: 'Posts new articles, videos and updates from the feeds this server follows.', bannerColor: '#5865f2' }), now());
  }

  // ------------------------------------------------------------------ resolving what people typed into a feed URL
  async function feedUrl(kind, query) {
    const q = String(query || '').trim();
    if (!q) fail(400, 'Tell the bot what to follow.');
    if (kind === 'topic') return { url: KINDS.topic.url(q), title: `News about “${q}”` };
    if (kind === 'reddit') { const sub = q.replace(/^https?:\/\/(www\.)?reddit\.com\//i, '').replace(/^\/?r\//i, '').split(/[/?#]/)[0].replace(/[^\w]/g, ''); if (!sub) fail(400, 'Type a subreddit name, like "gaming".'); return { url: KINDS.reddit.url(sub), title: `r/${sub}` }; }
    if (kind === 'github') {
      const m = q.replace(/^https?:\/\/github\.com\//i, '').match(/^([\w.-]+)\/([\w.-]+)/);
      if (!m) fail(400, 'Type it like owner/project (or paste the GitHub link).');
      return { url: KINDS.github.url(`${m[1]}/${m[2].replace(/\.git$/, '')}`), title: `${m[1]}/${m[2]} releases` };
    }
    if (kind === 'steam') {
      let appid = (q.match(/store\.steampowered\.com\/app\/(\d+)/) || q.match(/^(\d{2,10})$/) || [])[1];
      let name = '';
      if (!appid && searchSteam) { const g = (await searchSteam(q)).find((x) => x.id.startsWith('steam:')); if (g) { appid = g.id.slice(6); name = g.name; } }
      if (!appid) fail(400, 'Couldn’t find that game on Steam. Paste its Steam store link.');
      return { url: KINDS.steam.url(appid), title: `${name || `Steam app ${appid}`} news` };
    }
    if (kind === 'youtube') {
      let id = (q.match(/(UC[\w-]{22})/) || [])[1];
      if (!id) {
        const handle = (q.match(/youtube\.com\/(@[\w.-]+)/) || q.match(/^(@[\w.-]+)$/) || [])[1] || (/^[\w.-]+$/.test(q) ? `@${q}` : '');
        if (!handle) fail(400, 'Paste the channel’s link (youtube.com/@name) or its @handle.');
        const page = await safeGet(`https://www.youtube.com/${handle}`, { accept: 'text/html' }).catch(() => null);
        const html = page ? page.body.toString('utf8') : '';
        id = (html.match(/"channelId":"(UC[\w-]{22})"/) || html.match(/channel\/(UC[\w-]{22})/) || [])[1];
        if (!id) fail(400, 'Couldn’t find that YouTube channel.');
      }
      return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, title: '' };
    }
    if (kind === 'rss') return { url: (await assertPublic(q)).href, title: '' };
    fail(400, 'Unknown kind of feed.');
  }
  const itemKey = (i) => crypto.createHash('sha1').update(i.id || i.link).digest('hex');
  const matches = (feed, i) => {
    const words = String(feed.keywords || '').toLowerCase().split(',').map((w) => w.trim()).filter(Boolean);
    if (!words.length) return true;
    const hay = `${i.title} ${i.summary}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  };
  async function fetchFeed(url) {
    const r = await safeGet(url);
    const parsed = parseFeed(r.body.toString('utf8'));
    if (!parsed.items.length && !/<(rss|feed|rdf)[\s>]/i.test(r.body.toString('utf8', 0, 2000))) throw new Error('That address isn’t a news feed.');
    return parsed;
  }

  // ------------------------------------------------------------------ posting
  function post(feed, item) {
    const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(feed.channel_id);
    if (!c || c.type !== 'text') return false;
    const id = newId();
    const embed = { title: item.title, url: item.link, summary: item.summary, image: item.image, source: item.source || feed.title, date: item.date, kind: feed.kind, feedId: feed.id };
    db.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, reply_to, created_at, thread_id) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)')
      .run(id, c.id, BOT_ID, seal({ content: item.title, attachments: [], embed, bot: true }), now());
    toChannel(c).emit('message:new', serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id), c));
    db.prepare('UPDATE feeds SET posted = posted + 1 WHERE id = ?').run(feed.id);
    return true;
  }
  async function check(feed) {
    db.prepare('UPDATE feeds SET last_check = ? WHERE id = ?').run(now(), feed.id);
    try {
      const { items } = await fetchFeed(feed.url);
      const seen = db.prepare('SELECT 1 FROM feed_seen WHERE feed_id = ? AND item_key = ?');
      const mark = db.prepare('INSERT OR IGNORE INTO feed_seen (feed_id, item_key, seen_at) VALUES (?, ?, ?)');
      // Oldest first, so a burst of news arrives in order; anything dated before the feed was added is old news.
      const fresh = items.filter((i) => !seen.get(feed.id, itemKey(i))).sort((a, b) => (a.date || 0) - (b.date || 0));
      let posted = 0;
      for (const i of fresh) {
        mark.run(feed.id, itemKey(i), now());
        if (i.date && i.date < feed.created_at - 3600000) continue;
        if (!matches(feed, i) || posted >= MAX_POSTS_PER_CHECK) continue;
        if (post(feed, i)) posted++;
      }
      // Remember at most the newest 600 items per feed.
      db.prepare('DELETE FROM feed_seen WHERE feed_id = ? AND item_key NOT IN (SELECT item_key FROM feed_seen WHERE feed_id = ? ORDER BY seen_at DESC LIMIT 600)').run(feed.id, feed.id);
      db.prepare('UPDATE feeds SET last_ok = ?, last_error = NULL WHERE id = ?').run(now(), feed.id);
      return posted;
    } catch (e) {
      db.prepare('UPDATE feeds SET last_error = ? WHERE id = ?').run(String(e.message || e).slice(0, 200), feed.id);
      return 0;
    }
  }
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const due = db.prepare('SELECT * FROM feeds WHERE paused = 0 AND (last_check IS NULL OR last_check < ?) ORDER BY last_check LIMIT 20').all(now() - EVERY_MS);
      for (const f of due) await check(f);
    } finally { running = false; }
  }
  setInterval(() => { tick().catch(() => {}); }, 60000).unref();
  setTimeout(() => { tick().catch(() => {}); }, 20000).unref();

  // ------------------------------------------------------------------ API (server admins)
  const feedOut = (f) => ({ id: f.id, channelId: f.channel_id, kind: f.kind, kindName: (KINDS[f.kind] || {}).name || f.kind, query: f.query, title: f.title, keywords: f.keywords, posted: f.posted, paused: !!f.paused, lastCheck: f.last_check, lastOk: f.last_ok, lastError: f.last_error, createdAt: f.created_at });
  const requireManager = (serverId, uid) => { const s = requireServer(serverId, uid); if (!canManageServer(s, uid)) fail(403, 'Only people who can manage this server can set up the news bot.'); return s; };
  api.get('/servers/:id/feeds', auth, (req, res) => {
    const s = requireManager(req.params.id, req.userId);
    res.json(db.prepare('SELECT * FROM feeds WHERE server_id = ? ORDER BY created_at').all(s.id).map(feedOut));
  });
  // Try a feed without saving it: shows the newest items so people can see it's the right thing.
  api.post('/servers/:id/feeds/preview', auth, wrap(async (req, res) => {
    requireManager(req.params.id, req.userId);
    rateLimit('feedpreview:' + req.userId, 20, 10 * 60000);
    const b = req.body || {};
    const { url, title } = await feedUrl(b.kind, b.query);
    let parsed;
    try { parsed = await fetchFeed(url); } catch (e) { fail(400, `Couldn’t read it: ${e.message}`); }
    res.json({ title: title || parsed.title, items: parsed.items.slice(0, 5).map((i) => ({ title: i.title, link: i.link, date: i.date, image: i.image })) });
  }));
  api.post('/servers/:id/feeds', auth, wrap(async (req, res) => {
    const s = requireManager(req.params.id, req.userId);
    rateLimit('feedadd:' + req.userId, 20, 3600000);
    const b = req.body || {};
    if (!KINDS[b.kind]) fail(400, 'Unknown kind of feed.');
    const c = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(String(b.channelId || ''), s.id);
    if (!c || c.type !== 'text') fail(400, 'Pick a text channel for the posts.');
    if (db.prepare('SELECT COUNT(*) n FROM feeds WHERE server_id = ?').get(s.id).n >= 25) fail(400, 'Up to 25 feeds per server.');
    const { url, title } = await feedUrl(b.kind, b.query);
    let parsed;
    try { parsed = await fetchFeed(url); } catch (e) { fail(400, `Couldn’t read it: ${e.message}`); }
    const id = newId();
    const t = now();
    db.prepare('INSERT INTO feeds (id, server_id, channel_id, kind, query, url, title, keywords, created_by, created_at, last_check, last_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, s.id, c.id, b.kind, String(b.query).trim().slice(0, 300), url, String(b.title || title || parsed.title || KINDS[b.kind].name).trim().slice(0, 100), String(b.keywords || '').slice(0, 300), req.userId, t, t, t);
    // Everything already in the feed counts as seen: only news from now on gets posted.
    const mark = db.prepare('INSERT OR IGNORE INTO feed_seen (feed_id, item_key, seen_at) VALUES (?, ?, ?)');
    db.transaction(() => parsed.items.forEach((i) => mark.run(id, itemKey(i), t)))();
    const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(id);
    // Optional: post the newest item right away so people see what it'll look like.
    if (b.postLatest && parsed.items.length) {
      const newest = [...parsed.items].filter((i) => matches(feed, i)).sort((x, y) => (y.date || 0) - (x.date || 0))[0];
      if (newest) post(feed, newest);
    }
    emitServerFeeds(s.id);
    res.json(feedOut(db.prepare('SELECT * FROM feeds WHERE id = ?').get(id)));
  }));
  api.patch('/feeds/:id', auth, (req, res) => {
    const f = db.prepare('SELECT * FROM feeds WHERE id = ?').get(req.params.id);
    if (!f) fail(404, 'No such feed.');
    requireManager(f.server_id, req.userId);
    const b = req.body || {};
    if (b.paused !== undefined) db.prepare('UPDATE feeds SET paused = ? WHERE id = ?').run(b.paused ? 1 : 0, f.id);
    if (b.keywords !== undefined) db.prepare('UPDATE feeds SET keywords = ? WHERE id = ?').run(String(b.keywords || '').slice(0, 300), f.id);
    if (b.title !== undefined) db.prepare('UPDATE feeds SET title = ? WHERE id = ?').run(String(b.title || '').trim().slice(0, 100) || f.title, f.id);
    if (b.channelId !== undefined) {
      const c = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(String(b.channelId), f.server_id);
      if (!c || c.type !== 'text') fail(400, 'Pick a text channel.');
      db.prepare('UPDATE feeds SET channel_id = ? WHERE id = ?').run(c.id, f.id);
    }
    res.json(feedOut(db.prepare('SELECT * FROM feeds WHERE id = ?').get(f.id)));
  });
  api.post('/feeds/:id/check', auth, wrap(async (req, res) => {
    const f = db.prepare('SELECT * FROM feeds WHERE id = ?').get(req.params.id);
    if (!f) fail(404, 'No such feed.');
    requireManager(f.server_id, req.userId);
    rateLimit('feedcheck:' + req.userId, 10, 10 * 60000);
    const posted = await check(f);
    res.json({ posted, feed: feedOut(db.prepare('SELECT * FROM feeds WHERE id = ?').get(f.id)) });
  }));
  api.delete('/feeds/:id', auth, (req, res) => {
    const f = db.prepare('SELECT * FROM feeds WHERE id = ?').get(req.params.id);
    if (!f) fail(404, 'No such feed.');
    requireManager(f.server_id, req.userId);
    db.prepare('DELETE FROM feeds WHERE id = ?').run(f.id);
    res.json({ ok: true });
  });

  // Pictures in bot posts come through this server (signed links), so news sites don't see members' IPs.
  app.get(['/media/news', '/media/news/:key'], wrap(async (req, res) => {
    if (!checkMediaToken(req.query.t)) return res.status(403).end();
    rateLimit('newsimg:' + req.ip, 300, 60000);
    try {
      const r = await safeGet(String(req.query.u || ''), { accept: 'image/*', max: 8 * 1024 * 1024 });
      if (!/^image\/(png|jpe?g|gif|webp|avif)/i.test(r.type)) return res.status(415).end();
      res.setHeader('Content-Type', r.type.split(';')[0]);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.end(r.body);
    } catch { res.status(404).end(); }
  }));

  return { BOT_ID, parseFeed, KINDS: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.name])) };
};
module.exports.parseFeed = parseFeed;
module.exports.privateIp = privateIp;
