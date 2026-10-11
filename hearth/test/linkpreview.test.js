// Link previews built by the sender (server/linkpreview.js, docs/design/LINK-PREVIEWS.md): POST /api/link-previews
// fetches a page through netguard and answers with its title, description, site name and picture, which the
// sender's app then puts inside the encrypted message.
//
// Nothing here touches the internet. Sites are one local HTTPS stand-in (a throwaway certificate the Hearth under
// test trusts through NODE_EXTRA_CA_CERTS) that answers for many host names; the Hearth child resolves those names
// through a small --require preload (FAKE_DNS), as in outbound-hardening.test.js.
//   loose:  LINK_PREVIEW_ALLOW_PRIVATE lists the stand-in's names, so it can reach them on 127.0.0.1 and on a
//           random port. Any other private name (a redirect target, say) is still refused.
//   strict: the real rules: https on 443, public addresses only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { startServer, hex, sleep } = require('./helpers');
const LP = require('../server/linkpreview');

// ------------------------------------------------------------------ test pictures
function png(w, h, { claim } = {}) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 4) & 255; raw[o + 1] = (y * 5) & 255; raw[o + 2] = 200; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(claim ? claim[0] : w, 0); ihdr.writeUInt32BE(claim ? claim[1] : h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const jpeg = (w, h) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.from([0xff, 0xd9])]);
const gif = (w, h) => { const b = Buffer.alloc(32); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const webpX = (w, h) => { const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBPVP8X', 8, 'latin1'); b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const PIC = png(64, 48);

// ------------------------------------------------------------------ the stand-in site
const SITE_NAMES = ['og', 'img', 'fb', 'hostile', 'caps', 'cs', 'redir', 'big', 'kinds', 'pics', 'wall', 'lim', 'net', 'cache', 'busy', 'logs', 'misc'].map((n) => `${n}.preview-site.net`);
const OTHER_NAMES = ['github.com', 'opengraph.githubassets.com', 'www.youtube.com', 'i.ytimg.com', 'publish.twitter.com', 'x.com', 'consent.youtube.com'];
const ALLOWED = [...SITE_NAMES, ...OTHER_NAMES];
const hits = []; // `${host}${path}` of every request the stand-in got
const hitsOn = (prefix) => hits.filter((x) => x.startsWith(prefix)).length;
let port;
let cacheVersion = 0;
const page = (head, body = '<p>Body text</p>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const metaP = (o) => Object.entries(o).map(([k, v]) => `<meta property="${k}" content="${v}">`).join('\n');

function site(req, res) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  const u = new URL(req.url, 'https://x');
  hits.push(host + req.url);
  const html = (body, type = 'text/html; charset=utf-8', extra = {}) => { res.writeHead(200, { 'content-type': type, ...extra }); res.end(body); };
  const bytes = (buf, type) => { res.writeHead(200, { 'content-type': type, 'content-length': buf.length }); res.end(buf); };
  const go = (to, code = 302) => { res.writeHead(code, { location: to }); res.end(); };
  const p = u.pathname;
  // ---- YouTube and X stand-ins
  if (host === 'www.youtube.com' && p === '/oembed') {
    const v = new URL(u.searchParams.get('url')).searchParams.get('v');
    if (v === 'dQw4w9WgXcQ' || v === 'hqonlyvid01') return html(JSON.stringify({ title: v === 'hqonlyvid01' ? 'Old video' : 'Never Gonna &amp; <b>Give</b>', author_name: 'Rick', thumbnail_url: 'https://evil.preview-site.net/x.png' }), 'application/json');
    res.writeHead(404); return res.end();
  }
  if (host === 'i.ytimg.com') {
    if (p === '/vi/dQw4w9WgXcQ/mqdefault.jpg') return bytes(jpeg(320, 180), 'image/jpeg');
    if (p === '/vi/hqonlyvid01/hqdefault.jpg') return bytes(jpeg(480, 360), 'image/jpeg');
    res.writeHead(404); return res.end();
  }
  if (host === 'publish.twitter.com' && p === '/oembed') {
    if (/status\/123$/.test(u.searchParams.get('url'))) {
      return html(JSON.stringify({ author_name: 'Hearth', html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Hello &amp; welcome<br>to <a href="https://t.co/x">the post</a> <script>alert(1)</script></p>&mdash; Hearth (@hearth) <a href="https://twitter.com/hearth/status/123">Oct 1</a></blockquote>' }), 'application/json');
    }
    res.writeHead(404); return res.end();
  }
  if (host === 'github.com' && p === '/hearth/hearth') {
    return html(page(metaP({ 'og:title': 'hearth/hearth: Self-hosted chat', 'og:description': 'A small chat server.', 'og:site_name': 'GitHub', 'og:image': `https://opengraph.githubassets.com:${port}/abc/hearth/hearth` })));
  }
  if (host === 'opengraph.githubassets.com') return bytes(png(120, 60), 'image/png');
  if (host === 'consent.youtube.com') return html(page('<title>Before you continue to YouTube</title>'));
  // ---- generic pages
  if (p === '/og') {
    return html(page(`<meta charset="utf-8"><title>Plain title</title>
      ${metaP({ 'og:title': 'Hearth &amp; friends', 'og:description': 'Self-hosted chat, end-to-end encrypted.', 'og:site_name': 'Preview Site', 'og:image': `https://img.preview-site.net:${port}/pic.png` })}`));
  }
  if (p === '/pic.png') return bytes(PIC, 'image/png');
  if (p === '/fallback/twitter') {
    return html(page(`<title>Title tag</title><meta name="twitter:title" content="First twitter title"><meta name="twitter:title" content="Second twitter title">
      <meta name="description" content="The meta description"><meta name="twitter:image" content="/pic.png"><meta property="og:site_name" content="Fallbacks">`));
  }
  if (p === '/fallback/title') return html(page('<TITLE>Only a &lt;title&gt; tag</TITLE><META NAME=description CONTENT=Unquoted><link rel="icon image_src" href="/pic.png">'));
  if (p === '/hostile') {
    const many = Array.from({ length: 5000 }, (_, i) => `<meta name="x${i}" content="${i}">`).join('');
    return html(page(`<!-- <meta property="og:title" content="From a comment"> -->
      <script>document.write('<meta property="og:title" content="From a script">')</script>
      <style>/* <meta property="og:title" content="From a style"> */</style>
      <noscript><meta property="og:title" content="From noscript"></noscript>
      <template><meta property="og:title" content="From a template"></template>
      <textarea><meta property="og:title" content="From a textarea"></textarea>
      <meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;Safe &amp;lt;b&amp;gt; title<script>alert(2)</script>">
      <meta property="og:description" content='<iframe src="javascript:alert(3)"></iframe>Desc'>
      <meta property="og:url" content="javascript:alert(4)">
      <meta property="og:image:secure_url" content="javascript:alert(5)">
      <meta property="og:image" content="data:image/png;base64,${PIC.toString('base64')}">
      <meta property="twitter:image" content=" JaVaScRiPt:alert(6)">
      <meta name="broken" content="it's <unclosed">
      ${many}<meta property="og:site_name" content="After five thousand tags">`));
  }
  if (p === '/caps') {
    const fam = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    return html(page(metaP({
      'og:title': `${fam}${'T'.repeat(192)}\u{1F600}\u{1F600}xyz`,
      'og:description': `Bell\u0007 bidi‮evil‬ zero​width &#x202E;ent &#0;nul &#xD800;sur ${'d'.repeat(2000)}`,
      'og:site_name': `${'S'.repeat(500)}`,
    })));
  }
  if (p === '/cs/1252') { res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' }); return res.end(Buffer.concat([Buffer.from('<html><head><title>Caf', 'latin1'), Buffer.from([0xe9, 0x20, 0x93]), Buffer.from('quoted', 'latin1'), Buffer.from([0x94]), Buffer.from('</title></head></html>', 'latin1')])); }
  if (p === '/cs/sjis') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(Buffer.concat([Buffer.from('<html><head><meta charset="Shift_JIS"><title>', 'latin1'), Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), Buffer.from('</title></head></html>', 'latin1')])); }
  if (p === '/cs/utf16meta') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(Buffer.from('<html><head><meta charset="utf-16"><title>Ünïcode ✓</title></head></html>', 'utf8')); }
  if (p === '/cs/bom16') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<html><head><title>Wide ✓</title></head></html>', 'utf16le')])); }
  if (p === '/cs/badlabel') { res.writeHead(200, { 'content-type': 'text/html; charset=no-such-charset' }); return res.end(Buffer.from('<html><head><title>Fallback ✓</title></head></html>', 'utf8')); }
  // ---- redirects
  if (p === '/r/http') return go(`http://redir.preview-site.net:${port}/og`);
  if (p === '/r/private') return go(`https://sneaky.preview-site.net:${port}/og`); // 127.0.0.1, but not one of the allowed names
  if (p === '/r/ip') return go(`https://127.0.0.1:${port}/og`);
  if (p === '/r/reserved') return go(`https://box.internal:${port}/og`);
  if (p === '/r/own') return go(`https://chat.ourhearth.net:${port}/og`);
  if (p === '/r/js') return go('javascript:alert(1)');
  if (p.startsWith('/r/chain/')) { const n = +p.split('/').pop(); return n > 0 ? go(`/r/chain/${n - 1}`, 307) : html(page('<title>End of the chain</title>')); }
  // ---- size and time
  if (p === '/endless') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write(`<html><head><title>Endless</title><meta property="og:description" content="Never ends">`);
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const pump = () => { while (!res.destroyed && res.write(chunk)); };
    res.on('drain', pump); res.on('error', () => {}); pump(); return;
  }
  if (p === '/late') return html(page(`<title>Early title</title>${' '.repeat(700 * 1024)}<meta property="og:description" content="Too late to be read">`));
  if (p === '/bomb') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    return res.end(BOMB);
  }
  if (p === '/slow') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html><head>'); return; } // then nothing, ever
  if (p.startsWith('/hang/')) { setTimeout(() => html(page(`<title>Hang ${p}</title>`)), 900); return; }
  // ---- other kinds of answers
  if (p === '/doc.pdf') return bytes(Buffer.from('%PDF-1.4\n%fake'), 'application/pdf');
  if (p === '/data.json') return html('{"title":"not html"}', 'application/json');
  if (p === '/direct') return bytes(png(200, 100), 'image/png');
  if (p === '/svg') return html(page(`<title>SVG page</title><meta property="og:image" content="/pic.svg">`));
  if (p === '/pic.svg') return bytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script></svg>'), 'image/svg+xml');
  if (p === '/huge') return html(page(`<title>Huge claim</title><meta property="og:image" content="/huge.png">`));
  if (p === '/huge.png') return bytes(png(4, 4, { claim: [100000, 100000] }), 'image/png');
  if (p === '/fakepng') return html(page(`<title>Fake PNG</title><meta property="og:image" content="/fake.png">`));
  if (p === '/fake.png') return bytes(Buffer.from(page('<title>I am HTML</title>')), 'image/png');
  if (p === '/heavy') return html(page(`<title>Heavy picture</title><meta property="og:image" content="/heavy.png">`));
  if (p === '/heavy.png') return bytes(Buffer.concat([png(64, 48), Buffer.alloc(3 * 1024 * 1024)]), 'image/png');
  if (p === '/pixel') return html(page(`<title>Tracking pixel</title><meta property="og:image" content="/pixel.png">`));
  if (p === '/pixel.png') return bytes(png(1, 1), 'image/png');
  if (p === '/gif') return html(page(`<title>GIF</title><meta property="og:image" content="/a.gif">`));
  if (p === '/a.gif') return bytes(gif(100, 80), 'image/gif');
  if (p === '/webp') return html(page(`<title>WebP</title><meta property="og:image" content="/a.webp">`));
  if (p === '/a.webp') return bytes(webpX(300, 200), 'image/webp');
  if (p === '/httpimg') return html(page(`<title>http picture</title><meta property="og:image" content="http://img.preview-site.net:${port}/pic.png">`));
  if (p === '/video') return html(page(metaP({ 'og:title': 'A video', 'og:type': 'video.other' })));
  if (p === '/cf') return html(page('<title>Just a moment...</title>'));
  if (p === '/consent') return go(`https://consent.youtube.com:${port}/ml?continue=x`);
  if (p === '/empty') return html(page(''));
  if (p === '/missing') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(page('<title>Not found</title>')); }
  if (p === '/cache') { cacheVersion++; return html(page(`<title>Version ${cacheVersion}</title>`)); }
  return html(page(`<title>Page ${host}${p}</title>`));
}
const BOMB = zlib.gzipSync(Buffer.concat([Buffer.from('<html><head><title>Bomb</title>'), Buffer.alloc(32 * 1024 * 1024, 0x20)]));

// ------------------------------------------------------------------ servers
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-linkpreview-'));
const PRELOAD = path.join(work, 'fake-dns.js');
fs.writeFileSync(PRELOAD, `
const ng = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'netguard.js'))});
const map = JSON.parse(process.env.FAKE_DNS || '{}');
ng.setResolver(async (host) => {
  const entry = map[host.toLowerCase()];
  if (!entry) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return entry.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
});
`);
const FAKE_DNS = JSON.stringify({
  ...Object.fromEntries([...ALLOWED, 'sneaky.preview-site.net', 'chat.ourhearth.net', 'loop.preview-site.net'].map((n) => [n, ['127.0.0.1']])),
  'inside.preview-site.net': ['10.0.0.7'], 'meta.preview-site.net': ['::ffff:169.254.169.254'], 'mixed.preview-site.net': ['93.184.216.34', '192.168.1.10'],
  'router.preview-site.net': ['203.0.114.9'], 'nat64.preview-site.net': ['64:ff9b::7f00:1'],
});
let tlsServer; let strict; let loose;
const as = (s, u, method, p, body, token = u.token) => s.api(method, p, { token, ip: u.ip, body });
const preview = (s, u, url) => as(s, u, 'POST', '/link-previews', { url });
const L = (p, name = 'og') => `https://${name}.preview-site.net:${port}${p}`;

before(async () => {
  const selfsigned = require('selfsigned');
  const altNames = [...ALLOWED, 'sneaky.preview-site.net', 'chat.ourhearth.net', 'loop.preview-site.net'].map((value) => ({ type: 2, value })).concat([{ type: 7, ip: '127.0.0.1' }]);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'preview-site.net' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }] });
  fs.writeFileSync(path.join(work, 'ca.pem'), pems.cert);
  tlsServer = https.createServer({ key: pems.private, cert: pems.cert }, site);
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  port = tlsServer.address().port;
  const common = { NODE_OPTIONS: `--require ${PRELOAD}`, FAKE_DNS, NODE_EXTRA_CA_CERTS: path.join(work, 'ca.pem'), OUTBOUND_BLOCK: '203.0.114.0/24', NO_PROXY: '*', no_proxy: '*' };
  loose = await startServer({
    ...common, LINK_PREVIEW_ALLOW_PRIVATE: ALLOWED.join(','), PUBLIC_HOSTS: 'chat.ourhearth.net', LINK_PREVIEW_TIMEOUT_MS: '3000',
    LINK_PREVIEW_YOUTUBE_OEMBED: `https://www.youtube.com:${port}/oembed`, LINK_PREVIEW_YTIMG_BASE: `https://i.ytimg.com:${port}`, LINK_PREVIEW_X_OEMBED: `https://publish.twitter.com:${port}/oembed`,
    LOG_FORMAT: 'json', LOG_LEVEL: 'debug', LOG_ACCESS_SAMPLE: '1',
  });
  strict = await startServer(common);
});
after(async () => {
  await loose.stop(); await strict.stop();
  try { tlsServer.closeAllConnections(); } catch { /* older Node */ }
  await new Promise((r) => tlsServer.close(() => r()));
  fs.rmSync(work, { recursive: true, force: true });
});

