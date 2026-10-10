// Removes hidden metadata from public pictures (avatars, banners, backgrounds, server icons, emoji, library GIFs).
// A photo straight from a phone usually carries EXIF: the camera, the time and often the exact GPS position where
// it was taken. Anyone who can see a profile picture can download it, so that has to go before it's stored.
//
// No image library is needed: metadata lives in its own blocks, separate from the picture data, so those blocks
// are dropped and everything else is copied byte for byte (the picture is never decoded or re-encoded).
//   JPEG: APP1 (EXIF, XMP), APP13 (Photoshop/IPTC), comments, the MPF index and anything after the end of the
//         image (extra pictures some phones append, like depth maps or "motion photo" data).
//   PNG:  eXIf, tEXt, iTXt (XMP), zTXt and tIME chunks.
//   WebP: EXIF and XMP chunks (and their flags in the VP8X header).
// The orientation is the one EXIF value that changes how a picture looks (a phone photo taken upright is
// stored sideways), so it's written back on its own in a tiny EXIF block. GIFs have no EXIF and are left alone.
//
// A file that's cut off or damaged part way is cleaned as far as it can be read, and the rest is kept as it is
// (browsers still show such files). Metadata comes first in a real photo, so a cut-off phone photo still loses
// its GPS position. A file with far more blocks than any real picture has is refused (ImageRejected): reading
// millions of tiny blocks would only cost time.
//
// Uploads are cleaned in a worker thread (stripFile), so even a big picture never holds up chat for anyone else.
const fs = require('fs');

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
// Real JPEGs have a few dozen markers outside the compressed image data (progressive ones up to about a hundred).
// Real PNG and WebP files have at most some thousands of chunks (a 100 MB PNG cut into 8 KB chunks has about 13,000;
// animations have a few per frame).
const MAX_JPEG_MARKERS = 4096;
const MAX_CHUNKS = 100000;

// The upload is refused: a file no real picture looks like, or one that couldn't be cleaned.
class ImageRejected extends Error {}

// The orientation (1-8) in a TIFF/EXIF block, or 0 if there's none.
function tiffOrientation(t) {
  if (!t || t.length < 8) return 0;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return 0;
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return 0;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 0;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 0; }
  }
  return 0;
}
// EXIF blocks start with "Exif\0\0" in JPEG (and in some WebP files); the TIFF data follows.
const withoutExifPrefix = (b) => (b.length >= 6 && b.toString('latin1', 0, 6) === 'Exif\0\0' ? b.subarray(6) : b);
// A minimal TIFF block holding only the orientation.
function orientationTiff(o) {
  const b = Buffer.alloc(26);
  b.write('MM', 0, 'latin1');
  b.writeUInt16BE(42, 2);
  b.writeUInt32BE(8, 4); // the first (only) directory starts right after the header
  b.writeUInt16BE(1, 8); // one entry:
  b.writeUInt16BE(0x0112, 10); // Orientation
  b.writeUInt16BE(3, 12); // SHORT
  b.writeUInt32BE(1, 14); // one value
  b.writeUInt16BE(o, 18); // (bytes 20-21 stay zero: padding of the 4-byte value field)
  b.writeUInt32BE(0, 22); // no next directory
  return b;
}

// The cleaned file, pieced together from ranges of the original plus a few new bytes. While a file is read the
// ranges are only noted (neighbouring ones merged), and everything is copied once at the end, so reading a block
// allocates nothing.
function pieces(buf) {
  const list = []; // [start, end] of the original, or a Buffer of new bytes
  let size = 0;
  return {
    keep(s, e) {
      if (e <= s) return;
      const last = list[list.length - 1];
      if (Array.isArray(last) && last[1] === s) last[1] = e; else list.push([s, e]);
      size += e - s;
    },
    add(b) { list.push(b); size += b.length; },
    get size() { return size; },
    build() {
      const out = Buffer.allocUnsafe(size);
      let o = 0;
      for (const p of list) o += Array.isArray(p) ? buf.copy(out, o, p[0], p[1]) : p.copy(out, o);
      return out;
    },
  };
}
const tooComplex = () => new ImageRejected('This picture has far more blocks than a real picture has.');

