// Signs the desktop app's update files, so installed apps only take updates from you (see update-verify.js).
// Run by .github/workflows/hearth-apps.yml: "bake" in the build with the UPDATE_PUBLIC_KEY variable, "sign" in a
// job of its own with the UPDATE_SIGNING_KEY secret (so the private key never meets npm packages' code). Never
// prints the private key.
//
//   node build/sign-update.js keygen       makes a new key pair: put the private key (all of it, with the
//                                          BEGIN/END lines) in the UPDATE_SIGNING_KEY secret and the public key in
//                                          the UPDATE_PUBLIC_KEY variable; keep a copy of the private key safe
//   node build/sign-update.js bake         writes the public key (UPDATE_PUBLIC_KEY, or else the one for
//                                          UPDATE_SIGNING_KEY) into hearth.config.json (before electron-builder, so
//                                          the installed app knows it)
//   node build/sign-update.js sign [dist]  writes latest*.yml.sig next to every latest*.yml in dist/ (after
//                                          electron-builder and after any step that rewrites latest.yml); only
//                                          with UPDATE_PUBLIC_KEY set, and only with that key's private half
//   node build/sign-update.js pubkey       prints the public half of UPDATE_SIGNING_KEY (what UPDATE_PUBLIC_KEY
//                                          must be when you already have the secret: don't make a new pair)
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

// UPDATE_PUBLIC_KEY, as the one line of base64 hearth.config.json holds; '' when it isn't set.
function publicKeyVar() {
  const raw = (process.env.UPDATE_PUBLIC_KEY || '').trim();
  if (!raw) return '';
  try { return U.loadPublicKey(raw).export({ type: 'spki', format: 'der' }).toString('base64'); } catch (e) { return fail(`UPDATE_PUBLIC_KEY isn't an Ed25519 public key (${e.message}).`); }
}

function bake() {
  const pub = publicKeyVar() || U.publicKeyText(privateKey());
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  cfg.updatePublicKey = pub;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  say(`This build only installs updates signed with the key whose public half is ${pub}`);
}

function signDir(dir) {
  const key = privateKey();
  // The apps are built with UPDATE_PUBLIC_KEY (the build job never sees the private key). Without it they carry no
  // key: apps already installed would take this signed update, and from then on accept unverified ones.
  const want = publicKeyVar();
  if (!want) fail(`UPDATE_PUBLIC_KEY isn't set, so the apps being signed here were built without a key and wouldn't check their own updates. Set the repository variable UPDATE_PUBLIC_KEY to this key's public half, ${U.publicKeyText(key)} (don't make a new key pair: installed apps only accept updates signed with this one), then build again. Nothing was signed.`);
  if (want !== U.publicKeyText(key)) fail(`UPDATE_SIGNING_KEY isn't the private half of UPDATE_PUBLIC_KEY (${want}), the key these apps were built with: they would refuse these updates. Nothing was signed.`);
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
  console.log(`Public key (the UPDATE_PUBLIC_KEY variable; goes into the app at build time; safe to share):\n\n${k.publicKey}`);
}

// The public half of an existing UPDATE_SIGNING_KEY, for the UPDATE_PUBLIC_KEY variable.
function pubkey() {
  console.log(U.publicKeyText(privateKey()));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'bake') bake();
else if (cmd === 'sign') signDir(path.resolve(arg || path.join(__dirname, '..', 'dist')));
else if (cmd === 'keygen') keygen();
else if (cmd === 'pubkey') pubkey();
else fail('Usage: node build/sign-update.js keygen | pubkey | bake | sign [dist]');
