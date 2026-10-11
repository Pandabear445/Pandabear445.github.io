// crypto-2: a password reset without the recovery key gives an account new keys from an email link alone, so whoever
// got into the inbox could do it. Those keys are held back from every server and group (no app shares a key with them,
// and the server keeps none handed to them) until a member who knew the person before compares safety numbers and
// vouches for them, or an instance admin does. Meanwhile the account can't bring a second account of its own in.
// Uses the app's real client code (public/js/e2ee.js, secure.js, api.js) in Node against a real server, as
// crypto-hardening.test.js does: a "device" is the app's start-up path with its own pins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./helpers');

let store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { crypto: globalThis.crypto, hashwasm: require('hash-wasm') };

let srv; let E; let API; let SEC;
let curIp = '198.51.100.9';
const realFetch = globalThis.fetch;
const sent = []; // [method, path] of every request the app code made
// Requests that hand a key to someone (sharing it, or making a new one for everyone); keys/self is the app keeping its own copy.
const handedOut = () => sent.filter(([m, p]) => m === 'POST' && /\/keys\/(share|rotate)$/.test(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;

before(async () => {
  srv = await H.startServer();
  globalThis.fetch = (url, opts = {}) => {
    if (!String(url).startsWith('/')) return realFetch(url, opts);
    sent.push([opts.method || 'GET', String(url)]);
    return realFetch(srv.base + url, { ...opts, headers: { ...(opts.headers || {}), 'x-forwarded-for': curIp } });
  };
  E = await import(js('e2ee.js'));
  API = await import(js('api.js'));
  SEC = await import(js('secure.js'));
});
after(async () => { globalThis.fetch = realFetch; await srv.stop(); });

const as = (u, m, p, body) => srv.api(m, p, { token: u.token, ip: u.ip, body });
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 50) { if (await fn()) return true; await sleep(50); } return false; };
const uname = (base) => `${base}${H.hex(3)}`;

async function uploadSignKey(p, sk) {
  const ch = (await as(p, 'POST', '/me/sign-key/challenge')).json;
  const keyProof = await E.signKeyProof(p.privateKey, ch.serverPublicKey, ch.nonce, p.id, sk.signPublicKey);
  const signature = await E.sign(sk.signKey, `hearth-sign-key|${p.id}|${p.publicKey}|${ch.nonce}`);
  return as(p, 'POST', '/me/sign-key', { signPublicKey: sk.signPublicKey, encSignPrivateKey: sk.encSignPrivateKey, nonce: ch.nonce, keyProof, signature });
}
async function person(name) {
  const kdfSalt = E.newKdfSalt();
  const { authKey, wrapKey } = await E.deriveKeys(name, `pw-${name}`, { kdf: 'argon2id', salt: kdfSalt });
  const id = await E.createIdentity(wrapKey);
  const ip = H.newIp();
  const r = await srv.api('POST', '/auth/register', { ip, body: { username: name, authKey, kdfSalt, publicKey: id.publicKey, encPrivateKey: id.encPrivateKey, acceptTos: srv.config.termsVersion || undefined } });
  assert.equal(r.status, 200, r.text);
  const p = { username: name, ip, authKey, wrapKey, kdfSalt, token: r.json.token, id: r.json.user.id, ...id };
  const sk = await E.createSigningKey(id.privateKey, id.publicKey);
  Object.assign(p, sk);
  assert.equal((await uploadSignKey(p, sk)).status, 200);
  return p;
}
async function serverWith(owner, others) {
  const s = (await as(owner, 'POST', '/servers', { name: 'keys' })).json;
  const code = (await as(owner, 'POST', `/servers/${s.id}/invites`, {})).json.code;
  for (const u of others) assert.equal((await as(u, 'POST', `/invites/${code}/join`, {})).status, 200);
  return { s, code, ch: s.channels.find((c) => c.type === 'text').id };
}
async function rotate(by, serverId, epoch, members) {
  const raw = E.newGroupKey();
  const wraps = {}; const pubs = {};
  for (const u of members) {
    wraps[u.id] = await E.wrapGroupKey({ raw, serverId, epoch, recipientId: u.id, recipientPub: u.publicKey, wrapperId: by.id, signKey: by.signKey });
    pubs[u.id] = u.publicKey;
  }
  const r = await as(by, 'POST', `/servers/${serverId}/keys/rotate`, { epoch, check: await E.keyCheck(raw, serverId, epoch), wraps, pubs });
  return { r, raw };
}
const wrapTo = (by, serverId, epoch, raw, u) => E.wrapGroupKey({ raw, serverId, epoch, recipientId: u.id, recipientPub: u.publicKey, wrapperId: by.id, signKey: by.signKey });
async function send(u, sid, ch, epoch, raw, t) {
  const ciphertext = await E.encryptGroup({ raw, serverId: sid, channelId: ch, epoch, authorId: u.id, signKey: u.signKey, payload: { t } });
  const r = await as(u, 'POST', `/channels/${ch}/messages`, { ciphertext, epoch });
  assert.equal(r.status, 200, r.text);
}
// The app's start-up on one device (app.js loadBootstrap), with that device's pins.
async function device(user, pins = new Map()) {
  store = pins; curIp = user.ip; API.setToken(user.token);
  const boot = (await as(user, 'GET', '/bootstrap')).json;
  const S = { me: boot.me, users: boot.users, servers: boot.servers, dms: boot.dms, privateKey: user.privateKey, e2eeSince: boot.e2eeSince };
  const sec = SEC.createSecure({ S });
  await sec.ensureSigningKey(boot.encSignPrivateKey);
  Object.values(S.users).forEach((u) => sec.trust(u));
  for (const st of Object.values(boot.keyStates || {})) await sec.applyState(st);
  for (const s of S.servers) await sec.keysSaved(s.id);
  return { sec, S, pins, boot };
}
const rowsOf = (sid, uid) => srv.sql('SELECT epoch, wrapper_id FROM server_keys WHERE server_id = ? AND user_id = ? ORDER BY epoch', sid, uid);
const flagOf = (uid) => srv.sql('SELECT keys_reset_at, keys_vouched_by FROM users WHERE id = ?', uid)[0];
const keyState = async (u, sid) => (await as(u, 'GET', `/servers/${sid}/keys`)).json;
async function resetWithoutRecovery(user) {
  const email = `${user.username}@example.test`;
  if (!srv.sql('SELECT email FROM users WHERE id = ?', user.id)[0].email) await H.confirmEmail(srv, user, email);
  await srv.api('POST', '/auth/forgot', { ip: H.newIp(), body: { login: user.username } });
  const tok = H.resetTokenFrom((await srv.mails()).filter((m) => m.to === email && /reset your password/.test(m.subject)).pop());
  const kdfSalt = E.newKdfSalt();
  const k = await E.deriveKeys(user.username, 'new-pw', { kdf: 'argon2id', salt: kdfSalt });
  const ident = await E.createIdentity(k.wrapKey);
  const ip = H.newIp();
  const rr = await srv.api('POST', '/auth/reset', { ip, body: { token: tok, authKey: k.authKey, kdfSalt, encPrivateKey: ident.encPrivateKey, publicKey: ident.publicKey } });
  assert.equal(rr.status, 200, rr.text);
  const nu = { ...user, ip, token: rr.json.token, authKey: k.authKey, ...ident, resetUser: rr.json.user };
  const sk = await E.createSigningKey(ident.privateKey, ident.publicKey);
  Object.assign(nu, sk);
  assert.equal((await uploadSignKey(nu, sk)).status, 200);
  return nu;
}

