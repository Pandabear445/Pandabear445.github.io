#!/usr/bin/env node
// Server performance benchmark (not part of npm test: a full run seeds half a million messages and takes minutes).
//
//   node scripts/bench.js [--scale 1] [--out bench.json] [--root /other/hearth] [--only a,b] [--plans] [--keep]
//
//   --scale  multiplies the dataset (0.1 for a quick run). Default 1: 2,000 users, 50 servers, one of them with
//            1,000 members, 500,000 channel messages, 1,000 DM conversations with 20,000 DM messages, 10,000
//            attachment rows.
//   --out    also write the results as JSON to this file.
//   --root   measure another Hearth checkout (an older release, say) with this script and the same dataset.
//   --only   run only some sections: bootstrap, members, history, search, perms, fanout, roles, joinleave,
//            slowmode, admin, startup, migration (memory is always reported).
//   --plans  print EXPLAIN QUERY PLAN for the hot statements.
//   --keep   keep the temporary data folder (its path is printed).
//   --server-args="…"  extra node options for the server process (e.g. "--cpu-prof --cpu-prof-dir=/tmp/prof").
//
// How it works: a fresh data folder (mkdtemp) gets its schema from the server's own db.js, then the dataset is
// written straight into SQLite (seeding through the API would take hours and trip the rate limits). Sign-in
// sessions are inserted the way the server makes them (SHA-256 of a random token in sessions.token_hash). Then the
// real server (node server/index.js) is started on that folder and measured over HTTP and Socket.IO, like an app.
// Every request carries its own X-Forwarded-For (the server trusts it from localhost), and senders rotate, so the
// per-account, per-session and per-network rate limits never kick in and every timing is real work.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

