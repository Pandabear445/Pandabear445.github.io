// Image preparation before encrypting and sending:
//  - big photos are resized (max 2560 px) and re-encoded as WebP/JPEG — usually 5–15× smaller. Re-encoding
//    also drops hidden metadata such as the GPS location some phones embed in photos;
//  - a small thumbnail (max 480 px) is made so chats show images instantly and load full size on demand.
// GIFs (animation) and SVGs are sent as they are.
const RESIZABLE = /^image\/(jpeg|png|webp|bmp)$/i;
const MAX_SIDE = 2560;
const THUMB_SIDE = 480;

function canvasOf(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
async function encode(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
async function scaled(bitmap, maxSide, quality) {
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  const c = canvasOf(w, h);
  const g = c.getContext('2d', { alpha: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, w, h);
  let blob = await encode(c, 'image/webp', quality);
  if (!blob || blob.type !== 'image/webp') blob = await encode(c, 'image/jpeg', quality); // older Safari
  return { blob, w, h };
}

// Returns { file, w, h, thumb } — `file` may be a smaller re-encoded copy; `thumb` is a Blob or null.
export async function prepareImage(file, { compress = true } = {}) {
  if (!/^image\//i.test(file.type) || /gif|svg/i.test(file.type) || typeof createImageBitmap !== 'function') return { file, w: 0, h: 0, thumb: null };
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return { file, w: 0, h: 0, thumb: null }; }
  const out = { file, w: bitmap.width, h: bitmap.height, thumb: null };
  try {
    if (compress && RESIZABLE.test(file.type) && (file.size > 1.2 * 1024 * 1024 || Math.max(bitmap.width, bitmap.height) > MAX_SIDE)) {
      const big = await scaled(bitmap, MAX_SIDE, 0.86);
      if (big.blob && big.blob.size < file.size) {
        const ext = big.blob.type === 'image/webp' ? 'webp' : 'jpg';
        out.file = new File([big.blob], file.name.replace(/\.[^.]+$/, '') + '.' + ext, { type: big.blob.type });
        out.w = big.w; out.h = big.h;
      }
    }
    if (Math.max(bitmap.width, bitmap.height) > THUMB_SIDE * 1.3 || file.size > 150 * 1024) out.thumb = (await scaled(bitmap, THUMB_SIDE, 0.72)).blob;
  } finally { bitmap.close && bitmap.close(); }
  return out;
}

// Load things one-by-one-ish: at most `limit` downloads/decryptions at the same time.
export function makeQueue(limit = 3) {
  let active = 0;
  const waiting = [];
  const next = () => {
    while (active < limit && waiting.length) {
      const { fn, resolve, reject } = waiting.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
    }
  };
  return (fn, { front = false } = {}) => new Promise((resolve, reject) => { (front ? waiting.unshift.bind(waiting) : waiting.push.bind(waiting))({ fn, resolve, reject }); next(); });
}

// Run `cb` once when `el` comes near the screen.
const seen = new WeakMap();
const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { const cb = seen.get(e.target); if (cb) { seen.delete(e.target); io.unobserve(e.target); cb(); } }
}, { rootMargin: '600px 0px' }) : null;
export function whenVisible(el, cb) {
  if (!io) return cb();
  seen.set(el, cb);
  io.observe(el);
}
