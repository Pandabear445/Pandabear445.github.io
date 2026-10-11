// The moderator toolkit: disconnect, move and server-mute in voice; ban with message cleanup; bulk delete.
// Each action is checked for what it does (live, in other people's apps too) and for what it refuses: people
// without the permission, outsiders, the owner, anyone at or above your highest role, bad input and floods.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, hex, sleep } = require('./helpers');

const P = { VIEW: 1, SEND: 2, MANAGE_MESSAGES: 32, CONNECT: 64, SPEAK: 128, KICK: 1 << 9, BAN: 1 << 10, MUTE: 1 << 17, MOVE: 1 << 18, ADMIN: 1 << 30 };
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');
let srv;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const ack = (s, ev, p, ms = 5000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.emit(ev, p, (x) => { clearTimeout(t); r(x); }); });
const next = (s, ev, ms = 3000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.once(ev, (x) => { clearTimeout(t); r(x); }); });
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await sleep(25); } return true; };
const audit = (action, target) => srv.sql('SELECT * FROM admin_log WHERE action = ? AND target = ?', action, target);

before(async () => { srv = await startServer(); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

// An owner, a moderator (a role with `modPerms`, above everyone else's) and members, in a fresh server with a
// second voice channel.
async function community({ modPerms = P.MUTE | P.MOVE, members = 2 } = {}) {
  const owner = await srv.register();
  const mod = await srv.register();
  const people = [];
  for (let i = 0; i < members; i++) people.push(await srv.register());
  const server = (await as(owner, 'POST', '/servers', { name: 'Mods ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const u of [mod, ...people]) assert.equal((await as(u, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const role = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Mod', permissions: modPerms })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${mod.id}/roles`, { roleIds: [role] })).status, 200);
  const voice2 = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'lounge', type: 'voice' })).json;
  srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', server.id);
  return { owner, mod, members: people, member: people[0], server, role, voice: server.channels.find((c) => c.type === 'voice'), voice2, text: server.channels.find((c) => c.type === 'text') };
}
const inCall = async (u, room) => ((await as(u, 'GET', '/bootstrap')).json.voice[room] || []);
const send = async (u, channelId, extra = {}) => {
  const r = await as(u, 'POST', `/channels/${channelId}/messages`, { ciphertext: cipher(), epoch: 1, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
};
const exists = (id) => srv.sql('SELECT 1 FROM messages WHERE id = ?', id).length === 1;
// A message written straight into the database, dated `ago` milliseconds back.
const oldMessage = (channelId, authorId, ago) => {
  const id = 'o' + hex(8);
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, channelId, authorId, '', cipher(), 1, Date.now() - ago);
  return id;
};
function multipart(bytes) {
  const boundary = '----hearth' + hex(8);
  const raw = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { raw, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const upload = async (u) => {
  const r = await srv.api('POST', '/upload/encrypted', { token: u.token, ip: u.ip, ...multipart(crypto.randomBytes(5000)) });
  assert.equal(r.status, 200, r.text);
  return r.json.url;
};

// ------------------------------------------------------------------ permissions
test('Mute Members and Move Members are new role bits; only Move Members works as a voice channel override', async () => {
  const { owner, server, voice, role } = await community();
  const r = await as(owner, 'PUT', `/channels/${voice.id}/overrides`, { overrides: [{ type: 'role', id: role, allow: P.MUTE | P.MOVE, deny: P.MUTE }] });
  assert.equal(r.status, 200, r.text);
  const ov = srv.sql('SELECT allow, deny FROM channel_overrides WHERE channel_id = ? AND target_id = ?', voice.id, role)[0];
  // A server mute holds in every voice channel, so Mute Members can't be given (or taken away) in just one.
  assert.deepEqual({ allow: ov.allow, deny: ov.deny }, { allow: P.MOVE, deny: 0 }, 'Move Members kept per channel, Mute Members dropped');
  const roles = (await as(owner, 'GET', '/bootstrap')).json.servers.find((s) => s.id === server.id).roleDefs;
  assert.equal(roles.find((x) => x.id === role).permissions, P.MUTE | P.MOVE);
});

// ------------------------------------------------------------------ disconnect
test('a moderator disconnects someone from voice: their app is told, the call updates, the audit log has it', async () => {
  const { mod, member, members: [, other], server, voice } = await community();
  const sm = await sock(member); const so = await sock(other);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).ok, true);
  assert.equal((await ack(so, 'voice:join', { channelId: voice.id })).ok, true);
  const kicked = next(sm, 'voice:kicked');
  const left = next(so, 'voice:peer-left');
  const r = await as(mod, 'POST', `/servers/${server.id}/voice/${member.id}/disconnect`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await kicked, { channelId: voice.id, by: 'moderator' });
  assert.equal((await left).userId, member.id, 'the others drop their connection to them');
  assert.deepEqual((await inCall(other, voice.id)).map((x) => x.userId), [other.id]);
  assert.equal(audit('voice_disconnect', member.id).length, 1);
  // The app's automatic rejoin (after a dropped connection) can't undo it; joining again on purpose can.
  assert.match((await ack(sm, 'voice:join', { channelId: voice.id, resume: true })).error, /moderator disconnected you/);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).ok, true);
});

test('disconnect is refused without Move Members, for the owner, for equal or higher roles, for yourself and outsiders', async () => {
  const { owner, mod, member, members: [, other], server, voice, role } = await community({ members: 3 });
  const outsider = await srv.register();
  const sockets = {};
  for (const u of [owner, mod, member, other]) { sockets[u.id] = await sock(u); assert.equal((await ack(sockets[u.id], 'voice:join', { channelId: voice.id })).ok, true); }
  const kick = (by, who) => as(by, 'POST', `/servers/${server.id}/voice/${who.id}/disconnect`);
  assert.equal((await kick(member, other)).status, 403, 'no permission');
  assert.match((await kick(member, other)).json.error, /Move Members/);
  assert.equal((await kick(mod, owner)).status, 403, 'not the owner');
  assert.equal((await kick(mod, mod)).status, 400, 'not yourself');
  assert.equal((await kick(outsider, member)).status, 404, 'not from outside the server');
  // Same highest role: refused. A higher role: refused.
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${other.id}/roles`, { roleIds: [role] })).status, 200);
  assert.equal((await kick(mod, other)).status, 403, 'not someone at your level');
  const high = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'High', permissions: 0 })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${other.id}/roles`, { roleIds: [high] })).status, 200);
  assert.match((await kick(mod, other)).json.error, /below yours/);
  // Someone who isn't in a call (or is in a DM call): nothing to disconnect.
  const third = (await srv.sql('SELECT user_id FROM members WHERE server_id = ? AND user_id NOT IN (?, ?, ?, ?)', server.id, owner.id, mod.id, member.id, other.id))[0].user_id;
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/voice/${third}/disconnect`)).status, 404);
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/voice/nobody/disconnect`)).status, 404);
  // Everyone who was refused is still in the call.
  assert.deepEqual((await inCall(owner, voice.id)).map((x) => x.userId).sort(), [owner.id, mod.id, member.id, other.id].sort());
  assert.equal(audit('voice_disconnect', other.id).length, 0);
});

test('Move Members given only in one voice channel works there and nowhere else', async () => {
  const { owner, member, members: [, other], server, voice, voice2 } = await community({ members: 2 });
  const helper = await srv.register();
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  assert.equal((await as(helper, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const r = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Lounge mod', permissions: 0 })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${helper.id}/roles`, { roleIds: [r] })).status, 200);
  assert.equal((await as(owner, 'PUT', `/channels/${voice2.id}/overrides`, { overrides: [{ type: 'role', id: r, allow: P.MOVE, deny: 0 }] })).status, 200);
  const sm = await sock(member); const so = await sock(other);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice2.id })).ok, true);
  assert.equal((await ack(so, 'voice:join', { channelId: voice.id })).ok, true);
  assert.equal((await as(helper, 'POST', `/servers/${server.id}/voice/${other.id}/disconnect`)).status, 403, 'not in the other channel');
  assert.equal((await as(helper, 'POST', `/servers/${server.id}/voice/${member.id}/disconnect`)).status, 200, 'in the lounge');
  assert.equal((await as(helper, 'POST', `/servers/${server.id}/voice/${member.id}/mute`)).status, 403, 'Move Members isn’t Mute Members');
});

