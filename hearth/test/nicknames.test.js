// Per-server nicknames: the name someone goes by in one server. Members set their own (Change Nickname, on for
// everyone by default), moderators with Manage Nicknames change or reset those of people below them. Everyone in the
// server gets them in their copy of it and live; nothing changes outside it (the display name stays). Every change
// is in the server's audit log, and the rules for names hold: length, the word filter, no invisible tricks.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, hex } = require('./helpers');
const { cleanNickname } = require('../server/nicknames');

const P = { VIEW: 1, SEND: 2, KICK: 1 << 9, MANAGE_ROLES: 1 << 12, VIEW_AUDIT_LOG: 1 << 19, CHANGE_NICKNAME: 1 << 20, MANAGE_NICKNAMES: 1 << 21, ADMIN: 1 << 30 };
let srv;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
// The next event of a kind that matches (null if none comes in time).
const next = (s, ev, match = () => true, ms = 3000) => new Promise((r) => {
  const on = (x) => { if (!match(x)) return; clearTimeout(t); s.off(ev, on); r(x); };
  const t = setTimeout(() => { s.off(ev, on); r(null); }, ms);
  s.on(ev, on);
});

before(async () => { srv = await startServer(); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

// A server with a moderator role (Manage Nicknames and View Audit Log) given to mod, and two plain members.
async function club() {
  const owner = await srv.register(); const mod = await srv.register(); const member = await srv.register(); const other = await srv.register();
  const server = (await as(owner, 'POST', '/servers', { name: 'Club ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const u of [mod, member, other]) assert.equal((await as(u, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const modRole = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Mod', permissions: P.MANAGE_NICKNAMES | P.VIEW_AUDIT_LOG | P.VIEW | P.SEND })).json;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${mod.id}/roles`, { roleIds: [modRole.id] })).status, 200);
  return { owner, mod, member, other, server, modRole };
}
const view = async (u, sid) => (await as(u, 'GET', '/bootstrap')).json.servers.find((s) => s.id === sid);
const setNick = (u, sid, uid, nickname) => as(u, 'PUT', `/servers/${sid}/members/${uid}/nickname`, { nickname });
const stored = (sid, uid) => (srv.sql('SELECT nickname FROM members WHERE server_id = ? AND user_id = ?', sid, uid)[0] || {}).nickname;
const audit = async (u, sid) => (await as(u, 'GET', `/servers/${sid}/audit?action=member_nickname`)).json;

test('nicknames: a member sets their own, everyone in the server sees it live, and it stays in that server', async () => {
  const { owner, member, other, server } = await club();
  const so = await sock(other);
  const live = next(so, 'member:nick', (x) => x.serverId === server.id);
  const r = await setNick(member, server.id, member.id, '  Hall   Alice ');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, userId: member.id, nickname: 'Hall Alice' }, 'trimmed, runs of spaces made one');
  assert.deepEqual(await live, { serverId: server.id, userId: member.id, nickname: 'Hall Alice' }, 'open apps hear about it');
  assert.equal(stored(server.id, member.id), 'Hall Alice');
  // Everyone's copy of the server carries it; only people who set one are listed.
  for (const u of [owner, other, member]) assert.deepEqual((await view(u, server.id)).nicknames, { [member.id]: 'Hall Alice' });
  // Outside the server nothing changes: the profile keeps the display name.
  const prof = (await as(other, 'GET', `/users/${member.id}`)).json;
  assert.equal(prof.profile.displayName, member.username);
  assert.equal(JSON.stringify(prof).includes('Hall Alice'), false, 'the profile doesn’t carry nicknames');
  // The same name again changes nothing (and says nothing).
  const quiet = next(so, 'member:nick', (x) => x.serverId === server.id, 600);
  assert.equal((await setNick(member, server.id, member.id, 'Hall Alice')).status, 200);
  assert.equal(await quiet, null);

  // Removing it: an empty name or DELETE.
  let gone = next(so, 'member:nick', (x) => x.serverId === server.id);
  assert.equal((await setNick(member, server.id, member.id, '')).json.nickname, null);
  assert.deepEqual(await gone, { serverId: server.id, userId: member.id, nickname: null });
  assert.equal(stored(server.id, member.id), null);
  assert.deepEqual((await view(other, server.id)).nicknames, {});
  assert.equal((await setNick(member, server.id, member.id, 'Back again')).status, 200);
  gone = next(so, 'member:nick', (x) => x.serverId === server.id && x.nickname === null);
  assert.equal((await as(member, 'DELETE', `/servers/${server.id}/members/${member.id}/nickname`)).status, 200);
  assert.ok(await gone);
  assert.equal(stored(server.id, member.id), null);
  // A body without a nickname is a mistake, not a removal.
  assert.equal((await as(member, 'PUT', `/servers/${server.id}/members/${member.id}/nickname`, {})).status, 400);
});

test('nicknames: Change Nickname is on for everyone in a new server; turning it off, or a timeout, stops it', async () => {
  const { owner, member, server } = await club();
  const everyone = srv.sql('SELECT permissions FROM roles WHERE id = ?', server.id)[0].permissions;
  assert.equal(everyone & P.CHANGE_NICKNAME, P.CHANGE_NICKNAME, 'new servers give everyone Change Nickname');
  assert.equal((await view(member, server.id)).myPerms & P.CHANGE_NICKNAME, P.CHANGE_NICKNAME);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone & ~P.CHANGE_NICKNAME })).status, 200);
  let r = await setNick(member, server.id, member.id, 'Nope');
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Change Nickname/);
  // A role can give it back to some people.
  const nicks = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Nicknamed', permissions: P.CHANGE_NICKNAME })).json;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { add: [nicks.id] })).status, 200);
  assert.equal((await setNick(member, server.id, member.id, 'Yes now')).status, 200);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone })).status, 200);

  // Timed out: no nickname changes until it ends (the app hides the option: the permission is gone).
  assert.equal((await as(owner, 'POST', `/servers/${server.id}/members/${member.id}/timeout`, { minutes: 10 })).status, 200);
  assert.equal((await view(member, server.id)).myPerms & P.CHANGE_NICKNAME, 0);
  r = await setNick(member, server.id, member.id, 'Sneaky');
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'timed_out');
  assert.equal(stored(server.id, member.id), 'Yes now');
  assert.equal((await as(owner, 'DELETE', `/servers/${server.id}/members/${member.id}/timeout`)).status, 200);
  assert.equal((await setNick(member, server.id, member.id, 'Free again')).status, 200);
});

test('nicknames: Manage Nicknames reaches people below you only, never the owner; others can’t touch anyone’s', async () => {
  const { owner, mod, member, other, server, modRole } = await club();
  // Without the permission: refused, and nothing changes.
  let r = await setNick(member, server.id, other.id, 'Renamed by member');
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Manage Nicknames/);
  assert.equal(stored(server.id, other.id), null);
  // A moderator renames a member below them, and resets it.
  r = await setNick(mod, server.id, member.id, 'Tidy name');
  assert.equal(r.status, 200, r.text);
  assert.equal(stored(server.id, member.id), 'Tidy name');
  assert.equal((await as(mod, 'DELETE', `/servers/${server.id}/members/${member.id}/nickname`)).status, 200);
  assert.equal(stored(server.id, member.id), null);
  // Never the owner, and nobody at or above them.
  r = await setNick(mod, server.id, owner.id, 'The boss');
  assert.equal(r.status, 403);
  assert.match(r.json.error, /owner/);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${other.id}/roles`, { roleIds: [modRole.id] })).status, 200);
  r = await setNick(mod, server.id, other.id, 'Same rank');
  assert.equal(r.status, 403);
  assert.match(r.json.error, /below yours/);
  // A moderator can set their own with Manage Nicknames even where Change Nickname is off for everyone.
  const everyone = srv.sql('SELECT permissions FROM roles WHERE id = ?', server.id)[0].permissions;
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone & ~P.CHANGE_NICKNAME })).status, 200);
  assert.equal((await setNick(mod, server.id, mod.id, 'Mod Squad')).status, 200);
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone })).status, 200);
  // The owner reaches everyone, and sets their own.
  assert.equal((await setNick(owner, server.id, mod.id, 'Renamed mod')).status, 200);
  assert.equal((await setNick(owner, server.id, owner.id, 'Founder')).status, 200);
  // An Administrator reaches people below them too.
  const admin = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Admins', permissions: P.ADMIN })).json;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${member.id}/roles`, { roleIds: [admin.id] })).status, 200);
  assert.equal((await setNick(member, server.id, other.id, 'By the admin')).status, 200);
  assert.equal((await setNick(member, server.id, owner.id, 'Nope')).status, 403);
});

