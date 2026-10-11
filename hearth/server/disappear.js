// Disappearing messages (schema v19): a timer per conversation, a deadline per message, and the job that deletes
// messages once their deadline has passed.
//
// The timer lives on the conversation: channels.disappear_secs (server channels and the text channel of a group
// chat) and dm_channels.disappear_secs (DMs). 0 is off. Every message is stamped with expires_at when the server
// stores it (created_at + timer), so changing the timer never changes messages already sent, and edits never move
// it. A thread reply never outlives the message that starts its thread.
//
// The server holds the only stored copy (ciphertext) and serves history to every device, so it deletes once, for
// everyone. Until it has, every route that hands out messages skips expired ones (alive / LIVE), and the apps hide
// them by themselves at the deadline (they also know the timer from inside the encrypted message).
//
// Deleting: one timer armed for the next deadline, plus a sweep every minute as a safety net. Each run deletes in
// batches of 500 through partial indexes that only hold disappearing messages, with everything hanging off them
// (files, reactions, poll votes, mention marks, saved entries, pin history), then tells open apps with the same live
// events a normal delete sends (message:delete-bulk, thread:update, dm:delete, saved:update).
//
// Routes
//   PUT /channels/:id/disappearing  { seconds }   group chat: any member; server channel: Manage Channels there (and
//                                                 a channel_update entry in the server's audit log)
//   PUT /dms/:id/disappearing       { seconds }   either person (not after a block, not to a deleted account)
//   GET /channels/:id/disappearing                the timer and who changed it lately
//   GET /dms/:id/disappearing
// Live: disappear:update { conv, channelId | dmId, seconds, prev, by, at, id }
const jobs = require('./jobs');
const log = require('./log');

const DAY = 86400;
// Off, 1 hour, 1 day, 1 week, 4 weeks. Under NODE_ENV=test, 5 seconds too, so browser tests can watch one go.
const BASE_CHOICES = [0, 3600, DAY, 7 * DAY, 28 * DAY];
const CHOICES = process.env.NODE_ENV === 'test' ? [0, 5, ...BASE_CHOICES.slice(1)] : BASE_CHOICES;
const MAX_SECS = 28 * DAY;
const MAX_WAIT = 2 ** 31 - 1; // setTimeout fires at once for anything longer (the sweep covers those)
const BATCH = 500; // rows per table per transaction
const MAX_PER_RUN = 5000; // then let other work in and carry on
const STARTUP_MAX = 50000; // at start-up, before anyone can connect
const LOG_KEEP = 50; // timer changes kept per conversation
const PAGE_EVENTS = 50; // timer changes handed out with one history page

// SQL for "not expired at ?" (one placeholder), for queries that page or count messages.
const LIVE = '(expires_at IS NULL OR expires_at > ?)';
const alive = (row, t = Date.now()) => !!row && (row.expires_at == null || row.expires_at > t);
// A message's deadline: created_at + the conversation's timer when it was sent, never later than its thread's
// first message. null = it doesn't disappear.
function stamp({ secs, t, root = null }) {
  const own = secs > 0 ? t + secs * 1000 : null;
  const cap = root && root.expires_at != null ? root.expires_at : null;
  if (own == null) return cap;
  return cap == null ? own : Math.min(own, cap);
}
// When an id from newId() was made (its first 9 characters are the time in base 36).
const idTime = (id) => { const n = parseInt(String(id || '').slice(0, 9), 36); return Number.isFinite(n) ? n : null; };

let current = null; // the running instance, for arm() from the bot and news-bot insert paths
const arm = (at) => { if (current && at != null) current.arm(at); };

