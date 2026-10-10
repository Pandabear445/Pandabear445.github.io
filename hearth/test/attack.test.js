// The automated attacker. Every API route is found by reading the server's source (so new routes are covered
// automatically), then called:
//   - with no sign-in, an expired sign-in, and a revoked one
//   - with someone else's ids, made-up ids, and ids that try path traversal or SQL
//   - with missing, extra, huge, mistyped, malformed, HTML/script and "prototype pollution" bodies
//   - many times, and many at once
// The rules: never a server error (5xx), never a hang, never a success without the right to it, and the
// server is still healthy and still saying no afterwards.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer, hex, newIp } = require('./helpers');

const SERVER_DIR = path.join(__dirname, '..', 'server');
// Routes anyone may call without signing in (and what they're for).
const PUBLIC = new Set([
  'GET /config', 'GET /auth/params', 'POST /auth/register', 'POST /auth/login', 'POST /auth/forgot', 'POST /auth/reset/info', 'POST /auth/reset',
  'GET /captcha', 'GET /terms', 'GET /push/key', 'POST /pay/kofi', 'POST /pay/stripe', 'POST /pay/memberships', 'POST /regions/:id/heartbeat',
]);
function routes() {
  const out = [];
  for (const f of fs.readdirSync(SERVER_DIR).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(SERVER_DIR, f), 'utf8');
    for (const m of src.matchAll(/\bapi\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) out.push({ method: m[1].toUpperCase(), path: m[2], file: f });
  }
  return out;
}

let srv; let victim; let attacker; let victimServer; let victimDm; let victimMsg;
const problems = [];
const record = (what, r) => { if (r.status >= 500 || r.status === 0) problems.push(`${what} → ${r.status} ${String(r.text).slice(0, 120)}`); };

before(async () => {
  srv = await startServer();
  victim = await srv.register('victim'); attacker = await srv.register('mallory');
  const helper = await srv.register('helper');
  victimServer = (await srv.api('POST', '/servers', { token: victim.token, ip: victim.ip, body: { name: 'private' } })).json;
  // victim and helper share a server so they can DM; the attacker is in neither
  const { code } = (await srv.api('POST', `/servers/${victimServer.id}/invites`, { token: victim.token, ip: victim.ip, body: {} })).json;
  await srv.api('POST', `/invites/${code}/join`, { token: helper.token, ip: helper.ip });
  victimDm = (await srv.api('POST', '/dms', { token: victim.token, ip: victim.ip, body: { userId: helper.id } })).json;
  victimMsg = (await srv.api('POST', `/dms/${victimDm.id}/messages`, { token: victim.token, ip: victim.ip, body: { ciphertext: 'v2:' + crypto.randomBytes(40).toString('base64') } })).json.id;
});
after(async () => {
  if (problems.length) console.log(problems.join('\n'));
  await srv.stop();
});

const fill = (p, v) => p.replace(/:(\w+)/g, () => encodeURIComponent(v));
// Ids an attacker would try: the victim's real ones, made-up ones, traversal and injection strings.
const idVariants = () => [victim.id, victimServer.id, victimDm.id, victimMsg, 'x' + hex(6), '../../../etc/passwd', '..%2f..%2fhearth.db', "1' OR '1'='1", '<img src=x onerror=alert(1)>', 'A'.repeat(3000), '%00', 'constructor', '__proto__'];
const FIELDS = ['name', 'username', 'email', 'code', 'token', 'authKey', 'ciphertext', 'content', 'userId', 'roleIds', 'permissions', 'text', 'url', 'query', 'kind',
  'channelId', 'epoch', 'wraps', 'pubs', 'emoji', 'reason', 'hours', 'role', 'mode', 'files', 'threadId', 'replyTo', 'totp', 'backupCode', 'confirm', 'description',
  'theme', 'profile', 'status', 'keywords', 'type', 'position', 'ids', 'maxUses', 'login', 'keepKeys', 'publicKey', 'encPrivateKey', 'signPublicKey', 'options', 'choice'];
