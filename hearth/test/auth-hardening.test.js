// Sign-in, sign-up, reset links and sessions: regressions for the auth hardening batch.
//   - ADMIN_USERS names belong to the account that first took them (a freed name brings no powers to a stranger),
//     and the owner is settled once, so a later sign-up can't take the server over. A server set up with
//     ADMIN_USERS before anyone signed up still goes to its first listed name, whoever signed up first.
//   - Requests without a solved robot check don't use up anyone's sign-in limits; an account's usual networks
//     (whole IPv6 /64s) and devices can't be locked out by strangers; past the instance-wide limits the robot
//     check gets harder instead of turning everyone away.
//   - Reset links die when the password or email changes; IP bans cover existing sessions and the reset flow,
//     but never stop anyone logging out.
//   - With two-factor on, sensitive changes always take a fresh code, also right after a two-factor sign-in
//     (auth-6): a request that can't go through doesn't use one up, a right code doesn't count against the guess
//     limits, and a step-up ticket only stands in for the code on the change it was handed out for. A password
//     change, turning on two-factor and logging out the other devices with the password give this device a new
//     token, so a copy of the old one stops working, live connections and push subscriptions included; a copy alone
//     can't get a new token and lock the original device out (auth-11).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { startServer, confirmEmail, enable2fa, resetTokenFrom, newIp, hex, b64, sleep, solveCaptcha, solveCaptchas } = require('./helpers');

const as = (srv, u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const role = async (srv, u) => (await as(srv, u, 'GET', '/bootstrap')).json.me.staffRole;
// A sign-up as the app sends it, without the helper's automatic retry (so refusals can be checked).
function regBody(srv, username) {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { username, authKey: hex(32), publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), encPrivateKey: b64(120), kdfSalt: b64(16), acceptTos: srv.config.termsVersion || undefined };
}
const tryRegister = (srv, username, ip = newIp()) => srv.api('POST', '/auth/register', { ip, body: regBody(srv, username) });
const setting = (srv, k) => (srv.sql('SELECT value FROM instance_settings WHERE key = ?', k)[0] || {}).value;
const cliSetOwner = (srv, name) => spawnSync(process.execPath, ['server/cli.js', 'set-owner', name], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: srv.dir }, encoding: 'utf8' });

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
    const t = await as(srv, srv.owner, 'POST', '/admin/owner', { userId: heir.id, authKey: srv.owner.authKey });
    assert.equal(t.status, 200, t.text);
    assert.equal(await role(srv, heir), 'owner');
    assert.equal(await role(srv, srv.owner), 'admin');
    const cli = cliSetOwner(srv, srv.owner.username);
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    assert.equal(await role(srv, srv.owner), 'owner');
    assert.equal(srv.sql("SELECT COUNT(*) n FROM admin_log WHERE action = 'ownership_set_cli' AND target = ?", srv.owner.id)[0].n, 1, 'on the audit log');
    assert.equal((await srv.api('GET', '/admin/log/verify', { token: srv.owner.token, ip: srv.owner.ip })).json.ok, true, 'hash chain intact');
    // A deleted account can't be made the owner from the command line either.
    const gone = srv.sql('SELECT username FROM users WHERE deleted_at IS NOT NULL')[0].username;
    const bad = cliSetOwner(srv, gone);
    assert.notEqual(bad.status, 0);
    assert.equal(await role(srv, srv.owner), 'owner');
  });

  test('the CLI won’t make a suspended account the owner, and drops the new owner’s other staff role', async () => {
    const mod = await srv.register('mod' + hex(3));
    assert.equal((await as(srv, srv.owner, 'PUT', '/admin/staff', { userId: mod.id, role: 'moderator', authKey: srv.owner.authKey })).status, 200);
    assert.equal((await as(srv, srv.owner, 'POST', `/admin/users/${mod.id}/suspend`, { reason: 'x' })).status, 200);
    // A suspended owner couldn't sign in, and nobody outranks the owner to lift it: the server would have no owner.
    const sus = cliSetOwner(srv, mod.username);
    assert.notEqual(sus.status, 0);
    assert.match(sus.stderr, /suspended/);
    assert.equal(await role(srv, srv.owner), 'owner');
    assert.equal((await as(srv, srv.owner, 'POST', `/admin/users/${mod.id}/unsuspend`)).status, 200);
    const ok = cliSetOwner(srv, mod.username);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    mod.token = (await srv.login(mod)).json.token; // the suspension signed it out
    assert.equal(await role(srv, mod), 'owner');
    assert.ok(!(mod.id in JSON.parse(setting(srv, 'staffRoles') || '{}')), 'no moderator role left over');
    assert.equal(cliSetOwner(srv, srv.owner.username).status, 0); // back as it was
    assert.equal(await role(srv, mod), null, 'its moderator role went when it became the owner');
  });
});

describe('a server set up with ADMIN_USERS, where someone else signs up first', () => {
  let srv;
  // The documented setup: ADMIN_USERS names the operator before anyone has signed up, but another account (the
  // helper's 'owner' here: a friend, or a bot scanning for new servers) gets there first.
  before(async () => { srv = await startServer({ ADMIN_USERS: 'chief' }); });
  after(() => srv.stop());

  test('the first account only stands in; the listed name owns the server once it signs up, for good', async () => {
    assert.equal(await role(srv, srv.owner), 'owner', 'someone has to run it meanwhile');
    assert.equal(setting(srv, 'owner'), undefined, 'not written down');
    assert.equal(setting(srv, 'ownerAwaitsEnv'), 'chief');
    const plain = await srv.register('plain' + hex(3));
    assert.equal(await role(srv, plain), null);
    await srv.restart();
    assert.match(srv.log, /chief \(the first name in ADMIN_USERS[^)]*\) will own this server/);
    assert.equal(await role(srv, srv.owner), 'owner');
    const chief = await srv.register('chief');
    assert.equal(await role(srv, chief), 'owner');
    assert.equal(await role(srv, srv.owner), null, 'the stand-in had no role of its own');
    assert.equal(setting(srv, 'owner'), chief.id);
    assert.equal(setting(srv, 'ownerAwaitsEnv'), undefined);
    await srv.restart();
    assert.equal(await role(srv, chief), 'owner', 'kept after a restart');
    // Settled now: a rename doesn't move it, and the old name stays chief's.
    assert.equal((await as(srv, chief, 'POST', '/me/username', { username: 'chief2', authKey: chief.authKey })).status, 200);
    assert.equal(await role(srv, chief), 'owner');
    assert.equal((await tryRegister(srv, 'chief')).status, 409);
  });
});

