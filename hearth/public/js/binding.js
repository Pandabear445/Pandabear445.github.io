// Where a message belongs, bound into its ciphertext (crypto-7). The conversation, the author and the key epoch were
// already bound in (additional authenticated data, e2ee.js); a message's own identity, place and version weren't. Its
// id, what it replies to, the thread it's in and its time are columns this server keeps beside the ciphertext, and an
// edit simply replaces the ciphertext. So a server could replay a message as new, move it under another reply or
// thread, re-date it or serve the words from before an edit, and it still decrypted and verified.
//
// Every new message now carries, inside the encrypted payload (beside t, f, p, x and l):
//   u    an id the sender's app picks (16 random bytes, base64url): the same through every edit, new for a forward
//   r    the server id of the message it replies to, or null
//   th   the id of the thread's first message for a thread reply, or null
//   ts   when it was sent: the sender's clock corrected by the server's (as for disappearing messages); for a scheduled
//        message (sch: 1) the time its sender picked, or the moment they said Send now (never a time the server gave)
//   v    its edit count: 0 when sent, one more with each edit (re-encrypted with the same u, r, th and ts)
// sch also tells every reader's app that the message was scheduled, and ts when it was due: the lateness a scheduled
// message is allowed needs that marker (README, Send later).
// Readers' apps compare that with what the server says (checkBinding) and show one small flag when they don't match.
// Apps from before this ignore the new fields (secure.js only ever kept the fields it knows), and messages without u
// (older apps, bots, webhooks and the news bot, which aren't end-to-end encrypted anyway) are never flagged.
//
// Nothing here throws on odd input: a message whose fields are malformed is flagged, never made unreadable.

export const SKEW = 10 * 60 * 1000; // clocks and slow connections: a message's time may be this far off either way
// A scheduled message may go out late without a flag, up to the server's own limit (server/scheduled.js
// LATE_LIMIT_MS: a server that was down posts what came due within the last day, and slow mode only delays one).
export const SCHEDULED_LATE = 24 * 3600 * 1000;
const UID = /^[A-Za-z0-9_-]{22}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_V = 1000000;

// 16 random bytes as base64url (22 characters).
export function newUid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const idOr = (x) => (typeof x === 'string' && ID.test(x) ? x : null);

// The fields for a new message (sent now, scheduled, or forwarded: always a new u). at: when it's sent (ms, the
// server's clock as this app knows it), or for a scheduled message the time it's due.
export function bindNew({ replyTo = null, threadId = null, at, scheduled = false } = {}) {
  return { u: newUid(), r: idOr(replyTo), th: idOr(threadId), ts: Math.round(Number(at) || 0), v: 0, ...(scheduled ? { sch: 1 } : {}) };
}
// An edit: the same message (u), place (r, th) and time (ts), one version later.
export function bindEdit(b) {
  return { u: b.u, r: b.r, th: b.th, ts: b.ts, v: Math.min(MAX_V, (b.v || 0) + 1), ...(b.sch ? { sch: 1 } : {}) };
}
// A scheduled message re-encrypted before it goes (scheduled.js reseal): the u, reply and thread fixed when it was
// scheduled (from the sender's own copy), and the time it goes out (at: the one in that copy, unless its sender just
// picked another or said Send now). Never posted yet, so still version 0. A copy from before these fields existed
// gets none ({}), like a message from an older app: filling them in from what the server holds for it (its reply,
// thread and time) would sign the server's word into it.
export function bindScheduled(b, { at } = {}) {
  if (!b || !UID.test(String(b.u || ''))) return {};
  return { u: b.u, r: idOr(b.r), th: idOr(b.th), ts: Math.round(Number(at) || 0), v: 0, sch: 1 };
}

