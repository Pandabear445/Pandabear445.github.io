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
// Anything that doesn't parse cleanly is left exactly as it was.

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;

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

// ---------------------------------------------------------------- JPEG
function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== SOI) return null;
  const out = [buf.subarray(0, 2)];
  let changed = false;
  let orientation = 0;
  let orientationAt = -1;
  let inScan = false; // after a start-of-scan, compressed image data runs until the next real marker
  let i = 2;
  for (;;) {
    if (inScan) {
      // In image data a 0xFF byte is followed by 0x00 (an escaped FF), a restart marker or another 0xFF (fill);
      // anything else is the next marker.
      const start = i;
      for (;;) {
        i = buf.indexOf(0xff, i);
        if (i < 0 || i >= buf.length - 1) return null; // no end-of-image: not a file we understand
        const next = buf[i + 1];
        if (next === 0 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) { i++; continue; }
        break;
      }
      out.push(buf.subarray(start, i));
      inScan = false;
    }
    if (i >= buf.length || buf[i] !== 0xff) return null;
    let j = i;
    while (j < buf.length && buf[j] === 0xff) j++; // fill bytes
    if (j >= buf.length) return null;
    const marker = buf[j];
    if (marker === EOI) {
      out.push(Buffer.from([0xff, EOI]));
      if (j + 1 < buf.length) changed = true; // whatever follows the image is dropped
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(Buffer.from([0xff, marker])); i = j + 1; continue; }
    if (marker === SOI || marker === 0x00 || j + 3 > buf.length) return null;
    const len = buf.readUInt16BE(j + 1);
    const end = j + 1 + len;
    if (len < 2 || end > buf.length) return null;
    const body = buf.subarray(j + 3, end);
    const isMpf = marker === 0xe2 && body.length >= 4 && body.toString('latin1', 0, 4) === 'MPF\0';
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe || isMpf) {
      changed = true;
      if (marker === 0xe1 && !orientation && body.toString('latin1', 0, 6) === 'Exif\0\0') {
        orientation = tiffOrientation(withoutExifPrefix(body));
        orientationAt = out.length;
      }
    } else {
      out.push(Buffer.concat([Buffer.from([0xff, marker]), buf.subarray(j + 1, end)]));
    }
    if (marker === SOS) inScan = true;
    i = end;
  }
  if (!changed) return null;
  if (orientation > 1) {
    const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), orientationTiff(orientation)]);
    const seg = Buffer.alloc(4);
    seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(exif.length + 2, 2);
    out.splice(orientationAt, 0, seg, exif);
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- PNG
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
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
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const out = [PNG_SIG];
  let changed = false;
  let orientation = 0;
  let orientationAt = -1;
  let ended = false;
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (len > 0x7fffffff || end > buf.length || !/^[A-Za-z]{4}$/.test(type)) return null;
    if (PNG_DROP.has(type)) {
      changed = true;
      if (type === 'eXIf' && !orientation) { orientation = tiffOrientation(withoutExifPrefix(buf.subarray(i + 8, i + 8 + len))); orientationAt = out.length; }
    } else out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) return null;
  if (i < buf.length) changed = true; // data after the end of the image is dropped
  if (!changed) return null;
  if (orientation > 1) out.splice(orientationAt, 0, pngChunk('eXIf', orientationTiff(orientation)));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- WebP
function webpChunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function stripWebp(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const riffEnd = 8 + buf.readUInt32LE(4);
  if (riffEnd > buf.length) return null;
  const out = [];
  let changed = riffEnd < buf.length; // data after the RIFF container is dropped
  let orientation = 0;
  let orientationAt = -1;
  let vp8x = -1;
  let i = 12;
  while (i + 8 <= riffEnd) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    if (i + 8 + len > riffEnd) return null;
    const end = Math.min(riffEnd, i + 8 + len + (len & 1));
    if (type === 'EXIF' || type === 'XMP ') {
      changed = true;
      if (type === 'EXIF' && !orientation) { orientation = tiffOrientation(withoutExifPrefix(buf.subarray(i + 8, i + 8 + len))); orientationAt = out.length; }
    } else {
      if (type === 'VP8X') vp8x = out.length;
      out.push(buf.subarray(i, end));
    }
    i = end;
  }
  if (i !== riffEnd) return null;
  if (!changed) return null;
  if (orientation > 1) out.splice(orientationAt, 0, webpChunk('EXIF', orientationTiff(orientation)));
  if (vp8x >= 0) {
    // The extended header says which optional chunks exist: EXIF (0x08) and XMP (0x04).
    const c = Buffer.from(out[vp8x]);
    if (c.length > 8) c[8] = (c[8] & ~0x0c) | (orientation > 1 ? 0x08 : 0);
    out[vp8x] = c;
  }
  const body = Buffer.concat(out);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

// The picture without its metadata, or null when there was nothing to remove (or the file isn't one we can
// safely rewrite: then it's kept as it is).
function stripImageMetadata(buf) {
  try { return stripJpeg(buf) || stripPng(buf) || stripWebp(buf); } catch { return null; }
}

module.exports = { stripImageMetadata, tiffOrientation, crc32 };
