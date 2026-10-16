// Word filters: hiding or blurring messages with words someone would rather not see. Messages are end-to-end
// encrypted, so the matching runs only in the reader's app (public/js/wordfilter.js, tested here as it is); the
// server keeps your own list sealed (it never sees a word of it) and a server's suggested list in plain text, set by
// people with Manage Server, audited, and sent live to the server's members (server/wordfilter.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, hex } = require('./helpers');
const { cleanList, LIMITS: SERVER_LIMITS } = require('../server/wordfilter');

const ROOT = path.join(__dirname, '..');
const cp = (...n) => String.fromCodePoint(...n);
let W; let srv;
const socks = [];
before(async () => {
  W = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'wordfilter.js')).href);
  srv = await startServer();
});
after(async () => { socks.forEach((s) => s.close()); if (srv) await srv.stop(); });

// ================================================================== the matcher
const hits = (list, text) => W.compile(list).find(text);

test('matcher: whole words in any capitalization, never part of another word', () => {
  const list = ['cat'];
  for (const t of ['cat', 'Cat!', 'a CAT.', '(cat)', 'my cat, my rules', 'cat\nnext line', '"cat"', 'cat’s'])
    assert.equal(hits(list, t), 'cat', `“${t}” should match`);
  for (const t of ['category', 'concat', 'bobcat', 'scatter', 'ca t', 'catcat', ''])
    assert.equal(hits(list, t), null, `“${t}” should not match`);
  // Numbers count as part of a word, like letters.
  assert.equal(hits(list, 'cat9'), null);
  assert.equal(hits(['r2d2'], 'R2D2 is here'), 'r2d2');
});

test('matcher: phrases match those words in a row, whatever spaces or punctuation sit between them', () => {
  const list = ['bad apple'];
  for (const t of ['a bad apple', 'BAD   apple', 'bad, apple', 'bad\napple', 'bad-apple', 'bad...apple!'])
    assert.equal(hits(list, t), 'bad apple', `“${t}” should match`);
  for (const t of ['bad red apple', 'apple bad', 'bad apples', 'badapple'])
    assert.equal(hits(list, t), null, `“${t}” should not match`);
});

test('matcher: * stands for any letters inside one word, and never reaches into the next word', () => {
  const list = ['bad*', '*fish', 'c*t', 'ex*ple*'];
  const want = { bad: 'bad*', badly: 'bad*', BADNESS: 'bad*', catfish: '*fish', fish: '*fish', cut: 'c*t', coat: 'c*t', ct: 'c*t', examples: 'ex*ple*', example: 'ex*ple*' };
  for (const [t, e] of Object.entries(want)) assert.equal(hits(list, t), e, `“${t}”`);
  for (const t of ['ba', 'abad', 'fishy', 'cute', 'coats', 'exa mple']) assert.equal(hits(list, t), null, `“${t}” should not match`);
  // A * inside a phrase stays inside its own word.
  assert.equal(hits(['big bad*'], 'big badly'), 'big bad*');
  assert.equal(hits(['big bad*'], 'big red badly'), null);
});

test('normalization: width, styled letters, accents, Zalgo, invisible characters and look-alike letters fold away', () => {
  const list = ['cat', 'naive'];
  const forms = [
    'ｃａｔ', // fullwidth
    cp(0x1d41c, 0x1d41a, 0x1d42d), // mathematical bold
    cp(0x24d2, 0x24d0, 0x24e3), // circled letters
    'CÂT', 'ćàt', // accents
    'c' + cp(0x336) + 'a' + cp(0x336) + 't' + cp(0x336), // strike-through combining marks
    'c' + cp(0x300, 0x301, 0x302, 0x303, 0x304, 0x305, 0x306) + 'at', // a Zalgo stack
    'c' + cp(0x200b) + 'at', 'c' + cp(0x200d) + 'a' + cp(0x200c) + 't', 'ca' + cp(0xad) + 't', 'c' + cp(0x2060) + 'at', // zero-width and joiners, soft hyphen, word joiner
    cp(0x202e) + 'cat' + cp(0x202c), 'c' + cp(0xfe0f) + 'at', // direction override, variation selector
    cp(0x441) + 'at', // Cyrillic с among Latin letters
    cp(0x441, 0x430) + 't', // two Cyrillic look-alikes
  ];
  for (const t of forms) assert.equal(hits(list, t), 'cat', `“${t}” (${[...t].map((c) => c.codePointAt(0).toString(16)).join(' ')}) should match`);
  assert.equal(hits(list, 'naïve'), 'naive');
  assert.equal(hits(['naïve'], 'NAIVE'), 'naïve', 'the list is folded the same way as the text');
  // Letters with no decomposition read as their plain ones.
  assert.equal(hits(['strasse'], 'Straße'), 'strasse');
  assert.equal(hits(['lodz'], 'Łódź'), 'lodz');
  // A word entirely of look-alikes reads as Latin too…
  assert.equal(hits(['pop'], cp(0x440, 0x43e, 0x440)), 'pop');
  // …but a real Cyrillic word stays itself (and a Cyrillic entry matches it).
  assert.equal(hits(['cat'], 'кот'), null);
  assert.equal(hits(['привет'], 'Привет, мир'), 'привет');
  // Other scripts keep their marks: they're part of the spelling.
  assert.equal(hits(['काम'], 'यह काम है'), 'काम');
});

test('normalization: spelled-out letters and stretched letters, within reason', () => {
  const list = ['cat', 'god', 'book'];
  for (const t of ['c a t', 'C.A.T', 'c-a-t', 'c_a_t', 'you are c a t ok', 'c . a . t'])
    assert.equal(hits(list, t), 'cat', `“${t}” should match`);
  // Spelled out across a line break, or with a long gap, isn't a word.
  assert.equal(hits(list, 'c\na\nt'), null);
  assert.equal(hits(list, 'c      a      t'), null);
  // A letter stretched to three or more matches it written once or twice…
  for (const t of ['caaat', 'caaaaaaaaaaat', 'gooood', 'boooook']) assert.ok(hits(list, t), `“${t}” should match`);
  // …but a doubled letter isn't a stretched one: "god" doesn't catch "good", "book" doesn't catch "bok".
  assert.equal(hits(list, 'good'), null);
  assert.equal(hits(list, 'bok'), null);
  assert.equal(hits(['ass'], 'as'), null);
  assert.equal(hits(['ass'], 'class'), null);
  assert.equal(hits(['ass'], 'asssss'), 'ass');
});

