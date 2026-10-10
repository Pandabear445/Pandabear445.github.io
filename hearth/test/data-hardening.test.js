// Data layer: bounded queries, very big threads, join/leave fan-out in a big server, upgrades that can be cut short,
// databases from a newer Hearth, indexes on hot lookups, and the paged study sync (server and app).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startServer, hex, sleep } = require('./helpers');

const ROOT = path.join(__dirname, '..');
let srv; let alice; let bob; let server; let channel; let dm;
const as = (u, m, p, body, opts = {}) => srv.api(m, p, { token: u.token, ip: u.ip, body, timeout: 60000, ...opts });
const cipher = () => 'v2:' + crypto.randomBytes(24).toString('base64');
// Message ids sort by time, like newId() makes them.
const idAt = (n) => n.toString(36).padStart(9, '0') + hex(5);

before(async () => {
  srv = await startServer();
  alice = await srv.register('alice'); bob = await srv.register('bob');
  server = (await as(alice, 'POST', '/servers', { name: 'HQ' })).json;
  channel = server.channels.find((c) => c.type === 'text');
  const { code } = (await as(alice, 'POST', `/servers/${server.id}/invites`, {})).json;
  assert.equal((await as(bob, 'POST', `/invites/${code}/join`)).status, 200);
  dm = (await as(alice, 'POST', '/dms', { userId: bob.id })).json;
});
after(async () => { await srv.stop(); });

// ------------------------------------------------------------------ data-1: ?limit is clamped
test('message pages hold 1 to 100 messages whatever ?limit says, in channels and DMs', async () => {
  const d = srv.db();
  const t0 = Date.now() - 1e6;
  d.transaction(() => {
    const m = d.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
    const dmm = d.prepare('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 150; i++) { m.run(idAt(t0 + i), channel.id, alice.id, '', cipher(), t0 + i); dmm.run(idAt(t0 + i), dm.id, alice.id, cipher(), t0 + i); }
  })();
  d.close();
  for (const base of [`/channels/${channel.id}/messages`, `/dms/${dm.id}/messages`]) {
    for (const limit of ['-1', '-5', '-100000', '500', '1e9']) {
      const r = await as(bob, 'GET', `${base}?limit=${limit}`);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.messages.length >= 1 && r.json.messages.length <= 100, `${base} ?limit=${limit} gave ${r.json.messages.length}`);
      assert.equal(r.json.hasMore, true);
      const older = await as(bob, 'GET', `${base}?limit=${limit}&before=${r.json.messages[0].id}`);
      assert.ok(older.json.messages.length >= 1 && older.json.messages.length <= 100, `before + ?limit=${limit}`);
    }
    // Normal paging still works.
    assert.equal((await as(bob, 'GET', base)).json.messages.length, 50);
    const full = await as(bob, 'GET', `${base}?limit=100`);
    assert.equal(full.json.messages.length, 100);
    assert.equal((await as(bob, 'GET', `${base}?limit=100&before=${full.json.messages[0].id}`)).json.messages.length, 50);
  }
});

// ------------------------------------------------------------------ data-2: threads of any size
function bigThread(author, n) {
  const root = idAt(Date.now() - 5e5) ; const d = srv.db();
  const ins = d.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, thread_id, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  const replies = [];
  d.transaction(() => {
    ins.run(root, channel.id, author.id, '', cipher(), null, Date.now());
    for (let i = 0; i < n; i++) { const id = idAt(Date.now() - 4e5 + i); replies.push(id); ins.run(id, channel.id, alice.id, '', 'v2:xxxxxxxxxxxxxxxxxxxxxxxx', root, Date.now()); }
    const re = d.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)');
    re.run(root, bob.id, '👍', Date.now());
    for (const id of [replies[0], replies[n - 1]]) re.run(id, bob.id, '🔥', Date.now());
  })();
  const blob = 'b' + hex(8) + '.bin';
  d.prepare('INSERT INTO blobs (name, uploader_id, message_id, created_at) VALUES (?, ?, ?, ?)').run(blob, author.id, root, Date.now());
  d.close();
  fs.writeFileSync(path.join(srv.dir, 'uploads', blob), crypto.randomBytes(1000));
  return { root, replies, blob };
}
const treeLeft = (t) => ({
  messages: srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ? OR thread_id = ?', t.root, t.root)[0].n,
  reactions: srv.sql(`SELECT COUNT(*) n FROM reactions WHERE message_id IN (?, ?, ?)`, t.root, t.replies[0], t.replies[t.replies.length - 1])[0].n,
  blobRow: srv.sql('SELECT COUNT(*) n FROM blobs WHERE name = ?', t.blob)[0].n,
  file: fs.existsSync(path.join(srv.dir, 'uploads', t.blob)),
});

