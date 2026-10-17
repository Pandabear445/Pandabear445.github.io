// Signed links for the picture proxies (/media/news, /media/avatar and /media/art).
//
// The server signs a picture's address when it hands it to an app: a news post's picture, a tracker item's, a
// webhook post's avatar (on a known avatar host only: see avatarHost below), someone's album art. The link names
// that one address and a time it stops working, with an HMAC over both, so a link for one picture can't be turned
// into a link for another, and nobody can make up a link for an address this server never chose to show. The app
// adds its sign-in media token (see mediaToken in index.js), so a link also needs a live session, still on the sign-in
// token it had then, to work.
//
// A link lasts about a day: long enough for a tab left open, short enough that a copied link soon stops working.
// The time it stops is rounded to the next 6 hours, so the same picture gets the same link for a while and browsers
// can cache it.
const crypto = require('crypto');

const TTL_SEC = 24 * 3600;
const STEP_SEC = 6 * 3600;
const MAX_URL = 2048;
const KINDS = new Set(['news', 'avatar', 'art']);

// One spelling per address (what the proxy will fetch), without a fragment. null for anything but http(s).
function normalize(u) {
  if (typeof u !== 'string' || !u || u.length > MAX_URL) return null;
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
    x.hash = '';
    return x.href.length > MAX_URL ? null : x.href;
  } catch { return null; }
}

// key: the server's 32-byte at-rest key. Links are signed with a key derived from it, used for nothing else.
function mediaLinks(key) {
  const k = crypto.createHmac('sha256', key).update('hearth media links v1').digest();
  const mac = (kind, exp, href) => crypto.createHmac('sha256', k).update(`${kind}\n${exp}\n${href}`).digest('base64url').slice(0, 32);
  // The link the app loads (it adds &t=<its media token>), or null if the address can't be signed.
  function sign(kind, u, { now = Date.now() } = {}) {
    if (!KINDS.has(kind)) return null;
    const href = normalize(u);
    if (!href) return null;
    const exp = (Math.floor(now / 1000 / STEP_SEC) + 1) * STEP_SEC + TTL_SEC;
    // A short name per picture in the path: older app caches mixed up links that differed only after "?".
    const name = crypto.createHash('sha256').update(href).digest('hex').slice(0, 12);
    return `/media/${kind}/${name}?u=${encodeURIComponent(href)}&e=${exp}&s=${mac(kind, exp, href)}`;
  }
  // The address to fetch if this link was signed for this kind of picture and hasn't run out, else null.
  function check(kind, u, e, s, { now = Date.now() } = {}) {
    if (!KINDS.has(kind) || typeof e !== 'string' || typeof s !== 'string' || !/^\d{1,12}$/.test(e) || !/^[\w-]{32}$/.test(s)) return null;
    const exp = Number(e);
    const nowSec = now / 1000;
    if (exp < nowSec || exp > nowSec + TTL_SEC + STEP_SEC + 60) return null;
    const href = normalize(u);
    if (!href) return null;
    const good = Buffer.from(mac(kind, exp, href));
    return crypto.timingSafeEqual(good, Buffer.from(s)) ? href : null;
  }
  return { sign, check };
}

// Webhook avatars (files-10). A webhook post names its own picture, and anyone can make a webhook in a server of their
// own, so signing every avatar would let anyone have this server fetch any picture on the internet for them. Only
// avatars on the hosts that programs posting to webhooks use are signed, and /media/avatar fetches from those hosts
// alone (every redirect too): Discord's and GitHub's avatar hosts, GitHub's file host (project logos) and Gravatar
// (https on the usual port), plus any an admin lists in WEBHOOK_AVATAR_HOSTS: host names or host:port, "*.example.com"
// for every name under it. Those may be on the local network (a Grafana at home, say), like ART_PROXY_EXTRA_HOSTS.
const AVATAR_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net', 'avatars.githubusercontent.com', 'raw.githubusercontent.com', 'gravatar.com', '*.gravatar.com'];
const EXTRA_AVATAR_HOSTS = String(process.env.WEBHOOK_AVATAR_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const listed = (list, u) => list.some((h) => (h.startsWith('*.') ? u.hostname.endsWith(h.slice(1)) : h === u.hostname || h === u.host));
// 'builtin' or 'extra' (listed by the admin) for an avatar address (a URL) this server may show, else null.
function avatarHost(u) {
  if (!u || u.username || u.password) return null;
  if (listed(EXTRA_AVATAR_HOSTS, u) && (u.protocol === 'https:' || u.protocol === 'http:')) return 'extra';
  if (u.protocol === 'https:' && !u.port && listed(AVATAR_HOSTS, u)) return 'builtin';
  return null;
}

module.exports = { mediaLinks, normalize, avatarHost, TTL_SEC, STEP_SEC };
