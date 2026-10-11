// Calls, realtime events, relays and watch together: the hardening behind the voice audit findings.
// Most of this talks to a real server over Socket.IO, like an open app (or a script pretending to be one) would.
// The call engine (public/js/voice.js) and the connection rules (public/js/conn.js) run here too, with a fake
// WebRTC underneath, since the browser parts of a call can't be driven from Node.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { startServer, hex, sleep } = require('./helpers');

const P = { VIEW: 1, SEND: 2, MENTION_EVERYONE: 16, CONNECT: 64, SPEAK: 128 };
const TURN_SECRET = 'test-secret';
let srv;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
// Emits and waits for the server's answer (null if none comes).
const ack = (s, ev, p, ms = 5000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.emit(ev, p, (x) => { clearTimeout(t); r(x); }); });
// The next event of a kind (null if none comes in time).
const next = (s, ev, ms = 2000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.once(ev, (x) => { clearTimeout(t); r(x); }); });
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await sleep(25); } return true; };
const clientModule = (name) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', name)).href);

before(async () => { srv = await startServer({ TURN_SECRET, TURN_URL: 'turn:relay.example.test:3478?transport=udp' }); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

// An owner and some members in a fresh server (with its default text and voice channels).
async function community(n = 1) {
  const owner = await srv.register();
  const members = [];
  for (let i = 0; i < n; i++) members.push(await srv.register());
  const server = (await as(owner, 'POST', '/servers', { name: 'Voice ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const m of members) assert.equal((await as(m, 'POST', `/invites/${invite.code}/join`)).status, 200);
  return { owner, members, member: members[0], server, voiceCh: server.channels.find((c) => c.type === 'voice'), textCh: server.channels.find((c) => c.type === 'text') };
}
const everyoneRole = async (owner, server) => (await as(owner, 'GET', '/bootstrap')).json.servers.find((s) => s.id === server.id).roleDefs.find((r) => r.id === server.id);
const inCall = async (u, room) => ((await as(u, 'GET', '/bootstrap')).json.voice[room] || []);

// ------------------------------------------------------------------ voice-3 / authz-5: permissions change mid-call
test('voice-3: losing Connect through a role edit takes you out of the call (an unrelated edit doesn’t)', async () => {
  const { owner, member, server, voiceCh } = await community();
  const so = await sock(owner); const sm = await sock(member);
  assert.equal((await ack(so, 'voice:join', { channelId: voiceCh.id })).ok, true);
  assert.equal((await ack(sm, 'voice:join', { channelId: voiceCh.id })).ok, true);
  const everyone = await everyoneRole(owner, server);
  let kicked = next(sm, 'voice:kicked', 800);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone.permissions | P.MENTION_EVERYONE })).status, 200);
  assert.equal(await kicked, null, 'a change that keeps Connect keeps you in the call');
  kicked = next(sm, 'voice:kicked', 3000);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone.permissions & ~P.CONNECT })).status, 200);
  assert.ok(await kicked, 'the member is told they were taken out');
  assert.ok((await ack(sm, 'voice:signal', { to: so.id, data: { x: 1 } })).error, 'and can no longer signal anyone in the call');
  assert.deepEqual((await inCall(owner, voiceCh.id)).map((x) => x.userId), [owner.id]);
  assert.ok((await ack(sm, 'voice:join', { channelId: voiceCh.id })).error, 'nor join again');
});

test('authz-5: a role taken away or deleted ends access to its private call; later joiners don’t get them as peers', async () => {
  const { owner, members: [frank, gina], server } = await community(2);
  const vip = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'VIP', permissions: 0 })).json.id;
  const tmp = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'TMP', permissions: 0 })).json.id;
  const room = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'vip', type: 'voice' })).json;
  const grant = P.VIEW | P.CONNECT | P.SPEAK;
  assert.equal((await as(owner, 'PUT', `/channels/${room.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW },
    { type: 'role', id: vip, allow: grant, deny: 0 }, { type: 'role', id: tmp, allow: grant, deny: 0 }] })).status, 200);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${frank.id}/roles`, { roleIds: [vip] })).status, 200);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${gina.id}/roles`, { roleIds: [tmp] })).status, 200);
  const fsock = await sock(frank); const gsock = await sock(gina);
  assert.equal((await ack(fsock, 'voice:join', { channelId: room.id })).ok, true);
  assert.equal((await ack(gsock, 'voice:join', { channelId: room.id })).ok, true);
  const frankOut = next(fsock, 'voice:kicked', 3000);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${frank.id}/roles`, { roleIds: [] })).status, 200);
  assert.ok(await frankOut, 'role taken away: out of the call');
  const ginaOut = next(gsock, 'voice:kicked', 3000);
  assert.equal((await as(owner, 'DELETE', `/roles/${tmp}`)).status, 200);
  assert.ok(await ginaOut, 'role deleted: out of the call');
  const bs = await sock(owner);
  const join = await ack(bs, 'voice:join', { channelId: room.id });
  assert.equal(join.ok, true);
  assert.deepEqual(join.peers, [], 'nobody who lost access is handed to the next person as a peer');
});

