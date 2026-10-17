// "New members can't read messages from before they joined" (server/joinhistory.js, ENGINEERING-REPORT crypto-13):
// the setting (who may change it, the audit log, the limit), which keys a newcomer is handed (keys/share, keyState,
// keys/self, a rejoin), the key change a join asks for (at once, shared by joins close together, slowed down by a
// flood), and every way history is served (messages, threads, pins, search, saved messages, unread counts, exports,
// reply quotes, jumps, reactions, polls, reports, live events), with the setting on and off. Voice channels' chats
// too. Most keys here are well-formed stand-ins (the server can't tell); one test runs the app's real key code.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./helpers');
const { PERMS } = require('../server/perms');

const GAP = 1500; // HEARTH_TEST_JOIN_KEY_GAP_MS: a join waits this long per key made in the last hour
let srv;
const as = (u, m, p, body) => srv.api(m, p, { token: u.token, ip: u.ip, body });
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const fakeWrap = () => ['w1', b64(65), b64(12), b64(48), b64(64)].join(':');
const cipher = () => 'v2:' + b64(30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 50) { if (await fn()) return true; await sleep(50); } return false; };
const keyRow = (sid) => ({ ...srv.sql('SELECT key_epoch, needs_rotation, join_rotate_at, hide_history FROM servers WHERE id = ?', sid)[0] });
const memberRow = (sid, uid) => srv.sql('SELECT joined_at, key_from FROM members WHERE server_id = ? AND user_id = ?', sid, uid)[0];
const memberIds = (sid) => srv.sql('SELECT user_id FROM members WHERE server_id = ?', sid).map((r) => r.user_id);
const sockets = [];
const connect = async (u) => { const s = await srv.socket(u.token); sockets.push(s); return s; };
const collect = (sock, ev) => { const got = []; sock.on(ev, (p) => got.push(p)); return got; };

before(async () => { srv = await H.startServer({ HEARTH_TEST_JOIN_KEY_GAP_MS: String(GAP) }); });
after(async () => { sockets.forEach((s) => s.close()); globalThis.fetch = realFetch; await srv.stop(); });

// One member's app replacing the key: a well-formed (not real) key wrapped for everyone in the server now.
async function rotate(by, sid) {
  const epoch = keyRow(sid).key_epoch + 1;
  const wraps = Object.fromEntries(memberIds(sid).map((id) => [id, fakeWrap()]));
  const r = await as(by, 'POST', `/servers/${sid}/keys/rotate`, { epoch, check: b64(24), wraps });
  assert.equal(r.status, 200, r.text);
  return epoch;
}
// Keys made a while ago, so the next join doesn't wait for the limit (the waits have their own test).
const ageKeys = (sid) => srv.sql('UPDATE server_epochs SET created_at = created_at - ? WHERE server_id = ?', 3 * 3600000, sid);
async function send(u, ch, extra = {}) {
  const sid = srv.sql('SELECT server_id FROM channels WHERE id = ?', ch)[0].server_id;
  const r = await as(u, 'POST', `/channels/${ch}/messages`, { ciphertext: cipher(), epoch: keyRow(sid).key_epoch, ...extra });
  assert.equal(r.status, 200, r.text);
  await sleep(3); // its own millisecond, so "before" and "after" a join are never the same instant
  return r.json.id;
}
async function joinWith(u, code) {
  const r = await as(u, 'POST', `/invites/${code}/join`, {});
  assert.equal(r.status, 200, r.text);
  await sleep(3);
  return r.json;
}
// A server with a key (epoch 1), its owner and the given members, and its text and voice channels.
async function space(owner, others = [], name = 'hall') {
  const s = (await as(owner, 'POST', '/servers', { name })).json;
  const code = (await as(owner, 'POST', `/servers/${s.id}/invites`, {})).json.code;
  for (const u of others) await joinWith(u, code);
  await rotate(owner, s.id);
  ageKeys(s.id);
  return { s, sid: s.id, code, ch: s.channels.find((c) => c.type === 'text').id, voice: s.channels.find((c) => c.type === 'voice').id };
}
const setHide = (u, sid, on) => as(u, 'PATCH', `/servers/${sid}`, { hideHistory: on });
const page = async (u, ch, q = '') => (await as(u, 'GET', `/channels/${ch}/messages${q}`)).json;
const ids = (list) => list.map((m) => m.id);

// ------------------------------------------------------------------ the setting
test('the setting: off by default, Manage Server only, not in group chats, true or false, written to the audit log', async () => {
  const A = await srv.register(); const B = await srv.register(); const C = await srv.register();
  const { s, sid } = await space(A, [B]);
  assert.equal(s.hideHistory, false, 'off for a new server');
  assert.equal(keyRow(sid).hide_history, 0);
  assert.equal((await setHide(B, sid, true)).status, 403, 'a member without Manage Server');
  assert.equal((await setHide(C, sid, true)).status, 404, 'an outsider');
  assert.equal((await setHide(A, sid, 'yes')).status, 400);
  const g = (await as(A, 'POST', '/groups', { userIds: [B.id] })).json;
  assert.equal((await setHide(A, g.id, true)).status, 400, 'group chats don’t have it');
  // A role with Manage Server may turn it on.
  const role = (await as(A, 'POST', `/servers/${sid}/roles`, { name: 'admins', permissions: PERMS.MANAGE_SERVER })).json;
  assert.equal((await as(A, 'PUT', `/servers/${sid}/members/${B.id}/roles`, { roleIds: [role.id] })).status, 200);
  const r = await setHide(B, sid, true);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.hideHistory, true);
  assert.equal((await setHide(A, sid, false)).status, 200);
  const audit = (await as(A, 'GET', `/servers/${sid}/audit?action=server_update`)).json.entries;
  const mine = audit.filter((e) => (e.detail.changes || []).includes('hideHistory'));
  assert.deepEqual(mine.map((e) => [e.actorId, e.detail.hideHistory]), [[A.id, false], [B.id, true]], 'who turned it which way, newest first');
  // Setting it to what it already is changes nothing and writes nothing.
  assert.equal((await setHide(A, sid, false)).status, 200);
  assert.equal((await as(A, 'GET', `/servers/${sid}/audit?action=server_update`)).json.entries.filter((e) => (e.detail.changes || []).includes('hideHistory')).length, 2);
});