test('lists: entries are checked and capped, the same entry kept once, mistakes reported', () => {
  const p = W.parseList('Cat\ncat\n  CAT  \n\nbig   dog, fox*\n');
  assert.deepEqual(p.entries, ['Cat', 'big dog', 'fox*']);
  assert.deepEqual(p.errors, []);
  const bad = {
    '*': /inside a word/, '***': /inside a word/, 'a': /At least 2/, 'a*': /At least 2/, '*a*': /At least 2/, '.*': /inside a word/, '!!!': /letters or numbers/,
    [`${'x'.repeat(61)}`]: /60 characters/, 'one two three four five six': /5 words/, '*a*b*c*d*e*': /4/, 'ok *': /inside a word/,
  };
  for (const [entry, why] of Object.entries(bad)) {
    const r = W.parseList([entry]);
    assert.deepEqual(r.entries, [], `“${entry}” is refused`);
    assert.match(r.errors[0].error, why, `“${entry}”: ${r.errors[0] && r.errors[0].error}`);
  }
  // Exactly at the limits is fine.
  assert.equal(W.parseList(['x'.repeat(60)]).entries.length, 1);
  assert.equal(W.parseList(['a b c d e']).entries.length, 1);
  assert.equal(W.parseList(['*ab*cd*ef*gh']).entries.length, 1);
  // At most LIMITS.entries entries; the rest are refused, not silently dropped.
  const many = W.parseList(Array.from({ length: W.LIMITS.entries + 5 }, (_, i) => `word${i}`));
  assert.equal(many.entries.length, W.LIMITS.entries);
  assert.equal(many.errors.length, 5);
  assert.match(many.errors[0].error, /up to 200/);
  // compile() ignores anything parseEntry refuses (a list edited by hand, or an old one) and never takes more.
  const m = W.compile(['*', 'a', ...Array.from({ length: 300 }, (_, i) => `w${i}x`)]);
  assert.equal(m.size, W.LIMITS.entries - 2);
  assert.equal(m.find('anything at all'), null);
  // The server checks a server's list by the same rules.
  assert.deepEqual(SERVER_LIMITS, { entries: 200, length: 60, words: 5, wildcards: 4, letters: 2 });
  for (const k of Object.keys(SERVER_LIMITS)) assert.equal(W.LIMITS[k], SERVER_LIMITS[k], k);
  for (const entry of Object.keys(bad)) assert.throws(() => cleanList([entry]), `the server refuses “${entry}” too`);
  assert.deepEqual(cleanList('Cat\ncat\n  big   dog , fox*'), ['Cat', 'big dog', 'fox*']);
});

test('hostile lists and texts: regex syntax is just text, nothing hangs, long text is cut', () => {
  // Characters that mean something to regular expressions are separators like any punctuation.
  const list = ['a.b', '(xy+)+', '[cat]', 'c\\d+', 'x|y z', '$$money$$', '.*', '^$'];
  const p = W.parseList(list);
  assert.deepEqual(p.entries, ['a.b', '(xy+)+', '[cat]', 'c\\d+', 'x|y z', '$$money$$'], `refused: ${JSON.stringify(p.errors)}`);
  assert.equal(p.errors.length, 2, '“.*” and “^$” have no letters to match');
  const m = W.compile(p.entries);
  assert.equal(m.find('aXb'), null, 'a dot is not "any character"');
  assert.equal(m.find('a b'), 'a.b', 'it separates words like a space');
  assert.equal(m.find('cat'), '[cat]');
  assert.equal(m.find('c d'), 'c\\d+');
  assert.equal(m.find('xy'), '(xy+)+');
  assert.equal(m.find('xyxy'), null, '+ repeats nothing');
  assert.equal(m.find('money'), '$$money$$');
  assert.equal(m.find('nothing here'), null);
  // The worst lists for a backtracking matcher, against the worst texts: still quick.
  const nasty = [
    W.compile(Array.from({ length: 200 }, (_, i) => `*a*a*a*a${i % 10}`)),
    W.compile(Array.from({ length: 200 }, (_, i) => `ab*ab*ab*ab${String.fromCharCode(97 + (i % 26))}`)),
    W.compile(Array.from({ length: 200 }, (_, i) => `aa*aa*aa a${i} b c d`)),
  ];
  const texts = ['a'.repeat(60000), 'ab'.repeat(30000), 'aaa '.repeat(15000), `${'a'.repeat(5000)}b `.repeat(10), 'c a '.repeat(12000)];
  const t0 = Date.now();
  for (const mm of nasty) for (const t of texts) mm.find(t);
  const took = Date.now() - t0;
  assert.ok(took < 5000, `15 worst cases took ${took} ms`);
  // Only the first LIMITS.text characters are looked at (more than any message the app sends).
  assert.equal(hits(['cat'], `${'x '.repeat(W.LIMITS.text / 2)} cat`), null);
  assert.equal(hits(['cat'], `${'x '.repeat(W.LIMITS.text / 2 - 10)} cat`), 'cat');
  // Anything at all can be passed without throwing.
  for (const junk of [null, undefined, 42, {}, [], 'x'.repeat(10)]) { W.compile(junk); W.parseList(junk); W.compile(['cat']).find(junk); }
});

test('what a message shows is checked: words, link previews, polls, bot cards, file names and descriptions', () => {
  const m = W.compile(['spoiler']);
  const t = (dec) => m.test(W.textOfMessage(dec));
  assert.equal(t({ t: 'nothing to see' }), false);
  assert.equal(t({ t: 'SPOILER alert' }), true);
  assert.equal(t({ t: 'see this', l: [{ url: 'https://example.org/x', title: 'Huge spoiler inside', desc: '', site: 'News' }] }), true, 'a link preview’s title');
  assert.equal(t({ t: 'see this', l: [{ url: 'https://example.org/x', title: 'News', desc: 'the spoiler is…', site: '' }] }), true, 'its description');
  assert.equal(t({ t: 'see this', l: [{ url: 'https://example.org/x', title: 'x', desc: '', site: 'Spoiler Weekly' }] }), true, 'its site name');
  assert.equal(t({ t: '', p: { q: 'Who wins?', o: ['me', 'spoiler'] } }), true, 'a poll option');
  assert.equal(t({ t: '', embed: { title: 'Feed', summary: 'big spoiler' } }), true, 'a bot’s card');
  assert.equal(t({ t: '', f: [{ name: 'spoiler.png' }] }), true, 'a file name');
  assert.equal(t({ t: 'hello', f: [{ name: 'cat.png', alt: 'a spoiler, sorry' }] }), true, 'a picture’s description (alt text)');
  assert.equal(t({ t: 'hello', f: [{ name: 'cat.png', alt: 'a cat on a rug' }] }), false);
  assert.equal(W.textOfMessage(null), '');
});

