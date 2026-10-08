// The app's real end-to-end encryption code (public/js/e2ee.js), run in Node with the same WebCrypto and
// Argon2id the browser uses. Proves that tampering is detected, wrong keys fail, signatures bind the sender,
// and the recovery key really restores the same identity.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let E; let SELF;
const enc = new TextEncoder();
before(async () => {
  globalThis.window = { crypto: globalThis.crypto, hashwasm: require('hash-wasm') };
  E = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'e2ee.js')).href);
  SELF = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'selftest.js')).href);
});

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
// Change one bit in one ':'-separated base64 field (or its last byte = the GCM tag, when tag = true).
function tamper(text, field, { tag = false } = {}) {
  const p = text.split(':');
  const bytes = unb64(p[field]);
  bytes[tag ? bytes.length - 1 : Math.floor(bytes.length / 2)] ^= 1;
  p[field] = b64(bytes);
  return p.join(':');
}
const fails = async (fn) => { try { await fn(); return false; } catch { return true; } };
async function person(name) {
  const { wrapKey } = await E.deriveKeys(name, `pw-${name}`, { kdf: 'argon2id', salt: E.newKdfSalt() });
  const id = await E.createIdentity(wrapKey);
  const s = await E.createSigningKey(id.privateKey, id.publicKey);
  return { ...id, ...s, wrapKey, id: name };
}

test('the in-app "Check my encryption" checks all pass', async () => {
  const results = await SELF.runCryptoChecks();
  const bad = results.filter((r) => !r.ok);
  assert.deepEqual(bad, []);
  assert.ok(results.length >= 18);
});

test('direct messages: tampered ciphertext, tag, salt or nonce are refused; the wrong key fails', async () => {
  const a = await person('a'); const b = await person('b'); const eve = await person('eve');
  const text = await E.encryptDm({ myPriv: a.privateKey, theirPub: b.publicKey, dmId: 'dm1', authorId: 'a', payload: { t: 'hello' } });
  const open = (t, who = b, from = a) => E.decryptDm({ myPriv: who.privateKey, theirPub: from.publicKey, dmId: 'dm1', authorId: 'a', text: t });
  assert.equal((await open(text)).payload.t, 'hello');
  assert.ok(await fails(() => open(tamper(text, 3))), 'ciphertext');
  assert.ok(await fails(() => open(tamper(text, 3, { tag: true }))), 'authentication tag');
  assert.ok(await fails(() => open(tamper(text, 1))), 'salt');
  assert.ok(await fails(() => open(tamper(text, 2))), 'nonce');
  assert.ok(await fails(() => open(text.split(':').slice(0, 3).join(':') + ':' + b64(unb64(text.split(':')[3]).slice(0, -4)))), 'truncated');
  assert.ok(await fails(() => open(text, eve)), 'outsider key');
  assert.ok(await fails(() => open(text, b, eve)), 'claimed to come from someone else');
  assert.ok(await fails(() => E.decryptDm({ myPriv: b.privateKey, theirPub: a.publicKey, dmId: 'dm2', authorId: 'a', text })), 'moved to another DM');
});

