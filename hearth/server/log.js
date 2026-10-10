// Structured logging. One line per event: JSON by default (for Docker, journald and log shippers), or a readable
// line with LOG_FORMAT=pretty. Every line has ts, level, component and op; lines written while handling a request
// carry its reqId, and lines written by a background job carry the job's name.
//
// Redaction happens here, centrally, so a careless call can't leak a secret: fields named like tokens, passwords,
// keys, cookies, message bodies or ciphertext are replaced, sign-in tokens and Bearer headers are scrubbed out of
// free text, and URLs lose their query strings. IP addresses are cut to their network (/24 or /48) unless the
// operator sets LOG_FULL_IP=true.
//
// No dependencies on the rest of the server (db.js uses it before anything else exists).
const crypto = require('crypto');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const config = {
  level: LEVELS[String(env('LOG_LEVEL', 'info')).toLowerCase()] || LEVELS.info,
  // JSON unless asked otherwise, or when a person is watching a terminal.
  pretty: String(env('LOG_FORMAT', process.stdout.isTTY ? 'pretty' : 'json')).toLowerCase() === 'pretty',
  fullIp: String(env('LOG_FULL_IP', 'false')).toLowerCase() === 'true',
  access: String(env('LOG_ACCESS', 'on')).toLowerCase(), // on | errors | off
  sample: Math.max(0, Math.min(1, Number(env('LOG_ACCESS_SAMPLE', '0.2')))),
  slowMs: Math.max(1, Number(env('LOG_SLOW_MS', '1000')) || 1000),
};

