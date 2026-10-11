// Thread unread counts and the Threads list per channel (server/usability.js, thread_activity in server/db.js).
// Each thread has its own read marker (t:<root>), synced like a channel's; pings in a thread count in the channel's
// badge until the thread is read; GET /channels/:id/threads lists a channel's threads by latest reply. Checked just
// as much for what they refuse: other people's markers, channels you can't read, bad input, too many requests.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, hex, sleep } = require('./helpers');

const P = { VIEW: 1, SEND: 2, MENTION_EVERYONE: 16, CREATE_THREADS: 1 << 15 };
const DENIED = [401, 403, 404];
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');

let srv; let boss; let server; let code;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const user = async (name) => {
  const u = await srv.register(`${name}${hex(3)}`);
  const r = await as(u, 'POST', `/invites/${code}/join`);
  assert.equal(r.status, 200, r.text);
  return u;
};
const room = async (name = 'room') => {
  const r = await as(boss, 'POST', `/servers/${server.id}/channels`, { name: `${name}${hex(2)}`, type: 'text' });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const freshEpoch = () => srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', server.id);
const send = async (u, channelId, extra = {}) => {
  freshEpoch();
  const r = await as(u, 'POST', `/channels/${channelId}/messages`, { ciphertext: cipher(), epoch: 1, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
};
const reply = (u, channelId, rootId, extra = {}) => send(u, channelId, { threadId: rootId, ...extra });
const unread = async (u, channelId) => (await as(u, 'GET', '/me/unread')).json.states['c:' + channelId];
const threads = async (u, channelId, q = '') => {
  const r = await as(u, 'GET', `/channels/${channelId}/threads${q}`);
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
const readThread = (u, rootId, messageId, extra = {}) => as(u, 'POST', '/me/read', { conv: 't:' + rootId, messageId, ...extra });

before(async () => {
  srv = await startServer();
  boss = srv.owner;
  server = (await as(boss, 'POST', '/servers', { name: 'Threads HQ' })).json;
  code = (await as(boss, 'POST', `/servers/${server.id}/invites`, { expiresHours: 0 })).json.code;
});
after(async () => {
  socks.forEach((s) => s.close());
  await srv.stop();
});

// ------------------------------------------------------------------ the Threads list
test('threads list: latest reply first, paged, with reply counts, participants and your own unread counts', async () => {
  const ann = await user('ann'); const ben = await user('ben');
  const ch = await room('list');
  await as(ann, 'GET', '/me/unread'); // ann's baseline: everything before this counts as read
  await sleep(5);
  const r1 = await send(boss, ch.id); const r2 = await send(boss, ch.id); const r3 = await send(boss, ch.id);
  await send(boss, ch.id); // no replies: not a thread
  await reply(ben, ch.id, r1); await reply(ben, ch.id, r1);
  await reply(ann, ch.id, r2);
  await reply(ben, ch.id, r3);
  const last1 = await reply(boss, ch.id, r1);

  let list = await threads(ann, ch.id);
  assert.deepEqual(list.threads.map((t) => t.rootId), [r1, r3, r2], 'the thread with the newest reply comes first');
  assert.equal(list.hasMore, false);
  const [t1, t3, t2] = list.threads;
  assert.equal(t1.replyCount, 3);
  assert.equal(t1.lastReplyId, last1);
  assert.ok(t1.lastReplyAt > 0);
  assert.deepEqual(t1.participants, [boss.id, ben.id], 'people who replied, most recent first, once each');
  assert.equal(t1.unread, 3, 'replies from others since ann’s baseline');
  assert.equal(t2.unread, 0, 'ann’s own reply doesn’t count');
  assert.equal(t3.unread, 1);
  assert.equal(t1.mentions, 0);
  assert.equal(t1.root.id, r1);
  assert.match(t1.root.ciphertext, /^v2:/, 'the first message comes as ciphertext, for the app to decrypt');
  assert.equal(t1.root.threadCount, 3);
  assert.equal(JSON.stringify(list).includes('"body"'), false);

  // A page at a time, by the latest reply's id.
  const p1 = await threads(ann, ch.id, '?limit=2');
  assert.deepEqual(p1.threads.map((t) => t.rootId), [r1, r3]);
  assert.equal(p1.hasMore, true);
  const p2 = await threads(ann, ch.id, `?limit=2&before=${p1.next}`);
  assert.deepEqual(p2.threads.map((t) => t.rootId), [r2]);
  assert.equal(p2.hasMore, false);
  assert.equal((await threads(ann, ch.id, '?limit=-5')).threads.length, 1, 'a limit below 1 is 1');
  assert.ok((await threads(ann, ch.id, '?limit=100000')).threads.length <= 50);
  for (const q of ['?before=x%20y', '?before=' + 'a'.repeat(65), '?before=%27%20OR%201%3D1']) {
    assert.equal((await as(ann, 'GET', `/channels/${ch.id}/threads${q}`)).status, 400, q);
  }
  // A new reply moves its thread to the top, live counts follow.
  await reply(ben, ch.id, r2);
  list = await threads(ann, ch.id);
  assert.deepEqual(list.threads.map((t) => t.rootId), [r2, r1, r3]);
  assert.equal(list.threads[0].unread, 1);
  // Voice channels have no threads.
  const voice = (await as(boss, 'POST', `/servers/${server.id}/channels`, { name: 'talk', type: 'voice' })).json;
  assert.equal((await as(ann, 'GET', `/channels/${voice.id}/threads`)).status, 400);
  // An empty channel lists nothing.
  const empty = await room('empty');
  assert.deepEqual(await threads(ann, empty.id), { threads: [], hasMore: false, next: null, threadMentions: 0 });
});

// ------------------------------------------------------------------ thread read markers
test('thread read markers: yours only, synced to your devices, forward only, and reading the channel leaves them alone', async () => {
  const cat = await user('cat'); const dan = await user('dan'); const out = await srv.register(`out${hex(3)}`);
  const ch = await room('marks');
  await as(cat, 'GET', '/me/unread');
  await sleep(5);
  const root = await send(boss, ch.id);
  const a = await reply(dan, ch.id, root); const b = await reply(dan, ch.id, root); const c = await reply(boss, ch.id, root);
  const other = await send(boss, ch.id);
  const otherReply = await reply(dan, ch.id, other);

  // The channel's messages carry your state for the threads they start.
  let page = (await as(cat, 'GET', `/channels/${ch.id}/messages`)).json;
  assert.equal(page.threads[root].unread, 3);
  assert.equal(page.threads[root].lastId, c);
  assert.equal(page.threads[other].unread, 1);
  assert.equal(Object.keys(page.threads).length, 2, 'only messages that start a thread');
  // Reading the channel (as scrolling to the bottom does) leaves its threads unread.
  assert.equal((await as(cat, 'POST', '/me/read', { conv: 'c:' + ch.id, messageId: other })).status, 200);
  assert.equal((await threads(cat, ch.id)).threads.find((t) => t.rootId === root).unread, 3);

  const c1 = await sock(cat); const c2 = await sock(cat); const d1 = await sock(dan);
  const ev = collect(c2, 'read:update'); const evd = collect(d1, 'read:update');
  let r = await readThread(cat, root, b);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.conv, 't:' + root);
  assert.equal(r.json.rootId, root);
  assert.equal(r.json.channelId, ch.id);
  assert.equal(r.json.lastReadId, b);
  assert.equal(r.json.unread, 1);
  assert.equal(r.json.threadMentions, 0);
  await sleep(200);
  assert.ok(ev.some((e) => e.conv === 't:' + root && e.lastReadId === b), 'cat’s other device is told');
  assert.equal(evd.length, 0, 'dan isn’t');
  // Forward only, and no "Mark unread" for threads.
  r = await readThread(cat, root, a);
  assert.equal(r.json.lastReadId, b, 'an older marker from a slow device doesn’t undo progress');
  assert.equal((await readThread(cat, root, a, { unread: true })).status, 400);
  r = await readThread(cat, root, c);
  assert.equal(r.json.unread, 0);
  assert.equal((await threads(cat, ch.id)).threads.find((t) => t.rootId === root).unread, 0);
  assert.equal((await threads(dan, ch.id)).threads.find((t) => t.rootId === root).unread, 1, 'dan’s marker is dan’s: boss’s reply is new to him');
  // Opening the thread shows where it was read up to.
  assert.equal((await as(cat, 'GET', `/messages/${root}/thread`)).json.state.lastReadId, c);

  // The marker must be a reply in that very thread.
  for (const [conv, messageId] of [[root, otherReply], [root, root], [root, other], [root, '0'], [root, ''], [root, 'nope'], [a, c], ['nope', c]]) {
    assert.equal((await readThread(cat, conv, messageId)).status, 404, `${conv} ${messageId}`);
  }
  for (const bad of [{ conv: 't:', messageId: c }, { conv: 't:' + 'a'.repeat(65), messageId: c }, { conv: ['t:' + root], messageId: c }, { conv: 'T:' + root, messageId: c }]) {
    assert.ok([400, 404].includes((await as(cat, 'POST', '/me/read', bad)).status), JSON.stringify(bad));
  }
  // Someone who isn't in the server: nothing to read, and nothing stored.
  assert.equal((await readThread(out, root, c)).status, 404);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM read_states WHERE user_id = ?', out.id)[0].n, 0);

  // Replying reads the thread up to your reply, and your other devices hear about it.
  const evc = collect(c1, 'read:update');
  await reply(dan, ch.id, other);
  assert.equal((await threads(cat, ch.id)).threads.find((t) => t.rootId === other).unread, 2);
  const mine = await reply(cat, ch.id, other);
  await sleep(200);
  assert.ok(evc.some((e) => e.conv === 't:' + other && e.lastReadId === mine && e.unread === 0), 'sending marks the thread read');
  assert.equal((await threads(cat, ch.id)).threads.find((t) => t.rootId === other).unread, 0);
});

// ------------------------------------------------------------------ pings in threads
test('thread pings count in the channel badge until the thread is read; “Mark as read” clears them', async () => {
  const eva = await user('eva'); const fox = await user('fox'); const gus = await user('gus');
  const ch = await room('pings');
  await as(eva, 'GET', '/me/unread'); await as(boss, 'GET', '/me/unread');
  await sleep(5);
  const root = await send(boss, ch.id);
  const evaMsg = await reply(eva, ch.id, root);
  await reply(fox, ch.id, root, { mentions: [eva.id] });
  await reply(fox, ch.id, root, { replyTo: evaMsg });
  await reply(gus, ch.id, root); // a plain reply: new, not a ping
  let st = await unread(eva, ch.id);
  assert.equal(st.mentions, 0, 'the channel’s own mentions are top-level messages');
  assert.equal(st.threadMentions, 2, 'a mention and a reply to eva, in a thread');
  assert.equal(st.unread, 1, 'thread replies don’t make the channel itself unread (only boss’s first message)');
  // The person who started the thread isn't pinged by every reply: the thread's unread count shows them.
  assert.equal((await unread(boss, ch.id)).threadMentions, 0);
  assert.equal((await threads(boss, ch.id)).threads[0].unread, 4);
  let t = (await threads(eva, ch.id)).threads[0];
  assert.equal(t.mentions, 2);
  assert.equal(t.unread, 3);

  // Reading the channel doesn't clear a thread's pings; opening the thread does. A plain read doesn't work the
  // count out at all (it can't have changed it, and the app keeps what it has).
  const top = await send(boss, ch.id);
  let r = await as(eva, 'POST', '/me/read', { conv: 'c:' + ch.id, messageId: top });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.threadMentions, undefined);
  assert.equal((await unread(eva, ch.id)).threadMentions, 2);
  // Opening the thread (or the Threads panel) tells the app the channel's count too.
  assert.equal((await as(eva, 'GET', `/messages/${root}/thread`)).json.state.threadMentions, 2);
  assert.equal((await threads(eva, ch.id)).threadMentions, 2);
  const lastReply = (await threads(eva, ch.id)).threads[0].lastReplyId;
  r = await readThread(eva, root, lastReply);
  assert.equal(r.json.mentions, 0);
  assert.equal(r.json.threadMentions, 0, 'the answer carries the channel’s new badge');
  assert.equal((await unread(eva, ch.id)).threadMentions, 0);

  // "Mark as read" on the channel (threads: true) takes its threads with it.
  const root2 = await send(boss, ch.id);
  await reply(fox, ch.id, root2, { mentions: [eva.id] });
  await reply(fox, ch.id, root, { mentions: [eva.id] });
  assert.equal((await unread(eva, ch.id)).threadMentions, 2);
  const evs = collect(await sock(eva), 'read:update');
  r = await as(eva, 'POST', '/me/read', { conv: 'c:' + ch.id, messageId: root2, threads: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.threadMentions, 0);
  assert.ok(r.json.threadsRead, 'says up to where the threads were read');
  await sleep(200);
  assert.ok(evs.some((e) => e.conv === 'c:' + ch.id && e.threadsRead === r.json.threadsRead), 'other devices clear their thread badges too');
  for (const x of (await threads(eva, ch.id)).threads) { assert.equal(x.unread, 0); assert.equal(x.mentions, 0); }
  // Later replies are new again, and the thread's own marker still moves on from there.
  await reply(fox, ch.id, root, { mentions: [eva.id] });
  t = (await threads(eva, ch.id)).threads[0];
  assert.equal(t.unread, 1); assert.equal(t.mentions, 1);
  // A whole server marked read takes every channel's threads with it.
  r = await as(eva, 'POST', `/servers/${server.id}/read`);
  assert.equal(r.status, 200);
  assert.equal(r.json.states.find((s) => s.conv === 'c:' + ch.id).threadMentions, 0);
  assert.equal((await unread(eva, ch.id)).threadMentions, 0);
  assert.equal((await threads(eva, ch.id)).threads[0].unread, 0);
});

test('thread pings: @everyone counts only from someone allowed to use it, and can be suppressed', async () => {
  const hal = await user('hal'); const loud = await user('loud'); const meek = await user('meek');
  const role = (await as(boss, 'POST', `/servers/${server.id}/roles`, { name: 'Crier', permissions: P.VIEW | P.SEND | P.MENTION_EVERYONE | P.CREATE_THREADS })).json;
  assert.equal((await as(boss, 'PUT', `/servers/${server.id}/members/${loud.id}/roles`, { roleIds: [role.id] })).status, 200);
  const ch = await room('crier');
  await as(hal, 'GET', '/me/unread');
  await sleep(5);
  const root = await send(boss, ch.id);
  await reply(meek, ch.id, root, { everyone: true });
  assert.equal((await unread(hal, ch.id)).threadMentions, 0, 'no Mention Everyone: not a ping');
  await reply(loud, ch.id, root, { everyone: true });
  assert.equal((await unread(hal, ch.id)).threadMentions, 1);
  assert.equal((await threads(hal, ch.id)).threads[0].mentions, 1);
  assert.equal((await as(hal, 'PUT', `/me/notify/c:${ch.id}`, { suppressEveryone: true })).status, 200);
  assert.equal((await unread(hal, ch.id)).threadMentions, 0, 'suppressed');
  assert.equal((await threads(hal, ch.id)).threads[0].mentions, 0);
  // The sender's own @everyone isn't a ping to them: replying read the thread up to it.
  assert.equal((await unread(loud, ch.id)).threadMentions, 0);
});

// ------------------------------------------------------------------ permissions
test('private channels: their threads, markers and pings never reach people who can’t read them', async () => {
  const ivy = await user('ivy'); const jon = await user('jon');
  const role = (await as(boss, 'POST', `/servers/${server.id}/roles`, { name: 'Insiders', permissions: P.VIEW | P.SEND | P.CREATE_THREADS })).json;
  assert.equal((await as(boss, 'PUT', `/servers/${server.id}/members/${ivy.id}/roles`, { roleIds: [role.id] })).status, 200);
  const ch = await room('secret');
  assert.equal((await as(boss, 'PUT', `/channels/${ch.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: role.id, allow: P.VIEW, deny: 0 }] })).status, 200);
  await as(jon, 'GET', '/me/unread');
  await sleep(5);
  const root = await send(boss, ch.id);
  const rep = await reply(ivy, ch.id, root, { mentions: [jon.id, boss.id] });

  // jon can't see the channel: "not found", exactly as for a channel that doesn't exist.
  const hidden = await as(jon, 'GET', `/channels/${ch.id}/threads`);
  const missing = await as(jon, 'GET', '/channels/nosuchchannel/threads');
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.json, missing.json);
  assert.equal((await readThread(jon, root, rep)).status, 404);
  assert.deepEqual((await readThread(jon, root, rep)).json, (await readThread(jon, 'nosuchroot', rep)).json, 'a thread you can’t see looks like one that doesn’t exist');
  assert.equal((await unread(jon, ch.id)), undefined, 'no counts for channels you can’t see');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM mention_marks WHERE user_id = ?', jon.id)[0].n, 0, 'a ping to someone who can’t see the channel isn’t kept');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM read_states WHERE user_id = ? AND conv LIKE ?', jon.id, 't:%')[0].n, 0);
  assert.equal((await unread(boss, ch.id)).threadMentions, 1, 'boss can see it: pinged');
  // Losing access: the list goes with it.
  assert.equal((await threads(ivy, ch.id)).threads.length, 1);
  assert.equal((await as(boss, 'PUT', `/servers/${server.id}/members/${ivy.id}/roles`, { roleIds: [] })).status, 200);
  assert.ok(DENIED.includes((await as(ivy, 'GET', `/channels/${ch.id}/threads`)).status));
  assert.ok(DENIED.includes((await readThread(ivy, root, rep)).status));
  // Not signed in.
  assert.equal((await srv.api('GET', `/channels/${ch.id}/threads`)).status, 401);
});

test('a deleted ping stops counting: opening the thread or the Threads panel says so', async () => {
  const ola = await user('ola'); const pip = await user('pip');
  const ch = await room('oops');
  await as(ola, 'GET', '/me/unread');
  await sleep(5);
  const root = await send(pip, ch.id);
  const first = await reply(pip, ch.id, root);
  assert.equal((await readThread(ola, root, first)).status, 200);
  const ping = await reply(pip, ch.id, root, { mentions: [ola.id] });
  assert.equal((await unread(ola, ch.id)).threadMentions, 1);
  assert.equal((await as(pip, 'DELETE', `/messages/${ping}`)).status, 200);
  assert.equal((await unread(ola, ch.id)).threadMentions, 0);
  const st = (await as(ola, 'GET', `/messages/${root}/thread`)).json.state;
  assert.equal(st.threadMentions, 0, 'the app sets the channel’s badge from this when the thread is opened');
  assert.equal(st.unread, 0);
  assert.equal(st.mentions, 0);
  const list = await threads(ola, ch.id);
  assert.equal(list.threadMentions, 0);
  // Only the first page carries it (older pages are about older threads).
  assert.equal((await threads(ola, ch.id, `?before=${list.next}`)).threadMentions, undefined);
});

test('thread pings: the count looks at your newest 500 in the channel, however many old ones there are', async () => {
  const pat = await user('pat'); const fox = await user('fox');
  const ch = await room('flood');
  await as(pat, 'GET', '/me/unread');
  await sleep(5);
  // An old ping pat hasn't read, in thread A.
  const a = await send(boss, ch.id);
  await reply(fox, ch.id, a, { mentions: [pat.id] });
  // Thread B: one real ping (the row's shape), then 600 more stored the same way, all of them read.
  const b = await send(boss, ch.id);
  const real = await reply(fox, ch.id, b, { mentions: [pat.id] });
  const shape = srv.sql('SELECT conv, thread_id FROM mention_marks WHERE message_id = ? AND user_id = ?', real, pat.id)[0];
  assert.deepEqual(shape, { conv: 'ct:' + ch.id, thread_id: b });
  const d = srv.db();
  try {
    const ins = d.prepare('INSERT INTO mention_marks (message_id, conv, user_id, thread_id) VALUES (?, ?, ?, ?)');
    // Ids just after the real ping's (same prefix), so they sort between it and the next message.
    d.transaction(() => { for (let i = 0; i < 600; i++) ins.run(`${real}~${String(i).padStart(4, '0')}`, shape.conv, pat.id, b); })();
  } finally { d.close(); }
  const lastB = await reply(fox, ch.id, b);
  assert.equal((await readThread(pat, b, lastB)).status, 200);
  // The 601 pings in B are read, so the walk ends before it reaches A's: the badge leaves it out, and A's own
  // count (on its message and in the Threads panel) still shows it.
  assert.equal((await unread(pat, ch.id)).threadMentions, 0);
  assert.equal((await threads(pat, ch.id)).threads.find((t) => t.rootId === a).mentions, 1);
  // A newer ping counts as usual.
  const c = await send(boss, ch.id);
  await reply(fox, ch.id, c, { mentions: [pat.id] });
  assert.equal((await unread(pat, ch.id)).threadMentions, 1);
  // Reading the channel doesn't count them at all.
  const r = await as(pat, 'POST', '/me/read', { conv: 'c:' + ch.id, messageId: c });
  assert.equal(r.json.threadMentions, undefined);
});

// ------------------------------------------------------------------ rate limits
test('the threads list is rate limited per person', async () => {
  const kim = await user('kim');
  const ch = await room('busy');
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await as(kim, 'GET', `/channels/${ch.id}/threads`)).status;
  assert.equal(last, 429);
  assert.equal((await as(boss, 'GET', `/channels/${ch.id}/threads`)).status, 200, 'someone else isn’t held up');
});

// ------------------------------------------------------------------ thread_activity follows every change
test('the list stays right as replies, threads and channels are deleted, and is rebuilt after an upgrade', async () => {
  const leo = await user('leo');
  const ch = await room('churn');
  const r1 = await send(leo, ch.id); const r2 = await send(leo, ch.id); const r3 = await send(leo, ch.id);
  const a1 = await reply(leo, ch.id, r1); const b1 = await reply(leo, ch.id, r2);
  const a2 = await reply(leo, ch.id, r1); await reply(leo, ch.id, r3);
  const order = async () => (await threads(boss, ch.id)).threads.map((t) => [t.rootId, t.lastReplyId]);
  const r3last = (await threads(boss, ch.id)).threads[0].lastReplyId;
  assert.deepEqual(await order(), [[r3, r3last], [r1, a2], [r2, b1]]);
  // Deleting a thread's newest reply: it goes back to the one before.
  assert.equal((await as(leo, 'DELETE', `/messages/${a2}`)).status, 200);
  assert.deepEqual(await order(), [[r3, r3last], [r2, b1], [r1, a1]]);
  // Its only reply gone: no longer a thread.
  assert.equal((await as(leo, 'DELETE', `/messages/${b1}`)).status, 200);
  assert.deepEqual(await order(), [[r3, r3last], [r1, a1]]);
  // The message that starts it gone (with its replies).
  assert.equal((await as(leo, 'DELETE', `/messages/${r3}`)).status, 200);
  assert.deepEqual(await order(), [[r1, a1]]);
  // Bulk delete by a moderator.
  const bulk = await as(boss, 'POST', `/channels/${ch.id}/messages/bulk-delete`, { ids: [r1] });
  assert.equal(bulk.status, 200, bulk.text);
  assert.deepEqual(await order(), []);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM thread_activity WHERE channel_id = ?', ch.id)[0].n, 0);

  // A deleted channel takes its rows with it.
  const gone = await room('gone');
  await reply(leo, gone.id, await send(leo, gone.id));
  assert.equal(srv.sql('SELECT COUNT(*) n FROM thread_activity WHERE channel_id = ?', gone.id)[0].n, 1);
  assert.equal((await as(boss, 'DELETE', `/channels/${gone.id}`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM thread_activity WHERE channel_id = ?', gone.id)[0].n, 0);

  // A database from before this table: it's filled from the replies already there when the server starts.
  const ch2 = await room('upgrade');
  const x = await send(leo, ch2.id); const y = await send(leo, ch2.id);
  await reply(leo, ch2.id, x); const ylast = await reply(leo, ch2.id, y); const xlast = await reply(leo, ch2.id, x);
  const want = await (async () => (await threads(boss, ch2.id)).threads.map((t) => [t.rootId, t.lastReplyId]))();
  assert.deepEqual(want, [[x, xlast], [y, ylast]]);
  srv.sql('DROP TABLE thread_activity');
  await srv.restart();
  assert.deepEqual((await threads(boss, ch2.id)).threads.map((t) => [t.rootId, t.lastReplyId]), want);
  await reply(leo, ch2.id, y);
  assert.equal((await threads(boss, ch2.id)).threads[0].rootId, y, 'and kept up to date after that');
});

// ------------------------------------------------------------------ query plans
test('thread queries use their indexes (no scans of a channel’s messages)', () => {
  const d = srv.db();
  try {
    const plan = (sql, ...args) => d.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' | ');
    const list = plan('SELECT root_id, last_reply_id FROM thread_activity WHERE channel_id = ? AND last_reply_id < ? ORDER BY last_reply_id DESC LIMIT ?', 'c', 'z', 26);
    assert.match(list, /idx_thread_activity_channel/);
    assert.doesNotMatch(list, /TEMP B-TREE/);
    assert.match(plan('SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE thread_id = ? AND id > ? AND author_id != ? LIMIT 100)', 'r', 'a', 'u'), /idx_messages_thread/);
    assert.match(plan("SELECT COUNT(*) AS n FROM (SELECT 1 FROM mention_marks WHERE thread_id = ? AND (user_id = ? OR (user_id = '*' AND ? = 1)) AND message_id > ? LIMIT 100)", 'r', 'u', 1, 'a'), /idx_mention_marks_thread/);
    // A channel's thread pings: yours and @everyone merged newest first from the index, so LIMIT 500 stops the walk
    // (a sort would read every one of them first).
    const marks = plan(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM (
        SELECT message_id, thread_id FROM mention_marks WHERE conv = ? AND user_id = ? AND message_id > ?
        UNION ALL SELECT message_id, thread_id FROM mention_marks WHERE conv = ? AND user_id = '*' AND ? = 1 AND message_id > ?
        ORDER BY message_id DESC LIMIT 500) mm
      WHERE mm.message_id > COALESCE((SELECT last_read_id FROM read_states WHERE user_id = ? AND conv = 't:' || mm.thread_id), '') LIMIT 100)`, 'ct:c', 'u', 'a', 'ct:c', 1, 'a', 'u');
    assert.match(marks, /MERGE \(UNION ALL\)/);
    assert.equal((marks.match(/SEARCH mention_marks USING (COVERING )?INDEX idx_mention_marks_conv \(conv=\? AND user_id=\? AND message_id>\?\)/g) || []).length, 2, marks);
    assert.doesNotMatch(marks, /TEMP B-TREE/);
    assert.match(marks, /read_states USING INDEX sqlite_autoindex_read_states_1/);
    assert.match(plan('SELECT MAX(id) AS id FROM messages WHERE channel_id = ?', 'c'), /idx_messages_channel/);
    // /me/unread asks this for every channel first: one step in the index.
    assert.match(plan('SELECT 1 FROM thread_activity WHERE channel_id = ? AND last_reply_id > ? LIMIT 1', 'c', 'a'), /COVERING INDEX idx_thread_activity_channel \(channel_id=\? AND last_reply_id>\?\)/);
  } finally { d.close(); }
});