// What a decrypted payload says about where it belongs, or undefined when it carries no (well-formed) u: then it's
// a message from before this, and nothing is checked. Anything else malformed comes out as values that fail the
// checks (ts 0), never as an exception.
export function bindingOf(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.u !== 'string' || !UID.test(payload.u)) return undefined;
  const ts = Number.isSafeInteger(payload.ts) && payload.ts > 0 ? payload.ts : 0;
  const v = Number.isSafeInteger(payload.v) && payload.v >= 0 && payload.v <= MAX_V ? payload.v : 0;
  return { u: payload.u, r: idOr(payload.r), th: idOr(payload.th), ts, v, ...(payload.sch === 1 ? { sch: 1 } : {}) };
}

// What the server says against what the message says. m: the message as the server sent it (replyTo, threadId,
// createdAt). b: bindingOf its payload. Returns { issues, notes }:
//   issues  'reply'     it was written as a reply to another message, or to none (or the server dropped the reply
//                       while the original is still there)
//           'thread'    it was written in another thread, or outside one (or the other way round)
//           'time'      the server's time for it is more than SKEW from when it was sent (a scheduled one may also be
//                       up to SCHEDULED_LATE late)
//           'repeated'  the same message (author and u) is here under more than one id (copies > 1)
//           'older'     an earlier version than one this device has already shown (top: the highest v seen)
//   notes   'replyGone' it replied to a message that is gone (deleted or disappeared before it was posted): the
//                       server rightly leaves the reply out, so this isn't a flag
// present(id): whether the message it replied to is still there: loaded here and not disappeared, or found by the
// server when asked (createOriginals). A reply the server left out while its original is still there was taken away,
// so that one is a flag after all.
// A thread has no such case: this server never shows a thread reply outside its thread (deleting or expiring the
// first message takes its replies with it, and a reply to a thread that's gone is refused), so a reply shown in the
// conversation itself was moved there, whether or not its thread's first message is loaded.
export function checkBinding(m, b, { present = () => false, copies = 1, top = -1 } = {}) {
  const issues = [];
  const notes = [];
  if (!m || !b) return { issues, notes };
  const replyTo = idOr(m.replyTo);
  if (b.r !== replyTo) {
    if (b.r && !replyTo && !present(b.r)) notes.push('replyGone');
    else issues.push('reply');
  }
  if (b.th !== idOr(m.threadId)) issues.push('thread');
  const off = Number(m.createdAt) - b.ts; // > 0: posted after the time it says
  if (!b.ts || !Number.isFinite(off) || off < -SKEW || off > SKEW + (b.sch ? SCHEDULED_LATE : 0)) issues.push('time');
  if (copies > 1) issues.push('repeated');
  if (top > b.v) issues.push('older');
  return { issues, notes };
}

// "about 3 hours", "about 25 minutes": how far a message's time is off, for the details.
export function roughly(ms) {
  const a = Math.abs(ms);
  if (a >= 2 * 86400000) return `about ${Math.round(a / 86400000)} days`;
  if (a >= 2 * 3600000) return `about ${Math.round(a / 3600000)} hours`;
  if (a >= 90 * 60000) return 'about an hour and a half';
  if (a >= 55 * 60000) return 'about an hour';
  return `about ${Math.max(1, Math.round(a / 60000))} minutes`;
}
// The details for the flag: one plain sentence per check that failed.
export function describe(issues, { m, b, copies = 1, top = -1 } = {}) {
  const out = [];
  const replyTo = m ? idOr(m.replyTo) : null;
  const threadId = m ? idOr(m.threadId) : null;
  for (const k of issues) {
    if (k === 'reply') {
      out.push(!b || !b.r ? 'Its sender didn’t write it as a reply, but it’s shown as one.'
        : replyTo ? 'Its sender wrote it as a reply to a different message than the one shown.'
          : 'Its sender wrote it as a reply, but it’s shown without one while the original is still there.');
    } else if (k === 'thread') {
      out.push(!b || !b.th ? 'Its sender wrote it in the conversation itself, not in a thread.'
        : threadId ? 'Its sender wrote it in a different thread.'
          : 'Its sender wrote it in a thread, but it’s shown in the conversation itself.');
    } else if (k === 'time') {
      const off = m && b && b.ts ? Number(m.createdAt) - b.ts : NaN;
      out.push(Number.isFinite(off) ? `Its time doesn’t match when it was sent: it’s shown ${roughly(off)} ${off > 0 ? 'later' : 'earlier'}.` : 'Its time doesn’t match when it was sent.');
    } else if (k === 'repeated') out.push(`The same message appears here ${copies === 2 ? 'twice' : `${copies} times`}, under different ids.`);
    else if (k === 'older') out.push(`This is an older version: this device has already shown edit ${top}${b ? `, and this is ${b.v ? `edit ${b.v}` : 'the original'}` : ''}.`);
  }
  return out;
}

