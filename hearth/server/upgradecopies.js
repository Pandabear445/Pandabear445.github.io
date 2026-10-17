// The copies of the database that db.js makes before an upgrade: data/backups/hearth-before-v<version>-<time>.db.
//
// data-4 / crypto-8: they used to pile up for good, a full copy of the database (accounts, sealed messages, identity
// keys wrapped by people's passwords) for every upgrade ever made. Now, once an upgrade has gone through,
// only the newest PRE_UPGRADE_KEEP of them stay (3 by default; 0 keeps them all, as before). The copy that upgrade
// made (or found already made) is never removed, and only files named exactly the way db.js names them are touched:
// a copy someone renamed, or anything else in the folder, is left alone.
//
// They aren't encrypted: each is a plain SQLite file like data/hearth.db next to it, protected the same way (by who
// can read the data folder). The encrypted backups (server/backup.js) are the ones meant to leave the machine.
const fs = require('fs');
const path = require('path');

const DEFAULT_KEEP = 3;
// hearth-before-v19-2026-10-11T12-34-56-789Z.db (the time is new Date().toISOString() with ":" and "." as "-").
const COPY_NAME = /^hearth-before-v(\d{1,6})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.db$/;

// How many copies to keep: PRE_UPGRADE_KEEP, a whole number (0 = all). null if it's set to something else.
function keepSetting(v = process.env.PRE_UPGRADE_KEEP) {
  const s = v === undefined ? '' : String(v).trim();
  if (s === '') return DEFAULT_KEEP;
  return /^\d{1,6}$/.test(s) ? Number(s) : null;
}

// Which of these file names go: all copies but the newest `keep` (by the time in their name), never `protect`
// (which counts as one of the ones kept), and never a name that isn't exactly a copy's.
function copiesToPrune(names, keep, protect = null) {
  if (!keep) return [];
  const copies = names.map((f) => ({ f, m: COPY_NAME.exec(f) })).filter((x) => x.m && x.f !== protect)
    .sort((a, b) => (a.m[2] === b.m[2] ? Number(b.m[1]) - Number(a.m[1]) : a.m[2] < b.m[2] ? 1 : -1));
  const others = protect && COPY_NAME.test(protect) && names.includes(protect) ? keep - 1 : keep;
  return copies.slice(Math.max(0, others)).map((x) => x.f);
}

// Removes the copies that go from `dir`. Returns the names removed. Only plain files count as copies: a link or a
// folder that happens to have such a name is neither removed nor counted as one of those kept.
function pruneUpgradeCopies(dir, { keep = DEFAULT_KEEP, protect = null } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const plain = (f) => { try { return fs.lstatSync(path.join(dir, f)).isFile(); } catch { return false; } };
  const removed = [];
  for (const f of copiesToPrune(names.filter((f) => COPY_NAME.test(f) && plain(f)), keep, protect)) {
    try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch { /* already gone */ }
  }
  return removed;
}

module.exports = { COPY_NAME, DEFAULT_KEEP, keepSetting, copiesToPrune, pruneUpgradeCopies };