test('turning it on replaces the key once (and tells the apps); turning it off doesn’t; at most 10 changes an hour each', async () => {
  const A = await srv.register(); const B = await srv.register();
  const { sid } = await space(A, [B]);
  const sock = await connect(B);
  const states = collect(sock, 'keys:state');
  assert.equal(keyRow(sid).needs_rotation, 0);
  assert.equal((await setHide(A, sid, true)).status, 200);
  assert.equal(keyRow(sid).needs_rotation, 1, 'the current backlog’s key is never handed out again');
  assert.ok(await until(() => states.some((st) => st.serverId === sid && st.needsRotation)), 'apps hear about it at once');
  await rotate(A, sid);
  assert.equal((await setHide(A, sid, false)).status, 200);
  assert.equal(keyRow(sid).needs_rotation, 0, 'off: nothing to replace');
  for (let i = 0; i < 8; i++) assert.equal((await setHide(A, sid, i % 2 === 0)).status, 200);
  const r = await setHide(A, sid, true);
  assert.equal(r.status, 429, 'the 11th change in an hour');
  // Other settings in the same request aren't held up by it when it isn't changing.
  assert.equal((await as(A, 'PATCH', `/servers/${sid}`, { description: 'still works', hideHistory: false })).status, 200);
});

// ------------------------------------------------------------------ keys
test('on: a newcomer gets only the key made after they joined; the current one is never shared to them', async () => {
  const A = await srv.register(); const B = await srv.register(); const N = await srv.register();
  const { sid, code } = await space(A, [B]);
  assert.equal((await setHide(A, sid, true)).status, 200);
  const e2 = await rotate(A, sid); // the switch on turning it on
  ageKeys(sid);
  const joined = await joinWith(N, code);
  assert.deepEqual(memberRow(sid, N.id).key_from, e2 + 1, 'their keys start at the next epoch');
  assert.equal(keyRow(sid).needs_rotation, 1, 'a quiet server switches keys at once');
  assert.deepEqual(joined.keyState.since, { at: memberRow(sid, N.id).joined_at, epoch: e2 + 1 });
  assert.deepEqual(joined.keyState.keys, []);
  // Nobody can hand them the key in use when they joined, even an app that hasn't noticed (or a modified one).
  assert.ok(!joined.keyState.missing.includes(N.id), 'not listed as missing the current key');
  srv.sql('UPDATE servers SET needs_rotation = 0 WHERE id = ?', sid); // as if that app hadn't seen the flag yet
  const share = await as(B, 'POST', `/servers/${sid}/keys/share`, { epoch: e2, wraps: { [N.id]: fakeWrap() } });
  assert.equal(share.status, 200, share.text);
  assert.equal(share.json.shared, 0);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM server_keys WHERE server_id = ? AND user_id = ?', sid, N.id)[0].n, 0);
  srv.sql('UPDATE servers SET needs_rotation = 1 WHERE id = ?', sid);
  const e3 = await rotate(A, sid);
  const st = (await as(N, 'GET', `/servers/${sid}/keys`)).json;
  assert.deepEqual(st.keys.map((k) => k.epoch), [e3]);
  assert.equal(st.since.epoch, e3);
  assert.equal(keyRow(sid).join_rotate_at, null);
  // Members who were in before keep every key.
  assert.deepEqual((await as(B, 'GET', `/servers/${sid}/keys`)).json.keys.map((k) => k.epoch), [1, e2, e3]);
  assert.equal((await as(B, 'GET', `/servers/${sid}/keys`)).json.since, undefined);
});

test('off: a newcomer gets the current key shared and reads back, as before', async () => {
  const A = await srv.register(); const B = await srv.register(); const N = await srv.register();
  const { sid, code, ch } = await space(A, [B]);
  const old = await send(A, ch);
  const joined = await joinWith(N, code);
  assert.equal(memberRow(sid, N.id).key_from, null);
  assert.equal(keyRow(sid).needs_rotation, 0, 'no new key for a join');
  assert.ok(joined.keyState.missing.includes(N.id));
  assert.equal(joined.keyState.since, undefined);
  const share = await as(B, 'POST', `/servers/${sid}/keys/share`, { epoch: 1, wraps: { [N.id]: fakeWrap() } });
  assert.equal(share.json.shared, 1);
  const p = await page(N, ch);
  assert.ok(ids(p.messages).includes(old));
  assert.equal(p.hidden, undefined);
});

