// Drives the real desktop app in Electron for client-hardening.test.js: `electron -r test/desktop-harness.js <copy
// of desktop/>`. This file runs first, then main.js. A fake Hearth server whose page is hostile (it refuses to be
// unloaded, then keeps its main thread busy) checks that an old-style desktop capture ends after the person's
// pick, that normal screen sharing carries on, and that a start page redirecting elsewhere doesn't leave an empty
// window. Prints one line: RESULT {...}.
const http = require('http');
const { app, shell, dialog, BrowserWindow } = require('electron');

app.setPath('userData', process.env.HEARTH_UD);
const opened = [];
shell.openExternal = async (u) => { opened.push(u); };
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
// Never hang the test run: whatever happened so far, reported as a failure.
setTimeout(() => { console.log(`RESULT ${JSON.stringify({ ...out, error: 'timed out' })}`); app.exit(1); }, 100000);
// A call into a page that's busy or gone never answers: give each try a second.
async function until(fn, ms = 15000) {
  const t = Date.now();
  for (;;) {
    try { const v = await Promise.race([fn(), sleep(1000).then(() => null)]); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t > ms) return null;
    await sleep(150);
  }
}

const PAGE = `<!doctype html><title>Fake Hearth</title><body><h1>Hearth</h1><script>
addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'stay'; return 'stay'; });
window.beat = () => { const t = window.cap && window.cap.getVideoTracks()[0]; if (t && t.readyState === 'live') navigator.sendBeacon('/beat', '1'); };
</script></body>`;
let redirect = false;
let loads = 0;
const beats = [];
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/config') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"name":"Fake Hearth"}'); }
  if (url === '/beat') { beats.push(Date.now()); res.writeHead(204); return res.end(); }
  if (redirect) { res.writeHead(302, { location: 'http://sso.example.invalid/login' }); return res.end(); }
  loads++;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});

(async () => {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const main = () => BrowserWindow.getAllWindows().find((x) => !x.getParentWindow());
  const pickerWin = () => BrowserWindow.getAllWindows().find((x) => x.getParentWindow() && x.isVisible());
  const js = (w, code) => w.webContents.executeJavaScript(code, true);
  const pick = async () => {
    const p = await until(pickerWin, 15000);
    if (!p) return false;
    await js(p, "document.querySelector('button.src').click(); document.getElementById('share').click(); 1");
    return true;
  };

  await until(() => main() && main().webContents.getURL().startsWith('file:'), 20000);
  const w = main();
  out.connect = !!(await js(w, `window.hearthDesktop.connect(${JSON.stringify(origin)})`)).ok;
  out.onServer = !!(await until(() => w.webContents.getURL() === `${origin}/`));

  // 1. Screen sharing the normal way (getDisplayMedia): the person picks, the page carries on sharing
  await js(w, 'document.body.click(); window.marker = 1; 1');
  const gdm = js(w, 'navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => { window.cap = s; return "shared"; }, (e) => "refused:" + e.name)').catch(() => 'error');
  out.gdmPicker = await pick();
  out.gdm = await Promise.race([gdm, sleep(15000).then(() => 'timeout')]);
  await sleep(4500);
  out.gdmAfter = await until(() => js(w, 'window.marker === 1 ? "same page, " + window.cap.getVideoTracks()[0].readyState : "reloaded"'), 5000);
  await js(w, 'window.cap.getTracks().forEach((t) => t.stop()); 1').catch(() => {});

  // 2. The old getUserMedia desktop capture, from a page that refuses to unload, then busy-loops (still reporting)
  const loadsBefore = loads;
  await js(w, 'document.body.click(); 1');
  const legacy = js(w, `navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop' } } }).then((s) => {
    window.cap = s; setInterval(window.beat, 200);
    setTimeout(() => { const end = Date.now() + 20000; let last = 0; while (Date.now() < end) if (Date.now() - last > 250) { last = Date.now(); window.beat(); } }, 500);
    return 'captured';
  }, (e) => 'refused:' + e.name)`).catch(() => 'error');
  out.legacyPicker = await pick();
  out.legacy = await Promise.race([legacy, sleep(15000).then(() => 'timeout')]);
  const picked = Date.now();
  await sleep(7000);
  out.legacyReloaded = loads > loadsBefore;
  out.lastBeatMs = beats.length ? beats[beats.length - 1] - picked : null;
  out.legacyAfter = await until(() => js(w, 'window.marker === 1 ? "same page" : "fresh page"'), 8000);

  // 3. "Change server…" from a page that refuses to unload, then a start page that redirects to another site
  await until(() => js(w, 'document.body.click(); 1'), 5000);
  await js(w, 'window.hearthDesktop.changeServer(); 1').catch(() => {});
  out.changeServer = !!(await until(() => w.webContents.getURL().startsWith('file:'), 8000));
  redirect = true;
  const openedBefore = opened.length;
  await js(w, `window.hearthDesktop.connect(${JSON.stringify(origin)})`).catch(() => {});
  out.redirectError = await until(() => (w.webContents.getURL().includes('error=') ? js(w, "document.getElementById('err').textContent") : null), 10000);
  out.redirectOpened = opened.slice(openedBefore);

  console.log(`RESULT ${JSON.stringify(out)}`);
  app.exit(0);
})().catch((e) => { console.log(`RESULT ${JSON.stringify({ ...out, error: String((e && e.stack) || e) })}`); app.exit(1); });
