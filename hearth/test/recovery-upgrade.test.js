// Upgrades, from a real older database: test/fixtures/upgrade-v16-c55a9dc.hfx.gz was made by Hearth 1.27.1 (commit
// c55a9dc, database version 16, the last release before the security overhaul) through its own API, by
// `bash scripts/upgrade-drill.sh --write-fixture c55a9dc`. That script also runs the same checks across real
// checkouts of the old code; this is the fast version. It holds throwaway test accounts and a throwaway secret.key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const UD = require('../scripts/upgrade-drill');
const { schemaOf } = require('../server/backup');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'upgrade-v16-c55a9dc.hfx.gz');
const NEW_SCHEMA = Number(/const SCHEMA_VERSION = (\d+);/.exec(fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8'))[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The old data in a new folder. Its sessions are moved to "just used", so they don't age out of the 60-day idle
// limit as the committed fixture gets older (everything else is exactly as the old version left it).
function oldData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-upgrade-'));
  const state = UD.unpack(FIXTURE, dir);
  const Database = require('better-sqlite3');
  const d = new Database(path.join(dir, 'hearth.db'));
  try {
    assert.equal(d.pragma('user_version', { simple: true }), 16, 'the fixture is a version 16 database');
    const t = Date.now();
    d.prepare('UPDATE sessions SET created_at = ?, last_used_at = ?, expires_at = ? WHERE revoked_at IS NULL').run(t - 60000, t, t + 300 * 86400000);
  } finally { d.close(); }
  return { dir, state };
}
// Runs Hearth on a data folder. Resolves once it answers (or with how it ended, if it exits first).
function run(dir, env = {}) {
  return new Promise((resolve) => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'false', NODE_ENV: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (x) => { log += x; }); child.stderr.on('data', (x) => { log += x; });
    const base = `http://127.0.0.1:${port}`;
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(50); } };
    child.on('exit', (code, signal) => resolve({ exited: true, code, signal, log }));
    (async () => {
      for (let i = 0; i < 200 && child.exitCode === null && child.signalCode === null; i++) {
        try { if ((await fetch(base + '/api/config')).ok) { child.removeAllListeners('exit'); resolve({ base, stop, log: () => log }); return; } } catch { /* starting */ }
        await sleep(100);
      }
    })();
  });
}
const tableExists = (dir, t) => {
  const Database = require('better-sqlite3');
  const d = new Database(path.join(dir, 'hearth.db'), { readonly: true });
  try { return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t); } finally { d.close(); }
};

test('a version 16 database from Hearth 1.27.1 upgrades in place: sign-in, same keys, files, sealed secrets, audit log; twice restarted', async () => {
  const { dir, state } = oldData();
  try {
    assert.equal(fs.existsSync(path.join(dir, 'audit-anchor.json')), false, 'the old version had no audit anchor');
    for (let round = 0; round < 3; round++) {
      const s = await run(dir);
      assert.ok(!s.exited, `Hearth started (round ${round}): ${s.log}`);
      try {
        const facts = await UD.verify({ base: s.base, dataDir: dir, state: { ...state, schema: 16 }, round, expectSchema: NEW_SCHEMA });
        assert.ok(facts.length >= 6);
      } finally { await s.stop(); }
    }
    assert.equal(schemaOf(path.join(dir, 'hearth.db')), NEW_SCHEMA);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an upgrade killed half-way changes nothing (database or audit anchor), and finishes cleanly on the next start', async () => {
  const { dir, state } = oldData();
  try {
    const s = await run(dir, { HEARTH_TEST_KILL_IN_MIGRATION: '1' });
    assert.equal(s.exited, true, 'the upgrade was killed');
    assert.equal(s.signal, 'SIGKILL');
    assert.equal(schemaOf(path.join(dir, 'hearth.db')), 16, 'still the old version');
    assert.equal(tableExists(dir, 'user_key_history'), false, 'none of the new tables were kept');
    assert.equal(fs.existsSync(path.join(dir, 'audit-anchor.json')), false, 'no audit anchor pointing at entries that were rolled back');
    const copies = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith(`hearth-before-v${NEW_SCHEMA}-`) && f.endsWith('.db'));
    assert.equal(copies.length, 1, 'the pre-upgrade copy was made first');
    assert.equal(schemaOf(path.join(dir, 'backups', copies[0])), 16);
    const again = await run(dir);
    assert.ok(!again.exited, again.log);
    try {
      // Regression: the anchor used to be written before the upgrade committed, so after a crash the audit log
      // reported entries "missing" (as if someone had cut them off) on every start from then on.
      await UD.verify({ base: again.base, dataDir: dir, state: { ...state, schema: 16 }, round: 3, expectSchema: NEW_SCHEMA });
    } finally { await again.stop(); }
    assert.equal(tableExists(dir, 'user_key_history'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the crash hook only works in tests: without NODE_ENV=test the same variable does nothing', async () => {
  const { dir, state } = oldData();
  try {
    const s = await run(dir, { HEARTH_TEST_KILL_IN_MIGRATION: '1', NODE_ENV: 'production' });
    assert.ok(!s.exited, `Hearth started and upgraded: ${s.log}`);
    try {
      await UD.verify({ base: s.base, dataDir: dir, state: { ...state, schema: 16 }, round: 4, expectSchema: NEW_SCHEMA });
    } finally { await s.stop(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the upgrade drill refuses a fixture that holds anything but Hearth data files', () => {
  const zlib = require('node:zlib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-upgrade-bad-'));
  const bad = path.join(dir, 'bad.hfx.gz');
  try {
    fs.writeFileSync(bad, zlib.gzipSync(Buffer.concat([Buffer.from(JSON.stringify({ state: {}, files: [{ name: '../escape.js', size: 1 }] }) + '\n'), Buffer.from('x')])));
    assert.throws(() => UD.unpack(bad, path.join(dir, 'out')), /Unexpected file in fixture/);
    assert.equal(fs.existsSync(path.join(dir, 'escape.js')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
