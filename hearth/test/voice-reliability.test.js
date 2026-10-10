// Voice reliability: calls that survive a dropped connection or a server restart, region changes that settle on
// one answer, and the call engine's state machine. The first half talks to a real server over Socket.IO; the
// second runs the call engine (public/js/voice.js) on a fake WebRTC, since browsers can't be driven from Node
// (test/e2e-voice/run.mjs does that with real browsers: npm run test:voice).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, hex, sleep } = require('./helpers');

const P = { VIEW: 1, CONNECT: 64, SPEAK: 128 };
const GRACE = 1500; // VOICE_GRACE_MS for this file (the default is 18 s)
let srv;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (token) => { const s = await srv.socket(token); socks.push(s); return s; };
const ack = (s, ev, p, ms = 5000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.emit(ev, p, (x) => { clearTimeout(t); r(x); }); });
const next = (s, ev, ms = 2000, pred = () => true) => new Promise((r) => {
  const t = setTimeout(() => { s.off(ev, h); r(null); }, ms);
  const h = (x) => { if (!pred(x)) return; clearTimeout(t); s.off(ev, h); r(x); };
  s.on(ev, h);
});
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) return false; await sleep(25); } return true; };
const inCall = async (u, room) => ((await as(u, 'GET', '/bootstrap')).json.voice[room] || []);
const drop = (s) => s.io.engine.close(); // the connection breaks (not a polite goodbye)

