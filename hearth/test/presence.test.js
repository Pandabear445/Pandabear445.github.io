// Automatic Away and custom statuses that clear themselves (server/presence.js, public/js/presence.js).
// Away: someone whose status is Online shows as Away only while every one of their open apps says it's idle, comes
// back the moment one is in use, and Do Not Disturb, Invisible and Away picked by hand never change. Custom status:
// it can clear itself after a set time, the server clears it when it's due and tells everyone live, and an expired
// one is never sent out. Status changes and idle reports are rate-limited and checked.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, hex, sleep } = require('./helpers');

let srv;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const ack = (s, ev, p, ms = 5000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.emit(ev, p, (x) => { clearTimeout(t); r(x); }); });
// The next event of a kind that matches (null if none comes in time).
const next = (s, ev, match = () => true, ms = 4000) => new Promise((r) => {
  const on = (x) => { if (!match(x)) return; clearTimeout(t); s.off(ev, on); r(x); };
  const t = setTimeout(() => { s.off(ev, on); r(null); }, ms);
  s.on(ev, on);
});
// A presence change for this person in a user:presence list (sent to everyone, about once a second).
const presenceOf = (s, uid, ms) => next(s, 'user:presence', (list) => list.some((x) => x.id === uid), ms).then((list) => (list ? list.find((x) => x.id === uid).presence : null));
const shownAs = async (viewer, uid) => (await as(viewer, 'GET', `/users/${uid}`)).json.presence;
const me = async (u) => (await as(u, 'GET', '/bootstrap')).json.me;
const idle = (s, on) => ack(s, 'presence:idle', { idle: on });

// Two people in one server, so each sees the other's profile changes.
async function pair() {
  const a = await srv.register(); const b = await srv.register();
  const server = (await as(a, 'POST', '/servers', { name: 'Hall ' + hex(3) })).json;
  const invite = (await as(a, 'POST', `/servers/${server.id}/invites`, {})).json;
  assert.equal((await as(b, 'POST', `/invites/${invite.code}/join`)).status, 200);
  return { a, b, server };
}

