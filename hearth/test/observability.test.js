// Observability and operations: the structured log (redaction, request ids, access log), safe background jobs,
// health endpoints, alerts (dedup, cooldown, caps) and the doctor command.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, newIp, hex, sleep } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const log = require('../server/log');
const jobs = require('../server/jobs');
const setupAlerts = require('../server/alerts');

// Everything the logger writes while fn runs (it writes to stdout/stderr directly).
function capture(fn) {
  const out = [];
  const o = process.stdout.write; const e = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  try { fn(); } finally { process.stdout.write = o; process.stderr.write = e; }
  return out.join('');
}
const lines = (text) => text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

// ------------------------------------------------------------------ the logger on its own
test('log: secrets in fields, URLs, headers, bodies and error messages are redacted', () => {
  const token = hex(32);
  const text = capture(() => {
    log.info('t', 'fields', {
      token, authorization: `Bearer ${token}`, authKey: hex(32), password: 'hunter2-password', recoveryKey: 'ABCD-EFGH-IJKL-MNOP',
      cookie: 'sid=abc123', ciphertext: 'c2:1:xyz', body: { text: 'hello secret message' }, headers: { Authorization: `Bearer ${token}`, 'x-other': 'fine' },
      url: `https://chat.example.test/reset?token=${token}&k=topsecret`, path: `/regions/install/abc?k=${token}`,
    });
    log.info('t', 'msg', { msg: `failed for Bearer ${token} at /api/media/gif?u=x&t=mediatok123` });
    log.error('t', 'err', new Error(`bad session ${token} password=hunter2-password`));
  });
  for (const secret of [token, 'hunter2-password', 'ABCD-EFGH-IJKL-MNOP', 'sid=abc123', 'c2:1:xyz', 'hello secret message', 'topsecret', 'mediatok123']) {
    assert.ok(!text.includes(secret), `${secret} leaked into: ${text}`);
  }
  const [a, b, c] = lines(text);
  assert.equal(a.token, '[redacted]');
  assert.equal(a.headers['x-other'], 'fine', 'harmless fields are kept');
  assert.match(a.url, /^https:\/\/chat\.example\.test\/reset\?\[redacted\]$/);
  assert.match(b.msg, /failed for Bearer \[redacted\]/);
  assert.equal(c.level, 'error');
  assert.equal(c.errorCategory, 'error');
  for (const l of [a, b, c]) for (const k of ['ts', 'level', 'component', 'op']) assert.ok(l[k], `every line has ${k}`);
});

test('log: IP addresses are cut to their network; error categories are short and safe', () => {
  assert.equal(log.truncIp('198.51.100.77'), '198.51.100.0/24');
  assert.equal(log.truncIp('::ffff:203.0.113.9'), '203.0.113.0/24');
  assert.equal(log.truncIp('2001:db8:abcd:12:34::1'), '2001:db8:abcd::/48');
  const text = capture(() => log.info('t', 'ip', { ip: '198.51.100.77', ips: ['203.0.113.5'] }));
  assert.ok(!text.includes('198.51.100.77') && !text.includes('203.0.113.5'));
  assert.equal(log.errorCategory(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })), 'db_busy');
  assert.equal(log.errorCategory(Object.assign(new Error('x'), { code: 'ENOSPC' })), 'disk_full');
  assert.equal(log.errorCategory(new TypeError('x')), 'bug');
  // The operator can ask for full addresses.
  const r = spawnSync(process.execPath, ['-e', "console.log(require('./server/log').truncIp('198.51.100.77'))"], { cwd: ROOT, env: { ...process.env, LOG_FULL_IP: 'true' }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '198.51.100.77');
});

test('log: pretty format is readable and still redacted', () => {
  const token = hex(32);
  const r = spawnSync(process.execPath, ['-e', `require('./server/log').warn('backup', 'failed', { msg: 'Bearer ${token} broke', ip: '198.51.100.7' })`], { cwd: ROOT, env: { ...process.env, LOG_FORMAT: 'pretty' }, encoding: 'utf8' });
  assert.match(r.stderr, /WARN\s+backup failed: Bearer \[redacted\] broke {2}ip=198\.51\.100\.0\/24/);
  assert.ok(!r.stderr.includes(token));
});

