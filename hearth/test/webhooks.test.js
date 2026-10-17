// Incoming webhooks (server/webhooks.js): per-channel addresses that programs post to the way they post to Discord
// or Slack. Requests here are what those programs send (Uptime Kuma's and Grafana's Discord notifiers, a Slack
// incoming-webhook body, GitHub's own events, curl from CI), over plain HTTP like curl would.
// The server runs in a time zone that isn't UTC (so a time with no zone read as local time would show), with a short
// body deadline, and with a local push service that decrypts what it gets (as in usability.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const ece = require('http_ece');
const { startServer, hex, newIp, sleep } = require('./helpers');

const P = { VIEW: 1, SEND: 2, MENTION_EVERYONE: 1 << 4, MANAGE_CHANNELS: 1 << 11, MANAGE_SERVER: 1 << 13 };
const ZW = '\u200b';
const BODY_MS = 4000;

let srv; let alice; let bob; let carol; let dave; let eve;
let space; let general; let alerts; let secret; let voice; let modsRole; let code;
let certDir; let push; let pushPort;
const inbox = {}; // user id -> decrypted push payloads
const subs = {}; // user id -> { ecdh, auth }
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 25) { const v = await fn(); if (v) return v; await sleep(25); } return null; };
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const collect = (s, ev) => { const got = []; s.on(ev, (x) => got.push(x)); return got; };
// A request the way a notifier sends it: no session, the address is the only credential. Like Discord clients, it
// waits out a 429 (retry_after) and tries again, unless the test is about the limits.
async function hook(path, { json, raw, type, ip = newIp(), headers = {}, method = 'POST', retry = true } = {}) {
  const h = { ...headers };
  if (type) h['content-type'] = type;
  for (;;) {
    const r = json !== undefined ? await srv.call(method, path, { body: json, ip, headers: h }) : await srv.call(method, path, { raw, ip, headers: h });
    if (r.status !== 429 || !retry || !r.json || !(r.json.retry_after <= 3)) return r;
    await sleep(r.json.retry_after * 1000 + 50);
  }
}
const channel = async (name) => {
  const r = await as(alice, 'POST', `/servers/${space.id}/channels`, { name, type: 'text' });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
async function makeHook(channel, name, { by = alice, allowMentions } = {}) {
  const r = await as(by, 'POST', `/channels/${channel.id}/webhooks`, { name, allowMentions });
  assert.equal(r.status, 200, r.text);
  return { ...r.json.webhook, token: r.json.token, path: r.json.path };
}
const lastMessage = (channelId) => srv.sql('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1', channelId)[0];
const member = async (name) => {
  const u = await srv.register(`${name}${hex(3)}`);
  assert.equal((await as(u, 'POST', `/invites/${code}/join`)).status, 200);
  return u;
};
const b64u = (b) => Buffer.from(b).toString('base64url');
async function subscribe(u) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  subs[u.id] = { ecdh, auth };
  const r = await as(u, 'POST', '/push/subscribe', { subscription: { endpoint: `https://127.0.0.1:${pushPort}/p/${u.id}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } });
  assert.equal(r.status, 200, r.text);
}
const got = (u) => inbox[u.id] || [];
// Waits until someone has n pushes (or a while passes), then a little longer so a wrong extra one would show.
async function settle(u, n) { for (let i = 0; i < 40 && got(u).length < n; i++) await sleep(100); await sleep(400); }
// A POST whose body is held back, like a slow or stalled client: the headers (with the address) go at once, the rest
// of the body when the test calls finish(). done resolves with the answer.
function held(p, json, { ip = newIp() } = {}) {
  const raw = Buffer.from(JSON.stringify(json));
  const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: p, headers: { 'content-type': 'application/json', 'content-length': raw.length, 'x-forwarded-for': ip } });
  const done = new Promise((resolve) => {
    req.on('response', (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ } resolve({ status: res.statusCode, json: j, text: t }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
  });
  req.write(raw.subarray(0, 5));
  return { done, finish: () => { req.end(raw.subarray(5)); return done; } };
}
async function history(channelId, u = alice) {
  const r = await as(u, 'GET', `/channels/${channelId}/messages`);
  assert.equal(r.status, 200, r.text);
  return r.json.messages;
}

before(async () => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-push-'));
  const pems = await require('selfsigned').generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  });
  fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);
  push = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const uid = req.url.split('/').pop();
      const s = subs[uid];
      let payload = null;
      try { payload = JSON.parse(ece.decrypt(Buffer.concat(parts), { version: 'aes128gcm', privateKey: s.ecdh, authSecret: s.auth }).toString('utf8')); } catch { payload = { undecryptable: true }; }
      (inbox[uid] ||= []).push(payload);
      res.writeHead(201); res.end();
    });
  });
  await new Promise((r) => push.listen(0, '127.0.0.1', r));
  pushPort = push.address().port;
  srv = await startServer({ TZ: 'Europe/Berlin', WEBHOOK_BODY_MS: String(BODY_MS), PUSH_ALLOW_PRIVATE: '1', NODE_EXTRA_CA_CERTS: path.join(certDir, 'cert.pem'),
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
  alice = await srv.register('alice'); bob = await srv.register('bob'); carol = await srv.register('carol'); dave = await srv.register('dave'); eve = await srv.register('eve');
  space = (await as(alice, 'POST', '/servers', { name: 'Hooks HQ' })).json;
  general = space.channels.find((c) => c.type === 'text');
  voice = space.channels.find((c) => c.type === 'voice');
  alerts = (await as(alice, 'POST', `/servers/${space.id}/channels`, { name: 'alerts', type: 'text' })).json;
  secret = (await as(alice, 'POST', `/servers/${space.id}/channels`, { name: 'secret', type: 'text' })).json;
  assert.equal((await as(alice, 'PUT', `/channels/${secret.id}/overrides`, { overrides: [{ type: 'role', id: space.id, allow: 0, deny: P.VIEW }] })).status, 200);
  code = (await as(alice, 'POST', `/servers/${space.id}/invites`, { expiresHours: 0 })).json.code;
  for (const u of [bob, carol, dave]) assert.equal((await as(u, 'POST', `/invites/${code}/join`)).status, 200);
  // carol manages channels (but may not mention everyone); dave manages the server.
  modsRole = (await as(alice, 'POST', `/servers/${space.id}/roles`, { name: 'Mods', permissions: P.MANAGE_CHANNELS })).json;
  const admins = (await as(alice, 'POST', `/servers/${space.id}/roles`, { name: 'Admins', permissions: P.MANAGE_SERVER })).json;
  assert.equal((await as(alice, 'PUT', `/servers/${space.id}/members/${carol.id}/roles`, { roleIds: [modsRole.id] })).status, 200);
  assert.equal((await as(alice, 'PUT', `/servers/${space.id}/members/${dave.id}/roles`, { roleIds: [admins.id] })).status, 200);
});
after(async () => {
  socks.forEach((s) => s.close());
  if (srv) await srv.stop();
  if (push) push.close();
  if (certDir) fs.rmSync(certDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ making them
test('only people with Manage Channels (or Manage Server) can make one; the secret is shown once and only its hash is kept', async () => {
  assert.equal((await as(bob, 'POST', `/channels/${general.id}/webhooks`, { name: 'Nope' })).status, 403, 'a plain member');
  assert.equal((await as(eve, 'POST', `/channels/${general.id}/webhooks`, { name: 'Nope' })).status, 404, 'not in the server');
  assert.equal((await as(carol, 'POST', `/channels/${secret.id}/webhooks`, { name: 'Nope' })).status, 404, 'a channel they can’t see');
  assert.equal((await as(alice, 'POST', `/channels/${voice.id}/webhooks`, { name: 'Nope' })).status, 400, 'voice channels have no messages');
  assert.equal((await as(bob, 'GET', `/channels/${general.id}/webhooks`)).status, 403);
  assert.equal((await as(alice, 'POST', `/channels/${general.id}/webhooks`, { name: '  \u200b ' })).status, 400, 'a name is needed');

  const byCarol = await makeHook(general, 'Carol CI', { by: carol });
  const byDave = await makeHook(alerts, 'Dave alerts', { by: dave });
  assert.ok(byDave.id);
  // A per-channel deny of Manage Channels is respected (Manage Server alone still counts, like Discord's).
  const locked = (await as(alice, 'POST', `/servers/${space.id}/channels`, { name: 'locked', type: 'text' })).json;
  assert.equal((await as(alice, 'PUT', `/channels/${locked.id}/overrides`, { overrides: [{ type: 'role', id: modsRole.id, allow: 0, deny: P.MANAGE_CHANNELS }] })).status, 200);
  assert.equal((await as(carol, 'POST', `/channels/${locked.id}/webhooks`, { name: 'Nope' })).status, 403);
  // Group chats have no webhooks.
  const group = await as(alice, 'POST', '/groups', { userIds: [bob.id] });
  assert.equal(group.status, 200, group.text);
  assert.equal((await as(alice, 'POST', `/channels/${group.json.channels.find((c) => c.type === 'text').id}/webhooks`, { name: 'Nope' })).status, 400);

  assert.match(byCarol.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(byCarol.path, `/api/webhooks/${byCarol.id}/${byCarol.token}`);
  const row = srv.sql('SELECT * FROM channel_webhooks WHERE id = ?', byCarol.id)[0];
  assert.equal(row.token_hash, crypto.createHash('sha256').update(`${byCarol.id}.${byCarol.token}`).digest('hex'));
  // Never stored or shown again: not in the database, the audit log, or the list.
  const dump = JSON.stringify([srv.sql('SELECT * FROM channel_webhooks'), srv.sql('SELECT * FROM admin_log'), srv.sql('SELECT * FROM users')]);
  assert.ok(!dump.includes(byCarol.token), 'secret stored');
  const list = await as(carol, 'GET', `/channels/${general.id}/webhooks`);
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(byCarol.token));
  assert.equal(list.json.webhooks.find((w) => w.id === byCarol.id).name, 'Carol CI');
  assert.equal(list.json.canPing, false, 'carol may not mention everyone');
  const audit = srv.sql("SELECT action, detail FROM admin_log WHERE action = 'webhook_created'");
  assert.ok(audit.some((a) => a.detail.includes(byCarol.id) && a.detail.includes('#general')), JSON.stringify(audit));
  // Its account is a bot that can never sign in or call the bot API.
  const u = srv.sql('SELECT * FROM users WHERE id = ?', byCarol.userId)[0];
  assert.equal(u.is_bot, 1);
  assert.equal(JSON.parse(u.profile).displayName, 'Carol CI');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM bots WHERE id = ?', byCarol.userId)[0].n, 0);
  assert.equal((await srv.api('POST', '/auth/login', { body: { username: u.username, authKey: hex(32) } })).status, 401);
  assert.equal((await srv.api('GET', '/bot/v1/me', { headers: { authorization: `Bot ${byCarol.token}` } })).status, 401);
});

// ------------------------------------------------------------------ posting
test('Uptime Kuma’s Discord notifier: embeds become Markdown, posted live as the webhook’s bot, sealed and not end-to-end encrypted', async () => {
  const w = await makeHook(alerts, 'Monitoring');
  const s = await sock(bob);
  const got = collect(s, 'message:new');
  // What Uptime Kuma sends when a monitor goes down (notification-providers/discord.js). Its timestamp is the
  // heartbeat's time: UTC, written with no zone (and this server's own zone is Europe/Berlin).
  const down = {
    username: 'Uptime Kuma',
    embeds: [{
      title: '\u274c Your service My API went down. \u274c', color: 16711680, timestamp: '2026-10-11 05:00:00.123',
      fields: [{ name: 'Service Name', value: 'My API' }, { name: 'Service URL', value: 'https://api.example.com/health' },
        { name: 'Time (Europe/Berlin)', value: '2026-10-11 07:00:00' }, { name: 'Error', value: 'timeout of 48000ms exceeded' }],
    }],
  };
  const r = await hook(w.path, { json: down });
  assert.equal(r.status, 204, r.text);
  assert.equal(r.text, '');
  const m = await until(() => got.find((x) => x.channelId === alerts.id));
  assert.ok(m, 'bob’s app got it live');
  assert.equal(m.authorId, w.userId);
  assert.equal(m.bot, true);
  assert.equal(m.legacy, true, 'a plaintext (server-sealed) post, like other bot posts');
  assert.deepEqual(m.webhook, { id: w.id, name: 'Uptime Kuma', avatar: null, pings: false });
  assert.equal(m.content, [
    '\ud83d\udd34 **\u274c Your service My API went down. \u274c**', '**Service Name**', 'My API', '**Service URL**', 'https://api.example.com/health',
    '**Time (Europe/Berlin)**', '2026-10-11 07:00:00', '**Error**', 'timeout of 48000ms exceeded', '2026-10-11 05:00 UTC'].join('\n'));
  // Stored sealed with the server's key: no ciphertext, and the text isn't readable in the database file.
  const row = lastMessage(alerts.id);
  assert.equal(row.id, m.id);
  assert.equal(row.ciphertext, null);
  assert.ok(!row.body.includes('My API'), 'sealed at rest');
  // In the history like any message; bob (no manage permission) sees it too.
  const h = (await history(alerts.id, bob)).find((x) => x.id === m.id);
  assert.equal(h.content, m.content);
  assert.equal(h.webhook.name, 'Uptime Kuma');
  // Uptime Kuma's "Test" button.
  assert.equal((await hook(w.path, { json: { username: 'Uptime Kuma', content: 'Uptime Kuma Testing' } })).status, 204);
  assert.equal(srv.sql('SELECT last_used_at FROM channel_webhooks WHERE id = ?', w.id)[0].last_used_at > 0, true);
});

test('Grafana (avatar_url, footer, link), ?wait=true, and GET on the address', async () => {
  const w = await makeHook(alerts, 'Grafana');
  const grafana = {
    content: '', username: 'Grafana', avatar_url: 'https://grafana.com/static/assets/img/fav32.png',
    embeds: [{ title: '[FIRING:1] HighCPU (web-1)', url: 'https://grafana.example.com/alerting/list', color: 14037554, type: 'rich',
      description: '**Firing**\n\nValue: B=97.2\nLabels:\n - alertname = HighCPU', footer: { text: 'Grafana v11.2.0', icon_url: 'https://grafana.com/static/assets/img/fav32.png' } }],
  };
  const r = await hook(`${w.path}?wait=true`, { json: grafana });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.webhook_id, w.id);
  assert.equal(r.json.channel_id, alerts.id);
  assert.equal(r.json.author.username, 'Grafana');
  assert.equal(r.json.author.bot, true);
  const row = srv.sql('SELECT * FROM messages WHERE id = ?', r.json.id)[0];
  assert.ok(row, 'the id that came back is the message');
  const m = (await history(alerts.id)).find((x) => x.id === r.json.id);
  assert.equal(m.content, ['\ud83d\udd34 **[FIRING:1] HighCPU (web-1)**', 'https://grafana.example.com/alerting/list', '**Firing**\n\nValue: B=97.2\nLabels:\n - alertname = HighCPU', 'Grafana v11.2.0'].join('\n'));
  // Kept as an https link for the app to show through the image proxy; never fetched by the server here.
  assert.equal(m.webhook.avatar, 'https://grafana.com/static/assets/img/fav32.png');
  const info = await hook(w.path, { method: 'GET' });
  assert.equal(info.status, 200);
  assert.deepEqual({ ...info.json }, { type: 1, id: w.id, name: 'Grafana', avatar: null, channel_id: alerts.id, guild_id: space.id, application_id: null });
  assert.ok(!info.text.includes(w.token));
});

test('Slack-style {text}, a Slack form, plain text, the /slack address and GitHub’s events', async () => {
  const ci = await channel('ci');
  const w = await makeHook(ci, 'Everything');
  // Slack incoming-webhook JSON (what GitHub Actions' slack steps and Alertmanager send).
  assert.equal((await hook(w.path, { json: { text: 'Deploy of *web* finished: <https://ci.example.com/run/42|run 42> &amp; done' } })).status, 204);
  assert.equal(lastMessage(ci.id).author_id, w.userId);
  let m = (await history(ci.id)).at(-1);
  assert.equal(m.content, 'Deploy of **web** finished: run 42 (https://ci.example.com/run/42) & done');
  // The form Slack also accepts.
  assert.equal((await hook(w.path, { raw: `payload=${encodeURIComponent(JSON.stringify({ text: 'from a form', username: 'cron' }))}`, type: 'application/x-www-form-urlencoded' })).status, 204);
  m = (await history(ci.id)).at(-1);
  assert.equal(m.content, 'from a form');
  assert.equal(m.webhook.name, 'cron');
  // curl -d '{"content":"…"}' sends JSON labelled as a form.
  assert.equal((await hook(w.path, { raw: '{"content":"curl from CI"}', type: 'application/x-www-form-urlencoded' })).status, 204);
  assert.equal((await history(ci.id)).at(-1).content, 'curl from CI');
  // Plain text.
  assert.equal((await hook(w.path, { raw: 'backup finished: 12 GB in 4 min\nall good', type: 'text/plain; charset=utf-8' })).status, 204);
  assert.equal((await history(ci.id)).at(-1).content, 'backup finished: 12 GB in 4 min\nall good');
  // /slack with attachments (Grafana's and many older tools' Slack format).
  const slack = { text: 'Alert', attachments: [{ color: 'danger', title: 'Disk full', title_link: 'https://grafana.example.com/d/1', text: '/var is at 99%', fields: [{ title: 'Host', value: 'db-1', short: true }], footer: 'Grafana' }] };
  assert.equal((await hook(`${w.path}/slack`, { json: slack })).status, 204);
  assert.equal((await history(ci.id)).at(-1).content, ['Alert', '', '\ud83d\udd34 **Disk full**', 'https://grafana.example.com/d/1', '/var is at 99%', '**Host**', 'db-1', 'Grafana'].join('\n'));
  // GitHub's own events at /github (Settings → Webhooks → Payload URL …/github): a push…
  const push = {
    ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40), created: false, deleted: false, compare: 'https://github.com/acme/web/compare/aaaaaaa...bbbbbbb',
    repository: { full_name: 'acme/web', html_url: 'https://github.com/acme/web' }, sender: { login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4' },
    commits: [{ id: 'b'.repeat(40), message: 'Fix the login page\n\nIt was broken.', author: { name: 'The Octocat', username: 'octocat' }, url: 'https://github.com/acme/web/commit/bbbb' }],
  };
  assert.equal((await hook(`${w.path}/github`, { json: push, headers: { 'x-github-event': 'push', 'x-github-delivery': crypto.randomUUID() } })).status, 204);
  m = (await history(ci.id)).at(-1);
  assert.equal(m.content, '**[acme/web:main] 1 new commit** (by octocat)\nhttps://github.com/acme/web/compare/aaaaaaa...bbbbbbb\n`bbbbbbb` Fix the login page \u2014 The Octocat');
  assert.equal(m.webhook.avatar, 'https://avatars.githubusercontent.com/u/583231?v=4');
  // …a pull request…
  const pr = { action: 'opened', number: 7, pull_request: { number: 7, title: 'Add dark mode', html_url: 'https://github.com/acme/web/pull/7', body: 'Closes #3', merged: false }, repository: { full_name: 'acme/web' }, sender: { login: 'octocat' } };
  assert.equal((await hook(`${w.path}/github`, { json: pr, headers: { 'x-github-event': 'pull_request' } })).status, 204);
  assert.equal((await history(ci.id)).at(-1).content, '**[acme/web] Pull request opened: #7 Add dark mode** (by octocat)\nhttps://github.com/acme/web/pull/7\nCloses #3');
  // …and the ping GitHub sends first, which shows nothing.
  const before = srv.sql('SELECT COUNT(*) n FROM messages WHERE channel_id = ?', ci.id)[0].n;
  assert.equal((await hook(`${w.path}/github`, { json: { zen: 'Keep it logically awesome.', hook_id: 1 }, headers: { 'x-github-event': 'ping' } })).status, 204);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE channel_id = ?', ci.id)[0].n, before);
});

// ------------------------------------------------------------------ refusals
test('a wrong id and a wrong secret get the same 404; bad payloads get Discord’s error codes', async () => {
  const w = await makeHook(await channel('strict'), 'Strict');
  const unknown = { message: 'Unknown Webhook', code: 10015 };
  const other = crypto.randomBytes(32).toString('base64url');
  for (const p of [`/api/webhooks/${w.id}/${other}`, `/api/webhooks/0mv2sowmv55f9a68b0b/${w.token}`, `/api/webhooks/${w.id}/short`, `/api/webhooks/${w.id}/${w.token}x`, `/api/webhooks/!!/${w.token}`]) {
    const r = await hook(p, { json: { content: 'hi' } });
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.json, unknown, p);
  }
  assert.deepEqual((await hook(`/api/webhooks/${w.id}/${other}`, { method: 'GET' })).json, unknown);

  const bad = async (opts, status, code) => {
    const r = await hook(w.path, opts);
    assert.equal(r.status, status, r.text);
    assert.equal(r.json.code, code, r.text);
    return r.json;
  };
  await bad({ raw: '{"content": "unterminated', type: 'application/json' }, 400, 50109);
  await bad({ json: {} }, 400, 50006);
  await bad({ json: { content: '   ' } }, 400, 50006);
  await bad({ raw: '', type: 'application/json' }, 400, 50006);
  const long = await bad({ json: { content: 'x'.repeat(2001) } }, 400, 50035);
  assert.equal(long.errors.content._errors[0].code, 'BASE_TYPE_MAX_LENGTH');
  const tooMany = await bad({ json: { embeds: Array.from({ length: 11 }, () => ({ title: 'x' })) } }, 400, 50035);
  assert.ok(tooMany.errors.embeds);
  const fields = await bad({ json: { embeds: [{ fields: Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' })) }] } }, 400, 50035);
  assert.ok(fields.errors.embeds[0].fields);
  const typed = await bad({ json: { embeds: [{ title: 'ok', fields: [{ name: 'a', value: { not: 'text' } }] }] } }, 400, 50035);
  assert.equal(typed.errors.embeds[0].fields[0].value._errors[0].code, 'BASE_TYPE_STRING');
  await bad({ json: { embeds: [{ description: 'x'.repeat(4000) }, { description: 'y'.repeat(2500) }] } }, 400, 50035);
  await bad({ json: [1, 2, 3] }, 400, 50035);
  await bad({ raw: '--x\r\nContent-Disposition: form-data; name="content"\r\n\r\nhi\r\n--x--', type: 'multipart/form-data; boundary=x' }, 400, 50109);
  // 64 KB at most (checked as it streams in).
  const big = await hook(w.path, { raw: JSON.stringify({ content: 'x', pad: 'y'.repeat(70 * 1024) }), type: 'application/json' });
  assert.equal(big.status, 413);
  assert.deepEqual(big.json, { message: 'Request entity too large', code: 40005 });
  // The instance's word filter applies (to the name too).
  assert.equal((await as(srv.owner, 'PUT', '/admin/words', { words: ['frobnicate'] })).status, 200);
  await bad({ json: { content: 'please frobnicate now' } }, 400, 200000);
  await bad({ json: { content: 'fine', username: 'Frobnicate bot' } }, 400, 200000);
  assert.equal((await as(srv.owner, 'PUT', '/admin/words', { words: [] })).status, 200);
  assert.equal((await hook(w.path, { json: { content: 'please frobnicate now' } })).status, 204);
});

test('pings: off by default (everyone, here, roles and names are defused); turning them on needs Mention Everyone', async () => {
  const w = await makeHook(general, 'Pager', { by: carol });
  const text = '@everyone @here server down, @bob look <@&' + modsRole.id + '> please';
  assert.equal((await hook(w.path, { json: { content: text } })).status, 204);
  let row = lastMessage(general.id);
  let m = (await history(general.id)).find((x) => x.id === row.id);
  assert.equal(m.content, `@${ZW}everyone @${ZW}here server down, @${ZW}bob look @${ZW}Mods please`);
  assert.equal(m.webhook.pings, false);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM mention_marks WHERE message_id = ?', row.id)[0].n, 0, 'nobody counted as mentioned');
  // Links with @ in them are left alone (only an @ starting a word is a mention).
  assert.equal((await hook(w.path, { json: { content: 'profile: https://social.example/@bob and mail ops@example.com' } })).status, 204);
  assert.equal((await history(general.id)).at(-1).content, 'profile: https://social.example/@bob and mail ops@example.com');

  // carol manages the channel but may not mention everyone: she can't let it ping.
  assert.equal((await as(carol, 'PATCH', `/channels/${general.id}/webhooks/${w.id}`, { allowMentions: true })).status, 403);
  assert.equal((await as(carol, 'POST', `/channels/${general.id}/webhooks`, { name: 'Loud', allowMentions: true })).status, 403);
  // The owner can.
  const on = await as(alice, 'PATCH', `/channels/${general.id}/webhooks/${w.id}`, { allowMentions: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.webhook.allowMentions, true);
  assert.ok(srv.sql("SELECT detail FROM admin_log WHERE action = 'webhook_changed'").some((a) => a.detail.includes('may ping')));
  assert.equal((await hook(w.path, { json: { content: text } })).status, 204);
  row = lastMessage(general.id);
  m = (await history(general.id)).find((x) => x.id === row.id);
  assert.equal(m.content, text);
  assert.equal(m.webhook.pings, true);
  const marks = srv.sql('SELECT user_id FROM mention_marks WHERE message_id = ?', row.id).map((r) => r.user_id).sort();
  assert.deepEqual(marks, ['*', bob.id, carol.id].sort(), 'everyone, bob by name, carol by role');
  // allowed_mentions narrows it, as on Discord.
  assert.equal((await hook(w.path, { json: { content: '@everyone and @bob', allowed_mentions: { parse: ['users'] } } })).status, 204);
  row = lastMessage(general.id);
  assert.equal((await history(general.id)).find((x) => x.id === row.id).content, `@${ZW}everyone and @bob`);
  assert.deepEqual(srv.sql('SELECT user_id FROM mention_marks WHERE message_id = ?', row.id).map((r) => r.user_id), [bob.id]);

  // A new secret for a webhook that may ping would hand carol pings she doesn't have.
  assert.equal((await as(carol, 'POST', `/channels/${general.id}/webhooks/${w.id}/token`)).status, 403);
  // Taking pings away is always allowed; then she can re-key it.
  assert.equal((await as(carol, 'PATCH', `/channels/${general.id}/webhooks/${w.id}`, { allowMentions: false })).status, 200);
  assert.equal((await as(carol, 'POST', `/channels/${general.id}/webhooks/${w.id}/token`)).status, 200);
});

test('the display name override is cleaned and capped; avatar_url is never fetched; markup stays text', async () => {
  const w = await makeHook(alerts, 'Names');
  // A local server counting requests: nothing must reach it when a post names it as the avatar.
  let hits = 0;
  const pics = http.createServer((req, res) => { hits++; res.end(); });
  await new Promise((r) => pics.listen(0, '127.0.0.1', r));
  try {
    const avatar = `https://127.0.0.1:${pics.address().port}/a.png`;
    const name = `  Ad\u202emin\u200b\u0000 ${'Z\u0301\u0302\u0303\u0304'.repeat(3)} with a very long name indeed  `;
    assert.equal((await hook(w.path, { json: { content: '<img src=x onerror=alert(1)> **hi**', username: name, avatar_url: avatar } })).status, 204);
    const m = (await history(alerts.id)).at(-1);
    // NFC first (Z with an acute is one letter), then at most two marks on top of it; 32 characters in all.
    assert.equal(m.webhook.name, `Admin ${'\u0179\u0302\u0303'.repeat(3)} with a very long`);
    assert.ok([...m.webhook.name].length <= 32);
    assert.equal(m.webhook.avatar, avatar, 'kept as a link for the app');
    assert.equal(m.content, '<img src=x onerror=alert(1)> **hi**', 'stored as text; the app’s Markdown escapes it');
    await sleep(300);
    assert.equal(hits, 0, 'the server never fetched the avatar');
    // Only https pictures are kept; an empty name falls back to the webhook's own.
    assert.equal((await hook(w.path, { json: { content: 'x', username: '\u200b\u200b', avatar_url: 'http://example.com/a.png' } })).status, 204);
    const m2 = (await history(alerts.id)).at(-1);
    assert.equal(m2.webhook.name, null);
    assert.equal(m2.webhook.avatar, null);
    assert.equal((await hook(w.path, { json: { content: 'x', username: 'y'.repeat(81) } })).status, 400, 'Discord’s 80-character limit');
  } finally { pics.close(); }
});

// ------------------------------------------------------------------ limits
test('rate limits: per webhook, per channel, and wrong secrets per address', async () => {
  const busy = await channel('busy');
  const w = await makeHook(busy, 'Flood');
  const ip = newIp();
  for (let i = 0; i < 5; i++) assert.equal((await hook(w.path, { json: { content: `n${i}` }, ip, retry: false })).status, 204);
  const r = await hook(w.path, { json: { content: 'one too many' }, ip, retry: false });
  assert.equal(r.status, 429);
  assert.equal(r.json.message, 'You are being rate limited.');
  assert.equal(r.json.global, false);
  assert.ok(r.json.retry_after > 0 && Number(r.headers.get('retry-after')) > 0);
  // 30 a minute per channel, whichever webhooks they come from.
  const more = [];
  for (let i = 0; i < 6; i++) more.push(await makeHook(busy, `Flood ${i}`, { by: i % 2 ? dave : alice }));
  let ok = 5; let limited = 0;
  for (const x of more) {
    for (let i = 0; i < 5; i++) {
      const s = (await hook(x.path, { json: { content: 'x' }, retry: false })).status;
      if (s === 204) ok++; else if (s === 429) limited++;
    }
  }
  assert.equal(ok, 30);
  assert.equal(limited, 5);
  // Guessing secrets: 30 wrong a minute per address, then 429 (other addresses are unaffected).
  const guesser = newIp();
  let statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await hook(`/api/webhooks/${w.id}/${crypto.randomBytes(32).toString('base64url')}`, { json: { content: 'x' }, ip: guesser, retry: false })).status);
  assert.equal(statuses.filter((s) => s === 404).length, 30);
  assert.equal(statuses.at(-1), 429);
  statuses = [(await hook(`/api/webhooks/${w.id}/${crypto.randomBytes(32).toString('base64url')}`, { json: { content: 'x' } })).status];
  assert.deepEqual(statuses, [404]);
  // Up to 10 per channel.
  for (let i = more.length + 1; i < 10; i++) await makeHook(busy, `Fill ${i}`, { by: dave });
  const full = await as(dave, 'POST', `/channels/${busy.id}/webhooks`, { name: 'Eleventh' });
  assert.equal(full.status, 400);
  assert.match(full.json.error, /up to 10/);
});

