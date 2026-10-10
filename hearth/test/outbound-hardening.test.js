// Outbound requests (server/netguard.js): feeds, trackers, news pictures and web push may only reach the public
// internet, can't be swapped to a private address by DNS rebinding, and can't hang or flood the server.
// Push subscriptions belong to the session that made them.
//
// Nothing here touches the internet: sites are local servers, and host names are answered by a fake resolver
// (in this process with setResolver; in the Hearth child through a small --require preload).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { startServer, hex, b64, sleep } = require('./helpers');
const netguard = require('../server/netguard');

const listen = (server, host = '127.0.0.1', port = 0) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
const closeAll = (server) => { try { server.closeAllConnections(); } catch { /* not http */ } return new Promise((r) => server.close(() => r())); };
const fake = (map) => { const calls = []; netguard.setResolver(async (host) => { calls.push(host); const a = map[host]; if (!a) throw new Error('not found'); return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); }); return calls; };
const codeOf = (p) => p.then(() => 'ok', (e) => e.code);
const rss = (title) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><item><title>${title} item</title><link>https://example.test/1</link><guid>1</guid></item></channel></rss>`;

// ================================================================== the guard itself (in this process)
test('netguard: every private, reserved or disguised address is refused; public ones are not', () => {
  const blocked = ['127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '240.0.0.1', '198.18.0.1', '192.0.2.1', '::1', '::', 'fe80::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    // IPv4 hidden inside IPv6: mapped (as the URL parser writes it, in hex), compatible, SIIT, NAT64, 6to4, Teredo
    '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::ffff:a00:1', '::7f00:1', '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1', '2002:7f00:1::1', '2002:a9fe:a9fe::', '2001::1', '2001:db8::1', '3fff::1', '100::1', 'fe80::1%eth0', '64:ff9b::808:808%eth0', 'localhost', '', 'not an ip'];
  for (const ip of blocked) assert.equal(netguard.blockedIp(ip), true, `${ip} must be refused`);
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '64:ff9b::808:808', '2002:808:808::1'])
    assert.equal(netguard.blockedIp(ip), false, `${ip} is public`);
});

test('netguard: odd ways of writing an address are judged by what they really are', async () => {
  const calls = fake({});
  for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/', 'http://[0:0:0:0:0:ffff:a00:1]/', 'http://[64:ff9b::169.254.169.254]/', 'http://[::127.0.0.1]/', 'http://%31%32%37.0.0.1/']) {
    assert.equal(await codeOf(netguard.checkPublicUrl(u)), 'PRIVATE', u);
  }
  assert.equal(calls.length, 0, 'address literals are never looked up');
  for (const u of ['file:///etc/passwd', 'gopher://x.test/', 'ftp://x.test/', 'javascript:alert(1)']) assert.equal(await codeOf(netguard.checkPublicUrl(u)), 'BAD_PROTOCOL', u);
  assert.equal(await codeOf(netguard.checkPublicUrl('http://x.test/', { protocols: ['https:'] })), 'BAD_PROTOCOL', 'https only');
  assert.equal(await codeOf(netguard.checkPublicUrl('http://user:pw@8.8.8.8/')), 'BAD_URL', 'no credentials in the address');
  assert.equal(await codeOf(netguard.checkPublicUrl('not a url')), 'BAD_URL');
  netguard.setResolver(null);
});

test('netguard: a host is refused if ANY of its addresses is private, however it is written', async () => {
  fake({ 'mixed.test': ['93.184.216.34', '10.0.0.5'], 'mapped.test': ['::ffff:169.254.169.254'], 'nat64.test': ['64:ff9b::a9fe:a9fe'], 'ok.test': ['93.184.216.34', '2606:4700::1'] });
  assert.equal(await codeOf(netguard.checkPublicUrl('http://mixed.test/')), 'PRIVATE');
  assert.equal(await codeOf(netguard.checkPublicUrl('http://mapped.test/')), 'PRIVATE');
  assert.equal(await codeOf(netguard.checkPublicUrl('http://nat64.test/')), 'PRIVATE');
  assert.equal(await codeOf(netguard.checkPublicUrl('http://nowhere.test/')), 'NOT_FOUND');
  assert.equal((await netguard.checkPublicUrl('https://ok.test/feed')).hostname, 'ok.test', 'public hosts pass');
  assert.equal(await codeOf(netguard.request('http://mixed.test/')), 'PRIVATE', 'and a request never connects');
  netguard.setResolver(null);
});

test('netguard: a slow DNS server only slows its own names; system lookups are capped at two, and nobody waits past their deadline', async () => {
  // Public names go to Node's DNS client, which has no shared limit for a slow name server to use up.
  const systemCalls = []; let active = 0; let most = 0;
  const err = (code) => Object.assign(new Error(code), { code });
  netguard.setResolver({
    dns: async (host) => {
      if (host.startsWith('slow')) { await sleep(2000); throw err('ETIMEOUT'); }
      if (host === 'broken.attacker.test') throw err('ESERVFAIL');
      if (host === 'fcm.googleapis.com') return [{ address: '142.250.72.10', family: 4 }];
      throw err('ENOTFOUND');
    },
    // The system lookup (on the thread pool) is only for local names and names DNS doesn't have.
    system: async (host) => {
      systemCalls.push(host); active++; most = Math.max(most, active);
      await sleep(600); active--;
      if (host === 'nas.lan') return [{ address: '93.184.216.34', family: 4 }];
      if (host === 'intranet.example.test') return [{ address: '10.0.0.9', family: 4 }];
      throw err('ENOTFOUND');
    },
  });
  try {
    const slow = [1, 2, 3, 4, 5, 6].map((i) => codeOf(netguard.checkPublicUrl(`http://slow${i}.attacker.test/`, { timeout: 1000 })));
    let t = Date.now();
    assert.equal((await netguard.checkPublicUrl('https://fcm.googleapis.com/x', { timeout: 1000 })).hostname, 'fcm.googleapis.com');
    assert.ok(Date.now() - t < 300, `a push service was looked up in ${Date.now() - t} ms while six slow lookups were in flight`);
    assert.deepEqual(await Promise.all(slow), Array(6).fill('TIMEOUT'));
    assert.equal(await codeOf(netguard.checkPublicUrl('http://broken.attacker.test/')), 'NOT_FOUND');
    assert.deepEqual(systemCalls, [], 'a slow or broken DNS answer never falls through to the system lookup');

    t = Date.now();
    const codes = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => codeOf(netguard.checkPublicUrl(`http://box${i}.lan/`, { timeout: 300 }))));
    assert.deepEqual(codes, Array(6).fill('TIMEOUT'));
    assert.ok(Date.now() - t < 1000, 'given up on at the deadline');
    assert.ok(most <= 2, `${most} system lookups ran at once`);
    await sleep(700); // the two that did start finish and free their places
    assert.equal((await netguard.checkPublicUrl('http://nas.lan/')).hostname, 'nas.lan', 'local names still work');
    assert.equal(await codeOf(netguard.checkPublicUrl('http://intranet.example.test/')), 'PRIVATE', 'a name DNS lacks is tried in /etc/hosts too, and still checked');
  } finally { netguard.setResolver(null); }
});

