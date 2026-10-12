// Release audit (1.29.0), server side: regression tests for what it found.
//   authz-1  a role members pick themselves could sit above a Manage Messages / Mute Members / Move Members
//            moderator, so anyone could pick their way out of that moderator's reach
//   authz-2  a Manage Channels holder could confirm the names and places of private categories, and move, merge or
//            rename channels into a category they can't see
//   abuse-1  RSVPs had no limit of their own, and each one made every open app in the server fetch the events again
//   abuse-2  webhook "per network" limits went by the exact address, so rotating IPv6 addresses inside a /64 got
//            around them
//   abuse-3  a few accounts could use up the instance-wide Discord-import ceiling and lock everyone else out
// and from the review of those fixes:
//   - Create channel with no category (or the app's default, Text) where Text holds only channels the caller can't
//     see: the default falls back to a category they see, a typed one gets a clear refusal
//   - a member given Manage Messages or Move Members by an override of their own keeps pickable roles below them
//   - a role picked yourself doesn't change who can manage a webhook (the one role-order check outside REACH)
//   - the instance-wide import ceiling bounds the server's time however many accounts ask, and is still shared
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, hex, sleep } = require('./helpers');

const P = { VIEW: 1, SEND: 2, MANAGE_MESSAGES: 32, CONNECT: 64, SPEAK: 128, MANAGE_CHANNELS: 1 << 11, MUTE: 1 << 17, MOVE: 1 << 18 };
// Where a category name is typed, naming one of channels the caller can't see gets this (a made-up name is accepted).
const CLOSED = 'You can’t add channels to that category. Pick one from the list or type a different name.';
let srv;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const ack = (s, ev, p) => new Promise((r) => { const t = setTimeout(() => r(null), 5000); s.emit(ev, p, (x) => { clearTimeout(t); r(x); }); });
const view = async (u, sid) => (await as(u, 'GET', '/bootstrap')).json.servers.find((s) => s.id === sid);
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');

