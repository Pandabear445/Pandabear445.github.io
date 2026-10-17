// The Android app under Google Play's rules: no way to pay inside it (Play doesn't allow an app to send people to
// pay outside its own billing), no APK from the download page (an app from Play updates only through Play), and
// links to a privacy policy (PRIVACY_URL on the server; Hearth's own on the app's connect screen).
//
// Static checks that every way to pay in the web client checks noPayments (android.js, from androidApp.on), the
// server's /api/config, the What's new list run as a module, the connect screen's link rule compiled with javac
// (skipped without a JDK), and the real client in Chromium, as a browser and as the Android app with its bridge
// simulated (skipped without Playwright). The web and the desktop app must look exactly as before.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { startServer } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const PRIVACY = 'https://privacy.example.com/hearth/privacy.html';
const FUNDING = 'https://ko-fi.com/hearth-test';
// A phone's browser, and the same phone inside the Hearth app (capacitor.config.json adds HearthAndroid).
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const APP_UA = `${PHONE_UA} HearthAndroid`;

let srv; let bad;
before(async () => {
  srv = await startServer({ PRIVACY_URL: PRIVACY });
  bad = await startServer({ PRIVACY_URL: 'http://privacy.example.com/privacy.html', LOG_FORMAT: 'json' });
  // A funding card with a donation link (changing the link needs the owner's password again).
  const r = await srv.api('PUT', '/admin/owner', { token: srv.owner.token, ip: srv.owner.ip, body: { funding: { enabled: true, url: FUNDING, monthly: 20 }, authKey: srv.owner.authKey } });
  assert.equal(r.status, 200, r.text);
  // Installers on /download: one for Windows, one for Android.
  const dl = path.join(srv.dir, 'downloads');
  fs.mkdirSync(dl, { recursive: true });
  fs.writeFileSync(path.join(dl, 'Hearth-Setup-1.29.1.exe'), 'not really an installer');
  fs.writeFileSync(path.join(dl, 'Hearth-1.29.1.apk'), 'not really an app');
});
after(async () => {
  if (srv) await srv.stop();
  if (bad) await bad.stop();
});

