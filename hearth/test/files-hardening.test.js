// Uploads, attachments, the media proxies and the GIF library, attacked the way the security review did:
// form-field floods, parallel uploads racing the quota, files left behind by deletions, GIF-library uploads that
// skipped storage accounting, attachment addresses pointing at other sites, profile photos keeping their GPS
// position, proxies following redirects or buffering huge answers, and a client choosing what the GIF library learns.
// Each test checks that the attack is refused AND that normal use still works.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { startServer, sleep } = require('./helpers');
const { stripImageMetadata, stripFile, ImageRejected, tiffOrientation, crc32 } = require('../server/imagemeta');

// ------------------------------------------------------------------ picture fixtures
// A 12x8 JPEG made by Chromium (it carries an ICC colour profile in APP2, which must survive).
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAwDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAbEAABBAMAAAAAAAAAAAAAAAAAAgcjoQQFMv/EABUBAQEAAAAAAAAAAAAAAAAAAAME/8QAGxEAAQQDAAAAAAAAAAAAAAAABAAFBjISE0H/2gAMAwEAAhEDEQA/AJXSN/zFRbYjfwJhoAgOdScrI4o9F6rcX//Z', 'base64');
// EXIF with a GPS position, an orientation and a description: what a phone photo carries.
function exifTiff(orientation = 6) {
  const desc = Buffer.from('SECRET-GPS-48.8584N-2.2945E\0', 'latin1');
  const descOff = 8 + 2 + 3 * 12 + 4;
  const gpsOff = descOff + desc.length + (desc.length & 1);
  const ratOff = gpsOff + 2 + 2 * 12 + 4;
  const b = Buffer.alloc(ratOff + 24);
  b.write('MM', 0, 'latin1'); b.writeUInt16BE(42, 2); b.writeUInt32BE(8, 4);
  let p = 8;
  b.writeUInt16BE(3, p); p += 2;
  const entry = (tag, type, count, value, short) => { b.writeUInt16BE(tag, p); b.writeUInt16BE(type, p + 2); b.writeUInt32BE(count, p + 4); if (short) b.writeUInt16BE(value, p + 8); else b.writeUInt32BE(value, p + 8); p += 12; };
  entry(0x010e, 2, desc.length, descOff); // ImageDescription
  entry(0x0112, 3, 1, orientation, true); // Orientation
  entry(0x8825, 4, 1, gpsOff); // GPS directory
  desc.copy(b, descOff);
  p = gpsOff;
  b.writeUInt16BE(2, p); p += 2;
  b.writeUInt16BE(1, p); b.writeUInt16BE(2, p + 2); b.writeUInt32BE(2, p + 4); b.write('N\0', p + 8, 'latin1'); p += 12; // GPSLatitudeRef
  b.writeUInt16BE(2, p); b.writeUInt16BE(5, p + 2); b.writeUInt32BE(3, p + 4); b.writeUInt32BE(ratOff, p + 8); // GPSLatitude
  [[48, 1], [51, 1], [2952, 100]].forEach(([n, d], k) => { b.writeUInt32BE(n, ratOff + k * 8); b.writeUInt32BE(d, ratOff + k * 8 + 4); });
  return b;
}
const jpegSeg = (marker, body) => { const h = Buffer.alloc(4); h[0] = 0xff; h[1] = marker; h.writeUInt16BE(body.length + 2, 2); return Buffer.concat([h, body]); };
// JPEG + EXIF/GPS, XMP, IPTC, a comment and a "motion photo" trailer after the end of the image.
function jpegWithMeta(orientation = 6) {
  const at = 4 + JPEG.readUInt16BE(4); // after SOI + APP0
  return Buffer.concat([JPEG.subarray(0, at),
    jpegSeg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff(orientation)])),
    jpegSeg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>SECRET-XMP-GPS</x:xmpmeta>', 'latin1')),
    jpegSeg(0xed, Buffer.from('Photoshop 3.0\0SECRET-IPTC-CITY', 'latin1')),
    jpegSeg(0xfe, Buffer.from('SECRET-COMMENT', 'latin1')),
    JPEG.subarray(at), Buffer.from('SECRET-TRAILER', 'latin1')]);
}
// Segments of a JPEG up to the start of scan: [{ marker, body }].
function jpegSegments(buf) {
  const out = [];
  let i = 2;
  while (i < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    out.push({ marker, body: buf.subarray(i + 4, i + 2 + len) });
    if (marker === 0xda) { out.push({ marker: 'scan', body: buf.subarray(i) }); break; }
    i += 2 + len;
  }
  return out;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const PNG_W = 5; const PNG_H = 3;
const PNG_RAW = Buffer.alloc(PNG_H * (1 + PNG_W * 3), 0).map((v, i) => (i % (1 + PNG_W * 3) === 0 ? 0 : (i * 37) & 255));
function makePng(extra = []) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(PNG_W, 0); ihdr.writeUInt32BE(PNG_H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', zlib.deflateSync(PNG_RAW)), pngChunk('IEND', Buffer.alloc(0))]);
}
const pngWithMeta = () => makePng([pngChunk('eXIf', exifTiff(6)), pngChunk('tEXt', Buffer.from('Comment\0SECRET-PNG-TEXT', 'latin1')),
  pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>SECRET-XMP</x:xmpmeta>', 'latin1')), pngChunk('tIME', Buffer.from([7, 234, 10, 10, 12, 0, 0]))]);
// Every chunk of a PNG, with its CRC checked.
function pngChunks(buf) {
  const out = [];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i); const type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    assert.equal(buf.readUInt32BE(i + 8 + len), crc32(buf.subarray(i + 4, i + 8 + len)), `CRC of ${type}`);
    out.push({ type, data });
    i += 12 + len;
  }
  return out;
}
function fakeGif(bytes = 2000) { const b = Buffer.alloc(bytes, 0x20); Buffer.from('GIF89a').copy(b, 0); b.writeUInt16LE(40, 6); b.writeUInt16LE(30, 8); return b; }
const PNG = makePng();
const has = (buf, s) => buf.includes(Buffer.from(s, 'latin1'));
const webpCh = (t, d) => { const h = Buffer.alloc(8); h.write(t, 0, 'latin1'); h.writeUInt32LE(d.length, 4); return Buffer.concat([h, d, Buffer.alloc(d.length & 1)]); };
// WebP with a VP8X header (alpha, EXIF and XMP flags), EXIF with orientation 6, XMP and some "image data".
function webpWithMeta() {
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x0c | 0x10; vp8x.writeUIntLE(4, 4, 3); vp8x.writeUIntLE(2, 7, 3);
  const body = Buffer.concat([webpCh('VP8X', vp8x), webpCh('EXIF', exifTiff(6)), webpCh('XMP ', Buffer.from('<x:xmpmeta>SECRET</x:xmpmeta>')),
    webpCh('ALPH', Buffer.from('alpha!')), webpCh('VP8 ', Buffer.from('imagedata'.repeat(20)))]);
  const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), body]); riff.writeUInt32LE(riff.length - 8, 4);
  return riff;
}
// Files no camera makes: millions of empty blocks, which used to keep the server busy for seconds and use hundreds
// of MB of memory while it looked for metadata.
const MIB = 1024 * 1024;
function manyBlockJpeg(bytes) {
  const n = Math.floor((bytes - 12) / 4);
  const b = Buffer.alloc(8 + n * 4 + 2);
  b.writeUInt32BE(0xffd8fffe, 0); b.writeUInt16BE(4, 4); b.write('hi', 6, 'latin1'); // start of image, a comment
  for (let k = 0; k < n; k++) b.writeUInt32BE(0xffe30002, 8 + k * 4); // empty APP3 blocks
  b.writeUInt16BE(0xffd9, 8 + n * 4);
  return b;
}
function manyChunkPng(bytes) {
  const n = Math.floor((bytes - 8) / 12);
  const b = Buffer.alloc(8 + n * 12);
  PNG.copy(b, 0, 0, 8);
  for (let k = 0; k < n; k++) b.write(k % 2 ? 'tEXt' : 'abCd', 8 + k * 12 + 4, 'latin1'); // empty chunks, kept and dropped in turn
  return b;
}
function manyChunkWebp(bytes) {
  const n = Math.floor((bytes - 12) / 8);
  const b = Buffer.alloc(12 + n * 8);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(b.length - 8, 4); b.write('WEBP', 8, 'latin1');
  for (let k = 0; k < n; k++) b.write(k % 2 ? 'XMP ' : 'ANMF', 12 + k * 8, 'latin1');
  return b;
}

