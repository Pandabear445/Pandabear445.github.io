// Disappearing messages (server/disappear.js and public/js/disappear.js): a timer per conversation, a deadline
// stamped on each message when it's sent, and the job that deletes messages once their time has passed.
// Checked for what it allows and what it refuses: who may change a timer, what the server stops handing out the
// moment a message's time has passed (before the sweep), what the sweep deletes with it, and that its bytes don't
// stay readable in the database file.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, hex, sleep } = require('./helpers');

const HOUR = 3600; const DAY = 86400; const WEEK = 7 * DAY; const WEEKS4 = 28 * DAY;
const P = { VIEW: 1, MANAGE_CHANNELS: 1 << 11, MANAGE_ROLES: 1 << 12 };
const cipher = (marker = '') => 'v2:' + crypto.randomBytes(48).toString('base64') + marker;

let srv; // the sweep never runs on its own here: what's refused is refused by the deadline alone
let boss; let alice; let bob; let carol; let outsider;
let space; let general; let lounge; let voiceCh; let group; let groupChat; let dm; let keepers; let inviteCode;
const socks = [];
const as = (u, method, p, body, s = srv) => s.api(method, p, { token: u.token, ip: u.ip, body });
const freshEpoch = (sid, s = srv) => s.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', sid);
async function sendC(u, channelId, extra = {}, s = srv) {
  const c = s.sql('SELECT server_id FROM channels WHERE id = ?', channelId)[0];
  freshEpoch(c.server_id, s);
  const r = await as(u, 'POST', `/channels/${channelId}/messages`, { ciphertext: cipher(), epoch: 1, ...extra }, s);
  assert.equal(r.status, 200, r.text);
  return r.json;
}
async function sendD(u, dmId, extra = {}, s = srv) {
  const r = await as(u, 'POST', `/dms/${dmId}/messages`, { ciphertext: cipher(), ...extra }, s);
  assert.equal(r.status, 200, r.text);
  return r.json;
}
const setTimer = (u, key, seconds, s = srv) => as(u, 'PUT', `${key.startsWith('d:') ? '/dms/' : '/channels/'}${key.slice(2)}/disappearing`, { seconds }, s);
// Setting a timer as part of a test's setup goes straight to the database: the route allows each person 10 changes a
// minute, and the tests about the route use their own people.
const useTimer = (key, secs, s = srv) => s.sql(`UPDATE ${key.startsWith('d:') ? 'dm_channels' : 'channels'} SET disappear_secs = ? WHERE id = ?`, secs, key.slice(2));
// People with Manage Channels in the test server, each used for a few changes (see useTimer).
const pool = [];
async function keeper() {
  let k = pool.find((x) => x.uses < 8);
  if (!k) {
    k = await srv.register(`keep${hex(3)}`);
    k.uses = 0;
    assert.equal((await as(k, 'POST', `/invites/${inviteCode}/join`)).status, 200);
    assert.equal((await as(boss, 'PUT', `/servers/${space.id}/members/${k.id}/roles`, { roleIds: [keepers.id] })).status, 200);
    pool.push(k);
  }
  k.uses++;
  return k;
}
// Moves a message's deadline into the past, as if its time had come (the sweep isn't running on srv).
const expire = (id, s = srv) => { s.sql('UPDATE messages SET expires_at = ? WHERE id = ?', Date.now() - 1000, id); s.sql('UPDATE dm_messages SET expires_at = ? WHERE id = ?', Date.now() - 1000, id); s.sql('UPDATE blobs SET expires_at = ? WHERE message_id = ?', Date.now() - 1000, id); };
const sock = async (u, s = srv) => { const x = await s.socket(u.token); socks.push(x); return x; };
const collect = (x, ev) => { const got = []; x.on(ev, (p) => got.push(p)); return got; };
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; }
async function upload(u, bytes, s = srv) {
  const boundary = '----hearth' + hex(8);
  const raw = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await s.api('POST', '/upload/encrypted', { token: u.token, ip: u.ip, raw, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, timeout: 30000 });
  assert.equal(r.status, 200, r.text);
  return r.json.url;
}
async function people(s) {
  const b = s.owner;
  const a = await s.register(`al${hex(3)}`); const c = await s.register(`bo${hex(3)}`);
  const sp = (await as(b, 'POST', '/servers', { name: 'Timer HQ' }, s)).json;
  const { code } = (await as(b, 'POST', `/servers/${sp.id}/invites`, {}, s)).json;
  for (const u of [a, c]) assert.equal((await as(u, 'POST', `/invites/${code}/join`, undefined, s)).status, 200);
  const d = (await as(a, 'POST', '/dms', { userId: c.id }, s)).json;
  return { b, a, c, sp, general: sp.channels.find((x) => x.type === 'text'), d };
}

before(async () => {
  srv = await startServer({ DISAPPEAR_SWEEP_MS: '3600000' });
  boss = srv.owner;
  alice = await srv.register(`alice${hex(3)}`); bob = await srv.register(`bob${hex(3)}`); carol = await srv.register(`carol${hex(3)}`); outsider = await srv.register(`out${hex(3)}`);
  space = (await as(boss, 'POST', '/servers', { name: 'Disappearing HQ' })).json;
  general = space.channels.find((c) => c.type === 'text');
  voiceCh = space.channels.find((c) => c.type === 'voice');
  lounge = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'lounge', type: 'text' })).json;
  inviteCode = (await as(boss, 'POST', `/servers/${space.id}/invites`, {})).json.code;
  for (const u of [alice, bob, carol]) assert.equal((await as(u, 'POST', `/invites/${inviteCode}/join`)).status, 200);
  keepers = (await as(boss, 'POST', `/servers/${space.id}/roles`, { name: 'Channel keepers', permissions: P.VIEW | P.MANAGE_CHANNELS })).json;
  group = (await as(alice, 'POST', '/groups', { userIds: [bob.id] })).json;
  groupChat = group.channels.find((c) => c.type === 'text');
  dm = (await as(alice, 'POST', '/dms', { userId: bob.id })).json;
});
after(async () => {
  socks.forEach((x) => x.close());
  if (srv) await srv.stop();
});

// ------------------------------------------------------------------ the timer
test('timer: only off, 1 hour, 1 day, 1 week and 4 weeks (and 5 s under test); anything else is 400 bad_timer', async () => {
  const c = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'choices', type: 'text' })).json;
  for (const v of [HOUR, DAY, WEEK, WEEKS4, 5, 0]) {
    const r = await setTimer(await keeper(), 'c:' + c.id, v);
    assert.equal(r.status, 200, `${v}: ${r.text}`);
    assert.equal(r.json.seconds, v);
  }
  for (const v of [-1, 1, 7, 60, 3601, HOUR + 0.5, '3600', null, true, [3600], { s: 3600 }, 1e15, WEEKS4 * 2]) {
    const r = await setTimer(await keeper(), 'c:' + c.id, v);
    assert.equal(r.status, 400, `${JSON.stringify(v)}: ${r.text}`);
    assert.equal(r.json.code, 'bad_timer');
  }
  const k = await keeper();
  assert.equal((await as(k, 'PUT', `/channels/${c.id}/disappearing`, {})).status, 400, 'no value');
  // /config lists what the app may offer.
  assert.deepEqual((await srv.api('GET', '/config')).json.disappearing.choices, [0, 5, HOUR, DAY, WEEK, WEEKS4]);
});

test('timer: in a DM either person can set it; outsiders get 404; a block either way or a deleted partner stops it', async () => {
  let r = await setTimer(alice, 'd:' + dm.id, DAY);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.seconds, r.json.prev, r.json.by, r.json.dmId], [DAY, 0, alice.id, dm.id]);
  r = await setTimer(bob, 'd:' + dm.id, HOUR);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.prev, DAY);
  for (const u of [outsider, carol]) assert.equal((await setTimer(u, 'd:' + dm.id, WEEK)).status, 404);
  assert.equal((await as(outsider, 'GET', `/dms/${dm.id}/disappearing`)).status, 404);
  assert.equal((await setTimer(alice, 'd:nope', WEEK)).status, 404);
  // Both people see it in their DM list.
  for (const u of [alice, bob]) assert.equal((await as(u, 'GET', '/bootstrap')).json.dms.find((d) => d.id === dm.id).disappear, HOUR);
  // A block, either way, stops changes (existing messages still disappear on time).
  const d2 = (await as(carol, 'POST', '/dms', { userId: alice.id })).json;
  assert.equal((await as(alice, 'POST', `/blocks/${carol.id}`)).status, 200);
  for (const u of [alice, carol]) assert.equal((await setTimer(u, 'd:' + d2.id, DAY)).status, 403);
  assert.equal((await as(alice, 'DELETE', `/blocks/${carol.id}`)).status, 200);
  assert.equal((await setTimer(carol, 'd:' + d2.id, DAY)).status, 200);
  // The other account deleted: nobody can read new messages to it, so the timer stays as it is.
  const gone = await srv.register(`gone${hex(3)}`);
  const { code } = (await as(boss, 'POST', `/servers/${space.id}/invites`, {})).json;
  await as(gone, 'POST', `/invites/${code}/join`);
  const d3 = (await as(alice, 'POST', '/dms', { userId: gone.id })).json;
  srv.sql('UPDATE users SET deleted_at = ? WHERE id = ?', Date.now(), gone.id);
  const del = await setTimer(alice, 'd:' + d3.id, DAY);
  assert.equal(del.status, 403);
  assert.equal(del.json.code, 'deleted');
  useTimer('d:' + dm.id, 0);
});

