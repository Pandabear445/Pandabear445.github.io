// Link previews (docs/design/LINK-PREVIEWS.md): the parts with no page around them, shared by the composer, the
// code that opens messages, and the tests (node --test loads this file as it is).
//
// A preview travels inside the encrypted message as `l: [{ v: 1, url, title, desc, site, kind, img? }]`. The
// sender builds it; readers only check and show it: they never fetch anything for it. Readers accept a preview
// only for a link that's really in the message text (outside code and spoilers), on https, with a host name
// that can't pass for another (no mixed scripts, no bidi tricks), and they work out the domain line themselves,
// so a sender can make a card say anything except where the link goes.
import { linkedUrls, isImageUrl } from './markdown.js';

export const THUMB_MAX_BYTES = 16384;
export const THUMB_B64_MAX = 4 * Math.ceil(THUMB_MAX_BYTES / 3); // 21848
export const TITLE_MAX = 200;
export const DESC_MAX = 300;
export const SITE_MAX = 60;
export const URL_MAX = 2048;
export const THUMB_SIDE = 400;
export const KINDS = new Set(['web', 'video', 'post', 'repo', 'image']);
// The same reserved names server/linkpreview.js refuses to fetch.
const RESERVED_TLDS = new Set(['localhost', 'local', 'lan', 'internal', 'test', 'example', 'invalid', 'onion', 'i2p', 'arpa', 'home', 'corp', 'localdomain']);
const RESERVED_HOSTS = new Set(['example.com', 'example.net', 'example.org']);
// GIF media links keep their own path (the GIF proxy); server/gifmedia.js MEDIA_HOSTS plus Tenor.
export const GIF_MEDIA_RE = /^https:\/\/(media\d*\.giphy\.com|i\.giphy\.com|static\.klipy\.com|static\.klipy\.co|media\.klipy\.com|media\.tenor\.com|c\.tenor\.com)\//i;
// Characters that reorder text (bidi overrides and isolates) or draw boxes: no reason to be in a real link.
const SNEAKY = /[‪-‮⁦-⁩─-◿]/;
const LABEL = /^[a-z0-9-]{1,63}$/;

const hostOf = (s) => { try { return new URL(s.includes('://') ? s : `https://${s}`).hostname; } catch { return ''; } };

