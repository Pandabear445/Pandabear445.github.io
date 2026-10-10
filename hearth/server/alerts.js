// Alerts for the instance owner: things that need a person to look, sent to the owner's confirmed email (through the
// accounts module's notify) and to the admin dashboard live (the 'admins' socket room, as 'admin:alert').
//
// Kinds: repeated application errors, failed backups and restore tests, a background job failing again and again,
// a relay region going quiet, low disk space, and sign-in abuse spikes (from the security log).
//
// No storms: each alert has a key, and the same key is sent at most once per cooldown (default an hour), however
// often it fires; on top of that at most MAX_PER_HOUR alerts go out per hour in all. What was held back is counted
// and mentioned in the next one. Alerts never carry secrets or message content: only what happened, counts and
// short, scrubbed error descriptions.
const log = require('./log');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const WINDOW_MS = 10 * 60000;
const MAX_PER_HOUR = 12;
const SECURITY_TYPES = new Set(['failed_login', 'failed_stepup', 'captcha_failed', 'blocked_ip', 'failed_2fa', 'reset_bad_proof', 'sign_key_bad_proof']);

// Counts in a sliding window (timestamps, pruned as they age out).
function windowCounter(windowMs) {
  const hits = [];
  const prune = (t) => { while (hits.length && hits[0].at < t - windowMs) hits.shift(); };
  return {
    add(kind) { const t = Date.now(); hits.push({ at: t, kind }); prune(t); if (hits.length > 20000) hits.splice(0, hits.length - 20000); return hits.length; },
    count() { prune(Date.now()); return hits.length; },
    byKind() { prune(Date.now()); const out = {}; for (const h of hits) out[h.kind] = (out[h.kind] || 0) + 1; return out; },
  };
}

