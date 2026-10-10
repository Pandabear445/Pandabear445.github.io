// Big files: resumable uploads, downloads with progress, and a bounded cache of decrypted copies.
//
// Uploads above CHUNKED_ABOVE go through the server's resumable protocol (see server/storage.js): the app
// declares the size, sends the ciphertext in chunks in order, and finishes with its SHA-256. A dropped connection
// doesn't lose what was sent: the app waits (longer each time), asks the server how much it has, and carries on
// from there. Everything sent here is already encrypted; the server never sees the file, its name or its type.
import { getToken } from './api.js';

export const CHUNKED_ABOVE = 8 * 1024 * 1024;
const MAX_TRIES = 10; // retries in a row without progress before giving up (about 3 minutes of waiting)

export const cancelledError = () => Object.assign(new Error('Upload cancelled.'), { cancelled: true });
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(cancelledError());
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(cancelledError()); }, { once: true });
});
// Waits until the browser thinks it's online again (it can't always tell, so this never waits forever).
const backOnline = (signal) => (typeof navigator === 'undefined' || navigator.onLine !== false ? Promise.resolve()
  : new Promise((resolve) => { const done = () => { window.removeEventListener('online', done); resolve(); }; window.addEventListener('online', done); setTimeout(done, 60000); signal && signal.addEventListener('abort', done, { once: true }); }));

// One API request with XMLHttpRequest (fetch can't report upload progress). Resolves with { status, data } for any
// answer from the server; rejects only when there was no answer (network) or it was cancelled.
function request(method, path, { body, json, onProgress, signal, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(cancelledError());
    const xhr = new XMLHttpRequest();
    xhr.open(method, '/api' + path);
    xhr.timeout = timeout;
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    if (json !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
    else if (body !== undefined && !(body instanceof FormData)) xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
    const stop = () => xhr.abort();
    if (signal) signal.addEventListener('abort', stop, { once: true });
    const end = () => { if (signal) signal.removeEventListener('abort', stop); };
    xhr.onload = () => {
      end();
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      resolve({ status: xhr.status, data, retryAfter: Number(xhr.getResponseHeader('Retry-After')) || 0 });
    };
    xhr.onerror = () => { end(); reject(Object.assign(new Error('network'), { network: true })); };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => { end(); reject(cancelledError()); };
    xhr.send(json !== undefined ? JSON.stringify(json) : body);
  });
}
const failure = (r, fallback) => Object.assign(new Error((r.data && r.data.error) || fallback || `Upload failed (${r.status}).`), { status: r.status, code: r.data && r.data.code });
// Network trouble, a busy server or "too many requests": worth waiting and trying again.
const retryable = (r) => !r || r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500;

export async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Uploads already-encrypted bytes (a Uint8Array) and resolves with the blob's /uploads/ address.
//   onProgress(fraction)            how much the server has confirmed (and what's in flight)
//   onStatus({ retrying, wait })    "connection lost, trying again in …" and back to normal
//   signal                          an AbortSignal: cancelling also tells the server, which frees the room
export async function uploadResumable(bytes, { onProgress = () => {}, onStatus = () => {}, signal } = {}) {
  const size = bytes.byteLength;
  const hash = await sha256Hex(bytes);
  const data = new Blob([bytes]);
  let start;
  for (let tries = 0; ; tries++) {
    start = await request('POST', '/uploads', { json: { size }, signal }).catch((e) => { if (e.cancelled) throw e; return null; });
    if (start && start.status === 200) break;
    if (!retryable(start) || tries >= 3) throw start ? failure(start) : new Error('Couldn’t reach the server. Check your connection and try again.');
    await sleep(1000 * 2 ** tries, signal);
  }
  const { id, chunkSize } = start.data;
  let offset = start.data.received || 0;
  try {
    let tries = 0;
    const recover = async (r) => {
      if (++tries > MAX_TRIES) throw new Error('The connection kept dropping, so the upload stopped. Try again when you’re back online.');
      const wait = r && r.status === 429 && r.retryAfter ? r.retryAfter * 1000 : Math.min(30000, 1000 * 2 ** (tries - 1));
      onStatus({ retrying: true, wait });
      await sleep(wait, signal);
      await backOnline(signal);
      // Ask the server how far it got: a chunk cut off halfway keeps what arrived.
      const st = await request('GET', `/uploads/${id}`, { signal, timeout: 30000 }).catch((e) => { if (e.cancelled) throw e; return null; });
      if (st && st.status === 200) offset = st.data.received;
      else if (st && st.status === 404) throw failure(st, 'The upload expired. Send the file again.');
      onStatus({ retrying: false });
    };
    while (offset < size) {
      const from = offset;
      const r = await request('PUT', `/uploads/${id}?offset=${from}`, {
        body: data.slice(from, Math.min(size, from + chunkSize)), signal, onProgress: (n) => onProgress(Math.min(1, (from + n) / size)),
      }).catch((e) => { if (e.cancelled) throw e; return null; });
      if (r && r.status === 200) { offset = r.data.received; tries = 0; onProgress(offset / size); continue; }
      if (r && r.status === 409 && r.data.code === 'offset_mismatch') { offset = r.data.received; continue; }
      if (!retryable(r)) throw failure(r);
      await recover(r);
    }
    for (;;) {
      const r = await request('POST', `/uploads/${id}/complete`, { json: { sha256: hash }, signal, timeout: 300000 }).catch((e) => { if (e.cancelled) throw e; return null; });
      if (r && r.status === 200) return r.data.url;
      if (!retryable(r)) throw failure(r);
      await recover(r);
    }
  } catch (e) {
    // Cancelled or failed for good: give the reserved room back (best effort; the server expires it anyway).
    request('DELETE', `/uploads/${id}`, { timeout: 15000 }).catch(() => {});
    throw e;
  }
}

