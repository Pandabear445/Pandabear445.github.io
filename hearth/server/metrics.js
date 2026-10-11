// GET /metrics: instance-level numbers in Prometheus's text format (version 0.0.4), for an operator's monitoring.
//
//  - Off unless METRICS_TOKEN is set (16 characters or more). Then it needs "Authorization: Bearer <token>",
//    compared in constant time; wrong guesses are limited per network. Never a token in the address.
//  - Only numbers about the instance: the process, requests by status class, sockets, background jobs (by their
//    fixed names), backups, disk and two totals (accounts, messages). No label ever holds a person, a name, an id or
//    an address, so nothing here needs the care that Admin → Health's details do.
//
// countRequests() is installed first thing (server/index.js) so every HTTP answer is counted; health.js adds the route,
// since it already samples the event loop, the disk and the backups.
const crypto = require('crypto');
const log = require('./log');

const MIN_TOKEN = 16;
const requests = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
let unexpectedErrors = 0;

// Express middleware: counts each answer by its status class once it has gone out.
function countRequests() {
  log.onError(() => { unexpectedErrors++; });
  return (req, res, next) => {
    res.on('finish', () => { const k = `${Math.floor(res.statusCode / 100)}xx`; if (k in requests) requests[k]++; });
    next();
  };
}
const counts = () => ({ requests: { ...requests }, unexpectedErrors });

// ------------------------------------------------------------------ the text format
const escLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const fmtValue = (v) => (typeof v !== 'number' || Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : String(v));
// families: [{ name, help, type: 'gauge'|'counter', samples: [[labels|null, value], …] }]
function render(families) {
  const out = [];
  for (const f of families) {
    out.push(`# HELP ${f.name} ${f.help.replace(/\\/g, '\\\\').replace(/\n/g, ' ')}`, `# TYPE ${f.name} ${f.type}`);
    for (const [labels, value] of f.samples) {
      const l = labels && Object.keys(labels).length ? `{${Object.entries(labels).map(([k, v]) => `${k}="${escLabel(v)}"`).join(',')}}` : '';
      out.push(`${f.name}${l} ${fmtValue(value)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

// ------------------------------------------------------------------ the route
// collect(): the families to show, worked out per request. countHit/hitsSoFar/netOf: the server's rate-limit buckets.
const MAX_FAILS = 20; const FAIL_WINDOW = 10 * 60000;
function setupMetrics({ app, limitNet, countHit, hitsSoFar, netOf, collect }) {
  const token = String(process.env.METRICS_TOKEN || '').trim();
  const on = token.length >= MIN_TOKEN;
  if (token && !on) log.warn('metrics', 'token_too_short', { msg: `METRICS_TOKEN must be at least ${MIN_TOKEN} characters (try: openssl rand -hex 32). /metrics stays off.` });
  else if (on) log.info('metrics', 'on', { msg: '/metrics is on (Authorization: Bearer METRICS_TOKEN).' });
  // Hashing both sides first gives equal lengths, so timingSafeEqual never throws and the time says nothing.
  const want = crypto.createHash('sha256').update(token).digest();
  const right = (header) => {
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(header || ''));
    const got = crypto.createHash('sha256').update(m ? m[1] : '').digest();
    return !!m && crypto.timingSafeEqual(got, want);
  };
  app.get('/metrics', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Off: a plain 404, not the app's page (which a scraper would take for an answer).
    if (!on) return res.status(404).type('text').send('Not found.\n');
    limitNet(req, 'metrics', 600, 60000);
    // Wrong tokens: 20 per 10 minutes per network. Checked before comparing, so past that not even the right one
    // is tried (a limit that still answered 200 to a lucky guess wouldn't limit guessing).
    const failKey = `metricsfail:net:${netOf(req.ip)}`;
    if (hitsSoFar(failKey) >= MAX_FAILS) { res.setHeader('Retry-After', String(FAIL_WINDOW / 1000)); return res.status(429).type('text').send('Too many wrong tokens. Try again later.\n'); }
    if (!right(req.headers.authorization)) {
      countHit(failKey, FAIL_WINDOW);
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      return res.status(401).type('text').send('Unauthorized.\n');
    }
    // Set by hand: Express's send() would reorder the parameters of the type Prometheus documents.
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.end(render(collect()));
  });
  return { on };
}

module.exports = { countRequests, counts, render, setupMetrics, MIN_TOKEN, MAX_FAILS };
