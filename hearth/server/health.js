// Health checks.
//   GET /api/health/live     the process is up and answering. Public, cheap, no details.
//   GET /api/health/ready    ready for people: the database answers, the data folder is writable, the schema is
//                            current and maintenance is off. Public: only ok/degraded/fail and short codes.
//   GET /api/admin/health    everything, for instance admins: each background job, the news bot's feed worker,
//                            relay regions, backups and restore tests, disk, event-loop lag, memory, versions.
//   PUT /api/admin/alerts    alerts on/off, email on/off, cooldown (turning alerts off needs the password again).
//   POST /api/admin/alerts/test   send a test alert.
//
// Every check says ok, degraded (works, but someone should look) or fail (broken, or about to be). The overall
// status is the worst of them.
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const jobs = require('./jobs');
const log = require('./log');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const RANK = { ok: 0, unknown: 0, degraded: 1, fail: 2 };
const worst = (list) => list.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'ok');
const H = 3600000;

// Disk space: degraded under 10% (or 1 GB) free, fail under 3% (or 200 MB). HEALTH_DISK_WARN_PCT and
// HEALTH_DISK_FAIL_PCT change the percentages.
function diskStatus(free, total) {
  if (!total) return { status: 'unknown', code: 'disk_unknown' };
  const pct = (free / total) * 100;
  const warnPct = +env('HEALTH_DISK_WARN_PCT', 10); const failPct = +env('HEALTH_DISK_FAIL_PCT', 3);
  if (pct < failPct || free < 200 * 1048576) return { status: 'fail', code: 'disk_full', pct };
  if (pct < warnPct || free < 1024 * 1048576) return { status: 'degraded', code: 'disk_low', pct };
  return { status: 'ok', code: 'disk_ok', pct };
}
function diskOf(dir) {
  try { const st = fs.statfsSync(dir); return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; } catch { return null; }
}
// The newest encrypted backup should be under a day old (it's made daily): degraded after 26 hours, fail after 50.
// A failed restore test of the newest one is a failure. Backups switched off is degraded.
function backupFreshness({ enabled, newestAt, newestVerified, now = Date.now() }) {
  if (!enabled) return { status: 'degraded', code: 'backups_off' };
  if (newestVerified && newestVerified.ok === false) return { status: 'fail', code: 'restore_test_failed' };
  if (!newestAt) return { status: 'degraded', code: 'no_backup_yet' };
  const age = now - newestAt;
  if (age > 50 * H) return { status: 'fail', code: 'backup_stale' };
  if (age > 26 * H) return { status: 'degraded', code: 'backup_late' };
  return { status: 'ok', code: 'backup_fresh' };
}

