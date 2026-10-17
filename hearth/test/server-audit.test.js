// Each server's own audit log, and its moderators' report inbox (server/serveraudit.js).
// The log: what gets written (and never message text), who can read it, what a reader who can't see a channel
// gets, filters and paging, live updates, refusals and floods, append-only storage and retention. The inbox: which
// reports reach a server's moderators, what they see (never who reported), handling them, and what stays as it was
// for instance staff.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, hex, sleep } = require('./helpers');

const P = { VIEW: 1, SEND: 2, MANAGE_MESSAGES: 32, CONNECT: 64, KICK: 1 << 9, BAN: 1 << 10, MANAGE_CHANNELS: 1 << 11, MANAGE_ROLES: 1 << 12,
  MANAGE_SERVER: 1 << 13, MANAGE_EMOJIS: 1 << 14, MUTE: 1 << 17, MOVE: 1 << 18, AUDIT: 1 << 19, ADMIN: 1 << 30 };
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');
let srv;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const ack = (s, ev, p, ms = 5000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.emit(ev, p, (x) => { clearTimeout(t); r(x); }); });
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await sleep(25); } return true; };
const log = async (u, sid, q = '') => { const r = await as(u, 'GET', `/servers/${sid}/audit${q}`); assert.equal(r.status, 200, r.text); return r.json; };
const entries = (sid) => srv.sql('SELECT * FROM server_audit WHERE server_id = ? ORDER BY id', sid);
const last = (sid, action) => { const e = srv.sql('SELECT * FROM server_audit WHERE server_id = ? AND action = ? ORDER BY id DESC LIMIT 1', sid, action)[0]; return e && { ...e, detail: JSON.parse(e.detail) }; };

before(async () => { srv = await startServer(); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

// An owner, a moderator (a role with `modPerms`, above everyone else's), a reader (View Audit Log only) and
// members, in a fresh server.
async function community({ modPerms = P.KICK | P.BAN | P.MANAGE_ROLES | P.MANAGE_MESSAGES | P.MANAGE_CHANNELS, members = 2 } = {}) {
  const owner = await srv.register();
  const mod = await srv.register();
  const reader = await srv.register();
  const people = [];
  for (let i = 0; i < members; i++) people.push(await srv.register());
  const server = (await as(owner, 'POST', '/servers', { name: 'Audit ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const u of [mod, reader, ...people]) assert.equal((await as(u, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const role = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Mod', permissions: modPerms })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${mod.id}/roles`, { roleIds: [role] })).status, 200);
  const readRole = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Auditor', permissions: P.AUDIT })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${reader.id}/roles`, { add: [readRole] })).status, 200);
  srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', server.id);
  return { owner, mod, reader, members: people, member: people[0], server, role, readRole, invite: invite.code, text: server.channels.find((c) => c.type === 'text'), voice: server.channels.find((c) => c.type === 'voice') };
}
const send = async (u, channelId) => {
  const r = await as(u, 'POST', `/channels/${channelId}/messages`, { ciphertext: cipher(), epoch: 1 });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
};
// A private channel: @everyone can't see it, the Mod role can.
async function privateChannel(c, name = 'secret-' + hex(2)) {
  const ch = (await as(c.owner, 'POST', `/servers/${c.server.id}/channels`, { name })).json;
  assert.equal((await as(c.owner, 'PUT', `/channels/${ch.id}/overrides`, { overrides: [{ type: 'role', id: c.server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: c.role, allow: P.VIEW, deny: 0 }] })).status, 200);
  return ch;
}

// ------------------------------------------------------------------ the permission
test('View Audit Log is permission bit 19; owners, Administrators and holders read the log, nobody else does', async () => {
  const c = await community();
  const outsider = await srv.register();
  assert.equal((await as(c.owner, 'GET', `/servers/${c.server.id}/audit`)).status, 200, 'the owner');
  assert.equal((await as(c.reader, 'GET', `/servers/${c.server.id}/audit`)).status, 200, 'View Audit Log');
  const r = await as(c.mod, 'GET', `/servers/${c.server.id}/audit`);
  assert.equal(r.status, 403, 'moderator powers alone don’t include the log');
  assert.match(r.json.error, /View Audit Log/);
  assert.equal((await as(c.member, 'GET', `/servers/${c.server.id}/audit`)).status, 403);
  assert.equal((await as(outsider, 'GET', `/servers/${c.server.id}/audit`)).status, 404, 'outsiders get the same answer as for a server that doesn’t exist');
  assert.equal((await srv.api('GET', `/servers/${c.server.id}/audit`)).status, 401);
  // Administrator includes it.
  const admin = (await as(c.owner, 'POST', `/servers/${c.server.id}/roles`, { name: 'Admin', permissions: P.ADMIN })).json.id;
  await as(c.owner, 'PUT', `/servers/${c.server.id}/members/${c.member.id}/roles`, { add: [admin] });
  assert.equal((await as(c.member, 'GET', `/servers/${c.server.id}/audit`)).status, 200, 'Administrator');
  // It's a moderator power: it can't be sold as a membership or picked by members themselves.
  const pickable = (await as(c.mod, 'POST', `/servers/${c.server.id}/roles`, { name: 'Pick me' })).json.id; // below Mod
  const no = await as(c.owner, 'PATCH', `/roles/${pickable}`, { selfAssign: true, permissions: P.AUDIT });
  assert.equal(no.status, 400);
  assert.match(no.json.error, /moderator powers/);
  // Group chats have no audit log.
  const friend = await srv.register();
  await as(c.owner, 'POST', '/friends', { username: friend.username });
  await as(friend, 'POST', `/friends/${c.owner.id}/accept`);
  const group = (await as(c.owner, 'POST', '/groups', { userIds: [friend.id] })).json;
  assert.equal((await as(c.owner, 'GET', `/servers/${group.id}/audit`)).status, 400);
  await as(c.owner, 'PATCH', `/servers/${group.id}`, { name: 'renamed group' });
  assert.equal(entries(group.id).length, 0, 'nothing is written for group chats');
});