test('netguard: DNS rebinding — the connection goes to the address that was checked, not a fresh lookup', async () => {
  // Two "sites" on the same port: the checked address (127.0.0.2) and the one a second lookup would give (127.0.0.1).
  const hits = { pinned: 0, rebound: 0 };
  const pinned = http.createServer((req, res) => { hits.pinned++; res.end('pinned'); });
  const port = await listen(pinned, '127.0.0.2');
  const rebound = http.createServer((req, res) => { hits.rebound++; res.end('rebound'); });
  await listen(rebound, '127.0.0.1', port);
  let n = 0;
  netguard.setResolver(async () => { n++; return [{ address: n === 1 ? '127.0.0.2' : '127.0.0.1', family: 4 }]; });
  try {
    // Loopback stands in for "public" here (allowPrivate), so this checks only the pinning.
    const r = await netguard.request(`http://rebind.test:${port}/`, { allowPrivate: true });
    assert.equal(r.body.toString(), 'pinned');
    assert.equal(n, 1, 'looked up exactly once');
    assert.deepEqual(hits, { pinned: 1, rebound: 0 });
    // With the real check, the first answer decides: a public-then-private host never gets a connection at all.
    n = 0;
    netguard.setResolver(async () => { n++; return [{ address: n === 1 ? '10.9.8.7' : '127.0.0.1', family: 4 }]; });
    assert.equal(await codeOf(netguard.request(`http://rebind.test:${port}/`)), 'PRIVATE');
    assert.equal(hits.rebound, 0);
  } finally { netguard.setResolver(null); await closeAll(pinned); await closeAll(rebound); }
});

test('netguard: redirects are checked hop by hop and capped', async () => {
  const hits = { inner: 0, loop: 0 };
  const inner = http.createServer((req, res) => { hits.inner++; res.end('secret'); });
  const innerPort = await listen(inner);
  const outer = http.createServer((req, res) => {
    if (req.url === '/to-name') { res.writeHead(302, { location: `http://inner.test:${innerPort}/` }); return res.end(); }
    if (req.url === '/to-mapped') { res.writeHead(301, { location: `http://[::ffff:7f00:1]:${innerPort}/` }); return res.end(); }
    if (req.url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
    if (req.url.startsWith('/loop')) { hits.loop++; res.writeHead(307, { location: '/loop' }); return res.end(); }
    if (req.url === '/to-ok') { res.writeHead(302, { location: '/ok' }); return res.end(); }
    res.end('fine');
  });
  const outerPort = await listen(outer);
  fake({ 'outer.test': ['127.0.0.1'], 'inner.test': ['127.0.0.1'] });
  // Only outer.test may be private (it stands in for a public site); anything a redirect points at gets the real check.
  const opts = { allowPrivate: (u) => u.hostname === 'outer.test' };
  try {
    assert.equal((await netguard.request(`http://outer.test:${outerPort}/to-ok`, opts)).body.toString(), 'fine', 'ordinary redirects still work');
    assert.equal(await codeOf(netguard.request(`http://outer.test:${outerPort}/to-name`, opts)), 'PRIVATE');
    assert.equal(await codeOf(netguard.request(`http://outer.test:${outerPort}/to-mapped`, opts)), 'PRIVATE');
    assert.equal(await codeOf(netguard.request(`http://outer.test:${outerPort}/to-file`, opts)), 'BAD_PROTOCOL');
    assert.equal(hits.inner, 0, 'the private site was never reached');
    assert.equal(await codeOf(netguard.request(`http://outer.test:${outerPort}/loop`, { ...opts, maxRedirects: 3 })), 'REDIRECTS');
    assert.equal(hits.loop, 4, 'the first request plus 3 redirects, then it stops');
    const r = await netguard.request(`http://outer.test:${outerPort}/to-ok`, { ...opts, maxRedirects: 0 });
    assert.equal(r.status, 302, 'maxRedirects 0 hands the redirect back without following it');
  } finally { netguard.setResolver(null); await closeAll(inner); await closeAll(outer); }
});

test('netguard: one deadline for the whole request; answers are capped while they stream', async () => {
  const opened = new Set();
  const site = http.createServer((req, res) => {
    if (req.url === '/silent') return; // never answers
    if (req.url === '/trickle') { res.writeHead(200); const t = setInterval(() => res.write('x'), 100); res.on('close', () => clearInterval(t)); return; }
    if (req.url === '/endless') { res.writeHead(200); const c = Buffer.alloc(1 << 20, 65); const pump = () => { while (res.write(c)); }; res.on('drain', pump); res.on('error', () => {}); pump(); return; }
    if (req.url === '/bomb') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.alloc(64 << 20))); }
    if (req.url === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/rss+xml' }); return res.end(zlib.gzipSync(rss('Zipped'))); }
    if (req.url === '/big-declared') { res.writeHead(200, { 'content-length': String(50 << 20) }); return res.end(); }
    res.end('ok');
  });
  site.on('connection', (s) => { opened.add(s); s.on('close', () => opened.delete(s)); });
  const port = await listen(site);
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const o = { allowPrivate: true };
  try {
    let t = Date.now();
    assert.equal(await codeOf(netguard.request(url('/silent'), { ...o, timeout: 600 })), 'TIMEOUT');
    assert.ok(Date.now() - t < 2000, 'a site that never answers is given up on');
    t = Date.now();
    assert.equal(await codeOf(netguard.request(url('/trickle'), { ...o, timeout: 700 })), 'TIMEOUT');
    assert.ok(Date.now() - t < 2000, 'a byte every 100 ms does not keep it alive');
    assert.equal(await codeOf(netguard.request(url('/endless'), { ...o, maxBytes: 2 << 20 })), 'TOO_BIG');
    const cut = await netguard.request(url('/endless'), { ...o, maxBytes: 100000, truncate: true });
    assert.equal(cut.body.length, 100000); assert.equal(cut.truncated, true);
    assert.equal(await codeOf(netguard.request(url('/bomb'), { ...o, maxBytes: 1 << 20 })), 'TOO_BIG', 'the cap counts unpacked bytes');
    assert.equal(await codeOf(netguard.request(url('/big-declared'), { ...o, maxBytes: 1 << 20 })), 'TOO_BIG', 'a declared size over the cap stops at once');
    assert.match((await netguard.request(url('/gz'), o)).body.toString(), /Zipped item/, 'compressed feeds still read fine');
    const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
    assert.equal(await codeOf(netguard.request(url('/silent'), { ...o, signal: ac.signal })), 'ABORTED');
    for (let i = 0; i < 20 && opened.size; i++) await sleep(50);
    assert.equal(opened.size, 0, 'no connection is left open');
  } finally { await closeAll(site); }
});

