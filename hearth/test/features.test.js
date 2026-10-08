// Security of the newer personal features: server folders, Updates (personal trackers), study tools and group
// chats. Each user's data must stay theirs, input must be cleaned, and the server must not be tricked into
// fetching private addresses.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, hex } = require('./helpers');

let srv; let a; let b;
const as = (u, method, path, body) => srv.api(method, path, { token: u.token, ip: u.ip, body });
const x1 = (n = 64) => 'x1:' + crypto.randomBytes(12).toString('base64') + ':' + crypto.randomBytes(n).toString('base64');
before(async () => { srv = await startServer(); a = await srv.register('alpha'); b = await srv.register('bravo'); });
after(async () => { await srv.stop(); });

// ------------------------------------------------------------------ server folders
test('folders: input is cleaned and stays per account', async () => {
  const dirty = {
    folders: [{ id: 'f1', name: '<b>School</b>'.repeat(10), color: 'javascript:alert(1)', emoji: '📚📚📚📚📚📚📚📚📚', servers: ['s1', 's1', '../x', { $gt: '' }, 'a'.repeat(100)], open: 'yes', __proto__: { admin: true } },
      { id: '../../evil', name: 'x' }, null, 'str'],
    order: ['f:f1', 's:s1', 'x:bad', 'f:f1', 42], focus: 'nope', extra: 'field',
  };
  const r = await as(a, 'PUT', '/me/rail', dirty);
  assert.equal(r.status, 200);
  assert.equal(r.json.folders.length, 1);
  const f = r.json.folders[0];
  assert.ok(f.name.length <= 32);
  assert.equal(f.color, '#5865f2');
  assert.deepEqual(f.servers, ['s1']);
  assert.equal(f.open, true);
  assert.deepEqual(r.json.order, ['f:f1', 's:s1']);
  assert.equal(r.json.focus, null);
  assert.equal(r.json.extra, undefined);
  assert.deepEqual((await as(b, 'GET', '/bootstrap')).json.me.rail.folders, [], 'other accounts unaffected');
  assert.equal((await as(a, 'GET', '/bootstrap')).json.me.rail.folders[0].id, 'f1');
  for (const body of [null, [], 'x', 123]) assert.ok([200, 400].includes((await srv.api('PUT', '/me/rail', { token: a.token, ip: a.ip, raw: JSON.stringify(body) })).status));
});

