// Paying for the server without ads or selling anything: supporters chip in through Ko-fi or Stripe and
// get their 💜 badge and perks automatically, for as long as they've paid for.
//
//  - Ko-fi: free, takes 0% of one-off donations. People paste their support code (shown in the app) into
//    the Ko-fi message; Ko-fi tells Hearth through a webhook.
//  - Stripe (cards, Apple Pay, Google Pay; ~2.9% + 30¢): a Payment Link. The app adds the person's code to the
//    link, so nothing needs pasting. Monthly subscriptions renew the badge every month by themselves.
// Payments are matched to people by that code; anything that can't be matched waits in Admin → Money so the
// owner can give it to the right person. Every payment is stored once, even if a webhook is delivered twice.
const crypto = require('crypto');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

module.exports = function setupMoney(ctx) {
  const { api, auth, db, fail, wrap, rateLimit, getSetting, setSetting, requireInstanceAdmin, getUserRow, broadcastUser, newId, express, emitTo, brief } = ctx;
  const now = () => Date.now();
  const DAY = 86400000;

  function cfg() {
    let v = {};
    try { v = JSON.parse(getSetting('payments') || '{}') || {}; } catch { /* defaults */ }
    return {
      kofiToken: typeof v.kofiToken === 'string' ? v.kofiToken : '',
      kofiUrl: typeof v.kofiUrl === 'string' ? v.kofiUrl : '',
      stripeSecret: typeof v.stripeSecret === 'string' ? v.stripeSecret : '',
      stripeLink: typeof v.stripeLink === 'string' ? v.stripeLink : '',
      monthlyCents: Math.max(100, Math.round(+v.monthlyCents || 300)),
      currency: typeof v.currency === 'string' && v.currency ? v.currency.slice(0, 3).toUpperCase() : 'USD',
      fileMb: Math.max(0, Math.round(+v.fileMb || 0)),
      autoRaised: v.autoRaised !== false,
    };
  }
  const saveCfg = (c) => setSetting('payments', JSON.stringify(c));

  // ------------------------------------------------------------------ support codes and granting
  function supportCode(uid) {
    const row = getUserRow(uid);
    if (row && row.support_code) return row.support_code;
    for (;;) {
      const code = 'H' + Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
      if (!db.prepare('SELECT 1 FROM users WHERE support_code = ?').get(code)) {
        db.prepare('UPDATE users SET support_code = ? WHERE id = ?').run(code, uid);
        return code;
      }
    }
  }
  // Finds the person a payment is for: their code anywhere in the text, or "@username".
  function whoFrom(text) {
    const s = String(text || '');
    for (const m of s.toUpperCase().matchAll(/\bH[A-Z2-9]{6}\b/g)) {
      const r = db.prepare('SELECT id FROM users WHERE support_code = ?').get(m[0]);
      if (r) return r.id;
    }
    const at = s.match(/@([A-Za-z0-9_.-]{2,32})/);
    if (at) { const r = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(at[1]); if (r) return r.id; }
    return null;
  }
  const daysFor = (cents, c = cfg()) => Math.max(1, Math.min(400, Math.round((cents / c.monthlyCents) * 31)));
  function grant(uid, days) {
    const row = getUserRow(uid);
    if (!row) return;
    if (row.supporter && row.supporter_until == null) { emitTo(uid, 'support:thanks', { forever: true }); return; } // already a supporter for good
    const from = Math.max(now(), row.supporter_until || 0);
    const until = from + days * DAY;
    db.prepare('UPDATE users SET supporter = 1, supporter_until = ? WHERE id = ?').run(until, uid);
    broadcastUser(uid);
    emitTo(uid, 'support:thanks', { until });
  }
  // Store a payment once. Returns its id, or null when it was already recorded.
  function record(provider, ref, uid, cents, currency, kind, note = '') {
    const id = newId();
    const r = db.prepare('INSERT OR IGNORE INTO payments (id, provider, ref, user_id, amount_cents, currency, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, provider, String(ref).slice(0, 200), uid, Math.max(0, Math.round(cents)), String(currency || '').toUpperCase().slice(0, 3), String(kind).slice(0, 40), String(note).slice(0, 300), now());
    return r.changes ? id : null;
  }
  // Supporter time that ran out: back to a normal account (the badge goes, files stay).
  function expire() {
    const due = db.prepare('SELECT id FROM users WHERE supporter = 1 AND supporter_until IS NOT NULL AND supporter_until < ?').all(now());
    for (const r of due) { db.prepare('UPDATE users SET supporter = 0 WHERE id = ?').run(r.id); broadcastUser(r.id); }
  }
  setInterval(expire, 3600000).unref();
  setTimeout(expire, 20000).unref();

  const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  // ------------------------------------------------------------------ Ko-fi webhook
  // Ko-fi → Settings → API → Webhook URL: https://your-server/api/pay/kofi
  api.post('/pay/kofi', express.urlencoded({ extended: false, limit: '100kb' }), (req, res) => {
    rateLimit('kofi:' + req.ip, 120, 60000);
    const c = cfg();
    let d;
    try { d = JSON.parse((req.body && req.body.data) || '{}'); } catch { return res.status(400).end(); }
    if (!c.kofiToken || !safeEq(d.verification_token || '', c.kofiToken)) return res.status(403).end();
    const cents = Math.round(parseFloat(d.amount || '0') * 100) || 0;
    const uid = whoFrom(`${d.message || ''} ${d.from_name || ''}`);
    const kind = d.is_subscription_payment ? `Ko-fi monthly${d.tier_name ? ` (${d.tier_name})` : ''}` : `Ko-fi ${String(d.type || 'donation').toLowerCase()}`;
    const id = record('kofi', d.kofi_transaction_id || d.message_id || newId(), uid, cents, d.currency || c.currency, kind, `${d.from_name || ''}${d.message ? `: ${d.message}` : ''}`);
    if (id && uid) grant(uid, d.is_subscription_payment ? Math.max(31, daysFor(cents, c)) : daysFor(cents, c));
    res.status(200).end();
  });

  // ------------------------------------------------------------------ Stripe webhook
  // Stripe → Developers → Webhooks → endpoint https://your-server/api/pay/stripe with the events
  // checkout.session.completed and invoice.paid. Paste its signing secret (whsec_…) in Admin → Money.
  function stripeVerified(req, secret) {
    const header = String(req.get('stripe-signature') || '');
    const parts = Object.fromEntries(header.split(',').map((x) => x.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
    const sigs = header.split(',').filter((x) => x.trim().startsWith('v1=')).map((x) => x.trim().slice(3));
    const t = +parts.t;
    if (!t || !sigs.length || !req.rawBody || Math.abs(now() / 1000 - t) > 300) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${req.rawBody.toString('utf8')}`).digest('hex');
    return sigs.some((s) => safeEq(s, expected));
  }
  api.post('/pay/stripe', (req, res) => {
    rateLimit('stripe:' + req.ip, 300, 60000);
    const c = cfg();
    if (!c.stripeSecret || !stripeVerified(req, c.stripeSecret)) return res.status(400).json({ error: 'Bad signature.' });
    const ev = req.body || {};
    const o = (ev.data && ev.data.object) || {};
    if (ev.type === 'checkout.session.completed') {
      const uid = whoFrom(o.client_reference_id) || null;
      if (uid && o.customer) {
        db.prepare('UPDATE users SET stripe_customer = ? WHERE id = ?').run(String(o.customer), uid);
        // A renewal invoice that arrived before this (Stripe doesn't promise the order): give it to them now.
        for (const p of db.prepare("SELECT * FROM payments WHERE provider = 'stripe' AND user_id IS NULL AND note = ?").all(`customer:${o.customer}`)) {
          db.prepare('UPDATE payments SET user_id = ? WHERE id = ?').run(uid, p.id);
          grant(uid, Math.max(31, daysFor(p.amount_cents, c)));
        }
      }
      // Subscriptions are paid through invoices (handled below), so only one-off payments count here.
      if (o.mode === 'payment') {
        const id = record('stripe', o.id || ev.id, uid, o.amount_total || 0, o.currency, 'Card payment', o.customer ? `customer:${o.customer}` : '');
        if (id && uid) grant(uid, daysFor(o.amount_total || 0, c));
      }
    } else if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_succeeded') {
      const cust = o.customer ? String(o.customer) : '';
      const row = cust ? db.prepare('SELECT id FROM users WHERE stripe_customer = ?').get(cust) : null;
      const uid = row ? row.id : null;
      const id = record('stripe', o.id || ev.id, uid, o.amount_paid || 0, o.currency, 'Card, monthly', cust ? `customer:${cust}` : '');
      if (id && uid) grant(uid, Math.max(31, daysFor(o.amount_paid || 0, c)));
    }
    res.json({ received: true });
  });

  // ------------------------------------------------------------------ for supporters-to-be
  api.get('/me/support', auth, (req, res) => {
    const c = cfg();
    const row = getUserRow(req.userId);
    const code = supportCode(req.userId);
    let stripeUrl = '';
    if (c.stripeLink) { try { const u = new URL(c.stripeLink); u.searchParams.set('client_reference_id', code); stripeUrl = u.href; } catch { /* bad link */ } }
    res.json({
      code, kofiUrl: c.kofiUrl && c.kofiToken ? c.kofiUrl : '', stripeUrl, monthlyCents: c.monthlyCents, currency: c.currency,
      supporter: !!row.supporter, until: row.supporter ? row.supporter_until : null,
      perks: { storageMb: +(getSetting('supporterQuotaMb') || 0), fileMb: c.fileMb },
      mine: db.prepare('SELECT amount_cents, currency, kind, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(req.userId),
    });
  });

  // ------------------------------------------------------------------ admin
  const monthStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const monthTotalCents = () => db.prepare('SELECT COALESCE(SUM(amount_cents), 0) n FROM payments WHERE created_at >= ?').get(monthStart()).n;
  api.get('/admin/money', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const c = cfg();
    const list = db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT 100').all()
      .map((p) => ({ id: p.id, provider: p.provider, user: p.user_id ? brief(p.user_id) : null, cents: p.amount_cents, currency: p.currency, kind: p.kind, note: p.note.startsWith('customer:') ? '' : p.note, at: p.created_at }));
    res.json({
      config: { kofiTokenSet: !!c.kofiToken, kofiUrl: c.kofiUrl, stripeSecretSet: !!c.stripeSecret, stripeLink: c.stripeLink, monthlyCents: c.monthlyCents, currency: c.currency, fileMb: c.fileMb, autoRaised: c.autoRaised },
      totals: { monthCents: monthTotalCents(), allCents: db.prepare('SELECT COALESCE(SUM(amount_cents), 0) n FROM payments').get().n, supporters: db.prepare('SELECT COUNT(*) n FROM users WHERE supporter = 1').get().n, unmatched: list.filter((p) => !p.user).length },
      payments: list,
    });
  });
  api.put('/admin/money', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const b = req.body || {};
    const c = cfg();
    const url = (v) => { const s = String(v || '').trim(); if (!s) return ''; try { const u = new URL(s); if (u.protocol !== 'https:') throw new Error(); return u.href; } catch { fail(400, 'Links must start with https://'); } return ''; };
    if (b.kofiToken !== undefined) c.kofiToken = String(b.kofiToken || '').trim().slice(0, 100);
    if (b.kofiUrl !== undefined) c.kofiUrl = url(b.kofiUrl);
    if (b.stripeSecret !== undefined) { const s = String(b.stripeSecret || '').trim(); if (s && !/^whsec_\w{10,}$/.test(s)) fail(400, 'The Stripe signing secret starts with whsec_'); c.stripeSecret = s; }
    if (b.stripeLink !== undefined) { c.stripeLink = url(b.stripeLink); if (c.stripeLink && !/^https:\/\/(buy|donate)\.stripe\.com\//.test(c.stripeLink)) fail(400, 'Use a Stripe Payment Link (https://buy.stripe.com/…).'); }
    if (b.monthlyCents !== undefined) c.monthlyCents = Math.max(100, Math.min(100000, Math.round(+b.monthlyCents || 300)));
    if (b.currency !== undefined) c.currency = String(b.currency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';
    if (b.fileMb !== undefined) c.fileMb = Math.max(0, Math.min(4096, Math.round(+b.fileMb || 0)));
    if (b.autoRaised !== undefined) c.autoRaised = !!b.autoRaised;
    saveCfg(c);
    ctx.onChange();
    res.json({ ok: true });
  });
  // Give a payment that couldn't be matched to the right person.
  api.post('/admin/money/payments/:id/assign', auth, (req, res) => {
    requireInstanceAdmin(req.userId);
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!p) fail(404, 'No such payment.');
    if (p.user_id) fail(400, 'That payment already belongs to someone.');
    const u = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(String((req.body || {}).username || '').replace(/^@/, '').trim());
    if (!u) fail(404, 'No one has that username.');
    db.prepare('UPDATE payments SET user_id = ? WHERE id = ?').run(u.id, p.id);
    const custom = String(p.note).match(/^customer:(.+)$/);
    if (custom) db.prepare('UPDATE users SET stripe_customer = ? WHERE id = ?').run(custom[1], u.id);
    grant(u.id, /monthly/i.test(p.kind) ? Math.max(31, daysFor(p.amount_cents)) : daysFor(p.amount_cents));
    res.json({ ok: true });
  });

  // For the funding card: what came in this month, in the funding card's currency units.
  const raisedThisMonth = () => (cfg().autoRaised ? monthTotalCents() / 100 : null);
  const supporterFileMb = () => cfg().fileMb;
  const available = () => { const c = cfg(); return !!(c.stripeLink || (c.kofiUrl && c.kofiToken)); };
  return { raisedThisMonth, supporterFileMb, grant, available };
};