test('timer: any group member can set it; in a server channel only Manage Channels there (a per-channel deny counts); a voice channel\'s chat has one, a group\'s call doesn\'t', async () => {
  assert.equal((await setTimer(bob, 'c:' + groupChat.id, WEEK)).status, 200, 'any group member');
  assert.equal((await setTimer(carol, 'c:' + groupChat.id, DAY)).status, 404, 'not in the group');
  useTimer('c:' + groupChat.id, 0);
  // Server channel: plain members can't, someone with Manage Channels can, unless this channel denies it to them.
  const plain = await setTimer(carol, 'c:' + general.id, DAY);
  assert.equal(plain.status, 403, plain.text);
  const k = await keeper();
  assert.equal((await setTimer(k, 'c:' + general.id, DAY)).status, 200);
  assert.equal((await as(boss, 'PUT', `/channels/${lounge.id}/overrides`, { overrides: [{ type: 'role', id: keepers.id, allow: 0, deny: P.MANAGE_CHANNELS }] })).status, 200);
  assert.equal((await setTimer(k, 'c:' + lounge.id, DAY)).status, 403, 'denied in this channel');
  // A channel you can't see stays "not found".
  const hidden = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'staff', type: 'text' })).json;
  await as(boss, 'PUT', `/channels/${hidden.id}/overrides`, { overrides: [{ type: 'role', id: space.id, allow: 0, deny: P.VIEW }] });
  assert.equal((await setTimer(carol, 'c:' + hidden.id, DAY)).status, 404);
  assert.equal((await as(carol, 'GET', `/channels/${hidden.id}/disappearing`)).status, 404);
  // A server's voice channel has a chat (voice chat), which disappears like a text channel's; a group's call has no
  // chat of its own, so it has no timer either.
  const v = await setTimer(boss, 'c:' + voiceCh.id, DAY);
  assert.equal(v.status, 200, v.text);
  const groupCall = group.channels.find((c) => c.type === 'voice');
  const gv = await setTimer(alice, 'c:' + groupCall.id, DAY);
  assert.equal(gv.status, 400);
  assert.equal(gv.json.code, 'bad_channel');
  assert.equal((await setTimer(outsider, 'c:' + general.id, DAY)).status, 404);
  // Channels carry it to everyone who can see them.
  const chans = (await as(bob, 'GET', '/bootstrap')).json.servers.find((s) => s.id === space.id).channels;
  assert.equal(chans.find((c) => c.id === general.id).disappear, DAY);
  assert.equal(chans.find((c) => c.id === voiceCh.id).disappear, DAY);
  assert.equal(voiceCh.disappear, 0);
  // A message in the voice channel's chat gets its deadline like one in a text channel.
  const before = Date.now();
  const vm = await sendC(bob, voiceCh.id, { ttl: DAY });
  assert.ok(vm.expiresAt >= before + DAY * 1000 && vm.expiresAt <= Date.now() + DAY * 1000, 'stamped from the voice channel’s timer');
  useTimer('c:' + general.id, 0);
  useTimer('c:' + voiceCh.id, 0);
});

test('timer: each change is logged (who, from, to, when) and shown with the history page it falls in; the same value again logs nothing; at most 50 kept', async () => {
  const c = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'logged', type: 'text' })).json;
  const m1 = await sendC(bob, c.id);
  const k = await keeper(); k.uses += 4;
  await setTimer(k, 'c:' + c.id, WEEK);
  const again = await setTimer(k, 'c:' + c.id, WEEK);
  assert.equal(again.status, 200);
  assert.equal(again.json.unchanged, true);
  const m2 = await sendC(bob, c.id, { ttl: WEEK });
  await setTimer(k, 'c:' + c.id, DAY);
  await setTimer(k, 'c:' + c.id, 0);
  const st = (await as(bob, 'GET', `/channels/${c.id}/disappearing`)).json;
  assert.equal(st.seconds, 0);
  assert.deepEqual(st.log.map((e) => [e.secs, e.prev, e.by]), [[0, DAY, k.id], [DAY, WEEK, k.id], [WEEK, 0, k.id]]);
  // The history page has them, in time order, with the messages around them.
  const page = (await as(bob, 'GET', `/channels/${c.id}/messages`)).json;
  assert.deepEqual(page.messages.map((m) => m.id), [m1.id, m2.id]);
  assert.deepEqual(page.timerEvents.map((e) => e.secs), [WEEK, DAY, 0]);
  assert.ok(page.timerEvents[0].at >= m1.createdAt && page.timerEvents[0].at <= m2.createdAt);
  // A page of older messages only gets the changes that fall inside it.
  const older = (await as(bob, 'GET', `/channels/${c.id}/messages?before=${m2.id}&limit=1`)).json;
  assert.deepEqual(older.messages.map((m) => m.id), [m1.id]);
  assert.deepEqual(older.timerEvents.map((e) => e.secs), [WEEK]);
  // 50 per conversation: older entries go when a new one comes.
  const conv = 'c:' + c.id;
  for (let i = 0; i < 60; i++) srv.sql('INSERT INTO disappear_log (id, conv, user_id, secs, prev_secs, created_at) VALUES (?, ?, ?, ?, ?, ?)', `old${i}${hex(4)}`, conv, boss.id, DAY, 0, 1000 + i);
  await setTimer(await keeper(), conv, HOUR);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM disappear_log WHERE conv = ?', conv)[0].n, 50);
  assert.equal(srv.sql('SELECT secs FROM disappear_log WHERE conv = ? ORDER BY created_at DESC LIMIT 1', conv)[0].secs, HOUR);
});

test('timer: a server channel’s change is in the server’s audit log with its other settings (a voice channel’s chat too); a group chat has no log', async () => {
  const c = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'audited', type: 'text' })).json;
  const vc = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'audited-voice', type: 'voice' })).json;
  const updates = (id) => srv.sql("SELECT actor_id, detail FROM server_audit WHERE server_id = ? AND action = 'channel_update' AND target_id = ? ORDER BY seq", space.id, id)
    .map((r) => ({ by: r.actor_id, ...JSON.parse(r.detail) }));
  const k = await keeper(); k.uses += 3;
  assert.equal((await setTimer(k, 'c:' + c.id, DAY)).status, 200);
  assert.equal((await setTimer(k, 'c:' + c.id, DAY)).json.unchanged, true);
  assert.equal((await setTimer(k, 'c:' + c.id, 0)).status, 200);
  assert.deepEqual(updates(c.id).map((e) => [e.by, e.changes]), [[k.id, { disappear: { from: 0, to: DAY } }], [k.id, { disappear: { from: DAY, to: 0 } }]], 'each change, not the same value again');
  assert.equal(updates(c.id)[0].channel.id, c.id);
  assert.equal((await setTimer(k, 'c:' + vc.id, DAY)).status, 200);
  assert.deepEqual(updates(vc.id).map((e) => e.changes), [{ disappear: { from: 0, to: DAY } }]);
  // Readers of the log get it like any other change to a channel.
  const log = (await as(boss, 'GET', `/servers/${space.id}/audit?action=channel_update&target=${vc.id}`)).json;
  assert.deepEqual(log.entries.map((e) => [e.actorId, e.detail.changes]), [[k.id, { disappear: { from: 0, to: DAY } }]]);
  // A group chat has no audit log (and a DM none at all).
  const groupRows = () => srv.sql('SELECT COUNT(*) n FROM server_audit WHERE server_id = ?', group.id)[0].n;
  const had = groupRows();
  assert.equal((await setTimer(alice, 'c:' + groupChat.id, HOUR)).status, 200);
  assert.equal(groupRows(), had);
  useTimer('c:' + groupChat.id, 0);
  useTimer('c:' + vc.id, 0);
});

test('timer: disappear:update reaches the DM pair, the group, and in a private channel only people who can see it', async () => {
  const [sa, sb, sc] = [await sock(alice), await sock(bob), await sock(carol)];
  const [ga, gb, gc] = [collect(sa, 'disappear:update'), collect(sb, 'disappear:update'), collect(sc, 'disappear:update')];
  await setTimer(alice, 'd:' + dm.id, DAY);
  await setTimer(bob, 'c:' + groupChat.id, HOUR);
  const priv = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'private', type: 'text' })).json;
  await as(boss, 'PUT', `/channels/${priv.id}/overrides`, { overrides: [{ type: 'role', id: space.id, allow: 0, deny: P.VIEW }, { type: 'member', id: bob.id, allow: P.VIEW, deny: 0 }] });
  await setTimer(boss, 'c:' + priv.id, WEEK);
  assert.ok(await until(() => gb.length >= 3), `bob hears all three (${gb.length})`);
  await sleep(300);
  const convs = (list) => list.map((e) => e.conv).sort();
  assert.deepEqual(convs(gb), ['c:' + groupChat.id, 'c:' + priv.id, 'd:' + dm.id].sort());
  assert.deepEqual(convs(ga), ['c:' + groupChat.id, 'd:' + dm.id].sort(), 'alice: not the private channel');
  assert.deepEqual(gc, [], 'carol: none of these are hers');
  const e = gb.find((x) => x.conv === 'd:' + dm.id);
  assert.deepEqual([e.seconds, e.prev, e.by, e.dmId], [DAY, 0, alice.id, dm.id]);
  useTimer('d:' + dm.id, 0);
  useTimer('c:' + groupChat.id, 0);
});

test('timer: changing it is rate limited per person', async () => {
  const u = await srv.register(`rl${hex(3)}`);
  const { code } = (await as(boss, 'POST', `/servers/${space.id}/invites`, {})).json;
  assert.equal((await as(u, 'POST', `/invites/${code}/join`)).status, 200);
  const g = (await as(boss, 'POST', '/groups', { userIds: [u.id] })).json;
  const gc = g.channels.find((x) => x.type === 'text');
  let last = null;
  for (let i = 0; i < 11; i++) last = await setTimer(u, 'c:' + gc.id, i % 2 ? HOUR : DAY);
  assert.equal(last.status, 429, last.text);
});