test('a thread with more replies than SQLite allows placeholders opens a page at a time and can be deleted', async () => {
  const N = 33000;
  const t = bigThread(bob, N);
  const r = await as(alice, 'GET', `/messages/${t.root}/thread`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.root.id, t.root);
  assert.equal(r.json.root.threadCount, N);
  assert.equal(r.json.messages.length, 100);
  assert.equal(r.json.hasMore, true);
  assert.deepEqual(r.json.messages.map((m) => m.id), t.replies.slice(-100), 'the newest replies, oldest first');
  assert.equal(r.json.messages[99].reactions[0].emoji, '🔥');
  const older = await as(alice, 'GET', `/messages/${t.root}/thread?before=${r.json.messages[0].id}`);
  assert.deepEqual(older.json.messages.map((m) => m.id), t.replies.slice(-200, -100));
  assert.ok((await as(alice, 'GET', `/messages/${t.root}/thread?limit=-1`)).json.messages.length <= 100);
  // Opening it at a linked reply deep inside takes one request for the page around it, then ?after for newer ones.
  const at = await as(alice, 'GET', `/messages/${t.root}/thread?around=${t.replies[5000]}`);
  assert.deepEqual(at.json.messages.map((m) => m.id), t.replies.slice(4975, 5026));
  assert.equal(at.json.hasMore, true);
  assert.equal(at.json.hasNewer, true);
  const newer = await as(alice, 'GET', `/messages/${t.root}/thread?limit=100&after=${t.replies[5025]}`);
  assert.deepEqual(newer.json.messages.map((m) => m.id), t.replies.slice(5026, 5126));
  assert.equal(newer.json.hasNewer, true);

  // If the database part fails, nothing is lost: the files are only removed after it has committed.
  srv.sql("CREATE TRIGGER block_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'blocked for the test'); END");
  assert.equal((await as(bob, 'DELETE', `/messages/${t.root}`)).status, 500);
  assert.deepEqual(treeLeft(t), { messages: N + 1, reactions: 3, blobRow: 1, file: true });
  srv.sql('DROP TRIGGER block_delete');

  const del = await as(bob, 'DELETE', `/messages/${t.root}`);
  assert.equal(del.status, 200, del.text);
  assert.deepEqual(treeLeft(t), { messages: 0, reactions: 0, blobRow: 0, file: false });
  assert.doesNotMatch(srv.log, /too many SQL variables/);
});

