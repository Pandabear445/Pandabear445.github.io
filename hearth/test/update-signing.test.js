// Signed server updates (admin-11): scripts/update-key.js signs update zips, scripts/make-update-zip.sh writes the
// .sig, hearth-update refuses a zip that isn't signed with the key this server pinned (before anything in it is
// unpacked or run), and a new key is only taken from an update the old key signed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const K = require('../scripts/update-key');
const UV = require('../desktop/update-verify');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-signing-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
// A fresh key pair for each use (no key material in this file).
function keyPair() {
  const k = UV.generateKeys();
  return { pem: k.privateKeyPem, pub: k.publicKey, priv: UV.loadPrivateKey(k.privateKeyPem) };
}
const signZip = (zip, key) => fs.writeFileSync(`${zip}.sig`, K.sign(sha(zip), key.priv) + '\n');
const CLI = path.join(ROOT, 'scripts/update-key.js');
const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HEARTH_UPDATE_KEY: '', HEARTH_UPDATE_KEY_FILE: '', ...env } });

// ------------------------------------------------------------------ scripts/update-key.js
test('a server update signature only verifies for the same zip, the same key and the server-update label', () => {
  const a = keyPair(); const b = keyPair();
  const sum = crypto.randomBytes(32).toString('hex');
  const sig = K.sign(sum, a.priv);
  assert.match(sig, K.SIG_RE);
  assert.equal(K.verify(sum, sig, a.pub), true, 'good signature');
  assert.equal(K.verify(sum.toUpperCase(), sig, a.pub), true, 'the hash is compared in lower case');
  assert.equal(K.verify(sum, sig, K.pubFileText(a.pub)), true, 'an update-signing.pub file (with its comments) works as the key');
  assert.equal(K.verify(sum, sig, b.pub), false, 'another key');
  const other = crypto.randomBytes(32).toString('hex');
  assert.equal(K.verify(other, sig, a.pub), false, 'another zip');
  // The same key used for something else never passes as a server update: the desktop label, no label at all,
  // or the desktop app's own signature format.
  const raw = (msg) => crypto.sign(null, Buffer.from(msg), a.priv).toString('base64');
  assert.equal(K.verify(sum, raw(`hearth-update-v1\n${sum}\n`), a.pub), false, 'desktop label');
  assert.equal(K.verify(sum, raw(`${sum}\n`), a.pub), false, 'no label');
  assert.equal(K.verify(sum, raw(sum), a.pub), false, 'just the hash');
  assert.equal(K.verify(sum, UV.sign('latest.yml', Buffer.from(sum), a.priv), a.pub), false, 'a desktop update signature');
  assert.equal(K.signedMessage(sum).toString(), `hearth-server-update-v1\n${sum}\n`);
  // Garbage never throws, it just doesn't verify.
  for (const s of ['', 'x', sig.slice(0, 80), `${sig}AA`, '!'.repeat(88), null, undefined]) assert.equal(K.verify(sum, s, a.pub), false, String(s));
  assert.equal(K.verify('not-a-hash', sig, a.pub), false);
  assert.equal(K.verify(sum, sig, 'not a key'), false);
  // Key files: comments are fine, anything but one Ed25519 public key isn't.
  assert.equal(K.readPublicKey(`# comment\n\n  ${a.pub}  \r\n`), a.pub);
  assert.throws(() => K.readPublicKey(''), /not an Ed25519 public key/);
  assert.throws(() => K.readPublicKey(`${a.pub}\n${b.pub}`), /not an Ed25519 public key/);
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => K.readPublicKey(p256), /not an Ed25519 public key/);
  assert.equal(K.readSig(`\r\n  ${sig}  \r\nmore\n`), sig);
});