test('timer: people using up their own changes don’t stop anyone else in the conversation from changing it', async () => {
  const [m1, m2, m3, v] = [await srv.register(`ma${hex(3)}`), await srv.register(`mb${hex(3)}`), await srv.register(`mc${hex(3)}`), await srv.register(`vi${hex(3)}`)];
  for (const u of [m1, m2, m3, v]) assert.equal((await as(u, 'POST', `/invites/${inviteCode}/join`)).status, 200);
  const g = (await as(m1, 'POST', '/groups', { userIds: [m2.id, m3.id, v.id] })).json;
  const key = 'c:' + g.channels.find((x) => x.type === 'text').id;
  // Thirty changes between three of them, ending on off; each one's eleventh is refused.
  for (const u of [m1, m2, m3]) {
    for (let i = 0; i < 10; i++) { const r = await setTimer(u, key, u === m3 && i === 9 ? 0 : i % 2 ? DAY : HOUR); assert.equal(r.status, 200, r.text); }
    assert.equal((await setTimer(u, key, WEEK)).status, 429);
  }
  // The fourth still can (a budget for the whole conversation would have locked them out for the hour).
  const r = await setTimer(v, key, DAY);
  assert.equal(r.status, 200, r.text);
  assert.ok((await sendC(v, key.slice(2), { ttl: DAY })).expiresAt > Date.now());
});

test('timer: a change between a jump page and the page after it comes with the later one', async () => {
  const [a, b] = [await srv.register(`ja${hex(3)}`), await srv.register(`jb${hex(3)}`)];
  for (const u of [a, b]) assert.equal((await as(u, 'POST', `/invites/${inviteCode}/join`)).status, 200);
  const d = (await as(a, 'POST', '/dms', { userId: b.id })).json;
  // 30 messages a second apart, a timer change half a second after the 30th, then 30 more.
  const ids = [];
  let ts = Date.now() - 600000;
  const put = (exp) => { ts += 1000; const id = ts.toString(36).padStart(9, '0') + hex(5); srv.sql('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, d.id, a.id, cipher(), ts, exp); ids.push(id); };
  for (let i = 0; i < 30; i++) put(null);
  const change = (await setTimer(a, 'd:' + d.id, HOUR)).json;
  srv.sql('UPDATE disappear_log SET created_at = ? WHERE id = ?', ts + 500, change.id);
  for (let i = 0; i < 30; i++) put(Date.now() + 3600000);
  // A search result or link opens the page around message 5 (messages 1–30, more below)...
  const around = (await as(b, 'GET', `/dms/${d.id}/messages?around=${ids[4]}`)).json;
  assert.equal(around.messages.at(-1).id, ids[29]);
  assert.equal(around.hasNewer, true);
  assert.deepEqual(around.timerEvents, []);
  // ...and scrolling down loads 31–60, which starts where that page ended: the change is on it.
  const next = (await as(b, 'GET', `/dms/${d.id}/messages?after=${ids[29]}`)).json;
  assert.equal(next.messages[0].id, ids[30]);
  assert.deepEqual(next.timerEvents.map((e) => e.id), [change.id]);
  // Only from the anchor on: not the changes above it (those came with the page before), even when nothing is newer.
  const sentAt = (n) => srv.sql('SELECT created_at FROM dm_messages WHERE id = ?', ids[n - 1])[0].created_at;
  const logAt = (id, t) => srv.sql('INSERT INTO disappear_log (id, conv, user_id, secs, prev_secs, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, 'd:' + d.id, a.id, DAY, 0, t);
  logAt('above' + hex(4), sentAt(15) + 500);
  logAt('between' + hex(4), sentAt(20) + 500);
  const mid = (await as(b, 'GET', `/dms/${d.id}/messages?after=${ids[19]}&limit=5`)).json;
  assert.deepEqual(mid.messages.map((m) => m.id), ids.slice(20, 25));
  assert.deepEqual(mid.timerEvents.map((e) => e.id.replace(/[0-9a-f]{8}$/, '')), ['between']);
  assert.deepEqual((await as(b, 'GET', `/dms/${d.id}/messages?after=${ids[59]}`)).json.timerEvents, []);
});

// ------------------------------------------------------------------ sending
test('send: the deadline is stamped from the timer at send time; changing the timer later leaves sent messages alone; no timer, no deadline', async () => {
  useTimer('d:' + dm.id, DAY);
  const m = await sendD(alice, dm.id, { ttl: DAY });
  assert.equal(m.expiresAt, m.createdAt + DAY * 1000);
  assert.equal(srv.sql('SELECT expires_at FROM dm_messages WHERE id = ?', m.id)[0].expires_at, m.expiresAt);
  useTimer('d:' + dm.id, HOUR);
  useTimer('d:' + dm.id, 0);
  assert.equal(srv.sql('SELECT expires_at FROM dm_messages WHERE id = ?', m.id)[0].expires_at, m.expiresAt, 'not retroactive');
  const plain = await sendD(bob, dm.id, { ttl: 0 });
  assert.equal(plain.expiresAt, null);
  // Channels and group chats the same.
  useTimer('c:' + groupChat.id, WEEK);
  const g = await sendC(alice, groupChat.id, { ttl: WEEK });
  assert.equal(g.expiresAt, g.createdAt + WEEK * 1000);
  useTimer('c:' + groupChat.id, 0);
  // The DM list's newest message and the live copy carry it too.
  const sb = await sock(bob);
  const got = collect(sb, 'dm:message');
  useTimer('d:' + dm.id, HOUR);
  const m3 = await sendD(alice, dm.id, { ttl: HOUR });
  assert.ok(await until(() => got.length));
  assert.equal(got[0].message.expiresAt, m3.expiresAt);
  assert.equal(got[0].dm.disappear, HOUR);
  useTimer('d:' + dm.id, 0);
});

test('send: a ttl that doesn’t match the timer is refused (409 disappear_changed); no ttl (an older app) gets the timer; junk ttl is 400', async () => {
  useTimer('c:' + general.id, DAY);
  const stale = await as(bob, 'POST', `/channels/${general.id}/messages`, { ciphertext: cipher(), epoch: 1, ttl: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'disappear_changed');
  const older = await sendC(bob, general.id);
  assert.equal(older.expiresAt, older.createdAt + DAY * 1000, 'an app that sends no ttl gets the timer anyway');
  for (const ttl of ['86400', -5, 1.5, WEEKS4 + 1]) {
    const r = await as(bob, 'POST', `/channels/${general.id}/messages`, { ciphertext: cipher(), epoch: 1, ttl });
    assert.equal(r.status, 400, `${ttl}: ${r.text}`);
  }
  useTimer('d:' + dm.id, WEEK);
  const d = await as(bob, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher(), ttl: DAY });
  assert.equal(d.status, 409);
  assert.equal(d.json.code, 'disappear_changed');
  useTimer('d:' + dm.id, 0);
  useTimer('c:' + general.id, 0);
});

test('send: a thread reply never outlives the message that starts the thread, even with the timer off; an expired one takes no replies', async () => {
  useTimer('c:' + general.id, HOUR);
  const root = await sendC(bob, general.id, { ttl: HOUR });
  useTimer('c:' + general.id, WEEK);
  const r1 = await sendC(alice, general.id, { threadId: root.id, ttl: WEEK });
  assert.equal(r1.expiresAt, root.expiresAt, 'capped by the thread');
  useTimer('c:' + general.id, 0);
  const r2 = await sendC(alice, general.id, { threadId: root.id, ttl: 0 });
  assert.equal(r2.expiresAt, root.expiresAt, 'even when the channel no longer has a timer');
  expire(root.id);
  const late = await as(alice, 'POST', `/channels/${general.id}/messages`, { ciphertext: cipher(), epoch: 1, threadId: root.id, ttl: 0 });
  assert.equal(late.status, 404, late.text);
  assert.equal((await as(alice, 'GET', `/messages/${root.id}/thread`)).status, 404);
});

test('threads: the Threads list leaves out a thread whose first message has disappeared, and it can’t be marked read, even before the sweep', async () => {
  const c = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'threaded', type: 'text' })).json;
  useTimer('c:' + c.id, HOUR);
  const root = await sendC(bob, c.id, { ttl: HOUR });
  useTimer('c:' + c.id, 0);
  const keep = await sendC(bob, c.id, { ttl: 0 });
  const reply = await sendC(alice, c.id, { threadId: root.id, ttl: 0 });
  assert.equal(reply.expiresAt, root.expiresAt, 'capped by the thread');
  await sendC(alice, c.id, { threadId: keep.id, ttl: 0 });
  const listed = async () => (await as(bob, 'GET', `/channels/${c.id}/threads`)).json.threads.map((t) => t.rootId).sort();
  assert.deepEqual(await listed(), [root.id, keep.id].sort());
  assert.equal((await as(bob, 'POST', '/me/read', { conv: 't:' + root.id, messageId: reply.id })).status, 200);
  expire(root.id);
  assert.deepEqual(await listed(), [keep.id]);
  assert.equal((await as(bob, 'POST', '/me/read', { conv: 't:' + root.id, messageId: reply.id })).status, 404);
});