before(async () => { srv = await startServer({ VOICE_GRACE_MS: String(GRACE) }); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

async function community(n = 1) {
  const owner = await srv.register();
  const members = [];
  for (let i = 0; i < n; i++) members.push(await srv.register());
  const server = (await as(owner, 'POST', '/servers', { name: 'Calls ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const m of members) assert.equal((await as(m, 'POST', `/invites/${invite.code}/join`)).status, 200);
  return { owner, members, member: members[0], server, voiceCh: server.channels.find((c) => c.type === 'voice') };
}
// Two people in a voice channel, each on one live connection.
async function call() {
  const c = await community(1);
  const so = await sock(c.owner.token); const sm = await sock(c.member.token);
  assert.equal((await ack(so, 'voice:join', { channelId: c.voiceCh.id })).ok, true);
  assert.equal((await ack(sm, 'voice:join', { channelId: c.voiceCh.id })).ok, true);
  return { ...c, so, sm, room: c.voiceCh.id };
}

// ------------------------------------------------------------------ grace window and resume
test('grace window: a dropped connection shows as "reconnecting" to the others, then is dropped after the grace', async () => {
  const { owner, member, so, sm, room } = await call();
  const left = collect(so, 'voice:peer-left');
  const state = next(so, 'voice:state', 3000, (p) => p.channelId === room && p.users.some((u) => u.userId === member.id && u.reconnecting));
  drop(sm);
  assert.ok(await state, 'the others see them as reconnecting');
  assert.equal(left.length, 0, 'not dropped yet');
  const list = await inCall(owner, room);
  assert.deepEqual(list.map((u) => u.userId).sort(), [owner.id, member.id].sort(), 'still listed during the grace window');
  assert.equal(list.find((u) => u.userId === member.id).reconnecting, true);
  assert.ok(await until(() => left.length === 1, GRACE + 3000), 'dropped once the grace window is over');
  assert.equal(left[0].userId, member.id);
  assert.deepEqual((await inCall(owner, room)).map((u) => u.userId), [owner.id]);
});

test('resume: the same sign-in comes back within the grace window and keeps its place; peers get its new socket', async () => {
  const { owner, member, so, sm, room } = await call();
  const oldId = sm.id;
  const left = collect(so, 'voice:peer-left');
  drop(sm);
  await until(async () => (await inCall(owner, room)).some((u) => u.reconnecting));
  const back = await sock(member.token);
  const moved = next(so, 'voice:peer-joined', 3000);
  const res = await ack(back, 'voice:join', { channelId: room, resume: true, muted: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.resumed, true);
  assert.deepEqual(res.peers.map((p) => p.userId), [owner.id], 'its peers, not itself');
  const ev = await moved;
  assert.deepEqual({ userId: ev.userId, socketId: ev.socketId, resumed: ev.resumed }, { userId: member.id, socketId: back.id, resumed: true });
  await sleep(GRACE + 500);
  assert.equal(left.length, 0, 'the grace timer was cancelled: nobody left');
  const list = await inCall(owner, room);
  assert.equal(list.length, 2);
  assert.deepEqual(list.find((u) => u.userId === member.id), { userId: member.id, muted: true, deafened: false, video: false, screen: false, reconnecting: false });
  // Signaling works both ways on the new socket; the old one is gone.
  const got = next(back, 'voice:signal', 2000);
  assert.equal((await ack(so, 'voice:signal', { to: back.id, data: { candidate: { candidate: 'x' } } })).ok, true);
  assert.equal((await got).userId, owner.id);
  assert.ok((await ack(so, 'voice:signal', { to: oldId, data: { x: 1 } })).error, 'the old socket is no longer a peer');
  assert.equal((await ack(back, 'voice:signal', { to: so.id, data: { x: 1 } })).ok, true);
});

test('no duplicate members: resuming twice, or joining again while the place is kept, leaves one entry each', async () => {
  const { owner, member, sm, room } = await call();
  drop(sm);
  await until(async () => (await inCall(owner, room)).some((u) => u.reconnecting));
  const a = await sock(member.token); const b = await sock(member.token);
  const [ra, rb] = await Promise.all([ack(a, 'voice:join', { channelId: room, resume: true }), ack(b, 'voice:join', { channelId: room, resume: true })]);
  assert.equal(ra.ok && rb.ok, true);
  let list = await inCall(owner, room);
  assert.equal(list.length, 2);
  assert.equal(new Set(list.map((u) => u.userId)).size, 2);
  // (Whichever of the two came last holds the place; resume once more so it's b.)
  assert.equal((await ack(b, 'voice:join', { channelId: room, resume: true })).resumed, true);
  // A plain join (another window) takes over: still one entry, and the replaced window is told.
  const c = await sock(member.token);
  const kicked = next(b, 'voice:kicked', 2000);
  assert.equal((await ack(c, 'voice:join', { channelId: room })).ok, true);
  assert.ok(await kicked, 'the window that had the place is told it moved');
  list = await inCall(owner, room);
  assert.equal(list.filter((u) => u.userId === member.id).length, 1);
  assert.ok((await ack(b, 'voice:signal', { to: c.id, data: {} })).error, 'the replaced window can no longer signal');
});

test('a different sign-in (or a signed-out one) can’t resume someone’s place', async () => {
  const { owner, member, so, sm, room } = await call();
  drop(sm);
  await until(async () => (await inCall(owner, room)).some((u) => u.reconnecting));
  // Another device of the same person: joins as new (the kept place ends), never "resumed".
  const other = await srv.login(member);
  assert.equal(other.status, 200, other.text);
  const s2 = await sock(other.json.token);
  const left = next(so, 'voice:peer-left', 3000);
  const res = await ack(s2, 'voice:join', { channelId: room, resume: true });
  assert.equal(res.ok, true);
  assert.ok(!res.resumed, 'a different session starts fresh');
  assert.ok(await left, 'the kept place was given up');
  assert.equal((await inCall(owner, room)).filter((u) => u.userId === member.id).length, 1);
  // Now that device drops, and its session is signed out while the place is being kept: it ends at once.
  drop(s2);
  await until(async () => (await inCall(owner, room)).some((u) => u.reconnecting));
  const gone = next(so, 'voice:peer-left', 1000);
  const t0 = Date.now();
  assert.equal((await srv.api('POST', '/auth/logout', { token: other.json.token, ip: member.ip })).status, 200);
  assert.ok(await gone, 'signing out ends the kept place');
  assert.ok(Date.now() - t0 < GRACE, 'without waiting for the grace window');
  assert.deepEqual((await inCall(owner, room)).map((u) => u.userId), [owner.id]);
  await assert.rejects(srv.socket(other.json.token), /unauthorized/, 'the revoked session can’t even connect, let alone resume');
});

test('losing access while reconnecting: the resume is refused like any join', async () => {
  const { owner, member, server, sm, room } = await call();
  drop(sm);
  await until(async () => (await inCall(owner, room)).some((u) => u.reconnecting));
  const roles = (await as(owner, 'GET', '/bootstrap')).json.servers.find((s) => s.id === server.id).roleDefs;
  const everyone = roles.find((r) => r.id === server.id);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone.permissions & ~P.CONNECT })).status, 200);
  assert.ok(await until(async () => !(await inCall(owner, room)).some((u) => u.userId === member.id)), 'taken out of the call');
  const back = await sock(member.token);
  const res = await ack(back, 'voice:join', { channelId: room, resume: true });
  assert.match(res.error || '', /permission/i);
  assert.deepEqual((await inCall(owner, room)).map((u) => u.userId), [owner.id]);
});

test('hanging up while the place is kept ends it straight away; another session can’t hang it up', async () => {
  const { owner, member, so, sm, room } = await call();
  drop(sm);
  await until(async () => (await inCall(owner, room)).some((u) => u.reconnecting));
  const other = (await srv.login(member)).json.token;
  const s3 = await sock(other);
  await ack(s3, 'voice:leave', { channelId: room });
  await sleep(200);
  assert.equal((await inCall(owner, room)).length, 2, 'another session’s hang-up doesn’t touch it');
  const back = await sock(member.token);
  const left = next(so, 'voice:peer-left', 1000);
  await ack(back, 'voice:leave', { channelId: room });
  assert.ok(await left, 'the same session’s hang-up ends it');
  assert.deepEqual((await inCall(owner, room)).map((u) => u.userId), [owner.id]);
});

test('coming back after a restart (resume with no kept place) doesn’t ring anyone; a new call still does', async () => {
  const { owner: a, member: b } = await community(1); // (direct messages need a server in common)
  const dm = (await as(a, 'POST', '/dms', { userId: b.id })).json;
  assert.ok(dm.id, JSON.stringify(dm));
  const sa = await sock(a.token); const sb = await sock(b.token);
  const room = 'dm:' + dm.id;
  let ring = next(sb, 'call:ring', 800);
  assert.equal((await ack(sa, 'voice:join', { channelId: room, resume: true })).ok, true);
  assert.equal(await ring, null, 'no ring for a call that was already going');
  await ack(sa, 'voice:leave', {});
  ring = next(sb, 'call:ring', 2000);
  assert.equal((await ack(sa, 'voice:join', { channelId: room })).ok, true);
  assert.ok(await ring, 'a new call rings');
  await ack(sa, 'voice:leave', {});
});

// ------------------------------------------------------------------ region conflicts
test('region conflict: concurrent changes get versions, the last write wins, everyone (and late joiners) gets it', async () => {
  const { owner, so, room } = await call();
  const ids = ['rega' + hex(3), 'regb' + hex(3)];
  for (const id of ids) srv.sql('INSERT INTO regions (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)', id, id, 'x'.repeat(64), Date.now());
  const events = collect(so, 'call:region');
  const rs = await Promise.all([
    as(owner, 'POST', '/calls/region', { room, region: ids[0] }),
    as(owner, 'POST', '/calls/region', { room, region: ids[1] }),
    as(owner, 'POST', '/calls/region', { room, region: null }),
  ]);
  rs.forEach((r) => assert.equal(r.status, 200, r.text));
  const versions = rs.map((r) => r.json.version);
  assert.equal(new Set(versions).size, 3, 'every change has its own version');
  const [row] = srv.sql('SELECT rtc_region, rtc_region_v FROM channels WHERE id = ?', room);
  const newest = rs.map((r) => r.json).sort((x, y) => y.version - x.version)[0];
  assert.equal(row.rtc_region_v, newest.version);
  assert.equal(row.rtc_region, newest.region, 'the server keeps the newest change');
  assert.ok(await until(() => events.length === 3));
  // Whatever order they arrive in, an app that keeps the highest version ends on the server's value.
  const settle = (list) => list.reduce((cur, e) => (e.version > cur.version ? e : cur), { version: 0 });
  assert.equal(settle(events).region, row.rtc_region);
  assert.equal(settle([...events].reverse()).region, row.rtc_region);
  // The member list and a late joiner see the same.
  const ch = (await as(owner, 'GET', '/bootstrap')).json.servers.flatMap((s) => s.channels).find((c) => c.id === room);
  assert.deepEqual({ region: ch.region, regionVersion: ch.regionVersion }, { region: row.rtc_region, regionVersion: row.rtc_region_v });
  const late = await srv.register();
  const sid = (await as(owner, 'GET', '/bootstrap')).json.servers.find((s) => s.channels.some((c) => c.id === room)).id;
  const inv = (await as(owner, 'POST', `/servers/${sid}/invites`, {})).json;
  await as(late, 'POST', `/invites/${inv.code}/join`);
  const sl = await sock(late.token);
  const res = await ack(sl, 'voice:join', { channelId: room });
  assert.equal(res.ok, true);
  assert.deepEqual({ region: res.region, regionVersion: res.regionVersion }, { region: row.rtc_region, regionVersion: row.rtc_region_v }, 'the join answer carries the active region');
});

test('region version: still refused for people who can’t change it, and DM calls are versioned too', async () => {
  const { member, room } = await call();
  const id = 'regc' + hex(3);
  srv.sql('INSERT INTO regions (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)', id, id, 'x'.repeat(64), Date.now());
  assert.equal((await as(member, 'POST', '/calls/region', { room, region: id })).status, 403);
  assert.equal(srv.sql('SELECT rtc_region_v FROM channels WHERE id = ?', room)[0].rtc_region_v, 0, 'a refused change doesn’t bump the version');
  const { owner: a, member: b } = await community(1);
  const dm = (await as(a, 'POST', '/dms', { userId: b.id })).json;
  assert.ok(dm.id, JSON.stringify(dm));
  const r1 = await as(a, 'POST', '/calls/region', { room: 'dm:' + dm.id, region: id });
  const r2 = await as(b, 'POST', '/calls/region', { room: 'dm:' + dm.id, region: null });
  assert.equal(r2.json.version, r1.json.version + 1);
  assert.equal((await as(a, 'GET', '/bootstrap')).json.dms.find((d) => d.id === dm.id).regionVersion, r2.json.version);
});

// ------------------------------------------------------------------ the call engine, on a fake WebRTC
const pcs = [];
class FakePC {
  constructor(config) {
    this.config = config; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.signalingState = 'stable';
    this.localDescription = null; this.remoteDescription = null; this.lanes = []; this.id = pcs.length; this.closed = false;
    pcs.push(this);
  }
  addTransceiver() { const sender = { track: null, replaceTrack: async (t) => { sender.track = t; }, getParameters: () => ({}), setParameters: async () => {} }; const t = { direction: 'sendrecv', sender }; this.lanes.push(t); return t; }
  getTransceivers() { if (!this.lanes.length && this.remoteDescription) for (let i = 0; i < 4; i++) this.addTransceiver(); return this.lanes; }
  async createOffer() { return { type: 'offer', sdp: `offer-${this.id}` }; }
  async createAnswer() { return { type: 'answer', sdp: `answer-${this.id}` }; }
  async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; this.onicecandidate && this.onicecandidate({ candidate: { toJSON: () => ({ candidate: `c${this.id}` }) } }); }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate() {}
  setConfiguration(c) { this.config = c; }
  async getStats() { return this.stats || new Map(); }
  close() { this.closed = true; this.connectionState = 'closed'; }
  set(state) { this.connectionState = state; this.onconnectionstatechange && this.onconnectionstatechange(); }
}
class FakeTrack {
  constructor(kind, deviceId = 'mic-1') { this.kind = kind; this.deviceId = deviceId; this.readyState = 'live'; this.enabled = true; this.id = Math.random().toString(36).slice(2); }
  stop() { this.readyState = 'ended'; }
  clone() { return new FakeTrack(this.kind, this.deviceId); }
  getSettings() { return { deviceId: this.deviceId }; }
}
let devices = [];
let gum = async ({ audio, video }) => new globalThis.MediaStream([new FakeTrack(video ? 'video' : 'audio', video ? 'cam-1' : (audio.deviceId ? 'mic-x' : 'mic-1'))]);
function fakeSocket(onEmit = () => undefined) {
  const handlers = {}; const sent = [];
  const s = {
    handlers, sent, id: 'me', connected: true,
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    emit(ev, payload, cb) { sent.push({ ev, payload }); const r = onEmit(ev, payload); if (cb) Promise.resolve(r).then((x) => setTimeout(() => cb(x || { ok: true }), 1)); },
    fire(ev, payload) { (handlers[ev] || []).forEach((fn) => fn(payload)); },
    connect() {},
  };
  return s;
}
let VM;
async function engine() {
  if (VM) return VM;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.RTCPeerConnection = FakePC;
  globalThis.MediaStream = class { constructor(tracks = []) { this.tracks = tracks; } getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); } getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); } getTracks() { return this.tracks; } };
  const listeners = {};
  const mediaDevices = {
    getUserMedia: (c) => gum(c), enumerateDevices: async () => devices,
    addEventListener: (ev, fn) => { (listeners[ev] ||= new Set()).add(fn); }, removeEventListener: (ev, fn) => { listeners[ev] && listeners[ev].delete(fn); },
    listeners,
  };
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices }, configurable: true, writable: true });
  VM = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'voice.js')).href);
  return VM;
}
const make = (V, socket, extra = {}) => new V({ socket, getIceServers: () => [], signSdp: async () => 'sig', verifySdp: async () => true, myId: () => 'me-user', ...extra });
const peersOf = (v) => [...v.peers.values()];

