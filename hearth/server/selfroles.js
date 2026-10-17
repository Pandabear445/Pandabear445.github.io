// Self-assignable roles: a moderator marks a role "Members can pick this role themselves" (ping roles like
// @game-night, pronoun and color roles, opt-in private channels) and members add or drop it from "Pick your
// roles". Picking a role has exactly the effect of a moderator giving it: the same member_roles row, then
// emitServer (permissions worked out again, calls rechecked, channels appear or disappear in open apps).
// Private channels use the server's key, which every member already holds, so keys don't change either way.
// Since members now change their own roles, the app's moderator tools send only the role they change
// ({ add, remove } on PUT /servers/:id/members/:uid/roles), never a whole list that may be out of date.
//
// Nothing here hands out power:
//   - a role with moderator powers or Mention @everyone (itself or through a channel override) can't be marked
//     or picked, and a marked role can't be given them later (the role editor and channel permissions refuse);
//   - a role that sits at or above a moderator role whose powers only reach people below it can't be picked:
//     everyone who did would be out of that role's reach. Those powers are Kick (kicks and timeouts), Ban, Manage
//     Roles, Manage Nicknames, Manage Messages (bulk delete, a ban's message cleanup and the report inbox only take
//     in people below you), Mute Members and Move Members (voice moderation), and Administrator. Manage Messages
//     and Move Members count given in a single channel too (a channel override, for a role or for one member, whose
//     highest role then counts), since that's where they're checked. Other powers (Manage Emojis, Channels, Server)
//     aren't counted: the one place they go by role order, changing a webhook someone else made, leaves roles
//     members pick themselves out of it instead (perms.topAssigned in server/webhooks.js), so roles that only have
//     those can sit below pickable ones;
//   - marking a role takes what giving it to anyone would take (PUT /servers/:id/members/:uid/roles): Manage
//     Roles, the role below your highest one, and every permission it has, server-wide and in each channel;
//   - a role sold as a membership can't be marked (it would be free), and a marked role can't be sold;
//   - picking a role can't undo a limit another of your roles puts on you in a channel. That's checked when you
//     pick, against what the pick really changes: a role given to you later, or a channel permission changed later,
//     isn't checked against roles you already picked (between roles, allow beats deny, as it always has). A
//     timeout is the limit no role can undo.
//
// A pick or drop sends everyone in the server a fresh copy of it (emitServer), which costs more the bigger the
// server is. Calls are checked at once, but the copies are sent at most every 400 ms per server, and less often
// while picks keep coming (broadcast() below), so many members toggling at once still cost one update.
//
// Routes
//   POST   /servers/:id/me/roles/:rid   pick a role marked self-assignable
//   DELETE /servers/:id/me/roles/:rid   drop it
// Marking a role is { selfAssign: true } on PATCH /roles/:id (server/index.js). Members see the marked roles
// in roleDefs (selfAssign, and selfAssignIssue when one can't be picked right now).

const jobs = require('./jobs');

const ID = /^[A-Za-z0-9_-]{1,64}$/;

