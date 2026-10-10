// Hearth desktop: a secure window onto your Hearth server, with tray, badge, notifications and auto-start.
// All chat code (including end-to-end encryption) runs from your server exactly as in the browser.
const {
  app, BrowserWindow, Menu, Tray, shell, session, ipcMain, nativeImage, dialog, net, desktopCapturer, powerMonitor,
  screen, clipboard, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const CONFIG = require('./hearth.config.json');

const APP_NAME = CONFIG.appName || 'Hearth';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch { /* first run */ }
let saveTimer = null;
const writeSettings = () => { clearTimeout(saveTimer); saveTimer = null; try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* ignore */ } };
// Window moves fire many times a second: write at most twice a second (and always on quit).
const saveSettings = (soon) => { if (soon) { if (!saveTimer) saveTimer = setTimeout(writeSettings, 500); } else writeSettings(); };

// Hardware acceleration can only be switched off before the app is ready (Settings → Apps & devices,
// for the rare graphics driver that shows a black or flickering window). Takes effect after a restart.
const HW_ACCEL_AT_START = settings.hardwareAcceleration !== false;
if (!HW_ACCEL_AT_START) app.disableHardwareAcceleration();

let win = null;
let tray = null;
let quitting = false;
let unread = 0;

// Which pages are "ours": exact origin / exact file comparisons (origin.js), never "starts with".
const { normalize, isServerUrl, isAppFile, isHttpsUpgrade } = require('./origin');
const CONNECT_FILE = path.join(__dirname, 'connect.html');
const PICKER_FILE = path.join(__dirname, 'picker.html');
const serverOrigin = () => normalize((CONFIG.lockServer ? CONFIG.defaultServer : settings.server || CONFIG.defaultServer) || '') || null;
const isServer = (url) => isServerUrl(url, serverOrigin());
const isConnectScreen = (url) => isAppFile(url, CONNECT_FILE);
const onServerPage = () => !!(win && !win.isDestroyed() && isServer(win.webContents.getURL()));

// ---------------------------------------------------------------- desktop settings (Settings → Apps & devices)
const CAN_START_AT_LOGIN = IS_WIN || IS_MAC; // Linux desktops each do this differently
const closeToTray = () => !IS_MAC && (settings.closeToTray ?? CONFIG.closeToTray ?? true);
const startHidden = () => !settings.startVisible; // stored the old way so existing choices carry over
const spellcheckOn = () => settings.spellcheck !== false;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const clampZoom = (z) => { z = Number(z); return Number.isFinite(z) ? Math.min(2, Math.max(0.5, Math.round(z * 100) / 100)) : 1; };
const zoom = () => clampZoom(settings.zoom ?? 1);

function startAtLogin() {
  if (!CAN_START_AT_LOGIN) return false;
  try {
    // Windows only reports "on" when the arguments match the ones it was turned on with.
    return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin || app.getLoginItemSettings({ args: [] }).openAtLogin;
  } catch { return false; }
}
function applyLoginItem(on) {
  if (!CAN_START_AT_LOGIN) return;
  try { app.setLoginItemSettings({ openAtLogin: !!on, args: startHidden() ? ['--hidden'] : [] }); } catch { /* not allowed here */ }
}

function desktopSettings() {
  return {
    startAtLogin: startAtLogin(),
    startHidden: startHidden(),
    closeToTray: closeToTray(),
    hardwareAcceleration: settings.hardwareAcceleration !== false,
    hardwareAccelerationActive: HW_ACCEL_AT_START, // what this run uses; a change applies after a restart
    zoom: zoom(),
    spellcheck: spellcheckOn(),
    server: serverOrigin(),
    serverLocked: !!CONFIG.lockServer,
    version: app.getVersion(),
    updateReady,
    updatesSigned: !!UPDATE_KEY, // this build only installs updates signed by its publisher
    platform: process.platform,
    supports: { startAtLogin: CAN_START_AT_LOGIN, closeToTray: !IS_MAC, updates: updatesSupported() },
  };
}
const settingsChanged = () => { refreshTrayMenu(); sendToPage('desktop-settings', desktopSettings()); };

// Every change goes through here (from the page, the tray menu or a shortcut), so they all stay in step.
function setDesktopSetting(key, value) {
  const bool = typeof value === 'boolean';
  switch (key) {
    case 'startAtLogin':
      if (!bool) return { ok: false, error: 'Expected on or off.' };
      if (!CAN_START_AT_LOGIN) return { ok: false, error: 'Not available on this system.' };
      applyLoginItem(value);
      break;
    case 'startHidden':
      if (!bool) return { ok: false, error: 'Expected on or off.' };
      settings.startVisible = !value; saveSettings();
      if (startAtLogin()) applyLoginItem(true); // re-register with the new arguments
      break;
    case 'closeToTray':
      if (!bool) return { ok: false, error: 'Expected on or off.' };
      if (IS_MAC) return { ok: false, error: 'Not available on this system.' };
      settings.closeToTray = value; saveSettings();
      break;
    case 'hardwareAcceleration':
      if (!bool) return { ok: false, error: 'Expected on or off.' };
      settings.hardwareAcceleration = value; saveSettings();
      settingsChanged();
      return { ok: true, restartNeeded: value !== HW_ACCEL_AT_START, settings: desktopSettings() };
    case 'spellcheck':
      if (!bool) return { ok: false, error: 'Expected on or off.' };
      settings.spellcheck = value; saveSettings();
      try { session.defaultSession.setSpellCheckerEnabled(value); } catch { /* ignore */ }
      break;
    case 'zoom':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'Expected a number.' };
      settings.zoom = clampZoom(value); saveSettings();
      applyZoom();
      break;
    default:
      return { ok: false, error: 'Unknown setting.' };
  }
  settingsChanged();
  return { ok: true, settings: desktopSettings() };
}