test('nicknames: outsiders, people who aren’t members, other servers and group chats', async () => {
  const { owner, member, other, server } = await club();
  const outsider = await srv.register();
  // Not in the server: it doesn't exist as far as they're concerned (the same answer as for a made-up id).
  let r = await setNick(outsider, server.id, outsider.id, 'Gatecrasher');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'Server not found.');
  assert.equal((await setNick(outsider, 'nope' + hex(4), outsider.id, 'x')).json.error, 'Server not found.');
  // The person must be a member of this server.
  r = await setNick(owner, server.id, outsider.id, 'Ghost');
  assert.equal(r.status, 404);
  assert.equal((await setNick(owner, server.id, '../../etc', 'Ghost')).status, 404);
  // A nickname in one server doesn't show in another.
  const second = (await as(owner, 'POST', '/servers', { name: 'Second ' + hex(3) })).json;
  const code = (await as(owner, 'POST', `/servers/${second.id}/invites`, {})).json.code;
  assert.equal((await as(member, 'POST', `/invites/${code}/join`)).status, 200);
  assert.equal((await setNick(member, server.id, member.id, 'Only here')).status, 200);
  assert.deepEqual((await view(member, second.id)).nicknames, {});
  // Group chats have none (their members' copy carries none either).
  const g = (await as(member, 'POST', '/groups', { userIds: [other.id] })).json;
  r = await setNick(member, g.id, member.id, 'Groupie');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Group chats/);
  assert.deepEqual((await view(member, g.id)).nicknames, {});
  assert.equal((await view(other, g.id)).myPerms & P.CHANGE_NICKNAME, 0, 'group members don’t get Change Nickname');
});

