// End-to-end encryption key lifecycle, with the app's real client code (public/js/e2ee.js, secure.js, api.js)
// running in Node against a real server. A "device" is the app's start-up path (app.js loadBootstrap) with its
// own pin store (localStorage). Each test proves an attack or a loss is refused, and that normal use still works.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./helpers');

// Browser bits the client code needs. Pins live in localStorage, so each device gets its own store.
let store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { crypto: globalThis.crypto, hashwasm: require('hash-wasm') };

let srv; let E; let API; let createSecure;
let curIp = '198.51.100.9';
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;

before(async () => {
  srv = await H.startServer();
  // The app calls fetch('/api/...'): send those to the test server, from the current device's address.
  globalThis.fetch = (url, opts = {}) => (String(url).startsWith('/')
    ? realFetch(srv.base + url, { ...opts, headers: { ...(opts.headers || {}), 'x-forwarded-for': curIp } })
    : realFetch(url, opts));
  E = await import(js('e2ee.js'));
  API = await import(js('api.js'));
  ({ createSecure } = await import(js('secure.js')));
});
after(async () => { globalThis.fetch = realFetch; await srv.stop(); });

const as = (u, m, p, body) => srv.api(m, p, { token: u.token, ip: u.ip, body });
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 50) { if (await fn()) return true; await sleep(50); } return false; };

// Uploads a signing key the way the app does: with proof of the identity key and of the new signing key.
async function uploadSignKey(p, sk) {
  const ch = (await as(p, 'POST', '/me/sign-key/challenge')).json;
  const keyProof = await E.signKeyProof(p.privateKey, ch.serverPublicKey, ch.nonce, p.id, sk.signPublicKey);
  const signature = await E.sign(sk.signKey, `hearth-sign-key|${p.id}|${p.publicKey}|${ch.nonce}`);
  return as(p, 'POST', '/me/sign-key', { signPublicKey: sk.signPublicKey, encSignPrivateKey: sk.encSignPrivateKey, nonce: ch.nonce, keyProof, signature });
}
// A person registered the way the app does it (real password hashing and keys).
async function person(name, { signKey = true } = {}) {
  const kdfSalt = E.newKdfSalt();
  const { authKey, wrapKey } = await E.deriveKeys(name, `pw-${name}`, { kdf: 'argon2id', salt: kdfSalt });
  const id = await E.createIdentity(wrapKey);
  const ip = H.newIp();
  const r = await srv.api('POST', '/auth/register', { ip, body: { username: name, authKey, kdfSalt, publicKey: id.publicKey, encPrivateKey: id.encPrivateKey, acceptTos: srv.config.termsVersion || undefined } });
  assert.equal(r.status, 200, r.text);
  const p = { username: name, ip, authKey, wrapKey, kdfSalt, token: r.json.token, id: r.json.user.id, ...id };
  if (signKey) {
    const sk = await E.createSigningKey(id.privateKey, id.publicKey);
    Object.assign(p, sk);
    const s = await uploadSignKey(p, sk);
    assert.equal(s.status, 200, s.text);
  }
  return p;
}
const uname = (base) => `${base}${H.hex(3)}`;
async function serverWith(owner, others) {
  const s = (await as(owner, 'POST', '/servers', { name: 'keys' })).json;
  const code = (await as(owner, 'POST', `/servers/${s.id}/invites`, {})).json.code;
  for (const u of others) assert.equal((await as(u, 'POST', `/invites/${code}/join`, {})).status, 200);
  return { s, code, ch: s.channels.find((c) => c.type === 'text').id };
}
async function wrapAll(by, serverId, epoch, raw, members) {
  const wraps = {}; const pubs = {};
  for (const u of members) {
    wraps[u.id] = await E.wrapGroupKey({ raw, serverId, epoch, recipientId: u.id, recipientPub: u.publicKey, wrapperId: by.id, signKey: by.signKey });
    pubs[u.id] = u.publicKey;
  }
  return { wraps, pubs };
}
// One person's app replacing the server key (real key, wrapped to everyone).
async function rotate(by, serverId, epoch, members, { check } = {}) {
  const raw = E.newGroupKey();
  const { wraps, pubs } = await wrapAll(by, serverId, epoch, raw, members);
  const r = await as(by, 'POST', `/servers/${serverId}/keys/rotate`, { epoch, check: check || await E.keyCheck(raw, serverId, epoch), wraps, pubs });
  return { r, raw };
}
async function send(u, sid, ch, epoch, raw, t) {
  const ciphertext = await E.encryptGroup({ raw, serverId: sid, channelId: ch, epoch, authorId: u.id, signKey: u.signKey, payload: { t } });
  const r = await as(u, 'POST', `/channels/${ch}/messages`, { ciphertext, epoch });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
}
// The app's start-up on one device (app.js loadBootstrap), with that device's pins.
async function device(user, pins = new Map()) {
  store = pins; curIp = user.ip; API.setToken(user.token);
  const boot = (await as(user, 'GET', '/bootstrap')).json;
  const S = { me: boot.me, users: boot.users, servers: boot.servers, dms: boot.dms, privateKey: user.privateKey, e2eeSince: boot.e2eeSince };
  const sec = createSecure({ S });
  await sec.ensureSigningKey(boot.encSignPrivateKey);
  Object.values(S.users).forEach((u) => sec.trust(u));
  for (const st of Object.values(boot.keyStates || {})) await sec.applyState(st);
  for (const s of S.servers) await sec.keysSaved(s.id);
  return { sec, S, pins, boot };
}
const rowsOf = (sid, uid) => srv.sql('SELECT epoch, wrapper_id FROM server_keys WHERE server_id = ? AND user_id = ? ORDER BY epoch', sid, uid);
const channelMsgs = async (u, ch) => (await as(u, 'GET', `/channels/${ch}/messages`)).json.messages;
async function resetWithoutRecovery(user) {
  await H.confirmEmail(srv, user, `${user.username}@example.test`);
  await srv.api('POST', '/auth/forgot', { ip: H.newIp(), body: { login: user.username } });
  const tok = H.resetTokenFrom(srv.mails().filter((m) => m.to === `${user.username}@example.test` && /reset your password/.test(m.subject)).pop());
  const kdfSalt = E.newKdfSalt();
  const k = await E.deriveKeys(user.username, 'new-pw', { kdf: 'argon2id', salt: kdfSalt });
  const ident = await E.createIdentity(k.wrapKey);
  const ip = H.newIp();
  const rr = await srv.api('POST', '/auth/reset', { ip, body: { token: tok, authKey: k.authKey, kdfSalt, encPrivateKey: ident.encPrivateKey, publicKey: ident.publicKey } });
  assert.equal(rr.status, 200, rr.text);
  const nu = { ...user, ip, token: rr.json.token, authKey: k.authKey, ...ident };
  const sk = await E.createSigningKey(ident.privateKey, ident.publicKey);
  Object.assign(nu, sk);
  assert.equal((await uploadSignKey(nu, sk)).status, 200);
  return nu;
}