function applyZoom() { if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoom()); }
function stepZoom(dir) {
  const z = zoom();
  const next = dir > 0 ? (ZOOM_STEPS.find((s) => s > z + 0.001) ?? 2) : ([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? 0.5);
  setDesktopSetting('zoom', next);
}
function openSettings() {
  showWindow();
  if (onServerPage()) sendToPage('open-settings');
}
function restartApp() {
  quitting = true;
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden' && !a.startsWith(`${PROTOCOL}://`)) });
  app.quit();
}

// ---------------------------------------------------------------- single instance
if (!app.requestSingleInstanceLock()) app.quit();
// hearth:// links (e.g. hearth://invite/abcd2345 from the browser) open here. Windows and Linux pass them on
// the command line; macOS sends open-url.
const PROTOCOL = 'hearth';
if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(PROTOCOL);
let pendingLink = (process.argv.find((a) => a.startsWith(`${PROTOCOL}://`)) || '');
function openLink(raw) {
  let u;
  try { u = new URL(raw); } catch { return; }
  if (u.protocol !== `${PROTOCOL}:`) return;
  const origin = serverOrigin();
  const parts = `${u.hostname}${u.pathname}`.split('/').filter(Boolean);
  showWindow();
  if (!origin || !win) { pendingLink = raw; return; }
  if (parts[0] === 'invite' && /^[A-Za-z0-9_-]{2,64}$/.test(parts[1] || '')) win.loadURL(`${origin}/invite/${parts[1]}`);
}
app.on('second-instance', (e, argv) => {
  const link = (argv || []).find((a) => a.startsWith(`${PROTOCOL}://`));
  if (link) openLink(link); else showWindow();
});
app.on('open-url', (e, url) => { e.preventDefault(); if (app.isReady()) openLink(url); else pendingLink = url; });
app.setAppUserModelId(CONFIG.appId || 'app.hearth.desktop');

// ---------------------------------------------------------------- window
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The saved position, if its title bar is still on a connected screen; otherwise (a monitor was
// unplugged, or the resolution changed) a normal-sized window in the middle of the main screen.
const DEFAULT_SIZE = { width: 1280, height: 820 };
function onScreen(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  for (const d of screen.getAllDisplays()) {
    const a = d.workArea;
    const across = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const down = Math.min(b.y + 40, a.y + a.height) - Math.max(b.y, a.y); // the title bar
    if (across >= 120 && down >= 20) return { ...b, width: Math.min(b.width, a.width), height: Math.min(b.height, a.height) };
  }
  return null;
}
function centeredOnPrimary(size = DEFAULT_SIZE) {
  const a = screen.getPrimaryDisplay().workArea;
  const width = Math.min(size.width || DEFAULT_SIZE.width, a.width);
  const height = Math.min(size.height || DEFAULT_SIZE.height, a.height);
  return { width, height, x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2) };
}
function keepOnScreen() {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  if (!onScreen(win.getBounds())) win.setBounds(centeredOnPrimary(win.getBounds()));
}

function createWindow() {
  const saved = settings.bounds || null;
  const b = onScreen(saved) || centeredOnPrimary(saved || DEFAULT_SIZE);
  win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    minWidth: 900, minHeight: 580, show: false, title: APP_NAME,
    backgroundColor: '#100e16', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true,
      spellcheck: spellcheckOn(), zoomFactor: zoom(),
    },
  });
  if (settings.maximized) win.maximize();
  const openedAtLogin = IS_MAC && startHidden() && (() => { try { return app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; } })();
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden') && !openedAtLogin) win.show(); });

  const remember = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized) settings.bounds = win.getBounds();
    saveSettings(true);
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    remember();
    if (!quitting && (closeToTray() || IS_MAC)) {
      e.preventDefault();
      win.hide();
      if (!IS_MAC) trayHintOnce();
    }
  });
  win.on('closed', () => { win = null; });
  // A page can't stop the app from leaving it ("Leave site?" / beforeunload): the reload that ends an
  // old-style screen capture (chooseScreen) must happen, and so must closing, quitting and changing server.
  // Hearth's own pages never ask.
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  // A reload or a new page starts outside any call until the page says otherwise. The server being down
  // behind a proxy (Caddy answers 502 while Hearth restarts) gets the "can't reach" screen too.
  win.webContents.on('did-navigate', (e, url, code) => {
    call = { inCall: false, muted: false, deafened: false }; drawThumbar();
    applyZoom();
    if (isServer(url) && [502, 503, 504, 520, 521, 522, 523, 524].includes(code)) loadOffline(`HTTP_${code}`);
  });

  // Links to other sites open in the normal browser, never inside the app (which has no address bar, and
  // whose bridge only your server's pages may use). Same for a redirect away from your server.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const elsewhere = (e, url) => {
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', (e, url) => {
    if (isServer(url) || isConnectScreen(url)) return;
    elsewhere(e, url);
  });
  win.webContents.on('will-redirect', (e, legacyUrl, legacyInPlace, legacyMainFrame) => {
    const url = (e && e.url) || legacyUrl;
    const mainFrame = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : legacyMainFrame;
    if (!mainFrame || isServer(url) || isHttpsUpgrade(url, serverOrigin())) return;
    elsewhere(e, url);
    // Nothing of the server's was showing yet (the app starting, Retry, Connect): without this the window
    // would stay empty. The connect screen says what happened, so the person can try again or switch servers.
    setImmediate(() => { if (win && !win.isDestroyed() && !onServerPage()) loadConnect(redirectedAway(url)); });
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3: the load was replaced by another one
    // Certificate problems keep the old screen: the certificate prompt (below) takes it from there.
    if (code <= -200 && code > -300) loadConnect(`Couldn't reach ${url} (${desc}). Check the address and your connection.`);
    else loadOffline(desc);
  });

  // Right-click menu, zoom keys / Ctrl+wheel, Ctrl+, for Settings.
  win.webContents.on('context-menu', (e, params) => {
    const menu = contextMenu(win.webContents, params);
    if (menu) menu.popup({ window: win, frame: params.frame || undefined });
  });
  win.webContents.on('zoom-changed', (e, dir) => stepZoom(dir === 'in' ? 1 : -1));
  win.webContents.on('before-input-event', (e, input) => {
    if (IS_MAC || input.type !== 'keyDown' || !input.control || input.alt || input.meta) return; // macOS: the menu handles these
    const k = input.key;
    if (k === ',') { e.preventDefault(); openSettings(); }
    else if (k === '=' || k === '+' || input.code === 'NumpadAdd') { e.preventDefault(); stepZoom(1); }
    else if (k === '-' || k === '_' || input.code === 'NumpadSubtract') { e.preventDefault(); stepZoom(-1); }
    else if ((k === '0' || input.code === 'Numpad0') && !input.shift) { e.preventDefault(); setDesktopSetting('zoom', 1); }
  });

  load();
}