test('look-alikes: read alike in every word, so mixing scripts gets nowhere; an honest word in its own script stays itself', () => {
  // A Latin letter slipped into a Cyrillic or Greek word, or the other way round.
  assert.equal(hits(['пидор'], 'ты пидоp'), 'пидор', 'Latin p in a Cyrillic word');
  assert.equal(hits(['пидор'], 'ты пидoр'), 'пидор', 'Latin o in a Cyrillic word');
  assert.equal(hits(['хуй'], 'xуй'), 'хуй', 'Latin x');
  assert.equal(hits(['μαλάκας'], 'μαλάκaς'), 'μαλάκας', 'Latin a in a Greek word');
  assert.equal(hits(['cat'], 'my сat is here'), 'cat', 'Cyrillic с in a Latin word');
  assert.equal(hits(['cat'], 'my саt is here'), 'cat');
  // A word wholly of look-alikes is a disguise in English text…
  assert.equal(hits(['cat'], 'my сат is here'), 'cat');
  assert.equal(hits(['pop'], cp(0x440, 0x43e, 0x440)), 'pop');
  // …but not among other Russian words: these are ordinary words ("but", "how", "not", "mouth", "juice").
  for (const [list, text] of [[['ho'], 'Я пришёл, но его не было'], [['kak'], 'Привет, как дела?'], [['he'], 'Я не знаю'], [['pot'], 'Закрой рот'], [['coke'], 'Мясо в соке'], [['ha'], 'Он на работе']])
    assert.equal(hits(list, text), null, `${list[0]} in “${text}”`);
  // And the other way: Latin letters standing for a Cyrillic word count in Russian text, not in English.
  assert.equal(hits(['рот'], 'Закрой pot'), 'рот');
  assert.equal(hits(['рот'], 'I like pot'), null);
  assert.equal(hits(['cat'], 'кот'), null);
  assert.equal(hits(['привет'], 'Привет, мир'), 'привет');
});

test('fancy letters: small capitals and letters in black circles and squares fold too; flag letters stay flags', () => {
  for (const t of ['ᴄᴀᴛ', cp(0x1F172, 0x1F170, 0x1F183), cp(0x1F152, 0x1F150, 0x1F163), 'a ᴄᴀᴛ!']) assert.equal(hits(['cat'], t), 'cat', t);
  assert.equal(hits(['cat'], cp(0x1F1E8, 0x1F1E6, 0x1F1F9)), null, 'regional indicators are flags (🇨🇦), not letters');
});

test('spaceless scripts: Chinese, Japanese and Thai entries match inside a run of text', () => {
  assert.equal(hits(['傻逼'], '你是傻逼吗'), '傻逼');
  assert.equal(hits(['バカ'], 'お前はバカだ'), 'バカ');
  assert.equal(hits(['ควาย'], 'มึงมันควายจริงๆ'), 'ควาย');
  assert.equal(hits(['傻逼'], '你好'), null);
  // They don't count against the *'s an entry may have, and scripts with spaces keep whole words.
  assert.equal(W.parseList(['傻*逼*么*呢*']).entries.length, 1);
  assert.equal(W.parseList(['傻*逼*么*呢*吗*']).entries.length, 0);
  assert.equal(hits(['привет'], 'приветствую'), null);
});

test('formatting: the text is also read as it’s shown, so bold, italics, strike-through, code and spoilers in a word don’t hide it', () => {
  const m = W.compile(['cat', 'bad apple']);
  for (const t of ['c**at**', '**c**at', 'c*at*', 'c__at__', 'ca~~t~~', 'c`at`', 'c||at||', '**c**a**t**'])
    assert.equal(m.find(W.readings(t)), 'cat', `“${t}”`);
  assert.equal(m.find(W.readings('b**ad** apple')), 'bad apple');
  assert.equal(W.asShown('c**at** &amp; <b>'), 'cat &amp; <b>', 'what the text says, not HTML');
  // Lines and code blocks stay apart, and nothing new is joined up.
  assert.equal(m.find(W.readings('c\n**at**')), null);
  assert.equal(m.find(W.readings('```\nc\n```at')), null);
  assert.equal(m.find(W.readings('ca t **bold**')), null);
  assert.deepEqual(W.readings('plain text'), ['plain text'], 'plain text is read once');
  // Headings, small print, list items and quotes are lines of their own (no <br> around them): a word split by
  // formatting at the end of one is still caught, and two of them don't join into a word nobody sees.
  const n = W.compile(['idiot', 'shit']);
  for (const t of ['- i__d__iot\n- loser', '1. i__d__iot\n2. go', '* i**d**iot\n* fine', '# i__d__iot\nloser', '-# i*d*iot\nok',
    '> i__d__iot\nloser', '>>> a\ni__d__iot\nb', 'well\n- i__d__iot', '- i__d__iot\nloser'])
    assert.equal(n.find(W.readings(t)), 'idiot', `“${t}”`);
  for (const t of ['- *s*\n- hit', '- *s*\nhit', '*s*\n- hit', '# *s*\nhit', '> *s*\nhit', '1. *s*\n2. hit', '-# *s*\n# hit', '- ||s||\n- hit'])
    assert.equal(n.find(W.readings(t)), null, `“${t}”`);
  assert.equal(n.find(W.readings('- a *s*hit b\n- c')), 'shit', 'inside one list item, formatting still joins');
});

test('a doubled letter is another word (the trade-off for not catching good with god): stretched ones still match', () => {
  assert.equal(hits(['fuck', 'shit', 'cat'], 'fuuck shiit caat'), null);
  assert.equal(hits(['cat'], 'caaat'), 'cat');
  assert.equal(hits(['caat'], 'caat'), 'caat', 'that spelling can go on the list');
  assert.equal(hits(['ca*t'], 'caat'), 'ca*t', 'or a * covers it');
});

