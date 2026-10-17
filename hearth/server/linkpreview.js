// Link previews built by the sender (docs/design/LINK-PREVIEWS.md).
//
// Someone about to send a link can ask this server for the page's title, description, site name and picture.
// Their app shrinks the picture and puts all of it inside the end-to-end encrypted message, so people reading
// it never contact the linked site (or this server) for the card. The price: this server sees the links people
// choose to preview, and who asked. That is said plainly in the app, README and SECURITY.md.
//
// The page is fetched like every other outbound request, through netguard (public addresses only, DNS pinned,
// every redirect checked, one deadline, size caps), and on top of that: https on port 443 only, real host names
// only (no IP literals or reserved names), never this server's own names. The HTML is never run or rendered:
// a small linear tokenizer reads the <head> in a worker thread with a time limit and pulls out the OpenGraph,
// X/Twitter and plain meta tags. Every text field has its markup and control characters removed, is decoded once,
// and capped. Pictures are checked by their bytes (JPEG, PNG, GIF or WebP of a sane size), never by the header.
//
// Results are cached per account for a few minutes, never shared between accounts (a shared cache would tell one
// person what another previewed, and let one person's copy of a page become what everyone sees). Nothing is
// written to disk, and URLs, hosts and titles never reach the log.
const net = require('net');
const netguard = require('./netguard');
const jobs = require('./jobs');
const log = require('./log');

const L = log.child('linkpreview');

const URL_MAX = 2048;
const PAGE_MAX_BYTES = 512 * 1024;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const OEMBED_MAX_BYTES = 64 * 1024;
const PAGE_REDIRECTS = 4;
const IMAGE_REDIRECTS = 3;
const TITLE_MAX = 200;
const DESC_MAX = 300;
const SITE_MAX = 60;
const IMG_MIN_SIDE = 48; // smaller is a tracking pixel or an icon
const IMG_MAX_SIDE = 8192;
const IMG_MAX_AREA = 25000000; // decompression bombs stop here, before they reach anyone's browser
// One budget for the page and its picture together.
const TOTAL_MS = Math.max(1000, Math.min(30000, +process.env.LINK_PREVIEW_TIMEOUT_MS || 10000));
const PAGE_MS = Math.round(TOTAL_MS * 0.7);
const IMAGE_MIN_MS = Math.min(1500, Math.round(TOTAL_MS * 0.15));
const PARSE_LIMIT_MS = +process.env.LINK_PREVIEW_PARSE_LIMIT_MS || 2000;
// Tests only, like FEED_ALLOW_PRIVATE: lets this server reach local stand-in sites on ports other than 443 and on
// private addresses. "1" allows every host; a comma-separated list of names allows only those (so a test can
// still show that a redirect to some other private name is refused).
const PRIVATE_ENV = String(process.env.LINK_PREVIEW_ALLOW_PRIVATE || '').trim();
const TEST_SITES = PRIVATE_ENV !== '' && PRIVATE_ENV !== '0';
const PRIVATE_HOSTS = PRIVATE_ENV === '1' ? null : new Set(PRIVATE_ENV.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const ALLOW_PRIVATE = !TEST_SITES ? false : PRIVATE_HOSTS ? (u) => PRIVATE_HOSTS.has(u.hostname) : true;

// Names that never point at a public web site (RFC 2606, 6761, 6762, 7686, 8375 and common LAN suffixes).
const RESERVED_TLDS = new Set(['localhost', 'local', 'lan', 'internal', 'test', 'example', 'invalid', 'onion', 'i2p', 'arpa', 'home', 'corp', 'localdomain']);
const RESERVED_HOSTS = new Set(['example.com', 'example.net', 'example.org']);
const LABEL = /^[a-z0-9-]{1,63}$/;

class PreviewRefused extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Why a host name may not be fetched ('' if it may). `host` is URL.hostname: already lowercase and punycoded.
function hostProblem(host, ownHosts) {
  const h = String(host || '');
  if (!h || h.length > 253 || h.includes('%')) return 'bad_url';
  if (h.startsWith('[') || net.isIP(h)) return 'bad_url';
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return 'bad_url';
  if (RESERVED_TLDS.has(labels[labels.length - 1]) || RESERVED_HOSTS.has(labels.slice(-2).join('.'))) return 'bad_url';
  if (ownHosts && ownHosts.has(h)) return 'own_server';
  return '';
}

// The link someone asked about, checked before anything leaves this server. Returns { u, fetchUrl } (the part
// after "#" is never sent anywhere) or throws PreviewRefused with a message fit to show people.
function checkPreviewUrl(raw, ownHosts = new Set(), { anyPort = TEST_SITES } = {}) {
  const bad = (msg = 'Only https links to a web site can get a preview.') => { throw new PreviewRefused('bad_url', msg); };
  if (typeof raw !== 'string' || !raw || raw.length > URL_MAX) bad('That link is too long, or empty.');
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) bad();
  let u;
  try { u = new URL(raw); } catch { bad(); }
  if (u.protocol !== 'https:' || u.username || u.password) bad();
  if (u.port !== '' && !anyPort) bad('Only links on the usual https port can get a preview.');
  const why = hostProblem(u.hostname, ownHosts);
  if (why === 'own_server') throw new PreviewRefused('own_server', 'Links to this server don’t get a preview.');
  if (why) bad();
  const f = new URL(u.href);
  f.hash = '';
  if (f.href.length > URL_MAX) bad('That link is too long.');
  return { u, fetchUrl: f.href };
}

