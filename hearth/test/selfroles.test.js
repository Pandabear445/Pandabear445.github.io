// Self-assignable roles: moderators mark a role "Members can pick this role themselves", members add and drop it
// from "Pick your roles". Picking works exactly like a moderator giving the role (permissions, private channels
// and calls update live), and none of it can hand out moderator powers or put someone out of a moderator's reach.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, hex } = require('./helpers');

const P = { VIEW: 1, SEND: 2, MENTION_EVERYONE: 16, MANAGE_MESSAGES: 32, CONNECT: 64, SPEAK: 128, KICK: 1 << 9, BAN: 1 << 10, MANAGE_CHANNELS: 1 << 11, MANAGE_ROLES: 1 << 12, MUTE: 1 << 17, MOVE: 1 << 18, MANAGE_NICKNAMES: 1 << 21, ADMIN: 1 << 30 };
let srv;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const ack = (s, ev, p, ms = 5000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.emit(ev, p, (x) => { clearTimeout(t); r(x); }); });
// The next event of a kind that matches (null if none comes in time).
const next = (s, ev, match = () => true, ms = 3000) => new Promise((r) => {
  const on = (x) => { if (!match(x)) return; clearTimeout(t); s.off(ev, on); r(x); };
  const t = setTimeout(() => { s.off(ev, on); r(null); }, ms);
  s.on(ev, on);
});

before(async () => { srv = await startServer(); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

// A server with a moderator role (Kick + Manage Roles), a "game-night" role below it that opens the private
// #game-night text channel and "Game room" voice channel, and three members.
async function club() {
  const owner = await srv.register(); const mod = await srv.register(); const member = await srv.register(); const other = await srv.register();
  const server = (await as(owner, 'POST', '/servers', { name: 'Club ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const u of [mod, member, other]) assert.equal((await as(u, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const modRole = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Mod', permissions: P.KICK | P.MANAGE_ROLES | P.VIEW | P.SEND })).json;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${mod.id}/roles`, { roleIds: [modRole.id] })).status, 200);
  // The owner's new roles go on top, so this one starts above Mod (see the hierarchy test).
  const game = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'game-night', permissions: 0 })).json;
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [modRole.id, game.id] })).status, 200);
  const text = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'game-night', type: 'text' })).json;
  const voice = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'Game room', type: 'voice' })).json;
  for (const c of [text, voice]) {
    const r = await as(owner, 'PUT', `/channels/${c.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: game.id, allow: P.VIEW | P.CONNECT | P.SPEAK, deny: 0 }] });
    assert.equal(r.status, 200, r.text);
  }
  return { owner, mod, member, other, server, modRole, game, text, voice };
}
const view = async (u, sid) => (await as(u, 'GET', '/bootstrap')).json.servers.find((s) => s.id === sid);
const sees = async (u, sid, cid) => (await view(u, sid)).channels.some((c) => c.id === cid);
const rolesOf = (sid, uid) => srv.sql('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?', sid, uid).map((r) => r.role_id);
const mark = (u, role, on = true, extra = {}) => as(u, 'PATCH', `/roles/${role.id}`, { selfAssign: on, ...extra });
const pick = (u, sid, rid) => as(u, 'POST', `/servers/${sid}/me/roles/${rid}`);
const drop = (u, sid, rid) => as(u, 'DELETE', `/servers/${sid}/me/roles/${rid}`);

test('selfroles: a member picks a marked role, its private channel opens live, and dropping it closes it again', async () => {
  const { owner, member, server, game, text } = await club();
  assert.equal((await mark(owner, game)).status, 200);
  const def = (await view(member, server.id)).roleDefs.find((r) => r.id === game.id);
  assert.equal(def.selfAssign, true, 'members see which roles they can pick');
  assert.equal(def.selfAssignIssue, undefined);
  assert.equal(await sees(member, server.id, text.id), false);

  const sm = await sock(member);
  let update = next(sm, 'server:update', (s) => s.id === server.id);
  const r = await pick(member, server.id, game.id);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(rolesOf(server.id, member.id), [game.id]);
  const got = await update;
  assert.ok(got, 'open apps get the new view of the server');
  assert.ok(got.channels.some((c) => c.id === text.id), 'with the private channel in it');
  assert.ok(got.memberRoles[member.id].includes(game.id));
  assert.equal(await sees(member, server.id, text.id), true);
  // Picking it again changes nothing (and sends no update).
  update = next(sm, 'server:update', (s) => s.id === server.id, 600);
  assert.equal((await pick(member, server.id, game.id)).status, 200);
  assert.equal(await update, null);

  update = next(sm, 'server:update', (s) => s.id === server.id);
  assert.equal((await drop(member, server.id, game.id)).status, 200);
  const after = await update;
  assert.ok(after && !after.channels.some((c) => c.id === text.id), 'the channel disappears from open apps');
  assert.deepEqual(rolesOf(server.id, member.id), []);
  assert.equal(await sees(member, server.id, text.id), false);
});

