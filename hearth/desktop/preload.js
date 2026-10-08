// The only bridge between the page and the desktop shell. The page can set the unread badge,
// bring the window forward, (on the connect screen) choose a server, and get the game/song being played.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hearthDesktop', {
  isDesktop: true,
  platform: process.platform,
  version: ipcRenderer.sendSync('version'),
  setBadge: (n) => ipcRenderer.send('badge', Number(n) || 0),
  focus: () => ipcRenderer.send('focus'),
  changeServer: () => ipcRenderer.send('change-server'),
  connect: (url) => ipcRenderer.invoke('connect', String(url)),
  // Screen-share picker (the app sends the list of screens/windows; the page answers with one id or null).
  onPickScreen: (cb) => ipcRenderer.on('screen-pick', (e, sources) => cb(sources)),
  pickScreen: (id) => ipcRenderer.send('screen-picked', id == null ? null : String(id)),
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
  // Updates from your server: told when one is downloaded; installUpdate() restarts into it.
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (e, u) => cb(u)),
  updateReady: () => ipcRenderer.sendSync('update-status'),
  installUpdate: () => ipcRenderer.send('install-update'),
  // Back from sleep / lock screen.
  onResume: (cb) => ipcRenderer.on('resume', () => cb()),
});