test('voice-3: losing Speak mid-call turns the mic off and keeps it off; getting it back is announced too', async () => {
  const { owner, member, server, voiceCh } = await community();
  const so = await sock(owner); const sm = await sock(member);
  await ack(so, 'voice:join', { channelId: voiceCh.id });
  assert.equal((await ack(sm, 'voice:join', { channelId: voiceCh.id, muted: false })).canSpeak, true);
  const everyone = await everyoneRole(owner, server);
  let perms = next(sm, 'voice:perms', 3000);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone.permissions & ~P.SPEAK })).status, 200);
  assert.deepEqual(await perms, { channelId: voiceCh.id, canSpeak: false });
  const me = async () => (await inCall(owner, voiceCh.id)).find((x) => x.userId === member.id);
  assert.equal((await me()).muted, true, 'shown muted to everyone');
  await ack(sm, 'voice:update', { muted: false, deafened: false });
  assert.equal((await me()).muted, true, 'and can’t unmute without Speak');
  perms = next(sm, 'voice:perms', 3000);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone.permissions })).status, 200);
  assert.deepEqual(await perms, { channelId: voiceCh.id, canSpeak: true });
  await ack(sm, 'voice:update', { muted: false, deafened: false });
  assert.equal((await me()).muted, false, 'with Speak back, they can talk again');
});

// ------------------------------------------------------------------ voice-5: declining calls
test('voice-5: only someone who was rung can decline a call', async () => {
  const { owner, member, voiceCh } = await community();
  const outsider = await srv.register();
  const so = await sock(owner); const sx = await sock(outsider); const sm = await sock(member);
  await ack(so, 'voice:join', { channelId: voiceCh.id });
  const declined = collect(so, 'call:declined');
  assert.ok((await ack(sx, 'call:decline', { room: voiceCh.id })).error, 'an outsider is refused');
  assert.ok((await ack(sm, 'call:decline', { room: voiceCh.id })).error, 'a server voice channel doesn’t ring, so there’s nothing to decline');
  assert.ok((await ack(sx, 'call:decline', { room: 'dm:' + hex(8) })).error, 'nor a made-up call');
  await sleep(400);
  assert.equal(declined.length, 0, 'nobody in the call was told someone declined');
  // A group call: a member who was rung declines, and the caller hears about it.
  const group = (await as(owner, 'POST', '/groups', { userIds: [member.id] })).json;
  const call = group.channels.find((c) => c.type === 'voice');
  const ring = next(sm, 'call:ring', 3000);
  assert.equal((await ack(so, 'voice:join', { channelId: call.id })).ok, true);
  assert.ok(await ring);
  const told = next(so, 'call:declined', 3000);
  assert.equal((await ack(sm, 'call:decline', { room: call.id })).ok, true);
  assert.deepEqual(await told, { room: call.id, userId: member.id });
  assert.ok((await ack(sx, 'call:decline', { room: call.id })).error, 'not a member of the group');
  // A DM call: the other person declines.
  const dm = (await as(owner, 'POST', '/dms', { userId: member.id })).json;
  await ack(so, 'voice:join', { channelId: 'dm:' + dm.id });
  const toldDm = next(so, 'call:declined', 3000);
  assert.equal((await ack(sm, 'call:decline', { room: 'dm:' + dm.id })).ok, true);
  assert.equal((await toldDm).userId, member.id);
  assert.ok((await ack(sx, 'call:decline', { room: 'dm:' + dm.id })).error);
  await ack(so, 'voice:leave', {});
});