test('engine: only legal state changes happen; "connected" only when every connection is up', async () => {
  const { Voice, TRANSITIONS } = await engine();
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? { ok: true, peers: [{ socketId: 'B', userId: 'ub' }, { socketId: 'C', userId: 'uc' }] } : undefined));
  const v = make(Voice, socket);
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    assert.equal(v.setState('connected'), false, 'idle → connected is refused');
    assert.equal(v.state, 'idle');
    assert.equal(v.setState('reconnecting'), false);
    assert.equal(warned, 2, 'and logged');
  } finally { console.warn = warn; }
  for (const [from, list] of Object.entries(TRANSITIONS)) for (const to of list) assert.ok(TRANSITIONS[to], `${from} → ${to} goes to a known state`);
  await v.join('room');
  assert.equal(v.state, 'connecting');
  const [b, c] = peersOf(v);
  b.pc.set('connected');
  assert.equal(v.state, 'connecting', 'one of two up is still connecting');
  assert.notEqual(v.status().label, 'Connected');
  c.pc.set('connected');
  assert.equal(v.state, 'connected');
  assert.equal(v.status().label, 'Connected');
  c.pc.set('disconnected');
  assert.equal(v.state, 'degraded', 'a connection dropping is never shown as connected');
  assert.equal(v.peerState('uc'), 'reconnecting');
  c.pc.set('connected');
  assert.equal(v.state, 'connected');
  v.cleanup();
  assert.equal(v.state, 'idle');
  assert.ok(pcs.slice(-2).every((pc) => pc.closed), 'every connection closed');
  assert.equal(v.listeners.length, 0, 'every listener and timer removed');
});

