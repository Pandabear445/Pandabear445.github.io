// Message usability and notifications (server/usability.js): saved messages, read state, notification
// preferences and the push decisions that follow them, data export, pins, slow mode and timeouts.
// Each feature is checked for what it allows and, just as much, for what it refuses: other people's saved
// items, read markers and preferences stay theirs, and an export can't start without the password.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const ece = require('http_ece');
const { startServer, hex, sleep, enable2fa, freshCode } = require('./helpers');

const P = { VIEW: 1, SEND: 2, REACT: 4, MENTION_EVERYONE: 16, MANAGE_MESSAGES: 32, KICK: 512, ADMIN: 1 << 30 };
const DENIED = [401, 403, 404];
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');
const x1 = () => 'x1:' + crypto.randomBytes(12).toString('base64') + ':' + crypto.randomBytes(64).toString('base64');
const b64u = (b) => Buffer.from(b).toString('base64url');

let srv; let boss; let server; let general; let code;
let certDir; let push; let pushPort;
const inbox = {}; // user id -> decrypted push payloads
const subs = {}; // user id -> { ecdh, auth }
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const user = async (name) => {
  const u = await srv.register(`${name}${hex(3)}`);
  const r = await as(u, 'POST', `/invites/${code}/join`);
  assert.equal(r.status, 200, r.text);
  return u;
};
const mkRole = async (name, permissions) => {
  const r = await as(boss, 'POST', `/servers/${server.id}/roles`, { name, permissions });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const give = async (u, roleIds) => assert.equal((await as(boss, 'PUT', `/servers/${server.id}/members/${u.id}/roles`, { roleIds })).status, 200);
const freshEpoch = () => srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', server.id);
const send = async (u, channelId, extra = {}) => {
  freshEpoch();
  const r = await as(u, 'POST', `/channels/${channelId}/messages`, { ciphertext: cipher(), epoch: 1, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
};
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
const emitAck = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
async function subscribe(u) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  subs[u.id] = { ecdh, auth };
  const r = await as(u, 'POST', '/push/subscribe', { subscription: { endpoint: `https://127.0.0.1:${pushPort}/p/${u.id}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } });
  assert.equal(r.status, 200, r.text);
}
const got = (u) => inbox[u.id] || [];
// Waits until someone has n pushes (or a while passes), then a little longer so a wrong extra one would show.
async function settle(u, n) { for (let i = 0; i < 40 && got(u).length < n; i++) await sleep(100); await sleep(400); }

before(async () => {
  // A local push service that decrypts what it receives (RFC 8291), so the tests can read each payload.
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-push-'));
  const pems = await require('selfsigned').generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  });
  fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);
  push = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const uid = req.url.split('/').pop();
      const s = subs[uid];
      let payload = null;
      try { payload = JSON.parse(ece.decrypt(Buffer.concat(parts), { version: 'aes128gcm', privateKey: s.ecdh, authSecret: s.auth }).toString('utf8')); } catch { payload = { undecryptable: true }; }
      (inbox[uid] ||= []).push(payload);
      res.writeHead(201); res.end();
    });
  });
  await new Promise((r) => push.listen(0, '127.0.0.1', r));
  pushPort = push.address().port;
  srv = await startServer({ PUSH_ALLOW_PRIVATE: '1', NODE_EXTRA_CA_CERTS: path.join(certDir, 'cert.pem'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
  boss = srv.owner;
  server = (await as(boss, 'POST', '/servers', { name: 'Usability HQ' })).json;
  general = server.channels.find((c) => c.type === 'text');
  code = (await as(boss, 'POST', `/servers/${server.id}/invites`, { expiresHours: 0 })).json.code;
});
after(async () => {
  socks.forEach((s) => s.close());
  await srv.stop();
  push.close();
  fs.rmSync(certDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ saved messages
test('saved: personal, synced to your own devices, ids plus an encrypted note only', async () => {
  const ann = await user('ann'); const ben = await user('ben'); const out = await srv.register(`out${hex(3)}`);
  const mid = await send(boss, general.id);
  const annSock = await sock(ann); const benSock = await sock(ben);
  const annEv = collect(annSock, 'saved:update'); const benEv = collect(benSock, 'saved:update');

  const note = x1();
  const r = await as(ann, 'PUT', `/me/saved/${mid}`, { note });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.note, note);
  assert.equal((await as(ann, 'PUT', `/me/saved/${mid}`, { note: 'plain words are refused' })).status, 400, 'notes must be ciphertext');
  const list = (await as(ann, 'GET', '/me/saved')).json;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].messageId, mid);
  assert.equal(list.items[0].message.ciphertext.startsWith('v2:'), true, 'the message comes back as ciphertext to decrypt');
  assert.deepEqual((await as(ann, 'GET', '/me/saved/ids')).json, [mid]);
  // Other people see nothing of it and can't change it.
  assert.equal((await as(ben, 'GET', '/me/saved')).json.items.length, 0);
  assert.equal((await as(ben, 'DELETE', `/me/saved/${mid}`)).status, 200);
  assert.equal((await as(ann, 'GET', '/me/saved')).json.items.length, 1, 'ben’s delete only touches ben’s list');
  // Can't save what you can't see.
  assert.ok(DENIED.includes((await as(out, 'PUT', `/me/saved/${mid}`, {})).status), 'outsiders can’t save a server message');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM saved_messages WHERE user_id = ?', out.id)[0].n, 0);
  await sleep(200);
  assert.ok(annEv.some((e) => e.messageId === mid && e.saved), 'ann’s other devices hear about it');
  assert.equal(benEv.filter((e) => e.messageId === mid && e.saved).length, 0, 'nobody else does');
  // The database holds only ids and the note: no readable text.
  const row = srv.sql('SELECT * FROM saved_messages WHERE user_id = ?', ann.id)[0];
  assert.deepEqual(Object.keys(row).sort(), ['created_at', 'message_id', 'note', 'user_id']);

  // Losing access (or the message being deleted) shows "no longer available", without the ciphertext.
  const priv = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: 'secret', type: 'text' })).json;
  const pm = await send(boss, priv.id);
  assert.equal((await as(ann, 'PUT', `/me/saved/${pm}`, {})).status, 200);
  assert.equal((await as(boss, 'PUT', `/channels/${priv.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }] })).status, 200);
  assert.equal((await as(boss, 'DELETE', `/messages/${mid}`)).status, 200);
  const after2 = (await as(ann, 'GET', '/me/saved')).json.items;
  assert.equal(after2.length, 2);
  for (const it of after2) { assert.equal(it.unavailable, true); assert.equal(it.message, undefined); }
  assert.equal((await as(ann, 'DELETE', `/me/saved/${pm}`)).status, 200, 'you can still remove it');
});

