// The search box's filter syntax (public/js/search-query.js): parsed and matched on the device only.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let Q;
before(async () => { Q = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'search-query.js')).href); });
const day = (y, m, d) => new Date(y, m - 1, d).getTime();
const view = (text, extra = {}) => ({ text, files: [], edited: false, pinned: false, createdAt: day(2025, 5, 10), ...extra });

test('words, phrases and every filter are pulled apart', () => {
  const q = Q.parseQuery('  pizza from:@Alex in:#general "friday night" has:image is:edited Pizza  ');
  assert.deepEqual(q.words, ['pizza'], 'words are deduplicated without caring about case');
  assert.deepEqual(q.phrases, ['friday night']);
  assert.deepEqual(q.from, { name: 'Alex', exact: true });
  assert.deepEqual(q.in, { kind: 'channel', name: 'general' });
  assert.deepEqual(q.has, ['image']);
  assert.deepEqual(q.is, ['edited']);
  assert.deepEqual(q.errors, []);
  assert.deepEqual(q.filters.map((f) => f.raw), ['from:@Alex', 'in:#general', 'has:image', 'is:edited']);
  assert.deepEqual(q.terms, ['friday night', 'pizza']);
});

test('from: and in: forms', () => {
  assert.deepEqual(Q.parseQuery('from:alex').from, { name: 'alex', exact: false });
  assert.deepEqual(Q.parseQuery('from:"Alex Smith" hi').from, { name: 'Alex Smith', exact: false });
  assert.deepEqual(Q.parseQuery('from:"Alex Smith" hi').words, ['hi']);
  assert.deepEqual(Q.parseQuery('FROM:me').from, { me: true, name: 'me' });
  assert.deepEqual(Q.parseQuery('in:@sam').in, { kind: 'user', name: 'sam' });
  assert.deepEqual(Q.parseQuery('in:random').in, { kind: 'channel', name: 'random' });
  assert.match(Q.parseQuery('from:a from:b').errors[0], /one from: filter/);
  assert.match(Q.parseQuery('from:').errors[0], /from: needs a name/);
  assert.match(Q.parseQuery('in:#').errors[0], /in: needs a channel/);
});

test('dates: before, after and during a day, month or year (local time)', () => {
  let q = Q.parseQuery('before:2025-05-31');
  assert.equal(q.before, day(2025, 5, 31));
  assert.equal(q.after, null);
  q = Q.parseQuery('after:2025-05-31');
  assert.equal(q.after, day(2025, 6, 1), 'after a day means after that whole day');
  q = Q.parseQuery('during:2025-05-31');
  assert.deepEqual([q.after, q.before], [day(2025, 5, 31), day(2025, 6, 1)]);
  q = Q.parseQuery('during:2024-02');
  assert.deepEqual([q.after, q.before], [day(2024, 2, 1), day(2024, 3, 1)]);
  q = Q.parseQuery('during:2024');
  assert.deepEqual([q.after, q.before], [day(2024, 1, 1), day(2025, 1, 1)]);
  q = Q.parseQuery('after:2025-01-01 before:2025-03-01 during:2025-02');
  assert.deepEqual([q.after, q.before], [day(2025, 2, 1), day(2025, 3, 1)], 'several dates narrow it down');
  assert.equal(Q.parseQuery('before:2025/5/7').before, day(2025, 5, 7));
  for (const bad of ['before:2025-13-01', 'after:2025-02-30', 'during:yesterday', 'before:', 'after:1969-12-31', 'before:25-01-01']) {
    assert.match(Q.parseQuery(bad).errors[0] || '', /needs a date like 2025-05-31/, bad);
  }
  assert.match(Q.parseQuery('after:2025-06-01 before:2025-05-01').errors[0], /after: date must come before/);
});

test('unknown values are explained; unknown operators are just words', () => {
  assert.deepEqual(Q.parseQuery('has:foo').errors, ['Unknown filter has:foo — try has:file, has:image, has:link']);
  assert.deepEqual(Q.parseQuery('is:deleted').errors, ['Unknown filter is:deleted — try is:edited, is:pinned']);
  assert.match(Q.parseQuery('has:').errors[0], /has: needs a type/);
  assert.deepEqual(Q.parseQuery('has:files has:Attachment has:links').has, ['file', 'link'], 'plurals and aliases');
  const q = Q.parseQuery('https://example.com at 12:30 re:lunch');
  assert.deepEqual(q.errors, []);
  assert.deepEqual(q.filters, []);
  assert.deepEqual(q.words, ['https://example.com', 'at', '12:30', 're:lunch']);
});

