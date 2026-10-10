// Creator memberships: a server's owner sells monthly tiers (like Patreon, inside the server). Each tier
// gives a role, and roles can open private channels, so "supporters get #behind-the-scenes" just works.
//
// Money: members pay through Stripe Checkout; Stripe sends it to the creator's own Stripe account (Stripe
// Connect Express, which also handles their identity checks, payouts and tax forms). This Hearth keeps the
// fee its owner sets in Admin → Money (application_fee_percent); nothing else is taken. Nothing that is
// free today depends on this: memberships only add things a creator chooses to offer.
//
// Stripe calls go to STRIPE_API_BASE (tests point it at a fake). Webhooks (checkout.session.completed,
// customer.subscription.updated / .deleted, invoice.paid) arrive at /api/pay/memberships and are checked
// against their signing secret.
const crypto = require('crypto');

module.exports = function setupMemberships(ctx) {
  const { api, auth, db, fail, wrap, rateLimit, getSetting, setSetting, requireInstanceAdmin, requireServer, requireOwner,
    isMember, emitServer, emitTo, seal, unseal, newId, brief, PM, mailPublicUrl, auditLog, stepUp, sealSecret, openSecret } = ctx;
  const now = () => Date.now();
  const API = () => (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');
  const MAX_TIERS = 5;
  // A role you can buy can't come with moderator powers.
  const POWERFUL = PM.ADMINISTRATOR | PM.MANAGE_SERVER | PM.MANAGE_ROLES | PM.MANAGE_CHANNELS | PM.MANAGE_MESSAGES
    | PM.MANAGE_EMOJIS | PM.KICK_MEMBERS | PM.BAN_MEMBERS;
  const LIVE = ['active', 'past_due']; // past_due: Stripe is still retrying the card, so they keep access meanwhile

  // ------------------------------------------------------------------ settings (Admin → Money)
  function cfg() {
    let v = {};
    try { v = JSON.parse(getSetting('memberships') || '{}') || {}; } catch { /* defaults */ }
    const key = v.key ? (unseal(v.key) || {}).k || '' : '';
    return {
      enabled: !!v.enabled,
      key,
      webhookSecret: openSecret(v.webhookSecret), // sealed with data/secret.key: anyone with it could fake payments
      feePercent: Number.isFinite(+v.feePercent) ? Math.max(0, Math.min(30, +v.feePercent)) : 5,
      currency: typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency) ? v.currency : 'USD',
    };
  }
  const usable = (c = cfg()) => c.enabled && !!c.key && !!c.webhookSecret;

  // ------------------------------------------------------------------ talking to Stripe
  function encode(obj, prefix, out = new URLSearchParams()) {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const name = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? encode(x, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(x))));
      else if (typeof v === 'object') encode(v, name, out);
      else out.append(name, String(v));
    }
    return out;
  }
  async function stripe(method, path, params) {
    const c = cfg();
    if (!c.key) fail(400, 'Memberships aren’t set up on this Hearth yet.');
    const body = params ? encode(params).toString() : undefined;
    let r;
    try {
      r = await fetch(API() + path + (method === 'GET' && body ? `?${body}` : ''), {
        method,
        headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(15000),
      });
    } catch { fail(502, 'Couldn’t reach Stripe. Try again in a moment.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) fail(502, `Stripe: ${String((j.error && j.error.message) || r.status).slice(0, 200)}`, r.status === 404 ? 'stripe_not_found' : 'stripe_error');
    return j;
  }

  // ------------------------------------------------------------------ helpers
  const tierRow = (id) => db.prepare('SELECT * FROM membership_tiers WHERE id = ?').get(id);
  const account = (sid) => db.prepare('SELECT * FROM creator_accounts WHERE server_id = ?').get(sid);
  const roleRow = (sid, rid) => rid && db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(rid, sid);
  // A role that comes with moderator powers, either itself or through a channel override.
  const powerful = (r) => !!r && (!!(r.permissions & POWERFUL)
    || !!db.prepare("SELECT 1 FROM channel_overrides WHERE target_type = 'role' AND target_id = ? AND (allow & ?) != 0").get(r.id, POWERFUL));
  // The membership that gives a role, while it's on sale or anyone still has it (or is signing up), or null.
  const tierForRole = (rid) => (rid && db.prepare(`SELECT t.* FROM membership_tiers t WHERE t.role_id = ? AND (t.active = 1
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.tier_id = t.id AND m.status IN ('active', 'past_due', 'pending'))) ORDER BY t.active DESC, t.created_at LIMIT 1`).get(rid)) || null;
  const publicTier = (t) => {
    const r = roleRow(t.server_id, t.role_id);
    return { id: t.id, name: t.name, description: t.description, priceCents: t.price_cents, currency: t.currency, active: !!t.active,
      role: r ? { id: r.id, name: r.name, color: r.color } : null };
  };
  const publicMembership = (m) => ({ id: m.id, tierId: m.tier_id, status: m.status, cancelAtEnd: !!m.cancel_at_end, periodEnd: m.period_end,
    amountCents: m.amount_cents, currency: m.currency, since: m.created_at });
  // Whether a server sells anything right now (the app shows "Memberships" in its menu).
  const offers = (sid) => usable() && !!(account(sid) || {}).ready && !!db.prepare('SELECT 1 FROM membership_tiers WHERE server_id = ? AND active = 1').get(sid);

  function baseUrl(req) {
    const u = mailPublicUrl();
    return u || `${req.protocol}://${req.get('host')}`;
  }

  // The roles a person should have from memberships: exactly the roles of their live memberships' tiers.
  // Roles that belong to a tier are managed here (given and taken away); other roles are never touched.
  function syncRoles(sid, uid) {
    if (!isMember(sid, uid)) return;
    const tierRoles = new Set(db.prepare('SELECT role_id FROM membership_tiers WHERE server_id = ? AND role_id IS NOT NULL').all(sid).map((r) => r.role_id));
    if (!tierRoles.size) return;
    const want = new Set(db.prepare(`SELECT t.role_id FROM memberships m JOIN membership_tiers t ON t.id = m.tier_id
      WHERE m.server_id = ? AND m.user_id = ? AND m.status IN ('active', 'past_due') AND t.role_id IS NOT NULL`).all(sid, uid).map((r) => r.role_id));
    const has = new Set(db.prepare('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(sid, uid).map((r) => r.role_id));
    let changed = false;
    for (const rid of tierRoles) {
      const role = roleRow(sid, rid);
      if (!role) continue;
      // Moderator powers can't be bought: a tier role that got them later (an edit, an override) isn't handed out.
      if (want.has(rid) && !has.has(rid) && powerful(role)) { console.warn(`Not giving the membership role "${role.name}": it has moderator powers.`); continue; }
      if (want.has(rid) && !has.has(rid)) { db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, uid, rid); changed = true; }
      if (!want.has(rid) && has.has(rid)) { db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').run(sid, uid, rid); changed = true; }
    }
    if (changed) emitServer(sid);
  }

  const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', incomplete: 'pending', unpaid: 'ended', canceled: 'ended', incomplete_expired: 'ended', paused: 'ended' };
  const periodEnd = (sub) => {
    const s = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
    return s ? s * 1000 : null;
  };
  // Apply what Stripe says about a subscription. Creates the membership from the checkout's metadata if needed.
  function applySubscription(sub, meta = sub.metadata || {}) {
    if (!sub || typeof sub.id !== 'string') return null;
    let m = db.prepare('SELECT * FROM memberships WHERE stripe_sub = ?').get(sub.id);
    if (!m) {
      const t = tierRow(String(meta.tier || ''));
      const uid = String(meta.user || '');
      if (!t || t.server_id !== meta.server || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return null;
      const id = newId();
      db.prepare(`INSERT INTO memberships (id, server_id, tier_id, user_id, stripe_sub, stripe_customer, status, amount_cents, currency, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(id, t.server_id, t.id, uid, sub.id, String(sub.customer || ''), t.price_cents, t.currency, now(), now());
      m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(id);
    }
    const status = STATUS[sub.status] || m.status;
    db.prepare('UPDATE memberships SET status = ?, cancel_at_end = ?, period_end = COALESCE(?, period_end), stripe_customer = COALESCE(NULLIF(?, \'\'), stripe_customer), updated_at = ? WHERE id = ?')
      .run(status, sub.cancel_at_period_end ? 1 : 0, periodEnd(sub), String(sub.customer || ''), now(), m.id);
    syncRoles(m.server_id, m.user_id);
    const after = db.prepare('SELECT * FROM memberships WHERE id = ?').get(m.id);
    emitTo(m.user_id, 'membership:update', { serverId: m.server_id, membership: publicMembership(after) });
    return after;
  }

  // ------------------------------------------------------------------ webhook
  const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  function verified(req, secret) {
    const header = String(req.get('stripe-signature') || '');
    const t = +((header.match(/(?:^|,)\s*t=(\d+)/) || [])[1] || 0);
    const sigs = header.split(',').map((x) => x.trim()).filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
    if (!t || !sigs.length || !req.rawBody || Math.abs(now() / 1000 - t) > 300) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${req.rawBody.toString('utf8')}`).digest('hex');
    return sigs.some((s) => safeEq(s, expected));
  }
  // Stripe → Developers → Webhooks → https://your-server/api/pay/memberships, events: checkout.session.completed,
  // customer.subscription.updated, customer.subscription.deleted, invoice.paid.
  api.post('/pay/memberships', wrap(async (req, res) => {
    rateLimit('memberships-hook:' + req.ip, 600, 60000);
    const c = cfg();
    if (!c.webhookSecret || !verified(req, c.webhookSecret)) return res.status(400).json({ error: 'Bad signature.' });
    const ev = req.body || {};
    const o = (ev.data && ev.data.object) || {};
    try {
      if (ev.type === 'checkout.session.completed' && o.mode === 'subscription' && o.metadata && o.metadata.kind === 'membership' && o.subscription) {
        const sub = typeof o.subscription === 'object' ? o.subscription : await stripe('GET', `/v1/subscriptions/${encodeURIComponent(o.subscription)}`);
        applySubscription(sub, o.metadata);
      } else if (ev.type === 'customer.subscription.created' || ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
        // Stripe confirms a subscription of a deleted server has ended: nothing left to retry.
        if (ev.type === 'customer.subscription.deleted' || STATUS[o.status] === 'ended') db.prepare('DELETE FROM membership_cancellations WHERE stripe_sub = ?').run(String(o.id || ''));
        if ((o.metadata || {}).kind === 'membership' || db.prepare('SELECT 1 FROM memberships WHERE stripe_sub = ?').get(String(o.id || ''))) applySubscription(o);
      } else if (ev.type === 'invoice.paid' && (o.subscription || (o.parent && o.parent.subscription_details))) {
        // Newer Stripe API versions keep it under parent.subscription_details.
        const ref = o.subscription || o.parent.subscription_details.subscription;
        const subId = typeof ref === 'object' && ref ? ref.id : String(ref || '');
        if (db.prepare('SELECT 1 FROM memberships WHERE stripe_sub = ?').get(subId)) applySubscription(await stripe('GET', `/v1/subscriptions/${encodeURIComponent(subId)}`));
      }
    } catch (e) {
      // Tell Stripe to try again later (it retries for days) rather than losing the event.
      return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
    }
    res.json({ received: true });
  }));

  // ------------------------------------------------------------------ what members see
  api.get('/servers/:id/memberships', auth, (req, res) => {
    const s = requireServer(req.params.id, req.userId);
    const c = cfg();
    const acct = account(s.id);
    const out = {
      available: usable(c),
      ready: !!(acct && acct.ready),
      feePercent: c.feePercent,
      currency: c.currency,
      tiers: db.prepare('SELECT * FROM membership_tiers WHERE server_id = ? AND active = 1 ORDER BY position, price_cents').all(s.id).map(publicTier),
      mine: db.prepare("SELECT * FROM memberships WHERE server_id = ? AND user_id = ? AND status != 'ended' ORDER BY created_at DESC").all(s.id, req.userId).map(publicMembership),
    };
    if (s.owner_id === req.userId) {
      const members = db.prepare("SELECT * FROM memberships WHERE server_id = ? AND status != 'pending' ORDER BY status = 'ended', created_at DESC LIMIT 200").all(s.id);
      out.owner = {
        connected: !!acct,
        allTiers: db.prepare('SELECT * FROM membership_tiers WHERE server_id = ? ORDER BY active DESC, position, price_cents').all(s.id).map(publicTier),
        members: members.map((m) => ({ ...publicMembership(m), user: brief(m.user_id) })),
        monthlyCents: members.filter((m) => LIVE.includes(m.status)).reduce((a, m) => a + m.amount_cents, 0),
      };
    }
    res.json(out);
  });

  // Start paying: a Stripe Checkout page for this tier. Returns its address; the app opens it.
  api.post('/servers/:id/memberships/tiers/:tid/checkout', auth, wrap(async (req, res) => {
    const s = requireServer(req.params.id, req.userId);
    rateLimit('membership-checkout:' + req.userId, 20, 3600000);
    const c = cfg();
    const acct = account(s.id);
    const t = tierRow(req.params.tid);
    if (!usable(c) || !acct || !acct.ready) fail(400, 'This server isn’t taking memberships right now.');
    if (!t || t.server_id !== s.id || !t.active) fail(404, 'That membership isn’t available.');
    // Its role was deleted: there'd be nothing to get for the money.
    if (t.role_id && !roleRow(s.id, t.role_id)) fail(404, 'That membership isn’t available.');
    if (s.owner_id === req.userId) fail(400, 'This is your own server, so there’s nothing to pay for.');
    if (db.prepare("SELECT 1 FROM memberships WHERE server_id = ? AND user_id = ? AND tier_id = ? AND status IN ('active', 'past_due')").get(s.id, req.userId, t.id)) {
      fail(400, 'You already have this membership.');
    }
    const base = baseUrl(req);
    const meta = { kind: 'membership', server: s.id, tier: t.id, user: req.userId };
    const session = await stripe('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      client_reference_id: req.userId,
      line_items: [{ quantity: 1, price_data: { currency: t.currency.toLowerCase(), unit_amount: t.price_cents, recurring: { interval: 'month' }, product_data: { name: `${t.name} · ${s.name}`.slice(0, 250) } } }],
      subscription_data: { application_fee_percent: c.feePercent, transfer_data: { destination: acct.stripe_account }, metadata: meta },
      metadata: meta,
      success_url: `${base}/?membership=thanks&server=${encodeURIComponent(s.id)}`,
      cancel_url: `${base}/?membership=cancelled&server=${encodeURIComponent(s.id)}`,
    });
    if (typeof session.url !== 'string' || !/^https:\/\//.test(session.url)) fail(502, 'Stripe didn’t return a checkout page.');
    res.json({ url: session.url });
  }));

  // Stop paying: it stays on until the end of the month already paid for.
  api.post('/servers/:id/memberships/:mid/cancel', auth, wrap(async (req, res) => {
    const s = requireServer(req.params.id, req.userId);
    const m = db.prepare('SELECT * FROM memberships WHERE id = ? AND server_id = ? AND user_id = ?').get(req.params.mid, s.id, req.userId);
    if (!m) fail(404, 'Membership not found.');
    if (m.status === 'ended') return res.json(publicMembership(m));
    const sub = await stripe('POST', `/v1/subscriptions/${encodeURIComponent(m.stripe_sub)}`, { cancel_at_period_end: true });
    res.json(publicMembership(applySubscription(sub) || m));
  }));

  // ------------------------------------------------------------------ what the server's owner manages
  // Connect (or finish connecting) the owner's Stripe account. Returns Stripe's onboarding page.
  api.post('/servers/:id/memberships/connect', auth, wrap(async (req, res) => {
    const s = requireOwner(req.params.id, req.userId);
    if (s.kind === 'group') fail(400, 'Group chats can’t sell memberships.');
    if (!usable()) fail(400, 'Memberships aren’t turned on for this Hearth. Ask its owner.');
    rateLimit('membership-connect:' + req.userId, 20, 3600000);
    let acct = account(s.id);
    if (!acct) {
      const a = await stripe('POST', '/v1/accounts', { type: 'express', capabilities: { card_payments: { requested: true }, transfers: { requested: true } }, metadata: { hearth_server: s.id } });
      if (typeof a.id !== 'string' || !/^acct_\w+$/.test(a.id)) fail(502, 'Stripe didn’t create the account.');
      db.prepare('INSERT INTO creator_accounts (server_id, stripe_account, ready, checked_at) VALUES (?, ?, 0, ?)').run(s.id, a.id, now());
      acct = account(s.id);
    }
    const base = baseUrl(req);
    const link = await stripe('POST', '/v1/account_links', {
      account: acct.stripe_account, type: 'account_onboarding',
      refresh_url: `${base}/?membership=connect&server=${encodeURIComponent(s.id)}`,
      return_url: `${base}/?membership=connected&server=${encodeURIComponent(s.id)}`,
    });
    if (typeof link.url !== 'string' || !/^https:\/\//.test(link.url)) fail(502, 'Stripe didn’t return a sign-up page.');
    res.json({ url: link.url });
  }));

  // Ask Stripe whether the owner's account can receive money yet.
  async function refreshAccount(sid) {
    const acct = account(sid);
    if (!acct) return null;
    const a = await stripe('GET', `/v1/accounts/${encodeURIComponent(acct.stripe_account)}`);
    const ready = !!(a.details_submitted && a.capabilities && a.capabilities.transfers === 'active');
    db.prepare('UPDATE creator_accounts SET ready = ?, checked_at = ? WHERE server_id = ?').run(ready ? 1 : 0, now(), sid);
    if (ready !== !!acct.ready) emitServer(sid);
    return { ready, needsInfo: !ready && !!a.details_submitted, payouts: !!a.payouts_enabled };
  }
  api.post('/servers/:id/memberships/refresh', auth, wrap(async (req, res) => {
    const s = requireOwner(req.params.id, req.userId);
    rateLimit('membership-refresh:' + req.userId, 60, 3600000);
    res.json((await refreshAccount(s.id)) || { ready: false });
  }));

  // The creator's own Stripe dashboard (payouts, refunds, tax forms).
  api.post('/servers/:id/memberships/dashboard', auth, wrap(async (req, res) => {
    const s = requireOwner(req.params.id, req.userId);
    const acct = account(s.id);
    if (!acct) fail(400, 'Connect Stripe first.');
    const l = await stripe('POST', `/v1/accounts/${encodeURIComponent(acct.stripe_account)}/login_links`, {});
    if (typeof l.url !== 'string' || !/^https:\/\//.test(l.url)) fail(502, 'Stripe didn’t return a dashboard link.');
    res.json({ url: l.url });
  }));

  function cleanTier(s, b, current = {}) {
    const name = String(b.name ?? current.name ?? '').trim().slice(0, 40);
    if (!name) fail(400, 'Give the membership a name.');
    const description = String(b.description ?? current.description ?? '').trim().slice(0, 300);
    const price = b.priceCents !== undefined ? Math.round(+b.priceCents) : current.price_cents;
    if (!Number.isFinite(price) || price < 100 || price > 50000) fail(400, 'The price can be from 1.00 to 500.00 a month.');
    const roleId = b.roleId !== undefined ? (b.roleId ? String(b.roleId) : null) : current.role_id ?? null;
    if (roleId) {
      const r = roleRow(s.id, roleId);
      if (!r || r.id === s.id) fail(400, 'Pick one of this server’s roles (not @everyone).');
      if (powerful(r)) fail(400, `"${r.name}" has moderator powers (itself or in a channel), so it can’t be sold. Pick or make a role without them.`);
      const other = db.prepare('SELECT name FROM membership_tiers WHERE server_id = ? AND role_id = ? AND id != ?').get(s.id, roleId, current.id || '');
      if (other) fail(400, `"${r.name}" already belongs to the "${other.name}" membership.`);
    }
    return { name, description, price, roleId };
  }
  api.post('/servers/:id/memberships/tiers', auth, (req, res) => {
    const s = requireOwner(req.params.id, req.userId);
    if (!usable()) fail(400, 'Memberships aren’t turned on for this Hearth. Ask its owner.');
    if (db.prepare('SELECT COUNT(*) n FROM membership_tiers WHERE server_id = ? AND active = 1').get(s.id).n >= MAX_TIERS) fail(400, `Up to ${MAX_TIERS} memberships per server.`);
    const t = cleanTier(s, req.body || {});
    const id = newId();
    const pos = (db.prepare('SELECT MAX(position) p FROM membership_tiers WHERE server_id = ?').get(s.id).p ?? -1) + 1;
    db.prepare('INSERT INTO membership_tiers (id, server_id, name, description, price_cents, currency, role_id, active, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, s.id, t.name, t.description, t.price, cfg().currency, t.roleId, pos, now());
    emitServer(s.id);
    res.json(publicTier(tierRow(id)));
  });
  // Changing the price only affects people who join from now on (Stripe keeps existing members' price).
  api.patch('/servers/:id/memberships/tiers/:tid', auth, (req, res) => {
    const s = requireOwner(req.params.id, req.userId);
    const cur = tierRow(req.params.tid);
    if (!cur || cur.server_id !== s.id) fail(404, 'Membership not found.');
    const t = cleanTier(s, req.body || {}, cur);
    db.prepare('UPDATE membership_tiers SET name = ?, description = ?, price_cents = ?, role_id = ? WHERE id = ?').run(t.name, t.description, t.price, t.roleId, cur.id);
    if (t.roleId !== cur.role_id) {
      for (const m of db.prepare('SELECT DISTINCT user_id FROM memberships WHERE tier_id = ?').all(cur.id)) syncRoles(s.id, m.user_id);
      if (cur.role_id) for (const r of db.prepare('SELECT user_id FROM member_roles WHERE server_id = ? AND role_id = ?').all(s.id, cur.role_id)) syncRoles(s.id, r.user_id);
    }
    emitServer(s.id);
    res.json(publicTier(tierRow(cur.id)));
  });
  // Stop selling a tier. People who already pay keep it until they cancel.
  api.delete('/servers/:id/memberships/tiers/:tid', auth, (req, res) => {
    const s = requireOwner(req.params.id, req.userId);
    const cur = tierRow(req.params.tid);
    if (!cur || cur.server_id !== s.id) fail(404, 'Membership not found.');
    db.prepare('UPDATE membership_tiers SET active = 0 WHERE id = ?').run(cur.id);
    emitServer(s.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ admin (Admin → Money)
  api.get('/admin/memberships', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const c = cfg();
    const live = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount_cents), 0) cents FROM memberships WHERE status IN ('active', 'past_due')").get();
    res.json({
      config: { enabled: c.enabled, keySet: !!c.key, keyMode: c.key ? (/_test_/.test(c.key) ? 'test' : 'live') : '', webhookSet: !!c.webhookSecret, feePercent: c.feePercent, currency: c.currency },
      stats: { creators: db.prepare('SELECT COUNT(*) n FROM creator_accounts WHERE ready = 1').get().n, members: live.n, monthlyCents: live.cents, feeCents: Math.round(live.cents * c.feePercent / 100),
        // Subscriptions of deleted servers that Stripe hasn't confirmed as ended yet (retried every hour).
        pendingCancellations: db.prepare('SELECT COUNT(*) n FROM membership_cancellations').get().n },
    });
  });
  // Every change goes in the audit log (names of what changed, never the secrets). Replacing the Stripe key or the
  // webhook secret decides where the money goes, so it needs the password (and two-factor) again.
  api.put('/admin/memberships', auth, wrap(async (req, res) => {
    requireInstanceAdmin(req.userId);
    const b = req.body || {};
    const before = cfg();
    let v = {};
    try { v = JSON.parse(getSetting('memberships') || '{}') || {}; } catch { /* fresh */ }
    const changed = [];
    if (b.enabled !== undefined) { v.enabled = !!b.enabled; if (v.enabled !== before.enabled) changed.push('enabled'); }
    if (b.key !== undefined) {
      const k = String(b.key || '').trim();
      if (k && !/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(k)) fail(400, 'Use a Stripe secret key (sk_live_…) or restricted key (rk_live_…).');
      v.key = k ? seal({ k }) : '';
      if (k !== before.key) changed.push('key');
    }
    if (b.webhookSecret !== undefined) {
      const w = String(b.webhookSecret || '').trim();
      if (w && !/^whsec_[A-Za-z0-9]{10,}$/.test(w)) fail(400, 'The webhook signing secret starts with whsec_');
      v.webhookSecret = sealSecret(w);
      if (w !== before.webhookSecret) changed.push('webhookSecret');
    }
    if (b.feePercent !== undefined) {
      const f = +b.feePercent;
      if (!Number.isFinite(f) || f < 0 || f > 30) fail(400, 'The fee can be 0 to 30%.');
      v.feePercent = Math.round(f * 10) / 10;
      if (v.feePercent !== before.feePercent) changed.push(`feePercent ${before.feePercent} \u2192 ${v.feePercent}`);
    }
    if (b.currency !== undefined) { const cur = String(b.currency || '').toUpperCase(); if (!/^[A-Z]{3}$/.test(cur)) fail(400, 'Use a 3-letter currency code like USD.'); v.currency = cur; if (cur !== before.currency) changed.push('currency'); }
    if (changed.includes('key') || changed.includes('webhookSecret')) await stepUp(req, b);
    setSetting('memberships', JSON.stringify(v));
    if (changed.length) auditLog(req, 'membership_settings', null, changed.join(', '));
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ keeping things right
  // Someone left (or was removed from) a server: stop billing them at the end of what they paid for.
  function onLeave(sid, uid) {
    const subs = db.prepare("SELECT stripe_sub FROM memberships WHERE server_id = ? AND user_id = ? AND status IN ('active', 'past_due', 'pending') AND cancel_at_end = 0").all(sid, uid);
    for (const { stripe_sub: sub } of subs) {
      stripe('POST', `/v1/subscriptions/${encodeURIComponent(sub)}`, { cancel_at_period_end: true }).then((x) => applySubscription(x)).catch((e) => console.warn('Couldn’t cancel a membership:', e.message));
    }
  }
  // A server is being deleted: end everyone's membership now (there's nothing left to pay for). The membership rows
  // go with the server, so each subscription is first written down in membership_cancellations and only crossed off
  // once Stripe confirms it ended: if Stripe can't be reached right now, nobody keeps being billed (it's retried).
  function onServerDeleted(sid) {
    const subs = db.prepare("SELECT stripe_sub, user_id FROM memberships WHERE server_id = ? AND status != 'ended'").all(sid);
    const add = db.prepare('INSERT OR IGNORE INTO membership_cancellations (stripe_sub, server_id, user_id, created_at) VALUES (?, ?, ?, ?)');
    db.transaction(() => subs.forEach((m) => add.run(m.stripe_sub, sid, m.user_id, now())))();
    if (subs.length) setImmediate(() => { retryCancellations().catch(() => {}); });
  }
  let retrying = false;
  async function retryCancellations() {
    if (retrying) return;
    retrying = true;
    try {
      const due = db.prepare('SELECT * FROM membership_cancellations ORDER BY tried_at IS NOT NULL, tried_at LIMIT 50').all();
      for (const p of due) {
        const sub = encodeURIComponent(p.stripe_sub);
        let done = false; let error = '';
        try { await stripe('DELETE', `/v1/subscriptions/${sub}`); done = true; } catch (e) {
          error = e.message;
          // Already gone (no such subscription, or it had ended anyway): nothing is being billed.
          if (e.code === 'stripe_not_found') done = true;
          else { try { done = STATUS[(await stripe('GET', `/v1/subscriptions/${sub}`)).status] === 'ended'; } catch (e2) { if (e2.code === 'stripe_not_found') done = true; } }
        }
        if (done) db.prepare('DELETE FROM membership_cancellations WHERE stripe_sub = ?').run(p.stripe_sub);
        else {
          db.prepare('UPDATE membership_cancellations SET attempts = attempts + 1, last_error = ?, tried_at = ? WHERE stripe_sub = ?').run(String(error).slice(0, 300), now(), p.stripe_sub);
          console.warn('Couldn’t end a membership of a deleted server (trying again later):', error);
        }
      }
    } finally { retrying = false; }
  }
  // A missed webhook can't leave someone with access they stopped paying for (or without access they paid
  // for): memberships past their end date are checked with Stripe.
  async function reconcile() {
    if (!usable()) return;
    const due = db.prepare("SELECT stripe_sub FROM memberships WHERE status IN ('active', 'past_due') AND period_end IS NOT NULL AND period_end < ? LIMIT 50").all(now() - 6 * 3600000);
    for (const { stripe_sub: sub } of due) {
      try { applySubscription(await stripe('GET', `/v1/subscriptions/${encodeURIComponent(sub)}`)); } catch { /* next time */ }
    }
  }
  setInterval(() => { reconcile().catch(() => {}); retryCancellations().catch(() => {}); }, 3600000).unref();
  setTimeout(() => { retryCancellations().catch(() => {}); }, 5000).unref();

  return { offers, syncRoles, onLeave, onServerDeleted, usable, POWERFUL, tierForRole, retryCancellations };
};
