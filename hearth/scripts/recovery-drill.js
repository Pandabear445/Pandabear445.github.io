#!/usr/bin/env node
// Recovery drill: proves, end to end, what each way of getting an account or a whole server back really restores,
// and what it can't. It runs the app's own encryption code (public/js/e2ee.js, secure.js, api.js) in Node against
// throwaway Hearth servers, the way test/crypto-hardening.test.js does, and prints a report.
//
//   cd hearth && node scripts/recovery-drill.js        (needs a checkout with dev dependencies: npm ci)
//
// It never touches a real data folder: every server it starts has its own temporary one. The same steps run in
// the test suite (test/recovery-drill.test.js). What each step shows is explained in docs/RECOVERY.md.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const H = require('../test/helpers');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 50) { if (await fn()) return true; await sleep(50); } return false; };

// A plain HTTP client for one server (the original, or the one restored from a backup).
function client(base) {
  return async (method, p, { token, ip = '198.51.100.9', body, form } = {}) => {
    const headers = { 'x-forwarded-for': ip };
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (form) payload = form; else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + '/api' + p, { method, headers, body: payload });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  };
}

// Starts Hearth on an existing data folder (a restored one) without touching its accounts.
async function startOn(dir) {
  const port = await new Promise((resolve) => { const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'false', NODE_ENV: 'test', MAIL_OUTBOX_DIR: path.join(dir, 'outbox'), PUBLIC_URL: 'https://chat.example.test' };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/config')).ok) break; } catch { /* starting */ }
    if (i > 150 || child.exitCode !== null) throw new Error(`The restored server didn't start:\n${log}`);
    await sleep(100);
  }
  return {
    base, dir, api: client(base), get log() { return log; },
    async stop() { if (child.exitCode === null) { child.kill('SIGTERM'); for (let i = 0; i < 60 && child.exitCode === null; i++) await sleep(50); if (child.exitCode === null) child.kill('SIGKILL'); } },
  };
}

