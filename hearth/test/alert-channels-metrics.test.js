// Alert channels (server/alertchannels.js: ntfy, a signed webhook, Discord and Slack) and GET /metrics
// (server/metrics.js): who may change them and when the password is needed again, secrets sealed at rest and only
// masked on the way out, outbound requests that may only reach the public internet (or a host the operator names in
// ALERT_PRIVATE_HOSTS), real deliveries to local stand-in services, and a metrics endpoint that's off by default,
// needs its token and says nothing about anyone.
//
// Nothing here touches the internet: the services are local servers, and host names are answered by a fake
// resolver loaded into the Hearth child (--require), as in outbound-hardening.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer, confirmEmail, enable2fa, hex, sleep } = require('./helpers');
const { sign } = require('../server/bots');
const channelsModule = require('../server/alertchannels');
const metricsModule = require('../server/metrics');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeAll = (server) => { try { server.closeAllConnections(); } catch { /* fine */ } return new Promise((r) => server.close(() => r())); };
const waitFor = async (fn, ms = 6000) => { for (let i = 0; i < ms / 50; i++) { if (await fn()) return true; await sleep(50); } return false; };

// ------------------------------------------------------------------ stand-in services
// One local server plays ntfy (/ntfy/), a webhook receiver (/hook), Discord (/discord/…), Slack (/slack/…) and a few
// misbehaving ones. got: every request it received. Another one, on a port nobody allowed, must never be reached.
const got = [];
let recv; let port; let other; let otherPort; let otherConns = 0;
const NTFY_TOKEN = 'tk_' + hex(14);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-alertch-'));
const PRELOAD = path.join(work, 'fake-dns.js');
fs.writeFileSync(PRELOAD, `
const ng = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'netguard.js'))});
const map = JSON.parse(process.env.FAKE_DNS || '{}');
const seen = {};
ng.setResolver(async (host) => {
  const h = host.toLowerCase();
  const entry = map[h];
  if (!entry) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  seen[h] = (seen[h] || 0) + 1;
  const answer = Array.isArray(entry[0]) ? entry[Math.min(seen[h], entry.length) - 1] : entry;
  return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
});
`);

let srv; let plain;
const METRICS_TOKEN = hex(24);
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const channelsOf = async (u = srv.owner) => (await as(u, 'GET', '/admin/alerts/channels')).json.channels;
const add = async (body, u = srv.owner) => as(u, 'POST', '/admin/alerts/channels', body);
const addOk = async (body, u = srv.owner) => { const r = await add(body, u); assert.equal(r.status, 200, r.text); return r.json; };
const wipeChannels = () => srv.sql("DELETE FROM instance_settings WHERE key = 'alertChannels'");
const local = (p) => `http://127.0.0.1:${port}${p}`;
const hits = (prefix) => got.filter((g) => g.path.startsWith(prefix));
const NTFY = () => `http://ntfy.lan:${port}/ntfy`; // a self-hosted ntfy behind a path, reached by its LAN name
// A fresh instance admin (changes are limited per admin, and each test makes plenty).
async function newAdmin() {
  const u = await srv.register();
  const r = await as(srv.owner, 'PUT', '/admin/staff', { userId: u.id, role: 'admin', authKey: srv.owner.authKey });
  assert.equal(r.status, 200, r.text);
  return u;
}

