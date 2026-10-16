// Call handshakes are checked against the keys this device pinned (docs/VOICE.md section 6, SECURITY.md row 152).
// No stubs for the check itself: the real public/js/e2ee.js and secure.js run in Node, and in the second half the real
// call engine (voice.js) is wired to secure.js the way app.js wires it, on a fake WebRTC that counts every
// RTCPeerConnection it is asked for. The malicious server is whatever lands in S.users (socket user:update →
// app.js setUser → secure.js mergeUser) and whatever GET /api/users/:id answers.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const store = new Map(); // this device's localStorage (the pin store)
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { crypto: globalThis.crypto, addEventListener() {}, removeEventListener() {} };

// What the server answers to GET /api/users/:id (served[id]), or a failure for everything when `down` is set.
const served = {};
let down = false;
globalThis.fetch = async (url) => {
  const m = String(url).match(/^\/api\/users\/([^/?]+)$/);
  if (down) return new Response('{"error":"Server error"}', { status: 500, headers: { 'content-type': 'application/json' } });
  if (!m || !served[m[1]]) return new Response('{"error":"Not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(served[m[1]]), { status: 200, headers: { 'content-type': 'application/json' } });
};

// A fake WebRTC (as in voice-reliability.test.js): every RTCPeerConnection made is in `pcs`.
const pcs = [];
class FakePC {
  constructor(config) {
    this.config = config; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.signalingState = 'stable';
    this.localDescription = null; this.remoteDescription = null; this.lanes = []; this.id = pcs.length; this.closed = false;
    pcs.push(this);
  }
  addTransceiver() { const sender = { track: null, replaceTrack: async (t) => { sender.track = t; }, getParameters: () => ({}), setParameters: async () => {} }; const t = { direction: 'sendrecv', sender }; this.lanes.push(t); return t; }
  getTransceivers() { if (!this.lanes.length && this.remoteDescription) for (let i = 0; i < 4; i++) this.addTransceiver(); return this.lanes; }
  async createOffer() { return { type: 'offer', sdp: `v=0\r\na=fingerprint:sha-256 0${this.id}:B0:B0\r\na=setup:actpass\r\n` }; }
  async createAnswer() { return { type: 'answer', sdp: `v=0\r\na=fingerprint:sha-256 0${this.id}:B1:B1\r\na=setup:active\r\n` }; }
  async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate() {}
  setConfiguration(c) { this.config = c; }
  async getStats() { return new Map(); }
  close() { this.closed = true; this.connectionState = 'closed'; }
}
globalThis.RTCPeerConnection = FakePC;
globalThis.MediaStream = class { constructor(tracks = []) { this.tracks = tracks; } getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); } getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); } getTracks() { return this.tracks; } };
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => new globalThis.MediaStream([]), enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} } }, configurable: true, writable: true });

const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;
let E; let SEC; let VM;
let alice; let bob; let carol; let evil; let alice2;
const ROOM = 'room-1';

