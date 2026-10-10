// Client-side hardening: profile pages, people lists, profile-write floods, shared looks, watch-together
// frames, the desktop app (update signing, which pages count as "ours", permissions, the screen picker) and
// the Android bridge. The desktop and Android apps can't be built here, so their security logic lives in small
// plain modules (desktop/origin.js, permissions.js, update-verify.js, mobile/native/BridgePolicy.java) that are
// tested directly, plus checks that main.js / MainActivity.java actually use them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { startServer, newIp, sleep } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const DAY = 86400000;

let srv;
const as = (u, method, p, body, ip) => srv.api(method, p, { token: u.token, ip: ip || u.ip, body });
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

// Collects user:update events per user id on a live connection.
async function listener(user) {
  const s = await srv.socket(user.token);
  const got = [];
  s.on('user:update', (u) => got.push(u));
  return { s, got, for: (id) => got.filter((u) => u && u.id === id) };
}
async function shareServer(owner, ...others) {
  const server = (await as(owner, 'POST', '/servers', { name: `s${crypto.randomBytes(3).toString('hex')}` })).json;
  const { code } = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const o of others) assert.equal((await as(o, 'POST', `/invites/${code}/join`)).status, 200);
  return server;
}
async function befriend(a, b) {
  assert.equal((await as(a, 'POST', '/friends', { username: b.username })).status, 200);
  assert.equal((await as(b, 'POST', `/friends/${a.id}/accept`)).status, 200);
}

// ------------------------------------------------------------------ xss-2: lastSeen
test('xss-2: lastSeen is day-only, and hidden while invisible or when either side has blocked the other', async () => {
  const alice = await srv.register(); const bob = await srv.register(); const carol = await srv.register(); const dave = await srv.register();
  await shareServer(alice, carol);
  await befriend(alice, carol);
  assert.equal((await as(alice, 'PATCH', '/me/profile', { topFriends: [carol.id] })).status, 200);
  await as(alice, 'GET', `/users/${alice.id}`, undefined, newIp()); // a fresh last_seen_at
  const sock = await srv.socket(alice.token);
  try {
    // legit use: a stranger and a co-member see the day, never the exact time
    let page = await as(bob, 'GET', `/users/${alice.id}/page`);
    assert.equal(page.status, 200);
    assert.equal(typeof page.json.lastSeen, 'number');
    assert.equal(page.json.lastSeen % DAY, DAY / 2, 'rounded to the day (noon UTC)');
    assert.ok(Math.abs(page.json.lastSeen - Date.now()) <= DAY);
    assert.deepEqual(page.json.topFriends.map((f) => f.id), [carol.id]);
    let people = (await as(carol, 'GET', '/people')).json.people.find((p) => p.id === alice.id);
    assert.equal(people.lastSeen % DAY, DAY / 2);

    // invisible: nothing, even though she's active right now
    assert.equal((await as(alice, 'PATCH', '/me/status', { status: 'invisible' })).status, 200);
    await as(alice, 'GET', `/users/${alice.id}`, undefined, newIp());
    page = await as(bob, 'GET', `/users/${alice.id}/page`);
    assert.equal(page.json.lastSeen, null, 'invisible: no lastSeen on the page');
    people = (await as(carol, 'GET', '/people')).json.people.find((p) => p.id === alice.id);
    assert.equal(people.presence, 'offline');
    assert.equal(people.lastSeen, 0, 'invisible: no lastSeen in People');

    // blocked: alice blocks bob, and dave blocks alice
    assert.equal((await as(alice, 'PATCH', '/me/status', { status: 'online' })).status, 200);
    assert.equal((await as(alice, 'POST', `/blocks/${bob.id}`)).status, 200);
    page = await as(bob, 'GET', `/users/${alice.id}/page`);
    assert.equal(page.status, 200);
    assert.equal(page.json.lastSeen, null, 'blocked viewer: no lastSeen');
    assert.deepEqual(page.json.topFriends, [], 'blocked viewer: no top friends');
    assert.deepEqual(page.json.comments, []);
    assert.equal((await as(dave, 'POST', `/blocks/${alice.id}`)).status, 200);
    assert.equal((await as(dave, 'GET', `/users/${alice.id}/page`)).json.lastSeen, null, 'blocked the other way round too');
    // carol (not blocked) still sees it all
    page = await as(carol, 'GET', `/users/${alice.id}/page`);
    assert.equal(page.json.lastSeen % DAY, DAY / 2);
    assert.deepEqual(page.json.topFriends.map((f) => f.id), [carol.id]);
  } finally { sock.close(); }
});

// ------------------------------------------------------------------ xss-5: profile writes
test('xss-5: profile updates reach co-members and friends once (coalesced), never unrelated people', async () => {
  const mallory = await srv.register(); const member = await srv.register(); const friend = await srv.register(); const stranger = await srv.register();
  await shareServer(mallory, member);
  await befriend(friend, mallory);
  const [m, f, s, self] = await Promise.all([listener(member), listener(friend), listener(stranger), listener(mallory)]);
  try {
    await sleep(1200); // connecting sends each person their own status: not what's measured here
    const ownBefore = self.for(mallory.id).length;
    for (let i = 0; i < 5; i++) assert.equal((await as(mallory, 'PATCH', '/me/profile', { bio: `bio ${i}` })).status, 200);
    await sleep(1600);
    assert.equal(m.for(mallory.id).length, 1, 'a burst of edits is one update for a co-member');
    assert.equal(m.for(mallory.id)[0].profile.bio, 'bio 4', 'with the latest profile');
    assert.equal(f.for(mallory.id).length, 1, 'friends get it too');
    assert.equal(s.for(mallory.id).length, 0, 'someone who shares nothing gets nothing');
    const own = self.for(mallory.id).slice(ownBefore);
    assert.equal(own.length, 5, 'her own apps hear about each change right away');
    assert.ok('status' in own[0], 'and get her own (private) view');
    assert.ok(!('status' in m.for(mallory.id)[0]), 'others get the public view');

    // nothing changed: no write, no broadcast
    assert.equal((await as(mallory, 'PATCH', '/me/profile', { bio: 'bio 4' })).status, 200);
    assert.equal((await as(mallory, 'DELETE', '/me/song')).status, 200, 'no song to remove');
    assert.equal((await as(mallory, 'DELETE', '/me/media/banner')).status, 200, 'no banner to remove');
    await sleep(1500);
    assert.equal(m.for(mallory.id).length, 1, 'no-op writes broadcast nothing');
    assert.equal(self.for(mallory.id).length, ownBefore + 5);
  } finally { [m, f, s, self].forEach((x) => x.s.close()); }
});