test('nicknames: the rules for names — length, text only, nothing invisible, the word filter, a locked profile', async () => {
  const { member, server } = await club();
  const sid = server.id;
  assert.equal((await setNick(member, sid, member.id, 'x'.repeat(33))).status, 400);
  assert.equal((await setNick(member, sid, member.id, 'y'.repeat(5000))).status, 400);
  assert.equal((await setNick(member, sid, member.id, 'x'.repeat(32))).status, 200);
  for (const bad of [42, { a: 1 }, ['x'], true]) assert.equal((await setNick(member, sid, member.id, bad)).status, 400, JSON.stringify(bad));
  // Invisible characters only: refused rather than shown as a blank name. That's every default-ignorable character
  // (combining grapheme joiner, variation selectors, tag characters, Khmer and Mongolian invisibles, musical
  // formatting, Hangul filler, a lone joiner) and the blank Braille pattern.
  let r = await setNick(member, sid, member.id, '\u200b\u2060\u200e');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /character people can see/);
  r = await setNick(member, sid, member.id, '\u2800');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /character people can see/);
  // (The route's rules, checked directly: a member only gets 20 tries a minute.)
  for (const blank of ['\ufe0f', '\u{E0020}\u{E0041}', '\u{E0041}\u{E0042}', '\u034f', '\u17b4', '\u17b5', '\u180b', '\u{1D173}', '\u3164', '\u200d', '\u2800 \u200d\ufe0f']) {
    assert.throws(() => cleanNickname(blank), /character people can see/, JSON.stringify(blank));
  }
  // Inside a name they're dropped too (tag characters can spell out hidden text)...
  assert.equal((await setNick(member, sid, member.id, 'Bo\u034fb\u{E0041}\u{E0042}\u17b4')).json.nickname, 'Bob');
  // ...but not where something visible needs them: an emoji's style, or a flag made of tags.
  assert.equal(cleanNickname('\u2764\ufe0f fan'), '\u2764\ufe0f fan');
  const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  assert.equal((await setNick(member, sid, member.id, `${england} fan`)).json.nickname, `${england} fan`);
  // Direction overrides, control characters and zero-width spaces are dropped; emoji (with their joiners) stay.
  assert.equal((await setNick(member, sid, member.id, 'ad\u202emin\u0007')).json.nickname, 'admin');
  assert.equal((await setNick(member, sid, member.id, 'two\nlines\there')).json.nickname, 'two lines here');
  assert.equal((await setNick(member, sid, member.id, '\u{1F469}\u200d\u{1F469}\u200d\u{1F467} family')).json.nickname, '\u{1F469}\u200d\u{1F469}\u200d\u{1F467} family');
  // The instance's word filter, as for display names.
  assert.equal((await as(srv.owner, 'PUT', '/admin/words', { words: ['frobnicate'] })).status, 200);
  try {
    r = await setNick(member, sid, member.id, 'Big Frobnicate');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /isn’t allowed/);
    // An invisible character can't split the word: it looks the same, so it's the same word.
    for (const split of ['frob\u200dnicate', 'frob\u034fnicate']) {
      r = await setNick(member, sid, member.id, split);
      assert.equal(r.status, 400, JSON.stringify(split));
      assert.match(r.json.error, /isn’t allowed/);
    }
    assert.equal(stored(sid, member.id), '\u{1F469}\u200d\u{1F469}\u200d\u{1F467} family');
  } finally { await as(srv.owner, 'PUT', '/admin/words', { words: [] }); }
  // Markup is just text (the app shows it as text).
  assert.equal((await setNick(member, sid, member.id, '<img src=x onerror=alert(1)>')).json.nickname, '<img src=x onerror=alert(1)>');
  // A profile staff locked can't change its nicknames either (a moderator still can, to tidy one up).
  assert.equal((await as(srv.owner, 'PATCH', `/admin/users/${member.id}/limits`, { profileLocked: true })).status, 200);
  r = await setNick(member, sid, member.id, 'Locked out');
  assert.equal(r.status, 403);
  assert.match(r.json.error, /locked/);
  assert.equal((await as(srv.owner, 'PATCH', `/admin/users/${member.id}/limits`, { profileLocked: false })).status, 200);
});