// ------------------------------------------------------------------ voice-12: typing
test('voice-12: "typing" goes nowhere when blocked, nor from someone who can’t post in the channel', async () => {
  const { owner, member, server, textCh } = await community();
  const dm = (await as(owner, 'POST', '/dms', { userId: member.id })).json;
  const so = await sock(owner); const sm = await sock(member);
  let got = next(so, 'typing', 1500);
  assert.equal((await ack(sm, 'typing', { dmId: dm.id })).ok, true);
  assert.equal((await got).userId, member.id, 'normally it arrives');
  assert.equal((await as(owner, 'POST', `/blocks/${member.id}`)).status, 200);
  await sleep(1100);
  got = next(so, 'typing', 1200);
  await ack(sm, 'typing', { dmId: dm.id });
  assert.equal(await got, null, 'blocked: nothing arrives');
  assert.equal((await as(owner, 'DELETE', `/blocks/${member.id}`)).status, 200);
  // In a channel: arrives while they can post; refused once Send Messages is taken away.
  await sleep(1100);
  got = next(so, 'typing', 1500);
  assert.equal((await ack(sm, 'typing', { channelId: textCh.id })).ok, true);
  assert.equal((await got).userId, member.id);
  const everyone = await everyoneRole(owner, server);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone.permissions & ~P.SEND })).status, 200);
  await sleep(1100);
  got = next(so, 'typing', 1200);
  assert.ok((await ack(sm, 'typing', { channelId: textCh.id })).error, 'refused');
  assert.equal(await got, null);
});

// ------------------------------------------------------------------ voice-4: many connections, one allowance
test('voice-4: one account can’t multiply its allowance by opening more connections', async () => {
  const u = await srv.register();
  const many = [];
  try {
    for (let i = 0; i < 30; i++) many.push(await srv.socket(u.token));
    await assert.rejects(srv.socket(u.token), /too_many_connections/, 'a 31st window is refused');
    let accepted = 0; let refused = 0;
    await Promise.all(many.slice(0, 10).flatMap((s) => Array.from({ length: 40 }, () => ack(s, 'voice:leave', {}).then((r) => {
      if (r && r.ok) accepted++; else if (r && r.error === 'Slow down.') refused++;
    }))));
    assert.equal(accepted + refused, 400, 'every event was answered');
    assert.ok(accepted <= 150, `10 connections together got ${accepted} events through (the account allows 120 at once, then 30 a second)`);
    // The app's window that was turned away gets in by itself once another one closes.
    const { watchConnection } = await clientModule('conn.js');
    const { io } = require('socket.io-client');
    const late = io(srv.base, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, forceNew: true });
    many.push(late);
    const refusedWith = new Promise((r) => late.once('connect_error', (e) => r(e.message)));
    const out = [];
    watchConnection(late, { onSignedOut: (r) => out.push(r), retryMs: 100 });
    assert.equal(await refusedWith, 'too_many_connections');
    many[0].close();
    assert.ok(await until(() => late.connected, 5000), 'connected once there was room');
    assert.deepEqual(out, [], 'and was never signed out');
  } finally { many.forEach((s) => s.close()); }
  await sleep(300);
  const again = await srv.socket(u.token); // windows closed: room for new ones
  again.close();
});

test('voice-4: typing events are passed on at most once a second per person', async () => {
  const { owner, member, textCh } = await community();
  const so = await sock(owner); const sm = await sock(member); const sm2 = await sock(member);
  const got = collect(so, 'typing');
  for (let i = 0; i < 10; i++) { ack(sm, 'typing', { channelId: textCh.id }); ack(sm2, 'typing', { channelId: textCh.id }); }
  await sleep(900);
  assert.equal(got.length, 1, `${got.length} typing events were passed on`);
});

// ------------------------------------------------------------------ voice-2 / auth-12: the flood limiter
test('voice-2: refusals are forgiven over time and answered; only a real flood disconnects, and says so first', async () => {
  const u = await srv.register();
  const s = await sock(u);
  let reason = null;
  s.on('disconnect', (r) => { reason = r; });
  // Four bursts of 60 events with pauses between them: 80 refusals in all (the old limit was 50 for a
  // connection's whole life, which a long, busy call reached by itself).
  for (let burst = 0; burst < 4; burst++) {
    const answers = await Promise.all(Array.from({ length: 60 }, () => ack(s, 'voice:leave', {}, 3000)));
    const ok = answers.filter((a) => a && a.ok).length;
    const slow = answers.filter((a) => a && a.error === 'Slow down.').length;
    assert.equal(ok + slow, 60, 'every event is answered, refused ones with "Slow down."');
    assert.ok(ok >= 40 && slow >= 10, `burst ${burst}: ${ok} accepted, ${slow} refused`);
    await sleep(4200);
  }
  assert.equal(reason, null, 'still connected');
  assert.equal(s.connected, true);
  // A real flood: the app is told why, then disconnected; the sign-in itself is untouched.
  const flood = next(s, 'flood', 5000);
  for (let i = 0; i < 200; i++) s.emit('voice:leave', {});
  assert.deepEqual(await flood, { reason: 'too_many_events' });
  assert.ok(await until(() => reason === 'io server disconnect'));
  assert.equal((await as(u, 'GET', '/bootstrap')).status, 200, 'still signed in');
});

