// Each server's own audit log, and its moderators' report inbox (v19).
//
// Audit log: once a server has more than one moderator, its owner needs to answer "who kicked Sam?" or "who changed
// #general's permissions?" without asking the instance's staff. Every moderation action and settings change inside
// a server is written here: kicks, bans and unbans (with how many messages a ban's cleanup deleted), timeouts, role
// changes (self-picked ones marked as such), nicknames (server/nicknames.js: old and new, which every member could
// see anyway; not shown once that person's account is deleted), roles, channels, channel permissions, invites,
// emoji, webhooks, bots,
// voice moderation, moderators deleting other people's messages (one at a time or in bulk), pins, server settings,
// the server's suggested word filter (server/wordfilter.js: what was added and removed) and ownership. Many of
// these also go to the instance audit log (admin_log) as before; this is the server's own copy.
//   - Metadata only: who, what, to whom, where and when. Never what a message said (the server can't read it anyway).
//   - Read by people with View Audit Log, Administrators and the owner. A channel's name is shown only to readers who
//     can see that channel now, and what an entry says about a channel they can't see (its old name, its webhooks,
//     its permissions) is left out. A deleted channel counts as private if it was when it was deleted (its
//     channel_delete entry says), whatever it was when older entries were written; then only Administrators see its
//     name. Invite codes are shown whole only to people with Manage Server, who can list the server's invites anyway.
//   - Handling reports isn't written here: the person reported (or anyone who can't see the report) could read it,
//     or, if those entries were hidden from them, spot the gap they leave in the numbering. Who handled a report,
//     when and with what note stays on the report, for the moderators who can see it (Reports tab).
//   - Append-only in the database (triggers in db.js). Kept for a year, and at most the newest 10,000 entries per
//     server, but never less than the last 7 days (so a flood of new entries can't push recent ones out). Disk use
//     is capped too: beyond the newest 50,000, the kinds anyone can cause cheaply go whatever their age (moderation
//     stays), and beyond 200,000 everything does. The hourly job below prunes; the triggers refuse any other delete.
//     Making invites and revoking your own are written at most 10 times an hour per person (the last says so), like
//     roles members pick themselves (server/selfroles.js), so throwaway accounts can't bury the log with them.
//   - Open Audit log tabs ask to hear about new entries (audit:watch) and fetch them (?after=), so each reader gets
//     exactly what their own permissions allow. Who may still read is checked again every time. Notices go out at
//     most every 2 seconds per server, and live fetches have their own allowance, so a burst of entries doesn't use
//     up the reader's.
//
// Report inbox: a report about a message in one of a server's channels, or about a member that someone reported from
// inside a server, also goes to that server's moderators (Manage Messages in that channel, or Kick or Ban Members and
// able to see it), unless the reporter unticked it. They see what instance staff see minus who reported it (and any
// IP addresses or report counts from elsewhere): the category, the reporter's note, and of the messages the reporter
// chose to include (which their app decrypted), the reported person's own. The reporter's would give them away, even
// by being the ones missing, so everyone else's go to instance staff only; moderators can read the channel anyway.
// Like every other action on a member, only reports about people below your highest role (never about you).
// Moderators mark them handled or dismissed; that's their own status, so instance staff still see every report and
// handle it on their own. Child-safety reports go to instance staff only.
//
// Routes
//   GET   /servers/:id/audit           ?before=&after=&limit=&action=a,b&actor=&target=&user=&username=   (View Audit Log)
//         -> { entries, users, hasMore, next }: next is where the following page starts (?before=next)
//   GET   /servers/:id/reports         ?status=open|handled|dismissed|all&before=               (moderators)
//   PATCH /servers/:id/reports/:rid    { status: 'open'|'handled'|'dismissed', note }
// Socket
//   audit:watch { serverId, on }   -> audit:new { serverId } while that reader may still read it
//   server:report { serverId, id, status, fresh? } to the moderators who can see that report (a new one, or one changed)
const jobs = require('./jobs');
const log = require('./log');
const { parseProfile } = require('./profile');

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEEP = 10000; // newest entries kept per server
const CEILING = 50000; // beyond this, the cheap kinds go however recent (db.js: SERVER_AUDIT_KEPT says which stay)
const HARD = 200000; // and beyond this, everything
const MAX_AGE = 365 * 24 * 3600 * 1000;
const GRACE = 7 * 24 * 3600 * 1000; // never pruned for count before this age (below the ceilings)
const NOTIFY_MS = 2000; // audit:new at most this often per server
const CHEAP_MAX = 10; // entries an hour per person and server for the kinds recordCapped() takes
const ACTIONS = [
  'server_update', 'server_transfer', 'category_reorder', 'category_rename',
  'channel_create', 'channel_update', 'channel_delete', 'channel_reorder', 'channel_overrides',
  'role_create', 'role_update', 'role_delete', 'role_reorder',
  'member_kick', 'member_ban', 'member_unban', 'member_timeout', 'member_timeout_remove', 'member_roles', 'member_nickname',
  'message_delete', 'message_bulk_delete', 'message_pin', 'message_unpin',
  'invite_create', 'invite_revoke', 'emoji_create', 'emoji_rename', 'emoji_delete',
  'webhook_create', 'webhook_update', 'webhook_rotate', 'webhook_delete', 'bot_add', 'bot_update', 'bot_remove',
  'voice_disconnect', 'voice_move', 'voice_mute', 'voice_unmute', 'word_filter_update',
];
// Detail keys that hold a channel ({ id, name, private }), shown only to readers who can see it.
const CHANNEL_KEYS = ['channel', 'toChannel'];
// What's left of an entry about a channel the reader can't see: counts and kinds, nothing that names anything.
const SAFE_KEYS = ['count', 'replies', 'kept', 'type', 'thread', 'staff'];
// Report categories instance staff handle alone: the evidence isn't passed around any further.
const STAFF_ONLY = ['child_safety'];