// ------------------------------------------------------------------ multipart
function multipart({ field = 'file', filename = 'a.bin', type = 'application/octet-stream', bytes, fields = [] }) {
  const boundary = '----hearth' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (bytes) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), bytes, Buffer.from('\r\n'));
  for (const [name, value] of fields) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`), Buffer.from(value), Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { raw: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const post = (srv, u, p, form, timeout = 30000) => srv.api('POST', p, { token: u.token, ip: u.ip, ...multipart(form), timeout });
const as = (srv, u, m, p, body) => srv.api(m, p, { token: u.token, ip: u.ip, body });
const fileOf = (srv, url) => path.join(srv.dir, 'uploads', path.basename(url));

// ------------------------------------------------------------------ a fake GIF provider / picture host
// KLIPY's API shape, GIF media, a huge answer without a size, and redirects (some to a host that isn't allowed).
// Every request it gets is noted in st.seen: the path asked for and any login sent.
function startFake() {
  const st = { search: 0, posts: 0, media: 0, sent: {}, closedEarly: {}, otherHost: 0, seen: [] };
  const other = http.createServer((req, res) => { st.otherHost++; res.writeHead(200, { 'content-type': 'image/gif' }); res.end(fakeGif()); });
  const srv = http.createServer((req, res) => {
    st.seen.push({ url: req.url, auth: req.headers.authorization });
    const u = new URL(req.url, 'http://x');
    const base = `http://127.0.0.1:${srv.address().port}`;
    const item = (id, title) => ({ id, content_description: title, media_formats: { gif: { url: `${base}/media/${id}.gif`, dims: [40, 30], size: 2000 }, tinygif: { url: `${base}/media/${id}-tiny.gif`, dims: [40, 30], size: 2000 } } });
    if (u.pathname === '/v2/search' || u.pathname === '/v2/featured') {
      st.search++;
      const q = u.searchParams.get('q') || 'trending';
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results: [item(q.replace(/\W/g, '') + 'id', `Title for ${q}`)], next: '' }));
    }
    if (u.pathname === '/v2/posts') { st.posts++; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ results: [item(u.searchParams.get('ids'), 'emoji')] })); }
    if (u.pathname.startsWith('/media/')) { st.media++; res.writeHead(200, { 'content-type': 'image/gif' }); return res.end(fakeGif()); }
    if (u.pathname === '/redirect-out') { res.writeHead(302, { location: `http://localhost:${other.address().port}/x.gif` }); return res.end(); }
    if (u.pathname === '/redirect-in') { res.writeHead(302, { location: `${base}/media/ok.gif` }); return res.end(); }
    // The allowed host as a login in front of another host, and a scheme-relative jump to another host.
    if (u.pathname === '/redirect-login') { res.writeHead(302, { location: `http://127.0.0.1:${srv.address().port}@localhost:${other.address().port}/x.gif` }); return res.end(); }
    if (u.pathname === '/redirect-slashes') { res.writeHead(302, { location: `//localhost:${other.address().port}/x.gif` }); return res.end(); }
    if (u.pathname.startsWith('/huge')) {
      // 100 MB of "image" with no Content-Length, written as fast as the reader takes it.
      const key = u.pathname;
      st.sent[key] = 0;
      res.writeHead(200, { 'content-type': u.pathname.includes('gif') ? 'image/gif' : 'image/jpeg' });
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      let closed = false;
      res.on('close', () => { closed = true; st.closedEarly[key] = st.sent[key] < 100 * 1024 * 1024; });
      const pump = () => {
        while (!closed && st.sent[key] < 100 * 1024 * 1024) {
          st.sent[key] += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        if (!closed) res.end();
      };
      return pump();
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => other.listen(0, '127.0.0.1', () => srv.listen(0, '127.0.0.1', () => resolve({
    st, port: srv.address().port, otherPort: other.address().port, base: `http://127.0.0.1:${srv.address().port}`,
    close: () => { srv.closeAllConnections(); other.closeAllConnections(); srv.close(); other.close(); },
  }))));
}

let srv; let fake; let owner;
before(async () => {
  fake = await startFake();
  srv = await startServer({ KLIPY_API_BASE: fake.base, GIF_PROXY_EXTRA_HOSTS: `127.0.0.1:${fake.port}`, ART_PROXY_EXTRA_HOSTS: `127.0.0.1:${fake.port}`, ORPHAN_SWEEP_DELAY_MS: '1500' });
  owner = srv.owner;
  const r = await srv.api('PATCH', '/admin/settings', { token: owner.token, ip: owner.ip, body: { klipyKey: 'test-key', gifProvider: 'klipy' } });
  assert.equal(r.status, 200, r.text);
});
after(async () => { if (srv) await srv.stop(); if (fake) fake.close(); });

// ------------------------------------------------------------------ files-1: form-field floods
test('files-1: an upload with a flood of text fields is refused before it can fill memory; normal uploads still work', async () => {
  const u = await srv.register('flooder');
  const many = Array.from({ length: 50 }, (_, i) => [`x${i}`, 'A'.repeat(100 * 1024)]);
  const r1 = await post(srv, u, '/upload/encrypted', { bytes: Buffer.from('ciphertext'), fields: many });
  assert.equal(r1.status, 400, r1.text);
  assert.equal(r1.json.code, 'form_limit');
  const r2 = await post(srv, u, '/upload/encrypted', { bytes: Buffer.from('ciphertext'), fields: [['big', 'B'.repeat(64 * 1024)]] });
  assert.equal(r2.status, 400, 'one oversized field');
  const r3 = await post(srv, u, '/gifs/library', { filename: 'x.gif', type: 'image/gif', bytes: fakeGif(), fields: Array.from({ length: 20 }, (_, i) => [`t${i}`, 'x']) });
  assert.equal(r3.status, 400, 'GIF library route has the same limits');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM user_files WHERE user_id = ?', u.id)[0].n, 0, 'refused uploads leave nothing behind');
  assert.equal((await srv.api('GET', '/config')).status, 200, 'server still answers');
  // Legit: a picture with its crop field.
  const ok = await post(srv, u, '/me/media/avatar', { filename: 'a.png', type: 'image/png', bytes: PNG, fields: [['crop', JSON.stringify({ x: 0, y: 0, z: 1 })]] });
  assert.equal(ok.status, 200, ok.text);
  const enc = await post(srv, u, '/upload/encrypted', { bytes: crypto.randomBytes(5000) });
  assert.equal(enc.status, 200, enc.text);
});

// ------------------------------------------------------------------ files-3: quota and daily limit races
async function race(u, n, size) {
  const results = await Promise.all(Array.from({ length: n }, () => post(srv, u, '/upload/encrypted', { bytes: crypto.randomBytes(size) })));
  return results.map((r) => r.status);
}
test('files-3: parallel uploads cannot overrun the storage quota or the daily allowance', async () => {
  const MB = 1024 * 1024;
  const size = Math.floor(1.5 * MB);
  try {
    let r = await srv.api('PUT', '/admin/limits', { token: owner.token, ip: owner.ip, body: { quotaMb: 2, fileMb: 5, dailyMb: 500 } });
    assert.equal(r.status, 200, r.text);
    const a = await srv.register('racer1');
    const s1 = await race(a, 3, size);
    assert.equal(s1.filter((s) => s === 200).length, 1, `exactly one fits: ${s1}`);
    assert.ok(s1.every((s) => s === 200 || s === 413 || s === 429), String(s1));
    const stored = srv.sql('SELECT COALESCE(SUM(size), 0) n FROM user_files WHERE user_id = ?', a.id)[0].n;
    assert.ok(stored <= 2 * MB, `stored ${stored} <= quota`);

    const b = await srv.register('racer2');
    const s2 = await race(b, 8, size);
    assert.equal(s2.filter((s) => s === 200).length, 1, `eight at once, still one: ${s2}`);
    assert.ok(srv.sql('SELECT COALESCE(SUM(size), 0) n FROM user_files WHERE user_id = ?', b.id)[0].n <= 2 * MB);

    r = await srv.api('PUT', '/admin/limits', { token: owner.token, ip: owner.ip, body: { quotaMb: 100, dailyMb: 2 } });
    assert.equal(r.status, 200);
    const c = await srv.register('racer3');
    const s3 = await race(c, 3, size);
    assert.equal(s3.filter((s) => s === 200).length, 1, `daily allowance: ${s3}`);
    assert.ok(srv.sql('SELECT COALESCE(SUM(size), 0) n FROM user_files WHERE user_id = ?', c.id)[0].n <= 2 * MB);

    // No file of a refused upload is left on disk: every .bin there has a quota row.
    const onDisk = fs.readdirSync(path.join(srv.dir, 'uploads')).filter((f) => f.endsWith('.bin'));
    const rows = new Set(srv.sql('SELECT name FROM user_files').map((x) => x.name));
    await sleep(200);
    assert.deepEqual(onDisk.filter((f) => !rows.has(f) && fs.existsSync(path.join(srv.dir, 'uploads', f))), []);
    // Legit: one at a time, within the limits, still works.
    const d = await srv.register('racer4');
    assert.equal((await post(srv, d, '/upload/encrypted', { bytes: crypto.randomBytes(size) })).status, 200);
  } finally {
    await srv.api('PUT', '/admin/limits', { token: owner.token, ip: owner.ip, body: { quotaMb: 1000, fileMb: 25, dailyMb: 500 } });
  }
});