test('channel messages: tampering fails, a forged author is caught, other keys and channels fail', async () => {
  const a = await person('a'); const m = await person('mallory');
  const raw = E.newGroupKey();
  const msg = await E.encryptGroup({ raw, serverId: 's', channelId: 'c', epoch: 3, authorId: 'a', signKey: a.signKey, payload: { t: 'secret' } });
  const open = (t, o = {}) => E.decryptGroup({ raw, serverId: 's', channelId: 'c', authorId: 'a', authorSignPub: a.signPublicKey, text: t, ...o });
  const ok = await open(msg);
  assert.equal(ok.payload.t, 'secret'); assert.equal(ok.verified, true);
  for (const f of [2, 3, 4]) assert.ok(await fails(() => open(tamper(msg, f))), `field ${f}`);
  assert.ok(await fails(() => open(tamper(msg, 4, { tag: true }))), 'tag');
  assert.ok(await fails(() => open(msg.replace(/^c2:3:/, 'c2:4:'))), 'epoch changed');
  assert.ok(await fails(() => open(msg, { channelId: 'other' })));
  assert.ok(await fails(() => open(msg, { raw: E.newGroupKey() })), 'old or other server key');
  // Mallory (a member, so she has the group key) re-signs Alice's message as her own, or signs one "from Alice".
  const forged = await E.encryptGroup({ raw, serverId: 's', channelId: 'c', epoch: 3, authorId: 'a', signKey: m.signKey, payload: { t: 'I am Alice' } });
  assert.equal((await open(forged)).verified, false, 'signature check exposes the impersonation');
  const sigSwapped = msg.split(':'); sigSwapped[5] = b64(unb64(sigSwapped[5]).map((x, i) => (i === 10 ? x ^ 1 : x)));
  const r = await open(sigSwapped.join(':')).catch(() => ({ verified: false }));
  assert.equal(r.verified, false, 'changed signature');
});

test('server key handoff: signed by the sharer; tampering, replays to someone else or another epoch fail', async () => {
  const a = await person('a'); const b = await person('b'); const eve = await person('eve');
  const raw = E.newGroupKey();
  const w = await E.wrapGroupKey({ raw, serverId: 's', epoch: 2, recipientId: 'b', recipientPub: b.publicKey, wrapperId: 'a', signKey: a.signKey });
  const open = (wrapped, o = {}) => E.unwrapGroupKey({ wrapped, serverId: 's', epoch: 2, myId: 'b', myPriv: b.privateKey, wrapperId: 'a', wrapperSignPub: a.signPublicKey, ...o });
  assert.deepEqual([...(await open(w))], [...raw]);
  for (const f of [1, 2, 3, 4]) assert.ok(await fails(() => open(tamper(w, f))), `field ${f}`);
  assert.ok(await fails(() => open(w, { epoch: 3 })), 'replayed into another epoch');
  assert.ok(await fails(() => open(w, { serverId: 's2' })), 'replayed into another server');
  assert.ok(await fails(() => open(w, { myId: 'eve', myPriv: eve.privateKey })), 'given to someone else');
  assert.ok(await fails(() => open(w, { wrapperSignPub: eve.signPublicKey })), 'claimed to come from someone else');
  // The server (or anyone) swapping in its own key, signed by itself, is refused.
  const evil = await E.wrapGroupKey({ raw: E.newGroupKey(), serverId: 's', epoch: 2, recipientId: 'b', recipientPub: b.publicKey, wrapperId: 'a', signKey: eve.signKey });
  assert.ok(await fails(() => open(evil)));
});

test('password-locked private key: right password opens it, wrong one doesn’t, tampering is caught', async () => {
  const salt = E.newKdfSalt();
  const k1 = await E.deriveKeys('alice', 'correct horse', { kdf: 'argon2id', salt });
  const k2 = await E.deriveKeys('alice', 'correct horsf', { kdf: 'argon2id', salt });
  const k3 = await E.deriveKeys('alice', 'correct horse', { kdf: 'argon2id', salt: E.newKdfSalt() });
  assert.notEqual(k1.authKey, k2.authKey); assert.notEqual(k1.authKey, k3.authKey);
  assert.match(k1.authKey, /^[0-9a-f]{64}$/);
  const id = await E.createIdentity(k1.wrapKey);
  assert.ok(await E.unwrapPrivateKey(k1.wrapKey, id.encPrivateKey));
  assert.ok(await fails(() => E.unwrapPrivateKey(k2.wrapKey, id.encPrivateKey)));
  assert.ok(await fails(() => E.unwrapPrivateKey(k3.wrapKey, id.encPrivateKey)), 'same password, different salt');
  const t = unb64(id.encPrivateKey); t[t.length - 1] ^= 1;
  assert.ok(await fails(() => E.unwrapPrivateKey(k1.wrapKey, b64(t))));
});

