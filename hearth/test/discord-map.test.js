// Import from Discord, the pure part (server/discordmap.js): a Discord server template becomes a plan for a new
// Hearth server. No server runs here. The sample template is test/fixtures/discord-template.json (the one in
// docs/design/DISCORD-IMPORT.md, Appendix A); the plan it should give is checked field by field.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../server/discordmap');
const { PERMS: H, DEFAULT_EVERYONE, CHANNEL_SCOPED } = require('../server/perms');

const SAMPLE = require('./fixtures/discord-template.json');
const clone = (x) => JSON.parse(JSON.stringify(x));
const plan = (input = SAMPLE, opts) => { const { guild } = M.parseTemplate(clone(input)); return M.planFromTemplate(guild, opts); };
// Discord permission values as strings, from bit names.
const d = (...names) => String(names.reduce((m, n) => m | (1n << BigInt(M.DISCORD[n])), 0n));
const bits = (...names) => BigInt(d(...names));
const ch = (p, key) => p.channels.find((c) => c.key === key);
const role = (p, key) => p.roles.find((r) => r.key === key);
const ov = (c, target) => c.overrides.find((o) => o.target === target);

// A guild-shaped template with `n` roles / channels for the limit tests.
function guildWith({ roles = 1, channels = 1, categories = 0, perChannel = [] } = {}) {
  const g = { roles: [{ id: 0, name: '@everyone', permissions: d('VIEW_CHANNEL', 'SEND_MESSAGES') }], channels: [] };
  for (let i = 1; i < roles; i++) g.roles.push({ id: i, name: `role ${i}`, permissions: '0' });
  for (let i = 0; i < categories; i++) g.channels.push({ id: 10000 + i, type: 4, name: `cat ${i}`, position: i });
  for (let i = 0; i < channels; i++) {
    g.channels.push({ id: 20000 + i, type: 0, name: `chan-${i}`, position: i, parent_id: categories ? 10000 + (i % categories) : null, permission_overwrites: perChannel });
  }
  return g;
}