const bodies = () => {
  const typed = (v) => Object.fromEntries(FIELDS.map((f) => [f, v]));
  return [
    { raw: '{"broken": ' }, { raw: 'null' }, { raw: '[]' }, { raw: '"text"' }, { raw: '12345' }, { raw: '\u0000\u0001' },
    { body: {} },
    { body: typed('x'.repeat(200000)) },
    { body: typed(['a', { b: 1 }]) }, { body: typed({ $gt: '', $ne: null }) }, { body: typed(123456789012345) }, { body: typed(true) }, { body: typed(null) }, { body: typed(-1) },
    { body: typed("'; DROP TABLE users; --") }, { body: typed('<script>alert(1)</script>') }, { body: typed('../../../../etc/passwd') }, { body: typed('‮😀\u0000') },
    { raw: '{"__proto__": {"admin": true, "isAdmin": true, "role": "owner"}, "constructor": {"prototype": {"admin": true}}}' },
    { raw: '['.repeat(5000) + ']'.repeat(5000) },
    { body: { ...typed('ok'), extra: 'field', isAdmin: true, owner_id: attacker.id, user_id: victim.id, author_id: victim.id } },
  ];
};

test('the route list was found', () => {
  const r = routes();
  assert.ok(r.length > 150, `${r.length} routes`);
});

test('without signing in, only public routes answer — and nothing errors', async () => {
  const open = [];
  for (const r of routes()) {
    const key = `${r.method} ${r.path}`;
    for (const id of [victim.id, 'x' + hex(4)]) {
      const res = await srv.api(r.method, fill(r.path, id), { body: {}, ip: newIp() });
      record(`anon ${key}`, res);
      if (res.status >= 200 && res.status < 300 && !PUBLIC.has(key)) open.push(`${key} (${res.status})`);
    }
  }
  assert.deepEqual(open, [], 'routes that answered without a sign-in');
  assert.deepEqual(problems, []);
});

test('expired and revoked sessions are refused everywhere', async () => {
  const u = await srv.register();
  const expired = (await srv.login(u)).json.token;
  srv.sql('UPDATE sessions SET expires_at = 1 WHERE token_hash = ?', crypto.createHash('sha256').update(expired).digest('hex'));
  const revoked = (await srv.login(u)).json.token;
  await srv.api('POST', '/auth/logout', { token: revoked, ip: u.ip });
  for (const r of routes().filter((x) => !PUBLIC.has(`${x.method} ${x.path}`))) {
    for (const token of [expired, revoked]) {
      const res = await srv.api(r.method, fill(r.path, u.id), { token, body: {}, ip: u.ip });
      record(`stale ${r.method} ${r.path}`, res);
      assert.equal(res.status, 401, `${r.method} ${r.path} with a dead session → ${res.status}`);
    }
  }
});