test('selfroles: the server key is untouched (private channels share it, like when a moderator gives the role)', async () => {
  const { owner, member, server, game } = await club();
  await mark(owner, game);
  const before = srv.sql('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?', server.id)[0];
  assert.equal((await pick(member, server.id, game.id)).status, 200);
  assert.equal((await drop(member, server.id, game.id)).status, 200);
  assert.deepEqual(srv.sql('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?', server.id)[0], before);
});

test('selfroles: dropping the role takes you out of the private voice channel, like a moderator taking it away', async () => {
  const { owner, member, server, game, voice } = await club();
  await mark(owner, game);
  const sm = await sock(member);
  assert.ok((await ack(sm, 'voice:join', { channelId: voice.id })).error, 'can’t join before picking the role');
  assert.equal((await pick(member, server.id, game.id)).status, 200);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).ok, true);
  const kicked = next(sm, 'voice:kicked');
  assert.equal((await drop(member, server.id, game.id)).status, 200);
  assert.ok(await kicked, 'taken out of the call');
});

test('selfroles: roles with moderator powers or Mention @everyone can’t be marked, by themselves or in a channel', async () => {
  const { owner, server, text } = await club();
  for (const [name, bits] of [['kick', P.KICK], ['ban', P.BAN], ['admin', P.ADMIN], ['manage-roles', P.MANAGE_ROLES], ['manage-channels', P.MANAGE_CHANNELS], ['manage-messages', P.MANAGE_MESSAGES], ['everyone-pinger', P.MENTION_EVERYONE]]) {
    const role = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name, permissions: bits })).json;
    // Put it at the bottom so only its permissions count.
    const order = (await view(owner, server.id)).roleDefs.filter((r) => !r.everyone && r.id !== role.id).map((r) => r.id);
    await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [...order, role.id] });
    const r = await mark(owner, role);
    assert.equal(r.status, 400, `${name}: ${r.text}`);
    assert.equal(r.json.code, 'self_assign');
    assert.match(r.json.error, /moderator powers/);
    // Marking it while taking the power away in the same save works.
    assert.equal((await mark(owner, role, true, { permissions: 0 })).status, 200, name);
  }
  // Through a channel override.
  const helper = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'helper', permissions: 0 })).json;
  const order = (await view(owner, server.id)).roleDefs.filter((r) => !r.everyone && r.id !== helper.id).map((r) => r.id);
  await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [...order, helper.id] });
  await as(owner, 'PUT', `/channels/${text.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: helper.id, allow: P.VIEW | P.MANAGE_MESSAGES, deny: 0 }] });
  const r = await mark(owner, helper);
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /in a channel/);
});

test('selfroles: a marked role can’t be given moderator powers later, in the role editor or a channel', async () => {
  const { owner, server, game, text } = await club();
  assert.equal((await mark(owner, game)).status, 200);
  for (const bits of [P.KICK, P.MANAGE_MESSAGES, P.MENTION_EVERYONE, P.ADMIN]) {
    const r = await as(owner, 'PATCH', `/roles/${game.id}`, { permissions: bits });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, /Turn that off first/);
  }
  const r = await as(owner, 'PUT', `/channels/${text.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: game.id, allow: P.VIEW | P.MANAGE_MESSAGES, deny: 0 }] });
  assert.equal(r.status, 400, r.text);
  assert.equal(srv.sql("SELECT allow FROM channel_overrides WHERE channel_id = ? AND target_id = ?", text.id, game.id)[0].allow & P.MANAGE_MESSAGES, 0);
  // Ordinary edits still work, and so does turning it off and then adding the power.
  assert.equal((await as(owner, 'PATCH', `/roles/${game.id}`, { name: 'board-games', permissions: P.SEND })).status, 200);
  assert.equal((await as(owner, 'PATCH', `/roles/${game.id}`, { selfAssign: false, permissions: P.KICK })).status, 200);
});