// ================================================================== reading pages
test('link previews: OpenGraph tags come back as title, description, site name and image', async () => {
  const u = await loose.register();
  const url = `${L('/og')}#section-2`;
  const r = await preview(loose, u, url);
  assert.equal(r.status, 200, r.text);
  const p = r.json.preview;
  assert.equal(p.url, url, 'the link is echoed exactly as sent');
  assert.equal(p.title, 'Hearth & friends');
  assert.equal(p.description, 'Self-hosted chat, end-to-end encrypted.');
  assert.equal(p.siteName, 'Preview Site');
  assert.equal(p.kind, 'web');
  assert.equal(p.image.type, 'image/png');
  assert.deepEqual([p.image.width, p.image.height], [64, 48], 'the size is read from the picture’s bytes');
  assert.ok(Buffer.from(p.image.data, 'base64').equals(PIC), 'the picture comes through byte for byte');
  assert.ok(hits.includes('og.preview-site.net/og'), 'the part after # is never sent to the site');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('link previews: Twitter card tags, <title> and meta description fill in when OpenGraph is missing; the first tag wins', async () => {
  const u = await loose.register();
  let p = (await preview(loose, u, L('/fallback/twitter', 'fb'))).json.preview;
  assert.equal(p.title, 'First twitter title');
  assert.equal(p.description, 'The meta description');
  assert.equal(p.siteName, 'Fallbacks');
  assert.equal(p.image.type, 'image/png', 'twitter:image, relative to the page');
  p = (await preview(loose, u, L('/fallback/title', 'fb'))).json.preview;
  assert.equal(p.title, 'Only a <title> tag', 'a <title> written in capitals, with entities: decoded once, and what the page escaped stays as text');
  assert.equal(p.description, 'Unquoted');
  assert.ok(p.image, '<link rel="image_src"> is the last resort for a picture');
});

test('link previews: hostile HTML is parsed, never run: comments, scripts, raw-text elements, entity tricks and javascript: links never reach the fields', async () => {
  const u = await loose.register();
  const r = await preview(loose, u, L('/hostile', 'hostile'));
  assert.equal(r.status, 200, r.text);
  const p = r.json.preview;
  // Markup written as markup in the value is dropped; what the page escaped is decoded once and stays text (the
  // app draws it as text: test/e2e "link previews").
  assert.equal(p.title, '<img src=x onerror=alert(1)>Safe &lt;b&gt; title alert(2)', 'the first real og:title: raw tags dropped, then entities decoded once');
  assert.ok(!/From a (comment|script|style|noscript|template|textarea)/.test(JSON.stringify(p)), 'tags inside comments and raw-text elements are not tags');
  assert.ok(!/<(script|iframe)/i.test(JSON.stringify(p)), 'markup the page wrote as markup is gone');
  assert.equal(p.description, 'Desc');
  assert.equal(p.image, null, 'javascript: and data: picture links are skipped, not fetched');
  assert.ok(!JSON.stringify(r.json).toLowerCase().includes('javascript'), 'og:url is never used');
  assert.equal(p.siteName, '', 'reading stops after 4,000 tags');
  // The tokenizer stays fast on pathological input (all within the parse time limit, in the worker). The short
  // quote patterns used to make every tag re-read the 8 KiB after it (seconds for 512 KiB).
  const MAX_PAGE = 512 * 1024;
  const fill = (unit) => `<head>${unit.repeat(Math.ceil(MAX_PAGE / unit.length))}`.slice(0, MAX_PAGE);
  for (const evil of [fill('<a x="'), fill('<!--'), fill('<meta content='), `<head><title>${'<'.repeat(500000)}`, fill('\'<a\'='), fill('<a"="'), fill('<a\'"="'), fill('="<a"'), fill('<<a "='), fill('<!-->')]) {
    const t = Date.now();
    LP.parseHead(LP.decodeHtml(Buffer.from(evil), 'text/html'));
    assert.ok(Date.now() - t < 1000, `parsed ${JSON.stringify(evil.slice(6, 26))}… in ${Date.now() - t} ms`);
  }
});

test('link previews: text reads as the page shows it: named entities (Latin-1, Greek, typography), escaped angle brackets kept, empty comments', () => {
  const f = (head) => LP.chooseFields(LP.parseHead(head));
  assert.equal(f('<head><title>Caf&eacute; M&uuml;nchen &ndash; &euro;5</title></head>').title, 'Café München – €5');
  assert.equal(f('<head><title>&Eacute;t&eacute; &szlig; &ccedil;a &auml;&ouml; &AElig; &Omega;&pi; &frac12; &trade; &rarr;</title></head>').title, 'Été ß ça äö Æ Ωπ ½ ™ →', 'names are case-sensitive');
  assert.equal(f('<head><meta name="description" content="How do I sort a List&lt;string&gt; in C#? Use Map&lt;K, V&gt; &amp; more"></head>').description,
    'How do I sort a List<string> in C#? Use Map<K, V> & more', 'escaped angle brackets are words, not tags');
  assert.equal(f('<head><title>a < b > c, I <3 it</title></head>').title, 'a < b > c, I <3 it', 'only tag-shaped markup is dropped');
  assert.equal(LP.cleanText('&constructor; &__proto__; &toString; &AMP; &Amp;', 100), '&constructor; &__proto__; &toString; & &Amp;', 'unknown names stay as written');
  assert.equal(LP.cleanText('<b>Bold</b> &lt;b&gt;escaped&lt;/b&gt;', 100), 'Bold <b>escaped</b>', 'markup goes before entities are decoded');
  for (const c of ['<!-->', '<!--->']) {
    assert.deepEqual(LP.parseHead(`<head>${c}<meta property="og:title" content="After an empty comment"></head>`).meta, { 'og:title': 'After an empty comment' }, c);
  }
  assert.deepEqual(LP.parseHead('<head><!-- <meta property="og:title" content="Hidden"> --><meta property="og:title" content="Shown"></head>').meta, { 'og:title': 'Shown' });
  // A broken tag is given up on from where its reading stopped: the tag after it is still read.
  assert.equal(LP.parseHead('<head><meta content="x" <meta property="og:title" content="After a broken tag"></head>').meta['og:title'], 'After a broken tag');
  assert.equal(LP.parseHead(`<head><meta content="${'x'.repeat(9000)}"><meta property="og:title" content="After a long value"></head>`).meta['og:title'], 'After a long value');
});

test('link previews: a page that takes too long to read is given up on alone: parses queued behind it or sent just after still work, and one reader thread is left', async () => {
  const slow = Buffer.from(`<head>${'<meta content="x">'.repeat(30000)}`); // about 500 KiB: never read within 1 ms
  const small = Buffer.from('<head><title>Small page</title></head>');
  assert.equal((await LP.parseInWorker(small, 'text/html')).title, 'Small page');
  let timeouts = 0;
  for (let round = 0; round < 5; round++) {
    const slowOne = LP.parseInWorker(slow, 'text/html', 1);
    const behind = LP.parseInWorker(small, 'text/html'); // queued on the same worker
    let after = null;
    try { await slowOne; } catch (e) {
      assert.equal(e.code, 'PARSE_TIMEOUT');
      timeouts++;
      // Sent at once: a new worker, while the old one is still stopping (its "exit" comes later).
      after = LP.parseInWorker(small, 'text/html');
    }
    assert.equal((await behind).title, 'Small page', `round ${round}: the job behind the slow page`);
    if (after) assert.equal((await after).title, 'Small page', `round ${round}: the job sent just after`);
  }
  assert.ok(timeouts >= 3, `the slow page timed out ${timeouts} times of 5`);
  for (let i = 0; i < 100 && LP.parserThreads() > 1; i++) await sleep(20);
  assert.equal(LP.parserThreads(), 1, 'stopped workers are gone, and no worker is left running unseen');
  assert.equal((await LP.parseInWorker(small, 'text/html')).title, 'Small page');
  assert.equal(LP.parserThreads(), 1);
});

test('link previews: fields are capped (200/300/60 code points) and control, bidi and zero-width characters are removed (ZWJ kept)', async () => {
  const u = await loose.register();
  const p = (await preview(loose, u, L('/caps', 'caps'))).json.preview;
  const fam = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  assert.equal([...p.title].length, 200, 'title capped at 200 code points, the ellipsis included');
  assert.equal(p.title, `${fam}${'T'.repeat(192)}\u{1F600}\u{1F600}…`, 'cut between characters, never inside one; the zero-width joiners inside the emoji survive');
  assert.ok([...p.description].length <= 300);
  assert.match(p.description, /^Bell bidievil zerowidth ent nul sur d+…$/, 'control, bidi and zero-width characters gone; bad numeric entities dropped');
  assert.equal([...p.siteName].length, 60);
  // The same rules in-process.
  assert.equal(LP.cleanText('a‮b⁦c​d﻿e\u0000f  g\n\th', 100), 'abcdef g h');
  assert.equal(LP.cleanText('&amp;lt;script&amp;gt;', 100), '&lt;script&gt;', 'entities are decoded only once');
  assert.equal(LP.cleanText('&#x1F600;&#128512;&#xDFFF;&#x110000;', 100), '\u{1F600}\u{1F600}');
});

test('link previews: charset from the BOM, Content-Type and <meta charset> (windows-1252, Shift_JIS); a UTF-16 <meta> is read as UTF-8', async () => {
  const u = await loose.register();
  const t = async (p) => (await preview(loose, u, L(p, 'cs'))).json.preview.title;
  assert.equal(await t('/cs/1252'), 'Café “quoted”');
  assert.equal(await t('/cs/sjis'), '日本語');
  assert.equal(await t('/cs/utf16meta'), 'Ünïcode ✓');
  assert.equal(await t('/cs/bom16'), 'Wide ✓');
  assert.equal(await t('/cs/badlabel'), 'Fallback ✓', 'a label nobody knows falls back to UTF-8');
  assert.equal(LP.decodeHtml(Buffer.from([0xef, 0xbb, 0xbf, 0x41]), 'text/html; charset=iso-8859-1'), 'A', 'a byte order mark beats the header');
  assert.equal(LP.decodeHtml(Buffer.from([0x80, 0x20, 0x96, 0xe9]), 'text/html; charset=latin1'), '€ –é', '"latin1" means windows-1252, as in browsers');
});

// ================================================================== what may be fetched
test('link previews: only https on port 443 with a real host name; IP literals, credentials, reserved names and this server’s own host get 400', async () => {
  const u = await strict.register();
  const refused = ['http://news.preview-site.net/a', 'https://93.184.216.34/', 'https://[2606:4700::1]/', 'https://2130706433/', 'https://0x7f.1/', 'https://user:pw@news.preview-site.net/',
    'https://news.preview-site.net:8443/', 'https://localhost/', 'https://printer.local/', 'https://nas.lan/', 'https://box.internal/', 'https://chat.example.test/', 'https://example.com/',
    'https://www.example.org/x', 'https://hidden.onion/', 'https://router.home.arpa/', 'https://intranet/', 'https://news.preview-site.net./', 'https://a..b/', 'javascript:alert(1)',
    'file:///etc/passwd', 'ftp://news.preview-site.net/', 'data:text/html,hi', 'https://news.preview-site.net/a b', 'https://news.preview-site.net/\u0000', `https://news.preview-site.net/${'a'.repeat(2050)}`, ''];
  const others = [await strict.register(), await strict.register()]; // refused calls count toward the limit too
  for (const [i, url] of refused.entries()) {
    const r = await preview(strict, i < 15 ? u : others[0], url);
    assert.equal(r.status, 400, `${url.slice(0, 60)} → ${r.status} ${r.text}`);
    assert.equal(r.json.code, 'bad_url', url.slice(0, 60));
  }
  for (const body of [{}, { url: 42 }, { url: ['https://news.preview-site.net/'] }, { url: { href: 'x' } }]) assert.equal((await as(strict, others[1], 'POST', '/link-previews', body)).status, 400, JSON.stringify(body));
  // This server's own names (PUBLIC_URL, the mail settings' address, PUBLIC_HOSTS): never fetched.
  const v = await loose.register();
  const own = await preview(loose, v, 'https://chat.ourhearth.net/invite/abc');
  assert.equal(own.status, 400);
  assert.equal(own.json.code, 'own_server');
  assert.equal(hitsOn('chat.ourhearth.net'), 0);
});

test('link previews: private, rebinding and disguised addresses are refused before any connection', async () => {
  const u = await strict.register();
  for (const name of ['inside', 'meta', 'mixed', 'router', 'nat64', 'loop', 'og']) {
    const r = await preview(strict, u, `https://${name}.preview-site.net/og`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.preview, null, name);
    // "blocked" is netguard's refusal; a refused connection would have said "unreachable".
    assert.equal(r.json.reason, 'blocked', `${name}.preview-site.net → ${r.json.reason}`);
  }
  assert.equal(hitsOn('inside.') + hitsOn('loop.'), 0);
  // In the loose server only the listed names may be private: anything else on 127.0.0.1 is still refused.
  const v = await loose.register();
  const before = hits.length;
  const r = await preview(loose, v, `https://sneaky.preview-site.net:${port}/og`);
  assert.equal(r.json.reason, 'blocked');
  assert.equal(hits.length, before, 'no request reached the stand-in');
});

test('link previews: every redirect is checked again; https→http, private, IP-literal, reserved, own-server and 5-hop redirects give no preview', async () => {
  const u = await loose.register();
  for (const p of ['/r/http', '/r/private', '/r/ip', '/r/reserved', '/r/own', '/r/js', '/r/chain/5']) {
    const r = await preview(loose, u, L(p, 'redir'));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.preview, null, p);
    assert.equal(r.json.reason, 'blocked', `${p} → ${r.json.reason}`);
  }
  assert.equal(hitsOn('sneaky.') + hitsOn('chat.ourhearth.net') + hitsOn('redir.preview-site.net/og'), 0, 'nothing behind a refused redirect was requested');
  const ok = await preview(loose, u, L('/r/chain/4', 'redir'));
  assert.equal(ok.json.preview.title, 'End of the chain', 'four redirects are fine');
});

test('link previews: an endless page, a gzip bomb and a slow site end within the deadline; only the head of a big page is read', async () => {
  const u = await loose.register();
  let t = Date.now();
  let r = await preview(loose, u, L('/endless', 'big'));
  assert.equal(r.json.preview.title, 'Endless');
  assert.equal(r.json.preview.description, 'Never ends');
  assert.ok(Date.now() - t < 3000, `endless page took ${Date.now() - t} ms`);
  t = Date.now();
  r = await preview(loose, u, L('/bomb', 'big'));
  assert.equal(r.json.preview.title, 'Bomb', 'a 32 MB page packed into a small gzip is read up to the cap');
  assert.ok(Date.now() - t < 3000, `gzip bomb took ${Date.now() - t} ms`);
  r = await preview(loose, u, L('/late', 'big'));
  assert.equal(r.json.preview.title, 'Early title');
  assert.equal(r.json.preview.description, '', 'tags past 512 KiB are never read');
  t = Date.now();
  r = await preview(loose, u, L('/slow', 'big'));
  assert.equal(r.json.preview, null);
  assert.equal(r.json.reason, 'timeout');
  assert.ok(Date.now() - t < 4500, `a site that never answers is given up on (${Date.now() - t} ms, budget 3000)`);
});

test('link previews: PDF and JSON give no preview; a direct image answer gives an image-only preview; other answers say why', async () => {
  const u = await loose.register();
  const reason = async (p) => (await preview(loose, u, L(p, 'kinds'))).json;
  assert.equal((await reason('/doc.pdf')).reason, 'not_html');
  assert.equal((await reason('/data.json')).reason, 'not_html');
  const img = (await reason('/direct')).preview;
  assert.equal(img.kind, 'image');
  assert.equal(img.title, '');
  assert.deepEqual([img.image.width, img.image.height], [200, 100]);
  assert.equal((await reason('/missing')).reason, 'unreachable', 'a 404 page is not previewed');
  assert.equal((await reason('/empty')).reason, 'none', 'a page with nothing to show');
  assert.equal((await reason('/video')).preview.kind, 'video', 'og:type video.*');
  const nowhere = await preview(loose, u, `https://nowhere.preview-site.net:${port}/`);
  assert.equal(nowhere.json.reason, 'unreachable', 'a name with no address');
});

test('link previews: preview images must really be JPEG/PNG/GIF/WebP of sane size; SVG, a PNG claiming 100000×100000, HTML served as image/png, a 3 MB image and a 1×1 pixel are dropped, the card is kept', async () => {
  const u = await loose.register();
  for (const p of ['/svg', '/huge', '/fakepng', '/heavy', '/pixel']) {
    const r = (await preview(loose, u, L(p, 'pics'))).json.preview;
    assert.ok(r && r.title, `${p}: the card stays`);
    assert.equal(r.image, null, `${p}: no picture`);
  }
  const g = (await preview(loose, u, L('/gif', 'pics'))).json.preview.image;
  assert.deepEqual([g.type, g.width, g.height], ['image/gif', 100, 80]);
  const w = (await preview(loose, u, L('/webp', 'pics'))).json.preview.image;
  assert.deepEqual([w.type, w.width, w.height], ['image/webp', 300, 200]);
  const h = (await preview(loose, u, L('/httpimg', 'pics'))).json.preview.image;
  assert.equal(h && h.type, 'image/png', 'an http picture link is fetched over https');
  // The sniffer in-process: types come from the bytes, never from what the file claims to be.
  assert.deepEqual(LP.sniffImage(jpeg(640, 360)), { type: 'image/jpeg', width: 640, height: 360 });
  assert.deepEqual(LP.sniffImage(png(10, 20)), { type: 'image/png', width: 10, height: 20 });
  assert.equal(LP.sniffImage(Buffer.from('<svg></svg>')), null);
  assert.equal(LP.sniffImage(Buffer.from([0xff, 0xd8, 0xff])), null, 'a cut-off JPEG');
  assert.equal(LP.sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100000, 0xff)])), null, 'a JPEG of fill bytes ends without a size');
});

