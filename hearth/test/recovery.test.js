// Password reset by email, the recovery key, and two-factor sign-in — the places where good encryption is most
// often undermined. Each test plays the attacker: what can someone with this much access actually do?
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, confirmEmail, enable2fa, freshCode, totp, resetProof, resetTokenFrom, newIp, hex, b64 } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

const forgot = (login, ip = newIp()) => srv.api('POST', '/auth/forgot', { body: { login }, ip });
const lastMailTo = (email) => srv.mails().filter((m) => m.to === email).pop();
async function resetLink(u, email) {
  const n = srv.mails().length;
  await forgot(u.username);
  const m = srv.mails().slice(n).find((x) => x.to === email);
  assert.ok(m, 'reset email sent');
  return resetTokenFrom(m);
}
const newKeysBody = (token, extra = {}) => {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { token, authKey: hex(32), kdfSalt: b64(16), encPrivateKey: b64(120), publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), ...extra };
};
const withRecovery = async (u) => {
  const r = await srv.api('PUT', '/me/recovery', { token: u.token, ip: u.ip, body: { authKey: u.authKey, encPrivateKeyRecovery: b64(150), recoverySalt: b64(16) } });
  assert.equal(r.status, 200, r.text);
};

// ------------------------------------------------------------------ forgot password
test('"forgot password" answers the same for unknown, unconfirmed and real accounts', async () => {
  const a = await srv.register(); await confirmEmail(srv, a, `${a.username}@example.test`);
  const b = await srv.register(); // no email
  const n = srv.mails().length;
  const answers = await Promise.all([forgot(a.username), forgot(b.username), forgot('nobody_' + hex(3)), forgot('nobody@example.test'), forgot(`${a.username}@example.test`)]);
  for (const r of answers) assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  const sent = srv.mails().slice(n);
  assert.equal(sent.length, 2, 'only the confirmed address gets mail (twice: by name and by email)');
  assert.ok(sent.every((m) => m.to === `${a.username}@example.test`));
});

test('an inbox can’t be flooded, and the limit doesn’t reveal the account exists', async () => {
  const a = await srv.register(); await confirmEmail(srv, a, `${a.username}@example.test`);
  const n = srv.mails().length;
  const rs = [];
  for (let i = 0; i < 6; i++) rs.push(await forgot(a.username));
  assert.ok(rs.every((r) => r.status === 200), 'never a different answer for a real account');
  assert.equal(srv.mails().slice(n).length, 3, 'at most 3 reset emails an hour');
});

test('"forgot password" is limited per network', async () => {
  const ip = newIp();
  const rs = [];
  for (let i = 0; i < 7; i++) rs.push((await forgot('x' + i, ip)).status);
  assert.ok(rs.includes(429));
});

test('reset links: wrong, expired and already-used links are refused', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  for (const token of ['', 'x'.repeat(43), hex(32), null, { $gt: '' }]) {
    assert.equal((await srv.api('POST', '/auth/reset/info', { body: { token }, ip: newIp() })).status, 400);
    assert.equal((await srv.api('POST', '/auth/reset', { body: newKeysBody(token), ip: newIp() })).status, 400);
  }
  // expired
  const t1 = await resetLink(u, email);
  srv.sql("UPDATE auth_tokens SET expires_at = ? WHERE kind = 'reset' AND user_id = ?", Date.now() - 1, u.id);
  assert.equal((await srv.api('POST', '/auth/reset', { body: newKeysBody(t1), ip: newIp() })).status, 400);
  // used once → can't be used again
  const t2 = await resetLink(u, email);
  assert.equal((await srv.api('POST', '/auth/reset', { body: newKeysBody(t2), ip: newIp() })).status, 200);
  assert.equal((await srv.api('POST', '/auth/reset', { body: newKeysBody(t2), ip: newIp() })).status, 400);
  assert.equal((await srv.api('POST', '/auth/reset/info', { body: { token: t2 }, ip: newIp() })).status, 400);
});

