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
async function addEntry(sealer, name, file) {
  const st = await fs.promises.stat(file);
  const nameBuf = Buffer.from(name);
  const head = Buffer.alloc(1 + 2 + nameBuf.length + 8);
  head[0] = 1; head.writeUInt16BE(nameBuf.length, 1); nameBuf.copy(head, 3); head.writeBigUInt64BE(BigInt(st.size), 3 + nameBuf.length);
  await sealer.write(head);
  let sent = 0;
  for await (const part of fs.createReadStream(file, { highWaterMark: CHUNK })) {
    const p = part.subarray(0, Math.max(0, st.size - sent)); // a file that grew while reading is cut at its old size
    sent += p.length; if (p.length) await sealer.write(p);
  }
  if (sent < st.size) await sealer.write(Buffer.alloc(st.size - sent)); // shrank while reading: keep the format consistent
}

async function createBackup({ db, dataDir, uploadDir, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const master = loadKey(dataDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `hearth-${stamp}.hbk`;
  const tmpDb = path.join(outDir, `.snapshot-${stamp}.db`);
  const out = path.join(outDir, name);
  const part = out + '.part';
  await db.backup(tmpDb);
  const fh = await fs.promises.open(part, 'w', 0o600);
  try {
    const s = new Sealer(fh, master);
    await s.start();
    await addEntry(s, 'hearth.db', tmpDb);
    for (const f of ['secret.key', 'vapid.json']) if (fs.existsSync(path.join(dataDir, f))) await addEntry(s, f, path.join(dataDir, f));
    for (const f of fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : []) {
      const full = path.join(uploadDir, f);
      if (/^[\w.-]+$/.test(f) && fs.statSync(full).isFile()) await addEntry(s, `uploads/${f}`, full);
    }
    await s.write(Buffer.from([0]));
    await s.end();
  } finally { await fh.close(); fs.rmSync(tmpDb, { force: true }); }
  fs.renameSync(part, out);
  return { name, file: out, size: fs.statSync(out).size };
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
  const dir = fs.mkdtempSync(path.join(scratchDir, '.verify-'));
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
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The database version (PRAGMA user_version) of a restored database file, read without changing it.
function schemaOf(file) {
  const Database = require('better-sqlite3');
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try { return d.pragma('user_version', { simple: true }); } finally { d.close(); }
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

module.exports = { createBackup, openBackup, verifyBackup, restoreBackup, uploadOffsite, loadKey, schemaOf };