// ------------------------------------------------------------------ what's written
test('kicks, bans (with their cleanup), unbans, timeouts and role changes are written with who did what to whom', async () => {
  const c = await community({ members: 4 });
  const [a, b, d, e] = c.members;
  // Role changes by a moderator.
  const helper = (await as(c.mod, 'POST', `/servers/${c.server.id}/roles`, { name: 'Helper', permissions: P.SEND })).json.id; // below Mod
  assert.equal((await as(c.mod, 'PUT', `/servers/${c.server.id}/members/${a.id}/roles`, { add: [helper] })).status, 200);
  let x = last(c.server.id, 'member_roles');
  assert.equal(x.actor_id, c.mod.id); assert.equal(x.target_id, a.id);
  assert.deepEqual(x.detail.added, [{ id: helper, name: 'Helper' }]);
  assert.deepEqual(x.detail.removed, []);
  // A change that changes nothing writes nothing.
  const before = entries(c.server.id).length;
  await as(c.mod, 'PUT', `/servers/${c.server.id}/members/${a.id}/roles`, { add: [helper] });
  assert.equal(entries(c.server.id).length, before);
  assert.equal((await as(c.mod, 'PUT', `/servers/${c.server.id}/members/${a.id}/roles`, { remove: [helper] })).status, 200);
  assert.deepEqual(last(c.server.id, 'member_roles').detail.removed, [{ id: helper, name: 'Helper' }]);
  // Kick.
  assert.equal((await as(c.mod, 'DELETE', `/servers/${c.server.id}/members/${b.id}`)).status, 200);
  x = last(c.server.id, 'member_kick');
  assert.equal(x.actor_id, c.mod.id); assert.equal(x.target_id, b.id);
  // Ban with message cleanup: one entry with the counts.
  srv.sql('UPDATE servers SET needs_rotation = 0 WHERE id = ?', c.server.id); // the kick asked for a new key; not what this tests
  await send(d, c.text.id); await send(d, c.text.id);
  const ban = await as(c.mod, 'POST', `/servers/${c.server.id}/bans`, { userId: d.id, reason: 'spam links', deleteHours: 24 });
  assert.equal(ban.status, 200, ban.text);
  x = last(c.server.id, 'member_ban');
  assert.equal(x.actor_id, c.mod.id); assert.equal(x.target_id, d.id);
  assert.equal(x.detail.reason, 'spam links'); assert.equal(x.detail.hours, 24); assert.equal(x.detail.count, 2);
  // A ban without cleanup, of someone who isn't a member.
  const stranger = await srv.register();
  assert.equal((await as(c.mod, 'POST', `/servers/${c.server.id}/bans`, { userId: stranger.id })).status, 200);
  x = last(c.server.id, 'member_ban');
  assert.equal(x.target_id, stranger.id); assert.equal(x.detail.hours, undefined); assert.equal(x.detail.member, false);
  // Unban: only when there was a ban to lift.
  assert.equal((await as(c.mod, 'DELETE', `/servers/${c.server.id}/bans/${d.id}`)).status, 200);
  assert.equal(last(c.server.id, 'member_unban').target_id, d.id);
  const n = entries(c.server.id).length;
  assert.equal((await as(c.mod, 'DELETE', `/servers/${c.server.id}/bans/${d.id}`)).status, 200);
  assert.equal(entries(c.server.id).length, n, 'nothing to unban, nothing written');
  // Timeouts.
  assert.equal((await as(c.mod, 'POST', `/servers/${c.server.id}/members/${e.id}/timeout`, { minutes: 10, reason: 'cool off' })).status, 200);
  x = last(c.server.id, 'member_timeout');
  assert.equal(x.target_id, e.id); assert.equal(x.detail.minutes, 10); assert.equal(x.detail.reason, 'cool off');
  assert.equal((await as(c.mod, 'DELETE', `/servers/${c.server.id}/members/${e.id}/timeout`)).status, 200);
  assert.equal(last(c.server.id, 'member_timeout_remove').target_id, e.id);
  // The instance's own audit log still gets what it got before.
  assert.equal(srv.sql("SELECT COUNT(*) n FROM admin_log WHERE action = 'member_timeout' AND target = ?", e.id)[0].n, 1);
  // Readers get names to show, and newest first.
  const out = await log(c.reader, c.server.id);
  assert.equal(out.entries[0].action, 'member_timeout_remove');
  assert.ok(out.entries.every((y, i) => i === 0 || y.id < out.entries[i - 1].id));
  for (const u of [c.mod, b, d, e, stranger]) assert.equal(out.users[u.id].username, u.username);
  const banned = out.entries.find((y) => y.action === 'member_ban' && y.targetId === d.id);
  assert.deepEqual({ reason: banned.detail.reason, hours: banned.detail.hours, count: banned.detail.count }, { reason: 'spam links', hours: 24, count: 2 });
});

test('roles members pick themselves are marked as such, and one member can’t flood the log with them', async () => {
  const c = await community();
  const game = (await as(c.mod, 'POST', `/servers/${c.server.id}/roles`, { name: 'game-night' })).json.id; // below Mod
  assert.equal((await as(c.owner, 'PATCH', `/roles/${game}`, { selfAssign: true })).status, 200);
  assert.equal((await as(c.member, 'POST', `/servers/${c.server.id}/me/roles/${game}`)).status, 200);
  const x = last(c.server.id, 'member_roles');
  assert.equal(x.actor_id, c.member.id); assert.equal(x.target_id, c.member.id);
  assert.equal(x.detail.self, true);
  assert.deepEqual(x.detail.added, [{ id: game, name: 'game-night' }]);
  // At most 20 entries an hour per member: toggling on and on stops being written (the toggles still work).
  for (let i = 0; i < 22; i++) {
    const r = await as(c.member, i % 2 ? 'POST' : 'DELETE', `/servers/${c.server.id}/me/roles/${game}`);
    if (r.status === 429) { await sleep(1100); i--; continue; }
    assert.equal(r.status, 200, r.text);
  }
  const mine = srv.sql("SELECT detail FROM server_audit WHERE server_id = ? AND action = 'member_roles' AND actor_id = ?", c.server.id, c.member.id);
  assert.equal(mine.length, 20);
  assert.equal(JSON.parse(mine[19].detail).last, true, 'the last one written says so');
});

test('channels, permissions, roles, invites, emoji and server settings are written; never what a message said', async () => {
  const c = await community();
  // Channels.
  const ch = (await as(c.mod, 'POST', `/servers/${c.server.id}/channels`, { name: 'news' })).json;
  let x = last(c.server.id, 'channel_create');
  assert.equal(x.target_id, ch.id); assert.equal(x.channel_id, ch.id); assert.deepEqual(x.detail.channel, { id: ch.id, name: 'news' });
  assert.equal((await as(c.mod, 'PATCH', `/channels/${ch.id}`, { name: 'announcements', topic: 'Read me', slowmode: 30 })).status, 200);
  x = last(c.server.id, 'channel_update');
  assert.deepEqual(x.detail.changes, { name: { from: 'news', to: 'announcements' }, topic: true, slowmode: { from: 0, to: 30 } });
  assert.ok(!JSON.stringify(x.detail).includes('Read me'), 'a topic’s text isn’t copied into the log');
  // Overrides.
  assert.equal((await as(c.owner, 'PUT', `/channels/${ch.id}/overrides`, { overrides: [{ type: 'role', id: c.server.id, allow: 0, deny: P.SEND }] })).status, 200);
  x = last(c.server.id, 'channel_overrides');
  assert.deepEqual(x.detail.changes, [{ type: 'role', id: c.server.id, name: '@everyone', allow: 0, deny: P.SEND, was: { allow: 0, deny: 0 } }]);
  // Roles.
  const r = (await as(c.owner, 'POST', `/servers/${c.server.id}/roles`, { name: 'Artist', permissions: P.SEND })).json.id;
  assert.equal(last(c.server.id, 'role_create').detail.name, 'Artist');
  assert.equal((await as(c.owner, 'PATCH', `/roles/${r}`, { name: 'Artists', permissions: P.SEND | P.MANAGE_EMOJIS, hoist: true })).status, 200);
  x = last(c.server.id, 'role_update');
  assert.deepEqual(x.detail.changes, { name: { from: 'Artist', to: 'Artists' }, hoist: true, permissions: { added: P.MANAGE_EMOJIS, removed: 0 } });
  assert.equal((await as(c.owner, 'DELETE', `/roles/${r}`)).status, 200);
  assert.equal(last(c.server.id, 'role_delete').detail.name, 'Artists');
  // Invites.
  const inv = (await as(c.owner, 'POST', `/servers/${c.server.id}/invites`, { maxUses: 5, expiresHours: 24 })).json.code;
  assert.deepEqual(last(c.server.id, 'invite_create').detail, { maxUses: 5, hours: 24 });
  assert.equal((await as(c.owner, 'DELETE', `/invites/${inv}`)).status, 200);
  assert.equal(last(c.server.id, 'invite_revoke').target_id, inv);
  // Server settings: what changed, not the new text.
  assert.equal((await as(c.owner, 'PATCH', `/servers/${c.server.id}`, { name: 'Renamed', description: 'secret plans', theme: { welcome: 'hi', accent: '#ff0000' } })).status, 200);
  x = last(c.server.id, 'server_update');
  assert.deepEqual(x.detail.changes, ['name', 'description', 'accent', 'welcome']);
  assert.deepEqual(x.detail.name, { from: c.server.name, to: 'Renamed' });
  assert.ok(!JSON.stringify(x.detail).includes('secret plans'));
  // A moderator deleting someone else's message: whose and where, never the ciphertext. Their own: nothing.
  const msg = await send(c.member, c.text.id);
  const n0 = entries(c.server.id).length;
  const own = await send(c.mod, c.text.id);
  assert.equal((await as(c.mod, 'DELETE', `/messages/${own}`)).status, 200);
  assert.equal(entries(c.server.id).length, n0, 'deleting your own message isn’t moderation');
  assert.equal((await as(c.mod, 'DELETE', `/messages/${msg}`)).status, 200);
  x = last(c.server.id, 'message_delete');
  assert.equal(x.actor_id, c.mod.id); assert.equal(x.target_id, c.member.id); assert.equal(x.channel_id, c.text.id);
  assert.deepEqual(Object.keys(x.detail), ['channel']);
  assert.ok(!x.detail.channel.private);
  // Bulk delete.
  for (let i = 0; i < 3; i++) await send(c.member, c.text.id);
  assert.equal((await as(c.mod, 'POST', `/channels/${c.text.id}/messages/bulk-delete`, { count: 3 })).status, 200);
  assert.equal(last(c.server.id, 'message_bulk_delete').detail.count, 3);
  // Channel delete keeps the name it had.
  assert.equal((await as(c.mod, 'DELETE', `/channels/${ch.id}`)).status, 200);
  assert.deepEqual(last(c.server.id, 'channel_delete').detail.channel, { id: ch.id, name: 'announcements' });
  // Ownership.
  const t = await as(c.owner, 'POST', `/servers/${c.server.id}/transfer`, { userId: c.mod.id, authKey: c.owner.authKey });
  assert.equal(t.status, 200, t.text);
  x = last(c.server.id, 'server_transfer');
  assert.equal(x.target_id, c.mod.id); assert.equal(x.detail.from, c.owner.id);
  // Nothing anywhere in this server's log holds message ciphertext.
  assert.ok(entries(c.server.id).every((e) => !/v2:/.test(e.detail)));
});