test('auth-12: the app reconnects after a flood disconnect, and signs out only when the session is really revoked', async () => {
  const { watchConnection } = await clientModule('conn.js');
  const u = await srv.register();
  const s = await sock(u);
  const signedOut = []; const downs = [];
  watchConnection(s, { onSignedOut: (r) => signedOut.push(r), onDown: (r) => downs.push(r), retryMs: 200 });
  for (let i = 0; i < 200; i++) s.emit('voice:leave', {});
  assert.ok(await until(() => downs.includes('io server disconnect')), 'the server closed the connection');
  assert.ok(await until(() => s.connected, 5000), 'and the app connected again by itself');
  assert.deepEqual(signedOut, [], 'without signing out (which would revoke the session and wipe the keys)');
  assert.equal((await as(u, 'GET', '/bootstrap')).status, 200);
  // A real revocation (signing this device out) is a sign-out, and nothing reconnects after it.
  assert.equal((await as(u, 'POST', '/auth/logout')).status, 200);
  assert.ok(await until(() => signedOut.length === 1));
  assert.equal(signedOut[0], 'logged_out');
  await sleep(1200);
  assert.equal(s.connected, false);
  // A sign-in that ended without the event reaching this device: the reconnect is refused ('unauthorized'),
  // and that is a sign-out too.
  const v = await srv.register();
  const t = await sock(v);
  const out = [];
  watchConnection(t, { onSignedOut: (r) => out.push(r), retryMs: 100 });
  srv.sql('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ?', Date.now(), 'test', v.id);
  for (let i = 0; i < 200; i++) t.emit('voice:leave', {});
  assert.ok(await until(() => out.length > 0, 5000), 'signed out');
  assert.deepEqual(out, ['unauthorized']);
});

// ------------------------------------------------------------------ voice-1: watch together stays small
test('voice-1: watch together refuses huge links, caps the queue’s size, and merges bursts of changes', async () => {
  const { owner, voiceCh } = await community(0);
  const s = await sock(owner);
  assert.equal((await ack(s, 'voice:join', { channelId: voiceCh.id })).ok, true);
  assert.match((await ack(s, 'watch:start', { url: 'https://x.example/' + 'a'.repeat(100000) + '.mp4' })).error, /too long/);
  assert.match((await ack(s, 'watch:start', { url: 'https://x.example/' + 'a'.repeat(2100) + '.mp4' })).error, /too long/);
  assert.equal((await ack(s, 'watch:start', { url: 'https://x.example/movie.mp4' })).ok, true, 'a normal link plays');
  // The longest allowed links fill the queue's byte budget before its 25 places.
  let queued = 0; let full = '';
  for (let i = 0; i < 25; i++) {
    const r = await ack(s, 'watch:start', { url: `https://x.example/${String(i).padStart(3, '0')}${'b'.repeat(2000)}.mp4`, queue: true });
    if (r.ok) queued++; else full = r.error;
  }
  assert.ok(queued >= 5 && queued < 25, `${queued} long links queued`);
  assert.match(full, /full/);
  // Twenty quick seeks go out as a couple of updates, each far below the old megabytes. (After a pause: one
  // connection may send 40 events per 4 seconds.)
  await sleep(3000);
  const sizes = []; let last = null;
  s.on('watch:state', (x) => { sizes.push(Buffer.byteLength(JSON.stringify(x))); last = x.state; });
  const t0 = Date.now();
  for (let i = 1; i <= 20; i++) assert.equal((await ack(s, 'watch:control', { action: 'seek', position: i * 5 })).ok, true);
  await sleep(600);
  assert.ok(sizes.length >= 1 && sizes.length <= Math.ceil((Date.now() - t0) / 250) + 1, `${sizes.length} updates for 20 seeks`);
  assert.ok(Math.max(...sizes) < 70 * 1024, `largest update ${Math.max(...sizes)} bytes`);
  assert.equal(last.position, 100, 'the last update carries the latest position');
  assert.equal(last.votes, undefined, 'internal bookkeeping isn’t sent');
  assert.equal((await ack(s, 'watch:stop', {})).ok, true);
  // Realtime messages over 256 KB aren't even read (the connection is closed instead).
  const gone = next(s, 'disconnect', 5000);
  s.emit('watch:start', { url: 'https://x.example/' + 'a'.repeat(300 * 1024) + '.mp4' });
  assert.match(String(await gone), /transport/);
  // A normal queue of short links still takes all 25.
  const other = await community(0);
  const t = await sock(other.owner);
  assert.equal((await ack(t, 'voice:join', { channelId: other.voiceCh.id })).ok, true);
  assert.equal((await ack(t, 'watch:start', { url: 'https://x.example/a.mp4' })).ok, true);
  for (let i = 0; i < 25; i++) assert.equal((await ack(t, 'watch:start', { url: `https://x.example/clip-${i}.webm`, queue: true })).ok, true);
  assert.match((await ack(t, 'watch:start', { url: 'https://x.example/one-more.mp4', queue: true })).error, /full/);
});

