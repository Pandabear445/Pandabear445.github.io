// Admin and owner tools: what a stolen session, a rogue moderator or admin, or someone with only the database can
// and can't do, and backups that never leave plaintext behind. Each test proves the refusal and that the
// legitimate use still works.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer, confirmEmail, hex, sleep } = require('./helpers');

const WHSEC = 'whsec_' + 'a'.repeat(32);
const PAY_WHSEC = 'whsec_' + 'p'.repeat(32);
let srv; let fake; let stripeDown = false; let stripeDelay = 0; const stripeCalls = []; const subs = new Map();
let owner; let admin; let mod; let alice; let bob; let space; let text;
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');
const logRows = (action) => srv.sql('SELECT * FROM admin_log WHERE action = ? ORDER BY id', action);
const channelMsg = (author) => {
  const id = 'm' + hex(8);
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, text.id, author.id, '', cipher(), 1, Date.now());
  return id;
};
async function dmMsg(from, to) {
  const dm = (await as(from, 'POST', '/dms', { userId: to.id })).json;
  const sent = await as(from, 'POST', `/dms/${dm.id}/messages`, { ciphertext: cipher() });
  assert.equal(sent.status, 200, sent.text);
  return sent.json.id;
}
// Stripe-style signature (same scheme for both webhooks).
function signed(event, secret) {
  const body = JSON.stringify(event); const t = Math.floor(Date.now() / 1000);
  return { body, sig: `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` };
}
async function hook(p, event, secret) {
  const { body, sig } = signed(event, secret);
  const r = await fetch(`${srv.base}/api/pay/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
  return { status: r.status, json: await r.json().catch(() => null) };
}

before(async () => {
  // A fake Stripe that can be "down" (500 on subscription calls), like during an outage.
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      stripeCalls.push({ method: req.method, url: req.url });
      const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') return send({ id: 'cs_' + hex(6), url: 'https://checkout.stripe.test/c/' + hex(4) });
      const m = req.url.match(/^\/v1\/subscriptions\/(sub_\w+)$/);
      if (m) {
        if (stripeDown) return send({ error: { message: 'Stripe is having a bad day' } }, 500);
        const s = subs.get(m[1]);
        if (!s) return send({ error: { message: 'No such subscription' } }, 404);
        if (req.method === 'DELETE') s.status = 'canceled';
        return setTimeout(() => send(s), stripeDelay); // Stripe takes a moment to answer
      }
      send({ error: { message: 'unknown ' + req.url } }, 404);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  srv = await startServer({ STRIPE_API_BASE: `http://127.0.0.1:${fake.address().port}` });
  owner = srv.owner;
  admin = await srv.register('adm' + hex(3)); mod = await srv.register('mod' + hex(3));
  alice = await srv.register('alice' + hex(3)); bob = await srv.register('bob' + hex(3));
  assert.equal((await as(owner, 'PUT', '/admin/staff', { userId: admin.id, role: 'admin', authKey: owner.authKey })).status, 200);
  assert.equal((await as(owner, 'PUT', '/admin/staff', { userId: mod.id, role: 'moderator', authKey: owner.authKey })).status, 200);
  space = (await as(owner, 'POST', '/servers', { name: 'Owner HQ' })).json;
  text = space.channels.find((c) => c.type === 'text');
  for (const u of [admin, mod, alice, bob]) {
    const { code } = (await as(owner, 'POST', `/servers/${space.id}/invites`, {})).json;
    assert.equal((await as(u, 'POST', `/invites/${code}/join`)).status, 200);
  }
});
after(async () => { await srv.stop(); fake.close(); });

// ------------------------------------------------------------------ admin-2: step-up for the keys to the instance
test('admin-2: making someone admin needs the owner’s password again, not just the session', async () => {
  const u = await srv.register();
  const noKey = await as(owner, 'PUT', '/admin/staff', { userId: u.id, role: 'admin' });
  assert.equal(noKey.status, 401); assert.equal(noKey.json.code, 'bad_password');
  assert.equal((await as(owner, 'PUT', '/admin/staff', { userId: u.id, role: 'admin', authKey: hex(32) })).status, 401);
  assert.equal(srv.sql('SELECT value FROM instance_settings WHERE key = ?', 'staffRoles')[0].value.includes(u.id), false, 'nothing changed');
  assert.equal((await as(owner, 'PUT', '/admin/staff', { userId: u.id, role: 'admin', authKey: owner.authKey })).status, 200);
  assert.equal((await as(u, 'GET', '/admin/staff')).json.me, 'admin');
  // Taking the role away needs it too.
  assert.equal((await as(owner, 'PUT', '/admin/staff', { userId: u.id, role: null })).status, 401);
  assert.equal((await as(owner, 'PUT', '/admin/staff', { userId: u.id, role: null, authKey: owner.authKey })).status, 200);
});

test('admin-2: right passwords don’t use up the step-up limit; wrong ones still do', async () => {
  const u = await srv.register();
  for (let i = 0; i < 12; i++) {
    const r = await as(owner, 'PUT', '/admin/staff', { userId: u.id, role: i % 2 ? null : 'moderator', authKey: owner.authKey });
    assert.equal(r.status, 200, `change ${i + 1}: ${r.text}`);
  }
  const guesser = await srv.register();
  for (let i = 0; i < 10; i++) assert.equal((await as(guesser, 'POST', '/me/username', { username: 'g' + hex(4), authKey: hex(32) })).status, 401);
  assert.equal((await as(guesser, 'POST', '/me/username', { username: 'g' + hex(4), authKey: guesser.authKey })).status, 429, 'locked after 10 wrong passwords');
  // Guesses sent all at once are limited the same way.
  const rusher = await srv.register();
  const codes = (await Promise.all(Array.from({ length: 15 }, () => as(rusher, 'POST', '/me/username', { username: 'r' + hex(4), authKey: hex(32) })))).map((r) => r.status);
  assert.equal(codes.filter((c) => c === 401).length, 10, codes.join(','));
  assert.equal(codes.filter((c) => c === 429).length, 5, codes.join(','));
});

test('admin-2: deleting a backup needs the password again', async () => {
  const made = await as(owner, 'POST', '/admin/backups', {});
  assert.equal(made.status, 200, made.text);
  const name = made.json.name;
  assert.equal((await as(owner, 'DELETE', `/admin/backups/${name}`)).status, 401);
  assert.equal((await as(owner, 'DELETE', `/admin/backups/${name}`, { authKey: hex(32) })).status, 401);
  assert.ok(fs.existsSync(path.join(srv.dir, 'backups', 'encrypted', name)), 'still there');
  const r = await as(owner, 'DELETE', `/admin/backups/${name}`, { authKey: owner.authKey });
  assert.equal(r.status, 200, r.text);
  assert.ok(!fs.existsSync(path.join(srv.dir, 'backups', 'encrypted', name)));
});

