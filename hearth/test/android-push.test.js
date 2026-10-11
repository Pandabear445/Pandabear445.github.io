// The Android app's notifications when it's closed (UnifiedPush delivering the Web Push the server already
// sends), its calls that keep going with the screen locked, and invite links that open in the app.
//
// Server side, against a fake push service ("ntfy") that decrypts every message exactly like the phone's push
// library would (RFC 8291, keys made the same way): what a notification may contain, how big it is, which push
// services the server talks to, and what happens when one refuses. Then the app's own logic: the plain Java
// classes compiled and run with javac (skipped without a JDK), the page's bridge module, the build patcher and
// static checks on the code that can only run on a phone. What only a real phone can show is listed in
// mobile/README.md ("Not yet tested on a device").
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ece = require('http_ece');
const { startServer, hex, b64, sleep } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const listen = (server, host = '127.0.0.1', port = 0) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
const closeAll = (server) => { try { server.closeAllConnections(); } catch { /* not http */ } return new Promise((r) => server.close(() => r())); };
const waitFor = async (fn, ms = 6000) => { for (let i = 0; i < ms / 50; i++) { if (await fn()) return true; await sleep(50); } return false; };

// ------------------------------------------------------------------ a fake push service that decrypts
// Keys made the way the phone's push library makes them: a P-256 key pair (public key uncompressed, base64url
// without padding: 87 characters) and a 16-byte auth secret (22 characters).
const keyring = new Map(); // path → { ecdh, auth }
function phoneKeys() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
const hits = []; // { path, status, headers, encLen, plain, payload, at }
// The answer depends on the path: /ok/ delivered, /gone/ unsubscribed, /slow429/ "too many", /err/ broken,
// /nosub/ ntfy's "nobody listens on this topic", /deny/ an access rule that refuses.
const ANSWER = { ok: 201, gone: 410, slow429: 429, err: 500, nosub: 507, deny: 403 };
let work; let tlsPems; let ntfy; let ntfyPort; let other; let otherPort; let otherConns = 0;
let srv; let hosts;
const DNS = {};

function pushService(onConn) {
  const s = https.createServer({ key: tlsPems.private, cert: tlsPems.cert }, (req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      const k = keyring.get(req.url);
      let plain = null; let payload = null;
      try { plain = ece.decrypt(body, { version: 'aes128gcm', privateKey: k.ecdh, authSecret: k.auth }); payload = JSON.parse(plain.toString('utf8')); } catch { /* undecryptable */ }
      const status = ANSWER[req.url.split('/')[1]] || 404;
      hits.push({ path: req.url, status, headers: req.headers, encLen: body.length, plain, payload, at: Date.now() });
      res.writeHead(status, status === 429 ? { 'retry-after': '120' } : {});
      res.end();
    });
  });
  if (onConn) s.on('connection', onConn);
  return s;
}
const hitsFor = (p) => hits.filter((h) => h.path === p);

before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-androidpush-'));
  // One certificate for every fake host name, trusted by both Hearth servers.
  tlsPems = await require('selfsigned').generate([{ name: 'commonName', value: 'ntfy.test' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' },
      ...['localhost', 'a.allowed.test', 'ntfy.lan', 'other.lan', 'other.test'].map((value) => ({ type: 2, value }))] }],
  });
  fs.writeFileSync(path.join(work, 'ca.pem'), tlsPems.cert);
  ntfy = pushService(); ntfyPort = await listen(ntfy);
  other = pushService(() => { otherConns++; }); otherPort = await listen(other);
  // Fake DNS for the second server (the same preload outbound-hardening.test.js uses).
  Object.assign(DNS, { 'a.allowed.test': ['127.0.0.1'], 'ntfy.lan': ['127.0.0.1'], 'other.lan': ['127.0.0.1'], 'other.test': ['127.0.0.1'] });
  const preload = path.join(work, 'fake-dns.js');
  fs.writeFileSync(preload, `
const ng = require(${JSON.stringify(path.join(ROOT, 'server', 'netguard.js'))});
const map = JSON.parse(process.env.FAKE_DNS || '{}');
ng.setResolver(async (host) => {
  const a = map[host.toLowerCase()];
  if (!a) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
});
`);
  const common = { NODE_EXTRA_CA_CERTS: path.join(work, 'ca.pem'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  srv = await startServer({ ...common, PUSH_ALLOW_PRIVATE: '1', PUSH_NTFY_URL: 'https://ntfy.example.com/some/path', LOG_FORMAT: 'json',
    ANDROID_CERT_SHA256: `${'AB:'.repeat(31)}CD, not-a-fingerprint`, ANDROID_PACKAGE: 'app.hearth.mobile' });
  // Locked down: only *.allowed.test and ntfy.lan, and ntfy.lan (a LAN address) is the only private one let
  // through, on the fake service's own port.
  hosts = await startServer({ ...common, NODE_OPTIONS: `--require ${preload}`, FAKE_DNS: JSON.stringify(DNS),
    PUSH_HOSTS: '*.allowed.test, ntfy.lan, other.lan', PUSH_PRIVATE_HOSTS: `ntfy.lan:${ntfyPort},a.allowed.test:${ntfyPort}`, PUSH_NTFY_URL: 'http://ntfy.example.com' });
});
after(async () => {
  if (srv) await srv.stop();
  if (hosts) await hosts.stop();
  if (ntfy) await closeAll(ntfy);
  if (other) await closeAll(other);
  fs.rmSync(work, { recursive: true, force: true });
});

const as = (s, u, method, p, body, token = u.token) => s.api(method, p, { token, ip: u.ip, body });
// Subscribes `u` the way the page does after the app hands it an endpoint; returns the endpoint.
async function subscribe(s, u, kind = 'ok', { base = `https://127.0.0.1:${ntfyPort}`, replaces, expect = 200 } = {}) {
  const p = `/${kind}/up${hex(10)}`;
  const k = phoneKeys();
  keyring.set(p, k);
  const r = await as(s, u, 'POST', '/push/subscribe', { subscription: { endpoint: base + p, keys: k.keys }, ...(replaces !== undefined ? { replaces } : {}) });
  assert.equal(r.status, expect, r.text);
  return { endpoint: base + p, path: p, r };
}
// A DM line between two people (made friends); returns a function that sends one message from `from`.
async function dmLine(s, from, to) {
  assert.equal((await as(s, from, 'POST', '/friends', { username: to.username })).status, 200);
  assert.equal((await as(s, to, 'POST', `/friends/${from.id}/accept`)).status, 200);
  const dm = (await as(s, from, 'POST', '/dms', { userId: to.id })).json;
  const send = async () => { const r = await as(s, from, 'POST', `/dms/${dm.id}/messages`, { ciphertext: 'v2:' + b64(60) }); assert.equal(r.status, 200, r.text); return r.json; };
  send.dm = dm;
  return send;
}
const rows = (s, uid) => s.sql('SELECT * FROM push_subs WHERE user_id = ? ORDER BY created_at', uid);