async function person(id) {
  const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const k = await E.createIdentity(wrapKey);
  return { id, ...k, ...(await E.createSigningKey(k.privateKey, k.publicKey)) };
}
// The server's whole record about someone (server/index.js publicUser always sends both key fields).
const rec = (p, extra = {}) => ({ id: p.id, username: p.id, publicKey: p.publicKey, signPublicKey: p.signPublicKey, ...extra });
const desc = (fp, type = 'offer') => ({ type, sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ${fp}\r\na=setup:actpass\r\n` });
// The text secure.js signs (sdpText): room, sender, recipient, type and the SDP with its DTLS fingerprint.
const signAs = (signer, from, to, d, room = ROOM) => E.sign(signer.signKey, `hearth-voice|${room}|${from}|${to}|${d.type}|${d.sdp}`);
const REAL = desc('AA:AA:AA:AA');
const EVIL = desc('EE:EE:EE:EE');

before(async () => {
  E = await import(js('e2ee.js'));
  SEC = await import(js('secure.js'));
  VM = await import(js('voice.js'));
  // ua and alice2 are the same account: alice2 is ua's keys after a password reset without the recovery key.
  [alice, bob, carol, evil, alice2] = await Promise.all(['ua', 'ub', 'uc', 'ua', 'ua'].map(person));
});

// Bob's device: a fresh pin store, S as in app.js, and the server's user:update (setUser, then sec.trust). Records go
// through JSON as on the wire, so a field set to undefined arrives left out, as publicUser leaves out a mark that's off.
// { reload: true } is the same device after a page reload: its pin store stays, the app's user cache starts empty.
function bobDevice({ reload = false } = {}) {
  if (!reload) {
    store.clear();
    for (const k of Object.keys(served)) delete served[k];
  }
  down = false;
  const S = { me: rec(bob), users: {}, privateKey: bob.privateKey, signKey: bob.signKey, servers: [], dms: [], config: {} };
  const warnings = [];
  const sec = SEC.createSecure({ S, onKeyWarning: (u) => warnings.push(u.id) });
  const update = (sent) => { const u = JSON.parse(JSON.stringify(sent)); S.users[u.id] = SEC.mergeUser(S.users[u.id], u); served[u.id] = S.users[u.id]; sec.trust(u); };
  const pin = (id) => JSON.parse(store.get(`hearth.pins.${bob.id}`) || '{}')[id] || null;
  return { S, sec, warnings, update, pin };
}
const offerFrom = async (d, who = alice, signer = who) => signAs(signer, who.id, bob.id, d);

// ------------------------------------------------------------------ the check itself (secure.js checkSdp)
test('an honest handshake from someone seen for the first time is accepted, and their keys are pinned', async () => {
  const b = bobDevice();
  b.update(rec(alice));
  // Signed by Alice's own app (secure.js signSdp), not just by the same formula.
  const SA = { me: rec(alice), users: {}, privateKey: alice.privateKey, signKey: alice.signKey, servers: [], dms: [] };
  const sig = await SEC.createSecure({ S: SA }).signSdp(ROOM, bob.id, REAL);
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, sig), { ok: true });
  assert.equal(await b.sec.verifySdp(ROOM, alice.id, REAL, sig), true);
  assert.deepEqual(b.pin(alice.id), { e: alice.publicKey, s: alice.signPublicKey }, 'pinned on first sight (trust on first use)');
  assert.deepEqual(b.warnings, []);
});

test('a pinned contact served with no identity key and the server’s signing key: refused and warned, pin untouched', async () => {
  // The bypass found in review: checkPin answered "ok" for a record without an identity key before it looked at the
  // pin, and the handshake was checked with the signing key the server listed. Every shape of "no identity key".
  const shapes = [
    ['publicKey null', { publicKey: null }],
    ['publicKey ""', { publicKey: '' }],
    ['publicKey "" as a bot', { publicKey: '', bot: true }],
    ['publicKey "" as a deleted account', { publicKey: '', deleted: true }],
  ];
  for (const verified of [false, true]) {
    for (const [label, blank] of shapes) {
      const b = bobDevice();
      b.update(rec(alice));
      if (verified) assert.equal(b.sec.acceptKeys(b.S.users[alice.id]), true, 'safety numbers compared');
      const before = b.pin(alice.id);
      b.update({ id: alice.id, username: alice.id, signPublicKey: evil.signPublicKey, ...blank });
      const what = `${label}${verified ? ', verified' : ''}`;
      const r = await b.sec.checkSdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, evil));
      assert.equal(r.ok, false, `${what}: the server's own offer is refused`);
      assert.equal(r.why, 'no-key', what);
      assert.equal(await b.sec.verifySdp(ROOM, alice.id, REAL, await offerFrom(REAL)), false, `${what}: nothing is accepted while the key is missing`);
      assert.equal(b.sec.keyChanged(b.S.users[alice.id]), true, `${what}: counts as a key change`);
      assert.deepEqual(b.warnings, [alice.id], `${what}: the user is warned`);
      assert.deepEqual(b.pin(alice.id), before, `${what}: the pin is untouched`);
      // The same record never makes the server's key one that vouches for Alice's messages.
      assert.ok(!b.sec.signKeysFor(b.S.users[alice.id]).includes(evil.signPublicKey), `${what}: not a key for her messages either`);
      assert.equal(b.sec.acceptKeys(b.S.users[alice.id]), false, `${what}: and there is nothing to accept`);
      assert.deepEqual(b.pin(alice.id), before);
      // The server lists her real keys again (no bot or deleted mark: publicUser leaves them out): back to normal,
      // nothing left behind.
      b.update(rec(alice));
      assert.equal('deleted' in b.S.users[alice.id] || 'bot' in b.S.users[alice.id], false, `${what}: no mark lingers`);
      assert.equal(b.sec.keyChanged(b.S.users[alice.id]), false, what);
      assert.equal(await b.sec.verifySdp(ROOM, alice.id, REAL, await offerFrom(REAL)), true, what);
    }
  }
});

test('the same bypass through GET /users/:id alone (nothing cached yet for that person)', async () => {
  const b = bobDevice();
  b.update(rec(alice));
  delete b.S.users[alice.id]; // a fresh start of the app: the pin store remains, the user cache doesn't
  served[alice.id] = { id: alice.id, username: alice.id, publicKey: null, signPublicKey: evil.signPublicKey };
  const r = await b.sec.checkSdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, evil));
  assert.deepEqual(r, { ok: false, why: 'no-key' });
  assert.equal(b.sec.keyChanged(b.S.users[alice.id]), true);
});

