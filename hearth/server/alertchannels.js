// Alert channels: where owner alerts go besides the owner's email and the admin dashboard.
//   ntfy      a topic on ntfy.sh or a self-hosted ntfy (published as JSON; an access token is optional)
//   webhook   a JSON POST signed like the bots' webhooks: HMAC-SHA256 over "<timestamp>.<body>" (bots.js sign)
//   discord   a Discord-style incoming webhook ({ content }): Discord, or anything that speaks it
//   slack     a Slack-style incoming webhook ({ text }): Slack, Mattermost, Rocket.Chat and the like
//
// The rules:
//  - Every request goes through netguard: https on the public internet, the address checked and pinned, no
//    redirects, a deadline and a cap on the answer. A host on your own network (a self-hosted ntfy on the LAN) is
//    reachable only when ALERT_PRIVATE_HOSTS names it, and only those hosts may use plain http.
//  - What locates a channel is a secret: an ntfy topic is the password for reading it, and Discord and Slack
//    addresses carry their token. Addresses, topics and tokens are sealed at rest with the server's key
//    (sealSecret) and only a masked form ever leaves the server. A webhook's signing secret is shown once.
//  - The text is the email's: what happened, counts and short scrubbed error descriptions. Nothing about people.
//  - Each delivery's outcome is kept (when, the answer, the error) for Admin → Health. Once a switched-on channel has
//    failed 3 real alerts in a row (Test presses aren't counted), one alert names every channel that's failing and
//    reaches the owner through the email and the other channels. It's one key for all of them, outside the hourly
//    cap and at most once an hour (alerts.js), so broken channels can't crowd out real alerts: adding channels needs
//    no password, and hiding alerts must.
const crypto = require('crypto');
const net = require('net');
const netguard = require('./netguard');
const log = require('./log');
const { sign } = require('./bots');

const KINDS = { ntfy: 'ntfy', webhook: 'Webhook', discord: 'Discord', slack: 'Slack' };
const MAX_CHANNELS = 10;
const FAILING_AFTER = 3;
const FAILING_KEY = 'alert_channels';
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/; // ntfy's own rule for topic names
const TOKEN = /^[\x21-\x7e]{1,256}$/; // printable, no spaces (ntfy tokens look like tk_…)
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
const timeout = () => num(process.env.ALERT_CHANNEL_TIMEOUT_MS, 8000);

// ALERT_PRIVATE_HOSTS: hosts on your own network that alert channels may use, like PUSH_PRIVATE_HOSTS. Exact names or
// addresses, on the scheme's default port unless the entry says "name:port". Read when used, so a restart isn't the
// only way tests can change it.
function privateHosts() {
  const out = [];
  for (const raw of String(process.env.ALERT_PRIVATE_HOSTS || '').split(',')) {
    const x = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!x || x.includes('*') || x.includes('/')) continue;
    if (net.isIP(x)) { out.push({ host: x, port: 0 }); continue; }
    const m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(x) || /^([^:]+)(?::(\d{1,5}))?$/.exec(x);
    if (m) out.push({ host: m[1], port: Number(m[2]) || 0 });
  }
  return out;
}
const defaultPort = (u) => (u.protocol === 'https:' ? 443 : 80);
const bareHost = (u) => u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
// An entry without a port covers the address written without one (http on 80, https on 443).
const listed = (u) => privateHosts().some((e) => e.host === bareHost(u) && (e.port ? e.port === (Number(u.port) || defaultPort(u)) : !u.port));
// Plain http would hand the token (or the topic) to anyone on the path, so it's for listed hosts only.
const httpsOrListed = (u) => u.protocol === 'https:' || listed(u);