module.exports = function setupDisappear(ctx) {
  const { api, auth, db, fail, rateLimit, newId, now, requireChannel, requireDm, requireManageableChannel, serverOf, isBlocked, getUserRow,
    toChannel, getIo, emitTo, removeUpload, unseal, threadInfo, groupLast, bots, serverAudit = () => {}, chanRef = () => null,
    toChannelAbout = (c) => toChannel(c), visibilityOf = () => null, historyStart = () => null } = ctx;

  // ---------------------------------------------------------------- the timer
  function parseTimer(v) {
    if (typeof v !== 'number' || !Number.isInteger(v) || !CHOICES.includes(v)) fail(400, 'Pick off, 1 hour, 1 day, 1 week or 4 weeks.', 'bad_timer');
    return v;
  }
  // The sending app says which timer it encrypted for (ttl). An app that doesn't know about timers sends none and
  // gets the conversation's. One that saw an older setting is told to fetch the new one and try again, so the
  // timer inside the encrypted message always matches the one the server stamps.
  function checkTtl(body, secs) {
    const ttl = body && body.ttl;
    if (ttl === undefined || ttl === null) return;
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0 || ttl > MAX_SECS) fail(400, 'Pick off, 1 hour, 1 day, 1 week or 4 weeks.', 'bad_timer');
    if (ttl !== (secs || 0)) fail(409, 'Disappearing messages were just changed here. Your message wasn’t sent.', 'disappear_changed');
  }

  const logOut = (r) => ({ id: r.id, by: r.user_id, secs: r.secs, prev: r.prev_secs, at: r.created_at });
  // from: the reader's history start in the server (server/joinhistory.js), when they joined with "New members can't
  // read messages from before they joined" on: changes from before then are part of that history.
  function recentLog(conv, n = 20, from = 0) {
    return db.prepare('SELECT * FROM disappear_log WHERE conv = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?').all(conv, from || 0, n).map(logOut);
  }
  // The timer changes that fall inside one page of history: from the page's first message (or the start, when
  // there's nothing older) up to its last (or now, when there's nothing newer). The apps show them between the
  // messages, by time. before: the ?before= id the page was asked with (it ends there). afterAt: for an ?after= page,
  // when its anchor message was sent (it starts there, not at its own first message, or a change made between the
  // two pages would be on neither). from: none before then (the reader's history start, server/joinhistory.js).
  function eventsBetween(conv, rows, { hasMore, hasNewer, before = null, afterAt = null, from = null } = {}) {
    const lo = Math.max(afterAt != null ? afterAt : hasMore && rows.length ? rows[0].created_at : 0, from || 0);
    let hi = hasNewer && rows.length ? rows[rows.length - 1].created_at + 1 : Number.MAX_SAFE_INTEGER;
    const b = before ? idTime(before) : null;
    if (b != null) hi = Math.min(hi, b);
    return db.prepare('SELECT * FROM disappear_log WHERE conv = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(conv, lo, hi, PAGE_EVENTS).reverse().map(logOut);
  }
  // Sets the timer, logs who did it, and tells everyone in the conversation. Setting the same value again does
  // nothing (no log line, no event).
  function setTimer({ table, id, conv, uid, secs, prev, room, extra }) {
    if (secs === prev) return { conv, ...extra, seconds: secs, prev, unchanged: true };
    // Per person in each conversation too, so nobody can fill its history with timer changes. Not one budget for
    // the whole conversation: someone using all of it up would lock everyone else out of changing the timer.
    rateLimit(`disappear-conv:${conv}:${uid}`, 10, 3600000);
    const at = now();
    const entryId = newId();
    db.transaction(() => {
      db.prepare(`UPDATE ${table} SET disappear_secs = ? WHERE id = ?`).run(secs, id);
      db.prepare('INSERT INTO disappear_log (id, conv, user_id, secs, prev_secs, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(entryId, conv, uid, secs, prev, at);
      db.prepare(`DELETE FROM disappear_log WHERE conv = ? AND id NOT IN (SELECT id FROM disappear_log WHERE conv = ? ORDER BY created_at DESC, id DESC LIMIT ${LOG_KEEP})`).run(conv, conv);
    })();
    const out = { conv, ...extra, id: entryId, seconds: secs, prev, by: uid, at };
    if (getIo()) room().emit('disappear:update', out);
    return out;
  }
  // Who may change a channel's timer: any member of a group chat (like renaming it), Manage Channels in that
  // channel in a server. Only channels with messages have one: text channels, and a server's voice channels, whose
  // chat (v19, voice chat) disappears like a text channel's. A group's call has no chat of its own.
  function channelFor(req, change) {
    const c = requireChannel(req.params.id, req.userId);
    const srv = serverOf(c) || {};
    if (c.type !== 'text' && !(c.type === 'voice' && srv.kind !== 'group')) fail(400, 'Only text channels and voice channels’ chats have disappearing messages.', 'bad_channel');
    if (change && srv.kind !== 'group') requireManageableChannel(c.id, req.userId);
    return c;
  }
  // A DM's timer: either person, but not after a block (either way), nor once the other account is deleted.
  function dmFor(req, change) {
    const d = requireDm(req.params.id, req.userId);
    if (change) {
      if (isBlocked(d.user_a, d.user_b)) fail(403, 'You can’t message this person.');
      if ((getUserRow(d.user_a === req.userId ? d.user_b : d.user_a) || {}).deleted_at) fail(403, 'This account was deleted.', 'deleted');
    }
    return d;
  }
  api.put('/channels/:id/disappearing', auth, (req, res) => {
    rateLimit('disappear:' + req.userId, 10, 60000);
    const c = channelFor(req, true);
    const secs = parseTimer((req.body || {}).seconds);
    const prev = c.disappear_secs || 0;
    const out = setTimer({ table: 'channels', id: c.id, conv: 'c:' + c.id, uid: req.userId, secs, prev, room: () => toChannel(c), extra: { channelId: c.id } });
    // A server channel's timer is one of its settings, so a change goes in the server's audit log with the rest
    // (group chats have none). Messages disappearing by themselves aren't logged.
    const srv = serverOf(c);
    if (!out.unchanged && srv && srv.kind !== 'group') serverAudit(srv, req.userId, 'channel_update', c.id, { channel: chanRef(srv, c), changes: { disappear: { from: prev, to: secs } } }, c.id);
    res.json(out);
  });
  api.put('/dms/:id/disappearing', auth, (req, res) => {
    rateLimit('disappear:' + req.userId, 10, 60000);
    const d = dmFor(req, true);
    const secs = parseTimer((req.body || {}).seconds);
    res.json(setTimer({ table: 'dm_channels', id: d.id, conv: 'd:' + d.id, uid: req.userId, secs, prev: d.disappear_secs || 0,
      room: () => getIo().to([`user:${d.user_a}`, `user:${d.user_b}`]), extra: { dmId: d.id } }));
  });
  api.get('/channels/:id/disappearing', auth, (req, res) => {
    rateLimit('disappear-read:' + req.userId, 60, 60000);
    const c = channelFor(req, false);
    const since = historyStart(c, req.userId);
    res.json({ conv: 'c:' + c.id, channelId: c.id, seconds: c.disappear_secs || 0, log: recentLog('c:' + c.id, 20, since ? since.at : 0) });
  });
  api.get('/dms/:id/disappearing', auth, (req, res) => {
    rateLimit('disappear-read:' + req.userId, 60, 60000);
    const d = dmFor(req, false);
    res.json({ conv: 'd:' + d.id, dmId: d.id, seconds: d.disappear_secs || 0, log: recentLog('d:' + d.id) });
  });

  // ---------------------------------------------------------------- deleting
  const json = (list) => JSON.stringify(list);
  const IN = 'IN (SELECT value FROM json_each(?))';
  // One batch from one table: the messages whose time has passed (idx_messages_expires / idx_dm_messages_expires),
  // with a thread's replies when its first message goes (normally due anyway: replies are capped by it).
  function expireTable(kind) {
    const t = now();
    const table = kind === 'c' ? 'messages' : 'dm_messages';
    const due = db.prepare(`SELECT id, ${kind === 'c' ? 'channel_id, thread_id, author_id' : 'dm_id, author_id'} FROM ${table} WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`).all(t, BATCH);
    if (!due.length) return 0;
    if (kind === 'c') {
      const have = new Set(due.map((r) => r.id));
      for (const r of db.prepare(`SELECT id, channel_id, thread_id, author_id FROM messages WHERE thread_id ${IN}`).all(json([...have]))) if (!have.has(r.id)) { have.add(r.id); due.push(r); }
    }
    const ids = json(due.map((r) => r.id));
    const files = db.prepare(`SELECT name FROM blobs WHERE message_id ${IN}`).all(ids).map((b) => '/uploads/' + b.name);
    // Older, server-sealed posts (bots, the news bot) keep their file list in the body, like deleteMessageTree reads.
    if (kind === 'c') db.prepare(`SELECT body FROM messages WHERE id ${IN} AND ciphertext IS NULL`).all(ids).forEach((m) => (unseal(m.body).attachments || []).forEach((a) => files.push(a.url)));
    const savers = db.prepare(`SELECT user_id, message_id FROM saved_messages WHERE message_id ${IN}`).all(ids);
    db.transaction(() => {
      db.prepare(`DELETE FROM blobs WHERE message_id ${IN}`).run(ids);
      for (const x of ['reactions', 'poll_votes', 'poll_closed', 'mention_marks', 'saved_messages', 'pin_log']) db.prepare(`DELETE FROM ${x} WHERE message_id ${IN}`).run(ids);
      db.prepare(`DELETE FROM ${table} WHERE id ${IN}`).run(ids);
    })();
    // After the commit, like every other delete: a failure can't leave a message whose files are already gone.
    // removeUpload also drops the user_files row, so the uploader's storage use goes down.
    files.forEach((u) => removeUpload(u));
    announce(kind, due, savers);
    return due.length;
  }
  // Open apps hear about it with the events a normal delete sends, marked expired (bots get message.deleted).
  function announce(kind, rows, savers) {
    const io = getIo();
    const by = new Map();
    for (const r of rows) { const k = kind === 'c' ? r.channel_id : r.dm_id; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    for (const [id, list] of by) {
      if (kind === 'c') {
        const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
        if (!c) continue;
        const gone = new Set(list.map((r) => r.id));
        if (io) {
          const room = toChannel(c);
          const srv = serverOf(c);
          room.emit('message:delete-bulk', { channelId: c.id, messages: list.map((r) => ({ id: r.id, threadId: r.thread_id || null })), expired: true,
            ...(srv && srv.kind === 'group' ? { last: groupLast(srv) } : {}) });
          // Not to members the thread is from before (server/joinhistory.js): they never got it.
          for (const rootId of new Set(list.filter((r) => r.thread_id && !gone.has(r.thread_id)).map((r) => r.thread_id))) {
            toChannelAbout(c, visibilityOf(rootId)).emit('thread:update', { rootId, channelId: c.id, threadCount: 0, ...threadInfo({ id: rootId }) });
          }
        }
        const b = bots();
        if (b) b.events('message.deleted', c.server_id, list.map((r) => ({ messageId: r.id, channelId: c.id, authorId: r.author_id, threadId: r.thread_id || null, deletedBy: null, expired: true })), { channel: c });
      } else if (io) {
        const d = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(id);
        if (!d) continue;
        const room = io.to([`user:${d.user_a}`, `user:${d.user_b}`]);
        const last = lastDm(d.id);
        for (const r of list) room.emit('dm:delete', { id: r.id, dmId: d.id, expired: true, last });
      }
    }
    if (io) for (const s of savers) emitTo(s.user_id, 'saved:update', { messageId: s.message_id, saved: false });
  }
  const lastDm = (dmId) => {
    const m = db.prepare(`SELECT id, author_id, ciphertext, created_at, expires_at FROM dm_messages WHERE dm_id = ? AND ${LIVE} ORDER BY id DESC LIMIT 1`).get(dmId, now());
    return m ? { id: m.id, authorId: m.author_id, ciphertext: m.ciphertext, createdAt: m.created_at, expiresAt: m.expires_at || null } : null;
  };

  // In WAL mode a deleted row's old bytes stay in hearth.db-wal until it's reset. secure_delete (db.js) overwrites
  // them in the database file; truncating the WAL after a sweep that deleted something removes the rest. At most
  // every DISAPPEAR_CHECKPOINT_MS (10 minutes by default): it waits for anyone reading.
  const envMs = Number(process.env.DISAPPEAR_CHECKPOINT_MS);
  const CHECKPOINT_MS = process.env.DISAPPEAR_CHECKPOINT_MS && Number.isFinite(envMs) && envMs >= 0 ? envMs : 600000;
  let lastCheckpoint = 0;
  let checkpointDue = false;
  function maybeCheckpoint() {
    if (!checkpointDue || now() - lastCheckpoint < CHECKPOINT_MS) return;
    const r = db.pragma('wal_checkpoint(TRUNCATE)')[0] || {};
    if (r.busy) { log.debug('disappear', 'checkpoint_busy', { msg: 'The WAL is in use; truncating it after the next sweep instead.' }); return; }
    lastCheckpoint = now();
    checkpointDue = false;
  }

  let timer = null;
  let armedAt = null;
  let more = false;
  // limit: how many to delete before letting other work in (more at start-up, when nobody is connected yet).
  function run(limit = MAX_PER_RUN) {
    let total = 0; let n;
    do { n = expireTable('c') + expireTable('d'); total += n; } while (n >= BATCH && total < limit);
    if (total) checkpointDue = true;
    maybeCheckpoint();
    more = n >= BATCH;
    // A backlog (after a long stop, say): carry on in a moment, letting requests in between.
    if (more) setImmediate(runJob); else armNext();
    return total;
  }
  const runJob = jobs.job('messages.expire', () => run(), { noOverlap: true });
  // The precise timer: one setTimeout for the earliest deadline (a covering read of the partial indexes).
  function armNext() {
    const next = db.prepare(`SELECT MIN(t) AS t FROM (SELECT MIN(expires_at) AS t FROM messages WHERE expires_at IS NOT NULL
      UNION ALL SELECT MIN(expires_at) AS t FROM dm_messages WHERE expires_at IS NOT NULL)`).get().t;
    armedAt = null;
    clearTimeout(timer);
    if (next != null) armAt(next);
  }
  function armAt(at) {
    if (armedAt != null && armedAt <= at) return;
    const wait = at - now();
    if (wait > MAX_WAIT) return; // 4-week timers: the minute sweep picks those up
    clearTimeout(timer);
    armedAt = at;
    timer = setTimeout(() => { armedAt = null; runJob(); }, Math.max(0, wait) + 25);
    timer.unref?.();
  }
  // The safety net (and what shows in Admin → Health): every minute, or DISAPPEAR_SWEEP_MS. (The first run is the one
  // just below, at start-up.)
  const sweepMs = Math.max(50, Number(process.env.DISAPPEAR_SWEEP_MS) || 60000);
  jobs.every('messages.expire', sweepMs, () => run(), { firstDelay: sweepMs });
  // Messages whose time passed while the server was stopped go before anyone can connect (this runs before listen;
  // there's nobody to tell yet). A huge backlog carries on in the background after the first 50,000, and the
  // routes never hand out what's left of it meanwhile.
  try { run(STARTUP_MAX); } catch (e) { log.error('disappear', 'startup_sweep', e, { msg: 'Could not delete expired messages at start-up; the sweep tries again in a minute.' }); }

  current = { arm: armAt };
  return { CHOICES, parseTimer, checkTtl, eventsBetween, run, arm: armAt };
};

module.exports.CHOICES = CHOICES;
module.exports.LIVE = LIVE;
module.exports.alive = alive;
module.exports.stamp = stamp;
module.exports.arm = arm;
module.exports.idTime = idTime;