// ------------------------------------------------------------------ crypto-1 / crypto-4: deleting an account
test('a member who handed out keys deletes their account: everyone keeps their history and DMs', async () => {
  const A = await person(uname('alice')); const V = await person(uname('victor')); const B = await person(uname('bob'));
  const { s, ch } = await serverWith(A, [V, B]);
  const { r, raw } = await rotate(V, s.id, 1, [A, V, B]); // Victor's app made epoch 1
  assert.equal(r.status, 200, r.text);
  await send(A, s.id, ch, 1, raw, 'alice in epoch 1');
  await send(V, s.id, ch, 1, raw, 'victor in epoch 1');
  const dm = (await as(A, 'POST', '/dms', { userId: V.id })).json;
  for (const [me, other, t] of [[A, V, 'from alice'], [V, A, 'from victor']]) {
    const ciphertext = await E.encryptDm({ myPriv: me.privateKey, theirPub: other.publicKey, dmId: dm.id, authorId: me.id, payload: { t } });
    assert.equal((await as(me, 'POST', `/dms/${dm.id}/messages`, { ciphertext })).status, 200);
  }
  const before = (await as(A, 'GET', `/users/${V.id}`)).json;
  const alicePins = new Map();
  await device(A, alicePins); // Alice has seen Victor before

  assert.equal((await as(V, 'DELETE', '/me', { authKey: V.authKey, confirm: V.username })).status, 200);
  // Public keys stay (they're public); the private ones are gone.
  const after = (await as(A, 'GET', `/users/${V.id}`)).json;
  assert.equal(after.deleted, true);
  assert.equal(after.publicKey, before.publicKey);
  assert.equal(after.signPublicKey, before.signPublicKey);
  const row = srv.sql('SELECT enc_private_key, enc_sign_private_key, enc_private_key_recovery FROM users WHERE id = ?', V.id)[0];
  assert.deepEqual([row.enc_private_key, row.enc_sign_private_key, row.enc_private_key_recovery], ['', null, null]);

  // Bob signs in for the first time after the deletion: the key Victor handed him still opens.
  assert.deepEqual(rowsOf(s.id, B.id).map((x) => [x.epoch, x.wrapper_id]), [[1, V.id]]);
  const d = await device(B, new Map());
  assert.ok(d.sec.heldEpochs(s.id).includes(1));
  const msgs = await channelMsgs(B, ch);
  for (const m of msgs) await d.sec.decryptChannelMessage(m);
  assert.deepEqual(msgs.map((m) => m.dec.t).sort(), ['alice in epoch 1', 'victor in epoch 1']);
  assert.ok(msgs.every((m) => m.dec.verified === true), 'the deleted member’s posts still verify');
  // ...and his app kept its own copy, so his history no longer depends on Victor's keys at all.
  assert.equal(rowsOf(s.id, B.id).find((x) => x.epoch === 1).wrapper_id, B.id);

  // Alice reloads: both sides of the DM still open; nobody can send new ones to the deleted account.
  const a = await device(A, alicePins);
  const dms = (await as(A, 'GET', `/dms/${dm.id}/messages`)).json.messages;
  for (const m of dms) await a.sec.decryptDmMessage(m);
  assert.deepEqual(dms.map((m) => m.dec.t).sort(), ['from alice', 'from victor']);
  const ciphertext = await E.encryptDm({ myPriv: A.privateKey, theirPub: V.publicKey, dmId: dm.id, authorId: A.id, payload: { t: 'hello?' } });
  const sendNew = await as(A, 'POST', `/dms/${dm.id}/messages`, { ciphertext });
  assert.equal(sendNew.status, 403);
  assert.equal(sendNew.json.code, 'deleted');
});

test('accounts deleted before this fix (keys blanked): devices fall back to the keys they pinned', async () => {
  const A = await person(uname('alice')); const V = await person(uname('vic'));
  const { s, ch } = await serverWith(A, [V]);
  const { raw } = await rotate(A, s.id, 1, [A, V]);
  await send(V, s.id, ch, 1, raw, 'old post');
  const dm = (await as(A, 'POST', '/dms', { userId: V.id })).json;
  const ciphertext = await E.encryptDm({ myPriv: V.privateKey, theirPub: A.publicKey, dmId: dm.id, authorId: V.id, payload: { t: 'old dm' } });
  assert.equal((await as(V, 'POST', `/dms/${dm.id}/messages`, { ciphertext })).status, 200);
  const pins = new Map();
  await device(A, pins);
  assert.equal((await as(V, 'DELETE', '/me', { authKey: V.authKey, confirm: V.username })).status, 200);
  srv.sql("UPDATE users SET public_key = '', sign_public_key = NULL WHERE id = ?", V.id); // what deletion used to do
  const d = await device(A, pins);
  const m = (await channelMsgs(A, ch)).find((x) => x.authorId === V.id);
  await d.sec.decryptChannelMessage(m);
  assert.equal(m.dec.t, 'old post');
  assert.equal(m.dec.verified, true, 'checked against the signing key this device pinned');
  const dmMsg = (await as(A, 'GET', `/dms/${dm.id}/messages`)).json.messages[0];
  await d.sec.decryptDmMessage(dmMsg);
  assert.equal(dmMsg.dec.t, 'old dm');
});