test('rejoining with it on: a new key, none of your old rows handed back or rewritable, your own old messages hidden too', async () => {
  const A = await srv.register(); const M = await srv.register();
  const { sid, code, ch } = await space(A, [M]);
  const mine = await send(M, ch);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid); // epoch 2, M has it
  assert.equal((await as(M, 'POST', `/servers/${sid}/leave`)).status, 200);
  await rotate(A, sid); // epoch 3, after M left
  ageKeys(sid);
  await joinWith(M, code);
  assert.equal(keyRow(sid).needs_rotation, 1);
  assert.equal(memberRow(sid, M.id).key_from, 4);
  // Their rows for epochs 1 and 2 are still in the database, but never handed back.
  assert.equal(srv.sql('SELECT COUNT(*) n FROM server_keys WHERE server_id = ? AND user_id = ? AND epoch < 3', sid, M.id)[0].n, 2);
  assert.deepEqual((await as(M, 'GET', `/servers/${sid}/keys`)).json.keys, []);
  assert.deepEqual((await as(M, 'GET', '/bootstrap')).json.keyStates[sid].keys, []);
  const self = await as(M, 'POST', `/servers/${sid}/keys/self`, { wraps: { 1: fakeWrap(), 2: fakeWrap() } });
  assert.equal(self.json.updated, 0, 'old rows aren’t theirs to touch any more');
  await rotate(A, sid);
  assert.deepEqual((await as(M, 'GET', `/servers/${sid}/keys`)).json.keys.map((k) => k.epoch), [4]);
  assert.equal((await as(M, 'POST', `/servers/${sid}/keys/self`, { wraps: { 4: fakeWrap() } })).json.updated, 1);
  const p = await page(M, ch);
  assert.ok(!ids(p.messages).includes(mine), 'their own message from the first time round is from before');
  assert.equal(p.hidden, true);
  assert.equal((await as(M, 'PATCH', `/messages/${mine}`, { ciphertext: cipher(), epoch: 4 })).status, 404, 'nor can they edit it unseen');
});

test('a join flood: joins close together share one new key, and a flood only slows the keys down', async () => {
  const A = await srv.register(); const B = await srv.register();
  const { sid, code, ch } = await space(A, [B]);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid);
  ageKeys(sid);
  const people = [];
  for (let i = 0; i < 6; i++) people.push(await srv.register());
  // Read state starts the first time it's asked for (everything before counts as read): ask now, so counts below
  // come from what was left out, not from that.
  for (const p of people) await as(p, 'GET', '/me/unread');
  await joinWith(people[0], code);
  assert.equal(keyRow(sid).needs_rotation, 1, 'the first join after a quiet spell: at once');
  const e = await rotate(A, sid);
  const made = srv.sql('SELECT created_at FROM server_epochs WHERE server_id = ? AND epoch = ?', sid, e)[0].created_at;
  // Everyone else joins right after: they wait together for the next key.
  for (const p of people.slice(1)) await joinWith(p, code);
  let k = keyRow(sid);
  assert.equal(k.needs_rotation, 0, 'messages keep flowing meanwhile');
  assert.equal(k.key_epoch, e);
  assert.equal(k.join_rotate_at, made + GAP * 1, 'one key made in the last hour: one gap after it');
  for (const p of people.slice(1)) assert.equal(memberRow(sid, p.id).key_from, e + 1);
  // Their key isn't shared now, and no app is told they're missing it.
  const st = (await as(B, 'GET', `/servers/${sid}/keys`)).json;
  assert.deepEqual(st.missing, []);
  // What's said while they wait is under a key from before theirs: not sent, not served.
  const waiter = people[1];
  const sock = await connect(waiter);
  const got = collect(sock, 'message:new');
  const during = await send(B, ch);
  assert.ok(await until(() => keyRow(sid).needs_rotation === 1, GAP * 4), 'the wait ends by itself');
  assert.equal(keyRow(sid).join_rotate_at, null);
  const e2 = await rotate(A, sid);
  for (const p of people) assert.ok((await as(p, 'GET', `/servers/${sid}/keys`)).json.keys.some((x) => x.epoch === e2 || x.epoch === e));
  const after = await send(B, ch);
  assert.ok(await until(() => got.some((m) => m.id === after)));
  assert.ok(!got.some((m) => m.id === during), 'the message under the old key never reached the waiting member');
  const p = await page(waiter, ch);
  assert.deepEqual(ids(p.messages), [after]);
  assert.equal(p.hidden, true);
  assert.equal((await as(waiter, 'GET', '/me/unread')).json.states['c:' + ch].unread, 1, 'nor counted as unread');
  // Each key made in the last hour adds a gap: the next joiner waits for two gaps after the newest key.
  const last = await srv.register();
  await joinWith(last, code);
  const n = srv.sql('SELECT COUNT(*) n FROM server_epochs WHERE server_id = ? AND created_at > ?', sid, Date.now() - 3600000)[0].n;
  const newest = srv.sql('SELECT MAX(created_at) t FROM server_epochs WHERE server_id = ?', sid)[0].t;
  assert.equal(n, 2);
  assert.equal(keyRow(sid).join_rotate_at, newest + GAP * n);
  // A key made for any other reason meanwhile covers them: the wait is dropped, nothing more is made.
  srv.sql('UPDATE servers SET needs_rotation = 1 WHERE id = ?', sid);
  await rotate(A, sid);
  assert.equal(keyRow(sid).join_rotate_at, null);
  await sleep(GAP * 3);
  assert.equal(keyRow(sid).needs_rotation, 0, 'no extra key once everyone has one');
});

test('a wait survives a restart', async () => {
  const A = await srv.register(); const N = await srv.register();
  const { sid, code } = await space(A, [], 'restart');
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid); // a fresh key: the join waits
  await joinWith(N, code);
  assert.ok(keyRow(sid).join_rotate_at, 'waiting');
  assert.equal(keyRow(sid).needs_rotation, 0);
  await srv.restart();
  assert.ok(await until(() => keyRow(sid).needs_rotation === 1, 6000), 'still replaced after the restart');
  assert.equal(keyRow(sid).join_rotate_at, null);
});

