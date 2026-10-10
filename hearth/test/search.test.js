// Message search (GET /api/search/messages): only metadata filters reach the server, results are ciphertext
// from conversations the caller can read right now, newest first, and paging is stable.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, hex } = require('./helpers');

let srv; let alice; let bob; let carol; let dave; let eve;
let hq; let general; let secret; let vip; let supporters; let eveServer; let eveChannel; let dm; let aliceCarolDm; let group; let groupChat;
const ids = {}; // name -> message id
const DENIED = [403, 404];
const T0 = Date.UTC(2025, 0, 1);
const DAY = 86400000;
const as = (u, method, path, body) => srv.api(method, path, { token: u.token, ip: u.ip, body });
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');
const search = (u, params = {}) => as(u, 'GET', '/search/messages?' + new URLSearchParams(params));
const idsOf = (r) => r.json.messages.map((m) => m.id);
let seq = 0;
// Messages go straight into the database (the server only ever stores ciphertext anyway), with chosen times.
const nextId = () => `s${String(++seq).padStart(5, '0')}${hex(4)}`;
function put(channelId, author, at, extra = {}) {
  const id = extra.id || nextId();
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, channelId, author.id, '', cipher(), 1, at, extra.threadId || null);
  return id;
}
function putDm(dmId, author, at) {
  const id = nextId();
  srv.sql('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)', id, dmId, author.id, cipher(), at);
  return id;
}
// Every page of a search, following nextCursor.
async function allPages(u, params, max = 50) {
  const out = [];
  let cursor;
  for (let i = 0; i < max; i++) {
    const r = await search(u, { ...params, ...(cursor ? { cursor } : {}) });
    assert.equal(r.status, 200, r.text);
    out.push(...r.json.messages);
    cursor = r.json.nextCursor;
    if (!cursor) return out;
  }
  throw new Error('too many pages');
}

before(async () => {
  srv = await startServer();
  alice = await srv.register('alice'); bob = await srv.register('bob'); carol = await srv.register('carol'); dave = await srv.register('dave'); eve = await srv.register('eve');
  hq = (await as(alice, 'POST', '/servers', { name: 'Alice HQ' })).json;
  general = hq.channels.find((c) => c.type === 'text');
  const { code } = (await as(alice, 'POST', `/servers/${hq.id}/invites`, {})).json;
  assert.equal((await as(bob, 'POST', `/invites/${code}/join`)).status, 200);
  assert.equal((await as(carol, 'POST', `/invites/${code}/join`)).status, 200);
  assert.equal((await as(dave, 'POST', `/invites/${code}/join`)).status, 200);
  // #secret: nobody but the owner can see it. #vip: only the Supporters role (Bob, for now).
  secret = (await as(alice, 'POST', `/servers/${hq.id}/channels`, { name: 'secret', type: 'text' })).json;
  assert.equal((await as(alice, 'PUT', `/channels/${secret.id}/overrides`, { overrides: [{ type: 'role', id: hq.id, allow: 0, deny: 1 }] })).status, 200);
  supporters = (await as(alice, 'POST', `/servers/${hq.id}/roles`, { name: 'Supporters', permissions: 0 })).json;
  vip = (await as(alice, 'POST', `/servers/${hq.id}/channels`, { name: 'vip', type: 'text' })).json;
  assert.equal((await as(alice, 'PUT', `/channels/${vip.id}/overrides`, { overrides: [{ type: 'role', id: hq.id, allow: 0, deny: 1 }, { type: 'role', id: supporters.id, allow: 1, deny: 0 }] })).status, 200);
  assert.equal((await as(alice, 'PUT', `/servers/${hq.id}/members/${bob.id}/roles`, { roleIds: [supporters.id] })).status, 200);
  // Eve's own server, a DM between Alice and Bob, one between Alice and Carol, and a group chat (Alice, Bob).
  eveServer = (await as(eve, 'POST', '/servers', { name: 'Eve Den' })).json;
  eveChannel = eveServer.channels.find((c) => c.type === 'text');
  dm = (await as(alice, 'POST', '/dms', { userId: bob.id })).json;
  aliceCarolDm = (await as(alice, 'POST', '/dms', { userId: carol.id })).json;
  group = (await as(alice, 'POST', '/groups', { userIds: [bob.id] })).json;
  groupChat = group.channels.find((c) => c.type === 'text');

  // One message a day from Jan 1 2025, in a fixed order.
  ids.g1 = put(general.id, alice, T0 + 1 * DAY);
  ids.g2 = put(general.id, bob, T0 + 2 * DAY);
  ids.s1 = put(secret.id, alice, T0 + 3 * DAY);
  ids.v1 = put(vip.id, alice, T0 + 4 * DAY);
  ids.e1 = put(eveChannel.id, eve, T0 + 5 * DAY);
  ids.d1 = putDm(dm.id, alice, T0 + 6 * DAY);
  ids.d2 = putDm(dm.id, bob, T0 + 7 * DAY);
  ids.ac1 = putDm(aliceCarolDm.id, carol, T0 + 8 * DAY);
  ids.gc1 = put(groupChat.id, bob, T0 + 9 * DAY);
  ids.g3 = put(general.id, carol, T0 + 10 * DAY);
  ids.t1 = put(general.id, bob, T0 + 11 * DAY, { threadId: ids.g1 }); // a thread reply
});
after(async () => { await srv.stop(); });