test('xss-5: deleting an account still tells former co-members and friends (worked out before they stop sharing anything)', async () => {
  const alice = await srv.register(); const member = await srv.register(); const friend = await srv.register(); const stranger = await srv.register();
  await shareServer(member, alice);
  await befriend(friend, alice);
  const [m, f, s] = await Promise.all([listener(member), listener(friend), listener(stranger)]);
  try {
    await sleep(1200);
    const r = await as(alice, 'DELETE', '/me', { authKey: alice.authKey, confirm: alice.username });
    assert.equal(r.status, 200, r.text);
    await sleep(1600);
    for (const [who, x] of [['co-member', m], ['friend', f]]) {
      const got = x.for(alice.id);
      assert.equal(got.length, 1, `the ${who} hears about it once`);
      assert.equal(got[0].profile.displayName, 'Deleted user', `the ${who}'s app shows "Deleted user"`);
      assert.equal(got[0].avatar || null, null);
    }
    assert.equal(s.for(alice.id).length, 0, 'someone who never shared anything with her still gets nothing');
  } finally { [m, f, s].forEach((x) => x.s.close()); }
});

test('xss-5: profile writes are rate limited (shared across profile, page, song and media)', async () => {
  const flooder = await srv.register();
  const codes = [];
  for (let i = 0; i < 30; i++) codes.push((await as(flooder, 'PATCH', '/me/profile', { bio: `b${i}` })).status);
  assert.deepEqual([...new Set(codes)], [200], 'a person saving changes is never stopped');
  const over = await as(flooder, 'PATCH', '/me/profile', { bio: 'one too many' });
  assert.equal(over.status, 429);
  assert.equal((await as(flooder, 'DELETE', '/me/song')).status, 429);
  assert.equal((await as(flooder, 'PUT', '/me/page', { meet: 'x' })).status, 429);
  assert.equal((await as(flooder, 'DELETE', '/me/media/banner')).status, 429);
  // someone else is unaffected
  const other = await srv.register();
  assert.equal((await as(other, 'PATCH', '/me/profile', { bio: 'hi' })).status, 200);
});

// ------------------------------------------------------------------ infra-1: the server serves the signature
test('infra-1: /updates serves latest*.yml.sig (and still nothing else)', async () => {
  const dir = path.join(srv.dir, 'downloads');
  fs.writeFileSync(path.join(dir, 'latest.yml.sig'), 'c2lnbmF0dXJl\n');
  fs.writeFileSync(path.join(dir, 'other.sig'), 'x');
  const r = await srv.call('GET', '/updates/latest.yml.sig');
  assert.equal(r.status, 200);
  assert.equal(r.text, 'c2lnbmF0dXJl\n');
  assert.match(r.headers.get('cache-control') || '', /no-cache/);
  assert.equal((await srv.call('GET', '/updates/other.sig')).status, 404);
  assert.equal((await srv.call('GET', '/updates/latest-linux.yml.sig')).status, 404, 'missing file');
});

