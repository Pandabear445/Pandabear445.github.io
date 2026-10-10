// Background jobs that can't take the server down. Every timer that does real work goes through here:
//   every(name, ms, fn, { firstDelay })   run fn every ms (first run after firstDelay, default ms)
//   after(name, ms, fn)                   run fn once, ms from now
//   job(name, fn)                         a safe version of fn to hand to any other timer (debounces and the like)
// Errors, thrown or rejected, are caught and logged with the job's name, and never reach the top level (where one
// SQLITE_BUSY used to crash the whole server). Each job keeps a health record: last run, last success, last error,
// failures in a row. A run that's still going when the next one is due is skipped, not stacked.
//
// The records live in memory; setStore() lets the server also save them to the database (throttled), so
// `node server/cli.js doctor` can report them from another process.
const log = require('./log');

const jobs = new Map(); // name -> record
let store = null; // (record) => void
let onFailure = null; // (record, err) => void
let onRecover = null; // (record) => void
const SAVE_EVERY_MS = 60000;

function recordFor(name, everyMs = null) {
  let r = jobs.get(name);
  if (!r) {
    r = { name, everyMs, lastRun: null, lastOk: null, lastError: null, lastErrorAt: null, lastErrorCategory: null, failures: 0, runs: 0, totalFailures: 0, skipped: 0, durationMs: null, running: false, savedAt: 0 };
    jobs.set(name, r);
  }
  if (everyMs && !r.everyMs) r.everyMs = everyMs;
  return r;
}
function save(r, force) {
  if (!store) return;
  const t = Date.now();
  if (!force && t - r.savedAt < SAVE_EVERY_MS) return;
  r.savedAt = t;
  try { store(r); } catch (e) { log.warn('jobs', 'save_failed', { job: r.name, err: e, msg: 'Couldn’t save a job’s health record.' }); }
}
function finish(r, started, err) {
  r.running = false;
  r.durationMs = Date.now() - started;
  const wasFailing = r.failures > 0;
  if (err) {
    r.failures++;
    r.totalFailures++;
    r.lastError = log.scrub(err && err.message ? err.message : String(err)).slice(0, 300);
    r.lastErrorAt = Date.now();
    r.lastErrorCategory = log.errorCategory(err);
    log.error('jobs', 'run_failed', err, { job: r.name, outcome: 'error', durationMs: r.durationMs, failuresInARow: r.failures });
    if (onFailure) { try { onFailure(r, err); } catch { /* alerts must not break jobs */ } }
  } else {
    r.lastOk = Date.now();
    if (wasFailing) {
      log.info('jobs', 'recovered', { job: r.name, outcome: 'ok', msg: `Working again after ${r.failures} failure${r.failures === 1 ? '' : 's'}.` });
      if (onRecover) { try { onRecover(r); } catch { /* alerts must not break jobs */ } }
    }
    r.failures = 0;
  }
  // Changes between working and failing are saved right away; routine runs at most once a minute.
  save(r, !!err !== wasFailing);
}

// A safe, health-recording version of fn. Returns a promise for async work (that never rejects).
function job(name, fn, opts = {}) {
  const r = recordFor(name, opts.everyMs);
  return (...args) => {
    if (r.running && opts.noOverlap) { r.skipped++; return undefined; }
    r.running = true;
    r.lastRun = Date.now();
    r.runs++;
    const started = r.lastRun;
    try {
      const out = log.withContext({ job: name }, () => fn(...args));
      if (out && typeof out.then === 'function') return out.then(() => finish(r, started), (e) => finish(r, started, e || new Error('rejected')));
      finish(r, started);
      return out;
    } catch (e) {
      finish(r, started, e);
      return undefined;
    }
  };
}
function every(name, ms, fn, { firstDelay = ms } = {}) {
  const run = job(name, fn, { everyMs: ms, noOverlap: true });
  let interval = null;
  const first = setTimeout(() => { run(); interval = setInterval(run, ms); interval.unref?.(); }, Math.max(0, firstDelay));
  first.unref?.();
  return { stop: () => { clearTimeout(first); if (interval) clearInterval(interval); }, run };
}
function after(name, ms, fn) {
  const t = setTimeout(job(name, fn), Math.max(0, ms));
  t.unref?.();
  return t;
}

// What the admin dashboard and the doctor show. stale: an every() job that hasn't run for 3 of its periods.
function list() {
  const t = Date.now();
  return [...jobs.values()].map((r) => ({
    name: r.name, everyMs: r.everyMs, lastRun: r.lastRun, lastOk: r.lastOk, lastError: r.lastError, lastErrorAt: r.lastErrorAt, lastErrorCategory: r.lastErrorCategory,
    failures: r.failures, runs: r.runs, totalFailures: r.totalFailures, skipped: r.skipped, durationMs: r.durationMs, running: r.running,
    stale: !!(r.everyMs && r.lastRun && t - r.lastRun > 3 * r.everyMs + 60000),
  })).sort((a, b) => a.name.localeCompare(b.name));
}
// ok, degraded (failing now, or late) or fail (failing FAIL_AFTER times in a row).
const FAIL_AFTER = 3;
const statusOf = (j) => (j.failures >= FAIL_AFTER ? 'fail' : j.failures > 0 || j.stale ? 'degraded' : 'ok');
const get = (name) => list().find((j) => j.name === name) || null;
const saveAll = () => { for (const r of jobs.values()) save(r, true); };

module.exports = {
  job, every, after, list, get, statusOf, saveAll, FAIL_AFTER,
  setStore: (fn) => { store = fn; },
  setOnFailure: (fn) => { onFailure = fn; },
  setOnRecover: (fn) => { onRecover = fn; },
};