// The source of one top-level function (from its name to the closing brace at the start of a line).
function fnSource(src, name) {
  const start = src.search(new RegExp(`^(export )?(async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `function ${name}`);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
}
// The name of the top-level function a position in the source is in.
function enclosing(src, at) {
  const re = /^(?:export )?(?:async )?function (\w+)\(/gm;
  let name = null; let m;
  while ((m = re.exec(src)) && m.index < at) name = m[1];
  return name;
}

// ================================================================== 1. no way to pay inside the Android app
test('play-1: noPayments is androidApp.on (or the app’s user agent), and every way to pay checks it', () => {
  const android = read('public', 'js', 'android.js');
  assert.match(android, /export const androidApp = \{ on: !!A,/);
  assert.match(android, /export const noPayments = androidApp\.on \|\| \/\\bHearthAndroid\\b\/\.test\(/);
  assert.equal(JSON.parse(read('mobile', 'capacitor.config.json')).android.appendUserAgent, 'HearthAndroid', 'the user agent the app really adds');

  const js = read('public', 'js', 'app.js');
  assert.match(js, /^import \{ androidApp, noPayments \} from '\.\/android\.js';$/m);
  // The Support window, the funding card on Home and the return from Stripe stop at once in the app.
  assert.match(fnSource(js, 'openSupport'), /^async function openSupport\(\) \{\n {2}if \(noPayments\) return;\n/);
  assert.match(fnSource(js, 'fundingCard'), /\n {2}if \(noPayments \|\| !f \|\| !f\.enabled \|\| !f\.url\) return null;\n/);
  assert.match(fnSource(js, 'backFromStripe'), /history\.replaceState\(null, '', '\/' \+ location\.hash\);\n {2}if \(noPayments\) return;\n/);
  // The entries that lead there: the menu on your name, the Memberships row and server menu item, and the owner's
  // Memberships tab in Server settings.
  assert.match(fnSource(js, 'statusMenu'), /!noPayments && \(S\.config\.funding \|\| S\.config\.support\) \? h\('button', \{ class: 'menu-item', onclick: \(\) => \{ closePopover\(\); openSupport\(\); \} \}/);
  assert.match(js, /if \(server\.memberships && !noPayments\) body\.append\(h\('button', \{ class: 'ev-row mb-row'/);
  assert.match(fnSource(js, 'serverMenuItems'), /server\.memberships && !isOwner\(server\) && !noPayments \? \{ label: 'Memberships'/);
  assert.match(fnSource(js, 'openServerSettings'), /\['memberships', 'Memberships', 'star', \(s\) => !noPayments && /);
  // A payment that didn't go through isn't a reason to send someone to their card from the app.
  assert.match(js, /else if \(m\.status === 'past_due' && !noPayments\) toast\(/);

  // Any other place that opens one of them (a new button, say), or reads the donation link or the supporter
  // settings (config.funding, config.support, however they're reached), has to check noPayments itself: in every
  // client file but Admin → Money, where the owner sets them up.
  const opens = /openSupport\(\)|openMemberships\(|openServerSettings\([^)]*'memberships'\)|\.funding\b|\.support\b|\[\s*['"`]funding['"`]\s*\]|['"`]funding['"`]\s+in\b|\{[^{}\n]*\bfunding\b[^{}\n]*\}\s*=(?!=)/g;
  const guarded = { 'app.js': ['fundingCard', 'openSupport', 'backFromStripe'], 'memberships.js': ['openMemberships', 'membershipsTab'] };
  let m; let n = 0;
  for (const file of fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js') && f !== 'admin.js')) {
    const src = read('public', 'js', file);
    while ((m = opens.exec(src))) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const line = src.slice(lineStart, src.indexOf('\n', m.index));
      if (/^(export )?(async )?function /.test(line) || /^import /.test(line)) continue;
      if (/(^|\s)\/\/|^\s*\*/.test(src.slice(lineStart, m.index))) continue; // in a comment
      n++;
      const inside = enclosing(src, m.index);
      assert.ok(/noPayments/.test(line) || (guarded[file] || []).includes(inside), `${file}: ${line.trim().slice(0, 140)}`);
    }
  }
  assert.ok(n >= 9, `found the places that open payments (${n})`);

  // Memberships: joining (Stripe's checkout) and the owner's tab both stop in the app.
  const mb = read('public', 'js', 'memberships.js');
  assert.match(mb, /^import \{ noPayments \} from '\.\/android\.js';$/m);
  assert.match(fnSource(mb, 'openMemberships'), /^export async function openMemberships\(server\) \{\n {2}if \(noPayments\) return;\n/);
  assert.match(fnSource(mb, 'membershipsTab'), /^export async function membershipsTab\(s, body, \{ roles \}\) \{\n {2}if \(noPayments\) \{ clear\(body\); return; \}\n/);

  // The ways to pay (Stripe and Ko-fi links, the owner's donation link, a membership checkout) are only built
  // inside those guarded functions. (Admin → Money is where the owner sets them up; it pays nothing.)
  const payLinks = /stripeUrl|kofiUrl|\/checkout`/g;
  for (const file of fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js') && f !== 'admin.js')) {
    const src = read('public', 'js', file);
    while ((m = payLinks.exec(src))) {
      const where = `${file}:${enclosing(src, m.index)}`;
      assert.ok(['app.js:openSupport', 'memberships.js:openMemberships'].includes(where), `a way to pay outside the guarded functions: ${where}`);
    }
  }
});

test('play-2: What’s new leaves out the items about paying in the Android app, and keeps them elsewhere', async () => {
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
  try {
    const W = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'whatsnew.js')).href);
    const items = (opts) => { store.set('hearth.seenVersion', '1.17.0'); return W.unseenChanges('1.29.0', opts); };
    const web = items();
    const app = items({ payments: false });
    const text = (list) => list.flatMap((c) => c.items);
    for (const t of [...text(web), ...text(app)]) assert.equal(typeof t, 'string', 'items are plain text');
    assert.ok(text(web).some((t) => /Creator memberships/.test(t)) && text(web).some((t) => /become a supporter/.test(t)), 'the web keeps them');
    assert.ok(!text(app).some((t) => /Stripe|supporter|memberships|pay /i.test(t)), 'the app has none of them');
    assert.equal(text(app).length, text(web).length - 2, 'only those two are left out');
    assert.ok(app.every((c) => c.items.length), 'no empty versions');
    // Every version after 1.17.0 up to 1.29.0 (CHANGES is newest first; later releases are newer than 1.29.0).
    const upTo = W.CHANGES.slice(W.CHANGES.findIndex((c) => c.version === '1.29.0'));
    assert.deepEqual(web.map((c) => c.version), upTo.filter((c) => c.version !== '1.17.0').map((c) => c.version));
    // Seen everything already, or a first visit: nothing, as before.
    store.set('hearth.seenVersion', '1.29.0');
    assert.deepEqual(W.unseenChanges('1.29.0', { payments: false }), []);
    store.delete('hearth.seenVersion');
    assert.deepEqual(W.unseenChanges('1.29.0'), []);
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
  assert.match(read('public', 'js', 'app.js'), /const news = unseenChanges\(S\.config\.version, \{ payments: !noPayments \}\);/);
});

