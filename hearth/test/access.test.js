// Who can reach what: other people's messages, servers you're not in, admin tools, and climbing permissions.
// "User 124 → User 123's data" must be refused, not quietly answered.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, hex } = require('./helpers');

let srv; let alice; let bob; let eve; let server; let textChannel; let dm; let aliceMsg; let aliceDmMsg;
const DENIED = [401, 403, 404];
const as = (u, method, path, body) => srv.api(method, path, { token: u.token, ip: u.ip, body });
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');

before(async () => {
  srv = await startServer();
  alice = await srv.register('alice'); bob = await srv.register('bob'); eve = await srv.register('eve');
  server = (await as(alice, 'POST', '/servers', { name: 'Alice HQ' })).json;
  textChannel = server.channels.find((c) => c.type === 'text');
  // Bob joins Alice's server with an invite; Eve stays outside.
  const { code } = (await as(alice, 'POST', `/servers/${server.id}/invites`, {})).json;
  assert.equal((await as(bob, 'POST', `/invites/${code}/join`)).status, 200);
  // A channel message from Alice (inserted directly: the server only ever stores ciphertext).
  aliceMsg = 'm' + hex(8);
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', aliceMsg, textChannel.id, alice.id, '', cipher(), 1, Date.now());
  // A DM between Alice and Bob.
  dm = (await as(alice, 'POST', '/dms', { userId: bob.id })).json;
  const sent = await as(alice, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() });
  assert.equal(sent.status, 200, sent.text);
  aliceDmMsg = sent.json.id;
});
after(async () => { await srv.stop(); });

test("an outsider can't read, post to, or look into a server they aren't in", async () => {
  for (const [m, p, b] of [
    ['GET', `/channels/${textChannel.id}/messages`], ['POST', `/channels/${textChannel.id}/messages`, { ciphertext: cipher(), epoch: 1 }],
    ['GET', `/channels/${textChannel.id}/pins`], ['GET', `/servers/${server.id}/keys`], ['PATCH', `/servers/${server.id}`, { description: 'pwned' }],
    ['POST', `/servers/${server.id}/invites`, {}], ['GET', `/servers/${server.id}/events`], ['GET', `/servers/${server.id}/feeds`], ['GET', `/servers/${server.id}/bans`],
    ['POST', `/servers/${server.id}/channels`, { name: 'x', type: 'text' }], ['POST', `/servers/${server.id}/keys/share`, { epoch: 1, wraps: {} }],
    ['GET', `/messages/${aliceMsg}/thread`], ['GET', `/messages/${aliceMsg}/locate`], ['POST', `/messages/${aliceMsg}/reactions`, { emoji: '👍' }],
    ['PATCH', `/messages/${aliceMsg}`, { ciphertext: cipher() }], ['DELETE', `/messages/${aliceMsg}`], ['POST', `/messages/${aliceMsg}/pin`],
    ['DELETE', `/servers/${server.id}`], ['POST', `/servers/${server.id}/transfer`, { userId: eve.id }],
  ]) {
    const r = await as(eve, m, p, b);
    assert.ok(DENIED.includes(r.status), `${m} ${p} → ${r.status}`);
  }
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', aliceMsg)[0].n, 1);
});