before(async () => {
  recv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url.startsWith('/fail')) { res.writeHead(500); return res.end('nope'); }
      if (req.url.startsWith('/slow')) return; // never answers
      if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: local('/landed') }); return res.end(); }
      if (req.url.startsWith('/huge')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const c = Buffer.alloc(1 << 16, 120); const pump = () => { while (!res.destroyed && res.write(c)); };
        res.on('drain', pump); res.on('error', () => {}); pump(); return;
      }
      if (req.url.startsWith('/ntfy/') && req.headers.authorization !== `Bearer ${NTFY_TOKEN}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  port = await listen(recv);
  other = http.createServer((req, res) => { res.end('should never be reached'); });
  other.on('connection', () => { otherConns++; });
  otherPort = await listen(other);
  const FAKE_DNS = JSON.stringify({
    'ntfy.lan': ['127.0.0.1'], 'hooks.public.test': ['93.184.216.34'], 'intranet.corp.test': ['10.0.0.7'], 'mixed.corp.test': ['93.184.216.34', '192.168.1.10'],
    'meta.test': ['::ffff:169.254.169.254'],
    // Public when the channel is saved, inside the network when an alert goes out (DNS rebinding).
    'flip.test': [['93.184.216.34'], ['127.0.0.1']],
  });
  srv = await startServer({ NODE_OPTIONS: `--require ${PRELOAD}`, FAKE_DNS, ALERT_PRIVATE_HOSTS: `127.0.0.1:${port}, ntfy.lan:${port}`, ALERT_CHANNEL_TIMEOUT_MS: '1500', METRICS_TOKEN });
  plain = await startServer();
});
after(async () => {
  await srv.stop(); await plain.stop();
  await closeAll(recv); await closeAll(other);
  fs.rmSync(work, { recursive: true, force: true });
});

// ================================================================== on their own
test('masking and the ALERT_PRIVATE_HOSTS list; the webhook signature is the bots’ own', () => {
  assert.equal(channelsModule.mask('short'), '••••');
  assert.equal(channelsModule.mask('hearth-alerts-Q7xZ9'), '••••7xZ9');
  const was = process.env.ALERT_PRIVATE_HOSTS;
  process.env.ALERT_PRIVATE_HOSTS = 'ntfy.lan, NTFY.HOME.ARPA., 10.0.0.5:8080, [fd00::5]:8443, fd00::6, *.lan, http://x/, ntfy.lan:abc';
  try {
    assert.deepEqual(channelsModule.privateHosts(), [{ host: 'ntfy.lan', port: 0 }, { host: 'ntfy.home.arpa', port: 0 }, { host: '10.0.0.5', port: 8080 }, { host: 'fd00::5', port: 8443 }, { host: 'fd00::6', port: 0 }]);
  } finally { if (was === undefined) delete process.env.ALERT_PRIVATE_HOSTS; else process.env.ALERT_PRIVATE_HOSTS = was; }
  // The same HMAC-SHA256 over "<timestamp>.<body>" that bot webhooks use (docs/BOTS.md shows how to check it).
  const secret = hex(16); const body = '{"v":1}';
  assert.equal(sign(secret, 1700000000, body), crypto.createHmac('sha256', secret).update(`1700000000.${body}`).digest('hex'));
});

test('masked addresses: a long first label of a host name and an ntfy server’s path are masked too', () => {
  const store = {};
  const ctx = { getSetting: (k) => store[k], setSetting: (k, v) => { store[k] = v; }, sealSecret: (x) => x, openSecret: (x) => x, fail: (st, msg) => { throw new Error(msg); } };
  const ch = (id, kind, target) => ({ id, kind, name: id, enabled: true, createdAt: 1, target: JSON.stringify(target), secret: kind === 'webhook' ? 's' : '' });
  store.alertChannels = JSON.stringify([
    ch('pipedream', 'webhook', { url: 'https://eo8a3f9c2d1b7e64.m.pipedream.net/' }),
    ch('slack', 'slack', { url: 'https://hooks.slack.com/services/T0/B0/abcdefghijkl' }),
    ch('ip', 'discord', { url: 'https://93.184.216.34:8443/api/webhooks/1/abcdefghijkl' }),
    ch('twolabels', 'webhook', { url: 'https://averyverylongname.com/x' }),
    ch('proxied', 'ntfy', { url: 'https://push.example.com/secret-prefix-9f3k/', topic: 'hearth-alerts-k3x9q', token: '' }),
    ch('root', 'ntfy', { url: 'https://ntfy.sh/', topic: 'hearth-alerts-k3x9q', token: 'tk_abcdefghijklmnop' }),
  ]);
  const where = Object.fromEntries(channelsModule(ctx).list().map((c) => [c.id, c.where]));
  assert.equal(where.pipedream, 'https://••••7e64.m.pipedream.net/••••', 'a secret sub-domain is masked like a path');
  assert.equal(where.slack, 'https://hooks.slack.com/••••ijkl', 'an ordinary host name is shown');
  assert.equal(where.ip, 'https://93.184.216.34:8443/••••ijkl', 'an address and a port are shown');
  assert.equal(where.twolabels, 'https://averyverylongname.com/••••', 'a domain itself is shown');
  assert.equal(where.proxied, 'https://push.example.com/••••f3k/ · topic ••••3x9q', 'an ntfy server’s path is masked');
  assert.equal(where.root, 'https://ntfy.sh · topic ••••3x9q · token ••••mnop');
});

test('metrics text format: escaped labels, NaN, an empty family', () => {
  const text = metricsModule.render([
    { name: 'hearth_x', help: 'A test.\nTwo lines', type: 'gauge', samples: [[{ job: 'a"b\\c\nd' }, 1], [null, NaN]] },
    { name: 'hearth_y_total', help: 'Count.', type: 'counter', samples: [] },
  ]);
  assert.equal(text, '# HELP hearth_x A test. Two lines\n# TYPE hearth_x gauge\nhearth_x{job="a\\"b\\\\c\\nd"} 1\nhearth_x NaN\n# HELP hearth_y_total Count.\n# TYPE hearth_y_total counter\n');
});

// ================================================================== alert channels on a real server
test('only instance admins can see or change alert channels: members and moderators get 403, signed out 401', async () => {
  const member = await srv.register(); const mod = await srv.register();
  assert.equal((await as(srv.owner, 'PUT', '/admin/staff', { userId: mod.id, role: 'moderator', authKey: srv.owner.authKey })).status, 200);
  const admin = await newAdmin();
  const mine = await addOk({ kind: 'webhook', url: local('/hook/perm'), name: 'Ops' }, admin);
  assert.ok(mine.secret, 'an admin can add one, without the password');
  const id = mine.channel.id;
  for (const u of [member, mod]) {
    assert.equal((await as(u, 'GET', '/admin/alerts/channels')).status, 403);
    assert.equal((await add({ kind: 'webhook', url: local('/hook/x') }, u)).status, 403);
    assert.equal((await as(u, 'PUT', `/admin/alerts/channels/${id}`, { name: 'x', authKey: u.authKey })).status, 403);
    assert.equal((await as(u, 'DELETE', `/admin/alerts/channels/${id}`, { authKey: u.authKey })).status, 403);
    assert.equal((await as(u, 'POST', `/admin/alerts/channels/${id}/test`)).status, 403);
    assert.ok(!('alerts' in ((await as(u, 'GET', '/admin/health')).json || {})), 'nor the health page that lists them');
  }
  assert.equal((await srv.api('GET', '/admin/alerts/channels')).status, 401);
  assert.equal((await srv.api('POST', '/admin/alerts/channels', { body: { kind: 'webhook', url: local('/hook/x') } })).status, 401);
  assert.equal(hits('/hook/x').length, 0);
  assert.deepEqual((await channelsOf()).map((c) => c.id), [id], 'nothing else was added');
  wipeChannels();
});

test('addresses are checked: private and disguised ones are refused unless ALERT_PRIVATE_HOSTS names them, http only for those', async () => {
  const admin = await newAdmin();
  const refused = [
    ['webhook', 'https://10.0.0.5/hook', 'private_address'], ['webhook', `https://127.0.0.1:${otherPort}/hook`, 'private_address'],
    ['webhook', `http://127.0.0.1:${otherPort}/hook`, 'private_address'], ['discord', 'https://[::ffff:7f00:1]/api/webhooks/1/x', 'private_address'],
    ['slack', 'https://169.254.169.254/latest/meta-data/', 'private_address'], ['webhook', 'https://intranet.corp.test/hook', 'private_address'],
    ['webhook', 'https://mixed.corp.test/hook', 'private_address'], ['webhook', 'https://meta.test/hook', 'private_address'],
    ['webhook', 'https://2130706433/hook', 'private_address'], ['ntfy', `http://[::1]:${port}/`, 'private_address'],
    ['webhook', 'http://hooks.public.test/hook', 'https_only'], ['webhook', 'https://user:pw@hooks.public.test/hook', 'bad_url'],
    ['webhook', 'ftp://hooks.public.test/hook', 'bad_url'], ['webhook', 'javascript:alert(1)', 'bad_url'], ['webhook', 'https://nowhere.test/x', 'bad_url'],
    ['webhook', `https://hooks.public.test/${'x'.repeat(2001)}`, 'bad_url'], ['webhook', '', 'bad_url'],
  ];
  for (const [kind, url, code] of refused) {
    const r = await add({ kind, url, topic: 'alerts-x' }, admin);
    assert.equal(r.status, 400, `${url} → ${r.status} ${r.text}`);
    assert.equal(r.json.code, code, `${url}: ${r.text}`);
  }
  // The fields are checked too.
  for (const [body, code] of [[{ kind: 'sms', url: local('/hook') }, 'bad_kind'], [{ kind: 'ntfy', url: NTFY(), topic: 'has space' }, 'bad_topic'],
    [{ kind: 'ntfy', url: NTFY(), topic: 'x'.repeat(65) }, 'bad_topic'], [{ kind: 'ntfy', url: NTFY(), topic: 'ok', token: 'two words' }, 'bad_token'],
    [{ kind: 'ntfy', url: `${NTFY()}?up=1`, topic: 'ok' }, 'bad_url']]) {
    const r = await add(body, admin);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, code, r.text);
  }
  assert.equal(srv.sql("SELECT value FROM instance_settings WHERE key = 'alertChannels'").length, 0, 'nothing was stored');
  assert.equal(otherConns, 0, 'nothing connected anywhere while checking');
  // Allowed: a public https address (only looked up, never contacted here), and the listed host and port, by
  // address or by name, over http.
  const ok = await newAdmin();
  await addOk({ kind: 'slack', url: 'https://hooks.public.test/services/T0/B0/' + hex(12) }, ok);
  await addOk({ kind: 'webhook', url: local('/hook/allowed') }, ok);
  await addOk({ kind: 'ntfy', url: NTFY(), topic: 'alerts-ok' }, ok);
  // A name that's listed, on another port, is not.
  assert.equal((await add({ kind: 'ntfy', url: `http://ntfy.lan:${otherPort}`, topic: 'alerts-ok' }, ok)).json.code, 'private_address');
  // Ten at most.
  for (let i = (await channelsOf()).length; i < channelsModule.MAX_CHANNELS; i++) await addOk({ kind: 'webhook', url: local(`/hook/n${i}`) }, ok);
  const over = await add({ kind: 'webhook', url: local('/hook/eleven') }, ok);
  assert.equal(over.status, 400); assert.equal(over.json.code, 'too_many');
  assert.equal(otherConns, 0);
  wipeChannels();
});