test('a reset link stored in the database is only a hash (a stolen database has no working links)', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  const raw = await resetLink(u, email);
  const rows = srv.sql("SELECT id FROM auth_tokens WHERE kind = 'reset' AND user_id = ?", u.id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, raw);
  assert.equal((await srv.api('POST', '/auth/reset/info', { body: { token: rows[0].id }, ip: newIp() })).status, 400);
});

test('two resets racing with one link: only one succeeds', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  const t = await resetLink(u, email);
  const rs = await Promise.all(Array.from({ length: 5 }, () => srv.api('POST', '/auth/reset', { body: newKeysBody(t), ip: newIp() })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400, 400, 400, 400]);
});

test('a reset signs out every device (live connections too) and emails a notice', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  const sock = await srv.socket(u.token);
  const t = await resetLink(u, email);
  const r = await srv.api('POST', '/auth/reset', { body: newKeysBody(t), ip: newIp() });
  assert.equal(r.status, 200);
  assert.equal((await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 401);
  await new Promise((res) => (sock.disconnected ? res() : sock.once('disconnect', res)));
  assert.match(lastMailTo(email).subject, /password was changed/);
  assert.equal((await srv.api('GET', '/bootstrap', { token: r.json.token, ip: u.ip })).status, 200);
});

// ------------------------------------------------------------------ recovery key
test('reset without the recovery key: new keys, old keys and server keys are dropped', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  await withRecovery(u);
  const t = await resetLink(u, email);
  const body = newKeysBody(t);
  assert.equal((await srv.api('POST', '/auth/reset', { body, ip: newIp() })).status, 200);
  const row = srv.sql('SELECT public_key, enc_private_key_recovery, sign_public_key FROM users WHERE id = ?', u.id)[0];
  assert.equal(row.public_key, body.publicKey);
  assert.equal(row.enc_private_key_recovery, null, 'the old recovery copy is useless with new keys and is removed');
  assert.equal(row.sign_public_key, null);
});

test('keeping keys needs proof of the private key: email access alone is not enough', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  await withRecovery(u);
  const t = await resetLink(u, email);
  const info = (await srv.api('POST', '/auth/reset/info', { body: { token: t }, ip: newIp() })).json;
  assert.ok(info.hasRecovery && info.keyChallenge && info.keyChallenge.nonce);
  const base = { token: t, authKey: hex(32), kdfSalt: b64(16), encPrivateKey: b64(120), keepKeys: true };
  // no proof / a made-up proof / a proof from a different key / a proof for an old challenge
  const attacker = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  for (const keyProof of [undefined, b64(32), resetProof({ ...u, privateKey: attacker.privateKey }, info.keyChallenge)]) {
    const r = await srv.api('POST', '/auth/reset', { body: { ...base, keyProof }, ip: newIp() });
    assert.equal(r.status, 403, `proof ${String(keyProof).slice(0, 10)}`);
  }
  const stale = resetProof(u, info.keyChallenge);
  await srv.api('POST', '/auth/reset/info', { body: { token: t }, ip: newIp() }); // a new challenge replaces the old one
  assert.equal((await srv.api('POST', '/auth/reset', { body: { ...base, keyProof: stale }, ip: newIp() })).status, 403);
  // the account is untouched by all that
  assert.equal((await srv.login(u)).status, 200);
});