// The highest version this device has seen of each message (author and u), kept across reloads so a server can't
// quietly serve the words from before an edit later on. Only edited messages are kept (version 0 has nothing older),
// at most `max` of them. When it's full, whoever has the most entries loses their oldest one: an account that edits a
// flood of messages (a sock puppet the server's operator made) pushes out its own entries, not other people's. Even so
// it's a bounded memory, so a server with very many accounts at its disposal can still wear it down.
// storage: localStorage or anything like it; every access is guarded (private windows).
export function createVersions(storage, keyFor, { max = 2000 } = {}) {
  let cache = { key: '', map: null };
  const load = () => {
    const key = keyFor();
    if (!key) return null;
    if (cache.key === key && cache.map) return cache.map;
    let map = new Map();
    try {
      const raw = JSON.parse(storage.getItem(key) || '[]');
      if (Array.isArray(raw)) for (const e of raw) if (Array.isArray(e) && typeof e[0] === 'string' && Number.isSafeInteger(e[1])) map.set(e[0], e[1]);
    } catch { map = new Map(); }
    cache = { key, map };
    return map;
  };
  const id = (authorId, u) => `${authorId}|${u}`;
  const authorOf = (key) => key.slice(0, key.lastIndexOf('|'));
  // The oldest entry of the author with the most (the oldest of those authors' entries on a tie).
  const evictable = (map) => {
    const count = new Map();
    let most = 0;
    for (const key of map.keys()) { const a = authorOf(key); const n = (count.get(a) || 0) + 1; count.set(a, n); if (n > most) most = n; }
    for (const key of map.keys()) if (count.get(authorOf(key)) === most) return key;
    return map.keys().next().value;
  };
  return {
    // The highest version seen so far (-1: none above the original).
    top(authorId, u) { const map = load(); return map ? (map.get(id(authorId, u)) ?? -1) : -1; },
    // Records a version just seen.
    see(authorId, u, v) {
      if (!(v > 0)) return;
      const map = load();
      if (!map) return;
      const k = id(authorId, u);
      if ((map.get(k) ?? -1) >= v) return;
      map.delete(k);
      map.set(k, v); // newest last, so each author's oldest go first when it's full
      while (map.size > max) map.delete(evictable(map));
      try { storage.setItem(cache.key, JSON.stringify([...map])); } catch { /* storage full or off: kept for this session */ }
    },
  };
}

// The server ids each message (author and u) has shown up under in each conversation this session: the same
// message under two ids was posted twice by someone who could only copy it, since every app sends each u once.
export function createCopies() {
  const seen = new Map(); // `${conv}|${authorId}|${u}` -> Set(ids)
  const k = (conv, authorId, u) => `${conv}|${authorId}|${u}`;
  return {
    // Notes it; returns every id it has had (this one included).
    add(conv, authorId, u, id) {
      const key = k(conv, authorId, u);
      let ids = seen.get(key);
      if (!ids) { ids = new Set(); seen.set(key, ids); }
      ids.add(id);
      return ids;
    },
    count(conv, authorId, u) { const ids = seen.get(k(conv, authorId, u)); return ids ? ids.size : 0; },
    // Messages deleted (or disappeared) in that conversation: they no longer count as copies. Returns the ids of the
    // copies left behind, which need drawing again (one left alone is no longer "repeated").
    drop(conv, gone) {
      const out = [];
      for (const [key, ids] of seen) {
        if (!key.startsWith(conv + '|')) continue;
        let hit = false;
        for (const id of gone) if (ids.delete(id)) hit = true;
        if (!ids.size) seen.delete(key);
        else if (hit) out.push(...ids);
      }
      return out;
    },
    clear() { seen.clear(); },
  };
}