// ------------------------------------------------------------------ history
test('on: nothing from before is served (messages, threads, pins, search, saved, jumps, reactions, polls, reports, export, unread); later messages are', async () => {
  const A = await srv.register(); const B = await srv.register(); const N = await srv.register();
  await as(N, 'GET', '/me/unread'); // N's read state starts before any of this (see the flood test)
  const { sid, code, ch } = await space(A, [B]);
  const old = await send(A, ch);
  const oldThread = await send(A, ch);
  const oldReply = await send(B, ch, { threadId: oldThread });
  assert.equal((await as(A, 'POST', `/messages/${old}/pin`)).status, 200);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid);
  const before2 = await send(B, ch); // under the new key, still before N joined
  ageKeys(sid);
  await joinWith(N, code);
  await rotate(A, sid);
  const fresh = await send(B, ch, { replyTo: old });
  const freshThread = await send(A, ch);
  await send(B, ch, { threadId: freshThread });
  const p = await page(N, ch);
  assert.deepEqual(ids(p.messages), [fresh, freshThread]);
  assert.equal(p.hidden, true, 'one line instead of rows of locked messages');
  assert.equal(p.messages[0].reply, null);
  assert.equal(p.messages[0].replyHidden, true, 'the quote of an older message isn’t sent either');
  assert.equal((await page(N, ch, `?around=${old}`)).messages.some((m) => m.id === old), false);
  assert.equal((await page(N, ch, `?before=${fresh}`)).messages.length, 0);
  // Members who were in keep everything.
  const pb = await page(B, ch);
  for (const id of [old, oldThread, before2, fresh]) assert.ok(ids(pb.messages).includes(id));
  assert.equal(pb.hidden, undefined);
  assert.ok(pb.messages.find((m) => m.id === fresh).reply, 'B gets the quote');
  // Threads
  assert.equal((await as(N, 'GET', `/messages/${oldThread}/thread`)).status, 404);
  assert.equal((await as(N, 'GET', `/messages/${freshThread}/thread`)).status, 200);
  const panel = (await as(N, 'GET', `/channels/${ch}/threads`)).json.threads.map((t) => t.rootId);
  assert.deepEqual(panel, [freshThread]);
  assert.equal((await as(B, 'GET', `/channels/${ch}/threads`)).json.threads.length, 2);
  // Pins and the pin history
  assert.deepEqual((await as(N, 'GET', `/channels/${ch}/pins`)).json, []);
  assert.equal((await as(B, 'GET', `/channels/${ch}/pins`)).json.length, 1);
  assert.deepEqual((await as(N, 'GET', `/channels/${ch}/pins/log`)).json, []);
  assert.equal((await as(B, 'GET', `/channels/${ch}/pins/log`)).json.length, 1);
  // Search, every scope
  for (const scope of [`c:${ch}`, `s:${sid}`, 'all']) {
    const found = ids((await as(N, 'GET', `/search/messages?scope=${scope}`)).json.messages);
    for (const id of [old, oldThread, oldReply, before2]) assert.ok(!found.includes(id), `${scope}: nothing from before`);
    assert.ok(found.includes(fresh), `${scope}: later ones`);
  }
  assert.ok(ids((await as(B, 'GET', `/search/messages?scope=c:${ch}`)).json.messages).includes(old));
  // Jumps, saving, reacting, pinning, polls, reports: answered like a message they can't see.
  assert.equal((await as(N, 'GET', `/messages/${old}/locate`)).status, 404);
  assert.equal((await as(N, 'GET', `/messages/${fresh}/locate`)).status, 200);
  assert.equal((await as(N, 'PUT', `/me/saved/${old}`, {})).status, 404);
  assert.equal((await as(N, 'POST', `/messages/${old}/reactions`, { emoji: '👍' })).status, 404);
  assert.equal((await as(N, 'GET', `/polls/${old}`)).status, 404);
  const rep = await as(N, 'POST', '/reports', { category: 'spam', context: { kind: 'message', messageId: old }, evidence: [{ id: old, text: 'x', reported: true }] });
  assert.equal(rep.status, 404);
  // A report about a later message can't attach an earlier one as evidence.
  const rep2 = await as(N, 'POST', '/reports', { category: 'spam', context: { kind: 'message', messageId: fresh }, evidence: [{ id: fresh, text: 'later' }, { id: old, text: 'made up' }] });
  assert.equal(rep2.status, 200, rep2.text);
  const ev = JSON.parse(srv.sql('SELECT evidence FROM reports WHERE reporter_id = ?', N.id)[0].evidence);
  assert.deepEqual(ev.map((e) => e.id), [fresh]);
  // Export
  const ex = await as(N, 'POST', '/me/export', { authKey: N.authKey });
  assert.equal(ex.status, 200, ex.text);
  const out = await srv.api('GET', `/me/export/messages?conv=c:${ch}`, { token: N.token, ip: N.ip, headers: { 'x-export-token': ex.json.token } });
  assert.equal(out.status, 200, out.text);
  const exported = ids(out.json.messages);
  for (const id of [old, oldThread, oldReply, before2]) assert.ok(!exported.includes(id));
  assert.ok(exported.includes(fresh));
  // Unread: only what came after they joined counts.
  const un = (await as(N, 'GET', '/me/unread')).json.states['c:' + ch];
  assert.equal(un.unread, 2);
  // Replying to an older message by its id (one a rejoiner remembers, say) doesn't hand back its quote either.
  const mine = await as(N, 'POST', `/channels/${ch}/messages`, { ciphertext: cipher(), epoch: keyRow(sid).key_epoch, replyTo: old });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json.reply, null);
  assert.equal(mine.json.replyHidden, true);
  assert.ok((await page(B, ch)).messages.find((m) => m.id === mine.json.id).reply, 'B still sees what it answers');
});

test('a message saved during an earlier membership shows as unavailable after rejoining with it on', async () => {
  const A = await srv.register(); const M = await srv.register();
  const { sid, code, ch } = await space(A, [M]);
  const old = await send(A, ch);
  assert.equal((await as(M, 'PUT', `/me/saved/${old}`, {})).status, 200);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid);
  assert.equal((await as(M, 'POST', `/servers/${sid}/leave`)).status, 200);
  ageKeys(sid);
  await joinWith(M, code);
  const item = (await as(M, 'GET', '/me/saved')).json.items.find((i) => i.messageId === old);
  assert.equal(item.unavailable, true);
  assert.equal(item.message, undefined);
});

