// Sign-in, sign-up, reset links and sessions: regressions for the auth hardening batch.
//   - ADMIN_USERS names belong to the account that first took them (a freed name brings no powers to a stranger),
//     and the owner is settled once, so a later sign-up can't take the server over.
//   - Requests without a solved robot check don't use up anyone's sign-in limits, and an account's usual
//     networks can't be locked out by strangers.
//   - Reset links die when the password or email changes; IP bans cover existing sessions and the reset flow.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startServer, confirmEmail, resetTokenFrom, newIp, hex, b64, sleep, solveCaptcha } = require('./helpers');

const as = (srv, u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const role = async (srv, u) => (await as(srv, u, 'GET', '/bootstrap')).json.me.staffRole;
// A sign-up as the app sends it, without the helper's automatic retry (so refusals can be checked).
function regBody(srv, username) {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { username, authKey: hex(32), publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), encPrivateKey: b64(120), kdfSalt: b64(16), acceptTos: srv.config.termsVersion || undefined };
}
const tryRegister = (srv, username, ip = newIp()) => srv.api('POST', '/auth/register', { ip, body: regBody(srv, username) });

// ------------------------------------------------------------------ ADMIN_USERS and ownership (auth-1, admin-1, admin-3)
describe('ADMIN_USERS names and the owner', () => {
  let srv;
  // 'chief' comes first and has no account yet; the helper's first account is 'owner' (also listed).
  before(async () => { srv = await startServer({ ADMIN_USERS: 'chief,owner,boss_t,helper' }); });
  after(() => srv.stop());

  test('registering a free ADMIN_USERS name later makes an admin, never the owner', async () => {
    assert.equal(await role(srv, srv.owner), 'owner');
    const chief = await srv.register('chief');
    assert.equal(await role(srv, chief), 'admin', 'listed names are still admins (documented setup)');
    const staff = await as(srv, chief, 'GET', '/admin/staff');
    assert.equal(staff.json.me, 'admin');
    assert.equal((await as(srv, chief, 'GET', '/admin/owner')).status, 403, 'not the owner');
    assert.equal((await as(srv, chief, 'POST', '/admin/backups/key', { authKey: chief.authKey })).status, 403, 'no backup key');
    assert.equal(await role(srv, srv.owner), 'owner', 'the first account still owns the server');
    assert.equal((await as(srv, srv.owner, 'GET', '/admin/owner')).status, 200);
  });

  test('an ADMIN_USERS admin who renames keeps the powers; nobody else can register or take the old name', async () => {
    const boss = await srv.register('boss_t');
    assert.equal(await role(srv, boss), 'admin');
    const r = await as(srv, boss, 'POST', '/me/username', { username: 'boss_t2', authKey: boss.authKey });
    assert.equal(r.status, 200, r.text);
    assert.equal(await role(srv, boss), 'admin', 'powers stay with the account');
    // The freed name is reserved: a stranger can't sign up with it, in any capitals.
    for (const name of ['boss_t', 'BOSS_T', 'Boss_T']) {
      const x = await tryRegister(srv, name);
      assert.equal(x.status, 409, `${name}: ${x.text}`);
      assert.match(x.json.error, /reserved/);
    }
    // ...or rename into it.
    const other = await srv.register('other' + hex(3));
    assert.equal((await as(srv, other, 'POST', '/me/username', { username: 'boss_t', authKey: other.authKey })).status, 409);
    assert.equal(await role(srv, other), null);
    // The owner can't take an ADMIN_USERS admin's role away in the app (it comes from .env).
    const rm = await as(srv, srv.owner, 'PUT', '/admin/staff', { userId: boss.id, role: null });
    assert.equal(rm.status, 400);
    assert.match(rm.json.error, /ADMIN_USERS/);
    // The account that holds the name may take it back.
    const back = await as(srv, boss, 'POST', '/me/username', { username: 'boss_t', authKey: boss.authKey });
    assert.equal(back.status, 200, back.text);
    assert.equal(await role(srv, boss), 'admin');
  });

  test('the owner, listed in ADMIN_USERS, renames: the old name stays reserved and brings nothing', async () => {
    const o = srv.owner;
    const r = await as(srv, o, 'POST', '/me/username', { username: 'owner_renamed', authKey: o.authKey });
    assert.equal(r.status, 200, r.text);
    o.username = 'owner_renamed';
    assert.equal(await role(srv, o), 'owner');
    assert.equal((await tryRegister(srv, 'owner')).status, 409);
  });

  test('an ADMIN_USERS admin who deletes their account: the name stays reserved, the deleted account has no role', async () => {
    const helper = await srv.register('helper');
    assert.equal(await role(srv, helper), 'admin');
    const d = await as(srv, helper, 'DELETE', '/me', { authKey: helper.authKey, confirm: 'helper' });
    assert.equal(d.status, 200, d.text);
    const x = await tryRegister(srv, 'helper');
    assert.equal(x.status, 409, x.text);
    const staff = (await as(srv, srv.owner, 'GET', '/admin/staff')).json.staff;
    assert.ok(!staff.some((s) => s.id === helper.id), 'deleted accounts are not listed as staff');
    // Ownership can't be handed to a deleted account or a bot (nobody could ever use it).
    assert.equal((await as(srv, srv.owner, 'POST', '/admin/owner', { userId: helper.id })).status, 400);
    assert.equal((await as(srv, srv.owner, 'POST', '/admin/owner', { userId: 'newsbot00000000000001' })).status, 400);
    assert.equal(await role(srv, srv.owner), 'owner');
  });

  test('after a restart: claims and the owner are kept', async () => {
    await srv.restart();
    assert.equal(await role(srv, srv.owner), 'owner');
    assert.equal((await tryRegister(srv, 'boss_t')).status, 409);
    assert.equal((await tryRegister(srv, 'helper')).status, 409, 'still reserved for the deleted admin');
    assert.equal((await tryRegister(srv, 'owner')).status, 409);
  });

  test('handing ownership over still works, and the CLI can name a new owner', async () => {
    const heir = await srv.register('heir' + hex(3));
    const t = await as(srv, srv.owner, 'POST', '/admin/owner', { userId: heir.id });
    assert.equal(t.status, 200, t.text);
    assert.equal(await role(srv, heir), 'owner');
    assert.equal(await role(srv, srv.owner), 'admin');
    const cli = spawnSync(process.execPath, ['server/cli.js', 'set-owner', srv.owner.username], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: srv.dir }, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    assert.equal(await role(srv, srv.owner), 'owner');
    assert.equal(srv.sql("SELECT COUNT(*) n FROM admin_log WHERE action = 'ownership_set_cli' AND target = ?", srv.owner.id)[0].n, 1, 'on the audit log');
    assert.equal((await srv.api('GET', '/admin/log/verify', { token: srv.owner.token, ip: srv.owner.ip })).json.ok, true, 'hash chain intact');
    // A deleted account can't be made the owner from the command line either.
    const gone = srv.sql('SELECT username FROM users WHERE deleted_at IS NOT NULL')[0].username;
    const bad = spawnSync(process.execPath, ['server/cli.js', 'set-owner', gone], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: srv.dir }, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.equal(await role(srv, srv.owner), 'owner');
  });
});

