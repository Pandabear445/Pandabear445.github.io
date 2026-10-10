// Sessions: what a sign-in token can do, how it ends, and that a stolen database can't be used to sign in.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, hex, sleep } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

const me = (u, token = u.token) => srv.api('GET', '/me/sessions', { token, ip: u.ip });
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };

test('no token, a junk token, or a truncated token: 401', async () => {
  const u = await srv.register();
  for (const token of [undefined, 'abc', hex(32).slice(0, 63), u.token.slice(0, -1) + (u.token.endsWith('0') ? '1' : '0'), u.token.toUpperCase(), `${u.token}x`, `x${u.token}`]) {
    assert.equal((await srv.api('GET', '/bootstrap', { token, ip: u.ip })).status, 401, String(token));
  }
  assert.equal((await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 200);
});

test('stolen database: session rows hold only hashes, and a hash is not a token', async () => {
  const u = await srv.register();
  const rows = srv.sql('SELECT * FROM sessions WHERE user_id = ?', u.id);
  assert.ok(rows.length >= 1);
  const all = JSON.stringify(rows);
  assert.ok(!all.includes(u.token), 'the raw token must never be stored');
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(u.token).digest('hex'));
  for (const r of rows) {
    assert.equal((await srv.api('GET', '/bootstrap', { token: r.token_hash, ip: u.ip })).status, 401);
    assert.equal((await srv.api('GET', '/bootstrap', { token: r.id, ip: u.ip })).status, 401);
  }
  // and nothing else in the users table is a usable credential either
  const user = srv.sql('SELECT * FROM users WHERE id = ?', u.id)[0];
  for (const v of Object.values(user)) if (typeof v === 'string' && v.length >= 20 && /^[\x20-\x7e]+$/.test(v)) assert.equal((await srv.api('GET', '/bootstrap', { token: v, ip: u.ip })).status, 401);
});