test('process: an unhandled rejection is logged and the process carries on; an uncaught exception is logged, then exit 1', () => {
  const script = `require('./server/log').installProcessHandlers();
    Promise.reject(new Error('nobody handled this'));
    setTimeout(() => { console.log('STILL RUNNING'); throw Object.assign(new Error('boom ${'f'.repeat(64)}'), { code: 'SQLITE_BUSY' }); }, 50);`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, LOG_FORMAT: 'json' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1, 'exits non-zero so systemd/Docker restart it');
  assert.match(r.stdout, /STILL RUNNING/, 'an unhandled rejection does not stop the process');
  const out = lines(r.stderr);
  const rej = out.find((l) => l.op === 'unhandled_rejection');
  const crash = out.find((l) => l.op === 'uncaught_exception');
  assert.ok(rej && rej.level === 'error' && /nobody handled this/.test(rej.error.message));
  assert.ok(crash && crash.level === 'fatal' && crash.errorCategory === 'db_busy' && crash.outcome === 'crash');
  assert.ok(!r.stderr.includes('f'.repeat(64)), 'the crash line is redacted too');
});

// ------------------------------------------------------------------ jobs on their own
test('jobs: a job that throws (sync or async) is caught, recorded, and the process keeps going; recovery resets it', async () => {
  const failed = []; const recovered = [];
  jobs.setOnFailure((r) => failed.push([r.name, r.failures]));
  jobs.setOnRecover((r) => recovered.push(r.name));
  let syncFail = true;
  let out;
  out = capture(() => {
    const a = jobs.every('t.sync', 20, () => { if (syncFail) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); }, { firstDelay: 0 });
    const b = jobs.every('t.async', 20, async () => { throw new Error('async nope'); }, { firstDelay: 0 });
    setTimeout(() => { a.stop(); b.stop(); }, 5000).unref();
  });
  await sleep(150);
  let s = jobs.get('t.sync'); const as = jobs.get('t.async');
  assert.ok(s.failures >= 3, `sync job failed repeatedly (${s.failures})`);
  assert.equal(s.lastErrorCategory, 'db_busy');
  assert.equal(jobs.statusOf(s), 'fail');
  assert.ok(as.failures >= 3 && as.lastError === 'async nope');
  assert.ok(failed.some(([n, f]) => n === 't.sync' && f >= 3), 'failures are reported');
  syncFail = false;
  await sleep(80);
  s = jobs.get('t.sync');
  assert.equal(s.failures, 0, 'a success resets the count');
  assert.ok(s.lastOk && s.totalFailures >= 3);
  assert.deepEqual(recovered.filter((n) => n === 't.sync'), ['t.sync']);
  assert.equal(jobs.statusOf(s), 'ok');
  // A run still going when the next is due is skipped, not stacked.
  let running = 0; let maxRunning = 0;
  out = capture(() => { const c = jobs.every('t.slow', 10, async () => { running++; maxRunning = Math.max(maxRunning, running); await sleep(60); running--; }, { firstDelay: 0 }); setTimeout(() => c.stop(), 200).unref(); });
  await sleep(250);
  assert.equal(maxRunning, 1);
  assert.ok(jobs.get('t.slow').skipped > 0);
  void out;
});

// ------------------------------------------------------------------ alerts on their own
function alertRig(settings = {}) {
  const store = new Map(Object.entries(settings));
  const emitted = []; const mails = [];
  const A = setupAlerts({
    getSetting: (k) => store.get(k), setSetting: (k, v) => (v == null ? store.delete(k) : store.set(k, v)),
    emitAdmins: (ev, data) => emitted.push({ ev, data }), ownerRow: () => ({ id: 'o', email: 'owner@example.test', email_verified: 1 }),
    notify: (row, what, text, opts) => mails.push({ to: row.email, what, text, opts }),
  });
  return { A, store, emitted, mails };
}

