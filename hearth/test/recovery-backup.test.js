// Backup and restore when things go wrong: files missing at backup time, damaged or cut-off backup files, a restore
// that's killed half-way, a disk that fills up mid-backup, a backup from a newer Hearth, and restoring after a
// break-in. Each one must fail cleanly and visibly (or succeed and say what's missing), never half-work quietly.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { startServer, hex } = require('./helpers');

const ROOT = path.join(__dirname, '..');
let srv; let user; let key; let tmp; let hooks;
// The command line, run as an operator would (optionally with a preloaded fault-injection hook).
const cli = (args, { env = {}, hook } = {}) => {
  const r = spawnSync(process.execPath, [...(hook ? ['-r', hook] : []), 'server/cli.js', ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR: srv.dir, ...env }, encoding: 'utf8' });
  return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr };
};
async function upload(u, bytes) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), 'blob.bin');
  const r = await fetch(`${srv.base}/api/upload/encrypted`, { method: 'POST', headers: { authorization: `Bearer ${u.token}`, 'x-forwarded-for': u.ip }, body: fd });
  assert.equal(r.status, 200, await r.clone().text());
  return path.basename((await r.json()).url);
}
const encFiles = () => { const d = path.join(srv.dir, 'backups', 'encrypted'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const newestBackup = () => path.join(srv.dir, 'backups', 'encrypted', encFiles().filter((f) => f.endsWith('.hbk')).sort().pop());
const target = (name) => path.join(tmp, name);
// Starts Hearth on an existing data folder; resolves with its output once it's up, or rejects with it if it exits.
function startOn(dir) {
  return new Promise((resolve, reject) => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'false', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    child.on('exit', () => reject(Object.assign(new Error('exited'), { log })));
    const poll = async () => {
      for (let i = 0; i < 150 && child.exitCode === null; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/api/config`)).ok) { resolve({ child, port, log: () => log, stop: () => new Promise((r) => { child.removeAllListeners('exit'); child.once('exit', r); child.kill(); }) }); return; } } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    poll();
  });
}

before(async () => {
  srv = await startServer();
  user = await srv.register('filer');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-recovery-bk-'));
  hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-recovery-hooks-'));
  // Fault injection, preloaded into the CLI or the server with -r / NODE_OPTIONS (never part of Hearth itself).
  // Disk full: writes to a backup's .part file fail with ENOSPC after 64 KB, while the flag file exists.
  fs.writeFileSync(path.join(hooks, 'enospc.js'), `
const fs = require('fs');
const flag = process.env.HOOK_FLAG;
const open = fs.promises.open;
fs.promises.open = async function (p, ...rest) {
  const fh = await open.call(fs.promises, p, ...rest);
  if (String(p).endsWith('.hbk.part') && (!flag || fs.existsSync(flag))) {
    let n = 0; const write = fh.write.bind(fh);
    fh.write = async (buf, ...a) => { n += buf.length; if (n > 65536) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); return write(buf, ...a); };
  }
  return fh;
};`);
  // Killed half-way through a restore: the process dies (SIGKILL, no clean-up) when it starts writing an upload.
  fs.writeFileSync(path.join(hooks, 'kill-in-restore.js'), `
const fs = require('fs');
const open = fs.promises.open;
fs.promises.open = async function (p, flags, ...rest) {
  if (flags === 'w' && /[\\\\/]uploads[\\\\/]/.test(String(p))) process.kill(process.pid, 'SIGKILL');
  return open.call(fs.promises, p, flags, ...rest);
};`);
});
after(async () => { await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(hooks, { recursive: true, force: true }); });

test('a backup with every file present restores with a clean file report; check-files agrees', async () => {
  await upload(user, crypto.randomBytes(3000));
  const r = cli(['backup']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Restore test passed/);
  assert.doesNotMatch(r.err, /Warning/);
  key = fs.readFileSync(path.join(srv.dir, 'backup.key'), 'utf8').trim();
  const res = cli(['restore', newestBackup(), target('clean'), key]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /Files: \d+ the database refers to/);
  assert.doesNotMatch(res.err, /refers to/);
  assert.ok(!fs.existsSync(path.join(target('clean'), 'RESTORE-INCOMPLETE')), 'the marker is gone once the restore is complete');
  assert.deepEqual(fs.readdirSync(target('clean')).filter((f) => /-(wal|shm)$/.test(f)), [], 'nothing left open');
  const chk = cli(['check-files'], { env: { DATA_DIR: target('clean') } });
  assert.equal(chk.code, 0, chk.err);
});

test('an upload missing at backup time: the backup is still made, and the gap is reported everywhere', async () => {
  const lost = await upload(user, crypto.randomBytes(2000));
  const kept = await upload(user, crypto.randomBytes(2000));
  fs.rmSync(path.join(srv.dir, 'uploads', lost)); // lost from the disk (say, deleted by hand)
  // The command line: made and restore-tested, but exit code 3 and the file named.
  const r = cli(['backup']);
  assert.equal(r.code, 3, r.err);
  assert.match(r.out, /Restore test passed/);
  assert.match(r.err, new RegExp(`1 file the database refers to were not on disk.*${lost}`));
  // "Back up now" in the app: made, the response names it, and the audit log records it.
  const a = await srv.api('POST', '/admin/backups', { token: srv.owner.token, ip: srv.owner.ip, body: {} });
  assert.equal(a.status, 200, a.text);
  assert.deepEqual(a.json.missing, [lost]);
  assert.equal(a.json.verified.ok, true);
  assert.match(srv.sql("SELECT detail FROM admin_log WHERE action = 'backup_files_missing' ORDER BY id DESC LIMIT 1")[0].detail, new RegExp(lost));
  assert.match(srv.sql("SELECT detail FROM admin_log WHERE action = 'backup_made' ORDER BY id DESC LIMIT 1")[0].detail, /1 file\(s\) missing/);
  // Restoring it: the database/file mismatch is reported (exit 3), the rest is complete and starts.
  const res = cli(['restore', newestBackup(), target('gap'), key]);
  assert.equal(res.code, 3, res.err);
  assert.match(res.err, new RegExp(`1 file the database refers to are not in this backup: ${lost}`));
  assert.ok(fs.existsSync(path.join(target('gap'), 'uploads', kept)));
  assert.ok(!fs.existsSync(path.join(target('gap'), 'RESTORE-INCOMPLETE')));
  const chk = cli(['check-files'], { env: { DATA_DIR: target('gap') } });
  assert.equal(chk.code, 3);
  assert.match(chk.err, new RegExp(lost));
  const s = await startOn(target('gap'));
  await s.stop();
  srv.sql('DELETE FROM blobs WHERE name = ?', lost); // so later backups are clean again
  srv.sql('DELETE FROM user_files WHERE name = ?', lost);
});

test('damaged backups (bit flips anywhere, cut off anywhere, extra bytes) are caught by verify and restore', async () => {
  await upload(user, crypto.randomBytes(1536 * 1024)); // more than one 1 MiB chunk
  const r = cli(['backup']);
  assert.equal(r.code, 0, r.err);
  const orig = fs.readFileSync(newestBackup());
  const hdr = 10 + 39; const len1 = orig.readUInt32BE(hdr);
  const flip = (at) => { const b = Buffer.from(orig); b[at] ^= 0x10; return b; };
  const variants = {
    'magic': flip(0), 'salt': flip(15), 'nonce prefix': flip(hdr - 2), 'length field': flip(hdr + 1),
    'first chunk': flip(hdr + 4 + 100), 'first chunk tag': flip(hdr + 4 + len1 - 1), 'last byte': flip(orig.length - 1), 'middle': flip(Math.floor(orig.length / 2)),
    'cut in the header': orig.subarray(0, 30), 'cut in a length field': orig.subarray(0, hdr + 2), 'cut mid-chunk': orig.subarray(0, hdr + 4 + Math.floor(len1 / 2)),
    'cut at a chunk boundary': orig.subarray(0, hdr + 4 + len1), 'last 16 bytes cut': orig.subarray(0, orig.length - 16), 'extra bytes': Buffer.concat([orig, Buffer.from([0, 0, 0, 0])]),
    'empty': Buffer.alloc(0),
  };
  assert.ok(orig.length > hdr + 4 + len1, 'the backup has more than one chunk (so cutting at a boundary is a real test)');
  for (const [name, buf] of Object.entries(variants)) {
    const f = path.join(tmp, `bad-${name.replace(/\W+/g, '-')}.hbk`);
    fs.writeFileSync(f, buf);
    const v = cli(['verify-backup', f, key]);
    assert.equal(v.code, 1, `verify should fail: ${name}`);
    assert.doesNotMatch(v.out, /passed/, name);
    const dir = target(`bad-${name.replace(/\W+/g, '-')}`);
    const res = cli(['restore', f, dir, key]);
    assert.equal(res.code, 1, `restore should fail: ${name}`);
    assert.match(res.err, /damaged|changed|cut off|incomplete|Not a Hearth backup|Wrong backup key|Unexpected/, name);
    // Nothing half-restored is left, only the marker saying why, so Hearth won't start on it.
    assert.deepEqual(fs.readdirSync(dir), ['RESTORE-INCOMPLETE'], name);
    assert.match(fs.readFileSync(path.join(dir, 'RESTORE-INCOMPLETE'), 'utf8'), /The restore stopped: /, name);
  }
  // The original still verifies (the damage was all in the copies).
  assert.equal(cli(['verify-backup', newestBackup(), key]).code, 0);
});

test('a lost backup key: no restore, no matter what (and nothing usable is left in the folder)', () => {
  const res = cli(['restore', newestBackup(), target('wrong-key'), hex(32)]);
  assert.equal(res.code, 1);
  assert.match(res.err, /Wrong backup key/);
  assert.deepEqual(fs.readdirSync(target('wrong-key')), ['RESTORE-INCOMPLETE']);
  assert.match(cli(['restore', newestBackup(), target('bad-key'), 'not-a-key']).err, /64 hex characters/);
});

test('a restore killed half-way leaves a folder Hearth refuses to start on, and says what to do', async () => {
  const dir = target('killed');
  const res = cli(['restore', newestBackup(), dir, key], { hook: path.join(hooks, 'kill-in-restore.js') });
  assert.equal(res.signal, 'SIGKILL', 'the restore really was killed mid-way');
  assert.ok(fs.existsSync(path.join(dir, 'hearth.db')), 'the database was already written: on its own it would look fine');
  assert.ok(fs.existsSync(path.join(dir, 'RESTORE-INCOMPLETE')));
  // Hearth refuses to run on it, and changes nothing.
  const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'hearth.db'))).digest('hex');
  const err = await startOn(dir).then((s) => s.stop().then(() => null), (e) => e);
  assert.ok(err, 'Hearth must not start on a half-restored folder');
  assert.match(err.log, /holds a restore that didn't finish/);
  assert.match(err.log, /restore the backup again into a new, empty one/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'hearth.db'))).digest('hex'), before);
  // The command line tools refuse it too (they'd open the database).
  assert.match(cli(['get-turn'], { env: { DATA_DIR: dir } }).err, /restore that didn't finish/);
  // Restoring again on top of it is refused; into a new folder it works.
  const again = cli(['restore', newestBackup(), dir, key]);
  assert.equal(again.code, 1);
  assert.match(again.err, /earlier restore that didn't finish/);
  assert.equal(cli(['restore', newestBackup(), target('after-kill'), key]).code, 0);
  const s = await startOn(target('after-kill'));
  await s.stop();
});

test('restoring into a folder that is not empty (a live data folder, a finished restore) is refused, untouched', () => {
  for (const dir of [srv.dir, target('clean')]) {
    const list = fs.readdirSync(dir).sort();
    const res = cli(['restore', newestBackup(), dir, key]);
    assert.equal(res.code, 1);
    assert.match(res.err, /isn't empty/);
    assert.deepEqual(fs.readdirSync(dir).sort(), list, 'nothing added or removed');
  }
});

test('disk full during a command-line backup: a clear failure, no .part or snapshot left, never called a success', () => {
  const before = encFiles();
  const r = cli(['backup'], { hook: path.join(hooks, 'enospc.js') });
  assert.equal(r.code, 1);
  assert.match(r.err, /Backup FAILED, nothing was saved: the disk is full/);
  assert.doesNotMatch(r.out, /Backup:|Restore test passed/);
  assert.deepEqual(encFiles(), before, 'no new .hbk and no .part');
  assert.deepEqual(fs.readdirSync(path.join(srv.dir, 'backups', '.tmp')), [], 'no plaintext snapshot left');
});

test('disk full during "Back up now": the app gets a clear error, it is audited, nothing is left behind', async () => {
  const flag = path.join(hooks, 'disk-full');
  await srv.restart({ NODE_OPTIONS: `-r ${path.join(hooks, 'enospc.js')}`, HOOK_FLAG: flag });
  try {
    const before = encFiles();
    fs.writeFileSync(flag, '');
    const r = await srv.api('POST', '/admin/backups', { token: srv.owner.token, ip: srv.owner.ip, body: {} });
    assert.equal(r.status, 500);
    assert.equal(r.json.code, 'backup_failed');
    assert.match(r.json.error, /disk is full\. Nothing was saved/);
    assert.deepEqual(encFiles(), before);
    assert.match(srv.sql("SELECT detail FROM admin_log WHERE action = 'backup_failed' ORDER BY id DESC LIMIT 1")[0].detail, /ENOSPC/);
    // Space freed: the next one works.
    fs.rmSync(flag);
    const ok = await srv.api('POST', '/admin/backups', { token: srv.owner.token, ip: srv.owner.ip, body: {} });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.verified.ok, true);
  } finally { fs.rmSync(flag, { force: true }); await srv.restart({ NODE_OPTIONS: '', HOOK_FLAG: '' }); }
});

test('a backup from a newer Hearth is refused by restore, with a clear message and nothing restored', async () => {
  const d = srv.db(); const v = d.pragma('user_version', { simple: true }); d.close();
  srv.sql('PRAGMA user_version = 99');
  try {
    const r = await srv.api('POST', '/admin/backups', { token: srv.owner.token, ip: srv.owner.ip, body: {} });
    assert.equal(r.status, 200, r.text);
  } finally { srv.sql(`PRAGMA user_version = ${v}`); }
  const dir = target('newer');
  const res = cli(['restore', newestBackup(), dir, key]);
  assert.equal(res.code, 2);
  assert.match(res.err, /from a newer version of Hearth \(database version 99; this version understands up to \d+\)\. Nothing was restored/);
  assert.doesNotMatch(res.out, /Restored/);
  assert.deepEqual(fs.readdirSync(dir), ['RESTORE-INCOMPLETE'], 'no database, no keys, no files');
  const err = await startOn(dir).then((s) => s.stop().then(() => null), (e) => e);
  assert.ok(err && /restore that didn't finish/.test(err.log), 'and Hearth won’t start on the empty folder as if it were new');
});

test('sessions after a restore: kept as they were at backup time, or all ended with --sign-out-everyone', async () => {
  const keep = (await srv.login(user)).json.token; // live when the backup is made
  const gone = (await srv.login(user)).json.token;
  assert.equal((await srv.api('POST', '/auth/logout', { token: gone, ip: user.ip })).status, 200); // revoked before it
  assert.equal(cli(['backup']).code, 0);
  const later = (await srv.login(user)).json.token; // made after the backup: not in it
  const file = newestBackup();
  const check = async (dir, flags = []) => {
    const res = cli(['restore', file, dir, key, ...flags]);
    assert.equal(res.code, 0, res.err);
    const s = await startOn(dir);
    try {
      const st = async (t) => (await fetch(`http://127.0.0.1:${s.port}/api/me/sessions`, { headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': user.ip } })).status;
      const login = await fetch(`http://127.0.0.1:${s.port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': user.ip }, body: JSON.stringify({ username: user.username, authKey: user.authKey }) });
      return { keep: await st(keep), gone: await st(gone), later: await st(later), login: login.status, out: res.out };
    } finally { await s.stop(); }
  };
  const plain = await check(target('sessions-kept'));
  assert.deepEqual([plain.keep, plain.gone, plain.later, plain.login], [200, 401, 401, 200]);
  assert.match(plain.out, /Everyone stays signed in as they were when the backup was made/);
  const out = await check(target('sessions-ended'), ['--sign-out-everyone']);
  assert.deepEqual([out.keep, out.gone, out.later, out.login], [401, 401, 401, 200], 'only a fresh sign-in works');
  assert.match(out.out, /Signed out \d+ sessions?/);
});