// ================================================================== server
test('android-push-1: a UnifiedPush endpoint with phone-style keys subscribes and gets a decryptable payload with no message text, under the 4096-byte limit', async () => {
  const phone = await srv.register(); const friend = await srv.register();
  const send = await dmLine(srv, friend, phone);
  const { path: p } = await subscribe(srv, phone);
  const before = Date.now();
  const msg = await send();
  assert.ok(await waitFor(() => hitsFor(p).length === 1), 'one push arrived');
  const h = hitsFor(p)[0];
  assert.equal(h.status, 201);
  assert.ok(h.payload, 'it decrypts with the phone’s keys');
  assert.equal(h.headers['content-encoding'], 'aes128gcm');
  assert.match(h.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/, 'signed with the server’s VAPID key (RFC 8292)');
  assert.equal(h.headers.urgency, 'high');
  for (const k of Object.keys(h.payload)) assert.ok(['title', 'body', 'tag', 'url', 'at', 'generic', '_'].includes(k), `unexpected field ${k}`);
  assert.equal(h.payload.body, 'New message', 'previews are hidden by default');
  assert.equal(h.payload.title, srv.config.name, 'the instance name, not who wrote');
  assert.equal(h.payload.tag, 'd:' + send.dm.id);
  assert.equal(h.payload.url, '/#m/' + msg.id);
  assert.doesNotMatch(h.plain.toString(), new RegExp(friend.username), 'the sender’s name isn’t in it');
  assert.ok(h.payload.at >= before - 1000 && h.payload.at <= Date.now() + 1000, 'stamped with when it was sent');
  assert.ok(h.encLen <= 4096, `encrypted ${h.encLen} bytes`);
  assert.ok(h.plain.length <= 3072 && h.plain.length % 256 === 0, `plaintext ${h.plain.length} bytes, padded to 256`);
});

test('android-push-2: subscribe refuses keys that are not a P-256 point and a 16-byte secret', async () => {
  const u = await srv.register();
  const good = phoneKeys().keys;
  const pub = Buffer.from(good.p256dh, 'base64url');
  const bad = [
    { ...good, p256dh: pub.subarray(0, 64).toString('base64url') }, // 64 bytes
    { ...good, p256dh: Buffer.concat([Buffer.from([0x02]), pub.subarray(1)]).toString('base64url') }, // not uncompressed
    { ...good, p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString('base64url') }, // off the curve
    { ...good, auth: crypto.randomBytes(15).toString('base64url') },
    { ...good, auth: crypto.randomBytes(17).toString('base64url') },
    { ...good, p256dh: good.p256dh.slice(0, 80) + '!@#$%^&' },
    { ...good, auth: 'x'.repeat(5000) },
    { p256dh: good.p256dh }, { auth: good.auth }, null, 'keys',
  ];
  for (const keys of bad) {
    const r = await as(srv, u, 'POST', '/push/subscribe', { subscription: { endpoint: `https://127.0.0.1:${ntfyPort}/ok/bad${hex(4)}`, keys } });
    assert.equal(r.status, 400, JSON.stringify(keys));
  }
  for (const replaces of [123, { x: 1 }, 'x'.repeat(1001)]) {
    const r = await as(srv, u, 'POST', '/push/subscribe', { subscription: { endpoint: `https://127.0.0.1:${ntfyPort}/ok/r${hex(4)}`, keys: good }, replaces });
    assert.equal(r.status, 400, `replaces ${JSON.stringify(replaces).slice(0, 30)}`);
  }
  assert.equal(rows(srv, u.id).length, 0, 'nothing stored');
  // Standard (padded) base64url, as some browsers send it, is fine.
  const k = phoneKeys().keys;
  const r = await as(srv, u, 'POST', '/push/subscribe', { subscription: { endpoint: `https://127.0.0.1:${ntfyPort}/ok/pad${hex(4)}`, keys: { p256dh: k.p256dh + '=', auth: k.auth + '==' } } });
  assert.equal(r.status, 200, r.text);
  // Not signed in: refused.
  assert.equal((await srv.api('POST', '/push/subscribe', { body: { subscription: { endpoint: `https://127.0.0.1:${ntfyPort}/ok/x`, keys: k } } })).status, 401);
});

test('android-push-3: "replaces" removes the caller’s old endpoint in the same step, never someone else’s', async () => {
  const a = await srv.register(); const b = await srv.register();
  const e1 = await subscribe(srv, a);
  const e2 = await subscribe(srv, a, 'ok', { replaces: e1.endpoint });
  assert.deepEqual(rows(srv, a.id).map((x) => x.endpoint), [e2.endpoint], 'only the new endpoint is left');
  // B can't remove A's endpoint by naming it.
  const e3 = await subscribe(srv, b, 'ok', { replaces: e2.endpoint });
  assert.deepEqual(rows(srv, a.id).map((x) => x.endpoint), [e2.endpoint], 'A keeps theirs');
  assert.deepEqual(rows(srv, b.id).map((x) => x.endpoint), [e3.endpoint]);
  // A phone that changes endpoint while its account has ten devices stays one device and pushes nobody else out.
  const c = await srv.register();
  const first = await subscribe(srv, c);
  const sid = rows(srv, c.id)[0].session_id;
  const devices = [first.endpoint];
  for (let i = 1; i < 10; i++) {
    const e = `https://127.0.0.1:${ntfyPort}/ok/dev${i}${hex(4)}`;
    srv.sql('INSERT INTO push_subs (endpoint, user_id, keys, ua, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?)', e, c.id, JSON.stringify(phoneKeys().keys), 'test', Date.now() + i, sid);
    devices.push(e);
  }
  assert.equal(rows(srv, c.id).length, 10);
  const moved = await subscribe(srv, c, 'ok', { replaces: devices[5] });
  const left = rows(srv, c.id).map((x) => x.endpoint);
  assert.equal(left.length, 10);
  assert.ok(!left.includes(devices[5]) && left.includes(moved.endpoint) && left.includes(devices[0]), 'the oldest device is kept; only the replaced one went');
  // Naming the endpoint itself (or nothing) just saves it again.
  assert.equal((await as(srv, b, 'POST', '/push/subscribe', { subscription: { endpoint: e3.endpoint, keys: phoneKeys().keys }, replaces: e3.endpoint })).status, 200);
  assert.equal((await as(srv, b, 'POST', '/push/subscribe', { subscription: { endpoint: e3.endpoint, keys: phoneKeys().keys }, replaces: null })).status, 200);
  assert.ok(rows(srv, b.id).some((x) => x.endpoint === e3.endpoint));
});