// ------------------------------------------------------------------ move
test('a moderator moves someone to another voice channel; their app follows; bad targets are refused', async () => {
  const { owner, mod, member, members: [, other], server, voice, voice2, text, role } = await community();
  const sm = await sock(member); const so = await sock(other);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).ok, true);
  assert.equal((await ack(so, 'voice:join', { channelId: voice.id })).ok, true);
  const move = (who, channelId, by = mod) => as(by, 'POST', `/servers/${server.id}/voice/${who.id}/move`, { channelId });
  assert.equal((await move(member, text.id)).status, 400, 'not a text channel');
  assert.equal((await move(member, voice.id)).status, 400, 'not where they already are');
  assert.equal((await move(member, 'nope')).status, 404);
  assert.equal((await move(member, voice2.id, other)).status, 403, 'not without Move Members');
  // A channel they can't connect to.
  assert.equal((await as(owner, 'PUT', `/channels/${voice2.id}/overrides`, { overrides: [{ type: 'member', id: member.id, allow: 0, deny: P.CONNECT }] })).status, 200);
  assert.match((await move(member, voice2.id)).json.error, /can’t connect/);
  assert.equal((await as(owner, 'PUT', `/channels/${voice2.id}/overrides`, { overrides: [] })).status, 200);
  const moved = next(sm, 'voice:moved');
  const r = await move(member, voice2.id);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await moved, { channelId: voice.id, to: voice2.id, serverId: server.id });
  assert.deepEqual((await inCall(other, voice.id)).map((x) => x.userId), [other.id], 'out of the old channel straight away');
  assert.match((await ack(sm, 'voice:join', { channelId: voice.id, resume: true })).error, /moved you/, 'an automatic rejoin of the old one is refused');
  assert.equal((await ack(sm, 'voice:join', { channelId: voice2.id })).ok, true, 'the app joins the new one');
  assert.equal(audit('voice_move', member.id).length, 1);
  // Moving needs the permission in the destination too.
  assert.equal((await as(owner, 'PUT', `/channels/${voice.id}/overrides`, { overrides: [{ type: 'role', id: role, allow: 0, deny: P.MOVE }] })).status, 200);
  assert.equal((await move(member, voice.id)).status, 403);
});