test('hostile lists and texts: the work for one message is bounded, and a message too costly to check counts as matching', () => {
  const alpha = 'cdefghijklmnopqrstuvwxyz';
  const tails = Array.from({ length: 200 }, (_, i) => alpha[i % 24] + alpha[Math.floor(i / 24) % 24]);
  const needs = tails.map((t) => 'ab'.repeat(28) + t);
  const longWord = (needs.join('') + 'ab'.repeat(20000)).slice(0, 44990) + 'q';
  const cases = [
    // Every entry valid (59 characters, one *), each text holding every entry's letters without matching any.
    [tails.map((t) => '*' + 'ab'.repeat(28) + t), longWord],
    [tails.map((t) => '*' + 'ab'.repeat(28) + t), needs.map((n) => n + 'ab'.repeat(80) + 'q').join(' ')],
    [tails.map((t) => '*' + 'ab'.repeat(13) + '*' + 'ab'.repeat(13) + '*ab' + t), longWord],
    [tails.map((t) => '*' + 'ab'.repeat(28) + t), Array.from({ length: 700 }, () => 'ab'.repeat(30)).join(' ') + ' ' + tails.map((t) => 'ab' + t).join('')],
    // Phrases whose first words fit everywhere.
    [tails.map((t) => `ab* ab* ab* ab* ab${t}`), Array.from({ length: 9000 }, () => 'abab').join(' ') + ' ' + tails.map((t) => 'ab' + t).join('')],
    [tails.map((t) => `ab ab ab ab ab${t}`), Array.from({ length: 9000 }, () => 'ab').join(' ') + ' ' + tails.map((t) => 'ab' + t).join('')],
    // Thousands of different short words, and formatting to read twice.
    [tails.map((t) => `*${t[0]}*${t[1]}*`), Array.from({ length: 14000 }, (_, i) => cp(0x4e00 + (i % 5000), 0x4e00 + ((i * 7) % 5000))).join(' ')],
    [tails.map((t) => '*' + 'ab'.repeat(28) + t), Array.from({ length: 700 }, () => '**ab**'.repeat(10)).join(' ')],
  ];
  for (const [list, text] of cases) {
    const m = W.compile(list);
    assert.equal(m.size, 200);
    m.find(W.readings(text)); // warmed up
    const t0 = performance.now();
    const r = m.find(W.readings(text));
    const took = performance.now() - t0;
    assert.ok(r === null || r === W.TOO_COSTLY, `no entry should match (${r})`);
    assert.ok(took < 400, `${list[0].slice(0, 20)}…: ${took.toFixed(0)} ms`);
  }
  // The phrases case runs out of budget: it's treated as matching (hidden, one click to show), not let through.
  assert.equal(W.compile(cases[4][0]).find(cases[4][1]), W.TOO_COSTLY);
  // An honest long message with a large, clumsy list (entries that are only two letters long) stays well inside it.
  const eng = 'the quick brown fox jumps over the lazy dog while people talk about classes, assets, titles and passing grades in history. **Bold** and _italics_ here';
  const short = ['as', 'it', 'he', 'th', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd', 'ti', 'es', 'or', 'te', 'of', 'ed', 'is', 'ar'];
  const clumsy = [...short.map((x) => `*${x}*x`), ...short.map((x) => `x*${x}*`), ...short.map((x) => `*${x}q*`), ...Array.from({ length: 140 }, (_, i) => `slur${i}*`)];
  assert.equal(W.compile(clumsy).find(W.readings(Array.from({ length: 400 }, () => eng).join('\n'))), null);
});

test('entries: invisible and direction characters are taken out (they could make an entry read as another), half characters refused', () => {
  assert.equal(W.cleanEntry(cp(0x202e) + 'emit'), 'emit');
  assert.equal(W.cleanEntry('dur' + cp(0x200b) + 'ian' + cp(0x2066)), 'durian');
  assert.equal(W.parseList(['a' + cp(0x3164)]).entries.length, 0, 'a filler character is no letter');
  assert.match(W.parseList(['qxx\uD800']).errors[0].error, /broken/);
});

test('lists: the server checks entries the way the app does', () => {
  const corpus = [
    'cat', 'Cat', 'a**b**c**d**e', 'ß', 'क्', 'का', 'a' + cp(0x3164), 'x' + cp(0xad) + 'y', cp(0x202e) + 'emit', 'qxx\uD800', '\uDC00ab',
    '*', '***', 'a', 'a*', '*a*', '.*', '!!!', 'x'.repeat(60), 'x'.repeat(61), 'one two three four five', 'one two three four five six',
    '*a*b*c*d*e*', '*ab*cd*ef*gh', 'ok *', 'ᴄᴀᴛ', cp(0x1F172, 0x1F170), 'ab' + cp(0x200d), 'ﬀ', 'ǆ', '傻逼', 'バカ', 'ควาย', 'пидор', 'μαλάκας',
    'c a t', '  spaced  out  ', 'a\tb', '١٢٣', 'é', 'ée', 'ŀl', 'ǅx', 'Ⅻ', '½', 'a' + cp(0x301), cp(0x301) + 'ab', 'a' + cp(0xfe0f) + 'b',
    cp(0x1d41c, 0x1d41a), '*' + cp(0x1d41c) + '*', 'ab**', '**ab', 'a*****b', 'ı', 'İ', 'ﬃ', 'ꜱꜱ',
  ];
  for (const e of corpus) {
    const app = W.parseList([e]);
    let server;
    try { server = cleanList([e]); } catch (err) { server = err; }
    const serverKept = Array.isArray(server) ? server : [];
    assert.deepEqual(serverKept, app.entries, `${JSON.stringify(e)}: app ${JSON.stringify(app)} server ${server.message || JSON.stringify(server)}`);
    assert.equal(!Array.isArray(server), app.errors.length > 0, `${JSON.stringify(e)} refused by one side only`);
    if (app.entries.length) assert.equal(W.compile(app.entries).size, 1, `${JSON.stringify(e)} kept, so it's used`);
  }
});

// ================================================================== the app side (wordfilter-app.js)
// Run in Node with the real matcher and the real vault encryption (e2ee.js); the page helpers are small fakes.
let A; let E;
async function loadApp() {
  if (A) return;
  const { register } = require('node:module');
  const fakes = {
    './util.js': 'export const h = () => ({}); export const clear = () => ({}); export const icon = () => ({}); export const toast = () => {};',
    './api.js': 'export const api = (...a) => globalThis.__wf.api(...a);',
  };
  const urls = Object.fromEntries(Object.entries(fakes).map(([k, src]) => [k, 'data:text/javascript,' + encodeURIComponent(src)]));
  register('data:text/javascript,' + encodeURIComponent(`const urls = ${JSON.stringify(urls)};
    export async function resolve(spec, ctx, next) {
      if (ctx.parentURL && ctx.parentURL.endsWith('/wordfilter-app.js') && urls[spec]) return { url: urls[spec], shortCircuit: true };
      return next(spec, ctx);
    }`));
  globalThis.window = { crypto: globalThis.crypto };
  E = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'e2ee.js')).href);
  A = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'wordfilter-app.js')).href);
}
async function appFor(servers) {
  await loadApp();
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey)).toString('base64');
  const S = { me: { id: 'me1', publicKey: pub }, servers };
  const stored = { data: null, updatedAt: 0, puts: [] };
  globalThis.__wf = {
    api: async (method, p, body) => {
      if (p !== '/me/word-filter') throw new Error('unexpected ' + p);
      if (method === 'GET') return { data: stored.data, updatedAt: stored.updatedAt };
      if (body.base !== stored.updatedAt) throw Object.assign(new Error('changed elsewhere'), { code: 'stale' });
      stored.puts.push(body.data);
      stored.data = body.data; stored.updatedAt += 1;
      return { updatedAt: stored.updatedAt };
    },
  };
  let changes = 0;
  const vk = E.vaultKey(kp.privateKey, pub);
  const wf = A.createWordFilter({ S, vaultKey: () => vk, serverOf: (m) => S.servers.find((s) => s.id === m.serverId) || null, onChange: () => { changes++; } });
  return { wf, S, stored, vk, changes: () => changes };
}

