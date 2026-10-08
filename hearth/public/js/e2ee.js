// Hearth end-to-end encryption.
//
// Primitives (all from the browser's WebCrypto, plus Argon2id via WebAssembly):
//   Password hardening  Argon2id (64 MiB, 3 passes) with a random per-account salt.
//                        Older accounts used PBKDF2-SHA256 and are upgraded at their next login.
//   Identity key        ECDH P-256. Private half is AES-256-GCM encrypted with a key derived from your
//                        password before it is stored on the server.
//   Signing key         ECDSA P-256. Signs channel messages, group-key handoffs and voice handshakes.
//   Message encryption  AES-256-GCM with a fresh key per message (HKDF-SHA256 from the conversation key
//                        and a random 256-bit salt), plus a random 96-bit nonce. Channel, author and key
//                        epoch are bound in as additional authenticated data. Padded to size steps so
//                        lengths don't give messages away.
//   Attachments         Each file gets its own random AES-256-GCM key, carried inside the encrypted message.
//   Direct messages     Conversation key = HKDF(ECDH(you, them)). Not signed, so DMs stay deniable.
//   Server channels     A random 256-bit group key per server "epoch", sent to each member wrapped with
//                        ECIES (ephemeral ECDH P-256 + HKDF + AES-GCM) and signed by whoever shared it.
//                        A new epoch starts whenever someone leaves, so former members can't read on.

const subtle = () => {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Encryption needs a secure connection. Open this site over https:// (or on localhost).');
  }
  return window.crypto.subtle;
};
const enc = new TextEncoder();
const dec = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };

// ---------------------------------------------------------------- encoding helpers
export function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdfKey(ikm) { return subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey', 'deriveBits']); }
function hkdfAes(base, salt, info, usages = ['encrypt', 'decrypt']) {
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, usages);
}
const gcm = (iv, aad) => (aad ? { name: 'AES-GCM', iv, additionalData: enc.encode(aad), tagLength: 128 } : { name: 'AES-GCM', iv, tagLength: 128 });
async function aesEncrypt(key, iv, data, aad) { return new Uint8Array(await subtle().encrypt(gcm(iv, aad), key, data)); }
async function aesDecrypt(key, iv, data, aad) { return new Uint8Array(await subtle().decrypt(gcm(iv, aad), key, data)); }

// Message lengths: before encryption every message is padded with spaces up to a size step (256 bytes,
// then 1 KiB steps above 4 KiB), so the server can't tell "ok" from a paragraph by the ciphertext's length.
// JSON ignores trailing spaces, so padded messages read fine everywhere (including older versions).
export function padded(payload) {
  const bytes = enc.encode(JSON.stringify(payload));
  const n = bytes.length;
  const step = n < 4096 ? 256 : 1024;
  const out = new Uint8Array(Math.ceil((n + 1) / step) * step).fill(0x20);
  out.set(bytes);
  return out;
}

// ---------------------------------------------------------------- password → keys
let argon2Promise = null;
function loadArgon2() {
  if (window.hashwasm && window.hashwasm.argon2id) return Promise.resolve(window.hashwasm.argon2id);
  if (!argon2Promise) {
    argon2Promise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/argon2.js';
      s.onload = () => (window.hashwasm && window.hashwasm.argon2id ? resolve(window.hashwasm.argon2id) : reject(new Error('Password hashing failed to load.')));
      s.onerror = () => { argon2Promise = null; reject(new Error('Password hashing failed to load. Check your connection.')); };
      document.head.append(s);
    });
  }
  return argon2Promise;
}
export const ARGON2 = { iterations: 3, memorySize: 64 * 1024, parallelism: 1 };
export const newKdfSalt = () => b64(rand(16));

// params: { kdf: 'argon2id', salt } or { kdf: 'pbkdf2' } (older accounts)
// Returns authKey (hex, sent to the server to log in) and wrapKey (never leaves the browser).
export async function deriveKeys(username, password, params) {
  if (params && params.kdf === 'pbkdf2') return derivePbkdf2(username, password);
  const argon2id = await loadArgon2();
  const master = await argon2id({
    password: password.normalize('NFKC'),
    salt: unb64(params.salt),
    ...ARGON2,
    hashLength: 32,
    outputType: 'binary',
  });
  const base = await hkdfKey(master);
  const authBits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('hearth-auth-v2') }, base, 256);
  const wrapKey = await hkdfAes(base, new Uint8Array(32), 'hearth-wrap-v2');
  master.fill(0);
  return { authKey: toHex(authBits), wrapKey };
}

