// Scheduled messages, "Send later" (server/scheduled.js). The app encrypts the message as it would to send it now;
// the server keeps only that ciphertext and posts it at its time exactly like a message sent then (live events,
// pings, unread state). Checked just as much for what it refuses: other people's scheduled messages, bad times and
// payloads, the limits, and everything that stops a message at its time (a timeout, being removed, a deleted channel
// or thread, lost permission, a block, a deleted account), plus key changes, which hold it for re-encrypting
// instead of posting something nobody can read.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { startServer, hex, sleep } = require('./helpers');

const P = { VIEW: 1, SEND: 2, ATTACH: 8 };
const cipher = () => 'c2:1:' + crypto.randomBytes(48).toString('base64');
// The sender's own copy (sealed with their vault key in the app; this server can only check its shape) and its ref.
const draft = () => 'x1:' + crypto.randomBytes(48).toString('base64');
const own = () => ({ ref: crypto.randomBytes(12).toString('hex'), draft: draft() });
const soon = (ms = 1200) => Date.now() + ms;
const HOUR = 3600 * 1000;

let srv; let boss; let server; let code;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const user = async (name, invite = code) => {
  const u = await srv.register(`${name}${hex(3)}`);
  const r = await as(u, 'POST', `/invites/${invite}/join`);
  assert.equal(r.status, 200, r.text);
  return u;
};
const room = async (name = 'room', srvId = server.id, owner = boss) => {
  const r = await as(owner, 'POST', `/servers/${srvId}/channels`, { name: `${name}${hex(2)}`, type: 'text' });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const freshEpoch = (id = server.id, epoch = 1) => srv.sql('UPDATE servers SET key_epoch = ?, needs_rotation = 0 WHERE id = ?', epoch, id);
// Sending in a server needs a current key; someone's app makes one after people leave (here: the test does).
const keyed = (channelId) => srv.sql('UPDATE servers SET needs_rotation = 0 WHERE id = (SELECT server_id FROM channels WHERE id = ?) AND key_epoch > 0', channelId);
const schedule = async (u, channelId, extra = {}) => {
  keyed(channelId);
  const r = await as(u, 'POST', `/channels/${channelId}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(), ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const scheduleDm = async (u, dmId, extra = {}) => {
  const r = await as(u, 'POST', `/dms/${dmId}/scheduled-messages`, { ...own(), ciphertext: cipher(), sendAt: soon(), ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const list = async (u) => {
  const r = await as(u, 'GET', '/scheduled-messages');
  assert.equal(r.status, 200, r.text);
  return r.json.items;
};
const rowOf = (id) => srv.sql('SELECT * FROM scheduled_messages WHERE id = ?', id)[0];
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}
// A server of its own (so key changes and moderation in one test don't touch the others).
async function newServer(name) {
  const s = (await as(boss, 'POST', '/servers', { name })).json;
  const inv = (await as(boss, 'POST', `/servers/${s.id}/invites`, { expiresHours: 0 })).json.code;
  const ch = s.channels.find((c) => c.type === 'text');
  freshEpoch(s.id);
  return { s, inv, ch };
}

before(async () => {
  srv = await startServer();
  boss = srv.owner;
  server = (await as(boss, 'POST', '/servers', { name: 'Later HQ' })).json;
  code = (await as(boss, 'POST', `/servers/${server.id}/invites`, { expiresHours: 0 })).json.code;
  freshEpoch();
});
after(async () => {
  socks.forEach((s) => s.close());
  await srv.stop();
});

// ------------------------------------------------------------------ the happy paths
test('channel: goes out at its time as a normal message, with its pings, and the sender’s apps follow along', async () => {
  const ann = await user('ann'); const ben = await user('ben');
  const ch = await room('later');
  const annS = await sock(ann); const benS = await sock(ben);
  const updates = collect(annS, 'scheduled:update'); const removed = collect(annS, 'scheduled:remove');
  const annNew = collect(annS, 'message:new');
  const benNew = collect(benS, 'message:new'); const benSched = collect(benS, 'scheduled:update');
  const ct = cipher();
  const sendAt = soon(1500);
  const item = await schedule(ann, ch.id, { ciphertext: ct, sendAt, mentions: [ben.id], nonce: 'abcdef123456' });
  assert.equal(item.status, 'pending');
  assert.equal(item.channelId, ch.id);
  assert.equal(item.serverId, server.id);
  assert.equal(item.dmId, null);
  assert.equal(item.ciphertext, ct);
  assert.equal(item.epoch, 1);
  assert.equal(item.sendAt, sendAt);
  assert.ok(item.encryptedAt > 0 && item.createdAt > 0);
  for (const k of ['body', 'text', 'content', 'mentions', 'own_key', 'ownKey', 'user_id', 'session_id', 'sessionId']) assert.equal(k in item, false, `no ${k} in the answer`);
  assert.ok(item.ref && item.draft.startsWith('x1:'), 'the sender’s own copy comes back to their apps');
  await until(() => updates.some((x) => x.id === item.id), 'the live copy for the sender’s other apps');
  assert.deepEqual((await list(ann)).map((x) => x.id), [item.id]);
  assert.deepEqual(await list(ben), [], 'nobody else sees it');
  assert.equal(benNew.length, 0, 'nothing posted before its time');

  const msg = await until(() => benNew.find((m) => m.ciphertext === ct), 'the message at its time');
  assert.equal(msg.authorId, ann.id);
  assert.equal(msg.channelId, ch.id);
  assert.equal(msg.epoch, 1);
  assert.ok(msg.createdAt >= sendAt, 'created when it went out');
  assert.ok(msg.createdAt - sendAt < 3000, 'and on time');
  assert.notEqual(msg.id, item.id, 'a message id of its own');
  assert.equal(msg.nonce, undefined, 'the nonce is never stored');
  const gone = await until(() => removed.find((x) => x.id === item.id), 'scheduled:remove');
  assert.equal(gone.messageId, msg.id);
  assert.equal(rowOf(item.id), undefined);
  assert.deepEqual(await list(ann), []);
  assert.equal(benSched.length, 0, 'other people never hear about it');
  assert.equal(msg.scheduled, undefined, 'nobody else can tell it was scheduled');
  const mine = await until(() => annNew.find((m) => m.id === msg.id), 'the sender’s own copy');
  assert.equal(mine.scheduled, true, 'the sender’s apps are told it went out by itself (so they don’t mark the channel read)');
  assert.equal(annNew.filter((m) => m.id === msg.id).length, 1, 'once');
  // In the history, pinged like any message (and nothing there says it was scheduled).
  const hist = (await as(ben, 'GET', `/channels/${ch.id}/messages`)).json.messages;
  assert.ok(hist.some((m) => m.id === msg.id && m.ciphertext === ct && m.scheduled === undefined));
  assert.equal(srv.sql('SELECT COUNT(*) n FROM mention_marks WHERE message_id = ? AND user_id = ?', msg.id, ben.id)[0].n, 1);
});

test('going out by itself doesn’t mark anything read for its sender: what came meanwhile (pings, DMs, thread replies) stays unread', async () => {
  const ann = await user('rmann'); const ben = await user('rmben'); const ch = await room('readmark');
  const root = (await as(boss, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json;
  const dm = (await as(ann, 'POST', '/dms', { userId: ben.id })).json;
  await as(ann, 'GET', '/me/unread'); // ann's baseline: everything before this counts as read
  await sleep(5);
  const annS = await sock(ann);
  const removed = collect(annS, 'scheduled:remove');
  const reads = collect(annS, 'read:update');
  const a = await schedule(ann, ch.id, { sendAt: soon(1500) });
  const b = await scheduleDm(ann, dm.id, { sendAt: soon(1500) });
  const c = await schedule(ann, ch.id, { sendAt: soon(1500), threadId: root.id });
  // While ann is away: ben pings her in the channel, writes to her, and replies in the thread with a ping.
  await as(ben, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1, mentions: [ann.id] });
  await as(ben, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() });
  await as(ben, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1, threadId: root.id, mentions: [ann.id] });
  const state = async () => (await as(ann, 'GET', '/me/unread')).json.states;
  const thread = async () => (await as(ann, 'GET', `/channels/${ch.id}/threads`)).json.threads.find((t) => t.rootId === root.id);
  let st = await state();
  assert.deepEqual([st['c:' + ch.id].unread, st['c:' + ch.id].mentions, st['d:' + dm.id].unread], [1, 1, 1]);
  assert.deepEqual([(await thread()).unread, (await thread()).mentions], [1, 1]);
  await until(() => [a, b, c].every((x) => removed.some((y) => y.id === x.id)), 'all three sent');
  st = await state();
  assert.equal(st['c:' + ch.id].unread, 1, 'the channel message ben wrote meanwhile is still unread');
  assert.equal(st['c:' + ch.id].mentions, 1, 'and so is his ping');
  assert.equal(st['d:' + dm.id].unread, 1, 'the DM too');
  const t = await thread();
  assert.deepEqual([t.unread, t.mentions], [1, 1], 'and the thread reply');
  assert.equal(reads.filter((x) => x.conv === 't:' + root.id).length, 0, 'no “read” sent to ann’s apps for the thread');
  // Her own messages never count as unread for her, scheduled or not.
  await as(ann, 'POST', '/me/read', { conv: 'c:' + ch.id, messageId: removed.find((x) => x.id === a.id).messageId });
  assert.equal((await state())['c:' + ch.id].unread, 0);
});

test('thread replies and replies keep their place; a reply to a deleted message just loses it', async () => {
  const ann = await user('tann'); const ch = await room('thready');
  const root = (await as(boss, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json;
  const other = (await as(boss, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json;
  const annS = await sock(ann);
  const removed = collect(annS, 'scheduled:remove');
  const a = await schedule(ann, ch.id, { threadId: root.id, sendAt: soon(900) });
  const b = await schedule(ann, ch.id, { replyTo: other.id, sendAt: soon(1000) });
  assert.equal(a.threadId, root.id);
  assert.equal(b.replyTo, other.id);
  await as(boss, 'DELETE', `/messages/${other.id}`);
  await until(() => removed.length === 2, 'both sent');
  const ra = srv.sql('SELECT * FROM messages WHERE id = ?', removed.find((x) => x.id === a.id).messageId)[0];
  const rb = srv.sql('SELECT * FROM messages WHERE id = ?', removed.find((x) => x.id === b.id).messageId)[0];
  assert.equal(ra.thread_id, root.id);
  assert.equal(srv.sql('SELECT last_reply_id FROM thread_activity WHERE root_id = ?', root.id)[0].last_reply_id, ra.id);
  assert.equal(rb.reply_to, null, 'the message it replied to was deleted meanwhile');
});

test('DM and group chat: go out at their time to the other people', async () => {
  const ann = await user('dann'); const ben = await user('dben');
  const dm = (await as(ann, 'POST', '/dms', { userId: ben.id })).json;
  const benS = await sock(ben);
  const benDm = collect(benS, 'dm:message'); const benNew = collect(benS, 'message:new');
  const ct = cipher();
  const item = await scheduleDm(ann, dm.id, { ciphertext: ct, sendAt: soon(1000) });
  assert.equal(item.dmId, dm.id);
  assert.equal(item.channelId, null);
  assert.equal(item.epoch, null);
  const got = await until(() => benDm.find((x) => x.message.ciphertext === ct), 'the DM');
  assert.equal(got.message.authorId, ann.id);
  assert.equal(got.dm.id, dm.id);
  assert.ok(got.message.createdAt >= item.sendAt);
  assert.equal(rowOf(item.id), undefined);

  const group = (await as(ann, 'POST', '/groups', { userIds: [ben.id] })).json;
  freshEpoch(group.id);
  const chat = group.channels.find((c) => c.type === 'text');
  const gct = cipher();
  await schedule(ann, chat.id, { ciphertext: gct, sendAt: soon(900) });
  const gm = await until(() => benNew.find((m) => m.ciphertext === gct), 'the group message');
  assert.equal(gm.serverId, group.id);
});

// ------------------------------------------------------------------ disappearing messages and voice chats
test('disappearing messages: scheduled for the timer in force, then posted with a deadline counted from when it goes out, by the timer then and never later than the one it was written for', async () => {
  const ann = await user('xann'); const ben = await user('xben');
  const ch = await room('fleeting');
  assert.equal((await as(boss, 'PUT', `/channels/${ch.id}/disappearing`, { seconds: 3600 })).status, 200);
  // The app says which timer it encrypted for, as when sending: one that doesn't match isn't scheduled.
  keyed(ch.id);
  const stale = await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(), ttl: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'disappear_changed');
  const benS = await sock(ben);
  const benNew = collect(benS, 'message:new');
  const at = async (ct, what) => until(() => benNew.find((m) => m.ciphertext === ct), what);
  // Posted under the same timer: its deadline is an hour after it went out (not after it was scheduled), and its file's too.
  const f = await uploadBlob(ann);
  const ct1 = cipher();
  const item = await schedule(ann, ch.id, { ciphertext: ct1, sendAt: soon(1500), ttl: 3600, files: [f] });
  assert.equal(item.ttl, 3600);
  assert.equal(rowOf(item.id).ttl, 3600);
  const m1 = await at(ct1, 'the message at its time');
  assert.ok(m1.createdAt >= item.sendAt);
  assert.equal(m1.expiresAt, m1.createdAt + 3600 * 1000, 'its deadline counts from when it went out');
  assert.equal(srv.sql('SELECT expires_at FROM blobs WHERE name = ?', path.basename(f))[0].expires_at, m1.expiresAt, 'and its file goes with it');
  // Made shorter before its time: the channel's timer then wins.
  const ct2 = cipher();
  await schedule(ann, ch.id, { ciphertext: ct2, sendAt: soon(1500), ttl: 3600 });
  srv.sql('UPDATE channels SET disappear_secs = 86400 WHERE id = ?', ch.id);
  srv.sql('UPDATE channels SET disappear_secs = 600 WHERE id = ?', ch.id);
  const m2 = await at(ct2, 'the second');
  assert.equal(m2.expiresAt, m2.createdAt + 600 * 1000);
  // Turned off before its time: it still goes when its sender expected (the timer inside it says so too).
  srv.sql('UPDATE channels SET disappear_secs = 3600 WHERE id = ?', ch.id);
  const ct3 = cipher();
  await schedule(ann, ch.id, { ciphertext: ct3, sendAt: soon(1500), ttl: 3600 });
  srv.sql('UPDATE channels SET disappear_secs = 0 WHERE id = ?', ch.id);
  const m3 = await at(ct3, 'the third');
  assert.equal(m3.expiresAt, m3.createdAt + 3600 * 1000);
  // Scheduled with the timer off and turned on before its time: the channel's timer.
  const ct4 = cipher();
  await schedule(ann, ch.id, { ciphertext: ct4, sendAt: soon(1500), ttl: 0 });
  srv.sql('UPDATE channels SET disappear_secs = 86400 WHERE id = ?', ch.id);
  const m4 = await at(ct4, 'the fourth');
  assert.equal(m4.expiresAt, m4.createdAt + 86400 * 1000);
  // Re-encrypting (PATCH with new ciphertext) checks the timer again and keeps the new one.
  const later = await schedule(ann, ch.id, { sendAt: soon(HOUR), ttl: 86400 });
  srv.sql('UPDATE channels SET disappear_secs = 3600 WHERE id = ?', ch.id);
  const old = await as(ann, 'PATCH', `/scheduled-messages/${later.id}`, { ...own(), ciphertext: cipher(), epoch: 1, ttl: 86400 });
  assert.equal(old.status, 409);
  assert.equal(old.json.code, 'disappear_changed');
  const fresh = await as(ann, 'PATCH', `/scheduled-messages/${later.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1, ttl: 3600 });
  assert.equal(fresh.status, 200, fresh.text);
  assert.equal(fresh.json.ttl, 3600);
  await as(ann, 'DELETE', `/scheduled-messages/${later.id}`);
  // A DM the same way.
  const dm = (await as(ann, 'POST', '/dms', { userId: ben.id })).json;
  srv.sql('UPDATE dm_channels SET disappear_secs = 3600 WHERE id = ?', dm.id);
  const benDm = collect(benS, 'dm:message');
  assert.equal((await as(ann, 'POST', `/dms/${dm.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), sendAt: soon(), ttl: 600 })).json.code, 'disappear_changed');
  const dct = cipher();
  await scheduleDm(ann, dm.id, { ciphertext: dct, sendAt: soon(1200), ttl: 3600 });
  srv.sql('UPDATE dm_channels SET disappear_secs = 600 WHERE id = ?', dm.id);
  const dmsg = await until(() => benDm.find((x) => x.message.ciphertext === dct), 'the DM');
  assert.equal(dmsg.message.expiresAt, dmsg.message.createdAt + 600 * 1000);
  srv.sql('UPDATE channels SET disappear_secs = 0 WHERE id = ?', ch.id);
});

test('disappearing messages: re-encrypting a scheduled message (a key change, an edit) keeps the timer it was written for; one turned off or made longer since never makes it last longer', async () => {
  const ann = await user('rann'); const ben = await user('rben');
  const ch = await room('secret');
  assert.equal((await as(boss, 'PUT', `/channels/${ch.id}/disappearing`, { seconds: 3600 })).status, 200);
  const benS = await sock(ben);
  const benNew = collect(benS, 'message:new');
  // Written under a 1-hour timer. A moderator turns it off, then the server's key changes, so it's held: the app
  // re-encrypts it with the timer as it is now beside it (ttl 0, which the server checks).
  const item = await schedule(ann, ch.id, { sendAt: soon(HOUR), ttl: 3600 });
  assert.equal((await as(boss, 'PUT', `/channels/${ch.id}/disappearing`, { seconds: 0 })).status, 200);
  srv.sql("UPDATE scheduled_messages SET status = 'held', reason = 'key' WHERE id = ?", item.id);
  const ct = cipher();
  const re = await as(ann, 'PATCH', `/scheduled-messages/${item.id}`, { draft: draft(), ciphertext: ct, epoch: 1, ttl: 0, sendAt: soon(1500) });
  assert.equal(re.status, 200, re.text);
  assert.equal(re.json.status, 'pending');
  assert.equal(re.json.ttl, 3600, 'it keeps the timer it was written for');
  const m = await until(() => benNew.find((x) => x.ciphertext === ct), 'the re-encrypted message');
  assert.equal(m.expiresAt, m.createdAt + 3600 * 1000, 'and disappears when its sender expected, as it would have untouched');
  // Made longer since: an edit keeps the shorter one. So does an app that doesn't say which timer it encrypted for.
  srv.sql('UPDATE channels SET disappear_secs = 3600 WHERE id = ?', ch.id);
  const b = await schedule(ann, ch.id, { sendAt: soon(HOUR), ttl: 3600 });
  srv.sql('UPDATE channels SET disappear_secs = 86400 WHERE id = ?', ch.id);
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${b.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1, ttl: 86400 })).json.ttl, 3600);
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${b.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1 })).json.ttl, 3600);
  // Shortened since: the conversation's timer applies.
  srv.sql('UPDATE channels SET disappear_secs = 600 WHERE id = ?', ch.id);
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${b.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1, ttl: 600 })).json.ttl, 600);
  assert.equal(rowOf(b.id).ttl, 600);
  // Written with none and turned on since: the conversation's.
  srv.sql('UPDATE channels SET disappear_secs = 0 WHERE id = ?', ch.id);
  const c = await schedule(ann, ch.id, { sendAt: soon(HOUR), ttl: 0 });
  srv.sql('UPDATE channels SET disappear_secs = 3600 WHERE id = ?', ch.id);
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${c.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1, ttl: 3600 })).json.ttl, 3600);
  // A DM the same way.
  const dm = (await as(ann, 'POST', '/dms', { userId: ben.id })).json;
  srv.sql('UPDATE dm_channels SET disappear_secs = 86400 WHERE id = ?', dm.id);
  const d = await scheduleDm(ann, dm.id, { sendAt: soon(HOUR), ttl: 86400 });
  srv.sql('UPDATE dm_channels SET disappear_secs = 0 WHERE id = ?', dm.id);
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${d.id}`, { draft: draft(), ciphertext: cipher(), ttl: 0 })).json.ttl, 86400);
  for (const x of [b, c, d]) await as(ann, 'DELETE', `/scheduled-messages/${x.id}`);
});