test('a pinned contact served with the identity key LEFT OUT (no publicKey field) and the server’s signing key: the same key change', async () => {
  // Found in review of the fix above: only a record with the publicKey field counted as one that says something about
  // keys, so leaving the field out (in the start-up user list after a reload, and in GET /users/:id, which is asked
  // when the cached record has no identity key) still made the server's signing key hers. An honest server never
  // sends that shape: publicUser always has both fields.
  const omitted = { id: alice.id, username: alice.id, signPublicKey: evil.signPublicKey };
  for (const verified of [false, true]) {
    const what = verified ? 'verified' : 'pinned';
    const b = bobDevice();
    b.update(rec(alice));
    if (verified) assert.equal(b.sec.acceptKeys(b.S.users[alice.id]), true);
    const before = b.pin(alice.id);
    const r = bobDevice({ reload: true }); // nothing cached about her: the server's list is all the app has
    r.update(omitted);
    const u = r.S.users[alice.id];
    assert.equal('publicKey' in u, false, 'the shape under test');
    assert.equal(E.checkPin(bob.id, u), 'changed', what);
    assert.equal(r.sec.keyChanged(u), true, what);
    assert.deepEqual(r.warnings, [alice.id], `${what}: the user is warned`);
    assert.deepEqual(r.sec.signKeysFor(u), [alice.signPublicKey], `${what}: only her pinned key vouches for what she wrote`);
    assert.deepEqual(await r.sec.checkSdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, evil)), { ok: false, why: 'no-key' }, what);
    assert.equal(await r.sec.verifySdp(ROOM, alice.id, REAL, await offerFrom(REAL)), false, what);
    assert.equal(r.sec.acceptKeys(u), false, `${what}: nothing to accept`);
    assert.deepEqual(r.pin(alice.id), before, `${what}: the pin is untouched`);
    // Through GET /users/:id alone.
    const g = bobDevice({ reload: true });
    served[alice.id] = omitted;
    assert.deepEqual(await g.sec.checkSdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, evil)), { ok: false, why: 'no-key' }, `${what}, GET`);
    assert.equal(g.sec.keyChanged(g.S.users[alice.id]), true, `${what}, GET`);
    assert.ok(!g.sec.signKeysFor(g.S.users[alice.id]).includes(evil.signPublicKey), `${what}, GET`);
    // Her real record again: back to normal.
    r.update(rec(alice));
    assert.equal(r.sec.keyChanged(r.S.users[alice.id]), false, what);
    assert.equal(await r.sec.verifySdp(ROOM, alice.id, REAL, await offerFrom(REAL)), true, what);
  }
  // A record that says nothing about keys at all (a placeholder, a presence update) still leaves the pin alone.
  const b = bobDevice();
  b.update(rec(alice));
  for (const v of [{ id: alice.id, username: alice.id }, { id: alice.id, presence: 'online' }, { id: alice.id, deleted: true }]) {
    assert.equal(E.checkPin(bob.id, v), 'ok', JSON.stringify(v));
  }
  assert.equal(E.checkPin(bob.id, { id: alice.id, username: alice.id, signPublicKey: null }), 'changed', 'a signing key field without an identity key is no placeholder');
});

test('nobody pinned yet: a signing key listed without an identity key never vouches for anyone', async () => {
  // Nothing gets pinned without an identity key, so the server could swap such a signing key at will: it counts for
  // nothing (secure.js keysOf), not even trust on first use.
  const b = bobDevice();
  b.update({ id: alice.id, username: alice.id, signPublicKey: evil.signPublicKey });
  assert.equal(b.pin(alice.id), null);
  assert.deepEqual(b.sec.signKeysFor(b.S.users[alice.id]), []);
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, evil)), { ok: false, why: 'no-key' });
});