test('android-push-4: PUSH_HOSTS limits which push services can be subscribed and sent to', async () => {
  const u = await hosts.register(); const friend = await hosts.register();
  const send = await dmLine(hosts, friend, u);
  const no = await subscribe(hosts, u, 'ok', { base: `https://other.test:${otherPort}`, expect: 400 });
  assert.match(no.r.json.error, /doesn.t send notifications through that push service/);
  for (const endpoint of [`https://evil.allowed.test.example:${ntfyPort}/ok/x`, `https://allowed.test:${ntfyPort}/ok/x`, `http://a.allowed.test:${ntfyPort}/ok/x`]) {
    const r = await as(hosts, u, 'POST', '/push/subscribe', { subscription: { endpoint, keys: phoneKeys().keys } });
    assert.equal(r.status, 400, endpoint);
  }
  const yes = await subscribe(hosts, u, 'ok', { base: `https://a.allowed.test:${ntfyPort}` });
  // A row from before PUSH_HOSTS was set: dropped at send time, never contacted.
  const k = phoneKeys();
  const stale = `https://other.test:${otherPort}/ok/stale${hex(4)}`;
  keyring.set(new URL(stale).pathname, k);
  hosts.sql('INSERT INTO push_subs (endpoint, user_id, keys, ua, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?)', stale, u.id, JSON.stringify(k.keys), 'test', Date.now(), rows(hosts, u.id)[0].session_id);
  const conns = otherConns;
  await send();
  assert.ok(await waitFor(() => hitsFor(yes.path).length === 1), 'the allowed service got it');
  assert.ok(await waitFor(() => !rows(hosts, u.id).some((x) => x.endpoint === stale)), 'the disallowed row is dropped');
  assert.equal(otherConns, conns, 'not even a connection to the disallowed host');
});

test('android-push-5: PUSH_PRIVATE_HOSTS lets one named LAN push service through and nothing else private', async () => {
  const u = await hosts.register(); const friend = await hosts.register();
  const send = await dmLine(hosts, friend, u);
  // other.lan is on PUSH_HOSTS but has a private address and isn't named in PUSH_PRIVATE_HOSTS.
  const r = await subscribe(hosts, u, 'ok', { base: `https://other.lan:${ntfyPort}`, expect: 400 });
  assert.match(r.r.json.error, /Bad subscription/);
  // ntfy.lan on another port than the one named: refused too.
  await subscribe(hosts, u, 'ok', { base: `https://ntfy.lan:${otherPort}`, expect: 400 });
  const lan = await subscribe(hosts, u, 'ok', { base: `https://ntfy.lan:${ntfyPort}` });
  await send();
  assert.ok(await waitFor(() => hitsFor(lan.path).length === 1), 'delivered to the LAN ntfy');
  assert.ok(hitsFor(lan.path)[0].payload, 'and it decrypts');
});

