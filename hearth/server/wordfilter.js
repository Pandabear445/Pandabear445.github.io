// Word filters (v19): hiding or blurring messages with words someone would rather not see. Messages are end-to-end
// encrypted, so this server can't read them, let alone filter them (docs/NEXT.md, "Not recommended"); all the
// matching happens in each reader's app (public/js/wordfilter.js), which never tells the server whether anything
// matched. What the server keeps is the lists:
//
//   - Your own list: encrypted by your app with your personal vault key (the one saved-message notes and scheduled
//     messages use; only your identity key can make it), bound to your account, and padded so its size says little
//     about how long it is. The server stores the ciphertext and hands it to your devices; it never learns a word
//     on it, or which servers' suggested lists you turned off (that's inside too).
//   - A server's suggested list: set by people with Manage Server, like the server's name. It isn't encrypted: every
//     member's copy of the server carries it (wordFilter: { words, action, updatedAt }) and members' apps apply it
//     in that server's channels, voice chats and threads unless the person turned it off. It's a suggestion, not a
//     rule: it doesn't stop anyone from posting anything, and the server still can't see what's posted. Every change
//     is in the server's audit log (word_filter_update: what was added and removed). Group chats have none.
//
// The rules for entries are the app's (public/js/wordfilter.js LIMITS): up to 200 entries, each up to 60 characters
// and 5 words, at least 2 letters or numbers, at most 4 *'s, and a * goes inside a word. They're checked here again
// for a server's list (anyone can call the route); the app also reports them as you type.
//
// Routes
//   GET /me/word-filter                  -> { data: 'x1:…' | null, updatedAt }
//   PUT /me/word-filter { data, base? }   data: your sealed list ('x1:…', or null to delete it); base: the updatedAt
//                                         your app last saw (a newer one is refused with 409 stale, so one device
//                                         can't silently undo another's change) -> { updatedAt }
//   GET /servers/:id/word-filter          (members) -> { words, action, updatedAt }
//   PUT /servers/:id/word-filter { words, action }   (Manage Server) words: an array or the text as typed
//                                         (one per line or comma-separated), [] to clear; action: 'hide' | 'blur'
// Socket
//   wordfilter:changed { updatedAt, from }        to your own apps (from: the session that saved it)
//   server:wordfilter { serverId, wordFilter }    to everyone in the server (wordFilter null: cleared)

const LIMITS = Object.freeze({ entries: 200, length: 60, words: 5, wildcards: 4, letters: 2 });
const ACTIONS = ['hide', 'blur'];
// A sealed list: 200 entries of 60 characters is about 12 KB of text (up to 4 bytes a character), padded and
// base64'd. Far more than any real list, far less than anything that would matter.
const SEALED_MAX = 96 * 1024;

// How the app reads an entry (public/js/wordfilter.js cleanEntry, fold and parseEntry), so the server refuses
// exactly what the app's editor says is wrong and keeps nothing the app would leave out. Kept in step with it: a
// test runs both over the same entries ("the server checks entries the way the app does").
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu; // invisible, format and direction characters
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const BROKEN = /\p{Cs}/u; // half of a character (a lone surrogate)
const MARKED = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu;
const PLAIN = {
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', ħ: 'h', ı: 'i', ŧ: 't', ƀ: 'b', ɨ: 'i', ʉ: 'u', þ: 'th', ŀ: 'l', ς: 'σ',
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p',
  ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
};
const PLAIN_RE = new RegExp(`[${Object.keys(PLAIN).join('')}]`, 'g');
const BOXED = /[\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}]/gu;
const fold = (t) => t.normalize('NFKC').replace(BOXED, (c) => String.fromCharCode(97 + ((c.codePointAt(0) - 0x1F150) % 32)))
  .replace(IGNORABLE, '').toLowerCase().normalize('NFD').replace(MARKED, '$1').normalize('NFC').replace(PLAIN_RE, (c) => PLAIN[c]);

