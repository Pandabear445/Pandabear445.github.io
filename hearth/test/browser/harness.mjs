// Shared set-up for the browser suites (test/a11y, test/visual): a real Hearth server on a fresh data folder
// (test/helpers.js), a headless Chromium, and a few steps that drive the app the way a person would.
//
// Playwright isn't a dependency of Hearth. These suites use a Playwright install already on the machine:
// set PLAYWRIGHT_MODULE to its index.mjs (or install it globally) and CHROMIUM_PATH to a browser if
// Playwright's own download isn't there.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { startServer } = require('../helpers.js');

export const ROOT = path.join(here, '..', '..');
export const PASSWORD = 'correct horse battery staple';

async function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const t of tries) {
    try { return await import(t); } catch { /* try the next one */ }
  }
  throw new Error('Playwright not found. Set PLAYWRIGHT_MODULE to its index.mjs, or install it (npm i -g playwright).');
}

function chromiumPath() {
  const tries = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  return tries.find((p) => fs.existsSync(p));
}

// Starts the server and the browser. `close()` stops both and deletes the data folder.
export async function launch({ env = {} } = {}) {
  const { chromium } = await loadPlaywright();
  const srv = await startServer(env);
  // Fake camera and microphone, so calls can be joined without a prompt.
  const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [];
  const newPage = async ({ width = 1366, height = 768, reducedMotion = 'reduce', colorScheme = 'dark', isMobile = false, hasTouch = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion, colorScheme, isMobile, hasTouch, deviceScaleFactor: 1, permissions: ['microphone', 'camera'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    return page;
  };
  return {
    srv, browser, newPage, errors,
    async close() { await browser.close(); await srv.stop(); },
  };
}

// Creates an account through the sign-up form and waits for the app to finish loading.
export async function signUp(page, base, username) {
  await page.goto(base);
  await page.click('#to-register');
  await page.fill('#register-form [name=username]', username);
  await page.fill('#register-form [name=password]', PASSWORD);
  await page.fill('#register-form [name=confirm]', PASSWORD);
  await page.check('#register-form [name=tos]');
  await page.click('#register-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden]):not(.loading)', { timeout: 60000 });
  await settle(page);
}

// Lets drawing, fonts and short transitions finish.
export async function settle(page, ms = 300) {
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(ms);
}

// The signed-in app's own REST helper, for set-up steps that aren't what's under test.
export function apiIn(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch('/api' + u, {
      method: m,
      headers: { authorization: 'Bearer ' + localStorage.getItem('hearth.token'), ...(b ? { 'content-type': 'application/json' } : {}) },
      body: b ? JSON.stringify(b) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }, [method, url, body]);
}

// Creates a server through the "Add a server" dialog and opens its first text channel.
export async function createServer(page, name) {
  await page.click('#rail button[aria-label="Add a server"]');
  await page.click('.modal button.choice >> nth=0');
  await page.fill('.modal input.input', name);
  await page.click('.modal .modal-foot .btn.primary');
  await page.waitForSelector('#composer-input', { timeout: 15000 });
  await settle(page);
}

// Phones: closes the navigation drawer by tapping the dimmed part of the screen to its right.
export async function closeNav(page) {
  if (!(await page.locator('body.nav-open').count())) return;
  const { width, height } = page.viewportSize();
  await page.mouse.click(width - 8, Math.round(height / 2));
  await page.waitForFunction(() => !document.body.classList.contains('nav-open'), null, { timeout: 5000 });
  await settle(page, 250);
}

// Types into the main composer and waits until the message shows as sent.
export async function sendMessage(page, text) {
  const before = await page.locator('#messages .msg:not(.pending)').count();
  await page.fill('#composer-input', text);
  await page.press('#composer-input', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#messages .msg:not(.pending)').length > n, before, { timeout: 15000 });
}