// ------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`)); // --name=value (needed when the value starts with --)
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf('--' + name); if (i < 0) return def;
  const v = argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v;
};
const SCALE = Number(flag('scale', process.env.BENCH_SCALE || 1));
const OUT = flag('out', null);
const ROOT = path.resolve(flag('root', path.join(__dirname, '..')));
const ONLY = flag('only', null) ? new Set(String(flag('only')).split(',')) : null;
const PLANS = !!flag('plans', false);
const KEEP = !!flag('keep', false);
const SERVER_ARGS = flag('server-args', '') ? String(flag('server-args')).split(' ').filter(Boolean) : []; // e.g. --cpu-prof
const want = (s) => !ONLY || ONLY.has(s);
const sc = (n, min) => Math.max(min, Math.round(n * SCALE));
const N = {
  users: sc(2000, 60),
  servers: sc(50, 5),
  bigMembers: sc(1000, 30),
  messages: sc(500000, 2000),
  dmChannels: sc(1000, 20),
  dmMessages: sc(20000, 200),
  blobs: sc(10000, 100),
  friends: sc(200, 5),
  heavyDms: sc(300, 10),
};
N.bigMembers = Math.min(N.bigMembers, N.users - 20);
const TEXT_CHANNELS = 5; // per server, plus one voice channel
const Database = require(require.resolve('better-sqlite3', { paths: [ROOT, __dirname] }));
const { io: ioClient } = require(require.resolve('socket.io-client', { paths: [__dirname, ROOT] }));

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => crypto.randomBytes(n).toString('hex');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
// Deterministic structure (who is where, which channel gets which message), so runs are comparable.
function prng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = prng(42);
const pick = (a) => a[Math.floor(rand() * a.length)];
const idAt = (ts) => ts.toString(36).padStart(9, '0') + hex(5); // like newId() in db.js
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  const r = (x) => Math.round(x * 100) / 100;
  return { n: s.length, p50: r(q(50)), p95: r(q(95)), min: r(s[0]), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
};
let ipCounter = 0;
const newIp = () => { ipCounter++; return `198.18.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
const rssMb = (pid) => { try { const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Math.round(+m[1] / 1024) : null; } catch { return null; } };
const results = {};
const record = (name, xs, extra = {}) => { results[name] = { ...stats(xs), ...extra }; const r = results[name]; console.log(`  ${name.padEnd(58)} n=${String(r.n).padStart(4)}  p50 ${String(r.p50).padStart(9)} ms  p95 ${String(r.p95).padStart(9)} ms`); };

// ------------------------------------------------------------------ socket worker (a child of this script)
if (process.env.HEARTH_BENCH_WORKER === '1') {
  const socks = [];
  const watches = new Map();
  let viewers = new Set(); let privateChannel = null; let leaks = 0;
  const seen = (event, payload, userId) => {
    if (event === 'message:new' && payload && payload.channelId === privateChannel && !viewers.has(userId)) leaks++;
    for (const [id, w] of watches) {
      if (w.event !== event || (w.nonce && (!payload || payload.nonce !== w.nonce))) continue;
      if (--w.left === 0) { watches.delete(id); process.send({ cmd: 'done', id, last: performance.timeOrigin + performance.now() }); }
    }
  };
  process.on('message', async (m) => {
    if (m.cmd === 'connect') {
      viewers = new Set(m.viewers); privateChannel = m.privateChannel;
      try {
        for (let i = 0; i < m.users.length; i += 50) {
          socks.push(...await Promise.all(m.users.slice(i, i + 50).map((u) => new Promise((resolve, reject) => {
            const s = ioClient(m.base, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { 'x-forwarded-for': u.ip } });
            s.once('connect', () => resolve(s));
            s.once('connect_error', reject);
            s.on('message:new', (p) => seen('message:new', p, u.id));
            s.on('server:update', (p) => seen('server:update', p, u.id));
          }))));
        }
        process.send({ cmd: 'connected' });
      } catch (e) { process.send({ cmd: 'error', error: e.message }); }
    } else if (m.cmd === 'watch') {
      if (m.count === 0) process.send({ cmd: 'done', id: m.id, last: 0 });
      else watches.set(m.id, { event: m.event, nonce: m.nonce, left: m.count });
    } else if (m.cmd === 'stats') process.send({ cmd: 'stats', leaks });
    else if (m.cmd === 'close') { socks.forEach((s) => s.close()); setTimeout(() => process.exit(0), 100); }
  });
  return;
}

// ------------------------------------------------------------------ the server process
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bench-'));
let PORT; let BASE; let child = null; let log = '';
const env = () => ({ ...process.env, DATA_DIR: DIR, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'false', NODE_ENV: 'test', MAIL_OUTBOX_DIR: path.join(DIR, 'outbox'), PUBLIC_URL: 'https://chat.example.test' });
async function start() {
  log = '';
  const t0 = performance.now();
  child = spawn(process.execPath, [...SERVER_ARGS, 'server/index.js'], { cwd: ROOT, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (;;) {
    try { const r = await fetch(BASE + '/api/config'); if (r.ok) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`Hearth didn't start:\n${log}`);
    if (performance.now() - t0 > 600000) throw new Error('Hearth took over 10 minutes to start');
    await sleep(5);
  }
  return performance.now() - t0;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 200 && child.exitCode === null; i++) await sleep(25);
  if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(50);
}
async function call(method, p, { token, body, ip = '198.51.100.1' } = {}) {
  const h = { 'x-forwarded-for': ip, 'accept-encoding': 'gzip' };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + '/api' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
async function timed(method, p, opts, okStatus = 200) {
  const t = performance.now();
  const r = await call(method, p, opts);
  const ms = performance.now() - t;
  if (r.status !== okStatus) throw new Error(`${method} ${p}: ${r.status} ${r.text.slice(0, 300)}`);
  return { ms, r };
}

// ------------------------------------------------------------------ dataset
const users = []; // { id, token, ip }
const servers = []; // { id, channels: [ids], voice, members: [user index] }
const S = {}; // ids the measurements need
function seed() {
  // The schema, made by the server's own code (db.js only; no HTTP server).
  const mk = spawnSync(process.execPath, ['-e', "require('./server/db')"], { cwd: ROOT, env: env(), encoding: 'utf8' });
  if (mk.status !== 0) throw new Error('could not create the schema: ' + mk.stderr);
  const d = new Database(path.join(DIR, 'hearth.db'));
  d.pragma('journal_mode = WAL');
  const { DEFAULT_EVERYONE, PERMS: P } = require(path.join(ROOT, 'server', 'perms.js'));
  const now = Date.now();
  const YEAR = 365 * 86400000;
  const start = now - YEAR;
  const t0 = performance.now();
  const cipher = 'v2:' + crypto.randomBytes(240).toString('base64'); // a typical short message, encrypted
  d.transaction(() => {
    const iu = d.prepare(`INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, sign_public_key, kdf, kdf_salt, profile, created_at)
      VALUES (?, ?, 'x', ?, 'e', ?, 'argon2id', 'c2FsdHNhbHRzYWx0c2FsdA==', ?, ?)`);
    const is = d.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < N.users; i++) {
      const id = 'bu' + String(i).padStart(5, '0');
      const token = hex(32);
      iu.run(id, 'bench' + i, crypto.randomBytes(91).toString('base64'), crypto.randomBytes(91).toString('base64'), JSON.stringify({ displayName: 'Bench ' + i, bio: 'x'.repeat(40) }), start + i);
      is.run(crypto.randomBytes(12).toString('base64url'), sha(token), id, now, now, now + 30 * 86400000);
      users.push({ id, token, ip: newIp() });
    }
    // users[0] owns every server (and is the instance owner, being the first account). users[1] is the "heavy"
    // person: an ordinary member (not an owner, so every permission is really worked out) of all servers.
    S.owner = 0; S.heavy = 1;
    const isrv = d.prepare("INSERT INTO servers (id, name, owner_id, created_at, key_epoch, needs_rotation, kind) VALUES (?, ?, ?, ?, 1, 0, 'server')");
    const ich = d.prepare('INSERT INTO channels (id, server_id, name, type, position, created_at, category) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const irole = d.prepare('INSERT INTO roles (id, server_id, name, position, permissions, hoist, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const imem = d.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)');
    const imr = d.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)');
    const iov = d.prepare('INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)');
    const iep = d.prepare("INSERT INTO server_epochs (server_id, epoch, key_check, creator_id, created_at) VALUES (?, 1, 'chk', ?, ?)");
    const ikey = d.prepare('INSERT INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, 1, ?, ?, ?, ?)');
    const wrapped = 'w1:' + crypto.randomBytes(300).toString('base64');
    const pool = []; for (let i = N.bigMembers; i < N.users; i++) pool.push(i); // the other servers' members
    for (let k = 0; k < N.servers; k++) {
      const sid = 'bs' + String(k).padStart(3, '0');
      isrv.run(sid, 'Server ' + k, users[0].id, start);
      irole.run(sid, sid, '@everyone', 0, DEFAULT_EVERYONE, 0, start);
      const roles = ['Mod', 'Staff', 'Regular', 'Colour'].map((name, j) => {
        const rid = `${sid}r${j}`;
        irole.run(rid, sid, name, 4 - j, name === 'Mod' ? (P.MANAGE_MESSAGES | P.KICK_MEMBERS) : 0, name === 'Mod' ? 1 : 0, start);
        return rid;
      });
      const channels = [];
      for (let j = 0; j < TEXT_CHANNELS; j++) { const cid = `bc${String(k).padStart(3, '0')}_${j}`; ich.run(cid, sid, j === 0 ? 'general' : 'chan-' + j, 'text', j, start, 'Text'); channels.push(cid); }
      const voice = `bc${String(k).padStart(3, '0')}_v`;
      ich.run(voice, sid, 'Lounge', 'voice', TEXT_CHANNELS, start, 'Voice');
      // Channel 1 is private (only Staff sees it); channel 2 is read-only for @everyone (Regular may post).
      iov.run(channels[1], 'role', sid, 0, P.VIEW_CHANNEL);
      iov.run(channels[1], 'role', roles[1], P.VIEW_CHANNEL, 0);
      iov.run(channels[2], 'role', sid, 0, P.SEND_MESSAGES);
      iov.run(channels[2], 'role', roles[2], P.SEND_MESSAGES, 0);
      let members;
      if (k === 0) { members = []; for (let i = 0; i < N.bigMembers; i++) members.push(i); }
      else { const set = new Set([0, 1]); while (set.size < Math.min(22, N.users)) set.add(pick(pool)); members = [...set]; }
      iep.run(sid, users[0].id, start);
      members.forEach((ui, n) => {
        imem.run(sid, users[ui].id, start + n);
        ikey.run(sid, users[ui].id, wrapped, users[0].id, start);
        // Staff: 90% of members (and the heavy user); Regular 30%; Colour 30%; Mod 1%.
        if (ui === 1 || rand() < 0.9) imr.run(sid, users[ui].id, roles[1]);
        if (rand() < 0.3) imr.run(sid, users[ui].id, roles[2]);
        if (rand() < 0.3) imr.run(sid, users[ui].id, roles[3]);
        if (ui > 1 && rand() < 0.01) imr.run(sid, users[ui].id, roles[0]);
      });
      servers.push({ id: sid, channels, voice, members, roles });
    }
    S.big = servers[0];
    // Who can see the big server's private channel: the owner and every Staff holder.
    S.privateViewers = new Set([users[0].id, ...d.prepare('SELECT user_id FROM member_roles WHERE role_id = ?').all(S.big.roles[1]).map((r) => r.user_id)]);
    // Someone only in the big server (their start-up data is mostly its member list).
    S.light = N.bigMembers - 1;
    // The last 5% of the big server's members never write there (people who only read).
    S.lurkerFrom = Math.floor(N.bigMembers * 0.95);

    // Channel messages over a year. The big server's #general gets 30%; the rest follows 1/rank like real servers.
    const texts = servers.flatMap((s) => s.channels.map((c) => ({ c, s })));
    const weights = texts.map((_, i) => (i === 0 ? 0 : 1 / (i + 1)));
    const wsum = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    const cum = weights.map((w) => (acc += (w / wsum) * 0.7));
    const im = d.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, reply_to, thread_id, created_at) VALUES (?, ?, ?, \'\', ?, 1, ?, ?, ?)');
    const irx = d.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)');
    const last = new Map(); const threadRoot = new Map();
    S.depthIds = []; // ids at increasing depth in the big #general, for ?before= paging
    S.someMessages = [];
    let bigCount = 0;
    const step = YEAR / N.messages;
    for (let i = 0; i < N.messages; i++) {
      const r = rand();
      let ti = 0;
      if (r >= 0.3) { const x = r - 0.3; ti = cum.findIndex((v) => v >= x); if (ti < 0) ti = texts.length - 1; }
      const { c, s } = texts[ti];
      const at = Math.floor(start + i * step);
      const id = idAt(at);
      let author; do author = pick(s.members); while (s === S.big && author >= S.lurkerFrom);
      author = users[author].id;
      const roll = rand();
      let reply = null; let thread = null;
      if (roll < 0.02 && last.has(c)) reply = last.get(c);
      else if (roll < 0.03 && threadRoot.has(c)) thread = threadRoot.get(c);
      im.run(id, c, author, cipher, reply, thread, at);
      if (!thread) {
        last.set(c, id);
        if (rand() < 0.002) threadRoot.set(c, id);
        if (c === S.big.channels[0] && ++bigCount % 1000 === 0) S.depthIds.push(id);
      }
      if (rand() < 0.05) for (let k = 0, n = 1 + Math.floor(rand() * 3); k < n; k++) irx.run(id, users[pick(s.members)].id, ['👍', '🔥', '😂'][k], at);
      if (i % 50 === 0) S.someMessages.push(id);
    }
    S.bigGeneralCount = bigCount;
    // A busy thread: its N replies are the newest messages of the big server's channel 3 (the last hour), so that
    // channel's newest page has to look past all of them, and the root's reply count covers all of them.
    const tch = S.big.channels[3];
    const troot = idAt(now - 3600000 - 1);
    im.run(troot, tch, users[2].id, cipher, null, null, now - 3600000 - 1);
    S.threadRoot = troot; S.threadChannel = tch; S.threadReplies = sc(20000, 200);
    for (let i = 0; i < S.threadReplies; i++) { const at = now - 3600000 + Math.floor((i * 3600000) / S.threadReplies); im.run(idAt(at), tch, users[pick(S.big.members.slice(2, 50))].id, cipher, null, troot, at); }
    // 20 pinned messages spread over #general's history.
    const pin = d.prepare('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?');
    S.depthIds.filter((_, i) => i % Math.max(1, Math.floor(S.depthIds.length / 20)) === 0).slice(0, 20).forEach((id, i) => pin.run(now - i * 1000, users[0].id, id));

    // Attachments: blob rows linked to messages (the files themselves aren't needed).
    const ib = d.prepare('INSERT INTO blobs (name, uploader_id, message_id, created_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < N.blobs; i++) ib.run(hex(12) + '.bin', users[pick([0, 1, 2, 3])].id, pick(S.someMessages), now);

    // DM conversations: the heavy user has N.heavyDms of them (and half of all DM messages); the rest are pairs of others.
    const idm = d.prepare('INSERT OR IGNORE INTO dm_channels (id, user_a, user_b, last_message_at, created_at) VALUES (?, ?, ?, ?, ?)');
    const idmm = d.prepare('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)');
    const dms = [];
    for (let i = 0; i < N.dmChannels; i++) {
      let a; let b;
      if (i < N.heavyDms) { a = 1; b = 2 + i; } else { a = 2 + Math.floor(rand() * (N.users - 2)); b = 2 + Math.floor(rand() * (N.users - 2)); if (a === b) continue; }
      const [x, y] = [users[a].id, users[b].id].sort();
      const id = 'bd' + String(i).padStart(5, '0');
      if (idm.run(id, x, y, now - i * 1000, start).changes) dms.push({ id, x, y, heavy: i < N.heavyDms });
    }
    const heavyDms = dms.filter((m) => m.heavy);
    const dstep = YEAR / N.dmMessages;
    for (let i = 0; i < N.dmMessages; i++) {
      const m = i % 2 ? pick(heavyDms) : pick(dms);
      const at = Math.floor(start + i * dstep);
      idmm.run(idAt(at), m.id, rand() < 0.5 ? m.x : m.y, cipher, at);
    }
    // Friends of the heavy user.
    const ifr = d.prepare("INSERT OR IGNORE INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'accepted', ?)");
    for (let i = 0; i < N.friends; i++) ifr.run(users[1].id, users[2 + i].id, now);
  })();
  const seconds = (performance.now() - t0) / 1000;
  const count = (t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const dataset = {};
  for (const t of ['users', 'sessions', 'servers', 'channels', 'members', 'roles', 'member_roles', 'channel_overrides', 'messages', 'reactions', 'blobs', 'dm_channels', 'dm_messages', 'friendships', 'server_keys']) dataset[t] = count(t);
  dataset.bigServerMembers = N.bigMembers;
  dataset.bigGeneralMessages = S.bigGeneralCount;
  dataset.threadReplies = d.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id IS NOT NULL').get().n;
  dataset.heavyUser = { servers: N.servers, dmChannels: d.prepare('SELECT COUNT(*) n FROM dm_channels WHERE user_a = ? OR user_b = ?').get(users[1].id, users[1].id).n, friends: N.friends };
  d.pragma('wal_checkpoint(TRUNCATE)');
  d.close();
  dataset.dbMb = Math.round(fs.statSync(path.join(DIR, 'hearth.db')).size / 1048576);
  dataset.seedSeconds = Math.round(seconds * 10) / 10;
  return dataset;
}