async function derivePbkdf2(username, password) {
  const u = username.toLowerCase();
  const pbkdf2 = async (salt) => {
    const k = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    return subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 310000 }, k, 256);
  };
  const [authBits, wrapBits] = await Promise.all([pbkdf2('hearth-auth:' + u), pbkdf2('hearth-wrap:' + u)]);
  const wrapKey = await subtle().importKey('raw', wrapBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { authKey: toHex(authBits), wrapKey };
}

async function sealBytes(key, bytes, aad) {
  const iv = rand(12);
  return b64(iv) + ':' + b64(await aesEncrypt(key, iv, bytes, aad));
}
async function openBytes(key, sealed, aad) {
  const [iv, ct] = sealed.split(':');
  return aesDecrypt(key, unb64(iv), unb64(ct), aad);
}

// ---------------------------------------------------------------- recovery key
// 32 random letters/numbers (160 bits). It encrypts a second copy of your private key, so a password reset
// by email can keep all your messages. High entropy, so a fast key derivation (HKDF) is enough.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newRecoveryCode() {
  const bytes = rand(20);
  let bits = 0; let value = 0; let out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{4}/g).join('-');
}
const normRecovery = (c) => String(c || '').toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/[^A-Z2-7]/g, '');
export async function recoveryWrapKey(code, saltB64) {
  const n = normRecovery(code);
  if (n.length !== 32) throw new Error('A recovery key has 32 letters and numbers (dashes optional).');
  return hkdfAes(await hkdfKey(enc.encode(`hearth-recovery|${n}`)), unb64(saltB64), 'hearth-recovery-v1');
}

// ---------------------------------------------------------------- identity (ECDH) key
const importEcdhPrivate = (pkcs8) => subtle().importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
const pubCache = new Map();
function importEcdhPublic(b64key) {
  if (!pubCache.has(b64key)) pubCache.set(b64key, subtle().importKey('spki', unb64(b64key), ECDH, false, []));
  return pubCache.get(b64key);
}

export async function createIdentity(wrapKey) {
  const kp = await subtle().generateKey(ECDH, true, ['deriveBits']);
  const publicKey = b64(await subtle().exportKey('spki', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey));
  const encPrivateKey = await sealBytes(wrapKey, pkcs8);
  const privateKey = await importEcdhPrivate(pkcs8);
  pkcs8.fill(0);
  return { publicKey, encPrivateKey, privateKey };
}
export async function unwrapPrivateKey(wrapKey, encPrivateKey) {
  const pkcs8 = await openBytes(wrapKey, encPrivateKey);
  try { return await importEcdhPrivate(pkcs8); } finally { pkcs8.fill(0); }
}
// Proves to the server that this device holds the private key for the account's published public key, without
// revealing it: ECDH with a one-off server key, then an HMAC over a fresh nonce. Used when a password reset
// keeps the old keys (the server checks it so an email-only attacker can't).
export async function resetKeyProof(myPriv, serverPublicKeyB64, nonce, userId) {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importEcdhPublic(serverPublicKeyB64) }, myPriv, 256);
  const mac = await subtle().importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await subtle().sign('HMAC', mac, enc.encode(`hearth-reset-proof|${userId}|${nonce}`)));
}
// ---------------------------------------------------------------- personal vault (study tools)
// A key only you can derive: ECDH between your identity key and its own public half, through HKDF. Your study
// decks, assignments and stats are encrypted with it before they're saved, so the server stores only ciphertext.
// Each item is bound to its kind and id (as additional data), so the server can't swap or relabel items.
export async function vaultKey(myPriv, myPubB64) {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importEcdhPublic(myPubB64) }, myPriv, 256);
  return hkdfAes(await hkdfKey(bits), enc.encode('hearth-vault-salt'), 'hearth-vault-v1');
}
export async function sealVault(key, kind, id, obj) {
  return 'x1:' + await sealBytes(key, padded(obj), `hearth-vault|${kind}|${id}`);
}
export async function openVault(key, kind, id, text) {
  if (!String(text).startsWith('x1:')) throw new Error('Unknown format');
  return JSON.parse(dec.decode(await openBytes(key, text.slice(3), `hearth-vault|${kind}|${id}`)));
}
export async function rewrapPrivateKey(oldWrapKey, newWrapKey, encPrivateKey) {
  const pkcs8 = await openBytes(oldWrapKey, encPrivateKey);
  try { return await sealBytes(newWrapKey, pkcs8); } finally { pkcs8.fill(0); }
}