test('recovery-key restoration: the right proof keeps the same keys, so old messages stay readable', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  await withRecovery(u);
  const before = srv.sql('SELECT public_key, enc_private_key_recovery FROM users WHERE id = ?', u.id)[0];
  const t = await resetLink(u, email);
  const info = (await srv.api('POST', '/auth/reset/info', { body: { token: t }, ip: newIp() })).json;
  assert.equal(info.encPrivateKeyRecovery, before.enc_private_key_recovery, 'the encrypted copy is handed back for the device to open');
  const newAuth = hex(32);
  const r = await srv.api('POST', '/auth/reset', { body: { token: t, authKey: newAuth, kdfSalt: b64(16), encPrivateKey: b64(120), keepKeys: true, keyProof: resetProof(u, info.keyChallenge) }, ip: newIp() });
  assert.equal(r.status, 200, r.text);
  const after = srv.sql('SELECT public_key, enc_private_key_recovery FROM users WHERE id = ?', u.id)[0];
  assert.equal(after.public_key, before.public_key, 'same identity key');
  assert.equal(after.enc_private_key_recovery, before.enc_private_key_recovery, 'recovery key still works next time');
  assert.equal((await srv.login({ ...u, authKey: newAuth })).status, 200);
  assert.equal((await srv.login(u)).status, 401, 'old password is gone');
});

test('keepKeys on an account without a recovery key is refused', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  const t = await resetLink(u, email);
  const info = (await srv.api('POST', '/auth/reset/info', { body: { token: t }, ip: newIp() })).json;
  const r = await srv.api('POST', '/auth/reset', { body: { token: t, authKey: hex(32), kdfSalt: b64(16), encPrivateKey: b64(120), keepKeys: true, keyProof: resetProof(u, info.keyChallenge) }, ip: newIp() });
  assert.equal(r.status, 400);
});

test('recovery key and email changes need the password', async () => {
  const u = await srv.register();
  assert.equal((await srv.api('PUT', '/me/recovery', { token: u.token, ip: u.ip, body: { authKey: hex(32), encPrivateKeyRecovery: b64(150), recoverySalt: b64(16) } })).status, 401);
  assert.equal((await srv.api('POST', '/me/email', { token: u.token, ip: u.ip, body: { authKey: hex(32), email: 'x@example.test' } })).status, 401);
  assert.equal((await srv.api('DELETE', '/me/recovery', { token: u.token, ip: u.ip, body: {} })).status, 401);
});

test('email confirmation codes: 5 wrong tries kill the code', async () => {
  const u = await srv.register();
  await srv.api('POST', '/me/email', { token: u.token, ip: u.ip, body: { authKey: u.authKey, email: `${u.username}@example.test` } });
  const code = /is (\d{6})/.exec(lastMailTo(`${u.username}@example.test`).subject)[1];
  const wrong = String((+code + 1) % 1000000).padStart(6, '0');
  for (let i = 0; i < 5; i++) assert.equal((await srv.api('POST', '/me/email/verify', { token: u.token, ip: u.ip, body: { code: wrong } })).status, 400);
  assert.equal((await srv.api('POST', '/me/email/verify', { token: u.token, ip: u.ip, body: { code } })).status, 429, 'even the right code is dead now');
});

test('changing the email warns the old address', async () => {
  const u = await srv.register(); const old = `${u.username}@example.test`; await confirmEmail(srv, u, old);
  await confirmEmail(srv, u, `${u.username}.new@example.test`);
  assert.match(lastMailTo(old).subject, /email was changed/);
});

// ------------------------------------------------------------------ two-factor
test('2FA: the password alone no longer signs in; wrong, reused and malformed codes fail', async () => {
  const u = await srv.register();
  const { secret, used } = await enable2fa(srv, u);
  const r1 = await srv.login(u);
  assert.equal(r1.status, 401); assert.equal(r1.json.code, 'need_2fa'); assert.equal(r1.json.token, undefined);
  for (const totpCode of ['000000', '12345', 'abcdef', '1234567', 123456]) {
    const r = await srv.login(u, { totp: totpCode });
    assert.ok([400, 401].includes(r.status), String(totpCode));
    assert.equal(r.json.token, undefined);
  }
  const code = await freshCode(secret, used);
  assert.equal((await srv.login(u, { totp: code })).status, 200);
  const replay = await srv.login(u, { totp: code });
  assert.equal(replay.status, 401, 'a code works only once');
  assert.equal(replay.json.code, 'bad_2fa');
  // an older code (from before the last one used) doesn't work either
  assert.equal((await srv.login(u, { totp: totp(secret, -1) })).status, 401);
});