test('engine: a join is never duplicated, and an old attempt can’t bring a call back after leaving', async () => {
  const { Voice } = await engine();
  let release;
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? new Promise((r) => { release = () => r({ ok: true, peers: [{ socketId: 'B', userId: 'ub' }] }); }) : undefined));
  const v = make(Voice, socket);
  const p1 = v.join('room'); const p2 = v.join('room');
  assert.equal(p1, p2, 'the same attempt');
  await until(() => !!release);
  assert.equal(socket.sent.filter((x) => x.ev === 'voice:join').length, 1, 'one join sent');
  const mic = v.rawStream.getAudioTracks()[0];
  const before = pcs.length;
  await v.leave(); // while the server hasn't answered yet
  release();
  await p1;
  await sleep(20);
  assert.equal(v.state, 'idle');
  assert.equal(v.channelId, null);
  assert.equal(pcs.length, before, 'the stale answer created no connection');
  assert.equal(mic.readyState, 'ended', 'the microphone was released');
});

test('engine: losing the server keeps the call; coming back resumes, keeps working connections and rebuilds broken ones', async () => {
  const { Voice } = await engine();
  let answer = { ok: true, peers: [{ socketId: 'B', userId: 'ub' }, { socketId: 'C', userId: 'uc' }] };
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? answer : undefined));
  const v = make(Voice, socket);
  await v.join('room');
  const [b, c] = peersOf(v);
  b.pc.set('connected'); c.pc.set('connected');
  socket.connected = false; socket.fire('disconnect', 'transport close');
  assert.equal(v.state, 'reconnecting');
  assert.match(v.status().detail, /may still be getting through/, 'honest: media may still flow');
  c.pc.set('failed'); // this one broke while we were away
  assert.equal(v.state, 'reconnecting');
  answer = { ok: true, resumed: true, peers: [{ socketId: 'B2', userId: 'ub' }, { socketId: 'C2', userId: 'uc' }] };
  socket.connected = true; socket.fire('connect');
  await until(() => v.state !== 'reconnecting');
  const rejoin = socket.sent.filter((x) => x.ev === 'voice:join').pop().payload;
  assert.equal(rejoin.resume, true);
  await until(() => v.peers.has('C2') && v.peers.get('C2').pc !== c.pc);
  assert.equal(v.peers.get('B2').pc, b.pc, 'the working connection was kept (moved to the new socket)');
  assert.ok(c.pc.closed, 'the broken one was replaced');
  assert.ok(!v.peers.has('B') && !v.peers.has('C'));
  v.peers.get('C2').pc.set('connected');
  assert.equal(v.state, 'connected');
  v.cleanup();
});

