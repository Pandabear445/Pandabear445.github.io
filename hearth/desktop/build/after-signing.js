// After SignPath has signed the Windows installer (see hearth/docs/SIGNING.md), its bytes changed, so the
// update files electron-builder wrote no longer match it. This rebuilds the installer's .blockmap (used for
// small differential updates) and puts the new size and SHA-512 into latest.yml, exactly as electron-builder
// would have. Without this, every installed app would refuse the update ("sha512 checksum mismatch").
//
//   node build/after-signing.js [distDir]
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

async function main(dist) {
  const ymlFile = path.join(dist, 'latest.yml');
  const info = yaml.load(fs.readFileSync(ymlFile, 'utf8'));
  const files = Array.isArray(info.files) ? info.files : [];
  if (!files.length) throw new Error('latest.yml lists no files');
  for (const f of files) {
    const file = path.join(dist, f.url);
    if (!fs.existsSync(file)) throw new Error(`latest.yml names ${f.url}, which isn't in ${dist}`);
    const r = await buildBlockMap(file, 'gzip', `${file}.blockmap`);
    console.log(`${f.url}: ${f.size} -> ${r.size} bytes, sha512 updated, blockmap rebuilt`);
    f.sha512 = r.sha512;
    f.size = r.size;
    if (info.path === f.url) info.sha512 = r.sha512;
  }
  fs.writeFileSync(ymlFile, yaml.dump(info, { lineWidth: 8000 }));
}

main(path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'))).catch((e) => {
  console.log(process.env.GITHUB_ACTIONS ? `::error title=Windows signing::${e.message}` : `ERROR: ${e.message}`);
  process.exit(1);
});
