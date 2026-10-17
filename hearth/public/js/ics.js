// Calendar files (.ics) for server events. No DOM here, so the tests can load it as is.
const pad = (n) => String(n).padStart(2, '0');
const utc = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r\n|\r|\n/g, '\\n');
const fmts = new Map();
function partsIn(t, tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmts.set(tz, f);
  }
  const p = {};
  f.formatToParts(t).forEach((x) => { if (x.type !== 'literal') p[x.type] = Number(x.value); });
  return p;
}
// Minutes tz's clock is ahead of UTC at t.
function offsetMin(t, tz) {
  const p = partsIn(t, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000) / 60000);
}
const wallStamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`; };
const localStamp = (t, tz) => wallStamp(Math.floor(t / 1000) * 1000 + offsetMin(t, tz) * 60000);
const fmtOffset = (m) => `${m < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(m) / 60))}${pad(Math.abs(m) % 60)}`;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const DAY = 86400000;
const daysIn = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
// Every time tz's clocks change after `start` up to `end`: { at (the first minute on the new offset), from, to }.
function changesBetween(tz, start, end) {
  const out = [];
  let t = start;
  let o = offsetMin(t, tz);
  while (t < end) {
    const t2 = Math.min(t + DAY, end);
    const o2 = offsetMin(t2, tz);
    if (o2 !== o) {
      // Narrow it down to the minute the clocks change.
      let lo = t; let hi = t2;
      while (hi - lo > 60000) { const mid = lo + Math.floor((hi - lo) / 120000) * 60000; if (offsetMin(mid, tz) === o) lo = mid; else hi = mid; }
      out.push({ at: hi, from: o, to: o2, wall: hi + o * 60000 }); // wall: the clock just before it changes
    }
    t = t2; o = o2;
  }
  return out;
}
// A change as a yearly rule on a weekday of its month ("second Sunday of March", "last Sunday of October").
function yearlyRule(c) {
  const d = new Date(c.wall);
  const y = d.getUTCFullYear(); const mo = d.getUTCMonth() + 1; const day = d.getUTCDate();
  return { ...c, mo, wd: d.getUTCDay(), n: day + 7 > daysIn(y, mo) ? -1 : Math.ceil(day / 7), time: c.wall - Date.UTC(y, mo - 1, day) };
}
// The moment a yearly rule changes the clocks in year y.
function ruleIn(r, y) {
  let day;
  if (r.n > 0) day = 1 + ((r.wd - new Date(Date.UTC(y, r.mo - 1, 1)).getUTCDay() + 7) % 7) + (r.n - 1) * 7;
  else { const dim = daysIn(y, r.mo); day = dim - ((new Date(Date.UTC(y, r.mo - 1, dim)).getUTCDay() - r.wd + 7) % 7); }
  return Date.UTC(y, r.mo - 1, day) + r.time - r.from * 60000;
}
const SPAN = 12; // years of clock changes the zone block describes: the year before the event and ten after it

// The VTIMEZONE block calendar apps need to read times written as TZID=<zone>. Most zones change their clocks
// on the same weekday of the same month every year, so the block is the year before the event's changes, each
// repeating yearly. That's only used when it matches every real change in the years it covers (it doesn't for
// Israel's "Friday before the last Sunday of March", or Morocco's Ramadan changes); otherwise the block lists
// the real changes one by one. Most calendar apps go by the zone's name anyway; this is for those that don't.
export function vtimezone(tz, aroundMs) {
  const year = new Date(aroundMs).getUTCFullYear() - 1;
  const eventYearStart = Date.UTC(year + 1, 0, 1);
  const all = changesBetween(tz, Date.UTC(year, 0, 1), Date.UTC(year + SPAN, 0, 1));
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  const part = (kind, wall, from, to, extra = []) => lines.push(`BEGIN:${kind}`, `DTSTART:${wallStamp(wall)}`, `TZOFFSETFROM:${fmtOffset(from)}`, `TZOFFSETTO:${fmtOffset(to)}`, ...extra, `END:${kind}`);
  const kindOf = (c) => (c.to > c.from ? 'DAYLIGHT' : 'STANDARD');
  if (!all.length) {
    const off = offsetMin(aroundMs, tz);
    part('STANDARD', 0, off, off);
  } else {
    const rules = all.filter((c) => c.at <= eventYearStart).map(yearlyRule);
    const later = all.filter((c) => c.at > eventYearStart);
    const predicted = [];
    for (let y = year + 1; y < year + SPAN; y++) rules.forEach((r) => predicted.push({ at: ruleIn(r, y), from: r.from, to: r.to }));
    const inSpan = predicted.filter((c) => c.at > eventYearStart && c.at <= Date.UTC(year + SPAN, 0, 1)).sort((a, b) => a.at - b.at);
    const fits = rules.length && inSpan.length === later.length && inSpan.every((c, i) => c.at === later[i].at && c.from === later[i].from && c.to === later[i].to);
    if (fits) {
      for (const r of rules) part(kindOf(r), r.wall, r.from, r.to, [`RRULE:FREQ=YEARLY;BYMONTH=${r.mo};BYDAY=${r.n}${WEEKDAYS[r.wd]}`]);
    } else {
      // The offset before the first change, then each kind of change with the dates it happens on.
      part(kindOf(all[0]) === 'DAYLIGHT' ? 'STANDARD' : 'DAYLIGHT', 0, all[0].from, all[0].from);
      const groups = new Map();
      for (const c of all) { const k = `${c.from} ${c.to}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
      for (const [, cs] of groups) part(kindOf(cs[0]), cs[0].wall, cs[0].from, cs[0].to, cs.slice(1).map((c) => `RDATE:${wallStamp(c.wall)}`));
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// The RRULE for a repeating event, starting at its next time. A monthly event on the 29th–31st falls on the
// month's last day when it's shorter: the latest of those days the month has (BYSETPOS=-1).
export function rruleFor(e) {
  if (!e.repeat) return null;
  const parts = [e.repeat === 'monthly' ? 'FREQ=MONTHLY' : 'FREQ=WEEKLY'];
  if (e.repeat === 'biweekly') parts.push('INTERVAL=2');
  if (e.repeat === 'monthly') {
    const day = Math.min(31, Math.max(1, Math.round(e.repeatDay) || new Date(e.startsAt).getDate()));
    parts.push(day <= 28 ? `BYMONTHDAY=${day}` : `BYMONTHDAY=${Array.from({ length: day - 27 }, (_, i) => 28 + i).join(',')};BYSETPOS=-1`);
  }
  if (e.repeatCount) parts.push(`COUNT=${Math.round(e.repeatCount)}`);
  else if (e.repeatUntil) parts.push(`UNTIL=${utc(e.repeatUntil)}`);
  return `RRULE:${parts.join(';')}`;
}

// The whole file. A repeating event's times are written on its own time zone's clock, so calendar apps keep it
// at the same local time when the clocks change (a UTC start would drift by an hour).
export function icsText(e, serverName, stamp = Date.now()) {
  let tz = e.repeat && e.timeZone && e.timeZone !== 'UTC' && /^[\w+\-/]+$/.test(e.timeZone) ? e.timeZone : null;
  // A zone this browser doesn't know (it's older than the server's list): plain UTC times instead.
  try { if (tz) partsIn(e.startsAt, tz); } catch { tz = null; }
  const at = (name, t) => (tz ? `${name};TZID=${tz}:${localStamp(t, tz)}` : `${name}:${utc(t)}`);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hearth//Events//EN', ...(tz ? vtimezone(tz, e.startsAt) : []),
    'BEGIN:VEVENT', `UID:${e.id}@hearth`, `DTSTAMP:${utc(stamp)}`, at('DTSTART', e.startsAt), at('DTEND', e.endsAt || e.startsAt + 3600000), rruleFor(e),
    `SUMMARY:${esc(e.title)}`, `DESCRIPTION:${esc(e.description)}`, `LOCATION:${esc(e.location || serverName)}`, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
}