// ------------------------------------------------------------------ voice-15: host-only playback
test('voice-15: in host-only mode only the host skips; "video ended" counts once most of the call says so', async () => {
  const { owner: host, members: [g1, g2], voiceCh } = await community(2);
  const sh = await sock(host); const s1 = await sock(g1); const s2 = await sock(g2);
  let state = null;
  sh.on('watch:state', (x) => { state = x.state; });
  for (const s of [sh, s1, s2]) assert.equal((await ack(s, 'voice:join', { channelId: voiceCh.id })).ok, true);
  assert.equal((await ack(sh, 'watch:start', { url: 'https://x.example/one.mp4', hostOnly: true })).ok, true);
  for (const name of ['two', 'three']) assert.equal((await ack(sh, 'watch:start', { url: `https://x.example/${name}.mp4`, queue: true })).ok, true);
  await sleep(400);
  const first = state.item.id;
  assert.ok((await ack(s1, 'watch:next', { skip: true, itemId: first })).error, 'a guest can’t skip');
  assert.ok((await ack(s1, 'watch:next', {})).error, 'not even without saying which video');
  assert.equal((await ack(s1, 'watch:next', { itemId: first })).ok, true);
  await sleep(400);
  assert.equal(state.item.id, first, 'one guest’s "it ended" doesn’t move a call of three on');
  assert.equal(state.playing, true);
  assert.equal((await ack(s2, 'watch:next', { itemId: first })).ok, true);
  await sleep(400);
  assert.notEqual(state.item.id, first, 'most of the call saw it end: next video');
  const second = state.item.id;
  assert.equal((await ack(sh, 'watch:next', { itemId: second })).ok, true);
  await sleep(400);
  assert.notEqual(state.item.id, second, 'the host’s own player ending moves on straight away');
});

// ------------------------------------------------------------------ voice-6 / voice-9: relay logins
test('voice-6/9: relay logins say when they run out, stay the same for hours, never name the user id, and /ice is rate-limited', async () => {
  const u = await srv.register();
  const t0 = Date.now();
  const relay = (await as(u, 'GET', '/ice')).json.find((e) => e.username);
  assert.ok(relay, 'a relay login');
  const parts = relay.username.split(':');
  assert.equal(parts.length, 2, 'coturn reads the expiry before the one colon');
  const [exp, who] = parts;
  assert.match(exp, /^\d+$/);
  // Relays (regions may be someone else's machine) log logins: they get a pseudonym, never the user id.
  assert.match(who, /^[0-9a-f]{12}$/, 'a 12-hex pseudonym');
  assert.notEqual(who, u.id);
  assert.ok(!relay.username.includes(u.id), 'the user id appears nowhere in the login');
  // Keyed, so a relay can't get it back by hashing user ids (which any member can see).
  for (const alg of ['sha256', 'sha1', 'md5']) {
    const plain = crypto.createHash(alg).update(u.id).digest('hex');
    assert.ok(!plain.startsWith(who) && !plain.endsWith(who), `not a plain ${alg} of the user id`);
  }
  assert.equal(relay.expiresAt, +exp * 1000, 'expiresAt matches the login');
  const ahead = relay.expiresAt - Date.now();
  assert.ok(ahead > 12 * 3600e3 - 60e3 && ahead <= 18 * 3600e3, `runs out in ${Math.round(ahead / 3600e3)} h`);
  assert.equal(relay.credential, crypto.createHmac('sha1', TURN_SECRET).update(relay.username).digest('base64'), 'coturn’s shared-secret scheme');
  const again = (await as(u, 'GET', '/ice')).json.find((e) => e.username);
  const step = (t) => Math.floor(t / 1000 / 21600);
  assert.ok(again.username === relay.username || step(Date.now()) !== step(t0), 'the same login for hours (the relay’s per-login quota is then per person)');
  assert.equal(again.username.split(':')[1], who, 'the same pseudonym every time for the same person');
  assert.equal(again.credential, crypto.createHmac('sha1', TURN_SECRET).update(again.username).digest('base64'));
  const boot = (await as(u, 'GET', '/bootstrap')).json.iceServers.find((e) => e.username);
  assert.equal(boot.expiresAt, again.expiresAt, 'the app gets the expiry with its first relay list too');
  assert.equal(boot.username.split(':')[1], who, '/bootstrap names the person the same way');
  const other = await srv.register();
  const theirs = (await as(other, 'GET', '/ice')).json.find((e) => e.username);
  assert.notEqual(theirs.username.split(':')[1], who, 'two people get different pseudonyms');
  assert.ok(!theirs.username.includes(other.id));
  assert.equal(theirs.credential, crypto.createHmac('sha1', TURN_SECRET).update(theirs.username).digest('base64'));
  let limited = 0;
  for (let i = 0; i < 60; i++) if ((await as(u, 'GET', '/ice')).status === 429) limited++;
  assert.ok(limited >= 1, '/ice is rate-limited');
  // It's the access log's pseudonym for the same person, so an admin can match relay logs to it.
  assert.ok(await until(() => new RegExp(`route=/api/ice status=429 .*uid=${who}\\b`).test(srv.log)), 'the access log names the person the same way');
  // The server's admin can turn a pseudonym (or a whole login from a relay's log) back into the account.
  const who_ = (arg) => spawnSync(process.execPath, ['server/cli.js', 'who', arg], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: srv.dir }, encoding: 'utf8' });
  for (const arg of [who, relay.username]) {
    const r = who_(arg);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`\\(id ${u.id}\\)`), arg);
    assert.doesNotMatch(r.stdout, new RegExp(other.id));
  }
  assert.equal(who_('000000000000').status, 1, 'an unknown pseudonym finds nobody');
});