test('channel scope: ciphertext newest first, serialized exactly like the history endpoint', async () => {
  const r = await search(bob, { scope: 'c:' + general.id });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(idsOf(r), [ids.t1, ids.g3, ids.g2, ids.g1]);
  assert.equal(r.json.nextCursor, null);
  const hist = (await as(bob, 'GET', `/channels/${general.id}/messages`)).json.messages;
  const fromHistory = hist.find((m) => m.id === ids.g2);
  assert.deepEqual(r.json.messages.find((m) => m.id === ids.g2), fromHistory, 'same shape as history');
  assert.ok(fromHistory.ciphertext && !('body' in fromHistory));
  assert.equal(r.json.messages[0].threadId, ids.g1, 'thread replies are found too, with their thread');
  assert.equal((await srv.api('GET', '/search/messages')).status, 401, 'signed-in only');
});

test('DM, server, group and "all" scopes return exactly what the caller can read', async () => {
  const d = await search(bob, { scope: 'd:' + dm.id });
  assert.deepEqual(idsOf(d), [ids.d2, ids.d1]);
  assert.ok(d.json.messages.every((m) => m.dmId === dm.id && m.ciphertext));
  const s = await search(bob, { scope: 's:' + hq.id });
  assert.deepEqual(idsOf(s), [ids.t1, ids.g3, ids.v1, ids.g2, ids.g1], 'general and vip, not secret');
  const g = await search(bob, { scope: 'c:' + groupChat.id });
  assert.deepEqual(idsOf(g), [ids.gc1]);
  const all = await search(bob, { scope: 'all' });
  assert.deepEqual(idsOf(all), [ids.t1, ids.g3, ids.gc1, ids.d2, ids.d1, ids.v1, ids.g2, ids.g1]);
  assert.deepEqual(idsOf(await search(bob)), idsOf(all), 'all is the default');
  // The owner sees the private channel; Eve sees only her own server.
  assert.ok(idsOf(await search(alice, { scope: 's:' + hq.id })).includes(ids.s1));
  assert.deepEqual(idsOf(await search(eve)), [ids.e1]);
});

test('a hidden private channel never appears, however it is asked for', async () => {
  assert.ok(DENIED.includes((await search(bob, { scope: 'c:' + secret.id })).status));
  for (const scope of ['all', 's:' + hq.id]) {
    const got = await allPages(bob, { scope, limit: '2' });
    assert.ok(!got.some((m) => m.channelId === secret.id), scope);
  }
});

test("another server's messages and other people's DMs never appear, even with a forged scope", async () => {
  for (const scope of ['c:' + eveChannel.id, 's:' + eveServer.id, 'd:' + aliceCarolDm.id, 'c:nonexistent', 's:' + hex(8), 'd:' + hex(8)]) {
    const r = await search(bob, { scope });
    assert.ok(DENIED.includes(r.status), `${scope} → ${r.status}`);
    assert.ok(!r.text.includes('ciphertext'));
  }
  const everything = await allPages(bob, { limit: '3' });
  const seen = new Set(everything.map((m) => m.id));
  for (const k of ['e1', 'ac1', 's1']) assert.ok(!seen.has(ids[k]), k);
  // Eve, outside Alice's server, gets nothing of it.
  assert.ok(DENIED.includes((await search(eve, { scope: 'c:' + general.id })).status));
  assert.ok(DENIED.includes((await search(eve, { scope: 's:' + hq.id })).status));
  assert.ok(DENIED.includes((await search(eve, { scope: 'd:' + dm.id })).status));
});

