// Scheduled messages ("Send later"). The sender's app encrypts the message exactly as it would to send it now (same
// format, server key epoch and signature for a channel; same format for a DM). This server keeps that ciphertext until
// the chosen time and then posts it through the same code as a message sent then (postChannelMessage /
// postDmMessage in index.js): a new message id, created_at = the moment it goes out, live events, pushes, @mentions
// and bot events as usual. It never gets the text. One thing differs: its author may well be away when it goes out,
// so it doesn't move their read marker (what others wrote meanwhile stays unread), and their own apps get their copy
// marked scheduled: true so they don't take it as "read up to here" either.
//
// The sender's own copy. With the ciphertext, the app sends `draft`: the same message sealed with the sender's
// personal vault key (only their identity key can make or open one), bound to `ref` (an id the app picks), the
// conversation and the thread. When a message has to be re-encrypted, the app works only from that copy, never from
// the ciphertext: so neither this server nor a stolen session (which has no identity key) can get the sender's app to
// re-encrypt and re-sign something they didn't schedule there (a forged message, or one of their old ones from before
// a key rotation). One without a copy that opens shows as "can't confirm you wrote this" and can only be cancelled.
//
// Sessions. Each one records the session that wrote it. When that session ends (logged out, signed out from another
// device, a password change or reset, staff), what it scheduled is held ("session_ended") and goes out only once the
// person confirms it from an app still signed in, so signing out a stolen session also stops what it queued. Expiry
// alone doesn't count. A new sign-in token for a session (rotateToken in index.js: a password change, two-factor
// turned on, "Log out all other devices" with the password) isn't a sign-out, but it's what shuts out a copy of the
// old token, so what the session had waiting is held too ("token_renewed"). The person's app re-encrypts those by
// itself, as for a key change, from their own copies; one a copy of the token made has no copy that opens (no
// identity key), so it stays held and can only be cancelled.
//
// Disappearing messages. The app encrypts it for the conversation's timer when it's scheduled (x inside, and ttl
// beside it, checked like a message sent then: 409 disappear_changed if the timer just changed) and this keeps ttl.
// When it's posted, its deadline counts from that moment, by the conversation's timer then, and never later than the
// ttl it was encrypted for (sendSecs in index.js): so it disappears no later than its sender expected, nor than the
// conversation's setting says by then. Readers' apps take the earlier of the two as well. Re-encrypting it (an edit,
// a key change) doesn't change that: the new ciphertext keeps the stricter of its ttl and the conversation's timer
// now (keepTtl), so a timer turned off or made longer meanwhile never makes it last longer than its sender wrote it
// for.
//
// Voice channels' chats take scheduled messages like text channels (a group's call has none); threads stay in text
// channels.
//
// At send time everything is checked again, as for a message sent then. Lost access (left, kicked, banned, a private
// channel hidden, the channel, server or DM gone), no permission to post there any more, a timeout, a block, the
// other person's account deleted, or the thread gone: the message is marked failed and the sender is told (live in
// any open app, and by push otherwise). Slow mode only delays it. One that came due more than a day ago, untouched
// since (the server was down, or brought back from an old backup), isn't posted that late: it fails the same way.
//
// Keys. A channel message is locked with the server key of one epoch, and readers who joined after a rotation never
// get older keys; a DM is locked with the two people's identity keys. Posting old ciphertext would make a message
// some or all readers can't open (and, for a channel, one a removed member could), so this server never does:
//   - the server's key changed or needs replacing (someone left): the message is "held", as soon as the key changes
//     (if its sender is still a member) or at its time. The sender's app, the next time it's open, re-encrypts it
//     with the current key (PATCH with new ciphertext) and it's pending again: it goes out at its time, or at once if
//     that has passed. That needs saying (sendNow, or a new sendAt), or the PATCH is refused (409 overdue): the app
//     says so by itself only within 10 minutes of the time; later, it asks first;
//   - in a DM, the other person's key changed (a password reset without the recovery key): held the same way. Their
//     app re-encrypts once the sender has checked the new key (it refuses to encrypt to an unchecked one);
//   - the sender's own keys changed: failed. That ciphertext can't be re-encrypted (the old private key is gone)
//     and its signature would no longer check out. Nothing is lost that the sender can't write again.
// A held message whose time comes is checked again then: one that can't go anyway fails, else the sender is told it's
// waiting. Held messages count towards the limit and go 30 days after their time if nobody re-encrypts them; failed
// ones don't count and go a week after their time.
//
// Routes (all signed in; only your own scheduled messages, anyone else's answer 404 like one that doesn't exist)
//   GET    /scheduled-messages                         yours, soonest first (keys checked first, see listing)
//   POST   /channels/:id/scheduled-messages            { ciphertext, epoch, ref, draft, sendAt, ttl?, replyTo?, threadId?, files?, mentions?, everyone? }
//   POST   /dms/:id/scheduled-messages                 { ciphertext, ref, draft, sendAt, ttl?, replyTo?, files? }
//   PATCH  /scheduled-messages/:id                     { sendAt?, ciphertext?, draft?, epoch?, ttl?, mentions?, everyone?, sendNow? }
//          reschedule (sendAt), or edit / re-encrypt / confirm (ciphertext with its draft; for a channel, mentions and
//          everyone are replaced along with it)
//   POST   /scheduled-messages/:id/send                send it now (refusals answered, the message left as it was); with
//          { ciphertext, epoch?, ttl?, mentions?, everyone? } that new copy goes instead (the app's, saying "now" inside)
//   DELETE /scheduled-messages/:id                     cancel, or dismiss a failed one (its files go too)
// Socket events to the sender's own apps: scheduled:update (the item) and scheduled:remove ({ id, messageId }).
const crypto = require('crypto');
const jobs = require('./jobs');
const log = require('./log');

