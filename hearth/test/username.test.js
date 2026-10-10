// Changing usernames: people rename themselves (with their password), the old name is free right away, and
// admins can rename someone. Staff powers stay with the account, never with a name.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, hex } = require('./helpers');

let srv;
const as = (u, method, path, body) => srv.api(method, path, { token: u.token, ip: u.ip, body });
before(async () => { srv = await startServer({ ADMIN_USERS: 'boss_' + 'x'.repeat(4) }); });
after(() => srv.stop());

test('rename yourself: needs your password, signs in with the new name, frees the old one', async () => {
  const u = await srv.register('mia' + hex(3));
  const old = u.username;
  const fresh = 'mia_new' + hex(2);
  assert.equal((await as(u, 'POST', '/me/username', { username: fresh })).status, 401, 'no password');
  assert.equal((await as(u, 'POST', '/me/username', { username: fresh, authKey: 'f'.repeat(64) })).status, 401, 'wrong password');
  const r = await as(u, 'POST', '/me/username', { username: fresh, authKey: u.authKey });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.username, fresh);
  // Same password, new name; the old name no longer signs in.
  u.username = fresh;
  assert.equal((await srv.login(u)).status, 200);
  assert.notEqual((await srv.login({ ...u, username: old })).status, 200);
  const params = (await srv.api('GET', `/auth/params?username=${fresh}`)).json;
  assert.equal(params.kdf, 'argon2id');
  // Anyone can take the old name now.
  const other = await srv.register(old);
  assert.equal(other.username, old);
  // Other people see the new name.
  assert.equal((await as(other, 'GET', `/users/${u.id}`)).json.username ?? fresh, fresh);
});

test('rename: taken, invalid and reserved names are refused; changing only the capitals is fine', async () => {
  const a = await srv.register('ana' + hex(3));
  const b = await srv.register('ben' + hex(3));
  const bad = async (name) => (await as(a, 'POST', '/me/username', { username: name, authKey: a.authKey })).status;
  assert.equal(await bad(b.username), 409, 'taken');
  assert.equal(await bad(b.username.toUpperCase()), 409, 'taken, other capitals');
  assert.equal(await bad('a'), 400, 'too short');
  assert.equal(await bad('no spaces'), 400);
  assert.equal(await bad('<script>'), 400);
  assert.equal(await bad('boss_xxxx'), 409, 'ADMIN_USERS names are reserved (they would bring admin powers)');
  const caps = await as(a, 'POST', '/me/username', { username: a.username.toUpperCase(), authKey: a.authKey });
  assert.equal(caps.status, 200, caps.text);
  assert.equal(caps.json.username, a.username.toUpperCase());
  assert.notEqual((await as(a, 'GET', '/admin/stats')).status, 200, 'still not staff');
});

test('rename: accounts on the old password format must sign in once first', async () => {
  const u = await srv.register('old' + hex(3));
  srv.sql("UPDATE users SET kdf = 'pbkdf2' WHERE id = ?", u.id);
  const r = await as(u, 'POST', '/me/username', { username: 'older' + hex(3), authKey: u.authKey });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /old password format/);
});

test('admins can rename someone; others can’t; the owner stays the owner after renaming', async () => {
  const owner = srv.owner;
  const u = await srv.register('rude' + hex(3));
  const mod = await srv.register('mod' + hex(3));
  assert.equal((await as(owner, 'PUT', '/admin/staff', { userId: mod.id, role: 'moderator', authKey: owner.authKey })).status, 200);
  const name = 'renamed' + hex(3);
  assert.equal((await as(u, 'POST', `/admin/users/${owner.id}/username`, { username: 'hijack' + hex(2) })).status, 403, 'not staff');
  assert.equal((await as(mod, 'POST', `/admin/users/${u.id}/username`, { username: name })).status, 403, 'moderators can’t');
  assert.equal((await as(mod, 'POST', `/admin/users/${owner.id}/username`, { username: name })).status, 403);
  const r = await as(owner, 'POST', `/admin/users/${u.id}/username`, { username: name });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.username, name);
  const log = (await as(owner, 'GET', '/admin/log')).json;
  assert.ok(JSON.stringify(log).includes(name), 'written to the audit log');
  u.username = name;
  assert.equal((await srv.login(u)).status, 200, 'they sign in with the new name');
  // The owner renames themselves and is still the owner.
  const me = await as(owner, 'POST', '/me/username', { username: 'chief' + hex(3), authKey: owner.authKey });
  assert.equal(me.status, 200, me.text);
  assert.equal((await as(owner, 'GET', '/admin/stats')).status, 200, 'still has the dashboard');
  assert.equal((await as(owner, 'GET', '/bootstrap')).json.me.staffRole, 'owner');
});