module.exports = function setupSelfRoles(ctx) {
  const { api, auth, db, fail, rateLimit, limitNet, requireServer, perms, PM, ALL, CHANNEL_SCOPED, emitServer, recheckVoice, MEMB, serverAudit } = ctx;
  // Moderator powers, plus pinging everyone. MEMB.POWERFUL (what can't be sold) is folded in so the two lists
  // can't drift apart.
  const BLOCKED = MEMB.POWERFUL | PM.ADMINISTRATOR | PM.MANAGE_SERVER | PM.MANAGE_ROLES | PM.MANAGE_CHANNELS
    | PM.MANAGE_MESSAGES | PM.MANAGE_EMOJIS | PM.KICK_MEMBERS | PM.BAN_MEMBERS | PM.MENTION_EVERYONE;

  // The powers that only reach people below you (perms.top): kick, ban and timeouts (Kick), role changes and
  // channel overrides (Manage Roles, which the overrides route needs server-wide, so a channel override can't
  // give this reach), other people's nicknames (Manage Nicknames, server-wide only: a nickname moderator's one
  // tool against an abusive name, which a picked role would otherwise put out of reach), other people's messages in
  // bulk and the reports about them (Manage Messages: bulk delete, a ban's cleanup and the report inbox keep to
  // people below you), and voice moderation (Mute Members, server-wide only, and Move Members). Administrator has
  // them all.
  const REACH = PM.ADMINISTRATOR | PM.KICK_MEMBERS | PM.BAN_MEMBERS | PM.MANAGE_ROLES | PM.MANAGE_NICKNAMES
    | PM.MANAGE_MESSAGES | PM.MUTE_MEMBERS | PM.MOVE_MEMBERS;
  // Of those, the ones a channel override can give, checked in that channel: Manage Messages (bulk delete, and the
  // report inbox for that channel's messages) and Move Members (disconnect and move from that voice channel).
  const REACH_IN_CHANNEL = PM.MANAGE_MESSAGES | PM.MOVE_MEMBERS;
  // The lowest role with that reach, server-wide or in some channel of this server, or null. @everyone doesn't
  // count: it sits at the bottom and holding it puts nobody above anyone. A member given that reach by an override of
  // their own reaches people below their highest role, so that role counts too ({ member: true }), leaving out roles
  // members pick themselves (perms.topAssigned: a pick doesn't raise anyone's reach); one whose highest is @everyone
  // reaches nobody, and the owner reaches everyone, so neither keeps anything below them.
  function lowestModRole(s) {
    let low = db.prepare(`SELECT id, name, position FROM roles WHERE server_id = ? AND id != ? AND ((permissions & ?) != 0 OR id IN (
        SELECT o.target_id FROM channel_overrides o JOIN channels c ON c.id = o.channel_id
        WHERE c.server_id = ? AND o.target_type = 'role' AND (o.allow & ?) != 0)) ORDER BY position LIMIT 1`)
      .get(s.id, s.id, REACH, s.id, REACH_IN_CHANNEL) || null;
    const mods = db.prepare(`SELECT DISTINCT o.target_id AS id FROM channel_overrides o JOIN channels c ON c.id = o.channel_id
        JOIN members m ON m.server_id = c.server_id AND m.user_id = o.target_id
        WHERE c.server_id = ? AND o.target_type = 'member' AND (o.allow & ?) != 0 AND o.target_id != ?`).all(s.id, REACH_IN_CHANNEL, s.owner_id || '');
    const topOf = db.prepare(`SELECT r.id, r.name, r.position FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.server_id = ? AND mr.user_id = ? AND r.server_id = ? AND r.id != ? AND r.self_assign = 0 ORDER BY r.position DESC LIMIT 1`);
    for (const m of mods) {
      const r = topOf.get(s.id, m.id, s.id, s.id);
      if (r && r.position > 0 && (!low || r.position < low.position)) low = { ...r, member: true };
    }
    return low;
  }

  // Why members can't pick this role right now, as a short clause, or null when they can.
  //   permissions: the role's permissions after a change being checked (default: as stored)
  //   low:         lowestModRole(s), when the caller already has it
  function issue(s, r, { permissions = r.permissions, low = lowestModRole(s) } = {}) {
    if (r.id === s.id) return 'everyone already has @everyone';
    const tier = MEMB.tierForRole(r.id);
    if (tier) return `it’s sold as the "${tier.name}" membership`;
    if (MEMB.powerful({ ...r, permissions }, BLOCKED)) return 'it has moderator powers or Mention @everyone (itself or in a channel)';
    // (A moderator role is never the one marked: it has the powers, which the line above refuses, unless this edit
    // takes them away. A member moderator's highest role can be, and picking it would put people level with them.)
    if (low && low.member && low.id === r.id) return 'it’s the highest role of someone who moderates a channel, who only reaches people below it';
    if (low && low.id !== r.id && r.position >= low.position) {
      return low.member ? `it sits above "${low.name}", the highest role of someone who moderates a channel and only reaches people below it`
        : `it sits above "${low.name}", a moderator role that only reaches people below it`;
    }
    return null;
  }

  // For serverCommon: { roleId: issue } for the marked roles that can't be picked right now. Servers with no
  // marked roles (most of them) cost nothing extra.
  function issues(s, roleRows) {
    const marked = roleRows.filter((r) => r.self_assign && r.id !== s.id);
    if (!marked.length) return {};
    const low = lowestModRole(s);
    const out = {};
    for (const r of marked) { const why = issue(s, r, { low }); if (why) out[r.id] = why; }
    return out;
  }

  // PATCH /roles/:id with selfAssign. `r` is the role as stored, `permissions` what it will have after the edit.
  // The caller already passed requireManageableRole (Manage Roles, role below their highest).
  function checkEdit(s, r, userId, selfAssign, permissions) {
    if (!selfAssign) return;
    if (r.self_assign) {
      // Already marked: only what the edit adds is checked, so someone who can edit the role but doesn't have
      // all of its permissions can still rename it.
      if (permissions & BLOCKED & ~r.permissions) fail(400, `Members can pick "${r.name}" themselves, so it can’t have moderator powers or Mention @everyone. Turn that off first.`, 'self_assign');
      return;
    }
    if (s.kind === 'group') fail(400, 'Group chats don’t have roles.');
    const why = issue(s, r, { permissions });
    if (why) fail(400, `Members can’t pick "${r.name}" themselves: ${why}.${/sits above/.test(why) ? ' Move it lower in the list first.' : ''}`, 'self_assign');
    // Marking it lets everyone give it to themselves, so it takes what giving it to anyone would take.
    if (permissions & ALL & ~perms.base(s, userId)) fail(403, `You can’t let members pick "${r.name}": it has permissions you don’t have.`);
    for (const o of db.prepare("SELECT channel_id, allow, deny FROM channel_overrides WHERE target_type = 'role' AND target_id = ?").all(r.id)) {
      if ((o.allow | o.deny) & CHANNEL_SCOPED & ~perms.channel(s, { id: o.channel_id }, userId)) fail(403, `You can’t let members pick "${r.name}": it has channel permissions you don’t have.`);
    }
  }

  // PUT /channels/:id/overrides: a marked role can't be given moderator powers in a channel either.
  function checkOverride(roleId, addedAllow) {
    if (!(addedAllow & BLOCKED)) return;
    const r = db.prepare('SELECT name, self_assign FROM roles WHERE id = ?').get(roleId);
    if (r && r.self_assign) fail(400, `Members can pick "${r.name}" themselves, so it can’t have moderator powers or Mention @everyone here.`, 'self_assign');
  }

  // Toggling is cheap for the member but sends everyone in the server a fresh copy of it, so it's limited per
  // account (bursts and per hour) and per network, and the copies are batched per server (broadcast).
  function limit(req) {
    rateLimit('selfrole:' + req.userId, 10, 10000);
    rateLimit('selfroleh:' + req.userId, 200, 3600000);
    limitNet(req, 'selfrole', 60, 10000);
  }
  // After a pick or drop: calls are checked again right away (someone who lost a voice channel leaves it now), and
  // the new view of the server goes out once for everything picked or dropped within the wait. The wait is 400 ms,
  // doubling (up to 5 s) while updates keep going out back to back, so a crowd of accounts toggling roles costs at
  // most one update every few seconds however many there are. A per-server cap would let one of them stop everyone
  // else picking; this only makes everyone's update a little later. Apps wait up to 1.5 s for it, then keep what
  // the route answered (public/js/selfroles.js).
  const MIN_WAIT = 400; const MAX_WAIT = 5000;
  const batches = new Map(); // server id -> { timer, last, wait }
  function broadcast(s) {
    recheckVoice(s);
    const t = Date.now();
    let b = batches.get(s.id);
    if (!b) {
      // Only servers with recent picks need remembering.
      if (batches.size >= 500) for (const [id, x] of batches) if (!x.timer && t - x.last > 60000) batches.delete(id);
      b = { timer: null, last: 0, wait: MIN_WAIT };
      batches.set(s.id, b);
    }
    if (b.timer) return;
    b.wait = t - b.last < b.wait + 2000 ? Math.min(MAX_WAIT, b.wait * 2) : MIN_WAIT;
    b.timer = setTimeout(jobs.job('selfroles.broadcast', () => {
      b.timer = null;
      b.last = Date.now();
      emitServer(s.id);
    }), b.wait).unref();
  }

  // Picks and drops go in the server's audit log, marked as picked by the member themselves. A member toggling a
  // role over and over could otherwise fill the log (and push older entries out of it), so each member gets at most
  // LOG_MAX entries an hour per server; past that their changes aren't logged until the hour is up.
  const LOG_MAX = 20;
  const logged = new Map(); // `${serverId}|${userId}` -> { n, reset }
  function logPick(s, uid, r, picked) {
    const t = Date.now();
    if (logged.size > 10000) for (const [k, v] of logged) if (v.reset < t) logged.delete(k);
    const k = `${s.id}|${uid}`;
    let e = logged.get(k);
    if (!e || e.reset < t) { e = { n: 0, reset: t + 3600000 }; logged.set(k, e); }
    if (++e.n > LOG_MAX) return;
    const role = [{ id: r.id, name: r.name }];
    serverAudit(s, uid, 'member_roles', uid, { added: picked ? role : [], removed: picked ? [] : role, self: true, last: e.n === LOG_MAX || undefined });
  }

  // Members only (banned people aren't members any more), roles of this server only, and not while timed out.
  function target(req) {
    const s = requireServer(req.params.id, req.userId);
    if (s.kind === 'group') fail(400, 'Group chats don’t have roles.');
    const rid = typeof req.params.rid === 'string' && ID.test(req.params.rid) ? req.params.rid : '';
    const r = rid && db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(rid, s.id);
    if (!r || r.id === s.id) fail(404, 'Role not found.');
    if (!r.self_assign) fail(403, `Members can’t pick "${r.name}" themselves. Ask a moderator.`, 'not_self_assign');
    if (perms.timedOut(s.id, req.userId)) fail(403, 'You’re timed out in this server, so you can’t change your roles until it ends.', 'timed_out');
    return { s, r };
  }

  api.post('/servers/:id/me/roles/:rid', auth, (req, res) => {
    limit(req);
    const { s, r } = target(req);
    if (db.prepare('SELECT 1 FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').get(s.id, req.userId, r.id)) return res.json({ ok: true, roleId: r.id, has: true });
    // Checked again here, not only when it was marked: the role or the roles around it may have changed since.
    const why = issue(s, r);
    if (why) fail(403, `You can’t pick "${r.name}" right now: ${why}. Ask a moderator.`, 'self_assign');
    // Between roles, an allow beats a deny, so a role you pick could undo a limit a moderator put on you with
    // another role (a "muted" role denying Send Messages, say). Where it would, picking is refused; a moderator
    // can still give it to you. (A limit set on you by name, or a timeout, can't be undone by any role.) Only
    // channels where the role allows something can change, and only what you could really do there afterwards
    // counts: an allow in a channel you still can't see changes nothing. The row is written, each of those channels
    // compared before and after, and a refusal undoes the write. A channel is only named if you can see it now.
    const ovs = db.prepare(`SELECT o.channel_id, c.name FROM channel_overrides o JOIN channels c ON c.id = o.channel_id
        WHERE o.target_type = 'role' AND o.target_id = ? AND o.allow != 0`).all(r.id);
    const was = ovs.map((o) => [o, perms.channel(s, { id: o.channel_id }, req.userId)]);
    const deniedBy = db.prepare(`SELECT o.deny FROM channel_overrides o JOIN member_roles mr ON mr.role_id = o.target_id
        WHERE o.channel_id = ? AND o.target_type = 'role' AND mr.server_id = ? AND mr.user_id = ? AND o.target_id != ?`);
    let added = 0;
    db.transaction(() => {
      added = db.prepare('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(s.id, req.userId, r.id).changes;
      for (const [o, before] of was) {
        const gained = perms.channel(s, { id: o.channel_id }, req.userId) & ~before;
        if (!gained) continue;
        const denied = deniedBy.all(o.channel_id, s.id, req.userId, r.id).reduce((a, x) => a | x.deny, 0);
        if (gained & denied) {
          fail(403, `You can’t pick "${r.name}": it would undo a limit another of your roles puts on you in ${before & PM.VIEW_CHANNEL ? `#${o.name}` : 'a channel you can’t see'}. Ask a moderator.`, 'self_assign_limit');
        }
      }
    })();
    if (added) { broadcast(s); logPick(s, req.userId, r, true); }
    res.json({ ok: true, roleId: r.id, has: true });
  });

  // Dropping a marked role always works (even one that can't be picked right now): it only takes away.
  api.delete('/servers/:id/me/roles/:rid', auth, (req, res) => {
    limit(req);
    const { s, r } = target(req);
    const gone = db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').run(s.id, req.userId, r.id).changes;
    if (gone) { broadcast(s); logPick(s, req.userId, r, false); }
    res.json({ ok: true, roleId: r.id, has: false });
  });

  return { BLOCKED, issues, checkEdit, checkOverride };
};