test('voice channel chats: the same rules', async () => {
  const A = await srv.register(); const N = await srv.register(); const L = await srv.register();
  const { sid, code, voice } = await space(A, []);
  const old = await send(A, voice);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid);
  ageKeys(sid);
  await joinWith(N, code);
  await rotate(A, sid);
  const fresh = await send(A, voice);
  const p = await page(N, voice);
  assert.deepEqual(ids(p.messages), [fresh]);
  assert.equal(p.hidden, true);
  assert.ok(!ids((await as(N, 'GET', `/search/messages?scope=c:${voice}`)).json.messages).includes(old));
  assert.deepEqual(ids((await page(A, voice)).messages), [old, fresh]);
  // Turned off again: whoever joins next reads back as before; N keeps their own start.
  assert.equal((await setHide(A, sid, false)).status, 200);
  await joinWith(L, code);
  assert.equal(memberRow(sid, L.id).key_from, null);
  assert.deepEqual(ids((await page(L, voice)).messages), [old, fresh]);
  assert.equal((await page(L, voice)).hidden, undefined);
  assert.equal((await page(N, voice)).hidden, true);
  assert.equal(memberRow(sid, N.id).key_from > 0, true);
});

test('live events: an edit, reactions and pins of older messages skip the newcomer; new messages and replies reach them (without the quote)', async () => {
  const A = await srv.register(); const B = await srv.register(); const N = await srv.register();
  const { sid, code, ch } = await space(A, [B]);
  const old = await send(B, ch);
  const oldRoot = await send(A, ch);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid);
  ageKeys(sid);
  await joinWith(N, code);
  await rotate(A, sid);
  const sock = await connect(N);
  const bsock = await connect(B);
  const seen = { upd: collect(sock, 'message:update'), react: collect(sock, 'reaction:update'), pin: collect(sock, 'pin:update'), neu: collect(sock, 'message:new'), thr: collect(sock, 'thread:update') };
  const bseen = collect(bsock, 'message:update');
  // B edits the older message: it's now locked with the key N holds, so N must not get it.
  const ed = await as(B, 'PATCH', `/messages/${old}`, { ciphertext: cipher(), epoch: keyRow(sid).key_epoch });
  assert.equal(ed.status, 200, ed.text);
  assert.equal((await as(B, 'POST', `/messages/${old}/reactions`, { emoji: '🔥' })).status, 200);
  assert.equal((await as(A, 'POST', `/messages/${old}/pin`)).status, 200);
  await send(B, ch, { threadId: oldRoot }); // a reply in a thread from before
  const reply = await send(B, ch, { replyTo: old });
  assert.ok(await until(() => seen.neu.some((m) => m.id === reply)));
  assert.ok(await until(() => bseen.some((m) => m.id === old)), 'members who were in get the edit');
  await sleep(200);
  assert.deepEqual(seen.upd, []);
  assert.deepEqual(seen.react, []);
  assert.deepEqual(seen.pin, []);
  assert.deepEqual(seen.thr, []);
  assert.deepEqual(seen.neu.map((m) => m.id), [reply], 'not the reply in the older thread');
  assert.equal(seen.neu[0].reply, null);
  assert.equal(seen.neu[0].replyHidden, true);
});

test('members already in when it was turned on keep everything, live too', async () => {
  const A = await srv.register(); const B = await srv.register();
  const { sid, ch } = await space(A, [B]);
  const old = await send(A, ch);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid);
  const sock = await connect(B);
  const upd = collect(sock, 'message:update');
  assert.equal((await as(A, 'PATCH', `/messages/${old}`, { ciphertext: cipher(), epoch: keyRow(sid).key_epoch })).status, 200);
  assert.ok(await until(() => upd.some((m) => m.id === old)));
  assert.ok(ids((await page(B, ch)).messages).includes(old));
  assert.equal(memberRow(sid, B.id).key_from, null);
});

