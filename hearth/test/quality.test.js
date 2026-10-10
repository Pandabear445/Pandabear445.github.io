// Server performance work (docs/PERFORMANCE.md): the v18 indexes and the query plans that use them, permissions
// worked out for many members at once, grouped server updates, batched key updates and member lists, the slowmode
// lookup and the shared grapheme segmenter. Every change is checked for the same answers as before and, where it
// touches access, that losing access still takes effect at once.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, hex, sleep } = require('./helpers');
const { makePerms, PERMS: P, ALL } = require('../server/perms');

let srv; let alice; let bob; let carol; let dave; let eve; let S; let general;
const as = (u, m, p, body) => srv.api(m, p, { token: u.token, ip: u.ip, body });
const cipher = () => 'v2:' + crypto.randomBytes(30).toString('base64');
const idAt = (n) => n.toString(36).padStart(9, '0') + hex(5); // time-sorted, like newId()
const freshEpoch = (sid = S.id) => srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', sid);
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(20); } return false; };
const collect = (sock, ev) => { const got = []; sock.on(ev, (p) => got.push(p)); return got; };
const sockets = [];
const connect = async (u) => { const s = await srv.socket(u.token); sockets.push(s); return s; };
const plan = (sql, ...args) => { const d = srv.db(); try { return d.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' | '); } finally { d.close(); } };

async function join(u, serverId) {
  const { code } = (await as(alice, 'POST', `/servers/${serverId}/invites`, {})).json;
  const r = await as(u, 'POST', `/invites/${code}/join`);
  assert.equal(r.status, 200, r.text);
  return r.json;
}
async function setRoles(u, roleIds, serverId = S.id) {
  const r = await as(alice, 'PUT', `/servers/${serverId}/members/${u.id}/roles`, { roleIds });
  assert.equal(r.status, 200, r.text);
}

before(async () => {
  srv = await startServer();
  alice = await srv.register('alice'); bob = await srv.register('bob'); carol = await srv.register('carol');
  dave = await srv.register('dave'); eve = await srv.register('eve');
  S = (await as(alice, 'POST', '/servers', { name: 'HQ' })).json;
  general = S.channels.find((c) => c.type === 'text');
  for (const u of [bob, carol, dave]) await join(u, S.id);
  freshEpoch();
});
after(async () => { sockets.forEach((s) => s.close()); await srv.stop(); });

// ------------------------------------------------------------------ schema
const V18 = {
  idx_messages_pins: { table: 'messages', cols: ['channel_id', 'pinned_at'], where: /WHERE pinned_at IS NOT NULL/ },
  idx_dm_messages_pins: { table: 'dm_messages', cols: ['dm_id', 'pinned_at'], where: /WHERE pinned_at IS NOT NULL/ },
  idx_messages_channel_top: { table: 'messages', cols: ['channel_id', 'id'], where: /WHERE thread_id IS NULL/ },
  idx_messages_created: { table: 'messages', cols: ['created_at'] },
  idx_dm_messages_created: { table: 'dm_messages', cols: ['created_at'] },
};
function checkIndexes(s) {
  const d = s.db();
  try {
    for (const [name, want] of Object.entries(V18)) {
      const row = d.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
      assert.ok(row, `${name} exists`);
      assert.equal(row.tbl_name, want.table);
      assert.deepEqual(d.prepare(`PRAGMA index_info(${name})`).all().map((c) => c.name), want.cols, name);
      if (want.where) assert.match(row.sql, want.where, `${name} is partial`);
    }
  } finally { d.close(); }
}

test('the database is at version 18 and has the v18 indexes', () => {
  const d = srv.db();
  try { assert.equal(d.pragma('user_version', { simple: true }), 18); } finally { d.close(); }
  checkIndexes(srv);
});