// "••••" plus the last four characters, when there are enough left over that they give nothing away.
const mask = (s) => { s = String(s || ''); return s.length >= 12 ? `••••${s.slice(-4)}` : '••••'; };
// The scheme, host and port, with a long first label of a host name masked: that label can be the secret itself
// (https://eo8a3f9c2d1b7e64.m.pipedream.net/ takes posts from anyone who knows it). The rest still says whose it is.
function maskedOrigin(u) {
  const labels = u.hostname.split('.');
  const host = !net.isIP(bareHost(u)) && labels.length >= 3 && labels[0].length >= 12 ? [mask(labels[0]), ...labels.slice(1)].join('.') : u.hostname;
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
}
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// Slack reads <…> as links and mentions (<!channel>), so its three markup characters are escaped as it asks.
const slackText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = function setupAlertChannels(ctx) {
  const { getSetting, setSetting, sealSecret, openSecret, fail, alerts = null, brandName = () => 'Hearth', emitAdmins = () => {} } = ctx;
  const now = () => Date.now();

  // ------------------------------------------------------------------ storage (the alertChannels setting)
  const load = () => { try { const v = JSON.parse(getSetting('alertChannels') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const save = (list) => setSetting('alertChannels', JSON.stringify(list));
  const targetOf = (ch) => { try { return JSON.parse(openSecret(ch.target) || 'null'); } catch { return null; } };
  const find = (id) => load().find((c) => c.id === String(id || '')) || null;

  // What the dashboard may see: never the address, topic, token or signing secret, only where they point, masked.
  // An ntfy server's path is masked too (a reverse proxy's secret prefix, or a topic left in it).
  function where(ch) {
    const t = targetOf(ch);
    if (!t || !t.url) return 'Can’t be read: was the server key (data/secret.key) replaced?';
    let u;
    try { u = new URL(t.url); } catch { return 'Can’t be read.'; }
    if (ch.kind === 'ntfy') return `${maskedOrigin(u)}${u.pathname === '/' ? '' : `/${mask(u.pathname.slice(1))}`} · topic ${mask(t.topic)}${t.token ? ` · token ${mask(t.token)}` : ''}`;
    return `${maskedOrigin(u)}/${mask(t.url.slice(u.origin.length + 1))}`;
  }
  const view = (ch) => ({
    id: ch.id, kind: ch.kind, kindLabel: KINDS[ch.kind], name: ch.name, enabled: !!ch.enabled, where: where(ch), signed: ch.kind === 'webhook',
    createdAt: ch.createdAt, updatedAt: ch.updatedAt || null, last: ch.last || null, lastOkAt: ch.lastOkAt || null, failures: ch.failures || 0,
  });
  const list = () => load().map(view);

  // ------------------------------------------------------------------ checking what an admin typed
  async function checkUrl(input, what) {
    const s = String(input || '').trim();
    if (!s) fail(400, `Paste the ${what}.`, 'bad_url');
    if (s.length > 2000) fail(400, `That ${what} is too long.`, 'bad_url');
    let u;
    try { u = await netguard.checkPublicUrl(s, { protocols: ['https:', 'http:'], allowPrivate: listed }); } catch (e) {
      if (!(e instanceof netguard.GuardError)) throw e;
      if (e.code === 'PRIVATE') fail(400, `${e.message} Alert channels have to be on the public internet, unless ALERT_PRIVATE_HOSTS names the host.`, 'private_address');
      fail(400, e.message, 'bad_url');
    }
    if (!httpsOrListed(u)) fail(400, 'Use an https:// address. Plain http is only for a host on your own network that ALERT_PRIVATE_HOSTS names.', 'https_only');
    u.hash = '';
    return u;
  }
  // The sealed parts of a channel from the request (`old` holds the current ones, for a change of only some).
  async function targetFrom(kind, b, old = {}) {
    if (kind === 'ntfy') {
      const pasted = b.url !== undefined;
      const server = await checkUrl(pasted ? b.url : old.url, 'ntfy server address');
      if (server.search) fail(400, 'The ntfy server address is just the server (like https://ntfy.sh), without ? or anything after it.', 'bad_url');
      // A different server never gets the old topic or token: whoever runs it would learn them. (Another admin, who
      // only ever sees them masked, could point the owner's channel at their own server and press Test.)
      let moved = false;
      if (pasted && old.url) { try { moved = new URL(old.url).origin !== server.origin; } catch { moved = true; } }
      const kept = (k) => (moved ? '' : old[k] || '');
      if (moved && b.topic === undefined) fail(400, 'A different ntfy server needs the topic typed again (and the access token, if it needs one): the old ones only go to the old server.', 'bad_topic');
      const topic = String(b.topic !== undefined ? b.topic : kept('topic')).trim();
      if (!TOPIC.test(topic)) fail(400, 'A topic is 1–64 letters, numbers, - and _. Pick one nobody can guess: on a public ntfy, whoever knows it can read it.', 'bad_topic');
      // The topic's own address pasted as the server (https://ntfy.sh/my-topic): the server is what's before it. Only
      // without a trailing slash, which is how to say a path is the server's own (https://example.com/alerts/ with the
      // topic "alerts"), and only for an address typed now (a saved one always ends in /).
      if (pasted && !/\/$/.test(String(b.url).trim().replace(/[?#].*$/, '')) && server.pathname.endsWith(`/${topic}`)) server.pathname = server.pathname.slice(0, -topic.length);
      if (!server.pathname.endsWith('/')) server.pathname += '/';
      const token = String(b.token !== undefined ? b.token : kept('token')).trim();
      if (token && !TOKEN.test(token)) fail(400, 'That access token doesn’t look right (no spaces; ntfy’s start with tk_).', 'bad_token');
      return { url: server.href, topic, token };
    }
    const u = await checkUrl(b.url !== undefined ? b.url : old.url, 'webhook address');
    return { url: u.href };
  }
  const nameFrom = (b, kind) => clean(b.name, 40) || KINDS[kind];

  async function add(b, by) {
    const kind = String(b.kind || '');
    if (!KINDS[kind]) fail(400, 'Pick ntfy, Webhook, Discord or Slack.', 'bad_kind');
    if (load().length >= MAX_CHANNELS) fail(400, `Up to ${MAX_CHANNELS} alert channels. Remove one first.`, 'too_many');
    const target = await targetFrom(kind, b);
    const secret = kind === 'webhook' ? crypto.randomBytes(32).toString('base64url') : null;
    const ch = { id: crypto.randomBytes(8).toString('hex'), kind, name: nameFrom(b, kind), enabled: true, createdAt: now(), createdBy: by || null,
      target: sealSecret(JSON.stringify(target)), secret: secret ? sealSecret(secret) : '', last: null, lastOkAt: null, failures: 0 };
    const all = load(); // read again: the address check above waited on DNS
    if (all.length >= MAX_CHANNELS) fail(400, `Up to ${MAX_CHANNELS} alert channels. Remove one first.`, 'too_many');
    all.push(ch);
    save(all);
    changed();
    return { channel: view(ch), secret };
  }
  // A new address, topic or token in b, checked as update would (400 when it's wrong) without saving anything: the
  // route does this before asking for the password and a fresh two-factor code, so a typo doesn't use a code up.
  async function check(id, b) {
    const cur = find(id);
    if (!cur) fail(404, 'That alert channel is gone.', 'not_found');
    if (['url', 'topic', 'token'].some((k) => b[k] !== undefined)) await targetFrom(cur.kind, b, targetOf(cur) || {});
  }
  // b: { name, enabled, url, topic, token } (any of them). Whether this needs the password is the route's call.
  async function update(id, b) {
    const cur = find(id);
    if (!cur) fail(404, 'That alert channel is gone.', 'not_found');
    const retarget = ['url', 'topic', 'token'].some((k) => b[k] !== undefined);
    const target = retarget ? await targetFrom(cur.kind, b, targetOf(cur) || {}) : null;
    const all = load();
    const ch = all.find((c) => c.id === cur.id);
    if (!ch) fail(404, 'That alert channel is gone.', 'not_found');
    if (b.name !== undefined) ch.name = nameFrom(b, ch.kind);
    if (b.enabled !== undefined) ch.enabled = !!b.enabled;
    if (target) { ch.target = sealSecret(JSON.stringify(target)); ch.last = null; ch.lastOkAt = null; ch.failures = 0; }
    ch.updatedAt = now();
    save(all);
    checkFailing(null);
    changed();
    return view(ch);
  }
  function remove(id) {
    const all = load();
    const i = all.findIndex((c) => c.id === String(id || ''));
    if (i < 0) fail(404, 'That alert channel is gone.', 'not_found');
    const [gone] = all.splice(i, 1);
    save(all);
    checkFailing(null);
    changed();
    return view(gone);
  }
  function changed() { try { emitAdmins('admin:alert-channels', {}); } catch { /* nobody watching */ } }

  // ------------------------------------------------------------------ sending
  // The request for one alert. `alert`: { key, severity, title, detail, held, at }; test marks the Test button's.
  function build(ch, t, alert, test) {
    const brand = clean(brandName(), 40) || 'Hearth';
    const held = alert.held ? `\n\n(${alert.held} more like this were held back since the last one.)` : '';
    const text = `${alert.detail}${held}\n\nOpen Admin → Health for details.`;
    const label = test ? 'Test' : alert.severity === 'critical' ? 'Needs attention now' : 'Needs a look';
    if (ch.kind === 'ntfy') {
      return { url: t.url, headers: t.token ? { Authorization: `Bearer ${t.token}` } : {},
        body: JSON.stringify({ topic: t.topic, title: `${brand}: ${alert.title}`, message: text, priority: test ? 3 : alert.severity === 'critical' ? 5 : 4,
          tags: [test ? 'white_check_mark' : alert.severity === 'critical' ? 'rotating_light' : 'warning'] }) };
    }
    if (ch.kind === 'discord') {
      // allowed_mentions: a name that happens to read @everyone (a region's, say) pings nobody.
      return { url: t.url, headers: {}, body: JSON.stringify({ content: `**${brand} · ${label}: ${alert.title}**\n${text}`.slice(0, 2000), allowed_mentions: { parse: [] } }) };
    }
    if (ch.kind === 'slack') return { url: t.url, headers: {}, body: JSON.stringify({ text: slackText(`*${brand} · ${label}: ${alert.title}*\n${text}`) }) };
    // The generic webhook: the alert as data, signed with the channel's secret like a bot's webhook.
    const id = crypto.randomBytes(12).toString('hex');
    const type = test ? 'alert.test' : 'alert';
    const body = JSON.stringify({ v: 1, id, type, createdAt: now(), server: brand,
      alert: { key: alert.key, severity: alert.severity, title: alert.title, detail: alert.detail, held: alert.held || 0, at: alert.at } });
    const ts = Math.floor(now() / 1000);
    return { url: t.url, body, headers: { 'X-Hearth-Event': type, 'X-Hearth-Delivery': id, 'X-Hearth-Timestamp': String(ts), 'X-Hearth-Signature': `v1=${sign(openSecret(ch.secret), ts, body)}` } };
  }
  // One delivery. Resolves { ok, status, error }; never throws.
  async function send(ch, alert, test = false) {
    const t = targetOf(ch);
    if (!t || !t.url || (ch.kind === 'webhook' && !openSecret(ch.secret))) return { ok: false, status: null, error: 'This channel can’t be read: was the server key (data/secret.key) replaced? Remove it and add it again.' };
    const req = build(ch, t, alert, test);
    try {
      const r = await netguard.request(req.url, {
        method: 'POST', protocols: ['https:', 'http:'], allowUrl: httpsOrListed, allowPrivate: listed, maxRedirects: 0, timeout: timeout(), maxBytes: 16 * 1024,
        truncate: true, decompress: false, body: req.body,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'HearthAlerts/1 (+self-hosted chat)', ...req.headers },
      });
      if (r.ok) return { ok: true, status: r.status };
      const why = r.status === 401 || r.status === 403 ? ' Check the access token or the address.' : r.status === 404 ? ' Is the address right?' : r.status === 429 ? ' It’s limiting how often it takes messages.' : '';
      return { ok: false, status: r.status, error: `It answered ${r.status}.${why}` };
    } catch (e) {
      return { ok: false, status: null, error: e instanceof netguard.GuardError ? e.message : 'Couldn’t reach it.' };
    }
  }
  // Kept on the channel (read again from storage: it may have changed, or gone, while the request ran). An outcome
  // for an address that was changed meanwhile says nothing about the new one, so it's dropped.
  function record(sent, res, test) {
    const all = load();
    const ch = all.find((c) => c.id === sent.id);
    if (!ch || ch.target !== sent.target) return null;
    const at = now();
    ch.last = { at, ok: !!res.ok, status: res.status || null, error: res.ok ? null : log.scrub(String(res.error || '')).slice(0, 200), test: !!test };
    // A Test that gets through shows the channel works again. One that fails is shown, but only real alerts count
    // toward "failing": pressing Test can't make a channel look broken, or bring on the alert about it.
    if (res.ok) { ch.lastOkAt = at; ch.failures = 0; } else if (!test) ch.failures = (ch.failures || 0) + 1;
    save(all);
    return ch;
  }
  async function deliver(ch, alert, test) {
    const res = await send(ch, alert, test);
    try { record(ch, res, test); } catch (e) { log.warn('alerts', 'channel_record_failed', { err: e }); }
    if (!res.ok) log.warn('alerts', 'channel_failed', { kind: ch.kind, channel: ch.id, status: res.status, msg: res.error, outcome: 'error' });
    return res;
  }
  // One alert for every switched-on channel that's failing, raised under one key outside the hourly cap (see the top).
  // `alert` is what was just delivered, or null after a Test or a change: then it can only be cleared.
  function checkFailing(alert) {
    if (!alerts) return;
    const bad = load().filter((c) => c.enabled && (c.failures || 0) >= FAILING_AFTER);
    if (!bad.length) { alerts.clear(FAILING_KEY); return; }
    if (!alert || alert.key === FAILING_KEY) return; // not about itself: that would go round in circles
    const first = bad[0];
    const lastError = (c) => (c.last && c.last.error) || 'unknown.';
    const names = bad.slice(0, 5).map((c) => `"${c.name}" (${KINDS[c.kind]})`).join(', ') + (bad.length > 5 ? ` and ${bad.length - 5} more` : '');
    alerts.raise(FAILING_KEY, bad.length === 1
      ? { severity: 'warning', title: `Alerts can’t reach the ${KINDS[first.kind]} channel "${first.name}"`,
        detail: `${first.failures} deliveries in a row have failed. Last error: ${lastError(first)} Check it in Admin → Health → Where alerts go.` }
      : { severity: 'warning', title: `Alerts can’t reach ${bad.length} alert channels`,
        detail: `Failing: ${names}. Last error at "${first.name}": ${lastError(first)} Check them in Admin → Health → Where alerts go.` }, { outsideCap: true });
  }
  // Every switched-on channel, all at once (alerts.raise calls this; nothing waits for it there, so it never rejects).
  async function deliverAll(alert) {
    try {
      const out = await Promise.all(load().filter((c) => c.enabled).map((c) => deliver(c, alert, false).catch(() => null)));
      checkFailing(alert);
      return out;
    } catch (e) { log.warn('alerts', 'channels_failed', { err: e }); return []; }
  }
  async function test(id) {
    const ch = find(id);
    if (!ch) fail(404, 'That alert channel is gone.', 'not_found');
    const res = await deliver(ch, { key: 'test', severity: 'warning', title: 'Test alert', detail: 'This is a test from Admin → Health. If you got it, alerts reach you here.', held: 0, at: now() }, true);
    try { checkFailing(null); } catch (e) { log.warn('alerts', 'channels_failed', { err: e }); }
    changed();
    return res;
  }

  return { list, get: (id) => { const c = find(id); return c ? view(c) : null; }, add, check, update, remove, test, deliverAll, KINDS };
};
module.exports.KINDS = KINDS;
module.exports.MAX_CHANNELS = MAX_CHANNELS;
module.exports.FAILING_AFTER = FAILING_AFTER;
module.exports.FAILING_KEY = FAILING_KEY;
module.exports.privateHosts = privateHosts;
module.exports.mask = mask;