// ------------------------------------------------------------------ files-4: GIF library accounting
test('files-4: GIF library uploads count toward storage, respect quota and the GIF switch, and admins can delete them', async () => {
  const u = await srv.register('gifguy');
  const gif = fakeGif(200 * 1024);
  const r = await post(srv, u, '/gifs/library', { filename: 'x.gif', type: 'image/gif', bytes: gif, fields: [['title', 'cat'], ['tags', 'cat funny']] });
  assert.equal(r.status, 200, r.text);
  const lib = srv.sql('SELECT file, size, added_by FROM gif_library WHERE added_by = ?', u.id);
  assert.equal(lib.length, 1);
  const row = srv.sql('SELECT kind, size FROM user_files WHERE name = ?', lib[0].file)[0];
  assert.deepEqual(row, { kind: 'gif', size: gif.length }, 'recorded like any other upload');
  assert.equal((await as(srv, u, 'GET', '/me/storage')).json.used, gif.length);

  // Over quota: refused (and nothing is stored).
  assert.equal((await srv.api('PATCH', `/admin/users/${u.id}/limits`, { token: owner.token, ip: owner.ip, body: { quotaMb: 1 } })).status, 200);
  const big = await post(srv, u, '/gifs/library', { filename: 'big.gif', type: 'image/gif', bytes: fakeGif(1024 * 1024) });
  assert.equal(big.status, 413, big.text);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM gif_library WHERE added_by = ?', u.id)[0].n, 1);
  // Blocked word in the title: refused, and the file and its quota row are gone again.
  await srv.api('PUT', '/admin/words', { token: owner.token, ip: owner.ip, body: { words: ['zorkbad'] } });
  const bad = await post(srv, u, '/gifs/library', { filename: 'b.gif', type: 'image/gif', bytes: fakeGif(), fields: [['title', 'zorkbad cat']] });
  assert.equal(bad.status, 400);
  await sleep(100);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM user_files WHERE user_id = ?', u.id)[0].n, 1);
  await srv.api('PUT', '/admin/words', { token: owner.token, ip: owner.ip, body: { words: [] } });

  // GIFs switched off: the library can't be added to either.
  await srv.api('PUT', '/admin/owner', { token: owner.token, ip: owner.ip, body: { features: { gifs: false } } });
  const off = await post(srv, u, '/gifs/library', { filename: 'c.gif', type: 'image/gif', bytes: fakeGif() });
  assert.equal(off.status, 404);
  await srv.api('PUT', '/admin/owner', { token: owner.token, ip: owner.ip, body: { features: { gifs: true } } });

  // Admin: "delete everything they uploaded" includes their library GIFs.
  const del = await srv.api('DELETE', `/admin/users/${u.id}/files`, { token: owner.token, ip: owner.ip });
  assert.equal(del.status, 200, del.text);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM gif_library WHERE added_by = ?', u.id)[0].n, 0);
  await sleep(100);
  assert.equal((await srv.call('GET', '/uploads/' + lib[0].file)).status, 404);
  // Blocked accounts can't add to the library.
  await srv.api('PATCH', `/admin/users/${u.id}/limits`, { token: owner.token, ip: owner.ip, body: { uploadsBlocked: true, quotaMb: null } });
  assert.equal((await post(srv, u, '/gifs/library', { filename: 'd.gif', type: 'image/gif', bytes: fakeGif() })).status, 403);
});

// ------------------------------------------------------------------ files-2 / data-5: cleanup on deletion
async function shared(a, b, name) {
  const s = (await as(srv, a, 'POST', '/servers', { name })).json;
  const { code } = (await as(srv, a, 'POST', `/servers/${s.id}/invites`, {})).json;
  assert.equal((await as(srv, b, 'POST', `/invites/${code}/join`)).status, 200);
  return s;
}
async function encUpload(u) {
  const r = await post(srv, u, '/upload/encrypted', { bytes: crypto.randomBytes(200000) });
  assert.equal(r.status, 200, r.text);
  return r.json.url;
}
// A message with an attachment, a reaction and a poll vote.
async function populate(sid, chId, author, other) {
  srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', sid);
  const url = await encUpload(author);
  const m = await as(srv, author, 'POST', `/channels/${chId}/messages`, { ciphertext: 'v2:' + crypto.randomBytes(30).toString('base64'), epoch: 1, files: [url] });
  assert.equal(m.status, 200, m.text);
  assert.equal((await as(srv, other, 'POST', `/messages/${m.json.id}/reactions`, { emoji: '👍' })).status, 200);
  assert.equal((await as(srv, other, 'POST', `/polls/${m.json.id}/vote`, { choices: [1] })).status, 200);
  assert.equal((await as(srv, author, 'POST', `/polls/${m.json.id}/close`)).status, 200);
  return { mid: m.json.id, url, name: path.basename(url) };
}
const leftovers = (mid, name) => ({
  blobRows: srv.sql('SELECT COUNT(*) n FROM blobs WHERE name = ?', name)[0].n,
  fileOnDisk: fs.existsSync(path.join(srv.dir, 'uploads', name)),
  userFiles: srv.sql('SELECT COUNT(*) n FROM user_files WHERE name = ?', name)[0].n,
  reactions: srv.sql('SELECT COUNT(*) n FROM reactions WHERE message_id = ?', mid)[0].n,
  pollVotes: srv.sql('SELECT COUNT(*) n FROM poll_votes WHERE message_id = ?', mid)[0].n,
  pollClosed: srv.sql('SELECT COUNT(*) n FROM poll_closed WHERE message_id = ?', mid)[0].n,
});
const NOTHING = { blobRows: 0, fileOnDisk: false, userFiles: 0, reactions: 0, pollVotes: 0, pollClosed: 0 };

test('files-2: deleting a server removes its emoji, banner and background files and their quota rows', async () => {
  const a = await srv.register('srvowner');
  const s = (await as(srv, a, 'POST', '/servers', { name: 'Doomed' })).json;
  assert.equal((await post(srv, a, `/servers/${s.id}/emojis`, { filename: 'e.png', type: 'image/png', bytes: PNG, fields: [['name', 'blobcat']] })).status, 200);
  assert.equal((await post(srv, a, `/servers/${s.id}/media/banner`, { filename: 'b.png', type: 'image/png', bytes: PNG })).status, 200);
  assert.equal((await post(srv, a, `/servers/${s.id}/media/background`, { filename: 'g.png', type: 'image/png', bytes: PNG })).status, 200);
  assert.equal((await srv.api('POST', `/servers/${s.id}/icon`, { token: a.token, ip: a.ip, ...multipart({ field: 'icon', filename: 'i.png', type: 'image/png', bytes: PNG }) })).status, 200);
  const th = JSON.parse(srv.sql('SELECT theme FROM servers WHERE id = ?', s.id)[0].theme);
  const urls = [srv.sql('SELECT url FROM emojis WHERE server_id = ?', s.id)[0].url, th.banner, th.background.image, srv.sql('SELECT icon FROM servers WHERE id = ?', s.id)[0].icon];
  for (const u of urls) assert.equal((await srv.call('GET', u)).status, 200);
  assert.equal((await as(srv, a, 'DELETE', `/servers/${s.id}`, { authKey: a.authKey })).status, 200);
  await sleep(150);
  for (const u of urls) assert.equal((await srv.call('GET', u)).status, 404, `${u} removed`);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM user_files WHERE user_id = ?', a.id)[0].n, 0, 'quota freed');
  assert.equal((await as(srv, a, 'GET', '/me/storage')).json.used, 0);
});

test('files-2: switching a server background from a picture to colours removes the picture', async () => {
  const a = await srv.register('themer');
  const s = (await as(srv, a, 'POST', '/servers', { name: 'Themes' })).json;
  assert.equal((await post(srv, a, `/servers/${s.id}/media/background`, { filename: 'g.png', type: 'image/png', bytes: PNG })).status, 200);
  const img = JSON.parse(srv.sql('SELECT theme FROM servers WHERE id = ?', s.id)[0].theme).background.image;
  // Changing only the dim keeps it.
  assert.equal((await as(srv, a, 'PATCH', `/servers/${s.id}`, { theme: { background: { kind: 'image', dim: 0.5 } } })).status, 200);
  assert.equal((await srv.call('GET', img)).status, 200);
  assert.equal((await as(srv, a, 'PATCH', `/servers/${s.id}`, { theme: { background: { kind: 'gradient', colors: ['#112233', '#445566'] } } })).status, 200);
  await sleep(100);
  assert.equal((await srv.call('GET', img)).status, 404);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM user_files WHERE user_id = ?', a.id)[0].n, 0);
});

