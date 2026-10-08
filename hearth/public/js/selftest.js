// "Check my encryption": runs every lock Hearth uses on this device, including that tampered or misaddressed
// messages are refused, then checks this account's own keys and server keys. Nothing is sent anywhere.
import * as E2EE from './e2ee.js';

const enc = new TextEncoder();
async function expectFail(fn) { try { await fn(); return false; } catch { return true; } }
const flip = (s) => { // change one character in the middle of a base64 field
  const i = Math.floor(s.length / 2);
  return s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
};
const tamperField = (text, idx) => { const p = text.split(':'); p[idx] = flip(p[idx]); return p.join(':'); };

// Generic checks on freshly made test keys. Returns [{ name, ok, detail }].
export async function runCryptoChecks() {
  const out = [];
  const check = async (name, fn) => {
    try { const r = await fn(); out.push({ name, ok: r !== false, detail: typeof r === 'string' ? r : '' }); } catch (e) { out.push({ name, ok: false, detail: e.message }); }
  };
  // Two pretend people (password hashing uses the real Argon2id settings, so this takes a second).
  const salt = E2EE.newKdfSalt();
  const k1 = await E2EE.deriveKeys('alice-test', 'correct horse battery', { kdf: 'argon2id', salt });
  const k1b = await E2EE.deriveKeys('alice-test', 'correct horse battery', { kdf: 'argon2id', salt });
  const k2 = await E2EE.deriveKeys('alice-test', 'wrong password!!', { kdf: 'argon2id', salt });
  await check('Password hashing (Argon2id) is repeatable and password-specific', () => k1.authKey === k1b.authKey && k1.authKey !== k2.authKey);
  const a = await E2EE.createIdentity(k1.wrapKey);
  const bWrap = (await E2EE.deriveKeys('bob-test', 'another password', { kdf: 'argon2id', salt: E2EE.newKdfSalt() })).wrapKey;
  const b = await E2EE.createIdentity(bWrap);
  await check('Private key unlocks with the right password', async () => !!(await E2EE.unwrapPrivateKey(k1.wrapKey, a.encPrivateKey)));
  await check('Private key does NOT unlock with a wrong password', () => expectFail(() => E2EE.unwrapPrivateKey(k2.wrapKey, a.encPrivateKey)));
  // Recovery key
  const code = E2EE.newRecoveryCode();
  const rSalt = E2EE.newKdfSalt();
  const recSealed = await E2EE.rewrapPrivateKey(k1.wrapKey, await E2EE.recoveryWrapKey(code, rSalt), a.encPrivateKey);
  await check('Recovery key unlocks the private key', async () => !!(await E2EE.unwrapPrivateKey(await E2EE.recoveryWrapKey(code.toLowerCase().replace(/-/g, ' '), rSalt), recSealed)));
  await check('A wrong recovery key does not', () => expectFail(async () => E2EE.unwrapPrivateKey(await E2EE.recoveryWrapKey(E2EE.newRecoveryCode(), rSalt), recSealed)));
  // Signing keys
  const sa = await E2EE.createSigningKey(a.privateKey, a.publicKey);
  const sb = await E2EE.createSigningKey(b.privateKey, b.publicKey);
  await check('Signatures verify, and fail for changed text or the wrong person', async () => {
    const sig = await E2EE.sign(sa.signKey, 'hello');
    return (await E2EE.verify(sa.signPublicKey, 'hello', sig)) && !(await E2EE.verify(sa.signPublicKey, 'hellO', sig)) && !(await E2EE.verify(sb.signPublicKey, 'hello', sig));
  });
  // Direct messages
  const dm = await E2EE.encryptDm({ myPriv: a.privateKey, theirPub: b.publicKey, dmId: 'dm1', authorId: 'A', payload: { t: 'secret DM' } });
  await check('Direct message: the other person can read it', async () => (await E2EE.decryptDm({ myPriv: b.privateKey, theirPub: a.publicKey, dmId: 'dm1', authorId: 'A', text: dm })).payload.t === 'secret DM');
  const eve = await E2EE.createIdentity((await E2EE.deriveKeys('eve-test', 'eve password', { kdf: 'argon2id', salt: E2EE.newKdfSalt() })).wrapKey);
  await check('Direct message: an outsider can’t', () => expectFail(() => E2EE.decryptDm({ myPriv: eve.privateKey, theirPub: a.publicKey, dmId: 'dm1', authorId: 'A', text: dm })));
  await check('Direct message: a changed byte is refused', () => expectFail(() => E2EE.decryptDm({ myPriv: b.privateKey, theirPub: a.publicKey, dmId: 'dm1', authorId: 'A', text: tamperField(dm, 3) })));
  await check('Direct message: moved to another chat or author is refused', async () =>
    (await expectFail(() => E2EE.decryptDm({ myPriv: b.privateKey, theirPub: a.publicKey, dmId: 'dm2', authorId: 'A', text: dm })))
    && expectFail(() => E2EE.decryptDm({ myPriv: b.privateKey, theirPub: a.publicKey, dmId: 'dm1', authorId: 'B', text: dm })));
  // Server channels
  const raw = E2EE.newGroupKey();
  const wrapped = await E2EE.wrapGroupKey({ raw, serverId: 's1', epoch: 1, recipientId: 'B', recipientPub: b.publicKey, wrapperId: 'A', signKey: sa.signKey });
  await check('Server key handoff: the right member unwraps it', async () => {
    const got = await E2EE.unwrapGroupKey({ wrapped, serverId: 's1', epoch: 1, myId: 'B', myPriv: b.privateKey, wrapperId: 'A', wrapperSignPub: sa.signPublicKey });
    return got.length === 32 && got.every((x, i) => x === raw[i]);
  });
  await check('Server key handoff: refused if not signed by the sender', () => expectFail(() => E2EE.unwrapGroupKey({ wrapped, serverId: 's1', epoch: 1, myId: 'B', myPriv: b.privateKey, wrapperId: 'A', wrapperSignPub: sb.signPublicKey })));
  await check('Server key handoff: nobody else can unwrap it', () => expectFail(() => E2EE.unwrapGroupKey({ wrapped, serverId: 's1', epoch: 1, myId: 'B', myPriv: eve.privateKey, wrapperId: 'A', wrapperSignPub: sa.signPublicKey })));
  const msg = await E2EE.encryptGroup({ raw, serverId: 's1', channelId: 'c1', epoch: 1, authorId: 'A', signKey: sa.signKey, payload: { t: 'channel secret' } });
  await check('Channel message: members read it and the signature checks out', async () => {
    const r = await E2EE.decryptGroup({ raw, serverId: 's1', channelId: 'c1', authorId: 'A', authorSignPub: sa.signPublicKey, text: msg });
    return r.payload.t === 'channel secret' && r.verified;
  });
  await check('Channel message: someone pretending to be the author is caught', async () => {
    const r = await E2EE.decryptGroup({ raw, serverId: 's1', channelId: 'c1', authorId: 'A', authorSignPub: sb.signPublicKey, text: msg });
    return r.verified === false;
  });
  await check('Channel message: a changed byte or another channel is refused', async () =>
    (await expectFail(() => E2EE.decryptGroup({ raw, serverId: 's1', channelId: 'c1', authorId: 'A', authorSignPub: sa.signPublicKey, text: tamperField(msg, 4) })))
    && expectFail(() => E2EE.decryptGroup({ raw, serverId: 's1', channelId: 'c2', authorId: 'A', authorSignPub: sa.signPublicKey, text: msg })));
  await check('Channel message: an old/other server key can’t read it', () => expectFail(() => E2EE.decryptGroup({ raw: E2EE.newGroupKey(), serverId: 's1', channelId: 'c1', authorId: 'A', authorSignPub: sa.signPublicKey, text: msg })));
  // Lengths are hidden
  await check('Message length is hidden (a short and a longer message look the same size)', async () => {
    const x = await E2EE.encryptGroup({ raw, serverId: 's1', channelId: 'c1', epoch: 1, authorId: 'A', signKey: sa.signKey, payload: { t: 'ok' } });
    const y = await E2EE.encryptGroup({ raw, serverId: 's1', channelId: 'c1', epoch: 1, authorId: 'A', signKey: sa.signKey, payload: { t: 'this is a much longer message about something private, with details' } });
    return x.split(':')[4].length === y.split(':')[4].length;
  });
  // Files
  await check('Files: each has its own key; a changed byte is refused', async () => {
    const f = await E2EE.encryptFile(enc.encode('picture bytes').buffer);
    const back = new TextDecoder().decode(await E2EE.decryptFile(f.k, f.blob.buffer));
    const bad = f.blob.slice(); bad[20] ^= 1;
    return back === 'picture bytes' && (await expectFail(() => E2EE.decryptFile(f.k, bad.buffer)));
  });
  return out;
}