test('engine: rejoin backs off on "slow down", gives up on a refusal, and releases the mic; Retry starts over', async () => {
  const { Voice, backoff, REJOIN } = await engine();
  for (let n = 0; n < 12; n++) {
    const lo = backoff(n, REJOIN, () => 0); const hi = backoff(n, REJOIN, () => 1);
    assert.ok(lo >= Math.min(REJOIN.max, REJOIN.base * 2 ** n) * 0.7 - 1 && hi <= REJOIN.max * 1.3 + 1, `bounded: ${n} ${lo}-${hi}`);
  }
  let replies = [];
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? replies.shift() || { ok: true, peers: [] } : undefined));
  const v = make(Voice, socket);
  await v.join('room');
  assert.equal(v.state, 'connected', 'alone in the call');
  replies = [{ error: 'Slow down.' }, { error: 'You don’t have permission to join this voice channel.' }];
  socket.connected = false; socket.fire('disconnect');
  socket.connected = true; socket.fire('connect');
  await until(() => v.state === 'failed', 5000);
  assert.equal(socket.sent.filter((x) => x.ev === 'voice:join').length, 3, 'tried again after "slow down", then stopped');
  assert.match(v.status().detail, /permission/);
  assert.equal(v.rawStream, null, 'the mic is released while failed');
  assert.equal(v.channelId, 'room', 'the call bar stays, with Retry');
  v.healthCheck(); // (back online, tab visible…)
  await sleep(30);
  assert.equal(v.state, 'failed', 'a refusal isn’t retried by itself');
  await v.retry();
  assert.equal(v.state, 'connected');
  assert.equal(v.channelId, 'room');
  // Failing for network reasons is retried by itself once the server is reachable again.
  v.fail('Couldn’t reach the server for a minute.');
  assert.equal(v.state, 'failed');
  v.healthCheck();
  await until(() => v.state === 'connected');
  assert.equal(v.state, 'connected');
  v.cleanup();
});