test('someone moved while their connection was down is sent to the new channel when their app comes back', async () => {
  const { mod, member, server, voice, voice2 } = await community({ members: 1 });
  const sm = await sock(member);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).ok, true);
  sm.close(); // their connection drops; the server keeps their place for a while
  await sleep(300);
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/voice/${member.id}/move`, { channelId: voice2.id })).status, 200);
  const back = await sock(member);
  const res = await ack(back, 'voice:join', { channelId: voice.id, resume: true });
  assert.equal(res.movedTo, voice2.id);
  assert.equal((await ack(back, 'voice:join', { channelId: voice2.id })).ok, true);
});

// ------------------------------------------------------------------ server mute
test('server mute: their app locks the mic, everyone else is told to drop their audio, and it outlasts rejoining', async () => {
  const { mod, member, members: [, other], server, voice, voice2 } = await community();
  const sm = await sock(member); const so = await sock(other);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).ok, true);
  assert.equal((await ack(so, 'voice:join', { channelId: voice.id })).ok, true);
  const states = collect(so, 'voice:state');
  const silenced = collect(so, 'voice:silenced');
  const locked = next(sm, 'voice:perms');
  const r = await as(mod, 'POST', `/servers/${server.id}/voice/${member.id}/mute`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await locked, { channelId: voice.id, canSpeak: false, serverMuted: true });
  assert.ok(await until(() => states.some((st) => st.users.some((x) => x.userId === member.id && x.serverMuted && x.muted))), 'the others see them server-muted');
  assert.ok(await until(() => silenced.some((e) => e.channelId === voice.id && e.userIds.includes(member.id))), 'the others’ apps are told to drop their audio');
  assert.ok(states.every((st) => st.users.every((x) => x.canSpeak === undefined)), 'whether someone may speak isn’t in the public call list');
  // Their app can't unmute itself as far as the server's concerned.
  sm.emit('voice:update', { muted: false, deafened: false });
  await sleep(200);
  assert.equal((await inCall(other, voice.id)).find((x) => x.userId === member.id).muted, true);
  assert.equal(audit('voice_mute', member.id).length, 1);
  // Leaving and coming back (to another channel of the server) doesn't lift it.
  await ack(sm, 'voice:leave', {});
  const again = await ack(sm, 'voice:join', { channelId: voice2.id });
  assert.equal(again.ok, true);
  assert.equal(again.canSpeak, false);
  assert.equal(again.serverMuted, true);
  // A second mute changes nothing; unmuting gives their voice back.
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/voice/${member.id}/mute`)).status, 200);
  assert.equal(audit('voice_mute', member.id).length, 1, 'logged once');
  const freed = next(sm, 'voice:perms');
  assert.equal((await as(mod, 'DELETE', `/servers/${server.id}/voice/${member.id}/mute`)).status, 200);
  assert.deepEqual(await freed, { channelId: voice2.id, canSpeak: true, serverMuted: false });
  assert.equal(audit('voice_unmute', member.id).length, 1);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM voice_mutes WHERE server_id = ?', server.id)[0].n, 0);
});

test('server mute is refused without Mute Members, on the owner and on higher roles; works on someone not in a call', async () => {
  const { owner, mod, member, members: [, other], server, voice } = await community({ modPerms: P.MUTE });
  const mute = (by, who) => as(by, 'POST', `/servers/${server.id}/voice/${who.id}/mute`);
  assert.equal((await mute(member, other)).status, 403, 'no permission');
  assert.equal((await mute(mod, owner)).status, 403, 'not the owner');
  assert.equal((await mute(mod, mod)).status, 400, 'not yourself');
  // Not in a call: the server-wide permission counts, and the mute is waiting for them when they join.
  assert.equal((await mute(mod, member)).status, 200);
  const sm = await sock(member);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).serverMuted, true);
  // A moderator can't lift a mute on someone above them either.
  const high = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'High', permissions: 0 })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${other.id}/roles`, { roleIds: [high] })).status, 200);
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/voice/${other.id}/mute`)).status, 200, 'the owner outranks everyone');
  assert.equal((await as(mod, 'DELETE', `/servers/${server.id}/voice/${other.id}/mute`)).status, 403);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM voice_mutes WHERE server_id = ? AND user_id = ?', server.id, other.id)[0].n, 1);
});

test('voice moderation isn’t for group chats, and is rate limited', async () => {
  const { owner, mod, member, server } = await community({ members: 1 });
  const g = await as(owner, 'POST', '/groups', { userIds: [member.id] });
  assert.equal(g.status, 200, g.text);
  for (const action of ['disconnect', 'mute']) assert.equal((await as(owner, 'POST', `/servers/${g.json.id}/voice/${member.id}/${action}`)).status, 400);
  let last;
  for (let i = 0; i < 61; i++) last = await as(mod, 'POST', `/servers/${server.id}/voice/${member.id}/disconnect`);
  assert.equal(last.status, 429);
});

