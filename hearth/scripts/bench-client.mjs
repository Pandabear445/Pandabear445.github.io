// Front-end measurements in a real browser (npm run bench:client): what the first load downloads, how
// long the app takes to become usable with a 4x slower CPU, scrolling back through a 10,000-message
// channel, and a 1,000-member list. Uses the same Playwright set-up as the browser tests
// (test/browser/harness.mjs). Prints a table and, with --json <file>, writes the numbers.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { launch, signUp, createServer, sendMessage, settle } from '../test/browser/harness.mjs';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const RUNS = Number(process.env.BENCH_RUNS || 5);
const HISTORY = Number(process.env.BENCH_HISTORY || 10000);
const MEMBERS = Number(process.env.BENCH_MEMBERS || 1000);
const PAGES = Number(process.env.BENCH_PAGES || 60);

const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };
const stats = (list) => ({ n: list.length, p50: Math.round(pct(list, 0.5) * 10) / 10, p95: Math.round(pct(list, 0.95) * 10) / 10 });
const out = { machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, ramGb: Math.round(os.totalmem() / 2 ** 30), node: process.version, platform: `${os.platform()} ${os.release()}` }, results: {} };
const say = (k, v) => { out.results[k] = v; console.log(k.padEnd(44), JSON.stringify(v)); };