const bad = (message, entry) => Object.assign(new Error(message), { status: 400, entry });
const cleanEntry = (raw) => String(raw).replace(IGNORABLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

// A server's list as stored: the entries cleaned, the same one (as the app reads it) once, in order. Anything wrong
// is refused with the entry and why, rather than quietly dropped: the person setting it should know.
function cleanList(input) {
  let raw;
  if (Array.isArray(input)) raw = input;
  else if (typeof input === 'string') {
    if (input.length > 100000) throw bad('That list is too long.');
    raw = input.split(/[\n,]/);
  } else throw bad('Send the words as a list.');
  if (raw.length > 2000) throw bad(`A list holds up to ${LIMITS.entries} entries.`);
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (typeof r !== 'string') throw bad('Each entry is text.');
    if (r.length > 1000) throw bad(`An entry is up to ${LIMITS.length} characters.`);
    const text = cleanEntry(r);
    if (!text) continue;
    if (BROKEN.test(text)) throw bad('An entry has a broken character in it.', text.replace(/\p{Cs}/gu, '\ufffd').slice(0, 80));
    if ([...text].length > LIMITS.length) throw bad(`An entry is up to ${LIMITS.length} characters.`, text.slice(0, 80));
    const folded = fold(text);
    const words = (folded.match(/[\p{L}\p{N}\p{M}*]+/gu) || []).map((w) => w.replace(/\*+/g, '*'));
    if (!words.length) throw bad('An entry needs letters or numbers.', text);
    if (words.length > LIMITS.words) throw bad(`An entry is up to ${LIMITS.words} words.`, text);
    if (words.includes('*')) throw bad('A * goes inside a word (cat*), not on its own.', text);
    let stars = 0;
    let letters = 0;
    for (const w of words) for (const c of w) if (c === '*') stars++; else letters++;
    if (stars > LIMITS.wildcards) throw bad(`An entry has up to ${LIMITS.wildcards} *’s.`, text);
    if (letters < LIMITS.letters) throw bad(`An entry needs at least ${LIMITS.letters} letters or numbers.`, text);
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(text);
  }
  if (out.length > LIMITS.entries) throw bad(`A list holds up to ${LIMITS.entries} entries.`);
  return out;
}