// The app's side (public/js/scheduled.js), run in Node with its imports replaced by small fakes (loaded once).
let clientModule = null;
async function clientScheduled() {
  if (clientModule) return clientModule;
  const { register } = require('node:module');
  const fakes = {
    './util.js': `export const h = () => ({ append() {}, classList: { add() {} } }); export const clear = (x) => x; export const icon = () => null;
      export const toast = (...a) => globalThis.__sched.toasts.push(a); export const fmtTime = (t) => String(t); export const copyText = async () => {};`,
    './api.js': 'export const api = (...a) => globalThis.__sched.api(...a);',
    './ui.js': 'export const modal = () => ({ box: null, close() {} }); export const menu = () => {}; export const confirmDialog = async () => false; export const showError = () => {}; export const field = () => null;',
    './markdown.js': 'export const linkedUrls = () => [];',
    './disappear.js': 'export const label = (s) => `${s} seconds`;',
  };
  const urls = Object.fromEntries(Object.entries(fakes).map(([k, src]) => [k, 'data:text/javascript,' + encodeURIComponent(src)]));
  register('data:text/javascript,' + encodeURIComponent(`const urls = ${JSON.stringify(urls)};
    export async function resolve(spec, ctx, next) {
      if (ctx.parentURL && ctx.parentURL.endsWith('/public/js/scheduled.js') && urls[spec]) return { url: urls[spec], shortCircuit: true };
      return next(spec, ctx);
    }`));
  clientModule = await import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'scheduled.js')).href);
  return clientModule;
}
// Re-encrypting passes the timer from the sender's own copy on to sealFor (which puts the stricter of it and the
// conversation's timer inside the message), so a message re-encrypted by itself after a key change keeps it.
// (The copies name their scheduled message, sid, as the composer's do once the server has answered: only those, or
// ones this device made, are re-encrypted by themselves; see the replay test below.)
test('the app re-encrypts a held message with the timer its own copy was written for', async () => {
  const { createScheduled } = await clientScheduled();
  const patches = []; const sealed = [];
  globalThis.__sched = {
    toasts: [],
    api: async (method, p, body) => {
      if (method !== 'PATCH') throw new Error(`unexpected ${method} ${p}`);
      patches.push([p, body]);
      const id = p.split('/').pop();
      return { ...items[id], status: 'pending', reason: null, ciphertext: body.ciphertext, draft: body.draft };
    },
  };
  const copies = { a: { t: 'see you at 9', f: [], x: 3600, sid: 'a' }, b: { t: 'no timer', f: [], sid: 'b' } };
  const base = { serverId: 's1', channelId: 'c1', dmId: null, threadId: null, status: 'held', reason: 'key', sendAt: Date.now() + HOUR, ciphertext: 'old', files: 0 };
  const items = {
    a: { ...base, id: 'a', ref: 'a'.repeat(16), draft: 'x1:copy-a', ttl: 3600 },
    b: { ...base, id: 'b', ref: 'b'.repeat(16), draft: 'x1:copy-b', ttl: 0 },
  };
  const sched = createScheduled({
    me: () => ({ id: 'u1' }),
    openDraft: async (it) => copies[it.id],
    // The conversation's timer was turned off since: ttl 0 beside it.
    sealFor: async (key, payload, keep) => { sealed.push({ key, payload, keep }); return { ciphertext: 'new-' + keep.ref, epoch: 2, ttl: 0, draft: 'x1:again' }; },
    withKeyRetry: (serverId, fn) => fn(),
    refreshTimer: async () => {},
    placeOf: () => ({ label: '#secret', dm: false }),
    onChange: () => {},
    openKey: () => {},
  });
  sched.onUpdate(items.a);
  await until(() => patches.length === 1, 'the first one re-encrypted by itself');
  sched.onUpdate(items.b);
  await until(() => patches.length === 2, 'the second one too');
  const of = (ref) => sealed.find((x) => x.keep.ref === ref);
  assert.equal(of(items.a.ref).key, 'c:c1');
  assert.deepEqual(of(items.a.ref).keep, { ref: items.a.ref, threadId: null, x: 3600, sid: 'a' }, 'the timer from its own copy goes to sealFor, and the new copy names it');
  assert.equal(of(items.a.ref).payload.t, 'see you at 9');
  assert.equal(of(items.b.ref).keep.x, 0, 'one written without a timer has none to keep');
  assert.ok(patches.every(([, body]) => body.sendNow === true && body.epoch === 2));
  assert.deepEqual(globalThis.__sched.toasts, []);
});