// ---------------------------------------------------------------- signing (ECDSA) key
// The signing key's private half is encrypted with a key derived from ECDH(your private, your public):
// only someone holding your identity key can compute it, so every device you log in on can unlock it.
async function selfKey(myPriv, myPubB64) {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importEcdhPublic(myPubB64) }, myPriv, 256);
  return hkdfAes(await hkdfKey(bits), new Uint8Array(32), 'hearth-self-wrap-v1');
}
export async function createSigningKey(myPriv, myPubB64) {
  const kp = await subtle().generateKey(ECDSA, true, ['sign', 'verify']);
  const signPublicKey = b64(await subtle().exportKey('spki', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey));
  const encSignPrivateKey = await sealBytes(await selfKey(myPriv, myPubB64), pkcs8, 'hearth-sign-key');
  const signKey = await subtle().importKey('pkcs8', pkcs8, ECDSA, false, ['sign']);
  pkcs8.fill(0);
  return { signPublicKey, encSignPrivateKey, signKey };
}
export async function unwrapSigningKey(myPriv, myPubB64, encSignPrivateKey) {
  const pkcs8 = await openBytes(await selfKey(myPriv, myPubB64), encSignPrivateKey, 'hearth-sign-key');
  try { return await subtle().importKey('pkcs8', pkcs8, ECDSA, false, ['sign']); } finally { pkcs8.fill(0); }
}

const verifyCache = new Map();
function importVerifyKey(b64key) {
  if (!verifyCache.has(b64key)) verifyCache.set(b64key, subtle().importKey('spki', unb64(b64key), ECDSA, false, ['verify']));
  return verifyCache.get(b64key);
}
export async function sign(signKey, text) {
  return b64(await subtle().sign(SIGN_ALG, signKey, enc.encode(text)));
}
export async function verify(signPubB64, text, sigB64) {
  if (!signPubB64 || !sigB64) return false;
  try { return await subtle().verify(SIGN_ALG, await importVerifyKey(signPubB64), unb64(sigB64), enc.encode(text)); } catch { return false; }
}

// ---------------------------------------------------------------- direct messages
// Derived keys are cached per (your private key, their public key), so a cache can never hand one person's
// key to another, even with two accounts or a key change in the same tab.
let dmBases = new WeakMap(); // myPriv -> Map(theirPub -> Promise<HKDF base>)
let dmLegacyKeys = new WeakMap();
const cacheFor = (wm, k) => { let m = wm.get(k); if (!m) { m = new Map(); wm.set(k, m); } return m; };
function dmBase(myPriv, theirPubB64) {
  const m = cacheFor(dmBases, myPriv);
  if (!m.has(theirPubB64)) {
    m.set(theirPubB64, (async () => {
      const bits = await subtle().deriveBits({ name: 'ECDH', public: await importEcdhPublic(theirPubB64) }, myPriv, 256);
      return hkdfKey(bits);
    })());
  }
  return m.get(theirPubB64);
}
function dmLegacyKey(myPriv, theirPubB64) {
  const m = cacheFor(dmLegacyKeys, myPriv);
  if (!m.has(theirPubB64)) m.set(theirPubB64, dmBase(myPriv, theirPubB64).then((base) => hkdfAes(base, enc.encode('hearth-dm-salt'), 'hearth-dm-v1')));
  return m.get(theirPubB64);
}