// ---------------------------------------------------------------- JPEG
function stripJpeg(buf) {
  const n = buf.length;
  if (n < 4 || buf[0] !== 0xff || buf[1] !== SOI) return null;
  const out = pieces(buf);
  out.keep(0, 2);
  let changed = false;
  let orientation = 0;
  let markers = 0;
  let i = 2; // where the next marker should start
  for (;;) {
    // Find the marker. Like the decoders, skip stray bytes before it (and an FF 00 pair, which isn't a marker):
    // browsers show such files, so their metadata after the stray bytes must go too. Fill bytes (FF FF…) stay.
    let f = i;
    let j = -1;
    while (f < n) {
      if (buf[f] !== 0xff) { f = buf.indexOf(0xff, f); if (f < 0) break; }
      j = f + 1;
      while (j < n && buf[j] === 0xff) j++;
      if (j >= n) { j = -1; break; }
      if (buf[j] !== 0) break;
      f = j + 1; j = -1;
    }
    if (j < 0) break; // no more markers: keep the rest as it is
    if (++markers > MAX_JPEG_MARKERS) throw tooComplex();
    const marker = buf[j];
    if (marker === EOI) {
      out.keep(f, j + 1);
      if (f > i || j + 1 < n) changed = true; // stray bytes and whatever follows the image are dropped
      return changed ? out.build() : null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // markers without a length
      if (f > i) changed = true;
      out.keep(f, j + 1);
      i = j + 1;
      continue;
    }
    if (marker === SOI || j + 3 > n) break; // a second image start (a broken file) or cut off: keep the rest
    const end = j + 1 + buf.readUInt16BE(j + 1);
    if (end < j + 3 || end > n) break; // cut off part way through this block: keep the rest
    const body = j + 3;
    const isMpf = marker === 0xe2 && end - body >= 4 && buf.toString('latin1', body, body + 4) === 'MPF\0';
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe || isMpf) {
      changed = true;
      if (marker === 0xe1 && !orientation && end - body >= 6 && buf.toString('latin1', body, body + 6) === 'Exif\0\0') {
        orientation = tiffOrientation(buf.subarray(body + 6, end));
        if (orientation > 1) { // written back in place of the block that held it
          const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), orientationTiff(orientation)]);
          const head = Buffer.from([0xff, 0xe1, 0, 0]);
          head.writeUInt16BE(exif.length + 2, 2);
          out.add(head); out.add(exif);
        }
      }
    } else {
      if (f > i) changed = true;
      out.keep(f, end);
    }
    i = end;
    if (marker === SOS) {
      // Compressed image data runs until the next real marker. In it a 0xFF byte is followed by 0x00 (an
      // escaped FF), a restart marker or another 0xFF (fill); anything else is the next marker.
      let k = i;
      let found = false;
      while (!found) {
        k = buf.indexOf(0xff, k);
        if (k < 0) break;
        // Runs of escaped bytes are stepped over right here (a hostile file can be nothing but those).
        while (k + 1 < n && buf[k] === 0xff) {
          const next = buf[k + 1];
          if (next === 0 || (next >= 0xd0 && next <= 0xd7)) k += 2;
          else if (next === 0xff) k++;
          else { found = true; break; }
        }
        if (k + 1 >= n) break;
      }
      if (!found) break; // no end of image (cut off): keep the rest
      out.keep(i, k);
      i = k;
    }
  }
  out.keep(i, n);
  return changed ? out.build() : null;
}

// ---------------------------------------------------------------- PNG
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fourcc = (s) => Buffer.from(s, 'latin1').readUInt32BE(0);
const PNG_EXIF = fourcc('eXIf');
const PNG_IEND = fourcc('IEND');
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].map(fourcc));
const isLetter = (b) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function stripPng(buf) {
  if (buf.length < 8 || buf.compare(PNG_SIG, 0, 8, 0, 8) !== 0) return null;
  const out = pieces(buf);
  out.keep(0, 8);
  let changed = false;
  let orientation = 0;
  let chunks = 0;
  let i = 8;
  while (i + 12 <= buf.length) {
    if (++chunks > MAX_CHUNKS) throw tooComplex();
    const len = buf.readUInt32BE(i);
    const end = i + 12 + len;
    if (len > 0x7fffffff || end > buf.length || !(isLetter(buf[i + 4]) && isLetter(buf[i + 5]) && isLetter(buf[i + 6]) && isLetter(buf[i + 7]))) break; // cut off or damaged: keep the rest
    const type = buf.readUInt32BE(i + 4);
    if (PNG_DROP.has(type)) {
      changed = true;
      if (type === PNG_EXIF && !orientation) {
        orientation = tiffOrientation(withoutExifPrefix(buf.subarray(i + 8, i + 8 + len)));
        if (orientation > 1) out.add(pngChunk('eXIf', orientationTiff(orientation)));
      }
    } else out.keep(i, end);
    i = end;
    if (type === PNG_IEND) {
      if (i < buf.length) changed = true; // data after the end of the image is dropped
      return changed ? out.build() : null;
    }
  }
  out.keep(i, buf.length);
  return changed ? out.build() : null;
}