before(async () => { srv = await startServer(); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

// A server with an owner and `n` more members (all joined).
async function community(n) {
  const owner = await srv.register();
  const people = [];
  for (let i = 0; i < n; i++) people.push(await srv.register());
  const server = (await as(owner, 'POST', '/servers', { name: 'Audit ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const u of people) assert.equal((await as(u, 'POST', `/invites/${invite.code}/join`)).status, 200);
  srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', server.id);
  return { owner, people, server, text: server.channels.find((c) => c.type === 'text'), voice: server.channels.find((c) => c.type === 'voice') };
}
const order = (c, ids) => as(c.owner, 'POST', `/servers/${c.server.id}/roles/order`, { ids });
const issueOf = async (u, sid, rid) => (await view(u, sid)).roleDefs.find((x) => x.id === rid).selfAssignIssue || '';

// ------------------------------------------------------------------ authz-1
test('authz-1: a pickable role can’t sit above a Manage Messages / Mute / Move moderator, who keeps reaching members who pick one', async () => {
  const c = await community(3);
  const [mod, troll, reporter] = c.people;
  const sid = c.server.id;
  // A moderator with only the new toolkit's powers (no Kick, Ban, Manage Roles or Manage Nicknames).
  const vm = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'VoiceMod', permissions: P.VIEW | P.SEND | P.MANAGE_MESSAGES | P.CONNECT | P.SPEAK | P.MUTE | P.MOVE })).json.id;
  assert.equal((await as(c.owner, 'PUT', `/servers/${sid}/members/${mod.id}/roles`, { add: [vm] })).status, 200);
  // A cosmetic role made afterwards lands above it: it can't be offered to members there.
  const blue = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'Blue', permissions: 0 })).json.id;
  let r = await as(c.owner, 'PATCH', `/roles/${blue}`, { selfAssign: true });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /sits above "VoiceMod"/);
  // Below VoiceMod it can be marked and picked; moved above later, it can't be picked any more (dropping still works).
  assert.equal((await order(c, [vm, blue])).status, 200);
  assert.equal((await as(c.owner, 'PATCH', `/roles/${blue}`, { selfAssign: true })).status, 200);
  assert.equal((await order(c, [blue, vm])).status, 200);
  assert.match(await issueOf(troll, sid, blue), /sits above "VoiceMod"/);
  r = await as(troll, 'POST', `/servers/${sid}/me/roles/${blue}`);
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'self_assign');
  assert.equal(srv.sql('SELECT COUNT(*) AS n FROM member_roles WHERE server_id = ? AND user_id = ?', sid, troll.id)[0].n, 0);

  // Where it can be picked, the moderator still reaches someone who picked it: mute, move, disconnect, bulk delete
  // and the report inbox all go by role order.
  assert.equal((await order(c, [vm, blue])).status, 200);
  const v2 = (await as(c.owner, 'POST', `/servers/${sid}/channels`, { name: 'v2', type: 'voice' })).json;
  const st = await sock(troll);
  assert.equal((await ack(st, 'voice:join', { channelId: c.voice.id })).ok, true);
  assert.equal((await as(troll, 'POST', `/servers/${sid}/me/roles/${blue}`)).status, 200);
  r = await as(mod, 'POST', `/servers/${sid}/voice/${troll.id}/mute`);
  assert.equal(r.status, 200, r.text);
  assert.equal((await as(mod, 'DELETE', `/servers/${sid}/voice/${troll.id}/mute`)).status, 200);
  r = await as(mod, 'POST', `/servers/${sid}/voice/${troll.id}/move`, { channelId: v2.id });
  assert.equal(r.status, 200, r.text);
  assert.equal((await ack(st, 'voice:join', { channelId: v2.id })).ok, true);
  r = await as(mod, 'POST', `/servers/${sid}/voice/${troll.id}/disconnect`);
  assert.equal(r.status, 200, r.text);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await as(troll, 'POST', `/channels/${c.text.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json.id);
  r = await as(reporter, 'POST', '/reports', { category: 'spam', context: { kind: 'message', messageId: ids[0] }, evidence: [{ id: ids[0], text: 'x' }] });
  assert.equal(r.status, 200, r.text);
  const inbox = await as(mod, 'GET', `/servers/${sid}/reports`);
  assert.equal(inbox.status, 200, inbox.text);
  assert.equal(inbox.json.reports.length, 1, 'the report reaches the moderator');
  r = await as(mod, 'POST', `/channels/${c.text.id}/messages/bulk-delete`, { ids: ids.slice(1) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deleted, 2);
  assert.ok(!r.json.kept, 'nothing kept back');
});

test('authz-1: Manage Messages or Move Members given in one channel keep pickable roles below that moderator too', async () => {
  const c = await community(2);
  const [helper, member] = c.people;
  const sid = c.server.id;
  // A role with no server-wide powers, allowed Manage Messages in #general only, at the bottom of the list.
  const helpers = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'Helpers', permissions: 0 })).json.id;
  const pink = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'Pink', permissions: 0 })).json.id;
  assert.equal((await order(c, [pink, helpers])).status, 200);
  assert.equal((await as(c.owner, 'PATCH', `/roles/${pink}`, { selfAssign: true })).status, 200, 'nothing reaches by role order yet');
  assert.equal((await as(c.owner, 'PUT', `/servers/${sid}/members/${helper.id}/roles`, { add: [helpers] })).status, 200);
  let r = await as(c.owner, 'PUT', `/channels/${c.text.id}/overrides`, { overrides: [{ type: 'role', id: helpers, allow: P.MANAGE_MESSAGES, deny: 0 }] });
  assert.equal(r.status, 200, r.text);
  assert.match(await issueOf(member, sid, pink), /sits above "Helpers"/);
  r = await as(member, 'POST', `/servers/${sid}/me/roles/${pink}`);
  assert.equal(r.status, 403, r.text);
  // A new role can't be marked above it either.
  const green = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'Green', permissions: 0 })).json.id;
  r = await as(c.owner, 'PATCH', `/roles/${green}`, { selfAssign: true });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /sits above "Helpers"/);
  // The same for Move Members in a voice channel.
  assert.equal((await as(c.owner, 'PUT', `/channels/${c.text.id}/overrides`, { overrides: [] })).status, 200);
  assert.equal(await issueOf(member, sid, pink), '');
  r = await as(c.owner, 'PUT', `/channels/${c.voice.id}/overrides`, { overrides: [{ type: 'role', id: helpers, allow: P.MOVE, deny: 0 }] });
  assert.equal(r.status, 200, r.text);
  assert.match(await issueOf(member, sid, pink), /sits above "Helpers"/);
  // Below the helpers, picking works and their bulk delete in #general still reaches the member.
  assert.equal((await as(c.owner, 'PUT', `/channels/${c.text.id}/overrides`, { overrides: [{ type: 'role', id: helpers, allow: P.MANAGE_MESSAGES, deny: 0 }] })).status, 200);
  assert.equal((await order(c, [green, helpers, pink])).status, 200);
  assert.equal(await issueOf(member, sid, pink), '');
  assert.equal((await as(member, 'POST', `/servers/${sid}/me/roles/${pink}`)).status, 200);
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await as(member, 'POST', `/channels/${c.text.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json.id);
  r = await as(helper, 'POST', `/channels/${c.text.id}/messages/bulk-delete`, { ids });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deleted, 2);
});