test('nicknames: every change is in the server’s audit log; your own are marked, and limited to 10 an hour per server', async () => {
  const { owner, mod, member, server } = await club();
  assert.equal((await setNick(member, server.id, member.id, 'First')).status, 200);
  assert.equal((await setNick(mod, server.id, member.id, 'Second')).status, 200);
  assert.equal((await as(mod, 'DELETE', `/servers/${server.id}/members/${member.id}/nickname`)).status, 200);
  let log = await audit(owner, server.id);
  assert.deepEqual(log.entries.map((e) => [e.actorId, e.targetId, e.detail.from, e.detail.to, !!e.detail.self]), [
    [mod.id, member.id, 'Second', null, false],
    [mod.id, member.id, 'First', 'Second', false],
    [member.id, member.id, null, 'First', true],
  ]);
  assert.ok(log.actions.includes('member_nickname'));
  // A moderator with View Audit Log reads them too; members without it can't.
  assert.equal((await audit(mod, server.id)).entries.length, 3);
  assert.equal((await as(member, 'GET', `/servers/${server.id}/audit`)).status, 403);
  // Renaming yourself over and over: every name is listed, so none can be used and then hidden. The 10th change in
  // an hour is the last (a moderator's changes and unchanged names don't count); past it the change is refused.
  for (let i = 1; i < 10; i++) assert.equal((await setNick(member, server.id, member.id, `Benign ${i}`)).status, 200);
  assert.equal((await setNick(member, server.id, member.id, 'Benign 9')).status, 200, 'the same name again isn’t a change');
  const r = await setNick(member, server.id, member.id, 'Server Owner (official)');
  assert.equal(r.status, 429, r.text);
  assert.match(r.json.error, /up to 10 times an hour/);
  assert.equal(stored(server.id, member.id), 'Benign 9');
  log = await audit(owner, server.id);
  const mine = log.entries.filter((e) => e.actorId === member.id);
  assert.equal(mine.length, 10);
  assert.deepEqual(mine.map((e) => e.detail.to).reverse(), ['First', ...Array.from({ length: 9 }, (_, i) => `Benign ${i + 1}`)]);
  assert.ok(mine.every((e) => e.detail.self && !e.detail.last));
  assert.equal(JSON.stringify(log).includes('Server Owner'), false);
  // Going back to your display name always works (and is listed).
  assert.equal((await as(member, 'DELETE', `/servers/${server.id}/members/${member.id}/nickname`)).status, 200);
  assert.equal((await audit(owner, server.id)).entries[0].detail.from, 'Benign 9');
  assert.equal((await setNick(member, server.id, member.id, 'Benign 10')).status, 429);
  // The limit is per server, and doesn't stop a moderator tidying the name up.
  assert.equal((await setNick(mod, server.id, member.id, 'Tidied')).status, 200);
  const second = (await as(owner, 'POST', '/servers', { name: 'Second ' + hex(3) })).json;
  const code = (await as(owner, 'POST', `/servers/${second.id}/invites`, {})).json.code;
  assert.equal((await as(member, 'POST', `/invites/${code}/join`)).status, 200);
  assert.equal((await setNick(member, second.id, member.id, 'Elsewhere')).status, 200);
  // A moderator's renames count as moderation, kept for a week however busy the log gets (like kicks); so does
  // instance staff clearing one (no actor); your own don't. The database's delete guard says so too.
  const guard = srv.sql("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'server_audit_no_delete'")[0].sql;
  assert.match(guard, /'member_nickname'/);
  assert.match(guard, /OLD\.action = 'member_nickname' AND OLD\.actor_id IS OLD\.target_id/);
});

