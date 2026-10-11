// Test harness for the security suite: starts a real Hearth server (fresh data folder, random port) as a child
// process, and talks to it over HTTP like an app — or an attacker — would. Each test file gets its own server.
//
// Requests carry X-Forwarded-For (the server trusts it from localhost, as behind Caddy), so a test can pretend
// to come from any address: that's how IP-rotation attacks are simulated.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { startSmtpSink } = require('./smtp-sink');

const ROOT = path.join(__dirname, '..');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipCounter = 0;
// A fresh public-looking address (198.18.0.0/15 is reserved for testing).
const newIp = () => { ipCounter++; return `198.18.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; };
const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64 = (n) => crypto.randomBytes(n).toString('base64');

// ------------------------------------------------------------------ two-factor codes (RFC 6238)
function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret, offsetSteps = 0) {
  const counter = Math.floor(Date.now() / 30000) + offsetSteps;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// ------------------------------------------------------------------ the "I'm not a robot" proof of work
// Solved with the app's own solver (public/js/captcha-worker.js, minus its message handler): several times faster
// than hashing with node:crypto, and it checks that what browsers run gets accepted.
const SOLVER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'captcha-worker.js'), 'utf8').replace(/self\.onmessage[\s\S]*$/, '');
const appSolve = new Function(`${SOLVER_SRC}\nreturn solve;`)();
const solved = (c, nonce) => ({ salt: c.salt, difficulty: c.difficulty, expires: c.expires, sig: c.sig, nonce });
function solveCaptcha(c) { return solved(c, appSolve(c.salt, c.difficulty)); }
// Many at once, on all but one of this machine's cores (for tests that need a flood of solved checks).
async function solveCaptchas(list) {
  const { Worker } = require('node:worker_threads');
  const n = Math.max(1, Math.min(list.length, os.cpus().length - 1));
  const code = `${SOLVER_SRC}\nconst { parentPort, workerData } = require('node:worker_threads');\nparentPort.postMessage(workerData.map((c) => solve(c.salt, c.difficulty)));`;
  const parts = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: list.filter((_, j) => j % n === i).map((c) => ({ salt: c.salt, difficulty: c.difficulty })) });
    w.once('message', (m) => { w.terminate(); resolve(m); });
    w.once('error', reject);
  })));
  return list.map((c, j) => solved(c, parts[j % n][Math.floor(j / n)]));
}

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
  const port = await freePort();
  // Emails go out over SMTP as on a real server, to a mail sink in this process (read them with mails()). No
  // SMTP login: the sink offers none, and a developer's own SMTP_USER/SMTP_PASS mustn't be tried against it.
  const sink = await startSmtpSink();
  const env = {
    ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'false', NODE_ENV: 'test',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: 'hearth@chat.example.test',
    PUBLIC_URL: 'https://chat.example.test', FEED_ALLOW_PRIVATE: '',
    // The readable log format prints stack traces on their own lines, which the attack suite counts as crashes
    // (JSON lines would hide them inside a string). Tests that parse the log ask for LOG_FORMAT=json.
    LOG_FORMAT: 'pretty', ...extraEnv,
  };
  let log = '';
  let child;
  const base = `http://127.0.0.1:${port}`;
  const launch = async () => {
    child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    for (let i = 0; ; i++) {
      try { const r = await fetch(base + '/api/config'); if (r.ok) break; } catch { /* not up yet */ }
      if (i > 150 || child.exitCode !== null) throw new Error(`Hearth didn't start:\n${log}`);
      await sleep(100);
    }
  };
  const halt = async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(50); if (child.exitCode === null) child.kill('SIGKILL'); }
  };
  try { await launch(); } catch (e) { await sink.close(); throw e; }
  const config = await (await fetch(base + '/api/config')).json();

  const srv = {
    base, dir, port, config, get child() { return child; }, get log() { return log; },
    // Stops and starts the same server on the same data (like an update or a reboot), optionally with some
    // settings in its environment changed (as an operator editing .env).
    async restart(envChanges = {}) { await halt(); Object.assign(env, envChanges); log = ''; await launch(); },
    // One HTTP request. Returns { status, json, text, headers }. Never throws on an error status.
    async call(method, p, { token, body, ip, headers = {}, raw, timeout = 15000 } = {}) {
      const h = { 'x-forwarded-for': ip || '198.51.100.1', ...headers };
      if (token) h.authorization = `Bearer ${token}`;
      let payload;
      if (method === 'GET' || method === 'HEAD') { raw = undefined; body = undefined; }
      if (raw !== undefined) { payload = raw; if (!h['content-type']) h['content-type'] = 'application/json'; } else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(base + (p.startsWith('/') ? p : '/' + p), { method, headers: h, body: payload, signal: ctl.signal, redirect: 'manual' });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, json, text, headers: r.headers };
      } finally { clearTimeout(timer); }
    },
    api(method, p, opts) { return srv.call(method, '/api' + p, opts); },
    // Creates an account the way the app does (real P-256 identity key; the rest is opaque to the server).
    async register(username = `u${hex(4)}`, { ip = newIp() } = {}) {
      const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const user = {
        username, ip, authKey: hex(32), kdfSalt: b64(16), privateKey: kp.privateKey,
        publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), encPrivateKey: b64(120),
      };
      const body = { username, authKey: user.authKey, publicKey: user.publicKey, encPrivateKey: user.encPrivateKey, kdfSalt: user.kdfSalt, acceptTos: srv.config.termsVersion || undefined };
      let r = await srv.api('POST', '/auth/register', { body, ip });
      if (r.status === 400 && r.json && r.json.code === 'captcha') {
        const c = (await srv.api('GET', '/captcha?purpose=register', { ip })).json;
        r = await srv.api('POST', '/auth/register', { body: { ...body, captcha: solveCaptcha(c) }, ip });
      }
      if (r.status !== 200) throw new Error(`register ${username}: ${r.status} ${r.text}`);
      user.id = r.json.user.id; user.token = r.json.token;
      return user;
    },
    async login(user, extra = {}, { ip = user.ip } = {}) {
      return srv.api('POST', '/auth/login', { body: { username: user.username, authKey: user.authKey, ...extra }, ip });
    },
    // Direct database access, as someone who copied the file would have.
    db() {
      const Database = require('better-sqlite3');
      const d = new Database(path.join(dir, 'hearth.db'));
      d.pragma('busy_timeout = 5000');
      return d;
    },
    sql(q, ...args) { const d = srv.db(); try { return /^\s*select/i.test(q) ? d.prepare(q).all(...args) : d.prepare(q).run(...args); } finally { d.close(); } },
    // Every email the server has sent so far, oldest first: { to, subject, text }. Waits until mail has stopped
    // arriving first, since some are sent after the HTTP answer (security notices, reset links).
    async mails() { await sink.idle(); return sink.messages.map((m) => ({ ...m })); },
    async stop() { await halt(); await sink.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    // A live connection like an open app window. Resolves once connected (or rejects with the server's reason).
    async socket(token) {
      const { io } = require('socket.io-client');
      const s = io(base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
      await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
      return s;
    },
  };
  // The first account is the owner. Turn the robot check off for the rest of the suite (one test turns it back on).
  srv.owner = await srv.register('owner');
  const r = await srv.api('PUT', '/admin/registration', { token: srv.owner.token, body: { captchaLogin: 'off', captchaRegister: 'off' }, ip: srv.owner.ip });
  if (r.status !== 200) throw new Error('could not turn captcha off: ' + r.text);
  return srv;
}

