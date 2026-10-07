// Hearth desktop: a secure window onto your Hearth server, with tray, badge, notifications and auto-start.
// All chat code (including end-to-end encryption) runs from your server exactly as in the browser.
const { app, BrowserWindow, Menu, Tray, shell, session, ipcMain, nativeImage, dialog, net, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const CONFIG = require('./hearth.config.json');

const APP_NAME = CONFIG.appName || 'Hearth';
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* first run */ }
const saveSettings = () => { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* ignore */ } };

let win = null;
let tray = null;
let quitting = false;
let unread = 0;

const normalize = (u) => {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return url.origin;
  } catch { return null; }
};
const serverOrigin = () => normalize((CONFIG.lockServer ? CONFIG.defaultServer : settings.server || CONFIG.defaultServer) || '') || null;
const closeToTray = () => (settings.closeToTray ?? CONFIG.closeToTray ?? true) && process.platform !== 'darwin';

// ---------------------------------------------------------------- single instance
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());
app.setAppUserModelId(CONFIG.appId || 'app.hearth.desktop');

// ---------------------------------------------------------------- window
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 820, x: b.x, y: b.y,
    minWidth: 900, minHeight: 580, show: false, title: APP_NAME,
    backgroundColor: '#100e16', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });

  const remember = () => {
    if (!win || win.isMinimized()) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized) settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    remember();
    if (!quitting && (closeToTray() || process.platform === 'darwin')) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });

  // Links to other sites open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const origin = serverOrigin();
    if (url.startsWith('file:') || (origin && url.startsWith(origin))) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3) loadConnect(`Couldn't reach ${url} (${desc}). Check the address and your connection.`);
  });

  load();
}

function load() {
  const origin = serverOrigin();
  if (origin) win.loadURL(origin + '/');
  else loadConnect();
}
function loadConnect(error = '') {
  win.loadFile(path.join(__dirname, 'connect.html'), { query: { error, locked: CONFIG.lockServer ? '1' : '' , name: APP_NAME } });
}

// ---------------------------------------------------------------- security: permissions + certificates
app.whenReady().then(() => {
  const allowed = ['media', 'notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen'];
  const ok = (url, perm) => {
    const origin = serverOrigin();
    try { return !!origin && new URL(url).origin === origin && allowed.includes(perm); } catch { return false; }
  };
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(ok(details.requestingUrl || wc.getURL(), perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, requestingOrigin) => ok(requestingOrigin, perm));

  // Screen sharing: Electron has no built-in picker, so we list screens/windows and let the page show
  // one (newer macOS uses its own system picker). On Windows the computer's audio can be shared too.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const origin = serverOrigin();
      if (!origin || !request.securityOrigin || !request.securityOrigin.startsWith(origin)) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
      const id = await pickSource(sources.map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL() })));
      const chosen = id && sources.find((s) => s.id === id);
      if (!chosen) return callback({});
      callback({ video: chosen, audio: process.platform === 'win32' && request.audioRequested ? 'loopback' : undefined });
    } catch { callback({}); }
  }, { useSystemPicker: true });
});
function pickSource(list) {
  return new Promise((resolve) => {
    if (!win) return resolve(null);
    const done = (e, id) => { if (fromOurPage(e)) { clearTimeout(t); ipcMain.removeListener('screen-picked', done); resolve(typeof id === 'string' ? id : null); } };
    const t = setTimeout(() => { ipcMain.removeListener('screen-picked', done); resolve(null); }, 120000);
    ipcMain.on('screen-picked', done);
    win.webContents.send('screen-pick', list);
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
function redDot(count) {
  const n = count > 9 ? '9+' : String(count);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#ef5466"/><text x="16" y="21.5" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="700" font-size="${n.length > 1 ? 14 : 17}" fill="#fff">${n}</text></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}
function setBadge(n) {
  unread = Math.max(0, Math.floor(n) || 0);
  if (process.platform === 'win32' && win) win.setOverlayIcon(unread ? redDot(unread) : null, unread ? `${unread} unread` : '');
  else app.setBadgeCount(unread);
  if (tray) tray.setToolTip(unread ? `${APP_NAME} — ${unread} unread` : APP_NAME);
  if (unread && win && !win.isFocused()) win.flashFrame(true);
}

// ---------------------------------------------------------------- tray + menus
function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', process.platform === 'darwin' ? 'tray-16.png' : 'tray-32.png'));
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on('click', () => showWindow());
  refreshTrayMenu();
}
function refreshTrayMenu() {
  if (!tray) return;
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: showWindow },
    { type: 'separator' },
    { label: 'Start when I log in', type: 'checkbox', checked: login, click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }); refreshTrayMenu(); } },
    process.platform !== 'darwin' ? { label: 'Keep running in the tray when closed', type: 'checkbox', checked: closeToTray(), click: (i) => { settings.closeToTray = i.checked; saveSettings(); } } : null,
    CONFIG.lockServer ? null : { label: 'Change server…', click: () => { showWindow(); loadConnect(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ].filter(Boolean)));
}
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'Open in browser', click: () => { const o = serverOrigin(); if (o) shell.openExternal(o); } },
      ...(CONFIG.lockServer ? [] : [{ label: 'Change server…', click: () => { showWindow(); loadConnect(); } }]),
    ] },
  ]));
}

// ---------------------------------------------------------------- IPC from the page (see preload.js)
const fromOurPage = (e) => {
  const url = e.senderFrame ? e.senderFrame.url : '';
  const origin = serverOrigin();
  return url.startsWith('file:') || (!!origin && url.startsWith(origin));
};
ipcMain.on('version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.on('badge', (e, n) => { if (fromOurPage(e)) setBadge(n); });
ipcMain.on('focus', (e) => { if (fromOurPage(e)) showWindow(); });
ipcMain.on('change-server', (e) => { if (fromOurPage(e) && !CONFIG.lockServer) loadConnect(); });
// Game / music detection (detect.js), only while the person shares it.
const detect = require('./detect');
ipcMain.on('detect', (e, o) => {
  if (!fromOurPage(e)) return;
  if (o && (o.games || o.songs)) detect.start((a) => { if (win && !win.isDestroyed()) win.webContents.send('activity', a); }, o);
  else detect.stop();
});
// The connect screen checks that the address really is a Hearth server before saving it.
ipcMain.handle('connect', async (e, raw) => {
  if (!e.senderFrame || !e.senderFrame.url.startsWith('file:')) return { ok: false, error: 'Not allowed.' };
  const origin = normalize(String(raw || '').trim());
  if (!origin) return { ok: false, error: 'That doesn’t look like a web address.' };
  try {
    const res = await net.fetch(origin + '/api/config');
    const cfg = await res.json();
    if (!res.ok || typeof cfg.name !== 'string') throw new Error('not hearth');
    settings.server = origin;
    saveSettings();
    load();
    return { ok: true, name: cfg.name };
  } catch (err) {
    if (/CERT|certificate/i.test(String(err && err.message))) {
      settings.server = origin; saveSettings(); load(); // the certificate prompt takes it from here
      return { ok: true };
    }
    return { ok: false, error: `Couldn’t find a Hearth server at ${origin}.` };
  }
});

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(() => {
  buildAppMenu();
  createWindow();
  buildTray();
  if (app.isPackaged && CONFIG.autoUpdate !== false && process.platform !== 'darwin') {
    try { require('electron-updater').autoUpdater.checkForUpdatesAndNotify().catch(() => {}); } catch { /* updates not configured */ }
  }
});
app.on('activate', () => showWindow());
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !closeToTray()) app.quit(); });