test('threads: a reply whose time has passed counts for nothing (replies, latest reply, who replied, unread, pings) and isn’t a read marker, even before the sweep', async () => {
  const c = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'replies', type: 'text' })).json;
  assert.equal((await as(bob, 'GET', '/me/unread')).status, 200); // bob's read baseline is from before these
  const root = await sendC(bob, c.id, { ttl: 0 });
  const first = await sendC(alice, c.id, { threadId: root.id, ttl: 0 });
  useTimer('c:' + c.id, HOUR);
  const gone = await sendC(carol, c.id, { threadId: root.id, ttl: HOUR, mentions: [bob.id] });
  useTimer('c:' + c.id, 0);
  const look = async () => {
    const list = (await as(bob, 'GET', `/channels/${c.id}/threads`)).json;
    const page = (await as(bob, 'GET', `/channels/${c.id}/messages`)).json;
    return { list, t: list.threads.find((x) => x.rootId === root.id), m: page.messages.find((x) => x.id === root.id), st: page.threads[root.id] };
  };
  let { list, t, m, st } = await look();
  assert.deepEqual([t.replyCount, t.lastReplyId, t.participants, t.unread, t.mentions, list.threadMentions], [2, gone.id, [carol.id, alice.id], 2, 1, 1]);
  assert.deepEqual([m.threadCount, st.lastId, st.unread, st.mentions], [2, gone.id, 2, 1]);
  expire(gone.id);
  ({ list, t, m, st } = await look());
  assert.deepEqual([t.replyCount, t.lastReplyId, t.lastReplyAt, t.participants, t.unread, t.mentions, list.threadMentions], [1, first.id, first.createdAt, [alice.id], 1, 0, 0]);
  assert.deepEqual([m.threadCount, m.threadLastAt, st.lastId, st.unread, st.mentions], [1, first.createdAt, first.id, 1, 0]);
  assert.equal((await as(bob, 'POST', '/me/read', { conv: 't:' + root.id, messageId: gone.id })).status, 404);
  const read = await as(bob, 'POST', '/me/read', { conv: 't:' + root.id, messageId: first.id });
  assert.equal(read.status, 200, read.text);
  assert.deepEqual([read.json.lastId, read.json.unread, read.json.mentions, read.json.threadMentions], [first.id, 0, 0, 0]);
  // A thread whose replies have all gone isn't listed (as after the sweep, which takes it out of thread_activity).
  expire(first.id);
  ({ t, m } = await look());
  assert.equal(t, undefined);
  assert.equal(m.threadCount, undefined);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE thread_id = ?', root.id)[0].n, 2, 'still in the database: only the deadline leaves them out');
});

// ------------------------------------------------------------------ never served after its time
test('an expired message can’t be edited, reacted to, pinned, voted on, saved, reported or located (404), even before the sweep; edits never move a deadline', async () => {
  useTimer('d:' + dm.id, HOUR);
  const d = await sendD(alice, dm.id, { ttl: HOUR });
  const e = await as(alice, 'PATCH', `/dm-messages/${d.id}`, { ciphertext: cipher() });
  assert.equal(e.status, 200, e.text);
  assert.equal(e.json.expiresAt, d.expiresAt, 'an edit keeps the deadline');
  useTimer('c:' + general.id, HOUR);
  const c = await sendC(bob, general.id, { ttl: HOUR });
  useTimer('c:' + general.id, 0);
  useTimer('d:' + dm.id, 0);
  // Saving works while it's there (the saved entry goes with it).
  assert.equal((await as(alice, 'PUT', `/me/saved/${c.id}`, {})).status, 200);
  expire(d.id); expire(c.id);
  const checks = [
    ['PATCH', `/dm-messages/${d.id}`, alice, { ciphertext: cipher() }],
    ['PATCH', `/messages/${c.id}`, bob, { ciphertext: cipher(), epoch: 1 }],
    ['POST', `/messages/${c.id}/reactions`, alice, { emoji: '👍' }],
    ['POST', `/messages/${d.id}/reactions`, bob, { emoji: '👍' }],
    ['POST', `/messages/${c.id}/pin`, boss, {}],
    ['POST', `/messages/${d.id}/pin`, alice, {}],
    ['POST', `/polls/${c.id}/vote`, alice, { choices: [0] }],
    ['GET', `/polls/${d.id}`, bob, undefined],
    ['PUT', `/me/saved/${d.id}`, bob, {}],
    ['GET', `/messages/${c.id}/locate`, alice, undefined],
    ['GET', `/messages/${d.id}/locate`, bob, undefined],
    ['POST', '/reports', alice, { category: 'spam', targetId: bob.id, context: { kind: 'message', messageId: c.id }, evidence: [{ id: c.id, text: 'x' }] }],
  ];
  for (const [method, p, u, body] of checks) {
    freshEpoch(space.id);
    const r = await as(u, method, p, body);
    assert.equal(r.status, 404, `${method} ${p}: ${r.status} ${r.text}`);
  }
});

test('moderation: an expired message can’t be deleted (by its author, a moderator or staff); bulk delete and a ban’s cleanup skip it; no audit entry is about it, even before the sweep', async () => {
  const c = (await as(boss, 'POST', `/servers/${space.id}/channels`, { name: 'modded', type: 'text' })).json;
  const spammer = await srv.register(`spam${hex(3)}`);
  assert.equal((await as(spammer, 'POST', `/invites/${inviteCode}/join`)).status, 200);
  const older = await sendC(spammer, c.id, { ttl: 0 });
  const newer = await sendC(spammer, c.id, { ttl: 0 });
  useTimer('c:' + c.id, HOUR);
  const gone1 = await sendC(spammer, c.id, { ttl: HOUR });
  const gone2 = await sendC(spammer, c.id, { ttl: HOUR });
  useTimer('c:' + c.id, 0);
  useTimer('d:' + dm.id, HOUR);
  const goneDm = await sendD(alice, dm.id, { ttl: HOUR });
  useTimer('d:' + dm.id, 0);
  expire(gone1.id); expire(gone2.id); expire(goneDm.id);
  const deletes = () => srv.sql("SELECT action, detail FROM server_audit WHERE server_id = ? AND channel_id = ? AND action IN ('message_delete', 'message_bulk_delete') ORDER BY seq", space.id, c.id);
  const there = (id) => srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', id)[0].n === 1;
  // One at a time: 404 for its author, a moderator, and staff; the DM too.
  for (const [u, p] of [[spammer, `/messages/${gone1.id}`], [boss, `/messages/${gone1.id}`], [boss, `/admin/messages/${gone1.id}`],
    [alice, `/dm-messages/${goneDm.id}`], [boss, `/admin/messages/${goneDm.id}`]]) {
    const r = await as(u, 'DELETE', p);
    assert.equal(r.status, 404, `DELETE ${p}: ${r.status} ${r.text}`);
  }
  // In bulk, picked by id: nothing left to delete, and nothing logged.
  let r = await as(boss, 'POST', `/channels/${c.id}/messages/bulk-delete`, { ids: [gone1.id, gone2.id] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.deleted, r.json.kept], [0, 0]);
  assert.deepEqual(deletes(), []);
  // The most recent one: the newest message still there, not the expired ones after it.
  r = await as(boss, 'POST', `/channels/${c.id}/messages/bulk-delete`, { count: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deleted, 1);
  assert.ok(!there(newer.id) && there(older.id));
  const logged = deletes();
  assert.deepEqual(logged.map((x) => [x.action, JSON.parse(x.detail).count]), [['message_bulk_delete', 1]]);
  // A ban's cleanup takes what's still there and counts only that.
  r = await as(boss, 'POST', `/servers/${space.id}/bans`, { userId: spammer.id, deleteHours: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deleted, 1);
  assert.ok(!there(older.id));
  const ban = srv.sql("SELECT detail FROM server_audit WHERE server_id = ? AND action = 'member_ban' AND target_id = ?", space.id, spammer.id);
  assert.equal(JSON.parse(ban[0].detail).count, 1);
  // The expired ones are the sweep's (still in the database: it isn't running on this server).
  assert.ok(there(gone1.id) && there(gone2.id));
  assert.equal(srv.sql('SELECT COUNT(*) n FROM dm_messages WHERE id = ?', goneDm.id)[0].n, 1);
});

test('serve: with the sweep paused, an expired message is in no history page, thread, pin list, search, saved list, export, reply quote or preview', async () => {
  useTimer('d:' + dm.id, HOUR);
  const keep = await sendD(bob, dm.id, { ttl: HOUR });
  const gone = await sendD(alice, dm.id, { ttl: HOUR });
  const reply = await sendD(bob, dm.id, { ttl: HOUR, replyTo: gone.id });
  assert.equal(reply.reply.id, gone.id);
  await as(alice, 'POST', `/messages/${gone.id}/pin`, {});
  assert.equal((await as(bob, 'PUT', `/me/saved/${gone.id}`, {})).status, 200);
  useTimer('d:' + dm.id, 0);
  useTimer('c:' + groupChat.id, HOUR);
  const gLast = await sendC(alice, groupChat.id, { ttl: HOUR });
  useTimer('c:' + groupChat.id, 0);
  expire(gone.id); expire(gLast.id);
  const ids = (list) => list.map((m) => m.id);
  const hist = (await as(bob, 'GET', `/dms/${dm.id}/messages`)).json.messages;
  assert.ok(!ids(hist).includes(gone.id) && ids(hist).includes(keep.id));
  assert.equal(hist.find((m) => m.id === reply.id).reply, null, 'the quote is gone too');
  assert.ok(!ids((await as(bob, 'GET', `/dms/${dm.id}/messages?around=${gone.id}`)).json.messages).includes(gone.id));
  assert.ok(!ids((await as(bob, 'GET', `/dms/${dm.id}/pins`)).json).includes(gone.id));
  const found = (await as(bob, 'GET', `/search/messages?scope=d:${dm.id}`)).json.messages;
  assert.ok(ids(found).includes(keep.id) && !ids(found).includes(gone.id), 'search');
  assert.ok(!ids((await as(bob, 'GET', '/search/messages')).json.messages).includes(gone.id), 'search everywhere');
  const saved = (await as(bob, 'GET', '/me/saved')).json.items.find((x) => x.messageId === gone.id);
  assert.ok(!saved || !saved.message, 'saved shows it as unavailable');
  // The DM list's preview and a group's newest message skip it.
  const boot = (await as(bob, 'GET', '/bootstrap')).json;
  assert.notEqual(boot.dms.find((x) => x.id === dm.id).last.id, gone.id);
  const g = boot.servers.find((s) => s.id === group.id);
  assert.ok(!g.last || g.last.id !== gLast.id, 'group preview');
  // Export: password step first (the export token), then pages without it.
  const ex = await as(bob, 'POST', '/me/export', { authKey: bob.authKey });
  assert.equal(ex.status, 200, ex.text);
  const page = await srv.api('GET', `/me/export/messages?conv=d:${dm.id}`, { token: bob.token, ip: bob.ip, headers: { 'x-export-token': ex.json.token } });
  assert.equal(page.status, 200, page.text);
  assert.ok(ids(page.json.messages).includes(keep.id) && !ids(page.json.messages).includes(gone.id), 'export');
  // Still in the database: the sweep isn't running on this server. Only the deadline keeps it out.
  assert.equal(srv.sql('SELECT COUNT(*) n FROM dm_messages WHERE id = ?', gone.id)[0].n, 1);
});

test('uploads: a disappearing message’s file is served with no-store, and is 404 once its time has passed (before the sweep)', async () => {
  const url = await upload(alice, crypto.randomBytes(3000));
  const plainUrl = await upload(alice, crypto.randomBytes(3000));
  useTimer('d:' + dm.id, HOUR);
  const m = await sendD(alice, dm.id, { ttl: HOUR, files: [url] });
  useTimer('d:' + dm.id, 0);
  await sendD(alice, dm.id, { ttl: 0, files: [plainUrl] });
  let r = await srv.call('GET', url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await srv.call('GET', plainUrl)).headers.get('cache-control'), 'private, no-cache', 'other files as before');
  expire(m.id);
  r = await srv.call('GET', url);
  assert.equal(r.status, 404);
});

test('source: every place that stores a message stamps its deadline', () => {
  const dir = path.join(__dirname, '..', 'server');
  const inserts = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(messages|dm_messages)\s*\(([^)]*)\)/g)) inserts.push({ f, table: m[1], cols: m[2] });
  }
  assert.ok(inserts.length >= 4, `found ${inserts.length}`);
  for (const x of inserts) assert.match(x.cols, /\bexpires_at\b/, `${x.f}: INSERT INTO ${x.table} without expires_at`);
});

