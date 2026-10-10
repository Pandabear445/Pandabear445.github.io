// Message usability and notifications (schema v18): saved messages, read state and unread counts, notification
// preferences (and the push decisions that follow them), pin history, member timeouts, and "Export my data".
//
// Message contents stay end-to-end encrypted. Everything here works on ids and times:
//   - a saved message is its id plus, optionally, a note the app encrypts with the person's own vault key (x1:);
//   - read state is the id of the last message read in each conversation;
//   - mention counts come from mention_marks, the user ids the sender's app already sends so the server can push;
//   - the export hands out ciphertext, and the app decrypts it and builds the download on the device.
//
// Routes
//   GET    /me/saved                saved messages, newest first (?before=<savedAt>&limit=)
//   GET    /me/saved/ids            just the ids (to draw the bookmark state)
//   PUT    /me/saved/:id            save (or change the note of) a message you can see
//   DELETE /me/saved/:id            unsave (works for messages that are gone too)
//   GET    /me/unread               per conversation: last read, last message, unread and mention counts
//   POST   /me/read                 { conv, messageId, unread? } — move your read marker (synced to your devices)
//   POST   /servers/:id/read        mark every channel you can see in a server as read
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

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONV = /^([cd]):([A-Za-z0-9_-]{1,64})$/;
const TARGET = /^([scd]):([A-Za-z0-9_-]{1,64})$/;
const NOTE = /^x1:[A-Za-z0-9+/=:_-]{16,8000}$/;
const LEVELS = ['default', 'all', 'mentions', 'none'];
const MAX_SAVED = 1000;
const MAX_PREFS = 2000;
const COUNT_CAP = 100; // counts past this show as "99+" anyway
const MAX_TIMEOUT_MIN = 28 * 24 * 60;
const EXPORT_TTL = 30 * 60 * 1000;
const EXPORT_MAX_MESSAGES = 200000; // per export, across all conversations
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