// ------------------------------------------------------------------ text
// Named character references: HTML 4's whole set (Latin-1 letters, Greek, symbols, typography) and the ASCII
// punctuation names some sites write. Names are case-sensitive, as in browsers (&Eacute; is É, &eacute; is é);
// a Map, so "&constructor;" and the like stay as they are.
const ENT = (() => {
  const m = new Map();
  const run = (names, from) => names.split(' ').forEach((n, i) => m.set(n, from + i));
  run('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest '
    + 'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig '
    + 'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml', 160);
  run('Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho', 913);
  run('Sigma Tau Upsilon Phi Chi Psi Omega', 931);
  run('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega', 945);
  const one = {
    quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, QUOT: 34, AMP: 38, LT: 60, GT: 62, COPY: 169, REG: 174, TRADE: 8482,
    excl: 33, num: 35, dollar: 36, percnt: 37, lpar: 40, rpar: 41, ast: 42, plus: 43, comma: 44, period: 46, sol: 47, colon: 58, semi: 59, equals: 61,
    quest: 63, commat: 64, lsqb: 91, bsol: 92, rsqb: 93, Hat: 94, lowbar: 95, grave: 96, lcub: 123, verbar: 124, vert: 124, rcub: 125,
    OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732, thetasym: 977, upsih: 978, piv: 982,
    ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, hyphen: 8208, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218,
    ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, mldr: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249,
    rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, image: 8465, weierp: 8472, real: 8476, trade: 8482, alefsym: 8501,
    larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660,
    forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715, prod: 8719, sum: 8721, minus: 8722, lowast: 8727,
    radic: 8730, prop: 8733, infin: 8734, ang: 8736, and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776,
    ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901,
    lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 10216, rang: 10217, loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
    starf: 9733, star: 9734, check: 10003, half: 189,
  };
  for (const [k, v] of Object.entries(one)) m.set(k, v);
  for (const [k, v] of m) m.set(k, String.fromCodePoint(v));
  return m;
})();
const codePoint = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '');
// Character references, decoded once (so "&amp;lt;" stays "&lt;" as text, never a tag).
const decodeEntities = (s) => String(s || '').replace(/&(#x[0-9a-f]{1,8}|#\d{1,9}|[a-z][a-z0-9]{1,31});/gi, (m, e) => (e[0] === '#'
  ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT.get(e) ?? m));
// Markup written as markup (a "<b>" or "<script>" right in a title or description, or the tags in an oEmbed
// answer): only things shaped like a tag, so "a < b > c" and "<3" stay.
const MARKUP = /<[/!]?[a-z][^<>]{0,500}>|<!--[^<>]{0,500}-->/gi;
// Control characters, zero-width spaces and the marks that reorder text around them (bidi). The zero-width
// joiner (U+200D) stays: emoji sequences need it.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g;
// Markup is dropped before character references are decoded, so text the page escaped stays text: a title
// "List&lt;string&gt;" reads "List<string>". Cards are drawn with text nodes only, so nothing here is for safety
// (a sender's app can put any text in a card anyway); it's so the card says what the page says.
function cleanText(s, max) {
  let t = decodeEntities(String(s == null ? '' : s).slice(0, 20000).replace(MARKUP, ' '));
  t = t.replace(INVISIBLE, '').replace(/\s+/g, ' ').normalize('NFC').trim();
  const cps = [...t];
  if (cps.length > max) t = `${cps.slice(0, max - 1).join('').trimEnd()}…`;
  return t;
}

