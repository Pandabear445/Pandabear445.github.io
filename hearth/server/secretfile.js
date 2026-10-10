// Files holding a secret this server makes for itself the first time it starts (the at-rest key, the backup key,
// the push notification keys). The file is created only if it isn't there yet (O_EXCL), so two processes starting
// at the same moment can't each write one and go on using different keys: the slower one reads the other's.
const fs = require('fs');

function readOrCreate(file, make, mode = 0o600) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const value = make();
  try {
    fs.writeFileSync(file, value, { mode, flag: 'wx' });
    return value;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return fs.readFileSync(file, 'utf8');
  }
}

module.exports = { readOrCreate };