test('secrets are sealed at rest and only ever shown masked; the webhook signing secret is shown once', async () => {
  wipeChannels();
  const admin = await newAdmin();
  const topic = `hearth-alerts-${hex(6)}`; const discordToken = hex(30); const webhookKey = hex(20); const slackPath = `T0/B0/${hex(12)}`;
  const n = await addOk({ kind: 'ntfy', url: NTFY(), topic, token: NTFY_TOKEN, name: 'Phone' }, admin);
  const w = await addOk({ kind: 'webhook', url: local(`/hook/sealed?key=${webhookKey}`), name: 'Pager <b>bold</b>' }, admin);
  const d = await addOk({ kind: 'discord', url: local(`/discord/1234567890/${discordToken}`) }, admin);
  const s = await addOk({ kind: 'slack', url: local(`/slack/services/${slackPath}`) }, admin);
  assert.match(w.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(n.secret, undefined, 'only webhooks have a signing secret');
  assert.equal(n.channel.where, `http://ntfy.lan:${port}/•••• · topic ••••${topic.slice(-4)} · token ••••${NTFY_TOKEN.slice(-4)}`);
  assert.equal(d.channel.where, `http://127.0.0.1:${port}/••••${discordToken.slice(-4)}`);
  assert.equal(d.channel.name, 'Discord', 'a channel without a name is called by its kind');
  assert.equal(w.channel.name, 'Pager <b>bold</b>', 'names are kept as text (the page shows them as text)');
  const secrets = [topic, NTFY_TOKEN, discordToken, webhookKey, slackPath, w.secret];
  const shown = JSON.stringify([n, d, s, w.channel, await channelsOf(), (await as(srv.owner, 'GET', '/admin/health')).json.alerts]);
  for (const x of secrets.slice(0, 5)) assert.ok(!shown.includes(x), `${x} was sent to the browser`);
  assert.ok(!JSON.stringify([await channelsOf(), (await as(srv.owner, 'GET', '/admin/health')).json]).includes(w.secret), 'the signing secret is never shown again');
  const stored = srv.sql("SELECT value FROM instance_settings WHERE key = 'alertChannels'")[0].value;
  for (const x of secrets) assert.ok(!stored.includes(x), `${x} is stored in the clear`);
  assert.equal(JSON.parse(stored).filter((c) => String(c.target).startsWith('sealed:')).length, 4, 'every address is sealed');
  const audit = JSON.stringify(srv.sql("SELECT action, detail FROM admin_log WHERE action LIKE 'alert_channel%'"));
  assert.match(audit, /alert_channel_added/);
  for (const x of secrets) assert.ok(!audit.includes(x), `${x} is in the audit log`);
  wipeChannels();
});

test('turning a channel off, pointing it elsewhere or removing it needs the password; adding, renaming and turning on don’t', async () => {
  wipeChannels();
  const admin = await newAdmin();
  const { channel } = await addOk({ kind: 'webhook', url: local('/hook/stepup'), name: 'Pager' }, admin);
  const put = (body) => as(admin, 'PUT', `/admin/alerts/channels/${channel.id}`, body);
  const denied = (r) => assert.ok([401, 403].includes(r.status), `needs the password (${r.status} ${r.text})`);
  denied(await put({ enabled: false }));
  denied(await put({ enabled: false, authKey: hex(32) }));
  // Anything that reads as "off" is off, so it needs the password too.
  for (const v of [null, 0, '']) denied(await put({ enabled: v }));
  assert.equal((await channelsOf())[0].enabled, true, 'still on');
  let r = await put({ enabled: false, authKey: admin.authKey });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.channel.enabled, false);
  r = await put({ enabled: true });
  assert.equal(r.status, 200); assert.equal(r.json.channel.enabled, true, 'turning it on needs nothing more');
  r = await put({ name: 'On-call pager' });
  assert.equal(r.status, 200); assert.equal(r.json.channel.name, 'On-call pager');
  denied(await put({ url: local('/hook/elsewhere') }));
  denied(await put({ token: 'tk_x' }));
  assert.equal((await channelsOf())[0].where, channel.where, 'the address didn’t change');
  r = await put({ url: local('/hook/elsewhere'), authKey: admin.authKey });
  assert.equal(r.status, 200, r.text);
  assert.notEqual(r.json.channel.where, channel.where);
  // Still checked like a new one, even with the password.
  r = await put({ url: 'https://10.0.0.9/hook', authKey: admin.authKey });
  assert.equal(r.json.code, 'private_address');
  denied(await as(admin, 'DELETE', `/admin/alerts/channels/${channel.id}`));
  assert.equal((await channelsOf()).length, 1);
  r = await as(admin, 'DELETE', `/admin/alerts/channels/${channel.id}`, { authKey: admin.authKey });
  assert.equal(r.status, 200, r.text);
  assert.equal((await channelsOf()).length, 0);
  for (const [m, p] of [['PUT', `/admin/alerts/channels/${channel.id}`], ['DELETE', `/admin/alerts/channels/${channel.id}`], ['POST', `/admin/alerts/channels/${channel.id}/test`], ['PUT', '/admin/alerts/channels/nope']]) {
    assert.equal((await as(admin, m, p, { name: 'x', authKey: admin.authKey })).status, 404, `${m} ${p}`);
  }
  const actions = srv.sql("SELECT action, detail FROM admin_log WHERE action LIKE 'alert_channel_%' AND target = ? ORDER BY id", channel.id);
  assert.deepEqual(actions.map((a) => a.action), ['alert_channel_added', 'alert_channel_changed', 'alert_channel_changed', 'alert_channel_changed', 'alert_channel_changed', 'alert_channel_removed']);
  assert.match(actions[1].detail, /turned off/);
  assert.match(actions[3].detail, /renamed from "Pager"/);
  assert.match(actions[4].detail, /address was http:\/\/127\.0\.0\.1/);
});

