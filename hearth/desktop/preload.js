// The only bridge between the page and the desktop shell. The page can set the unread badge,
// bring the window forward and (on the connect screen) choose a server — nothing else.
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
});