// ------------------------------------------------------------------ redaction
// Field names whose values are never written: any name containing one of the words, or exactly one of the short
// ones. (Case-insensitive. Over-redacting a harmless field is fine; under-redacting isn't.)
const SECRET_KEY = /token|passw|secret|authoriz|cookie|cipher|authkey|auth_key|recovery|backupcode|totp|private|wrapped|apikey|api_key|signature|^(pass|key|sig|body|text|content|evidence|details|enc_.*|wrap.*)$/i;
const IP_KEY = /^(ip|ips|remote|remoteaddress|clientip|peer)$/i;
const HEX_TOKEN = /\b[0-9a-f]{40,}\b/gi; // session tokens (64 hex), reset links, backup keys, hashes
const BEARER = /\b(bearer|basic)\s+[^\s"',;]+/gi;
const URL_QUERY = /(\bhttps?:\/\/[^\s"'?#]*|(?:^|[\s"'(])\/[\w./:-]*)\?[^\s"')]*/gi;
const KEY_VALUE = /\b(token|access_token|key|k|secret|password|pass|auth|authkey|code|sig|signature)=([^\s&"']+)/gi;
const LONG_B64 = /\b[A-Za-z0-9+/_-]{80,}={0,2}/g; // ciphertext, wrapped keys, recovery material

// Free text (messages, error messages, URLs): scrub anything that looks like a credential.
function scrub(s) {
  if (s == null) return s;
  return String(s)
    .replace(BEARER, (m, kind) => `${kind} [redacted]`)
    .replace(KEY_VALUE, (m, k) => `${k}=[redacted]`)
    .replace(URL_QUERY, (m) => m.replace(/\?.*$/, '?[redacted]'))
    .replace(HEX_TOKEN, '[redacted]')
    .replace(LONG_B64, '[redacted]');
}

// The network part of an address: a.b.c.0/24 for IPv4, the first 48 bits for IPv6.
function truncIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (!s || config.fullIp) return s;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(s);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (s.includes(':')) {
    const [head] = s.split('::');
    const parts = head.split(':').filter(Boolean);
    return `${parts.slice(0, 3).concat(Array(Math.max(0, 3 - parts.length)).fill('0')).join(':')}::/48`;
  }
  return '[ip]';
}

function redact(value, key = '', depth = 0) {
  if (key && SECRET_KEY.test(key) && value != null && value !== '') return '[redacted]';
  if (key && IP_KEY.test(key)) return Array.isArray(value) ? value.map(truncIp) : truncIp(value);
  if (typeof value === 'string') return scrub(value).slice(0, 2000);
  if (value == null || typeof value !== 'object') return value;
  if (depth > 4) return '[…]';
  if (value instanceof Error) return errorInfo(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, '', depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, depth + 1);
  return out;
}

// A short, safe word for what kind of failure this was, for dashboards and alerts (never the raw error).
function errorCategory(e) {
  if (!e) return 'unknown';
  const code = String(e.code || '');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'db_busy';
  if (code === 'SQLITE_FULL' || code === 'ENOSPC') return 'disk_full';
  if (code.startsWith('SQLITE_')) return 'db';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission';
  if (code === 'ENOENT') return 'missing_file';
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return 'network';
  if (e.name === 'AbortError' || code === 'TIMEOUT' || /timed? ?out/i.test(e.message || '')) return 'timeout';
  if (e.name === 'GuardError') return 'blocked_fetch';
  if (e.status && e.status < 500) return 'client';
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) return 'bug';
  return 'error';
}
function errorInfo(e) {
  if (!(e instanceof Error)) return { category: 'error', message: scrub(String(e)).slice(0, 500) };
  return { category: errorCategory(e), name: e.name, code: e.code || undefined, message: scrub(e.message).slice(0, 500), stack: e.stack ? scrub(e.stack).split('\n').slice(0, 12).join('\n') : undefined };
}

// ------------------------------------------------------------------ context: request ids and job names
const als = new AsyncLocalStorage();
const context = () => als.getStore() || {};
const withContext = (ctx, fn) => als.run({ ...context(), ...ctx }, fn);

// A stable, non-reversible id for a user in logs (so lines about one person can be grouped without naming them).
// Keyed with a secret from the server (setUserHashKey), so it can't be checked against a list of user ids.
let uidKey = crypto.randomBytes(32);
const setUserHashKey = (k) => { uidKey = crypto.createHmac('sha256', k).update('hearth-log-user').digest(); };
const userHash = (uid) => (uid ? crypto.createHmac('sha256', uidKey).update(String(uid)).digest('hex').slice(0, 12) : undefined);

// ------------------------------------------------------------------ writing
const listeners = new Set(); // other parts of the server that want to know about errors (alerts)
function write(level, component, op, fields = {}) {
  if (LEVELS[level] < config.level) return;
  const ctx = context();
  const { msg, err, ...rest } = fields;
  const line = { ts: new Date().toISOString(), level, component, op };
  if (ctx.reqId) line.reqId = ctx.reqId;
  if (ctx.job && !rest.job) line.job = ctx.job;
  if (msg !== undefined) line.msg = scrub(msg).slice(0, 2000);
  Object.assign(line, redact(rest));
  if (err) line.error = errorInfo(err);
  if (line.error && !line.errorCategory) line.errorCategory = line.error.category;
  let text;
  if (config.pretty) {
    const extras = Object.entries(line).filter(([k]) => !['ts', 'level', 'component', 'op', 'msg', 'error'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
    text = `${line.ts} ${level.toUpperCase().padEnd(5)} ${component} ${op}${line.msg ? `: ${line.msg}` : ''}${extras ? `  ${extras}` : ''}`;
    if (line.error) text += `\n    ${line.error.stack ? line.error.stack.split('\n').join('\n    ') : `${line.error.name || 'Error'}: ${line.error.message}`}`;
  } else {
    text = JSON.stringify(line);
  }
  text += '\n';
  // Fatal lines are written synchronously: the process is about to exit and must not lose them.
  if (level === 'fatal') { try { fs.writeSync(2, text); } catch { /* nowhere to write */ } } else if (LEVELS[level] >= LEVELS.warn) process.stderr.write(text);
  else process.stdout.write(text);
  if (LEVELS[level] >= LEVELS.error) for (const fn of listeners) { try { fn(line); } catch { /* a listener must never break logging */ } }
}
const log = {
  debug: (component, op, fields) => write('debug', component, op, fields),
  info: (component, op, fields) => write('info', component, op, fields),
  warn: (component, op, fields) => write('warn', component, op, fields),
  // error(component, op, err, fields): err is an Error (or anything thrown).
  error: (component, op, err, fields = {}) => write('error', component, op, { ...fields, err }),
  fatal: (component, op, err, fields = {}) => write('fatal', component, op, { ...fields, err }),
  // A logger with its component filled in: const L = log.child('backup'); L.info('made', { msg }).
  child: (component) => ({
    debug: (op, f) => log.debug(component, op, f), info: (op, f) => log.info(component, op, f), warn: (op, f) => log.warn(component, op, f),
    error: (op, err, f) => log.error(component, op, err, f), fatal: (op, err, f) => log.fatal(component, op, err, f),
  }),
  onError: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
};

// ------------------------------------------------------------------ HTTP: request ids and the access log
const REQ_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const newReqId = () => crypto.randomBytes(9).toString('base64url');
// A route template for the access log, never the real URL (which can carry tokens, ids and search words).
function routeOf(req) {
  if (req.route && req.route.path) {
    const p = req.route.path instanceof RegExp ? '(app page)' : String(req.route.path);
    const base = req.baseUrl || (req.originalUrl.startsWith('/api/') && !p.startsWith('/api') ? '/api' : '');
    return base + p;
  }
  const p = String(req.originalUrl || req.url || '').split('?')[0];
  if (p.startsWith('/api/')) return '/api/(no route)';
  if (p.startsWith('/socket.io')) return '/socket.io';
  const first = p.split('/')[1] || '';
  return /^[\w.-]{1,40}$/.test(first) && !/\.\w+$/.test(first) ? `/${first}/*` : '/(static)';
}
// Express middleware: request id in, request id out, one access-log line when the response is done.
function requestLogger() {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const reqId = typeof incoming === 'string' && REQ_ID.test(incoming) ? incoming : newReqId();
    req.id = reqId;
    res.setHeader('X-Request-Id', reqId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (config.access === 'off') return;
      const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
      const status = res.statusCode;
      const slow = durationMs >= config.slowMs;
      const okRead = status < 400 && (req.method === 'GET' || req.method === 'HEAD');
      if (!slow && config.access === 'errors' && status < 400) return;
      if (!slow && okRead && Math.random() >= config.sample) return;
      const level = slow || status >= 500 ? 'warn' : 'info';
      const fields = { method: req.method, route: routeOf(req), status, durationMs, outcome: status >= 500 ? 'error' : status >= 400 ? 'denied' : slow ? 'slow' : 'ok', uid: userHash(req.userId), ip: req.ip };
      withContext({ reqId }, () => write(level, 'http', slow ? 'slow_request' : 'request', fields));
    });
    als.run({ reqId }, next);
  };
}

// ------------------------------------------------------------------ the process itself
// A promise nobody handled is logged (and the server carries on). An exception nobody caught is logged with what
// we know, then the process exits with status 1: its state can't be trusted any more, and systemd or Docker start
// a fresh one (deploy/hearth.service and docker-compose.yml both restart on failure).
let installed = false;
function installProcessHandlers({ beforeExit } = {}) {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    log.error('process', 'unhandled_rejection', reason instanceof Error ? reason : new Error(scrub(String(reason))), { outcome: 'error' });
  });
  process.on('uncaughtException', (err, origin) => {
    try { log.fatal('process', 'uncaught_exception', err, { origin, outcome: 'crash', msg: `${err && err.message ? err.message : err}`, uptimeS: Math.round(process.uptime()) }); } catch { /* still exit */ }
    try { if (beforeExit) beforeExit(); } catch { /* still exit */ }
    process.exit(1);
  });
}

module.exports = { ...log, log, scrub, redact, truncIp, errorCategory, errorInfo, userHash, setUserHashKey, withContext, context, requestLogger, routeOf, installProcessHandlers, config, LEVELS };
