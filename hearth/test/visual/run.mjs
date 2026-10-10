// Visual regression check (npm run test:visual): seven core screens at a desktop and a phone size,
// compared with saved baselines at a tolerance. Not part of `npm test` and not run in CI: screenshots
// depend on the machine's fonts and graphics, so baselines are made on the machine that checks them.
//
//   npm run test:visual               compare with test/visual/baseline/ (made on the first run)
//   npm run test:visual -- --update   accept the current look as the new baseline
//
// Differences are written to test/visual/output/ (the new screenshot and a diff with changed pixels in
// magenta). Comparison runs in the browser on a canvas, so no image library is needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, signUp, createServer, sendMessage, settle, closeNav } from '../browser/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(here, 'baseline');
const OUT_DIR = path.join(here, 'output');
const update = process.argv.includes('--update');
// A pixel counts as changed when any channel moves by more than PIXEL_DELTA; a screen fails when more
// than MAX_CHANGED of its pixels changed. Repeated runs on one machine came out identical, so this only has
// to absorb small rendering noise; the dark themes' subtle borders differ from their panels by about 10-30
// levels, so a bigger delta would miss real changes there.
const PIXEL_DELTA = 10;
const MAX_CHANGED = 0.0001;
const SIZES = [{ name: 'desktop', width: 1366, height: 768 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true }];
// Parts that change between runs (times, avatar colours made from random ids, the time-of-day greeting) are
// blanked by a test-only stylesheet. Masking them in the screenshot isn't enough: dialog backdrops blur
// what's behind them, which smears those colours past any mask.
const STEADY_CSS = `
  .av-inner { background: #777 !important; }
  .msg-time, .msg-hover-time, .day-div span, .home-view h1, .inbox-time, .conv-time { color: transparent !important; }
`;

fs.mkdirSync(BASE_DIR, { recursive: true });
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// Counts changed pixels between two PNGs (as data URLs) and paints a diff image.
function diffInPage([a, b, delta]) {
  const load = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
  return Promise.all([load(a), load(b)]).then(([ia, ib]) => {
    if (ia.width !== ib.width || ia.height !== ib.height) return { sizeChanged: true, changed: 1, total: 1 };
    const w = ia.width; const hgt = ia.height;
    const canvas = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = hgt; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x; };
    const da = canvas(ia).getImageData(0, 0, w, hgt).data;
    const db = canvas(ib).getImageData(0, 0, w, hgt).data;
    const outCtx = canvas(ib);
    const out = outCtx.getImageData(0, 0, w, hgt);
    let changed = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d > delta) { changed++; out.data.set([255, 0, 255, 255], i); } else { out.data[i + 3] = 70; }
    }
    outCtx.putImageData(out, 0, 0);
    return { changed, total: w * hgt, diff: changed ? outCtx.canvas.toDataURL('image/png') : null };
  });
}

const H = await launch();
const results = [];
try {
  // One account and one server with a few messages, shared by both sizes.
  const seed = await H.newPage();
  await signUp(seed, H.srv.base, 'visual');
  await createServer(seed, 'Visual check');
  for (const t of ['Morning! Has anyone tried the new **release**?', 'Yes — the search is much faster now.', 'Here is the changelog: https://example.com/changelog', 'Nice. I’ll update tonight.']) await sendMessage(seed, t);
  await seed.close();

  for (const size of SIZES) {
    const page = await H.newPage(size);
    // Web fonts come from Google; blocking them keeps screenshots the same online and offline.
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await page.addInitScript((css) => document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style'); s.textContent = css; document.head.append(s);
    }), STEADY_CSS);
    const shots = [];
    const shot = async (name) => {
      // No hover tooltips in the picture.
      await page.mouse.move(size.width - 2, size.height - 2);
      await settle(page, 400);
      await page.evaluate(() => document.querySelectorAll('.tooltip').forEach((t) => t.remove()));
      const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      shots.push({ name: `${name}-${size.name}`, png });
    };
    await page.goto(H.srv.base);
    await shot('sign-in');
    await page.fill('#login-form [name=username]', 'visual');
    await page.fill('#login-form [name=password]', 'correct horse battery staple');
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector('#app:not([hidden]):not(.loading)', { timeout: 60000 });
    await shot('home');
    if (size.isMobile) { await page.click('.nav-toggle'); await settle(page, 300); }
    await page.click('#rail button[aria-label^="Visual check"]');
    await settle(page, 300);
    if (await page.locator('body.nav-open').count()) await page.click('#sidebar-body .ch-row >> nth=0');
    await page.waitForSelector('#messages .msg');
    if (await page.locator('#members:not([hidden])').count()) await page.click('#main-head button[aria-label="Hide members"]');
    await page.mouse.move(0, 0);
    await shot('channel');
    if (size.isMobile) { await page.click('.nav-toggle'); await shot('navigation'); await closeNav(page); }
    else { await page.click('#main-head button[aria-label="Show members"]'); await shot('members'); await page.click('#main-head button[aria-label="Hide members"]'); }
    await page.keyboard.press('Control+k');
    await shot('search');
    await page.keyboard.press('Escape');
    await settle(page, 300);
    if (size.isMobile) { await page.click('.nav-toggle'); await settle(page, 300); }
    await page.click('#user-panel button[aria-label="Settings"]');
    await shot('settings');
    await page.keyboard.press('Escape');
    await settle(page, 300);
    await page.click('#sidebar-head .server-head');
    await page.locator('.popover .menu-item', { hasText: 'Server settings' }).first().click();
    await shot('server-settings');
    await page.close();

    for (const s of shots) {
      const file = path.join(BASE_DIR, `${s.name}.png`);
      if (update || !fs.existsSync(file)) {
        fs.writeFileSync(file, s.png);
        results.push({ name: s.name, status: update ? 'updated' : 'new baseline' });
        continue;
      }
      const cmp = await H.newPage({ width: 200, height: 200 });
      const r = await cmp.evaluate(diffInPage, [`data:image/png;base64,${fs.readFileSync(file).toString('base64')}`, `data:image/png;base64,${s.png.toString('base64')}`, PIXEL_DELTA]);
      await cmp.close();
      const share = r.changed / r.total;
      const ok = !r.sizeChanged && share <= MAX_CHANGED;
      if (!ok) {
        fs.writeFileSync(path.join(OUT_DIR, `${s.name}.png`), s.png);
        if (r.diff) fs.writeFileSync(path.join(OUT_DIR, `${s.name}.diff.png`), Buffer.from(r.diff.split(',')[1], 'base64'));
      }
      results.push({ name: s.name, status: ok ? 'ok' : 'CHANGED', detail: r.sizeChanged ? 'size changed' : `${(share * 100).toFixed(3)}% of pixels differ` });
    }
  }
} catch (e) {
  results.push({ name: 'run', status: 'ERROR', detail: e.stack || String(e) });
} finally {
  await H.close();
}

for (const r of results) console.log(`${r.status.padEnd(12)} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
const bad = results.filter((r) => r.status === 'CHANGED' || r.status === 'ERROR');
console.log(`\n${results.length} screens, ${bad.length} changed${bad.length ? ` — see ${path.relative(process.cwd(), OUT_DIR)}/, and run with --update if the change is intended` : ''}`);
process.exit(bad.length ? 1 : 0);