test('netguard: a refused compressed answer stops unpacking at once, so no CPU is left burning on it', async () => {
  // About a kilobyte of brotli that unpacks to 1 GiB of zeros (seconds of CPU to unpack in full).
  const bomb = await new Promise((resolve) => {
    const z = zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } });
    const out = []; z.on('data', (c) => out.push(c)); z.on('end', () => resolve(Buffer.concat(out)));
    const zeros = Buffer.alloc(16 << 20); let left = 64;
    const pump = () => { while (left > 0) { left--; if (!z.write(zeros)) return z.once('drain', pump); } z.end(); };
    pump();
  });
  assert.ok(bomb.length < 4096, `${bomb.length} bytes`);
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-encoding': 'br', 'content-type': 'image/png' }); res.end(bomb); });
  const port = await listen(site);
  try {
    assert.equal(await codeOf(netguard.request(`http://127.0.0.1:${port}/bomb.png`, { allowPrivate: true, maxBytes: 1 << 20 })), 'TOO_BIG');
    const before = process.cpuUsage();
    await sleep(1500);
    const used = process.cpuUsage(before);
    const ms = Math.round((used.user + used.system) / 1000);
    assert.ok(ms < 300, `${ms} ms of CPU went on it after it was refused`);
  } finally { await closeAll(site); }
});

test('netguard: misconfigured but readable answers read the way fetch() reads them; real garbage does not', async () => {
  const text = rss('Lenient');
  const gz = zlib.gzipSync(text);
  const site = http.createServer((req, res) => {
    const send = (encoding, body) => { res.writeHead(200, { 'content-type': 'application/rss+xml', 'content-encoding': encoding }); res.end(body); };
    if (req.url === '/utf8') return send('UTF-8', text); // a charset where the encoding goes
    if (req.url === '/none') return send('none', text);
    if (req.url === '/raw-deflate') return send('deflate', zlib.deflateRawSync(text)); // no zlib header
    if (req.url === '/deflate') return send('deflate', zlib.deflateSync(text));
    if (req.url === '/no-trailer') return send('gzip', gz.subarray(0, gz.length - 8)); // cut before its checksum
    if (req.url === '/two') return send('deflate, gzip', zlib.gzipSync(zlib.deflateSync(text)));
    if (req.url === '/br') return send('br', zlib.brotliCompressSync(text));
    return send('gzip', Buffer.from('this was never gzip, whatever the header says'));
  });
  const port = await listen(site);
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    for (const p of ['/utf8', '/none', '/raw-deflate', '/deflate', '/no-trailer', '/two', '/br']) {
      assert.equal((await netguard.request(url(p), { allowPrivate: true })).body.toString(), text, p);
      assert.equal(await (await fetch(url(p))).text(), text, `${p} (fetch reads it the same)`);
    }
    assert.equal(await codeOf(netguard.request(url('/garbage'), { allowPrivate: true })), 'BAD_ENCODING');
  } finally { await closeAll(site); }
});

test("netguard: this server's own addresses are refused even when public (web ports aside), and so is OUTBOUND_BLOCK", async () => {
  // Pretend this machine has a public address on an interface, as a VPS does.
  const real = os.networkInterfaces;
  os.networkInterfaces = () => ({ ...real(), eth9: [{ address: '93.184.216.99', family: 'IPv4' }, { address: '2606:4700:10::99', family: 'IPv6' }] });
  process.env.OUTBOUND_BLOCK = '8.8.4.0/24, 2001:4860:4860::8844, nonsense';
  netguard.refreshOwnAddresses();
  fake({ 'self.test': ['93.184.216.99'], 'self6.test': ['2606:4700:10::99'], 'router.test': ['8.8.4.4'], 'fine.test': ['8.8.8.8'] });
  try {
    // A request to it would come back in on the loopback interface, past the firewall, to whatever listens there.
    for (const u of ['http://93.184.216.99:5432/', 'http://self.test:8080/feed', 'https://self6.test:8443/x', 'http://[2606:4700:10::99]:22/', 'http://self.test:6379/']) {
      assert.equal(await codeOf(netguard.checkPublicUrl(u)), 'PRIVATE', u);
    }
    assert.equal(await codeOf(netguard.request('http://self.test:6379/')), 'PRIVATE', 'and a request never connects');
    // The ordinary web ports serve the public anyway (a blog with a feed next to Hearth keeps working).
    for (const u of ['http://93.184.216.99/', 'https://self.test/feed', 'http://self.test:80/', 'https://[2606:4700:10::99]/']) assert.equal(await codeOf(netguard.checkPublicUrl(u)), 'ok', u);
    // Addresses the admin listed are refused on every port.
    for (const u of ['http://8.8.4.4/', 'https://router.test/', 'http://[2001:4860:4860::8844]/']) assert.equal(await codeOf(netguard.checkPublicUrl(u)), 'PRIVATE', u);
    for (const u of ['http://8.8.8.8:8080/', 'https://fine.test/']) assert.equal(await codeOf(netguard.checkPublicUrl(u)), 'ok', u);
  } finally {
    os.networkInterfaces = real; delete process.env.OUTBOUND_BLOCK;
    netguard.refreshOwnAddresses(); netguard.setResolver(null);
  }
});

