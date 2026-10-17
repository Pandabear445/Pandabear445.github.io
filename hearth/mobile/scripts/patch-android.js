#!/usr/bin/env node
// Adds Hearth's own parts to the Android project that `npx cap add android` generates (there's no committed
// android/ folder; the "Hearth apps" workflow builds it fresh every time):
//   - the UnifiedPush library, at an exact version (notifications while the app is closed);
//   - HearthPushService (unexported, only the library's PUSH_EVENT reaches it) and CallService (a foreground
//     service of type "microphone" that keeps a call going with the screen locked), with the permissions
//     Android needs for the latter;
//   - invite links: hearth://invite/CODE, and https://SERVER/invite/CODE when the app is built for one server
//     (HEARTH_SERVER), as a verified App Link (the server publishes /.well-known/assetlinks.json);
//   - the status bar icon (native/res) and the app's unit tests (native/test, run by testReleaseUnitTest).
//
// Usage (from hearth/mobile, after `npx cap add android` and copying native/*.java):
//   node scripts/patch-android.js android                       patch android/ (SERVER: the baked-in server)
//   node scripts/patch-android.js --check-merged <manifest>    check the merged manifest of a release build
// The pure functions are exported for test/android-push.test.js. No dependencies.
'use strict';
const fs = require('fs');
const path = require('path');

// Bump by hand after reading the release notes (https://codeberg.org/UnifiedPush/android-connector), then let
// the android job prove it still compiles. Never a range: what's built is exactly what was reviewed.
const CONNECTOR = 'org.unifiedpush.android:connector:3.3.5';
const MARK = '<!-- added by the Hearth build -->';

const PERMISSIONS = [
  // Android 9+: any foreground service. Android 14+: one permission per service type (CallService: microphone).
  // https://developer.android.com/develop/background-work/services/fgs/declare
  // https://developer.android.com/about/versions/14/changes/fgs-types-required
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
];

const SERVICES = `
        ${MARK}
        <service android:name=".HearthPushService" android:exported="false">
            <intent-filter><action android:name="org.unifiedpush.android.connector.PUSH_EVENT" /></intent-filter>
        </service>
        <service android:name=".CallService" android:exported="false" android:foregroundServiceType="microphone" android:stopWithTask="true" />
`;

// https://SERVER for an App Link: a plain https origin, nothing else ('' when there's none to add).
function appLinkHost(server) {
  if (!server) return null;
  let u;
  try { u = new URL(String(server).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !/^[a-z0-9.-]+$/i.test(u.hostname)) return null;
  return { host: u.hostname.toLowerCase(), port: u.port || '' };
}

function inviteFilters(server) {
  const out = [`
            ${MARK}
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="hearth" android:host="invite" />
            </intent-filter>`];
  const link = appLinkHost(server);
  if (link) {
    out.push(`
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="${link.host}"${link.port ? ` android:port="${link.port}"` : ''} android:pathPrefix="/invite/" />
            </intent-filter>`);
  }
  return out.join('');
}

// The generated AndroidManifest.xml with Hearth's additions. Throws if it doesn't look like Capacitor's template
// or was patched already (so a changed template fails the build instead of shipping without push).
function patchManifest(xml, { server = '' } = {}) {
  if (xml.includes(MARK)) throw new Error('AndroidManifest.xml is already patched');
  if (!xml.includes('</application>')) throw new Error('AndroidManifest.xml has no </application>');
  const internet = /<uses-permission android:name="android\.permission\.INTERNET" \/>/;
  if (!internet.test(xml)) throw new Error('AndroidManifest.xml has no INTERNET permission line to add to');
  const act = /<activity\b[^>]*android:name="\.MainActivity"[^>]*>[\s\S]*?<\/activity>/.exec(xml);
  if (!act) throw new Error('AndroidManifest.xml has no .MainActivity');
  if (!/android:launchMode="singleTask"/.test(act[0])) throw new Error('.MainActivity must be singleTask (links reach the running app)');
  let out = xml.replace(act[0], act[0].replace(/\s*<\/activity>$/, `${inviteFilters(server)}\n\n        </activity>`));
  out = out.replace('</application>', `${SERVICES}    </application>`);
  out = out.replace(internet, (m) => `${m}\n    ${PERMISSIONS.map((p) => `<uses-permission android:name="${p}" />`).join('\n    ')}`);
  return out;
}

// Appended to android/app/build.gradle.
function gradleAdditions() {
  return `
// ---- added by the Hearth build: UnifiedPush (an exact version; bump by hand, see mobile/README.md)
dependencies {
    implementation "${CONNECTOR}"
}
`;
}

function copyDir(from, to, filter = () => true) {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name); const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyDir(a, b, filter);
    else if (filter(e.name)) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(a, b); n++; }
  }
  return n;
}

