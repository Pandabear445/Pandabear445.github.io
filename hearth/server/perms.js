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

  // Server-wide permissions for a member.
  function base(server, userId) {
    if (!server) return 0;
    if (server.owner_id === userId) return ALL;
    if (server.kind === 'group') return GROUP_MEMBER;
    let p = 0;
    for (const r of rolesOf(server.id, userId)) p |= r.permissions;
    if (p & P.ADMINISTRATOR) return ALL;
    return timedOut(server.id, userId) ? p & ~TALK : p;
  }

  // Permissions in one channel, after overrides.
  function channel(server, ch, userId) {
    let p = base(server, userId);
    if (p === ALL) return ALL;
    const ov = db.prepare('SELECT * FROM channel_overrides WHERE channel_id = ?').all(ch.id);
    if (ov.length) {
      const everyone = ov.find((o) => o.target_type === 'role' && o.target_id === server.id);
      if (everyone) p = (p & ~everyone.deny) | everyone.allow;
      const mine = new Set(db.prepare(heldRoles).all(server.id, userId).map((r) => r.role_id));
      let allow = 0; let deny = 0;
      for (const o of ov) if (o.target_type === 'role' && mine.has(o.target_id)) { allow |= o.allow; deny |= o.deny; }
      p = (p & ~deny) | allow;
      const me = ov.find((o) => o.target_type === 'member' && o.target_id === userId);
      if (me) p = (p & ~me.deny) | me.allow;
      // A channel override can't give a timed-out member their voice back.
      if (server.kind !== 'group' && timedOut(server.id, userId)) p &= ~TALK;
    }
    return p & P.VIEW_CHANNEL ? p : 0;
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

  return { base, channel, top, restricted, rolesOf, timedOut };
}

module.exports = { PERMS, ALL, DEFAULT_EVERYONE, CHANNEL_SCOPED, GROUP_MEMBER, TALK, makePerms };