// ================================================================== through a real Hearth server
// A fake resolver for the Hearth child: FAKE_DNS maps host → addresses (or a list of answers, one per lookup);
// every lookup is logged to FAKE_DNS_LOG.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-outbound-'));
const PRELOAD = path.join(work, 'fake-dns.js');
fs.writeFileSync(PRELOAD, `
const fs = require('fs');
const ng = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'netguard.js'))});
const map = JSON.parse(process.env.FAKE_DNS || '{}');
const seen = {};
ng.setResolver(async (host) => {
  const h = host.toLowerCase();
  if (process.env.FAKE_DNS_LOG) fs.appendFileSync(process.env.FAKE_DNS_LOG, h + '\\n');
  const entry = map[h];
  if (!entry) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  seen[h] = (seen[h] || 0) + 1;
  const answer = Array.isArray(entry[0]) ? entry[Math.min(seen[h], entry.length) - 1] : entry;
  return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
});
`);
const DNS_LOG = path.join(work, 'dns.log');
const lookups = (host) => (fs.existsSync(DNS_LOG) ? fs.readFileSync(DNS_LOG, 'utf8').split('\n').filter((h) => h === host).length : 0);

let strict; let loose; // loose: private push endpoints and feeds allowed, so local stand-ins can be reached
let feedHits = 0; let feedSrv; let feedPort; let pinnedSrv; let reboundSrv; let pinPort; const pinHits = { pinned: 0, rebound: 0 };
let tls; let pushSrv; let pushPort; const pushHits = [];
let artSrv; let artPort; let artOpen = 0; const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(200)]);
const as = (s, u, method, p, body, token = u.token) => s.api(method, p, { token, ip: u.ip, body });
const pushSub = (endpoint) => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { endpoint, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }; };
const subRows = (s, uid) => s.sql('SELECT * FROM push_subs WHERE user_id = ?', uid);
const sessionsOf = async (s, u, token = u.token) => (await as(s, u, 'GET', '/me/sessions', undefined, token)).json.active;
// A DM channel from `from` to `to` (as friends), and a function that sends one message in it.
async function dmLine(s, from, to) {
  assert.equal((await as(s, from, 'POST', '/friends', { username: to.username })).status, 200);
  assert.equal((await as(s, to, 'POST', `/friends/${from.id}/accept`)).status, 200);
  const dm = (await as(s, from, 'POST', '/dms', { userId: to.id })).json;
  return async () => { const r = await as(s, from, 'POST', `/dms/${dm.id}/messages`, { ciphertext: 'v2:' + b64(60) }); assert.equal(r.status, 200, r.text); return r; };
}
const waitFor = async (fn, ms = 5000) => { for (let i = 0; i < ms / 50; i++) { if (await fn()) return true; await sleep(50); } return false; };

before(async () => {
  feedSrv = http.createServer((req, res) => { feedHits++; res.setHeader('Content-Type', 'application/rss+xml'); res.end(rss('Inside')); });
  feedPort = await listen(feedSrv);
  pinnedSrv = http.createServer((req, res) => { pinHits.pinned++; res.setHeader('Content-Type', 'application/rss+xml'); res.end(rss('Pinned')); });
  pinPort = await listen(pinnedSrv, '127.0.0.2');
  reboundSrv = http.createServer((req, res) => { pinHits.rebound++; res.setHeader('Content-Type', 'application/rss+xml'); res.end(rss('Rebound')); });
  await listen(reboundSrv, '127.0.0.1', pinPort);
  // A local "push service" with its own certificate, trusted by the loose server only.
  const selfsigned = require('selfsigned');
  tls = await selfsigned.generate([{ name: 'commonName', value: 'push.local' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }] });
  fs.writeFileSync(path.join(work, 'push-ca.pem'), tls.cert);
  pushSrv = https.createServer({ key: tls.private, cert: tls.cert }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { pushHits.push({ url: req.url, method: req.method, headers: req.headers, len: Buffer.concat(chunks).length }); res.writeHead(req.url.startsWith('/gone') ? 410 : 201); res.end(); });
  });
  pushPort = await listen(pushSrv);
  // A picture host an admin listed in ART_PROXY_EXTRA_HOSTS (on the local network, which that allows).
  artSrv = http.createServer((req, res) => {
    if (req.url === '/cover.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    if (req.url === '/away.png') { res.writeHead(302, { location: `http://127.0.0.2:${pinPort}/x.png` }); return res.end(); }
    if (req.url === '/huge.png') {
      artOpen++; res.writeHead(200, { 'content-type': 'image/png' });
      const c = Buffer.alloc(1 << 20); const pump = () => { while (!res.destroyed && res.write(c)); };
      res.on('drain', pump); res.on('error', () => {}); res.on('close', () => { artOpen--; }); pump(); return;
    }
    res.writeHead(404); res.end();
  });
  artPort = await listen(artSrv);
  const FAKE_DNS = JSON.stringify({
    localhost: ['127.0.0.1', '::1'], 'fcm.googleapis.com': ['142.250.72.10'], 'push.services.mozilla.test': ['2620:149:a44::10'],
    'intranet.corp.test': ['10.0.0.7'], 'mixed.corp.test': ['93.184.216.34', '192.168.1.10'], 'meta.test': ['::ffff:169.254.169.254'],
    // One answer per lookup: the check when the tracker is previewed, the request itself, then (if anything
    // looked it up again) loopback.
    'rebind.test': ['127.0.0.1'], 'feed.pinned.test': [['127.0.0.2'], ['127.0.0.2'], ['127.0.0.1']], 'img.steamstatic.com': ['127.0.0.1'],
    'push.again.test': ['142.250.72.11'], 'router.corp.test': ['203.0.114.9'],
  });
  // OUTBOUND_BLOCK: addresses an admin refuses outright (like the server's own public address behind NAT).
  const common = { NODE_OPTIONS: `--require ${PRELOAD}`, FAKE_DNS, FAKE_DNS_LOG: DNS_LOG, OUTBOUND_BLOCK: '203.0.114.0/24' };
  strict = await startServer(common);
  loose = await startServer({ ...common, FEED_ALLOW_PRIVATE: '1', PUSH_ALLOW_PRIVATE: '1', NODE_EXTRA_CA_CERTS: path.join(work, 'push-ca.pem'), ART_PROXY_EXTRA_HOSTS: `127.0.0.1:${artPort}` });
});
after(async () => {
  await strict.stop(); await loose.stop();
  await closeAll(feedSrv); await closeAll(pinnedSrv); await closeAll(reboundSrv); await closeAll(pushSrv); await closeAll(artSrv);
  fs.rmSync(work, { recursive: true, force: true });
});