// ------------------------------------------------------------------ read state
test('read state: unread and mention counts, synced across your devices, never readable or writable by others', async () => {
  const cat = await user('cat'); const dan = await user('dan'); const out = await srv.register(`out${hex(3)}`);
  const room = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: `room${hex(2)}`, type: 'text' })).json;
  await send(boss, room.id);
  // The first look sets the line: everything older counts as read.
  let st = (await as(cat, 'GET', '/me/unread')).json.states['c:' + room.id];
  assert.equal(st.unread, 0);
  await sleep(5);
  const m1 = await send(boss, room.id);
  const m2 = await send(boss, room.id, { mentions: [cat.id] });
  const m3 = await send(dan, room.id, { replyTo: m1 });
  st = (await as(cat, 'GET', '/me/unread')).json.states['c:' + room.id];
  assert.equal(st.unread, 3);
  assert.equal(st.mentions, 1, 'one message pings cat');
  assert.equal(st.lastId, m3);
  assert.equal((await as(boss, 'GET', '/me/unread')).json.states['c:' + room.id].unread, 1, 'only dan’s: your own messages don’t count, and sending marks it read');

  const c1 = await sock(cat); const c2 = await sock(cat); const d1 = await sock(dan);
  const ev2 = collect(c2, 'read:update'); const evd = collect(d1, 'read:update');
  let r = await as(cat, 'POST', '/me/read', { conv: 'c:' + room.id, messageId: m2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.unread, 1);
  assert.equal(r.json.mentions, 0);
  await sleep(200);
  assert.ok(ev2.some((e) => e.conv === 'c:' + room.id && e.lastReadId === m2), 'cat’s other device is told');
  assert.equal(evd.length, 0, 'dan isn’t');
  // Only forward, unless marking unread on purpose.
  r = await as(cat, 'POST', '/me/read', { conv: 'c:' + room.id, messageId: m1 });
  assert.equal(r.json.lastReadId, m2, 'an older marker from a slow device doesn’t undo progress');
  r = await as(cat, 'POST', '/me/read', { conv: 'c:' + room.id, messageId: m1, unread: true });
  assert.equal(r.json.lastReadId, m1);
  assert.equal(r.json.unread, 2);
  // Others: not your conversation, not your marker.
  assert.ok(DENIED.includes((await as(out, 'POST', '/me/read', { conv: 'c:' + room.id, messageId: m3 })).status));
  assert.equal((await as(out, 'GET', '/me/unread')).json.states['c:' + room.id], undefined, 'no counts for channels you can’t see');
  assert.equal((await as(dan, 'POST', '/me/read', { conv: 'c:' + room.id, messageId: m3 })).status, 200);
  assert.equal((await as(cat, 'GET', '/me/unread')).json.states['c:' + room.id].lastReadId, m1, 'dan’s marker is dan’s');
  // A message from another conversation can't be used as the marker.
  assert.equal((await as(cat, 'POST', '/me/read', { conv: 'c:' + room.id, messageId: await send(boss, general.id) })).status, 404);
  for (const bad of [{}, { conv: 'x:1', messageId: m1 }, { conv: 'c:' + room.id }, { conv: 'c:' + room.id, messageId: '0' }, { conv: ['c:1'], messageId: m1 }]) {
    assert.ok([400, 404].includes((await as(cat, 'POST', '/me/read', bad)).status), JSON.stringify(bad));
  }
  // Mark a whole server read.
  r = await as(cat, 'POST', `/servers/${server.id}/read`);
  assert.equal(r.status, 200);
  assert.equal((await as(cat, 'GET', '/me/unread')).json.states['c:' + room.id].unread, 0);
  assert.ok(DENIED.includes((await as(out, 'POST', `/servers/${server.id}/read`)).status));
  c1.close();

  // DMs: every message counts as a mention; the other person can't touch your marker.
  const dm = (await as(cat, 'POST', '/dms', { userId: dan.id })).json;
  const dmMsg = (await as(dan, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() })).json.id;
  st = (await as(cat, 'GET', '/me/unread')).json.states['d:' + dm.id];
  assert.equal(st.unread, 1); assert.equal(st.mentions, 1);
  assert.ok(DENIED.includes((await as(out, 'POST', '/me/read', { conv: 'd:' + dm.id, messageId: dmMsg })).status));
  assert.equal((await as(cat, 'POST', '/me/read', { conv: 'd:' + dm.id, messageId: dmMsg })).json.unread, 0);
});