test('voice-6: the app sees when relay logins are about to run out, and never hands expiresAt to WebRTC', async () => {
  const R = await clientModule('relays.js');
  const now = Date.UTC(2026, 0, 1);
  const list = [{ urls: ['stun:stun.example'] }, { urls: ['turn:a.example'], username: 'x', credential: 'y', expiresAt: now + 11.5 * 3600e3, region: 'A', regionId: 'a' }];
  assert.equal(R.iceStale(list, now), false, 'fresh');
  assert.equal(R.iceStale(list, now + 11 * 3600e3), true, 'within the last hour');
  assert.equal(R.iceStale(list, now + 12 * 3600e3), true, 'expired');
  assert.equal(R.iceStale([{ urls: ['stun:stun.example'] }], now + 1e12), false, 'nothing that expires');
  assert.equal(R.iceStale(undefined, now), false);
  for (const e of R.chooseIce(list, null)) assert.equal('expiresAt' in e, false);
  for (const e of R.chooseIce(list, null, 'a').iceServers) assert.equal('expiresAt' in e, false);
});

// ------------------------------------------------------------------ the call engine (public/js/voice.js), on a fake WebRTC
// Just enough of RTCPeerConnection to watch the order things happen in. Candidates are "gathered" the moment a
// local description is set, like a real browser that has host candidates ready at once.
const pcs = [];
class FakePC {
  constructor(config) {
    this.config = config; this.log = []; this.connectionState = 'new'; this.signalingState = 'stable';
    this.localDescription = null; this.remoteDescription = null; this.lanes = []; this.id = pcs.length;
    pcs.push(this);
  }
  addTransceiver() { const t = { direction: 'sendrecv', sender: { track: null, replaceTrack: async () => {}, getParameters: () => ({}), setParameters: async () => {} } }; this.lanes.push(t); return t; }
  getTransceivers() { return this.lanes; }
  async createOffer() { return { type: 'offer', sdp: `offer-${this.id}-${this.log.length}` }; }
  async createAnswer() { return { type: 'answer', sdp: `answer-${this.id}` }; }
  async setLocalDescription(d) {
    this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; this.log.push('local:' + d.type);
    for (let i = 0; i < 3; i++) this.onicecandidate && this.onicecandidate({ candidate: { toJSON: () => ({ candidate: `cand-${this.id}-${i}`, sdpMid: '0' }) } });
  }
  async setRemoteDescription(d) { await sleep(5); this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; this.log.push('remote:' + d.type); }
  async addIceCandidate(c) { if (!this.remoteDescription) { this.log.push('rejected:' + c.candidate); throw new Error('no remote description'); } this.log.push('candidate:' + c.candidate); }
  setConfiguration(c) { this.config = c; this.log.push('config'); }
  close() { this.connectionState = 'closed'; }
}
function fakeSocket(onEmit = () => undefined) {
  const handlers = {}; const sent = [];
  return {
    handlers, sent, id: 'me',
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    emit(ev, payload, cb) { sent.push({ ev, payload }); const r = onEmit(ev, payload); if (cb) setTimeout(() => cb(r || { ok: true }), 1); },
    fire(ev, payload) { (handlers[ev] || []).forEach((fn) => fn(payload)); },
  };
}
let Voice;
async function loadVoice() {
  if (Voice) return Voice;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.RTCPeerConnection = FakePC;
  globalThis.MediaStream = class { constructor(tracks = []) { this.tracks = tracks; } getAudioTracks() { return this.tracks; } getVideoTracks() { return []; } getTracks() { return this.tracks; } };
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => new globalThis.MediaStream([]) } }, configurable: true, writable: true });
  ({ Voice } = await clientModule('voice.js'));
  return Voice;
}

