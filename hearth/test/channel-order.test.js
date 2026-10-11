// Channel and category order (server/channelorder.js): dragging channels and categories in the sidebar, and Move up /
// Move down in their menus, send the whole list as the person sees it. Reordering, moving a channel into another
// category, live updates and the server's audit log; refusals without Manage Channels (server-wide, or in the
// channel, or in a category's channels); what a moderator can't see or can't manage keeping its place without
// giving anything away; validation and limits.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, hex } = require('./helpers');
const ORDER = require('../server/channelorder');

const P = { VIEW: 1, SEND: 2, MANAGE_CHANNELS: 1 << 11, MANAGE_ROLES: 1 << 12, MANAGE_SERVER: 1 << 13 };
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
const last = (sid, action) => { const e = srv.sql('SELECT * FROM server_audit WHERE server_id = ? AND action = ? ORDER BY id DESC LIMIT 1', sid, action)[0]; return e && { ...e, detail: JSON.parse(e.detail) }; };
const count = (sid, action) => srv.sql('SELECT COUNT(*) AS n FROM server_audit WHERE server_id = ? AND action = ?', sid, action)[0].n;

before(async () => { srv = await startServer(); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

// An owner, a moderator (a role with Manage Channels) and a member, in a server laid out as
//   Text: general rules news chat     Voice: Lounge
async function setup() {
  const owner = await srv.register(); const mod = await srv.register(); const member = await srv.register();
  const server = (await as(owner, 'POST', '/servers', { name: 'Order ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const u of [mod, member]) assert.equal((await as(u, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const role = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Keepers', permissions: P.VIEW | P.SEND | P.MANAGE_CHANNELS })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${mod.id}/roles`, { roleIds: [role] })).status, 200);
  const mk = async (name, extra = {}) => { const r = await as(owner, 'POST', `/servers/${server.id}/channels`, { name, ...extra }); assert.equal(r.status, 200, r.text); return r.json; };
  const ch = { general: server.channels.find((c) => c.type === 'text'), lounge: server.channels.find((c) => c.type === 'voice') };
  for (const n of ['rules', 'news', 'chat']) ch[n] = await mk(n);
  return { owner, mod, member, server, role, ch, mk };
}
const view = async (u, sid) => (await as(u, 'GET', '/bootstrap')).json.servers.find((s) => s.id === sid);
// The sidebar as the apps draw it (orderedCategories in app.js): "Category: channel channel".
const catOf = (c) => c.category || (c.type === 'voice' ? 'Voice' : 'Text');
function layout(s) {
  const chans = [...s.channels].sort((a, b) => a.position - b.position);
  const seen = [];
  chans.forEach((c) => { if (!seen.includes(catOf(c))) seen.push(catOf(c)); });
  const order = (s.categoryOrder || []).filter((k) => seen.includes(k));
  return [...order, ...seen.filter((k) => !order.includes(k))].map((k) => `${k}: ${chans.filter((c) => catOf(c) === k).map((c) => c.name).join(' ')}`);
}
// Sends a layout like the app does after a drag: [[category, [channel names]], …] from u's own view of the server.
async function arrange(u, sid, spec) {
  const s = await view(u, sid);
  const byName = new Map(s.channels.map((c) => [c.name, c]));
  const ids = []; const categories = {};
  for (const [cat, names] of spec) for (const n of names) { const c = byName.get(n); ids.push(c.id); if (catOf(c) !== cat) categories[c.id] = cat; }
  return as(u, 'POST', `/servers/${sid}/channel-order`, { ids, categories: Object.keys(categories).length ? categories : undefined });
}
// A per-channel deny for a role, set by the owner.
const deny = (c, ch, roleId, bits) => as(c.owner, 'PUT', `/channels/${ch.id}/overrides`, { overrides: [{ type: 'role', id: roleId, allow: 0, deny: bits }] });
// What the apps send as `from`: [[category, [channel ids top to bottom]], …] in u's own view.
function shown(s) {
  const chans = [...s.channels].sort((a, b) => a.position - b.position);
  const cats = [...new Set(chans.map(catOf))];
  return cats.map((k) => [k, chans.filter((c) => catOf(c) === k).map((c) => c.id)]);
}
const catsShown = (s) => layout(s).map((x) => x.slice(0, x.indexOf(':')));

// ------------------------------------------------------------------ the happy path
test('channel order: reorder in a category, move a channel into another; members see it live; the audit log says what moved', async () => {
  const c = await setup();
  const sid = c.server.id;
  const sm = await sock(c.member);
  let update = next(sm, 'server:update', (s) => s.id === sid);
  const r = await arrange(c.owner, sid, [['Text', ['news', 'general', 'rules', 'chat']], ['Voice', ['Lounge']]]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.moved, 1, 'dragging #news up past two channels is one move');
  const got = await update;
  assert.ok(got, 'open apps get the new order at once');
  assert.deepEqual(layout(got), ['Text: news general rules chat', 'Voice: Lounge']);
  assert.deepEqual(layout(await view(c.member, sid)), ['Text: news general rules chat', 'Voice: Lounge']);
  const e = last(sid, 'channel_reorder');
  assert.equal(e.actor_id, c.owner.id);
  assert.equal(e.target_id, c.ch.news.id);
  assert.equal(e.detail.count, 1);
  assert.equal(e.detail.channel.name, 'news', 'one channel moved: the entry names it');

  // Into another category: its parent changes, for everyone; the entry is a channel change like Edit channel's.
  const reorders = count(sid, 'channel_reorder');
  update = next(sm, 'server:update', (s) => s.id === sid);
  const m = await arrange(c.owner, sid, [['Text', ['news', 'general', 'rules']], ['Voice', ['Lounge', 'chat']]]);
  assert.equal(m.status, 200, m.text);
  assert.equal(srv.sql('SELECT category FROM channels WHERE id = ?', c.ch.chat.id)[0].category, 'Voice');
  assert.deepEqual(layout(await update), ['Text: news general rules', 'Voice: Lounge chat']);
  const u = last(sid, 'channel_update');
  assert.equal(u.target_id, c.ch.chat.id);
  assert.deepEqual(u.detail.changes, { category: { from: 'Text', to: 'Voice' } });
  assert.equal(count(sid, 'channel_reorder'), reorders, 'moving into a category isn’t also written as a reorder');
  // What the log shows its readers.
  const readerView = await as(c.owner, 'GET', `/servers/${sid}/audit?action=channel_update`);
  assert.equal(readerView.json.entries[0].detail.changes.category.to, 'Voice');

  // A bigger reorder says how many moved, without names.
  const big = await arrange(c.owner, sid, [['Text', ['rules', 'general', 'news']], ['Voice', ['chat', 'Lounge']]]);
  assert.equal(big.status, 200, big.text);
  const b = last(sid, 'channel_reorder');
  assert.equal(b.detail.count, 3, 'two in Text (the third kept its place), one in Voice');
  assert.equal(b.detail.channel, undefined);

  // The same list again changes nothing: no update, no entry.
  const entries = srv.sql('SELECT COUNT(*) AS n FROM server_audit WHERE server_id = ?', sid)[0].n;
  update = next(sm, 'server:update', (s) => s.id === sid, 700);
  const same = await arrange(c.owner, sid, [['Text', ['rules', 'general', 'news']], ['Voice', ['chat', 'Lounge']]]);
  assert.equal(same.status, 200);
  assert.equal(same.json.moved, 0);
  assert.equal(await update, null);
  assert.equal(srv.sql('SELECT COUNT(*) AS n FROM server_audit WHERE server_id = ?', sid)[0].n, entries);

  // A moderator with Manage Channels can do it too, and the category order (dragging a category) works the same way.
  update = next(sm, 'server:update', (s) => s.id === sid);
  const cats = await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Voice', 'Text'] });
  assert.equal(cats.status, 200, cats.text);
  assert.deepEqual(layout(await update), ['Voice: chat Lounge', 'Text: rules general news']);
  assert.equal(last(sid, 'category_reorder').actor_id, c.mod.id);
  const mv = await arrange(c.mod, sid, [['Voice', ['chat', 'Lounge', 'general']], ['Text', ['rules', 'news']]]);
  assert.equal(mv.status, 200, mv.text);
  assert.deepEqual(layout(await view(c.member, sid)), ['Voice: chat Lounge general', 'Text: rules news']);
});

test('channel order: moving the last channel out of a category empties it; older channels without a category count as Text or Voice', async () => {
  const c = await setup();
  const sid = c.server.id;
  srv.sql("UPDATE channels SET category = '' WHERE server_id = ?", sid); // as written before categories existed
  const lone = await c.mk('lonely', { category: 'Corner' });
  assert.deepEqual(layout(await view(c.owner, sid)), ['Text: general rules news chat', 'Voice: Lounge', 'Corner: lonely']);
  const r = await arrange(c.owner, sid, [['Text', ['general', 'lonely', 'rules', 'news', 'chat']], ['Voice', ['Lounge']], ['Corner', []]]);
  assert.equal(r.status, 200, r.text);
  assert.equal(srv.sql('SELECT category FROM channels WHERE id = ?', lone.id)[0].category, 'Text');
  assert.equal(srv.sql('SELECT category FROM channels WHERE id = ?', c.ch.rules.id)[0].category, '', 'channels that stay where they were aren’t rewritten');
  assert.deepEqual(layout(await view(c.member, sid)), ['Text: general lonely rules news chat', 'Voice: Lounge']);
});

// ------------------------------------------------------------------ refusals
test('channel order: needs Manage Channels; outsiders are told there is no such server; group members can’t reorder a group', async () => {
  const c = await setup();
  const sid = c.server.id;
  const before = layout(await view(c.owner, sid));
  const outsider = await srv.register();
  const no = await arrange(c.member, sid, [['Text', ['chat', 'general', 'rules', 'news']], ['Voice', ['Lounge']]]);
  assert.equal(no.status, 403);
  assert.match(no.json.error, /Manage Channels/);
  const ids = (await view(c.owner, sid)).channels.map((x) => x.id);
  assert.equal((await as(outsider, 'POST', `/servers/${sid}/channel-order`, { ids })).status, 404);
  assert.equal((await srv.api('POST', `/servers/${sid}/channel-order`, { body: { ids } })).status, 401);
  const cats = await as(c.member, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Voice', 'Text'] });
  assert.equal(cats.status, 403);
  assert.match(cats.json.error, /Manage Channels/);
  assert.equal((await as(outsider, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Voice', 'Text'] })).status, 404);

  // Manage Server alone doesn't reorder categories, even alongside a change it does allow (and then nothing is saved).
  const srvRole = (await as(c.owner, 'POST', `/servers/${sid}/roles`, { name: 'Settings', permissions: P.VIEW | P.MANAGE_SERVER })).json.id;
  assert.equal((await as(c.owner, 'PUT', `/servers/${sid}/members/${c.member.id}/roles`, { roleIds: [srvRole] })).status, 200);
  const mixed = await as(c.member, 'PATCH', `/servers/${sid}`, { name: 'Renamed', categoryOrder: ['Voice', 'Text'] });
  assert.equal(mixed.status, 403);
  assert.match(mixed.json.error, /Manage Channels/);
  assert.equal(srv.sql('SELECT name FROM servers WHERE id = ?', sid)[0].name, c.server.name, 'the whole change is refused');
  assert.equal((await as(c.member, 'PATCH', `/servers/${sid}`, { description: 'still works' })).status, 200);
  assert.deepEqual(layout(await view(c.owner, sid)), before, 'nothing moved');

  // Group chats: only their owner arranges them.
  const friend = await srv.register();
  await as(c.owner, 'POST', '/friends', { username: friend.username });
  await as(friend, 'POST', `/friends/${c.owner.id}/accept`);
  const group = (await as(c.owner, 'POST', '/groups', { userIds: [friend.id] })).json;
  const g = await as(friend, 'PATCH', `/servers/${group.id}`, { categoryOrder: ['Voice', 'Text'] });
  assert.equal(g.status, 403);
  assert.equal((await as(friend, 'POST', `/servers/${group.id}/channel-order`, { ids: (await view(friend, group.id)).channels.map((x) => x.id).reverse() })).status, 403);
  assert.equal((await as(friend, 'PATCH', `/servers/${group.id}`, { name: 'Still renamable' })).status, 200, 'anyone in a group still renames it');
  assert.equal((await as(c.owner, 'PATCH', `/servers/${group.id}`, { categoryOrder: ['Voice', 'Text'] })).status, 200);
});

test('channel order: a channel where Manage Channels is denied keeps its category and its order among such channels; the rest move around it', async () => {
  const c = await setup();
  const sid = c.server.id;
  for (const ch of [c.ch.rules, c.ch.news]) assert.equal((await deny(c, ch, c.role, P.MANAGE_CHANNELS)).status, 200);
  const mine = await view(c.mod, sid);
  assert.equal(mine.channels.find((x) => x.id === c.ch.rules.id).perms & P.MANAGE_CHANNELS, 0, 'the app knows it can’t move #rules');

  const into = await arrange(c.mod, sid, [['Text', ['general', 'news', 'chat']], ['Voice', ['Lounge', 'rules']]]);
  assert.equal(into.status, 403);
  assert.match(into.json.error, /#rules/);
  const swap = await arrange(c.mod, sid, [['Text', ['general', 'news', 'rules', 'chat']], ['Voice', ['Lounge']]]);
  assert.equal(swap.status, 403, 'two channels the moderator can’t manage can’t trade places');
  assert.match(swap.json.error, /Manage Channels/);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Text: general rules news chat', 'Voice: Lounge'], 'nothing moved');

  // Channels they manage go anywhere, around those two.
  const around = await arrange(c.mod, sid, [['Text', ['chat', 'rules', 'news', 'general']], ['Voice', ['Lounge']]]);
  assert.equal(around.status, 200, around.text);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Text: chat rules news general', 'Voice: Lounge']);
  const out = await arrange(c.mod, sid, [['Text', ['rules', 'news', 'general']], ['Voice', ['chat', 'Lounge']]]);
  assert.equal(out.status, 200, out.text);
  // Edit channel refuses them too, as before.
  assert.equal((await as(c.mod, 'PATCH', `/channels/${c.ch.rules.id}`, { category: 'Voice' })).status, 403);

  // Categories: one holding a channel they can't manage keeps its order among such categories.
  const faq = await c.mk('faq', { category: 'Info' });
  assert.equal((await deny(c, faq, c.role, P.MANAGE_CHANNELS)).status, 200);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Text: rules news general', 'Voice: chat Lounge', 'Info: faq']);
  const cswap = await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Info', 'Voice', 'Text'] });
  assert.equal(cswap.status, 403);
  assert.match(cswap.json.error, /category “Info”/);
  const cfine = await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Voice', 'Text', 'Info'] });
  assert.equal(cfine.status, 200, 'Voice (all theirs) moves around the other two');
  assert.deepEqual(layout(await view(c.owner, sid)), ['Voice: chat Lounge', 'Text: rules news general', 'Info: faq']);
  // The owner can do anything.
  assert.equal((await as(c.owner, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Info', 'Text', 'Voice'] })).status, 200);
  assert.equal((await arrange(c.owner, sid, [['Info', ['faq', 'rules']], ['Text', ['general', 'news']], ['Voice', ['chat', 'Lounge']]])).status, 200);
  // Categories are labels, not locks: a channel the moderator manages can still go into Info (as Edit channel allows).
  const join = await arrange(c.mod, sid, [['Info', ['faq', 'general', 'rules']], ['Text', ['news']], ['Voice', ['chat', 'Lounge']]]);
  assert.equal(join.status, 200, join.text);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Info: faq general rules', 'Text: news', 'Voice: chat Lounge']);
});

// ------------------------------------------------------------------ what a moderator can't see
test('channel order: hidden channels and categories keep their place, their ids are refused like made-up ones, and their names never show', async () => {
  const c = await setup();
  const sid = c.server.id;
  const secret = await c.mk('secret');
  assert.equal((await as(c.owner, 'PUT', `/channels/${secret.id}/overrides`, { overrides: [{ type: 'role', id: sid, allow: 0, deny: P.VIEW }] })).status, 200);
  // The owner puts #secret right after #general.
  assert.equal((await arrange(c.owner, sid, [['Text', ['general', 'secret', 'rules', 'news', 'chat']], ['Voice', ['Lounge']]])).status, 200);
  assert.ok(!(await view(c.mod, sid)).channels.some((x) => x.id === secret.id));

  // The moderator reorders what they see; #secret stays right after #general (wherever that went), not at the end.
  const r = await arrange(c.mod, sid, [['Text', ['rules', 'general', 'news', 'chat']], ['Voice', ['Lounge']]]);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Text: rules general secret news chat', 'Voice: Lounge']);
  assert.equal(srv.sql('SELECT category FROM channels WHERE id = ?', secret.id)[0].category, 'Text');
  // #general leaves: #secret follows the channel before it that's still there.
  assert.equal((await arrange(c.mod, sid, [['Text', ['rules', 'news', 'chat']], ['Voice', ['general', 'Lounge']]])).status, 200);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Text: rules secret news chat', 'Voice: general Lounge']);

  // A list with a hidden channel's id is refused exactly like one with an id that doesn't exist (or one left out).
  const seen = (await view(c.mod, sid)).channels.map((x) => x.id);
  const withHidden = await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: [...seen, secret.id] });
  const withMadeUp = await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: [...seen, 'x' + hex(8)] });
  const missing = await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: seen.slice(1) });
  assert.equal(withHidden.status, 400);
  assert.equal(withHidden.text, withMadeUp.text);
  assert.equal(withHidden.text, missing.text);
  const swapped = [...seen.filter((x) => x !== seen[0]), secret.id];
  assert.equal((await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: swapped })).text, withMadeUp.text);

  // Categories: one with only private channels isn't in the moderator's view, nor in what open apps get.
  const vault = await c.mk('vault', { category: 'Vault' });
  assert.equal((await as(c.owner, 'PUT', `/channels/${vault.id}/overrides`, { overrides: [{ type: 'role', id: sid, allow: 0, deny: P.VIEW }] })).status, 200);
  assert.equal((await as(c.owner, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Vault', 'Text', 'Voice'] })).status, 200);
  const sm = await sock(c.mod);
  const modView = await view(c.mod, sid);
  assert.deepEqual(modView.categoryOrder, ['Text', 'Voice'], 'the name of a category of private channels doesn’t reach people who can’t see it');
  const update = next(sm, 'server:update', (s) => s.id === sid);
  // Moving into it is refused like moving into a category that doesn't exist.
  const intoHidden = await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: modView.channels.sort((a, b) => a.position - b.position).map((x) => x.id), categories: { [c.ch.chat.id]: 'Vault' } });
  const intoNowhere = await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: modView.channels.map((x) => x.id), categories: { [c.ch.chat.id]: 'Nowhere' } });
  assert.equal(intoHidden.status, 400);
  assert.equal(intoHidden.text, intoNowhere.text);
  // Reordering the categories they see leaves Vault first; naming it changes nothing either.
  assert.equal((await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Voice', 'Vault', 'Text'] })).status, 200);
  const got = await update;
  assert.ok(got && !got.categoryOrder.includes('Vault'), 'live updates leave it out too');
  assert.deepEqual(JSON.parse(srv.sql('SELECT category_order FROM servers WHERE id = ?', sid)[0].category_order), ['Vault', 'Voice', 'Text']);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Vault: vault', 'Voice: general Lounge', 'Text: rules secret news chat']);
  assert.deepEqual(last(sid, 'category_reorder').detail, {}, 'no category names in the entry');
});

// ------------------------------------------------------------------ two people (or two devices) at once
test('channel order: a list built on an older layout is refused instead of quietly undoing someone else’s move', async () => {
  const c = await setup();
  const sid = c.server.id;
  // The moderator's app shows Text: general rules news chat (a menu opened on it, say)…
  const seen = await view(c.mod, sid);
  const from = shown(seen);
  const fromCats = catsShown(seen);
  const byName = (n) => seen.channels.find((x) => x.name === n).id;
  // …while the owner moves #chat to the top.
  assert.equal((await arrange(c.owner, sid, [['Text', ['chat', 'general', 'rules', 'news']], ['Voice', ['Lounge']]])).status, 200);
  // The moderator's Move down on #rules, built on what they saw, would put #chat back at the bottom: refused.
  const stale = await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: ['general', 'news', 'rules', 'chat', 'Lounge'].map(byName), from });
  assert.equal(stale.status, 400);
  assert.match(stale.json.error, /changed in the meantime/);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Text: chat general rules news', 'Voice: Lounge'], 'the owner’s move stands');
  // Built on the layout as it is now, it goes through.
  const fresh = await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: ['chat', 'general', 'news', 'rules', 'Lounge'].map(byName), from: shown(await view(c.mod, sid)) });
  assert.equal(fresh.status, 200, fresh.text);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Text: chat general news rules', 'Voice: Lounge']);
  // A channel that changed category in the meantime counts too (the flat order alone wouldn't show it).
  const before = shown(await view(c.mod, sid));
  assert.equal((await arrange(c.owner, sid, [['Text', ['chat', 'general', 'news']], ['Voice', ['rules', 'Lounge']]])).status, 200);
  const moved = await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: ['general', 'chat', 'news', 'rules', 'Lounge'].map(byName), from: before });
  assert.equal(moved.status, 400);
  assert.deepEqual(layout(await view(c.owner, sid)), ['Text: chat general news', 'Voice: rules Lounge']);

  // Categories: the same with the order the app showed.
  assert.deepEqual(fromCats, ['Text', 'Voice']);
  assert.equal((await as(c.owner, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Voice', 'Text'] })).status, 200);
  const staleCats = await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Text', 'Voice'], categoryOrderFrom: fromCats });
  assert.equal(staleCats.status, 400);
  assert.match(staleCats.json.error, /changed in the meantime/);
  assert.deepEqual(catsShown(await view(c.owner, sid)), ['Voice', 'Text']);
  // categoryOrderFrom rides along with categoryOrder, so Manage Channels is still all it takes.
  const fine = await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Text', 'Voice'], categoryOrderFrom: ['Voice', 'Text'] });
  assert.equal(fine.status, 200, fine.text);
  assert.deepEqual(catsShown(await view(c.owner, sid)), ['Text', 'Voice']);

  // Malformed ones are refused before anything else.
  const ids = shown(await view(c.mod, sid)).flatMap(([, list]) => list);
  for (const bad of ['Text', [['Text']], [[7, []]], [['Text', 'abc']], [['Text', [7]]], [['x'.repeat(65), []]], Array.from({ length: ids.length + 1 }, () => ['Text', []]),
    [['Text', [...ids, ...ids]]]]) {
    const r = await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids, from: bad });
    assert.equal(r.status, 400, `${JSON.stringify(bad).slice(0, 60)} → ${r.status} ${r.text}`);
    assert.match(r.json.error, /Send the channels in order/);
  }
  for (const bad of ['Text', [7], Array.from({ length: 501 }, () => 'k'), ['x'.repeat(65)]]) {
    assert.equal((await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Text', 'Voice'], categoryOrderFrom: bad })).status, 400);
  }
});

test('channel order: a hidden channel in `from` is refused like a made-up one; positions are places among the channels each member sees', async () => {
  const c = await setup();
  const sid = c.server.id;
  const secret = await c.mk('secret');
  const staff = [await c.mk('staff-1', { category: 'Staff' }), await c.mk('staff-2', { category: 'Staff' })];
  for (const x of [secret, ...staff]) assert.equal((await as(c.owner, 'PUT', `/channels/${x.id}/overrides`, { overrides: [{ type: 'role', id: sid, allow: 0, deny: P.VIEW }] })).status, 200);
  // The owner puts #secret after #general and Staff between Text and Voice.
  assert.equal((await arrange(c.owner, sid, [['Text', ['general', 'secret', 'rules', 'news', 'chat']], ['Staff', ['staff-1', 'staff-2']], ['Voice', ['Lounge']]])).status, 200);
  assert.equal((await as(c.owner, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Text', 'Staff', 'Voice'] })).status, 200);
  const mine = await view(c.member, sid);
  const pos = Object.fromEntries(mine.channels.map((x) => [x.name, x.position]));
  assert.deepEqual(pos, { general: 0, rules: 1, news: 2, chat: 3, Lounge: 4 }, 'no gaps where private channels are');
  assert.deepEqual(mine.categoryOrder, ['Text', 'Voice']);
  const owners = (await view(c.owner, sid)).channels.map((x) => x.position);
  assert.deepEqual(owners, owners.map((_, i) => i), 'the owner sees every channel, numbered the same way');

  const ids = shown(await view(c.mod, sid)).flatMap(([, list]) => list);
  const send = (from) => as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids, from });
  const real = shown(await view(c.mod, sid));
  // #secret (or a made-up id) said to be where #rules is.
  const withHidden = await send(real.map(([k, list]) => [k, k === 'Text' ? [list[0], secret.id, ...list.slice(2)] : list]));
  const withMadeUp = await send(real.map(([k, list]) => [k, k === 'Text' ? [list[0], 'x' + hex(8), ...list.slice(2)] : list]));
  // Lounge said to be in the hidden Staff category, or in one that doesn't exist.
  const hiddenCat = await send(real.map(([k, list]) => [k === 'Voice' ? 'Staff' : k, list]));
  const madeUpCat = await send(real.map(([k, list]) => [k === 'Voice' ? 'Nowhere' : k, list]));
  assert.equal(withHidden.status, 400);
  assert.equal(withHidden.text, withMadeUp.text);
  assert.match(withHidden.json.error, /changed in the meantime/);
  assert.equal(hiddenCat.text, madeUpCat.text);
  assert.match(hiddenCat.json.error, /changed in the meantime/);
  assert.equal((await send(real)).status, 200, 'the real one is fine');
  const hiddenOrder = await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Voice', 'Text'], categoryOrderFrom: ['Text', 'Staff', 'Voice'] });
  const madeUpOrder = await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Voice', 'Text'], categoryOrderFrom: ['Text', 'Nowhere', 'Voice'] });
  assert.equal(hiddenOrder.status, 400);
  assert.equal(hiddenOrder.text, madeUpOrder.text);
});

// ------------------------------------------------------------------ renaming a category
test('channel order: renaming a category takes what moving its channels takes', async () => {
  const c = await setup();
  const sid = c.server.id;
  const rename = (u, from, to) => as(u, 'POST', `/servers/${sid}/categories/rename`, { from, to });
  const where = (ch) => srv.sql('SELECT category FROM channels WHERE id = ?', ch.id)[0].category;
  const renames = () => count(sid, 'category_rename');

  // Manage Channels denied in #rules: the moderator can't put it in another category this way either.
  assert.equal((await deny(c, c.ch.rules, c.role, P.MANAGE_CHANNELS)).status, 200);
  const archive = await c.mk('old', { category: 'Archive' });
  const merge = await rename(c.mod, 'Text', 'Archive');
  assert.equal(merge.status, 403);
  assert.match(merge.json.error, /category “Text”/);
  const plain = await rename(c.mod, 'Text', 'Chat');
  assert.equal(plain.status, 403, 'nor rename the category it’s in');
  assert.equal(where(c.ch.rules), 'Text');
  assert.equal(where(c.ch.general), 'Text');
  assert.equal(renames(), 0);
  // The owner can.
  assert.equal((await rename(c.owner, 'Text', 'Chat')).status, 200);
  assert.equal(where(c.ch.rules), 'Chat');
  assert.equal((await rename(c.owner, 'Chat', 'Text')).status, 200);
  assert.equal((await as(c.owner, 'PUT', `/channels/${c.ch.rules.id}/overrides`, { overrides: [] })).status, 200);

  // A category the moderator sees no channel of is answered like a name that doesn't exist, and nothing moves.
  const notes = await c.mk('staff-notes', { category: 'Staff' });
  assert.equal((await as(c.owner, 'PUT', `/channels/${notes.id}/overrides`, { overrides: [{ type: 'role', id: sid, allow: 0, deny: P.VIEW }] })).status, 200);
  const hidden = await rename(c.mod, 'Staff', 'Text');
  const madeUp = await rename(c.mod, 'Nope', 'Text');
  assert.equal(hidden.status, 400);
  assert.equal(hidden.text, madeUp.text);
  assert.equal((await rename(c.mod, 'Staff', 'Staff')).text, madeUp.text, 'even renaming it to itself');
  assert.equal(where(notes), 'Staff');
  assert.equal(renames(), 2, 'refusals and made-up names write nothing to the audit log');

  // A channel they can't see in a category they rename: it keeps its category (the category is renamed with it)…
  const secret = await c.mk('secret');
  assert.equal((await as(c.owner, 'PUT', `/channels/${secret.id}/overrides`, { overrides: [{ type: 'role', id: sid, allow: 0, deny: P.VIEW }] })).status, 200);
  const sm = await sock(c.member);
  const update = next(sm, 'server:update', (x) => x.id === sid);
  const ok = await rename(c.mod, 'Text', 'Chat');
  assert.equal(ok.status, 200, ok.text);
  assert.ok(await update, 'open apps get it at once');
  assert.equal(where(secret), 'Chat');
  assert.equal(where(c.ch.general), 'Chat');
  assert.deepEqual(last(sid, 'category_rename').detail, { from: 'Text', to: 'Chat' });
  // …but merging that category into another one would move the hidden channel, so that's refused.
  const into = await rename(c.mod, 'Chat', 'Archive');
  assert.equal(into.status, 403);
  assert.equal(where(secret), 'Chat');
  assert.equal(where(c.ch.general), 'Chat');

  // Merging a category whose channels they all see and manage works, and the one merged into keeps its place.
  const faq = await c.mk('faq', { category: 'Info' });
  assert.equal((await as(c.owner, 'PATCH', `/servers/${sid}`, { categoryOrder: ['Archive', 'Chat', 'Voice', 'Info'] })).status, 200);
  const m = await rename(c.mod, 'Info', 'Archive');
  assert.equal(m.status, 200, m.text);
  assert.equal(where(faq), 'Archive');
  assert.equal(where(archive), 'Archive');
  assert.deepEqual(layout(await view(c.owner, sid)), ['Archive: old faq', 'Chat: general rules news chat secret', 'Voice: Lounge', 'Staff: staff-notes']);

  // Validation, and the limit it shares with reordering (each rename goes out to every member's app).
  for (const body of [{}, { from: 'Chat' }, { from: 'Chat', to: '   ' }, { from: ['Chat'], to: 'X' }, { from: 'Chat', to: { $gt: '' } }]) {
    const r = await as(c.owner, 'POST', `/servers/${sid}/categories/rename`, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status} ${r.text}`);
  }
  assert.equal((await as(c.member, 'POST', `/servers/${sid}/categories/rename`, { from: 'Chat', to: 'Lobby' })).status, 403);
  let limited = null;
  for (let i = 0; i < 40 && limited === null; i++) {
    const r = await rename(c.mod, i % 2 ? 'Lobby' : 'Voice', i % 2 ? 'Voice' : 'Lobby');
    if (r.status === 429) limited = i; else assert.equal(r.status, 200, r.text);
  }
  assert.ok(limited !== null && limited < 30, `renames are limited (${limited})`);
  const ids = shown(await view(c.mod, sid)).flatMap(([, list]) => list);
  assert.equal((await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids })).status, 429, 'together with reordering');
});