test('upgrading a version 17 database builds the v18 indexes, after a backup copy; a newer one is still refused', async () => {
  const s = await startServer();
  try {
    const u = await s.register();
    for (const name of Object.keys(V18)) s.sql(`DROP INDEX ${name}`);
    s.sql('PRAGMA user_version = 17');
    await s.restart();
    const d = s.db();
    try { assert.equal(d.pragma('user_version', { simple: true }), 18); } finally { d.close(); }
    checkIndexes(s);
    assert.equal(fs.readdirSync(path.join(s.dir, 'backups')).filter((f) => /^hearth-before-v18-.*\.db$/.test(f)).length, 1);
    assert.equal((await s.api('GET', '/me/sessions', { token: u.token, ip: u.ip })).status, 200, 'sign-ins survive the upgrade');
    // Restarting again changes nothing (the block is idempotent) and makes no second copy.
    await s.restart();
    checkIndexes(s);
    assert.equal(fs.readdirSync(path.join(s.dir, 'backups')).filter((f) => f.startsWith('hearth-before-v18-')).length, 1);
    // A database from a newer Hearth is still refused, untouched.
    s.sql('PRAGMA user_version = 19');
    await assert.rejects(s.restart(), /didn't start/);
    assert.match(s.log, /database version 19; this version understands up to 18/);
  } finally { await s.stop(); }
});

test('the hot statements use their indexes instead of reading whole tables', () => {
  const day = Date.now() - 86400000;
  const plans = {
    pins: plan('SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 50', 'c'),
    dmPins: plan('SELECT * FROM dm_messages WHERE dm_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 50', 'd'),
    newest: plan('SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT ?', 'c', 50),
    older: plan('SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?', 'c', 'z', 50),
    newer: plan('SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL AND id > ? ORDER BY id ASC LIMIT ?', 'c', 'a', 50),
    statsMessages: plan('SELECT COUNT(*) n FROM messages WHERE created_at >= ? AND created_at < ?', day, Date.now()),
    statsDms: plan('SELECT COUNT(*) n FROM dm_messages WHERE created_at >= ? AND created_at < ?', day, Date.now()),
    slowmode: plan('SELECT MAX(created_at) AS created_at FROM messages WHERE channel_id = ? AND author_id = ?', 'c', 'u'),
    keyStates: plan(`SELECT k.user_id, k.epoch, k.wrapped, k.wrapper_id, k.created_at, e.key_check FROM server_keys k
      JOIN server_epochs e ON e.server_id = k.server_id AND e.epoch = k.epoch
      WHERE k.server_id = ? AND k.user_id IN (SELECT value FROM json_each(?)) ORDER BY k.user_id, k.epoch`, 's', '["a"]'),
    memberRoles: plan(`SELECT mr.user_id, mr.role_id FROM member_roles mr JOIN members m ON m.server_id = mr.server_id AND m.user_id = mr.user_id
          WHERE mr.server_id = ?`, 's'),
    userRows: plan('SELECT * FROM users WHERE id IN (SELECT value FROM json_each(?))', '["a"]'),
  };
  for (const [name, p] of Object.entries(plans)) assert.doesNotMatch(p, /\bSCAN (messages|dm_messages|server_keys|member_roles|users|k|mr)\b/, `${name}: ${p}`);
  assert.match(plans.pins, /idx_messages_pins/);
  assert.match(plans.dmPins, /idx_dm_messages_pins/);
  for (const k of ['newest', 'older', 'newer']) assert.match(plans[k], /idx_messages_channel_top/, k);
  assert.match(plans.statsMessages, /COVERING INDEX idx_messages_created/);
  assert.match(plans.statsDms, /COVERING INDEX idx_dm_messages_created/);
  assert.match(plans.slowmode, /COVERING INDEX idx_messages_channel_author_time/);
  assert.match(plans.keyStates, /idx_server_keys_user/);
});

// ------------------------------------------------------------------ permissions for many members at once
test('perms.forServer gives exactly what perms.base and perms.channel give, for every member and channel', () => {
  const d = srv.db();
  try {
    const t = Date.now();
    let n = 0;
    const id = (p) => `${p}${hex(6)}`;
    const users = [];
    d.transaction(() => {
      for (let i = 0; i < 40; i++) {
        const u = id('pu');
        d.prepare("INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, created_at) VALUES (?, ?, 'x', 'k', 'e', ?)").run(u, u, t);
        users.push(u);
      }
    })();
    // A pseudo-random mix (fixed seed) of roles, held roles, @everyone/role/member overrides, an Administrator role,
    // a role from another server, an owner and a non-member, in a normal server and in a group.
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const bits = () => [P.VIEW_CHANNEL, P.SEND_MESSAGES, P.ATTACH_FILES, P.MANAGE_MESSAGES, P.CONNECT, P.KICK_MEMBERS].reduce((a, b) => (rnd() < 0.4 ? a | b : a), 0);
    for (const kind of ['server', 'group']) {
      const sid = id('ps');
      const other = id('ps');
      d.transaction(() => {
        for (const x of [sid, other]) {
          d.prepare('INSERT INTO servers (id, name, owner_id, created_at, kind) VALUES (?, ?, ?, ?, ?)').run(x, x, users[0], t, kind);
          d.prepare("INSERT INTO roles (id, server_id, name, position, permissions, created_at) VALUES (?, ?, '@everyone', 0, ?, ?)").run(x, x, kind === 'server' ? (rnd() < 0.5 ? 0 : P.VIEW_CHANNEL | P.SEND_MESSAGES) : 0, t);
        }
        const roles = [];
        for (let r = 0; r < 6; r++) { const rid = id('pr'); roles.push(rid); d.prepare("INSERT INTO roles (id, server_id, name, position, permissions, created_at) VALUES (?, ?, 'r', ?, ?, ?)").run(rid, sid, r + 1, r === 5 ? P.ADMINISTRATOR : bits(), t); }
        const foreign = id('pr');
        d.prepare("INSERT INTO roles (id, server_id, name, position, permissions, created_at) VALUES (?, ?, 'f', 1, ?, ?)").run(foreign, other, P.ADMINISTRATOR, t);
        const chans = [];
        for (let c = 0; c < 6; c++) { const cid = id('pc'); chans.push(cid); d.prepare("INSERT INTO channels (id, server_id, name, type, created_at) VALUES (?, ?, 'c', 'text', ?)").run(cid, sid, t); }
        users.slice(0, 35).forEach((u, i) => {
          d.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(sid, u, t + i);
          for (const rid of roles.slice(0, 5)) if (rnd() < 0.3) d.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, u, rid);
          if (i === 3) d.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, u, roles[5]); // Administrator
          if (i === 4) d.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, u, foreign); // another server's role
        });
        // A role row left behind by someone who isn't a member any more must not count.
        d.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, users[38], roles[5]);
        chans.forEach((cid, c) => {
          if (c === 0) return; // one channel without overrides
          if (rnd() < 0.7) d.prepare("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'role', ?, ?, ?)").run(cid, sid, bits(), bits());
          for (const rid of roles) if (rnd() < 0.4) d.prepare("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'role', ?, ?, ?)").run(cid, rid, bits(), bits());
          for (const u of users.slice(0, 40)) if (rnd() < 0.15) d.prepare("INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, 'member', ?, ?, ?)").run(cid, u, bits(), bits());
        });
      })();
      const perms = makePerms(d);
      const server = d.prepare('SELECT * FROM servers WHERE id = ?').get(sid);
      const chs = d.prepare('SELECT * FROM channels WHERE server_id = ?').all(sid);
      const everyone = perms.forServer(server);
      const some = perms.forServer(server, users.slice(0, 10));
      for (const u of users) {
        assert.equal(everyone.base(u), perms.base(server, u), `${kind} base ${u}`);
        assert.equal(some.base(u), perms.base(server, u), `${kind} base (some) ${u}`);
        for (const c of chs) {
          const want = perms.channel(server, c, u);
          assert.equal(everyone.channel(c, u), want, `${kind} channel ${c.id} ${u}`);
          assert.equal(some.channel(c, u), want, `${kind} channel (some) ${c.id} ${u}`);
          n++;
        }
      }
      // The data really covers the cases: someone with everything, and someone kept out of a channel.
      assert.equal(perms.base(server, users[0]), ALL);
      if (kind === 'server') {
        assert.equal(perms.base(server, users[3]), ALL, 'Administrator');
        assert.notEqual(perms.base(server, users[4]), ALL, 'another server’s Administrator role doesn’t count');
        assert.notEqual(perms.base(server, users[38]), ALL, 'a left-behind role doesn’t count');
        assert.ok(users.some((u) => chs.some((c) => perms.channel(server, c, u) === 0)), 'someone can’t see some channel');
      }
    }
    assert.ok(n > 400);
  } finally { d.close(); }
});