test('link previews: Cloudflare-style challenge and consent pages give reason "challenge"', async () => {
  const u = await loose.register();
  assert.equal((await preview(loose, u, L('/cf', 'wall'))).json.reason, 'challenge');
  assert.equal((await preview(loose, u, L('/consent', 'wall'))).json.reason, 'challenge');
  for (const t of ['Just a moment...', 'Attention Required! | Cloudflare', 'Access denied', 'Before you continue to Google']) assert.ok(LP.looksLikeChallenge(t), t);
  assert.ok(!LP.looksLikeChallenge('Access to justice'));
});

// ================================================================== limits and the cache
test('link previews: limits per account, per network and per target host; two in flight per account', async () => {
  // Per account: 20 a minute, cache hits included.
  const u = await loose.register();
  for (let i = 0; i < 20; i++) assert.equal((await preview(loose, u, L('/limit-me', 'lim'))).status, 200);
  const over = await preview(loose, u, L('/limit-me', 'lim'));
  assert.equal(over.status, 429);
  assert.equal(over.json.code, 'rate_limited');
  assert.ok(+over.headers.get('retry-after') > 0);
  assert.equal(hitsOn('lim.preview-site.net/limit-me'), 1, 'one fetch, the rest from this account’s cache');

  // Two at once per account: a third waits its turn.
  const v = await loose.register();
  const three = await Promise.all([1, 2, 3].map((i) => preview(loose, v, L(`/hang/${i}`, 'lim'))));
  const busy = three.filter((r) => r.status === 429);
  assert.equal(busy.length, 1, three.map((r) => r.status).join(','));
  assert.equal(busy[0].json.code, 'busy');
  assert.equal(busy[0].headers.get('retry-after'), '2');
  assert.equal(three.filter((r) => r.status === 200 && r.json.preview).length, 2);

  // Per network: 60 a minute however many accounts ask from it.
  const ip = `198.18.250.${Math.floor(Math.random() * 200) + 1}`;
  const people = [];
  for (let i = 0; i < 4; i++) people.push(await loose.register());
  const fromNet = (p) => loose.api('POST', '/link-previews', { token: p.token, ip, body: { url: L('/same', 'net') } });
  let n = 0;
  for (const p of people.slice(0, 3)) for (let i = 0; i < 20; i++) { assert.equal((await fromNet(p)).status, 200); n++; }
  const net = await fromNet(people[3]);
  assert.equal(net.status, 429, `call ${n + 1} from one network`);
  assert.equal(net.json.code, 'rate_limited');

  // Per target host: past 60 fetches a minute from everyone together, the answer is "busy" (no request made).
  const askers = [];
  for (let i = 0; i < 4; i++) askers.push(await loose.register());
  const answers = [];
  for (const a of askers) for (let i = 0; i < 16; i++) answers.push((await preview(loose, a, L(`/n/${a.id}/${i}`, 'busy'))).json);
  assert.equal(answers.filter((x) => x.preview).length, 60);
  assert.ok(answers.slice(60).every((x) => x.reason === 'busy'), JSON.stringify(answers.slice(60)));
  assert.equal(hitsOn('busy.preview-site.net'), 60);
});

