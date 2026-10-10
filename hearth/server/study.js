// Study tools (Recall): flashcard decks, their pictures and your study profile, synced across your devices.
// The app encrypts every item with a key only it can derive (see vaultKey in public/js/e2ee.js); the server
// stores and returns ciphertext and never knows what's in your decks.
module.exports = function setupStudy(ctx) {
  const { api, auth, db, fail, rateLimit, emitToUser } = ctx;
  const now = () => Date.now();
  // deck = one deck, img = one picture used on cards, settings = your Recall profile.
  // task and day were used by the earlier study tools; they can still be read and deleted.
  const KINDS = new Set(['deck', 'img', 'settings', 'task', 'day']);
  const MAX_ITEM = 1024 * 1024; // a deck of a few thousand cards, or one picture
  const MAX_TOTAL = 100 * 1024 * 1024;
  const MAX_ITEMS = 5000;
  const ID = /^[\w-]{1,64}$/;

  // Assignment reminders belonged to the earlier study tools; Recall doesn't use them.
  db.exec('DROP TABLE IF EXISTS study_reminders');

  // Turning the study tools on or off (they're hidden until someone wants them).
  api.patch('/me/study-settings', auth, (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined) db.prepare('UPDATE users SET study_enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, req.userId);
    const enabled = !!db.prepare('SELECT study_enabled FROM users WHERE id = ?').get(req.userId).study_enabled;
    emitToUser(req.userId, 'study:enabled', { enabled });
    res.json({ enabled });
  });

  // Sync: everything changed since `since` (deletions included, as tombstones), oldest change first, a page at a
  // time: at most PAGE_ITEMS items or about PAGE_BYTES of data per answer (someone's 100 MB in one answer held up
  // everyone on the server). `more: true` means ask again with since = the last item's updatedAt.
  const PAGE_ITEMS = 500;
  const PAGE_BYTES = 4 * 1024 * 1024;
  api.get('/me/study', auth, (req, res) => {
    rateLimit('studysync:' + req.userId, 120, 60000);
    const since = Math.max(0, Math.floor(+req.query.since) || 0);
    const items = []; let bytes = 0; let more = false;
    for (const r of db.prepare('SELECT id, kind, data, updated_at, deleted FROM study_items WHERE user_id = ? AND updated_at > ? ORDER BY updated_at').iterate(req.userId, since)) {
      // Never stop between two items changed at the same moment: `since` couldn't point between them.
      const last = items[items.length - 1];
      if ((items.length >= PAGE_ITEMS || bytes >= PAGE_BYTES) && r.updated_at !== last.updatedAt) { more = true; break; }
      items.push({ id: r.id, kind: r.kind, data: r.deleted ? null : r.data, updatedAt: r.updated_at, deleted: !!r.deleted });
      bytes += r.deleted ? 0 : r.data.length;
    }
    // Apps from before paging read one answer as everything. Rather than let one of them act on half the list (and
    // overwrite the rest), ask for a reload: the new version is already waiting in the browser.
    if (more && req.query.paged !== '1') fail(409, 'Reload Hearth to finish syncing your study decks (a newer version of the app is ready).', 'study_paged');
    const used = db.prepare('SELECT COALESCE(SUM(size), 0) b, COUNT(*) n FROM study_items WHERE user_id = ? AND deleted = 0').get(req.userId);
    res.json({ items, more, now: now(), usedBytes: used.b, count: used.n });
  });
  api.put('/me/study/:id', auth, (req, res) => {
    rateLimit('study:' + req.userId, 600, 60000);
    const id = String(req.params.id);
    const b = req.body || {};
    if (!ID.test(id)) fail(400, 'Bad id.');
    if (typeof b.kind !== 'string' || !KINDS.has(b.kind)) fail(400, 'Unknown kind.');
    if (typeof b.data !== 'string' || !b.data.startsWith('x1:') || b.data.length > MAX_ITEM) fail(b.data && b.data.length > MAX_ITEM ? 413 : 400, b.data && b.data.length > MAX_ITEM ? 'That deck is too big to sync. Split it into smaller decks.' : 'Bad data.');
    const cur = db.prepare('SELECT kind, size, deleted FROM study_items WHERE user_id = ? AND id = ?').get(req.userId, id);
    if (cur && cur.kind !== b.kind && !cur.deleted) fail(409, 'That id is used by something else.');
    const used = db.prepare('SELECT COALESCE(SUM(size), 0) b, COUNT(*) n FROM study_items WHERE user_id = ? AND deleted = 0').get(req.userId);
    if (used.b - (cur && !cur.deleted ? cur.size : 0) + b.data.length > MAX_TOTAL) fail(413, 'Your study space is full (100 MB). Delete some old decks or pictures.');
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
    // Deletions stay as tombstones so devices that are open hear about them. After 90 days they go: an app that
    // starts syncs from the beginning and doesn't need them, and they'd otherwise pile up forever.
    db.prepare('DELETE FROM study_items WHERE user_id = ? AND deleted = 1 AND updated_at < ?').run(req.userId, t - 90 * 86400000);
    emitToUser(req.userId, 'study:changed', { since: t - 1, from: req.session.id });
    res.json({ ok: true, updatedAt: t });
  });

};
