// Creator memberships: owners connect Stripe and sell tiers that give a role; members pay through Stripe
// Checkout; webhooks turn the role on and off. Stripe itself is a small fake server here.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { startServer, hex } = require('./helpers');

const WHSEC = 'whsec_' + 'a'.repeat(32);
let srv; let fake; const calls = []; const subs = new Map(); let accountReady = false;
const as = (u, method, path, body) => srv.api(method, path, { token: u.token, ip: u.ip, body });

before(async () => {
  // Fake Stripe: records what Hearth asks for and answers like the real API.
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const p = Object.fromEntries(new URLSearchParams(body));
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, p });
      const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && req.url === '/v1/accounts') return send({ id: 'acct_' + hex(8) });
      if (req.method === 'POST' && req.url === '/v1/account_links') return send({ url: 'https://connect.stripe.test/setup/' + hex(4) });
      let m = req.url.match(/^\/v1\/accounts\/(acct_\w+)$/);
      if (m) return send({ id: m[1], details_submitted: accountReady, payouts_enabled: accountReady, capabilities: { transfers: accountReady ? 'active' : 'inactive' } });
      if ((m = req.url.match(/^\/v1\/accounts\/(acct_\w+)\/login_links$/))) return send({ url: 'https://connect.stripe.test/express/' + m[1] });
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') return send({ id: 'cs_' + hex(6), url: 'https://checkout.stripe.test/c/pay/' + hex(6) });
      if ((m = req.url.match(/^\/v1\/subscriptions\/(sub_\w+)$/))) {
        const s = subs.get(m[1]);
        if (!s) return send({ error: { message: 'No such subscription' } }, 404);
        if (req.method === 'POST' && p.cancel_at_period_end === 'true') s.cancel_at_period_end = true;
        if (req.method === 'DELETE') s.status = 'canceled';
        return send(s);
      }
      send({ error: { message: 'unknown ' + req.url } }, 404);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  srv = await startServer({ STRIPE_API_BASE: `http://127.0.0.1:${fake.address().port}`, PUBLIC_URL: 'https://chat.example.test' });
});
after(async () => { await srv.stop(); fake.close(); });

// Sends a webhook signed like Stripe signs them.
async function hook(event, secret = WHSEC, t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const r = await fetch(`${srv.base}/api/pay/memberships`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body });
  return r.status;
}

async function setup() {
  const owner = await srv.register(); const fan = await srv.register(); const other = await srv.register();
  const server = (await as(owner, 'POST', '/servers', { name: 'Studio ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  await as(fan, 'POST', `/invites/${invite.code}/join`); await as(other, 'POST', `/invites/${invite.code}/join`);
  const role = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Supporters', permissions: 0 })).json;
  const vip = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'behind-the-scenes', type: 'text' })).json;
  // Only Supporters can see #behind-the-scenes.
  await as(owner, 'PUT', `/channels/${vip.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: 1 }, { type: 'role', id: role.id, allow: 1, deny: 0 }] });
  return { owner, fan, other, server, role, vip };
}
const sees = async (u, sid, cid) => (await as(u, 'GET', '/bootstrap')).json.servers.find((s) => s.id === sid).channels.some((c) => c.id === cid);
const rolesOf = (sid, uid) => srv.sql('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?', sid, uid).map((r) => r.role_id);

test('memberships: off until the Hearth owner sets up Stripe; only they can', async () => {
  const { owner, server } = await setup();
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/memberships/connect`)).status, 400, 'not turned on yet');
  assert.equal((await as(owner, 'PUT', '/admin/memberships', { enabled: true })).status, 403, 'server owners aren’t instance admins');
  const admin = srv.owner;
  assert.equal((await as(admin, 'PUT', '/admin/memberships', { key: 'pk_live_nope' })).status, 400, 'publishable keys are refused');
  assert.equal((await as(admin, 'PUT', '/admin/memberships', { feePercent: 50 })).status, 400, 'fee capped');
  const r = await as(admin, 'PUT', '/admin/memberships', { enabled: true, key: 'sk_test_' + 'k'.repeat(24), webhookSecret: WHSEC, feePercent: 5, currency: 'usd', authKey: admin.authKey });
  assert.equal(r.status, 200, r.text);
  const cfg = (await as(admin, 'GET', '/admin/memberships')).json;
  assert.deepEqual([cfg.config.enabled, cfg.config.keySet, cfg.config.keyMode, cfg.config.webhookSet, cfg.config.feePercent, cfg.config.currency], [true, true, 'test', true, 5, 'USD']);
  assert.ok(!JSON.stringify(cfg).includes('kkkkkkkk'), 'the key is never sent back');
  const stored = srv.sql("SELECT value FROM instance_settings WHERE key = 'memberships'")[0].value;
  assert.ok(!stored.includes('kkkkkkkk'), 'the key is stored encrypted');
});