// The sweep runs every 300 ms here, so expired statuses clear quickly.
before(async () => { srv = await startServer({ STATUS_SWEEP_MS: '300' }); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

test('away: defaults, and the "Away after" setting takes only 5, 10, 15, 30 minutes or never', async () => {
  const u = await srv.register();
  let m = await me(u);
  assert.equal(m.awayAfter, 10, 'ten minutes unless changed');
  assert.equal(m.autoAway, false);
  assert.equal(m.customStatusExpiresAt, null);
  for (const bad of [7, -5, '10', 10.5, 600, null, true, [10]]) {
    const r = await as(u, 'PATCH', '/me/status', { awayAfter: bad });
    assert.equal(r.status, 400, `awayAfter ${JSON.stringify(bad)} is refused`);
  }
  assert.equal((await as(u, 'PATCH', '/me/status', {})).status, 400, 'nothing to change');
  assert.equal((await as(u, 'PATCH', '/me/status', { status: 'away' })).status, 400, 'unknown status');
  assert.equal((await as(u, 'PATCH', '/me/status', { status: 'offline' })).status, 400, 'offline is not a status you pick');
  const r = await as(u, 'PATCH', '/me/status', { awayAfter: 0 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, status: 'online', awayAfter: 0 });
  m = await me(u);
  assert.equal(m.awayAfter, 0);
  assert.equal(srv.sql('SELECT away_after FROM users WHERE id = ?', u.id)[0].away_after, 0);
  assert.equal((await as(u, 'PATCH', '/me/status', { status: 'dnd', awayAfter: 30 })).status, 200);
  m = await me(u);
  assert.equal(m.status, 'dnd');
  assert.equal(m.awayAfter, 30);
  assert.equal((await srv.api('PATCH', '/me/status', { body: { awayAfter: 5 } })).status, 401, 'signed in only');
  assert.equal((await srv.api('PUT', '/me/custom-status', { body: { text: 'x' } })).status, 401, 'signed in only');
});

test('away: only once every one of the person\'s apps is idle, and back as soon as one is in use', async () => {
  const { a, b } = await pair();
  const watcher = await sock(b);
  const s1 = await sock(a); const s2 = await sock(a);
  await presenceOf(watcher, a.id, 2500); // coming online
  assert.equal(await shownAs(b, a.id), 'online');

  // One window idle, the other still in use: still Online, and nobody is told anything.
  assert.deepEqual(await idle(s1, true), { ok: true });
  assert.equal(await presenceOf(watcher, a.id, 1800), null, 'no change while another window is in use');
  assert.equal(await shownAs(b, a.id), 'online');

  // Both idle: Away for everyone, and their own apps hear it's automatic.
  const selfUpdate = next(s1, 'user:update', (u) => u.id === a.id && u.autoAway === true);
  const change = presenceOf(watcher, a.id);
  assert.deepEqual(await idle(s2, true), { ok: true });
  assert.equal(await change, 'idle');
  assert.ok(await selfUpdate, 'their own apps are told they show as Away');
  assert.equal(await shownAs(b, a.id), 'idle');
  const mine = await me(a);
  assert.equal(mine.status, 'online', 'the status they picked stays Online');
  assert.equal(mine.autoAway, true);
  assert.equal(mine.presence, 'idle');
  // Saying idle again changes nothing.
  assert.deepEqual(await idle(s2, true), { ok: true });

  // Back on one window: Online right away.
  const back = presenceOf(watcher, a.id);
  assert.deepEqual(await idle(s1, false), { ok: true });
  assert.equal(await back, 'online');
  assert.equal((await me(a)).autoAway, false);

  // The window in use closes while the other is idle: Away.
  const gone = presenceOf(watcher, a.id);
  s1.close();
  assert.equal(await gone, 'idle', 'the only window left is idle');
  // A new window starts out in use: Online again.
  const fresh = presenceOf(watcher, a.id);
  const s3 = await sock(a);
  assert.equal(await fresh, 'online');
  // Every window closed: Offline (not Away).
  const off = presenceOf(watcher, a.id);
  s2.close(); s3.close();
  assert.equal(await off, 'offline');
  assert.equal(await shownAs(b, a.id), 'offline');
});

test('away: a new sign-in token (auth-11) closes the windows on the old one; back on the new token they start in use and report again', async () => {
  const { a, b } = await pair();
  const watcher = await sock(b);
  const s1 = await sock(a); const s2 = await sock(a);
  const told = [];
  s1.on('session:revoked', (p) => told.push(p));
  await presenceOf(watcher, a.id, 2500);
  const away = presenceOf(watcher, a.id);
  assert.deepEqual(await idle(s1, true), { ok: true });
  assert.deepEqual(await idle(s2, true), { ok: true });
  assert.equal(await away, 'idle');
  // The password changes on this device: the same session goes on with a new token, and both windows (on the old
  // one) are closed, which leaves nobody here: Offline, not Away.
  const off = presenceOf(watcher, a.id);
  const r = await as(a, 'POST', '/me/password', { oldAuthKey: a.authKey, newAuthKey: hex(32), encPrivateKey: 'x'.repeat(80), salt: 'A'.repeat(24) });
  assert.equal(r.status, 200, r.text);
  assert.equal(await off, 'offline');
  assert.deepEqual(told, [{ reason: 'token_rotated' }]);
  await assert.rejects(srv.socket(a.token), /unauthorized/, 'the old token can’t connect');
  // Back with the new token: in use, then idle again by its own report.
  a.token = r.json.token;
  const on = presenceOf(watcher, a.id);
  const s3 = await sock(a);
  assert.equal(await on, 'online');
  const again = presenceOf(watcher, a.id);
  assert.deepEqual(await idle(s3, true), { ok: true });
  assert.equal(await again, 'idle');
  assert.equal((await me(a)).autoAway, true);
});

test('away: never over Do Not Disturb, Invisible or Away picked by hand, and "never" turns it off', async () => {
  const { a, b } = await pair();
  const watcher = await sock(b);
  const s = await sock(a);
  await presenceOf(watcher, a.id, 2500);

  assert.equal((await as(a, 'PATCH', '/me/status', { status: 'dnd' })).status, 200);
  assert.equal(await presenceOf(watcher, a.id), 'dnd');
  await idle(s, true);
  assert.equal(await presenceOf(watcher, a.id, 1800), null, 'Do Not Disturb stays');
  assert.equal(await shownAs(b, a.id), 'dnd');
  assert.equal((await me(a)).autoAway, false);

  assert.equal((await as(a, 'PATCH', '/me/status', { status: 'invisible' })).status, 200);
  assert.equal(await presenceOf(watcher, a.id), 'offline');
  assert.equal(await shownAs(b, a.id), 'offline', 'Invisible stays offline, idle or not');

  // Picking Online while every app is idle: Away until one is in use again.
  assert.equal((await as(a, 'PATCH', '/me/status', { status: 'online' })).status, 200);
  assert.equal(await presenceOf(watcher, a.id), 'idle');

  // "Never": shown as Online at once, and idle reports change nothing.
  assert.equal((await as(a, 'PATCH', '/me/status', { awayAfter: 0 })).status, 200);
  assert.equal(await presenceOf(watcher, a.id), 'online');
  await idle(s, false);
  await idle(s, true);
  assert.equal(await presenceOf(watcher, a.id, 1800), null);
  assert.equal(await shownAs(b, a.id), 'online');
  // Turning it back on while idle: Away.
  assert.equal((await as(a, 'PATCH', '/me/status', { awayAfter: 5 })).status, 200);
  assert.equal(await presenceOf(watcher, a.id), 'idle');
  // A manual Away is just Away, and stays Away when the app is in use.
  assert.equal((await as(a, 'PATCH', '/me/status', { status: 'idle' })).status, 200);
  await idle(s, false);
  assert.equal(await shownAs(b, a.id), 'idle');
  assert.equal((await me(a)).autoAway, false, 'chosen, not automatic');
});

test('away: someone Invisible or on Do Not Disturb gives nothing away by opening or closing windows', async () => {
  // Presence goes to every socket on the instance, so each entry is visible to everyone: one sent while what
  // people see stays the same would tell them the account is connected and picking up or putting down devices.
  for (const status of ['invisible', 'dnd']) {
    const v = await srv.register();
    const stranger = await srv.register(); // shares nothing with v: presence reaches everyone anyway
    const w = await sock(stranger);
    const seen = [];
    w.on('user:presence', (list) => list.filter((x) => x.id === v.id).forEach((x) => seen.push(x.presence)));
    assert.equal((await as(v, 'PATCH', '/me/status', { status })).status, 200);
    await sleep(1300);
    seen.length = 0;
    const shown = status === 'invisible' ? 'offline' : 'dnd';
    // The first window (an Invisible account coming online included), reported idle.
    const desk = await sock(v);
    assert.deepEqual(await idle(desk, true), { ok: true });
    await sleep(1300);
    if (status === 'invisible') assert.deepEqual(seen, [], 'an Invisible account connecting tells nobody');
    else assert.deepEqual(seen, ['dnd'], 'coming online on Do Not Disturb shows as such');
    seen.length = 0;
    // Another device opens and closes while the first is idle.
    const phone = await sock(v);
    await sleep(1300);
    assert.deepEqual(seen, [], `${status}: a second window opening tells nobody`);
    phone.close();
    await sleep(1300);
    assert.deepEqual(seen, [], `${status}: nor its closing`);
    // Changing "Away after" tells only their own apps.
    const own = next(desk, 'user:update', (u) => u.id === v.id && u.awayAfter === 30);
    assert.equal((await as(v, 'PATCH', '/me/status', { awayAfter: 30 })).status, 200);
    assert.ok(await own, 'their own apps get the new setting');
    await sleep(1300);
    assert.deepEqual(seen, [], `${status}: changing "Away after" tells nobody`);
    assert.equal(await shownAs(stranger, v.id), shown);
    // The last window closing.
    desk.close();
    await sleep(1300);
    if (status === 'invisible') assert.deepEqual(seen, [], 'an Invisible account going offline tells nobody');
    else assert.deepEqual(seen, ['offline']);
  }
});

test('away: idle reports are limited, and a refused one changes nothing', async () => {
  const u = await srv.register();
  const s = await sock(u);
  let refused = null; let sent = 0;
  for (let i = 0; i < 30 && !refused; i++) {
    const r = await idle(s, i % 2 === 0);
    if (r && r.error) refused = { r, idle: i % 2 === 0 }; else sent++;
  }
  assert.ok(refused, 'flipping back and forth is refused after a while');
  assert.equal(sent, 20, '20 changes a minute');
  assert.match(refused.r.error, /Too many attempts/);
  // The refused change didn't happen: the last accepted report (idle false after an even count) stands.
  assert.equal(await shownAs(u, u.id), 'online');
  // Repeating the current state isn't a change, so it's never refused.
  assert.deepEqual(await idle(s, false), { ok: true });
  // Junk is just "in use".
  assert.deepEqual(await ack(s, 'presence:idle', { idle: 'yes' }), { ok: true });
  assert.deepEqual(await ack(s, 'presence:idle', null), { ok: true });
});

test('status changes are limited: 15 a minute, custom statuses included', async () => {
  const u = await srv.register();
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await as(u, 'PATCH', '/me/status', { status: i % 2 ? 'online' : 'dnd' })).status);
  for (let i = 0; i < 5; i++) codes.push((await as(u, 'PUT', '/me/custom-status', { text: `busy ${i}` })).status);
  assert.deepEqual(codes, Array(15).fill(200));
  const r = await as(u, 'PATCH', '/me/status', { status: 'online' });
  assert.equal(r.status, 429);
  assert.equal((await as(u, 'PUT', '/me/custom-status', { text: 'one more' })).status, 429);
  // Through the profile editor too, when the status itself changes (other profile edits aren't status changes).
  assert.equal((await as(u, 'PATCH', '/me/profile', { customStatus: { emoji: '', text: 'sneaky' } })).status, 429);
  assert.equal((await as(u, 'PATCH', '/me/profile', { bio: 'still fine' })).status, 200);
  assert.equal((await me(u)).profile.customStatus.text, 'busy 4');
});