describe('ADMIN_USERS names added later, and names held back by the update', () => {
  let srv; let carol;
  before(async () => { srv = await startServer(); }); // no ADMIN_USERS at first: the first account owns the server
  after(() => srv.stop());

  test('a name added to ADMIN_USERS later brings admin, never ownership', async () => {
    await srv.restart({ ADMIN_USERS: 'carol' });
    assert.match(srv.log, /ADMIN_USERS starts with carol, but owner owns this server/, 'the operator is told who owns it');
    carol = await srv.register('carol');
    assert.equal(await role(srv, carol), 'admin');
    assert.equal(await role(srv, srv.owner), 'owner');
  });

  test('upgrading: listed names nobody has are held back, since they may have been a renamed or deleted admin’s', async () => {
    // A server from before this version has no record of which account took which ADMIN_USERS name.
    srv.sql("DELETE FROM instance_settings WHERE key = 'envAdminClaims'");
    await srv.restart({ ADMIN_USERS: 'carol,boss,dave' });
    assert.match(srv.log, /ADMIN_USERS lists boss, dave, which no account has/);
    for (const name of ['boss', 'Dave']) {
      const r = await tryRegister(srv, name);
      assert.equal(r.status, 409, `${name}: ${r.text}`);
      assert.match(r.json.error, /reserved/);
    }
    const x = await srv.register('x' + hex(3));
    assert.equal((await as(srv, x, 'POST', '/me/username', { username: 'boss', authKey: x.authKey })).status, 409, 'or rename into');
    assert.equal(await role(srv, carol), 'admin', 'a name someone had at the update is still theirs');
    assert.equal(await role(srv, srv.owner), 'owner');
    // Taking a held-back name off ADMIN_USERS lets it go.
    await srv.restart({ ADMIN_USERS: 'carol,boss' });
    const dave = await srv.register('dave');
    assert.equal(await role(srv, dave), null);
    assert.equal((await tryRegister(srv, 'boss')).status, 409, 'still held back');
    // Only names listed at the update are held back: one added afterwards goes to whoever takes it first.
    await srv.restart({ ADMIN_USERS: 'carol,boss,erin' });
    assert.doesNotMatch(srv.log, /lists[^\n]*erin/);
    const erin = await srv.register('erin');
    assert.equal(await role(srv, erin), 'admin');
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

  test('an account’s own networks (the whole IPv6 /64) and devices keep their own limit', async () => {
    const home = '2001:db8:aa:1::1';
    const u = await srv.register(undefined, { ip: home });
    // A stranger uses up the account's limit for new networks, solving every robot check.
    const st = [];
    for (let i = 0; i < 11; i++) { const ip = newIp(); st.push((await login(ip, hex(32), { captcha: await solved(ip) }, u)).status); }
    assert.deepEqual(st, [...Array(10).fill(401), 429]);
    // The laptop picked a new address in the same /64 overnight (IPv6 privacy addresses): still its network.
    const v6 = '2001:db8:aa:1::2';
    const r = await login(v6, u.authKey, { captcha: await solved(v6) }, u);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.device, /^[\w-]{22}\.[\w-]{22}$/, 'a note for this device');
    // Somewhere new entirely (mobile data, travel): the note from that sign-in says it's the account's device.
    const away = newIp();
    const r2 = await login(away, u.authKey, { captcha: await solved(away), device: r.json.device }, u);
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.json.device, r.json.device, 'the same note is kept');
    // Without a note, a new device on a new network waits like anyone (the honest limit). Notes can't be made up
    // or borrowed from another account.
    const w = await srv.register();
    const wip = newIp();
    const wNote = (await login(wip, w.authKey, { captcha: await solved(wip) }, w)).json.device;
    const forged = r.json.device.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    for (const device of [undefined, forged, wNote, `${r.json.device}.x`]) {
      const ip = newIp();
      assert.equal((await login(ip, u.authKey, { captcha: await solved(ip), device }, u)).status, 429, String(device));
    }
    // A password change retires the notes handed out before it.
    const k2 = hex(32);
    assert.equal((await srv.api('POST', '/me/password', { token: r.json.token, ip: v6, body: { oldAuthKey: u.authKey, newAuthKey: k2, encPrivateKey: b64(60), salt: b64(16) } })).status, 200);
    const later = newIp();
    assert.equal((await login(later, k2, { captcha: await solved(later), device: r.json.device }, u)).status, 429);
  });

  test('failed sign-ins make the robot check harder for the whole /64, wherever its puzzles come from', async () => {
    const u = await srv.register();
    const net = (i) => `2001:db8:bb:7::${i}`;
    for (let i = 1; i <= 3; i++) assert.equal((await login(net(i), hex(32), { captcha: await solved(net(i)) }, u)).status, 401);
    assert.equal((await srv.api('GET', '/captcha?purpose=login', { ip: net(9) })).json.difficulty, 19, 'another address in the same /64');
    assert.equal((await srv.api('GET', '/captcha?purpose=login', { ip: newIp() })).json.difficulty, 18, 'other networks are unaffected');
    // An easier puzzle fetched from another network isn't accepted from this one.
    const easy = await solved(newIp());
    const r = await login(net(10), u.authKey, { captcha: easy }, u);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'captcha_harder');
    assert.equal((await login(net(10), u.authKey, { captcha: await solved(net(10)) }, u)).status, 200);
    // Fetching puzzles is limited per /64 too.
    const got = [];
    for (let i = 0; i < 61; i++) got.push((await srv.api('GET', '/captcha?purpose=login', { ip: `2001:db8:bb:8::${(i + 1).toString(16)}` })).status);
    assert.deepEqual(got.slice(0, 60), Array(60).fill(200));
    assert.equal(got[60], 429);
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

  test('password resets: the robot check comes first, and made-up names don’t use up the instance-wide cap', async () => {
    const u = resetter;
    const forgot = (ip, login, extra = {}) => srv.api('POST', '/auth/forgot', { ip, body: { login, ...extra } });
    // Without a solved check: turned away, nothing counted, no email.
    const before = (await srv.mails()).length;
    const st = [];
    for (let n = 0; n < 61; n++) { const ip = newIp(); for (let i = 0; i < 5; i++) st.push((await forgot(ip, i ? 'nobody' + hex(3) : u.username)).status); }
    assert.ok(st.every((x) => x === 400), JSON.stringify(st));
    assert.equal((await srv.mails()).length, before);
    // Made-up names with solved checks: answered like real ones, and still nothing counted.
    for (let i = 0; i < 3; i++) { const ip = newIp(); assert.equal((await forgot(ip, 'nobody' + hex(3), { captcha: await solved(ip) })).status, 200); }
    const ip = newIp();
    const r = await forgot(ip, u.username, { captcha: await solved(ip) });
    assert.equal(r.status, 200, r.text);
    assert.ok((await srv.mails()).slice(before).some((m) => m.to === `${u.username}@example.test` && /reset your password/.test(m.subject)), 'the real reset email went out');
  });
});

// ------------------------------------------------------------------ busy times (auth-3)
describe('busy times: past the instance-wide sign-up limit the robot check gets harder, nobody is turned away', () => {
  let srv;
  before(async () => {
    srv = await startServer();
    assert.equal((await srv.api('PUT', '/admin/registration', { token: srv.owner.token, ip: srv.owner.ip, body: { captchaRegister: 'on', captchaLogin: 'on' } })).status, 200);
  });
  after(() => srv.stop());
  const challenge = async (ip, purpose = 'register') => (await srv.api('GET', `/captcha?purpose=${purpose}`, { ip })).json;

  test('junk with solved checks past the limit only makes the check harder; a real sign-up still gets in', async () => {
    const early = solveCaptcha(await challenge(newIp())); // an ordinary check, solved before the rush
    assert.equal(early.difficulty, 18);
    // 119 junk sign-ups, each with a solved check (24 networks, 5 each): with the owner's, the limit (120) is used up.
    const asks = [];
    for (let n = 0; n < 24; n++) { const ip = newIp(); for (let i = 0; i < 5 && asks.length < 119; i++) asks.push({ ip, c: await challenge(ip) }); }
    const sols = await solveCaptchas(asks.map((a) => a.c));
    for (let i = 0; i < asks.length; i++) {
      const r = await srv.api('POST', '/auth/register', { ip: asks[i].ip, body: { ...regBody(srv, '!'), captcha: sols[i] } });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /Usernames are/, 'got past the robot check');
    }
    assert.equal((await challenge(newIp())).difficulty, 19, 'a harder check for everyone now');
    assert.equal((await challenge(newIp(), 'login')).difficulty, 18, 'signing in isn’t affected');
    // A real person: the check solved before the rush is too easy now (the app then solves a new one by itself)...
    const ip = newIp();
    const body = regBody(srv, 'legit' + hex(3));
    const tooEasy = await srv.api('POST', '/auth/register', { ip, body: { ...body, captcha: early } });
    assert.equal(tooEasy.status, 400);
    assert.equal(tooEasy.json.code, 'captcha_harder');
    // ...and with the harder one they're in, not told to come back in an hour.
    const ok = await srv.api('POST', '/auth/register', { ip, body: { ...body, captcha: solveCaptcha(await challenge(ip)) } });
    assert.equal(ok.status, 200, ok.text);
    // With the robot check switched off there's nothing to make harder: then the limit turns sign-ups away.
    assert.equal((await srv.api('PUT', '/admin/registration', { token: srv.owner.token, ip: srv.owner.ip, body: { captchaRegister: 'off' } })).status, 200);
    assert.equal((await tryRegister(srv, 'off' + hex(3))).status, 429);
  });
});