test('the sweep and the serving filter use their indexes (never a scan of the message tables)', () => {
  const d = srv.db();
  try {
    const plan = (q, ...a) => d.prepare('EXPLAIN QUERY PLAN ' + q).all(...a).map((r) => r.detail).join(' | ');
    const ids = '["a","b"]';
    const plans = {
      due: plan('SELECT id, channel_id, thread_id, author_id FROM messages WHERE expires_at <= ? ORDER BY expires_at LIMIT ?', 1, 500),
      dueDm: plan('SELECT id, dm_id, author_id FROM dm_messages WHERE expires_at <= ? ORDER BY expires_at LIMIT ?', 1, 500),
      next: plan('SELECT MIN(t) AS t FROM (SELECT MIN(expires_at) AS t FROM messages WHERE expires_at IS NOT NULL UNION ALL SELECT MIN(expires_at) AS t FROM dm_messages WHERE expires_at IS NOT NULL)'),
      replies: plan('SELECT id FROM messages WHERE thread_id IN (SELECT value FROM json_each(?))', ids),
      saved: plan('DELETE FROM saved_messages WHERE message_id IN (SELECT value FROM json_each(?))', ids),
      pinLog: plan('DELETE FROM pin_log WHERE message_id IN (SELECT value FROM json_each(?))', ids),
      blobs: plan('DELETE FROM blobs WHERE message_id IN (SELECT value FROM json_each(?))', ids),
      page: plan('SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT ?', 'c', 1, 50),
      pageDm: plan('SELECT * FROM dm_messages WHERE dm_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT ?', 'd', 1, 50),
      log: plan('SELECT * FROM disappear_log WHERE conv = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?', 'c:x', 0, 1, 50),
    };
    for (const [k, v] of Object.entries(plans)) assert.doesNotMatch(v, /\bSCAN (messages|dm_messages|saved_messages|pin_log|blobs|disappear_log)\b/, `${k}: ${v}`);
    assert.match(plans.due, /idx_messages_expires/);
    assert.match(plans.dueDm, /idx_dm_messages_expires/);
    assert.match(plans.next, /COVERING INDEX idx_messages_expires/);
    assert.match(plans.saved, /idx_saved_messages_message/);
    assert.match(plans.pinLog, /idx_pin_log_message/);
    assert.match(plans.page, /idx_messages_channel_top/);
  } finally { d.close(); }
});

test('bots: a bot’s post follows the channel timer; the bot API carries expiresAt and never lists an expired message', async () => {
  const b = await as(boss, 'POST', '/bots', { name: `tick${hex(2)}`, description: 'timer test bot', scopes: ['messages.send', 'messages.read.metadata'], listed: false });
  assert.equal(b.status, 200, b.text);
  const inst = await as(boss, 'POST', `/servers/${space.id}/bots`, { botId: b.json.bot.id, scopes: ['messages.send', 'messages.read.metadata'], channels: [general.id], confirm: true });
  assert.equal(inst.status, 200, inst.text);
  const bot = (method, p, body) => srv.call(method, '/api/bot/v1' + p, { body, headers: { authorization: `Bot ${b.json.token}` } });
  useTimer('c:' + general.id, DAY);
  const posted = await bot('POST', `/channels/${general.id}/messages`, { content: 'hello from a bot' });
  assert.equal(posted.status, 200, posted.text);
  const row = srv.sql('SELECT created_at, expires_at FROM messages WHERE id = ?', posted.json.message.messageId)[0];
  assert.equal(row.expires_at, row.created_at + DAY * 1000);
  assert.equal(posted.json.message.expiresAt, row.expires_at);
  useTimer('c:' + general.id, 0);
  expire(posted.json.message.messageId);
  const list = await bot('GET', `/channels/${general.id}/messages`);
  assert.equal(list.status, 200, list.text);
  assert.ok(!list.json.messages.some((m) => m.messageId === posted.json.message.messageId));
  assert.equal((await bot('PATCH', `/messages/${posted.json.message.messageId}`, { content: 'edited' })).status, 404);
});

