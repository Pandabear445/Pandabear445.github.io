#!/usr/bin/env node
// Benchmark for message search (GET /api/search/messages). Not part of npm test.
//
//   node scripts/bench-search.js [messages=200000] [channels=50]
//
// Starts a real server on a temporary data folder (test/helpers.js), fills it with ciphertext-sized messages
// spread over 5 servers and their channels, plus 20 DMs, then times representative searches over HTTP (auth,
// access checks, serialization and gzip included) and prints the SQLite query plans they use. Search allows
// 60 requests a minute per person, so requests rotate over a few accounts that all see the same data.
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startServer } = require(path.join(__dirname, '..', 'test', 'helpers'));

const TOTAL = parseInt(process.argv[2] || '200000', 10);
const CHANNELS = parseInt(process.argv[3] || '50', 10);
const SERVERS = 5;
const DMS = 20;
const DM_MESSAGES = 1000;
const RUNS = 15;
const DAY = 86400000;

const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const ms = (x) => `${x.toFixed(1)} ms`;

(async () => {
  console.log(`Seeding ${TOTAL.toLocaleString()} channel messages in ${CHANNELS} channels (${SERVERS} servers) + ${(DMS * DM_MESSAGES).toLocaleString()} DM messages…`);
  const srv = await startServer();
  try {
    const people = [];
    for (let i = 0; i < 6; i++) people.push(await srv.register(`bench${i}`));
    const others = [];
    for (let i = 0; i < 20; i++) others.push(await srv.register(`writer${i}`));
    const me = people[0];
    const servers = [];
    for (let i = 0; i < SERVERS; i++) servers.push((await srv.api('POST', '/servers', { token: me.token, ip: me.ip, body: { name: `Bench ${i}` } })).json);

    const d = srv.db();
    const t0 = Date.now();
    const start = Date.now() - 365 * DAY; // a year of history
    const channels = [];
    const dms = [];
    d.transaction(() => {
      const addMember = d.prepare('INSERT OR IGNORE INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)');
      for (const s of servers) for (const u of [...people, ...others]) addMember.run(s.id, u.id, start);
      // Channels beyond each server's own #general.
      const addChannel = d.prepare("INSERT INTO channels (id, server_id, name, type, position, created_at, category) VALUES (?, ?, ?, 'text', ?, ?, 'Text')");
      servers.forEach((s) => channels.push(s.channels.find((c) => c.type === 'text').id));
      for (let i = channels.length; i < CHANNELS; i++) {
        const id = 'bc' + crypto.randomBytes(6).toString('hex');
        addChannel.run(id, servers[i % SERVERS].id, `channel-${i}`, i, start);
        channels.push(id);
      }
      // Busy channels and quiet ones: channel i gets a share proportional to 1/(i+1), like real servers.
      const weights = channels.map((_, i) => 1 / (i + 1));
      const sum = weights.reduce((a, b) => a + b, 0);
      const cum = [];
      weights.reduce((a, w, i) => (cum[i] = a + w / sum), 0);
      const addMsg = d.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const cipher = 'v2:' + crypto.randomBytes(240).toString('base64'); // a typical short message, encrypted
      for (let i = 0; i < TOTAL; i++) {
        const r = Math.random();
        let c = cum.findIndex((x) => x >= r);
        if (c < 0) c = channels.length - 1;
        const at = start + Math.floor((i / TOTAL) * 365 * DAY);
        const author = i % 50 === 0 ? people[1] : others[i % others.length]; // bench1 writes 2% of messages
        addMsg.run(at.toString(36).padStart(9, '0') + crypto.randomBytes(5).toString('hex'), channels[c], author.id, '', cipher, 1, at);
      }
      const addDm = d.prepare('INSERT INTO dm_channels (id, user_a, user_b, last_message_at, created_at) VALUES (?, ?, ?, ?, ?)');
      const addDmMsg = d.prepare('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)');
      for (let k = 0; k < DMS; k++) {
        const other = others[k];
        const [a, b] = [me.id, other.id].sort();
        const id = 'bd' + crypto.randomBytes(6).toString('hex');
        addDm.run(id, a, b, Date.now(), start);
        dms.push(id);
        for (let i = 0; i < DM_MESSAGES; i++) {
          const at = start + Math.floor(Math.random() * 365 * DAY);
          addDmMsg.run(at.toString(36).padStart(9, '0') + crypto.randomBytes(5).toString('hex'), id, i % 2 ? me.id : other.id, cipher, at);
        }
      }
    })();
    console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s. Database: ${(require('fs').statSync(path.join(srv.dir, 'hearth.db')).size / 1048576).toFixed(0)} MB (+ WAL)\n`);

    // Requests rotate over the bench accounts (all members of every server; only bench0 has the DMs). Each
    // account waits when it's about to go over the server's 60 searches a minute (waiting isn't timed).
    let turn = 0;
    const sent = new Map();
    const pace = async (u) => {
      const now = () => Date.now();
      const list = (sent.get(u.id) || []).filter((x) => x > now() - 60000);
      if (list.length >= 58) await new Promise((r) => setTimeout(r, list[0] + 60500 - now()));
      sent.set(u.id, [...list.filter((x) => x > now() - 60000), now()]);
    };
    const run = async (params, who) => {
      const u = who || people[turn++ % people.length];
      await pace(u);
      const t = process.hrtime.bigint();
      const r = await srv.api('GET', '/search/messages?' + new URLSearchParams(params), { token: u.token, ip: u.ip, headers: { 'accept-encoding': 'gzip' } });
      const took = Number(process.hrtime.bigint() - t) / 1e6;
      if (r.status !== 200) throw new Error(`${r.status} ${r.text}`);
      return { took, json: r.json };
    };
    const midCursor = (await run({ scope: 'c:' + channels[0], limit: '200' })).json.nextCursor;
    let deep = midCursor;
    for (let i = 0; i < 40 && deep; i++) deep = (await run({ scope: 'c:' + channels[0], limit: '200', cursor: deep })).json.nextCursor;
    const midYear = start + 180 * DAY;
    const cases = [
      ['one channel, newest 100', { scope: 'c:' + channels[0] }],
      ['one channel, 200 at ~8,000 back (cursor)', { scope: 'c:' + channels[0], limit: '200', cursor: deep }],
      ['quiet channel, newest 100', { scope: 'c:' + channels[CHANNELS - 1] }],
      ['one server (10 channels), newest 200', { scope: 's:' + servers[0].id, limit: '200' }],
      ['all (50 channels + 20 DMs), newest 200', { scope: 'all', limit: '200' }, me],
      ['all, from: an author with 2% of messages', { scope: 'all', from: people[1].id, limit: '200' }, me],
      ['all, from: someone with no messages', { scope: 'all', from: people[2].id, limit: '200' }, me],
      ['all, one day in the middle of the year', { scope: 'all', after: String(midYear), before: String(midYear + DAY), limit: '200' }, me],
      ['one DM, newest 100', { scope: 'd:' + dms[0] }, me],
    ];
    console.log('Query'.padEnd(46), 'results'.padStart(7), 'median'.padStart(10), 'p95'.padStart(10));
    for (const [name, params, who] of cases) {
      const times = [];
      let n = 0;
      for (let i = 0; i < RUNS; i++) { const r = await run(params, who); times.push(r.took); n = r.json.messages.length; }
      console.log(name.padEnd(46), String(n).padStart(7), ms(pct(times, 50)).padStart(10), ms(pct(times, 95)).padStart(10));
    }
    // One click in the app: up to 1000 messages, 5 pages of 200, following nextCursor (request time only).
    const clicks = [];
    for (let k = 0; k < 5; k++) {
      let cursor = null;
      let total = 0;
      for (let i = 0; i < 5; i++) { const r = await run({ scope: 'all', limit: '200', ...(cursor ? { cursor } : {}) }, me); cursor = r.json.nextCursor; total += r.took; }
      clicks.push(total);
    }
    console.log('one click: 5 pages of 200, scope=all'.padEnd(46), '1000'.padStart(7), ms(pct(clicks, 50)).padStart(10), ms(pct(clicks, 95)).padStart(10));

    // The plans of the exact statements server/search.js runs, without statistics (Hearth never runs ANALYZE)
    // and with them.
    const { SQL } = require(path.join(__dirname, '..', 'server', 'search'));
    const plans = (label) => {
      console.log(`\nQuery plans (${label}):`);
      for (const [k, sql] of Object.entries(SQL)) {
        const args = [channels[0], ...(k.endsWith('a') ? [people[1].id] : []), Date.now(), '', 0, '', 201];
        console.log(`  ${k.padEnd(3)}`, d.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' | '));
      }
    };
    plans('no statistics');
    d.exec('ANALYZE');
    plans('after ANALYZE');
    d.close();
    const cpu = os.cpus();
    console.log(`\nMachine: ${cpu[0].model}, ${cpu.length} CPUs, ${(os.totalmem() / 1073741824).toFixed(0)} GB RAM, load ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}, Node ${process.version}, ${os.platform()} ${os.release()}`);
  } finally {
    await srv.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
