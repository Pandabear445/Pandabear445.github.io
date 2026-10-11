// Pictures and videos from other sites (xss-8). Loading one shows that site your IP address (and when you looked),
// so an image link in a message waits for a click unless you chose otherwise in Settings → Privacy & safety, and a
// watch-together video file from another site says so before it loads. Things that come through this server
// (uploads, GIFs through its GIF proxy) or inside the encrypted message (link preview pictures) aren't "outside".
import { isUploadUrl } from './attachments.js';

export const OUTSIDE_MODES = ['ask', 'always', 'never'];
export const OUTSIDE_LABELS = { ask: 'Ask first', always: 'Always load', never: 'Never load' };

// The person's choice, from their synced privacy settings; anything unknown means the default, ask first.
export function outsideMode(privacy) {
  const v = privacy && privacy.outsideImages;
  return OUTSIDE_MODES.includes(v) ? v : 'ask';
}

// Whether loading `src` (as the app would put it in the page) contacts a site other than this Hearth server.
// Relative addresses, this server's own and data:/blob: ones stay here; anything that doesn't parse counts as outside.
export function isOutside(src, origin) {
  const s = String(src || '');
  if (/^(data|blob):/i.test(s)) return false;
  try { return new URL(s, origin + '/').origin !== origin; } catch { return true; }
}

// The site a link goes to, as people know it (no "www."), for "Image from …" and the watch-together notice.
export function outsideHost(src) {
  try { return new URL(src).host.replace(/^www\./i, ''); } catch { return 'another site'; }
}

// Where an image link in a message (an address the sender wrote) would load from:
//   'here'     only this server, with nothing fetched from anywhere else: a file uploaded here (/uploads/<name>),
//              or a GIPHY/KLIPY link the app itself sends through this server's GIF proxy (`viaProxy`)
//   'server'   any other address on this server. Not shown as a picture: /media/news, /media/art and /media/gif
//              typed into a message carry the sender's own token and their choice of site (?u=), so showing one
//              would have this server fetch that site for every reader (telling the sender when it's read),
//              whatever the reader chose for outside images
//   'outside'  another site, which would see the reader's IP address
export function imagePlace(link, { origin, viaProxy = false }) {
  if (viaProxy) return 'here';
  let url;
  try { url = new URL(String(link || ''), origin + '/'); } catch { return 'outside'; }
  if (url.origin !== origin) return 'outside';
  return isUploadUrl(url.pathname) ? 'here' : 'server';
}

// What a message shows for an image link: 'show' (load it now), 'ask' (a placeholder with a Load button),
// 'hidden' (a placeholder without one) or 'skip' (no picture: the link stays a plain link). `link` is the address
// as written in the message, `viaProxy` whether the app loads it through this server's GIF proxy, `opened`
// whether the viewer already clicked Load on this link in this message, this session (openedLinks).
export function imageDecision(link, { origin, viaProxy = false, mode = 'ask', opened = false }) {
  const place = imagePlace(link, { origin, viaProxy });
  if (place === 'here') return 'show';
  if (place === 'server') return 'skip';
  if (mode === 'never') return 'hidden';
  if (mode === 'always' || opened) return 'show';
  return 'ask';
}

// The Load clicks of this session, by message and link, so a redraw of that message doesn't ask again. Not by link
// alone: a later message with the same link asks again, or its sender (serving the picture uncached) would learn
// when each one is read, without the reader being asked. A link with no message to go with it isn't remembered.
export function openedLinks() {
  const seen = new Set();
  const key = (messageId, link) => `${messageId}\n${link}`;
  return {
    add(messageId, link) { if (messageId) seen.add(key(messageId, link)); },
    has(messageId, link) { return !!messageId && seen.has(key(messageId, link)); },
  };
}

// A watch-together item that loads straight from another site (a direct video file). YouTube, Vimeo and Twitch
// play in their own frames, which say whose player it is, so they don't get a notice.
export function outsideVideoHost(item, origin) {
  if (!item || item.kind !== 'video') return null;
  return isOutside(item.src, origin) ? outsideHost(item.src) : null;
}