describe('ownership with ADMIN_USERS set before anyone signs up', () => {
  let srv;
  // The documented setup: the operator's own name is listed and they sign up first.
  before(async () => { srv = await startServer({ ADMIN_USERS: 'owner,second' }); });
  after(() => srv.stop());

  test('the listed first account is the owner; a second listed name is an admin', async () => {
    assert.equal(await role(srv, srv.owner), 'owner');
    const second = await srv.register('second');
    assert.equal(await role(srv, second), 'admin');
    const plain = await srv.register('plain' + hex(3));
    assert.equal(await role(srv, plain), null);
  });
});

// ------------------------------------------------------------------ sign-in limits (auth-2, auth-3)
// This server runs on a clock the test can move forward (Date.now() + an offset read from a file), with the
// robot check on, like a default install.
describe('sign-in and sign-up limits', () => {
  let srv; let victim; let resetter; let clockFile; let offset = 0;
  const advance = async (ms) => { offset += ms; fs.writeFileSync(clockFile, String(offset)); await sleep(150); };
  const setCaptcha = async (v) => assert.equal((await srv.api('PUT', '/admin/registration', { token: srv.owner.token, ip: srv.owner.ip, body: { captchaLogin: v, captchaRegister: v } })).status, 200);
  const solved = async (ip, purpose = 'login') => solveCaptcha((await srv.api('GET', `/captcha?purpose=${purpose}`, { ip })).json);
  const login = async (ip, authKey, extra = {}, who = victim) => srv.api('POST', '/auth/login', { ip, body: { username: who.username, authKey, ...extra } });
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-clock-'));
    clockFile = path.join(dir, 'offset');
    fs.writeFileSync(clockFile, '0');
    const preload = path.join(dir, 'clock.js');
    fs.writeFileSync(preload, `const fs = require('fs'); const real = Date.now; let off = 0;
const read = () => { try { off = +fs.readFileSync(${JSON.stringify(clockFile)}, 'utf8') || 0; } catch { /* keep */ } };
read(); setInterval(read, 25).unref(); Date.now = () => real() + off;\n`);
    srv = await startServer({ NODE_OPTIONS: `--require ${preload}` });
    victim = await srv.register(); // victim.ip is now one of the account's known networks
    resetter = await srv.register(); await confirmEmail(srv, resetter, `${resetter.username}@example.test`);
    await setCaptcha('on');
  });
  after(async () => { await srv.stop(); fs.rmSync(path.dirname(clockFile), { recursive: true, force: true }); });

  test('requests without a solved robot check use up nobody’s sign-in limit', async () => {
    const attacker = newIp();
    const st = [];
    for (let i = 0; i < 15; i++) st.push((await login(attacker, hex(32))).status);
    assert.deepEqual(st, Array(15).fill(400), 'all refused for the missing robot check, none counted');
    // The victim on a network they've never used, right password, solved check: gets in.
    const ip = newIp();
    const r = await login(ip, victim.authKey, { captcha: await solved(ip) });
    assert.equal(r.status, 200, r.text);
  });

  test('wrong passwords with solved checks are still limited per account from new networks', async () => {
    const u = await srv.register();
    const st = [];
    for (let i = 0; i < 11; i++) { const ip = newIp(); st.push((await login(ip, hex(32), { captcha: await solved(ip) }, u)).status); }
    assert.deepEqual(st.slice(0, 10), Array(10).fill(401));
    assert.equal(st[10], 429, 'per-account limit');
  });

  test('a stranger filling the account’s daily limit can’t lock it out of its usual network', async () => {
    const u = await srv.register(); // u.ip is a network the account has used
    await setCaptcha('off'); // every attempt counts now: the worst case
    try {
      for (let w = 0; w < 10; w++) {
        await advance(16 * 60000);
        for (let i = 0; i < 10; i++) assert.equal((await login(newIp(), hex(32), {}, u)).status, 401);
      }
      await advance(16 * 60000);
      const blocked = await login(newIp(), u.authKey, {}, u);
      assert.equal(blocked.status, 429, 'the daily limit for new networks is full');
      assert.match(blocked.json.error, /minutes/);
      assert.equal((await srv.login(u)).status, 200, 'from a network the account has used before, it still signs in');
    } finally { await setCaptcha('on'); }
  });

  test('instance-wide sign-up limit: junk without a robot check doesn’t use it up', async () => {
    const st = [];
    for (let n = 0; n < 26; n++) { const ip = newIp(); for (let i = 0; i < 5; i++) st.push((await tryRegister(srv, 'x' + hex(4), ip)).status); }
    assert.ok(st.every((s) => s === 400), JSON.stringify(st));
    const ip = newIp();
    const r = await srv.api('POST', '/auth/register', { ip, body: { ...regBody(srv, 'legit' + hex(3)), captcha: await solved(ip, 'register') } });
    assert.equal(r.status, 200, r.text);
  });

  test('instance-wide sign-in limit: junk without a robot check doesn’t use it up', async () => {
    let refused = 0;
    for (let n = 0; n < 152; n++) {
      const ip = newIp();
      const rs = await Promise.all(Array.from({ length: 20 }, () => srv.api('POST', '/auth/login', { ip, body: { username: 'nobody' + hex(3) } })));
      refused += rs.filter((r) => r.status === 400).length;
      assert.equal(refused, (n + 1) * 20, 'turned away at the robot check');
    }
    assert.equal(refused, 152 * 20);
    const ip = newIp();
    const r = await srv.api('POST', '/auth/login', { ip, body: { username: srv.owner.username, authKey: srv.owner.authKey, captcha: await solved(ip) } });
    assert.equal(r.status, 200, r.text);
  });

  test('password resets: requests for made-up names don’t use up the instance-wide cap', async () => {
    const u = resetter;
    for (let n = 0; n < 61; n++) { const ip = newIp(); for (let i = 0; i < 5; i++) assert.equal((await srv.api('POST', '/auth/forgot', { ip, body: { login: 'nobody' + hex(3) } })).status, 200); }
    const before = srv.mails().length;
    const r = await srv.api('POST', '/auth/forgot', { ip: newIp(), body: { login: u.username } });
    assert.equal(r.status, 200, r.text);
    assert.ok(srv.mails().slice(before).some((m) => m.to === `${u.username}@example.test` && /reset your password/.test(m.subject)), 'the real reset email went out');
  });
});

