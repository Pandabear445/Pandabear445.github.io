// REST client.
let token = localStorage.getItem('hearth.token') || '';
// Whose sign-in this tab holds (set once the app has started): a token another tab stores for a different account
// (signed out there, then in as someone else) is never picked up here.
let owner = null;
const watchers = new Set();
const changed = () => watchers.forEach((fn) => { try { fn(token); } catch { /* one watcher's problem */ } });
const storedToken = () => { try { return localStorage.getItem('hearth.token') || ''; } catch { return ''; } };
const sameOwner = () => { try { return !!owner && localStorage.getItem('hearth.userId') === owner; } catch { return false; } };

export const getToken = () => token;
export function setToken(t) {
  const before = token;
  token = t || '';
  if (token) localStorage.setItem('hearth.token', token);
  else localStorage.removeItem('hearth.token');
  if (token && token !== before) changed();
}
export function setTokenOwner(userId) { owner = userId || null; }
// Called with the new token whenever it changes: this tab got a new one (a password change, two-factor turned on,
// other devices signed out: the server replaces the token then), or another tab of this browser did and stored it.
export function onTokenChange(fn) { watchers.add(fn); return () => watchers.delete(fn); }
// A newer token for this sign-in that another tab stored, if its 'storage' event hasn't reached this tab yet.
// True if this tab now holds a different token than before.
export function adoptStoredToken() {
  const t = storedToken();
  if (!t || t === token || !sameOwner()) return false;
  token = t;
  changed();
  return true;
}
// Resolves true once this tab holds a token other than `was` (checking what's stored too), or false after ms.
export function tokenMovedFrom(was, ms) {
  if (adoptStoredToken() || (token && token !== was)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let off = null;
    const done = (moved) => { clearTimeout(timer); clearInterval(poll); if (off) off(); resolve(moved); };
    // (The storage event can be slow while a tab is in the background, so look now and then as well.)
    const poll = setInterval(() => { if (adoptStoredToken()) done(true); }, 500);
    const timer = setTimeout(() => done(false), ms);
    off = onTokenChange((t) => { if (t && t !== was) done(true); });
  });
}
// Another tab of this browser stored a new token for the same sign-in: use it here too. (A removed token is left
// alone: that tab signed out, and the server tells this one so itself.)
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (e) => {
    if (e.key !== 'hearth.token' || !e.newValue || e.newValue === token || !sameOwner()) return;
    token = e.newValue;
    changed();
  });
}

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch('/api' + path, opts);
  let data = {};
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const e = new Error(data.error || `Request failed (${r.status})`);
    e.status = r.status;
    e.code = data.code;
    e.codeUsed = data.codeUsed === true; // turned down after a two-factor code was checked: that code is spent
    e.retryAfter = Number(r.headers.get('Retry-After')) || 0; // seconds, on 429
    throw e;
  }
  return data;
}

// Upload with progress (fetch has no upload progress).
export function upload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + path);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.send(formData);
  });
}