test('alerts: the same alert is sent once per cooldown; what was held back is counted in the next one', (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  const { A, emitted, mails, store } = alertRig();
  const secret = hex(32);
  assert.equal(A.raise('backup_failed', { severity: 'critical', title: 'The daily backup failed', detail: `disk_full at /x?token=${secret}` }), 'sent');
  assert.equal(A.raise('backup_failed', { title: 'The daily backup failed' }), 'cooldown');
  assert.equal(A.raise('backup_failed', { title: 'The daily backup failed' }), 'cooldown');
  assert.equal(emitted.length, 1); assert.equal(mails.length, 1);
  assert.equal(emitted[0].ev, 'admin:alert');
  assert.ok(!JSON.stringify(emitted).includes(secret) && !JSON.stringify(mails).includes(secret), 'alerts are scrubbed');
  assert.equal(mails[0].opts.footer, '', 'not the "if this wasn’t you" footer');
  // After the cooldown (an hour by default) it goes out again, saying how many were held back.
  clock += 61 * 60000;
  assert.equal(A.raise('backup_failed', { title: 'The daily backup failed' }), 'sent');
  assert.equal(emitted[1].data.held, 2);
  assert.match(mails[1].text, /2 more like this were held back/);
  // Saved: a restart doesn't send it again within the cooldown.
  const again = alertRig({ alertState: store.get('alertState') }).A;
  assert.equal(again.raise('backup_failed', { title: 'x' }), 'cooldown');
});

test('alerts: at most 12 an hour in all, nothing when switched off, thresholds for errors, sign-in floods and failing jobs', (t) => {
  let clock = 5_000_000;
  t.mock.method(Date, 'now', () => clock);
  const rig = alertRig();
  for (let i = 0; i < 12; i++) assert.equal(rig.A.raise(`k${i}`, { title: `t${i}` }), 'sent');
  assert.equal(rig.A.raise('k12', { title: 'one too many' }), 'capped');
  clock += 3601000;
  assert.equal(rig.A.raise('k12', { title: 'later' }), 'sent');

  const off = alertRig({ alerts: JSON.stringify({ enabled: false }) });
  assert.equal(off.A.raise('x', { title: 'x' }), 'off');
  assert.equal(off.emitted.length + off.mails.length, 0);

  const s = alertRig();
  for (let i = 0; i < 49; i++) s.A.countSecurity('failed_login');
  s.A.countSecurity('username_changed'); // not abuse
  assert.equal(s.emitted.length, 0, 'below the threshold: quiet');
  s.A.countSecurity('captcha_failed');
  assert.equal(s.emitted.length, 1);
  assert.equal(s.emitted[0].data.key, 'auth_abuse');
  assert.match(s.emitted[0].data.detail, /failed_login ×49/);
  for (let i = 0; i < 200; i++) s.A.countSecurity('failed_login');
  assert.equal(s.emitted.length, 1, 'a flood is one alert, not 200');

  const e = alertRig();
  for (let i = 0; i < 10; i++) e.A.countError({ errorCategory: 'db_busy' });
  assert.deepEqual(e.emitted.map((x) => x.data.key), ['app_errors']);

  const j = alertRig();
  j.A.jobFailed({ name: 'newsbot.feeds', failures: 2, lastError: 'x', lastErrorCategory: 'network' });
  assert.equal(j.emitted.length, 0);
  j.A.jobFailed({ name: 'newsbot.feeds', failures: 3, lastError: 'x', lastErrorCategory: 'network' });
  assert.equal(j.emitted[0].data.key, 'job:newsbot.feeds');
});