module.exports = function setupAlerts(ctx) {
  const { getSetting, setSetting, emitAdmins, ownerRow, notify } = ctx;
  const now = () => Date.now();
  const thresholds = {
    errors: Math.max(1, +env('ALERT_ERRORS', 10)), // unexpected errors in 10 minutes
    authFails: Math.max(1, +env('ALERT_AUTH_FAILS', 50)), // failed sign-ins, robot checks, blocked addresses in 10 minutes
    jobFailures: Math.max(1, +env('ALERT_JOB_FAILURES', 3)), // failures in a row
  };

  function config() {
    let v = {};
    try { v = JSON.parse(getSetting('alerts') || '{}') || {}; } catch { /* defaults */ }
    const envOn = String(env('ALERTS', 'on')).toLowerCase() !== 'off';
    return {
      enabled: v.enabled !== undefined ? !!v.enabled : envOn,
      email: v.email !== undefined ? !!v.email : true,
      cooldownMin: Math.max(1, Math.min(7 * 24 * 60, Math.round(+(v.cooldownMin || env('ALERT_COOLDOWN_MIN', 60))) || 60)),
      thresholds,
    };
  }
  function setConfig(patch) {
    const c = config();
    const next = { enabled: patch.enabled !== undefined ? !!patch.enabled : c.enabled, email: patch.email !== undefined ? !!patch.email : c.email,
      cooldownMin: patch.cooldownMin !== undefined ? Math.max(1, Math.min(7 * 24 * 60, Math.round(+patch.cooldownMin) || 60)) : c.cooldownMin };
    setSetting('alerts', JSON.stringify(next));
    return config();
  }

  // Saved, so a restart (or a crash loop) doesn't send everything again.
  let state = null;
  const load = () => {
    if (state) return state;
    try { state = JSON.parse(getSetting('alertState') || '{}') || {}; } catch { state = {}; }
    state.keys = state.keys || {}; state.recent = Array.isArray(state.recent) ? state.recent : [];
    return state;
  };
  const persist = () => { try { setSetting('alertState', JSON.stringify(state)); } catch (e) { log.warn('alerts', 'save_failed', { err: e }); } };
  const sentLastHour = () => load().recent.filter((a) => a.delivered && a.at > now() - 3600000).length;

  // raise(key, { severity: 'warning'|'critical', title, detail }). Returns 'sent', 'cooldown', 'capped' or 'off'.
  function raise(key, { severity = 'warning', title, detail = '' }) {
    const c = config();
    const st = load();
    const k = st.keys[key] || { lastSent: 0, suppressed: 0 };
    st.keys[key] = k;
    k.active = true;
    k.lastSeen = now();
    if (!c.enabled) return 'off';
    if (now() - k.lastSent < c.cooldownMin * 60000) { k.suppressed++; return 'cooldown'; }
    if (sentLastHour() >= MAX_PER_HOUR) { k.suppressed++; return 'capped'; }
    const held = k.suppressed;
    const alert = { key, severity, title: log.scrub(title).slice(0, 140), detail: log.scrub(detail).slice(0, 600), at: now(), held, delivered: true };
    k.lastSent = alert.at; k.suppressed = 0;
    st.recent.unshift(alert);
    st.recent = st.recent.slice(0, 30);
    persist();
    log.warn('alerts', 'raised', { alert: key, severity, msg: alert.title, outcome: 'sent' });
    try { emitAdmins('admin:alert', { key, severity, title: alert.title, detail: alert.detail, at: alert.at, held }); } catch { /* dashboard closed */ }
    if (c.email) {
      const owner = ownerRow();
      const text = `${alert.title}\n\n${alert.detail}${held ? `\n\n(${held} more like this were held back since the last email.)` : ''}\n\nOpen Admin → Health for details. You get at most one email like this every ${c.cooldownMin} minutes; turn them off in Admin → Health.`;
      try { notify(owner, `${severity === 'critical' ? 'needs attention now' : 'needs a look'}: ${alert.title}`, text, { footer: '' }); } catch (e) { log.warn('alerts', 'email_failed', { err: e }); }
    }
    return 'sent';
  }
  // The condition is over: the next time it happens counts as new (once the cooldown has passed).
  function clear(key) { const k = load().keys[key]; if (k && k.active) { k.active = false; persist(); } }

  // ---------------------------------------------------------------- sources
  const errors = windowCounter(WINDOW_MS);
  function countError(line) {
    const n = errors.add(line && line.errorCategory);
    if (n >= thresholds.errors) raise('app_errors', { severity: 'warning', title: 'The server keeps running into errors', detail: `${n} unexpected errors in the last 10 minutes. Kinds: ${Object.entries(errors.byKind()).map(([kd, x]) => `${kd || 'error'} ×${x}`).join(', ')}. The server log has the details (search for "level":"error").` });
  }
  const security = windowCounter(WINDOW_MS);
  function countSecurity(type) {
    if (!SECURITY_TYPES.has(type)) return;
    const n = security.add(type);
    if (n >= thresholds.authFails) raise('auth_abuse', { severity: 'warning', title: 'Lots of failed sign-ins right now', detail: `${n} failed sign-ins, robot checks or blocked connections in the last 10 minutes (${Object.entries(security.byKind()).map(([kd, x]) => `${kd} ×${x}`).join(', ')}). Admin → Security shows where they come from.` });
  }
  function jobFailed(rec) {
    if (rec.failures >= thresholds.jobFailures) raise(`job:${rec.name}`, { severity: 'warning', title: `Background job "${rec.name}" keeps failing`, detail: `It failed ${rec.failures} times in a row. Last error (${rec.lastErrorCategory}): ${rec.lastError}` });
  }
  const jobRecovered = (name) => clear(`job:${name}`);

  return {
    raise, clear, config, setConfig, countError, countSecurity, jobFailed, jobRecovered, thresholds,
    recent: () => load().recent.map(({ delivered, ...a }) => a), // eslint-disable-line no-unused-vars
    stats: () => ({ errors10m: errors.count(), authFails10m: security.count(), authByKind: security.byKind() }),
  };
};
module.exports.windowCounter = windowCounter;
module.exports.SECURITY_TYPES = SECURITY_TYPES;