test('android-push-6: a push service answering 429 sits out for Retry-After and is kept; 5xx, 403 and 507 count as failures and are dropped after 8', async () => {
  const u = await srv.register(); const friend = await srv.register();
  const send = await dmLine(srv, friend, u);
  const slow = await subscribe(srv, u, 'slow429');
  await send();
  assert.ok(await waitFor(() => hitsFor(slow.path).length === 1));
  assert.ok(await waitFor(() => (rows(srv, u.id)[0] || {}).retry_at > 0));
  let row = rows(srv, u.id)[0];
  assert.equal(row.fails, 0, '429 is not a failure');
  assert.ok(Math.abs(row.retry_at - (Date.now() + 120000)) < 10000, `retry in ~120 s (Retry-After), got ${row.retry_at - Date.now()} ms`);
  await send();
  await sleep(500);
  assert.equal(hitsFor(slow.path).length, 1, 'nothing sent while it sits out');
  srv.sql('DELETE FROM push_subs WHERE user_id = ?', u.id);

  const err = await subscribe(srv, u, 'err');
  await send();
  assert.ok(await waitFor(() => (rows(srv, u.id)[0] || {}).fails === 1), 'a 500 is a failure');
  row = rows(srv, u.id)[0];
  assert.ok(Math.abs(row.retry_at - (Date.now() + 60000)) < 10000, 'backs off a minute');
  assert.equal(hitsFor(err.path).length, 1);
  srv.sql('DELETE FROM push_subs WHERE user_id = ?', u.id);
  // Someone else's device on the same push service fails the same way: one log line covers both.
  const u2 = await srv.register(); const f2 = await srv.register();
  const send2 = await dmLine(srv, f2, u2);
  const err2 = await subscribe(srv, u2, 'err');
  await send2();
  assert.ok(await waitFor(() => hitsFor(err2.path).length === 1));

  const deny = await subscribe(srv, u, 'deny');
  await send();
  assert.ok(await waitFor(() => (rows(srv, u.id)[0] || {}).fails === 1), 'a 403 (an ntfy access rule) is a failure');
  assert.equal(hitsFor(deny.path).length, 1);
  srv.sql('DELETE FROM push_subs WHERE user_id = ?', u.id);

  const nosub = await subscribe(srv, u, 'nosub');
  srv.sql('UPDATE push_subs SET fails = 7, retry_at = NULL WHERE endpoint = ?', nosub.endpoint);
  await send();
  assert.ok(await waitFor(() => rows(srv, u.id).length === 0), 'the eighth failure in a row (507) drops it');
  // A delivered push after failures resets the count.
  const ok = await subscribe(srv, u);
  srv.sql('UPDATE push_subs SET fails = 3, retry_at = NULL WHERE endpoint = ?', ok.endpoint);
  await send();
  assert.ok(await waitFor(() => (rows(srv, u.id)[0] || {}).fails === 0));
  // The operator sees which push service refused (by host only), once.
  assert.ok(await waitFor(() => /"op":"refused"/.test(srv.log)));
  const lines = srv.log.split('\n').filter((l) => /"op":"refused"/.test(l));
  assert.ok(lines.every((l) => !/\/(err|deny|nosub|slow429)\//.test(l)), 'never the endpoint itself');
  assert.equal(lines.filter((l) => /"status":500/.test(l)).length, 1, 'at most once an hour per host and answer');
});

test('android-push-7: payloads are padded to 256-byte steps, capped, and stamped with the time', async () => {
  const owner = srv.owner; const u = await srv.register();
  // Previews "names": the lock screen may show who and where, so names travel (encrypted).
  assert.equal((await as(srv, u, 'PUT', '/me/notify-settings', { previews: 'names' })).status, 200);
  const server = (await as(srv, owner, 'POST', '/servers', { name: 'Padding' })).json;
  const ch = server.channels.find((c) => c.type === 'text');
  const code = (await as(srv, owner, 'POST', `/servers/${server.id}/invites`, { expiresHours: 0 })).json.code;
  assert.equal((await as(srv, u, 'POST', `/invites/${code}/join`)).status, 200);
  const { path: p } = await subscribe(srv, u);
  // Names longer than the app would ever allow (written straight into the database): still capped.
  srv.sql('UPDATE servers SET name = ?, key_epoch = 1, needs_rotation = 0 WHERE id = ?', 'é'.repeat(400), server.id);
  const sent = Date.now();
  const r = await as(srv, owner, 'POST', `/channels/${ch.id}/messages`, { ciphertext: 'v2:' + b64(48), epoch: 1, mentions: [u.id] });
  assert.equal(r.status, 200, r.text);
  assert.ok(await waitFor(() => hitsFor(p).length === 1));
  const h = hitsFor(p)[0];
  assert.equal(h.plain.length % 256, 0, `${h.plain.length} bytes`);
  assert.ok(h.plain.length <= 3072);
  assert.match(h.payload.title, /mentioned you$/);
  assert.ok([...h.payload.body].length <= 300 && [...h.payload.title].length <= 200, 'capped');
  assert.ok(h.payload.body.startsWith('#'), 'names shown with previews "names"');
  assert.ok(Math.abs(h.payload.at - sent) < 5000, 'stamped with the send time');
  assert.match(h.payload._, /^ *$/, 'the padding is only spaces');
  // A short one is padded too: two different names give the same size.
  srv.sql('UPDATE servers SET name = ? WHERE id = ?', 'ab', server.id);
  await as(srv, owner, 'POST', `/channels/${ch.id}/messages`, { ciphertext: 'v2:' + b64(48), epoch: 1, mentions: [u.id] });
  assert.ok(await waitFor(() => hitsFor(p).length === 2));
  srv.sql('UPDATE servers SET name = ? WHERE id = ?', 'abcdefghijklmnopqrstuvwxyz', server.id);
  await as(srv, owner, 'POST', `/channels/${ch.id}/messages`, { ciphertext: 'v2:' + b64(48), epoch: 1, mentions: [u.id] });
  assert.ok(await waitFor(() => hitsFor(p).length === 3));
  assert.equal(hitsFor(p)[1].encLen, hitsFor(p)[2].encLen, 'the push service sees the same size');
});

test('android-push-8: a call push opens the call (#call/<room>) and says only "Incoming call" by default', async () => {
  const caller = await srv.register(); const callee = await srv.register();
  const send = await dmLine(srv, caller, callee);
  const { path: p } = await subscribe(srv, callee);
  const s = await srv.socket(caller.token);
  try {
    const res = await new Promise((resolve) => s.emit('voice:join', { channelId: 'dm:' + send.dm.id }, resolve));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(await waitFor(() => hitsFor(p).length === 1));
    const pl = hitsFor(p)[0].payload;
    assert.equal(pl.tag, 'call:dm:' + send.dm.id);
    assert.equal(pl.url, '/#call/dm:' + send.dm.id);
    assert.equal(pl.body, 'Incoming call');
    assert.ok(typeof pl.at === 'number' && Math.abs(pl.at - Date.now()) < 10000, 'the phone can tell a fresh ring from a stale one');
  } finally { s.close(); }
});

test('android-push-9: signing out stops pushes to the phone’s UnifiedPush endpoint', async () => {
  const u = await srv.register(); const friend = await srv.register();
  const send = await dmLine(srv, friend, u);
  const { path: p } = await subscribe(srv, u);
  assert.equal((await as(srv, u, 'POST', '/auth/logout')).status, 200);
  assert.equal(rows(srv, u.id).length, 0, 'the row went with the session');
  await send();
  await sleep(700);
  assert.equal(hitsFor(p).length, 0);
  // Unsubscribing only ever removes your own.
  const v = await srv.register(); const w = await srv.register();
  const ev = await subscribe(srv, v);
  assert.equal((await as(srv, w, 'POST', '/push/unsubscribe', { endpoint: ev.endpoint })).status, 200);
  assert.equal(rows(srv, v.id).length, 1);
});

test('android-push-10: /api/config shows PUSH_NTFY_URL only when it is https, as an origin', async () => {
  assert.equal(srv.config.pushNtfy, 'https://ntfy.example.com');
  assert.equal(hosts.config.pushNtfy, null);
  assert.match(hosts.log, /ntfy_url_ignored/);
});

test('android-push-11: /.well-known/assetlinks.json lets only the configured app open invite links', async () => {
  const r = await srv.call('GET', '/.well-known/assetlinks.json');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.deepEqual(r.json, [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'app.hearth.mobile', sha256_cert_fingerprints: [`${'AB:'.repeat(31)}CD`] } }],
    'the bad fingerprint is left out');
  const none = await hosts.call('GET', '/.well-known/assetlinks.json');
  assert.equal(none.status, 404, 'without ANDROID_CERT_SHA256 no app is vouched for (and the page isn’t served instead)');
  assert.deepEqual(none.json, []);
  // The invite page itself still loads in a browser.
  const inv = await srv.call('GET', '/invite/abcd2345');
  assert.equal(inv.status, 200);
  assert.match(inv.text, /<html/i);
});

