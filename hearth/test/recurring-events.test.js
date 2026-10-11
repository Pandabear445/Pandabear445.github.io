// Repeating events (weekly game night, monthly meetup): the date maths on the event's own clock, the move to the
// next time once one ends (answers cleared, reminder armed again), editing "this and every later time", the
// calendar file, and who may do what.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServer, hex } = require('./helpers');
const R = require('../server/recurrence');

const P = { VIEW: 1, SEND: 2, MANAGE_CHANNELS: 1 << 11 };
const DAY = 86400000;
const NY = 'America/New_York';
const at = (y, mo, d, h, mi, tz = NY) => R.fromWall(y, mo, d, h, mi, tz);
const clock = (t, tz = NY) => { const w = R.wall(t, tz); return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`; };

// ------------------------------------------------------------------ the date maths (no server)
test('weekly and every-2-weeks times keep their local time through daylight-saving changes', () => {
  const first = at(2026, 10, 23, 20, 0); // a Friday, 8 pm, before New York's clocks go back on 1 November
  let t = first;
  const seen = [];
  for (let i = 0; i < 3; i++) { t = R.nextStart(t, { every: 'weekly', tz: NY, anchor: first }); seen.push(clock(t)); }
  assert.deepEqual(seen, ['2026-10-30 20:00', '2026-11-06 20:00', '2026-11-13 20:00']);
  // The same local time is a different UTC hour once the clocks change.
  assert.equal(new Date(at(2026, 10, 30, 20, 0)).getUTCHours(), 0);
  assert.equal(new Date(at(2026, 11, 6, 20, 0)).getUTCHours(), 1);
  // And into summer time.
  const march = at(2026, 3, 1, 19, 30);
  assert.equal(clock(R.nextStart(march, { every: 'biweekly', tz: NY, anchor: march })), '2026-03-15 19:30');
  // London and Sydney change on other dates, in other directions.
  const lon = at(2026, 3, 22, 18, 0, 'Europe/London');
  assert.equal(clock(R.nextStart(lon, { every: 'weekly', tz: 'Europe/London', anchor: lon }), 'Europe/London'), '2026-03-29 18:00');
  const syd = at(2026, 4, 1, 9, 0, 'Australia/Sydney');
  assert.equal(clock(R.nextStart(syd, { every: 'weekly', tz: 'Australia/Sydney', anchor: syd }), 'Australia/Sydney'), '2026-04-08 09:00');
});

test('monthly keeps the day of the month, on the last day when a month is shorter, and goes back to it after', () => {
  const first = at(2026, 1, 31, 19, 0, 'Europe/London');
  let t = first;
  const seen = [];
  for (let i = 0; i < 5; i++) { t = R.nextStart(t, { every: 'monthly', tz: 'Europe/London', anchor: first }); seen.push(clock(t, 'Europe/London')); }
  assert.deepEqual(seen, ['2026-02-28 19:00', '2026-03-31 19:00', '2026-04-30 19:00', '2026-05-31 19:00', '2026-06-30 19:00']);
  // A leap year has a 29th of February, and December rolls into January.
  const leap = at(2028, 1, 30, 12, 0, 'UTC');
  assert.equal(clock(R.nextStart(leap, { every: 'monthly', tz: 'UTC', anchor: leap }), 'UTC'), '2028-02-29 12:00');
  const dec = at(2026, 12, 15, 12, 0, 'UTC');
  assert.equal(clock(R.nextStart(dec, { every: 'monthly', tz: 'UTC', anchor: dec }), 'UTC'), '2027-01-15 12:00');
  // The day of the month is the one on the event's clock, not in UTC: 8 pm on the 31st in Los Angeles is the
  // 1st in UTC.
  const la = at(2026, 1, 31, 20, 0, 'America/Los_Angeles');
  assert.equal(new Date(la).getUTCDate(), 1);
  assert.equal(clock(R.nextStart(la, { every: 'monthly', tz: 'America/Los_Angeles', anchor: la }), 'America/Los_Angeles'), '2026-02-28 20:00');
});

test('a time the clocks skip comes out later, a time that happens twice is the first one', () => {
  assert.equal(new Date(at(2026, 3, 8, 2, 30)).toISOString(), '2026-03-08T07:30:00.000Z', '2:30 doesn’t exist that night: 3:30 summer time');
  assert.equal(new Date(at(2026, 11, 1, 1, 30)).toISOString(), '2026-11-01T05:30:00.000Z', '1:30 happens twice: the first (summer time) one');
  // A weekly event set at 2:30 stays at 2:30 after the night it couldn't happen.
  const anchor = at(2026, 3, 1, 2, 30);
  const skipped = R.nextStart(anchor, { every: 'weekly', tz: NY, anchor });
  assert.equal(clock(skipped), '2026-03-08 03:30');
  assert.equal(clock(R.nextStart(skipped, { every: 'weekly', tz: NY, anchor })), '2026-03-15 02:30');
});

test('a week the clocks go forward is shorter than 7 days, so a repeating event can last at most 6', () => {
  const sun = at(2027, 3, 7, 20, 0); // a Sunday, 8 pm, the week New York's clocks go forward
  const next = R.nextStart(sun, { every: 'weekly', tz: NY, anchor: sun });
  assert.equal(clock(next), '2027-03-14 20:00');
  assert.equal(next - sun, 7 * DAY - 3600000, 'that week is 167 hours');
  // A 7-day event would still be on when the next one starts; the longest allowed ends well before.
  const six = R.advance({ startsAt: sun, endsAt: sun + 6 * DAY, every: 'weekly', tz: NY, anchor: sun, until: null, left: null }, sun + 6 * DAY);
  assert.equal(six.startsAt, next);
  assert.ok(six.startsAt > sun + 6 * DAY);
});

test('advance: one step normally, catches up after downtime, and stops at the count or the last date', () => {
  const s = at(2026, 10, 2, 20, 0);
  const ev = { startsAt: s, endsAt: s + 2 * 3600000, every: 'weekly', tz: NY, anchor: s, until: null, left: null };
  const one = R.advance(ev, s + 2 * 3600000);
  assert.equal(clock(one.startsAt), '2026-10-09 20:00');
  assert.equal(one.endsAt - one.startsAt, 2 * 3600000, 'it keeps its length');
  assert.equal(one.left, null);
  // The server was off for five weeks: the next time is the first one that hasn't ended yet (here, the one
  // going on right now, which started at 8 pm on 6 November, after the clocks went back).
  const later = R.advance(ev, s + 35 * DAY + 3600000);
  assert.equal(clock(later.startsAt), '2026-11-06 20:00');
  assert.equal(clock(R.advance(ev, s + 35 * DAY + 4 * 3600000).startsAt), '2026-11-13 20:00');
  // Counting: 3 times in all (this one and two more).
  assert.equal(R.advance({ ...ev, left: 3 }, s + 3 * 3600000).left, 2);
  assert.equal(R.advance({ ...ev, left: 1 }, s + 3 * 3600000), null, 'the last time leads nowhere');
  assert.equal(R.advance({ ...ev, left: 3 }, s + 30 * DAY), null, 'all three are over');
  // A last date: a time after it doesn't happen.
  assert.equal(clock(R.advance({ ...ev, until: s + 7 * DAY }, s + 3 * 3600000).startsAt), '2026-10-09 20:00');
  assert.equal(R.advance({ ...ev, until: s + 7 * DAY - 1 }, s + 3 * 3600000), null);
  // No end: it counts as over three hours after it starts, as everywhere else, and the next one has no end either.
  const open = R.advance({ ...ev, endsAt: null }, s + 3 * 3600000);
  assert.equal(clock(open.startsAt), '2026-10-09 20:00');
  assert.equal(open.endsAt, null);
  assert.equal(clock(R.advance({ ...ev, endsAt: null }, s + 7 * DAY + 3 * 3600000).startsAt), '2026-10-16 20:00', 'one that ended three hours after starting is skipped');
  assert.equal(R.advance({ ...ev, every: 'daily' }, s + DAY), null, 'an unknown rule doesn’t repeat');
});

test('time zones are checked against the real list', () => {
  assert.equal(R.zone('America/New_York'), NY);
  assert.equal(R.zone('UTC'), 'UTC');
  for (const bad of ['Mars/Olympus_Mons', '../../etc/passwd', '', 'x'.repeat(65), '+05:00', 42, null, { tz: NY }]) assert.equal(R.zone(bad), null, String(bad));
});

// ------------------------------------------------------------------ the calendar file (public/js/ics.js)
test('the .ics file: an RRULE, times on the event’s own clock with its VTIMEZONE, and safe text', async () => {
  const I = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'ics.js')).href);
  const start = at(2026, 10, 30, 20, 0);
  const weekly = { id: 'ev1', title: 'Game night', description: 'bring snacks; chips, dip', location: '', startsAt: start, endsAt: start + 2 * 3600000, repeat: 'weekly', timeZone: NY, repeatCount: 5, repeatUntil: null };
  const lines = I.icsText(weekly, 'HQ', 0).split('\r\n');
  assert.ok(lines.includes('DTSTART;TZID=America/New_York:20261030T200000'), lines.join('\n'));
  assert.ok(lines.includes('DTEND;TZID=America/New_York:20261030T220000'));
  assert.ok(lines.includes('RRULE:FREQ=WEEKLY;COUNT=5'));
  assert.ok(lines.includes('DESCRIPTION:bring snacks\\; chips\\, dip'));
  // The zone itself, so calendar apps that don't know the name still get the clock changes right.
  const tz = lines.slice(lines.indexOf('BEGIN:VTIMEZONE'), lines.indexOf('END:VTIMEZONE') + 1);
  assert.ok(tz.includes('TZID:America/New_York'));
  assert.ok(tz.includes('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'));
  assert.ok(tz.includes('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU'));
  assert.ok(lines.indexOf('END:VTIMEZONE') < lines.indexOf('BEGIN:VEVENT'));
  assert.equal(I.rruleFor({ ...weekly, repeat: 'biweekly', repeatCount: null }), 'RRULE:FREQ=WEEKLY;INTERVAL=2');
  // Monthly on the 31st: the month's last day when it's shorter. The last date is in UTC, as the format wants.
  assert.equal(I.rruleFor({ ...weekly, repeat: 'monthly', repeatDay: 31, repeatCount: null, repeatUntil: Date.UTC(2027, 5, 1, 3, 59, 59) }),
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1;UNTIL=20270601T035959Z');
  assert.equal(I.rruleFor({ ...weekly, repeat: 'monthly', repeatDay: 12, repeatCount: null }), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=12');
  // A one-off event: UTC times, no rule, no zone. A title can't start a line of its own.
  const once = I.icsText({ ...weekly, repeat: null, title: 'Line\r\nRRULE:FREQ=DAILY\rX' }, 'HQ', 0).split('\r\n');
  assert.ok(once.includes('DTSTART:20261031T000000Z'));
  assert.ok(!once.some((l) => l.startsWith('RRULE') || l.startsWith('BEGIN:VTIMEZONE')), once.join('\n'));
  assert.ok(once.includes('SUMMARY:Line\\nRRULE:FREQ=DAILY\\nX'));
  // A repeating event kept in UTC needs no zone block.
  assert.ok(!I.icsText({ ...weekly, timeZone: 'UTC' }, 'HQ', 0).includes('VTIMEZONE'));
  // A zone this device doesn't know: plain UTC times rather than a broken file.
  const unknown = I.icsText({ ...weekly, timeZone: 'Not/A_Zone' }, 'HQ', 0);
  assert.ok(unknown.includes('DTSTART:20261031T000000Z') && !unknown.includes('TZID'), unknown);
  // A zone without daylight saving gets a one-line zone.
  assert.match(I.icsText({ ...weekly, timeZone: 'Asia/Tokyo' }, 'HQ', 0), /BEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:\+0900\r\nTZOFFSETTO:\+0900/);
});

// Reads a VTIMEZONE block back (yearly BYMONTH/BYDAY rules and RDATEs, as ics.js writes them): the moments the
// clocks change up to the end of `lastYear`, each with the offset in minutes after it.
function zoneChanges(lines, lastYear) {
  const off = (v) => (v[0] === '-' ? -1 : 1) * (Number(v.slice(1, 3)) * 60 + Number(v.slice(3, 5)));
  const stamp = (v) => Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15));
  const out = [];
  let c = null;
  for (const l of lines) {
    const [k, v] = [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)];
    if (l === 'BEGIN:STANDARD' || l === 'BEGIN:DAYLIGHT') c = { walls: [] };
    else if (!c) continue;
    else if (k === 'DTSTART' || k === 'RDATE') c.walls.push(stamp(v));
    else if (k === 'TZOFFSETFROM') c.from = off(v);
    else if (k === 'TZOFFSETTO') c.to = off(v);
    else if (k === 'RRULE') c.rule = Object.fromEntries(v.split(';').map((x) => x.split('=')));
    else if (l === 'END:STANDARD' || l === 'END:DAYLIGHT') {
      if (c.rule) {
        const s = new Date(c.walls[0]);
        const [, n, wd] = /^(-?\d)(\w\w)$/.exec(c.rule.BYDAY);
        const want = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(wd); const mo = Number(c.rule.BYMONTH) - 1;
        for (let y = s.getUTCFullYear() + 1; y <= lastYear; y++) {
          const days = [];
          for (let d = 1; d <= new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === want) days.push(d);
          c.walls.push(Date.UTC(y, mo, days.at(Number(n) > 0 ? Number(n) - 1 : Number(n)), s.getUTCHours(), s.getUTCMinutes()));
        }
      }
      c.walls.forEach((w) => out.push({ at: w - c.from * 60000, to: c.to }));
      c = null;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

test('the .ics zone block matches the real clock changes, also in zones that don’t change on a weekday of the month', async () => {
  const I = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'ics.js')).href);
  const real = (t, tz) => { const w = R.wall(t, tz); return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - t) / 60000); };
  const start = Date.UTC(2027, 5, 15, 18);
  // Israel moves its clocks on the Friday before the last Sunday of March, Gaza and Cairo on other days, and
  // Morocco around Ramadan; the others follow a weekday of the month.
  for (const tz of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Australia/Lord_Howe', 'America/Santiago', 'Asia/Jerusalem', 'Asia/Gaza', 'Africa/Cairo', 'Africa/Casablanca', 'Asia/Tokyo']) {
    const lines = I.icsText({ id: 'z', title: 'Z', startsAt: start, endsAt: start + 3600000, repeat: 'weekly', timeZone: tz }, 'HQ', 0).split('\r\n');
    const changes = zoneChanges(lines.slice(lines.indexOf('BEGIN:VTIMEZONE'), lines.indexOf('END:VTIMEZONE') + 1), 2029);
    let wrong = 0;
    for (let t = Date.UTC(2027, 0, 1); t < Date.UTC(2029, 0, 1); t += 3600000) {
      const now = changes.filter((c) => c.at <= t).at(-1);
      if (!now || now.to !== real(t, tz)) wrong++;
    }
    assert.equal(wrong, 0, `${tz}: ${wrong} hours on the wrong offset`);
  }
  // Israel's changes are listed one by one (summer time starts 24 March in 2028, not on the last Friday, the 31st).
  const jer = I.vtimezone('Asia/Jerusalem', start);
  assert.ok(jer.includes('RDATE:20280324T020000'), jer.join('\n'));
  assert.ok(!jer.some((l) => l.startsWith('RRULE')));
  assert.ok(I.vtimezone(NY, start).includes('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'), 'New York still gets yearly rules');
});

// ------------------------------------------------------------------ the server
let srv; let boss; let server; let general; let code;
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const user = async (name) => {
  const u = await srv.register(`${name}${hex(3)}`);
  assert.equal((await as(u, 'POST', `/invites/${code}/join`)).status, 200);
  return u;
};
const row = (id) => srv.sql('SELECT * FROM server_events WHERE id = ?', id)[0];
const rsvps = (id) => Object.fromEntries(srv.sql('SELECT user_id, status FROM event_rsvps WHERE event_id = ?', id).map((r) => [r.user_id, r.status]));
const inAWeek = () => Date.now() + 7 * DAY;
const listed = async (u, id) => (await as(u, 'GET', `/servers/${server.id}/events`)).json.find((e) => e.id === id);
// Pretends a time of the series has just ended: moves it (and its rule) into the past.
const endNow = (id, startsAt, lenMs = 2 * 3600000) => srv.sql('UPDATE server_events SET starts_at = ?, ends_at = ?, repeat_anchor = ?, reminded = 1 WHERE id = ?', startsAt, startsAt + lenMs, startsAt, id);

before(async () => {
  srv = await startServer();
  boss = srv.owner;
  server = (await as(boss, 'POST', '/servers', { name: 'Club' })).json;
  general = server.channels.find((c) => c.type === 'text');
  code = (await as(boss, 'POST', `/servers/${server.id}/invites`, { expiresHours: 0 })).json.code;
});
after(async () => { await srv.stop(); });

test('creating a weekly event: the rule, its time zone and how many times are left come back to everyone', async () => {
  const amy = await user('amy');
  const r = await as(amy, 'POST', `/servers/${server.id}/events`, { title: 'Board games', startsAt: inAWeek(), endsAt: inAWeek() + 3 * 3600000, repeat: 'weekly', timeZone: NY, repeatCount: 6 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.repeat, 'weekly');
  assert.equal(r.json.timeZone, NY);
  assert.equal(r.json.repeatCount, 6);
  assert.equal(r.json.repeatUntil, null);
  assert.equal(r.json.repeatDay, undefined, 'only monthly events say which day');
  const bo = await user('bo');
  const seen = await listed(bo, r.json.id);
  assert.equal(seen.repeat, 'weekly');
  assert.equal(seen.timeZone, NY);
  assert.ok((await as(bo, 'GET', '/events')).json.some((e) => e.id === r.json.id && e.repeat === 'weekly'), 'Home’s Coming up says it repeats');
  // A one-off event says so too.
  const once = await as(amy, 'POST', `/servers/${server.id}/events`, { title: 'Once', startsAt: inAWeek() });
  assert.equal(once.json.repeat, null);
  assert.equal(once.json.timeZone, undefined);
  // Monthly says which day of the month it keeps; with no time zone given it is kept in UTC.
  const m = await as(amy, 'POST', `/servers/${server.id}/events`, { title: 'Meetup', startsAt: inAWeek(), repeat: 'monthly' });
  assert.equal(m.json.timeZone, 'UTC');
  assert.equal(m.json.repeatDay, new Date(m.json.startsAt).getUTCDate());
});

test('when a time ends, the event moves to the next one: same local time, reminder armed, everyone answers again', async () => {
  const host = await user('host'); const cat = await user('cat'); const dan = await user('dan');
  const created = (await as(host, 'POST', `/servers/${server.id}/events`, { title: 'Game night', startsAt: inAWeek(), endsAt: inAWeek() + 2 * 3600000, repeat: 'weekly', timeZone: NY, repeatCount: 4 })).json;
  assert.equal((await as(cat, 'POST', `/events/${created.id}/rsvp`, { status: 'going' })).status, 200);
  assert.equal((await as(dan, 'POST', `/events/${created.id}/rsvp`, { status: 'maybe' })).status, 200);
  // Last Friday's (local) 8 pm game night just ended.
  const w = R.wall(Date.now() - 3 * 3600000, NY);
  let start = R.fromWall(w.y, w.mo, w.d, 20, 0, NY);
  while (start + 2 * 3600000 > Date.now()) start -= DAY;
  endNow(created.id, start);
  const sock = await srv.socket(cat.token);
  const updates = [];
  sock.on('events:update', (p) => updates.push(p));
  try {
    const next = await listed(cat, created.id);
    assert.ok(next, 'still listed');
    assert.equal(clock(next.startsAt), clock(R.nextStart(start, { every: 'weekly', tz: NY, anchor: start })));
    assert.equal(R.wall(next.startsAt, NY).h, 20, 'still 8 pm in New York');
    assert.ok(next.startsAt > Date.now() - 2 * 3600000 && next.startsAt <= start + 7 * DAY + 3600000);
    assert.equal(next.endsAt - next.startsAt, 2 * 3600000);
    assert.equal(next.repeatCount, 3, 'one of the four is done');
    assert.equal(row(created.id).reminded, 0, 'the reminder is armed again');
    // Answers are cleared; the person who made it is down as going, as when they made it.
    assert.deepEqual(rsvps(created.id), { [host.id]: 'going' });
    assert.deepEqual(next.going, [host.id]);
    assert.equal(next.mine, null);
    for (let i = 0; i < 50 && !updates.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(updates.some((u) => u.serverId === server.id), 'open apps are told to refresh');
    // Listing again changes nothing more.
    assert.equal((await listed(cat, created.id)).startsAt, next.startsAt);
  } finally { sock.close(); }
});

test('the series ends after its count or its last date, and then it’s an ordinary past event', async () => {
  const host = await user('hosta');
  const byCount = (await as(host, 'POST', `/servers/${server.id}/events`, { title: 'Twice', startsAt: inAWeek(), repeat: 'weekly', timeZone: NY, repeatCount: 1 })).json;
  endNow(byCount.id, Date.now() - 5 * 3600000);
  assert.equal(await listed(host, byCount.id), undefined, 'no next time after the last one');
  assert.equal(row(byCount.id).repeat, null);
  // A last date (a day, counted until midnight on the event's clock).
  const last = R.wall(Date.now() + 3 * DAY, NY);
  const day = `${last.y}-${String(last.mo).padStart(2, '0')}-${String(last.d).padStart(2, '0')}`;
  const byDate = await as(host, 'POST', `/servers/${server.id}/events`, { title: 'Until', startsAt: Date.now() + DAY, repeat: 'weekly', timeZone: NY, repeatUntil: day });
  assert.equal(byDate.status, 200, byDate.text);
  assert.equal(byDate.json.repeatUntil, R.fromWall(last.y, last.mo, last.d + 1, 0, 0, NY) - 1, 'the end of that day in New York');
  endNow(byDate.json.id, Date.now() - 6 * DAY - 4 * 3600000); // the next would be tomorrow: before the last date
  assert.ok(await listed(host, byDate.json.id));
  endNow(byDate.json.id, Date.now() - 4 * 3600000); // the next would be a week away: after it
  assert.equal(await listed(host, byDate.json.id), undefined);
  // Someone who made it and has since left isn't put back down as going.
  const gone = await user('gone');
  const left = (await as(gone, 'POST', `/servers/${server.id}/events`, { title: 'Orphan', startsAt: inAWeek(), repeat: 'biweekly', timeZone: NY })).json;
  assert.equal((await as(gone, 'POST', `/servers/${server.id}/leave`)).status, 200);
  endNow(left.id, Date.now() - 5 * 3600000);
  const next = await listed(boss, left.id);
  assert.ok(next);
  assert.deepEqual(next.going, []);
  assert.deepEqual(rsvps(left.id), {});
  assert.ok(next.startsAt - (Date.now() - 5 * 3600000) > 13 * DAY, 'every 2 weeks');
});

test('a monthly event on the 31st comes back on the last day of a shorter month, then the 31st again', async () => {
  const host = await user('hostm');
  const ev = (await as(host, 'POST', `/servers/${server.id}/events`, { title: 'Month end', startsAt: inAWeek(), repeat: 'monthly', timeZone: 'Europe/London' })).json;
  // Its rule was set on 31 January last year: let the server catch up month by month to now.
  const y = new Date().getUTCFullYear() - 1;
  const jan31 = R.fromWall(y, 1, 31, 19, 0, 'Europe/London');
  endNow(ev.id, jan31);
  const next = await listed(host, ev.id);
  const w = R.wall(next.startsAt, 'Europe/London');
  const dim = new Date(Date.UTC(w.y, w.mo, 0)).getUTCDate();
  assert.equal(w.d, Math.min(31, dim), `${clock(next.startsAt, 'Europe/London')} is the 31st or the month’s last day`);
  assert.equal(w.h, 19);
  assert.equal(next.repeatDay, 31, 'it still says the 31st');
});

test('editing changes this time and every later one: time zone and day stay, a new start resets them, stop repeating any time', async () => {
  const host = await user('hoste');
  const ev = (await as(host, 'POST', `/servers/${server.id}/events`, { title: 'Weekly', startsAt: inAWeek(), endsAt: inAWeek() + 3600000, repeat: 'weekly', timeZone: NY, repeatCount: 10 })).json;
  // An admin somewhere else edits the title: the series stays on New York's clock and keeps its count.
  let r = await as(boss, 'PATCH', `/events/${ev.id}`, { title: 'Weekly (renamed)', timeZone: 'Asia/Tokyo' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.timeZone, NY);
  assert.equal(r.json.repeatCount, 10);
  assert.equal(row(ev.id).repeat_anchor, ev.startsAt);
  // How it ends is replaced as a pair: a last date clears the count.
  r = await as(host, 'PATCH', `/events/${ev.id}`, { repeatUntil: ev.startsAt + 30 * DAY });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.repeatCount, null);
  assert.equal(r.json.repeatUntil, ev.startsAt + 30 * DAY);
  // A new start time is the new rule's day and time.
  r = await as(host, 'PATCH', `/events/${ev.id}`, { startsAt: ev.startsAt + 2 * 3600000, endsAt: ev.startsAt + 3 * 3600000 });
  assert.equal(r.status, 200, r.text);
  assert.equal(row(ev.id).repeat_anchor, ev.startsAt + 2 * 3600000);
  // A monthly event that's on the 30th because of a shorter month keeps going back to the 31st after an edit
  // that doesn't touch its time.
  const m = (await as(host, 'POST', `/servers/${server.id}/events`, { title: 'Monthly', startsAt: inAWeek(), repeat: 'monthly', timeZone: NY })).json;
  const anchor = R.fromWall(2025, 1, 31, 18, 0, NY);
  srv.sql('UPDATE server_events SET repeat_anchor = ? WHERE id = ?', anchor, m.id);
  assert.equal((await as(host, 'PATCH', `/events/${m.id}`, { title: 'Monthly!' })).json.repeatDay, 31);
  assert.equal(row(m.id).repeat_anchor, anchor);
  // Stopping it during one of its times (it started two hours ago) works: its time isn't being moved.
  endNow(ev.id, Date.now() - 2 * 3600000, 4 * 3600000);
  r = await as(host, 'PATCH', `/events/${ev.id}`, { repeat: null });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.repeat, null);
  assert.deepEqual(srv.sql('SELECT repeat, repeat_until, repeat_left, repeat_tz, repeat_anchor FROM server_events WHERE id = ?', ev.id)[0],
    { repeat: null, repeat_until: null, repeat_left: null, repeat_tz: null, repeat_anchor: null });
  // Moving it into the past still isn't allowed.
  assert.equal((await as(host, 'PATCH', `/events/${ev.id}`, { startsAt: Date.now() - 3 * 3600000 })).status, 400);
  // Turning it back on takes the editor's time zone (it has none of its own any more).
  r = await as(host, 'PATCH', `/events/${ev.id}`, { repeat: 'biweekly', timeZone: 'Europe/Paris' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.timeZone, 'Europe/Paris');
  // Deleting removes the whole series (this time and every later one).
  assert.equal((await as(host, 'DELETE', `/events/${ev.id}`)).status, 200);
  assert.equal(row(ev.id), undefined);
});

test('a dialog left open past the end of a time: other edits apply to the next time, a stale time or rule is refused', async () => {
  const host = await user('stale'); const cat = await user('cate');
  const ev = (await as(host, 'POST', `/servers/${server.id}/events`, { title: 'Game night', startsAt: inAWeek(), endsAt: inAWeek() + 2 * 3600000, repeat: 'weekly', timeZone: NY, repeatCount: 6 })).json;
  // The editor was opened during this time, which ended five minutes ago.
  const start = Date.now() - 2 * 3600000 - 5 * 60000;
  endNow(ev.id, start);
  const next = R.nextStart(start, { every: 'weekly', tz: NY, anchor: start });
  // The time and the rule weren't touched, so the app leaves them out: the edit is for next week's.
  let r = await as(host, 'PATCH', `/events/${ev.id}`, { title: 'Game night', description: 'next week: Catan', location: '' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.startsAt, next);
  assert.equal(r.json.endsAt, next + 2 * 3600000);
  assert.equal(r.json.description, 'next week: Catan');
  assert.equal(r.json.repeatCount, 5, 'the time that ended still counts');
  assert.equal((await as(cat, 'POST', `/events/${ev.id}/rsvp`, { status: 'going' })).status, 200);
  // A new time, or a new rule, sent with the start the dialog showed is refused: it's not the time it has now.
  for (const body of [{ startsAt: start, endsAt: start + 3 * 3600000 }, { repeat: 'weekly', timeZone: NY, repeatUntil: null, repeatCount: 6 }, { repeat: null }]) {
    r = await as(host, 'PATCH', `/events/${ev.id}`, { title: 'Changed', ...body, from: start });
    assert.equal(r.status, 409, `${JSON.stringify(body)} → ${r.status} ${r.text}`);
    assert.match(r.json.error, /changed since you opened it/);
  }
  assert.deepEqual(srv.sql('SELECT title, starts_at, repeat, repeat_left FROM server_events WHERE id = ?', ev.id)[0], { title: 'Game night', starts_at: next, repeat: 'weekly', repeat_left: 5 });
  // An API client that sends a time that's already over without `from` isn't taken either (within the hour a
  // one-off event may be moved back by): the series would move on at once and clear everyone's answers.
  r = await as(host, 'PATCH', `/events/${ev.id}`, { startsAt: Date.now() - 35 * 60000, endsAt: Date.now() - 5 * 60000 });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /hasn’t ended/);
  // With the start it has now, a new time is fine, and the answers for next week stay.
  r = await as(host, 'PATCH', `/events/${ev.id}`, { startsAt: next + 3600000, endsAt: next + 3 * 3600000, from: next });
  assert.equal(r.status, 200, r.text);
  await listed(host, ev.id);
  assert.deepEqual(rsvps(ev.id), { [host.id]: 'going', [cat.id]: 'going' });
  // Someone who may not edit it learns nothing from `from`.
  assert.equal((await as(cat, 'PATCH', `/events/${ev.id}`, { title: 'mine now', from: 1 })).status, 403);
});

test('bad rules are refused with a reason', async () => {
  const u = await user('val');
  const base = { title: 'X', startsAt: inAWeek(), endsAt: inAWeek() + 3600000, timeZone: NY };
  const next = new Date().getUTCFullYear() + 1;
  const bad = [
    [{ repeat: 'daily' }, /every week, every 2 weeks or every month/],
    [{ repeat: 'weekly', timeZone: 'Mars/Olympus_Mons' }, /time zone/],
    [{ repeat: 'weekly', timeZone: '../../etc/passwd' }, /time zone/],
    [{ repeat: 'weekly', timeZone: 'A'.repeat(200) }, /time zone/],
    [{ repeat: 'weekly', repeatCount: 3, repeatUntil: inAWeek() + 30 * DAY }, /not both/],
    [{ repeat: 'weekly', repeatCount: 0 }, /between 1 and 500/],
    [{ repeat: 'weekly', repeatCount: 501 }, /between 1 and 500/],
    [{ repeat: 'weekly', repeatCount: 2.5 }, /between 1 and 500/],
    [{ repeat: 'weekly', repeatCount: 'lots' }, /between 1 and 500/],
    [{ repeat: 'weekly', repeatUntil: inAWeek() - DAY }, /last date/],
    [{ repeat: 'weekly', repeatUntil: inAWeek() + 6 * 366 * DAY }, /last date/],
    [{ repeat: 'weekly', repeatUntil: 'soon' }, /last date/],
    [{ repeat: 'weekly', endsAt: inAWeek() + 8 * DAY }, /up to 6 days/],
    [{ repeat: 'weekly', endsAt: inAWeek() + 7 * DAY }, /up to 6 days/],
    [{ repeat: 'weekly', repeatUntil: `${next}-02-31` }, /last date doesn’t exist/],
    [{ repeat: 'weekly', repeatUntil: `${next}-04-31` }, /last date doesn’t exist/],
    [{ repeat: 'weekly', repeatUntil: `${next}-00-99` }, /last date doesn’t exist/],
    [{ repeat: 'weekly', repeatUntil: `${next}-13-01` }, /last date doesn’t exist/],
    // A first time that's already over would move on at once.
    [{ repeat: 'weekly', startsAt: Date.now() - 40 * 60000, endsAt: Date.now() - 10 * 60000 }, /hasn’t ended/],
  ];
  for (const [extra, msg] of bad) {
    const r = await as(u, 'POST', `/servers/${server.id}/events`, { ...base, ...extra });
    assert.equal(r.status, 400, `${JSON.stringify(extra).slice(0, 80)} → ${r.status} ${r.text}`);
    assert.match(r.json.error, msg);
  }
  assert.equal(srv.sql('SELECT COUNT(*) n FROM server_events WHERE created_by = ?', u.id)[0].n, 0, 'nothing was saved');
  // Six days is fine, and so is the last day of February (someone else posts these: refused tries count
  // towards the hourly limit too).
  const u2 = await user('val2');
  const six = await as(u2, 'POST', `/servers/${server.id}/events`, { ...base, repeat: 'weekly', endsAt: base.startsAt + 6 * DAY, repeatUntil: `${next}-02-28` });
  assert.equal(six.status, 200, six.text);
  assert.equal(R.wall(six.json.repeatUntil, NY).d, 28);
  srv.sql('DELETE FROM server_events WHERE id = ?', six.json.id);
  // 'none' (or nothing) is an ordinary event, and a one-off may still last longer than a week.
  const once = await as(u2, 'POST', `/servers/${server.id}/events`, { ...base, repeat: 'none', endsAt: inAWeek() + 8 * DAY });
  assert.equal(once.status, 200, once.text);
  assert.equal(once.json.repeat, null);
  // An edit can't sneak in a bad rule either.
  assert.equal((await as(u2, 'PATCH', `/events/${once.json.id}`, { repeat: 'hourly' })).status, 400);
  assert.equal((await as(u2, 'PATCH', `/events/${once.json.id}`, { repeat: 'weekly' })).status, 400, 'too long to repeat weekly');
  assert.equal(row(once.json.id).repeat, null);
});

test('only members post repeating events; only the person who made one or an admin changes it', async () => {
  const owner = await user('own');
  const ev = (await as(owner, 'POST', `/servers/${server.id}/events`, { title: 'Series', startsAt: inAWeek(), repeat: 'weekly', timeZone: NY })).json;
  // Someone outside the server can't see, post, edit, answer or delete.
  const outsider = await srv.register(`out${hex(3)}`);
  assert.ok([403, 404].includes((await as(outsider, 'POST', `/servers/${server.id}/events`, { title: 'Spam', startsAt: inAWeek(), repeat: 'weekly' })).status));
  assert.ok([403, 404].includes((await as(outsider, 'GET', `/servers/${server.id}/events`)).status));
  assert.ok([403, 404].includes((await as(outsider, 'PATCH', `/events/${ev.id}`, { repeat: 'monthly' })).status));
  assert.ok([403, 404].includes((await as(outsider, 'POST', `/events/${ev.id}/rsvp`, { status: 'going' })).status));
  assert.ok([403, 404].includes((await as(outsider, 'DELETE', `/events/${ev.id}`)).status));
  assert.ok(!(await as(outsider, 'GET', '/events')).json.some((e) => e.id === ev.id), 'nor see it on Home');
  // Another member can answer but not change or delete it.
  const other = await user('other');
  assert.equal((await as(other, 'PATCH', `/events/${ev.id}`, { repeat: null })).status, 403);
  assert.equal((await as(other, 'PATCH', `/events/${ev.id}`, { repeatCount: 1 })).status, 403);
  assert.equal((await as(other, 'DELETE', `/events/${ev.id}`)).status, 403);
  assert.equal(row(ev.id).repeat, 'weekly');
  // Manage Channels may (as for any event).
  const role = (await as(boss, 'POST', `/servers/${server.id}/roles`, { name: 'Planner', permissions: P.MANAGE_CHANNELS })).json;
  assert.equal((await as(boss, 'PUT', `/servers/${server.id}/members/${other.id}/roles`, { roleIds: [role.id] })).status, 200);
  assert.equal((await as(other, 'PATCH', `/events/${ev.id}`, { repeat: 'biweekly' })).status, 200);
  assert.equal(row(ev.id).repeat, 'biweekly');
  // Muted everywhere (no Send Messages): no new series and no editing their own.
  const muted = await user('muted');
  const mine = (await as(muted, 'POST', `/servers/${server.id}/events`, { title: 'Mine', startsAt: inAWeek(), repeat: 'weekly', timeZone: NY })).json;
  const everyone = srv.sql('SELECT permissions FROM roles WHERE id = ?', server.id)[0].permissions;
  assert.equal((await as(boss, 'PATCH', `/roles/${server.id}`, { permissions: everyone & ~P.SEND })).status, 200);
  try {
    assert.equal((await as(muted, 'POST', `/servers/${server.id}/events`, { title: 'More', startsAt: inAWeek(), repeat: 'weekly' })).status, 403);
    assert.equal((await as(muted, 'PATCH', `/events/${mine.id}`, { repeat: 'monthly' })).status, 403);
  } finally {
    assert.equal((await as(boss, 'PATCH', `/roles/${server.id}`, { permissions: everyone })).status, 200);
  }
  // A suspended account can't touch it; banned from the server, neither.
  srv.sql('UPDATE users SET suspended_at = ? WHERE id = ?', Date.now(), muted.id);
  assert.ok([401, 403].includes((await as(muted, 'PATCH', `/events/${mine.id}`, { title: 'still mine?' })).status));
  srv.sql('UPDATE users SET suspended_at = NULL WHERE id = ?', muted.id);
  assert.equal((await as(boss, 'POST', `/servers/${server.id}/bans`, { userId: muted.id, reason: 'spam' })).status, 200);
  assert.ok([403, 404].includes((await as(muted, 'PATCH', `/events/${mine.id}`, { title: 'still mine?' })).status));
  assert.equal(row(mine.id).title, 'Mine');
  // A suspended creator isn't put back down as going when their series moves on.
  const sus = await user('sus');
  const theirs = (await as(sus, 'POST', `/servers/${server.id}/events`, { title: 'Theirs', startsAt: inAWeek(), repeat: 'weekly', timeZone: NY })).json;
  srv.sql('UPDATE users SET suspended_at = ? WHERE id = ?', Date.now(), sus.id);
  endNow(theirs.id, Date.now() - 5 * 3600000);
  assert.ok(await listed(boss, theirs.id));
  assert.deepEqual(rsvps(theirs.id), {});
});

test('editing events is rate limited', async () => {
  const u = await user('busy');
  const ev = (await as(u, 'POST', `/servers/${server.id}/events`, { title: 'Busy', startsAt: inAWeek(), repeat: 'weekly', timeZone: NY })).json;
  let last;
  for (let i = 0; i < 61; i++) last = await as(u, 'PATCH', `/events/${ev.id}`, { title: `Busy ${i}` });
  assert.equal(last.status, 429);
  assert.equal(last.json.code, 'rate_limited');
  assert.equal(row(ev.id).title, 'Busy 59');
  // Creating them already was (20 an hour per person).
  let made;
  for (let i = 0; i < 20; i++) made = await as(u, 'POST', `/servers/${server.id}/events`, { title: `Spam ${i}`, startsAt: inAWeek(), repeat: 'weekly' });
  assert.equal(made.status, 429);
});