// ------------------------------------------------------------------ what a reader sees
test('a reader who can’t see a channel doesn’t learn its name, old names, webhooks or permissions', async () => {
  const c = await community();
  const secret = await privateChannel(c, 'mod-talk');
  assert.equal((await as(c.mod, 'PATCH', `/channels/${secret.id}`, { name: 'mod-plans' })).status, 200);
  const msg = await send(c.member, c.text.id);
  await as(c.mod, 'DELETE', `/messages/${msg}`);
  const theirs = await send(c.mod, secret.id);
  srv.sql('UPDATE messages SET author_id = ? WHERE id = ?', c.member.id, theirs); // as if the member had posted it before losing access
  assert.equal((await as(c.mod, 'DELETE', `/messages/${theirs}`)).status, 200);
  const out = await log(c.reader, c.server.id);
  const text = JSON.stringify(out);
  assert.ok(!/mod-talk|mod-plans/.test(text), 'no private channel names');
  const upd = out.entries.find((e) => e.action === 'channel_update');
  assert.deepEqual(upd.detail, { channel: { hidden: true } }, 'nothing but the fact');
  const ov = out.entries.find((e) => e.action === 'channel_overrides');
  assert.deepEqual(ov.detail, { channel: { hidden: true } });
  const dels = out.entries.filter((e) => e.action === 'message_delete');
  assert.ok(dels.some((e) => e.detail.channel.hidden) && dels.some((e) => e.detail.channel.name === c.text.name), 'a channel they can see keeps its name');
  // Someone who can see it gets the names, the old one and the new one.
  const ownerView = await log(c.owner, c.server.id);
  const u2 = ownerView.entries.find((e) => e.action === 'channel_update');
  assert.deepEqual(u2.detail.changes.name, { from: 'mod-talk', to: 'mod-plans' });
  assert.equal(u2.detail.channel.name, 'mod-talk'); assert.equal(u2.detail.channel.now, 'mod-plans');
  // Once it's deleted, its name stays hidden from readers who aren't Administrators; Administrators see it.
  assert.equal((await as(c.owner, 'DELETE', `/channels/${secret.id}`)).status, 200);
  const gone = (await log(c.reader, c.server.id)).entries.find((e) => e.action === 'channel_delete');
  assert.deepEqual(gone.detail, { channel: { hidden: true, deleted: true }, type: 'text' }, 'only what kind of channel it was');
  const asOwner = (await log(c.owner, c.server.id)).entries.find((e) => e.action === 'channel_delete');
  assert.deepEqual(asOwner.detail.channel, { name: 'mod-plans', deleted: true });
  // Invite codes are whole only for people who can list invites anyway.
  const inv = (await as(c.owner, 'POST', `/servers/${c.server.id}/invites`, {})).json.code;
  const masked = (await log(c.reader, c.server.id, '?action=invite_create')).entries[0];
  assert.notEqual(masked.targetId, inv); assert.ok(!JSON.stringify(masked).includes(inv));
  assert.equal((await log(c.owner, c.server.id, '?action=invite_create')).entries[0].targetId, inv);
});

test('webhooks are written by name and channel (never their secret), and hidden with a private channel', async () => {
  const c = await community({ members: 0 });
  const secret = await privateChannel(c, 'ops-' + hex(2));
  const open = (await as(c.owner, 'POST', `/channels/${c.text.id}/webhooks`, { name: 'Uptime' })).json;
  const hidden = (await as(c.owner, 'POST', `/channels/${secret.id}/webhooks`, { name: 'Deploy bot' })).json;
  assert.ok(open.token && hidden.token);
  const rot = await as(c.owner, 'POST', `/channels/${c.text.id}/webhooks/${open.webhook.id}/token`);
  assert.equal(rot.status, 200, rot.text);
  assert.equal((await as(c.owner, 'PATCH', `/channels/${c.text.id}/webhooks/${open.webhook.id}`, { name: 'Uptime Kuma' })).status, 200);
  assert.equal((await as(c.owner, 'DELETE', `/channels/${c.text.id}/webhooks/${open.webhook.id}`)).status, 200);
  const all = entries(c.server.id);
  for (const tok of [open.token, hidden.token, rot.json.token]) assert.ok(!all.some((e) => e.detail.includes(tok)), 'never the secret');
  assert.deepEqual(['webhook_create', 'webhook_rotate', 'webhook_update', 'webhook_delete'].map((a) => !!last(c.server.id, a)), [true, true, true, true]);
  assert.deepEqual(last(c.server.id, 'webhook_update').detail.renamed, { from: 'Uptime', to: 'Uptime Kuma' });
  const view = (await log(c.reader, c.server.id, '?action=webhook_create')).entries;
  assert.equal(view.find((e) => e.targetId === open.webhook.id).detail.name, 'Uptime');
  const h2 = view.find((e) => e.targetId === hidden.webhook.id);
  assert.deepEqual(h2.detail, { channel: { hidden: true } }, 'a private channel’s webhook keeps its name to itself');
});

test('making invites and lifting bans are rate limited (each one is an entry)', async () => {
  const c = await community({ members: 0 });
  let n = 0; let status = 200;
  while (status === 200 && n < 70) { status = (await as(c.owner, 'POST', `/servers/${c.server.id}/invites`, {})).status; n++; }
  assert.equal(status, 429, 'a loop of invites is refused');
  assert.ok(n > 50, 'after a generous allowance');
  let u = 200; let k = 0;
  while (u === 200 && k < 40) { u = (await as(c.mod, 'DELETE', `/servers/${c.server.id}/bans/${c.reader.id}`)).status; k++; }
  assert.equal(u, 429);
});