// ------------------------------------------------------------------ managing
test('rename, rotate and delete: live updates for the people managing it, the old address dies, posts keep their author', async () => {
  const w = await makeHook(general, 'Deploys');
  const sa = await sock(alice); const sb = await sock(bob);
  const aliceHooks = collect(sa, 'webhooks:update'); const bobHooks = collect(sb, 'webhooks:update');
  const bobUsers = collect(sb, 'user:update');
  // Members without the permission can't touch it; strangers can't see it.
  for (const [method, p, body] of [['PATCH', `/channels/${general.id}/webhooks/${w.id}`, { name: 'Mine' }], ['POST', `/channels/${general.id}/webhooks/${w.id}/token`], ['DELETE', `/channels/${general.id}/webhooks/${w.id}`]]) {
    assert.equal((await as(bob, method, p, body)).status, 403, `${method} ${p}`);
    assert.equal((await as(eve, method, p, body)).status, 404, `${method} ${p}`);
  }
  // A webhook is managed in its own channel only.
  assert.equal((await as(alice, 'PATCH', `/channels/${alerts.id}/webhooks/${w.id}`, { name: 'Moved' })).status, 404);

  const ren = await as(alice, 'PATCH', `/channels/${general.id}/webhooks/${w.id}`, { name: 'Deploy bot' });
  assert.equal(ren.status, 200, ren.text);
  assert.equal(ren.json.webhook.name, 'Deploy bot');
  assert.equal(JSON.parse(srv.sql('SELECT profile FROM users WHERE id = ?', w.userId)[0].profile).displayName, 'Deploy bot');
  assert.ok(await until(() => bobUsers.find((u) => u.id === w.userId && u.profile.displayName === 'Deploy bot')), 'readers see the new name');
  assert.ok(await until(() => aliceHooks.find((x) => x.channelId === general.id)), 'managers’ open panels refresh');

  assert.equal((await hook(w.path, { json: { content: 'before the rotation' } })).status, 204);
  const posted = lastMessage(general.id);
  const rot = await as(alice, 'POST', `/channels/${general.id}/webhooks/${w.id}/token`);
  assert.equal(rot.status, 200, rot.text);
  assert.notEqual(rot.json.token, w.token);
  assert.equal((await hook(w.path, { json: { content: 'old address' } })).status, 404);
  assert.equal((await hook(rot.json.path, { json: { content: 'new address' } })).status, 204);
  assert.ok(srv.sql("SELECT detail FROM admin_log WHERE action = 'webhook_token_rotated'").some((a) => a.detail.includes(w.id) && !a.detail.includes(rot.json.token)));

  const del = await as(alice, 'DELETE', `/channels/${general.id}/webhooks/${w.id}`);
  assert.equal(del.status, 200);
  assert.equal((await hook(rot.json.path, { json: { content: 'after delete' } })).status, 404);
  // Its posts are still there, so the row stays as a tombstone (with a secret nobody has) and its account is
  // marked deleted, keeping its name for those posts.
  const tomb = srv.sql('SELECT * FROM channel_webhooks WHERE id = ?', w.id)[0];
  assert.ok(tomb.deleted_at > 0);
  assert.notEqual(tomb.token_hash, crypto.createHash('sha256').update(`${w.id}.${rot.json.token}`).digest('hex'));
  const acct = srv.sql('SELECT * FROM users WHERE id = ?', w.userId)[0];
  assert.ok(acct.deleted_at > 0, 'its account is retired');
  assert.equal(JSON.parse(acct.profile).displayName, 'Deploy bot', 'and still named, for its posts');
  assert.equal(srv.sql('SELECT author_id FROM messages WHERE id = ?', posted.id)[0].author_id, w.userId, 'old posts keep their author');
  assert.ok(srv.sql("SELECT detail FROM admin_log WHERE action = 'webhook_deleted'").some((a) => a.detail.includes(w.id)));
  assert.ok(!(await as(alice, 'GET', `/channels/${general.id}/webhooks`)).json.webhooks.some((x) => x.id === w.id));
  assert.equal(bobHooks.length, 0, 'people who can’t manage webhooks aren’t told about them');
});