// ================================================================== the app's plain Java (javac; skipped without a JDK)
const hasJava = () => spawnSync('javac', ['-version'], { stdio: 'ignore' }).status === 0;
// Compiles the app's pure classes with a small main that prints one line per check, and returns those lines.
function runJava(body) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-java-'));
  try {
    const src = `package app.hearth.mobile;
import java.nio.charset.StandardCharsets;
public class Check {
  static PushPayload p(String s) { return PushPayload.parse(s.getBytes(StandardCharsets.UTF_8)); }
  // Output stays ASCII whatever the console encoding is: other characters are printed as escapes.
  static String ascii(String s) { StringBuilder b = new StringBuilder(); for (char c : s.toCharArray()) b.append(c < 128 ? String.valueOf(c) : String.format("\\\\u%04x", (int) c)); return b.toString(); }
  static String show(PushPayload x) { return x == null ? "null" : ascii(x.tag + "|" + x.title + "|" + x.body + "|" + x.url + "|" + x.at + "|" + x.generic); }
  static String inv(String[] r) { return r == null ? "null" : r[0] + "|" + r[1]; }
  public static void main(String[] a) {
${body}
  }
}`;
    fs.writeFileSync(path.join(tmp, 'Check.java'), src);
    const n = (f) => path.join(ROOT, 'mobile', 'native', f);
    execFileSync('javac', ['-encoding', 'UTF-8', '-d', tmp, n('PushPolicy.java'), n('PushPayload.java'), n('InviteLinks.java'), n('BridgePolicy.java'), path.join(tmp, 'Check.java')], { stdio: 'pipe' });
    return execFileSync('java', ['-cp', tmp, 'app.hearth.mobile.Check'], { encoding: 'utf8' }).trim().split('\n');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const jstr = (s) => JSON.stringify(s); // a JSON string is a valid Java string literal for these

test('android-push-12: notification payloads are parsed strictly (javac)', { skip: !hasJava() && 'no JDK (javac) here' }, () => {
  const big = '{"tag":"c:a","_":"' + ' '.repeat(4090) + '"}';
  const cases = [
    '{"title":"Hearth","body":"New message","tag":"d:abc123","url":"/#m/xyz789","at":1760000000000,"_":"   "}',
    big, '[]', '{"title":"x"}', '{"tag":"c:<script>"}', '{"tag":"c:a"} x', '{"tag":"c:a"',
    '{"x":{"y":[1,"}",{"z":null}]},"tag":"c:abc","ok":true,"no":false,"n":null}',
    '{"tag":"c:a","title":"caf\\u00e9 \\"x\\" \\/ \\\\"}',
    '{"tag":"c:a","url":"https://evil.example/"}',
    '{"tag":"c:a","title":"one","title":"two"}',
    '{"tag":"call:dm:abc","at":"soon","generic":"Incoming call"}',
  ];
  const out = runJava(cases.map((c) => `    System.out.println(show(p(${jstr(c)})));`).join('\n') + `
    System.out.println(PushPolicy.clean("evil\\u202e\\u0000txt\\u200e", 50));
    String x = PushPolicy.clean(new String(new char[500]).replace('\\0', 'x'), 120);
    System.out.println(x.codePointCount(0, x.length()) + "|" + x.endsWith("\\u2026"));`);
  assert.deepEqual(out.slice(0, cases.length), [
    'd:abc123|Hearth|New message|/#m/xyz789|1760000000000|',
    'null', 'null', 'null', 'null', 'null', 'null',
    'c:abc|||/|0|',
    'c:a|caf\\u00e9 "x" / \\||/|0|',
    'c:a|||/|0|',
    'c:a|two||/|0|',
    'call:dm:abc|||/|0|Incoming call',
  ]);
  assert.equal(out[cases.length], 'evil txt', 'direction overrides and control characters are removed');
  assert.equal(out[cases.length + 1], '120|true', 'cut to 120 with an ellipsis');
});

test('android-push-13: a notification only ever opens an in-app address (javac, and the page agrees)', { skip: !hasJava() && 'no JDK (javac) here' }, async () => {
  const ok = ['/', '/#m/abc123', '/#c/abc', '/#d/abc', '/#call/dm:abc', '/#call/abc', '/#updates', '/#study', '/#scheduled'];
  const bad = ['https://evil.example/', '//evil.example', '/#reset=AAAAAAAAAAAAAAAAAAAAAAAA', 'javascript:alert(1)', '/#m/ABC', '/#m/abc?x', '/#call/dm:abc/x', '', '/#invite/abcd', '/x', ' /#m/abc'];
  const out = runJava([...ok, ...bad].map((u) => `    System.out.println(PushPolicy.safeOpenPath(${jstr(u)}));`).join('\n') + '\n    System.out.println(PushPolicy.safeOpenPath(null));');
  assert.deepEqual(out, [...ok, ...bad.map(() => '/'), '/']);
  const AP = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'android-push.js')).href);
  for (const u of ok) assert.equal(AP.safeOpenHash(u), u === '/' ? '' : u.slice(1), u);
  for (const u of [...bad, null, undefined]) assert.equal(AP.safeOpenHash(u), '', String(u));
  // Java and the page use the same rule.
  const javaRule = /Pattern\.compile\("(\^\/\(#[^"]+)"\)/.exec(read('mobile', 'native', 'PushPolicy.java'))[1];
  assert.equal(javaRule, AP.OPEN_RE.source.replace(/\\\//g, '/'));
  // The page follows #call/ and #d/ links (and the invite links the app hands over).
  const app = read('public', 'js', 'app.js');
  const open = app.slice(app.indexOf('function openLinkFromHash('), app.indexOf('function openCallFromLink('));
  assert.ok(open.includes('#call\\/((?:dm:)?[a-z0-9]{1,64})$') && open.includes('openCallFromLink(m[1])'), 'handles #call/');
  assert.ok(open.includes('#d\\/([a-z0-9]{1,64})$'), 'handles #d/');
  assert.ok(open.includes('#invite\\/([A-Za-z0-9]{2,64})$') && open.includes('openJoinModal(m[1])'), 'handles #invite/');
});

test('android-push-14: each server gets its own push registration; calls ring only while fresh; only the server\u2019s page manages push and calls (javac)', { skip: !hasJava() && 'no JDK (javac) here' }, () => {
  const vapid = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
  const types = ['pushRegister', 'pushPick', 'pushUnregister', 'pushState', 'callStart', 'callEnd'];
  const out = runJava(`
    String inst = PushPolicy.instanceFor("https://a.example");
    System.out.println(inst.length() + "|" + inst.equals(PushPolicy.instanceFor("https://a.example")) + "|" + inst.equals(PushPolicy.instanceFor("https://b.example")) + "|" + PushPolicy.instanceFor("").isEmpty());
    System.out.println(PushPolicy.channelFor("call:dm:x") + "|" + PushPolicy.channelFor("c:x") + "|" + PushPolicy.channelFor("d:x") + "|" + PushPolicy.channelFor("event:x") + "|" + PushPolicy.channelFor("updates-x"));
    long now = 1760000000000L;
    System.out.println(PushPolicy.freshCall(now - 119000, now) + "|" + PushPolicy.freshCall(now - 121000, now) + "|" + PushPolicy.freshCall(now + 400000, now) + "|" + PushPolicy.freshCall(0, now));
    System.out.println(PushPolicy.validVapid(${jstr(vapid)}) + "|" + PushPolicy.validVapid(${jstr(vapid + 'A')}) + "|" + PushPolicy.validVapid(${jstr('A' + vapid.slice(1))}) + "|" + PushPolicy.validVapid(null));
    String l = "https://localhost", s = "https://chat.example.com", e = "https://evil.example";
    for (String t : new String[] { ${types.map(jstr).join(', ')} })
      System.out.println(t + "|" + BridgePolicy.allowed(t, s, l, s) + "|" + BridgePolicy.allowed(t, l, l, s) + "|" + BridgePolicy.allowed(t, e, l, s) + "|" + BridgePolicy.allowed(t, s, l, ""));
    System.out.println(BridgePolicy.allowed("setServer", l, l, s) + "|" + BridgePolicy.allowed("setServer", s, l, s) + "|" + BridgePolicy.allowed("hello", l, l, s) + "|" + BridgePolicy.allowed("cancel", s, l, s));`);
  assert.deepEqual(out, [
    '17|true|false|true',
    'calls|messages|messages|activity|activity',
    'true|false|false|false',
    'true|false|false|false',
    ...types.map((t) => `${t}|true|false|false|false`),
    'true|false|true|true',
  ]);
});