test('with two-factor on, each change that stops alerts somewhere wants a fresh code; a wrong new address doesn’t use one up (auth-6)', async () => {
  wipeChannels();
  const admin = await newAdmin();
  const { backupCodes } = await enable2fa(srv, admin);
  const left = () => JSON.parse(srv.sql('SELECT backup_codes FROM users WHERE id = ?', admin.id)[0].backup_codes).length;
  const { channel } = await addOk({ kind: 'webhook', url: local('/hook/fresh'), name: 'Pager' }, admin);
  const put = (body) => as(admin, 'PUT', `/admin/alerts/channels/${channel.id}`, { authKey: admin.authKey, ...body });
  // The password alone isn't enough, even right after two-factor was turned on.
  let r = await put({ enabled: false });
  assert.ok([401, 403].includes(r.status), r.text);
  assert.equal((await channelsOf())[0].enabled, true);
  // A new address that's refused anyway is refused before the code is checked: the code stays good.
  let code = backupCodes.pop();
  let n = left();
  r = await put({ url: 'https://10.0.0.9/hook', backupCode: code });
  assert.deepEqual([r.status, r.json.code, r.json.codeUsed], [400, 'private_address', undefined], r.text);
  assert.equal(left(), n, 'the code wasn’t used');
  r = await put({ url: local('/hook/fresh-elsewhere'), backupCode: code });
  assert.equal(r.status, 200, r.text);
  assert.equal(left(), n - 1);
  // Each change wants its own code: the one just used doesn't turn the channel off, a new one does.
  r = await put({ enabled: false, backupCode: code });
  assert.equal(r.json.code, 'bad_2fa', r.text);
  r = await put({ enabled: false, backupCode: backupCodes.pop() });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.channel.enabled, false);
  r = await as(admin, 'DELETE', `/admin/alerts/channels/${channel.id}`, { authKey: admin.authKey });
  assert.ok([401, 403].includes(r.status), r.text);
  r = await as(admin, 'DELETE', `/admin/alerts/channels/${channel.id}`, { authKey: admin.authKey, backupCode: backupCodes.pop() });
  assert.equal(r.status, 200, r.text);
  assert.equal((await channelsOf()).length, 0);
});

test('turning alerts or alert emails off with null, 0 or "" needs the password too (not only false)', async () => {
  const admin = await newAdmin();
  const put = (body) => as(admin, 'PUT', '/admin/alerts', body);
  for (const body of [{ enabled: null }, { enabled: 0 }, { enabled: '' }, { email: null }, { email: 0 }]) {
    const r = await put(body);
    assert.ok([401, 403].includes(r.status), `${JSON.stringify(body)} → ${r.status} ${r.text}`);
  }
  const cfg = (await as(admin, 'GET', '/admin/health')).json.alerts;
  assert.equal(cfg.enabled, true); assert.equal(cfg.email, true);
  assert.equal((await put({ cooldownMin: 45 })).status, 200, 'other changes still need nothing more');
  assert.equal((await put({ enabled: true })).status, 200);
});

test('a cooldown longer than an hour needs the password (a week of it is nearly "off"); a shorter one doesn’t', async () => {
  const admin = await newAdmin();
  const put = (body) => as(admin, 'PUT', '/admin/alerts', body);
  const was = (await as(admin, 'GET', '/admin/health')).json.alerts.cooldownMin;
  assert.ok(was <= 60, `starts at an hour or less (${was})`);
  for (const body of [{ cooldownMin: 61 }, { cooldownMin: 10080 }, { cooldownMin: 1e9 }, { cooldownMin: '600' }, { cooldownMin: 120, authKey: hex(32) }]) {
    const r = await put(body);
    assert.ok([401, 403].includes(r.status), `${JSON.stringify(body)} → ${r.status} ${r.text}`);
  }
  assert.equal((await as(admin, 'GET', '/admin/health')).json.alerts.cooldownMin, was, 'unchanged');
  assert.equal((await put({ cooldownMin: 60 })).status, 200, 'up to an hour needs nothing more');
  let r = await put({ cooldownMin: 120, authKey: admin.authKey });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.cooldownMin, 120);
  r = await put({ cooldownMin: 90 });
  assert.equal(r.status, 200, 'shorter again needs nothing more'); assert.equal(r.json.cooldownMin, 90);
  assert.equal((await put({ cooldownMin: 0 })).status, 400);
  r = await put({ cooldownMin: was });
  assert.equal(r.status, 200); assert.equal(r.json.cooldownMin, was);
  const audit = srv.sql("SELECT detail FROM admin_log WHERE action = 'alerts_settings' ORDER BY id DESC LIMIT 4").map((a) => a.detail);
  assert.match(audit[2], /cooldown 60 → 120 min/);
});