test('selfroles: a member can’t self-assign a role with Kick or Manage bits, or any role that isn’t marked', async () => {
  const { member, server, modRole, game } = await club();
  // Mod (Kick + Manage Roles) isn't marked, and game-night isn't either yet.
  for (const role of [modRole, game]) {
    const r = await pick(member, server.id, role.id);
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'not_self_assign');
  }
  // Even if a powerful role got marked some other way (an old bug, a hand-edited database), picking re-checks.
  srv.sql('UPDATE roles SET self_assign = 1 WHERE id = ?', modRole.id);
  const r = await pick(member, server.id, modRole.id);
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /moderator powers/);
  assert.deepEqual(rolesOf(server.id, member.id), []);
  srv.sql('UPDATE roles SET self_assign = 0 WHERE id = ?', modRole.id);
  // Nor can a member take away a role a moderator gave them unless it's marked.
  assert.equal((await drop(member, server.id, modRole.id)).status, 403);
});

test('selfroles: a role above a moderator role can’t be marked or picked (nobody gets out of a moderator’s reach)', async () => {
  const { owner, mod, member, server, modRole, game } = await club();
  // Move game-night above Mod.
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [game.id, modRole.id] })).status, 200);
  let r = await mark(owner, game);
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /sits above "Mod"/);
  // Below it, it can be marked and picked; the moderator can still time the member out and kick them.
  await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [modRole.id, game.id] });
  assert.equal((await mark(owner, game)).status, 200);
  assert.equal((await pick(member, server.id, game.id)).status, 200);
  // Moved above Mod later: the role says why it can't be picked, picking is refused, dropping still works.
  await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [game.id, modRole.id] });
  const def = (await view(member, server.id)).roleDefs.find((x) => x.id === game.id);
  assert.match(def.selfAssignIssue, /sits above "Mod"/);
  assert.equal((await pick(srv.owner, server.id, game.id)).status, 404, 'non-members first get a 404');
  assert.equal((await drop(member, server.id, game.id)).status, 200);
  r = await pick(member, server.id, game.id);
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /Ask a moderator/);
  // Back below: the moderator's reach is intact after a pick.
  await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [modRole.id, game.id] });
  assert.equal((await pick(member, server.id, game.id)).status, 200);
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/members/${member.id}/timeout`, { minutes: 5 })).status, 200);
});

test('selfroles: only people who could give the role to anyone can mark it', async () => {
  const { owner, mod, member, server, modRole, game, text, voice } = await club();
  // No Manage Roles.
  assert.equal((await mark(member, game)).status, 403);
  // A role above the moderator's own.
  assert.equal((await mark(mod, modRole)).status, 403);
  // Manage Roles, but the role opens #game-night and the Game room, which the moderator can't see.
  let r = await mark(mod, game);
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /channel permissions you don’t have/);
  const open = (c, extra) => as(owner, 'PUT', `/channels/${c.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: game.id, allow: P.VIEW | P.CONNECT | P.SPEAK, deny: 0 }, ...extra] });
  await open(text, [{ type: 'role', id: modRole.id, allow: P.VIEW, deny: 0 }]);
  assert.equal((await mark(mod, game)).status, 403, 'still can’t see the voice channel');
  await open(voice, [{ type: 'role', id: modRole.id, allow: P.VIEW, deny: 0 }]);
  r = await mark(mod, game);
  assert.equal(r.status, 200, r.text);
  // A role with a permission the moderator doesn't have (here @everyone can't create invites, and Mod can't either).
  const everyone = (await view(owner, server.id)).roleDefs.find((x) => x.everyone);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone.permissions & ~(1 << 8) })).status, 200);
  const inviters = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'inviters', permissions: 1 << 8 })).json;
  await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [modRole.id, game.id, inviters.id] });
  r = await mark(mod, inviters);
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /permissions you don’t have/);
  assert.equal((await mark(owner, inviters)).status, 200, 'the owner can');
  // Turning it off only takes being able to edit the role.
  assert.equal((await mark(mod, inviters, false)).status, 200);
});