// ------------------------------------------------------------------ ban with cleanup
test('banning with cleanup deletes their recent messages everywhere in the server, with files and thread replies', async () => {
  const { owner, mod, member: spammer, members: [, bystander], server, text } = await community({ modPerms: P.BAN | P.MANAGE_MESSAGES });
  const text2 = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'second', type: 'text' })).json;
  const file = await upload(spammer);
  const withFile = await send(spammer, text.id, { files: [file] });
  const root = await send(spammer, text.id);
  const reply = await send(bystander, text.id, { threadId: root });
  const elsewhere = await send(spammer, text2.id);
  const theirReply = await send(spammer, text.id, { threadId: await send(bystander, text.id) });
  const old = oldMessage(text.id, spammer.id, 2 * 86400000);
  const kept = await send(bystander, text.id);
  assert.equal((await srv.call('GET', file)).status, 200);
  const watch = await sock(bystander);
  const bulk = collect(watch, 'message:delete-bulk');
  const r = await as(mod, 'POST', `/servers/${server.id}/bans`, { userId: spammer.id, reason: 'spam', deleteHours: 24 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deleted, 4);
  for (const id of [withFile, root, reply, elsewhere, theirReply]) assert.equal(exists(id), false, `${id} is gone`);
  assert.equal(exists(old), true, 'older than the window: kept');
  assert.equal(exists(kept), true, 'other people’s messages stay');
  assert.equal((await srv.call('GET', file)).status, 404, 'their files are deleted too');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM blobs WHERE message_id = ?', withFile)[0].n, 0);
  assert.ok(await until(() => bulk.length >= 2), 'open apps hear about it, one event per channel');
  const ids = bulk.flatMap((e) => e.messages);
  for (const id of [withFile, root, elsewhere, theirReply]) assert.ok(ids.some((m) => m.id === id));
  assert.ok(ids.find((m) => m.id === theirReply).threadId, 'a thread reply says which thread it left');
  assert.equal(audit('ban_messages_deleted', spammer.id).length, 1);
  assert.equal(srv.sql('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?', server.id, spammer.id).length, 1);
});