test('update-key.js keygen keeps the private key private, never overwrites it, and never prints it', () => {
  const t = tmp();
  try {
    const key = path.join(t, 'keys', 'update-signing.key');
    const pub = path.join(t, 'update-signing.pub');
    const r = cli(['keygen', '--key', key, '--pub', pub]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.statSync(key).mode & 0o777, 0o600, 'only its owner can read the private key');
    assert.equal(fs.statSync(path.dirname(key)).mode & 0o777, 0o700);
    const pem = fs.readFileSync(key, 'utf8');
    assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE KEY|MC4CAQAwBQYDK2Vw/, 'the private key is never printed');
    const p = K.readPublicKey(fs.readFileSync(pub, 'utf8'));
    assert.equal(p, K.publicKeyOf(K.loadPrivateKey(pem)), 'update-signing.pub is the matching public half');
    assert.match(fs.readFileSync(pub, 'utf8'), /^# Hearth server update signing key/);
    assert.ok(r.stdout.includes(p));
    // A second keygen refuses: replacing the key would lock out every server that pinned it.
    const again = cli(['keygen', '--key', key, '--pub', pub]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
    assert.equal(fs.readFileSync(key, 'utf8'), pem);
    assert.equal(K.readPublicKey(fs.readFileSync(pub, 'utf8')), p);
    // A second key for a key change says what to do with the old one.
    const next = cli(['keygen', '--key', path.join(t, 'keys', 'next.key'), '--pub', pub]);
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /sign the next update with the OLD private key/);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test('update-key.js sign and verify: from a key file, HEARTH_UPDATE_KEY, HEARTH_UPDATE_KEY_FILE or the default place', () => {
  const t = tmp();
  try {
    const home = path.join(t, 'home');
    fs.mkdirSync(home);
    const a = keyPair(); const b = keyPair();
    const keyFile = path.join(t, 'a.key');
    fs.writeFileSync(keyFile, a.pem, { mode: 0o600 });
    const pubA = path.join(t, 'a.pub'); fs.writeFileSync(pubA, K.pubFileText(a.pub));
    const pubB = path.join(t, 'b.pub'); fs.writeFileSync(pubB, K.pubFileText(b.pub));
    const zip = path.join(t, 'hearth-update-9.9.9.zip');
    fs.writeFileSync(zip, crypto.randomBytes(2048));
    const env = { HOME: home, USERPROFILE: home };

    // No key anywhere: has-key says so, sign refuses and writes nothing.
    assert.equal(cli(['has-key'], env).status, 1);
    let r = cli(['sign', zip], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No update signing key/);
    assert.ok(!fs.existsSync(`${zip}.sig`));

    r = cli(['sign', zip, '--key', keyFile], env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(a.pub));
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE KEY|Warning/);
    if (process.platform !== 'win32') {
      // A key file other accounts can read still signs, with a warning saying how to fix it.
      fs.chmodSync(keyFile, 0o644);
      r = cli(['sign', zip, '--key', keyFile], env);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /can be read by other accounts .*chmod 600/);
      fs.chmodSync(keyFile, 0o600);
    }
    assert.equal(K.verify(sha(zip), K.readSig(fs.readFileSync(`${zip}.sig`, 'utf8')), a.pub), true);
    assert.equal(cli(['verify', zip, '--pub', pubA], env).status, 0);
    r = cli(['verify', zip, '--pub', pubB], env);
    assert.equal(r.status, 1, 'another key');
    assert.match(r.stderr, /doesn't match/);
    // The key itself in the environment (a CI secret), as PEM or base64 of the PEM.
    for (const text of [a.pem, Buffer.from(a.pem).toString('base64')]) {
      fs.rmSync(`${zip}.sig`);
      assert.equal(cli(['sign', zip], { ...env, HEARTH_UPDATE_KEY: text }).status, 0);
      assert.equal(cli(['verify', zip, '--pub', pubA], env).status, 0);
    }
    // A key file named in the environment, and the default place.
    assert.equal(cli(['public'], { ...env, HEARTH_UPDATE_KEY_FILE: keyFile }).stdout.trim(), a.pub);
    fs.mkdirSync(path.join(home, '.config', 'hearth'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'hearth', 'update-signing.key'), b.pem, { mode: 0o600 });
    assert.equal(cli(['has-key'], env).status, 0);
    assert.equal(cli(['sign', zip], env).status, 0);
    assert.equal(cli(['verify', zip, '--pub', pubB], env).status, 0, 'signed with the default key');
    assert.equal(cli(['sign', zip], { ...env, HEARTH_UPDATE_KEY_FILE: keyFile }).status, 0);
    assert.equal(cli(['verify', zip, '--pub', pubA], env).status, 0, 'HEARTH_UPDATE_KEY_FILE comes before the default');
    // A changed zip, a missing or broken .sig, a broken key: refused.
    const sig = fs.readFileSync(`${zip}.sig`);
    fs.appendFileSync(zip, 'x');
    assert.equal(cli(['verify', zip, '--pub', pubA], env).status, 1, 'tampered');
    fs.rmSync(`${zip}.sig`);
    r = cli(['verify', zip, '--pub', pubA], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /isn't signed/);
    fs.writeFileSync(`${zip}.sig`, 'not a signature\n');
    assert.equal(cli(['verify', zip, '--pub', pubA], env).status, 1);
    assert.ok(sig.length > 0);
    const bad = path.join(t, 'bad.key');
    fs.writeFileSync(bad, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    r = cli(['sign', zip, '--key', bad], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a usable Ed25519 private key/);
    assert.doesNotMatch(r.stderr, /UPDATE_SIGNING_KEY/, 'not the desktop secret\'s name');
    assert.equal(cli(['nonsense'], env).status, 1);
    assert.equal(cli(['sign', zip, '--key'], env).status, 1);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ hearth-update.sh
const stub = (dir, name, body) => { fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }); };
const shellSkip = !['bash', 'zip', 'unzip', 'rsync', 'sha256sum', 'tar', 'flock', 'openssl', 'base64'].every(has) && 'needs bash, zip, unzip, rsync, openssl';

// A fake plain-node install (run as root) and update zips for it. Stubs for everything that would touch the real
// system (id says root; node, npm and curl only write to a log), so only openssl, unzip and friends are real.
// installedKey: the update-signing.pub the installed Hearth came with. Each zip may carry a key, a version and
// its own updater script.
// openssl: true (the real one, 3.0 or newer), '1.1.1' (no -rawin, no Ed25519 in pkeyutl, like Ubuntu 20.04's),
// false (fails everything) or 'yes' (says yes to everything). node: whether `node -e` runs the real Node.
function lab({ installedKey, installed = '1.0.0', openssl = true, node = true } = {}) {
  const t = tmp();
  const app = path.join(t, 'app');
  for (const d of ['server', 'data', 'node_modules']) fs.mkdirSync(path.join(app, d), { recursive: true });
  fs.writeFileSync(path.join(app, 'server/index.js'), '// old\n');
  fs.writeFileSync(path.join(app, 'server/proxytrust.js'), '// already the new rule\n');
  fs.writeFileSync(path.join(app, 'package.json'), `{\n  "version": "${installed}"\n}\n`);
  fs.writeFileSync(path.join(app, 'package-lock.json'), '{"lock":1}\n');
  fs.writeFileSync(path.join(app, 'data/hearth.db'), '');
  if (installedKey) fs.writeFileSync(path.join(app, 'update-signing.pub'), K.pubFileText(installedKey.pub), { mode: 0o644 });
  fs.chmodSync(app, 0o755); // (whatever the umask: only root may change the folder the installed key is in)
  for (const f of ['server/index.js', 'package.json']) fs.utimesSync(path.join(app, f), new Date('2020-01-01'), new Date('2020-01-01'));
  fs.mkdirSync(path.join(t, 'etc'));
  const pin = path.join(t, 'etc', 'hearth-update.pub');
  let n = 0;
  // An update zip: version, the key it carries, what its server/index.js says, its own updater.
  const zip = ({ version = '1.0.1', key, body = '// new\n', updater } = {}) => {
    const src = path.join(t, `src${++n}`, 'hearth');
    for (const d of ['server', 'scripts']) fs.mkdirSync(path.join(src, d), { recursive: true });
    fs.writeFileSync(path.join(src, 'server/index.js'), body);
    fs.copyFileSync(path.join(ROOT, 'server/proxytrust.js'), path.join(src, 'server/proxytrust.js'));
    fs.writeFileSync(path.join(src, 'package.json'), `{\n  "version": "${version}"\n}\n`);
    fs.writeFileSync(path.join(src, 'package-lock.json'), '{"lock":1}\n');
    if (updater != null) fs.writeFileSync(path.join(src, 'scripts/hearth-update.sh'), updater);
    else fs.copyFileSync(path.join(ROOT, 'scripts/hearth-update.sh'), path.join(src, 'scripts/hearth-update.sh'));
    if (key) fs.writeFileSync(path.join(src, 'update-signing.pub'), K.pubFileText(key.pub));
    // A different time for each zip's files (rsync skips files whose size and time match).
    const when = new Date(Date.UTC(2021, 0, n));
    for (const f of ['server/index.js', 'package.json']) fs.utimesSync(path.join(src, f), when, when);
    const z = path.join(t, `hearth-update-${n}.zip`);
    execFileSync('zip', ['-qr', z, 'hearth'], { cwd: path.dirname(src) });
    return z;
  };
  const bin = path.join(t, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(t, 'calls.log');
  const log = `>> "${calls}"`;
  stub(bin, 'id', 'if [ "$*" = "-u" ]; then echo 0; else PATH=/usr/bin:/bin exec id "$@"; fi');
  // (Run as an ordinary user, the test's own files count as root's, as they would be on a server.)
  stub(bin, 'stat', `me="$(PATH=/usr/bin:/bin id -u)"
if [ "$1" = -c ] && [ "$2" = %U ]; then echo root
elif [ "$1" = -c ] && [ "$2" = '%u %a' ] && [ "$me" != 0 ]; then
  o="$(PATH=/usr/bin:/bin stat -c '%u %a' "$3")" || exit 1; u="\${o%% *}"; [ "$u" = "$me" ] && u=0; echo "$u \${o#* }"
else PATH=/usr/bin:/bin exec stat "$@"; fi`);
  // node -e is the signature check on servers whose OpenSSL can't do it; anything else only goes to the log.
  stub(bin, 'node', `if [ "$1" = -e ]; then ${node ? `exec "${process.execPath}" "$@"` : 'echo "node: not here" >&2; exit 127'}; fi; echo "node $*" ${log}`);
  stub(bin, 'npm', `echo "npm $*" ${log}; mkdir -p node_modules`);
  stub(bin, 'curl', 'echo \'{"name":"Hearth"}\'');
  stub(bin, 'pgrep', 'exit 1');
  for (const c of ['docker', 'docker-compose', 'pm2', 'apt-get', 'systemctl']) stub(bin, c, 'exit 1');
  if (openssl === false) stub(bin, 'openssl', 'exit 1'); // an OpenSSL without Ed25519
  if (openssl === 'yes') stub(bin, 'openssl', 'exit 0'); // something that says yes to every signature
  // OpenSSL 1.1.1: pkeyutl has no -rawin, and without it can't use an Ed25519 key.
  if (openssl === '1.1.1') stub(bin, 'openssl', 'case " $* " in *" -rawin "*) echo "pkeyutl: Option unknown option -rawin" >&2 ;; *) echo "EVP_PKEY_verify_init: operation not supported for this keytype" >&2 ;; esac; exit 1');
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HEARTH_DIR: app, HEARTH_BACKUP_ROOT: path.join(t, 'backups'),
    HEARTH_UPDATE_CONF: path.join(t, 'conf'), HEARTH_UPDATE_BIN: path.join(t, 'hearth-update'), HEARTH_UPDATE_LOCK: path.join(t, 'lock'),
    HEARTH_UPDATE_PUBKEY: pin,
  };
  // runWith: from another folder (cwd), another copy of the updater (script), under another umask.
  const runWith = ({ cwd, script = path.join(ROOT, 'scripts/hearth-update.sh'), umask } = {}, ...args) => {
    const cmd = umask ? ['sh', ['-c', `umask ${umask}; exec bash "$@"`, 'sh', script, ...args]] : ['bash', [script, ...args]];
    const r = spawnSync(cmd[0], cmd[1], { env, cwd, encoding: 'utf8', timeout: 60000, input: '' });
    return { ...r, out: r.stdout + r.stderr };
  };
  const run = (...args) => runWith({}, ...args);
  const calls_ = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  const backups = () => (fs.existsSync(path.join(t, 'backups')) ? fs.readdirSync(path.join(t, 'backups')).filter((f) => /^\d{4}-/.test(f)) : []);
  const index = () => fs.readFileSync(path.join(app, 'server/index.js'), 'utf8');
  const pinned = () => (fs.existsSync(pin) ? K.readPublicKey(fs.readFileSync(pin, 'utf8')) : null);
  const version = () => JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version;
  // Hearth is started in the background: wait until the stub has run as often as expected.
  const started = async (times = 1) => { for (let i = 0; i < 50 && (calls_().match(/^node server\/index\.js/gm) || []).length < times; i++) await sleep(100); };
  // Nothing was changed: same program files, no new backup, nothing run.
  const unchanged = (before) => {
    assert.equal(index(), before.index);
    assert.deepEqual(backups(), before.backups, 'not even a backup was started');
    assert.equal(calls_(), before.calls, 'nothing was built or started');
  };
  const snapshot = () => ({ index: index(), backups: backups(), calls: calls_() });
  return { t, app, pin, env, zip, run, runWith, calls: calls_, backups, index, pinned, version, started, unchanged, snapshot, done: () => fs.rmSync(t, { recursive: true, force: true }) };
}

test('no key pinned yet: an unsigned update installs as before (checksum) and says it is not signed', { skip: shellSkip }, async () => {
  const L = lab();
  try {
    const z = L.zip();
    fs.writeFileSync(`${z}.sha256`, `${sha(z)}  ${path.basename(z)}\n`);
    const r = L.run('--yes', z);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Checksum matches/);
    assert.match(r.out, /isn't signed \(no hearth-update-1\.zip\.sig next to it\)\. This server has no update signing key pinned yet/);
    assert.equal(L.index(), '// new\n');
    assert.equal(L.pinned(), null, 'nothing to pin');
    await L.started();
    // A signed zip on a server without a key: installed, and it says the signature couldn't be checked.
    const s = L.zip({ version: '1.0.2' });
    signZip(s, keyPair());
    const r2 = L.run('--yes', s);
    assert.equal(r2.status, 0, r2.out);
    assert.match(r2.out, /is signed, but this server has no update signing key pinned yet/);
    await L.started(2);
  } finally { L.done(); }
});

test('the first update that brings a key pins it; afterwards only zips signed with that key are installed', { skip: shellSkip }, async () => {
  const L = lab();
  const a = keyPair(); const b = keyPair();
  try {
    const first = L.run('--yes', L.zip({ key: a }));
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /now only installs updates signed with the key this update brought/);
    assert.equal(L.pinned(), a.pub);
    assert.equal(fs.statSync(L.pin).mode & 0o777, 0o644);
    await L.started();
    const before = L.snapshot();

    // Unsigned: refused before anything is unpacked or run, and the operator is told the way out.
    let z = L.zip({ version: '1.0.2', key: a, body: '// attacker\n' });
    let r = L.run('--yes', z);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /isn't signed \(no hearth-update-\d+\.zip\.sig next to it\)\. Nothing was changed/);
    assert.match(r.out, /only installs updates signed with its update key/);
    assert.match(r.out, /--allow-unsigned/);
    L.unchanged(before);
    // Signed with another key.
    signZip(z, b);
    r = L.run('--yes', z);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /doesn't match this server's update key/);
    L.unchanged(before);
    // The right key, but over something else: another label, or the hash alone.
    for (const msg of [`hearth-update-v1\n${sha(z)}\n`, sha(z), `${sha(z)}\n`]) {
      fs.writeFileSync(`${z}.sig`, crypto.sign(null, Buffer.from(msg), a.priv).toString('base64') + '\n');
      r = L.run('--yes', z);
      assert.notEqual(r.status, 0, msg);
      assert.match(r.out, /doesn't match this server's update key/);
    }
    // A .sig that isn't one.
    fs.writeFileSync(`${z}.sig`, '$(touch /nonexistent)\n');
    r = L.run('--yes', z);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /\.sig that isn't a signature/);
    L.unchanged(before);
    // A swapped zip with a matching .sha256, next to the published zip's real signature.
    const real = L.zip({ version: '1.0.2', key: a });
    signZip(real, a);
    const swapped = L.zip({ version: '1.0.2', key: a, body: '// attacker\n' });
    fs.copyFileSync(`${real}.sig`, `${swapped}.sig`);
    fs.writeFileSync(`${swapped}.sha256`, `${sha(swapped)}  update.zip\n`);
    r = L.run('--yes', swapped);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /Checksum matches/);
    assert.match(r.out, /doesn't match this server's update key/);
    L.unchanged(before);
    // The published one goes through (signed with Node, checked with openssl).
    r = L.run('--yes', real);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`Signed with this server's update key \\(${a.pub.replace(/[+/]/g, '\\$&')}\\)`));
    assert.equal(L.index(), '// new\n');
    assert.equal(L.pinned(), a.pub);
    await L.started(2);
  } finally { L.done(); }
});