function setupHealth(ctx) {
  const { api, auth, adminOnly, wrap, fail, rateLimit, limitNet, db, DATA_DIR, SCHEMA_VERSION, VERSION, maintenance, stepUp, auditLog, alerts,
    sockets, listEncBackups, listBackups, autoBackup, NEWS_BOT_ID, isAlive } = ctx;
  const started = Date.now();

  // Event-loop lag: the worst (p99) of each minute, so a spike is still visible when someone looks.
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let lag = { p99Ms: 0, maxMs: 0, at: null };
  jobs.every('health.sample', 60000, () => {
    lag = { p99Ms: Math.round(loop.percentile(99) / 1e6), maxMs: Math.round(loop.max / 1e6), at: Date.now() };
    loop.reset();
  }, { firstDelay: 15000 });

  // Writing a small file is the only real test that the data folder takes writes (permissions, a full disk, a
  // read-only mount). Done at most every 30 seconds, whatever the probe rate.
  let writable = { ok: true, at: 0 };
  function dataDirWritable() {
    if (Date.now() - writable.at < 30000) return writable.ok;
    const probe = path.join(DATA_DIR, '.health-probe');
    try { fs.writeFileSync(probe, String(Date.now())); fs.unlinkSync(probe); writable = { ok: true, at: Date.now() }; } catch { writable = { ok: false, at: Date.now() }; }
    return writable.ok;
  }
  function dbOk() {
    try { return db.prepare('SELECT 1 AS one').get().one === 1 ? db.pragma('user_version', { simple: true }) : null; } catch { return null; }
  }

  // The four readiness checks plus disk. Codes only: nothing about paths, versions or errors.
  function readiness() {
    const codes = [];
    let status = 'ok';
    const schema = dbOk();
    if (schema === null) { codes.push('db'); status = 'fail'; } else if (schema !== SCHEMA_VERSION) { codes.push('schema'); status = 'fail'; }
    if (!dataDirWritable()) { codes.push('data_dir'); status = 'fail'; }
    const d = diskOf(DATA_DIR);
    const ds = d ? diskStatus(d.free, d.total) : { status: 'ok' };
    if (ds.status !== 'ok' && ds.code) { codes.push(ds.code); status = worst([status, ds.status]); }
    const maint = !!maintenance();
    if (maint) { codes.push('maintenance'); status = worst([status, 'degraded']); }
    return { status, codes, ready: status !== 'fail' && !maint };
  }

  // Health probes come from a proxy, Docker or an uptime monitor every few seconds: generous limits.
  const probeLimit = (req) => limitNet(req, 'health', 600, 60000);
  api.get('/health/live', (req, res) => {
    probeLimit(req);
    res.json({ status: 'ok' });
  });
  api.get('/health/ready', (req, res) => {
    probeLimit(req);
    const r = readiness();
    res.status(r.ready ? 200 : 503).json({ status: r.status, codes: r.codes });
  });

  // ---------------------------------------------------------------- the full picture (admins)
  function newsbotHealth() {
    const bot = !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(NEWS_BOT_ID);
    const feeds = db.prepare('SELECT COUNT(*) n, SUM(last_error IS NOT NULL) bad, MAX(last_ok) lastOk FROM feeds WHERE paused = 0').get();
    const trackers = (() => { try { return db.prepare('SELECT COUNT(*) n FROM user_feeds').get().n; } catch { return 0; } })();
    const w = jobs.get('newsbot.feeds');
    const t = Date.now();
    let status = 'ok'; let code = 'ok';
    // The worker runs every minute. Only once there's something to poll does a silent worker matter.
    if (feeds.n || trackers) {
      const ranOk = w && w.lastOk;
      if (!ranOk && t - started > 3 * 60000) { status = 'fail'; code = 'worker_never_ran'; } else if (ranOk && t - ranOk > 5 * 60000) { status = 'fail'; code = 'worker_stuck'; } else if (ranOk && t - ranOk > 150000) { status = 'degraded'; code = 'worker_late'; } else if (feeds.n && feeds.bad > feeds.n / 2) { status = 'degraded'; code = 'feeds_failing'; }
    }
    return { status, code, botAccount: bot, feeds: feeds.n || 0, feedsWithErrors: feeds.bad || 0, lastFeedSuccess: feeds.lastOk || null, trackers,
      worker: w ? { lastRun: w.lastRun, lastOk: w.lastOk, failures: w.failures, lastError: w.lastError } : null };
  }
  function regionsHealth() {
    const rows = db.prepare('SELECT id, name, last_seen FROM regions ORDER BY created_at').all();
    const list = rows.map((r) => ({ id: r.id, name: r.name, lastSeen: r.last_seen || null, installed: !!r.last_seen, alive: !!isAlive(r) }));
    const down = list.filter((r) => r.installed && !r.alive);
    return { status: down.length ? 'degraded' : 'ok', code: down.length ? 'relay_down' : list.length ? 'ok' : 'none', regions: list, down: down.length };
  }
  function backupHealth() {
    const enc = listEncBackups();
    const newest = enc[0];
    const a = autoBackup();
    const f = backupFreshness({ enabled: a.enabled, newestAt: newest && newest.at, newestVerified: newest && newest.verified });
    const lastVerified = enc.map((b) => b.verified).filter(Boolean).sort((x, y) => (y.at || 0) - (x.at || 0))[0] || null;
    const dbCopies = listBackups();
    return { ...f, enabled: a.enabled, keep: a.keep, newest: newest ? { name: newest.name, at: newest.at, size: newest.size } : null, count: enc.length,
      lastRestoreTest: lastVerified ? { ok: !!lastVerified.ok, at: lastVerified.at || null, error: lastVerified.ok ? undefined : log.scrub(lastVerified.error || '').slice(0, 200) } : null,
      offsite: newest && newest.offsite ? { ok: !!newest.offsite.ok, at: newest.offsite.at || null } : null,
      offsiteConfigured: !!String(process.env.BACKUP_RCLONE_REMOTE || '').trim(), newestDbCopy: dbCopies[0] ? dbCopies[0].at : null,
      job: jobs.get('backup.daily') };
  }
  function processHealth() {
    const m = process.memoryUsage();
    const lagStatus = lag.p99Ms > 1000 ? 'fail' : lag.p99Ms > 200 ? 'degraded' : 'ok';
    return { status: lagStatus, code: lagStatus === 'ok' ? 'ok' : 'event_loop_lag', lagP99Ms: lag.p99Ms, lagMaxMs: lag.maxMs, lagSampledAt: lag.at,
      rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, uptime: Math.round(process.uptime()), version: VERSION, node: process.version, pid: process.pid, sockets: sockets() };
  }
  function full() {
    const r = readiness();
    const d = diskOf(DATA_DIR);
    const disk = d ? { ...d, ...diskStatus(d.free, d.total) } : { status: 'unknown', code: 'disk_unknown' };
    const jobList = jobs.list().map((j) => ({ ...j, status: jobs.statusOf(j) }));
    const jobStatus = worst(jobList.map((j) => j.status));
    const schema = dbOk();
    const parts = {
      database: { status: schema === null ? 'fail' : schema !== SCHEMA_VERSION ? 'fail' : 'ok', schema, expectedSchema: SCHEMA_VERSION },
      dataDir: { status: dataDirWritable() ? 'ok' : 'fail', path: DATA_DIR },
      maintenance: { status: maintenance() ? 'degraded' : 'ok', on: !!maintenance() },
      disk, jobs: { status: jobStatus, failing: jobList.filter((j) => j.status !== 'ok').map((j) => j.name) },
      newsbot: newsbotHealth(), regions: regionsHealth(), backups: backupHealth(), process: processHealth(),
      security: { status: 'ok', ...alerts.stats() },
    };
    const st = alerts.stats();
    if (st.authFails10m >= alerts.thresholds.authFails) parts.security.status = 'degraded';
    if (st.errors10m >= alerts.thresholds.errors) parts.process.status = worst([parts.process.status, 'degraded']);
    return { status: worst(Object.values(parts).map((p) => p.status)), ready: r.ready, codes: r.codes, checkedAt: Date.now(), ...parts, jobList,
      alerts: { ...alerts.config(), recent: alerts.recent() } };
  }
  api.get('/admin/health', auth, adminOnly, (req, res) => {
    rateLimit('adminhealth:' + req.userId, 120, 60000);
    res.json(full());
  });
  // Turning alerts off is what someone hiding what they're doing would want: like fewer backups, it needs the
  // password (and two-factor) again. Turning them on, or other changes, doesn't.
  api.put('/admin/alerts', auth, adminOnly, wrap(async (req, res) => {
    rateLimit('alertcfg:' + req.userId, 30, 3600000);
    const b = req.body || {};
    const before = alerts.config();
    const turningOff = (b.enabled === false && before.enabled) || (b.email === false && before.email);
    if (turningOff) await stepUp(req, b);
    if (b.cooldownMin !== undefined && !(+b.cooldownMin > 0)) fail(400, 'The cooldown is a number of minutes.');
    const after = alerts.setConfig({ enabled: b.enabled, email: b.email, cooldownMin: b.cooldownMin });
    auditLog(req, 'alerts_settings', null, `alerts ${before.enabled ? 'on' : 'off'} → ${after.enabled ? 'on' : 'off'}, email ${before.email ? 'on' : 'off'} → ${after.email ? 'on' : 'off'}, cooldown ${before.cooldownMin} → ${after.cooldownMin} min`);
    res.json(after);
  }));
  api.post('/admin/alerts/test', auth, adminOnly, (req, res) => {
    rateLimit('alerttest:' + req.userId, 3, 3600000);
    const out = alerts.raise(`test:${Date.now()}`, { severity: 'warning', title: 'Test alert', detail: 'This is a test from Admin → Health. If you got it, alerts reach you.' });
    auditLog(req, 'alerts_test', null, out);
    res.json({ result: out });
  });

  // ---------------------------------------------------------------- watching for trouble (alerts)
  const downSince = new Map();
  jobs.every('alerts.check', 60000, () => {
    const d = diskOf(DATA_DIR);
    if (d) {
      const ds = diskStatus(d.free, d.total);
      if (ds.status !== 'ok' && ds.status !== 'unknown') alerts.raise(`disk:${ds.status}`, { severity: ds.status === 'fail' ? 'critical' : 'warning', title: ds.status === 'fail' ? 'The disk is almost full' : 'Disk space is getting low', detail: `${(d.free / 1073741824).toFixed(1)} GB free of ${(d.total / 1073741824).toFixed(1)} GB (${ds.pct.toFixed(1)}%) where Hearth keeps its data. Uploads and backups stop working when it runs out.` });
      else { alerts.clear('disk:degraded'); alerts.clear('disk:fail'); }
    }
    // A region that was up and has gone quiet (its agent reports every minute; it counts as down after 3).
    for (const r of regionsHealth().regions) {
      const key = `region:${r.id}`;
      if (r.installed && !r.alive) {
        if (!downSince.has(r.id)) downSince.set(r.id, Date.now());
        alerts.raise(key, { severity: 'warning', title: `Relay region "${r.name}" is down`, detail: `No heartbeat since ${new Date(r.lastSeen).toISOString()}. Calls that relied on it fall back to the other relays. Check the region's server (Admin → Regions).` });
      } else if (downSince.has(r.id)) { downSince.delete(r.id); alerts.clear(key); }
    }
  }, { firstDelay: 90000 });

  return { readiness, full, diskStatus, backupFreshness };
}

module.exports = { setupHealth, diskStatus, diskOf, backupFreshness, worst };
