// Removes tags from profile songs before they're stored (files-6). Anyone who opens a profile can download its song,
// and a song file often says more than its title: ripping or tagging software, comments, lyrics, a cover picture
// (sometimes a personal photo) and, for shop downloads, the buyer's name or email address.
//
// Like the picture cleaner (imagemeta.js), the sound itself is never decoded or re-encoded: tags live in their own
// blocks, separate from the audio, so those blocks are dropped and the audio is copied byte for byte. It runs in a
// worker thread of its own, apart from the pictures' (imagemeta.js: stripFile(file, { audio: true })). What's
// handled, by what the file is (not by its name):
//   MP3:  ID3v2 tags at the start (and an ID3v2.4 tag with a footer at the end), APE tags, Lyrics3 blocks and the
//         ID3v1 tag ("TAG", plus the enhanced "TAG+") at the end. The MPEG frames in between are kept exactly.
//   WAV:  LIST (INFO: artist, title, software…), id3, bext (broadcast: who and when), iXML, XMP, cart and DISP
//         chunks, and the same tags as an MP3's if a tagger added them after the RIFF data. The format and sample
//         data chunks are kept exactly. A RIFF size of 0 or 0xFFFFFFFF (written by a recorder that was streaming) is
//         left alone.
//   M4A:  udta and meta boxes at the top level, in moov and in each track (iTunes tags, cover art, the buyer's
//         account), the 'pinf' box in a track's audio description (where iTunes Store purchases also put the
//         buyer's name), and an XMP box. They're turned into "free" boxes of zeros of the same size, which players
//         skip, so no other byte moves and the offsets in the file stay right.
//   OGG (Vorbis/Opus comments) is left as it is: changing those means rebuilding the pages around them, with new
//   checksums. So is FLAC data under another name, and anything this code doesn't recognise or whose structure
//   doesn't add up.
// A WAV or M4A with far more chunks or boxes than a real song has is refused (AudioRejected): each one is a small
// read, so walking millions of them would only keep the worker busy.
const fs = require('fs');

// Real songs have a few dozen boxes (M4A) or chunks (WAV) outside their audio data. This is the most read in one
// file, over all its levels together, before it's refused: a few milliseconds of work.
const MAX_BOXES = 10000;

// The upload is refused: a file no real song looks like.
class AudioRejected extends Error {}
const tooComplex = () => new AudioRejected('This song has far more blocks than a real song has.');
// Counts one more box or chunk against the file's budget ({ left }).
function spend(budget) { if (--budget.left < 0) throw tooComplex(); }

// What a song is read from: a Buffer, or an open file (read in small pieces, so a big song is never held whole).
const bufferSource = (buf) => ({ size: buf.length, read: (pos, len) => buf.subarray(pos, Math.min(buf.length, pos + len)) });
function fileSource(fd) {
  const size = fs.fstatSync(fd).size;
  return {
    size,
    read(pos, len) {
      const b = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
      let got = 0;
      while (got < b.length) {
        const r = fs.readSync(fd, b, got, b.length - got, pos + got);
        if (!r) break;
        got += r;
      }
      return b.subarray(0, got);
    },
  };
}

// A plan is the cleaned file as a list of parts: [start, end] of the original, a Buffer of new bytes, or
// { zeros: n }. null means there's nothing to remove.
function planSize(plan) {
  return plan.reduce((a, p) => a + (Array.isArray(p) ? p[1] - p[0] : Buffer.isBuffer(p) ? p.length : p.zeros), 0);
}
const ascii = (b, s, e) => b.toString('latin1', s, e);