// A new sign-in token holds what the session had waiting (token_renewed). The app re-encrypts those by itself, like
// after a key change, but only from copies that open with its own keys; and the live event can reach it before it
// has the new token, so a try turned away then (401) is tried again once it's back with the new one.
test('the app re-encrypts by itself what a new sign-in token held, only from its own copies, and again after reconnecting', async () => {
  const { createScheduled } = await clientScheduled();
  const patches = [];
  let refuse = true; // still on the old token
  const base = { serverId: 's1', channelId: 'c1', dmId: null, threadId: null, status: 'held', reason: 'token_renewed', sendAt: Date.now() + HOUR, ciphertext: 'old', files: 0, ttl: 0 };
  const items = {
    mine: { ...base, id: 'mine', ref: 'm'.repeat(16), draft: 'x1:mine' },
    copy: { ...base, id: 'copy', ref: 'c'.repeat(16), draft: 'x1:made-with-a-copy-of-the-token' },
  };
  globalThis.__sched = {
    toasts: [],
    api: async (method, p, body) => {
      if (method === 'GET' && p === '/scheduled-messages') return { items: Object.values(items) };
      if (method !== 'PATCH') throw new Error(`unexpected ${method} ${p}`);
      if (refuse) { const e = new Error('Not signed in.'); e.status = 401; e.code = 'signed_out'; throw e; }
      patches.push([p, body]);
      const id = p.split('/').pop();
      return { ...items[id], status: 'pending', reason: null, ciphertext: body.ciphertext, draft: body.draft };
    },
  };
  const sched = createScheduled({
    me: () => ({ id: 'u1' }),
    openDraft: async (it) => { if (it.id !== 'mine') throw new Error('doesn\u2019t open'); return { t: 'see you at 9', f: [], sid: 'mine' }; },
    sealFor: async (key, payload, keep) => ({ ciphertext: 'new-' + keep.ref, epoch: 1, ttl: 0, draft: 'x1:again' }),
    withKeyRetry: (serverId, fn) => fn(),
    refreshTimer: async () => {},
    placeOf: () => ({ label: '#general', dm: false }),
    onChange: () => {},
    openKey: () => {},
  });
  sched.onUpdate(items.mine);
  sched.onUpdate(items.copy);
  await sleep(100);
  assert.equal(patches.length, 0, 'turned away while the old token was still in use');
  refuse = false;
  await sched.load(); // reconnected with the new token
  await until(() => patches.length === 1, 'its own one re-encrypted');
  assert.equal(patches[0][0], '/scheduled-messages/mine');
  assert.equal(patches[0][1].ciphertext, 'new-' + items.mine.ref);
  await sleep(100);
  assert.equal(patches.length, 1, 'never the one whose copy doesn\u2019t open');
  assert.deepEqual(globalThis.__sched.toasts, []);
});

