// Per-server nicknames (v19): the name someone goes by in one server, shown there instead of their display name (its
// member list, messages, @mention suggestions, calls, typing and notifications). DMs, profiles and everywhere else keep
// the display name; a profile card opened inside the server shows the nickname as well.
//
// Who can change what (server/perms.js):
//   - your own: Change Nickname (in @everyone by default; a server can take it off @everyone and give it to some roles
//     only, and a timeout takes it away) or Manage Nicknames;
//   - someone else's: Manage Nicknames, and only for people whose highest role is below yours, like kicks and role
//     changes. Nobody but the owner changes the owner's. Owners and Administrators have both permissions.
//   - neither while you're timed out in that server, and neither in group chats (they have no nicknames);
//   - your own, not while an admin has locked your profile (it's a name, like the display name).
// A nickname follows the display name's rules: at most 32 characters after trimming, and the instance's word filter.
// Control, direction-changing and invisible characters are dropped (they can make one name pass for another or break
// the line it's on), and a name with nothing visible left is refused. The word filter looks through the invisible
// characters that stay (joiners, variation selectors), so one can't split a blocked word. Empty (or null) means
// "no nickname".
//
// Nicknames are public to the server's members, like the member list: every member's copy of the server carries them
// (nicknames: { userId: nickname }), and a change goes live to the server's room. They're stored with the membership,
// so leaving, a kick or a ban removes them. Every change goes in the server's audit log (member_nickname, with the old
// and new name, so a moderator can see every name someone went by); your own are marked self. So nobody can bury the
// log by renaming themselves over and over, you set your own at most 10 times an hour in each server (past that
// it's refused, not left out of the log: a name nobody can find later is exactly what an abuser would want; removing
// it, back to your display name, always works). Once
// an account is deleted, its entries no longer show the names (server/serveraudit.js), as its profile is erased.
//
// Routes
//   PUT    /servers/:id/members/:uid/nickname   { nickname }   set it (empty or null: remove it)
//   DELETE /servers/:id/members/:uid/nickname                  remove it
// Socket
//   member:nick { serverId, userId, nickname }   to everyone in the server (nickname null: removed)

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX = 32;
const SELF_MAX = 10; // changes to your own nickname an hour, per server
// Line breaks, tabs and other control characters become spaces (so "a\nb" stays two words).
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// Invisible characters: everything Unicode calls default-ignorable (soft hyphen, combining grapheme joiner, Arabic
// letter mark, Hangul fillers, Khmer inherent vowels, Mongolian selectors, zero-width space, direction marks,
// overrides and isolates, word joiner and invisible operators, variation selectors, byte order mark, musical
// formatting, tag characters…) and the interlinear annotation marks. They're dropped, except three kinds that
// something visible needs: the zero-width joiners (emoji and several scripts), variation selectors (emoji or text
// style, CJK variants), and tag characters inside a flag (England, Scotland, Wales).
const HIDDEN = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,7}\u{E007F}|[\p{Default_Ignorable_Code_Point}\ufff9-\ufffb]/gu;
const KEEP = /^(?:\u{1F3F4}.*|[\u200c\u200d\ufe00-\ufe0f\u{E0100}-\u{E01EF}])$/u;
// What doesn't count as something people can see: the invisible characters that stay, white space, and the blank
// Braille pattern (a character that draws nothing).
const BLANK = /[\p{Default_Ignorable_Code_Point}\s\u2800]/gu;
// For the word filter: every invisible character gone, so "frob<ZWJ>nicate" is still the word it looks like.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

// The nickname as it will be stored: '' for none. Refuses anything that isn't text, is too long, or has nothing
// visible left. (The word filter is checked separately, by the route.)
function cleanNickname(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') throw Object.assign(new Error('A nickname is text.'), { status: 400 });
  // Far longer than any nickname: refused before doing any work on it.
  if (v.length > 512) throw Object.assign(new Error(`A nickname is up to ${MAX} characters.`), { status: 400 });
  const t = v.replace(BREAKS, ' ').replace(HIDDEN, (c) => (KEEP.test(c) ? c : '')).replace(/\s+/g, ' ').trim();
  if (!t) {
    if (v.trim()) throw Object.assign(new Error('A nickname needs at least one character people can see.'), { status: 400 });
    return '';
  }
  if (!t.replace(BLANK, '')) throw Object.assign(new Error('A nickname needs at least one character people can see.'), { status: 400 });
  if (t.length > MAX) throw Object.assign(new Error(`A nickname is up to ${MAX} characters.`), { status: 400 });
  return t;
}
// The text the word filter checks: the nickname with every invisible character taken out.
const wordsOf = (t) => t.replace(IGNORABLE, '');

