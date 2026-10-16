// Word filter: the matching (README "Word filter", docs/FEATURES.md). Messages are end-to-end encrypted, so the
// only filter that can work is one that runs where the text can be read: on the reader's own device. This file is
// the part with no page around it, shared by the app (wordfilter-app.js) and the tests (node --test loads it as it is).
//
// A list holds up to LIMITS.entries entries. Each is a word or a phrase of up to LIMITS.words words, at most
// LIMITS.length characters, with at least LIMITS.letters letters or numbers and up to LIMITS.wildcards *'s.
// Whole words, any capitalization: "cat" catches "Cat!" but not "category". A * stands for any letters inside one
// word: "cat*" also catches "category", "*cat" catches "bobcat", "c*t" catches "cut". Chinese, Japanese, Thai, Lao,
// Khmer and Burmese don't put spaces between words, so an entry in those scripts matches anywhere inside a run of
// text (as if it had a * at each end). There is no other syntax: entries are never turned into regular expressions.
//
// Both the list and the text are folded the same way before comparing, so trivial disguises don't work:
//   - NFKC (fullwidth ｃａｔ, 𝐜𝐚𝐭, ⓒⓐⓣ, ligatures), small capitals (ᴄᴀᴛ) and letters in black circles and squares
//     (🅒🅐🅣, 🅲🅰🆃), then lower case. Flag letters (🇨🇦) stay flags;
//   - accents and other marks on Latin, Greek and Cyrillic letters dropped (cât, c̶a̶t̶, Zalgo stacks), and a few
//     letters with no decomposition read as their plain ones (ø, ł, đ, ß as ss…). Other scripts keep their marks:
//     there they are part of the spelling;
//   - invisible characters dropped (zero-width spaces and joiners, soft hyphens, direction marks, variation
//     selectors, fillers), so "c<zero-width space>at" is still cat;
//   - Cyrillic and Greek letters that look like Latin ones (а, с, о, р…) are read as those Latin letters in every
//     word, on both sides, so a word that mixes scripts (сat with a Cyrillic с, or пидоp with a Latin p) is caught
//     either way round. A word written wholly in one script only stands for a word in another when the rest of the
//     message suggests a disguise: "сат" in English text is cat, but "но" (but) in a Russian sentence isn't "ho";
//   - letters spelled out one at a time ("c a t", "c.a.t", "c-a-t") are also read as the word they spell;
//   - the message is also read as it's shown, with its formatting applied (markdown.js), so c**at** and c||at|| are
//     cat too;
//   - a letter written three or more times matches the same letter written once or twice in the entry ("caaat"),
//     but a doubled letter isn't stretched: "god" doesn't catch "good", and so "caat" doesn't catch "cat" either.
//     Add a spelling like that to the list if it matters (a * helps).
// Not covered: digits or symbols standing for letters (c4t, c@t), or words split some other way. Add those spellings
// to the list (a * helps).
//
// Cost: every comparison is a small walk over one word, never a backtracking search, and it's bounded three ways so
// no list (a server's included) together with any message can make the app hang: quick checks first (a word must
// have the letters an entry can't do without, start and end with what it starts and ends with, and be long enough),
// words longer than MAX_WORD are compared by their start and end only, and a message gets at most BUDGET steps per
// list. A message that would take more than that is treated as matching (TOO_COSTLY): it's hidden or blurred, and
// "Show" is one click, rather than slipping through.

import { render } from './markdown.js';

export const LIMITS = Object.freeze({
  entries: 200, // per list
  length: 60, // characters per entry
  words: 5, // words in a phrase
  wildcards: 4, // *'s per entry
  letters: 2, // letters or numbers per entry, at least (so "*" or "a*" can't hide everything)
  text: 50000, // characters of a message looked at (more than any message the app sends)
});
export const ACTIONS = ['hide', 'blur'];
// What find() answers instead of an entry when a message would take too long to check against the list. It can't be
// an entry (it has no letters).
export const TOO_COSTLY = '…';
const MAX_WORD = 256; // characters of one word compared in full; past that, the first and last MAX_WORD / 2
const BUDGET = 1000000; // steps per message and list (see VISIT and WALK): a few tens of milliseconds at most