test('android-push-15: invite links only ever open an invite on the app\u2019s own server (javac)', { skip: !hasJava() && 'no JDK (javac) here' }, () => {
  const links = ['hearth://invite/abcd2345', 'hearth://invite/abcd2345/', 'https://Chat.Example.com/invite/abcd2345', 'https://chat.example.com:443/invite/abcd2345',
    'https://1.2.3.4:3000/invite/abcd2345', 'hearth://invite/', 'hearth://invite/a', 'hearth://invite/ab/cd', 'hearth://evil/abcd2345', 'https://chat.example.com/invite/ab%2F..',
    'https://chat.example.com/x/invite/abcd', 'http://chat.example.com/invite/abcd2345', 'https://user@chat.example.com/invite/abcd2345', 'javascript:alert(1)',
    'hearth://invite/abcd2345?x=<script>', ''];
  const out = runJava(links.map((l) => `    System.out.println(inv(InviteLinks.parse(${jstr(l)})));`).join('\n') + `
    String s = "https://chat.example.com";
    System.out.println(InviteLinks.forServer(InviteLinks.parse("hearth://invite/abcd2345"), s) + "|" + InviteLinks.forServer(InviteLinks.parse("hearth://invite/abcd2345"), ""));
    System.out.println(InviteLinks.forServer(InviteLinks.parse("https://chat.example.com/invite/abcd2345"), s) + "|" + InviteLinks.forServer(InviteLinks.parse("https://other.example/invite/abcd2345"), s));
    System.out.println(InviteLinks.target(s, "abcd2345"));`);
  assert.deepEqual(out, [
    '|abcd2345', '|abcd2345', 'https://chat.example.com|abcd2345', 'https://chat.example.com|abcd2345', 'https://1.2.3.4:3000|abcd2345',
    ...Array(11).fill('null'),
    'true|false', 'true|false', 'https://chat.example.com/invite/abcd2345',
  ]);
});

// ================================================================== the build and the code that only runs on a phone
// What `npx cap add android` writes (Capacitor 8's template), for the build patcher.
const TEMPLATE = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:allowBackup="true" android:icon="@mipmap/ic_launcher" android:label="@string/app_name" android:theme="@style/AppTheme">
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <provider android:name="androidx.core.content.FileProvider" android:authorities="\${applicationId}.fileprovider" android:exported="false" android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths"></meta-data>
        </provider>
    </application>
    <!-- Permissions -->
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

