// Small admin command line, used by scripts (e.g. setup-turn.sh). Safe to run while Hearth is running.
//   node server/cli.js set-turn "turn:203.0.113.7:3478?transport=udp,turn:203.0.113.7:3478?transport=tcp" SECRET
//   node server/cli.js get-turn
//   node server/cli.js get-turn-secret             (for setting up a relay in another region)
//   node server/cli.js add-turn "turn:198.51.100.9:3478?transport=udp,…" [SECRET]   (adds, keeps the others)
// Encrypted backups (see server/backup.js):
//   node server/cli.js backup                      make one now (restore-tested, copied off-site if configured)
//   node server/cli.js verify-backup FILE [KEY]    restore it into a scratch folder and check the database
//   node server/cli.js restore FILE NEW_DATA_DIR [KEY]
//                                                  unpack it into an empty folder; then point DATA_DIR there (or
//                                                  move it to data/) and start Hearth. KEY = the 64-character backup
//                                                  key, if this machine doesn't have the original data/backup.key.
const path = require('path');
const fs = require('fs');
const os = require('os');

const [cmd, a, b, c] = process.argv.slice(2);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const keyFrom = (hex) => {
  if (hex) { if (!/^[0-9a-f]{64}$/i.test(hex.trim())) throw new Error('The backup key is 64 hex characters.'); return Buffer.from(hex.trim(), 'hex'); }
  return require('./backup').loadKey(DATA_DIR);
};
// The newest database version this code understands. Read from db.js as text: requiring it would open (and upgrade)
// the live database, which verifying or restoring a backup mustn't touch.
const codeSchema = () => Number((/const SCHEMA_VERSION = (\d+);/.exec(fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8')) || [])[1]) || 0;
// A backup from a newer Hearth can't be started with this code (it refuses to run on a newer database).
const newerWarning = (schema) => (codeSchema() && schema > codeSchema()
  ? `Warning: this backup is from a newer version of Hearth (database version ${schema}; this version understands up to ${codeSchema()}). Install that version (or newer) before starting Hearth on it.`
  : '');
const settings = () => {
  const { db } = require('./db');
  return { db, set: (k, v) => db.prepare('INSERT OR REPLACE INTO instance_settings (key, value) VALUES (?, ?)').run(k, v), get: (k) => (db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(k) || {}).value };
};

(async () => {
  if (cmd === 'set-turn' && a && b) { const { set } = settings(); set('turnUrls', a); set('turnSecret', b); console.log('TURN relay saved. Calls use it right away.'); }
  else if (cmd === 'get-turn') { const { get } = settings(); console.log(JSON.stringify({ urls: get('turnUrls') || null, secretSet: !!get('turnSecret') })); }
  else if (cmd === 'get-turn-secret') { const { get } = settings(); if (get('turnSecret')) console.log(get('turnSecret')); else process.exitCode = 1; }
  else if (cmd === 'add-turn' && a) {
    const { get, set } = settings();
    const urls = [...new Set([...(get('turnUrls') || '').split(','), ...a.split(',')].map((x) => x.trim()).filter((u) => /^turns?:/.test(u)))].slice(0, 12);
    set('turnUrls', urls.join(','));
    if (b) set('turnSecret', b);
    console.log(`TURN relays saved (${urls.length / 2 | 0 || urls.length} relay${urls.length > 2 ? 's' : ''}). Calls use them right away.`);
  } else if (cmd === 'backup') {
    const BK = require('./backup');
    const { db, UPLOAD_DIR } = require('./db');
    const out = path.join(DATA_DIR, 'backups', 'encrypted');
    const bk = await BK.createBackup({ db, dataDir: DATA_DIR, uploadDir: UPLOAD_DIR, outDir: out });
    const v = await BK.verifyBackup(bk.file, BK.loadKey(DATA_DIR), path.join(DATA_DIR, 'backups'));
    console.log(`Backup: ${bk.file} (${(bk.size / 1048576).toFixed(1)} MB). Restore test passed: ${v.users} accounts, ${v.messages} messages, ${v.files} files.`);
    const off = await BK.uploadOffsite(bk.file);
    if (!off.skipped) console.log(off.ok ? `Copied off-site to ${off.remote}.` : `Copying off-site FAILED: ${off.error}`);
  } else if (cmd === 'verify-backup' && a) {
    const v = await require('./backup').verifyBackup(path.resolve(a), keyFrom(b), os.tmpdir());
    console.log(`Restore test passed: ${v.users} accounts, ${v.messages} messages, ${v.files} files, database version ${v.schema}${v.hasSecretKey ? '' : ' (no secret.key inside: this server used AT_REST_KEY)'}.`);
    if (newerWarning(v.schema)) console.error(newerWarning(v.schema));
  } else if (cmd === 'restore' && a && b) {
    const BK = require('./backup');
    const entries = await BK.restoreBackup(path.resolve(a), keyFrom(c), path.resolve(b));
    console.log(`Restored ${entries.length} files into ${path.resolve(b)}. Start Hearth with DATA_DIR=${path.resolve(b)} (or move it to data/).`);
    const warn = newerWarning(BK.schemaOf(path.join(path.resolve(b), 'hearth.db')));
    if (warn) { console.error(warn); process.exitCode = 2; }
  } else {
    console.log('Usage: node server/cli.js set-turn <urls> <secret> | add-turn <urls> [secret] | get-turn | get-turn-secret | backup | verify-backup <file> [key] | restore <file> <new-data-dir> [key]');
    process.exitCode = 1;
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