test('the key changes only with an update the old key signed (or --allow-unsigned, loudly)', { skip: shellSkip }, async () => {
  const L = lab();
  const a = keyPair(); const b = keyPair(); const c = keyPair();
  try {
    assert.equal(L.run('--yes', L.zip({ key: a })).status, 0);
    assert.equal(L.pinned(), a.pub);
    await L.started();
    // An update carrying a new key, signed by the old one: installed, and the new key is pinned.
    let z = L.zip({ version: '1.0.2', key: b });
    signZip(z, a);
    let r = L.run('--yes', z);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /update signing key is now .*signed with the previous key/);
    assert.equal(L.pinned(), b.pub);
    await L.started(2);
    // From then on only the new key counts.
    z = L.zip({ version: '1.0.3', key: b });
    signZip(z, a);
    r = L.run('--yes', z);
    assert.notEqual(r.status, 0, 'the old key no longer works');
    signZip(z, b);
    r = L.run('--yes', z);
    assert.equal(r.status, 0, r.out);
    assert.equal(L.version(), '1.0.3');
    await L.started(3);
    // A zip that brings its own key can't vouch for itself.
    z = L.zip({ version: '1.0.4', key: c });
    signZip(z, c);
    const before = L.snapshot();
    r = L.run('--yes', z);
    assert.notEqual(r.status, 0);
    L.unchanged(before);
    assert.equal(L.pinned(), b.pub);
    // Unless the operator overrides the check, which is said loudly and is the documented way back from a lost key.
    r = L.run('--yes', '--allow-unsigned', z);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Going ahead anyway because of --allow-unsigned/);
    assert.match(r.out, /installed WITHOUT a valid signature/);
    assert.match(r.out, /it came with an update installed with --allow-unsigned/);
    assert.equal(L.pinned(), c.pub);
    assert.equal(L.version(), '1.0.4');
    await L.started(4);
    // An update without update-signing.pub leaves the pinned key alone (a release can't switch checking off).
    z = L.zip({ version: '1.0.5' });
    signZip(z, c);
    r = L.run('--yes', z);
    assert.equal(r.status, 0, r.out);
    assert.equal(L.pinned(), c.pub);
    await L.started(5);
    // A rollback doesn't touch the pinned key either.
    assert.equal(L.run('--rollback', '--yes').status, 0);
    assert.equal(L.pinned(), c.pub);
    await L.started(6);
  } finally { L.done(); }
});

