// Link previews, the app's side (public/js/linkpreview.js, markdown.js linkedUrls, secure.js, app.js): which link
// the composer offers, what readers accept from inside a message, and that a message with a preview still fits
// and still opens in older apps. The client modules run here as they are (no browser needed).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis.window || { crypto: globalThis.crypto };

const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;
let LP; let MD; let E; let A;
before(async () => {
  LP = await import(js('linkpreview.js'));
  MD = await import(js('markdown.js'));
  E = await import(js('e2ee.js'));
  A = await import(js('attachments.js'));
});

const ORIGIN = { origin: 'chat.ourhearth.net' };
// A WebP or JPEG thumbnail of a given size in bytes, as base64 (only its first bytes matter to the checks).
const webp = (bytes = 600) => { const b = Buffer.alloc(bytes, 7); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(bytes - 8, 4); b.write('WEBPVP8 ', 8, 'latin1'); return b.toString('base64'); };
const jpg = (bytes = 600) => { const b = Buffer.alloc(bytes, 7); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b.toString('base64'); };
const card = (url, extra = {}) => ({ v: 1, url, title: 'A title', desc: 'A description', site: 'Site', kind: 'web', ...extra });

test('findPreviewUrl: the first https link outside code and spoilers; image links, GIF media, this server, IP hosts and http links are skipped', () => {
  const f = (t) => LP.findPreviewUrl(t, ORIGIN);
  assert.equal(f('look https://news.example-site.net/a?b=1 and https://second.example-site.net/'), 'https://news.example-site.net/a?b=1');
  assert.equal(f('in code `https://code.example-site.net/x` then https://after.example-site.net/'), 'https://after.example-site.net/');
  assert.equal(f('```\nhttps://block.example-site.net/\n``` https://after.example-site.net/'), 'https://after.example-site.net/');
  assert.equal(f('a spoiler ||https://hidden.example-site.net/|| only'), null);
  assert.equal(f('https://pics.example-site.net/cat.png https://media.giphy.com/media/x/giphy.gif https://media.tenor.com/x/y.gif'), null, 'pictures and GIFs show as pictures');
  assert.equal(f('https://static.klipy.com/x/y https://ok.example-site.net/'), 'https://ok.example-site.net/');
  assert.equal(f('https://chat.ourhearth.net/invite/abc'), null, 'links to this server');
  assert.equal(f('http://plain.example-site.net/ https://93.184.216.34/ https://localhost/ https://box.lan/ https://www.example.com/'), null);
  assert.equal(f('https://news.example-site.net:8443/'), null, 'other ports');
  assert.equal(LP.findPreviewUrl('https://news.example-site.net:8443/', { anyPort: true }), 'https://news.example-site.net:8443/', 'except in tests');
  assert.equal(f('trailing punctuation https://news.example-site.net/a).'), 'https://news.example-site.net/a', 'the link as render() makes it');
  assert.equal(f(''), null);
});