// ------------------------------------------------------------------ private channels: fan-out and losing access
test('a private channel’s messages reach only who can see it, and losing access (role, override, kick) takes effect at once', async () => {
  const s = (await as(alice, 'POST', '/servers', { name: 'Private' })).json;
  for (const u of [bob, carol, dave]) await join(u, s.id);
  const staff = (await as(alice, 'POST', `/servers/${s.id}/roles`, { name: 'Staff', permissions: 0 })).json.id;
  await setRoles(bob, [staff], s.id); await setRoles(carol, [staff], s.id);
  const ch = (await as(alice, 'POST', `/servers/${s.id}/channels`, { name: 'staff', type: 'text' })).json;
  const ov = (extra = []) => as(alice, 'PUT', `/channels/${ch.id}/overrides`, { overrides: [{ type: 'role', id: s.id, allow: 0, deny: P.VIEW_CHANNEL }, { type: 'role', id: staff, allow: P.VIEW_CHANNEL, deny: 0 }, ...extra] });
  assert.equal((await ov()).status, 200);
  freshEpoch(s.id);
  const got = {};
  for (const u of [bob, carol, dave]) got[u.username] = collect(await connect(u), 'message:new');
  const send = async () => {
    const r = await as(alice, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1 });
    assert.equal(r.status, 200, r.text);
    return r.json.id;
  };
  const has = (name, id) => got[name].some((m) => m.id === id);
  const settle = async (id, yes, no) => {
    for (const n of yes) assert.ok(await until(() => has(n, id)), `${n} gets ${id}`);
    await sleep(300);
    for (const n of no) assert.ok(!has(n, id), `${n} must not get ${id}`);
  };
  const history = (u) => as(u, 'GET', `/channels/${ch.id}/messages`);

  const m1 = await send();
  await settle(m1, ['bob', 'carol'], ['dave']);
  assert.equal((await history(dave)).status, 404);
  assert.equal((await as(dave, 'POST', `/channels/${ch.id}/messages`, { ciphertext: cipher(), epoch: 1 })).status, 404);

  // Role taken away: the very next message skips carol, and her history request is refused.
  await setRoles(carol, [], s.id);
  const m2 = await send();
  await settle(m2, ['bob'], ['carol', 'dave']);
  assert.equal((await history(carol)).status, 404);
  assert.equal((await history(bob)).status, 200);

  // A member override that denies View: bob is out at once, though his role allows it.
  assert.equal((await ov([{ type: 'member', id: bob.id, allow: 0, deny: P.VIEW_CHANNEL }])).status, 200);
  const m3 = await send();
  await sleep(400);
  for (const n of ['bob', 'carol', 'dave']) assert.ok(!has(n, m3), `${n} must not get m3`);
  assert.equal((await history(bob)).status, 404);

  // Back in, then kicked: nothing more reaches him and the channel is gone for him.
  assert.equal((await ov()).status, 200);
  const m4 = await send();
  await settle(m4, ['bob'], ['carol', 'dave']);
  assert.equal((await as(alice, 'DELETE', `/servers/${s.id}/members/${bob.id}`)).status, 200);
  freshEpoch(s.id);
  await setRoles(carol, [staff], s.id);
  const m5 = await send();
  await settle(m5, ['carol'], ['bob', 'dave']);
  assert.equal((await history(bob)).status, 404);
});

