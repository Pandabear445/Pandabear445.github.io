// Accessibility and responsive-layout checks in a real browser (npm run test:a11y). Separate from
// `npm test`: it needs Chromium and Playwright (see test/browser/harness.mjs). Each check below guards a
// fix described in docs/ACCESSIBILITY.md, so it doesn't quietly come back.
import { launch, signUp, createServer, sendMessage, settle, PASSWORD } from '../browser/harness.mjs';
import { auditDom, overflowDom } from './checks.mjs';
import { checkContrast } from './contrast.mjs';

const results = [];
let current = '';
function check(cond, what, detail = '') {
  results.push({ group: current, ok: !!cond, what, detail: cond ? '' : detail });
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${what}${!cond && detail ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const section = (name) => { current = name; console.log(`\n${name}`); };

// The audit must find nothing on this screen.
async function audit(page, label) {
  const issues = await page.evaluate(auditDom);
  check(!issues.length, `no audit issues: ${label}`, issues.slice(0, 8).map((i) => `${i.rule} ${i.el}: ${i.detail}`).join('\n         '));
}
const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a ? { tag: a.tagName, label: a.getAttribute('aria-label') || a.textContent.trim().slice(0, 40), cls: a.className, inModal: !!a.closest('.modal'), inPop: !!a.closest('.popover') } : null;
});