// ------------------------------------------------------------------ bytes → text
// The WHATWG order, simplified: byte order mark, then the Content-Type charset, then a <meta> in the first few KB,
// then UTF-8. A label this build can't decode falls back to UTF-8 (with replacement characters).
function charsetLabel(s) {
  const m = /charset\s*=\s*["']?\s*([\w.:-]{1,40})/i.exec(String(s || ''));
  return m ? m[1].toLowerCase() : '';
}
function decoderFor(label) {
  try { return new TextDecoder(label, { fatal: false }); } catch { return null; }
}
// windows-1252 by hand: Node's TextDecoder reads it as ISO-8859-1, so curly quotes, dashes and € (0x80-0x9F)
// would come out as invisible control characters. This label also covers "latin1", "ascii" and the rest of its
// family, as browsers do.
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const decode1252 = (b) => b.toString('latin1').replace(/[\u0080-\u009f]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]);
const decodeWith = (d, b) => (d.encoding === 'windows-1252' ? decode1252(b) : d.decode(b));
function decodeHtml(bytes, contentType = '') {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  let label = charsetLabel(contentType);
  let d = label && decoderFor(label);
  if (!d) {
    // The prescan reads bytes as latin1, which keeps every ASCII character where it is.
    const head = b.subarray(0, 4096).toString('latin1');
    const m = /<meta[^>]{0,512}?charset\s*=\s*["']?\s*([\w.:-]{1,40})/i.exec(head);
    label = m ? m[1].toLowerCase() : '';
    // A page can't really be UTF-16 if its <meta> was readable as ASCII; x-user-defined means windows-1252.
    if (/^utf-?16/.test(label)) label = 'utf-8';
    if (label === 'x-user-defined') label = 'windows-1252';
    d = label && decoderFor(label);
  }
  return decodeWith(d || new TextDecoder('utf-8'), b);
}

// ------------------------------------------------------------------ reading the <head>
// A tokenizer made of indexOf calls and bounded loops: no regular expression ever runs over the page, and it
// never goes back. A broken tag is given up on from where its reading stopped (the "<" that cut it short, or the
// end of the 8 KiB it may read), not from just after its "<", which let one window be read again by every tag
// in it. A step budget (a few times the page's length) stops it should that ever not hold.
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes']);
const META_KEYS = new Set(['og:title', 'og:description', 'og:site_name', 'og:type', 'og:image', 'og:image:url', 'og:image:secure_url', 'og:image:width', 'og:image:height',
  'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:src', 'description', 'application-name']);
const MAX_TAGS = 4000;
const MAX_TAG_CHARS = 8192;
const MAX_ATTRS = 32;
const MAX_ATTR_NAME = 64;
const MAX_ATTR_VALUE = 4096;
const MAX_TITLE = 2000;
const MAX_HTML_CHARS = 512 * 1024;
const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isNameChar = (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-' || c === ':' || c === '_';

function parseHead(input) {
  const html = String(input || '').slice(0, MAX_HTML_CHARS);
  // ASCII-only lowercasing keeps every index the same (toLowerCase can make some characters longer).
  const lower = html.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const n = html.length;
  const meta = {};
  let title = null;
  let imageSrc = null;
  // Characters looked at, all scans together; reading stops once it passes the budget.
  let steps = 0;
  const budget = 4 * n + 4096;
  // Where the next quote character is, remembered, so a page full of unclosed quotes can't make each tag scan
  // to the end of the page again.
  const nextAt = { '"': { from: -1, at: -1 }, '\'': { from: -1, at: -1 } };
  const nextQuote = (q, from) => {
    const c = nextAt[q];
    if (c.from !== -1 && from >= c.from && (c.at === -1 || from <= c.at)) return c.at;
    c.from = from; c.at = html.indexOf(q, from);
    steps += (c.at === -1 ? n : c.at) - from;
    return c.at;
  };
  // Reads the attributes of a tag whose name ends at k. Returns { end, attrs } (end: the index of ">"), or
  // { stop } when the tag is broken or runs over MAX_TAG_CHARS: stop is where reading carries on.
  const readTag = (start) => {
    let k = start;
    const limit = Math.min(n, k + MAX_TAG_CHARS);
    const attrs = [];
    const out = (r) => { steps += k - start; return r; };
    while (k < limit) {
      const c = html[k];
      if (c === '>') return out({ end: k, attrs });
      if (c === '<') return out({ stop: k }); // a new tag starts before this one ended: read on from it
      if (isSpace(c) || c === '/') { k++; continue; }
      const nameStart = k;
      while (k < limit && !isSpace(html[k]) && html[k] !== '>' && html[k] !== '/' && html[k] !== '=' && html[k] !== '<') k++;
      const name = lower.slice(nameStart, Math.min(k, nameStart + MAX_ATTR_NAME));
      while (k < limit && isSpace(html[k])) k++;
      let value = '';
      if (html[k] === '=') {
        k++;
        while (k < limit && isSpace(html[k])) k++;
        const q = html[k];
        if (q === '"' || q === '\'') {
          const e = nextQuote(q, k + 1);
          if (e === -1 || e >= limit) { k = limit; return out({ stop: limit }); } // a quote that never closes in time
          value = html.slice(k + 1, Math.min(e, k + 1 + MAX_ATTR_VALUE));
          k = e + 1;
        } else {
          const vs = k;
          while (k < limit && !isSpace(html[k]) && html[k] !== '>' && html[k] !== '<') k++;
          value = html.slice(vs, Math.min(k, vs + MAX_ATTR_VALUE));
        }
      }
      if (name && attrs.length < MAX_ATTRS) attrs.push([name, value]);
    }
    return out({ stop: limit });
  };
  const attr = (attrs, name) => { const a = attrs.find(([k]) => k === name); return a ? a[1] : null; };

  let i = 0;
  let tags = 0;
  while (i < n && tags < MAX_TAGS && steps <= budget) {
    const lt = lower.indexOf('<', i);
    if (lt === -1) break;
    steps += lt - i + 1;
    if (lower.startsWith('<!--', lt)) {
      // "<!-->" and "<!--->" are whole (empty) comments, as browsers read them.
      if (lower.startsWith('>', lt + 4)) { i = lt + 5; continue; }
      if (lower.startsWith('->', lt + 4)) { i = lt + 6; continue; }
      const e = lower.indexOf('-->', lt + 4);
      if (e === -1) break;
      steps += e - lt;
      i = e + 3;
      continue;
    }
    let j = lt + 1;
    const closing = lower[j] === '/';
    if (closing) j++;
    const nameStart = j;
    while (j < n && j - nameStart < 32 && isNameChar(lower[j])) j++;
    const name = lower.slice(nameStart, j);
    if (!name || !(lower[nameStart] >= 'a' && lower[nameStart] <= 'z')) { i = lt + 1; continue; } // <!doctype, <?xml, a stray "<"
    const tag = readTag(j);
    if (tag.stop !== undefined) { i = tag.stop; continue; }
    tags++;
    i = tag.end + 1;
    if (closing) { if (name === 'head') break; continue; }
    if (name === 'body') break;
    if (name === 'plaintext') break;
    if (RAW_TEXT.has(name) || name === 'title') {
      const e = lower.indexOf(`</${name}`, i);
      if (name === 'title' && title === null) title = html.slice(i, e === -1 ? Math.min(n, i + MAX_TITLE) : Math.min(e, i + MAX_TITLE));
      if (e === -1) break;
      steps += e - i;
      i = e;
      continue;
    }
    if (name === 'meta') {
      const key = (attr(tag.attrs, 'property') || attr(tag.attrs, 'name') || '').trim().toLowerCase();
      const content = attr(tag.attrs, 'content');
      if (META_KEYS.has(key) && content !== null && meta[key] === undefined) meta[key] = content; // the first one wins (ogp.me)
    } else if (name === 'link' && imageSrc === null) {
      const rel = (attr(tag.attrs, 'rel') || '').toLowerCase().split(/\s+/);
      const href = attr(tag.attrs, 'href');
      if (rel.includes('image_src') && href) imageSrc = href;
    }
  }
  return { meta, title, imageSrc };
}

// The fields a preview shows, from what parseHead found.
function chooseFields(head) {
  const m = head.meta || {};
  return {
    title: cleanText(m['og:title'] || m['twitter:title'] || head.title || '', TITLE_MAX),
    description: cleanText(m['og:description'] || m['twitter:description'] || m.description || '', DESC_MAX),
    siteName: cleanText(m['og:site_name'] || m['application-name'] || '', SITE_MAX),
    ogType: String(m['og:type'] || '').trim().toLowerCase().slice(0, 40),
  };
}

// The picture to fetch: the first candidate that resolves (against the page's final address) to an https link.
// An http one is tried as https; data:, javascript: and everything else are skipped.
function pickImage(head, base) {
  const m = head.meta || {};
  const list = [m['og:image:secure_url'], m['og:image'], m['og:image:url'], m['twitter:image'], m['twitter:image:src'], head.imageSrc];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const s = decodeEntities(raw).trim();
    if (!s || s.length > URL_MAX) continue;
    let u;
    try { u = new URL(s, base); } catch { continue; }
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:' || u.username || u.password) continue;
    u.hash = '';
    if (u.href.length > URL_MAX) continue;
    return u.href;
  }
  return null;
}

const CHALLENGE = /^(just a moment\.\.\.|attention required!|access denied|are you a robot|before you continue)/i;
const looksLikeChallenge = (title) => CHALLENGE.test(String(title || '').trim());

// ------------------------------------------------------------------ pictures
// The type and size of a picture, read from its bytes (the Content-Type header is never trusted). null for
// anything that isn't a JPEG, PNG, GIF or WebP whose size can be read.
function sniffImage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) {
    return { type: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && b[20] === 0x2f) { const bits = b.readUInt32LE(21); return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8X') return { type: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    for (let markers = 0; i + 4 <= b.length && markers < 4096; markers++) {
      if (b[i] !== 0xff) return null;
      const mk = b[i + 1];
      if (mk === 0xff) { i++; continue; } // fill bytes
      if (mk === 0x01 || (mk >= 0xd0 && mk <= 0xd8)) { i += 2; continue; } // markers without a length
      if (mk === 0xd9 || mk === 0xda) return null; // end of image, or image data before any frame header
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return null;
      const sof = (mk >= 0xc0 && mk <= 0xc3) || (mk >= 0xc5 && mk <= 0xc7) || (mk >= 0xc9 && mk <= 0xcb) || (mk >= 0xcd && mk <= 0xcf);
      if (sof) return i + 9 <= b.length ? { type: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) } : null;
      i += 2 + len;
    }
  }
  return null;
}
const saneSize = (s) => !!s && s.width >= IMG_MIN_SIDE && s.height >= IMG_MIN_SIDE && s.width <= IMG_MAX_SIDE && s.height <= IMG_MAX_SIDE && s.width * s.height <= IMG_MAX_AREA;
// What the app gets: the picture as it came (its device shrinks and re-encodes it, which also drops metadata).
function imageOut(body) {
  const s = sniffImage(body);
  if (!saneSize(s)) return null;
  return { type: s.type, data: body.toString('base64'), width: s.width, height: s.height, bytes: body.length };
}

