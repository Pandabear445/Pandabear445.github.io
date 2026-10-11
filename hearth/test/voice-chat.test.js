// Text chat in voice channels (v19). A server's voice channels take messages through the same route as text channels
// (POST /channels/:id/messages): ciphertext only, the server's key epoch, View Channel and Send Messages (Connect isn't
// needed), the same limits. No threads, bots or webhooks there, and a group's call has no chat (the group's own
// conversation is it). A voice chat counts as unread only for people who opened it (or, in the app, who are in its
// call); its pings always count; "All messages" from the server's setting pushes only to people who follow it.
// Moderation (pins, bulk delete, a ban's cleanup), search and the data export take voice chats in like text channels.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const ece = require('http_ece');
const { startServer, hex, sleep } = require('./helpers');

const P = { VIEW: 1, SEND: 2, REACT: 4, ATTACH: 8, MANAGE_MESSAGES: 32, CONNECT: 64, CREATE_THREADS: 1 << 15 };
const DENIED = [403, 404];
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');
const b64u = (b) => Buffer.from(b).toString('base64url');

let srv; let boss; let server; let general; let lounge; let code;
let certDir; let push; let pushPort;
const inbox = {}; // user id -> decrypted push payloads
const subs = {};
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const user = async (name) => {
  const u = await srv.register(`${name}${hex(3)}`);
  assert.equal((await as(u, 'POST', `/invites/${code}/join`)).status, 200);
  return u;
};
const voiceRoom = async (name = 'talk') => {
  const r = await as(boss, 'POST', `/servers/${server.id}/channels`, { name: `${name}${hex(2)}`, type: 'voice' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.type, 'voice');
  return r.json;
};
const freshEpoch = () => srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', server.id);
const post = (u, channelId, extra = {}) => { freshEpoch(); return as(u, 'POST', `/channels/${channelId}/messages`, { ciphertext: cipher(), epoch: 1, ...extra }); };
const send = async (u, channelId, extra = {}) => {
  const r = await post(u, channelId, extra);
  assert.equal(r.status, 200, r.text);
  return r.json.id;
};
const unread = async (u) => (await as(u, 'GET', '/me/unread')).json.states;
const overrides = (c, list) => as(boss, 'PUT', `/channels/${c.id}/overrides`, { overrides: list });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
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
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-vchat-'));
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
  server = (await as(boss, 'POST', '/servers', { name: 'Voice chat HQ' })).json;
  general = server.channels.find((c) => c.type === 'text');
  lounge = server.channels.find((c) => c.type === 'voice');
  code = (await as(boss, 'POST', `/servers/${server.id}/invites`, { expiresHours: 0 })).json.code;
});
after(async () => {
  socks.forEach((s) => s.close());
  await srv.stop();
  push.close();
  fs.rmSync(certDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the chat itself
test('a voice channel’s chat: members send, read, edit, react, reply and type there; ciphertext only, live to the channel', async () => {
  const ann = await user('ann'); const ben = await user('ben');
  const benSock = await sock(ben);
  const fresh = collect(benSock, 'message:new'); const edits = collect(benSock, 'message:update'); const typing = collect(benSock, 'typing');

  const id = await send(ann, lounge.id);
  await sleep(150);
  const live = fresh.find((m) => m.id === id);
  assert.ok(live, 'people who can see the channel get it live');
  assert.equal(live.channelId, lounge.id);
  assert.match(live.ciphertext, /^v2:/);
  // Stored like any channel message: ciphertext, no readable body.
  const row = srv.sql('SELECT body, ciphertext, epoch, channel_id FROM messages WHERE id = ?', id)[0];
  assert.equal(row.body, '');
  assert.equal(row.channel_id, lounge.id);
  assert.equal(row.ciphertext, live.ciphertext);
  assert.equal(row.epoch, 1);

  const page = await as(ben, 'GET', `/channels/${lounge.id}/messages`);
  assert.equal(page.status, 200, page.text);
  assert.ok(page.json.messages.some((m) => m.id === id && m.ciphertext === row.ciphertext));
  assert.equal(JSON.stringify(page.json).includes('"body"'), false);

  // Edit (the author's, re-encrypted), react, reply.
  freshEpoch();
  const ed = await as(ann, 'PATCH', `/messages/${id}`, { ciphertext: cipher(), epoch: 1 });
  assert.equal(ed.status, 200, ed.text);
  assert.ok(ed.json.editedAt);
  assert.equal((await as(ben, 'PATCH', `/messages/${id}`, { ciphertext: cipher(), epoch: 1 })).status, 404, 'not someone else’s');
  assert.equal((await as(ben, 'POST', `/messages/${id}/reactions`, { emoji: '🎧' })).status, 200);
  const re = await post(ben, lounge.id, { replyTo: id });
  assert.equal(re.status, 200, re.text);
  assert.equal(re.json.replyTo, id);
  assert.equal(re.json.reply.id, id);

  // "Is typing…" works there too.
  const annSock = await sock(ann);
  annSock.emit('typing', { channelId: lounge.id });
  await sleep(200);
  assert.ok(typing.some((t) => t.channelId === lounge.id && t.userId === ann.id));
  assert.ok(edits.some((m) => m.id === id));

  // Where it lives, for message links and notifications.
  const loc = await as(ben, 'GET', `/messages/${id}/locate`);
  assert.deepEqual(loc.json, { kind: 'channel', channelId: lounge.id, serverId: server.id, threadId: null });

  // Your own goes; someone else's doesn't without Manage Messages.
  assert.equal((await as(ben, 'DELETE', `/messages/${id}`)).status, 403);
  assert.equal((await as(ann, 'DELETE', `/messages/${id}`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', id)[0].n, 0);

  // Chatting doesn't need Connect: someone who can see the channel but not join the call can still write.
  const stage = await voiceRoom('stage');
  assert.equal((await overrides(stage, [{ type: 'role', id: server.id, allow: 0, deny: P.CONNECT }])).status, 200);
  assert.equal((await post(ben, stage.id)).status, 200);
});

// ------------------------------------------------------------------ what's refused
test('refusals: hidden channels, no Send Messages, timeouts, group calls, threads, bots, webhooks, bad payloads, stale keys, slow mode', async () => {
  const cat = await user('cat'); const dan = await user('dan'); const out = await srv.register(`out${hex(3)}`);
  const vc = await voiceRoom('rules');
  // Not in the server, or can't see the channel: it doesn't exist.
  assert.equal((await post(out, vc.id)).status, 404);
  assert.equal((await as(out, 'GET', `/channels/${vc.id}/messages`)).status, 404);
  const hidden = await voiceRoom('hidden');
  assert.equal((await overrides(hidden, [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }])).status, 200);
  assert.equal((await post(cat, hidden.id)).status, 404);
  assert.equal((await as(cat, 'GET', `/channels/${hidden.id}/messages`)).status, 404);

  // Send Messages denied in the voice channel: read only. Attach Files denied: no files.
  assert.equal((await overrides(vc, [{ type: 'role', id: server.id, allow: 0, deny: P.SEND }])).status, 200);
  const ro = await post(cat, vc.id);
  assert.equal(ro.status, 403);
  assert.match(ro.json.error, /permission to send messages/);
  assert.equal((await as(cat, 'GET', `/channels/${vc.id}/messages`)).status, 200, 'still readable');
  assert.equal((await overrides(vc, [{ type: 'role', id: server.id, allow: 0, deny: P.ATTACH }])).status, 200);
  assert.equal((await post(cat, vc.id, { files: ['/uploads/whatever.bin'] })).status, 403);
  assert.equal((await overrides(vc, [])).status, 200);

  // A timeout takes the chat away like any other channel's.
  assert.equal((await as(boss, 'POST', `/servers/${server.id}/members/${dan.id}/timeout`, { minutes: 5 })).status, 200);
  assert.equal((await post(dan, vc.id)).status, 403);
  assert.equal((await as(boss, 'DELETE', `/servers/${server.id}/members/${dan.id}/timeout`)).status, 200);
  assert.equal((await post(dan, vc.id)).status, 200);

  // No threads in a voice channel's chat.
  const root = await send(cat, vc.id);
  const th = await post(dan, vc.id, { threadId: root });
  assert.equal(th.status, 400);
  assert.match(th.json.error, /Threads are only in text channels/);
  assert.equal((await as(dan, 'GET', `/channels/${vc.id}/threads`)).status, 400);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE thread_id = ?', root)[0].n, 0);

  // Payloads: too short, too long, missing; an old key epoch.
  for (const ciphertext of ['short', 'x'.repeat(64001), undefined, 42]) {
    freshEpoch();
    assert.equal((await as(cat, 'POST', `/channels/${vc.id}/messages`, { ciphertext, epoch: 1 })).status, 400, String(ciphertext).slice(0, 10));
  }
  freshEpoch();
  const stale = await as(cat, 'POST', `/channels/${vc.id}/messages`, { ciphertext: cipher(), epoch: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'stale-key');

  // Slow mode applies to the chat (cat wrote a moment ago; Manage Messages skips it).
  assert.equal((await as(boss, 'PATCH', `/channels/${vc.id}`, { slowmode: 60 })).status, 200);
  const slow = await post(cat, vc.id);
  assert.equal(slow.status, 429);
  assert.equal(slow.json.code, 'slowmode');
  await send(boss, vc.id); await send(boss, vc.id);

  // A group's call has no chat of its own (its conversation is the group's), and nothing to bulk delete.
  const group = (await as(cat, 'POST', '/groups', { userIds: [dan.id] })).json;
  const call = group.channels.find((c) => c.type === 'voice');
  srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', group.id);
  const g = await as(cat, 'POST', `/channels/${call.id}/messages`, { ciphertext: cipher(), epoch: 1 });
  assert.equal(g.status, 400);
  assert.match(g.json.error, /group call has no chat/);
  assert.equal((await as(cat, 'POST', `/channels/${call.id}/messages/bulk-delete`, { count: 5 })).status, 400);
  assert.equal((await as(cat, 'POST', `/channels/${group.channels.find((c) => c.type === 'text').id}/messages`, { ciphertext: cipher(), epoch: 1 })).status, 200, 'the group’s chat works as before');

  // Webhooks and bots post in text channels only.
  const hook = await as(boss, 'POST', `/channels/${vc.id}/webhooks`, { name: 'Uptime' });
  assert.equal(hook.status, 400);
  assert.match(hook.json.error, /text channels/);
  const b = await as(boss, 'POST', '/bots', { name: `vbot${hex(2)}`, description: 'voice chat test bot', scopes: ['messages.send'], listed: true });
  assert.equal(b.status, 200, b.text);
  assert.equal((await as(boss, 'POST', `/servers/${server.id}/bots`, { botId: b.json.bot.id, scopes: ['messages.send'], channels: [vc.id, general.id], confirm: true })).status, 200);
  const botPost = await srv.api('POST', `/bot/v1/channels/${vc.id}/messages`, { headers: { authorization: `Bot ${b.json.token}` }, body: { content: 'hello' }, ip: '203.0.113.9' });
  assert.equal(botPost.status, 400);
  assert.equal(botPost.json.code, 'bad_channel');
  assert.equal((await srv.api('POST', `/bot/v1/channels/${general.id}/messages`, { headers: { authorization: `Bot ${b.json.token}` }, body: { content: 'hello' }, ip: '203.0.113.9' })).status, 200, 'the same bot in a text channel');
});

test('disappearing messages: a voice chat has the channel’s timer, like a text channel (set by Manage Channels, stamped, checked, never served after its time)', async () => {
  const fay = await user('fay');
  const vc = await voiceRoom('fleeting');
  assert.equal(vc.disappear, 0);
  assert.equal((await as(fay, 'PUT', `/channels/${vc.id}/disappearing`, { seconds: 3600 })).status, 403, 'a plain member can’t set it');
  const set = await as(boss, 'PUT', `/channels/${vc.id}/disappearing`, { seconds: 3600 });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.seconds, 3600);
  // The app says which timer it encrypted for; one that doesn't match isn't sent.
  const stale = await post(fay, vc.id, { ttl: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'disappear_changed');
  const t0 = Date.now();
  const r = await post(fay, vc.id, { ttl: 3600 });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.expiresAt >= t0 + 3600000 && r.json.expiresAt <= Date.now() + 3600000);
  // Past its time it's gone from the history, before the sweep has run.
  srv.sql('UPDATE messages SET expires_at = ? WHERE id = ?', Date.now() - 1000, r.json.id);
  const page = await as(fay, 'GET', `/channels/${vc.id}/messages`);
  assert.equal(page.status, 200);
  assert.ok(!page.json.messages.some((m) => m.id === r.json.id), 'an expired voice chat message is never served');
  // A group's call has no chat, so no timer either.
  const pal = await user('pal');
  const grp = (await as(fay, 'POST', '/groups', { userIds: [pal.id] })).json;
  const call = grp.channels.find((c) => c.type === 'voice');
  const g = await as(fay, 'PUT', `/channels/${call.id}/disappearing`, { seconds: 3600 });
  assert.equal(g.status, 400);
  assert.equal(g.json.code, 'bad_channel');
});

test('limits: a voice chat has the same message rate limits as a text channel', async () => {
  const eli = await user('eli');
  const vc = await voiceRoom('busy');
  const codes = [];
  for (let i = 0; i < 27; i++) codes.push((await post(eli, vc.id)).status);
  assert.deepEqual(codes.slice(0, 25), Array(25).fill(200));
  assert.ok(codes.slice(25).every((c) => c === 429), `then 429 (${codes.slice(25)})`);
});

// ------------------------------------------------------------------ unread
test('unread: a voice chat counts only once you’ve opened it; its pings always count; Mark server read leaves unopened ones alone', async () => {
  const fay = await user('fay'); const gus = await user('gus'); const out = await user('out');
  await unread(fay); // fay's baseline: everything before this counts as read
  await sleep(5);
  const vc = await voiceRoom('hang');
  const priv = await voiceRoom('priv');
  assert.equal((await overrides(priv, [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'member', id: fay.id, allow: P.VIEW, deny: 0 }])).status, 200);
  await send(gus, vc.id); const m2 = await send(gus, vc.id);
  await send(gus, general.id);

  // Never opened: nothing unread, no marker; the text channel counts as usual.
  let st = await unread(fay);
  assert.deepEqual(st['c:' + vc.id], { lastReadId: null, lastId: m2, unread: 0, mentions: 0, opened: false });
  assert.ok(st['c:' + general.id].unread >= 1);
  assert.equal(st['c:' + priv.id].opened, false, 'a private voice channel fay may see');
  assert.equal((await unread(out))['c:' + priv.id], undefined, 'nothing about a voice channel you can’t see');
  // A ping counts even so.
  const ping = await send(gus, vc.id, { mentions: [fay.id] });
  st = await unread(fay);
  assert.equal(st['c:' + vc.id].mentions, 1);
  assert.equal(st['c:' + vc.id].unread, 0);
  assert.equal(st['c:' + vc.id].lastId, ping);

  // Opening it (reading up to the newest) makes it count from then on, on all of fay's devices.
  const fs1 = await sock(fay);
  const reads = collect(fs1, 'read:update');
  const r = await as(fay, 'POST', '/me/read', { conv: 'c:' + vc.id, messageId: ping });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.opened, true);
  assert.equal(r.json.unread, 0);
  assert.equal(r.json.mentions, 0);
  await sleep(150);
  assert.ok(reads.some((x) => x.conv === 'c:' + vc.id && x.opened === true));
  await send(gus, vc.id); await send(gus, vc.id);
  st = await unread(fay);
  assert.equal(st['c:' + vc.id].unread, 2);
  assert.equal(st['c:' + vc.id].opened, true);
  assert.equal(st['c:' + vc.id].lastReadId, ping);

  // An empty chat opened: the marker '0' says so (only for voice chats; a text channel still needs a message).
  const empty = await voiceRoom('empty');
  const z = await as(fay, 'POST', '/me/read', { conv: 'c:' + empty.id, messageId: '0' });
  assert.equal(z.status, 200, z.text);
  assert.equal(z.json.opened, true);
  assert.equal(z.json.lastReadId, '0');
  await send(gus, empty.id);
  assert.equal((await unread(fay))['c:' + empty.id].unread, 1);
  const zt = await as(fay, 'POST', '/me/read', { conv: 'c:' + general.id, messageId: '0' });
  assert.equal(zt.status, 400);
  assert.match(zt.json.error, /Pick a message/);
  // '0' never moves a marker back (only "Mark unread" does).
  assert.equal((await as(fay, 'POST', '/me/read', { conv: 'c:' + vc.id, messageId: '0' })).json.lastReadId, ping);
  // Someone else's chat marker can't be set where they can't see.
  assert.equal((await as(out, 'POST', '/me/read', { conv: 'c:' + priv.id, messageId: '0' })).status, 404);

  // Writing there opens it too.
  const said = await voiceRoom('said');
  await send(gus, said.id);
  await send(fay, said.id);
  assert.equal((await unread(fay))['c:' + said.id].opened, true);

  // Mark server read: opened chats are read; one never opened with a ping has its ping read but stays unopened
  // (marking it read isn't opening it); a quiet one never opened is left alone.
  const quietVc = await voiceRoom('quiet'); const pingVc = await voiceRoom('pinged');
  await send(gus, quietVc.id);
  const p2 = await send(gus, pingVc.id, { mentions: [fay.id] });
  const mr = await as(fay, 'POST', `/servers/${server.id}/read`);
  assert.equal(mr.status, 200, mr.text);
  const convs = mr.json.states.map((x) => x.conv);
  assert.ok(convs.includes('c:' + vc.id) && convs.includes('c:' + pingVc.id) && convs.includes('c:' + general.id));
  assert.ok(!convs.includes('c:' + quietVc.id), 'never opened and no ping: left alone');
  assert.deepEqual(mr.json.states.find((x) => x.conv === 'c:' + pingVc.id), { conv: 'c:' + pingVc.id, lastReadId: null, lastId: p2, unread: 0, mentions: 0, opened: false });
  st = await unread(fay);
  assert.equal(st['c:' + quietVc.id].opened, false);
  assert.deepEqual(st['c:' + pingVc.id], { lastReadId: null, lastId: p2, unread: 0, mentions: 0, opened: false });
  assert.equal(st['c:' + vc.id].unread, 0);
  // Still not followed: a plain message doesn't count for fay, the next ping does (only that one).
  await send(gus, pingVc.id);
  const p3 = await send(gus, pingVc.id, { mentions: [fay.id] });
  st = await unread(fay);
  assert.deepEqual([st['c:' + pingVc.id].opened, st['c:' + pingVc.id].unread, st['c:' + pingVc.id].mentions], [false, 0, 1]);

  // "Mark as read" from the voice channel's menu (pings: true) does the same for one chat, on all fay's devices.
  const pr = await as(fay, 'POST', '/me/read', { conv: 'c:' + pingVc.id, messageId: p3, pings: true });
  assert.equal(pr.status, 200, pr.text);
  assert.deepEqual(pr.json, { conv: 'c:' + pingVc.id, lastReadId: null, lastId: p3, unread: 0, mentions: 0, opened: false });
  await sleep(150);
  assert.ok(reads.some((x) => x.conv === 'c:' + pingVc.id && x.opened === false && x.mentions === 0));
  assert.equal((await unread(fay))['c:' + pingVc.id].mentions, 0);
  assert.equal((await as(fay, 'POST', '/me/read', { conv: 'c:' + pingVc.id, messageId: '0', pings: true })).status, 400, 'pings are read up to a message');
  assert.equal((await as(out, 'POST', '/me/read', { conv: 'c:' + priv.id, messageId: '0', pings: true })).status, 404);
  // On a chat fay follows, pings: true is an ordinary read.
  const last = await send(gus, vc.id);
  const pv = await as(fay, 'POST', '/me/read', { conv: 'c:' + vc.id, messageId: last, pings: true });
  assert.deepEqual([pv.json.opened, pv.json.lastReadId, pv.json.unread], [true, last, 0]);

  // A group's call has no chat state at all.
  const group = (await as(fay, 'POST', '/groups', { userIds: [gus.id] })).json;
  st = await unread(fay);
  assert.ok(st['c:' + group.channels.find((c) => c.type === 'text').id]);
  assert.equal(st['c:' + group.channels.find((c) => c.type === 'voice').id], undefined);
});

test('"All messages" for a voice chat follows it, like opening it: from then on it counts as unread; pings not yet read stay', async () => {
  const nia = await user('nia'); const oz = await user('oz');
  await unread(nia); // nia's baseline
  await sleep(5);
  const vc = await voiceRoom('allmsg');
  const m1 = await send(oz, vc.id);
  const ping = await send(oz, vc.id, { mentions: [nia.id] });
  await send(oz, vc.id);
  let st = (await unread(nia))['c:' + vc.id];
  assert.deepEqual([st.opened, st.unread, st.mentions], [false, 0, 1]);

  const ns = await sock(nia);
  const reads = collect(ns, 'read:update');
  const r = await as(nia, 'PUT', `/me/notify/c:${vc.id}`, { level: 'all' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.level, 'all');
  await sleep(150);
  assert.ok(reads.some((x) => x.conv === 'c:' + vc.id && x.opened === true && x.lastReadId === m1), 'all of nia’s devices hear it counts now');
  // The marker went just before the ping she hasn't read: it and what came after are unread, and it still pings.
  st = (await unread(nia))['c:' + vc.id];
  assert.deepEqual([st.opened, st.lastReadId, st.unread, st.mentions], [true, m1, 2, 1]);
  assert.ok(st.lastReadId < ping);
  await send(oz, vc.id);
  assert.equal((await unread(nia))['c:' + vc.id].unread, 3);
  // Choosing again, or another level later, never moves it (she follows it from now on, like one she opened).
  for (const level of ['all', 'mentions', 'default']) assert.equal((await as(nia, 'PUT', `/me/notify/c:${vc.id}`, { level })).status, 200);
  assert.equal((await unread(nia))['c:' + vc.id].lastReadId, m1);

  // No pings waiting: from the newest message, so nothing said before lights up.
  const busy = await voiceRoom('busy');
  await send(oz, busy.id); const newest = await send(oz, busy.id);
  assert.equal((await as(nia, 'PUT', `/me/notify/c:${busy.id}`, { level: 'all' })).status, 200);
  st = (await unread(nia))['c:' + busy.id];
  assert.deepEqual([st.opened, st.lastReadId, st.unread], [true, newest, 0]);
  await send(oz, busy.id);
  assert.equal((await unread(nia))['c:' + busy.id].unread, 1);
  // An empty one: the marker '0'.
  const empty = await voiceRoom('allempty');
  assert.equal((await as(nia, 'PUT', `/me/notify/c:${empty.id}`, { level: 'all' })).status, 200);
  assert.deepEqual([(await unread(nia))['c:' + empty.id].opened, (await unread(nia))['c:' + empty.id].lastReadId], [true, '0']);
  // Other levels don't follow it.
  const muted = await voiceRoom('mentionsonly');
  await send(oz, muted.id);
  assert.equal((await as(nia, 'PUT', `/me/notify/c:${muted.id}`, { level: 'mentions' })).status, 200);
  assert.equal((await unread(nia))['c:' + muted.id].opened, false);

  // Text channels and a group's call get no marker from it (a text channel counts anyway; a call has no chat).
  const marker = (conv) => srv.sql('SELECT last_read_id FROM read_states WHERE user_id = ? AND conv = ?', nia.id, conv).length;
  const text = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: `t${hex(2)}`, type: 'text' })).json;
  assert.equal((await as(nia, 'PUT', `/me/notify/c:${text.id}`, { level: 'all' })).status, 200);
  assert.equal(marker('c:' + text.id), 0);
  const group = (await as(nia, 'POST', '/groups', { userIds: [oz.id] })).json;
  const call = group.channels.find((c) => c.type === 'voice');
  assert.equal((await as(nia, 'PUT', `/me/notify/c:${call.id}`, { level: 'all' })).status, 200);
  assert.equal(marker('c:' + call.id), 0);
});

// ------------------------------------------------------------------ push
test('push: pings from a voice chat push like a text channel’s; "All messages" for the server reaches only people who follow the chat', async () => {
  const hal = await user('hal'); const ivy = await user('ivy'); const jo = await user('jo');
  await subscribe(hal); await subscribe(ivy);
  const vc = await voiceRoom('pushy');
  assert.equal((await as(hal, 'PUT', `/me/notify/s:${server.id}`, { level: 'all' })).status, 200);
  assert.equal((await as(ivy, 'PUT', '/me/notify-settings', { previews: 'names' })).status, 200);

  // Server set to "All messages": a text channel's message pushes, a voice chat's (never opened) doesn't.
  let n = got(hal).length;
  await send(jo, general.id);
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n + 1, 'text channel: pushed');
  n = got(hal).length;
  await send(jo, vc.id);
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n, 'voice chat nobody opened: quiet');
  // A ping does push.
  await send(jo, vc.id, { mentions: [hal.id] });
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n + 1, 'mention: pushed');
  // Once hal has opened it, it's like any channel.
  const last = srv.sql('SELECT id FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1', vc.id)[0].id;
  assert.equal((await as(hal, 'POST', '/me/read', { conv: 'c:' + vc.id, messageId: last })).status, 200);
  n = got(hal).length;
  await send(jo, vc.id);
  await settle(hal, n + 1);
  assert.equal(got(hal).length, n + 1, 'opened: pushed');

  // "All messages" picked on the voice channel itself always reaches you; the push says where (no message text).
  assert.equal((await as(ivy, 'PUT', `/me/notify/c:${vc.id}`, { level: 'all' })).status, 200);
  const m = got(ivy).length;
  await send(jo, vc.id);
  await settle(ivy, m + 1);
  assert.equal(got(ivy).length, m + 1);
  const p = got(ivy)[m];
  assert.ok(p.body.includes(vc.name) && p.body.includes('🔊'), p.body);
  assert.equal(p.url.startsWith('/#m/'), true);
});