// ------------------------------------------------------------------ query plans of the hot statements
function plans() {
  const d = new Database(path.join(DIR, 'hearth.db'), { readonly: true });
  const big = S.big.id; const ch = S.big.channels[0]; const u = users[1].id;
  const list = [
    ['session lookup (auth)', 'SELECT * FROM sessions WHERE token_hash = ?', [sha('x')]],
    ['bootstrap: my servers', 'SELECT s.* FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY m.joined_at', [u]],
    ['serverCommon: channels', 'SELECT * FROM channels WHERE server_id = ? ORDER BY position, created_at', [big]],
    ['serverCommon: member ids', 'SELECT user_id FROM members WHERE server_id = ? ORDER BY joined_at', [big]],
    ['serverCommon: member roles', 'SELECT mr.user_id, mr.role_id FROM member_roles mr JOIN members m ON m.server_id = mr.server_id AND m.user_id = mr.user_id WHERE mr.server_id = ?', [big]],
    ['perms: roles of a member', `SELECT r.* FROM roles r WHERE r.server_id = ? AND (r.id = ? OR r.id IN (SELECT mr.role_id FROM member_roles mr JOIN members m ON m.server_id = mr.server_id AND m.user_id = mr.user_id
      WHERE mr.server_id = ? AND mr.user_id = ?))`, [big, big, big, u]],
    ['perms: channel overrides', 'SELECT * FROM channel_overrides WHERE channel_id = ?', [ch]],
    ['perms: restricted?', 'SELECT 1 FROM channel_overrides WHERE channel_id = ? AND (deny & ?) != 0', [ch, 1]],
    ['bootstrap: DMs', 'SELECT * FROM dm_channels WHERE user_a = ? OR user_b = ? ORDER BY last_message_at DESC', [u, u]],
    ['bootstrap: last DM message', 'SELECT id, author_id, ciphertext, created_at FROM dm_messages WHERE dm_id = ? ORDER BY id DESC LIMIT 1', ['bd00000']],
    ['bootstrap: friendships', 'SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?', [u, u]],
    ['keyState: my wrapped keys', `SELECT k.epoch, k.wrapped, k.wrapper_id, k.created_at, e.key_check FROM server_keys k JOIN server_epochs e ON e.server_id = k.server_id AND e.epoch = k.epoch
      WHERE k.server_id = ? AND k.user_id = ? ORDER BY k.epoch`, [big, u]],
    ['keyState: members missing the key', `SELECT m.user_id FROM members m WHERE m.server_id = ? AND NOT EXISTS
        (SELECT 1 FROM server_keys k WHERE k.server_id = m.server_id AND k.user_id = m.user_id AND k.epoch = ?)`, [big, 1]],
    ['history: newest page', 'SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT ?', [ch, 50]],
    ['history: ?before= page', 'SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?', [ch, S.depthIds[0] || 'z', 50]],
    ['serializeMessage: thread info', 'SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE thread_id = ?', [S.someMessages[0]]],
    ['serializeMessage: reply', 'SELECT * FROM messages WHERE id = ?', [S.someMessages[0]]],
    ['reactions of a page', 'SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (?, ?) ORDER BY created_at', [S.someMessages[0], S.someMessages[1]]],
    ['fan-out: members of a server', 'SELECT user_id FROM members WHERE server_id = ?', [big]],
    ['slowmode: last message (v17 query)', 'SELECT created_at FROM messages WHERE channel_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1', [ch, u]],
    ['slowmode: last message (v18 query)', 'SELECT MAX(created_at) AS created_at FROM messages WHERE channel_id = ? AND author_id = ?', [ch, u]],
    ['pins of a channel', 'SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 50', [ch]],
    ['pins of a DM', 'SELECT * FROM dm_messages WHERE dm_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 50', ['bd00000']],
    ['admin stats: messages in a day', 'SELECT COUNT(*) n FROM messages WHERE created_at >= ? AND created_at < ?', [Date.now() - 86400000, Date.now()]],
    ['admin stats: DM messages in a day', 'SELECT COUNT(*) n FROM dm_messages WHERE created_at >= ? AND created_at < ?', [Date.now() - 86400000, Date.now()]],
    ['perms.forServer: all members\' roles', `SELECT mr.user_id, mr.role_id FROM member_roles mr JOIN members m ON m.server_id = mr.server_id AND m.user_id = mr.user_id
          WHERE mr.server_id = ?`, [big]],
    ['socket connect: my servers', 'SELECT server_id FROM members WHERE user_id = ?', [u]],
    ['search (all): my text channels', `SELECT c.* FROM channels c JOIN members m ON m.server_id = c.server_id WHERE m.user_id = ? AND c.type = 'text'`, [u]],
  ];
  try {
    const { SQL } = require(path.join(ROOT, 'server', 'search.js'));
    list.push(['search: one channel, newest first', SQL.c, [ch, Date.now(), '', 0, '', 101]]);
  } catch { /* an older checkout without search.js */ }
  const out = {};
  for (const [name, sql, args] of list) {
    try { out[name] = d.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' | '); } catch (e) { out[name] = 'error: ' + e.message; }
  }
  d.close();
  return out;
}