test('an ntfy topic’s own address pasted as the server is taken apart; a path that ends in / is the server’s own', async () => {
  wipeChannels();
  const admin = await newAdmin();
  const topic = `pasted-${hex(6)}`;
  const sentTo = async (id) => {
    const r = await as(admin, 'POST', `/admin/alerts/channels/${id}/test`);
    assert.equal(r.json.result.ok, true, JSON.stringify(r.json.result));
    const last = got[got.length - 1];
    return { path: last.path, topic: JSON.parse(last.body).topic, priority: JSON.parse(last.body).priority };
  };
  const { channel } = await addOk({ kind: 'ntfy', url: `${NTFY()}/${topic}`, topic, token: NTFY_TOKEN }, admin);
  assert.deepEqual(await sentTo(channel.id), { path: '/ntfy/', topic, priority: 3 }, 'published to the server, with the topic in the body; a test is ordinary priority');
  // A path named like the topic, ending in /, is kept (it's where that ntfy lives).
  const own = await addOk({ kind: 'ntfy', url: `http://127.0.0.1:${port}/alerts/`, topic: 'alerts' }, admin);
  assert.deepEqual(await sentTo(own.channel.id), { path: '/alerts/', topic: 'alerts', priority: 3 });
  // A saved server keeps its path when only the topic changes, even to the path's own name.
  let r = await as(admin, 'PUT', `/admin/alerts/channels/${channel.id}`, { topic: 'ntfy', authKey: admin.authKey });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await sentTo(channel.id), { path: '/ntfy/', topic: 'ntfy', priority: 3 });
  r = await as(admin, 'PUT', `/admin/alerts/channels/${own.channel.id}`, { topic: 'other', authKey: admin.authKey });
  assert.deepEqual(await sentTo(own.channel.id), { path: '/alerts/', topic: 'other', priority: 3 });
  wipeChannels();
});

test('moving an ntfy channel to another server never takes its topic or access token along', async () => {
  wipeChannels();
  const topic = `owner-secret-${hex(6)}`;
  const { channel } = await addOk({ kind: 'ntfy', url: NTFY(), topic, token: NTFY_TOKEN, name: 'Owner phone' });
  const admin = await newAdmin();
  const put = (body) => as(admin, 'PUT', `/admin/alerts/channels/${channel.id}`, { authKey: admin.authKey, ...body });
  const lastTo = (host) => got.filter((g) => g.headers.host === host).pop();
  // The same server (another way of writing it): the topic and token stay, and still work.
  let r = await put({ url: `${NTFY()}/` });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.channel.where, /· token ••••/);
  assert.deepEqual((await as(admin, 'POST', `/admin/alerts/channels/${channel.id}/test`)).json.result, { ok: true, status: 200 });
  // Another server (here the same machine by its address, which is another origin): the topic has to be typed again.
  const elsewhere = `127.0.0.1:${port}`;
  const before = got.length;
  r = await put({ url: `http://${elsewhere}/ntfy` });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'bad_topic'); assert.match(r.json.error, /typed again/);
  assert.match((await channelsOf()).find((c) => c.id === channel.id).where, /^http:\/\/ntfy\.lan:/, 'nothing changed');
  r = await put({ url: `http://${elsewhere}/ntfy`, topic: 'mine' });
  assert.equal(r.status, 200, r.text);
  assert.doesNotMatch(r.json.channel.where, /token/, 'the token stayed behind');
  r = await as(admin, 'POST', `/admin/alerts/channels/${channel.id}/test`);
  assert.equal(r.json.result.status, 401, 'the new server got no token (the stand-in wants one)');
  const sent = lastTo(elsewhere);
  assert.ok(sent && got.indexOf(sent) >= before, 'it went to the new server');
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(JSON.parse(sent.body).topic, 'mine');
  for (const g of got.slice(before)) assert.ok(!g.body.includes(topic) && !JSON.stringify(g.headers).includes(NTFY_TOKEN), 'neither the old topic nor the token went anywhere');
  // Typed again, they go along.
  r = await put({ url: `http://${elsewhere}/ntfy`, topic: 'mine', token: NTFY_TOKEN });
  assert.deepEqual((await as(admin, 'POST', `/admin/alerts/channels/${channel.id}/test`)).json.result, { ok: true, status: 200 });
  wipeChannels();
});

test('an alert reaches ntfy (by name, with its token), a signed webhook, Discord and Slack, with the email’s words and nothing about anyone', async () => {
  wipeChannels();
  const email = `boss-${hex(4)}@example.test`;
  await confirmEmail(srv, srv.owner, email);
  const topic = `hearth-${hex(6)}`;
  await addOk({ kind: 'ntfy', url: NTFY(), topic, token: NTFY_TOKEN });
  const hook = await addOk({ kind: 'webhook', url: local('/hook/deliver') });
  await addOk({ kind: 'discord', url: local('/discord/1/abc') });
  await addOk({ kind: 'slack', url: local('/slack/T/B/x') });
  const off = await addOk({ kind: 'webhook', url: local('/hook/off') });
  assert.equal((await as(srv.owner, 'PUT', `/admin/alerts/channels/${off.channel.id}`, { enabled: false, authKey: srv.owner.authKey })).status, 200);
  const mailsBefore = (await srv.mails()).length;
  const start = got.length;
  const since = (prefix) => got.slice(start).filter((g) => g.path.startsWith(prefix));
  const sent = Date.now();
  const r = await as(srv.owner, 'POST', '/admin/alerts/test');
  assert.equal(r.json.result, 'sent');
  assert.ok(await waitFor(() => since('/ntfy/').length && since('/hook/deliver').length && since('/discord/1/').length && since('/slack/T/').length), 'every channel got it');
  assert.equal(hits('/hook/off').length, 0, 'a channel that’s turned off gets nothing');
  const mail = (await srv.mails()).slice(mailsBefore).find((m) => m.to === email);
  assert.ok(mail, 'the email still goes out');

  const ntfy = since('/ntfy/')[0];
  assert.equal(ntfy.method, 'POST'); assert.equal(ntfy.path, '/ntfy/', 'published as JSON to the server itself, not to a topic address');
  assert.equal(ntfy.headers.authorization, `Bearer ${NTFY_TOKEN}`);
  const nb = JSON.parse(ntfy.body);
  assert.equal(nb.topic, topic); assert.equal(nb.priority, 4); assert.deepEqual(nb.tags, ['warning']);
  assert.equal(nb.title, `${srv.config.name}: Test alert`);

  const wh = since('/hook/deliver')[0];
  assert.equal(wh.headers['x-hearth-event'], 'alert');
  const ts = Number(wh.headers['x-hearth-timestamp']);
  assert.ok(Math.abs(ts * 1000 - sent) < 60000, 'a fresh timestamp');
  assert.equal(wh.headers['x-hearth-signature'], `v1=${crypto.createHmac('sha256', hook.secret).update(`${ts}.${wh.body}`).digest('hex')}`, 'signed with the secret shown once');
  assert.equal(wh.headers['x-hearth-signature'], `v1=${sign(hook.secret, ts, wh.body)}`);
  const wb = JSON.parse(wh.body);
  assert.deepEqual(Object.keys(wb).sort(), ['alert', 'createdAt', 'id', 'server', 'type', 'v']);
  assert.deepEqual(Object.keys(wb.alert).sort(), ['at', 'detail', 'held', 'key', 'severity', 'title']);
  assert.equal(wh.headers['x-hearth-delivery'], wb.id);

  const dc = JSON.parse(since('/discord/1/')[0].body);
  assert.deepEqual(dc.allowed_mentions, { parse: [] }, 'nobody is pinged');
  assert.match(dc.content, /Test alert/);
  const sb = JSON.parse(since('/slack/T/')[0].body);
  assert.match(sb.text, /Test alert/);

  // The words are the email's: its title and detail, and nothing that names or locates a person.
  assert.match(mail.subject, new RegExp(wb.alert.title));
  assert.ok(mail.text.includes(wb.alert.detail));
  assert.ok(nb.message.startsWith(wb.alert.detail));
  const all = got.slice(start).map((g) => g.body + JSON.stringify(g.headers)).join('\n');
  for (const x of [srv.owner.username, srv.owner.id, email, srv.owner.ip]) assert.ok(!all.includes(x), `${x} was sent to a channel`);
  // Each one's outcome is kept for the dashboard.
  assert.ok(await waitFor(async () => (await channelsOf()).filter((c) => c.enabled).every((c) => c.last && c.last.ok)));
  const list = await channelsOf();
  assert.ok(list.filter((c) => c.enabled).every((c) => c.last.status === 200 && c.lastOkAt && !c.last.test));
  assert.equal(list.find((c) => c.id === off.channel.id).last, null);
  wipeChannels();
});

