// Signs the desktop app's update files, so installed apps only take updates from you (see update-verify.js).
// Run by .github/workflows/hearth-apps.yml when the UPDATE_SIGNING_KEY secret exists. Never prints the key.
//
//   node build/sign-update.js keygen       makes a new key pair: put the private key (all of it, with the
//                                          BEGIN/END lines) in the UPDATE_SIGNING_KEY secret; keep a copy safe
//   node build/sign-update.js bake         writes the public key for UPDATE_SIGNING_KEY into hearth.config.json
//                                          (before electron-builder, so the installed app knows it)
//   node build/sign-update.js sign [dist]  writes latest*.yml.sig next to every latest*.yml in dist/
//                                          (after electron-builder and after any step that rewrites latest.yml)
//
// Losing the key, or changing it, means apps built with the old public key refuse new updates: people then
// install the next version by hand from your server's /download page once.
const fs = require('fs');
const path = require('path');
const U = require('../update-verify');

const CONFIG_FILE = path.join(__dirname, '..', 'hearth.config.json');
const say = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice title=Update signing::${msg}` : msg);
const fail = (msg) => { console.log(process.env.GITHUB_ACTIONS ? `::error title=Update signing::${msg}` : `ERROR: ${msg}`); process.exit(1); };

function privateKey() {
  const raw = process.env.UPDATE_SIGNING_KEY || '';
  if (!raw.trim()) fail('UPDATE_SIGNING_KEY is empty.');
  try { return U.loadPrivateKey(raw); } catch (e) { return fail(`UPDATE_SIGNING_KEY isn't a usable Ed25519 private key (${e.message}).`); }
}

function bake() {
  const pub = U.publicKeyText(privateKey());
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  cfg.updatePublicKey = pub;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  say(`This build only installs updates signed with the key whose public half is ${pub}`);
}

function signDir(dir) {
  const key = privateKey();
  const pub = U.loadPublicKey(U.publicKeyText(key));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^latest(-[\w-]+)?\.yml$/.test(f)) : [];
  if (!files.length) fail(`No latest*.yml in ${dir}: nothing to sign.`);
  for (const name of files) {
    const yml = fs.readFileSync(path.join(dir, name));
    if (!U.readMetadata(yml).hashes.size) fail(`${name} lists no SHA-512: is it really electron-builder's update file?`);
    const sig = U.sign(name, yml, key);
    if (!U.verifySignature(name, yml, sig, pub)) fail(`Signing ${name} didn't verify.`);
    fs.writeFileSync(path.join(dir, `${name}.sig`), sig + '\n');
    say(`Signed ${name} (version ${U.readMetadata(yml).version}).`);
  }
}

function keygen() {
  const k = U.generateKeys();
  console.log('Private key (the UPDATE_SIGNING_KEY secret; never commit it):\n');
  console.log(k.privateKeyPem);
  console.log(`Public key (goes into the app at build time; safe to share):\n\n${k.publicKey}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'bake') bake();
else if (cmd === 'sign') signDir(path.resolve(arg || path.join(__dirname, '..', 'dist')));
else if (cmd === 'keygen') keygen();
else fail('Usage: node build/sign-update.js keygen | bake | sign [dist]');
