// Files and attachment storage: resumable uploads, storage reports and orphan cleanup.
//
// Resumable uploads (for big attachments; the one-request POST /api/upload/encrypted stays for small files and
// older apps). The app encrypts the file first, so the server only ever receives ciphertext:
//
//   POST   /api/uploads               { size }        → { id, chunkSize, received: 0, expiresAt }
//                                                       The size is checked against the per-file limit, the
//                                                       storage quota and today's allowance, and reserved up front.
//   PUT    /api/uploads/:id?offset=N  raw bytes        Chunks go in order: N must be what the server already has.
//                                                       At most chunkSize bytes each.
//   GET    /api/uploads/:id                            → { received, size, … }: where to carry on after a dropped
//                                                       connection.
//   POST   /api/uploads/:id/complete  { sha256 }      The server hashes what it received; only a match is moved
//                                                       (one atomic rename) into data/uploads/ as a blob.
//   DELETE /api/uploads/:id                            Cancels and gives the reserved room back.
//
// Unfinished uploads live in data/upload-parts/, outside data/uploads/: they are never served and never go into
// backups. Each session belongs to the account that started it; anyone else gets 404. A session left alone for a
// day (UPLOAD_SESSION_IDLE_MS) is removed by the sweep below, which also frees its reservation.
//
// The reservation is a row in user_files (kind 'reserved', name 'upload-<id>'), so every quota check that
// already adds up user_files (single uploads included) sees the room as taken. Completing swaps it for the real
// file's row in one transaction.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function setupStorage(ctx) {
  const { api, auth, db, fail, wrap, rateLimit, limitNet, HttpError, quotaOf, overLimit, uploadLimits, fmtMb, MB, getUserRow,
    removeUpload, fileName, UPLOAD_DIR, DATA_DIR, unseal, auditLog, stepUp, adminOnly, brief } = ctx;
  const now = () => Date.now();

  const PART_DIR = path.join(DATA_DIR, 'upload-parts');
  fs.mkdirSync(PART_DIR, { recursive: true });
  try { fs.chmodSync(PART_DIR, 0o700); } catch { /* not ours to change */ }

  const CHUNK = Math.max(64 * 1024, +(process.env.UPLOAD_CHUNK_BYTES || 0) || 4 * MB);
  const IDLE_MS = +(process.env.UPLOAD_SESSION_IDLE_MS || 0) || 24 * 3600 * 1000;
  const SWEEP_MS = +(process.env.UPLOAD_SWEEP_MS || 0) || 10 * 60 * 1000;
  const MAX_SESSIONS = 4; // unfinished uploads per person at once
  const DISK_MARGIN = 64 * MB; // never promise the last bit of the disk
  const ID = /^[a-f0-9]{32}$/;
  const SHA = /^[a-f0-9]{64}$/;
  const SAFE_NAME = /^[a-z0-9]+(\.[a-z0-9]{1,8})?$/i;
  const reservation = (id) => 'upload-' + id;
  const partOf = (id) => path.join(PART_DIR, id + '.part');

  // Requests working on a session right now (one at a time per session): id -> { abort, completing }.
  const active = new Map();

  const sessionOut = (s) => ({ id: s.id, size: s.size, received: s.received, chunkSize: s.chunk_size, createdAt: s.created_at, updatedAt: s.updated_at, expiresAt: s.updated_at + IDLE_MS });
  // Someone else's session (or none) looks the same: not found.
  function own(req) {
    const id = String(req.params.id || '');
    const s = ID.test(id) && db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id);
    if (!s || s.user_id !== req.userId) fail(404, 'That upload isn\u2019t here any more. Start it again.', 'no_upload');
    return s;
  }
  // Removes a session: its part file, its row and its reservation.
  function drop(id) {
    db.transaction(() => {
      db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(id);
      db.prepare('DELETE FROM user_files WHERE name = ?').run(reservation(id));
    })();
    fs.promises.unlink(partOf(id)).catch(() => {});
  }
  function diskFree() {
    try { const st = fs.statfsSync(UPLOAD_DIR); return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; } catch { return { free: null, total: null }; }
  }

  // ------------------------------------------------------------------ start
  api.post('/uploads', auth, (req, res) => {
    rateLimit('upsess:' + req.userId, 20, 60 * 1000);
    rateLimit('upsessh:' + req.userId, 200, 3600 * 1000);
    limitNet(req, 'upsess', 100, 60 * 1000);
    const size = Number((req.body || {}).size);
    if (!Number.isSafeInteger(size) || size < 1) fail(400, 'Say how big the file is, in bytes.', 'bad_size');
    const q = quotaOf(req.userId);
    if (q.blocked) fail(403, 'Uploads are turned off for your account. Ask an admin if you think that\u2019s a mistake.');
    // The same per-file limit as one-request uploads, with the same allowance for the encryption overhead.
    if (size > q.fileMb * MB + MB) fail(413, `That file is too big. Files can be up to ${q.fileMb} MB.`, 'too_big');
    if (db.prepare('SELECT COUNT(*) n FROM upload_sessions WHERE user_id = ?').get(req.userId).n >= MAX_SESSIONS) {
      fail(429, 'You have too many uploads going at once. Let one finish (or cancel one), then try again.', 'too_many_uploads');
    }
    const { free } = diskFree();
    if (free != null && size > free - DISK_MARGIN) fail(507, 'The server is running out of disk space, so it can\u2019t take this file right now. Let an admin know.', 'disk_full');
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(partOf(id), '', { mode: 0o600 });
    try {
      // No await from the quota check to the reservation, so uploads started at the same time can't both take
      // the last of the room (see overLimit in index.js).
      const over = overLimit(req.userId, q, size);
      if (over) throw over;
      const t = now();
      db.transaction(() => {
        db.prepare('INSERT INTO upload_sessions (id, user_id, size, received, chunk_size, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)').run(id, req.userId, size, CHUNK, t, t);
        db.prepare('INSERT INTO user_files (name, user_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?)').run(reservation(id), req.userId, 'reserved', size, t);
      })();
    } catch (e) {
      fs.rmSync(partOf(id), { force: true });
      throw e;
    }
    res.json(sessionOut(db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id)));
  });

  // ------------------------------------------------------------------ status, list
  api.get('/uploads', auth, (req, res) => {
    res.json(db.prepare('SELECT * FROM upload_sessions WHERE user_id = ? ORDER BY created_at').all(req.userId).map(sessionOut));
  });
  api.get('/uploads/:id', auth, (req, res) => {
    rateLimit('upstat:' + req.userId, 240, 60 * 1000);
    res.json(sessionOut(own(req)));
  });

  // ------------------------------------------------------------------ one chunk
  api.put('/uploads/:id', auth, wrap(async (req, res) => {
    rateLimit('upchunk:' + req.userId, 600, 60 * 1000);
    rateLimit('upchunks:' + req.session.id, 600, 60 * 1000);
    limitNet(req, 'upchunk', 1200, 60 * 1000);
    const s = own(req);
    const row = getUserRow(req.userId);
    if (row && row.uploads_blocked) fail(403, 'Uploads are turned off for your account.');
    if (!/^application\/octet-stream\b/i.test(String(req.headers['content-type'] || ''))) fail(415, 'Send the chunk as application/octet-stream.', 'bad_type');
    const offset = /^\d{1,15}$/.test(String(req.query.offset)) ? Number(req.query.offset) : NaN;
    if (active.has(s.id)) fail(409, 'This upload is busy with another request. Wait for it, then carry on.', 'busy');
    if (offset !== s.received) {
      res.status(409).json({ error: `The server has ${s.received} bytes of this file, so the next chunk starts there.`, code: 'offset_mismatch', received: s.received });
      return;
    }
    const cap = Math.min(s.chunk_size, s.size - s.received);
    if (cap <= 0) fail(400, 'The whole file is already here. Finish the upload instead.', 'already_complete');
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > cap) {
      res.setHeader('Connection', 'close');
      fail(413, `Chunks can be up to ${cap} bytes here.`, 'chunk_too_big');
    }
    // Taken before the first await, so two chunks sent at once can't both get in.
    let aborted = false;
    let tooBig = false;
    let diskError = null;
    active.set(s.id, { abort: () => { aborted = true; req.destroy(); } });
    let fh;
    try { fh = await fs.promises.open(partOf(s.id), 'r+'); } catch {
      active.delete(s.id);
      drop(s.id);
      fail(410, 'This upload expired. Start it again.', 'no_upload');
    }
    let pos = s.received;
    try {
      // Anything past what the server confirmed (a chunk cut off before a crash) is dropped first.
      await fh.truncate(s.received);
      for await (const buf of req) {
        if (pos - s.received + buf.length > cap) { tooBig = true; break; }
        try { await fh.write(buf, 0, buf.length, pos); } catch (e) { diskError = e; break; }
        pos += buf.length;
      }
    } catch { /* the connection dropped: keep what arrived, the app asks where to carry on */ } finally {
      await fh.close().catch(() => {});
      active.delete(s.id);
    }
    if (aborted) return; // cancelled meanwhile: the session is gone
    if (tooBig || diskError) {
      await fs.promises.truncate(partOf(s.id), s.received).catch(() => {});
      res.setHeader('Connection', 'close');
      if (diskError) fail(507, 'The server couldn\u2019t save that piece (its disk may be full). Let an admin know.', 'disk_full');
      fail(413, `Chunks can be up to ${cap} bytes here.`, 'chunk_too_big');
    }
    // A session removed while this chunk was arriving (account deleted, admin cleanup) stays removed.
    if (!db.prepare('UPDATE upload_sessions SET received = ?, updated_at = ? WHERE id = ?').run(pos, now(), s.id).changes) {
      fs.promises.unlink(partOf(s.id)).catch(() => {});
      fail(404, 'That upload isn\u2019t here any more. Start it again.', 'no_upload');
    }
    if (pos === s.received && !res.destroyed) fail(400, 'That chunk was empty.', 'empty_chunk');
    if (!res.destroyed) res.json({ received: pos, size: s.size });
  }));

  // ------------------------------------------------------------------ finish
  async function sha256Of(file) {
    const hash = crypto.createHash('sha256');
    for await (const buf of fs.createReadStream(file)) hash.update(buf);
    return hash.digest('hex');
  }
  api.post('/uploads/:id/complete', auth, wrap(async (req, res) => {
    rateLimit('updone:' + req.userId, 60, 60 * 1000);
    const s = own(req);
    const want = String((req.body || {}).sha256 || '').toLowerCase();
    if (!SHA.test(want)) fail(400, 'Send the SHA-256 of the whole file (64 hex characters).', 'bad_hash');
    if (active.has(s.id)) fail(409, 'This upload is busy with another request. Wait for it, then carry on.', 'busy');
    if (s.received !== s.size) {
      res.status(409).json({ error: `The server only has ${s.received} of ${s.size} bytes so far.`, code: 'incomplete', received: s.received });
      return;
    }
    active.set(s.id, { completing: true, abort: () => {} });
    let got;
    try {
      const st = await fs.promises.stat(partOf(s.id)).catch(() => null);
      got = st && st.size === s.size ? await sha256Of(partOf(s.id)) : null;
    } finally { active.delete(s.id); }
    if (!got || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
      drop(s.id);
      fail(400, 'The file arrived damaged (its checksum doesn\u2019t match), so it wasn\u2019t saved. Send it again.', 'hash_mismatch');
    }
    // Nothing awaits from here to the end: the file appears in uploads/ in one rename, already complete, and
    // its rows swap the reservation for the real file in one transaction.
    if (!db.prepare('SELECT 1 FROM upload_sessions WHERE id = ?').get(s.id)) fail(404, 'That upload isn\u2019t here any more. Start it again.', 'no_upload');
    const name = fileName('.bin');
    const dest = path.join(UPLOAD_DIR, name);
    fs.renameSync(partOf(s.id), dest);
    try {
      fs.chmodSync(dest, 0o644);
      const t = now();
      db.transaction(() => {
        db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(s.id);
        db.prepare('DELETE FROM user_files WHERE name = ?').run(reservation(s.id));
        db.prepare('INSERT INTO user_files (name, user_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?)').run(name, req.userId, 'attachment', s.size, t);
        db.prepare('INSERT INTO blobs (name, uploader_id, created_at) VALUES (?, ?, ?)').run(name, req.userId, t);
      })();
    } catch (e) {
      fs.rmSync(dest, { force: true });
      drop(s.id);
      throw e;
    }
    res.json({ url: '/uploads/' + name, size: s.size });
  }));

  // ------------------------------------------------------------------ cancel
  api.delete('/uploads/:id', auth, (req, res) => {
    rateLimit('upcancel:' + req.userId, 120, 60 * 1000);
    const s = own(req);
    const a = active.get(s.id);
    if (a && a.completing) fail(409, 'This upload is just finishing.', 'busy');
    if (a) { active.delete(s.id); a.abort(); }
    drop(s.id);
    res.json({ ok: true });
  });

  // Every unfinished upload of one person (account deleted, or an admin removed their files).
  function cancelUserSessions(uid) {
    for (const s of db.prepare('SELECT id FROM upload_sessions WHERE user_id = ?').all(uid)) {
      const a = active.get(s.id);
      if (a) { active.delete(s.id); a.abort(); }
      drop(s.id);
    }
  }

  // ------------------------------------------------------------------ expiry sweep
  // Sessions idle for IDLE_MS, sessions whose part file is gone (a restored backup has the rows but never the
  // part files), part files without a session (a crash between the two), and reservations without a session.
  function sweepUploads() {
    const t = now();
    let removed = 0;
    for (const s of db.prepare('SELECT id, updated_at FROM upload_sessions').all()) {
      if (active.has(s.id)) continue;
      if (s.updated_at < t - IDLE_MS || !fs.existsSync(partOf(s.id))) { drop(s.id); removed++; }
    }
    const live = new Set(db.prepare('SELECT id FROM upload_sessions').all().map((s) => s.id));
    for (const f of fs.readdirSync(PART_DIR)) {
      const id = f.replace(/\.part$/, '');
      if (live.has(id)) continue;
      try { if (fs.statSync(path.join(PART_DIR, f)).mtimeMs < t - 60 * 1000) fs.rmSync(path.join(PART_DIR, f), { force: true }); } catch { /* gone */ }
    }
    db.prepare("DELETE FROM user_files WHERE kind = 'reserved' AND substr(name, 8) NOT IN (SELECT id FROM upload_sessions)").run();
    return removed;
  }
  setTimeout(() => { try { sweepUploads(); } catch (e) { console.error('Upload cleanup failed:', e.message); } }, 1000).unref();
  setInterval(() => { try { sweepUploads(); } catch (e) { console.error('Upload cleanup failed:', e.message); } }, SWEEP_MS).unref();

  // ------------------------------------------------------------------ what is referenced
  // A file in data/uploads/ is in use if anything points at it. Built from what the database says, never from
  // guesses about names:
  //   - attachment blobs whose message still exists, and blobs not yet attached that are younger than a day
  //     (the app uploads, then posts; see the hourly sweep in index.js);
  //   - the GIF library;
  //   - any "/uploads/<name>" written in any text column of any other table (avatars, banners, songs, server
  //     icons and themes, emoji, profile pages, settings…), so a new feature that stores a picture is covered
  //     without being listed here;
  //   - the attachment lists inside older, server-encrypted messages (and news bot posts), which are opened.
  // `unverifiable` counts sealed message bodies that couldn't be opened: their files can't be told apart from
  // leftovers, so cleanup refuses to delete anything while there are any.
  const URL_IN_TEXT = /\/uploads\/([a-z0-9]+(?:\.[a-z0-9]{1,8})?)/gi;
  const SKIP_TABLES = new Set(['messages', 'dm_messages', 'blobs', 'user_files', 'upload_sessions']);
  const SEALED = /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]*$/;
  function references(graceMs) {
    const refs = new Set();
    const addText = (txt) => { if (typeof txt === 'string') for (const m of txt.matchAll(URL_IN_TEXT)) refs.add(m[1]); };
    const pendingCutoff = now() - Math.max(graceMs, 24 * 3600 * 1000);
    db.prepare(`SELECT name FROM blobs WHERE (message_id IS NULL AND created_at >= ?)
      OR EXISTS (SELECT 1 FROM messages WHERE id = blobs.message_id) OR EXISTS (SELECT 1 FROM dm_messages WHERE id = blobs.message_id)`).all(pendingCutoff)
      .forEach((b) => refs.add(b.name));
    db.prepare('SELECT file FROM gif_library').all().forEach((g) => refs.add(path.basename(String(g.file))));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).filter((t) => !SKIP_TABLES.has(t));
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all().filter((c) => !c.type || /TEXT|CHAR|CLOB/i.test(c.type)).map((c) => c.name);
      for (const c of cols) {
        const q = `"${c.replace(/"/g, '""')}"`;
        for (const r of db.prepare(`SELECT ${q} AS v FROM "${t.replace(/"/g, '""')}" WHERE ${q} LIKE '%/uploads/%'`).iterate()) addText(r.v);
      }
    }
    let unverifiable = 0;
    for (const m of db.prepare("SELECT body FROM messages WHERE ciphertext IS NULL AND body != ''").iterate()) {
      const open = unseal(m.body);
      if (open && open.content === '[unable to decrypt]' && Array.isArray(open.attachments) && !open.attachments.length && SEALED.test(m.body)) unverifiable++;
      else addText(JSON.stringify(open));
      addText(m.body); // bodies stored as plain text by very old versions
    }
    return { refs, unverifiable };
  }

  // Files in data/uploads/ that nothing references and that are older than the grace period, plus bookkeeping rows
  // that point at nothing. Read-only: cleanup() below deletes what this finds.
  function findOrphans(graceMs) {
    const { refs, unverifiable } = references(graceMs);
    const cutoff = now() - graceMs;
    const tracked = new Set(db.prepare("SELECT name FROM user_files WHERE kind != 'reserved'").all().map((r) => r.name));
    const files = [];
    let names = [];
    try { names = fs.readdirSync(UPLOAD_DIR); } catch { /* none */ }
    const onDisk = new Set();
    for (const f of names) {
      if (!SAFE_NAME.test(f)) continue;
      let st;
      try { st = fs.statSync(path.join(UPLOAD_DIR, f)); } catch { continue; }
      if (!st.isFile()) continue;
      onDisk.add(f);
      if (refs.has(f) || st.mtimeMs >= cutoff) continue;
      files.push({ name: f, size: st.size, modifiedAt: Math.round(st.mtimeMs), tracked: tracked.has(f) });
    }
    // Quota rows for files that are no longer on disk (they still count against someone's storage).
    const staleRows = db.prepare("SELECT name, size FROM user_files WHERE kind != 'reserved' AND created_at < ?").all(cutoff).filter((r) => !onDisk.has(r.name) && !refs.has(r.name));
    // Blob rows whose message is gone or that were never attached in time, with or without a file.
    const deadBlobs = db.prepare('SELECT name FROM blobs').all().filter((b) => !refs.has(b.name)).map((b) => b.name);
    return { files, staleRows, deadBlobs, unverifiable };
  }

  function graceOf(v) {
    const hours = Number(v);
    return (Number.isFinite(hours) ? Math.min(24 * 365, Math.max(1, hours)) : 24) * 3600 * 1000;
  }

  // ------------------------------------------------------------------ admin report
  api.get('/admin/storage/report', auth, adminOnly, (req, res) => {
    rateLimit('storreport:' + req.userId, 30, 10 * 60 * 1000);
    const graceMs = graceOf(req.query.graceHours);
    const sum = (sql, ...a) => db.prepare(sql).get(...a);
    const total = sum("SELECT COUNT(*) files, COALESCE(SUM(size), 0) bytes FROM user_files WHERE kind != 'reserved'");
    const topUsers = db.prepare("SELECT user_id, COUNT(*) files, SUM(size) bytes FROM user_files WHERE kind != 'reserved' GROUP BY user_id ORDER BY bytes DESC LIMIT 20").all()
      .map((r) => ({ user: brief(r.user_id), files: r.files, bytes: r.bytes }));
    // Per server: the attachments of messages in its channels (the server can't see which file is which).
    const topServers = db.prepare(`SELECT c.server_id id, COUNT(*) files, COALESCE(SUM(uf.size), 0) bytes FROM blobs b
        JOIN messages m ON m.id = b.message_id JOIN channels c ON c.id = m.channel_id LEFT JOIN user_files uf ON uf.name = b.name
        GROUP BY c.server_id ORDER BY bytes DESC LIMIT 20`).all()
      .map((r) => { const s = db.prepare('SELECT id, name, kind FROM servers WHERE id = ?').get(r.id) || { id: r.id, name: '', kind: 'server' }; return { server: { id: s.id, name: s.name, kind: s.kind }, files: r.files, bytes: r.bytes }; });
    const dms = sum(`SELECT COUNT(*) files, COALESCE(SUM(uf.size), 0) bytes FROM blobs b JOIN dm_messages d ON d.id = b.message_id
      LEFT JOIN user_files uf ON uf.name = b.name`);
    const pending = sum('SELECT COUNT(*) files, COALESCE(SUM(uf.size), 0) bytes FROM blobs b LEFT JOIN user_files uf ON uf.name = b.name WHERE b.message_id IS NULL');
    const sessions = db.prepare('SELECT * FROM upload_sessions ORDER BY updated_at DESC').all();
    const o = findOrphans(graceMs);
    const disk = diskFree();
    res.json({
      total, topUsers, topServers, dms, pending, free: disk.free, diskTotal: disk.total,
      uploads: {
        count: sessions.length, reserved: sessions.reduce((a, s) => a + s.size, 0), received: sessions.reduce((a, s) => a + s.received, 0),
        list: sessions.slice(0, 50).map((s) => ({ user: brief(s.user_id), size: s.size, received: s.received, createdAt: s.created_at, updatedAt: s.updated_at, expiresAt: s.updated_at + IDLE_MS })),
      },
      orphans: {
        graceHours: graceMs / 3600000, count: o.files.length, bytes: o.files.reduce((a, f) => a + f.size, 0), files: o.files.slice(0, 100),
        staleRows: o.staleRows.length, staleBytes: o.staleRows.reduce((a, r) => a + r.size, 0), deadBlobRows: o.deadBlobs.length, unverifiable: o.unverifiable,
      },
    });
  });

  // ------------------------------------------------------------------ admin cleanup
  // Needs the password (and two-factor) again, and is audit-logged. Everything is worked out again here, in one
  // go with no await between finding and removing, so nothing that gained a reference meanwhile is touched.
  api.post('/admin/storage/cleanup', auth, adminOnly, wrap(async (req, res) => {
    rateLimit('storclean:' + req.userId, 10, 60 * 60 * 1000);
    await stepUp(req, req.body);
    const graceMs = graceOf((req.body || {}).graceHours);
    const o = findOrphans(graceMs);
    if (o.unverifiable) fail(409, `${o.unverifiable} older messages couldn\u2019t be opened with this server\u2019s key, so it can\u2019t be sure which files they use. Nothing was deleted.`, 'unverifiable');
    let bytes = 0;
    db.transaction(() => {
      for (const f of o.files) { db.prepare('DELETE FROM blobs WHERE name = ?').run(f.name); db.prepare('DELETE FROM user_files WHERE name = ?').run(f.name); }
      for (const r of o.staleRows) db.prepare('DELETE FROM user_files WHERE name = ?').run(r.name);
      for (const n of o.deadBlobs) db.prepare('DELETE FROM blobs WHERE name = ?').run(n);
    })();
    for (const f of o.files) { removeUpload('/uploads/' + f.name); bytes += f.size; }
    const detail = `${o.files.length} files (${fmtMb(bytes)}), ${o.staleRows.length} stale quota rows, ${o.deadBlobs.length} blob rows; grace ${graceMs / 3600000} h`;
    auditLog(req, 'storage_cleanup', null, detail);
    res.json({ ok: true, files: o.files.length, bytes, staleRows: o.staleRows.length, deadBlobRows: o.deadBlobs.length });
  }));

  // ------------------------------------------------------------------ your own files (Settings → Storage)
  // Sizes, dates and where each file was posted: the server never knows names or types (they're inside the
  // encrypted message), so the app fills those in from messages it can open.
  api.get('/me/storage/files', auth, (req, res) => {
    rateLimit('myfiles:' + req.userId, 60, 60 * 1000);
    const rows = db.prepare(`SELECT uf.name, uf.kind, uf.size, uf.created_at, b.message_id, m.channel_id, c.server_id, d.dm_id
        FROM user_files uf LEFT JOIN blobs b ON b.name = uf.name LEFT JOIN messages m ON m.id = b.message_id
        LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dm_messages d ON d.id = b.message_id
        WHERE uf.user_id = ? AND uf.kind != 'reserved' ORDER BY uf.size DESC LIMIT 50`).all(req.userId);
    res.json({
      limits: uploadLimits(),
      files: rows.map((r) => ({
        url: '/uploads/' + r.name, kind: r.kind, size: r.size, createdAt: r.created_at,
        where: r.channel_id ? { type: 'channel', serverId: r.server_id, channelId: r.channel_id, messageId: r.message_id }
          : r.dm_id ? { type: 'dm', dmId: r.dm_id, messageId: r.message_id } : r.kind === 'attachment' ? { type: 'unsent' } : null,
      })),
      uploads: db.prepare('SELECT * FROM upload_sessions WHERE user_id = ? ORDER BY created_at').all(req.userId).map(sessionOut),
    });
  });

  return { cancelUserSessions, sweepUploads, findOrphans, PART_DIR, CHUNK, IDLE_MS, HttpError };
};
