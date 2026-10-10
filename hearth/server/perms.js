// Server permissions. Each permission is one bit; a role's permissions are the bits OR'ed together.
// Resolution follows the familiar model: @everyone, then the member's roles, then per-channel
// overrides (for @everyone, then the member's roles, then the member). Owners and anyone with
// Administrator get everything.
const PERMS = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  ADD_REACTIONS: 1 << 2,
  ATTACH_FILES: 1 << 3,
  MENTION_EVERYONE: 1 << 4,
  MANAGE_MESSAGES: 1 << 5,
  CONNECT: 1 << 6,
  SPEAK: 1 << 7,
  CREATE_INVITE: 1 << 8,
  KICK_MEMBERS: 1 << 9,
  BAN_MEMBERS: 1 << 10,
  MANAGE_CHANNELS: 1 << 11,
  MANAGE_ROLES: 1 << 12,
  MANAGE_SERVER: 1 << 13,
  MANAGE_EMOJIS: 1 << 14,
  CREATE_THREADS: 1 << 15,
  EMBED_LINKS: 1 << 16,
  ADMINISTRATOR: 1 << 30,
};
const ALL = Object.values(PERMS).reduce((a, b) => a | b, 0);
const P = PERMS;
const DEFAULT_EVERYONE = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS | P.ATTACH_FILES | P.EMBED_LINKS
  | P.CONNECT | P.SPEAK | P.CREATE_INVITE | P.CREATE_THREADS;
// Permissions that only make sense per channel (used to validate overrides). Create Invite isn't one: invites
// are for the whole server, so a per-channel toggle would look like it does something when it doesn't.
const CHANNEL_SCOPED = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS | P.ATTACH_FILES | P.EMBED_LINKS
  | P.MENTION_EVERYONE | P.MANAGE_MESSAGES | P.CONNECT | P.SPEAK | P.CREATE_THREADS | P.MANAGE_CHANNELS | P.MANAGE_ROLES;
// What everyone in a group chat can do. Only its owner manages it (adds channels, deletes other people's
// messages…); renaming it and changing its picture are allowed to everyone by those routes themselves.
const GROUP_MEMBER = DEFAULT_EVERYONE | P.MENTION_EVERYONE;
// What a member who is timed out can't do until it ends: anything that posts or speaks. Reading, joining a call
// to listen and leaving still work. Owners and Administrators can't be timed out (the route refuses them).
const TALK = P.SEND_MESSAGES | P.ADD_REACTIONS | P.ATTACH_FILES | P.MENTION_EVERYONE | P.CREATE_THREADS | P.SPEAK | P.EMBED_LINKS | P.CREATE_INVITE;