// ------------------------------------------------------------------ threads from before, and the rest of the edges
test('a thread from before stays closed everywhere, replies written after the join included', async () => {
  const A = await srv.register(); const B = await srv.register(); const N = await srv.register();
  for (const u of [B, N]) await as(u, 'GET', '/me/unread'); // their read state starts before any of this
  const { sid, code, ch } = await space(A, [B]);
  const root = await send(A, ch);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid);
  ageKeys(sid);
  await joinWith(N, code);
  await rotate(A, sid);
  const sock = await connect(N);
  const react = collect(sock, 'reaction:update');
  const thr = collect(sock, 'thread:update');
  // Written after N joined, under the key N holds, but in a thread from before (an @everyone ping too).
  const reply = await send(A, ch, { threadId: root, everyone: true });
  const later = await send(A, ch, { threadId: root });
  assert.equal((await as(A, 'POST', `/messages/${reply}/pin`)).status, 200);
  const quote = await send(B, ch, { replyTo: reply }); // a channel message quoting that reply
  assert.equal((await as(N, 'GET', `/messages/${root}/thread`)).status, 404);
  for (const scope of [`c:${ch}`, `s:${sid}`, 'all']) {
    const found = ids((await as(N, 'GET', `/search/messages?scope=${scope}`)).json.messages);
    assert.ok(!found.includes(reply) && !found.includes(later), `${scope}: not the replies`);
    assert.ok(found.includes(quote), `${scope}: later channel messages still`);
  }
  assert.ok(ids((await as(B, 'GET', `/search/messages?scope=c:${ch}`)).json.messages).includes(reply), 'B finds it');
  assert.equal((await as(N, 'GET', `/messages/${reply}/locate`)).status, 404);
  assert.equal((await as(N, 'PUT', `/me/saved/${reply}`, {})).status, 404);
  assert.equal((await as(N, 'POST', `/messages/${reply}/reactions`, { emoji: '👍' })).status, 404);
  assert.equal((await as(N, 'POST', '/me/read', { conv: 't:' + root, messageId: reply })).status, 404, 'no read state for it either');
  assert.equal((await as(N, 'POST', `/channels/${ch}/messages`, { ciphertext: cipher(), epoch: keyRow(sid).key_epoch, threadId: root })).status, 404, 'nor a reply into it');
  assert.equal((await as(N, 'POST', `/channels/${ch}/scheduled-messages`, { ciphertext: cipher(), epoch: keyRow(sid).key_epoch, ref: H.hex(12), draft: 'x1:' + b64(30), sendAt: Date.now() + 3600000, threadId: root })).status, 404, 'nor a scheduled one');
  assert.deepEqual((await as(N, 'GET', `/channels/${ch}/pins`)).json, [], 'its pin');
  assert.equal((await as(B, 'GET', `/channels/${ch}/pins`)).json.length, 1);
  assert.deepEqual((await as(N, 'GET', `/channels/${ch}/pins/log`)).json, []);
  const q = (await page(N, ch)).messages.find((m) => m.id === quote);
  assert.equal(q.reply, null);
  assert.equal(q.replyHidden, true, 'a quote of it is left out');
  // Its ping doesn't count for N: not in the unread badge, not when N opens a thread they can open.
  assert.equal((await as(N, 'GET', '/me/unread')).json.states['c:' + ch].threadMentions || 0, 0);
  const mine = await send(A, ch);
  await send(B, ch, { threadId: mine });
  assert.equal((await as(N, 'GET', `/messages/${mine}/thread`)).json.state.threadMentions, 0);
  assert.equal((await as(B, 'GET', '/me/unread')).json.states['c:' + ch].threadMentions, 1, 'B was pinged');
  // Live: B reacts to the reply; nothing reaches N. Then a moderator removes one reply: the count isn't sent to N.
  assert.equal((await as(B, 'POST', `/messages/${reply}/reactions`, { emoji: '🔥' })).status, 200);
  assert.equal((await as(A, 'POST', `/channels/${ch}/messages/bulk-delete`, { ids: [later] })).status, 200);
  await sleep(300);
  assert.deepEqual(react, []);
  assert.ok(!thr.some((t) => t.rootId === root), 'no thread counts of the older thread');
  // Export
  const ex = await as(N, 'POST', '/me/export', { authKey: N.authKey });
  const out = await srv.api('GET', `/me/export/messages?conv=c:${ch}`, { token: N.token, ip: N.ip, headers: { 'x-export-token': ex.json.token } });
  assert.equal(out.status, 200, out.text);
  assert.ok(!ids(out.json.messages).includes(reply));
  assert.ok(ids(out.json.messages).includes(quote));
});

test('a newcomer doesn’t make the key their own join asked for while an older member can; alone, they may', async () => {
  const A = await srv.register(); const B = await srv.register(); const N = await srv.register();
  const { sid, code } = await space(A, [B]);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid); // a fresh key: under 10 minutes old
  await sleep(GAP + 100); // one gap later, a join switches keys at once
  await joinWith(N, code);
  assert.equal(keyRow(sid).needs_rotation, 1);
  await connect(B); // an older member is online: their app makes it
  const epoch = keyRow(sid).key_epoch + 1;
  const wraps = Object.fromEntries(memberIds(sid).map((id) => [id, fakeWrap()]));
  const r = await as(N, 'POST', `/servers/${sid}/keys/rotate`, { epoch, check: b64(24), wraps });
  assert.equal(r.status, 429, r.text);
  assert.equal(r.json.code, 'rotate_too_soon');
  await rotate(B, sid);
  // Nobody else online: the newcomer makes it (or they couldn't write at all).
  const C = await srv.register(); const M = await srv.register();
  const t = await space(C, [], 'quiet');
  assert.equal((await setHide(C, t.sid, true)).status, 200);
  await rotate(C, t.sid);
  await sleep(GAP + 100);
  await joinWith(M, t.code);
  assert.equal(keyRow(t.sid).needs_rotation, 1);
  await rotate(M, t.sid);
});

test('crypto-2: someone held back until verified gets no key either way, and isn’t the older member who makes a newcomer’s key', async () => {
  const A = await srv.register(); const B = await srv.register(); const N = await srv.register(); const V = await srv.register();
  const { sid, code } = await space(A, [B]);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid); // a fresh key: under 10 minutes old
  const copies = (u, epoch) => srv.sql('SELECT COUNT(*) n FROM server_keys WHERE server_id = ? AND user_id = ? AND epoch = ?', sid, u.id, epoch)[0].n;
  // B's password was reset without the recovery key: held back here until someone verifies them.
  srv.sql('UPDATE users SET keys_reset_at = ? WHERE id = ?', Date.now(), B.id);
  await sleep(GAP + 100); // one gap later, a join switches keys at once
  await joinWith(N, code);
  assert.equal(keyRow(sid).needs_rotation, 1);
  // The only older member online is held back, so can't make it: the newcomer may, without the voluntary limits.
  await connect(B);
  const e = await rotate(N, sid);
  assert.equal(copies(N, e), 1);
  assert.equal(copies(B, e), 0, 'no copy of the new key for the member held back');
  // A newcomer held back: the key their join asked for isn't theirs, nothing is shared to them, they aren't listed as
  // missing it or waiting for a newer one. Once verified, they're handed the current key like any member missing it
  // (here still the one their join asked for). A key made while they were held and replaced since would stay out of
  // reach, as for anyone held back: keys/share only ever hands on the current key.
  srv.sql('UPDATE users SET keys_reset_at = ? WHERE id = ?', Date.now(), V.id);
  ageKeys(sid);
  const joined = await joinWith(V, code);
  assert.equal(memberRow(sid, V.id).key_from, e + 1);
  assert.ok(joined.keyState.held.includes(V.id), 'listed as held');
  assert.deepEqual(joined.keyState.keys, []);
  const e2 = await rotate(A, sid);
  assert.equal(copies(V, e2), 0, 'the new key a held newcomer’s join asked for isn’t handed to them');
  let st = (await as(A, 'GET', `/servers/${sid}/keys`)).json;
  assert.ok(!st.missing.includes(V.id) && !(st.waiting || []).includes(V.id), JSON.stringify(st));
  const shareTo = () => as(A, 'POST', `/servers/${sid}/keys/share`, { epoch: e2, wraps: { [V.id]: fakeWrap() } });
  let share = await shareTo();
  assert.equal(share.status, 200, share.text);
  assert.equal(share.json.shared, 0, 'nothing shared while held');
  srv.sql('UPDATE users SET keys_reset_at = NULL WHERE id = ?', V.id); // verified (an instance admin, say)
  st = (await as(A, 'GET', `/servers/${sid}/keys`)).json;
  assert.ok(st.missing.includes(V.id), 'now missing the current key, made after they joined');
  share = await shareTo();
  assert.equal(share.json.shared, 1);
  assert.deepEqual((await as(V, 'GET', `/servers/${sid}/keys`)).json.keys.map((k) => k.epoch), [e2]);
});