test('link previews: the cache is per account: another account asking for the same URL triggers its own fetch and gets fresh content', async () => {
  const a = await loose.register();
  const b = await loose.register();
  const url = L('/cache', 'cache');
  const first = await preview(loose, a, url);
  const again = await preview(loose, a, `${url}#other-fragment`);
  assert.equal(again.json.cached, true);
  assert.equal(again.json.preview.title, first.json.preview.title, 'the same account gets its own copy back');
  assert.equal(again.json.preview.url, `${url}#other-fragment`, 'with its own link echoed');
  assert.equal(hitsOn('cache.preview-site.net'), 1);
  const other = await preview(loose, b, url);
  assert.equal(other.json.cached, undefined, 'never served from another account’s cache');
  assert.notEqual(other.json.preview.title, first.json.preview.title, 'a fresh fetch, so fresh content');
  assert.equal(hitsOn('cache.preview-site.net'), 2);
});

// ================================================================== special sites
test('link previews: YouTube links use oEmbed and the video thumbnail; the watch page is never fetched', async () => {
  const u = await loose.register();
  const r = await preview(loose, u, `https://www.youtube.com:${port}/watch?v=dQw4w9WgXcQ&t=42`);
  const p = r.json.preview;
  assert.equal(p.title, 'Never Gonna & Give');
  assert.equal(p.description, 'Rick');
  assert.equal(p.siteName, 'YouTube');
  assert.equal(p.kind, 'video');
  assert.deepEqual([p.image.type, p.image.width, p.image.height], ['image/jpeg', 320, 180]);
  const old = (await preview(loose, u, `https://youtu.be:${port}/hqonlyvid01`)).json.preview;
  assert.deepEqual([old.title, old.image.width], ['Old video', 480], 'falls back to hqdefault.jpg');
  const gone = await preview(loose, u, `https://www.youtube.com:${port}/shorts/removedvid1`);
  assert.equal(gone.json.reason, 'none', 'a removed or private video');
  assert.equal(hits.filter((x) => x.startsWith('www.youtube.com/') && !x.startsWith('www.youtube.com/oembed')).length, 0, 'the watch page itself is never fetched');
  assert.equal(hitsOn('evil.preview-site.net'), 0, 'the oEmbed answer’s thumbnail_url is not trusted');
});