// ------------------------------------------------------------------ filters, paging, validation
test('filters by action, actor, target and person; pages with before; refuses bad input', async () => {
  const c = await community({ members: 3 });
  const [a, b] = c.members;
  await as(c.mod, 'POST', `/servers/${c.server.id}/members/${a.id}/timeout`, { minutes: 5 });
  await as(c.owner, 'POST', `/servers/${c.server.id}/members/${b.id}/timeout`, { minutes: 5 });
  await as(c.mod, 'DELETE', `/servers/${c.server.id}/members/${a.id}`);
  let out = await log(c.owner, c.server.id, '?action=member_timeout');
  assert.equal(out.entries.length, 2);
  assert.ok(out.entries.every((e) => e.action === 'member_timeout'));
  out = await log(c.owner, c.server.id, '?action=member_timeout,member_kick');
  assert.equal(out.entries.length, 3);
  out = await log(c.owner, c.server.id, `?actor=${c.mod.id}`);
  assert.ok(out.entries.length >= 2 && out.entries.every((e) => e.actorId === c.mod.id));
  out = await log(c.owner, c.server.id, `?target=${a.id}`);
  assert.deepEqual(out.entries.map((e) => e.action), ['member_kick', 'member_timeout']);
  out = await log(c.owner, c.server.id, `?user=${c.mod.id}`);
  assert.ok(out.entries.some((e) => e.targetId === c.mod.id) && out.entries.some((e) => e.actorId === c.mod.id), 'done by them or to them');
  // Paging.
  const all = (await log(c.owner, c.server.id, '?limit=100')).entries;
  assert.ok(all.length > 4);
  const p1 = await log(c.owner, c.server.id, '?limit=2');
  assert.equal(p1.entries.length, 2); assert.equal(p1.hasMore, true);
  const p2 = await log(c.owner, c.server.id, `?limit=2&before=${p1.entries[1].id}`);
  assert.deepEqual(p2.entries.map((e) => e.id), all.slice(2, 4).map((e) => e.id));
  const newer = await log(c.owner, c.server.id, `?after=${all[2].id}`);
  assert.deepEqual(newer.entries.map((e) => e.id), all.slice(0, 2).map((e) => e.id));
  assert.ok((await log(c.owner, c.server.id, '?limit=5000')).entries.length <= 100);
  // Bad input.
  for (const q of ['?action=drop_table', '?action=member_kick,nope', '?before=abc', '?after=-1', `?actor=${'x'.repeat(80)}`, '?target=a%20b']) {
    assert.equal((await as(c.owner, 'GET', `/servers/${c.server.id}/audit${q}`)).status, 400, q);
  }
});

test('reading the log is rate limited', async () => {
  const c = await community({ members: 0 });
  let limited = false;
  for (let i = 0; i < 70 && !limited; i++) limited = (await as(c.reader, 'GET', `/servers/${c.server.id}/audit`)).status === 429;
  assert.ok(limited, 'a flood of reads is refused');
});

// ------------------------------------------------------------------ live updates
test('an open Audit log tab hears about new entries, and stops when its reader loses the permission', async () => {
  const c = await community({ members: 2 });
  const s = await sock(c.reader);
  const got = collect(s, 'audit:new');
  assert.deepEqual(await ack(s, 'audit:watch', { serverId: c.server.id }), { ok: true });
  await as(c.mod, 'POST', `/servers/${c.server.id}/members/${c.member.id}/timeout`, { minutes: 5 });
  assert.ok(await until(() => got.length === 1), 'told about the new entry');
  assert.deepEqual(got[0], { serverId: c.server.id });
  // Without the permission, watching is refused.
  const m = await sock(c.member);
  assert.match((await ack(m, 'audit:watch', { serverId: c.server.id })).error, /View Audit Log/);
  const outsider = await srv.register();
  const o = await sock(outsider);
  assert.match((await ack(o, 'audit:watch', { serverId: c.server.id })).error, /not found/i);
  assert.match((await ack(o, 'audit:watch', { serverId: '../x' })).error, /not found/i);
  // Lose the role: no more news (and the connection stops watching). Notices are at most every 2 seconds.
  assert.equal((await as(c.owner, 'PUT', `/servers/${c.server.id}/members/${c.reader.id}/roles`, { remove: [c.readRole] })).status, 200);
  await sleep(2400);
  const had = got.length;
  await as(c.mod, 'DELETE', `/servers/${c.server.id}/members/${c.member.id}/timeout`);
  await sleep(2400);
  assert.equal(got.length, had, 'nothing after the permission went');
});

test('a burst of entries sends a notice every 2 seconds at most, and live fetches have their own allowance', async () => {
  const c = await community({ members: 1 });
  const s = await sock(c.reader);
  const got = collect(s, 'audit:new');
  assert.deepEqual(await ack(s, 'audit:watch', { serverId: c.server.id }), { ok: true });
  // About ten entries over 3 seconds: two or three notices, not ten.
  const end = Date.now() + 3000;
  while (Date.now() < end) { await as(c.owner, 'PATCH', `/channels/${c.text.id}`, { topic: hex(4) }); await sleep(300); }
  await sleep(2200);
  assert.ok(got.length >= 1 && got.length <= 3, `${got.length} notices`);
  // An open tab's ?after= fetches don't use up the allowance for reading and paging (and have one of their own).
  let live = 0; let status = 200;
  while (status === 200 && live < 50) { status = (await as(c.reader, 'GET', `/servers/${c.server.id}/audit?after=1`)).status; live++; }
  assert.equal(status, 429); assert.ok(live > 30, `${live}`);
  assert.equal((await as(c.reader, 'GET', `/servers/${c.server.id}/audit`)).status, 200, 'paging still works');
});

// ------------------------------------------------------------------ append-only and retention
test('the database refuses to change or delete entries, except for a deleted server and old ones', async () => {
  const c = await community({ members: 1 });
  await as(c.mod, 'DELETE', `/servers/${c.server.id}/members/${c.member.id}`);
  const e = last(c.server.id, 'member_kick');
  assert.throws(() => srv.sql('UPDATE server_audit SET actor_id = ? WHERE id = ?', c.owner.id, e.id), /append-only/);
  assert.throws(() => srv.sql('DELETE FROM server_audit WHERE id = ?', e.id), /append-only/);
  // Over a year old: the retention job may delete it.
  const old = srv.sql("INSERT INTO server_audit (server_id, seq, action, detail, created_at) SELECT ?, MAX(seq) + 1, 'member_kick', '{}', ? FROM server_audit WHERE server_id = ?",
    c.server.id, Date.now() - 400 * 86400000, c.server.id).lastInsertRowid;
  srv.sql('DELETE FROM server_audit WHERE id = ?', old);
  // Deleting the server takes its log with it.
  assert.equal((await as(c.owner, 'DELETE', `/servers/${c.server.id}`, { authKey: c.owner.authKey })).status, 200);
  assert.equal(entries(c.server.id).length, 0);
});

// ------------------------------------------------------------------ report inbox
// A message reported in a server: the reporter's app sends the messages it chose to include, decrypted.
const reportMessage = (reporter, messageId, extra = {}) => as(reporter, 'POST', '/reports', {
  category: 'harassment', details: 'keeps doing this', targetId: 'x', context: { kind: 'message', messageId },
  evidence: [{ id: messageId, text: 'the nasty words', files: [] }], ...extra,
});
const inbox = async (u, sid, q = '') => { const r = await as(u, 'GET', `/servers/${sid}/reports${q}`); return r; };

