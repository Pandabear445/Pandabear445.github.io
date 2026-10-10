// Browser hardening headers, the append-only audit log, and what a copy of the database (or a stolen backup)
// gives away.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, confirmEmail, enable2fa, newIp, hex, b64 } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

// ------------------------------------------------------------------ headers
const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((p) => p[0]).map(([k, ...v]) => [k, v]));

test('Content-Security-Policy is present and actually restrictive', async () => {
  for (const p of ['/', '/api/config', '/download', '/terms']) {
    const r = await srv.call('GET', p);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, `${p} has a CSP`);
    const d = directives(csp);
    assert.deepEqual(d['default-src'], ["'self'"]);
    assert.ok(d['script-src'].includes("'self'"));
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", '*', 'https:', 'http:', 'data:', 'blob:']) assert.ok(!d['script-src'].includes(bad), `script-src allows ${bad}`);
    assert.deepEqual(d['script-src-attr'], ["'none'"]);
    assert.deepEqual(d['object-src'], ["'none'"]);
    assert.deepEqual(d['frame-ancestors'], ["'none'"]);
    assert.deepEqual(d['base-uri'], ["'none'"]);
    assert.deepEqual(d['form-action'], ["'self'"]);
    assert.ok(!d['connect-src'].some((s) => ['*', 'https:', 'wss:', 'ws:', 'http:'].includes(s)), `connect-src too wide: ${d['connect-src']}`);
  }
});

test('the other security headers are set; nothing reveals the software', async () => {
  const r = await srv.call('GET', '/');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(r.headers.get('permissions-policy'), /geolocation=\(\)/);
  assert.equal(r.headers.get('x-powered-by'), null);
  const api = await srv.api('GET', '/config');
  assert.equal(api.headers.get('cache-control'), 'no-store');
  assert.equal(api.headers.get('cross-origin-resource-policy'), 'same-origin');
});

test('HSTS is sent over HTTPS (behind the proxy)', async () => {
  const r = await srv.call('GET', '/', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/);
  assert.match(r.headers.get('content-security-policy'), /upgrade-insecure-requests/);
});

test('no cookies at all: sign-in uses a bearer token, so there is nothing for CSRF to ride on', async () => {
  const u = await srv.register();
  for (const r of [await srv.login(u), await srv.api('GET', '/bootstrap', { token: u.token, ip: u.ip }), await srv.call('GET', '/'), await srv.api('GET', '/config')]) {
    assert.equal(r.headers.get('set-cookie'), null);
  }
  // A forged cross-site form post (no Authorization header) gets nowhere.
  const forged = await srv.call('POST', '/api/me/password', { raw: 'oldAuthKey=x', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' } });
  assert.equal(forged.status, 401);
});

test('uploaded files are served sandboxed and can’t run as a page', async () => {
  const r = await srv.call('GET', '/uploads/nonexistent.html');
  assert.notEqual(r.status, 200);
  // any upload response is sandboxed (checked on a real file)
  const u = await srv.register();
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'text/html' }), 'x.html');
  const up = await fetch(`${srv.base}/api/upload/encrypted`, { method: 'POST', headers: { authorization: `Bearer ${u.token}`, 'x-forwarded-for': u.ip }, body: form });
  const j = await up.json();
  if (up.ok) {
    const f = await srv.call('GET', j.url);
    assert.notEqual(f.headers.get('content-type'), 'text/html');
    assert.match(f.headers.get('content-security-policy') || '', /sandbox|default-src 'none'/);
    assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
  }
});

// ------------------------------------------------------------------ audit log
test('security events land in the audit log', async () => {
  const u = await srv.register(); await confirmEmail(srv, u, `${u.username}@example.test`);
  await srv.api('POST', '/auth/forgot', { body: { login: u.username }, ip: newIp() });
  await enable2fa(srv, u);
  await srv.api('PUT', '/admin/staff', { token: srv.owner.token, ip: srv.owner.ip, body: { userId: u.id, role: 'moderator' } });
  await srv.api('POST', `/admin/users/${u.id}/2fa/remove`, { token: srv.owner.token, ip: srv.owner.ip });
  const actions = srv.sql('SELECT action FROM admin_log WHERE target = ? ORDER BY id', u.id).map((r) => r.action);
  for (const a of ['email_changed', 'password_reset_requested', '2fa_enabled', 'role_moderator', '2fa_removed']) assert.ok(actions.includes(a), `${a} in ${actions}`);
});

test('the audit log is append-only: the database refuses edits and deletes', async () => {
  const d = srv.db();
  try {
    assert.throws(() => d.prepare("UPDATE admin_log SET action = 'nothing' WHERE id = 1").run(), /append-only/);
    assert.throws(() => d.prepare('DELETE FROM admin_log').run(), /append-only/);
  } finally { d.close(); }
  // no API route deletes log entries either
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.ok(!/DELETE FROM admin_log|UPDATE admin_log/.test(src));
});

test('tampering with the log file by hand is detected (hash chain)', async () => {
  const ok = (await srv.api('GET', '/admin/log/verify', { token: srv.owner.token, ip: srv.owner.ip })).json;
  assert.equal(ok.ok, true); assert.ok(ok.entries > 3);
  // An attacker with the database file drops the protection and rewrites one entry.
  const d = srv.db();
  const victim = d.prepare('SELECT id FROM admin_log ORDER BY id LIMIT 1 OFFSET 2').get().id;
  d.exec('DROP TRIGGER admin_log_no_update');
  d.prepare("UPDATE admin_log SET detail = 'nothing to see here' WHERE id = ?").run(victim);
  d.close();
  const bad = (await srv.api('GET', '/admin/log/verify', { token: srv.owner.token, ip: srv.owner.ip })).json;
  assert.equal(bad.ok, false);
  assert.equal(bad.brokenAt, victim);
});

// ------------------------------------------------------------------ stolen database
test('a stolen database holds no usable secrets', async () => {
  const u = await srv.register(); await confirmEmail(srv, u, `${u.username}@example.test`);
  const { secret, backupCodes } = await enable2fa(srv, u);
  await srv.api('PUT', '/admin/mail', { token: srv.owner.token, ip: srv.owner.ip, body: { host: 'smtp.example.test', pass: 'SMTP-PASSWORD-123', from: 'x@example.test' } });
  const dump = JSON.stringify([srv.sql('SELECT * FROM users'), srv.sql('SELECT * FROM sessions'), srv.sql('SELECT * FROM auth_tokens'), srv.sql('SELECT * FROM instance_settings')]);
  assert.ok(!dump.includes(secret), 'two-factor secret is encrypted');
  for (const c of backupCodes) assert.ok(!dump.includes(c.replace('-', '')), 'backup codes are hashed');
  assert.ok(!dump.includes('SMTP-PASSWORD-123'), 'SMTP password is encrypted');
  assert.ok(!dump.includes(u.token), 'session tokens are hashed');
  assert.ok(!dump.includes(u.authKey), 'password-derived keys are hashed');
  // Messages are whatever the apps sent: ciphertext. The server has nothing to decrypt them with.
  assert.ok(!/BEGIN (EC )?PRIVATE KEY|"d":"/.test(dump), 'no private keys in the clear');
});
