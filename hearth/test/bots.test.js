// The bot platform (server/bots.js): bot accounts, tokens, installs with scopes and channels, the bot API,
// signed webhooks with retries and dead letters, and slash commands. Webhooks go to a local HTTPS server with
// a throwaway certificate the Hearth under test is told to trust (NODE_EXTRA_CA_CERTS), so the https-only rule
// stays on; private addresses are allowed for it with the admin flag, and a second Hearth without the flag
// checks that they're refused. Nothing here touches the internet.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { startServer, hex, newIp, sleep } = require('./helpers');
const { verify } = require('../scripts/example-bot');

let srv; let alice; let bob; let mallory; let eve;
let space; let general; let secret; let other;
let hook; let certDir;
const A = {}; const B = {}; // the two main bots: { id, token, secret }
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const bot = (tok, method, p, body, ip = '203.0.113.7') => srv.api(method, '/bot/v1' + p, { headers: { authorization: `Bot ${tok}` }, body, ip });
const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 25) { const v = await fn(); if (v) return v; await sleep(25); } return null; };
const cipher = () => 'c2:' + crypto.randomBytes(48).toString('base64');
// Channel messages need a current server key; the server never opens them, so a stand-in epoch is enough here.
const keyReady = (sid) => srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', sid);
async function say(u, channelId, sid = space.id) {
  keyReady(sid);
  const r = await as(u, 'POST', `/channels/${channelId}/messages`, { ciphertext: cipher(), epoch: 1 });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

// ------------------------------------------------------------------ a local HTTPS server playing the bots' side
// Each bot gets a path (/hook/<name>); handlers[name] decides the answer (default 200).
function webhookServer(cert, key) {
  const hits = [];
  const handlers = {};
  let live = 0; const peak = {};
  const server = https.createServer({ cert, key }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const name = req.url.split('/')[2] || '';
      const raw = Buffer.concat(chunks);
      let json = null;
      try { json = JSON.parse(raw.toString('utf8')); } catch { /* not JSON */ }
      const hit = { name, headers: req.headers, raw, json, at: Date.now() };
      hits.push(hit);
      live++; peak[name] = Math.max(peak[name] || 0, live);
      try {
        const h = handlers[name];
        const status = h ? await h(hit) : 200;
        if (status === 'hang') return; // never answers
        res.writeHead(status || 200).end('{}');
      } finally { live--; }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, hits, handlers, peak, url: (name) => `https://127.0.0.1:${server.address().port}/hook/${name}`,
    of: (name, type) => hits.filter((x) => x.name === name && (!type || (x.json && x.json.type === type))),
  })));
}