test('read state: @everyone counts as a mention only from someone allowed to use it, and can be suppressed', async () => {
  const eva = await user('eva'); const loud = await user('loud'); const quiet = await user('quiet');
  const role = await mkRole('Announcer', P.VIEW | P.SEND | P.MENTION_EVERYONE);
  await give(loud, [role.id]);
  const room = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: `news${hex(2)}`, type: 'text' })).json;
  await as(eva, 'GET', '/me/unread');
  await sleep(5);
  await send(quiet, room.id, { everyone: true });
  assert.equal((await as(eva, 'GET', '/me/unread')).json.states['c:' + room.id].mentions, 0, 'no Mention Everyone: not a ping');
  await send(loud, room.id, { everyone: true });
  assert.equal((await as(eva, 'GET', '/me/unread')).json.states['c:' + room.id].mentions, 1);
  assert.equal((await as(eva, 'PUT', `/me/notify/s:${server.id}`, { suppressEveryone: true })).status, 200);
  assert.equal((await as(eva, 'GET', '/me/unread')).json.states['c:' + room.id].mentions, 0, 'suppressed');
});

// ------------------------------------------------------------------ notification preferences
test('notification preferences: yours only, for places you’re in, with input checked', async () => {
  const fay = await user('fay'); const gus = await user('gus'); const out = await srv.register(`out${hex(3)}`);
  const until = Date.now() + 3600000;
  let r = await as(fay, 'PUT', `/me/notify/c:${general.id}`, { level: 'mentions', muteUntil: until });
  assert.equal(r.status, 200, r.text);
  assert.equal((await as(fay, 'GET', '/me/notify')).json.prefs['c:' + general.id].level, 'mentions');
  assert.deepEqual((await as(gus, 'GET', '/me/notify')).json.prefs, {}, 'gus sees none of fay’s');
  assert.equal((await as(fay, 'PUT', `/me/notify/c:${general.id}`, { level: 'muted' })).json.level, 'none', 'the old name still works');
  assert.equal((await as(fay, 'PUT', `/me/notify/c:${general.id}`, { level: 'default', muteUntil: null })).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM notify_prefs WHERE user_id = ?', fay.id)[0].n, 0, 'back to defaults leaves no row');
  // Not in it: refused (and nothing stored that would tell you it exists).
  for (const t of [`s:${server.id}`, `c:${general.id}`]) assert.ok(DENIED.includes((await as(out, 'PUT', `/me/notify/${t}`, { level: 'none' })).status), t);
  const dm = (await as(fay, 'POST', '/dms', { userId: gus.id })).json;
  assert.ok(DENIED.includes((await as(out, 'PUT', `/me/notify/d:${dm.id}`, { level: 'none' })).status));
  assert.equal(srv.sql('SELECT COUNT(*) n FROM notify_prefs WHERE user_id = ?', out.id)[0].n, 0);
  for (const body of [{ level: 'loud' }, { muteUntil: Date.now() - 1000 }, { muteUntil: Date.now() + 400 * 86400000 }, { muteUntil: 'soon' }]) {
    assert.equal((await as(fay, 'PUT', `/me/notify/s:${server.id}`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await as(fay, 'PUT', '/me/notify/x:abc', { level: 'none' })).status, 400);
  // Do Not Disturb schedule and preview privacy.
  r = await as(fay, 'PUT', '/me/notify-settings', { dnd: { on: true, start: '22:00', end: '07:30', days: [1, 2, 3, 3, 9] }, tz: 'Europe/Paris', previews: 'names' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.dnd.days, [1, 2, 3]);
  assert.equal((await as(gus, 'GET', '/me/notify')).json.settings.previews, 'hidden', 'previews are hidden unless you choose otherwise');
  for (const body of [{ tz: 'Mars/Olympus' }, { dnd: { start: '25:00' } }, { dnd: { end: '7pm' } }, { previews: 'everything' }, { dnd: { days: 'all' } }]) {
    assert.equal((await as(fay, 'PUT', '/me/notify-settings', body)).status, 400, JSON.stringify(body));
  }
});

test('push: preferences, mutes, @everyone suppression and Do Not Disturb are honoured on the server; lock screens show no names by default', async () => {
  const hal = await user('hal'); const ivy = await user('ivy');
  const role = await mkRole('Herald', P.VIEW | P.SEND | P.MENTION_EVERYONE);
  await give(boss, [role.id]);
  await subscribe(hal); await subscribe(ivy);
  const room = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: `push${hex(2)}`, type: 'text' })).json;

  // A mention reaches hal; the payload hides who and where (previews default to hidden).
  await send(boss, room.id, { mentions: [hal.id] });
  await settle(hal, 1);
  assert.equal(got(hal).length, 1);
  const first = got(hal)[0];
  assert.equal(first.title, srv.config.name);
  assert.equal(first.body, 'New message');
  assert.equal(JSON.stringify(first).includes('owner'), false, 'no sender name');
  assert.equal(JSON.stringify(first).includes(room.name), false, 'no channel name');
  // Choosing names shows them (still no message text: the server never has it).
  assert.equal((await as(ivy, 'PUT', '/me/notify-settings', { previews: 'names' })).status, 200);
  await send(boss, room.id, { mentions: [ivy.id] });
  await settle(ivy, 1);
  assert.match(got(ivy)[0].title, /mentioned you/);
  assert.match(got(ivy)[0].body, new RegExp(room.name));

  // Plain messages don't push by default; "All messages" on the channel makes them push.
  let n = got(ivy).length;
  await send(boss, room.id);
  await settle(ivy, n + 1);
  assert.equal(got(ivy).length, n, 'default: only pings push');
  assert.equal((await as(ivy, 'PUT', `/me/notify/c:${room.id}`, { level: 'all' })).status, 200);
  await send(boss, room.id);
  await settle(ivy, n + 1);
  assert.equal(got(ivy).length, n + 1, 'all messages: pushed');

  // Nothing / muted for a while: even mentions stay quiet.
  n = got(hal).length;
  assert.equal((await as(hal, 'PUT', `/me/notify/c:${room.id}`, { level: 'none' })).status, 200);
  await send(boss, room.id, { mentions: [hal.id] });
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n, 'channel set to nothing');
  assert.equal((await as(hal, 'PUT', `/me/notify/c:${room.id}`, { level: 'default' })).status, 200);
  assert.equal((await as(hal, 'PUT', `/me/notify/s:${server.id}`, { muteUntil: Date.now() + 600000 })).status, 200);
  await send(boss, room.id, { mentions: [hal.id] });
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n, 'server muted for 10 minutes');
  assert.equal((await as(hal, 'PUT', `/me/notify/s:${server.id}`, { muteUntil: null })).status, 200);
  await send(boss, room.id, { mentions: [hal.id] });
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n + 1, 'unmuted: back');

  // @everyone pushes, unless suppressed; a direct mention still gets through.
  n = got(hal).length;
  await send(boss, room.id, { everyone: true });
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n + 1, '@everyone from someone allowed');
  assert.equal((await as(hal, 'PUT', `/me/notify/c:${room.id}`, { suppressEveryone: true })).status, 200);
  await send(boss, room.id, { everyone: true });
  await settle(hal, n + 2);
  assert.equal(got(hal).length, n + 1, '@everyone suppressed');
  await send(boss, room.id, { everyone: true, mentions: [hal.id] });
  await settle(hal, n + 2);
  assert.equal(got(hal).length, n + 2, 'a direct mention isn’t suppressed');

  // Do Not Disturb on a schedule that covers right now (every day, all day): nothing, DMs included.
  n = got(hal).length;
  assert.equal((await as(hal, 'PUT', '/me/notify-settings', { dnd: { on: true, start: '00:00', end: '00:00', days: [0, 1, 2, 3, 4, 5, 6] }, tz: 'UTC' })).json.dndActive, true);
  await send(boss, room.id, { mentions: [hal.id] });
  const dm = (await as(boss, 'POST', '/dms', { userId: hal.id })).json;
  assert.equal((await as(boss, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() })).status, 200);
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n, 'quiet hours');
  // A schedule that doesn't cover now: back to normal.
  const hour = new Date().getUTCHours();
  const away = (h) => `${String((hour + h) % 24).padStart(2, '0')}:00`;
  assert.equal((await as(hal, 'PUT', '/me/notify-settings', { dnd: { on: true, start: away(2), end: away(4) } })).json.dndActive, false);
  assert.equal((await as(boss, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() })).status, 200);
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n + 1, 'outside quiet hours a DM pushes');
  // A DM muted for a while: quiet.
  assert.equal((await as(hal, 'PUT', `/me/notify/d:${dm.id}`, { muteUntil: Date.now() + 60000 })).status, 200);
  assert.equal((await as(boss, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() })).status, 200);
  await settle(hal, n + 2);
  assert.equal(got(hal).length, n + 1, 'DM muted');
  for (const p of [...got(hal), ...got(ivy)]) assert.equal(p.undecryptable, undefined, 'every push was a proper encrypted payload');
});