test('selfroles: non-members, banned and timed-out members, other servers’ roles and @everyone are refused', async () => {
  const { owner, mod, member, other, server, game } = await club();
  await mark(owner, game);
  const outsider = await srv.register();
  assert.equal((await pick(outsider, server.id, game.id)).status, 404, 'not a member');
  assert.equal((await srv.api('POST', `/servers/${server.id}/me/roles/${game.id}`, { ip: outsider.ip })).status, 401, 'not signed in');
  // A role of another server, through this server's route.
  const theirs = (await as(outsider, 'POST', '/servers', { name: 'Elsewhere ' + hex(2) })).json;
  const foreign = (await as(outsider, 'POST', `/servers/${theirs.id}/roles`, { name: 'x', permissions: 0 })).json;
  assert.equal((await mark(outsider, foreign)).status, 200);
  assert.equal((await pick(member, server.id, foreign.id)).status, 404, 'the role must belong to that server');
  assert.equal((await pick(member, server.id, server.id)).status, 404, '@everyone');
  assert.equal((await pick(member, server.id, encodeURIComponent('<b>x</b>'))).status, 404);
  assert.equal((await pick(member, server.id, 'z'.repeat(80))).status, 404);
  assert.equal((await mark(owner, { id: server.id })).status, 200, '@everyone ignores the flag');
  assert.equal((await view(owner, server.id)).roleDefs.find((r) => r.everyone).selfAssign, false);
  // Timed out: can't pick or drop.
  assert.equal((await pick(member, server.id, game.id)).status, 200);
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/members/${member.id}/timeout`, { minutes: 5 })).status, 200);
  let r = await drop(member, server.id, game.id);
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'timed_out');
  assert.equal((await pick(member, server.id, game.id)).status, 403);
  // Banned: not a member any more.
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/bans`, { userId: other.id })).status, 200);
  r = await pick(other, server.id, game.id);
  assert.equal(r.status, 404, r.text);
  assert.deepEqual(rolesOf(server.id, other.id), []);
});

test('selfroles: a role sold as a membership can’t be marked or picked', async () => {
  const { owner, member, server, game } = await club();
  srv.sql(`INSERT INTO membership_tiers (id, server_id, name, description, price_cents, currency, role_id, active, position, created_at)
    VALUES (?, ?, 'Supporters', '', 500, 'USD', ?, 1, 0, ?)`, 't' + hex(6), server.id, game.id, Date.now());
  const r = await mark(owner, game);
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /sold as the "Supporters" membership/);
  srv.sql('UPDATE roles SET self_assign = 1 WHERE id = ?', game.id);
  assert.equal((await pick(member, server.id, game.id)).status, 403);
});

test('selfroles: unmarking keeps the role for people who picked it, but they can no longer change it themselves', async () => {
  const { owner, member, server, game } = await club();
  await mark(owner, game);
  assert.equal((await pick(member, server.id, game.id)).status, 200);
  assert.equal((await mark(owner, game, false)).status, 200);
  assert.deepEqual(rolesOf(server.id, member.id), [game.id]);
  assert.equal((await drop(member, server.id, game.id)).status, 403);
});

test('selfroles: picking a role can’t undo a limit another of your roles puts on you', async () => {
  const { owner, member, other, server } = await club();
  const general = server.channels.find((c) => c.type === 'text');
  // "quiet" (given by the owner) can't post in #general; "chatty" (members pick it) may.
  const quiet = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'quiet', permissions: 0 })).json;
  const chatty = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'chatty', permissions: 0 })).json;
  const order = (await view(owner, server.id)).roleDefs.filter((r) => !r.everyone && ![quiet.id, chatty.id].includes(r.id)).map((r) => r.id);
  await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [...order, quiet.id, chatty.id] });
  assert.equal((await as(owner, 'PUT', `/channels/${general.id}/overrides`, { overrides: [{ type: 'role', id: quiet.id, allow: 0, deny: P.SEND }, { type: 'role', id: chatty.id, allow: P.SEND, deny: 0 }] })).status, 200);
  assert.equal((await mark(owner, chatty)).status, 200);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { roleIds: [quiet.id] })).status, 200);
  const r = await pick(member, server.id, chatty.id);
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'self_assign_limit');
  assert.match(r.json.error, /#general/);
  assert.deepEqual(rolesOf(server.id, member.id), [quiet.id]);
  // Without the limit, it's an ordinary pick.
  assert.equal((await pick(other, server.id, chatty.id)).status, 200);
});

test('selfroles: toggling is rate limited', async () => {
  const { owner, member, server, game } = await club();
  await mark(owner, game);
  let limited = null;
  for (let i = 0; i < 14 && !limited; i++) {
    const r = i % 2 ? await drop(member, server.id, game.id) : await pick(member, server.id, game.id);
    if (r.status === 429) limited = i;
    else assert.equal(r.status, 200, r.text);
  }
  assert.equal(limited, 10, 'ten changes in ten seconds, then 429');
});