test('app: your list is sealed with your vault key, padded, and opens again on another device', async () => {
  const { wf, S, stored, vk } = await appFor([]);
  await wf.save({ words: ['kumquat*', 'durian'], action: 'blur' });
  const sealed = stored.data;
  assert.match(sealed, /^x1:/);
  // Look for the words where a leak would show them: verbatim in the short fields, and in the ciphertext's bytes.
  // (Searching the ciphertext's base64 text itself matched 'blur' by chance about once in a hundred runs.)
  const parts = sealed.split(':');
  assert.ok(parts.every((part, i) => (i === 2 ? !/kumquat|durian|blur/.test(Buffer.from(part, 'base64').toString('latin1')) : !/kumquat|durian|blur/i.test(part))), 'nothing readable in what the server stores');
  // Bound to this account and this kind of item: opened as anything else, it fails.
  const open = await E.openVault(await vk, 'wordfilter', 'me1', sealed);
  assert.deepEqual([open.words, open.action, open.off], [['kumquat*', 'durian'], 'blur', []]);
  await assert.rejects(E.openVault(await vk, 'wordfilter', 'someone-else', sealed));
  await assert.rejects(E.openVault(await vk, 'saved', 'me1', sealed));
  // Padded: a list of one short word and one of fifty look the same size.
  await wf.save({ words: ['ab'] });
  const small = stored.data.length;
  await wf.save({ words: Array.from({ length: 50 }, (_, i) => `longerword${i}`) });
  assert.equal(stored.data.length, small, 'list length doesn’t show in the ciphertext size');
  // Another device of the same account (same identity key) opens it; one with another key can't, and says so
  // (the list then counts as empty there) instead of throwing.
  const other = A.createWordFilter({ S, vaultKey: () => vk, serverOf: () => null });
  await other.load();
  assert.deepEqual(other.check({ authorId: 'x', dmId: 'd', dec: { t: 'a longerword7 here' } }), { action: 'blur', by: 'you' });
  const { wf: stranger } = await appFor([]);
  globalThis.__wf.api = async () => ({ data: stored.data, updatedAt: stored.updatedAt });
  await stranger.load();
  assert.equal(stranger.check({ authorId: 'x', dmId: 'd', dec: { t: 'a longerword7 here' } }), null);
});

test('app: never your own messages; your list everywhere; a server’s only in that server, unless you turn it off', async () => {
  const club = { id: 's1', kind: 'server', wordFilter: { words: ['durian'], action: 'blur', updatedAt: 1 } };
  const group = { id: 'g1', kind: 'group', wordFilter: { words: ['durian'], action: 'hide', updatedAt: 1 } };
  const { wf, changes } = await appFor([club, group]);
  const msg = (t, extra = {}) => ({ id: hex(4), authorId: 'them', serverId: 's1', channelId: 'c1', dec: { t }, ...extra });
  assert.deepEqual(wf.check(msg('fresh durian today')), { action: 'blur', by: 'server' });
  assert.equal(wf.check(msg('fresh durian today', { authorId: 'me1' })), null, 'your own message');
  assert.equal(wf.check(msg('fresh durian today', { dmId: 'd1', serverId: undefined })), null, 'a server’s list never applies in DMs');
  assert.equal(wf.check(msg('fresh durian today', { serverId: 'g1' })), null, 'group chats have no server list');
  assert.equal(wf.check(msg('mango')), null);
  assert.equal(wf.check({ authorId: 'them', dec: { error: true } }), null, 'nothing to check in what can’t be read');
  // Your own list applies everywhere, DMs included.
  const before = changes();
  await wf.save({ words: ['mango'] });
  assert.ok(changes() > before, 'what’s on screen is told to redraw');
  assert.deepEqual(wf.check(msg('a mango', { dmId: 'd1', serverId: undefined })), { action: 'hide', by: 'you' });
  assert.deepEqual(wf.check(msg('a mango', { serverId: 'g1' })), { action: 'hide', by: 'you' });
  // Both match: hiding wins over blurring.
  assert.deepEqual(wf.check(msg('mango and durian')), { action: 'hide', by: 'you' });
  await wf.save({ action: 'blur' });
  assert.deepEqual(wf.check(msg('mango and durian')), { action: 'blur', by: 'you' });
  club.wordFilter = { words: ['durian'], action: 'hide', updatedAt: 2 };
  assert.deepEqual(wf.check(msg('mango and durian')), { action: 'hide', by: 'server' }, 'a newer server list is used at once');
  // Turned off for yourself: that server's list stops applying, yours still does.
  await wf.save({ off: ['s1'] });
  assert.equal(wf.check(msg('durian')), null);
  assert.deepEqual(wf.check(msg('mango')), { action: 'blur', by: 'you' });
  assert.deepEqual(wf.exportable(), { words: ['mango'], action: 'blur', serversTurnedOff: ['s1'] });
  // "Show" is remembered for that message (until the page reloads).
  wf.reveal('m1');
  assert.equal(wf.isShown('m1'), true);
  assert.equal(wf.isShown('m2'), false);
});

test('app: a save that another device beat is refused and the newer list loaded', async () => {
  const { wf, stored } = await appFor([]);
  await wf.save({ words: ['alpha'] });
  stored.updatedAt += 5; // saved elsewhere meanwhile
  await assert.rejects(wf.save({ words: ['beta'] }), (e) => e.code === 'stale');
  await wf.save({ words: ['gamma'] });
  assert.deepEqual(wf.check({ authorId: 'x', dmId: 'd', dec: { t: 'gamma' } }), { action: 'hide', by: 'you' });
});

