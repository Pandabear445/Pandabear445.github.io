// What reaches other sites (xss-7, xss-8). The app's fonts come from Hearth itself (no Google Fonts), the page's
// security policy names no font host and no blob: frames, an image link in a message to another site waits for a
// click unless the person chose otherwise (a synced Privacy & safety setting), and a watch-together video file
// from another site says so before it loads. The browser side of the click-to-load is in test/e2e (flows.mjs ›
// outside images); the client module's rules run here as they are.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
let srv; let O;
before(async () => {
  srv = await startServer();
  O = await import(pathToFileURL(path.join(PUBLIC, 'js', 'outside.js')).href);
});
after(async () => { await srv.stop(); });

const FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/i;
const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((p) => p[0]).map(([k, ...v]) => [k, v]));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
// The fonts people can pick for their name and profile page, as the server checks them (server/profile.js, page.js).
const listed = (file) => [...(/const FONTS = \[([\s\S]*?)\];/.exec(fs.readFileSync(path.join(ROOT, 'server', file), 'utf8'))[1].matchAll(/'([^']+)'/g))].map((m) => m[1]);
const GENERIC = new Set(['default', 'system', 'serif', 'mono', 'comic']);

// ------------------------------------------------------------------ fonts (xss-8)
test('xss-8: the pages load no fonts from Google: GET / and the other pages point at /fonts/fonts.css', async () => {
  for (const p of ['/', '/download', '/terms']) {
    const r = await srv.call('GET', p);
    assert.equal(r.status, 200, p);
    assert.ok(!FONT_HOSTS.test(r.text), `${p} still points at Google Fonts`);
    assert.ok(!/rel="preconnect"/.test(r.text), `${p} still opens a connection to another site`);
  }
  for (const p of ['/', '/download']) assert.match((await srv.call('GET', p)).text, /<link rel="stylesheet" href="\/fonts\/fonts\.css">/, p);
  // Nothing the app serves (pages, styles, scripts) names a font host, so no @import or script can bring it back.
  const files = walk(PUBLIC).filter((f) => /\.(html|css|js)$/.test(f));
  const offenders = files.filter((f) => FONT_HOSTS.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, []);
});

test('xss-8: every font the app uses is served from /fonts (woff2, latin and latin-ext, cached a week) with its licence', async () => {
  const css = await srv.call('GET', '/fonts/fonts.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  const faces = [...css.text.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]);
  const families = new Set(faces.map((f) => /font-family:'([^']+)'/.exec(f)[1]));
  // The interface fonts (app.css --font and --font-display) and every name/profile-page font the server accepts.
  const wanted = new Set(['Figtree', 'Bricolage Grotesque', ...listed('profile.js'), ...listed('page.js')].filter((f) => !GENERIC.has(f)));
  assert.ok(wanted.size >= 13, `found ${wanted.size} fonts`);
  for (const f of wanted) assert.ok(families.has(f), `${f} has no @font-face`);
  for (const f of faces) {
    assert.match(f, /font-display:swap/);
    assert.match(f, /unicode-range:U\+/, 'each file covers one subset, so a page only downloads what it shows');
    assert.match(f, /src:url\([\w.-]+\.woff2\) format\('woff2'\)/, 'files are local (relative), never another site');
  }
  // The variable Bricolage Grotesque (optical size + weight), as the old Google Fonts request asked for.
  assert.ok(faces.some((f) => /Bricolage Grotesque/.test(f) && /opsz/.test(f)));
  const urls = [...new Set(faces.map((f) => /url\(([^)]+)\)/.exec(f)[1]))];
  let total = 0;
  for (const u of urls) {
    assert.match(u, /-(latin|latin-ext)-/, `${u}: only the latin subsets are shipped`);
    const r = await fetch(`${srv.base}/fonts/${u}`);
    assert.equal(r.status, 200, u);
    assert.equal(r.headers.get('content-type'), 'font/woff2', u);
    assert.match(r.headers.get('cache-control') || '', /max-age=604800/, u);
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b.toString('latin1', 0, 4), 'wOF2', `${u} is a real woff2 file`);
    total += b.length;
  }
  assert.ok(total < 800 * 1024, `the fonts add up to ${Math.round(total / 1024)} KB`);
  // Only the files fonts.css uses are shipped (no unused weights or subsets).
  const shipped = fs.readdirSync(path.join(PUBLIC, 'fonts')).filter((f) => f.endsWith('.woff2'));
  assert.deepEqual(shipped.sort(), [...urls].sort());
  // Each font's SIL Open Font License travels with it.
  for (const f of wanted) {
    const lic = path.join(PUBLIC, 'fonts', 'licenses', `${f.toLowerCase().replace(/ /g, '-')}.txt`);
    assert.ok(fs.existsSync(lic), `${f}: no licence file`);
    assert.match(fs.readFileSync(lic, 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/i, f);
  }
});

test('xss-8: the offline copy keeps the interface fonts; profile fonts load when a profile uses one', async () => {
  const sw = await srv.call('GET', '/sw.js');
  const assets = JSON.parse(/const ASSETS = (\[[^\]]*\]);/.exec(sw.text)[1]);
  for (const a of ['/fonts/fonts.css', '/fonts/figtree-latin-wght-normal.woff2', '/fonts/figtree-latin-wght-italic.woff2', '/fonts/bricolage-grotesque-latin-opsz-normal.woff2']) {
    assert.ok(assets.includes(a), `${a} isn't kept for offline use`);
  }
  assert.ok(!assets.some((a) => /pacifico|monoton|creepster/.test(a)), 'profile fonts are not downloaded up front');
  assert.ok(assets.every((a) => a.startsWith('/')), 'the offline copy holds only this server\'s files');
});

