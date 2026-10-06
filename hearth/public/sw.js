// Hearth service worker. The server fills in the version and asset list (see /sw.js in server/index.js).
// - App files load from cache instantly; a new version installs in the background and the page offers a reload.
// - API calls, uploads and the realtime socket always go to the network.
// - Push notifications open the right conversation when tapped.
const VERSION = '__VERSION__';
const ASSETS = '__ASSETS__';
const CACHE = `hearth-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('hearth-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Only the app's own files are cached here. Everything else (API, uploads, GIFs passed through the
  // server) goes straight to the network and the browser's normal cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/downloads/') || url.pathname.startsWith('/media/')) return;
  if (url.pathname.startsWith('/socket.io/') && url.pathname !== '/socket.io/socket.io.js') return;

  // Pages: try the network first (fresh HTML), fall back to the cached app shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }
  if (!ASSETS.includes(url.pathname)) return;
  // App files: cache first, then network (and remember it). Matched exactly: ignoring the "?…" part once
  // made every GIF show as the same one, because GIFs differ only in their query string.
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') { const c = await caches.open(CACHE); c.put(req, res.clone()); }
    return res;
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Hearth', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // If a Hearth window is already focused, the app shows its own notification.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.focused)) return;
    await self.registration.showNotification(data.title || 'Hearth', {
      body: data.body || 'New activity',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: data.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ type: 'open', url: target });
    } else {
      await self.clients.openWindow(target);
    }
  })());
});