test('Test sends to that channel only and records what came back: an error answer, a wrong token, no answer, a redirect', async () => {
  wipeChannels();
  const admin = await newAdmin();
  const test1 = async (body) => { const { channel } = await addOk(body, admin); const r = await as(admin, 'POST', `/admin/alerts/channels/${channel.id}/test`); assert.equal(r.status, 200, r.text); return r.json; };
  await addOk({ kind: 'webhook', url: local('/hook/bystander') }, admin);
  const before = got.length;
  let t = await test1({ kind: 'webhook', url: local('/hook/tested') });
  assert.deepEqual(t.result, { ok: true, status: 200 });
  assert.equal(got.length - before, 1, 'one request, to that channel only');
  assert.equal(JSON.parse(hits('/hook/tested')[0].body).type, 'alert.test');
  assert.equal(hits('/hook/tested')[0].headers['x-hearth-event'], 'alert.test');
  assert.equal(t.channel.last.ok, true); assert.equal(t.channel.last.test, true); assert.ok(t.channel.lastOkAt);
  t = await test1({ kind: 'slack', url: local('/fail/x') });
  assert.equal(t.result.ok, false); assert.equal(t.result.status, 500); assert.match(t.result.error, /answered 500/);
  const shown = (await channelsOf()).find((c) => c.id === t.channel.id);
  assert.equal(shown.last.ok, false); assert.equal(shown.last.status, 500); assert.match(shown.last.error, /answered 500/);
  assert.equal(shown.failures, 0, 'a failed Test is shown, but only real alerts count toward failing');
  t = await test1({ kind: 'ntfy', url: NTFY(), topic: 'wrong-token', token: 'tk_wrong' });
  assert.equal(t.result.status, 401); assert.match(t.result.error, /access token/);
  const slowStart = Date.now();
  t = await test1({ kind: 'webhook', url: local('/slow') });
  assert.equal(t.result.ok, false); assert.match(t.result.error, /too long/);
  assert.ok(Date.now() - slowStart < 6000, 'the deadline holds');
  t = await test1({ kind: 'discord', url: local('/redirect') });
  assert.equal(t.result.status, 302, 'a redirect is an answer, never followed');
  assert.equal(hits('/landed').length, 0);
  t = await test1({ kind: 'webhook', url: local('/huge') });
  assert.equal(t.result.ok, true, 'an endless answer is cut off, not waited for');
  assert.equal((await srv.api('GET', '/health/live')).status, 200);
  assert.equal(hits('/hook/bystander').length, 0, 'the other channel heard nothing');
  wipeChannels();
});

test('a stored channel whose name now points inside the network is never contacted', async () => {
  wipeChannels();
  const admin = await newAdmin();
  const conns = []; const watch = (s) => conns.push(s.remoteAddress);
  recv.on('connection', watch);
  try {
    const { channel } = await addOk({ kind: 'webhook', url: `https://flip.test:${port}/hook/flip` }, admin);
    const r = await as(admin, 'POST', `/admin/alerts/channels/${channel.id}/test`);
    assert.equal(r.json.result.ok, false);
    assert.match(r.json.result.error, /private network/);
    assert.equal(conns.length, 0, 'not even a connection');
  } finally { recv.off('connection', watch); }
  wipeChannels();
});

test('a channel that keeps failing raises an alert, through the email and the other channels', async () => {
  wipeChannels();
  await addOk({ kind: 'webhook', url: local('/hook/good') });
  const bad = await addOk({ kind: 'webhook', url: local('/fail/bad'), name: 'Broken pager' });
  // Two failures already (as if two earlier alerts had failed there).
  const list = JSON.parse(srv.sql("SELECT value FROM instance_settings WHERE key = 'alertChannels'")[0].value);
  list.find((c) => c.id === bad.channel.id).failures = 2;
  srv.sql("UPDATE instance_settings SET value = ? WHERE key = 'alertChannels'", JSON.stringify(list));
  assert.equal((await as(srv.owner, 'POST', '/admin/alerts/test')).json.result, 'sent');
  const key = channelsModule.FAILING_KEY;
  let health;
  assert.ok(await waitFor(async () => { health = (await as(srv.owner, 'GET', '/admin/health')).json; return health.alerts.recent.some((a) => a.key === key); }), 'raised');
  const raised = health.alerts.recent.find((a) => a.key === key);
  assert.match(raised.title, /Alerts can’t reach the Webhook channel "Broken pager"/);
  assert.match(raised.detail, /3 deliveries in a row have failed\. Last error: It answered 500\./);
  assert.ok(await waitFor(() => hits('/hook/good').some((g) => JSON.parse(g.body).alert.key === key)), 'the working channel hears about it');
  assert.equal(health.alertChannels.status, 'degraded');
  assert.equal(health.alertChannels.failing, 1);
  // It went to the failing one too, but that doesn't start a loop: the same alert waits out its cooldown.
  await sleep(300);
  health = (await as(srv.owner, 'GET', '/admin/health')).json;
  assert.equal(health.alerts.recent.filter((a) => a.key === key).length, 1);
  // A Test that gets through shows it works again (the address is fixed here behind its back, as a stand-in).
  const fixed = JSON.parse(srv.sql("SELECT value FROM instance_settings WHERE key = 'alertChannels'")[0].value);
  fixed.find((c) => c.id === bad.channel.id).target = fixed.find((c) => c.id !== bad.channel.id).target;
  srv.sql("UPDATE instance_settings SET value = ? WHERE key = 'alertChannels'", JSON.stringify(fixed));
  assert.equal((await as(srv.owner, 'POST', `/admin/alerts/channels/${bad.channel.id}/test`)).json.channel.failures, 0);
  assert.equal((await as(srv.owner, 'GET', '/admin/health')).json.alertChannels.status, 'ok');
  wipeChannels();
});

