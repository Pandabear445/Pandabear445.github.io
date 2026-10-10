// The bridge for picker.html only (the "Choose what to share" window). It's the app's own local page:
// the list of screens and windows (names and previews) goes here and never to the server's page, and only
// the person's click here decides what gets shared. main.js checks that answers come from this window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hearthPicker', {
  // cb({ host, audio, sources: [{ id, name, screen, thumb }] })
  onSources: (cb) => ipcRenderer.on('picker:sources', (e, data) => cb(data)),
  choose: (id) => ipcRenderer.send('picker:choose', id == null ? null : String(id)),
});