function load() {
  const origin = serverOrigin();
  if (origin) win.loadURL(origin + '/');
  else loadConnect();
}
function connectQuery(extra) {
  return { locked: CONFIG.lockServer ? '1' : '', name: APP_NAME, server: serverOrigin() || '', ...extra };
}
function loadConnect(error = '') {
  win.loadFile(path.join(__dirname, 'connect.html'), { query: connectQuery({ error }) });
}
// What the connect screen says when the server sent the app somewhere else (a sign-in page in front of it, say).
function redirectedAway(url) {
  let host = '';
  try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) host = u.host; } catch { /* not a web address */ }
  return host
    ? `Your server sent the app on to ${host}, which was opened in your browser instead. The app only shows your Hearth server’s own pages.`
    : 'Your server sent the app to an address it can’t open. The app only shows your Hearth server’s own pages.';
}
// The server didn't answer: a friendly screen that keeps trying and comes back by itself.
function loadOffline(reason = '') {
  if (!win || win.isDestroyed()) return;
  if (!serverOrigin()) return loadConnect(reason);
  win.loadFile(path.join(__dirname, 'connect.html'), { query: connectQuery({ offline: '1', reason }) });
}

// ---------------------------------------------------------------- right-click menu
const short = (s, n = 28) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const copyText = (t) => { try { Promise.resolve(clipboard.writeText(String(t))).catch(() => {}); } catch { /* ignore */ } };
function contextMenu(wc, p) {
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
  const f = p.editFlags || {};

  // Spelling: suggestions for the word under the mouse, and "Add to dictionary".
  if (p.isEditable && p.misspelledWord) {
    const sugg = (p.dictionarySuggestions || []).slice(0, 6);
    for (const s of sugg) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!sugg.length) items.push({ label: 'No spelling suggestions', enabled: false });
    items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    sep();
  }

  const link = p.linkURL && /^(https?|mailto):/i.test(p.linkURL) ? p.linkURL : '';
  if (link) {
    if (/^https?:/i.test(link)) items.push({ label: 'Open link in browser', click: () => shell.openExternal(link) });
    items.push({ label: /^mailto:/i.test(link) ? 'Copy email address' : 'Copy link', click: () => copyText(link.replace(/^mailto:/i, '')) });
    sep();
  }

  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
    if (/^(https?|blob|data):/i.test(p.srcURL)) items.push({ label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) });
    if (/^https?:/i.test(p.srcURL)) items.push({ label: 'Copy image address', click: () => copyText(p.srcURL) });
    sep();
  }

  if (p.isEditable) {
    items.push(
      { role: 'undo', label: 'Undo', enabled: f.canUndo !== false },
      { role: 'redo', label: 'Redo', enabled: f.canRedo !== false },
      { type: 'separator' },
      { role: 'cut', label: 'Cut', enabled: !!f.canCut },
      { role: 'copy', label: 'Copy', enabled: !!f.canCopy },
      { role: 'paste', label: 'Paste', enabled: f.canPaste !== false },
      { role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: f.canPaste !== false },
      { role: 'selectAll', label: 'Select all', enabled: f.canSelectAll !== false },
    );
  } else if (p.selectionText && p.selectionText.trim()) {
    items.push({ role: 'copy', label: 'Copy', enabled: f.canCopy !== false });
  }
  const sel = (p.selectionText || '').trim();
  if (sel && !/^\s*$/.test(sel)) {
    sep();
    items.push({ label: `Search the web for “${short(sel)}”`, click: () => shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(sel.slice(0, 500))}`) });
  }
  if (!app.isPackaged) { sep(); items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) }); }

  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  return items.length ? Menu.buildFromTemplate(items) : null;
}

// ---------------------------------------------------------------- security: permissions + certificates
// Microphone, camera and reading the clipboard: the person says yes once per server in a native dialog (as a
// browser would ask), never the page by itself. See permissions.js for what's allowed without asking.
const consent = require('./permissions');
const deniedThisRun = new Set(); // "origin|kind" the person said no to: not asked again until the app restarts
const asking = new Map(); // one dialog at a time per question, however often the page asks
const granted = (origin) => (origin && settings.permissions && settings.permissions[origin]) || {};
function askConsent(origin, kinds) {
  if (kinds.some((k) => deniedThisRun.has(`${origin}|${k}`))) return Promise.resolve(false);
  const key = `${origin}|${kinds.join(',')}`;
  if (!asking.has(key)) {
    asking.set(key, (async () => {
      if (!win || win.isDestroyed()) return false;
      const host = (() => { try { return new URL(origin).host; } catch { return origin; } })();
      const { response, checkboxChecked } = await dialog.showMessageBox(win, consent.prompt(kinds, host));
      if (response !== 1) { kinds.forEach((k) => deniedThisRun.add(`${origin}|${k}`)); return false; }
      if (checkboxChecked) {
        settings.permissions = { ...(settings.permissions || {}), [origin]: { ...granted(origin), ...Object.fromEntries(kinds.map((k) => [k, true])) } };
        saveSettings();
      }
      return true;
    })().catch(() => false).finally(() => asking.delete(key)));
  }
  return asking.get(key);
}
function resetPermissions() {
  delete settings.permissions;
  deniedThisRun.clear();
  saveSettings();
}

// Screen sharing. Electron asks one "media" permission with no device named for getDisplayMedia() *and* for
// the old getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop' } } }), which captures the whole
// desktop at once, without the display-media handler. So the person picks what to share right at that
// permission (the picker below); getDisplayMedia then carries on into the display-media handler, which shares
// exactly that choice. If that handler doesn't follow within a few seconds, it was the old kind of request,
// which Hearth never makes: the page's renderer is stopped and the page loaded again, which ends that capture.
let pendingShare = null; // { origin, source, at }: the person's choice, waiting for the display-media handler
const SHARE_HANDOFF_MS = 3000;
// Stopping the renderer process (rather than asking the page to reload) means nothing the page runs can keep
// the capture going: not a "Leave site?" handler, a busy loop or a worker. Once it's gone, the page loads
// again in a new one (a reload sent any sooner is lost with the old process).
function restartPage() {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  const again = () => setImmediate(() => { if (!wc.isDestroyed()) wc.reload(); });
  wc.once('render-process-gone', again);
  try { wc.forcefullyCrashRenderer(); } catch { wc.removeListener('render-process-gone', again); wc.reload(); }
}
async function chooseScreen(origin) {
  if (pendingShare && Date.now() - pendingShare.at < SHARE_HANDOFF_MS) return false; // one share at a time
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  const id = await pickSource(sources.map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL() })), { host: new URL(origin).host, audio: IS_WIN });
  const source = id && sources.find((s) => s.id === id);
  if (!source || serverOrigin() !== origin) return false;
  const mine = { origin, source, at: Date.now() };
  pendingShare = mine;
  setTimeout(() => {
    if (pendingShare !== mine) return; // taken by the display-media handler, as it should be
    pendingShare = null;
    if (win && !win.isDestroyed() && isServer(win.webContents.getURL())) restartPage();
  }, SHARE_HANDOFF_MS);
  return true;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details = {}) => {
    const origin = serverOrigin();
    const fromServer = !!(win && !win.isDestroyed() && wc && wc.id === win.webContents.id) && isServerUrl(details.requestingUrl || wc.getURL(), origin);
    const d = consent.decide(perm, details, { fromServer, granted: granted(origin) });
    if (d.result === 'screen') return chooseScreen(origin).then((yes) => cb(!!yes), () => cb(false));
    if (d.result !== 'ask') return cb(d.result === 'allow');
    askConsent(origin, d.kinds).then((yes) => cb(!!yes), () => cb(false));
  });
  // Checks (navigator.permissions, device names) answer "yes" only for what the person already allowed.
  session.defaultSession.setPermissionCheckHandler((wc, perm, requestingOrigin, details = {}) => {
    const origin = serverOrigin();
    return consent.decide(perm, details, { fromServer: isServerUrl(requestingOrigin, origin), granted: granted(origin) }).result === 'allow';
  });
  try { session.defaultSession.setSpellCheckerEnabled(spellcheckOn()); } catch { /* ignore */ }

  // Screen sharing: Electron has no built-in picker, so the app shows its own (picker.html, a local window
  // the server's page can't see or script; see chooseScreen above), on every system: macOS's own picker
  // would come after the app's and skip this handler. The server's page only asks to share: it never gets
  // the list of windows or their previews, and nothing is shared until the person picks. getDisplayMedia
  // shares exactly that pick; the old getUserMedia desktop capture (which Hearth never uses) gets the whole
  // screen, but only until chooseScreen stops the page, about 3 seconds later. On Windows the computer's
  // audio can be shared too.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // The callback may be called once; null means "no" (an empty object throws in current Electron).
    let answered = false;
    const answer = (streams) => { if (answered) return; answered = true; try { callback(streams); } catch { /* the page gets an error */ } };
    try {
      const origin = serverOrigin();
      const choice = pendingShare;
      pendingShare = null;
      if (!origin || !isServerUrl(request.securityOrigin, origin)) return answer(null);
      if (!choice || choice.origin !== origin || Date.now() - choice.at > SHARE_HANDOFF_MS) return answer(null);
      answer({ video: choice.source, audio: IS_WIN && request.audioRequested ? 'loopback' : undefined });
    } catch { answer(null); }
  });
});
// Opens the picker over the main window; resolves to the chosen source id, or null (cancelled, closed,
// or two minutes without an answer).
let picker = null;
function pickSource(list, { host, audio }) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed() || picker) return resolve(null);
    const p = new BrowserWindow({
      parent: win, modal: true, width: 760, height: 560, minWidth: 480, minHeight: 360, show: false,
      title: 'Choose what to share', backgroundColor: '#100e16', autoHideMenuBar: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
    });
    picker = p;
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      ipcMain.removeListener('picker:choose', onChoose);
      picker = null;
      if (!p.isDestroyed()) p.destroy();
      resolve(id);
    };
    // Only this window's own page answers, and only with an id that was on the list.
    const onChoose = (e, id) => {
      if (p.isDestroyed() || e.sender !== p.webContents || !e.senderFrame || !isAppFile(e.senderFrame.url, PICKER_FILE)) return;
      finish(typeof id === 'string' && list.some((s) => s.id === id) ? id : null);
    };
    const t = setTimeout(() => finish(null), 120000);
    ipcMain.on('picker:choose', onChoose);
    p.on('closed', () => finish(null));
    p.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    p.webContents.on('will-navigate', (e) => e.preventDefault());
    p.webContents.once('did-finish-load', () => {
      if (p.isDestroyed()) return;
      p.webContents.send('picker:sources', { host, audio, sources: list });
      p.show();
    });
    p.loadFile(PICKER_FILE).catch(() => finish(null));
  });
}

// Self-signed certificates: trusted only for hosts listed in hearth.config.json, or after the user
// explicitly accepts that exact certificate fingerprint (remembered, and re-asked if it ever changes).
app.on('certificate-error', async (event, wc, url, error, cert, callback) => {
  const host = new URL(url).host;
  const trusted = settings.trustedCerts || {};
  if ((CONFIG.trustedSelfSignedHosts || []).includes(host) || trusted[host] === cert.fingerprint) {
    event.preventDefault();
    return callback(true);
  }
  callback(false);
  if (!win || new URL(url).origin !== serverOrigin()) return;
  const changed = !!trusted[host];
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Trust this certificate'],
    defaultId: 0, cancelId: 0,
    title: changed ? 'Certificate changed' : 'Unverified certificate',
    message: changed ? `The security certificate for ${host} has changed.` : `${host} uses a certificate that isn't signed by a trusted authority.`,
    detail: `${changed ? 'This can mean someone is intercepting your connection. ' : 'That is normal for a self-hosted server without a domain. '}Only continue if the server owner confirms this fingerprint:\n\n${cert.fingerprint}`,
  });
  if (response === 1) {
    settings.trustedCerts = { ...trusted, [host]: cert.fingerprint };
    saveSettings();
    load();
  }
});