// Long lists are cut (the entry says how many more there were) and so are long strings, so one entry stays small.
// Still too long (long items in a list): fewer items from each list, the count of the rest kept, until it fits, so
// an entry always says as much as it can and never less than its counts and plain values.
const DETAIL_MAX = 8000;
function trim(d) {
  const out = {};
  const lists = [];
  for (const [k, v] of Object.entries(d || {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) { out[k] = v.slice(0, 25); if (v.length > 25) out[`${k}More`] = v.length - 25; lists.push([k, v.length]); }
    else if (typeof v === 'string') out[k] = v.slice(0, 300);
    else out[k] = v;
  }
  let json = JSON.stringify(out);
  for (const n of [12, 6, 3, 1, 0]) {
    if (json.length <= DETAIL_MAX) return json;
    for (const [k, len] of lists) {
      out[k] = out[k].slice(0, n);
      if (len > out[k].length) out[`${k}More`] = len - out[k].length;
    }
    json = JSON.stringify(out);
  }
  if (json.length <= DETAIL_MAX) return json;
  // Something else is too long: keep what's small (numbers, flags, short words) and say it was cut.
  const small = { truncated: true };
  for (const [k, v] of Object.entries(out)) if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 64)) small[k] = v;
  return JSON.stringify(small);
}

