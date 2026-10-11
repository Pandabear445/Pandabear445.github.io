// Import from Discord, the routes (server/imports.js): paste a Discord server template, see what it would make and
// what won't come over, then create the server in one go. Checked against a real server: the result has to behave
// like the Discord server did (who can post where, who sees the private channel, who can speak on the stage), the
// importer owns it alone, and nothing is created by a preview, a bad template, a missing confirmation or a refusal.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, hex } = require('./helpers');
const { cleanChannelName } = require('../server/discordmap');
const { DEFAULT_EVERYONE, PERMS } = require('../server/perms');

const SAMPLE = require('./fixtures/discord-template.json');
const P = { VIEW: 1, SEND: 2, SPEAK: 128, ADMIN: 1 << 30 };
const cipher = () => 'v2:' + crypto.randomBytes(48).toString('base64');
const clone = (x) => JSON.parse(JSON.stringify(x));
let srv;
const socks = [];
const as = (u, method, p, body) => srv.api(method, p, { token: u.token, ip: u.ip, body });
const sock = async (u) => { const s = await srv.socket(u.token); socks.push(s); return s; };
const ack = (s, ev, p, ms = 5000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.emit(ev, p, (x) => { clearTimeout(t); r(x); }); });
const next = (s, ev, match = () => true, ms = 4000) => new Promise((r) => {
  const on = (x) => { if (!match(x)) return; clearTimeout(t); s.off(ev, on); r(x); };
  const t = setTimeout(() => { s.off(ev, on); r(null); }, ms);
  s.on(ev, on);
});
const count = (table) => srv.sql(`SELECT COUNT(*) n FROM ${table}`)[0].n;
const preview = (u, body) => as(u, 'POST', '/imports/discord/preview', body);
const create = (u, body) => as(u, 'POST', '/imports/discord', body);
const view = async (u, sid) => (await as(u, 'GET', '/bootstrap')).json.servers.find((s) => s.id === sid);

before(async () => { srv = await startServer(); });
after(async () => { socks.forEach((s) => s.close()); await srv.stop(); });

test('discord import: a preview returns the plan and the report, and creates nothing', async () => {
  const u = await srv.register();
  const before = ['servers', 'roles', 'channels', 'channel_overrides', 'server_imports'].map(count);
  const r = await preview(u, { template: SAMPLE });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.source, { kind: 'paste', template: true, code: 'hEaRtHtEsT01', name: 'Pinecone Club', usageCount: 3, updatedAt: '2026-10-01T09:12:45+00:00', isDirty: false });
  const plan = r.json.plan;
  assert.equal(plan.name, 'Pinecone Club');
  assert.equal(plan.everyone.permissions, DEFAULT_EVERYONE);
  assert.deepEqual(plan.report.counts, { roles: 6, categories: 4, channels: 11, overrides: 10, skipped: 1 });
  // The preview carries what the app shows: each channel's overrides are counted, not sent, and the
  // per-permission notes are only in the report.
  assert.ok(plan.channels.every((c) => Number.isInteger(c.overrides) && !c.notes.some((n) => n.includes(':'))));
  assert.equal(plan.channels.reduce((n, c) => n + c.overrides, 0), 10);
  assert.deepEqual(plan.channels.find((c) => c.name === 'announcements').notes, ['renamed', 'announcement']);
  // What won't come over is there before anything exists: permissions, channel kinds and settings.
  assert.ok(plan.report.lost.some((l) => l.bit === 'MANAGE_THREADS' && l.where.includes('Moderator')));
  // Nicknames come over (Change Nickname for @everyone, Manage Nicknames for the moderators), so they aren't listed.
  assert.ok(!plan.report.lost.some((l) => l.bit === 'MANAGE_NICKNAMES' || l.bit === 'CHANGE_NICKNAME'));
  assert.ok(plan.roles.find((x) => x.name === 'Moderator').permissions & PERMS.MANAGE_NICKNAMES);
  // View Audit Log comes over as each server's own audit log, so it isn't listed as lost.
  assert.ok(!plan.report.lost.some((l) => l.bit === 'VIEW_AUDIT_LOG'));
  assert.ok(plan.roles.find((x) => x.name === 'Moderator').permissions & PERMS.VIEW_AUDIT_LOG);
  assert.deepEqual(plan.report.dropped, [{ bit: 'CREATE_INSTANT_INVITE', where: ['mod-chat'] }]);
  assert.ok(plan.report.widened.some((w) => w.bit === 'READ_MESSAGE_HISTORY'));
  assert.deepEqual(plan.report.skipped, [{ kind: 'category', key: '50', name: 'Archive', reason: 'empty' }]);
  // Big numbers stay numbers the app can use (no BigInt leaks into JSON).
  assert.ok(plan.roles.every((x) => Number.isInteger(x.permissions)));
  assert.deepEqual(['servers', 'roles', 'channels', 'channel_overrides', 'server_imports'].map(count), before, 'nothing was created');
  // The bare serialized_source_guild gives the same plan, and a different name can be chosen.
  const bare = await preview(u, { template: SAMPLE.serialized_source_guild, name: 'Pine Club' });
  assert.equal(bare.status, 200);
  assert.equal(bare.json.plan.name, 'Pine Club');
  assert.deepEqual(bare.json.plan.channels, plan.channels);
  assert.equal(bare.json.source.template, false);
});