// ------------------------------------------------------------------ Updates (personal trackers)
test('trackers: private and internal addresses are refused (no server-side request forgery)', async () => {
  for (const q of ['http://127.0.0.1:1/feed', 'http://localhost/feed', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/x', 'http://[::1]/x', 'file:///etc/passwd', 'gopher://x']) {
    const r = await as(a, 'POST', '/me/trackers', { kind: 'rss', query: q });
    assert.equal(r.status, 400, `${q} → ${r.status}`);
    const p = await as(a, 'POST', '/me/trackers/preview', { kind: 'rss', query: q });
    assert.equal(p.status, 400, `preview ${q} → ${p.status}`);
  }
  assert.equal((await as(a, 'POST', '/me/trackers', { kind: '__proto__', query: 'x' })).status, 400);
  assert.equal((await as(a, 'POST', '/me/trackers', { kind: 'constructor', query: 'x' })).status, 400);
});

test("trackers: nobody can see, change or delete someone else's", async () => {
  // Insert a tracker for A directly (the network to real feeds isn't available in tests).
  const id = 'trk' + hex(4);
  srv.sql('INSERT INTO user_feeds (id, user_id, kind, query, url, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, a.id, 'rss', 'q', 'https://example.test/feed', 'Alpha feed', Date.now());
  srv.sql("INSERT INTO user_feed_items (id, feed_id, user_id, item_key, data, new, created_at) VALUES (?, ?, ?, 'k1', ?, 1, ?)", 'it' + hex(4), id, a.id, JSON.stringify({ title: 'ALPHA-PRIVATE', url: 'https://example.test/1' }), Date.now());
  const mine = await as(a, 'GET', '/me/trackers');
  assert.equal(mine.json.trackers.length, 1);
  assert.equal(mine.json.unread, 1);
  const theirs = await as(b, 'GET', '/me/trackers');
  assert.equal(theirs.json.trackers.length, 0);
  assert.ok(!theirs.text.includes('ALPHA-PRIVATE'));
  assert.ok(!(await as(b, 'GET', `/me/trackers?feed=${id}`)).text.includes('ALPHA-PRIVATE'));
  assert.equal((await as(b, 'PATCH', `/me/trackers/${id}`, { paused: true })).status, 404);
  assert.equal((await as(b, 'POST', `/me/trackers/${id}/check`)).status, 404);
  assert.equal((await as(b, 'DELETE', `/me/trackers/${id}`)).status, 404);
  await as(b, 'POST', '/me/tracker-items/read', { all: true });
  await as(b, 'POST', '/me/tracker-items/read', { feedId: id });
  await as(b, 'POST', '/me/tracker-items/read', { ids: mine.json.items.map((i) => i.id) });
  assert.equal((await as(a, 'GET', '/me/trackers')).json.unread, 1, "B's read marks don't touch A's items");
  assert.equal(srv.sql('SELECT paused FROM user_feeds WHERE id = ?', id)[0].paused, 0);
});

// ------------------------------------------------------------------ study tools
test('study: only ciphertext is accepted, and each account sees only its own items', async () => {
  for (const data of ['plain text', '{"name":"deck"}', '', null, 123, ['x1:']]) assert.equal((await as(a, 'PUT', '/me/study/deck-1', { kind: 'deck', data })).status, 400);
  for (const kind of ['note', '__proto__', '', null]) assert.equal((await as(a, 'PUT', '/me/study/deck-1', { kind, data: x1() })).status, 400);
  for (const id of ['../x', 'a'.repeat(41), 'a b', '%00']) assert.notEqual((await as(a, 'PUT', `/me/study/${encodeURIComponent(id)}`, { kind: 'deck', data: x1() })).status, 200);
  const secret = x1();
  assert.equal((await as(a, 'PUT', '/me/study/deck-1', { kind: 'deck', data: secret })).status, 200);
  assert.equal((await as(b, 'PUT', '/me/study/deck-1', { kind: 'deck', data: x1() })).status, 200, 'same id, different account: separate items');
  const ga = (await as(a, 'GET', '/me/study')).json; const gb = (await as(b, 'GET', '/me/study')).json;
  assert.equal(ga.items.find((i) => i.id === 'deck-1').data, secret);
  assert.ok(!JSON.stringify(gb).includes(secret));
  await as(b, 'DELETE', '/me/study/deck-1');
  assert.equal((await as(a, 'GET', '/me/study')).json.items.find((i) => i.id === 'deck-1').data, secret, "B deleting its own item leaves A's alone");
  // the same id can't be reused for another kind (no type confusion)
  assert.equal((await as(a, 'PUT', '/me/study/deck-1', { kind: 'task', data: x1() })).status, 409);
});

test('study: size limits', async () => {
  const big = 'x1:' + 'A'.repeat(512 * 1024 + 10);
  const r = await as(a, 'PUT', '/me/study/deck-big', { kind: 'deck', data: big });
  assert.ok([400, 413].includes(r.status));
});

test('study: reminders hold only a time and are per account', async () => {
  assert.equal((await as(a, 'PUT', '/me/study-reminders/task-1', { at: Date.now() + 3600000 })).status, 200);
  assert.equal((await as(a, 'PUT', '/me/study-reminders/task-2', { at: Date.now() + 1000 * 86400000 })).status, 400, 'more than a year away');
  assert.equal((await as(a, 'PUT', '/me/study-reminders/task-3', { at: 'soon' })).status, 400);
  const row = srv.sql('SELECT * FROM study_reminders WHERE user_id = ?', a.id)[0];
  assert.deepEqual(Object.keys(row).sort(), ['at', 'id', 'user_id']);
  await as(b, 'PUT', '/me/study-reminders/task-1', { at: null });
  assert.equal(srv.sql('SELECT COUNT(*) n FROM study_reminders WHERE user_id = ?', a.id)[0].n, 1, "B can't cancel A's reminder");
});

// ------------------------------------------------------------------ group chats
test('group chats: only the owner removes people; outsiders can do nothing', async () => {
  const c = await srv.register('charlie');
  const d = await srv.register('delta');
  for (const u of [b, c]) { await as(u, 'POST', '/friends', { username: 'alpha' }); await as(a, 'POST', `/friends/${u.id}/accept`); }
  const g = (await as(a, 'POST', '/groups', { userIds: [b.id, c.id], name: 'G' })).json;
  assert.ok(g.id, JSON.stringify(g));
  assert.equal((await as(b, 'DELETE', `/groups/${g.id}/members/${c.id}`)).status, 403, 'not the owner');
  assert.ok([403, 404].includes((await as(d, 'DELETE', `/groups/${g.id}/members/${c.id}`)).status), 'outsider');
  assert.ok([403, 404].includes((await as(d, 'POST', `/groups/${g.id}/owner`, { userId: d.id })).status));
  assert.equal((await as(b, 'POST', `/groups/${g.id}/owner`, { userId: b.id })).status, 403);
  assert.equal((await as(a, 'DELETE', `/groups/${g.id}/members/${a.id}`)).status, 400, 'owner uses Leave instead');
  assert.equal((await as(a, 'DELETE', `/groups/${g.id}/members/${c.id}`)).status, 200);
  assert.ok([403, 404].includes((await as(c, 'GET', `/channels/${g.channels.find((x) => x.type === 'text').id}/messages`)).status), 'removed member is out');
  assert.equal((await as(a, 'POST', `/groups/${g.id}/owner`, { userId: d.id })).status, 404, 'only to someone in the group');
});

test('deleting an account removes its trackers, study items and reminders', async () => {
  const u = await srv.register();
  await as(u, 'PUT', '/me/study/deck-x', { kind: 'deck', data: x1() });
  await as(u, 'PUT', '/me/study-reminders/t1', { at: Date.now() + 3600000 });
  srv.sql('INSERT INTO user_feeds (id, user_id, kind, query, url, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'trk' + hex(4), u.id, 'rss', 'q', 'https://example.test/f', 't', Date.now());
  assert.equal((await as(u, 'DELETE', '/me', { authKey: u.authKey, confirm: u.username })).status, 200);
  for (const t of ['study_items', 'study_reminders', 'user_feeds']) assert.equal(srv.sql(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, u.id)[0].n, 0, t);
});