test('ban cleanup only takes 1, 24 or 168 hours, and the usual ban checks still apply', async () => {
  const { owner, mod, member, members: [, other], server, text, role } = await community({ modPerms: P.BAN });
  const mine = await send(member, text.id);
  for (const deleteHours of [5, -1, 'all', 1e9, 0.5]) {
    const r = await as(mod, 'POST', `/servers/${server.id}/bans`, { userId: member.id, deleteHours });
    assert.equal(r.status, 400, `deleteHours ${deleteHours}`);
  }
  assert.equal(srv.sql('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?', server.id, member.id).length, 0, 'a refused ban doesn’t happen');
  assert.equal(exists(mine), true);
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/bans`, { userId: owner.id, deleteHours: 168 })).status, 400);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${other.id}/roles`, { roleIds: [role] })).status, 200);
  const theirs = await send(other, text.id);
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/bans`, { userId: other.id, deleteHours: 168 })).status, 403, 'not someone at your level');
  assert.equal(exists(theirs), true);
  assert.equal((await as(member, 'POST', `/servers/${server.id}/bans`, { userId: other.id, deleteHours: 1 })).status, 403, 'not without Ban Members');
  // Without cleanup: banned, messages stay.
  const r = await as(mod, 'POST', `/servers/${server.id}/bans`, { userId: member.id });
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 0);
  assert.equal(exists(mine), true);
});

// ------------------------------------------------------------------ bulk delete
test('bulk delete by selection: one transaction, one event, one audit entry; thread replies go with their start', async () => {
  const { mod, member, members: [, other], text, server } = await community({ modPerms: P.MANAGE_MESSAGES });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await send(i % 2 ? member : other, text.id));
  const reply = await send(member, text.id, { threadId: ids[0] });
  const survivor = await send(member, text.id);
  const watch = await sock(other);
  const bulk = collect(watch, 'message:delete-bulk');
  const single = collect(watch, 'message:delete');
  const r = await as(mod, 'POST', `/channels/${text.id}/messages/bulk-delete`, { ids: [...ids, 'gone-already'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ deleted: r.json.deleted, replies: r.json.replies, kept: r.json.kept }, { deleted: 5, replies: 1, kept: 0 });
  for (const id of [...ids, reply]) assert.equal(exists(id), false);
  assert.equal(exists(survivor), true);
  assert.ok(await until(() => bulk.length === 1));
  await sleep(200);
  assert.equal(bulk.length, 1, 'a single batched event');
  assert.equal(single.length, 0);
  assert.deepEqual(bulk[0].messages.map((m) => m.id).sort(), [...ids].sort());
  assert.equal(bulk[0].channelId, text.id);
  const logged = audit('messages_bulk_deleted', text.id);
  assert.equal(logged.length, 1);
  assert.match(logged[0].detail, /5 messages \(and 1 thread reply\)/);
  assert.ok(logged[0].detail.includes(server.id));
});

test('bulk delete of the last N, within 14 days, keeping messages by people at or above you', async () => {
  const { owner, mod, member, text } = await community({ modPerms: P.MANAGE_MESSAGES });
  const old = oldMessage(text.id, member.id, 15 * 86400000);
  const bossMsg = await send(owner, text.id);
  const recent = [];
  for (let i = 0; i < 4; i++) recent.push(await send(member, text.id));
  const r = await as(mod, 'POST', `/channels/${text.id}/messages/bulk-delete`, { count: 10 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deleted, 4);
  assert.equal(r.json.kept, 1, 'the owner’s message');
  assert.equal(exists(bossMsg), true);
  assert.equal(exists(old), true, 'older than 14 days: not part of "the last N"');
  for (const id of recent) assert.equal(exists(id), false);
  // Picking an old one is refused outright.
  assert.match((await as(mod, 'POST', `/channels/${text.id}/messages/bulk-delete`, { ids: [old] })).json.error, /older than 14 days/);
  // The owner can clear anyone's.
  assert.equal((await as(owner, 'POST', `/channels/${text.id}/messages/bulk-delete`, { ids: [bossMsg] })).json.deleted, 1);
});

test('bulk delete refuses people without Manage Messages, outsiders, bad input and floods', async () => {
  const { owner, mod, member, text, voice, server } = await community({ modPerms: P.MANAGE_MESSAGES });
  const outsider = await srv.register();
  const target = await send(owner, text.id);
  const mine = await send(member, text.id);
  const bd = (u, body, ch = text.id) => as(u, 'POST', `/channels/${ch}/messages/bulk-delete`, body);
  assert.equal((await bd(member, { ids: [mine] })).status, 403, 'not even your own, without the permission');
  assert.equal((await bd(outsider, { ids: [target] })).status, 404);
  // A server's voice channel has a chat (v19), so bulk delete works there too (a group's call has none: see
  // voice-chat.test.js); this one is empty.
  const inVoice = await bd(mod, { count: 1 }, voice.id);
  assert.equal(inVoice.status, 200, inVoice.text);
  assert.equal(inVoice.json.deleted, 0);
  for (const body of [{}, { count: 0 }, { count: 101 }, { count: 2.5 }, { ids: [] }, { ids: 'x' }, { ids: [1, 2] }, { ids: ['a b'] },
    { ids: Array.from({ length: 101 }, (_, i) => 'm' + i) }, { ids: ['x'.repeat(65)] }]) {
    assert.equal((await bd(owner, body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  // A message from another channel can't be swept up through this one.
  const other = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'other', type: 'text' })).json;
  const there = await send(member, other.id);
  assert.equal((await bd(mod, { ids: [there] })).json.deleted, 0);
  assert.equal(exists(there), true);
  assert.equal(exists(target), true);
  let last;
  for (let i = 0; i < 11; i++) last = await bd(mod, { ids: ['nothing' + i] });
  assert.equal(last.status, 429);
});

// ------------------------------------------------------------------ review regressions
test('Mute Members is server-wide: a grant in one voice channel can’t mute, and a moderator can lift a mute anywhere', async () => {
  const { owner, mod, member, members: [, plain], server, voice, voice2 } = await community({ modPerms: P.MUTE });
  const helper = await srv.register();
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  assert.equal((await as(helper, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const lounge = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Lounge mod', permissions: 0 })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${helper.id}/roles`, { roleIds: [lounge] })).status, 200);
  assert.equal((await as(owner, 'PUT', `/channels/${voice2.id}/overrides`, { overrides: [{ type: 'role', id: lounge, allow: P.MUTE, deny: 0 }] })).status, 200);
  const sm = await sock(member);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice2.id })).ok, true);
  const r = await as(helper, 'POST', `/servers/${server.id}/voice/${member.id}/mute`);
  assert.equal(r.status, 403, 'a channel grant isn’t Mute Members');
  assert.match(r.json.error, /Mute Members/);
  // Someone with it server-wide mutes them in the lounge; they're muted in the other channel too, and the same
  // moderator can lift it from there, and with nobody in a call.
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/voice/${member.id}/mute`)).status, 200);
  await ack(sm, 'voice:leave', {});
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).serverMuted, true);
  assert.equal((await as(mod, 'DELETE', `/servers/${server.id}/voice/${member.id}/mute`)).status, 200);
  await ack(sm, 'voice:leave', {});
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/voice/${member.id}/mute`)).status, 200, 'not in a call');
  assert.equal((await as(mod, 'DELETE', `/servers/${server.id}/voice/${member.id}/mute`)).status, 200, 'not in a call');
  // Moderators get the list of server-muted members with the server (to see and lift a mute outside calls);
  // nobody else does.
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/voice/${member.id}/mute`)).status, 200);
  const view = async (u) => (await as(u, 'GET', '/bootstrap')).json.servers.find((x) => x.id === server.id);
  assert.deepEqual((await view(mod)).voiceMutes, [member.id]);
  assert.deepEqual((await view(owner)).voiceMutes, [member.id]);
  assert.equal((await view(plain)).voiceMutes, undefined);
  assert.equal((await view(helper)).voiceMutes, undefined);
});

test('a server mute never sticks to the owner: handing the server over lifts it, and an owner is never muted', async () => {
  const { owner, mod, member, server, voice } = await community();
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/voice/${member.id}/mute`)).status, 200);
  const r = await as(owner, 'POST', `/servers/${server.id}/transfer`, { userId: member.id, authKey: owner.authKey });
  assert.equal(r.status, 200, r.text);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM voice_mutes WHERE server_id = ? AND user_id = ?', server.id, member.id)[0].n, 0);
  const sm = await sock(member);
  const res = await ack(sm, 'voice:join', { channelId: voice.id });
  assert.equal(res.canSpeak, true);
  assert.equal(res.serverMuted, undefined);
  // Even a mute row left behind (an older copy of the data, say) doesn't silence the owner.
  srv.sql('INSERT INTO voice_mutes (server_id, user_id, by_id, created_at) VALUES (?, ?, ?, ?)', server.id, member.id, mod.id, Date.now());
  await ack(sm, 'voice:leave', {});
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).canSpeak, true);
  // The instance staff's transfer drops it too.
  const other = await community();
  assert.equal((await as(other.mod, 'POST', `/servers/${other.server.id}/voice/${other.member.id}/mute`)).status, 200);
  const t = await as(srv.owner, 'POST', `/admin/servers/${other.server.id}/transfer`, { username: other.member.username });
  assert.equal(t.status, 200, t.text);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM voice_mutes WHERE server_id = ?', other.server.id)[0].n, 0);
});