test("an outsider can't read or touch someone else's DMs", async () => {
  for (const [m, p, b] of [
    ['GET', `/dms/${dm.id}/messages`], ['POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() }], ['GET', `/dms/${dm.id}/pins`],
    ['PATCH', `/dm-messages/${aliceDmMsg}`, { ciphertext: cipher() }], ['DELETE', `/dm-messages/${aliceDmMsg}`],
  ]) {
    const r = await as(eve, m, p, b);
    assert.ok(DENIED.includes(r.status), `${m} ${p} → ${r.status}`);
  }
});

test("the other person in a DM can't edit or delete your messages", async () => {
  assert.ok(DENIED.includes((await as(bob, 'PATCH', `/dm-messages/${aliceDmMsg}`, { ciphertext: cipher() })).status));
  assert.ok(DENIED.includes((await as(bob, 'DELETE', `/dm-messages/${aliceDmMsg}`)).status));
  assert.equal((await as(bob, 'GET', `/dms/${dm.id}/messages`)).status, 200, 'but can read the conversation they are in');
});

test('a plain member can’t manage the server, other members, or other people’s messages', async () => {
  for (const [m, p, b] of [
    ['PATCH', `/servers/${server.id}`, { description: 'x' }], ['POST', `/servers/${server.id}/roles`, { name: 'boss', permissions: 1 << 30 }],
    ['PUT', `/servers/${server.id}/members/${bob.id}/roles`, { roleIds: [] }], ['DELETE', `/servers/${server.id}/members/${alice.id}`],
    ['POST', `/servers/${server.id}/bans`, { userId: alice.id }], ['DELETE', `/channels/${textChannel.id}`], ['PATCH', `/channels/${textChannel.id}`, { name: 'x' }],
    ['DELETE', `/servers/${server.id}`], ['POST', `/servers/${server.id}/transfer`, { userId: bob.id }], ['POST', `/servers/${server.id}/feeds`, { kind: 'topic', query: 'x', channelId: textChannel.id }],
    ['PATCH', `/messages/${aliceMsg}`, { ciphertext: cipher() }], ['DELETE', `/messages/${aliceMsg}`], ['POST', `/messages/${aliceMsg}/pin`],
    ['PUT', `/channels/${textChannel.id}/overrides`, { targetType: 'member', targetId: bob.id, allow: 1 << 30, deny: 0 }],
  ]) {
    const r = await as(bob, m, p, b);
    assert.ok(DENIED.includes(r.status), `${m} ${p} → ${r.status}`);
  }
});

test('permission escalation: Manage Roles can’t mint Administrator or touch higher roles', async () => {
  // Alice gives Bob a role that can manage roles (and nothing else).
  const mod = (await as(alice, 'POST', `/servers/${server.id}/roles`, { name: 'role-manager', permissions: 1 << 12 })).json;
  const modRoleId = mod.id || srv.sql("SELECT id FROM roles WHERE server_id = ? AND name = 'role-manager'", server.id)[0].id;
  assert.equal((await as(alice, 'PUT', `/servers/${server.id}/members/${bob.id}/roles`, { roleIds: [modRoleId] })).status, 200);
  // Bob tries to create an Administrator role → the bit is stripped.
  await as(bob, 'POST', `/servers/${server.id}/roles`, { name: 'sneaky', permissions: (1 << 30) | (1 << 13) | (1 << 12) });
  const sneaky = srv.sql("SELECT permissions FROM roles WHERE server_id = ? AND name = 'sneaky'", server.id)[0];
  assert.ok(sneaky, 'role created');
  assert.equal(sneaky.permissions & (1 << 30), 0, 'no Administrator');
  assert.equal(sneaky.permissions & (1 << 13), 0, 'no Manage Server');
  // Bob tries to upgrade his own role or @everyone → can't add what he doesn't have.
  await as(bob, 'PATCH', `/roles/${server.id}`, { permissions: 1 << 30 });
  assert.equal(srv.sql('SELECT permissions FROM roles WHERE id = ?', server.id)[0].permissions & (1 << 30), 0);
  const r = await as(bob, 'PATCH', `/roles/${modRoleId}`, { permissions: 1 << 30 });
  assert.ok(DENIED.includes(r.status) || (srv.sql('SELECT permissions FROM roles WHERE id = ?', modRoleId)[0].permissions & (1 << 30)) === 0);
  // …and can't change the owner's roles or delete Alice's server.
  assert.equal((await as(bob, 'PUT', `/servers/${server.id}/members/${alice.id}/roles`, { roleIds: [] })).status, 403);
  assert.ok(DENIED.includes((await as(bob, 'DELETE', `/servers/${server.id}`)).status));
});

test('profiles of other people never include private fields', async () => {
  srv.sql("UPDATE users SET email = 'alice@example.test', email_verified = 1 WHERE id = ?", alice.id);
  const r = await as(bob, 'GET', `/users/${alice.id}`);
  assert.equal(r.status, 200);
  const boot = await as(bob, 'GET', '/bootstrap');
  for (const blob of [r.text, JSON.stringify(boot.json.users[alice.id] || {})]) {
    for (const secret of ['alice@example.test', 'auth_hash', 'authHash', 'encPrivateKey', 'enc_private_key', 'totp', 'backup', 'recovery', 'last_ip', '"ip"', 'kdfSalt']) {
      assert.ok(!blob.includes(secret), `leaks ${secret}`);
    }
  }
});

test('every admin endpoint refuses normal users (403) and anonymous callers (401)', async () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'index.js'), 'utf8')
    + require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'accounts.js'), 'utf8')
    + require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'activity.js'), 'utf8')
    + require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'money.js'), 'utf8')
    + require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'memberships.js'), 'utf8')
    + require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'regions.js'), 'utf8');
  const routes = [...src.matchAll(/api\.(get|post|put|patch|delete)\('(\/admin\/[^']*)'/g)].map((m) => [m[1].toUpperCase(), m[2].replace(/:(\w+)/g, (x, k) => (k === 'id' ? alice.id : 'x'))]);
  assert.ok(routes.length > 40, `found ${routes.length} admin routes`);
  for (const [m, p] of routes) {
    const anon = await srv.api(m, p, { body: {}, ip: eve.ip });
    assert.equal(anon.status, 401, `anonymous ${m} ${p} → ${anon.status}`);
    const r = await as(eve, m, p, {});
    assert.equal(r.status, 403, `user ${m} ${p} → ${r.status} ${r.text.slice(0, 80)}`);
  }
});