test('discord import: creates the server, roles, channels, overrides and category order in one go; the importer owns it alone', async () => {
  const u = await srv.register();
  const s = await sock(u);
  const added = next(s, 'server:add', (x) => x.server && x.server.name === 'Pinecone Club');
  const r = await create(u, { template: SAMPLE });
  assert.equal(r.status, 200, r.text);
  const server = r.json;
  assert.equal(server.ownerId, u.id);
  assert.deepEqual(server.memberIds, [u.id]);
  assert.equal(server.description, 'Hiking, photos and bad puns');
  assert.deepEqual(server.categoryOrder, ['Text', 'Information', 'Text Channels', 'Voice Channels']);
  assert.equal(server.keyState.keyEpoch, 0, 'a fresh server: its first key is made by the app, as for any new server');
  assert.equal(server.keyState.needsRotation, true);
  assert.ok(server.importId);
  assert.deepEqual(server.report.counts, { roles: 6, categories: 4, channels: 11, overrides: 10, skipped: 1 });
  // Roles: @everyone with the server's id, then the six in Discord's order.
  const roles = [...server.roleDefs].sort((a, b) => a.position - b.position);
  assert.deepEqual(roles.map((x) => [x.name, x.position, x.color, x.icon, x.hoist, x.mentionable]), [
    ['@everyone', 0, '', '', false, false], ['Muted', 1, '#95a5a6', '', false, false], ['Member', 2, '', '', false, false],
    ['Event Host', 3, '#2ecc71', '🎪', true, true], ['Builder', 4, '#f1c40f', '', false, false], ['Moderator', 5, '#3498db', '🛡️', true, true],
    ['Admin', 6, '#e74c3c', '', true, false],
  ]);
  assert.equal(roles[0].id, server.id);
  assert.equal(roles[0].permissions, DEFAULT_EVERYONE);
  assert.equal(roles.find((x) => x.name === 'Admin').permissions, P.ADMIN);
  // Channels in order, with types, categories, topics and slowmode.
  assert.deepEqual(server.channels.map((c) => [c.position, c.name, c.type, c.category]), [
    [0, 'welcome', 'text', 'Text'], [1, 'announcements', 'text', 'Information'], [2, 'rules', 'text', 'Information'],
    [3, 'general', 'text', 'Text Channels'], [4, 'trail-photos', 'text', 'Text Channels'], [5, 'mod-chat', 'text', 'Text Channels'],
    [6, 'help-forum', 'text', 'Text Channels'], [7, 'channel-8', 'text', 'Text Channels'],
    [8, 'Campfire', 'voice', 'Voice Channels'], [9, 'Town Hall', 'voice', 'Voice Channels'], [10, 'AFK', 'voice', 'Voice Channels'],
  ]);
  const byName = (n) => server.channels.find((c) => c.name === n);
  assert.equal(byName('trail-photos').slowmode, 30);
  assert.equal(byName('rules').topic, 'Be kind. No spoilers for trail reports.');
  const mod = roles.find((x) => x.name === 'Moderator');
  assert.deepEqual(byName('mod-chat').overrides.sort((a, b) => a.allow - b.allow), [
    { type: 'role', id: server.id, allow: 0, deny: P.VIEW }, { type: 'role', id: mod.id, allow: P.VIEW, deny: 0 },
  ]);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM channel_overrides o JOIN channels c ON c.id = o.channel_id WHERE c.server_id = ?', server.id)[0].n, 10);
  // The import is recorded, with a map from the template's keys to what was made, and audit-logged.
  const imp = srv.sql('SELECT * FROM server_imports WHERE id = ?', server.importId)[0];
  assert.equal(imp.server_id, server.id);
  assert.equal(imp.user_id, u.id);
  assert.equal(imp.kind, 'discord_template');
  assert.equal(imp.source, 'hEaRtHtEsT01');
  assert.equal(JSON.parse(imp.report).counts.channels, 11);
  assert.equal(srv.sql("SELECT COUNT(*) n FROM import_map WHERE import_id = ? AND kind = 'channel'", server.importId)[0].n, 11);
  assert.equal(srv.sql("SELECT target_id FROM import_map WHERE import_id = ? AND kind = 'role' AND source_id = '5'", server.importId)[0].target_id, mod.id);
  assert.match(srv.sql("SELECT detail FROM admin_log WHERE action = 'server_import' AND target = ?", server.id)[0].detail, /discord template hEaRtHtEsT01: 6 roles, 11 channels, 10 overrides, 1 skipped/);
  // The importer's open app got it live, like a server they just made.
  const ev = await added;
  assert.ok(ev, 'server:add reached the open app');
  assert.equal(ev.server.id, server.id);
  assert.ok((await as(u, 'GET', '/bootstrap')).json.servers.some((x) => x.id === server.id));
});