// A stolen session (the sender's token, no identity key) keeps the sender's own copy of a scheduled message from the
// list, and after the sender cancels it puts it back as new scheduled messages (junk ciphertext, a reply target of its
// choosing), then gets the key changed (a throwaway member joins and leaves). The sender's app, with its real vault,
// must not re-encrypt and re-sign those words by itself: neither the copy as the composer first made it, nor the one
// naming the cancelled message. Its own waiting ones still are: one whose copy names it, and one this device made.
test('a copy of a cancelled scheduled message put back by a stolen session is never re-encrypted by itself; the app\u2019s own still are', async () => {
  globalThis.window = globalThis.window || globalThis; // e2ee.js asks window.crypto for WebCrypto
  const E2EE = await import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'e2ee.js')).href);
  const { createScheduled } = await clientScheduled();
  const { s, inv, ch } = await newServer('Replay');
  const ann = await user('rpann', inv);
  const tmp = await user('rptmp', inv); // leaves later, so the key has to change
  freshEpoch(s.id);
  const key = 'c:' + ch.id;
  // Ann's vault key, derived from her identity key exactly as the app does (E2EE.vaultKey).
  const priv = await crypto.webcrypto.subtle.importKey('pkcs8', ann.privateKey.export({ type: 'pkcs8', format: 'der' }), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const vk = await E2EE.vaultKey(priv, ann.publicKey);
  const draftId = (ref, k, threadId) => `${ref}|${k}|${threadId || ''}`; // app.js draftId
  const seal = (ref, payload) => E2EE.sealVault(vk, 'scheduled', draftId(ref, key, null), payload);
  const target = (await as(boss, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json;
  const targetId = (target.message || target).id;
  // What the composer does (app.js sendOnce + bindScheduled): schedule with a copy, then seal it again naming the
  // scheduled message and hand the server the same ciphertext with it.
  async function scheduleLikeTheApp(words, { bind = true } = {}) {
    const ref = crypto.randomBytes(16).toString('hex');
    const first = await seal(ref, { t: words, f: [] });
    const body = { ciphertext: cipher(), epoch: 1 };
    const r = await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...body, ref, draft: first, sendAt: soon(HOUR) });
    assert.equal(r.status, 200, r.text);
    if (!bind) return { item: r.json, first };
    const p = await as(ann, 'PATCH', `/scheduled-messages/${r.json.id}`, { ...body, draft: await seal(ref, { t: words, f: [], sid: r.json.id }) });
    assert.equal(p.status, 200, p.text);
    return { item: p.json, first };
  }
  const WORDS = 'I am resigning, effective immediately. (withdrawn)';
  const orig = await scheduleLikeTheApp(WORDS);
  const mine = await scheduleLikeTheApp('still on: lunch at 1'); // made on another of her devices
  const here = await scheduleLikeTheApp('still on: the 3 pm call', { bind: false }); // made on this one (not bound)

  // The attacker keeps both copies (the list has the bound one; the live scheduled:update for the POST had the first).
  const stolen = (await list(ann)).find((x) => x.id === orig.item.id);
  assert.notEqual(stolen.draft, orig.first, 'the copy on the server names its scheduled message');
  assert.equal((await as(ann, 'DELETE', `/scheduled-messages/${orig.item.id}`)).status, 200);
  const replays = [];
  for (const copy of [orig.first, stolen.draft]) {
    const r = await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ref: stolen.ref, draft: copy, ciphertext: cipher(), epoch: 1, sendAt: soon(4000), replyTo: targetId });
    assert.equal(r.status, 200, r.text);
    replays.push(r.json.id);
  }
  // The key has to change: someone leaves; a member's app makes the new one.
  assert.equal((await as(tmp, 'POST', `/servers/${s.id}/leave`)).status, 200);
  const all = [...replays, mine.item.id, here.item.id];
  await until(() => all.every((id) => rowOf(id).status === 'held'), 'held for the new key');
  freshEpoch(s.id, 2);

  // Ann's app opens (the real scheduled.js, her real vault). sealFor stands in for app.js: what it would encrypt and
  // sign under epoch 2, with the copy it would seal (naming keep.sid).
  const patches = []; const resealed = [];
  globalThis.__sched = {
    toasts: [],
    api: async (method, p, body) => {
      if (method === 'PATCH') patches.push(p.split('/').pop());
      const r = await as(ann, method, p, body);
      if (r.status >= 400) throw Object.assign(new Error(r.json && r.json.error), { status: r.status, code: r.json && r.json.code });
      return r.json;
    },
  };
  const sched = createScheduled({
    me: () => ({ id: ann.id }),
    openDraft: (it) => E2EE.openVault(vk, 'scheduled', draftId(it.ref, it.dmId ? 'd:' + it.dmId : 'c:' + it.channelId, it.threadId), it.draft),
    sealFor: async (k, payload, keep) => {
      resealed.push({ t: payload.t, sid: keep.sid });
      return { ciphertext: cipher().replace('c2:1:', 'c2:2:'), epoch: 2, ttl: 0, draft: await seal(keep.ref, keep.sid ? { ...payload, sid: keep.sid } : payload) };
    },
    withKeyRetry: (serverId, fn) => fn(), refreshTimer: async () => {}, placeOf: () => ({ label: '#x', dm: false }), onChange: () => {}, openKey: () => {},
  });
  sched.added(here.item); // the composer on this device scheduled it
  await sched.load();
  await until(() => patches.length >= 2, 'her own two re-encrypted by themselves');
  // Past the replays' time: nothing more happens.
  await sleep(Math.max(0, rowOf(replays[0]).send_at - Date.now()) + 1500);
  assert.deepEqual(patches.sort(), [mine.item.id, here.item.id].sort(), 'only her own waiting ones were re-encrypted');
  assert.deepEqual(resealed.map((x) => x.t).sort(), ['still on: lunch at 1', 'still on: the 3 pm call'], 'the withdrawn words were never re-encrypted');
  assert.ok(resealed.every((x) => x.sid), 'each new copy names its scheduled message');
  for (const id of replays) assert.equal(rowOf(id).status, 'held', 'the replays wait, as they were');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE channel_id = ? AND author_id = ?', ch.id, ann.id)[0].n, 0, 'nothing was posted as her');
  assert.deepEqual(globalThis.__sched.toasts, []);
  // Bound to it now: another key change, and any of her apps re-encrypts it by itself (this one forgets it made it).
  const again = createScheduled({
    me: () => ({ id: ann.id }),
    openDraft: (it) => E2EE.openVault(vk, 'scheduled', draftId(it.ref, 'c:' + it.channelId, it.threadId), it.draft),
    sealFor: async (k, payload, keep) => ({ ciphertext: cipher().replace('c2:1:', 'c2:3:'), epoch: 3, ttl: 0, draft: await seal(keep.ref, { ...payload, sid: keep.sid }) }),
    withKeyRetry: (serverId, fn) => fn(), refreshTimer: async () => {}, placeOf: () => ({ label: '#x', dm: false }), onChange: () => {}, openKey: () => {},
  });
  freshEpoch(s.id, 3);
  patches.length = 0;
  await again.load(); // (the list holds what still has epoch 2)
  await until(() => patches.includes(here.item.id) && patches.includes(mine.item.id), 'both re-encrypted by another app once their copies name them');
  await sleep(300);
  assert.ok(!patches.some((id) => replays.includes(id)), 'never the replays');
  for (const id of [...replays, mine.item.id, here.item.id]) await as(ann, 'DELETE', `/scheduled-messages/${id}`);
});

test('voice channels: their chats take scheduled messages like a text channel; threads stay in text channels; a group call has no chat', async () => {
  const ann = await user('vann'); const ben = await user('vben');
  const vc = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: `lounge${hex(2)}`, type: 'voice' })).json;
  const benS = await sock(ben);
  const benNew = collect(benS, 'message:new');
  const ct = cipher();
  const item = await schedule(ann, vc.id, { ciphertext: ct, sendAt: soon(1200) });
  assert.equal(item.channelId, vc.id);
  const m = await until(() => benNew.find((x) => x.ciphertext === ct), 'the voice chat message at its time');
  assert.equal(m.channelId, vc.id);
  // No threads there.
  const root = (await as(ann, 'POST', `/channels/${vc.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json;
  keyed(vc.id);
  const th = await as(ann, 'POST', `/channels/${vc.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR), threadId: root.id });
  assert.equal(th.status, 400);
  // A group's call has no chat of its own (the group's conversation is it).
  const group = (await as(ann, 'POST', '/groups', { userIds: [ben.id] })).json;
  freshEpoch(group.id);
  const call = group.channels.find((c) => c.type === 'voice');
  const g = await as(ann, 'POST', `/channels/${call.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR) });
  assert.equal(g.status, 400);
});

test('list, edit, reschedule, send now and cancel: your own only', async () => {
  const ann = await user('eann'); const ben = await user('eben'); const ch = await room('edits');
  const benS = await sock(ben);
  const benNew = collect(benS, 'message:new');
  const a = await schedule(ann, ch.id, { sendAt: Date.now() + 2 * HOUR });
  const b = await schedule(ann, ch.id, { sendAt: Date.now() + HOUR });
  assert.deepEqual((await list(ann)).map((x) => x.id), [b.id, a.id], 'soonest first');

  // Nobody else can see, change, send or cancel them, and can't tell them from ones that don't exist.
  for (const [m, p, body] of [['PATCH', `/scheduled-messages/${a.id}`, { sendAt: Date.now() + HOUR }], ['POST', `/scheduled-messages/${a.id}/send`], ['DELETE', `/scheduled-messages/${a.id}`],
    ['PATCH', '/scheduled-messages/nope', { sendAt: Date.now() + HOUR }], ['DELETE', `/scheduled-messages/${'x'.repeat(65)}`], ['POST', '/scheduled-messages/%27%20OR%201%3D1/send']]) {
    const r = await as(ben, m, p, body);
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(r.json.error, 'Scheduled message not found.');
  }
  assert.equal((await srv.api('GET', '/scheduled-messages')).status, 401);
  assert.equal((await srv.api('DELETE', `/scheduled-messages/${a.id}`)).status, 401);
  assert.ok(rowOf(a.id));

  // Edit: new ciphertext (with the current epoch), when it was written moves on.
  await sleep(5);
  const ct = cipher();
  let r = await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, { draft: draft(), ciphertext: ct, epoch: 1, mentions: [ben.id] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ciphertext, ct);
  assert.ok(r.json.encryptedAt > a.encryptedAt);
  assert.equal(r.json.sendAt, a.sendAt);
  assert.deepEqual(JSON.parse(rowOf(a.id).mentions), [ben.id]);
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, { draft: draft(), ciphertext: 'short', epoch: 1 })).status, 400);
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, { draft: draft(), ciphertext: cipher(), epoch: 7 })).json.code, 'stale-key');
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, {})).status, 400);
  // Reschedule.
  const later = Date.now() + 3 * HOUR;
  r = await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, { sendAt: later });
  assert.equal(r.json.sendAt, later);
  assert.equal(r.json.ciphertext, ct, 'rescheduling keeps the message');
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, { sendAt: Date.now() - 1000 })).json.code, 'send_at');
  // Send now: posted at once, like a message sent now.
  r = await as(ann, 'POST', `/scheduled-messages/${a.id}/send`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.message.ciphertext, ct);
  assert.equal(r.json.message.authorId, ann.id);
  await until(() => benNew.some((m) => m.id === r.json.message.id), 'the message sent now');
  assert.equal(rowOf(a.id), undefined);
  assert.equal((await as(ann, 'POST', `/scheduled-messages/${a.id}/send`)).status, 404, 'only once');
  // Cancel.
  assert.equal((await as(ann, 'DELETE', `/scheduled-messages/${b.id}`)).status, 200);
  assert.equal((await as(ann, 'DELETE', `/scheduled-messages/${b.id}`)).status, 404);
  assert.deepEqual(await list(ann), []);
  await sleep(300);
  assert.equal(benNew.length, 1, 'the cancelled one never went out');
});

test('new words replace who it pings: @everyone or an @name edited out pings nobody', async () => {
  const ben = await user('evben'); const ch = await room('pings');
  // boss may use @everyone; he schedules one with it and a ping for ben, then edits both out.
  const it = await schedule(boss, ch.id, { sendAt: soon(HOUR), everyone: true, mentions: [ben.id] });
  assert.equal(rowOf(it.id).everyone, 1);
  // What the app sends for new words without @everyone (everyone: false, or left out by an older app).
  let r = await as(boss, 'PATCH', `/scheduled-messages/${it.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1, mentions: [] });
  assert.equal(r.status, 200, r.text);
  assert.equal(rowOf(it.id).everyone, 0, 'everyone left out: no @everyone');
  assert.deepEqual(JSON.parse(rowOf(it.id).mentions), []);
  r = await as(boss, 'PATCH', `/scheduled-messages/${it.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1, everyone: true, mentions: [ben.id] });
  assert.equal(rowOf(it.id).everyone, 1);
  r = await as(boss, 'PATCH', `/scheduled-messages/${it.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1, everyone: false });
  assert.equal(rowOf(it.id).everyone, 0);
  assert.deepEqual(JSON.parse(rowOf(it.id).mentions), [], 'no mentions given: none');
  // Rescheduling alone keeps them (the words didn't change).
  await as(boss, 'PATCH', `/scheduled-messages/${it.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1, everyone: true, mentions: [ben.id] });
  await as(boss, 'PATCH', `/scheduled-messages/${it.id}`, { sendAt: soon(HOUR) });
  assert.equal(rowOf(it.id).everyone, 1);
  await as(boss, 'PATCH', `/scheduled-messages/${it.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1 });
  // Sent: nobody is pinged.
  const bossS = await sock(boss);
  const gone = collect(bossS, 'scheduled:remove');
  assert.equal((await as(boss, 'POST', `/scheduled-messages/${it.id}/send`)).status, 200);
  const sent = await until(() => gone.find((x) => x.id === it.id), 'sent');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM mention_marks WHERE message_id = ?', sent.messageId)[0].n, 0, 'no ping recorded, for everyone or for ben');
});