// Nothing of a webhook's account is shown once no post of it is left: it's wiped like a deleted person's account.
const wiped = (userId) => {
  const u = srv.sql('SELECT * FROM users WHERE id = ?', userId)[0];
  return u.deleted_at > 0 && /^deleted-[0-9a-f]{12}$/.test(u.username) && JSON.parse(u.profile).displayName === 'Deleted webhook';
};
test('deleting the channel or the whole server takes its webhooks with it, and wipes their accounts', async () => {
  const doomed = (await as(alice, 'POST', `/servers/${space.id}/channels`, { name: 'doomed', type: 'text' })).json;
  const w = await makeHook(doomed, 'Gone soon');
  assert.equal((await hook(w.path, { json: { content: 'posted once' } })).status, 204);
  // Deleted first (its post stays, so it's a tombstone), then its channel: no post is left, so its account goes too.
  const early = await makeHook(doomed, 'Deleted early');
  assert.equal((await hook(early.path, { json: { content: 'me too' } })).status, 204);
  assert.equal((await as(alice, 'DELETE', `/channels/${doomed.id}/webhooks/${early.id}`)).status, 200);
  assert.ok(!wiped(early.userId), 'kept while its post is there');
  assert.equal((await as(alice, 'DELETE', `/channels/${doomed.id}`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM channel_webhooks WHERE channel_id = ?', doomed.id)[0].n, 0);
  assert.ok(wiped(w.userId), JSON.stringify(srv.sql('SELECT * FROM users WHERE id = ?', w.userId)));
  assert.ok(wiped(early.userId));
  assert.equal((await hook(w.path, { json: { content: 'x' } })).status, 404);
  const gone = await as(bob, 'GET', `/users/${w.userId}`);
  assert.ok(!gone.text.includes('Gone soon') && !gone.text.includes('gone_soon'), gone.text);

  const other = (await as(alice, 'POST', '/servers', { name: 'Short lived' })).json;
  const ch = other.channels.find((c) => c.type === 'text');
  const w2 = await makeHook(ch, 'Also gone');
  const w3 = await makeHook(ch, 'Never posted');
  assert.equal((await hook(w2.path, { json: { content: 'still here' } })).status, 204);
  const r = await srv.api('DELETE', `/servers/${other.id}`, { token: alice.token, ip: alice.ip, body: { authKey: alice.authKey } });
  assert.equal(r.status, 200, r.text);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM channel_webhooks WHERE server_id = ?', other.id)[0].n, 0);
  assert.ok(wiped(w2.userId));
  assert.ok(wiped(w3.userId));
  assert.equal((await hook(w2.path, { json: { content: 'x' } })).status, 404);
});

test('a suspended maker pauses their webhooks; IP bans and maintenance apply', async () => {
  const w = await makeHook(alerts, 'Carol’s', { by: carol });
  assert.equal((await as(srv.owner, 'POST', `/admin/users/${carol.id}/suspend`, { reason: 'spam' })).status, 200);
  const r = await hook(w.path, { json: { content: 'x' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 50001);
  assert.equal((await as(srv.owner, 'POST', `/admin/users/${carol.id}/unsuspend`)).status, 200);
  assert.equal((await hook(w.path, { json: { content: 'back' } })).status, 204);
  carol.token = (await srv.login(carol)).json.token; // suspension signed her out

  const banned = '203.0.113.99';
  assert.equal((await as(srv.owner, 'POST', '/admin/ip-bans', { ip: banned, reason: 'test' })).status, 200);
  assert.equal((await hook(w.path, { json: { content: 'x' }, ip: banned })).status, 403);
  assert.equal((await hook(w.path, { json: { content: 'other address' } })).status, 204);
  assert.equal((await as(srv.owner, 'DELETE', '/admin/ip-bans', { ip: banned })).status, 200);

  assert.equal((await as(srv.owner, 'PUT', '/admin/maintenance', { text: 'Upgrading' })).status, 200);
  assert.equal((await hook(w.path, { json: { content: 'x' } })).status, 503);
  assert.equal((await as(srv.owner, 'PUT', '/admin/maintenance', { text: '' })).status, 200);
  assert.equal((await hook(w.path, { json: { content: 'after maintenance' } })).status, 204);
});

test('a webhook outlives its maker leaving the server, and the list says so', async () => {
  const frank = await srv.register('frank');
  const { code } = (await as(alice, 'POST', `/servers/${space.id}/invites`, {})).json;
  assert.equal((await as(frank, 'POST', `/invites/${code}/join`)).status, 200);
  const admins = srv.sql("SELECT id FROM roles WHERE server_id = ? AND name = 'Admins'", space.id)[0];
  assert.equal((await as(alice, 'PUT', `/servers/${space.id}/members/${frank.id}/roles`, { roleIds: [admins.id] })).status, 200);
  const w = await makeHook(alerts, 'Frank’s cron', { by: frank });
  let mine = (await as(alice, 'GET', `/channels/${alerts.id}/webhooks`)).json.webhooks.find((x) => x.id === w.id);
  assert.equal(mine.makerHere, true);
  assert.equal(mine.createdByName, 'frank');
  assert.equal((await as(frank, 'POST', `/servers/${space.id}/leave`)).status, 200);
  assert.equal((await hook(w.path, { json: { content: 'still running' } })).status, 204);
  mine = (await as(alice, 'GET', `/channels/${alerts.id}/webhooks`)).json.webhooks.find((x) => x.id === w.id);
  assert.equal(mine.makerHere, false);
  // And frank, no longer a member, can't manage it.
  assert.equal((await as(frank, 'DELETE', `/channels/${alerts.id}/webhooks/${w.id}`)).status, 404);
});

test('other JSON routes still parse JSON; the webhook body reader covers any capitalisation of its path', async () => {
  const r = await as(alice, 'PATCH', `/channels/${alerts.id}`, { topic: 'Where alerts land' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.topic, 'Where alerts land');
  const w = await makeHook(alerts, 'Caps');
  const shout = await hook(w.path.replace('/api/webhooks/', '/API/Webhooks/'), { json: { content: 'a shouty path' } });
  assert.equal(shout.status, 204, shout.text);
  assert.equal((await history(alerts.id)).at(-1).content, 'a shouty path');
});

// ------------------------------------------------------------------ requests already on their way
test('a request already on its way follows the rules as they are when its body arrives: new address, pings off, deleted', async () => {
  const room = await channel('inflight');
  const w = await makeHook(room, 'Slow', { allowMentions: true });
  // Sent with an address that's replaced before the body is in: refused like any wrong address.
  const a = held(w.path, { content: 'sent with the old address' });
  await sleep(300);
  const rot = await as(alice, 'POST', `/channels/${room.id}/webhooks/${w.id}/token`);
  assert.equal(rot.status, 200, rot.text);
  const r1 = await a.finish();
  assert.equal(r1.status, 404, r1.text);
  assert.deepEqual(r1.json, { message: 'Unknown Webhook', code: 10015 });
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE channel_id = ?', room.id)[0].n, 0, 'nothing posted');
  // Pings turned off while an @everyone is on its way: it lands defused, and nobody is counted as mentioned.
  const b = held(rot.json.path, { content: '@everyone it is down' });
  await sleep(300);
  assert.equal((await as(alice, 'PATCH', `/channels/${room.id}/webhooks/${w.id}`, { allowMentions: false })).status, 200);
  const r2 = await b.finish();
  assert.equal(r2.status, 204, r2.text);
  const row = lastMessage(room.id);
  const m = (await history(room.id)).find((x) => x.id === row.id);
  assert.equal(m.content, `@${ZW}everyone it is down`);
  assert.equal(m.webhook.pings, false);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM mention_marks WHERE message_id = ?', row.id)[0].n, 0);
  // Deleted while a post is on its way: refused.
  const c = held(rot.json.path, { content: 'after the delete' });
  await sleep(300);
  assert.equal((await as(alice, 'DELETE', `/channels/${room.id}/webhooks/${w.id}`)).status, 200);
  const r3 = await c.finish();
  assert.equal(r3.status, 404, r3.text);
  assert.equal(lastMessage(room.id).id, row.id, 'nothing posted after the delete');
  // A body that never arrives gets a 408 once the deadline passes, instead of holding the request open for minutes.
  const w2 = await makeHook(room, 'Stalled');
  const t0 = Date.now();
  const r4 = await held(w2.path, { content: 'never sent' }).done;
  assert.equal(r4.status, 408, JSON.stringify(r4));
  assert.ok(Date.now() - t0 >= BODY_MS - 200 && Date.now() - t0 < BODY_MS + 5000, `${Date.now() - t0} ms`);
});

// ------------------------------------------------------------------ pushes
test('pushes: "All messages" hears webhook posts whether or not they may ping; mentions push only from one that may', async () => {
  const ivy = await member('ivy');
  await subscribe(ivy);
  const room = await channel('pager');
  const quiet = await makeHook(room, 'Quiet', { by: dave });
  const loud = await makeHook(room, 'Loud', { by: alice, allowMentions: true });
  // Default (mentions only): a pings-off @ivy pushes nothing, an allowed one does.
  const handle = srv.sql('SELECT username FROM users WHERE id = ?', ivy.id)[0].username;
  assert.equal((await hook(quiet.path, { json: { content: `@${handle} the disk is full` } })).status, 204);
  await settle(ivy, 1);
  assert.equal(got(ivy).length, 0, 'a webhook that may not ping pushes no mention');
  assert.equal((await hook(loud.path, { json: { content: `@${handle} the disk is full` } })).status, 204);
  await settle(ivy, 1);
  assert.equal(got(ivy).length, 1, 'one that may ping does');
  // "All messages" on the channel: plain posts push too, from either webhook (an Uptime Kuma alert on a phone).
  assert.equal((await as(ivy, 'PUT', `/me/notify/c:${room.id}`, { level: 'all' })).status, 200);
  assert.equal((await hook(quiet.path, { json: { username: 'Uptime Kuma', embeds: [{ title: 'Your service My API went down.', color: 16711680 }] } })).status, 204);
  await settle(ivy, 2);
  assert.equal(got(ivy).length, 2);
  assert.equal((await hook(loud.path, { json: { content: 'deploy finished' } })).status, 204);
  await settle(ivy, 3);
  assert.equal(got(ivy).length, 3);
  for (const p of got(ivy)) assert.equal(p.undecryptable, undefined);
  // Someone who can't see the channel hears nothing, "All messages" on the server or not.
  const hidden = await channel('hidden-pager');
  assert.equal((await as(alice, 'PUT', `/channels/${hidden.id}/overrides`, { overrides: [{ type: 'role', id: space.id, allow: 0, deny: P.VIEW }, { type: 'member', id: dave.id, allow: P.VIEW, deny: 0 }] })).status, 200);
  const h = await makeHook(hidden, 'Hidden', { by: dave });
  assert.equal((await as(ivy, 'PUT', `/me/notify/s:${space.id}`, { level: 'all' })).status, 200);
  assert.equal((await hook(h.path, { json: { content: 'secret alert' } })).status, 204);
  await settle(ivy, 4);
  assert.equal(got(ivy).length, 3);
});

// ------------------------------------------------------------------ moderation reaches webhooks
test('Manage Channels doesn’t get around a read-only channel or a timeout: making, renaming and re-keying need Send Messages', async () => {
  const news = await channel('announcements');
  assert.equal((await as(alice, 'PUT', `/channels/${news.id}/overrides`, { overrides: [
    { type: 'role', id: space.id, allow: 0, deny: P.SEND }, { type: 'role', id: modsRole.id, allow: 0, deny: P.SEND }] })).status, 200);
  const made = await as(carol, 'POST', `/channels/${news.id}/webhooks`, { name: 'Fake news' });
  assert.equal(made.status, 403, made.text);
  assert.match(made.json.error, /send messages/);
  const list = await as(carol, 'GET', `/channels/${news.id}/webhooks`);
  assert.equal(list.status, 200, 'she can still see and manage the list');
  assert.equal(list.json.canPost, false);
  const owners = await makeHook(news, 'Announcements');
  assert.equal((await as(alice, 'GET', `/channels/${news.id}/webhooks`)).json.canPost, true, 'the owner can post anywhere');
  assert.equal((await hook(owners.path, { json: { content: 'real news' } })).status, 204);

  // carol's own webhook, then a timeout.
  const room = await channel('carols-room');
  const mine = await makeHook(room, 'Carol pager', { by: carol });
  assert.equal((await hook(mine.path, { json: { content: 'before' } })).status, 204);
  assert.equal((await as(alice, 'POST', `/servers/${space.id}/members/${carol.id}/timeout`, { minutes: 5 })).status, 200);
  const timedOut = await as(carol, 'POST', `/channels/${room.id}/webhooks`, { name: 'Totally not carol' });
  assert.equal(timedOut.status, 403);
  assert.match(timedOut.json.error, /timed out/);
  assert.equal((await as(carol, 'POST', `/channels/${room.id}/webhooks/${mine.id}/token`)).status, 403, 'no new address');
  assert.equal((await as(carol, 'PATCH', `/channels/${room.id}/webhooks/${mine.id}`, { name: 'Server Owner' })).status, 403, 'no new name');
  // The webhook whose address she made pauses while it lasts (she still knows the address).
  const paused = await hook(mine.path, { json: { content: 'while timed out' } });
  assert.equal(paused.status, 403);
  assert.equal(paused.json.code, 50001);
  assert.match((await as(alice, 'GET', `/channels/${room.id}/webhooks`)).json.webhooks.find((x) => x.id === mine.id).paused, /timed out/);
  assert.equal((await as(alice, 'DELETE', `/servers/${space.id}/members/${carol.id}/timeout`)).status, 200);
  assert.equal((await hook(mine.path, { json: { content: 'after' } })).status, 204);
  assert.equal((await as(carol, 'PATCH', `/channels/${room.id}/webhooks/${mine.id}`, { name: 'Carol pager 2' })).status, 200);
});

test('banning the person who made a webhook’s address pauses it; a new address from a manager makes it theirs and starts it again', async () => {
  const gina = await member('gina');
  assert.equal((await as(alice, 'PUT', `/servers/${space.id}/members/${gina.id}/roles`, { roleIds: [modsRole.id] })).status, 200);
  const room = await channel('gina-feed');
  const w = await makeHook(room, 'Gina feed', { by: gina });
  assert.equal((await hook(w.path, { json: { content: 'hello' } })).status, 204);
  assert.equal((await as(alice, 'POST', `/servers/${space.id}/bans`, { userId: gina.id, reason: 'spam' })).status, 200);
  const r = await hook(w.path, { json: { content: 'from a banned person' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 50001);
  const row = (await as(alice, 'GET', `/channels/${room.id}/webhooks`)).json.webhooks.find((x) => x.id === w.id);
  assert.match(row.paused, /banned/);
  assert.equal(row.makerHere, false);
  assert.equal(row.canChange, true, 'she isn’t in the server any more, so anyone managing it can take it over');
  const rot = await as(alice, 'POST', `/channels/${room.id}/webhooks/${w.id}/token`);
  assert.equal(rot.status, 200, rot.text);
  assert.equal(rot.json.webhook.createdBy, alice.id);
  assert.equal(rot.json.webhook.paused, null);
  assert.equal((await hook(rot.json.path, { json: { content: 'back' } })).status, 204);
  assert.equal((await hook(w.path, { json: { content: 'old address' } })).status, 404);
  assert.ok(srv.sql("SELECT detail FROM admin_log WHERE action = 'webhook_token_rotated'").some((a) => a.detail.includes(w.id) && a.detail.includes(gina.username)));
});

test('role order: a webhook can be changed by whoever made its address or someone above them, not below', async () => {
  const room = await channel('role-order');
  const high = await makeHook(room, 'Dave feed', { by: dave }); // Admins sits above Mods
  for (const [method, p, body] of [['PATCH', `/channels/${room.id}/webhooks/${high.id}`, { name: 'Server Owner' }], ['PATCH', `/channels/${room.id}/webhooks/${high.id}`, { allowMentions: false }],
    ['POST', `/channels/${room.id}/webhooks/${high.id}/token`], ['DELETE', `/channels/${room.id}/webhooks/${high.id}`]]) {
    const r = await as(carol, method, p, body);
    assert.equal(r.status, 403, `${method} ${p} ${r.text}`);
    assert.match(r.json.error, /highest role/);
  }
  assert.equal((await hook(high.path, { json: { content: 'still dave’s' } })).status, 204, 'carol couldn’t take it over');
  const low = await makeHook(room, 'Carol feed', { by: carol });
  const seen = (await as(carol, 'GET', `/channels/${room.id}/webhooks`)).json.webhooks;
  assert.equal(seen.find((x) => x.id === high.id).canChange, false);
  assert.equal(seen.find((x) => x.id === low.id).canChange, true);
  // dave is above carol: his new address makes hers his, and then she can't change it.
  const rot = await as(dave, 'POST', `/channels/${room.id}/webhooks/${low.id}/token`);
  assert.equal(rot.status, 200, rot.text);
  assert.equal(rot.json.webhook.createdBy, dave.id);
  assert.equal((await as(carol, 'POST', `/channels/${room.id}/webhooks/${low.id}/token`)).status, 403);
  assert.equal((await as(alice, 'DELETE', `/channels/${room.id}/webhooks/${low.id}`)).status, 200, 'the owner is above everyone');
});

test('suspending a webhook’s own account pauses it, and the admin’s page for that account says whose address it is', async () => {
  const room = await channel('reported');
  const w = await makeHook(room, 'Spammy', { by: carol });
  assert.equal((await hook(w.path, { json: { content: 'buy now' } })).status, 204);
  const info = await as(srv.owner, 'GET', `/admin/users/${w.userId}`);
  assert.equal(info.status, 200, info.text);
  assert.equal(info.json.webhook.name, 'Spammy');
  assert.equal(info.json.webhook.channel, 'reported');
  assert.equal(info.json.webhook.madeBy.id, carol.id);
  assert.equal((await as(srv.owner, 'POST', `/admin/users/${w.userId}/suspend`, { reason: 'spam' })).status, 200);
  const r = await hook(w.path, { json: { content: 'buy more' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 50001);
  assert.match((await as(alice, 'GET', `/channels/${room.id}/webhooks`)).json.webhooks.find((x) => x.id === w.id).paused, /account is suspended/);
  assert.equal((await as(srv.owner, 'POST', `/admin/users/${w.userId}/unsuspend`)).status, 200);
  assert.equal((await hook(w.path, { json: { content: 'sorry' } })).status, 204);
});

test('webhook accounts stay out of the admin’s plain user list and counts; one with no post left is wiped', async () => {
  const mallory = await srv.register('mallory');
  const own = (await as(mallory, 'POST', '/servers', { name: 'Mallory land' })).json;
  const ch = own.channels.find((c) => c.type === 'text');
  const stats0 = (await as(srv.owner, 'GET', '/admin/stats')).json;
  const made = [];
  for (let i = 0; i < 4; i++) made.push(await makeHook(ch, `spam ${i}`, { by: mallory }));
  assert.equal((await hook(made[0].path, { json: { content: 'a post' } })).status, 204);
  const stats = (await as(srv.owner, 'GET', '/admin/stats')).json;
  assert.equal(stats.users, stats0.users, 'webhook accounts aren’t people');
  assert.equal(stats.newUsers24h, stats0.newUsers24h);
  const list = (await as(srv.owner, 'GET', '/admin/users')).json;
  assert.equal(list[0].id, mallory.id, 'the newest sign-up is still on top');
  assert.ok(!list.some((u) => made.some((w) => w.userId === u.id)), 'no webhook accounts in the plain list');
  const name = srv.sql('SELECT username FROM users WHERE id = ?', made[1].userId)[0].username;
  const found = (await as(srv.owner, 'GET', `/admin/users?q=${encodeURIComponent(name)}`)).json;
  assert.equal(found.length, 1);
  assert.equal(found[0].bot, true, 'searching finds them, marked as bots');
  // Deleted without ever posting: the row goes and the account is wiped (its username is free again).
  assert.equal((await as(mallory, 'DELETE', `/channels/${ch.id}/webhooks/${made[1].id}`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM channel_webhooks WHERE id = ?', made[1].id)[0].n, 0);
  assert.ok(wiped(made[1].userId));
  assert.equal(srv.sql('SELECT COUNT(*) n FROM users WHERE lower(username) = ?', name)[0].n, 0);
  const pub = await as(mallory, 'GET', `/users/${made[1].userId}`);
  assert.ok(!pub.text.includes('spam 1') && !pub.text.includes('A webhook:'), pub.text);
  // With a post left, a tombstone keeps its author until the post goes (here: with the server).
  assert.equal((await as(mallory, 'DELETE', `/channels/${ch.id}/webhooks/${made[0].id}`)).status, 200);
  assert.ok(!wiped(made[0].userId));
  assert.equal((await srv.api('DELETE', `/servers/${own.id}`, { token: mallory.token, ip: mallory.ip, body: { authKey: mallory.authKey } })).status, 200);
  for (const w of made) assert.ok(wiped(w.userId), w.name);
});

// ------------------------------------------------------------------ more of what programs send
test('Slack: rich text (what Slack’s composer and Block Kit Builder make) is shown, and text stands in when no block is', async () => {
  const room = await channel('slack-rich');
  const w = await makeHook(room, 'Slack tools', { by: dave });
  // Only blocks Hearth doesn't show: the text is the fallback, as in Slack's notifications.
  const fb = await hook(`${w.path}/slack`, { json: { text: 'Deploy of web finished', blocks: [{ type: 'divider' }, { type: 'image', image_url: 'https://example.com/a.png', alt_text: 'chart' }] } });
  assert.equal(fb.status, 204, fb.text);
  assert.equal((await history(room.id)).at(-1).content, 'Deploy of web finished');
  // Rich text.
  const rich = { text: 'Deploy of web finished', blocks: [{ type: 'rich_text', elements: [
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'Deploy of ' }, { type: 'text', text: 'web', style: { bold: true } }, { type: 'text', text: ' finished ' }, { type: 'emoji', name: 'white_check_mark', unicode: '2705' }] },
    { type: 'rich_text_list', style: 'bullet', elements: [
      { type: 'rich_text_section', elements: [{ type: 'link', url: 'https://ci.example.com/run/42', text: 'run 42' }] },
      { type: 'rich_text_section', elements: [{ type: 'text', text: '312 tests', style: { code: true } }, { type: 'text', text: ' passed' }] }] },
    { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'npm test\nok' }] },
    { type: 'rich_text_quote', elements: [{ type: 'broadcast', range: 'here' }, { type: 'text', text: ' heads up', style: { italic: true } }] }] }] };
  assert.equal((await hook(`${w.path}/slack`, { json: rich })).status, 204);
  assert.equal((await history(room.id)).at(-1).content, [
    'Deploy of **web** finished ✅', '- run 42 (https://ci.example.com/run/42)', '- `312 tests` passed', '```', 'npm test', 'ok', '```', `> @${ZW}here *heads up*`].join('\n'));
  // Through the plain address too (Slack-style JSON is recognised by its fields).
  assert.equal((await hook(w.path, { json: { blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'plain address' }] }] }] } })).status, 204);
  assert.equal((await history(room.id)).at(-1).content, 'plain address');
});

test('a role named like a role mention can’t bring a ping back when mentions are defused', async () => {
  const oncall = (await as(alice, 'POST', `/servers/${space.id}/roles`, { name: 'oncall', mentionable: true })).json;
  const trick = (await as(alice, 'POST', `/servers/${space.id}/roles`, { name: `<@&${oncall.id}>` })).json;
  const room = await channel('tricky');
  const w = await makeHook(room, 'Trick', { by: dave });
  const r = await hook(`${w.path}?wait=true`, { json: { content: `<@&${trick.id}> look` } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.content, `@${ZW}${oncall.id} look`);
  assert.ok(!/<@&/.test(r.json.content));
});

test('an embed time with no time zone is UTC (Uptime Kuma’s format), whatever zone the server is in', () => {
  const { fromDiscord } = require('../server/webhooks').parse;
  const tz = process.env.TZ;
  try {
    for (const zone of ['Europe/Berlin', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = zone;
      assert.equal(fromDiscord({ embeds: [{ title: 't', timestamp: '2026-10-11 05:00:00.123' }] }).text, '**t**\n2026-10-11 05:00 UTC', zone);
      assert.equal(fromDiscord({ embeds: [{ title: 't', timestamp: '2026-10-11T05:00:00Z' }] }).text, '**t**\n2026-10-11 05:00 UTC', zone);
      assert.equal(fromDiscord({ embeds: [{ title: 't', timestamp: '2026-10-11T07:00:00+02:00' }] }).text, '**t**\n2026-10-11 05:00 UTC', zone);
    }
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});