test('deleted messages are gone from search', async () => {
  const doomed = put(general.id, bob, T0 + 12 * DAY);
  assert.ok(idsOf(await search(bob, { scope: 'c:' + general.id })).includes(doomed));
  assert.equal((await as(bob, 'DELETE', `/messages/${doomed}`)).status, 200);
  const sent = await as(bob, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() });
  assert.equal(sent.status, 200, sent.text);
  assert.ok(idsOf(await search(bob, { scope: 'd:' + dm.id })).includes(sent.json.id));
  assert.equal((await as(bob, 'DELETE', `/dm-messages/${sent.json.id}`)).status, 200);
  const after = idsOf(await search(bob));
  assert.ok(!after.includes(doomed) && !after.includes(sent.json.id));
});

test('from and date filters', async () => {
  const fromAlice = await search(bob, { from: alice.id });
  assert.deepEqual(idsOf(fromAlice), [ids.d1, ids.v1, ids.g1]);
  assert.ok(fromAlice.json.messages.every((m) => m.authorId === alice.id));
  assert.deepEqual(idsOf(await search(bob, { from: carol.id })), [ids.g3], 'Carol’s DM with Alice is not Bob’s');
  assert.deepEqual(idsOf(await search(bob, { scope: 'd:' + dm.id, from: carol.id })), []);
  assert.deepEqual(idsOf(await search(bob, { scope: 'c:' + general.id, from: bob.id })), [ids.t1, ids.g2]);
  // before is exclusive, after is inclusive.
  assert.deepEqual(idsOf(await search(bob, { before: String(T0 + 4 * DAY) })), [ids.g2, ids.g1]);
  assert.deepEqual(idsOf(await search(bob, { after: String(T0 + 9 * DAY) })), [ids.t1, ids.g3, ids.gc1]);
  assert.deepEqual(idsOf(await search(bob, { after: String(T0 + 2 * DAY), before: String(T0 + 7 * DAY) })), [ids.d1, ids.v1, ids.g2]);
  assert.deepEqual(idsOf(await search(bob, { after: String(T0 + 2 * DAY), before: String(T0 + 7 * DAY), from: bob.id })), [ids.g2]);
  for (const bad of [{ before: 'yesterday' }, { after: '-5' }, { before: '1e20' }, { from: 'x'.repeat(65) }, { from: 'a b' }, { scope: 'x:1' }, { scope: 'c:' }, { scope: 'c:a/b' }]) {
    assert.equal((await search(dave, bad)).status, 400, JSON.stringify(bad));
  }
});

test('paging is stable and deterministic, even when many messages share a timestamp', async () => {
  const pager = await srv.register();
  const s = (await as(pager, 'POST', '/servers', { name: 'Pages' })).json;
  const c = s.channels.find((x) => x.type === 'text');
  const at = T0 + 20 * DAY;
  const made = [];
  for (let i = 0; i < 23; i++) made.push(put(c.id, pager, at, { id: 'p' + hex(6) }));
  made.push(put(c.id, pager, at + 1), put(c.id, pager, at - 1));
  const expected = [made[23], ...made.slice(0, 23).sort().reverse(), made[24]];
  const first = await allPages(pager, { scope: 'c:' + c.id, limit: '7' });
  assert.deepEqual(first.map((m) => m.id), expected, 'created_at DESC, id DESC, no repeats or gaps');
  const again = await allPages(pager, { scope: 'all', limit: '4' });
  assert.deepEqual(again.map((m) => m.id), expected, 'same order with other page sizes and scopes');
});

test('scope=all looks at a bounded number of conversations per page but still pages through all of them', async () => {
  const wide = await srv.register();
  const s = (await as(wide, 'POST', '/servers', { name: 'Wide' })).json;
  const d = srv.db();
  const expected = [];
  try {
    d.transaction(() => {
      for (let j = 0; j < 130; j++) {
        const cid = 'w' + hex(6);
        d.prepare("INSERT INTO channels (id, server_id, name, type, position, created_at, category) VALUES (?, ?, ?, 'text', ?, ?, 'Text')").run(cid, s.id, 'c' + j, j + 1, T0);
        for (let k = 0; k < 3; k++) {
          const id = nextId();
          const at = T0 + 30 * DAY + k * 1000 + j;
          d.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, cid, wide.id, '', cipher(), 1, at);
          expected.push([at, id]);
        }
      }
    })();
  } finally { d.close(); }
  expected.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : -1));
  const first = await search(wide, { limit: '200' });
  assert.ok(first.json.conversations <= 100, `looked at ${first.json.conversations} conversations`);
  assert.ok(first.json.nextCursor);
  const got = await allPages(wide, { limit: '200' });
  assert.deepEqual(got.map((m) => m.id), expected.map((e) => e[1]));
});

