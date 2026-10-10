// Message search: GET /api/search/messages.
//
// Message bodies are end-to-end encrypted, so the server can't match words. The app sends only metadata
// filters (where, from whom, between which times), gets the matching messages back as ciphertext, newest
// first, and looks for the search words itself after decrypting each page. The words never reach the server.
//
//   scope    c:<channelId> | d:<dmId> | s:<serverId> | all (default)
//   from     a user id: only their messages
//   before   epoch ms: only messages sent before this time
//   after    epoch ms: only messages sent at or after this time
//   cursor   nextCursor from the previous page
//   limit    page size, 1-200 (default 100)
//
// Access is worked out again on every request (servers you're in, channels you can view, DMs you're part
// of), so a scope or cursor kept from earlier can't reach anything you've since lost. Work is bounded: one
// page is at most 200 messages, scope=all and s: look at no more than MAX_SOURCES conversations per page
// (those with the newest matching messages), and each person gets 60 requests a minute.

// Newest-first positions inside one conversation, strictly between lo and hi. Each is a range scan over a
// covering index (see "v17 (search)" in db.js), so it never reads message rows or sorts. The index is named:
// with statistics the planner sometimes picks the channel index for from: and filters row by row, which for
// a rare author means reading the whole channel.
const RANGE = 'AND (created_at, id) < (?, ?) AND (created_at, id) > (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?';
const SQL = {
  c: `SELECT created_at AS t, id FROM messages INDEXED BY idx_messages_channel_time WHERE channel_id = ? ${RANGE}`,
  ca: `SELECT created_at AS t, id FROM messages INDEXED BY idx_messages_channel_author_time WHERE channel_id = ? AND author_id = ? ${RANGE}`,
  d: `SELECT created_at AS t, id FROM dm_messages INDEXED BY idx_dm_messages_time WHERE dm_id = ? ${RANGE}`,
  da: `SELECT created_at AS t, id FROM dm_messages INDEXED BY idx_dm_messages_author_time WHERE dm_id = ? AND author_id = ? ${RANGE}`,
};

