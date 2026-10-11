// Repeating events: when the next time is. The maths runs on the wall clock of the time zone the event was
// planned in, so a weekly 8 pm game night stays at 8 pm when the clocks change, and "every month on the 31st"
// means the 31st there (or the month's last day when it's shorter). Pure functions, no database.
const KINDS = ['weekly', 'biweekly', 'monthly'];
const DAY = 86400000;
// An event without an end counts as over this long after it starts (the lists use the same rule).
const DEFAULT_LEN = 3 * 3600000;

const fmts = new Map(); // time zone -> Intl.DateTimeFormat
function fmtFor(tz) {
  let f = fmts.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch {
      // A zone this build doesn't know (stored by a newer one, say): fall back to UTC rather than fail.
      return fmtFor('UTC');
    }
    fmts.set(tz, f);
  }
  return f;
}
// The canonical name of an IANA time zone, or null if it isn't one.
function zone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}
// What a clock in tz shows at the moment ms.
function wall(ms, tz) {
  const o = {};
  for (const p of fmtFor(tz).formatToParts(ms)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}
// How far tz's clock is ahead of UTC at ms.
function offset(ms, tz) {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}
// The moment a clock in tz shows this time. A time the clocks skip (spring forward) comes out that much later;
// a time that happens twice (fall back) is the first one.
function fromWall(y, mo, d, h, mi, tz) {
  const t = Date.UTC(y, mo - 1, d, h, mi);
  const before = offset(t - DAY, tz);
  const after = offset(t + DAY, tz);
  const hits = [t - before, t - after].filter((x) => x + offset(x, tz) === t);
  return hits.length ? Math.min(...hits) : t - before;
}
const daysIn = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// The start of the time after the one at startMs. rule: { every, tz, anchor } where anchor is a start the rule
// was set from: it gives the time of day and, for monthly, the day of the month.
function nextStart(startMs, { every, tz, anchor }) {
  const cur = wall(startMs, tz);
  const a = wall(anchor ?? startMs, tz);
  let { y, mo, d } = cur;
  if (every === 'monthly') {
    mo += 1;
    if (mo > 12) { mo = 1; y += 1; }
    d = Math.min(a.d, daysIn(y, mo));
  } else {
    const x = new Date(Date.UTC(y, mo - 1, d + (every === 'biweekly' ? 14 : 7)));
    y = x.getUTCFullYear(); mo = x.getUTCMonth() + 1; d = x.getUTCDate();
  }
  return fromWall(y, mo, d, a.h, a.mi, tz);
}

// Moves a repeating event on to its first time that hasn't ended by `t` (one step normally; more if the server
// was off for a while). ev: { startsAt, endsAt, every, tz, anchor, until, left } where left counts the times
// still to come including the current one (null: no limit). Returns { startsAt, endsAt, left }, or null when the
// series is over.
function advance(ev, t) {
  if (!KINDS.includes(ev.every)) return null;
  const tz = ev.tz || 'UTC';
  const len = ev.endsAt != null ? ev.endsAt - ev.startsAt : null;
  let s = ev.startsAt;
  let left = ev.left ?? null;
  for (let i = 0; i < 5000; i++) {
    if (left != null) { left -= 1; if (left < 1) return null; }
    const next = nextStart(s, { every: ev.every, tz, anchor: ev.anchor });
    if (!(next > s)) return null; // never loop on a broken zone
    s = next;
    if (ev.until != null && s > ev.until) return null;
    if (s + (len ?? DEFAULT_LEN) > t) return { startsAt: s, endsAt: len != null ? s + len : null, left };
  }
  return null;
}

module.exports = { KINDS, DEFAULT_LEN, zone, wall, fromWall, daysIn, nextStart, advance };
