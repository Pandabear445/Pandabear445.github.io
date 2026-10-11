// Inside the Hearth Android app, gives the page what a phone web view lacks on its own:
// notifications (window.Notification) and saving files (<a download> links), and with a current app also
// notifications while it's closed (androidApp.push, see android-push.js), calls that keep going with the
// screen locked (androidApp.callState) and invite links that open in the app.
// Does nothing in browsers or the desktop app.
import { createAndroidPush, safeOpenHash, safeInviteHash } from './android-push.js';

const A = window.HearthAndroid;
// push: null until the app says it can (an older app can't). ready: settles once the app answered (or didn't
// in time). onHangUp: set by app.js; the call notification's Hang up button calls it.
export const androidApp = { on: !!A, version: '', notify: 'default', push: null, calls: false, ready: Promise.resolve(), onHangUp: null };

if (A) {
  const send = (msg) => { try { A.postMessage(JSON.stringify(msg)); } catch { /* app closing */ } };
  // Opens a place in the app (a tapped notification, an invite link) through the address's #part, which
  // app.js follows (now, or once signed in).
  const go = (hash) => { if (hash && location.hash !== hash) location.hash = hash; };
  let ready;
  androidApp.ready = new Promise((r) => { ready = r; setTimeout(r, 1500); });
  A.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'info') {
      androidApp.version = m.version || '';
      androidApp.notify = m.notify || 'default';
      androidApp.calls = m.call === true;
      if (m.push && typeof m.push === 'object' && !androidApp.push) {
        androidApp.push = createAndroidPush({ send, initial: m.push });
        // Signed out while the app was closed: this phone mustn't keep a push address for the old account.
        if (m.push.state === 'registered' && !localStorage.getItem('hearth.token')) androidApp.push.unregister();
      }
      go(safeOpenHash(m.open));
      go(safeInviteHash(m.invite));
      ready();
    } else if (m.type === 'pushState' && androidApp.push) androidApp.push._reply(m);
  };
  // v: 2 tells the app this page takes notification taps and invites in place (older pages get reloaded).
  send({ type: 'hello', v: 2 });
  androidApp.switchServer = () => send({ type: 'changeServer' });
  androidApp.cancel = (tag) => send({ type: 'cancel', tag: String(tag) });
  window.addEventListener('hearth-push', (e) => { if (androidApp.push) androidApp.push._event(e.detail); });
  window.addEventListener('hearth-open', (e) => go(safeOpenHash(e.detail)));
  window.addEventListener('hearth-invite', (e) => go(safeInviteHash(e.detail)));
  window.addEventListener('hearth-hangup', () => { if (typeof androidApp.onHangUp === 'function') androidApp.onHangUp(); });

  // ---- calls: while one is on, the app runs a foreground service (a notification with Hang up) so Android
  // keeps the call and its microphone going with the screen off or the app in the background.
  let inCall = false; let callTitle = '';
  androidApp.callState = ({ inCall: on, title = '' } = {}) => {
    const t = String(title || '').slice(0, 120);
    if (on && (!inCall || t !== callTitle)) send({ type: 'callStart', title: t });
    else if (!on && inCall) send({ type: 'callEnd' });
    inCall = !!on; callTitle = t;
  };
  // Leaving the page (a reload, switching server) ends the call in it: so does the notification. (The app also
  // stops it when the next page starts loading, in case this message doesn't get out in time.)
  window.addEventListener('pagehide', () => { if (inCall) { inCall = false; send({ type: 'callEnd' }); } });

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