module.exports = function setupSearch(ctx) {
  const { api, auth, db, fail, rateLimit, canIn, PM, requireServer, requireChannel, requireDm, serializeMessage, serializeDmMessage, reactionsFor } = ctx;
  const DEFAULT_LIMIT = 100;
  const MAX_LIMIT = 200;
  const MAX_SOURCES = 100;
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  const SCOPE = /^(all|[cds]:[A-Za-z0-9_-]{1,64})$/;

  // A position in the results is [createdAt, id]. Results are ordered by it, newest first; the id breaks ties
  // between messages sent in the same millisecond, so the order (and so paging) is always the same.
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const TOP = [Number.MAX_SAFE_INTEGER, '']; // above every message
  const BOTTOM = [-1, '']; // below every message

  // The cursor is the position of the last message on the previous page (base64url JSON). It only says where
  // to carry on: what may be read is decided by the access checks, so editing it can't reach anything new.
  const encodeCursor = (p) => Buffer.from(JSON.stringify(p)).toString('base64url');
  function decodeCursor(s) {
    const bad = () => fail(400, 'That search can’t be continued. Start it again.', 'bad_cursor');
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{4,200}$/.test(s)) bad();
    let p = null;
    try { p = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { /* checked below */ }
    if (!Array.isArray(p) || p.length !== 2 || !Number.isSafeInteger(p[0]) || p[0] < 0 || typeof p[1] !== 'string' || !ID.test(p[1])) bad();
    return p;
  }
  function timeParam(v, name) {
    if (v === undefined || v === '') return null;
    if (typeof v !== 'string' || !/^\d{1,16}$/.test(v) || !Number.isSafeInteger(Number(v))) fail(400, `${name} must be a time in milliseconds.`, 'bad_query');
    return Number(v);
  }

  const positions = (src, from, hi, lo, n) => db.prepare(SQL[src.kind + (from ? 'a' : '')])
    .all(src.id, ...(from ? [from] : []), hi[0], hi[1], lo[0], lo[1], n).map((r) => [r.t, r.id]);

  // The conversations a request may read. Single channels and DMs are checked up front (404 like the history
  // endpoints); channels found through s: or all are checked one by one, only as far as they're needed.
  function sources(scope, uid, from) {
    if (scope === 'all') {
      const chans = db.prepare(`SELECT c.* FROM channels c JOIN members m ON m.server_id = c.server_id
        WHERE m.user_id = ? AND c.type = 'text'`).all(uid).map((c) => ({ kind: 'c', id: c.id, channel: c, check: true }));
      const dms = db.prepare('SELECT id, user_a, user_b FROM dm_channels WHERE user_a = ? OR user_b = ?').all(uid, uid)
        .filter((d) => !from || from === d.user_a || from === d.user_b).map((d) => ({ kind: 'd', id: d.id }));
      return [...chans, ...dms];
    }
    const [kind, id] = [scope[0], scope.slice(2)];
    if (kind === 'c') { const c = requireChannel(id, uid); return [{ kind: 'c', id: c.id, channel: c }]; }
    if (kind === 'd') { const d = requireDm(id, uid); return !from || from === d.user_a || from === d.user_b ? [{ kind: 'd', id: d.id }] : []; }
    const s = requireServer(id, uid);
    return db.prepare("SELECT * FROM channels WHERE server_id = ? AND type = 'text'").all(s.id).map((c) => ({ kind: 'c', id: c.id, channel: c, check: true }));
  }

  api.get('/search/messages', auth, (req, res) => {
    rateLimit('search:' + req.userId, 60, 60000);
    const q = req.query;
    const uid = req.userId;
    const scope = q.scope === undefined || q.scope === '' ? 'all' : q.scope;
    if (typeof scope !== 'string' || !SCOPE.test(scope)) fail(400, 'Unknown search scope. Use c:<channel>, d:<dm>, s:<server> or all.', 'bad_query');
    let from = null;
    if (q.from !== undefined && q.from !== '') {
      if (typeof q.from !== 'string' || !ID.test(q.from)) fail(400, 'from must be a user id.', 'bad_query');
      from = q.from;
    }
    const before = timeParam(q.before, 'before');
    const after = timeParam(q.after, 'after');
    let limit = q.limit === undefined ? DEFAULT_LIMIT : parseInt(q.limit, 10);
    if (!Number.isFinite(limit)) limit = DEFAULT_LIMIT;
    limit = Math.max(1, Math.min(MAX_LIMIT, limit));
    // Everything returned lies strictly between lo and hi.
    let hi = q.cursor !== undefined ? decodeCursor(q.cursor) : TOP;
    if (before !== null && cmp([before, ''], hi) < 0) hi = [before, ''];
    const lo = after !== null ? [after, ''] : BOTTOM;

    // Each conversation's newest matching message (one index lookup each), newest first; empty ones drop out.
    const servers = new Map();
    const serverRow = (id) => { if (!servers.has(id)) servers.set(id, db.prepare('SELECT * FROM servers WHERE id = ?').get(id)); return servers.get(id); };
    const live = [];
    for (const src of sources(scope, uid, from)) {
      const top = positions(src, from, hi, lo, 1)[0];
      if (top) live.push({ ...src, top });
    }
    live.sort((a, b) => cmp(b.top, a.top));

    // Keep the MAX_SOURCES most recently active ones the caller can view. When more exist, nothing at or below
    // the newest message of the first one left out is returned yet: the next page picks the conversations again
    // from its cursor, so those come in their turn and paging never skips a message.
    const chosen = [];
    let floor = lo;
    for (const src of live) {
      if (src.check && !canIn(serverRow(src.channel.server_id), src.channel, uid, PM.VIEW_CHANNEL)) continue;
      if (chosen.length === MAX_SOURCES) { floor = src.top; break; }
      chosen.push(src);
    }

    // Merge the conversations newest first. Once a full page is in hand, a conversation whose newest message is
    // older than the page's last one can't change it, and neither can any after it.
    const need = limit + 1;
    let best = [];
    for (const src of chosen) {
      if (best.length >= need && cmp(src.top, best[need - 1].p) < 0) break;
      const got = positions(src, from, hi, floor, need).map((p) => ({ p, src }));
      best = best.concat(got).sort((a, b) => cmp(b.p, a.p)).slice(0, need);
    }
    const page = best.slice(0, limit);
    const more = best.length > limit || floor !== lo;

    // The messages themselves, serialized exactly like the history endpoints (so the app decrypts them as usual).
    const load = (table, ids) => (ids.length ? db.prepare(`SELECT * FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : []);
    const rows = new Map();
    load('messages', page.filter((x) => x.src.kind === 'c').map((x) => x.p[1])).forEach((r) => rows.set('c' + r.id, r));
    load('dm_messages', page.filter((x) => x.src.kind === 'd').map((x) => x.p[1])).forEach((r) => rows.set('d' + r.id, r));
    const reactions = reactionsFor(page.map((x) => x.p[1]));
    const messages = [];
    for (const { p, src } of page) {
      const row = rows.get(src.kind + p[1]);
      if (row) messages.push(src.kind === 'c' ? serializeMessage(row, src.channel, reactions) : serializeDmMessage(row, reactions));
    }
    res.json({ messages, nextCursor: more && page.length ? encodeCursor(page[page.length - 1].p) : null, conversations: chosen.length });
  });
};
module.exports.SQL = SQL; // for scripts/bench-search.js, which prints their query plans
