// The example bot (scripts/example-bot.js), run as its own process against a real Hearth, the way a developer
// would run it: it registers /roll, says hello when installed, answers /roll through the bot API, and refuses
// webhooks that aren't signed. Everything stays on this machine (a throwaway certificate for 127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { startServer, sleep } = require('./helpers');

let srv; let dir; let child; let childLog = ''; let port; let alice; let space; let general; let dice;
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 25) { const v = await fn(); if (v) return v; await sleep(25); } return null; };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

before(async () => {
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-example-bot-'));
  fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
  fs.writeFileSync(path.join(dir, 'key.pem'), pems.private);
  srv = await startServer({ NODE_EXTRA_CA_CERTS: path.join(dir, 'cert.pem'), BOT_WEBHOOK_ALLOW_PRIVATE: '1' });
  alice = await srv.register('alice');
  space = (await as(alice, 'POST', '/servers', { name: 'Game night' })).json;
  general = space.channels.find((c) => c.type === 'text');
  port = await freePort();
  const made = await as(srv.owner, 'POST', '/bots', { name: 'Dice', description: 'Rolls dice', scopes: ['messages.send', 'commands'], listed: true, webhookUrl: `https://127.0.0.1:${port}/` });
  assert.equal(made.status, 200, made.text);
  dice = { id: made.json.bot.id, token: made.json.token, secret: made.json.webhookSecret };
  child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'example-bot.js')], {
    env: { ...process.env, HEARTH_URL: srv.base, BOT_TOKEN: dice.token, WEBHOOK_SECRET: dice.secret, PORT: String(port), TLS_CERT: path.join(dir, 'cert.pem'), TLS_KEY: path.join(dir, 'key.pem') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  assert.ok(await until(() => /Ready\./.test(childLog)), `the example bot didn't start:\n${childLog}`);
});
after(async () => {
  if (child && child.exitCode === null) child.kill();
  if (srv) await srv.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('the example bot registers /roll, says hello when installed, and answers /roll', async () => {
  assert.match(childLog, /Signed in as Dice/);
  assert.deepEqual((await srv.api('GET', '/bot/v1/commands', { headers: { authorization: `Bot ${dice.token}` } })).json.commands.map((c) => c.name), ['roll']);
  const inst = await as(alice, 'POST', `/servers/${space.id}/bots`, { botId: dice.id, scopes: ['messages.send', 'commands'], channels: [general.id], confirm: true });
  assert.equal(inst.status, 200, inst.text);
  const hello = await until(async () => (await as(alice, 'GET', `/channels/${general.id}/messages`)).json.messages.find((m) => m.authorId === dice.id));
  assert.ok(hello, `no hello:\n${childLog}`);
  assert.match(hello.content, /I roll dice/);
  assert.equal(hello.bot, true);
  // The app lists the command, then runs it.
  const cmds = (await as(alice, 'GET', `/channels/${general.id}/commands`)).json.commands;
  assert.deepEqual(cmds.map((c) => [c.botName, c.name, c.options.map((o) => `${o.name}:${o.type}`)]), [['Dice', 'roll', ['sides:number']]]);
  const sock = await srv.socket(alice.token);
  const got = [];
  sock.on('bot:interaction', (x) => got.push(x));
  try {
    const r = await as(alice, 'POST', `/channels/${general.id}/commands`, { botId: dice.id, name: 'roll', args: { sides: 20 }, ack: true, socketId: sock.id });
    assert.equal(r.status, 202, r.text);
    const done = await until(() => got.find((x) => x.interactionId === r.json.interactionId));
    assert.equal(done.status, 'ok', JSON.stringify(done));
    const msg = (await as(alice, 'GET', `/channels/${general.id}/messages`)).json.messages.find((m) => m.id === done.messageId);
    const n = Number((/rolled \*\*(\d+)\*\* \(1–20\)/.exec(msg.content) || [])[1]);
    assert.ok(n >= 1 && n <= 20, msg.content);
    // A bad number gets an answer only Alice sees (and nothing is stored).
    const count = srv.sql('SELECT COUNT(*) n FROM messages')[0].n;
    const bad = await as(alice, 'POST', `/channels/${general.id}/commands`, { botId: dice.id, name: 'roll', args: { sides: 1 }, ack: true, socketId: sock.id });
    const eph = await until(() => got.find((x) => x.interactionId === bad.json.interactionId));
    assert.deepEqual([eph.status, eph.ephemeral && eph.ephemeral.content], ['ok', 'Pick between 2 and 1000 sides.']);
    assert.equal(srv.sql('SELECT COUNT(*) n FROM messages')[0].n, count);
  } finally { sock.close(); }
  // The installation is healthy (it heard from the bot).
  assert.equal((await as(alice, 'GET', `/servers/${space.id}/bots`)).json.installed[0].health, 'ok');
});

test('the example bot refuses webhooks that aren’t signed with its secret', async () => {
  const send = (headers, body) => new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method: 'POST', path: '/', ca: fs.readFileSync(path.join(dir, 'cert.pem')), headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(body);
  });
  const body = JSON.stringify({ v: 1, id: 'x1', type: 'command.invoked', data: { command: 'roll', args: {}, interactionId: 'in_x' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const crypto = require('node:crypto');
  const sig = (secret, t = ts) => `v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  assert.equal(await send({}, body), 401, 'unsigned');
  assert.equal(await send({ 'x-hearth-timestamp': ts, 'x-hearth-signature': sig('not-the-secret') }, body), 401, 'wrong secret');
  const old = String(Math.floor(Date.now() / 1000) - 600);
  assert.equal(await send({ 'x-hearth-timestamp': old, 'x-hearth-signature': sig(dice.secret, old) }, body), 401, 'replayed from 10 minutes ago');
  assert.equal(await send({ 'x-hearth-timestamp': ts, 'x-hearth-signature': sig(dice.secret) }, body), 200, 'signed and fresh');
});