// ------------------------------------------------------------------ xss-4 / infra-6: desktop origins
test('xss-4/infra-6: look-alike addresses are not the server, and only connect.html is the connect screen', () => {
  const O = require('../desktop/origin');
  const origin = 'https://chat.example.com';
  for (const bad of ['https://chat.example.com@evil.example/', 'https://chat.example.com.evil.example/', 'https://chat.example.com:8443/',
    'https://chat.example.com-x.io/', 'http://chat.example.com/', 'https://user:pw@chat.example.com/', 'blob:https://chat.example.com/1234',
    'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) assert.equal(O.isServerUrl(bad, origin), false, bad);
  for (const good of ['https://chat.example.com/', 'https://chat.example.com/x?y=1#z', 'https://CHAT.example.com/invite/abc']) assert.equal(O.isServerUrl(good, origin), true, good);
  assert.equal(O.isServerUrl('https://chat.example.com/', null), false, 'no server chosen yet');
  assert.equal(O.normalize('chat.example.com/some/path'), origin);

  // connect.html exactly (any query), on Linux and Windows paths
  const posix = '/opt/Hearth/resources/app.asar/connect.html';
  assert.equal(O.isAppFile('file:///opt/Hearth/resources/app.asar/connect.html?server=x&error=y', posix, 'linux'), true);
  assert.equal(O.isAppFile('file:///etc/passwd', posix, 'linux'), false);
  assert.equal(O.isAppFile('file:///opt/Hearth/resources/app.asar/picker.html', posix, 'linux'), false);
  assert.equal(O.isAppFile('file:///opt/Hearth/resources/app.asar/x/../connect.html', posix, 'linux'), true, 'same file');
  assert.equal(O.isAppFile('https://chat.example.com/connect.html', posix, 'linux'), false);
  const win = 'C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\Hearth\\resources\\app.asar\\connect.html';
  assert.equal(O.isAppFile('file:///C:/Users/Ann%20Lee/AppData/Local/Programs/Hearth/resources/app.asar/connect.html?locked=', win, 'win32'), true);
  assert.equal(O.isAppFile('file:///c:/users/ann%20lee/appdata/local/programs/hearth/resources/app.asar/connect.html', win, 'win32'), true, 'Windows paths ignore case');
  assert.equal(O.isAppFile('file:///C:/Windows/System32/drivers/etc/hosts', win, 'win32'), false);

  // http -> https on the same host is the same server; anything else isn't
  assert.equal(O.isHttpsUpgrade('https://chat.example.com/', 'http://chat.example.com'), true);
  assert.equal(O.isHttpsUpgrade('https://evil.example/', 'http://chat.example.com'), false);
  assert.equal(O.isHttpsUpgrade('https://chat.example.com/', 'https://chat.example.com'), false);
});

test('xss-4/infra-6: main.js uses exact checks everywhere and handles redirects', () => {
  const main = read('desktop', 'main.js');
  assert.doesNotMatch(main, /\.startsWith\(\s*(o|origin)\s*\)/, 'no prefix comparisons against the server origin');
  assert.doesNotMatch(main, /startsWith\('file:'\)/, 'no "any file: page" trust');
  assert.match(main, /on\('will-redirect'/, 'main-frame redirects are checked');
  const redirect = main.slice(main.indexOf("on('will-redirect'"), main.indexOf("on('did-fail-load'"));
  assert.match(redirect, /elsewhere\(e, url\);[\s\S]*!onServerPage\(\)\) loadConnect\(redirectedAway\(url\)\)/, 'a refused redirect with no page showing yet lands on the connect screen, not an empty window');
  assert.match(main, /on\('will-navigate'[\s\S]{0,120}isServer\(url\) \|\| isConnectScreen\(url\)/);
  assert.match(main, /const fromOurPage = \(e\) => fromMainWindow\(e\) && \(isServer\(/);
  assert.match(main, /const fromConnectScreen = \(e\) => fromMainWindow\(e\) && isConnectScreen\(/);
  assert.match(main, /isServerUrl\(request\.securityOrigin, origin\)/, 'screen-share requests: exact origin');
  const pkg = JSON.parse(read('desktop', 'package.json'));
  for (const f of ['origin.js', 'permissions.js', 'update-verify.js', 'picker.html', 'picker-preload.js']) assert.ok(pkg.build.files.includes(f), `${f} is packaged`);
});

// ------------------------------------------------------------------ infra-2: permissions + screen picker
test('infra-2: microphone, camera and clipboard need the person\'s yes; other sites get nothing', () => {
  const P = require('../desktop/permissions');
  const srvCtx = (granted = {}) => ({ fromServer: true, granted });
  assert.equal(P.decide('media', { mediaTypes: ['audio'] }, { fromServer: false }).result, 'deny', 'not the server: no');
  assert.deepEqual(P.decide('media', { mediaTypes: ['audio'] }, srvCtx()), { result: 'ask', kinds: ['microphone'] });
  assert.deepEqual(P.decide('media', { mediaTypes: ['audio', 'video'] }, srvCtx({ microphone: true })), { result: 'ask', kinds: ['camera'] });
  assert.equal(P.decide('media', { mediaTypes: ['audio'] }, srvCtx({ microphone: true })).result, 'allow', 'remembered yes');
  assert.deepEqual(P.decide('media', {}, srvCtx()), { result: 'ask', kinds: ['microphone', 'camera'] }, 'unspecified media needs both');
  // no device named = screen capture (getDisplayMedia, or the old chromeMediaSource: 'desktop' getUserMedia,
  // which Electron would otherwise grant straight away): always the app's own picker, never remembered
  assert.equal(P.decide('media', { mediaTypes: [] }, srvCtx({ microphone: true, camera: true })).result, 'screen');
  assert.equal(P.decide('media', { mediaTypes: [], isMainFrame: false }, srvCtx()).result, 'deny');
  assert.equal(P.decide('media', { mediaTypes: [] }, { fromServer: false }).result, 'deny');
  assert.equal(P.decide('media', { mediaType: 'video' }, srvCtx({ camera: true })).result, 'allow', 'permission checks use mediaType');
  assert.deepEqual(P.decide('clipboard-read', {}, srvCtx()), { result: 'ask', kinds: ['clipboard'] });
  assert.equal(P.decide('clipboard-read', { isMainFrame: false }, srvCtx({ clipboard: true })).result, 'deny', 'never a frame inside the app');
  for (const ok of ['notifications', 'clipboard-sanitized-write', 'fullscreen', 'display-capture']) assert.equal(P.decide(ok, {}, srvCtx()).result, 'allow', ok);
  for (const no of ['geolocation', 'midi', 'hid', 'usb', 'serial', 'openExternal', 'pointerLock']) assert.equal(P.decide(no, {}, srvCtx()).result, 'deny', no);
  const clip = P.prompt(['clipboard'], 'chat.example.com');
  assert.equal(clip.defaultId, 0, 'clipboard: "Don\'t allow" is the default');
  assert.equal(clip.checkboxChecked, false);
  assert.match(clip.message, /chat\.example\.com/);
  assert.equal(P.prompt(['microphone'], 'h').buttons[1], 'Allow');

  const main = read('desktop', 'main.js');
  assert.doesNotMatch(main, /'clipboard-read'/, 'main.js no longer auto-grants clipboard-read');
  assert.match(main, /consent\.decide\(perm, details/);
  assert.match(main, /dialog\.showMessageBox\(win, consent\.prompt\(/, 'asks with a native dialog');
});

test('infra-2: the screen list goes to the app\'s own picker window, never to the server\'s page', () => {
  const main = read('desktop', 'main.js');
  // the person picks at the permission step; the display-media handler only takes that choice over
  assert.match(main, /if \(d\.result === 'screen'\) return chooseScreen\(origin\)/);
  const handler = main.slice(main.indexOf('setDisplayMediaRequestHandler('), main.indexOf('// Opens the picker over the main window'));
  assert.match(handler, /const choice = pendingShare;\s*pendingShare = null;/, 'one choice, used once');
  assert.match(handler, /answer\(\{ video: choice\.source/);
  assert.doesNotMatch(handler, /pickSource|getSources/, 'the handler never picks by itself');
  assert.doesNotMatch(main, /useSystemPicker/, 'the app\'s picker on every system');
  const choose = main.slice(main.indexOf('async function chooseScreen'), main.indexOf('app.whenReady().then(() => {\n  session.defaultSession.setPermissionRequestHandler'));
  assert.match(choose, /if \(pendingShare !== mine\) return;[\s\S]*restartPage\(\)/, 'a capture the display-media handler never saw (the old API) ends with a restart of the page');
  // ...which the page can't refuse or put off: its renderer is stopped (not asked to unload), then reloaded
  const restart = main.slice(main.indexOf('function restartPage'), main.indexOf('async function chooseScreen'));
  assert.match(restart, /wc\.once\('render-process-gone', again\)[\s\S]*wc\.forcefullyCrashRenderer\(\)/, 'stops the renderer, reloads once it is gone');
  assert.match(restart, /wc\.reload\(\)/);
  assert.match(main, /win\.webContents\.on\('will-prevent-unload', \(e\) => e\.preventDefault\(\)\)/, 'a "Leave site?" handler can\'t cancel a reload, close or quit');
  assert.doesNotMatch(main, /send\('screen-pick'/, 'no window list or previews sent to the page');
  assert.doesNotMatch(main, /'screen-picked'/, 'the page can\'t answer for the person');
  assert.match(main, /preload: path\.join\(__dirname, 'picker-preload\.js'\)/);
  assert.match(main, /e\.sender !== p\.webContents/, 'only the picker window answers');
  assert.match(main, /list\.some\(\(s\) => s\.id === id\)/, 'and only with a listed source');
  const preload = read('desktop', 'preload.js');
  assert.doesNotMatch(preload, /onPickScreen|pickScreen|screen-pick/);
  const picker = read('desktop', 'picker.html');
  assert.match(picker, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
  assert.doesNotMatch(picker, /innerHTML/, 'window titles are shown as text');
});

// The real desktop app in Electron, when it's installed (desktop/node_modules, or HEARTH_ELECTRON=<binary>).
// Linux without a display needs xvfb-run.
function findElectron() {
  const env = process.env.HEARTH_ELECTRON;
  if (env) return fs.existsSync(env) ? env : null;
  try { const bin = require(require.resolve('electron', { paths: [DESKTOP] })); return typeof bin === 'string' && fs.existsSync(bin) ? bin : null; } catch { return null; }
}
const ELECTRON = findElectron();
const NEEDS_XVFB = process.platform === 'linux' && !process.env.DISPLAY;
const electronSkip = !ELECTRON ? 'Electron is not installed (npm install in desktop/, or set HEARTH_ELECTRON)'
  : NEEDS_XVFB && spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).error ? 'no display and no xvfb-run' : false;
test('infra-2: in Electron, a hostile page can\'t keep an old-style desktop capture, block a reload or leave an empty window', { skip: electronSkip, timeout: 180000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-desk-'));
  try {
    const appDir = path.join(tmp, 'app');
    fs.cpSync(DESKTOP, appDir, { recursive: true, filter: (src) => !/[\\/](node_modules|dist)$/.test(src) });
    const cfg = JSON.parse(fs.readFileSync(path.join(appDir, 'hearth.config.json'), 'utf8'));
    fs.writeFileSync(path.join(appDir, 'hearth.config.json'), JSON.stringify({ ...cfg, defaultServer: '', lockServer: false, autoUpdate: false }));
    const args = [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), '-r', path.join(__dirname, 'desktop-harness.js'), appDir];
    const [cmd, argv] = NEEDS_XVFB ? ['xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', ELECTRON, ...args]] : [ELECTRON, args];
    const env = { ...process.env, HEARTH_UD: path.join(tmp, 'userdata') };
    delete env.ELECTRON_RUN_AS_NODE;
    const output = await new Promise((resolve) => {
      // Its own process group, so a stuck run can be stopped whole (xvfb-run, Xvfb, Electron and its helpers).
      const child = spawn(cmd, argv, { detached: true, env });
      let text = '';
      child.stdout.on('data', (d) => { text += d; });
      child.stderr.on('data', (d) => { text += d; });
      const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
      const kill = setTimeout(() => { stop(); resolve(text); }, 150000);
      child.on('exit', () => { clearTimeout(kill); setTimeout(() => { stop(); resolve(text); }, 500); });
    });
    const line = output.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `no result from Electron:\n${output.slice(-3000)}`);
    const r = JSON.parse(line.slice(7));
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.connect && r.onServer, true, 'connected to the fake server');
    // legit use: getDisplayMedia goes through the picker and keeps sharing, no reload
    assert.equal(r.gdmPicker, true);
    assert.equal(r.gdm, 'shared');
    assert.equal(r.gdmAfter, 'same page, live', 'normal screen sharing carries on');
    // the old API: the person's pick, then the capture ends although the page refuses to unload and busy-loops
    assert.equal(r.legacyPicker, true, 'the old API still goes through the picker first');
    assert.equal(r.legacy, 'captured');
    assert.equal(r.legacyReloaded, true, 'the page was loaded again');
    assert.equal(r.legacyAfter, 'fresh page');
    assert.ok(r.lastBeatMs === null || r.lastBeatMs < 5000, `the capture ended within the hand-off time (last live report ${r.lastBeatMs} ms after the pick)`);
    // "Leave site?" can't keep the person on the page either
    assert.equal(r.changeServer, true, 'Change server works from a page that refuses to unload');
    // a start page redirecting elsewhere: opened in the browser once, and the connect screen says why
    assert.deepEqual(r.redirectOpened, ['http://sso.example.invalid/login']);
    assert.match(r.redirectError || '', /sent the app on to sso\.example\.invalid/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ infra-1: signed updates
const UV = require('../desktop/update-verify');
const sha = (buf) => crypto.createHash('sha512').update(buf).digest('base64');
function release(version, installer) {
  const h = sha(installer);
  return `version: ${version}\nfiles:\n  - url: Hearth-Setup-${version}.exe\n    sha512: ${h}\n    size: ${installer.length}\npath: Hearth-Setup-${version}.exe\nsha512: ${h}\nreleaseDate: '2026-10-01T12:00:00.000Z'\n`;
}

test('infra-1: a signed update verifies; tampered metadata, a missing signature or another key do not', () => {
  const { privateKeyPem, publicKey } = UV.generateKeys();
  const key = UV.loadPrivateKey(privateKeyPem);
  const installer = crypto.randomBytes(4096);
  const yml = Buffer.from(release('1.30.0', installer));
  const sig = UV.sign('latest.yml', yml, key);
  const ok = UV.verifyFeed({ name: 'latest.yml', yml, sig, publicKey, version: '1.30.0', currentVersion: '1.27.1' });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(UV.fileMatches(sha(installer), ok.hashes), true, 'the real installer matches');

  // one changed byte of the listed SHA-512 (an attacker swapping in their own installer's hash)
  const evil = crypto.randomBytes(4096);
  const swapped = Buffer.from(yml.toString().split(sha(installer)).join(sha(evil)));
  assert.equal(UV.verifyFeed({ name: 'latest.yml', yml: swapped, sig, publicKey, version: '1.30.0', currentVersion: '1.27.1' }).ok, false, 'tampered yml');
  const flipped = Buffer.from(yml); flipped[30] ^= 1;
  assert.equal(UV.verifyFeed({ name: 'latest.yml', yml: flipped, sig, publicKey, version: '1.30.0', currentVersion: '1.27.1' }).ok, false, 'one flipped bit');
  // a different installer than the signed one
  assert.equal(UV.fileMatches(sha(evil), ok.hashes), false, 'tampered file');
  const almost = Buffer.from(installer); almost[0] ^= 1;
  assert.equal(UV.fileMatches(sha(almost), ok.hashes), false);
  // no signature, an empty one, garbage, another publisher's key
  for (const s of [null, '', '   ', 'not base64 !!', Buffer.alloc(64).toString('base64')]) {
    assert.equal(UV.verifyFeed({ name: 'latest.yml', yml, sig: s, publicKey, version: '1.30.0', currentVersion: '1.27.1' }).ok, false, `sig ${JSON.stringify(s)}`);
  }
  const other = UV.generateKeys();
  assert.equal(UV.verifyFeed({ name: 'latest.yml', yml, sig: UV.sign('latest.yml', yml, UV.loadPrivateKey(other.privateKeyPem)), publicKey, version: '1.30.0', currentVersion: '1.27.1' }).ok, false, 'signed by someone else');
  // the server didn't serve the yml at all
  assert.equal(UV.verifyFeed({ name: 'latest.yml', yml: null, sig, publicKey }).ok, false);
  // the signature is bound to the file name: a Windows signature isn't valid for the Linux file
  assert.equal(UV.verifyFeed({ name: 'latest-linux.yml', yml, sig, publicKey }).ok, false);
});

test('infra-1: no downgrades, no version swaps, and the right file per platform', () => {
  const { privateKeyPem, publicKey } = UV.generateKeys();
  const key = UV.loadPrivateKey(privateKeyPem);
  const yml = Buffer.from(release('1.27.1', crypto.randomBytes(64)));
  const sig = UV.sign('latest.yml', yml, key);
  assert.match(UV.verifyFeed({ name: 'latest.yml', yml, sig, publicKey, version: '1.27.1', currentVersion: '1.27.1' }).error, /isn’t newer/, 'same version');
  assert.equal(UV.verifyFeed({ name: 'latest.yml', yml, sig, publicKey, version: '1.27.1', currentVersion: '1.30.0' }).ok, false, 'older, validly signed release');
  assert.match(UV.verifyFeed({ name: 'latest.yml', yml, sig, publicKey, version: '9.9.9', currentVersion: '1.0.0' }).error, /isn’t the signed one/);
  assert.equal(UV.compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(UV.compareVersions('1.2.0', '1.2.0-beta.1'), 1);
  assert.equal(UV.compareVersions('1.2.0-beta.2', '1.2.0-beta.10'), -1);
  assert.equal(UV.compareVersions('v2.0.0', '2.0.0'), 0);
  assert.equal(UV.channelFile('win32', 'x64'), 'latest.yml');
  assert.equal(UV.channelFile('linux', 'x64'), 'latest-linux.yml');
  assert.equal(UV.channelFile('linux', 'arm64'), 'latest-linux-arm64.yml');
  // electron-builder's real layout, including quoted values
  const meta = UV.readMetadata(`version: '2.0.0'\nfiles:\n  - url: a.AppImage\n    sha512: "${'A'.repeat(86)}=="\n    blockMapSize: 1\npath: a.AppImage\nsha512: ${'B'.repeat(86)}==\n`);
  assert.equal(meta.version, '2.0.0');
  assert.equal(meta.hashes.size, 2);
});

test('infra-1: the install dialog always asks, and says when an update can\'t be verified', async () => {
  const unverified = UV.installPrompt({ version: '1.30.0', verified: false, host: 'chat.example.com' });
  assert.match(unverified.detail, /can’t be verified/);
  assert.match(unverified.detail, /chat\.example\.com/);
  assert.equal(unverified.defaultId, 0, 'unverified: "Not now" is the default');
  assert.equal(unverified.type, 'warning');
  const verified = UV.installPrompt({ version: '1.30.0', verified: true });
  assert.match(verified.detail, /signed by Hearth’s publisher/);
  assert.deepEqual(verified.buttons, ['Not now', 'Restart and install']);
  const f = path.join(os.tmpdir(), `hearth-upd-${process.pid}`);
  const data = crypto.randomBytes(300000);
  fs.writeFileSync(f, data);
  try { assert.equal(await UV.sha512File(f), sha(data)); } finally { fs.rmSync(f, { force: true }); }

  const main = read('desktop', 'main.js');
  assert.match(main, /autoInstallOnAppQuit = false/, 'never installs silently on quit');
  assert.doesNotMatch(main, /autoInstallOnAppQuit = true/);
  const install = main.slice(main.indexOf('async function installUpdate'), main.indexOf('const askToInstall'));
  assert.ok(install.indexOf('showMessageBox') > 0 && install.indexOf('showMessageBox') < install.indexOf('quitAndInstall'), 'asks before quitAndInstall');
  assert.ok(install.indexOf('fileMatches') < install.indexOf('quitAndInstall'), 'and re-checks the file first');
  assert.match(main, /if \(!UPDATE_KEY\) return \{ ok: true, verified: false/, 'no key: still updates, marked unverified');
  assert.match(main, /UPDATES\.verifyFeed\(/);
  assert.equal(typeof JSON.parse(read('desktop', 'hearth.config.json')).updatePublicKey, 'string');
});

test('infra-1: build/sign-update.js signs every latest*.yml and bakes the public key; CI uses it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-sign-'));
  try {
    // a copy of the desktop folder's relevant files, so "bake" doesn't touch the real config
    fs.mkdirSync(path.join(tmp, 'build'));
    fs.copyFileSync(path.join(DESKTOP, 'build', 'sign-update.js'), path.join(tmp, 'build', 'sign-update.js'));
    fs.copyFileSync(path.join(DESKTOP, 'update-verify.js'), path.join(tmp, 'update-verify.js'));
    fs.copyFileSync(path.join(DESKTOP, 'hearth.config.json'), path.join(tmp, 'hearth.config.json'));
    const dist = path.join(tmp, 'dist'); fs.mkdirSync(dist);
    const exe = crypto.randomBytes(1000); const appimage = crypto.randomBytes(1000);
    fs.writeFileSync(path.join(dist, 'latest.yml'), release('1.30.0', exe));
    fs.writeFileSync(path.join(dist, 'latest-linux.yml'), release('1.30.0', appimage));
    const { privateKeyPem, publicKey } = UV.generateKeys();
    const script = path.join(tmp, 'build', 'sign-update.js');
    const run = (args, key) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, GITHUB_ACTIONS: '', UPDATE_SIGNING_KEY: key }, encoding: 'utf8' });
    for (const key of [privateKeyPem, Buffer.from(privateKeyPem).toString('base64')]) {
      const r = run(['sign', dist], key);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE KEY/, 'never prints the key');
      for (const name of ['latest.yml', 'latest-linux.yml']) {
        const ok = UV.verifyFeed({ name, yml: fs.readFileSync(path.join(dist, name)), sig: fs.readFileSync(path.join(dist, `${name}.sig`), 'utf8'), publicKey });
        assert.equal(ok.ok, true, `${name}: ${ok.error}`);
      }
    }
    const baked = run(['bake'], privateKeyPem);
    assert.equal(baked.status, 0, baked.stdout + baked.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'hearth.config.json'), 'utf8')).updatePublicKey, publicKey);
    assert.notEqual(run(['sign', dist], '').status, 0, 'no key: refuses');
    assert.notEqual(run(['sign', dist], 'not a key').status, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const wf = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'hearth-apps.yml'), 'utf8');
  assert.match(wf, /UPDATE_SIGNING_KEY: \$\{\{ secrets\.UPDATE_SIGNING_KEY \}\}/);
  assert.match(wf, /node build\/sign-update\.js bake/);
  assert.ok(wf.indexOf('node build/sign-update.js sign dist') > wf.indexOf('node build/after-signing.js dist'), 'signs after SignPath rewrites latest.yml');
  assert.ok(wf.indexOf('node build/sign-update.js bake') < wf.indexOf('npx electron-builder --publish never'), 'bakes the key before building');
  assert.match(wf, /hearth\/desktop\/dist\/latest\*\.yml\.sig/, 'uploads the signatures');
  assert.match(wf, /files=\([^)]*dist\/latest\*\.yml\.sig\)/, 'copies them to the server (the pinned-host scp step)');
});

// ------------------------------------------------------------------ xss-6: shared looks
test('xss-6: a look file can\'t put anything but a number into the background angle', async () => {
  const A = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'appearance.js')).href);
  const payload = '0deg, red, red), url(https://evil.example/t.png), linear-gradient(0';
  for (const style of ['linear', 'conic']) {
    const css = A.gradientCss({ angle: payload, colors: ['#000000', '#ffffff', '#000000'], style });
    assert.doesNotMatch(css, /url\(|evil/, `${style}: ${css}`);
  }
  assert.match(A.gradientCss({ angle: 90, colors: ['#000000', '#ffffff'], style: 'linear' }), /^linear-gradient\(90deg, #000000, #ffffff\)$/, 'a real angle still works');
  assert.match(A.gradientCss({ angle: 999, colors: ['#000000', '#ffffff'], style: 'linear' }), /\(360deg/);
  const clean = A.cleanAppearance({ accent: '#123456', bg: { kind: 'gradient', angle: payload, style: 'x);background:url(//e)', colors: ['#111111', 'red;x', '#333333'], evil: 'y' },
    layout: { order: ['main', 'rail', 'sidebar', 'panel'], sideW: '300px);x', extra: 1 }, unknown: 'z' });
  assert.equal(clean.bg.angle, 135, 'text angle replaced');
  assert.equal(clean.bg.style, 'linear');
  assert.deepEqual(clean.bg.colors, ['#111111', '#000000', '#333333']);
  assert.ok(!('evil' in clean.bg) && !('extra' in clean.layout) && !('unknown' in clean), 'unknown keys dropped');
  assert.equal(clean.layout.sideW, 256, 'wrong type: the default');
  assert.deepEqual(clean.layout.order, ['main', 'rail', 'sidebar', 'panel']);
  assert.equal(A.cleanAppearance({ bg: { kind: 'gradient', angle: 45, style: 'conic', colors: ['#000000', '#ffffff', '#000000'] } }).bg.angle, 45, 'a normal look keeps its angle');
});

// ------------------------------------------------------------------ xss-9: watch-together frames
test('xss-9: watch-together players are sandboxed and YouTube commands go only to YouTube', () => {
  const src = read('public', 'js', 'watch.js');
  const frames = src.split('\n').filter((l) => l.includes("h('iframe'"));
  assert.equal(frames.length, 3);
  for (const l of frames) assert.match(l, /sandbox: PLAYER_SANDBOX/, l.trim().slice(0, 80));
  assert.match(src, /PLAYER_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox'/);
  assert.doesNotMatch(src, /allow-top-navigation/);
  assert.doesNotMatch(src, /postMessage\([^)]*\)\s*,\s*'\*'\)|,\s*'\*'\)/, 'no postMessage to any origin');
});

// ------------------------------------------------------------------ xss-1: profile page CSS
test('xss-1: the profile page\'s parent contains it (CSS the page can\'t select)', () => {
  const css = read('public', 'css', 'app.css');
  const shell = /\.mys-shell \{([^}]*)\}/.exec(css);
  assert.ok(shell, '.mys-shell rule');
  assert.match(shell[1], /contain: (layout paint|strict)/);
  assert.match(shell[1], /isolation: isolate/);
  const page = read('public', 'js', 'page.js');
  assert.doesNotMatch(page, /mys-comment-form/, 'no comment box on the styled page');
  assert.match(page, /removeProperty\('-webkit-text-security'\)/);
});

// The real client in Chromium, when Playwright is installed (it isn't part of Hearth's dependencies).
function findPlaywright() {
  for (const p of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright']) {
    if (!p) continue;
    try { return require(p); } catch { /* next */ }
  }
  try { return require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')); } catch { return null; }
}
const PW = findPlaywright();
test('xss-1: in the browser, page CSS can\'t cover the close button, mask text or rename app animations; commenting still works', { skip: !PW && 'Playwright is not installed' }, async () => {
  const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const browser = await PW.chromium.launch({ executablePath: exe, args: ['--proxy-server=direct://'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
    const page = await context.newPage();
    const mallory = await srv.register();
    const evil = '.mys-page{contain:none;isolation:auto}.mys-wrap{z-index:auto}'
      + '.mys-comment-open{position:fixed;inset:0;z-index:99999;background:#100e16;-webkit-text-security:disc;animation:spin 1s infinite}'
      + '.mys-comment-open::before{content:"Session expired - enter your password"}'
      + '@keyframes spin{to{opacity:0}}'
      + '@keyframes mask{from,to{-webkit-text-security:disc}}.mys-chip{animation:mask 1s infinite}'; // masking from an animation frame
    assert.equal((await as(mallory, 'PUT', '/me/page', { css: evil })).status, 200);

    const name = `vis${crypto.randomBytes(3).toString('hex')}`;
    await page.goto(srv.base + '/');
    await page.click('#to-register');
    await page.fill('#register-form input[name=username]', name);
    await page.fill('#register-form input[name=password]', 'correct horse battery');
    await page.fill('#register-form input[name=confirm]', 'correct horse battery');
    await page.check('#register-form input[name=tos]');
    await page.click('#register-form button[type=submit]');
    await page.waitForSelector('#app:not([hidden]):not(.loading)', { timeout: 60000 });
    await page.evaluate(async (uid) => { const m = await import('/js/app.js'); m.app.openProfile(uid); }, mallory.id);
    await page.waitForSelector('.mys-modal .mys-comment-open');
    await sleep(400); // the modal's opening animation
    const r = await page.evaluate(() => {
      const box = (el) => { const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
      const close = document.querySelector('.mys-close').getBoundingClientRect();
      const hit = document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2);
      const btn = document.querySelector('.mys-comment-open');
      return {
        btn: box(btn), shell: box(document.querySelector('.mys-shell')), vw: innerWidth, vh: innerHeight,
        closeHit: !!(hit && hit.closest('.mys-close')), boxesOnPage: document.querySelectorAll('.mys-page textarea, .mys-page input').length,
        security: getComputedStyle(btn).webkitTextSecurity, animation: getComputedStyle(btn).animationName,
        chipSecurity: getComputedStyle(document.querySelector('.mys-chip')).webkitTextSecurity, chipAnimation: getComputedStyle(document.querySelector('.mys-chip')).animationName,
        style: [...document.querySelectorAll('.mys-page style')].map((s) => s.textContent).join('\n'),
      };
    });
    assert.equal(r.closeHit, true, 'the close button is still on top and clickable');
    assert.ok(r.btn[2] < r.vw && r.btn[3] < r.vh, `the "fixed, full window" element stays smaller than the window: ${r.btn}`);
    assert.ok(r.btn[0] >= r.shell[0] - 1 && r.btn[1] >= r.shell[1] - 1 && r.btn[0] + r.btn[2] <= r.shell[0] + r.shell[2] + 1 && r.btn[1] + r.btn[3] <= r.shell[1] + r.shell[3] + 1, 'and inside the page\'s box');
    assert.equal(r.boxesOnPage, 0, 'no text box on the styled page');
    assert.notEqual(r.security, 'disc', 'no password-style masking');
    assert.match(r.chipAnimation, /^pg[0-9a-z]+-mask$/, 'the page\'s masking animation is applied (renamed)...');
    assert.notEqual(r.chipSecurity, 'disc', '...but can\'t mask text from its keyframes either');
    const scoped = await page.evaluate(async () => (await import('/js/page.js')).scopeCss('@keyframes m{from,to{-webkit-text-security:disc;opacity:.5}}@media (min-width:1px){@keyframes n{to{-webkit-text-security:square}}}.x{color:red}', '.s'));
    assert.doesNotMatch(scoped, /text-security/, scoped);
    assert.match(scoped, /opacity: 0\.5/, 'the rest of the frame stays');
    assert.doesNotMatch(r.style, /@keyframes spin\b/, 'the app\'s own "spin" is not redefined');
    assert.match(r.style, /@keyframes pg[0-9a-z]+-spin/);
    assert.match(r.animation, /^pg[0-9a-z]+-spin$/, 'the page\'s own animation still runs under its new name');

    // legit use: the comment is written in the app's own dialog and lands on the wall
    await page.evaluate(() => { document.querySelector('.mys-page style').remove(); });
    await page.click('.mys-comment-open');
    await page.waitForSelector('.modal:not(.mys-modal) textarea');
    assert.equal(await page.evaluate(() => !!document.querySelector('.modal:not(.mys-modal) textarea').closest('.mys-page')), false, 'the dialog is outside the page');
    await page.fill('.modal:not(.mys-modal) textarea', 'hello from the test');
    await page.click('.modal:not(.mys-modal) .modal-foot .btn.primary');
    await page.waitForSelector('.mys-comment-text >> text=hello from the test');
    const wall = await as(mallory, 'GET', `/users/${mallory.id}/page`);
    assert.equal(wall.json.comments[0].text, 'hello from the test');
  } finally { await browser.close(); }
});

// ------------------------------------------------------------------ infra-7: Android bridge
test('infra-7: only the connect screen may change the Android app\'s server', { skip: !hasJava() && 'no JDK (javac) here' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bridge-'));
  try {
    const check = `package app.hearth.mobile;
public class BridgePolicyCheck {
  public static void main(String[] a) {
    String local = "https://localhost", server = "https://chat.example.com", evil = "https://evil.example";
    System.out.println(String.join(",",
      ""+BridgePolicy.allowed("setServer", server, local, server),
      ""+BridgePolicy.allowed("setServer", local, local, server),
      ""+BridgePolicy.allowed("setServer", evil, local, server),
      ""+BridgePolicy.allowed("setServer", "", local, server),
      ""+BridgePolicy.allowed("changeServer", server, local, server),
      ""+BridgePolicy.allowed("notify", server, local, server),
      ""+BridgePolicy.allowed("notify", evil, local, server),
      ""+BridgePolicy.allowed("hello", local, local, ""),
      ""+BridgePolicy.allowed("setServer", local, local, "")));
  }
}`;
    fs.writeFileSync(path.join(tmp, 'BridgePolicyCheck.java'), check);
    execFileSync('javac', ['-d', tmp, path.join(ROOT, 'mobile', 'native', 'BridgePolicy.java'), path.join(tmp, 'BridgePolicyCheck.java')], { stdio: 'pipe' });
    const out = execFileSync('java', ['-cp', tmp, 'app.hearth.mobile.BridgePolicyCheck'], { encoding: 'utf8' }).trim();
    assert.equal(out, 'false,true,false,false,true,true,false,true,true');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
function hasJava() { return spawnSync('javac', ['-version'], { stdio: 'ignore' }).status === 0; }

test('infra-7: MainActivity checks who sent each message; CI ships BridgePolicy', () => {
  const java = read('mobile', 'native', 'MainActivity.java');
  const onMessage = java.slice(java.indexOf('private void onMessage('), java.indexOf('case "setServer"'));
  assert.match(onMessage, /BridgePolicy\.allowed\(type, from, localOrigin\(\), serverOrigin\(\)\)/);
  assert.match(onMessage, /originOf\(sourceOrigin\.toString\(\)\)/);
  const wf = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'hearth-apps.yml'), 'utf8');
  assert.match(wf, /cp native\/\*\.java android\/app\/src\/main\/java\/app\/hearth\/mobile\//);
});