// ------------------------------------------------------------------ crypto-1: a reset without a recovery key
test('the sharer resets without a recovery key: old keys still open, and old rows are never deleted', async () => {
  const A = await person(uname('alice')); let V = await person(uname('victor')); const B = await person(uname('bob'));
  const { s, ch } = await serverWith(A, [V, B]);
  const { raw: raw1 } = await rotate(V, s.id, 1, [A, V, B]);
  await send(A, s.id, ch, 1, raw1, 'alice epoch 1');
  await send(V, s.id, ch, 1, raw1, 'victor before his reset');
  const old = (await as(B, 'GET', `/users/${V.id}`)).json;
  // A device of Bob's that had pinned Victor's old keys (and never opened the server since).
  const oldPins = new Map(); store = oldPins; E.checkPin(B.id, old);
  // Alice (who manages the server) replaces the key; then Victor resets with brand-new keys.
  const r2 = await rotate(A, s.id, 2, [A, V, B]);
  assert.equal(r2.r.status, 200, r2.r.text);
  const V0 = V;
  V = await resetWithoutRecovery(V);
  const now = (await as(B, 'GET', `/users/${V.id}`)).json;
  assert.notEqual(now.signPublicKey, old.signPublicKey);
  assert.deepEqual(now.pastKeys.map((k) => [k.publicKey, k.signPublicKey]), [[old.publicKey, old.signPublicKey]], 'the old public keys are on record');
  assert.deepEqual(rowsOf(s.id, B.id).map((x) => x.epoch), [1, 2]);

  // An old epoch can't be dropped any more (only the current one can be shared again).
  assert.equal((await as(B, 'POST', `/servers/${s.id}/keys/bad`, { epoch: 1 })).json.removed, 0);
  assert.deepEqual(rowsOf(s.id, B.id).map((x) => x.epoch), [1, 2]);

  // Bob's old device: Victor's key "changed" (not verified yet), but the handoff was signed by the key it pinned.
  const victorsWrap = srv.sql('SELECT wrapped FROM server_keys WHERE server_id = ? AND user_id = ? AND epoch = 1', s.id, B.id)[0].wrapped;
  const od = await device(B, oldPins);
  assert.equal(od.sec.keyChanged(od.S.users[V.id]), true);
  assert.deepEqual(od.sec.heldEpochs(s.id).sort(), [1, 2]);
  const ep1 = (await channelMsgs(B, ch)).filter((x) => x.epoch === 1);
  for (const m of ep1) await od.sec.decryptChannelMessage(m);
  assert.deepEqual(ep1.map((m) => [m.dec.t, m.dec.verified]).sort(), [['alice epoch 1', true], ['victor before his reset', true]]);
  // After "Numbers match" the old key stays trusted for what it signed back then (dated before the reset)...
  od.sec.acceptKeys(od.S.users[V.id]);
  const oldPost = ep1.find((m) => m.dec.t === 'victor before his reset');
  assert.deepEqual(od.sec.signKeysFor(od.S.users[V.id], { at: oldPost.createdAt }), [now.signPublicKey, old.signPublicKey]);
  assert.deepEqual(od.sec.signKeysFor(od.S.users[V.id]), [now.signPublicKey], 'an old key never vouches for something undated');
  // ...but not for anything newer (say it leaked): a post signed with it today isn't shown as Victor's.
  await sleep(5);
  const late = await send({ ...V, signKey: V0.signKey }, s.id, ch, 2, r2.raw, 'signed with the old key, today');
  const lm = (await channelMsgs(B, ch)).find((x) => x.id === late);
  await od.sec.decryptChannelMessage(lm);
  assert.equal(lm.dec.t, 'signed with the old key, today');
  assert.equal(lm.dec.verified, false);
  // Nor can it hand out the key everyone encrypts with from now on.
  const evil = E.newGroupKey(); const t3 = Date.now();
  srv.sql('INSERT INTO server_epochs (server_id, epoch, key_check, creator_id, created_at) VALUES (?, 3, ?, ?, ?)', s.id, await E.keyCheck(evil, s.id, 3), V.id, t3);
  const w3 = await E.wrapGroupKey({ raw: evil, serverId: s.id, epoch: 3, recipientId: B.id, recipientPub: B.publicKey, wrapperId: V.id, signKey: V0.signKey });
  srv.sql('INSERT INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, 3, ?, ?, ?, ?)', s.id, B.id, w3, V.id, t3);
  srv.sql('UPDATE servers SET key_epoch = 3 WHERE id = ?', s.id);
  await od.sec.refresh(s.id);
  assert.ok(!od.sec.heldEpochs(s.id).includes(3));
  assert.equal(od.sec.currentKey(s.id), null);
  assert.ok(await until(() => !rowsOf(s.id, B.id).some((x) => x.epoch === 3)), 'reported as broken');
  srv.sql('DELETE FROM server_epochs WHERE server_id = ? AND epoch = 3', s.id);
  srv.sql('UPDATE servers SET key_epoch = 2, needs_rotation = 0 WHERE id = ?', s.id);

  // Bob on a brand-new phone (no pins at all), with his row put back as Victor wrapped it (his old device
  // already re-wrapped it to Bob). It can still read epoch 1 with the old key the server lists for Victor, but
  // nothing vouches for that key (this phone never saw it as his, and safety numbers don't cover it): what only
  // it checks out is shown as "older key, not verified", and the key isn't kept as Bob's own copy.
  assert.equal(rowsOf(s.id, B.id)[0].wrapper_id, B.id);
  srv.sql('UPDATE server_keys SET wrapped = ?, wrapper_id = ? WHERE server_id = ? AND user_id = ? AND epoch = 1', victorsWrap, V.id, s.id, B.id);
  const fresh = await device(B, new Map());
  assert.deepEqual(fresh.sec.heldEpochs(s.id).sort(), [1, 2]);
  const all = await channelMsgs(B, ch);
  for (const m of all) await fresh.sec.decryptChannelMessage(m);
  assert.deepEqual(all.map((m) => [m.dec.t, m.dec.verified, m.dec.keyNote || null]).sort(),
    [['alice epoch 1', true, null], ['signed with the old key, today', false, null], ['victor before his reset', false, 'listed']]);
  assert.deepEqual(rowsOf(s.id, B.id).map((x) => [x.epoch, x.wrapper_id]), [[1, V.id], [2, B.id]], 'nothing reported away, nothing kept on a listed key’s word');
  // A key the server adds to someone's history LATER is not trusted by a device that already knows them.
  const fake = await E.createSigningKey(B.privateKey, B.publicKey);
  srv.sql('INSERT INTO user_key_history (user_id, public_key, sign_public_key, retired_at) VALUES (?, ?, ?, ?)', V.id, old.publicKey, fake.signPublicKey, Date.now());
  const again = await device(B, fresh.pins);
  assert.ok(!again.sec.signKeysFor(again.S.users[V.id]).includes(fake.signPublicKey));
});

test('after a reset without a recovery key, the other person still reads your old DMs', async () => {
  const A = await person(uname('alice')); let V = await person(uname('vera'));
  await serverWith(A, [V]);
  const dm = (await as(A, 'POST', '/dms', { userId: V.id })).json;
  const ciphertext = await E.encryptDm({ myPriv: A.privateKey, theirPub: V.publicKey, dmId: dm.id, authorId: A.id, payload: { t: 'before the reset' } });
  assert.equal((await as(A, 'POST', `/dms/${dm.id}/messages`, { ciphertext })).status, 200);
  const pins = new Map();
  await device(A, pins); // a device of Alice's that knew Vera before
  V = await resetWithoutRecovery(V);
  // A new device of Alice's: opens it with the old key the server lists for Vera, flagged as not verified.
  const d = await device(A, new Map());
  const m = (await as(A, 'GET', `/dms/${dm.id}/messages`)).json.messages[0];
  await d.sec.decryptDmMessage(m);
  assert.equal(m.dec.t, 'before the reset');
  assert.equal(m.dec.keyNote, 'listed');
  // The device that knew her: her old key is the one it pinned. Before and after "Numbers match" it opens with
  // that (an older key of hers, trusted back then), not on the server's word.
  const k = await device(A, pins);
  for (const accept of [false, true]) {
    if (accept) k.sec.acceptKeys(k.S.users[V.id]);
    const again = (await as(A, 'GET', `/dms/${dm.id}/messages`)).json.messages[0];
    await k.sec.decryptDmMessage(again);
    assert.equal(again.dec.t, 'before the reset');
    assert.equal(again.dec.keyNote, 'pinned');
  }
});

// ------------------------------------------------------------------ crypto-3: rotation abuse
test('junk key bundles are refused; a plain member can’t keep replacing the key; needed rotations still work', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); const M = await person(uname('mallory'));
  const { s } = await serverWith(A, [B, M]);
  assert.equal((await rotate(A, s.id, 1, [A, B, M])).r.status, 200);
  const junk = Object.fromEntries([A, B, M].map((u) => [u.id, 'A'.repeat(1999)]));
  let r = await as(M, 'POST', `/servers/${s.id}/keys/rotate`, { epoch: 2, check: 'A'.repeat(24), wraps: junk });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'bad_wraps');
  const real = await wrapAll(M, s.id, 2, E.newGroupKey(), [A, B, M]);
  const bloated = { ...real.wraps, [A.id]: real.wraps[A.id] + 'A'.repeat(400) };
  assert.equal((await as(M, 'POST', `/servers/${s.id}/keys/rotate`, { epoch: 2, check: 'A'.repeat(24), wraps: bloated })).status, 400);
  // A well-formed voluntary rotation by a plain member, right after the last one: too soon.
  r = (await rotate(M, s.id, 2, [A, B, M])).r;
  assert.equal(r.status, 429);
  assert.equal(r.json.code, 'rotate_too_soon');
  assert.equal(srv.sql('SELECT key_epoch FROM servers WHERE id = ?', s.id)[0].key_epoch, 1);
  // The owner (Manage Server) can replace it any time.
  assert.equal((await rotate(A, s.id, 2, [A, B, M])).r.status, 200);
  // When someone leaves, any member's app rotates at once.
  assert.equal((await as(B, 'POST', `/servers/${s.id}/leave`)).status, 200);
  assert.equal((await rotate(M, s.id, 3, [A, M])).r.status, 200);
  // Once the key is 10 minutes old, a plain member may replace it too; the key's maker is shown to members.
  srv.sql('UPDATE server_epochs SET created_at = created_at - 11 * 60000 WHERE server_id = ?', s.id);
  assert.equal((await rotate(M, s.id, 4, [A, M])).r.status, 200);
  const ks = (await as(A, 'GET', `/servers/${s.id}/keys`)).json;
  assert.equal(ks.keyCreatorId, M.id);
  assert.ok(ks.keys.every((k) => k.wrapped.length < 600));
});