test('data-5: when the last member leaves a group, its files, quota rows, reactions and votes go too', async () => {
  const a = await srv.register('galice'); const b = await srv.register('gbob');
  await shared(a, b, 'meet');
  const g = (await as(srv, a, 'POST', '/groups', { userIds: [b.id] })).json;
  const ch = g.channels.find((c) => c.type === 'text');
  const { mid, url, name } = await populate(g.id, ch.id, a, b);
  assert.equal((await srv.call('GET', url)).status, 200);
  assert.equal((await as(srv, a, 'POST', `/servers/${g.id}/leave`)).status, 200);
  assert.equal((await as(srv, b, 'POST', `/servers/${g.id}/leave`)).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM servers WHERE id = ?', g.id)[0].n, 0);
  await sleep(150);
  assert.deepEqual(leftovers(mid, name), NOTHING);
  assert.equal((await srv.call('GET', url)).status, 404);
  assert.equal((await as(srv, a, 'GET', '/me/storage')).json.used, 0);
});

test('data-5: account deletion that empties a group cleans it up too', async () => {
  const a = await srv.register('dalice'); const b = await srv.register('dbob');
  await shared(b, a, 'meet2'); // owned by b: owners must hand over servers before deleting their account
  const g = (await as(srv, a, 'POST', '/groups', { userIds: [b.id] })).json;
  const { mid, name } = await populate(g.id, g.channels.find((c) => c.type === 'text').id, a, b);
  assert.equal((await as(srv, b, 'POST', `/servers/${g.id}/leave`)).status, 200);
  const del = await as(srv, a, 'DELETE', '/me', { authKey: a.authKey, confirm: a.username });
  assert.equal(del.status, 200, del.text);
  await sleep(150);
  assert.deepEqual(leftovers(mid, name), NOTHING);
});

test('data-5: admin server deletion, channel deletion and message deletion remove reactions and poll votes', async () => {
  const a = await srv.register('aalice'); const b = await srv.register('abob');
  const s = await shared(a, b, 'adminned');
  const chId = s.channels.find((c) => c.type === 'text').id;
  // Deleting one message.
  const one = await populate(s.id, chId, a, b);
  assert.equal((await as(srv, a, 'DELETE', `/messages/${one.mid}`)).status, 200);
  await sleep(100);
  assert.deepEqual(leftovers(one.mid, one.name), NOTHING);
  // Deleting the whole server (as an admin).
  const two = await populate(s.id, chId, a, b);
  const r = await srv.api('DELETE', `/admin/servers/${s.id}`, { token: owner.token, ip: owner.ip });
  assert.equal(r.status, 200, r.text);
  await sleep(100);
  assert.deepEqual(leftovers(two.mid, two.name), NOTHING);
});

// ------------------------------------------------------------------ files-6: metadata in public pictures
test('files-6: the metadata stripper removes EXIF/GPS, XMP, IPTC, comments and trailers but keeps the picture and its orientation', () => {
  const src = jpegWithMeta(6);
  const out = stripImageMetadata(src);
  assert.ok(out);
  for (const s of ['SECRET', 'http://ns.adobe.com/xap', 'Photoshop 3.0']) assert.equal(has(out, s), false, s);
  const before = jpegSegments(JPEG); const now = jpegSegments(out);
  // Same coding segments (quantisation, frame, Huffman tables, ICC profile) and the same compressed image data.
  assert.deepEqual(now.filter((x) => x.marker !== 0xe1).map((x) => [x.marker, x.body.toString('hex')]), before.map((x) => [x.marker, x.body.toString('hex')]));
  const app1 = now.filter((x) => x.marker === 0xe1);
  assert.equal(app1.length, 1, 'one small EXIF block for the orientation');
  assert.equal(tiffOrientation(app1[0].body.subarray(6)), 6);
  assert.ok(app1[0].body.length < 40);
  // Orientation 1 (normal) needs no EXIF at all; a file without metadata is left untouched.
  assert.equal(jpegSegments(stripImageMetadata(jpegWithMeta(1))).filter((x) => x.marker === 0xe1).length, 0);
  assert.equal(stripImageMetadata(JPEG), null);
  assert.equal(stripImageMetadata(PNG), null);
  assert.equal(stripImageMetadata(Buffer.concat([JPEG.subarray(0, 300)])), null, 'a cut-off file is left alone');
  // PNG: metadata chunks gone, CRCs valid, the image data still inflates to the right size.
  const png = stripImageMetadata(pngWithMeta());
  assert.ok(png && !has(png, 'SECRET'));
  const chunks = pngChunks(png);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'eXIf', 'IDAT', 'IEND']);
  assert.equal(tiffOrientation(chunks[1].data), 6);
  assert.deepEqual(zlib.inflateSync(chunks.find((c) => c.type === 'IDAT').data), PNG_RAW);
  // WebP: EXIF and XMP chunks removed, their header flags cleared, the RIFF size right.
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x0c | 0x10; vp8x.writeUIntLE(4, 4, 3); vp8x.writeUIntLE(2, 7, 3);
  const ch = (t, d) => { const h = Buffer.alloc(8); h.write(t, 0, 'latin1'); h.writeUInt32LE(d.length, 4); return Buffer.concat([h, d, Buffer.alloc(d.length & 1)]); };
  const body = Buffer.concat([ch('VP8X', vp8x), ch('ALPH', Buffer.from('alpha!')), ch('VP8 ', Buffer.from('imagedata')), ch('EXIF', exifTiff(1)), ch('XMP ', Buffer.from('<x:xmpmeta>SECRET</x:xmpmeta>'))]);
  const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), body]); riff.writeUInt32LE(riff.length - 8, 4);
  const webp = stripImageMetadata(riff);
  assert.ok(webp && !has(webp, 'SECRET') && !has(webp, 'EXIF') && !has(webp, 'XMP '));
  assert.equal(webp.readUInt32LE(4), webp.length - 8);
  assert.equal(webp[20], 0x10, 'only the alpha flag is left');
  assert.ok(has(webp, 'imagedata') && has(webp, 'alpha!'));
});

test('files-6: profile and server pictures are stored without their GPS position; quota counts the cleaned size', async () => {
  const u = await srv.register('photog');
  const r = await post(srv, u, '/me/media/avatar', { filename: 'me.jpg', type: 'image/jpeg', bytes: jpegWithMeta(6), fields: [['crop', '{}']] });
  assert.equal(r.status, 200, r.text);
  const avatar = r.json.avatar;
  const served = Buffer.from(await (await fetch(srv.base + avatar)).arrayBuffer());
  assert.equal(has(served, 'SECRET'), false, 'no GPS, description, XMP, IPTC, comment or trailer');
  assert.equal(tiffOrientation(jpegSegments(served).find((x) => x.marker === 0xe1).body.subarray(6)), 6, 'orientation kept');
  assert.equal(srv.sql('SELECT size FROM user_files WHERE name = ?', path.basename(avatar))[0].size, served.length);
  assert.equal(fs.readdirSync(path.join(srv.dir, 'uploads')).filter((f) => f.endsWith('.tmp')).length, 0);
  // PNG banner, server icon and emoji go through the same path.
  const b = await post(srv, u, '/me/media/banner', { filename: 'b.png', type: 'image/png', bytes: pngWithMeta(), fields: [['crop', '{}']] });
  assert.equal(b.status, 200);
  const banner = Buffer.from(await (await fetch(srv.base + b.json.banner)).arrayBuffer());
  assert.equal(has(banner, 'SECRET'), false);
  assert.deepEqual(zlib.inflateSync(pngChunks(banner).find((c) => c.type === 'IDAT').data), PNG_RAW);
  const s = (await as(srv, u, 'POST', '/servers', { name: 'Pics' })).json;
  const icon = await srv.api('POST', `/servers/${s.id}/icon`, { token: u.token, ip: u.ip, ...multipart({ field: 'icon', filename: 'i.jpg', type: 'image/jpeg', bytes: jpegWithMeta(3) }) });
  assert.equal(icon.status, 200);
  assert.equal(has(fs.readFileSync(fileOf(srv, icon.json.icon)), 'SECRET'), false);
  // A plain picture is stored byte for byte.
  const p = await post(srv, u, '/me/media/background', { filename: 'p.png', type: 'image/png', bytes: PNG, fields: [['crop', '{}']] });
  assert.ok(fs.readFileSync(fileOf(srv, p.json.background)).equals(PNG));
});

// ------------------------------------------------------------------ review-1/2: the stripper itself can't be used against the server
test('review-1: pictures made of millions of tiny blocks are refused straight away, without piling up memory', () => {
  for (const [kind, buf] of [['JPEG', manyBlockJpeg(11.5 * MIB)], ['PNG', manyChunkPng(11.5 * MIB)], ['WebP', manyChunkWebp(7.5 * MIB)]]) {
    const heap = process.memoryUsage().heapUsed;
    const t = Date.now();
    assert.throws(() => stripImageMetadata(buf), ImageRejected, kind);
    const ms = Date.now() - t;
    assert.ok(ms < 1000, `${kind}: ${ms} ms (it took about 2 s before)`);
    assert.ok(process.memoryUsage().heapUsed - heap < 64 * MIB, `${kind}: no per-block copies`);
  }
  // A real picture with a lot of blocks (a few hundred, like a progressive JPEG) is still cleaned normally.
  const at = 4 + JPEG.readUInt16BE(4);
  const blocks = Buffer.alloc(300 * 4); for (let k = 0; k < 300; k++) blocks.writeUInt32BE(0xffe30002, k * 4);
  const busy = Buffer.concat([jpegWithMeta(6).subarray(0, at), blocks, jpegWithMeta(6).subarray(at)]);
  const out = stripImageMetadata(busy);
  assert.ok(out && !has(out, 'SECRET'));
  assert.equal(jpegSegments(out).filter((x) => x.marker === 0xe3).length, 300, 'other blocks are kept');
  // Long runs of escaped bytes in the image data are fine too (and quick).
  const scan = Buffer.alloc(11.5 * MIB);
  JPEG.copy(scan, 0, 0, JPEG.indexOf(Buffer.from([0xff, 0xda])));
  for (let p = JPEG.indexOf(Buffer.from([0xff, 0xda])); p < scan.length; p += 2) { scan[p] = 0xff; scan[p + 1] = 0; }
  const sos = JPEG.indexOf(Buffer.from([0xff, 0xda]));
  JPEG.copy(scan, sos, sos, sos + 2 + JPEG.readUInt16BE(sos + 2));
  scan.writeUInt16BE(0xffd9, scan.length - 2);
  const t = Date.now();
  assert.equal(stripImageMetadata(Buffer.concat([scan, Buffer.from('TRAILER')])).length, scan.length);
  assert.ok(Date.now() - t < 1000);
});