const MAX_PENDING = 25; // pending or held, per person
const MAX_DAYS = 30;
const MAX_AHEAD_MS = MAX_DAYS * 24 * 3600 * 1000;
const FAILED_KEPT_MS = 7 * 24 * 3600 * 1000; // failed ones, after their time
const HELD_KEPT_MS = 30 * 24 * 3600 * 1000; // held ones nobody came back to re-encrypt
const LATE_LIMIT_MS = 24 * 3600 * 1000; // due longer ago than this (the server was down): not posted that late
const MAX_WAIT_MS = 60000; // the timer looks again at least this often
const BATCH = 50;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const REF = /^[A-Za-z0-9_-]{16,64}$/;
const DRAFT_MAX = 66000; // the sender's copy: the same message as the ciphertext (at most 64,000), without a signature
const UPLOAD = /^\/uploads\/[a-z0-9]+\.bin$/;

// Why one is held or failed, in the words the app shows and the push carries.
const WHY = {
  key: 'This conversation’s encryption key changed after you scheduled it. Your app re-encrypts it the next time it’s open.',
  peer_key: 'Their security key changed after you scheduled it. Check their safety number; your app then re-encrypts it.',
  keys_changed: 'Your own encryption keys changed after you scheduled it (a password reset without your recovery key), so it can’t be sent. Write it again.',
  no_access: 'You can no longer post in that conversation: it was deleted, or you left or lost access to it.',
  no_permission: 'You no longer have permission to post there (or to attach files or reply in threads there).',
  timed_out: 'You were timed out in that server when it was due.',
  thread_gone: 'The thread it replies in was deleted.',
  blocked: 'You can’t message this person any more.',
  deleted: 'That account was deleted.',
  suspended: 'Your account was suspended when it was due.',
  too_late: 'It was due more than a day ago, while your Hearth server was down, so it wasn’t sent that late.',
  session_ended: 'It was scheduled from a session that has been signed out since, so it waits for you to confirm it (Keep, Send now or Edit) or cancel it.',
  token_renewed: 'Your sign-in got a new token after it was scheduled (a password change, two-factor turned on or other devices signed out). Your app re-encrypts it by itself once it confirms you wrote it; if it can’t, a copy of your old sign-in may have made it: cancel it.',
};