// ------------------------------------------------------------------ validation and limits
test('channel order: malformed lists are refused; names are cleaned like everywhere else; 30 changes a minute per person', async () => {
  const c = await setup();
  const sid = c.server.id;
  const s = await view(c.owner, sid);
  const ids = s.channels.sort((a, b) => a.position - b.position).map((x) => x.id);
  const post = (body) => as(c.owner, 'POST', `/servers/${sid}/channel-order`, body);
  for (const body of [{}, { ids: 'nope' }, { ids: [] }, { ids: [...ids, ids[0]] }, { ids: ids.map((x, i) => (i ? x : 42)) },
    { ids: [...ids.slice(1), 'a'.repeat(65)] }, { ids: Array.from({ length: 1001 }, (_, i) => 'c' + i) },
    { ids, categories: [] }, { ids, categories: 'Voice' }, { ids, categories: { [ids[0]]: '' } }, { ids, categories: { [ids[0]]: 7 } },
    { ids, categories: { [ids[0]]: '   ' } }, { ids, categories: { nope: 'Voice' } }, { ids, categories: { ['__proto__']: 'Voice' } }]) {
    const r = await post(body);
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)} → ${r.status} ${r.text}`);
  }
  const patch = (categoryOrder) => as(c.owner, 'PATCH', `/servers/${sid}`, { categoryOrder });
  assert.equal((await patch('Voice,Text')).status, 400);
  assert.equal((await patch(Array.from({ length: 501 }, (_, i) => 'k' + i))).status, 400);
  assert.equal((await patch([{ $gt: '' }, '<b>Voice</b>', 'Voice'])).status, 200, 'unknown names are left out');
  assert.deepEqual(layout(await view(c.owner, sid)), ['Voice: Lounge', 'Text: general rules news chat']);
  // Category names are trimmed and cut like Edit channel's.
  const r = await post({ ids, categories: { [c.ch.chat.id]: '  Voice  ' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(srv.sql('SELECT category FROM channels WHERE id = ?', c.ch.chat.id)[0].category, 'Voice');
  assert.deepEqual(srv.sql('SELECT name FROM channels WHERE server_id = ? ORDER BY position', sid).length, 5, 'nothing made or lost');

  // Each change goes out to every member's app, so one person gets 30 a minute (both kinds together).
  let limited = null;
  for (let i = 0; i < 40 && limited === null; i++) {
    const x = i % 2 ? await as(c.mod, 'PATCH', `/servers/${sid}`, { categoryOrder: i % 4 === 1 ? ['Text', 'Voice'] : ['Voice', 'Text'] })
      : await as(c.mod, 'POST', `/servers/${sid}/channel-order`, { ids: i % 4 ? ids : [...ids].reverse() });
    if (x.status === 429) limited = i;
    else assert.equal(x.status, 200, x.text);
  }
  assert.equal(limited, 30, 'the 31st change in a minute waits');
  assert.equal((await patch(['Text', 'Voice'])).status, 200, 'someone else isn’t held up');
});

// ------------------------------------------------------------------ the rules themselves
test('channel order: what counts as moved, and where hidden channels go', () => {
  assert.deepEqual(ORDER.movedItems(['a', 'b', 'c', 'd'], ['b', 'c', 'a', 'd']), ['a'], 'one dragged down past two');
  assert.deepEqual(ORDER.movedItems(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c']), ['d']);
  assert.deepEqual(ORDER.movedItems(['a', 'b', 'c'], ['a', 'b', 'c']), []);
  assert.deepEqual(ORDER.movedItems([], []), []);
  assert.equal(ORDER.movedItems(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']).length, 3);
  assert.deepEqual(ORDER.categoriesInOrder([{ category: 'B' }, { category: '', type: 'voice' }, { category: 'A' }], ['A', 'Gone', 'A', 7]), ['A', 'B', 'Voice']);
  assert.deepEqual(ORDER.parseOrder('{"x":1}'), []);
  assert.deepEqual(ORDER.parseOrder('not json'), []);

  const ch = (id, category, position) => ({ id, name: id, type: 'text', category, position });
  const channels = [ch('h0', 'T', 0), ch('a', 'T', 1), ch('h1', 'T', 2), ch('h2', 'T', 3), ch('b', 'T', 4), ch('v', 'V', 5)];
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const plan = ORDER.planChannels({ channels, stored: [], ids: ['b', 'a', 'v'], moves: new Map(), seen: new Set(['a', 'b', 'v']), managed: new Set(['a', 'b', 'v']), fail });
  const final = new Map(plan.updates.map((u) => [u.c.id, u.position]));
  const pos = (id) => (final.has(id) ? final.get(id) : channels.find((x) => x.id === id).position);
  assert.deepEqual(['h0', 'a', 'h1', 'h2', 'b', 'v'].sort((x, y) => pos(x) - pos(y)), ['h0', 'b', 'a', 'h1', 'h2', 'v'],
    'hidden ones stay together after the channel they followed (or at the top)');
  assert.throws(() => ORDER.planChannels({ channels, stored: [], ids: ['a', 'b'], moves: new Map(), seen: new Set(['a', 'b', 'v']), managed: new Set(), fail }), { status: 400 });
});