// ------------------------------------------------------------------ input and limits
test('validation: the time, the ciphertext and the rest of the input', async () => {
  const ann = await user('vann'); const ch = await room('valid');
  for (const sendAt of [undefined, null, '', 'soon', true, 1.5, Date.now() - 1000, Date.now(), Date.now() + 31 * 24 * HOUR, 1e300, [Date.now() + HOUR], { t: 1 }, String(Date.now() + HOUR)]) {
    const r = await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt });
    assert.equal(r.status, 400, `sendAt ${JSON.stringify(sendAt)}`);
    assert.equal(r.json.code, 'send_at');
  }
  assert.equal((await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: Date.now() + 29 * 24 * HOUR })).status, 200, 'up to 30 days ahead');
  for (const ciphertext of [undefined, '', 'tiny', 42, { a: 1 }, 'x'.repeat(64001)]) {
    assert.equal((await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext, epoch: 1, sendAt: soon(HOUR) })).status, 400, `ciphertext ${String(ciphertext).slice(0, 10)}`);
  }
  assert.equal((await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: 'y'.repeat(64000), epoch: 1, sendAt: soon(HOUR) })).status, 200, 'the same size limit as sending');
  // Mentions and files: only well-formed ones are kept; a reply elsewhere is dropped; a missing thread is refused.
  const elsewhere = (await as(boss, 'POST', `/channels/${(await room('other')).id}/messages`, { ciphertext: cipher(), epoch: 1 })).json;
  const it = await schedule(ann, ch.id, { sendAt: soon(HOUR), mentions: ['x y', 5, {}, 'a'.repeat(65), boss.id, boss.id], files: ['/uploads/../../etc/passwd', '/uploads/nothere.bin', 7], everyone: 'yes', replyTo: elsewhere.id });
  const row = rowOf(it.id);
  assert.deepEqual(JSON.parse(row.mentions), [boss.id]);
  assert.deepEqual(JSON.parse(row.files), [], 'only blobs you uploaded and haven’t used');
  assert.equal(row.everyone, 0);
  assert.equal(row.reply_to, null);
  assert.equal(it.files, 0);
  assert.equal((await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR), threadId: 'nope' })).status, 404);
  // The key epoch must be the current one, as for sending.
  const stale = await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 0, sendAt: soon(HOUR) });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'stale-key');
  // Places you can't post in. (A server's voice channel has a chat, so it takes them: see the voice channels test. A
  // group's call has no chat of its own.)
  const grp = (await as(ann, 'POST', '/groups', { userIds: [boss.id] })).json;
  freshEpoch(grp.id);
  const call = grp.channels.find((c) => c.type === 'voice');
  assert.equal((await as(ann, 'POST', `/channels/${call.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR) })).status, 400);
  const outsider = await srv.register(`out${hex(3)}`);
  assert.equal((await as(outsider, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR) })).status, 404);
  assert.equal((await as(outsider, 'POST', '/channels/nope/scheduled-messages', { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR) })).status, 404);
  const dm = (await as(ann, 'POST', '/dms', { userId: boss.id })).json;
  assert.equal((await as(outsider, 'POST', `/dms/${dm.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), sendAt: soon(HOUR) })).status, 404, 'someone else’s DM');
  // Not a word of plaintext anywhere in the table: only what the app sent.
  const cols = srv.sql("SELECT name FROM pragma_table_info('scheduled_messages')").map((c) => c.name);
  for (const c of ['body', 'text', 'content']) assert.equal(cols.includes(c), false);
});

test('the sender’s own copy (draft) and its ref: required, checked for shape, replaced with the ciphertext', async () => {
  const ann = await user('drann'); const ch = await room('drafts');
  const dm = (await as(ann, 'POST', '/dms', { userId: boss.id })).json;
  const body = (extra) => ({ ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR), ...own(), ...extra });
  for (const bad of [{ draft: undefined }, { draft: '' }, { draft: 'c2:1:' + 'a'.repeat(40) }, { draft: 'x1:short' }, { draft: 'x1:' + 'a'.repeat(66000) }, { draft: ['x1:' + 'a'.repeat(40)] },
    { ref: undefined }, { ref: 'short' }, { ref: 'x'.repeat(65) }, { ref: 'has spaces in it ok' }, { ref: 12345678901234567 }]) {
    const r = await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, body(bad));
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
    assert.equal(r.json.code, 'draft');
    const d = await as(ann, 'POST', `/dms/${dm.id}/scheduled-messages`, body(bad));
    assert.equal(d.status, 400, 'DMs too');
  }
  const it = await schedule(ann, ch.id, { sendAt: soon(HOUR) });
  // New ciphertext needs a new copy with it (the two always match).
  for (const d of [undefined, 'nope']) {
    const r = await as(ann, 'PATCH', `/scheduled-messages/${it.id}`, { ciphertext: cipher(), epoch: 1, draft: d });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'draft');
  }
  const d2 = draft();
  const r = await as(ann, 'PATCH', `/scheduled-messages/${it.id}`, { ciphertext: cipher(), epoch: 1, draft: d2, ref: 'ignored-new-ref-1234567' });
  assert.equal(r.json.draft, d2);
  assert.equal(r.json.ref, it.ref, 'the ref stays: the app seals new copies with the same one');
  assert.equal((await list(ann)).find((x) => x.id === it.id).draft, d2);
});

test('limits: 25 waiting per person (failed ones don’t count), and scheduling counts as sending', async () => {
  const ann = await user('lann'); const ch = await room('limits');
  const u = srv.sql('SELECT public_key, sign_public_key FROM users WHERE id = ?', ann.id)[0];
  assert.ok(u);
  // 24 straight into the table (quicker than 24 requests, which the send limits would slow), then the API.
  const first = await schedule(ann, ch.id, { sendAt: soon(HOUR) });
  const keyOf = rowOf(first.id).own_key;
  const t = Date.now();
  for (let i = 0; i < 24; i++) {
    srv.sql(`INSERT INTO scheduled_messages (id, user_id, server_id, channel_id, ciphertext, epoch, own_key, send_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      `fill${i}${hex(4)}`, ann.id, server.id, ch.id, cipher(), keyOf, t + 2 * HOUR + i, t, t);
  }
  const r = await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR) });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'too_many');
  const dm = (await as(ann, 'POST', '/dms', { userId: boss.id })).json;
  assert.equal((await as(ann, 'POST', `/dms/${dm.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), sendAt: soon(HOUR) })).json.code, 'too_many', 'DMs count too');
  srv.sql("UPDATE scheduled_messages SET status = 'failed', reason = 'timed_out' WHERE id = ?", first.id);
  assert.equal((await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR) })).status, 200, 'a failed one makes room');
  const items = await list(ann);
  assert.equal(items.length, 26);
  assert.equal(items.filter((x) => x.status === 'failed').length, 1);

  // Rate limits: scheduling is limited like sending (30 messages in 10 seconds).
  const fast = await user('fast'); const fch = await room('fast');
  let limited = 0;
  for (let i = 0; i < 32; i++) {
    const x = await as(fast, 'POST', `/channels/${fch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR) });
    if (x.status === 429) limited++;
    else if (x.status !== 200 && x.json.code !== 'too_many') assert.fail(x.text);
  }
  assert.ok(limited > 0, 'a burst is limited');
});

test('refused when scheduling: no permission to post, timed out, blocked, deleted account', async () => {
  const { s, inv, ch } = await newServer('Strict');
  const ann = await user('rann', inv); const ben = await user('rben', inv);
  // Can't post here: can't schedule here either.
  const locked = (await as(boss, 'POST', `/servers/${s.id}/channels`, { name: 'readonly', type: 'text' })).json;
  assert.equal((await as(boss, 'PUT', `/channels/${locked.id}/overrides`, { overrides: [{ type: 'role', id: s.id, allow: 0, deny: P.SEND }] })).status, 200);
  assert.equal((await as(ann, 'POST', `/channels/${locked.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR) })).status, 403);
  assert.equal((await as(boss, 'PUT', `/channels/${locked.id}/overrides`, { overrides: [{ type: 'role', id: s.id, allow: 0, deny: P.ATTACH }] })).status, 200);
  const blob = await uploadBlob(ann);
  assert.equal((await as(ann, 'POST', `/channels/${locked.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR), files: [blob] })).status, 403, 'files need Attach Files');
  // Timed out: no queueing posts for later either.
  assert.equal((await as(boss, 'POST', `/servers/${s.id}/members/${ann.id}/timeout`, { minutes: 5 })).status, 200);
  const to = await as(ann, 'POST', `/channels/${ch.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), epoch: 1, sendAt: soon(HOUR) });
  assert.equal(to.status, 403);
  assert.equal(to.json.code, 'timed_out');
  // DMs: a block either way, or a deleted account.
  const dm = (await as(ben, 'POST', '/dms', { userId: ann.id })).json;
  assert.equal((await as(ann, 'POST', `/blocks/${ben.id}`)).status, 200);
  assert.equal((await as(ben, 'POST', `/dms/${dm.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), sendAt: soon(HOUR) })).status, 403);
  assert.equal((await as(ann, 'POST', `/dms/${dm.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), sendAt: soon(HOUR) })).status, 403);
  const cid = await user('rcid', inv);
  const dm2 = (await as(ben, 'POST', '/dms', { userId: cid.id })).json;
  assert.equal((await as(cid, 'DELETE', '/me', { authKey: cid.authKey, confirm: cid.username })).status, 200);
  const del = await as(ben, 'POST', `/dms/${dm2.id}/scheduled-messages`, { ...own(), ciphertext: cipher(), sendAt: soon(HOUR) });
  assert.equal(del.status, 403);
  assert.equal(del.json.code, 'deleted');
});