test('who may not speak is sent only to the people in the call, not to everyone who can see the channel', async () => {
  const { owner, mod, member, members: [, viewer, peer], server, voice } = await community({ modPerms: P.KICK, members: 3 });
  const sm = await sock(member); const sp = await sock(peer); const sv = await sock(viewer);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).ok, true);
  assert.equal((await ack(sp, 'voice:join', { channelId: voice.id })).ok, true);
  const seen = collect(sv, 'voice:state');
  const viewerSilenced = collect(sv, 'voice:silenced');
  const peerSilenced = collect(sp, 'voice:silenced');
  const t = await as(mod, 'POST', `/servers/${server.id}/members/${member.id}/timeout`, { minutes: 10 });
  assert.equal(t.status, 200, t.text);
  // The people in the call drop their audio...
  assert.ok(await until(() => peerSilenced.some((e) => e.userIds.includes(member.id))), 'call participants are told');
  // ...and so does an app joining the call later (in its answer).
  const late = await ack(await sock(owner), 'voice:join', { channelId: voice.id });
  assert.deepEqual(late.silenced, [member.id]);
  // Someone who only sees the channel can't tell a timeout from muting yourself.
  assert.ok(await until(() => seen.some((e) => e.users.some((x) => x.userId === member.id && x.muted))));
  await sleep(200);
  assert.equal((await as(viewer, 'GET', `/servers/${server.id}/timeouts`)).status, 403);
  assert.ok(seen.every((e) => e.users.every((x) => x.canSpeak === undefined && !x.serverMuted)));
  assert.equal(viewerSilenced.length, 0);
  const entry = (await inCall(viewer, voice.id)).find((x) => x.userId === member.id);
  assert.equal(entry.canSpeak, undefined);
  assert.equal(entry.muted, true);
});

test('ban cleanup leaves threads with replies the moderator couldn’t delete: higher roles, the owner, other channels', async () => {
  // A moderator with Ban Members only (no Manage Messages anywhere), and a senior member above them.
  const { owner, mod, members: [spammer, senior, bystander], server, text } = await community({ modPerms: P.BAN, members: 3 });
  const high = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Senior', permissions: 0 })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${senior.id}/roles`, { roleIds: [high] })).status, 200);
  const staff = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'staff', type: 'text' })).json;
  assert.equal((await as(owner, 'PUT', `/channels/${staff.id}/overrides`, { overrides: [
    { type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: high, allow: P.VIEW, deny: 0 }, { type: 'member', id: spammer.id, allow: P.VIEW, deny: 0 }] })).status, 200);
  const rootG = await send(spammer, text.id);
  const seniorReplyG = await send(senior, text.id, { threadId: rootG });
  const rootS = await send(spammer, staff.id);
  const seniorReplyS = await send(senior, staff.id, { threadId: rootS });
  const rootB = await send(spammer, text.id);
  const bystanderReply = await send(bystander, text.id, { threadId: rootB });
  const seniorRoot = await send(senior, text.id);
  const spamReply = await send(spammer, text.id, { threadId: seniorRoot });
  const plain = await send(spammer, staff.id);
  assert.equal((await as(mod, 'GET', `/channels/${staff.id}/messages`)).status, 404, 'the moderator can’t see #staff');
  assert.equal((await as(mod, 'DELETE', `/messages/${seniorReplyG}`)).status, 403, 'nor delete the senior’s reply directly');
  const r = await as(mod, 'POST', `/servers/${server.id}/bans`, { userId: spammer.id, deleteHours: 1 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ deleted: r.json.deleted, replies: r.json.replies, kept: r.json.kept }, { deleted: 2, replies: 0, kept: 3 });
  for (const id of [rootG, seniorReplyG, rootS, seniorReplyS, rootB, bystanderReply, seniorRoot]) assert.equal(exists(id), true, `${id} stays`);
  for (const id of [spamReply, plain]) assert.equal(exists(id), false, 'their own messages go');
  const logged = audit('ban_messages_deleted', spammer.id);
  assert.equal(logged.length, 1);
  assert.match(logged[0].detail, /2 messages, 3 threads kept/);

  // With Manage Messages too: a thread goes with replies by people below them, not with the owner's.
  const c2 = await community({ modPerms: P.BAN | P.MANAGE_MESSAGES, members: 2 });
  const [spam2, below] = c2.members;
  const withOwner = await send(spam2, c2.text.id);
  const ownerReply = await send(c2.owner, c2.text.id, { threadId: withOwner });
  const withBelow = await send(spam2, c2.text.id);
  const belowReply = await send(below, c2.text.id, { threadId: withBelow });
  const r2 = await as(c2.mod, 'POST', `/servers/${c2.server.id}/bans`, { userId: spam2.id, deleteHours: 24 });
  assert.deepEqual({ deleted: r2.json.deleted, replies: r2.json.replies, kept: r2.json.kept }, { deleted: 1, replies: 1, kept: 1 });
  assert.equal(exists(withOwner), true);
  assert.equal(exists(ownerReply), true, 'the owner’s reply stays');
  assert.equal(exists(withBelow), false);
  assert.equal(exists(belowReply), false);
  assert.match(audit('ban_messages_deleted', spam2.id)[0].detail, /1 message \(and 1 thread reply by others\), 1 thread kept/);
});