test('discord import: the new server behaves like the template — muted, read-only, private and stage channels', async () => {
  const owner = await srv.register(); const plain = await srv.register(); const muted = await srv.register(); const moderator = await srv.register();
  const builder = await srv.register();
  const server = (await create(owner, { template: SAMPLE, name: 'Behaves ' + hex(3) })).json;
  srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', server.id);
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const x of [plain, muted, moderator, builder]) assert.equal((await as(x, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const roleId = (n) => server.roleDefs.find((x) => x.name === n).id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${muted.id}/roles`, { roleIds: [roleId('Muted')] })).status, 200);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${moderator.id}/roles`, { roleIds: [roleId('Moderator')] })).status, 200);
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${builder.id}/roles`, { roleIds: [roleId('Builder')] })).status, 200);
  const chan = (n) => server.channels.find((c) => c.name === n).id;
  const post = (x, n) => as(x, 'POST', `/channels/${chan(n)}/messages`, { ciphertext: cipher(), epoch: 1 });
  assert.equal((await post(plain, 'general')).status, 200);
  assert.equal((await post(muted, 'general')).status, 403, 'Muted can\'t post in #general');
  assert.equal((await post(plain, 'rules')).status, 403, '#rules is read-only for @everyone');
  assert.equal((await post(plain, 'announcements')).status, 403);
  assert.equal((await post(moderator, 'announcements')).status, 200, 'Moderators may post announcements');
  // #mod-chat is private: only the Moderator role (and the owner) see it.
  const sees = async (x) => (await view(x, server.id)).channels.some((c) => c.name === 'mod-chat');
  assert.equal(await sees(plain), false);
  assert.equal(await sees(muted), false);
  assert.equal(await sees(moderator), true);
  assert.equal(await sees(owner), true);
  assert.equal((await as(plain, 'GET', `/channels/${chan('mod-chat')}/messages`)).status, 404);
  assert.equal((await as(moderator, 'GET', `/channels/${chan('mod-chat')}/messages`)).status, 200);
  // Town Hall is a stage: plain members join listen-only. Moderator (Mute Members) can speak, as on the Discord
  // stage; Builder (Manage Channels alone) couldn't speak there without being brought up, so can't here.
  const sp = await sock(plain); const sm = await sock(moderator); const sb = await sock(builder);
  const j1 = await ack(sp, 'voice:join', { channelId: chan('Town Hall') });
  assert.equal(j1.ok, true, JSON.stringify(j1));
  assert.equal(j1.canSpeak, false);
  const j2 = await ack(sm, 'voice:join', { channelId: chan('Town Hall') });
  assert.equal(j2.ok, true, JSON.stringify(j2));
  assert.equal(j2.canSpeak, true);
  const j5 = await ack(sb, 'voice:join', { channelId: chan('Town Hall') });
  assert.equal(j5.ok, true, JSON.stringify(j5));
  assert.equal(j5.canSpeak, false);
  await ack(sb, 'voice:leave', {});
  // In AFK @everyone can't speak (Discord denied it there); in Campfire everyone can.
  const j3 = await ack(sp, 'voice:join', { channelId: chan('AFK') });
  assert.equal(j3.ok, true, JSON.stringify(j3));
  assert.equal(j3.canSpeak, false);
  const j4 = await ack(sp, 'voice:join', { channelId: chan('Campfire') });
  assert.equal(j4.ok, true, JSON.stringify(j4));
  assert.equal(j4.canSpeak, true);
  await ack(sp, 'voice:leave', {});
  await ack(sm, 'voice:leave', {});
});

// Discord permission values from bit numbers.
const bits = (...n) => String(n.reduce((m, x) => m | (1n << BigInt(x)), 0n));
const DB = { INVITE: 0, KICK: 1, MANAGE_CHANNELS: 4, VIEW: 10, SEND: 11, CONNECT: 20, SPEAK: 21, MANAGE_ROLES: 28 };

test('discord import: what Hearth allows beyond Discord is in the preview, and is what the new server does', async () => {
  const owner = await srv.register(); const kicker = await srv.register(); const chanMgr = await srv.register(); const streamer = await srv.register(); const plain = await srv.register();
  const tpl = { serialized_source_guild: { name: 'Wider', roles: [
    { id: 0, name: '@everyone', permissions: bits(DB.VIEW, DB.SEND, DB.CONNECT, DB.SPEAK, DB.INVITE) },
    { id: 1, name: 'Streamer', permissions: '0' },
    { id: 2, name: 'Kicker', permissions: bits(DB.KICK) },
    { id: 3, name: 'ChanMgr', permissions: bits(DB.MANAGE_CHANNELS) },
  ], channels: [
    // Invites are off in every channel; Streamer may manage just this one.
    { id: 10, type: 0, name: 'stream-chat', position: 0, permission_overwrites: [
      { id: 0, type: 0, allow: '0', deny: bits(DB.INVITE) }, { id: 1, type: 0, allow: bits(DB.MANAGE_CHANNELS, DB.MANAGE_ROLES), deny: '0' }] },
    { id: 11, type: 0, name: 'memes', position: 1, permission_overwrites: [{ id: 0, type: 0, allow: '0', deny: bits(DB.INVITE) }] },
  ] } };
  const p = (await preview(owner, { template: tpl })).json.plan;
  const wide = Object.fromEntries(p.report.widened.map((w) => [w.bit, w.where]));
  assert.deepEqual(wide.MODERATE_MEMBERS, ['Kicker']);
  assert.deepEqual(wide.MANAGE_WEBHOOKS, ['ChanMgr']);
  assert.deepEqual(wide.MANAGE_EVENTS, ['ChanMgr']);
  assert.deepEqual(wide.CREATE_INSTANT_INVITE, ['stream-chat', 'memes']);
  assert.deepEqual(p.report.dropped.filter((x) => x.bit.startsWith('MANAGE_')), [{ bit: 'MANAGE_CHANNELS', where: ['stream-chat'] }, { bit: 'MANAGE_ROLES', where: ['stream-chat'] }]);
  // Created as previewed: the report wasn't exaggerating.
  const server = (await create(owner, { template: tpl })).json;
  srv.sql('UPDATE servers SET key_epoch = 1, needs_rotation = 0 WHERE id = ?', server.id);
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const x of [kicker, chanMgr, streamer, plain]) assert.equal((await as(x, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const give = async (u, n) => assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${u.id}/roles`, { roleIds: [server.roleDefs.find((x) => x.name === n).id] })).status, 200);
  await give(kicker, 'Kicker'); await give(chanMgr, 'ChanMgr'); await give(streamer, 'Streamer');
  const chan = server.channels.find((c) => c.name === 'stream-chat').id;
  assert.equal((await as(kicker, 'POST', `/servers/${server.id}/members/${plain.id}/timeout`, { minutes: 5 })).status, 200, 'Kick members times out in Hearth');
  assert.equal((await as(chanMgr, 'GET', `/channels/${chan}/webhooks`)).status, 200, 'Manage channels manages webhooks in Hearth');
  assert.equal((await as(plain, 'POST', `/servers/${server.id}/invites`, {})).status, 403, 'timed out: no invites');
  assert.equal((await as(streamer, 'POST', `/servers/${server.id}/invites`, {})).status, 200, 'invites are server-wide in Hearth');
  assert.equal((await as(streamer, 'PATCH', `/channels/${chan}`, { topic: 'x' })).status, 403, 'Manage channel in one channel only does less in Hearth');
});