test('memberships: an owner connects Stripe, sells a tier, a fan pays and gets the role and the private channel', async () => {
  const { owner, fan, other, server, role, vip } = await setup();
  // Only the owner can connect and sell.
  assert.equal((await as(fan, 'POST', `/servers/${server.id}/memberships/connect`)).status, 403);
  const c = await as(owner, 'POST', `/servers/${server.id}/memberships/connect`);
  assert.equal(c.status, 200, c.text);
  assert.match(c.json.url, /^https:\/\/connect\.stripe\.test\//);
  const acctCall = calls.filter((x) => x.url === '/v1/accounts').pop();
  assert.equal(acctCall.p.type, 'express');
  assert.equal(acctCall.auth, 'Bearer sk_test_' + 'k'.repeat(24));
  // Tiers: sensible prices, a role without moderator powers, owner only.
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/memberships/tiers`, { name: 'Fan', priceCents: 50, roleId: role.id })).status, 400, 'too cheap');
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/memberships/tiers`, { name: 'Fan', priceCents: 500, roleId: server.id })).status, 400, 'not @everyone');
  const mod = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Mods', permissions: 1 << 9 })).json;
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/memberships/tiers`, { name: 'Fan', priceCents: 500, roleId: mod.id })).status, 400, 'no buying moderator powers');
  assert.equal((await as(fan, 'POST', `/servers/${server.id}/memberships/tiers`, { name: 'Fan', priceCents: 500, roleId: role.id })).status, 403);
  const tier = (await as(owner, 'POST', `/servers/${server.id}/memberships/tiers`, { name: 'Fan', description: 'Early videos', priceCents: 500, roleId: role.id })).json;
  assert.equal(tier.role.id, role.id);
  // Not on sale until Stripe says the account can be paid.
  assert.equal((await as(fan, 'POST', `/servers/${server.id}/memberships/tiers/${tier.id}/checkout`)).status, 400);
  accountReady = true;
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/memberships/refresh`)).json.ready, true);
  const view = (await as(fan, 'GET', `/servers/${server.id}/memberships`)).json;
  assert.equal(view.tiers.length, 1); assert.equal(view.owner, undefined, 'members don’t see the owner’s view');
  assert.equal((await as(fan, 'GET', '/bootstrap')).json.servers.find((s) => s.id === server.id).memberships, true);
  // Checkout: monthly, the Hearth's fee, money to the creator's account.
  const co = await as(fan, 'POST', `/servers/${server.id}/memberships/tiers/${tier.id}/checkout`);
  assert.equal(co.status, 200, co.text);
  assert.match(co.json.url, /^https:\/\/checkout\.stripe\.test\//);
  const p = calls.filter((x) => x.url === '/v1/checkout/sessions').pop().p;
  assert.equal(p.mode, 'subscription');
  assert.equal(p['line_items[0][price_data][unit_amount]'], '500');
  assert.equal(p['line_items[0][price_data][recurring][interval]'], 'month');
  assert.equal(p['subscription_data[application_fee_percent]'], '5');
  assert.equal(p['subscription_data[transfer_data][destination]'], srv.sql('SELECT stripe_account FROM creator_accounts WHERE server_id = ?', server.id)[0].stripe_account);
  assert.equal(p['subscription_data[metadata][user]'], fan.id);
  assert.match(p.success_url, /^https:\/\/chat\.example\.test\/\?membership=thanks/);
  assert.equal(await sees(fan, server.id, vip.id), false);
  // Stripe tells Hearth it's paid.
  const subId = 'sub_' + hex(8);
  const meta = { kind: 'membership', server: server.id, tier: tier.id, user: fan.id };
  subs.set(subId, { id: subId, status: 'active', customer: 'cus_1', cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: meta });
  assert.equal(await hook({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: subId, metadata: meta } } }), 200);
  assert.deepEqual(rolesOf(server.id, fan.id), [role.id]);
  assert.equal(await sees(fan, server.id, vip.id), true, 'the private channel opens');
  assert.equal(await sees(other, server.id, vip.id), false, 'still hidden from everyone else');
  const mine = (await as(fan, 'GET', `/servers/${server.id}/memberships`)).json.mine;
  assert.equal(mine.length, 1); assert.equal(mine[0].status, 'active');
  assert.equal((await as(fan, 'POST', `/servers/${server.id}/memberships/tiers/${tier.id}/checkout`)).status, 400, 'can’t buy it twice');
  const ownerView = (await as(owner, 'GET', `/servers/${server.id}/memberships`)).json.owner;
  assert.equal(ownerView.members.length, 1); assert.equal(ownerView.monthlyCents, 500);
  // The same event twice changes nothing.
  assert.equal(await hook({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: subId, metadata: meta } } }), 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM memberships WHERE stripe_sub = ?', subId)[0].n, 1);
  // Cancel: keeps access until the end of the month, then Stripe ends it and the role goes.
  const cancel = await as(fan, 'POST', `/servers/${server.id}/memberships/${mine[0].id}/cancel`);
  assert.equal(cancel.json.cancelAtEnd, true);
  assert.equal(await sees(fan, server.id, vip.id), true, 'paid-for month still counts');
  subs.get(subId).status = 'canceled';
  assert.equal(await hook({ type: 'customer.subscription.deleted', data: { object: subs.get(subId) } }), 200);
  assert.deepEqual(rolesOf(server.id, fan.id), []);
  assert.equal(await sees(fan, server.id, vip.id), false);
});