test('admin-2: handing over ownership needs the password, and the old owner gets an email', async () => {
  await confirmEmail(srv, owner, 'owner@example.test');
  const heir = await srv.register('heir' + hex(3));
  const before = srv.mails().length;
  const noKey = await as(owner, 'POST', '/admin/owner', { userId: heir.id });
  assert.equal(noKey.status, 401); assert.equal(noKey.json.code, 'bad_password');
  assert.equal((await as(owner, 'POST', '/admin/owner', { userId: heir.id, authKey: hex(32) })).status, 401);
  assert.equal((await as(heir, 'GET', '/admin/staff')).status, 403, 'a stolen session alone changes nothing');
  assert.equal((await as(owner, 'POST', '/admin/owner', { userId: heir.id, authKey: owner.authKey })).status, 200);
  assert.equal((await as(heir, 'GET', '/admin/staff')).json.me, 'owner');
  const mail = srv.mails().slice(before).find((m) => m.to === 'owner@example.test');
  assert.ok(mail, 'the old owner is told by email');
  assert.match(mail.subject, /handed over ownership/);
  assert.match(mail.text, new RegExp(heir.username));
  assert.equal(logRows('ownership_transferred').length, 1);
  // The new owner gives it back (with their own password).
  assert.equal((await as(heir, 'POST', '/admin/owner', { userId: owner.id })).status, 401);
  assert.equal((await as(heir, 'POST', '/admin/owner', { userId: owner.id, authKey: heir.authKey })).status, 200);
  assert.equal((await as(owner, 'GET', '/admin/staff')).json.me, 'owner');
});

// ------------------------------------------------------------------ admin-4: moderators and messages / reports
test('admin-4: a moderator can’t delete messages by the owner or by staff at their level or above', async () => {
  const ownerMsg = channelMsg(owner); const adminMsg = channelMsg(admin); const modMsg = channelMsg(mod);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${ownerMsg}`)).status, 403);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${adminMsg}`)).status, 403);
  assert.equal((await as(admin, 'DELETE', `/admin/messages/${ownerMsg}`)).status, 403, 'nor an admin the owner’s');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE id IN (?, ?)', ownerMsg, adminMsg)[0].n, 2);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${modMsg}`)).status, 200, 'their own is fine');
  assert.equal((await as(admin, 'DELETE', `/admin/messages/${channelMsg(mod)}`)).status, 200, 'an admin outranks a moderator');
  // The owner's DM to someone, even if a moderator learns its id.
  const ownerDm = await dmMsg(owner, bob);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${ownerDm}`)).status, 403);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM dm_messages WHERE id = ?', ownerDm)[0].n, 1);
});

test('admin-4: reported messages of people below can still be removed; unreported DMs can’t', async () => {
  const bad = channelMsg(alice);
  const rep = await as(bob, 'POST', '/reports', { category: 'spam', context: { kind: 'message', messageId: bad }, evidence: [{ id: bad, text: 'buy now' }] });
  assert.equal(rep.status, 200, rep.text);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${bad}`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', bad)[0].n, 0);
  const privateDm = await dmMsg(alice, bob);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${privateDm}`)).status, 403, 'not reported: private');
  const r2 = await as(bob, 'POST', '/reports', { category: 'harassment', context: { kind: 'message', messageId: privateDm }, evidence: [{ id: privateDm, text: 'mean' }] });
  assert.equal(r2.status, 200, r2.text);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${privateDm}`)).status, 200, 'reported: can be removed');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM dm_messages WHERE id = ?', privateDm)[0].n, 0);
});

test('admin-4: staff can’t close reports about themselves or about people at their level or above', async () => {
  const aboutMod = (await as(bob, 'POST', '/reports', { targetId: mod.id, category: 'other', details: 'mod abuse' })).json.id;
  const aboutOwner = (await as(bob, 'POST', '/reports', { targetId: owner.id, category: 'other', details: 'x' })).json.id;
  const aboutAlice = (await as(bob, 'POST', '/reports', { targetId: alice.id, category: 'spam', details: 'x' })).json.id;
  assert.equal((await as(mod, 'PATCH', `/admin/reports/${aboutMod}`, { status: 'dismissed' })).status, 403);
  assert.equal((await as(mod, 'PATCH', `/admin/reports/${aboutOwner}`, { status: 'resolved' })).status, 403);
  assert.equal((await as(admin, 'PATCH', `/admin/reports/${aboutOwner}`, { status: 'dismissed' })).status, 403);
  assert.equal(srv.sql('SELECT status FROM reports WHERE id = ?', aboutMod)[0].status, 'open');
  assert.equal((await as(mod, 'PATCH', `/admin/reports/${aboutAlice}`, { status: 'resolved' })).status, 200);
  assert.equal((await as(admin, 'PATCH', `/admin/reports/${aboutMod}`, { status: 'reviewing' })).status, 200, 'someone above them can');
  assert.equal((await as(owner, 'PATCH', `/admin/reports/${aboutOwner}`, { status: 'dismissed' })).status, 200, 'the owner handles reports about the owner');
});

// ------------------------------------------------------------------ admin-5: admins and the owner's servers, IP bans
test('admin-5: an admin can’t delete or take the owner’s servers, or delete group chats from here', async () => {
  assert.equal((await as(admin, 'POST', `/admin/servers/${space.id}/transfer`, { username: admin.username })).status, 403);
  assert.equal((await as(admin, 'DELETE', `/admin/servers/${space.id}`)).status, 403);
  assert.equal(srv.sql('SELECT owner_id FROM servers WHERE id = ?', space.id)[0].owner_id, owner.id);
  const gid = 'g' + hex(8);
  srv.sql("INSERT INTO servers (id, name, owner_id, created_at, kind) VALUES (?, 'grp', ?, ?, 'group')", gid, alice.id, Date.now());
  assert.equal((await as(admin, 'DELETE', `/admin/servers/${gid}`)).status, 404);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM servers WHERE id = ?', gid)[0].n, 1);
  // A normal member's server is still theirs to manage.
  const hers = (await as(alice, 'POST', '/servers', { name: 'Alice place' })).json;
  const { code } = (await as(alice, 'POST', `/servers/${hers.id}/invites`, {})).json;
  await as(bob, 'POST', `/invites/${code}/join`);
  assert.equal((await as(admin, 'POST', `/admin/servers/${hers.id}/transfer`, { username: bob.username })).status, 200);
  assert.equal((await as(admin, 'DELETE', `/admin/servers/${hers.id}`)).status, 200);
});

test('admin-5: an admin can’t IP-ban the owner’s network or their own, even as a range', async () => {
  const r1 = await as(admin, 'POST', '/admin/ip-bans', { ip: owner.ip });
  assert.equal(r1.status, 403, r1.text);
  assert.equal((await as(admin, 'POST', '/admin/ip-bans', { ip: owner.ip + '/32' })).status, 403, 'as a range too');
  assert.equal((await as(admin, 'POST', '/admin/ip-bans', { ip: admin.ip + '/32' })).status, 400);
  assert.equal((await as(admin, 'POST', '/admin/ip-bans', { ip: '0.0.0.0/0' })).status, 400);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM instance_settings WHERE key = 'ipBans' AND value LIKE ?", `%${owner.ip}%`)[0].n, 0);
  assert.equal((await srv.login(owner)).status, 200, 'the owner can still sign in');
  assert.equal((await as(admin, 'POST', '/admin/ip-bans', { ip: '203.0.113.77', reason: 'spam' })).status, 200, 'other addresses still work');
  assert.equal((await as(admin, 'DELETE', '/admin/ip-bans', { ip: '203.0.113.77' })).status, 200);
});