test('voice-7: candidates that arrive before (or while) an offer is checked are kept and used, in order', async () => {
  const V = await loadVoice();
  const socket = fakeSocket();
  const v = new V({ socket, getIceServers: () => [], signSdp: async () => 'sig', verifySdp: async () => { await sleep(50); return true; } });
  v.channelId = 'room';
  const sig = (data) => socket.fire('voice:signal', { from: 'A', userId: 'ua', data });
  sig({ candidate: { candidate: 'early', sdpMid: '0' } }); // before the offer (an older app sends these first)
  sig({ sdp: { type: 'offer', sdp: 'remote-offer' }, sig: 's' });
  sig({ candidate: { candidate: 'during', sdpMid: '0' } }); // while the offer's signature is still being checked
  await v.signalChains.get('A');
  const pc = v.peers.get('A').pc;
  assert.deepEqual(pc.log.filter((x) => !x.startsWith('local')), ['remote:offer', 'candidate:early', 'candidate:during']);
  // Our own answer goes out before any of our candidates.
  const out = socket.sent.filter((x) => x.ev === 'voice:signal' && x.payload.to === 'A').map((x) => (x.payload.data.sdp ? 'sdp:' + x.payload.data.sdp.type : 'candidate'));
  assert.deepEqual(out, ['sdp:answer', 'candidate', 'candidate', 'candidate']);
  v.cleanup();
});

test('voice-7/6: a new call fetches fresh relay logins first, and sends its offer before its candidates', async () => {
  const V = await loadVoice();
  let ice = [{ urls: ['turn:old.example'], username: 'old', credential: 'x' }];
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? { ok: true, peers: [{ socketId: 'B', userId: 'ub' }], canSpeak: true } : undefined));
  const v = new V({ socket, getIceServers: () => ice, ensureIce: async () => { await sleep(40); ice = [{ urls: ['turn:new.example'], username: 'new', credential: 'y' }]; }, signSdp: async () => { await sleep(30); return 'sig'; }, verifySdp: async () => true });
  const before = pcs.length;
  await v.join('room');
  const pc = pcs[before];
  assert.equal(pc.config.iceServers[0].username, 'new', 'the connection was made with the fresh logins');
  const out = socket.sent.filter((x) => x.ev === 'voice:signal' && x.payload.to === 'B').map((x) => (x.payload.data.sdp ? 'sdp:' + x.payload.data.sdp.type : 'candidate'));
  assert.deepEqual(out, ['sdp:offer', 'candidate', 'candidate', 'candidate'], 'the receiver never gets a candidate before the offer it belongs to');
  // A network restart: the new candidates follow the new offer too (they'd be refused against the old one).
  const sentBefore = socket.sent.length;
  await v.restartIce('B', v.peers.get('B'));
  const restart = socket.sent.slice(sentBefore).filter((x) => x.ev === 'voice:signal').map((x) => (x.payload.data.sdp ? 'sdp:' + x.payload.data.sdp.type : 'candidate'));
  assert.deepEqual(restart, ['sdp:offer', 'candidate', 'candidate', 'candidate']);
  // Logins renewed mid-call: every connection picks them up.
  ice = [{ urls: ['turn:newer.example'], username: 'newer', credential: 'z' }];
  v.updateIceServers();
  assert.equal(pc.config.iceServers[0].username, 'newer');
  // Speak taken away mid-call: the mic goes off and stays off.
  socket.fire('voice:perms', { channelId: 'room', canSpeak: false });
  assert.equal(v.muted, true);
  v.setMuted(false);
  assert.equal(v.muted, true, 'can’t unmute without Speak');
  assert.deepEqual(socket.sent.filter((x) => x.ev === 'voice:update').pop().payload.muted, true);
  v.cleanup();
});