test('matching: all words and phrases, any case, also in file names', () => {
  const q = Q.parseQuery('pizza "Friday night"');
  assert.ok(Q.matchMessage(q, view('PIZZA on friday NIGHT?')));
  assert.ok(!Q.matchMessage(q, view('pizza on friday, night')), 'a phrase must appear as written');
  assert.ok(!Q.matchMessage(q, view('Friday night tacos')), 'every word must appear');
  assert.ok(Q.matchMessage(Q.parseQuery('invoice'), view('see attached', { files: [{ name: 'Invoice-May.pdf' }] })));
  assert.ok(Q.matchMessage(Q.parseQuery('crème'), view('Crème brûlée')), 'accents and unicode case');
  assert.ok(Q.matchMessage(Q.parseQuery('a.b (c)'), view('x a.b (c) y')), 'regex characters are literal');
  assert.ok(!Q.matchMessage(Q.parseQuery('a.b'), view('axb')));
  assert.ok(Q.matchMessage(Q.parseQuery(''), view('anything')), 'no words: everything matches');
});

test('matching: has:, is: and dates', () => {
  const img = { name: 'cat.png', type: 'image/png' };
  const pdf = { name: 'doc.pdf', type: 'application/pdf' };
  assert.ok(Q.matchMessage(Q.parseQuery('has:file'), view('', { files: [pdf] })));
  assert.ok(!Q.matchMessage(Q.parseQuery('has:file'), view('no files')));
  assert.ok(Q.matchMessage(Q.parseQuery('has:image'), view('', { files: [img] })));
  assert.ok(Q.matchMessage(Q.parseQuery('has:image'), view('', { files: [{ name: 'IMG_1.JPG' }] })), 'by extension too');
  assert.ok(!Q.matchMessage(Q.parseQuery('has:image'), view('', { files: [pdf] })));
  assert.ok(Q.matchMessage(Q.parseQuery('has:image'), view('look', { imageLinks: 1 })), 'an image link counts');
  assert.ok(Q.matchMessage(Q.parseQuery('has:link'), view('see https://example.com/x')));
  assert.ok(!Q.matchMessage(Q.parseQuery('has:link'), view('see example dot com')));
  assert.ok(!Q.matchMessage(Q.parseQuery('has:link has:file'), view('https://a.b')), 'has: filters add up');
  assert.ok(Q.matchMessage(Q.parseQuery('is:edited'), view('x', { edited: true })));
  assert.ok(!Q.matchMessage(Q.parseQuery('is:edited'), view('x')));
  assert.ok(Q.matchMessage(Q.parseQuery('is:pinned'), view('x', { pinned: true })));
  assert.ok(Q.matchMessage(Q.parseQuery('during:2025-05-10'), view('x')));
  assert.ok(!Q.matchMessage(Q.parseQuery('before:2025-05-10'), view('x')));
  assert.ok(Q.matchMessage(Q.parseQuery('after:2025-05-09'), view('x')));
  assert.ok(!Q.matchMessage(Q.parseQuery('after:2025-05-10'), view('x')));
});

test('highlighting pieces cover the text exactly and mark every match', () => {
  const q = Q.parseQuery('hello "hello world" <b>');
  const text = 'Hello world, <b>hello</b> again';
  const parts = Q.segments(text, q);
  assert.equal(parts.map((p) => p.text).join(''), text, 'nothing lost or added');
  assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ['Hello world', '<b>', 'hello'], 'longest match first, original case kept');
  assert.deepEqual(Q.segments('plain', Q.parseQuery('')), [{ text: 'plain', hit: false }]);
  assert.deepEqual(Q.segments('', q), []);
  // Called twice with the same query: the shared pattern starts over each time.
  assert.deepEqual(Q.segments(text, q), parts);
});

test('excerpts stay short, center on the first match and never split an emoji', () => {
  const long = 'start '.repeat(60) + 'the NEEDLE is here ' + 'end '.repeat(60);
  const ex = Q.excerpt(long, Q.parseQuery('needle'), 120);
  assert.ok(ex.length <= 122, ex.length);
  assert.ok(ex.startsWith('…') && ex.endsWith('…'));
  assert.ok(ex.includes('NEEDLE'));
  assert.equal(Q.excerpt('short\n\ntext', Q.parseQuery('x')), 'short text', 'whitespace folded');
  assert.equal(Q.excerpt('hi <:party:abc123def> there', null), 'hi :party: there', 'custom emoji shown by name');
  const emoji = '\u{1F600}'.repeat(200);
  for (const max of [119, 120, 121]) assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(Q.excerpt(emoji, null, max)), `no lone surrogate at ${max}`);
});

test('removing one chip or all filters keeps the words', () => {
  const text = 'pizza from:@alex has:image "friday night" before:2025-01-01';
  const q = Q.parseQuery(text);
  assert.equal(Q.removeFilter(text, q.filters[1]), 'pizza from:@alex "friday night" before:2025-01-01');
  assert.equal(Q.clearFilters(text), 'pizza "friday night"');
  assert.equal(Q.clearFilters('from:"Alex Smith" in:#general'), '');
});
