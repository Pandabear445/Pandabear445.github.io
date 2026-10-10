#!/usr/bin/env node
// Upgrade drill, the Node half (scripts/upgrade-drill.sh runs the servers):
//   seed BASE CODE_ROOT STATE.json          fill a running (old) Hearth through its API: accounts with real keys,
//                                           two-factor, an encrypted server and DM, an attachment, settings with
//                                           plaintext API keys, staff changes for the audit log
//   verify BASE DATA_DIR STATE.json ROUND    check a running (new) Hearth on that data: sign-in, the same keys open
//                                           the messages, files byte-equal, secrets sealed, audit log verifies
//   stamp DATA_DIR STATE.json               record the (stopped) old server's database version in the state
//   pack DATA_DIR STATE.json OUT            bundle a stopped server's data and its state as a test fixture
// The fast version of the same checks runs in the test suite from a committed fixture (test/recovery-upgrade.test.js).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const H = require('../test/helpers');

const ROOT = path.join(__dirname, '..');
let E;
async function crypto2() {
  if (!E) {
    globalThis.window = globalThis.window || { crypto: globalThis.crypto, hashwasm: require('hash-wasm') };
    E = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'e2ee.js')).href);
  }
  return E;
}
function client(base) {
  return async (method, p, { token, ip = '198.51.100.7', body, form } = {}) => {
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
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ok = (r, what) => { assert.ok(r.status === 200, `${what}: ${r.status} ${r.text}`); return r.json; };

// ------------------------------------------------------------------ seed (runs against the OLD version)
async function seed({ base, codeRoot = ROOT }) {
  const E2 = await crypto2();
  const api = client(base);
  // The robot check of the version being seeded (its own solver, in case the puzzle changed).
  const src = fs.readFileSync(path.join(codeRoot, 'public', 'js', 'captcha-worker.js'), 'utf8').replace(/self\.onmessage[\s\S]*$/, '');
  const solve = new Function(`${src}\nreturn solve;`)();
  const config = ok(await api('GET', '/config'), 'config');
  async function signUp(name) {
    const username = `${name}${H.hex(2)}`;
    const password = `upgrade-${name}-pw`;
    const kdfSalt = E2.newKdfSalt();
    const { authKey, wrapKey } = await E2.deriveKeys(username, password, { kdf: 'argon2id', salt: kdfSalt });
    const id = await E2.createIdentity(wrapKey);
    const ip = H.newIp();
    const body = { username, authKey, kdfSalt, publicKey: id.publicKey, encPrivateKey: id.encPrivateKey, acceptTos: config.termsVersion || undefined };
    let r = await api('POST', '/auth/register', { ip, body });
    if (r.status === 400 && r.json && r.json.code === 'captcha') {
      const c = ok(await api('GET', '/captcha?purpose=register', { ip }), 'captcha');
      r = await api('POST', '/auth/register', { ip, body: { ...body, captcha: { salt: c.salt, difficulty: c.difficulty, expires: c.expires, sig: c.sig, nonce: solve(c.salt, c.difficulty) } } });
    }
    ok(r, `register ${name}`);
    const p = { name, username, password, authKey, ip, token: r.json.token, id: r.json.user.id, publicKey: id.publicKey, privateKey: id.privateKey };
    const sk = await E2.createSigningKey(id.privateKey, id.publicKey);
    // Newer versions want proof of both keys; older ones take the key as it is.
    const ch = await api('POST', '/me/sign-key/challenge', { token: p.token, ip });
    const extra = ch.status === 200 ? {
      nonce: ch.json.nonce, keyProof: await E2.signKeyProof(id.privateKey, ch.json.serverPublicKey, ch.json.nonce, p.id, sk.signPublicKey),
      signature: await E2.sign(sk.signKey, `hearth-sign-key|${p.id}|${id.publicKey}|${ch.json.nonce}`),
    } : {};
    ok(await api('POST', '/me/sign-key', { token: p.token, ip, body: { signPublicKey: sk.signPublicKey, encSignPrivateKey: sk.encSignPrivateKey, ...extra } }), 'sign key');
    Object.assign(p, { signKey: sk.signKey, signPublicKey: sk.signPublicKey });
    return p;
  }
  const owner = await signUp('owner');
  const as = (u, m, p, body) => api(m, p, { token: u.token, ip: u.ip, body });
  ok(await as(owner, 'PUT', '/admin/registration', { captchaLogin: 'off', captchaRegister: 'off' }), 'captcha off');
  const alice = await signUp('alice'); const bob = await signUp('bob');
  // Two-factor for Bob (its secret is sealed with secret.key; backup codes are keyed with it).
  const setup = ok(await as(bob, 'POST', '/me/2fa/setup', { authKey: bob.authKey }), '2fa setup');
  const en = ok(await as(bob, 'POST', '/me/2fa/enable', { code: H.totp(setup.secret.replace(/\s/g, '')) }), '2fa enable');
  bob.backupCodes = en.backupCodes;
  // Settings, with API keys that older versions kept in plain text.
  const secrets = { giphyKey: `giphy-${H.hex(8)}`, klipyKey: `klipy-${H.hex(8)}` };
  ok(await as(owner, 'PATCH', '/admin/settings', secrets), 'settings');
  // Staff changes: audit log entries.
  ok(await as(owner, 'PUT', '/admin/staff', { userId: alice.id, role: 'moderator', authKey: owner.authKey }), 'staff'); // newer versions want the password again
  // An encrypted server: Alice's key (epoch 1) for both, a signed message with an attachment.
  const s = ok(await as(alice, 'POST', '/servers', { name: 'upgrade' }), 'server');
  const code = ok(await as(alice, 'POST', `/servers/${s.id}/invites`, {}), 'invite').code;
  ok(await as(bob, 'POST', `/invites/${code}/join`, {}), 'join');
  const raw = E2.newGroupKey();
  const wraps = {}; const pubs = {};
  for (const u of [alice, bob]) {
    wraps[u.id] = await E2.wrapGroupKey({ raw, serverId: s.id, epoch: 1, recipientId: u.id, recipientPub: u.publicKey, wrapperId: alice.id, signKey: alice.signKey });
    pubs[u.id] = u.publicKey;
  }
  ok(await as(alice, 'POST', `/servers/${s.id}/keys/rotate`, { epoch: 1, check: await E2.keyCheck(raw, s.id, 1), wraps, pubs }), 'rotate');
  const ch = s.channels.find((c) => c.type === 'text').id;
  const fileBytes = crypto.randomBytes(20000);
  const ef = await E2.encryptFile(fileBytes);
  const fd = new FormData(); fd.append('file', new Blob([ef.blob]), 'blob.bin');
  const up = ok(await api('POST', '/upload/encrypted', { token: alice.token, ip: alice.ip, form: fd }), 'upload');
  const text = 'written before the upgrade';
  const ciphertext = await E2.encryptGroup({ raw, serverId: s.id, channelId: ch, epoch: 1, authorId: alice.id, signKey: alice.signKey, payload: { t: text, f: [{ url: up.url, k: ef.k, name: 'a.bin', type: 'application/octet-stream', size: fileBytes.length }] } });
  const msg = ok(await as(alice, 'POST', `/channels/${ch}/messages`, { ciphertext, epoch: 1, files: [up.url] }), 'message');
  // A DM, Alice to Bob.
  const dm = ok(await as(alice, 'POST', '/dms', { userId: bob.id }), 'dm');
  const dmText = 'a direct message from before the upgrade';
  const dmCt = await E2.encryptDm({ myPriv: alice.privateKey, theirPub: bob.publicKey, dmId: dm.id, authorId: alice.id, payload: { t: dmText } });
  const dmMsg = ok(await as(alice, 'POST', `/dms/${dm.id}/messages`, { ciphertext: dmCt }), 'dm message');
  const strip = (u) => ({ username: u.username, password: u.password, authKey: u.authKey, token: u.token, id: u.id, ip: u.ip, publicKey: u.publicKey, signPublicKey: u.signPublicKey, ...(u.backupCodes ? { backupCodes: u.backupCodes } : {}) });
  return {
    madeBy: config.version, users: { owner: strip(owner), alice: strip(alice), bob: strip(bob) },
    serverId: s.id, channelId: ch, channelMsg: { id: msg.id, text, ciphertext }, dmId: dm.id, dmMsg: { id: dmMsg.id, text: dmText, ciphertext: dmCt },
    file: { name: path.basename(up.url), sha256: sha(Buffer.from(ef.blob)), plainSha256: sha(fileBytes) },
    secrets, auditActions: ['registration', 'role_moderator'],
  };
}

// ------------------------------------------------------------------ verify (runs against the NEW version)
// round: which of Bob's backup codes to use (each works once).
async function verify({ base, dataDir, state, round = 0, expectSchema }) {
  const E2 = await crypto2();
  const api = client(base);
  const facts = [];
  const { owner, alice, bob } = state.users;
  // Sign-in: the owner, Alice the way the app does it (her password opens her key), Bob with a backup code.
  ok(await api('POST', '/auth/login', { ip: H.newIp(), body: { username: owner.username, authKey: owner.authKey } }), 'owner sign-in');
  const params = ok(await api('GET', `/auth/params?username=${alice.username}`, { ip: H.newIp() }), 'params');
  const k = await E2.deriveKeys(alice.username, alice.password, params);
  const a = ok(await api('POST', '/auth/login', { ip: H.newIp(), body: { username: alice.username, authKey: k.authKey } }), 'alice sign-in');
  const alicePriv = await E2.unwrapPrivateKey(k.wrapKey, a.encPrivateKey);
  assert.equal(a.user.publicKey, alice.publicKey, 'Alice keeps her identity key');
  const bobNoCode = await api('POST', '/auth/login', { ip: H.newIp(), body: { username: bob.username, authKey: bob.authKey } });
  assert.equal(bobNoCode.json && bobNoCode.json.code, 'need_2fa', 'Bob still needs his second factor');
  const b = ok(await api('POST', '/auth/login', { ip: H.newIp(), body: { username: bob.username, authKey: bob.authKey, backupCode: bob.backupCodes[round] } }), 'bob sign-in with a backup code');
  const bp = await E2.deriveKeys(bob.username, bob.password, ok(await api('GET', `/auth/params?username=${bob.username}`, { ip: H.newIp() }), 'params'));
  const bobPriv = await E2.unwrapPrivateKey(bp.wrapKey, b.encPrivateKey);
  facts.push('owner, Alice (password-derived key) and Bob (backup code) sign in; Bob still needs 2FA');
  // Sessions from before the upgrade still work.
  for (const u of [owner, alice, bob]) assert.equal((await api('GET', '/bootstrap', { token: u.token, ip: u.ip })).status, 200, `${u.username}'s old session`);
  facts.push('sessions from before the upgrade still work');
  // The same keys open the messages: the server key Alice wrapped, her signed post, the attachment, the DM.
  const st = ok(await api('GET', `/servers/${state.serverId}/keys`, { token: a.token, ip: H.newIp() }), 'keys');
  const wrap = st.keys.find((x) => x.epoch === 1);
  const raw = await E2.unwrapGroupKey({ wrapped: wrap.wrapped, serverId: state.serverId, epoch: 1, myId: alice.id, myPriv: alicePriv, wrapperId: wrap.wrapperId, wrapperSignPub: alice.signPublicKey });
  const msgs = ok(await api('GET', `/channels/${state.channelId}/messages`, { token: a.token, ip: H.newIp() }), 'messages').messages;
  const m = msgs.find((x) => x.id === state.channelMsg.id);
  assert.equal(m.ciphertext, state.channelMsg.ciphertext, 'stored byte for byte');
  const opened = await E2.decryptGroup({ raw, serverId: state.serverId, channelId: state.channelId, authorId: alice.id, authorSignPub: alice.signPublicKey, text: m.ciphertext });
  assert.equal(opened.payload.t, state.channelMsg.text);
  assert.equal(opened.verified, true, 'Alice\'s signature checks out');
  const blob = Buffer.from(await (await fetch(`${base}/uploads/${state.file.name}`)).arrayBuffer());
  assert.equal(sha(blob), state.file.sha256, 'attachment byte-equal');
  assert.equal(sha(Buffer.from(await E2.decryptFile(opened.payload.f[0].k, blob))), state.file.plainSha256, 'attachment decrypts');
  const dmRows = ok(await api('GET', `/dms/${state.dmId}/messages`, { token: b.token, ip: H.newIp() }), 'dm').messages;
  const dmm = dmRows.find((x) => x.id === state.dmMsg.id);
  const dmOpen = await E2.decryptDm({ myPriv: bobPriv, theirPub: alice.publicKey, dmId: state.dmId, authorId: alice.id, text: dmm.ciphertext });
  assert.equal(dmOpen.payload.t, state.dmMsg.text);
  facts.push('channel message (signed), DM and attachment open with the same keys; files byte-equal');
  // Secrets: sealed with secret.key now, and still the same keys underneath.
  const Database = require('better-sqlite3');
  const d = new Database(path.join(dataDir, 'hearth.db'), { readonly: true });
  let schema;
  try {
    schema = d.pragma('user_version', { simple: true });
    const atRest = Buffer.from(fs.readFileSync(path.join(dataDir, 'secret.key'), 'utf8').trim(), 'hex');
    for (const [key, want] of Object.entries(state.secrets)) {
      const v = d.prepare('SELECT value FROM instance_settings WHERE key = ?').get(key).value;
      assert.ok(v.startsWith('sealed:'), `${key} is sealed`);
      assert.ok(!v.includes(want), `${key} isn't readable in the database`);
      const [iv, tag, ct] = v.slice(7).split('.').map((x) => Buffer.from(x, 'base64'));
      const dc = crypto.createDecipheriv('aes-256-gcm', atRest, iv); dc.setAuthTag(tag);
      assert.equal(JSON.parse(Buffer.concat([dc.update(ct), dc.final()]).toString()).k, want, `${key} opens with secret.key`);
    }
  } finally { d.close(); }
  const set = ok(await api('GET', '/admin/settings', { token: owner.token, ip: owner.ip }), 'settings');
  assert.equal(set.giphyKeyHint.slice(-4), state.secrets.giphyKey.slice(-4), 'and the server still uses it');
  facts.push('API keys sealed with secret.key (not readable in the database), and still used by the server');
  // The audit log: the old entries are there and the chain verifies.
  const v = ok(await api('GET', '/admin/log/verify', { token: owner.token, ip: owner.ip }), 'audit verify');
  assert.equal(v.ok, true, `audit log: ${JSON.stringify(v)}`);
  const log = ok(await api('GET', '/admin/log', { token: owner.token, ip: owner.ip }), 'audit log');
  for (const act of state.auditActions) assert.ok(log.some((e) => e.action === act), `audit entry ${act}`);
  facts.push(`audit log verifies (${v.entries} entries, the old ones included)`);
  if (expectSchema) assert.equal(schema, expectSchema, 'database version');
  const copies = fs.existsSync(path.join(dataDir, 'backups')) ? fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.startsWith('hearth-before-') && f.endsWith('.db')) : [];
  if (state.schema && expectSchema && state.schema < expectSchema) {
    assert.equal(copies.length, 1, 'exactly one pre-upgrade copy, however often it restarted');
    facts.push(`database version ${state.schema} → ${schema}; one pre-upgrade copy (${copies[0]})`);
  } else facts.push(`database version ${schema}`);
  return facts;
}

// ------------------------------------------------------------------ fixture bundles
// gzip( one JSON line { state, files: [{ name, size }] } + the files' bytes ), small enough to commit.
function pack(dataDir, state, out) {
  const names = ['hearth.db', 'secret.key', 'vapid.json', 'audit-anchor.json'].filter((f) => fs.existsSync(path.join(dataDir, f)));
  for (const f of fs.readdirSync(path.join(dataDir, 'uploads'))) names.push(`uploads/${f}`);
  if (fs.existsSync(path.join(dataDir, 'hearth.db-wal')) && fs.statSync(path.join(dataDir, 'hearth.db-wal')).size) throw new Error('Stop the server first (its database still has a write-ahead log).');
  const bufs = names.map((n) => fs.readFileSync(path.join(dataDir, n)));
  const head = Buffer.from(JSON.stringify({ state, files: names.map((name, i) => ({ name, size: bufs[i].length })) }) + '\n');
  fs.writeFileSync(out, zlib.gzipSync(Buffer.concat([head, ...bufs]), { level: 9 }));
  return fs.statSync(out).size;
}
function unpack(file, dataDir) {
  const all = zlib.gunzipSync(fs.readFileSync(file));
  const nl = all.indexOf(10);
  const { state, files } = JSON.parse(all.subarray(0, nl).toString());
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  let pos = nl + 1;
  for (const f of files) {
    if (!/^(hearth\.db|secret\.key|vapid\.json|audit-anchor\.json|uploads\/[\w.-]+)$/.test(f.name)) throw new Error(`Unexpected file in fixture: ${f.name}`);
    fs.writeFileSync(path.join(dataDir, f.name), all.subarray(pos, pos + f.size), { mode: 0o600 });
    pos += f.size;
  }
  return state;
}

async function main() {
  const [cmd, a, b, c, d] = process.argv.slice(2);
  if (cmd === 'seed') {
    const state = await seed({ base: a, codeRoot: path.resolve(b) });
    fs.writeFileSync(c, JSON.stringify(state, null, 1));
    console.log(`Seeded ${a} (Hearth ${state.madeBy}): 3 accounts, an encrypted server, a DM, an attachment, settings and audit entries.`);
  } else if (cmd === 'verify') {
    const state = JSON.parse(fs.readFileSync(c, 'utf8'));
    const facts = await verify({ base: a, dataDir: path.resolve(b), state, round: Number(d) || 0, expectSchema: Number(process.env.EXPECT_SCHEMA) || 0 });
    for (const f of facts) console.log(`  ok  ${f}`);
  } else if (cmd === 'stamp') {
    // Records the database version the old server left (read straight from the file header).
    const state = JSON.parse(fs.readFileSync(b, 'utf8'));
    state.schema = require('../server/backup').schemaOf(path.join(path.resolve(a), 'hearth.db'));
    fs.writeFileSync(b, JSON.stringify(state, null, 1));
    console.log(state.schema);
  } else if (cmd === 'pack') {
    const state = JSON.parse(fs.readFileSync(b, 'utf8'));
    console.log(`Fixture: ${c} (${(pack(path.resolve(a), state, c) / 1024).toFixed(0)} KB)`);
  } else {
    console.error('Usage: node scripts/upgrade-drill.js seed BASE CODE_ROOT STATE | verify BASE DATA_DIR STATE [ROUND] | stamp DATA_DIR STATE | pack DATA_DIR STATE OUT');
    process.exitCode = 1;
  }
}
if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });

module.exports = { seed, verify, pack, unpack };