test('authz-1 (review): a moderator given Manage Messages by an override of their own keeps pickable roles below their highest role', async () => {
  const c = await community(2);
  const [mod, member] = c.people;
  const sid = c.server.id;
  // The moderator's only role has no powers; an override for them alone allows Manage Messages in #general.
  const helper = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'Helper', permissions: 0 })).json.id;
  const gamer = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'gamer', permissions: 0 })).json.id;
  assert.equal((await order(c, [gamer, helper])).status, 200);
  assert.equal((await as(c.owner, 'PUT', `/servers/${sid}/members/${mod.id}/roles`, { add: [helper] })).status, 200);
  let r = await as(c.owner, 'PUT', `/channels/${c.text.id}/overrides`, { overrides: [{ type: 'member', id: mod.id, allow: P.MANAGE_MESSAGES, deny: 0 }] });
  assert.equal(r.status, 200, r.text);
  // gamer sits above Helper: anyone who picked it would be out of the moderator's reach, so it can't be marked.
  r = await as(c.owner, 'PATCH', `/roles/${gamer}`, { selfAssign: true });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /sits above "Helper", the highest role of someone who moderates a channel/);
  // Nor can Helper itself: picking it would put people level with the moderator.
  r = await as(c.owner, 'PATCH', `/roles/${helper}`, { selfAssign: true });
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /highest role of someone who moderates a channel/);
  // Below Helper it can be, and the moderator still reaches someone who picked it.
  assert.equal((await order(c, [helper, gamer])).status, 200);
  assert.equal((await as(c.owner, 'PATCH', `/roles/${gamer}`, { selfAssign: true })).status, 200);
  assert.equal((await as(member, 'POST', `/servers/${sid}/me/roles/${gamer}`)).status, 200);
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await as(member, 'POST', `/channels/${c.text.id}/messages`, { ciphertext: cipher(), epoch: 1 })).json.id);
  r = await as(mod, 'POST', `/channels/${c.text.id}/messages/bulk-delete`, { ids });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deleted, 2);
  assert.ok(!r.json.kept);
  // Moved above Helper later, it can't be picked any more.
  assert.equal((await order(c, [gamer, helper])).status, 200);
  assert.match(await issueOf(member, sid, gamer), /sits above "Helper"/);
  assert.equal((await as(member, 'DELETE', `/servers/${sid}/me/roles/${gamer}`)).status, 200);
  assert.equal((await as(member, 'POST', `/servers/${sid}/me/roles/${gamer}`)).status, 403);
  // A moderator whose highest role is @everyone reaches nobody, so they keep nothing below them.
  assert.equal((await as(c.owner, 'PUT', `/servers/${sid}/members/${mod.id}/roles`, { remove: [helper] })).status, 200);
  assert.equal(await issueOf(member, sid, gamer), '');
});