// ---------------------------------------------------------------- WebP
const WEBP_EXIF = fourcc('EXIF');
const WEBP_XMP = fourcc('XMP ');
const WEBP_VP8X = fourcc('VP8X');
function webpChunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function stripWebp(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const declaredEnd = 8 + buf.readUInt32LE(4);
  const riffEnd = Math.min(declaredEnd, buf.length); // a cut-off file is cleaned as far as it goes
  const out = pieces(buf);
  const head = Buffer.alloc(12); // written at the end, with the new size
  out.add(head);
  let changed = riffEnd < buf.length; // data after the RIFF container is dropped
  let orientation = 0;
  let vp8x = null;
  let chunks = 0;
  let i = 12;
  while (i + 8 <= riffEnd) {
    if (++chunks > MAX_CHUNKS) throw tooComplex();
    const type = buf.readUInt32BE(i);
    const len = buf.readUInt32LE(i + 4);
    if (i + 8 + len > riffEnd) break; // cut off: keep the rest
    const end = Math.min(riffEnd, i + 8 + len + (len & 1));
    if (type === WEBP_EXIF || type === WEBP_XMP) {
      changed = true;
      if (type === WEBP_EXIF && !orientation) {
        orientation = tiffOrientation(withoutExifPrefix(buf.subarray(i + 8, i + 8 + len)));
        if (orientation > 1) out.add(webpChunk('EXIF', orientationTiff(orientation)));
      }
    } else if (type === WEBP_VP8X && !vp8x && len >= 10) {
      vp8x = Buffer.from(buf.subarray(i, end)); // a copy: its flags are updated below
      out.add(vp8x);
    } else out.keep(i, end);
    i = end;
  }
  out.keep(i, riffEnd);
  if (!changed) return null;
  // The extended header says which optional chunks exist: EXIF (0x08) and XMP (0x04).
  if (vp8x) vp8x[8] = (vp8x[8] & ~0x0c) | (orientation > 1 ? 0x08 : 0);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(out.size - 8 + (declaredEnd - riffEnd), 4); // a cut-off file stays exactly as cut off
  head.write('WEBP', 8, 'latin1');
  return out.build();
}

// The picture without its metadata, or null when there was nothing to remove (or it isn't a JPEG, PNG or WebP).
// Throws ImageRejected for a file that can't be cleaned: such a file isn't kept with its metadata by mistake.
function stripImageMetadata(buf) {
  try {
    return stripJpeg(buf) || stripPng(buf) || stripWebp(buf);
  } catch (e) {
    throw e instanceof ImageRejected ? e : new ImageRejected('This picture couldn\u2019t be read.');
  }
}

// ---------------------------------------------------------------- the worker thread
// Uploads are cleaned in a worker (like the news bot's feed reader): it reads the file, writes the cleaned copy
// under a temporary name and renames it over the original, so a failure never leaves half a file. It handles
// pictures in order; if it goes quiet for STRIP_LIMIT_MS (or stops), the picture it was working on is refused and
// the others are handed to a new worker.
const STRIP_LIMIT_MS = +process.env.IMAGE_STRIP_LIMIT_MS || 15000;
let worker = null;
let jobSeq = 0;
let watchdog = null;
const jobs = new Map(); // id -> { file, resolve, reject }, oldest first
function startWorker() {
  const { Worker } = require('worker_threads');
  // The image data itself is outside this limit; the cleaning code needs very little memory of its own.
  const w = new Worker(__filename, { workerData: { imageStripper: true }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  w.on('message', ({ id, size, err, rejected }) => {
    const job = jobs.get(id);
    if (job) {
      jobs.delete(id);
      if (err) job.reject(rejected ? new ImageRejected(err) : new Error(err)); else job.resolve(size);
    }
    arm(); // it's making progress
  });
  w.on('error', () => replaceWorker(w));
  w.on('exit', () => replaceWorker(w));
  return w;
}
function replaceWorker(w) {
  if (!w || worker !== w) return;
  worker = null;
  w.terminate().catch(() => {});
  const first = jobs.keys().next();
  if (!first.done) {
    const job = jobs.get(first.value);
    jobs.delete(first.value);
    fs.promises.unlink(job.file + '.tmp').catch(() => {});
    job.reject(new ImageRejected('This picture couldn\u2019t be checked.'));
  }
  if (jobs.size) {
    try {
      worker = startWorker();
      for (const [id, job] of jobs) worker.postMessage({ id, file: job.file });
    } catch (e) {
      worker = null;
      for (const job of jobs.values()) job.reject(e);
      jobs.clear();
    }
  }
  arm();
}
// Restarts the watchdog, and lets the worker keep the process running only while it has pictures to finish.
function arm() {
  clearTimeout(watchdog);
  watchdog = null;
  if (worker) { if (jobs.size) worker.ref(); else worker.unref(); }
  if (!jobs.size) return;
  watchdog = setTimeout(() => replaceWorker(worker), STRIP_LIMIT_MS);
  watchdog.unref();
}
// Cleans the picture at this path in place. Resolves to its new size, or null if nothing had to be removed.
function stripFile(file) {
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    try { if (!worker) worker = startWorker(); } catch (e) { return reject(e); }
    jobs.set(id, { file, resolve, reject });
    worker.postMessage({ id, file });
    if (!watchdog) arm(); else worker.ref();
  });
}
{
  const { isMainThread, parentPort, workerData } = require('worker_threads');
  if (!isMainThread && workerData && workerData.imageStripper) {
    parentPort.on('message', ({ id, file }) => {
      const tmp = file + '.tmp';
      try {
        const clean = stripImageMetadata(fs.readFileSync(file));
        if (clean) {
          fs.writeFileSync(tmp, clean);
          fs.renameSync(tmp, file);
        }
        parentPort.postMessage({ id, size: clean ? clean.length : null });
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* not written */ }
        parentPort.postMessage({ id, err: String(e.message || e), rejected: e instanceof ImageRejected });
      }
    });
  }
}

module.exports = { stripImageMetadata, stripFile, ImageRejected, tiffOrientation, crc32 };
