// Encrypted backups: everything needed to bring Hearth back on a new machine, in one file that's useless
// without the backup key.
//
//   What's inside   the database (a consistent snapshot taken while running), data/secret.key, data/vapid.json
//                   and data/uploads/ (pictures and encrypted attachments)
//   Encryption      AES-256-GCM in 1 MiB chunks (key = HKDF-SHA256(backup key, random salt per file)). Each
//                   chunk's nonce carries its number and a "last chunk" flag, so chunks can't be reordered,
//                   dropped or cut off without the restore noticing.
//   The key         BACKUP_KEY in .env (64 hex characters) or data/backup.key, made the first time. Keep a copy
//                   somewhere else (a password manager): a backup can't be restored without it, and the copies
//                   you send off-site never include it.
//   Off-site        With BACKUP_RCLONE_REMOTE set (for example "b2:my-bucket/hearth"), each backup is copied
//                   there with rclone (Backblaze B2, S3, Google Drive, SFTP… — anything rclone supports).
//   Restore-tested  Every backup is decrypted into a scratch folder right after it's made and the database is
//                   opened and checked (PRAGMA integrity_check), so a backup that can't be restored is noticed
//                   the day it's made, not the day it's needed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAGIC = Buffer.from('HEARTHBK1\n');
const CHUNK = 1 << 20;
const NAME_RE = /^(hearth\.db|secret\.key|vapid\.json|uploads\/[\w-][\w.-]*)$/;

