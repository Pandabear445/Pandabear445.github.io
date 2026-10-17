// Attachment entries arrive inside encrypted messages, so whoever sent the message chose every field of them,
// including the address. The server can't check (it only sees ciphertext), so the app does: only files stored on
// this Hearth server (/uploads/<name>) are kept. An address anywhere else would let the sender see who opened the
// message and from where (a "tracking pixel"), or turn a click on a file card into a jump to a look-alike site.

const UPLOAD_PATH = /^\/uploads\/[a-z0-9]+(\.[a-z0-9]{1,8})?$/i;
export const MAX_FILES = 10; // the app sends at most 10 attachments per message
export const ALT_MAX = 1000; // an image description (alt text), as the attachment dialog allows

export const isUploadUrl = (u) => typeof u === 'string' && UPLOAD_PATH.test(u);

// The attachment list of a decrypted message, keeping only well-formed entries that point at this server.
export function cleanFiles(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list) {
    if (out.length >= MAX_FILES) break;
    if (!f || typeof f !== 'object' || !isUploadUrl(f.url)) continue;
    const e = { ...f, name: String(f.name || '').slice(0, 255), type: String(f.type || '').slice(0, 100), size: Math.max(0, +f.size || 0) };
    if (f.th !== undefined && !(f.th && typeof f.th === 'object' && isUploadUrl(f.th.url))) delete e.th; // a broken thumbnail just isn't shown
    // The sender's description (alt text) is words only, and "spoiler" is a plain yes or no.
    const alt = typeof f.alt === 'string' ? f.alt.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, ALT_MAX) : '';
    if (alt) e.alt = alt; else delete e.alt;
    if (f.sp === 1 || f.sp === true) e.sp = 1; else delete e.sp;
    out.push(e);
  }
  return out;
}

// Where a download link may point: a decrypted copy in this app's memory (blob:) or a file on this server.
export function safeDownloadHref(href, origin) {
  if (typeof href !== 'string') return null;
  if (href.startsWith('blob:')) return href.startsWith(`blob:${origin}/`) ? href : null;
  if (!isUploadUrl(href)) return null;
  try { return new URL(href, origin).origin === origin ? href : null; } catch { return null; }
}