test('staff ranks: a moderator can’t use admin tools or act on admins; admins can’t touch the owner', async () => {
  const mod = await srv.register(); const admin = await srv.register();
  await as(srv.owner, 'PUT', '/admin/staff', { userId: mod.id, role: 'moderator', authKey: srv.owner.authKey });
  await as(srv.owner, 'PUT', '/admin/staff', { userId: admin.id, role: 'admin', authKey: srv.owner.authKey });
  assert.equal((await as(mod, 'GET', '/admin/settings')).status, 403);
  assert.equal((await as(mod, 'PUT', '/admin/registration', { mode: 'open' })).status, 403);
  assert.equal((await as(mod, 'POST', `/admin/users/${admin.id}/suspend`, { reason: 'x' })).status, 403);
  assert.equal((await as(admin, 'POST', `/admin/users/${srv.owner.id}/suspend`, { reason: 'x' })).status, 403);
  assert.equal((await as(admin, 'POST', `/admin/users/${srv.owner.id}/logout`)).status, 403);
  assert.equal((await as(admin, 'PUT', '/admin/staff', { userId: mod.id, role: 'admin' })).status, 403, 'only the owner hands out roles');
  assert.equal((await as(admin, 'PUT', '/admin/staff', { userId: admin.id, role: 'admin' })).status, 403);
  assert.equal((await as(admin, 'POST', '/admin/owner', { userId: admin.id })).status, 403, 'can’t take ownership');
  assert.equal((await as(mod, 'POST', `/admin/users/${eve.id}/suspend`, { reason: 'spam', hours: 1 })).status, 200, 'but can act below their rank');
  await as(mod, 'POST', `/admin/users/${eve.id}/unsuspend`);
});

test('a deleted account is gone: can’t sign in, its sessions are dead, its name is free', async () => {
  const u = await srv.register();
  const other = (await srv.login(u)).json.token;
  assert.equal((await as(u, 'DELETE', '/me', { authKey: u.authKey, confirm: 'wrong' })).status, 400);
  assert.equal((await as(u, 'DELETE', '/me', { authKey: hex(32), confirm: u.username })).status, 401);
  assert.equal((await as(u, 'DELETE', '/me', { authKey: u.authKey, confirm: u.username })).status, 200);
  assert.equal((await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 401);
  assert.equal((await srv.api('GET', '/bootstrap', { token: other, ip: u.ip })).status, 401);
  assert.equal((await srv.login(u)).status, 401);
  const row = srv.sql('SELECT username, public_key, enc_private_key, email, totp_secret, deleted_at FROM users WHERE id = ?', u.id)[0];
  // The private key is erased; the PUBLIC key stays, so the people they talked to can still read old messages.
  assert.ok(row.deleted_at && row.enc_private_key === '' && !row.email && !row.totp_secret && row.username !== u.username);
  assert.equal(row.public_key, u.publicKey);
  await srv.register(u.username); // the name can be used again
  assert.equal((await as(srv.owner, 'DELETE', '/me', { authKey: srv.owner.authKey, confirm: 'owner' })).status, 400, 'the instance owner must hand over first');
  assert.equal((await as(alice, 'DELETE', '/me', { authKey: alice.authKey, confirm: 'alice' })).json.code, 'owns_servers');
});