// ------------------------------------------------------------------ at send time
test('refused at its time: timed out, removed, channel or thread deleted, permission gone — failed, and the sender told', async () => {
  const { s, inv, ch } = await newServer('Moderated');
  const ann = await user('fann', inv); const ben = await user('fben', inv); const cat = await user('fcat', inv); const dee = await user('fdee', inv);
  const annS = await sock(ann); const benS = await sock(ben); const catS = await sock(cat); const deeS = await sock(dee);
  const seen = collect(deeS, 'message:new');
  const told = (x) => collect(x, 'scheduled:update');
  const annT = told(annS); const benT = told(benS); const catT = told(catS);
  const benRemoved = collect(benS, 'scheduled:remove');
  const thread = (await as(dee, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json;
  const other = await room('soon-gone', s.id);
  const locked = await room('soon-locked', s.id);

  const a = await schedule(ann, ch.id, { sendAt: soon(1500) }); // timed out by then
  const b1 = await schedule(ben, other.id, { sendAt: soon(1500) }); // the channel is deleted
  const b2 = await schedule(ben, ch.id, { sendAt: soon(1500), threadId: thread.id }); // the thread is deleted
  const b3 = await schedule(ben, locked.id, { sendAt: soon(1500) }); // can't post there any more
  const c = await schedule(cat, ch.id, { sendAt: soon(1500) }); // kicked
  await as(boss, 'POST', `/servers/${s.id}/members/${ann.id}/timeout`, { minutes: 5 });
  await as(boss, 'DELETE', `/channels/${other.id}`);
  await as(dee, 'DELETE', `/messages/${thread.id}`);
  await as(boss, 'PUT', `/channels/${locked.id}/overrides`, { overrides: [{ type: 'role', id: s.id, allow: 0, deny: P.SEND }] });
  await as(boss, 'DELETE', `/servers/${s.id}/members/${cat.id}`);
  freshEpoch(s.id); // someone made the new key (the kick needs one), so only the refusals above count

  const failed = (list, id) => list.find((x) => x.id === id && x.status === 'failed');
  const fa = await until(() => failed(annT, a.id), 'ann told');
  assert.equal(fa.reason, 'timed_out');
  assert.match(fa.note, /timed out/);
  assert.equal((await until(() => failed(benT, b1.id), 'b1')).reason, 'no_access');
  assert.equal((await until(() => failed(benT, b2.id), 'b2')).reason, 'thread_gone');
  assert.equal((await until(() => failed(benT, b3.id), 'b3')).reason, 'no_permission');
  assert.equal((await until(() => failed(catT, c.id), 'cat told')).reason, 'no_access');
  await sleep(300);
  assert.equal(seen.filter((m) => m.authorId !== dee.id).length, 0, 'none of them was posted');
  assert.equal(benRemoved.length, 0);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE author_id IN (?, ?, ?)', ann.id, ben.id, cat.id)[0].n, 0);
  // They stay listed as failed (with the reason) until dismissed, and can't be sent or edited.
  const mine = await list(ben);
  assert.deepEqual(mine.map((x) => x.status), ['failed', 'failed', 'failed']);
  assert.ok(mine.every((x) => x.note && x.ciphertext));
  assert.equal((await as(ben, 'POST', `/scheduled-messages/${b2.id}/send`)).json.code, 'failed');
  assert.equal((await as(ben, 'PATCH', `/scheduled-messages/${b2.id}`, { sendAt: soon(HOUR) })).json.code, 'failed');
  assert.equal((await as(ben, 'DELETE', `/scheduled-messages/${b2.id}`)).status, 200);
  assert.equal((await list(ben)).length, 2);
});

test('send now is refused like a message sent now, and leaves the scheduled one as it was', async () => {
  const { s, inv, ch } = await newServer('Now');
  const ann = await user('nann', inv);
  const item = await schedule(ann, ch.id, { sendAt: soon(HOUR) });
  await as(boss, 'POST', `/servers/${s.id}/members/${ann.id}/timeout`, { minutes: 5 });
  const r = await as(ann, 'POST', `/scheduled-messages/${item.id}/send`);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'timed_out');
  assert.equal(rowOf(item.id).status, 'pending');
  // Slow mode: "send now" waits like any message; at its time, it's only put back.
  await as(boss, 'DELETE', `/servers/${s.id}/members/${ann.id}/timeout`);
  assert.equal((await as(boss, 'PATCH', `/channels/${ch.id}`, { slowmode: 30 })).status, 200);
  assert.equal((await as(ann, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1 })).status, 200);
  const slow = await as(ann, 'POST', `/scheduled-messages/${item.id}/send`);
  assert.equal(slow.status, 429);
  assert.equal(slow.json.code, 'slowmode');
  const annS = await sock(ann);
  const ups = collect(annS, 'scheduled:update');
  const at = soon(800);
  await as(ann, 'PATCH', `/scheduled-messages/${item.id}`, { sendAt: at });
  const moved = await until(() => ups.find((x) => x.id === item.id && x.sendAt > at + 20000), 'put back by slow mode');
  assert.equal(moved.status, 'pending');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE channel_id = ? AND author_id = ?', ch.id, ann.id)[0].n, 1, 'not posted inside the slow mode wait');
});

test('blocked or deleted by its time (DM): failed, and the sender told', async () => {
  const ann = await user('bann'); const ben = await user('bben'); const cat = await user('bcat');
  const annS = await sock(ann);
  const t = collect(annS, 'scheduled:update');
  const d1 = (await as(ann, 'POST', '/dms', { userId: ben.id })).json;
  const d2 = (await as(ann, 'POST', '/dms', { userId: cat.id })).json;
  const a = await scheduleDm(ann, d1.id, { sendAt: soon(1200) });
  const b = await scheduleDm(ann, d2.id, { sendAt: soon(1200) });
  await as(ben, 'POST', `/blocks/${ann.id}`);
  assert.equal((await as(cat, 'DELETE', '/me', { authKey: cat.authKey, confirm: cat.username })).status, 200);
  assert.equal((await until(() => t.find((x) => x.id === a.id && x.status === 'failed'), 'blocked')).reason, 'blocked');
  assert.equal((await until(() => t.find((x) => x.id === b.id && x.status === 'failed'), 'deleted')).reason, 'deleted');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM dm_messages WHERE author_id = ?', ann.id)[0].n, 0);
});

