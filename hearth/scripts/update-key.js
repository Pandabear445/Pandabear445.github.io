#!/usr/bin/env node
// Signed server updates: the publisher signs each update zip, and servers only install zips signed with the key
// they trust (hearth-update checks them before unpacking anything; docs/SIGNING.md, "Signing server updates").
//
//   node scripts/update-key.js keygen [--key FILE] [--pub FILE]
//        makes a key pair. The private key goes to FILE (default ~/.config/hearth/update-signing.key, readable
//        only by you; never put it in this repository), the public half to update-signing.pub (commit that one)
//   node scripts/update-key.js sign ZIP [--key FILE]      writes ZIP.sig (make-update-zip.sh does this for you)
//   node scripts/update-key.js verify ZIP [--pub FILE]    checks ZIP.sig against update-signing.pub (or FILE)
//   node scripts/update-key.js public [--key FILE]        prints the public half of the private key
//   node scripts/update-key.js has-key [--key FILE]       exit 0 when a private key is set up, 1 when not
//
// The private key is the first of: --key FILE, HEARTH_UPDATE_KEY (the key itself, e.g. a CI secret),
// HEARTH_UPDATE_KEY_FILE, the default file. It is never printed.
//
// What's signed (Ed25519): "hearth-server-update-v1\n<the zip's SHA-256 in hex>\n". The label keeps a desktop
// update signature (desktop/update-verify.js, "hearth-update-v1") or any other use of the key from passing as
// a server update. hearth-update checks the same bytes with openssl, so servers don't need Node to verify.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../desktop/update-verify');

const CONTEXT = 'hearth-server-update-v1';
const ROOT = path.join(__dirname, '..');
const DEFAULT_KEY = path.join(os.homedir(), '.config', 'hearth', 'update-signing.key');
const DEFAULT_PUB = path.join(ROOT, 'update-signing.pub');
// Ed25519 public keys as one line of base64 (SPKI DER): always 60 characters with this prefix. hearth-update
// accepts exactly this shape, so nothing else can end up in the key file it writes.
const PUB_RE = /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/;
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/;

const signedMessage = (sha256hex) => Buffer.from(`${CONTEXT}\n${String(sha256hex).toLowerCase()}\n`, 'utf8');
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// update-signing.pub: '#' comment lines, then the key. Returns the key line, or throws.
function readPublicKey(text) {
  const key = String(text || '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('').replace(/\s+/g, '');
  if (!PUB_RE.test(key)) throw new Error('not an Ed25519 public key (one line of base64 starting with MCowBQYDK2VwAyEA)');
  U.loadPublicKey(key); // also a key Node can load
  return key;
}
function loadPrivateKey(text) {
  try { return U.loadPrivateKey(text); } catch (e) { throw new Error(`not a usable Ed25519 private key (${e.message.replace(/UPDATE_SIGNING_KEY/, 'it')})`); }
}
const publicKeyOf = (privateKey) => U.publicKeyText(privateKey);

function sign(sha256hex, privateKey) {
  return crypto.sign(null, signedMessage(sha256hex), privateKey).toString('base64');
}
function verify(sha256hex, sig, publicKey) {
  try {
    const s = String(sig || '').trim();
    if (!SIG_RE.test(s) || !/^[0-9a-f]{64}$/i.test(String(sha256hex))) return false;
    const key = typeof publicKey === 'string' ? U.loadPublicKey(readPublicKey(publicKey)) : publicKey;
    return crypto.verify(null, signedMessage(sha256hex), key, Buffer.from(s, 'base64'));
  } catch { return false; }
}
// The first non-empty line of a .sig file.
const readSig = (text) => (String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '');

function pubFileText(pub) {
  return [
    '# Hearth server update signing key (Ed25519, public half). A server that installs an update carrying this file',
    '# afterwards only installs updates signed with the matching private key. Made with: node scripts/update-key.js keygen',
    pub, '',
  ].join('\n');
}

// ---------------------------------------------------------------- command line
class Fail extends Error {}
function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--key' || argv[i] === '--pub') {
      if (argv[i + 1] == null) throw new Fail(`${argv[i]} needs a file name.`);
      out[argv[i].slice(2)] = argv[++i];
    } else if (argv[i].startsWith('--')) throw new Fail(`Unknown option: ${argv[i]}`);
    else out._.push(argv[i]);
  }
  return out;
}
// Where the private key comes from, or null when there's none.
function privateKeySource(opt, env = process.env) {
  if (opt.key) return { text: () => fs.readFileSync(opt.key, 'utf8'), name: opt.key };
  if ((env.HEARTH_UPDATE_KEY || '').trim()) return { text: () => env.HEARTH_UPDATE_KEY, name: 'HEARTH_UPDATE_KEY' };
  if ((env.HEARTH_UPDATE_KEY_FILE || '').trim()) return { text: () => fs.readFileSync(env.HEARTH_UPDATE_KEY_FILE, 'utf8'), name: env.HEARTH_UPDATE_KEY_FILE };
  if (fs.existsSync(DEFAULT_KEY)) return { text: () => fs.readFileSync(DEFAULT_KEY, 'utf8'), name: DEFAULT_KEY };
  return null;
}
function privateKey(opt, env) {
  const src = privateKeySource(opt, env);
  if (!src) throw new Fail(`No update signing key: make one with "node scripts/update-key.js keygen", or set HEARTH_UPDATE_KEY_FILE (docs/SIGNING.md).`);
  let text;
  try { text = src.text(); } catch (e) { throw new Fail(`Couldn't read the update signing key ${src.name} (${e.code || e.message}).`); }
  // A key file others can read is a key others can sign with.
  if (src.name !== 'HEARTH_UPDATE_KEY' && process.platform !== 'win32') {
    try { if (fs.statSync(src.name).mode & 0o077) console.error(`Warning: ${src.name} can be read by other accounts on this computer. Fix it with: chmod 600 "${src.name}"`); } catch { /* read just above */ }
  }
  try { return { key: loadPrivateKey(text), name: src.name }; } catch (e) { throw new Fail(`The update signing key ${src.name} is ${e.message}.`); }
}