// ------------------------------------------------------------------ feeds and trackers (ssrf-1, ssrf-2)
test('trackers and feeds: disguised and DNS-hidden private addresses are refused before any connection', async () => {
  const u = await strict.register();
  const sneaky = [`http://[::ffff:127.0.0.1]:${feedPort}/feed.xml`, `http://[::ffff:7f00:1]:${feedPort}/feed.xml`, 'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    `http://[64:ff9b::7f00:1]:${feedPort}/feed.xml`, `http://[::127.0.0.1]:${feedPort}/feed.xml`, `http://2130706433:${feedPort}/feed.xml`, `http://0x7f.1:${feedPort}/feed.xml`,
    `http://rebind.test:${feedPort}/feed.xml`, 'http://mixed.corp.test/feed.xml', 'http://meta.test/latest/meta-data/'];
  for (const q of sneaky) {
    const r = await as(strict, u, 'POST', '/me/trackers', { kind: 'rss', query: q });
    assert.equal(r.status, 400, `${q} → ${r.status} ${r.text}`);
    assert.match(r.json.error, /private network/, q);
    const p = await as(strict, u, 'POST', '/me/trackers/preview', { kind: 'rss', query: q });
    assert.equal(p.status, 400, `preview ${q} → ${p.status}`);
  }
  // Server feeds (Manage Server) go through the same guard.
  const s = (await as(strict, u, 'POST', '/servers', { name: 'News ' + hex(3) })).json;
  const ch = s.channels.find((c) => c.type === 'text');
  for (const q of [`http://[::ffff:7f00:1]:${feedPort}/feed.xml`, `http://rebind.test:${feedPort}/feed.xml`]) {
    assert.equal((await as(strict, u, 'POST', `/servers/${s.id}/feeds`, { kind: 'rss', query: q, channelId: ch.id })).status, 400, q);
    assert.equal((await as(strict, u, 'POST', `/servers/${s.id}/feeds/preview`, { kind: 'rss', query: q })).status, 400, q);
  }
  // Addresses listed in OUTBOUND_BLOCK, by number or by name.
  for (const q of ['http://203.0.114.9/feed.xml', 'http://router.corp.test/feed.xml']) {
    const r = await as(strict, u, 'POST', '/me/trackers', { kind: 'rss', query: q });
    assert.equal(r.status, 400, `${q} → ${r.status} ${r.text}`);
    assert.match(r.json.error, /blocked on this server/, q);
  }
  // The news picture proxy too.
  const t = (await as(strict, u, 'GET', '/bootstrap')).json.mediaToken;
  for (const q of [`http://[::ffff:7f00:1]:${feedPort}/a.png`, `http://rebind.test:${feedPort}/a.png`]) {
    const r = await strict.call('GET', `/media/news?u=${encodeURIComponent(q)}&t=${encodeURIComponent(t)}`);
    assert.equal(r.status, 404, q);
  }
  assert.equal(feedHits, 0, 'the private site never got a request');
});

test('trackers: the feed is fetched from the address that was looked up, once (no rebinding)', async () => {
  // FEED_ALLOW_PRIVATE lets this server reach local stand-ins; the lookup is still made once and pinned.
  const u = await loose.register();
  const before = lookups('feed.pinned.test');
  const r = await as(loose, u, 'POST', '/me/trackers/preview', { kind: 'rss', query: `http://feed.pinned.test:${pinPort}/feed.xml` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.title, 'Pinned');
  assert.equal(lookups('feed.pinned.test') - before, 2, 'looked up for the up-front check and for the request, never again on connect');
  assert.deepEqual(pinHits, { pinned: 1, rebound: 0 }, 'the second DNS answer (127.0.0.1) was never used');
  // Ordinary feeds keep working.
  const add = await as(loose, u, 'POST', '/me/trackers', { kind: 'rss', query: `http://127.0.0.1:${feedPort}/feed.xml` });
  assert.equal(add.status, 200, add.text);
});

// ------------------------------------------------------------------ music and game pictures (activity.js)
test('picture proxy: allowed hosts still work through the guard; private answers, stray redirects and huge files do not', async () => {
  // An allow-listed name whose DNS points inside the network: refused before connecting.
  const conns = []; const watch = (s) => conns.push(s.remoteAddress);
  pushSrv.on('connection', watch);
  try {
    const u = await strict.register();
    const t = (await as(strict, u, 'GET', '/bootstrap')).json.mediaToken;
    const r = await strict.call('GET', `/media/art?u=${encodeURIComponent(`https://img.steamstatic.com:${pushPort}/x.png`)}&t=${encodeURIComponent(t)}`);
    assert.equal(r.status, 404);
    assert.equal(conns.length, 0, 'no connection was made');
  } finally { pushSrv.off('connection', watch); }

  const u = await loose.register();
  const t = encodeURIComponent((await as(loose, u, 'GET', '/bootstrap')).json.mediaToken);
  const art = (p) => fetch(`${loose.base}/media/art?u=${encodeURIComponent(`http://127.0.0.1:${artPort}${p}`)}&t=${t}`);
  const ok = await art('/cover.png');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await ok.arrayBuffer()).equals(PNG), 'the picture comes through intact');
  const hits = pinHits.pinned;
  assert.equal((await art('/away.png')).status, 404, 'a redirect off the allowed hosts is not followed');
  assert.equal(pinHits.pinned, hits);
  const t0 = Date.now();
  assert.equal((await art('/huge.png')).status, 404, 'over the size cap');
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(await waitFor(() => artOpen === 0, 3000), 'the download was cut off');
});

// ------------------------------------------------------------------ push endpoints (platform-2, ssrf-5)
test('push: subscribing refuses anything but a public https push service', async () => {
  const bad = ['http://fcm.googleapis.com/fcm/send/x', 'https://127.0.0.1:1/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5:8443/admin',
    'https://[::ffff:7f00:1]/x', 'https://[::ffff:169.254.169.254]/x', `https://localhost:${pushPort}/x`, 'https://2130706433/x', 'https://[fd00::1]/x',
    'https://intranet.corp.test/push', 'https://mixed.corp.test/push', 'https://meta.test/x', 'https://user:pw@fcm.googleapis.com/x', 'javascript:alert(1)', 'https://nowhere.test/x', 'x'.repeat(1001)];
  let u;
  for (const [i, endpoint] of bad.entries()) {
    if (i % 8 === 0) u = await strict.register(); // failed tries count toward the subscribe limit too
    const r = await as(strict, u, 'POST', '/push/subscribe', { subscription: pushSub(endpoint) });
    assert.equal(r.status, 400, `${endpoint} → ${r.status} ${r.text}`);
  }
  assert.equal(strict.sql('SELECT COUNT(*) n FROM push_subs')[0].n, 0, 'nothing was stored');
  // Real push services are fine, and the subscription remembers the session that made it.
  const ok = await strict.register();
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/ok-' + hex(8), 'https://push.services.mozilla.test/wpush/v2/' + hex(8)]) {
    const r = await as(strict, ok, 'POST', '/push/subscribe', { subscription: pushSub(endpoint) });
    assert.equal(r.status, 200, `${endpoint} → ${r.text}`);
  }
  const sid = (await sessionsOf(strict, ok)).find((x) => x.current).id;
  assert.deepEqual(subRows(strict, ok.id).map((x) => x.session_id), [sid, sid]);
});