// ------------------------------------------------------------------ folding
// Zero-width and other invisible characters, and format characters (direction marks, soft hyphen, tags).
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
// Marks on Latin, Greek and Cyrillic letters (after NFD: accents, strike-through, Zalgo stacks).
const MARKED = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu;
// Letters NFD doesn't take apart, small capitals, and Greek's final sigma (so σ and ς are one letter).
const PLAIN = {
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', ħ: 'h', ı: 'i', ŧ: 't', ƀ: 'b', ɨ: 'i', ʉ: 'u', þ: 'th', ŀ: 'l', ς: 'σ',
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p',
  ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
};
const PLAIN_RE = new RegExp(`[${Object.keys(PLAIN).join('')}]`, 'g');
// Letters in black circles (U+1F150…) and black squares (U+1F170…): symbols to Unicode, so NFKC leaves them.
const BOXED = /[\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}]/gu;
const unbox = (c) => String.fromCharCode(97 + ((c.codePointAt(0) - 0x1F150) % 32));
// Cyrillic and Greek letters (lower case) that pass for Latin ones.
const LOOKS = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', і: 'i', ј: 'j',
  ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w', ү: 'y',
  α: 'a', β: 'b', γ: 'y', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w', ϲ: 'c',
};
const LOOKS_RE = new RegExp(`[${Object.keys(LOOKS).join('')}]`, 'g');
const skeleton = (w) => w.replace(LOOKS_RE, (c) => LOOKS[c]);
// The one script a word's letters are all in, when it's one of the three that share look-alikes: 'L', 'C' or 'G'.
// '' for a word that mixes them (a disguise) or has letters of any other script.
const NOT_LATIN = /(?!\p{Script=Latin})\p{L}/u;
const NOT_CYRILLIC = /(?!\p{Script=Cyrillic})\p{L}/u;
const NOT_GREEK = /(?!\p{Script=Greek})\p{L}/u;
const scriptOf = (w) => (!NOT_LATIN.test(w) ? 'L' : !NOT_CYRILLIC.test(w) ? 'C' : !NOT_GREEK.test(w) ? 'G' : '');
// A Cyrillic or Greek letter with no Latin look-alike: text that has one is written in that script.
const lookAlikes = (script) => Object.keys(LOOKS).filter((c) => new RegExp(`\\p{Script=${script}}`, 'u').test(c)).join('');
const REAL = {
  C: new RegExp(`(?![${lookAlikes('Cyrillic')}])(?=\\p{L})\\p{Script=Cyrillic}`, 'u'),
  G: new RegExp(`(?![${lookAlikes('Greek')}])(?=\\p{L})\\p{Script=Greek}`, 'u'),
};
// Scripts written without spaces between words.
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
// A word: letters, numbers and the marks that belong to them.
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