test('membership changes apply at once: losing a role or being kicked hides what you could search before', async () => {
  assert.ok(idsOf(await search(bob, { scope: 's:' + hq.id })).includes(ids.v1));
  // Bob's Supporters role ends (as when a paid membership lapses).
  assert.equal((await as(alice, 'PUT', `/servers/${hq.id}/members/${bob.id}/roles`, { roleIds: [] })).status, 200);
  assert.ok(DENIED.includes((await search(bob, { scope: 'c:' + vip.id })).status));
  assert.ok(!idsOf(await search(bob, { scope: 's:' + hq.id })).includes(ids.v1));
  assert.ok(!(await allPages(bob, { limit: '2' })).some((m) => m.channelId === vip.id));
  // Carol is kicked: nothing from Alice HQ any more, by any scope, even continuing an old search.
  const before = await search(carol, { scope: 's:' + hq.id, limit: '1' });
  assert.equal(before.status, 200);
  assert.ok(before.json.nextCursor);
  assert.equal((await as(alice, 'DELETE', `/servers/${hq.id}/members/${carol.id}`)).status, 200);
  for (const scope of ['s:' + hq.id, 'c:' + general.id]) {
    assert.ok(DENIED.includes((await search(carol, { scope })).status), scope);
    assert.ok(DENIED.includes((await search(carol, { scope, cursor: before.json.nextCursor })).status), scope + ' (old cursor)');
  }
  const left = await allPages(carol, {});
  assert.deepEqual(left.map((m) => m.id), [ids.ac1], 'only her own DM is left');
});

test('cursors: malformed ones are refused, and a forged one reaches nothing extra', async () => {
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  for (const cursor of ['%%%', 'abc', b64('not json'), b64({ t: 1 }), b64([1]), b64([-1, 'x']), b64([1.5, 'x']), b64(['1', 'x']), b64([1, '']), b64([1, 'a b']), b64([1, 'x', 2]), 'A'.repeat(400)]) {
    const r = await search(dave, { cursor });
    assert.equal(r.status, 400, cursor);
    assert.equal(r.json.code, 'bad_cursor');
  }
  // Alice's cursor from inside #secret, handed to Dave, starts a page for Dave only.
  const a = await search(alice, { scope: 's:' + hq.id, limit: '1', before: String(T0 + 4 * DAY) });
  assert.deepEqual(idsOf(a), [ids.s1]);
  const reused = await search(dave, { cursor: a.json.nextCursor });
  assert.equal(reused.status, 200);
  assert.ok(!idsOf(reused).includes(ids.s1));
  assert.ok(DENIED.includes((await search(dave, { scope: 'c:' + secret.id, cursor: a.json.nextCursor })).status));
  // A cursor from the far future just means "from the newest".
  const future = await search(dave, { cursor: b64([Number.MAX_SAFE_INTEGER, 'zzzz']) });
  assert.deepEqual(idsOf(future), idsOf(await search(dave)));
});

test('limit is bounded', async () => {
  const big = await srv.register();
  const s = (await as(big, 'POST', '/servers', { name: 'Big' })).json;
  const c = s.channels.find((x) => x.type === 'text');
  const d = srv.db();
  try {
    d.transaction(() => {
      for (let i = 0; i < 230; i++) d.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nextId(), c.id, big.id, '', cipher(), 1, T0 + i);
    })();
  } finally { d.close(); }
  const count = async (limit) => (await search(big, limit === undefined ? {} : { limit })).json.messages.length;
  assert.equal(await count(), 100, 'default 100');
  assert.equal(await count('5'), 5);
  assert.equal(await count('1000'), 200, 'at most 200');
  assert.equal(await count('0'), 1, 'at least 1');
  assert.equal(await count('-3'), 1);
  assert.equal(await count('lots'), 100);
});

test('searching is rate limited per person', async () => {
  const busy = await srv.register();
  let last;
  for (let i = 0; i < 61; i++) last = await search(busy, { limit: '1' });
  assert.equal(last.status, 429);
  assert.equal(last.json.code, 'rate_limited');
  assert.equal((await search(dave, { limit: '1' })).status, 200, 'other people are unaffected');
});