// ------------------------------------------------------------------ reset links, bans, sessions (auth-4, 8, 9, 10, 13)
describe('reset links, IP bans and sessions', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.stop());
  const rs = (u, method, p, body) => as(srv, u, method, p, body);

  async function linkFor(u, email) {
    const before = (await srv.mails()).length;
    assert.equal((await srv.api('POST', '/auth/forgot', { ip: newIp(), body: { login: u.username } })).status, 200);
    const m = (await srv.mails()).slice(before).find((x) => x.to === email && /reset your password/.test(x.subject));
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
    u.token = pw.json.token; // the session goes on with a new token (auth-11)
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

  test('logging out works from a banned address (and in maintenance), and really ends the session', async () => {
    const u = await srv.register();
    const ban = await srv.api('POST', '/admin/ip-bans', { token: srv.owner.token, ip: srv.owner.ip, body: { ip: u.ip, reason: 'spam' } });
    assert.equal(ban.status, 200, ban.text);
    assert.equal((await rs(u, 'GET', '/bootstrap')).status, 403);
    // The app logs out when it's turned away; if the server refused that, the session would stay live for
    // anyone holding a copy of the token.
    assert.equal((await rs(u, 'POST', '/auth/logout')).status, 200);
    assert.equal((await srv.api('GET', '/bootstrap', { token: u.token, ip: newIp() })).status, 401, 'dead everywhere');
    await srv.api('DELETE', '/admin/ip-bans', { token: srv.owner.token, ip: srv.owner.ip, body: { ip: u.ip } });
    assert.equal((await rs(u, 'GET', '/bootstrap')).status, 401, 'and after the ban is lifted');
    const m = await srv.register();
    assert.equal((await srv.api('PUT', '/admin/maintenance', { token: srv.owner.token, ip: srv.owner.ip, body: { text: 'Back soon' } })).status, 200);
    try {
      assert.equal((await rs(m, 'GET', '/bootstrap')).status, 503);
      assert.equal((await rs(m, 'POST', '/auth/logout')).status, 200);
    } finally { await srv.api('PUT', '/admin/maintenance', { token: srv.owner.token, ip: srv.owner.ip, body: { text: '' } }); }
    assert.equal((await rs(m, 'GET', '/bootstrap')).status, 401);
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
    const before = (await srv.mails()).length;
    const r2 = await srv.api('POST', '/me/password', { token: fresh, ip: u.ip, body: { oldAuthKey: k1, newAuthKey: hex(32), encPrivateKey: b64(60), salt: b64(16), keepSessions: true } });
    assert.equal(r2.status, 200, r2.text);
    assert.equal((await srv.api('GET', '/bootstrap', { token: second, ip: u.ip })).status, 200, 'the upgrade keeps other devices signed in');
    assert.equal(audit('password_upgraded'), 1);
    assert.ok((await srv.mails()).slice(before).some((m) => m.to === `${u.username}@x.test` && /re-saved/.test(m.subject)), 'the owner is told');
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
    const toA = (await srv.mails()).filter((m) => m.to === `${a.username}@x.test`);
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

// ------------------------------------------------------------------ step-up codes and session tokens (auth-6, auth-11)
// auth-6: with two-factor on, a token copied at sign-in plus the typed password used to be enough for any sensitive
// change for 10 minutes. Now those always take a fresh code; only starting a data export and clearing unused files
// still count a recent two-factor sign-in. auth-11: changing the password, turning on two-factor and logging out the
// other devices give this device a new token in place, so a copy of the old one stops working, live connections too.
describe('step-up codes and session tokens (auth-6, auth-11)', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.stop());
  const rs = (u, method, p, body) => as(srv, u, method, p, body);
  const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const until = async (fn, ms = 5000) => { for (let t = 0; t < ms; t += 50) { if (await fn()) return true; await sleep(50); } return false; };
  const sessionOf = (token) => srv.sql('SELECT * FROM sessions WHERE token_hash = ?', sha(token))[0];
  const newPw = (u) => ({ oldAuthKey: u.authKey, newAuthKey: hex(32), encPrivateKey: b64(60), salt: b64(16) });
  // Someone with two-factor on who has just signed in with a code: the 10 minutes the old shortcut covered.
  async function justSignedIn(u = null) {
    if (!u) u = await srv.register();
    const tf = await enable2fa(srv, u);
    const r = await srv.login(u, { backupCode: tf.backupCodes.pop() });
    assert.equal(r.status, 200, r.text);
    u.token = r.json.token;
    assert.ok(Date.now() - sessionOf(u.token).mfa_at < 60000, 'this sign-in passed two-factor just now');
    return { u, codes: tf.backupCodes, tf };
  }
  // A live connection, and what the server said before closing it.
  async function watched(token) {
    const s = await srv.socket(token);
    const said = [];
    s.on('session:revoked', (p) => said.push(p));
    return { s, said };
  }

  test('auth-6: right after a two-factor sign-in, changing the password or email still needs a code', async () => {
    const { u, codes } = await justSignedIn();
    const pw = newPw(u);
    let r = await rs(u, 'POST', '/me/password', pw);
    assert.deepEqual([r.status, r.json.code], [401, 'need_2fa'], 'the password alone isn’t enough, even minutes after signing in with a code');
    r = await rs(u, 'POST', '/me/email', { authKey: u.authKey, email: `${u.username}@new.test` });
    assert.deepEqual([r.status, r.json.code], [401, 'need_2fa']);
    assert.equal((await srv.login(u)).json.code, 'need_2fa', 'the password didn’t change');
    assert.equal(srv.sql("SELECT COUNT(*) n FROM auth_tokens WHERE user_id = ? AND kind = 'email'", u.id)[0].n, 0, 'no email code was sent');
    // With a code, both go through.
    r = await rs(u, 'POST', '/me/password', { ...pw, backupCode: codes.pop() });
    assert.equal(r.status, 200, r.text);
    u.token = r.json.token; u.authKey = pw.newAuthKey;
    r = await rs(u, 'POST', '/me/email', { authKey: u.authKey, email: `${u.username}@new.test`, backupCode: codes.pop() });
    assert.equal(r.status, 200, r.text);
    // The session that turned two-factor on has just passed it too, and gets no shortcut either.
    const v = await srv.register();
    await enable2fa(srv, v);
    assert.equal((await rs(v, 'POST', '/me/password', newPw(v))).json.code, 'need_2fa');
    assert.equal((await rs(v, 'POST', '/me/email', { authKey: v.authKey, email: `${v.username}@new.test` })).json.code, 'need_2fa');
  });

  test('auth-6: the recovery key, the locked key, the username and deleting the account need a code right after sign-in too', async () => {
    const { u, codes } = await justSignedIn();
    const authKey = u.authKey;
    for (const [method, p, body] of [
      ['PUT', '/me/recovery', { authKey, encPrivateKeyRecovery: b64(150), recoverySalt: b64(16) }],
      ['DELETE', '/me/recovery', { authKey }],
      ['DELETE', '/me/email', { authKey }],
      ['POST', '/me/keys/wrapped', { authKey }],
      ['POST', '/me/username', { authKey, username: `n${hex(4)}` }],
      ['DELETE', '/me', { authKey, confirm: u.username }],
    ]) {
      const r = await rs(u, method, p, body);
      assert.deepEqual([r.status, r.json.code], [401, 'need_2fa'], `${method} ${p}`);
    }
    const row = srv.sql('SELECT username, deleted_at, enc_private_key_recovery FROM users WHERE id = ?', u.id)[0];
    assert.deepEqual([row.username, row.deleted_at, row.enc_private_key_recovery], [u.username, null, null], 'nothing changed');
    assert.equal((await rs(u, 'POST', '/me/keys/wrapped', { authKey, backupCode: codes.pop() })).status, 200, 'with a code it works');
  });

  test('auth-6: handing over control, a secret or money, or deleting for good needs a code right after sign-in; a data export and clearing unused files don’t', async () => {
    const owner = srv.owner;
    const { codes } = await justSignedIn(owner);
    const authKey = owner.authKey;
    const heir = await srv.register();
    const s = (await rs(owner, 'POST', '/servers', { name: 'Step-up HQ' })).json;
    const code = (await rs(owner, 'POST', `/servers/${s.id}/invites`, { expiresHours: 0 })).json.code;
    assert.equal((await rs(heir, 'POST', `/invites/${code}/join`)).status, 200);
    const bot = (await rs(owner, 'POST', '/bots', { name: `stepbot${hex(2)}`, scopes: [] })).json.bot;
    assert.ok(bot && bot.id, 'a bot to make tokens for');
    for (const [method, p, body] of [
      ['PUT', '/admin/staff', { userId: heir.id, role: 'moderator', authKey }],
      ['POST', '/admin/owner', { userId: heir.id, authKey }],
      ['PUT', '/admin/owner', { funding: { url: 'https://ko-fi.com/elsewhere' }, authKey }],
      ['POST', '/admin/backups/key', { authKey }],
      ['PUT', '/admin/turn', { urls: 'turn:203.0.113.9:3478', authKey }],
      ['POST', '/admin/regions', { name: 'Elsewhere', origin: 'https://chat.example.test', authKey }],
      ['PUT', '/admin/alerts', { enabled: false, authKey }],
      ['POST', `/bots/${bot.id}/tokens`, { authKey }],
      ['POST', `/bots/${bot.id}/webhook-secret`, { authKey }],
      ['POST', `/servers/${s.id}/transfer`, { userId: heir.id, authKey }],
      ['DELETE', `/servers/${s.id}`, { authKey }],
    ]) {
      const r = await rs(owner, method, p, body);
      assert.deepEqual([r.status, r.json && r.json.code], [401, 'need_2fa'], `${method} ${p}`);
    }
    assert.equal(srv.sql('SELECT owner_id FROM servers WHERE id = ?', s.id)[0].owner_id, owner.id, 'the server is still theirs');
    assert.ok(!(await role(srv, heir)), 'no staff role was given');
    // The two low-risk ones: a two-factor sign-in in the last 10 minutes still counts.
    let r = await rs(owner, 'POST', '/me/export', { authKey });
    assert.equal(r.status, 200, r.text);
    r = await rs(owner, 'POST', '/admin/storage/cleanup', { authKey });
    assert.equal(r.status, 200, r.text);
    // …but only for those 10 minutes.
    srv.sql('UPDATE sessions SET mfa_at = ? WHERE token_hash = ?', Date.now() - 11 * 60000, sha(owner.token));
    assert.equal((await rs(owner, 'POST', '/me/export', { authKey })).json.code, 'need_2fa');
    // With a code, the others go through as before.
    r = await rs(owner, 'DELETE', `/servers/${s.id}`, { authKey, backupCode: codes.pop() });
    assert.equal(r.status, 200, r.text);
  });

  test('auth-6: a step-up ticket stands in for the code once, only for the session that sent the code', async () => {
    const { u, codes } = await justSignedIn();
    const rec = () => ({ authKey: u.authKey, encPrivateKeyRecovery: b64(150), recoverySalt: b64(16) });
    // Fetching the locked key with a code hands back a ticket for the next request of the same change.
    let k = await rs(u, 'POST', '/me/keys/wrapped', { authKey: u.authKey, backupCode: codes.pop() });
    assert.equal(k.status, 200, k.text);
    const ticket = k.json.stepUpTicket;
    assert.match(ticket, /^[\w-]{40,}$/);
    let r = await rs(u, 'PUT', '/me/recovery', { ...rec(), stepUpTicket: ticket });
    assert.equal(r.status, 200, r.text);
    assert.equal((await rs(u, 'PUT', '/me/recovery', { ...rec(), stepUpTicket: ticket })).json.code, 'need_2fa', 'it works once');
    // Another session (a copied token is one) can't use it, and trying uses it up.
    k = await rs(u, 'POST', '/me/keys/wrapped', { authKey: u.authKey, backupCode: codes.pop() });
    const other = { ...u, token: (await srv.login(u, { backupCode: codes.pop() })).json.token };
    assert.equal((await rs(other, 'PUT', '/me/recovery', { ...rec(), stepUpTicket: k.json.stepUpTicket })).json.code, 'need_2fa');
    assert.equal((await rs(u, 'PUT', '/me/recovery', { ...rec(), stepUpTicket: k.json.stepUpTicket })).json.code, 'need_2fa');
    // A ticket comes only from a typed code: it isn't good for fetching the locked key again (which would hand out
    // the next one, and so on).
    k = await rs(u, 'POST', '/me/keys/wrapped', { authKey: u.authKey, backupCode: codes.pop() });
    r = await rs(u, 'POST', '/me/keys/wrapped', { authKey: u.authKey, stepUpTicket: k.json.stepUpTicket });
    assert.deepEqual([r.status, r.json.code], [401, 'need_2fa']);
    assert.equal(r.json.stepUpTicket, undefined);
    // It doesn't stand in for the password, and a made-up one is just a missing code.
    k = await rs(u, 'POST', '/me/keys/wrapped', { authKey: u.authKey, backupCode: codes.pop() });
    assert.equal((await rs(u, 'PUT', '/me/recovery', { ...rec(), authKey: hex(32), stepUpTicket: k.json.stepUpTicket })).json.code, 'bad_password');
    assert.equal((await rs(u, 'PUT', '/me/recovery', { ...rec(), stepUpTicket: 'x'.repeat(43) })).json.code, 'need_2fa');
    // Without two-factor there's no code, so no ticket.
    const plain = await srv.register();
    const p = await rs(plain, 'POST', '/me/keys/wrapped', { authKey: plain.authKey });
    assert.equal(p.status, 200);
    assert.equal(p.json.stepUpTicket, undefined);
  });

  test('auth-6: an old-format account with two-factor re-saves its password right after signing in, with that sign-in’s ticket', async () => {
    const u = await srv.register();
    const { backupCodes } = await enable2fa(srv, u);
    const elsewhere = (await srv.login(u, { backupCode: backupCodes.pop() })).json.token;
    assert.equal((await srv.login(u, { backupCode: backupCodes.pop() })).json.stepUpTicket, undefined, 'an up-to-date account gets no ticket');
    srv.sql("UPDATE users SET kdf = 'pbkdf2' WHERE id = ?", u.id); // from before the Argon2id upgrade
    const r = await srv.login(u, { backupCode: backupCodes.pop() });
    assert.equal(r.status, 200, r.text);
    u.token = r.json.token;
    const body = { ...newPw(u), keepSessions: true };
    assert.equal((await rs(u, 'POST', '/me/password', body)).json.code, 'need_2fa', 'the code used to sign in can’t be used again');
    const up = await rs(u, 'POST', '/me/password', { ...body, stepUpTicket: r.json.stepUpTicket });
    assert.equal(up.status, 200, up.text);
    assert.equal((await srv.api('GET', '/bootstrap', { token: elsewhere, ip: u.ip })).status, 200, 'the upgrade keeps other devices signed in');
    assert.equal((await srv.api('GET', '/bootstrap', { token: up.json.token, ip: u.ip })).status, 200);
    // That ticket is good for the re-save only: not for deleting the account, a full password change or the locked
    // key (and shown anywhere, it's used up).
    u.authKey = body.newAuthKey;
    srv.sql("UPDATE users SET kdf = 'pbkdf2' WHERE id = ?", u.id);
    for (const [method, p, body] of [
      ['DELETE', '/me', { authKey: u.authKey, confirm: u.username }],
      ['POST', '/me/password', newPw(u)],
      ['POST', '/me/keys/wrapped', { authKey: u.authKey }],
    ]) {
      const t = await srv.login(u, { backupCode: backupCodes.pop() });
      assert.ok(t.json.stepUpTicket, 'an old-format sign-in with two-factor gets one');
      const v = { ...u, token: t.json.token };
      const r2 = await rs(v, method, p, { ...body, stepUpTicket: t.json.stepUpTicket });
      assert.deepEqual([r2.status, r2.json.code], [401, 'need_2fa'], `${method} ${p}`);
      assert.equal((await rs(v, 'POST', '/me/password', { ...newPw(u), keepSessions: true, stepUpTicket: t.json.stepUpTicket })).json.code, 'need_2fa', 'used up');
    }
    assert.equal(srv.sql('SELECT deleted_at FROM users WHERE id = ?', u.id)[0].deleted_at, null);
  });

  test('auth-6: the locked key’s step-up ticket is good for a new password, a recovery key or deleting the account, nothing else', async () => {
    const { u, codes } = await justSignedIn();
    const s = (await rs(u, 'POST', '/servers', { name: 'Ticket HQ' })).json;
    const ticket = async () => (await rs(u, 'POST', '/me/keys/wrapped', { authKey: u.authKey, backupCode: codes.pop() })).json.stepUpTicket;
    const rec = (t) => ({ authKey: u.authKey, encPrivateKeyRecovery: b64(150), recoverySalt: b64(16), stepUpTicket: t });
    for (const [method, p, body] of [
      ['DELETE', `/servers/${s.id}`, {}],
      ['POST', '/me/email', { email: `${u.username}@ticket.test` }],
      ['POST', '/me/username', { username: `n${hex(4)}` }],
    ]) {
      const t = await ticket();
      const r = await rs(u, method, p, { ...body, authKey: u.authKey, stepUpTicket: t });
      assert.deepEqual([r.status, r.json.code], [401, 'need_2fa'], `${method} ${p}`);
      // …and trying it there used it up.
      assert.equal((await rs(u, 'PUT', '/me/recovery', rec(t))).json.code, 'need_2fa');
    }
    assert.equal(srv.sql('SELECT COUNT(*) n FROM servers WHERE id = ?', s.id)[0].n, 1, 'the server is still there');
    assert.equal(srv.sql('SELECT username FROM users WHERE id = ?', u.id)[0].username, u.username);
    // Where it does count, it works.
    const r = await rs(u, 'PUT', '/me/recovery', rec(await ticket()));
    assert.equal(r.status, 200, r.text);
  });

  test('auth-6: a request that can’t go through is turned down before the code is used up; one turned down after says so', async () => {
    const { u, codes } = await justSignedIn();
    const left = () => JSON.parse(srv.sql('SELECT backup_codes FROM users WHERE id = ?', u.id)[0].backup_codes).length;
    // A mistyped email: the code stays good, and the corrected request goes through with it.
    let code = codes.pop();
    let n = left();
    let r = await rs(u, 'POST', '/me/email', { authKey: u.authKey, email: 'me@nowhere', backupCode: code });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.codeUsed, undefined);
    assert.equal(left(), n, 'the backup code wasn’t used');
    r = await rs(u, 'POST', '/me/email', { authKey: u.authKey, email: `${u.username}@fixed.test`, backupCode: code });
    assert.equal(r.status, 200, r.text);
    // A taken username, the same.
    const other = await srv.register();
    code = codes.pop(); n = left();
    r = await rs(u, 'POST', '/me/username', { authKey: u.authKey, username: other.username, backupCode: code });
    assert.deepEqual([r.status, r.json.codeUsed], [409, undefined]);
    assert.equal(left(), n);
    r = await rs(u, 'POST', '/me/username', { authKey: u.authKey, username: `n${hex(4)}`, backupCode: code });
    assert.equal(r.status, 200, r.text);
    u.username = r.json.username;
    // Broken key material for a new password or a recovery key, and deleting an account that still owns a server.
    const s = (await rs(u, 'POST', '/servers', { name: 'Still mine' })).json;
    code = codes.pop(); n = left();
    for (const [method, p, body] of [
      ['POST', '/me/password', { ...newPw(u), newAuthKey: 'nope' }],
      ['PUT', '/me/recovery', { authKey: u.authKey, encPrivateKeyRecovery: '', recoverySalt: b64(16) }],
      ['DELETE', '/me', { authKey: u.authKey, confirm: u.username }],
    ]) {
      r = await rs(u, method, p, { ...body, backupCode: code });
      assert.equal(r.status, 400, `${method} ${p}: ${r.text}`);
      assert.equal(left(), n, `${method} ${p} didn’t use the code`);
    }
    assert.equal(srv.sql('SELECT deleted_at FROM users WHERE id = ?', u.id)[0].deleted_at, null);
    assert.ok(s.id);
    // Turned down after the code was checked (here: a fourth name change in a day): the answer says the code is
    // spent, so the app asks for a new one rather than sending it again.
    for (let i = 0; i < 2; i++) {
      r = await rs(u, 'POST', '/me/username', { authKey: u.authKey, username: `n${hex(4)}`, backupCode: codes.pop() });
      assert.equal(r.status, 200, r.text);
    }
    code = codes.pop(); n = left();
    r = await rs(u, 'POST', '/me/username', { authKey: u.authKey, username: `n${hex(4)}`, backupCode: code });
    assert.deepEqual([r.status, r.json.codeUsed], [429, true], r.text);
    assert.equal(left(), n - 1);
    assert.equal((await rs(u, 'POST', '/me/username', { authKey: u.authKey, username: `n${hex(4)}`, backupCode: code })).json.code, 'bad_2fa', 'it can’t be used again');
    // A wrong code or password isn't "spent".
    r = await rs(u, 'POST', '/me/keys/wrapped', { authKey: hex(32), backupCode: codes[0] });
    assert.deepEqual([r.json.code, r.json.codeUsed], ['bad_password', undefined]);
  });

  test('auth-6: a right code gives its tries back, so a run of confirmed changes doesn’t block signing in with two-factor', async () => {
    const u = await srv.register();
    const { backupCodes } = await enable2fa(srv, u);
    // Nine changes in a row, each with its own code (more than the 8 tries per 15 minutes that codes share with
    // signing in).
    for (let i = 1; i <= 9; i++) {
      const r = await rs(u, 'POST', '/me/keys/wrapped', { authKey: u.authKey, backupCode: backupCodes.pop() });
      assert.equal(r.status, 200, `change ${i}: ${r.text}`);
    }
    const r = await srv.login(u, { backupCode: backupCodes.pop() });
    assert.equal(r.status, 200, r.text);
    // Wrong codes still count, as before.
    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await rs(u, 'POST', '/me/keys/wrapped', { authKey: u.authKey, backupCode: 'aaaaa-bbbbb' })).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 429]);
  });

  test('auth-11: a password change gives this device a new token; the old one, and a live connection on it, stop working', async () => {
    const u = await srv.register();
    const old = u.token;
    const sid = sessionOf(old).id;
    const live = await watched(old);
    const r = await rs(u, 'POST', '/me/password', newPw(u));
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.token, /^[0-9a-f]{64}$/);
    assert.notEqual(r.json.token, old);
    assert.equal((await srv.api('GET', '/bootstrap', { token: old, ip: u.ip })).status, 401, 'the old token (and any copy of it) is out');
    assert.equal((await srv.api('GET', '/bootstrap', { token: r.json.token, ip: u.ip })).status, 200, 'the new one works');
    const now = sessionOf(r.json.token);
    assert.equal(now.id, sid, 'the same session, so its place in Signed-in devices stays');
    assert.equal(now.revoked_at, null);
    assert.ok(await until(() => live.s.disconnected), 'the connection on the old token is closed');
    assert.deepEqual(live.said, [{ reason: 'token_rotated' }], 'and told why, which isn’t a sign-out');
    await assert.rejects(srv.socket(old), /unauthorized/);
    (await srv.socket(r.json.token)).close();
  });

  test('auth-11: turning on two-factor gives this device a new token too', async () => {
    const u = await srv.register();
    const old = u.token;
    const sid = sessionOf(old).id;
    const live = await watched(old);
    await enable2fa(srv, u); // (the helper takes the new token from the answer)
    assert.notEqual(u.token, old);
    assert.equal((await srv.api('GET', '/bootstrap', { token: old, ip: u.ip })).status, 401);
    assert.equal((await rs(u, 'GET', '/bootstrap')).status, 200);
    assert.equal(sessionOf(u.token).id, sid);
    assert.ok(sessionOf(u.token).mfa_at, 'and it still counts as having passed two-factor');
    assert.ok(await until(() => live.s.disconnected));
    assert.deepEqual(live.said, [{ reason: 'token_rotated' }]);
  });

  test('auth-11: “log out all other devices” with the password gives this device a new token too, even with no other device signed in', async () => {
    const u = await srv.register();
    const second = (await srv.login(u)).json.token;
    const old = u.token;
    const live = await watched(old);
    const r = await rs(u, 'POST', '/me/sessions/revoke-others', { authKey: u.authKey });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.count, 1);
    assert.equal((await srv.api('GET', '/bootstrap', { token: second, ip: u.ip })).status, 401, 'the other device is signed out');
    assert.equal((await srv.api('GET', '/bootstrap', { token: old, ip: u.ip })).status, 401, 'so is a copy of this one');
    assert.equal((await srv.api('GET', '/bootstrap', { token: r.json.token, ip: u.ip })).status, 200);
    assert.ok(await until(() => live.s.disconnected));
    assert.deepEqual(live.said, [{ reason: 'token_rotated' }]);
    u.token = r.json.token;
    const again = await rs(u, 'POST', '/me/sessions/revoke-others', { authKey: u.authKey });
    assert.equal(again.json.count, 0);
    assert.notEqual(again.json.token, u.token);
    assert.equal((await rs(u, 'GET', '/bootstrap')).status, 401);
    assert.equal((await srv.api('GET', '/bootstrap', { token: again.json.token, ip: u.ip })).status, 200);
    // With two-factor on, it takes a fresh code too, like a password change.
    u.token = again.json.token;
    const { backupCodes } = await enable2fa(srv, u);
    assert.equal((await rs(u, 'POST', '/me/sessions/revoke-others', { authKey: u.authKey })).json.code, 'need_2fa');
    const third = await rs(u, 'POST', '/me/sessions/revoke-others', { authKey: u.authKey, backupCode: backupCodes.pop() });
    assert.equal(third.status, 200, third.text);
    assert.match(third.json.token, /^[0-9a-f]{64}$/);
  });

  test('auth-11: a new token ends the media token handed out with the old one; the app gets a working one when it reconnects', async () => {
    // 400 = token accepted (the empty URL is then refused), 403 = token refused.
    const gif = (t) => srv.call('GET', `/media/gif?t=${encodeURIComponent(t)}&u=`);
    const u = await srv.register();
    const before = (await rs(u, 'GET', '/bootstrap')).json.mediaToken; // what the app, or a copy of its token, holds
    assert.equal((await gif(before)).status, 400);
    const r = await rs(u, 'POST', '/me/sessions/revoke-others', { authKey: u.authKey });
    assert.equal(r.status, 200, r.text);
    assert.equal((await gif(before)).status, 403, 'a copy of the old sign-in token can\u2019t keep fetching through the picture proxies');
    u.token = r.json.token;
    const after = (await rs(u, 'GET', '/bootstrap')).json.mediaToken;
    assert.notEqual(after, before);
    assert.equal((await gif(after)).status, 400, 'the new one works');
    // The same for a password change.
    const pw = newPw(u);
    const p = await rs(u, 'POST', '/me/password', pw);
    assert.equal(p.status, 200, p.text);
    assert.equal((await gif(after)).status, 403);
  });

  test('auth-11: a copy of the token alone can’t get a new one and lock the original device out', async () => {
    const u = await srv.register();
    const copy = u.token; // the same token, used from somewhere else
    const elsewhere = { ...u, ip: newIp() };
    const live = await watched(u.token);
    const victimOther = (await srv.login(u)).json.token;
    // Without the password, "log out all other devices" signs out the other sessions (as it always did), but this
    // session keeps its token: no new one is handed out.
    let r = await rs(elsewhere, 'POST', '/me/sessions/revoke-others');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.token, undefined, 'no new token without the password');
    assert.equal((await srv.api('GET', '/bootstrap', { token: victimOther, ip: u.ip })).status, 401);
    // A wrong password (or a made-up one) changes nothing either.
    r = await rs(elsewhere, 'POST', '/me/sessions/revoke-others', { authKey: hex(32) });
    assert.deepEqual([r.status, r.json.code], [401, 'bad_password']);
    await sleep(300);
    assert.equal(live.s.connected, true, 'the original device’s connection stays');
    assert.deepEqual(live.said, []);
    assert.equal((await rs(u, 'GET', '/bootstrap')).status, 200, 'and it carries on');
    // Its "Log out" still ends the session, copy included.
    assert.equal((await rs(u, 'POST', '/auth/logout')).status, 200);
    assert.equal((await srv.api('GET', '/bootstrap', { token: copy, ip: elsewhere.ip })).status, 401);
    assert.ok(sessionOf(copy).revoked_at);
  });

  test('auth-11: the app’s connection comes back with the new token; a copy that never gets one is signed out, and told why', async () => {
    const { watchConnection } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'conn.js')).href);
    const { io } = require('socket.io-client');
    const u = await srv.register();
    const old = u.token;
    // This browser's tab: asks for the token on every connect, like app.js. Its new token arrives a moment after the
    // server has already closed the connection (another tab changed the password and stores it).
    let current = old;
    let used = old;
    const tab = io(srv.base, { auth: (cb) => { used = current; cb({ token: current }); }, transports: ['websocket'], reconnection: false, forceNew: true });
    // A copy of the token elsewhere, running the same app code.
    const copy = io(srv.base, { auth: { token: old }, transports: ['websocket'], reconnection: false, forceNew: true });
    try {
      await until(() => tab.connected && copy.connected);
      const tabOut = []; const copyOut = [];
      watchConnection(tab, { onSignedOut: (r) => tabOut.push(r), retryMs: 100, tokenMoved: (ms) => until(() => current !== used, ms) });
      // (Nothing ever gives the copy a new token; it waits a little less than the app would, to keep this quick.)
      watchConnection(copy, { onSignedOut: (r) => copyOut.push(r), retryMs: 100, tokenMoved: (ms) => sleep(Math.min(ms, 300)).then(() => false) });
      const r = await rs(u, 'POST', '/me/password', newPw(u));
      assert.equal(r.status, 200, r.text);
      assert.ok(await until(() => !tab.connected), 'closed');
      await sleep(300);
      current = r.json.token;
      assert.ok(await until(() => tab.connected, 5000), 'the tab is back, on the new token');
      assert.equal(used, r.json.token);
      assert.deepEqual(tabOut, [], 'and was never signed out (which would wipe the keys every tab here uses)');
      assert.ok(await until(() => copyOut.length > 0, 12000), 'the copy is signed out');
      assert.deepEqual(copyOut, ['token_rotated'], 'said as such, so the app can explain it');
      assert.equal(copy.connected, false);
    } finally { tab.close(); copy.close(); }
  });

  test('auth-11: the minute sweep closes a connection still on a token its session has replaced', { timeout: 90000 }, async () => {
    const u = await srv.register();
    const live = await watched(u.token);
    // As if the token changed without this connection being closed then: only the sweep can catch it.
    srv.sql('UPDATE sessions SET token_hash = ? WHERE token_hash = ?', sha(hex(32)), sha(u.token));
    assert.ok(await until(() => live.s.disconnected, 75000), 'closed within a minute or so');
    assert.deepEqual(live.said, [{ reason: 'token_rotated' }]);
  });
});
