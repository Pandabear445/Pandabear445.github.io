// The only bridge between the page and the desktop shell. The page can set the unread badge,
// bring the window forward, (on the connect screen) choose a server, and get the game/song being played.
// main.js checks that every message comes from the main window showing your server's own pages (exactly
// its origin; see origin.js) or the built-in connect screen. Screen sharing has no channel here: the app
// shows its own picker (picker.html), so the page never sees your windows.
const { contextBridge, ipcRenderer } = require('electron');

// Subscribes to a message from the app; returns a function that stops listening.
const listen = (channel, cb) => {
  const f = (e, data) => cb(data);
  ipcRenderer.on(channel, f);
  return () => ipcRenderer.removeListener(channel, f);
};

contextBridge.exposeInMainWorld('hearthDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: ipcRenderer.sendSync('version'),
  setBadge: (n) => ipcRenderer.send('badge', Number(n) || 0),
  focus: () => ipcRenderer.send('focus'),
  changeServer: () => ipcRenderer.send('change-server'),
  connect: (url) => ipcRenderer.invoke('connect', String(url)),
  // The "can't reach your server" screen: asks again; the app loads the server when it answers.
  retryServer: () => ipcRenderer.invoke('retry-server'),
  // Games & music: the page turns detection on/off (following the person's sharing settings) and gets
  // { game, music } back every 20 seconds while it's on. See detect.js.
  detectActivity: (o) => ipcRenderer.send('detect', { games: !!(o && o.games), songs: !!(o && o.songs) }),
  onActivity: (cb) => ipcRenderer.on('activity', (e, a) => cb(a)),
  // Keybinds that work everywhere (push-to-talk, mute, deafen). Resolves to { ok, global }.
  setKeybinds: (b) => ipcRenderer.invoke('keybinds', b || {}),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (e, ev) => cb(ev)),
  // Taskbar: flash on @mention; Mute/Deafen buttons in the taskbar preview while in a call.
  flash: () => ipcRenderer.send('flash'),
  setCallState: (s) => ipcRenderer.send('call-state', { inCall: !!(s && s.inCall), muted: !!(s && s.muted), deafened: !!(s && s.deafened) }),
  // Updates from your server: told when one is downloaded; installUpdate() asks the person (a native
  // dialog) and restarts into it only if they say yes.
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (e, u) => cb(u)),
  updateReady: () => ipcRenderer.sendSync('update-status'),
  installUpdate: () => ipcRenderer.send('install-update'),
  // "Check for updates": resolves to { state: 'none' | 'downloading' | 'ready' | 'checking' | 'error' | 'unavailable',
  // version?, percent?, message? }; onUpdateState(cb) follows the download afterwards.
  checkForUpdates: () => ipcRenderer.invoke('check-updates'),
  onUpdateState: (cb) => listen('update-state', cb),
  // Back from sleep / lock screen.
  onResume: (cb) => ipcRenderer.on('resume', () => cb()),
  // Ctrl+, (Cmd+, on Mac), the menu or the tray asks the page to open Settings.
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),
  // The app's own settings (Settings → Apps & devices). getDesktopSettings() resolves to
  // { startAtLogin, startHidden, closeToTray, hardwareAcceleration, hardwareAccelerationActive, zoom, spellcheck,
  //   server, serverLocked, version, updateReady, platform, supports: { startAtLogin, closeToTray, updates } }.
  // setDesktopSetting(key, value) resolves to { ok, settings, restartNeeded?, error? }.
  getDesktopSettings: () => ipcRenderer.invoke('desktop-settings:get'),
  setDesktopSetting: (key, value) => ipcRenderer.invoke('desktop-settings:set', String(key), typeof value === 'number' || typeof value === 'boolean' ? value : null),
  onDesktopSettings: (cb) => listen('desktop-settings', cb),
  restart: () => ipcRenderer.send('restart'),
});