test('a pinned member served with the identity key left out (or null) can’t hand out a server key the server made, nor vouch for its messages', async () => {
  // review probe omit-field-epoch2.mjs: Bob holds the real epoch-1 key from Alice (pinned and verified). After a reload
  // the server lists Alice without her identity key and with a signing key of its own, and announces epoch 2 as
  // current with a "share from Alice" it made itself. With the field left out, that key used to become the one Bob
  // writes with, and the server's messages "from Alice" in it showed as verified. Last, the honest control: the same
  // steps with her real record and a real share from her.
  const SID = 'srv-1';
  const share = async (raw, epoch, signer) => ({ epoch, wrapperId: alice.id, check: await E.keyCheck(raw, SID, epoch), createdAt: Date.now(),
    wrapped: await E.wrapGroupKey({ raw, serverId: SID, epoch, recipientId: bob.id, recipientPub: bob.publicKey, wrapperId: alice.id, signKey: signer.signKey }) });
  const cases = [
    ['identity key left out', { id: alice.id, username: alice.id, signPublicKey: evil.signPublicKey }, evil],
    ['identity key null', { id: alice.id, username: alice.id, publicKey: null, signPublicKey: evil.signPublicKey }, evil],
    ['honest', rec(alice), alice],
  ];
  for (const [label, listed, signer] of cases) {
    const honest = signer === alice;
    const b = bobDevice();
    b.S.servers = [{ id: SID, memberIds: [alice.id, bob.id] }];
    b.update(rec(alice));
    assert.equal(b.sec.acceptKeys(b.S.users[alice.id]), true);
    const real1 = crypto.getRandomValues(new Uint8Array(32));
    const k1 = await share(real1, 1, alice);
    await quiet(() => b.sec.applyState({ serverId: SID, keyEpoch: 1, keys: [k1] }));
    assert.equal(b.sec.currentKey(SID).epoch, 1, `${label}: the real key from Alice`);
    // Reload, then the server's version of events.
    const r = bobDevice({ reload: true });
    r.S.servers = [{ id: SID, memberIds: [alice.id, bob.id] }];
    r.update(listed);
    const raw2 = crypto.getRandomValues(new Uint8Array(32));
    const k2 = await share(raw2, 2, signer);
    await quiet(() => r.sec.applyState({ serverId: SID, keyEpoch: 2, keys: [k1, k2] }));
    const cur = r.sec.currentKey(SID);
    const text = await E.encryptGroup({ raw: raw2, serverId: SID, channelId: 'c1', epoch: 2, authorId: alice.id, signKey: signer.signKey, payload: { t: 'hello from epoch 2' } });
    const m = { serverId: SID, channelId: 'c1', authorId: alice.id, ciphertext: text, createdAt: Date.now() };
    await quiet(() => r.sec.decryptChannelMessage(m));
    if (honest) {
      assert.equal(cur && cur.epoch, 2, 'honest: her new key is the one to write with');
      assert.deepEqual([m.dec.t, m.dec.verified], ['hello from epoch 2', true], 'honest: her message checks out');
      assert.deepEqual(r.warnings, []);
    } else {
      assert.ok(!cur || !Buffer.from(cur.raw).equals(Buffer.from(raw2)), `${label}: the server's key is never the one to write with`);
      assert.notEqual(m.dec.verified, true, `${label}: its message "from Alice" is not verified`);
      assert.notEqual(m.dec.t, 'hello from epoch 2', `${label}: nor even opened`);
      assert.deepEqual(r.warnings, [alice.id], `${label}: the user is warned`);
    }
  }
});

test('marks the server sends only while they’re set don’t linger: one record saying "deleted" doesn’t block calls for good', async () => {
  // review probe lingering.mjs: publicUser leaves deleted, bot and keysReset out when they're off, so a whole record
  // without them means off (secure.js mergeUser), while an update that isn't a whole record leaves them as they were.
  const b = bobDevice();
  b.update(rec(alice));
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: true });
  b.update(rec(alice, { deleted: true, bot: true }));
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: false, why: 'deleted' });
  b.update({ id: alice.id, presence: 'online' });
  assert.equal(b.S.users[alice.id].deleted, true, 'a presence update says nothing about it');
  b.update(rec(alice, { deleted: undefined, bot: undefined })); // the wire drops both
  assert.equal('deleted' in b.S.users[alice.id], false);
  assert.equal('bot' in b.S.users[alice.id], false);
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: true }, 'calls work again');
  assert.equal(SEC.mergeUser({ id: 'x', publicKey: 'k', deleted: true }, { id: 'x', publicKey: 'k', deleted: true }).deleted, true, 'kept while sent');
});