// The start tag of the element `kind` whose android:name ends with `name`, and everything up to its end tag.
function element(xml, kind, name) {
  const re = new RegExp(`<${kind}\\b[^>]*>`, 'g');
  for (let m; (m = re.exec(xml));) {
    const nm = /android:name="([^"]+)"/.exec(m[0]);
    if (!nm || !(nm[1] === name || nm[1].endsWith('.' + name))) continue;
    if (m[0].endsWith('/>')) return { tag: m[0], body: '' };
    const end = xml.indexOf(`</${kind}>`, m.index);
    return { tag: m[0], body: end < 0 ? '' : xml.slice(m.index, end) };
  }
  return null;
}

// What must be true of the manifest that ends up in the APK. Returns a list of problems (empty: fine).
function checkMerged(xml) {
  const problems = [];
  const push = element(xml, 'service', 'HearthPushService');
  if (!push) problems.push('HearthPushService is missing');
  else {
    if (!/android:exported="false"/.test(push.tag)) problems.push('HearthPushService must be exported="false"');
    if (!push.body.includes('org.unifiedpush.android.connector.PUSH_EVENT')) problems.push('HearthPushService must take PUSH_EVENT');
  }
  if (!element(xml, 'receiver', 'MessagingReceiverImpl')) problems.push("the UnifiedPush library's MessagingReceiverImpl is missing");
  const call = element(xml, 'service', 'CallService');
  if (!call) problems.push('CallService is missing');
  else {
    if (!/android:exported="false"/.test(call.tag)) problems.push('CallService must be exported="false"');
    if (!/android:foregroundServiceType="microphone"/.test(call.tag)) problems.push('CallService must be a microphone foreground service');
  }
  for (const p of PERMISSIONS) if (!xml.includes(`android:name="${p}"`)) problems.push(`permission ${p} is missing`);
  if (!/android:scheme="hearth"/.test(xml)) problems.push('the hearth://invite link filter is missing');
  return problems;
}

function main(argv) {
  if (argv[0] === '--check-merged') {
    const file = argv[1];
    if (!file || !fs.existsSync(file)) { console.error(`No merged manifest found (${file || 'none given'}).`); return 1; }
    const problems = checkMerged(fs.readFileSync(file, 'utf8'));
    if (problems.length) { console.error(`Merged manifest ${file}:\n  - ${problems.join('\n  - ')}`); return 1; }
    console.log(`Merged manifest OK: ${file}`);
    return 0;
  }
  const dir = argv[0];
  if (!dir || !fs.existsSync(path.join(dir, 'app'))) { console.error('Usage: node scripts/patch-android.js <android project folder> | --check-merged <file>'); return 2; }
  const native = path.join(__dirname, '..', 'native');
  const manifest = path.join(dir, 'app', 'src', 'main', 'AndroidManifest.xml');
  const server = process.env.SERVER || '';
  fs.writeFileSync(manifest, patchManifest(fs.readFileSync(manifest, 'utf8'), { server }));
  fs.appendFileSync(path.join(dir, 'app', 'build.gradle'), gradleAdditions());
  const res = copyDir(path.join(native, 'res'), path.join(dir, 'app', 'src', 'main', 'res'));
  const tests = copyDir(path.join(native, 'test'), path.join(dir, 'app', 'src', 'test', 'java', 'app', 'hearth', 'mobile'), (n) => n.endsWith('.java'));
  const link = appLinkHost(server);
  console.log(`Patched ${dir}: UnifiedPush ${CONNECTOR.split(':').pop()}, push and call services, invite links (hearth://${link ? ` and https://${link.host}${link.port ? ':' + link.port : ''}` : ''}), ${res} resource(s), ${tests} test file(s).`);
  return 0;
}

module.exports = { patchManifest, gradleAdditions, checkMerged, appLinkHost, CONNECTOR, PERMISSIONS };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