// ------------------------------------------------------------------ export my data
test('export: needs the password (and 2FA) to start; the token is yours, this session’s, and short-lived', async () => {
  const jon = await user('jon'); const kim = await user('kim');
  await send(jon, general.id);
  for (const p of ['/me/export/account', `/me/export/messages?conv=c:${general.id}`]) {
    assert.equal((await as(jon, 'GET', p)).status, 403, `${p} without a token`);
    assert.equal((await srv.api('GET', p, { token: jon.token, ip: jon.ip, headers: { 'x-export-token': 'f'.repeat(64) } })).status, 403, `${p} with a made-up token`);
  }
  assert.equal((await as(jon, 'POST', '/me/export', {})).status, 401, 'no password');
  assert.equal((await as(jon, 'POST', '/me/export', { authKey: 'f'.repeat(64) })).status, 401, 'wrong password');
  const r = await as(jon, 'POST', '/me/export', { authKey: jon.authKey });
  assert.equal(r.status, 200, r.text);
  const tok = { 'x-export-token': r.json.token };
  const acct = await srv.api('GET', '/me/export/account', { token: jon.token, ip: jon.ip, headers: tok });
  assert.equal(acct.status, 200, acct.text);
  assert.equal(acct.json.account.username, jon.username);
  assert.ok(acct.json.servers.some((s) => s.id === server.id));
  assert.equal(JSON.stringify(acct.json).includes('auth_hash'), false);
  assert.equal(JSON.stringify(acct.json).includes(kim.ip), false, 'no one’s addresses');
  const page = await srv.api('GET', `/me/export/messages?conv=c:${general.id}&limit=5`, { token: jon.token, ip: jon.ip, headers: tok });
  assert.equal(page.status, 200, page.text);
  assert.ok(page.json.messages.length >= 1 && page.json.messages.every((m) => m.ciphertext || m.legacy), 'ciphertext for the app to decrypt');
  // Someone else's token, or this token from another session of the same account: refused.
  assert.equal((await srv.api('GET', '/me/export/account', { token: kim.token, ip: kim.ip, headers: tok })).status, 403);
  const other = await srv.login(jon);
  assert.equal(other.status, 200);
  assert.equal((await srv.api('GET', '/me/export/account', { token: other.json.token, ip: jon.ip, headers: tok })).status, 403);
  // Conversations you can't read stay out, token or not.
  const dm = (await as(kim, 'POST', '/dms', { userId: boss.id })).json;
  assert.ok(DENIED.includes((await srv.api('GET', `/me/export/messages?conv=d:${dm.id}`, { token: jon.token, ip: jon.ip, headers: tok })).status));
  // With two-factor on, starting an export needs a code too.
  const tf = await enable2fa(srv, kim);
  srv.sql('UPDATE sessions SET mfa_at = NULL WHERE user_id = ?', kim.id);
  const noCode = await as(kim, 'POST', '/me/export', { authKey: kim.authKey });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.json.code, 'need_2fa');
  assert.equal((await as(kim, 'POST', '/me/export', { authKey: kim.authKey, totp: await freshCode(tf.secret, tf.used) })).status, 200);
  assert.ok(srv.sql("SELECT COUNT(*) n FROM admin_log WHERE action = 'data_export' AND target = ?", jon.id)[0].n >= 1, 'starting an export is in the audit log');
});