// Review fixes.

test('selfroles: a moderator’s change touches only the role it names, so it can’t undo a member’s own picks', async () => {
  const { owner, mod, member, server, modRole, game } = await club();
  await mark(owner, game);
  const regular = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'regular', permissions: 0 })).json;
  await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [modRole.id, game.id, regular.id] });
  // The moderator's app drew the member menu while the member had no roles; the member then picks game-night.
  assert.equal((await pick(member, server.id, game.id)).status, 200);
  let r = await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { add: [regular.id] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(rolesOf(server.id, member.id).sort(), [game.id, regular.id].sort(), 'the pick survives');
  r = await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { remove: [regular.id] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(rolesOf(server.id, member.id), [game.id]);
  // And a role the member dropped isn't quietly given back.
  await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { add: [regular.id] });
  assert.equal((await drop(member, server.id, game.id)).status, 200);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { remove: [regular.id] })).status, 200);
  assert.deepEqual(rolesOf(server.id, member.id), []);
  // Validation, and the usual checks still apply to what's named.
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { add: [regular.id], remove: [regular.id] })).status, 400);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { add: regular.id })).status, 400, 'lists only');
  assert.deepEqual(rolesOf(server.id, member.id), [], 'a bad request changes nothing');
  r = await as(mod, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { add: [modRole.id] });
  assert.equal(r.status, 403, 'not a role above or at your own');
  // The whole list still works as before.
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { roleIds: [regular.id] })).status, 200);
  assert.deepEqual(rolesOf(server.id, member.id), [regular.id]);
});

test('selfroles: only roles whose powers go by role order keep marked roles below them, server-wide or in a channel', async () => {
  const { owner, member, server, modRole, game, text, voice } = await club();
  // Bottom of the list: a role that only manages emoji.
  const emoji = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Emoji artist', permissions: 1 << 14 })).json;
  await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [modRole.id, game.id, emoji.id] });
  let r = await mark(owner, game);
  assert.equal(r.status, 200, r.text);
  assert.equal((await pick(member, server.id, game.id)).status, 200);
  // It doesn't reach anyone (emoji don't look at role order), so being above it changes nothing.
  assert.equal((await view(member, server.id)).roleDefs.find((x) => x.id === game.id).selfAssignIssue, undefined);
  const toBottom = async (low) => {
    const ids = (await view(owner, server.id)).roleDefs.filter((x) => !x.everyone && x.id !== low.id).map((x) => x.id);
    await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [...ids, low.id] });
  };
  const issueOf = async () => (await view(member, server.id)).roleDefs.find((x) => x.id === game.id).selfAssignIssue || '';
  // Each power that does check role order keeps marked roles below it: kicks and timeouts, bans, role changes,
  // other people's nicknames, bulk delete and the report inbox (Manage Messages), and voice mute and move.
  for (const [name, bits] of [['kicker', P.KICK], ['banner', P.BAN], ['role-manager', P.MANAGE_ROLES], ['nickname-manager', P.MANAGE_NICKNAMES],
    ['message-manager', P.MANAGE_MESSAGES], ['voice-muter', P.MUTE], ['voice-mover', P.MOVE], ['admin', P.ADMIN]]) {
    const low = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name, permissions: bits })).json;
    await toBottom(low);
    assert.match(await issueOf(), new RegExp(`sits above "${name}"`), name);
    srv.sql('DELETE FROM roles WHERE id = ?', low.id);
    assert.equal(await issueOf(), '', `${name} gone`);
  }
  // Manage Messages and Move Members given in a single channel count as well: that's where they're checked.
  for (const [name, ch, bits] of [['helper', text, P.MANAGE_MESSAGES], ['usher', voice, P.MOVE]]) {
    const low = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name, permissions: 0 })).json;
    await toBottom(low);
    assert.equal(await issueOf(), '', `${name} has no powers yet`);
    const base = [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: game.id, allow: P.VIEW | P.CONNECT | P.SPEAK, deny: 0 }];
    r = await as(owner, 'PUT', `/channels/${ch.id}/overrides`, { overrides: [...base, { type: 'role', id: low.id, allow: P.VIEW | bits, deny: 0 }] });
    assert.equal(r.status, 200, r.text);
    assert.match(await issueOf(), new RegExp(`sits above "${name}"`), name);
    // Marking another role above it is refused, and so is picking.
    const other = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'other-' + name, permissions: 0 })).json;
    r = await mark(owner, other);
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, new RegExp(`sits above "${name}"`));
    assert.equal((await drop(member, server.id, game.id)).status, 200, 'dropping always works');
    r = await pick(member, server.id, game.id);
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, 'self_assign');
    assert.equal((await as(owner, 'PUT', `/channels/${ch.id}/overrides`, { overrides: base })).status, 200);
    srv.sql('DELETE FROM roles WHERE id IN (?, ?)', low.id, other.id);
    assert.equal((await pick(member, server.id, game.id)).status, 200, 'with the channel power gone, it can be picked again');
  }
});