// ------------------------------------------------------------------ grouped server updates
test('a server update reaches each member once, with their own view; same permissions, same view', async () => {
  const s = (await as(alice, 'POST', '/servers', { name: 'Views' })).json;
  for (const u of [bob, carol, dave]) await join(u, s.id);
  const staff = (await as(alice, 'POST', `/servers/${s.id}/roles`, { name: 'Staff', permissions: 0 })).json.id;
  await setRoles(bob, [staff], s.id);
  const ch = (await as(alice, 'POST', `/servers/${s.id}/channels`, { name: 'secret', type: 'text' })).json;
  assert.equal((await as(alice, 'PUT', `/channels/${ch.id}/overrides`, { overrides: [{ type: 'role', id: s.id, allow: 0, deny: P.VIEW_CHANNEL }, { type: 'role', id: staff, allow: P.VIEW_CHANNEL, deny: 0 }] })).status, 200);
  const ups = {};
  for (const u of [alice, bob, carol, dave]) ups[u.username] = collect(await connect(u), 'server:update');
  const mine = (n) => ups[n].filter((x) => x.id === s.id);
  const gen = s.channels.find((c) => c.type === 'text');
  const change = async (topic) => {
    const before = Object.fromEntries(Object.keys(ups).map((n) => [n, mine(n).length]));
    assert.equal((await as(alice, 'PATCH', `/channels/${gen.id}`, { topic })).status, 200);
    for (const n of Object.keys(ups)) assert.ok(await until(() => mine(n).length > before[n]), `${n} gets the update`);
    await sleep(300);
    for (const n of Object.keys(ups)) assert.equal(mine(n).length, before[n] + 1, `${n} gets exactly one`);
    return Object.fromEntries(Object.keys(ups).map((n) => [n, mine(n)[mine(n).length - 1]]));
  };
  let v = await change('one');
  const names = (x) => x.channels.map((c) => c.name).sort();
  assert.ok(names(v.bob).includes('secret'));
  assert.ok(!names(v.carol).includes('secret'));
  assert.deepEqual(v.carol, v.dave, 'same permissions, same view');
  assert.equal(v.carol.channels.find((c) => c.id === gen.id).topic, 'one');
  assert.equal(v.alice.myPerms, ALL);
  assert.ok(v.alice.channels.every((c) => Array.isArray(c.overrides)), 'the owner sees overrides');
  assert.ok(v.bob.channels.every((c) => c.overrides === undefined), 'members without Manage Roles/Channels don’t');
  // Bob loses the role: his next update no longer has the channel, and it now looks like carol's.
  await setRoles(bob, [], s.id);
  await sleep(500); // (that change sends its own update first)
  v = await change('two');
  assert.ok(!names(v.bob).includes('secret'));
  assert.deepEqual(v.bob, v.carol);
  // Someone outside the server gets none of it.
  const eveUps = collect(await connect(eve), 'server:update');
  await change('three');
  assert.equal(eveUps.filter((x) => x.id === s.id).length, 0);
});