test('link previews: youtubeId follows the watch-together rules on every YouTube link form', () => {
  const id = (s) => LP.youtubeId(new URL(s));
  const table = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'], ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=1', 'dQw4w9WgXcQ'], ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'], ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'], ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?si=x', 'dQw4w9WgXcQ'], ['https://www.youtube.com/v/dQw4w9WgXcQ', 'dQw4w9WgXcQ'], ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=5', 'dQw4w9WgXcQ'], ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/@channel', ''], ['https://www.youtube.com/watch?v=short', ''], ['https://youtu.be/', ''], ['https://www.youtube.com/watch?v=dQw4w9WgXc!', ''],
    ['https://notyoutube.com/watch?v=dQw4w9WgXcQ', null], ['https://youtube.com.evil.net/watch?v=dQw4w9WgXcQ', null],
  ];
  for (const [url, want] of table) assert.equal(id(url), want, url);
  // Watch together uses the same function, so the two can't drift apart.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('function parseWatchUrl('), src.indexOf('async function watchTitle('));
  assert.match(fn, /const id = youtubeId\(u\)/);
});

test('link previews: X status links use oEmbed text, never fetch x.com, and give none when oEmbed fails', async () => {
  const u = await loose.register();
  const p = (await preview(loose, u, `https://x.com:${port}/hearth/status/123?s=20`)).json.preview;
  assert.equal(p.title, 'Hearth (@hearth)');
  assert.equal(p.description, 'Hello & welcome to the post alert(1)', 'the oEmbed HTML is read as text, never rendered');
  assert.deepEqual([p.siteName, p.kind, p.image], ['X', 'post', null]);
  assert.equal((await preview(loose, u, `https://x.com:${port}/hearth/status/999`)).json.reason, 'none');
  assert.equal((await preview(loose, u, `https://x.com:${port}/hearth`)).json.reason, 'none', 'profiles and other X pages');
  assert.equal(hitsOn('x.com'), 0, 'x.com itself is never fetched');
  assert.deepEqual(LP.xStatus(new URL('https://mobile.twitter.com/a_b/status/1/photo/1')), { handle: 'a_b', id: '1' });
  assert.equal(LP.xStatus(new URL('https://x.com/i/flow/login')), null);
});