test('broken channels can’t crowd out real alerts: one alert for all of them, outside the hourly cap, and Test presses don’t count', async () => {
  wipeChannels();
  const admin = await newAdmin();
  // Nine channels that always fail, added and tested without the password (all an admin may do on their own).
  const ids = [];
  for (let i = 0; i < 9; i++) ids.push((await addOk({ kind: 'webhook', url: local(`/fail/crowd${i}`), name: `Pager ${i}` }, admin)).channel.id);
  for (const id of ids) for (let k = 0; k < 2; k++) assert.equal((await as(admin, 'POST', `/admin/alerts/channels/${id}/test`)).json.result.ok, false);
  assert.ok((await channelsOf()).every((c) => c.failures === 0 && c.last.test), 'failed Tests are shown, not counted');
  // Three alerts (the admin's own "Send a test alert", which needs no password either): every channel fails each one.
  for (let k = 0; k < 3; k++) assert.equal((await as(admin, 'POST', '/admin/alerts/test')).json.result, 'sent');
  assert.ok(await waitFor(async () => (await channelsOf()).every((c) => c.failures >= 3)), 'each channel failed 3 real alerts');
  await sleep(300);
  const health = (await as(srv.owner, 'GET', '/admin/health')).json;
  assert.equal(health.alertChannels.failing, 9);
  const about = health.alerts.recent.filter((a) => a.key === channelsModule.FAILING_KEY || a.key.startsWith('alert_channel'));
  assert.ok(about.length <= 1, `at most one alert about channels in all (${about.map((a) => a.key)})`);
  // The owner's alert still goes out.
  assert.equal((await as(srv.owner, 'POST', '/admin/alerts/test')).json.result, 'sent', 'a real alert is not capped');
  wipeChannels();
});

test('the alert about failing channels names them, has its own hourly slot, and clears when none is failing', async () => {
  const store = {}; const raised = []; const cleared = [];
  const alerts = { raise: (key, a, opts) => { raised.push({ key, ...a, opts }); return 'sent'; }, clear: (key) => cleared.push(key) };
  const ctx = { getSetting: (k) => store[k], setSetting: (k, v) => { store[k] = v; }, sealSecret: (x) => x, openSecret: (x) => x, fail: (st, msg) => { throw Object.assign(new Error(msg), { status: st }); }, alerts };
  const ch = (i, failures) => ({ id: `c${i}`, kind: i % 2 ? 'slack' : 'discord', name: `Pager ${i}`, enabled: true, createdAt: 1, failures,
    last: { at: 1, ok: false, status: 500, error: 'It answered 500.', test: false }, target: JSON.stringify({ url: `https://127.0.0.1:1/fail/${i}` }) });
  store.alertChannels = JSON.stringify([ch(1, 3), ch(2, 5), ch(3, 1), ...[4, 5, 6, 7, 8].map((i) => ch(i, 4))]);
  const c = channelsModule(ctx);
  // (Their addresses are on this machine and not allowed, so each delivery fails at once, without a connection.)
  await c.deliverAll({ key: 'job:backup.daily', severity: 'warning', title: 't', detail: 'd', held: 0, at: 1 });
  assert.equal(raised.length, 1, 'one alert, however many are failing');
  const a = raised[0];
  assert.equal(a.key, channelsModule.FAILING_KEY);
  assert.deepEqual(a.opts, { outsideCap: true });
  assert.equal(a.title, 'Alerts can’t reach 7 alert channels', 'the one that has failed only twice isn’t failing yet');
  assert.match(a.detail, /^Failing: "Pager 1" \(Slack\), "Pager 2" \(Discord\), "Pager 4" \(Discord\), "Pager 5" \(Slack\), "Pager 6" \(Discord\) and 2 more\. Last error at "Pager 1": /);
  assert.ok(a.detail.length < 600, 'it fits in an alert');
  // Delivering that alert fails again, but doesn't raise another one about itself.
  await c.deliverAll({ key: channelsModule.FAILING_KEY, severity: 'warning', title: 't', detail: 'd', held: 0, at: 2 });
  assert.equal(raised.length, 1);
  assert.equal(cleared.length, 0);
  for (const x of c.list()) if (x.failures >= channelsModule.FAILING_AFTER) c.remove(x.id);
  assert.deepEqual(cleared, [channelsModule.FAILING_KEY], 'cleared once none is failing');
});

test('rate limits: Test 20 an hour, changes 30 an hour, per admin', async () => {
  wipeChannels();
  const admin = await newAdmin();
  const { channel } = await addOk({ kind: 'webhook', url: local('/hook/limits') }, admin);
  for (let i = 0; i < 20; i++) assert.equal((await as(admin, 'POST', `/admin/alerts/channels/${channel.id}/test`)).status, 200, `test ${i}`);
  assert.equal((await as(admin, 'POST', `/admin/alerts/channels/${channel.id}/test`)).status, 429);
  for (let i = 1; i < 30; i++) assert.equal((await as(admin, 'PUT', `/admin/alerts/channels/${channel.id}`, { name: `n${i}` })).status, 200, `change ${i}`);
  assert.equal((await as(admin, 'PUT', `/admin/alerts/channels/${channel.id}`, { name: 'one too many' })).status, 429);
  assert.equal((await add({ kind: 'webhook', url: local('/hook/x') }, admin)).status, 429);
  wipeChannels();
});