// ------------------------------------------------------------------ batched key updates and member lists
test('key updates go to each connected member with only their own wrapped keys', async () => {
  const s = (await as(alice, 'POST', '/servers', { name: 'Keys' })).json;
  for (const u of [bob, carol]) await join(u, s.id);
  const t = Date.now();
  srv.sql('UPDATE servers SET key_epoch = 2, needs_rotation = 0 WHERE id = ?', s.id);
  for (const e of [1, 2]) srv.sql("INSERT INTO server_epochs (server_id, epoch, key_check, creator_id, created_at) VALUES (?, ?, 'chk', ?, ?)", s.id, e, alice.id, t);
  for (const [u, tag] of [[alice, 'a'], [bob, 'b'], [carol, 'c']]) for (const e of [1, 2]) srv.sql('INSERT INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', s.id, e, u.id, `w-${tag}-${e}`, alice.id, t);
  const states = {};
  for (const u of [bob, carol, eve]) states[u.username] = collect(await connect(u), 'keys:state');
  await join(dave, s.id); // someone new needs the key: everyone connected hears about it
  for (const n of ['bob', 'carol']) assert.ok(await until(() => states[n].some((x) => x.serverId === s.id)), n);
  await sleep(300);
  for (const [n, tag] of [['bob', 'b'], ['carol', 'c']]) {
    const st = states[n].filter((x) => x.serverId === s.id);
    assert.equal(st.length, 1, `${n}: one update`);
    assert.deepEqual(st[0].keys.map((k) => [k.epoch, k.wrapped]), [[1, `w-${tag}-1`], [2, `w-${tag}-2`]], `${n}: only their own keys, in epoch order`);
    assert.equal(st[0].keyEpoch, 2);
    assert.deepEqual(st[0].missing, [dave.id]);
    // The same as asking for it one person at a time.
    const one = (await as(n === 'bob' ? bob : carol, 'GET', `/servers/${s.id}/keys`)).json;
    assert.deepEqual(one.keys, st[0].keys);
  }
  assert.equal(states.eve.filter((x) => x.serverId === s.id).length, 0, 'not to someone outside');
});