// ------------------------------------------------------------------ moderation, search, export
test('moderation: pins, bulk delete and a ban’s cleanup work in voice chats; search and the data export include them', async () => {
  const kim = await user('kim'); const lou = await user('lou'); const spam = await user('spam');
  const vc = await voiceRoom('mod');
  const a = await send(kim, vc.id); const b = await send(lou, vc.id); const c = await send(kim, vc.id);

  // Pins need Manage Messages, as in text channels, and keep their history.
  assert.equal((await as(kim, 'POST', `/messages/${a}/pin`)).status, 403);
  assert.equal((await as(boss, 'POST', `/messages/${a}/pin`)).status, 200);
  assert.deepEqual((await as(lou, 'GET', `/channels/${vc.id}/pins`)).json.map((m) => m.id), [a]);
  assert.equal((await as(boss, 'GET', `/channels/${vc.id}/pins/log`)).json[0].messageId, a);

  // Search: the server and "everywhere" scopes take in voice chats (ciphertext, for the app to decrypt), and so does
  // the chat's own scope; someone who can't see the voice channel gets none of it.
  const seeIds = async (u, scope) => { const r = await as(u, 'GET', '/search/messages?' + new URLSearchParams({ scope })); assert.equal(r.status, 200, r.text); return r.json.messages.map((m) => m.id); };
  for (const scope of [`s:${server.id}`, 'all', `c:${vc.id}`]) {
    const found = await seeIds(lou, scope);
    assert.ok([a, b, c].every((id) => found.includes(id)), scope);
  }
  const priv = await voiceRoom('privmod');
  assert.equal((await overrides(priv, [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }])).status, 200);
  const secret = await send(boss, priv.id);
  assert.ok((await seeIds(boss, `s:${server.id}`)).includes(secret));
  assert.ok(!(await seeIds(lou, `s:${server.id}`)).includes(secret));
  assert.ok(!(await seeIds(lou, 'all')).includes(secret));
  assert.equal((await as(lou, 'GET', `/search/messages?scope=c:${priv.id}`)).status, 404);

  // Bulk delete: picked ones, then the most recent; Manage Messages only; one event for the lot.
  const louSock = await sock(lou);
  const bulk = collect(louSock, 'message:delete-bulk');
  assert.ok(DENIED.includes((await as(kim, 'POST', `/channels/${vc.id}/messages/bulk-delete`, { ids: [b] })).status));
  const r1 = await as(boss, 'POST', `/channels/${vc.id}/messages/bulk-delete`, { ids: [b, c] });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.deleted, 2);
  await sleep(150);
  assert.ok(bulk.some((e) => e.channelId === vc.id && e.messages.length === 2));
  await send(kim, vc.id); await send(kim, vc.id);
  const r2 = await as(boss, 'POST', `/channels/${vc.id}/messages/bulk-delete`, { count: 10 });
  assert.equal(r2.json.deleted, 3, 'the two new ones and the pinned one');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE channel_id = ?', vc.id)[0].n, 0);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM server_audit WHERE action = 'message_bulk_delete' AND channel_id = ?", vc.id)[0].n, 2);

  // A ban's cleanup takes what they said in voice chats too.
  const s1 = await send(spam, vc.id); const s2 = await send(spam, lounge.id); const s3 = await send(spam, general.id);
  const ban = await as(boss, 'POST', `/servers/${server.id}/bans`, { userId: spam.id, deleteHours: 1 });
  assert.equal(ban.status, 200, ban.text);
  assert.equal(ban.json.deleted, 3);
  assert.equal(srv.sql(`SELECT COUNT(*) n FROM messages WHERE id IN (?, ?, ?)`, s1, s2, s3)[0].n, 0);

  // The data export lists the voice chats you can see (with their type), and their messages export.
  const kept = await send(kim, vc.id);
  const ex = await as(kim, 'POST', '/me/export', { authKey: kim.authKey });
  assert.equal(ex.status, 200, ex.text);
  const tok = { 'x-export-token': ex.json.token };
  const acct = await srv.api('GET', '/me/export/account', { token: kim.token, ip: kim.ip, headers: tok });
  assert.equal(acct.status, 200, acct.text);
  const chans = acct.json.servers.find((s) => s.id === server.id).channels;
  assert.deepEqual(chans.find((x) => x.id === vc.id), { id: vc.id, name: vc.name, type: 'voice', topic: '' });
  assert.equal(chans.find((x) => x.id === general.id).type, 'text');
  assert.ok(!chans.some((x) => x.id === priv.id), 'not a voice channel kim can’t see');
  const page = await srv.api('GET', `/me/export/messages?conv=c:${vc.id}`, { token: kim.token, ip: kim.ip, headers: tok });
  assert.equal(page.status, 200, page.text);
  assert.deepEqual(page.json.messages.map((m) => m.id), [kept]);

  // Deleting the voice channel deletes its chat.
  assert.equal((await as(boss, 'DELETE', `/channels/${vc.id}`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', kept)[0].n, 0);
});

// ------------------------------------------------------------------ the upgrade
// Before voice channels had a chat, nobody could be denied Send Messages on one. Upgrading carries the limits a
// server had on posting over to the voice channels it already had, once (server/db.js, 'voiceChatLimits').
test('upgrading: existing voice channels keep the server’s limits on posting (Connect denied, muted roles, read-only, slow mode), once, in the audit log', async () => {
  const s2 = await startServer();
  try {
    const owner = s2.owner;
    const call = (u, method, p, body) => s2.api(method, p, { token: u.token, ip: u.ip, body });
    const ok = async (u, method, p, body) => { const r = await call(u, method, p, body); assert.equal(r.status, 200, `${method} ${p}: ${r.text}`); return r.json; };
    const mk = async (name) => {
      const sv = await ok(owner, 'POST', '/servers', { name });
      const inv = await ok(owner, 'POST', `/servers/${sv.id}/invites`, { expiresHours: 0 });
      return { sv, code: inv.code, text: sv.channels.find((c) => c.type === 'text'), lounge: sv.channels.find((c) => c.type === 'voice') };
    };
    const join = async (code, name) => { const u = await s2.register(`${name}${hex(3)}`); await ok(u, 'POST', `/invites/${code}/join`); return u; };
    const chan = (sv, name, type, extra = {}) => ok(owner, 'POST', `/servers/${sv.id}/channels`, { name, type, ...extra });
    const role = async (sv, name, members) => {
      const r = await ok(owner, 'POST', `/servers/${sv.id}/roles`, { name, permissions: 0 });
      for (const u of members) await ok(owner, 'PUT', `/servers/${sv.id}/members/${u.id}/roles`, { roleIds: [r.id] });
      return r.id;
    };
    const setOv = (c, list) => ok(owner, 'PUT', `/channels/${c.id}/overrides`, { overrides: list });
    const ovs = (c) => s2.sql('SELECT target_type AS type, target_id AS id, allow, deny FROM channel_overrides WHERE channel_id = ? ORDER BY target_type, target_id', c.id);
    const ovFor = (c, id) => ovs(c).find((o) => o.id === id) || null;
    const postIn = (u, sv, c) => { s2.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', sv.id); return call(u, 'POST', `/channels/${c.id}/messages`, { ciphertext: cipher(), epoch: 1 }); };

    // A hall with a Muted role (Send Messages denied in every text channel it can see; it can't see #staff), a staff
    // meeting room only Staff may join, someone kept out of the Lounge's call, and a role an admin had already let
    // post in the staff room through the API.
    const A = await mk('Old hall');
    const [plain, muted, staff, troll] = [await join(A.code, 'plain'), await join(A.code, 'muted'), await join(A.code, 'staff'), await join(A.code, 'troll')];
    const mutedRole = await role(A.sv, 'Muted', [muted]);
    const staffRole = await role(A.sv, 'Staff', [staff]);
    const chatty = await role(A.sv, 'Chatty', []);
    const rules = await chan(A.sv, 'rules', 'text');
    const staffText = await chan(A.sv, 'staff', 'text');
    const meeting = await chan(A.sv, 'meeting', 'voice');
    await setOv(A.text, [{ type: 'role', id: mutedRole, allow: 0, deny: P.SEND }]);
    await setOv(rules, [{ type: 'role', id: mutedRole, allow: 0, deny: P.SEND | P.REACT }]);
    await setOv(staffText, [{ type: 'role', id: A.sv.id, allow: 0, deny: P.VIEW }, { type: 'role', id: staffRole, allow: P.VIEW, deny: 0 }]);
    await setOv(meeting, [{ type: 'role', id: A.sv.id, allow: 0, deny: P.CONNECT }, { type: 'role', id: staffRole, allow: P.CONNECT, deny: 0 },
      { type: 'role', id: chatty, allow: P.SEND, deny: P.CONNECT }]);
    await setOv(A.lounge, [{ type: 'member', id: troll.id, allow: 0, deny: P.CONNECT }]);
    // A read-only hall: @everyone may post in none of its text channels, which all have slow mode.
    const B = await mk('Quiet hall');
    const reader = await join(B.code, 'reader');
    const news = await chan(B.sv, 'news', 'text');
    await setOv(B.text, [{ type: 'role', id: B.sv.id, allow: 0, deny: P.SEND }]);
    await setOv(news, [{ type: 'role', id: B.sv.id, allow: 0, deny: P.SEND }]);
    await ok(owner, 'PATCH', `/channels/${B.text.id}`, { slowmode: 120 });
    await ok(owner, 'PATCH', `/channels/${news.id}`, { slowmode: 30 });
    // An ordinary hall with an announcements channel: nothing to carry over.
    const C = await mk('Open hall');
    const guest = await join(C.code, 'guest');
    const ann = await chan(C.sv, 'announcements', 'text');
    await setOv(ann, [{ type: 'role', id: C.sv.id, allow: 0, deny: P.SEND }]);
    const auditCount = (sv) => s2.sql('SELECT COUNT(*) n FROM server_audit WHERE server_id = ?', sv.id)[0].n;
    const before = { A: auditCount(A.sv), B: auditCount(B.sv), C: auditCount(C.sv) };

    // A fresh database marks the step done at once: these channels were made after it, so nothing changed yet.
    assert.equal(s2.sql("SELECT COUNT(*) n FROM instance_settings WHERE key = 'voiceChatLimits'")[0].n, 1);
    assert.equal(ovFor(A.lounge, mutedRole), null);
    // As if this data came from the version before: the step runs on the next start.
    s2.sql("DELETE FROM instance_settings WHERE key = 'voiceChatLimits'");
    await s2.restart();

    // The Lounge: the Muted role and the person kept out of its call can't post; nobody else lost anything.
    assert.deepEqual(ovFor(A.lounge, mutedRole), { type: 'role', id: mutedRole, allow: 0, deny: P.SEND });
    assert.deepEqual(ovFor(A.lounge, troll.id), { type: 'member', id: troll.id, allow: 0, deny: P.CONNECT | P.SEND });
    assert.equal(ovFor(A.lounge, A.sv.id), null, '@everyone untouched');
    assert.equal((await postIn(muted, A.sv, A.lounge)).status, 403);
    assert.equal((await postIn(troll, A.sv, A.lounge)).status, 403);
    assert.equal((await postIn(plain, A.sv, A.lounge)).status, 200);
    assert.equal((await postIn(staff, A.sv, A.lounge)).status, 200);
    // The staff meeting room: whoever couldn't join can't post; Staff's own Connect isn't copied as an allow, so its
    // chat waits for an admin (a non-member of staff could read whatever staff wrote there). Chatty's allow stays.
    assert.deepEqual(ovFor(meeting, A.sv.id), { type: 'role', id: A.sv.id, allow: 0, deny: P.CONNECT | P.SEND });
    assert.deepEqual(ovFor(meeting, staffRole), { type: 'role', id: staffRole, allow: P.CONNECT, deny: 0 });
    assert.deepEqual(ovFor(meeting, chatty), { type: 'role', id: chatty, allow: P.SEND, deny: P.CONNECT });
    assert.deepEqual(ovFor(meeting, mutedRole), { type: 'role', id: mutedRole, allow: 0, deny: P.SEND });
    for (const u of [plain, staff]) assert.equal((await postIn(u, A.sv, meeting)).status, 403);
    assert.equal((await postIn(owner, A.sv, meeting)).status, 200, 'the owner can still post (and open it up)');
    // The text channels are as they were.
    assert.deepEqual(ovs(A.text), [{ type: 'role', id: mutedRole, allow: 0, deny: P.SEND }]);
    // The read-only hall: @everyone can't post in its voice chat either, and it has the shortest slow mode.
    assert.deepEqual(ovFor(B.lounge, B.sv.id), { type: 'role', id: B.sv.id, allow: 0, deny: P.SEND });
    assert.equal(s2.sql('SELECT slowmode FROM channels WHERE id = ?', B.lounge.id)[0].slowmode, 30);
    assert.equal((await postIn(reader, B.sv, B.lounge)).status, 403);
    // The open hall: nothing changed, and its members chat in the Lounge as before.
    assert.deepEqual(ovs(C.lounge), []);
    assert.equal(s2.sql('SELECT slowmode FROM channels WHERE id = ?', C.lounge.id)[0].slowmode, 0);
    assert.equal((await postIn(guest, C.sv, C.lounge)).status, 200);

    // Each change is in the server's audit log, by Hearth itself, saying why.
    const log = async (sv) => (await ok(owner, 'GET', `/servers/${sv.id}/audit?action=channel_overrides,channel_update`)).entries.filter((e) => e.detail && e.detail.voiceChat);
    const la = await log(A.sv);
    assert.deepEqual(la.map((e) => [e.action, e.actorId, e.targetId]).sort(), [['channel_overrides', null, A.lounge.id], ['channel_overrides', null, meeting.id]].sort());
    const lm = la.find((e) => e.targetId === meeting.id).detail.changes;
    assert.deepEqual(lm.map((o) => [o.name, o.deny & P.SEND, o.was.deny & P.SEND]).sort(), [['@everyone', P.SEND, 0], ['Muted', P.SEND, 0]]);
    const lb = await log(B.sv);
    assert.deepEqual(lb.map((e) => e.action).sort(), ['channel_overrides', 'channel_update']);
    assert.deepEqual(lb.find((e) => e.action === 'channel_update').detail.changes, { slowmode: { from: 0, to: 30 } });
    assert.equal(auditCount(C.sv), before.C, 'nothing in the open hall’s log');

    // Once: an admin opens the meeting room's chat to Staff, and the next start leaves that alone.
    await setOv(meeting, [{ type: 'role', id: A.sv.id, allow: 0, deny: P.CONNECT | P.SEND }, { type: 'role', id: staffRole, allow: P.CONNECT | P.SEND, deny: 0 }]);
    assert.equal((await postIn(staff, A.sv, meeting)).status, 200);
    const counts = [auditCount(A.sv), auditCount(B.sv)];
    await s2.restart();
    assert.deepEqual(ovFor(meeting, staffRole), { type: 'role', id: staffRole, allow: P.CONNECT | P.SEND, deny: 0 });
    assert.equal(ovFor(meeting, mutedRole), null);
    assert.deepEqual([auditCount(A.sv), auditCount(B.sv)], counts);
    // Voice channels made from now on start open.
    const later = await chan(B.sv, 'later', 'voice');
    assert.deepEqual(ovs(later), []);
    assert.ok(before.A < counts[0] && before.B < counts[1]);
  } finally { await s2.stop(); }
});