test('app: a save is made against the list its editor showed, so a change made on another device meanwhile is refused, not lost', async () => {
  const { wf: one, S, stored, vk } = await appFor([]);
  const two = A.createWordFilter({ S, vaultKey: () => vk, serverOf: () => null });
  await one.save({ words: ['tamarillo'] });
  await two.load();
  const shown = stored.updatedAt; // both devices' editors show this version
  await two.save({ words: ['tamarillo', 'rambutan'] }, { base: shown });
  await one.load(); // the live update reaches the first device; its open editor still shows the older list
  await assert.rejects(one.save({ words: ['tamarillo', 'durian'] }, { base: shown }), (e) => e.code === 'stale');
  assert.deepEqual(one.exportable().words, ['tamarillo', 'rambutan'], 'the other device’s change is still there');
  // A change that isn't from an editor (the action, a server's switch) goes on top of the latest list.
  await one.save({ action: 'blur' });
  assert.deepEqual([one.exportable().words, one.exportable().action], [['tamarillo', 'rambutan'], 'blur']);
});

test('app: a server that hands back an older copy of your list, or none, can’t quietly switch it off on a device that saw a newer one', async () => {
  const { S, stored, vk } = await appFor([]);
  const memory = () => { let v = null; return { get: () => v, set: (x) => { v = x; } }; };
  const dev = A.createWordFilter({ S, vaultKey: () => vk, serverOf: () => null, store: memory() });
  await dev.save({ words: ['mango'] });
  const first = stored.data;
  await dev.save({ words: ['mango', 'harasser-nick'] });
  const msg = { authorId: 'x', dmId: 'd', dec: { t: 'hi harasser-nick' } };
  const real = globalThis.__wf.api;
  // Rolled back to the first copy (with a newer-looking version), then dropped: the newer list still applies.
  for (const served of [{ data: first, updatedAt: 99 }, { data: null, updatedAt: 0 }]) {
    globalThis.__wf.api = async () => served;
    await dev.load();
    assert.deepEqual(dev.check({ ...msg, dec: { ...msg.dec } }), { action: 'hide', by: 'you' }, JSON.stringify(served).slice(0, 30));
  }
  // Saving puts it back, numbered past anything seen.
  globalThis.__wf.api = real;
  await dev.load();
  await dev.save({ action: 'blur' });
  const body = await E.openVault(await vk, 'wordfilter', 'me1', stored.data);
  assert.deepEqual([body.n, body.words, body.action], [3, ['mango', 'harasser-nick'], 'blur']);
  // A device that never saw the newer copy has nothing to compare with (the limit of this check).
  const fresh = A.createWordFilter({ S, vaultKey: () => vk, serverOf: () => null, store: memory() });
  globalThis.__wf.api = async () => ({ data: first, updatedAt: 5 });
  await fresh.load();
  assert.equal(fresh.check({ ...msg, dec: { ...msg.dec } }), null);
  globalThis.__wf.api = real;
});