// Format: d2:<salt>:<iv>:<ciphertext>   (fresh HKDF key per message; DM id + author bound as AAD)
export async function encryptDm({ myPriv, theirPub, dmId, authorId, payload }) {
  const salt = rand(32);
  const iv = rand(12);
  const key = await hkdfAes(await dmBase(myPriv, theirPub), salt, `hearth-dm-v2|${dmId}`, ['encrypt']);
  const ct = await aesEncrypt(key, iv, padded(payload), `hearth-d2|${dmId}|${authorId}`);
  return `d2:${b64(salt)}:${b64(iv)}:${b64(ct)}`;
}
export async function decryptDm({ myPriv, theirPub, dmId, authorId, text }) {
  if (text.startsWith('v1:')) {
    const key = await dmLegacyKey(myPriv, theirPub);
    return { payload: JSON.parse(dec.decode(await openBytes(key, text.slice(3)))), legacy: true };
  }
  const [v, salt, iv, ct] = text.split(':');
  if (v !== 'd2') throw new Error('Unknown format');
  const key = await hkdfAes(await dmBase(myPriv, theirPub), unb64(salt), `hearth-dm-v2|${dmId}`, ['decrypt']);
  return { payload: JSON.parse(dec.decode(await aesDecrypt(key, unb64(iv), unb64(ct), `hearth-d2|${dmId}|${authorId}`))) };
}
// Files from the first DM version were encrypted with the conversation key itself.
export async function decryptLegacyDmFile(myPriv, theirPub, buf) {
  const bytes = new Uint8Array(buf);
  return aesDecrypt(await dmLegacyKey(myPriv, theirPub), bytes.slice(0, 12), bytes.slice(12));
}

// ---------------------------------------------------------------- server channel group keys
export const newGroupKey = () => rand(32);

export async function keyCheck(raw, serverId, epoch) {
  const d = await subtle().digest('SHA-256', concat(enc.encode(`hearth-key-check|${serverId}|${epoch}|`), raw));
  return b64(new Uint8Array(d).slice(0, 18));
}

// ECIES: ephemeral ECDH with the recipient's identity key → HKDF → AES-GCM, then signed by the sender.
// Format: w1:<ephemeral public>:<iv>:<ciphertext>:<signature>
export async function wrapGroupKey({ raw, serverId, epoch, recipientId, recipientPub, wrapperId, signKey }) {
  const eph = await subtle().generateKey(ECDH, true, ['deriveBits']);
  const ephPub = b64(await subtle().exportKey('spki', eph.publicKey));
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importEcdhPublic(recipientPub) }, eph.privateKey, 256);
  const ctx = `hearth-gk|${serverId}|${epoch}|${recipientId}|${wrapperId}`;
  const key = await hkdfAes(await hkdfKey(bits), unb64(ephPub).slice(-32), ctx, ['encrypt']);
  const iv = rand(12);
  const ct = b64(await aesEncrypt(key, iv, raw, ctx));
  const body = `${ephPub}:${b64(iv)}:${ct}`;
  const sig = await sign(signKey, `${ctx}|${body}`);
  return `w1:${body}:${sig}`;
}
export async function unwrapGroupKey({ wrapped, serverId, epoch, myId, myPriv, wrapperId, wrapperSignPub }) {
  const [v, ephPub, iv, ct, sig] = wrapped.split(':');
  if (v !== 'w1') throw new Error('Unknown key format');
  const ctx = `hearth-gk|${serverId}|${epoch}|${myId}|${wrapperId}`;
  if (!(await verify(wrapperSignPub, `${ctx}|${ephPub}:${iv}:${ct}`, sig))) throw new Error('Key signature did not verify');
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importEcdhPublic(ephPub) }, myPriv, 256);
  const key = await hkdfAes(await hkdfKey(bits), unb64(ephPub).slice(-32), ctx, ['decrypt']);
  return aesDecrypt(key, unb64(iv), unb64(ct), ctx);
}

// Cached per key (the raw bytes object) as well as server+epoch, so a different key for the same epoch
// is never answered from the cache.
let groupBases = new WeakMap(); // raw -> Map(id -> Promise<HKDF base>)
function groupBase(raw, id) {
  const m = cacheFor(groupBases, raw);
  if (!m.has(id)) m.set(id, hkdfKey(raw));
  return m.get(id);
}

