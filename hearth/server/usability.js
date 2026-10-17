// Message usability and notifications (schema v18): saved messages, read state and unread counts, notification
// preferences (and the push decisions that follow them), pin history, member timeouts, and "Export my data".
//
// Message contents stay end-to-end encrypted. Everything here works on ids and times:
//   - a saved message is its id plus, optionally, a note the app encrypts with the person's own vault key (x1:);
//   - read state is the id of the last message read in each conversation (and each thread);
//   - mention counts come from mention_marks, the user ids the sender's app already sends so the server can push;
//   - the export hands out ciphertext, and the app decrypts it and builds the download on the device.
//
// Routes
//   GET    /me/saved                saved messages, newest first (?before=<savedAt>&limit=)
//   GET    /me/saved/ids            just the ids (to draw the bookmark state)
//   PUT    /me/saved/:id            save (or change the note of) a message you can see
//   DELETE /me/saved/:id            unsave (works for messages that are gone too)
//   GET    /me/unread               per conversation: last read, last message, unread and mention counts
//   POST   /me/read                 { conv, messageId, unread?, threads?, pings? } — move your read marker (synced to
//                                   your devices); conv t:<root id> is a thread; threads: true also marks a channel's
//                                   threads; pings: true reads a voice chat you don't follow without following it
//   POST   /servers/:id/read        mark every channel you can see in a server as read, threads included
//   GET    /channels/:id/threads    the channel's threads, latest reply first, with your unread counts (?before=&limit=)
//   GET    /me/notify               your preferences and Do Not Disturb settings
//   PUT    /me/notify/:target       s:<server> | c:<channel> | d:<dm>: { level, muteUntil, suppressEveryone }
//   PUT    /me/notify-settings      { dnd: { on, start, end, days }, tz, previews }
//   GET    /channels/:id/pins/log   who pinned and unpinned what, newest first
//   GET    /servers/:id/timeouts    active timeouts (Kick Members)
//   POST   /servers/:id/members/:uid/timeout     { minutes, reason } (Kick Members, below you)
//   DELETE /servers/:id/members/:uid/timeout
//   GET    /me/reports              the reports you filed and where they stand
//   POST   /me/export               start an export: needs your password (and 2FA code), gives a short-lived token
//   GET    /me/export/account       account, profile, servers, conversations (X-Export-Token)
//   GET    /me/export/messages      one conversation's messages as ciphertext, oldest first (X-Export-Token)

const crypto = require('crypto');
const jobs = require('./jobs');
const { alive, LIVE } = require('./disappear');

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONV = /^([cd]):([A-Za-z0-9_-]{1,64})$/;
const THREAD = /^t:([A-Za-z0-9_-]{1,64})$/;
const THREADS_PAGE = 25;
const TARGET = /^([scd]):([A-Za-z0-9_-]{1,64})$/;
const NOTE = /^x1:[A-Za-z0-9+/=:_-]{16,8000}$/;
const LEVELS = ['default', 'all', 'mentions', 'none'];
const MAX_SAVED = 1000;
const MAX_PREFS = 2000;
const COUNT_CAP = 100; // counts past this show as "99+" anyway
// A channel's thread pings are counted from the person's newest this many in it. Pings in threads already read
// stay in the table (each thread has its own marker), so without a bound the count would walk every one of them.
const THREAD_PING_SCAN = 500;
const MAX_TIMEOUT_MIN = 28 * 24 * 60;
const EXPORT_TTL = 30 * 60 * 1000;
const EXPORT_MAX_MESSAGES = 200000; // per export, across all conversations
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