test('the installed Hearth\'s own key is pinned on the first run, and a signed server never goes back a version by itself', { skip: shellSkip }, async () => {
  const a = keyPair();
  const L = lab({ installedKey: a, installed: '1.5.0' });
  try {
    const before = L.snapshot();
    // --verify changes nothing, not even the pinned key, but already checks against the installed key.
    let z = L.zip({ version: '1.6.0', key: a });
    let r = L.run('--verify', z);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /isn't signed/);
    assert.match(r.out, /it came with the installed Hearth/);
    assert.equal(L.pinned(), null);
    // An update pins it (it came with what's running), then refuses the unsigned zip.
    r = L.run('--yes', z);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /Pinned the update signing key that came with this Hearth/);
    assert.equal(L.pinned(), a.pub);
    L.unchanged(before);
    // An older, properly signed version: refused unless asked for.
    const old = L.zip({ version: '1.4.9', key: a });
    signZip(old, a);
    r = L.run('--yes', old);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /is Hearth 1\.4\.9, older than the installed 1\.5\.0/);
    assert.match(r.out, /hearth-update --rollback/);
    L.unchanged(before);
    for (const [v, older] of [['1.5.0-beta.2', true], ['1.5.0', false], ['1.10.0', false], ['0.99.99', true]]) {
      const zz = L.zip({ version: v, key: a });
      signZip(zz, a);
      const rr = L.run('--verify', zz);
      assert.equal(rr.status === 0, !older, `${v}: ${rr.out}`);
    }
    r = L.run('--yes', '--allow-downgrade', old);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Installing 1\.4\.9 over the newer 1\.5\.0, because of --allow-downgrade/);
    assert.equal(L.version(), '1.4.9');
    await L.started();
  } finally { L.done(); }
});