// ------------------------------------------------------------------ admin-6: money settings are logged; destinations need the password
test('admin-6: changing where payments go needs the password and is logged (without the secrets)', async () => {
  const before = srv.sql('SELECT COUNT(*) n FROM admin_log')[0].n;
  assert.equal((await as(admin, 'PUT', '/admin/money', { stripeLink: 'https://buy.stripe.com/attacker123' })).status, 401);
  assert.equal((await as(admin, 'PUT', '/admin/money', { kofiToken: 'known-token' })).status, 401);
  assert.equal((await as(admin, 'PUT', '/admin/money', { stripeSecret: PAY_WHSEC })).status, 401);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM admin_log')[0].n, before, 'nothing changed, nothing logged');
  assert.equal((await as(owner, 'GET', '/me/support')).json.stripeUrl, '');
  const ok = await as(admin, 'PUT', '/admin/money', { stripeLink: 'https://buy.stripe.com/test_link', stripeSecret: PAY_WHSEC, authKey: admin.authKey });
  assert.equal(ok.status, 200, ok.text);
  const row = logRows('payment_settings').pop();
  assert.equal(row.admin_id, admin.id);
  assert.match(row.detail, /stripeLink/); assert.match(row.detail, /stripeSecret/);
  assert.ok(!row.detail.includes(PAY_WHSEC), 'never the secret itself');
  // Price and perks aren't where the money goes: no password, still logged.
  assert.equal((await as(admin, 'PUT', '/admin/money', { monthlyCents: 500 })).status, 200);
  assert.match(logRows('payment_settings').pop().detail, /monthlyCents/);
});

test('admin-6: assigning a payment and memberships settings are logged; new Stripe keys need the password', async () => {
  srv.sql("INSERT INTO payments (id, provider, ref, user_id, amount_cents, currency, kind, note, created_at) VALUES (?, 'kofi', ?, NULL, 300, 'USD', 'Ko-fi donation', 'x', ?)", 'p' + hex(6), 'tx' + hex(6), Date.now());
  const pid = srv.sql('SELECT id FROM payments WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 1')[0].id;
  assert.equal((await as(admin, 'POST', `/admin/money/payments/${pid}/assign`, { username: bob.username })).status, 200);
  const a = logRows('payment_assigned').pop();
  assert.equal(a.admin_id, admin.id); assert.equal(a.target, bob.id);
  // Memberships: the key and webhook secret decide where creators' money goes.
  const cfg = { enabled: true, key: 'sk_test_' + 'k'.repeat(24), webhookSecret: WHSEC, feePercent: 5, currency: 'usd' };
  assert.equal((await as(admin, 'PUT', '/admin/memberships', cfg)).status, 401);
  assert.equal((await as(admin, 'PUT', '/admin/memberships', { ...cfg, authKey: hex(32) })).status, 401);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM instance_settings WHERE key = 'memberships'")[0].n, 0);
  assert.equal((await as(admin, 'PUT', '/admin/memberships', { ...cfg, authKey: admin.authKey })).status, 200);
  assert.match(logRows('membership_settings').pop().detail, /key, webhookSecret/);
  assert.equal((await as(admin, 'PUT', '/admin/memberships', { feePercent: 7 })).status, 200, 'the fee alone needs no password');
  assert.match(logRows('membership_settings').pop().detail, /feePercent 5 → 7/);
  assert.equal((await as(admin, 'PUT', '/admin/memberships', { feePercent: 5 })).status, 200);
  for (const r of logRows('membership_settings')) assert.ok(!r.detail.includes('kkkkkkkk') && !r.detail.includes(WHSEC));
});

test('admin-6: GIF, relay, activity and region settings changes are logged too', async () => {
  assert.equal((await as(admin, 'PATCH', '/admin/settings', { giphyRating: 'pg' })).status, 200);
  assert.match(logRows('gif_settings').pop().detail, /giphyRating/);
  assert.equal((await as(admin, 'PUT', '/admin/turn', { urls: 'turn:198.51.100.3:3478' })).status, 200);
  assert.match(logRows('turn_settings').pop().detail, /urls/);
  assert.equal((await as(admin, 'PATCH', '/admin/activity', { rawgKey: '' })).status, 200);
  assert.match(logRows('activity_settings').pop().detail, /rawgKey/);
  const reg = await as(admin, 'POST', '/admin/regions', { name: 'Frankfurt', origin: 'https://chat.example.test' });
  assert.equal(reg.status, 200, reg.text);
  assert.equal(logRows('region_added').pop().detail, 'Frankfurt');
  assert.equal((await as(admin, 'DELETE', `/admin/regions/${reg.json.region.id}`)).status, 200);
  assert.equal(logRows('region_removed').pop().detail, 'Frankfurt');
});

// ------------------------------------------------------------------ files-8: API keys and webhook secrets sealed at rest
test('files-8: GIF and activity API keys and payment webhook secrets are encrypted at rest (old plain ones too)', async () => {
  assert.equal((await as(admin, 'PATCH', '/admin/settings', { giphyKey: 'GIPHY-KEY-1234', klipyKey: 'KLIPY-KEY-5678' })).status, 200);
  assert.equal((await as(admin, 'PATCH', '/admin/activity', { lastfmKey: 'LASTFM-KEY-0001', rawgKey: 'RAWG-KEY-0002' })).status, 200);
  assert.equal((await as(admin, 'PUT', '/admin/money', { kofiToken: 'KOFI-TOKEN-XYZ', kofiUrl: 'https://ko-fi.com/hearth', authKey: admin.authKey })).status, 200);
  const dump = () => JSON.stringify(srv.sql('SELECT * FROM instance_settings'));
  for (const secret of ['GIPHY-KEY-1234', 'KLIPY-KEY-5678', 'LASTFM-KEY-0001', 'RAWG-KEY-0002', 'KOFI-TOKEN-XYZ', PAY_WHSEC, WHSEC]) assert.ok(!dump().includes(secret), `${secret} is sealed`);
  // ...and they still work: the admin view shows the right key's last characters, Ko-fi's token still checks out.
  const s = (await as(admin, 'GET', '/admin/settings')).json;
  assert.equal(s.giphyKeyHint.slice(-4), '1234'); assert.equal(s.klipyKeyHint.slice(-4), '5678');
  const act = (await as(admin, 'GET', '/admin/activity')).json;
  assert.equal(act.lastfmKeySet, true); assert.equal(act.rawgKeySet, true);
  const kofi = (token) => fetch(`${srv.base}/api/pay/kofi`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: JSON.stringify({ verification_token: token, amount: '3.00', kofi_transaction_id: 'tx-' + hex(4), message: '' }) }) }).then((r) => r.status);
  assert.equal(await kofi('KOFI-TOKEN-XYZ'), 200);
  assert.equal(await kofi('wrong-token'), 403);
  // Values saved in plain text by an older version are sealed at the next start.
  srv.sql("UPDATE instance_settings SET value = 'OLD-PLAIN-GIPHY-9999' WHERE key = 'giphyKey'");
  const pay = JSON.parse(srv.sql("SELECT value FROM instance_settings WHERE key = 'payments'")[0].value);
  srv.sql("UPDATE instance_settings SET value = ? WHERE key = 'payments'", JSON.stringify({ ...pay, kofiToken: 'OLD-PLAIN-KOFI' }));
  await srv.restart();
  assert.ok(!dump().includes('OLD-PLAIN-GIPHY-9999') && !dump().includes('OLD-PLAIN-KOFI'));
  assert.equal((await as(admin, 'GET', '/admin/settings')).json.giphyKeyHint.slice(-4), '9999');
  assert.equal(await kofi('OLD-PLAIN-KOFI'), 200);
});

