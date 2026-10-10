// The news bot: follows things people care about and posts new items into a server channel.
//
// Sources (no API keys needed): a topic search (Google News), a YouTube channel, a subreddit, a Steam game's
// news, a GitHub project's releases, or any RSS/Atom feed. Each feed checks every 10 minutes.
// Only NEW things get posted: when a feed is added, everything already in it is marked as seen (the newest one
// can be posted right away to show it works), and items more than 3 days old are skipped even if the source
// shuffles them back to the top.
//
// Bot posts are public news, so they're stored like older messages (protected by the server's at-rest
// encryption, not end-to-end) and the app labels them that way. Everything people write stays end-to-end.
const crypto = require('crypto');
const netguard = require('./netguard');

const BOT_ID = 'newsbot00000000000001';
const KINDS = {
  topic: { name: 'Topic search', url: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en` },
  youtube: { name: 'YouTube channel' },
  reddit: { name: 'Subreddit', url: (q) => `https://www.reddit.com/r/${encodeURIComponent(q.replace(/^\/?r\//i, '').replace(/[^\w]/g, ''))}/new/.rss` },
  steam: { name: 'Steam game news', url: (appid) => `https://store.steampowered.com/feeds/news/app/${appid}/` },
  github: { name: 'GitHub releases', url: (repo) => `https://github.com/${repo}/releases.atom` },
  rss: { name: 'RSS / Atom feed', url: (u) => u },
};
const EVERY_MS = 10 * 60000;
// News older than this when it first shows up in a feed is skipped (sources sometimes shuffle old items back
// to the top). Measured from now, not from when the feed was added: sites like Google News often list an
// article hours after its publish time, and those are still news.
const STALE_MS = 3 * 86400000;
const MAX_POSTS_PER_CHECK = 3;

// ------------------------------------------------------------------ fetching safely
// Feeds are fetched by this server, so addresses inside your network (the VPS itself, the router, cloud
// metadata) are refused, the connection goes to the very address that was checked (no DNS rebinding), and
// every redirect is checked again. See netguard.js.
const allowPrivate = () => process.env.FEED_ALLOW_PRIVATE === '1'; // tests only: they serve feeds from localhost
const privateIp = netguard.blockedIp;
const assertPublic = (urlStr) => netguard.checkPublicUrl(urlStr, { allowPrivate: allowPrivate() });
async function safeGet(urlStr, { accept = 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.5, */*;q=0.1', max = 3 * 1024 * 1024, timeout = 12000 } = {}) {
  let r;
  try {
    r = await netguard.request(urlStr, { allowPrivate: allowPrivate(), maxRedirects: 4, timeout, maxBytes: max, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HearthNewsBot/1.0; +self-hosted chat)', Accept: accept } });
  } catch (e) {
    if (e.code === 'TOO_BIG') throw new Error('The feed is too big.');
    throw e;
  }
  if (!r.ok) throw new Error(`The site answered ${r.status}.`);
  return { body: r.body, type: r.type, url: r.url };
}

// ------------------------------------------------------------------ reading RSS / Atom
// Feeds are other people's text, often full of HTML (patch notes, news summaries) and sometimes broken, so
// every step here takes time in proportion to the feed's size: nothing scans "to the end" again for each tag,
// and big items are trimmed first. (Before 1.24.1 some feeds took up to a minute to read, freezing the
// server.) On top of that, feeds are read in a worker thread with a time limit (see parseInWorker below).
const MAX_ITEM_CHARS = 200000; // one item; longer ones are cut (the summary keeps only 400 characters anyway)
const MAX_SUMMARY_CHARS = 30000;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const codePoint = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
const entities = (s) => s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,9}|[a-z]{1,12});/gi, (m, e) => (e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m));
// <![CDATA[ ... ]]> → its contents (an unclosed one runs to the end).
function cdata(s) {
  let out = ''; let i = 0;
  for (;;) {
    const a = s.indexOf('<![CDATA[', i);
    if (a === -1) return out + s.slice(i);
    const b = s.indexOf(']]>', a + 9);
    out += s.slice(i, a) + s.slice(a + 9, b === -1 ? s.length : b);
    if (b === -1) return out;
    i = b + 3;
  }
}
const decode = (s) => entities(cdata(String(s || '')));
// Drops <script>…</script> and <style>…</style> (an unclosed one drops the rest).
function dropBlocks(s, name) {
  const open = new RegExp(`<${name}\\b`, 'gi'); const close = new RegExp(`</${name}\\s*>`, 'gi');
  let out = ''; let i = 0; let m;
  open.lastIndex = 0;
  while ((m = open.exec(s))) {
    close.lastIndex = m.index;
    const c = close.exec(s);
    out += s.slice(i, m.index) + ' ';
    if (!c) return out;
    i = close.lastIndex; open.lastIndex = i;
  }
  return out + s.slice(i);
}
const stripTags = (s) => entities(dropBlocks(dropBlocks(decode(s), 'script'), 'style').replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const esc = (n) => n.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
// The text inside the first <name …>…</name> (or up to the end if it's never closed).
function tag(block, name) {
  const m = new RegExp(`<${esc(name)}(?:\\s[^<>]*)?>`, 'i').exec(block);
  if (!m) return '';
  const from = m.index + m[0].length;
  const close = new RegExp(`</${esc(name)}\\s*>`, 'gi');
  close.lastIndex = from;
  const c = close.exec(block);
  return block.slice(from, c ? c.index : block.length);
}
function attr(block, name, a, where = null) {
  const re = new RegExp(`<${esc(name)}\\b([^<>]*)>`, 'gi');
  const want = new RegExp(`(?:^|\\s)${esc(a)}\\s*=\\s*["']([^"'<>]*)["']`, 'i');
  let m;
  while ((m = re.exec(block))) {
    const attrs = m[1];
    if (where && !where(attrs)) continue;
    const v = want.exec(attrs);
    if (v) return decode(v[1]);
  }
  return '';
}
// The <item>s (or Atom <entry>s): each runs to its closing tag, or to the next item if it's never closed.
function blocksOf(text, name, max = 60) {
  const openRe = new RegExp(`<${name}[\\s>/]`, 'gi');
  const opens = []; let m;
  while (opens.length <= max && (m = openRe.exec(text))) opens.push(m.index);
  const closeRe = new RegExp(`</${name}\\s*>`, 'i');
  return opens.slice(0, max).map((start, k) => {
    const seg = text.slice(start, Math.min(k + 1 < opens.length ? opens[k + 1] : text.length, start + MAX_ITEM_CHARS));
    const c = closeRe.exec(seg);
    return c ? seg.slice(0, c.index + c[0].length) : seg;
  });
}
function parseFeed(xml) {
  const text = String(xml);
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const blocks = blocksOf(text, isAtom ? 'entry' : 'item');
  const first = text.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = text.slice(0, first > 0 ? Math.min(first, 20000) : 4000);
  const title = stripTags(tag(head, 'title')).slice(0, 120);
  const items = blocks.map((b) => {
    const link = isAtom ? (attr(b, 'link', 'href', (a) => !/rel=["'](?!alternate)/i.test(a)) || attr(b, 'link', 'href')) : stripTags(tag(b, 'link')) || attr(b, 'link', 'href');
    const id = stripTags(tag(b, 'guid') || tag(b, 'id')) || link;
    const date = Date.parse(stripTags(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'))) || null;
    const rawSummary = (tag(b, 'description') || tag(b, 'summary') || tag(b, 'media:description') || tag(b, 'content:encoded') || tag(b, 'content')).slice(0, MAX_SUMMARY_CHARS);
    const image = attr(b, 'media:thumbnail', 'url') || attr(b, 'media:content', 'url', (a) => /image|\.(jpe?g|png|webp|gif)/i.test(a)) || attr(b, 'enclosure', 'url', (a) => /image\//i.test(a))
      || (/<img\b[^<>]*?\ssrc=["']([^"'<>]+)["']/i.exec(decode(rawSummary)) || [])[1] || '';
    const source = stripTags(tag(b, 'source')) || '';
    return { id: String(id).slice(0, 500), title: stripTags(tag(b, 'title')).slice(0, 300), link: String(link).trim().slice(0, 1000), date, summary: stripTags(rawSummary).slice(0, 400), image: /^https?:\/\//.test(image) ? image.slice(0, 1000) : '', source: source.slice(0, 80) };
  }).filter((i) => i.title && /^https?:\/\//.test(i.link));
  return { title, items };
}

// Feeds are read in a worker thread, so even a feed that's slow to read can't hold up chat, calls or anything
// else; one that takes longer than PARSE_LIMIT_MS is given up on (the worker is replaced).
const PARSE_LIMIT_MS = +process.env.FEED_PARSE_LIMIT_MS || 5000;
let parser = null; let parseSeq = 0;
const parsing = new Map(); // id -> { resolve, reject }
function parserWorker() {
  if (parser) return parser;
  const { Worker } = require('worker_threads');
  parser = new Worker(__filename, { workerData: { feedParser: true } });
  parser.on('message', ({ id, ok, err }) => { const p = parsing.get(id); if (!p) return; parsing.delete(id); if (err) p.reject(new Error(err)); else p.resolve(ok); });
  const fail = (e) => { parser = null; for (const [, p] of parsing) p.reject(e); parsing.clear(); };
  parser.on('error', fail);
  parser.on('exit', () => fail(new Error('The feed reader stopped.')));
  parser.unref(); // after the listeners (adding one re-arms it): never keeps the process alive by itself
  return parser;
}
function parseInWorker(xml) {
  return new Promise((resolve, reject) => {
    const id = ++parseSeq;
    const w = parserWorker();
    const timer = setTimeout(() => {
      if (!parsing.has(id)) return;
      parsing.delete(id);
      reject(new Error('That feed takes too long to read.'));
      if (parser === w) { parser = null; w.terminate().catch(() => {}); }
    }, PARSE_LIMIT_MS);
    parsing.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    w.postMessage({ id, xml: String(xml) });
  });
}
{
  const { isMainThread, parentPort, workerData } = require('worker_threads');
  if (!isMainThread && workerData && workerData.feedParser) {
    parentPort.on('message', ({ id, xml }) => {
      try { parentPort.postMessage({ id, ok: parseFeed(xml) }); } catch (e) { parentPort.postMessage({ id, err: String(e.message || e) }); }
    });
  }
}

module.exports = function setupNewsbot(ctx) {
  const { api, app, auth, db, fail, wrap, rateLimit, seal, newId, requireServer, canManageServer, serializeMessage, toChannel, checkMediaToken, emitServerFeeds, searchSteam, notifyUser } = ctx;
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
    if (kind === 'rss') {
      try { return { url: (await assertPublic(q)).href, title: '' }; } catch (e) { fail(400, e.message); }
    }
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
    const parsed = await parseInWorker(r.body.toString('utf8'));
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
        if (i.date && i.date < now() - STALE_MS) continue;
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
  setInterval(() => { tick().catch(() => {}); userTick().catch(() => {}); }, 60000).unref();
  setTimeout(() => { tick().catch(() => {}); userTick().catch(() => {}); }, 20000).unref();

  // ------------------------------------------------------------------ personal trackers ("Updates")
  // The same feeds, followed by one person for themselves instead of posted to a server. Found items go to their
  // Updates page (and a notification if they want one). Like server feeds, only things published after you
  // start tracking show up — never a backlog of old news.
  const USER_EVERY_MS = 30 * 60000;
  const USER_MAX_TRACKERS = 20;
  const USER_MAX_PER_CHECK = 10;
  const trackerOut = (f, unread = 0) => ({ id: f.id, kind: f.kind, kindName: (KINDS[f.kind] || {}).name || f.kind, query: f.query, title: f.title, keywords: f.keywords,
    notify: !!f.notify, paused: !!f.paused, found: f.found, unread, lastCheck: f.last_check, lastOk: f.last_ok, lastError: f.last_error, createdAt: f.created_at });
  const itemOut = (r) => { let d = {}; try { d = JSON.parse(r.data); } catch { /* */ } return { id: r.id, feedId: r.feed_id, ...d, foundAt: r.created_at, read: !!r.read_at }; };
  const unreadCount = (uid) => db.prepare('SELECT COUNT(*) n FROM user_feed_items WHERE user_id = ? AND new = 1 AND read_at IS NULL').get(uid).n;
  async function checkUserFeed(feed) {
    db.prepare('UPDATE user_feeds SET last_check = ? WHERE id = ?').run(now(), feed.id);
    try {
      const { items } = await fetchFeed(feed.url);
      const seen = db.prepare('SELECT 1 FROM user_feed_items WHERE feed_id = ? AND item_key = ?');
      // "new" = shown on the Updates page; the rest are only remembered so they never show up later.
      const add = db.prepare('INSERT OR IGNORE INTO user_feed_items (id, feed_id, user_id, item_key, data, new, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const fresh = items.filter((i) => !seen.get(feed.id, itemKey(i))).sort((a, b) => (a.date || 0) - (b.date || 0));
      const found = [];
      db.transaction(() => {
        for (const i of fresh) {
          const show = !(i.date && i.date < now() - STALE_MS) && matches(feed, i) && found.length < USER_MAX_PER_CHECK;
          const data = show ? JSON.stringify({ title: i.title, url: i.link, summary: i.summary, image: i.image, source: i.source || feed.title, date: i.date }) : '{}';
          add.run(newId(), feed.id, feed.user_id, itemKey(i), data, show ? 1 : 0, now());
          if (show) found.push(i);
        }
        db.prepare('UPDATE user_feeds SET last_ok = ?, last_error = NULL, found = found + ? WHERE id = ?').run(now(), found.length, feed.id);
        // Remember at most the newest 600 items per tracker.
        db.prepare('DELETE FROM user_feed_items WHERE feed_id = ? AND id NOT IN (SELECT id FROM user_feed_items WHERE feed_id = ? ORDER BY created_at DESC LIMIT 600)').run(feed.id, feed.id);
      })();
      if (found.length && notifyUser) {
        notifyUser(feed.user_id, {
          feedId: feed.id, title: feed.title, count: found.length, unread: unreadCount(feed.user_id), notify: !!feed.notify,
          first: { title: found[found.length - 1].title, url: found[found.length - 1].link },
        });
      }
      return found.length;
    } catch (e) {
      db.prepare('UPDATE user_feeds SET last_error = ? WHERE id = ?').run(String(e.message || e).slice(0, 200), feed.id);
      return 0;
    }
  }
  let userRunning = false;
  async function userTick() {
    if (userRunning) return;
    userRunning = true;
    try {
      const due = db.prepare('SELECT * FROM user_feeds WHERE paused = 0 AND (last_check IS NULL OR last_check < ?) ORDER BY last_check LIMIT 30').all(now() - USER_EVERY_MS);
      for (const f of due) await checkUserFeed(f);
    } finally { userRunning = false; }
  }
  const myFeed = (id, uid) => { const f = db.prepare('SELECT * FROM user_feeds WHERE id = ? AND user_id = ?').get(String(id), uid); if (!f) fail(404, 'No such tracker.'); return f; };
  const unreadByFeed = (uid) => Object.fromEntries(db.prepare('SELECT feed_id, COUNT(*) n FROM user_feed_items WHERE user_id = ? AND new = 1 AND read_at IS NULL GROUP BY feed_id').all(uid).map((r) => [r.feed_id, r.n]));
  api.get('/me/trackers', auth, (req, res) => {
    const unread = unreadByFeed(req.userId);
    const before = Math.floor(+req.query.before) || Number.MAX_SAFE_INTEGER;
    const feed = typeof req.query.feed === 'string' && req.query.feed ? req.query.feed : null;
    const items = db.prepare(`SELECT * FROM user_feed_items WHERE user_id = ? AND new = 1 AND created_at < ? ${feed ? 'AND feed_id = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 60`).all(...[req.userId, before, ...(feed ? [feed] : [])]);
    res.json({ trackers: db.prepare('SELECT * FROM user_feeds WHERE user_id = ? ORDER BY created_at').all(req.userId).map((f) => trackerOut(f, unread[f.id] || 0)),
      items: items.map(itemOut), unread: unreadCount(req.userId), kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.name])) });
  });
  api.post('/me/trackers/preview', auth, wrap(async (req, res) => {
    rateLimit('trackpreview:' + req.userId, 20, 10 * 60000);
    const b = req.body || {};
    if (typeof b.kind !== 'string' || !Object.hasOwn(KINDS, b.kind)) fail(400, 'Unknown kind of tracker.');
    const { url, title } = await feedUrl(b.kind, b.query);
    let parsed;
    try { parsed = await fetchFeed(url); } catch (e) { fail(400, `Couldn’t read it: ${e.message}`); }
    res.json({ title: title || parsed.title, items: parsed.items.slice(0, 5).map((i) => ({ title: i.title, url: i.link, date: i.date, image: i.image, source: i.source })) });
  }));
  api.post('/me/trackers', auth, wrap(async (req, res) => {
    rateLimit('trackadd:' + req.userId, 20, 3600000);
    const b = req.body || {};
    if (typeof b.kind !== 'string' || !Object.hasOwn(KINDS, b.kind)) fail(400, 'Unknown kind of tracker.');
    if (db.prepare('SELECT COUNT(*) n FROM user_feeds WHERE user_id = ?').get(req.userId).n >= USER_MAX_TRACKERS) fail(400, `You can track up to ${USER_MAX_TRACKERS} things.`);
    const { url, title } = await feedUrl(b.kind, b.query);
    if (db.prepare('SELECT 1 FROM user_feeds WHERE user_id = ? AND url = ?').get(req.userId, url)) fail(409, 'You’re already tracking that.');
    let parsed;
    try { parsed = await fetchFeed(url); } catch (e) { fail(400, `Couldn’t read it: ${e.message}`); }
    const id = newId(); const t = now();
    db.transaction(() => {
      db.prepare('INSERT INTO user_feeds (id, user_id, kind, query, url, title, keywords, notify, created_at, last_check, last_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, req.userId, b.kind, String(b.query).trim().slice(0, 300), url, String(b.title || title || parsed.title || KINDS[b.kind].name).trim().slice(0, 100), String(b.keywords || '').slice(0, 300), b.notify === false ? 0 : 1, t, t, t);
      // What's already out there counts as seen: only news from now on shows up.
      const add = db.prepare("INSERT OR IGNORE INTO user_feed_items (id, feed_id, user_id, item_key, data, new, created_at) VALUES (?, ?, ?, ?, '{}', 0, ?)");
      parsed.items.forEach((i) => add.run(newId(), id, req.userId, itemKey(i), t));
    })();
    res.json(trackerOut(db.prepare('SELECT * FROM user_feeds WHERE id = ?').get(id)));
  }));
  api.patch('/me/trackers/:id', auth, (req, res) => {
    const f = myFeed(req.params.id, req.userId);
    const b = req.body || {};
    if (b.paused !== undefined) db.prepare('UPDATE user_feeds SET paused = ? WHERE id = ?').run(b.paused ? 1 : 0, f.id);
    if (b.notify !== undefined) db.prepare('UPDATE user_feeds SET notify = ? WHERE id = ?').run(b.notify ? 1 : 0, f.id);
    if (b.keywords !== undefined) db.prepare('UPDATE user_feeds SET keywords = ? WHERE id = ?').run(String(b.keywords || '').slice(0, 300), f.id);
    if (b.title !== undefined) db.prepare('UPDATE user_feeds SET title = ? WHERE id = ?').run(String(b.title || '').trim().slice(0, 100) || f.title, f.id);
    res.json(trackerOut(db.prepare('SELECT * FROM user_feeds WHERE id = ?').get(f.id), unreadByFeed(req.userId)[f.id] || 0));
  });
  api.post('/me/trackers/:id/check', auth, wrap(async (req, res) => {
    const f = myFeed(req.params.id, req.userId);
    rateLimit('trackcheck:' + req.userId, 10, 10 * 60000);
    const found = await checkUserFeed(f);
    res.json({ found, tracker: trackerOut(db.prepare('SELECT * FROM user_feeds WHERE id = ?').get(f.id), unreadByFeed(req.userId)[f.id] || 0) });
  }));
  api.delete('/me/trackers/:id', auth, (req, res) => {
    const f = myFeed(req.params.id, req.userId);
    db.prepare('DELETE FROM user_feeds WHERE id = ?').run(f.id);
    res.json({ ok: true, unread: unreadCount(req.userId) });
  });
  // Mark items read: some ids, one tracker, or everything.
  api.post('/me/tracker-items/read', auth, (req, res) => {
    const b = req.body || {};
    const t = now();
    if (Array.isArray(b.ids)) {
      const st = db.prepare('UPDATE user_feed_items SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL');
      db.transaction(() => b.ids.slice(0, 500).forEach((id) => st.run(t, String(id), req.userId)))();
    } else if (typeof b.feedId === 'string') db.prepare('UPDATE user_feed_items SET read_at = ? WHERE feed_id = ? AND user_id = ? AND read_at IS NULL').run(t, b.feedId, req.userId);
    else if (b.all === true) db.prepare('UPDATE user_feed_items SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(t, req.userId);
    res.json({ unread: unreadCount(req.userId) });
  });

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
    if (typeof b.kind !== 'string' || !Object.hasOwn(KINDS, b.kind)) fail(400, 'Unknown kind of feed.');
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
    if (b.paused !== undefined) { db.prepare('UPDATE feeds SET paused = ? WHERE id = ?').run(b.paused ? 1 : 0, f.id); emitServerFeeds(f.server_id); }
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
    emitServerFeeds(f.server_id);
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

  return { BOT_ID, parseFeed, KINDS: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.name])), unreadUpdates: unreadCount };
};
module.exports.parseFeed = parseFeed;
module.exports.BOT_ID = BOT_ID;
module.exports.parseInWorker = parseInWorker;
module.exports.privateIp = privateIp;