test('staff can remove a huge thread too; deleting one reply leaves the rest', async () => {
  const t = bigThread(alice, 33000);
  const staff = await srv.api('DELETE', `/admin/messages/${t.root}`, { token: srv.owner.token, ip: srv.owner.ip, timeout: 60000 });
  assert.equal(staff.status, 200, staff.text);
  assert.deepEqual(treeLeft(t), { messages: 0, reactions: 0, blobRow: 0, file: false });

  const small = bigThread(bob, 3);
  assert.equal((await as(alice, 'DELETE', `/messages/${small.replies[1]}`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ? OR thread_id = ?', small.root, small.root)[0].n, 3);
  const r = await as(bob, 'GET', `/messages/${small.root}/thread`);
  assert.deepEqual(r.json.messages.map((m) => m.id), [small.replies[0], small.replies[2]]);
  assert.equal(r.json.hasMore, false);
  // Someone else's message still can't be deleted by a plain member.
  assert.equal((await as(bob, 'DELETE', `/messages/${small.replies[0]}`)).status, 403);
});

test('a page whose messages carry 200k reactions opens (no stack overflow), reactions in the order they were added', async () => {
  const ch = (await as(alice, 'POST', `/servers/${server.id}/channels`, { name: 'popular', type: 'text' })).json;
  const EMOJI = Array.from({ length: 20 }, (_, i) => 'e' + i);
  const d = srv.db();
  const users = []; const msgs = [];
  d.transaction(() => {
    const t0 = Date.now() - 1e6;
    const u = d.prepare("INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, created_at) VALUES (?, ?, 'x', 'x', 'x', ?)");
    const m = d.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
    const re = d.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 100; i++) { const id = 'fan' + hex(6); users.push(id); u.run(id, id, t0); }
    for (let i = 0; i < 100; i++) { const id = idAt(t0 + i); msgs.push(id); m.run(id, ch.id, alice.id, '', cipher(), t0 + i); }
    // Added newest emoji first and in reverse user order, so the answer's order can only come from created_at.
    let t = t0;
    for (const id of msgs) for (const e of [...EMOJI].reverse()) for (const uid of [...users].reverse()) re.run(id, uid, e, t++);
  })();
  d.close();
  for (const q of ['limit=100', `around=${msgs[50]}`]) {
    const r = await as(bob, 'GET', `/channels/${ch.id}/messages?${q}`);
    assert.equal(r.status, 200, `${q}: ${r.text}`);
    const first = r.json.messages.find((x) => x.id === msgs[50]);
    assert.equal(first.reactions.length, 20);
    assert.deepEqual(first.reactions.map((x) => x.emoji), [...EMOJI].reverse());
    assert.deepEqual(first.reactions[0].userIds, [...users].reverse());
  }
  assert.doesNotMatch(srv.log, /Maximum call stack/);
});

// ------------------------------------------------------------------ data-3: join/leave in a big server
test('join, leave, a kick and a channel edit in a 2000-member server with 500 online stay fast, and reach everyone online', async () => {
  const M = 2000; const ONLINE = 500;
  const big = (await as(alice, 'POST', '/servers', { name: 'Big' })).json;
  for (let i = 0; i < 10; i++) await as(alice, 'POST', `/servers/${big.id}/channels`, { name: 'c' + i, type: 'text' });
  const { code } = (await as(alice, 'POST', `/servers/${big.id}/invites`, {})).json;
  const d = srv.db();
  const tokens = [];
  d.transaction(() => {
    const t = Date.now();
    const u = d.prepare("INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, created_at) VALUES (?, ?, 'x', 'x', 'x', ?)");
    const m = d.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)');
    const k = d.prepare("INSERT INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, 1, ?, ?, ?, ?)");
    const se = d.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
    d.prepare("INSERT INTO server_epochs (server_id, epoch, key_check, creator_id, created_at) VALUES (?, 1, 'chk', ?, ?)").run(big.id, alice.id, t);
    d.prepare('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?').run(big.id);
    k.run(big.id, alice.id, 'w'.repeat(60), alice.id, t);
    for (let i = 0; i < M; i++) {
      const id = 'syn' + hex(6);
      u.run(id, 'syn' + hex(6), t); m.run(big.id, id, t + i); k.run(big.id, id, 'w'.repeat(60), alice.id, t);
      if (i < ONLINE) { const tok = hex(32); tokens.push(tok); se.run(hex(12), crypto.createHash('sha256').update(tok).digest('hex'), id, t, t, t + 86400000); }
    }
  })();
  d.close();
  // Members with the app open: each gets their own server update and key state, so this is the fan-out that costs.
  const sockets = [];
  const heard = { 'server:update': 0, 'keys:state': 0 };
  try {
    for (const tok of tokens) {
      const so = await srv.socket(tok);
      so.on('server:update', (p) => { if (p.id === big.id) heard['server:update']++; });
      so.on('keys:state', (p) => { if (p.serverId === big.id) heard['keys:state']++; });
      sockets.push(so);
    }
    const mallory = await srv.register();
    const sock = await srv.socket(alice.token);
    sockets.push(sock);
    const seen = [];
    for (const ev of ['keys:state', 'member:add', 'member:remove', 'server:update']) sock.on(ev, (p) => seen.push([ev, p]));
    let worst = 0; let stop = false;
    const pinger = (async () => { while (!stop) { const s = Date.now(); await srv.api('GET', '/config'); worst = Math.max(worst, Date.now() - s); await sleep(20); } })();
    const times = {};
    const timed = async (name, fn) => { const t = Date.now(); const r = await fn(); (times[name] ||= []).push(Date.now() - t); assert.equal(r.status, 200, `${name}: ${r.text}`); };
    try {
      for (let i = 0; i < 3; i++) {
        await timed('join', () => as(mallory, 'POST', `/invites/${code}/join`));
        await timed('leave', () => as(mallory, 'POST', `/servers/${big.id}/leave`));
      }
      await timed('join', () => as(mallory, 'POST', `/invites/${code}/join`));
      // Both send everyone online their own view of the whole server (permissions differ per person).
      await timed('kick', () => as(alice, 'DELETE', `/servers/${big.id}/members/${mallory.id}`));
      await timed('channel edit', () => as(alice, 'PATCH', `/channels/${big.channels[0].id}`, { name: 'renamed' }));
    } finally { stop = true; await pinger; }
    for (let i = 0; i < 50 && (heard['server:update'] < 2 * ONLINE || heard['keys:state'] < 8 * ONLINE); i++) await sleep(100);
    // Before: about 1.5 s per join and 4 s per leave here (with 1 online), with everyone else waiting as long. The kick
    // and the edit take about 0.1-0.2 s; working the shared part of a server update out again for each member online
    // (online × members) made them 0.8-1 s.
    for (const [name, ms] of Object.entries(times)) assert.ok(Math.max(...ms) < (['kick', 'channel edit'].includes(name) ? 600 : 1000), `${name} took ${ms.join(', ')} ms`);
    assert.ok(worst < 1000, `others waited up to ${worst} ms`);
    // Everyone online heard both server updates and all 8 key changes (4 joins, 3 leaves, the kick).
    assert.equal(heard['server:update'], 2 * ONLINE);
    assert.equal(heard['keys:state'], 8 * ONLINE);
    // The online owner still hears who came and went, and that the newcomer needs the key.
    const keyUpdates = seen.filter(([ev, p]) => ev === 'keys:state' && p.serverId === big.id);
    assert.equal(keyUpdates.length, 8);
    assert.ok(keyUpdates.some(([, p]) => p.missing.includes(mallory.id)));
    assert.equal(seen.filter(([ev, p]) => ev === 'member:add' && p.serverId === big.id).length, 4);
    assert.equal(seen.filter(([ev, p]) => ev === 'member:remove' && p.serverId === big.id && p.userId === mallory.id).length, 4);
    const after = seen.filter(([ev, p]) => ev === 'server:update' && p.id === big.id).pop();
    assert.ok(after && !after[1].memberIds.includes(mallory.id) && after[1].channels.some((c) => c.name === 'renamed'));
  } finally { sockets.forEach((x) => x.close()); }
});

test('joining is rate limited per account; leaving never is, so nobody can be kept in a group', async () => {
  const small = (await as(alice, 'POST', '/servers', { name: 'Door' })).json;
  const { code } = (await as(alice, 'POST', `/servers/${small.id}/invites`, {})).json;
  const eve = await srv.register();
  for (let i = 0; i < 20; i++) {
    assert.equal((await as(eve, 'POST', `/invites/${code}/join`)).status, 200, `join ${i + 1}`);
    assert.equal((await as(eve, 'POST', `/servers/${small.id}/leave`)).status, 200, `leave ${i + 1}`);
  }
  const j = await as(eve, 'POST', `/invites/${code}/join`);
  assert.equal(j.status, 429);
  assert.equal(j.json.code, 'rate_limited');
  // Someone else is unaffected.
  const fred = await srv.register();
  assert.equal((await as(fred, 'POST', `/invites/${code}/join`)).status, 200);

  // Anyone who shares a server with you can put you in a group and add you back each time you leave. However often
  // that happens, leaving still works, and so does leaving a server afterwards.
  const group = (await as(alice, 'POST', '/groups', { userIds: [fred.id], name: 'Trap' })).json;
  for (let i = 0; i < 30; i++) {
    assert.equal((await as(fred, 'POST', `/servers/${group.id}/leave`)).status, 200, `group leave ${i + 1}`);
    assert.equal((await as(alice, 'POST', `/groups/${group.id}/members`, { userId: fred.id })).status, 200, `re-add ${i + 1}`);
  }
  assert.equal((await as(fred, 'POST', `/servers/${group.id}/leave`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM members WHERE server_id = ? AND user_id = ?', group.id, fred.id)[0].n, 0);
  assert.equal((await as(fred, 'POST', `/servers/${small.id}/leave`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM members WHERE server_id = ? AND user_id = ?', small.id, fred.id)[0].n, 0);
});

// ------------------------------------------------------------------ data-9 / data-10: query plans
// The statements the server runs on its hottest paths, checked against the server's own database.
test('hot lookups use indexes instead of reading whole tables', () => {
  const d = srv.db();
  try {
    const plan = (sql, ...args) => d.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' | ');
    const plans = {
      socketJoin: plan('SELECT server_id FROM members WHERE user_id = ?', 'x'),
      bootstrapServers: plan('SELECT s.* FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY m.joined_at', 'x'),
      bootstrapDms: plan('SELECT * FROM dm_channels WHERE user_a = ? OR user_b = ? ORDER BY last_message_at DESC', 'x', 'x'),
      bootstrapFriends: plan('SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?', 'x', 'x'),
      sharesServer: plan('SELECT 1 FROM members x JOIN members y ON x.server_id = y.server_id WHERE x.user_id = ? AND y.user_id = ? LIMIT 1', 'x', 'y'),
      channelsByServer: plan('SELECT * FROM channels WHERE server_id = ? ORDER BY position, created_at', 'x'),
      memberKeys: plan(`SELECT k.epoch FROM server_keys k JOIN server_epochs e ON e.server_id = k.server_id AND e.epoch = k.epoch
        WHERE k.server_id = ? AND k.user_id = ? ORDER BY k.epoch`, 'x', 'y'),
      groupLast: plan('SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT 1', 'x'),
    };
    for (const [name, p] of Object.entries(plans)) assert.doesNotMatch(p, /\bSCAN (members|dm_channels|friendships|channels|server_keys|m|x|y|k)\b/, `${name}: ${p}`);
    assert.match(plans.groupLast, /idx_messages_channel/);
    assert.match(plans.socketJoin, /idx_members_user/);
  } finally { d.close(); }
});

test('start-up data for someone in quiet groups doesn’t depend on how many messages the instance has', async () => {
  const carol = await srv.register();
  const friends = (await as(alice, 'POST', `/servers/${server.id}/invites`, {})).json;
  assert.equal((await as(carol, 'POST', `/invites/${friends.code}/join`)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await as(carol, 'POST', '/groups', { userIds: [alice.id], name: 'g' + i })).status, 200);
  const time = async () => { let best = Infinity; for (let i = 0; i < 3; i++) { const s = Date.now(); const r = await as(carol, 'GET', '/bootstrap'); assert.equal(r.status, 200); best = Math.min(best, Date.now() - s); } return best; };
  const quiet = await time();
  const busy = (await as(alice, 'POST', '/servers', { name: 'Busy' })).json.channels.find((c) => c.type === 'text');
  const d = srv.db();
  const ins = d.prepare("INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, '', 'v2:x', 1, ?)");
  const t0 = Date.now() - 2e6;
  // In chunks, so this outside writer never holds the database lock long enough (5 s) for the running server's
  // own writes to give up while the machine is busy.
  for (let c = 0; c < 300000; c += 20000) d.transaction(() => { for (let i = c; i < c + 20000; i++) ins.run(idAt(t0 + i), busy.id, alice.id, t0 + i); })();
  d.close();
  const loud = await time();
  // Before: each quiet group walked every message on the instance (about 0.7 s more for 300k messages here).
  assert.ok(loud < quiet + 150, `bootstrap ${quiet} ms -> ${loud} ms with 300k unrelated messages`);
  const groups = (await as(carol, 'GET', '/bootstrap')).json.servers.filter((s) => s.kind === 'group');
  assert.equal(groups.length, 10);
  assert.ok(groups.every((g) => g.last === null));
});

// ------------------------------------------------------------------ data-13 / crypto-10: paged study sync
const x1 = (n) => 'x1:' + crypto.randomBytes(Math.ceil(n * 0.75)).toString('base64').slice(0, n - 3);
async function syncAll(u, since = 0) {
  const got = []; let pages = 0;
  for (;;) {
    const r = await as(u, 'GET', `/me/study?since=${since}&paged=1`);
    assert.equal(r.status, 200, r.text);
    pages++;
    got.push(...r.json.items);
    if (!r.json.more) return { got, pages };
    assert.ok(r.json.items.length > 0);
    since = r.json.items[r.json.items.length - 1].updatedAt;
  }
}

test('study sync comes in pages of a few MB, nothing skipped or repeated; old apps are asked to reload', async () => {
  const u = await srv.register();
  const ids = [];
  for (let i = 0; i < 12; i++) { const id = `r-deck${i}`; ids.push(id); assert.equal((await as(u, 'PUT', `/me/study/${id}`, { kind: 'deck', data: x1(1000 * 1000) })).status, 200); }
  const first = await as(u, 'GET', '/me/study?since=0&paged=1');
  assert.equal(first.json.more, true);
  assert.ok(first.text.length < 6 * 1024 * 1024, `first page is ${first.text.length} bytes`);
  assert.equal(first.headers.get('content-encoding'), 'gzip', 'big pages are still compressed');
  const { got, pages } = await syncAll(u);
  assert.ok(pages >= 3);
  assert.deepEqual(got.map((i) => i.id), ids, 'every item once, in order');
  // An app from before paging gets everything in one answer when it fits, otherwise a clear "reload" (never half).
  const legacy = await as(u, 'GET', '/me/study?since=0');
  assert.equal(legacy.status, 409);
  assert.equal(legacy.json.code, 'study_paged');
  const tail = await as(u, 'GET', `/me/study?since=${got[got.length - 3].updatedAt}`);
  assert.equal(tail.status, 200);
  assert.deepEqual(tail.json.items.map((i) => i.id), ids.slice(-2));
});

test('thousands of deletions no longer hide the newest items (the Recall profile) from a new device', async () => {
  const u = await srv.register();
  const d = srv.db();
  const t0 = Date.now() - 1e6;
  d.transaction(() => {
    const ins = d.prepare('INSERT INTO study_items (id, user_id, kind, data, size, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 5001; i++) ins.run(`gone-${i}`, u.id, 'deck', '', 0, t0 + i, 1);
    for (let i = 0; i < 20; i++) ins.run(`r-live${i}`, u.id, 'deck', 'x1:deck', 7, t0 + 6000 + i, 0);
    ins.run('recall-profile', u.id, 'settings', 'x1:profile', 10, t0 + 7000, 0);
  })();
  d.close();
  const { got } = await syncAll(u);
  assert.equal(got.length, 5022);
  assert.equal(new Set(got.map((i) => i.id)).size, 5022);
  assert.equal(got[got.length - 1].id, 'recall-profile');
  assert.equal(got.filter((i) => !i.deleted).length, 21);
  // Deleting cleans up tombstones older than 90 days (recent ones stay so open devices still hear about them).
  srv.sql('UPDATE study_items SET updated_at = ? WHERE user_id = ? AND id LIKE ?', Date.now() - 100 * 86400000, u.id, 'gone-1%');
  assert.equal((await as(u, 'DELETE', '/me/study/r-live0')).status, 200);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM study_items WHERE user_id = ? AND id LIKE 'gone-1%'", u.id)[0].n, 0);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM study_items WHERE user_id = ? AND id LIKE 'gone-2%'", u.id)[0].n, 1111);
  assert.equal(srv.sql("SELECT deleted FROM study_items WHERE user_id = ? AND id = 'r-live0'", u.id)[0].deleted, 1);
});

test('the study sync is limited per account, by requests and by data sent, leaving room for several devices', async () => {
  // Requests: as many as saves (600 a minute), since each save on one device makes every other open device ask once.
  const u = await srv.register();
  for (let i = 0; i < 600; i++) assert.equal((await as(u, 'GET', '/me/study?paged=1')).status, 200, `sync ${i + 1}`);
  assert.equal((await as(u, 'GET', '/me/study?paged=1')).status, 429);
  assert.equal((await as(alice, 'GET', '/me/study?paged=1')).status, 200);

  // Data: about two full study spaces (2 x 100 MB) a minute, then a wait, whatever the pages look like.
  const v = await srv.register();
  const d = srv.db();
  d.transaction(() => {
    const ins = d.prepare("INSERT INTO study_items (id, user_id, kind, data, size, updated_at, deleted) VALUES (?, ?, 'deck', ?, ?, ?, 0)");
    for (let i = 0; i < 12; i++) ins.run(`r-big${i}`, v.id, 'x1:' + 'A'.repeat(1e6 - 3), 1e6, Date.now() - 1e5 + i);
  })();
  d.close();
  let sent = 0; let refused = null;
  for (let since = 0, i = 0; !refused && i < 200; i++) {
    const r = await as(v, 'GET', `/me/study?since=${since}&paged=1`);
    if (r.status !== 200) { refused = r; break; }
    sent += r.json.items.reduce((n, it) => n + it.data.length, 0);
    since = r.json.more ? r.json.items[r.json.items.length - 1].updatedAt : 0;
  }
  assert.ok(refused, 'the data limit kicks in');
  assert.equal(refused.status, 429);
  assert.equal(refused.json.code, 'rate_limited');
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.ok(sent >= 200e6 && sent <= 225e6, `sent ${sent} bytes before the limit`);
  assert.equal((await as(alice, 'GET', '/me/study?paged=1')).status, 200, 'other accounts are unaffected');
});

// The app side (public/js/recall-host.js), run in Node with its imports replaced by small fakes.
test('Recall loads every page before tidying up, so the profile and pictures of later pages survive', async () => {
  const { register } = require('node:module');
  const fakes = {
    './util.js': 'export const h = (...a) => globalThis.__recall.h(...a); export const toast = (...a) => globalThis.__recall.toasts.push(a);',
    './api.js': 'export const api = (...a) => globalThis.__recall.api(...a);',
    './e2ee.js': `export const vaultKey = async () => 'k';
      export const openVault = async (k, kind, id, data) => JSON.parse(data.slice(3));
      export const sealVault = async (k, kind, id, obj) => 'x1:' + JSON.stringify(obj);`,
  };
  const urls = Object.fromEntries(Object.entries(fakes).map(([k, src]) => [k, 'data:text/javascript,' + encodeURIComponent(src)]));
  register('data:text/javascript,' + encodeURIComponent(`const urls = ${JSON.stringify(urls)};
    export async function resolve(spec, ctx, next) {
      if (ctx.parentURL && ctx.parentURL.endsWith('/recall-host.js') && urls[spec]) return { url: urls[spec], shortCircuit: true };
      return next(spec, ctx);
    }`));
  const handlers = [];
  Object.assign(globalThis, {
    addEventListener: (type, fn) => { if (type === 'message') handlers.push(fn); },
    document: { querySelector: () => null, body: { append() {} } },
    getComputedStyle: () => ({ backgroundColor: 'rgb(20, 20, 20)', borderBottomLeftRadius: '0px' }),
    requestAnimationFrame: () => 1,
  });
  const { createRecall } = await import(require('node:url').pathToFileURL(path.join(ROOT, 'public/js/recall-host.js')).href);

  // A server with 600 rows: deleted decks first, then a deck using a picture, the picture and the profile on page 2.
  const enc = (o) => 'x1:' + JSON.stringify(o);
  const rows = [];
  for (let i = 0; i < 590; i++) rows.push({ id: `old-${i}`, kind: 'deck', data: null, deleted: true });
  rows.push({ id: 'r-a', kind: 'deck', data: enc({ id: 'a', cards: [{ term: 't', termImg: 'hearth-img:img-1' }] }) });
  rows.push({ id: 'img-1', kind: 'img', data: enc({ data: 'data:image/png;base64,AAAA' }) });
  rows.push({ id: 'recall-profile', kind: 'settings', data: enc({ updatedAt: 5, courses: ['Biology'] }) });
  rows.forEach((r, i) => { r.updatedAt = 1000 + i; r.deleted = !!r.deleted; });

  const run = async ({ failSecondPage = false, busyFirst = false } = {}) => {
    const calls = []; const posted = []; let gets = 0; let clock = 5000;
    const win = { postMessage: (m) => posted.push(m) };
    globalThis.__recall = {
      toasts: [],
      h: (tag) => ({ tag, style: {}, append() {}, isConnected: true, contentWindow: tag === 'iframe' ? win : undefined, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }),
      api: async (method, p, body) => {
        calls.push([method, p, body]);
        if (method !== 'GET') return { updatedAt: ++clock };
        gets++;
        if (failSecondPage && gets === 2) throw new Error('network down');
        if (busyFirst && gets === 1) throw Object.assign(new Error('Too many attempts. Try again in 1 seconds.'), { status: 429, retryAfter: 1 });
        const since = Number(new URL(p, 'http://x').searchParams.get('since'));
        const rest = rows.filter((r) => r.updatedAt > since);
        return { items: rest.slice(0, 500), more: rest.length > 500, now: Date.now() };
      },
    };
    handlers.length = 0;
    const recall = createRecall({ S: { me: { publicKey: 'pk', studyEnabled: true }, privateKey: 'sk' }, onEnabled() {} });
    recall.view(); // opens the frame
    const own = handlers.slice(); // this instance's message listener (later runs add their own)
    const send = (data) => { for (const fn of own) fn({ source: win, data: { recall: 1, ...data } }); };
    send({ t: 'ready' });
    for (let i = 0; i < 300 && !posted.length && !globalThis.__recall.toasts.length; i++) await sleep(10);
    return { calls, posted, toasts: globalThis.__recall.toasts, recall, send, gets: () => gets };
  };

  const ok = await run();
  assert.equal(ok.calls.filter(([m]) => m === 'GET').length, 2, 'both pages fetched');
  assert.ok(ok.calls.every(([m, p]) => m !== 'GET' || p.includes('paged=1')));
  const init = ok.posted.find((m) => m.t === 'init');
  assert.ok(init, 'Recall opened');
  assert.deepEqual(init.state.profile, { updatedAt: 5, courses: ['Biology'] }, 'the real profile, not a blank one');
  assert.equal(init.state.decks[0].cards[0].termImg, 'data:image/png;base64,AAAA');
  assert.ok(!ok.calls.some(([m, p]) => m === 'PUT' && p.endsWith('/recall-profile')), 'the profile is never overwritten');

  // A page that fails on the first load stops everything: no half-list migration or clean-up.
  const bad = await run({ failSecondPage: true });
  assert.ok(!bad.posted.some((m) => m.t === 'init'));
  assert.ok(!bad.calls.some(([m]) => m === 'PUT' || m === 'DELETE'));
  assert.match(String(bad.toasts[0] && bad.toasts[0][0]), /network down/);

  // Busy server on the first load (a 429): it waits as told and opens, instead of failing until a reload.
  const busy = await run({ busyFirst: true });
  assert.ok(busy.posted.some((m) => m.t === 'init'), 'Recall opened after waiting');
  assert.equal(busy.toasts.length, 0);
  assert.equal(busy.calls.filter(([m]) => m === 'GET').length, 3);

  // Changes elsewhere. This tab's own saves come back as study:changed too: those don't make it sync. Others are
  // fetched at most once a second, and only what really changed goes to Recall.
  const live = await run(); // the fakes talk to the newest instance
  const gets = live.gets();
  live.send({ t: 'profile', profile: { updatedAt: 9, courses: ['Chemistry'] } });
  await sleep(1100); // saves wait 900 ms for more changes
  const put = live.calls.find(([m, p]) => m === 'PUT' && p.endsWith('/recall-profile'));
  assert.ok(put, 'the profile was saved');
  const own = 5000 + live.calls.filter(([m]) => m !== 'GET').length;
  live.recall.onRemoteChange({ since: own - 1 });
  await sleep(1200);
  assert.equal(live.gets(), gets, 'no sync for its own save');
  // The server now has that save and a new deck from another device; three changes in a burst mean one request.
  rows.push({ id: 'recall-profile', kind: 'settings', data: enc({ updatedAt: 9, courses: ['Chemistry'] }), updatedAt: own, deleted: false });
  rows.push({ id: 'r-b', kind: 'deck', data: enc({ id: 'b', cards: [] }), updatedAt: own + 1, deleted: false });
  const before = live.posted.length;
  for (let i = 0; i < 3; i++) live.recall.onRemoteChange({ since: own });
  await sleep(1200);
  assert.equal(live.gets(), gets + 1, 'one sync for the burst');
  const remote = live.posted.slice(before).filter((m) => m.t === 'remote');
  assert.equal(remote.length, 1);
  assert.deepEqual(remote[0].decks.map((x) => x.id), ['b']);
  assert.equal(remote[0].profile, null, 'its own profile isn\u2019t sent back to Recall as a change');
});

// ------------------------------------------------------------------ data-4 / data-14: upgrades and downgrades
const copies = (s, v) => (fs.existsSync(path.join(s.dir, 'backups')) ? fs.readdirSync(path.join(s.dir, 'backups')).filter((f) => f.startsWith(`hearth-before-v${v}-`)) : []);
const version = (s) => { const d = s.db(); try { return d.pragma('user_version', { simple: true }); } finally { d.close(); } };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const stopChild = async (s) => { s.child.kill('SIGTERM'); for (let i = 0; i < 100 && s.child.exitCode === null; i++) await sleep(50); };

test('an upgrade that was cut short (old version number on a newer schema) starts, keeps sign-ins, copies once', async () => {
  const s = await startServer();
  try {
    const v = version(s);
    assert.ok(v >= 16);
    const u = await s.register();
    for (const from of [11, 0]) {
      s.sql(`PRAGMA user_version = ${from}`);
      await s.restart();
      assert.equal(version(s), v, `from ${from}`);
      assert.equal((await s.api('GET', '/me/sessions', { token: u.token, ip: u.ip })).status, 200, 'the session still works');
    }
    assert.equal(copies(s, v).length, 2, 'one copy per real upgrade');
    await s.restart();
    assert.equal(copies(s, v).length, 2, 'none when nothing is upgraded');
  } finally { await s.stop(); }
});

test('a failing upgrade changes nothing, isn’t copied again on every restart, and finishes once fixed', async () => {
  const s = await startServer();
  try {
    const v = version(s);
    const u = await s.register();
    const srvRow = (await s.api('POST', '/servers', { token: u.token, ip: u.ip, body: { name: 'Old' } })).json;
    // A pre-v5 database: a legacy "admin" member, waiting for the one-time move to roles. Something in the way makes a
    // later step fail (here: a table where the v16 index has to go).
    s.sql("UPDATE members SET role = 'admin' WHERE server_id = ?", srvRow.id);
    s.sql('PRAGMA user_version = 4');
    s.sql('DROP INDEX idx_memberships_server_user');
    s.sql('CREATE TABLE idx_memberships_server_user (x)');
    const admins = () => s.sql("SELECT COUNT(*) n FROM roles WHERE server_id = ? AND name = 'Admin'", srvRow.id)[0].n;
    for (let i = 0; i < 3; i++) {
      await assert.rejects(s.restart(), /didn't start/);
      assert.match(s.log, /already a table named idx_memberships_server_user/);
      assert.equal(version(s), 4, 'still the old version');
      assert.equal(admins(), 0, 'the roles step was rolled back with the rest');
      assert.equal(copies(s, v).length, 1, `attempt ${i + 1}: still just one copy`);
    }
    // A different database put in its place (here: changed, then its old dates put back, as tar or cp -p would)
    // is copied again before the next attempt.
    s.sql("INSERT INTO instance_settings (key, value) VALUES ('marker', 'swapped')");
    const old = new Date(Date.now() - 3600000);
    fs.utimesSync(path.join(s.dir, 'hearth.db'), old, old);
    await assert.rejects(s.restart(), /didn't start/);
    assert.equal(copies(s, v).length, 2);
    s.sql('DROP TABLE idx_memberships_server_user');
    await s.restart();
    assert.equal(version(s), v);
    assert.equal(admins(), 1);
    assert.equal(s.sql("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'index' AND name = 'idx_memberships_server_user'")[0].n, 1);
    assert.equal((await s.api('GET', '/me/sessions', { token: u.token, ip: u.ip })).status, 200);
    // The copy is a complete database from before the upgrade.
    const D = require('better-sqlite3');
    const c = new D(path.join(s.dir, 'backups', copies(s, v).sort()[0]), { readonly: true });
    try { assert.equal(c.pragma('user_version', { simple: true }), 4); assert.equal(c.pragma('integrity_check', { simple: true }), 'ok'); } finally { c.close(); }
  } finally { await s.stop(); }
});

test('a database from a newer Hearth is refused at start-up, untouched; backups from one get a warning', async () => {
  const s = await startServer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-newer-'));
  const cli = (args) => {
    const r = spawnSync(process.execPath, ['server/cli.js', ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  try {
    const v = version(s);
    const backup = async () => {
      const r = await s.api('POST', '/admin/backups', { token: s.owner.token, ip: s.owner.ip, body: {} });
      assert.equal(r.status, 200, r.text);
      return path.join(s.dir, 'backups', 'encrypted', r.json.name);
    };
    const key = () => fs.readFileSync(path.join(s.dir, 'backup.key'), 'utf8').trim();
    // A backup of this version restores without a warning.
    const same = await backup();
    const plain = cli(['restore', same, path.join(tmp, 'same'), key()]);
    assert.equal(plain.code, 0, plain.err);
    assert.doesNotMatch(plain.err, /newer version/);

    s.sql('PRAGMA user_version = 99');
    const newer = await backup();
    const verify = cli(['verify-backup', newer, key()]);
    assert.match(verify.out, /Restore test passed.*database version 99/);
    assert.match(verify.err, /newer version of Hearth \(database version 99; this version understands up to \d+\)/);
    const restore = cli(['restore', newer, path.join(tmp, 'newer'), key()]);
    assert.equal(restore.code, 2);
    assert.match(restore.err, /newer version of Hearth/);
    // Reading the version leaves nothing behind in the new data folder (opening it with SQLite left -wal and -shm).
    for (const dir of ['same', 'newer']) assert.deepEqual(fs.readdirSync(path.join(tmp, dir)).filter((f) => /-(wal|shm)$/.test(f)), [], dir);

    await stopChild(s);
    const db = path.join(s.dir, 'hearth.db');
    const before = sha(db);
    await assert.rejects(s.restart(), /didn't start/);
    assert.match(s.log, /written by a newer version of Hearth \(database version 99; this version understands up to \d+\)/);
    assert.match(s.log, /hearth-before-v99-/);
    assert.equal(sha(db), before, 'the file is untouched');
    assert.equal(version(s), 99);
    assert.equal(copies(s, v).length + copies(s, 99).length, 0, 'no upgrade copy either');
    // Back to a version it knows: it starts again.
    s.sql(`PRAGMA user_version = ${v}`);
    await s.restart();
    assert.equal((await s.api('GET', '/config')).status, 200);
  } finally { await s.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