test('a member who rotates to a key nobody else can open doesn’t lock the server: the apps replace it', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); const M = await person(uname('mallory'));
  const { s, ch } = await serverWith(A, [B, M]);
  assert.equal((await rotate(A, s.id, 1, [A, B, M])).r.status, 200);
  srv.sql('UPDATE server_epochs SET created_at = created_at - 11 * 60000 WHERE server_id = ?', s.id);
  // Mallory's key: wrapped properly, but its check value is wrong, so nobody's app accepts it.
  const bad = await rotate(M, s.id, 2, [A, B, M], { check: 'B'.repeat(24) });
  assert.equal(bad.r.status, 200, bad.r.text);
  const d = await device(A, new Map());
  // Alice's app reported the broken key, and the server asks for a new one...
  assert.ok(await until(async () => srv.sql('SELECT needs_rotation FROM servers WHERE id = ?', s.id)[0].needs_rotation === 1));
  assert.equal(srv.sql('SELECT COUNT(*) n FROM server_keys WHERE server_id = ? AND epoch = 2 AND user_id = ?', s.id, A.id)[0].n, 0);
  // ...which the apps hear about (keys:state; here the app asks), and Alice's app makes epoch 3.
  await d.sec.refresh(s.id);
  assert.ok(await until(async () => srv.sql('SELECT key_epoch FROM servers WHERE id = ?', s.id)[0].key_epoch === 3), 'a fresh key replaced the broken one');
  const st = srv.sql('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?', s.id)[0];
  assert.deepEqual([st.key_epoch, st.needs_rotation], [3, 0]);
  assert.equal(srv.sql('SELECT creator_id FROM server_epochs WHERE server_id = ? AND epoch = 3', s.id)[0].creator_id, A.id);
  await d.sec.refresh(s.id);
  const ck = await d.sec.ready(s.id);
  assert.equal(ck.epoch, 3);
  await send(A, s.id, ch, 3, ck.raw, 'still talking');
  // An old epoch reported bad is never dropped or treated as broken.
  assert.equal((await as(B, 'POST', `/servers/${s.id}/keys/bad`, { epoch: 1 })).json.removed, 0);
});

// ------------------------------------------------------------------ crypto-11: planting a signing key
test('a signing key can only be uploaded with proof of the identity key and the signing key', async () => {
  const V = await person(uname('legacy'), { signKey: false }); // an older account without a signing key yet
  const evil = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const evilPub = E.b64(await crypto.subtle.exportKey('spki', evil.publicKey));
  // With only the session: no proof at all.
  let r = await as(V, 'POST', '/me/sign-key', { signPublicKey: evilPub, encSignPrivateKey: 'AAAAAAAA:BBBBBBBB' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'need_proof');
  // A proof made with some other identity key (the attacker doesn't have the victim's).
  const other = await E.createIdentity((await E.deriveKeys('o', 'p', { kdf: 'argon2id', salt: E.newKdfSalt() })).wrapKey);
  let ch = (await as(V, 'POST', '/me/sign-key/challenge')).json;
  let keyProof = await E.signKeyProof(other.privateKey, ch.serverPublicKey, ch.nonce, V.id, evilPub);
  let signature = await E.sign(evil.privateKey, `hearth-sign-key|${V.id}|${V.publicKey}|${ch.nonce}`);
  r = await as(V, 'POST', '/me/sign-key', { signPublicKey: evilPub, encSignPrivateKey: 'AAAAAAAA:BBBBBBBB', nonce: ch.nonce, keyProof, signature });
  assert.equal(r.status, 403);
  // The real identity proof, but for a signing key the uploader doesn't hold (signature by another key).
  const sk = await E.createSigningKey(V.privateKey, V.publicKey);
  ch = (await as(V, 'POST', '/me/sign-key/challenge')).json;
  keyProof = await E.signKeyProof(V.privateKey, ch.serverPublicKey, ch.nonce, V.id, sk.signPublicKey);
  signature = await E.sign(evil.privateKey, `hearth-sign-key|${V.id}|${V.publicKey}|${ch.nonce}`);
  r = await as(V, 'POST', '/me/sign-key', { signPublicKey: sk.signPublicKey, encSignPrivateKey: sk.encSignPrivateKey, nonce: ch.nonce, keyProof, signature });
  assert.equal(r.status, 403);
  assert.equal(srv.sql('SELECT sign_public_key FROM users WHERE id = ?', V.id)[0].sign_public_key, null);
  // The app's own start-up does it properly; a challenge works only once.
  const d = await device(V, new Map());
  assert.ok(d.S.me.signPublicKey);
  assert.equal(srv.sql('SELECT sign_public_key FROM users WHERE id = ?', V.id)[0].sign_public_key, d.S.me.signPublicKey);
  ch = (await as(V, 'POST', '/me/sign-key/challenge')).json;
  srv.sql('UPDATE users SET sign_public_key = NULL WHERE id = ?', V.id);
  keyProof = await E.signKeyProof(V.privateKey, ch.serverPublicKey, ch.nonce, V.id, sk.signPublicKey);
  signature = await E.sign(sk.signKey, `hearth-sign-key|${V.id}|${V.publicKey}|${ch.nonce}`);
  const body = { signPublicKey: sk.signPublicKey, encSignPrivateKey: sk.encSignPrivateKey, nonce: ch.nonce, keyProof, signature };
  assert.equal((await as(V, 'POST', '/me/sign-key', body)).status, 200);
  srv.sql('UPDATE users SET sign_public_key = NULL WHERE id = ?', V.id);
  assert.equal((await as(V, 'POST', '/me/sign-key', body)).status, 403, 'replayed challenge');
});

// ------------------------------------------------------------------ auth-5 / crypto-8: the password-locked key
test('a session alone no longer gets the password-locked private key; the password does', async () => {
  const A = await person(uname('alice'));
  const boot = await as(A, 'GET', '/bootstrap');
  assert.equal(boot.status, 200);
  assert.ok(!('encPrivateKey' in boot.json), 'not in /bootstrap');
  assert.ok(!boot.text.includes(A.encPrivateKey));
  assert.equal((await as(A, 'POST', '/me/keys/wrapped', {})).status, 401);
  assert.equal((await as(A, 'POST', '/me/keys/wrapped', { authKey: H.hex(32) })).status, 401);
  const ok = await as(A, 'POST', '/me/keys/wrapped', { authKey: A.authKey });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.encPrivateKey, A.encPrivateKey);
  assert.ok(await E.unwrapPrivateKey(A.wrapKey, ok.json.encPrivateKey), 'and it opens with the password, as before');
  // Guessing is rate limited like any password check.
  let last;
  for (let i = 0; i < 25; i++) last = await as(A, 'POST', '/me/keys/wrapped', { authKey: H.hex(32) });
  assert.equal(last.status, 429);
});

