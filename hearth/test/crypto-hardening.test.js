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
  // After "Numbers match" the old key stays trusted for what it signed back then...
  od.sec.acceptKeys(od.S.users[V.id]);
  assert.deepEqual(od.sec.signKeysFor(od.S.users[V.id]), [now.signPublicKey, old.signPublicKey]);
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
  // already re-wrapped it to Bob).
  assert.equal(rowsOf(s.id, B.id)[0].wrapper_id, B.id);
  srv.sql('UPDATE server_keys SET wrapped = ?, wrapper_id = ? WHERE server_id = ? AND user_id = ? AND epoch = 1', victorsWrap, V.id, s.id, B.id);
  const fresh = await device(B, new Map());
  assert.deepEqual(fresh.sec.heldEpochs(s.id).sort(), [1, 2]);
  const all = await channelMsgs(B, ch);
  for (const m of all) await fresh.sec.decryptChannelMessage(m);
  assert.deepEqual(all.map((m) => [m.dec.t, m.dec.verified]).sort(),
    [['alice epoch 1', true], ['signed with the old key, today', false], ['victor before his reset', true]]);
  assert.deepEqual(rowsOf(s.id, B.id).map((x) => x.epoch), [1, 2], 'nothing was reported away');
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
  V = await resetWithoutRecovery(V);
  const d = await device(A, new Map()); // a new device of Alice's: learns Vera's old key from her history
  const m = (await as(A, 'GET', `/dms/${dm.id}/messages`)).json.messages[0];
  await d.sec.decryptDmMessage(m);
  assert.equal(m.dec.t, 'before the reset');
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