// Whether a link may carry a preview. origin: this server (links to it never get one). anyPort: tests only
// (S.config.linkPreviewAnyPort), for stand-in sites on other ports.
export function previewableUrl(url, { origin = '', anyPort = false } = {}) {
  if (typeof url !== 'string' || !url || url.length > URL_MAX || SNEAKY.test(url)) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port !== '' && !anyPort) return false;
  // The host as written: all ASCII or all non-ASCII letters, never a mix (а Cyrillic "а" in "apple.com").
  const raw = (/^https:\/\/([^/?#]*)/i.exec(url) || [])[1] || '';
  const written = raw.replace(/:\d*$/, '').replace(/\./g, '');
  if (/[\x00-\x7f]/.test(written) && /[^\x00-\x7f]/.test(written)) return false;
  const host = u.hostname;
  if (!host || host.length > 253 || host.includes('%') || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  if (RESERVED_TLDS.has(labels[labels.length - 1]) || RESERVED_HOSTS.has(labels.slice(-2).join('.'))) return false;
  if (origin && host === hostOf(origin)) return false;
  return true;
}

// The link the composer offers a preview for: the first one in the text (outside code and spoilers) that may
// have one and isn't already shown another way (image links and GIFs show as pictures).
export function findPreviewUrl(text, opts = {}) {
  return linkedUrls(text, { skipSpoilers: true }).find((u) => previewableUrl(u, opts) && !isImageUrl(u) && !GIF_MEDIA_RE.test(u)) || null;
}

// Links that may be private or work only once (sign-in, reset, invite and share links): in "Always" mode they
// still ask first, since fetching one could use it up or show it to the server.
const PRIVATE_KEYS = /(token|code|key|sig|auth|session|pass|otp|reset|invite|magic|ticket|secret|nonce)/i;
const PRIVATE_PATH = /\/(reset|invite|verify|confirm|unsubscribe|magic|login|signin|sign-in|oauth|auth)(\/|$|[-_.?])/i;
const SHARE_HOSTS = /(^|\.)(docs\.google\.com|drive\.google\.com|meet\.google\.com|dropbox\.com|zoom\.us|1drv\.ms|onedrive\.live\.com|icloud\.com|wetransfer\.com|we\.tl)$/i;
export function looksPrivate(url) {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (SHARE_HOSTS.test(u.hostname)) return true;
  if (PRIVATE_PATH.test(u.pathname)) return true;
  for (const k of u.searchParams.keys()) if (PRIVATE_KEYS.test(k)) return true;
  return false;
}

// Text from a preview, as it may be shown: control, zero-width and bidi characters removed, spaces collapsed,
// cut to `max` characters (counted as code points, so an emoji is never cut in half).
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿￹-￻]/g;
export function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  let t = s.slice(0, 4 * max + 100).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const cps = [...t];
  if (cps.length > max) t = `${cps.slice(0, max - 1).join('').trimEnd()}…`;
  return t;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
function headBytes(data, n) {
  try { const bin = atob(data.slice(0, Math.ceil(n / 3) * 4)); return Array.from(bin, (c) => c.charCodeAt(0)); } catch { return []; }
}
// The thumbnail: WebP or JPEG (what the sender's app makes), at most 16 KiB, its bytes matching its type, and a
// size that fits the card. Anything else is dropped (the card stays).
export function cleanImg(img) {
  if (!img || typeof img !== 'object') return null;
  const { type, data, w, h } = img;
  if (type !== 'image/webp' && type !== 'image/jpeg') return null;
  if (typeof data !== 'string' || !data || data.length > THUMB_B64_MAX || data.length % 4 || !B64.test(data)) return null;
  const bytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > THUMB_MAX_BYTES) return null;
  if (![w, h].every((x) => Number.isInteger(x) && x >= 1 && x <= THUMB_SIDE)) return null;
  const b = headBytes(data, 12);
  const ok = type === 'image/jpeg' ? b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    : String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP';
  return ok ? { type, data, w, h } : null;
}

// What a reader keeps of a message's previews: at most one, checked as described at the top. Never throws.
export function cleanLinks(list, text, opts = {}) {
  if (!Array.isArray(list)) return undefined;
  let linked;
  try { linked = new Set(linkedUrls(text, { skipSpoilers: true })); } catch { return undefined; }
  for (const x of list.slice(0, 3)) {
    if (!x || typeof x !== 'object' || x.v !== 1) continue;
    const url = typeof x.url === 'string' ? x.url : '';
    if (!linked.has(url) || !previewableUrl(url, opts)) continue;
    const out = { v: 1, url, title: cleanText(x.title, TITLE_MAX), desc: cleanText(x.desc, DESC_MAX), site: cleanText(x.site, SITE_MAX), kind: KINDS.has(x.kind) ? x.kind : 'web' };
    const img = cleanImg(x.img);
    if (img) out.img = img;
    if (out.title || out.desc || out.img) return [out];
  }
  return undefined;
}

// A message too big to send with its preview is sent with less of it: first without the picture, then without
// the card. The first one whose ciphertext fits is used (see encryptFitting in app.js).
export function payloadVariants(payload) {
  if (!payload || !Array.isArray(payload.l) || !payload.l.length) return [payload];
  const { l, ...rest } = payload;
  const out = [payload];
  if (l[0] && l[0].img) { const { img, ...card } = l[0]; out.push({ ...rest, l: [card, ...l.slice(1)] }); }
  out.push(rest);
  return out;
}

// The domain line under a card, from the link itself (never from what the sender wrote).
export function hostLabel(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}