test('what the app says: each refused call says why, and a missing key means no safety numbers', () => {
  const said = (why) => SEC.callRefusedText(why, 'Alice');
  assert.match(said('key-changed'), /^Alice’s security key changed, so their call connection was blocked\. Compare safety numbers/);
  assert.match(said('key-changed'), /Verify encryption/, 'says where to verify');
  assert.match(said('deleted'), /Alice: that account was deleted/);
  assert.doesNotMatch(said('deleted'), /no usable security key/, 'a deleted account isn’t said to have no key');
  assert.match(said('no-key'), /the server lists no usable security key for them/);
  assert.match(said('lookup-failed'), /couldn’t be loaded/);
  assert.match(said('self'), /claimed to come from your own account/);
  assert.match(said('bad-signature'), /security signature didn't check out/);
  assert.equal(said(undefined), said('bad-signature'), 'anything else is a bad signature');
  for (const why of ['key-changed', 'deleted', 'no-key', 'lookup-failed', 'bad-signature']) assert.match(said(why), /Alice/, why);
  // openSafetyNumber: numbers only when there's an identity key to compare.
  const none = (u) => SEC.noSafetyNumbersText(u, 'Alice');
  assert.equal(none(rec(alice)), null);
  assert.equal(none(rec(alice, { deleted: true })), null, 'an account deleted now keeps its keys: numbers as before');
  assert.match(none(rec(alice, { publicKey: null })), /The server lists no security key for Alice/);
  assert.match(none(rec(alice, { publicKey: '' })), /no safety numbers to compare/);
  assert.match(none({ id: alice.id, username: alice.id, signPublicKey: evil.signPublicKey }), /no security key for Alice/, 'left out');
  assert.match(none({ id: alice.id, publicKey: '', signPublicKey: null, deleted: true }), /^This account was deleted/);
});

test('a deleted account: one deleted by an older version (no keys at all) is no key change; neither kind is ever in a call', async () => {
  const b = bobDevice();
  b.update(rec(alice));
  // Older versions cleared both keys on deletion: nothing the server could use, so it's left as pinned.
  b.update({ id: alice.id, username: 'deleted-1', publicKey: '', signPublicKey: null, deleted: true });
  assert.equal(b.sec.keyChanged(b.S.users[alice.id]), false);
  assert.deepEqual(b.warnings, [], 'no "security key changed" for someone who deleted their account');
  assert.deepEqual(b.sec.signKeysFor(b.S.users[alice.id]), [alice.signPublicKey], 'what she wrote still checks out against her pinned key');
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: false, why: 'deleted' }, 'said as a deleted account');
  // Never pinned (first seen after it was deleted): the same.
  const n = bobDevice();
  n.update({ id: alice.id, username: 'deleted-1', publicKey: '', signPublicKey: null, deleted: true });
  assert.deepEqual(await n.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: false, why: 'deleted' });
  assert.deepEqual(n.warnings, []);
  // Deleted now: the account keeps its keys (old messages stay readable), and it can't be in a call.
  const c = bobDevice();
  c.update(rec(alice));
  c.update(rec(alice, { deleted: true }));
  assert.equal(c.sec.keyChanged(c.S.users[alice.id]), false);
  assert.deepEqual(await c.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: false, why: 'deleted' });
  // A deleted mark with a signing key but no identity key is no real deletion (old ones cleared both): a change.
  const d = bobDevice();
  d.update(rec(alice));
  d.update({ id: alice.id, username: 'deleted-2', publicKey: '', signPublicKey: evil.signPublicKey, deleted: true });
  assert.equal(d.sec.keyChanged(d.S.users[alice.id]), true);
});

test('swapped keys are refused as a key change: a new signing key, a new identity key, both, or a signing key taken away', async () => {
  const cases = [
    ['signing key swapped', rec(alice, { signPublicKey: evil.signPublicKey }), EVIL, evil],
    ['both keys swapped', rec(evil), EVIL, evil],
    ['identity key swapped, honest offer', rec(alice, { publicKey: evil.publicKey }), REAL, alice],
    ['signing key taken away', rec(alice, { signPublicKey: null }), REAL, alice],
    ['signing key emptied', rec(alice, { signPublicKey: '' }), REAL, alice],
  ];
  for (const [label, served2, d, signer] of cases) {
    const b = bobDevice();
    b.update(rec(alice));
    b.update({ ...served2, id: alice.id });
    assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, d, await offerFrom(d, alice, signer)), { ok: false, why: 'key-changed' }, label);
    assert.deepEqual(b.warnings, [alice.id], label);
    assert.deepEqual(b.pin(alice.id), { e: alice.publicKey, s: alice.signPublicKey }, label);
    b.update(rec(alice));
    assert.equal(await b.sec.verifySdp(ROOM, alice.id, REAL, await offerFrom(REAL)), true, `${label}: honest again`);
  }
});

test('a genuine key change (a reset) waits until the user accepts it; then the new key works and the old one doesn’t', async () => {
  const b = bobDevice();
  b.update(rec(alice));
  b.update(rec(alice2));
  const r = await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL, alice2));
  assert.deepEqual(r, { ok: false, why: 'key-changed' }, 'said as a key change, not as tampering');
  assert.deepEqual(b.warnings, [alice.id]);
  assert.equal(b.sec.acceptKeys(b.S.users[alice.id]), true); // "Numbers match — trust new key"
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL, alice2)), { ok: true });
  assert.equal(await b.sec.verifySdp(ROOM, alice.id, REAL, await offerFrom(REAL, alice)), false, 'the old key no longer counts');
});