// ------------------------------------------------------------------ a real server
test('server: request ids, access log by route template, no tokens or full IPs in the log', async () => {
  const srv = await startServer({ LOG_FORMAT: 'json', LOG_ACCESS_SAMPLE: '1' });
  try {
    const { owner } = srv;
    const secret = hex(32);
    // An id we send is echoed; a bad one (spaces, too long) is replaced; none gets one made up.
    let r = await srv.api('GET', '/health/live', { headers: { 'x-request-id': 'probe-42' } });
    assert.equal(r.headers.get('x-request-id'), 'probe-42');
    r = await srv.api('GET', '/health/live', { headers: { 'x-request-id': 'bad id\twith "quotes"' } });
    assert.match(r.headers.get('x-request-id'), /^[A-Za-z0-9_-]{12}$/);
    r = await srv.api('GET', '/health/live', { headers: { 'x-request-id': 'x'.repeat(65) } });
    assert.notEqual(r.headers.get('x-request-id'), 'x'.repeat(65));
    const made = (await srv.api('GET', '/config')).headers.get('x-request-id');
    assert.match(made, /^[A-Za-z0-9_-]{12}$/);

    // Tokens in URLs, headers and bodies.
    await srv.api('GET', `/users/${owner.id}?q=${secret}`, { token: owner.token, ip: '198.18.200.77', headers: { 'x-request-id': 'req-users' } });
    await srv.call('GET', `/uploads/${secret}.bin?k=${secret}`);
    await srv.call('GET', `/media/gif?u=https%3A%2F%2Fmedia.giphy.com%2Fx.gif&t=${secret}`);
    await srv.api('POST', '/auth/login', { body: { username: 'owner', authKey: secret }, ip: '198.18.201.5' });
    await srv.api('GET', '/me/sessions', { token: secret, headers: { cookie: `session=${secret}` } });
    await sleep(200);
    const text = srv.log;
    for (const s of [secret, owner.token, owner.authKey, '198.18.200.77', '198.18.201.5', owner.id]) assert.ok(!text.includes(s), `${s} leaked into the log`);
    const all = lines(text);
    assert.ok(all.length > 5);
    for (const l of all) for (const k of ['ts', 'level', 'component', 'op']) assert.ok(l[k] !== undefined, `${k} on ${JSON.stringify(l)}`);
    const users = all.find((l) => l.reqId === 'req-users');
    assert.equal(users.component, 'http');
    assert.equal(users.route, '/api/users/:id', 'route template, not the URL');
    assert.equal(users.status, 200);
    assert.equal(users.ip, '198.18.200.0/24');
    assert.match(users.uid, /^[0-9a-f]{12}$/, 'a keyed hash of the user id');
    assert.equal(typeof users.durationMs, 'number');
    assert.ok(all.some((l) => l.route === '/uploads/:file'));
    // The failed sign-in is in the security log line too, with the network only.
    const sec = all.find((l) => l.component === 'security' && l.op === 'failed_login');
    assert.ok(sec && sec.ip === '198.18.201.0/24');
  } finally { await srv.stop(); }
});

test('server: live and ready say only ok/degraded/fail and short codes; maintenance makes ready 503', async () => {
  const srv = await startServer();
  try {
    const live = await srv.api('GET', '/health/live');
    assert.equal(live.status, 200);
    assert.deepEqual(live.json, { status: 'ok' });
    const ready = await srv.api('GET', '/health/ready');
    assert.equal(ready.status, 200);
    assert.deepEqual(Object.keys(ready.json).sort(), ['codes', 'status']);
    assert.ok(['ok', 'degraded'].includes(ready.json.status));
    for (const c of ready.json.codes) assert.match(c, /^[a-z_]+$/);
    // Nothing internal: no paths, versions, hostnames or numbers.
    for (const r of [live, ready]) assert.doesNotMatch(r.text, new RegExp([srv.dir, 'hearth-test', 'version', 'node', 'schema', os.hostname(), '\\d'].map((x) => x.replace(/[.*+?^${}()|[\]\\/]/g, (m) => (x === '\\d' ? m : `\\${m}`))).join('|')));
    // Health probes don't need a session and aren't blocked by maintenance (they report it).
    const m = await srv.api('PUT', '/admin/maintenance', { token: srv.owner.token, body: { text: 'Back soon' }, ip: srv.owner.ip });
    assert.equal(m.status, 200);
    const during = await srv.api('GET', '/health/ready');
    assert.equal(during.status, 503);
    assert.ok(during.json.codes.includes('maintenance'));
    assert.equal((await srv.api('GET', '/health/live')).status, 200, 'still alive');
    await srv.api('PUT', '/admin/maintenance', { token: srv.owner.token, body: { text: '' }, ip: srv.owner.ip });
    assert.equal((await srv.api('GET', '/health/ready')).status, 200);
  } finally { await srv.stop(); }
});