test('app: news of this device’s own save, coming before its answer, loads nothing; another device’s, during a save, loads after it', async () => {
  const { wf } = await appFor([]);
  const on = {};
  wf.listen({ on: (ev, fn) => { on[ev] = fn; } });
  const real = globalThis.__wf.api;
  let gets = 0;
  const announcing = (shift) => async (method, p, body) => {
    if (method === 'GET') gets++;
    const r = await real(method, p, body);
    if (method === 'PUT') on['wordfilter:changed']({ updatedAt: r.updatedAt + shift });
    return r;
  };
  globalThis.__wf.api = announcing(0);
  await wf.save({ words: ['kiwi'] });
  assert.equal(gets, 0, 'its own save');
  globalThis.__wf.api = announcing(1);
  await wf.save({ words: ['kiwi', 'lime'] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gets, 1, 'a newer one is loaded once the save is done');
  globalThis.__wf.api = real;
});

test('app: what a message shows as formatted counts too', async () => {
  const { wf } = await appFor([]);
  await wf.save({ words: ['tamarillo*'] });
  assert.deepEqual(wf.check({ authorId: 'x', dmId: 'd', dec: { t: 'fresh ta**marillos** here' } }), { action: 'hide', by: 'you' });
  assert.deepEqual(wf.check({ authorId: 'x', dmId: 'd', dec: { t: 'see', l: [{ url: 'https://example.org', title: 'T||amarillo|| news', desc: '', site: '' }] } }), { action: 'hide', by: 'you' });
});

// ================================================================== the server
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const next = (s, ev, match = () => true, ms = 3000) => new Promise((r) => {
  const on = (x) => { if (!match(x)) return; clearTimeout(t); s.off(ev, on); r(x); };
  const t = setTimeout(() => { s.off(ev, on); r(null); }, ms);
  s.on(ev, on);
});
const P = { VIEW: 1, SEND: 2, MANAGE_MESSAGES: 1 << 5, MANAGE_SERVER: 1 << 13, VIEW_AUDIT_LOG: 1 << 19 };
async function club() {
  const owner = await srv.register(); const admin = await srv.register(); const mod = await srv.register(); const member = await srv.register(); const outsider = await srv.register();
  const server = (await as(owner, 'POST', '/servers', { name: 'Club ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const u of [admin, mod, member]) assert.equal((await as(u, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const adminRole = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Admins', permissions: P.MANAGE_SERVER | P.VIEW_AUDIT_LOG | P.VIEW | P.SEND })).json;
  const modRole = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Mods', permissions: P.MANAGE_MESSAGES | P.VIEW | P.SEND })).json;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${admin.id}/roles`, { roleIds: [adminRole.id] })).status, 200);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${mod.id}/roles`, { roleIds: [modRole.id] })).status, 200);
  return { owner, admin, mod, member, outsider, server };
}
const setList = (u, sid, body) => as(u, 'PUT', `/servers/${sid}/word-filter`, body);
const copyOf = async (u, sid) => (await as(u, 'GET', '/bootstrap')).json.servers.find((s) => s.id === sid);
const audit = async (u, sid) => (await as(u, 'GET', `/servers/${sid}/audit?action=word_filter_update`)).json;

test('server list: Manage Server sets it; members can read it; others can’t touch it', async () => {
  const { owner, admin, mod, member, outsider, server } = await club();
  assert.deepEqual((await as(member, 'GET', `/servers/${server.id}/word-filter`)).json, { words: [], action: 'hide', updatedAt: 0 });
  assert.equal((await copyOf(member, server.id)).wordFilter, null);
  // Manage Messages isn't enough: the list applies in every channel, like the server's settings.
  for (const u of [member, mod]) {
    const r = await setList(u, server.id, { words: ['durian'], action: 'hide' });
    assert.equal(r.status, 403, r.text);
  }
  assert.equal((await setList(outsider, server.id, { words: ['durian'] })).status, 404, 'not a member: no such server');
  assert.equal((await as(outsider, 'GET', `/servers/${server.id}/word-filter`)).status, 404);
  assert.equal((await srv.api('PUT', `/servers/${server.id}/word-filter`, { body: { words: ['durian'] } })).status, 401);
  // Someone with Manage Server (and the owner) can.
  let r = await setList(admin, server.id, { words: ['Durian', 'durian', 'stinky fruit', 'jack*'], action: 'blur' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.words, ['Durian', 'stinky fruit', 'jack*'], 'the same entry once');
  assert.equal(r.json.action, 'blur');
  // Every member's copy of the server carries it (it isn't secret), and GET answers the same.
  for (const u of [owner, mod, member]) assert.deepEqual((await copyOf(u, server.id)).wordFilter, r.json);
  assert.deepEqual((await as(member, 'GET', `/servers/${server.id}/word-filter`)).json, r.json);
  assert.equal(JSON.parse(srv.sql('SELECT word_filter FROM servers WHERE id = ?', server.id)[0].word_filter).words.length, 3);
  // The owner changes it; an empty list clears it.
  r = await setList(owner, server.id, { words: 'durian\nmango', action: 'hide' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.words, ['durian', 'mango']);
  r = await setList(owner, server.id, { words: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.words, []);
  assert.equal((await copyOf(member, server.id)).wordFilter, null);
  assert.equal(srv.sql('SELECT word_filter FROM servers WHERE id = ?', server.id)[0].word_filter, null);
});

test('server list: limits and bad input are refused with the entry and why', async () => {
  const { owner, server } = await club();
  const bad = [
    [{ words: ['*'] }, /inside a word/], [{ words: ['a'] }, /at least 2/], [{ words: ['x'.repeat(61)] }, /60 characters/],
    [{ words: ['one two three four five six'] }, /5 words/], [{ words: ['*a*b*c*d*e*'] }, /4/],
    [{ words: Array.from({ length: 201 }, (_, i) => `w${i}x`) }, /up to 200/], [{ words: [42] }, /text/], [{ words: { a: 1 } }, /list/],
    [{ words: 'x'.repeat(100001) }, /too long/], [{ words: ['y'.repeat(5000)] }, /60 characters/], [{ words: Array(3000).fill('ab') }, /up to 200/],
    [{ words: ['ok'], action: 'delete' }, /hide or blur/], [{ words: ['ok'], action: 7 }, /hide or blur/],
  ];
  for (const [body, why] of bad) {
    const r = await setList(owner, server.id, body);
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)}: ${r.status} ${r.text}`);
    assert.match(r.json.error, why);
  }
  assert.match((await setList(owner, server.id, { words: ['fine', '*'] })).json.error, /“\*”/, 'it says which entry');
  // Exactly 200 entries of 60 characters is fine.
  const full = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')}${'z'.repeat(57)}`);
  const r = await setList(owner, server.id, { words: full });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.words.length, 200);
  // Group chats have none.
  const friend = await srv.register();
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  await as(friend, 'POST', `/invites/${invite.code}/join`);
  const g = (await as(owner, 'POST', '/groups', { userIds: [friend.id] })).json;
  assert.ok(g && g.id, 'group made');
  assert.equal((await setList(owner, g.id, { words: ['durian'] })).status, 400);
  assert.equal((await as(owner, 'GET', `/servers/${g.id}/word-filter`)).status, 400);
  assert.equal((await copyOf(owner, g.id)).wordFilter, null);
});

test('server list: every change is in the audit log (added, removed, the action), and goes live to members', async () => {
  const { owner, admin, member, server } = await club();
  const s = await sock(member);
  let live = next(s, 'server:wordfilter', (x) => x.serverId === server.id);
  let r = await setList(admin, server.id, { words: ['durian', 'mango'], action: 'hide' });
  assert.equal(r.status, 200);
  assert.deepEqual(await live, { serverId: server.id, wordFilter: r.json });
  // The same list again changes nothing: no entry, no event.
  const quiet = next(s, 'server:wordfilter', (x) => x.serverId === server.id, 600);
  assert.equal((await setList(admin, server.id, { words: ['durian', 'mango'], action: 'hide' })).status, 200);
  assert.equal(await quiet, null);
  live = next(s, 'server:wordfilter', (x) => x.serverId === server.id);
  r = await setList(owner, server.id, { words: ['durian', 'kiwi'], action: 'blur' });
  assert.equal((await live).wordFilter.action, 'blur');
  live = next(s, 'server:wordfilter', (x) => x.serverId === server.id);
  await setList(owner, server.id, { words: [] });
  assert.deepEqual(await live, { serverId: server.id, wordFilter: null });

  const log = await audit(owner, server.id);
  assert.ok(log.actions.includes('word_filter_update'));
  const e = log.entries; // newest first
  assert.equal(e.length, 3, 'three changes, the no-op left out');
  assert.equal(e[2].actorId, admin.id);
  assert.deepEqual([e[2].detail.added, e[2].detail.removed, e[2].detail.count, e[2].detail.action], [['durian', 'mango'], [], 2, { from: null, to: 'hide' }]);
  assert.equal(e[1].actorId, owner.id);
  assert.deepEqual([e[1].detail.added, e[1].detail.removed, e[1].detail.action], [['kiwi'], ['mango'], { from: 'hide', to: 'blur' }]);
  assert.deepEqual([e[0].detail.added, e[0].detail.removed, e[0].detail.count], [[], ['durian', 'kiwi'], 0]);
  // Members without View Audit Log don't read it.
  assert.equal((await audit(member, server.id)).entries, undefined);
});

test('your own list: stored sealed, only for you, live to your other devices, never overwritten by a stale device', async () => {
  const alice = await srv.register(); const bob = await srv.register();
  assert.equal((await srv.api('GET', '/me/word-filter')).status, 401);
  assert.deepEqual((await as(alice, 'GET', '/me/word-filter')).json, { data: null, updatedAt: 0 });
  // Only sealed data: anything else is refused.
  for (const data of ['durian', 'x1:', 'x1:not base64!:x', { words: ['durian'] }, 5, 'x2:abc:def'])
    assert.equal((await as(alice, 'PUT', '/me/word-filter', { data })).status, 400, JSON.stringify(data));
  assert.equal((await as(alice, 'PUT', '/me/word-filter', { data: 'x1:' + 'A'.repeat(100000) + ':AAAA' })).status, 413);
  const other = await sock(alice);
  const live = next(other, 'wordfilter:changed');
  const sealed = 'x1:' + Buffer.from('iv-iv-iv-iv-').toString('base64') + ':' + Buffer.from('ciphertext').toString('base64');
  let r = await as(alice, 'PUT', '/me/word-filter', { data: sealed, base: 0 });
  assert.equal(r.status, 200, r.text);
  const v1 = r.json.updatedAt;
  assert.ok(v1 > 0);
  assert.equal((await live).updatedAt, v1, 'her other open apps hear about it');
  assert.deepEqual((await as(alice, 'GET', '/me/word-filter')).json, { data: sealed, updatedAt: v1 });
  assert.deepEqual((await as(bob, 'GET', '/me/word-filter')).json, { data: null, updatedAt: 0 }, 'each account sees only its own');
  // A device that last saw an older version is refused, so it can't undo a change made elsewhere.
  r = await as(alice, 'PUT', '/me/word-filter', { data: sealed, base: v1 - 1 });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'stale');
  r = await as(alice, 'PUT', '/me/word-filter', { data: sealed, base: v1 });
  assert.equal(r.status, 200);
  assert.ok(r.json.updatedAt > v1, 'versions only go up');
  assert.equal((await as(alice, 'PUT', '/me/word-filter', { data: sealed, base: 'x' })).status, 400);
  // null deletes it.
  r = await as(alice, 'PUT', '/me/word-filter', { data: null });
  assert.equal(r.status, 200);
  assert.equal((await as(alice, 'GET', '/me/word-filter')).json.data, null);
  // Deleting the account takes it away.
  await as(bob, 'PUT', '/me/word-filter', { data: sealed });
  assert.equal(srv.sql('SELECT COUNT(*) n FROM word_filters WHERE user_id = ?', bob.id)[0].n, 1);
  assert.equal((await as(bob, 'DELETE', '/me', { authKey: bob.authKey, confirm: bob.username })).status, 200);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM word_filters WHERE user_id = ?', bob.id)[0].n, 0);
});