// Adds an email to an account (through the real confirmation code).
async function confirmEmail(srv, user, email) {
  const before = (await srv.mails()).length;
  const r = await srv.api('POST', '/me/email', { token: user.token, body: { email, authKey: user.authKey }, ip: user.ip });
  if (r.status !== 200) throw new Error('email: ' + r.text);
  const mail = (await srv.mails()).slice(before).find((m) => m.to === email);
  const code = /is (\d{6})/.exec(mail.subject)[1];
  const v = await srv.api('POST', '/me/email/verify', { token: user.token, body: { code }, ip: user.ip });
  if (v.status !== 200) throw new Error('verify: ' + v.text);
}
// Turns two-factor on. Returns { secret, backupCodes, used } (used: code steps already spent) and updates user.token (other sessions are signed out).
async function enable2fa(srv, user) {
  const s = await srv.api('POST', '/me/2fa/setup', { token: user.token, body: { authKey: user.authKey }, ip: user.ip });
  if (s.status !== 200) throw new Error('2fa setup: ' + s.text);
  const secret = s.json.secret.replace(/\s/g, '');
  const used = new Set();
  const e = await srv.api('POST', '/me/2fa/enable', { token: user.token, body: { code: await freshCode(secret, used) }, ip: user.ip });
  if (e.status !== 200) throw new Error('2fa enable: ' + e.text);
  return { secret, backupCodes: e.json.backupCodes, used };
}
// The next not-yet-used code: codes work once, so a test that needs several waits for a new 30-second step.
async function freshCode(secret, usedSteps) {
  for (;;) {
    const step = Math.floor(Date.now() / 30000);
    if (!usedSteps.has(step)) { usedSteps.add(step); return totp(secret); }
    await sleep(Math.max(50, 30000 - (Date.now() % 30000) + 50));
  }
}
// The proof that a reset keeps the right private key (see /auth/reset/info).
function resetProof(user, challenge) {
  const pub = crypto.createPublicKey({ key: Buffer.from(challenge.serverPublicKey, 'base64'), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: user.privateKey, publicKey: pub });
  return crypto.createHmac('sha256', shared).update(`hearth-reset-proof|${user.id}|${challenge.nonce}`).digest('base64');
}
const resetTokenFrom = (mail) => /#reset=([\w-]+)/.exec(mail.text)[1];

module.exports = { startServer, confirmEmail, enable2fa, freshCode, totp, resetProof, resetTokenFrom, newIp, hex, b64, sleep, solveCaptcha, solveCaptchas };