test('android-push-16: the Android build adds UnifiedPush at an exact version, the push and call services unexported, the permissions a call needs, and invite links', () => {
  const P = require('../mobile/scripts/patch-android.js');
  const out = P.patchManifest(TEMPLATE, { server: '' });
  const push = /<service android:name="\.HearthPushService"[^>]*>[\s\S]*?<\/service>/.exec(out);
  assert.ok(push && /android:exported="false"/.test(push[0]) && /org\.unifiedpush\.android\.connector\.PUSH_EVENT/.test(push[0]), 'push service: unexported, PUSH_EVENT only');
  assert.match(out, /<service android:name="\.CallService" android:exported="false" android:foregroundServiceType="microphone" android:stopWithTask="true" \/>/);
  assert.match(out, /android\.permission\.FOREGROUND_SERVICE" \/>/);
  assert.match(out, /android\.permission\.FOREGROUND_SERVICE_MICROPHONE/);
  assert.match(out, /<data android:scheme="hearth" android:host="invite" \/>/);
  assert.doesNotMatch(out, /android:scheme="https"/, 'no App Link without a baked-in server');
  const main = /<activity[\s\S]*?<\/activity>/.exec(out)[0];
  assert.match(main, /android\.intent\.category\.LAUNCHER[\s\S]*android:scheme="hearth"/, 'the invite filter is on MainActivity');
  assert.throws(() => P.patchManifest(out), /already patched/);
  assert.throws(() => P.patchManifest(TEMPLATE.replace('</application>', '')), /application/);
  assert.throws(() => P.patchManifest(TEMPLATE.replace('android:launchMode="singleTask"', '')), /singleTask/);
  // An app built for one server opens that server's invite links itself (verified with assetlinks.json).
  const one = P.patchManifest(TEMPLATE, { server: 'https://Chat.Example.com' });
  assert.match(one, /<intent-filter android:autoVerify="true">[\s\S]*?<data android:scheme="https" android:host="chat\.example\.com" android:pathPrefix="\/invite\/" \/>/);
  assert.match(P.patchManifest(TEMPLATE, { server: 'https://1.2.3.4:3000' }), /android:host="1\.2\.3\.4" android:port="3000"/);
  for (const bad of ['http://chat.example.com', 'https://a"b.example', 'not a url', 'https://u:p@chat.example.com']) {
    assert.doesNotMatch(P.patchManifest(TEMPLATE, { server: bad }), /android:scheme="https"/, bad);
  }
  assert.match(P.gradleAdditions(), /implementation "org\.unifiedpush\.android:connector:\d+\.\d+\.\d+"/);
  assert.doesNotMatch(P.gradleAdditions(), /[+[\]]|latest/i, 'an exact version, never a range');
  // The merged manifest check (run on the real build in CI) catches a missing library receiver or a wrong service.
  assert.deepEqual(P.checkMerged(out), ["the UnifiedPush library's MessagingReceiverImpl is missing"]);
  const merged = out.replace('</application>', '<receiver android:name="org.unifiedpush.android.connector.internal.MessagingReceiverImpl" android:exported="true"></receiver></application>');
  assert.deepEqual(P.checkMerged(merged), []);
  assert.ok(P.checkMerged(merged.replace('android:name=".HearthPushService" android:exported="false"', 'android:name=".HearthPushService" android:exported="true"')).length);
  assert.ok(P.checkMerged(merged.replace('foregroundServiceType="microphone"', 'foregroundServiceType="dataSync"')).length);
  // The workflow runs it, the unit tests, and the merged manifest check (values only through env:).
  const wf = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'hearth-apps.yml'), 'utf8');
  assert.match(wf, /cp native\/\*\.java android\/app\/src\/main\/java\/app\/hearth\/mobile\/\n(\s+#.*\n)*\s+node scripts\/patch-android\.js android\n/);
  assert.match(wf, /\.\/gradlew --no-daemon assembleRelease testReleaseUnitTest \$\{BUNDLE:\+"\$BUNDLE"\}/);
  assert.match(wf, /node scripts\/patch-android\.js --check-merged "\$m"/);
  assert.ok(fs.existsSync(path.join(ROOT, 'mobile', 'native', 'test', 'PushPolicyTest.java')));
  assert.ok(fs.existsSync(path.join(ROOT, 'mobile', 'native', 'res', 'drawable', 'ic_stat_hearth.xml')));
});

test('android-push-17: the push service drops what didn\u2019t decrypt; push keys and call controls only reach the server\u2019s page; a call service needs the microphone permission', () => {
  const svc = read('mobile', 'native', 'HearthPushService.java');
  const onMessage = svc.slice(svc.indexOf('public void onMessage('));
  assert.ok(onMessage.indexOf('getDecrypted()') > 0 && onMessage.indexOf('getDecrypted()') < onMessage.indexOf('PushPayload.parse'), 'checks decryption before reading anything');
  assert.ok(onMessage.indexOf('currentInstance') < onMessage.indexOf('PushPayload.parse'), 'and that it is this server\u2019s registration');
  const main = read('mobile', 'native', 'MainActivity.java');
  const hello = main.slice(main.indexOf('case "hello"'), main.indexOf('case "setServer"'));
  assert.match(hello, /boolean server = from\.equals\(serverOrigin\(\)\);[\s\S]*info\(server\)/);
  const info = main.slice(main.indexOf('private JSONObject info('), main.indexOf('private void toPage('));
  assert.match(info, /if \(fromServer\) \{[\s\S]*o\.put\("push"/, 'push state (with keys) only for the server\u2019s page');
  const toServer = main.slice(main.indexOf('private void toServerPage('), main.indexOf('static void pushChanged('));
  assert.match(toServer, /o\.equals\(serverOrigin\(\)\)/);
  assert.match(main.slice(main.indexOf('static void pushChanged('), main.indexOf('static void hangUpFromNotification(') + 200), /toServerPage\("hearth-push"[\s\S]*toServerPage\("hearth-hangup"/);
  // Switching server removes the old server's push registration.
  const setServer = main.slice(main.indexOf('private void setServerOrigin('), main.indexOf('private static String originOf('));
  assert.match(setServer, /HearthPush\.unregister\(this, PushPolicy\.instanceFor\(old\)\)/);
  assert.equal((main.match(/putString\("server"/g) || []).length, 1, 'every server change goes through setServerOrigin');
  const bridge = read('mobile', 'native', 'BridgePolicy.java');
  assert.match(bridge, /if \(type\.startsWith\("push"\) \|\| type\.startsWith\("call"\)\) return server;/);
  // Android's rules for a microphone foreground service: the permission is granted first; the right type.
  const call = read('mobile', 'native', 'CallService.java');
  assert.match(call, /checkSelfPermission\(Manifest\.permission\.RECORD_AUDIO\)/);
  assert.match(call, /startForeground\(NOTIFICATION_ID, n, ServiceInfo\.FOREGROUND_SERVICE_TYPE_MICROPHONE\)/);
  assert.match(call, /return START_NOT_STICKY;/);
  // Notifications never carry more than the server's push says; the lock screen gets the generic version.
  const notes = read('mobile', 'native', 'HearthNotifications.java');
  assert.match(notes, /setVisibility\(Notification\.VISIBILITY_PRIVATE\)[\s\S]*setPublicVersion\(publicVersion\)/);
});

test('android-push-18: the page subscribes what the app hands it, replaces the old address, and unregisters on sign-out', async () => {
  const AP = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'android-push.js')).href);
  const sent = [];
  let p;
  const app = (onSend) => { p = AP.createAndroidPush({ send: (m) => { sent.push(m); onSend(m); }, initial: { state: 'none' }, timeoutMs: 300, stateMs: 100, unregisterMs: 100 }); return p; };
  // Registered after a moment: resolves with the address and keys.
  app((m) => {
    if (m.type === 'pushRegister') { setTimeout(() => p._reply({ type: 'pushState', state: 'pending' }), 5); setTimeout(() => p._event({ state: 'registered', endpoint: 'https://ntfy.sh/upX', p256dh: 'B'.repeat(87), auth: 'a'.repeat(22), vapid: 'V' }), 20); }
    if (m.type === 'pushState') setTimeout(() => p._reply({ type: 'pushState', state: 'registered', endpoint: 'https://ntfy.sh/upX' }), 5);
    if (m.type === 'pushUnregister') setTimeout(() => p._reply({ type: 'pushState', state: 'none' }), 5);
  });
  const changes = [];
  p.onChange((st) => changes.push(st.state));
  const st = await p.register('KEY');
  assert.equal(st.endpoint, 'https://ntfy.sh/upX');
  assert.deepEqual(sent.map((m) => m.type), ['pushRegister']);
  assert.equal(sent[0].vapid, 'KEY');
  assert.deepEqual(changes, ['registered']);
  assert.equal((await p.state()).state, 'registered');
  await p.unregister();
  assert.equal(sent.at(-1).type, 'pushUnregister');
  // "Change": the list of push apps.
  sent.length = 0;
  p.register('KEY', { choose: true }).catch(() => {});
  assert.equal(sent[0].type, 'pushPick');
  // No push app installed, a failure, notifications blocked, a cancelled list, no answer at all.
  for (const [answer, code] of [[{ state: 'noDistributor' }, 'noDistributor'], [{ state: 'failed', reason: 'NETWORK' }, 'NETWORK'], [{ state: 'blocked' }, 'blocked'], [{ state: 'none', reason: 'CANCELLED' }, 'CANCELLED']]) {
    app((m) => { if (m.type === 'pushRegister') setTimeout(() => p._event(answer), 5); });
    await assert.rejects(p.register('KEY'), (e) => e.code === code && typeof e.message === 'string', code);
  }
  app(() => {});
  await assert.rejects(p.register('KEY'), (e) => e.code === 'timeout');
  assert.equal((await p.state()).state, 'none', 'no answer: the last known state');
  assert.match(AP.reasonText.noDistributor, /ntfy/);
  assert.equal(AP.safeInviteHash('abcd2345'), '#invite/abcd2345');
  for (const bad of ['', 'a', 'ab/cd', '<script>', 'x'.repeat(65), null]) assert.equal(AP.safeInviteHash(bad), '', String(bad));
  // app.js: sign-out removes the phone's registration; enabling posts "replaces"; quiet starts never pop up a list.
  const js = read('public', 'js', 'app.js');
  const signOut = js.slice(js.indexOf('async function signOutHere('), js.indexOf('// ======================================================================= realtime'));
  assert.match(signOut, /if \(androidApp\.push \|\| \(localStorage\.getItem\('hearth\.push'\) === 'on'[\s\S]*disablePush\(\{ signOut: true \}\)/);
  const sub = js.slice(js.indexOf('async function subscribeAndroidPush('), js.indexOf('// Once per start'));
  assert.match(sub, /replaces: prev && prev !== st\.endpoint \? prev : undefined/);
  assert.match(sub, /if \(quiet && !st\.distributor\) return;/);
  const disable = js.slice(js.indexOf('async function disablePush('), js.indexOf('async function androidPushStatus('));
  assert.match(disable, /androidApp\.push\.unregister\(\)/);
  // android.js: a page that finds a registration but no sign-in (signed out while the app was closed) removes it.
  const bridgeJs = read('public', 'js', 'android.js');
  assert.match(bridgeJs, /m\.push\.state === 'registered' && !localStorage\.getItem\('hearth\.token'\)\) androidApp\.push\.unregister\(\)/);
  assert.match(bridgeJs, /send\(\{ type: 'hello', v: 2 \}\)/);
  // The call notification follows the call (started and stopped from the voice engine's changes).
  assert.match(js, /androidApp\.callState\(\{ inCall: !!voice\.channelId/);
  assert.match(js, /androidApp\.onHangUp = \(\) => \{ if \(voice && voice\.channelId\) \{ voice\.leave\(\)/);
});

test('android-push-19: opening Hearth while a call rings stops the ringtone and goes to that call, never anywhere else (javac)', { skip: !hasJava() && 'no JDK (javac) here' }, () => {
  const tags = ['call:dm:abc', 'call:abc', 'missed-call:dm:abc', 'd:abc', 'c:abc', 'call:', 'call:ABC', 'call:dm:abc/x', 'call:abc#x', 'event:abc'];
  const out = runJava(tags.map((t) => `    System.out.println(PushPolicy.ringingCallPath(${jstr(t)}));`).join('\n') + '\n    System.out.println(PushPolicy.ringingCallPath(null));');
  assert.deepEqual(out, ['/#call/dm:abc', '/#call/abc', ...tags.slice(2).map(() => 'null'), 'null']);
  // Only ringing calls are cancelled (missed calls and messages stay), and the newest one is opened like a tap.
  const notes = read('mobile', 'native', 'HearthNotifications.java');
  const stop = notes.slice(notes.indexOf('static String stopRinging('), notes.indexOf('static Notification ongoingCall('));
  assert.match(stop, /PushPolicy\.ringingCallPath\(s\.getTag\(\)\)[\s\S]*if \(p == null\) continue;[\s\S]*nm\.cancel\(s\.getTag\(\), s\.getId\(\)\)/);
  const main = read('mobile', 'native', 'MainActivity.java');
  const resume = main.slice(main.indexOf('public void onResume()'), main.indexOf('public void onPause()'));
  assert.match(resume, /String call = HearthNotifications\.stopRinging\(this\);\s*if \(call != null\) openPath\(call\);/);
  assert.match(main.slice(main.indexOf('private void openPath('), main.indexOf('private String takeInvite(')), /pendingOpen = PushPolicy\.safeOpenPath\(path\);/);
});

test('android-push-20: a new page ends the call notification; "Change" lists every push app and keeps the registration until one is picked; links ring only for calls that ring', async () => {
  // Any whole-page load (a reload after an update, switching server, an error page) ends the call notification:
  // the app does it when the page starts loading, and the page says so as it goes.
  const main = read('mobile', 'native', 'MainActivity.java');
  const started = main.slice(main.indexOf('public void onPageStarted('), main.indexOf('public void onReceivedError('));
  assert.match(started, /pageReady = false;[\s\S]*CallService\.stop\(MainActivity\.this\);/);
  assert.match(read('public', 'js', 'android.js'), /addEventListener\('pagehide', \(\) => \{ if \(inCall\) \{ inCall = false; send\(\{ type: 'callEnd' \}\); \} \}\)/);
  // Picking a push app: nothing is removed before a pick; Change shows Hearth's own list (every push app, the
  // phone's default notwithstanding); backing out of Android's list is a cancel, not a second list.
  const push = read('mobile', 'native', 'HearthPush.java');
  const reg = push.slice(push.indexOf('static void register('), push.indexOf('private static void pickDistributor('));
  assert.doesNotMatch(push, /removeDistributor/);
  assert.match(reg, /if \(choose\) \{ pickDistributor\(a, instance, key, true, keep\); return; \}/);
  assert.match(reg, /resolveDefaultDistributor\(a\)[\s\S]*ResolvedDistributor\.Found[\s\S]*ResolvedDistributor\.ToSelect[\s\S]*tryUseDefaultDistributor[\s\S]*else cancelled\(a, false\)/);
  const pick = push.slice(push.indexOf('private static void pickDistributor('), push.indexOf('private static void cancelled('));
  assert.match(pick, /if \(!choose && found\.size\(\) == 1/);
  assert.match(pick, /setNegativeButton\("Cancel", \(d, w\) -> cancelled\(a, keep\)\)[\s\S]*setOnCancelListener\(\(d\) -> cancelled\(a, keep\)\)/);
  assert.match(push.slice(push.indexOf('private static void cancelled(')), /if \(keep\) set\(c, "registered", ""\); else set\(c, "none", "CANCELLED"\);[\s\S]*st\.put\("cancelled", true\)/);
  // The page: a cancel ends the wait with CANCELLED even though the registration it had is still there.
  const AP = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'android-push.js')).href);
  let p;
  p = AP.createAndroidPush({ send: (m) => { if (m.type === 'pushPick') { setTimeout(() => p._reply({ type: 'pushState', state: 'pending' }), 5); setTimeout(() => p._event({ state: 'registered', endpoint: 'https://ntfy.sh/upOld', p256dh: 'B'.repeat(87), auth: 'a'.repeat(22), cancelled: true }), 20); } }, initial: { state: 'registered' }, timeoutMs: 500 });
  await assert.rejects(p.register('KEY', { choose: true }), (e) => e.code === 'CANCELLED');
  assert.equal(p.last.state, 'registered', 'the old registration is still known');
  // Settings: the push app row (and its Change) only while push is on, and the two rows redraw each other.
  const settings = read('public', 'js', 'settings.js');
  const rows = settings.slice(settings.indexOf('function pushRows('), settings.indexOf('function pushToggleRow('));
  assert.match(rows, /pushToggleRow\(app, \(\) => appRow && appRow\.redraw\(\)\)/);
  assert.match(rows, /androidPushAppRow\(app, \(\) => toggle\.refresh\(\)\)/);
  assert.equal((settings.match(/\.\.\.pushRows\(app\)/g) || []).length, 2, 'both places use the shared rows');
  const appRow = settings.slice(settings.indexOf('function androidPushAppRow('), settings.indexOf('// In the Android app: notifications come from the app itself'));
  assert.match(appRow, /const on = \(await app\.push\.status\(\)[^\n]*=== 'on';[\s\S]*if \(on && st\.distributor\)/);
  // #call/ links: a ring card only for a DM call with the other person in it, or a group chat's call.
  const js = read('public', 'js', 'app.js');
  const link = js.slice(js.indexOf('function openCallFromLink('), js.indexOf('// ---- message actions'));
  assert.match(link, /if \(d\.userId && inCall\(room, d\.userId\)\) from = d\.userId;/);
  assert.match(link, /if \(isGroup\(s\) && ch && ch\.type === 'voice'\) \{\s*room = ch\.id;\s*from =/);
  // The ringing room comes from our own DM and channel lists, not the link's text.
  assert.match(link, /room = 'dm:' \+ d\.id;/);
  assert.match(link, /if \(room && from && !\(voice && voice\.channelId === room\)\) onRing\(\{ room, from, video: false \}\);/);
  // The call notification names who or where only with previews set to "names" (Android shows it locked too).
  const title = js.slice(js.indexOf('function callTitle('), js.indexOf('function roomTitle('));
  assert.match(title, /if \(\(S\.notifySettings \|\| \{\}\)\.previews !== 'names'\) return 'In a call';/);
  assert.match(js, /S\.notifySettings = \{ dnd: r\.dnd, tz: r\.tz, previews: r\.previews \};\s*syncCallNotification\(\);/);
  // The one-time offer names the app, not the server.
  assert.match(js, /h\('span', null, 'Get notifications when Hearth is closed\?'\)/);
});