// ---------------------------------------------------------------- MP3
// The length of the ID3v2 tag whose 10-byte header is h, or 0 if h isn't one.
function id3v2Length(h) {
  if (h.length < 10 || ascii(h, 0, 3) !== 'ID3' || h[3] < 2 || h[3] > 4 || h[4] === 0xff) return 0;
  if (h[5] & { 2: 0x3f, 3: 0x1f, 4: 0x0f }[h[3]]) return 0; // flags no version defines: not a real tag
  if (h[6] & 0x80 || h[7] & 0x80 || h[8] & 0x80 || h[9] & 0x80) return 0; // sizes are "syncsafe": 7 bits a byte
  const size = (h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9];
  return 10 + size + (h[3] === 4 && h[5] & 0x10 ? 10 : 0); // v2.4 may add a 10-byte footer
}
// [start, end] of what's left between `from` and `to` once the tags around it are taken off.
function untagged(src, from, to) {
  let start = from;
  // ID3v2 at the start (some taggers add a second one in front of the first). One that claims to run past the end
  // takes the rest with it: a tag is never kept just because its size is wrong.
  for (let k = 0; k < 16 && start < to; k++) {
    const len = id3v2Length(src.read(start, 10));
    if (!len) break;
    start = Math.min(to, start + len);
  }
  let end = to;
  for (let rounds = 0; rounds < 32 && end > start; rounds++) {
    // ID3v1: the last 128 bytes, starting "TAG"; an enhanced tag ("TAG+", 227 bytes) can sit just before it.
    if (end - start >= 128 && ascii(src.read(end - 128, 3), 0, 3) === 'TAG') {
      end -= 128;
      if (end - start >= 227 && ascii(src.read(end - 227, 4), 0, 4) === 'TAG+') end -= 227;
      continue;
    }
    // APE tag: a 32-byte footer "APETAGEX" whose size covers the items and the footer; a header may come first.
    if (end - start >= 32) {
      const f = src.read(end - 32, 32);
      if (ascii(f, 0, 8) === 'APETAGEX' && !(f.readUInt32LE(20) & 0x20000000)) {
        const total = f.readUInt32LE(12) + (f.readUInt32LE(20) & 0x80000000 ? 32 : 0);
        if (total >= 32 && total <= end - start) { end -= total; continue; }
      }
    }
    // Lyrics3 v2: "LYRICSBEGIN" … a six-digit size and "LYRICS200".
    if (end - start >= 15) {
      const f = ascii(src.read(end - 15, 15), 0, 15);
      if (/^\d{6}LYRICS200$/.test(f)) {
        const total = Number(f.slice(0, 6)) + 15;
        if (total <= end - start && ascii(src.read(end - total, 11), 0, 11) === 'LYRICSBEGIN') { end -= total; continue; }
      }
      // Lyrics3 v1: "LYRICSBEGIN" … "LYRICSEND", at most 5100 bytes of lyrics.
      if (f.endsWith('LYRICSEND')) {
        const back = Math.max(start, end - 5100 - 20);
        const at = ascii(src.read(back, end - back), 0, end - back).lastIndexOf('LYRICSBEGIN');
        if (at >= 0) { end = back + at; continue; }
      }
    }
    // An ID3v2.4 tag at the end, found by its footer ("3DI").
    if (end - start >= 20) {
      const f = src.read(end - 10, 10);
      if (ascii(f, 0, 3) === '3DI') {
        const h = Buffer.from(f); h.write('ID3', 0, 'latin1');
        const total = id3v2Length(h);
        if (total >= 20 && total <= end - start && ascii(src.read(end - total, 3), 0, 3) === 'ID3') { end -= total; continue; }
      }
    }
    break;
  }
  return [start, end];
}
function mp3Plan(src) {
  const [start, end] = untagged(src, 0, src.size);
  if (start === 0 && end === src.size) return null;
  return end > start ? [[start, end]] : [];
}