// ------------------------------------------------------------------ permission micro-benchmark (in process)
function permsBench() {
  const d = new Database(path.join(DIR, 'hearth.db'), { readonly: true });
  // The same statement cache the server uses (db.js), so this times the permission logic, not SQL compiling.
  const compile = d.prepare.bind(d); const cache = new Map();
  d.prepare = (sql) => { let st = cache.get(sql); if (!st) { st = compile(sql); cache.set(sql, st); } return st; };
  const perms = require(path.join(ROOT, 'server', 'perms.js')).makePerms(d);
  const { PERMS: PM } = require(path.join(ROOT, 'server', 'perms.js'));
  const srv = d.prepare('SELECT * FROM servers WHERE id = ?').get(S.big.id);
  const open = d.prepare('SELECT * FROM channels WHERE id = ?').get(S.big.channels[0]);
  const priv = d.prepare('SELECT * FROM channels WHERE id = ?').get(S.big.channels[1]);
  const memberIds = d.prepare('SELECT user_id FROM members WHERE server_id = ?').all(S.big.id).map((r) => r.user_id);
  const ns = () => Number(process.hrtime.bigint()) / 1e6;
  const one = (fn) => { const xs = []; for (const u of memberIds) { const t = ns(); fn(u); xs.push(ns() - t); } return xs; };
  for (let i = 0; i < 2; i++) one((u) => perms.channel(srv, priv, u)); // warm up
  record('perms.channel, channel without overrides (per member)', one((u) => perms.channel(srv, open, u)));
  record('perms.channel, private channel with overrides (per member)', one((u) => perms.channel(srv, priv, u)));
  // requireChannel(): channel row, membership, server row, then the channel permissions.
  record('requireChannel path (per call)', one((u) => {
    const c = d.prepare('SELECT * FROM channels WHERE id = ?').get(priv.id);
    d.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(c.server_id, u);
    const s = d.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
    return perms.channel(s, c, u) & PM.VIEW_CHANNEL;
  }));
  // Who receives an event in the private channel (toChannel): everyone's permissions there.
  // (As server/index.js toChannel does it: with perms.forServer where the checkout has it, else member by member.)
  const audience = () => {
    const ids = d.prepare('SELECT user_id FROM members WHERE server_id = ?').all(srv.id).map((r) => r.user_id);
    if (!perms.forServer) return ids.filter((u) => perms.channel(srv, priv, u) & PM.VIEW_CHANNEL);
    const ev = perms.forServer(srv);
    return ids.filter((u) => ev.channel(priv, u) & PM.VIEW_CHANNEL);
  };
  const xs = [];
  let size = 0;
  for (let i = 0; i < 40; i++) { const t = ns(); size = audience().length; xs.push(ns() - t); }
  record(`private-channel audience, ${memberIds.length} members (toChannel)`, xs, { audience: size });
  d.close();
}