test('nicknames: past the newest 50,000 entries, the database keeps a moderator’s and staff’s nickname changes, not your own', async () => {
  const { owner, mod, member, server } = await club();
  assert.equal((await setNick(member, server.id, member.id, 'Own name')).status, 200);
  assert.equal((await setNick(mod, server.id, member.id, 'Mod name')).status, 200);
  assert.equal((await as(srv.owner, 'POST', `/admin/users/${member.id}/reset-profile`)).status, 200);
  const rows = srv.sql("SELECT id, actor_id FROM server_audit WHERE server_id = ? AND action = 'member_nickname' ORDER BY id", server.id);
  assert.deepEqual(rows.map((x) => x.actor_id), [member.id, mod.id, null]);
  const d = srv.db();
  try {
    // Rather than write 50,000 rows, the next entry's number jumps: everything before is beyond the newest 50,000.
    d.prepare("INSERT INTO server_audit (server_id, seq, actor_id, action, detail, created_at) SELECT ?, MAX(seq) + 50005, ?, 'server_update', '{}', ? FROM server_audit WHERE server_id = ?")
      .run(server.id, owner.id, Date.now(), server.id);
    for (const x of rows.slice(1)) assert.throws(() => d.prepare('DELETE FROM server_audit WHERE id = ?').run(x.id), /append-only/, String(x.actor_id));
    d.exec('SAVEPOINT probe');
    assert.equal(d.prepare('DELETE FROM server_audit WHERE id = ?').run(rows[0].id).changes, 1, 'your own can go');
    d.exec('ROLLBACK TO probe'); d.exec('RELEASE probe');
  } finally { d.close(); }
});