// Format: c2:<epoch>:<salt>:<iv>:<ciphertext>:<signature>
export async function encryptGroup({ raw, serverId, channelId, epoch, authorId, signKey, payload }) {
  const salt = rand(32);
  const iv = rand(12);
  const aad = `hearth-c2|${channelId}|${epoch}|${authorId}`;
  const key = await hkdfAes(await groupBase(raw, `${serverId}|${epoch}`), salt, `hearth-msg-v2|${channelId}`, ['encrypt']);
  const ct = await aesEncrypt(key, iv, padded(payload), aad);
  const body = `${epoch}:${b64(salt)}:${b64(iv)}:${b64(ct)}`;
  const sig = await sign(signKey, `${aad}|${body}`);
  return `c2:${body}:${sig}`;
}
export function groupEpoch(text) {
  const parts = String(text || '').split(':');
  return parts[0] === 'c2' ? parseInt(parts[1], 10) : null;
}
export async function decryptGroup({ raw, serverId, channelId, authorId, authorSignPub, text }) {
  const [v, epoch, salt, iv, ct, sig] = text.split(':');
  if (v !== 'c2') throw new Error('Unknown format');
  const aad = `hearth-c2|${channelId}|${epoch}|${authorId}`;
  const key = await hkdfAes(await groupBase(raw, `${serverId}|${epoch}`), unb64(salt), `hearth-msg-v2|${channelId}`, ['decrypt']);
  const payload = JSON.parse(dec.decode(await aesDecrypt(key, unb64(iv), unb64(ct), aad)));
  const verified = await verify(authorSignPub, `${aad}|${epoch}:${salt}:${iv}:${ct}`, sig);
  return { payload, verified };
}

// ---------------------------------------------------------------- attachments (one random key per file)
export async function encryptFile(arrayBuffer) {
  const raw = rand(32);
  const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = rand(12);
  const ct = await aesEncrypt(key, iv, arrayBuffer);
  return { blob: concat(iv, ct), k: b64(raw) };
}
export async function decryptFile(kB64, arrayBuffer) {
  const key = await subtle().importKey('raw', unb64(kB64), 'AES-GCM', false, ['decrypt']);
  const bytes = new Uint8Array(arrayBuffer);
  return aesDecrypt(key, bytes.slice(0, 12), bytes.slice(12));
}

// ---------------------------------------------------------------- verification
// Safety numbers cover both people's identity and signing keys.
export async function safetyNumber(a, b) {
  const ka = `${a.publicKey}|${a.signPublicKey || ''}`;
  const kb = `${b.publicKey}|${b.signPublicKey || ''}`;
  const [x, y] = [ka, kb].sort();
  const digest = new Uint8Array(await subtle().digest('SHA-512', enc.encode(`hearth-safety-v2|${x}||${y}`)));
  const groups = [];
  for (let i = 0; i < 12; i++) {
    const n = ((digest[i * 3] << 16) | (digest[i * 3 + 1] << 8) | digest[i * 3 + 2]) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups;
}
export async function keyFingerprint(user) {
  const digest = await subtle().digest('SHA-256', enc.encode(`${user.publicKey}|${user.signPublicKey || ''}`));
  return toHex(digest).slice(0, 40).match(/.{4}/g).join(' ');
}

// Trust on first use: remember each person's keys and warn if the server ever hands out different ones.
const pinKey = (myId) => `hearth.pins.${myId}`;
function loadPins(myId) { try { return JSON.parse(localStorage.getItem(pinKey(myId)) || '{}'); } catch { return {}; } }
function savePins(myId, pins) { localStorage.setItem(pinKey(myId), JSON.stringify(pins)); }
// Returns 'ok' | 'changed'. New people are pinned automatically.
export function checkPin(myId, user) {
  if (!user || !user.publicKey || user.id === myId) return 'ok';
  const pins = loadPins(myId);
  const p = pins[user.id];
  if (!p) { pins[user.id] = { e: user.publicKey, s: user.signPublicKey || null }; savePins(myId, pins); return 'ok'; }
  if (p.e !== user.publicKey) return 'changed';
  if (p.s && user.signPublicKey && p.s !== user.signPublicKey) return 'changed';
  if (!p.s && user.signPublicKey) { p.s = user.signPublicKey; savePins(myId, pins); }
  return 'ok';
}
export function acceptPin(myId, user) {
  const pins = loadPins(myId);
  pins[user.id] = { e: user.publicKey, s: user.signPublicKey || null, verified: true };
  savePins(myId, pins);
}

// ---------------------------------------------------------------- local key storage (IndexedDB)
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('hearth', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('keys', mode);
    const req = fn(t.objectStore('keys'));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}
export const storeKey = (userId, key) => tx('readwrite', (s) => s.put(key, userId));
export const loadKey = (userId) => tx('readonly', (s) => s.get(userId)).catch(() => null);
export const clearKeys = () => tx('readwrite', (s) => s.clear()).catch(() => {});
export function clearCaches() { dmBases = new WeakMap(); dmLegacyKeys = new WeakMap(); groupBases = new WeakMap(); }