test('link previews: GitHub links go through OpenGraph with kind "repo"', async () => {
  const u = await loose.register();
  const p = (await preview(loose, u, `https://github.com:${port}/hearth/hearth`)).json.preview;
  assert.deepEqual([p.title, p.siteName, p.kind], ['hearth/hearth: Self-hosted chat', 'GitHub', 'repo']);
  assert.equal(p.image.width, 120);
});

// ================================================================== switches, logs and who may ask
test('link previews: the owner switch turns the route off (404), is audit-logged and reaches /api/config', async () => {
  const u = await strict.register();
  const owner = strict.owner;
  assert.equal((await strict.api('GET', '/config')).json.features.linkPreviews, true, 'on by default');
  const r = await as(strict, owner, 'PUT', '/admin/owner', { features: { linkPreviews: false } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await strict.api('GET', '/config')).json.features.linkPreviews, false);
  const off = await preview(strict, u, 'https://news.preview-site.net/a');
  assert.equal(off.status, 404);
  assert.equal(off.json.code, 'off');
  const row = strict.sql("SELECT * FROM admin_log WHERE action = 'owner_settings' ORDER BY id DESC LIMIT 1")[0];
  assert.equal(row.admin_id, owner.id);
  assert.match(row.detail, /features/);
  // A member can't flip it.
  assert.equal((await as(strict, u, 'PUT', '/admin/owner', { features: { linkPreviews: true } })).status, 403);
  assert.equal((await as(strict, owner, 'PUT', '/admin/owner', { features: { linkPreviews: true } })).status, 200);
  assert.equal((await preview(strict, u, 'https://news.preview-site.net/a')).status, 200);
  assert.equal((await strict.api('GET', '/config')).json.linkPreviewAnyPort, undefined, 'the test-only port switch is off on a normal server');
  assert.equal((await loose.api('GET', '/config')).json.linkPreviewAnyPort, true);
});