test('nicknames: a self-assignable role can’t sit above a Manage Nicknames role, so nobody picks their way out of its reach', async () => {
  const { owner, mod, member, server, modRole } = await club();
  // A cosmetic role, made after Mod: the owner's new roles go on top.
  const gamer = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Gamer', permissions: 0 })).json;
  let r = await as(owner, 'PATCH', `/roles/${gamer.id}`, { selfAssign: true });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /sits above "Mod"/);
  // Below Mod it can be marked and picked, and the moderator still reaches the member.
  const order = (ids) => as(owner, 'POST', `/servers/${server.id}/roles/order`, { ids });
  assert.equal((await order([modRole.id, gamer.id])).status, 200);
  assert.equal((await as(owner, 'PATCH', `/roles/${gamer.id}`, { selfAssign: true })).status, 200);
  assert.equal((await as(member, 'POST', `/servers/${server.id}/me/roles/${gamer.id}`)).status, 200);
  assert.equal((await setNick(member, server.id, member.id, 'Impersonating Owner')).status, 200);
  assert.equal((await as(mod, 'DELETE', `/servers/${server.id}/members/${member.id}/nickname`)).status, 200);
  // Moved above Mod later: it says why it can't be picked, and picking is refused.
  assert.equal((await as(member, 'DELETE', `/servers/${server.id}/me/roles/${gamer.id}`)).status, 200);
  assert.equal((await order([gamer.id, modRole.id])).status, 200);
  assert.match((await view(member, server.id)).roleDefs.find((x) => x.id === gamer.id).selfAssignIssue || '', /sits above "Mod"/);
  assert.equal((await as(member, 'POST', `/servers/${server.id}/me/roles/${gamer.id}`)).status, 403);
});

test('nicknames: once an account is deleted, the audit log no longer shows the names it went by', async () => {
  const { owner, mod, member, other, server } = await club();
  assert.equal((await setNick(member, server.id, member.id, 'Jane Q Realname')).status, 200);
  assert.equal((await setNick(mod, server.id, member.id, 'Jane Q Tidied')).status, 200);
  assert.equal((await setNick(other, server.id, other.id, 'Still here')).status, 200);
  const r = await as(member, 'DELETE', '/me', { authKey: member.authKey, confirm: member.username });
  assert.equal(r.status, 200, r.text);
  const log = await audit(owner, server.id);
  const theirs = log.entries.filter((e) => e.targetId === member.id);
  assert.equal(theirs.length, 2, 'the entries stay');
  for (const e of theirs) {
    assert.equal(e.detail.erased, true);
    assert.equal('from' in e.detail || 'to' in e.detail, false);
  }
  assert.equal(JSON.stringify(log).includes('Jane Q'), false);
  assert.equal(theirs.find((e) => e.actorId === member.id).detail.self, true);
  // Other people's entries are as they were.
  assert.equal(log.entries.find((e) => e.targetId === other.id).detail.to, 'Still here');
});

test('nicknames: leaving takes it away, and coming back starts without one', async () => {
  const { owner, member, server } = await club();
  assert.equal((await setNick(member, server.id, member.id, 'Leaving soon')).status, 200);
  const so = await sock(owner);
  const removed = next(so, 'member:remove', (x) => x.serverId === server.id && x.userId === member.id);
  assert.equal((await as(member, 'POST', `/servers/${server.id}/leave`)).status, 200);
  assert.ok(await removed);
  assert.deepEqual((await view(owner, server.id)).nicknames, {});
  const code = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json.code;
  assert.equal((await as(member, 'POST', `/invites/${code}/join`)).status, 200);
  assert.equal(stored(server.id, member.id), null);
  assert.deepEqual((await view(member, server.id)).nicknames, {});
});