test('authz-1 (review): a role picked yourself doesn’t change who can manage a webhook, on either side', async () => {
  const c = await community(2);
  const [holder, chanMod] = c.people;
  const sid = c.server.id;
  const mk = async (name, permissions) => (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name, permissions })).json.id;
  const hookMaker = await mk('HookMaker', P.VIEW | P.SEND | P.MANAGE_CHANNELS);
  const chanMods = await mk('ChanMod', P.VIEW | P.SEND | P.MANAGE_CHANNELS);
  const gamer = await mk('gamer', 0);
  assert.equal((await order(c, [gamer, chanMods, hookMaker])).status, 200);
  assert.equal((await as(c.owner, 'PUT', `/servers/${sid}/members/${holder.id}/roles`, { add: [hookMaker] })).status, 200);
  assert.equal((await as(c.owner, 'PUT', `/servers/${sid}/members/${chanMod.id}/roles`, { add: [chanMods] })).status, 200);
  // Manage Channels isn't a power that reaches by role order, so gamer can be offered above both.
  assert.equal((await as(c.owner, 'PATCH', `/roles/${gamer}`, { selfAssign: true })).status, 200);
  const hooks = `/channels/${c.text.id}/webhooks`;
  const make = async (u, name) => { const r = await as(u, 'POST', hooks, { name }); assert.equal(r.status, 200, r.text); return r.json.webhook.id; };
  const canChange = async (u, id) => (await as(u, 'GET', hooks)).json.webhooks.find((w) => w.id === id).canChange;

  // The holder (below ChanMod) picks gamer: ChanMod can still rename and delete their webhook.
  const one = await make(holder, 'One');
  assert.equal(await canChange(chanMod, one), true);
  assert.equal((await as(holder, 'POST', `/servers/${sid}/me/roles/${gamer}`)).status, 200);
  assert.equal(await canChange(chanMod, one), true);
  let r = await as(chanMod, 'PATCH', `${hooks}/${one}`, { name: 'One renamed' });
  assert.equal(r.status, 200, r.text);
  r = await as(chanMod, 'DELETE', `${hooks}/${one}`);
  assert.equal(r.status, 200, r.text);
  assert.equal((await as(holder, 'DELETE', `/servers/${sid}/me/roles/${gamer}`)).status, 200);

  // The other way round: ChanMod below HookMaker can't change the holder's webhook, and picking gamer doesn't let them.
  assert.equal((await order(c, [gamer, hookMaker, chanMods])).status, 200);
  const two = await make(holder, 'Two');
  assert.equal(await canChange(chanMod, two), false);
  assert.equal((await as(chanMod, 'POST', `/servers/${sid}/me/roles/${gamer}`)).status, 200);
  assert.equal(await canChange(chanMod, two), false);
  r = await as(chanMod, 'DELETE', `${hooks}/${two}`);
  assert.equal(r.status, 403, r.text);
  r = await as(chanMod, 'POST', `${hooks}/${two}/token`);
  assert.equal(r.status, 403, r.text);
  // The owner still can.
  assert.equal((await as(c.owner, 'DELETE', `${hooks}/${two}`)).status, 200);
});