function loadKey(dataDir) {
  if (process.env.BACKUP_KEY) {
    if (!/^[0-9a-f]{64}$/i.test(process.env.BACKUP_KEY)) throw new Error('BACKUP_KEY must be 64 hex characters.');
    return Buffer.from(process.env.BACKUP_KEY, 'hex');
  }
  const file = path.join(dataDir, 'backup.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
const fileKey = (master, salt) => Buffer.from(crypto.hkdfSync('sha256', master, salt, 'hearth-backup-v1', 32));
const nonceFor = (prefix, n, last) => { const b = Buffer.alloc(12); prefix.copy(b, 0); b.writeUInt32BE(n, 7); b[11] = last ? 1 : 0; return b; };

// Writes the encrypted stream: header, then [u32 length][ciphertext+tag] chunks; the final chunk is flagged.
class Sealer {
  constructor(fh, master) {
    this.fh = fh; this.salt = crypto.randomBytes(32); this.prefix = crypto.randomBytes(7);
    this.key = fileKey(master, this.salt); this.header = Buffer.concat([MAGIC, this.salt, this.prefix]);
    this.n = 0; this.pending = []; this.size = 0; this.held = null;
  }
  async start() { await this.fh.write(this.header); }
  async seal(buf, last) {
    const c = crypto.createCipheriv('aes-256-gcm', this.key, nonceFor(this.prefix, this.n++, last));
    c.setAAD(this.header);
    const ct = Buffer.concat([c.update(buf), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4); len.writeUInt32BE(ct.length);
    await this.fh.write(Buffer.concat([len, ct]));
  }
  // A full chunk is held back one step, so the last one can be flagged as last.
  async write(buf) {
    this.pending.push(buf); this.size += buf.length;
    while (this.size >= CHUNK) {
      const all = Buffer.concat(this.pending); const chunk = all.subarray(0, CHUNK);
      this.pending = [all.subarray(CHUNK)]; this.size = this.pending[0].length;
      if (this.held) await this.seal(this.held, false);
      this.held = Buffer.from(chunk);
    }
  }
  async end() {
    const rest = Buffer.concat(this.pending);
    if (this.held && rest.length) { await this.seal(this.held, false); await this.seal(rest, true); } else if (this.held) await this.seal(this.held, true); else await this.seal(rest, true);
  }
}

// Archive entries inside the encrypted stream: [1][u16 name length][name][u64 size][bytes] … [0].
// The file is opened first and read through that handle, so it can be deleted meanwhile (the app keeps running:
// a message with an attachment can be deleted while a backup streams). With `optional`, a file that's already
// gone is simply left out (returns false) instead of failing the whole backup.
async function addEntry(sealer, name, file, { optional = false } = {}) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch (e) { if (optional && e.code === 'ENOENT') return false; throw e; }
  try {
    const st = await fh.stat();
    const nameBuf = Buffer.from(name);
    const head = Buffer.alloc(1 + 2 + nameBuf.length + 8);
    head[0] = 1; head.writeUInt16BE(nameBuf.length, 1); nameBuf.copy(head, 3); head.writeBigUInt64BE(BigInt(st.size), 3 + nameBuf.length);
    await sealer.write(head);
    let sent = 0;
    for await (const part of fh.createReadStream({ highWaterMark: CHUNK, autoClose: false })) {
      const p = part.subarray(0, Math.max(0, st.size - sent)); // a file that grew while reading is cut at its old size
      sent += p.length; if (p.length) await sealer.write(p);
    }
    if (sent < st.size) await sealer.write(Buffer.alloc(st.size - sent)); // shrank while reading: keep the format consistent
  } finally { await fh.close(); }
  return true;
}

// Files a backup (or restore test) in progress is writing: a plaintext database snapshot, a half-written .part,
// a decrypted restore test. Removed if the process is stopped mid-way (see removeInFlight), and at startup.
const inFlight = new Set();
// The plaintext snapshot never goes near outDir (the folder people copy off-site, e.g. with rclone): it's made in
// a private folder of its own, data/backups/.tmp by default.
const defaultTmpDir = (dataDir) => path.join(dataDir, 'backups', '.tmp');
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

async function createBackup({ db, dataDir, uploadDir, outDir, tmpDir = defaultTmpDir(dataDir) }) {
  fs.mkdirSync(outDir, { recursive: true });
  privateDir(tmpDir);
  const master = loadKey(dataDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `hearth-${stamp}.hbk`;
  const tmpDb = path.join(tmpDir, `.snapshot-${stamp}.db`);
  const out = path.join(outDir, name);
  const part = out + '.part';
  inFlight.add(tmpDb); inFlight.add(part);
  let fh = null; let ok = false; let skipped = 0;
  try {
    fs.writeFileSync(tmpDb, '', { mode: 0o600 }); // created private, so the copy is never readable by others
    await db.backup(tmpDb);
    fs.chmodSync(tmpDb, 0o600);
    fh = await fs.promises.open(part, 'w', 0o600);
    const s = new Sealer(fh, master);
    await s.start();
    await addEntry(s, 'hearth.db', tmpDb);
    for (const f of ['secret.key', 'vapid.json']) if (fs.existsSync(path.join(dataDir, f))) await addEntry(s, f, path.join(dataDir, f));
    for (const f of fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : []) {
      if (!/^[\w.-]+$/.test(f)) continue;
      const full = path.join(uploadDir, f);
      let st;
      try { st = fs.statSync(full); } catch (e) { if (e.code === 'ENOENT') { skipped++; continue; } throw e; }
      if (st.isFile() && !(await addEntry(s, `uploads/${f}`, full, { optional: true }))) skipped++;
    }
    await s.write(Buffer.from([0]));
    await s.end();
    await fh.close(); fh = null;
    fs.renameSync(part, out);
    ok = true;
  } finally {
    if (fh) await fh.close().catch(() => {});
    fs.rmSync(tmpDb, { force: true }); fs.rmSync(`${tmpDb}-journal`, { force: true });
    if (!ok) fs.rmSync(part, { force: true }); // a failed backup leaves nothing behind
    inFlight.delete(tmpDb); inFlight.delete(part);
  }
  return { name, file: out, size: fs.statSync(out).size, skipped };
}

// Called when the process is about to stop: a backup cut off now can't finish, so its plaintext snapshot,
// half-written file or decrypted restore test is removed right away.
function removeInFlight() {
  for (const p of inFlight) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
  inFlight.clear();
}

// Leftovers of a backup or restore test that was cut off by a crash or a forced stop: plaintext snapshots
// (older versions made them inside outDir), decrypted restore tests and half-written .part files. Run at startup
// and before each new backup, for things untouched for olderThanMs: a backup still running (from the command line,
// say, while the server restarts) keeps writing to its files, so it's left alone. Returns the names removed.
function cleanStale({ outDir, tmpDir, scratchDir, olderThanMs = 0 }) {
  const removed = [];
  const list = (d) => { try { return d ? fs.readdirSync(d) : []; } catch { return []; } };
  // The last change to a file, or to anything in a folder (a restore test writes into uploads/ inside it).
  const touched = (p, depth = 0) => {
    const st = fs.statSync(p);
    let t = st.mtimeMs;
    if (st.isDirectory() && depth < 3) for (const f of fs.readdirSync(p)) { try { t = Math.max(t, touched(path.join(p, f), depth + 1)); } catch { /* gone meanwhile */ } }
    return t;
  };
  const old = (p) => { if (olderThanMs <= 0) return true; try { return Date.now() - touched(p) >= olderThanMs; } catch { return false; } };
  const rm = (dir, f) => { const p = path.join(dir, f); if (inFlight.has(p) || !old(p)) return; try { fs.rmSync(p, { recursive: true, force: true }); removed.push(f); } catch { /* next time */ } };
  for (const f of list(outDir)) if (f.startsWith('.snapshot-') || f.endsWith('.hbk.part')) rm(outDir, f);
  for (const f of list(tmpDir)) rm(tmpDir, f);
  for (const f of list(scratchDir)) if (f.startsWith('.verify-')) rm(scratchDir, f);
  return removed;
}

// Decrypts a backup. onEntry(name, size) returns a writable path (or null to skip); returns the list of entries.
// Throws on a wrong key, any changed byte, reordered/missing chunks, or a cut-off file.
async function openBackup(file, master, onEntry) {
  const fh = await fs.promises.open(file, 'r');
  const entries = [];
  try {
    const head = Buffer.alloc(MAGIC.length + 39);
    if ((await fh.read(head, 0, head.length, 0)).bytesRead !== head.length || !head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Hearth backup file.');
    const salt = head.subarray(MAGIC.length, MAGIC.length + 32); const prefix = head.subarray(MAGIC.length + 32);
    const key = fileKey(master, salt);
    let pos = head.length; let n = 0; let done = false;
    const size = (await fh.stat()).size;
    // plaintext parser state
    let buf = Buffer.alloc(0); let cur = null; let out = null; let ended = false;
    const feed = async (pt) => {
      buf = buf.length ? Buffer.concat([buf, pt]) : pt;
      for (;;) {
        if (ended) { if (buf.length) throw new Error('Unexpected data after the end of the backup.'); return; }
        if (!cur) {
          if (buf.length < 1) return;
          if (buf[0] === 0) { ended = true; buf = buf.subarray(1); continue; }
          if (buf[0] !== 1 || buf.length < 3) { if (buf[0] !== 1) throw new Error('Damaged backup.'); return; }
          const nl = buf.readUInt16BE(1);
          if (buf.length < 3 + nl + 8) return;
          const name = buf.subarray(3, 3 + nl).toString();
          if (!NAME_RE.test(name)) throw new Error(`Unexpected file in backup: ${name}`);
          cur = { name, left: Number(buf.readBigUInt64BE(3 + nl)) };
          entries.push({ name, size: cur.left });
          const target = onEntry ? onEntry(name, cur.left) : null;
          out = target ? await fs.promises.open(target, 'w', 0o600) : null;
          buf = buf.subarray(3 + nl + 8);
        }
        const take = Math.min(cur.left, buf.length);
        if (out && take) await out.write(buf.subarray(0, take));
        cur.left -= take; buf = buf.subarray(take);
        if (cur.left === 0) { if (out) await out.close(); out = null; cur = null; continue; }
        return;
      }
    };
    try {
      while (pos < size) {
        if (done) throw new Error('Unexpected data after the last chunk.');
        const lenBuf = Buffer.alloc(4);
        await fh.read(lenBuf, 0, 4, pos);
        const len = lenBuf.readUInt32BE(0);
        if (len < 16 || len > CHUNK + 16 || pos + 4 + len > size) throw new Error('The backup file is cut off or damaged.');
        const ct = Buffer.alloc(len);
        await fh.read(ct, 0, len, pos + 4);
        pos += 4 + len;
        const last = pos === size;
        const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(prefix, n++, last));
        d.setAAD(head); d.setAuthTag(ct.subarray(len - 16));
        let pt;
        try { pt = Buffer.concat([d.update(ct.subarray(0, len - 16)), d.final()]); } catch { throw new Error(n === 1 ? 'Wrong backup key, or the file was changed.' : 'The backup file was changed or is damaged.'); }
        done = last;
        await feed(pt);
      }
      if (!done) throw new Error('The backup file is cut off.');
      if (!ended) throw new Error('The backup file is incomplete.');
    } finally { if (out) await out.close(); }
  } finally { await fh.close(); }
  return entries;
}

// The restore test: decrypt into a scratch folder, open the database and check it.
async function verifyBackup(file, master, scratchDir) {
  const dir = fs.mkdtempSync(path.join(scratchDir, '.verify-')); // private (0700): it holds the decrypted backup
  inFlight.add(dir);
  try {
    fs.mkdirSync(path.join(dir, 'uploads'));
    const entries = await openBackup(file, master, (name) => path.join(dir, name));
    if (!entries.some((e) => e.name === 'hearth.db')) throw new Error('No database in the backup.');
    const Database = require('better-sqlite3');
    const d = new Database(path.join(dir, 'hearth.db'), { readonly: true });
    try {
      const check = d.pragma('integrity_check', { simple: true });
      if (check !== 'ok') throw new Error(`Database check failed: ${check}`);
      const count = (t) => { try { return d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return 0; } };
      return { ok: true, users: count('users'), messages: count('messages') + count('dm_messages'), files: entries.filter((e) => e.name.startsWith('uploads/')).length, hasSecretKey: entries.some((e) => e.name === 'secret.key'), schema: d.pragma('user_version', { simple: true }) };
    } finally { d.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); inFlight.delete(dir); }
}

// The database version (PRAGMA user_version) of a restored database file: 4 bytes at offset 60 of its header, read
// straight from the file. Opening it with SQLite instead would leave -wal and -shm files next to it (it's in WAL mode).
function schemaOf(file) {
  const head = Buffer.alloc(100);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 100, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1', 0, 16) !== 'SQLite format 3\0') throw new Error(`${file} isn't a SQLite database.`);
  return head.readInt32BE(60);
}

// Restores into an empty folder (a new data/ directory).
async function restoreBackup(file, master, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  if (fs.readdirSync(targetDir).length) throw new Error(`${targetDir} isn't empty. Restore into a new, empty folder.`);
  fs.mkdirSync(path.join(targetDir, 'uploads'));
  return openBackup(file, master, (name) => path.join(targetDir, name));
}

// Copies a backup off-site with rclone, if BACKUP_RCLONE_REMOTE is set.
function uploadOffsite(file) {
  const remote = (process.env.BACKUP_RCLONE_REMOTE || '').trim();
  if (!remote) return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    execFile('rclone', ['copyto', '--no-traverse', file, `${remote.replace(/\/+$/, '')}/${path.basename(file)}`], { timeout: 6 * 3600000 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err.message).trim().slice(-300) } : { ok: true, remote });
    });
  });
}

module.exports = { createBackup, openBackup, verifyBackup, restoreBackup, uploadOffsite, loadKey, cleanStale, removeInFlight, defaultTmpDir, schemaOf };
