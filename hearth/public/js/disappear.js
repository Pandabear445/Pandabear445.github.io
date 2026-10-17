// Disappearing messages on this device: the timer choices, when a message is due to go, and the line shown when
// someone changes a conversation's timer. No DOM and no network, so it's tested under Node (test/disappearing.test.js).
//
// A message carries two deadlines: expiresAt, which the server stamped when it stored the message, and x, the timer
// the sender's app put inside the encrypted message. The app hides a message at the earlier of the two, so it goes
// on time even if the server forgets to delete it or stamps a later deadline. The send time (createdAt) still comes
// from the server, though: a dishonest server can change it and keep a message showing longer.

export const MAX_SECS = 28 * 86400;
export const TIMERS = [[0, 'Off'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week'], [2419200, '4 weeks']];
const HOUR = 3600000;

// "1 week", "4 weeks", "Off" (and "5 seconds", the choice browser tests use).
export function label(secs) {
  const s = Number(secs) || 0;
  const known = TIMERS.find(([v]) => v === s);
  if (known) return known[1];
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (s % 604800 === 0) return unit(s / 604800, 'week');
  if (s % 86400 === 0) return unit(s / 86400, 'day');
  if (s % 3600 === 0) return unit(s / 3600, 'hour');
  if (s % 60 === 0) return unit(s / 60, 'minute');
  return unit(s, 'second');
}

// The timers this server offers (/config; under test it adds 5 seconds). Only these count inside a message: a
// modified app can't make a message vanish from its readers' screens seconds after it arrives, before anyone could
// report it, in a conversation where the timer is off or longer.
let offered = new Set(TIMERS.map(([v]) => v).filter(Boolean));
export function setChoices(list) {
  const ok = Array.isArray(list) ? list.filter((v) => Number.isInteger(v) && v >= 1 && v <= MAX_SECS) : [];
  if (ok.length) offered = new Set(ok);
}
// The timer inside a decrypted message: one of the offered choices (a whole number of seconds up to 4 weeks), or
// nothing.
export const cleanX = (v) => (Number.isInteger(v) && v >= 1 && v <= MAX_SECS && offered.has(v) ? v : undefined);

// When a message goes: the earlier of the server's deadline and its own timer. Infinity: never.
export function deadline(m) {
  if (!m) return Infinity;
  const server = Number(m.expiresAt) > 0 ? Number(m.expiresAt) : Infinity;
  const x = m.dec && cleanX(m.dec.x);
  const own = x && Number.isFinite(Number(m.createdAt)) ? Number(m.createdAt) + x * 1000 : Infinity;
  return Math.min(server, own);
}
export const expired = (m, now) => deadline(m) <= now;
export const disappears = (m) => Number.isFinite(deadline(m));
// The server's deadline is later than the sender's own timer (or missing), with a minute's slack for clocks: the
// server kept it longer, or the sender's app chose a shorter timer than the conversation's.
export function serverKept(m) {
  const x = m && m.dec && cleanX(m.dec.x);
  if (!x) return false;
  const own = Number(m.createdAt) + x * 1000;
  return !m.expiresAt || Number(m.expiresAt) > own + 60000;
}
// A timer change between writing a message and sending it that would keep it longer than the timer it was written
// under (turned off, or made longer): the app asks before sending it. A stricter one (turned on, made shorter) is fine.
export const weaker = (wrote, now) => (Number(wrote) || 0) > 0 && (!(Number(now) > 0) || Number(now) > Number(wrote));
// The timer a message re-encrypted later keeps (a scheduled one, scheduled.js): the conversation's now, unless that
// is weaker than the one it was written under, which then stays. 0 = none.
export const stricter = (wrote, now) => (weaker(wrote, now) ? Number(wrote) : Number(now) > 0 ? Number(now) : 0);
// The soonest deadline still ahead, or null.
export function nextDeadline(items, now) {
  let best = Infinity;
  for (const m of items) { const d = deadline(m); if (d > now && d < best) best = d; }
  return best === Infinity ? null : best;
}
// How long to wait for a deadline: never less than a quarter second, and never more than an hour (long timers and
// a computer that went to sleep are checked again then; setTimeout can't wait past 24.8 days anyway).
export const waitFor = (at, now) => Math.max(250, Math.min(HOUR, at - now));

// A name that reads as "You": in any case, with accents, spaces, dots or invisible characters in it (Hangul fillers
// and every other character Unicode calls default-ignorable too), look-alike letters from other alphabets, or as its
// first word ("You (admin)"). On the timer line it could pass for your own change. Look-alikes are matched before
// anything is lower-cased, as capital and small letters can look like different ones: a capital Greek upsilon "Υ"
// reads as Y, its small letter "υ" as u. (No list of look-alikes is complete, so the line doesn't rest on this alone:
// see sysLineParts.)
const LOOKALIKE = new Map(Object.entries({
  y: 'уУүҮʏỿΥγɣᎩꭹⲨⲩყƴɏ',
  o: 'оОοΟօՕөӨ0σᴏⲟⲞøØɵᴑ〇ⵔ',
  u: 'υսՍцЦμʊᴜᑌᥙʋʉ',
}).flatMap(([to, from]) => [...from].map((c) => [c, to])));
const INVISIBLE = /[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
export function readsAsYou(name) {
  const s = String(name || '').normalize('NFKD').replace(INVISIBLE, '').replace(/./gsu, (c) => LOOKALIKE.get(c) || c.toLowerCase());
  if (s.replace(/[^\p{L}]/gu, '') === 'you') return true;
  return s.split(/[^\p{L}]+/u).find(Boolean) === 'you';
}
// The line shown in the conversation when someone changes its timer, in parts. entry: { by, secs, prev }.
//   self    true only when the change is yours (its user id is yours): then who is "You"
//   who     otherwise their name (nameOf: a nickname in a server, else the display name), or "Someone"
//   handle  their @username (handleOf, always letters, digits, _ and . only), after any name that isn't simply that
//           username, and after one that reads as "You" even when it is: whatever look-alike a name uses, someone
//           else's change never reads as your own. Without a known @username, a name that reads as "You" is "Someone"
//   action  "turned off disappearing messages", "turned on disappearing messages: 1 week", "changed …"
// The app draws a name apart from the built-in "You" as well (sysLineEl in app.js).
export function sysLineParts(entry, meId, nameOf, handleOf = () => null) {
  const self = !!entry.by && entry.by === meId;
  let who = self ? 'You' : (entry.by && nameOf(entry.by)) || 'Someone';
  let handle = null;
  if (!self) {
    const at = (entry.by && handleOf(entry.by)) || null;
    const justTheUsername = !!at && /^[A-Za-z0-9_.]+$/.test(who) && who.toLowerCase() === String(at).toLowerCase();
    if (at && (!justTheUsername || readsAsYou(who))) handle = at;
    else if (!at && readsAsYou(who)) who = 'Someone';
  }
  const action = !entry.secs ? 'turned off disappearing messages'
    : !entry.prev ? `turned on disappearing messages: ${label(entry.secs)}`
      : `changed disappearing messages to ${label(entry.secs)}`;
  return { self, who, handle, action };
}
export function sysLineText(entry, meId, nameOf, handleOf) {
  const p = sysLineParts(entry, meId, nameOf, handleOf);
  return `${p.who}${p.handle ? ` (@${p.handle})` : ''} ${p.action}`;
}

// "in 3 days", "in 5 hours", "in 20 minutes", "in less than a minute".
export function remaining(ms) {
  if (ms < 60000) return 'in less than a minute';
  const unit = (n, w) => `in ${n} ${w}${n === 1 ? '' : 's'}`;
  if (ms < HOUR) return unit(Math.round(ms / 60000), 'minute');
  if (ms < 2 * 86400000) return unit(Math.round(ms / HOUR), 'hour');
  return unit(Math.round(ms / 86400000), 'day');
}
