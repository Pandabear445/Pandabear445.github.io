// The search box's little language, parsed and matched on this device. Pure functions, no DOM and no network,
// so the server never sees the words (and the tests can run this under Node).
//
//   from:@username  from:name  from:"Display Name"  from:me     whose messages
//   in:#channel  in:@username (your DM with them)                where
//   before:2025-05-31  after:2025-05  during:2025                when (a day, a month or a year, local time)
//   has:file  has:image  has:link                                what's in it
//   is:edited  is:pinned
//   "exact phrase"  and plain words, which must all appear (any order, any case)
//
// Anything else with a colon (like https://… or 12:30) is an ordinary word.

const OPS = new Set(['from', 'in', 'before', 'after', 'during', 'has', 'is']);
const HAS = { file: 'file', files: 'file', attachment: 'file', attachments: 'file', image: 'image', images: 'image', photo: 'image', link: 'link', links: 'link', url: 'link' };
const IS = ['edited', 'pinned'];
const LINK = /\bhttps?:\/\/\S/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|heic|svg)$/i;

// What the empty search box suggests. Clicking one adds it to the box.
export const SUGGESTIONS = [
  { insert: 'from:', hint: 'a person' },
  { insert: 'in:#', hint: 'a channel' },
  { insert: 'has:file', hint: 'attachments' },
  { insert: 'has:image', hint: 'pictures' },
  { insert: 'has:link', hint: 'links' },
  { insert: 'before:', hint: 'YYYY-MM-DD' },
  { insert: 'after:', hint: 'YYYY-MM-DD' },
  { insert: 'during:', hint: 'YYYY-MM-DD' },
  { insert: 'is:edited', hint: 'edited' },
  { insert: '"', hint: 'exact phrase' },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A day, month or year as [start, end) in local time. null if it isn't a real date.
export function period(value) {
  const m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(String(value).trim());
  if (!m) return null;
  const y = +m[1];
  const mo = m[2] ? +m[2] : null;
  const d = m[3] ? +m[3] : null;
  if (y < 1970 || (mo !== null && (mo < 1 || mo > 12))) return null;
  if (d !== null) {
    const start = new Date(y, mo - 1, d);
    if (start.getMonth() !== mo - 1 || start.getDate() !== d) return null; // 2025-02-30 and the like
    return { start: start.getTime(), end: new Date(y, mo - 1, d + 1).getTime() };
  }
  if (mo !== null) return { start: new Date(y, mo - 1, 1).getTime(), end: new Date(y, mo, 1).getTime() };
  return { start: new Date(y, 0, 1).getTime(), end: new Date(y + 1, 0, 1).getTime() };
}

function applyFilter(q, f) {
  const v = f.value;
  if (f.key === 'from' || f.key === 'in') {
    if (!v || v === '@' || v === '#') return q.errors.push(f.key === 'from' ? 'from: needs a name, like from:@alex' : 'in: needs a channel, like in:#general');
    if (q[f.key]) return q.errors.push(`Use one ${f.key}: filter at a time.`);
    if (f.key === 'from') q.from = v.toLowerCase() === 'me' ? { me: true, name: 'me' } : { name: v.replace(/^@/, ''), exact: v.startsWith('@') };
    else q.in = { kind: v.startsWith('@') ? 'user' : 'channel', name: v.replace(/^[#@]/, '') };
    return;
  }
  if (f.key === 'has') {
    const kind = HAS[v.toLowerCase()];
    if (!kind) return q.errors.push(v ? `Unknown filter has:${v} — try has:file, has:image, has:link` : 'has: needs a type — try has:file, has:image, has:link');
    if (!q.has.includes(kind)) q.has.push(kind);
    return;
  }
  if (f.key === 'is') {
    const what = v.toLowerCase();
    if (!IS.includes(what)) return q.errors.push(v ? `Unknown filter is:${v} — try is:edited, is:pinned` : 'is: needs a state — try is:edited, is:pinned');
    if (!q.is.includes(what)) q.is.push(what);
    return;
  }
  // before / after / during
  const p = period(v);
  if (!p) return q.errors.push(`${f.key}: needs a date like 2025-05-31${v ? ` (“${v}” isn’t one)` : ''}`);
  // after:a day means after that whole day; during: is the day itself. Several dates narrow it down.
  const lo = f.key === 'before' ? null : f.key === 'after' ? p.end : p.start;
  const hi = f.key === 'after' ? null : f.key === 'before' ? p.start : p.end;
  if (lo !== null) q.after = q.after === null ? lo : Math.max(q.after, lo);
  if (hi !== null) q.before = q.before === null ? hi : Math.min(q.before, hi);
}

// Splits what was typed into filters, quoted phrases and words. Never throws: problems go in `errors`.
export function parseQuery(input) {
  const text = String(input || '');
  const q = { text, words: [], phrases: [], from: null, in: null, after: null, before: null, has: [], is: [], filters: [], errors: [] };
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    const rest = text.slice(i);
    let m = /^([A-Za-z]+):(?:"([^"]*)"?|([^\s"]*))/.exec(rest);
    if (m && OPS.has(m[1].toLowerCase())) {
      const f = { key: m[1].toLowerCase(), value: (m[2] !== undefined ? m[2] : m[3] || '').trim(), raw: m[0], start: i, end: i + m[0].length };
      q.filters.push(f);
      applyFilter(q, f);
      i = f.end;
      continue;
    }
    m = /^"([^"]*)"?/.exec(rest);
    if (m) {
      const p = m[1].trim().replace(/\s+/g, ' ');
      if (p && !q.phrases.some((x) => x.toLowerCase() === p.toLowerCase())) q.phrases.push(p);
      i += m[0].length;
      continue;
    }
    const w = /^\S+/.exec(rest)[0];
    if (!q.words.some((x) => x.toLowerCase() === w.toLowerCase())) q.words.push(w);
    i += w.length;
  }
  if (q.after !== null && q.before !== null && q.after >= q.before) q.errors.push('Those dates leave no time to search: the after: date must come before the before: date.');
  q.terms = [...q.phrases, ...q.words];
  q.termRes = q.terms.map((t) => new RegExp(escapeRe(t), 'iu'));
  // One pattern for highlighting: longest first, so "hello world" wins over "hello".
  q.highlight = q.terms.length ? new RegExp([...q.terms].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'giu') : null;
  return q;
}