const H = await launch();
try {
  // ------------------------------------------------------------------ set-up: an account and a server
  const p = await H.newPage({ width: 1366, height: 768 });
  await signUp(p, H.srv.base, 'bench');
  await createServer(p, 'Bench');
  await sendMessage(p, 'The first real message, copied below to make a long history.');
  const ids = await p.evaluate(() => ({ uid: localStorage.getItem('hearth.userId') }));

  // ------------------------------------------------------------------ first load: bytes
  const sizes = await H.newPage();
  const loaded = [];
  sizes.on('response', async (r) => {
    const u = new URL(r.url());
    if (!/\.(js|css)$/.test(u.pathname)) return;
    const body = await r.body().catch(() => null);
    loaded.push({ path: u.pathname, encoded: Number(r.headers()['content-length'] || 0) || null, decoded: body ? body.length : 0, enc: r.headers()['content-encoding'] || 'none' });
  });
  await sizes.goto(H.srv.base, { waitUntil: 'networkidle' });
  const js = loaded.filter((x) => x.path.endsWith('.js'));
  const css = loaded.filter((x) => x.path.endsWith('.css'));
  // Compressed sizes as the server's brotli would send them (the dev server doesn't always send content-length).
  const zlib = await import('node:zlib');
  const path = await import('node:path');
  const br = (rel) => {
    const f = rel.startsWith('/socket.io/') ? null : path.join(new URL('..', import.meta.url).pathname, 'public', rel);
    return f && fs.existsSync(f) ? zlib.brotliCompressSync(fs.readFileSync(f)).length : null;
  };
  say('load: JS files on the sign-in screen', js.length);
  say('load: JS bytes (raw / brotli)', { raw: js.reduce((a, x) => a + x.decoded, 0), brotli: js.reduce((a, x) => a + (br(x.path) || x.decoded), 0) });
  say('load: CSS bytes (raw / brotli)', { raw: css.reduce((a, x) => a + x.decoded, 0), brotli: css.reduce((a, x) => a + (br(x.path) || x.decoded), 0) });
  say('load: biggest JS files (raw bytes)', js.sort((a, b) => b.decoded - a.decoded).slice(0, 5).map((x) => `${x.path} ${x.decoded}`));
  await sizes.close();

  // ------------------------------------------------------------------ time until usable, CPU slowed 4x
  const timed = async (signedIn) => {
    const t = [];
    for (let i = 0; i < RUNS; i++) {
      const pg = await H.newPage();
      const cdp = await pg.context().newCDPSession(pg);
      await pg.goto(H.srv.base);
      // Signed in: log in at full speed first (the slow password step isn't what's measured), then reload.
      if (signedIn) {
        await pg.fill('#login-form [name=username]', 'bench');
        await pg.fill('#login-form [name=password]', 'correct horse battery staple');
        await pg.click('#login-form button[type=submit]');
        await pg.waitForSelector('#app:not([hidden]):not(.loading)', { timeout: 60000 });
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await pg.reload();
      const sel = signedIn ? '#app:not([hidden]):not(.loading) #composer-input, #app:not([hidden]):not(.loading) .home-view' : '#login-form:not([hidden]) input[name=username]';
      await pg.waitForSelector(sel, { timeout: 60000 });
      t.push(await pg.evaluate(() => performance.now()));
      await pg.close();
    }
    return stats(t);
  };
  say('load: sign-in form ready, ms (CPU 4x slower)', await timed(false));
  say('load: app ready when signed in, ms (CPU 4x slower)', await timed(true));

  // ------------------------------------------------------------------ a 10,000-message channel
  const db = H.srv.db();
  const row = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 1').get();
  const cols = Object.keys(row);
  const ins = db.prepare(`INSERT INTO messages (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const start = Date.now() - HISTORY * 60000;
  db.transaction(() => {
    for (let i = 0; i < HISTORY; i++) {
      const ts = start + i * 60000;
      const id = ts.toString(36).padStart(9, '0') + crypto.randomBytes(5).toString('hex');
      ins.run(...cols.map((c) => (c === 'id' ? id : c === 'created_at' ? ts : row[c])));
    }
  })();
  db.close();
  await p.reload(); await p.waitForSelector('#app:not([hidden]):not(.loading)');
  await p.click('#rail button[aria-label^="Bench"]'); await p.waitForSelector('#messages .msg'); await settle(p, 800);
  // JS heap after a full garbage collection, so the number doesn't depend on when the collector last ran.
  const cdp = await p.context().newCDPSession(p);
  const heapMb = async () => { await cdp.send('HeapProfiler.collectGarbage'); const u = await cdp.send('Runtime.getHeapUsage'); return Math.round(u.usedSize / 2 ** 20 * 10) / 10; };
  const counts = async () => ({ ...(await p.evaluate(() => ({ msgs: document.querySelectorAll('#messages .msg').length, nodes: document.querySelectorAll('*').length }))), heapMb: await heapMb() });
  say(`history: ${HISTORY} messages, after opening`, await counts());
  // Scroll to the top again and again, the way someone reading back would; each step loads one page.
  const pageTimes = [];
  for (let i = 0; i < PAGES; i++) {
    const before = await p.evaluate(() => document.querySelector('#messages .msg[data-mid]').dataset.mid);
    const t0 = Date.now();
    await p.evaluate(() => { const sc = document.querySelector('#messages'); sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll')); });
    const moved = await p.waitForFunction((b) => { const f = document.querySelector('#messages .msg[data-mid]'); return f && f.dataset.mid !== b; }, before, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!moved) break;
    pageTimes.push(Date.now() - t0);
  }
  await settle(p, 500);
  say(`history: load one older page, ms (${PAGES} pages)`, stats(pageTimes));
  const afterScroll = await counts();
  say(`history: after scrolling back ${pageTimes.length} pages`, afterScroll);
  // Jump back to the newest messages and check the old ones were let go.
  if (await p.locator('#jump-latest:not([hidden])').count()) await p.click('#jump-latest');
  await p.evaluate(() => { const sc = document.querySelector('#messages'); sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event('scroll')); });
  await settle(p, 1500);
  say('history: after jumping back to the latest', await counts());

  // ------------------------------------------------------------------ new messages arriving while reading the latest
  // 100 messages posted through the API (the same ciphertext again, so they decrypt); counts how much of the list
  // is torn down and rebuilt per arrival, and how long each takes to appear.
  const token = await p.evaluate(() => localStorage.getItem('hearth.token'));
  const db1 = H.srv.db();
  const last = db1.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 1').get();
  db1.close();
  await p.evaluate(() => {
    window.__removed = 0;
    window.__mo = new MutationObserver((list) => { for (const m of list) window.__removed += m.removedNodes.length; });
    window.__mo.observe(document.querySelector('#messages'), { childList: true });
  });
  const arrive = [];
  for (let i = 0; i < 100; i++) {
    const t0 = Date.now();
    const r = await H.srv.api('POST', `/channels/${last.channel_id}/messages`, { token, body: { ciphertext: last.ciphertext, epoch: last.epoch }, ip: `198.18.9.${1 + (i % 200)}` });
    // The server allows 25 messages per 10 s per session: wait and try again, outside the timing.
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 2000)); i--; continue; }
    if (r.status !== 200) { say('incoming: posting failed', `${r.status} ${r.text.slice(0, 120)}`); break; }
    const id = r.json.id || (r.json.message && r.json.message.id);
    await p.waitForSelector(`#messages .msg[data-mid="${id}"]`, { timeout: 5000 });
    arrive.push(Date.now() - t0);
  }
  if (arrive.length) {
    say('incoming: message on screen after posting, ms', stats(arrive));
    say('incoming: list nodes removed during 100 arrivals', await p.evaluate(() => window.__removed));
    say('incoming: after 100 arrivals', await counts());
  }

  // ------------------------------------------------------------------ a 1,000-member server
  const db2 = H.srv.db();
  const server = db2.prepare('SELECT server_id FROM members WHERE user_id = ?').get(ids.uid).server_id;
  const u = db2.prepare('SELECT * FROM users WHERE id = ?').get(ids.uid);
  const ucols = Object.keys(u);
  const uins = db2.prepare(`INSERT INTO users (${ucols.join(',')}) VALUES (${ucols.map(() => '?').join(',')})`);
  const mins = db2.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)');
  db2.transaction(() => {
    for (let i = 0; i < MEMBERS - 1; i++) {
      const id = (Date.now() + i).toString(36).padStart(9, '0') + crypto.randomBytes(5).toString('hex');
      const name = `member${String(i).padStart(4, '0')}`;
      uins.run(...ucols.map((c) => (c === 'id' ? id : c === 'username' ? name : c === 'email' ? null : c === 'profile' ? '{}' : u[c])));
      mins.run(server, id, Date.now());
    }
  })();
  db2.close();
  await H.srv.restart();
  await p.reload(); await p.waitForSelector('#app:not([hidden]):not(.loading)');
  await p.click('#rail button[aria-label^="Bench"]'); await p.waitForSelector('#messages .msg'); await settle(p, 800);
  const open = [];
  const search = [];
  for (let i = 0; i < RUNS; i++) {
    if (await p.locator('#members:not([hidden])').count()) { await p.click('#main-head button[aria-label="Hide members"]'); await settle(p, 200); }
    const t0 = await p.evaluate(() => performance.now());
    await p.click('#main-head button[aria-label="Show members"]');
    await p.waitForFunction((n) => document.querySelectorAll('#members .member').length >= Math.min(n, 1) && !!document.querySelector('#members .group-label'), MEMBERS);
    const t = await p.evaluate((a) => new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(performance.now() - a)))), t0);
    open.push(t);
    const ts = await p.evaluate(() => {
      const s = document.querySelector('#members .search-input');
      const a = performance.now();
      s.value = 'member01'; s.dispatchEvent(new Event('input'));
      s.value = ''; s.dispatchEvent(new Event('input'));
      return performance.now() - a;
    });
    search.push(ts / 2);
  }
  // The very first open also pins every member's keys on this device (once per person), so it's shown apart.
  say(`members: first open of the ${MEMBERS}-member list, ms`, Math.round(open[0]));
  say(`members: open it again, ms`, stats(open.slice(1)));
  say('members: rows in the DOM', await p.evaluate(() => document.querySelectorAll('#members .member').length));
  say('members: one search keystroke, ms', stats(search));
} finally {
  await H.close();
}
console.log('\nmachine', JSON.stringify(out.machine));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