test('linkedUrls matches the links render() makes', () => {
  const text = 'see https://a.example-site.net/x, `https://code.example-site.net/` and **https://b.example-site.net/y** > https://c.example-site.net/z';
  const hrefs = [...MD.render(text).matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.deepEqual(MD.linkedUrls(text), hrefs);
  assert.deepEqual(MD.linkedUrls('||https://s.example-site.net/||'), ['https://s.example-site.net/||'], 'render() would link it (with the bars)');
  assert.deepEqual(MD.linkedUrls('||https://s.example-site.net/||', { skipSpoilers: true }), []);
});

test('cleanLinks: kept only when its URL is linked in the text and is https without credentials, mixed-script host or bidi characters; fields are capped', () => {
  const url = 'https://news.example-site.net/story';
  const text = `read ${url} now`;
  assert.deepEqual(LP.cleanLinks([card(url)], text, ORIGIN), [card(url)]);
  assert.equal(LP.cleanLinks([card('https://elsewhere.example-site.net/')], text, ORIGIN), undefined, 'a card for a link that isn’t in the message');
  assert.equal(LP.cleanLinks([card(url)], `\`${url}\``, ORIGIN), undefined, 'a link only inside code');
  assert.equal(LP.cleanLinks([card(url)], `||${url}||`, ORIGIN), undefined, 'a link only inside a spoiler');
  for (const bad of ['http://news.example-site.net/', 'https://user:pw@news.example-site.net/', 'https://аpple.com/', 'https://news.example-site.net/‮gnp.exe',
    'https://news.example-site.net/╱', 'https://10.0.0.1/', 'https://printer.local/', 'https://chat.ourhearth.net/x', 'https://news.example-site.net:8443/', `https://news.example-site.net/${'a'.repeat(2100)}`]) {
    assert.equal(LP.cleanLinks([card(bad)], `x ${bad} y`, ORIGIN), undefined, bad.slice(0, 50));
  }
  assert.ok(LP.cleanLinks([card('https://xn--80ak6aa92e.com/')], 'https://xn--80ak6aa92e.com/', ORIGIN), 'a host written in punycode is fine (it shows as punycode)');
  assert.ok(LP.cleanLinks([card('https://пример.рф/')], 'https://пример.рф/', ORIGIN), 'a host entirely in one non-Latin script is fine');
  const long = LP.cleanLinks([card(url, { title: 'T'.repeat(500), desc: `a‮b​c ${'d'.repeat(900)}`, site: 'S'.repeat(90), kind: 'mystery' })], text, ORIGIN)[0];
  assert.equal([...long.title].length, 200);
  assert.equal([...long.desc].length, 300);
  assert.ok(long.desc.startsWith('abc d'), 'bidi and zero-width characters are removed');
  assert.equal([...long.site].length, 60);
  assert.equal(long.kind, 'web', 'an unknown kind becomes "web"');
  assert.equal(LP.hostLabel('https://www.news.example-site.net/a'), 'news.example-site.net', 'the domain line comes from the link');
});

test('cleanLinks: images must be ≤16 KiB base64 WebP/JPEG with matching magic bytes; anything else drops the image, not the card', () => {
  const url = 'https://news.example-site.net/a';
  const keep = (img) => LP.cleanLinks([card(url, { img })], url, ORIGIN)[0];
  assert.deepEqual(keep({ type: 'image/webp', data: webp(), w: 400, h: 210 }).img, { type: 'image/webp', data: webp(), w: 400, h: 210 });
  assert.ok(keep({ type: 'image/jpeg', data: jpg(16384), w: 320, h: 180 }).img, 'exactly 16 KiB');
  for (const img of [
    { type: 'image/jpeg', data: jpg(16385), w: 320, h: 180 }, // too big
    { type: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), w: 10, h: 10 }, // not a type the app makes
    { type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64'), w: 10, h: 10 },
    { type: 'image/webp', data: jpg(), w: 10, h: 10 }, // the bytes say JPEG
    { type: 'image/jpeg', data: webp(), w: 10, h: 10 },
    { type: 'image/webp', data: webp(), w: 401, h: 10 }, { type: 'image/webp', data: webp(), w: 0, h: 10 }, { type: 'image/webp', data: webp(), w: 1.5, h: 10 },
    { type: 'image/webp', data: `${webp()}"><script>`, w: 10, h: 10 }, { type: 'image/webp', data: 42, w: 10, h: 10 }, 'data:image/webp;base64,AAAA', null,
  ]) {
    const c = keep(img);
    assert.ok(c && c.title === 'A title', 'the card stays');
    assert.equal(c.img, undefined, JSON.stringify(img).slice(0, 80));
  }
});

test('cleanLinks: unknown versions, kinds and extra keys are ignored; at most one card; never throws on junk', () => {
  const url = 'https://news.example-site.net/a';
  const two = 'https://two.example-site.net/b';
  const text = `${url} ${two}`;
  const out = LP.cleanLinks([{ v: 2, url, title: 'future' }, card(url, { extra: 'x', html: '<b>' }), card(two)], text, ORIGIN);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), ['desc', 'kind', 'site', 'title', 'url', 'v'], 'unknown keys are dropped');
  assert.equal(out[0].url, url, 'the first entry this app understands');
  assert.equal(LP.cleanLinks([card(url, { title: '', desc: '', site: 'Only a site' })], url, ORIGIN), undefined, 'a card with nothing to show');
  for (const junk of [null, undefined, 'x', 42, {}, [null], [42], ['x'], [[]], [{ v: '1', url }], [{ v: 1, url: { toString: () => url } }], [Object.create(null)],
    JSON.parse(`[{"__proto__": {"v": 1}, "url": "${url}"}]`), [{ v: 1, url, title: { length: 1e9 } }]]) {
    assert.doesNotThrow(() => LP.cleanLinks(junk, text, ORIGIN));
    const r = LP.cleanLinks(junk, text, ORIGIN);
    assert.ok(r === undefined || (r.length === 1 && typeof r[0].title === 'string'), JSON.stringify(junk));
  }
  assert.equal(LP.cleanLinks([card(url)], null, ORIGIN), undefined);
});