test('a foreign key: an offer signed by someone else, claiming to be Alice, is refused even though her record is real', async () => {
  const b = bobDevice();
  b.update(rec(alice));
  b.update(rec(carol));
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, evil)), { ok: false, why: 'bad-signature' });
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, carol)), { ok: false, why: 'bad-signature' }, 'another member’s key');
  assert.deepEqual(b.warnings, []);
});

test('stripped, swapped and misdirected signatures are refused', async () => {
  const b = bobDevice();
  b.update(rec(alice));
  const sig = await offerFrom(REAL);
  const no = { ok: false, why: 'bad-signature' };
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, undefined), no, 'no signature');
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, ''), no, 'empty signature');
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, 'AAAA'), no, 'garbage');
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, EVIL, sig), no, 'DTLS fingerprint swapped under a genuine signature');
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, { ...REAL, type: 'answer' }, sig), no, 'relabelled as an answer');
  assert.deepEqual(await b.sec.checkSdp('room-2', alice.id, REAL, sig), no, 'replayed into another room');
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await signAs(alice, alice.id, carol.id, REAL)), no, 'made for another recipient');
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, { type: 'offer', sdp: 42 }, sig), no, 'not an SDP');
  assert.deepEqual(await b.sec.checkSdp(ROOM, bob.id, REAL, await signAs(bob, bob.id, bob.id, REAL)), no, 'claims to come from this account');
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, sig), { ok: true }, 'the genuine one still works');
});

test('the check uses the PINNED signing key: a record that leaves it out still verifies, one the server alone lists never does', async () => {
  const b = bobDevice();
  b.update(rec(alice));
  b.S.users[alice.id] = { id: alice.id, username: alice.id, publicKey: alice.publicKey }; // a record without the field
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: true });
  assert.equal(await b.sec.verifySdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, evil)), false);
});

test('pinned before they had a signing key: the first one is taken on trust, unless they were verified by safety number', async () => {
  // Not verified: trust on first use, as for a new contact (documented in docs/VOICE.md section 6).
  const b = bobDevice();
  b.update(rec(alice, { signPublicKey: null }));
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: false, why: 'no-key' }, 'no signing key yet: nothing to check with');
  b.update(rec(alice));
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: true });
  assert.deepEqual(b.pin(alice.id), { e: alice.publicKey, s: alice.signPublicKey });
  b.update(rec(alice, { signPublicKey: evil.signPublicKey }));
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, evil)), { ok: false, why: 'key-changed' }, 'from then on it’s pinned');
  // Verified while she had none: her safety numbers covered "no signing key", so a signing key appearing is a change
  // to verify again, whoever's it is.
  const c = bobDevice();
  c.update(rec(alice, { signPublicKey: null }));
  assert.equal(c.sec.acceptKeys(c.S.users[alice.id]), true);
  c.update(rec(alice, { signPublicKey: evil.signPublicKey }));
  assert.deepEqual(await c.sec.checkSdp(ROOM, alice.id, EVIL, await offerFrom(EVIL, alice, evil)), { ok: false, why: 'key-changed' });
  assert.deepEqual(c.warnings, [alice.id]);
  assert.equal(c.pin(alice.id).s, null, 'not adopted');
  c.update(rec(alice)); // her real one: still a change until she's verified again
  assert.equal(c.sec.keyChanged(c.S.users[alice.id]), true);
  assert.equal(c.sec.acceptKeys(c.S.users[alice.id]), true);
  assert.deepEqual(await c.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: true });
  const p = c.pin(alice.id);
  assert.deepEqual([p.e, p.s, p.verified], [alice.publicKey, alice.signPublicKey, true]);
});

test('keys that can’t be loaded refuse the handshake', async () => {
  const b = bobDevice();
  down = true;
  assert.deepEqual(await b.sec.checkSdp(ROOM, alice.id, REAL, await offerFrom(REAL)), { ok: false, why: 'lookup-failed' });
  down = false;
});

test('the member list (checkPins) gives the same answer as checkPin for every case above', async () => {
  const variants = [
    rec(alice), rec(alice, { publicKey: null, signPublicKey: evil.signPublicKey }), rec(alice, { publicKey: '', deleted: true, signPublicKey: null }),
    rec(alice, { publicKey: '', deleted: true }), rec(alice, { signPublicKey: null }), rec(alice, { signPublicKey: evil.signPublicKey }), rec(alice2),
    { id: alice.id, username: alice.id }, // a placeholder: says nothing about keys
    { id: alice.id, username: alice.id, signPublicKey: evil.signPublicKey }, // the identity key left out
    { id: alice.id, username: alice.id, signPublicKey: null }, { id: alice.id, deleted: true },
  ];
  for (const v of variants) {
    const b = bobDevice();
    b.update(rec(alice));
    const bulk = E.checkPins(bob.id, [v]).has(alice.id);
    assert.equal(bulk, E.checkPin(bob.id, v) === 'changed', JSON.stringify({ ...v, publicKey: v.publicKey && v.publicKey.slice(0, 8) }));
  }
});