// ------------------------------------------------------------------ YouTube and X
const YT_HOSTS = new Set(['youtube.com', 'youtube-nocookie.com', 'youtu.be']);
const isYoutubeHost = (host) => YT_HOSTS.has(String(host || '').toLowerCase().replace(/^(www|m|music)\./, ''));
// The video id in a YouTube link: the same rules as watch together (index.js parseWatchUrl uses this), '' when
// the link is YouTube's but not a video, null when it isn't YouTube's at all.
function youtubeId(u) {
  if (!u || !isYoutubeHost(u.hostname)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const id = host === 'youtu.be' ? u.pathname.slice(1, 12) : (u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) || [])[1]);
  return /^[\w-]{11}$/.test(id || '') ? id : '';
}
const X_HOSTS = new Set(['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'x.com', 'www.x.com']);
const isXHost = (host) => X_HOSTS.has(String(host || '').toLowerCase());
// { handle, id } for a post link on X, null for anything else.
function xStatus(u) {
  if (!u || !isXHost(u.hostname)) return null;
  const m = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:\/|$)/.exec(u.pathname);
  return m ? { handle: m[1], id: m[2] } : null;
}
// The text of the first <p> in an oEmbed answer's html: read, never rendered.
function xText(html) {
  const s = String(html || '').slice(0, 20000);
  const lower = s.replace(/[A-Z]+/g, (x) => x.toLowerCase());
  const p = lower.indexOf('<p');
  if (p === -1) return '';
  const open = lower.indexOf('>', p);
  const close = lower.indexOf('</p>', open);
  if (open === -1 || close === -1) return '';
  return cleanText(s.slice(open + 1, close).replace(/<br\s*\/?>/gi, ' '), DESC_MAX);
}

// ------------------------------------------------------------------ parsing in a worker
// A page that's slow to read can't hold up chat or calls; one that takes longer than PARSE_LIMIT_MS is given up
// on and the worker replaced (the same pattern as newsbot.js). Each worker keeps its own jobs, so a worker that
// stops (late, after it was replaced) can only fail what was sent to it, and only ever clears itself.
let parser = null; let parseSeq = 0; let parserThreads = 0;
function parserWorker() {
  if (parser) return parser;
  const { Worker } = require('worker_threads');
  const me = { w: new Worker(__filename, { workerData: { linkParser: true } }), jobs: new Map() };
  parserThreads++;
  me.w.on('message', ({ id, ok, err }) => { const p = me.jobs.get(id); if (!p) return; me.jobs.delete(id); if (err) p.reject(new Error(err)); else p.resolve(ok); });
  const failAll = (e) => { if (parser === me) parser = null; for (const p of me.jobs.values()) p.reject(e); me.jobs.clear(); };
  me.w.on('error', failAll);
  me.w.on('exit', () => { parserThreads--; failAll(new Error('The page reader stopped.')); });
  me.w.unref();
  parser = me;
  return me;
}
// Hands a job to the current worker, with its time limit counted from now.
function sendJob(job) {
  const me = parserWorker();
  job.timer = setTimeout(() => {
    if (me.jobs.get(job.id) !== job) return;
    me.jobs.delete(job.id);
    job.reject(Object.assign(new Error('That page takes too long to read.'), { code: 'PARSE_TIMEOUT' }));
    // That worker is stuck on this page: stop it, and give the jobs waiting behind it to a new one (their
    // pages did nothing wrong).
    if (parser === me) parser = null;
    const behind = [...me.jobs.values()];
    me.jobs.clear();
    me.w.terminate().catch(() => {});
    for (const j of behind) { clearTimeout(j.timer); sendJob(j); }
  }, job.limit);
  me.jobs.set(job.id, job);
  me.w.postMessage({ id: job.id, bytes: job.bytes, contentType: job.contentType });
}
// limit: tests only (the route always uses PARSE_LIMIT_MS).
function parseInWorker(bytes, contentType, limit = PARSE_LIMIT_MS) {
  return new Promise((resolve, reject) => {
    const job = { id: ++parseSeq, bytes, contentType: String(contentType || ''), limit, timer: null };
    job.resolve = (v) => { clearTimeout(job.timer); resolve(v); };
    job.reject = (e) => { clearTimeout(job.timer); reject(e); };
    sendJob(job);
  });
}
const readPage = (bytes, contentType) => parseHead(decodeHtml(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength ?? bytes.length), contentType));
{
  const { isMainThread, parentPort, workerData } = require('worker_threads');
  if (!isMainThread && workerData && workerData.linkParser) {
    parentPort.on('message', ({ id, bytes, contentType }) => {
      try { parentPort.postMessage({ id, ok: readPage(bytes, contentType) }); } catch (e) { parentPort.postMessage({ id, err: String((e && e.message) || e) }); }
    });
  }
}