test('selfroles: a pick is checked against what it really changes, and never names a channel you can’t see', async () => {
  const { owner, member, server } = await club();
  const secret = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'secret-merger-plans', type: 'text' })).json;
  const muted = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'muted', permissions: 0 })).json;
  const artists = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'artists', permissions: 0 })).json;
  const ids = (await view(owner, server.id)).roleDefs.filter((x) => !x.everyone && ![muted.id, artists.id].includes(x.id)).map((x) => x.id);
  await as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids: [...ids, muted.id, artists.id] });
  const set = (artistsAllow) => as(owner, 'PUT', `/channels/${secret.id}/overrides`, { overrides: [
    { type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: muted.id, allow: 0, deny: 8 }, { type: 'role', id: artists.id, allow: artistsAllow, deny: 0 }] });
  assert.equal((await set(8)).status, 200);
  assert.equal((await mark(owner, artists)).status, 200);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { add: [muted.id] })).status, 200);
  // Attach Files in a channel the member can't see either way: picking changes nothing they can use, so it's fine.
  let r = await pick(member, server.id, artists.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(await sees(member, server.id, secret.id), false);
  assert.equal((await drop(member, server.id, artists.id)).status, 200);
  // If the role also opens the channel, the pick would undo the limit there: refused, without the channel's name.
  assert.equal((await set(P.VIEW | 8)).status, 200);
  r = await pick(member, server.id, artists.id);
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'self_assign_limit');
  assert.doesNotMatch(r.json.error, /secret|merger/);
  assert.match(r.json.error, /a channel you can’t see/);
  assert.deepEqual(rolesOf(server.id, member.id), [muted.id], 'nothing was written');
});

test('selfroles: a burst of picks from many members sends each open app one update, not one per pick', async () => {
  const { owner, server, game } = await club();
  await mark(owner, game);
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  const pickers = [];
  for (let i = 0; i < 4; i++) { const u = await srv.register(); assert.equal((await as(u, 'POST', `/invites/${invite.code}/join`)).status, 200); pickers.push(u); }
  const watcher = await sock(owner);
  await new Promise((r) => setTimeout(r, 200));
  let count = 0; let last = null;
  const on = (s) => { if (s.id === server.id) { count++; last = s; } };
  watcher.on('server:update', on);
  const results = await Promise.all(pickers.flatMap((u) => [pick(u, server.id, game.id)]));
  results.forEach((r) => assert.equal(r.status, 200, r.text));
  const drops = await Promise.all(pickers.slice(0, 2).map((u) => drop(u, server.id, game.id)));
  drops.forEach((r) => assert.equal(r.status, 200, r.text));
  await new Promise((r) => setTimeout(r, 1500));
  watcher.off('server:update', on);
  assert.ok(count >= 1 && count <= 2, `${count} updates for 6 changes`);
  // The update that did go out has all of them.
  assert.deepEqual(pickers.filter((u) => (last.memberRoles[u.id] || []).includes(game.id)).map((u) => u.id), pickers.slice(2).map((u) => u.id));
});

test('selfroles: people who manage roles see which roles are sold as memberships', async () => {
  const { owner, mod, member, server, game } = await club();
  srv.sql(`INSERT INTO membership_tiers (id, server_id, name, description, price_cents, currency, role_id, active, position, created_at)
    VALUES (?, ?, 'Supporters', '', 500, 'USD', ?, 1, 0, ?)`, 't' + hex(6), server.id, game.id, Date.now());
  assert.deepEqual((await view(owner, server.id)).soldRoles, { [game.id]: 'Supporters' });
  assert.deepEqual((await view(mod, server.id)).soldRoles, { [game.id]: 'Supporters' });
  assert.equal((await view(member, server.id)).soldRoles, undefined);
});
