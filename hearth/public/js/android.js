// Inside the Hearth Android app, gives the page what a phone web view lacks on its own:
// notifications (window.Notification) and saving files (<a download> links).
// Does nothing in browsers or the desktop app.
const A = window.HearthAndroid;
export const androidApp = { on: !!A, version: '', notify: 'default' };

if (A) {
  const send = (msg) => { try { A.postMessage(JSON.stringify(msg)); } catch { /* app closing */ } };
  A.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'info') { androidApp.version = m.version || ''; androidApp.notify = m.notify || 'default'; }
  };
  send({ type: 'hello' });
  androidApp.switchServer = () => send({ type: 'changeServer' });

  // ---- notifications
  const open = new Map();
  let waiting = [];
  window.addEventListener('hearth-notify-permission', (e) => {
    androidApp.notify = e.detail || 'default';
    const w = waiting; waiting = [];
    for (const r of w) r(androidApp.notify);
  });
  window.addEventListener('hearth-notification-click', (e) => {
    const n = open.get(e.detail);
    if (n && typeof n.onclick === 'function') n.onclick({ target: n });
  });
  class AppNotification {
    static get permission() { return androidApp.notify; }
    static requestPermission() {
      return new Promise((resolve) => {
        if (androidApp.notify === 'granted') return resolve('granted');
        waiting.push(resolve);
        send({ type: 'askNotify' });
      });
    }
    constructor(title, opts = {}) {
      this.title = String(title || 'Hearth');
      this.body = String(opts.body || '');
      this.tag = String(opts.tag || `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`);
      this.onclick = null;
      open.set(this.tag, this);
      if (open.size > 200) open.delete(open.keys().next().value);
      send({ type: 'notify', title: this.title, body: this.body, tag: this.tag });
    }
    close() { open.delete(this.tag); send({ type: 'cancel', tag: this.tag }); }
  }
  window.Notification = AppNotification;

  // ---- downloads: web views ignore <a download>, so hand the bytes to the app in chunks
  const CHUNK = 384 * 1024;
  const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  // The page's security policy doesn't let fetch() read blob: URLs, so remember the blob behind each one.
  const blobs = new Map();
  const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
  URL.createObjectURL = (obj) => { const u = createURL.call(URL, obj); if (obj instanceof Blob) blobs.set(u, obj); return u; };
  URL.revokeObjectURL = (u) => { setTimeout(() => blobs.delete(u), 60000); return revokeURL.call(URL, u); };
  const fromData = (href) => {
    const [head, body = ''] = href.split(',');
    const type = (head.match(/^data:([^;,]*)/) || [])[1] || '';
    const bin = /;base64/.test(head) ? atob(body) : decodeURIComponent(body);
    return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0) & 255)], { type });
  };
  async function save(href, name) {
    const blob = href.startsWith('blob:') ? blobs.get(href) : href.startsWith('data:') ? fromData(href) : await (await fetch(href)).blob();
    if (!blob) throw new Error('file gone');
    const id = `d${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    send({ type: 'saveStart', id, name: name || 'file', mime: blob.type || 'application/octet-stream' });
    for (let at = 0; at < blob.size; at += CHUNK) {
      send({ type: 'saveChunk', id, data: b64(new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer())) });
    }
    send({ type: 'saveEnd', id });
  }
  const savable = (a) => a && a.hasAttribute('download') && (/^(blob|data):/.test(a.href) || a.origin === location.origin);
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (savable(this)) { save(this.href, this.getAttribute('download')).catch(() => {}); return; }
    return click.call(this);
  };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[download]');
    if (!savable(a)) return;
    e.preventDefault();
    save(a.href, a.getAttribute('download')).catch(() => {});
  }, true);
}
