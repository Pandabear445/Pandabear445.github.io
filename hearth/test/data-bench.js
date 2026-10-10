// Benchmark for two data-layer hot spots (not part of `npm test`: it takes a minute and only prints numbers).
//   join/leave in a big server: how long the request takes and how long everyone else's requests wait
//   start-up data (/bootstrap) for someone in quiet group chats on an instance with many messages elsewhere
//
//   node test/data-bench.js [members=2000] [online=200] [messages=500000]
//   HEARTH_ROOT=/path/to/other/hearth node test/data-bench.js     (measure another checkout, e.g. an older release)
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.resolve(process.env.HEARTH_ROOT || path.join(__dirname, '..'));
const { startServer, hex, sleep } = require(path.join(ROOT, 'test', 'helpers.js'));
const [M = 2000, ONLINE = 200, MESSAGES = 500000] = process.argv.slice(2).map(Number);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Measures fn() while pinging /api/config every 20 ms as "everyone else".
async function measure(srv, fn) {
  let worst = 0; let stop = false;
  const pinger = (async () => { while (!stop) { const s = Date.now(); await fetch(srv.base + '/api/config'); worst = Math.max(worst, Date.now() - s); await sleep(20); } })();
  const t = Date.now();
  try { await fn(); } finally { stop = true; await pinger; }
  return { ms: Date.now() - t, worst };
}

async function joinLeave() {
  const srv = await startServer();
  const sockets = [];
  try {
    const o = srv.owner;
    const oc = (m, p, body) => srv.api(m, p, { token: o.token, body, ip: o.ip, timeout: 300000 });
    const s = (await oc('POST', '/servers', { name: 'Big' })).json;
    for (let i = 0; i < 10; i++) await oc('POST', `/servers/${s.id}/channels`, { name: 'c' + i, type: 'text' });
    const d = srv.db(); const t = Date.now();
    const tokens = [];
    d.transaction(() => {
      const iu = d.prepare("INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, created_at) VALUES (?, ?, 'x', 'k', 'e', ?)");
      const im = d.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)');
      const ik = d.prepare("INSERT INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, 1, ?, ?, ?, ?)");
      const is = d.prepare('INSERT INTO sessions (id, token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
      d.prepare("INSERT INTO server_epochs (server_id, epoch, key_check, creator_id, created_at) VALUES (?, 1, 'chk', ?, ?)").run(s.id, o.id, t);
      ik.run(s.id, o.id, 'w'.repeat(400), o.id, t);
      for (let i = 0; i < M; i++) {
        const id = 'fake' + i;
        iu.run(id, id, t); im.run(s.id, id, t + i); ik.run(s.id, id, 'w'.repeat(400), o.id, t);
        if (i < ONLINE) { const tok = hex(32); tokens.push(tok); is.run(hex(12), crypto.createHash('sha256').update(tok).digest('hex'), id, t, t, t + 86400000); }
      }
    })();
    d.prepare('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?').run(s.id); d.close();
    // Members with the app open (they receive every update).
    for (const tok of tokens) { const so = await srv.socket(tok); so.on('server:update', () => {}); sockets.push(so); }
    const code = (await oc('POST', `/servers/${s.id}/invites`, {})).json.code;
    const a = await srv.register('mallory');
    const joins = []; const leaves = []; let worst = 0;
    for (let i = 0; i < 3; i++) {
      const j = await measure(srv, () => srv.api('POST', `/invites/${code}/join`, { token: a.token, ip: a.ip, timeout: 300000 }));
      const l = await measure(srv, () => srv.api('POST', `/servers/${s.id}/leave`, { token: a.token, ip: a.ip, timeout: 300000 }));
      joins.push(j.ms); leaves.push(l.ms); worst = Math.max(worst, j.worst, l.worst);
    }
    console.log(`join/leave, ${M + 1} members (${ONLINE} online), 12 channels: join median ${median(joins)} ms [${joins.join(', ')}], leave median ${median(leaves)} ms [${leaves.join(', ')}], others waited up to ${worst} ms`);
  } finally { sockets.forEach((x) => x.close()); await srv.stop(); }
}

async function bootstrapGroups() {
  const srv = await startServer();
  try {
    const o = srv.owner; const c = await srv.register('carol');
    const oc = (u, m, p, body) => srv.api(m, p, { token: u.token, body, ip: u.ip, timeout: 300000 });
    const hq = (await oc(o, 'POST', '/servers', { name: 'HQ' })).json;
    const { code } = (await oc(o, 'POST', `/servers/${hq.id}/invites`, {})).json;
    await oc(c, 'POST', `/invites/${code}/join`);
    for (let i = 0; i < 10; i++) await oc(c, 'POST', '/groups', { userIds: [o.id], name: 'g' + i });
    const time = async () => { const runs = []; for (let i = 0; i < 5; i++) { const t = Date.now(); await oc(c, 'GET', '/bootstrap'); runs.push(Date.now() - t); } return median(runs); };
    const quiet = await time();
    const busy = hq.channels.find((x) => x.type === 'text');
    const d = srv.db();
    const ins = d.prepare("INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, '', 'v2:x', 1, ?)");
    const t0 = Date.now() - 10 * MESSAGES;
    d.transaction(() => { for (let i = 0; i < MESSAGES; i++) ins.run((t0 + i).toString(36).padStart(9, '0') + hex(5), busy.id, o.id, t0 + i); })();
    d.close();
    const loud = await time();
    console.log(`/bootstrap for someone in 10 quiet groups: median ${quiet} ms with no other messages, ${loud} ms with ${MESSAGES} messages elsewhere`);
  } finally { await srv.stop(); }
}

(async () => {
  console.log(`Hearth at ${ROOT}`);
  await joinLeave();
  await bootstrapGroups();
})().catch((e) => { console.error(e); process.exit(1); });