// ------------------------------------------------------------------ crypto-5: keys from outside, rollbacks
test('the app never uses a current key handed out by a non-member, nor goes back to an older key', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); const X = await person(uname('ghost'));
  const { s } = await serverWith(A, [B]);
  assert.equal((await rotate(A, s.id, 1, [A, B])).r.status, 200);
  // Someone with write access to the database: epoch 2 = their key, wrapped and signed by a non-member.
  const evil = E.newGroupKey();
  const t = Date.now();
  srv.sql('INSERT INTO server_epochs (server_id, epoch, key_check, creator_id, created_at) VALUES (?, 2, ?, ?, ?)', s.id, await E.keyCheck(evil, s.id, 2), X.id, t);
  for (const u of [A, B]) {
    const w = await E.wrapGroupKey({ raw: evil, serverId: s.id, epoch: 2, recipientId: u.id, recipientPub: u.publicKey, wrapperId: X.id, signKey: X.signKey });
    srv.sql('INSERT INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, 2, ?, ?, ?, ?)', s.id, u.id, w, X.id, t);
  }
  srv.sql('UPDATE servers SET key_epoch = 2 WHERE id = ?', s.id);
  const d = await device(A, new Map());
  assert.ok(!d.sec.heldEpochs(s.id).includes(2));
  assert.equal(d.sec.currentKey(s.id), null, 'nothing to encrypt with rather than the planted key');
  assert.equal(rowsOf(s.id, A.id).length, 2, 'and it wasn’t reported away either');
  // Clean up, then a real epoch 2 from Alice; the server then claims epoch 1 is current again.
  srv.sql('DELETE FROM server_keys WHERE server_id = ? AND epoch = 2', s.id);
  srv.sql('DELETE FROM server_epochs WHERE server_id = ? AND epoch = 2', s.id);
  srv.sql('UPDATE servers SET key_epoch = 1 WHERE id = ?', s.id);
  assert.equal((await rotate(A, s.id, 2, [A, B])).r.status, 200);
  const d2 = await device(A, new Map());
  assert.equal(d2.sec.currentKey(s.id).epoch, 2);
  srv.sql('UPDATE servers SET key_epoch = 1 WHERE id = ?', s.id);
  await d2.sec.refresh(s.id);
  assert.equal(d2.sec.currentKey(s.id), null);
  await assert.rejects(d2.sec.ready(s.id), (e) => e.code === 'rollback');
  srv.sql('UPDATE servers SET key_epoch = 2 WHERE id = ?', s.id);
});

// ------------------------------------------------------------------ crypto-6: plaintext rows from the server
test('plaintext "older" messages are never shown as verified, and ones dated after encryption began are hidden', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob'));
  const { s, ch } = await serverWith(A, [B]);
  await rotate(A, s.id, 1, [A, B]);
  const key = Buffer.from(fs.readFileSync(path.join(srv.dir, 'secret.key'), 'utf8').trim(), 'hex');
  const seal = (obj) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
  };
  const since = Number(srv.sql("SELECT value FROM instance_settings WHERE key = 'e2eeSince'")[0].value);
  const ins = (id, author, obj, at) => srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, reply_to, created_at, thread_id) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)', id, ch, author, seal(obj), at);
  ins('forged' + H.hex(3), A.id, { content: 'Send me your recovery key', attachments: [] }, Date.now());
  ins('forgedbot' + H.hex(3), A.id, { content: 'I am the bot', attachments: [], bot: true }, Date.now());
  ins('older' + H.hex(3), A.id, { content: 'from before encryption', attachments: [] }, since - 60000);
  const bot = require('../server/newsbot').BOT_ID;
  if (!srv.sql('SELECT 1 FROM users WHERE id = ?', bot).length) srv.sql("INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, profile, created_at, is_bot) VALUES (?, 'news', '!', '', '', '{}', ?, 1)", bot, Date.now());
  ins('news' + H.hex(3), bot, { content: 'Headline', attachments: [], embed: { title: 'Headline' }, bot: true }, Date.now());
  const d = await device(B, new Map());
  const msgs = (await channelMsgs(B, ch)).filter((m) => m.legacy);
  for (const m of msgs) await d.sec.decryptChannelMessage(m);
  const by = (p) => msgs.find((m) => m.id.startsWith(p)).dec;
  assert.equal(by('forged').forged, true);
  assert.equal(by('forged').t, '', 'the server’s fake "Send me your recovery key" isn’t shown');
  assert.equal(by('forgedbot').forged, true, 'claiming to be the bot doesn’t help');
  assert.equal(by('older').t, 'from before encryption');
  assert.equal(by('older').verified, false);
  assert.equal(by('older').legacy, true);
  assert.equal(by('news').t, 'Headline');
  assert.equal(by('news').bot, true);
});

// ------------------------------------------------------------------ crypto-13: rejoining after a kick
test('a kicked member who rejoins with an old invite gets a new key, not what was said while they were away', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); const M = await person(uname('mike'));
  const { s, code, ch } = await serverWith(A, [B, M]);
  await rotate(A, s.id, 1, [A, B, M]);
  assert.equal((await as(A, 'DELETE', `/servers/${s.id}/members/${M.id}`)).status, 200);
  const { raw: raw2 } = await rotate(A, s.id, 2, [A, B]);
  await send(A, s.id, ch, 2, raw2, 'mods: about mike');
  assert.equal((await as(M, 'POST', `/invites/${code}/join`, {})).status, 200);
  const st = srv.sql('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?', s.id)[0];
  assert.deepEqual([st.key_epoch, st.needs_rotation], [2, 1], 'coming back asks for a new key');
  // Nobody can hand Mike the key from while he was away (even an app that hasn't noticed yet).
  const w = await E.wrapGroupKey({ raw: raw2, serverId: s.id, epoch: 2, recipientId: M.id, recipientPub: M.publicKey, wrapperId: A.id, signKey: A.signKey });
  assert.equal((await as(A, 'POST', `/servers/${s.id}/keys/share`, { epoch: 2, wraps: { [M.id]: w } })).status, 409);
  await device(A, new Map()); // Alice's app makes the new key, for everyone including Mike
  assert.ok(await until(async () => srv.sql('SELECT key_epoch FROM servers WHERE id = ?', s.id)[0].key_epoch === 3));
  const d = await device(M, new Map());
  assert.ok(d.sec.heldEpochs(s.id).includes(3));
  assert.ok(!d.sec.heldEpochs(s.id).includes(2));
  const m = (await channelMsgs(M, ch)).find((x) => x.epoch === 2);
  await d.sec.decryptChannelMessage(m);
  assert.equal(m.dec.t, '');
  assert.equal(m.dec.pending, true);
  // Someone joining for the first time still gets the current key, as before.
  const N = await person(uname('newbie'));
  assert.equal((await as(N, 'POST', `/invites/${code}/join`, {})).status, 200);
  assert.equal(srv.sql('SELECT needs_rotation FROM servers WHERE id = ?', s.id)[0].needs_rotation, 0);
});

// ------------------------------------------------------------------ the self copy endpoint
test('keys/self only ever touches your own rows, with well-formed keys', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); const O = await person(uname('outsider'));
  const { s } = await serverWith(A, [B]);
  const { raw } = await rotate(A, s.id, 1, [A, B]);
  const mine = await E.wrapGroupKey({ raw, serverId: s.id, epoch: 1, recipientId: B.id, recipientPub: B.publicKey, wrapperId: B.id, signKey: B.signKey });
  assert.equal((await as(O, 'POST', `/servers/${s.id}/keys/self`, { wraps: { 1: mine } })).status, 404, 'not a member');
  assert.equal((await as(B, 'POST', `/servers/${s.id}/keys/self`, { wraps: { 1: 'x'.repeat(300), 2: mine } })).json.updated, 0, 'junk, or a key you don’t have');
  const before = rowsOf(s.id, A.id);
  assert.equal((await as(B, 'POST', `/servers/${s.id}/keys/self`, { wraps: { 1: mine } })).json.updated, 1);
  assert.deepEqual(rowsOf(s.id, B.id).map((x) => [x.epoch, x.wrapper_id]), [[1, B.id]]);
  assert.deepEqual(rowsOf(s.id, A.id), before, 'Alice’s row untouched');
  const d = await device(B, new Map());
  assert.deepEqual(d.sec.heldEpochs(s.id), [1]);
});

test('an app told the wrong public key for itself never wraps its keys to it', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); const O = await person(uname('other'));
  const { s } = await serverWith(A, [B]);
  await rotate(A, s.id, 1, [A, B]);
  store = new Map(); curIp = B.ip; API.setToken(B.token);
  const boot = (await as(B, 'GET', '/bootstrap')).json;
  // A server up to something says Bob's public key is one it controls.
  const S = { me: { ...boot.me, publicKey: O.publicKey }, users: boot.users, servers: boot.servers, dms: boot.dms, privateKey: B.privateKey, signKey: B.signKey };
  const sec = createSecure({ S });
  for (const st of Object.values(boot.keyStates)) await sec.applyState(st);
  await sec.keysSaved(s.id);
  assert.deepEqual(sec.heldEpochs(s.id), [1]);
  assert.equal(rowsOf(s.id, B.id)[0].wrapper_id, A.id, 'no copy was wrapped to the wrong key');
  // With the right key, the copy is made.
  const d = await device(B, new Map());
  assert.deepEqual(d.sec.heldEpochs(s.id), [1]);
  assert.equal(rowsOf(s.id, B.id)[0].wrapper_id, B.id);
});