test('server list: half characters are refused, invisible and direction characters taken out, and the audit entry says what changed', async () => {
  const { owner, admin, server } = await club();
  // Entries padded with half characters made the audit entry too long to keep, and it read as "cleared".
  const junk = Array.from({ length: 25 }, (_, i) => `q${String.fromCharCode(97 + (i % 26))}x` + '\uD800'.repeat(57));
  let r = await setList(admin, server.id, { words: ['durian', 'election', 'union', ...junk] });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /broken character/);
  r = await setList(admin, server.id, { words: [cp(0x202e) + 'emit', 'dur' + cp(0x200b) + 'ian', 'mango'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.words, ['emit', 'durian', 'mango'], 'shown as they match');
  const e = (await audit(owner, server.id)).entries[0];
  assert.deepEqual([e.detail.added, e.detail.count, e.detail.truncated], [['emit', 'durian', 'mango'], 3, undefined]);
});

test('audit: a detail too long to keep loses list items, never its counts or what it does now', () => {
  const { trimDetail } = require('../server/serveraudit');
  const long = Array.from({ length: 40 }, (_, i) => String(i).padEnd(400, 'x'));
  const json = trimDetail({ added: long, removed: ['a'], count: 40, action: { from: null, to: 'hide' } });
  assert.ok(json.length <= 8000, String(json.length));
  const d = JSON.parse(json);
  assert.deepEqual([d.count, d.action, d.removed, d.truncated], [40, { from: null, to: 'hide' }, ['a'], undefined]);
  assert.ok(d.added.length >= 1 && d.added.length < 25);
  assert.equal(d.added.length + d.addedMore, 40, 'how many more there were');
  // Short details are kept whole, as before.
  assert.deepEqual(JSON.parse(trimDetail({ added: ['x'], count: 1 })), { added: ['x'], count: 1 });
});

test('audit: an older entry whose details were cut never reads as clearing the list', async () => {
  const { register } = require('node:module');
  const fakes = {
    './util.js': 'export const h = (...a) => a; export const clear = (x) => x; export const icon = () => null; export const toast = () => {}; export const fmtStamp = String;',
    './api.js': 'export const api = async () => ({});',
    './ui.js': 'export const modal = () => ({}); export const field = () => null;',
    './perms.js': 'export const PERMS = {}; export const PERM_GROUPS = [];',
    './profile-ui.js': 'export const avatarEl = () => null;',
    './markdown.js': 'export const render = (x) => x;',
    './admin.js': 'export const CATEGORY_LABEL = {};',
  };
  const urls = Object.fromEntries(Object.entries(fakes).map(([k, src]) => [k, 'data:text/javascript,' + encodeURIComponent(src)]));
  register('data:text/javascript,' + encodeURIComponent(`const urls = ${JSON.stringify(urls)};
    export async function resolve(spec, ctx, next) {
      if (ctx.parentURL && ctx.parentURL.endsWith('/public/js/serveraudit.js') && urls[spec]) return { url: urls[spec], shortCircuit: true };
      return next(spec, ctx);
    }`));
  const { sentence } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'serveraudit.js')).href);
  const said = (detail) => sentence({ action: 'word_filter_update', actorId: 'u1', detail }, { u1: { displayName: 'Ann' } }).flat(3).filter((x) => typeof x === 'string').join('');
  assert.match(said({ truncated: true }), /changed the server’s suggested word filter \(details too long to keep\)/);
  assert.doesNotMatch(said({ truncated: true }), /cleared/);
  assert.match(said({ added: [], removed: ['durian'], count: 0 }), /cleared/);
  assert.match(said({ truncated: true, count: 3, added: ['a'], addedMore: 2 }), /changed the server’s suggested word filter \(3 entries\)/);
});

test('nothing the filter does reaches the server: no route takes what matched', async () => {
  // The only word filter routes are the four lists above; matching, "Show" and opting out of a server's list happen
  // in the app (the opt-out inside the sealed list).
  const routes = require('fs').readFileSync(path.join(ROOT, 'server', 'wordfilter.js'), 'utf8').match(/api\.(get|put|post|patch|delete)\('[^']+'/g);
  assert.deepEqual(routes, ["api.get('/me/word-filter'", "api.put('/me/word-filter'", "api.get('/servers/:id/word-filter'", "api.put('/servers/:id/word-filter'"]);
  const app = require('fs').readFileSync(path.join(ROOT, 'public', 'js', 'wordfilter-app.js'), 'utf8');
  assert.deepEqual([...new Set(app.match(/api\('(GET|PUT|POST|PATCH|DELETE)', [^,)]+/g))].sort(),
    ["api('GET', '/me/word-filter'", "api('PUT', '/me/word-filter'", "api('PUT', `/servers/${s.id}/word-filter`"].sort());
});
