// "New members can't read messages from before they joined" (v19, ENGINEERING-REPORT crypto-13): a server setting,
// in Server settings → Overview (Manage Server; written to the server's audit log). Off by default, for new servers
// as for existing ones: with it on, every join makes every member's app switch to a new key, and newcomers wait a
// moment for theirs, while many communities want newcomers to read back (Discord's default too).
//
// With it on, someone who joins (with an invite, the only way into a server; group chats don't have the setting):
//   - is a member "from now": members.key_from is the next key epoch (the current one + 1), and their history starts at
//     joined_at. Members who were in before keep everything, and so do people who joined while it was off;
//   - makes the key need replacing (servers.needs_rotation, the same flag a kick or a rejoin sets), so the apps make a
//     new one, wrapped to everyone in the server then, before the next message goes out. Joins close together share
//     one new key, and a flood of joins can't keep the apps replacing it: a join waits until the current key is a
//     minute old for each key made in the last hour (so one a minute when it's quiet, and roughly one every 8 minutes
//     under a steady flood, never more). Meanwhile messages go on under the current key, and the newcomer's app says
//     their key is on its way; whoever joins meanwhile shares that next key. A wait is kept in the database
//     (servers.join_rotate_at), so a restart doesn't lose it;
//   - is only ever handed keys from key_from on. The current key isn't shared to them (keys/share skips them, and
//     the key state's `missing` list leaves them out so no app tries; they're listed as `waiting` instead), and their
//     own older key rows (from an earlier membership) aren't handed back (keyState) or rewritten (keys/self). While
//     another member is online, the key their join asked for is that member's app's to make: theirs counts as a
//     voluntary one (causedRotation in index.js), so nobody can join just to put in a key the others can't open;
//   - isn't served anything from before: messages, thread replies and thread roots, pins and the pin history, search
//     results, saved messages, the Threads panel, unread and ping counts (thread pings too), exports, reply quotes of
//     older messages, jumps to one, disappearing-timer changes, report evidence shared with them as a moderator, and
//     live events about older messages (edits, reactions, pins, thread counts). A message counts as "before" if it
//     was written before they joined, or is locked with a key from before key_from (the few sent while their key was
//     on its way): they could never open those. A thread started before stays closed, replies written after they
//     joined included (they can't open the thread, so search, jumps, saving and the rest go by its first message).
//     Link previews travel inside messages, so they go with them; scheduled messages are only ever their author's own.
// The apps show one line, "Messages from before you joined are hidden in this server", where the history starts.
//
// Turning it on replaces the key once, so what's already been said is under a key that's never handed out again
// (only the current key ever is). Turning it off lets later joiners read back as before; whoever joined while it was
// on keeps their own start (they never got those keys, so the older messages would only show as locked).
// Toggling it is limited to 10 times an hour per person in each server, since each "on" replaces the key (not one budget
// per server: someone could use it up, ending on off, so nobody else could turn it back on).

// Per key made in the last hour (at least one). Tests shorten it (only with NODE_ENV=test, so a stray variable on a
// real server does nothing).
const TEST_GAP = process.env.NODE_ENV === 'test' ? Number(process.env.HEARTH_TEST_JOIN_KEY_GAP_MS) : 0;
const GAP_MS = TEST_GAP > 0 ? TEST_GAP : 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WATCH_MS = 60 * 1000;

// The smallest message id written at or after time t (ids start with the time, server/db.js newId): unread counts and
// the pin history compare ids rather than reading each message.
const idFloor = (t) => Math.max(0, Math.floor(t)).toString(36).padStart(9, '0');