const H = await launch();
const { base } = H.srv;
try {
  // ------------------------------------------------------------------ signed out
  section('Sign-in and sign-up');
  const page = await H.newPage({ width: 1366, height: 768 });
  await page.goto(base); await settle(page);
  await audit(page, 'sign-in form');
  await page.click('#to-register');
  await audit(page, 'sign-up form');
  await page.fill('#register-form [name=username]', 'mismatch');
  await page.fill('#register-form [name=password]', PASSWORD);
  await page.fill('#register-form [name=confirm]', PASSWORD + 'x');
  await page.check('#register-form [name=tos]');
  await page.click('#register-form button[type=submit]');
  const reg = await page.evaluate(() => {
    const c = document.querySelector('#register-form [name=confirm]');
    const ids = (c.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    return { invalid: c.getAttribute('aria-invalid'), described: ids.map((id) => (document.getElementById(id) || {}).textContent).join(' '), focused: document.activeElement === c };
  });
  check(reg.invalid === 'true', 'a wrong password confirmation marks that field invalid', reg);
  check(/do not match/.test(reg.described), 'the error message is tied to the field (aria-describedby)', reg);
  check(reg.focused, 'focus moves to the field with the error', reg);
  await page.fill('#register-form [name=confirm]', PASSWORD);
  check(await page.getAttribute('#register-form [name=confirm]', 'aria-invalid') === null, 'editing the field clears the error state');
  await page.close();

  // ------------------------------------------------------------------ the app
  section('Main screens: names, labels, alt text, tabindex');
  const p = await H.newPage({ width: 1366, height: 768 });
  await signUp(p, base, 'alice');
  await audit(p, 'home');
  await createServer(p, 'Quality checks');
  await sendMessage(p, 'Hello **there**, with a link https://example.com/docs');
  await sendMessage(p, 'A second message');
  await sendMessage(p, 'A third message');
  await audit(p, 'channel with messages');
  const dot = await p.evaluate(() => { const d = document.querySelector('#user-panel .status-dot'); return d && { role: d.getAttribute('role'), label: d.getAttribute('aria-label') }; });
  check(dot && dot.role === 'img' && dot.label === 'Online', 'presence dots say their status in words, not only colour', dot);
  // Icon-only buttons (no visible text) all have a name.
  const unnamed = await p.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby') && b.getClientRects().length).map((b) => b.className));
  check(!unnamed.length, 'icon-only buttons have labels', unnamed);
  await p.click('#messages .msg >> nth=-1', { button: 'right' }); await settle(p, 200);
  await audit(p, 'message context menu');
  await p.keyboard.press('Escape');
  await p.click('.cw-main button[aria-label="Emoji"]'); await settle(p, 400);
  await audit(p, 'emoji picker');
  await p.keyboard.press('Escape');
  await p.click('.me-btn'); await settle(p, 200);
  await audit(p, 'status menu');
  await p.keyboard.press('Escape');
  await p.keyboard.press('Control+k'); await settle(p, 300);
  await audit(p, 'search');
  const searchName = await p.evaluate(() => { const d = document.querySelector('.modal-search'); return d && d.getAttribute('aria-label'); });
  check(searchName === 'Search', 'the search dialog is named', searchName);
  await p.keyboard.press('Escape'); await settle(p, 300);
  await p.click('#user-panel button[aria-label="Settings"]'); await settle(p, 500);
  const setName = await p.evaluate(() => document.querySelector('.settings-modal').getAttribute('aria-label'));
  check(setName === 'Settings', 'the settings dialog is named', setName);
  for (const label of ['Profile', 'Security', 'Privacy & safety', 'Appearance', 'Chat', 'Notifications', 'Voice & video', 'Keybinds', 'Apps & devices']) {
    const btn = p.locator('.set-nav-btn', { hasText: label }).first();
    if (!(await btn.count())) continue;
    await btn.click(); await settle(p, 250);
    await audit(p, `settings: ${label}`);
  }
  await p.keyboard.press('Escape'); await settle(p, 300);

  section('Server screens and dialogs');
  await p.click('#sidebar-head .server-head'); await settle(p, 200);
  await p.locator('.popover .menu-item', { hasText: 'Server settings' }).first().click(); await settle(p, 500);
  const ssTabs = await p.locator('.ss-nav button').allTextContents();
  for (let i = 0; i < ssTabs.length; i++) {
    await p.locator('.ss-nav button').nth(i).click(); await settle(p, 400);
    await audit(p, `server settings: ${ssTabs[i].trim()}`);
  }
  await p.keyboard.press('Escape'); await settle(p, 300);
  await p.click('#sidebar-head .server-head'); await settle(p, 200);
  await p.locator('.popover .menu-item', { hasText: /Invite/ }).first().click(); await settle(p, 500);
  await audit(p, 'invite dialog');
  await p.keyboard.press('Escape'); await settle(p, 300);
  await p.click('#sidebar-head .server-head'); await settle(p, 200);
  await p.locator('.popover .menu-item', { hasText: /Create channel|New channel/ }).first().click(); await settle(p, 400);
  await audit(p, 'create channel dialog');
  await p.keyboard.press('Escape'); await settle(p, 300);
  await p.click('#messages .msg .msg-av >> nth=0'); await settle(p, 400);
  await audit(p, 'profile popup');
  await p.keyboard.press('Escape'); await settle(p, 200);
  await p.click('#rail button[aria-label="Home"]'); await settle(p, 400);
  await p.locator('#sidebar-body button', { hasText: 'Friends' }).first().click(); await settle(p, 400);
  await audit(p, 'friends');
  await p.locator('#main-head [role=tab]', { hasText: 'Add friend' }).click(); await settle(p, 300);
  await audit(p, 'add friend');
  await p.click('#rail button[aria-label^="Quality checks"]'); await settle(p, 500);

  section('Admin screens');
  // Hand the instance to alice (the test harness made a first, API-only account the owner).
  const aliceId = await p.evaluate(() => localStorage.getItem('hearth.userId'));
  const own = await H.srv.api('POST', '/admin/owner', { token: H.srv.owner.token, body: { userId: aliceId, authKey: H.srv.owner.authKey }, ip: H.srv.owner.ip });
  check(own.status === 200, 'set-up: alice is the owner', own.text);
  await p.reload(); await p.waitForSelector('#app:not([hidden]):not(.loading)'); await settle(p, 500);
  await p.click('#rail button[aria-label="Admin"]'); await settle(p, 600);
  const adminTabs = await p.evaluate(() => [...document.querySelectorAll('.admin-tab')].map((b) => b.textContent.trim()));
  for (const label of ['Overview', 'Online', 'Reports', 'Users', 'Servers', 'Security', 'Team & roles', 'Registration & Terms', 'Audit log', 'Regions', 'Money', 'Owner']) {
    const btn = p.locator('.admin-tab', { hasText: label }).first();
    if (!(await btn.count())) { check(false, `admin tab "${label}" can be found`, adminTabs); continue; }
    await btn.click(); await settle(p, 500);
    await audit(p, `admin: ${label}`);
  }
  await p.click('#user-panel button[aria-label="Settings"]'); await settle(p, 500);
  const inst = p.locator('.set-nav-btn', { hasText: 'Server settings' }).first();
  if (await inst.count()) { await inst.click(); await settle(p, 500); await audit(p, 'settings: Server settings (instance)'); }
  await p.keyboard.press('Escape'); await settle(p, 300);
  await p.click('#rail button[aria-label^="Quality checks"]'); await settle(p, 500);

  section('Contrast of the theme tokens (WCAG 2.x)');
  const rows = await checkContrast(p);
  for (const theme of [...new Set(rows.map((r) => r.theme))]) {
    const bad = rows.filter((r) => r.theme === theme && !r.ok);
    check(!bad.length, `${theme}: ${rows.filter((r) => r.theme === theme).length} colour pairs meet their minimum`, bad.map((r) => `${r.use}: ${r.ratio}:1 < ${r.min}:1`).join('; '));
  }

  section('Dialogs: focus moves in, stays in, goes back; Esc closes');
  const addBtn = p.locator('#rail button[aria-label="Add a server"]');
  await addBtn.focus();
  await p.keyboard.press('Enter'); await settle(p, 200);
  const dlg = await p.evaluate(() => {
    const m = document.querySelector('.modal-backdrop:not(.closing) .modal');
    const by = m && m.getAttribute('aria-labelledby');
    return m && { modal: m.getAttribute('aria-modal'), title: by && document.getElementById(by) ? document.getElementById(by).textContent : null };
  });
  check(dlg && dlg.modal === 'true', 'dialogs are aria-modal', dlg);
  check(dlg && dlg.title === 'Add a server', 'dialogs are labelled by their title', dlg);
  check((await active(p)).inModal, 'focus moves into the dialog when it opens', await active(p));
  let escaped = false;
  for (let i = 0; i < 8; i++) { await p.keyboard.press('Tab'); if (!(await active(p)).inModal) escaped = true; }
  for (let i = 0; i < 8; i++) { await p.keyboard.press('Shift+Tab'); if (!(await active(p)).inModal) escaped = true; }
  check(!escaped, 'Tab and Shift+Tab stay inside the dialog');
  await p.keyboard.press('Escape'); await settle(p, 250);
  check(!(await p.locator('.modal-backdrop:not(.closing)').count()), 'Esc closes the dialog');
  check((await active(p)).label === 'Add a server', 'focus returns to the button that opened it', await active(p));
  // Back and forth between dialogs still ends up on the original button.
  await p.keyboard.press('Enter'); await settle(p, 200);
  await p.click('.modal button.choice >> nth=0'); await settle(p, 250);
  check((await active(p)).inModal, 'the next dialog in a flow gets focus', await active(p));
  await p.keyboard.press('Escape'); await settle(p, 250);
  check((await active(p)).label === 'Add a server', 'after a two-step flow, focus still returns to the opener', await active(p));
  // A confirmation on top of another dialog hands focus back to that dialog, not the page.
  await p.click('#user-panel button[aria-label="Settings"]'); await settle(p, 400);
  const logout = p.locator('.set-nav-btn.danger');
  await logout.focus(); await p.keyboard.press('Enter'); await settle(p, 250);
  check((await p.locator('.modal-backdrop:not(.closing)').count()) === 2, 'a confirmation opens on top of settings');
  await p.keyboard.press('Escape'); await settle(p, 250);
  const back = await active(p);
  check(back.inModal && /Log out/.test(back.label), 'closing it puts focus back on the button in settings', back);
  await p.keyboard.press('Escape'); await settle(p, 300);

  section('Menus and popups: aria-expanded, arrow keys, Esc');
  const head = p.locator('#sidebar-head .server-head');
  check(await head.getAttribute('aria-haspopup') && (await head.getAttribute('aria-expanded')) === 'false', 'menu buttons say they open a popup and that it is closed');
  await head.focus(); await p.keyboard.press('Enter'); await settle(p, 200);
  check((await head.getAttribute('aria-expanded')) === 'true', 'aria-expanded turns true while the menu is open');
  const m1 = await active(p);
  check(m1.inPop && /menu-item/.test(m1.cls), 'focus lands on the first menu item', m1);
  await p.keyboard.press('ArrowDown');
  const m2 = await active(p);
  check(m2.inPop && m2.label !== m1.label, 'ArrowDown moves to the next item', [m1.label, m2.label]);
  await p.keyboard.press('End');
  const m3 = await active(p);
  await p.keyboard.press('Home');
  check((await active(p)).label === m1.label && m3.label !== m1.label, 'Home and End jump to the first and last items');
  await p.keyboard.press('Escape'); await settle(p, 150);
  check((await head.getAttribute('aria-expanded')) === 'false', 'Esc closes the menu and aria-expanded turns false');
  check((await active(p)).cls.includes('server-head'), 'focus returns to the menu button', await active(p));
  await head.press('Enter'); await settle(p, 150);
  await p.keyboard.press('Tab'); await settle(p, 150);
  check(!(await p.locator('.popover').count()), 'Tab closes a menu, like a native one');
  const emo = p.locator('.cw-main button[aria-label="Emoji"]');
  await emo.focus(); await p.keyboard.press('Enter'); await settle(p, 400);
  const pop = await p.evaluate(() => { const x = document.querySelector('.popover'); return x && { role: x.getAttribute('role'), label: x.getAttribute('aria-label'), focusIn: x.contains(document.activeElement) }; });
  check(pop && pop.role === 'dialog' && pop.label === 'Emoji', 'non-menu popups are named dialogs', pop);
  check(pop && pop.focusIn, 'focus moves into the popup', pop);
  await p.keyboard.press('Escape'); await settle(p, 150);
  check((await active(p)).label === 'Emoji', 'Esc returns focus to the button', await active(p));

  section('Messages: keyboard navigation');
  const tabStops = await p.evaluate(() => {
    const list = document.querySelector('#messages');
    const all = [...list.querySelectorAll('a[href], button, input, textarea, select, [tabindex]')].filter((e) => e.tabIndex >= 0 && e.getClientRects().length);
    return { total: all.length, msgs: list.querySelectorAll('.msg[data-mid]').length, current: list.querySelectorAll('.msg[tabindex="0"]').length };
  });
  check(tabStops.current === 1, 'exactly one message is in the Tab order', tabStops);
  check(tabStops.total <= 10, 'Tab doesn’t walk through every message’s toolbar', tabStops);
  await p.focus('#messages .msg[tabindex="0"]');
  const lastId = await p.evaluate(() => document.activeElement.dataset.mid);
  await p.keyboard.press('ArrowUp');
  const prevId = await p.evaluate(() => document.activeElement.dataset.mid);
  check(prevId && prevId !== lastId, 'ArrowUp moves to the previous message', [lastId, prevId]);
  await p.keyboard.press('Tab');
  const tool = await active(p);
  check(tool.tag === 'BUTTON' && (await p.evaluate(() => !!document.activeElement.closest('.msg') && document.activeElement.closest('.msg').dataset.mid)) === prevId, 'Tab from a message reaches its own actions', tool);
  const toolsShown = await p.evaluate(() => getComputedStyle(document.activeElement.closest('.msg').querySelector('.msg-tools')).opacity);
  check(Number(toolsShown) > 0.5, 'the actions toolbar is visible while it has keyboard focus', toolsShown);

  section('Focus is visible');
  await p.focus('#composer-input');
  await p.keyboard.press('Shift+Tab');
  const ring = await p.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), tag: document.activeElement.tagName }; });
  check(ring.style !== 'none' && ring.width >= 2, 'keyboard focus shows a 2px outline', ring);

  section('Skip link');
  await p.reload(); await p.waitForSelector('#app:not([hidden]):not(.loading)'); await settle(p, 500);
  await p.keyboard.press('Tab');
  const skip = await active(p);
  check(/Skip to conversation/.test(skip.label), 'the first Tab stop is "Skip to conversation"', skip);
  await p.keyboard.press('Enter');
  const home = await p.evaluate(() => ({ id: document.activeElement.id, composer: !!document.querySelector('#composer-input') }));
  check(home.id === (home.composer ? 'composer-input' : 'main'), 'with no conversation open, it jumps to the main area', home);
  await p.click('#rail button[aria-label^="Quality checks"]'); await settle(p, 500);
  await p.focus('#rail button[aria-label^="Quality checks"]');
  await p.keyboard.press('Shift+Tab'); await p.keyboard.press('Shift+Tab'); await p.keyboard.press('Shift+Tab');
  await p.keyboard.press('Shift+Tab'); await p.keyboard.press('Shift+Tab');
  const sk2 = await p.evaluate(() => document.activeElement.id);
  if (sk2 !== 'skip-main') await p.focus('#skip-main');
  await p.keyboard.press('Enter');
  check(await p.evaluate(() => document.activeElement.id === 'composer-input'), 'in a channel, it jumps to the message box');

  section('Toasts are announced');
  const live = await p.evaluate(() => { const t = document.getElementById('toasts'); return { live: t.getAttribute('aria-live'), role: t.getAttribute('role') }; });
  check(live.live === 'polite' && live.role === 'status', 'the toast area is a polite live region', live);
  await p.evaluate(async () => { const { toast } = await import('/js/util.js'); toast('Something went wrong', 'error'); toast('Saved'); });
  const roles = await p.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.getAttribute('role')));
  check(roles.includes('alert') && roles.includes(null), 'errors are role=alert, other toasts use the polite region', roles);
  await p.close();

  section('Reduced motion');
  const rm = await H.newPage({ width: 1366, height: 768, reducedMotion: 'reduce' });
  await rm.goto(base); await settle(rm);
  const durReduce = await rm.evaluate(() => { const t = document.createElement('div'); t.className = 'toast'; document.body.append(t); const d = getComputedStyle(t).animationDuration; t.remove(); return parseFloat(d); });
  check(durReduce < 0.01, 'animations are switched off with prefers-reduced-motion', durReduce);
  const full = await H.newPage({ width: 1366, height: 768, reducedMotion: 'no-preference' });
  await full.goto(base); await settle(full);
  const durFull = await full.evaluate(() => { const t = document.createElement('div'); t.className = 'toast'; document.body.append(t); const d = getComputedStyle(t).animationDuration; t.remove(); return parseFloat(d); });
  check(durFull > 0.05, 'and stay on without it', durFull);
  await rm.close(); await full.close();

  // ------------------------------------------------------------------ layout at four sizes
  section('Responsive layout');
  const sizes = [[390, 844, true], [768, 1024, true], [1366, 768, false], [1920, 1080, false]];
  const long = await H.newPage({ width: 1366, height: 768 });
  await signUp(long, base, 'a_very_long_username_xx');
  await createServer(long, 'A server with a rather long name that keeps going and going and going');
  await sendMessage(long, 'https://example.com/' + 'x'.repeat(300));
  await sendMessage(long, 'W'.repeat(400));
  await long.setInputFiles('.cw-main input[type=file]', { name: `a-really-long-file-name-${'z'.repeat(150)}.txt`, mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await settle(long, 300);
  await long.press('#composer-input', 'Enter');
  await long.waitForSelector('#messages .att-file, #messages .attachment, #messages .msg-files', { timeout: 15000 });
  await settle(long, 500);
  for (const [w, hgt] of sizes) {
    await long.setViewportSize({ width: w, height: hgt });
    if (await long.locator('#members:not([hidden])').count() && w < 1241) await long.click('#members button[aria-label^="Close"], #members .icon-btn >> nth=-1').catch(() => {});
    await settle(long, 400);
    const o = await long.evaluate(overflowDom);
    check(o.scrollWidth <= o.clientWidth && !o.offenders.length, `${w}×${hgt}: no horizontal scrolling with long names, URLs and file names`, o);
    const wraps = await long.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll('#messages .msg-text, #messages .msg-files > *, #messages .msg-name')].filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().right)).filter((r) => r > vw + 1);
    });
    check(!wraps.length, `${w}×${hgt}: message text and attachments stay inside the screen`, wraps);
  }
  await long.close();

  section('Phones: everything reachable');
  const ph = await H.newPage({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await ph.goto(base); await settle(ph);
  await ph.fill('#login-form [name=username]', 'alice');
  await ph.fill('#login-form [name=password]', PASSWORD);
  await ph.click('#login-form button[type=submit]');
  await ph.waitForSelector('#app:not([hidden]):not(.loading)', { timeout: 60000 });
  await settle(ph, 500);
  await ph.click('.nav-toggle'); await settle(ph, 400);
  const inView = (sel) => ph.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; }, sel);
  check(await inView('#user-panel button[aria-label="Settings"]'), 'settings button is on screen in the navigation drawer');
  await ph.click('#sidebar-body .ch-row >> nth=0').catch(() => {});
  await ph.click('#rail button[aria-label^="Quality checks"]').catch(() => {});
  await settle(ph, 400);
  if (await ph.locator('body.nav-open').count()) { await ph.click('#sidebar-body .ch-row >> nth=0').catch(() => {}); await settle(ph, 400); }
  if (await ph.locator('body.nav-open').count()) await ph.click('.nav-scrim', { force: true }).catch(() => {});
  await settle(ph, 300);
  check(await inView('#composer-input'), 'the message box is on screen');
  check(await inView('#main-head button[aria-label^="Search"]'), 'search is reachable from the header');
  await ph.click('#main-head button[aria-label^="Search"]'); await settle(ph, 400);
  const so = await ph.evaluate(overflowDom);
  check(so.scrollWidth <= so.clientWidth && await inView('.modal-search input'), 'search opens full screen without sideways scrolling', so);
  await ph.click('.search-close'); await settle(ph, 300);
  await ph.click('.nav-toggle'); await settle(ph, 300);
  await ph.click('#user-panel button[aria-label="Settings"]'); await settle(ph, 500);
  const sto = await ph.evaluate(overflowDom);
  check(sto.scrollWidth <= sto.clientWidth, 'settings fit the screen', sto);
  check(await inView('.set-close'), 'settings can be closed', await inView('.set-close'));
  const closeBg = await ph.evaluate(() => getComputedStyle(document.querySelector('.set-close')).backgroundColor);
  check(!/rgba\(0, 0, 0, 0\)|transparent/.test(closeBg) && !/\/ 0\)|, 0\)$/.test(closeBg), 'the close button has a solid background over the scrolling tabs', closeBg);
  await ph.click('.set-close'); await settle(ph, 400);
  // Call controls in a voice channel.
  if (!(await ph.locator('body.nav-open').count())) await ph.click('.nav-toggle');
  await settle(ph, 300);
  await ph.click('#sidebar-body >> text=Lounge'); await settle(ph, 800);
  if (await ph.locator('body.nav-open').count()) await ph.click('.nav-scrim', { force: true }).catch(() => {});
  await settle(ph, 300);
  const join = ph.locator('.cs-controls .btn.primary');
  if (await join.count()) { await join.click(); await settle(ph, 1500); }
  check(await inView('.cs-controls button[aria-label="Leave call"]') || await inView('.cs-controls .btn.primary'), 'call controls are on screen', await ph.evaluate(() => [...document.querySelectorAll('.cs-controls button')].map((b) => b.getAttribute('aria-label') || b.textContent)));
  const cso = await ph.evaluate(overflowDom);
  check(cso.scrollWidth <= cso.clientWidth, 'the call screen has no sideways scrolling', cso);
  await ph.click('.cs-controls button[aria-label="Leave call"]').catch(() => {});
  await ph.close();

  section('Phones: the on-screen keyboard doesn’t cover the message box');
  // Fake the visual viewport the way iOS Safari reports an open keyboard: the page keeps its size and only
  // visualViewport shrinks.
  const kb = await H.newPage({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await kb.addInitScript(() => {
    const t = new EventTarget();
    Object.assign(t, { height: innerHeight, width: innerWidth, scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { value: t, configurable: true });
    window.__setKeyboard = (px) => { t.height = innerHeight - px; t.dispatchEvent(new Event('resize')); };
  });
  await kb.goto(base); await settle(kb);
  await kb.fill('#login-form [name=username]', 'alice');
  await kb.fill('#login-form [name=password]', PASSWORD);
  await kb.click('#login-form button[type=submit]');
  await kb.waitForSelector('#app:not([hidden]):not(.loading)', { timeout: 60000 });
  await kb.click('.nav-toggle'); await settle(kb, 300);
  await kb.click('#rail button[aria-label^="Quality checks"]').catch(() => {});
  await settle(kb, 300);
  await kb.click('#sidebar-body .ch-row >> nth=0').catch(() => {});
  if (await kb.locator('body.nav-open').count()) await kb.click('.nav-scrim', { force: true }).catch(() => {});
  await kb.waitForSelector('#composer-input');
  await kb.focus('#composer-input');
  await kb.evaluate(() => window.__setKeyboard(340));
  await settle(kb, 300);
  const kbs = await kb.evaluate(() => ({ bottom: Math.round(document.querySelector('.composer').getBoundingClientRect().bottom), visible: window.visualViewport.height, cls: document.documentElement.classList.contains('kb-open') }));
  check(kbs.cls && kbs.bottom <= kbs.visible + 1, 'with the keyboard up, the message box sits above it', kbs);
  await kb.evaluate(() => window.__setKeyboard(0));
  await settle(kb, 300);
  const kbo = await kb.evaluate(() => ({ bottom: Math.round(document.querySelector('.composer').getBoundingClientRect().bottom), h: innerHeight, cls: document.documentElement.classList.contains('kb-open') }));
  check(!kbo.cls && kbo.bottom > kbo.h - 120, 'with it down again, the app fills the screen', kbo);
  await kb.close();

  check(!H.errors.length, 'no script errors on any page', H.errors.slice(0, 5));
} catch (e) {
  check(false, 'the suite ran to the end', e.stack || String(e));
} finally {
  await H.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