test('hearth-update --verify only checks: nothing is unpacked, backed up, run, pinned or logged', { skip: shellSkip }, () => {
  const L = lab();
  const a = keyPair();
  try {
    fs.writeFileSync(L.pin, K.pubFileText(a.pub));
    const before = L.snapshot();
    const z = L.zip({ key: a });
    signZip(z, a);
    let r = L.run('--verify', z);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /passed the checks for this server \(installed: 1\.0\.0\)/);
    L.unchanged(before);
    assert.ok(!fs.existsSync(path.join(L.t, 'backups', 'last-update.log')), 'the last update\'s log is kept');
    fs.rmSync(`${z}.sig`);
    r = L.run('--verify', z);
    assert.notEqual(r.status, 0);
    r = L.run('--verify', '--allow-unsigned', z);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /is NOT verified/);
    L.unchanged(before);
    assert.match(L.run('--verify').out, /Which update\?/);
  } finally { L.done(); }
});

test('a broken pinned key, or a pinned key this server can\'t check, refuses updates instead of switching the check off', { skip: shellSkip }, async () => {
  let L = lab();
  try {
    fs.writeFileSync(L.pin, '# not a key\nhello\n');
    const before = L.snapshot();
    const r = L.run('--yes', L.zip());
    assert.notEqual(r.status, 0);
    assert.match(r.out, /isn't an update signing key/);
    L.unchanged(before);
    assert.match(L.run('--status').out, /update key: not a key, so every update is refused/);
  } finally { L.done(); }
  // Neither OpenSSL nor Node can check Ed25519 here, and neither can a tool that says yes to everything.
  const a = keyPair();
  for (const openssl of [false, 'yes', '1.1.1']) {
    L = lab({ openssl, node: false });
    try {
      fs.writeFileSync(L.pin, K.pubFileText(a.pub));
      const before = L.snapshot();
      const z = L.zip();
      signZip(z, a);
      const r = L.run('--yes', z);
      assert.notEqual(r.status, 0, `${openssl}: ${r.out}`);
      assert.match(r.out, /can't be checked: this server can't check Ed25519 signatures \(that takes OpenSSL 3\.0 or newer, as on Debian 12 and Ubuntu 22\.04, or Node\.js\)/);
      assert.doesNotMatch(r.out, /1\.1\.1 or newer/);
      L.unchanged(before);
      assert.match(L.run('--status').out, /every update is refused until one of them is installed/);
    } finally { L.done(); }
  }
});

test('OpenSSL 1.1.1 (Ubuntu 20.04, Debian 11): signatures are checked with Node instead', { skip: shellSkip }, async () => {
  const L = lab({ openssl: '1.1.1' });
  const a = keyPair(); const b = keyPair();
  try {
    // The first update that brings a key pins it, as with a newer OpenSSL.
    let r = L.run('--yes', L.zip({ key: a }));
    assert.equal(r.status, 0, r.out);
    assert.equal(L.pinned(), a.pub);
    await L.started();
    // The next one, signed with that key, installs (it was refused before Node did the check).
    let z = L.zip({ version: '1.0.2', key: a });
    signZip(z, a);
    r = L.run('--yes', z);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Signed with this server's update key/);
    assert.equal(L.version(), '1.0.2');
    await L.started(2);
    // And one signed with another key is still refused.
    z = L.zip({ version: '1.0.3', key: a });
    signZip(z, b);
    const before = L.snapshot();
    r = L.run('--yes', z);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /doesn't match this server's update key/);
    L.unchanged(before);
  } finally { L.done(); }
});