// ------------------------------------------------------------------ the route
module.exports = function setupLinkPreviews(ctx) {
  const { api, auth, fail, wrap, rateLimit, countHit, limitNet, features, publicUrl, version } = ctx;
  const UA = `Mozilla/5.0 (compatible; HearthLinkPreview/${version || '1'}; +self-hosted chat)`;
  const ACCEPT_LANGUAGE = String(process.env.LINK_PREVIEW_ACCEPT_LANGUAGE || 'en').replace(/[^\w,;=.* -]/g, '').slice(0, 100) || 'en';
  const YT_OEMBED = process.env.LINK_PREVIEW_YOUTUBE_OEMBED || 'https://www.youtube.com/oembed';
  const YTIMG = (process.env.LINK_PREVIEW_YTIMG_BASE || 'https://i.ytimg.com').replace(/\/+$/, '');
  const X_OEMBED = process.env.LINK_PREVIEW_X_OEMBED || 'https://publish.twitter.com/oembed';

  // This server's own names: a preview of them would be this server fetching itself.
  function ownHosts(req) {
    const out = new Set();
    const add = (s) => { try { out.add(new URL(s).hostname.toLowerCase()); } catch { /* not a URL */ } };
    add(process.env.PUBLIC_URL || '');
    add(publicUrl ? publicUrl() : '');
    if (req && req.hostname) out.add(String(req.hostname).toLowerCase().replace(/^\[|\]$/g, ''));
    for (const h of String(process.env.PUBLIC_HOSTS || '').split(',')) if (h.trim()) out.add(h.trim().toLowerCase());
    return out;
  }
  // Checked on every hop, redirects included.
  const hopOk = (own) => (u) => u.protocol === 'https:' && (TEST_SITES || u.port === '') && !u.username && !u.password && !hostProblem(u.hostname, own);
  // An endpoint this server knows (oEmbed, thumbnails): only that exact host and port, no detours.
  const sameHost = (base) => { const b = new URL(base); return (u) => u.protocol === 'https:' && u.host === b.host; };

  const REASON = {
    PRIVATE: 'blocked', NOT_ALLOWED: 'blocked', BAD_PROTOCOL: 'blocked', BAD_URL: 'blocked', REDIRECTS: 'blocked',
    NOT_FOUND: 'unreachable', NETWORK: 'unreachable', BAD_ENCODING: 'unreachable', TOO_BIG: 'unreachable',
    TIMEOUT: 'timeout', PARSE_TIMEOUT: 'timeout',
  };
  class Stop extends Error { constructor(reason) { super(reason); this.reason = reason; } }
  const guard = async (p) => {
    try { return await p; } catch (e) {
      if (e && e.code === 'ABORTED') throw e;
      throw new Stop(REASON[e && e.code] || 'unreachable');
    }
  };

  async function fetchImage(url, { own, deadline, signal, allowUrl }) {
    if (!allowUrl) {
      try { if (countHit('lphost:' + new URL(url).hostname, 60000) > 60) return null; } catch { return null; }
    }
    try {
      const r = await netguard.request(url, {
        protocols: ['https:'], allowUrl: allowUrl || hopOk(own), allowPrivate: ALLOW_PRIVATE, maxRedirects: IMAGE_REDIRECTS,
        timeout: Math.max(IMAGE_MIN_MS, deadline - Date.now()), maxBytes: IMAGE_MAX_BYTES, signal,
        headers: { 'User-Agent': UA, Accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9' },
      });
      return r.ok ? imageOut(r.body) : null;
    } catch (e) {
      if (e && e.code === 'ABORTED') throw e;
      return null;
    }
  }
  async function oembed(base, query, { deadline, signal }) {
    const r = await guard(netguard.request(`${base}${base.includes('?') ? '&' : '?'}${query}`, {
      protocols: ['https:'], allowUrl: sameHost(base), allowPrivate: ALLOW_PRIVATE, maxRedirects: 1,
      timeout: Math.max(500, Math.min(5000, deadline - Date.now())), maxBytes: OEMBED_MAX_BYTES, signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': ACCEPT_LANGUAGE },
    }));
    if (!r.ok) throw new Stop('none');
    let j;
    try { j = JSON.parse(r.body.toString('utf8')); } catch { throw new Stop('none'); }
    if (!j || typeof j !== 'object') throw new Stop('none');
    return j;
  }

  async function youtube(id, opts) {
    const j = await oembed(YT_OEMBED, `format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, opts);
    const title = cleanText(j.title, TITLE_MAX);
    if (!title) throw new Stop('none');
    // Built from the id: the answer's thumbnail_url isn't trusted. mqdefault has no black bars; older videos may
    // only have hqdefault.
    const thumbs = sameHost(YTIMG);
    const image = await fetchImage(`${YTIMG}/vi/${id}/mqdefault.jpg`, { ...opts, allowUrl: thumbs })
      || await fetchImage(`${YTIMG}/vi/${id}/hqdefault.jpg`, { ...opts, allowUrl: thumbs });
    return { title, description: cleanText(j.author_name, DESC_MAX), siteName: 'YouTube', kind: 'video', image };
  }
  async function xPost(s, opts) {
    const j = await oembed(X_OEMBED, `url=${encodeURIComponent(`https://twitter.com/${s.handle}/status/${s.id}`)}&omit_script=1&dnt=true&hide_thread=true`, opts);
    const name = cleanText(j.author_name, 100);
    const text = xText(j.html);
    if (!name && !text) throw new Stop('none');
    return { title: name ? `${name} (@${s.handle})` : `@${s.handle}`, description: text, siteName: 'X', kind: 'post', image: null };
  }

  async function generic(fetchUrl, u, opts) {
    const r = await guard(netguard.request(fetchUrl, {
      protocols: ['https:'], allowUrl: hopOk(opts.own), allowPrivate: ALLOW_PRIVATE, maxRedirects: PAGE_REDIRECTS,
      timeout: Math.max(500, Math.min(PAGE_MS, opts.deadline - Date.now())), maxBytes: PAGE_MAX_BYTES, truncate: true, decompress: true, signal: opts.signal,
      headers: {
        'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1', 'Accept-Language': ACCEPT_LANGUAGE,
      },
    }));
    if (!r.ok) throw new Stop('unreachable');
    let final;
    try { final = new URL(r.url); } catch { throw new Stop('unreachable'); }
    if (/^consent\.(youtube|google)\.com$/.test(final.hostname)) throw new Stop('challenge');
    const type = r.type.split(';')[0].trim().toLowerCase();
    if (/^image\/(jpeg|png|gif|webp)$/.test(type)) {
      const image = r.truncated ? null : imageOut(r.body);
      if (!image) throw new Stop('none');
      return { title: '', description: '', siteName: '', kind: 'image', image };
    }
    if (type !== 'text/html' && type !== 'application/xhtml+xml') throw new Stop('not_html');
    let head;
    try { head = await parseInWorker(r.body, r.type); } catch (e) { throw new Stop(e && e.code === 'PARSE_TIMEOUT' ? 'timeout' : 'none'); }
    const f = chooseFields(head);
    if (looksLikeChallenge(f.title)) throw new Stop('challenge');
    const imgUrl = pickImage(head, final.href);
    const image = imgUrl ? await fetchImage(imgUrl, opts) : null;
    if (!f.title && !f.description && !image) throw new Stop('none');
    const kind = u.hostname === 'github.com' ? 'repo' : /^video(\.|$)/.test(f.ogType) ? 'video' : 'web';
    return { title: f.title, description: f.description, siteName: f.siteName, kind, image };
  }

  // { preview, reason }: never throws except when the person went away (ABORTED).
  async function build(checked, own, signal) {
    const { u, fetchUrl } = checked;
    const opts = { own, signal, deadline: Date.now() + TOTAL_MS };
    try {
      const yt = youtubeId(u);
      if (yt) return { preview: await youtube(yt, opts) };
      const xs = xStatus(u);
      if (xs) return { preview: await xPost(xs, opts) };
      // Other X pages are never fetched: they need JavaScript and a sign-in to show anything.
      if (isXHost(u.hostname)) return { preview: null, reason: 'none' };
      return { preview: await generic(fetchUrl, u, opts) };
    } catch (e) {
      if (e instanceof Stop) return { preview: null, reason: e.reason };
      if (e && e.code === 'ABORTED') throw e;
      L.warn('failed', { code: (e && e.code) || 'error' }); // never the message: it can name the host
      return { preview: null, reason: 'unreachable' };
    }
  }

  // ---- the cache: per account, in memory, short-lived
  const cache = new Map(); // `${userId}\n${fetchUrl}` -> { uid, expires, preview, reason, bytes }, least recently used first
  const byUser = new Map(); // userId -> Set of keys, oldest first
  let cacheBytes = 0;
  const PER_USER = 20; const MAX_ENTRIES = 2000; const MAX_BYTES = 48 * 1024 * 1024;
  const drop = (key) => {
    const e = cache.get(key);
    if (!e) return;
    cache.delete(key); cacheBytes -= e.bytes;
    const s = byUser.get(e.uid);
    if (s) { s.delete(key); if (!s.size) byUser.delete(e.uid); }
  };
  const cacheGet = (key) => {
    const e = cache.get(key);
    if (!e) return null;
    if (e.expires < Date.now()) { drop(key); return null; }
    cache.delete(key); cache.set(key, e); // most recently used now
    return e;
  };
  const cachePut = (uid, key, result) => {
    if (result.reason === 'busy') return;
    drop(key);
    const bytes = result.preview && result.preview.image ? result.preview.image.data.length : 0;
    const e = { uid, expires: Date.now() + (result.preview ? 10 : 2) * 60000, preview: result.preview, reason: result.reason, bytes };
    let s = byUser.get(uid);
    if (!s) { s = new Set(); byUser.set(uid, s); }
    while (s.size >= PER_USER) drop(s.values().next().value);
    cache.set(key, e); s.add(key); cacheBytes += bytes;
    while (cache.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) drop(cache.keys().next().value);
  };
  jobs.every('linkpreview.cache_sweep', 60000, () => { const t = Date.now(); for (const [k, e] of cache) if (e.expires < t) drop(k); });

  // ---- in flight: two per account, eight on the whole server; the same account asking twice shares one fetch
  const inflight = new Map(); // key -> { promise, ctl, waiters }
  const perUser = new Map(); // userId -> count
  let total = 0;

  api.post('/link-previews', auth, wrap(async (req, res) => {
    const started = Date.now();
    if (features().linkPreviews === false) fail(404, 'Link previews are turned off on this server.', 'off');
    rateLimit('lp:' + req.userId, 20, 60000);
    if (req.session) rateLimit('lps:' + req.session.id, 20, 60000);
    limitNet(req, 'lp', 60, 60000);
    const raw = (req.body || {}).url;
    const own = ownHosts(req);
    let checked;
    try { checked = checkPreviewUrl(raw, own); } catch (e) { if (e instanceof PreviewRefused) fail(400, e.message, e.code); throw e; }
    const key = `${req.userId}\n${checked.fetchUrl}`;
    const say = (result, cached) => {
      const p = result.preview;
      L.debug('preview', { outcome: p ? 'ok' : 'none', reason: result.reason, kind: p ? p.kind : undefined, cached: !!cached, ms: Date.now() - started, imageBytes: p && p.image ? p.image.bytes : 0 });
      res.json({ preview: p ? { url: raw, title: p.title, description: p.description, siteName: p.siteName, kind: p.kind, image: p.image || null } : null,
        ...(p ? {} : { reason: result.reason || 'none' }), ...(cached ? { cached: true } : {}) });
    };
    const hit = cacheGet(key);
    if (hit) return say(hit, true);

    let job = inflight.get(key);
    if (!job || job.ctl.signal.aborted) {
      if ((perUser.get(req.userId) || 0) >= 2 || total >= 8) fail(429, 'Still working on your last preview.', 'busy', 2);
      rateLimit('lpf:' + req.userId, 100, 3600000); // real fetches, cache hits aside
      // Many accounts asking about one site in a short time: answered "busy" rather than fetched (never cached).
      if (countHit('lphost:' + checked.u.hostname, 60000) > 60) return say({ preview: null, reason: 'busy' });
      const ctl = new AbortController();
      const uid = req.userId;
      perUser.set(uid, (perUser.get(uid) || 0) + 1); total++;
      const mine = { ctl, waiters: 0 };
      mine.promise = build(checked, own, ctl.signal).then((result) => { cachePut(uid, key, result); return result; }).finally(() => {
        if (inflight.get(key) === mine) inflight.delete(key);
        total--;
        const c = (perUser.get(uid) || 1) - 1;
        if (c > 0) perUser.set(uid, c); else perUser.delete(uid);
      });
      inflight.set(key, mine);
      job = mine;
    }
    job.waiters++;
    // The app went away (another link, a closed tab): stop the fetch once nobody is waiting for it.
    let gone = false;
    res.on('close', () => { if (!res.writableFinished && !gone) { gone = true; if (--job.waiters === 0) job.ctl.abort(); } });
    let result;
    try { result = await job.promise; } catch (e) {
      if (e && e.code === 'ABORTED') { if (!res.headersSent) res.end(); return; }
      throw e;
    }
    if (!gone) { gone = true; job.waiters--; }
    if (res.writableEnded || res.destroyed) return;
    say(result, false);
  }));
};

module.exports.checkPreviewUrl = checkPreviewUrl;
module.exports.decodeHtml = decodeHtml;
module.exports.parseHead = parseHead;
module.exports.chooseFields = chooseFields;
module.exports.decodeEntities = decodeEntities;
module.exports.cleanText = cleanText;
module.exports.sniffImage = sniffImage;
module.exports.youtubeId = youtubeId;
module.exports.xStatus = xStatus;
module.exports.xText = xText;
module.exports.pickImage = pickImage;
module.exports.looksLikeChallenge = looksLikeChallenge;
module.exports.parseInWorker = parseInWorker;
module.exports.parserThreads = () => parserThreads; // tests: page reader threads alive