test('review-2: a cut-off or slightly damaged photo still loses its metadata; the rest is kept as it is', () => {
  const full = jpegWithMeta(6);
  // Cut off part way through the image data (no end-of-image marker), as an interrupted transfer leaves it.
  const cut = full.subarray(0, full.indexOf(Buffer.from('SECRET-TRAILER', 'latin1')) - 12);
  const out = stripImageMetadata(cut);
  assert.ok(out, 'cleaned, not kept as it was');
  for (const x of ['SECRET', 'http://ns.adobe.com/xap', 'Photoshop 3.0']) assert.equal(has(out, x), false, x);
  assert.equal(tiffOrientation(jpegSegments(out).find((x) => x.marker === 0xe1).body.subarray(6)), 6, 'orientation kept');
  const tail = cut.subarray(cut.indexOf(Buffer.from([0xff, 0xda])));
  assert.ok(out.subarray(out.length - tail.length).equals(tail), 'the image data is copied byte for byte');
  // Stray bytes between blocks (decoders skip them, so the picture still shows): before the EXIF block, and later.
  const at = 4 + JPEG.readUInt16BE(4);
  for (const where of [at, full.indexOf(Buffer.from([0xff, 0xfe]))]) {
    const padded = Buffer.concat([full.subarray(0, where), Buffer.from([0, 0]), full.subarray(where)]);
    const clean = stripImageMetadata(padded);
    assert.ok(clean && !has(clean, 'SECRET'), `stray bytes at ${where}`);
    assert.deepEqual(jpegSegments(clean).filter((x) => x.marker !== 0xe1).map((x) => x.marker), jpegSegments(JPEG).map((x) => x.marker));
  }
  // Both at once, and stray FF 00 pairs (also skipped by decoders).
  const both = Buffer.concat([full.subarray(0, at), Buffer.from([0x12, 0xff, 0x00, 0x34]), cut.subarray(at)]);
  assert.equal(has(stripImageMetadata(both), 'SECRET'), false);
  // PNG cut off in its image data: the metadata chunks before it still go.
  const png = pngWithMeta();
  const pngOut = stripImageMetadata(png.subarray(0, png.length - 20));
  assert.ok(pngOut && !has(pngOut, 'SECRET'));
  assert.ok(pngOut.subarray(pngOut.length - 30).equals(png.subarray(png.length - 50, png.length - 20)));
  // WebP whose size says more than the file holds: cleaned, and still exactly as much "missing" as before.
  const webp = webpWithMeta();
  const webpOut = stripImageMetadata(webp.subarray(0, webp.length - 30));
  assert.ok(webpOut && !has(webpOut, 'SECRET') && !has(webpOut, 'XMP '));
  assert.equal(webpOut.readUInt32LE(4) - (webpOut.length - 8), 30);
  assert.equal(webpOut[20], 0x10 | 0x08, 'alpha and the small orientation EXIF block');
  // Nothing to remove: still left alone (and a file that isn't a picture at all is not this code's business).
  assert.equal(stripImageMetadata(JPEG.subarray(0, 300)), null);
  assert.equal(stripImageMetadata(Buffer.from('just some text')), null);
});

test('review-1: uploads are cleaned in a worker thread, in place and in order; one that can’t be finished is refused', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hearth-strip-'));
  try {
    const files = [jpegWithMeta(6), PNG, pngWithMeta(), Buffer.from('not a picture'), manyBlockJpeg(64 * 1024)].map((b, k) => {
      const f = path.join(dir, `f${k}`); fs.writeFileSync(f, b); return f;
    });
    const res = await Promise.allSettled(files.map((f) => stripFile(f)));
    assert.equal(res[0].value, fs.statSync(files[0]).size);
    assert.equal(has(fs.readFileSync(files[0]), 'SECRET'), false);
    assert.equal(res[1].value, null, 'nothing to remove: the file is not touched');
    assert.ok(fs.readFileSync(files[1]).equals(PNG));
    assert.equal(has(fs.readFileSync(files[2]), 'SECRET'), false);
    assert.equal(res[3].value, null);
    assert.ok(res[4].reason instanceof ImageRejected, 'the many-block file is refused');
    // The worker gives up on a picture after IMAGE_STRIP_LIMIT_MS: here 1 ms, so every one is refused in turn, and
    // nothing is left half-written.
    const mod = require.resolve('../server/imagemeta');
    const saved = require.cache[mod];
    delete require.cache[mod];
    process.env.IMAGE_STRIP_LIMIT_MS = '1';
    let impatient;
    try { impatient = require('../server/imagemeta'); } finally { delete process.env.IMAGE_STRIP_LIMIT_MS; require.cache[mod] = saved; }
    fs.writeFileSync(files[0], jpegWithMeta(6));
    const slow = await Promise.allSettled([files[0], files[2]].map((f) => impatient.stripFile(f)));
    assert.ok(slow.every((r) => r.status === 'rejected' && r.reason instanceof impatient.ImageRejected), String(slow.map((r) => r.status)));
    await sleep(200);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('review-1: a hostile many-block upload is refused and the server keeps answering while it is checked', async () => {
  const u = await srv.register('blockflood');
  const uploads = () => fs.readdirSync(path.join(srv.dir, 'uploads')).length;
  const before = uploads();
  const lat = [];
  let stop = false;
  const poll = (async () => { while (!stop) { const t = Date.now(); await srv.api('GET', '/config'); lat.push(Date.now() - t); await sleep(5); } })();
  const r = await post(srv, u, '/me/media/avatar', { filename: 'evil.jpg', type: 'image/jpeg', bytes: manyBlockJpeg(11.5 * MIB), fields: [['crop', '{}']] });
  // The review's case: a server banner sent by someone who isn't even a member.
  const s = (await as(srv, owner, 'POST', '/servers', { name: 'Not yours' })).json;
  const r2 = await post(srv, u, `/servers/${s.id}/media/banner`, { filename: 'evil.jpg', type: 'image/jpeg', bytes: manyBlockJpeg(11.5 * MIB) });
  // GIF library uploads go through the same check.
  const r3 = await post(srv, u, '/gifs/library', { filename: 'evil.png', type: 'image/png', bytes: manyChunkPng(7 * MIB) });
  stop = true;
  await poll;
  assert.ok(lat.length > 0 && Math.max(...lat) < 750, `/api/config took up to ${Math.max(...lat)} ms (about 2 s before)`);
  for (const x of [r, r2, r3]) { assert.equal(x.status, 400, x.text); assert.equal(x.json.code, 'bad_image'); }
  await sleep(150);
  assert.equal(uploads(), before, 'nothing left on disk');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM user_files WHERE user_id = ?', u.id)[0].n, 0, 'no storage used');
  // A normal photo right after: cleaned and stored.
  const ok = await post(srv, u, '/me/media/avatar', { filename: 'me.jpg', type: 'image/jpeg', bytes: jpegWithMeta(6), fields: [['crop', '{}']] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(has(fs.readFileSync(fileOf(srv, ok.json.avatar)), 'SECRET'), false);
});

// ------------------------------------------------------------------ files-5 / xss-3: attachment addresses
test('files-5/xss-3: attachment entries from encrypted messages only keep files on this server', async () => {
  const A = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'attachments.js')).href);
  const evil = [
    { url: 'https://evil.example/x.gif', type: 'image/gif' },
    { url: 'https://chat.example.com@evil.example/login', name: 'Q3-report.pdf', type: 'application/pdf' },
    { url: '//evil.example/pixel.png', type: 'image/png' },
    { url: 'javascript:alert(1)' }, { url: 'data:image/png;base64,AAAA' }, { url: '/api/me' }, { url: '/uploads/../api/me' },
    { url: '/uploads/abc.png?x=https://evil' }, { url: '/uploads/abc/def.png' }, null, 'string', { url: ['x'] },
  ];
  assert.deepEqual(A.cleanFiles(evil), []);
  assert.deepEqual(A.cleanFiles('nope'), []);
  const good = A.cleanFiles([{ url: '/uploads/0abc123def.bin', k: 'key', name: 'a.png', type: 'image/png', size: 10, th: { url: '/uploads/0abc124.bin', k: 'k2' } }]);
  assert.deepEqual(good, [{ url: '/uploads/0abc123def.bin', k: 'key', name: 'a.png', type: 'image/png', size: 10, th: { url: '/uploads/0abc124.bin', k: 'k2' } }]);
  // A bad thumbnail is dropped, the file itself kept.
  assert.equal(A.cleanFiles([{ url: '/uploads/a1.bin', k: 'k', th: { url: 'https://evil.example/t.png' } }])[0].th, undefined);
  assert.equal(A.cleanFiles(Array.from({ length: 50 }, (_, i) => ({ url: `/uploads/f${i}.bin`, k: 'k' }))).length, 10);
  // Download links: a decrypted copy of this app, or a file on this server. Never another site.
  const origin = 'https://chat.example.test';
  assert.equal(A.safeDownloadHref('https://other.example/', origin), null);
  assert.equal(A.safeDownloadHref('https://chat.example.test@evil.example/login', origin), null);
  assert.equal(A.safeDownloadHref('blob:https://evil.example/123', origin), null);
  assert.equal(A.safeDownloadHref('/uploads/abc.bin', origin), '/uploads/abc.bin');
  assert.equal(A.safeDownloadHref(`blob:${origin}/123-456`, origin), `blob:${origin}/123-456`);
  // The decrypting code uses it for channel messages, DMs and older messages alike.
  const secure = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'secure.js'), 'utf8');
  assert.equal((secure.match(/f: cleanFiles\(/g) || []).length, 3);
  assert.doesNotMatch(secure, /Array\.isArray\(payload\.f\) \? payload\.f/);
});