// ------------------------------------------------------------------ authz-2
// An owner, a moderator with Manage Channels, and a private category "Layoffs 2027" (two channels hidden from
// everyone but the owner) stored in the category order.
async function hiddenCategory() {
  const c = await community(1);
  const [mod] = c.people;
  const sid = c.server.id;
  const role = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'Keepers', permissions: P.VIEW | P.SEND | P.MANAGE_CHANNELS })).json.id;
  assert.equal((await as(c.owner, 'PUT', `/servers/${sid}/members/${mod.id}/roles`, { add: [role] })).status, 200);
  const hidden = [];
  for (const name of ['hr-a', 'hr-b']) {
    const ch = (await as(c.owner, 'POST', `/servers/${sid}/channels`, { name, type: 'text', category: 'Layoffs 2027' })).json;
    assert.equal((await as(c.owner, 'PUT', `/channels/${ch.id}/overrides`, { overrides: [{ type: 'role', id: sid, allow: 0, deny: P.VIEW }] })).status, 200);
    hidden.push(ch);
  }
  assert.equal((await as(c.owner, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Text', 'Layoffs 2027', 'Voice'] })).status, 200);
  return { ...c, mod, sid, hidden };
}
const catIn = (ch) => srv.sql('SELECT category FROM channels WHERE id = ?', ch.id)[0].category;

test('authz-2: Edit channel and Create channel can’t put a channel in a category the caller can’t see, or show where it is', async () => {
  const c = await hiddenCategory();
  const { mod, sid } = c;
  assert.deepEqual((await view(mod, sid)).categoryOrder, ['Text', 'Voice']);
  const probe = (await as(mod, 'POST', `/servers/${sid}/channels`, { name: 'probe', type: 'text', category: 'Zprobe' })).json;
  // A drag into a category that doesn't exist: the answer every refusal below has to match.
  const modView = await view(mod, sid);
  const nowhere = await as(mod, 'POST', `/servers/${sid}/channel-order`, { ids: modView.channels.sort((a, b) => a.position - b.position).map((x) => x.id), categories: { [probe.id]: 'Nowhere' } });
  assert.equal(nowhere.status, 400);
  // Edit channel: the hidden category is refused, and nothing moves. (A drag answers it like a made-up name; a typed
  // name gets a clear refusal, since a made-up one would be accepted.)
  let r = await as(mod, 'PATCH', `/channels/${probe.id}`, { category: 'Layoffs 2027' });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, CLOSED);
  const drag = await as(mod, 'POST', `/servers/${sid}/channel-order`, { ids: modView.channels.sort((a, b) => a.position - b.position).map((x) => x.id), categories: { [probe.id]: 'Layoffs 2027' } });
  assert.equal(drag.text, nowhere.text);
  assert.equal(catIn(probe), 'Zprobe');
  assert.deepEqual((await view(mod, sid)).categoryOrder, ['Text', 'Voice'], 'its name and place never show');
  // Create channel: the same, and nothing is made.
  const before = srv.sql('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', sid)[0].n;
  r = await as(mod, 'POST', `/servers/${sid}/channels`, { name: 'probe2', type: 'text', category: 'Layoffs 2027' });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, CLOSED);
  assert.equal(srv.sql('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', sid)[0].n, before);
  // A made-up name still makes a new category, at the end of the moderator's list.
  r = await as(mod, 'PATCH', `/channels/${probe.id}`, { category: 'Layoffs 2026' });
  assert.equal(r.status, 200, r.text);
  assert.equal(catIn(probe), 'Layoffs 2026');
  assert.deepEqual((await view(mod, sid)).categoryOrder, ['Text', 'Voice']);
  // A category they see a channel of is fine even with hidden channels in it (Text holds a private one now).
  const secret = (await as(c.owner, 'POST', `/servers/${sid}/channels`, { name: 'secret', type: 'text', category: 'Text' })).json;
  assert.equal((await as(c.owner, 'PUT', `/channels/${secret.id}/overrides`, { overrides: [{ type: 'role', id: sid, allow: 0, deny: P.VIEW }] })).status, 200);
  assert.equal((await as(mod, 'PATCH', `/channels/${probe.id}`, { category: 'Text' })).status, 200);
  assert.equal(catIn(probe), 'Text');
  // The owner, who sees it, can still use it.
  assert.equal((await as(c.owner, 'PATCH', `/channels/${probe.id}`, { category: 'Layoffs 2027' })).status, 200);
  assert.equal(catIn(probe), 'Layoffs 2027');
  for (const ch of c.hidden) assert.equal(catIn(ch), 'Layoffs 2027');
});

test('authz-2: Rename category never merges into or renames a category the caller can’t see', async () => {
  const c = await hiddenCategory();
  const { mod, sid } = c;
  const rename = (from, to) => as(mod, 'POST', `/servers/${sid}/categories/rename`, { from, to });
  const probe = (await as(mod, 'POST', `/servers/${sid}/channels`, { name: 'probe', type: 'text', category: 'Zp' })).json;
  // The moderator's own reorder stores every category, the hidden one included.
  const v = await view(mod, sid);
  assert.equal((await as(mod, 'PATCH', `/servers/${sid}`, { categoryOrder: [...v.categoryOrder].reverse() })).status, 200);
  const unknown = await rename('Nope', 'Text');
  assert.equal(unknown.status, 400);
  // Merging the probe's category into the hidden one is refused; nothing moves.
  const merge = await rename('Zp', 'Layoffs 2027');
  assert.equal(merge.status, 400, merge.text);
  assert.match(merge.json.error, /can’t add channels to that category, so you can’t rename this one to it/);
  assert.equal(catIn(probe), 'Zp');
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM server_audit WHERE server_id = ? AND action = 'category_rename'", sid)[0].n, 0);
  // Renaming the hidden category itself is answered the same way, and the private channels keep their category.
  assert.equal((await rename('Layoffs 2027', 'lol')).text, unknown.text);
  for (const ch of c.hidden) assert.equal(catIn(ch), 'Layoffs 2027');
  assert.ok(!(await view(mod, sid)).categoryOrder.includes('Layoffs 2027'));
  // An ordinary rename to a new name still works.
  assert.equal((await rename('Zp', 'Projects')).status, 200);
  assert.equal(catIn(probe), 'Projects');
});