test('custom status: set with a time to clear, checked, and cleared live by the server when it\'s due', async () => {
  const { a, b } = await pair();
  const watcherB = await sock(b);
  const selfA = await sock(a);

  // Validation (someone else, so these don't use up a's status changes).
  const v = await srv.register();
  const bad = [
    [{ text: 'x', expiresIn: 59999 }, /1 minute to a week/],
    [{ text: 'x', expiresIn: 8 * 86400000 + 1 }, /1 minute to a week/],
    [{ text: 'x', expiresIn: '3600000' }, /1 minute to a week/],
    [{ text: 'x', expiresIn: 90000.5 }, /1 minute to a week/],
    [{ text: 'x', expiresIn: -60000 }, /1 minute to a week/],
    [{ text: 'x'.repeat(129) }, /128 characters/],
    [{ emoji: '😀'.repeat(9), text: 'x' }, /one emoji/],
    [{ text: { toString: 'x' } }, /is text/],
    [{ text: ['x'] }, /is text/],
  ];
  for (const [body, msg] of bad) {
    const r = await as(v, 'PUT', '/me/custom-status', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, msg);
  }

  // Set: one line, with its time. Others see the status; only the person sees when it clears.
  const seen = next(watcherB, 'user:update', (u) => u.id === a.id && u.profile.customStatus.text === 'At lunch back soon');
  const t0 = Date.now();
  let r = await as(a, 'PUT', '/me/custom-status', { emoji: '🍜', text: '  At lunch\nback soon ', expiresIn: 3600000 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.profile.customStatus.text, 'At lunch back soon');
  assert.equal(r.json.profile.customStatus.emoji, '🍜');
  assert.ok(Math.abs(r.json.customStatusExpiresAt - (t0 + 3600000)) < 5000, 'clears an hour from now');
  const pub = await seen;
  assert.ok(pub, 'people who share a server are told live');
  assert.equal(pub.customStatusExpiresAt, undefined, 'the time it clears is the person\'s own business');
  assert.equal((await as(b, 'GET', `/users/${a.id}`)).json.profile.customStatus.text, 'At lunch back soon');

  // The profile editor sends everything back: the same status keeps its time, a new one lasts until cleared.
  r = await as(a, 'PATCH', '/me/profile', { bio: 'hello', customStatus: { emoji: '🍜', text: 'At lunch back soon' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.customStatusExpiresAt, 'unchanged status keeps its time');
  r = await as(a, 'PATCH', '/me/profile', { customStatus: { emoji: '', text: 'In a meeting' } });
  assert.equal(r.json.customStatusExpiresAt, null, 'a new status from the editor stays until cleared');
  assert.equal(srv.sql('SELECT status_expires_at FROM users WHERE id = ?', a.id)[0].status_expires_at, null);

  // Due: the server clears it and tells everyone, without anyone asking.
  r = await as(a, 'PUT', '/me/custom-status', { text: 'Gone fishing', expiresIn: 60000 });
  assert.equal(r.status, 200);
  const cleared = next(watcherB, 'user:update', (u) => u.id === a.id && !u.profile.customStatus.text, 5000);
  const clearedSelf = next(selfA, 'user:update', (u) => u.id === a.id && !u.profile.customStatus.text && u.customStatusExpiresAt === null, 5000);
  srv.sql('UPDATE users SET status_expires_at = ? WHERE id = ?', Date.now() - 1000, a.id); // as if the minute had passed
  assert.ok(await cleared, 'the people who can see them are told it cleared');
  assert.ok(await clearedSelf, 'and so are their own apps');
  const row = srv.sql('SELECT profile, status_expires_at FROM users WHERE id = ?', a.id)[0];
  assert.equal(row.status_expires_at, null);
  assert.deepEqual(JSON.parse(row.profile).customStatus, { emoji: '', text: '' });
  assert.equal(JSON.parse(row.profile).bio, 'hello', 'nothing else on the profile changes');

  // Clearing takes no time, and a cleared status has no time either.
  await as(a, 'PUT', '/me/custom-status', { text: 'brb', expiresIn: 600000 });
  r = await as(a, 'PUT', '/me/custom-status', { emoji: '', text: '', expiresIn: 600000 });
  assert.equal(r.status, 200);
  assert.equal(r.json.customStatusExpiresAt, null);
  assert.equal(r.json.profile.customStatus.text, '');
});

test('custom status: the word filter and a locked profile apply, but anyone can clear theirs', async () => {
  const u = await srv.register();
  assert.equal((await as(u, 'PUT', '/me/custom-status', { text: 'set before the lock' })).status, 200);
  const owner = srv.owner;
  assert.equal((await srv.api('PUT', '/admin/words', { token: owner.token, ip: owner.ip, body: { words: ['grapefruit'] } })).status, 200);
  try {
    const r = await as(u, 'PUT', '/me/custom-status', { text: 'I love Grapefruit' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /isn.t allowed/);
  } finally { await srv.api('PUT', '/admin/words', { token: owner.token, ip: owner.ip, body: { words: [] } }); }

  const lock = await srv.api('PATCH', `/admin/users/${u.id}/limits`, { token: owner.token, ip: owner.ip, body: { profileLocked: true } });
  assert.equal(lock.status, 200, lock.text);
  assert.equal((await as(u, 'PUT', '/me/custom-status', { text: 'new words', expiresIn: 600000 })).status, 403);
  const r = await as(u, 'PUT', '/me/custom-status', { text: '' });
  assert.equal(r.status, 200, 'clearing still works');
  assert.equal(r.json.profile.customStatus.text, '');
});

test('custom status: one past its time is never sent out, even before the sweep clears it', async () => {
  // A server whose sweep won't run during this test.
  await srv.restart({ STATUS_SWEEP_MS: '3600000' });
  const { a, b } = await pair();
  assert.equal((await as(a, 'PUT', '/me/custom-status', { emoji: '☕', text: 'Coffee', expiresIn: 60000 })).status, 200);
  srv.sql('UPDATE users SET status_expires_at = ? WHERE id = ?', Date.now() - 1, a.id);
  const pub = (await as(b, 'GET', `/users/${a.id}`)).json;
  assert.deepEqual(pub.profile.customStatus, { emoji: '', text: '' });
  const boot = (await as(b, 'GET', '/bootstrap')).json;
  assert.deepEqual(boot.users[a.id].profile.customStatus, { emoji: '', text: '' }, 'nor in member lists');
  const mine = await me(a);
  assert.deepEqual(mine.profile.customStatus, { emoji: '', text: '' });
  assert.equal(mine.customStatusExpiresAt, null);
  assert.ok(srv.sql('SELECT status_expires_at FROM users WHERE id = ?', a.id)[0].status_expires_at, 'still waiting for the sweep');
  await srv.restart({ STATUS_SWEEP_MS: '300' });
  for (let i = 0; i < 40 && srv.sql('SELECT status_expires_at FROM users WHERE id = ?', a.id)[0].status_expires_at; i++) await sleep(100);
  assert.equal(srv.sql('SELECT status_expires_at FROM users WHERE id = ?', a.id)[0].status_expires_at, null, 'and the sweep clears it after a restart too');
});

// ------------------------------------------------------------------ the app's side (public/js/presence.js)
const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;

test('app: "Clear after" lengths in the person\'s own time, and how they read', async () => {
  const P = await import(js('presence.js'));
  const mon = new Date(2026, 9, 12, 9, 0); // a Monday, 09:00 local time
  assert.equal(P.clearAfterMs('30m', mon), 30 * 60000);
  assert.equal(P.clearAfterMs('1h', mon), 3600000);
  assert.equal(P.clearAfterMs('4h', mon), 4 * 3600000);
  assert.equal(P.clearAfterMs('never', mon), null);
  assert.equal(P.clearAfterMs('junk', mon), null);
  assert.equal(P.clearAfterMs('today', mon), 15 * 3600000, 'until midnight');
  assert.equal(new Date(mon.getTime() + P.clearAfterMs('week', mon, 1)).getDay(), 1, 'weeks starting Monday end at the start of the next Monday');
  assert.equal(new Date(mon.getTime() + P.clearAfterMs('week', mon, 0)).getDay(), 0, 'weeks starting Sunday end at the start of Sunday');
  assert.ok(P.clearAfterMs('week', mon, 1) <= 7 * 86400000);
  const sunLate = new Date(2026, 9, 18, 23, 59, 40);
  assert.equal(P.clearAfterMs('today', sunLate), 60000, 'never less than the server\'s shortest');
  assert.equal(P.clearAfterMs('week', sunLate, 1), 60000);
  const monStart = new Date(2026, 9, 12, 0, 0, 1);
  assert.ok(P.clearAfterMs('week', monStart, 1) < 7 * 86400000 + 3600000, 'a whole week at most');
  assert.equal(P.weekStart('en-US'), 0);
  assert.equal(P.weekStart('de-DE'), 1);
  assert.ok([0, 1, 6].includes(P.weekStart('not a locale!')));
  assert.match(P.clearsLabel(mon.getTime() + P.clearAfterMs('today', mon), mon), /^Clears at 11:59/);
  assert.match(P.clearsLabel(mon.getTime() + 20 * 3600000, mon), /^Clears tomorrow at /);
  assert.match(P.clearsLabel(mon.getTime() + P.clearAfterMs('week', mon, 1), mon), /^Clears Sunday at 11:59/);
  assert.equal(P.clearsLabel(null), 'Stays until you clear it.');
  assert.equal(P.CLEAR_AFTER.length, 6);
});

test('app: reports idle after the person\'s time, back on the first input, and the desktop app\'s system idle time wins', async () => {
  const P = await import(js('presence.js'));
  const listeners = {}; const docListeners = {};
  let clock = 1_000_000;
  const realNow = Date.now; const realInterval = globalThis.setInterval;
  const sent = []; let refuse = false;
  const socket = { connected: true, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, emit(ev, p, cb) { sent.push([ev, p.idle]); cb(refuse ? { error: 'Slow down.' } : { ok: true }); } };
  globalThis.window = { addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); } };
  globalThis.document = { hidden: false, addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); } };
  let minutes = 10;
  let away;
  Date.now = () => clock;
  globalThis.setInterval = () => 0; // the test runs the checks itself
  try {
    away = P.initAway({ socket, minutes: () => minutes });
    await away.check();
    assert.deepEqual(sent, [], 'in use: nothing to say');
    clock += 9 * 60000; await away.check();
    assert.deepEqual(sent, []);
    clock += 61000; await away.check();
    assert.deepEqual(sent, [['presence:idle', true]], 'idle after ten minutes');
    await away.check();
    assert.equal(sent.length, 1, 'said once');
    listeners.pointermove[0]();
    assert.deepEqual(sent[1], ['presence:idle', false], 'back on the first input, without waiting for a check');
    listeners.keydown[0]();
    assert.equal(sent.length, 2);
    // Coming back into view counts as use.
    clock += 11 * 60000; await away.check();
    docListeners.visibilitychange[0]();
    assert.deepEqual(sent.slice(-2), [['presence:idle', true], ['presence:idle', false]]);
    // "Never".
    minutes = 0; clock += 60 * 60000; await away.check();
    assert.equal(sent.length, 4);
    // A refused report is tried again on the next check.
    minutes = 5; refuse = true; await away.check();
    assert.deepEqual(sent[4], ['presence:idle', true]);
    refuse = false; await away.check();
    assert.deepEqual(sent[5], ['presence:idle', true]);
    // A new connection starts as "in use" on the server, so the app says idle again.
    socket.handlers.connect();
    await sleep(0);
    assert.deepEqual(sent[6], ['presence:idle', true]);

    // The desktop app: the computer's idle time, not this page's input.
    sent.length = 0;
    let systemIdle = 0;
    globalThis.window = { addEventListener: () => {}, hearthDesktop: { idleSeconds: async () => systemIdle } };
    const desk = P.initAway({ socket: { ...socket, handlers: {} }, minutes: () => 10 });
    clock += 60 * 60000; // nothing in this page for an hour, but the computer is in use
    await desk.check();
    assert.deepEqual(sent, [], 'in use elsewhere on the computer');
    systemIdle = 601; await desk.check();
    assert.deepEqual(sent, [['presence:idle', true]]);
    systemIdle = 3; await desk.check();
    assert.deepEqual(sent[1], ['presence:idle', false]);
    // An older desktop app without the bridge call falls back to the page.
    globalThis.window = { addEventListener: () => {}, hearthDesktop: { idleSeconds: async () => { throw new Error('no handler'); } } };
    sent.length = 0;
    const old = P.initAway({ socket: { ...socket, handlers: {} }, minutes: () => 10 });
    clock += 11 * 60000; await old.check();
    assert.deepEqual(sent, [['presence:idle', true]]);

    // In a call: in use whatever the input says (watching a shared screen, say), in a browser and in the desktop
    // app, and the time starts again when the call ends.
    sent.length = 0;
    let inCall = true; systemIdle = 3600;
    globalThis.window = { addEventListener: () => {}, hearthDesktop: { idleSeconds: async () => systemIdle } };
    const call = P.initAway({ socket: { ...socket, handlers: {} }, minutes: () => 10, busy: () => inCall });
    clock += 60 * 60000; await call.check();
    assert.deepEqual(sent, [], 'an hour in a call without input is still in use');
    inCall = false; clock += 9 * 60000; await call.check();
    assert.deepEqual(sent, [], 'and the Away time counts from the end of the call');
    clock += 61000; await call.check();
    assert.deepEqual(sent, [['presence:idle', true]]);
    // used(): input the page hears about from elsewhere (the Study page's frame) brings it back at once, and
    // counts in the desktop app too.
    call.used();
    assert.deepEqual(sent[1], ['presence:idle', false]);
    clock += 5 * 60000; await call.check();
    assert.equal(sent.length, 2, 'the frame\'s input counts like the page\'s');
  } finally {
    Date.now = realNow; globalThis.setInterval = realInterval;
    delete globalThis.window; delete globalThis.document;
  }
});

