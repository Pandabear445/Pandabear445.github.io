// Where GIF media may be downloaded from (the GIF privacy proxy, emoji made from a GIF, the GIF library), and the
// exact address each download goes to. A requested URL is only ever checked, never fetched as it was given: the
// address is put together from this server's own strings (the scheme, and a host from the list below or from
// GIF_PROXY_EXTRA_HOSTS), and only the path and query are taken from the request. So a GIF link can't point this
// server at another host, another port or a login of its choosing.

// GIPHY serves media from media.giphy.com, media0 to media4.giphy.com and i.giphy.com (media5 to media9 are allowed
// too, so a new shard doesn't break GIFs); KLIPY from the other three. Exact names only: no subdomains, no trailing
// dot, https on its default port.
const MEDIA_HOSTS = Object.freeze([
  'media.giphy.com', ...Array.from({ length: 10 }, (_, n) => `media${n}.giphy.com`), 'i.giphy.com',
  'static.klipy.com', 'static.klipy.co', 'media.klipy.com',
]);

// Characters a path segment may hold as they are (RFC 3986 "pchar") that encodeURIComponent escapes anyway.
const PCHAR_KEPT = /%(?:24|26|2B|2C|3A|3B|3D|40)/g;

// The path without its leading "/", rebuilt one segment at a time: each segment is decoded and encoded again, so it
// can't carry a "/", "\", "?" or "#" of its own and the result stays a path on the chosen host. null if the path
// has broken %-escapes. Escapes come out in one spelling, and an escaped $ & + , : ; = or @ comes out as the plain
// character (RFC 3986 doesn't treat those two as the same, but GIPHY and KLIPY media paths never use them).
function mediaPath(pathname) {
  try {
    return pathname.split('/').slice(1).map((seg) => encodeURIComponent(decodeURIComponent(seg)).replace(PCHAR_KEPT, decodeURIComponent)).join('/');
  } catch { return null; }
}

// The address to fetch for a GIF media URL (a URL object), or null if it isn't one this server downloads.
// extraHosts: the operator's GIF_PROXY_EXTRA_HOSTS entries (host or host:port, over http or https).
function gifMediaUrl(u, extraHosts = []) {
  if (!(u instanceof URL)) return null;
  let origin = null;
  const known = u.protocol === 'https:' && u.port === '' ? MEDIA_HOSTS.find((h) => h === u.hostname) : undefined;
  if (known) origin = 'https://' + known;
  else {
    const extra = extraHosts.find((h) => h === u.host);
    const scheme = u.protocol === 'https:' ? 'https://' : u.protocol === 'http:' ? 'http://' : null;
    if (extra && scheme) origin = scheme + extra;
  }
  if (!origin) return null;
  const p = mediaPath(u.pathname);
  if (p === null) return null;
  return u.search ? `${origin}/${p}?${u.search.slice(1)}` : `${origin}/${p}`;
}

module.exports = { MEDIA_HOSTS, gifMediaUrl };