// ------------------------------------------------------------------ the sweep (a server where it runs every 200 ms)
test('sweep: deletes expired messages with their files, reactions, poll votes, mention marks, saved entries and pin history, tells open apps with the usual delete events, and frees storage', async () => {
  const s = await startServer({ DISAPPEAR_SWEEP_MS: '200', DISAPPEAR_CHECKPOINT_MS: '0' });
  try {
    const { b, a, c, sp, general: g, d } = await people(s);
    const sa = await sock(a, s); const sc = await sock(c, s);
    const bulk = collect(sa, 'message:delete-bulk'); const threads = collect(sa, 'thread:update');
    const dmDel = collect(sc, 'dm:delete'); const savedEv = collect(sc, 'saved:update');
    // A channel message with a file, a reaction, a pin, a poll vote, a mention and a save; a thread under another one.
    const file = await upload(a, crypto.randomBytes(20000), s);
    const usedBefore = (await as(a, 'GET', '/me/storage', undefined, s)).json.used;
    assert.ok(usedBefore >= 20000);
    await setTimer(b, 'c:' + g.id, HOUR, s);
    const m = await sendC(a, g.id, { ttl: HOUR, files: [file], mentions: [c.id] }, s);
    const root = await sendC(c, g.id, { ttl: HOUR }, s);
    await setTimer(b, 'c:' + g.id, 0, s);
    const keepRoot = await sendC(c, g.id, { ttl: 0 }, s);
    const reply = await sendC(a, g.id, { threadId: root.id, ttl: 0 }, s);
    const replyOfKeep = await sendC(a, g.id, { threadId: keepRoot.id, ttl: 0 }, s);
    s.sql('UPDATE messages SET expires_at = ? WHERE id = ?', Date.now() + 60 * 60000, replyOfKeep.id); // a reply that goes on its own
    assert.equal((await as(c, 'POST', `/messages/${m.id}/reactions`, { emoji: '🔥' }, s)).status, 200);
    assert.equal((await as(b, 'POST', `/messages/${m.id}/pin`, {}, s)).status, 200);
    assert.equal((await as(c, 'POST', `/polls/${m.id}/vote`, { choices: [1] }, s)).status, 200);
    assert.equal((await as(c, 'PUT', `/me/saved/${m.id}`, {}, s)).status, 200);
    assert.equal(s.sql('SELECT COUNT(*) n FROM mention_marks WHERE message_id = ?', m.id)[0].n, 1);
    // A DM.
    await setTimer(a, 'd:' + d.id, HOUR, s);
    const dmsg = await sendD(a, d.id, { ttl: HOUR }, s);
    await setTimer(a, 'd:' + d.id, 0, s);
    const dmKeep = await sendD(c, d.id, { ttl: 0 }, s);
    // Their time comes.
    const [bulk0, threads0, saved0] = [bulk.length, threads.length, savedEv.length];
    const auditRows = () => s.sql('SELECT COUNT(*) n FROM server_audit WHERE server_id = ?', sp.id)[0].n;
    const audit0 = auditRows();
    const past = Date.now() - 10;
    s.sql('UPDATE messages SET expires_at = ? WHERE id IN (?, ?, ?)', past, m.id, root.id, replyOfKeep.id);
    s.sql('UPDATE dm_messages SET expires_at = ? WHERE id = ?', past, dmsg.id);
    assert.ok(await until(() => s.sql('SELECT COUNT(*) n FROM messages WHERE id IN (?, ?, ?, ?)', m.id, root.id, reply.id, replyOfKeep.id)[0].n === 0
      && s.sql('SELECT COUNT(*) n FROM dm_messages WHERE id = ?', dmsg.id)[0].n === 0), 'the sweep deleted them');
    // Nobody deleted them: the server's audit log gets nothing (no message_delete or message_bulk_delete, no one blamed).
    assert.equal(auditRows(), audit0, 'no server audit entry for the sweep');
    const ids = JSON.stringify([m.id, root.id, reply.id, dmsg.id]);
    for (const t of ['blobs', 'reactions', 'poll_votes', 'poll_closed', 'mention_marks', 'saved_messages', 'pin_log']) {
      assert.equal(s.sql(`SELECT COUNT(*) n FROM ${t} WHERE message_id IN (SELECT value FROM json_each(?))`, ids)[0].n, 0, t);
    }
    assert.equal(s.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', keepRoot.id)[0].n, 1, 'others stay');
    assert.equal(s.sql('SELECT COUNT(*) n FROM dm_messages WHERE id = ?', dmKeep.id)[0].n, 1);
    assert.equal((await s.call('GET', file)).status, 404, 'the file is gone');
    assert.ok(await until(async () => (await as(a, 'GET', '/me/storage', undefined, s)).json.used <= usedBefore - 20000), 'storage freed');
    // Open apps heard about it like any delete.
    assert.ok(await until(() => bulk.length > bulk0 && dmDel.length && savedEv.length > saved0 && threads.length > threads0));
    const sweptBulk = bulk.slice(bulk0);
    const all = sweptBulk.flatMap((x) => x.messages.map((y) => y.id));
    for (const id of [m.id, root.id, reply.id, replyOfKeep.id]) assert.ok(all.includes(id), `message:delete-bulk has ${id}`);
    assert.ok(sweptBulk.every((x) => x.expired === true && x.channelId === g.id));
    assert.deepEqual(dmDel.map((x) => [x.id, x.dmId, x.expired]), [[dmsg.id, d.id, true]]);
    assert.equal(dmDel[0].last.id, dmKeep.id, 'with the DM’s new newest message');
    assert.deepEqual(savedEv.slice(saved0), [{ messageId: m.id, saved: false }]);
    const t = threads.slice(threads0).find((x) => x.rootId === keepRoot.id);
    assert.ok(t, 'the surviving thread gets its new count');
    assert.equal(t.threadCount, 0);
    assert.ok(!threads.slice(threads0).some((x) => x.rootId === root.id), 'a thread that went with its first message gets no count');
    // A group chat's apps also get its new newest message, for the conversation list.
    const grp = (await as(a, 'POST', '/groups', { userIds: [c.id] }, s)).json;
    const gch = grp.channels.find((x) => x.type === 'text');
    const before0 = await sendC(c, gch.id, {}, s);
    await setTimer(c, 'c:' + gch.id, HOUR, s);
    const goes = await sendC(a, gch.id, { ttl: HOUR }, s);
    const n0 = bulk.length;
    s.sql('UPDATE messages SET expires_at = ? WHERE id = ?', Date.now() - 10, goes.id);
    assert.ok(await until(() => bulk.length > n0));
    const ev = bulk[bulk.length - 1];
    assert.deepEqual(ev.messages.map((x) => x.id), [goes.id]);
    assert.equal(ev.last.id, before0.id);
    assert.deepEqual(s.sql("SELECT action FROM server_audit WHERE action IN ('message_delete', 'message_bulk_delete')"), [], 'anywhere');
  } finally { await s.stop(); }
});

test('sweep: a backlog is cleared in batches while the server keeps answering; messages that expired while it was stopped are gone before the first request', async () => {
  const s = await startServer({ DISAPPEAR_SWEEP_MS: '3600000' }); // off while the backlog is written
  try {
    const { a, c, general: g, d } = await people(s);
    const seed = await sendC(a, g.id, {}, s);
    // 6,000 expired messages written straight into the database (as if the server had been down a while), plus
    // a reply in a thread whose first message is among them.
    const db = s.db();
    try {
      const past = Date.now() - 60000;
      const ins = db.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at, expires_at) VALUES (?, ?, ?, \'\', ?, 1, ?, ?)');
      const insD = db.prepare('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
      db.transaction(() => {
        for (let i = 0; i < 5000; i++) ins.run(`bk${String(i).padStart(6, '0')}${hex(3)}`, g.id, a.id, cipher(), past - 1000, past);
        for (let i = 0; i < 1000; i++) insD.run(`bd${String(i).padStart(6, '0')}${hex(3)}`, d.id, c.id, cipher(), past - 1000, past);
      })();
    } finally { db.close(); }
    await s.restart({ DISAPPEAR_SWEEP_MS: '1500' });
    // The start-up sweep ran before the server listened: nothing expired is left by the first request.
    assert.equal(s.sql('SELECT COUNT(*) n FROM messages WHERE expires_at IS NOT NULL')[0].n, 0);
    assert.equal(s.sql('SELECT COUNT(*) n FROM dm_messages WHERE expires_at IS NOT NULL')[0].n, 0);
    assert.equal(s.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', seed.id)[0].n, 1);
    // A second backlog while running: health answers quickly throughout.
    const db2 = s.db();
    try {
      const past = Date.now() - 1000;
      const ins = db2.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at, expires_at) VALUES (?, ?, ?, \'\', ?, 1, ?, ?)');
      db2.transaction(() => { for (let i = 0; i < 8000; i++) ins.run(`bl${String(i).padStart(6, '0')}${hex(3)}`, g.id, a.id, cipher(), past - 1000, past); })();
    } finally { db2.close(); }
    // The sweep (every 1.5 s here) works through it 500 at a time, letting requests in between.
    const slow = [];
    const done = until(() => s.sql('SELECT COUNT(*) n FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?', Date.now() - 500)[0].n === 0, 20000);
    for (let i = 0; i < 30; i++) {
      const t0 = Date.now();
      assert.equal((await s.call('GET', '/api/health/live')).status, 200);
      slow.push(Date.now() - t0);
      await sleep(100);
    }
    assert.ok(await done, 'the backlog is cleared');
    assert.ok(Math.max(...slow) < 1500, `health answered within ${Math.max(...slow)} ms`);
  } finally { await s.stop(); }
});

test('forensics: after the sweep, a marker that was inside an expired message is nowhere in hearth.db or hearth.db-wal', async () => {
  const s = await startServer({ DISAPPEAR_SWEEP_MS: '200', DISAPPEAR_CHECKPOINT_MS: '0' });
  try {
    const { a, d } = await people(s);
    const marker = `MARK${hex(12)}`;
    await setTimer(a, 'd:' + d.id, 5, s);
    const m = await sendD(a, d.id, { ttl: 5, ciphertext: cipher(marker) }, s);
    const files = () => ['hearth.db', 'hearth.db-wal'].map((f) => path.join(s.dir, f)).filter((f) => fs.existsSync(f));
    const holds = () => files().some((f) => fs.readFileSync(f).includes(Buffer.from(marker)));
    assert.ok(holds(), 'the marker is in the files while the message exists');
    assert.ok(await until(() => s.sql('SELECT COUNT(*) n FROM dm_messages WHERE id = ?', m.id)[0].n === 0, 12000), 'deleted at its time');
    assert.ok(await until(() => !holds(), 5000), 'no copy of its bytes is left in the database or its WAL');
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ the app's side (public/js/disappear.js)
let D;
before(async () => { D = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'disappear.js')).href); });

test('app: a message goes at the earlier of the server’s deadline and its own timer; no timer means never', () => {
  const t = 1_000_000;
  assert.equal(D.deadline({ createdAt: t }), Infinity);
  assert.equal(D.deadline({ createdAt: t, expiresAt: t + 5000 }), t + 5000);
  assert.equal(D.deadline({ createdAt: t, dec: { x: 3600 } }), t + 3600000, 'a server that dropped the deadline doesn’t keep it on screen');
  assert.equal(D.deadline({ createdAt: t, expiresAt: t + 9e9, dec: { x: 3600 } }), t + 3600000, 'nor one that moved it later');
  assert.equal(D.deadline({ createdAt: t, expiresAt: t + 1000, dec: { x: 3600 } }), t + 1000);
  assert.equal(D.expired({ createdAt: t, expiresAt: t + 1000 }, t + 1000), true);
  assert.equal(D.expired({ createdAt: t, expiresAt: t + 1000 }, t + 999), false);
  assert.equal(D.disappears({ createdAt: t }), false);
  assert.equal(D.deadline({ createdAt: t, dec: { x: 1e12 } }), Infinity, 'a timer past 4 weeks inside the message is ignored');
});

test('app: serverKept flags a message the server kept past its sender’s timer (a minute’s slack)', () => {
  const t = 5_000_000;
  assert.equal(D.serverKept({ createdAt: t, expiresAt: t + 3600000, dec: { x: 3600 } }), false);
  assert.equal(D.serverKept({ createdAt: t, expiresAt: t + 3600000 + 30000, dec: { x: 3600 } }), false);
  assert.equal(D.serverKept({ createdAt: t, expiresAt: t + 3600000 + 120000, dec: { x: 3600 } }), true);
  assert.equal(D.serverKept({ createdAt: t, dec: { x: 3600 } }), true, 'no deadline at all');
  assert.equal(D.serverKept({ createdAt: t, expiresAt: t + 1000 }), false, 'no timer inside');
});

test('app: nextDeadline skips messages without one and those already past; waitFor stays between 250 ms and an hour', () => {
  const now = 10_000;
  assert.equal(D.nextDeadline([{ createdAt: 0 }, { createdAt: 0, expiresAt: 9000 }, { createdAt: 0, expiresAt: 50000 }, { createdAt: 0, expiresAt: 20000 }], now), 20000);
  assert.equal(D.nextDeadline([{ createdAt: 0 }], now), null);
  assert.equal(D.waitFor(now + 10, now), 250);
  assert.equal(D.waitFor(now + 5000, now), 5000);
  assert.equal(D.waitFor(now + 28 * 86400000, now), 3600000, 'never past setTimeout’s limit');
  assert.equal(D.waitFor(now - 5000, now), 250);
});

test('app: the timer lines read "turned on: 1 week", "changed to 1 day", "turned off", with You and Someone', () => {
  const name = (id) => ({ u1: 'Alice' })[id] || null;
  assert.equal(D.sysLineText({ by: 'u1', secs: WEEK, prev: 0 }, 'me', name), 'Alice turned on disappearing messages: 1 week');
  assert.equal(D.sysLineText({ by: 'me', secs: DAY, prev: WEEK }, 'me', name), 'You changed disappearing messages to 1 day');
  assert.equal(D.sysLineText({ by: 'u9', secs: 0, prev: DAY }, 'me', name), 'Someone turned off disappearing messages');
  assert.equal(D.sysLineText({ by: null, secs: HOUR, prev: 0 }, 'me', name), 'Someone turned on disappearing messages: 1 hour');
  assert.deepEqual([0, HOUR, DAY, WEEK, WEEKS4, 5].map(D.label), ['Off', '1 hour', '1 day', '1 week', '4 weeks', '5 seconds']);
  assert.equal(D.remaining(30000), 'in less than a minute');
  assert.equal(D.remaining(5 * 3600000), 'in 5 hours');
  assert.equal(D.remaining(3 * 86400000), 'in 3 days');
});

test('app: the timer inside a message counts only when it’s one of the offered choices (a modified app can’t pick 8 seconds)', () => {
  for (const v of [HOUR, DAY, WEEK, WEEKS4]) assert.equal(D.cleanX(v), v);
  for (const v of [1, 5, 8, 60, HOUR + 1, 0, -1, 1.5, WEEKS4 + 1, '3600', null, undefined, NaN, Infinity, {}]) assert.equal(D.cleanX(v), undefined, String(v));
  assert.equal(D.deadline({ createdAt: 1000, dec: { x: 8 } }), Infinity, 'an 8-second timer inside the message is ignored');
  assert.equal(D.serverKept({ createdAt: 1000, dec: { x: 8 } }), false);
  // The server's own list (/config; under test it has 5 seconds); junk in it is ignored, an empty one changes nothing.
  try {
    D.setChoices([0, 5, HOUR, DAY, WEEK, WEEKS4, -3, 1.5, 'x', WEEKS4 * 2]);
    assert.equal(D.cleanX(5), 5);
    assert.equal(D.cleanX(WEEKS4 * 2), undefined);
    D.setChoices([]);
    D.setChoices('junk');
    assert.equal(D.cleanX(5), 5);
  } finally { D.setChoices([HOUR, DAY, WEEK, WEEKS4]); }
  assert.equal(D.cleanX(5), undefined);
});

test('app: a timer turned off or made longer after a message was written is weaker (the app asks before sending); on or shorter isn’t', () => {
  assert.equal(D.weaker(HOUR, 0), true, 'turned off');
  assert.equal(D.weaker(HOUR, DAY), true, 'made longer');
  assert.equal(D.weaker(HOUR, HOUR), false);
  assert.equal(D.weaker(DAY, HOUR), false, 'made shorter: sent with it');
  assert.equal(D.weaker(0, HOUR), false, 'turned on: sent with it');
  assert.equal(D.weaker(0, 0), false);
  assert.equal(D.weaker(undefined, 0), false);
});

test('app: a scheduled message re-encrypted later keeps the stricter of the timer it was written under and the one now', () => {
  assert.equal(D.stricter(HOUR, 0), HOUR, 'turned off since: the one it was written under stays');
  assert.equal(D.stricter(HOUR, DAY), HOUR, 'made longer since: the same');
  assert.equal(D.stricter(DAY, HOUR), HOUR, 'made shorter: the new one');
  assert.equal(D.stricter(0, HOUR), HOUR, 'turned on: the new one');
  assert.equal(D.stricter(HOUR, HOUR), HOUR);
  assert.equal(D.stricter(0, 0), 0);
  assert.equal(D.stricter(undefined, 0), 0);
  assert.equal(D.stricter(undefined, HOUR), HOUR);
});

// ------------------------------------------------------------------ who changed the timer (the line in the conversation)
// Someone whose display name or nickname is "You" (or reads as it) mustn't make the line look like your own change:
// "You" is only ever for the entry's user id being yours; such a name gets their @username after it.
test('app: the timer line says "You" only for your own change; a name that reads as "You" gets its @username', () => {
  const names = { p1: 'You', p2: 'Alice', p3: 'y o u', p4: 'You (admin)', p5: 'Yоu', p6: 'Youssef' };
  const nameOf = (id) => names[id] || null;
  const handleOf = (id) => ({ p1: 'mallory', p3: 'eve', p4: 'trent', p5: 'oscar', p6: 'youssef' })[id] || null;
  for (const [secs, prev] of [[0, HOUR], [HOUR, 0], [DAY, HOUR]]) {
    const own = D.sysLineText({ by: 'me', secs, prev }, 'me', nameOf, handleOf);
    const theirs = D.sysLineText({ by: 'p1', secs, prev }, 'me', nameOf, handleOf);
    assert.match(own, /^You (turned|changed)/);
    assert.notEqual(theirs, own, 'a partner named "You" doesn’t read like your own change');
    assert.equal(theirs, own.replace(/^You /, 'You (@mallory) '));
  }
  assert.equal(D.sysLineText({ by: 'p3', secs: 0, prev: HOUR }, 'me', nameOf, handleOf), 'y o u (@eve) turned off disappearing messages');
  assert.equal(D.sysLineText({ by: 'p4', secs: 0, prev: HOUR }, 'me', nameOf, handleOf), 'You (admin) (@trent) turned off disappearing messages');
  assert.equal(D.sysLineText({ by: 'p5', secs: 0, prev: HOUR }, 'me', nameOf, handleOf), 'Yоu (@oscar) turned off disappearing messages', 'look-alike letters');
  assert.equal(D.sysLineText({ by: 'p1', secs: 0, prev: HOUR }, 'me', nameOf), 'Someone turned off disappearing messages', 'no @username known: not the name');
  assert.equal(D.sysLineText({ by: 'p2', secs: 0, prev: HOUR }, 'me', nameOf, handleOf), 'Alice turned off disappearing messages', 'other names as they are');
  assert.equal(D.sysLineText({ by: 'p6', secs: 0, prev: HOUR }, 'me', nameOf, handleOf), 'Youssef turned off disappearing messages');
  const parts = D.sysLineParts({ by: 'p1', secs: 0, prev: HOUR }, 'me', nameOf, handleOf);
  assert.deepEqual(parts, { self: false, who: 'You', handle: 'mallory', action: 'turned off disappearing messages' });
  assert.equal(D.sysLineParts({ by: 'me', secs: 0, prev: HOUR }, 'me', nameOf, handleOf).self, true);
  for (const n of ['You', 'YOU', ' you ', 'Y.o.u', 'Y​ou', 'Yóu', 'Ｙｏｕ', 'Y0U', 'You!']) assert.equal(D.readsAsYou(n), true, n);
  for (const n of ['Young', 'Yousef', 'Your friend', 'Alice', '', null]) assert.equal(D.readsAsYou(n), false, String(n));
  // The app draws the line from those parts: the built-in "You" for yours, anyone else's name in its own element.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const el = app.slice(app.indexOf('function sysLineEl('), app.indexOf('\n}\n', app.indexOf('function sysLineEl(')));
  assert.match(el, /sysLineParts\(e, S\.me\.id,/);
  assert.match(el, /p\.self \? h\('span', \{ class: 'sys-you' \}, 'You'\)/);
  assert.match(el, /h\('bdi', \{ class: 'sys-who'/);
});

// Look-alikes are matched before lower-casing (a capital Greek upsilon reads as Y, its small letter as u) and every
// default-ignorable character goes, Hangul fillers included (letters to Unicode, but they draw nothing). And as no list
// of look-alikes is complete, anyone else's @username follows any name that isn't simply that username.
test('app: a name made of a capital upsilon, a Hangul filler or a look-alike no list has still never reads as your own change', () => {
  for (const n of ['Υou', 'ΥΟU', 'Υοu', 'Υоս', 'Youㅤ', 'ㅤYou', 'Yᅟou', 'Youﾠ', 'Yᅠou', 'ϒou', 'Үou', 'Ꭹou', 'ʏᴏᴜ', 'You⠀']) {
    assert.equal(D.readsAsYou(n), true, JSON.stringify(n));
  }
  for (const n of ['Υoung', 'Youssef', 'bob']) assert.equal(D.readsAsYou(n), false, n);
  const names = { p1: 'Υou', p2: 'Youㅤ', p3: 'ꓬou', p4: 'Alice', p5: 'bob', p6: 'You', p7: 'Bob' };
  const handles = { p1: 'mallory', p2: 'eve', p3: 'trudy', p4: 'alice_w', p5: 'bob', p6: 'You', p7: 'bob' };
  const line = (by, handleOf = (id) => handles[id]) => D.sysLineText({ by, secs: 0, prev: HOUR }, 'me', (id) => names[id], handleOf);
  const own = line('me');
  assert.equal(own, 'You turned off disappearing messages');
  for (const by of ['p1', 'p2', 'p3', 'p4', 'p6']) {
    const theirs = line(by);
    assert.notEqual(theirs, own);
    assert.equal(theirs, `${names[by]} (@${handles[by]}) turned off disappearing messages`, by);
  }
  assert.equal(line('p5'), 'bob turned off disappearing messages', 'a name that is just the username needs no @username');
  assert.equal(line('p7'), 'Bob turned off disappearing messages', 'nor one that differs from it only in case');
  assert.equal(line('p1', () => null), 'Someone turned off disappearing messages', 'no @username known: not a name that reads as "You"');
  assert.equal(line('p2', () => null), 'Someone turned off disappearing messages');
});

// ------------------------------------------------------------------ copies of a message's words kept on the device
// The app's inbox (app.js addInbox / purgeInbox, run here from its own source) and reminders (features.js), with a
// localStorage and a page small enough for Node.
function fakePage() {
  const ls = new Map();
  const saved = { localStorage: globalThis.localStorage, document: globalThis.document, window: globalThis.window, Node: globalThis.Node };
  globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k),
    key: (i) => [...ls.keys()][i] ?? null, get length() { return ls.size; },
  };
  class N {
    constructor(t) { this.tag = t; this.children = []; this.attrs = {}; this.style = { setProperty() {} }; this.dataset = {}; this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false }; this.removed = false; }
    append(...k) { this.children.push(...k); }
    appendChild(k) { this.children.push(k); return k; }
    setAttribute(k, v) { this.attrs[k] = v; }
    hasAttribute(k) { return k in this.attrs; }
    addEventListener() {}
    removeEventListener() {}
    remove() { this.removed = true; }
    get firstChild() { return this.children[0] || null; }
    set innerHTML(v) { this.html = v; }
  }
  globalThis.Node = N;
  const body = new N('body');
  globalThis.document = { createElement: (t) => new N(t), createTextNode: (s) => ({ s }), body, getElementById: () => new N('div'), querySelector: () => null, addEventListener() {} };
  globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } };
  return { ls, body, restore };
}
const appSrc = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const fnSrc = (src, name) => { const i = src.search(new RegExp(`\\n(async )?function ${name}\\(`)); assert.ok(i > 0, name); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
// addInbox and purgeInbox as app.js has them, over the same storage key (hearth.inbox.<account>).
function inboxOf(S, now) {
  const src = appSrc();
  const mine = (k) => `hearth.${k}.${S.me.id}`;
  const P = {
    get inbox() { try { return JSON.parse(localStorage.getItem(mine('inbox')) || '[]'); } catch { return []; } },
    set inbox(v) { localStorage.setItem(mine('inbox'), JSON.stringify(v.slice(0, 200))); },
  };
  return new Function('P', 'S', 'nowServer', 'updateTitle', 'armClientExpiry', 'loggingOut', `${fnSrc(src, 'addInbox')}\n${fnSrc(src, 'purgeInbox')}\nreturn { addInbox, purgeInbox };`)(P, S, now, () => {}, () => {}, null);
}
// The text inside a fake element and its children.
const textIn = (n) => (n == null ? '' : typeof n === 'string' ? n : n.s != null ? String(n.s) : (n.children || []).map(textIn).join(''));

test('app: a reminder on a disappearing message copies its words with the message’s deadline, and they go with it (app closed at the deadline)', async () => {
  const page = fakePage();
  const realNow = Date.now; const realInterval = globalThis.setInterval;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  globalThis.setInterval = () => 0;
  try {
    const F = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'features.js')).href);
    const S = { me: { id: 'alice' } };
    const app = inboxOf(S, () => clock);
    const notes = [];
    F.initFeatures({ S, nowServer: () => clock, addInbox: app.addInbox, notify: (n) => notes.push(n), playSound() {}, displayName: () => 'Bob', getUser: () => ({ id: 'bob' }), jump() {} });
    // Bob's message in a DM with a 1-day timer; Alice asks to be reminded in an hour.
    const words = 'the safe combination is 31-07-44';
    const m = { id: 'm1', authorId: 'bob', dmId: 'd1', createdAt: clock, expiresAt: clock + DAY * 1000, dec: { t: words, x: DAY } };
    F.remindItems(m, 'd:d1', words).filter(Boolean).find((x) => /1 hour/.test(x.label)).action();
    assert.equal(JSON.parse(page.ls.get('hearth.reminders.alice'))[0].exp, m.expiresAt);
    // It fires an hour later, with the app open.
    clock += HOUR * 1000 + 1000;
    F.startReminders();
    const entry = JSON.parse(page.ls.get('hearth.inbox.alice'))[0];
    assert.equal(entry.type, 'reminder');
    assert.equal(entry.exp, m.expiresAt, 'the inbox copy carries the message’s deadline');
    assert.deepEqual(notes[0], { title: 'Reminder', body: `Bob: ${words}`, tag: 'reminder:m1', msgId: 'm1' }, 'its notification is tied to the message, so it closes when the message goes');
    const bar = page.body.children.find((x) => textIn(x).includes('31-07-44'));
    assert.ok(bar && !bar.removed, 'the reminder’s bar is on screen');
    // Alice closes the browser; the deadline passes with no delete event for her. Three days later the app opens:
    // its start-up purge drops the copy (and the start-up sweep in usability.js would, for any account).
    clock = m.expiresAt + 3 * DAY * 1000;
    app.purgeInbox();
    F.purgeReminders();
    assert.ok(!(page.ls.get('hearth.inbox.alice') || '').includes('31-07-44'), 'the words are gone from the inbox');
    assert.ok(bar.removed, 'and from the screen');
    // While the app is open, the message's own delete takes the copy with it.
    app.addInbox({ type: 'reminder', msgId: 'm2', text: 'other words', exp: clock + HOUR * 1000 });
    app.purgeInbox(new Set(['m2']));
    assert.ok(!(page.ls.get('hearth.inbox.alice') || '').includes('other words'));
    // A reminder on a message with no timer has no deadline, and stays.
    const plainMsg = { id: 'm3', authorId: 'bob', dmId: 'd1', createdAt: clock, dec: { t: 'no timer here' } };
    F.remindItems(plainMsg, 'd:d1', 'no timer here').filter(Boolean).find((x) => /1 hour/.test(x.label)).action();
    clock += HOUR * 1000 + 1000;
    F.startReminders();
    const plain = JSON.parse(page.ls.get('hearth.inbox.alice')).find((x) => x.msgId === 'm3');
    assert.equal(plain.exp, undefined);
    clock += 30 * DAY * 1000;
    app.purgeInbox();
    assert.ok(page.ls.get('hearth.inbox.alice').includes('no timer here'));
  } finally { Date.now = realNow; globalThis.setInterval = realInterval; page.restore(); }
});