// The text as the filter reads it (see the top of the file). Longer text is cut at LIMITS.text characters.
export function fold(text) {
  return String(text == null ? '' : text).slice(0, LIMITS.text)
    .normalize('NFKC')
    .replace(BOXED, unbox)
    .replace(IGNORABLE, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(MARKED, '$1')
    .normalize('NFC')
    .replace(PLAIN_RE, (c) => PLAIN[c]);
}
// Runs longer than three of one letter count as three: past that, how many there were doesn't matter.
const clampRuns = (w) => w.replace(/(.)\1{3,}/gu, '$1$1$1');
// One letter per run: the key a word is looked up by.
const squash = (w) => w.replace(/(.)\1+/gu, '$1');

// The text as it's shown, with its formatting applied (markdown.js): "c**at**" is shown as "cat". Line breaks, code
// blocks and line blocks (headings, small print, list items, quotes) stay apart; everything else that formatting adds
// or takes away goes.
const FORMAT = /[*_~|`]/;
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const BLOCK_SPAN = /^<span class="md-(?:h[123]|sub|li|quote)\b/;
export function asShown(text) {
  const s = String(text == null ? '' : text).slice(0, LIMITS.text);
  if (!FORMAT.test(s)) return s;
  try {
    // Only ever compared with the list, never put on the page. A line block is shown on lines of its own, with no
    // <br> around it, so both its start and its end (the </span> that closes it, told from an inline span's by
    // keeping count of the open ones) are line breaks. Tags are taken out until none are left, so a tag split around
    // another one can't come back together.
    const open = [];
    let out = render(s).replace(/<br>|<\/?pre\b[^>]*>|<span\b[^>]*>|<\/span>/g, (tag) => {
      if (tag === '</span>') return open.pop() ? '\n' : '';
      if (tag.startsWith('<span')) { const block = BLOCK_SPAN.test(tag); open.push(block); return block ? '\n' : ''; }
      return '\n';
    });
    let before;
    do { before = out; out = out.replace(/<[^>]*>/g, ''); } while (out !== before);
    return out.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITY[e]);
  } catch { return s; }
}
// What's compared for a text: the text as typed and, when its formatting changes it, as shown.
export function readings(text) {
  const s = String(text == null ? '' : text);
  const shown = asShown(s);
  return shown === s.slice(0, LIMITS.text) ? [s] : [s, shown];
}

// The words of a text, in order, and (when it has letters spelled out one at a time) the same with each such run
// read as one word: "you are c a t" -> [you, are, c, a, t] and [you, are, cat]. Folded, look-alikes as typed.
function read(text) {
  const s = fold(text);
  const words = [];
  const joined = [];
  let run = [];
  let spelled = false;
  let end = -1;
  const flush = () => {
    if (run.length >= 2) { joined.push(run.join('')); spelled = true; } else joined.push(...run);
    run = [];
  };
  for (const m of s.matchAll(WORD)) {
    const w = m[0];
    words.push(w);
    const gap = end < 0 ? '' : s.slice(end, m.index);
    end = m.index + w.length;
    const single = [...w].length === 1;
    // Spelled out: single letters with a short gap between them (a space, a dot, a dash), on one line.
    if (single && run.length && gap.length <= 3 && !/[\n\r]/.test(gap)) { run.push(w); continue; }
    flush();
    if (single) run.push(w); else joined.push(w);
  }
  flush();
  // Whether the text is written in Cyrillic or Greek (has letters of them that don't look Latin).
  const ctx = { C: REAL.C.test(s), G: REAL.G.test(s) };
  return { seqs: spelled ? [words, joined] : [words], ctx };
}
export const wordsOf = (text) => read(text).seqs;

// Whether a word written in one script (tw: the text's) can stand for an entry's word written in another (pw).
// Mixed words, and words in the same script, always can. Otherwise it's a disguise only in context: Latin letters
// standing for a Cyrillic or Greek word in text written in that script ("Закрой pot"), or look-alikes standing for
// a Latin word in text that isn't otherwise written in their script ("сат" among English words).
function scriptsFit(tw, pw, ctx) {
  if (!tw || !pw || tw === pw) return true;
  if (tw === 'L') return !!ctx[pw];
  return !ctx[tw];
}

// ------------------------------------------------------------------ entries
const STAR = 0;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const BROKEN = /\p{Cs}/u; // half of a character (a lone surrogate)
const word = (t) => t.match(/[\p{L}\p{N}\p{M}*]+/gu) || [];

// An entry as it's kept and shown: invisible and direction characters taken out (the matcher ignores them anyway,
// and in a list they could make an entry read as something else), control characters and runs of spaces made one
// space, trimmed.
export const cleanEntry = (raw) => String(raw == null ? '' : raw).replace(IGNORABLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

// One entry, ready to match: { text, words, key, need } or { error }. Each of words is { els: [STAR | { c, k }...],
// sc, need, min, first, last }.
//   key: the first word squashed, when it has no *: the entry is looked up by it;
//   need: the longest stretch of letters (squashed) the entry, or one word of it, has: a text or word without it
//     can't match (checked first); min: how many letters a word needs; first, last: the letters it starts and ends
//     with, when it doesn't start or end with a *.
export function parseEntry(raw) {
  const text = cleanEntry(raw);
  if (!text) return { error: 'empty' };
  if (BROKEN.test(text)) return { error: 'Has a broken character in it.' };
  if ([...text].length > LIMITS.length) return { error: `Up to ${LIMITS.length} characters.` };
  const parts = word(fold(text));
  if (!parts.length) return { error: 'Needs letters or numbers.' };
  if (parts.length > LIMITS.words) return { error: `Up to ${LIMITS.words} words.` };
  let stars = 0;
  let letters = 0;
  let need = '';
  const words = [];
  for (const p0 of parts) {
    const p1 = p0.replace(/\*+/g, '*');
    if (p1 === '*') return { error: 'A * goes inside a word (cat*), not on its own.' };
    const p = clampRuns(skeleton(p1));
    const els = [];
    let min = 0;
    for (const c of p) {
      if (c === '*') { stars++; els.push(STAR); continue; }
      letters++;
      const last = els[els.length - 1];
      if (last && last !== STAR && last.c === c) last.k++; else els.push({ c, k: 1 });
    }
    for (const el of els) if (el !== STAR) min += el.k;
    // No spaces between words in this script: the entry can be anywhere in a run of text.
    if (SPACELESS.test(p)) {
      if (els[0] !== STAR) els.unshift(STAR);
      if (els[els.length - 1] !== STAR) els.push(STAR);
    }
    let wneed = '';
    for (const seg of p.split('*')) { const sq = squash(seg); if ([...sq].length > [...wneed].length) wneed = sq; }
    if ([...wneed].length > [...need].length) need = wneed;
    const end = els[els.length - 1];
    words.push({ els, sc: scriptOf(p1), need: wneed, min, first: els[0] === STAR ? null : els[0].c, last: end === STAR ? null : end.c });
  }
  if (stars > LIMITS.wildcards) return { error: `Up to ${LIMITS.wildcards} *’s.` };
  if (letters < LIMITS.letters) return { error: `At least ${LIMITS.letters} letters or numbers.` };
  const first = words[0].els;
  const key = first.includes(STAR) ? null : first.map((e) => e.c).join('');
  return { text, words, key, need };
}

// A list as typed (one entry per line, or separated by commas) or as an array: the entries to keep (cleaned, the
// same entry once, in order) and what was wrong with the others. Past LIMITS.entries the rest are refused.
export function parseList(input) {
  const raw = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\n,]/);
  const entries = [];
  const errors = [];
  const seen = new Set();
  for (const r of raw.slice(0, 5000)) {
    const p = parseEntry(r);
    if (p.error === 'empty') continue;
    if (p.error) { errors.push({ entry: cleanEntry(r).slice(0, 80), error: p.error }); continue; }
    const same = fold(p.text);
    if (seen.has(same)) continue;
    seen.add(same);
    if (entries.length >= LIMITS.entries) { errors.push({ entry: p.text, error: `A list holds up to ${LIMITS.entries} entries.` }); continue; }
    entries.push(p.text);
  }
  if (raw.length > 5000) errors.push({ entry: '', error: `A list holds up to ${LIMITS.entries} entries.` });
  return { entries, errors };
}

// ------------------------------------------------------------------ matching
// Whether a word pattern matches the whole word t (an array of characters, runs of at most three). Each pattern
// letter written k times takes k of that letter from the text, or a run of three (a stretched letter); a * takes
// any number of letters. The reachable places in the word are kept as one row of flags: a single pass per pattern
// element, so the cost is the word's length times the pattern's. Two rows are kept and reused (words are at most
// MAX_WORD + 1 long by then).
let rowA = new Uint8Array(MAX_WORD + 2);
let rowB = new Uint8Array(MAX_WORD + 2);
function wordMatches(els, t, runs) {
  const n = t.length;
  if (rowA.length < n + 1) { rowA = new Uint8Array(n + 1); rowB = new Uint8Array(n + 1); }
  let cur = rowA;
  let next = rowB;
  cur.fill(0, 0, n + 1);
  cur[0] = 1;
  for (const el of els) {
    next.fill(0, 0, n + 1);
    let any = false;
    if (el === STAR) {
      let j = 0;
      while (j <= n && !cur[j]) j++;
      for (; j <= n; j++) { next[j] = 1; any = true; }
    } else {
      for (let j = 0; j < n; j++) {
        if (!cur[j] || t[j] !== el.c) continue;
        const avail = runs[j];
        if (el.k <= avail) { next[j + el.k] = 1; any = true; }
        if (avail === 3 && el.k < 3) { next[j + 3] = 1; any = true; }
      }
    }
    if (!any) return false;
    const was = cur; cur = next; next = was;
  }
  return cur[n] === 1;
}
// A text word ready to compare: its key (squashed, look-alikes read as Latin), and the rest when an entry gets past
// the quick checks: its characters (runs clamped; a word longer than MAX_WORD kept as its start and end with a break
// between them that no letter matches, so whatever matches there matches the whole word too), the run left from each
// place, and its script. A long word is cut at once, so its key is the cut one too.
const CUT = '\u0000';
function prep(w) {
  const tw = { w, key: '', t: null, runs: null, sc: '' };
  if (w.length > MAX_WORD) full(tw); else tw.key = squash(skeleton(w));
  return tw;
}
function full(tw) {
  if (tw.t) return tw;
  let t = [...clampRuns(skeleton(tw.w))];
  if (t.length > MAX_WORD) { t = [...t.slice(0, MAX_WORD / 2), CUT, ...t.slice(-MAX_WORD / 2)]; tw.key = squash(t.join('')); }
  else if (!tw.key) tw.key = squash(t.join(''));
  const runs = new Uint8Array(t.length);
  for (let j = t.length - 1; j >= 0; j--) runs[j] = j + 1 < t.length && t[j + 1] === t[j] ? runs[j + 1] + 1 : 1;
  tw.t = t; tw.runs = runs; tw.sc = scriptOf(tw.w);
  return tw;
}
const OVER = 2; // a comparison that ran out of budget
// What the budget counts: looking at one entry at one place in the text, a word compared with an entry's word the
// first time (the same pair again is remembered), and each walk's length × the entry word's.
const VISIT = 8;
const WALK = 32;

// One entry's word against one text word: the quick checks, then the walk. Remembered per pair for the text.
function wordFits(pw, tw, ctx, budget) {
  const memo = tw.memo || (tw.memo = new Map());
  const known = memo.get(pw);
  if (known !== undefined) return known;
  let r = false;
  if (!pw.need || tw.key.includes(pw.need)) {
    const { t } = full(tw);
    const n = t.length;
    if (n >= pw.min && (!pw.first || t[0] === pw.first) && (!pw.last || t[n - 1] === pw.last) && scriptsFit(tw.sc, pw.sc, ctx)) {
      budget.left -= WALK + (n + 1) * pw.els.length;
      if (budget.left < 0) return OVER;
      r = wordMatches(pw.els, t, tw.runs);
    }
  }
  memo.set(pw, r);
  return r;
}

// A matcher for a list of entries (anything parseEntry refuses is left out).
//   find(text or [texts]): the first entry that matches somewhere, TOO_COSTLY when the text would take too long to
//   check, or null;  test(text): whether find() isn't null.
export function compile(list) {
  const exact = new Map(); // key -> entries whose first word has no *
  const loose = new Map(); // the letters the first word of an entry with a * can't do without -> those entries
  let size = 0;
  for (const raw of Array.isArray(list) ? list.slice(0, LIMITS.entries) : []) {
    const e = parseEntry(raw);
    if (e.error) continue;
    e.i = size++;
    const [map, k] = e.key ? [exact, e.key] : [loose, e.words[0].need];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  const lens = [...new Set([...loose.keys()].map((k) => k.length))];
  const lookups = lens.reduce((sum, n) => sum + 1 + (n >> 3), 0); // budget per character of a word looked up: longer stretches cost more
  // The entries with a * a text word could start: those whose first word's letters are somewhere in it (looked up
  // by each stretch of the word that long, so the cost goes with the word, not the list).
  const starts = (tw, budget) => {
    if (tw.starts) return tw.starts;
    const found = new Set();
    const k = tw.key;
    budget.left -= k.length * lookups;
    for (const n of lens) for (let j = 0; j + n <= k.length; j++) { const es = loose.get(k.slice(j, j + n)); if (es) found.add(es); }
    return (tw.starts = [...found].flat());
  };
  // The entries whose first word fits a text word, worked out once per different word: true, or OVER.
  const firsts = (tw, ctx, budget) => {
    if (tw.firsts) return tw.firsts;
    const out = [];
    for (const e of [...(exact.get(tw.key) || []), ...starts(tw, budget)]) {
      if ((budget.left -= VISIT) < 0) return OVER;
      const r = wordFits(e.words[0], tw, ctx, budget);
      if (r === OVER) return OVER;
      if (r) out.push(e);
    }
    // In list order, so the entry named is the first on the list that matches there.
    return (tw.firsts = out.sort((a, b) => a.i - b.i));
  };
  // The rest of a phrase from word i of seq on: true, false or OVER.
  const rest = (e, seq, i, ctx, budget) => {
    if (e.words.length === 1) return true;
    if ((budget.left -= VISIT) < 0) return OVER;
    if (i + e.words.length > seq.length) return false;
    for (let x = 1; x < e.words.length; x++) {
      const r = wordFits(e.words[x], seq[i + x], ctx, budget);
      if (r !== true) return r;
    }
    return true;
  };
  function findIn(text, budget) {
    const { seqs: raw, ctx } = read(text);
    // Each different word is prepared (and compared with each entry's word) once, however often it comes.
    const words = new Map();
    const seqs = raw.map((ws) => ws.map((w) => { let p = words.get(w); if (!p) words.set(w, (p = prep(w))); return p; }));
    for (const seq of seqs) {
      for (let i = 0; i < seq.length; i++) {
        const fs = firsts(seq[i], ctx, budget);
        if (fs === OVER) return TOO_COSTLY;
        for (const e of fs) { const r = rest(e, seq, i, ctx, budget); if (r) return r === OVER ? TOO_COSTLY : e.text; }
      }
    }
    return null;
  }
  function find(input) {
    if (!size) return null;
    const budget = { left: BUDGET };
    for (const text of Array.isArray(input) ? input : [input]) {
      const r = findIn(text, budget);
      if (r) return r;
    }
    return null;
  }
  return { size, find, test: (text) => find(text) !== null };
}

// Everything a message shows as text: its words, its link previews' title, description and site name, a poll's
// question and options, a bot post's card, and its files' names and descriptions (alt text). (dec: the decrypted
// message.)
export function textOfMessage(dec) {
  if (!dec || typeof dec !== 'object') return '';
  const out = [];
  const add = (v) => { if (typeof v === 'string' && v) out.push(v); };
  add(dec.t);
  for (const l of Array.isArray(dec.l) ? dec.l.slice(0, 5) : []) if (l && typeof l === 'object') { add(l.title); add(l.desc); add(l.site); }
  if (dec.p && typeof dec.p === 'object') { add(dec.p.q); for (const o of Array.isArray(dec.p.o) ? dec.p.o.slice(0, 20) : []) add(typeof o === 'string' ? o : o && o.t); }
  if (dec.embed && typeof dec.embed === 'object') { add(dec.embed.title); add(dec.embed.summary); add(dec.embed.source); }
  for (const f of Array.isArray(dec.f) ? dec.f.slice(0, 20) : []) if (f && typeof f === 'object') { add(f.name); add(f.alt); }
  return out.join('\n');
}