module.exports = function setupScheduled(ctx) {
  const {
    api, auth, db, fail, rateLimit, limitMessages, newId, now, perms, PM, requireChannel, requireDm, isMember, serverOf, isBlocked,
    getUserRow, stillSuspended, validCipher, requireCurrentEpoch, attachBlobs, removeUpload, replyIn, threadRootIn, dmReplyIn,
    postChannelMessage, postDmMessage, pushTo, maintenance, nameOf, emitTo, ready = () => true,
    hasChat = (c) => c.type === 'text', checkTtl = () => {},
  } = ctx;
  // The disappearing timer the app encrypted it for (checked by checkTtl against the conversation's), or null when
  // the app didn't say (then the conversation's timer when it's posted decides alone).
  const ttlOf = (b) => (typeof b.ttl === 'number' ? b.ttl : null);
  // New ciphertext for one already scheduled keeps the stricter of the timer it had and the conversation's now: a
  // timer turned on or shortened since applies, but one turned off or made longer never lets it live longer than its
  // sender wrote it for, whatever the app sends (the same as when it's posted untouched, see sendSecs).
  const keepTtl = (had, ttl) => (had > 0 && !(ttl > 0 && ttl < had) ? had : ttl);

  // ------------------------------------------------------------------ keys
  // Fingerprints of the public keys a message was written with. A channel message is signed, so the sender's
  // signing key counts too; a DM depends on both people's identity keys.
  const fp = (...keys) => crypto.createHash('sha256').update(keys.map((k) => String(k || '')).join('|')).digest('base64').slice(0, 24);
  const ownKey = (u, channel) => (channel ? fp('c', u.public_key, u.sign_public_key) : fp('d', u.public_key));
  const peerKey = (u) => fp('p', u.public_key);
  const peerOf = (d, uid) => (d.user_a === uid ? d.user_b : d.user_a);
  // A key change since it was written: { fail } (the sender's own keys) or { hold } (needs re-encrypting), or null.
  function keyProblem(r, u = getUserRow(r.user_id)) {
    if (!u) return null;
    if (ownKey(u, !!r.channel_id) !== r.own_key) return { fail: 'keys_changed' };
    if (r.channel_id) {
      const s = r.server_id && db.prepare('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?').get(r.server_id);
      return s && (s.needs_rotation || !s.key_epoch || s.key_epoch !== r.epoch) ? { hold: 'key' } : null;
    }
    const d = db.prepare('SELECT user_a, user_b FROM dm_channels WHERE id = ?').get(r.dm_id);
    const peer = d && getUserRow(peerOf(d, r.user_id));
    return peer && !peer.deleted_at && peerKey(peer) !== r.peer_key ? { hold: 'peer_key' } : null;
  }

  // ------------------------------------------------------------------ rows
  const filesOf = (r) => { try { return JSON.parse(r.files); } catch { return []; } };
  const serialize = (r) => ({
    id: r.id, serverId: r.server_id || null, channelId: r.channel_id || null, dmId: r.dm_id || null, threadId: r.thread_id || null, replyTo: r.reply_to || null,
    ciphertext: r.ciphertext, epoch: r.epoch == null ? null : r.epoch, files: filesOf(r).length, sendAt: r.send_at, status: r.status,
    reason: r.reason || null, note: r.reason ? WHY[r.reason] || null : null, createdAt: r.created_at,
    // When this ciphertext was written, and the sender's own copy of it (see the top of this file).
    encryptedAt: r.updated_at, ref: r.ref || null, draft: r.draft || null,
    // The disappearing timer it was encrypted for (seconds; 0 = none), or null.
    ttl: r.ttl == null ? null : r.ttl,
  });
  const rowOf = (id) => db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
  const changed = (r) => emitTo(r.user_id, 'scheduled:update', serialize(r));
  function own(id, uid) {
    const r = ID.test(String(id || '')) ? db.prepare('SELECT * FROM scheduled_messages WHERE id = ? AND user_id = ?').get(String(id), uid) : null;
    if (!r) fail(404, 'Scheduled message not found.');
    return r;
  }
  // Deletes it with its files (cancelled, dismissed, or its account gone).
  function forget(r) {
    const names = db.prepare('SELECT name FROM blobs WHERE message_id = ?').all(r.id).map((b) => b.name);
    db.transaction(() => {
      db.prepare('DELETE FROM blobs WHERE message_id = ?').run(r.id);
      db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id);
    })();
    names.forEach((n) => removeUpload('/uploads/' + n));
  }

  // Where it was going, for a push: only what the sender can still see.
  function placeName(r) {
    if (r.dm_id) {
      const d = db.prepare('SELECT user_a, user_b FROM dm_channels WHERE id = ?').get(r.dm_id);
      return d ? nameOf(peerOf(d, r.user_id)) : 'a conversation';
    }
    const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(r.channel_id);
    if (!c || !isMember(c.server_id, r.user_id)) return 'a conversation you can no longer see';
    const s = serverOf(c);
    if (!(perms.channel(s, c, r.user_id) & PM.VIEW_CHANNEL)) return 'a conversation you can no longer see';
    return s.kind === 'group' ? s.name || 'your group' : `${c.type === 'voice' ? '\uD83D\uDD0A ' : '#'}${c.name} · ${s.name}`;
  }
  // Held or failed. tell: it came due like this, so the sender hears about it (once): open apps get the live
  // event, devices with no app open a push.
  function mark(r, status, reason, { tell = false } = {}) {
    const same = r.status === status && r.reason === reason;
    if (same && (!tell || r.told_at)) return;
    const toldAt = tell ? now() : r.told_at || null;
    db.prepare('UPDATE scheduled_messages SET status = ?, reason = ?, told_at = ? WHERE id = ?').run(status, reason, toldAt, r.id);
    Object.assign(r, { status, reason, told_at: toldAt });
    changed(r);
    if (!tell) return;
    const title = status === 'failed' ? 'A scheduled message wasn’t sent' : 'A scheduled message is waiting';
    pushTo([r.user_id], { title, body: `${placeName(r)}: ${WHY[reason]}`, tag: 'sched:' + r.id, url: '/#scheduled', generic: title }, { kind: 'scheduled' });
  }

  // ------------------------------------------------------------------ sending
  // Keys, then whether it waits for its sender to confirm it. A session_ended or token_renewed hold stays until a
  // session still signed in re-encrypts it (the person confirming it, or their app from their own copy), whatever
  // happens to the keys meanwhile: only the sender's own new keys (which fail it) come first.
  const WAITS_FOR_SENDER = new Set(['session_ended', 'token_renewed']);
  function waitsFor(r, u) {
    const keys = keyProblem(r, u);
    if (keys && keys.fail) return keys;
    if (r.status === 'held' && WAITS_FOR_SENDER.has(r.reason)) return { hold: r.reason };
    return keys;
  }
  // Everything a message sent now would be checked for, from the sender's side. Returns what to do:
  //   { gone }            the account is gone: forget it
  //   { fail: reason }    it can't ever go as it is
  //   { hold: reason }    it needs re-encrypting first
  //   { later: time }     slow mode: not yet
  //   { channel, threadId, replyTo } or { dm, replyTo }   post it
  function prepare(r) {
    const u = getUserRow(r.user_id);
    if (!u || u.deleted_at) return { gone: true };
    if (stillSuspended(u)) return { fail: 'suspended' };
    if (r.channel_id) {
      const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(r.channel_id);
      if (!c || !hasChat(c) || !isMember(c.server_id, r.user_id)) return { fail: 'no_access' };
      const s = serverOf(c);
      const cp = perms.channel(s, c, r.user_id);
      if (!(cp & PM.VIEW_CHANNEL)) return { fail: 'no_access' };
      // Before the permissions: a timeout takes Send Messages away, and this says why.
      if (perms.timedOut(s.id, r.user_id)) return { fail: 'timed_out' };
      if (!(cp & PM.SEND_MESSAGES) || (filesOf(r).length && !(cp & PM.ATTACH_FILES)) || (r.thread_id && !(cp & PM.CREATE_THREADS))) return { fail: 'no_permission' };
      const keys = waitsFor(r, u);
      if (keys) return keys;
      const threadId = r.thread_id ? threadRootIn(c, r.thread_id) : null;
      if (r.thread_id && !threadId) return { fail: 'thread_gone' };
      if (c.slowmode > 0 && !(cp & (PM.MANAGE_MESSAGES | PM.MANAGE_CHANNELS))) {
        const last = db.prepare('SELECT MAX(created_at) AS t FROM messages WHERE channel_id = ? AND author_id = ?').get(c.id, r.user_id).t;
        if (last != null && last + c.slowmode * 1000 > now()) return { later: last + c.slowmode * 1000 };
      }
      return { channel: c, threadId, replyTo: replyIn(c, r.reply_to) };
    }
    const d = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(r.dm_id);
    if (!d || (d.user_a !== r.user_id && d.user_b !== r.user_id)) return { fail: 'no_access' };
    if (isBlocked(d.user_a, d.user_b)) return { fail: 'blocked' };
    const peer = getUserRow(peerOf(d, r.user_id));
    if (!peer || peer.deleted_at) return { fail: 'deleted' };
    const keys = waitsFor(r, u);
    if (keys) return keys;
    return { dm: d, replyTo: dmReplyIn(d, r.reply_to) };
  }
  // Posts it as a new message. The scheduled row goes, and its files become the message's, in the same transaction
  // as the message itself: it can't be posted twice, or lost.
  function post(r, p) {
    const handOver = (messageId) => {
      // Gone meanwhile (cancelled, sent): throwing undoes the message too.
      if (db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id).changes !== 1) throw new Error('That scheduled message is gone.');
      db.prepare('UPDATE blobs SET message_id = ? WHERE message_id = ?').run(messageId, r.id);
    };
    let mentions = [];
    try { mentions = JSON.parse(r.mentions); } catch { /* none */ }
    const msg = p.channel
      ? postChannelMessage(p.channel, r.user_id, { ciphertext: r.ciphertext, epoch: r.epoch, files: [], replyTo: p.replyTo, threadId: p.threadId, mentions, everyone: !!r.everyone, ttl: r.ttl }, null, { within: handOver, scheduled: true })
      : postDmMessage(p.dm, r.user_id, { ciphertext: r.ciphertext, files: [], replyTo: p.replyTo, ttl: r.ttl }, null, { within: handOver, scheduled: true });
    emitTo(r.user_id, 'scheduled:remove', { id: r.id, messageId: msg.id });
    return msg;
  }
  function deliver(r) {
    // Due long ago and not written since: the server was down or in maintenance, or brought back from an old backup.
    // Posting it now could say something no longer true, so it isn't; its sender hears why. (One re-encrypted after
    // its time was the sender's own choice: it goes.)
    if (now() - r.send_at > LATE_LIMIT_MS && r.updated_at < r.send_at) return mark(r, 'failed', 'too_late', { tell: true });
    const p = prepare(r);
    if (p.gone) return forget(r);
    if (p.later) {
      db.prepare('UPDATE scheduled_messages SET send_at = ? WHERE id = ?').run(p.later, r.id);
      r.send_at = p.later;
      return changed(r);
    }
    if (p.fail) return mark(r, 'failed', p.fail, { tell: true });
    if (p.hold) return mark(r, 'held', p.hold, { tell: true });
    post(r, p);
  }
  // Due: pending ones whose time has come, and held ones whose time has come and whose sender wasn't told yet (they
  // are checked again: one that can't go anyway fails now, and one that only needs re-encrypting tells the sender).
  const DUE = `SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_at <= ?
    UNION ALL SELECT * FROM scheduled_messages WHERE status = 'held' AND told_at IS NULL AND send_at <= ?`;
  function sendDue() {
    const t = now();
    const due = db.prepare(`${DUE} ORDER BY send_at, id LIMIT ?`).all(t, t, BATCH);
    for (const r of due) {
      try { deliver(r); } catch (e) {
        // Something unexpected (a busy database, say): try that one again in a minute rather than straight away.
        log.error('scheduled', 'send_failed', e, { msg: 'A scheduled message couldn’t be sent; trying again in a minute.' });
        db.prepare('UPDATE scheduled_messages SET send_at = ? WHERE id = ?').run(now() + 60000, r.id);
      }
    }
  }

  // One timer, armed for the soonest pending message (and at least once a minute), so messages go out on time to
  // the second without polling. During maintenance nothing is sent: they go out, late, once it's over (up to a day
  // late; see deliver).
  let timer = null;
  function arm(minWait = 0) {
    clearTimeout(timer);
    const next = db.prepare(`SELECT MIN(t) AS t FROM (SELECT MIN(send_at) AS t FROM scheduled_messages WHERE status = 'pending'
      UNION ALL SELECT MIN(send_at) FROM scheduled_messages WHERE status = 'held' AND told_at IS NULL)`).get().t;
    const wait = next == null ? MAX_WAIT_MS : Math.min(MAX_WAIT_MS, Math.max(minWait, next - now()));
    timer = setTimeout(run, wait);
    timer.unref?.();
  }
  const run = jobs.job('scheduled.send', () => {
    timer = null;
    const paused = !ready() || !!maintenance();
    try { if (!paused) sendDue(); } finally { arm(paused ? 15000 : 0); }
  });
  // Safety net: if a run ever failed before re-arming, this starts the timer again.
  jobs.every('scheduled.watch', MAX_WAIT_MS, () => { if (!timer) arm(); }, { firstDelay: 2000 });
  jobs.every('scheduled.prune', 3600 * 1000, () => {
    const t = now();
    const old = db.prepare("SELECT * FROM scheduled_messages WHERE (status = 'failed' AND send_at < ?) OR (status = 'held' AND send_at < ?)").all(t - FAILED_KEPT_MS, t - HELD_KEPT_MS);
    for (const r of old) { forget(r); emitTo(r.user_id, 'scheduled:remove', { id: r.id, messageId: null }); }
  }, { firstDelay: 60000 });

  // ------------------------------------------------------------------ input
  // A time in milliseconds, as a JSON number (not a string or an array that happens to convert to one).
  function checkSendAt(t) {
    if (typeof t !== 'number' || !Number.isSafeInteger(t)) fail(400, 'Pick when to send it.', 'send_at');
    if (t <= now()) fail(400, 'Pick a time in the future.', 'send_at');
    if (t > now() + MAX_AHEAD_MS) fail(400, `You can schedule a message up to ${MAX_DAYS} days ahead.`, 'send_at');
    return t;
  }
  // The sender's own copy (see the top of this file): this server can't open it, only check its shape.
  function checkDraft(draft) {
    if (typeof draft !== 'string' || !draft.startsWith('x1:') || draft.length < 20 || draft.length > DRAFT_MAX) fail(400, 'Bad encrypted payload. Reload the page.', 'draft');
    return draft;
  }
  function checkRef(ref) {
    if (typeof ref !== 'string' || !REF.test(ref)) fail(400, 'Bad encrypted payload. Reload the page.', 'draft');
    return ref;
  }
  const cleanMentions = (m) => (Array.isArray(m) ? [...new Set(m.filter((x) => typeof x === 'string' && ID.test(x)))].slice(0, 50) : []);
  const cleanFiles = (f) => (Array.isArray(f) ? [...new Set(f.filter((u) => typeof u === 'string' && UPLOAD.test(u)))].slice(0, 20) : []);
  function limitScheduling(req) {
    rateLimit('sched:' + req.userId, 30, 60000);
    limitMessages(req); // scheduling one is sending one, later
  }
  function roomFor(uid) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM scheduled_messages WHERE user_id = ? AND status != 'failed'").get(uid).n;
    if (n >= MAX_PENDING) fail(400, `You can have up to ${MAX_PENDING} scheduled messages at a time. Send or cancel one first.`, 'too_many');
  }
  // Stores a new one. Its files (blobs this person uploaded and hasn't attached to anything) become its own.
  function create(row, files) {
    const id = newId();
    const t = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO scheduled_messages (id, user_id, server_id, channel_id, dm_id, thread_id, reply_to, ciphertext, epoch, ref, draft, session_id, own_key, peer_key, ttl, mentions, everyone, send_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, row.user_id, row.server_id || null, row.channel_id || null, row.dm_id || null, row.thread_id || null, row.reply_to || null,
        row.ciphertext, row.epoch == null ? null : row.epoch, row.ref, row.draft, row.session_id || null, row.own_key, row.peer_key || null, row.ttl == null ? null : row.ttl, JSON.stringify(row.mentions || []), row.everyone ? 1 : 0, row.send_at, t, t);
      attachBlobs(files, row.user_id, id);
      const kept = db.prepare('SELECT name FROM blobs WHERE message_id = ?').all(id).map((b) => '/uploads/' + b.name);
      db.prepare('UPDATE scheduled_messages SET files = ? WHERE id = ?').run(JSON.stringify(kept), id);
    })();
    const r = rowOf(id);
    changed(r);
    arm();
    return r;
  }

  // ------------------------------------------------------------------ routes
  // Keys are checked here too, so an app that opens before the time re-encrypts what needs it straight away.
  api.get('/scheduled-messages', auth, (req, res) => {
    rateLimit('schedlist:' + req.userId, 60, 60000);
    const u = getUserRow(req.userId);
    const rows = db.prepare('SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY send_at, id').all(req.userId);
    for (const r of rows) {
      if (r.status !== 'pending') continue;
      const k = keyProblem(r, u);
      if (k) mark(r, k.fail ? 'failed' : 'held', k.fail || k.hold);
    }
    res.json({ items: rows.map(serialize), max: MAX_PENDING, maxDays: MAX_DAYS });
  });

  api.post('/channels/:id/scheduled-messages', auth, (req, res) => {
    const c = requireChannel(req.params.id, req.userId);
    if (!hasChat(c)) fail(400, c.type === 'voice' ? 'A group call has no chat of its own: write in the group.' : 'You can only send messages in text and voice channels.');
    if ((req.body || {}).threadId && c.type !== 'text') fail(400, 'Threads are only in text channels.');
    limitScheduling(req);
    const b = req.body || {};
    validCipher(b.ciphertext);
    const ref = checkRef(b.ref);
    const draft = checkDraft(b.draft);
    const sendAt = checkSendAt(b.sendAt);
    const s = serverOf(c);
    if (perms.timedOut(s.id, req.userId)) fail(403, 'You’re timed out in this server for now.', 'timed_out');
    const cp = perms.channel(s, c, req.userId);
    if (!(cp & PM.SEND_MESSAGES)) fail(403, 'You don’t have permission to send messages here.');
    const files = cleanFiles(b.files);
    if (files.length && !(cp & PM.ATTACH_FILES)) fail(403, 'You don’t have permission to attach files here.');
    let threadId = null;
    if (b.threadId) {
      if (!(cp & PM.CREATE_THREADS)) fail(403, 'You don’t have permission to reply in threads here.');
      threadId = threadRootIn(c, b.threadId, req.userId);
      if (!threadId) fail(404, 'That thread no longer exists.');
    }
    const epoch = requireCurrentEpoch(c.server_id, b.epoch);
    // The disappearing timer the app encrypted for must be the one in force now, as for a message sent now.
    checkTtl(b, c.disappear_secs);
    roomFor(req.userId);
    const r = create({
      user_id: req.userId, server_id: c.server_id, channel_id: c.id, thread_id: threadId, reply_to: replyIn(c, b.replyTo), ciphertext: b.ciphertext, epoch,
      ref, draft, session_id: req.session.id, own_key: ownKey(getUserRow(req.userId), true), ttl: ttlOf(b), mentions: cleanMentions(b.mentions), everyone: b.everyone === true, send_at: sendAt,
    }, files);
    res.json(serialize(r));
  });

  api.post('/dms/:id/scheduled-messages', auth, (req, res) => {
    const d = requireDm(req.params.id, req.userId);
    limitScheduling(req);
    if (isBlocked(d.user_a, d.user_b)) fail(403, 'You can’t message this person.');
    const peer = getUserRow(peerOf(d, req.userId));
    if (!peer || peer.deleted_at) fail(403, 'This account was deleted.', 'deleted');
    const b = req.body || {};
    validCipher(b.ciphertext);
    const ref = checkRef(b.ref);
    const draft = checkDraft(b.draft);
    const sendAt = checkSendAt(b.sendAt);
    checkTtl(b, d.disappear_secs);
    roomFor(req.userId);
    const r = create({
      user_id: req.userId, dm_id: d.id, reply_to: dmReplyIn(d, b.replyTo), ciphertext: b.ciphertext, ref, draft, session_id: req.session.id,
      own_key: ownKey(getUserRow(req.userId), false), peer_key: peerKey(peer), ttl: ttlOf(b), send_at: sendAt,
    }, cleanFiles(b.files));
    res.json(serialize(r));
  });

  // New ciphertext for one already scheduled (an edit, a re-encrypt, a confirmation, or Send now's copy): it takes the
  // keys of now and this session, so a held one is pending again. Checked like a message sent now: the current epoch
  // for a channel, the other person's current key for a DM, the conversation's disappearing timer (ttl, keeping the
  // stricter of that and the one it was written for). Returns the columns that change; ciphertext and draft are
  // checked by the caller.
  function reencrypted(r, b, req, conv) {
    const set = {};
    const u = getUserRow(req.userId);
    if (r.channel_id) set.epoch = requireCurrentEpoch(r.server_id, b.epoch);
    else {
      const d = db.prepare('SELECT user_a, user_b FROM dm_channels WHERE id = ?').get(r.dm_id);
      const peer = getUserRow(peerOf(d, req.userId));
      if (!peer || peer.deleted_at) fail(403, 'This account was deleted.', 'deleted');
      set.peer_key = peerKey(peer);
    }
    // New ciphertext is checked against the conversation's disappearing timer as it is now, and keeps the stricter
    // of that and the one it was written for (the app puts the same one inside it, x).
    checkTtl(b, conv.disappear_secs);
    set.ttl = keepTtl(r.ttl, ttlOf(b));
    Object.assign(set, { ciphertext: b.ciphertext, own_key: ownKey(u, !!r.channel_id), session_id: req.session.id, updated_at: now(), status: 'pending', reason: null, told_at: null });
    // Who it pings goes with the words: new words replace them, so an @everyone or @name edited out pings nobody.
    if (r.channel_id) {
      set.mentions = JSON.stringify(cleanMentions(b.mentions));
      set.everyone = b.everyone === true ? 1 : 0;
    }
    return set;
  }

  // Reschedule (sendAt), or edit, re-encrypt or confirm (ciphertext with the sender's copy, and the current epoch for a
  // channel). New ciphertext takes the keys of now and this session, so a held one is pending again. The conversation
  // must still be yours to open.
  api.patch('/scheduled-messages/:id', auth, (req, res) => {
    rateLimit('schededit:' + req.userId, 60, 60000);
    const r = own(req.params.id, req.userId);
    if (r.status === 'failed') fail(409, 'This one wasn’t sent. Dismiss it and write it again.', 'failed');
    const b = req.body || {};
    if (b.sendAt === undefined && b.ciphertext === undefined) fail(400, 'Nothing to change.');
    const conv = r.channel_id ? requireChannel(r.channel_id, req.userId) : requireDm(r.dm_id, req.userId);
    const set = {};
    if (b.sendAt !== undefined) set.send_at = checkSendAt(b.sendAt);
    if (b.ciphertext !== undefined) {
      validCipher(b.ciphertext);
      set.draft = checkDraft(b.draft);
      // A held one whose time has passed goes out the moment it's pending again. Only when the request says so (or
      // gives a new time): an edit or a confirmation shouldn't quietly send a message that's hours or days late.
      if (r.status === 'held' && r.send_at <= now() && set.send_at === undefined && b.sendNow !== true) {
        fail(409, 'Its time has passed. Send it now, or pick a new time.', 'overdue');
      }
      Object.assign(set, reencrypted(r, b, req, conv));
    } else if (r.status === 'held') fail(409, 'This message needs re-encrypting first.', 'held');
    const cols = Object.keys(set);
    db.prepare(`UPDATE scheduled_messages SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => set[k]), r.id);
    const fresh = rowOf(r.id);
    changed(fresh);
    arm();
    res.json(serialize(fresh));
  });

  // Send now. A refusal is answered and the message stays as it was (its time decides then); one that needs
  // re-encrypting is marked held. With new ciphertext ({ ciphertext, epoch?, ttl?, mentions?, everyone? }, checked like
  // an edit), that copy is the one posted: the app re-encrypts it with the moment it really goes out inside it
  // (public/js/binding.js), so readers' apps don't take it for a message this server re-dated. Refused, nothing
  // changes, the copy is dropped.
  api.post('/scheduled-messages/:id/send', auth, (req, res) => {
    const r = own(req.params.id, req.userId);
    if (r.status === 'failed') fail(409, 'This one wasn’t sent. Dismiss it and write it again.', 'failed');
    limitMessages(req);
    const b = req.body || {};
    let go = r;
    if (b.ciphertext !== undefined) {
      const conv = r.channel_id ? requireChannel(r.channel_id, req.userId) : requireDm(r.dm_id, req.userId);
      validCipher(b.ciphertext);
      go = { ...r, ...reencrypted(r, b, req, conv) };
    }
    const p = prepare(go);
    if (p.gone) fail(404, 'Scheduled message not found.');
    if (p.hold) { mark(r, 'held', p.hold); fail(409, WHY[p.hold], 'held'); }
    if (p.fail) fail(p.fail === 'no_access' ? 404 : 403, WHY[p.fail], p.fail);
    if (p.later) fail(429, `Slowmode is on. You can send another message in ${Math.ceil((p.later - now()) / 1000)}s.`, 'slowmode');
    res.json({ message: post(go, p) });
  });

  api.delete('/scheduled-messages/:id', auth, (req, res) => {
    rateLimit('scheddel:' + req.userId, 120, 60000);
    const r = own(req.params.id, req.userId);
    forget(r);
    emitTo(r.user_id, 'scheduled:remove', { id: r.id, messageId: null });
    arm();
    res.json({ ok: true });
  });

  return {
    // A server's key changed or needs replacing (called with every keys:state): what's waiting there with an older
    // key is held, so its sender's app re-encrypts it now rather than at its time.
    recheckServer(serverId) {
      const s = db.prepare('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?').get(serverId);
      if (!s) return;
      // Only members' (anyone else's fails at its time: they can't post there now).
      const rows = db.prepare(`SELECT * FROM scheduled_messages WHERE server_id = ? AND status = 'pending' AND (? = 1 OR epoch IS NOT ?)
        AND user_id IN (SELECT user_id FROM members WHERE server_id = ?)`).all(serverId, s.needs_rotation || !s.key_epoch ? 1 : 0, s.key_epoch, serverId);
      for (const r of rows) mark(r, 'held', 'key');
    },
    // Sessions ended (revokeSessions in index.js: logged out, signed out from elsewhere, a password change or reset,
    // staff): what they scheduled waits for the person to confirm it from a session still signed in.
    sessionsEnded(userId, sessionIds) {
      const gone = new Set(sessionIds);
      if (!gone.size) return;
      const rows = db.prepare("SELECT * FROM scheduled_messages WHERE user_id = ? AND status != 'failed'").all(userId).filter((r) => gone.has(r.session_id));
      for (const r of rows) mark(r, 'held', 'session_ended');
      if (rows.length) arm();
    },
    // A session got a new sign-in token (rotateToken in index.js): what it had waiting is held until the person's app
    // re-encrypts it from their own copy, so what a copy of the old token queued doesn't go out. (Ones already held
    // for a key change wait for the same thing; failed ones go nowhere anyway.)
    tokenRenewed(userId, sessionId) {
      const rows = db.prepare("SELECT * FROM scheduled_messages WHERE user_id = ? AND session_id = ? AND status = 'pending'").all(userId, sessionId);
      for (const r of rows) mark(r, 'held', 'token_renewed');
      if (rows.length) arm();
    },
    // The account was deleted: nothing it scheduled goes out.
    forgetUser(uid) { for (const r of db.prepare('SELECT * FROM scheduled_messages WHERE user_id = ?').all(uid)) forget(r); },
    MAX_PENDING, MAX_DAYS, WHY,
  };
};