function makePerms(db) {
  // Only roles held by a current member count: a role row left behind by someone who left can never come back
  // into effect when they rejoin.
  const heldRoles = `SELECT mr.role_id FROM member_roles mr JOIN members m ON m.server_id = mr.server_id AND m.user_id = mr.user_id
      WHERE mr.server_id = ? AND mr.user_id = ?`;
  const rolesOf = (serverId, userId) => db.prepare(`SELECT r.* FROM roles r WHERE r.server_id = ? AND (r.id = ? OR r.id IN (${heldRoles}))`)
    .all(serverId, serverId, serverId, userId);

  // Is this member timed out in this server right now? (v18, see member_timeouts in db.js)
  const timedOut = (serverId, userId) => !!db.prepare('SELECT 1 FROM member_timeouts WHERE server_id = ? AND user_id = ? AND until > ?').get(serverId, userId, Date.now());

  // The rules themselves, as plain functions of what was read from the database, so checking one person
  // (base, channel) and many at once (forServer) can't drift apart.
  //   roleBits: permissions of the roles that count (@everyone and the ones they hold, of this server)
  //   mine():   ids of the roles they hold (only read when the channel has overrides)
  //   muted():  whether they're timed out in this server right now
  function baseFrom(server, userId, roleBits, muted) {
    if (!server) return 0;
    if (server.owner_id === userId) return ALL;
    if (server.kind === 'group') return GROUP_MEMBER;
    let p = 0;
    for (const bits of roleBits) p |= bits;
    if (p & P.ADMINISTRATOR) return ALL;
    return muted() ? p & ~TALK : p;
  }
  function channelFrom(server, userId, p, ov, mine, muted) {
    if (p === ALL) return ALL;
    if (ov.length) {
      const everyone = ov.find((o) => o.target_type === 'role' && o.target_id === server.id);
      if (everyone) p = (p & ~everyone.deny) | everyone.allow;
      const held = mine();
      let allow = 0; let deny = 0;
      for (const o of ov) if (o.target_type === 'role' && held.has(o.target_id)) { allow |= o.allow; deny |= o.deny; }
      p = (p & ~deny) | allow;
      const me = ov.find((o) => o.target_type === 'member' && o.target_id === userId);
      if (me) p = (p & ~me.deny) | me.allow;
      // A channel override can't give a timed-out member their voice back.
      if (server.kind !== 'group' && muted()) p &= ~TALK;
    }
    return p & P.VIEW_CHANNEL ? p : 0;
  }
  const overridesOf = (channelId) => db.prepare('SELECT * FROM channel_overrides WHERE channel_id = ?').all(channelId);

  // Server-wide permissions for a member.
  function base(server, userId) {
    if (!server) return 0;
    if (server.owner_id === userId || server.kind === 'group') return baseFrom(server, userId, [], () => false);
    return baseFrom(server, userId, rolesOf(server.id, userId).map((r) => r.permissions), () => timedOut(server.id, userId));
  }

  // Permissions in one channel, after overrides.
  function channel(server, ch, userId) {
    const p = base(server, userId);
    if (p === ALL) return ALL;
    return channelFrom(server, userId, p, overridesOf(ch.id), () => new Set(db.prepare(heldRoles).all(server.id, userId).map((r) => r.role_id)), () => timedOut(server.id, userId));
  }

  // The same answers for many members of one server at once (who receives a private channel's message, everyone's
  // own view of a server after a change): the server's roles and the members' roles are read in one query each,
  // and each channel's overrides once, instead of again for every member and channel. Nothing is kept once the
  // caller is done with it (it's made for one fan-out), so a later role or override change is always seen.
  //   userIds: the members it will be asked about (default: all of them). Anyone else is worked out the usual way.
  function forServer(server, userIds = null) {
    const roleBits = new Map(db.prepare('SELECT id, permissions FROM roles WHERE server_id = ?').all(server.id).map((r) => [r.id, r.permissions]));
    const held = new Map();
    const rows = userIds
      ? db.prepare(`SELECT mr.user_id, mr.role_id FROM member_roles mr JOIN members m ON m.server_id = mr.server_id AND m.user_id = mr.user_id
          WHERE mr.server_id = ? AND mr.user_id IN (SELECT value FROM json_each(?))`).all(server.id, JSON.stringify(userIds))
      : db.prepare(`SELECT mr.user_id, mr.role_id FROM member_roles mr JOIN members m ON m.server_id = mr.server_id AND m.user_id = mr.user_id
          WHERE mr.server_id = ?`).all(server.id);
    for (const r of rows) { if (!held.has(r.user_id)) held.set(r.user_id, new Set()); held.get(r.user_id).add(r.role_id); }
    const known = userIds ? new Set(userIds) : null;
    // Who is timed out here right now, read once like the roles.
    const muted = new Set(db.prepare('SELECT user_id FROM member_timeouts WHERE server_id = ? AND until > ?').all(server.id, Date.now()).map((r) => r.user_id));
    const none = new Set();
    const ovs = new Map(); const bases = new Map();
    const ovOf = (id) => { if (!ovs.has(id)) ovs.set(id, overridesOf(id)); return ovs.get(id); };
    const baseOf = (uid) => {
      if (known && !known.has(uid)) return base(server, uid);
      if (!bases.has(uid)) {
        // Like rolesOf: @everyone (the role with the server's id) plus the roles they hold that belong to this server.
        const bits = [];
        if (roleBits.has(server.id)) bits.push(roleBits.get(server.id));
        for (const id of held.get(uid) || none) if (id !== server.id && roleBits.has(id)) bits.push(roleBits.get(id));
        bases.set(uid, baseFrom(server, uid, bits, () => muted.has(uid)));
      }
      return bases.get(uid);
    };
    return {
      base: baseOf,
      channel: (ch, uid) => (known && !known.has(uid) ? channel(server, ch, uid) : channelFrom(server, uid, baseOf(uid), ovOf(ch.id), () => held.get(uid) || none, () => muted.has(uid))),
    };
  }

  // Highest role position (owner is above everyone). Used for "you can only manage roles below yours".
  function top(server, userId) {
    if (server.owner_id === userId) return Infinity;
    return Math.max(0, ...rolesOf(server.id, userId).map((r) => r.position));
  }

  // Is any member possibly blocked from seeing this channel? (Then events go to individuals, not the room.)
  function restricted(server, ch) {
    const everyone = db.prepare('SELECT permissions FROM roles WHERE id = ?').get(server.id);
    if (everyone && !(everyone.permissions & P.VIEW_CHANNEL)) return true;
    return !!db.prepare('SELECT 1 FROM channel_overrides WHERE channel_id = ? AND (deny & ?) != 0').get(ch.id, P.VIEW_CHANNEL);
  }

  return { base, channel, forServer, top, restricted, rolesOf, timedOut };
}

module.exports = { PERMS, ALL, DEFAULT_EVERYONE, CHANNEL_SCOPED, GROUP_MEMBER, TALK, makePerms };