// Whether a message that isn't loaded here is still there, asked of the server once each (lookup(id): the same
// lookup message links use, GET /messages/:id/locate, resolving true when found and false when gone). For a reply the
// server shows without its original: an original it can still find was taken away from the reply, not lost, so the
// server would have to deny that message everywhere to pass the reply off as orphaned. Until the answer comes, and
// when there's none (no connection), the original counts as gone: an unanswered question never raises a flag.
export function createOriginals(lookup, { max = 500 } = {}) {
  const known = new Map(); // id -> true (found) | false (gone) | Promise (asking)
  return {
    found(id) { return known.get(id) === true; },
    // Asks about it unless that was done already; onFound() once it turns out to be there. Resolves to whether it is.
    ask(id, onFound = () => {}) {
      if (!ID.test(String(id || ''))) return Promise.resolve(false);
      if (known.has(id)) return Promise.resolve(known.get(id)).then((x) => x === true);
      if (known.size >= max) known.delete(known.keys().next().value);
      const p = Promise.resolve().then(() => lookup(id)).then((ok) => {
        known.set(id, ok === true);
        if (ok === true) onFound();
        return ok === true;
      }, () => { known.delete(id); return false; }); // no answer: asked again next time it's drawn
      known.set(id, p);
      return p;
    },
    clear() { known.clear(); },
  };
}

// ------------------------------------------------------------------ the app's side (app.js), one message at a time
// What a decrypted message says about itself, when that can be trusted: a channel message that verified as its
// author's, or a DM that opened with a key this device trusts (the one it has pinned for them now, or one it pinned
// back then: secure.js keyNote none or 'pinned'). Anything else already carries a stronger warning (a new key not
// verified yet, one the server merely lists), and its fields could have been written by someone else, so they're
// neither checked nor remembered.
export function trustedBinding(m) {
  const d = m && m.dec;
  if (!d || d.error || d.pending || !d.b) return null;
  if (m.dmId) return !d.keyNote || d.keyNote === 'pinned' ? d.b : null;
  return d.verified === true ? d.b : null;
}
// Notes a message as it's decrypted (conv: its conversation, 'c:<channel>' or 'd:<dm>'): its edit count and the id
// it came under. Returns the ids of other copies already loaded that now need drawing again (a second id for the
// same message, or a newer edit that makes another copy the older one).
export function noteMessage(m, conv, { versions, copies }) {
  const b = trustedBinding(m);
  if (!b || !m.id) return [];
  const before = versions.top(m.authorId, b.u);
  versions.see(m.authorId, b.u, b.v);
  const ids = copies.add(conv, m.authorId, b.u, m.id);
  return ids.size > 1 || b.v > before ? [...ids].filter((id) => id !== m.id) : [];
}
// { issues, notes, b, copies, top } for a message (checkBinding), or null when it carries nothing to check.
// present(id): a message with that id is loaded in this conversation and hasn't disappeared.
export function bindingState(m, conv, { versions, copies, present = () => false }) {
  const b = trustedBinding(m);
  if (!b) return null;
  const n = copies.count(conv, m.authorId, b.u);
  const top = versions.top(m.authorId, b.u);
  return { ...checkBinding(m, b, { present, copies: n, top }), b, copies: n, top };
}