export const isImageFile = (f) => !!f && (/^image\//i.test(f.type || '') || IMAGE_EXT.test(f.name || ''));

// Does a decrypted message match the words and the on-device filters (has:, is:, dates)?
// v = { text, files: [{ name, type }], edited, pinned, createdAt, imageLinks }. from: and in: are ids the app
// resolves itself, so it checks those.
export function matchMessage(q, v) {
  const text = v.text || '';
  const files = v.files || [];
  if (q.after !== null && !(v.createdAt >= q.after)) return false;
  if (q.before !== null && !(v.createdAt < q.before)) return false;
  // Words can be in the text or in an attachment's name.
  const hay = files.length ? `${text}\n${files.map((f) => f.name || '').join('\n')}` : text;
  for (const re of q.termRes) if (!re.test(hay)) return false;
  for (const kind of q.has) {
    if (kind === 'file' && !files.length) return false;
    if (kind === 'image' && !files.some(isImageFile) && !v.imageLinks) return false;
    if (kind === 'link' && !LINK.test(text)) return false;
  }
  if (q.is.includes('edited') && !v.edited) return false;
  if (q.is.includes('pinned') && !v.pinned) return false;
  return true;
}

// Splits text into plain and matching pieces, for highlighting with real text nodes (never as HTML).
export function segments(text, q) {
  const s = String(text || '');
  const re = q && q.highlight;
  if (!re || !s) return s ? [{ text: s, hit: false }] : [];
  const out = [];
  let at = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > at) out.push({ text: s.slice(at, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at), hit: false });
  return out;
}

// Never cut a character made of two UTF-16 units (most emoji) in half.
const safeCut = (s, i) => (i > 0 && i < s.length && /[\uDC00-\uDFFF]/.test(s[i]) ? i - 1 : i);

// A short one-line excerpt around the first match (custom emoji shown as :name:).
export function excerpt(text, q, max = 160) {
  const flat = String(text || '').replace(/<a?:(\w{2,32}):[a-z0-9]{6,40}>/g, ':$1:').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let hit = 0;
  if (q && q.highlight) { q.highlight.lastIndex = 0; const m = q.highlight.exec(flat); if (m) hit = m.index; }
  let start = Math.max(0, Math.min(hit - 40, flat.length - max));
  if (start > 0) { const sp = flat.indexOf(' ', start); if (sp > 0 && sp < hit) start = sp + 1; }
  start = safeCut(flat, start);
  const end = safeCut(flat, Math.min(flat.length, start + max));
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}

// The box without one filter (a chip's ×) or without all of them ("Clear filters").
const tidy = (s) => s.replace(/\s{2,}/g, ' ').trim();
export const removeFilter = (input, f) => tidy(input.slice(0, f.start) + ' ' + input.slice(f.end));
export function clearFilters(input) {
  let out = String(input || '');
  for (const f of [...parseQuery(out).filters].reverse()) out = out.slice(0, f.start) + ' ' + out.slice(f.end);
  return tidy(out);
}