module.exports = function setupUsability(ctx) {
  const { api, auth, db, fail, wrap, rateLimit, stepUp, auditLog, perms, PM, ALL, newId, now, emitTo, emitServer, brandName,
    requireServer, requirePerm, requireChannel, requireDm, isMember, serverOf, serializeMessage, serializeDmMessage, reactionsFor,
    getUserRow, selfUser, nameOf } = ctx;

  // ---------------------------------------------------------------- helpers
  const idParam = (v, what = 'message') => { if (typeof v !== 'string' || !ID.test(v)) fail(404, `That ${what} doesn’t exist.`); return v; };
  // A conversation key you can read right now, or 404. { kind: 'c', channel, server } | { kind: 'd', dm }
  function convAccess(uid, conv) {
    const m = typeof conv === 'string' && CONV.exec(conv);
    if (!m) fail(400, 'Unknown conversation.');
    if (m[1] === 'c') { const channel = requireChannel(m[2], uid); return { kind: 'c', channel, server: serverOf(channel), conv }; }
    return { kind: 'd', dm: requireDm(m[2], uid), conv };
  }
  // Where a message lives, if the person can still see it there; null otherwise (never throws).
  function visibleMessage(uid, messageId) {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (m) {
      try { const c = requireChannel(m.channel_id, uid); return { conv: 'c:' + c.id, row: m, channel: c }; } catch { return null; }
    }
    const d = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(messageId);
    if (d) {
      try { requireDm(d.dm_id, uid); return { conv: 'd:' + d.dm_id, row: d }; } catch { return null; }
    }
    return null;
  }
  const serialize = (v, reactions) => (v.channel ? serializeMessage(v.row, v.channel, reactions) : serializeDmMessage(v.row, reactions));

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
  const Q = {
    lastC: 'SELECT id FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT 1',
    lastD: 'SELECT id FROM dm_messages WHERE dm_id = ? ORDER BY id DESC LIMIT 1',
    unreadC: countSql('SELECT 1 FROM messages WHERE channel_id = ? AND thread_id IS NULL AND id > ? AND author_id != ?'),
    unreadD: countSql('SELECT 1 FROM dm_messages WHERE dm_id = ? AND id > ? AND author_id != ?'),
    marks: countSql("SELECT 1 FROM mention_marks WHERE conv = ? AND (user_id = ? OR (user_id = '*' AND ? = 1)) AND message_id > ?"),
  };
  function convState(uid, conv, lastReadId, { group = false, suppressAll = false } = {}) {
    const [, kind, id] = CONV.exec(conv);
    const last = db.prepare(kind === 'c' ? Q.lastC : Q.lastD).get(id);
    const st = { lastReadId, lastId: last ? last.id : null, unread: 0, mentions: 0 };
    if (!last || last.id <= lastReadId) return st;
    st.unread = db.prepare(kind === 'c' ? Q.unreadC : Q.unreadD).get(id, lastReadId, uid).n;
    // Direct messages and group chats count every message, like a mention; channels count real pings.
    st.mentions = kind === 'd' || group ? st.unread : db.prepare(Q.marks).get(conv, uid, suppressAll ? 0 : 1, lastReadId).n;
    return st;
  }
  function unreadFor(uid) {
    const baseline = baselineOf(uid);
    const states = new Map(db.prepare('SELECT conv, last_read_id FROM read_states WHERE user_id = ?').all(uid).map((r) => [r.conv, r.last_read_id]));
    const out = {};
    for (const s of db.prepare('SELECT s.* FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ?').all(uid)) {
      const group = s.kind === 'group';
      const sp = prefRow(uid, 's:' + s.id);
      for (const c of db.prepare("SELECT * FROM channels WHERE server_id = ? AND type = 'text'").all(s.id)) {
        if (!(perms.channel(s, c, uid) & PM.VIEW_CHANNEL)) continue;
        const conv = 'c:' + c.id;
        const cp = prefRow(uid, conv);
        out[conv] = convState(uid, conv, states.get(conv) || baseline, { group, suppressAll: !!((cp && cp.suppress_everyone) || (sp && sp.suppress_everyone)) });
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
    const a = convAccess(req.userId, b.conv);
    const back = b.unread === true;
    const id = String(b.messageId || '');
    if (id === '0') { if (!back) fail(400, 'Pick a message.'); } else {
      idParam(id);
      const there = a.kind === 'c'
        ? db.prepare('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?').get(id, a.channel.id)
        : db.prepare('SELECT 1 FROM dm_messages WHERE id = ? AND dm_id = ?').get(id, a.dm.id);
      if (!there) fail(404, 'That message doesn’t exist.');
    }
    const lastReadId = setRead(req.userId, a.conv, id, back);
    const st = convState(req.userId, a.conv, lastReadId, { group: a.server && a.server.kind === 'group' });
    emitTo(req.userId, 'read:update', { conv: a.conv, ...st });
    res.json({ conv: a.conv, ...st });
  });
  api.post('/servers/:id/read', auth, (req, res) => {
    rateLimit('read:' + req.userId, 240, 60000);
    const s = requireServer(req.params.id, req.userId);
    const changed = [];
    db.transaction(() => {
      for (const c of db.prepare("SELECT * FROM channels WHERE server_id = ? AND type = 'text'").all(s.id)) {
        if (!(perms.channel(s, c, req.userId) & PM.VIEW_CHANNEL)) continue;
        const last = db.prepare(Q.lastC).get(c.id);
        if (!last) continue;
        changed.push({ conv: 'c:' + c.id, lastReadId: setRead(req.userId, 'c:' + c.id, last.id), lastId: last.id, unread: 0, mentions: 0 });
      }
    })();
    changed.forEach((st) => emitTo(req.userId, 'read:update', st));
    res.json({ ok: true, states: changed });
  });
  // Sending a message means you've seen the conversation up to it (no event: your other devices get the message).
  function markSent(uid, conv, id) { try { setRead(uid, conv, id); } catch { /* never block a send */ } }

  // Who a channel message pings, kept so counts survive a reload. Only top-level messages count toward a
  // channel's mentions (thread replies still push and show in the inbox).
  function recordMentions(messageId, conv, userIds, everyone) {
    const ins = db.prepare('INSERT OR IGNORE INTO mention_marks (message_id, conv, user_id) VALUES (?, ?, ?)');
    db.transaction(() => {
      for (const u of new Set(userIds)) ins.run(messageId, conv, u);
      if (everyone) ins.run(messageId, conv, '*');
    })();
  }

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
    return { title: brandName(), body: payload.generic || 'New activity', tag: payload.tag, url: payload.url };
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
    if (m[1] === 's') requireServer(m[2], req.userId); else if (m[1] === 'c') requireChannel(m[2], req.userId); else requireDm(m[2], req.userId);
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
  api.get('/channels/:id/pins/log', auth, (req, res) => {
    const c = requireChannel(req.params.id, req.userId);
    res.json(db.prepare('SELECT message_id, user_id, action, created_at FROM pin_log WHERE channel_id = ? ORDER BY created_at DESC LIMIT 50').all(c.id)
      .map((r) => ({ messageId: r.message_id, userId: r.user_id, action: r.action, at: r.created_at })));
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
    expiry.set(k, setTimeout(() => { expiry.delete(k); endExpired(); }, Math.max(0, wait) + 50).unref());
  }
  function endExpired() {
    const gone = db.prepare('SELECT server_id, user_id FROM member_timeouts WHERE until <= ?').all(now());
    if (!gone.length) return;
    db.prepare('DELETE FROM member_timeouts WHERE until <= ?').run(now());
    for (const g of gone) emitTo(g.user_id, 'timeout:update', { serverId: g.server_id, until: null });
    [...new Set(gone.map((g) => g.server_id))].forEach((sid) => emitServer(sid));
  }
  setInterval(endExpired, 60000).unref();
  // Read markers and preferences for channels and DMs that no longer exist (deleted channels and servers).
  function sweepStale() {
    for (const t of [['read_states', 'conv'], ['notify_prefs', 'target']]) {
      db.prepare(`DELETE FROM ${t[0]} WHERE ${t[1]} LIKE 'c:%' AND NOT EXISTS (SELECT 1 FROM channels WHERE id = substr(${t[0]}.${t[1]}, 3))`).run();
      db.prepare(`DELETE FROM ${t[0]} WHERE ${t[1]} LIKE 'd:%' AND NOT EXISTS (SELECT 1 FROM dm_channels WHERE id = substr(${t[0]}.${t[1]}, 3))`).run();
    }
    db.prepare("DELETE FROM notify_prefs WHERE target LIKE 's:%' AND NOT EXISTS (SELECT 1 FROM servers WHERE id = substr(notify_prefs.target, 3))").run();
  }
  setTimeout(() => { try { sweepStale(); } catch (e) { console.error('Read-state cleanup failed:', e.message); } }, 90000).unref();
  setInterval(() => { try { sweepStale(); } catch (e) { console.error('Read-state cleanup failed:', e.message); } }, 24 * 3600000).unref();
  setTimeout(endExpired, 5000).unref();
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
  // out what this account can already read (ciphertext); the app decrypts it and packs the download.
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
    await stepUp(req, req.body);
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
    const servers = db.prepare('SELECT s.*, m.joined_at FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY m.joined_at').all(uid).map((s) => ({
      id: s.id, name: s.name, kind: s.kind || 'server', joinedAt: s.joined_at, owner: s.owner_id === uid,
      roles: db.prepare('SELECT r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?').all(s.id, uid).map((r) => r.name),
      channels: db.prepare("SELECT * FROM channels WHERE server_id = ? AND type = 'text' ORDER BY position, created_at").all(s.id)
        .filter((c) => perms.channel(s, c, uid) & PM.VIEW_CHANNEL).map((c) => ({ id: c.id, name: c.name, topic: c.topic || '' })),
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
    const rows = a.kind === 'c'
      ? db.prepare('SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(a.channel.id, after, n)
      : db.prepare('SELECT * FROM dm_messages WHERE dm_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(a.dm.id, after, n);
    e.served += rows.length;
    const reactions = reactionsFor(rows.map((r) => r.id));
    res.json({ messages: rows.map((r) => (a.kind === 'c' ? serializeMessage(r, a.channel, reactions) : serializeDmMessage(r, reactions))), hasMore: rows.length === n, served: e.served });
  });

  return { pushAllowed, shapePush, wantsAll, recordMentions, markSent, logPin, timeoutOf, dndActive, settingsOf };
};