// ---------------------------------------------------------------- unread badge
const buildImage = (name) => nativeImage.createFromPath(path.join(__dirname, 'build', `${name}.png`));
function redDot(count) { return buildImage(`badge-${count > 9 ? '9plus' : count}`); }
function setBadge(n) {
  unread = Math.max(0, Math.floor(n) || 0);
  if (IS_WIN && win) win.setOverlayIcon(unread ? redDot(unread) : null, unread ? `${unread} unread` : '');
  else app.setBadgeCount(unread);
  if (tray) tray.setToolTip(unread ? `${APP_NAME} — ${unread} unread` : APP_NAME);
  if (unread && win && !win.isFocused()) win.flashFrame(true);
}

// ---------------------------------------------------------------- calls: taskbar buttons + global keys
// While you're in a call, the taskbar preview (hover Hearth's taskbar button) gets Mute and Deafen buttons.
let call = { inCall: false, muted: false, deafened: false };
function drawThumbar() {
  if (!IS_WIN || !win) return;
  if (!call.inCall) { win.setThumbarButtons([]); return; }
  win.setThumbarButtons([
    { tooltip: call.muted ? 'Unmute' : 'Mute', icon: buildImage(call.muted ? 'thumb-mic-off' : 'thumb-mic'), click: () => sendToPage('hotkey', { action: 'mute' }) },
    { tooltip: call.deafened ? 'Undeafen' : 'Deafen', icon: buildImage(call.deafened ? 'thumb-deafen-off' : 'thumb-deafen'), click: () => sendToPage('hotkey', { action: 'deafen' }) },
  ]);
}
const sendToPage = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
const hotkeys = require('./hotkeys');