test('link previews: signed-out, revoked and suspended sessions are refused', async () => {
  assert.equal((await strict.api('POST', '/link-previews', { body: { url: 'https://news.preview-site.net/' } })).status, 401);
  assert.equal((await strict.api('POST', '/link-previews', { token: 'nope', body: { url: 'https://news.preview-site.net/' } })).status, 401);
  const u = await strict.register();
  assert.equal((await preview(strict, u, 'https://news.preview-site.net/')).status, 200);
  assert.equal((await as(strict, strict.owner, 'POST', `/admin/users/${u.id}/suspend`, { hours: 1, reason: 'test' })).status, 200);
  assert.equal((await preview(strict, u, 'https://news.preview-site.net/')).status, 401, 'suspending signs every session out');
  const again = await strict.login(u);
  assert.equal(again.status, 403, 'and signing in again is refused while suspended');
  // Bots use their own API (a separate router): their tokens don't open this route.
  assert.equal((await strict.api('POST', '/link-previews', { headers: { authorization: `Bot ${hex(20)}` }, body: { url: 'https://news.preview-site.net/' } })).status, 401);
});

test('link previews: the requested URL, host and title never appear in the server log', async () => {
  const u = await loose.register();
  const secret = `/very-private-path-${hex(6)}?token=${hex(8)}`;
  const r = await preview(loose, u, L(secret, 'logs'));
  assert.equal(r.json.preview.title.startsWith('Page logs.preview-site.net'), true);
  await preview(loose, u, `https://inside-${hex(3)}.preview-site.net/x`); // a failure too
  await sleep(200);
  const log = loose.log;
  assert.match(log, /"component":"linkpreview","op":"preview"/, 'each preview is logged (without the link)');
  assert.match(log, /"route":"\/api\/link-previews"/, 'the access log names the route only');
  for (const needle of ['preview-site.net', 'very-private-path', 'token=', 'Hearth & friends', 'Never Gonna', 'youtube.com', 'x.com:', 'ourhearth']) {
    assert.ok(!log.includes(needle), `the log mentions ${needle}`);
  }
});