test('ban cleanup of thousands of messages keeps the server answering, and bots still get one event per message', async () => {
  const { owner, mod, member: spammer, server, text } = await community({ modPerms: P.BAN | P.MANAGE_MESSAGES, members: 1 });
  const text2 = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'flood', type: 'text' })).json;
  // A bot that listens for deletions in every channel (its webhook is never reached; deliveries just queue).
  const made = await as(srv.owner, 'POST', '/bots', { name: 'Watcher' + hex(2), description: 'listens', scopes: ['messages.read.metadata'], listed: true });
  assert.equal(made.status, 200, made.text);
  srv.sql('UPDATE bots SET webhook_url = ? WHERE id = ?', 'https://192.0.2.1/hook', made.json.bot.id);
  const inst = await as(owner, 'POST', `/servers/${server.id}/bots`, { botId: made.json.bot.id, scopes: ['messages.read.metadata'], channels: '*', confirm: true });
  assert.equal(inst.status, 200, inst.text);
  const N = 3000;
  const d = srv.db();
  try {
    const put = d.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const t0 = Date.now() - 50 * 60000;
    d.transaction(() => { for (let i = 0; i < N; i++) put.run(`f${String(i).padStart(6, '0')}${hex(3)}`, i % 2 ? text.id : text2.id, spammer.id, '', cipher(), 1, t0 + i * 100); })();
  } finally { d.close(); }
  const started = Date.now();
  const ban = as(mod, 'POST', `/servers/${server.id}/bans`, { userId: spammer.id, deleteHours: 1 });
  await sleep(30);
  const pinged = Date.now();
  const cfg = await srv.call('GET', '/api/config');
  const answeredIn = Date.now() - pinged;
  const r = await ban;
  assert.equal(cfg.status, 200);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deleted, N);
  assert.ok(answeredIn < 1500, `another request waited ${answeredIn} ms (the ban took ${Date.now() - started} ms)`);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM bot_deliveries WHERE type = 'message.deleted' AND server_id = ?", server.id)[0].n, N);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE author_id = ?', spammer.id)[0].n, 0);
});

test('a timed-out moderator can’t use the toolkit until the timeout ends', async () => {
  const { owner, mod, member, members: [, other], server, voice, voice2, text } = await community({ modPerms: P.MUTE | P.MOVE | P.MANAGE_MESSAGES | P.BAN });
  const sm = await sock(member);
  assert.equal((await ack(sm, 'voice:join', { channelId: voice.id })).ok, true);
  const mine = await send(member, text.id);
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/members/${mod.id}/timeout`, { minutes: 10 })).status, 200);
  for (const [method, p, body] of [['POST', `/servers/${server.id}/voice/${member.id}/mute`], ['POST', `/servers/${server.id}/voice/${member.id}/disconnect`],
    ['POST', `/servers/${server.id}/voice/${member.id}/move`, { channelId: voice2.id }], ['POST', `/channels/${text.id}/messages/bulk-delete`, { count: 100 }],
    ['POST', `/servers/${server.id}/bans`, { userId: member.id, deleteHours: 24 }]]) {
    const r = await as(mod, method, p, body);
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal(r.json.code, 'timed_out', p);
  }
  assert.equal(exists(mine), true);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM bans WHERE server_id = ?', server.id)[0].n, 0, 'the refused ban didn’t happen');
  assert.deepEqual((await inCall(owner, voice.id)).map((x) => x.userId), [member.id]);
  // A plain ban (no cleanup) still works, as it did before.
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/bans`, { userId: other.id })).status, 200);
});