// The browser test below checks the real app, but only where Playwright is installed. This always runs: the app must
// keep sending every attachment address through those checks before loading, showing or downloading it.
test('review-3 (files-5/xss-3): the app only loads, shows or downloads attachments through the same-server checks', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const fn = (name) => {
    const start = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, `${name} is in app.js`);
    return app.slice(start, app.indexOf('\n}\n', start) + 2);
  };
  assert.match(app, /^import \{[^}]*\bisUploadUrl\b[^}]*\bsafeDownloadHref\b[^}]*\} from '\.\/attachments\.js';$/m);
  // Fetching (and decrypting) a file: refused for anything but /uploads/<name>, before any request is made.
  assert.match(fn('decryptedUrl'), /^function decryptedUrl\(m, f\) \{\n\s*if \(!isUploadUrl\(f\.url\)\) return Promise\.reject\(/);
  // Downloads: only a decrypted copy (blob: of this app) or a file on this server, never a jump to another site.
  const dl = fn('downloadAttachment');
  assert.match(dl, /const href = safeDownloadHref\([^;]*, location\.origin\);\n\s*if \(!href\) throw /);
  assert.doesNotMatch(dl, /href: f\.url|location\.href =|window\.open\(/);
  // Pictures, videos, audio and voice messages: unencrypted ones load straight from this server only.
  const el = fn('attachmentEl');
  assert.match(el, /const direct = \(\) => \(isUploadUrl\(f\.url\) \? Promise\.resolve\(f\.url\) : Promise\.reject\(/);
  assert.equal((el.match(/Promise\.resolve\(f\.url\)/g) || []).length, 1, 'only through direct()');
  assert.match(el, /voiceEl\(f, \(\) => \(\(f\.k \|\| m\.dmId\) \? decryptedUrl\(m, f\) : direct\(\)\)\)/);
  assert.match(el, /const full = \(\) => \(enc \? decryptedUrl\(m, f\) : direct\(\)\);/);
  assert.equal((el.match(/\.src = f\.url/g) || []).length, 1);
  assert.match(el, /if \(enc \|\| f\.th \|\| !isUploadUrl\(f\.url\)\) whenVisible\(holder, load\); else el\.src = f\.url;/);
});

// ------------------------------------------------------------------ files-10 / ssrf-3: proxies
const mediaTokenOf = async (u) => (await as(srv, u, 'GET', '/bootstrap')).json.mediaToken;
test('files-10: the GIF proxy re-checks every redirect and stops huge answers that give no size', async () => {
  const u = await srv.register('viewer');
  const t = encodeURIComponent(await mediaTokenOf(u));
  const q = (target) => `/media/gif?u=${encodeURIComponent(target)}&t=${t}`;
  const out = await srv.call('GET', q(`${fake.base}/redirect-out`));
  assert.equal(out.status, 502, 'a redirect to another host is not followed');
  assert.equal(fake.st.otherHost, 0);
  const inside = await fetch(srv.base + q(`${fake.base}/redirect-in`));
  assert.equal(inside.status, 200, 'a redirect within the allowed hosts still works');
  assert.ok(Buffer.from(await inside.arrayBuffer()).subarray(0, 6).equals(Buffer.from('GIF89a')));
  const huge = await fetch(srv.base + q(`${fake.base}/huge.gif`));
  let got = 0;
  try { for await (const c of huge.body) got += c.length; } catch { /* cut off */ }
  assert.ok(got <= 21 * 1024 * 1024, `client got ${got} bytes`);
  await sleep(300);
  assert.ok(fake.st.sent['/huge.gif'] < 60 * 1024 * 1024, `upstream stopped early (${fake.st.sent['/huge.gif']})`);
});

// ------------------------------------------------------------------ files-12: the address the GIF proxy fetches
test('files-12: GIF media is fetched from an address rebuilt from the allowed hosts, never the one asked for', () => {
  const { gifMediaUrl, MEDIA_HOSTS } = require('../server/gifmedia');
  const at = (s, extra) => gifMediaUrl(new URL(s), extra);
  // GIPHY's and KLIPY's media hosts, by exact name.
  const giphy = ['media.giphy.com', 'i.giphy.com', ...Array.from({ length: 10 }, (_, n) => `media${n}.giphy.com`)];
  assert.deepEqual([...MEDIA_HOSTS].sort(), [...giphy, 'static.klipy.com', 'static.klipy.co', 'media.klipy.com'].sort());
  for (const h of MEDIA_HOSTS) assert.equal(at(`https://${h}/media/abc/giphy.gif`), `https://${h}/media/abc/giphy.gif`, h);
  for (const s of ['https://media10.giphy.com/x.gif', 'https://media01.giphy.com/x.gif', 'https://mediax.giphy.com/x.gif', 'https://evil.media.giphy.com/x.gif',
    'https://media.giphy.com.evil.test/x.gif', 'https://giphy.com/x.gif', 'https://klipy.com/x.gif', 'https://static.klipy.com.evil.test/x.gif']) assert.equal(at(s), null, s);
  // Upper case is the same host. A trailing dot, plain http, another port or another scheme: refused.
  assert.equal(at('HTTPS://MEDIA2.GIPHY.COM/Media/X.GIF'), 'https://media2.giphy.com/Media/X.GIF');
  for (const s of ['https://media.giphy.com./x.gif', 'http://media.giphy.com/x.gif', 'http://i.giphy.com:443/x.gif', 'https://media.giphy.com:8443/x.gif',
    'https://media.giphy.com:80/x.gif', 'ftp://media.giphy.com/x.gif', 'wss://media.giphy.com/x.gif']) assert.equal(at(s), null, s);
  assert.equal(at('https://media.giphy.com:443/x.gif'), 'https://media.giphy.com/x.gif', 'the default port is no port');
  // A login in the address is dropped; one that hides another host is judged by that host.
  assert.equal(at('https://user:pw@i.giphy.com/a.gif'), 'https://i.giphy.com/a.gif');
  for (const s of ['https://media.giphy.com@evil.test/x.gif', 'https://media.giphy.com:443@evil.test/x.gif', 'https://evil.test\\@media.giphy.com/x.gif',
    'https://evil.test#@media.giphy.com/x.gif', 'https://evil.test?@media.giphy.com/']) assert.equal(at(s), null, s);
  // Odd paths stay paths on the same host: a leading "//" or "\\", escaped slashes, dots and question marks.
  assert.equal(at('https://media.giphy.com//evil.test/x.gif'), 'https://media.giphy.com//evil.test/x.gif');
  assert.equal(new URL(at('https://media.giphy.com//evil.test/x.gif')).host, 'media.giphy.com');
  assert.equal(at('https://media.giphy.com\\\\evil.test/x.gif'), 'https://media.giphy.com//evil.test/x.gif');
  assert.equal(at('https://media.giphy.com/a%2F..%2F..%2Fb%5Cc%3Fd%23e.gif'), 'https://media.giphy.com/a%2F..%2F..%2Fb%5Cc%3Fd%23e.gif', 'escaped separators stay escaped');
  assert.equal(at('https://media.giphy.com/a/%2e%2E/../b.gif'), 'https://media.giphy.com/b.gif');
  assert.equal(at('https://media.giphy.com/caf%c3%a9%20%41.gif'), 'https://media.giphy.com/caf%C3%A9%20A.gif', 'escapes are written one way');
  assert.equal(at("https://media.giphy.com/v1.a=b,c;d:e@f$g&h+i!j~k*l'm(n)o/x.gif"), "https://media.giphy.com/v1.a=b,c;d:e@f$g&h+i!j~k*l'm(n)o/x.gif", 'characters a path may hold are kept');
  assert.equal(at('https://media.giphy.com/a%zz.gif'), null, 'a broken escape');
  // The query is kept as it was; a fragment is never sent.
  assert.equal(at('https://media4.giphy.com/media/v1.Y2lk/3o7/giphy.gif?cid=abc&rid=giphy.gif&ct=g#x'), 'https://media4.giphy.com/media/v1.Y2lk/3o7/giphy.gif?cid=abc&rid=giphy.gif&ct=g');
  assert.equal(at('https://media.giphy.com/x.gif?u=//evil.test/@x'), 'https://media.giphy.com/x.gif?u=//evil.test/@x');
  // The operator's extra hosts: exactly the host[:port] given, over http or https only, without a login.
  const extra = ['127.0.0.1:9', 'gifs.lan'];
  assert.equal(at('http://127.0.0.1:9/m/x.gif?a=1', extra), 'http://127.0.0.1:9/m/x.gif?a=1');
  assert.equal(at('https://gifs.lan/x.gif', extra), 'https://gifs.lan/x.gif');
  assert.equal(at('http://u:p@127.0.0.1:9/x.gif', extra), 'http://127.0.0.1:9/x.gif');
  for (const s of ['http://127.0.0.1:10/x.gif', 'http://127.0.0.1/x.gif', 'ws://127.0.0.1:9/x', 'ftp://127.0.0.1:9/x', 'http://gifs.lan:8080/x.gif', 'http://127.0.0.1:9@evil.test/x.gif'])
    assert.equal(at(s, extra), null, s);
  assert.equal(at('http://127.0.0.1:9/x.gif'), null, 'not without the setting');
  assert.equal(gifMediaUrl('https://media.giphy.com/x.gif'), null, 'only a parsed URL is judged');
  // However the address is written, what comes out is on an allowed host, without a login or fragment, or nothing.
  const origins = new Set([...MEDIA_HOSTS.map((h) => `https://${h}`), 'http://127.0.0.1:9', 'https://127.0.0.1:9', 'http://gifs.lan', 'https://gifs.lan']);
  let passed = 0;
  for (const scheme of ['https://', 'http://', 'HTTPS://', 'https:/', 'https:\\\\', 'ws://']) {
    for (const auth of ['media.giphy.com', 'MEDIA.giphy.com', 'media.giphy.com.', 'media.giphy.com:443', 'media.giphy.com:8443', 'u:p@media.giphy.com', 'media.giphy.com@evil.test',
      'evil.test\\@media.giphy.com', 'media.giphy.com%2F@evil.test', 'media%2egiphy.com', '127.0.0.1:9', '127.0.0.1:9@evil.test', 'gifs.lan', '[::1]', '0x7f000001']) {
      for (const p of ['/x.gif', '//evil.test/x', '/\\evil.test', '/%2F%2Fevil.test', '/..%2F..%2F', '/@evil.test', '/x?y#z', '?//evil.test', '#//evil.test', '']) {
        let u;
        try { u = new URL(scheme + auth + p); } catch { continue; }
        const href = gifMediaUrl(u, extra);
        if (href === null) continue;
        const x = new URL(href);
        assert.ok(origins.has(x.origin), `${scheme + auth + p} -> ${href}`);
        assert.equal(x.username + x.password + x.hash, '', href);
        passed++;
      }
    }
  }
  assert.ok(passed > 50, `${passed} addresses were allowed`);
});

test('files-12: the GIF proxy sends only the rebuilt request: no login, odd paths stay on the allowed host, sneaky redirects are refused', async () => {
  const u = await srv.register('gifpaths');
  const t = encodeURIComponent(await mediaTokenOf(u));
  const q = (target) => `/media/gif?u=${encodeURIComponent(target)}&t=${t}`;
  const hostPort = `127.0.0.1:${fake.port}`;
  const last = () => fake.st.seen[fake.st.seen.length - 1];
  // A login in the address is not passed on.
  let r = await srv.call('GET', q(`http://someone:secret@${hostPort}/media/login.gif`));
  assert.equal(r.status, 200);
  assert.deepEqual(last(), { url: '/media/login.gif', auth: undefined });
  // Escaped slashes stay escaped: the provider is asked for one odd name under /media/, not for /redirect-out.
  r = await srv.call('GET', q(`http://${hostPort}/media/a%2F..%2F..%2Fredirect-out`));
  assert.equal(r.status, 200);
  assert.equal(last().url, '/media/a%2F..%2F..%2Fredirect-out');
  // A path that starts with "//" is still asked of the allowed host, never of the host written after it.
  r = await srv.call('GET', q(`http://${hostPort}//localhost:${fake.otherPort}/x.gif`));
  assert.equal(r.status, 502, 'the fake has nothing at that path');
  assert.equal(last().url, `//localhost:${fake.otherPort}/x.gif`);
  // Refused before anything is sent: another scheme, another port, the allowed host as a login, http, a port or a
  // trailing dot on a built-in host.
  const before = fake.st.seen.length;
  for (const bad of [`ws://${hostPort}/media/x.gif`, `http://127.0.0.1:${fake.otherPort}/x.gif`, `http://${hostPort}@localhost:${fake.otherPort}/x.gif`,
    'http://media.giphy.com/x.gif', 'https://media.giphy.com:8443/x.gif', 'https://media.giphy.com./x.gif', 'https://media.giphy.com/a%zz.gif']) {
    assert.equal((await srv.call('GET', q(bad))).status, 400, bad);
  }
  assert.equal(fake.st.seen.length, before);
  // Redirects to another host written as a login or as "//host": not followed.
  for (const p of ['/redirect-login', '/redirect-slashes']) assert.equal((await srv.call('GET', q(`http://${hostPort}${p}`))).status, 502, p);
  assert.equal(fake.st.otherHost, 0);
});

test('ssrf-3: the picture proxy stops reading a huge answer at its 6 MB limit instead of buffering it', async () => {
  const u = await srv.register('artviewer');
  const t = encodeURIComponent(await mediaTokenOf(u));
  const r = await srv.call('GET', `/media/art?u=${encodeURIComponent(`${fake.base}/huge-art.jpg`)}&t=${t}`, { timeout: 30000 });
  assert.equal(r.status, 404);
  await sleep(300);
  assert.ok(fake.st.sent['/huge-art.jpg'] < 40 * 1024 * 1024, `read ${fake.st.sent['/huge-art.jpg']} of 100 MB`);
  assert.equal(fake.st.closedEarly['/huge-art.jpg'], true);
  assert.equal((await srv.api('GET', '/config')).status, 200);
});

// ------------------------------------------------------------------ ssrf-4: emoji from GIPHY/KLIPY
test('ssrf-4: emoji-from-GIF checks the name before calling the provider, and is rate limited', async () => {
  const s = (await as(srv, owner, 'POST', '/servers', { name: 'Emoji land' })).json;
  const ok = await as(srv, owner, 'POST', `/servers/${s.id}/emojis/from-giphy`, { gifId: 'abcd1234', name: 'party' });
  assert.equal(ok.status, 200, ok.text);
  const posts = fake.st.posts; const media = fake.st.media;
  for (let i = 0; i < 19; i++) assert.equal((await as(srv, owner, 'POST', `/servers/${s.id}/emojis/from-giphy`, { gifId: 'abcd1234', name: 'party' })).status, 409);
  assert.equal(fake.st.posts, posts, 'no provider call for a request that can only fail');
  assert.equal(fake.st.media, media, 'and no download');
  const limited = await as(srv, owner, 'POST', `/servers/${s.id}/emojis/from-giphy`, { gifId: 'abcd1235', name: 'party2' });
  assert.equal(limited.status, 429);
});

// ------------------------------------------------------------------ files-11: what the GIF library learns
test('files-11: learned GIFs must come from this server’s own search results, keep the provider’s title and pass the word filter', async () => {
  await srv.api('PUT', '/admin/gif-library', { token: owner.token, ip: owner.ip, body: { learn: true } });
  const u = await srv.register('sender');
  const found = await as(srv, u, 'GET', '/gifs?q=happy%20cat');
  assert.equal(found.status, 200, found.text);
  const g = found.json.items[0];
  assert.equal(g.id, 'happycatid');
  // The app claims another address or other words: not learned.
  await as(srv, u, 'POST', '/gifs/used', { id: g.id, url: `${fake.base}/media/attacker.gif`, title: 't', query: 'q' });
  await as(srv, u, 'POST', '/gifs/used', { id: 'neverserved', url: `${fake.base}/media/neverserved.gif`, title: 'x', query: 'evil words' });
  await sleep(300);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM gif_library WHERE source = 'klipy'")[0].n, 0);
  // The real one: learned with the provider's title and the search's words, credited to who sent it.
  await as(srv, u, 'POST', '/gifs/used', { id: g.id, url: g.url, title: 'EVIL TITLE', query: 'evil injected tags', sticker: true });
  let row;
  for (let i = 0; i < 50 && !row; i++) { await sleep(100); row = srv.sql("SELECT * FROM gif_library WHERE source = 'klipy' AND source_id = ?", g.id)[0]; }
  assert.ok(row, 'learned');
  assert.equal(row.title, 'Title for happy cat');
  assert.match(row.tags, /happy/); assert.doesNotMatch(row.tags, /evil|injected/);
  assert.equal(row.added_by, u.id);
  assert.equal(row.sticker, 0);
  // A search with a blocked word: never learned.
  await srv.api('PUT', '/admin/words', { token: owner.token, ip: owner.ip, body: { words: ['zorkbad'] } });
  const bad = (await as(srv, u, 'GET', '/gifs?q=zorkbad')).json.items[0];
  await as(srv, u, 'POST', '/gifs/used', { id: bad.id, url: bad.url });
  await sleep(400);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM gif_library WHERE source_id = ?', bad.id)[0].n, 0);
  await srv.api('PUT', '/admin/words', { token: owner.token, ip: owner.ip, body: { words: [] } });
  await srv.api('PUT', '/admin/gif-library', { token: owner.token, ip: owner.ip, body: { learn: false } });
});

// ------------------------------------------------------------------ data-5: leftovers from before the fix
test('data-5: leftovers from earlier versions (blobs, reactions, votes of deleted messages) are swept after a restart', async () => {
  const u = await srv.register('oldtimer');
  const url = await encUpload(u);
  const name = path.basename(url);
  srv.sql('UPDATE blobs SET message_id = ? WHERE name = ?', 'gone-message-1', name);
  srv.sql('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', 'gone-message-1', u.id, '👍', Date.now());
  srv.sql('INSERT INTO poll_votes (message_id, user_id, choice, created_at) VALUES (?, ?, ?, ?)', 'gone-message-1', u.id, 0, Date.now());
  srv.sql('INSERT INTO poll_closed (message_id, closed_at) VALUES (?, ?)', 'gone-message-1', Date.now());
  // A blob that is still in use must survive.
  const keep = await encUpload(u);
  const s = (await as(srv, u, 'POST', '/servers', { name: 'Keep' })).json;
  srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', s.id);
  const m = await as(srv, u, 'POST', `/channels/${s.channels.find((c) => c.type === 'text').id}/messages`, { ciphertext: 'v2:' + crypto.randomBytes(30).toString('base64'), epoch: 1, files: [keep] });
  assert.equal(m.status, 200, m.text);
  await srv.restart();
  let left;
  for (let i = 0; i < 40; i++) { await sleep(150); left = leftovers('gone-message-1', name); if (left.blobRows === 0 && left.pollClosed === 0) break; }
  await sleep(150);
  assert.deepEqual(leftovers('gone-message-1', name), NOTHING);
  assert.equal((await srv.call('GET', keep)).status, 200, 'attached blobs are kept');
  assert.equal(srv.sql('SELECT COUNT(*) n FROM blobs WHERE name = ?', path.basename(keep))[0].n, 1);
});

// ------------------------------------------------------------------ review-4: GIF library uploads from before
test('review-4: GIF library uploads from older versions are counted toward their uploader’s storage once, after an update', async () => {
  const u = await srv.register('oldgifs');
  // As an older version left them: library rows and their files, but no storage rows. An upload, a learned GIF
  // (nobody's upload) and an upload by an account that no longer exists.
  const longAgo = Date.now() - 30 * 86400000;
  const add = (source, by, bytes) => {
    const file = `old${crypto.randomBytes(8).toString('hex')}.gif`;
    fs.writeFileSync(path.join(srv.dir, 'uploads', file), fakeGif(bytes));
    srv.sql('INSERT INTO gif_library (id, file, title, size, source, source_id, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      crypto.randomBytes(8).toString('hex'), file, 'old', bytes, source, source === 'upload' ? null : file, by, longAgo);
    return file;
  };
  const mine = add('upload', u.id, 3000);
  const learned = add('klipy', u.id, 4000);
  const ghost = add('upload', 'no-such-account', 5000);
  srv.sql("DELETE FROM instance_settings WHERE key = 'gifLibraryIndexed'");
  await srv.restart();
  assert.deepEqual(srv.sql('SELECT name, kind, size, created_at FROM user_files WHERE user_id = ?', u.id), [{ name: mine, kind: 'gif', size: 3000, created_at: longAgo }]);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM user_files WHERE name IN (?, ?)', learned, ghost)[0].n, 0);
  const st = (await as(srv, u, 'GET', '/me/storage')).json;
  assert.equal(st.used, 3000);
  assert.equal(st.today, 0, 'the original upload time is kept: today’s allowance isn’t used up');
  assert.deepEqual(st.byKind, [{ kind: 'gif', files: 1, bytes: 3000 }]);
  // Only once: a later restart doesn't count it again (or bring back a row that was cleared).
  srv.sql('DELETE FROM user_files WHERE name = ?', mine);
  await srv.restart();
  assert.equal(srv.sql('SELECT COUNT(*) n FROM user_files WHERE name = ?', mine)[0].n, 0);
  assert.equal(srv.sql("SELECT value FROM instance_settings WHERE key = 'gifLibraryIndexed'")[0].value, '1');
});

// ------------------------------------------------------------------ the real client in a browser (when available)
// Runs where Playwright and its Chromium are installed (the development container, or wherever PLAYWRIGHT_MODULE
// and CHROMIUM_PATH point: Playwright's index.mjs and a Chromium executable); skipped elsewhere.
const PW = process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const havePlaywright = fs.existsSync(PW) && fs.existsSync(CHROME);
test('files-5/xss-3 + files-6 in Chromium: attacker attachment URLs are never loaded or opened; stripped photos still display upright', { skip: !havePlaywright && 'Playwright not installed' }, async () => {
  const https = require('node:https');
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'evil.example' }], { keySize: 2048, algorithm: 'sha256' });
  const evilLog = [];
  const evil = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    evilLog.push(req.url);
    if (req.url.startsWith('/pixel')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1 id="fake">Session expired</h1>');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const ep = evil.address().port;
  const { chromium } = await import(pathToFileURL(PW).href);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--proxy-server=direct://', '--host-resolver-rules=MAP evil.example 127.0.0.1'] });
  try {
    globalThis.window = globalThis.window || { crypto: globalThis.crypto, hashwasm: require('hash-wasm') };
    const E = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'e2ee.js')).href);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route('**/*', (route) => { const h = new URL(route.request().url()).hostname; return h === '127.0.0.1' || h === 'evil.example' ? route.continue() : route.abort(); });
    const page = await context.newPage();
    await page.goto(srv.base + '/');
    await page.click('#to-register');
    await page.fill('#register-form input[name=username]', 'browseralice');
    await page.fill('#register-form input[name=password]', 'correct horse battery');
    await page.fill('#register-form input[name=confirm]', 'correct horse battery');
    await page.check('#register-form input[name=tos]');
    await page.click('#register-form button[type=submit]');
    await page.waitForSelector('#app:not([hidden]):not(.loading)', { timeout: 60000 });
    const alice = { token: await page.evaluate(() => localStorage.getItem('hearth.token')), ip: '127.0.0.1' };
    const me = (await as(srv, alice, 'GET', '/bootstrap')).json.me;
    // A phone photo as avatar: stored without GPS, still decodes, still upright (12x8 shown as 8x12).
    const av = await post(srv, alice, '/me/media/avatar', { filename: 'me.jpg', type: 'image/jpeg', bytes: jpegWithMeta(6), fields: [['crop', '{}']] });
    assert.equal(av.status, 200, av.text);
    const dims = await page.evaluate(async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, av.json.avatar);
    assert.deepEqual(dims, [8, 12]);

    const server = (await as(srv, alice, 'POST', '/servers', { name: 'Work' })).json;
    const channel = server.channels.find((c) => c.type === 'text');
    await page.reload(); await page.waitForSelector('#app:not([hidden]):not(.loading)');
    for (let i = 0; i < 200 && !(srv.sql('SELECT key_epoch FROM servers WHERE id = ?', server.id)[0].key_epoch > 0); i++) await sleep(100);
    const mallory = await srv.register('browsermallory');
    const myPriv = await crypto.webcrypto.subtle.importKey('pkcs8', mallory.privateKey.export({ type: 'pkcs8', format: 'der' }), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const sk = await E.createSigningKey(myPriv, mallory.publicKey);
    // Uploaded the way the app does it: with proof of the identity key and of the new signing key (crypto-11).
    const ch = (await as(srv, mallory, 'POST', '/me/sign-key/challenge')).json;
    const keyProof = await E.signKeyProof(myPriv, ch.serverPublicKey, ch.nonce, mallory.id, sk.signPublicKey);
    const signature = await E.sign(sk.signKey, `hearth-sign-key|${mallory.id}|${mallory.publicKey}|${ch.nonce}`);
    assert.equal((await as(srv, mallory, 'POST', '/me/sign-key', { signPublicKey: sk.signPublicKey, encSignPrivateKey: sk.encSignPrivateKey, nonce: ch.nonce, keyProof, signature })).status, 200);
    const { code } = (await as(srv, alice, 'POST', `/servers/${server.id}/invites`, {})).json;
    assert.equal((await as(srv, mallory, 'POST', `/invites/${code}/join`)).status, 200);
    let st;
    for (let i = 0; i < 200; i++) { st = (await as(srv, mallory, 'GET', `/servers/${server.id}/keys`)).json; if (st.keys.find((k) => k.epoch === st.keyEpoch)) break; await sleep(100); }
    const k = st.keys.find((x) => x.epoch === st.keyEpoch);
    const raw = await E.unwrapGroupKey({ wrapped: k.wrapped, serverId: server.id, epoch: k.epoch, myId: mallory.id, myPriv, wrapperId: k.wrapperId, wrapperSignPub: (await as(srv, mallory, 'GET', `/users/${me.id}`)).json.signPublicKey });
    const payload = { t: 'Here is the Q3 report', f: [
      { name: 'Q3-report.pdf', type: 'application/pdf', size: 48213, url: `https://chat.example.com@evil.example:${ep}/login` },
      { name: 'chart.png', type: 'image/png', size: 1200, url: `https://evil.example:${ep}/pixel.png` },
      { name: 'thumb.png', type: 'image/png', size: 1200, url: '/uploads/abc.bin', k: 'x', th: { url: `https://evil.example:${ep}/pixel-th.png`, k: 'x' } },
      { name: 'fine.jpg', type: 'image/jpeg', size: 900, url: av.json.avatar },
    ] };
    const ciphertext = await E.encryptGroup({ raw, serverId: server.id, channelId: channel.id, epoch: st.keyEpoch, authorId: mallory.id, signKey: sk.signKey, payload });
    assert.equal((await as(srv, mallory, 'POST', `/channels/${channel.id}/messages`, { ciphertext, epoch: st.keyEpoch })).status, 200);
    await page.evaluate((id) => { location.hash = '#c/' + id; }, channel.id);
    await page.waitForFunction(() => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('Q3 report')), null, { timeout: 20000 });
    await page.waitForSelector('.att-img[src*="/uploads/"]', { timeout: 10000 });
    await sleep(1500);
    assert.equal(await page.$$eval('.att-file', (els) => els.length), 0, 'the fake PDF card is not shown');
    const srcs = await page.$$eval('.att-img', (els) => els.map((e) => e.src));
    assert.ok(srcs.every((s) => !s || s.startsWith(srv.base)), String(srcs));
    assert.ok(srcs.includes(srv.base + av.json.avatar), 'the same-server picture still shows');
    assert.deepEqual(evilLog, [], 'the attacker’s host was never contacted');
    assert.equal(new URL(page.url()).hostname, '127.0.0.1');
  } finally {
    await browser.close();
    evil.closeAllConnections(); evil.close();
  }
});
