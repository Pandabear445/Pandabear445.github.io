// Invite links that unfurl (server/invitepreview.js) and the words for sharing an invite (public/js/invite-share.js).
// What /invite/<code> and /api/invites/:code/preview show before anyone signs in: the same generic card for every
// code unless the server opted in and the link still works, escaped, noindex, limited per network; and the app's
// own page carrying the instance's name.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, newIp } = require('./helpers');

let srv; let owner; let member; let S; let code;
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const page = (p, opts = {}) => srv.call('GET', p, { ip: opts.ip || newIp(), headers: opts.headers });
const preview = (c, ip = newIp()) => srv.api('GET', `/invites/${c}/preview`, { ip });
const meta = (html, prop) => {
  const m = new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)">`).exec(html);
  return m ? m[1] : null;
};
const invite = async (u, sid, body = {}) => (await as(u, 'POST', `/servers/${sid}/invites`, body)).json.code;

before(async () => {
  srv = await startServer();
  owner = srv.owner;
  member = await srv.register('ana_zq');
  S = (await as(owner, 'POST', '/servers', { name: 'Quiet Pines' })).json;
  code = await invite(owner, S.id);
  assert.equal((await as(member, 'POST', `/invites/${code}/join`)).status, 200);
});
after(() => srv.stop());

test('off by default: every code gets the same generic card, byte for byte, and the JSON names no server', async () => {
  assert.equal(srv.sql('SELECT invite_preview FROM servers WHERE id = ?', S.id)[0].invite_preview, 0);
  const expired = await invite(owner, S.id, { expiresHours: 1 });
  srv.sql('UPDATE invites SET expires_at = 1 WHERE code = ?', expired);
  const unknown = await page('/invite/doesnotexist9');
  const pages = [unknown, await page(`/invite/${expired}`), await page(`/invite/${code}`), await page('/invite/%3Cscript%3E')];
  for (const r of pages) {
    assert.equal(r.status, 200);
    assert.equal(r.text, unknown.text, 'identical whatever the code');
    assert.ok(!r.text.includes('Quiet Pines'), 'an opted-out server’s name never appears');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
  }
  const html = unknown.text;
  assert.equal(meta(html, 'robots'), 'noindex');
  assert.equal(meta(html, 'og:title'), `You’re invited to a server on ${srv.config.name}`);
  assert.match(meta(html, 'og:description'), /end-to-end encrypted/);
  assert.equal(meta(html, 'og:site_name'), srv.config.name);
  assert.equal(meta(html, 'twitter:card'), 'summary');
  assert.equal(meta(html, 'og:image'), 'https://chat.example.test/icons/icon-512.png', 'the configured public address (PUBLIC_URL)');
  assert.match(html, /<title>You’re invited to a server on [^<]+<\/title>/);
  assert.equal((html.match(/<title>/g) || []).length, 1, 'one title');
  assert.match(html, /<script type="module" src="\/js\/app\.js"><\/script>/, 'still the app');
  for (const c of [code, expired, 'doesnotexist9']) {
    const r = await preview(c);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { instance: srv.config.name, server: null });
  }
});

