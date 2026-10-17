// Message formatting, the app's side (public/js/markdown.js): #channel mentions, Discord's line formatting
// (headings, small print, lists, >>> quotes) and <t:…> timestamps. The module runs here as it is (no browser).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis.window || { crypto: globalThis.crypto };

const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;
let MD;
// The channels this reader can see (the app's resolver looks in its own server list, which holds only those).
const CHANNELS = {
  '0mfr2k3ab1c2d3e4f5': { name: 'rules', type: 'text', serverId: 'srv0000001' },
  '0mfr2k3ab1c2d3e4f6': { name: '<script>alert(1)</script>', type: 'text', serverId: 'srv0000001' },
  '0mfr2k3ab1c2d3e4f7': { name: 'Lounge', type: 'voice', serverId: 'srv0000001' },
};
before(async () => {
  MD = await import(js('markdown.js'));
  MD.setResolvers({ channel: (id) => CHANNELS[id] || null, role: (id) => (id === 'role000001' ? { name: 'mods', color: '' } : null) });
});
const md = (t, o) => MD.render(t, o);

test('a channel the reader can see becomes a link with its id and server, its name escaped', () => {
  const out = md('Read <#0mfr2k3ab1c2d3e4f5> first');
  assert.match(out, /^Read <a class="mention channel-mention" href="#c\/0mfr2k3ab1c2d3e4f5" data-channel="0mfr2k3ab1c2d3e4f5" data-server="srv0000001">#rules<\/a> first$/);
  const bad = md('<#0mfr2k3ab1c2d3e4f6>');
  assert.ok(!bad.includes('<script>'), bad);
  assert.ok(bad.includes('#&lt;script&gt;alert(1)&lt;/script&gt;</a>'), bad);
  const voice = md('<#0mfr2k3ab1c2d3e4f7>');
  assert.match(voice, /data-channel="0mfr2k3ab1c2d3e4f7"/);
  assert.match(voice, /aria-label="Lounge \(voice channel\)"/);
  assert.match(voice, /<span class="ic"><svg[^]*<\/svg><\/span>Lounge<\/a>$/, 'a voice channel shows the speaker, not a #');
});

test('a channel the reader can’t see (or that is gone) is plain text, with no link and no name', () => {
  const out = md('see <#0zzzzzzzzzzzzzzzzz> now');
  assert.equal(out, 'see <span class="channel-unknown">#unknown-channel</span> now');
  assert.ok(!/<a|data-channel/.test(out));
  assert.equal(md('<#0zzzzzzzzzzzzzzzzz>', { inline: true }), '#unknown-channel');
  assert.equal(md('<#AB>'), '&lt;#AB&gt;', 'not an id: left as typed');
});

test('channel tokens inside code stay as typed', () => {
  assert.equal(md('`<#0mfr2k3ab1c2d3e4f5>`'), '<code class="md-code">&lt;#0mfr2k3ab1c2d3e4f5&gt;</code>');
  const block = md('```\n<#0mfr2k3ab1c2d3e4f5>\n```');
  assert.ok(block.startsWith('<pre class="md-pre"><code>&lt;#0mfr2k3ab1c2d3e4f5&gt;'), block);
  assert.ok(!block.includes('data-channel'));
});

test('on one line (replies, thread cards, previews) a channel is plain #name, never a link', () => {
  assert.equal(md('in <#0mfr2k3ab1c2d3e4f5>', { inline: true }), 'in #rules');
  assert.equal(md('<#0mfr2k3ab1c2d3e4f6>', { inline: true }), '#&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('a server’s welcome text links #names of channels the reader can see, outside code', () => {
  const chans = [{ id: '0mfr2k3ab1c2d3e4f5', name: 'rules' }];
  assert.equal(MD.linkChannelNames('Read **#rules** and say hi in #general.', chans), 'Read **<#0mfr2k3ab1c2d3e4f5>** and say hi in #general.');
  assert.equal(MD.linkChannelNames('#Rules first', chans), '<#0mfr2k3ab1c2d3e4f5> first');
  assert.equal(MD.linkChannelNames('`#rules` and ```\n#rules\n```', chans), '`#rules` and ```\n#rules\n```');
  assert.equal(MD.linkChannelNames('#rules-two a#rules # rules', chans), '#rules-two a#rules # rules');
  assert.match(md(MD.linkChannelNames('Read **#rules**', chans)), /^Read <strong><a class="mention channel-mention"[^>]*>#rules<\/a><\/strong>$/);
});

test('readableText puts mentions, emoji and timestamps into words for notifications and previews', () => {
  assert.equal(MD.readableText('go to <#0mfr2k3ab1c2d3e4f5> or <#0zzzzzzzzzzzzzzzzz>, ask <@&role000001> <:blob:emoji00001>'),
    'go to #rules or #unknown-channel, ask @mods :blob:');
  assert.ok(!/<t:/.test(MD.readableText('at <t:1700000000:D>')));
});

test('headings, small print and lists become blocks, with the rest of the formatting inside', () => {
  assert.equal(md('# Rules'), '<span class="md-h1">Rules</span>');
  assert.equal(md('## Two'), '<span class="md-h2">Two</span>');
  assert.equal(md('### **Three**'), '<span class="md-h3"><strong>Three</strong></span>');
  assert.equal(md('#### Four'), '#### Four', 'only three levels, like Discord');
  assert.equal(md('-# small print'), '<span class="md-sub">small print</span>');
  assert.equal(md('- one\n* two *really*\n- three'),
    '<span class="md-li">one</span><span class="md-li">two <em>really</em></span><span class="md-li">three</span>');
  assert.equal(md('1. first\n1. second\n5. third'),
    '<span class="md-li md-ol" data-n="1">first</span><span class="md-li md-ol" data-n="2">second</span><span class="md-li md-ol" data-n="3">third</span>',
    'a numbered list counts on from its first number');
  assert.equal(md('3. starts at three'), '<span class="md-li md-ol" data-n="3">starts at three</span>');
  assert.equal(md('- top\n  - nested'), '<span class="md-li">top</span><span class="md-li md-lv1">nested</span>');
});

test('blocks need a space after the marker, so #channel names, #1 and hashtags stay text', () => {
  assert.equal(md('#general is here'), '#general is here');
  assert.equal(md('#1 fan'), '#1 fan');
  assert.equal(md('#'), '#');
  assert.equal(md('-#nope'), '-#nope');
  assert.equal(md('-not a list'), '-not a list');
  assert.equal(md('2024. A year'), '2024. A year');
  assert.equal(md('# '), '# ', 'a heading needs words');
  assert.equal(md('Read <#0mfr2k3ab1c2d3e4f5> and #general'),
    'Read <a class="mention channel-mention" href="#c/0mfr2k3ab1c2d3e4f5" data-channel="0mfr2k3ab1c2d3e4f5" data-server="srv0000001">#rules</a> and #general');
});

test('quotes: > quotes one line, >>> the rest of the message', () => {
  assert.equal(md('> one\nnot quoted'), '<span class="md-quote">one</span>not quoted');
  assert.equal(md('before\n>>> all\nof\n\nthis'),
    'before<span class="md-quote">all</span><span class="md-quote">of</span><span class="md-quote"></span><span class="md-quote">this</span>');
  assert.equal(md('>>> # Big'), '<span class="md-quote"><span class="md-h1">Big</span></span>');
  assert.equal(md('>> not a quote'), '&gt;&gt; not a quote');
});

test('line breaks: none next to a block, but a typed blank line stays', () => {
  assert.equal(md('# Title\nText'), '<span class="md-h1">Title</span>Text');
  assert.equal(md('# Title\n\nText'), '<span class="md-h1">Title</span><br>Text');
  assert.equal(md('Text\n# Title'), 'Text<span class="md-h1">Title</span>');
  assert.equal(md('Text\n\n# Title'), 'Text<br><br><span class="md-h1">Title</span>');
  assert.equal(md('a\nb\n\nc'), 'a<br>b<br><br>c', 'plain lines as before');
});

test('markers inside code blocks are left alone', () => {
  const out = md('```\n# not a heading\n- not a list\n>>> nor a quote\n```');
  assert.equal(out, '<pre class="md-pre"><code># not a heading\n- not a list\n&gt;&gt;&gt; nor a quote</code></pre>');
  assert.equal(md('`# code`'), '<code class="md-code"># code</code>');
});

test('escaping holds inside blocks', () => {
  assert.equal(md('# <b>hi</b>'), '<span class="md-h1">&lt;b&gt;hi&lt;/b&gt;</span>');
  assert.equal(md('- <img src=x onerror=alert(1)>'), '<span class="md-li">&lt;img src=x onerror=alert(1)&gt;</span>');
  assert.equal(md('1. "quoted" & \'single\''), '<span class="md-li md-ol" data-n="1">&quot;quoted&quot; &amp; &#39;single&#39;</span>');
});

test('on one line the markers go: headings, small print and quotes lose them, bullets become dots', () => {
  assert.equal(md('# Rules\n-# fine print\n- one\n* two\n1. step\n> quoted\n>>> rest', { inline: true }),
    'Rules fine print \u2022 one \u2022 two 1. step quoted rest');
  assert.ok(!md('# <b>x</b>', { inline: true }).includes('<b>'));
});

test('timestamps show in the reader’s time zone, as a <time> with the exact moment', () => {
  const out = md('Game night <t:1700000000:F>');
  assert.match(out, /^Game night <time class="md-time" datetime="2023-11-14T22:13:20\.000Z" title="[^"<>]+">[^<]+<\/time>$/);
  assert.equal(MD.formatStamp(1700000000, 'R', 1700000000 * 1000 + 3 * 86400000), '3 days ago');
  assert.equal(MD.formatStamp(1700000000, 'R', 1700000000 * 1000 - 2 * 3600000), 'in 2 hours');
  assert.equal(MD.formatStamp(9999999999999), null, 'past the last date a clock can show');
  assert.equal(md('<t:9999999999999>'), '&lt;t:9999999999999&gt;');
  assert.equal(md('`<t:1700000000>`'), '<code class="md-code">&lt;t:1700000000&gt;</code>');
  assert.ok(!md('<t:1700000000:R>', { inline: true }).includes('<time'));
});

test('big emoji are unchanged by the new formatting', () => {
  assert.equal(MD.isJumbo('\u{1F600}\u{1F600}'), true);
  assert.equal(MD.isJumbo('# \u{1F600}'), false);
  assert.equal(MD.isJumbo('- \u{1F600}'), false);
});