// ------------------------------------------------------------------ keys
test('key rotation: held for re-encrypting (at once when the key changes, or at its time), never posted with an old key', async () => {
  const { s, inv, ch } = await newServer('Rotating');
  const ann = await user('kann', inv); const ben = await user('kben', inv); const leaver = await user('kleave', inv);
  const annS = await sock(ann); const benS = await sock(ben);
  const ups = collect(annS, 'scheduled:update');
  const benNew = collect(benS, 'message:new');
  const early = await schedule(ann, ch.id, { sendAt: soon(HOUR) });
  // Someone leaves: the key must be replaced, so what's waiting is held now (the sender's app re-encrypts it).
  assert.equal((await as(leaver, 'POST', `/servers/${s.id}/leave`)).status, 200);
  const held = await until(() => ups.find((x) => x.id === early.id && x.status === 'held'), 'held when the key needs replacing');
  assert.equal(held.reason, 'key');
  assert.match(held.note, /re-encrypts/);
  // Held ones can't be rescheduled or sent as they are…
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${early.id}`, { sendAt: soon(HOUR) })).json.code, 'held');
  assert.equal((await as(ann, 'POST', `/scheduled-messages/${early.id}/send`)).json.code, 'held');
  // …the app re-encrypts it with the new key, and it's pending again.
  freshEpoch(s.id, 2);
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${early.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1 })).json.code, 'stale-key');
  const fresh = cipher();
  const r = await as(ann, 'PATCH', `/scheduled-messages/${early.id}`, { draft: draft(), ciphertext: fresh, epoch: 2, sendAt: soon(800) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'pending');
  assert.equal(r.json.epoch, 2);
  const m = await until(() => benNew.find((x) => x.ciphertext === fresh), 'the re-encrypted message');
  assert.equal(m.epoch, 2);

  // The key changes without the server hearing about it here (as after a restore): caught at its time.
  const late = await schedule(ann, ch.id, { sendAt: soon(1000), epoch: 2 });
  srv.sql('UPDATE servers SET key_epoch = 3 WHERE id = ?', s.id);
  const h = await until(() => ups.find((x) => x.id === late.id && x.status === 'held'), 'held at its time');
  assert.equal(h.reason, 'key');
  await sleep(300);
  assert.ok(!benNew.some((x) => x.ciphertext === late.ciphertext), 'never posted with the old key');
  assert.ok(rowOf(late.id).told_at > 0, 'the sender was told it’s waiting');
  // Re-encrypted after its time has passed: only when the request says it may go at once (or gives a new time).
  // An edit or a re-encrypt alone is refused, so a message hours or days late never goes without being asked for.
  const ct3 = cipher();
  const overdue = await as(ann, 'PATCH', `/scheduled-messages/${late.id}`, { draft: draft(), ciphertext: ct3, epoch: 3 });
  assert.equal(overdue.status, 409);
  assert.equal(overdue.json.code, 'overdue');
  assert.equal(rowOf(late.id).status, 'held', 'left as it was');
  await sleep(300);
  assert.ok(!benNew.some((x) => x.ciphertext === ct3), 'not sent');
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${late.id}`, { draft: draft(), ciphertext: ct3, epoch: 3, sendNow: 'yes' })).json.code, 'overdue', 'only true');
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${late.id}`, { draft: draft(), ciphertext: ct3, epoch: 3, sendNow: true })).status, 200);
  await until(() => benNew.find((x) => x.ciphertext === ct3), 'sent once re-encrypted');
  // A held one whose sender lost access by its time fails then.
  const third = await schedule(ann, ch.id, { sendAt: soon(1200), epoch: 3 });
  srv.sql('UPDATE servers SET key_epoch = 4 WHERE id = ?', s.id);
  await as(ann, 'GET', '/scheduled-messages'); // the listing notices the old key: held
  assert.equal(rowOf(third.id).status, 'held');
  await as(boss, 'DELETE', `/servers/${s.id}/members/${ann.id}`);
  assert.equal((await until(() => ups.find((x) => x.id === third.id && x.status === 'failed'), 'failed: removed')).reason, 'no_access');
});

test('DM keys: the other person’s new key holds it; your own new keys fail it', async () => {
  const ann = await user('xann'); const ben = await user('xben');
  const dm = (await as(ann, 'POST', '/dms', { userId: ben.id })).json;
  const benS = await sock(ben);
  const benDm = collect(benS, 'dm:message');
  const a = await scheduleDm(ann, dm.id, { sendAt: soon(HOUR) });
  // Ben's key changes (a password reset without his recovery key): ann's app must re-encrypt to the new key.
  const oldBen = srv.sql('SELECT public_key FROM users WHERE id = ?', ben.id)[0].public_key;
  srv.sql('UPDATE users SET public_key = ? WHERE id = ?', crypto.randomBytes(91).toString('base64'), ben.id);
  let item = (await list(ann)).find((x) => x.id === a.id);
  assert.equal(item.status, 'held');
  assert.equal(item.reason, 'peer_key');
  const ct = cipher();
  const r = await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, { draft: draft(), ciphertext: ct, sendAt: soon(700) });
  assert.equal(r.json.status, 'pending');
  await until(() => benDm.find((x) => x.message.ciphertext === ct), 'the re-encrypted DM');
  srv.sql('UPDATE users SET public_key = ? WHERE id = ?', oldBen, ben.id);

  // Ann's own keys change: what she scheduled can't be opened or re-signed any more. Failed, not held.
  const ch = await room('ownkeys');
  const b = await schedule(ann, ch.id, { sendAt: soon(HOUR) });
  const c = await scheduleDm(ann, dm.id, { sendAt: soon(HOUR) });
  srv.sql('UPDATE users SET sign_public_key = ? WHERE id = ?', crypto.randomBytes(91).toString('base64'), ann.id);
  item = (await list(ann)).find((x) => x.id === b.id);
  assert.equal(item.status, 'failed');
  assert.equal(item.reason, 'keys_changed');
  assert.equal((await list(ann)).find((x) => x.id === c.id).status, 'pending', 'a DM doesn’t depend on the signing key');
  srv.sql('UPDATE users SET public_key = ? WHERE id = ?', crypto.randomBytes(91).toString('base64'), ann.id);
  assert.equal((await list(ann)).find((x) => x.id === c.id).reason, 'keys_changed');
});

test('long overdue (the server was down a day or more): not posted that late, unless re-encrypted since', async () => {
  const ann = await user('oann'); const ch = await room('overdue');
  const annS = await sock(ann);
  const ups = collect(annS, 'scheduled:update');
  const probe = await schedule(ann, ch.id, { sendAt: soon(HOUR) });
  const keyOf = rowOf(probe.id).own_key;
  const t = Date.now();
  const add = (id, sendAt, writtenAt) => srv.sql(`INSERT INTO scheduled_messages (id, user_id, server_id, channel_id, ciphertext, epoch, own_key, send_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`, id, ann.id, server.id, ch.id, cipher(), keyOf, sendAt, writtenAt, writtenAt);
  const stale = `late${hex(4)}`; const fresh = `fresh${hex(4)}`; const recent = `recent${hex(4)}`;
  add(stale, t - 2 * 24 * HOUR, t - 3 * 24 * HOUR); // due two days ago, written before that
  add(fresh, t - 2 * 24 * HOUR, t - 1000); // due two days ago, re-encrypted just now
  add(recent, t - 3 * HOUR, t - 4 * HOUR); // a few hours late: still goes
  await as(ann, 'PATCH', `/scheduled-messages/${probe.id}`, { sendAt: soon(2 * HOUR) }); // wakes the timer
  const failed = await until(() => ups.find((x) => x.id === stale && x.status === 'failed'), 'the stale one failed');
  assert.equal(failed.reason, 'too_late');
  assert.match(failed.note, /more than a day ago/);
  await until(() => !rowOf(fresh) && !rowOf(recent), 'the other two sent');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE channel_id = ? AND author_id = ?', ch.id, ann.id)[0].n, 2);
});

test('the app shows what people wrote only as text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'scheduled.js'), 'utf8');
  assert.equal(/\bhtml\s*:|innerHTML|outerHTML|insertAdjacentHTML/.test(src), false, 'no HTML from scheduled messages or the server’s notes');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /scheduled-messages`, \{ \.\.\.sealed/, 'scheduling sends what sending would (sealFor)');
  // Re-encrypting works only from the sender's own copy (openDraft, sealed with their vault key), never by opening
  // the ciphertext the server hands back: a forged message, or one of their old ones, must never be re-signed.
  // (The browser flow checks this for real: test/e2e/flows.mjs, "send later".)
  assert.equal(/decrypt/i.test(src), false, 'scheduled.js never decrypts the ciphertext it is given');
  assert.match(src, /deps\.openDraft\(it\)/);
  assert.match(app, /E2EE\.openVault\(await myVaultKey\(\), 'scheduled', draftId\(ref, key, threadId\)/, 'the copy is bound to its ref, conversation and thread');
});