test('server: admin health is for instance admins only, and alert settings need the password to turn off', async () => {
  const srv = await startServer();
  try {
    const { owner } = srv;
    const user = await srv.register();
    assert.equal((await srv.api('GET', '/admin/health')).status, 401);
    const denied = await srv.api('GET', '/admin/health', { token: user.token, ip: user.ip });
    assert.equal(denied.status, 403);
    assert.ok(!/jobs|backup|disk/i.test(denied.text), 'a refusal says nothing about the server');
    const r = await srv.api('GET', '/admin/health', { token: owner.token, ip: owner.ip });
    assert.equal(r.status, 200);
    const d = r.json;
    for (const k of ['status', 'database', 'dataDir', 'disk', 'jobs', 'jobList', 'newsbot', 'regions', 'backups', 'process', 'security', 'alerts']) assert.ok(k in d, `has ${k}`);
    assert.ok(['ok', 'degraded', 'fail'].includes(d.status));
    assert.equal(d.database.status, 'ok');
    assert.equal(d.database.schema, d.database.expectedSchema);
    assert.equal(d.dataDir.status, 'ok');
    assert.equal(d.backups.code, 'no_backup_yet', 'a fresh server has no backup yet: degraded, not ok');
    assert.equal(d.backups.status, 'degraded');
    assert.equal(d.newsbot.botAccount, true);
    assert.equal(d.newsbot.feeds, 0);
    assert.ok(typeof d.process.lagP99Ms === 'number' && d.process.version && d.process.uptime >= 0);
    const names = d.jobList.map((j) => j.name);
    for (const n of ['ratelimit.sweep', 'newsbot.feeds', 'backup.daily', 'sessions.purge', 'events.reminders', 'accounts.token_purge', 'memberships.reconcile', 'alerts.check']) assert.ok(names.includes(n), `job ${n} is tracked`);
    assert.ok(!JSON.stringify(d).includes(owner.token));

    // Alert settings: users can't; the owner can, but turning them off needs the password.
    assert.equal((await srv.api('PUT', '/admin/alerts', { token: user.token, body: { enabled: false }, ip: user.ip })).status, 403);
    assert.equal((await srv.api('POST', '/admin/alerts/test', { token: user.token, ip: user.ip })).status, 403);
    const noPw = await srv.api('PUT', '/admin/alerts', { token: owner.token, body: { enabled: false }, ip: owner.ip });
    assert.ok([401, 403].includes(noPw.status), `turning alerts off without the password is refused (${noPw.status})`);
    assert.equal((await srv.api('GET', '/admin/health', { token: owner.token, ip: owner.ip })).json.alerts.enabled, true);
    const off = await srv.api('PUT', '/admin/alerts', { token: owner.token, body: { enabled: false, authKey: owner.authKey }, ip: owner.ip });
    assert.equal(off.status, 200);
    assert.equal(off.json.enabled, false);
    const on = await srv.api('PUT', '/admin/alerts', { token: owner.token, body: { enabled: true, cooldownMin: 30 }, ip: owner.ip });
    assert.equal(on.status, 200, 'turning them back on needs no password');
    assert.equal(on.json.cooldownMin, 30);
    const audit = srv.sql("SELECT action, detail FROM admin_log WHERE action = 'alerts_settings' ORDER BY id");
    assert.equal(audit.length, 2);
    assert.match(audit[0].detail, /alerts on → off/);
  } finally { await srv.stop(); }
});