// ------------------------------------------------------------------ memberships: data-8, data-12, admin-9, admin-10
async function creatorSetup() {
  const creator = await srv.register(); const fan = await srv.register(); const buyer = await srv.register();
  const server = (await as(creator, 'POST', '/servers', { name: 'Studio ' + hex(3) })).json;
  for (const u of [fan, buyer]) { const { code } = (await as(creator, 'POST', `/servers/${server.id}/invites`, {})).json; await as(u, 'POST', `/invites/${code}/join`); }
  const role = (await as(creator, 'POST', `/servers/${server.id}/roles`, { name: 'Gold supporter', permissions: 0 })).json;
  srv.sql('INSERT INTO creator_accounts (server_id, stripe_account, ready, checked_at) VALUES (?, ?, 1, ?)', server.id, 'acct_' + hex(6), Date.now());
  const tier = (await as(creator, 'POST', `/servers/${server.id}/memberships/tiers`, { name: 'Gold', priceCents: 500, roleId: role.id })).json;
  assert.equal(tier.role.id, role.id, JSON.stringify(tier));
  const sub = 'sub_' + hex(8);
  subs.set(sub, { id: sub, status: 'active', customer: 'cus_' + hex(4), cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: { kind: 'membership', server: server.id, tier: tier.id, user: fan.id } });
  srv.sql(`INSERT INTO memberships (id, server_id, tier_id, user_id, stripe_sub, status, amount_cents, currency, period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', 500, 'USD', ?, ?, ?)`, 'mb' + hex(6), server.id, tier.id, fan.id, sub, Date.now() + 20 * 86400000, Date.now(), Date.now());
  srv.sql('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)', server.id, fan.id, role.id);
  return { creator, fan, buyer, server, role, tier, sub };
}

test('data-12: a role sold as a membership can’t be deleted, and a tier whose role is gone isn’t sold', async () => {
  const { creator, buyer, server, role, tier } = await creatorSetup();
  const del = await as(creator, 'DELETE', `/roles/${role.id}`);
  assert.equal(del.status, 409, del.text);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM roles WHERE id = ?', role.id)[0].n, 1);
  assert.equal((await as(buyer, 'POST', `/servers/${server.id}/memberships/tiers/${tier.id}/checkout`)).status, 200, 'on sale while its role exists');
  // A role that went missing anyway (an older version, or by hand): the tier stops selling.
  srv.sql('DELETE FROM roles WHERE id = ?', role.id);
  assert.equal((await as(buyer, 'POST', `/servers/${server.id}/memberships/tiers/${tier.id}/checkout`)).status, 404);
  // An ordinary role can still be deleted.
  const plain = (await as(creator, 'POST', `/servers/${server.id}/roles`, { name: 'plain', permissions: 0 })).json;
  assert.equal((await as(creator, 'DELETE', `/roles/${plain.id}`)).status, 200);
});