// ------------------------------------------------------------------ second review round
// A key pair the "server" controls (identity + signing), without a password.
async function serverKeys() {
  const wk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const id = await E.createIdentity(wk);
  return { ...id, ...(await E.createSigningKey(id.privateKey, id.publicKey)) };
}
const plantDm = (dmId, authorId, ciphertext, at) => {
  const id = 'zz' + H.hex(6);
  srv.sql('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, reply_to, created_at) VALUES (?, ?, ?, ?, NULL, ?)', id, dmId, authorId, ciphertext, at);
  return id;
};
const plantPost = (ch, authorId, ciphertext, epoch, at) => {
  const id = 'zz' + H.hex(6);
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, reply_to, created_at, thread_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)', id, ch, authorId, '', ciphertext, epoch, at);
  return id;
};
const dmMsg = async (u, dmId, id) => (await as(u, 'GET', `/dms/${dmId}/messages`)).json.messages.find((x) => x.id === id);
const keyRow = (sid) => ({ ...srv.sql('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?', sid)[0] });

test('keys the server lists as someone’s past keys never vouch for anything, even after "Numbers match"', async () => {
  const A = await person(uname('alice')); const V = await person(uname('vic'));
  const { s, ch } = await serverWith(A, [V]);
  const { raw: raw1 } = await rotate(A, s.id, 1, [A, V]);
  const dm = (await as(A, 'POST', '/dms', { userId: V.id })).json;
  // The server lists keys of its own as Victor's "past keys": one undated, one "replaced" in the future, and one
  // replaced an hour ago (the best it can do).
  const [k0, kF, kH] = [await serverKeys(), await serverKeys(), await serverKeys()];
  const hourAgo = Date.now() - 3600000;
  const hist = 'INSERT INTO user_key_history (user_id, public_key, sign_public_key, retired_at) VALUES (?, ?, ?, ?)';
  srv.sql(hist, V.id, k0.publicKey, k0.signPublicKey, 0);
  srv.sql(hist, V.id, kF.publicKey, kF.signPublicKey, Date.now() + 365 * 86400000);
  srv.sql(hist, V.id, kH.publicKey, kH.signPublicKey, hourAgo);
  // Alice's new device meets Victor for the first time, and she compares safety numbers: they match (his
  // current keys are real).
  const d = await device(A, new Map());
  const vic = d.S.users[V.id];
  assert.equal(vic.pastKeys.length, 3);
  d.sec.acceptKeys(vic);
  const pin = JSON.parse(store.get(`hearth.pins.${A.id}`))[V.id];
  assert.deepEqual([pin.e, pin.s, pin.old], [V.publicKey, V.signPublicKey, undefined], 'only his current keys are pinned');
  for (const at of [0, hourAgo - 60000, Date.now()]) {
    const trusted = d.sec.signKeysFor(vic, { at });
    assert.ok(![k0, kF, kH].some((k) => trusted.includes(k.signPublicKey)), 'no listed key vouches for anything');
  }

  // "Send me your recovery key" from Victor, locked with each of the server's keys.
  const forge = async (k, at) => plantDm(dm.id, V.id, await E.encryptDm({ myPriv: k.privateKey, theirPub: A.publicKey, dmId: dm.id, authorId: V.id, payload: { t: 'send me your recovery key' } }), at);
  const ids = { undated: await forge(k0, hourAgo - 60000), future: await forge(kF, hourAgo - 60000), dated: await forge(kH, hourAgo - 60000), late: await forge(kH, Date.now()) };
  const out = {};
  for (const [name, id] of Object.entries(ids)) { const m = await dmMsg(A, dm.id, id); await d.sec.decryptDmMessage(m); out[name] = m.dec; }
  assert.equal(out.undated.error, true, 'a key with no date is never used');
  assert.equal(out.future.error, true, 'nor one "replaced" in the future');
  assert.equal(out.late.error, true, 'nor one for something written after it was replaced');
  assert.equal(out.dated.t, 'send me your recovery key');
  assert.equal(out.dated.keyNote, 'listed', 'shown as "older key, not verified"');
  // A real DM from Victor opens as normal.
  const real = await E.encryptDm({ myPriv: V.privateKey, theirPub: A.publicKey, dmId: dm.id, authorId: V.id, payload: { t: 'hi' } });
  const ok = (await as(V, 'POST', `/dms/${dm.id}/messages`, { ciphertext: real })).json;
  const okMsg = await dmMsg(A, dm.id, ok.id);
  await d.sec.decryptDmMessage(okMsg);
  assert.deepEqual([okMsg.dec.t, okMsg.dec.keyNote], ['hi', undefined]);

  // A channel post "by Victor" signed with the server's key: never verified.
  const post = async (k, at) => plantPost(ch, V.id, await E.encryptGroup({ raw: raw1, serverId: s.id, channelId: ch, epoch: 1, authorId: V.id, signKey: k.signKey, payload: { t: 'forged post' } }), 1, at);
  const p1 = await post(kH, hourAgo - 60000); const p2 = await post(k0, hourAgo - 60000);
  const msgs = await channelMsgs(A, ch);
  const m1 = msgs.find((x) => x.id === p1); const m2 = msgs.find((x) => x.id === p2);
  await d.sec.decryptChannelMessage(m1); await d.sec.decryptChannelMessage(m2);
  assert.deepEqual([m1.dec.t, m1.dec.verified, m1.dec.keyNote], ['forged post', false, 'listed']);
  assert.deepEqual([m2.dec.verified, m2.dec.keyNote], [false, undefined]);

  // An older server key handed out "by Victor" with a listed key: readable history at most, never kept as
  // Alice's own copy, and never the key she writes with.
  await rotate(A, s.id, 2, [A, V]);
  const fake1 = E.newGroupKey();
  srv.sql('UPDATE server_epochs SET key_check = ? WHERE server_id = ? AND epoch = 1', await E.keyCheck(fake1, s.id, 1), s.id);
  const w1 = await E.wrapGroupKey({ raw: fake1, serverId: s.id, epoch: 1, recipientId: A.id, recipientPub: A.publicKey, wrapperId: V.id, signKey: kH.signKey });
  srv.sql('UPDATE server_keys SET wrapped = ?, wrapper_id = ?, created_at = ? WHERE server_id = ? AND user_id = ? AND epoch = 1', w1, V.id, hourAgo - 60000, s.id, A.id);
  srv.sql('DELETE FROM server_keys WHERE server_id = ? AND user_id = ? AND epoch = 2', s.id, A.id); // her copy of epoch 2 "lost"
  const d2 = await device(A, d.pins);
  assert.deepEqual(d2.sec.heldEpochs(s.id), [1]);
  assert.equal(rowsOf(s.id, A.id).find((x) => x.epoch === 1).wrapper_id, V.id, 'not re-wrapped as Alice’s own');
  // The server now says epoch 1 is current: the app won't write with it.
  srv.sql('UPDATE servers SET key_epoch = 1 WHERE id = ?', s.id);
  await d2.sec.refresh(s.id);
  assert.equal(d2.sec.currentKey(s.id), null);
  srv.sql('UPDATE servers SET key_epoch = 2 WHERE id = ?', s.id);
});