async function makeBot(name, scopes, { by = srv.owner, listed = true, webhook = true } = {}) {
  const r = await as(by, 'POST', '/bots', { name, description: `${name} test bot`, scopes, listed, webhookUrl: webhook ? hook.url(name) : undefined });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.bot.id, token: r.json.token, secret: r.json.webhookSecret, name };
}
async function install(b, scopes, channels, { by = alice, sid = space.id } = {}) {
  const r = await as(by, 'POST', `/servers/${sid}/bots`, { botId: b.id, scopes, channels, confirm: true });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

before(async () => {
  // A throwaway certificate for 127.0.0.1 that only the Hearth under test trusts.
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  });
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bots-'));
  fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);
  hook = await webhookServer(pems.cert, pems.private);
  srv = await startServer({ NODE_EXTRA_CA_CERTS: path.join(certDir, 'cert.pem'), BOT_WEBHOOK_ALLOW_PRIVATE: '1', BOT_RETRY_BASE_MS: '40', BOT_WEBHOOK_TIMEOUT_MS: '1500', BOT_INTERACTION_TIMEOUT_MS: '1500' });
  alice = await srv.register('alice'); bob = await srv.register('bob'); mallory = await srv.register('mallory'); eve = await srv.register('eve');
  space = (await as(alice, 'POST', '/servers', { name: 'Alice HQ' })).json;
  general = space.channels.find((c) => c.type === 'text');
  secret = (await as(alice, 'POST', `/servers/${space.id}/channels`, { name: 'secret', type: 'text' })).json;
  assert.equal((await as(alice, 'PUT', `/channels/${secret.id}/overrides`, { overrides: [{ type: 'role', id: space.id, allow: 0, deny: 1 }] })).status, 200);
  const { code } = (await as(alice, 'POST', `/servers/${space.id}/invites`, {})).json;
  for (const u of [bob, mallory]) assert.equal((await as(u, 'POST', `/invites/${code}/join`)).status, 200);
  other = (await as(eve, 'POST', '/servers', { name: 'Eve place' })).json;
  Object.assign(A, await makeBot('alpha', ['messages.send', 'messages.read.metadata', 'channels.read', 'members.read', 'reactions.write', 'commands', 'webhooks.manage']));
  Object.assign(B, await makeBot('beta', ['messages.send', 'messages.read.metadata', 'channels.read']));
});
after(async () => {
  if (srv) await srv.stop();
  if (hook) hook.server.close();
  if (certDir) fs.rmSync(certDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ identities and tokens
test('creating a bot: the token and webhook secret are shown once, only a hash is kept, and it’s audit-logged without the token', async () => {
  assert.match(A.token, /^hb_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
  const secretPart = A.token.split('.')[1];
  const rows = srv.sql('SELECT * FROM bot_tokens WHERE bot_id = ?', A.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(A.token.slice(3)).digest('hex'));
  // Not in the database in any form people could use, nor in what the app gets back later.
  const dump = JSON.stringify([srv.sql('SELECT * FROM bot_tokens'), srv.sql('SELECT * FROM bots'), srv.sql('SELECT * FROM admin_log'), srv.sql('SELECT * FROM users WHERE is_bot = 1')]);
  assert.ok(!dump.includes(secretPart), 'token secret stored');
  assert.ok(!dump.includes(A.secret), 'webhook secret stored in the clear');
  const mine = await as(srv.owner, 'GET', '/bots');
  assert.equal(mine.status, 200);
  assert.ok(!mine.text.includes(secretPart) && !mine.text.includes(A.secret));
  assert.equal(mine.json.mine.find((b) => b.id === A.id).tokens.length, 1);
  const log = srv.sql("SELECT action, detail FROM admin_log WHERE target = ? AND action LIKE 'bot_%'", A.id).map((r) => r.action);
  assert.deepEqual(log, ['bot_created', 'bot_token_created']);
  // A bot account can never sign in.
  const u = srv.sql('SELECT * FROM users WHERE id = ?', A.id)[0];
  assert.equal(u.is_bot, 1);
  assert.equal((await srv.api('POST', '/auth/login', { body: { username: u.username, authKey: hex(32) }, ip: newIp() })).status, 401);
  assert.equal((await bot(A.token, 'GET', '/me')).json.id, A.id);
});

test('who may create bots is an instance setting (admins only by default)', async () => {
  const deny = await as(bob, 'POST', '/bots', { name: 'bobbot', scopes: [] });
  assert.equal(deny.status, 403);
  assert.equal((await as(bob, 'GET', '/bots')).json.canCreate, false);
  assert.equal((await as(srv.owner, 'PUT', '/admin/owner', { features: { createBots: 'everyone' } })).status, 200);
  const ok = await as(bob, 'POST', '/bots', { name: 'bobbot', scopes: [] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await as(srv.owner, 'PUT', '/admin/owner', { features: { createBots: 'admins' } })).status, 200);
  assert.equal((await as(bob, 'POST', '/bots', { name: 'bobbot2', scopes: [] })).status, 403);
  // Bob still manages the one he made, and nobody else can.
  assert.equal((await as(bob, 'PATCH', `/bots/${ok.json.bot.id}`, { description: 'mine' })).status, 200);
  assert.equal((await as(mallory, 'PATCH', `/bots/${ok.json.bot.id}`, { description: 'hijack' })).status, 404);
  assert.equal((await as(mallory, 'POST', `/bots/${ok.json.bot.id}/tokens`, { authKey: mallory.authKey })).status, 404);
});

test('wrong, malformed and missing tokens are 401; a token in the address is refused; errors are { error, code }', async () => {
  const [id] = A.token.slice(3).split('.');
  const wrong = `hb_${id}.${crypto.randomBytes(32).toString('base64url')}`;
  for (const [h, what] of [[undefined, 'none'], [`Bearer ${A.token}`, 'bearer'], [`Bot ${wrong}`, 'wrong secret'], ['Bot hb_nope', 'malformed'], [`Bot ${A.token}x`, 'too long']]) {
    const r = await srv.api('GET', '/bot/v1/me', { headers: h ? { authorization: h } : {}, ip: newIp() });
    assert.equal(r.status, 401, what);
    assert.equal(r.json.code, 'bad_token', what);
    assert.equal(typeof r.json.error, 'string');
  }
  // A person's session token isn't a bot token either.
  assert.equal((await srv.api('GET', '/bot/v1/me', { token: alice.token })).status, 401);
  for (const q of [`?token=${encodeURIComponent(A.token)}`, `?access_token=x`, `?q=${encodeURIComponent(A.token)}`]) {
    const r = await bot(A.token, 'GET', '/me' + q);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.code, 'token_in_url');
  }
  const nf = await bot(A.token, 'GET', '/nothing-here');
  assert.deepEqual([nf.status, nf.json.code], [404, 'not_found']);
});

test('rotating needs the password, swaps the token in one step, and is logged; revoked tokens stop at once', async () => {
  const b = await makeBot('rotor', ['messages.send']);
  assert.equal((await as(srv.owner, 'POST', `/bots/${b.id}/tokens`, { rotate: true })).status, 401, 'step-up');
  const r = await as(srv.owner, 'POST', `/bots/${b.id}/tokens`, { rotate: true, authKey: srv.owner.authKey });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.revoked, 1);
  assert.equal((await bot(b.token, 'GET', '/me')).status, 401, 'old token after rotation');
  assert.equal((await bot(r.json.token, 'GET', '/me')).status, 200);
  const extra = (await as(srv.owner, 'POST', `/bots/${b.id}/tokens`, { authKey: srv.owner.authKey })).json;
  assert.equal((await bot(extra.token, 'GET', '/me')).status, 200);
  assert.equal((await as(srv.owner, 'DELETE', `/bots/${b.id}/tokens/${extra.id}`)).status, 200);
  assert.equal((await bot(extra.token, 'GET', '/me')).status, 401, 'revoked');
  assert.equal((await bot(r.json.token, 'GET', '/me')).status, 200, 'the other one still works');
  const log = srv.sql("SELECT action, detail FROM admin_log WHERE target = ? AND action LIKE 'bot_token_%' ORDER BY id", b.id);
  assert.deepEqual(log.map((x) => x.action), ['bot_token_created', 'bot_token_rotated', 'bot_token_created', 'bot_token_revoked']);
  for (const t of [b.token, r.json.token, extra.token]) assert.ok(!JSON.stringify(log).includes(t.split('.')[1]));
});

// ------------------------------------------------------------------ installing
test('only the owner or Manage Server can install, after approving; scopes are limited to what the bot asks for', async () => {
  assert.equal((await as(mallory, 'POST', `/servers/${space.id}/bots`, { botId: A.id, scopes: [], channels: [], confirm: true })).status, 403);
  assert.equal((await as(eve, 'POST', `/servers/${space.id}/bots`, { botId: A.id, scopes: [], channels: [], confirm: true })).status, 404);
  assert.equal((await as(mallory, 'GET', `/servers/${space.id}/bots`)).status, 403);
  const noOk = await as(alice, 'POST', `/servers/${space.id}/bots`, { botId: A.id, scopes: ['messages.send'], channels: [general.id] });
  assert.deepEqual([noOk.status, noOk.json.code], [400, 'needs_approval']);
  const tooMuch = await as(alice, 'POST', `/servers/${space.id}/bots`, { botId: B.id, scopes: ['members.read'], channels: '*', confirm: true });
  assert.deepEqual([tooMuch.status, tooMuch.json.code], [400, 'bad_scopes']);
  assert.equal((await as(alice, 'POST', `/servers/${space.id}/bots`, { botId: B.id, scopes: ['admin'], channels: '*', confirm: true })).json.code, 'bad_scopes');
  // A channel from someone else's server can't go on the list.
  assert.equal((await as(alice, 'POST', `/servers/${space.id}/bots`, { botId: B.id, scopes: [], channels: [other.channels[0].id], confirm: true })).json.code, 'bad_channels');

  const before = hook.of('alpha', 'bot.installed').length;
  const inst = await install(A, ['messages.send', 'messages.read.metadata', 'reactions.write', 'commands', 'members.read', 'webhooks.manage'], [general.id]);
  A.inst = inst.id;
  assert.deepEqual(inst.scopes, ['messages.send', 'messages.read.metadata', 'members.read', 'reactions.write', 'commands', 'webhooks.manage']);
  assert.deepEqual(inst.pendingScopes, ['channels.read']);
  B.inst = (await install(B, ['messages.read.metadata'], '*')).id;
  assert.equal((await as(alice, 'POST', `/servers/${space.id}/bots`, { botId: A.id, scopes: [], channels: [], confirm: true })).status, 409);
  const ev = await until(() => hook.of('alpha', 'bot.installed')[before]);
  assert.ok(ev, 'bot.installed delivered');
  assert.deepEqual(ev.json.data.channelIds, [general.id]);
  // Members see the bots in the member list (as bots), and the news bot is listed as built in.
  const boot = (await as(bob, 'GET', '/bootstrap')).json;
  const s = boot.servers.find((x) => x.id === space.id);
  assert.ok(s.bots.includes(A.id) && s.bots.includes(B.id));
  assert.equal(boot.users[A.id].bot, true);
  assert.ok(!s.memberIds.includes(A.id), 'bots aren’t members (they never get the server key)');
  const list = (await as(alice, 'GET', `/servers/${space.id}/bots`)).json;
  assert.equal(list.builtIn[0].id, 'newsbot00000000000001');
  assert.equal(list.installed.length, 2);
  const audit = srv.sql("SELECT action FROM admin_log WHERE action = 'bot_installed' AND target = ?", space.id);
  assert.equal(audit.length, 2);
});

test('every scope and the channel allow-list are enforced on the bot API', async () => {
  // B has only messages.read.metadata.
  const deny = [
    ['POST', `/channels/${general.id}/messages`, { content: 'hi' }],
    ['GET', `/installations/${B.inst}/members`], ['GET', `/installations/${B.inst}/channels`],
    ['GET', `/installations/${B.inst}/deliveries`], ['PUT', `/installations/${B.inst}/events`, { events: null }],
  ];
  for (const [m, p, body] of deny) {
    const r = await bot(B.token, m, p, body);
    assert.deepEqual([r.status, r.json.code], [403, 'missing_scope'], `${m} ${p}`);
  }
  assert.equal((await bot(B.token, 'GET', `/channels/${general.id}/messages`)).status, 200);
  // A may post in #general only: not in the private channel, not in a server it isn't in.
  const inSecret = await bot(A.token, 'POST', `/channels/${secret.id}/messages`, { content: 'hi' });
  assert.deepEqual([inSecret.status, inSecret.json.code], [403, 'channel_not_allowed']);
  const elsewhere = await bot(A.token, 'POST', `/channels/${other.channels[0].id}/messages`, { content: 'hi' });
  assert.deepEqual([elsewhere.status, elsewhere.json.code], [404, 'not_installed']);
  assert.deepEqual([(await bot(A.token, 'GET', `/installations/${A.inst}/channels`)).status], [403], 'channels.read wasn’t granted');
  const members = (await bot(A.token, 'GET', `/installations/${A.inst}/members`)).json.members.map((m) => m.id).sort();
  assert.deepEqual(members, [alice.id, bob.id, mallory.id].sort());
  const installs = (await bot(A.token, 'GET', '/installations')).json.installations;
  assert.deepEqual(installs.map((i) => [i.serverId, i.channelIds]), [[space.id, [general.id]]]);
});

test('bot messages: plaintext and marked as a bot’s, length-limited, word-filtered, and only its own can be edited or deleted', async () => {
  const r = await bot(A.token, 'POST', `/channels/${general.id}/messages`, { content: 'Hello from **alpha**' });
  assert.equal(r.status, 200, r.text);
  const id = r.json.message.messageId;
  const row = srv.sql('SELECT * FROM messages WHERE id = ?', id)[0];
  assert.equal(row.ciphertext, null);
  assert.equal(row.author_id, A.id);
  assert.ok(!row.body.includes('alpha'), 'sealed at rest like the news bot’s posts');
  const seen = (await as(bob, 'GET', `/channels/${general.id}/messages`)).json.messages.find((m) => m.id === id);
  assert.deepEqual([seen.legacy, seen.bot, seen.content], [true, true, 'Hello from **alpha**']);
  assert.equal((await bot(A.token, 'POST', `/channels/${general.id}/messages`, { content: 'x'.repeat(2001) })).json.code, 'too_long');
  assert.equal((await bot(A.token, 'POST', `/channels/${general.id}/messages`, { content: '  ' })).json.code, 'bad_content');
  assert.equal((await as(srv.owner, 'PUT', '/admin/words', { words: ['frobnicate'] })).status, 200);
  const blocked = await bot(A.token, 'POST', `/channels/${general.id}/messages`, { content: 'please frobnicate now' });
  assert.deepEqual([blocked.status, blocked.json.code], [400, 'blocked_word']);
  assert.equal((await bot(A.token, 'PATCH', `/messages/${id}`, { content: 'I said frobnicate' })).json.code, 'blocked_word');
  await as(srv.owner, 'PUT', '/admin/words', { words: [] });

  const edit = await bot(A.token, 'PATCH', `/messages/${id}`, { content: 'Edited' });
  assert.equal(edit.status, 200, edit.text);
  assert.equal((await as(bob, 'GET', `/channels/${general.id}/messages`)).json.messages.find((m) => m.id === id).content, 'Edited');
  const human = await say(bob, general.id);
  assert.equal((await bot(A.token, 'PATCH', `/messages/${human.id}`, { content: 'pwned' })).json.code, 'not_author');
  assert.equal((await bot(A.token, 'DELETE', `/messages/${human.id}`)).json.code, 'not_author');
  // B can't edit A's message (and may not post at all).
  assert.equal((await bot(B.token, 'PATCH', `/messages/${id}`, { content: 'x' })).status, 403);
  // Reactions: A has reactions.write.
  assert.equal((await bot(A.token, 'PUT', `/messages/${human.id}/reactions/${encodeURIComponent('👍')}`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM reactions WHERE message_id = ? AND user_id = ?', human.id, A.id)[0].n, 1);
  assert.equal((await bot(B.token, 'PUT', `/messages/${human.id}/reactions/x`)).json.code, 'missing_scope');
  assert.equal((await bot(A.token, 'DELETE', `/messages/${id}`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', id)[0].n, 0);
  // Metadata only, never content, even through the read API.
  const meta = await bot(A.token, 'GET', `/channels/${general.id}/messages`);
  assert.ok(meta.json.messages.length >= 1);
  for (const m of meta.json.messages) assert.deepEqual(Object.keys(m).sort(), ['authorId', 'authorIsBot', 'channelId', 'createdAt', 'editedAt', 'messageId', 'replyTo', 'threadId']);
});

test('adding scopes or channels needs approval again; taking them away doesn’t', async () => {
  const add = await as(alice, 'PATCH', `/servers/${space.id}/bots/${B.id}`, { scopes: ['messages.read.metadata', 'channels.read'] });
  assert.deepEqual([add.status, add.json.code, add.json.added], [400, 'needs_approval', ['channels.read']]);
  assert.equal((await as(mallory, 'PATCH', `/servers/${space.id}/bots/${B.id}`, { scopes: ['messages.read.metadata', 'channels.read'], confirm: true })).status, 403);
  const ok = await as(alice, 'PATCH', `/servers/${space.id}/bots/${B.id}`, { scopes: ['messages.read.metadata', 'channels.read', 'messages.send'], confirm: true });
  assert.equal(ok.status, 200, ok.text);
  // Still nothing the bot didn't ask for.
  assert.equal((await as(alice, 'PATCH', `/servers/${space.id}/bots/${B.id}`, { scopes: ['members.read'], confirm: true })).json.code, 'bad_scopes');
  const less = await as(alice, 'PATCH', `/servers/${space.id}/bots/${B.id}`, { scopes: ['messages.read.metadata', 'channels.read'] });
  assert.equal(less.status, 200, less.text);
  assert.deepEqual(less.json.scopes, ['messages.read.metadata', 'channels.read']);
  // A: from one channel to every public channel is more.
  const wider = await as(alice, 'PATCH', `/servers/${space.id}/bots/${A.id}`, { channels: '*' });
  assert.deepEqual([wider.status, wider.json.moreChannels], [400, true]);
  const audit = srv.sql("SELECT detail FROM admin_log WHERE action = 'bot_access_changed'");
  assert.equal(audit.length, 2);
});

// ------------------------------------------------------------------ events
test('events: metadata only, only about channels the installation can see, and never a bot’s own actions', async () => {
  const mark = hook.hits.length;
  const since = (name, type) => hook.hits.slice(mark).filter((x) => x.name === name && x.json && x.json.type === type);
  const hidden = await say(alice, secret.id);
  const open = await say(bob, general.id);
  const gotA = await until(() => since('alpha', 'message.created').find((x) => x.json.data.messageId === open.id));
  const gotB = await until(() => since('beta', 'message.created').find((x) => x.json.data.messageId === open.id));
  assert.ok(gotA && gotB);
  for (const e of [gotA, gotB]) {
    assert.equal(e.json.v, 1);
    assert.deepEqual(Object.keys(e.json.data).sort(), ['authorId', 'authorIsBot', 'channelId', 'createdAt', 'editedAt', 'messageId', 'replyTo', 'threadId']);
    assert.ok(!e.raw.toString().includes(open.ciphertext.slice(3, 40)), 'no ciphertext either');
    assert.equal(e.json.data.authorId, bob.id);
  }
  await sleep(200);
  assert.ok(!hook.hits.slice(mark).some((x) => x.json && JSON.stringify(x.json.data).includes(hidden.id)), 'nothing about the private channel');
  assert.ok(!hook.hits.slice(mark).some((x) => x.json && x.json.data.channelId === secret.id));

  // A posts and reacts: B hears about the post (B has no reactions scope... it has metadata, so it hears both);
  // A hears about neither.
  const posted = (await bot(A.token, 'POST', `/channels/${general.id}/messages`, { content: 'loop?' })).json.message;
  await bot(A.token, 'PUT', `/messages/${open.id}/reactions/${encodeURIComponent('🎉')}`);
  assert.ok(await until(() => since('beta', 'message.created').find((x) => x.json.data.messageId === posted.messageId && x.json.data.authorIsBot === true)));
  assert.ok(await until(() => since('beta', 'reaction.added').find((x) => x.json.data.userId === A.id)));
  await sleep(200);
  assert.ok(!since('alpha', 'message.created').some((x) => x.json.data.messageId === posted.messageId), 'its own post didn’t come back');
  assert.ok(!since('alpha', 'reaction.added').some((x) => x.json.data.userId === A.id), 'its own reaction didn’t come back');
  // People's reactions do reach it.
  await as(bob, 'POST', `/messages/${open.id}/reactions`, { emoji: '😀' });
  assert.ok(await until(() => since('alpha', 'reaction.added').find((x) => x.json.data.userId === bob.id && x.json.data.emoji === '😀')));

  // Members: A has members.read, B doesn't.
  const carol = await srv.register('carol');
  const { code } = (await as(alice, 'POST', `/servers/${space.id}/invites`, {})).json;
  await as(carol, 'POST', `/invites/${code}/join`);
  assert.ok(await until(() => since('alpha', 'member.joined').find((x) => x.json.data.userId === carol.id)));
  await as(carol, 'POST', `/servers/${space.id}/leave`);
  assert.ok(await until(() => since('alpha', 'member.left').find((x) => x.json.data.userId === carol.id)));
  // Channels: B (channels.read, every public channel) hears about a new public channel; A (one channel) doesn't.
  const fresh = (await as(alice, 'POST', `/servers/${space.id}/channels`, { name: 'fresh', type: 'text' })).json;
  assert.ok(await until(() => since('beta', 'channel.created').find((x) => x.json.data.channelId === fresh.id)));
  await as(alice, 'DELETE', `/channels/${fresh.id}`);
  assert.ok(await until(() => since('beta', 'channel.deleted').find((x) => x.json.data.channelId === fresh.id)));
  await sleep(150);
  assert.ok(!since('alpha', 'channel.created').length && !since('beta', 'member.joined').length);
  // A person deleting a message: metadata.
  await as(bob, 'DELETE', `/messages/${open.id}`);
  assert.ok(await until(() => since('alpha', 'message.deleted').find((x) => x.json.data.messageId === open.id && x.json.data.deletedBy === bob.id)));
  // Deliveries hold no message text either.
  for (const d of srv.sql('SELECT body FROM bot_deliveries')) assert.ok(!Object.keys(JSON.parse(d.body).data).some((k) => /content|cipher|text|body/i.test(k)), d.body);
});

test('webhooks are signed over "timestamp.body" and verify with the documented check; tampering fails', async () => {
  const e = hook.of('alpha').find((x) => x.json && x.json.type === 'message.created');
  assert.ok(e);
  assert.equal(e.headers['x-hearth-event'], 'message.created');
  assert.equal(e.headers['x-hearth-delivery'], e.json.id);
  assert.match(e.headers['x-hearth-signature'], /^v1=[0-9a-f]{64}$/);
  const ts = Number(e.headers['x-hearth-timestamp']);
  assert.ok(Math.abs(ts - e.at / 1000) < 5);
  const expect = crypto.createHmac('sha256', A.secret).update(`${ts}.${e.raw.toString('utf8')}`).digest('hex');
  assert.equal(e.headers['x-hearth-signature'], `v1=${expect}`);
  assert.equal(verify(A.secret, e.headers, e.raw, { now: e.at }), true);
  assert.equal(verify(B.secret, e.headers, e.raw, { now: e.at }), false, 'another bot’s secret');
  assert.equal(verify(A.secret, e.headers, Buffer.from(e.raw.toString().replace('message.created', 'message.deleted')), { now: e.at }), false, 'body changed');
  assert.equal(verify(A.secret, { ...e.headers, 'x-hearth-timestamp': String(ts + 1) }, e.raw, { now: e.at }), false, 'timestamp changed');
  assert.equal(verify(A.secret, e.headers, e.raw, { now: e.at + 301000 }), false, 'outside the 5-minute replay window');
  // A new webhook secret (shown once, needs the password) takes over.
  assert.equal((await as(srv.owner, 'POST', `/bots/${A.id}/webhook-secret`, {})).status, 401);
  const rot = await as(srv.owner, 'POST', `/bots/${A.id}/webhook-secret`, { authKey: srv.owner.authKey });
  assert.equal(rot.status, 200);
  const mark = hook.hits.length;
  await bot(B.token, 'GET', '/me'); // (nothing) — then something A hears about:
  await as(bob, 'POST', `/messages/${(await say(bob, general.id)).id}/reactions`, { emoji: '⭐' });
  const next = await until(() => hook.hits.slice(mark).find((x) => x.name === 'alpha' && x.json.type === 'reaction.added'));
  assert.ok(verify(rot.json.webhookSecret, next.headers, next.raw));
  assert.ok(!verify(A.secret, next.headers, next.raw));
  A.secret = rot.json.webhookSecret;
});

test('failed deliveries retry with growing waits, then land in the dead-letter list the installer can retry or clear', async () => {
  const C = await makeBot('gamma', ['members.read']);
  hook.handlers.gamma = () => 500;
  await install(C, ['members.read'], []);
  const dead = await until(() => srv.sql("SELECT * FROM bot_deliveries WHERE bot_id = ? AND status = 'dead'", C.id)[0], 15000);
  assert.ok(dead, 'went to dead letters');
  assert.equal(dead.attempts, 6);
  const tries = hook.of('gamma', 'bot.installed');
  assert.equal(tries.length, 6, 'at most 6 attempts');
  assert.ok(tries.every((t) => t.json.id === tries[0].json.id), 'same delivery id each time');
  const gaps = tries.slice(1).map((t, i) => t.at - tries[i].at);
  assert.ok(gaps[4] > gaps[0] * 3, `backoff grows: ${gaps}`);
  assert.ok(gaps[0] >= 25, `jittered base wait: ${gaps}`);
  const listed = (await as(alice, 'GET', `/servers/${space.id}/bots`)).json.installed.find((i) => i.bot.id === C.id);
  assert.equal(listed.health, 'failing');
  assert.match(listed.lastError, /500/);
  const dl = (await as(alice, 'GET', `/servers/${space.id}/bots/${C.id}/deliveries`)).json;
  assert.equal(dl.dead.length, 1);
  assert.equal(dl.dead[0].lastStatus, 500);
  assert.equal((await as(mallory, 'GET', `/servers/${space.id}/bots/${C.id}/deliveries`)).status, 403);
  assert.equal((await as(mallory, 'POST', `/servers/${space.id}/bots/${C.id}/deliveries/retry`, {})).status, 403);
  // Fixed: retry from the list.
  hook.handlers.gamma = () => 200;
  assert.equal((await as(alice, 'POST', `/servers/${space.id}/bots/${C.id}/deliveries/retry`, {})).json.retried, 1);
  assert.ok(await until(() => srv.sql("SELECT 1 FROM bot_deliveries WHERE bot_id = ? AND status = 'ok'", C.id).length));
  assert.equal((await as(alice, 'GET', `/servers/${space.id}/bots`)).json.installed.find((i) => i.bot.id === C.id).health, 'ok');
  // And clearing.
  hook.handlers.gamma = () => 503;
  const carol = await srv.register('carol2');
  const { code } = (await as(alice, 'POST', `/servers/${space.id}/invites`, {})).json;
  await as(carol, 'POST', `/invites/${code}/join`);
  assert.ok(await until(() => srv.sql("SELECT 1 FROM bot_deliveries WHERE bot_id = ? AND status = 'dead'", C.id).length, 15000));
  assert.equal((await as(alice, 'DELETE', `/servers/${space.id}/bots/${C.id}/deliveries/dead`)).json.cleared, 1);
  assert.equal((await as(alice, 'GET', `/servers/${space.id}/bots/${C.id}/deliveries`)).json.dead.length, 0);
});

test('slow webhooks time out, and a bot never has more than 4 deliveries in flight', async () => {
  const D = await makeBot('delta', ['members.read']);
  hook.handlers.delta = async () => { await sleep(300); return 200; };
  await install(D, ['members.read'], []);
  const { code } = (await as(alice, 'POST', `/servers/${space.id}/invites`, {})).json;
  for (let i = 0; i < 6; i++) { const u = await srv.register(); await as(u, 'POST', `/invites/${code}/join`); }
  assert.ok(await until(() => hook.of('delta', 'member.joined').length >= 6, 10000));
  assert.ok(hook.peak.delta <= 4, `peak ${hook.peak.delta}`);
  assert.ok(hook.peak.delta >= 2, 'did run in parallel');
  // One that never answers: timed out (1.5 s here), counted as a failure, retried.
  hook.handlers.delta = () => 'hang';
  const u = await srv.register();
  await as(u, 'POST', `/invites/${code}/join`);
  const failed = await until(() => srv.sql("SELECT * FROM bot_deliveries WHERE bot_id = ? AND type = 'member.joined' AND attempts >= 1 AND last_error IS NOT NULL", D.id)[0], 6000);
  assert.ok(failed);
  assert.match(failed.last_error, /too long/);
  hook.handlers.delta = () => 200;
});

test('per-bot rate limits on the bot API', async () => {
  const E = await makeBot('epsilon', ['messages.send']);
  await install(E, ['messages.send'], [general.id]);
  let posted = 0; let limited = null;
  for (let i = 0; i < 12; i++) {
    const r = await bot(E.token, 'POST', `/channels/${general.id}/messages`, { content: `spam ${i}` });
    if (r.status === 200) posted++; else { limited = r; break; }
  }
  assert.equal(posted, 10);
  assert.deepEqual([limited.status, limited.json.code], [429, 'rate_limited']);
  assert.ok(+limited.headers.get('retry-after') > 0);
  let r;
  for (let i = 0; i < 70; i++) { r = await bot(E.token, 'GET', '/me'); if (r.status === 429) break; }
  assert.deepEqual([r.status, r.json.code], [429, 'rate_limited']);
  // Another bot isn't slowed down by it.
  assert.equal((await bot(B.token, 'GET', '/me')).status, 200);
});

// ------------------------------------------------------------------ slash commands
test('commands: registration is checked, lists follow scopes, channels and permissions', async () => {
  const bad = [
    [{ name: 'Bad Name' }], [{ name: 'x', options: [{ name: 'a', type: 'code' }] }], [{ name: 'x' }, { name: 'x' }],
    [{ name: 'x', options: [{ name: 'a', type: 'string', required: false }, { name: 'b', type: 'string' }] }], [{ name: 'x', permission: 'ROOT' }],
  ];
  for (const commands of bad) assert.equal((await bot(A.token, 'PUT', '/commands', { commands })).json.code, 'bad_commands', JSON.stringify(commands));
  const reg = await bot(A.token, 'PUT', '/commands', { commands: [
    { name: 'roll', description: 'Roll a die', options: [{ name: 'sides', type: 'number', required: true }] },
    { name: 'say', description: 'Say something', options: [{ name: 'text', type: 'string' }, { name: 'who', type: 'user', required: false }, { name: 'where', type: 'channel', required: false }] },
    { name: 'purge', description: 'Mods only', permission: 'MANAGE_MESSAGES' },
  ] });
  assert.equal(reg.status, 200, reg.text);
  // A token made for one installation can't change the bot's commands.
  const instTok = (await as(srv.owner, 'POST', `/bots/${A.id}/tokens`, { installationId: A.inst, authKey: srv.owner.authKey })).json;
  assert.equal((await bot(instTok.token, 'PUT', '/commands', { commands: [] })).json.code, 'bot_token_needed');
  assert.equal((await bot(instTok.token, 'GET', '/me')).status, 200);
  // B registers one too, but its installation didn't grant commands.
  assert.equal((await bot(B.token, 'PUT', '/commands', { commands: [{ name: 'beta' }] })).status, 200);
  const forBob = (await as(bob, 'GET', `/channels/${general.id}/commands`)).json.commands.map((c) => c.name).sort();
  assert.deepEqual(forBob, ['roll', 'say']);
  const forAlice = (await as(alice, 'GET', `/channels/${general.id}/commands`)).json.commands.map((c) => c.name).sort();
  assert.deepEqual(forAlice, ['purge', 'roll', 'say']);
  assert.deepEqual((await as(alice, 'GET', `/channels/${secret.id}/commands`)).json.commands, [], 'A isn’t allowed in #secret');
  assert.equal((await as(eve, 'GET', `/channels/${general.id}/commands`)).status, 404);
});

test('commands: the warning must be acknowledged, arguments are checked, permissions apply', async () => {
  const go = (u, name, args, extra = {}) => as(u, 'POST', `/channels/${general.id}/commands`, { botId: A.id, name, args, ack: true, ...extra });
  assert.equal((await as(bob, 'POST', `/channels/${general.id}/commands`, { botId: A.id, name: 'roll', args: { sides: 6 } })).json.code, 'needs_ack');
  for (const [name, args, why] of [
    ['roll', {}, 'missing'], ['roll', { sides: 'lots' }, 'not a number'], ['roll', { sides: 6, extra: 1 }, 'unknown argument'],
    ['say', { text: 'hi', who: eve.id }, 'not in this server'], ['say', { text: 'hi', where: other.channels[0].id }, 'another server’s channel'],
    ['say', { text: 'hi', where: secret.id }, 'a channel bob can’t see'], ['say', { text: 'x'.repeat(1001) }, 'too long'],
  ]) {
    const r = await go(bob, name, args);
    assert.deepEqual([r.status, r.json.code], [400, 'bad_args'], why);
  }
  assert.deepEqual([(await go(bob, 'purge', {})).status, (await go(bob, 'purge', {})).json.code], [403, 'missing_permission']);
  assert.equal((await go(bob, 'nope', {})).json.code, 'unknown_command');
  assert.equal((await as(bob, 'POST', `/channels/${general.id}/commands`, { botId: B.id, name: 'beta', args: {}, ack: true })).json.code, 'unknown_command', 'no commands scope');
  assert.equal((await as(eve, 'POST', `/channels/${general.id}/commands`, { botId: A.id, name: 'roll', args: { sides: 6 }, ack: true })).status, 404);
});

test('commands: the bot gets what was typed and answers in time; ephemeral answers go only to the invoker and are never stored', async () => {
  const sock = await srv.socket(mallory.token);
  const other2 = await srv.socket(alice.token);
  const got = []; const aliceGot = [];
  sock.on('bot:interaction', (x) => got.push(x));
  other2.on('bot:interaction', (x) => aliceGot.push(x));
  const answer = { mode: 'ephemeral' };
  hook.handlers.alpha = async (hit) => {
    if (hit.json && hit.json.type === 'command.invoked') {
      const d = hit.json.data;
      const reply = answer.mode === 'ephemeral' ? { content: `secret roll ${d.args.sides}`, ephemeral: true } : answer.mode === 'public' ? { content: `public roll ${d.args.sides}` } : null;
      if (reply) setTimeout(() => bot(A.token, 'POST', `/interactions/${d.interactionId}/callback`, reply).then((r) => { answer.last = r; }), 30);
    }
    return 200;
  };
  try {
    const msgsBefore = srv.sql('SELECT COUNT(*) n FROM messages')[0].n;
    const r = await as(mallory, 'POST', `/channels/${general.id}/commands`, { botId: A.id, name: 'roll', args: { sides: '20' }, ack: true, socketId: sock.id });
    assert.equal(r.status, 202, r.text);
    const inv = await until(() => hook.of('alpha', 'command.invoked').find((x) => x.json.data.interactionId === r.json.interactionId));
    assert.deepEqual(inv.json.data.args, { sides: 20 });
    assert.equal(inv.json.data.userId, mallory.id);
    assert.ok(verify(A.secret, inv.headers, inv.raw));
    const done = await until(() => got.find((x) => x.interactionId === r.json.interactionId));
    assert.deepEqual([done.status, done.ephemeral.content], ['ok', 'secret roll 20']);
    await sleep(100);
    assert.ok(!aliceGot.length, 'nobody else hears it');
    assert.equal(srv.sql('SELECT COUNT(*) n FROM messages')[0].n, msgsBefore, 'not stored as a message');
    assert.equal(srv.sql("SELECT COUNT(*) n FROM bot_deliveries WHERE type = 'command.invoked'")[0].n, 0, 'the typed arguments aren’t queued or kept');
    // Answering twice: too late.
    assert.equal((await bot(A.token, 'POST', `/interactions/${r.json.interactionId}/callback`, { content: 'again' })).json.code, 'interaction_expired');
    // Another bot can't answer it.
    assert.equal((await bot(B.token, 'POST', `/interactions/${r.json.interactionId}/callback`, { content: 'x' })).json.code, 'unknown_interaction');

    answer.mode = 'public';
    const p = await as(mallory, 'POST', `/channels/${general.id}/commands`, { botId: A.id, name: 'roll', args: { sides: 6 }, ack: true, socketId: sock.id });
    const pub = await until(() => got.find((x) => x.interactionId === p.json.interactionId));
    assert.ok(pub.messageId);
    assert.equal((await as(alice, 'GET', `/channels/${general.id}/messages`)).json.messages.find((m) => m.id === pub.messageId).content, 'public roll 6');

    answer.mode = 'silent';
    const t = await as(mallory, 'POST', `/channels/${general.id}/commands`, { botId: A.id, name: 'roll', args: { sides: 6 }, ack: true, socketId: sock.id });
    const late = await until(() => got.find((x) => x.interactionId === t.json.interactionId), 4000);
    assert.equal(late.status, 'timeout', 'the bot didn’t answer');
    assert.equal((await bot(A.token, 'POST', `/interactions/${t.json.interactionId}/callback`, { content: 'sorry' })).json.code, 'interaction_expired');

    // A bot whose webhook fails: told straight away.
    hook.handlers.alpha = () => 500;
    const f = await as(mallory, 'POST', `/channels/${general.id}/commands`, { botId: A.id, name: 'roll', args: { sides: 6 }, ack: true });
    const failed = await until(() => got.find((x) => x.interactionId === f.json.interactionId), 3000);
    assert.equal(failed.status, 'failed');
  } finally {
    delete hook.handlers.alpha;
    sock.close(); other2.close();
  }
});

// ------------------------------------------------------------------ private addresses
test('webhooks must be https on the public internet: http and private addresses are refused without the admin flag', async () => {
  assert.equal((await as(srv.owner, 'POST', '/bots', { name: 'plain', scopes: [], webhookUrl: 'http://example.com/hook' })).json.code, 'bad_webhook');
  assert.equal((await as(srv.owner, 'PATCH', `/bots/${A.id}`, { webhookUrl: 'ftp://example.com/' })).json.code, 'bad_webhook');
  const strict = await startServer({ NODE_EXTRA_CA_CERTS: path.join(certDir, 'cert.pem') });
  try {
    for (const url of [hook.url('x'), 'https://10.0.0.5/hook', 'https://169.254.169.254/latest', 'https://[::1]/hook', 'https://192.168.1.1/']) {
      const r = await strict.api('POST', '/bots', { token: strict.owner.token, ip: strict.owner.ip, body: { name: 'inside', scopes: [], webhookUrl: url } });
      assert.deepEqual([r.status, r.json.code], [400, 'private_address'], url);
    }
    // One saved before (straight into the database) is still refused when it's used.
    const ok = await strict.api('POST', '/bots', { token: strict.owner.token, ip: strict.owner.ip, body: { name: 'later', scopes: ['members.read'], listed: true } });
    strict.sql('UPDATE bots SET webhook_url = ? WHERE id = ?', hook.url('strict'), ok.json.bot.id);
    const s = (await strict.api('POST', '/servers', { token: strict.owner.token, ip: strict.owner.ip, body: { name: 'S' } })).json;
    assert.equal((await strict.api('POST', `/servers/${s.id}/bots`, { token: strict.owner.token, ip: strict.owner.ip, body: { botId: ok.json.bot.id, scopes: ['members.read'], channels: [], confirm: true } })).status, 200);
    const row = await until(() => strict.sql("SELECT * FROM bot_deliveries WHERE last_error IS NOT NULL")[0], 5000);
    assert.match(row.last_error, /private network/);
    assert.equal(hook.of('strict').length, 0, 'never reached');
  } finally { await strict.stop(); }
});

// ------------------------------------------------------------------ lifecycle
test('a paused, uninstalled, disabled or deleted bot can’t act', async () => {
  const F = await makeBot('phi', ['messages.send', 'members.read']);
  const inst = await install(F, ['messages.send', 'members.read'], [general.id]);
  const scoped = (await as(srv.owner, 'POST', `/bots/${F.id}/tokens`, { installationId: inst.id, authKey: srv.owner.authKey })).json;
  assert.equal((await bot(F.token, 'POST', `/channels/${general.id}/messages`, { content: 'up' })).status, 200);
  // Paused by the server.
  assert.equal((await as(alice, 'PATCH', `/servers/${space.id}/bots/${F.id}`, { enabled: false })).status, 200);
  assert.equal((await bot(F.token, 'POST', `/channels/${general.id}/messages`, { content: 'paused' })).json.code, 'installation_paused');
  assert.ok(!(await as(bob, 'GET', '/bootstrap')).json.servers.find((x) => x.id === space.id).bots.includes(F.id));
  assert.equal((await as(alice, 'PATCH', `/servers/${space.id}/bots/${F.id}`, { enabled: true })).status, 200);
  // Uninstalled: its server-only token is gone, its whole-bot token can't reach the server any more.
  const mark = hook.hits.length;
  assert.equal((await as(mallory, 'DELETE', `/servers/${space.id}/bots/${F.id}`)).status, 403);
  assert.equal((await as(alice, 'DELETE', `/servers/${space.id}/bots/${F.id}`)).status, 200);
  assert.equal((await bot(F.token, 'POST', `/channels/${general.id}/messages`, { content: 'still here?' })).json.code, 'not_installed');
  assert.equal((await bot(F.token, 'GET', `/installations/${inst.id}/members`)).json.code, 'not_installed');
  assert.equal((await bot(scoped.token, 'GET', '/me')).status, 401);
  assert.ok(await until(() => hook.hits.slice(mark).find((x) => x.name === 'phi' && x.json.type === 'bot.uninstalled')));
  assert.equal(srv.sql("SELECT COUNT(*) n FROM admin_log WHERE action = 'bot_uninstalled'")[0].n >= 1, true);
  // Switched off by an instance admin (abuse): every call refused, logged.
  await install(F, ['messages.send'], [general.id]);
  assert.equal((await as(alice, 'PATCH', `/bots/${F.id}`, { disabled: true })).status, 404, 'not alice’s bot, and she isn’t an admin');
  assert.equal((await as(srv.owner, 'PATCH', `/bots/${F.id}`, { disabled: true })).status, 200);
  assert.deepEqual([(await bot(F.token, 'GET', '/me')).status, (await bot(F.token, 'GET', '/me')).json.code], [403, 'bot_disabled']);
  assert.ok(srv.sql("SELECT 1 FROM admin_log WHERE action = 'bot_disabled' AND target = ?", F.id).length);
  // Deleted: gone for good; its posts keep an author.
  assert.equal((await as(srv.owner, 'DELETE', `/bots/${F.id}`)).status, 200);
  assert.equal((await bot(F.token, 'GET', '/me')).status, 401);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM bot_installations WHERE bot_id = ?', F.id)[0].n, 0);
  assert.ok(srv.sql('SELECT deleted_at FROM users WHERE id = ?', F.id)[0].deleted_at);
  assert.ok(srv.sql('SELECT COUNT(*) n FROM messages WHERE author_id = ?', F.id)[0].n >= 1);
});

test('the news bot is unchanged and shows up as a built-in bot', async () => {
  const list = (await as(alice, 'GET', `/servers/${space.id}/bots`)).json;
  assert.deepEqual(list.builtIn.map((b) => [b.id, b.feeds, b.active]), [['newsbot00000000000001', 0, false]]);
  // Not in the installed list, no token, no bots row: it keeps its own storage.
  assert.equal(srv.sql("SELECT COUNT(*) n FROM bots WHERE id = 'newsbot00000000000001'")[0].n, 0);
  assert.equal(srv.sql("SELECT is_bot FROM users WHERE id = 'newsbot00000000000001'")[0].is_bot, 1);
  // Group chats can't have bots.
  const g = await as(alice, 'POST', '/groups', { userIds: [bob.id] });
  if (g.status === 200) assert.equal((await as(alice, 'GET', `/servers/${g.json.id}/bots`)).status, 400);
});