test('app: signing out or deleting the account clears every inbox and reminder copy from this browser; start-up drops any past its deadline', async () => {
  const page = fakePage();
  try {
    const U = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'usability.js')).href);
    const now = Date.now();
    const S = { me: { id: 'alice' } };
    const app = inboxOf(S, () => now);
    app.addInbox({ type: 'mention', msgId: 'm9', title: 'Bob mentioned you', text: 'the door code is 7741', exp: now + HOUR * 1000 });
    page.ls.set('hearth.reminders.alice', JSON.stringify([{ at: now + 60000, key: 'd:x', msgId: 'm8', text: 'bring the 7741 key', exp: now + HOUR * 1000 }]));
    page.ls.set('hearth.inbox.olduser', JSON.stringify([{ type: 'reply', msgId: 'm7', text: 'left by an earlier sign-out: 7741' }]));
    page.ls.set('hearth.favs.alice', '[]');
    // Log out and Settings → Delete account both end in signOutHere, which clears them (after the keys).
    const src = appSrc();
    assert.match(fnSrc(src, 'signOutHere'), /clearAllDrafts\(\)[\s\S]*clearLocalCopies\(\);[\s\S]*location\.href = '\/'/);
    U.clearLocalCopies();
    assert.deepEqual([...page.ls.keys()].filter((k) => /^hearth\.(inbox|reminders)\./.test(k)), [], 'no copies left, any account');
    assert.equal(page.ls.get('hearth.favs.alice'), '[]', 'other settings stay');
    // While signing out nothing new is written to the inbox.
    assert.match(fnSrc(src, 'addInbox'), /if \(!S\.me \|\| loggingOut\) return;/);
    // Start-up (before anyone signs in): whatever is past its deadline goes, whoever it belongs to.
    assert.match(fnSrc(src, 'init'), /^\nasync function init\(\) \{\n(\s*\/\/.*\n)*\s*expireLocalCopies\(Date\.now\(\)\);/);
    page.ls.set('hearth.inbox.alice', JSON.stringify([{ type: 'mention', msgId: 'a', text: 'gone already: 9921', exp: now - 1000 }, { type: 'mention', msgId: 'b', text: 'still here', exp: now + 60000 }, { type: 'reply', msgId: 'c', text: 'no timer' }]));
    page.ls.set('hearth.reminders.bob', JSON.stringify([{ at: now + 60000, msgId: 'd', text: 'past: 5512', exp: now - 5 }]));
    page.ls.set('hearth.inbox.carol', 'not json');
    assert.equal(U.expireLocalCopies(now), 2);
    const left = page.ls.get('hearth.inbox.alice');
    assert.ok(!left.includes('9921') && left.includes('still here') && left.includes('no timer'));
    assert.equal(page.ls.has('hearth.reminders.bob'), false, 'a list left empty goes');
    assert.equal(page.ls.has('hearth.inbox.carol'), false, 'and an unreadable one');
    // The ids of scheduled messages this device made go with the rest of the account's (SCHED.reset, in signOutHere).
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'scheduled.js'), 'utf8'), /reset\(\) \{\n\s*try \{ const k = hereKey\(\); if \(k\) localStorage\.removeItem\(k\);/);
  } finally { page.restore(); }
});