function setupNicknames(ctx) {
  const { api, auth, db, fail, rateLimit, limitNet, requireServer, isMember, perms, PM, ALL, checkWords, requireUnlocked,
    serverAudit, getIo } = ctx;

  const nicknameOf = (serverId, userId) => {
    const r = db.prepare('SELECT nickname FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
    return (r && r.nickname) || null;
  };
  // Everyone in the server sees the change at once (the same room member:add and member:remove go to).
  const announce = (serverId, userId, nickname) => {
    const io = getIo();
    if (io) io.to(`server:${serverId}`).emit('member:nick', { serverId, userId, nickname: nickname || null });
  };

  // The server and the person whose nickname this request changes, once the caller may change it.
  function target(req) {
    const s = requireServer(String(req.params.id || ''), req.userId);
    if (s.kind === 'group') fail(400, 'Group chats don’t have nicknames.');
    const uid = String(req.params.uid || '');
    if (!ID.test(uid) || !isMember(s.id, uid)) fail(404, 'That person is not in this server.');
    const mine = perms.base(s, req.userId);
    const self = uid === req.userId;
    // A timeout takes Change Nickname away (perms.js TALK); Manage Nicknames waits for it to end as well, like the
    // other moderator tools. Said first, since it's the reason whatever else is true.
    if (mine !== ALL && perms.timedOut(s.id, req.userId)) {
      fail(403, 'You’re timed out in this server, so you can’t change nicknames until it ends.', 'timed_out');
    }
    if (self) {
      if (!(mine & (PM.CHANGE_NICKNAME | PM.MANAGE_NICKNAMES))) fail(403, 'You need the Change Nickname permission.');
      requireUnlocked(req.userId);
    } else {
      if (!(mine & PM.MANAGE_NICKNAMES)) fail(403, 'You need the Manage Nicknames permission.');
      if (uid === s.owner_id) fail(403, 'Only the owner can change the owner’s nickname.');
      if (perms.top(s, uid) >= perms.top(s, req.userId)) fail(403, 'You can only change nicknames for people whose highest role is below yours.');
    }
    return { s, uid, self };
  }
  // Plenty for someone tidying up a member list; not enough to flood a server's member lists with renames.
  function limit(req) {
    rateLimit('nick:' + req.userId, 20, 60000);
    rateLimit('nickh:' + req.userId, 200, 3600000);
    limitNet(req, 'nick', 60, 60000);
  }
  // Your own nickname: set at most SELF_MAX times an hour in each server (a refused or unchanged one doesn't count,
  // and removing it is always allowed, so at most twice that many entries). Every change is in the audit log, so this
  // is what keeps a member from burying it. Kept in memory: a restart starts the count again.
  const own = new Map(); // `${serverId}|${userId}` -> { n, reset }
  function ownChange(serverId, userId) {
    const t = Date.now();
    if (own.size > 10000) for (const [k, v] of own) if (v.reset < t) own.delete(k);
    const k = `${serverId}|${userId}`;
    let e = own.get(k);
    if (!e || e.reset < t) { e = { n: 0, reset: t + 3600000 }; own.set(k, e); }
    if (e.n >= SELF_MAX) {
      const wait = Math.ceil((e.reset - t) / 60000);
      fail(429, `You can change your nickname in a server up to ${SELF_MAX} times an hour (removing it always works). Try again in ${wait} minute${wait === 1 ? '' : 's'}.`, 'rate_limited', Math.ceil((e.reset - t) / 1000));
    }
    return () => { e.n += 1; };
  }

  function change(req, res, wanted) {
    limit(req);
    const { s, uid, self } = target(req);
    let next;
    try { next = cleanNickname(wanted); } catch (e) { fail(e.status || 400, e.message); }
    if (next) checkWords(next, wordsOf(next));
    const before = nicknameOf(s.id, uid);
    if ((before || '') === next) return res.json({ ok: true, userId: uid, nickname: next || null });
    const counted = self && next ? ownChange(s.id, uid) : null;
    db.prepare('UPDATE members SET nickname = ? WHERE server_id = ? AND user_id = ?').run(next || null, s.id, uid);
    if (counted) counted();
    const detail = { from: before, to: next || null };
    // Every change is listed, your own marked as such.
    serverAudit(s, req.userId, 'member_nickname', uid, self ? { ...detail, self: true } : detail);
    announce(s.id, uid, next);
    res.json({ ok: true, userId: uid, nickname: next || null });
  }

  api.put('/servers/:id/members/:uid/nickname', auth, (req, res) => {
    const b = req.body || {};
    if (!('nickname' in b)) fail(400, 'Send the nickname (empty to remove it).');
    change(req, res, b.nickname);
  });
  api.delete('/servers/:id/members/:uid/nickname', auth, (req, res) => change(req, res, null));

  // Instance staff resetting an offensive profile (POST /admin/users/:id/reset-profile): the person's nicknames go
  // too, in every server, each with an entry in that server's audit log saying staff did it.
  function clearAll(userId) {
    const rows = db.prepare('SELECT server_id, nickname FROM members WHERE user_id = ? AND nickname IS NOT NULL').all(userId);
    if (!rows.length) return 0;
    db.prepare('UPDATE members SET nickname = NULL WHERE user_id = ? AND nickname IS NOT NULL').run(userId);
    for (const r of rows) {
      serverAudit(r.server_id, null, 'member_nickname', userId, { from: r.nickname, to: null, staff: true });
      announce(r.server_id, userId, null);
    }
    return rows.length;
  }

  return { nicknameOf, clearAll };
}

module.exports = setupNicknames;
module.exports.cleanNickname = cleanNickname;
module.exports.NICKNAME_MAX = MAX;