test('2FA: guessing is limited per account, from any number of networks', async () => {
  const u = await srv.register();
  await enable2fa(srv, u);
  const rs = [];
  for (let i = 0; i < 10; i++) rs.push((await srv.api('POST', '/auth/login', { body: { username: u.username, authKey: u.authKey, totp: String(100000 + i) }, ip: u.ip })).status);
  assert.ok(rs.slice(8).every((s) => s === 429), rs.join(','));
});

test('2FA backup codes work once each', async () => {
  const u = await srv.register();
  const { backupCodes } = await enable2fa(srv, u);
  assert.equal(backupCodes.length, 10);
  assert.equal((await srv.login(u, { backupCode: backupCodes[0] })).status, 200);
  assert.equal((await srv.login(u, { backupCode: backupCodes[0] })).status, 401);
  assert.equal((await srv.login(u, { backupCode: backupCodes[1].toUpperCase().replace('-', ' ') })).status, 200, 'case and spacing don’t matter');
  const stored = srv.sql('SELECT backup_codes FROM users WHERE id = ?', u.id)[0].backup_codes;
  for (const c of backupCodes) assert.ok(!stored.includes(c.replace('-', '')), 'codes are stored hashed');
});

test('2FA racing: 8 simultaneous logins with one backup code, or one authenticator code → one session', async () => {
  const u = await srv.register();
  const { secret, backupCodes, used } = await enable2fa(srv, u);
  const rs = await Promise.all(Array.from({ length: 8 }, () => srv.login(u, { backupCode: backupCodes[3] })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, 'backup code');
  const v = await srv.register();
  const t = await enable2fa(srv, v);
  const code = await freshCode(t.secret, t.used);
  const rv = await Promise.all(Array.from({ length: 8 }, () => srv.login(v, { totp: code })));
  assert.equal(rv.filter((r) => r.status === 200).length, 1, 'authenticator code');
  void secret; void used;
});

test('2FA is needed for a password reset too (a stolen inbox is not enough)', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  const { secret, used } = await enable2fa(srv, u);
  const t = await resetLink(u, email);
  const info = (await srv.api('POST', '/auth/reset/info', { body: { token: t }, ip: newIp() })).json;
  assert.equal(info.need2fa, true);
  assert.equal((await srv.api('POST', '/auth/reset', { body: newKeysBody(t), ip: newIp() })).status, 401);
  assert.equal((await srv.api('POST', '/auth/reset', { body: newKeysBody(t, { totp: '000000' }), ip: newIp() })).status, 401);
  assert.equal((await srv.login(u)).json.code, 'need_2fa', 'nothing changed');
  assert.equal((await srv.api('POST', '/auth/reset', { body: newKeysBody(t, { totp: await freshCode(secret, used) }), ip: newIp() })).status, 200);
});

test('turning 2FA on signs out other devices; turning it off needs password AND a code', async () => {
  const u = await srv.register();
  const other = (await srv.login(u)).json.token;
  const { backupCodes } = await enable2fa(srv, u);
  assert.equal((await srv.api('GET', '/bootstrap', { token: other, ip: u.ip })).status, 401);
  assert.equal((await srv.api('POST', '/me/2fa/disable', { token: u.token, ip: u.ip, body: { authKey: u.authKey } })).status, 401);
  assert.equal((await srv.api('POST', '/me/2fa/disable', { token: u.token, ip: u.ip, body: { authKey: hex(32), backupCode: backupCodes[0] } })).status, 401);
  assert.equal((await srv.api('POST', '/me/2fa/disable', { token: u.token, ip: u.ip, body: { authKey: u.authKey, backupCode: backupCodes[0] } })).status, 200);
  assert.equal((await srv.login(u)).status, 200);
});

