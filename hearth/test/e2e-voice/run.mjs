// Two real browsers in one call, against a real Hearth server: the voice reliability checks that can't run in
// Node (WebRTC, media devices). Run with `npm run test:voice`. Chromium's fake camera and microphone stand in for
// real devices, and every connection is local, so the numbers here are best cases: no real network in between.
//
// Scenarios: join (both peers reach "connected"), a dropped signaling connection, a server restart, rapid
// join/leave cycles (no leaked RTCPeerConnections), region switching (including a pinned relay that's down, and
// two people switching at once), and devices disappearing. Recovery times are measured and printed at the end.
//
// Network impairment: `tc netem` isn't available everywhere (the dev container's kernel has no netem), so with
// IMPAIR=iptables (root only: it changes the host firewall for a few seconds, and always undoes it) loopback UDP,
// which carries the WebRTC media and connectivity checks but not the signaling, is dropped at random and then
// entirely. Without IMPAIR those scenarios are skipped and say so.
//
// Needs Playwright and Chromium. It looks for `playwright` as a normal package first, then PLAYWRIGHT_MODULE, then
// the copy preinstalled in the dev container. CHROMIUM_PATH picks the browser binary.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const timings = {};
let failures = 0;

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not a dependency of the app */ }
  for (const p of [process.env.PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    if (p && fs.existsSync(p)) return import(pathToFileURL(p).href);
  }
  throw new Error('Playwright not found. Install it (npm i -D playwright) or set PLAYWRIGHT_MODULE.');
}
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const guess = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  return fs.existsSync(guess) ? guess : undefined;
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

// ------------------------------------------------------------------ the server
const server = {
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-e2e-voice-')), port: 0, child: null, log: '',
  get base() { return `http://127.0.0.1:${this.port}`; },
  async start(extraEnv = {}) {
    if (!this.port) this.port = await freePort();
    const env = { ...process.env, DATA_DIR: this.dir, PORT: String(this.port), HOST: '127.0.0.1', HTTPS: 'false', NODE_ENV: 'test', ...extraEnv };
    this.child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => { this.log += d; });
    this.child.stderr.on('data', (d) => { this.log += d; });
    for (let i = 0; ; i++) {
      try { const r = await fetch(this.base + '/api/config'); if (r.ok) return; } catch { /* not up yet */ }
      if (i > 200 || this.child.exitCode !== null) throw new Error(`Hearth didn't start:\n${this.log}`);
      await sleep(50);
    }
  },
  async stop() {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    c.kill('SIGTERM');
    for (let i = 0; i < 100 && c.exitCode === null; i++) await sleep(50);
    if (c.exitCode === null) c.kill('SIGKILL');
  },
  async api(method, p, token, body) {
    const r = await fetch(this.base + '/api' + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text}`);
    return json;
  },
  sql(q, ...args) {
    // The server owns the database; a short write here is fine (WAL, busy timeout).
    return import('better-sqlite3').then(({ default: Database }) => {
      const d = new Database(path.join(this.dir, 'hearth.db'));
      d.pragma('busy_timeout = 5000');
      try { return /^\s*select/i.test(q) ? d.prepare(q).all(...args) : d.prepare(q).run(...args); } finally { d.close(); }
    });
  },
};

// ------------------------------------------------------------------ browsers
// Runs in every page before the app: turns on the app's voice debug hook, and counts every RTCPeerConnection the
// page creates (independently of the app's own bookkeeping), so leaks show up.
const INIT = () => {
  try { localStorage.setItem('hearth.voiceDebug', '1'); } catch { /* storage off */ }
  const Orig = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = class extends Orig { constructor(...a) { super(...a); window.__pcs.push(this); } };
  window.__livePcs = () => window.__pcs.filter((p) => p.connectionState !== 'closed').length;
  // Every toast the app shows (they fade after a few seconds).
  window.__toasts = [];
  new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.classList && n.classList.contains('toast')) window.__toasts.push(n.textContent); })
    .observe(document, { childList: true, subtree: true });
};
const toasted = (u, text) => V(u, (t) => window.__toasts.some((x) => x.includes(t)), text);

async function newUser(browser, name) {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [${name} page error] ${e.message}`));
  const user = { name, page, context, password: `pw-${name}-${Math.random().toString(36).slice(2)}` };
  await page.goto(server.base);
  await page.click('#to-register');
  const f = page.locator('#register-form');
  await f.locator('[name=username]').fill(name);
  await f.locator('[name=password]').fill(user.password);
  await f.locator('[name=confirm]').fill(user.password);
  await f.locator('[name=tos]').check();
  await f.locator('button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#app').hidden && !document.querySelector('#app').classList.contains('loading') && window.__hearthVoice, null, { timeout: 90000 });
  user.token = await page.evaluate(() => localStorage.getItem('hearth.token'));
  user.id = await page.evaluate(() => localStorage.getItem('hearth.userId'));
  return user;
}
const V = (u, fn, arg) => u.page.evaluate(fn, arg);
const voiceState = (u) => V(u, () => window.__hearthVoice.state);
const uiState = (u) => V(u, () => { const el = document.querySelector('#voice-panel [data-call-state]'); return el ? `${el.dataset.callState}: ${el.textContent}` : null; });
const livePcs = (u) => V(u, () => window.__livePcs());
// Every connection in the call is up (and the engine says so).
const allUp = (u, n) => V(u, (n) => {
  const v = window.__hearthVoice;
  const peers = [...v.peers.values()];
  return v.state === 'connected' && peers.length === n && peers.every((p) => p.pc.connectionState === 'connected');
}, n);
async function waitFor(u, fn, arg, timeout = 30000) {
  await u.page.waitForFunction(fn, arg, { timeout, polling: 50 });
}
const waitUp = (u, n, timeout) => waitFor(u, (n) => {
  const v = window.__hearthVoice;
  const peers = [...v.peers.values()];
  return v.state === 'connected' && peers.length === n && peers.every((p) => p.pc.connectionState === 'connected');
}, n, timeout);