module.exports = function setupJoinHistory({ db, now, jobs, emitKeyState }) {
  // ------------------------------------------------------------------ who sees what
  // Where someone's history starts in a server: { at, epoch, floor } (joined then, keys from that epoch on, message
  // ids from floor on), or null: they see everything (it was off when they joined, or they're not a member).
  function startOf(serverId, userId) {
    const m = db.prepare('SELECT joined_at, key_from FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
    return m && m.key_from != null ? { at: m.joined_at, epoch: m.key_from, floor: idFloor(m.joined_at) } : null;
  }
  // Whether a message row (or anything with created_at, and ciphertext and epoch for an encrypted message) is from
  // after the start. Plaintext ones (bots, webhooks) only go by time.
  const own = (row, st) => row.created_at >= st.at && (!row.ciphertext || row.epoch == null || row.epoch >= st.epoch);
  // Just what's needed to tell (ciphertext: 1 or 0, whether it's encrypted, rather than the ciphertext itself).
  const rowOf = (id) => (id ? db.prepare('SELECT created_at, ciphertext IS NOT NULL AS ciphertext, epoch, thread_id FROM messages WHERE id = ?').get(id) : null);
  // A thread reply (a row with thread_id) also goes by the message that starts its thread: a thread started before
  // the start stays closed, replies written after it included, everywhere (search, jumps, saving, reacting, exports,
  // unread and ping counts, live events), since the thread itself can't be opened. One whose first message is gone
  // is closed too.
  const visible = (row, st) => !st || !row || (own(row, st) && (!row.thread_id || ((r) => !!r && own(r, st))(rowOf(row.thread_id))));
  const hidden = (serverId, userId, row) => !visible(row, startOf(serverId, userId));
  // The same as SQL, for queries over many messages: { sql, args } to add to a WHERE. The id bound says nothing new (a
  // message's id is made, from the time, just before its created_at, in the same step), but it lets a page walk the
  // channel's index from the join instead of through everything before it.
  //   alias: 'm.' for a joined table. threads: the query can return thread replies (pins, exports), so their thread's
  //   first message must pass too; it then needs a named outer table (alias 'messages.' for a plain FROM messages).
  const where = (st, { alias = '', threads = false } = {}) => (st
    ? {
      sql: ` AND ${alias}id >= ? AND ${alias}created_at >= ? AND (${alias}ciphertext IS NULL OR ${alias}epoch >= ?)${threads
        ? ` AND (${alias}thread_id IS NULL OR EXISTS (SELECT 1 FROM messages hr WHERE hr.id = ${alias}thread_id AND hr.created_at >= ? AND (hr.ciphertext IS NULL OR hr.epoch >= ?)))` : ''}`,
      args: [st.floor, st.at, st.epoch, ...(threads ? [st.at, st.epoch] : [])],
    }
    : { sql: '', args: [] });
  // The members a live event about this message must skip: those it's from before (or its thread's first message
  // is). Two index probes each (the partial indexes only hold members who joined with the setting on), so a server
  // without any costs nothing.
  function shutOut(serverId, row) {
    if (!row) return [];
    const out = new Set();
    if (row.ciphertext && row.epoch != null) {
      for (const r of db.prepare('SELECT user_id FROM members WHERE server_id = ? AND key_from > ?').iterate(serverId, row.epoch)) out.add(r.user_id);
    }
    if (row.created_at != null) {
      for (const r of db.prepare('SELECT user_id FROM members WHERE server_id = ? AND key_from IS NOT NULL AND joined_at > ?').iterate(serverId, row.created_at)) out.add(r.user_id);
    }
    if (row.thread_id) {
      const root = rowOf(row.thread_id);
      // Nothing to tell anyone about a reply whose thread is gone; only those who joined with the setting on are
      // left out of it, as from the thread.
      if (root) shutOut(serverId, root).forEach((u) => out.add(u));
      else db.prepare('SELECT user_id FROM members WHERE server_id = ? AND key_from IS NOT NULL').all(serverId).forEach((r) => out.add(r.user_id));
    }
    return [...out];
  }
  // Members waiting for a key newer than this epoch: nobody may hand them this one.
  const waitingFor = (serverId, epoch) => db.prepare('SELECT user_id FROM members WHERE server_id = ? AND key_from > ?').all(serverId, epoch).map((r) => r.user_id);

  // ------------------------------------------------------------------ joins and the next key
  // When the next join-caused key may be made: once the current key is a minute old for each key made in the last
  // hour. Read from the newest 60 epochs by the primary key (epochs only ever go up with time).
  function dueAt(serverId, t = now()) {
    const recent = db.prepare('SELECT created_at FROM server_epochs WHERE server_id = ? ORDER BY epoch DESC LIMIT 60').all(serverId);
    if (!recent.length) return t;
    const inHour = recent.filter((e) => e.created_at > t - HOUR_MS).length;
    return Math.max(t, recent[0].created_at + GAP_MS * Math.max(1, inHour));
  }
  // Someone just joined (the members row is in). With the setting on, their history starts now and the key is to be
  // replaced: at once, or when the limit allows (shared with whoever else joins meanwhile). Returns whether it applied.
  function joined(serverId, userId) {
    const s = db.prepare('SELECT hide_history, key_epoch, needs_rotation, join_rotate_at FROM servers WHERE id = ?').get(serverId);
    if (!s || !s.hide_history) return false;
    db.prepare('UPDATE members SET key_from = ? WHERE server_id = ? AND user_id = ?').run(s.key_epoch + 1, serverId, userId);
    // No key yet (the first one will be made after they joined), or one is being replaced anyway: nothing to plan.
    if (!s.key_epoch || s.needs_rotation) return true;
    const t = now();
    const due = Math.min(dueAt(serverId, t), s.join_rotate_at || Infinity);
    if (due <= t) db.prepare('UPDATE servers SET needs_rotation = 1, join_rotate_at = NULL WHERE id = ?').run(serverId);
    else {
      db.prepare('UPDATE servers SET join_rotate_at = ? WHERE id = ?').run(due, serverId);
      arm();
    }
    return true;
  }

  // One timer for the soonest wait on the instance (like scheduled messages), checked again every minute in case.
  let timer = null;
  let armedFor = Infinity;
  function arm() {
    const next = db.prepare('SELECT MIN(join_rotate_at) AS t FROM servers WHERE join_rotate_at IS NOT NULL').get().t;
    if (next == null) { clearTimeout(timer); timer = null; armedFor = Infinity; return; }
    if (timer && armedFor <= next) return;
    clearTimeout(timer);
    armedFor = next;
    timer = setTimeout(fire, Math.max(0, Math.min(next - now(), WATCH_MS)));
    timer.unref?.();
  }
  // The waits that are over: the key needs replacing now, if anyone is still waiting for it (a key made meanwhile,
  // for any reason, already covered them, and clears join_rotate_at).
  const fire = jobs.job('joinhistory.rotate', () => {
    timer = null;
    armedFor = Infinity;
    const t = now();
    for (const s of db.prepare('SELECT id, key_epoch FROM servers WHERE join_rotate_at IS NOT NULL AND join_rotate_at <= ?').all(t)) {
      const waiting = !!db.prepare('SELECT 1 FROM members WHERE server_id = ? AND key_from > ? LIMIT 1').get(s.id, s.key_epoch);
      db.prepare(`UPDATE servers SET join_rotate_at = NULL${waiting ? ', needs_rotation = 1' : ''} WHERE id = ?`).run(s.id);
      if (waiting) emitKeyState(s.id);
    }
    arm();
  });
  jobs.every('joinhistory.watch', WATCH_MS, () => { if (!timer) arm(); }, { firstDelay: 2000 });

  // ------------------------------------------------------------------ the setting
  // Turns it on or off (the caller checked Manage Server and the limit). Returns whether the key must be replaced.
  function set(serverId, on) {
    db.prepare('UPDATE servers SET hide_history = ? WHERE id = ?').run(on ? 1 : 0, serverId);
    if (!on) return false;
    return db.prepare('UPDATE servers SET needs_rotation = 1 WHERE id = ? AND key_epoch > 0').run(serverId).changes > 0;
  }

  return { startOf, visible, hidden, where, shutOut, rowOf, waitingFor, joined, set, arm, idFloor, GAP_MS };
};
module.exports.idFloor = idFloor;