test('the toggle limit is each person’s own: a co-manager can’t use it up and leave it off', async () => {
  const A = await srv.register(); const B = await srv.register(); const N = await srv.register();
  const { sid, code } = await space(A, [B]);
  const role = (await as(A, 'POST', `/servers/${sid}/roles`, { name: 'admins', permissions: PERMS.MANAGE_SERVER })).json;
  assert.equal((await as(A, 'PUT', `/servers/${sid}/members/${B.id}/roles`, { roleIds: [role.id] })).status, 200);
  assert.equal((await setHide(A, sid, true)).status, 200);
  for (let i = 0; i < 9; i++) assert.equal((await setHide(B, sid, i % 2 === 1)).status, 200); // off, on, … off
  assert.equal((await setHide(A, sid, true)).status, 200);
  assert.equal((await setHide(B, sid, false)).status, 200, 'B’s 10th, off again');
  assert.equal((await setHide(B, sid, true)).status, 429, 'B’s own 11th change');
  assert.equal(keyRow(sid).hide_history, 0);
  const r = await setHide(A, sid, true);
  assert.equal(r.status, 200, r.text);
  await joinWith(N, code);
  assert.ok(memberRow(sid, N.id).key_from > 0, 'the next joiner is kept from the backlog');
});

test('a moderator who joined later doesn’t get report evidence from before they joined', async () => {
  const A = await srv.register(); const B = await srv.register(); const C = await srv.register(); const M = await srv.register();
  const { sid, code, ch } = await space(A, [B, C]);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid);
  const bad = await send(C, ch);
  const rep = await as(B, 'POST', '/reports', { category: 'harassment', context: { kind: 'message', messageId: bad }, evidence: [{ id: bad, text: 'before the moderator' }] });
  assert.equal(rep.status, 200, rep.text);
  ageKeys(sid);
  await joinWith(M, code);
  await rotate(A, sid);
  const fresh = await send(C, ch);
  const rep2 = await as(B, 'POST', '/reports', { category: 'harassment', context: { kind: 'message', messageId: fresh }, evidence: [{ id: fresh, text: 'after' }] });
  assert.equal(rep2.status, 200, rep2.text);
  const role = (await as(A, 'POST', `/servers/${sid}/roles`, { name: 'mods', permissions: PERMS.MANAGE_MESSAGES | PERMS.VIEW_CHANNEL })).json;
  assert.equal((await as(A, 'PUT', `/servers/${sid}/members/${M.id}/roles`, { roleIds: [role.id] })).status, 200);
  const list = (await as(M, 'GET', `/servers/${sid}/reports`)).json.reports;
  const first = list.find((x) => x.id === rep.json.id);
  const second = list.find((x) => x.id === rep2.json.id);
  assert.ok(first, 'the report itself is there to handle');
  assert.deepEqual(first.evidence, []);
  assert.equal(first.evidenceHidden, 1);
  assert.deepEqual(second.evidence.map((e) => e.text), ['after']);
  assert.equal(second.evidenceHidden, undefined);
  const own = (await as(A, 'GET', `/servers/${sid}/reports`)).json.reports.find((x) => x.id === rep.json.id);
  assert.deepEqual(own.evidence.map((e) => e.text), ['before the moderator'], 'the owner, there all along, sees it');
});

test('timer changes, pin history and the key count: nothing from before (or from the key wait) for the newcomer', async () => {
  const A = await srv.register(); const B = await srv.register(); const N = await srv.register();
  const { sid, code, ch } = await space(A, [B]);
  assert.equal((await as(A, 'PUT', `/channels/${ch}/disappearing`, { seconds: 3600 })).status, 200);
  assert.equal((await as(A, 'PUT', `/channels/${ch}/disappearing`, { seconds: 0 })).status, 200);
  assert.equal((await setHide(A, sid, true)).status, 200);
  await rotate(A, sid); // fresh: the join waits for the next key
  await joinWith(N, code);
  assert.ok(keyRow(sid).join_rotate_at, 'waiting');
  const st = (await as(A, 'GET', `/servers/${sid}/keys`)).json;
  assert.deepEqual(st.waiting, [N.id], 'listed apart, so the encryption dialog counts who holds the key');
  assert.ok(!st.missing.includes(N.id));
  const during = await send(B, ch); // under the old key, while N waits
  assert.equal((await as(A, 'POST', `/messages/${during}/pin`)).status, 200);
  assert.ok(await until(() => keyRow(sid).needs_rotation === 1, GAP * 4));
  await rotate(A, sid);
  assert.equal((await as(A, 'GET', `/servers/${sid}/keys`)).json.waiting, undefined);
  const after = await send(B, ch);
  assert.equal((await as(A, 'PUT', `/channels/${ch}/disappearing`, { seconds: 86400 })).status, 200);
  const p = await page(N, ch);
  assert.deepEqual(ids(p.messages), [after]);
  assert.deepEqual(p.timerEvents.map((e) => e.secs), [86400], 'only the change after they joined');
  assert.equal((await page(B, ch)).timerEvents.length, 3);
  assert.deepEqual((await as(N, 'GET', `/channels/${ch}/disappearing`)).json.log.map((e) => e.secs), [86400]);
  assert.equal((await as(B, 'GET', `/channels/${ch}/disappearing`)).json.log.length, 3);
  assert.deepEqual((await as(N, 'GET', `/channels/${ch}/pins/log`)).json, [], 'not the pin of a message they can’t open');
  assert.equal((await as(B, 'GET', `/channels/${ch}/pins/log`)).json.length, 1);
});