// ------------------------------------------------------------------ the call engine (public/js/voice.js)
// On a fake WebRTC (as in voice-reliability.test.js): what the muted person's app and everyone else's do.
class FakePC {
  constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; this.signalingState = 'stable'; this.lanes = []; }
  addTransceiver() { const sender = { track: null, replaceTrack: async (t) => { sender.track = t; }, getParameters: () => ({}), setParameters: async () => {} }; const t = { direction: 'sendrecv', sender }; this.lanes.push(t); return t; }
  getTransceivers() { return this.lanes; }
  async createOffer() { return { type: 'offer', sdp: 'offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  setConfiguration() {}
  async getStats() { return new Map(); }
  close() { this.connectionState = 'closed'; }
}
class FakeTrack { constructor(kind) { this.kind = kind; this.readyState = 'live'; this.enabled = true; } stop() { this.readyState = 'ended'; } clone() { return new FakeTrack(this.kind); } getSettings() { return { deviceId: 'mic-1' }; } }
function fakeSocket(onEmit = () => undefined) {
  const handlers = {}; const sent = [];
  return {
    handlers, sent, id: 'me', connected: true,
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    emit(ev, payload, cb) { sent.push({ ev, payload }); const r = onEmit(ev, payload); if (cb) Promise.resolve(r).then((x) => setTimeout(() => cb(x || { ok: true }), 1)); },
    fire(ev, payload) { (handlers[ev] || []).forEach((fn) => fn(payload)); },
    connect() {},
  };
}
async function engine() {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.RTCPeerConnection = FakePC;
  globalThis.MediaStream = class { constructor(tracks = []) { this.tracks = tracks; } getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); } getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); } getTracks() { return this.tracks; } };
  const mediaDevices = { getUserMedia: async () => new globalThis.MediaStream([new FakeTrack('audio')]), enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices }, configurable: true, writable: true });
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'voice.js')).href);
}

test('engine: a server-muted peer’s audio is dropped here; our own server mute locks the mic; moves and disconnects are followed', async () => {
  const { Voice } = await engine();
  const notices = []; const moves = [];
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? { ok: true, peers: [{ socketId: 'B', userId: 'ub' }], canSpeak: true, silenced: ['uc'] } : undefined));
  const v = new Voice({ socket, getIceServers: () => [], signSdp: async () => 'sig', verifySdp: async () => true, myId: () => 'me', onNotice: (t) => notices.push(t), onMoved: (to) => moves.push(to) });
  await v.join('room');
  const b = v.peerByUser('ub');
  assert.ok(b, 'connected to the other person');
  b.audio = { muted: false, remove() {} }; b.screenAudio = { muted: false, remove() {} };
  assert.deepEqual([...v.silenced], ['uc'], 'the join answer says who is silenced in this call');
  // Everyone else's app: whatever arrives from a silenced person isn't played (their mic and their shared screen's sound).
  socket.fire('voice:silenced', { channelId: 'elsewhere', userIds: ['ub'] });
  assert.equal(b.audio.muted, false, 'another call’s list is ignored');
  socket.fire('voice:silenced', { channelId: 'room', userIds: ['ub'] });
  assert.deepEqual([b.audio.muted, b.screenAudio.muted], [true, true]);
  v.setDeafened(false);
  assert.equal(b.audio.muted, true, 'undeafening doesn’t bring them back');
  v.setSilenced([]);
  assert.deepEqual([b.audio.muted, b.screenAudio.muted], [false, false]);
  // Our own app, muted by a moderator: the mic goes off and can't be turned back on until it's lifted.
  v.setMuted(false);
  socket.fire('voice:perms', { channelId: 'room', canSpeak: false, serverMuted: true });
  assert.equal(v.muted, true);
  assert.equal(v.speakLocked, true);
  assert.equal(v.serverMuted, true);
  v.setMuted(false);
  assert.equal(v.muted, true, 'unmuting is refused');
  assert.equal(v.localStream.getAudioTracks()[0].enabled, false, 'nothing is sent');
  assert.match(notices.pop(), /moderator muted you/);
  socket.fire('voice:perms', { channelId: 'room', canSpeak: true, serverMuted: false });
  assert.equal(v.speakLocked, false);
  assert.match(notices.pop(), /unmuted you/);
  // Lifted, but their roles (or a timeout) still don't let them talk here: they're told so, and stay locked.
  socket.fire('voice:perms', { channelId: 'room', canSpeak: false, serverMuted: true });
  notices.pop();
  socket.fire('voice:perms', { channelId: 'room', canSpeak: false, serverMuted: false });
  assert.match(notices.pop(), /lifted your server mute, but your roles still don’t allow speaking/);
  assert.equal(v.speakLocked, true);
  v.setMuted(false);
  assert.equal(v.muted, true);
  socket.fire('voice:perms', { channelId: 'room', canSpeak: true });
  // Moved: out of this call, no leave sent (the server already did it), and the app is asked to join the new one.
  const sentBefore = socket.sent.length;
  socket.fire('voice:moved', { channelId: 'other-room', to: 'x' });
  assert.equal(v.channelId, 'room', 'a move for another call is ignored');
  socket.fire('voice:moved', { channelId: 'room', to: 'room2', serverId: 's' });
  assert.equal(v.channelId, null);
  assert.deepEqual(moves, ['room2']);
  assert.equal(socket.sent.slice(sentBefore).filter((x) => x.ev === 'voice:leave').length, 0);
  // Disconnected by a moderator: out, and told why.
  await v.join('room');
  socket.fire('voice:kicked', { channelId: 'room', by: 'moderator' });
  assert.equal(v.channelId, null);
  assert.match(notices.pop(), /moderator disconnected you/);
});