test('a server that lists its own keys as yours can’t plant a "self-wrapped" current key', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); const X = await serverKeys();
  const { s } = await serverWith(A, [B]);
  await rotate(A, s.id, 1, [A, B]);
  // Epoch 2: the server's key, wrapped to Alice, labelled as wrapped by Alice herself, signed with X; and X's
  // signing key served as Alice's.
  const evil = E.newGroupKey(); const t = Date.now();
  srv.sql('INSERT INTO server_epochs (server_id, epoch, key_check, creator_id, created_at) VALUES (?, 2, ?, ?, ?)', s.id, await E.keyCheck(evil, s.id, 2), A.id, t);
  const w = await E.wrapGroupKey({ raw: evil, serverId: s.id, epoch: 2, recipientId: A.id, recipientPub: A.publicKey, wrapperId: A.id, signKey: X.signKey });
  srv.sql('INSERT INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, 2, ?, ?, ?, ?)', s.id, A.id, w, A.id, t);
  srv.sql('UPDATE servers SET key_epoch = 2 WHERE id = ?', s.id);
  srv.sql('UPDATE users SET sign_public_key = ? WHERE id = ?', X.signPublicKey, A.id);
  // The app stops at start-up with a clear error instead of trusting it.
  await assert.rejects(device(A, new Map()), (e) => e.code === 'own_key_mismatch' && /aren’t the ones your password unlocks/.test(e.message));
  // Even an app that skipped that check never takes the planted copy (only keys proven to be yours count).
  store = new Map(); curIp = A.ip; API.setToken(A.token);
  const boot = (await as(A, 'GET', '/bootstrap')).json;
  const S = { me: boot.me, users: boot.users, servers: boot.servers, dms: boot.dms, privateKey: A.privateKey, signKey: A.signKey };
  const sec = createSecure({ S });
  for (const st of Object.values(boot.keyStates)) await sec.applyState(st);
  assert.ok(!sec.heldEpochs(s.id).includes(2));
  assert.equal(sec.currentKey(s.id), null);
  // Alice's identity key swapped for X's: refused at start-up too (her signing key is locked with it).
  srv.sql('UPDATE users SET sign_public_key = ?, public_key = ? WHERE id = ?', A.signPublicKey, X.publicKey, A.id);
  await assert.rejects(device(A, new Map()), (e) => e.code === 'own_key_mismatch');
  // With her real keys the app starts, and the planted key still isn't used (it isn't signed by her).
  srv.sql('UPDATE users SET public_key = ? WHERE id = ?', A.publicKey, A.id);
  const d = await device(A, new Map());
  assert.deepEqual(d.sec.heldEpochs(s.id), [1]);
  assert.equal(d.sec.currentKey(s.id), null);
});

test('refused rotations don’t use up the hour: the owner can still replace the key, and only real keys count', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); const M = await person(uname('mallory'));
  const { s } = await serverWith(A, [B, M]);
  assert.equal((await rotate(A, s.id, 1, [A, B, M])).r.status, 200);
  srv.sql('UPDATE server_epochs SET created_at = created_at - 11 * 60000 WHERE server_id = ?', s.id);
  // Mallory (no permissions) sends a dozen rotations that leave someone out: all refused...
  for (let i = 0; i < 13; i++) {
    const r = (await rotate(M, s.id, 2, [A, M])).r;
    assert.deepEqual([r.status, r.json.code], [409, 'members']);
  }
  // ...and they don't count: the owner's "Replace key now" works, and so does Mallory's own (the key is old).
  assert.equal((await rotate(A, s.id, 2, [A, B, M])).r.status, 200);
  srv.sql('UPDATE server_epochs SET created_at = created_at - 11 * 60000 WHERE server_id = ? AND epoch = 2', s.id);
  assert.equal((await rotate(M, s.id, 3, [A, B, M])).r.status, 200);
  // Twelve keys made in the last hour: plain members wait, the owner has an allowance of her own.
  for (let e = 4; e <= 12; e++) assert.equal((await rotate(A, s.id, e, [A, B, M])).r.status, 200);
  srv.sql('UPDATE server_epochs SET created_at = created_at - 11 * 60000 WHERE server_id = ? AND epoch = 12', s.id);
  const r = (await rotate(M, s.id, 13, [A, B, M])).r;
  assert.deepEqual([r.status, r.json.code], [429, 'rate_limited']);
  assert.equal((await rotate(A, s.id, 13, [A, B, M])).r.status, 200);
  // An hour later it's fine again.
  srv.sql('UPDATE server_epochs SET created_at = created_at - 61 * 60000 WHERE server_id = ?', s.id);
  assert.equal((await rotate(M, s.id, 14, [A, B, M])).r.status, 200);
});

test('reporting a good key doesn’t let anyone skip the rotation limits, nor keep the key churning', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); const C = await person(uname('carol'));
  const M = await person(uname('mallory')); const M2 = await person(uname('mallory2')); // Mallory's second account
  const { s } = await serverWith(A, [B, C, M, M2]);
  const everyone = [A, B, C, M, M2];
  assert.equal((await rotate(A, s.id, 1, everyone)).r.status, 200);
  const bobOnline = await srv.socket(B.token); // Bob's app is open (it opened the key fine)
  try {
    // Mallory may not replace the key yet...
    let r = (await rotate(M, s.id, 2, everyone)).r;
    assert.deepEqual([r.status, r.json.code], [429, 'rotate_too_soon']);
    // ...so she says the (perfectly good) key Alice handed her doesn't open. One report isn't enough.
    assert.equal((await as(M, 'POST', `/servers/${s.id}/keys/bad`, { epoch: 1 })).json.removed, 1);
    assert.equal(keyRow(s.id).needs_rotation, 0);
    r = (await rotate(M, s.id, 2, everyone, { check: 'B'.repeat(24) })).r;
    assert.deepEqual([r.status, r.json.code], [429, 'rotate_too_soon']);
    // With her second account too, the apps are asked for a new key, but neither of hers may make it (let
    // alone one nobody can open): Bob is online and can.
    assert.equal((await as(M2, 'POST', `/servers/${s.id}/keys/bad`, { epoch: 1 })).json.removed, 1);
    assert.equal(keyRow(s.id).needs_rotation, 1);
    for (const u of [M, M2]) {
      r = (await rotate(u, s.id, 2, everyone, { check: 'B'.repeat(24) })).r;
      assert.deepEqual([r.status, r.json.code], [429, 'rotate_too_soon']);
    }
    assert.equal((await rotate(B, s.id, 2, everyone)).r.status, 200);
    // Each member's reports count only so often: the pair can't keep the key churning. (Each new key is made by
    // whoever didn't make the one reported: Carol and Bob take turns.)
    let forced = 1;
    for (let e = 2; e < 20; e++) {
      await as(M, 'POST', `/servers/${s.id}/keys/bad`, { epoch: e });
      await as(M2, 'POST', `/servers/${s.id}/keys/bad`, { epoch: e });
      if (!keyRow(s.id).needs_rotation) break;
      forced++;
      assert.equal((await rotate(e % 2 ? B : C, s.id, e + 1, everyone)).r.status, 200);
    }
    assert.equal(forced, 12, 'twelve reports an hour each, then no more');
    assert.equal(keyRow(s.id).needs_rotation, 0);
  } finally { bobOnline.close(); }

  // A key that really is broken still gets replaced at once by the members it fails for (nobody else online).
  srv.sql('UPDATE server_epochs SET created_at = created_at - 61 * 60000 WHERE server_id = ?', s.id);
  srv.sql('DELETE FROM server_key_reports WHERE server_id = ?', s.id);
  const e0 = keyRow(s.id).key_epoch;
  const bad = await rotate(M, s.id, e0 + 1, everyone, { check: 'C'.repeat(24) });
  assert.equal(bad.r.status, 200, bad.r.text);
  // Mallory made it: once it's reported broken she can't make its replacement without the limits either.
  await as(B, 'POST', `/servers/${s.id}/keys/bad`, { epoch: e0 + 1 });
  await as(C, 'POST', `/servers/${s.id}/keys/bad`, { epoch: e0 + 1 });
  assert.equal(keyRow(s.id).needs_rotation, 1);
  const again = (await rotate(M, s.id, e0 + 2, everyone, { check: 'C'.repeat(24) })).r;
  assert.deepEqual([again.status, again.json.code], [429, 'rotate_too_soon']);
  // Carol's app (it couldn't open the key either) replaces it at once.
  await device(C, new Map());
  assert.ok(await until(() => keyRow(s.id).key_epoch === e0 + 2), 'a fresh key replaced the broken one');
  assert.equal(srv.sql('SELECT creator_id FROM server_epochs WHERE server_id = ? AND epoch = ?', s.id, e0 + 2)[0].creator_id, C.id);
});