test('nicknames: instance staff resetting a profile remove its nicknames everywhere, and say so in each log', async () => {
  const { owner, member, other, server } = await club();
  assert.equal((await setNick(member, server.id, member.id, 'Rude name')).status, 200);
  const so = await sock(other);
  const live = next(so, 'member:nick', (x) => x.serverId === server.id && x.userId === member.id);
  assert.equal((await as(srv.owner, 'POST', `/admin/users/${member.id}/reset-profile`)).status, 200);
  assert.deepEqual(await live, { serverId: server.id, userId: member.id, nickname: null });
  assert.equal(stored(server.id, member.id), null);
  const e = (await audit(owner, server.id)).entries[0];
  assert.equal(e.actorId, null);
  assert.equal(e.detail.staff, true);
  assert.equal(e.detail.from, 'Rude name');
});

test('nicknames: a member reported from inside the server carries the nickname they had there', async () => {
  const { member, other, server } = await club();
  assert.equal((await setNick(other, server.id, other.id, 'Shown name')).status, 200);
  const r = await as(member, 'POST', '/reports', { category: 'harassment', targetId: other.id, details: 'Their name', context: { kind: 'user', serverId: server.id } });
  assert.equal(r.status, 200, r.text);
  const ctx = JSON.parse(srv.sql('SELECT context FROM reports WHERE id = ?', r.json.id)[0].context);
  assert.equal(ctx.targetNickname, 'Shown name');
  // From a server they don't share it isn't added (and nothing says who is where).
  const elsewhere = await as(member, 'POST', '/reports', { category: 'harassment', targetId: other.id, details: 'x', context: { kind: 'user', serverId: 'nope' } });
  assert.equal(JSON.parse(srv.sql('SELECT context FROM reports WHERE id = ?', elsewhere.json.id)[0].context).targetNickname, undefined);
});

test('nicknames: too many changes in a minute are refused', async () => {
  const { owner, member, server } = await club();
  // The owner renaming someone (your own have a lower limit, above): 20 a minute.
  let last = null; let n = 0;
  for (; n < 25 && (!last || last.status === 200); n++) last = await setNick(owner, server.id, member.id, `Spin ${n}`);
  assert.equal(last.status, 429);
  assert.equal(n, 21);
});

test('nicknames: servers from before this version get Change Nickname for everyone once, as they upgrade', async () => {
  const { owner, member, server } = await club();
  // As a server from v18 would be: no nickname permission anywhere.
  const everyone = srv.sql('SELECT permissions FROM roles WHERE id = ?', server.id)[0].permissions;
  srv.sql('UPDATE roles SET permissions = ? WHERE id = ?', everyone & ~P.CHANGE_NICKNAME, server.id);
  const d = srv.db(); try { d.pragma('user_version = 18'); } finally { d.close(); }
  await srv.restart();
  assert.equal(srv.sql('SELECT permissions FROM roles WHERE id = ?', server.id)[0].permissions & P.CHANGE_NICKNAME, P.CHANGE_NICKNAME);
  assert.equal(srv.db().pragma('user_version', { simple: true }), 19);
  // Once upgraded, a server that turns it off keeps it off across restarts.
  assert.equal((await as(owner, 'PATCH', `/roles/${server.id}`, { permissions: everyone & ~P.CHANGE_NICKNAME })).status, 200);
  await srv.restart();
  assert.equal(srv.sql('SELECT permissions FROM roles WHERE id = ?', server.id)[0].permissions & P.CHANGE_NICKNAME, 0);
  assert.equal((await setNick(member, server.id, member.id, 'Still off')).status, 403);
});