module.exports = function setupUsability(ctx) {
  const { api, auth, db, fail, wrap, rateLimit, stepUp, auditLog, serverAudit, perms, PM, ALL, newId, now, emitTo, emitServer, brandName,
    requireServer, requirePerm, requireChannel, requireDm, isMember, serverOf, serializeMessage, serializeDmMessage, reactionsFor,
    getUserRow, selfUser, nameOf, history } = ctx;

  // ---------------------------------------------------------------- helpers
  const idParam = (v, what = 'message') => { if (typeof v !== 'string' || !ID.test(v)) fail(404, `That ${what} doesn’t exist.`); return v; };
  // A conversation key you can read right now, or 404. { kind: 'c', channel, server } | { kind: 'd', dm }
  function convAccess(uid, conv) {
    const m = typeof conv === 'string' && CONV.exec(conv);
    if (!m) fail(400, 'Unknown conversation.');
    if (m[1] === 'c') { const channel = requireChannel(m[2], uid); return { kind: 'c', channel, server: serverOf(channel), conv }; }
    return { kind: 'd', dm: requireDm(m[2], uid), conv };
  }
  // Where a message lives, if the person can still see it there; null otherwise (never throws). A disappearing
  // message whose time has passed is gone, even before the sweep deletes it; so is one from before the person's
  // history in that server starts (server/joinhistory.js: a message saved during an earlier membership, say).
  function visibleMessage(uid, messageId) {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (m) {
      if (!alive(m)) return null;
      try {
        const c = requireChannel(m.channel_id, uid);
        const since = history.startOf(c.server_id, uid);
        return history.visible(m, since) ? { conv: 'c:' + c.id, row: m, channel: c, since } : null;
      } catch { return null; }
    }
    const d = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(messageId);
    if (d) {
      if (!alive(d)) return null;
      try { requireDm(d.dm_id, uid); return { conv: 'd:' + d.dm_id, row: d }; } catch { return null; }
    }
    return null;
  }
  const serialize = (v, reactions) => (v.channel ? serializeMessage(v.row, v.channel, reactions, v.since) : serializeDmMessage(v.row, reactions));

  // ---------------------------------------------------------------- saved messages
  const savedOut = (uid, r, reactions) => {
    const v = visibleMessage(uid, r.message_id);
    return { messageId: r.message_id, note: r.note || null, savedAt: r.created_at, ...(v ? { conv: v.conv, message: serialize(v, reactions) } : { unavailable: true }) };
  };
  api.get('/me/saved', auth, (req, res) => {
    rateLimit('saved-read:' + req.userId, 120, 60000);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const before = /^\d{1,16}$/.test(String(req.query.before || '')) ? Number(req.query.before) : Number.MAX_SAFE_INTEGER;
    const rows = db.prepare('SELECT * FROM saved_messages WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC, message_id DESC LIMIT ?').all(req.userId, before, limit + 1);
    const page = rows.slice(0, limit);
    const reactions = reactionsFor(page.map((r) => r.message_id));
    res.json({ items: page.map((r) => savedOut(req.userId, r, reactions)), hasMore: rows.length > limit });
  });
  api.get('/me/saved/ids', auth, (req, res) => {
    res.json(db.prepare('SELECT message_id FROM saved_messages WHERE user_id = ? ORDER BY created_at DESC').all(req.userId).map((r) => r.message_id));
  });
  api.put('/me/saved/:id', auth, (req, res) => {
    rateLimit('saved:' + req.userId, 60, 60000);
    const id = idParam(req.params.id);
    const v = visibleMessage(req.userId, id);
    if (!v) fail(404, 'That message was deleted or you can’t see it.');
    const b = req.body || {};
    const note = b.note == null || b.note === '' ? null : String(b.note);
    if (note !== null && !NOTE.test(note)) fail(400, 'That note couldn’t be saved. Reload the page and try again.');
    const had = db.prepare('SELECT created_at FROM saved_messages WHERE user_id = ? AND message_id = ?').get(req.userId, id);
    if (!had && db.prepare('SELECT COUNT(*) n FROM saved_messages WHERE user_id = ?').get(req.userId).n >= MAX_SAVED) fail(400, `You can save up to ${MAX_SAVED} messages. Remove some first.`);
    const at = had ? had.created_at : now();
    db.prepare(`INSERT INTO saved_messages (user_id, message_id, note, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, message_id) DO UPDATE SET note = excluded.note`).run(req.userId, id, note, at);
    const out = { messageId: id, note, savedAt: at, conv: v.conv, saved: true };
    emitTo(req.userId, 'saved:update', out);
    res.json(out);
  });
  api.delete('/me/saved/:id', auth, (req, res) => {
    rateLimit('saved:' + req.userId, 60, 60000);
    const id = idParam(req.params.id);
    db.prepare('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?').run(req.userId, id);
    emitTo(req.userId, 'saved:update', { messageId: id, saved: false });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- read state
  // The first time someone's read state is asked for, everything up to now counts as read, so an upgrade (or a
  // brand-new account) doesn't light up every old conversation. Conversations never opened since use that line.
  function baselineOf(uid) {
    const row = db.prepare('SELECT read_baseline FROM user_prefs WHERE user_id = ?').get(uid);
    if (row && row.read_baseline) return row.read_baseline;
    const b = newId();
    db.prepare(`INSERT INTO user_prefs (user_id, read_baseline, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET read_baseline = COALESCE(user_prefs.read_baseline, excluded.read_baseline)`).run(uid, b, now());
    return db.prepare('SELECT read_baseline FROM user_prefs WHERE user_id = ?').get(uid).read_baseline;
  }
  const countSql = (sql) => `SELECT COUNT(*) AS n FROM (${sql} LIMIT ${COUNT_CAP})`;
  // Pings in any of a channel's threads that their thread hasn't been read past (each thread has its own marker).
  // Only the newest THREAD_PING_SCAN of them are looked at: yours and @everyone, merged newest first from two
  // ranges of idx_mention_marks_conv, so the walk stops there however many old, already-read pings pile up.
  // extra: more conditions on each (mm.message_id, mm.thread_id).
  const threadMarksSql = (extra = '') => countSql(`SELECT 1 FROM (
        SELECT message_id, thread_id FROM mention_marks WHERE conv = ? AND user_id = ? AND message_id > ?
        UNION ALL SELECT message_id, thread_id FROM mention_marks WHERE conv = ? AND user_id = '*' AND ? = 1 AND message_id > ?
        ORDER BY message_id DESC LIMIT ${THREAD_PING_SCAN}) mm
      WHERE mm.message_id > COALESCE((SELECT last_read_id FROM read_states WHERE user_id = ? AND conv = 't:' || mm.thread_id), '')
        AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.id = mm.message_id AND x.expires_at <= ?)${extra}`);
  const Q = {
    lastC: 'SELECT id FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT 1',
    lastD: 'SELECT id FROM dm_messages WHERE dm_id = ? ORDER BY id DESC LIMIT 1',
    unreadC: countSql('SELECT 1 FROM messages WHERE channel_id = ? AND thread_id IS NULL AND id > ? AND author_id != ?'),
    unreadD: countSql('SELECT 1 FROM dm_messages WHERE dm_id = ? AND id > ? AND author_id != ?'),
    marks: countSql("SELECT 1 FROM mention_marks WHERE conv = ? AND (user_id = ? OR (user_id = '*' AND ? = 1)) AND message_id > ?"),
    // The same three for someone whose history in the server starts at a point (server/joinhistory.js): only what's
    // from then, without the few messages locked with a key from before theirs. lastCH walks back no further than
    // when they joined.
    lastCH: 'SELECT id FROM messages WHERE channel_id = ? AND thread_id IS NULL AND id >= ? AND (ciphertext IS NULL OR epoch >= ?) ORDER BY id DESC LIMIT 1',
    unreadCH: countSql('SELECT 1 FROM messages WHERE channel_id = ? AND thread_id IS NULL AND id > ? AND author_id != ? AND (ciphertext IS NULL OR epoch >= ?)'),
    marksH: countSql(`SELECT 1 FROM mention_marks mm JOIN messages x ON x.id = mm.message_id WHERE mm.conv = ? AND (mm.user_id = ? OR (mm.user_id = '*' AND ? = 1))
      AND mm.message_id > ? AND (x.ciphertext IS NULL OR x.epoch >= ?)`),
    marker: 'SELECT last_read_id FROM read_states WHERE user_id = ? AND conv = ?',
    // A voice chat's first ping for you after a point, and the message just before it (followVoiceChat).
    firstMark: "SELECT MIN(message_id) AS id FROM mention_marks WHERE conv = ? AND (user_id = ? OR (user_id = '*' AND ? = 1)) AND message_id > ?",
    lastBefore: 'SELECT MAX(id) AS id FROM messages WHERE channel_id = ? AND thread_id IS NULL AND id < ?',
    // Threads (idx_messages_thread, idx_mention_marks_thread): the newest reply, unread replies and pings in one.
    // A reply whose time has passed (a disappearing message the sweep hasn't reached) counts for none of them.
    lastT: `SELECT id FROM messages WHERE thread_id = ? AND ${LIVE} ORDER BY id DESC LIMIT 1`,
    unreadT: countSql(`SELECT 1 FROM messages WHERE thread_id = ? AND id > ? AND author_id != ? AND ${LIVE}`),
    marksT: countSql(`SELECT 1 FROM mention_marks mm WHERE mm.thread_id = ? AND (mm.user_id = ? OR (mm.user_id = '*' AND ? = 1)) AND mm.message_id > ?
      AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.id = mm.message_id AND x.expires_at <= ?)`),
    threadMarks: threadMarksSql(),
    // The same for someone whose history in the server starts at a point (server/joinhistory.js): only pings they
    // can open, in threads whose first message is from then on and not locked with a key from before theirs.
    threadMarksH: threadMarksSql(`
        AND EXISTS (SELECT 1 FROM messages x WHERE x.id = mm.message_id AND (x.ciphertext IS NULL OR x.epoch >= ?))
        AND EXISTS (SELECT 1 FROM messages r WHERE r.id = mm.thread_id AND r.created_at >= ? AND (r.ciphertext IS NULL OR r.epoch >= ?))`),
    // Has any thread in the channel had a reply since? (One step in idx_thread_activity_channel. Without one there
    // can't be an unread ping in its threads, so /me/unread skips counting them for most channels.)
    threadsSince: 'SELECT 1 FROM thread_activity WHERE channel_id = ? AND last_reply_id > ? LIMIT 1',
    // The newest message in a channel, thread replies included.
    lastAny: 'SELECT MAX(id) AS id FROM messages WHERE channel_id = ?',
    // Up to 5 people who replied in a thread, the most recent first (from its newest 200 replies).
    participants: `SELECT author_id FROM (SELECT author_id, id FROM messages WHERE thread_id = ? AND ${LIVE} ORDER BY id DESC LIMIT 200) GROUP BY author_id ORDER BY MAX(id) DESC LIMIT 5`,
  };
  const markerOf = (uid, conv) => (db.prepare(Q.marker).get(uid, conv) || {}).last_read_id || null;
  // @everyone switched off for this channel or its server.
  function suppressedAll(uid, c) {
    const cp = prefRow(uid, 'c:' + c.id); const sp = prefRow(uid, 's:' + c.server_id);
    return !!((cp && cp.suppress_everyone) || (sp && sp.suppress_everyone));
  }
  // Where a channel's threads count as read from: "Mark as read" on the channel or its server (ct:<channel>) or the
  // person's baseline, whichever is later. Each thread's own marker (t:<root>) can only move further.
  function threadFloor(uid, channelId, baseline = baselineOf(uid), stored = markerOf(uid, 'ct:' + channelId)) {
    return stored && stored > baseline ? stored : baseline;
  }
  // The later of two read markers (either may be missing).
  const later = (a, b) => (b && (!a || a < b) ? b : a);
  // since: the person's history start in the channel's server (server/joinhistory.js), or null: then only pings from
  // after it, in threads they can open.
  function threadMentionsIn(uid, channelId, floor, suppressAll, since = null) {
    const f = since ? later(floor, since.floor) : floor;
    if (!db.prepare(Q.threadsSince).get(channelId, f)) return 0;
    const args = ['ct:' + channelId, uid, f, 'ct:' + channelId, suppressAll ? 0 : 1, f, uid, now()];
    return since ? db.prepare(Q.threadMarksH).get(...args, since.epoch, since.at, since.epoch).n : db.prepare(Q.threadMarks).get(...args).n;
  }
  // Where someone's history in a channel's server starts (server/joinhistory.js), or null. kind 'c' only.
  const startIn = (uid, channel, s = null) => history.startOf((s && s.id) || channel.server_id, uid);
  // floor: threadFloor() for the channel. Given, the channel's threads add their pings as threadMentions (the app
  // shows them in the channel's badge, apart from the channel's own mentions, which reading the channel clears).
  // since: the person's history start in the channel's server (server/joinhistory.js): nothing from before it counts,
  // as if they had read up to there.
  function convState(uid, conv, lastReadId, { group = false, suppressAll = false, floor = null, since = null } = {}) {
    const [, kind, id] = CONV.exec(conv);
    const h = kind === 'c' && since ? since : null;
    if (h) lastReadId = later(lastReadId, h.floor);
    const last = h ? db.prepare(Q.lastCH).get(id, h.floor, h.epoch) : db.prepare(kind === 'c' ? Q.lastC : Q.lastD).get(id);
    const st = { lastReadId, lastId: last ? last.id : null, unread: 0, mentions: 0 };
    if (kind === 'c' && floor) st.threadMentions = threadMentionsIn(uid, id, floor, suppressAll, h);
    if (!last || last.id <= lastReadId) return st;
    st.unread = h ? db.prepare(Q.unreadCH).get(id, lastReadId, uid, h.epoch).n : db.prepare(kind === 'c' ? Q.unreadC : Q.unreadD).get(id, lastReadId, uid).n;
    // Direct messages and group chats count every message, like a mention; channels count real pings.
    st.mentions = kind === 'd' || group ? st.unread
      : h ? db.prepare(Q.marksH).get(conv, uid, suppressAll ? 0 : 1, lastReadId, h.epoch).n
        : db.prepare(Q.marks).get(conv, uid, suppressAll ? 0 : 1, lastReadId).n;
    return st;
  }
  // v19 (voice chat): a voice channel's chat counts as unread only for people who follow it: who opened it, wrote
  // there or picked "All messages" for it, which leaves a read marker (and, in the app, who are in its call). Until
  // then only its pings count (unread stays 0, opened false), from the baseline or from where "Mark as read" left
  // them (cp:<channel>, "pings read up to", which doesn't make you follow it). It has no threads.
  //   marker: your read marker there, or null; pingsRead: your cp: marker there, or null
  function voiceChatState(uid, conv, marker, { baseline, suppressAll = false, pingsRead = null, since = null }) {
    if (marker) return { ...convState(uid, conv, marker, { suppressAll, since }), opened: true };
    const floor = later(later(baseline, pingsRead), since && since.floor);
    const last = since ? db.prepare(Q.lastCH).get(conv.slice(2), since.floor, since.epoch) : db.prepare(Q.lastC).get(conv.slice(2));
    const mentions = !last || last.id <= floor ? 0
      : since ? db.prepare(Q.marksH).get(conv, uid, suppressAll ? 0 : 1, floor, since.epoch).n : db.prepare(Q.marks).get(conv, uid, suppressAll ? 0 : 1, floor).n;
    return { lastReadId: null, lastId: last ? last.id : null, unread: 0, mentions, opened: false };
  }
  const isVoiceChat = (c, s = serverOf(c)) => c.type === 'voice' && !!s && s.kind !== 'group';
  // Following a voice chat by picking "All messages" for it, as opening it would: a read marker at its newest message
  // ('0' while it has none), so what's said there from now on counts as unread on all your devices. Pings you haven't
  // read stay: the marker then goes just before the first of them. Nothing changes for a chat you already follow.
  function followVoiceChat(uid, c) {
    const conv = 'c:' + c.id;
    if (!isVoiceChat(c) || markerOf(uid, conv)) return;
    const baseline = baselineOf(uid);
    const pingsRead = markerOf(uid, 'cp:' + c.id);
    const floor = pingsRead && pingsRead > baseline ? pingsRead : baseline;
    const suppressAll = suppressedAll(uid, c);
    const ping = db.prepare(Q.firstMark).get(conv, uid, suppressAll ? 0 : 1, floor).id;
    let at;
    if (ping) { const before = db.prepare(Q.lastBefore).get(c.id, ping).id; at = before && before > floor ? before : floor; }
    else at = (db.prepare(Q.lastC).get(c.id) || {}).id || '0';
    setRead(uid, conv, at);
    emitTo(uid, 'read:update', { conv, ...convState(uid, conv, at, { suppressAll, since: startIn(uid, c) }), opened: true });
  }
  // The channels of a server that have a chat: text channels, and voice channels outside group chats (a group's call
  // has none: the group's conversation is its chat).
  const chatChannels = (s) => db.prepare(s.kind === 'group' ? "SELECT * FROM channels WHERE server_id = ? AND type = 'text'"
    : "SELECT * FROM channels WHERE server_id = ? AND type IN ('text', 'voice')").all(s.id);
  function unreadFor(uid) {
    const baseline = baselineOf(uid);
    // Not the thread markers (t:): there's one for every thread ever opened, and threads are counted per channel here.
    const states = new Map(db.prepare("SELECT conv, last_read_id FROM read_states WHERE user_id = ? AND conv NOT LIKE 't:%'").all(uid).map((r) => [r.conv, r.last_read_id]));
    const out = {};
    for (const s of db.prepare('SELECT s.* FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ?').all(uid)) {
      const group = s.kind === 'group';
      const sp = prefRow(uid, 's:' + s.id);
      const since = history.startOf(s.id, uid); // nothing from before it counts (server/joinhistory.js)
      for (const c of chatChannels(s)) {
        if (!(perms.channel(s, c, uid) & PM.VIEW_CHANNEL)) continue;
        const conv = 'c:' + c.id;
        const cp = prefRow(uid, conv);
        const suppressAll = !!((cp && cp.suppress_everyone) || (sp && sp.suppress_everyone));
        out[conv] = c.type === 'voice' ? voiceChatState(uid, conv, states.get(conv) || null, { baseline, suppressAll, pingsRead: states.get('cp:' + c.id) || null, since }) : convState(uid, conv, states.get(conv) || baseline, {
          group, suppressAll, floor: threadFloor(uid, c.id, baseline, states.get('ct:' + c.id) || null), since,
        });
      }
    }
    for (const d of db.prepare('SELECT id FROM dm_channels WHERE user_a = ? OR user_b = ?').all(uid, uid)) {
      const conv = 'd:' + d.id;
      out[conv] = convState(uid, conv, states.get(conv) || baseline);
    }
    return out;
  }
  // Moves the marker forward only, unless asked to go back (mark as unread). Two devices racing can't undo
  // each other's progress.
  function setRead(uid, conv, id, back = false) {
    const t = now();
    if (back) {
      db.prepare(`INSERT INTO read_states (user_id, conv, last_read_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, conv) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`).run(uid, conv, id, t);
    } else {
      db.prepare(`INSERT INTO read_states (user_id, conv, last_read_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, conv) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at
        WHERE excluded.last_read_id > read_states.last_read_id`).run(uid, conv, id, t);
    }
    return db.prepare('SELECT last_read_id FROM read_states WHERE user_id = ? AND conv = ?').get(uid, conv).last_read_id;
  }
  api.get('/me/unread', auth, (req, res) => {
    rateLimit('unread:' + req.userId, 60, 60000);
    res.json({ states: unreadFor(req.userId) });
  });
  api.post('/me/read', auth, (req, res) => {
    rateLimit('read:' + req.userId, 240, 60000);
    const b = req.body || {};
    if (typeof b.conv === 'string' && THREAD.test(b.conv)) return res.json(readThread(req.userId, b));
    const a = convAccess(req.userId, b.conv);
    const back = b.unread === true;
    const id = String(b.messageId || '');
    // A voice channel's chat opened while it has no messages yet: the marker '0' (before every message) is how it
    // counts as opened from then on, on all your devices. It only ever moves forward from there.
    const voiceChat = a.kind === 'c' && a.channel.type === 'voice' && a.server.kind !== 'group';
    if (id === '0') { if (!back && !voiceChat) fail(400, 'Pick a message.'); } else {
      idParam(id);
      const there = a.kind === 'c'
        ? db.prepare('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?').get(id, a.channel.id)
        : db.prepare('SELECT 1 FROM dm_messages WHERE id = ? AND dm_id = ?').get(id, a.dm.id);
      if (!there) fail(404, 'That message doesn’t exist.');
    }
    // "Mark as read" from a menu on a voice chat you don't follow (pings: true): its pings are read, and it stays
    // unfollowed (a cp: marker, not a read marker). Marking it read isn't opening it.
    if (voiceChat && b.pings === true && !back && !markerOf(req.userId, a.conv)) {
      if (id === '0') fail(400, 'Pick a message.');
      const pingsRead = setRead(req.userId, 'cp:' + a.channel.id, id);
      const out = { conv: a.conv, ...voiceChatState(req.userId, a.conv, null, { baseline: baselineOf(req.userId), suppressAll: suppressedAll(req.userId, a.channel), pingsRead, since: startIn(req.userId, a.channel, a.server) }) };
      emitTo(req.userId, 'read:update', out);
      return res.json(out);
    }
    const lastReadId = setRead(req.userId, a.conv, id, back);
    // Reading a channel leaves its threads alone: each has its own marker. "Mark as read" (threads: true) is the
    // exception, so the badge it clears doesn't come straight back from a ping in a thread. Only then is the answer's
    // threadMentions worked out: a plain read can't change it (the app keeps what it has), and the app sends one
    // every time you scroll to the bottom of a busy channel.
    const threadsRead = a.kind === 'c' && a.channel.type === 'text' && b.threads === true && !back ? readAllThreads(req.userId, a.channel.id) : null;
    const st = convState(req.userId, a.conv, lastReadId, a.kind === 'c'
      ? { group: a.server.kind === 'group', suppressAll: suppressedAll(req.userId, a.channel), floor: threadsRead ? threadFloor(req.userId, a.channel.id) : null, since: startIn(req.userId, a.channel, a.server) }
      : {});
    const out = { conv: a.conv, ...st, ...(threadsRead ? { threadsRead } : {}), ...(voiceChat ? { opened: true } : {}) };
    emitTo(req.userId, 'read:update', out);
    res.json(out);
  });
  // Every thread in a channel read up to its newest reply right now (one ct:<channel> marker, not one per thread).
  function readAllThreads(uid, channelId) {
    const last = db.prepare(Q.lastAny).get(channelId).id;
    return last ? setRead(uid, 'ct:' + channelId, last) : null;
  }
  // A thread's marker (t:<root>): forward only, to one of its replies. Threads have no "Mark unread".
  function readThread(uid, b) {
    const root = db.prepare('SELECT id, channel_id, thread_id, created_at, ciphertext IS NOT NULL AS ciphertext, epoch, expires_at FROM messages WHERE id = ?').get(THREAD.exec(b.conv)[1]);
    // A thread in a channel you can't read looks exactly like one that doesn't exist (so does one whose first
    // message has disappeared, or was written before your history in the server starts, server/joinhistory.js).
    let channel = null;
    try { channel = alive(root) && !root.thread_id ? requireChannel(root.channel_id, uid) : null; } catch { /* not yours to see */ }
    if (channel && !history.visible(root, startIn(uid, channel))) channel = null;
    if (!channel) fail(404, 'That thread doesn’t exist.');
    if (b.unread === true) fail(400, 'Threads can’t be marked unread.');
    const id = idParam(String(b.messageId || ''));
    if (!alive(db.prepare('SELECT expires_at FROM messages WHERE id = ? AND thread_id = ?').get(id, root.id))) fail(404, 'That message doesn’t exist.');
    setRead(uid, 't:' + root.id, id);
    return announceThread(uid, root.id, channel);
  }
  // One thread as one person sees it. lastReadId is where it counts as read from (its own marker, the channel's
  // "Mark as read" or the baseline, whichever is latest); unread counts other people's replies after that.
  function threadState(uid, rootId, channel, { floor = threadFloor(uid, channel.id), suppressAll = suppressedAll(uid, channel) } = {}) {
    const own = markerOf(uid, 't:' + rootId);
    const lastReadId = own && own > floor ? own : floor;
    const t = now();
    const lastId = (db.prepare(Q.lastT).get(rootId, t) || {}).id || null;
    const st = { conv: 't:' + rootId, rootId, channelId: channel.id, lastReadId, lastId, unread: 0, mentions: 0 };
    if (!lastId || lastId <= lastReadId) return st;
    st.unread = db.prepare(Q.unreadT).get(rootId, lastReadId, uid, t).n;
    st.mentions = db.prepare(Q.marksT).get(rootId, uid, suppressAll ? 0 : 1, lastReadId, t).n;
    return st;
  }
  // The states of the threads started by some of a channel's messages (a page of them), by root id.
  function threadStates(uid, channel, rootIds) {
    const out = {};
    if (!rootIds.length) return out;
    const opts = { floor: threadFloor(uid, channel.id), suppressAll: suppressedAll(uid, channel) };
    for (const id of rootIds) out[id] = threadState(uid, id, channel, opts);
    return out;
  }
  // One thread's state with its channel's thread pings (for the channel's badge): opening a thread sets both right,
  // even after a ping the app counted was deleted.
  function threadStateWithBadge(uid, rootId, channel) {
    const opts = { floor: threadFloor(uid, channel.id), suppressAll: suppressedAll(uid, channel) };
    return { ...threadState(uid, rootId, channel, opts), threadMentions: threadMentionsIn(uid, channel.id, opts.floor, opts.suppressAll, startIn(uid, channel)) };
  }
  // A thread's new state, with its channel's badge, to all of the person's devices.
  function announceThread(uid, rootId, channel) {
    const out = threadStateWithBadge(uid, rootId, channel);
    emitTo(uid, 'read:update', out);
    return out;
  }
  api.post('/servers/:id/read', auth, (req, res) => {
    rateLimit('read:' + req.userId, 240, 60000);
    const s = requireServer(req.params.id, req.userId);
    const changed = [];
    const baseline = baselineOf(req.userId);
    db.transaction(() => {
      for (const c of chatChannels(s)) {
        if (!(perms.channel(s, c, req.userId) & PM.VIEW_CHANNEL)) continue;
        const last = db.prepare(Q.lastC).get(c.id);
        if (!last) continue;
        const conv = 'c:' + c.id;
        if (c.type === 'voice') {
          if (markerOf(req.userId, conv)) { changed.push({ conv, lastReadId: setRead(req.userId, conv, last.id), lastId: last.id, unread: 0, mentions: 0, opened: true }); continue; }
          // A voice chat you don't follow stays that way (marking it read isn't opening it): only its pings are read
          // (its cp: marker), and one without a ping for you is left alone.
          const pingsRead = markerOf(req.userId, 'cp:' + c.id);
          if (!voiceChatState(req.userId, conv, null, { baseline, suppressAll: suppressedAll(req.userId, c), pingsRead, since: startIn(req.userId, c, s) }).mentions) continue;
          setRead(req.userId, 'cp:' + c.id, last.id);
          changed.push({ conv, lastReadId: null, lastId: last.id, unread: 0, mentions: 0, opened: false });
          continue;
        }
        // Marking a whole server read takes its threads with it too.
        const threadsRead = readAllThreads(req.userId, c.id);
        changed.push({ conv, lastReadId: setRead(req.userId, conv, last.id), lastId: last.id, unread: 0, mentions: 0, threadMentions: 0, ...(threadsRead ? { threadsRead } : {}) });
      }
    })();
    changed.forEach((st) => emitTo(req.userId, 'read:update', st));
    res.json({ ok: true, states: changed });
  });
  // Sending a message means you've seen the conversation up to it (no event: your other devices get the message).
  function markSent(uid, conv, id) { try { setRead(uid, conv, id); } catch { /* never block a send */ } }
  // Replying in a thread: read up to your reply. Your other devices are told, since a channel's thread pings can't
  // be worked out from the message alone.
  function markThreadSent(uid, channel, rootId, id) {
    try { setRead(uid, 't:' + rootId, id); announceThread(uid, rootId, channel); } catch { /* never block a send */ }
  }

  // Who a channel message pings, kept so counts survive a reload. A thread reply's pings go under ct:<channel>
  // with the thread's root, so they count in the channel's badge until that thread is read.
  function recordMentions(messageId, conv, userIds, everyone, threadId = null) {
    const ins = db.prepare('INSERT OR IGNORE INTO mention_marks (message_id, conv, user_id, thread_id) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (const u of new Set(userIds)) ins.run(messageId, conv, u, threadId);
      if (everyone) ins.run(messageId, conv, '*', threadId);
    })();
  }

  // ---------------------------------------------------------------- threads in a channel
  // The Threads panel: a channel's threads, the one with the latest reply first (thread_activity, kept by triggers in
  // db.js), paged by that reply's id (?before=). Each comes with its first message as stored (ciphertext, decrypted by
  // the app), the reply count, the latest reply, up to 5 people who replied most recently, and your own unread and
  // ping counts. Only for channels you can read: any other is "not found", as for its messages.
  api.get('/channels/:id/threads', auth, (req, res) => {
    rateLimit('threads:' + req.userId, 60, 60000);
    const c = requireChannel(req.params.id, req.userId);
    if (c.type !== 'text') fail(400, 'Only text channels have threads.');
    const before = req.query.before === undefined ? null : String(req.query.before);
    if (before !== null && !ID.test(before)) fail(400, 'That page of threads doesn’t exist.');
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || THREADS_PAGE));
    const rows = before
      ? db.prepare('SELECT root_id, last_reply_id FROM thread_activity WHERE channel_id = ? AND last_reply_id < ? ORDER BY last_reply_id DESC LIMIT ?').all(c.id, before, limit + 1)
      : db.prepare('SELECT root_id, last_reply_id FROM thread_activity WHERE channel_id = ? ORDER BY last_reply_id DESC LIMIT ?').all(c.id, limit + 1);
    const page = rows.slice(0, limit);
    const reactions = reactionsFor(page.map((r) => r.root_id));
    const opts = { floor: threadFloor(req.userId, c.id), suppressAll: suppressedAll(req.userId, c) };
    const since = history.startOf(c.server_id, req.userId);
    const threads = [];
    for (const r of page) {
      const root = db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND thread_id IS NULL').get(r.root_id, c.id);
      // A thread whose first message has disappeared is gone too, even before the sweep deletes it; so is one whose
      // replies all have (the sweep's deletes take it out of thread_activity). Counts, the latest reply and who
      // replied leave out replies whose time has passed. One started before your history in this server starts
      // (server/joinhistory.js) isn't listed: you can't open it.
      if (!alive(root) || !history.visible(root, since)) continue;
      const msg = serializeMessage(root, c, reactions, since);
      const { unread, mentions, lastReadId, lastId } = threadState(req.userId, root.id, c, opts);
      if (!lastId) continue;
      threads.push({
        rootId: root.id, root: msg, replyCount: msg.threadCount || 0, lastReplyId: lastId, lastReplyAt: msg.threadLastAt || null,
        participants: db.prepare(Q.participants).all(root.id, now()).map((p) => p.author_id), unread, mentions, lastReadId,
      });
    }
    // The first page also carries the channel's thread pings, so opening the panel sets the channel's badge right.
    res.json({ threads, hasMore: rows.length > limit, next: page.length ? page[page.length - 1].last_reply_id : null,
      ...(before ? {} : { threadMentions: threadMentionsIn(req.userId, c.id, opts.floor, opts.suppressAll) }) });
  });

  // ---------------------------------------------------------------- notification preferences
  const prefRow = (uid, target) => db.prepare('SELECT level, mute_until, suppress_everyone FROM notify_prefs WHERE user_id = ? AND target = ?').get(uid, target) || null;
  const prefOut = (r) => ({ level: r.level, muteUntil: r.mute_until && r.mute_until > now() ? r.mute_until : null, suppressEveryone: !!r.suppress_everyone });
  const DND_DEFAULT = { on: false, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] };
  // Notification previews on push default to hidden: the lock screen then says only that something happened.
  function settingsOf(uid) {
    let d = {};
    try { d = JSON.parse((db.prepare('SELECT data FROM user_prefs WHERE user_id = ?').get(uid) || {}).data || '{}') || {}; } catch { /* defaults */ }
    return { dnd: { ...DND_DEFAULT, ...(d.dnd || {}) }, tz: typeof d.tz === 'string' ? d.tz : 'UTC', previews: d.previews === 'names' ? 'names' : 'hidden' };
  }
  const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
  // Is this person's Do Not Disturb schedule on at time t? Days are the days a quiet period starts on, so
  // 22:00–08:00 on Friday covers Saturday morning too.
  function dndActive(uid, t = now(), st = settingsOf(uid)) {
    const d = st.dnd;
    if (!d.on) return false;
    let parts;
    try { parts = new Intl.DateTimeFormat('en-US', { timeZone: st.tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(t)); } catch { return false; }
    const get = (type) => (parts.find((p) => p.type === type) || {}).value;
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
    const toMin = (s) => { const m = HHMM.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
    const start = toMin(d.start); const end = toMin(d.end);
    const on = (x) => d.days.includes((x + 7) % 7);
    if (start === end) return on(day);
    if (start < end) return on(day) && mins >= start && mins < end;
    return (on(day) && mins >= start) || (on(day - 1) && mins < end);
  }
  // Should this person get a push for this? kind: 'dm' | 'group' | 'mention' | 'everyone' | 'reply' | 'message'
  // (a plain channel message) | 'call' | 'event' | 'tracker'. Do Not Disturb (the status or the schedule) stops
  // everything; the conversation's and the server's preferences decide the rest. Channels push only pings unless
  // "All messages" was picked for the channel or its server.
  function pushAllowed(uid, { kind, serverId, channelId, dmId } = {}) {
    const row = getUserRow(uid);
    if (!row || row.status === 'dnd') return false;
    const st = settingsOf(uid);
    if (dndActive(uid, now(), st)) return false;
    // Calls, event reminders, tracker updates (and anything else that isn't a message): only quiet hours apply.
    if (!['dm', 'group', 'mention', 'everyone', 'reply', 'message'].includes(kind)) return true;
    const t = now();
    const cp = channelId ? prefRow(uid, 'c:' + channelId) : dmId ? prefRow(uid, 'd:' + dmId) : null;
    const sp = serverId ? prefRow(uid, 's:' + serverId) : null;
    if ((cp && cp.mute_until > t) || (sp && sp.mute_until > t)) return false;
    const pick = (r) => (r && r.level !== 'default' ? r.level : null);
    const level = pick(cp) || pick(sp) || 'default';
    if (level === 'none') return false;
    if (kind === 'everyone' && ((cp && cp.suppress_everyone) || (sp && sp.suppress_everyone))) return false;
    if (kind === 'message') return level === 'all';
    if (kind === 'group' && level === 'mentions') return false;
    return true;
  }
  // What one person's devices are sent. With previews hidden (the default) a lock screen shows only the
  // instance's name and "New message": not who, not where. Push never carries message text either way.
  function shapePush(uid, payload) {
    if (settingsOf(uid).previews === 'names') return payload;
    return { title: brandName(), body: payload.generic || 'New activity', tag: payload.tag, url: payload.url, at: payload.at };
  }
  // People who chose "All messages" for this channel or its server (and can see it): they get plain messages too.
  function wantsAll(srv, c) {
    return db.prepare("SELECT DISTINCT user_id FROM notify_prefs WHERE target IN (?, ?) AND level = 'all'").all('c:' + c.id, 's:' + srv.id).map((r) => r.user_id);
  }
  api.get('/me/notify', auth, (req, res) => {
    const prefs = {};
    db.prepare('SELECT * FROM notify_prefs WHERE user_id = ?').all(req.userId).forEach((r) => { prefs[r.target] = prefOut(r); });
    res.json({ prefs, settings: settingsOf(req.userId) });
  });
  api.put('/me/notify/:target', auth, (req, res) => {
    rateLimit('notify:' + req.userId, 120, 60000);
    const m = TARGET.exec(String(req.params.target || ''));
    if (!m) fail(400, 'Unknown conversation.');
    const ch = m[1] === 'c' ? requireChannel(m[2], req.userId) : null;
    if (m[1] === 's') requireServer(m[2], req.userId); else if (m[1] === 'd') requireDm(m[2], req.userId);
    const b = req.body || {};
    const cur = prefRow(req.userId, req.params.target) || { level: 'default', mute_until: null, suppress_everyone: 0 };
    let level = b.level === undefined ? cur.level : b.level === 'muted' ? 'none' : b.level;
    if (!LEVELS.includes(level)) fail(400, 'Pick all messages, only mentions, nothing, or the default.');
    let until = b.muteUntil === undefined ? cur.mute_until : b.muteUntil;
    if (until === null || until === 0 || until === false) until = null;
    else if (!Number.isSafeInteger(until) || until <= now() || until > now() + 366 * 86400000) fail(400, 'Mute for a time between now and a year from now.');
    const sup = b.suppressEveryone === undefined ? !!cur.suppress_everyone : !!b.suppressEveryone;
    if (level === 'default' && !until && !sup) db.prepare('DELETE FROM notify_prefs WHERE user_id = ? AND target = ?').run(req.userId, req.params.target);
    else {
      const exists = db.prepare('SELECT 1 FROM notify_prefs WHERE user_id = ? AND target = ?').get(req.userId, req.params.target);
      if (!exists && db.prepare('SELECT COUNT(*) n FROM notify_prefs WHERE user_id = ?').get(req.userId).n >= MAX_PREFS) fail(400, 'You have too many notification settings. Reset some to the default first.');
      db.prepare(`INSERT INTO notify_prefs (user_id, target, level, mute_until, suppress_everyone, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, target) DO UPDATE SET level = excluded.level, mute_until = excluded.mute_until, suppress_everyone = excluded.suppress_everyone, updated_at = excluded.updated_at`)
        .run(req.userId, req.params.target, level, until, sup ? 1 : 0, now());
    }
    const out = { target: req.params.target, level, muteUntil: until, suppressEveryone: sup };
    // v19 (voice chat): "All messages" for a voice channel's chat follows it, like opening it.
    if (ch && level === 'all') followVoiceChat(req.userId, ch);
    emitTo(req.userId, 'notify:update', out);
    res.json(out);
  });
  api.put('/me/notify-settings', auth, (req, res) => {
    rateLimit('notify:' + req.userId, 120, 60000);
    const b = req.body || {};
    const cur = settingsOf(req.userId);
    const next = { ...cur };
    if (b.dnd !== undefined) {
      const d = b.dnd || {};
      if (d.start !== undefined && !HHMM.test(String(d.start))) fail(400, 'Times look like 22:00.');
      if (d.end !== undefined && !HHMM.test(String(d.end))) fail(400, 'Times look like 22:00.');
      const days = d.days === undefined ? cur.dnd.days : (Array.isArray(d.days) ? [...new Set(d.days.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : null);
      if (!days) fail(400, 'Pick the days for quiet hours.');
      next.dnd = { on: d.on === undefined ? cur.dnd.on : !!d.on, start: d.start === undefined ? cur.dnd.start : String(d.start), end: d.end === undefined ? cur.dnd.end : String(d.end), days };
    }
    if (b.tz !== undefined) {
      if (typeof b.tz !== 'string' || b.tz.length > 64 || !validTz(b.tz)) fail(400, 'Unknown time zone.');
      next.tz = b.tz;
    }
    if (b.previews !== undefined) {
      if (!['hidden', 'names'].includes(b.previews)) fail(400, 'Previews are hidden or names.');
      next.previews = b.previews;
    }
    db.prepare(`INSERT INTO user_prefs (user_id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(req.userId, JSON.stringify(next), now());
    emitTo(req.userId, 'notify:settings', next);
    res.json({ ...next, dndActive: dndActive(req.userId, now(), next) });
  });

  // ---------------------------------------------------------------- pins: history per channel
  function logPin(channelId, messageId, userId, action) {
    db.prepare('INSERT INTO pin_log (id, channel_id, message_id, user_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), channelId, messageId, userId, action, now());
  }
  // Someone whose history in the server starts later (server/joinhistory.js) doesn't get the entries about messages
  // from before then (message ids start with the time they were written), nor about ones they're kept from by the
  // same rules as everywhere else (locked with a key from before theirs, a reply in a thread from before). An entry
  // about a message deleted since goes by its id alone.
  api.get('/channels/:id/pins/log', auth, (req, res) => {
    const c = requireChannel(req.params.id, req.userId);
    const since = history.startOf(c.server_id, req.userId);
    const hist = history.where(since, { alias: 'm.', threads: true });
    const rows = since
      ? db.prepare(`SELECT l.message_id, l.user_id, l.action, l.created_at FROM pin_log l LEFT JOIN messages m ON m.id = l.message_id
          WHERE l.channel_id = ? AND l.message_id >= ? AND (m.id IS NULL OR (1${hist.sql})) ORDER BY l.created_at DESC LIMIT 50`).all(c.id, since.floor, ...hist.args)
      : db.prepare('SELECT message_id, user_id, action, created_at FROM pin_log WHERE channel_id = ? ORDER BY created_at DESC LIMIT 50').all(c.id);
    res.json(rows.map((r) => ({ messageId: r.message_id, userId: r.user_id, action: r.action, at: r.created_at })));
  });

  // ---------------------------------------------------------------- timeouts
  // A timed-out member keeps reading but can't post, react, start threads or talk in calls until it ends (see
  // TALK in perms.js, which every permission check goes through). Needs Kick Members, and only works on people
  // whose highest role is below yours. Owners and Administrators can't be timed out.
  function timeoutTarget(req) {
    const s = requirePerm(req.params.id, req.userId, PM.KICK_MEMBERS, 'You need the Kick Members permission.');
    if (s.kind === 'group') fail(400, 'Group chats don’t have timeouts.');
    const uid = idParam(req.params.uid, 'member');
    if (uid === req.userId) fail(400, 'You can’t time yourself out.');
    if (!isMember(s.id, uid)) fail(404, 'That person is not in this server.');
    if (uid === s.owner_id) fail(403, 'You can’t time out the owner.');
    if (perms.top(s, uid) >= perms.top(s, req.userId)) fail(403, 'You can only time out people whose highest role is below yours.');
    return { s, uid };
  }
  const expiry = new Map(); // `${serverId}|${userId}` -> timer
  function scheduleEnd(serverId, uid, until) {
    const k = `${serverId}|${uid}`;
    clearTimeout(expiry.get(k));
    const wait = until - now();
    if (wait > 2 ** 31 - 1) return; // the minute sweep catches long ones
    expiry.set(k, setTimeout(jobs.job('usability.end_timeouts', () => { expiry.delete(k); endExpired(); }), Math.max(0, wait) + 50).unref());
  }
  function endExpired() {
    const gone = db.prepare('SELECT server_id, user_id FROM member_timeouts WHERE until <= ?').all(now());
    if (!gone.length) return;
    db.prepare('DELETE FROM member_timeouts WHERE until <= ?').run(now());
    for (const g of gone) emitTo(g.user_id, 'timeout:update', { serverId: g.server_id, until: null });
    [...new Set(gone.map((g) => g.server_id))].forEach((sid) => emitServer(sid));
  }
  // Read markers, preferences and disappearing-timer history for channels and DMs that no longer exist (deleted
  // channels and servers).
  function sweepStale() {
    for (const t of [['read_states', 'conv'], ['notify_prefs', 'target'], ['disappear_log', 'conv']]) {
      db.prepare(`DELETE FROM ${t[0]} WHERE ${t[1]} LIKE 'c:%' AND NOT EXISTS (SELECT 1 FROM channels WHERE id = substr(${t[0]}.${t[1]}, 3))`).run();
      db.prepare(`DELETE FROM ${t[0]} WHERE ${t[1]} LIKE 'd:%' AND NOT EXISTS (SELECT 1 FROM dm_channels WHERE id = substr(${t[0]}.${t[1]}, 3))`).run();
    }
    db.prepare("DELETE FROM notify_prefs WHERE target LIKE 's:%' AND NOT EXISTS (SELECT 1 FROM servers WHERE id = substr(notify_prefs.target, 3))").run();
    // Thread markers for threads that were deleted, and "every thread read up to" markers for deleted channels.
    db.prepare("DELETE FROM read_states WHERE conv LIKE 't:%' AND NOT EXISTS (SELECT 1 FROM messages WHERE id = substr(read_states.conv, 3))").run();
    db.prepare("DELETE FROM read_states WHERE conv LIKE 'ct:%' AND NOT EXISTS (SELECT 1 FROM channels WHERE id = substr(read_states.conv, 4))").run();
    db.prepare("DELETE FROM read_states WHERE conv LIKE 'cp:%' AND NOT EXISTS (SELECT 1 FROM channels WHERE id = substr(read_states.conv, 4))").run();
  }
  // Safe jobs (errors logged and shown in Admin → Health, never a crash).
  jobs.every('usability.end_timeouts', 60000, endExpired, { firstDelay: 5000 });
  jobs.every('usability.sweep_stale', 24 * 3600000, sweepStale, { firstDelay: 90000 });
  api.get('/servers/:id/timeouts', auth, (req, res) => {
    const s = requirePerm(req.params.id, req.userId, PM.KICK_MEMBERS, 'You need the Kick Members permission.');
    res.json(db.prepare('SELECT user_id, until, reason, by_id, created_at FROM member_timeouts WHERE server_id = ? AND until > ? ORDER BY until').all(s.id, now())
      .map((r) => ({ userId: r.user_id, until: r.until, reason: r.reason, byId: r.by_id, at: r.created_at })));
  });
  api.post('/servers/:id/members/:uid/timeout', auth, (req, res) => {
    rateLimit('timeout:' + req.userId, 30, 60000);
    const { s, uid } = timeoutTarget(req);
    if (perms.base(s, uid) === ALL) fail(403, 'Administrators can’t be timed out.');
    const minutes = Number((req.body || {}).minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MIN) fail(400, 'A timeout lasts from 1 minute to 28 days.');
    const reason = String((req.body || {}).reason || '').slice(0, 300);
    const until = now() + minutes * 60000;
    db.prepare(`INSERT INTO member_timeouts (server_id, user_id, until, reason, by_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, user_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, by_id = excluded.by_id, created_at = excluded.created_at`)
      .run(s.id, uid, until, reason, req.userId, now());
    auditLog(req, 'member_timeout', uid, `in server "${s.name}" (${s.id}) for ${minutes} min${reason ? `: ${reason}` : ''}`);
    serverAudit(s, req.userId, 'member_timeout', uid, { minutes, until, reason: reason || undefined });
    scheduleEnd(s.id, uid, until);
    emitServer(s.id);
    emitTo(uid, 'timeout:update', { serverId: s.id, until, reason });
    res.json({ ok: true, until });
  });
  api.delete('/servers/:id/members/:uid/timeout', auth, (req, res) => {
    rateLimit('timeout:' + req.userId, 30, 60000);
    const { s, uid } = timeoutTarget(req);
    const had = db.prepare('DELETE FROM member_timeouts WHERE server_id = ? AND user_id = ?').run(s.id, uid).changes;
    if (had) {
      auditLog(req, 'member_timeout_removed', uid, `in server "${s.name}" (${s.id})`);
      serverAudit(s, req.userId, 'member_timeout_remove', uid);
      emitServer(s.id);
      emitTo(uid, 'timeout:update', { serverId: s.id, until: null });
    }
    res.json({ ok: true });
  });
  const timeoutOf = (serverId, uid) => (db.prepare('SELECT until, reason FROM member_timeouts WHERE server_id = ? AND user_id = ? AND until > ?').get(serverId, uid, now()) || null);

  // ---------------------------------------------------------------- your reports
  // What you reported and whether staff have looked at it. Staff notes stay with staff.
  api.get('/me/reports', auth, (req, res) => {
    res.json(db.prepare('SELECT id, category, status, created_at, handled_at, target_id, context FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 100').all(req.userId)
      .map((r) => { let c = {}; try { c = JSON.parse(r.context || '{}'); } catch { /* none */ }
        return { id: r.id, category: r.category, status: r.status, createdAt: r.created_at, handledAt: r.handled_at, targetName: r.target_id ? nameOf(r.target_id) : null, kind: c.kind || 'user' }; }));
  });

  // ---------------------------------------------------------------- export my data
  // Starting an export needs the password (and a two-factor code when that's on). It gives a token that works
  // for 30 minutes, only from the session that asked, for at most EXPORT_MAX_MESSAGES messages. The server hands
  // out what this account can already read (ciphertext); the app decrypts it and packs the download. Since that's
  // nothing the session couldn't fetch anyway, a two-factor sign-in in the last 10 minutes counts (grace, auth-6).
  const exportsByToken = new Map();
  setInterval(() => { const t = now(); for (const [k, e] of exportsByToken) if (e.expires < t) exportsByToken.delete(k); }, 60000).unref();
  function requireExport(req) {
    const tok = String(req.headers['x-export-token'] || '');
    const e = /^[a-f0-9]{64}$/.test(tok) && exportsByToken.get(crypto.createHash('sha256').update(tok).digest('hex'));
    if (!e || e.userId !== req.userId || e.sessionId !== req.session.id || e.expires < now()) fail(403, 'Start the export again from Settings (it needs your password).', 'export_token');
    return e;
  }
  api.post('/me/export', auth, wrap(async (req, res) => {
    rateLimit('export:' + req.userId, 5, 3600000);
    await stepUp(req, req.body, 'authKey', { grace: true });
    const token = crypto.randomBytes(32).toString('hex');
    const expires = now() + EXPORT_TTL;
    // Only a hash is kept, like session tokens.
    exportsByToken.set(crypto.createHash('sha256').update(token).digest('hex'), { userId: req.userId, sessionId: req.session.id, expires, served: 0 });
    auditLog(req, 'data_export', req.userId, 'started');
    res.json({ token, expiresAt: expires, maxMessages: EXPORT_MAX_MESSAGES });
  }));
  api.get('/me/export/account', auth, (req, res) => {
    requireExport(req);
    const uid = req.userId;
    const me = getUserRow(uid);
    const person = (id) => { const r = getUserRow(id); return r ? { id: r.id, username: r.username, displayName: nameOf(id) } : { id }; };
    const servers = db.prepare('SELECT s.*, m.joined_at, m.nickname AS my_nickname FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY m.joined_at').all(uid).map((s) => ({
      id: s.id, name: s.name, kind: s.kind || 'server', joinedAt: s.joined_at, owner: s.owner_id === uid, nickname: s.my_nickname || undefined,
      roles: db.prepare('SELECT r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?').all(s.id, uid).map((r) => r.name),
      // Voice channels' chats (v19) are conversations too, and export like text channels.
      channels: chatChannels(s).sort((a, b) => a.position - b.position || a.created_at - b.created_at)
        .filter((c) => perms.channel(s, c, uid) & PM.VIEW_CHANNEL).map((c) => ({ id: c.id, name: c.name, type: c.type, topic: c.topic || '' })),
      members: s.kind === 'group' ? db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(s.id).map((r) => person(r.user_id)) : undefined,
    }));
    const dms = db.prepare('SELECT * FROM dm_channels WHERE user_a = ? OR user_b = ?').all(uid, uid).map((d) => ({ id: d.id, with: person(d.user_a === uid ? d.user_b : d.user_a), createdAt: d.created_at }));
    const friends = db.prepare('SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?').all(uid, uid)
      .map((f) => ({ user: person(f.requester_id === uid ? f.addressee_id : f.requester_id), status: f.status, direction: f.requester_id === uid ? 'outgoing' : 'incoming' }));
    const blocked = db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?').all(uid).map((r) => person(r.blocked_id));
    const saved = db.prepare('SELECT message_id, note, created_at FROM saved_messages WHERE user_id = ? ORDER BY created_at DESC').all(uid).map((r) => ({ messageId: r.message_id, note: r.note, savedAt: r.created_at }));
    const notify = {};
    db.prepare('SELECT * FROM notify_prefs WHERE user_id = ?').all(uid).forEach((r) => { notify[r.target] = prefOut(r); });
    const self = selfUser(me);
    res.json({
      exportedAt: now(), instance: brandName(),
      account: { id: me.id, username: me.username, createdAt: me.created_at, email: self.email || null, status: me.status, privacy: self.privacy },
      profile: { displayName: (self.profile || {}).displayName || '', profile: self.profile, avatar: me.avatar, banner: me.banner, song: me.song || null },
      servers, dms, friends, blocked, saved, notifications: { prefs: notify, settings: settingsOf(uid) },
      readStates: db.prepare('SELECT conv, last_read_id, updated_at FROM read_states WHERE user_id = ?').all(uid).map((r) => ({ conv: r.conv, lastReadId: r.last_read_id, at: r.updated_at })),
      reports: db.prepare('SELECT id, category, status, created_at FROM reports WHERE reporter_id = ?').all(uid).map((r) => ({ id: r.id, category: r.category, status: r.status, createdAt: r.created_at })),
      limits: { maxMessages: EXPORT_MAX_MESSAGES },
    });
  });
  api.get('/me/export/messages', auth, (req, res) => {
    const e = requireExport(req);
    rateLimit('export-page:' + req.userId, 600, 60000);
    const a = convAccess(req.userId, String(req.query.conv || ''));
    const after = req.query.after ? idParam(String(req.query.after)) : '';
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 200));
    if (e.served >= EXPORT_MAX_MESSAGES) fail(413, 'This export reached its size limit.', 'export_limit');
    const n = Math.min(limit, EXPORT_MAX_MESSAGES - e.served);
    // Channels include thread replies (with threadId), so a thread exports with its channel.
    // Disappearing messages whose time has passed aren't handed out (the sweep deletes them soon), nor are messages
    // from before your history in that server starts (server/joinhistory.js).
    const t = now();
    const since = a.kind === 'c' ? history.startOf(a.server.id, req.userId) : null;
    const hist = history.where(since, { alias: 'messages.', threads: true }); // replies in a thread from before too
    const rows = a.kind === 'c'
      ? db.prepare(`SELECT * FROM messages WHERE channel_id = ?${hist.sql} AND ${LIVE} AND id > ? ORDER BY id ASC LIMIT ?`).all(a.channel.id, ...hist.args, t, after, n)
      : db.prepare(`SELECT * FROM dm_messages WHERE dm_id = ? AND ${LIVE} AND id > ? ORDER BY id ASC LIMIT ?`).all(a.dm.id, t, after, n);
    e.served += rows.length;
    const reactions = reactionsFor(rows.map((r) => r.id));
    res.json({ messages: rows.map((r) => (a.kind === 'c' ? serializeMessage(r, a.channel, reactions, since) : serializeDmMessage(r, reactions))), hasMore: rows.length === n, served: e.served });
  });

  return { pushAllowed, shapePush, wantsAll, recordMentions, markSent, markThreadSent, threadStateWithBadge, threadStates, logPin, timeoutOf, dndActive, settingsOf };
};