// ------------------------------------------------------------------ the page's security policy (xss-7)
test('xss-7: the security policy names no font host and no blob: frames; fetch, XHR and sockets go only to Hearth', async () => {
  for (const p of ['/', '/download', '/terms', '/api/config']) {
    const csp = (await srv.call('GET', p)).headers.get('content-security-policy');
    assert.ok(csp, p);
    assert.ok(!/googleapis|gstatic/i.test(csp), `${p}: ${csp}`);
    const d = directives(csp);
    assert.deepEqual(d['font-src'], ["'self'", 'data:']);
    assert.deepEqual(d['style-src'], ["'self'", "'unsafe-inline'"]);
    assert.ok(!d['frame-src'].includes('blob:'), `${p}: frame-src allows blob:`);
    assert.deepEqual(d['frame-src'], ["'self'", 'https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com', 'https://player.twitch.tv']);
    assert.ok(d['connect-src'].every((s) => s === "'self'" || /^wss?:\/\/127\.0\.0\.1:\d+$/.test(s)), `${p}: connect-src ${d['connect-src']}`);
  }
  // Nothing in the app makes a frame out of a blob: (Recall is the only same-site frame, at /recall/).
  const code = walk(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const frames = [...code.matchAll(/h\('iframe', \{([^]*?)\}\)/g)].map((m) => m[1]);
  assert.ok(frames.length >= 4);
  for (const f of frames) assert.ok(!/blob|createObjectURL/.test(f), f);
});

// ------------------------------------------------------------------ the Outside images setting (xss-8)
test('xss-8: Outside images is a privacy choice kept on the server: ask first by default, checked, live on your other devices', async () => {
  const u = await srv.register();
  const other = await srv.register();
  const as = (who, method, p, body) => srv.api(method, p, { token: who.token, ip: who.ip, body });
  assert.equal((await as(u, 'GET', '/bootstrap')).json.me.privacy.outsideImages, 'ask');
  // Another device of the same person hears about the change straight away.
  const s = await srv.socket(u.token);
  try {
    const heard = new Promise((resolve) => s.on('user:update', (x) => { if (x.id === u.id && x.privacy && x.privacy.outsideImages === 'never') resolve(x); }));
    const r = await as(u, 'PATCH', '/me/privacy', { outsideImages: 'never' });
    assert.equal(r.status, 200);
    assert.equal(r.json.outsideImages, 'never');
    assert.equal(r.json.dms, 'everyone', 'the other privacy choices are kept');
    await Promise.race([heard, new Promise((_, rej) => setTimeout(() => rej(new Error('no user:update on the other device')), 5000))]);
  } finally { s.close(); }
  // Only the three choices exist; anything else is ignored.
  for (const bad of ['sometimes', '', null, 1, ['always'], { always: true }]) {
    const r = await as(u, 'PATCH', '/me/privacy', { outsideImages: bad });
    assert.equal(r.status, 200);
    assert.equal(r.json.outsideImages, 'never', JSON.stringify(bad));
  }
  assert.equal((await as(u, 'PATCH', '/me/privacy', { outsideImages: 'always' })).json.outsideImages, 'always');
  assert.equal((await as(u, 'GET', '/bootstrap')).json.me.privacy.outsideImages, 'always');
  // It's nobody else's business: other people never see it.
  const seen = await as(other, 'GET', `/users/${u.id}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.json.privacy, undefined);
});

test('xss-8: privacy changes are rate limited', async () => {
  const u = await srv.register();
  const codes = [];
  for (let i = 0; i < 64; i++) codes.push((await srv.api('PATCH', '/me/privacy', { token: u.token, ip: u.ip, body: { outsideImages: i % 2 ? 'ask' : 'never' } })).status);
  assert.equal(codes.filter((c) => c === 200).length, 60);
  assert.equal(codes.at(-1), 429);
});

// ------------------------------------------------------------------ the app's rules (public/js/outside.js)
test('xss-8: which image links are outside, and what a message shows for each choice', () => {
  const origin = 'https://chat.example.test';
  assert.equal(O.outsideMode(undefined), 'ask');
  assert.equal(O.outsideMode({}), 'ask');
  assert.equal(O.outsideMode({ outsideImages: 'never' }), 'never');
  assert.equal(O.outsideMode({ outsideImages: 'always' }), 'always');
  assert.equal(O.outsideMode({ outsideImages: 'bogus' }), 'ask');

  // Other sites (including look-alikes and other schemes or ports of this one) are outside.
  for (const src of ['https://pics.example.net/a.png', 'https://chat.example.test.evil.net/a.png', 'https://chat.example.test@evil.net/a.png',
    'http://chat.example.test/a.png', 'https://chat.example.test:8443/a.png', '//evil.net/a.png', 'https://media.tenor.com/x/y.gif', 'http://[::1/a.png']) {
    assert.equal(O.isOutside(src, origin), true, src);
  }
  // This server's own files, GIFs through its proxy (a relative /media/gif/ address), data: and blob: aren't.
  for (const src of ['https://chat.example.test/uploads/a.png', '/media/gif/abc?u=https%3A%2F%2Fmedia.giphy.com%2Fx.gif&t=t', 'data:image/png;base64,AAAA', 'blob:https://chat.example.test/1-2']) {
    assert.equal(O.isOutside(src, origin), false, src);
  }

  const out = 'https://pics.example.net/a.png';
  assert.equal(O.imageDecision(out, { origin }), 'ask', 'the default is to ask first');
  assert.equal(O.imageDecision(out, { origin, mode: 'ask', opened: true }), 'show', 'clicked open this session');
  assert.equal(O.imageDecision(out, { origin, mode: 'always' }), 'show');
  assert.equal(O.imageDecision(out, { origin, mode: 'never' }), 'hidden');
  assert.equal(O.imageDecision(out, { origin, mode: 'never', opened: true }), 'hidden', 'Never load wins over an earlier click');
  // A GIPHY/KLIPY link the app sends through this server's GIF proxy (with the reader's own token) always shows;
  // with the proxy off it loads from GIPHY, so it's outside like any other site.
  const gif = 'https://media.giphy.com/media/abc123/giphy.gif';
  for (const mode of ['ask', 'always', 'never']) assert.equal(O.imageDecision(gif, { origin, mode, viaProxy: true }), 'show', `proxied GIFs always show (${mode})`);
  assert.equal(O.imageDecision(gif, { origin }), 'ask');
  // A file uploaded to this server (a GIF from its library, an emoji) always shows.
  for (const mode of ['ask', 'always', 'never']) assert.equal(O.imageDecision(`${origin}/uploads/k3j4h5.gif`, { origin, mode }), 'show', mode);

  assert.equal(O.outsideHost('https://www.pics.example.net:8443/a.png?x=1'), 'pics.example.net:8443');
  assert.equal(O.outsideHost('not a link'), 'another site');
});

test('xss-8: a link to this server\'s own picture proxies is never shown as a picture, whatever the reader chose', () => {
  // Typed into a message, /media/news (and /media/art, /media/gif) carries the sender's own token and their choice
  // of site, so showing it would have this server fetch the sender's site for every reader: a read receipt, and an
  // outside picture shown to someone who chose Never load. It stays a plain link.
  const origin = 'https://chat.example.test';
  const sneaky = [
    `${origin}/media/news/x.png?u=https%3A%2F%2Fevil.test%2Fa.png&t=x`,
    `${origin}/media/news?u=https%3A%2F%2Fevil.test%2Fa.png&t=x&.png`,
    `${origin}/media/art/k.png?u=https%3A%2F%2Fi.scdn.co%2Fimage%2Fab.png&t=x`,
    `${origin}/media/gif/abc.gif?u=https%3A%2F%2Fmedia.giphy.com%2Fmedia%2Fx%2Fgiphy.gif&t=someone-elses-token`,
    `${origin}/uploads/../media/news/x.png?u=https%3A%2F%2Fevil.test%2Fa.png&t=x`,
    `${origin}/uploads/%2e%2e/media/news/x.png?u=https%3A%2F%2Fevil.test%2Fa.png&t=x`,
    `${origin}//evil.test/a.png`,
    `${origin}/uploads/a.png/b.png`,
    `${origin}/icons/icon-192.png`,
  ];
  for (const link of sneaky) {
    assert.equal(O.imagePlace(link, { origin }), 'server', link);
    for (const mode of ['ask', 'always', 'never']) {
      assert.equal(O.imageDecision(link, { origin, mode }), 'skip', `${link} (${mode})`);
      assert.equal(O.imageDecision(link, { origin, mode, opened: true }), 'skip', `${link} (${mode}, clicked)`);
    }
  }
  assert.equal(O.imagePlace(`${origin}/uploads/k3j4h5.png`, { origin }), 'here');
  assert.equal(O.imagePlace(`${origin}/uploads/k3j4h5.png?u=https%3A%2F%2Fevil.test%2F`, { origin }), 'here', 'the uploads route ignores the query: it never fetches anything');
  assert.equal(O.imagePlace('https://chat.example.test.evil.net/uploads/k3j4h5.png', { origin }), 'outside');
  assert.equal(O.imagePlace('http://chat.example.test/uploads/k3j4h5.png', { origin }), 'outside');
});

test('xss-8: every message body goes through click-to-load, voice channel chats included; scheduled messages show text only', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
  // One place puts a picture from a message on screen (embedImg), and only embedEl calls it after embedDecision.
  assert.equal((app.match(/class: 'embed-img'/g) || []).length, 1, 'one place builds a message picture');
  const calls = [...app.matchAll(/\bembedImg\(/g)].length;
  assert.equal(calls, 3, 'embedImg: its definition, the show branch and the Load button');
  // Image links are only pulled out of a message in fillMessage, and filtered by the reader's choice there.
  const fill = app.slice(app.indexOf('function fillMessage('), app.indexOf('function fillMessage(') + 6000);
  assert.match(fill, /extractImageUrls\(text\)\.filter\(.*embedDecision\(u, m\) !== 'skip'\)/);
  assert.match(fill, /embeds\.map\(\(u\) => embedEl\(u, m\)\)/);
  assert.equal([...app.matchAll(/extractImageUrls\(/g)].length, 2, 'fillMessage, and a count of image links (no picture)');
  // A voice channel's chat is the same conversation view as a text channel's, so its messages go through fillMessage.
  const panel = app.slice(app.indexOf('function voiceChatPanel('), app.indexOf('function membersPanel('));
  assert.match(panel, /chatView\(\)/, 'the voice chat panel uses the text channel view');
  // Scheduled messages (the Send later list) never build HTML from what people wrote, so no picture loads there.
  const sched = fs.readFileSync(path.join(PUBLIC, 'js', 'scheduled.js'), 'utf8');
  assert.doesNotMatch(sched, /innerHTML|'img'|extractImageUrls|embed-img/);
});

test('xss-8: a Load click counts for that message only: a later message with the same link asks again', () => {
  // Remembered by link alone, one click would let every later message with that link load by itself, anywhere, so
  // its sender (serving the picture uncached) would learn when each one is read without the reader being asked.
  const origin = 'https://chat.example.test';
  const link = 'https://pics.example.net/receipt.png';
  const opened = O.openedLinks();
  const decide = (mid) => O.imageDecision(link, { origin, mode: 'ask', opened: opened.has(mid, link) });
  assert.equal(decide('m1'), 'ask');
  opened.add('m1', link);
  assert.equal(decide('m1'), 'show', 'a redraw of the message it was clicked in doesn\u2019t ask again');
  assert.equal(decide('m2'), 'ask', 'another message with the same link asks again');
  assert.equal(opened.has('m1', 'https://pics.example.net/other.png'), false, 'another link in the same message asks too');
  opened.add(undefined, link); opened.add('', link);
  assert.equal(opened.has(undefined, link) || opened.has('', link) || opened.has(null, link), false, 'nothing is remembered without a message');
  // The app asks with the message it draws.
  const app = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
  assert.match(app, /const openedOutside = openedLinks\(\);/);
  assert.match(app, /opened: openedOutside\.has\(m && m\.id, u\)/);
  assert.match(app, /openedOutside\.add\(m && m\.id, u\);/);
  assert.match(app, /embedDecision\(text\.trim\(\), m\) === 'show'/);
  assert.doesNotMatch(app, /embedDecision\([^,()]+\)/, 'every call says which message');
});

test('xss-8: a watch-together video file from another site gets a notice; this server\'s files and the embedded players don\'t', () => {
  const origin = 'https://chat.example.test';
  assert.equal(O.outsideVideoHost({ kind: 'video', src: 'https://videos.example.net/clip.webm' }, origin), 'videos.example.net');
  assert.equal(O.outsideVideoHost({ kind: 'video', src: 'https://chat.example.test/uploads/clip.webm' }, origin), null);
  for (const kind of ['youtube', 'vimeo', 'twitch']) assert.equal(O.outsideVideoHost({ kind, src: 'dQw4w9WgXcQ' }, origin), null, kind);
  assert.equal(O.outsideVideoHost(null, origin), null);
});
