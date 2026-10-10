// Same permission bits as server/perms.js, plus labels for the role and channel editors.
export const PERMS = {
  VIEW_CHANNEL: 1 << 0, SEND_MESSAGES: 1 << 1, ADD_REACTIONS: 1 << 2, ATTACH_FILES: 1 << 3,
  MENTION_EVERYONE: 1 << 4, MANAGE_MESSAGES: 1 << 5, CONNECT: 1 << 6, SPEAK: 1 << 7,
  CREATE_INVITE: 1 << 8, KICK_MEMBERS: 1 << 9, BAN_MEMBERS: 1 << 10, MANAGE_CHANNELS: 1 << 11,
  MANAGE_ROLES: 1 << 12, MANAGE_SERVER: 1 << 13, MANAGE_EMOJIS: 1 << 14, CREATE_THREADS: 1 << 15,
  EMBED_LINKS: 1 << 16, ADMINISTRATOR: 1 << 30,
};
const P = PERMS;
export const PERM_GROUPS = [
  ['General', [
    ['VIEW_CHANNEL', 'View channels', 'See text and voice channels.', true],
    ['MANAGE_CHANNELS', 'Manage channels', 'Create, edit, reorder and delete channels and categories.', true],
    ['MANAGE_ROLES', 'Manage roles', 'Create and edit roles below their own, and change channel permissions.', true],
    ['MANAGE_SERVER', 'Manage server', 'Change the name, icon, banner, theme and welcome message.', false],
    ['MANAGE_EMOJIS', 'Manage emoji', 'Upload, rename and delete custom emoji.', false],
    ['CREATE_INVITE', 'Create invites', 'Invite new people.', true],
  ]],
  ['Members', [
    ['KICK_MEMBERS', 'Kick members', 'Remove people below them. They can rejoin with an invite.', false],
    ['BAN_MEMBERS', 'Ban members', 'Remove people below them and stop them from rejoining.', false],
  ]],
  ['Text', [
    ['SEND_MESSAGES', 'Send messages', '', true],
    ['CREATE_THREADS', 'Reply in threads', '', true],
    ['EMBED_LINKS', 'Show link previews', 'Image links in their messages show as pictures.', true],
    ['ATTACH_FILES', 'Attach files', '', true],
    ['ADD_REACTIONS', 'Add reactions', 'Add new reactions (anyone can join existing ones).', true],
    ['MENTION_EVERYONE', 'Mention @everyone and @channel', 'Their @everyone notifies people.', true],
    ['MANAGE_MESSAGES', 'Manage messages', 'Delete and pin anyone’s messages, and skip slowmode.', true],
  ]],
  ['Voice', [
    ['CONNECT', 'Connect', 'Join voice channels.', true],
    ['SPEAK', 'Speak', 'Talk in voice channels (otherwise listen only).', true],
  ]],
  ['Advanced', [
    ['ADMINISTRATOR', 'Administrator', 'Every permission, everywhere, and bypasses channel restrictions. Give this carefully.', false],
  ]],
];
export const ALL = Object.values(P).reduce((a, b) => a | b, 0);
export const has = (perms, bit) => (perms & bit) === bit;
// What everyone in a group chat can do (its owner can do everything), as on the server.
export const GROUP_MEMBER = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS | P.ATTACH_FILES | P.EMBED_LINKS
  | P.CONNECT | P.SPEAK | P.CREATE_INVITE | P.CREATE_THREADS | P.MENTION_EVERYONE;

// Roles a member has, highest first (excluding @everyone).
export function memberRoles(server, userId) {
  const ids = (server.memberRoles || {})[userId] || [];
  return (server.roleDefs || []).filter((r) => ids.includes(r.id)).sort((a, b) => b.position - a.position);
}
// Server-wide permissions for any member (the server only sends our own; this is for display rules).
export function basePerms(server, userId) {
  if (!server) return 0;
  if (server.ownerId === userId) return ALL;
  if (server.kind === 'group') return GROUP_MEMBER;
  let p = 0;
  for (const r of server.roleDefs || []) if (r.everyone || ((server.memberRoles || {})[userId] || []).includes(r.id)) p |= r.permissions;
  return p & P.ADMINISTRATOR ? ALL : p;
}
// Does a <@&role> in this person's message ping the role's members? Only if the role is mentionable or they may
// mention everyone. The composer only offers those roles, but a hand-typed mention must not ping either.
export function mayMentionRole(server, roleId, authorId) {
  const r = ((server && server.roleDefs) || []).find((x) => x.id === roleId);
  return !!r && !r.everyone && (r.mentionable || has(basePerms(server, authorId), P.MENTION_EVERYONE));
}
export const topColor = (server, userId) => (memberRoles(server, userId).find((r) => r.color) || {}).color || '';
