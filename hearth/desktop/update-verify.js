// Signed updates for the desktop app. The app downloads updates from the server it's connected to, so the
// server (or anyone who can write its data/downloads folder) decides what's offered. A build made with a
// signing key (GitHub secret UPDATE_SIGNING_KEY, see build/sign-update.js) carries the matching public key in
// hearth.config.json ("updatePublicKey") and installs an update only when:
//   1. latest*.yml (what electron-updater reads: version, files, SHA-512s) comes with latest*.yml.sig, an
//      Ed25519 signature by the publisher's key over that exact file and its name;
//   2. the signed version is newer than the running one (no going back to an old, signed version);
//   3. the downloaded installer's SHA-512 is one the signed file lists (checked again right before it runs).
// A build without a key still updates, but always asks first and says the update can't be verified.
// No Electron in here: build/sign-update.js and the tests use it with plain Node.
const crypto = require('crypto');
const fs = require('fs');

const CONTEXT = 'hearth-update-v1';

// The file electron-updater reads for this platform (same rule as its Provider.getChannelFilePrefix).
function channelFile(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'latest.yml';
  if (platform === 'darwin') return 'latest-mac.yml';
  return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`;
}

// What gets signed: a fixed label, the file's name (so latest.yml can't pass as latest-linux.yml) and its bytes.
const signedMessage = (name, yml) => Buffer.concat([Buffer.from(`${CONTEXT}\n${name}\n`, 'utf8'), Buffer.from(yml)]);

// Keys. Public: base64 of the SPKI DER (one line, what hearth.config.json holds) or PEM. Private: PEM, the
// PEM in base64, or base64 PKCS#8 DER (whatever fits in a GitHub secret most easily).
function loadPublicKey(text) {
  const s = String(text || '').trim();
  const key = s.includes('-----BEGIN')
    ? crypto.createPublicKey(s)
    : crypto.createPublicKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The update public key must be an Ed25519 key.');
  return key;
}
function loadPrivateKey(text) {
  let s = String(text || '').trim();
  if (!s.includes('-----BEGIN')) {
    const raw = Buffer.from(s, 'base64');
    if (raw.toString('utf8').includes('-----BEGIN')) s = raw.toString('utf8');
    else return checkPrivate(crypto.createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' }));
  }
  return checkPrivate(crypto.createPrivateKey(s));
}
function checkPrivate(key) {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('UPDATE_SIGNING_KEY must be an Ed25519 private key.');
  return key;
}
const publicKeyText = (privateKey) => crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

function sign(name, yml, privateKey) {
  return crypto.sign(null, signedMessage(name, yml), privateKey).toString('base64');
}
function verifySignature(name, yml, sig, publicKey) {
  try {
    const s = Buffer.from(String(sig || '').trim(), 'base64');
    if (s.length !== 64) return false;
    return crypto.verify(null, signedMessage(name, yml), publicKey, s);
  } catch { return false; }
}

// The parts of electron-builder's latest*.yml that matter here: the version and every SHA-512 it lists
// (the installer's, under files: and at the top level). Only ever read after the signature checked out.
function readMetadata(yml) {
  const text = Buffer.isBuffer(yml) ? yml.toString('utf8') : String(yml || '');
  const v = /^version:\s*['"]?([0-9A-Za-z.+-]+)['"]?\s*$/m.exec(text);
  const hashes = new Set();
  for (const m of text.matchAll(/^\s*(?:-\s+)?sha512:\s*['"]?([A-Za-z0-9+/]{86}==)['"]?\s*$/gm)) hashes.add(m[1]);
  return { version: v ? v[1] : null, hashes };
}

// Semantic versions: 1.10.0 > 1.9.3, and 1.2.0 > 1.2.0-beta.1.
function compareVersions(a, b) {
  const parse = (v) => { const [core, pre = ''] = String(v || '').replace(/^v/, '').split('+')[0].split(/-(.*)/s); return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre }; };
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < 3; i++) { const d = (x.nums[i] || 0) - (y.nums[i] || 0); if (d) return Math.sign(d); }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xp = x.pre.split('.'); const yp = y.pre.split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    if (xp[i] === undefined) return -1;
    if (yp[i] === undefined) return 1;
    const xn = /^\d+$/.test(xp[i]); const yn = /^\d+$/.test(yp[i]);
    if (xn && yn && +xp[i] !== +yp[i]) return Math.sign(+xp[i] - +yp[i]);
    if (xn !== yn) return xn ? -1 : 1;
    if (xp[i] !== yp[i]) return xp[i] < yp[i] ? -1 : 1;
  }
  return 0;
}

const NOT_INSTALLED = 'so it wasn’t installed.';
// Checks the signed metadata for an update electron-updater says it downloaded (version), against the
// running version. Returns { ok: true, version, hashes } or { ok: false, error }.
function verifyFeed({ name, yml, sig, publicKey, version, currentVersion }) {
  const key = typeof publicKey === 'string' ? loadPublicKey(publicKey) : publicKey;
  if (yml == null) return { ok: false, error: `Your server doesn’t offer the update’s details (${name}), ${NOT_INSTALLED}` };
  if (sig == null || !String(sig).trim()) return { ok: false, error: `This update isn’t signed by Hearth’s publisher, ${NOT_INSTALLED}` };
  if (!verifySignature(name, yml, sig, key)) return { ok: false, error: `This update’s signature doesn’t match Hearth’s publisher, ${NOT_INSTALLED}` };
  const meta = readMetadata(yml);
  if (!meta.version || !meta.hashes.size) return { ok: false, error: `This update’s signed details are incomplete, ${NOT_INSTALLED}` };
  if (version != null && compareVersions(meta.version, version) !== 0) return { ok: false, error: `The downloaded update (${version}) isn’t the signed one (${meta.version}), ${NOT_INSTALLED}` };
  if (currentVersion != null && compareVersions(meta.version, currentVersion) <= 0) return { ok: false, error: `The signed update (${meta.version}) isn’t newer than this version, ${NOT_INSTALLED}` };
  return { ok: true, version: meta.version, hashes: meta.hashes };
}

// The installer that's about to run must be one the signed file lists.
function fileMatches(sha512, hashes) {
  return typeof sha512 === 'string' && !!hashes && (hashes instanceof Set ? hashes.has(sha512) : [...hashes].includes(sha512));
}
const NOT_SIGNED_FILE = `The downloaded update doesn’t match the signed one, ${NOT_INSTALLED}`;

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('base64')));
  });
}

// The native "install now?" dialog. Hearth never installs an update without the person saying so.
function installPrompt({ version, verified, host }) {
  return {
    type: verified ? 'question' : 'warning',
    buttons: ['Not now', 'Restart and install'],
    defaultId: verified ? 1 : 0,
    cancelId: 0,
    title: 'Install update',
    message: `Install Hearth ${version} now?`,
    detail: verified
      ? 'This update is signed by Hearth’s publisher and its download checked out. Hearth closes, installs it and opens again.'
      : `This update can’t be verified: this copy of Hearth was built without an update signing key, so all it can check is that the download matches what ${host || 'your server'} says. Only install it if you trust that server. Hearth closes, installs it and opens again.`,
  };
}

module.exports = {
  CONTEXT, channelFile, signedMessage, loadPublicKey, loadPrivateKey, publicKeyText, generateKeys, sign, verifySignature,
  readMetadata, compareVersions, verifyFeed, fileMatches, NOT_SIGNED_FILE, sha512File, installPrompt,
};