test('authz-2: a new category name doesn’t take the place of a deleted category that had it', async () => {
  const c = await hiddenCategory();
  const { mod, sid } = c;
  // The owner deletes the private category's channels; its name stays in the stored order, first.
  assert.equal((await as(c.owner, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Layoffs 2027', 'Text', 'Voice'] })).status, 200);
  for (const ch of c.hidden) assert.equal((await as(c.owner, 'DELETE', `/channels/${ch.id}`)).status, 200);
  // Now it's a made-up name like any other: it doesn't come back at the top.
  const fresh = await as(mod, 'POST', `/servers/${sid}/channels`, { name: 'fresh', type: 'text', category: 'Layoffs 2027' });
  assert.equal(fresh.status, 200, fresh.text);
  assert.deepEqual((await view(mod, sid)).categoryOrder, ['Text', 'Voice']);
  assert.deepEqual((await view(c.owner, sid)).categoryOrder, ['Text', 'Voice']);
  // Nor does a rename onto a name left behind.
  assert.equal((await as(c.owner, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Text', 'Layoffs 2027', 'Voice'] })).status, 200);
  assert.equal((await as(c.owner, 'DELETE', `/channels/${fresh.json.id}`)).status, 200);
  const other = (await as(mod, 'POST', `/servers/${sid}/channels`, { name: 'other', type: 'text', category: 'Zz' })).json;
  assert.ok(other.id);
  assert.equal((await as(mod, 'POST', `/servers/${sid}/categories/rename`, { from: 'Zz', to: 'Layoffs 2027' })).status, 200);
  assert.deepEqual((await view(mod, sid)).categoryOrder, ['Text', 'Voice']);
});

test('authz-2 (review): Create channel with no category, where Text holds only channels the caller can’t see, uses one they see', async () => {
  const c = await community(1);
  const [mod] = c.people;
  const sid = c.server.id;
  const keepers = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'Keepers', permissions: P.VIEW | P.SEND | P.MANAGE_CHANNELS })).json.id;
  assert.equal((await as(c.owner, 'PUT', `/servers/${sid}/members/${mod.id}/roles`, { add: [keepers] })).status, 200);
  const lounge = (await as(c.owner, 'POST', `/servers/${sid}/channels`, { name: 'chat', type: 'text', category: 'Lounge' })).json;
  assert.equal(catIn(lounge), 'Lounge');
  // #general, the only channel in Text, is made private.
  assert.equal((await as(c.owner, 'PUT', `/channels/${c.text.id}/overrides`, { overrides: [{ type: 'role', id: sid, allow: 0, deny: P.VIEW }] })).status, 200);
  // Typed (the app used to fill in Text): a clear refusal, nothing made.
  let r = await as(mod, 'POST', `/servers/${sid}/channels`, { name: 'new-one', type: 'text', category: 'Text' });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, CLOSED);
  // None given: the first of the moderator's categories with a text channel.
  r = await as(mod, 'POST', `/servers/${sid}/channels`, { name: 'new-one', type: 'text' });
  assert.equal(r.status, 200, r.text);
  assert.equal(catIn(r.json), 'Lounge');
  // A voice channel's default, Voice, is one they see: it goes there as ever.
  r = await as(mod, 'POST', `/servers/${sid}/channels`, { name: 'Den', type: 'voice' });
  assert.equal(r.status, 200, r.text);
  assert.equal(catIn(r.json), 'Voice');
  assert.ok(!(await view(mod, sid)).categoryOrder.includes('Text'));
  // The owner, who sees #general, still gets Text by default.
  r = await as(c.owner, 'POST', `/servers/${sid}/channels`, { name: 'own', type: 'text' });
  assert.equal(r.status, 200, r.text);
  assert.equal(catIn(r.json), 'Text');
});

// ------------------------------------------------------------------ abuse-1
test('abuse-1: RSVPs are limited per account and per network, and a flood of them costs open apps a few fetches, not one each', async () => {
  const c = await community(3);
  const [a1, a2, victim] = c.people;
  const sid = c.server.id;
  const ev = (await as(a1, 'POST', `/servers/${sid}/events`, { title: 'X', startsAt: Date.now() + 86400000 })).json;
  assert.ok(ev.id, JSON.stringify(ev));
  const sv = await sock(victim);
  let updates = 0;
  sv.on('events:update', (p) => { if (p.serverId === sid) updates++; });
  await sleep(600); // past the event's own update
  updates = 0;
  // Two members toggle their answer as fast as they can.
  const flood = async (u, n) => {
    const st = { ok: 0, limited: 0 };
    await Promise.all(Array.from({ length: n }, async (_, k) => {
      const r = await as(u, 'POST', `/events/${ev.id}/rsvp`, { status: k % 2 ? 'going' : 'no' });
      if (r.status === 200) st.ok++; else if (r.status === 429) st.limited++;
    }));
    return st;
  };
  const [s1, s2] = await Promise.all([flood(a1, 40), flood(a2, 40)]);
  assert.equal(s1.ok, 15, JSON.stringify(s1));
  assert.equal(s1.limited, 25);
  assert.equal(s2.ok, 15, JSON.stringify(s2));
  await sleep(1500);
  assert.ok(updates >= 1, 'answers still reach open apps');
  assert.ok(updates <= 4, `the flood's updates are coalesced (${updates})`);
  // The victim's own allowance is untouched.
  assert.equal((await as(victim, 'GET', '/me/storage')).status, 200);
  assert.equal((await as(victim, 'GET', `/servers/${sid}/events`)).status, 200);
});

test('abuse-1: an answer that changes nothing tells nobody; many accounts on one network share a limit', async () => {
  const c = await community(6);
  const [host, ...rest] = c.people;
  const sid = c.server.id;
  const ev = (await as(host, 'POST', `/servers/${sid}/events`, { title: 'Y', startsAt: Date.now() + 86400000 })).json;
  const sh = await sock(host);
  let updates = 0;
  sh.on('events:update', (p) => { if (p.serverId === sid) updates++; });
  await sleep(600);
  updates = 0;
  const [u] = rest;
  assert.equal((await as(u, 'POST', `/events/${ev.id}/rsvp`, { status: 'maybe' })).status, 200);
  for (let i = 0; i < 40 && !updates; i++) await sleep(50);
  assert.equal(updates, 1, 'a change goes out at once');
  updates = 0;
  const same = await as(u, 'POST', `/events/${ev.id}/rsvp`, { status: 'maybe' });
  assert.equal(same.status, 200);
  assert.equal(same.json.mine, 'maybe');
  await sleep(1200);
  assert.equal(updates, 0, 'the same answer again sends nothing');
  // Five accounts on one network: 60 a minute between them, though each could send 15.
  const net = '203.0.113.77';
  let ok = 0; let limited = 0;
  for (const x of rest) {
    for (let i = 0; i < 13; i++) {
      const r = await srv.api('POST', `/events/${ev.id}/rsvp`, { token: x.token, ip: net, body: { status: i % 2 ? 'going' : 'no' } });
      if (r.status === 200) ok++; else if (r.status === 429) limited++;
    }
  }
  assert.equal(ok, 60);
  assert.equal(limited, 5);
});

// ------------------------------------------------------------------ abuse-2
test('abuse-2: wrong webhook addresses are limited per IPv6 /64, not per address', async () => {
  const bad = (ip, i) => srv.call('POST', `/api/webhooks/nope${i}/${'x'.repeat(43)}`, { ip, body: { content: 'hi' } });
  const seen = [];
  for (let i = 0; i < 35; i++) seen.push((await bad(`2001:db8:1:3::${(i + 1).toString(16)}`, i)).status);
  assert.deepEqual(seen.slice(0, 30), Array(30).fill(404), 'the first 30 wrong addresses get the usual answer');
  assert.ok(seen.slice(30).every((s) => s === 429), `then the whole /64 is refused (${seen.slice(30)})`);
  // Spelled differently (zeros written out), the same /64 is still the same network.
  assert.equal((await bad('2001:0db8:0001:0003:ffff::9', 99)).status, 429);
  // Another /64 has its own allowance.
  assert.equal((await bad('2001:db8:1:4::1', 100)).status, 404);
});

// ------------------------------------------------------------------ abuse-3
test('abuse-3: a few accounts can’t use up the instance-wide import ceiling and lock everyone else out', async () => {
  const nets = ['203.0.113.10', '203.0.113.20', '203.0.113.30'];
  const tpl = { serialized_source_guild: { name: 'G', roles: [{ id: 0, name: '@everyone', permissions: '0' }], channels: [{ id: 1, type: 0, name: 'general', position: 0, permission_overwrites: [] }] } };
  const counts = {};
  const attackers = [];
  for (let i = 0; i < 5; i++) { const u = await srv.register(); u.ip = nets[i % 3]; attackers.push(u); }
  for (const u of attackers) {
    for (let i = 0; i < 60; i++) {
      // Half junk, half real templates: neither lets them fill the instance's ceiling.
      const r = await as(u, 'POST', '/imports/discord/preview', i % 2 ? { junk: 1 } : { template: tpl });
      counts[r.status] = (counts[r.status] || 0) + 1;
    }
  }
  assert.deepEqual(counts, { 200: 150, 400: 150 });
  // Their own limits still hold.
  const more = await as(attackers[0], 'POST', '/imports/discord/preview', { template: tpl });
  assert.equal(more.status, 429);
  // Someone else on another network can still preview and import.
  const victim = await srv.register();
  const r = await as(victim, 'POST', '/imports/discord/preview', { template: tpl });
  assert.equal(r.status, 200, r.text);
  const made = await as(victim, 'POST', '/imports/discord', { template: tpl });
  assert.equal(made.status, 200, made.text);
});

test('abuse-3 (review): the instance-wide import ceiling bounds the server’s time however many accounts ask, and stays shared', async () => {
  // A server of its own, so the counts start at zero.
  const own = await startServer();
  try {
    const tpl = { serialized_source_guild: { name: 'G', roles: [{ id: 0, name: '@everyone', permissions: '0' }], channels: [{ id: 1, type: 0, name: 'general', position: 0, permission_overwrites: [] }] } };
    const preview = (u) => own.api('POST', '/imports/discord/preview', { token: u.token, ip: u.ip, body: { template: tpl } });
    // n previews from one account, ten at a time; their statuses in order.
    const run = async (u, n) => {
      const out = [];
      for (let i = 0; i < n; i += 10) out.push(...(await Promise.all(Array.from({ length: Math.min(10, n - i) }, () => preview(u)))).map((r) => r.status));
      return out;
    };
    let ok = 0;
    const tally = (st) => { assert.ok(st.every((x) => x === 200 || x === 429), st.join()); const n = st.filter((x) => x === 200).length; ok += n; return n; };
    // Nine accounts, each on its own network, ask for all 60 of theirs. Until 500 plans were made anyone gets them;
    // after that only an account that has had fewer than 20 this window does.
    const heavy = [];
    for (let i = 0; i < 9; i++) heavy.push(await own.register());
    for (const u of heavy.slice(0, 8)) assert.equal(tally(await run(u, 60)), 60);
    const ninth = await run(heavy[8], 60);
    assert.equal(tally(ninth), 20);
    assert.deepEqual(ninth.slice(20), Array(40).fill(429), 'past half the ceiling and its share, refused though its own 60 aren’t used up');
    assert.equal(ok, 500);
    // Someone else can still preview and import (each is a plan).
    const victim = await own.register();
    assert.equal((await preview(victim)).status, 200);
    const made = await own.api('POST', '/imports/discord', { token: victim.token, ip: victim.ip, body: { template: tpl } });
    assert.equal(made.status, 200, made.text);
    ok += 2;
    // Fresh accounts get their share each (20, the 21st refused) ...
    const first = await own.register();
    const st = await run(first, 21);
    assert.equal(tally(st), 20);
    assert.equal(st[20], 429);
    // ... until the ceiling itself: 1,000 plans in the window, however many accounts ask.
    for (let i = 0; i < 25; i++) tally(await run(await own.register(), 20));
    assert.equal(ok, 1000);
    const late = await own.register();
    const r = await preview(late);
    assert.equal(r.status, 429, r.text);
  } finally {
    await own.stop();
  }
});
