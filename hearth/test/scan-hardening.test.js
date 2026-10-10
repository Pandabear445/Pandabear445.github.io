// Fixes that came out of the CodeQL code scan: the per-account request ceiling, secret files created only once
// even when two processes start together, profile CSS that can't close its <style> element, and drafts kept
// in a Map so no conversation key can clash with an object's built-in properties.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, hex } = require('./helpers');

const CEILING = 25;
let srv;
before(async () => { srv = await startServer({ API_RATE_LIMIT: String(CEILING) }); });
after(async () => { await srv.stop(); });

test('every signed-in request counts toward a per-account ceiling; logging out and other accounts still work', async () => {
  const a = await srv.register(`ceil${hex(3)}`);
  const b = await srv.register(`ceil${hex(3)}`);
  const get = (u) => srv.api('GET', '/me/notify', { token: u.token, ip: u.ip });
  // Registering doesn't use the ceiling: it counts signed-in requests only.
  for (let i = 0; i < CEILING; i++) assert.equal((await get(a)).status, 200, `request ${i + 1}`);
  const over = await get(a);
  assert.equal(over.status, 429, over.text);
  assert.equal(over.json.code, 'rate_limited');
  assert.ok(+over.headers.get('retry-after') > 0, 'says when to try again');
  assert.equal((await get(b)).status, 200, 'another account has its own allowance');
  assert.equal((await srv.api('GET', '/config', { ip: a.ip })).status, 200, 'public routes are not part of it');
  assert.equal((await srv.api('POST', '/auth/logout', { token: a.token, ip: a.ip })).status, 200, 'logging out is never refused');
});

test('a secret file is made once: a process that loses the race uses the file the other one wrote', () => {
  const { readOrCreate } = require('../server/secretfile');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-secret-'));
  const file = path.join(dir, 'k.key');
  assert.equal(readOrCreate(file, () => 'first'), 'first');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.equal(readOrCreate(file, () => 'second'), 'first', 'an existing file is kept');
  // Another process writes the file between this one's read and its write: this one ends up with theirs.
  const racy = path.join(dir, 'r.key');
  assert.equal(readOrCreate(racy, () => { fs.writeFileSync(racy, 'theirs'); return 'mine'; }), 'theirs');
  assert.equal(fs.readFileSync(racy, 'utf8'), 'theirs');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('profile CSS never contains "<", so it cannot close the <style> element it is put in', () => {
  const { sanitizeCss } = require('../server/page');
  for (const css of ['</style><script>alert(1)</script>', '<sty<stylele>', '<\\/style>', 'a { color: red } </STYLE >', '<<!---->/style>']) {
    const out = sanitizeCss(css);
    assert.ok(!out.includes('<'), `${JSON.stringify(css)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(sanitizeCss('.card > p { color: #fff; }'), '.card > p { color: #fff; }', 'ordinary CSS (child selectors too) is kept');
});

test('drafts keep any conversation key as plain data ("__proto__" included) and survive a reload', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
  };
  globalThis.window = { addEventListener() {} };
  try {
    const { createDrafts } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'usability.js')).href);
    const d = createDrafts('u1');
    assert.equal(d.get('__proto__'), '', 'nothing there yet (not the object prototype)');
    assert.equal(d.get('constructor'), '');
    d.set('__proto__', 'odd but harmless');
    d.set('c:abc', 'hello');
    d.flush();
    assert.equal(({}).t, undefined, 'Object.prototype untouched');
    const again = createDrafts('u1');
    assert.equal(again.get('__proto__'), 'odd but harmless');
    assert.equal(again.get('c:abc'), 'hello');
    assert.deepEqual(again.entries().sort(), [['__proto__', 'odd but harmless'], ['c:abc', 'hello']]);
    again.delete('c:abc');
    again.clear();
    assert.equal(store.has('hearth.drafts.u1'), false);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
  }
});
