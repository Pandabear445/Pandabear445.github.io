// Small admin command line, used by scripts (e.g. setup-turn.sh). Safe to run while Hearth is running.
//   node server/cli.js set-turn "turn:203.0.113.7:3478?transport=udp,turn:203.0.113.7:3478?transport=tcp" SECRET
//   node server/cli.js get-turn
//   node server/cli.js get-turn-secret             (for setting up a relay in another region)
//   node server/cli.js add-turn "turn:198.51.100.9:3478?transport=udp,…" [SECRET]   (adds, keeps the others)
//   node server/cli.js set-owner USERNAME          make this account the instance owner (when the owner's account
//                                                  is lost; in the app the owner hands it over in Team & roles)
// Encrypted backups (see server/backup.js):
//   node server/cli.js backup                      make one now (restore-tested, copied off-site if configured)
//   node server/cli.js verify-backup FILE [KEY]    restore it into a scratch folder and check the database
//   node server/cli.js restore FILE NEW_DATA_DIR [KEY] [--sign-out-everyone]
//                                                  unpack it into an empty folder; then point DATA_DIR there (or
//                                                  move it to data/) and start Hearth. KEY = the 64-character backup
//                                                  key, if this machine doesn't have the original data/backup.key.
//                                                  --sign-out-everyone ends every session in the restored copy (use
//                                                  it after a break-in; see docs/RECOVERY.md).
//   node server/cli.js check-files                 compare the database with data/uploads: files it needs that
//                                                  are missing, and files nothing refers to
// Exit codes: 0 done; 1 failed; 2 restore refused (backup from a newer Hearth); 3 done, but files are missing.
const path = require('path');
const fs = require('fs');
const os = require('os');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((x) => x.startsWith('--')));
const [cmd, a, b, c] = argv.filter((x) => !x.startsWith('--'));
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
// Files the database refers to but that aren't there: those attachments and pictures can't be opened.
const missingNote = (n, names, what) => `Warning: ${n} file${n === 1 ? '' : 's'} the database refers to ${what}: ${names.slice(0, 10).join(', ')}${n > 10 ? ', …' : ''}. Those attachments or pictures will show as unavailable.`;
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
  } else if (cmd === 'set-owner' && a) {
    const { db, get, set } = settings();
    const r = db.prepare('SELECT id, username, suspended_at, suspended_until FROM users WHERE lower(username) = ? AND deleted_at IS NULL AND is_bot = 0').get(a.trim().replace(/^@/, '').toLowerCase());
    if (!r) throw new Error(`There's no account called ${a} that can sign in.`);
    // Like a handover in the app: a suspended owner couldn't sign in, and nobody outranks the owner to lift it.
    if (r.suspended_at && (!r.suspended_until || r.suspended_until > Date.now())) throw new Error(`${r.username} is suspended, so they couldn't use the server. Pick an account that isn't (it can lift the suspension in Admin \u2192 Users).`);
    const before = get('owner');
    set('owner', r.id);
    db.prepare("DELETE FROM instance_settings WHERE key = 'ownerAwaitsEnv'").run(); // settled: no ADMIN_USERS sign-up takes it later
    // The owner needs no other staff role (as in the app's handover). Older versions kept a plain list of admins.
    let roles = null;
    try { roles = JSON.parse(get('staffRoles') || 'null'); } catch { /* rebuilt below */ }
    if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
      roles = {};
      try { (JSON.parse(get('admins') || '[]') || []).forEach((id) => { roles[id] = 'admin'; }); } catch { /* none */ }
    }
    if (roles[r.id]) { delete roles[r.id]; set('staffRoles', JSON.stringify(roles)); }
    // On the audit log like an in-app handover (append-only, keyed hash chain and anchor; see auditAppend in db.js).
    require('./db').auditAppend({ admin_id: null, action: 'ownership_set_cli', target: r.id, detail: r.username, ip: null });
    console.log(`${r.username} owns this server now (they see it after reloading the app).${before && before !== r.id ? ' The previous owner is no longer staff unless they had a role besides owner: check Admin → Team & roles.' : ''}`);
  } else if (cmd === 'backup') {
    const BK = require('./backup');
    const { db, UPLOAD_DIR } = require('./db');
    const out = path.join(DATA_DIR, 'backups', 'encrypted');
    let bk;
    try { bk = await BK.createBackup({ db, dataDir: DATA_DIR, uploadDir: UPLOAD_DIR, outDir: out }); } catch (e) {
      throw new Error(`Backup FAILED, nothing was saved: ${['ENOSPC', 'EDQUOT'].includes(e.code) ? 'the disk is full. Free some space (or back up to a bigger disk) and try again.' : e.message}`);
    }
    const v = await BK.verifyBackup(bk.file, BK.loadKey(DATA_DIR), path.join(DATA_DIR, 'backups'));
    console.log(`Backup: ${bk.file} (${(bk.size / 1048576).toFixed(1)} MB). Restore test passed: ${v.users} accounts, ${v.messages} messages, ${v.files} files.`);
    if (bk.missing.length) { console.error(missingNote(bk.missing.length, bk.missing, 'were not on disk, so they are not in this backup')); process.exitCode = 3; }
    const off = await BK.uploadOffsite(bk.file);
    if (!off.skipped) console.log(off.ok ? `Copied off-site to ${off.remote}.` : `Copying off-site FAILED: ${off.error}`);
  } else if (cmd === 'verify-backup' && a) {
    const v = await require('./backup').verifyBackup(path.resolve(a), keyFrom(b), os.tmpdir());
    console.log(`Restore test passed: ${v.users} accounts, ${v.messages} messages, ${v.files} files, database version ${v.schema}${v.hasSecretKey ? '' : ' (no secret.key inside: this server used AT_REST_KEY)'}.`);
    if (newerWarning(v.schema)) console.error(newerWarning(v.schema));
  } else if (cmd === 'restore' && a && b) {
    const BK = require('./backup');
    const target = path.resolve(b);
    let r;
    try { r = await BK.restoreBackup(path.resolve(a), keyFrom(c), target, { maxSchema: codeSchema(), signOutEveryone: flags.has('--sign-out-everyone') }); } catch (e) {
      if (e.code !== 'HEARTH_BACKUP_TOO_NEW') throw e;
      console.error(e.message); process.exitCode = 2; return;
    }
    console.log(`Restored ${r.entries.length} files into ${target} (database version ${r.schema}). Start Hearth with DATA_DIR=${target} (or move it to data/).`);
    if (flags.has('--sign-out-everyone')) console.log(`Signed out ${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? '' : 's'}: everyone signs in again with their password.`);
    else console.log('Everyone stays signed in as they were when the backup was made. After a break-in, restore again with --sign-out-everyone.');
    console.log(`Files: ${r.files.referenced} the database refers to, ${r.files.present} restored, ${r.files.unreferencedCount} not referred to by anything.`);
    if (r.files.missingCount) { console.error(missingNote(r.files.missingCount, r.files.missing, 'are not in this backup')); process.exitCode = 3; }
  } else if (cmd === 'check-files') {
    const BK = require('./backup');
    const f = BK.uploadReport(path.join(DATA_DIR, 'hearth.db'), path.join(DATA_DIR, 'uploads'));
    console.log(`Files: ${f.referenced} the database refers to, ${f.present} in uploads/, ${f.unreferencedCount} not referred to by anything.`);
    if (f.missingCount) { console.error(missingNote(f.missingCount, f.missing, 'are missing from uploads/')); process.exitCode = 3; }
  } else {
    console.log('Usage: node server/cli.js set-turn <urls> <secret> | add-turn <urls> [secret] | get-turn | get-turn-secret | set-owner <username> | backup | verify-backup <file> [key] | restore <file> <new-data-dir> [key] [--sign-out-everyone] | check-files');
    process.exitCode = 1;
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