test('logout revokes the session (and closes its live connection)', async () => {
  const u = await srv.register();
  const sock = await srv.socket(u.token);
  let revoked = null;
  sock.on('session:revoked', (p) => { revoked = p; });
  assert.equal((await srv.api('POST', '/auth/logout', { token: u.token, ip: u.ip })).status, 200);
  assert.equal((await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 401);
  assert.ok(await waitFor(() => sock.disconnected), 'socket closed');
  assert.equal(revoked && revoked.reason, 'logged_out');
  await assert.rejects(srv.socket(u.token), /unauthorized/);
});

test('password change signs out every other session, live connections included; the current one stays', async () => {
  const u = await srv.register();
  const other = (await srv.login(u)).json.token;
  const sock = await srv.socket(other);
  const r = await srv.api('POST', '/me/password', { token: u.token, ip: u.ip, body: { oldAuthKey: u.authKey, newAuthKey: hex(32), encPrivateKey: 'Z'.repeat(60), salt: 'S'.repeat(24) } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await srv.api('GET', '/bootstrap', { token: other, ip: u.ip })).status, 401);
  assert.equal((await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 200);
  assert.ok(await waitFor(() => sock.disconnected));
  const row = srv.sql('SELECT revoke_reason FROM sessions WHERE token_hash = ?', crypto.createHash('sha256').update(other).digest('hex'))[0];
  assert.equal(row.revoke_reason, 'password_changed');
});

test('the "keep other sessions" flag is ignored for a real password change', async () => {
  const u = await srv.register();
  const other = (await srv.login(u)).json.token;
  await srv.api('POST', '/me/password', { token: u.token, ip: u.ip, body: { oldAuthKey: u.authKey, newAuthKey: hex(32), encPrivateKey: 'Z'.repeat(60), salt: 'S'.repeat(24), keepSessions: true } });
  assert.equal((await srv.api('GET', '/bootstrap', { token: other, ip: u.ip })).status, 401);
});

test('password change with the wrong current password is refused', async () => {
  const u = await srv.register();
  const r = await srv.api('POST', '/me/password', { token: u.token, ip: u.ip, body: { oldAuthKey: hex(32), newAuthKey: hex(32), encPrivateKey: 'Z'.repeat(60), salt: 'S'.repeat(24) } });
  assert.equal(r.status, 401);
  assert.equal((await srv.login(u)).status, 200, 'old password still works');
});

test('an expired session stops working (absolute expiry and idle timeout)', async () => {
  const u = await srv.register();
  const t2 = (await srv.login(u)).json.token;
  srv.sql('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', Date.now() - 1000, crypto.createHash('sha256').update(u.token).digest('hex'));
  assert.equal((await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 401);
  srv.sql('UPDATE sessions SET last_used_at = ?, created_at = ? WHERE token_hash = ?', Date.now() - 61 * 86400000, Date.now() - 61 * 86400000, crypto.createHash('sha256').update(t2).digest('hex'));
  assert.equal((await srv.api('GET', '/bootstrap', { token: t2, ip: u.ip })).status, 401);
  await assert.rejects(srv.socket(t2), /unauthorized/);
});

test('Settings → Sessions lists devices; one can be revoked; others can all be signed out', async () => {
  const u = await srv.register();
  const t2 = (await srv.api('POST', '/auth/login', { body: { username: u.username, authKey: u.authKey }, ip: u.ip, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' } })).json.token;
  const t3 = (await srv.login(u)).json.token;
  const list = (await me(u)).json;
  assert.equal(list.active.length, 3);
  const cur = list.active.find((x) => x.current);
  assert.ok(cur && cur.ip && cur.createdAt && cur.lastUsed && cur.expiresAt);
  assert.ok(list.active.some((x) => /Windows/.test(x.ua)));
  assert.ok(list.active.every((x) => !('token_hash' in x) && !('token' in x)), 'never sends token hashes');
  // revoke one
  const s2 = srv.sql('SELECT id FROM sessions WHERE token_hash = ?', crypto.createHash('sha256').update(t2).digest('hex'))[0].id;
  assert.equal((await srv.api('DELETE', `/me/sessions/${s2}`, { token: u.token, ip: u.ip })).status, 200);
  assert.equal((await srv.api('GET', '/bootstrap', { token: t2, ip: u.ip })).status, 401);
  assert.equal((await srv.api('DELETE', `/me/sessions/${cur.id}`, { token: u.token, ip: u.ip })).status, 400, 'use Log out for this one');
  // log out all others
  const sock = await srv.socket(t3);
  const r = await srv.api('POST', '/me/sessions/revoke-others', { token: u.token, ip: u.ip });
  assert.equal(r.json.count, 1);
  assert.equal((await srv.api('GET', '/bootstrap', { token: t3, ip: u.ip })).status, 401);
  assert.ok(await waitFor(() => sock.disconnected));
  assert.equal((await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 200);
  const after2 = (await me(u)).json;
  assert.equal(after2.active.length, 1);
  assert.ok(after2.ended.length >= 2, 'recently signed out devices are shown');
});

test("someone else's session can't be seen or revoked", async () => {
  const a = await srv.register(); const b = await srv.register();
  const bSession = srv.sql('SELECT id FROM sessions WHERE user_id = ?', b.id)[0].id;
  assert.equal((await srv.api('DELETE', `/me/sessions/${bSession}`, { token: a.token, ip: a.ip })).status, 404);
  assert.equal((await srv.api('GET', '/bootstrap', { token: b.token, ip: b.ip })).status, 200);
  assert.ok((await me(a)).json.active.every((x) => x.id !== bSession));
});

test('a suspended account is cut off immediately, live connections included', async () => {
  const u = await srv.register();
  const sock = await srv.socket(u.token);
  assert.equal((await srv.api('POST', `/admin/users/${u.id}/suspend`, { token: srv.owner.token, ip: srv.owner.ip, body: { reason: 'test', hours: 1 } })).status, 200);
  assert.ok(await waitFor(() => sock.disconnected));
  assert.notEqual((await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 200);
  assert.equal((await srv.login(u)).status, 403);
});

// The app signs out (and says why) on 'session:revoked'; a connection closed without it only reconnects, gets
// refused and lands on the sign-in screen with no explanation. So every way of cutting someone off sends it first.
test('suspension, staff sign-out and account deletion tell open windows why before closing them', async () => {
  const cutOff = async (u, act) => {
    const sock = await srv.socket(u.token);
    let why = null;
    sock.on('session:revoked', (p) => { why = p && p.reason; });
    assert.equal((await act()).status, 200);
    assert.ok(await waitFor(() => sock.disconnected), 'socket closed');
    return why;
  };
  const owner = { token: srv.owner.token, ip: srv.owner.ip };
  const a = await srv.register();
  assert.equal(await cutOff(a, () => srv.api('POST', `/admin/users/${a.id}/suspend`, { ...owner, body: { reason: 'test', hours: 1 } })), 'suspended');
  const b = await srv.register();
  assert.equal(await cutOff(b, () => srv.api('POST', `/admin/users/${b.id}/logout`, owner)), 'staff');
  const c = await srv.register();
  const laptop = (await srv.login(c)).json.token;
  assert.equal(await cutOff({ ...c, token: laptop }, () => srv.api('DELETE', '/me', { token: c.token, ip: c.ip, body: { authKey: c.authKey, confirm: c.username } })), 'account_deleted');
});

test('restarting the server keeps everyone signed in and the database intact (twice)', async () => {
  const u = await srv.register();
  for (let i = 0; i < 2; i++) {
    await srv.restart();
    assert.equal((await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 200, `after restart ${i + 1}`);
  }
  const d = srv.db(); const v = d.pragma('user_version', { simple: true }); d.close();
  assert.ok(v >= 13, `schema ${v}`);
  const ok = (await srv.api('GET', '/admin/log/verify', { token: srv.owner.token, ip: srv.owner.ip })).json;
  assert.equal(ok.ok, true);
});