test('recovery key restores the very same identity (old messages stay readable)', async () => {
  const a = await person('alice'); const b = await person('bob');
  const old = await E.encryptDm({ myPriv: b.privateKey, theirPub: a.publicKey, dmId: 'd', authorId: 'bob', payload: { t: 'from before' } });
  const code = E.newRecoveryCode();
  assert.match(code, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  const rSalt = E.newKdfSalt();
  const recoveryCopy = await E.rewrapPrivateKey(a.wrapKey, await E.recoveryWrapKey(code, rSalt), a.encPrivateKey);
  // Password forgotten: open the recovery copy with the code, lock it with a new password.
  const next = await E.deriveKeys('alice', 'brand new password', { kdf: 'argon2id', salt: E.newKdfSalt() });
  const relocked = await E.rewrapPrivateKey(await E.recoveryWrapKey(code.toLowerCase(), rSalt), next.wrapKey, recoveryCopy);
  const restored = await E.unwrapPrivateKey(next.wrapKey, relocked);
  assert.equal((await E.decryptDm({ myPriv: restored, theirPub: b.publicKey, dmId: 'd', authorId: 'bob', text: old })).payload.t, 'from before');
  // a wrong or mistyped code doesn't open it
  assert.ok(await fails(async () => E.unwrapPrivateKey(await E.recoveryWrapKey(E.newRecoveryCode(), rSalt), recoveryCopy)));
  assert.ok(await fails(async () => E.unwrapPrivateKey(await E.recoveryWrapKey(code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A'), rSalt), recoveryCopy)));
  assert.ok(await fails(async () => E.recoveryWrapKey('too-short', rSalt)));
});

test('reset key proof: what the app computes is exactly what the server checks', async () => {
  const a = await person('alice');
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const nonce = crypto.randomBytes(24).toString('base64url');
  const proof = await E.resetKeyProof(a.privateKey, eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), nonce, 'user1');
  // the server side (server/accounts.js)
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(a.publicKey, 'base64'), format: 'der', type: 'spki' }) });
  assert.equal(proof, crypto.createHmac('sha256', shared).update(`hearth-reset-proof|user1|${nonce}`).digest('base64'));
  const other = await person('mallory');
  assert.notEqual(await E.resetKeyProof(other.privateKey, eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), nonce, 'user1'), proof);
});

test('message length is hidden and every encryption is unique', async () => {
  const raw = E.newGroupKey(); const a = await person('a');
  const sizes = new Set();
  const seen = new Set();
  for (const t of ['', 'ok', 'a'.repeat(100), 'b'.repeat(200)]) {
    const m = await E.encryptGroup({ raw, serverId: 's', channelId: 'c', epoch: 1, authorId: 'a', signKey: a.signKey, payload: { t } });
    sizes.add(m.split(':')[4].length);
    seen.add(m);
  }
  assert.equal(sizes.size, 1, 'short and longer messages are the same size');
  const same = await Promise.all(Array.from({ length: 50 }, () => E.encryptGroup({ raw, serverId: 's', channelId: 'c', epoch: 1, authorId: 'a', signKey: a.signKey, payload: { t: 'same' } })));
  assert.equal(new Set(same.map((m) => m.split(':')[3])).size, 50, 'fresh nonce every time');
  assert.equal(new Set(same).size, 50);
});

test('files: own key each, tampering and wrong keys fail', async () => {
  const f = await E.encryptFile(enc.encode('a picture').buffer);
  const g = await E.encryptFile(enc.encode('a picture').buffer);
  assert.notEqual(f.k, g.k);
  assert.equal(new TextDecoder().decode(await E.decryptFile(f.k, f.blob.buffer)), 'a picture');
  assert.ok(await fails(() => E.decryptFile(g.k, f.blob.buffer)));
  for (const i of [0, 5, 20, f.blob.length - 1]) { const bad = f.blob.slice(); bad[i] ^= 1; assert.ok(await fails(() => E.decryptFile(f.k, bad.buffer)), `byte ${i}`); }
});