test('engine: signals for a replaced connection are ignored; a fresh connection from them replaces ours; simultaneous fresh offers resolve', async () => {
  const { Voice } = await engine();
  const socket = fakeSocket();
  const v = make(Voice, socket);
  v.channelId = 'room';
  const sig = (data, from = 'A', userId = 'ua') => v.queueSignal({ from, userId, data });
  await sig({ sdp: { type: 'offer', sdp: 'o1' }, sig: 's', pc: 'theirs-1' });
  const first = v.peers.get('A');
  assert.equal(first.remotePc, 'theirs-1');
  // A candidate meant for one of our older connections: dropped.
  const n = first.pending.length;
  await sig({ candidate: { candidate: 'old' }, pc: 'theirs-1', topc: 'not-ours' });
  assert.equal(first.pending.length, n);
  // Their app started over (new connection id, no "to"): ours is replaced, not renegotiated.
  await sig({ sdp: { type: 'offer', sdp: 'o2' }, sig: 's', pc: 'theirs-2' }, 'A2');
  const second = v.peers.get('A2');
  assert.ok(first.pc.closed && second && second.pc !== first.pc && second.remotePc === 'theirs-2');
  assert.equal(v.peers.size, 1, 'one connection per person');
  // Outgoing signals carry both ids.
  const out = socket.sent.filter((x) => x.ev === 'voice:signal').pop().payload.data;
  assert.equal(out.pc, second.pcId); assert.equal(out.topc, 'theirs-2');
  v.cleanup();
  // Both sides start a fresh connection at once: the lower user id gives way.
  for (const [me, them, keepsOurs] of [['m-user', 'z-user', false], ['z-user', 'a-user', true]]) {
    const s2 = fakeSocket();
    const w = make(Voice, s2, { myId: () => me });
    w.channelId = 'room';
    const ours = await w.createPeer('X', them, true);
    await w.queueSignal({ from: 'X', userId: them, data: { sdp: { type: 'offer', sdp: 'theirs' }, sig: 's', pc: 'p-them' } });
    const now = w.peers.get('X');
    assert.equal(now === ours, keepsOurs, `${me} vs ${them}`);
    assert.equal(now.pc.signalingState, keepsOurs ? 'have-local-offer' : 'stable');
    w.cleanup();
  }
});