// Checks on this account: its keys match what the server publishes, and every server's key is in place.
export async function runAccountChecks({ me, privateKey, signKey, serverKeys }) {
  const out = [];
  const check = async (name, fn) => {
    try { const r = await fn(); out.push({ name, ok: r !== false, detail: typeof r === 'string' ? r : '' }); } catch (e) { out.push({ name, ok: false, detail: e.message }); }
  };
  await check('Your private key matches your public key', async () => {
    const probe = await E2EE.createIdentity((await E2EE.deriveKeys('probe', 'probe-password', { kdf: 'argon2id', salt: E2EE.newKdfSalt() })).wrapKey);
    const text = await E2EE.encryptDm({ myPriv: probe.privateKey, theirPub: me.publicKey, dmId: 'probe', authorId: 'p', payload: { t: 'x' } });
    return (await E2EE.decryptDm({ myPriv: privateKey, theirPub: probe.publicKey, dmId: 'probe', authorId: 'p', text })).payload.t === 'x';
  });
  if (signKey) await check('Your signing key matches the one others check against', async () => E2EE.verify(me.signPublicKey, 'probe', await E2EE.sign(signKey, 'probe')));
  for (const s of serverKeys || []) {
    await check(`Server key for ${s.name}`, () => (s.ok ? true : (s.why || 'missing')));
  }
  return out;
}