// ------------------------------------------------------------------ voice-11 / voice-14: regions and relay settings
test('voice-14: relay settings and regions need the password again, and every change is logged', async () => {
  const admin = srv.owner;
  const origin = 'https://chat.example.test';
  assert.equal((await as(admin, 'POST', '/admin/regions', { name: 'Paris', origin })).status, 401, 'no password');
  assert.equal((await as(admin, 'POST', '/admin/regions', { name: 'Paris', origin, authKey: hex(32) })).status, 401, 'wrong password');
  const add = await as(admin, 'POST', '/admin/regions', { name: 'Paris', origin, authKey: admin.authKey });
  assert.equal(add.status, 200, add.text);
  const id = add.json.region.id;
  assert.equal((await as(admin, 'POST', `/admin/regions/${id}/reinstall`, { origin })).status, 401);
  assert.equal((await as(admin, 'POST', `/admin/regions/${id}/reinstall`, { origin, authKey: admin.authKey })).status, 200);
  assert.equal((await as(admin, 'PATCH', `/admin/regions/${id}`, { name: 'Paris 2' })).status, 200);
  assert.equal((await as(admin, 'DELETE', `/admin/regions/${id}`)).status, 200);
  assert.equal((await as(admin, 'DELETE', `/admin/regions/${id}`)).status, 404);
  assert.equal((await as(admin, 'PUT', '/admin/turn', { urls: 'turn:relay.example.test:3478?transport=udp', secret: TURN_SECRET })).status, 401);
  const turn = await as(admin, 'PUT', '/admin/turn', { urls: 'turn:relay.example.test:3478?transport=udp', secret: TURN_SECRET, authKey: admin.authKey });
  assert.equal(turn.status, 200, turn.text);
  const log = srv.sql('SELECT action, target, detail FROM admin_log ORDER BY id');
  for (const action of ['region_added', 'region_reinstalled', 'region_renamed', 'region_deleted', 'turn_settings']) assert.ok(log.some((r) => r.action === action), action);
  assert.ok(log.find((r) => r.action === 'turn_settings').detail.includes('secret changed'));
  assert.ok(!JSON.stringify(log).includes(TURN_SECRET), 'the secret itself is never logged');
  // People who aren't instance admins are still refused first.
  const someone = await srv.register();
  assert.equal((await as(someone, 'POST', '/admin/regions', { name: 'X', origin, authKey: someone.authKey })).status, 403);
  assert.equal((await as(someone, 'PUT', '/admin/turn', { urls: 'turn:evil.example:3478', authKey: someone.authKey })).status, 403);
});

test('voice-11: a region can only report a public address, however an internal one is written', async () => {
  const admin = srv.owner;
  const add = await as(admin, 'POST', '/admin/regions', { name: 'Frankfurt', origin: 'https://chat.example.test', authKey: admin.authKey });
  assert.equal(add.status, 200, add.text);
  const id = add.json.region.id;
  const token = /[?&]k=([0-9a-f]+)/.exec(add.json.command)[1];
  const beat = (ip) => srv.api('POST', `/regions/${id}/heartbeat`, { headers: { 'x-region-token': token }, body: { ip, relay: true } });
  assert.equal((await beat('203.0.113.9')).status, 200);
  for (const ip of ['0::1', '0:0:0:0:0:0:0:1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:127.0.0.1', 'fe8f::1', '::1', 'fe80::1', 'fd00::5', '::', '64:ff9b::a00:1', 'fe80::1%eth0', '10.0.0.1', '127.0.0.1', '169.254.169.254', 'not-an-ip']) {
    assert.equal((await beat(ip)).status, 400, ip);
  }
  const reg = (await as(admin, 'GET', '/admin/regions')).json.regions.find((x) => x.id === id);
  assert.equal(reg.ip, '203.0.113.9', 'refused reports changed nothing');
  assert.ok(reg.urls.every((u) => u.includes('203.0.113.9')));
  assert.equal((await beat('2606:4700:4700::1111')).status, 200, 'a public IPv6 address is fine');
  await as(admin, 'DELETE', `/admin/regions/${id}`);
});

test('voice-9: the relay setup caps bandwidth per connection (not just the number of connections)', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-turn.sh'), 'utf8');
  assert.match(script, /^max-bps=\$\(\(MAX_MBIT \* 125000\)\)$/m);
  assert.match(script, /^bps-capacity=/m);
  assert.match(script, /^user-quota=\d+$/m);
});