test('start-up data and joins list every member with their profile', async () => {
  // Graphemes: flags and skin tones count as one, at most 6 (the segmenter is shared now; same answers).
  assert.equal((await as(carol, 'PATCH', '/me/profile', { bio: 'hi', customFx: { glyphs: '🇫🇷🇩🇪👍🏽abcdef' } })).status, 200);
  const boot = await as(bob, 'GET', '/bootstrap');
  assert.equal(boot.status, 200);
  const hq = boot.json.servers.find((x) => x.id === S.id);
  for (const id of hq.memberIds) {
    const u = boot.json.users[id];
    assert.ok(u && u.id === id && u.profile && typeof u.publicKey === 'string', `member ${id} listed`);
  }
  assert.equal(boot.json.users[carol.id].profile.customFx.glyphs, '🇫🇷🇩🇪👍🏽abc');
  assert.equal(boot.json.users[carol.id].profile.bio, 'hi');
  assert.equal(boot.json.users[eve.id], undefined, 'nobody unrelated');
  const fresh = await srv.register();
  const joined = await join(fresh, S.id);
  assert.ok(joined.memberIds.includes(fresh.id));
  const again = await as(fresh, 'GET', '/bootstrap');
  assert.deepEqual(Object.keys(again.json.users).filter((id) => joined.memberIds.includes(id)).sort(), [...joined.memberIds].sort());
  assert.equal(again.json.users[carol.id].profile.customFx.glyphs, '🇫🇷🇩🇪👍🏽abc');
  assert.equal((await srv.api('GET', '/bootstrap')).status, 401);
});

// ------------------------------------------------------------------ slowmode
test('slowmode still holds: a second message too soon is refused; first messages, other channels and moderators aren’t', async () => {
  const ch = (await as(alice, 'POST', `/servers/${S.id}/channels`, { name: 'slow', type: 'text' })).json;
  const other = (await as(alice, 'POST', `/servers/${S.id}/channels`, { name: 'fast', type: 'text' })).json;
  freshEpoch();
  // Lots of history from others, so finding bob's last message really is a lookup.
  const d = srv.db(); const t0 = Date.now() - 1e6;
  d.transaction(() => { const ins = d.prepare("INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, '', ?, 1, ?)"); for (let i = 0; i < 500; i++) ins.run(idAt(t0 + i), ch.id, dave.id, cipher(), t0 + i); })();
  d.close();
  assert.equal((await as(alice, 'PATCH', `/channels/${ch.id}`, { slowmode: 60 })).status, 200);
  const send = (u, c = ch) => as(u, 'POST', `/channels/${c.id}/messages`, { ciphertext: cipher(), epoch: 1 });
  assert.equal((await send(bob)).status, 200, 'first message');
  const again = await send(bob);
  assert.equal(again.status, 429);
  assert.equal(again.json.code, 'slowmode');
  assert.match(again.json.error, /in (59|60)s/);
  assert.equal((await send(bob, other)).status, 200, 'another channel has its own clock');
  assert.equal((await send(carol)).status, 200, 'someone who never wrote here');
  assert.equal((await send(dave)).status, 200, 'old messages (long ago) don’t count');
  assert.equal((await send(dave)).status, 429);
  assert.equal((await send(alice)).status, 200);
  assert.equal((await send(alice)).status, 200, 'moderators aren’t slowed');
  assert.equal((await send(eve)).status, 404, 'outsiders can’t send at all');
});