module.exports = function setupServerAudit(ctx) {
  // keptSql: db.js's serverAuditKeptSql, the moderation kinds the 50,000 ceiling leaves alone.
  const { api, auth, db, fail, rateLimit, perms, PM, ALL, requireServer, isMember, getIo, keptSql, history = null } = ctx;
  const MOD = PM.MANAGE_MESSAGES | PM.KICK_MEMBERS | PM.BAN_MEMBERS;
  const serverRow = (id) => db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  const int = (v, what) => {
    if (v === undefined || v === '') return null;
    if (!/^\d{1,15}$/.test(String(v))) fail(400, `${what} must be a number.`);
    return +v;
  };
  const idParam = (v, what) => {
    if (v === undefined || v === '') return null;
    if (typeof v !== 'string' || !ID.test(v)) fail(400, `Unknown ${what}.`);
    return v;
  };

  // ------------------------------------------------------------------ writing
  // A channel as entries keep it: its name then, and whether some members couldn't see it (then only people who
  // can see it now, or Administrators once it's gone, read the name).
  const channelRef = (s, c) => (c ? { id: c.id, name: c.name, ...(perms.restricted(s, c) ? { private: true } : {}) } : null);
  // Adds an entry. server: a servers row or id; actorId: who did it (null: Hearth itself, or instance staff, which
  // the detail says with staff: true); targetId: the person, role, channel, emoji, invite code or webhook it was done
  // to; channelId: the channel it happened in, if any. Group chats have no audit log. A failure here is logged and
  // swallowed: what it records has already happened, and the person doing it shouldn't see an error for that.
  function record(server, actorId, action, targetId = null, detail = {}, channelId = null) {
    try {
      const s = typeof server === 'string' ? serverRow(server) : server;
      if (!s || s.kind === 'group') return;
      db.prepare(`INSERT INTO server_audit (server_id, seq, actor_id, action, target_id, channel_id, detail, created_at)
        SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ? FROM server_audit WHERE server_id = ?`)
        .run(s.id, actorId || null, action, targetId || null, channelId || null, trim(detail), Date.now(), s.id);
      notify(s.id);
    } catch (e) {
      log.error('serveraudit', 'write_failed', e, { action, outcome: 'error' });
    }
  }
  // For what any member can do cheaply and over and over (making invites, revoking their own): at most CHEAP_MAX
  // entries per person, server and kind an hour, the last one saying so. Past that the action still works; it's
  // just not written until the hour is up. Kept in memory: a restart starts the count again.
  const cheap = new Map(); // `${serverId}|${actorId}|${kind}` -> { n, reset }
  function recordCapped(kind, server, actorId, action, targetId = null, detail = {}, channelId = null) {
    const sid = typeof server === 'string' ? server : server && server.id;
    if (!sid || !actorId) return record(server, actorId, action, targetId, detail, channelId);
    const t = Date.now();
    if (cheap.size > 10000) for (const [k, v] of cheap) if (v.reset < t) cheap.delete(k);
    const k = `${sid}|${actorId}|${kind}`;
    let e = cheap.get(k);
    if (!e || e.reset < t) { e = { n: 0, reset: t + 3600000 }; cheap.set(k, e); }
    if (++e.n > CHEAP_MAX) return undefined;
    return record(server, actorId, action, targetId, { ...detail, last: e.n === CHEAP_MAX || undefined }, channelId);
  }

  // ------------------------------------------------------------------ reading
  const mayRead = (s, uid) => s.kind !== 'group' && (perms.base(s, uid) & PM.VIEW_AUDIT_LOG) === PM.VIEW_AUDIT_LOG;
  function requireReader(serverId, uid) {
    const s = requireServer(String(serverId || ''), uid);
    if (s.kind === 'group') fail(400, 'Group chats don’t have an audit log.');
    if (!mayRead(s, uid)) fail(403, 'You need the View Audit Log permission.');
    return s;
  }
  const who = (r) => {
    const p = parseProfile(r);
    return { id: r.id, username: r.username, displayName: p.displayName || r.username, avatar: r.avatar || null, bot: !!r.is_bot || undefined, deleted: !!r.deleted_at || undefined };
  };
  function usersOf(ids) {
    const list = [...ids].filter((x) => typeof x === 'string' && ID.test(x));
    const out = {};
    if (!list.length) return out;
    for (const r of db.prepare('SELECT * FROM users WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(list))) out[r.id] = who(r);
    return out;
  }
  // Whether a deleted channel was private when it went: its channel_delete entry has its permissions from just
  // before. Entries written earlier can't say (a private channel starts out public, then gets locked), so they all
  // go by this. No such entry (the write failed): private, the safe answer.
  function wasPrivate(serverId, channelId) {
    if (typeof channelId !== 'string') return true;
    const row = db.prepare("SELECT detail FROM server_audit WHERE channel_id = ? AND action = 'channel_delete' AND server_id = ? ORDER BY id DESC LIMIT 1").get(channelId, serverId);
    if (!row) return true;
    try { const d = JSON.parse(row.detail); return !d.channel || !!d.channel.private; } catch { return true; }
  }

  // What one reader sees of entries: channel names only where they can see the channel, invite codes masked unless
  // they could list the invites themselves. Every entry is shown to every reader in some form, so the numbering
  // never has gaps that would say something was left out.
  function viewer(s, uid) {
    const base = perms.base(s, uid);
    const admin = base === ALL;
    // Someone waiting to be verified here after a reset without their recovery key can't list this server's invites
    // (crypto-2), so they don't see codes here either. Held until someone here vouched for them (index.js heldIn).
    const unverified = !!db.prepare(`SELECT 1 FROM users u WHERE u.id = ? AND u.keys_reset_at IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM key_vouches v WHERE v.user_id = u.id AND v.server_id = ? AND v.reset_at = u.keys_reset_at)`).get(uid, s.id);
    const manageServer = (base & PM.MANAGE_SERVER) === PM.MANAGE_SERVER && !unverified;
    const seen = new Map();
    const channelNow = (id) => {
      if (!seen.has(id)) {
        const c = typeof id === 'string' && db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(id, s.id);
        seen.set(id, c ? { c, see: (perms.channel(s, c, uid) & PM.VIEW_CHANNEL) !== 0 } : { gone: admin || !wasPrivate(s.id, id) });
      }
      return seen.get(id);
    };
    const channel = (x) => {
      if (!x || typeof x !== 'object') return null;
      const now = channelNow(x.id);
      if (now.c) return now.see ? { id: x.id, name: x.name, ...(now.c.name !== x.name ? { now: now.c.name } : {}) } : { hidden: true };
      return now.gone ? { name: x.name, deleted: true } : { hidden: true, deleted: true };
    };
    const userIds = new Set();
    // People whose accounts are deleted. A nickname is a name someone chose for themselves (often their real one),
    // and deleting the account erases their profile: the entries stay, but no longer say the names.
    const erased = new Map();
    const deleted = (id) => {
      if (!erased.has(id)) erased.set(id, typeof id === 'string' && !!db.prepare('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NOT NULL').get(id));
      return erased.get(id);
    };
    const entry = (r) => {
      let d = {};
      try { d = JSON.parse(r.detail) || {}; } catch { /* unreadable: shown without details */ }
      let detail = { ...d };
      for (const k of CHANNEL_KEYS) if (k in d) detail[k] = channel(d[k]);
      if (detail.channel && detail.channel.hidden) {
        const kept = { channel: detail.channel };
        for (const k of SAFE_KEYS) if (k in d) kept[k] = d[k];
        detail = kept;
      }
      if (r.action === 'member_nickname' && deleted(r.target_id)) {
        delete detail.from; delete detail.to; detail.erased = true;
      }
      let targetId = r.target_id;
      if (r.action.startsWith('invite_') && targetId && !manageServer) targetId = `${targetId.slice(0, 2)}…`;
      [r.actor_id, r.target_id, d.creatorId, r.action === 'server_transfer' ? d.from : null].forEach((x) => x && userIds.add(x));
      if (Array.isArray(detail.changes)) detail.changes.forEach((o) => o && o.type === 'member' && userIds.add(o.id));
      return { id: r.id, seq: r.seq, action: r.action, actorId: r.actor_id, targetId, createdAt: r.created_at, detail };
    };
    return { entry, users: () => usersOf(userIds) };
  }

  api.get('/servers/:id/audit', auth, (req, res) => {
    const q = req.query || {};
    // An open tab fetching what's new (?after=) has its own allowance, so a burst of entries can't use up the
    // reader's for paging and filtering.
    if (q.after !== undefined && q.after !== '') rateLimit('sauditlive:' + req.userId, 40, 60000);
    else rateLimit('saudit:' + req.userId, 60, 60000);
    const s = requireReader(req.params.id, req.userId);
    const before = int(q.before, 'before');
    const after = int(q.after, 'after');
    const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 50));
    const actions = q.action === undefined || q.action === '' ? [] : String(q.action).split(',');
    if (actions.length > ACTIONS.length || actions.some((a) => !ACTIONS.includes(a))) fail(400, 'Unknown action.');
    const actor = idParam(q.actor, 'person');
    const target = idParam(q.target, 'target');
    let user = idParam(q.user, 'person');
    // By username, for people the app doesn't know (someone banned long ago): unknown names just match nothing.
    if (!user && q.username !== undefined && q.username !== '') {
      if (typeof q.username !== 'string' || q.username.length > 64) fail(400, 'Unknown person.');
      const u = db.prepare('SELECT id FROM users WHERE lower(username) = ?').get(q.username.trim().replace(/^@/, '').toLowerCase());
      user = u ? u.id : '-'; // '-' is nobody's id
    }
    let sql = 'SELECT * FROM server_audit WHERE server_id = ?';
    const args = [s.id];
    if (after !== null) { sql += ' AND id > ?'; args.push(after); }
    if (actions.length) { sql += ' AND action IN (SELECT value FROM json_each(?))'; args.push(JSON.stringify(actions)); }
    if (actor) { sql += ' AND actor_id = ?'; args.push(actor); }
    if (target) { sql += ' AND target_id = ?'; args.push(target); }
    if (user) { sql += ' AND (actor_id = ? OR target_id = ?)'; args.push(user, user); }
    if (before !== null) { sql += ' AND id < ?'; args.push(before); }
    const rows = db.prepare(`${sql} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
    const hasMore = rows.length > limit;
    const v = viewer(s, req.userId);
    const entries = rows.slice(0, limit).map(v.entry);
    res.json({ entries, users: v.users(), hasMore, next: hasMore ? entries[entries.length - 1].id : null, actions: ACTIONS });
  });

  // Live updates for open Audit log tabs. A connection follows at most 5 servers' logs (the oldest is dropped).
  function watch(socket, p = {}) {
    const sid = String(p.serverId || '');
    if (!ID.test(sid)) fail(404, 'Server not found.');
    const room = `audit:${sid}`;
    if (p.on === false) { socket.leave(room); return { ok: true }; }
    requireReader(sid, socket.userId);
    const mine = [...socket.rooms].filter((r) => r.startsWith('audit:') && r !== room);
    while (mine.length >= 5) socket.leave(mine.shift());
    socket.join(room);
    return { ok: true };
  }
  // New entries are announced at most every NOTIFY_MS per server, to the watchers that may still read the log
  // (anyone who lost the permission or left stops watching).
  const pending = new Map();
  function notify(sid) {
    const io = getIo();
    if (!io || pending.has(sid) || !io.sockets.adapter.rooms.get(`audit:${sid}`)) return;
    pending.set(sid, setTimeout(jobs.job('serveraudit.notify', () => {
      pending.delete(sid);
      const room = io.sockets.adapter.rooms.get(`audit:${sid}`);
      if (!room) return;
      const s = serverRow(sid);
      for (const id of [...room]) {
        const sock = io.sockets.sockets.get(id);
        if (!sock) continue;
        if (s && isMember(sid, sock.userId) && mayRead(s, sock.userId)) sock.emit('audit:new', { serverId: sid });
        else sock.leave(`audit:${sid}`);
      }
    }), NOTIFY_MS));
    pending.get(sid).unref?.();
  }

  // ------------------------------------------------------------------ retention
  // Over a year old; beyond the newest 10,000 of their server and at least a week old; beyond the newest 50,000 and
  // not moderation (db.js: SERVER_AUDIT_KEPT); or beyond the newest 200,000. The triggers in db.js allow exactly
  // these (with a second's slack on the times for the clock moving on).
  function prune() {
    const t = Date.now();
    let n = db.prepare('DELETE FROM server_audit WHERE created_at < ?').run(t - MAX_AGE - 1000).changes;
    const top = db.prepare('SELECT MAX(seq) AS n FROM server_audit WHERE server_id = ?');
    const low = db.prepare('SELECT MIN(seq) AS n FROM server_audit WHERE server_id = ?');
    const hard = db.prepare('DELETE FROM server_audit WHERE server_id = ? AND seq <= ?');
    const cut = db.prepare(`DELETE FROM server_audit WHERE server_id = ? AND seq <= ? AND (created_at < ? OR (seq <= ? AND NOT ${keptSql()}))`);
    for (const { id } of db.prepare("SELECT id FROM servers WHERE COALESCE(kind, 'server') != 'group'").all()) {
      const hi = top.get(id).n;
      if (hi === null || hi - low.get(id).n < KEEP) continue;
      // Only a flood far beyond any real server's gets here: say so, as it may have cost recent moderation entries.
      const flood = hard.run(id, hi - HARD).changes;
      if (flood) log.warn('serveraudit', 'hard_cap', { serverId: id, removed: flood, msg: 'A server’s audit log passed 200,000 entries; the oldest went, whatever they were.' });
      n += flood + cut.run(id, hi - KEEP, t - GRACE - 1000, hi - CEILING).changes;
    }
    if (n) log.info('serveraudit', 'pruned', { removed: n, outcome: 'ok' });
    return n;
  }
  jobs.every('serveraudit.prune', 3600 * 1000, prune, { firstDelay: +(process.env.AUDIT_PRUNE_DELAY_MS || 10 * 60 * 1000) });

  // ------------------------------------------------------------------ report inbox
  const contextOf = (r) => { try { return JSON.parse(r.context || '{}') || {}; } catch { return {}; } };
  // Whether a report about someone else in this server is shared with its moderators at all (the reporter can say no).
  const shares = (category, optOut) => !optOut && !STAFF_ONLY.includes(category);
  // The server a member report was made from: only one both people are in.
  const memberServer = (serverId, reporterId, targetId) => {
    const s = typeof serverId === 'string' && ID.test(serverId) && serverRow(serverId);
    return s && s.kind !== 'group' && isMember(s.id, reporterId) && isMember(s.id, targetId) ? s : null;
  };
  // Who among a server's members sees a report in its inbox: Manage Messages in the channel it came from, or Kick or
  // Ban Members and able to see that channel (any of the three for a report about a member), and only when the
  // person reported is below them (never about themselves; the owner sees every report but ones about the owner).
  // ev: perms.forServer(s, …), when checking many members.
  function seesReport(s, uid, r, ev = null, cx = contextOf(r)) {
    if (r.server_id !== s.id || !r.server_status || r.target_id === uid) return false;
    const base = ev ? ev.base(uid) : perms.base(s, uid);
    if (!(base & MOD) && !cx.channelId) return false;
    if (cx.channelId) {
      const c = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(cx.channelId, s.id);
      if (c) {
        const p = ev ? ev.channel(c, uid) : perms.channel(s, c, uid);
        if (!((p & PM.MANAGE_MESSAGES) || ((p & PM.VIEW_CHANNEL) && (base & (PM.KICK_MEMBERS | PM.BAN_MEMBERS))))) return false;
      } else if (!(base & MOD) || (base !== ALL && wasPrivate(s.id, cx.channelId))) return false; // the channel is gone: as the audit log
    }
    return s.owner_id === uid || !r.target_id || perms.top(s, r.target_id) < perms.top(s, uid);
  }
  // Anyone who could see some report here: a moderator server-wide, or with Manage Messages in some channel.
  function requireModerator(serverId, uid) {
    const s = requireServer(String(serverId || ''), uid);
    if (s.kind === 'group') fail(400, 'Group chats don’t have reports.');
    if (!(perms.base(s, uid) & MOD) && !db.prepare('SELECT * FROM channels WHERE server_id = ?').all(s.id).some((c) => perms.channel(s, c, uid) & PM.MANAGE_MESSAGES)) {
      fail(403, 'You need the Manage Messages, Kick Members or Ban Members permission.');
    }
    return s;
  }
  // Whether a moderator whose history in the server starts at `since` (they joined with "New members can't read
  // messages from before they joined" on, server/joinhistory.js) may see a shared message: by the same rules as the
  // channel itself, or by when it was written once it's been deleted.
  function evidenceSeen(e, since) {
    if (!since || !history) return true;
    const m = db.prepare('SELECT created_at, ciphertext IS NOT NULL AS ciphertext, epoch, thread_id FROM messages WHERE id = ?').get(String(e.id || ''));
    return m ? history.visible(m, since) : Number(e.createdAt) >= since.at;
  }
  // A report as a moderator sees it: never who reported it, their address or other reports. Of the messages shared,
  // only the reported person's own: leaving out just the reporter's would point at them by what's missing. The
  // reporter's app decrypted those, so a moderator whose history in the server starts later doesn't get the ones
  // from before (evidenceHidden: how many); the report itself is theirs to handle as usual.
  function reportOut(r, userIds, since = null) {
    const cx = contextOf(r);
    let evidence = [];
    try { evidence = JSON.parse(r.evidence || '[]'); } catch { /* none */ }
    if (!Array.isArray(evidence)) evidence = [];
    evidence = evidence.filter((e) => e && e.authorId === r.target_id && e.authorId !== r.reporter_id);
    const shown = evidence.filter((e) => evidenceSeen(e, since));
    const evidenceHidden = evidence.length - shown.length;
    evidence = shown.map((e) => ({ id: e.id, authorId: e.authorId, createdAt: e.createdAt, text: e.text, files: e.files, reported: !!e.reported }));
    [r.target_id, r.server_handled_by, ...evidence.map((e) => e.authorId)].forEach((x) => x && userIds.add(x));
    return {
      id: r.id, category: r.category, details: r.details, createdAt: r.created_at, targetId: r.target_id,
      status: r.server_status, note: r.server_note || '', handledBy: r.server_handled_by || null, handledAt: r.server_handled_at || null,
      // Whether instance staff have closed it too (they never see the moderators' note as theirs, nor the other way).
      staffStatus: r.status,
      context: { kind: cx.kind || 'user', messageId: cx.messageId || null, channelId: cx.channelId || null, channelName: cx.channelName || null },
      evidence,
      ...(evidenceHidden ? { evidenceHidden } : {}),
    };
  }
  const STATUSES = { open: ['open'], handled: ['handled'], dismissed: ['dismissed'], all: ['open', 'handled', 'dismissed'] };
  api.get('/servers/:id/reports', auth, (req, res) => {
    rateLimit('sreports:' + req.userId, 60, 60000);
    const s = requireModerator(req.params.id, req.userId);
    const q = req.query || {};
    const status = STATUSES[q.status] ? q.status : 'open';
    const before = int(q.before, 'before');
    const rows = db.prepare(`SELECT * FROM reports WHERE server_id = ? AND server_status IN (SELECT value FROM json_each(?)) AND created_at < ?
        ORDER BY created_at DESC LIMIT 200`).all(s.id, JSON.stringify(STATUSES[status]), before === null ? Number.MAX_SAFE_INTEGER : before);
    const userIds = new Set();
    const shown = [];
    let next = null;
    const ev = perms.forServer(s, [req.userId]); // their permissions read once for the whole list
    const since = history ? history.startOf(s.id, req.userId) : null;
    for (const r of rows) {
      if (shown.length === 50) { next = shown[shown.length - 1].createdAt; break; }
      if (seesReport(s, req.userId, r, ev)) shown.push(reportOut(r, userIds, since));
    }
    if (!next && rows.length === 200) next = rows[rows.length - 1].created_at;
    // How many open ones this person can act on (the tab's badge), from the newest 500.
    const open = db.prepare("SELECT * FROM reports WHERE server_id = ? AND server_status = 'open' ORDER BY created_at DESC LIMIT 500").all(s.id)
      .filter((r) => seesReport(s, req.userId, r, ev)).length;
    res.json({ reports: shown, users: usersOf(userIds), next, open });
  });
  api.patch('/servers/:id/reports/:rid', auth, (req, res) => {
    rateLimit('sreportset:' + req.userId, 60, 60000);
    const s = requireModerator(req.params.id, req.userId);
    const rid = String(req.params.rid || '');
    const r = ID.test(rid) && db.prepare('SELECT * FROM reports WHERE id = ? AND server_id = ?').get(rid, s.id);
    if (!r || !seesReport(s, req.userId, r)) fail(404, 'Report not found.');
    const b = req.body || {};
    if (!['open', 'handled', 'dismissed'].includes(b.status)) fail(400, 'Mark it handled, dismissed or open again.');
    if (b.note !== undefined && typeof b.note !== 'string') fail(400, 'The note is text.');
    const note = b.note !== undefined ? b.note.trim().slice(0, 500) : r.server_note;
    const done = b.status !== 'open';
    // Who handled it and when stays on the report, for the moderators who can see it; it isn't written to the audit
    // log, where the person reported could learn of it (see the top of this file).
    db.prepare('UPDATE reports SET server_status = ?, server_handled_by = ?, server_handled_at = ?, server_note = ? WHERE id = ?')
      .run(b.status, done ? req.userId : null, done ? Date.now() : null, note, r.id);
    reportChanged(s.id, r.id);
    res.json({ ok: true, status: b.status });
  });
  // Tells the moderators who can see this report (online ones) that it's new (fresh: their app says so) or changed.
  function reportChanged(serverId, reportId, fresh = false) {
    const io = getIo();
    const s = serverRow(serverId);
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
    if (!io || !s || !r || !r.server_status) return;
    const online = db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(s.id).map((m) => m.user_id).filter((u) => io.sockets.adapter.rooms.has(`user:${u}`));
    if (!online.length) return;
    const ev = perms.forServer(s, online);
    const cx = contextOf(r);
    const rooms = online.filter((u) => seesReport(s, u, r, ev, cx)).map((u) => `user:${u}`);
    if (rooms.length) io.to(rooms).emit('server:report', { serverId: s.id, id: r.id, status: r.server_status, ...(fresh ? { fresh: true, category: r.category } : {}) });
  }

  return { record, recordCapped, channelRef, watch, prune, mayRead, shares, memberServer, reportChanged, ACTIONS };
};
// Exported for the tests (test/wordfilter.test.js).
module.exports.trimDetail = trim;
