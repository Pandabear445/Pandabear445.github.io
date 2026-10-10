// Who may change what inside a server: roles and overrides after people leave, private channels, group chats,
// blocks, pushes, events, invites and the irreversible owner actions. Each case checks that the attack is
// refused AND that the normal use next to it still works.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, enable2fa, hex, sleep } = require('./helpers');

const P = {
  VIEW: 1, SEND: 2, ADD_REACTIONS: 4, MENTION_EVERYONE: 1 << 4, MANAGE_MESSAGES: 1 << 5, CONNECT: 1 << 6,
  CREATE_INVITE: 1 << 8, MANAGE_CHANNELS: 1 << 11, MANAGE_ROLES: 1 << 12, MANAGE_SERVER: 1 << 13, ADMIN: 1 << 30,
};
const DENIED = [401, 403, 404];
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');
const b64u = (b) => Buffer.from(b).toString('base64url');

let srv; let boss; let server; let general; let code;
let certDir; let push; let pushPort; const pushes = {}; // user id -> number of pushes their endpoint received
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const user = async (name) => {
  const u = await srv.register(`${name}${hex(3)}`);
  const r = await as(u, 'POST', `/invites/${code}/join`);
  assert.equal(r.status, 200, r.text);
  return u;
};
const mkRole = async (name, permissions) => {
  const r = await as(boss, 'POST', `/servers/${server.id}/roles`, { name, permissions });
  assert.equal(r.status, 200, r.text);
  return srv.sql('SELECT id, position FROM roles WHERE id = ?', r.json.id)[0];
};
const give = async (u, roleIds, by = boss) => assert.equal((await as(by, 'PUT', `/servers/${server.id}/members/${u.id}/roles`, { roleIds })).status, 200);
const mkChannel = async (name, type = 'text') => {
  const r = await as(boss, 'POST', `/servers/${server.id}/channels`, { name, type });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const mkPrivate = async (name, extra = [], type = 'text') => {
  const c = await mkChannel(name, type);
  assert.equal((await as(boss, 'PUT', `/channels/${c.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }, ...extra] })).status, 200);
  return c;
};
const putMsg = (channelId, authorId) => {
  const id = 'm' + hex(8);
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, channelId, authorId, '', cipher(), 1, Date.now());
  return id;
};
const overridesOf = (channelId) => srv.sql('SELECT target_type AS type, target_id AS id, allow, deny FROM channel_overrides WHERE channel_id = ? ORDER BY target_type, target_id', channelId);
const myServer = async (u, sid = server.id) => (await as(u, 'GET', '/bootstrap')).json.servers.find((s) => s.id === sid);
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const emitAck = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
// Messages need the server's current key epoch; the server only compares the number (content is ciphertext).
const freshEpoch = (sid = server.id) => srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', sid);

before(async () => {
  // A local push service (https on 127.0.0.1, with a certificate the Hearth process is told to trust), so the
  // tests can see who gets a push without contacting anything outside this machine.
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-push-'));
  const pems = await require('selfsigned').generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  });
  fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);
  push = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    req.resume();
    req.on('end', () => { const uid = req.url.split('/').pop(); pushes[uid] = (pushes[uid] || 0) + 1; res.writeHead(201); res.end(); });
  });
  await new Promise((r) => push.listen(0, '127.0.0.1', r));
  pushPort = push.address().port;
  srv = await startServer({ NODE_EXTRA_CA_CERTS: path.join(certDir, 'cert.pem'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
  boss = srv.owner;
  server = (await as(boss, 'POST', '/servers', { name: 'HQ' })).json;
  general = server.channels.find((c) => c.type === 'text');
  code = (await as(boss, 'POST', `/servers/${server.id}/invites`, { expiresHours: 0 })).json.code;
});
after(async () => {
  socks.forEach((s) => s.close());
  await srv.stop();
  push.close();
  fs.rmSync(certDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ authz-1, data-11
test('authz-1: kick, ban and leave take away roles and member overrides; rejoining gives none of them back', async () => {
  const bob = await user('bob'); const keep = await user('keep');
  const admin = await mkRole('Admin', P.ADMIN);
  await give(bob, [admin.id]); await give(keep, [admin.id]);
  const vault = await mkPrivate('vault', [{ type: 'member', id: bob.id, allow: P.VIEW | P.SEND, deny: 0 }]);
  putMsg(vault.id, boss.id);
  assert.equal((await as(bob, 'GET', `/channels/${vault.id}/messages`)).status, 200, 'bob reads #vault while he is allowed');

  assert.equal((await as(boss, 'DELETE', `/servers/${server.id}/members/${bob.id}`)).status, 200, 'kick');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM member_roles WHERE server_id = ? AND user_id = ?', server.id, bob.id)[0].n, 0, 'roles gone');
  assert.equal(srv.sql("SELECT COUNT(*) n FROM channel_overrides WHERE target_type = 'member' AND target_id = ?", bob.id)[0].n, 0, 'member override gone');
  const ownerView = await myServer(boss);
  assert.equal(ownerView.memberRoles[bob.id], undefined, 'ex-members are not listed in memberRoles');
  assert.deepEqual(ownerView.memberRoles[keep.id], [admin.id], 'members who stay keep their roles');

  const back = await as(bob, 'POST', `/invites/${code}/join`);
  assert.equal(back.status, 200);
  assert.equal(back.json.myPerms & P.ADMIN, 0, 'no Administrator after rejoining');
  const tmp = await mkChannel('tmp-a1');
  assert.equal((await as(bob, 'DELETE', `/channels/${tmp.id}`)).status, 403);
  assert.equal((await as(bob, 'GET', `/channels/${vault.id}/messages`)).status, 404, 'the private channel is closed again');

  // Ban, unban, rejoin.
  await give(bob, [admin.id]);
  assert.equal((await as(boss, 'POST', `/servers/${server.id}/bans`, { userId: bob.id })).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM member_roles WHERE server_id = ? AND user_id = ?', server.id, bob.id)[0].n, 0);
  assert.equal((await as(boss, 'DELETE', `/servers/${server.id}/bans/${bob.id}`)).status, 200);
  const again = await as(bob, 'POST', `/invites/${code}/join`);
  assert.equal(again.status, 200);
  assert.equal(again.json.myPerms & P.ADMIN, 0, 'no Administrator after ban, unban and rejoin');

  // Leaving on your own clears them too.
  await give(bob, [admin.id]);
  assert.equal((await as(bob, 'POST', `/servers/${server.id}/leave`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM member_roles WHERE server_id = ? AND user_id = ?', server.id, bob.id)[0].n, 0);
  assert.equal((await as(bob, 'POST', `/invites/${code}/join`)).json.myPerms & P.ADMIN, 0);
  assert.ok((await myServer(keep)).myPerms & P.ADMIN, 'the admin who stayed is still an admin');
});

test('data-11: RSVPs go when someone leaves, is kicked or deletes their account, and ex-members are never listed', async () => {
  const grace = await user('grace'); const hank = await user('hank'); const gone = await user('gone');
  const ev = (await as(boss, 'POST', `/servers/${server.id}/events`, { title: 'game night', startsAt: Date.now() + 86400000 })).json;
  for (const u of [grace, hank, gone]) assert.equal((await as(u, 'POST', `/events/${ev.id}/rsvp`, { status: 'going' })).status, 200);
  assert.equal((await as(boss, 'DELETE', `/servers/${server.id}/members/${grace.id}`)).status, 200);
  assert.equal((await as(hank, 'POST', `/servers/${server.id}/leave`)).status, 200);
  assert.equal((await as(gone, 'DELETE', '/me', { authKey: gone.authKey, confirm: gone.username })).status, 200);
  for (const u of [grace, hank, gone]) assert.equal(srv.sql('SELECT COUNT(*) n FROM event_rsvps WHERE user_id = ?', u.id)[0].n, 0, `${u.username}'s RSVP is gone`);
  // A row left over from an older version doesn't show up either.
  srv.sql("INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, 'going')", ev.id, grace.id);
  const list = (await as(boss, 'GET', `/servers/${server.id}/events`)).json.find((e) => e.id === ev.id);
  assert.deepEqual(list.going, [boss.id]);
  srv.sql('DELETE FROM event_rsvps WHERE user_id = ?', grace.id);
});

// ------------------------------------------------------------------ authz-2
test("authz-2: Manage Roles can't rewrite overrides on a channel it can't see, or for roles above it", async () => {
  const staff = await mkPrivate('staff');
  putMsg(staff.id, boss.id);
  const before = overridesOf(staff.id);
  const carol = await user('carol');
  await give(carol, [(await mkRole('rolemgr', P.MANAGE_ROLES)).id]);
  const grab = await as(carol, 'PUT', `/channels/${staff.id}/overrides`, { overrides: [{ type: 'member', id: carol.id, allow: P.VIEW | P.SEND, deny: 0 }] });
  assert.equal(grab.status, 404, 'a channel you can’t see is “not found”');
  assert.deepEqual(overridesOf(staff.id), before, 'nothing changed');
  assert.equal((await as(carol, 'GET', `/channels/${staff.id}/messages`)).status, 404);

  // Hierarchy: Cosmetic < Junior < Senior (newer roles go on top).
  const cosmetic = await mkRole('Cosmetic', 0);
  const junior = await mkRole('Junior', P.MANAGE_ROLES);
  const senior = await mkRole('Senior', P.MANAGE_MESSAGES);
  const mallory = await user('mallory'); const sam = await user('sam');
  await give(mallory, [junior.id]); await give(sam, [senior.id]);
  const room = await mkChannel('lobby');
  const seniorOv = { type: 'role', id: senior.id, allow: P.MANAGE_MESSAGES, deny: 0 };
  assert.equal((await as(boss, 'PUT', `/channels/${room.id}/overrides`, { overrides: [seniorOv] })).status, 200);
  const lock = await as(mallory, 'PUT', `/channels/${room.id}/overrides`, { overrides: [seniorOv, { type: 'role', id: senior.id, allow: 0, deny: P.VIEW | P.SEND }] });
  assert.equal(lock.status, 403, 'can’t lock a higher role out');
  assert.equal((await as(mallory, 'PUT', `/channels/${room.id}/overrides`, { overrides: [] })).status, 403, 'can’t remove a higher role’s override');
  assert.equal((await as(mallory, 'PUT', `/channels/${room.id}/overrides`, { overrides: [{ type: 'member', id: sam.id, allow: 0, deny: P.VIEW }] })).status, 403, 'or target a higher member');
  assert.equal((await as(sam, 'GET', `/channels/${room.id}/messages`)).status, 200, 'Senior still reads the channel');

  // Normal use: overrides for lower roles and @everyone, leaving the higher role's override as it was.
  const ok = await as(mallory, 'PUT', `/channels/${room.id}/overrides`, { overrides: [seniorOv,
    { type: 'role', id: cosmetic.id, allow: P.MANAGE_MESSAGES, deny: P.SEND }, { type: 'role', id: server.id, allow: 0, deny: P.ADD_REACTIONS }] });
  assert.equal(ok.status, 200, ok.text);
  const now = overridesOf(room.id);
  assert.deepEqual(now.find((o) => o.id === senior.id), { type: 'role', id: senior.id, allow: P.MANAGE_MESSAGES, deny: 0 }, 'higher role untouched');
  assert.deepEqual(now.find((o) => o.id === cosmetic.id), { type: 'role', id: cosmetic.id, allow: 0, deny: P.SEND }, 'can’t grant Manage Messages she lacks');
  assert.ok(now.find((o) => o.id === server.id), '@everyone override saved');

  // A per-channel deny of Manage Roles is respected.
  const rules = await mkChannel('rules-ro');
  assert.equal((await as(boss, 'PUT', `/channels/${rules.id}/overrides`, { overrides: [{ type: 'member', id: mallory.id, allow: 0, deny: P.MANAGE_ROLES }] })).status, 200);
  assert.equal((await as(mallory, 'PUT', `/channels/${rules.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.SEND }] })).status, 403);
  assert.equal(overridesOf(rules.id).length, 1);
});

// ------------------------------------------------------------------ authz-3
test('authz-3: Manage Channels needs the channel: hidden channels are “not found” and per-channel denies count', async () => {
  const board = await mkPrivate('board');
  putMsg(board.id, boss.id);
  const dave = await user('dave');
  await give(dave, [(await mkRole('chanmgr', P.MANAGE_CHANNELS)).id]);
  assert.equal((await as(dave, 'PATCH', `/channels/${board.id}`, { name: 'renamed', topic: 'x' })).status, 404);
  assert.equal((await as(dave, 'DELETE', `/channels/${board.id}`)).status, 404);
  assert.deepEqual(srv.sql('SELECT name FROM channels WHERE id = ?', board.id), [{ name: 'board' }], 'channel and name unchanged');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE channel_id = ?', board.id)[0].n, 1);

  const rules = await mkChannel('rules');
  assert.equal((await as(boss, 'PUT', `/channels/${rules.id}/overrides`, { overrides: [{ type: 'member', id: dave.id, allow: 0, deny: P.MANAGE_CHANNELS }] })).status, 200);
  assert.equal((await as(dave, 'PATCH', `/channels/${rules.id}`, { topic: 'edited despite the deny' })).status, 403);
  assert.equal((await as(dave, 'DELETE', `/channels/${rules.id}`)).status, 403);

  // Normal use still works.
  assert.equal((await as(dave, 'PATCH', `/channels/${general.id}`, { topic: 'welcome' })).status, 200);
  const temp = await mkChannel('temp');
  assert.equal((await as(dave, 'DELETE', `/channels/${temp.id}`)).status, 200);
});

// ------------------------------------------------------------------ authz-4
test('authz-4: in a group chat only the owner can delete the chat, add channels or delete other people’s messages', async () => {
  const alice = await user('alice'); const frank = await user('frank'); const gina = await user('gina');
  const g = (await as(alice, 'POST', '/groups', { userIds: [frank.id, gina.id] })).json;
  const chat = g.channels.find((c) => c.type === 'text');
  const aliceMsg = putMsg(chat.id, alice.id); const ginaMsg = putMsg(chat.id, gina.id); const frankMsg = putMsg(chat.id, frank.id);
  assert.equal((await as(frank, 'DELETE', `/messages/${aliceMsg}`)).status, 403, 'not other people’s messages');
  assert.equal((await as(frank, 'POST', `/servers/${g.id}/channels`, { name: 'mine', type: 'text' })).status, 403);
  assert.equal((await as(frank, 'PATCH', `/channels/${chat.id}`, { name: 'x' })).status, 403);
  assert.equal((await as(frank, 'DELETE', `/channels/${chat.id}`)).status, 403);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE channel_id = ?', chat.id)[0].n, 3, 'history intact');
  assert.equal((await myServer(frank, g.id)).myPerms & P.MANAGE_CHANNELS, 0);

  // What members do in a group still works: talk, delete their own, pin, rename it, change its picture.
  freshEpoch(g.id);
  assert.equal((await as(frank, 'POST', `/channels/${chat.id}/messages`, { ciphertext: cipher(), epoch: 1 })).status, 200);
  assert.equal((await as(frank, 'DELETE', `/messages/${frankMsg}`)).status, 200);
  assert.equal((await as(frank, 'POST', `/messages/${aliceMsg}/pin`)).status, 200);
  assert.equal((await as(frank, 'PATCH', `/servers/${g.id}`, { name: 'Weekend' })).status, 200);
  const fd = new FormData();
  fd.append('icon', new Blob([crypto.randomBytes(64)], { type: 'image/png' }), 'pic.png');
  const icon = await fetch(`${srv.base}/api/servers/${g.id}/icon`, { method: 'POST', headers: { authorization: `Bearer ${frank.token}`, 'x-forwarded-for': frank.ip }, body: fd });
  assert.equal(icon.status, 200, await icon.text());
  // …and the owner still moderates.
  assert.equal((await as(alice, 'DELETE', `/messages/${ginaMsg}`)).status, 200);
});

// ------------------------------------------------------------------ authz-6
test('authz-6: "DMs from friends only" also keeps non-friends from pulling you into group chats', async () => {
  const alice = await user('alicep'); const mallory = await user('malloryp'); const sam = await user('samp'); const pal = await user('pal');
  assert.equal((await as(alice, 'PATCH', '/me/privacy', { dms: 'friends' })).status, 200);
  assert.equal((await as(mallory, 'POST', '/groups', { userIds: [alice.id] })).status, 403);
  const g = (await as(mallory, 'POST', '/groups', { userIds: [sam.id] })).json;
  assert.equal((await as(mallory, 'POST', `/groups/${g.id}/members`, { userId: alice.id })).status, 403);
  assert.equal((await as(mallory, 'POST', '/groups', { userIds: [sam.id, alice.id] })).status, 403, 'not even alongside someone else');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? AND s.kind = ?', alice.id, 'group')[0].n, 0);
  // Friends still can.
  assert.equal((await as(pal, 'POST', '/friends', { username: alice.username })).status, 200);
  assert.equal((await as(alice, 'POST', '/friends', { username: pal.username })).status, 200);
  assert.equal((await as(pal, 'POST', '/groups', { userIds: [alice.id] })).status, 200);
  // With DMs open to everyone, people you share a server with can add you as before.
  assert.equal((await as(alice, 'PATCH', '/me/privacy', { dms: 'everyone' })).status, 200);
  assert.equal((await as(mallory, 'POST', `/groups/${g.id}/members`, { userId: alice.id })).status, 200);
});

// ------------------------------------------------------------------ authz-7
test('authz-7: a block also stops DM edits, new reactions, pins and typing', async () => {
  const bob = await user('bobb'); const carol = await user('carolb');
  const dm = (await as(bob, 'POST', '/dms', { userId: carol.id })).json;
  const bobMsg = (await as(bob, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() })).json.id;
  const carolMsg = (await as(carol, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() })).json.id;
  assert.equal((await as(bob, 'POST', `/messages/${carolMsg}/reactions`, { emoji: '👍' })).status, 200);
  const cs = await sock(carol); const bs = await sock(bob);
  const typing = collect(cs, 'typing');
  assert.equal((await emitAck(bs, 'typing', { dmId: dm.id })).ok, true);
  await sleep(300);
  assert.equal(typing.length, 1, 'typing reaches the other person normally');

  assert.equal((await as(carol, 'POST', `/blocks/${bob.id}`)).status, 200);
  assert.equal((await as(bob, 'PATCH', `/dm-messages/${bobMsg}`, { ciphertext: cipher() })).status, 403, 'no rewriting old messages');
  assert.equal((await as(bob, 'POST', `/messages/${carolMsg}/reactions`, { emoji: '😡' })).status, 403, 'no new reactions');
  assert.equal((await as(bob, 'POST', `/messages/${carolMsg}/pin`)).status, 403, 'no pins');
  assert.equal((await as(carol, 'POST', `/messages/${bobMsg}/pin`)).status, 403, 'the conversation is frozen both ways');
  await emitAck(bs, 'typing', { dmId: dm.id });
  await sleep(300);
  assert.equal(typing.length, 1, 'no typing after the block');
  // Taking things back still works.
  assert.equal((await as(bob, 'POST', `/messages/${carolMsg}/reactions`, { emoji: '👍' })).status, 200, 'removing your own reaction');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM reactions WHERE message_id = ?', carolMsg)[0].n, 0);
  assert.equal((await as(bob, 'DELETE', `/dm-messages/${bobMsg}`)).status, 200, 'deleting your own message');
  await as(carol, 'DELETE', `/blocks/${bob.id}`);
  assert.equal((await as(bob, 'POST', `/messages/${carolMsg}/pin`)).status, 200, 'unblocked: back to normal');
  bs.close(); cs.close();
});

// ------------------------------------------------------------------ authz-8
test('authz-8: mention and reply pushes only reach people who can see the channel', async () => {
  const viewer = await user('viewer'); const outsider = await user('outside');
  for (const u of [viewer, outsider]) {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const r = await as(u, 'POST', '/push/subscribe', { subscription: { endpoint: `https://127.0.0.1:${pushPort}/p/${u.id}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } } });
    assert.equal(r.status, 200, r.text);
  }
  const mods = await mkPrivate('mod-actions', [{ type: 'member', id: viewer.id, allow: P.VIEW | P.SEND, deny: 0 }]);
  const count = (u) => pushes[u.id] || 0;
  const settle = async (want) => { for (let i = 0; i < 40 && Object.entries(want).some(([id, n]) => (pushes[id] || 0) < n); i++) await sleep(100); await sleep(400); };
  const outsiderOld = putMsg(mods.id, outsider.id); // from before they lost access
  const v0 = count(viewer); const o0 = count(outsider);
  freshEpoch();
  assert.equal((await as(boss, 'POST', `/channels/${mods.id}/messages`, { ciphertext: cipher(), epoch: 1, mentions: [viewer.id, outsider.id] })).status, 200);
  assert.equal((await as(boss, 'POST', `/channels/${mods.id}/messages`, { ciphertext: cipher(), epoch: 1, replyTo: outsiderOld })).status, 200);
  await settle({ [viewer.id]: v0 + 1 });
  assert.equal(count(viewer), v0 + 1, 'the member who can see #mod-actions is pushed');
  assert.equal(count(outsider), o0, 'the one who can’t see it gets nothing (no private channel name on their phone)');
  // In a channel they can see, they're pushed as usual.
  const theirs = putMsg(general.id, outsider.id);
  assert.equal((await as(boss, 'POST', `/channels/${general.id}/messages`, { ciphertext: cipher(), epoch: 1, mentions: [outsider.id] })).status, 200);
  assert.equal((await as(boss, 'POST', `/channels/${general.id}/messages`, { ciphertext: cipher(), epoch: 1, replyTo: theirs })).status, 200);
  await settle({ [outsider.id]: o0 + 2 });
  assert.equal(count(outsider), o0 + 2);
});

// ------------------------------------------------------------------ authz-9 (the app's own rule, run in Node)
test('authz-9: a hand-typed role mention only pings when the role is mentionable or the author may ping everyone', async () => {
  const { mayMentionRole, basePerms, PERMS } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'perms.js')).href);
  const s = {
    id: 'srv', ownerId: 'own', kind: 'server',
    roleDefs: [
      { id: 'srv', everyone: true, permissions: PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES },
      { id: 'staff', mentionable: false, permissions: 0 }, { id: 'fans', mentionable: true, permissions: 0 },
      { id: 'pinger', mentionable: false, permissions: PERMS.MENTION_EVERYONE },
    ],
    memberRoles: { plain: [], loud: ['pinger'] },
  };
  assert.equal(mayMentionRole(s, 'staff', 'plain'), false, 'not mentionable, no permission');
  assert.equal(mayMentionRole(s, 'fans', 'plain'), true, 'mentionable roles are for everyone');
  assert.equal(mayMentionRole(s, 'staff', 'loud'), true, 'Mention @everyone covers roles too');
  assert.equal(mayMentionRole(s, 'staff', 'own'), true, 'the owner can');
  assert.equal(mayMentionRole(s, 'srv', 'own'), false, '@everyone isn’t a role mention');
  assert.equal(mayMentionRole(s, 'nope', 'own'), false);
  // The app's copy of group permissions matches the server's.
  const g = { id: 'g', ownerId: 'own', kind: 'group' };
  assert.equal(basePerms(g, 'member') & PERMS.MANAGE_CHANNELS, 0);
  assert.ok(basePerms(g, 'member') & PERMS.SEND_MESSAGES);
  assert.ok(basePerms(g, 'own') & PERMS.ADMINISTRATOR);
});

// ------------------------------------------------------------------ authz-10
test('authz-10: events hide private channels from people who can’t see them, and muted members can’t post them', async () => {
  const hidden = await mkPrivate('hidden-ev');
  const frank = await user('franke');
  const ev = await as(boss, 'POST', `/servers/${server.id}/events`, { title: 'staff sync', startsAt: Date.now() + 86400000, channelId: hidden.id });
  assert.equal(ev.status, 200, ev.text);
  assert.equal(ev.json.channelId, hidden.id, 'the owner sees the channel it links to');
  const theirs = (await as(frank, 'GET', `/servers/${server.id}/events`)).json.find((e) => e.id === ev.json.id);
  assert.equal(theirs.channelId, null, 'a member who can’t see #hidden-ev doesn’t learn its id');
  assert.equal((await as(frank, 'GET', '/events')).json.find((e) => e.id === ev.json.id).channelId, null);
  const sneaky = await as(frank, 'POST', `/servers/${server.id}/events`, { title: 'mine', startsAt: Date.now() + 86400000, channelId: hidden.id });
  assert.equal(sneaky.status, 200);
  assert.equal(srv.sql('SELECT channel_id FROM server_events WHERE id = ?', sneaky.json.id)[0].channel_id, null, 'can’t link a channel you can’t see');
  const fine = await as(frank, 'POST', `/servers/${server.id}/events`, { title: 'hangout', startsAt: Date.now() + 86400000, channelId: general.id });
  assert.equal(fine.json.channelId, general.id, 'linking a channel you can see works');
  // An admin editing the owner's event keeps its channel even without seeing it.
  assert.equal(srv.sql('SELECT channel_id FROM server_events WHERE id = ?', ev.json.id)[0].channel_id, hidden.id);

  // Muted everywhere (no Send Messages): no events either.
  const everyone = srv.sql('SELECT permissions FROM roles WHERE id = ?', server.id)[0].permissions;
  assert.equal((await as(boss, 'PATCH', `/roles/${server.id}`, { permissions: everyone & ~P.SEND })).status, 200);
  try {
    assert.equal((await as(frank, 'POST', `/servers/${server.id}/events`, { title: 'SPAM', description: 'x'.repeat(2000), startsAt: Date.now() + 86400000 })).status, 403);
    assert.equal((await as(frank, 'PATCH', `/events/${fine.json.id}`, { title: 'SPAM' })).status, 403, 'nor rewrite their old ones');
    assert.equal((await as(boss, 'POST', `/servers/${server.id}/events`, { title: 'still fine', startsAt: Date.now() + 86400000 })).status, 200, 'admins still can');
  } finally {
    assert.equal((await as(boss, 'PATCH', `/roles/${server.id}`, { permissions: everyone })).status, 200);
  }
  assert.equal((await as(frank, 'PATCH', `/events/${fine.json.id}`, { title: 'hangout!' })).status, 200);
});

// ------------------------------------------------------------------ authz-11
test('authz-11: only someone who could join a call can decline it', async () => {
  const eve = await srv.register(`eve${hex(3)}`); // not in the server
  const member = await user('caller');
  const lounge = server.channels.find((c) => c.type === 'voice');
  const bs = await sock(boss);
  const declined = collect(bs, 'call:declined');
  assert.equal((await emitAck(bs, 'voice:join', { channelId: lounge.id })).ok, true);
  const es = await sock(eve);
  const r = await emitAck(es, 'call:decline', { room: lounge.id });
  assert.ok(r.error, 'refused');
  assert.ok((await emitAck(es, 'call:decline', { room: 'dm:nope' })).error);
  const ms = await sock(member);
  assert.equal((await emitAck(ms, 'call:decline', { room: lounge.id })).ok, true);
  await sleep(300);
  assert.deepEqual(declined.map((d) => d.userId), [member.id], 'only the member’s decline arrives');
  await emitAck(bs, 'voice:leave', {});
  bs.close(); es.close(); ms.close();
});

// ------------------------------------------------------------------ authz-12
test('authz-12: Manage Roles can’t hand out a role with permissions it doesn’t have, even a lower one', async () => {
  const lowAdmin = await mkRole('LowAdmin', P.ADMIN);
  const cosmetic = await mkRole('Cosmetic2', 0);
  const helper = await mkRole('Helper', P.MANAGE_MESSAGES);
  const mgr = await mkRole('Manager', P.MANAGE_ROLES | P.MANAGE_MESSAGES); // newest, so highest of these
  assert.ok(mgr.position > lowAdmin.position);
  const grace = await user('graceR'); const pat = await user('pat');
  await give(grace, [mgr.id]);
  const self = await as(grace, 'PUT', `/servers/${server.id}/members/${grace.id}/roles`, { roleIds: [mgr.id, lowAdmin.id] });
  assert.equal(self.status, 403);
  assert.equal((await myServer(grace)).myPerms & P.ADMIN, 0, 'still not an administrator');
  assert.equal((await as(grace, 'PUT', `/servers/${server.id}/members/${pat.id}/roles`, { roleIds: [lowAdmin.id] })).status, 403, 'not for others either');
  // Normal use: roles within your own permissions, below you.
  assert.equal((await as(grace, 'PUT', `/servers/${server.id}/members/${pat.id}/roles`, { roleIds: [cosmetic.id, helper.id] })).status, 200);
  assert.deepEqual((await myServer(boss)).memberRoles[pat.id].sort(), [cosmetic.id, helper.id].sort());
  // Taking a powerful lower role away is allowed (it can only reduce power); the owner can still give it.
  await give(pat, [cosmetic.id, lowAdmin.id]);
  assert.equal((await as(grace, 'PUT', `/servers/${server.id}/members/${pat.id}/roles`, { roleIds: [cosmetic.id] })).status, 200);
  assert.deepEqual((await myServer(boss)).memberRoles[pat.id], [cosmetic.id]);
});

// ------------------------------------------------------------------ authz-13
test('authz-13: invites can be listed and revoked by the right people, and a ban kills the banned person’s invites', async () => {
  const frank = await user('franki'); const mod = await user('modi'); const newbie = await srv.register(`new${hex(3)}`);
  await give(mod, [(await mkRole('Manage server', P.MANAGE_SERVER)).id]);
  const mine = (await as(frank, 'POST', `/servers/${server.id}/invites`, {})).json.code;
  const other = (await as(boss, 'POST', `/servers/${server.id}/invites`, { expiresHours: 24 })).json.code;
  const stale = (await as(boss, 'POST', `/servers/${server.id}/invites`, { expiresHours: 1 })).json.code;
  srv.sql('UPDATE invites SET expires_at = ? WHERE code = ?', Date.now() - 1000, stale);

  const all = (await as(mod, 'GET', `/servers/${server.id}/invites`)).json.map((i) => i.code);
  assert.ok(all.includes(mine) && all.includes(other), 'Manage Server sees every working invite');
  assert.ok(!all.includes(stale), 'expired ones aren’t listed');
  const own = await as(frank, 'GET', `/servers/${server.id}/invites`);
  assert.equal(own.status, 200);
  assert.deepEqual(own.json.map((i) => i.code), [mine], 'everyone else sees only their own');
  assert.equal(own.json[0].creatorId, frank.id);
  assert.ok(DENIED.includes((await as(newbie, 'GET', `/servers/${server.id}/invites`)).status), 'outsiders see nothing');

  assert.equal((await as(frank, 'DELETE', `/invites/${other}`)).status, 403, 'can’t revoke someone else’s');
  assert.equal((await as(newbie, 'DELETE', `/invites/${other}`)).status, 404, 'outsiders can’t either');
  assert.equal((await as(frank, 'DELETE', `/invites/${mine}`)).status, 200, 'your own: yes');
  assert.equal((await as(newbie, 'POST', `/invites/${mine}/join`)).status, 404, 'a revoked invite stops working');
  assert.equal((await as(mod, 'DELETE', `/invites/${other}`)).status, 200, 'Manage Server: anyone’s');
  assert.equal((await as(newbie, 'GET', `/invites/${other}`)).status, 404);

  const fromFrank = (await as(frank, 'POST', `/servers/${server.id}/invites`, {})).json.code;
  assert.equal((await as(boss, 'POST', `/servers/${server.id}/bans`, { userId: frank.id })).status, 200);
  assert.equal((await as(newbie, 'POST', `/invites/${fromFrank}/join`)).status, 404, 'a banned member’s invites die with the ban');
  assert.equal((await as(newbie, 'POST', `/invites/${code}/join`)).status, 200, 'other invites still work');
});

// ------------------------------------------------------------------ authz-14
test('authz-14: deleting or handing over a server needs the password (and two-factor when it’s on)', async () => {
  const owner = await srv.register(`own${hex(3)}`); const heir = await srv.register(`heir${hex(3)}`);
  const s1 = (await as(owner, 'POST', '/servers', { name: 'Big' })).json;
  const s2 = (await as(owner, 'POST', '/servers', { name: 'Other' })).json;
  const c1 = (await as(owner, 'POST', `/servers/${s1.id}/invites`, {})).json.code;
  assert.equal((await as(heir, 'POST', `/invites/${c1}/join`)).status, 200);

  for (const body of [undefined, { authKey: 'wrong'.repeat(10) }]) {
    assert.equal((await as(owner, 'POST', `/servers/${s1.id}/transfer`, { userId: heir.id, ...body })).status, 401);
    assert.equal((await as(owner, 'DELETE', `/servers/${s2.id}`, body)).status, 401);
  }
  assert.equal(srv.sql('SELECT owner_id FROM servers WHERE id = ?', s1.id)[0].owner_id, owner.id, 'still theirs');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM servers WHERE id = ?', s2.id)[0].n, 1, 'still there');
  assert.equal((await as(heir, 'DELETE', `/servers/${s1.id}`, { authKey: heir.authKey })).status, 403, 'a member’s own password doesn’t help');

  // Two-factor on, and this session hasn't used it lately: the password alone isn't enough.
  const tf = await enable2fa(srv, owner);
  srv.sql('UPDATE sessions SET mfa_at = NULL WHERE user_id = ?', owner.id);
  const half = await as(owner, 'POST', `/servers/${s1.id}/transfer`, { userId: heir.id, authKey: owner.authKey });
  assert.equal(half.status, 401); assert.equal(half.json.code, 'need_2fa');
  const t = await as(owner, 'POST', `/servers/${s1.id}/transfer`, { userId: heir.id, authKey: owner.authKey, backupCode: tf.backupCodes[0] });
  assert.equal(t.status, 200, t.text);
  assert.equal(srv.sql('SELECT owner_id FROM servers WHERE id = ?', s1.id)[0].owner_id, heir.id);
  assert.equal((await as(owner, 'DELETE', `/servers/${s2.id}`, { authKey: owner.authKey })).status, 200, 'two-factor was just used: the password is enough for a few minutes');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM servers WHERE id = ?', s2.id)[0].n, 0);
  const logged = srv.sql("SELECT action FROM admin_log WHERE target IN (?, ?) ORDER BY id", s1.id, s2.id).map((r) => r.action);
  assert.deepEqual(logged, ['server_transferred', 'server_deleted']);
});

// ------------------------------------------------------------------ upgrade cleanup (runs last: it restarts the server)
test('authz-1 upgrade: roles, member overrides and RSVPs left behind by older versions are cleared at start', async () => {
  socks.forEach((s) => s.close());
  const ghost = await srv.register(`ghost${hex(3)}`); // never a member
  const stays = await user('stays');
  const role = await mkRole('Old admin', P.ADMIN);
  await give(stays, [role.id]);
  const vault = await mkPrivate('vault-old', [{ type: 'member', id: stays.id, allow: P.VIEW, deny: 0 }]);
  const ev = (await as(boss, 'POST', `/servers/${server.id}/events`, { title: 'later', startsAt: Date.now() + 86400000 })).json;
  srv.sql('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)', server.id, ghost.id, role.id);
  srv.sql("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'member', ?, ?, 0)", vault.id, ghost.id, P.VIEW);
  srv.sql("INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, 'going')", ev.id, ghost.id);
  await srv.restart();
  assert.equal(srv.sql('SELECT COUNT(*) n FROM member_roles WHERE user_id = ?', ghost.id)[0].n, 0);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM channel_overrides WHERE target_id = ?", ghost.id)[0].n, 0);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM event_rsvps WHERE user_id = ?', ghost.id)[0].n, 0);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM member_roles WHERE user_id = ? AND role_id = ?', stays.id, role.id)[0].n, 1, 'members keep theirs');
  assert.equal(srv.sql("SELECT COUNT(*) n FROM channel_overrides WHERE target_id = ?", stays.id)[0].n, 1);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM event_rsvps WHERE user_id = ?', boss.id)[0].n > 0, true);
  // And someone joining later doesn't inherit anything.
  assert.equal((await as(ghost, 'POST', `/invites/${code}/join`)).json.myPerms & P.ADMIN, 0);
});