test('engine: someone the server never listed is flagged; someone listed who drops out is closed after a grace', async () => {
  const VMod = await engine();
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? { ok: true, peers: [{ socketId: 'B', userId: 'ub' }] } : undefined));
  const v = make(VMod.Voice, socket);
  v.channelId = 'room'; // (set so the list applies before the join answer, as in the app)
  v.setListed(['me-user', 'ub']);
  v.channelId = null;
  await v.join('room');
  v.setListed(['me-user', 'ub']);
  await v.queueSignal({ from: 'H', userId: 'hidden', data: { sdp: { type: 'offer', sdp: 'x' }, sig: 's', pc: 'h1' } });
  assert.deepEqual(v.unlistedPeers(0).map((p) => [p.userId, p.neverListed]), [['hidden', true]]);
  assert.deepEqual(v.unlistedPeers(60000), [], 'not before a short delay (the list may simply be a moment behind)');
  // The listed one drops out of the list (a server restart that forgot them): kept a while, then closed.
  v.setListed(['me-user']);
  const b = v.peerByUser('ub');
  assert.equal(b.everListed, true);
  b.unlistedSince = Date.now() - VMod.UNLISTED_GRACE - 1;
  v.peerByUser('hidden').unlistedSince = Date.now() - VMod.UNLISTED_GRACE - 1;
  v.tick();
  assert.ok(b.pc.closed, 'closed after the grace');
  assert.equal(v.peerByUser('hidden'), null);
  v.cleanup();
});

test('engine: a vanished mic switches to the default one live; no mic means listen-only; a vanished camera turns video off', async () => {
  const { Voice } = await engine();
  const notices = [];
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? { ok: true, peers: [{ socketId: 'B', userId: 'ub' }] } : undefined));
  const v = make(Voice, socket, { onNotice: (t) => notices.push(t) });
  await v.join('room');
  const peer = peersOf(v)[0];
  peer.pc.set('connected');
  const lane = () => peer.pc.getTransceivers()[0].sender.track;
  const oldTrack = lane();
  // Device list without the mic in use (mic-1): switch to the default, on the same connection.
  devices = [{ kind: 'audioinput', deviceId: 'other' }, { kind: 'videoinput', deviceId: 'cam-1' }];
  await v.checkDevices('devicechange');
  assert.notEqual(lane(), oldTrack, 'the live track was swapped');
  assert.equal(peersOf(v)[0].pc, peer.pc, 'without a new connection');
  assert.match(notices.pop(), /switched to the default one/);
  // Camera on, then unplugged.
  await v.setCamera(true);
  assert.ok(v.camStream);
  devices = [{ kind: 'audioinput', deviceId: 'other' }];
  await v.checkDevices('devicechange');
  assert.equal(v.camStream, null);
  assert.match(notices.pop(), /camera was disconnected/);
  assert.equal(socket.sent.filter((x) => x.ev === 'voice:update').pop().payload.video, false, 'the others see video off');
  // Every mic gone: listen-only.
  devices = [];
  const realGum = gum;
  gum = async ({ audio }) => { if (audio) { const e = new Error('none'); e.name = 'NotFoundError'; throw e; } return realGum({ video: true }); };
  v.rawStream.getAudioTracks()[0].readyState = 'ended';
  await v.checkDevices('ended');
  assert.equal(v.noMic, true);
  assert.equal(v.muted, true);
  assert.match(notices.pop(), /listen-only/);
  // Permission taken away: listen-only, and said clearly.
  gum = realGum;
  devices = [{ kind: 'audioinput', deviceId: 'mic-1' }];
  await v.checkDevices('devicechange');
  assert.equal(v.noMic, false, 'a mic plugged in while listen-only is picked up (muted)');
  assert.equal(v.muted, true);
  v.onPermission('microphone', 'denied');
  assert.equal(v.noMic, true);
  assert.equal(v.speakLocked, true);
  v.setMuted(false);
  assert.equal(v.muted, true, 'can’t unmute without permission');
  assert.match(notices.pop(), /Microphone access was turned off/);
  v.cleanup();
  assert.equal(navigator.mediaDevices.listeners.devicechange.size, 0, 'the devicechange listener is removed on leaving');
});