test('2FA enable needs a valid code from the new secret; setup needs the password', async () => {
  const u = await srv.register();
  assert.equal((await srv.api('POST', '/me/2fa/setup', { token: u.token, ip: u.ip, body: { authKey: hex(32) } })).status, 401);
  await srv.api('POST', '/me/2fa/setup', { token: u.token, ip: u.ip, body: { authKey: u.authKey } });
  assert.equal((await srv.api('POST', '/me/2fa/enable', { token: u.token, ip: u.ip, body: { code: '000000' } })).status, 400);
  assert.equal(srv.sql('SELECT totp_enabled FROM users WHERE id = ?', u.id)[0].totp_enabled, 0);
});

test('step-up: with 2FA on, a stolen session + password still can’t change the password, email or recovery key', async () => {
  const u = await srv.register();
  const { backupCodes } = await enable2fa(srv, u);
  // pretend the session is old (the 10-minute grace after a 2FA sign-in has passed)
  srv.sql('UPDATE sessions SET mfa_at = ? WHERE user_id = ?', Date.now() - 3600000, u.id);
  const pw = { oldAuthKey: u.authKey, newAuthKey: hex(32), encPrivateKey: b64(60), salt: b64(16) };
  const r = await srv.api('POST', '/me/password', { token: u.token, ip: u.ip, body: pw });
  assert.equal(r.status, 401); assert.equal(r.json.code, 'need_2fa');
  assert.equal((await srv.api('PUT', '/me/recovery', { token: u.token, ip: u.ip, body: { authKey: u.authKey, encPrivateKeyRecovery: b64(150), recoverySalt: b64(16) } })).json.code, 'need_2fa');
  assert.equal((await srv.api('POST', '/me/email', { token: u.token, ip: u.ip, body: { authKey: u.authKey, email: 'evil@example.test' } })).json.code, 'need_2fa');
  assert.equal((await srv.api('DELETE', '/me', { token: u.token, ip: u.ip, body: { authKey: u.authKey, confirm: u.username } })).json.code, 'need_2fa');
  // with the code it works
  assert.equal((await srv.api('POST', '/me/password', { token: u.token, ip: u.ip, body: { ...pw, backupCode: backupCodes[0] } })).status, 200);
});

test('2FA failures after the right password email a warning', async () => {
  const u = await srv.register(); const email = `${u.username}@example.test`; await confirmEmail(srv, u, email);
  await enable2fa(srv, u);
  for (let i = 0; i < 3; i++) await srv.login(u, { totp: String(200000 + i) });
  assert.match(lastMailTo(email).subject, /someone has your password/);
});

test('admins can remove 2FA only for people below them; others can’t at all', async () => {
  const u = await srv.register(); await enable2fa(srv, u);
  const rando = await srv.register();
  assert.equal((await srv.api('POST', `/admin/users/${u.id}/2fa/remove`, { token: rando.token, ip: rando.ip })).status, 403);
  const admin = await srv.register();
  assert.equal((await srv.api('PUT', '/admin/staff', { token: srv.owner.token, ip: srv.owner.ip, body: { userId: admin.id, role: 'admin' } })).status, 200);
  await enable2fa(srv, srv.owner).catch(() => {}); // owner turns on 2FA (their session stays)
  assert.equal((await srv.api('POST', `/admin/users/${srv.owner.id}/2fa/remove`, { token: admin.token, ip: admin.ip })).status, 403, 'an admin can’t strip the owner’s 2FA');
  assert.equal((await srv.api('POST', `/admin/users/${admin.id}/2fa/remove`, { token: admin.token, ip: admin.ip })).status, 400, 'nor their own');
  assert.equal((await srv.api('POST', `/admin/users/${u.id}/2fa/remove`, { token: admin.token, ip: admin.ip })).status, 200);
  const log = srv.sql("SELECT * FROM admin_log WHERE action = '2fa_removed' AND target = ?", u.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].admin_id, admin.id);
});