// ------------------------------------------------------------------ reset links, bans, sessions (auth-4, 8, 9, 10, 13)
describe('reset links, IP bans and sessions', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.stop());
  const rs = (u, method, p, body) => as(srv, u, method, p, body);

  async function linkFor(u, email) {
    const before = srv.mails().length;
    assert.equal((await srv.api('POST', '/auth/forgot', { ip: newIp(), body: { login: u.username } })).status, 200);
    const m = srv.mails().slice(before).find((x) => x.to === email && /reset your password/.test(x.subject));
    assert.ok(m, 'reset mail sent to ' + email);
    return resetTokenFrom(m);
  }
  function useLink(token, ip = newIp()) { // new password, new keys
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return srv.api('POST', '/auth/reset', { ip, body: { token, authKey: hex(32), encPrivateKey: b64(120), kdfSalt: b64(16), publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } });
  }

  test('a reset link stops working once the password is changed', async () => {
    const u = await srv.register(); const email = `${u.username}@old.test`; await confirmEmail(srv, u, email);
    const link = await linkFor(u, email);
    const pw = await rs(u, 'POST', '/me/password', { oldAuthKey: u.authKey, newAuthKey: hex(32), encPrivateKey: b64(60), salt: b64(16) });
    assert.equal(pw.status, 200, pw.text);
    assert.equal((await srv.api('POST', '/auth/reset/info', { ip: newIp(), body: { token: link } })).status, 400);
    assert.equal((await useLink(link)).status, 400);
    assert.equal((await rs(u, 'GET', '/bootstrap')).status, 200, 'the owner is still signed in');
    // A new link works as usual.
    const fresh = await linkFor(u, email);
    assert.equal((await useLink(fresh)).status, 200);
  });

  test('a reset link sent to the old address stops working once the email changes', async () => {
    const u = await srv.register(); const oldE = `${u.username}@old.test`; await confirmEmail(srv, u, oldE);
    const link = await linkFor(u, oldE);
    await confirmEmail(srv, u, `${u.username}@new.test`);
    assert.equal((await useLink(link)).status, 400);
    assert.equal((await rs(u, 'GET', '/bootstrap')).status, 200);
  });

  test('a reset link stops working once the email is removed', async () => {
    const u = await srv.register(); const e = `${u.username}@old.test`; await confirmEmail(srv, u, e);
    const link = await linkFor(u, e);
    assert.equal((await rs(u, 'DELETE', '/me/email', { authKey: u.authKey })).status, 200);
    assert.equal((await useLink(link)).status, 400);
  });

  test('IP bans cut off existing sessions and the password-reset flow (staff are exempt)', async () => {
    const spam = await srv.register(); const other = await srv.register(undefined, { ip: newIp() });
    await confirmEmail(srv, other, `${other.username}@x.test`);
    const link = await linkFor(other, `${other.username}@x.test`);
    assert.equal((await rs(spam, 'GET', '/bootstrap')).status, 200);
    const ban = await srv.api('POST', '/admin/ip-bans', { token: srv.owner.token, ip: srv.owner.ip, body: { ip: spam.ip, reason: 'spam' } });
    assert.equal(ban.status, 200, ban.text);
    const boot = await rs(spam, 'GET', '/bootstrap');
    assert.equal(boot.status, 403);
    assert.equal(boot.json.code, 'ip_banned');
    assert.equal((await srv.api('POST', '/auth/forgot', { ip: spam.ip, body: { login: other.username } })).status, 403);
    assert.equal((await srv.api('POST', '/auth/reset/info', { ip: spam.ip, body: { token: link } })).status, 403);
    assert.equal((await useLink(link, spam.ip)).status, 403);
    // Staff from a banned address still get in (nobody locks the admins out).
    assert.equal((await srv.api('GET', '/bootstrap', { token: srv.owner.token, ip: spam.ip })).status, 200);
    // Somewhere else, the link still works; lifting the ban restores access.
    await srv.api('DELETE', '/admin/ip-bans', { token: srv.owner.token, ip: srv.owner.ip, body: { ip: spam.ip } });
    assert.equal((await rs(spam, 'GET', '/bootstrap')).status, 200);
    assert.equal((await useLink(link)).status, 200);
  });

  test('old-format accounts: "keep other sessions" only right after signing in, and always logged and emailed', async () => {
    const u = await srv.register('legacy' + hex(3)); await confirmEmail(srv, u, `${u.username}@x.test`);
    const otherDevice = (await srv.login(u)).json.token;
    srv.sql("UPDATE users SET kdf = 'pbkdf2' WHERE id = ?", u.id); // an account from before the Argon2id upgrade
    const audit = (action) => srv.sql('SELECT COUNT(*) n FROM admin_log WHERE action = ? AND target = ?', action, u.id)[0].n;
    // A session that signed in long ago can't use the flag: this is a real change, everyone else is signed out.
    srv.sql('UPDATE sessions SET created_at = ? WHERE token_hash = ?', Date.now() - 3600000, crypto.createHash('sha256').update(u.token).digest('hex'));
    const k1 = hex(32);
    const r1 = await rs(u, 'POST', '/me/password', { oldAuthKey: u.authKey, newAuthKey: k1, encPrivateKey: b64(60), salt: b64(16), keepSessions: true });
    assert.equal(r1.status, 200, r1.text);
    assert.equal((await srv.api('GET', '/bootstrap', { token: otherDevice, ip: u.ip })).status, 401, 'other devices signed out');
    assert.equal(audit('password_changed'), 1);
    // Right after signing in (what the app does to upgrade), other devices stay, but it's on record and emailed.
    srv.sql("UPDATE users SET kdf = 'pbkdf2' WHERE id = ?", u.id);
    u.authKey = k1;
    const second = (await srv.login(u)).json.token;
    const fresh = (await srv.login(u)).json.token;
    const before = srv.mails().length;
    const r2 = await srv.api('POST', '/me/password', { token: fresh, ip: u.ip, body: { oldAuthKey: k1, newAuthKey: hex(32), encPrivateKey: b64(60), salt: b64(16), keepSessions: true } });
    assert.equal(r2.status, 200, r2.text);
    assert.equal((await srv.api('GET', '/bootstrap', { token: second, ip: u.ip })).status, 200, 'the upgrade keeps other devices signed in');
    assert.equal(audit('password_upgraded'), 1);
    assert.ok(srv.mails().slice(before).some((m) => m.to === `${u.username}@x.test` && /re-saved/.test(m.subject)), 'the owner is told');
  });

  test('adding an email another account has gives the same answer as a free one', async () => {
    const a = await srv.register(); await confirmEmail(srv, a, `${a.username}@x.test`);
    const b = await srv.register();
    const taken = await rs(b, 'POST', '/me/email', { email: `${a.username}@x.test`, authKey: b.authKey });
    const free = await rs(b, 'POST', '/me/email', { email: `${b.username}@free.test`, authKey: b.authKey });
    assert.equal(taken.status, 200, taken.text);
    assert.equal(free.status, 200, free.text);
    assert.deepEqual(Object.keys(taken.json).sort(), Object.keys(free.json).sort());
    // The address's owner is told why no code came; guessing a code at verify fails like any wrong code.
    const toA = srv.mails().filter((m) => m.to === `${a.username}@x.test`);
    assert.ok(toA.some((m) => /already has an account/.test(m.subject)));
    assert.ok(!toA.some((m) => /confirmation code/.test(m.subject) && m.text.includes(b.username)), 'no code for b went to a’s inbox');
    await rs(b, 'POST', '/me/email', { email: `${a.username}@x.test`, authKey: b.authKey });
    const v = await rs(b, 'POST', '/me/email/verify', { code: '123456' });
    assert.equal(v.status, 400);
    assert.match(v.json.error, /isn’t right/);
    assert.equal(srv.sql('SELECT email FROM users WHERE id = ?', a.id)[0].email, `${a.username}@x.test`);
    assert.equal(srv.sql('SELECT email FROM users WHERE id = ?', b.id)[0].email, null);
  });

  test('the media token belongs to its session: it stops working at logout, suspension and deletion', async () => {
    // 400 = token accepted (the empty URL is then refused), 403 = token refused.
    const gif = (t) => srv.call('GET', `/media/gif?t=${encodeURIComponent(t)}&u=`);
    const u = await srv.register();
    const t1 = (await rs(u, 'GET', '/bootstrap')).json.mediaToken;
    assert.equal((await gif(t1)).status, 400);
    assert.equal((await gif(t1.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).status, 403, 'forged');
    const other = (await srv.login(u)).json.token;
    const t2 = (await srv.api('GET', '/bootstrap', { token: other, ip: u.ip })).json.mediaToken;
    assert.equal((await srv.api('POST', '/auth/logout', { token: other, ip: u.ip })).status, 200);
    assert.equal((await gif(t2)).status, 403, 'after logout');
    assert.equal((await gif(t1)).status, 400, 'other sessions keep theirs');
    assert.equal((await srv.api('POST', `/admin/users/${u.id}/suspend`, { token: srv.owner.token, ip: srv.owner.ip, body: { reason: 'x' } })).status, 200);
    assert.equal((await gif(t1)).status, 403, 'while suspended');
    assert.equal((await srv.api('POST', `/admin/users/${u.id}/unsuspend`, { token: srv.owner.token, ip: srv.owner.ip })).status, 200);
    u.token = (await srv.login(u)).json.token; // suspension signed every device out
    const t3 = (await rs(u, 'GET', '/bootstrap')).json.mediaToken;
    assert.equal((await gif(t3)).status, 400);
    assert.equal((await rs(u, 'DELETE', '/me', { authKey: u.authKey, confirm: u.username })).status, 200);
    assert.equal((await gif(t3)).status, 403, 'after the account is deleted');
  });

  test('/auth/params is limited per network, so rotating IPv6 addresses in one /64 hits the limit', async () => {
    const st = [];
    for (let i = 0; i < 61; i++) st.push((await srv.api('GET', `/auth/params?username=x${i}`, { ip: `2001:db8:77:5::${(i + 1).toString(16)}` })).status);
    assert.deepEqual(st.slice(0, 60), Array(60).fill(200));
    assert.equal(st[60], 429);
    assert.equal((await srv.api('GET', '/auth/params?username=x', { ip: '2001:db8:77:6::1' })).status, 200, 'another network is unaffected');
  });
});