// The one-request upload, for small files (and the way older servers take every file).
export async function uploadSimple(bytes, { onProgress = () => {}, signal } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), 'blob.bin');
  const total = bytes.byteLength || 1;
  const r = await request('POST', '/upload/encrypted', { body: fd, signal, onProgress: (n) => onProgress(Math.min(1, n / total)) })
    .catch((e) => { if (e.cancelled) throw e; throw new Error('Upload failed. Check your connection.'); });
  if (r.status !== 200) throw failure(r);
  return r.data.url;
}
// Downloads a file from this server with progress. A dropped connection carries on with a Range request from
// where it stopped (a few times). A file that's gone answers with an error whose code is 'gone'.
export async function download(url, { onProgress = () => {}, signal, expected = 0 } = {}) {
  const parts = [];
  let got = 0;
  let total = expected;
  for (let tries = 0; ; tries++) {
    let res;
    try {
      res = await fetch(url, { signal, headers: got ? { Range: `bytes=${got}-` } : {} });
    } catch (e) {
      if (signal && signal.aborted) throw cancelledError();
      if (tries >= 3) throw new Error('Couldn’t reach the server. Check your connection and try again.');
      await sleep(1000 * 2 ** tries, signal);
      continue;
    }
    if (res.status === 404 || res.status === 410) throw Object.assign(new Error('This file is no longer available. It was deleted, or the message it was in was.'), { code: 'gone' });
    if (got && res.status === 200) { parts.length = 0; got = 0; } // the server sent it all again
    else if (!res.ok) throw new Error(`The server couldn’t send this file (${res.status}). Try again in a moment.`);
    if (!got) total = Number(res.headers.get('Content-Length')) || expected;
    if (!res.body || !res.body.getReader) { const b = new Uint8Array(await res.arrayBuffer()); parts.push(b); got += b.length; break; }
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        if (total) onProgress(Math.min(1, got / total));
      }
      break;
    } catch (e) {
      if (signal && signal.aborted) throw cancelledError();
      if (tries >= 3) throw new Error('The download kept getting cut off. Try again in a moment.');
      await sleep(1000 * 2 ** tries, signal);
    }
  }
  onProgress(1);
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}

// Decrypted copies live as blob: URLs. Each one holds the whole file in memory until it's revoked, so only the
// most recently used ones are kept (up to `budget` bytes); older ones are revoked unless something on screen still
// shows them (a playing video would break). Call release() for everything when signing out.
export function makeUrlCache(budget = 256 * 1024 * 1024) {
  const items = new Map(); // key -> { url, size }
  let bytes = 0;
  const inUse = (url) => typeof document !== 'undefined' && [...document.querySelectorAll('img[src^="blob:"], video[src^="blob:"], audio[src^="blob:"], source[src^="blob:"]')].some((el) => el.getAttribute('src') === url);
  const trim = () => {
    for (const [k, v] of items) {
      if (bytes <= budget) break;
      if (inUse(v.url)) continue;
      items.delete(k); bytes -= v.size; URL.revokeObjectURL(v.url);
    }
  };
  return {
    get(key) { const v = items.get(key); if (!v) return null; items.delete(key); items.set(key, v); return v.url; }, // most recent last
    put(key, blob) {
      const old = items.get(key);
      if (old) { items.delete(key); bytes -= old.size; URL.revokeObjectURL(old.url); }
      const url = URL.createObjectURL(blob);
      items.set(key, { url, size: blob.size });
      bytes += blob.size;
      trim();
      return url;
    },
    drop(key) { const v = items.get(key); if (v) { items.delete(key); bytes -= v.size; if (!inUse(v.url)) URL.revokeObjectURL(v.url); } },
    release() { for (const v of items.values()) URL.revokeObjectURL(v.url); items.clear(); bytes = 0; },
    get size() { return bytes; },
    get count() { return items.size; },
  };
}

// What a file is, from the type the sender's app recorded (inside the encrypted message) and its name.
export function mediaKind(type, name = '') {
  const t = String(type || '').toLowerCase();
  if (/^image\//.test(t)) return 'img';
  if (/^video\//.test(t)) return 'video';
  if (/^audio\//.test(t)) return 'audio';
  if (!t && /\.(mp4|webm|mov)$/i.test(name)) return 'video';
  return null;
}
// A short, plain description of a file's type for unsupported-file cards ("PDF document", "ZIP archive"…).
export function typeLabel(type, name = '') {
  const ext = (String(name).match(/\.([a-z0-9]{1,8})$/i) || [])[1];
  const known = { pdf: 'PDF document', zip: 'ZIP archive', '7z': '7-Zip archive', rar: 'RAR archive', gz: 'Compressed file', txt: 'Text file', md: 'Text file', csv: 'Spreadsheet (CSV)',
    doc: 'Word document', docx: 'Word document', xls: 'Spreadsheet', xlsx: 'Spreadsheet', ppt: 'Presentation', pptx: 'Presentation', json: 'JSON file', apk: 'Android app', exe: 'Windows program', dmg: 'Mac disk image', iso: 'Disc image' };
  if (ext && known[ext.toLowerCase()]) return known[ext.toLowerCase()];
  const t = String(type || '');
  if (/^image\//.test(t)) return 'Image';
  if (/^video\//.test(t)) return 'Video';
  if (/^audio\//.test(t)) return 'Audio';
  if (/^text\//.test(t)) return 'Text file';
  return ext ? `${ext.toUpperCase()} file` : 'File';
}
