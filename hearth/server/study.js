// Study tools: flashcard decks, assignments, focus-timer settings and daily stats, synced across your devices.
// The app encrypts every item with a key only it can derive (see vaultKey in public/js/e2ee.js); the server
// stores and returns ciphertext and never knows what's in your decks or to-do list.
//
// Reminders for assignments are the one thing the server must act on while your app is closed, so the app
// registers only a time (and a random id) — the push notification says "A study reminder is due", nothing more.
module.exports = function setupStudy(ctx) {
  const { api, auth, db, fail, rateLimit, pushTo, emitToUser } = ctx;
  const now = () => Date.now();
  const KINDS = new Set(['deck', 'task', 'day', 'settings']);
  const MAX_ITEM = 512 * 1024; // one deck can hold a few thousand cards
  const MAX_TOTAL = 20 * 1024 * 1024;
  const MAX_ITEMS = 3000;
  const ID = /^[\w-]{1,40}$/;

  db.exec(`CREATE TABLE IF NOT EXISTS study_reminders (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_study_reminders_at ON study_reminders(at);`);

  // Turning the study tools on or off (they're hidden until someone wants them).
  api.patch('/me/study-settings', auth, (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined) db.prepare('UPDATE users SET study_enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, req.userId);
    const enabled = !!db.prepare('SELECT study_enabled FROM users WHERE id = ?').get(req.userId).study_enabled;
    emitToUser(req.userId, 'study:enabled', { enabled });
    res.json({ enabled });
  });

  // Sync: everything changed since `since` (deletions included, as tombstones).
  api.get('/me/study', auth, (req, res) => {
    const since = Math.max(0, Math.floor(+req.query.since) || 0);
    const items = db.prepare('SELECT id, kind, data, updated_at, deleted FROM study_items WHERE user_id = ? AND updated_at > ? ORDER BY updated_at LIMIT 5000').all(req.userId, since)
      .map((r) => ({ id: r.id, kind: r.kind, data: r.deleted ? null : r.data, updatedAt: r.updated_at, deleted: !!r.deleted }));
    const used = db.prepare('SELECT COALESCE(SUM(size), 0) b, COUNT(*) n FROM study_items WHERE user_id = ? AND deleted = 0').get(req.userId);
    res.json({ items, now: now(), usedBytes: used.b, count: used.n });
  });
  api.put('/me/study/:id', auth, (req, res) => {
    rateLimit('study:' + req.userId, 600, 60000);
    const id = String(req.params.id);
    const b = req.body || {};
    if (!ID.test(id)) fail(400, 'Bad id.');
    if (typeof b.kind !== 'string' || !KINDS.has(b.kind)) fail(400, 'Unknown kind.');
    if (typeof b.data !== 'string' || !b.data.startsWith('x1:') || b.data.length > MAX_ITEM) fail(400, b.data && b.data.length > MAX_ITEM ? 'That deck is too big. Split it into smaller decks.' : 'Bad data.');
    const cur = db.prepare('SELECT kind, size, deleted FROM study_items WHERE user_id = ? AND id = ?').get(req.userId, id);
    if (cur && cur.kind !== b.kind && !cur.deleted) fail(409, 'That id is used by something else.');
    const used = db.prepare('SELECT COALESCE(SUM(size), 0) b, COUNT(*) n FROM study_items WHERE user_id = ? AND deleted = 0').get(req.userId);
    if (used.b - (cur && !cur.deleted ? cur.size : 0) + b.data.length > MAX_TOTAL) fail(413, 'Your study space is full (20 MB). Delete some old decks.');
    if (!cur && used.n >= MAX_ITEMS) fail(413, 'That’s a lot of study items. Delete some old ones first.');
    // Strictly increasing per account, so two quick saves on two devices still sync in order.
    const last = db.prepare('SELECT MAX(updated_at) t FROM study_items WHERE user_id = ?').get(req.userId).t || 0;
    const t = Math.max(now(), last + 1);
    db.prepare(`INSERT INTO study_items (id, user_id, kind, data, size, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(user_id, id) DO UPDATE SET kind = excluded.kind, data = excluded.data, size = excluded.size, updated_at = excluded.updated_at, deleted = 0`)
      .run(id, req.userId, b.kind, b.data, b.data.length, t);
    emitToUser(req.userId, 'study:changed', { since: t - 1, from: req.session.id });
    res.json({ updatedAt: t });
  });
  api.delete('/me/study/:id', auth, (req, res) => {
    const id = String(req.params.id);
    if (!ID.test(id)) fail(400, 'Bad id.');
    const last = db.prepare('SELECT MAX(updated_at) t FROM study_items WHERE user_id = ?').get(req.userId).t || 0;
    const t = Math.max(now(), last + 1);
    db.prepare("UPDATE study_items SET data = '', size = 0, deleted = 1, updated_at = ? WHERE user_id = ? AND id = ?").run(t, req.userId, id);
    db.prepare('DELETE FROM study_reminders WHERE user_id = ? AND id = ?').run(req.userId, id);
    emitToUser(req.userId, 'study:changed', { since: t - 1, from: req.session.id });
    res.json({ ok: true, updatedAt: t });
  });

  // Reminder times (no content). PUT with at=null removes one.
  api.put('/me/study-reminders/:id', auth, (req, res) => {
    rateLimit('studyrem:' + req.userId, 300, 60000);
    const id = String(req.params.id);
    if (!ID.test(id)) fail(400, 'Bad id.');
    const at = (req.body || {}).at;
    if (at === null || at === undefined) { db.prepare('DELETE FROM study_reminders WHERE user_id = ? AND id = ?').run(req.userId, id); return res.json({ ok: true }); }
    const n = Math.floor(+at);
    if (!Number.isFinite(n) || n < now() - 60000 || n > now() + 400 * 86400000) fail(400, 'Pick a time in the next year.');
    if (db.prepare('SELECT COUNT(*) n FROM study_reminders WHERE user_id = ?').get(req.userId).n >= 500) fail(400, 'Too many reminders.');
    db.prepare('INSERT OR REPLACE INTO study_reminders (user_id, id, at) VALUES (?, ?, ?)').run(req.userId, id, n);
    res.json({ ok: true });
  });
  setInterval(() => {
    const due = db.prepare('SELECT * FROM study_reminders WHERE at <= ? LIMIT 200').all(now());
    for (const r of due) {
      db.prepare('DELETE FROM study_reminders WHERE user_id = ? AND id = ?').run(r.user_id, r.id);
      emitToUser(r.user_id, 'study:reminder', { id: r.id });
      pushTo([r.user_id], { title: '⏰ Study reminder', body: 'Something on your study list is due. Open Hearth to see it.', tag: 'study-' + r.id, url: '/#study' });
    }
  }, 30000).unref();
};