test('looksPrivate: sign-in, reset, invite and share links are not previewed without asking', () => {
  for (const u of ['https://app.example-site.net/login?token=abc', 'https://app.example-site.net/x?code=123&state=y', 'https://app.example-site.net/reset/abc',
    'https://app.example-site.net/a?X-Amz-Signature=1', 'https://docs.google.com/document/d/1/edit', 'https://www.dropbox.com/s/x', 'https://us02web.zoom.us/j/1',
    'https://app.example-site.net/invite/abc', 'https://app.example-site.net/magic-link?k=1', 'https://app.example-site.net/oauth/callback', 'not a url']) {
    assert.equal(LP.looksPrivate(u), true, u);
  }
  for (const u of ['https://news.example-site.net/2026/10/story', 'https://github.com/hearth/hearth/issues/1', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://news.example-site.net/author/jane']) {
    assert.equal(LP.looksPrivate(u), false, u);
  }
});

test('Show link previews: the composer offers a preview only where readers will show it (the server-wide permission), so a channel override can turn it off but not on', async () => {
  const PM = await import(js('perms.js'));
  const { EMBED_LINKS, VIEW_CHANNEL, SEND_MESSAGES, ADMINISTRATOR } = PM.PERMS;
  const server = {
    ownerId: 'owner', kind: 'server',
    roleDefs: [{ id: 'every', everyone: true, permissions: VIEW_CHANNEL | SEND_MESSAGES }, { id: 'linkers', permissions: EMBED_LINKS }, { id: 'admins', permissions: ADMINISTRATOR }],
    memberRoles: { carol: ['linkers'], dave: ['admins'] },
  };
  assert.equal(PM.mayEmbed(server, 'bob'), false, '@everyone without it: no cards from bob, whatever a channel override says');
  assert.equal(PM.mayEmbed(server, 'carol'), true, 'a role that has it');
  assert.equal(PM.mayEmbed(server, 'dave'), true, 'Administrator');
  assert.equal(PM.mayEmbed(server, 'owner'), true, 'the owner');
  assert.equal(PM.mayEmbed({ kind: 'group', ownerId: 'x', roleDefs: [] }, 'bob'), true, 'everyone in a group chat');
  assert.equal(PM.mayEmbed(null, 'bob'), false);
  // Readers and the composer ask that same question; the composer also needs the channel's own permission.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const body = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  assert.match(body('function senderMayEmbed(', '\n}\n'), /return mayEmbed\(S\.servers\.find\(\(x\) => x\.id === m\.serverId\), m\.authorId\);/);
  assert.match(body('const linksAllowedHere = ', '\n  };'), /canIn\(ch, PERMS\.EMBED_LINKS\) && mayEmbed\(serverOfChannel\(ch\.id\), S\.me\.id\)/);
});

// ---------------------------------------------------------------- inside real ciphertexts
async function people() {
  const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const a = await E.createIdentity(wrapKey);
  const b = await E.createIdentity(wrapKey);
  const sk = await E.createSigningKey(a.privateKey, a.publicKey);
  return { a: { ...a, ...sk, id: 'alice-1' }, b: { ...b, id: 'bob-1' } };
}
// app.js encryptFitting, step for step (app.js itself needs a page around it).
const CIPHER_MAX = 64000;
async function fitting(payload, encrypt) {
  let out; let used;
  for (const p of LP.payloadVariants(payload)) { out = await encrypt(p); used = p; if (out.length <= CIPHER_MAX) break; }
  return { out, used };
}

test('payload size: a 4000-character message with a full preview fits in 64,000 ciphertext characters; a bigger one drops the picture first, then the card', async () => {
  const { a, b } = await people();
  const raw = E.newGroupKey();
  const url = 'https://news.example-site.net/a';
  const full = (t) => ({ t, f: [], l: [card(url, { title: 'T'.repeat(200), desc: 'D'.repeat(300), site: 'S'.repeat(60), img: { type: 'image/webp', data: webp(16384), w: 400, h: 210 } })] });
  const group = (p) => E.encryptGroup({ raw, serverId: 's1', channelId: 'c1', epoch: 1, authorId: a.id, signKey: a.signKey, payload: p });
  const dm = (p) => E.encryptDm({ myPriv: a.privateKey, theirPub: b.publicKey, dmId: 'd1', authorId: a.id, payload: p });
  for (const enc of [group, dm]) {
    const r = await fitting(full(`${url} ${'x'.repeat(3965)}`), enc);
    assert.ok(r.used.l && r.used.l[0].img, 'the whole preview fits next to the longest message the composer allows');
    assert.ok(r.out.length <= CIPHER_MAX, `${r.out.length} characters`);
    const big = await fitting(full(`${url} ${'x'.repeat(26000)}`), enc);
    assert.ok(big.used.l && !big.used.l[0].img, 'too big with the picture: the card goes without it');
    assert.ok(big.out.length <= CIPHER_MAX);
    const bigger = await fitting(full(`${url} ${'x'.repeat(47000)}`), enc);
    assert.equal(bigger.used.l, undefined, 'still too big: no card');
    assert.ok(bigger.out.length <= CIPHER_MAX);
  }
  assert.deepEqual(LP.payloadVariants({ t: 'x', f: [] }), [{ t: 'x', f: [] }], 'nothing to drop without a preview');
});

test('older apps: a payload with l still decrypts, and the old opener (t, f, p only) shows the text unchanged; the new one keeps the checked card', async () => {
  const { a } = await people();
  const raw = E.newGroupKey();
  const url = 'https://news.example-site.net/a';
  const payload = { t: `hello ${url}`, f: [], l: [card(url, { img: { type: 'image/jpeg', data: jpg(), w: 100, h: 50 } })] };
  const text = await E.encryptGroup({ raw, serverId: 's1', channelId: 'c1', epoch: 1, authorId: a.id, signKey: a.signKey, payload });
  const { payload: opened, verified } = await E.decryptGroup({ raw, serverId: 's1', channelId: 'c1', authorId: a.id, authorSignPub: a.signPublicKey, text });
  assert.equal(verified, true, 'the card is covered by the sender’s signature with the rest');
  const old = { t: String(opened.t || ''), f: A.cleanFiles(opened.f) }; // what secure.js kept before previews
  assert.deepEqual(old, { t: payload.t, f: [] });
  assert.deepEqual(LP.cleanLinks(opened.l, opened.t, ORIGIN), payload.l);
});

test('static: secure.js checks previews in both openers, linkCardEl builds text nodes only, and the size limits match', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const secure = read('public', 'js', 'secure.js');
  assert.equal((secure.match(/\.\.\.linksIn\(payload\)/g) || []).length, 2, 'channel and DM messages');
  assert.equal((secure.match(/cleanLinks\(/g) || []).length, 1);
  const app = read('public', 'js', 'app.js');
  const card = app.slice(app.indexOf('function linkCardEl('), app.indexOf('\n}\n', app.indexOf('function linkCardEl(')));
  assert.ok(card.length > 100);
  assert.doesNotMatch(card, /html:/, 'no HTML from a preview');
  assert.doesNotMatch(card, /md\(/, 'no markdown either');
  assert.match(app, /const CIPHER_MAX = 64000;/);
  assert.match(read('server', 'index.js'), /const validCipher = \(c\) => \{\n\s+if \(typeof c !== 'string' \|\| c\.length < 20 \|\| c\.length > 64000\)/);
  // The thumbnail limit the reader enforces is what the sender's app makes.
  assert.equal(LP.THUMB_MAX_BYTES, 16384);
  assert.match(read('public', 'js', 'media.js'), /r\.blob\.size <= 16384/);
});