// ---------------------------------------------------------------- WAV
const WAV_DROP = new Set(['LIST', 'id3 ', 'ID3 ', 'bext', 'iXML', '_PMX', 'XMP ', 'cart', 'DISP']);
function wavPlan(src, budget) {
  const n = src.size;
  const head = src.read(0, 12);
  if (head.length < 12 || ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 12) !== 'WAVE') return null;
  const declared = head.readUInt32LE(4);
  if (declared === 0 || declared === 0xffffffff) return null;
  const declaredEnd = 8 + declared;
  const riffEnd = Math.min(declaredEnd, n); // a cut-off file is cleaned as far as it goes
  const plan = [null]; // the new header goes first
  const keep = (s, e) => { if (e <= s) return; const last = plan[plan.length - 1]; if (Array.isArray(last) && last[1] === s) last[1] = e; else plan.push([s, e]); };
  let changed = false;
  let i = 12;
  while (i + 8 <= riffEnd) {
    spend(budget);
    const ch = src.read(i, 8);
    const len = ch.readUInt32LE(4);
    if (i + 8 + len > riffEnd) break; // cut off: keep the rest
    const end = Math.min(riffEnd, i + 8 + len + (len & 1));
    if (WAV_DROP.has(ascii(ch, 0, 4))) changed = true; else keep(i, end);
    i = end;
  }
  keep(i, riffEnd);
  // Bytes after the RIFF size are kept (they may be audio a recorder miscounted), but not tags some taggers add
  // there the way they do to an MP3 (ID3v1, APE, an ID3v2 tag).
  const [s, e] = untagged(src, riffEnd, n);
  const tagsAfter = s > riffEnd || e < n;
  if (!changed && !tagsAfter) return null;
  if (changed) {
    plan[0] = Buffer.alloc(12);
    plan[0].write('RIFF', 0, 'latin1');
    plan[0].write('WAVE', 8, 'latin1');
    plan[0].writeUInt32LE(planSize(plan.slice(1)) + 4 + (declaredEnd - riffEnd), 4); // a cut-off file stays exactly as cut off
  } else plan.splice(0, plan.length, [0, riffEnd]);
  if (e > s) plan.push([s, e]);
  return plan;
}

// ---------------------------------------------------------------- M4A (MP4)
// The boxes from `from` to `to`: [{ type, start, head, end }], or null if they don't add up exactly. Each one is
// counted against the file's budget, over every level.
function boxes(src, from, to, top, budget) {
  const list = [];
  let i = from;
  while (i < to) {
    spend(budget);
    if (to - i < 8) return null;
    const h = src.read(i, 16);
    let size = h.readUInt32BE(0);
    let head = 8;
    const type = ascii(h, 4, 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
    if (size === 1) { if (h.length < 16) return null; size = Number(h.readBigUInt64BE(8)); head = 16; } else if (size === 0 && top) size = to - i; // "to the end of the file"
    if (size < head) return null;
    if (i + size > to) { if (!top) return null; size = to - i; } // a cut-off file: its last box runs to the end
    list.push({ type, start: i, head, end: i + size });
    i += size;
  }
  return list;
}
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
const META_BOX = new Set(['udta', 'meta']);
function mp4Plan(src, budget) {
  const list = (from, to, top = false) => boxes(src, from, to, top, budget);
  // iTunes Store purchases also name the buyer in a 'pinf' box inside the track's audio description
  // (trak/mdia/minf/stbl/stsd/mp4a). stsd has 8 bytes of its own (version, flags, entry count) before its entries;
  // an audio entry has 28 (16 or 36 more in QuickTime's version 1 and 2 layouts) before its boxes. Anything here that
  // doesn't add up is only not searched: the rest of the file is still cleaned.
  const purchaseInfo = (trak) => {
    let kids = trak;
    for (const type of ['mdia', 'minf', 'stbl', 'stsd']) {
      const b = kids.find((x) => x.type === type);
      kids = b ? list(b.start + b.head + (type === 'stsd' ? 8 : 0), b.end) : null;
      if (!kids) return [];
    }
    const found = [];
    for (const entry of kids) {
      const body = entry.start + entry.head;
      if (entry.end - body < 28) continue;
      const version = src.read(body + 8, 2).readUInt16BE(0);
      const inner = list(body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), entry.end);
      if (inner) found.push(...inner.filter((x) => x.type === 'pinf'));
    }
    return found;
  };
  const top = list(0, src.size, true);
  if (!top || !top.length || top[0].type !== 'ftyp') return null;
  const blank = [];
  for (const b of top) {
    if (META_BOX.has(b.type)) blank.push(b); // tags for the whole file
    else if (b.type === 'moov') {
      const kids = list(b.start + b.head, b.end);
      if (!kids) return null;
      for (const k of kids) {
        if (META_BOX.has(k.type)) blank.push(k);
        else if (k.type === 'trak') {
          const tk = list(k.start + k.head, k.end);
          if (!tk) return null;
          tk.filter((t) => META_BOX.has(t.type)).forEach((t) => blank.push(t));
          blank.push(...purchaseInfo(tk));
        }
      }
    } else if (b.type === 'uuid' && b.end - b.start >= b.head + 16 && src.read(b.start + b.head, 16).toString('hex') === XMP_UUID) blank.push(b);
  }
  if (!blank.length) return null;
  blank.sort((a, b) => a.start - b.start);
  const plan = [];
  let at = 0;
  for (const b of blank) {
    plan.push([at, b.start + 4], Buffer.from('free', 'latin1')); // its size stays, its type becomes "free"…
    if (b.head === 16) plan.push([b.start + 8, b.start + 16]);
    plan.push({ zeros: b.end - b.start - b.head }); // …and what it held becomes zeros
    at = b.end;
  }
  plan.push([at, src.size]);
  return plan;
}