// ================================================================== 2. no APK download page inside the app
test('play-3: inside the app, Settings has no download page or share link, and /download offers nothing to download', () => {
  const settings = read('public', 'js', 'settings.js');
  const apps = fnSource(settings, 'appsTab');
  assert.match(apps, /window\.hearthDesktop \|\| androidApp\.on \? null : section\('Desktop app',/);
  assert.match(apps, /androidApp\.on \? null : section\('Share', /);
  // Those two sections are the only links to /download in the client (the page itself aside).
  for (const file of fs.readdirSync(path.join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js') && f !== 'download-page.js')) {
    const src = read('public', 'js', file);
    const re = /\/download(?!s)/g; let m;
    while ((m = re.exec(src))) {
      assert.equal(file, 'settings.js', `a link to /download in ${file}`);
      const sec = src.lastIndexOf("section('", m.index);
      assert.match(src.slice(sec - 40, sec), /androidApp\.on \? null : $/, `settings.js: /download outside a section the app leaves out (${src.slice(sec, sec + 30)})`);
    }
  }
  // The page: with the app's user agent, no files at all, and the page stops before listing any.
  const page = read('public', 'js', 'download-page.js');
  assert.match(page, /const inApp = \/\\bHearthAndroid\\b\/\.test\(ua\);/);
  assert.match(page, /const files = inApp \? \[\] : cfg\.downloads \|\| \[\];/);
  const render = fnSource(page, 'render');
  assert.match(render, /^function render\(\) \{\n {2}const p = document\.getElementById\('primary'\);\n {2}p\.replaceChildren\(\);\n {2}if \(inApp\) \{[\s\S]*?\n {4}return;\n {2}\}/);
  assert.ok(!/href|desktopUrl/.test(render.slice(render.indexOf('if (inApp)'), render.indexOf('return;'))), 'no link in the app’s version');
});

// ================================================================== 3. privacy policy links
test('play-4: /api/config gives privacyUrl only for an https PRIVACY_URL, and the app shows the links only then', async () => {
  assert.equal(srv.config.privacyUrl, PRIVACY);
  assert.equal((await srv.api('GET', '/config')).json.privacyUrl, PRIVACY);
  assert.equal(bad.config.privacyUrl, null, 'http:// is ignored');
  assert.match(bad.log, /privacy_url_ignored/);
  assert.doesNotMatch(srv.log, /privacy_url_ignored/);
  // The client checks again before using it as a link.
  const js = read('public', 'js', 'app.js');
  const signIn = fnSource(js, 'showSignIn');
  assert.match(signIn, /const privacyUrl = typeof S\.config\.privacyUrl === 'string' && \/\^https:\\\/\\\/\/i\.test\(S\.config\.privacyUrl\) \? S\.config\.privacyUrl : '';/);
  assert.match(signIn, /\$\('#reg-privacy'\)\.hidden = !privacyUrl;\n {2}if \(privacyUrl\) \$\('#reg-privacy-link'\)\.href = privacyUrl;/);
  const html = read('public', 'index.html');
  assert.match(html, /name="tos" required>[^\n]*Terms of Service[^\n]*<\/label>\n\s*<p class="field-hint tos-privacy" id="reg-privacy" hidden>[^<]*<a id="reg-privacy-link" href="#" target="_blank" rel="noopener noreferrer">Privacy policy<\/a><\/p>/);
  const settings = read('public', 'js', 'settings.js');
  assert.match(fnSource(settings, 'privacyLink'), /typeof url === 'string' && \/\^https:\\\/\\\/\/i\.test\(url\) \? h\('a', \{ href: url, target: '_blank', rel: 'noopener noreferrer' \}, 'Privacy policy'\) : null/);
  const account = fnSource(settings, 'accountTab');
  assert.match(account.slice(account.indexOf("section('Delete account'")), /privacyLink\(S\.config\) \? h\('p', \{ class: 'field-hint' \}, 'How this server handles your data: ', privacyLink\(S\.config\)\) : null\),\n {2}\);/);
  assert.match(fnSource(settings, 'appsTab'), /privacyLink\(cfg\) \? section\('Privacy', /);
  // Documented for operators.
  assert.match(read('.env.example'), /^# PRIVACY_URL=https:\/\//m);
  assert.match(read('README.md'), /^\| `PRIVACY_URL` \| — \|/m);
});

test('play-5: the connect screen’s privacy policy link opens in the browser and never becomes the server (javac)', { skip: !hasJava() && 'no JDK (javac) here' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-links-'));
  try {
    const urls = ['https://pandabear445.github.io/Hearth-chat/privacy.html', 'https://pandabear445.github.io/Hearth-chat/', 'https://pandabear445.github.io/',
      'https://pandabear445.github.io/Hearth-chat', 'https://pandabear445.github.io.evil.example/Hearth-chat/privacy.html', 'https://pandabear445.github.io@evil.example/Hearth-chat/',
      'http://pandabear445.github.io/Hearth-chat/privacy.html', 'https://kappachat.duckdns.org/', 'https://chat.example.com/Hearth-chat/', ''];
    const check = `package app.hearth.mobile;
public class LinkCheck {
  public static void main(String[] a) {
    String[] urls = { ${urls.map((u) => JSON.stringify(u)).join(', ')}, null };
    StringBuilder sb = new StringBuilder();
    for (String u : urls) sb.append(BridgePolicy.opensInBrowser(u) ? '1' : '0');
    System.out.println(sb);
  }
}`;
    fs.writeFileSync(path.join(tmp, 'LinkCheck.java'), check);
    execFileSync('javac', ['-d', tmp, path.join(ROOT, 'mobile', 'native', 'BridgePolicy.java'), path.join(tmp, 'LinkCheck.java')], { stdio: 'pipe' });
    assert.equal(execFileSync('java', ['-cp', tmp, 'app.hearth.mobile.LinkCheck'], { encoding: 'utf8' }).trim(), '11000000000');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
function hasJava() { return spawnSync('javac', ['-version'], { stdio: 'ignore' }).status === 0; }

// The app's own backstop, for a server that still shows a way to pay (older than 1.29.1) and for links people post:
// payment pages never open, in the app or in the browser.
test('play-8: the app refuses Stripe and Ko-fi payment pages (javac), before anything else gets the link', () => {
  const main = read('mobile', 'native', 'MainActivity.java');
  const nav = main.slice(main.indexOf('public boolean shouldOverrideUrlLoading('), main.indexOf('public void onPageStarted('));
  assert.match(nav, /if \(BridgePolicy\.isPaymentPage\(url\)\) \{\n\s*Toast\.makeText\(MainActivity\.this, "Payments aren't available in the Android app", Toast\.LENGTH_SHORT\)\.show\(\);\n\s*return true;\n\s*\}/);
  const at = nav.indexOf('BridgePolicy.isPaymentPage(url)');
  assert.ok(at > nav.indexOf('if (isOurs(url)) return false;'), 'after the server’s own pages');
  assert.ok(at < nav.indexOf('setServerOrigin(') && at < nav.indexOf('startActivity('), 'before the connect screen and the browser');
  assert.match(read('mobile', 'native', 'test', 'PushPolicyTest.java'), /public void paymentPagesDontOpenFromTheApp\(\)/);
  if (!hasJava()) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-pay-'));
  try {
    const pay = ['https://checkout.stripe.com/c/pay/cs_test_a1', 'https://buy.stripe.com/test_123', 'https://donate.stripe.com/x', 'https://billing.stripe.com/p/session/x',
      FUNDING, 'https://www.ko-fi.com/hearth', 'https://KO-FI.COM/hearth', 'http://ko-fi.com/hearth', 'https://ko-fi.com./hearth', 'https://ko-fi.com:443/hearth',
      'https://someone@ko-fi.com/hearth', 'https://ko-fi.com', 'https://ko-fi.com?x=1', 'https://ko-fi.com#top'];
    const other = ['https://kappachat.duckdns.org/', 'https://stripe.com/docs', 'https://connect.stripe.com/express/x', 'https://notko-fi.com/x', 'https://ko-fi.com.evil.example/x',
      'https://evil.example/ko-fi.com', 'https://evil.example/?u=https://ko-fi.com', 'https://ko-fi.com@evil.example/', 'https://[::1]:3000/', 'ftp://ko-fi.com/', 'ko-fi.com', '',
      'https://pandabear445.github.io/Hearth-chat/privacy.html'];
    fs.writeFileSync(path.join(tmp, 'PayCheck.java'), `package app.hearth.mobile;
public class PayCheck {
  public static void main(String[] a) {
    String[] urls = { ${[...pay, ...other].map((u) => JSON.stringify(u)).join(', ')}, null };
    StringBuilder sb = new StringBuilder();
    for (String u : urls) sb.append(BridgePolicy.isPaymentPage(u) ? '1' : '0');
    System.out.println(sb);
  }
}`);
    execFileSync('javac', ['-d', tmp, path.join(ROOT, 'mobile', 'native', 'BridgePolicy.java'), path.join(tmp, 'PayCheck.java')], { stdio: 'pipe' });
    assert.equal(execFileSync('java', ['-cp', tmp, 'app.hearth.mobile.PayCheck'], { encoding: 'utf8' }).trim(), '1'.repeat(pay.length) + '0'.repeat(other.length + 1));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('play-6: the connect screen links to Hearth’s privacy policy, and MainActivity sends that link to the browser', () => {
  const site = /static final String SITE = "([^"]+)";/.exec(read('mobile', 'native', 'BridgePolicy.java'))[1];
  assert.equal(site, 'https://pandabear445.github.io/Hearth-chat/');
  const connect = read('mobile', 'www', 'index.html');
  const links = [...connect.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)];
  assert.deepEqual(links.map((l) => [l[1], l[2]]), [[`${site}privacy.html`, 'Privacy policy']], 'one link, to the privacy policy');
  assert.ok(connect.indexOf('Privacy policy') > connect.indexOf('<form class="card"') && connect.indexOf('Privacy policy') < connect.indexOf('</form>'), 'on the card people see');
  // Leaving the connect screen for any other https:// address still sets the server (old web views); the link
  // falls through to "open in the browser", like links from the server's pages.
  const main = read('mobile', 'native', 'MainActivity.java');
  const nav = main.slice(main.indexOf('public boolean shouldOverrideUrlLoading('), main.indexOf('public void onPageStarted('));
  assert.match(nav, /if \(from\.equals\(localOrigin\(\)\) && \(url\.startsWith\("https:\/\/"\) \|\| url\.startsWith\("http:\/\/"\)\) && !BridgePolicy\.opensInBrowser\(url\)\) \{\n\s*setServerOrigin\(originOf\(url\)\);\n\s*return false;/);
  assert.ok(nav.indexOf('BridgePolicy.opensInBrowser(url)') < nav.indexOf('startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())'), 'then on to the browser');
  assert.match(read('mobile', 'native', 'test', 'PushPolicyTest.java'), /public void theConnectScreensPrivacyLinkOpensInTheBrowser\(\)/);
});

// ================================================================== 4. nothing copied off the phone
// The web view's storage holds the session token and the unlocked keys, so Android's backup (to the person's Google
// account) and phone-to-phone transfer are off. The privacy policy says so.
test('play-9: the build turns off Android backup and phone-to-phone transfer, and the merged manifest check insists on it', () => {
  const P = require('../mobile/scripts/patch-android.js');
  const manifest = (app) => `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application ${app} android:label="@string/app_name">
        <activity android:name=".MainActivity" android:launchMode="singleTask" android:exported="true">
        </activity>
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;
  for (const app of ['android:allowBackup="true"', '']) {
    const out = P.patchManifest(manifest(app), { server: '' });
    const tag = /<application\b[^>]*>/.exec(out)[0];
    assert.match(tag, /^<application android:allowBackup="false" android:dataExtractionRules="@xml\/data_extraction_rules" tools:replace="android:allowBackup,android:dataExtractionRules" /, app || 'no allowBackup in the template');
    assert.equal((tag.match(/allowBackup/g) || []).length, 2, 'set once (and named in tools:replace)');
    assert.match(out, /<manifest xmlns:tools="http:\/\/schemas\.android\.com\/tools" xmlns:android=/);
    assert.ok(!P.checkMerged(out).some((x) => /allowBackup|data_extraction/.test(x)));
  }
  assert.throws(() => P.patchManifest(manifest('android:dataExtractionRules="@xml/other"')), /backup rules/);
  assert.throws(() => P.patchManifest(manifest('android:fullBackupContent="@xml/other"')), /backup rules/);
  const merged = P.patchManifest(manifest('android:allowBackup="true"'));
  assert.ok(P.checkMerged(merged.replace('android:allowBackup="false"', 'android:allowBackup="true"')).includes('<application> must have android:allowBackup="false"'));
  assert.ok(P.checkMerged(merged.replace(/ android:dataExtractionRules="[^"]*"/, '')).includes('<application> must use @xml/data_extraction_rules'));
  // The rules leave out every place the app keeps data, for the backup and for a transfer. They're copied in with
  // the status bar icon (native/res).
  const rules = read('mobile', 'native', 'res', 'xml', 'data_extraction_rules.xml');
  for (const part of ['cloud-backup', 'device-transfer']) {
    const body = new RegExp(`<${part}>([\\s\\S]*?)</${part}>`).exec(rules)[1];
    assert.doesNotMatch(body, /<include\b/, part);
    for (const d of ['root', 'file', 'database', 'sharedpref', 'external']) assert.match(body, new RegExp(`<exclude domain="${d}" path="\\." />`), `${part}: ${d}`);
  }
  assert.match(read('mobile', 'scripts', 'patch-android.js'), /copyDir\(path\.join\(native, 'res'\), path\.join\(dir, 'app', 'src', 'main', 'res'\)\)/);
  const privacy = path.join(ROOT, '..', 'privacy.html');
  if (fs.existsSync(privacy)) assert.match(fs.readFileSync(privacy, 'utf8'), /turns off Android's own backup and phone-to-phone transfer/);
});

// ================================================================== the real client, as a browser and as the app
function findPlaywright() {
  for (const p of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright']) {
    if (!p) continue;
    try { return require(p); } catch { /* next */ }
  }
  try { return require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')); } catch { return null; }
}
const PW = findPlaywright();
// Stands in for the app's native half: window.HearthAndroid, answering the page's hello as MainActivity does.
function fakeAppBridge() {
  if (window.HearthAndroid) return;
  const bridge = {
    onmessage: null,
    postMessage(raw) {
      const m = JSON.parse(raw);
      if (m.type === 'hello') setTimeout(() => bridge.onmessage && bridge.onmessage({ data: JSON.stringify({ type: 'info', version: '1.29.1', notify: 'granted', server: location.origin, call: true }) }), 5);
    },
  };
  window.HearthAndroid = bridge;
}

test('play-7: in Chromium, a browser shows the ways to pay and downloads as before; the app shows none of them, and both show the privacy policy', { skip: !PW && 'Playwright is not installed', timeout: 240000 }, async () => {
  const { signUp, settle } = await import(pathToFileURL(path.join(ROOT, 'test', 'browser', 'harness.mjs')).href);
  const exe = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => fs.existsSync(p));
  const browser = await PW.chromium.launch({ executablePath: exe, args: ['--proxy-server=direct://'] });
  const errors = [];
  const open = async (opts = {}, init) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    return page;
  };
  const menuItems = async (page) => {
    await page.click('#user-panel .me-btn');
    await page.waitForSelector('.menu.status-menu');
    const items = await page.locator('.menu.status-menu .menu-item').allInnerTexts();
    await page.keyboard.press('Escape');
    await page.waitForSelector('.menu.status-menu', { state: 'detached', timeout: 5000 }).catch(() => {});
    return items;
  };
  const openSettingsTab = async (page, tab) => {
    if (!(await page.locator('.settings-modal').count())) await page.click('#user-panel button[aria-label="Settings"]');
    await page.locator('.set-nav .set-nav-btn', { hasText: tab }).click();
    await settle(page, 200);
  };
  const privacyHref = (page) => page.locator(`.set-content a[href="${PRIVACY}"]`).evaluateAll((as) => as.map((a) => [a.textContent, a.target, a.rel]));
  try {
    // ---- a browser: everything as before, plus the privacy policy
    const web = await open();
    await web.goto(srv.base);
    await web.click('#to-register');
    assert.equal(await web.locator('#reg-privacy').isVisible(), true, 'the privacy policy at sign-up');
    assert.equal(await web.locator('#reg-privacy-link').getAttribute('href'), PRIVACY);
    await signUp(web, srv.base, 'webuser');
    await web.waitForSelector('.fund-card');
    assert.match(await web.locator('.fund-card').innerText(), /Chip in/);
    const webMenu = await menuItems(web);
    assert.ok(webMenu.some((t) => /Support Hearth/.test(t)), `the Support item (${webMenu.join(' | ')})`);
    // The Support window links to the owner's donation link.
    await web.click('.fund-card .btn.primary');
    await web.waitForSelector('.support-modal');
    assert.equal(await web.locator(`.support-modal a[href="${FUNDING}"]`).count(), 1);
    await web.keyboard.press('Escape');
    await web.waitForSelector('.support-modal', { state: 'detached' });
    await openSettingsTab(web, 'Apps & devices');
    assert.equal(await web.locator('.set-content a[href="/download"]').count(), 1, 'the Download page link');
    assert.match(await web.locator('.set-content').innerText(), /Send friends this link to get the app/);
    assert.deepEqual(await privacyHref(web), [['Privacy policy', '_blank', 'noopener noreferrer']]);
    await openSettingsTab(web, 'Security');
    assert.deepEqual(await privacyHref(web), [['Privacy policy', '_blank', 'noopener noreferrer']]);

    // ---- the Android app: no way to pay, no downloads, the same privacy links
    const app = await open({ userAgent: APP_UA }, fakeAppBridge);
    await app.goto(srv.base);
    await app.click('#to-register');
    assert.equal(await app.locator('#reg-privacy').isVisible(), true);
    await signUp(app, srv.base, 'appuser');
    assert.equal(await app.evaluate(() => !!window.HearthAndroid), true);
    await settle(app, 500);
    assert.equal(await app.locator('.fund-card').count(), 0, 'no funding card on Home');
    assert.equal(await app.locator('.home-view').count(), 1, 'Home is showing');
    const appMenu = await menuItems(app);
    assert.ok(appMenu.length > 3 && !appMenu.some((t) => /Support/.test(t)), `no Support item (${appMenu.join(' | ')})`);
    // And no link to the donation page anywhere: Home, the menu on your name, every Settings tab.
    const noFunding = async (where) => assert.equal(await app.locator(`a[href="${FUNDING}"]`).count(), 0, `a donation link in ${where}`);
    await noFunding('Home');
    await app.click('#user-panel .me-btn');
    await app.waitForSelector('.menu.status-menu');
    await noFunding('the menu on your name');
    await app.keyboard.press('Escape');
    await app.waitForSelector('.menu.status-menu', { state: 'detached', timeout: 5000 }).catch(() => {});
    await app.click('#user-panel button[aria-label="Settings"]');
    await app.waitForSelector('.settings-modal .set-nav');
    const navBtn = '.set-nav .set-nav-btn:not(.danger)'; // not Log out
    const tabs = await app.locator(navBtn).allInnerTexts();
    assert.ok(tabs.length >= 8, `Settings tabs (${tabs.join(' | ')})`);
    let seen = 0;
    for (let i = 0; i < tabs.length; i++) {
      await app.locator(navBtn).nth(i).click();
      await settle(app, 200);
      const subs = await app.locator('.set-subtabs .set-subtab').count();
      for (let j = 0; j < Math.max(1, subs); j++) {
        if (subs) { await app.locator('.set-subtabs .set-subtab').nth(j).click(); await settle(app, 200); }
        await noFunding(`Settings \u2192 ${tabs[i].trim()}${subs ? ` \u2192 ${(await app.locator('.set-subtabs .set-subtab').nth(j).innerText()).trim()}` : ''}`);
        seen++;
      }
    }
    assert.ok(seen > tabs.length, `looked at the sub-tabs too (${seen})`);
    await openSettingsTab(app, 'Apps & devices');
    const appsText = await app.locator('.set-content').innerText();
    assert.match(appsText, /You’re using the Hearth Android app/);
    assert.equal(await app.locator('.set-content a[href="/download"]').count(), 0, 'no Download page link');
    assert.doesNotMatch(appsText, /Send friends this link|Desktop app/);
    assert.deepEqual(await privacyHref(app), [['Privacy policy', '_blank', 'noopener noreferrer']]);
    await openSettingsTab(app, 'Security');
    assert.deepEqual(await privacyHref(app), [['Privacy policy', '_blank', 'noopener noreferrer']]);

    // ---- /download: the app gets no files; a phone's browser and a computer still get the APK and the installer
    await app.goto(srv.base + '/download');
    await app.waitForSelector('#primary h2');
    assert.match(await app.locator('#primary').innerText(), /You’re using the Hearth Android app/);
    assert.equal(await app.locator('a[href*="/downloads/"]').count(), 0, 'no download in the app');
    const phone = await open({ userAgent: PHONE_UA });
    await phone.goto(srv.base + '/download');
    await phone.waitForSelector('#primary a[href$=".apk"]');
    assert.match(await phone.locator('#primary').innerText(), /Download the Android app/);
    await web.goto(srv.base + '/download');
    await web.waitForSelector('#all a[href$=".exe"]');
    assert.equal(await web.locator('#all a[href$=".apk"]').count(), 1, 'the Android card lists the APK in a browser');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
