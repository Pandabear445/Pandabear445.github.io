// Attachment options, the app's side: a description (alt text) and "Mark as spoiler" travel inside the encrypted
// message with each file (app.js uploadEncryptedFiles), so the sender chose them; public/js/attachments.js
// cleanFiles keeps only a capped string and a plain yes for them. The module runs here as it is (no browser).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let A;
before(async () => { A = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'attachments.js')).href); });
const file = (extra = {}) => ({ url: '/uploads/0abc123def.bin', k: 'key', name: 'cat.png', type: 'image/png', size: 10, ...extra });

test('a description is kept as words, trimmed and capped at 1000 characters', () => {
  assert.equal(A.ALT_MAX, 1000);
  assert.equal(A.cleanFiles([file({ alt: '  A cat asleep on a keyboard  ' })])[0].alt, 'A cat asleep on a keyboard');
  assert.equal(A.cleanFiles([file({ alt: 'x'.repeat(5000) })])[0].alt.length, 1000);
  assert.equal(A.cleanFiles([file({ alt: 'line one\nline\u0000two' })])[0].alt, 'line one line two', 'control characters become spaces');
});

test('a description that isn’t a string, or is empty, is dropped', () => {
  for (const alt of [{ toString: () => 'x' }, ['a'], 42, true, null, '', '   ']) {
    const [f] = A.cleanFiles([file({ alt })]);
    assert.ok(!('alt' in f), `alt ${JSON.stringify(alt)} should be dropped`);
  }
});

test('spoiler is a plain yes: 1 or true become 1, anything else is dropped', () => {
  assert.equal(A.cleanFiles([file({ sp: 1 })])[0].sp, 1);
  assert.equal(A.cleanFiles([file({ sp: true })])[0].sp, 1);
  for (const sp of [0, '1', 'yes', 2, {}, [], null, false]) {
    const [f] = A.cleanFiles([file({ sp })]);
    assert.ok(!('sp' in f), `sp ${JSON.stringify(sp)} should be dropped`);
  }
});

test('a file without options comes out as it went in, and a bad address still loses the whole entry', () => {
  assert.deepEqual(A.cleanFiles([file()]), [file()]);
  assert.deepEqual(A.cleanFiles([{ url: 'https://evil.example/x.png', alt: 'hi', sp: 1 }]), []);
  const both = A.cleanFiles([file({ alt: 'A map', sp: 1 })])[0];
  assert.equal(both.alt, 'A map');
  assert.equal(both.sp, 1);
});

test('the app sends both inside the message, reads alt for pictures and blurs spoilers until the first click', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /\.\.\.\(p\.spoiler \? \{ sp: 1 \} : \{\}\), \.\.\.\(p\.alt \? \{ alt: String\(p\.alt\)\.slice\(0, ALT_MAX\) \} : \{\}\)/);
  assert.match(app, /alt: f\.alt \|\| f\.name \|\| 'Image'/);
  assert.match(app, /if \(f\.sp\) spoilerCover\(holder, el, media\)/);
  // Unopened spoilers stay out of the picture viewer's left/right browsing.
  assert.match(app, /!i\.closest\('\.att-spoiler:not\(\.revealed\)'\)/);
  // A message that would be too big for the server with ten long descriptions goes with them cut short.
  const fit = app.slice(app.indexOf('async function encryptFitting('), app.indexOf('async function sendTo('));
  assert.match(fit, /alt: f\.alt\.slice\(0, 200\)/);
  // The server never sees either: no route or column for them.
  const server = fs.readdirSync(path.join(__dirname, '..', 'server')).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8')).join('\n');
  assert.doesNotMatch(server, /\balt_text\b|\bspoiler\b/i);
});
