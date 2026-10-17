// Away after inactivity, and custom statuses that clear themselves.
//
// Away: every open app (one Socket.IO connection) reports whether it has gone unused for the account's "Away after"
// time (presence:idle { idle }). In a browser that means no input in the page; in the desktop app, no input on the
// computer at all (Electron's system idle time), so someone playing a game with Hearth in the background isn't
// Away. Someone whose status is Online shows as Away (presence 'idle') while EVERY one of their connections says
// idle, and Online again as soon as one doesn't: the server combines them (index.js presenceFor), so one device
// left alone never makes a person who's busy on another look away. A new connection starts out in use, and one
// that never reports (an older app) always counts as in use. Do Not Disturb, Away picked by hand and Invisible are
// never changed. The setting (5, 10, 15 or 30 minutes, or never; 10 by default) is on the account, so all of a
// person's devices follow the same one; with "never" the reports are ignored.
//
// Custom status expiry: PUT /me/custom-status takes how long the status should last (expiresIn, in ms, 1 minute to
// 8 days). The app works out "today" and "this week" in the person's own time zone and sends the length, so the
// server never needs their time zone and a clock that's off doesn't matter. A sweep (every STATUS_SWEEP_MS, 15 s by
// default) clears the ones that are due and tells everyone who can see the person, live. Until it runs, an expired
// status is already left out of everything the server sends (index.js publicUser). Setting a status from the
// profile editor (PATCH /me/profile) without changing it keeps its expiry; a new one there lasts until cleared.
//
// Limits: status, Away time and custom status changes together, 15 a minute and 120 an hour per account and 120
// a minute per network (each one reaches everyone who can see the person). Idle reports, 20 a minute per account:
// an app sends at most two per "Away after" period, and every change is sent to everyone on the instance.
//
// Routes
//   PATCH /me/status          { status?, awayAfter? }      Online / Away / Do not disturb / Invisible; the Away time
//   PUT   /me/custom-status   { emoji, text, expiresIn? }  set or clear the custom status (expiresIn: ms, or null)
// Socket.IO
//   presence:idle { idle }    from an app: whether it has gone unused for the account's "Away after" time

const jobs = require('./jobs');

const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const AWAY_CHOICES = [0, 5, 10, 15, 30]; // minutes; 0 = never
const MIN_EXPIRY_MS = 60000;
const MAX_EXPIRY_MS = 8 * 86400000; // "this week" from a Monday morning, with room for a daylight-saving change
const SWEEP_MS = Math.max(200, +(process.env.STATUS_SWEEP_MS || 0) || 15000);
// A status is one line: control characters (line breaks, tabs) become spaces.
const oneLine = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

module.exports = function setupPresence(ctx) {
  const { api, auth, db, fail, rateLimit, limitNet, now, getUserRow, parseProfile, sanitizeProfile, checkWords, requireUnlocked,
    broadcastUser, broadcastPresence, presenceFor, selfUser } = ctx;

  function limitStatus(req) {
    rateLimit('status:' + req.userId, 15, 60000);
    rateLimit('statush:' + req.userId, 120, 3600000);
    limitNet(req, 'status', 120, 60000);
  }

  api.patch('/me/status', auth, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    limitStatus(req);
    if (b.status === undefined && b.awayAfter === undefined) fail(400, 'Nothing to change.');
    if (b.status !== undefined && !STATUSES.includes(b.status)) fail(400, 'Unknown status.');
    if (b.awayAfter !== undefined && !AWAY_CHOICES.includes(b.awayAfter)) fail(400, 'Choose 5, 10, 15 or 30 minutes, or never.');
    const row = getUserRow(req.userId);
    const status = b.status === undefined ? row.status : b.status;
    const awayAfter = b.awayAfter === undefined ? row.away_after : b.awayAfter;
    if (status !== row.status || awayAfter !== row.away_after) {
      const before = presenceFor(row);
      db.prepare('UPDATE users SET status = ?, away_after = ? WHERE id = ?').run(status, awayAfter, req.userId);
      // Everyone: the new dot, if it changed (an Invisible account changing "Away after" tells nobody anything);
      // this person's own apps: the new settings.
      broadcastPresence(req.userId, before);
    }
    res.json({ ok: true, status, awayAfter });
  });

  api.put('/me/custom-status', auth, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    limitStatus(req);
    for (const k of ['emoji', 'text']) if (b[k] != null && typeof b[k] !== 'string') fail(400, 'A status is text.');
    const emoji = oneLine(b.emoji || '');
    const text = oneLine(b.text || '');
    if (emoji.length > 16) fail(400, 'Pick one emoji for your status.');
    if (text.length > 128) fail(400, 'A status can be up to 128 characters.');
    const clearing = !emoji && !text;
    // Anyone can clear theirs; setting one is changing the profile, which an admin may have locked.
    if (!clearing) requireUnlocked(req.userId);
    let expiresAt = null;
    if (!clearing && b.expiresIn != null) {
      if (!Number.isSafeInteger(b.expiresIn) || b.expiresIn < MIN_EXPIRY_MS || b.expiresIn > MAX_EXPIRY_MS) fail(400, 'A status can clear itself from 1 minute to a week from now.');
      expiresAt = now() + b.expiresIn;
    }
    checkWords(emoji, text);
    const row = getUserRow(req.userId);
    const json = JSON.stringify(sanitizeProfile({ customStatus: { emoji, text } }, parseProfile(row)));
    if (json !== row.profile || expiresAt !== (row.status_expires_at || null)) {
      db.prepare('UPDATE users SET profile = ?, status_expires_at = ? WHERE id = ?').run(json, expiresAt, req.userId);
      broadcastUser(req.userId);
    }
    res.json(selfUser(getUserRow(req.userId)));
  });

  // Statuses that are due: cleared, and everyone who can see the person told (their own apps right away).
  const due = db.prepare('SELECT id, profile FROM users WHERE status_expires_at IS NOT NULL AND status_expires_at <= ? LIMIT 500');
  const clearOne = db.prepare('UPDATE users SET profile = ?, status_expires_at = NULL WHERE id = ? AND status_expires_at <= ?');
  function sweep() {
    const t = now();
    for (const r of due.all(t)) {
      const json = JSON.stringify(sanitizeProfile({ customStatus: { emoji: '', text: '' } }, parseProfile(r)));
      if (clearOne.run(json, r.id, t).changes) broadcastUser(r.id);
    }
  }
  jobs.every('status.expire', SWEEP_MS, sweep);

  // presence:idle from one connection. Only a change counts against the limit; a refused one leaves things as
  // they were (the app tries again on its next check).
  function setIdle(socket, p) {
    const idle = !!(p && p.idle === true);
    if (!!socket.data.idle === idle) return;
    rateLimit('idle:' + socket.userId, 20, 60000);
    const row = getUserRow(socket.userId);
    const before = row && presenceFor(row);
    socket.data.idle = idle;
    if (row && presenceFor(row) !== before) broadcastPresence(socket.userId);
  }

  return { setIdle, sweep, limitStatus };
};

module.exports.AWAY_CHOICES = AWAY_CHOICES;
module.exports.MAX_EXPIRY_MS = MAX_EXPIRY_MS;