test('a server that can\'t check signatures pins no key and stays on checksums, as before signing', { skip: shellSkip }, async () => {
  const a = keyPair();
  const L = lab({ openssl: '1.1.1', node: false, installedKey: a });
  try {
    assert.match(L.run('--status').out, /update key: none \(this server can't check Ed25519 signatures .*only checked against their \.sha256\)/);
    const z = L.zip({ key: a });
    signZip(z, a);
    const r = L.run('--yes', z);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /The installed Hearth has an update signing key, but this server can't check Ed25519 signatures .*so it isn't pinned/);
    assert.match(r.out, /This update brings an update signing key .*so it isn't pinned: updates stay checked against their checksum only/);
    assert.doesNotMatch(r.out, /now only installs updates signed/);
    assert.equal(L.pinned(), null, 'nothing pinned that every later update would fail against');
    assert.equal(L.index(), '// new\n');
    await L.started();
  } finally { L.done(); }
});

test('the installed Hearth\'s key is only trusted when it is root\'s alone', { skip: shellSkip }, async () => {
  const owner = keyPair(); const foreign = keyPair();
  // update-signing.pub that another account could have written (here: group-writable, or that account's file).
  const cases = [['group-writable', (f) => fs.chmodSync(f, 0o664)], ['a writable folder', (f) => fs.chmodSync(path.dirname(f), 0o777)]];
  if (process.getuid && process.getuid() === 0) cases.push(['another account\'s file', (f) => fs.chownSync(f, 1000, 1000)]);
  for (const [what, loosen] of cases) {
    const L = lab({ installedKey: foreign });
    try {
      loosen(path.join(L.app, 'update-signing.pub'));
      assert.match(L.run('--status').out, /none pinned yet \(this Hearth's update-signing\.pub isn't root's alone/, what);
      // The owner's genuine signed release, carrying the owner's key: installed, and the owner's key is pinned.
      const z = L.zip({ key: owner });
      signZip(z, owner);
      const r = L.run('--yes', z);
      assert.equal(r.status, 0, `${what}: ${r.out}`);
      assert.match(r.out, /update-signing\.pub \(or a folder it's in\) can be changed by an account other than root, so it isn't trusted/);
      assert.equal(L.pinned(), owner.pub, what);
      await L.started();
    } finally { L.done(); }
  }
});

test('hearth-update takes a zip path from where it is run, with the .sha256 and .sig next to it', { skip: shellSkip }, async () => {
  const L = lab();
  const a = keyPair();
  try {
    fs.writeFileSync(L.pin, K.pubFileText(a.pub));
    const z = L.zip({ key: a });
    signZip(z, a);
    fs.writeFileSync(`${z}.sha256`, `${sha(z)}  ${path.basename(z)}\n`);
    // A file of the same name in the Hearth folder is never the one checked.
    fs.writeFileSync(path.join(L.app, path.basename(z)), 'decoy');
    for (const name of [path.basename(z), `./${path.basename(z)}`]) {
      const r = L.runWith({ cwd: path.dirname(z) }, '--verify', name);
      assert.equal(r.status, 0, `${name}: ${r.out}`);
      assert.match(r.out, /Checksum matches/);
      assert.match(r.out, /Signed with this server's update key/);
    }
    const r = L.runWith({ cwd: path.dirname(z) }, '--yes', path.basename(z));
    assert.equal(r.status, 0, r.out);
    assert.equal(L.index(), '// new\n');
    await L.started();
  } finally { L.done(); }
});

test('the installed updater replaces itself in one step, so running it as hearth-update <zip> is safe', { skip: shellSkip }, async () => {
  const L = lab();
  const a = keyPair();
  try {
    fs.writeFileSync(L.pin, K.pubFileText(a.pub));
    // The updater installed on the server is this one; the new release's updater is longer (40 more lines at the
    // top), so a copy written into the running file would leave bash reading the middle of something else.
    const bin = L.env.HEARTH_UPDATE_BIN;
    fs.copyFileSync(path.join(ROOT, 'scripts/hearth-update.sh'), bin);
    fs.chmodSync(bin, 0o750);
    const lines = read('scripts/hearth-update.sh').split('\n');
    lines.splice(1, 0, ...Array.from({ length: 40 }, (_, i) => `# a longer updater, line ${i + 1}`));
    const z = L.zip({ version: '1.0.2', key: a, updater: lines.join('\n') });
    signZip(z, a);
    // Under a strict umask, as root's own shell often is: the updater still ends up readable (755).
    const r = L.runWith({ script: bin, umask: '077' }, '--yes', z);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /unbound variable|syntax error|Step failed/);
    assert.equal(L.version(), '1.0.2');
    assert.equal(fs.readFileSync(bin, 'utf8'), lines.join('\n'), 'the new updater is installed');
    assert.equal(fs.statSync(bin).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(path.dirname(bin)).filter((f) => f.startsWith('hearth-update.')), [], 'no temporary copy left behind');
    await L.started();
    // The first copy of itself (run from somewhere else) is 755 too, whatever the umask.
    fs.rmSync(bin);
    const z2 = L.zip({ version: '1.0.3', key: a });
    signZip(z2, a);
    assert.equal(L.runWith({ umask: '027' }, '--verify', z2).status, 0);
    assert.equal(fs.statSync(bin).mode & 0o777, 0o755);
  } finally { L.done(); }
});

test('hearth-update --status names the pinned key', { skip: shellSkip }, () => {
  const a = keyPair();
  const L = lab({ installedKey: a });
  try {
    assert.match(L.run('--status').out, /update key: none pinned yet \(the next update pins the one this Hearth came with\)/);
    fs.writeFileSync(L.pin, K.pubFileText(a.pub));
    assert.ok(L.run('--status').out.includes(`update key: ${a.pub} (pinned in ${L.pin}`));
    fs.rmSync(L.pin); fs.rmSync(path.join(L.app, 'update-signing.pub'));
    assert.match(L.run('--status').out, /update key: none \(updates are only checked against their \.sha256\)/);
  } finally { L.done(); }
});

test('hearth-update checks a private copy of the zip, and the signature before reading anything inside it', () => {
  const text = read('scripts/hearth-update.sh');
  assert.ok(text.includes('PIN="${HEARTH_UPDATE_PUBKEY:-/etc/hearth-update.pub}"'), 'the trust anchor lives outside the Hearth folder');
  const main = text.slice(text.indexOf('# ---------------------------------------------------------------- update\n'));
  const at = (s, from = main) => { const i = from.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('cp -- "$ZIP" "$WORK/update.zip"') < at('check_update "$ZIP" "$WORK/update.zip"'));
  assert.ok(at('check_update "$ZIP" "$WORK/update.zip"') < at('unzip -q "$WORK/update.zip"'));
  assert.ok(at('check_update') < at('install_updater "$NEW/scripts/hearth-update.sh"'), 'the updater is only replaced after the check');
  assert.doesNotMatch(text, /\bcp [^;&|\n]*"\$BIN"/, 'the installed updater is never written into, only replaced');
  assert.match(text, /cp -- "\$1" "\$t" && chmod 755 "\$t" && mv -fT "\$t" "\$BIN"/);
  assert.doesNotMatch(main, /unzip[^\n]*"\$ZIP"/, 'the zip as given is never unpacked');
  const fn = text.slice(text.indexOf('check_update() {'), text.indexOf('\n}\n', text.indexOf('check_update() {')));
  assert.ok(at('sig_ok "$SUM"', fn) < at('unzip -Z1', fn), 'no zip parsing before the signature check');
  assert.ok(at('unzip -Z1', fn) < at('zip_version', fn));
  assert.ok(text.includes('SIG_CONTEXT=hearth-server-update-v1'));
  assert.equal(K.CONTEXT, 'hearth-server-update-v1');
});

// ------------------------------------------------------------------ scripts/make-update-zip.sh
const gitSkip = !['bash', 'zip', 'unzip', 'git'].every(has) && 'needs git, zip, unzip';
// A scratch repository with just what make-update-zip.sh needs, so a key can be "committed" without touching
// this one.
function repoLab({ pub } = {}) {
  const t = tmp();
  const h = path.join(t, 'repo', 'hearth');
  for (const d of ['server', 'scripts', 'desktop']) fs.mkdirSync(path.join(h, d), { recursive: true });
  fs.writeFileSync(path.join(h, 'package.json'), '{\n  "version": "9.8.7"\n}\n');
  fs.writeFileSync(path.join(h, 'server/index.js'), '//\n');
  for (const f of ['scripts/make-update-zip.sh', 'scripts/hearth-update.sh', 'scripts/update-key.js', 'desktop/update-verify.js']) fs.copyFileSync(path.join(ROOT, f), path.join(h, f));
  if (pub != null) fs.writeFileSync(path.join(h, 'update-signing.pub'), pub);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: path.join(t, 'repo'), stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'test');
  const home = path.join(t, 'home');
  fs.mkdirSync(home);
  const out = path.join(t, 'out');
  const zip = path.join(out, 'hearth-update-9.8.7.zip');
  const run = (args = [], env = {}) => {
    const r = spawnSync('bash', [path.join(h, 'scripts/make-update-zip.sh'), ...args, out], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home, HEARTH_UPDATE_KEY: '', HEARTH_UPDATE_KEY_FILE: '', ...env } });
    return { ...r, out: r.stdout + r.stderr };
  };
  return { t, h, home, zip, run, done: () => fs.rmSync(t, { recursive: true, force: true }) };
}

test('make-update-zip.sh signs with the publisher\'s key, and won\'t make an unsigned zip once a key is committed', { skip: gitSkip }, () => {
  const a = keyPair(); const b = keyPair();
  // No key yet: as before, a zip and its .sha256, and it says it isn't signed.
  let R = repoLab();
  try {
    const r = R.run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Not signed: there's no update signing key yet/);
    assert.ok(fs.existsSync(R.zip) && fs.existsSync(`${R.zip}.sha256`));
    assert.ok(!fs.existsSync(`${R.zip}.sig`));
    // With a key but nothing committed: signed, with a reminder to commit the public half.
    const keyFile = path.join(R.t, 'a.key');
    fs.writeFileSync(keyFile, a.pem, { mode: 0o600 });
    const s = R.run([], { HEARTH_UPDATE_KEY_FILE: keyFile });
    assert.equal(s.status, 0, s.out);
    assert.equal(K.verify(sha(R.zip), K.readSig(fs.readFileSync(`${R.zip}.sig`, 'utf8')), a.pub), true);
    assert.match(s.out, /doesn't carry update-signing\.pub/);
    assert.doesNotMatch(s.out, /PRIVATE KEY/);
  } finally { R.done(); }

  // Someone with write access to the repository (not the key) commits their own update-signing.pub: the owner's
  // usual run refuses to make a release that would move every server to it.
  R = repoLab({ pub: K.pubFileText(keyPair().pub) });
  try {
    const r = R.run([], { HEARTH_UPDATE_KEY: a.pem });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /If you didn't change it, someone else did: see git log -p -- update-signing\.pub\. Nothing was made/);
    assert.ok(!fs.existsSync(R.zip) && !fs.existsSync(`${R.zip}.sig`));
  } finally { R.done(); }

  // Committed: no key means no zip (servers that pinned it would refuse it), unless --unsigned says so.
  R = repoLab({ pub: K.pubFileText(a.pub) });
  try {
    let r = R.run();
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /pins an update signing key .*Nothing was made/s);
    assert.ok(!fs.existsSync(R.zip) && !fs.existsSync(`${R.zip}.sha256`), 'no unsigned zip left behind to hand out');
    r = R.run(['--unsigned']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Not signed \(--unsigned\)/);
    assert.ok(fs.existsSync(R.zip) && !fs.existsSync(`${R.zip}.sig`));
    // The key in its default place: signed, and the zip carries the key servers will pin.
    fs.mkdirSync(path.join(R.home, '.config', 'hearth'), { recursive: true });
    fs.writeFileSync(path.join(R.home, '.config', 'hearth', 'update-signing.key'), a.pem, { mode: 0o600 });
    r = R.run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Signed hearth-update-9\.8\.7\.zip with your update signing key/);
    assert.equal(K.verify(sha(R.zip), K.readSig(fs.readFileSync(`${R.zip}.sig`, 'utf8')), a.pub), true);
    assert.equal(K.readPublicKey(execFileSync('unzip', ['-p', R.zip, 'hearth/update-signing.pub'], { encoding: 'utf8' })), a.pub);
    assert.doesNotMatch(r.out, /changes the update signing key|doesn't carry/);
    // The CI way: the key itself in HEARTH_UPDATE_KEY.
    const aFile = path.join(R.t, 'a.key');
    fs.writeFileSync(aFile, a.pem, { mode: 0o600 });
    r = R.run([], { HEARTH_UPDATE_KEY: a.pem });
    assert.equal(r.status, 0, r.out);
    assert.equal(K.verify(sha(R.zip), K.readSig(fs.readFileSync(`${R.zip}.sig`, 'utf8')), a.pub), true);
    // Signed with another key than the committed one: servers would move to the committed key, so that takes the
    // committed key's private half too (--new-key), never just a commit.
    r = R.run([], { HEARTH_UPDATE_KEY: b.pem });
    assert.equal(r.status, 1, r.out);
    assert.ok(r.out.includes(`update-signing.pub in the last commit is ${a.pub}, but you sign with ${b.pub}`), r.out);
    assert.match(r.out, /--new-key FILE .*Nothing was made/s);
    assert.ok(!fs.existsSync(R.zip) && !fs.existsSync(`${R.zip}.sig`), 'nothing left behind to hand out');
    const cFile = path.join(R.t, 'c.key');
    fs.writeFileSync(cFile, keyPair().pem, { mode: 0o600 });
    r = R.run(['--new-key', cFile], { HEARTH_UPDATE_KEY: b.pem });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /is the key .*, not the one in update-signing\.pub .*Nothing was made/s);
    assert.ok(!fs.existsSync(R.zip));
    r = R.run(['--new-key', aFile], { HEARTH_UPDATE_KEY: b.pem });
    assert.equal(r.status, 0, r.out);
    assert.equal(K.verify(sha(R.zip), K.readSig(fs.readFileSync(`${R.zip}.sig`, 'utf8')), b.pub), true, 'signed with the current key');
    assert.ok(r.out.includes(`KEY CHANGE: servers that install this update switch from ${b.pub}`), r.out);
    // (--new-key=FILE, and a relative file name, from where you are.)
    const rel = spawnSync('bash', [path.join(R.h, 'scripts/make-update-zip.sh'), '--new-key=a.key', path.join(R.t, 'out')], { cwd: R.t, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: R.home, HEARTH_UPDATE_KEY: b.pem, HEARTH_UPDATE_KEY_FILE: '' } });
    assert.equal(rel.status, 0, rel.stdout + rel.stderr);
    // --new-key on an update that doesn't change the key is a mistake (the new public half isn't committed).
    r = R.run(['--new-key', cFile], { HEARTH_UPDATE_KEY: a.pem });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /this one doesn't.*did you commit the new one/s);
    // A broken key: nothing is left behind.
    r = R.run([], { HEARTH_UPDATE_KEY: 'not a key' });
    assert.equal(r.status, 1);
    assert.match(r.out, /Signing failed\. Nothing was made/);
    assert.ok(!fs.existsSync(R.zip) && !fs.existsSync(`${R.zip}.sig`));
  } finally { R.done(); }

  // A committed update-signing.pub that isn't a key is caught here, not on every server.
  R = repoLab({ pub: 'hello\n' });
  try {
    const r = R.run(['--unsigned']);
    assert.equal(r.status, 1);
    assert.match(r.out, /isn't an update signing key/);
  } finally { R.done(); }
  // Signatures are never committed by accident.
  if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT }).status === 0) {
    for (const f of ['dist/hearth-update-9.9.9.zip.sig', 'hearth-update-9.9.9.zip.sig']) {
      assert.equal(spawnSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: ROOT }).status, 0, `${f} is ignored`);
    }
  }
});

test('no real update signing key is committed with the code; the docs say how to make one', () => {
  // The owner makes their own (docs/SIGNING.md): a key in the repository would be a key nobody chose.
  assert.ok(!fs.existsSync(path.join(ROOT, 'update-signing.pub')) || K.readPublicKey(read('update-signing.pub')));
  const doc = read('docs/SIGNING.md');
  assert.match(doc, /## Signing server updates/);
  assert.match(doc, /node scripts\/update-key\.js keygen/);
  assert.match(doc, /--allow-unsigned/);
});