test('admin-10: a role sold as a membership can’t gain moderator powers later, and such a role isn’t handed out', async () => {
  const { creator, buyer, server, role, tier } = await creatorSetup();
  assert.equal((await as(creator, 'PATCH', `/roles/${role.id}`, { permissions: 1 << 30 })).status, 400, 'no Administrator');
  assert.equal((await as(creator, 'PATCH', `/roles/${role.id}`, { permissions: 1 << 10 })).status, 400, 'no Ban Members');
  assert.equal(srv.sql('SELECT permissions FROM roles WHERE id = ?', role.id)[0].permissions, 0);
  assert.equal((await as(creator, 'PATCH', `/roles/${role.id}`, { permissions: 1 << 16, name: 'Gold supporters' })).status, 200, 'harmless changes still work');
  const vip = (await as(creator, 'POST', `/servers/${server.id}/channels`, { name: 'vip', type: 'text' })).json;
  const bad = await as(creator, 'PUT', `/channels/${vip.id}/overrides`, { overrides: [{ type: 'role', id: role.id, allow: (1 << 0) | (1 << 5), deny: 0 }] });
  assert.equal(bad.status, 400, 'no Manage Messages in a channel either');
  assert.equal((await as(creator, 'PUT', `/channels/${vip.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: 1 }, { type: 'role', id: role.id, allow: 1, deny: 0 }] })).status, 200);
  // If the bit gets there anyway (an older version, or by hand), paying doesn't hand it out.
  srv.sql('UPDATE roles SET permissions = ? WHERE id = ?', 1 << 30, role.id);
  const sub = 'sub_' + hex(8);
  subs.set(sub, { id: sub, status: 'active', customer: 'cus_x', cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: { kind: 'membership', server: server.id, tier: tier.id, user: buyer.id } });
  assert.equal((await hook('memberships', { type: 'customer.subscription.updated', data: { object: subs.get(sub) } }, WHSEC)).status, 200);
  assert.equal(srv.sql('SELECT status FROM memberships WHERE stripe_sub = ?', sub)[0].status, 'active');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM member_roles WHERE user_id = ? AND role_id = ?', buyer.id, role.id)[0].n, 0, 'no moderator powers for money');
  assert.equal((await as(buyer, 'GET', `/servers/${server.id}/bans`)).status, 403);
});

test('admin-9: creator-membership invoices aren’t counted as donations to the instance', async () => {
  const { sub } = await creatorSetup();
  const month = async () => (await as(admin, 'GET', '/admin/money')).json.totals;
  const t0 = await month();
  const paid = (o) => hook('stripe', { id: 'evt_' + hex(4), type: 'invoice.paid', data: { object: { id: 'in_' + hex(6), customer: 'cus_member', amount_paid: 2500, currency: 'usd', ...o } } }, PAY_WHSEC);
  assert.equal((await paid({ subscription: sub })).status, 200);
  assert.equal((await paid({ parent: { subscription_details: { subscription: 'sub_' + hex(8), metadata: { kind: 'membership' } } } })).status, 200);
  const t1 = await month();
  assert.equal(t1.monthCents, t0.monthCents); assert.equal(t1.unmatched, t0.unmatched);
  // A real supporter invoice is still recorded.
  assert.equal((await paid({ subscription: 'sub_supporter_' + hex(4) })).status, 200);
  const t2 = await month();
  assert.equal(t2.monthCents, t0.monthCents + 2500); assert.equal(t2.unmatched, t0.unmatched + 1);
});

test('data-8: deleting a server while Stripe is down keeps its subscriptions to cancel, and retries until Stripe confirms', async () => {
  const { creator, server, sub } = await creatorSetup();
  stripeDown = true;
  try {
    assert.equal((await as(creator, 'DELETE', `/servers/${server.id}`)).status, 200);
    for (let i = 0; i < 40 && !stripeCalls.some((c) => c.method === 'DELETE' && c.url === `/v1/subscriptions/${sub}`); i++) await sleep(50);
    assert.ok(stripeCalls.some((c) => c.method === 'DELETE' && c.url === `/v1/subscriptions/${sub}`), 'tried right away');
    await sleep(200);
    const pending = srv.sql('SELECT * FROM membership_cancellations WHERE stripe_sub = ?', sub);
    assert.equal(pending.length, 1, 'still on the list to cancel');
    assert.ok(pending[0].attempts >= 1); assert.match(pending[0].last_error, /bad day/);
    assert.equal(subs.get(sub).status, 'active', 'Stripe would still be billing');
    assert.equal((await as(admin, 'GET', '/admin/memberships')).json.stats.pendingCancellations, 1);
  } finally { stripeDown = false; }
  // Stripe is back: the retry (here: shortly after a restart; normally every hour) cancels it.
  await srv.restart();
  for (let i = 0; i < 100 && srv.sql('SELECT COUNT(*) n FROM membership_cancellations WHERE stripe_sub = ?', sub)[0].n; i++) await sleep(100);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM membership_cancellations WHERE stripe_sub = ?', sub)[0].n, 0);
  assert.equal(subs.get(sub).status, 'canceled');
});

// ------------------------------------------------------------------ admin-8 / data-6: no plaintext next to the encrypted backups
test('admin-8/data-6: the plaintext snapshot never appears in backups/encrypted, and a stop mid-backup leaves nothing', async () => {
  const up = path.join(srv.dir, 'uploads');
  const buf = crypto.randomBytes(1 << 20);
  for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(up, `big${String(i).padStart(3, '0')}.bin`), buf);
  const enc = path.join(srv.dir, 'backups', 'encrypted'); const tmp = path.join(srv.dir, 'backups', '.tmp');
  const seen = new Set(); let plaintext = false; let done = false;
  const watch = (async () => {
    while (!done) {
      for (const f of fs.existsSync(enc) ? fs.readdirSync(enc) : []) {
        seen.add(f);
        try { const fd = fs.openSync(path.join(enc, f), 'r'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); if (b.toString('latin1').startsWith('SQLite format 3')) plaintext = true; } catch { /* gone */ }
      }
      await sleep(2);
    }
  })();
  const r = await as(owner, 'POST', '/admin/backups', {});
  done = true; await watch;
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.verified.ok, true);
  assert.equal(plaintext, false, 'no plaintext database in the encrypted folder');
  assert.deepEqual([...seen].filter((f) => !/^hearth-[\w.-]+\.hbk(\.part)?$/.test(f)), [], `only backups there: ${[...seen]}`);
  assert.equal(fs.statSync(tmp).mode & 0o077, 0, 'the snapshot folder is private');
  assert.deepEqual(fs.readdirSync(tmp), [], 'the snapshot is gone afterwards');

  // Stopped in the middle of a backup (an update, a restart): nothing plaintext or half-written is left.
  const pending = as(owner, 'POST', '/admin/backups', {}).catch(() => null);
  for (let i = 0; i < 400 && !(fs.readdirSync(enc).some((f) => f.endsWith('.part'))); i++) await sleep(5);
  assert.ok(fs.readdirSync(enc).some((f) => f.endsWith('.part')), 'caught it mid-backup');
  srv.child.kill('SIGTERM');
  for (let i = 0; i < 100 && srv.child.exitCode === null; i++) await sleep(50);
  await pending;
  assert.deepEqual(fs.readdirSync(enc).filter((f) => !f.endsWith('.hbk')), [], 'no .part left');
  assert.deepEqual(fs.readdirSync(tmp), [], 'no snapshot left');
  for (let i = 0; i < 120; i++) fs.rmSync(path.join(up, `big${String(i).padStart(3, '0')}.bin`), { force: true });
  await srv.restart();
});

test('admin-8/data-6/data-7: leftovers of a crashed backup are removed at startup, but not a backup still running', async () => {
  const enc = path.join(srv.dir, 'backups', 'encrypted'); const tmp = path.join(srv.dir, 'backups', '.tmp');
  const verify = path.join(srv.dir, 'backups', '.verify-abc123');
  fs.mkdirSync(enc, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
  fs.copyFileSync(path.join(srv.dir, 'hearth.db'), path.join(enc, '.snapshot-2026-01-01T00-00-00-000Z.db')); // where older versions put it
  fs.writeFileSync(path.join(enc, 'hearth-2026-01-01T00-00-00-000Z.hbk.part'), crypto.randomBytes(1000));
  fs.copyFileSync(path.join(srv.dir, 'hearth.db'), path.join(tmp, '.snapshot-2026-01-02T00-00-00-000Z.db'));
  fs.mkdirSync(verify);
  fs.writeFileSync(path.join(verify, 'secret.key'), 'x');
  // Left by a crash an hour ago: nothing has touched them since.
  const hourAgo = (Date.now() - 3600000) / 1000;
  for (const p of [path.join(enc, '.snapshot-2026-01-01T00-00-00-000Z.db'), path.join(enc, 'hearth-2026-01-01T00-00-00-000Z.hbk.part'),
    path.join(tmp, '.snapshot-2026-01-02T00-00-00-000Z.db'), path.join(verify, 'secret.key'), verify]) fs.utimesSync(p, hourAgo, hourAgo);
  // A backup made from the command line (a cron job) that's still writing while the server restarts.
  const running = { part: path.join(enc, 'hearth-2026-01-03T00-00-00-000Z.hbk.part'), snap: path.join(tmp, '.snapshot-2026-01-03T00-00-00-000Z.db'), verify: path.join(srv.dir, 'backups', '.verify-run123') };
  fs.writeFileSync(running.part, crypto.randomBytes(1000)); fs.writeFileSync(running.snap, 'x');
  fs.mkdirSync(path.join(running.verify, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(running.verify, 'uploads', 'being-written.bin'), 'x');
  // Its folders were made long ago; only the file being written is fresh.
  fs.utimesSync(path.join(running.verify, 'uploads'), hourAgo, hourAgo); fs.utimesSync(running.verify, hourAgo, hourAgo);
  const keep = fs.readdirSync(enc).filter((f) => f.endsWith('.hbk'));
  await srv.restart();
  assert.deepEqual(fs.readdirSync(enc).sort(), [...keep, path.basename(running.part)].sort(), 'only finished backups (and the running one) remain');
  assert.deepEqual(fs.readdirSync(tmp), [path.basename(running.snap)]);
  assert.ok(!fs.existsSync(verify));
  assert.ok(fs.existsSync(path.join(running.verify, 'uploads', 'being-written.bin')), 'a restore test still writing is left alone');
  for (const p of Object.values(running)) fs.rmSync(p, { recursive: true, force: true });
});

// ------------------------------------------------------------------ data-7: uploads deleted while a backup streams
test('data-7: an upload deleted while a backup streams is left out instead of failing the backup; a failure leaves no .part', async () => {
  const BK = require('../server/backup');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bk-'));
  const up = path.join(dir, 'uploads'); const out = path.join(dir, 'backups', 'encrypted');
  fs.mkdirSync(up, { recursive: true });
  const d = new Database(path.join(dir, 'hearth.db'));
  d.exec("CREATE TABLE users (id TEXT); INSERT INTO users VALUES ('a')");
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(up, `f${String(i).padStart(2, '0')}.bin`), crypto.randomBytes(4096));
  const realReaddir = fs.readdirSync; const realStat = fs.statSync;
  try {
    // One file disappears right after the folder is listed, another right after it's checked (just before it's read).
    fs.readdirSync = function (p, ...rest) { const list = realReaddir.call(fs, p, ...rest); if (p === up) fs.unlinkSync(path.join(up, 'f19.bin')); return list; };
    fs.statSync = function (p, ...rest) { const st = realStat.call(fs, p, ...rest); if (p === path.join(up, 'f10.bin')) fs.unlinkSync(p); return st; };
    const b = await BK.createBackup({ db: d, dataDir: dir, uploadDir: up, outDir: out });
    fs.readdirSync = realReaddir; fs.statSync = realStat;
    assert.equal(b.skipped, 2);
    const v = await BK.verifyBackup(b.file, BK.loadKey(dir), path.join(dir, 'backups'));
    assert.equal(v.ok, true); assert.equal(v.files, 18);
    assert.deepEqual(realReaddir.call(fs, out), [b.name]);
    // A backup that fails for another reason (here: a file that can't be read) leaves no .part and no snapshot.
    const realOpen = fs.promises.open;
    fs.promises.open = async function (p, ...rest) { if (p === path.join(up, 'f05.bin')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return realOpen.call(fs.promises, p, ...rest); };
    try { await assert.rejects(BK.createBackup({ db: d, dataDir: dir, uploadDir: up, outDir: out }), /EIO/); } finally { fs.promises.open = realOpen; }
    assert.deepEqual(realReaddir.call(fs, out), [b.name], 'no .part left behind');
    assert.deepEqual(realReaddir.call(fs, BK.defaultTmpDir(dir)), [], 'no snapshot left behind');
  } finally { fs.readdirSync = realReaddir; fs.statSync = realStat; d.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ admin-7: a keyed, anchored audit log
test('admin-7: the audit log catches entries cut off the end, NULLed hashes and re-hashed edits', async () => {
  const s2 = await startServer();
  try {
    const o = s2.owner;
    for (let i = 0; i < 4; i++) { const u = await s2.register(); await s2.api('PUT', '/admin/staff', { token: o.token, ip: o.ip, body: { userId: u.id, role: 'moderator', authKey: o.authKey } }); }
    const verify = async () => (await s2.api('GET', '/admin/log/verify', { token: o.token, ip: o.ip })).json;
    const v0 = await verify();
    assert.equal(v0.ok, true, JSON.stringify(v0)); assert.ok(v0.entries >= 5); assert.equal(v0.anchored, true);
    // (a) The newest entries are deleted (what someone hiding their last actions would do).
    let d = s2.db();
    d.exec('DROP TRIGGER admin_log_no_delete');
    const maxId = d.prepare('SELECT MAX(id) m FROM admin_log').get().m;
    d.prepare('DELETE FROM admin_log WHERE id > ?').run(maxId - 2);
    d.exec("CREATE TRIGGER admin_log_no_delete BEFORE DELETE ON admin_log BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;");
    d.close();
    const v1 = await verify();
    assert.equal(v1.ok, false); assert.equal(v1.reason, 'missing'); assert.equal(v1.anchoredId, maxId);
    // Carrying on doesn't hide it: the next entry is preceded by a record of the gap.
    const u = await s2.register();
    await s2.api('PUT', '/admin/staff', { token: o.token, ip: o.ip, body: { userId: u.id, role: 'moderator', authKey: o.authKey } });
    const v2 = await verify();
    assert.equal(v2.ok, true, JSON.stringify(v2));
    assert.equal(v2.gaps.length, 1); assert.equal(v2.gaps[0].action, 'audit_log_gap');
    assert.match(s2.sql("SELECT detail FROM admin_log WHERE action = 'audit_log_gap'")[0].detail, new RegExp(`#${maxId}`));
    // (b) An edit, re-hashed with the old unkeyed formula: without data/secret.key the chain can't be redone.
    d = s2.db();
    d.exec('DROP TRIGGER admin_log_no_update');
    const rows = d.prepare('SELECT * FROM admin_log ORDER BY id').all();
    const victim = rows[2];
    let prev = victim.prev_hash;
    for (const r of rows.slice(2)) {
      const row = r.id === victim.id ? { ...r, detail: 'nothing to see here' } : r;
      const h = crypto.createHash('sha256').update(JSON.stringify([prev || '', row.id, row.admin_id || '', row.action, row.target || '', row.detail || '', row.ip || '', row.created_at])).digest('hex');
      d.prepare('UPDATE admin_log SET detail = ?, prev_hash = ?, hash = ? WHERE id = ?').run(row.detail, prev, h, row.id);
      prev = h;
    }
    d.close();
    const v3 = await verify();
    assert.equal(v3.ok, false); assert.equal(v3.brokenAt, victim.id); assert.equal(v3.reason, 'changed');
    // (c) Hashes set to NULL are no longer "repaired" at the next start.
    d = s2.db();
    d.prepare('UPDATE admin_log SET hash = NULL, prev_hash = NULL WHERE id >= ?').run(victim.id);
    d.close();
    await s2.restart();
    assert.equal(s2.sql('SELECT hash FROM admin_log WHERE id = ?', victim.id)[0].hash, null, 'not re-chained');
    const v4 = await verify();
    assert.equal(v4.ok, false); assert.equal(v4.brokenAt, victim.id);
    // (d) The anchor file can't be rewritten without the key either.
    const anchorFile = path.join(s2.dir, 'audit-anchor.json');
    const a = JSON.parse(fs.readFileSync(anchorFile, 'utf8'));
    fs.writeFileSync(anchorFile, JSON.stringify({ ...a, id: 1 }));
    const v5 = await verify();
    assert.equal(v5.ok, false); assert.equal(v5.reason, 'anchor');
    // ...nor deleted while the server runs.
    fs.rmSync(anchorFile);
    const v6 = await verify();
    assert.equal(v6.ok, false); assert.equal(v6.reason, 'anchor');
  } finally { await s2.stop(); }
});

test('admin-7: logs from before the keyed chain still verify, and new entries are keyed from the switch-over', async () => {
  const s3 = await startServer();
  try {
    const o = s3.owner;
    for (let i = 0; i < 3; i++) { const u = await s3.register(); await s3.api('PUT', '/admin/staff', { token: o.token, ip: o.ip, body: { userId: u.id, role: 'moderator', authKey: o.authKey } }); }
    // Turn this into a log as an older version left it: plain SHA-256 hashes, no switch-over marker, no anchor.
    s3.child.kill('SIGTERM'); for (let i = 0; i < 100 && s3.child.exitCode === null; i++) await sleep(50);
    const d = s3.db();
    d.exec('DROP TRIGGER admin_log_no_update');
    let prev = '';
    for (const r of d.prepare('SELECT * FROM admin_log ORDER BY id').all()) {
      const h = crypto.createHash('sha256').update(JSON.stringify([prev, r.id, r.admin_id || '', r.action, r.target || '', r.detail || '', r.ip || '', r.created_at])).digest('hex');
      d.prepare('UPDATE admin_log SET prev_hash = ?, hash = ? WHERE id = ?').run(prev, h, r.id);
      prev = h;
    }
    const legacyCount = d.prepare('SELECT COUNT(*) n FROM admin_log').get().n;
    d.prepare("DELETE FROM instance_settings WHERE key = 'auditKeyedFrom'").run();
    d.close();
    fs.rmSync(path.join(s3.dir, 'audit-anchor.json'));
    await s3.restart();
    const v1 = (await s3.api('GET', '/admin/log/verify', { token: o.token, ip: o.ip })).json;
    assert.equal(v1.ok, true, JSON.stringify(v1)); assert.equal(v1.keyedFrom, legacyCount + 1); assert.equal(v1.gaps.length, 0);
    // The switch-over is in the log itself, signed and dated: the old entries can be told apart from the new.
    const switched = s3.sql('SELECT * FROM admin_log WHERE id = ?', legacyCount + 1)[0];
    assert.equal(switched.action, 'audit_chain_keyed'); assert.match(switched.detail, new RegExp(`#${legacyCount + 1}`));
    assert.equal(v1.keyedSince, switched.created_at);
    const u = await s3.register();
    await s3.api('PUT', '/admin/staff', { token: o.token, ip: o.ip, body: { userId: u.id, role: 'moderator', authKey: o.authKey } });
    const v2 = (await s3.api('GET', '/admin/log/verify', { token: o.token, ip: o.ip })).json;
    assert.equal(v2.ok, true, JSON.stringify(v2)); assert.ok(v2.entries > legacyCount);
    // The new entries aren't plain SHA-256 any more.
    const last = s3.sql('SELECT * FROM admin_log ORDER BY id DESC LIMIT 1')[0];
    const plain = crypto.createHash('sha256').update(JSON.stringify([last.prev_hash, last.id, last.admin_id || '', last.action, last.target || '', last.detail || '', last.ip || '', last.created_at])).digest('hex');
    assert.notEqual(last.hash, plain);
    // Doing the same to the keyed log (edit, re-hash it all with plain SHA-256, delete the markers) can't be passed
    // off as an older version's log: signing starts over, in a new dated entry the check lists as a problem.
    await sleep(20);
    s3.child.kill('SIGTERM'); for (let i = 0; i < 100 && s3.child.exitCode === null; i++) await sleep(50);
    const d2 = s3.db();
    d2.exec('DROP TRIGGER admin_log_no_update');
    prev = '';
    for (const r of d2.prepare('SELECT * FROM admin_log ORDER BY id').all()) {
      const detail = r.id === 2 ? 'nothing to see here' : r.detail;
      const h = crypto.createHash('sha256').update(JSON.stringify([prev, r.id, r.admin_id || '', r.action, r.target || '', detail || '', r.ip || '', r.created_at])).digest('hex');
      d2.prepare('UPDATE admin_log SET detail = ?, prev_hash = ?, hash = ? WHERE id = ?').run(detail, prev, h, r.id);
      prev = h;
    }
    const resetAt = d2.prepare('SELECT MAX(id) m FROM admin_log').get().m + 1;
    d2.prepare("DELETE FROM instance_settings WHERE key = 'auditKeyedFrom'").run();
    d2.close();
    fs.rmSync(path.join(s3.dir, 'audit-anchor.json'));
    await s3.restart();
    const v3 = (await s3.api('GET', '/admin/log/verify', { token: o.token, ip: o.ip })).json;
    assert.equal(v3.keyedFrom, resetAt);
    assert.ok(v3.keyedSince > switched.created_at, 'dated when it was reset');
    assert.deepEqual(v3.gaps.map((g) => [g.id, g.action]), [[resetAt, 'audit_chain_keyed']], 'the reset is flagged');
  } finally { await s3.stop(); }
});

// ------------------------------------------------------------------ review: the keyed chain can't be quietly turned back into a plain one
test('admin-7: deleting the keyed-chain markers doesn’t make an edited log pass (keyed entries left, or hashes NULLed)', async () => {
  const s4 = await startServer();
  try {
    const o = s4.owner;
    for (let i = 0; i < 4; i++) { const u = await s4.register(); await s4.api('PUT', '/admin/staff', { token: o.token, ip: o.ip, body: { userId: u.id, role: 'moderator', authKey: o.authKey } }); }
    const verify = async () => (await s4.api('GET', '/admin/log/verify', { token: o.token, ip: o.ip })).json;
    const v0 = await verify();
    assert.equal(v0.ok, true, JSON.stringify(v0)); assert.equal(v0.keyedFrom, 1);
    const stop = async () => { s4.child.kill('SIGTERM'); for (let i = 0; i < 100 && s4.child.exitCode === null; i++) await sleep(50); };
    const dropMarkers = (d) => { d.prepare("DELETE FROM instance_settings WHERE key = 'auditKeyedFrom'").run(); fs.rmSync(path.join(s4.dir, 'audit-anchor.json'), { force: true }); };
    // (a) The newest entries are cut off and both markers deleted: the entries still signed with this server's key
    // give it away.
    await stop();
    let d = s4.db();
    d.exec('DROP TRIGGER admin_log_no_delete');
    d.prepare('DELETE FROM admin_log WHERE id > (SELECT MAX(id) - 2 FROM admin_log)').run();
    dropMarkers(d);
    d.close();
    await s4.restart();
    const v1 = await verify();
    assert.equal(v1.ok, false, JSON.stringify(v1)); assert.equal(v1.reason, 'keyed_from');
    // (b) The reviewer's case: cut off, an entry edited, every hash and prev_hash NULLed, markers deleted. Nothing
    // re-chains the NULLs (that was a one-time upgrade for databases older than v13).
    await stop();
    d = s4.db();
    d.exec('DROP TRIGGER admin_log_no_update');
    d.prepare("UPDATE admin_log SET detail = 'nothing to see here' WHERE id = 2").run();
    d.prepare('UPDATE admin_log SET hash = NULL, prev_hash = NULL').run();
    dropMarkers(d);
    d.close();
    await s4.restart();
    assert.equal(s4.sql('SELECT hash FROM admin_log WHERE id = 1')[0].hash, null, 'not re-chained');
    const v2 = await verify();
    assert.equal(v2.ok, false, JSON.stringify(v2)); assert.equal(v2.brokenAt, 1); assert.equal(v2.reason, 'changed');
  } finally { await s4.stop(); }
});

// ------------------------------------------------------------------ review: every subscription of a deleted server ends right away
async function moreSubs({ server, tier, fan }, n) {
  const d = srv.db();
  const add = d.prepare(`INSERT INTO memberships (id, server_id, tier_id, user_id, stripe_sub, status, amount_cents, currency, period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', 500, 'USD', ?, ?, ?)`);
  d.transaction(() => {
    for (let i = 0; i < n; i++) {
      const sub = 'sub_' + hex(8);
      subs.set(sub, { id: sub, status: 'active', customer: 'cus_' + hex(4), cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: { kind: 'membership', server: server.id, tier: tier.id, user: fan.id } });
      add.run('mb' + hex(6), server.id, tier.id, fan.id, sub, Date.now() + 20 * 86400000, Date.now(), Date.now());
    }
  })();
  d.close();
  return srv.sql('SELECT stripe_sub FROM memberships WHERE server_id = ?', server.id).map((r) => r.stripe_sub);
}
// Waits (up to a few seconds, far less than the hourly retry) until Stripe has ended them all and none is left on
// the list. Returns how many are still going.
async function untilCancelled(list) {
  const left = () => list.filter((s) => subs.get(s).status !== 'canceled').length
    + srv.sql(`SELECT COUNT(*) n FROM membership_cancellations WHERE stripe_sub IN (${list.map(() => '?').join(',')})`, ...list)[0].n;
  for (let i = 0; i < 300 && left(); i++) await sleep(50);
  return left();
}

test('data-8: deleting a server with more than 50 memberships ends all of them right away, not 50 an hour', async () => {
  // Let the retry that runs shortly after a start go by first, so only the deletion itself can do the work.
  await srv.restart(); await sleep(5500);
  const big = await creatorSetup();
  const list = await moreSubs(big, 129);
  assert.equal(list.length, 130);
  stripeDelay = 5;
  try {
    assert.equal((await as(big.creator, 'DELETE', `/servers/${big.server.id}`)).status, 200);
    assert.equal(await untilCancelled(list), 0, 'every subscription ended, none left waiting');
  } finally { stripeDelay = 0; }
});

test('data-8: a server deleted while another one’s memberships are still being ended isn’t skipped', async () => {
  const a = await creatorSetup(); const b = await creatorSetup();
  const listA = await moreSubs(a, 59); const listB = await moreSubs(b, 2);
  stripeDelay = 20;
  try {
    assert.equal((await as(a.creator, 'DELETE', `/servers/${a.server.id}`)).status, 200);
    await sleep(100);
    assert.ok(listA.some((s) => subs.get(s).status !== 'canceled'), 'still working through the first server');
    assert.equal((await as(b.creator, 'DELETE', `/servers/${b.server.id}`)).status, 200);
    assert.equal(await untilCancelled([...listA, ...listB]), 0);
  } finally { stripeDelay = 0; }
  assert.equal((await as(admin, 'GET', '/admin/memberships')).json.stats.pendingCancellations, 0);
});

// ------------------------------------------------------------------ review: backups can't be thinned out with only a session
test('admin-2: keeping fewer backups or none needs the password, and backups made by hand can’t push out older days', async () => {
  const enc = path.join(srv.dir, 'backups', 'encrypted');
  fs.mkdirSync(enc, { recursive: true });
  // Backups from the last few days, as the daily schedule leaves them.
  const old = [1, 2, 3].map((daysAgo) => {
    const name = `hearth-old-${daysAgo}d.hbk`;
    fs.writeFileSync(path.join(enc, name), crypto.randomBytes(256));
    const t = (Date.now() - daysAgo * 86400000) / 1000;
    fs.utimesSync(path.join(enc, name), t, t);
    return name;
  });
  const settings = async () => (await as(owner, 'GET', '/admin/owner')).json.autoBackup;
  // With only the session: neither fewer backups nor none.
  const r1 = await as(owner, 'PUT', '/admin/owner', { autoBackup: { enabled: true, keep: 1 } });
  assert.equal(r1.status, 401); assert.equal(r1.json.code, 'bad_password');
  assert.equal((await as(owner, 'PUT', '/admin/owner', { autoBackup: { enabled: false, keep: 7 } })).status, 401);
  assert.equal((await as(owner, 'PUT', '/admin/owner', { autoBackup: { enabled: true, keep: 1 }, authKey: hex(32) })).status, 401);
  assert.deepEqual(await settings(), { enabled: true, keep: 7 });
  for (let i = 0; i < 2; i++) assert.equal((await as(owner, 'POST', '/admin/backups', {})).status, 200);
  for (const name of old) assert.ok(fs.existsSync(path.join(enc, name)), `${name} is still there`);
  // The owner, with the password, keeps 2. A backup made by hand then removes only what the daily schedule would
  // (yesterday's stays), and each removal is in the audit log.
  assert.equal((await as(owner, 'PUT', '/admin/owner', { autoBackup: { enabled: true, keep: 2 }, authKey: owner.authKey })).status, 200);
  assert.match(logRows('owner_settings').pop().detail, /keep 7 → on, keep 2/);
  assert.equal((await as(owner, 'POST', '/admin/backups', {})).status, 200);
  assert.ok(fs.existsSync(path.join(enc, old[0])), 'yesterday’s backup is kept');
  const pruned = logRows('backup_pruned').map((r) => r.detail);
  for (const name of old.slice(1)) {
    assert.ok(!fs.existsSync(path.join(enc, name)), `${name} is past what's kept`);
    assert.ok(pruned.some((d) => d.startsWith(name)), `removing ${name} is logged`);
  }
  // More backups again needs no password.
  assert.equal((await as(owner, 'PUT', '/admin/owner', { autoBackup: { enabled: true, keep: 7 } })).status, 200);
  assert.deepEqual(await settings(), { enabled: true, keep: 7 });
});

test('admin-6: a new donation link needs the password too; the rest of the funding card doesn’t', async () => {
  const fundingNow = async () => (await as(owner, 'GET', '/admin/owner')).json.funding;
  const before = (await fundingNow()).url;
  const r = await as(owner, 'PUT', '/admin/owner', { funding: { url: 'https://ko-fi.com/someone-else' } });
  assert.equal(r.status, 401); assert.equal(r.json.code, 'bad_password');
  assert.equal((await fundingNow()).url, before);
  // The form sends the link with every save: unchanged, it needs nothing.
  assert.equal((await as(owner, 'PUT', '/admin/owner', { funding: { url: before, monthly: 40, note: 'Thanks!' } })).status, 200);
  assert.equal((await fundingNow()).monthly, 40);
  const ok = await as(owner, 'PUT', '/admin/owner', { funding: { url: 'https://ko-fi.com/hearth-host' }, authKey: owner.authKey });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await fundingNow()).url, 'https://ko-fi.com/hearth-host');
  const row = logRows('owner_settings').pop();
  assert.match(row.detail, /donation link changed/); assert.ok(!row.detail.includes('authKey'));
});