function createDrill() {
  // Browser bits the app's code needs. Trusted keys ("pins") live in localStorage, so each device has its own.
  let store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.window = { crypto: globalThis.crypto, hashwasm: require('hash-wasm') };
  const realFetch = globalThis.fetch;
  let target = null; // the server the app's own fetch('/api/…') calls go to
  let curIp = '198.51.100.9';
  let inflight = 0; // the app's requests still running

  let E; let API; let createSecure;
  let srv; let api; let restored = null;
  const ctx = {}; // what the steps share (people, server, expected plaintexts)
  const unrecoverable = [];
  const tmpDirs = [];

  const as = (u, m, p, body, a = api) => a(m, p, { token: u.token, ip: u.ip, body });
  const PASSWORD = (name, n = 1) => `drill-password-${name}-${n}`;

  // ------------------------------------------------------------------ the app's own steps
  async function uploadSignKey(p, sk, a = api) {
    const ch = (await as(p, 'POST', '/me/sign-key/challenge', undefined, a)).json;
    const keyProof = await E.signKeyProof(p.privateKey, ch.serverPublicKey, ch.nonce, p.id, sk.signPublicKey);
    const signature = await E.sign(sk.signKey, `hearth-sign-key|${p.id}|${p.publicKey}|${ch.nonce}`);
    const r = await as(p, 'POST', '/me/sign-key', { signPublicKey: sk.signPublicKey, encSignPrivateKey: sk.encSignPrivateKey, nonce: ch.nonce, keyProof, signature }, a);
    assert.equal(r.status, 200, r.text);
  }
  // Sign-up as the app does it: Argon2id from the password, a new identity key locked with it, a signing key.
  async function signUp(name) {
    const username = `${name}${H.hex(2)}`;
    const kdfSalt = E.newKdfSalt();
    const { authKey, wrapKey } = await E.deriveKeys(username, PASSWORD(name), { kdf: 'argon2id', salt: kdfSalt });
    const id = await E.createIdentity(wrapKey);
    const ip = H.newIp();
    const r = await api('POST', '/auth/register', { ip, body: { username, authKey, kdfSalt, publicKey: id.publicKey, encPrivateKey: id.encPrivateKey, acceptTos: srv.config.termsVersion || undefined } });
    assert.equal(r.status, 200, r.text);
    const p = { name, username, password: PASSWORD(name), ip, authKey, wrapKey, token: r.json.token, id: r.json.user.id, ...id };
    const sk = await E.createSigningKey(id.privateKey, id.publicKey);
    Object.assign(p, sk);
    await uploadSignKey(p, sk);
    return p;
  }
  // Sign-in as the app does it: the salt from the server, Argon2id, then the password-locked key is opened here.
  async function signIn(p, password, extra = {}, a = api) {
    const ip = H.newIp();
    const params = (await a('GET', `/auth/params?username=${encodeURIComponent(p.username)}`, { ip })).json;
    const k = await E.deriveKeys(p.username, password, params);
    const r = await a('POST', '/auth/login', { ip, body: { username: p.username, authKey: k.authKey, ...extra } });
    if (r.status !== 200) return { status: r.status, code: r.json && r.json.code };
    const privateKey = await E.unwrapPrivateKey(k.wrapKey, r.json.encPrivateKey);
    return { status: 200, session: { ...p, ip, token: r.json.token, authKey: k.authKey, wrapKey: k.wrapKey, privateKey, encPrivateKey: r.json.encPrivateKey, publicKey: r.json.user.publicKey } };
  }
  // The app's code shares one sign-in token (api.js), so background work a device started (storing its own copy
  // of a key, handing the key to a new member) must finish before another device takes over: wait until none of
  // the app's requests are in flight for a moment.
  async function settle() {
    for (let quiet = 0, i = 0; quiet < 3 && i < 400; i++) { quiet = inflight ? 0 : quiet + 1; await sleep(20); }
  }
  // One device: the app's start-up (app.js loadBootstrap), with that device's own trusted keys.
  async function device(user, pins = new Map(), a = api, base = srv.base) {
    await settle();
    store = pins; curIp = user.ip; target = base; API.setToken(user.token);
    const boot = (await as(user, 'GET', '/bootstrap', undefined, a)).json;
    const S = { me: boot.me, users: boot.users, servers: boot.servers, dms: boot.dms, privateKey: user.privateKey, e2eeSince: boot.e2eeSince };
    const sec = createSecure({ S });
    await sec.ensureSigningKey(boot.encSignPrivateKey);
    Object.values(S.users).forEach((u) => sec.trust(u));
    for (const st of Object.values(boot.keyStates || {})) await sec.applyState(st);
    for (const sv of S.servers) await sec.keysSaved(sv.id);
    await settle();
    return { sec, S, pins, user, a, base };
  }
  // Every call the device makes must reach its own server, as itself.
  const use = async (d) => { await settle(); store = d.pins; curIp = d.user.ip; target = d.base; API.setToken(d.user.token); };
  async function sendChannel(d, sid, ch, t, f) {
    await use(d);
    const { ciphertext, epoch } = await d.sec.encryptChannel(sid, ch, { t, ...(f ? { f } : {}) });
    const r = await as(d.user, 'POST', `/channels/${ch}/messages`, { ciphertext, epoch, ...(f ? { files: f.map((x) => x.url) } : {}) }, d.a);
    assert.equal(r.status, 200, r.text);
    return { id: r.json.id, epoch };
  }
  async function sendDm(d, dmId, t) {
    await use(d);
    const ciphertext = await d.sec.encryptDm(dmId, { t });
    const r = await as(d.user, 'POST', `/dms/${dmId}/messages`, { ciphertext }, d.a);
    assert.equal(r.status, 200, r.text);
    return r.json.id;
  }
  // What a device can read: channel texts by epoch, and DM texts; '' when it can't open one.
  async function readChannel(d, ch) {
    await use(d);
    const r = await as(d.user, 'GET', `/channels/${ch}/messages?limit=100`, undefined, d.a);
    assert.equal(r.status, 200, r.text);
    for (const m of r.json.messages) await d.sec.decryptChannelMessage(m);
    return r.json.messages;
  }
  async function readDm(d, dmId) {
    await use(d);
    const r = await as(d.user, 'GET', `/dms/${dmId}/messages?limit=100`, undefined, d.a);
    assert.equal(r.status, 200, r.text);
    for (const m of r.json.messages) await d.sec.decryptDmMessage(m);
    return r.json.messages;
  }
  const texts = (msgs) => msgs.filter((m) => m.dec && m.dec.t).map((m) => m.dec.t).sort();
  const sorted = (a) => [...a].sort();
  async function resetLink(p) {
    const n = srv.mails().length;
    const r = await api('POST', '/auth/forgot', { ip: H.newIp(), body: { login: p.username } });
    assert.equal(r.status, 200);
    const m = srv.mails().slice(n).find((x) => x.to === p.email && /reset your password/.test(x.subject));
    assert.ok(m, 'the reset email arrived');
    return H.resetTokenFrom(m);
  }
  const cli = (args, env = {}) => spawnSync(process.execPath, ['server/cli.js', ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });

  // ------------------------------------------------------------------ the steps
  const steps = [
    {
      id: 'setup',
      title: 'Accounts A, B, C with real keys; A has a recovery key, B has 2FA; an encrypted server, DMs and an attachment',
      async run() {
        const A = await signUp('alice'); const B = await signUp('bob'); const C = await signUp('carol');
        for (const p of [A, C]) { p.email = `${p.username}@example.test`; await H.confirmEmail(srv, p, p.email); }
        // A's recovery key: a second copy of her identity key, locked with a code only she keeps.
        A.recoveryCode = E.newRecoveryCode();
        A.recoverySalt = E.newKdfSalt();
        const encRec = await E.rewrapPrivateKey(A.wrapKey, await E.recoveryWrapKey(A.recoveryCode, A.recoverySalt), A.encPrivateKey);
        assert.equal((await as(A, 'PUT', '/me/recovery', { authKey: A.authKey, encPrivateKeyRecovery: encRec, recoverySalt: A.recoverySalt })).status, 200);
        B.twofa = await H.enable2fa(srv, B);
        // The server, with C and B in it. A's app makes the first key (epoch 1), the others get it from her.
        const s = (await as(A, 'POST', '/servers', { name: 'drill' })).json;
        const code = (await as(A, 'POST', `/servers/${s.id}/invites`, {})).json.code;
        for (const u of [B, C]) assert.equal((await as(u, 'POST', `/invites/${code}/join`, {})).status, 200);
        const ch = s.channels.find((c) => c.type === 'text').id;
        Object.assign(ctx, { A, B, C, sid: s.id, ch, code, pins: { A: new Map(), B: new Map(), C: new Map() } });
        let dA = await device(A, ctx.pins.A);
        const sent = { 1: [], 2: [] };
        sent[1].push('A: hello, epoch 1'); await sendChannel(dA, s.id, ch, sent[1][0]);
        const dB = await device(B, ctx.pins.B); const dC = await device(C, ctx.pins.C);
        sent[1].push('B: hi, epoch 1'); await sendChannel(dB, s.id, ch, sent[1][1]);
        sent[1].push('C: hey, epoch 1'); await sendChannel(dC, s.id, ch, sent[1][2]);
        // The owner replaces the key once (as after someone leaves), so there's history in two epochs.
        await use(dA); await dA.sec.forceRotate(s.id);
        dA = await device(A, ctx.pins.A);
        sent[2].push('A: epoch 2 begins'); await sendChannel(dA, s.id, ch, sent[2][0]);
        // An attachment: encrypted on A's device with its own key, which travels inside the message.
        ctx.fileBytes = crypto.randomBytes(48 * 1024);
        const ef = await E.encryptFile(ctx.fileBytes);
        const fd = new FormData(); fd.append('file', new Blob([ef.blob]), 'blob.bin');
        const up = await api('POST', '/upload/encrypted', { token: A.token, ip: A.ip, form: fd });
        assert.equal(up.status, 200, up.text);
        ctx.file = { url: up.json.url, name: path.basename(up.json.url), k: ef.k };
        sent[2].push('A: the report is attached');
        await sendChannel(dA, s.id, ch, sent[2][1], [{ url: up.json.url, k: ef.k, name: 'report.pdf', type: 'application/pdf', size: ctx.fileBytes.length }]);
        ctx.sent = sent;
        // DMs: A↔B and A↔C, both ways.
        ctx.dmAB = (await as(A, 'POST', '/dms', { userId: B.id })).json.id;
        ctx.dmAC = (await as(A, 'POST', '/dms', { userId: C.id })).json.id;
        dA = await device(A, ctx.pins.A);
        const dB2 = await device(B, ctx.pins.B); const dC2 = await device(C, ctx.pins.C);
        ctx.dmTexts = { AB: ['A→B: our secret', 'B→A: safe with me'], AC: ['A→C: before your reset', 'C→A: noted'] };
        await sendDm(dA, ctx.dmAB, ctx.dmTexts.AB[0]); await sendDm(dB2, ctx.dmAB, ctx.dmTexts.AB[1]);
        await sendDm(dA, ctx.dmAC, ctx.dmTexts.AC[0]); await sendDm(dC2, ctx.dmAC, ctx.dmTexts.AC[1]);
        // Everyone reads everything.
        for (const d of [dA, dB2, dC2]) assert.deepEqual(texts(await readChannel(d, ch)), sorted([...sent[1], ...sent[2]]));
        assert.deepEqual(texts(await readDm(dA, ctx.dmAB)), sorted(ctx.dmTexts.AB));
        assert.deepEqual(texts(await readDm(dC2, ctx.dmAC)), sorted(ctx.dmTexts.AC));
        ctx.dC = dC2; // C's device, holding the current key (used in the removal step)
        return [`3 accounts, server key epochs 1-2, ${sent[1].length + sent[2].length} channel messages, 4 DMs, a ${ctx.fileBytes.length / 1024} KB encrypted attachment`, 'A has a recovery key; B has two-factor with 10 backup codes'];
      },
    },
    {
      id: 'password-change',
      title: 'A changes her password: other sessions end, her keys still open everything, the old password fails',
      async run() {
        const { A } = ctx;
        const other = (await signIn(A, A.password)).session;
        const sock = await srv.socket(other.token);
        // The app: new salt, new Argon2id keys, the same identity key locked again with the new one.
        const salt = E.newKdfSalt();
        const k = await E.deriveKeys(A.username, PASSWORD('alice', 2), { kdf: 'argon2id', salt });
        const enc = await E.rewrapPrivateKey(A.wrapKey, k.wrapKey, A.encPrivateKey);
        const r = await as(A, 'POST', '/me/password', { oldAuthKey: A.authKey, newAuthKey: k.authKey, encPrivateKey: enc, salt });
        assert.equal(r.status, 200, r.text);
        assert.equal((await as(other, 'GET', '/bootstrap')).status, 401, 'the other session ended');
        assert.ok(await until(() => sock.disconnected), 'its live connection was cut');
        sock.close();
        assert.equal((await as(A, 'GET', '/bootstrap')).status, 200, 'this session stays');
        const old = await signIn(A, A.password);
        assert.equal(old.status, 401, 'the old password is refused');
        A.password = PASSWORD('alice', 2);
        const fresh = await signIn(A, A.password);
        assert.equal(fresh.status, 200);
        Object.assign(A, { token: fresh.session.token, ip: fresh.session.ip, authKey: fresh.session.authKey, wrapKey: fresh.session.wrapKey, encPrivateKey: fresh.session.encPrivateKey, privateKey: fresh.session.privateKey });
        assert.ok(await E.unwrapPrivateKey(A.wrapKey, enc), 'the identity key opens with the new password');
        await assert.rejects(E.unwrapPrivateKey((await E.deriveKeys(A.username, PASSWORD('alice', 1), { kdf: 'argon2id', salt })).wrapKey, enc), 'and not with the old one');
        const d = await device(A, new Map());
        assert.deepEqual(texts(await readChannel(d, ctx.ch)), sorted([...ctx.sent[1], ...ctx.sent[2]]));
        assert.deepEqual(texts(await readDm(d, ctx.dmAB)), sorted(ctx.dmTexts.AB));
        return ['other session: 401, live connection closed', 'old password: 401', 'new password on a new device: all channel history and DMs open'];
      },
    },
    {
      id: 'reset-with-recovery',
      title: 'A forgets her password and resets it WITH her recovery key: same identity, all history readable',
      async run() {
        const { A } = ctx;
        const before = (await as(ctx.B, 'GET', `/users/${A.id}`)).json;
        const tok = await resetLink(A);
        const info = (await api('POST', '/auth/reset/info', { ip: H.newIp(), body: { token: tok } })).json;
        assert.equal(info.hasRecovery, true);
        // The app: open the recovery copy with the code, prove it holds the key, lock it with the new password.
        const rWrap = await E.recoveryWrapKey(A.recoveryCode, info.recoverySalt);
        const priv = await E.unwrapPrivateKey(rWrap, info.encPrivateKeyRecovery);
        await assert.rejects(E.unwrapPrivateKey(await E.recoveryWrapKey(E.newRecoveryCode(), info.recoverySalt), info.encPrivateKeyRecovery), 'a wrong recovery key opens nothing');
        const keyProof = await E.resetKeyProof(priv, info.keyChallenge.serverPublicKey, info.keyChallenge.nonce, A.id);
        const kdfSalt = E.newKdfSalt();
        A.password = PASSWORD('alice', 3);
        const k = await E.deriveKeys(A.username, A.password, { kdf: 'argon2id', salt: kdfSalt });
        const encPrivateKey = await E.rewrapPrivateKey(rWrap, k.wrapKey, info.encPrivateKeyRecovery);
        const oldToken = A.token;
        const r = await api('POST', '/auth/reset', { ip: H.newIp(), body: { token: tok, authKey: k.authKey, kdfSalt, encPrivateKey, keepKeys: true, keyProof } });
        assert.equal(r.status, 200, r.text);
        assert.equal((await api('GET', '/bootstrap', { token: oldToken, ip: A.ip })).status, 401, 'every earlier session ended');
        const after = (await as(ctx.B, 'GET', `/users/${A.id}`)).json;
        assert.equal(after.publicKey, before.publicKey, 'same identity key');
        assert.equal(after.signPublicKey, before.signPublicKey, 'same signing key');
        const s = await signIn(A, A.password);
        assert.equal(s.status, 200);
        Object.assign(A, { token: s.session.token, ip: s.session.ip, authKey: s.session.authKey, wrapKey: s.session.wrapKey, encPrivateKey: s.session.encPrivateKey, privateKey: s.session.privateKey });
        // Contacts' devices see no key change: nothing to verify again.
        const dB = await device(ctx.B, ctx.pins.B);
        assert.equal(dB.sec.keyChanged(dB.S.users[A.id]), false);
        const d = await device(A, new Map());
        const msgs = await readChannel(d, ctx.ch);
        assert.deepEqual(texts(msgs), sorted([...ctx.sent[1], ...ctx.sent[2]]));
        assert.ok(msgs.every((m) => m.dec.verified), 'every post still verifies');
        assert.deepEqual(texts(await readDm(d, ctx.dmAB)), sorted(ctx.dmTexts.AB));
        assert.deepEqual(texts(await readDm(d, ctx.dmAC)), sorted(ctx.dmTexts.AC));
        ctx.pins.A = new Map(d.pins); // her phone after the reset
        return ['wrong recovery key: refused locally', 'same public and signing keys; contacts see no key change', 'all channel epochs and all DMs readable on a new device'];
      },
    },
    {
      id: 'reset-without-recovery',
      title: 'C forgets her password and has no recovery key: new keys, old DMs unreadable, "key changed" shown',
      async run() {
        const { A, C, sid, ch } = ctx;
        const old = { publicKey: C.publicKey, encPrivateKey: C.encPrivateKey, wrapKey: C.wrapKey };
        const dA = await device(A, ctx.pins.A);
        assert.equal(dA.sec.keyChanged(dA.S.users[C.id]), false);
        const tok = await resetLink(C);
        const info = (await api('POST', '/auth/reset/info', { ip: H.newIp(), body: { token: tok } })).json;
        assert.equal(info.hasRecovery, false);
        // No way to keep the keys: the server refuses keepKeys without a recovery copy.
        const kdfSalt = E.newKdfSalt();
        C.password = PASSWORD('carol', 2);
        const k = await E.deriveKeys(C.username, C.password, { kdf: 'argon2id', salt: kdfSalt });
        const ident = await E.createIdentity(k.wrapKey);
        const refused = await api('POST', '/auth/reset', { ip: H.newIp(), body: { token: tok, authKey: k.authKey, kdfSalt, encPrivateKey: old.encPrivateKey, keepKeys: true } });
        assert.equal(refused.status, 400);
        const r = await api('POST', '/auth/reset', { ip: H.newIp(), body: { token: tok, authKey: k.authKey, kdfSalt, encPrivateKey: ident.encPrivateKey, publicKey: ident.publicKey } });
        assert.equal(r.status, 200, r.text);
        Object.assign(C, { token: r.json.token, ip: H.newIp(), authKey: k.authKey, wrapKey: k.wrapKey, ...ident });
        const sk = await E.createSigningKey(ident.privateKey, ident.publicKey);
        Object.assign(C, sk);
        await uploadSignKey(C, sk);
        ctx.oldC = old;
        // C's new device: her old DMs (both directions) can't be opened. Nothing on the server can open them.
        const dC = await device(C, new Map());
        const dms = await readDm(dC, ctx.dmAC);
        assert.equal(dms.length, 2);
        assert.ok(dms.every((m) => m.dec.error), 'old DMs are unreadable for C (expected: their key is gone)');
        // A's device: "security key changed"; sending to C waits until A checks the safety number.
        const dA2 = await device(A, ctx.pins.A);
        assert.equal(dA2.sec.keyChanged(dA2.S.users[C.id]), true, 'A sees "key changed"');
        await use(dA2);
        await assert.rejects(dA2.sec.encryptDm(ctx.dmAC, { t: 'x' }), (e) => e.code === 'untrusted');
        // A still reads both sides of the old conversation (her own key, plus C's old public key she trusted).
        const mine = await readDm(dA2, ctx.dmAC);
        assert.deepEqual(texts(mine), sorted(ctx.dmTexts.AC));
        // Group history: C's key copies were deleted with her old keys. Nobody hands her the current key until a
        // member's app trusts her new key (A checks the safety number and accepts it).
        const held0 = srv.sql('SELECT epoch FROM server_keys WHERE server_id = ? AND user_id = ?', sid, C.id);
        assert.deepEqual(held0, [], 'no server keys for C right after the reset');
        dA2.sec.acceptKeys(dA2.S.users[C.id]);
        await use(dA2); dA2.sec.maintain(sid);
        assert.ok(await until(() => srv.sql('SELECT 1 FROM server_keys WHERE server_id = ? AND user_id = ?', sid, C.id).length), 'A’s app re-shared the current key with C');
        const dC2 = await device(C, new Map());
        assert.deepEqual(dC2.sec.heldEpochs(sid), [2], 'only the current epoch comes back');
        const msgs = await readChannel(dC2, ch);
        assert.deepEqual(texts(msgs), sorted(ctx.sent[2]), 'C reads the current epoch (including what was said before her reset)…');
        assert.ok(msgs.filter((m) => m.epoch === 1).every((m) => m.dec.pending && !m.dec.t), '…but not older epochs');
        await sendDm(dA2, ctx.dmAC, 'A→C: after your reset');
        const dC3 = await device(C, new Map());
        assert.deepEqual(texts(await readDm(dC3, ctx.dmAC)), ['A→C: after your reset'], 'new DMs work again');
        ctx.dC = dC3;
        ctx.cOldDmsUnreadable = dms.length;
        return ['keepKeys without a recovery key: refused (400)', `C's ${dms.length} old DMs: unreadable on her side (expected), still readable on A's side`,
          'A sees "security key changed"; DMs to C wait for verification', 'after A verifies: C gets the current server key (epoch 2) back, not epoch 1'];
      },
    },
    {
      id: 'lost-2fa',
      title: 'B loses his authenticator: a backup code works once; reused it fails',
      async run() {
        const { B } = ctx;
        const code = B.twofa.backupCodes[0];
        assert.equal((await signIn(B, B.password)).code, 'need_2fa', 'the password alone isn’t enough');
        const first = await signIn(B, B.password, { backupCode: code });
        assert.equal(first.status, 200);
        assert.equal((await signIn(B, B.password, { backupCode: code })).status, 401, 'the same code again fails');
        assert.equal((await signIn(B, B.password, { backupCode: 'abcd-efgh' })).status, 401, 'a made-up code fails');
        const d = await device(first.session, new Map());
        assert.deepEqual(texts(await readChannel(d, ctx.ch)), sorted([...ctx.sent[1], ...ctx.sent[2]]), 'his keys are untouched by losing the second factor');
        Object.assign(B, { token: first.session.token, ip: first.session.ip });
        return ['password only: needs a code', 'backup code: 200 once, then 401', 'B’s history: readable (2FA has nothing to do with encryption keys)'];
      },
    },
    {
      id: 'revoke-device',
      title: 'B revokes a lost device: its token and live connection die, and it can’t reconnect',
      async run() {
        const { B } = ctx;
        const ids = async () => (await as(B, 'GET', '/me/sessions')).json.active.map((x) => x.id);
        const was = await ids();
        const lost = (await signIn(B, B.password, { backupCode: B.twofa.backupCodes[1] })).session;
        const sock = await srv.socket(lost.token);
        let revoked = null;
        sock.on('session:revoked', (p) => { revoked = p; });
        const added = (await ids()).filter((id) => !was.includes(id));
        assert.equal(added.length, 1, 'the lost device is listed');
        assert.equal((await as(B, 'DELETE', `/me/sessions/${added[0]}`)).status, 200);
        assert.equal((await as(lost, 'GET', '/bootstrap')).status, 401, 'its token is dead');
        assert.ok(await until(() => sock.disconnected), 'its live connection was cut');
        assert.equal(revoked && revoked.reason, 'revoked');
        sock.close();
        await assert.rejects(srv.socket(lost.token), /unauthorized/i, 'it can’t reconnect');
        assert.equal((await as(B, 'GET', '/bootstrap')).status, 200, 'B’s own session is fine');
        ctx.revokedToken = lost.token;
        return ['revoked token: 401', 'socket: disconnected with "revoked", reconnect refused'];
      },
    },
    {
      id: 'removal-rotation',
      title: 'C is removed and the key rotates: she can’t read anything sent after, and keeps what she had',
      async run() {
        const { A, C, sid, ch } = ctx;
        const dC = ctx.dC;
        await use(dC);
        const had = dC.sec.currentKey(sid);
        assert.equal(had.epoch, 2);
        assert.equal((await as(A, 'DELETE', `/servers/${sid}/members/${C.id}`)).status, 200);
        assert.equal(srv.sql('SELECT needs_rotation FROM servers WHERE id = ?', sid)[0].needs_rotation, 1, 'removal asks for a new key');
        // A's app makes epoch 3, wrapped only for those still in the server.
        const dA = await device(A, ctx.pins.A);
        await sendChannel(dA, sid, ch, 'A: after C left (epoch 3)');
        const e3 = srv.sql('SELECT user_id FROM server_keys WHERE server_id = ? AND epoch = 3', sid).map((r) => r.user_id);
        assert.ok(!e3.includes(C.id), 'nobody wrapped epoch 3 for C');
        // The server no longer shows her the channel at all.
        assert.ok([403, 404].includes((await as(C, 'GET', `/channels/${ch}/messages`)).status));
        // Even with the ciphertext (a leaked database, say), her keys don't open epoch 3, and do open epoch 2.
        const rows = srv.sql('SELECT author_id, ciphertext, epoch FROM messages WHERE channel_id = ? AND ciphertext IS NOT NULL ORDER BY id', ch);
        const open = (row, raw) => E.decryptGroup({ raw, serverId: sid, channelId: ch, authorId: row.author_id, authorSignPub: [], text: row.ciphertext }).then((x) => x.payload.t, () => null);
        const after = rows.filter((r) => r.epoch === 3);
        const before = rows.filter((r) => r.epoch === 2);
        for (const row of after) assert.equal(await open(row, had.raw), null, 'epoch 3 stays closed to C');
        const kept = (await Promise.all(before.map((row) => open(row, had.raw)))).filter(Boolean).sort();
        assert.deepEqual(kept, sorted(ctx.sent[2]), 'what she had, she keeps: removal is not retroactive');
        ctx.sent[3] = ['A: after C left (epoch 3)'];
        return ['C: 403/404 on the channel; no epoch-3 key wrapped for her', `with leaked ciphertext: 0/${after.length} epoch-3 messages open, ${kept.length}/${before.length} epoch-2 messages still open (not retroactive)`];
      },
    },
    {
      id: 'new-device',
      title: 'New devices after history exists: they read what their keys allow',
      async run() {
        const { B, sid, ch, code } = ctx;
        // B on a brand-new phone (no trusted keys yet), signing in with a backup code.
        const s = (await signIn(B, B.password, { backupCode: B.twofa.backupCodes[2] })).session;
        const d = await device(s, new Map());
        assert.deepEqual(sorted(d.sec.heldEpochs(sid)), [1, 2, 3]);
        assert.deepEqual(texts(await readChannel(d, ch)), sorted([...ctx.sent[1], ...ctx.sent[2], ...ctx.sent[3]]));
        assert.deepEqual(texts(await readDm(d, ctx.dmAB)), sorted(ctx.dmTexts.AB));
        // A new member: gets the current key only. Joining isn't a key change, so what was said in the current
        // epoch before she joined is readable to her; older epochs are not.
        const D = await signUp('dave');
        assert.equal((await as(D, 'POST', `/invites/${code}/join`, {})).status, 200);
        await device(ctx.A, ctx.pins.A); // A's app hands her the current key
        assert.ok(await until(() => srv.sql('SELECT 1 FROM server_keys WHERE server_id = ? AND user_id = ?', sid, D.id).length));
        const dD = await device(D, new Map());
        assert.deepEqual(dD.sec.heldEpochs(sid), [3]);
        const msgs = await readChannel(dD, ch);
        assert.deepEqual(texts(msgs), sorted(ctx.sent[3]));
        assert.ok(msgs.filter((m) => m.epoch < 3).every((m) => m.dec.pending));
        ctx.D = D;
        return ['B’s new phone: epochs 1-3 and his DMs readable', 'new member D: only epoch 3 (including messages from before she joined); epochs 1-2 not'];
      },
    },
    {
      id: 'backup-restore',
      title: 'Encrypted backup, restored with the CLI into a clean folder, started, and checked',
      async run() {
        const { A, B, C, D, sid, ch } = ctx;
        const env = { DATA_DIR: srv.dir };
        const b = cli(['backup'], env);
        assert.equal(b.status, 0, b.stderr);
        const file = path.join(srv.dir, 'backups', 'encrypted', fs.readdirSync(path.join(srv.dir, 'backups', 'encrypted')).filter((f) => f.endsWith('.hbk')).sort().pop());
        const key = fs.readFileSync(path.join(srv.dir, 'backup.key'), 'utf8').trim();
        const after = (await signIn(A, A.password)).session; // a session made after the backup: not in it
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-drill-restored-')); tmpDirs.push(dir);
        const rs = cli(['restore', file, path.join(dir, 'data'), key]);
        assert.equal(rs.status, 0, rs.stderr);
        restored = await startOn(path.join(dir, 'data'));
        const ra = restored.api;
        // The same people sign in (B with a backup code: his 2FA secret came back with secret.key).
        const a = await signIn(A, A.password, {}, ra);
        assert.equal(a.status, 200);
        const bIn = await signIn(B, B.password, { backupCode: B.twofa.backupCodes[3] }, ra);
        assert.equal(bIn.status, 200);
        assert.equal((await signIn(C, C.password, {}, ra)).status, 200);
        assert.equal(a.session.publicKey, A.publicKey, 'same keys');
        // Messages open with the same keys, on a device that has never seen this server.
        const dA = await device(a.session, new Map(), ra, restored.base);
        const msgs = await readChannel(dA, ch);
        assert.deepEqual(texts(msgs), sorted([...ctx.sent[1], ...ctx.sent[2], ...ctx.sent[3]]));
        // Every signature checks out, except C's post from before her reset: a device that never knew her old key
        // only has the server's word for it, so it's shown as "older key, not verified" (as on the original server).
        assert.ok(msgs.filter((m) => m.authorId !== C.id).every((m) => m.dec.verified), 'every other signature checks out');
        assert.deepEqual(msgs.filter((m) => m.authorId === C.id).map((m) => [m.dec.verified, m.dec.keyNote]), [[false, 'listed']]);
        assert.deepEqual(texts(await readDm(dA, ctx.dmAB)), sorted(ctx.dmTexts.AB));
        // The attachment: present, byte-for-byte the same, and it decrypts to the original.
        const orig = fs.readFileSync(path.join(srv.dir, 'uploads', ctx.file.name));
        const copy = fs.readFileSync(path.join(dir, 'data', 'uploads', ctx.file.name));
        assert.ok(orig.equals(copy), 'the file on disk is byte-equal');
        const served = Buffer.from(await (await fetch(restored.base + ctx.file.url)).arrayBuffer());
        assert.ok(served.equals(orig), 'and served unchanged');
        const withFile = msgs.find((m) => m.dec.f && m.dec.f.length);
        const plain = Buffer.from(await dA.sec.decryptAttachment(withFile, withFile.dec.f[0], served));
        assert.ok(plain.equals(ctx.fileBytes), 'and decrypts to the original');
        // Sessions: as they were at backup time.
        assert.equal((await ra('GET', '/bootstrap', { token: A.token, ip: A.ip })).status, 200, 'a session live at backup time still works');
        assert.equal((await ra('GET', '/bootstrap', { token: ctx.revokedToken, ip: B.ip })).status, 401, 'a session revoked before the backup stays revoked');
        assert.equal((await ra('GET', '/bootstrap', { token: after.token, ip: after.ip })).status, 401, 'a session made after the backup doesn’t exist there');
        // The audit log verifies (a new anchor is started, and the log says so).
        const owner = srv.owner;
        const v = (await ra('GET', '/admin/log/verify', { token: owner.token, ip: owner.ip })).json;
        assert.equal(v.ok, true, JSON.stringify(v));
        assert.ok(v.gaps.some((g) => g.action === 'audit_anchor_reset'), 'the restore is visible in the log');
        // Still nobody reads anyone else's messages.
        for (const [u, p] of [[C, `/dms/${ctx.dmAB}/messages`], [D, `/dms/${ctx.dmAB}/messages`], [C, `/channels/${ch}/messages`]]) {
          const st = (await ra('GET', p, { token: u.token, ip: u.ip })).status;
          assert.ok([403, 404].includes(st), `${u.name} ${p}: ${st}`);
        }
        assert.equal((await ra('GET', `/servers/${sid}/keys`, { token: C.token, ip: C.ip })).status >= 400, true);
        // --sign-out-everyone (after a break-in): no earlier session works; passwords do.
        const rs2 = cli(['restore', file, path.join(dir, 'data2'), key, '--sign-out-everyone']);
        assert.equal(rs2.status, 0, rs2.stderr);
        await restored.stop();
        restored = await startOn(path.join(dir, 'data2'));
        assert.equal((await restored.api('GET', '/bootstrap', { token: A.token, ip: A.ip })).status, 401);
        assert.equal((await signIn(A, A.password, {}, restored.api)).status, 200);
        await restored.stop(); restored = null;
        target = srv.base;
        return [`backup: ${(fs.statSync(file).size / 1024).toFixed(0)} KB, restored with the CLI into an empty folder`,
          'A, B (backup code) and C sign in; same public keys', `${msgs.length} channel messages and the DMs decrypt on a brand-new device; all signatures verify except C's pre-reset post (shown as "older key, not verified", as before the backup)`,
          'attachment: byte-equal on disk and over HTTP, decrypts to the original', 'sessions: live-at-backup work, revoked-before stay revoked, made-after don’t exist; --sign-out-everyone ends them all',
          `audit log: verifies (${v.entries} entries, anchor restarted and logged)`, 'C and D: 403/404 on the A-B DM and the channel'];
      },
    },
    {
      id: 'unrecoverable',
      title: 'Cases nothing can recover (checked, so the report states them as facts)',
      async run() {
        // 1. A lost password with no recovery key: C's old private key is locked with a password nobody has.
        const guess = await E.deriveKeys(ctx.C.username, 'a guess', { kdf: 'argon2id', salt: E.newKdfSalt() });
        await assert.rejects(E.unwrapPrivateKey(guess.wrapKey, ctx.oldC.encPrivateKey));
        assert.equal(srv.sql('SELECT COUNT(*) n FROM users WHERE enc_private_key = ?', ctx.oldC.encPrivateKey)[0].n, 0, 'and the server dropped even that locked copy at the reset');
        unrecoverable.push({ case: 'Lost password, no recovery key', what: `C's ${ctx.cOldDmsUnreadable} old DMs and server-key epochs older than the current one stay unreadable to C forever. The people she wrote to still read their copies. Her account itself came back (email reset).` });
        // 2. A lost backup key: the backup file is useless.
        const file = path.join(srv.dir, 'backups', 'encrypted', fs.readdirSync(path.join(srv.dir, 'backups', 'encrypted')).filter((f) => f.endsWith('.hbk')).sort().pop());
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-drill-nokey-')); tmpDirs.push(dir);
        const r = cli(['restore', file, path.join(dir, 'data'), H.hex(32)]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /Wrong backup key/);
        assert.deepEqual(fs.readdirSync(path.join(dir, 'data')), ['RESTORE-INCOMPLETE'], 'nothing usable is left behind');
        unrecoverable.push({ case: 'Lost backup key', what: 'The .hbk file can’t be opened by anyone, including the owner. Only a backup made with a key you still have can be restored.' });
        return unrecoverable.map((u) => `${u.case}: confirmed`);
      },
    },
  ];

  return {
    steps, unrecoverable,
    async setup() {
      const js = (f) => pathToFileURL(path.join(ROOT, 'public', 'js', f)).href;
      srv = await H.startServer();
      api = client(srv.base);
      target = srv.base;
      globalThis.fetch = (url, opts = {}) => {
        if (!String(url).startsWith('/')) return realFetch(url, opts);
        inflight++;
        return realFetch(target + url, { ...opts, headers: { ...(opts.headers || {}), 'x-forwarded-for': curIp } }).finally(() => { inflight--; });
      };
      E = await import(js('e2ee.js'));
      API = await import(js('api.js'));
      ({ createSecure } = await import(js('secure.js')));
    },
    async teardown() {
      globalThis.fetch = realFetch;
      if (restored) await restored.stop();
      if (srv) await srv.stop();
      for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ standalone report
async function main() {
  const drill = createDrill();
  const started = Date.now();
  const lines = [`Hearth recovery drill, ${new Date().toISOString()}`, ''];
  let passed = 0;
  try {
    await drill.setup();
    for (const [i, s] of drill.steps.entries()) {
      const t = Date.now();
      try {
        const facts = await s.run();
        passed++;
        lines.push(`PASS  ${i + 1}. ${s.title}  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
        for (const f of facts || []) lines.push(`        - ${f}`);
      } catch (e) {
        lines.push(`FAIL  ${i + 1}. ${s.title}`, `        ${String(e && e.message).split('\n').join('\n        ')}`);
        lines.push('      (later steps build on this one, so the drill stopped here)');
        break;
      }
    }
  } finally { await drill.teardown(); }
  lines.push('', 'Unrecoverable by design (each one checked above):');
  if (!drill.unrecoverable.length) lines.push('  (not reached)');
  for (const u of drill.unrecoverable) lines.push(`  UNRECOVERABLE  ${u.case}: ${u.what}`);
  const ok = passed === drill.steps.length;
  lines.push('', `${passed} of ${drill.steps.length} steps passed in ${((Date.now() - started) / 1000).toFixed(0)} s.${ok ? '' : ' THE DRILL FAILED.'}`);
  console.log(lines.join('\n'));
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });

module.exports = { createDrill };