// ------------------------------------------------------------------ the call engine wired to the real check
function bobEngine({ verify } = {}) {
  const b = bobDevice();
  const sent = []; const warnings = [];
  const socket = { id: 'SB', connected: true, on() {}, emit(ev, p, cb) { sent.push({ ev, p }); if (cb) setTimeout(() => cb({ ok: true }), 1); }, connect() {}, disconnect() {} };
  const voice = new VM.Voice({
    socket, getIceServers: () => [], myId: () => bob.id,
    signSdp: (to, d) => b.sec.signSdp(voice.channelId, to, d), // app.js
    verifySdp: verify || ((from, d, sig) => b.sec.checkSdp(voice.channelId, from, d, sig)), // app.js
    onSecurityWarning: (userId, why) => warnings.push([userId, why]),
  });
  voice.channelId = ROOM; voice.state = 'connected';
  return { ...b, voice, sent, signals: () => sent.filter((x) => x.ev === 'voice:signal'), callWarnings: warnings };
}
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

test('engine: an honest signed offer builds one connection and is answered with a signed answer', async () => {
  const b = bobEngine();
  b.update(rec(alice));
  const n = pcs.length;
  await b.voice.queueSignal({ from: 'SA', userId: alice.id, data: { sdp: REAL, sig: await offerFrom(REAL), pc: 'a1' } });
  assert.equal(pcs.length, n + 1);
  const peer = b.voice.peers.get('SA');
  assert.equal(peer.pc.remoteDescription.sdp, REAL.sdp);
  const answer = b.signals().find((x) => x.p.data.sdp && x.p.data.sdp.type === 'answer');
  assert.ok(answer, 'answered');
  assert.equal(await E.verify(bob.signPublicKey, `hearth-voice|${ROOM}|${bob.id}|${alice.id}|answer|${answer.p.data.sdp.sdp}`, answer.p.data.sig), true, 'signed for Alice in this room');
  assert.deepEqual(b.callWarnings, []);
  b.voice.cleanup();
});

test('engine: a forged handshake creates no RTCPeerConnection, sends nothing and says why', async () => {
  const cases = [
    ['pinned contact served with a null identity key and the server’s signing key', async (b) => { b.update(rec(alice)); b.update(rec(alice, { publicKey: null, signPublicKey: evil.signPublicKey })); return { sdp: EVIL, sig: await offerFrom(EVIL, alice, evil) }; }, 'no-key'],
    ['the same as a deleted account', async (b) => { b.update(rec(alice)); b.update(rec(alice, { publicKey: '', deleted: true, signPublicKey: evil.signPublicKey })); return { sdp: EVIL, sig: await offerFrom(EVIL, alice, evil) }; }, 'no-key'],
    ['pinned contact served with the identity key left out, after a reload', async (b) => { b.update(rec(alice)); delete b.S.users[alice.id]; b.update({ id: alice.id, username: alice.id, signPublicKey: evil.signPublicKey }); return { sdp: EVIL, sig: await offerFrom(EVIL, alice, evil) }; }, 'no-key'],
    ['a deleted account, even with its real keys and signature', async (b) => { b.update(rec(alice)); b.update(rec(alice, { deleted: true })); return { sdp: REAL, sig: await offerFrom(REAL) }; }, 'deleted'],
    ['pinned contact’s signing key swapped', async (b) => { b.update(rec(alice)); b.update(rec(alice, { signPublicKey: evil.signPublicKey })); return { sdp: EVIL, sig: await offerFrom(EVIL, alice, evil) }; }, 'key-changed'],
    ['DTLS fingerprint swapped under a genuine signature', async (b) => { b.update(rec(alice)); return { sdp: EVIL, sig: await offerFrom(REAL) }; }, 'bad-signature'],
    ['signature stripped', async (b) => { b.update(rec(alice)); return { sdp: REAL }; }, 'bad-signature'],
    ['signed with a foreign key', async (b) => { b.update(rec(alice)); return { sdp: EVIL, sig: await offerFrom(EVIL, alice, evil) }; }, 'bad-signature'],
    ['keys that can’t be loaded', async () => { down = true; return { sdp: REAL, sig: await offerFrom(REAL) }; }, 'lookup-failed'],
  ];
  for (const [label, make, why] of cases) {
    const b = bobEngine();
    const data = await make(b);
    const n = pcs.length;
    await quiet(() => b.voice.queueSignal({ from: 'SA', userId: alice.id, data: { ...data, pc: 'a1' } }));
    down = false;
    assert.equal(pcs.length, n, `${label}: no RTCPeerConnection`);
    assert.equal(b.voice.peers.size, 0, label);
    assert.deepEqual(b.signals(), [], `${label}: nothing sent back`);
    assert.deepEqual(b.callWarnings, [[alice.id, why]], label);
    b.voice.cleanup();
  }
});