function keygen(opt) {
  const keyFile = path.resolve(opt.key || DEFAULT_KEY);
  const pubFile = path.resolve(opt.pub || DEFAULT_PUB);
  const k = U.generateKeys();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  // Opening with 'wx' is the existence check, so nothing can slip a file in between a check and the write.
  let fd;
  try { fd = fs.openSync(keyFile, 'wx', 0o600); } catch (e) {
    if (e.code === 'EEXIST') throw new Fail(`${keyFile} already exists. Keep using it, or move it away first: a new key means servers that pinned the old one refuse updates signed with the new one (docs/SIGNING.md, "Changing the key").`);
    throw e;
  }
  try { fs.writeFileSync(fd, k.privateKeyPem); } finally { fs.closeSync(fd); }
  // Same for the public key: open it once and learn from that open whether one was there.
  let replacing = true;
  let pfd;
  try { pfd = fs.openSync(pubFile, 'r+'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    replacing = false;
    pfd = fs.openSync(pubFile, 'wx');
  }
  try { fs.ftruncateSync(pfd, 0); fs.writeSync(pfd, pubFileText(k.publicKey), 0); } finally { fs.closeSync(pfd); }
  console.log(`Private key: ${keyFile} (only you can read it). Back it up somewhere safe and offline; never commit it.`);
  console.log(`Public key:  ${pubFile}\n             ${k.publicKey}`);
  if (replacing) console.log(`This replaced the old public key: sign the next update with the OLD private key and name the new one (bash scripts/make-update-zip.sh --new-key "${keyFile}"), so servers accept the change (docs/SIGNING.md, "Changing the key").`);
  else console.log('Commit update-signing.pub and make the next update with scripts/make-update-zip.sh: it signs with this key.');
}

function signZip(zip, opt) {
  if (!zip || !fs.existsSync(zip)) throw new Fail(`No such update zip: ${zip || '(none given)'}`);
  const { key, name } = privateKey(opt);
  const pub = publicKeyOf(key);
  const sum = sha256File(zip);
  const sig = sign(sum, key);
  if (!verify(sum, sig, pub)) throw new Fail("The signature didn't verify; nothing was written.");
  fs.writeFileSync(`${zip}.sig`, sig + '\n');
  console.log(`Signed ${path.basename(zip)} with ${name === DEFAULT_KEY ? 'your update signing key' : name}.`);
  console.log(`  ${zip}.sig`);
  console.log(`  key: ${pub}`);
  return { sum, sig, pub };
}

function verifyZip(zip, opt) {
  if (!zip || !fs.existsSync(zip)) throw new Fail(`No such update zip: ${zip || '(none given)'}`);
  const pubFile = opt.pub || DEFAULT_PUB;
  let pub;
  try { pub = readPublicKey(fs.readFileSync(pubFile, 'utf8')); } catch (e) { throw new Fail(`${pubFile}: ${e.code === 'ENOENT' ? 'no such file' : e.message}.`); }
  if (!fs.existsSync(`${zip}.sig`)) throw new Fail(`${path.basename(zip)} isn't signed (no ${path.basename(zip)}.sig next to it).`);
  const sum = sha256File(zip);
  if (!verify(sum, readSig(fs.readFileSync(`${zip}.sig`, 'utf8')), pub)) throw new Fail(`${path.basename(zip)}'s signature doesn't match the key ${pub}.`);
  console.log(`${path.basename(zip)} is signed by ${pub} (SHA-256 ${sum}).`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = args(rest);
  if (cmd === 'keygen') return keygen(opt);
  if (cmd === 'sign') return signZip(opt._[0], opt);
  if (cmd === 'verify') return verifyZip(opt._[0], opt);
  if (cmd === 'public') return console.log(publicKeyOf(privateKey(opt).key));
  if (cmd === 'has-key') { if (!privateKeySource(opt)) process.exitCode = 1; return undefined; }
  throw new Fail('Usage: node scripts/update-key.js keygen | sign ZIP | verify ZIP | public | has-key   (see the top of this file)');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) {
    console.error(e instanceof Fail ? e.message : `Error: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { CONTEXT, PUB_RE, SIG_RE, DEFAULT_KEY, signedMessage, sha256File, readPublicKey, loadPrivateKey, publicKeyOf, sign, verify, readSig, pubFileText };
