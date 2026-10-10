// Sign-up, sign-in and the limits around them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, newIp, hex } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test('wrong password and unknown username get the same answer', async () => {
  const u = await srv.register();
  const wrong = await srv.api('POST', '/auth/login', { body: { username: u.username, authKey: hex(32) }, ip: newIp() });
  const unknown = await srv.api('POST', '/auth/login', { body: { username: 'nobody_' + hex(3), authKey: hex(32) }, ip: newIp() });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.json.error, unknown.json.error);
  assert.equal(wrong.json.token, undefined);
});

test('an unknown username takes about as long as a wrong password (no timing leak)', async () => {
  const u = await srv.register();
  const time = async (username) => { const t = process.hrtime.bigint(); await srv.api('POST', '/auth/login', { body: { username, authKey: hex(32) }, ip: newIp() }); return Number(process.hrtime.bigint() - t) / 1e6; };
  const known = []; const unknown = [];
  for (let i = 0; i < 4; i++) { known.push(await time(u.username)); unknown.push(await time('ghost_' + hex(4))); }
  const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  // bcrypt dominates both; without the dummy hash an unknown name answers ~100x faster.
  assert.ok(med(unknown) > med(known) / 3, `unknown ${med(unknown)}ms vs known ${med(known)}ms`);
});

test('the right password signs in; malformed logins are refused without a server error', async () => {
  const u = await srv.register();
  assert.equal((await srv.login(u)).status, 200);
  for (const body of [{}, { username: u.username }, { username: u.username, authKey: 12345 }, { username: ['x'], authKey: u.authKey },
    { username: u.username, authKey: { $ne: '' } }, { username: "' OR 1=1 --", authKey: "' OR '1'='1" }, { username: 'a'.repeat(100000), authKey: 'b'.repeat(100000) }]) {
    const r = await srv.api('POST', '/auth/login', { body, ip: newIp() });
    assert.ok([400, 401].includes(r.status), `${JSON.stringify(body).slice(0, 60)} → ${r.status}`);
  }
});

test('registration validates input and refuses duplicate names (any letter case)', async () => {
  const u = await srv.register();
  const base = { authKey: hex(32), publicKey: 'A'.repeat(40), encPrivateKey: 'B'.repeat(40), kdfSalt: 'C'.repeat(24), acceptTos: srv.config.termsVersion };
  assert.equal((await srv.api('POST', '/auth/register', { body: { ...base, username: u.username.toUpperCase() }, ip: newIp() })).status, 409);
  for (const username of ['a', '<script>', 'x'.repeat(30), '../../etc', 'na me', null, 42]) {
    assert.equal((await srv.api('POST', '/auth/register', { body: { ...base, username }, ip: newIp() })).status, 400, String(username));
  }
  assert.equal((await srv.api('POST', '/auth/register', { body: { ...base, username: 'okname1', authKey: 'not-hex' }, ip: newIp() })).status, 400);
});

test('two sign-ups racing for the same name: exactly one wins, no server error', async () => {
  const name = 'race_' + hex(3);
  const body = () => ({ username: name, authKey: hex(32), publicKey: 'A'.repeat(40), encPrivateKey: 'B'.repeat(40), kdfSalt: 'C'.repeat(24), acceptTos: srv.config.termsVersion });
  const rs = await Promise.all(Array.from({ length: 6 }, () => srv.api('POST', '/auth/register', { body: body(), ip: newIp() })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
});

test('login attempts are limited per network', async () => {
  const u = await srv.register();
  const ip = newIp();
  const statuses = [];
  for (let i = 0; i < 22; i++) statuses.push((await srv.api('POST', '/auth/login', { body: { username: 'x' + i, authKey: hex(32) }, ip })).status);
  assert.ok(statuses.includes(429), 'expected a 429 from one network');
  const r = await srv.api('POST', '/auth/login', { body: { username: u.username, authKey: hex(32) }, ip });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0, 'Retry-After header');
});

test('IPv6: rotating addresses inside one /64 shares one limit', async () => {
  const statuses = [];
  for (let i = 0; i < 22; i++) statuses.push((await srv.api('POST', '/auth/login', { body: { username: 'v6_' + i, authKey: hex(32) }, ip: `2001:db8:abcd:12::${(i + 1).toString(16)}` })).status);
  assert.ok(statuses.includes(429));
});

test('guessing one account from many IP addresses is still limited (per-account limit)', async () => {
  const u = await srv.register();
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await srv.api('POST', '/auth/login', { body: { username: u.username, authKey: hex(32) }, ip: newIp() })).status);
  assert.ok(statuses.slice(10).every((s) => s === 429), statuses.join(','));
  // …but the owner, from a network they've used before, can still sign in.
  assert.equal((await srv.login(u)).status, 200);
});

test('registration is limited per network', async () => {
  const ip = newIp();
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    statuses.push((await srv.api('POST', '/auth/register', { body: { username: 'reg' + hex(3), authKey: hex(32), publicKey: 'A'.repeat(40), encPrivateKey: 'B'.repeat(40), kdfSalt: 'C'.repeat(24), acceptTos: srv.config.termsVersion }, ip })).status);
    assert.ok([200, 429].includes(statuses[i]), `register → ${statuses[i]}`);
  }
  assert.ok(statuses.includes(429), statuses.join(','));
});

test('the robot check is enforced when on', async () => {
  await srv.api('PUT', '/admin/registration', { token: srv.owner.token, body: { captchaLogin: 'on' }, ip: srv.owner.ip });
  const u = srv.owner;
  const r = await srv.login(u);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'captcha');
  const forged = await srv.login(u, { captcha: { salt: '0'.repeat(32), difficulty: 18, expires: Date.now() + 60000, sig: 'f'.repeat(64), nonce: 1 } });
  assert.equal(forged.status, 400);
  await srv.api('PUT', '/admin/registration', { token: srv.owner.token, body: { captchaLogin: 'off' }, ip: srv.owner.ip });
});

test('the news bot account can never sign in', async () => {
  const bot = srv.sql('SELECT username FROM users WHERE is_bot = 1')[0];
  assert.ok(bot);
  for (const authKey of ['', '!', hex(32)]) assert.equal((await srv.api('POST', '/auth/login', { body: { username: bot.username, authKey }, ip: newIp() })).status, 401);
});

test('passwords are stored only as bcrypt hashes of a key derived on the device', async () => {
  const u = await srv.register();
  const row = srv.sql('SELECT auth_hash FROM users WHERE id = ?', u.id)[0];
  assert.match(row.auth_hash, /^\$2[aby]\$11\$/);
  assert.ok(!row.auth_hash.includes(u.authKey));
});