// ------------------------------------------------------------------ sockets
// The connections live in a few child processes (like apps on other machines), so the time the bench itself
// spends decoding 1,000 copies of every event doesn't land in the server's numbers. Times are compared on the
// shared wall clock (performance.timeOrigin + performance.now()).
const WORKERS = 3;
const workers = []; // { proc, users }
const pendingWatch = new Map();
let watchSeq = 0;
const clock = () => performance.timeOrigin + performance.now();
async function startSockets(list, viewers, privateChannel) {
  const per = Math.ceil(list.length / WORKERS);
  await Promise.all([...Array(WORKERS)].map((_, k) => new Promise((resolve, reject) => {
    const part = list.slice(k * per, (k + 1) * per);
    const proc = spawn(process.execPath, [__filename], { env: { ...process.env, HEARTH_BENCH_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const w = { proc, users: part };
    workers.push(w);
    proc.on('message', (m) => {
      if (m.cmd === 'connected') resolve();
      else if (m.cmd === 'error') reject(new Error('socket worker: ' + m.error));
      else if (m.cmd === 'done') { const p = pendingWatch.get(m.id); if (p) p(m); }
      else if (m.cmd === 'stats' && w.onStats) w.onStats(m);
    });
    proc.send({ cmd: 'connect', base: BASE, users: part, viewers: [...viewers], privateChannel });
  })));
  return workers.reduce((n, w) => n + w.users.length, 0);
}
// Resolves with the wall-clock time the last expected socket got the event. count(users) = how many of a
// worker's sockets should get it.
function watchEvent(event, nonce, count) {
  const parts = workers.map((w) => new Promise((resolve) => {
    const id = ++watchSeq;
    pendingWatch.set(id, (m) => { pendingWatch.delete(id); resolve(m.last); });
    w.proc.send({ cmd: 'watch', id, event, nonce, count: count(w.users) });
  }));
  const timeout = sleep(30000).then(() => { throw new Error(`${event}: not every socket got it within 30 s`); });
  return Promise.race([Promise.all(parts).then((ts) => Math.max(...ts)), timeout]);
}
async function socketLeaks() {
  const all = await Promise.all(workers.map((w) => new Promise((resolve) => { w.onStats = (m) => resolve(m.leaks); w.proc.send({ cmd: 'stats' }); })));
  return all.reduce((a, b) => a + b, 0);
}
async function stopSockets() {
  await Promise.all(workers.map((w) => new Promise((resolve) => { if (w.proc.exitCode !== null) return resolve(); w.proc.once('exit', resolve); w.proc.send({ cmd: 'close' }); })));
  workers.length = 0;
}

// Sends one message and waits until every expected socket has it. Returns [ms until the POST answered, ms until
// the last socket received it].
async function sendAndWait(channelId, sender, count) {
  const nonce = 'b' + hex(8);
  const arrived = watchEvent('message:new', nonce, count);
  await sleep(5); // the watch reaches the workers first
  const t = clock();
  const r = await call('POST', `/channels/${channelId}/messages`, { token: sender.token, ip: sender.ip, body: { ciphertext: 'v2:' + crypto.randomBytes(240).toString('base64'), epoch: 1, nonce } });
  const post = clock() - t;
  if (r.status !== 200) throw new Error(`send: ${r.status} ${r.text}`);
  return [post, (await arrived) - t];
}

// ------------------------------------------------------------------ main
(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const cpu = os.cpus();
  const machine = { cpu: cpu[0] && cpu[0].model, cores: cpu.length, ramGb: Math.round(os.totalmem() / 1073741824), node: process.version, os: `${os.platform()} ${os.release()}`, loadavg: os.loadavg().map((x) => Math.round(x * 100) / 100) };
  console.log(`Hearth at ${ROOT}\nMachine: ${machine.cpu}, ${machine.cores} cores, ${machine.ramGb} GB RAM, Node ${machine.node}, ${machine.os}, load ${machine.loadavg.join(' ')}`);
  console.log(`Data folder: ${DIR}\nSeeding (scale ${SCALE})…`);
  const dataset = seed();
  console.log('Dataset:', JSON.stringify(dataset));
  const memory = {};
  const extra = {};
  try {
    const first = await start();
    console.log(`Started in ${first.toFixed(0)} ms.`);
    await sleep(1000);
    memory.idleAfterStart = rssMb(child.pid);
    const heavy = users[S.heavy]; const owner = users[S.owner]; const light = users[S.light];
    const others = []; for (let i = 2; i < N.bigMembers; i++) others.push(users[i]);
    let turn = 0;
    const nextSender = () => others[turn++ % others.length];
    const asNext = () => { const u = nextSender(); return { token: u.token, ip: u.ip }; }; // requests from members in turn

    if (want('bootstrap')) {
      console.log('\nStart-up data');
      for (let i = 0; i < 3; i++) await timed('GET', '/bootstrap', { token: heavy.token, ip: heavy.ip }); // warm up
      const xs = []; let size = 0;
      for (let i = 0; i < 30; i++) { const { ms, r } = await timed('GET', '/bootstrap', { token: heavy.token, ip: heavy.ip }); xs.push(ms); size = r.text.length; }
      record(`/api/bootstrap, heavy user (${N.servers} servers, ${dataset.heavyUser.dmChannels} DMs)`, xs, { bytes: size });
    }
    if (want('members')) {
      // There is no separate member-list route: the app gets a server's members (ids, roles and profiles) in its
      // start-up data and in server:add. This is that for someone who is only in the big server.
      const xs = []; let size = 0;
      for (let i = 0; i < 30; i++) { const { ms, r } = await timed('GET', '/bootstrap', { token: light.token, ip: light.ip }); xs.push(ms); size = r.text.length; }
      record(`member list: /api/bootstrap of a member of only the ${N.bigMembers}-member server`, xs, { bytes: size });
    }
    if (want('history')) {
      console.log('\nChannel history');
      const ch = S.big.channels[0];
      const xs = [];
      for (let i = 0; i < 50; i++) xs.push((await timed('GET', `/channels/${ch}/messages`, asNext())).ms);
      record(`newest page (50) of #general, ${dataset.bigGeneralMessages} messages`, xs);
      const deep = [];
      const ids = S.depthIds;
      for (let i = 0; i < 50; i++) {
        const before = ids[Math.floor((i / 50) * ids.length)] || ids[0];
        const { ms, r } = await timed('GET', `/channels/${ch}/messages?before=${before}`, asNext());
        if (!r.json.messages.length) throw new Error('empty page');
        deep.push(ms);
      }
      record('?before= page (50) at depths spread over the whole history', deep);
      const walk = [];
      let cursor = null;
      for (let i = 0; i < 50; i++) {
        const { ms, r } = await timed('GET', `/channels/${ch}/messages?limit=100${cursor ? `&before=${cursor}` : ''}`, { token: heavy.token, ip: heavy.ip });
        walk.push(ms); cursor = r.json.messages[0] && r.json.messages[0].id;
      }
      record('paging back 100 at a time (50 pages in a row)', walk);
      const busy = [];
      for (let i = 0; i < 30; i++) busy.push((await timed('GET', `/channels/${S.threadChannel}/messages`, asNext())).ms);
      record(`newest page of a channel whose last ${S.threadReplies} messages are thread replies`, busy);
      const th = [];
      for (let i = 0; i < 30; i++) th.push((await timed('GET', `/messages/${S.threadRoot}/thread`, asNext())).ms);
      record(`thread view (newest 100 of ${S.threadReplies} replies)`, th);
      const pins = [];
      for (let i = 0; i < 30; i++) pins.push((await timed('GET', `/channels/${ch}/pins`, asNext())).ms);
      record(`pinned messages of #general (20 pins, ${dataset.bigGeneralMessages} messages)`, pins);
    }
    if (want('admin')) {
      console.log('\nAdmin');
      const xs = [];
      for (let i = 0; i < 10; i++) xs.push((await timed('GET', '/admin/stats', { token: owner.token, ip: owner.ip })).ms);
      record('/api/admin/stats (14-day activity series)', xs);
    }
    if (want('search')) {
      console.log('\nSearch');
      const xs = [];
      for (let i = 0; i < 30; i++) xs.push((await timed('GET', '/search/messages?scope=all&limit=100', { token: heavy.token, ip: heavy.ip })).ms);
      record(`search scope=all, heavy user (${N.servers * TEXT_CHANNELS} channels + DMs)`, xs);
      const ys = [];
      for (let i = 0; i < 30; i++) ys.push((await timed('GET', `/search/messages?scope=c:${S.big.channels[0]}&limit=100`, asNext())).ms);
      record('search one channel (big #general), newest 100', ys);
    }
    if (want('slowmode')) {
      // With slowmode on, sending looks up the sender's last message in that channel. Measured on the big #general
      // for members who never wrote there (no socket is connected yet, so this is the request alone).
      console.log('\nSlowmode');
      const d = new Database(path.join(DIR, 'hearth.db'));
      d.prepare('UPDATE channels SET slowmode = 30 WHERE id = ?').run(S.big.channels[0]);
      d.close();
      const lurkers = users.slice(S.lurkerFrom, N.bigMembers);
      const xs = [];
      for (let i = 0; i < Math.min(40, lurkers.length); i++) {
        const u = lurkers[i];
        const { ms } = await timed('POST', `/channels/${S.big.channels[0]}/messages`, { token: u.token, ip: u.ip, body: { ciphertext: 'v2:' + crypto.randomBytes(240).toString('base64'), epoch: 1 } });
        xs.push(ms);
      }
      record(`send in a slowmode channel (${dataset.bigGeneralMessages} messages), first message there`, xs);
      const d2 = new Database(path.join(DIR, 'hearth.db'));
      d2.prepare('UPDATE channels SET slowmode = 0 WHERE id = ?').run(S.big.channels[0]);
      d2.close();
    }
    if (want('perms')) { console.log('\nPermissions (in process)'); permsBench(); }
    memory.afterHttpLoad = rssMb(child.pid);

    const needSockets = want('fanout') || want('joinleave') || want('roles');
    let online = 0;
    if (needSockets) {
      console.log(`\nConnecting ${N.bigMembers} sockets (${WORKERS} client processes)…`);
      const t = performance.now();
      online = await startSockets(users.slice(0, N.bigMembers), S.privateViewers, S.big.channels[1]);
      extra.socketConnectSeconds = Math.round((performance.now() - t) / 100) / 10;
      await sleep(3000); // presence and the first updates settle
      memory.withSockets = rssMb(child.pid);
      console.log(`  ${online} connected in ${extra.socketConnectSeconds} s; server RSS ${memory.withSockets} MB`);
    }
    if (want('fanout')) {
      console.log('\nMessage send + fan-out');
      const everyone = (list) => list.length;
      for (let i = 0; i < 3; i++) await sendAndWait(S.big.channels[0], nextSender(), everyone);
      const post = []; const last = [];
      for (let i = 0; i < 40; i++) { const [p, l] = await sendAndWait(S.big.channels[0], nextSender(), everyone); post.push(p); last.push(l); }
      record(`send to #general: POST answered (${online} sockets)`, post);
      record(`send to #general: last of ${online} sockets has it`, last);
      // The private channel: only Staff (and the owner) may get it; anyone else receiving it counts as a leak.
      const viewersOf = (list) => list.filter((u) => S.privateViewers.has(u.id)).length;
      const viewers = workers.reduce((n, w) => n + viewersOf(w.users), 0);
      const staffSenders = others.filter((u) => S.privateViewers.has(u.id));
      const ppost = []; const plast = [];
      for (let i = 0; i < 43; i++) {
        const [p, l] = await sendAndWait(S.big.channels[1], staffSenders[i % staffSenders.length], viewersOf);
        if (i >= 3) { ppost.push(p); plast.push(l); }
      }
      await sleep(500);
      const leaks = await socketLeaks();
      record(`send to private channel: POST answered (${viewers} of ${online} may see it)`, ppost);
      record(`send to private channel: last of ${viewers} sockets has it`, plast, { leaks });
      if (leaks) throw new Error(`${leaks} private messages reached sockets that may not see the channel`);
    }
    if (want('roles')) {
      // Changing someone's roles sends every online member their own view of the server (emitServer).
      console.log('\nRole change in the big server');
      const xs = []; const ys = [];
      for (let i = 0; i < 12; i++) {
        const target = others[Math.floor(others.length / 2) + i];
        const roleIds = i % 2 ? [] : [S.big.roles[3]];
        const arrived = watchEvent('server:update', null, (list) => list.length);
        await sleep(5);
        const t = clock();
        const { ms } = await timed('PUT', `/servers/${S.big.id}/members/${target.id}/roles`, { token: owner.token, ip: owner.ip, body: { roleIds } });
        const all = (await arrived) - t;
        if (i >= 2) { xs.push(ms); ys.push(all); }
      }
      record(`role change: PUT answered (${online} online members)`, xs);
      record(`role change: last of ${online} sockets has its server:update`, ys);
    }
    if (want('joinleave')) {
      console.log('\nJoin / leave the big server');
      const inv = await call('POST', `/servers/${S.big.id}/invites`, { token: owner.token, ip: owner.ip, body: { maxUses: 0, expiresHours: 0 } });
      if (inv.status !== 200) throw new Error('invite: ' + inv.text);
      const joins = []; const leaves = [];
      for (let i = 0; i < 20; i++) {
        const u = users[N.bigMembers + i]; // never in the big server before
        joins.push((await timed('POST', `/invites/${inv.json.code}/join`, { token: u.token, ip: u.ip })).ms);
        leaves.push((await timed('POST', `/servers/${S.big.id}/leave`, { token: u.token, ip: u.ip })).ms);
      }
      record(`join (${N.bigMembers} members, ${online} online)`, joins);
      record(`leave (${N.bigMembers} members, ${online} online)`, leaves);
    }
    memory.afterLoad = rssMb(child.pid);
    await stopSockets();
    await sleep(1500);
    memory.afterSocketsClosed = rssMb(child.pid);
    await stop();

    if (want('startup')) {
      console.log('\nStart-up');
      const xs = [];
      for (let i = 0; i < 5; i++) { xs.push(await start()); await stop(); }
      record(`server start to /api/config OK (${dataset.dbMb} MB database)`, xs);
    }
    if (want('migration')) {
      // An upgrade from the previous schema version: user_version one lower and that version's new indexes
      // removed (as a database from the previous release would be). Start-up then copies the database to
      // backups/ (VACUUM INTO) and runs the whole migration transaction, building the indexes.
      console.log('\nUpgrade from the previous schema version');
      const src = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');
      const cur = Number(/SCHEMA_VERSION = (\d+)/.exec(src)[1]);
      let tag = 0; const added = [];
      for (const line of src.split('\n')) {
        // Comments name the version that added what follows ("// v17 (data): …", "// v12: …", "(schema v6)").
        const m = /^\/\/.*\bv(\d+)\b/.exec(line); if (m) tag = +m[1];
        if (line.includes("db.exec('BEGIN IMMEDIATE')")) tag = 0; // (comments above it are about the version check)
        const ix = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/.exec(line); if (ix && tag === cur) added.push(ix[1]);
      }
      const xs = [];
      for (let i = 0; i < 3; i++) {
        const d = new Database(path.join(DIR, 'hearth.db'));
        added.forEach((ix) => d.exec(`DROP INDEX IF EXISTS ${ix}`));
        d.pragma(`user_version = ${cur - 1}`);
        d.close();
        fs.rmSync(path.join(DIR, 'backups'), { recursive: true, force: true });
        xs.push(await start());
        await stop();
      }
      record(`upgrade v${cur - 1} → v${cur}: start to /api/config OK (rebuilds ${added.length} indexes)`, xs, { indexes: added });
    }
  } catch (e) {
    console.error(e);
    console.error('--- server log ---\n' + log.slice(-4000));
    process.exitCode = 1;
  } finally {
    await stopSockets();
    await stop();
  }
  console.log('\nServer memory (RSS, MB):', JSON.stringify(memory));
  const queryPlans = PLANS ? plans() : undefined;
  if (queryPlans) { console.log('\nQuery plans:'); for (const [k, v] of Object.entries(queryPlans)) console.log(`  ${k.padEnd(38)} ${v}`); }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ root: ROOT, at: new Date().toISOString(), scale: SCALE, machine, dataset, results, memory, extra, queryPlans }, null, 2));
  if (KEEP) console.log(`Kept ${DIR}`); else fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