test('memberships: forged or stale webhooks are refused; leaving stops the billing', async () => {
  const { owner, fan, server, role } = await setup();
  await as(owner, 'POST', `/servers/${server.id}/memberships/connect`);
  await as(owner, 'POST', `/servers/${server.id}/memberships/refresh`);
  const tier = (await as(owner, 'POST', `/servers/${server.id}/memberships/tiers`, { name: 'Club', priceCents: 300, roleId: role.id })).json;
  const subId = 'sub_' + hex(8);
  const meta = { kind: 'membership', server: server.id, tier: tier.id, user: fan.id };
  subs.set(subId, { id: subId, status: 'active', customer: 'cus_2', cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: meta });
  const ev = { type: 'customer.subscription.updated', data: { object: subs.get(subId) } };
  assert.equal(await hook(ev, 'whsec_' + 'b'.repeat(32)), 400, 'wrong secret');
  assert.equal(await hook(ev, WHSEC, Math.floor(Date.now() / 1000) - 3600), 400, 'replayed an hour later');
  assert.deepEqual(rolesOf(server.id, fan.id), []);
  // A subscription for someone else's server can't be pinned on this one.
  const bad = { ...subs.get(subId), id: 'sub_' + hex(8), metadata: { ...meta, server: 'nope' } };
  assert.equal(await hook({ type: 'customer.subscription.updated', data: { object: bad } }), 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM memberships WHERE stripe_sub = ?', bad.id)[0].n, 0);
  assert.equal(await hook(ev), 200);
  assert.deepEqual(rolesOf(server.id, fan.id), [role.id]);
  // Leaving the server cancels at the end of the paid month (no surprise charges next month).
  assert.equal((await as(fan, 'POST', `/servers/${server.id}/leave`)).status, 200);
  for (let i = 0; i < 20 && !subs.get(subId).cancel_at_period_end; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(subs.get(subId).cancel_at_period_end, true, 'Stripe was told to stop renewing');
});

test('memberships: when a membership ends, the members-only call drops that person (they don’t keep listening)', async () => {
  const { owner, fan, server, role } = await setup();
  await as(owner, 'POST', `/servers/${server.id}/memberships/connect`);
  await as(owner, 'POST', `/servers/${server.id}/memberships/refresh`);
  const tier = (await as(owner, 'POST', `/servers/${server.id}/memberships/tiers`, { name: 'Backstage', priceCents: 400, roleId: role.id })).json;
  // A voice channel only Supporters can see and join (VIEW_CHANNEL = 1, CONNECT = 64).
  const call = (await as(owner, 'POST', `/servers/${server.id}/channels`, { name: 'backstage', type: 'voice' })).json;
  await as(owner, 'PUT', `/channels/${call.id}/overrides`, { overrides: [{ type: 'role', id: server.id, allow: 0, deny: 1 | 64 }, { type: 'role', id: role.id, allow: 1 | 64, deny: 0 }] });
  const subId = 'sub_' + hex(8);
  const meta = { kind: 'membership', server: server.id, tier: tier.id, user: fan.id };
  subs.set(subId, { id: subId, status: 'active', customer: 'cus_3', cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: meta });
  assert.equal(await hook({ type: 'customer.subscription.updated', data: { object: subs.get(subId) } }), 200);
  assert.deepEqual(rolesOf(server.id, fan.id), [role.id]);
  const so = await srv.socket(owner.token); const sf = await srv.socket(fan.token);
  const ack = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
  try {
    assert.equal((await ack(so, 'voice:join', { channelId: call.id })).ok, true);
    assert.equal((await ack(sf, 'voice:join', { channelId: call.id })).ok, true, 'a paying member joins');
    const kicked = new Promise((r) => { sf.once('voice:kicked', r); setTimeout(() => r(null), 3000); });
    subs.get(subId).status = 'canceled';
    assert.equal(await hook({ type: 'customer.subscription.deleted', data: { object: subs.get(subId) } }), 200);
    assert.ok(await kicked, 'the ended member is taken out of the call');
    assert.ok((await ack(sf, 'voice:signal', { to: so.id, data: { x: 1 } })).error, 'and can’t signal anyone in it');
    const inCall = (await as(owner, 'GET', '/bootstrap')).json.voice[call.id] || [];
    assert.equal(inCall.some((x) => x.userId === fan.id), false);
    assert.equal(inCall.some((x) => x.userId === owner.id), true, 'the owner stays');
  } finally { so.close(); sf.close(); }
});