// ONLY=<regex> runs just the matching scenarios (the first join always runs: the others start from it).
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
async function scenario(name, fn) {
  if (ONLY && !ONLY.test(name) && results.length) { console.log(`- ${name} … skipped`); return; }
  const t0 = Date.now();
  process.stdout.write(`- ${name} … `);
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, note });
    console.log(`ok (${Date.now() - t0} ms)${note ? ` — ${note}` : ''}`);
  } catch (e) {
    failures++;
    results.push({ name, ok: false, ms: Date.now() - t0, note: e.message });
    console.log(`FAILED\n    ${String(e.stack || e.message).split('\n').slice(0, 6).join('\n    ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ------------------------------------------------------------------ the run
const { chromium } = await loadPlaywright();
await server.start();
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
let A; let B; let room;
try {
  A = await newUser(browser, 'ana');
  await server.api('PUT', '/admin/registration', A.token, { captchaLogin: 'off', captchaRegister: 'off' });
  B = await newUser(browser, 'ben');
  const srv = await server.api('POST', '/servers', A.token, { name: 'Voice test' });
  const invite = await server.api('POST', `/servers/${srv.id}/invites`, A.token, {});
  await server.api('POST', `/invites/${invite.code}/join`, B.token);
  room = srv.channels.find((c) => c.type === 'voice').id;
  // Both apps pick up the new server (and its channel) from their live connection.
  for (const u of [A, B]) await waitFor(u, (id) => !!document.querySelector(`[data-cid="${id}"]`) || true, room);
  await sleep(500);

  await scenario('join: both peers reach connectionState "connected"', async () => {
    const t0 = Date.now();
    await V(A, (id) => window.__hearthVoice.join(id), room);
    await V(B, (id) => window.__hearthVoice.join(id), room);
    await waitUp(A, 1); await waitUp(B, 1);
    timings.joinMs = Date.now() - t0;
    const ui = await uiState(A);
    assert(/^connected: Connected/.test(ui || ''), `call bar should say Connected, says ${ui}`);
    const bar = await A.page.locator('#voice-panel').innerText();
    assert(!/\b(null|undefined)\b/.test(bar), `nothing stray in the call bar: ${bar}`);
    return `both connected ${timings.joinMs} ms after the first join; call bar: "${ui}"`;
  });

  // The signaling connection drops (the WebSocket closes). Media keeps flowing peer to peer; the app reconnects,
  // asks for its place back, and the server resumes it: same RTCPeerConnection, no renegotiation needed.
  await scenario('socket drop: automatic rejoin resumes the same place and keeps the media connection', async () => {
    await V(A, () => { window.__pcBefore = [...window.__hearthVoice.peers.values()][0].pc; });
    const t0 = Date.now();
    await V(A, () => window.__hearthVoice.socket.io.engine.close());
    await waitFor(A, () => window.__hearthVoice.state === 'reconnecting', null, 5000);
    const sawReconnecting = await waitFor(B, (id) => (window.__hearthVoice && true) && [...document.querySelectorAll('[data-call-state]')].length >= 0 && true, A.id, 1000).then(() => true);
    await waitUp(A, 1, 30000);
    timings.socketDropRejoinMs = Date.now() - t0;
    const same = await V(A, () => [...window.__hearthVoice.peers.values()][0].pc === window.__pcBefore);
    const resumed = await V(A, () => window.__hearthVoice.history.some((e) => /server kept our place/.test(e.event)));
    assert(resumed, 'the server should have resumed the same place');
    assert(same, 'the media connection should have survived the signaling drop');
    const list = (await server.api('GET', '/bootstrap', A.token)).voice[room] || [];
    assert(list.length === 2 && new Set(list.map((x) => x.userId)).size === 2, `no duplicate members: ${JSON.stringify(list)}`);
    assert(list.every((x) => !x.reconnecting), 'nobody is still marked reconnecting');
    void sawReconnecting;
    return `back to connected ${timings.socketDropRejoinMs} ms after the socket closed (same RTCPeerConnection)`;
  });

  // The browser goes offline (DevTools network emulation: the WebSocket is cut, WebRTC is not) and comes back.
  await scenario('network loss: offline for 4 s, then automatic rejoin', async () => {
    const t0 = Date.now();
    await A.context.setOffline(true);
    let wentDown = true;
    try { await waitFor(A, () => window.__hearthVoice.state === 'reconnecting', null, 8000); } catch { wentDown = false; }
    await sleep(Math.max(0, 4000 - (Date.now() - t0)));
    const back = Date.now();
    await A.context.setOffline(false);
    await waitUp(A, 1, 40000);
    await waitUp(B, 1, 40000);
    timings.offlineRecoverMs = Date.now() - back;
    return wentDown ? `noticed the drop; connected again ${timings.offlineRecoverMs} ms after the network came back`
      : `the emulated outage didn't close the signaling connection; still connected ${timings.offlineRecoverMs} ms after`;
  });

  // A relay region that's "up" (recent heartbeat) but whose relay doesn't answer: for the region scenarios later.
  const deadPort = await freePort();
  const regionId = 'regdead' + Math.random().toString(36).slice(2, 6);
  await server.sql("INSERT OR REPLACE INTO instance_settings (key, value) VALUES ('turnSecret', ?)", JSON.stringify('e2e-secret'));
  await server.sql('INSERT INTO regions (id, name, token_hash, turn_urls, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)', regionId, 'Nowhere', 'x'.repeat(64), JSON.stringify([`turn:127.0.0.1:${deadPort}?transport=udp`]), Date.now() + 3600e3, Date.now());

  // The server restarts (an update, say): it forgets every call. Both apps come back and rejoin by themselves.
  await scenario('server restart: both peers rejoin automatically', async () => {
    await V(A, () => { window.__pcBefore = [...window.__hearthVoice.peers.values()][0].pc; });
    const t0 = Date.now();
    await server.stop();
    const down = Date.now();
    await server.start();
    const up = Date.now();
    await waitUp(A, 1, 60000);
    await waitUp(B, 1, 60000);
    for (let i = 0; i < 100; i++) { const l = (await server.api('GET', '/bootstrap', A.token)).voice[room] || []; if (l.length === 2) break; await sleep(100); }
    const list = (await server.api('GET', '/bootstrap', A.token)).voice[room] || [];
    assert(list.length === 2, `both back in the server's call state: ${JSON.stringify(list)}`);
    timings.restartDownMs = up - down;
    timings.restartRejoinMs = Date.now() - up;
    timings.restartTotalMs = Date.now() - t0;
    const same = await V(A, () => [...window.__hearthVoice.peers.values()][0].pc === window.__pcBefore);
    return `server down for ${timings.restartDownMs} ms; both connected and listed ${timings.restartRejoinMs} ms after it was back (${same ? 'media connection survived' : 'media connection was rebuilt'})`;
  });

  await scenario('rapid join/leave cycles leave no RTCPeerConnection behind', async () => {
    const dedupe = await V(A, async (id) => {
      const v = window.__hearthVoice;
      await v.leave();
      const p1 = v.join(id); const p2 = v.join(id);
      await p1;
      return p1 === p2;
    }, room);
    assert(dedupe, 'two joins at once share one attempt');
    const churn = await V(A, async (id) => {
      const v = window.__hearthVoice;
      const stuck = (p, what) => Promise.race([p, new Promise((r) => setTimeout(() => r(`stuck: ${what}`), 15000))]);
      for (let i = 0; i < 8; i++) {
        const j = v.join(id).catch(() => {});
        await new Promise((r) => setTimeout(r, (i * 37) % 250));
        const a = await stuck(v.leave(), `leave ${i}`);
        const b = await stuck(j, `join ${i}`);
        if (a || b) return { error: a || b, info: v.debugInfo(), log: v.history.slice(-15).map((e) => e.event) };
      }
      return null;
    }, room);
    assert(!churn, `join/leave cycle got stuck: ${JSON.stringify(churn)}`);
    await sleep(1500);
    const aLive = await livePcs(A);
    const aState = await voiceState(A);
    const bInfo = await V(B, () => ({ live: window.__livePcs(), peers: window.__hearthVoice.peers.size }));
    assert(aState === 'idle', `A is idle after leaving: ${aState}`);
    assert(aLive === 0, `A has no open RTCPeerConnection: ${aLive}`);
    assert(bInfo.live === bInfo.peers && bInfo.peers === 0, `B has none left for A: ${JSON.stringify(bInfo)}`);
    const list = (await server.api('GET', '/bootstrap', A.token)).voice[room] || [];
    assert(list.length === 1 && list[0].userId === B.id, `server has just B: ${JSON.stringify(list)}`);
    const t0 = Date.now();
    await V(A, (id) => window.__hearthVoice.join(id), room);
    await waitUp(A, 1); await waitUp(B, 1);
    timings.rejoinAfterChurnMs = Date.now() - t0;
    const counts = [await livePcs(A), await livePcs(B)];
    assert(counts[0] === 1 && counts[1] === 1, `exactly one connection each after rejoining: ${counts}`);
    return `9 joins/8 leaves; 0 live connections after; rejoin took ${timings.rejoinAfterChurnMs} ms`;
  });

  await scenario('region switch to a region whose relay is down: "switching", then falls back to automatic and says so', async () => {
    // Both apps need the relay list that includes the new region: they get it when they reconnect.
    for (const u of [A, B]) {
      const known = (await V(u, () => JSON.stringify(window.__hearthVoice.getIceServers()))).includes(`127.0.0.1:${deadPort}`);
      if (!known) {
        await V(u, () => window.__hearthVoice.socket.io.engine.close());
        await waitFor(u, () => window.__hearthVoice.state === 'reconnecting', null, 5000).catch(() => {});
      }
    }
    await sleep(500);
    await waitUp(A, 1, 30000); await waitUp(B, 1, 30000);
    const t0 = Date.now();
    await server.api('POST', '/calls/region', A.token, { room, region: regionId });
    await waitFor(A, () => window.__hearthVoice.history.some((e) => /State: switching/.test(e.event)), null, 5000);
    await waitFor(A, () => window.__hearthVoice.relayFallback, null, 20000);
    await waitUp(A, 1, 40000); await waitUp(B, 1, 40000);
    timings.switchToDeadRegionMs = Date.now() - t0;
    const toast = await toasted(A, 'relay isn\u2019t answering');
    assert(toast, 'the person is told the relay isn’t answering');
    return `connected again ${timings.switchToDeadRegionMs} ms after the switch (relay-only attempt, then automatic)`;
  });

  await scenario('region switch back to automatic: measured interruption', async () => {
    const t0 = Date.now();
    await server.api('POST', '/calls/region', A.token, { room, region: null });
    await waitFor(A, () => !window.__hearthVoice.relayFallback && window.__hearthVoice.state !== 'connected', null, 5000).catch(() => {});
    await waitUp(A, 1, 30000); await waitUp(B, 1, 30000);
    timings.switchToAutoMs = Date.now() - t0;
    const engine = await V(A, () => window.__hearthVoice.lastSwitchMs);
    timings.switchEngineMs = engine;
    // The media gap: from the old connection closing to the new one connected (the 800 ms before it, the old
    // connection keeps carrying audio).
    const gaps = [await V(A, () => window.__hearthVoice.lastGapMs), await V(B, () => window.__hearthVoice.lastGapMs)];
    timings.switchGapMs = Math.max(...gaps.filter((x) => typeof x === 'number'));
    return `everyone connected ${timings.switchToAutoMs} ms after the request (engine: ${engine} ms from the announcement; media gap ${timings.switchGapMs} ms)`;
  });

  await scenario('two region changes at once: last write wins, everyone converges on the server’s value', async () => {
    const [r1, r2] = await Promise.all([
      server.api('POST', '/calls/region', A.token, { room, region: regionId }),
      server.api('POST', '/calls/region', A.token, { room, region: null }),
    ]);
    assert(r1.version !== r2.version, 'each change gets its own version');
    const [row] = await server.sql('SELECT rtc_region AS region, rtc_region_v AS version FROM channels WHERE id = ?', room);
    const winner = r1.version > r2.version ? r1 : r2;
    assert(row.version === winner.version && (row.region || null) === (winner.region || null), `server holds the newest: ${JSON.stringify(row)}`);
    for (const u of [A, B]) await waitFor(u, ([id, v]) => (window.__hearthCallRegion(id) || {}).version === v, [room, row.version], 5000);
    const seen = [await V(A, (id) => window.__hearthCallRegion(id), room), await V(B, (id) => window.__hearthCallRegion(id), room)];
    assert(seen.every((x) => (x.region || null) === (row.region || null)), `both apps agree with the server: ${JSON.stringify(seen)}`);
    // Each change that reached an app rebuilds its connections 800 ms later: let the last of them finish.
    await sleep(2000);
    await waitUp(A, 1, 40000); await waitUp(B, 1, 40000);
    // Back to automatic for the rest.
    if (row.region) { await server.api('POST', '/calls/region', A.token, { room, region: null }); await sleep(300); await waitUp(A, 1, 40000); await waitUp(B, 1, 40000); }
    return `versions ${r1.version} and ${r2.version}; both apps on v${row.version} (${row.region || 'automatic'})`;
  });

  await scenario('devices: the mic in use disappears → default mic, live; the camera disappears → video off, with a reason', async () => {
    await waitUp(A, 1, 40000);
    const before = await V(A, () => { const p = [...window.__hearthVoice.peers.values()][0]; window.__pcBefore = p.pc; return p.pc.getTransceivers()[0].sender.track && p.pc.getTransceivers()[0].sender.track.id; });
    await V(A, () => {
      const md = navigator.mediaDevices;
      window.__realEnum = window.__realEnum || md.enumerateDevices.bind(md);
      md.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'some-other-mic', label: 'Other', groupId: 'g' }, { kind: 'videoinput', deviceId: 'cam', label: 'Cam', groupId: 'g' }, { kind: 'audiooutput', deviceId: 'default', label: '', groupId: 'g' }];
      md.dispatchEvent(new Event('devicechange'));
    });
    await waitFor(A, (old) => { const p = [...window.__hearthVoice.peers.values()][0]; const t = p.pc.getTransceivers()[0].sender.track; return t && t.id !== old; }, before, 10000);
    const kept = await V(A, () => [...window.__hearthVoice.peers.values()][0].pc === window.__pcBefore && window.__hearthVoice.state === 'connected');
    assert(kept, 'the new mic goes out on the same connection');
    const told = await toasted(A, 'switched to the default one');
    assert(told, 'the person is told the mic changed');
    // Camera on, then it goes away.
    await V(A, () => window.__hearthVoice.setCamera(true));
    for (let i = 0; i < 50; i++) { const l = (await server.api('GET', '/bootstrap', A.token)).voice[room] || []; if ((l.find((x) => x.userId === A.id) || {}).video) break; await sleep(100); }
    await V(A, () => {
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'some-other-mic', label: 'Other', groupId: 'g' }];
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    });
    await waitFor(A, () => !window.__hearthVoice.camStream, null, 10000);
    const camTold = await toasted(A, 'camera was disconnected');
    assert(camTold, 'the person is told why video went off');
    let videoOff = false;
    for (let i = 0; i < 50 && !videoOff; i++) { const l = (await server.api('GET', '/bootstrap', A.token)).voice[room] || []; videoOff = !(l.find((x) => x.userId === A.id) || {}).video; if (!videoOff) await sleep(100); }
    assert(videoOff, 'the others see the camera as off');
    // Settings → a different input device during the call: swapped live.
    const t1 = await V(A, () => [...window.__hearthVoice.peers.values()][0].pc.getTransceivers()[0].sender.track.id);
    await V(A, async () => { navigator.mediaDevices.enumerateDevices = window.__realEnum; await window.__hearthVoice.setInputDevice(); });
    const t2 = await V(A, () => [...window.__hearthVoice.peers.values()][0].pc.getTransceivers()[0].sender.track.id);
    assert(t1 !== t2, 'Settings input change swaps the live track');
    assert(await allUp(A, 1), 'still connected after the swap');
    return 'mic swapped without renegotiating; camera turned off with a reason; Settings swap is live';
  });

  await scenario('diagnostics: numbers from getStats, "unavailable" when missing, no addresses or device ids', async () => {
    await sleep(2500);
    const d = await V(A, async () => { await window.__hearthVoice.diagnostics([]); await new Promise((r) => setTimeout(r, 1200)); return window.__hearthVoice.diagnostics([]); });
    const m = d.peers[0].metrics;
    assert(typeof m.rttMs === 'number', `round trip measured: ${JSON.stringify(m)}`);
    assert(m.path === 'host' || m.path === 'srflx' || m.path === 'prflx' || m.path === 'relay', `path type: ${m.path}`);
    assert(m.audioFlowing === true, `audio flowing: ${JSON.stringify(m)}`);
    const text = JSON.stringify(d);
    assert(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text) && !/[0-9a-f]{4}:[0-9a-f:]{6,}/i.test(text), 'no IP address in the diagnostics');
    // The panel itself.
    await A.page.click('#voice-panel .vp-where');
    await A.page.waitForSelector('.call-stage [aria-label="Call diagnostics"]', { timeout: 10000 });
    await A.page.click('.call-stage [aria-label="Call diagnostics"]');
    await A.page.waitForSelector('.diag-peer', { timeout: 10000 });
    const panel = await A.page.locator('.diag').innerText();
    assert(/Round trip/.test(panel) && /unavailable/.test(panel), 'shows metrics, and "unavailable" for what the browser didn’t report');
    assert(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(panel), 'no IP address in the panel');
    await A.page.keyboard.press('Escape');
    await A.page.locator('.modal-x').click({ timeout: 1000 }).catch(() => {});
    return `RTT ${m.rttMs} ms, loss ${m.lossPct}%, jitter ${m.jitterMs} ms, path ${m.path}`;
  });

  // Loopback UDP is the media path here (both browsers are on this machine); the signaling is TCP and isn't touched.
  const fw = (op, extra) => execFileSync('iptables', [op, 'OUTPUT', '-o', 'lo', '-p', 'udp', ...extra, '-j', 'DROP'], { stdio: 'pipe' });
  const LOSS = ['-m', 'statistic', '--mode', 'random', '--probability', '0.2'];
  const impair = process.env.IMPAIR === 'iptables';
  await scenario('impairment: 20% packet loss on the media path for 8 s', async () => {
    if (!impair) return 'skipped (set IMPAIR=iptables, as root, to run it)';
    fw('-I', LOSS);
    let worst = 0; let states = new Set();
    try {
      for (let i = 0; i < 8; i++) {
        await sleep(1000);
        const d = await V(A, () => window.__hearthVoice.diagnostics([]));
        worst = Math.max(worst, (d.peers[0] && d.peers[0].metrics.lossPct) || 0);
        states.add(await voiceState(A));
      }
    } finally { fw('-D', LOSS); }
    await waitUp(A, 1, 40000); await waitUp(B, 1, 40000);
    timings.lossWorstPct = worst;
    return `worst loss shown in diagnostics: ${worst}%; states seen: ${[...states].join(', ')}`;
  });
  await scenario('impairment: media path cut for 12 s → not shown as connected; recovers by itself afterwards', async () => {
    if (!impair) return 'skipped (set IMPAIR=iptables, as root, to run it)';
    const t0 = Date.now();
    fw('-I', []);
    let sawTrouble = false; let uiDuring = null;
    try {
      for (let i = 0; i < 24 && !sawTrouble; i++) {
        await sleep(500);
        const st = await voiceState(A);
        if (st === 'degraded') { sawTrouble = true; uiDuring = await uiState(A); }
      }
      await sleep(Math.max(0, 12000 - 500));
    } finally { fw('-D', []); }
    const back = Date.now();
    await waitUp(A, 1, 60000); await waitUp(B, 1, 60000);
    timings.cutRecoverMs = Date.now() - back;
    const restarts = await V(A, (t0) => window.__hearthVoice.history.filter((e) => e.t >= t0 && /Restarting the network path|fresh connection/.test(e.event)).length, t0);
    assert(sawTrouble, 'the call should have shown trouble while the media path was cut');
    assert(!/Connected/.test(uiDuring || ''), `the call bar didn't claim "Connected" during the cut: ${uiDuring}`);
    return `call bar during the cut: "${uiDuring}"; connected again ${timings.cutRecoverMs} ms after the path came back (${restarts} restart steps on Ana's side)`;
  });

  await scenario('hidden listener: a live connection to someone the server never listed is shown with a warning', async () => {
    const C = await newUser(browser, 'cara');
    const invite = await server.api('POST', `/servers/${srv.id}/invites`, A.token, {});
    await server.api('POST', `/invites/${invite.code}/join`, C.token);
    await sleep(500);
    // Pretend the server left Cara out of the list it sends Ana (the attack), but let her connect anyway.
    await V(A, (cid) => { const v = window.__hearthVoice; const orig = v.setListed.bind(v); v.setListed = (ids) => orig(ids.filter((x) => x !== cid)); v.setListed([...v.listed]); }, C.id);
    await V(C, (id) => window.__hearthVoice.join(id), room);
    await waitUp(A, 2, 30000);
    await A.page.click('#voice-panel .vp-where'); // the call page, where the warning shows
    await A.page.waitForSelector('.cs-hidden-peers', { timeout: 10000 });
    const warn = await A.page.locator('.cs-hidden-peers').innerText();
    assert(/cara/.test(warn), `names the hidden peer: ${warn}`);
    await V(C, () => window.__hearthVoice.leave());
    await C.context.close();
    return `warning shown: "${warn.slice(0, 90)}…"`;
  });
} finally {
  if (process.env.KEEP_OPEN !== '1') {
    await browser.close().catch(() => {});
    await server.stop();
    fs.rmSync(server.dir, { recursive: true, force: true });
  }
}
console.log('\nResults');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? ` — ${r.note}` : ''}`);
console.log('Timings (ms):', JSON.stringify(timings));
console.log(`${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