// ------------------------------------------------------------------ pins
test('pins: need Manage Messages in server channels, are kept in the channel’s pin history, and are capped', async () => {
  const lea = await user('lea'); const mod = await user('mod');
  const role = await mkRole('Pinner', P.VIEW | P.SEND | P.MANAGE_MESSAGES);
  await give(mod, [role.id]);
  const room = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: `pins${hex(2)}`, type: 'text' })).json;
  const own = await send(lea, room.id);
  assert.equal((await as(lea, 'POST', `/messages/${own}/pin`)).status, 403, 'even your own message needs Manage Messages');
  assert.equal((await as(mod, 'POST', `/messages/${own}/pin`)).status, 200);
  assert.equal((await as(mod, 'DELETE', `/messages/${own}/pin`)).status, 200);
  assert.equal((await as(lea, 'DELETE', `/messages/${own}/pin`)).status, 403);
  const log = (await as(lea, 'GET', `/channels/${room.id}/pins/log`)).json;
  assert.deepEqual(log.map((x) => x.action), ['unpin', 'pin']);
  assert.ok(log.every((x) => x.userId === mod.id && x.messageId === own));
  const out = await srv.register(`out${hex(3)}`);
  assert.ok(DENIED.includes((await as(out, 'GET', `/channels/${room.id}/pins/log`)).status), 'outsiders can’t read the pin history');
  // At most 50 pinned per channel.
  for (let i = 0; i < 50; i++) srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at, pinned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'p' + hex(8), room.id, boss.id, '', cipher(), 1, Date.now(), Date.now());
  assert.equal((await as(mod, 'POST', `/messages/${own}/pin`)).status, 400);
  // Group chats: anyone in the group can pin.
  const g = (await as(lea, 'POST', '/groups', { userIds: [mod.id] }));
  if (g.status === 200) {
    const gc = g.json.channels.find((c) => c.type === 'text');
    srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', g.json.id);
    const gm = (await as(mod, 'POST', `/channels/${gc.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json.id;
    assert.equal((await as(lea, 'POST', `/messages/${gm}/pin`)).status, 200, 'group members pin freely');
  }
});

// ------------------------------------------------------------------ slow mode
test('slow mode is enforced by the server, with moderators exempt', async () => {
  const max = await user('max'); const mod = await user('slowmod');
  const role = await mkRole('Slow mod', P.VIEW | P.SEND | P.MANAGE_MESSAGES);
  await give(mod, [role.id]);
  const room = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: `slow${hex(2)}`, type: 'text' })).json;
  assert.equal((await as(boss, 'PATCH', `/channels/${room.id}`, { slowmode: 30 })).status, 200);
  assert.equal((await as(max, 'PATCH', `/channels/${room.id}`, { slowmode: 0 })).status, 403, 'members can’t lift it');
  await send(max, room.id);
  freshEpoch();
  const r = await as(max, 'POST', `/channels/${room.id}/messages`, { ciphertext: cipher(), epoch: 1 });
  assert.equal(r.status, 429);
  assert.equal(r.json.code, 'slowmode');
  await send(mod, room.id); await send(mod, room.id);
  // Once the wait is over, the member can post again.
  srv.sql('UPDATE messages SET created_at = created_at - 31000 WHERE channel_id = ? AND author_id = ?', room.id, max.id);
  await send(max, room.id);
});

// ------------------------------------------------------------------ timeouts
test('timeouts: Kick Members and role order required; a timed-out member can read but not post, react, edit, vote or type', async () => {
  const ned = await user('ned'); const mod = await user('tmod'); const peer = await user('tpeer'); const admin = await user('tadmin');
  const modRole = await mkRole('Timeout mod', P.VIEW | P.SEND | P.KICK);
  const adminRole = await mkRole('Timeout admin', P.ADMIN);
  await give(mod, [modRole.id]); await give(peer, [modRole.id]); await give(admin, [adminRole.id]);
  const before1 = await send(ned, general.id);
  const poll = await send(boss, general.id);
  const nedSock = await sock(ned);
  const tev = collect(nedSock, 'timeout:update');

  assert.equal((await as(ned, 'POST', `/servers/${server.id}/members/${peer.id}/timeout`, { minutes: 5 })).status, 403, 'needs Kick Members');
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/members/${peer.id}/timeout`, { minutes: 5 })).status, 403, 'not on an equal role');
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/members/${admin.id}/timeout`, { minutes: 5 })).status, 403, 'not on a higher role');
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/members/${boss.id}/timeout`, { minutes: 5 })).status, 403, 'not the owner');
  assert.equal((await as(boss, 'POST', `/servers/${server.id}/members/${admin.id}/timeout`, { minutes: 5 })).status, 403, 'administrators can’t be timed out');
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/members/${mod.id}/timeout`, { minutes: 5 })).status, 400, 'not yourself');
  for (const minutes of [0, -5, 1.5, 'ten', 40321]) assert.equal((await as(mod, 'POST', `/servers/${server.id}/members/${ned.id}/timeout`, { minutes })).status, 400, String(minutes));
  const out = await srv.register(`out${hex(3)}`);
  assert.ok(DENIED.includes((await as(out, 'POST', `/servers/${server.id}/members/${ned.id}/timeout`, { minutes: 5 })).status));

  const r = await as(mod, 'POST', `/servers/${server.id}/members/${ned.id}/timeout`, { minutes: 10, reason: 'cool off' });
  assert.equal(r.status, 200, r.text);
  assert.ok(srv.sql("SELECT COUNT(*) n FROM admin_log WHERE action = 'member_timeout' AND target = ? AND admin_id = ?", ned.id, mod.id)[0].n === 1, 'audit-logged');
  await sleep(200);
  assert.ok(tev.some((e) => e.serverId === server.id && e.until > Date.now()), 'ned is told');
  const mine = (await as(ned, 'GET', '/bootstrap')).json.servers.find((s) => s.id === server.id);
  assert.ok(mine.timeout && mine.timeout.until > Date.now(), 'the app knows (and shows read-only)');
  assert.equal(mine.channels.find((c) => c.id === general.id).perms & P.SEND, 0);

  freshEpoch();
  const denied = [
    await as(ned, 'POST', `/channels/${general.id}/messages`, { ciphertext: cipher(), epoch: 1 }),
    await as(ned, 'PATCH', `/messages/${before1}`, { ciphertext: cipher(), epoch: 1 }),
    await as(ned, 'POST', `/messages/${poll}/reactions`, { emoji: '👍' }),
    await as(ned, 'POST', `/polls/${poll}/vote`, { choices: [0] }),
  ];
  for (const x of denied) assert.equal(x.status, 403, x.text);
  assert.equal((await emitAck(nedSock, 'typing', { channelId: general.id })).ok, undefined, 'typing is refused');
  assert.equal((await as(ned, 'GET', `/channels/${general.id}/messages`)).status, 200, 'reading still works');
  // Leaving and rejoining doesn't shake it off.
  assert.equal((await as(ned, 'POST', `/servers/${server.id}/leave`)).status, 200);
  assert.equal((await as(ned, 'POST', `/invites/${code}/join`)).status, 200);
  freshEpoch();
  assert.equal((await as(ned, 'POST', `/channels/${general.id}/messages`, { ciphertext: cipher(), epoch: 1 })).status, 403, 'still timed out after rejoining');
  // The moderators' list; members can't read it.
  assert.ok((await as(mod, 'GET', `/servers/${server.id}/timeouts`)).json.some((t) => t.userId === ned.id && t.reason === 'cool off'));
  assert.equal((await as(peer, 'GET', `/servers/${server.id}/timeouts`)).status, 200);
  assert.equal((await as(ned, 'GET', `/servers/${server.id}/timeouts`)).status, 403);
  // When it runs out, everything is back.
  srv.sql('UPDATE member_timeouts SET until = ? WHERE user_id = ?', Date.now() - 1, ned.id);
  await send(ned, general.id);
  // Lifting one early is logged too.
  assert.equal((await as(mod, 'POST', `/servers/${server.id}/members/${ned.id}/timeout`, { minutes: 5 })).status, 200);
  assert.equal((await as(peer, 'DELETE', `/servers/${server.id}/members/${ned.id}/timeout`)).status, 200);
  assert.ok(srv.sql("SELECT COUNT(*) n FROM admin_log WHERE action = 'member_timeout_removed' AND target = ?", ned.id)[0].n === 1);
  await send(ned, general.id);
});

// ------------------------------------------------------------------ reports
test('reports: you can see your own reports’ status, nobody else’s, and repeats don’t pile up', async () => {
  const oli = await user('oli'); const pam = await user('pam');
  const mid = await send(pam, general.id);
  const body = { category: 'spam', targetId: pam.id, context: { kind: 'message', messageId: mid }, evidence: [{ id: mid, text: 'buy now' }] };
  const r1 = await as(oli, 'POST', '/reports', body);
  assert.equal(r1.status, 200, r1.text);
  const r2 = await as(oli, 'POST', '/reports', body);
  assert.equal(r2.json.id, r1.json.id);
  assert.equal(r2.json.duplicate, true);
  const mine = (await as(oli, 'GET', '/me/reports')).json;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'open');
  assert.equal(mine[0].resolution, undefined, 'staff notes stay with staff');
  assert.deepEqual((await as(pam, 'GET', '/me/reports')).json, [], 'the reported person can’t see it');
  assert.equal((await as(boss, 'PATCH', `/admin/reports/${r1.json.id}`, { status: 'resolved', resolution: 'internal note' })).status, 200);
  assert.equal((await as(oli, 'GET', '/me/reports')).json[0].status, 'resolved');
  assert.notEqual((await as(oli, 'POST', '/reports', body)).json.id, r1.json.id, 'after it’s closed, a new report is new');
});

// ------------------------------------------------------------------ the app's own helpers (run in Node)
test('app helpers: quiet hours follow the same rule as the server, and the export zip is a valid archive', async () => {
  const { pathToFileURL } = require('node:url');
  const zlib = require('node:zlib');
  const U = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'usability.js')).href);
  // Quiet hours: 22:00–07:00 starting Friday covers Saturday 03:00 but not Saturday 23:00 (Saturday isn't a start day).
  const dnd = { on: true, start: '22:00', end: '07:00', days: [5] };
  const at = (iso) => Date.parse(iso);
  assert.equal(U.quietNow({ dnd, tz: 'UTC' }, at('2026-10-09T23:30:00Z')), true, 'Friday night');
  assert.equal(U.quietNow({ dnd, tz: 'UTC' }, at('2026-10-10T03:00:00Z')), true, 'Saturday early morning');
  assert.equal(U.quietNow({ dnd, tz: 'UTC' }, at('2026-10-10T08:00:00Z')), false, 'Saturday after it ends');
  assert.equal(U.quietNow({ dnd, tz: 'UTC' }, at('2026-10-10T23:00:00Z')), false, 'Saturday night: not a start day');
  assert.equal(U.quietNow({ dnd, tz: 'America/New_York' }, at('2026-10-10T03:00:00Z')), true, 'time zones count (Friday 23:00 in New York)');
  assert.equal(U.quietNow({ dnd: { ...dnd, on: false }, tz: 'UTC' }, at('2026-10-09T23:30:00Z')), false, 'off is off');
  assert.equal(U.quietNow({ dnd: { on: true, start: '09:00', end: '09:00', days: [6] }, tz: 'UTC' }, at('2026-10-10T15:00:00Z')), true, 'same start and end: all day');
  // The server agrees (same settings, same moment, through the real endpoint).
  const u = await srv.register(`tz${hex(3)}`);
  const quiet = (await as(u, 'PUT', '/me/notify-settings', { dnd: { on: true, start: '00:00', end: '23:59', days: [new Date().getUTCDay()] }, tz: 'UTC' })).json.dndActive;
  assert.equal(quiet, U.quietNow({ dnd: { on: true, start: '00:00', end: '23:59', days: [new Date().getUTCDay()] }, tz: 'UTC' }));

  // The zip: every entry's local header and central record agree, and CRC-32s check out.
  assert.equal(U.crc32(Buffer.from('hello')), zlib.crc32(Buffer.from('hello')));
  const z = U.createZip();
  const files = { 'account.json': '{"a":1}', 'conversations/x.json': 'é'.repeat(1000), 'attachments/a.bin': crypto.randomBytes(5000) };
  for (const [n, d] of Object.entries(files)) z.add(n, typeof d === 'string' ? d : new Uint8Array(d));
  assert.equal(z.add('account.json', 'again'), 'account (1).json', 'names are kept unique');
  const buf = Buffer.from(await z.blob().arrayBuffer());
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0);
  const count = buf.readUInt16LE(eocd + 10); const cdOff = buf.readUInt32LE(eocd + 16);
  assert.equal(count, 4);
  let p = cdOff;
  const seen = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16); const size = buf.readUInt32LE(p + 24); const nlen = buf.readUInt16LE(p + 28); const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(off), 0x04034b50, `${name}: local header`);
    const data = buf.subarray(off + 30 + buf.readUInt16LE(off + 26), off + 30 + buf.readUInt16LE(off + 26) + size);
    assert.equal(zlib.crc32(data), crc, `${name}: CRC-32`);
    seen[name] = data;
    p += 46 + nlen;
  }
  assert.equal(seen['conversations/x.json'].toString('utf8'), files['conversations/x.json']);
  assert.ok(seen['attachments/a.bin'].equals(files['attachments/a.bin']));
});

test('app: saved messages and read markers are no longer kept as plaintext in the browser', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(src, /get saved\(\)/, 'no local saved list');
  assert.doesNotMatch(src, /text: textOf\(m\), files: filesOf\(m\)\.length/, 'saving doesn’t copy the decrypted text anywhere');
  assert.match(src, /api\('PUT', `\/me\/saved\/\$\{m\.id\}`, \{\}\)/, 'saving sends the id only');
  assert.match(src, /localStorage\.removeItem\(k\); lsCache\.delete\(k\);/, 'the old local copy is removed after it is handed over');
});