// ================================================================== /metrics
test('metrics: off by default (a plain 404, not the app), and a short METRICS_TOKEN keeps it off', async () => {
  for (const headers of [{}, { authorization: `Bearer ${METRICS_TOKEN}` }]) {
    const r = await plain.call('GET', '/metrics', { headers });
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    assert.ok(!r.text.includes('hearth_') && !r.text.includes('<html'), r.text);
  }
  await plain.restart({ METRICS_TOKEN: 'too-short' });
  const r = await plain.call('GET', '/metrics', { headers: { authorization: 'Bearer too-short' } });
  assert.equal(r.status, 404);
  assert.match(plain.log, /token_too_short|METRICS_TOKEN must be at least 16/);
});

test('metrics: Prometheus text with instance-level numbers only, no names, ids, addresses or emails', async () => {
  const someone = await srv.register(`mu${hex(4)}`);
  await srv.api('GET', '/no-such-route', { token: someone.token, ip: someone.ip });
  const scrape = async () => { const r = await srv.call('GET', '/metrics', { ip: '198.51.100.41', headers: { authorization: `Bearer ${METRICS_TOKEN}` } }); assert.equal(r.status, 200, r.text); return r.text; };
  const parse = (text) => {
    const out = [];
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('# HELP ') || line.startsWith('# TYPE ')) continue;
      const m = /^(hearth_[a-z0-9_]+)(?:\{([^}]*)\})? (\S+)$/.exec(line);
      assert.ok(m, `not a metric line: ${line}`);
      const labels = {};
      for (const [, k, v] of (m[2] || '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[k] = v;
      out.push({ name: m[1], labels, value: Number(m[3]) });
    }
    return out;
  };
  const text = await scrape();
  const samples = parse(text);
  const one = (list, name, labels = {}) => list.find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v));
  for (const name of ['hearth_process_uptime_seconds', 'hearth_event_loop_lag_p99_seconds', 'hearth_process_resident_memory_bytes', 'hearth_sockets', 'hearth_disk_free_bytes',
    'hearth_registered_users', 'hearth_backups', 'hearth_ready', 'hearth_unexpected_errors_total']) assert.ok(one(samples, name), `${name} is there`);
  for (const k of ['1xx', '2xx', '3xx', '4xx', '5xx']) assert.ok(one(samples, 'hearth_http_requests_total', { class: k }), `requests ${k}`);
  assert.ok(one(samples, 'hearth_http_requests_total', { class: '4xx' }).value >= 1, 'the 404 was counted');
  assert.ok(one(samples, 'hearth_job_runs_total', { job: 'backup.daily' }), 'jobs by name');
  assert.ok(!one(samples, 'hearth_job_last_run_timestamp_seconds', { job: 'backup.daily' }), 'a job that hasn’t run has no time (not NaN)');
  assert.ok(one(samples, 'hearth_job_last_run_timestamp_seconds', { job: 'backup.cleanup_leftovers' }).value > 1.7e9, 'one that has, has one');
  assert.ok(!samples.some((s) => Number.isNaN(s.value)), 'no NaN anywhere');
  assert.ok(one(samples, 'hearth_job_failures_total', { job: 'alerts.check' }));
  assert.ok(one(samples, 'hearth_messages', { kind: 'channel' }) && one(samples, 'hearth_messages', { kind: 'direct' }));
  assert.equal(one(samples, 'hearth_info').labels.schema, '19');
  assert.equal(one(samples, 'hearth_registered_users').value, srv.sql('SELECT COUNT(*) n FROM users WHERE is_bot = 0 AND deleted_at IS NULL')[0].n);
  assert.ok(one(samples, 'hearth_disk_total_bytes').value > 0);
  assert.match(text, /# TYPE hearth_http_requests_total counter/);
  // Only these labels, and nothing about a person anywhere.
  const labelNames = new Set(samples.flatMap((s) => Object.keys(s.labels)));
  assert.deepEqual([...labelNames].sort(), ['class', 'job', 'kind', 'node', 'schema', 'version']);
  for (const s of samples.filter((x) => x.labels.job)) assert.match(s.labels.job, /^[a-z_]+\.[a-z_]+$/, 'job labels are the jobs’ fixed names');
  for (const x of [srv.owner.username, srv.owner.id, someone.username, someone.id, someone.ip, srv.owner.ip, '@example.test']) assert.ok(!text.includes(x), `${x} is in /metrics`);
  assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'no IP addresses');
  // Counters count.
  const before2xx = one(samples, 'hearth_http_requests_total', { class: '2xx' }).value;
  await srv.api('GET', '/health/live');
  const again = parse(await scrape());
  assert.ok(one(again, 'hearth_http_requests_total', { class: '2xx' }).value > before2xx);
});

test('metrics: the bearer token or nothing; wrong guesses are limited per network, before the token is even compared', async () => {
  const get = (authorization, { ip = '198.51.100.40', p = '/metrics' } = {}) => srv.call('GET', p, { ip, headers: authorization === undefined ? {} : { authorization } });
  let r = await get(undefined);
  assert.equal(r.status, 401); assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="metrics"'); assert.ok(!r.text.includes('hearth_'));
  for (const a of [`Bearer ${hex(24)}`, `Bearer ${METRICS_TOKEN.slice(0, -1)}`, `Bearer ${METRICS_TOKEN}x`, `Basic ${Buffer.from(`x:${METRICS_TOKEN}`).toString('base64')}`, METRICS_TOKEN, `Bearer ${METRICS_TOKEN} extra`, 'Bearer']) {
    r = await get(a);
    assert.equal(r.status, 401, a);
  }
  r = await get(undefined, { p: `/metrics?token=${METRICS_TOKEN}` });
  assert.equal(r.status, 401, 'never a token in the address');
  r = await get(`Bearer ${METRICS_TOKEN}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  // 20 wrong guesses from one network; after that even the right token waits there, but not elsewhere.
  const ip = '198.51.100.77';
  for (let i = 0; i < metricsModule.MAX_FAILS; i++) assert.equal((await get(`Bearer ${hex(24)}`, { ip })).status, 401);
  assert.equal((await get(`Bearer ${hex(24)}`, { ip })).status, 429);
  assert.equal((await get(`Bearer ${METRICS_TOKEN}`, { ip })).status, 429);
  assert.equal((await get(`Bearer ${METRICS_TOKEN}`, { ip: '203.0.113.9' })).status, 200);
});