// ------------------------------------------------------------------ pins
test('pinned messages: complete, newest pin first, at most 50, only this conversation; outsiders get 404', async () => {
  const ch = (await as(alice, 'POST', `/servers/${S.id}/channels`, { name: 'pins', type: 'text' })).json;
  const d = srv.db(); const t0 = Date.now() - 2e6; const pinned = [];
  const dm = (await as(bob, 'POST', '/dms', { userId: carol.id })).json;
  d.transaction(() => {
    const ins = d.prepare("INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at, pinned_at, pinned_by) VALUES (?, ?, ?, '', ?, 1, ?, ?, ?)");
    for (let i = 0; i < 300; i++) {
      const id = idAt(t0 + i);
      const pin = i % 5 === 0 ? t0 + 1e5 + ((i * 7919) % 300) : null; // pin times not in message order
      ins.run(id, ch.id, bob.id, cipher(), t0 + i, pin, pin ? alice.id : null);
      if (pin) pinned.push({ id, pin });
    }
    ins.run(idAt(t0 + 999), general.id, bob.id, cipher(), t0 + 999, t0 + 9e5, alice.id); // a pin elsewhere
    const dmi = d.prepare('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, created_at, pinned_at, pinned_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 40; i++) dmi.run(idAt(t0 + i), dm.id, bob.id, cipher(), t0 + i, i % 10 === 0 ? t0 + i : null, i % 10 === 0 ? bob.id : null);
  })();
  d.close();
  const want = pinned.sort((a, b) => b.pin - a.pin).slice(0, 50).map((x) => x.id);
  const r = await as(carol, 'GET', `/channels/${ch.id}/pins`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((m) => m.id), want);
  // Unpinning takes it off the list.
  assert.equal((await as(alice, 'DELETE', `/messages/${want[0]}/pin`)).status, 200);
  assert.deepEqual((await as(carol, 'GET', `/channels/${ch.id}/pins`)).json.map((m) => m.id), pinned.filter((x) => x.id !== want[0]).slice(0, 50).map((x) => x.id));
  const dp = await as(carol, 'GET', `/dms/${dm.id}/pins`);
  assert.equal(dp.status, 200);
  assert.equal(dp.json.length, 4);
  assert.ok(dp.json.every((m, i, a) => !i || a[i - 1].pinnedAt >= m.pinnedAt));
  assert.equal((await as(eve, 'GET', `/channels/${ch.id}/pins`)).status, 404);
  assert.equal((await as(eve, 'GET', `/dms/${dm.id}/pins`)).status, 404);
});

// ------------------------------------------------------------------ history paging
test('channel history pages skip thread replies and page exactly as before; ?limit stays bounded', async () => {
  const ch = (await as(alice, 'POST', `/servers/${S.id}/channels`, { name: 'history', type: 'text' })).json;
  const d = srv.db(); const t0 = Date.now() - 3e6; const top = []; let root = null;
  d.transaction(() => {
    const ins = d.prepare("INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, thread_id, created_at) VALUES (?, ?, ?, '', ?, 1, ?, ?)");
    for (let i = 0; i < 400; i++) {
      const id = idAt(t0 + i);
      if (root && i % 3 === 0) ins.run(id, ch.id, bob.id, cipher(), root, t0 + i); // a thread reply, in between
      else { ins.run(id, ch.id, bob.id, cipher(), null, t0 + i); top.push(id); if (i % 50 === 1) root = id; }
    }
    for (let i = 0; i < 300; i++) ins.run(idAt(t0 + 1000 + i), ch.id, carol.id, cipher(), root, t0 + 1000 + i); // a busy thread, newest of all
  })();
  d.close();
  const get = (q = '') => as(bob, 'GET', `/channels/${ch.id}/messages${q}`);
  // Newest to oldest, 100 at a time, then the default page size.
  for (const limit of [100, 50]) {
    const seen = []; let before = null; let more = true;
    while (more) {
      const r = await get(`?limit=${limit}${before ? `&before=${before}` : ''}`);
      assert.equal(r.status, 200);
      assert.ok(r.json.messages.every((m) => !m.threadId), 'no thread replies');
      seen.unshift(...r.json.messages.map((m) => m.id));
      more = r.json.hasMore; before = r.json.messages[0] && r.json.messages[0].id;
      if (!r.json.messages.length) break;
    }
    assert.deepEqual(seen, top, `limit ${limit}`);
  }
  const first = await get();
  assert.deepEqual(first.json.messages.map((m) => m.id), top.slice(-50));
  assert.equal(first.json.hasNewer, false);
  const after = await get(`?after=${top[10]}&limit=20`);
  assert.deepEqual(after.json.messages.map((m) => m.id), top.slice(11, 31));
  const around = await get(`?around=${top[100]}`);
  assert.deepEqual(around.json.messages.map((m) => m.id), top.slice(75, 126));
  // The busy thread's root carries its count (its 300 + the in-between replies) and the newest reply's time.
  const rootMsg = (await get(`?around=${root}`)).json.messages.find((m) => m.id === root);
  const replies = srv.sql('SELECT COUNT(*) n, MAX(created_at) last FROM messages WHERE thread_id = ?', root)[0];
  assert.ok(replies.n >= 300);
  assert.equal(rootMsg.threadCount, replies.n);
  assert.equal(rootMsg.threadLastAt, replies.last);
  for (const limit of ['1000', '-1', '0', 'x']) {
    const r = await get(`?limit=${limit}`);
    assert.ok(r.json.messages.length >= 1 && r.json.messages.length <= 100, `limit=${limit}`);
  }
  assert.equal((await as(eve, 'GET', `/channels/${ch.id}/messages`)).status, 404);
});

// ------------------------------------------------------------------ admin activity chart
test('the admin activity chart counts each day’s messages exactly; others are refused', async () => {
  const ch = (await as(alice, 'POST', `/servers/${S.id}/channels`, { name: 'stats', type: 'text' })).json;
  const dm = (await as(bob, 'POST', '/dms', { userId: dave.id })).json;
  const day = 86400000; const t = Date.now();
  const d = srv.db();
  d.transaction(() => {
    const m = d.prepare("INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, '', ?, 1, ?)");
    const dmm = d.prepare('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 300; i++) { const at = t - Math.floor((i / 300) * 20 * day); m.run(idAt(at) + i, ch.id, bob.id, cipher(), at); if (i % 3 === 0) dmm.run(idAt(at) + i, dm.id, bob.id, cipher(), at); }
  })();
  d.close();
  const r = await srv.api('GET', '/admin/stats', { token: srv.owner.token, ip: srv.owner.ip });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.series.length, 14);
  // Reference counts without any index (NOT INDEXED reads the tables themselves).
  const count = (table, from, to) => srv.sql(`SELECT COUNT(*) n FROM ${table} NOT INDEXED WHERE created_at >= ? AND created_at < ?`, from, to)[0].n;
  const now2 = Date.now();
  for (let i = 13; i >= 0; i--) {
    const from = new Date(new Date(now2 - i * day).toDateString()).getTime();
    const row = r.json.series[13 - i];
    assert.equal(row.day, new Date(from).toISOString().slice(0, 10));
    assert.equal(row.messages, count('messages', from, from + day) + count('dm_messages', from, from + day), row.day);
  }
  assert.ok(r.json.series.reduce((a, x) => a + x.messages, 0) > 100, 'the test data is in the chart');
  assert.equal((await as(bob, 'GET', '/admin/stats')).status, 403);
  assert.equal((await srv.api('GET', '/admin/stats')).status, 401);
});
