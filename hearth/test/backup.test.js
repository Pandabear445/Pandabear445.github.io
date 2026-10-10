// Backups: encrypted, tamper-evident, restore-tested — and a full restore onto a new server really works.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, enable2fa, hex } = require('./helpers');

const ROOT = path.join(__dirname, '..');
let srv; let user; let codes; let backupFile; let key;
const cli = (args, env = {}) => execFileSync(process.execPath, ['server/cli.js', ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const cliFails = (args, env) => { try { cli(args, env); return null; } catch (e) { return String(e.stderr || e.message); } };

before(async () => {
  srv = await startServer();
  user = await srv.register('keeper');
  codes = (await enable2fa(srv, user)).backupCodes;
  srv.sql("INSERT INTO instance_settings (key, value) VALUES ('marker', 'BACKUP-MARKER-123')");
});
after(async () => { await srv.stop(); });

test('only the owner can make, download or see the key of backups', async () => {
  const rando = await srv.register();
  for (const [m, p] of [['POST', '/admin/backups'], ['GET', '/admin/backups/x.hbk'], ['POST', '/admin/backups/key'], ['POST', '/admin/backups/x.hbk/verify']]) {
    assert.equal((await srv.api(m, p, { token: rando.token, ip: rando.ip, body: {} })).status, 403, `${m} ${p}`);
  }
});

test('"Back up now" makes an encrypted backup and restore-tests it', async () => {
  const r = await srv.api('POST', '/admin/backups', { token: srv.owner.token, ip: srv.owner.ip, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.verified.ok, true, JSON.stringify(r.json.verified));
  assert.ok(r.json.verified.users >= 2);
  backupFile = path.join(srv.dir, 'backups', 'encrypted', r.json.name);
  const bytes = fs.readFileSync(backupFile);
  assert.ok(!bytes.includes(Buffer.from('SQLite format')), 'the database inside is encrypted');
  assert.ok(!bytes.includes(Buffer.from('BACKUP-MARKER-123')));
  assert.ok(!bytes.includes(Buffer.from(fs.readFileSync(path.join(srv.dir, 'secret.key'), 'utf8').trim())), 'the server key inside is encrypted');
  key = fs.readFileSync(path.join(srv.dir, 'backup.key'), 'utf8').trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(srv.dir, 'backup.key')).mode & 0o077, 0, 'backup.key is private to its owner');
});

test('the download is the encrypted file; plain database copies can’t be downloaded at all', async () => {
  const name = path.basename(backupFile);
  const r = await srv.api('GET', `/admin/backups/${name}`, { token: srv.owner.token, ip: srv.owner.ip });
  assert.equal(r.status, 200);
  fs.mkdirSync(path.join(srv.dir, 'backups'), { recursive: true });
  fs.copyFileSync(path.join(srv.dir, 'hearth.db'), path.join(srv.dir, 'backups', 'hearth-manual-x.db'));
  assert.equal((await srv.api('GET', '/admin/backups/hearth-manual-x.db', { token: srv.owner.token, ip: srv.owner.ip })).status, 404);
});

test('showing the backup key needs the password again and is logged', async () => {
  assert.equal((await srv.api('POST', '/admin/backups/key', { token: srv.owner.token, ip: srv.owner.ip, body: { authKey: hex(32) } })).status, 401);
  const r = await srv.api('POST', '/admin/backups/key', { token: srv.owner.token, ip: srv.owner.ip, body: { authKey: srv.owner.authKey } });
  assert.equal(r.json.key, key);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM admin_log WHERE action = 'backup_key_viewed'")[0].n, 1);
});

test('a changed byte, a cut-off file, extra bytes or the wrong key are all caught', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hbk-'));
  const orig = fs.readFileSync(backupFile);
  const variants = {
    flipped: (() => { const b = Buffer.from(orig); b[Math.floor(b.length / 2)] ^= 1; return b; })(),
    header: (() => { const b = Buffer.from(orig); b[20] ^= 1; return b; })(),
    cut: orig.subarray(0, orig.length - 100),
    'cut-at-chunk': orig.subarray(0, 10 + 39 + 4 + Math.min(orig.readUInt32BE(49), orig.length - 60)),
    extra: Buffer.concat([orig, Buffer.from('junk')]),
  };
  for (const [name, buf] of Object.entries(variants)) {
    const f = path.join(tmp, `${name}.hbk`); fs.writeFileSync(f, buf);
    assert.ok(cliFails(['verify-backup', f, key]), `${name} should fail`);
  }
  assert.match(cliFails(['verify-backup', backupFile, hex(32)]), /Wrong backup key/);
  assert.match(cli(['verify-backup', backupFile, key]), /Restore test passed/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('full restore onto a new server: accounts, settings and two-factor all come back', async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-restored-'));
  fs.rmSync(target, { recursive: true });
  assert.match(cliFails(['restore', backupFile, srv.dir, key]) || '', /isn't empty/, 'never restores over existing data');
  assert.match(cli(['restore', backupFile, target, key]), /Restored/);
  const restored = await startServerOn(target);
  try {
    // the account signs in with its password plus a backup code — which needs the restored secret.key
    const r = await restored.api('POST', '/auth/login', { body: { username: user.username, authKey: user.authKey, backupCode: codes[5] }, ip: user.ip });
    assert.equal(r.status, 200, r.text);
    assert.equal(restored.sql("SELECT value FROM instance_settings WHERE key = 'marker'")[0].value, 'BACKUP-MARKER-123');
    assert.equal((await restored.api('GET', '/admin/log/verify', { token: r.json.token, ip: user.ip })).status, 403);
  } finally { await restored.stop(); }
});

// Starts Hearth on an existing data folder (the restored one).
async function startServerOn(dir) {
  const { spawn } = require('node:child_process');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'false' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  return {
    api: async (method, p, { token, body, ip } = {}) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip || '198.51.100.9', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
      return { status: r.status, json, text };
    },
    sql: (q) => { const D = require('better-sqlite3'); const d = new D(path.join(dir, 'hearth.db'), { readonly: true }); try { return d.prepare(q).all(); } finally { d.close(); } },
    stop: async () => { child.kill(); await new Promise((r) => setTimeout(r, 300)); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