test('engine: a pinned region whose relay hands out nothing falls back to automatic relays, once, and says so', async () => {
  const { Voice } = await engine();
  const notices = []; const asked = [];
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? { ok: true, peers: [{ socketId: 'B', userId: 'ub' }] } : undefined));
  const v = make(Voice, socket, {
    onNotice: (t) => notices.push(t),
    getIceServers: ({ automatic } = {}) => { asked.push(!!automatic); return automatic ? [{ urls: 'stun:x' }] : { iceServers: [{ urls: 'turn:dead' }], iceTransportPolicy: 'relay' }; },
  });
  // A relay that answers nothing: no candidate before gathering ends.
  const realSLD = FakePC.prototype.setLocalDescription;
  FakePC.prototype.setLocalDescription = async function (d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; if (this.config.iceTransportPolicy === 'relay') this.onicecandidate && this.onicecandidate({ candidate: null }); else realSLD.call(this, d); };
  try {
    await v.join('room');
    await until(() => v.relayFallback && peersOf(v)[0] && !peersOf(v)[0].relayOnly);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /relay isn’t answering/);
    assert.equal(peersOf(v)[0].pc.config.iceTransportPolicy, undefined, 'the new connection uses automatic relays');
    v.switchNetwork();
    assert.equal(v.relayFallback, false, 'a new region gets a fresh chance');
  } finally { FakePC.prototype.setLocalDescription = realSLD; v.cleanup(); }
});

test('engine: region switch shows "switching" until every connection is back, and measures it', async () => {
  const { Voice } = await engine();
  const socket = fakeSocket((ev) => (ev === 'voice:join' ? { ok: true, peers: [{ socketId: 'B', userId: 'ub' }] } : undefined));
  const v = make(Voice, socket);
  await v.join('room');
  peersOf(v)[0].pc.set('connected');
  assert.equal(v.state, 'connected');
  v.switchNetwork();
  assert.equal(v.state, 'switching');
  assert.equal(v.status().label, 'Switching region…');
  await until(() => peersOf(v)[0] && peersOf(v)[0].pc.connectionState === 'new', 3000);
  assert.equal(v.state, 'switching', 'still switching while the new connection comes up');
  peersOf(v)[0].pc.set('connected');
  assert.equal(v.state, 'connected');
  assert.equal(typeof v.lastSwitchMs, 'number');
  v.cleanup();
});

test('diagnostics: numbers from getStats, null ("unavailable") when missing (not 0), never an address or device id', async () => {
  const { summarizeStats } = await engine();
  const report = new Map([
    ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'CP' }],
    ['CP', { id: 'CP', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.042, availableOutgoingBitrate: 1500000, timestamp: 1000 }],
    ['L', { id: 'L', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'udp', address: '203.0.113.7', ip: '203.0.113.7', port: 50000, url: 'turn:relay.example:3478?transport=udp' }],
    ['R', { id: 'R', type: 'remote-candidate', candidateType: 'srflx', address: '198.51.100.9', port: 4000 }],
    ['IA', { id: 'IA', type: 'inbound-rtp', kind: 'audio', packetsLost: 5, packetsReceived: 95, jitter: 0.012, audioLevel: 0.25, bytesReceived: 5000, timestamp: 1000 }],
    ['MS', { id: 'MS', type: 'media-source', kind: 'audio', trackIdentifier: 'device-abc' }],
  ]);
  const one = summarizeStats(report, null, [{ urls: ['turn:relay.example:3478?transport=udp'], region: 'Frankfurt' }]);
  assert.deepEqual(one.metrics, {
    rttMs: 42, lossPct: 5, jitterMs: 12, outKbps: 1500, inFps: null, outFps: null, inResolution: null, outResolution: null,
    audioLevel: 0.25, audioFlowing: true, path: 'relay', remotePath: 'srflx', relayProtocol: 'udp', relay: 'Frankfurt',
  });
  const text = JSON.stringify(one.metrics);
  for (const secret of ['203.0.113.7', '198.51.100.9', 'relay.example', 'device-abc', '50000']) assert.ok(!text.includes(secret), `never shows ${secret}`);
  // Next sample: loss over the interval; no new audio bytes means audio isn't flowing.
  const report2 = new Map(report);
  report2.set('IA', { ...report.get('IA'), packetsLost: 5, packetsReceived: 195, bytesReceived: 5000, timestamp: 2000 });
  const two = summarizeStats(report2, one.raw, []);
  assert.equal(two.metrics.lossPct, 0, 'no loss in the last interval is 0');
  assert.equal(two.metrics.audioFlowing, false);
  assert.equal(two.metrics.relay, 'a relay', 'an unknown relay is never named by its address');
  // Nothing reported at all: every number unavailable.
  const none = summarizeStats(new Map(), null, []);
  assert.ok(Object.values(none.metrics).every((x) => x === null), JSON.stringify(none.metrics));
  assert.ok(Object.values(summarizeStats(null).metrics).every((x) => x === null));
});