test('only the server can opt in: Manage Server, not in group chats, true or false, and it’s in the audit log', async () => {
  assert.equal((await as(member, 'PATCH', `/servers/${S.id}`, { invitePreview: true })).status, 403, 'a member without Manage Server');
  assert.equal((await as(owner, 'PATCH', `/servers/${S.id}`, { invitePreview: 'yes' })).status, 400);
  const outsider = await srv.register();
  assert.notEqual((await as(outsider, 'PATCH', `/servers/${S.id}`, { invitePreview: true })).status, 200);
  await as(owner, 'POST', '/friends', { username: member.username });
  await as(member, 'POST', `/friends/${owner.id}/accept`);
  const g = (await as(owner, 'POST', '/groups', { userIds: [member.id], name: 'G' })).json;
  if (g && g.id) assert.equal((await as(owner, 'PATCH', `/servers/${g.id}`, { invitePreview: true })).status, 400, 'group chats have no invite links');
  assert.equal(srv.sql('SELECT invite_preview FROM servers WHERE id = ?', S.id)[0].invite_preview, 0);

  const r = await as(owner, 'PATCH', `/servers/${S.id}`, { invitePreview: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.invitePreview, true);
  const boot = (await as(member, 'GET', '/bootstrap')).json;
  assert.equal(boot.servers.find((x) => x.id === S.id).invitePreview, true, 'members see the setting');
  const log = (await as(owner, 'GET', `/servers/${S.id}/audit`)).json.entries;
  const e = log.find((x) => x.action === 'server_update' && (x.detail.changes || []).includes('invitePreview'));
  assert.ok(e, 'audited');
  assert.equal(e.detail.invitePreview, true);
  assert.equal(e.actorId, owner.id);
});

test('opted in: a working link names the server and its member count; expired, used-up and revoked links still don’t', async () => {
  const r = await page(`/invite/${code}`);
  assert.equal(meta(r.text, 'og:title'), `Join Quiet Pines on ${srv.config.name}`);
  assert.match(meta(r.text, 'og:description'), /^2 members · /);
  assert.equal(meta(r.text, 'robots'), 'noindex');
  assert.match(r.text, /<title>Join Quiet Pines on [^<]+<\/title>/);
  assert.deepEqual((await preview(code)).json, { instance: srv.config.name, server: { name: 'Quiet Pines', memberCount: 2 } });
  // Nothing else about the server: no icon, description, channels or member names.
  assert.equal(Object.keys((await preview(code)).json.server).sort().join(), 'memberCount,name');
  assert.ok(!r.text.includes(member.username) && !r.text.includes('/uploads/'));

  const generic = (await page('/invite/doesnotexist9')).text;
  const expired = await invite(owner, S.id, { expiresHours: 1 });
  srv.sql('UPDATE invites SET expires_at = 1 WHERE code = ?', expired);
  const used = await invite(owner, S.id, { maxUses: 1 });
  srv.sql('UPDATE invites SET uses = 1 WHERE code = ?', used);
  const revoked = await invite(owner, S.id, { maxUses: 5 });
  assert.equal((await as(owner, 'DELETE', `/invites/${revoked}`)).status, 200);
  for (const c of [expired, used, revoked]) {
    assert.equal((await page(`/invite/${c}`)).text, generic, `${c}: the generic card`);
    assert.equal((await preview(c)).json.server, null);
  }
  // Turned off again: back to the generic card at once.
  assert.equal((await as(owner, 'PATCH', `/servers/${S.id}`, { invitePreview: false })).status, 200);
  assert.equal((await page(`/invite/${code}`)).text, generic);
  assert.equal((await preview(code)).json.server, null);
  assert.equal((await as(owner, 'PATCH', `/servers/${S.id}`, { invitePreview: true })).status, 200);
});

test('a hostile server name is escaped everywhere (quotes, tags, ampersands, $& and control characters)', async () => {
  const name = '"><script>alert(1)</script> & \'q\' $& $1\u202e\u0007';
  const evil = (await as(owner, 'POST', '/servers', { name })).json;
  assert.equal((await as(owner, 'PATCH', `/servers/${evil.id}`, { invitePreview: true })).status, 200);
  const c = await invite(owner, evil.id);
  const html = (await page(`/invite/${c}`)).text;
  assert.ok(!html.includes('<script>alert(1)'), 'no tag from the name');
  assert.equal((html.match(/<script/g) || []).length, 2, 'only the app’s own two scripts');
  const t = meta(html, 'og:title');
  assert.equal(t, `Join &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;q&#39; $&amp; $1 on ${srv.config.name}`);
  assert.ok(!/[\u202e\u0007]/.test(html), 'control and direction characters dropped');
  assert.equal((html.match(/<title>/g) || []).length, 1);
  // The JSON is JSON: the app shows it as text.
  assert.equal((await preview(c)).json.server.name, name);
  // Long text is cut to whole characters (never half an emoji), with an ellipsis, and half a character is dropped.
  const { esc } = require('../server/invitepreview');
  const cut = esc('\u{1F332}'.repeat(200), 120);
  assert.equal([...cut].length, 120);
  assert.ok(cut.isWellFormed() && cut.endsWith('\u2026'));
  assert.equal(esc('a\ud83c'), 'a');
});

test('limited per network: the JSON says 429, the page quietly shows the generic card; other networks are unaffected', async () => {
  const ip = newIp();
  let refused = 0;
  for (let i = 0; i < 61; i++) if ((await preview(code, ip)).status === 429) refused++;
  assert.equal(refused, 1, 'the 61st in a minute');
  // The page shares the allowance and never refuses: past it, nothing is looked up.
  const r = await page(`/invite/${code}`, { ip });
  assert.equal(r.status, 200);
  assert.equal(meta(r.text, 'og:title'), `You’re invited to a server on ${srv.config.name}`);
  const elsewhere = await page(`/invite/${code}`);
  assert.equal(meta(elsewhere.text, 'og:title'), `Join Quiet Pines on ${srv.config.name}`);
  // And the other way round: a page flood uses up the JSON's allowance too.
  const ip2 = newIp();
  for (let i = 0; i < 60; i++) await page(`/invite/x${i}`, { ip: ip2 });
  assert.equal((await preview(code, ip2)).status, 429);
});

test('the app’s own page carries the instance’s name and tagline, escaped; a forged Host header changes nothing', async () => {
  const home = await page('/');
  assert.equal(home.status, 200);
  assert.equal(meta(home.text, 'og:title'), srv.config.name);
  assert.equal(meta(home.text, 'og:site_name'), srv.config.name);
  assert.equal(meta(home.text, 'robots'), null, 'the instance’s own page isn’t noindex');
  assert.match(home.text, /<link rel="stylesheet" href="\/css\/app\.css">/);
  const forged = await page('/', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
  assert.equal(meta(forged.text, 'og:image'), 'https://chat.example.test/icons/icon-512.png');
  assert.ok(!forged.text.includes('evil.example'));
  const inv = await page('/invite/abc12345', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
  assert.ok(!inv.text.includes('evil.example'));
  // Renamed with markup in the name and tagline: escaped, on /, /index.html and the app's other addresses.
  const set = await as(owner, 'PUT', '/admin/owner', { brand: { name: 'Pine "&" <Den>', tagline: 'Cozy <b>chat</b> & more' } });
  assert.equal(set.status, 200, set.text);
  for (const p of ['/', '/index.html', '/channels/whatever']) {
    const r = await page(p);
    assert.equal(meta(r.text, 'og:title'), 'Pine &quot;&amp;&quot; &lt;Den&gt;', p);
    assert.equal(meta(r.text, 'og:description'), 'Cozy &lt;b&gt;chat&lt;/b&gt; &amp; more', p);
    assert.ok(!r.text.includes('<Den>') && !r.text.includes('<b>chat'), p);
  }
  // Still sent compressed to browsers that ask (and the same page underneath).
  const zipped = await fetch(srv.base + '/', { headers: { 'accept-encoding': 'gzip', 'x-forwarded-for': newIp() } });
  assert.equal(zipped.headers.get('content-encoding'), 'gzip');
  assert.equal(meta(await zipped.text(), 'og:title'), 'Pine &quot;&amp;&quot; &lt;Den&gt;');
  await as(owner, 'PUT', '/admin/owner', { brand: { name: '', tagline: '' } });
});

// ------------------------------------------------------------------ the app's side (no browser needed)
const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;
test('invite-share.js: the messages carry the link, the real expiry and what signing up takes; share only where there is a share sheet', async () => {
  const I = await import(js('invite-share.js'));
  const link = 'https://chat.example.test/invite/AbCd2345';
  const msg = I.inviteMessage({ serverName: 'Quiet Pines', link, instance: 'Kappa' });
  assert.ok(msg.includes(link) && msg.includes('Quiet Pines') && msg.includes('Kappa'));
  assert.match(msg, /end-to-end encrypted/);
  assert.ok(!msg.includes(`${link}.`), 'no full stop glued to the link');
  assert.ok(!I.inviteMessage({ serverName: 'Quiet Pines', link: null, instance: 'Kappa' }).includes('http'), 'the share sheet carries the link itself');
  assert.match(I.movingMessage({ link, hours: 720 }), new RegExp(`${link.replace(/[/.]/g, '\\$&')} \\(link expires in 30 days\\)$`));
  assert.match(I.movingMessage({ link, hours: 168 }), /expires in 7 days\)$/);
  assert.match(I.movingMessage({ link, hours: 1 }), /expires in 1 hour\)$/);
  assert.ok(I.movingMessage({ link, hours: 0 }).endsWith(link), 'never: nothing about expiry');
  // The words follow how the instance lets new people in, and never promise a sign-up that isn't there.
  assert.equal(I.signUpMode({ registrationOpen: true, registrationRequiresCode: false }), 'open');
  assert.equal(I.signUpMode({ registrationOpen: true, registrationRequiresCode: true }), 'code');
  assert.equal(I.signUpMode({ registrationOpen: false, registrationRequiresCode: false }), 'closed');
  assert.equal(I.signUpMode({}), 'closed', 'unclear counts as closed');
  assert.equal(I.signUpMode(null), 'closed');
  const open = I.inviteMessage({ serverName: 'Quiet Pines', link, instance: 'Kappa', mode: 'open' });
  assert.equal(open, msg, 'open is the default');
  assert.match(open, /You’ll make an account on Kappa first\.$/);
  assert.doesNotMatch(open, /sign-up code|already have/);
  const coded = I.inviteMessage({ serverName: 'Quiet Pines', link, instance: 'Kappa', mode: 'code' });
  assert.ok(coded.includes(link) && coded.includes('Quiet Pines'));
  assert.match(coded, /sign-up code: ask me for it\.$/);
  const closed = I.inviteMessage({ serverName: 'Quiet Pines', link, instance: 'Kappa', mode: 'closed' });
  assert.ok(closed.includes(link));
  assert.match(closed, /account you already have on Kappa/);
  assert.doesNotMatch(closed, /make an account/, 'closed: no promise of a new account');
  assert.match(I.inviteMessage({ serverName: 'Quiet Pines', link: null, instance: 'Kappa', mode: 'code' }), /sign-up code/, 'the share sheet text says it too');
  // The dialog's line: open, a code (send it separately; where to find it only for those who manage sign-ups), closed.
  assert.equal(I.joinNote({ serverName: 'Quiet Pines', instance: 'Kappa' }), 'New people make an account on Kappa first, then land right in Quiet Pines.');
  const codeNote = I.joinNote({ serverName: 'Quiet Pines', instance: 'Kappa', mode: 'code' });
  assert.match(codeNote, /sign-up code/);
  assert.match(codeNote, /Send them the code separately/);
  assert.match(codeNote, /Whoever runs Kappa has it\.$/);
  assert.match(I.joinNote({ serverName: 'Quiet Pines', instance: 'Kappa', mode: 'code', manages: true }), /Admin → Registration & Terms\.$/);
  const closedNote = I.joinNote({ serverName: 'Quiet Pines', instance: 'Kappa', mode: 'closed' });
  assert.match(closedNote, /only people who already have an account here can join\.$/);
  assert.doesNotMatch(closedNote, /make an account|Admin/);
  assert.match(I.joinNote({ serverName: 'Quiet Pines', instance: 'Kappa', mode: 'closed', manages: true }), /open sign-ups in Admin → Registration & Terms/);
  // The moving announcement: the same, before the link, which stays last.
  const movingCode = I.movingMessage({ link, hours: 720, mode: 'code', instance: 'Kappa' });
  assert.match(movingCode, /sign-up code, so ask me for it\./);
  assert.ok(movingCode.endsWith(`${link} (link expires in 30 days)`));
  const movingClosed = I.movingMessage({ link, hours: 0, mode: 'closed', instance: 'Kappa' });
  assert.match(movingClosed, /already have an account on Kappa/);
  assert.ok(movingClosed.endsWith(link));
  assert.equal(I.movingMessage({ link, hours: 168, mode: 'open', instance: 'Kappa' }), I.movingMessage({ link, hours: 168 }));
  assert.equal(I.canShare({ nav: {} }), false, 'no navigator.share: no Share button');
  assert.equal(I.canShare({ nav: { share: () => {} } }), true);
  assert.equal(I.canShare({ nav: { share: () => {} }, desktop: true }), false);
  assert.equal(I.canShare({ nav: { share: () => {} }, android: true }), false);
});

test('invite-share.js: the “just you here” card, and dismissals kept per server even when storage fails', async () => {
  const I = await import(js('invite-share.js'));
  const solo = { id: 's1', kind: 'server', memberIds: ['me'] };
  assert.equal(I.nudgeWanted(solo, { canInvite: true, dismissed: false }), true);
  assert.equal(I.nudgeWanted({ ...solo, memberIds: ['me', 'you'] }, { canInvite: true }), false, 'gone once someone joins');
  assert.equal(I.nudgeWanted(solo, { canInvite: false }), false);
  assert.equal(I.nudgeWanted({ ...solo, kind: 'group' }, { canInvite: true }), false);
  assert.equal(I.nudgeWanted(solo, { canInvite: true, dismissed: true }), false);
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  assert.equal(I.nudgeDismissed('s1', store), false);
  I.dismissNudge('s1', store);
  assert.equal(I.nudgeDismissed('s1', store), true);
  assert.equal(I.nudgeDismissed('s2', store), false);
  for (let i = 0; i < 250; i++) I.dismissNudge(`x${i}`, store);
  assert.ok(JSON.parse(mem.get('hearth.inviteNudgeDismissed')).length <= 200, 'bounded');
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(I.nudgeDismissed('s1', broken), false);
  assert.doesNotThrow(() => I.dismissNudge('s1', broken));
  mem.set('hearth.inviteNudgeDismissed', '{"not":"a list"}');
  assert.equal(I.nudgeDismissed('s1', store), false);
});