function setupWordFilter(ctx) {
  const { api, auth, db, fail, rateLimit, limitNet, requireServer, perms, PM, serverAudit, getIo, emitTo } = ctx;
  const now = () => Date.now();

  // ------------------------------------------------------------------ your own list (sealed)
  const mineOf = (uid) => db.prepare('SELECT data, updated_at FROM word_filters WHERE user_id = ?').get(uid);
  api.get('/me/word-filter', auth, (req, res) => {
    rateLimit('wfget:' + req.userId, 120, 60000);
    const r = mineOf(req.userId);
    res.json({ data: r ? r.data : null, updatedAt: r ? r.updated_at : 0 });
  });
  api.put('/me/word-filter', auth, (req, res) => {
    rateLimit('wf:' + req.userId, 30, 60000);
    rateLimit('wfh:' + req.userId, 300, 3600000);
    limitNet(req, 'wf', 120, 60000);
    const b = req.body || {};
    const data = b.data === null ? null : b.data;
    if (data !== null && (typeof data !== 'string' || !/^x1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(data))) fail(400, 'Bad data.');
    if (data && data.length > SEALED_MAX) fail(413, 'That word filter is too big to save.');
    if (b.base !== undefined && b.base !== null && !Number.isSafeInteger(b.base)) fail(400, 'Bad base.');
    const cur = mineOf(req.userId);
    const was = cur ? cur.updated_at : 0;
    // Saved on another device since this one last loaded it: say so instead of overwriting that change.
    if (Number.isSafeInteger(b.base) && b.base !== was) fail(409, 'Your word filter was changed on another device. It has been reloaded: make your change again.', 'stale');
    const t = Math.max(now(), was + 1); // strictly increasing, so two quick saves still order
    if (data === null) db.prepare('UPDATE word_filters SET data = NULL, updated_at = ? WHERE user_id = ?').run(t, req.userId);
    else {
      db.prepare(`INSERT INTO word_filters (user_id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(req.userId, data, t);
    }
    emitTo(req.userId, 'wordfilter:changed', { updatedAt: t, from: req.session.id });
    res.json({ updatedAt: t });
  });

  // ------------------------------------------------------------------ a server's suggested list (plain)
  const parse = (s) => {
    if (!s || s.kind === 'group' || !s.word_filter) return null;
    try {
      const v = JSON.parse(s.word_filter);
      if (!v || !Array.isArray(v.words) || !v.words.length) return null;
      return { words: v.words, action: ACTIONS.includes(v.action) ? v.action : 'hide', updatedAt: v.updatedAt || 0 };
    } catch { return null; }
  };
  api.get('/servers/:id/word-filter', auth, (req, res) => {
    rateLimit('wfget:' + req.userId, 120, 60000);
    const s = requireServer(String(req.params.id || ''), req.userId);
    if (s.kind === 'group') fail(400, 'Group chats don’t have a word filter of their own.');
    res.json(parse(s) || { words: [], action: 'hide', updatedAt: 0 });
  });
  api.put('/servers/:id/word-filter', auth, (req, res) => {
    rateLimit('wfs:' + req.userId, 20, 60000);
    rateLimit('wfsh:' + req.userId, 100, 3600000);
    limitNet(req, 'wfs', 60, 60000);
    const s = requireServer(String(req.params.id || ''), req.userId);
    if (s.kind === 'group') fail(400, 'Group chats don’t have a word filter of their own.');
    if ((perms.base(s, req.userId) & PM.MANAGE_SERVER) !== PM.MANAGE_SERVER) fail(403, 'You need the Manage Server permission.');
    const b = req.body || {};
    const action = b.action === undefined ? null : b.action;
    if (action !== null && !ACTIONS.includes(action)) fail(400, 'Choose hide or blur.');
    let words;
    try { words = cleanList(b.words === undefined ? [] : b.words); } catch (e) { fail(e.status || 400, e.entry ? `${e.message} (“${e.entry}”)` : e.message, 'bad_entry'); }
    const before = parse(s) || { words: [], action: 'hide', updatedAt: 0 };
    const next = { words, action: action || before.action, updatedAt: Math.max(now(), before.updatedAt + 1) };
    const same = next.words.length === before.words.length && next.words.every((w, i) => w === before.words[i]) && (!next.words.length || next.action === before.action);
    if (same) return res.json(parse(s) || { words: [], action: next.action, updatedAt: before.updatedAt });
    db.prepare('UPDATE servers SET word_filter = ? WHERE id = ?').run(next.words.length ? JSON.stringify(next) : null, s.id);
    // The audit log says what changed. The list is no secret (every member's app has it), and moderators reading
    // the log need to see what was added to understand what members stopped seeing.
    const had = new Set(before.words.map((w) => w.toLowerCase()));
    const has = new Set(next.words.map((w) => w.toLowerCase()));
    serverAudit(s, req.userId, 'word_filter_update', null, {
      added: next.words.filter((w) => !had.has(w.toLowerCase())),
      removed: before.words.filter((w) => !has.has(w.toLowerCase())),
      count: next.words.length,
      // What it does now, when that's new: the action changed, or there was no list before.
      action: next.words.length && (next.action !== before.action || !before.words.length) ? { from: before.words.length ? before.action : null, to: next.action } : undefined,
    });
    const out = next.words.length ? next : null;
    const io = getIo();
    if (io) io.to(`server:${s.id}`).emit('server:wordfilter', { serverId: s.id, wordFilter: out });
    res.json(out || { words: [], action: next.action, updatedAt: next.updatedAt });
  });

  // What every member's copy of the server carries (serverCommon in index.js).
  return { publicOf: parse };
}

module.exports = setupWordFilter;
module.exports.cleanList = cleanList;
module.exports.LIMITS = LIMITS;
module.exports.SEALED_MAX = SEALED_MAX;