test('app: in the Android app, going to the background says nothing by itself, the app\'s own events aren\'t input, and coming back is', async () => {
  const P = await import(js('presence.js'));
  const listeners = {}; const docListeners = {};
  let clock = 5_000_000;
  const realNow = Date.now; const realInterval = globalThis.setInterval;
  const sent = [];
  const socket = { connected: true, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, emit(ev, p, cb) { sent.push([ev, p.idle]); cb({ ok: true }); } };
  const fire = (ev) => (listeners[ev] || []).forEach((fn) => fn({ detail: true }));
  // The Android app's page: no desktop bridge, input only from the page itself (public/js/android.js).
  globalThis.window = { HearthAndroid: {}, addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); } };
  globalThis.document = { hidden: false, addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); } };
  Date.now = () => clock;
  globalThis.setInterval = () => 0;
  try {
    let inCall = false;
    const away = P.initAway({ socket, minutes: () => 10, busy: () => inCall });
    // Sent to the background: nothing is reported then, and Away comes only after the person's time, as anywhere.
    document.hidden = true;
    docListeners.visibilitychange.forEach((fn) => fn());
    clock += 9 * 60000; await away.check();
    assert.deepEqual(sent, [], 'going to the background is not being away');
    // A push arriving, a notification's Hang up, an invite or a tapped notification's place: the app talking to the
    // page, not the person using it.
    for (const ev of ['hearth-push', 'hearth-hangup', 'hearth-open', 'hearth-invite', 'hearth-notification-click']) fire(ev);
    clock += 61000; await away.check();
    assert.deepEqual(sent, [['presence:idle', true]], 'Away after ten minutes in the background, whatever the app sent the page');
    // Opened again (the launcher, Recents or a notification): the page is visible, which is use, straight away.
    document.hidden = false;
    docListeners.visibilitychange.forEach((fn) => fn());
    assert.deepEqual(sent[1], ['presence:idle', false]);
    // In a call with the screen off (the app's call notification keeps it going): in use however long it lasts.
    inCall = true; document.hidden = true;
    docListeners.visibilitychange.forEach((fn) => fn());
    clock += 60 * 60000; await away.check();
    assert.equal(sent.length, 2, 'a call in the background is still use');
  } finally {
    Date.now = realNow; globalThis.setInterval = realInterval;
    delete globalThis.window; delete globalThis.document;
  }
});

