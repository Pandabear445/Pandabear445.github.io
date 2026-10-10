// Is this address one of Hearth's own pages? Every trust decision in main.js (which pages load inside the
// window, which may use the hearthDesktop bridge, who may share the screen) goes through these. They compare
// whole origins, never the start of the text: "https://chat.example.com.evil.net/" and
// "https://chat.example.com@evil.net/" both *start with* "https://chat.example.com" but are other sites.
// No Electron in here, so test/client-hardening.test.js runs it with plain Node.
const path = require('path');
const { fileURLToPath } = require('url');

// What the person typed (chat.example.com, https://chat.example.com/x…) as an origin, or null.
function normalize(u) {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return url.origin;
  } catch { return null; }
}

// An http(s) page of exactly this server. Addresses with a user name or password in them are refused:
// they're only ever used to make one site's address look like another's.
function isServerUrl(url, origin) {
  if (!origin) return false;
  try {
    const u = new URL(String(url));
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && u.origin === origin;
  } catch { return false; }
}

// One of the app's own local files (connect.html, picker.html), compared as a path: any query or #hash is
// fine, any other file: page is not. Windows paths compare without regard to case.
function isAppFile(url, file, platform = process.platform) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'file:') return false;
    u.search = ''; u.hash = '';
    const win = platform === 'win32';
    const p = fileURLToPath(u, { windows: win });
    const norm = (x) => (win ? path.win32.normalize(x).toLowerCase() : path.posix.normalize(x));
    return norm(p) === norm(file);
  } catch { return false; }
}

// A server that only moves http:// to https:// on the same host (a reverse proxy doing its job) is still the
// same server, so that redirect may load. Everything else that leaves the server is refused.
function isHttpsUpgrade(url, origin) {
  try {
    const from = new URL(origin);
    const to = new URL(String(url));
    return from.protocol === 'http:' && to.protocol === 'https:' && to.hostname === from.hostname && !to.username && !to.password;
  } catch { return false; }
}

module.exports = { normalize, isServerUrl, isAppFile, isHttpsUpgrade };