test('a kicked member who resets their password and rejoins still gets a new key', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); let K = await person(uname('mike'));
  const { s, code, ch } = await serverWith(A, [B, K]);
  await rotate(A, s.id, 1, [A, B, K]);
  assert.equal((await as(A, 'DELETE', `/servers/${s.id}/members/${K.id}`)).status, 200);
  const { raw: raw2 } = await rotate(A, s.id, 2, [A, B]);
  await send(A, s.id, ch, 2, raw2, 'mods: about mike');
  K = await resetWithoutRecovery(K); // deletes all his key rows
  assert.equal(srv.sql('SELECT COUNT(*) n FROM server_keys WHERE user_id = ?', K.id)[0].n, 0);
  assert.equal((await as(K, 'POST', `/invites/${code}/join`, {})).status, 200);
  assert.deepEqual(keyRow(s.id), { key_epoch: 2, needs_rotation: 1 }, 'coming back still asks for a new key');
  const w = await E.wrapGroupKey({ raw: raw2, serverId: s.id, epoch: 2, recipientId: K.id, recipientPub: K.publicKey, wrapperId: A.id, signKey: A.signKey });
  assert.equal((await as(A, 'POST', `/servers/${s.id}/keys/share`, { epoch: 2, wraps: { [K.id]: w } })).status, 409);
  // He can't make the new key himself without the usual limits (it would be his to choose).
  const r = (await rotate(K, s.id, 3, [A, B, K])).r;
  assert.deepEqual([r.status, r.json.code], [429, 'rotate_too_soon']);
  // Bob's app does it.
  assert.equal((await rotate(B, s.id, 3, [A, B, K])).r.status, 200);
});

test('the password-locked key needs a two-factor code when that’s on, and shares the password-check limit', async () => {
  const A = await person(uname('alice'));
  const { secret, used } = await H.enable2fa(srv, A);
  srv.sql('UPDATE sessions SET mfa_at = NULL WHERE user_id = ?', A.id); // its last two-factor check was a while ago
  let r = await as(A, 'POST', '/me/keys/wrapped', { authKey: A.authKey });
  assert.deepEqual([r.status, r.json.code], [401, 'need_2fa'], 'the password alone isn’t enough');
  r = await as(A, 'POST', '/me/keys/wrapped', { authKey: A.authKey, totp: await H.freshCode(secret, used) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.encPrivateKey, A.encPrivateKey);
  // Wrong passwords here and in the other password checks share one limit.
  const B = await person(uname('bob'));
  for (let i = 0; i < 5; i++) await as(B, 'POST', '/me/keys/wrapped', { authKey: H.hex(32) });
  for (let i = 0; i < 5; i++) await as(B, 'DELETE', '/me/recovery', { authKey: H.hex(32) });
  r = await as(B, 'POST', '/me/keys/wrapped', { authKey: B.authKey });
  assert.equal(r.status, 429);
});

test('replies, old DM files and accepted keys use the keys from when things were written; lists stay lean', async () => {
  const A = await person(uname('alice')); let V = await person(uname('vera'));
  const { s, ch } = await serverWith(A, [V]);
  const { raw } = await rotate(A, s.id, 1, [A, V]);
  const dm = (await as(A, 'POST', '/dms', { userId: V.id })).json;
  const pins = new Map();
  await device(A, pins); // Alice's device knows Vera's first keys
  const oldPost = await send(V, s.id, ch, 1, raw, 'before');
  // An old-format DM file Vera sent before resetting (locked with the conversation key itself).
  const sub = crypto.subtle;
  const bits = await sub.deriveBits({ name: 'ECDH', public: await sub.importKey('spki', E.unb64(A.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, V.privateKey, 256);
  const fk = await sub.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('hearth-dm-salt'), info: new TextEncoder().encode('hearth-dm-v1') },
    await sub.importKey('raw', bits, 'HKDF', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.randomBytes(12);
  const fileBuf = Buffer.concat([iv, Buffer.from(await sub.encrypt({ name: 'AES-GCM', iv }, fk, Buffer.from('old file')))]);
  const V0 = V;
  await sleep(5);
  V = await resetWithoutRecovery(V);
  const retiredAt = srv.sql('SELECT retired_at FROM user_key_history WHERE user_id = ?', V.id)[0].retired_at;
  // Someone posts with Vera's old signing key after her reset (say it leaked); Alice replies to it and to her old post.
  await sleep(5);
  const ct = await E.encryptGroup({ raw, serverId: s.id, channelId: ch, epoch: 1, authorId: V.id, signKey: V0.signKey, payload: { t: 'leaked' } });
  const late = (await as(V, 'POST', `/channels/${ch}/messages`, { ciphertext: ct, epoch: 1 })).json.id;
  const replyTo = async (to, t) => (await as(A, 'POST', `/channels/${ch}/messages`, { ciphertext: await E.encryptGroup({ raw, serverId: s.id, channelId: ch, epoch: 1, authorId: A.id, signKey: A.signKey, payload: { t } }), epoch: 1, replyTo: to })).json.id;
  const reply = await replyTo(late, 're'); const reply2 = await replyTo(oldPost, 're2');

  await sleep(20);
  const d = await device(A, pins);
  d.sec.acceptKeys(d.S.users[V.id]); // "Numbers match", a while after her reset
  const pin = JSON.parse(store.get(`hearth.pins.${A.id}`))[V.id];
  assert.equal(pin.old[0].until, retiredAt, 'the old key counts until the server says it was replaced, not until now');
  const msgs = await channelMsgs(A, ch);
  for (const id of [reply, reply2]) await d.sec.decryptChannelMessage(msgs.find((m) => m.id === id));
  const rp = msgs.find((m) => m.id === reply).reply; const rp2 = msgs.find((m) => m.id === reply2).reply;
  assert.ok(rp.createdAt && rp2.createdAt);
  assert.deepEqual([rp.dec.t, rp.dec.verified], ['leaked', false], 'a reply preview isn’t verified with a key from before it');
  assert.deepEqual([rp2.dec.t, rp2.dec.verified, rp2.dec.keyNote], ['before', true, 'pinned']);
  // The old-format file opens with the key Vera had when she sent it.
  const plain = await d.sec.decryptAttachment({ dmId: dm.id, createdAt: retiredAt - 1 }, {}, fileBuf);
  assert.equal(Buffer.from(plain).toString(), 'old file');
  // Past keys come with the user's own record and the start-up list, not with every list of people.
  assert.equal((await as(A, 'GET', `/users/${V.id}`)).json.pastKeys.length, 1);
  assert.equal(d.boot.users[V.id].pastKeys.length, 1);
  const people = (await as(A, 'GET', '/people')).json.people;
  assert.ok(people.some((x) => x.id === V.id) && people.every((x) => !('pastKeys' in x)));
});