test('app: going Away after joining a server is still "only presence" (the folders, keysReset and re-signed album art don\u2019t count)', async () => {
  const P = await import(js('presence.js'));
  // (secure.js brings api.js, which reads the stored token as it loads.)
  if (!globalThis.localStorage) globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const SEC = await import(js('secure.js'));
  const { a } = await pair();
  // The app's copy of you, as it would be after joining someone else's server by invite: its server:add carries
  // your public copy (which leaves keysReset out), and drawing the server bar puts the new server in your folder
  // order without saving it (folders.js).
  let mine = await me(a);
  const c = await srv.register();
  const hall = (await as(c, 'POST', '/servers', { name: 'Porch ' + hex(3) })).json;
  const inv = (await as(c, 'POST', `/servers/${hall.id}/invites`, {})).json;
  const s = await sock(a);
  const added = next(s, 'server:add', (x) => x.server.id === hall.id);
  assert.equal((await as(a, 'POST', `/invites/${inv.code}/join`)).status, 200);
  const add = await added;
  assert.ok(add && add.users[a.id], 'your own public copy comes with it');
  mine = SEC.mergeUser(mine, add.users[a.id]);
  assert.equal('keysReset' in mine, false);
  mine.rail = { ...mine.rail, order: [...mine.rail.order, 's:' + hall.id] };
  // Going Away: the update to your own apps differs from the app's copy only in presence (and autoAway).
  const update = next(s, 'user:update', (u) => u.id === a.id && u.autoAway === true);
  assert.deepEqual(await idle(s, true), { ok: true });
  const u = await update;
  assert.ok(u, 'told it shows as Away');
  assert.equal(u.keysReset, null);
  assert.deepEqual(u.rail.order, [], 'the server\u2019s copy of the folders has no order saved');
  assert.equal(P.onlyPresenceChanged(mine, u), true, 'just the dots: nothing rebuilt');
  // A song playing: its art link is signed again every few hours, which isn't a change; another song is.
  const song = (artSrc, title = 'Song') => ({ music: { title, artist: 'Band', art: 'https://art.example/a.jpg', artSrc } });
  assert.equal(P.onlyPresenceChanged({ ...mine, activity: song('/media/art/x?e=1&s=a') }, { ...u, activity: song('/media/art/x?e=2&s=b') }), true);
  assert.equal(P.onlyPresenceChanged({ ...mine, activity: song('/media/art/x?e=1&s=a') }, { ...u, activity: song('/media/art/x?e=1&s=a', 'Other') }), false);
  // Anything else that changed still redraws: a status, a reset mark appearing, an "Away after" time.
  assert.equal(P.onlyPresenceChanged(mine, { ...u, profile: { ...u.profile, customStatus: { emoji: '', text: 'Lunch' } } }), false);
  assert.equal(P.onlyPresenceChanged(mine, { ...u, keysReset: Date.now() }), false);
  assert.equal(P.onlyPresenceChanged(mine, { ...u, awayAfter: 30 }), false);
  assert.equal(P.onlyPresenceChanged(mine, { ...u, id: c.id }), false, 'about someone else');
  assert.equal(P.onlyPresenceChanged(null, u), false);
});

test('study page: input in the Recall frame counts as using Hearth, and says nothing else', () => {
  const fs = require('node:fs');
  const recall = fs.readFileSync(path.join(__dirname, '..', 'public', 'recall', 'recall.js'), 'utf8');
  const host = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'recall-host.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  // The frame: at most every 30 seconds, an empty "active".
  assert.match(recall, /if \(t - lastActive < 30000\) return; lastActive = t; hbSend\('active', \{\}\);/);
  // The host: only from its own frame (onMessage checks the source first), handed to the away tracker.
  assert.match(host, /if \(!frame \|\| e\.source !== frame\.contentWindow\) return;[\s\S]*if \(m\.t === 'active'\) \{ if \(ctx\.onActive\) ctx\.onActive\(\); return; \}/);
  assert.match(app, /onActive: \(\) => \{ if \(away\) away\.used\(\); \}/);
});

test('desktop: the idle time comes only from the main window showing the server, through the preload bridge', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('idle-time', \(e\) => \(fromOurPage\(e\) \? powerMonitor\.getSystemIdleTime\(\) : null\)\)/);
  assert.match(preload, /idleSeconds: \(\) => ipcRenderer\.invoke\('idle-time'\)/);
});