// ---------------------------------------------------------------- the formats
function planFor(src) {
  const budget = { left: MAX_BOXES };
  const h = src.read(0, 12);
  if (h.length >= 8 && ascii(h, 4, 8) === 'ftyp') return mp4Plan(src, budget);
  if (h.length >= 12 && ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 12) === 'WAVE') return wavPlan(src, budget);
  if (['OggS', 'fLaC'].includes(ascii(h, 0, 4))) return null; // left as it is (see the top of this file)
  return mp3Plan(src);
}

// The song without its tags, or null when there was nothing to remove (or it isn't a format handled here). Throws
// AudioRejected for a file no real song looks like.
function stripAudioMetadata(buf) {
  const plan = planFor(bufferSource(buf));
  if (!plan) return null;
  const out = Buffer.alloc(planSize(plan)); // zero-filled, so { zeros } parts need nothing more
  let o = 0;
  for (const p of plan) o += Array.isArray(p) ? buf.copy(out, o, p[0], p[1]) : Buffer.isBuffer(p) ? p.copy(out, o) : p.zeros;
  return out;
}

// Writes the song at `file` without its tags to `tmp`, a megabyte at a time. Returns the new size, or null (and
// writes nothing) when there was nothing to remove.
function stripAudioFile(file, tmp) {
  const fd = fs.openSync(file, 'r');
  let out = null;
  try {
    const plan = planFor(fileSource(fd));
    if (!plan) return null;
    out = fs.openSync(tmp, 'w');
    const chunk = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (const p of plan) {
      if (Buffer.isBuffer(p)) { fs.writeSync(out, p); size += p.length; continue; }
      let left = Array.isArray(p) ? p[1] - p[0] : p.zeros;
      let pos = Array.isArray(p) ? p[0] : 0;
      if (!Array.isArray(p)) chunk.fill(0);
      while (left > 0) {
        const want = Math.min(left, chunk.length);
        const got = Array.isArray(p) ? fs.readSync(fd, chunk, 0, want, pos) : want;
        if (!got) throw new Error('The song file changed while it was being cleaned.');
        fs.writeSync(out, chunk, 0, got);
        pos += got; left -= got; size += got;
      }
    }
    fs.closeSync(out);
    out = null;
    return size;
  } catch (e) {
    if (out !== null) { try { fs.closeSync(out); } catch { /* closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* not written */ }
    throw e;
  } finally { fs.closeSync(fd); }
}

module.exports = { stripAudioMetadata, stripAudioFile, AudioRejected, id3v2Length };