// ------------------------------------------------------------------ the attack, and the way back
test('crypto-2: after a reset without a recovery key nobody hands the new keys a server key until a member vouches', async () => {
  const A = await person(uname('alice')); const B = await person(uname('bob')); let V = await person(uname('victim'));
  const { s, ch } = await serverWith(A, [B, V]);
  const { raw: raw1 } = await rotate(A, s.id, 1, [A, B, V]);
  // An invite the real Victor made before the reset, and a server he owns.
  const vInvite = (await as(V, 'POST', `/servers/${s.id}/invites`, {})).json.code;
  assert.ok(vInvite);
  // Pat runs a server of her own that Victor isn't in (yet).
  const P = await person(uname('pat'));
  const { s: x, code: xCode } = await serverWith(P, []);
  const before = Date.now();
  await sleep(5);

  const V0 = V;
  V = await resetWithoutRecovery(V); // someone with only his email
  const at = flagOf(V.id).keys_reset_at;
  assert.ok(at >= before, 'the reset is recorded');
  assert.equal(V.resetUser.keysReset, at, 'and his own app is told');
  assert.equal((await as(B, 'GET', `/users/${V.id}`)).json.keysReset, at, 'so is everyone else’s');
  let st = await keyState(A, s.id);
  assert.deepEqual(st.held, [V.id]);
  assert.ok(!st.missing.includes(V.id), 'not listed as someone to share with');

  // A device of Bob's that never saw Victor's old key (the case that used to hand the key over at once).
  sent.length = 0;
  const d = await device(B, new Map());
  assert.equal(d.sec.currentKey(s.id).epoch, 1);
  await sleep(300);
  assert.deepEqual(handedOut(), [], 'the app doesn’t try to share or rotate');
  assert.deepEqual(rowsOf(s.id, V.id), []);
  // An older (or modified) app that shares anyway: the server keeps nothing for him.
  const w = await wrapTo(B, s.id, 1, raw1, V);
  const r = await as(B, 'POST', `/servers/${s.id}/keys/share`, { epoch: 1, wraps: { [V.id]: w }, pubs: { [V.id]: V.publicKey } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.shared, r.json.held], [0, [V.id]]);
  assert.deepEqual(rowsOf(s.id, V.id), []);
  // Rotations go on without him: with a copy for him (dropped; here made for his old key, which would otherwise be
  // refused as stale), or without one.
  let rot = await rotate(A, s.id, 2, [A, B, V0]);
  assert.equal(rot.r.status, 200, rot.r.text);
  rot = await rotate(A, s.id, 3, [A, B]);
  assert.equal(rot.r.status, 200, rot.r.text);
  const raw3 = rot.raw;
  assert.deepEqual(rowsOf(s.id, V.id), []);
  // Nor can he make the key the others will write with.
  const own = await rotate(V, s.id, 4, [A, B, V]);
  assert.deepEqual([own.r.status, own.r.json.code], [403, 'keys_unverified']);
  // His own app knows why it has no key, and says so instead of waiting.
  const vd = await device(V, new Map());
  assert.equal(vd.S.me.keysReset, at);
  await assert.rejects(vd.sec.ready(s.id), (e) => e.code === 'unverified');

  // He can't bring anyone in: no invites (not even the list of old ones), no group chats.
  for (const [m, p, body] of [['POST', `/servers/${s.id}/invites`, {}], ['GET', `/servers/${s.id}/invites`], ['POST', '/groups', { userIds: [B.id] }]]) {
    const x = await as(V, m, p, body);
    assert.deepEqual([x.status, x.json.code], [403, 'keys_unverified'], `${m} ${p}`);
    assert.match(x.json.error, /recovery key/);
  }
  // The link the real Victor made still works (he made it, and people may be using it): a newcomer gets the key.
  const N = await person(uname('newbie'));
  assert.equal((await as(N, 'POST', `/invites/${vInvite}/join`, {})).status, 200);
  assert.ok((await keyState(A, s.id)).missing.includes(N.id));
  const wn = await wrapTo(A, s.id, 3, raw3, N);
  assert.equal((await as(A, 'POST', `/servers/${s.id}/keys/share`, { epoch: 3, wraps: { [N.id]: wn } })).json.shared, 1);

  // Who may vouch: not himself, not the newcomer (joined after the reset), not someone he met only since, and not
  // for a key other than his current one.
  let v = await as(V, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.deepEqual([v.status, v.json.code], [403, 'self']);
  v = await as(N, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.deepEqual([v.status, v.json.code], [403, 'not_eligible']);
  // Nor Pat, though she's been in her server since long before: he only joined it after his reset.
  assert.equal((await as(V, 'POST', `/invites/${xCode}/join`, {})).status, 200, 'joining others’ servers still works');
  assert.deepEqual((await keyState(P, x.id)).held, [V.id]);
  v = await as(P, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.deepEqual([v.status, v.json.code], [403, 'not_eligible']);
  // So his app doesn't offer her as someone to ask: only Alice and Bob (in a server with him since before), not the
  // newcomer either. Bob's word would count in that server.
  const asks = (await as(V, 'GET', '/me/verifiers')).json;
  assert.equal(asks.waiting, true);
  assert.deepEqual(asks.users.map((u) => u.id).sort(), [A.id, B.id].sort());
  assert.deepEqual(asks.users.find((u) => u.id === B.id).serverIds, [s.id]);
  v = await as(B, 'POST', `/users/${V.id}/keys/verify`, { publicKey: A.publicKey });
  assert.deepEqual([v.status, v.json.code], [409, 'stale_keys']);
  assert.equal(flagOf(V.id).keys_reset_at, at, 'still waiting');

  // Bob compared safety numbers with him: "Numbers match — verify and share keys".
  v = await as(B, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.equal(v.status, 200, v.text);
  assert.equal(v.json.verified, true);
  assert.deepEqual(flagOf(V.id), { keys_reset_at: null, keys_vouched_by: B.id });
  assert.ok(srv.sql("SELECT 1 FROM admin_log WHERE action = 'keys_verified' AND target = ?", V.id).length, 'in the audit log');
  assert.equal((await as(B, 'GET', `/users/${V.id}`)).json.keysReset, undefined);
  st = await keyState(A, s.id);
  assert.deepEqual(st.held, []);
  assert.ok(st.missing.includes(V.id));
  // Any member's app now shares the current key with him, and he reads what's said next.
  const ad = await device(A, new Map());
  assert.ok(await until(() => rowsOf(s.id, V.id).some((x) => x.epoch === 3)), 'shared once verified');
  void ad;
  await send(A, s.id, ch, 3, raw3, 'welcome back');
  const vd2 = await device(V, new Map());
  assert.equal(vd2.sec.currentKey(s.id).epoch, 3);
  const m = (await as(V, 'GET', `/channels/${ch}/messages`)).json.messages.find((x) => x.epoch === 3);
  await vd2.sec.decryptChannelMessage(m);
  assert.equal(m.dec.t, 'welcome back');
  assert.equal((await as(V, 'POST', `/servers/${s.id}/invites`, {})).status, 200, 'and can invite again');
});

test('crypto-2: group chats are held back the same way; an unverified member can’t vouch for anyone', async () => {
  const A = await person(uname('alice')); let V = await person(uname('vera')); let W = await person(uname('walt'));
  const F = await person(uname('friend'));
  await serverWith(A, [V, W, F]); // so they may add each other to groups
  const g = (await as(A, 'POST', '/groups', { userIds: [V.id, W.id] })).json;
  const { raw } = await rotate(A, g.id, 1, [A, V, W]);
  V = await resetWithoutRecovery(V);
  W = await resetWithoutRecovery(W);
  assert.deepEqual((await keyState(A, g.id)).held.sort(), [V.id, W.id].sort());
  // Neither can add anyone to the group (a second account of theirs would be handed the key).
  const add = await as(V, 'POST', `/groups/${g.id}/members`, { userId: F.id });
  assert.deepEqual([add.status, add.json.code], [403, 'keys_unverified']);
  assert.ok(!srv.sql('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', g.id, F.id).length);
  // Alice's app shares with nobody; the server would keep nothing anyway.
  sent.length = 0;
  await device(A, new Map());
  await sleep(300);
  assert.ok(!handedOut().some(([, p]) => p.includes(g.id)), JSON.stringify(sent));
  const wv = await wrapTo(A, g.id, 1, raw, V);
  assert.equal((await as(A, 'POST', `/servers/${g.id}/keys/share`, { epoch: 1, wraps: { [V.id]: wv } })).json.shared, 0);
  // Walt, waiting himself, can't vouch for Vera (two accounts someone took over can't clear each other).
  const x = await as(W, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.deepEqual([x.status, x.json.code], [403, 'keys_unverified']);
  // Alice, in the group with them since before, vouches for Vera; Walt stays held back.
  assert.equal((await as(A, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey })).json.verified, true);
  assert.deepEqual((await keyState(A, g.id)).held, [W.id]);
  await device(A, new Map());
  assert.ok(await until(() => rowsOf(g.id, V.id).length === 1));
  assert.deepEqual(rowsOf(g.id, W.id), []);
  // Adding people (by someone who isn't waiting) works as before, and the newcomer gets the key.
  assert.equal((await as(A, 'POST', `/groups/${g.id}/members`, { userId: F.id })).status, 200);
  await device(A, new Map());
  assert.ok(await until(() => rowsOf(g.id, F.id).length === 1));
  assert.deepEqual(rowsOf(g.id, W.id), []);
});

test('crypto-2: an instance admin can verify someone from Admin → Users; never themselves, nor while waiting', async () => {
  const A = await person(uname('alice')); let V = await person(uname('vic'));
  await serverWith(A, [V]);
  V = await resetWithoutRecovery(V);
  const owner = srv.owner;
  assert.equal((await as(A, 'POST', `/admin/users/${V.id}/keys/verify`)).status, 403, 'not for members');
  const detail = (await as(owner, 'GET', `/admin/users/${V.id}`)).json;
  assert.equal(detail.keysResetAt, flagOf(V.id).keys_reset_at);
  assert.equal((await as(owner, 'POST', `/admin/users/${owner.id}/keys/verify`)).status, 403, 'not on yourself');
  // An admin whose own keys wait to be verified can't clear anyone's.
  srv.sql('UPDATE users SET keys_reset_at = ? WHERE id = ?', Date.now(), owner.id);
  let r = await as(owner, 'POST', `/admin/users/${V.id}/keys/verify`);
  assert.deepEqual([r.status, r.json.code], [403, 'keys_unverified']);
  srv.sql('UPDATE users SET keys_reset_at = NULL WHERE id = ?', owner.id);
  // It can't be taken back, so it takes the password (and a fresh two-factor code when that's on), like a staff change.
  r = await as(owner, 'POST', `/admin/users/${V.id}/keys/verify`);
  assert.deepEqual([r.status, r.json.code], [401, 'bad_password'], 'the session alone isn’t enough');
  assert.ok(flagOf(V.id).keys_reset_at, 'still waiting');
  r = await as(owner, 'POST', `/admin/users/${V.id}/keys/verify`, { authKey: owner.authKey });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(flagOf(V.id), { keys_reset_at: null, keys_vouched_by: owner.id });
  assert.ok(srv.sql("SELECT 1 FROM admin_log WHERE action = 'keys_verified_by_admin' AND target = ?", V.id).length);
  assert.equal((await as(owner, 'POST', `/admin/users/${V.id}/keys/verify`)).status, 400, 'nothing left to verify');
  assert.equal((await as(owner, 'GET', `/admin/users/${V.id}`)).json.keysVouched.by.id, owner.id);
});

test('crypto-2 with auth-6: an admin with two-factor on needs a fresh code to verify someone, even right after signing in with one', async () => {
  const A = await person(uname('ann')); let V = await person(uname('val'));
  await serverWith(A, [V]);
  V = await resetWithoutRecovery(V);
  const adm = await person(uname('adm'));
  assert.equal((await as(srv.owner, 'PUT', '/admin/staff', { userId: adm.id, role: 'admin', authKey: srv.owner.authKey })).status, 200);
  const tf = await H.enable2fa(srv, adm);
  const login = await srv.login(adm, { backupCode: tf.backupCodes.pop() });
  assert.equal(login.status, 200, login.text);
  adm.token = login.json.token;
  let r = await as(adm, 'POST', `/admin/users/${V.id}/keys/verify`, { authKey: adm.authKey });
  assert.deepEqual([r.status, r.json.code], [401, 'need_2fa']);
  assert.ok(flagOf(V.id).keys_reset_at, 'still waiting');
  // A wrong one changes nothing either.
  r = await as(adm, 'POST', `/admin/users/${V.id}/keys/verify`, { authKey: adm.authKey, totp: '000000' });
  assert.equal(r.status, 401);
  assert.ok(flagOf(V.id).keys_reset_at);
  r = await as(adm, 'POST', `/admin/users/${V.id}/keys/verify`, { authKey: adm.authKey, backupCode: tf.backupCodes.pop() });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(flagOf(V.id), { keys_reset_at: null, keys_vouched_by: adm.id });
});

test('crypto-2: only resets that replace the keys are marked; nobody who shares nothing; a second reset stays marked', async () => {
  // Shares no server or group with anyone: like a new account, nobody to protect and nobody who could verify it.
  let L = await person(uname('loner'));
  L = await resetWithoutRecovery(L);
  assert.equal(flagOf(L.id).keys_reset_at, null);
  assert.equal(L.resetUser.keysReset, null);
  // An ordinary password change doesn't mark anyone.
  const A = await person(uname('alice')); const B = await person(uname('bob'));
  const { s, code } = await serverWith(A, [B]);
  const pw = await E.deriveKeys(B.username, 'changed-pw', { kdf: 'argon2id', salt: E.newKdfSalt() });
  const c = await as(B, 'POST', '/me/password', { oldAuthKey: B.authKey, newAuthKey: pw.authKey, encPrivateKey: B.encPrivateKey, salt: E.newKdfSalt() });
  assert.equal(c.status, 200, c.text);
  assert.equal(flagOf(B.id).keys_reset_at, null);
  // Nor does a reset with the recovery key (same keys, proven).
  const R = await srv.register(uname('rec'));
  assert.equal((await as(R, 'POST', `/invites/${code}/join`, {})).status, 200);
  assert.equal((await as(R, 'PUT', '/me/recovery', { authKey: R.authKey, encPrivateKeyRecovery: H.b64(120), recoverySalt: H.b64(16) })).status, 200);
  await H.confirmEmail(srv, R, `${R.username}@example.test`);
  await srv.api('POST', '/auth/forgot', { ip: H.newIp(), body: { login: R.username } });
  const tok = H.resetTokenFrom((await srv.mails()).filter((m) => m.to === `${R.username}@example.test` && /reset your password/.test(m.subject)).pop());
  const info = (await srv.api('POST', '/auth/reset/info', { ip: H.newIp(), body: { token: tok } })).json;
  const kept = await srv.api('POST', '/auth/reset', { ip: H.newIp(), body: { token: tok, authKey: H.hex(32), kdfSalt: H.b64(16), encPrivateKey: H.b64(120), keepKeys: true, keyProof: H.resetProof(R, info.keyChallenge) } });
  assert.equal(kept.status, 200, kept.text);
  assert.equal(flagOf(R.id).keys_reset_at, null);
  // A second reset while still waiting stays marked, from the newer reset (whoever vouches must predate it).
  let V = await person(uname('vince'));
  assert.equal((await as(V, 'POST', `/invites/${code}/join`, {})).status, 200);
  V = await resetWithoutRecovery(V);
  const first = flagOf(V.id).keys_reset_at;
  assert.ok(first);
  assert.equal((await as(V, 'POST', `/servers/${s.id}/leave`)).status, 200, 'he leaves');
  await sleep(5);
  V = await resetWithoutRecovery(V);
  assert.ok(flagOf(V.id).keys_reset_at > first, 'still marked, though he now shares nothing');
});

test('crypto-2: someone waiting to be verified can still make the key of a server nobody else is in; codes stay hidden', async () => {
  const A = await person(uname('alice')); let V = await person(uname('val'));
  // Valerie owns a server with Alice in it, and made an invite there before her reset.
  const { s, code } = await serverWith(V, [A]);
  await rotate(V, s.id, 1, [V, A]);
  const made = async () => (await as(V, 'GET', `/servers/${s.id}/audit`)).json.entries.filter((e) => e.action === 'invite_create').map((e) => e.targetId);
  assert.deepEqual(await made(), [code], 'the owner sees whole codes');
  V = await resetWithoutRecovery(V);
  // The server's audit log doesn't show her the invite codes she can't list any more.
  assert.deepEqual(await made(), [`${code.slice(0, 2)}\u2026`]);
  // A new server of her own, nobody else in it: her app makes its key as usual.
  const mine = (await as(V, 'POST', '/servers', { name: 'mine' })).json;
  const d = await device(V, new Map());
  assert.ok(await until(() => d.sec.currentKey(mine.id)), 'her app made the key of her own server');
  assert.deepEqual(rowsOf(mine.id, V.id).map((x) => x.epoch), [1]);
  // But not the one Alice is in.
  assert.deepEqual(rowsOf(s.id, V.id), []);
  await assert.rejects(d.sec.ready(s.id), (e) => e.code === 'unverified');
});

test('crypto-2: the app drops the mark when a whole user object comes without it, and skips marked people by itself', async () => {
  // mergeUser: only a full user object (it has publicKey) clears it; a presence or activity update doesn't.
  const old = { id: 'u1', publicKey: 'k', keysReset: 5, username: 'x' };
  assert.equal(SEC.mergeUser(old, { id: 'u1', presence: 'online' }).keysReset, 5);
  assert.equal('keysReset' in SEC.mergeUser(old, { id: 'u1', publicKey: 'k', username: 'x' }), false);
  assert.equal(SEC.mergeUser(old, { id: 'u1', publicKey: 'k', keysReset: null }).keysReset, null);
  // A key state that (like an older server's) doesn't list who is held back: the app still skips anyone it knows
  // is waiting to be verified. (One that does list them is what counts: someone can be held back in one server and
  // not in another, see the test of vouches below.)
  const A = await person(uname('alice')); let V = await person(uname('vic')); const N = await person(uname('nina'));
  const { s, code } = await serverWith(A, [V]);
  await rotate(A, s.id, 1, [A, V]);
  V = await resetWithoutRecovery(V);
  assert.equal((await as(N, 'POST', `/invites/${code}/join`, {})).status, 200);
  const d = await device(A, new Map());
  assert.ok(await until(() => rowsOf(s.id, N.id).length === 1), 'a newcomer is shared with as usual');
  assert.equal(d.sec.heldBack(s.id, V.id), true);
  assert.equal(d.sec.heldBack(s.id, N.id), false);
  sent.length = 0;
  const st = await keyState(A, s.id);
  const older = { ...st, missing: [...st.missing, V.id] };
  delete older.held;
  await d.sec.applyState(older);
  await sleep(300);
  assert.deepEqual(handedOut(), [], JSON.stringify(sent));
});

// ------------------------------------------------------------------ review: a vouch only counts where the voucher is
test('crypto-2: a second account in a public server can vouch only for that server; private servers and groups stay held', async () => {
  const A = await person(uname('alice')); let V = await person(uname('victor'));
  const B = await person(uname('bob')); const C = await person(uname('carol')); const O = await person(uname('comm'));
  // Victor's private server with Alice, and a public community (its invite is out there) with Bob and Carol.
  const { s: priv, ch: privCh } = await serverWith(A, [V]);
  const { raw: privRaw } = await rotate(A, priv.id, 1, [A, V]);
  const { s: pub, code: pubCode } = await serverWith(O, [V, B, C]);
  // Whoever is about to take over Victor's email puts a second account in the community first.
  const P = await person(uname('puppet'));
  assert.equal((await as(P, 'POST', `/invites/${pubCode}/join`, {})).status, 200);
  await rotate(O, pub.id, 1, [O, V, B, C, P]);
  // A private group: Victor, Bob and Carol only.
  const g = (await as(B, 'POST', '/groups', { userIds: [V.id, C.id] })).json;
  const { raw: gRaw } = await rotate(B, g.id, 1, [B, V, C]);
  await send(B, g.id, g.channels.find((c) => c.type === 'text').id, 1, gRaw, 'private group secret');
  await sleep(5);

  V = await resetWithoutRecovery(V);
  // Everyone who could lift a hold is listed, with where their word counts: the puppet only in the community.
  let asks = (await as(V, 'GET', '/me/verifiers')).json;
  assert.deepEqual(asks.users.map((u) => u.id).sort(), [A.id, B.id, C.id, O.id, P.id].sort());
  assert.deepEqual(asks.users.find((u) => u.id === P.id).serverIds, [pub.id]);
  assert.deepEqual(asks.users.find((u) => u.id === B.id).serverIds.sort(), [pub.id, g.id].sort());

  // The puppet "verifies" him without comparing anything.
  let v = await as(P, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.equal(v.status, 200, v.text);
  assert.deepEqual([v.json.verified, v.json.released, v.json.everywhere], [true, [pub.id], false]);
  assert.ok(flagOf(V.id).keys_reset_at, 'still marked');
  assert.deepEqual((await keyState(O, pub.id)).held, [], 'released in the community (which the puppet reads anyway)');
  assert.deepEqual((await keyState(A, priv.id)).held, [V.id], 'not in the private server');
  assert.deepEqual((await keyState(B, g.id)).held, [V.id], 'nor in the group');
  assert.equal((await as(B, 'GET', `/users/${V.id}`)).json.keysReset, flagOf(V.id).keys_reset_at, 'everyone still sees the mark');
  // Devices that never saw his old key: Bob's shares the community's key with him, not the group's; Alice's shares nothing.
  sent.length = 0;
  await device(B, new Map());
  assert.ok(await until(() => rowsOf(pub.id, V.id).length === 1), 'the community key goes to him');
  await device(A, new Map());
  await sleep(300);
  assert.deepEqual(rowsOf(g.id, V.id), []);
  assert.deepEqual(rowsOf(priv.id, V.id), []);
  assert.ok(!handedOut().some(([, p]) => p.includes(g.id) || p.includes(priv.id)), JSON.stringify(sent));
  // The server keeps none handed to him there either.
  const w = await wrapTo(B, g.id, 1, gRaw, V);
  assert.equal((await as(B, 'POST', `/servers/${g.id}/keys/share`, { epoch: 1, wraps: { [V.id]: w } })).json.shared, 0);
  // He can invite people where he's released, not where he's held, and can't add the puppet to the group.
  assert.equal((await as(V, 'POST', `/servers/${pub.id}/invites`, {})).status, 200);
  let x = await as(V, 'POST', `/servers/${priv.id}/invites`, {});
  assert.deepEqual([x.status, x.json.code], [403, 'keys_unverified']);
  x = await as(V, 'POST', `/groups/${g.id}/members`, { userId: P.id });
  assert.deepEqual([x.status, x.json.code], [403, 'keys_unverified']);
  // Nor start a group chat while held back anywhere.
  x = await as(V, 'POST', '/groups', { userIds: [P.id] });
  assert.deepEqual([x.status, x.json.code], [403, 'keys_unverified']);
  // A second vouch from the puppet opens nothing more.
  v = await as(P, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.deepEqual([v.json.verified, v.json.released, v.json.everywhere], [false, [], false]);
  asks = (await as(V, 'GET', '/me/verifiers')).json;
  assert.ok(!asks.users.some((u) => u.id === P.id), 'nobody listed whose word opens nothing new');

  // Alice compares numbers with him: the private server. Carol: the group. Then he's verified everywhere.
  v = await as(A, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.deepEqual([v.json.released, v.json.everywhere], [[priv.id], false]);
  assert.deepEqual((await keyState(A, priv.id)).held, []);
  assert.deepEqual((await keyState(B, g.id)).held, [V.id]);
  v = await as(C, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.deepEqual([v.json.released, v.json.everywhere], [[g.id], true]);
  assert.deepEqual(flagOf(V.id), { keys_reset_at: null, keys_vouched_by: C.id });
  assert.equal(srv.sql('SELECT COUNT(*) AS n FROM key_vouches WHERE user_id = ?', V.id)[0].n, 0, 'no rows left behind');
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'keys_verified' AND target = ?", V.id)[0].n, 3);
  await device(A, new Map());
  assert.ok(await until(() => rowsOf(priv.id, V.id).length === 1));
  await send(A, priv.id, privCh, 1, privRaw, 'hi again');
  assert.deepEqual((await as(V, 'GET', '/me/verifiers')).json, { waiting: false, users: [] });
});

test('crypto-2: leaving a server after the reset isn’t being verified there', async () => {
  const A = await person(uname('alice')); let V = await person(uname('vale')); const O = await person(uname('comm'));
  const { s: priv } = await serverWith(A, [V]);
  const { s: pub, code } = await serverWith(O, [V, A]);
  const P = await person(uname('puppet'));
  assert.equal((await as(P, 'POST', `/invites/${code}/join`, {})).status, 200);
  await sleep(5);
  V = await resetWithoutRecovery(V);
  // He leaves the private server, then the puppet vouches in the only one left: still marked.
  assert.equal((await as(V, 'POST', `/servers/${priv.id}/leave`)).status, 200);
  let v = await as(P, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.deepEqual([v.json.released, v.json.everywhere], [[pub.id], false]);
  assert.ok(flagOf(V.id).keys_reset_at);
  // Alice, a member there, can still vouch for that server; then he's verified everywhere.
  assert.ok((await as(V, 'GET', '/me/verifiers')).json.users.some((u) => u.id === A.id));
  v = await as(A, 'POST', `/users/${V.id}/keys/verify`, { publicKey: V.publicKey });
  assert.deepEqual([v.json.released, v.json.everywhere], [[priv.id], true]);
  assert.equal(flagOf(V.id).keys_reset_at, null);
});

test('crypto-2: someone held back alone in a server can’t hand the key they made to a newcomer', async () => {
  const A = await person(uname('alice')); let V = await person(uname('vowner'));
  const { s, code, ch } = await serverWith(V, [A]);
  await rotate(V, s.id, 1, [V, A]);
  V = await resetWithoutRecovery(V);
  // Whoever has her account removes Alice and, alone now, makes the server's next key (allowed: nobody to protect).
  assert.equal((await as(V, 'DELETE', `/servers/${s.id}/members/${A.id}`)).status, 200);
  const vd = await device(V, new Map());
  assert.ok(await until(() => vd.sec.currentKey(s.id)));
  const made = vd.sec.currentKey(s.id);
  assert.equal(made.epoch, 2);
  // A newcomer through the invite she made before the reset (it keeps working): the key is replaced first.
  const N = await person(uname('newbie'));
  assert.equal((await as(N, 'POST', `/invites/${code}/join`, {})).status, 200);
  let st = await keyState(N, s.id);
  assert.deepEqual([st.needsRotation, st.held, st.missing], [true, [V.id], [N.id]]);
  // Even with that undone (as on a server from before this fix), she can't share hers with him.
  srv.sql('UPDATE servers SET needs_rotation = 0 WHERE id = ?', s.id);
  const w = await wrapTo(V, s.id, 2, made.raw, N);
  const r = await as(V, 'POST', `/servers/${s.id}/keys/share`, { epoch: 2, wraps: { [N.id]: w }, pubs: { [N.id]: N.publicKey } });
  assert.deepEqual([r.status, r.json.code], [403, 'keys_unverified']);
  assert.deepEqual(rowsOf(s.id, N.id), []);
  srv.sql('UPDATE servers SET needs_rotation = 1 WHERE id = ?', s.id);
  // Her app doesn't try; his makes a new key without her, and she can't read what he writes.
  sent.length = 0;
  await device(V, new Map());
  await sleep(300);
  assert.deepEqual(handedOut(), [], JSON.stringify(sent));
  const nd = await device(N, new Map());
  assert.ok(await until(() => nd.sec.currentKey(s.id)), 'the newcomer made a key');
  const ck = nd.sec.currentKey(s.id);
  assert.equal(ck.epoch, 3);
  st = await keyState(N, s.id);
  assert.equal(st.keyCreatorId, N.id);
  assert.deepEqual(rowsOf(s.id, V.id).map((x) => x.epoch), [2], 'no copy of the new key for her');
  await send(N, s.id, ch, 3, ck.raw, 'secret from newcomer');
  const vd2 = await device(V, new Map());
  assert.equal(vd2.sec.currentKey(s.id), null);
  // A server key made by someone who isn't held back changes nothing for ordinary joins.
  const B = await person(uname('bob'));
  const { s: t, code: tCode } = await serverWith(B, []);
  await rotate(B, t.id, 1, [B]);
  const M = await person(uname('mia'));
  assert.equal((await as(M, 'POST', `/invites/${tCode}/join`, {})).status, 200);
  assert.equal((await keyState(M, t.id)).needsRotation, false);
});

// Last: it resets the instance owner's password.
test('crypto-2: a marked owner can’t give out staff roles or hand over ownership until verified', async () => {
  const A = await person(uname('alice')); const P = await person(uname('puppet')); const M = await person(uname('mod'));
  let O = { ...srv.owner };
  const { s } = await serverWith(A, []);
  const code = (await as(A, 'POST', `/servers/${s.id}/invites`, {})).json.code;
  assert.equal((await as(O, 'POST', `/invites/${code}/join`, {})).status, 200);
  assert.equal((await as(O, 'PUT', '/admin/staff', { userId: M.id, role: 'moderator', authKey: O.authKey })).status, 200);
  await sleep(5);
  O = await resetWithoutRecovery(O);
  assert.ok(flagOf(O.id).keys_reset_at);
  // A second account made admin could otherwise verify the owner from Admin → Users.
  let r = await as(O, 'PUT', '/admin/staff', { userId: P.id, role: 'admin', authKey: O.authKey });
  assert.deepEqual([r.status, r.json.code], [403, 'keys_unverified']);
  assert.match(r.json.error, /recovery key/);
  r = await as(O, 'POST', '/admin/owner', { userId: P.id, authKey: O.authKey });
  assert.deepEqual([r.status, r.json.code], [403, 'keys_unverified']);
  assert.equal((await as(P, 'POST', `/admin/users/${O.id}/keys/verify`)).status, 403, 'not an admin');
  assert.ok(flagOf(O.id).keys_reset_at);
  // Taking a role away still works.
  assert.equal((await as(O, 'PUT', '/admin/staff', { userId: M.id, role: null, authKey: O.authKey })).status, 200);
  // Once a member who knew them verifies them (here everywhere they were), roles can be given again.
  const v = await as(A, 'POST', `/users/${O.id}/keys/verify`, { publicKey: O.publicKey });
  assert.equal(v.json.everywhere, true);
  assert.equal((await as(O, 'PUT', '/admin/staff', { userId: M.id, role: 'moderator', authKey: O.authKey })).status, 200);
});

test('crypto-2 with scheduled messages and voice chats: what was scheduled before the reset never goes out, and a voice channel’s chat is held back with its server', async () => {
  const A = await person(uname('alice')); let V = await person(uname('vic'));
  const { s, ch } = await serverWith(A, [V]);
  const vc = (await as(A, 'POST', `/servers/${s.id}/channels`, { name: `lounge${H.hex(2)}`, type: 'voice' })).json;
  assert.ok(vc && vc.id, 'a voice channel');
  const { r: rot } = await rotate(A, s.id, 1, [A, V]);
  assert.equal(rot.status, 200, rot.text);
  const schedule = async (channelId) => {
    const r = await as(V, 'POST', `/channels/${channelId}/scheduled-messages`, { ciphertext: `c2:1:${H.b64(48)}`, epoch: 1, ref: H.hex(12), draft: `x1:${H.b64(48)}`, sendAt: Date.now() + 2500 });
    assert.equal(r.status, 200, r.text);
    return r.json.id;
  };
  const ids = [await schedule(ch), await schedule(vc.id)]; // a text channel and the voice channel's chat
  const rowOf = (id) => srv.sql('SELECT status, reason FROM scheduled_messages WHERE id = ?', id)[0];
  V = await resetWithoutRecovery(V);
  for (const id of ids) assert.deepEqual({ ...rowOf(id) }, { status: 'held', reason: 'session_ended' }, 'the reset signed out the session that scheduled them');
  // At their time: failed (her own keys changed, so they can't be confirmed either), never posted.
  assert.ok(await until(() => ids.every((id) => rowOf(id).status === 'failed'), 15000), 'failed at their time');
  for (const id of ids) assert.equal(rowOf(id).reason, 'keys_changed');
  for (const c of [ch, vc.id]) assert.ok(!(await as(A, 'GET', `/channels/${c}/messages`)).json.messages.some((m) => m.authorId === V.id), 'nothing of hers posted');
  // The voice channel's chat uses the server's key, so she's held back there like everywhere in the server, and a
  // copy handed to her anyway is dropped.
  const st = await keyState(V, s.id);
  assert.ok(st.held.includes(V.id));
  assert.equal(st.keys.length, 0);
  const raw = E.newGroupKey();
  const shared = await as(A, 'POST', `/servers/${s.id}/keys/share`, { epoch: 1, wraps: { [V.id]: await wrapTo(A, s.id, 1, raw, V) }, pubs: { [V.id]: V.publicKey } });
  assert.equal(shared.status, 200, shared.text);
  assert.deepEqual([shared.json.shared, shared.json.held], [0, [V.id]]);
});