// ------------------------------------------------------------------ permission values and bits
test('discordBits reads permission strings above 2^32 and 2^53 with BigInt, and plain numbers up to 2^53', () => {
  assert.equal(M.discordBits('6756516287881350'), 6756516287881350n);
  assert.equal(M.discordBits('4503599627370496'), 1n << 52n);
  assert.equal(M.discordBits(String(1n << 63n)), 1n << 63n);
  assert.equal(M.discordBits(String((1n << 64n) + 5n)), 5n, 'masked to 64 bits');
  assert.equal(M.discordBits(104324689), 104324689n);
  assert.equal(M.discordBits(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
  for (const bad of [-1, 1.5, 2 ** 60, NaN, '12a', '', ' 1', '-5', null, undefined, {}, [], true, '9'.repeat(40)]) assert.equal(M.discordBits(bad), null, `refuses ${String(bad)}`);
});

// Each Hearth permission and the Discord one(s) behind it.
const TABLE = [
  ['VIEW_CHANNEL', ['VIEW_CHANNEL']], ['SEND_MESSAGES', ['SEND_MESSAGES']], ['ADD_REACTIONS', ['ADD_REACTIONS']],
  ['ATTACH_FILES', ['ATTACH_FILES']], ['MENTION_EVERYONE', ['MENTION_EVERYONE']], ['MANAGE_MESSAGES', ['MANAGE_MESSAGES']],
  ['CONNECT', ['CONNECT']], ['SPEAK', ['SPEAK']], ['CREATE_INVITE', ['CREATE_INSTANT_INVITE']], ['KICK_MEMBERS', ['KICK_MEMBERS']],
  ['BAN_MEMBERS', ['BAN_MEMBERS']], ['MANAGE_CHANNELS', ['MANAGE_CHANNELS']], ['MANAGE_ROLES', ['MANAGE_ROLES']],
  ['MANAGE_SERVER', ['MANAGE_GUILD']], ['MANAGE_EMOJIS', ['MANAGE_GUILD_EXPRESSIONS']],
  ['CREATE_THREADS', ['SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS']], ['EMBED_LINKS', ['EMBED_LINKS']],
  ['MUTE_MEMBERS', ['MUTE_MEMBERS']], ['MOVE_MEMBERS', ['MOVE_MEMBERS']], ['VIEW_AUDIT_LOG', ['VIEW_AUDIT_LOG']],
  ['CHANGE_NICKNAME', ['CHANGE_NICKNAME']], ['MANAGE_NICKNAMES', ['MANAGE_NICKNAMES']], ['ADMINISTRATOR', ['ADMINISTRATOR']],
];

test('mapRolePermissions maps every Hearth permission from its Discord permission, one at a time', () => {
  assert.equal(TABLE.length, Object.keys(H).length, 'every Hearth permission has a row');
  for (const [hearth, discord] of TABLE) {
    const m = M.mapRolePermissions(bits(...discord));
    assert.equal(m.permissions, H[hearth], hearth);
    assert.deepEqual(m.lost, [], `${hearth}: nothing lost`);
  }
  assert.deepEqual(M.mapRolePermissions(0n), { permissions: 0, lost: [] });
});

test('mapRolePermissions: Reply in threads needs both SEND_MESSAGES_IN_THREADS and CREATE_PUBLIC_THREADS', () => {
  assert.equal(M.mapRolePermissions(bits('SEND_MESSAGES_IN_THREADS')).permissions & H.CREATE_THREADS, 0);
  assert.equal(M.mapRolePermissions(bits('CREATE_PUBLIC_THREADS')).permissions & H.CREATE_THREADS, 0);
  assert.deepEqual(M.mapRolePermissions(bits('CREATE_PUBLIC_THREADS')).lost, ['CREATE_PUBLIC_THREADS'], 'half of it is reported');
  assert.equal(M.mapRolePermissions(bits('SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS')).permissions, H.CREATE_THREADS);
});

test('mapRolePermissions lists what Hearth has no permission for, unless a broader Hearth permission covers it', () => {
  const lostOf = (...n) => M.mapRolePermissions(bits(...n)).lost;
  assert.deepEqual(lostOf('VIEW_AUDIT_LOG', 'MANAGE_NICKNAMES', 'DEAFEN_MEMBERS', 'PRIORITY_SPEAKER', 'MANAGE_THREADS'),
    ['PRIORITY_SPEAKER', 'DEAFEN_MEMBERS', 'MANAGE_THREADS']);
  // View Audit Log has a Hearth equivalent (each server's own audit log), so it comes over instead of being lost; so
  // do Change Nickname and Manage Nicknames (per-server nicknames).
  assert.deepEqual(M.mapRolePermissions(bits('VIEW_AUDIT_LOG', 'MANAGE_NICKNAMES')), { permissions: H.VIEW_AUDIT_LOG | H.MANAGE_NICKNAMES, lost: [] });
  assert.deepEqual(M.mapRolePermissions(bits('CHANGE_NICKNAME')), { permissions: H.CHANGE_NICKNAME, lost: [] });
  // Pinning and skipping slowmode are part of Manage Messages in Hearth, timeouts part of Kick Members.
  assert.deepEqual(lostOf('PIN_MESSAGES', 'BYPASS_SLOWMODE', 'MODERATE_MEMBERS'), ['MODERATE_MEMBERS', 'PIN_MESSAGES', 'BYPASS_SLOWMODE']);
  assert.deepEqual(lostOf('PIN_MESSAGES', 'BYPASS_SLOWMODE', 'MANAGE_MESSAGES'), []);
  assert.deepEqual(lostOf('MODERATE_MEMBERS', 'KICK_MEMBERS'), []);
  assert.deepEqual(lostOf('MANAGE_EVENTS'), ['MANAGE_EVENTS']);
  assert.deepEqual(lostOf('MANAGE_EVENTS', 'MANAGE_CHANNELS'), []);
  assert.deepEqual(lostOf('CREATE_GUILD_EXPRESSIONS', 'MANAGE_GUILD_EXPRESSIONS'), []);
  // Things every Hearth member can do anyway lose nothing.
  assert.deepEqual(lostOf('READ_MESSAGE_HISTORY', 'STREAM', 'USE_VAD', 'SEND_POLLS', 'USE_EXTERNAL_EMOJIS', 'CREATE_EVENTS'), []);
  // An unknown bit is still reported.
  assert.deepEqual(M.mapRolePermissions(1n << 47n).lost, ['BIT_47']);
  // An Administrator can do everything Hearth has.
  assert.deepEqual(M.mapRolePermissions(bits('ADMINISTRATOR', 'PRIORITY_SPEAKER')), { permissions: H.ADMINISTRATOR, lost: [] });
});

test('mapOverwrite: allow needs every Discord permission behind it, deny needs any; allow and deny never overlap', () => {
  let m = M.mapOverwrite(bits('SEND_MESSAGES_IN_THREADS'), 0n);
  assert.equal(m.allow, 0);
  assert.deepEqual(m.dropped, ['SEND_MESSAGES_IN_THREADS']);
  m = M.mapOverwrite(0n, bits('SEND_MESSAGES_IN_THREADS'));
  assert.equal(m.deny, H.CREATE_THREADS);
  m = M.mapOverwrite(bits('VIEW_CHANNEL', 'SEND_MESSAGES'), bits('SEND_MESSAGES', 'ATTACH_FILES'));
  assert.equal(m.allow, H.VIEW_CHANNEL | H.SEND_MESSAGES);
  assert.equal(m.deny, H.ATTACH_FILES, 'an allow beats a deny of the same permission, as in Discord');
  assert.deepEqual(m.dropped, []);
  // Never more than Discord: for random roles and overrides, every channel permission Hearth ends up with, Discord
  // gave too (all of the Discord permissions behind it).
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  const randomBits = () => { let b = 0n; for (let i = 0; i < 53; i++) if (rnd() % 4 === 0) b |= 1n << BigInt(i); return b; };
  for (let i = 0; i < 2000; i++) {
    const base = randomBits(); const allow = randomBits(); const deny = randomBits() & ~allow;
    if (base & bits('ADMINISTRATOR')) continue;
    const discord = (base & ~deny) | allow;
    const o = M.mapOverwrite(allow, deny);
    assert.equal(o.allow & o.deny, 0);
    assert.equal((o.allow | o.deny) & ~CHANNEL_SCOPED, 0, 'only per-channel permissions');
    const hearth = (M.mapRolePermissions(base).permissions & ~o.deny) | o.allow;
    for (const [name, sources] of TABLE) {
      if (!(H[name] & CHANNEL_SCOPED) || !(hearth & H[name])) continue;
      assert.equal(discord & bits(...sources), bits(...sources), `${name} without Discord's ${sources.join(' + ')} (case ${i})`);
    }
  }
});

test('mapOverwrite drops Create Invite and other server-wide permissions, and reports denied history as widened', () => {
  const m = M.mapOverwrite(bits('VIEW_CHANNEL', 'CREATE_INSTANT_INVITE', 'MUTE_MEMBERS'), bits('KICK_MEMBERS', 'READ_MESSAGE_HISTORY', 'USE_EXTERNAL_STICKERS'));
  assert.equal(m.allow, H.VIEW_CHANNEL);
  assert.equal(m.deny, 0);
  assert.deepEqual(m.dropped, ['CREATE_INSTANT_INVITE', 'KICK_MEMBERS', 'MUTE_MEMBERS', 'USE_EXTERNAL_STICKERS']);
  assert.deepEqual(m.widened, ['READ_MESSAGE_HISTORY']);
  // Move Members is per channel in Hearth, so it stays.
  assert.equal(M.mapOverwrite(bits('MOVE_MEMBERS'), 0n).allow, H.MOVE_MEMBERS);
});

// ------------------------------------------------------------------ the sample template
test('planFromTemplate(sample): @everyone becomes Hearth\'s default, and what it loses or gains is listed', () => {
  const p = plan();
  assert.equal(p.everyone.permissions, 1147343);
  assert.equal(p.everyone.permissions, DEFAULT_EVERYONE);
  assert.equal(p.everyone.dangerous, false);
  assert.deepEqual(p.everyone.lost, ['REQUEST_TO_SPEAK', 'CREATE_PRIVATE_THREADS', 'USE_EXTERNAL_STICKERS', 'USE_SOUNDBOARD', 'USE_EXTERNAL_SOUNDS', 'USE_EXTERNAL_APPS']);
  // In Hearth anyone who can post can make events; Discord's @everyone here couldn't.
  assert.deepEqual(p.everyone.widened, ['CREATE_EVENTS']);
  assert.equal(p.name, 'Pinecone Club');
  assert.equal(p.description, 'Hiking, photos and bad puns');
});

test('planFromTemplate(sample): roles keep Discord order as positions 1..6, with mapped permissions and what they lose', () => {
  const p = plan();
  const got = p.roles.map((r) => [r.key, r.name, r.position, r.permissions, r.lost, r.skip]);
  assert.deepEqual(got, [
    ['1', 'Muted', 1, 0, [], null],
    ['2', 'Member', 2, 0, [], null],
    ['3', 'Event Host', 3, H.MENTION_EVERYONE, ['PRIORITY_SPEAKER', 'MANAGE_EVENTS'], null],
    ['4', 'Builder', 4, H.MANAGE_CHANNELS | H.MANAGE_ROLES | H.MANAGE_EMOJIS, [], null],
    ['5', 'Moderator', 5, H.MENTION_EVERYONE | H.MANAGE_MESSAGES | H.KICK_MEMBERS | H.BAN_MEMBERS | H.MUTE_MEMBERS | H.MOVE_MEMBERS | H.VIEW_AUDIT_LOG | H.MANAGE_NICKNAMES, ['MANAGE_THREADS'], null],
    ['6', 'Admin', 6, H.ADMINISTRATOR, [], null],
  ]);
  assert.equal(role(p, '6').admin, true);
  assert.equal(role(p, '5').admin, false);
});

test('planFromTemplate(sample): colours, hoist, mentionable and emoji role icons carry over', () => {
  const p = plan();
  assert.deepEqual(p.roles.map((r) => [r.name, r.color, r.icon, r.hoist, r.mentionable]), [
    ['Muted', '#95a5a6', '', false, false],
    ['Member', '', '', false, false],
    ['Event Host', '#2ecc71', '🎪', true, true],
    ['Builder', '#f1c40f', '', false, false],
    ['Moderator', '#3498db', '🛡️', true, true],
    ['Admin', '#e74c3c', '', true, false],
  ]);
});

test('planFromTemplate(sample): categories in Discord order, channels without one first under "Text", the empty "Archive" skipped', () => {
  const p = plan();
  assert.deepEqual(p.categoryOrder, ['Text', 'Information', 'Text Channels', 'Voice Channels']);
  assert.deepEqual(p.channels.map((c) => [c.position, c.key, c.name, c.type, c.category]), [
    [0, '40', 'welcome', 'text', 'Text'],
    [1, '11', 'announcements', 'text', 'Information'],
    [2, '12', 'rules', 'text', 'Information'],
    [3, '21', 'general', 'text', 'Text Channels'],
    [4, '22', 'trail-photos', 'text', 'Text Channels'],
    [5, '23', 'mod-chat', 'text', 'Text Channels'],
    [6, '24', 'help-forum', 'text', 'Text Channels'],
    [7, '25', 'channel-8', 'text', 'Text Channels'],
    [8, '31', 'Campfire', 'voice', 'Voice Channels'],
    [9, '32', 'Town Hall', 'voice', 'Voice Channels'],
    [10, '33', 'AFK', 'voice', 'Voice Channels'],
  ]);
  assert.deepEqual(p.report.skipped, [{ kind: 'category', key: '50', name: 'Archive', reason: 'empty' }]);
  assert.equal(ch(p, '22').slowmode, 30);
  assert.equal(ch(p, '21').topic, 'Talk about anything');
});

test('planFromTemplate: a voice channel keeps its slowmode, since its chat has one in Hearth too (voice chat)', () => {
  const g = clone(SAMPLE);
  g.serialized_source_guild.channels.find((c) => c.id === 31).rate_limit_per_user = 15;
  const p = plan(g);
  assert.equal(ch(p, '31').type, 'voice');
  assert.equal(ch(p, '31').slowmode, 15);
  assert.equal(ch(p, '32').slowmode, 0);
});

test('planFromTemplate(sample): text names are cleaned like Hearth\'s own; one with nothing left becomes channel-<position>', () => {
  const p = plan();
  assert.equal(ch(p, '40').sourceName, '👋・welcome');
  assert.ok(ch(p, '40').notes.includes('renamed'));
  assert.ok(ch(p, '11').notes.includes('renamed'));
  assert.equal(ch(p, '25').name, 'channel-8');
  assert.ok(ch(p, '25').notes.includes('renamed'));
  assert.ok(!ch(p, '12').notes.includes('renamed'));
  assert.equal(M.cleanChannelName('  Big News  Room!! ', 'text'), 'big-news-room');
  assert.equal(M.cleanChannelName('  Town Hall ', 'voice'), 'Town Hall');
});

test('planFromTemplate(sample): channel overrides map bit by bit; a stage is listen-only except for whoever can mute there', () => {
  const p = plan();
  const T = H.SEND_MESSAGES | H.ADD_REACTIONS | H.CREATE_THREADS; // 32774
  assert.deepEqual(ch(p, '40').overrides, [{ target: 'everyone', allow: 0, deny: T }]);
  assert.deepEqual(ch(p, '11').overrides, [{ target: 'everyone', allow: 0, deny: H.SEND_MESSAGES }, { target: '5', allow: H.SEND_MESSAGES | H.MENTION_EVERYONE, deny: 0 }]);
  assert.deepEqual(ch(p, '21').overrides, [{ target: '1', allow: 0, deny: T | H.SPEAK }]);
  assert.deepEqual(ch(p, '23').overrides, [{ target: 'everyone', allow: 0, deny: H.VIEW_CHANNEL }, { target: '5', allow: H.VIEW_CHANNEL, deny: 0 }]);
  assert.equal(ch(p, '23').private, true);
  assert.equal(ch(p, '21').private, false);
  // Town Hall (a stage): @everyone can't speak; Moderator (Mute Members) can, as on a Discord stage, where
  // speaking without being brought up takes Mute Members. Builder (only Manage Channels) couldn't there, so can't.
  const stage = ch(p, '32');
  assert.equal(stage.type, 'voice');
  assert.ok(stage.notes.includes('stage'));
  assert.deepEqual(ov(stage, 'everyone'), { target: 'everyone', allow: 0, deny: H.SPEAK });
  assert.equal(ov(stage, '4'), undefined);
  assert.deepEqual(ov(stage, '5'), { target: '5', allow: H.SPEAK, deny: 0 });
  assert.equal(ov(stage, '6'), undefined, 'Administrators can speak anyway');
  assert.deepEqual(ch(p, '33').overrides, [{ target: 'everyone', allow: 0, deny: H.SPEAK }]);
  assert.equal(p.report.counts.overrides, 10);
});

test('planFromTemplate(sample): announcement and forum channels become text channels, with notes', () => {
  const p = plan();
  assert.deepEqual(ch(p, '11').notes, ['renamed', 'announcement']);
  assert.deepEqual(ch(p, '24').notes, ['forum']);
  assert.equal(ch(p, '24').type, 'text');
});

test('planFromTemplate(sample): member overrides, NSFW, user limits, category permissions and server settings are reported, not applied', () => {
  const p = plan();
  assert.ok(ch(p, '21').notes.includes('member_overwrite_dropped'));
  assert.ok(ch(p, '25').notes.includes('nsfw_dropped'));
  assert.ok(ch(p, '33').notes.includes('user_limit_dropped'));
  assert.ok(ch(p, '23').notes.includes('dropped:CREATE_INSTANT_INVITE'));
  assert.deepEqual(p.report.warnings, [{ code: 'category_permissions_dropped', name: 'Information' }]);
  assert.deepEqual(p.report.channelNotes, [
    { code: 'member_overwrite_dropped', channels: ['general'] },
    { code: 'nsfw_dropped', channels: ['channel-8'] },
    { code: 'user_limit_dropped', channels: ['AFK'] },
  ]);
  assert.deepEqual(p.report.unmapped, [
    { field: 'verification_level', value: 1 }, { field: 'explicit_content_filter', value: 2 }, { field: 'default_message_notifications', value: 1 },
    { field: 'afk_channel', value: 'AFK' }, { field: 'system_channel', value: '👋・welcome' }, { field: 'icon', value: null },
  ]);
  assert.deepEqual(p.problems, []);
});

test('planFromTemplate(sample): every Discord permission that can\'t come over is in the report, with who had it', () => {
  const p = plan();
  assert.deepEqual(p.report.lost, [
    { bit: 'PRIORITY_SPEAKER', where: ['Event Host'] }, { bit: 'REQUEST_TO_SPEAK', where: ['@everyone'] }, { bit: 'MANAGE_EVENTS', where: ['Event Host'] },
    { bit: 'MANAGE_THREADS', where: ['Moderator'] }, { bit: 'CREATE_PRIVATE_THREADS', where: ['@everyone'] }, { bit: 'USE_EXTERNAL_STICKERS', where: ['@everyone'] },
    { bit: 'USE_SOUNDBOARD', where: ['@everyone'] }, { bit: 'USE_EXTERNAL_SOUNDS', where: ['@everyone'] }, { bit: 'USE_EXTERNAL_APPS', where: ['@everyone'] },
  ]);
  assert.deepEqual(p.report.dropped, [{ bit: 'CREATE_INSTANT_INVITE', where: ['mod-chat'] }]);
  // A denied Read Message History can't be kept: anyone who can see a Hearth channel reads all of it. Builder's
  // Manage Channels also manages events and skips slowmode in Hearth, which Builder couldn't do in Discord.
  assert.deepEqual(p.report.widened, [
    { bit: 'READ_MESSAGE_HISTORY', where: ['channel-8'] }, { bit: 'MANAGE_EVENTS', where: ['Builder'] },
    { bit: 'CREATE_EVENTS', where: ['@everyone'] }, { bit: 'BYPASS_SLOWMODE', where: ['Builder'] },
  ]);
  assert.ok(ch(p, '25').notes.includes('widened:READ_MESSAGE_HISTORY'));
  assert.deepEqual(ch(p, '25').overrides, []);
  assert.deepEqual(p.report.counts, { roles: 6, categories: 4, channels: 11, overrides: 10, skipped: 1 });
});

// ------------------------------------------------------------------ edge cases and limits
test('planFromTemplate: channel kinds Hearth doesn\'t have are skipped and reported by type', () => {
  const g = guildWith({ channels: 1 });
  g.channels.push({ id: 900, type: 11, name: 'a-thread' }, { id: 901, type: 14, name: 'directory' }, { id: 902, type: 99, name: 'future' }, { id: 903, name: 'no-type' });
  const p = plan(g);
  assert.deepEqual(p.report.skipped.map((s) => [s.kind, s.name, s.reason]), [
    ['channel', 'a-thread', 'type_11'], ['channel', 'directory', 'type_14'], ['channel', 'future', 'type_99'], ['channel', 'no-type', 'type_unknown'],
  ]);
  assert.equal(p.channels.length, 1);
});

test('planFromTemplate: duplicate category names become "Name (2)", compared without case; a category called "Text" keeps its name', () => {
  const g = guildWith();
  g.channels = [
    { id: 1, type: 0, name: 'loose', position: 0 },
    { id: 2, type: 4, name: 'General', position: 0 }, { id: 3, type: 0, name: 'a', parent_id: 2 },
    { id: 4, type: 4, name: 'general', position: 1 }, { id: 5, type: 0, name: 'b', parent_id: 4 },
    { id: 6, type: 4, name: 'TEXT', position: 2 }, { id: 7, type: 0, name: 'c', parent_id: 6 },
    { id: 8, type: 4, name: 'x'.repeat(40), position: 3 }, { id: 9, type: 0, name: 'd', parent_id: 8 },
    { id: 10, type: 4, name: 'x'.repeat(32), position: 4 }, { id: 11, type: 0, name: 'e', parent_id: 10 },
    { id: 12, type: 2, name: 'Loose voice', position: 0 },
  ];
  const p = plan(g);
  assert.deepEqual(p.categoryOrder, ['Text (2)', 'General', 'general (2)', 'TEXT', 'x'.repeat(32), `${'x'.repeat(28)} (2)`, 'Voice']);
  assert.ok(p.categoryOrder.every((c) => [...c].length <= 32));
  assert.equal(p.channels.find((c) => c.name === 'loose').category, 'Text (2)');
});

test('planFromTemplate: 120 roles keeps the highest 99 and reports 21; overrides for those are dropped', () => {
  const g = guildWith({ roles: 121, channels: 1 });
  g.channels[0].permission_overwrites = [{ id: 1, type: 0, allow: d('SEND_MESSAGES'), deny: '0' }, { id: 120, type: 0, allow: d('SEND_MESSAGES'), deny: '0' }];
  const p = plan(g);
  const kept = p.roles.filter((r) => !r.skip);
  assert.equal(kept.length, 99);
  assert.deepEqual(kept.map((r) => r.position), Array.from({ length: 99 }, (_, i) => i + 1));
  assert.equal(kept[0].key, '22', 'the lowest kept role is the 22nd');
  const over = p.report.skipped.filter((s) => s.reason === 'limit');
  assert.equal(over.length, 21);
  assert.deepEqual(over.map((s) => s.key), Array.from({ length: 21 }, (_, i) => String(i + 1)));
  assert.deepEqual(p.channels[0].overrides, [{ target: '120', allow: H.SEND_MESSAGES, deny: 0 }]);
  assert.ok(p.channels[0].notes.includes('overwrite_role_missing'));
});

test('planFromTemplate: more than 500 channels or 50 categories is a problem to fix before creating', () => {
  let p = plan(guildWith({ channels: 501 }));
  assert.deepEqual(p.problems, [{ code: 'too_many_channels', count: 501, max: 500 }]);
  assert.equal(p.channels.length, 501, 'the preview still shows them all, to untick some');
  p = plan(guildWith({ channels: 500 }));
  assert.deepEqual(p.problems, []);
  p = plan(guildWith({ channels: 51, categories: 51 }));
  assert.deepEqual(p.problems, [{ code: 'too_many_categories', count: 51, max: 50 }]);
  // Leaving one out fixes it.
  p = plan(guildWith({ channels: 51, categories: 51 }), { skipChannels: new Set(['20000']) });
  assert.deepEqual(p.problems, []);
});

test('planFromTemplate: skipRoles and skipChannels leave items out, with the overrides that point at them; a category takes its channels', () => {
  const p = plan(SAMPLE, { skipRoles: new Set(['5', '1']), skipChannels: new Set(['22', '30']) });
  assert.deepEqual(p.roles.filter((r) => !r.skip).map((r) => [r.name, r.position]), [['Member', 1], ['Event Host', 2], ['Builder', 3], ['Admin', 4]]);
  assert.equal(role(p, '5').skip, 'excluded');
  assert.deepEqual(ch(p, '23').overrides, [{ target: 'everyone', allow: 0, deny: H.VIEW_CHANNEL }], 'Moderator\'s access to #mod-chat goes with it');
  assert.ok(ch(p, '23').notes.includes('overwrite_role_missing'));
  assert.deepEqual(ch(p, '21').overrides, []);
  assert.equal(ch(p, '22'), undefined);
  for (const k of ['31', '32', '33']) assert.equal(ch(p, k), undefined, 'the Voice Channels category took its channels');
  assert.deepEqual(p.categoryOrder, ['Text', 'Information', 'Text Channels']);
  const skipped = p.report.skipped.map((s) => `${s.kind}:${s.key}:${s.reason}`);
  for (const s of ['role:1:excluded', 'role:5:excluded', 'channel:22:excluded', 'channel:31:excluded', 'category:30:excluded', 'category:50:empty']) assert.ok(skipped.includes(s), s);
  // The positions stay a running index.
  assert.deepEqual(p.channels.map((c) => c.position), [0, 1, 2, 3, 4, 5, 6]);
});

test('planFromTemplate: @everyone with Administrator is marked dangerous; with Manage permissions, warned', () => {
  const g = clone(SAMPLE);
  g.serialized_source_guild.roles[0].permissions = d('ADMINISTRATOR');
  let p = plan(g);
  assert.equal(p.everyone.dangerous, true);
  assert.equal(p.everyone.permissions, H.ADMINISTRATOR);
  assert.ok(p.report.warnings.some((w) => w.code === 'everyone_admin'));
  assert.deepEqual(p.everyone.widened, [], 'nothing is withheld from an Administrator');
  g.serialized_source_guild.roles[0].permissions = d('VIEW_CHANNEL', 'MANAGE_GUILD');
  p = plan(g);
  assert.equal(p.everyone.dangerous, false);
  assert.ok(p.report.warnings.some((w) => w.code === 'everyone_manage'));
});

test('planFromTemplate accepts the bare serialized_source_guild, and a guild with real ids (@everyone = the guild\'s id)', () => {
  const bare = plan(SAMPLE.serialized_source_guild);
  const full = plan(SAMPLE);
  assert.deepEqual(bare, full);
  const g = {
    id: '1199887766554433221', name: 'Real ids',
    roles: [
      { id: '1199887766554433300', name: 'Mods', permissions: d('KICK_MEMBERS'), position: 2 },
      { id: '1199887766554433221', name: '@everyone', permissions: d('VIEW_CHANNEL', 'SEND_MESSAGES', 'CONNECT'), position: 0 },
      { id: '1199887766554433299', name: 'Regulars', permissions: '0', position: 1 },
      { id: '1199887766554433301', name: 'Helper Bot', permissions: d('SEND_MESSAGES'), position: 3, managed: true, tags: { bot_id: '42' } },
      { id: '1199887766554433302', name: 'Server Booster', permissions: '0', position: 4, tags: { premium_subscriber: null } },
    ],
    channels: [
      { id: '1199887766554433400', type: 0, name: 'hello', position: 0, permission_overwrites: [
        { id: '1199887766554433221', type: 'role', allow: '0', deny: d('SEND_MESSAGES') },
        { id: '1199887766554433300', type: 'role', allow: d('SEND_MESSAGES'), deny: '0' },
        { id: '80351110224678912', type: 'member', allow: '0', deny: d('VIEW_CHANNEL') },
      ] },
    ],
  };
  const p = plan(g);
  assert.equal(p.everyone.permissions, H.VIEW_CHANNEL | H.SEND_MESSAGES | H.CONNECT);
  assert.deepEqual(p.roles.filter((r) => !r.skip).map((r) => [r.name, r.position]), [['Regulars', 1], ['Mods', 2]], 'sorted by position');
  assert.deepEqual(p.report.skipped.map((s) => [s.name, s.reason]), [['Helper Bot', 'managed'], ['Server Booster', 'managed']]);
  assert.deepEqual(p.channels[0].overrides, [{ target: 'everyone', allow: 0, deny: H.SEND_MESSAGES }, { target: '1199887766554433300', allow: H.SEND_MESSAGES, deny: 0 }]);
  assert.ok(p.channels[0].notes.includes('member_overwrite_dropped'));
});

test('planFromTemplate: an unsynced template is flagged; an image role icon, bad permissions and an empty server are handled', () => {
  const g = clone(SAMPLE);
  g.is_dirty = true;
  g.serialized_source_guild.roles[3].icon = 'abcdef0123456789abcdef0123456789';
  g.serialized_source_guild.roles[4].icon = 'abcdef0123456789abcdef0123456789';
  g.serialized_source_guild.roles[4].unicode_emoji = null;
  g.serialized_source_guild.roles[2].permissions = 'lots';
  let p = plan(g);
  const codes = p.report.warnings.map((w) => `${w.code}${w.name ? ':' + w.name : ''}`);
  for (const c of ['template_unsynced', 'role_icon_image_dropped:Builder', 'bad_permissions:Member']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes('role_icon_image_dropped:Event Host'), 'an emoji icon is kept instead');
  assert.equal(role(p, '2').permissions, 0);
  p = plan({ roles: [{ id: 0, name: '@everyone', permissions: '0' }], channels: [] });
  assert.deepEqual(p.channels.map((c) => [c.name, c.type, c.category]), [['general', 'text', 'Text']]);
  assert.deepEqual(p.categoryOrder, ['Text']);
  assert.ok(p.report.warnings.some((w) => w.code === 'added_default_channel'));
  assert.equal(plan({ roles: [{ id: 0 }], name: '   ' }).name, 'Imported server');
  assert.equal(plan(SAMPLE, { name: '  My own name ' }).name, 'My own name');
});

test('planFromTemplate: role and channel names are cleaned; roles can\'t pose as @everyone or @here', () => {
  const g = guildWith({ roles: 4 });
  g.roles[1].name = '@everyone'; g.roles[2].name = '  '; g.roles[3].name = 'A\u0000long\u202ename '.repeat(10);
  g.channels = [{ id: 5, type: 2, name: '   ' }, { id: 6, type: 0, name: 'x'.repeat(100), topic: 't'.repeat(400) }];
  const p = plan(g);
  assert.equal(p.roles[0].name, 'everyone (role)');
  assert.equal(p.roles[1].name, 'role');
  assert.equal([...p.roles[2].name].length <= 32, true);
  assert.ok(!/[\u0000\u202e]/.test(p.roles[2].name), 'control and text-direction characters are removed');
  assert.deepEqual(p.channels.map((c) => c.name), ['x'.repeat(48), 'Voice 2']);
  assert.equal(p.channels[0].topic.length, 300);
  assert.ok(p.channels[0].notes.includes('topic_trimmed'));
});

// ------------------------------------------------------------------ what Hearth allows beyond Discord
// A template with @everyone (view, send, connect, speak, invite) and the given roles and channels.
const tpl = (roles, channels = [{ id: 100, type: 0, name: 'general', position: 0 }]) => ({
  roles: [{ id: 0, name: '@everyone', permissions: d('VIEW_CHANNEL', 'SEND_MESSAGES', 'CONNECT', 'SPEAK', 'CREATE_INSTANT_INVITE') },
    ...roles.map(([name, ...perms], i) => ({ id: i + 1, name, permissions: d(...perms) }))],
  channels,
});
const wide = (p) => Object.fromEntries(p.report.widened.filter((w) => !['STREAM', 'USE_VAD', 'USE_APPLICATION_COMMANDS', 'USE_EMBEDDED_ACTIVITIES', 'CREATE_EVENTS', 'SEND_VOICE_MESSAGES', 'SEND_POLLS', 'READ_MESSAGE_HISTORY'].includes(w.bit)).map((w) => [w.bit, w.where]));

test('planFromTemplate lists what a Hearth permission bundles that the role lacked in Discord: Kick, Manage channels, Manage server, Manage messages', () => {
  const p = plan(tpl([['Kicker', 'KICK_MEMBERS'], ['ChanMgr', 'MANAGE_CHANNELS'], ['ServerMgr', 'MANAGE_GUILD'], ['Janitor', 'MANAGE_MESSAGES'],
    ['Full', 'KICK_MEMBERS', 'MODERATE_MEMBERS', 'MANAGE_CHANNELS', 'MANAGE_WEBHOOKS', 'MANAGE_EVENTS', 'MANAGE_MESSAGES', 'PIN_MESSAGES', 'BYPASS_SLOWMODE'],
    ['Boss', 'ADMINISTRATOR']]));
  assert.deepEqual(wide(p), {
    MANAGE_WEBHOOKS: ['ChanMgr', 'ServerMgr'], MANAGE_EVENTS: ['ChanMgr', 'ServerMgr'], MODERATE_MEMBERS: ['Kicker'],
    PIN_MESSAGES: ['Janitor'], BYPASS_SLOWMODE: ['ChanMgr', 'Janitor'],
  });
  // Nothing is lost for them either: they get the Hearth permission they had.
  assert.equal(role(p, '1').permissions, H.KICK_MEMBERS);
  assert.deepEqual(role(p, '1').lost, []);
  // @everyone with Kick Members: listed once, for @everyone, not again for each role.
  const g = tpl([['Kicker', 'KICK_MEMBERS']]);
  g.roles[0].permissions = d('VIEW_CHANNEL', 'KICK_MEMBERS');
  assert.deepEqual(wide(plan(g)), { MODERATE_MEMBERS: ['@everyone'] });
  // @everyone as an Administrator lacked nothing.
  g.roles[0].permissions = d('ADMINISTRATOR');
  assert.deepEqual(wide(plan(g)), {});
});

test('planFromTemplate lists a channel deny of what Hearth only has server-wide (Create invite, Mute members), where the target could see the channel', () => {
  const deny = (id, ...perms) => ({ id, type: 0, allow: '0', deny: d(...perms) });
  // @everyone may invite at role level, but every channel denies it: a common way to stop invites in Discord.
  let p = plan(tpl([], [
    { id: 100, type: 0, name: 'general', position: 0, permission_overwrites: [deny(0, 'CREATE_INSTANT_INVITE')] },
    { id: 101, type: 0, name: 'memes', position: 1, permission_overwrites: [deny(0, 'CREATE_INSTANT_INVITE')] },
  ]));
  assert.ok(p.everyone.permissions & H.CREATE_INVITE, 'Hearth keeps the role permission');
  assert.deepEqual(wide(p), { CREATE_INSTANT_INVITE: ['general', 'memes'] });
  assert.deepEqual(p.report.dropped, [{ bit: 'CREATE_INSTANT_INVITE', where: ['general', 'memes'] }], 'and it is still listed as not coming over');
  // A role with Mute Members denied it in one voice channel; a channel @everyone can't see isn't a widening.
  p = plan(tpl([['VoiceMod', 'MUTE_MEMBERS']], [
    { id: 100, type: 2, name: 'Lounge', position: 0, permission_overwrites: [deny(1, 'MUTE_MEMBERS')] },
    { id: 101, type: 0, name: 'secret', position: 1, permission_overwrites: [deny(0, 'VIEW_CHANNEL', 'CREATE_INSTANT_INVITE')] },
  ]));
  assert.deepEqual(wide(p), { MUTE_MEMBERS: ['Lounge'] });
  // A role allowed to see a channel that denies @everyone invites: it can't invite from there in Discord either.
  p = plan(tpl([['Mods', 'MANAGE_MESSAGES', 'PIN_MESSAGES', 'BYPASS_SLOWMODE']], [
    { id: 100, type: 0, name: 'mods', position: 0, permission_overwrites: [deny(0, 'VIEW_CHANNEL', 'CREATE_INSTANT_INVITE'), { id: 1, type: 0, allow: d('VIEW_CHANNEL'), deny: d('PIN_MESSAGES') }] },
  ]));
  assert.deepEqual(wide(p), { CREATE_INSTANT_INVITE: ['mods'], PIN_MESSAGES: ['mods'] }, 'and a pin deny for a role that can manage messages there');
  // A per-channel grant of Manage Messages to a role that can't pin: Hearth lets it pin there.
  p = plan(tpl([['Helper']], [{ id: 100, type: 0, name: 'help', position: 0, permission_overwrites: [{ id: 1, type: 0, allow: d('MANAGE_MESSAGES'), deny: '0' }] }]));
  assert.deepEqual(wide(p), { PIN_MESSAGES: ['help'], BYPASS_SLOWMODE: ['help'] });
  assert.deepEqual(ch(p, '100').overrides, [{ target: '1', allow: H.MANAGE_MESSAGES, deny: 0 }]);
});

test('planFromTemplate: Manage channel or Manage permissions granted in one channel only is listed: Hearth needs them server-wide', () => {
  const allow = (id, ...perms) => ({ id, type: 0, allow: d(...perms), deny: '0' });
  let p = plan(tpl([['Streamer'], ['Builder', 'MANAGE_CHANNELS', 'MANAGE_ROLES']], [
    { id: 100, type: 0, name: 'stream-chat', position: 0, permission_overwrites: [allow(1, 'MANAGE_CHANNELS', 'MANAGE_ROLES'), allow(2, 'MANAGE_CHANNELS', 'MANAGE_ROLES')] },
  ]));
  const c = ch(p, '100');
  // The overrides stay (harmless: they do less in Hearth, not more).
  assert.deepEqual(ov(c, '1'), { target: '1', allow: H.MANAGE_CHANNELS | H.MANAGE_ROLES, deny: 0 });
  assert.ok(c.notes.includes('dropped:MANAGE_CHANNELS'));
  assert.ok(c.notes.includes('dropped:MANAGE_ROLES'));
  assert.deepEqual(p.report.dropped, [{ bit: 'MANAGE_CHANNELS', where: ['stream-chat'] }, { bit: 'MANAGE_ROLES', where: ['stream-chat'] }]);
  // Only Builder already had them server-wide: nothing to list.
  p = plan(tpl([['Builder', 'MANAGE_CHANNELS', 'MANAGE_ROLES']], [{ id: 100, type: 0, name: 'x', position: 0, permission_overwrites: [allow(1, 'MANAGE_CHANNELS', 'MANAGE_ROLES')] }]));
  assert.deepEqual(p.report.dropped, []);
});

test('planFromTemplate: Embed Links allowed in one channel only is listed: Hearth link previews need Show link previews server-wide', () => {
  const allow = (id, ...perms) => ({ id, type: 0, allow: d(...perms), deny: '0' });
  // @everyone (tpl's) lacks Embed Links; #trail-photos allows it to @everyone and to Photographers, who lack it too.
  // Readers' apps check the sender's server-wide permission, so these overrides show no previews in Hearth.
  let p = plan(tpl([['Photographers'], ['Linkers', 'EMBED_LINKS']], [
    { id: 100, type: 0, name: 'trail-photos', position: 0, permission_overwrites: [allow(0, 'EMBED_LINKS'), allow(1, 'EMBED_LINKS', 'ATTACH_FILES')] },
    { id: 101, type: 0, name: 'links', position: 1, permission_overwrites: [allow(2, 'EMBED_LINKS')] },
  ]));
  assert.equal(p.everyone.permissions & H.EMBED_LINKS, 0);
  const c = ch(p, '100');
  // The overrides stay (harmless: they do less in Hearth, not more).
  assert.deepEqual(ov(c, 'everyone'), { target: 'everyone', allow: H.EMBED_LINKS, deny: 0 });
  assert.deepEqual(ov(c, '1'), { target: '1', allow: H.EMBED_LINKS | H.ATTACH_FILES, deny: 0 });
  assert.ok(c.notes.includes('dropped:EMBED_LINKS'));
  // Linkers have it server-wide: their override in #links does what it did in Discord.
  assert.ok(!ch(p, '101').notes.includes('dropped:EMBED_LINKS'));
  assert.deepEqual(p.report.dropped, [{ bit: 'EMBED_LINKS', where: ['trail-photos'] }]);
  // @everyone has it server-wide: an allow for anyone adds nothing, and nothing is listed.
  const g = tpl([['Photographers']], [{ id: 100, type: 0, name: 'trail-photos', position: 0, permission_overwrites: [allow(0, 'EMBED_LINKS'), allow(1, 'EMBED_LINKS')] }]);
  g.roles[0].permissions = d('VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS');
  p = plan(g);
  assert.deepEqual(p.report.dropped, []);
  // A deny still comes over and works (it turns previews off in that channel).
  g.channels[0].permission_overwrites = [{ id: 0, type: 0, allow: '0', deny: d('EMBED_LINKS') }];
  p = plan(g);
  assert.deepEqual(ov(ch(p, '100'), 'everyone'), { target: 'everyone', allow: 0, deny: H.EMBED_LINKS });
  assert.deepEqual(p.report.dropped, []);
});

test('planFromTemplate: on a stage only those who could speak unasked in Discord can (Mute Members and Speak there, after its overrides)', () => {
  const stage = (overwrites = []) => [{ id: 100, type: 13, name: 'Town Hall', position: 0, permission_overwrites: overwrites }];
  // Mute Members can; Move Members or Manage Channels alone can't; a Speak override alone doesn't make a speaker.
  let p = plan(tpl([['Muter', 'MUTE_MEMBERS'], ['Mover', 'MOVE_MEMBERS'], ['Builder', 'MANAGE_CHANNELS'], ['Talker']],
    stage([{ id: 4, type: 0, allow: d('SPEAK', 'ATTACH_FILES'), deny: '0' }])));
  let c = ch(p, '100');
  assert.deepEqual(c.overrides, [{ target: 'everyone', allow: 0, deny: H.SPEAK }, { target: '4', allow: H.ATTACH_FILES, deny: 0 }, { target: '1', allow: H.SPEAK, deny: 0 }]);
  // A Voice Mod denied Speak and Mute Members in this stage stays silent there, and the Mute deny is listed.
  p = plan(tpl([['Voice Mod', 'MUTE_MEMBERS']], stage([{ id: 1, type: 0, allow: '0', deny: d('SPEAK', 'MUTE_MEMBERS', 'MOVE_MEMBERS', 'MANAGE_CHANNELS') }])));
  c = ch(p, '100');
  assert.deepEqual(ov(c, '1'), { target: '1', allow: 0, deny: H.SPEAK | H.MOVE_MEMBERS | H.MANAGE_CHANNELS });
  assert.deepEqual(wide(p), { MUTE_MEMBERS: ['Town Hall'] });
  // Granted Mute Members in just this stage: a speaker here.
  p = plan(tpl([['Host']], stage([{ id: 1, type: 0, allow: d('MUTE_MEMBERS'), deny: '0' }])));
  assert.deepEqual(ov(ch(p, '100'), '1'), { target: '1', allow: H.SPEAK, deny: 0 });
  // If @everyone itself could speak unasked, the stage stays open.
  const g = tpl([], stage());
  g.roles[0].permissions = d('VIEW_CHANNEL', 'CONNECT', 'SPEAK', 'MUTE_MEMBERS');
  assert.deepEqual(ch(plan(g), '100').overrides, []);
});

test('planFromTemplate warns about moderator powers for @everyone: server-wide (Manage emoji too) and in a channel', () => {
  const g = tpl([]);
  g.roles[0].permissions = d('VIEW_CHANNEL', 'MANAGE_GUILD_EXPRESSIONS');
  assert.ok(plan(g).report.warnings.some((w) => w.code === 'everyone_manage'));
  g.roles[0].permissions = d('VIEW_CHANNEL', 'SEND_MESSAGES');
  assert.ok(!plan(g).report.warnings.some((w) => w.code === 'everyone_manage'));
  // Renaming everyone below you and reading the audit log are moderator powers in Hearth too (memberships.js
  // POWERFUL), and both come over now: @everyone holding them is said, like Kick.
  for (const bit of ['MANAGE_NICKNAMES', 'VIEW_AUDIT_LOG']) {
    g.roles[0].permissions = d('VIEW_CHANNEL', 'SEND_MESSAGES', bit);
    const p = plan(g);
    assert.ok(p.report.warnings.some((w) => w.code === 'everyone_manage'), bit);
    assert.ok(p.everyone.permissions & H[bit], `${bit} comes over`);
  }
  // Changing your own nickname isn't one (Hearth's @everyone has it by default).
  g.roles[0].permissions = d('VIEW_CHANNEL', 'SEND_MESSAGES', 'CHANGE_NICKNAME');
  assert.ok(!plan(g).report.warnings.some((w) => w.code === 'everyone_manage'));
  g.channels = [
    { id: 100, type: 0, name: 'general', position: 0, permission_overwrites: [{ id: 0, type: 0, allow: d('MANAGE_MESSAGES'), deny: '0' }] },
    { id: 101, type: 0, name: 'quiet', position: 1, permission_overwrites: [{ id: 0, type: 0, allow: '0', deny: d('SEND_MESSAGES') }] },
  ];
  const p = plan(g);
  assert.deepEqual(p.report.warnings.filter((w) => w.code === 'everyone_channel_manage'), [{ code: 'everyone_channel_manage', channels: ['general'] }]);
});

test('planFromTemplate: overrides that don\'t come because of a limit, and held a role back, are listed as widened', () => {
  // (99 roles and @everyone fit Hearth's 100 per channel, so the limit is lowered here to see it work.)
  const g = guildWith({ roles: 60, channels: 1 });
  g.channels[0].permission_overwrites = Array.from({ length: 59 }, (_, i) => ({ id: i + 1, type: 0, allow: '0', deny: d('ATTACH_FILES') }));
  const widenedCut = (p) => p.report.warnings.filter((w) => w.code === 'override_limit_widened');
  let p = plan(g, { limits: { overrides: 50 } });
  assert.equal(p.channels[0].overrides.length, 50);
  assert.deepEqual(widenedCut(p), [{ code: 'override_limit_widened', channels: ['chan-0'] }]);
  // Allows past the limit take nothing away.
  g.channels[0].permission_overwrites = Array.from({ length: 59 }, (_, i) => ({ id: i + 1, type: 0, allow: d('ATTACH_FILES'), deny: '0' }));
  p = plan(g, { limits: { overrides: 50 } });
  assert.ok(p.channels[0].notes.includes('override_limit'));
  assert.deepEqual(widenedCut(p), []);
  // Past the 300 read in one channel, nobody knows what they were.
  g.channels[0].permission_overwrites = Array.from({ length: 301 }, () => ({ id: 1, type: 0, allow: d('ATTACH_FILES'), deny: '0' }));
  p = plan(g);
  assert.ok(p.channels[0].notes.includes('override_limit'));
  assert.deepEqual(widenedCut(p), [{ code: 'override_limit_widened', channels: ['chan-0'] }]);
});

test('planFromTemplate: overrides in all are capped (stages count), and every list of names in the report is cut short', () => {
  // 99 roles that can speak on a stage × 500 stages and not one override in the template: 50,000 overrides.
  const g = guildWith({ roles: 100, channels: 0 });
  for (const r of g.roles.slice(1)) r.permissions = d('MUTE_MEMBERS', 'SPEAK');
  g.channels = Array.from({ length: 500 }, (_, i) => ({ id: 1000 + i, type: 13, name: `stage ${i}`, position: i }));
  let p = plan(g);
  assert.equal(p.report.counts.overrides, 50000);
  assert.deepEqual(p.problems, [{ code: 'too_many_overrides', count: 50000, max: M.LIMITS.overridesTotal }]);
  // Fewer stages (or roles) and it fits.
  g.channels = g.channels.slice(0, 50);
  p = plan(g);
  assert.equal(p.report.counts.overrides, 5000);
  assert.deepEqual(p.problems, []);
  // 500 channels that each drop a permission: the report names 25 and counts the rest.
  const h = guildWith({ channels: 500, perChannel: [{ id: 0, type: 0, allow: '0', deny: d('USE_EXTERNAL_STICKERS', 'READ_MESSAGE_HISTORY') }] });
  p = plan(h);
  const dropped = p.report.dropped.find((x) => x.bit === 'USE_EXTERNAL_STICKERS');
  assert.equal(dropped.where.length, 25);
  assert.equal(dropped.more, 475);
  assert.equal(p.report.widened.find((x) => x.bit === 'READ_MESSAGE_HISTORY').more, 476, '@everyone lacks it too');
});

test('planFromTemplate: a hostile template at every input limit plans quickly and gives a small report', () => {
  // 99 roles with every permission but Administrator, 500 stages, 10,000 overrides of random permissions.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  const all = (1n << 64n) - 1n;
  const rbits = () => ((BigInt(rnd()) << 33n) | (BigInt(rnd()) << 2n) | BigInt(rnd() & 3)) & all & ~8n;
  const g = { roles: [{ id: 0, name: '@everyone', permissions: '0' }], channels: [] };
  for (let i = 1; i <= 99; i++) g.roles.push({ id: i, name: `r${i}${'x'.repeat(30)}`, permissions: String(all & ~8n) });
  const per = M.MAX_IN.overwrites / 500;
  for (let c = 0; c < 500; c++) {
    g.channels.push({ id: 1000 + c, type: 13, name: `${'x'.repeat(40)}${c}`, permission_overwrites: Array.from({ length: per }, (_, k) => {
      const a = rbits(); return { id: k % 100, type: 0, allow: String(a), deny: String(rbits() & ~a) };
    }) });
  }
  const body = JSON.stringify(g);
  plan(JSON.parse(body)); // warm up
  const t = process.hrtime.bigint();
  const p = plan(JSON.parse(body));
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  assert.ok(JSON.stringify(p.report).length < 150 * 1024, `report ${JSON.stringify(p.report).length} bytes`);
  assert.ok(p.problems.some((x) => x.code === 'too_many_overrides'));
  // One more override than the cap is refused before any work.
  g.channels[0].permission_overwrites.push({ id: 0, type: 0, allow: '0', deny: '1' });
  assert.throws(() => M.parseTemplate(g), (e) => e.code === 'too_big');
});

test('planFromTemplate gives each channel the key of its group, so a renamed category can be followed', () => {
  const g = guildWith();
  g.channels = [{ id: 1, type: 0, name: 'loose', position: 0 }, { id: 2, type: 4, name: 'Text', position: 0 }, { id: 3, type: 0, name: 'inside', parent_id: 2 }];
  let p = plan(g);
  assert.deepEqual(p.channels.map((c) => [c.name, c.group, c.category]), [['loose', '', 'Text (2)'], ['inside', '2', 'Text']]);
  p = plan(g, { skipChannels: new Set(['3']) });
  assert.deepEqual(p.channels.map((c) => [c.name, c.group, c.category]), [['loose', '', 'Text']]);
});

test('planFromTemplate is deterministic', () => {
  assert.deepEqual(plan(), plan());
  const g = guildWith({ roles: 130, channels: 60, categories: 7 });
  assert.deepEqual(plan(g), plan(g));
});

test('parseTemplate survives hostile input without throwing anything but ImportError, and pollutes nothing', () => {
  const bad = [
    null, undefined, 1, 'text', [], [SAMPLE], {}, { roles: 'x' }, { roles: [] }, { roles: [1, 'x', null] },
    { serialized_source_guild: { roles: {} } }, { roles: [{ id: 0 }], channels: 'nope' },
    { roles: Array.from({ length: 301 }, (_, i) => ({ id: i })) },
    { roles: [{ id: 0 }], channels: Array.from({ length: 601 }, (_, i) => ({ id: i, type: 0 })) },
    { roles: [{ id: 0 }], channels: Array.from({ length: 100 }, (_, i) => ({ id: i, type: 0, permission_overwrites: Array.from({ length: 300 }, () => ({ id: 0, type: 0, allow: '1', deny: '0' })) })) },
  ];
  for (const x of bad) {
    assert.throws(() => M.parseTemplate(x), (e) => e instanceof M.ImportError && typeof e.code === 'string', JSON.stringify(x === undefined ? 'undefined' : x).slice(0, 80));
  }
  // Odd but readable input gives a plan, never an exception.
  // Deep nesting where it isn't expected (only known fields one level down are ever read).
  let chain = {};
  for (let i = 0; i < 5000; i++) chain = { serialized_source_guild: chain, roles: chain, nested: [chain] };
  const deep = { serialized_source_guild: { roles: [{ id: 0, name: chain, permissions: chain, colors: chain, tags: chain }], channels: [{ id: 1, type: 0, permission_overwrites: [chain, { id: chain }] }], settings: chain }, extra: chain };
  const odd = [
    JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"roles":[{"id":0,"__proto__":{"admin":true},"name":{"toString":"x"},"permissions":{"$gt":""}}],"channels":[{"id":"__proto__","type":"0","name":["a"],"permission_overwrites":[{"id":0,"allow":"x","deny":[]},"junk",null]}]}'),
    { roles: [{ id: 0, name: 'x'.repeat(10 * 1024 * 1024) }], channels: [{ id: 1, type: 0, name: 'y'.repeat(1024 * 1024), topic: 'z'.repeat(1024 * 1024), position: 'first', parent_id: { a: 1 }, rate_limit_per_user: 1e12, user_limit: -5 }] },
    { roles: [{ id: 0 }], channels: [{ id: 1, type: 0, parent_id: 1 }, { id: 2, type: 0, parent_id: 99 }] },
    deep,
  ];
  for (const x of odd) {
    const { guild } = M.parseTemplate(x);
    const p = M.planFromTemplate(guild);
    assert.ok(p.channels.length >= 1);
    for (const c of p.channels) { assert.ok(c.name.length <= 48); assert.ok(c.topic.length <= 300); assert.ok(c.slowmode >= 0 && c.slowmode <= 21600); }
  }
  assert.equal({}.polluted, undefined);
  assert.equal({}.admin, undefined);
});
