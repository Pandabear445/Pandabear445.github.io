// Health checks.
//   GET /api/health/live     the process is up and answering. Public, cheap, no details.
//   GET /api/health/ready    ready for people: the database answers, the data folder is writable, the schema is
//                            current and maintenance is off. Public: only ok/degraded/fail and short codes.
//   GET /api/admin/health    everything, for instance admins: each background job, the news bot's feed worker,
//                            relay regions, backups and restore tests, disk, event-loop lag, memory, versions.
//   PUT /api/admin/alerts    alerts on/off, email on/off, cooldown (turning alerts off, or lengthening the cooldown past
//                            an hour, needs the password again, and a fresh two-factor code when it's on: stepUp).
//   POST /api/admin/alerts/test   send a test alert.
//   /api/admin/alerts/channels    where else alerts go (ntfy, a signed webhook, Discord, Slack: alertchannels.js).
//                            Adding one is for admins; turning one off, changing its address or removing it also
//                            needs the password and a fresh code again, like turning alerts off.
//   GET /metrics             Prometheus text format, off unless METRICS_TOKEN is set (metrics.js).
//
// Every check says ok, degraded (works, but someone should look) or fail (broken, or about to be). The overall
// status is the worst of them.
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const jobs = require('./jobs');
const log = require('./log');
const setupAlertChannels = require('./alertchannels');
const METRICS = require('./metrics');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const RANK = { ok: 0, unknown: 0, degraded: 1, fail: 2 };
const worst = (list) => list.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'ok');
const H = 3600000;
const LONGEST_FREE_COOLDOWN = 60; // minutes (the default): longer needs the password

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
    sockets, listEncBackups, listBackups, autoBackup, NEWS_BOT_ID, isAlive, app, getSetting, setSetting, sealSecret, openSecret, brandName,
    emitAdmins = () => {}, countHit, hitsSoFar, netOf } = ctx;
  const started = Date.now();
  const channels = setupAlertChannels({ getSetting, setSetting, sealSecret, openSecret, fail, alerts, brandName, emitAdmins });
  alerts.useChannels(channels);

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
      security: { status: 'ok', ...alerts.stats() }, alertChannels: channelsHealth(),
    };
    const st = alerts.stats();
    if (st.authFails10m >= alerts.thresholds.authFails) parts.security.status = 'degraded';
    if (st.errors10m >= alerts.thresholds.errors) parts.process.status = worst([parts.process.status, 'degraded']);
    return { status: worst(Object.values(parts).map((p) => p.status)), ready: r.ready, codes: r.codes, checkedAt: Date.now(), ...parts, jobList,
      alerts: { ...alerts.config(), recent: alerts.recent(), channels: channels.list() } };
  }
  // A switched-on channel whose last 3 deliveries failed needs a look: alerts may not be reaching anyone there.
  function channelsHealth() {
    const on = channels.list().filter((c) => c.enabled);
    const failing = on.filter((c) => c.failures >= setupAlertChannels.FAILING_AFTER).length;
    return { status: failing ? 'degraded' : 'ok', code: failing ? 'channel_failing' : 'ok', on: on.length, failing };
  }
  api.get('/admin/health', auth, adminOnly, (req, res) => {
    rateLimit('adminhealth:' + req.userId, 120, 60000);
    res.json(full());
  });
  // Turning alerts off is what someone hiding what they're doing would want: like fewer backups, it needs the
  // password (and two-factor) again. So does a cooldown made longer than an hour (a week of it is nearly "off": each
  // kind of alert would reach the owner once a week). Turning them on, a shorter cooldown and the rest don't.
  api.put('/admin/alerts', auth, adminOnly, wrap(async (req, res) => {
    rateLimit('alertcfg:' + req.userId, 30, 3600000);
    const b = req.body || {};
    const before = alerts.config();
    if (b.cooldownMin !== undefined && !(+b.cooldownMin > 0)) fail(400, 'The cooldown is a number of minutes.'); // (before a code is used up)
    // Any falsy value turns a switch off in setConfig (null, 0, ""), so any of them needs the password, not only false.
    const off = (k) => b[k] !== undefined && !b[k] && before[k];
    const cooldown = b.cooldownMin !== undefined ? Math.max(1, Math.min(7 * 24 * 60, Math.round(+b.cooldownMin) || 60)) : before.cooldownMin;
    const longer = cooldown > before.cooldownMin && cooldown > LONGEST_FREE_COOLDOWN;
    if (off('enabled') || off('email') || longer) await stepUp(req, b);
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

  // ---------------------------------------------------------------- where else alerts go (alertchannels.js)
  // Adding one only adds a place alerts go, so it's for any instance admin. Turning one off, pointing it somewhere
  // else or removing it is what someone covering their tracks would do (alerts stop reaching the owner there), so
  // like turning alerts off it needs the password (and two-factor) again. All of it is in the audit log, masked.
  const chanLimit = (req) => rateLimit('alertchan:' + req.userId, 30, 3600000);
  const chanAudit = (req, action, c, more = '') => auditLog(req, action, c.id, `${c.kindLabel} "${c.name}" (${c.where})${more}`);
  api.get('/admin/alerts/channels', auth, adminOnly, (req, res) => {
    rateLimit('adminhealth:' + req.userId, 120, 60000);
    res.json({ channels: channels.list() });
  });
  api.post('/admin/alerts/channels', auth, adminOnly, wrap(async (req, res) => {
    chanLimit(req);
    const out = await channels.add(req.body || {}, req.userId);
    chanAudit(req, 'alert_channel_added', out.channel);
    // A webhook's signing secret is in this answer and nowhere else, ever again.
    res.json(out.secret ? { channel: out.channel, secret: out.secret } : { channel: out.channel });
  }));
  api.put('/admin/alerts/channels/:id', auth, adminOnly, wrap(async (req, res) => {
    chanLimit(req);
    const b = req.body || {};
    const before = channels.get(req.params.id);
    if (!before) fail(404, 'That alert channel is gone.', 'not_found');
    const retarget = ['url', 'topic', 'token'].some((k) => b[k] !== undefined);
    // A new address, topic or token is checked first, so a typo doesn't use up a two-factor code (update checks it
    // again: a lookup can change in between).
    if (retarget) await channels.check(before.id, b);
    // Any falsy `enabled` turns it off (as in PUT /admin/alerts), so the check isn't only for false.
    if (retarget || (b.enabled !== undefined && !b.enabled && before.enabled)) await stepUp(req, b);
    const after = await channels.update(before.id, { name: b.name, enabled: b.enabled, url: b.url, topic: b.topic, token: b.token });
    const what = [before.name !== after.name ? `renamed from "${before.name}"` : '', before.enabled !== after.enabled ? (after.enabled ? 'turned on' : 'turned off') : '',
      retarget ? `address was ${before.where}` : ''].filter(Boolean).join(', ');
    chanAudit(req, 'alert_channel_changed', after, what ? `: ${what}` : '');
    res.json({ channel: after });
  }));
  api.delete('/admin/alerts/channels/:id', auth, adminOnly, wrap(async (req, res) => {
    chanLimit(req);
    if (!channels.get(req.params.id)) fail(404, 'That alert channel is gone.', 'not_found');
    await stepUp(req, req.body);
    chanAudit(req, 'alert_channel_removed', channels.remove(req.params.id));
    res.json({ ok: true });
  }));
  // The Test button: one message to that channel only (switched on or not), and what came back.
  api.post('/admin/alerts/channels/:id/test', auth, adminOnly, wrap(async (req, res) => {
    rateLimit('alertchantest:' + req.userId, 20, 3600000);
    const result = await channels.test(req.params.id);
    const c = channels.get(req.params.id);
    if (c) chanAudit(req, 'alert_channel_test', c, result.ok ? ': delivered' : `: failed (${result.error})`);
    res.json({ result, channel: c });
  }));

  // ---------------------------------------------------------------- /metrics (metrics.js)
  // The two totals are counted at most once a minute: COUNT(*) reads a whole index, and scrapers ask every few seconds.
  let totals = { at: 0 };
  function cachedTotals() {
    if (Date.now() - totals.at < 60000) return totals;
    const n = (q) => { try { return db.prepare(q).get().n; } catch { return NaN; } };
    totals = { at: Date.now(), users: n('SELECT COUNT(*) n FROM users WHERE is_bot = 0 AND deleted_at IS NULL'), channel: n('SELECT COUNT(*) n FROM messages'), direct: n('SELECT COUNT(*) n FROM dm_messages') };
    return totals;
  }
  const secs = (ms) => (ms ? Math.round(ms / 1000) : NaN);
  const fam = (name, help, samples, type = 'gauge') => ({ name, help, type, samples });
  function metricsNow() {
    const m = process.memoryUsage();
    const d = diskOf(DATA_DIR);
    const enc = listEncBackups();
    const newest = enc[0];
    const t = cachedTotals();
    const c = METRICS.counts();
    const jobList = jobs.list();
    // A job that hasn't run (or succeeded) yet has no time: its sample is left out rather than NaN.
    const perJob = (pick) => jobList.map((j) => [{ job: j.name }, pick(j)]).filter(([, v]) => !Number.isNaN(v));
    return [
      fam('hearth_info', 'This Hearth server: its version and database schema (always 1).', [[{ version: VERSION, schema: String(SCHEMA_VERSION), node: process.version }, 1]]),
      fam('hearth_ready', '1 when /api/health/ready says ready, 0 when not.', [[null, readiness().ready ? 1 : 0]]),
      fam('hearth_process_uptime_seconds', 'Seconds since this process started.', [[null, Math.round(process.uptime())]]),
      fam('hearth_event_loop_lag_p99_seconds', 'Event-loop delay, 99th percentile over the last sampled minute.', [[null, lag.p99Ms / 1000]]),
      fam('hearth_event_loop_lag_max_seconds', 'Event-loop delay, worst over the last sampled minute.', [[null, lag.maxMs / 1000]]),
      fam('hearth_process_resident_memory_bytes', 'Resident memory of the process.', [[null, m.rss]]),
      fam('hearth_process_heap_used_bytes', 'JavaScript heap in use.', [[null, m.heapUsed]]),
      fam('hearth_process_heap_total_bytes', 'JavaScript heap allocated.', [[null, m.heapTotal]]),
      fam('hearth_http_requests_total', 'HTTP answers since the process started, by status class.', Object.entries(c.requests).map(([k, v]) => [{ class: k }, v]), 'counter'),
      fam('hearth_unexpected_errors_total', 'Unexpected errors logged since the process started.', [[null, c.unexpectedErrors]], 'counter'),
      fam('hearth_sockets', 'Open live connections (Socket.IO).', [[null, sockets()]]),
      fam('hearth_job_last_run_timestamp_seconds', 'When each background job last ran (Unix time).', perJob((j) => secs(j.lastRun))),
      fam('hearth_job_last_success_timestamp_seconds', 'When each background job last succeeded (Unix time).', perJob((j) => secs(j.lastOk))),
      fam('hearth_job_runs_total', 'Runs of each background job since the process started.', perJob((j) => j.runs), 'counter'),
      fam('hearth_job_failures_total', 'Failed runs of each background job since the process started.', perJob((j) => j.totalFailures), 'counter'),
      fam('hearth_job_consecutive_failures', 'Failures in a row of each background job (0 once a run works).', perJob((j) => j.failures)),
      fam('hearth_backups', 'Encrypted backups kept.', [[null, enc.length]]),
      fam('hearth_backup_last_timestamp_seconds', 'When the newest encrypted backup was made (Unix time); absent when there is none.', newest && newest.at ? [[null, secs(newest.at)]] : []),
      fam('hearth_backup_age_seconds', 'Age of the newest encrypted backup; absent when there is none.', newest && newest.at ? [[null, Math.max(0, Math.round((Date.now() - newest.at) / 1000))]] : []),
      fam('hearth_disk_free_bytes', 'Free space where Hearth keeps its data.', d ? [[null, d.free]] : []),
      fam('hearth_disk_total_bytes', 'Size of the disk where Hearth keeps its data.', d ? [[null, d.total]] : []),
      fam('hearth_registered_users', 'Accounts (bots and webhooks not counted).', [[null, t.users]]),
      fam('hearth_messages', 'Messages stored, by kind (channel or direct).', [[{ kind: 'channel' }, t.channel], [{ kind: 'direct' }, t.direct]]),
    ];
  }
  if (app) METRICS.setupMetrics({ app, limitNet, countHit, hitsSoFar, netOf, collect: metricsNow });

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

  return { readiness, full, diskStatus, backupFreshness, channels };
}

module.exports = { setupHealth, diskStatus, diskOf, backupFreshness, worst, LONGEST_FREE_COOLDOWN };