// ------------------------------------------------------------------ review: thread replies and group chats
test('admin-4: a thread can’t be removed when it has replies by staff at the remover’s level or above', async () => {
  const reply = (root, author) => {
    const id = 'm' + hex(8);
    srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, text.id, author.id, '', cipher(), 1, Date.now(), root);
    return id;
  };
  const count = (...ids) => srv.sql(`SELECT COUNT(*) n FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)[0].n;
  const root = channelMsg(alice); const ownerReply = reply(root, owner);
  const r = await as(mod, 'DELETE', `/admin/messages/${root}`);
  assert.equal(r.status, 403, r.text);
  assert.equal(count(root, ownerReply), 2, 'nothing removed');
  const mine = channelMsg(mod); const adminReply = reply(mine, admin);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${mine}`)).status, 403, 'not even under their own message');
  assert.equal(count(mine, adminReply), 2);
  // Replies by people below them still go with the thread; someone ranked higher can remove the others.
  const spam = channelMsg(alice); const r1 = reply(spam, bob); const r2 = reply(spam, alice);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${spam}`)).status, 200);
  assert.equal(count(spam, r1, r2), 0);
  assert.equal((await as(admin, 'DELETE', `/admin/messages/${mine}`)).status, 200);
  assert.equal((await as(owner, 'DELETE', `/admin/messages/${root}`)).status, 200);
  assert.equal(count(root, ownerReply, mine, adminReply), 0);
});

test('admin-4: group chat messages, like DMs, can only be removed by staff when they were reported', async () => {
  const g = await as(alice, 'POST', '/groups', { userIds: [bob.id] });
  assert.equal(g.status, 200, g.text);
  const chat = srv.sql("SELECT id FROM channels WHERE server_id = ? AND type = 'text'", g.json.id)[0].id;
  const id = 'm' + hex(8);
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, chat, alice.id, '', cipher(), 1, Date.now());
  const r = await as(mod, 'DELETE', `/admin/messages/${id}`);
  assert.equal(r.status, 403, r.text);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', id)[0].n, 1);
  const rep = await as(bob, 'POST', '/reports', { category: 'harassment', context: { kind: 'message', messageId: id }, evidence: [{ id, text: 'mean' }] });
  assert.equal(rep.status, 200, rep.text);
  assert.equal((await as(mod, 'DELETE', `/admin/messages/${id}`)).status, 200, 'reported: can be removed');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM messages WHERE id = ?', id)[0].n, 0);
});