test('engine: a check that throws refuses the handshake too', async () => {
  const b = bobEngine({ verify: async () => { throw new Error('offline'); } });
  const n = pcs.length;
  await quiet(() => b.voice.queueSignal({ from: 'SA', userId: alice.id, data: { sdp: REAL, sig: 'x', pc: 'a1' } }));
  assert.equal(pcs.length, n);
  assert.deepEqual(b.callWarnings, [[alice.id, 'lookup-failed']]);
  b.voice.cleanup();
});

test('engine: a forged answer is never applied to our offer; the genuine one is', async () => {
  const b = bobEngine();
  b.update(rec(alice));
  const peer = await b.voice.createPeer('SA', alice.id, true);
  assert.equal(peer.pc.signalingState, 'have-local-offer');
  const ANSWER = desc('AB:AB', 'answer');
  const FORGED = desc('EE:EE', 'answer');
  const forgedSig = await signAs(evil, alice.id, bob.id, FORGED);
  await quiet(() => b.voice.queueSignal({ from: 'SA', userId: alice.id, data: { sdp: FORGED, sig: forgedSig, pc: 'a1', topc: peer.pcId } }));
  assert.equal(peer.pc.remoteDescription, null, 'forged answer not applied');
  assert.deepEqual(b.callWarnings, [[alice.id, 'bad-signature']]);
  await b.voice.queueSignal({ from: 'SA', userId: alice.id, data: { sdp: ANSWER, sig: await signAs(alice, alice.id, bob.id, ANSWER), pc: 'a1', topc: peer.pcId } });
  assert.equal(peer.pc.remoteDescription.sdp, ANSWER.sdp);
  b.voice.cleanup();
});

test('engine: signals that claim to come from this account are refused, and the engine never connects to itself', async () => {
  // Nobody is in a call twice: joining from another device takes the first one out (server/index.js voice:join).
  const b = bobEngine({ verify: async () => true }); // even a check that would pass everything
  const n = pcs.length;
  await quiet(() => b.voice.queueSignal({ from: 'SX', userId: bob.id, data: { sdp: REAL, sig: 'x', pc: 'x1' } }));
  await quiet(() => b.voice.queueSignal({ from: 'SX', userId: bob.id, data: { candidate: { candidate: 'c' }, pc: 'x1' } }));
  assert.equal(pcs.length, n);
  assert.equal(b.voice.peers.size, 0);
  assert.equal(b.voice.early.size, 0, 'not even a candidate is kept for it');
  assert.deepEqual(b.callWarnings, [[bob.id, 'self']]);
  await assert.rejects(b.voice.createPeer('SX', bob.id, true), 'a server that lists us among the others gets no connection to ourselves');
  assert.equal(pcs.length, n);
  b.voice.cleanup();
});

test('engine: connections the server doesn’t list are closed after 20 s even when its list is empty', async () => {
  // The close used to apply only while the list had someone in it, so an empty list kept every connection for good.
  const b = bobEngine({ verify: async () => true });
  b.voice.setListed([bob.id, alice.id]);
  await b.voice.queueSignal({ from: 'SA', userId: alice.id, data: { sdp: REAL, sig: 'x', pc: 'a1' } }); // listed
  await b.voice.queueSignal({ from: 'SH', userId: 'hidden', data: { sdp: REAL, sig: 'x', pc: 'h1' } }); // never listed
  const listedPeer = b.voice.peerByUser(alice.id);
  const hidden = b.voice.peerByUser('hidden');
  b.voice.setListed([]);
  // The warning keeps its timing: a never-listed connection is flagged after 3 s, not at once.
  assert.deepEqual(b.voice.unlistedPeers().filter((p) => p.neverListed), []);
  hidden.createdAt -= 3001; hidden.unlistedSince -= 3001;
  assert.deepEqual(b.voice.unlistedPeers().filter((p) => p.neverListed).map((p) => p.userId), ['hidden']);
  b.voice.tick();
  assert.ok(!hidden.closed && !listedPeer.closed, 'kept within the 20 s');
  listedPeer.unlistedSince -= VM.UNLISTED_GRACE + 1;
  hidden.unlistedSince -= VM.UNLISTED_GRACE + 1;
  b.voice.tick();
  assert.ok(hidden.closed, 'the never-listed one is closed');
  assert.ok(listedPeer.closed, 'and so is the one the server stopped listing');
  b.voice.cleanup();
});