// ---------------------------------------------------------------- updates
// The app updates itself from your own Hearth server (data/downloads, filled by GitHub Actions or by hand):
// it downloads in the background, then asks before installing (a native dialog; never silently on quit).
// Builds made with a signing key only install updates signed by their publisher (update-verify.js), so
// whoever controls a server's downloads folder can't get their own program run on your computer.
// Mac builds need code signing for this, so Mac skips it.
const UPDATES = require('./update-verify');
const UPDATE_KEY = typeof CONFIG.updatePublicKey === 'string' ? CONFIG.updatePublicKey.trim() : '';
let updateReady = null;
let readyUpdate = null; // { version, file, verified, hashes } once a download has passed the checks
let updateFeed = null; // where the updater was pointed (…/updates/)
let updater = null;
let updateState = { state: 'idle' };
const updatesSupported = () => app.isPackaged && CONFIG.autoUpdate !== false && !IS_MAC;
function setUpdateState(s) { updateState = s; sendToPage('update-state', s); }
function getUpdater() {
  if (updater || !updatesSupported()) return updater;
  try { updater = require('electron-updater').autoUpdater; } catch { return null; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false; // installing always waits for the person's yes (installUpdate)
  updater.on('checking-for-update', () => setUpdateState({ state: 'checking' }));
  updater.on('update-available', (info) => setUpdateState({ state: 'downloading', version: info.version, percent: 0 }));
  updater.on('download-progress', (p) => setUpdateState({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent || 0) }));
  updater.on('update-not-available', () => setUpdateState({ state: 'none', version: app.getVersion() }));
  updater.on('update-downloaded', (info) => {
    vetUpdate(info).then((r) => {
      if (!r.ok) {
        updateReady = null; readyUpdate = null;
        setUpdateState({ state: 'error', message: r.error });
        settingsChanged();
        return;
      }
      readyUpdate = r;
      updateReady = info.version;
      setUpdateState({ state: 'ready', version: info.version, verified: r.verified });
      sendToPage('update-ready', { version: info.version });
      settingsChanged();
    });
  });
  // No update published yet, or offline: try again later.
  updater.on('error', (err) => setUpdateState({ state: 'error', message: friendlyUpdateError(err) }));
  return updater;
}
function friendlyUpdateError(err) {
  const m = String((err && err.message) || err || '');
  if (/404|latest\.yml|Cannot find/i.test(m)) return 'Your server doesn’t offer app updates yet.';
  if (/not signed by the application owner|publisherName|signature/i.test(m)) return 'The update isn’t signed by the same publisher as this app, so it wasn’t installed.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|net::/i.test(m)) return 'Couldn’t reach your server.';
  return 'Couldn’t check for updates right now.';
}
async function checkForUpdates() {
  if (updateReady) return { state: 'ready', version: updateReady };
  if (!updatesSupported()) {
    return { state: 'unavailable', message: !app.isPackaged ? 'Updates work in the installed app.' : IS_MAC ? 'Download new versions from your server’s /download page.' : 'Automatic updates are turned off in this build.' };
  }
  const origin = serverOrigin();
  const au = getUpdater();
  if (!origin || !au) return { state: 'unavailable', message: 'Connect to a server first.' };
  if (updateState.state === 'checking' || updateState.state === 'downloading') return updateState;
  try {
    updateFeed = `${origin}/updates/`;
    au.setFeedURL({ provider: 'generic', url: updateFeed });
    const r = await au.checkForUpdates();
    if (r && r.isUpdateAvailable) return { state: 'downloading', version: r.updateInfo.version, percent: 0 };
    return { state: 'none', version: app.getVersion() };
  } catch (err) {
    return { state: 'error', message: friendlyUpdateError(err) };
  }
}
function setupUpdates() {
  if (!updatesSupported()) return;
  setTimeout(() => checkForUpdates().catch(() => {}), 15000);
  setInterval(() => checkForUpdates().catch(() => {}), 4 * 3600000);
}
// The file that quitAndInstall would run.
const installerFile = (info) => (updater && updater.installerPath) || (info && (info.downloadedFile || info.file)) || null;
async function fetchUpdateFile(name) {
  const res = await net.fetch(updateFeed + name, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
// A finished download: with a signing key, its signed details and its SHA-512 must check out; without one,
// it's marked unverified (and the install dialog says so).
async function vetUpdate(info) {
  const file = installerFile(info);
  if (!info || !file) return { ok: false, error: 'The update didn’t finish downloading. Hearth will try again later.' };
  if (!UPDATE_KEY) return { ok: true, verified: false, version: info.version, file };
  try {
    if (!updateFeed) return { ok: false, error: 'Couldn’t check the update’s signature right now.' };
    // Never a "web installer" with a separate package: Hearth's releases don't use one.
    if (updater && updater.downloadedUpdateHelper && updater.downloadedUpdateHelper.packageFile) return { ok: false, error: UPDATES.NOT_SIGNED_FILE };
    const name = UPDATES.channelFile(process.platform, process.arch);
    const [yml, sig] = await Promise.all([fetchUpdateFile(name), fetchUpdateFile(`${name}.sig`)]);
    const feed = UPDATES.verifyFeed({ name, yml, sig: sig && sig.toString('utf8'), publicKey: UPDATE_KEY, version: info.version, currentVersion: app.getVersion() });
    if (!feed.ok) return feed;
    if (!UPDATES.fileMatches(await UPDATES.sha512File(file), feed.hashes)) return { ok: false, error: UPDATES.NOT_SIGNED_FILE };
    return { ok: true, verified: true, version: info.version, file, hashes: feed.hashes };
  } catch {
    return { ok: false, error: 'Couldn’t check the update’s signature right now. Hearth will try again later.' };
  }
}
// "Restart to update" (Settings, the tray, the page's banner): checks the file once more, then asks.
let installing = false;
async function installUpdate() {
  if (!updateReady || !readyUpdate || installing) return;
  installing = true;
  try {
    const file = installerFile(readyUpdate);
    let ok = file === readyUpdate.file;
    if (ok && readyUpdate.verified) ok = UPDATES.fileMatches(await UPDATES.sha512File(file).catch(() => ''), readyUpdate.hashes);
    if (!ok) {
      updateReady = null; readyUpdate = null;
      setUpdateState({ state: 'error', message: UPDATES.NOT_SIGNED_FILE });
      settingsChanged();
      return;
    }
    const host = (() => { try { return new URL(updateFeed).host; } catch { return ''; } })();
    const opts = UPDATES.installPrompt({ version: readyUpdate.version, verified: readyUpdate.verified, host });
    if (win && !win.isDestroyed()) showWindow();
    const { response } = await (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
    if (response !== 1 || !updateReady) return;
    quitting = true;
    try { updater.quitAndInstall(false, true); } catch { app.quit(); }
  } finally { installing = false; }
}
const askToInstall = () => { installUpdate().catch(() => { installing = false; }); };

// ---------------------------------------------------------------- tray + menus
function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', IS_MAC ? 'tray-16.png' : 'tray-32.png'));
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on('click', () => showWindow());
  refreshTrayMenu();
}
function refreshTrayMenu() {
  if (!tray) return;
  const login = startAtLogin();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: showWindow },
    { label: 'Settings…', click: openSettings },
    updateReady ? { label: `Restart to update (${updateReady})`, click: askToInstall } : null,
    { type: 'separator' },
    CAN_START_AT_LOGIN ? { label: 'Start when I log in', type: 'checkbox', checked: login, click: (i) => setDesktopSetting('startAtLogin', i.checked) } : null,
    CAN_START_AT_LOGIN && login ? { label: 'Start minimised in the tray', type: 'checkbox', checked: startHidden(), click: (i) => setDesktopSetting('startHidden', i.checked) } : null,
    !IS_MAC ? { label: 'Keep running in the tray when closed', type: 'checkbox', checked: closeToTray(), click: (i) => setDesktopSetting('closeToTray', i.checked) } : null,
    CONFIG.lockServer ? null : { label: 'Change server…', click: () => { showWindow(); loadConnect(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ].filter(Boolean)));
}
// The first time the window goes to the tray, say so (otherwise it looks like Hearth quit).
function trayHintOnce() {
  if (settings.trayHintShown) return;
  settings.trayHintShown = true; saveSettings();
  const content = `${APP_NAME} is still running here so you keep getting messages. To quit, right-click this icon and choose Quit. You can change this in Settings → Apps & devices.`;
  try {
    if (IS_WIN && tray) tray.displayBalloon({ iconType: 'info', title: `${APP_NAME} is still running`, content });
    else if (Notification.isSupported()) new Notification({ title: `${APP_NAME} is still running`, body: content, silent: true }).show();
  } catch { /* ignore */ }
}
function buildAppMenu() {
  // On Windows and Linux the zoom and Settings keys are handled in before-input-event (so Ctrl+=, Ctrl++ and
  // the number pad all work); the menu only shows them.
  const shown = (accelerator) => ({ accelerator, registerAccelerator: IS_MAC });
  const settingsItem = { label: 'Settings…', ...shown('CmdOrCtrl+,'), click: openSettings };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ label: APP_NAME, submenu: [
      { role: 'about' }, { type: 'separator' }, settingsItem, { type: 'separator' },
      { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] }] : [{ label: 'File', submenu: [settingsItem, { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }] }]),
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { label: 'Actual size', ...shown('CmdOrCtrl+0'), click: () => setDesktopSetting('zoom', 1) },
      { label: 'Zoom in', ...shown('CmdOrCtrl+='), click: () => stepZoom(1) },
      { label: 'Zoom out', ...shown('CmdOrCtrl+-'), click: () => stepZoom(-1) },
      { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'Open in browser', click: () => { const o = serverOrigin(); if (o) shell.openExternal(o); } },
      ...(CONFIG.lockServer ? [] : [{ label: 'Change server…', click: () => { showWindow(); loadConnect(); } }]),
      { label: 'Reset permissions', click: () => {
        resetPermissions();
        const o = { type: 'info', message: 'Hearth will ask again before using your microphone, camera or clipboard.' };
        (win && !win.isDestroyed() ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)).catch(() => {});
      } },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
    ] },
  ]));
}

