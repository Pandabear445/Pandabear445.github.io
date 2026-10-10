// `node server/cli.js doctor`: checks a Hearth install and says what's wrong, in plain words.
//
// Read-only by default: it reads the database without changing it, never creates folders or files, and never prints a
// secret (only "set" or "not set"). Safe while Hearth is running.
//
//   node server/cli.js doctor                    the checks
//   node server/cli.js doctor --relays           also try to reach each relay region's TURN port
//   node server/cli.js doctor --json             machine-readable output
//   node server/cli.js doctor --fix-permissions  the one repair it can make: key files to 600 and the data folder
//                                                to 700 (owner only). Says what it changes before changing it.
//
// Exit status: 0 everything passed, 1 warnings only, 2 at least one failure.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { diskStatus, diskOf, backupFreshness } = require('./health');

const H = 3600000;
const ago = (t) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
const gb = (b) => `${(b / 1073741824).toFixed(1)} GB`;
const KEY_FILES = ['secret.key', 'backup.key', 'vapid.json', 'key.pem', 'region-backup/id_ed25519'];

// The schema version this code expects, read from db.js as text (requiring it would open and upgrade the database).
const codeSchema = () => Number((/const SCHEMA_VERSION = (\d+);/.exec(fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8')) || [])[1]) || 0;

// Opens the database without changing anything on disk. While Hearth runs (a -wal file exists) a normal read-only
// connection sees the latest data and SQLite's companion files are already there. Otherwise a read-only connection
// would still create them, so a database up to 256 MB is read from an in-memory copy instead (marked as a plain
// rollback-journal file, which an in-memory database needs); a bigger one is opened read-only as usual.
function openReadOnly(file) {
  const Database = require('better-sqlite3');
  if (!fs.existsSync(`${file}-wal`)) {
    // The size check and the read use the same open file.
    const fd = fs.openSync(file, 'r');
    let buf = null;
    try { if (fs.fstatSync(fd).size <= 256 * 1048576) buf = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    if (buf) {
      if (buf.length >= 100 && buf.toString('latin1', 0, 15) === 'SQLite format 3') { buf[18] = 1; buf[19] = 1; }
      return new Database(buf, { readonly: true });
    }
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 3000');
  return db;
}

async function runDoctor({ dataDir, env = process.env, flags = new Set() }) {
  const results = [];
  const add = (status, name, detail) => results.push({ status, name, detail });
  const pass = (n, d) => add('pass', n, d); const warn = (n, d) => add('warn', n, d); const failed = (n, d) => add('fail', n, d);
  const isSet = (k) => !!String(env[k] || '').trim();

  // ---------------------------------------------------------------- versions
  const pkg = require('../package.json');
  pass('Hearth version', pkg.version);
  const major = +process.versions.node.split('.')[0];
  if (major < 20) failed('Node.js', `${process.version}: Hearth needs Node 20 or newer (22 recommended).`);
  else if (major < 22) warn('Node.js', `${process.version}: works, but Node 22 is what Hearth is tested on.`);
  else pass('Node.js', process.version);

  // ---------------------------------------------------------------- data folder
  const dir = path.resolve(dataDir);
  let dirOk = false;
  let st = null;
  try { st = fs.statSync(dir); } catch { /* missing */ }
  if (!st) failed('Data folder', `${dir} doesn't exist. Set DATA_DIR to Hearth's data folder (it's created on first start).`);
  else if (!st.isDirectory()) failed('Data folder', `${dir} isn't a folder.`);
  else {
    dirOk = true;
    let writable = true;
    try { fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); } catch { writable = false; }
    if (!writable) failed('Data folder', `${dir} isn't writable by this user (uid ${process.getuid ? process.getuid() : '?'}). Hearth must own it: chown -R the user Hearth runs as.`);
    else if (process.platform !== 'win32' && (st.mode & 0o007)) warn('Data folder', `${dir} can be read by every user on this machine (mode ${(st.mode & 0o777).toString(8)}). It holds the database and keys: chmod 700 it (or run with --fix-permissions).`);
    else pass('Data folder', `${dir} (writable${process.platform !== 'win32' ? `, mode ${(st.mode & 0o777).toString(8)}` : ''})`);
    const loose = [];
    for (const f of KEY_FILES) {
      try { const s = fs.statSync(path.join(dir, f)); if (process.platform !== 'win32' && (s.mode & 0o077)) loose.push(`${f} (${(s.mode & 0o777).toString(8)})`); } catch { /* not there */ }
    }
    if (loose.length) warn('Key file permissions', `Readable by others: ${loose.join(', ')}. They should be 600 (run with --fix-permissions).`);
    else pass('Key file permissions', 'owner-only');
  }

  // ---------------------------------------------------------------- database (read-only)
  let db = null;
  const dbFile = path.join(dir, 'hearth.db');
  if (dirOk) {
    if (!fs.existsSync(dbFile)) warn('Database', `No database yet (${dbFile}). It's created when Hearth first starts.`);
    else {
      try {
        db = openReadOnly(dbFile);
        const sqlite = db.prepare('SELECT sqlite_version() v').get().v;
        pass('SQLite', sqlite);
        const v = db.pragma('user_version', { simple: true });
        const want = codeSchema();
        const tables = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'").get().n;
        if (!tables) warn('Database schema', 'The database is empty. Hearth sets it up on start.');
        else if (v === want) pass('Database schema', `version ${v} (current)`);
        else if (v < want) warn('Database schema', `version ${v}; this Hearth upgrades it to ${want} on next start (a copy is saved in backups/ first).`);
        else failed('Database schema', `version ${v} is newer than this Hearth understands (${want}). Install the newer version again, or restore the backup made before that upgrade.`);
        if (flags.has('--integrity')) {
          const r = db.pragma('quick_check', { simple: true });
          if (r === 'ok') pass('Database integrity', 'quick_check ok'); else failed('Database integrity', `quick_check: ${String(r).slice(0, 200)}`);
        }
      } catch (e) {
        failed('Database', `Couldn't open ${dbFile} read-only: ${e.code || ''} ${e.message}`.trim());
        try { if (db) db.close(); } catch { /* ignore */ }
        db = null;
      }
    }
  }
  const setting = (k) => { try { return db ? (db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(k) || {}).value : undefined; } catch { return undefined; } };
  const has = (table) => { try { return !!db && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table); } catch { return false; } };

  // ---------------------------------------------------------------- configuration (never the values)
  const publicUrl = String(env.PUBLIC_URL || '').trim();
  const https = String(env.HTTPS || 'true').toLowerCase() !== 'false';
  if (!publicUrl) warn('PUBLIC_URL', 'not set. Password-reset emails need it (the address people use, e.g. https://chat.example.com).');
  else if (!/^https:\/\//i.test(publicUrl)) warn('PUBLIC_URL', 'set, but not https://. Sign-in tokens and encryption need HTTPS; put Hearth behind an HTTPS proxy.');
  else pass('PUBLIC_URL', 'set (https)');
  const secretKeyFile = dirOk && fs.existsSync(path.join(dir, 'secret.key'));
  if (isSet('AT_REST_KEY')) pass('At-rest key', 'AT_REST_KEY is set');
  else if (secretKeyFile) pass('At-rest key', 'data/secret.key present');
  else if (db) failed('At-rest key', 'Neither AT_REST_KEY nor data/secret.key exists, but there is a database: sealed data (2FA secrets, news posts) can’t be opened. Restore secret.key from a backup.');
  else warn('At-rest key', 'not created yet (made on first start)');
  const mailSetting = (() => { try { return JSON.parse(setting('mail') || '{}') || {}; } catch { return {}; } })();
  if (isSet('SMTP_HOST') || mailSetting.host) pass('Email (SMTP)', `set${mailSetting.host ? ' in Admin → Owner' : ' in the environment'}${isSet('SMTP_PASS') || mailSetting.pass ? ', password set' : ', password not set'}`);
  else warn('Email (SMTP)', 'not set. Password resets and owner alerts by email won’t work.');
  pass('ADMIN_USERS', isSet('ADMIN_USERS') ? 'set' : 'not set (the first account owns the server)');
  if (isSet('TURN_USERNAME') && !isSet('TURN_SECRET') && !setting('turnSecret')) warn('TURN', 'static TURN_USERNAME/TURN_CREDENTIAL: everyone shares one password that never expires. Use TURN_SECRET (scripts/setup-turn.sh).');
  else pass('TURN', isSet('TURN_SECRET') || setting('turnSecret') ? 'shared secret set' : 'no relay of its own configured (STUN only, plus any regions)');

  // ---------------------------------------------------------------- TLS and reverse proxy
  let trust;
  try { trust = require('./proxytrust').trustProxySetting(env.TRUST_PROXY); } catch (e) { failed('TRUST_PROXY', `isn't valid: ${e.message}`); }
  if (trust !== undefined) {
    if (https) {
      if (!isSet('SSL_CERT')) warn('TLS', 'HTTPS on with a self-signed certificate (browsers warn). Fine on a LAN; on the internet use a domain with Caddy, or set SSL_CERT/SSL_KEY.');
      else if (!fs.existsSync(env.SSL_CERT) || !fs.existsSync(env.SSL_KEY || '')) failed('TLS', 'SSL_CERT or SSL_KEY points at a file that doesn’t exist.');
      else pass('TLS', 'HTTPS with SSL_CERT/SSL_KEY');
      if (trust && trust !== 'loopback') warn('TRUST_PROXY', 'set while Hearth serves HTTPS itself: with no proxy in front, X-Forwarded-For can only come from visitors, who could then pick their own address.');
      else pass('TRUST_PROXY', trust === 'loopback' ? 'default (this machine only)' : 'off');
    } else {
      if (env.ALLOW_DIRECT_HTTP === 'true') warn('Reverse proxy', 'HTTPS=false and ALLOW_DIRECT_HTTP=true: plain HTTP from the internet is accepted, so tokens can travel unencrypted. Only for testing.');
      else pass('Reverse proxy', 'HTTPS=false: expects an HTTPS proxy (Caddy/nginx) in front; direct plain-HTTP visitors are refused');
      const host = String(env.HOST || '0.0.0.0');
      if (trust === false) warn('TRUST_PROXY', 'off while behind a proxy: every visitor will share the proxy’s address (one rate limit, IP bans hit everyone).');
      else if (typeof trust === 'number') warn('TRUST_PROXY', `trusts ${trust} hop(s) from anywhere. Only safe if nothing can reach port ${env.PORT || 3000} except the proxy${host === '0.0.0.0' ? ' (HOST is 0.0.0.0, so check your firewall)' : ''}.`);
      else pass('TRUST_PROXY', trust === 'loopback' ? 'default (proxy on this machine)' : 'proxy addresses set');
    }
  }

  // ---------------------------------------------------------------- disk
  if (dirOk) {
    const d = diskOf(dir);
    if (!d) warn('Disk space', 'couldn’t be read');
    else {
      const ds = diskStatus(d.free, d.total);
      const text = `${gb(d.free)} free of ${gb(d.total)} (${ds.pct.toFixed(1)}%)`;
      if (ds.status === 'fail') failed('Disk space', `${text}: almost full. Uploads and backups will fail.`);
      else if (ds.status === 'degraded') warn('Disk space', `${text}: getting low.`);
      else pass('Disk space', text);
    }
  }

  // ---------------------------------------------------------------- backups
  if (dirOk) {
    if (isSet('BACKUP_KEY')) pass('Backup key', 'BACKUP_KEY is set (keep a copy outside this server)');
    else if (fs.existsSync(path.join(dir, 'backup.key'))) pass('Backup key', 'data/backup.key present. It is NOT inside backups: keep a copy in a password manager (Admin → Owner → Backups).');
    else warn('Backup key', 'none yet (made with the first encrypted backup).');
    const encDir = path.join(dir, 'backups', 'encrypted');
    let enc = [];
    try { enc = fs.readdirSync(encDir).filter((f) => /^hearth-[\w.-]+\.hbk$/.test(f)).map((f) => ({ name: f, at: fs.statSync(path.join(encDir, f)).mtimeMs })).sort((a, b) => b.at - a.at); } catch { /* none */ }
    let auto = { enabled: true, keep: 7 };
    try { auto = { ...auto, ...JSON.parse(setting('autoBackup') || '{}') }; } catch { /* default */ }
    let status = {};
    try { status = JSON.parse(setting('backupStatus') || '{}').files || {}; } catch { /* none */ }
    const newest = enc[0];
    const verified = newest && status[newest.name] && status[newest.name].verified;
    const f = backupFreshness({ enabled: auto.enabled, newestAt: newest && newest.at, newestVerified: verified });
    const what = newest ? `newest ${newest.name}, ${ago(newest.at)}${verified ? `, restore test ${verified.ok ? 'passed' : 'FAILED'}` : ''}; ${enc.length} kept` : 'no encrypted backups yet';
    const advice = { backups_off: 'Automatic backups are off (Admin → Owner).', restore_test_failed: 'The newest backup failed its restore test: make a new one and check disk space.', no_backup_yet: 'The first one is made within an hour of starting (or run: node server/cli.js backup).', backup_late: 'The daily backup is late.', backup_stale: 'No backup for over two days: check the server log for "backup".' }[f.code];
    (f.status === 'fail' ? failed : f.status === 'degraded' ? warn : pass)('Backups', `${what}.${advice ? ` ${advice}` : ''}`);
    pass('Off-site copies', isSet('BACKUP_RCLONE_REMOTE') ? 'BACKUP_RCLONE_REMOTE is set' : 'not set (backups stay on this machine and any regions)');
  }

  // ---------------------------------------------------------------- relays
  if (db && has('regions')) {
    const rows = db.prepare('SELECT id, name, ip, turn_urls, last_seen FROM regions ORDER BY created_at').all();
    if (!rows.length) pass('Relay regions', 'none');
    for (const r of rows) {
      const alive = r.last_seen && Date.now() - r.last_seen < 3 * 60000;
      if (!r.last_seen) warn(`Region ${r.name}`, 'waiting for its install (no heartbeat yet)');
      else if (!alive) warn(`Region ${r.name}`, `last heartbeat ${ago(r.last_seen)}. (Normal if Hearth is stopped: heartbeats go to the running server.)`);
      else pass(`Region ${r.name}`, `last heartbeat ${ago(r.last_seen)}`);
      if (flags.has('--relays') && r.ip) {
        let urls = [];
        try { urls = JSON.parse(r.turn_urls || '[]'); } catch { /* none */ }
        const port = +((/:(\d+)/.exec(String(urls[0] || '').replace(/^turns?:[^:]+/, '')) || [])[1]) || 3478;
        const ok = await new Promise((resolve) => {
          const s = net.connect({ host: r.ip, port, timeout: 3000 }, () => { s.destroy(); resolve(true); });
          s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); });
        });
        (ok ? pass : failed)(`Region ${r.name} relay`, ok ? `TCP ${r.ip}:${port} reachable` : `TCP ${r.ip}:${port} not reachable from here (firewall, or coturn down)`);
      }
    }
  }

  // ---------------------------------------------------------------- background jobs (as last recorded)
  if (db) {
    if (!has('job_health')) warn('Background jobs', 'no record yet (this database predates job tracking; Hearth adds it on next start).');
    else {
      const rows = db.prepare('SELECT * FROM job_health ORDER BY name').all();
      if (!rows.length) pass('Background jobs', 'no runs recorded yet');
      const failing = rows.filter((r) => r.failures > 0);
      for (const r of failing) (r.failures >= 3 ? failed : warn)(`Job ${r.name}`, `failed ${r.failures} time(s) in a row, last ${ago(r.last_error_at)} (${r.last_error_category || 'error'}): ${String(r.last_error || '').slice(0, 160)}`);
      if (rows.length && !failing.length) {
        const newest = Math.max(...rows.map((r) => r.updated_at || 0));
        pass('Background jobs', `${rows.length} jobs, none failing (last record ${ago(newest)})`);
      }
    }
  }
  if (db) db.close();

  // ---------------------------------------------------------------- repairs (only when asked)
  const repairs = [];
  if (flags.has('--fix-permissions') && dirOk && process.platform !== 'win32') {
    const fix = (p, mode, why) => {
      try { const m = fs.statSync(p).mode & 0o777; if (m !== mode) { fs.chmodSync(p, mode); repairs.push(`chmod ${mode.toString(8)} ${p} (was ${m.toString(8)}): ${why}`); } } catch { /* not there */ }
    };
    fix(dir, 0o700, 'only the account Hearth runs as needs the data folder');
    for (const f of KEY_FILES) fix(path.join(dir, f), 0o600, 'key files are as sensitive as passwords');
  }

  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  return { results, repairs, fails, warns, exitCode: fails ? 2 : warns ? 1 : 0 };
}

function printReport(r, out = process.stdout) {
  const tag = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  for (const x of r.results) out.write(`${tag[x.status]}  ${x.name}: ${x.detail}\n`);
  for (const x of r.repairs) out.write(`FIXED ${x}\n`);
  out.write(`\n${r.fails ? `${r.fails} problem(s) to fix` : r.warns ? 'No failures' : 'All good'}${r.warns ? `, ${r.warns} warning(s)` : ''}.\n`);
}

module.exports = { runDoctor, printReport };