test('a message reported in a server reaches its moderators, without who reported it, and staff still see everything', async () => {
  const c = await community({ members: 2 });
  const [reporter, offender] = c.members;
  const s = await sock(c.mod);
  const told = collect(s, 'server:report');
  const msg = await send(offender, c.text.id);
  const r = await reportMessage(reporter, msg);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.toServer, true);
  assert.ok(await until(() => told.length === 1), 'moderators online are told');
  assert.equal(told[0].serverId, c.server.id);
  const got = await inbox(c.mod, c.server.id);
  assert.equal(got.status, 200, got.text);
  assert.equal(got.json.open, 1);
  const rep = got.json.reports[0];
  assert.equal(rep.targetId, offender.id); assert.equal(rep.category, 'harassment'); assert.equal(rep.details, 'keeps doing this');
  assert.equal(rep.evidence[0].text, 'the nasty words'); assert.equal(rep.evidence[0].authorId, offender.id);
  assert.equal(rep.context.channelId, c.text.id);
  // Never who reported it, from where, or reports from elsewhere.
  const raw = JSON.stringify(got.json);
  assert.ok(!raw.includes(reporter.id) && !raw.includes(reporter.username), 'the reporter stays anonymous');
  assert.ok(!/reporterIp|targetIps|priorReports|reporter/.test(raw));
  // Plain members, outsiders and readers of the audit log alone don't get the inbox.
  assert.equal((await inbox(offender, c.server.id)).status, 403);
  assert.equal((await inbox(c.reader, c.server.id)).status, 403);
  assert.equal((await inbox(await srv.register(), c.server.id)).status, 404);
  // Handled by a moderator: their own status, kept on the report (not in the audit log); instance staff's stays open.
  const h = await as(c.mod, 'PATCH', `/servers/${c.server.id}/reports/${rep.id}`, { status: 'handled', note: 'warned them' });
  assert.equal(h.status, 200, h.text);
  const after = (await inbox(c.mod, c.server.id, '?status=handled')).json.reports[0];
  assert.equal(after.status, 'handled'); assert.equal(after.handledBy, c.mod.id); assert.equal(after.note, 'warned them');
  assert.equal((await inbox(c.mod, c.server.id)).json.open, 0);
  assert.ok(!entries(c.server.id).some((e) => e.action.startsWith('report') || e.detail.includes('harassment')), 'nothing about it in the audit log');
  assert.ok(!entries(c.server.id).some((e) => e.detail.includes(reporter.id) || e.actor_id === reporter.id), 'the log never names the reporter');
  const staff = (await as(srv.owner, 'GET', '/admin/reports?status=open')).json.find((y) => y.id === rep.id);
  assert.equal(staff.status, 'open', 'instance staff still have it open');
  assert.equal(staff.reporter.id, reporter.id, 'staff see the reporter, as before');
  assert.equal(staff.serverInbox.status, 'handled'); assert.equal(staff.serverInbox.handledBy.id, c.mod.id);
  // Bad input.
  assert.equal((await as(c.mod, 'PATCH', `/servers/${c.server.id}/reports/${rep.id}`, { status: 'resolved' })).status, 400);
  assert.equal((await as(c.mod, 'PATCH', `/servers/${c.server.id}/reports/${rep.id}`, { status: 'open', note: 5 })).status, 400);
  assert.equal((await as(c.mod, 'PATCH', `/servers/${c.server.id}/reports/nope`, { status: 'open' })).status, 404);
  assert.equal((await as(offender, 'PATCH', `/servers/${c.server.id}/reports/${rep.id}`, { status: 'dismissed' })).status, 403);
  // Reopened.
  assert.equal((await as(c.mod, 'PATCH', `/servers/${c.server.id}/reports/${rep.id}`, { status: 'open' })).status, 200);
  const reopened = (await inbox(c.mod, c.server.id)).json.reports[0];
  assert.equal(reopened.status, 'open'); assert.equal(reopened.handledBy, null);
  assert.equal((await inbox(c.mod, c.server.id, '?status=all')).json.reports.length, 1);
  assert.equal((await inbox(c.mod, c.server.id, '?before=yesterday')).status, 400);
  assert.equal((await inbox(c.mod, c.server.id, `?status=all&before=${rep.createdAt}`)).json.reports.length, 0, 'paged by time');
});

test('which reports reach a moderator: role order, never about themselves, channels they can see, the reporter’s choice', async () => {
  const c = await community({ members: 3, modPerms: P.KICK });
  const [reporter, offender, other] = c.members;
  const mine = async () => (await inbox(c.mod, c.server.id)).json.reports;
  // About the moderator: not theirs to see (the owner sees it).
  const m1 = await send(c.mod, c.text.id);
  assert.equal((await reportMessage(reporter, m1)).status, 200);
  assert.equal((await mine()).length, 0);
  assert.equal((await inbox(c.owner, c.server.id)).json.reports.length, 1);
  // About the owner: nobody in the server sees it (instance staff do).
  const o1 = await send(c.owner, c.text.id);
  assert.equal((await reportMessage(other, o1)).status, 200);
  assert.equal((await inbox(c.owner, c.server.id)).json.reports.length, 1, 'the owner doesn’t see reports about themselves');
  // In a private channel the moderator can't see.
  const secret = (await as(c.owner, 'POST', `/servers/${c.server.id}/channels`, { name: 'staff-' + hex(2) })).json;
  await as(c.owner, 'PUT', `/channels/${secret.id}/overrides`, { overrides: [{ type: 'role', id: c.server.id, allow: 0, deny: P.VIEW }, { type: 'member', id: offender.id, allow: P.VIEW | P.SEND, deny: 0 }, { type: 'member', id: reporter.id, allow: P.VIEW, deny: 0 }] });
  const s1 = await send(offender, secret.id);
  assert.equal((await reportMessage(reporter, s1)).status, 200);
  assert.equal((await mine()).length, 0, 'not from a channel they can’t see');
  // The reporter unticked it, or it's for instance staff alone.
  const p1 = await send(offender, c.text.id);
  const optOut = await reportMessage(reporter, p1, { toServer: false });
  assert.equal(optOut.json.toServer, false);
  const p2 = await send(offender, c.text.id);
  assert.equal((await reportMessage(other, p2, { category: 'child_safety' })).json.toServer, false);
  assert.equal((await mine()).length, 0);
  // A normal one reaches them.
  const p3 = await send(offender, c.text.id);
  assert.equal((await reportMessage(other, p3)).status, 200);
  assert.equal((await mine()).length, 1);
  // Someone at or above them: no longer theirs once the offender is promoted.
  const big = (await as(c.owner, 'POST', `/servers/${c.server.id}/roles`, { name: 'Big' })).json.id; // goes on top
  await as(c.owner, 'PUT', `/servers/${c.server.id}/members/${offender.id}/roles`, { add: [big] });
  assert.equal((await mine()).length, 0);
  // A direct message report never reaches a server.
  const dm = await as(reporter, 'POST', '/dms', { userId: other.id });
  assert.equal(dm.status, 200, dm.text);
  const d = await as(other, 'POST', `/dms/${dm.json.id}/messages`, { ciphertext: cipher() });
  assert.equal(d.status, 200, d.text);
  const viaDm = await reportMessage(reporter, d.json.id);
  assert.equal(viaDm.status, 200, viaDm.text);
  assert.equal(viaDm.json.toServer, false);
});