// ---------------------------------------------------------------- IPC from the page (see preload.js)
// A message counts only from the main window's top frame, showing your server's page (exact origin) or the
// built-in connect screen. A look-alike address (https://your.server.evil.net) is not your server.
const fromMainWindow = (e) => !!(win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame && !e.senderFrame.parent);
const fromOurPage = (e) => fromMainWindow(e) && (isServer(e.senderFrame.url) || isConnectScreen(e.senderFrame.url));
const fromConnectScreen = (e) => fromMainWindow(e) && isConnectScreen(e.senderFrame.url);
ipcMain.on('version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.on('badge', (e, n) => { if (fromOurPage(e)) setBadge(n); });
ipcMain.on('focus', (e) => { if (fromOurPage(e)) showWindow(); });
ipcMain.on('change-server', (e) => { if (fromOurPage(e) && !CONFIG.lockServer) loadConnect(); });
// Keybinds from Settings → Keybinds: push-to-talk / mute / deafen, even while a game has focus.
ipcMain.handle('keybinds', (e, b) => (fromOurPage(e) ? hotkeys.set(b, (ev) => sendToPage('hotkey', ev)) : { ok: false }));
// A @mention while Hearth isn't focused: flash the taskbar button until it is.
ipcMain.on('flash', (e) => { if (fromOurPage(e) && win && !win.isFocused()) win.flashFrame(true); });
ipcMain.on('call-state', (e, s) => {
  if (!fromOurPage(e)) return;
  call = { inCall: !!(s && s.inCall), muted: !!(s && s.muted), deafened: !!(s && s.deafened) };
  drawThumbar();
});
ipcMain.on('install-update', (e) => { if (fromOurPage(e)) askToInstall(); });
ipcMain.on('update-status', (e) => { e.returnValue = updateReady; });
// Settings → Apps & devices: the app's own settings, the update check and "Restart now".
ipcMain.handle('desktop-settings:get', (e) => (fromOurPage(e) ? desktopSettings() : null));
ipcMain.handle('desktop-settings:set', (e, key, value) => (fromOurPage(e) ? setDesktopSetting(String(key), value) : { ok: false, error: 'Not allowed.' }));
ipcMain.handle('check-updates', (e) => (fromOurPage(e) ? checkForUpdates() : { state: 'error', message: 'Not allowed.' }));
ipcMain.on('restart', (e) => { if (fromOurPage(e)) restartApp(); });
// Game / music detection (detect.js), only while the person shares it.
const detect = require('./detect');
ipcMain.on('detect', (e, o) => {
  if (!fromOurPage(e)) return;
  if (o && (o.games || o.songs)) detect.start((a) => { if (win && !win.isDestroyed()) win.webContents.send('activity', a); }, o);
  else detect.stop();
});
// Is it a Hearth server? (/api/config answers with its name.) A certificate error counts as "there": the
// certificate prompt handles it when the page loads.
async function probe(origin) {
  try {
    const res = await net.fetch(origin + '/api/config', { signal: AbortSignal.timeout(10000), cache: 'no-store' });
    const cfg = await res.json().catch(() => ({}));
    if (!res.ok || typeof cfg.name !== 'string') return { ok: false, error: res.ok ? 'NOT_HEARTH' : `HTTP_${res.status}` };
    return { ok: true, name: cfg.name };
  } catch (err) {
    const m = String(err && err.message);
    if (/CERT|certificate/i.test(m)) return { ok: true, cert: true };
    return { ok: false, error: /timeout|abort/i.test(m) ? 'timed out' : m.replace(/^net::/, '') };
  }
}
// The connect screen checks that the address really is a Hearth server before saving it.
ipcMain.handle('connect', async (e, raw) => {
  if (!fromConnectScreen(e)) return { ok: false, error: 'Not allowed.' };
  if (CONFIG.lockServer) return { ok: false, error: 'This app only connects to its own server.' };
  const origin = normalize(String(raw || '').trim());
  if (!origin) return { ok: false, error: 'That doesn’t look like a web address.' };
  const r = await probe(origin);
  if (!r.ok) return { ok: false, error: `Couldn’t find a Hearth server at ${origin}.` };
  settings.server = origin;
  saveSettings();
  load();
  settingsChanged();
  return { ok: true, name: r.name };
});
// The "can't reach your server" screen asks this every few seconds; when the server answers, it loads.
ipcMain.handle('retry-server', async (e) => {
  if (!fromConnectScreen(e)) return { ok: false, error: 'Not allowed.' };
  const origin = serverOrigin();
  if (!origin) return { ok: false, error: 'No server yet.' };
  const r = await probe(origin);
  if (r.ok && win && !win.isDestroyed() && isConnectScreen(win.webContents.getURL())) load();
  return { ok: r.ok, error: r.error || '' };
});

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(() => {
  buildAppMenu();
  createWindow();
  buildTray();
  setupUpdates();
  if (pendingLink) win.webContents.once('did-finish-load', () => { const l = pendingLink; pendingLink = ''; openLink(l); });
  // Back from sleep or the lock screen: tell the page to reconnect right away instead of waiting.
  powerMonitor.on('resume', () => sendToPage('resume'));
  powerMonitor.on('unlock-screen', () => sendToPage('resume'));
  // A monitor was unplugged or rearranged: bring the window back if it's now off every screen.
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);
});
app.on('will-quit', () => { hotkeys.stop(); if (saveTimer) writeSettings(); });
app.on('activate', () => showWindow());
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!IS_MAC && !closeToTray()) app.quit(); });