test('server: a failing job (the daily backup) is logged, reported and alerted, and the server keeps running', async () => {
  // A file where the backups folder should be: every backup attempt fails.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-obs-'));
  fs.writeFileSync(path.join(dir, 'backups'), 'not a folder');
  const srv = await startServer({ DATA_DIR: dir, LOG_FORMAT: 'json', BACKUP_FIRST_CHECK_MS: '1500' });
  try {
    const { owner } = srv;
    const sock = await srv.socket(owner.token);
    const live = [];
    sock.on('admin:alert', (a) => live.push(a));
    let d;
    for (let i = 0; i < 50; i++) {
      d = (await srv.api('GET', '/admin/health', { token: owner.token, ip: owner.ip })).json;
      if (d.jobList.find((j) => j.name === 'backup.daily' && j.failures > 0)) break;
      await sleep(200);
    }
    const job = d.jobList.find((j) => j.name === 'backup.daily');
    assert.ok(job.failures >= 1, 'the failure is recorded');
    assert.ok(job.lastError && job.lastErrorAt && job.lastErrorCategory);
    assert.equal(job.status, 'degraded');
    assert.ok(d.jobs.failing.includes('backup.daily'));
    assert.ok(d.alerts.recent.some((a) => a.key === 'backup_failed' && a.severity === 'critical'), 'the owner is alerted');
    assert.equal((await srv.api('GET', '/health/live')).status, 200, 'the server is still up');
    assert.equal(srv.child.exitCode, null);
    const logged = lines(srv.log).find((l) => l.op === 'run_failed' && l.job === 'backup.daily');
    assert.ok(logged && logged.level === 'error' && logged.errorCategory);
    // Saved for the doctor and for after a restart.
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dir, 'hearth.db'), { readonly: true });
    const row = db.prepare("SELECT failures, last_error_category FROM job_health WHERE name = 'backup.daily'").get();
    db.close();
    assert.ok(row && row.failures >= 1);
    // A test alert reaches the dashboard live.
    const t = await srv.api('POST', '/admin/alerts/test', { token: owner.token, ip: owner.ip });
    assert.equal(t.json.result, 'sent');
    for (let i = 0; i < 20 && !live.some((a) => a.title === 'Test alert'); i++) await sleep(100);
    assert.ok(live.some((a) => a.title === 'Test alert'));
    sock.close();
  } finally { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ doctor
const doctor = (dataDir, env = {}, args = []) => spawnSync(process.execPath, ['server/cli.js', 'doctor', ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 60000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: dataDir, HTTPS: 'false', PUBLIC_URL: 'https://chat.example.test', SMTP_HOST: 'smtp.example.test', HEALTH_DISK_WARN_PCT: '0.5', HEALTH_DISK_FAIL_PCT: '0.1', ...env },
});
const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => { const st = fs.statSync(path.join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}:${(st.mode & 0o777).toString(8)}`; }).join('\n');

test('doctor: a healthy data folder passes (exit 0), read-only, and never prints secrets', async () => {
  const srv = await startServer();
  const dir = srv.dir;
  try {
    // Stop the server but keep its data (as an operator would before running the doctor, though it's safe either way).
    srv.child.kill('SIGTERM');
    for (let i = 0; i < 100 && srv.child.exitCode === null; i++) await sleep(50);
    const bk = spawnSync(process.execPath, ['server/cli.js', 'backup'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATA_DIR: dir }, timeout: 60000 });
    assert.equal(bk.status, 0, bk.stderr);
    const before = snapshot(dir);
    const secretPass = `pw-${hex(8)}`; const secretKey = hex(32);
    const r = doctor(dir, { SMTP_PASS: secretPass, AT_REST_KEY: '', BACKUP_KEY: '' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS {2}Database schema: version \d+ \(current\)$/m);
    assert.match(r.stdout, /^PASS {2}Backups: newest hearth-/m);
    assert.match(r.stdout, /^PASS {2}Email \(SMTP\): set in the environment, password set$/m);
    assert.match(r.stdout, /All good\./);
    assert.doesNotMatch(r.stdout, /^(WARN|FAIL)/m);
    const secret = fs.readFileSync(path.join(dir, 'secret.key'), 'utf8').trim();
    const withKey = doctor(dir, { BACKUP_KEY: secretKey, SMTP_PASS: secretPass });
    for (const s of [secretPass, secretKey, secret]) assert.ok(!(r.stdout + withKey.stdout + r.stderr).includes(s), 'no secret values in the output');
    assert.match(withKey.stdout, /Backup key: BACKUP_KEY is set/);
    assert.equal(snapshot(dir), before, 'the doctor changed nothing in the data folder');
    const json = JSON.parse(doctor(dir, {}, ['--json']).stdout);
    assert.equal(json.exitCode, 0);
    assert.ok(json.results.every((x) => ['pass', 'warn', 'fail'].includes(x.status)));
  } finally { await srv.stop(); }
});

test('doctor: broken data folders fail with exit 2; warnings exit 1; repairs only with a flag', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-doc-'));
  try {
    // Missing folder: fails, and isn't created.
    const missing = path.join(scratch, 'nope');
    let r = doctor(missing);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /^FAIL {2}Data folder: .*doesn't exist/m);
    assert.ok(!fs.existsSync(missing), 'nothing created');
    // A database that isn't one.
    const junk = path.join(scratch, 'junk'); fs.mkdirSync(junk, { mode: 0o700 });
    fs.writeFileSync(path.join(junk, 'hearth.db'), crypto.randomBytes(4096));
    fs.writeFileSync(path.join(junk, 'secret.key'), hex(32), { mode: 0o600 });
    r = doctor(junk);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /^FAIL {2}Database: Couldn't open/m);
    // A database from a newer Hearth.
    const srv = await startServer();
    try {
      srv.child.kill('SIGTERM');
      for (let i = 0; i < 100 && srv.child.exitCode === null; i++) await sleep(50);
      const newer = path.join(scratch, 'newer'); fs.cpSync(srv.dir, newer, { recursive: true });
      const Database = require('better-sqlite3');
      const d = new Database(path.join(newer, 'hearth.db')); d.pragma('user_version = 99'); d.close();
      r = doctor(newer);
      assert.equal(r.status, 2);
      assert.match(r.stdout, /^FAIL {2}Database schema: version 99 is newer/m);
      // A failing job recorded by the server shows up.
      const ok = path.join(scratch, 'ok'); fs.cpSync(srv.dir, ok, { recursive: true });
      const d2 = new Database(path.join(ok, 'hearth.db'));
      d2.prepare("INSERT OR REPLACE INTO job_health (name, failures, last_error, last_error_at, last_error_category, updated_at) VALUES ('newsbot.feeds', 5, 'database is locked', ?, 'db_busy', ?)").run(Date.now(), Date.now());
      d2.close();
      r = doctor(ok);
      assert.equal(r.status, 2);
      assert.match(r.stdout, /^FAIL {2}Job newsbot\.feeds: failed 5 time\(s\) in a row.*db_busy/m);
      // Loose key permissions: a warning (exit 1 if that's all), fixed only with --fix-permissions.
      const loose = path.join(scratch, 'loose'); fs.cpSync(srv.dir, loose, { recursive: true });
      fs.chmodSync(path.join(loose, 'secret.key'), 0o644);
      r = doctor(loose, { SMTP_HOST: '' });
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /^WARN {2}Key file permissions: Readable by others: secret\.key \(644\)/m);
      assert.equal(fs.statSync(path.join(loose, 'secret.key')).mode & 0o777, 0o644, 'not changed without the flag');
      r = doctor(loose, {}, ['--fix-permissions']);
      assert.match(r.stdout, /^FIXED chmod 600 .*secret\.key \(was 644\): key files are as sensitive as passwords/m);
      assert.equal(fs.statSync(path.join(loose, 'secret.key')).mode & 0o777, 0o600);
      // Proxy and TLS assumptions.
      r = doctor(loose, { PUBLIC_URL: 'http://chat.example.test', TRUST_PROXY: 'bogus/99/x' });
      assert.match(r.stdout, /^WARN {2}PUBLIC_URL: set, but not https/m);
      r = doctor(loose, { HTTPS: 'true', TRUST_PROXY: '2' });
      assert.match(r.stdout, /^WARN {2}TRUST_PROXY: set while Hearth serves HTTPS itself/m);
    } finally { await srv.stop(); }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

// A long-running server's own spawn check: the request logger and jobs don't break normal use (a smoke test of
// sockets, uploads and messages through the access log is covered by the rest of the suite running on this build).
test('server: the access log can be turned down to errors only', async () => {
  const srv = await startServer({ LOG_FORMAT: 'json', LOG_ACCESS: 'errors' });
  try {
    await srv.api('GET', '/health/live', { headers: { 'x-request-id': 'quiet-ok' } });
    await srv.api('GET', '/admin/health', { headers: { 'x-request-id': 'loud-401' } });
    await sleep(100);
    const all = lines(srv.log);
    assert.ok(!all.some((l) => l.reqId === 'quiet-ok'));
    assert.ok(all.some((l) => l.reqId === 'loud-401' && l.status === 401 && l.outcome === 'denied'));
  } finally { await srv.stop(); }
});
void spawn; void newIp;