// ------------------------------------------------------------------ the app's own key code
// Browser bits the client code needs (each device its own pin store).
let store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { crypto: globalThis.crypto, hashwasm: require('hash-wasm') };
const realFetch = globalThis.fetch;
let curIp = '198.51.100.9';
const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;

test('the app: a newcomer’s device holds only the new key and reads what came after; older members’ devices keep theirs', async () => {
  globalThis.fetch = (url, opts = {}) => (String(url).startsWith('/')
    ? realFetch(srv.base + url, { ...opts, headers: { ...(opts.headers || {}), 'x-forwarded-for': curIp } })
    : realFetch(url, opts));
  const E = await import(js('e2ee.js'));
  const API = await import(js('api.js'));
  const { createSecure } = await import(js('secure.js'));
  async function person(name) {
    const kdfSalt = E.newKdfSalt();
    const { authKey, wrapKey } = await E.deriveKeys(name, `pw-${name}`, { kdf: 'argon2id', salt: kdfSalt });
    const id = await E.createIdentity(wrapKey);
    const ip = H.newIp();
    const r = await srv.api('POST', '/auth/register', { ip, body: { username: name, authKey, kdfSalt, publicKey: id.publicKey, encPrivateKey: id.encPrivateKey, acceptTos: srv.config.termsVersion || undefined } });
    assert.equal(r.status, 200, r.text);
    const p = { username: name, ip, authKey, token: r.json.token, id: r.json.user.id, ...id };
    const sk = await E.createSigningKey(id.privateKey, id.publicKey);
    Object.assign(p, sk);
    const ch = (await as(p, 'POST', '/me/sign-key/challenge')).json;
    const keyProof = await E.signKeyProof(p.privateKey, ch.serverPublicKey, ch.nonce, p.id, sk.signPublicKey);
    const signature = await E.sign(sk.signKey, `hearth-sign-key|${p.id}|${p.publicKey}|${ch.nonce}`);
    assert.equal((await as(p, 'POST', '/me/sign-key', { signPublicKey: sk.signPublicKey, encSignPrivateKey: sk.encSignPrivateKey, nonce: ch.nonce, keyProof, signature })).status, 200);
    return p;
  }
  async function device(user) {
    store = new Map(); curIp = user.ip; API.setToken(user.token);
    const boot = (await as(user, 'GET', '/bootstrap')).json;
    const S = { me: boot.me, users: boot.users, servers: boot.servers, dms: boot.dms, privateKey: user.privateKey, e2eeSince: boot.e2eeSince };
    const sec = createSecure({ S });
    await sec.ensureSigningKey(boot.encSignPrivateKey);
    Object.values(S.users).forEach((u) => sec.trust(u));
    for (const st of Object.values(boot.keyStates || {})) await sec.applyState(st);
    for (const s of S.servers) await sec.keysSaved(s.id);
    return { sec, S };
  }
  const tag = H.hex(3);
  const A = await person(`ann${tag}`); const B = await person(`ben${tag}`); const N = await person(`neo${tag}`);
  const s = (await as(A, 'POST', '/servers', { name: 'real keys' })).json;
  const ch = s.channels.find((c) => c.type === 'text').id;
  const code = (await as(A, 'POST', `/servers/${s.id}/invites`, {})).json.code;
  await joinWith(B, code);
  let a = await device(A);
  const sendReal = async (d, u, t) => {
    const { ciphertext, epoch } = await d.sec.encryptChannel(s.id, ch, { t });
    const r = await as(u, 'POST', `/channels/${ch}/messages`, { ciphertext, epoch });
    assert.equal(r.status, 200, r.text);
    return r.json.id;
  };
  await sendReal(a, A, 'before the newcomer: plum');
  assert.equal((await setHide(A, s.id, true)).status, 200);
  ageKeys(s.id);
  await joinWith(N, code);
  a = await device(A); // Alice's app sees the key needs replacing and makes the next one, for everyone
  assert.ok(await until(() => keyRow(s.id).key_epoch === 2 && keyRow(s.id).needs_rotation === 0));
  a = await device(A);
  await sendReal(a, A, 'after the newcomer: pear');
  const n = await device(N);
  assert.deepEqual(n.sec.heldEpochs(s.id), [2], 'only the key made after they joined');
  const msgs = (await as(N, 'GET', `/channels/${ch}/messages`)).json;
  assert.equal(msgs.hidden, true);
  assert.equal(msgs.messages.length, 1);
  await n.sec.decryptChannelMessage(msgs.messages[0]);
  assert.equal(msgs.messages[0].dec.t, 'after the newcomer: pear');
  assert.ok(!msgs.messages.some((m) => m.dec && m.dec.pending), 'no “waiting for key” rows');
  const b = await device(B);
  assert.deepEqual(b.sec.heldEpochs(s.id).sort(), [1, 2]);
  const bm = (await as(B, 'GET', `/channels/${ch}/messages`)).json.messages;
  for (const m of bm) await b.sec.decryptChannelMessage(m);
  assert.deepEqual(bm.map((m) => m.dec.t), ['before the newcomer: plum', 'after the newcomer: pear']);
});