test('a member reported from inside a server reaches its moderators; a server the reporter isn’t in is ignored', async () => {
  const c = await community({ members: 2 });
  const [reporter, offender] = c.members;
  const r = await as(reporter, 'POST', '/reports', { category: 'impersonation', targetId: offender.id, context: { kind: 'user', serverId: c.server.id } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.toServer, true);
  const rep = (await inbox(c.mod, c.server.id)).json.reports[0];
  assert.equal(rep.context.kind, 'user'); assert.equal(rep.targetId, offender.id); assert.deepEqual(rep.evidence, []);
  // A server the reporter isn't in (or a made-up id) is quietly ignored: the report goes to staff only.
  const other = await community({ members: 0 });
  const r2 = await as(reporter, 'POST', '/reports', { category: 'spam', targetId: other.mod.id, context: { kind: 'user', serverId: other.server.id } });
  assert.equal(r2.status, 200); assert.equal(r2.json.toServer, false);
  const r3 = await as(c.member, 'POST', '/reports', { category: 'spam', targetId: c.owner.id, context: { kind: 'user', serverId: '<script>' } });
  assert.equal(r3.status, 200); assert.equal(r3.json.toServer, false);
  assert.equal((await inbox(other.owner, other.server.id)).json.reports.length, 0);
});

test('moderators get only the reported person’s messages from a report, never the reporter’s or anyone else’s', async () => {
  // This file signs up more people than the instance-wide limit allows in an hour (120, kept in memory): a restart
  // starts that count again.
  await srv.restart();
  const c = await community({ members: 3 });
  const [reporter, offender, bystander] = c.members;
  // An argument: the reporter's own messages are right before the reported one, as the dialog includes them.
  const m1 = await send(reporter, c.text.id);
  const m2 = await send(offender, c.text.id);
  const m3 = await send(bystander, c.text.id);
  const m4 = await send(reporter, c.text.id);
  const bad = await send(offender, c.text.id);
  const r = await as(reporter, 'POST', '/reports', {
    category: 'harassment', targetId: offender.id, context: { kind: 'message', messageId: bad },
    evidence: [[m1, 'you started it'], [m2, 'whatever'], [m3, 'calm down both'], [m4, 'leave me alone'], [bad, 'the nasty words']].map(([id, text]) => ({ id, text, files: [] })),
  });
  assert.equal(r.status, 200, r.text);
  const got = (await inbox(c.mod, c.server.id)).json;
  const rep = got.reports.find((x) => x.id === r.json.id);
  assert.deepEqual(rep.evidence.map((e) => [e.id, e.authorId, e.text]), [[m2, offender.id, 'whatever'], [bad, offender.id, 'the nasty words']]);
  assert.ok(rep.evidence.find((e) => e.id === bad).reported);
  assert.ok(!rep.evidence.some((e) => e.authorId === reporter.id));
  assert.ok(!(reporter.id in got.users) && !(bystander.id in got.users), 'nobody else in the users map');
  const raw = JSON.stringify(got);
  for (const t of ['you started it', 'leave me alone', 'calm down both', reporter.id, reporter.username]) assert.ok(!raw.includes(t), t);
  // Instance staff still get everything the reporter shared.
  const staff = (await as(srv.owner, 'GET', '/admin/reports?status=open')).json.find((y) => y.id === r.json.id);
  assert.equal(staff.evidence.length, 5);
});

test('handling a report leaves nothing in the audit log: the person reported can’t learn of it there', async () => {
  const c = await community({ members: 3, modPerms: P.KICK | P.AUDIT | P.MANAGE_ROLES });
  const [reporter, offender, other] = c.members;
  // The offender can read the audit log (a role below the moderator's), and so can a reader with nothing else.
  const watcher = (await as(c.mod, 'POST', `/servers/${c.server.id}/roles`, { name: 'Watcher', permissions: P.AUDIT })).json.id;
  assert.equal((await as(c.mod, 'PUT', `/servers/${c.server.id}/members/${offender.id}/roles`, { add: [watcher] })).status, 200);
  const watchers = {};
  for (const [k, u] of [['offender', offender], ['reader', c.reader], ['mod', c.mod]]) {
    const s = await sock(u);
    watchers[k] = collect(s, 'audit:new');
    assert.deepEqual(await ack(s, 'audit:watch', { serverId: c.server.id }), { ok: true });
  }
  const msg = await send(offender, c.text.id);
  const rep = (await reportMessage(reporter, msg, { category: 'hate' })).json.id;
  // A report about the moderator, who can read the log; and one from a channel the moderator can't see.
  const m2 = await send(c.mod, c.text.id);
  const rep2 = (await reportMessage(other, m2, { category: 'self_harm' })).json.id;
  const secret = (await as(c.owner, 'POST', `/servers/${c.server.id}/channels`, { name: 'quiet-' + hex(2) })).json;
  await as(c.owner, 'PUT', `/channels/${secret.id}/overrides`, { overrides: [{ type: 'role', id: c.server.id, allow: 0, deny: P.VIEW }, { type: 'member', id: other.id, allow: P.VIEW | P.SEND, deny: 0 }, { type: 'member', id: reporter.id, allow: P.VIEW, deny: 0 }] });
  const m3 = await send(other, secret.id);
  const rep3 = (await reportMessage(reporter, m3, { category: 'sexual' })).json.id;
  await sleep(2300); // past any notice from setting up
  for (const k of Object.keys(watchers)) watchers[k].length = 0;
  const before = (await log(c.owner, c.server.id, '?limit=100')).entries.map((e) => e.id);
  for (const [id, status] of [[rep, 'dismissed'], [rep2, 'dismissed'], [rep3, 'handled'], [rep, 'open'], [rep, 'handled']]) {
    assert.equal((await as(c.owner, 'PATCH', `/servers/${c.server.id}/reports/${id}`, { status })).status, 200);
  }
  await sleep(2400);
  for (const k of Object.keys(watchers)) assert.equal(watchers[k].length, 0, `${k}: no notice, so nothing to notice`);
  for (const u of [c.owner, c.mod, offender, c.reader]) {
    const out = await log(u, c.server.id, '?limit=100');
    assert.deepEqual(out.entries.map((e) => e.id), before, 'the same entries for everyone, with no gaps');
    assert.ok(!/hate|self_harm|sexual/.test(JSON.stringify(out)));
  }
  // The trail is on the report, for the moderators who can see it.
  const mine = (await inbox(c.mod, c.server.id, '?status=all')).json.reports;
  assert.deepEqual(mine.map((x) => [x.id, x.status, x.handledBy]), [[rep, 'handled', c.owner.id]], 'not the one about them, nor the hidden channel’s');
  assert.equal((await inbox(offender, c.server.id)).status, 403);
  assert.equal((await inbox(c.reader, c.server.id)).status, 403);
  assert.ok(!['report_handled', 'report_dismissed', 'report_reopened'].some((a) => (srv.sql('SELECT 1 FROM server_audit WHERE action = ?', a)).length));
  assert.equal((await as(c.owner, 'GET', `/servers/${c.server.id}/audit?action=report_handled`)).status, 400, 'not a kind of entry');
});

test('a deleted channel’s name is hidden from readers if it was private when deleted, whatever older entries say', async () => {
  const c = await community({ members: 2, modPerms: P.KICK });
  // Created public, then locked (the app makes private channels this way), then deleted.
  const ch = await privateChannel(c, 'plan-to-ban-sam');
  const pub = (await as(c.owner, 'POST', `/servers/${c.server.id}/channels`, { name: 'old-news' })).json;
  assert.equal((await as(c.owner, 'DELETE', `/channels/${ch.id}`)).status, 200);
  assert.equal((await as(c.owner, 'DELETE', `/channels/${pub.id}`)).status, 200);
  const out = await log(c.reader, c.server.id, '?action=channel_create,channel_delete,channel_overrides');
  assert.ok(!JSON.stringify(out).includes('plan-to-ban-sam'), 'no entry names it');
  const about = (id) => out.entries.filter((e) => e.targetId === id).map((e) => [e.action, e.detail.channel]);
  assert.deepEqual(about(ch.id), [['channel_delete', { hidden: true, deleted: true }], ['channel_overrides', { hidden: true, deleted: true }], ['channel_create', { hidden: true, deleted: true }]]);
  assert.deepEqual(about(pub.id), [['channel_delete', { name: 'old-news', deleted: true }], ['channel_create', { name: 'old-news', deleted: true }]], 'a public one keeps its name');
  // Administrators still see it.
  assert.ok(JSON.stringify(await log(c.owner, c.server.id)).includes('plan-to-ban-sam'));
  // A report filed while a channel was public, which was locked and then deleted: only Administrators see it now.
  const [reporter, offender] = c.members;
  const ch2 = (await as(c.owner, 'POST', `/servers/${c.server.id}/channels`, { name: 'was-open-' + hex(2) })).json;
  const msg = await send(offender, ch2.id);
  assert.equal((await reportMessage(reporter, msg)).status, 200);
  assert.equal((await inbox(c.mod, c.server.id)).json.reports.length, 1);
  await as(c.owner, 'PUT', `/channels/${ch2.id}/overrides`, { overrides: [{ type: 'role', id: c.server.id, allow: 0, deny: P.VIEW }, { type: 'member', id: offender.id, allow: P.VIEW, deny: 0 }] });
  assert.equal((await as(c.owner, 'DELETE', `/channels/${ch2.id}`)).status, 200);
  assert.equal((await inbox(c.mod, c.server.id)).json.reports.length, 0, 'gone from the Kick moderator’s inbox');
  assert.equal((await inbox(c.owner, c.server.id)).json.reports.length, 1);
});

test('the person filter finds people who are no longer members, by username too', async () => {
  const c = await community({ members: 2 });
  const [banned, kicked] = c.members;
  await as(c.mod, 'POST', `/servers/${c.server.id}/bans`, { userId: banned.id });
  await as(c.mod, 'DELETE', `/servers/${c.server.id}/members/${kicked.id}`);
  let out = await log(c.reader, c.server.id, `?username=${banned.username.toUpperCase()}`);
  assert.deepEqual(out.entries.map((e) => [e.action, e.actorId]), [['member_ban', c.mod.id]]);
  out = await log(c.reader, c.server.id, `?username=@${kicked.username}`);
  assert.deepEqual(out.entries.map((e) => e.action), ['member_kick']);
  assert.equal((await log(c.reader, c.server.id, '?username=nobody-' + hex(4))).entries.length, 0, 'an unknown name matches nothing');
  assert.equal((await as(c.reader, 'GET', `/servers/${c.server.id}/audit?username=${'x'.repeat(65)}`)).status, 400);
});

test('invites: the dialog reuses a fresh one, each person’s are written 10 an hour at most, and revoking is rate limited', async () => {
  const c = await community({ members: 1 });
  const member = c.member; // a plain member: Create Invite is on for @everyone
  const before = entries(c.server.id).length;
  const a = (await as(member, 'POST', `/servers/${c.server.id}/invites`, { expiresHours: 24, maxUses: 5, reuse: true })).json;
  const b = (await as(member, 'POST', `/servers/${c.server.id}/invites`, { expiresHours: 24, maxUses: 5, reuse: true })).json;
  assert.equal(b.code, a.code); assert.equal(b.reused, true);
  const d = (await as(member, 'POST', `/servers/${c.server.id}/invites`, { expiresHours: 24, maxUses: 0, reuse: true })).json;
  assert.notEqual(d.code, a.code, 'other settings: a new one');
  const e = (await as(member, 'POST', `/servers/${c.server.id}/invites`, { expiresHours: 0, reuse: true })).json;
  assert.equal((await as(member, 'POST', `/servers/${c.server.id}/invites`, { expiresHours: 0, reuse: true })).json.code, e.code);
  assert.equal(entries(c.server.id).length, before + 3);
  // Someone else's, or one already used, isn't handed out again.
  assert.notEqual((await as(c.mod, 'POST', `/servers/${c.server.id}/invites`, { expiresHours: 24, maxUses: 5, reuse: true })).json.code, a.code);
  const joiner = await srv.register();
  assert.equal((await as(joiner, 'POST', `/invites/${a.code}/join`)).status, 200);
  assert.notEqual((await as(member, 'POST', `/servers/${c.server.id}/invites`, { expiresHours: 24, maxUses: 5, reuse: true })).json.code, a.code);
  // Without reuse (API clients), each is new; past 10 an hour, a person's aren't written (the 10th says so).
  for (let i = 0; i < 10; i++) assert.equal((await as(member, 'POST', `/servers/${c.server.id}/invites`, {})).status, 200);
  const mine = srv.sql("SELECT detail FROM server_audit WHERE server_id = ? AND action = 'invite_create' AND actor_id = ? ORDER BY id", c.server.id, member.id);
  assert.equal(mine.length, 10);
  assert.equal(JSON.parse(mine[9].detail).last, true);
  // Revoking their own: capped the same way. A moderator revoking someone else's is always written.
  const codes = (await as(member, 'GET', `/servers/${c.server.id}/invites`)).json.map((x) => x.code);
  assert.ok(codes.length >= 12);
  for (const code of codes.slice(0, 11)) assert.equal((await as(member, 'DELETE', `/invites/${code}`)).status, 200);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM server_audit WHERE server_id = ? AND action = 'invite_revoke' AND actor_id = ?", c.server.id, member.id)[0].n, 10);
  assert.equal((await as(c.owner, 'DELETE', `/invites/${codes[11]}`)).status, 200);
  assert.equal(last(c.server.id, 'invite_revoke').actor_id, c.owner.id);
  // A loop of revokes (here of codes that don't exist) is refused.
  let status = 404; let n = 0;
  while (status !== 429 && n < 70) { status = (await as(c.reader, 'DELETE', `/invites/nope${n}`)).status; n++; }
  assert.equal(status, 429); assert.ok(n > 50);
});

test('Admin → Reports stops saying the server’s moderators have a report once the server is gone', async () => {
  const c = await community({ members: 2 });
  const [reporter, offender] = c.members;
  const msg = await send(offender, c.text.id);
  const id = (await reportMessage(reporter, msg)).json.id;
  const staffView = async () => (await as(srv.owner, 'GET', '/admin/reports?status=all')).json.find((y) => y.id === id);
  assert.equal((await staffView()).serverInbox.status, 'open');
  assert.equal((await as(c.owner, 'DELETE', `/servers/${c.server.id}`, { authKey: c.owner.authKey })).status, 200);
  assert.equal((await staffView()).serverInbox, null);
});

// Last: it restarts the server.
test('retention: a year, the newest 10,000 per server (never less than a week), and past 50,000 only moderation stays', async () => {
  const a = await community({ members: 0 });
  const b = await community({ members: 0 });
  // c: a kick, then a flood of invites past the 50,000 ceiling; e: past the 200,000 one.
  const c = await community({ members: 1 });
  await as(c.mod, 'DELETE', `/servers/${c.server.id}/members/${c.member.id}`);
  const e = await community({ members: 0 });
  const d = srv.db();
  const t = Date.now();
  const ins = d.prepare("INSERT INTO server_audit (server_id, seq, action, detail, created_at) VALUES (?, ?, 'member_kick', '{}', ?)");
  const fill = (sid, from, n, at) => { for (let i = 0; i < n; i++) ins.run(sid, from + i, at(i)); };
  const top = (sid) => d.prepare('SELECT COALESCE(MAX(seq), 0) n FROM server_audit WHERE server_id = ?').get(sid).n;
  d.transaction(() => {
    // a: 10,050 more entries; the first 60 of them 8 days old, the rest from today.
    const s0 = top(a.server.id) + 1;
    fill(a.server.id, s0, 60, () => t - 8 * 86400000);
    fill(a.server.id, s0 + 60, 9990, () => t - 1000);
    // b: 10,020 recent entries (all inside the week), and before them two over a year old.
    const s1 = top(b.server.id) + 1;
    fill(b.server.id, s1, 2, () => t - 400 * 86400000);
    fill(b.server.id, s1 + 2, 10020, () => t - 1000);
  })();
  // Rather than write 50,000 rows, the next entry's number jumps: everything before is then beyond the newest 50,000.
  d.prepare("INSERT INTO server_audit (server_id, seq, actor_id, action, target_id, detail, created_at) VALUES (?, ?, ?, 'invite_create', 'x', '{}', ?)")
    .run(c.server.id, top(c.server.id) + 50005, c.member.id, t - 1000);
  d.prepare("INSERT INTO server_audit (server_id, seq, action, detail, created_at) VALUES (?, ?, 'member_kick', '{}', ?)").run(e.server.id, top(e.server.id) + 200005, t - 1000);
  const kept = (h, sid) => h.prepare(`SELECT id, action FROM server_audit WHERE server_id = ? AND (action IN ('member_kick', 'member_ban', 'role_create', 'channel_overrides')
    OR (action = 'member_roles' AND actor_id IS NOT NULL AND actor_id != target_id)) ORDER BY id`).all(sid);
  const keptC = kept(d, c.server.id);
  assert.ok(keptC.some((x) => x.action === 'member_kick') && keptC.some((x) => x.action === 'member_roles'));
  const cheapC = d.prepare("SELECT COUNT(*) n FROM server_audit WHERE server_id = ? AND action = 'invite_create' AND seq < ?").get(c.server.id, top(c.server.id)).n;
  assert.ok(cheapC >= 1);
  // The database itself: a recent kick past 50,000 can't be deleted, a recent invite entry there can.
  const kick = keptC.find((x) => x.action === 'member_kick').id;
  assert.throws(() => d.prepare('DELETE FROM server_audit WHERE id = ?').run(kick), /append-only/);
  d.exec('SAVEPOINT probe');
  assert.equal(d.prepare("DELETE FROM server_audit WHERE server_id = ? AND action = 'invite_create' AND seq < ?").run(c.server.id, top(c.server.id)).changes, cheapC);
  d.exec('ROLLBACK TO probe'); d.exec('RELEASE probe');
  const countA = d.prepare('SELECT COUNT(*) n FROM server_audit WHERE server_id = ?').get(a.server.id).n;
  // What should go from a: beyond its newest 10,000 and older than a week (its first entries, from setting it up,
  // are recent, so they stay).
  const goneA = d.prepare('SELECT COUNT(*) n FROM server_audit WHERE server_id = ? AND seq <= ? AND created_at < ?').get(a.server.id, top(a.server.id) - 10000, t - 7 * 86400000).n;
  assert.equal(goneA, 50);
  const countB = d.prepare('SELECT COUNT(*) n FROM server_audit WHERE server_id = ?').get(b.server.id).n;
  // A recent entry is still refused by the database itself, even past 10,000.
  assert.throws(() => d.prepare('DELETE FROM server_audit WHERE server_id = ? AND seq = ?').run(b.server.id, top(b.server.id) - 10005), /append-only/);
  d.close();
  await srv.restart({ AUDIT_PRUNE_DELAY_MS: '200' });
  const n = (sid) => srv.sql('SELECT COUNT(*) n FROM server_audit WHERE server_id = ?', sid)[0].n;
  assert.ok(await until(() => n(a.server.id) < countA, 8000), 'pruned');
  // c: the cheap kinds past 50,000 went, recent though they were; the kick and the role changes stayed.
  const invitesC = () => srv.sql("SELECT COUNT(*) n FROM server_audit WHERE server_id = ? AND action = 'invite_create'", c.server.id)[0].n;
  assert.ok(await until(() => invitesC() === 1, 3000), 'only the newest invite entry is left');
  const d2 = srv.db();
  try { assert.deepEqual(kept(d2, c.server.id), keptC, 'moderation from the last week stays'); } finally { d2.close(); }
  // e: past 200,000 everything goes, moderation too (a limit on disk use whatever happens).
  assert.ok(await until(() => n(e.server.id) === 1, 3000));
  assert.ok(await until(() => n(b.server.id) < countB, 3000), 'pruned');
  assert.equal(n(a.server.id), countA - goneA, 'a keeps its newest 10,000 (and anything from the last week)');
  assert.equal(n(b.server.id), countB - 2, 'b only loses what’s over a year old: the rest is less than a week old');
  // The week-old entries left in a are all among its newest 10,000.
  const hi = srv.sql('SELECT MAX(seq) n FROM server_audit WHERE server_id = ?', a.server.id)[0].n;
  assert.equal(srv.sql('SELECT COUNT(*) n FROM server_audit WHERE server_id = ? AND created_at < ? AND seq <= ?', a.server.id, t - 7 * 86400000, hi - 10000)[0].n, 0);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM server_audit WHERE server_id = ? AND created_at < ?', a.server.id, t - 7 * 86400000)[0].n, 10, 'the 10 old ones still inside the newest 10,000 stay');
});

// The app's side (public/js/serveraudit.js), run in Node with its imports replaced by small fakes: what a change to a
// channel's disappearing timer says in the log.
test('the log says what a channel’s disappearing timer was set to, with its other settings', async () => {
  const path = require('node:path');
  const { register } = require('node:module');
  const fakes = {
    './util.js': 'export const h = (...a) => a; export const clear = (x) => x; export const icon = () => null; export const toast = () => {}; export const fmtStamp = String;',
    './api.js': 'export const api = async () => ({});',
    './ui.js': 'export const modal = () => ({}); export const field = () => null;',
    './perms.js': 'export const PERMS = {}; export const PERM_GROUPS = [];',
    './profile-ui.js': 'export const avatarEl = () => null;',
    './markdown.js': 'export const render = (x) => x;',
    './admin.js': 'export const CATEGORY_LABEL = {};',
  };
  const urls = Object.fromEntries(Object.entries(fakes).map(([k, src]) => [k, 'data:text/javascript,' + encodeURIComponent(src)]));
  register('data:text/javascript,' + encodeURIComponent(`const urls = ${JSON.stringify(urls)};
    export async function resolve(spec, ctx, next) {
      if (ctx.parentURL && ctx.parentURL.endsWith('/public/js/serveraudit.js') && urls[spec]) return { url: urls[spec], shortCircuit: true };
      return next(spec, ctx);
    }`));
  const { sentence } = await import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'serveraudit.js')).href);
  const said = (changes) => sentence({ action: 'channel_update', actorId: 'u1', targetId: 'c1', detail: { channel: { id: 'c1', name: 'general' }, changes } }, { u1: { displayName: 'Ann' } })[1];
  assert.equal(said({ disappear: { from: 0, to: 86400 } }), 'Set disappearing messages to 1 day.');
  assert.equal(said({ disappear: { from: 86400, to: 0 } }), 'Turned disappearing messages off.');
  assert.equal(said({ slowmode: { from: 0, to: 30 }, disappear: { from: 0, to: 3600 } }), 'Set slowmode to 30 seconds; set disappearing messages to 1 hour.');
});