test('push: a stored endpoint that now points inside the network is never contacted, and is dropped', async () => {
  // Rows like these could be saved before the subscribe check existed, or a host's DNS could change later.
  const conns = [];
  const watch = (s) => conns.push(s.remoteAddress);
  pushSrv.on('connection', watch);
  try {
    const v = await strict.register(); const friend = await strict.register();
    const send = await dmLine(strict, friend, v);
    const keys = JSON.stringify(pushSub('x').keys);
    for (const endpoint of [`https://127.0.0.1:${pushPort}/direct`, `https://rebind.test:${pushPort}/dns`, `https://[::ffff:7f00:1]:${pushPort}/mapped`]) {
      strict.sql('INSERT INTO push_subs (endpoint, user_id, keys, ua, created_at) VALUES (?, ?, ?, ?, ?)', endpoint, v.id, keys, 'test', Date.now());
    }
    const before = pushHits.length;
    await send();
    assert.ok(await waitFor(() => subRows(strict, v.id).length === 0), 'the rows are dropped');
    assert.equal(conns.length, 0, 'not even a TCP connection reached the private address');
    assert.equal(pushHits.length, before);
  } finally { pushSrv.off('connection', watch); }
});

test('push: a hostile endpoint streaming an endless answer cannot take the server down', async () => {
  let sent = 0; let closedAt = 0; let openedAt = 0;
  const flood = https.createServer({ key: tls.private, cert: tls.cert }, (req, res) => {
    req.resume(); openedAt = Date.now();
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.on('error', () => {}); res.on('close', () => { closedAt = Date.now(); });
    const chunk = Buffer.alloc(1 << 20, 0x41);
    const pump = () => { while (!res.destroyed) { sent++; if (!res.write(chunk)) break; } };
    res.on('drain', pump); pump();
  });
  const port = await listen(flood);
  try {
    const v = await loose.register(); const friend = await loose.register();
    const send = await dmLine(loose, friend, v);
    assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${port}/flood`) })).status, 200);
    await send();
    assert.ok(await waitFor(() => closedAt > 0, 8000), 'Hearth hung up on the flood');
    assert.ok(closedAt - openedAt < 3000, `it hung up after ${closedAt - openedAt} ms`);
    assert.ok(sent < 64, `only ${sent} MiB were ever handed to the socket`);
    await sleep(500);
    assert.equal(loose.child.exitCode, null, 'Hearth is still running');
    assert.equal((await loose.api('GET', '/config')).status, 200);
  } finally { await closeAll(flood); }
});

test('push: per-account cap, a subscribe limit, and sending off the request path a few at a time', async () => {
  // A new endpoint counts toward the limit; the app turning push on again for a known one doesn't.
  const y = await loose.register();
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await as(loose, y, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${pushPort}/y${i}`) })).status);
  assert.deepEqual(statuses, [...Array(10).fill(200), 429, 429]);
  assert.equal(subRows(loose, y.id).length, 10);
  assert.equal((await as(loose, y, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${pushPort}/y0`) })).status, 200, 'known endpoints are fine');

  // Old rows past the cap are trimmed to the newest 10 on the next subscribe.
  const z = await loose.register();
  const zs = (await sessionsOf(loose, z)).find((x) => x.current).id;
  const keys = JSON.stringify(pushSub('x').keys);
  for (let i = 0; i < 25; i++) loose.sql('INSERT INTO push_subs (endpoint, user_id, keys, ua, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?)', `https://127.0.0.1:${pushPort}/old${i}`, z.id, keys, 't', Date.now() - 100000 + i, zs);
  assert.equal((await as(loose, z, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${pushPort}/newest`) })).status, 200);
  const left = subRows(loose, z.id).map((x) => x.endpoint);
  assert.equal(left.length, 10);
  assert.ok(left.includes(`https://127.0.0.1:${pushPort}/newest`));
  assert.ok(!left.includes(`https://127.0.0.1:${pushPort}/old0`), 'the oldest went');

  // A push service that never answers: the message is sent at once, the server stays quick, and only a few
  // sends are ever in flight.
  let open = 0; let most = 0; const socks = new Set();
  const hang = https.createServer({ key: tls.private, cert: tls.cert }, (req, res) => { req.resume(); open++; most = Math.max(most, open); res.on('close', () => { open--; }); }); // open until the connection goes
  hang.on('secureConnection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); });
  const hangPort = await listen(hang);
  try {
    const w = await loose.register(); const friend = await loose.register();
    const send = await dmLine(loose, friend, w);
    for (let i = 0; i < 10; i++) assert.equal((await as(loose, w, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${hangPort}/h${i}`) })).status, 200);
    let t = Date.now();
    await send();
    assert.ok(Date.now() - t < 1500, `the message went out in ${Date.now() - t} ms`);
    await waitFor(() => open >= 2, 3000);
    t = Date.now();
    assert.equal((await loose.api('GET', '/config')).status, 200);
    assert.ok(Date.now() - t < 1000, 'other requests are not held up');
    await sleep(500);
    assert.equal(most, 2, `${most} sends to one account's devices were in flight at once`);
  } finally { socks.forEach((s) => s.destroy()); await closeAll(hang); }
});

// ------------------------------------------------------------------ push follows the session (auth-7)
test('push: delivery works, and stops for a device once its session is revoked, changed out or logged out', async () => {
  const v = await loose.register(); const friend = await loose.register();
  const send = await dmLine(loose, friend, v);
  const hitsFor = (p) => pushHits.filter((h) => h.url === p).length;

  // Device B turns push on; a DM while v is offline reaches it, in the standard Web Push format. (A host name,
  // so this goes through the pinned lookup and a certificate checked against that name.)
  const tokB = (await loose.login(v)).json.token;
  assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(`https://localhost:${pushPort}/devB`) }, tokB)).status, 200);
  await send();
  assert.ok(await waitFor(() => hitsFor('/devB') === 1), 'control: delivered');
  const h = pushHits.find((x) => x.url === '/devB');
  assert.equal(h.method, 'POST');
  assert.equal(h.headers['content-encoding'], 'aes128gcm');
  assert.match(h.headers.authorization, /^vapid t=/);
  assert.equal(h.headers.ttl, '21600');
  assert.ok(h.len > 0);

  // 1) B is revoked from Settings → Sessions.
  const sessB = (await sessionsOf(loose, v)).find((x) => !x.current);
  assert.equal((await as(loose, v, 'DELETE', `/me/sessions/${sessB.id}`)).status, 200);
  assert.equal(subRows(loose, v.id).length, 0, 'its subscription is gone');
  await send(); await sleep(600);
  assert.equal(hitsFor('/devB'), 1, 'nothing more reaches B');

  // 2) Device C, then a password change on the main session signs C out.
  const tokC = (await loose.login(v)).json.token;
  assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${pushPort}/devC`) }, tokC)).status, 200);
  const newKey = hex(32);
  assert.equal((await as(loose, v, 'POST', '/me/password', { oldAuthKey: v.authKey, newAuthKey: newKey, encPrivateKey: b64(60), salt: b64(16) })).status, 200);
  v.authKey = newKey;
  assert.equal(subRows(loose, v.id).length, 0);
  await send(); await sleep(600);
  assert.equal(hitsFor('/devC'), 0);

  // 3) The main session itself turns push on, then logs out.
  assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${pushPort}/devA`) })).status, 200);
  assert.equal((await as(loose, v, 'POST', '/auth/logout')).status, 200);
  assert.equal(subRows(loose, v.id).length, 0);
  await send(); await sleep(600);
  assert.equal(hitsFor('/devA'), 0);

  // A push service saying "gone" (410) removes the subscription, as before.
  const g = await loose.register(); const gf = await loose.register();
  const sendG = await dmLine(loose, gf, g);
  assert.equal((await as(loose, g, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${pushPort}/gone-${hex(4)}`) })).status, 200);
  await sendG();
  assert.ok(await waitFor(() => subRows(loose, g.id).length === 0));
});

test('push: expired sessions, suspended accounts and pre-upgrade subscriptions', async () => {
  const hitsFor = (p) => pushHits.filter((h) => h.url === p).length;
  // An expired session's device gets nothing (and the row is cleaned up).
  const x = await loose.register(); const xf = await loose.register();
  const sendX = await dmLine(loose, xf, x);
  const tokX2 = (await loose.login(x)).json.token;
  assert.equal((await as(loose, x, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${pushPort}/expired`) }, tokX2)).status, 200);
  const sid = subRows(loose, x.id)[0].session_id;
  loose.sql('UPDATE sessions SET expires_at = ? WHERE id = ?', Date.now() - 1000, sid);
  await sendX();
  assert.ok(await waitFor(() => subRows(loose, x.id).length === 0), 'dropped');
  assert.equal(hitsFor('/expired'), 0);

  // A suspended account gets no pushes, even from a subscription that somehow outlived its sessions.
  const s = await loose.register(); const sf = await loose.register();
  const sendS = await dmLine(loose, sf, s);
  assert.equal((await as(loose, s, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${pushPort}/suspended`) })).status, 200);
  loose.sql('UPDATE users SET suspended_at = ? WHERE id = ?', Date.now(), s.id);
  await sendS(); await sleep(600);
  assert.equal(hitsFor('/suspended'), 0, 'skipped while suspended');
  loose.sql('UPDATE users SET suspended_at = NULL WHERE id = ?', s.id);
  // Staff suspending someone removes their subscriptions outright.
  const r = await as(loose, loose.owner, 'POST', `/admin/users/${s.id}/suspend`, { hours: 1, reason: 'test' });
  assert.equal(r.status, 200, r.text);
  assert.equal(subRows(loose, s.id).length, 0);

  // Subscriptions saved before this change have no session: they still work while the account has a live
  // session, and are dropped as soon as one of its sessions is signed out.
  const o = await loose.register(); const of = await loose.register();
  const sendO = await dmLine(loose, of, o);
  loose.sql('INSERT INTO push_subs (endpoint, user_id, keys, ua, created_at) VALUES (?, ?, ?, ?, ?)', `https://127.0.0.1:${pushPort}/legacy`, o.id, JSON.stringify(pushSub('x').keys), 't', Date.now());
  await sendO();
  assert.ok(await waitFor(() => hitsFor('/legacy') === 1), 'still delivered');
  const tok2 = (await loose.login(o)).json.token;
  assert.equal((await as(loose, o, 'POST', '/auth/logout', undefined, tok2)).status, 200);
  assert.equal(subRows(loose, o.id).length, 0);
});

// ------------------------------------------------------------------ fair sending (one account can't stall push for everyone)
// A push service that takes the connection and never answers. Requests in flight are counted per path prefix
// (the part before the first '-'), so a test can tell accounts apart.
async function deadPushService() {
  const svc = { open: new Map(), most: new Map(), total: 0, mostTotal: 0, socks: new Set() };
  svc.server = https.createServer({ key: tls.private, cert: tls.cert }, (req, res) => {
    const who = req.url.split('-')[0];
    req.resume();
    svc.open.set(who, (svc.open.get(who) || 0) + 1); svc.most.set(who, Math.max(svc.most.get(who) || 0, svc.open.get(who)));
    svc.total++; svc.mostTotal = Math.max(svc.mostTotal, svc.total);
    res.on('close', () => { svc.open.set(who, svc.open.get(who) - 1); svc.total--; }); // the connection went (never answered)
  });
  svc.server.on('secureConnection', (s) => { svc.socks.add(s); s.on('close', () => svc.socks.delete(s)); });
  svc.port = await listen(svc.server);
  svc.close = async () => { svc.socks.forEach((s) => s.destroy()); await closeAll(svc.server); };
  return svc;
}
const hitsAt = (p) => pushHits.filter((h) => h.url === p).length;

test("push: accounts whose push services never answer can't hold up anyone else's notifications", async () => {
  const dead = await deadPushService();
  try {
    // Five accounts, each with three "devices" on a push service that hangs, and each flooded with messages.
    const floods = [];
    for (let k = 0; k < 5; k++) {
      const w = await loose.register(); const wf = await loose.register();
      for (let i = 0; i < 3; i++) assert.equal((await as(loose, w, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${dead.port}/w${k}-${i}`) })).status, 200);
      floods.push(await dmLine(loose, wf, w));
    }
    for (let round = 0; round < 4; round++) for (const send of floods) await send();
    await waitFor(() => dead.total >= 8, 3000);
    // Someone else's message still gets its notification right away.
    const v = await loose.register(); const vf = await loose.register();
    const sendV = await dmLine(loose, vf, v);
    const mine = `/fair-${hex(4)}`;
    assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(`https://localhost:${pushPort}${mine}`) })).status, 200);
    const t = Date.now();
    await sendV();
    assert.ok(await waitFor(() => hitsAt(mine) === 1, 5000), 'delivered');
    assert.ok(Date.now() - t < 1500, `delivered after ${Date.now() - t} ms`);
    await sleep(300);
    for (const [who, n] of dead.most) assert.ok(n <= 2, `${n} sends to ${who}'s devices at once`);
    assert.ok(dead.mostTotal <= 8, `${dead.mostTotal} sends to one push service at once`);
  } finally { await dead.close(); }
});

test('push: a push service that keeps failing sits out longer each time, then is dropped; one that answers starts over', async () => {
  let conns = 0;
  const flaky = net.createServer((s) => { conns++; s.destroy(); }); // takes the connection and hangs up at once
  const port = await listen(flaky);
  try {
    const v = await loose.register(); const vf = await loose.register();
    const send = await dmLine(loose, vf, v);
    const ep = `https://127.0.0.1:${port}/flaky`;
    const row = () => subRows(loose, v.id)[0];
    assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(ep) })).status, 200);
    await send();
    assert.ok(await waitFor(() => row() && row().fails === 1), 'one failure counted');
    assert.ok(row().retry_at > Date.now() + 50000, 'it sits out about a minute');
    const tried = conns;
    await send(); await sleep(600);
    assert.equal(conns, tried, 'not tried again while it sits out');
    assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(ep) })).status, 200);
    assert.equal(row().fails, 1, "subscribing again doesn't wipe the count");
    // The 8th failure in a row (pretending the waits have passed) drops it.
    loose.sql('UPDATE push_subs SET fails = 7, retry_at = ? WHERE endpoint = ?', Date.now() - 1, ep);
    await send();
    assert.ok(await waitFor(() => subRows(loose, v.id).length === 0), 'dropped');

    // A working push service with a few failures behind it: delivered, and the count starts over.
    const ok = `/recovered-${hex(4)}`;
    assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${pushPort}${ok}`) })).status, 200);
    loose.sql('UPDATE push_subs SET fails = 3, retry_at = ? WHERE user_id = ?', Date.now() - 1, v.id);
    await send();
    assert.ok(await waitFor(() => hitsAt(ok) === 1), 'delivered');
    assert.ok(await waitFor(() => row().fails === 0 && row().retry_at === null));
  } finally { await closeAll(flaky); }
});

test('push: a notification still waiting to go out is not sent once its device is signed out', async () => {
  // Two hanging devices of v's own keep both of v's sending places busy, so a third device's notification waits.
  const dead = await deadPushService();
  try {
    for (const expire of [false, true]) {
      const v = await loose.register(); const vf = await loose.register();
      const send = await dmLine(loose, vf, v);
      const tokB = (await loose.login(v)).json.token;
      const devB = `/waiting-${expire}-${hex(4)}`;
      assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(`https://localhost:${pushPort}${devB}`) }, tokB)).status, 200);
      await sleep(5); // the hanging ones are newer, so they're sent first
      for (let i = 0; i < 2; i++) assert.equal((await as(loose, v, 'POST', '/push/subscribe', { subscription: pushSub(`https://127.0.0.1:${dead.port}/v${expire}-${i}`) })).status, 200);
      await send();
      assert.ok(await waitFor(() => (dead.open.get(`/v${expire}`) || 0) === 2, 3000), "both of v's places are taken");
      await sleep(300);
      assert.equal(hitsAt(devB), 0, 'B is still waiting its turn');
      // B's session runs out while its notification waits. (Signing out deletes the row outright; this is the
      // case where the row is still there.)
      const sidB = subRows(loose, v.id).find((x) => x.endpoint.endsWith(devB)).session_id;
      if (expire) loose.sql('UPDATE sessions SET expires_at = ? WHERE id = ?', Date.now() - 1000, sidB);
      // The hanging sends give up (their connections drop), which frees v's places.
      dead.socks.forEach((s) => s.destroy());
      if (expire) {
        assert.ok(await waitFor(() => !subRows(loose, v.id).some((x) => x.endpoint.endsWith(devB))), 'dropped instead of sent');
        await sleep(300);
        assert.equal(hitsAt(devB), 0, 'nothing reached the signed-out device');
      } else {
        assert.ok(await waitFor(() => hitsAt(devB) === 1), 'control: delivered once its turn came');
      }
    }
  } finally { await dead.close(); }
});

// ------------------------------------------------------------------ subscribing (no lookups to spend)
test('push: subscribing again to a known endpoint looks nothing up, and every subscribe call is rate limited', async () => {
  const u = await strict.register();
  const ep = 'https://push.again.test/wpush/' + hex(8);
  const before = lookups('push.again.test');
  assert.equal((await as(strict, u, 'POST', '/push/subscribe', { subscription: pushSub(ep) })).status, 200);
  assert.equal(lookups('push.again.test') - before, 1, 'a new endpoint is checked');
  const statuses = [];
  for (let i = 0; i < 60; i++) statuses.push((await as(strict, u, 'POST', '/push/subscribe', { subscription: pushSub(ep) })).status);
  assert.deepEqual(statuses, [...Array(59).fill(200), 429], '60 calls an hour, new endpoint or not');
  assert.equal(lookups('push.again.test') - before, 1, 'and only the first one looked anything up');
});