// ------------------------------------------------------------------ sessions
test('a session that ends: what it scheduled waits for its owner to confirm it from a session still signed in', async () => {
  const ann = await user('sann'); const ben = await user('sben'); const ch = await room('sessions');
  freshEpoch();
  const dm = (await as(ann, 'POST', '/dms', { userId: ben.id })).json;
  const benS = await sock(ben); const annS = await sock(ann);
  const benNew = collect(benS, 'message:new'); const benDm = collect(benS, 'dm:message');
  const ups = collect(annS, 'scheduled:update');
  // A second session for ann (her laptop, or someone who stole its token).
  const login = await srv.login(ann);
  assert.equal(login.status, 200, login.text);
  const other = { ...ann, token: login.json.token };
  const a = await schedule(other, ch.id, { sendAt: soon(1500) });
  const b = await scheduleDm(other, dm.id, { sendAt: soon(1500) });
  const c = await schedule(other, ch.id, { sendAt: soon(HOUR) });
  const mine = await schedule(ann, ch.id, { sendAt: soon(HOUR) }); // from the session that stays
  // Ann signs out every other session: what it queued doesn't go out.
  const rv = await as(ann, 'POST', '/me/sessions/revoke-others');
  assert.equal(rv.status, 200, rv.text);
  assert.equal((await as(other, 'GET', '/scheduled-messages')).status, 401, 'the other session is gone');
  for (const x of [a, b, c]) {
    const row = rowOf(x.id);
    assert.equal(row.status, 'held', 'held, not posted');
    assert.equal(row.reason, 'session_ended');
  }
  assert.equal(rowOf(mine.id).status, 'pending', 'what this session scheduled is untouched');
  assert.ok(ups.some((x) => x.id === a.id && x.status === 'held' && /signed out/.test(x.note)), 'her open apps hear about it at once');
  // At their time: still not sent, and she's told they're waiting.
  await until(() => rowOf(a.id).told_at && rowOf(b.id).told_at, 'told at their time');
  await sleep(300);
  assert.ok(!benNew.some((m) => m.ciphertext === a.ciphertext) && !benDm.some((x) => x.message.ciphertext === b.ciphertext), 'nothing posted');
  // Can't be sent or rescheduled as it is: only new ciphertext (from her app, from her own copy) confirms it.
  const send = await as(ann, 'POST', `/scheduled-messages/${c.id}/send`);
  assert.equal(send.status, 409);
  assert.equal(send.json.code, 'held');
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${c.id}`, { sendAt: soon(2 * HOUR) })).json.code, 'held');
  // A key change meanwhile doesn't turn it into one her app re-encrypts by itself.
  srv.sql('UPDATE servers SET key_epoch = 2 WHERE id = ?', server.id);
  await as(ann, 'GET', '/scheduled-messages');
  assert.equal(rowOf(c.id).reason, 'session_ended');
  freshEpoch();
  // Confirmed (Keep): pending again, now tied to this session, and it goes out.
  const ct = cipher();
  const keep = await as(ann, 'PATCH', `/scheduled-messages/${c.id}`, { draft: draft(), ciphertext: ct, epoch: 1 });
  assert.equal(keep.status, 200, keep.text);
  assert.equal(keep.json.status, 'pending');
  assert.equal((await as(ann, 'POST', `/scheduled-messages/${c.id}/send`)).status, 200);
  await until(() => benNew.find((m) => m.ciphertext === ct), 'sent once confirmed');
  // Overdue ones need saying so, as for any held one.
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1 })).json.code, 'overdue');
  assert.equal((await as(ann, 'DELETE', `/scheduled-messages/${a.id}`)).status, 200);

  // Logging out counts too, and so does a password change (which signs out the other sessions).
  const l2 = await srv.login(ann);
  const laptop = { ...ann, token: l2.json.token };
  const d = await schedule(laptop, ch.id, { sendAt: soon(HOUR) });
  assert.equal((await as(laptop, 'POST', '/auth/logout')).status, 200);
  assert.equal(rowOf(d.id).reason, 'session_ended');
  // Signing out one session from Settings → Sessions.
  const l3 = await srv.login(ann);
  const tablet = { ...ann, token: l3.json.token };
  const e = await schedule(tablet, ch.id, { sendAt: soon(HOUR) });
  assert.equal((await as(ann, 'DELETE', `/me/sessions/${rowOf(e.id).session_id}`)).status, 200);
  assert.equal(rowOf(e.id).reason, 'session_ended');
  assert.notEqual(rowOf(mine.id).reason, 'session_ended', 'still not held for that (only for the key change above)');
});

test('a new sign-in token for the same session (auth-11) isn’t a sign-out, but what it had waiting is held until the app re-encrypts it from its own copy: a copy of the old token gets nothing out', async () => {
  const ann = await user('stok'); const ben = await user('stokb'); const ch = await room('tokens');
  freshEpoch();
  const benS = await sock(ben); const annS = await sock(ann);
  const benNew = collect(benS, 'message:new');
  const ups = collect(annS, 'scheduled:update');
  const a = await schedule(ann, ch.id, { sendAt: soon(HOUR) });
  const b = await schedule(ann, ch.id, { sendAt: soon(HOUR) });
  // Someone with a copy of ann's token (no identity key, so its own copy of the message is one her app can't open).
  const copy = { ...ann, ip: '203.0.113.77' };
  const c = await schedule(copy, ch.id, { sendAt: soon(4000) });
  const sid = rowOf(a.id).session_id;
  assert.equal(rowOf(c.id).session_id, sid, 'the same session: the server can\u2019t tell them apart');
  // "Log out all other devices" with the password, then a password change: each gives this session a new token.
  const rv = await as(ann, 'POST', '/me/sessions/revoke-others', { authKey: ann.authKey });
  assert.equal(rv.status, 200, rv.text);
  assert.ok(rv.json.token && rv.json.token !== ann.token, 'a new token');
  const old = ann.token;
  ann.token = rv.json.token;
  for (const x of [a, b, c]) {
    const row = rowOf(x.id);
    assert.deepEqual([row.status, row.reason], ['held', 'token_renewed'], 'held: a copy of the old token could have written it');
    assert.equal(row.session_id, sid, 'still this session\u2019s');
  }
  await until(() => ups.some((x) => x.id === a.id && x.status === 'held' && x.reason === 'token_renewed' && /new token/.test(x.note)), 'her apps hear about it');
  assert.equal((await as(copy, 'PATCH', `/scheduled-messages/${c.id}`, { draft: draft(), ciphertext: cipher(), epoch: 1, sendNow: true })).status, 401, 'the copy can\u2019t confirm its own any more');
  // Her app re-encrypts the ones it wrote (from its own copies), from the new token: pending again, still this session's.
  const ct = cipher();
  const fixed = await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, { draft: draft(), ciphertext: ct, epoch: 1 });
  assert.equal(fixed.status, 200, fixed.text);
  assert.deepEqual([fixed.json.status, rowOf(a.id).session_id], ['pending', sid]);
  // A password change on top: held again, the same way.
  const newAuthKey = hex(32);
  const pw = await as(ann, 'POST', '/me/password', { oldAuthKey: ann.authKey, newAuthKey, encPrivateKey: 'x'.repeat(80), salt: crypto.randomBytes(16).toString('base64') });
  assert.equal(pw.status, 200, pw.text);
  ann.authKey = newAuthKey;
  ann.token = pw.json.token;
  assert.equal((await srv.api('GET', '/scheduled-messages', { token: old, ip: ann.ip })).status, 401, 'the old token is out');
  assert.equal(rowOf(a.id).reason, 'token_renewed');
  assert.equal((await list(ann)).filter((x) => [a.id, b.id, c.id].includes(x.id)).length, 3, 'listed for the new token');
  // Not sent as it is, at its time or on request.
  assert.equal((await as(ann, 'POST', `/scheduled-messages/${a.id}/send`)).json.code, 'held');
  await until(() => rowOf(c.id).told_at, 'the copy\u2019s came due: she\u2019s told it waits', 10000);
  await sleep(300);
  assert.ok(!benNew.some((m) => m.ciphertext === c.ciphertext), 'the copy\u2019s never went out');
  assert.deepEqual([rowOf(c.id).status, rowOf(c.id).reason], ['held', 'token_renewed']);
  // Re-encrypted from the new token, it goes.
  const ct2 = cipher();
  assert.equal((await as(ann, 'PATCH', `/scheduled-messages/${a.id}`, { draft: draft(), ciphertext: ct2, epoch: 1 })).status, 200);
  assert.equal((await as(ann, 'POST', `/scheduled-messages/${a.id}/send`)).status, 200, 'sent now from the new token');
  await until(() => benNew.find((m) => m.ciphertext === ct2), 'posted');
  for (const x of [b, c]) assert.equal((await as(ann, 'DELETE', `/scheduled-messages/${x.id}`)).status, 200);
});

// ------------------------------------------------------------------ files, accounts, restarts
async function uploadBlob(u) {
  const boundary = '----hearth' + crypto.randomBytes(8).toString('hex');
  const raw = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    crypto.randomBytes(2000), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await srv.api('POST', '/upload/encrypted', { token: u.token, ip: u.ip, raw, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(r.status, 200, r.text);
  return r.json.url;
}
const fileOf = (url) => path.join(srv.dir, 'uploads', path.basename(url));

test('attachments: kept with the scheduled message, handed to the message at its time, deleted on cancel', async () => {
  const ann = await user('fiann'); const ben = await user('fiben'); const ch = await room('files');
  const f1 = await uploadBlob(ann); const f2 = await uploadBlob(ann); const notMine = await uploadBlob(ben);
  const a = await schedule(ann, ch.id, { sendAt: soon(1200), files: [f1, notMine] });
  assert.equal(a.files, 1, 'only your own files');
  assert.equal(srv.sql('SELECT message_id FROM blobs WHERE name = ?', path.basename(f1))[0].message_id, a.id);
  assert.equal(srv.sql('SELECT message_id FROM blobs WHERE name = ?', path.basename(notMine))[0].message_id, null);
  // Used once: a second scheduled message (or message) can't take the same file.
  const b = await schedule(ann, ch.id, { sendAt: soon(HOUR), files: [f1, f2] });
  assert.deepEqual(JSON.parse(rowOf(b.id).files), [f2]);
  const benS = await sock(ben);
  const benNew = collect(benS, 'message:new');
  const m = await until(() => benNew.find((x) => x.ciphertext === a.ciphertext), 'the message with its file');
  assert.equal(srv.sql('SELECT message_id FROM blobs WHERE name = ?', path.basename(f1))[0].message_id, m.id);
  assert.ok(fs.existsSync(fileOf(f1)));
  // The admin's "Clean up orphans now" leaves a waiting message's file alone, however old the upload.
  srv.sql('UPDATE blobs SET created_at = ? WHERE name IN (?, ?)', Date.now() - 3 * 24 * HOUR, path.basename(f1), path.basename(f2));
  const clean = await as(boss, 'POST', '/admin/storage/cleanup', { authKey: boss.authKey });
  assert.equal(clean.status, 200, clean.text);
  assert.ok(fs.existsSync(fileOf(f2)) && fs.existsSync(fileOf(f1)));
  assert.equal(srv.sql('SELECT message_id FROM blobs WHERE name = ?', path.basename(f2))[0].message_id, b.id);
  // Cancelled: its file goes with it.
  assert.ok(fs.existsSync(fileOf(f2)));
  await as(ann, 'DELETE', `/scheduled-messages/${b.id}`);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM blobs WHERE name = ?', path.basename(f2))[0].n, 0);
  await until(() => !fs.existsSync(fileOf(f2)), 'its file deleted (removed from disk in the background)');
});

test('Settings → Storage and the admin report say a file waits with a scheduled message', async () => {
  const ann = await user('stann'); const ch = await room('storage');
  const f = await uploadBlob(ann);
  const it = await schedule(ann, ch.id, { sendAt: Date.now() + 20 * 24 * HOUR, files: [f] });
  const mine = (await as(ann, 'GET', '/me/storage/files')).json.files.find((x) => x.url === f);
  assert.deepEqual(mine.where, { type: 'scheduled', sendAt: it.sendAt, serverId: server.id, channelId: ch.id, dmId: null });
  const rep = await as(boss, 'GET', '/admin/storage/report');
  assert.equal(rep.status, 200, rep.text);
  assert.ok(rep.json.scheduled.files >= 1 && rep.json.scheduled.bytes > 0);
  // Nobody else's files say anything about it.
  const ben = await user('stben');
  assert.ok(!(await as(ben, 'GET', '/me/storage/files')).json.files.some((x) => x.url === f));
});

test('a deleted account’s scheduled messages never go out', async () => {
  const ann = await user('gann'); const ch = await room('ghost');
  const benS = await sock(boss);
  const seen = collect(benS, 'message:new');
  const f = await uploadBlob(ann);
  // Due a few seconds later: deleting an account takes a moment (on a busy machine, more than a second).
  const a = await schedule(ann, ch.id, { sendAt: soon(4000), files: [f] });
  assert.equal((await as(ann, 'DELETE', '/me', { authKey: ann.authKey, confirm: ann.username })).status, 200);
  assert.ok(Date.now() < a.sendAt, 'deleted before its time');
  assert.equal(rowOf(a.id), undefined);
  await until(() => !fs.existsSync(fileOf(f)), 'its file deleted (removed from disk in the background)');
  await sleep(a.sendAt - Date.now() + 1500);
  assert.ok(!seen.some((m) => m.ciphertext === a.ciphertext));
});

test('due while the server was down: sent when it starts again; the start-up sweep keeps waiting files', async () => {
  const ann = await user('rsann'); const ch = await room('restart');
  const f = await uploadBlob(ann);
  const a = await schedule(ann, ch.id, { sendAt: soon(1500) });
  const b = await schedule(ann, ch.id, { sendAt: soon(HOUR), files: [f] });
  // Stop it right away (before its time), start it after, with the orphan sweep soon after start.
  await srv.restart({ ORPHAN_SWEEP_DELAY_MS: '200' });
  await until(() => !rowOf(a.id), 'sent after the restart', 15000);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE ciphertext = ?', a.ciphertext)[0].n, 1, 'once');
  await sleep(800);
  assert.equal(srv.sql('SELECT message_id FROM blobs WHERE name = ?', path.basename(f))[0].message_id, b.id);
  assert.ok(fs.existsSync(fileOf(f)), 'a file waiting to be sent isn’t an orphan');
});
