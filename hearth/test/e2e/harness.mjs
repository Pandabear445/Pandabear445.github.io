// End-to-end harness: a fresh Hearth server per run (temp data folder, free port), one browser with a separate
// context per person, and the UI helpers the flows share. Plain node + Playwright, nothing else.
//
// Playwright isn't a dependency of Hearth: it's looked up in this order, so a global install works as is:
//   PLAYWRIGHT_MODULE (a path or package name), 'playwright', 'playwright-core', then the copy this
//   project's dev containers ship in /opt/node22. The browser is CHROMIUM_PATH, the containers' Chromium, or
//   whatever Playwright installed itself (the same variables as the browser checks in test/files-hardening.test.js).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ Playwright and the browser
const PW_CANDIDATES = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean);
const CHROME_CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);

export async function loadPlaywright() {
  for (const name of PW_CANDIDATES) {
    try {
      const mod = await import(name.startsWith('/') ? pathToFileURL(name).href : name);
      const pw = mod.chromium ? mod : mod.default;
      if (pw && pw.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error(`Playwright not found (tried ${PW_CANDIDATES.join(', ')}). Install it (npm i -g playwright) or set PLAYWRIGHT_MODULE.`);
}

export async function launchBrowser({ headed = false, slowMo = 0 } = {}) {
  const { chromium } = await loadPlaywright();
  const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  return chromium.launch({
    headless: !headed, slowMo, executablePath,
    // Calls need a microphone: Chromium's fake one, allowed without a prompt.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
}

// ------------------------------------------------------------------ the server
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

export async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-e2e-data-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const outbox = path.join(dir, 'outbox');
  // Emails go to a folder instead of out (read with mails()); PUBLIC_URL is what reset links point at.
  const env = {
    ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'false', NODE_ENV: 'test',
    MAIL_OUTBOX_DIR: outbox, PUBLIC_URL: base,
  };
  let log = '';
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) {
    try { const r = await fetch(base + '/api/config'); if (r.ok) break; } catch { /* not up yet */ }
    if (i > 300 || child.exitCode !== null) throw new Error(`Hearth didn't start:\n${log}`);
    await sleep(100);
  }
  return {
    base, dir, port, get log() { return log; },
    // Every email the server has sent so far, oldest first: { to, subject, text }.
    mails() {
      if (!fs.existsSync(outbox)) return [];
      return fs.readdirSync(outbox).sort().map((f) => JSON.parse(fs.readFileSync(path.join(outbox, f), 'utf8')));
    },
    // The newest email to this address that matches, once it arrives.
    async mail(to, match, timeout = 15000) {
      for (const until = Date.now() + timeout; Date.now() < until; await sleep(100)) {
        const hit = this.mails().reverse().find((m) => m.to === to && match.test(m.subject + '\n' + m.text));
        if (hit) return hit;
      }
      throw new Error(`No email to ${to} matching ${match} arrived.`);
    },
    async stop({ keep = false } = {}) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        for (let i = 0; i < 60 && child.exitCode === null; i++) await sleep(50);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ people (one browser context each)
// Everything a page logs is kept: console messages, uncaught errors and failed requests. On a failure they're
// written next to a screenshot; uncaught errors and 5xx answers also fail the run at the end.
export class Person {
  constructor(name, context, page, base) {
    this.name = name; this.context = context; this.page = page; this.base = base;
    this.log = []; this.pageErrors = []; this.serverErrors = [];
    this.watch(page);
  }

  watch(page) {
    const stamp = () => new Date().toISOString().slice(11, 23);
    page.on('console', (m) => { if (m.type() !== 'verbose' && m.type() !== 'debug') this.log.push(`${stamp()} [${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => { this.log.push(`${stamp()} [pageerror] ${e.stack || e.message}`); this.pageErrors.push(e.message); });
    page.on('response', (r) => {
      if (r.status() < 400) return;
      const line = `${r.status()} ${r.request().method()} ${r.url().replace(this.base, '')}`;
      this.log.push(`${stamp()} [http] ${line}`);
      if (r.status() >= 500) this.serverErrors.push(line);
    });
    page.on('requestfailed', (r) => { if (r.url().startsWith(this.base)) this.log.push(`${stamp()} [requestfailed] ${r.method()} ${r.url().replace(this.base, '')} ${r.failure() ? r.failure().errorText : ''}`); });
  }

  static async open(browser, base, name) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, permissions: ['microphone', 'camera'] });
    // Nothing leaves this machine: fonts and other outside requests are refused (fast and the same every run).
    await context.route((url) => !url.href.startsWith(base), (route) => route.abort());
    // Every call connection the app makes, so the voice flow can check it really connected.
    await context.addInitScript(() => {
      const Orig = window.RTCPeerConnection;
      if (!Orig || window.__e2ePeers) return;
      const peers = [];
      Object.defineProperty(window, '__e2ePeers', { value: peers });
      window.RTCPeerConnection = class extends Orig { constructor(...args) { super(...args); peers.push(this); } };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(base);
    return new Person(name, context, page, base);
  }

  async close() { await this.context.close().catch(() => {}); }

  // ---- small UI helpers (all wait on the page, never on the clock)
  $(sel, opts) { return this.page.locator(sel, opts); }
  async waitApp(timeout = 60000) { await this.page.waitForSelector('#app:not([hidden]):not(.loading)', { timeout }); }
  // The dialog with this title (the newest one, if several are stacked).
  modal(title) { return this.page.locator('.modal').filter({ has: this.page.locator('.modal-head h2', { hasText: title }) }).last(); }
  // The same, once it's ready to type into: dialogs move the focus to their first field 30 ms after they open
  // (ui.js modal(), and some dialogs again on their own), which would otherwise land in the middle of typing
  // into another field. So wait out that one short timer, then a frame.
  async dialog(title) {
    const m = this.modal(title);
    await m.waitFor();
    await this.page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => r()), 60)));
    return m;
  }
  async noModals() { await this.page.waitForSelector('.modal-backdrop', { state: 'detached' }); }
  menuItem(label) { return this.page.locator('.popover .menu-item').filter({ has: this.page.locator('.menu-label', { hasText: exact(label) }) }); }
  async toast(text, timeout = 20000) { await this.page.locator('#toasts .toast').filter({ hasText: text }).first().waitFor({ timeout }); }
  async railButton(label) { await this.page.locator(`#rail button[aria-label="${label}"]`).click(); }
  async serverMenu(item) { await this.$('#sidebar-head .server-head').click(); await this.menuItem(item).click(); }
  // A conversation in the DM sidebar, by its exact name (a group's preview line can mention other names).
  dmRow(name) { return this.page.locator('#sidebar-body .dm-row').filter({ has: this.page.locator('.dm-row-name', { hasText: exact(name) }) }); }
  channelRow(name) { return this.page.locator('#sidebar-body .ch-row').filter({ has: this.page.locator('.ch-name', { hasText: exact(name) }) }); }
  async openChannel(name) {
    await this.channelRow(name).locator('.ch-main').click();
    await this.page.waitForSelector(`#composer-input[placeholder="Message #${name}"]`);
  }
  // A message in the conversation on screen (not a "Sending…" copy).
  message(text, scope = '#messages') { return this.page.locator(`${scope} .msg[data-mid]:not([data-mid^="pending-"])`).filter({ has: this.page.locator('.msg-text', { hasText: text }) }); }
  async send(text, composer = '#composer-input') {
    const box = this.$(composer);
    await box.fill(text);
    await box.press('Enter');
    await this.message(text, composer === '#composer-input' ? '#messages' : '.thread-list').first().waitFor();
  }
  async messageAction(text, action) {
    const m = this.message(text).first();
    await m.hover();
    await m.locator('button[aria-label="More actions"]').click();
    await this.menuItem(action).click();
  }
  // The "Confirm it's you" step before sensitive changes: the password, then the dialog's main button.
  async confirmPassword(title, password) {
    const m = await this.dialog(title);
    await m.locator('input[type=password]').fill(password);
    await m.locator('.modal-foot .btn.primary').click();
    return m;
  }
  async openSettings(tab, sub) {
    await this.$('#user-panel button[aria-label="Settings"]').click();
    if (tab) await this.page.locator('.set-nav .set-nav-btn', { hasText: exact(tab) }).click();
    if (sub) await this.page.locator('.set-subtabs .set-subtab', { hasText: exact(sub) }).click();
  }
  async closeSettings() { await this.$('.set-close').click(); await this.page.waitForSelector('.settings-modal', { state: 'detached' }); }
  async showMembers() {
    if (await this.$('#members .member-list').count()) return;
    await this.$('#main-head button[aria-label="Show members"]').click();
    await this.$('#members .member-list').waitFor();
  }
  member(name) { return this.page.locator('#members .member').filter({ has: this.page.locator('.member-name', { hasText: name }) }); }

  // ---- accounts, through the real sign-up and sign-in forms (Argon2id and key generation in the page)
  async register(username, password) {
    await this.$('#to-register').click();
    const f = this.$('#register-form');
    await f.locator('[name=username]').fill(username);
    await f.locator('[name=password]').fill(password);
    await f.locator('[name=confirm]').fill(password);
    await f.locator('[name=tos]').check();
    await f.locator('button[type=submit]').click();
    await this.waitApp();
  }
  async login(username, password) {
    const f = this.$('#login-form');
    await f.waitFor();
    await f.locator('[name=username]').fill(username);
    await f.locator('[name=password]').fill(password);
    await f.locator('button[type=submit]').click();
    await this.waitApp();
  }
  async logout() {
    await this.openSettings();
    await this.page.locator('.set-nav .set-nav-btn.danger', { hasText: 'Log out' }).click();
    await this.modal('Log out?').locator('.modal-foot .btn.danger').click();
    await this.page.waitForSelector('#login-form:not([hidden])');
  }
  async inviteLink() {
    await this.serverMenu('Invite people');
    const out = this.$('.modal input[aria-label="Invite link"]');
    await this.page.waitForFunction(() => /\/invite\/\w+/.test((document.querySelector('.modal input[aria-label="Invite link"]') || {}).value || ''));
    const link = await out.inputValue();
    await this.$('.modal .modal-x').click();
    await this.noModals();
    return link;
  }
  async join(link, serverName) {
    await this.railButton('Add a server');
    await this.page.locator('.modal .choice', { hasText: 'Join with an invite' }).click();
    const m = await this.dialog('Join a server');
    await m.locator('input.input').fill(link);
    await m.locator('.invite-preview strong', { hasText: serverName }).waitFor();
    await m.locator('.modal-foot .btn.primary').click();
    await this.page.locator('#sidebar-head .server-head-name', { hasText: exact(serverName) }).waitFor();
    await this.noModals();
  }
  async createServer(name) {
    await this.railButton('Add a server');
    await this.page.locator('.modal .choice', { hasText: 'Create my own' }).click();
    const m = await this.dialog('Create a server');
    await m.locator('input.input').fill(name);
    await m.locator('.modal-foot .btn.primary').click();
    await this.page.locator('#sidebar-head .server-head-name', { hasText: exact(name) }).waitFor();
    await this.noModals();
  }
  // Everything this person's app has open, for a failure report.
  async capture(dir) {
    const safe = this.name.replace(/\W+/g, '_');
    for (const [i, p] of this.context.pages().entries()) {
      const tag = i ? `${safe}-${i}` : safe;
      await p.screenshot({ path: path.join(dir, `${tag}.png`) }).catch(() => {});
      fs.writeFileSync(path.join(dir, `${tag}.html`), await p.content().catch((e) => String(e)));
    }
    fs.writeFileSync(path.join(dir, `${safe}.console.log`), this.log.join('\n') + '\n');
  }
}

// A regular expression matching exactly this text (Playwright's hasText is a substring match otherwise).
export function exact(text) { return new RegExp(`^\\s*${String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`); }

// A password made fresh for each run, so no password is ever written down in the repository.
export const newPassword = () => `pw-${crypto.randomBytes(9).toString('base64url')}`;

// The 6-digit code an authenticator app would show for this secret (RFC 6238: SHA-1, 30-second steps).
export function totp(secret, at = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; const bytes = [];
  for (const ch of String(secret).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const hm = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = hm[19] & 15;
  return String((hm.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// ------------------------------------------------------------------ test files
// A small real PNG (a colour gradient), so the image goes through the app's own image handling.
export function makePng(w = 64, h = 48) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 4) & 255; raw[o + 1] = (y * 5) & 255; raw[o + 2] = 200; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