test('discord import: over 5,000 channel permissions in all (stages count) is a problem to fix before creating', async () => {
  const u = await srv.register();
  const roles = [{ id: 0, name: '@everyone', permissions: bits(DB.VIEW, DB.CONNECT) }, ...Array.from({ length: 99 }, (_, i) => ({ id: i + 1, name: `host ${i}`, permissions: bits(22, DB.SPEAK) }))];
  const tpl = { roles, channels: Array.from({ length: 60 }, (_, i) => ({ id: 1000 + i, type: 13, name: `stage ${i}`, position: i })) };
  const before = count('servers');
  const p = await preview(u, { template: tpl });
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.plan.problems, [{ code: 'too_many_overrides', count: 6000, max: 5000 }]);
  assert.ok(JSON.stringify(p.json).length < 100 * 1024, 'the preview stays small');
  const r = await create(u, { template: tpl });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'too_many_overrides');
  assert.match(r.json.error, /6000 channel permissions/);
  assert.equal(count('servers'), before);
  // Leaving ten stages out makes it fit.
  const ok = await create(u, { template: tpl, name: 'Stages ' + hex(3), skipChannels: Array.from({ length: 10 }, (_, i) => String(1050 + i)) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.report.counts.overrides, 5000);
});

test('discord import: the report kept with the server is capped in size', async () => {
  const u = await srv.register();
  const tpl = { roles: [{ id: 0, name: '@everyone', permissions: bits(DB.VIEW) }], channels: [
    { id: 1, type: 0, name: 'general', position: 0 },
    ...Array.from({ length: 590 }, (_, i) => ({ id: 100 + i, type: 99, name: `${'n'.repeat(190)}${i}` })),
  ] };
  const r = await create(u, { template: tpl, name: 'Capped ' + hex(3) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.report.skipped.length, 590, 'the importer gets the whole list');
  const kept = srv.sql('SELECT report FROM server_imports WHERE id = ?', r.json.importId)[0].report;
  assert.ok(kept.length <= 128 * 1024, `${kept.length} bytes`);
  const report = JSON.parse(kept);
  assert.equal(report.skipped.length, 100);
  assert.equal(report.skippedMore, 490);
});

test('discord import: names end up exactly as Hearth\'s own channel route cleans them', async () => {
  const u = await srv.register();
  const names = ['📢・Announcements', 'Big News  Room!!', '公告', 'ok_name-1', '  spaced out  ', 'Ünïcödé'];
  const tpl = { roles: [{ id: 0, name: '@everyone', permissions: '1024' }], channels: names.map((n, i) => ({ id: 100 + i, type: 0, name: n, position: i })) };
  const made = (await create(u, { template: tpl, name: 'Names ' + hex(3) })).json;
  const own = (await as(u, 'POST', '/servers', { name: 'Own ' + hex(3) })).json;
  for (const [i, n] of names.entries()) {
    const expected = cleanChannelName(n, 'text') || `channel-${i + 1}`;
    assert.equal(made.channels[i].name, expected);
    const viaRoute = await as(u, 'POST', `/servers/${own.id}/channels`, { name: n, type: 'text' });
    if (cleanChannelName(n, 'text')) assert.equal(viaRoute.json.name, expected, n);
    else assert.equal(viaRoute.status, 400, 'Hearth refuses an empty name; the import numbers it instead');
  }
});

test('discord import: what was left out on purpose stays out', async () => {
  const u = await srv.register();
  const r = await create(u, { template: SAMPLE, name: 'Fewer ' + hex(3), skipRoles: ['5', 'nonsense', 7], skipChannels: ['30', '22'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.roleDefs.map((x) => x.name).sort(), ['@everyone', 'Admin', 'Builder', 'Event Host', 'Member', 'Muted']);
  assert.ok(!r.json.channels.some((c) => ['trail-photos', 'Campfire', 'Town Hall', 'AFK'].includes(c.name)));
  assert.deepEqual(r.json.categoryOrder, ['Text', 'Information', 'Text Channels']);
  // #mod-chat stays private, with no role let in (Moderator was left out); the owner still sees it.
  const mc = r.json.channels.find((c) => c.name === 'mod-chat');
  assert.deepEqual(mc.overrides, [{ type: 'role', id: r.json.id, allow: 0, deny: P.VIEW }]);
});

test('discord import: bad, oversized and malformed input is refused and creates nothing', async () => {
  const u = await srv.register();
  const before = count('servers');
  const cases = [
    [{}, 'bad_template'], [{ template: null }, 'bad_template'], [{ template: 'just text' }, 'bad_template'], [{ template: [SAMPLE] }, 'bad_template'],
    [{ template: { roles: [] } }, 'bad_template'], [{ template: { channels: [] } }, 'bad_template'],
    [{ template: { roles: [{ id: 0 }], channels: 'x' } }, 'bad_template'],
    [{ template: { roles: Array.from({ length: 301 }, (_, i) => ({ id: i })) } }, 'too_big'],
    [{ template: SAMPLE, name: '   ' }, 'bad_request'], [{ template: SAMPLE, name: 42 }, 'bad_request'],
    [{ template: SAMPLE, skipRoles: 'all' }, 'bad_request'], [{ template: SAMPLE, skipChannels: Array(601).fill('1') }, 'bad_request'],
  ];
  for (const [body, code] of cases) {
    const r = await create(u, body);
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 60)} → ${r.status} ${r.text}`);
    assert.equal(r.json.code, code, JSON.stringify(body).slice(0, 60));
  }
  // The preview refuses the same templates.
  for (const [body, code] of cases.filter(([b]) => b.template !== SAMPLE)) {
    const p = await preview(u, body);
    assert.equal(p.status, 400, `preview ${JSON.stringify(body).slice(0, 60)}`);
    assert.equal(p.json.code, code);
  }
  // Raw garbage, and a body over 2 MB (refused before the route runs).
  for (const raw of ['null', '[]', '"x"', '{"template": ']) assert.ok([400].includes((await srv.api('POST', '/imports/discord/preview', { token: u.token, ip: u.ip, raw })).status), raw);
  const big = await create(u, { template: { roles: [{ id: 0, name: 'x'.repeat(2.1 * 1024 * 1024) }] } });
  assert.equal(big.status, 413);
  assert.equal(big.json.code, 'too_large');
  assert.equal(count('servers'), before);
});

test('discord import: Hearth\'s limits — 99 roles, 50 categories, 500 channels', async () => {
  const u = await srv.register();
  const roles = [{ id: 0, name: '@everyone', permissions: '3072' }, ...Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: `r${i + 1}`, permissions: '0' }))];
  const many = (n, cats = 0) => ({ roles, channels: [
    ...Array.from({ length: cats }, (_, i) => ({ id: 5000 + i, type: 4, name: `cat ${i}`, position: i })),
    ...Array.from({ length: n }, (_, i) => ({ id: 10000 + i, type: 0, name: `c${i}`, position: i, parent_id: cats ? 5000 + (i % cats) : null })),
  ] });
  // Too many channels or categories: the preview says so; creating refuses until some are left out.
  let p = await preview(u, { template: many(501) });
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.plan.problems, [{ code: 'too_many_channels', count: 501, max: 500 }]);
  let r = await create(u, { template: many(501) });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'too_many_channels');
  r = await create(u, { template: many(51, 51) });
  assert.equal(r.json.code, 'too_many_categories');
  // 120 roles: the top 99 come over, which fills the server's 100 (with @everyone).
  r = await create(u, { template: many(500), name: 'Big ' + hex(3), skipChannels: [] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.roleDefs.length, 100);
  assert.equal(r.json.channels.length, 500);
  assert.equal(r.json.report.skipped.filter((x) => x.reason === 'limit').length, 21);
  assert.ok(!r.json.roleDefs.some((x) => x.name === 'r1'), 'the lowest roles stay behind');
  assert.equal((await as(u, 'POST', `/servers/${r.json.id}/roles`, { name: 'one more' })).status, 400, 'the server is at its role limit, as if made by hand');
});

test('discord import: @everyone as an Administrator needs a confirmation', async () => {
  const u = await srv.register();
  const tpl = clone(SAMPLE);
  tpl.serialized_source_guild.roles[0].permissions = '8';
  const p = await preview(u, { template: tpl });
  assert.equal(p.json.plan.everyone.dangerous, true);
  assert.ok(p.json.plan.report.warnings.some((w) => w.code === 'everyone_admin'));
  const before = count('servers');
  for (const allowEveryoneAdmin of [undefined, false, 'true', 1]) {
    const r = await create(u, { template: tpl, allowEveryoneAdmin });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'everyone_admin');
  }
  assert.equal(count('servers'), before);
  const r = await create(u, { template: tpl, allowEveryoneAdmin: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.roleDefs.find((x) => x.everyone).permissions, P.ADMIN);
});

test('discord import: "only staff can create servers" applies to imports too; signed-out callers get nothing', async () => {
  const u = await srv.register();
  const set = (v) => as(srv.owner, 'PUT', '/admin/owner', { features: { createServers: v } });
  assert.equal((await set('staff')).status, 200);
  try {
    for (const r of [await preview(u, { template: SAMPLE }), await create(u, { template: SAMPLE })]) {
      assert.equal(r.status, 403);
      assert.match(r.json.error, /only staff can create servers/);
    }
    // The instance owner is staff.
    assert.equal((await preview(srv.owner, { template: SAMPLE })).status, 200);
  } finally { assert.equal((await set('everyone')).status, 200); }
  assert.equal((await srv.api('POST', '/imports/discord/preview', { body: { template: SAMPLE } })).status, 401);
  assert.equal((await srv.api('POST', '/imports/discord', { body: { template: SAMPLE } })).status, 401);
});

test('discord import: five imported servers an hour; refused attempts don\'t use one up; previews have their own limit', async () => {
  const u = await srv.register();
  for (let i = 0; i < 3; i++) assert.equal((await create(u, { template: { roles: 'x' } })).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await create(u, { template: SAMPLE, name: `Batch ${i}` })).status, 200, `import ${i + 1}`);
  const sixth = await create(u, { template: SAMPLE, name: 'Batch 6' });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.json.code, 'rate_limited');
  assert.equal(srv.sql("SELECT COUNT(*) n FROM servers WHERE owner_id = ? AND name = 'Batch 6'", u.id)[0].n, 0);
  // Someone else isn't affected.
  assert.equal((await create(await srv.register(), { template: SAMPLE })).status, 200);
  const v = await srv.register();
  let last;
  for (let i = 0; i < 61; i++) last = await preview(v, { template: SAMPLE.serialized_source_guild });
  assert.equal(last.status, 429);
});

test('discord import: the import list is for the owner and Administrators (its report names private channels)', async () => {
  const owner = await srv.register(); const member = await srv.register(); const manager = await srv.register(); const admin = await srv.register(); const outsider = await srv.register();
  const server = (await create(owner, { template: SAMPLE, name: 'Listed ' + hex(3) })).json;
  const invite = (await as(owner, 'POST', `/servers/${server.id}/invites`, {})).json;
  for (const x of [member, manager, admin]) assert.equal((await as(x, 'POST', `/invites/${invite.code}/join`)).status, 200);
  const manageServer = (await as(owner, 'POST', `/servers/${server.id}/roles`, { name: 'Managers', permissions: 1 << 13 })).json.id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${manager.id}/roles`, { roleIds: [manageServer] })).status, 200);
  const adminRole = server.roleDefs.find((x) => x.name === 'Admin').id;
  assert.equal((await as(owner, 'PUT', `/servers/${server.id}/members/${admin.id}/roles`, { roleIds: [adminRole] })).status, 200);
  const r = await as(owner, 'GET', `/servers/${server.id}/imports`);
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].id, server.importId);
  assert.equal(r.json[0].kind, 'discord_template');
  assert.equal(r.json[0].createdBy, owner.id);
  assert.deepEqual(r.json[0].report.counts, server.report.counts);
  assert.ok(JSON.stringify(r.json[0].report).includes('mod-chat'), 'the report names the private #mod-chat');
  assert.equal((await as(admin, 'GET', `/servers/${server.id}/imports`)).status, 200);
  assert.equal((await as(manager, 'GET', `/servers/${server.id}/imports`)).status, 403, 'Manage Server alone doesn\'t see private channels, so not their names either');
  assert.equal((await as(member, 'GET', `/servers/${server.id}/imports`)).status, 403);
  assert.equal((await as(outsider, 'GET', `/servers/${server.id}/imports`)).status, 404);
  // A server made by hand has none.
  const plain = (await as(owner, 'POST', '/servers', { name: 'Plain' })).json;
  assert.deepEqual((await as(owner, 'GET', `/servers/${plain.id}/imports`)).json, []);
  // Deleting the server takes its import record with it.
  srv.sql('DELETE FROM servers WHERE id = ?', server.id);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM server_imports WHERE server_id = ?', server.id)[0].n, 0);
  assert.equal(srv.sql('SELECT COUNT(*) n FROM import_map WHERE import_id = ?', server.importId)[0].n, 0);
});