test("someone else's ids: no route hands the attacker the victim's data", async () => {
  const leaks = [];
  for (const r of routes().filter((x) => x.path.includes(':'))) {
    for (const id of [victim.id, victimServer.id, victimDm.id, victimMsg]) {
      const res = await srv.api(r.method, fill(r.path, id), { token: attacker.token, body: {}, ip: attacker.ip });
      record(`idor ${r.method} ${r.path}`, res);
      if (res.status >= 200 && res.status < 300 && res.text.includes(victimMsg) && !r.path.startsWith('/users/')) leaks.push(`${r.method} ${r.path} (${id})`);
    }
  }
  assert.deepEqual(leaks, []);
  // spot checks on the obvious ones
  assert.notEqual((await srv.api('GET', `/dms/${victimDm.id}/messages`, { token: attacker.token, ip: attacker.ip })).status, 200);
  assert.notEqual((await srv.api('GET', `/servers/${victimServer.id}/keys`, { token: attacker.token, ip: attacker.ip })).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM dm_messages WHERE id = ?', victimMsg)[0].n, 1, 'still there');
});

test('garbage in: malformed, huge, mistyped and hostile input never causes a server error', async () => {
  const fuzz = await srv.register();
  const relogin = async () => { fuzz.token = (await srv.login(fuzz)).json.token; };
  let n = 0;
  for (const r of routes()) {
    if (['/auth/logout', '/me/sessions/revoke-others'].includes(r.path) || (r.method === 'DELETE' && r.path === '/me')) continue;
    const ids = r.path.includes(':') ? idVariants() : [''];
    for (const id of ids) {
      for (const b of r.path.includes(':') && id !== ids[0] ? [{ body: {} }] : bodies()) {
        const res = await srv.api(r.method, fill(r.path, id), { token: fuzz.token, ip: newIp(), ...b, timeout: 20000 }).catch((e) => ({ status: 0, text: String(e) }));
        n++;
        record(`fuzz ${r.method} ${r.path} id=${String(id).slice(0, 20)} ${JSON.stringify(b).slice(0, 60)}`, res);
        if (res.status === 401 && res.json && res.json.code === 'signed_out') await relogin();
      }
    }
  }
  assert.ok(n > 2000, `${n} requests`);
  assert.deepEqual(problems, [], 'server errors or hangs');
});

test('path traversal on file routes never reaches the database, the source or settings', async () => {
  const tries = ['/uploads/..%2f..%2fhearth.db', '/uploads/%2e%2e/%2e%2e/data/hearth.db', '/uploads/..%5c..%5chearth.db', '/updates/..%2f..%2f.env', '/updates/..%2fpackage.json',
    '/downloads/..%2fhearth.db', '/downloads/%2e%2e%2fsecret.key', '/media/game/..%2f..%2fserver%2findex.js', '/vendor/..%2f..%2fserver%2findex.js', '/..%2fserver%2findex.js',
    '/%2e%2e/%2e%2e/etc/passwd', '/uploads/%00.png', '/js/..%2f..%2fserver%2fdb.js', '/api/admin/backups/..%2f..%2fhearth.db', '/api/admin/backups/../../secret.key'];
  for (const p of tries) {
    const r = await srv.call('GET', p, { token: srv.owner.token, ip: newIp() });
    record(`traversal ${p}`, r);
    assert.ok(!r.text.includes('SQLite format'), `${p} returned the database`);
    assert.ok(!/require\(['"]|module\.exports/.test(r.text), `${p} returned server source`);
    assert.ok(!/root:x:0:0|"dependencies"/.test(r.text), `${p} returned a system or project file`);
  }
  assert.deepEqual(problems, []);
});

test('repeated and concurrent requests: limits kick in, nothing breaks', async () => {
  const u = await srv.register();
  const burst = await Promise.all(Array.from({ length: 80 }, (_, i) => srv.api('POST', `/dms/${victimDm.id}/messages`, { token: u.token, ip: u.ip, body: { ciphertext: 'v2:' + hex(30) + i } })));
  burst.forEach((r) => record('burst', r));
  assert.ok(burst.every((r) => [403, 404, 429].includes(r.status)));
  const mixed = await Promise.all(Array.from({ length: 120 }, (_, i) => srv.api(['GET', 'POST'][i % 2], ['/bootstrap', '/auth/login', '/me/sessions', '/people?q=%27%20OR%201%3D1--'][i % 4], { token: u.token, ip: newIp(), body: { username: u.username, authKey: hex(32) } })));
  mixed.forEach((r) => record('mixed', r));
  assert.deepEqual(problems, []);
});

test('afterwards the server is healthy and still says no', async () => {
  assert.equal(srv.child.exitCode, null, 'still running');
  assert.equal((await srv.api('GET', '/config')).status, 200);
  assert.equal((await srv.api('GET', '/admin/stats', { token: attacker.token, ip: attacker.ip })).status, 403);
  assert.equal((await srv.api('GET', `/dms/${victimDm.id}/messages`, { token: victim.token, ip: victim.ip })).status, 200);
  // the attacker's "prototype pollution" bodies didn't make anyone staff
  assert.equal(srv.sql("SELECT value FROM instance_settings WHERE key = 'staffRoles'").map((r) => r.value).join('').includes(attacker.id), false);
  const crashes = (srv.log.match(/^\s+at /gm) || []).length;
  assert.equal(crashes, 0, `stack traces in the server log:\n${srv.log.slice(-3000)}`);
});
