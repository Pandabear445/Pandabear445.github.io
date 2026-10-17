// Import from Discord, phase 1: a Discord server template becomes a plan for a new Hearth server (roles,
// categories, channels and channel permissions). See docs/design/DISCORD-IMPORT.md and docs/IMPORT.md.
//
// Pure: no database, no network, no clock. The same input always gives the same plan, so server/imports.js runs
// it for the preview and again when creating, and never trusts a plan sent back by the app.
//
// Input is what people can get their hands on: a whole template object (GET /guilds/templates/<code>), just its
// serialized_source_guild, or a guild-shaped object with real ids (roles, channels and the guild's own id). Only
// known fields are read, each with a type check; input objects are never spread or used as maps, so keys like
// __proto__ and constructor are inert.
//
// The permission rule: grant no more than Discord did where Hearth can say so, and list everything else before
// anything is created.
//   - A role gets a Hearth permission only if it had every Discord permission behind it.
//   - In a channel override, Hearth allows a permission only if Discord allowed every permission behind it, and
//     denies it if Discord denied any of them. Only per-channel permissions are kept (as PUT /channels/:id/overrides).
//   - What Hearth has no equivalent for is listed ("lost" for roles, "dropped" for overrides).
//   - What Hearth allows anyway is listed as "widened": things Discord could withhold but Hearth can't (reading
//     history, screen share, polls…) whenever @everyone lacks them or an override denies them; what a Hearth
//     permission bundles that the role didn't have in Discord (Kick members also times out, Manage channels also
//     manages webhooks…); and per-channel denies of what Hearth only has server-wide (Create invite, Mute members).
const { PERMS: P, CHANNEL_SCOPED } = require('./perms');

class ImportError extends Error {
  constructor(code, message) { super(message); this.name = 'ImportError'; this.code = code; }
}

// Discord's permission bits by name (https://docs.discord.com/developers/topics/permissions). Bits go past 2^53,
// so they're handled as BigInt throughout.
const DISCORD = Object.freeze({
  CREATE_INSTANT_INVITE: 0, KICK_MEMBERS: 1, BAN_MEMBERS: 2, ADMINISTRATOR: 3, MANAGE_CHANNELS: 4, MANAGE_GUILD: 5,
  ADD_REACTIONS: 6, VIEW_AUDIT_LOG: 7, PRIORITY_SPEAKER: 8, STREAM: 9, VIEW_CHANNEL: 10, SEND_MESSAGES: 11,
  SEND_TTS_MESSAGES: 12, MANAGE_MESSAGES: 13, EMBED_LINKS: 14, ATTACH_FILES: 15, READ_MESSAGE_HISTORY: 16,
  MENTION_EVERYONE: 17, USE_EXTERNAL_EMOJIS: 18, VIEW_GUILD_INSIGHTS: 19, CONNECT: 20, SPEAK: 21, MUTE_MEMBERS: 22,
  DEAFEN_MEMBERS: 23, MOVE_MEMBERS: 24, USE_VAD: 25, CHANGE_NICKNAME: 26, MANAGE_NICKNAMES: 27, MANAGE_ROLES: 28,
  MANAGE_WEBHOOKS: 29, MANAGE_GUILD_EXPRESSIONS: 30, USE_APPLICATION_COMMANDS: 31, REQUEST_TO_SPEAK: 32,
  MANAGE_EVENTS: 33, MANAGE_THREADS: 34, CREATE_PUBLIC_THREADS: 35, CREATE_PRIVATE_THREADS: 36,
  USE_EXTERNAL_STICKERS: 37, SEND_MESSAGES_IN_THREADS: 38, USE_EMBEDDED_ACTIVITIES: 39, MODERATE_MEMBERS: 40,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 41, USE_SOUNDBOARD: 42, CREATE_GUILD_EXPRESSIONS: 43, CREATE_EVENTS: 44,
  USE_EXTERNAL_SOUNDS: 45, SEND_VOICE_MESSAGES: 46, SET_VOICE_CHANNEL_STATUS: 48, SEND_POLLS: 49,
  USE_EXTERNAL_APPS: 50, PIN_MESSAGES: 51, BYPASS_SLOWMODE: 52,
});
const NAME_OF = new Map(Object.entries(DISCORD).map(([k, b]) => [b, k]));
const D = (name) => 1n << BigInt(DISCORD[name]);
const MASK64 = (1n << 64n) - 1n;
// Permission values are read as BigInt, but worked on as two unsigned 32-bit numbers (lo, hi): BigInt operations
// are slow and every one allocates, and a template can carry thousands of overrides.
const split = (b) => [Number(b & 0xffffffffn), Number((b >> 32n) & 0xffffffffn)];
const u32 = (x) => x >>> 0;

// Hearth permission ← the Discord permissions behind it (all of them, for a role or an allow).
const MAP = [
  ['VIEW_CHANNEL', ['VIEW_CHANNEL']],
  ['SEND_MESSAGES', ['SEND_MESSAGES']],
  ['ADD_REACTIONS', ['ADD_REACTIONS']],
  ['ATTACH_FILES', ['ATTACH_FILES']],
  ['MENTION_EVERYONE', ['MENTION_EVERYONE']],
  ['MANAGE_MESSAGES', ['MANAGE_MESSAGES']],
  ['CONNECT', ['CONNECT']],
  ['SPEAK', ['SPEAK']],
  ['CREATE_INVITE', ['CREATE_INSTANT_INVITE']],
  ['KICK_MEMBERS', ['KICK_MEMBERS']],
  ['BAN_MEMBERS', ['BAN_MEMBERS']],
  ['MANAGE_CHANNELS', ['MANAGE_CHANNELS']],
  ['MANAGE_ROLES', ['MANAGE_ROLES']],
  ['MANAGE_SERVER', ['MANAGE_GUILD']],
  ['MANAGE_EMOJIS', ['MANAGE_GUILD_EXPRESSIONS']],
  // Hearth's "Reply in threads" both starts threads and posts in them.
  ['CREATE_THREADS', ['SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS']],
  ['EMBED_LINKS', ['EMBED_LINKS']],
  ['MUTE_MEMBERS', ['MUTE_MEMBERS']],
  ['MOVE_MEMBERS', ['MOVE_MEMBERS']],
  // Each server's own audit log (server/serveraudit.js): who kicked, banned or timed out whom, and who changed
  // roles, channels, permissions and settings, like Discord's. Server-wide only, in both.
  ['VIEW_AUDIT_LOG', ['VIEW_AUDIT_LOG']],
  // Per-server nicknames (server/nicknames.js): your own, and other people's below you. Server-wide only, in both.
  ['CHANGE_NICKNAME', ['CHANGE_NICKNAME']],
  ['MANAGE_NICKNAMES', ['MANAGE_NICKNAMES']],
  ['ADMINISTRATOR', ['ADMINISTRATOR']],
].map(([h, ds]) => { const [lo, hi] = split(ds.reduce((m, d) => m | D(d), 0n)); return { hearth: P[h], lo, hi }; });

// Things Discord can withhold but Hearth always allows to anyone who can see the channel (or post, or join the
// call). Having them in Discord loses nothing; lacking them is a widening, and gets a warning.
const WIDENED = ['READ_MESSAGE_HISTORY', 'STREAM', 'USE_VAD', 'USE_APPLICATION_COMMANDS', 'USE_EMBEDDED_ACTIVITIES',
  'SEND_VOICE_MESSAGES', 'SEND_POLLS', 'CREATE_EVENTS'];
const WIDENED_MASK = WIDENED.reduce((m, d) => m | D(d), 0n);
const [WIDE_LO, WIDE_HI] = split(WIDENED_MASK);
// Also always allowed, but harmless: custom emoji from any server can be used anywhere in Hearth.
const [ALWAYS_LO, ALWAYS_HI] = split(WIDENED_MASK | D('USE_EXTERNAL_EMOJIS'));
// Discord permissions that are part of a broader Hearth one: not lost when the role ends up with it.
const COVERED = [
  ['PIN_MESSAGES', P.MANAGE_MESSAGES], ['BYPASS_SLOWMODE', P.MANAGE_MESSAGES],
  ['MODERATE_MEMBERS', P.KICK_MEMBERS], // Hearth timeouts need Kick Members
  ['MANAGE_EVENTS', P.MANAGE_SERVER | P.MANAGE_CHANNELS], // so do editing and deleting others' events
  ['MANAGE_WEBHOOKS', P.MANAGE_SERVER | P.MANAGE_CHANNELS], // channel webhooks (server/webhooks.js)
  ['CREATE_GUILD_EXPRESSIONS', P.MANAGE_EMOJIS],
].map(([d, by]) => { const [lo, hi] = split(D(d)); return { lo, hi, by }; });
// The few Discord permissions the checks below look at for every role in every channel, packed into a small
// number: BigInt is slow, and a hostile template can ask for 99 roles × 500 channels of them.
const SMALL = ['ADMINISTRATOR', 'VIEW_CHANNEL', 'SPEAK', 'MUTE_MEMBERS', 'CREATE_INSTANT_INVITE', 'PIN_MESSAGES', 'BYPASS_SLOWMODE',
  'MANAGE_WEBHOOKS', 'MANAGE_EVENTS', 'MODERATE_MEMBERS'];
const S = Object.fromEntries(SMALL.map((n, i) => [n, 1 << i]));
const SMALL_AT = SMALL.map((n) => DISCORD[n]);
function small(bits) {
  if (!bits) return 0;
  const [lo, hi] = split(bits);
  let out = 0;
  for (let i = 0; i < SMALL_AT.length; i++) { const b = SMALL_AT[i]; if ((b < 32 ? lo >>> b : hi >>> (b - 32)) & 1) out |= 1 << i; }
  return out;
}
const smallNames = (v) => SMALL.filter((n, i) => v & (1 << i));
// The other way round: what a Hearth permission lets someone do beyond its Discord namesake, in those terms.
// base: Hearth permissions server-wide; chan: in one channel (or base again).
//   - Kick members also times people out (server/usability.js).
//   - Manage channels or Manage server also manage webhooks (server/webhooks.js) and anyone's events (index.js).
//   - Manage messages also pins; Manage messages or Manage channels (in that channel) also skip slowmode.
//   - Create invites and Mute members exist only server-wide in Hearth: no channel can take them away.
function abilities(base, chan) {
  let d = 0;
  if (base & P.KICK_MEMBERS) d |= S.MODERATE_MEMBERS;
  if (base & (P.MANAGE_SERVER | P.MANAGE_CHANNELS)) d |= S.MANAGE_EVENTS;
  if ((base & P.MANAGE_SERVER) || ((base & P.MANAGE_CHANNELS) && (chan & P.MANAGE_CHANNELS))) d |= S.MANAGE_WEBHOOKS;
  if (chan & P.MANAGE_MESSAGES) d |= S.PIN_MESSAGES;
  if (chan & (P.MANAGE_MESSAGES | P.MANAGE_CHANNELS)) d |= S.BYPASS_SLOWMODE;
  if (base & P.CREATE_INVITE) d |= S.CREATE_INSTANT_INVITE;
  if (base & P.MUTE_MEMBERS) d |= S.MUTE_MEMBERS;
  return d;
}
// Those of them a Discord channel override can take away (Timeout Members is server-wide in Discord too).
const PER_CHANNEL_ABILITY = S.PIN_MESSAGES | S.BYPASS_SLOWMODE | S.MANAGE_WEBHOOKS | S.MANAGE_EVENTS | S.CREATE_INSTANT_INVITE | S.MUTE_MEMBERS;

// Names of the bits set, lowest first (unknown ones as BIT_<n>).
const NAMES64 = Array.from({ length: 64 }, (_, i) => NAME_OF.get(i) || `BIT_${i}`);
function namesOf(lo, hi) {
  const out = [];
  for (let i = 0; lo; i++, lo >>>= 1) if (lo & 1) out.push(NAMES64[i]);
  for (let i = 32; hi; i++, hi >>>= 1) if (hi & 1) out.push(NAMES64[i]);
  return out;
}
const names = (bits) => (bits ? namesOf(...split(bits)) : []);
// Rest less what a broader Hearth permission in `granted` covers, as [lo, hi].
function uncovered(lo, hi, granted) {
  for (const c of COVERED) if (((lo & c.lo) || (hi & c.hi)) && (granted & c.by)) { lo &= ~c.lo; hi &= ~c.hi; }
  return [lo, hi];
}
const hasAll = (lo, hi, m) => u32(lo & m.lo) === m.lo && u32(hi & m.hi) === m.hi;

// A Discord permission value: a string of digits (API v8+) or a plain number (older examples). Anything else: null.
function discordBits(v) {
  if (typeof v === 'string' && /^\d{1,25}$/.test(v)) return BigInt(v) & MASK64;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

// A role's server-wide permissions. { permissions: Hearth bits, lost: Discord names it had that Hearth can't give }
function mapRolePermissions(bits) {
  const [lo, hi] = split(bits);
  let hearth = 0; let uLo = 0; let uHi = 0;
  for (const m of MAP) if (hasAll(lo, hi, m)) { hearth |= m.hearth; uLo |= m.lo; uHi |= m.hi; }
  // An Administrator can do everything Hearth has, so nothing it had is missing.
  if (hearth & P.ADMINISTRATOR) return { permissions: hearth, lost: [] };
  return { permissions: hearth, lost: namesOf(...uncovered(lo & ~uLo & ~ALWAYS_LO, hi & ~uHi & ~ALWAYS_HI, hearth)) };
}

// One channel override. { allow, deny: Hearth bits; dropped: Discord names that couldn't be set; widened: Discord
// names it denied that Hearth always allows }. Allow and deny never overlap.
function mapOverwrite(allow, deny) {
  const m = overwriteBits(allow, deny);
  return { allow: m.allow, deny: m.deny, dropped: namesOf(m.dropLo, m.dropHi), widened: namesOf(m.wideLo, m.wideHi) };
}
// The same, with dropped and widened as bits ([lo, hi] halves), which the plan gathers per channel.
function overwriteBits(allow, deny) {
  const [aLo, aHi] = split(allow); const [dLo, dHi] = split(deny);
  let a = 0; let d = 0;
  for (const m of MAP) {
    if (hasAll(aLo, aHi, m)) a |= m.hearth;
    if ((dLo & m.lo) || (dHi & m.hi)) d |= m.hearth;
  }
  a &= CHANNEL_SCOPED;
  d &= CHANNEL_SCOPED & ~a;
  // What each side did that the result doesn't carry. A deny Discord itself overrode (the same bit allowed in the
  // same override) isn't missing anything.
  let rALo = aLo & ~ALWAYS_LO; let rAHi = aHi & ~ALWAYS_HI;
  let rDLo = dLo & ~aLo & ~ALWAYS_LO; let rDHi = dHi & ~aHi & ~ALWAYS_HI;
  for (const m of MAP) {
    if (a & m.hearth) { rALo &= ~m.lo; rAHi &= ~m.hi; }
    if (d & m.hearth) { rDLo &= ~m.lo; rDHi &= ~m.hi; }
  }
  [rALo, rAHi] = uncovered(rALo, rAHi, a);
  return { allow: a, deny: d, dropLo: rALo | rDLo, dropHi: rAHi | rDHi, wideLo: dLo & ~aLo & WIDE_LO, wideHi: dHi & ~aHi & WIDE_HI };
}

// ------------------------------------------------------------------ reading the input
// Discord allows 250 roles and 500 channels; a little more is tolerated (older servers), much more is refused
// before any work is done. Overrides are capped in total so a hostile file can't make the plan expensive: 10,000
// is 20 for each of 500 channels, far more than real servers use.
const MAX_IN = { roles: 300, channels: 600, overwritesPerChannel: 300, overwrites: 10000 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const get = (o, k) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
// Text with control and text-direction characters removed (newlines too, unless `lines`), cut to `max`
// characters. Someone else's template could otherwise flip how a role or channel name reads.
const BIDI = '\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069';
const CONTROLS = new RegExp(`[\\u0000-\\u001f\\u007f${BIDI}]`, 'g');
const CONTROLS_KEEP_LINES = new RegExp(`[\\u0000-\\u0009\\u000b-\\u001f\\u007f${BIDI}]`, 'g');
function text(v, max, lines = false) {
  if (typeof v !== 'string') return '';
  const s = v.slice(0, max * 2).replace(lines ? CONTROLS_KEEP_LINES : CONTROLS, '');
  return [...s].slice(0, max).join('');
}
const int = (v) => (Number.isSafeInteger(v) ? v : typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Ids: template placeholders (small integers) or snowflakes, kept as strings. Anything else isn't an id.
const idKey = (v) => (Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'string' && /^\d{1,25}$/.test(v) ? v : null);
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

function parseTemplate(input) {
  if (!isObj(input)) throw new ImportError('bad_template', 'That doesn’t look like a Discord server template.');
  const src = get(input, 'serialized_source_guild');
  const template = isObj(src);
  const g = template ? src : input;
  const rolesIn = get(g, 'roles');
  const chIn = get(g, 'channels');
  if (!Array.isArray(rolesIn) || !rolesIn.length) throw new ImportError('bad_template', 'That doesn’t look like a Discord server template: it has no roles.');
  if (chIn !== undefined && chIn !== null && !Array.isArray(chIn)) throw new ImportError('bad_template', 'That doesn’t look like a Discord server template: its channels aren’t a list.');
  const channelsIn = Array.isArray(chIn) ? chIn : [];
  if (rolesIn.length > MAX_IN.roles || channelsIn.length > MAX_IN.channels) {
    throw new ImportError('too_big', `That has more roles or channels than a Discord server can have (at most ${MAX_IN.roles} roles and ${MAX_IN.channels} channels are read).`);
  }
  let unreadable = 0;
  const seen = new Set();
  // A missing or repeated id gets a key of its own that no override can point at.
  const keyOf = (raw, prefix, i) => { const k = idKey(raw); if (k !== null && !seen.has(prefix + k)) { seen.add(prefix + k); return k; } return `${prefix}${i}`; };

  const roles = [];
  rolesIn.forEach((r, index) => {
    if (!isObj(r)) { unreadable++; return; }
    const colors = get(r, 'colors');
    const c = int(has(colors, 'primary_color') && get(colors, 'primary_color') !== null ? get(colors, 'primary_color') : get(r, 'color'));
    const tags = get(r, 'tags');
    roles.push({
      key: keyOf(get(r, 'id'), 'r', index),
      name: text(get(r, 'name'), 200),
      bits: discordBits(get(r, 'permissions')),
      color: c !== null && c > 0 && c <= 0xffffff ? hex(c) : '',
      emoji: text(get(r, 'unicode_emoji'), 16),
      imageIcon: typeof get(r, 'icon') === 'string' && get(r, 'icon') !== '',
      hoist: get(r, 'hoist') === true,
      mentionable: get(r, 'mentionable') === true,
      position: num(get(r, 'position')),
      // Roles Discord manages itself (a bot's role, Server Booster, linked roles): never something to recreate.
      managed: get(r, 'managed') === true || (isObj(tags) && ['bot_id', 'integration_id', 'premium_subscriber', 'subscription_listing_id', 'guild_connections'].some((k) => has(tags, k))),
      index,
    });
  });
  if (!roles.length) throw new ImportError('bad_template', 'That doesn’t look like a Discord server template: none of its roles could be read.');

  let total = 0;
  const channels = [];
  channelsIn.forEach((c, index) => {
    if (!isObj(c)) { unreadable++; return; }
    const owIn = get(c, 'permission_overwrites');
    const list = Array.isArray(owIn) ? owIn : [];
    total += Math.min(list.length, MAX_IN.overwritesPerChannel);
    if (total > MAX_IN.overwrites) throw new ImportError('too_big', 'That template has far more channel permissions than a Discord server can.');
    const overwrites = [];
    for (const o of list.slice(0, MAX_IN.overwritesPerChannel)) {
      if (!isObj(o)) { unreadable++; continue; }
      const t = get(o, 'type');
      overwrites.push({
        id: idKey(get(o, 'id')),
        type: t === 0 || t === '0' || t === 'role' ? 'role' : t === 1 || t === '1' || t === 'member' ? 'member' : null,
        allow: discordBits(get(o, 'allow')) ?? 0n,
        deny: discordBits(get(o, 'deny')) ?? 0n,
      });
    }
    const topic = typeof get(c, 'topic') === 'string' ? get(c, 'topic') : '';
    const tagList = get(c, 'available_tags');
    channels.push({
      key: keyOf(get(c, 'id'), 'c', index),
      type: int(get(c, 'type')),
      name: text(get(c, 'name'), 200),
      position: num(get(c, 'position')),
      topic: text(topic, 300, true),
      topicCut: [...topic].length > 300,
      nsfw: get(c, 'nsfw') === true,
      userLimit: Math.max(0, int(get(c, 'user_limit')) || 0),
      slowmode: Math.max(0, Math.min(21600, int(get(c, 'rate_limit_per_user')) || 0)),
      parent: idKey(get(c, 'parent_id')),
      overwrites,
      overwritesCut: list.length > MAX_IN.overwritesPerChannel,
      tags: Array.isArray(tagList) ? tagList.length : 0,
      index,
    });
  });

  const code = get(input, 'code');
  const iconHash = get(g, 'icon_hash') ?? get(g, 'icon');
  const updatedAt = get(input, 'updated_at');
  const guild = {
    id: idKey(get(g, 'id')),
    name: text(get(g, 'name') || get(input, 'name'), 100),
    description: text(get(g, 'description'), 300, true),
    roles, channels,
    settings: {
      verification_level: int(get(g, 'verification_level')),
      explicit_content_filter: int(get(g, 'explicit_content_filter')),
      default_message_notifications: int(get(g, 'default_message_notifications')),
      afk_channel_id: idKey(get(g, 'afk_channel_id')),
      system_channel_id: idKey(get(g, 'system_channel_id')),
    },
    iconHash: typeof iconHash === 'string' && /^(a_)?[0-9a-f]{32}$/.test(iconHash) ? iconHash : null,
    isDirty: get(input, 'is_dirty') === true,
    unreadable,
  };
  const meta = {
    template,
    code: typeof code === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(code) ? code : '',
    name: text(get(input, 'name'), 100),
    usageCount: template ? Math.max(0, int(get(input, 'usage_count')) || 0) : null,
    updatedAt: typeof updatedAt === 'string' && /^[0-9T:.+\-Z ]{10,40}$/.test(updatedAt) ? updatedAt : null,
    isDirty: guild.isDirty,
    sourceGuildId: idKey(get(input, 'source_guild_id')) || guild.id,
    iconHash: guild.iconHash,
  };
  return { guild, meta };
}

// ------------------------------------------------------------------ the plan
// The same rules as the server's own routes (server/index.js): names, colours, icons and categories end up exactly
// as if someone had typed them into Hearth.
const cleanChannelName = (name, type) => {
  let n = String(name || '').trim().slice(0, 48);
  if (type === 'text') n = n.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '');
  return n;
};
const cleanCategory = (c) => String(c || '').trim().slice(0, 32);
const cleanIcon = (i) => [...String(i || '')].slice(0, 2).join('');
// Hearth's limits for one server: 100 roles counting @everyone (POST /servers/:id/roles), 50 categories in the
// saved order (PATCH /servers/:id), 100 overrides per channel (PUT /channels/:id/overrides). Channels have no cap
// of their own in Hearth; an import brings at most Discord's 500. Overrides in all, counting the ones a stage adds
// for its speakers, are capped too: every member's app loads all of them with the server.
const LIMITS = Object.freeze({ roles: 99, channels: 500, categories: 50, overrides: 100, overridesTotal: 5000 });

const TEXT_TYPES = new Map([[0, null], [5, 'announcement'], [15, 'forum'], [16, 'forum']]);
const VOICE_TYPES = new Map([[2, null], [13, 'stage']]);
// On a Discord stage everyone listens until someone brings them up. Speaking without being asked takes Mute Members
// in that stage (Discord's rule for unsuppressing yourself), and Speak.
const STAGE_SPEAKER = S.MUTE_MEMBERS | S.SPEAK;
const speaksOnStage = (dp) => !!(dp & S.ADMINISTRATOR) || (dp & STAGE_SPEAKER) === STAGE_SPEAKER;
// Moderator powers that @everyone shouldn't have without the person importing knowing. The same ones Hearth keeps
// out of roles people buy or pick themselves (memberships.js POWERFUL): renaming the people below you (Manage
// Nicknames) and reading the audit log (who moderated whom) count too.
const EVERYONE_MANAGE = P.MANAGE_SERVER | P.MANAGE_ROLES | P.MANAGE_CHANNELS | P.MANAGE_MESSAGES | P.MANAGE_EMOJIS
  | P.KICK_MEMBERS | P.BAN_MEMBERS | P.MUTE_MEMBERS | P.MOVE_MEMBERS | P.MANAGE_NICKNAMES | P.VIEW_AUDIT_LOG;
const EVERYONE_CHANNEL_MANAGE = P.MANAGE_MESSAGES | P.MOVE_MEMBERS | P.MANAGE_CHANNELS | P.MANAGE_ROLES | P.MENTION_EVERYONE;
// Lists of names in the report (who had a permission, which channels a note is about) stop here, with a count of
// the rest: a hostile template could otherwise make the report, which is kept, as big as the template.
const WHERE_MAX = 25;
const capped = (list) => (list.length > WHERE_MAX ? { list: list.slice(0, WHERE_MAX), more: list.length - WHERE_MAX } : { list, more: 0 });

// Sort by Discord position, then by id (older first, as Discord's sidebar does), then by order in the file.
function byPosition(a, b) {
  const pa = a.position ?? Infinity; const pb = b.position ?? Infinity;
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (/^\d+$/.test(a.key) && /^\d+$/.test(b.key) && a.key !== b.key) return BigInt(a.key) < BigInt(b.key) ? -1 : 1;
  return a.index - b.index;
}

// opts: { name, skipRoles, skipChannels (Sets of keys; a category's key skips its channels), limits }
function planFromTemplate(guild, opts = {}) {
  const lim = { ...LIMITS, ...(opts.limits || {}) };
  const skipRoles = opts.skipRoles instanceof Set ? opts.skipRoles : new Set();
  const skipChannels = opts.skipChannels instanceof Set ? opts.skipChannels : new Set();
  const warnings = [];
  const skipped = [];
  if (guild.isDirty) warnings.push({ code: 'template_unsynced' });
  if (guild.unreadable) warnings.push({ code: 'unreadable_items', count: guild.unreadable });

  // ---- @everyone: the role with the guild's id (real ids), else the first one (templates).
  const evRole = (guild.id && guild.roles.find((r) => r.key === guild.id)) || guild.roles[0];
  if (evRole.bits === null) warnings.push({ code: 'bad_permissions', name: '@everyone' });
  const evBits = evRole.bits ?? 0n;
  const ev = mapRolePermissions(evBits);
  const dangerous = !!(ev.permissions & P.ADMINISTRATOR);
  // What @everyone lacked in Discord but gets in Hearth (an Administrator lacked nothing).
  const everyone = { key: evRole.key, permissions: ev.permissions, lost: ev.lost, widened: dangerous ? [] : names(~evBits & WIDENED_MASK), dangerous };
  if (everyone.dangerous) warnings.push({ code: 'everyone_admin' });
  else if (ev.permissions & EVERYONE_MANAGE) warnings.push({ code: 'everyone_manage' });

  // ---- roles, lowest first. Positions when every role has one, else the order in the file (templates).
  const others = guild.roles.filter((r) => r !== evRole);
  const ordered = others.every((r) => r.position !== null) ? [...others].sort(byPosition) : others;
  const roles = ordered.map((r) => {
    const m = mapRolePermissions(r.bits ?? 0n);
    if (r.bits === null) warnings.push({ code: 'bad_permissions', name: r.name || 'role' });
    let name = text(r.name.trim(), 32).trim() || 'role';
    if (/^@(everyone|here)$/i.test(name)) name = `${name.slice(1).toLowerCase()} (role)`;
    return {
      key: r.key, name, sourceName: r.name, color: r.color, icon: cleanIcon(r.emoji), hoist: r.hoist, mentionable: r.mentionable,
      permissions: m.permissions, lost: m.lost, admin: !!(m.permissions & P.ADMINISTRATOR), position: 0,
      skip: r.managed ? 'managed' : skipRoles.has(r.key) ? 'excluded' : null, imageIcon: r.imageIcon && !r.emoji, bits: r.bits ?? 0n,
    };
  });
  // Over Hearth's limit, the lowest roles stay behind (the person importing can untick others instead).
  let room = lim.roles;
  for (let i = roles.length - 1; i >= 0; i--) if (!roles[i].skip) { if (room > 0) room--; else roles[i].skip = 'limit'; }
  const kept = roles.filter((r) => !r.skip);
  kept.forEach((r, i) => { r.position = i + 1; });
  for (const r of roles) {
    if (r.skip) skipped.push({ kind: 'role', key: r.key, name: r.name, reason: r.skip });
    else if (r.imageIcon) warnings.push({ code: 'role_icon_image_dropped', name: r.name });
  }
  const keptRoles = new Map(kept.map((r) => [r.key, r]));
  const allRoles = new Set(roles.map((r) => r.key));
  // For @everyone ('everyone') and each kept role, someone holding just that role: Hearth and Discord permissions
  // server-wide, what Hearth lets them do in Discord's terms (abilities), and what of that Discord didn't (wide).
  const facts = new Map();
  const evAbility = abilities(ev.permissions, ev.permissions); const evSmall = small(evBits);
  facts.set('everyone', { hBase: ev.permissions, dBase: evSmall, ability: evAbility, wide: dangerous ? 0 : evAbility & ~evSmall, admin: dangerous });
  for (const r of kept) {
    const hBase = ev.permissions | r.permissions; const dBase = evSmall | small(r.bits); const ability = abilities(hBase, hBase);
    const admin = dangerous || r.admin;
    facts.set(r.key, { hBase, dBase, ability, wide: admin ? 0 : ability & ~dBase, admin });
  }

  // ---- categories and channels
  const cats = guild.channels.filter((c) => c.type === 4).sort(byPosition);
  const catKeys = new Set(cats.map((c) => c.key));
  const groups = new Map(); // category key (or '' / '~' for channels without one) -> channels
  const plain = [];
  const allChannels = [];
  for (const c of guild.channels) {
    if (c.type === 4) continue;
    const kind = TEXT_TYPES.has(c.type) ? 'text' : VOICE_TYPES.has(c.type) ? 'voice' : null;
    const parent = c.parent !== null && catKeys.has(c.parent) ? c.parent : null;
    const ch = { src: c, kind, parent, skip: null };
    allChannels.push(ch);
    if (!kind) { ch.skip = `type_${c.type ?? 'unknown'}`; continue; }
    if (skipChannels.has(c.key) || (parent && skipChannels.has(parent))) { ch.skip = 'excluded'; continue; }
    plain.push(ch);
    // Channels without a (known) category: text ones go first under "Text", voice ones last under "Voice", as
    // Hearth does for new channels.
    const g = parent || (kind === 'text' ? '' : '~');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(ch);
  }
  const groupOrder = [...(groups.has('') ? [''] : []), ...cats.map((c) => c.key).filter((k) => groups.has(k)), ...(groups.has('~') ? ['~'] : [])];
  // Names: Discord categories keep theirs (made unique without regard to case, since Hearth groups channels by the
  // name); "Text" and "Voice" for channels without one give way if a category already has that name.
  const taken = new Set();
  const unique = (base) => {
    let n = base; let i = 2;
    while (taken.has(n.toLowerCase())) { const sfx = ` (${i++})`; n = base.slice(0, 32 - sfx.length).trimEnd() + sfx; }
    taken.add(n.toLowerCase());
    return n;
  };
  const catName = new Map();
  cats.forEach((c, i) => { if (groups.has(c.key)) catName.set(c.key, unique(cleanCategory(c.name) || `Category ${i + 1}`)); });
  if (groups.has('')) catName.set('', unique('Text'));
  if (groups.has('~')) catName.set('~', unique('Voice'));
  for (const c of cats) {
    if (!groups.has(c.key)) skipped.push({ kind: 'category', key: c.key, name: cleanCategory(c.name) || 'Category', reason: skipChannels.has(c.key) ? 'excluded' : 'empty' });
    else if (c.overwrites.length) warnings.push({ code: 'category_permissions_dropped', name: catName.get(c.key) });
  }
  for (const ch of allChannels) if (ch.skip) skipped.push({ kind: 'channel', key: ch.src.key, name: ch.src.name, reason: ch.skip });

  const everyoneKey = evRole.key;
  const channels = [];
  // The same override (allow, deny) mostly comes up again and again; a hostile one can't make it costly either.
  const owCache = new Map();
  const mapOw = (allow, deny) => {
    const k = (allow << 64n) | deny;
    let m = owCache.get(k);
    if (!m) { m = overwriteBits(allow, deny); m.sAllow = small(allow); m.sDeny = small(deny); owCache.set(k, m); }
    return m;
  };
  const everyoneChannelManage = []; const cutDenies = [];
  for (const g of groupOrder) {
    // Within a category, text channels come before voice ones (Discord's sidebar order).
    const list = groups.get(g);
    const sorted = [...list.filter((c) => c.kind === 'text').sort((a, b) => byPosition(a.src, b.src)), ...list.filter((c) => c.kind === 'voice').sort((a, b) => byPosition(a.src, b.src))];
    for (const { src: c, kind } of sorted) {
      const position = channels.length;
      const notes = [];
      let name = kind === 'text' ? cleanChannelName(c.name, 'text') : cleanChannelName(c.name, 'voice');
      if (!name) name = kind === 'text' ? `channel-${position + 1}` : `Voice ${position + 1}`;
      if (name !== c.name) notes.push('renamed');
      const conv = kind === 'text' ? TEXT_TYPES.get(c.type) : VOICE_TYPES.get(c.type);
      if (conv) notes.push(conv);
      if (c.tags) notes.push('forum_tags_dropped');
      if (c.nsfw) notes.push('nsfw_dropped');
      if (c.userLimit > 0 && kind === 'voice') notes.push('user_limit_dropped');
      if (c.topicCut) notes.push('topic_trimmed');
      if (c.overwritesCut) notes.push('override_limit');
      // Overrides: one per target (Discord has one per target too; a repeat is merged). Discord's own are kept
      // alongside, merged the same way, to work out what each role could do here in Discord.
      const byTarget = new Map(); const raw = new Map();
      // What couldn't be set (dropped) and what Hearth allows anyway (widened), as Discord bits.
      let dropLo = 0; let dropHi = 0; let wideLo = 0; let wideHi = 0;
      for (const o of c.overwrites) {
        if (o.type === 'member' || (o.type === null && o.id !== null && !allRoles.has(o.id) && o.id !== everyoneKey)) { if (!notes.includes('member_overwrite_dropped')) notes.push('member_overwrite_dropped'); continue; }
        const target = o.id === everyoneKey ? 'everyone' : o.id !== null && keptRoles.has(o.id) ? o.id : null;
        if (!target) { if (!notes.includes('overwrite_role_missing')) notes.push('overwrite_role_missing'); continue; }
        const m = mapOw(o.allow, o.deny);
        dropLo |= m.dropLo; dropHi |= m.dropHi; wideLo |= m.wideLo; wideHi |= m.wideHi;
        const prev = byTarget.get(target) || { target, allow: 0, deny: 0 };
        prev.allow |= m.allow; prev.deny = (prev.deny | m.deny) & ~prev.allow;
        byTarget.set(target, prev);
        const rp = raw.get(target) || { allow: 0, deny: 0 };
        rp.allow |= m.sAllow; rp.deny = (rp.deny | m.sDeny) & ~rp.allow;
        raw.set(target, rp);
      }
      // Discord's permissions here for someone with just @everyone or just one role (Discord's order: the role
      // permissions, then the @everyone override, then the role's).
      const evRaw = raw.get('everyone');
      const dIn = (t) => {
        let p = facts.get(t).dBase;
        if (p & S.ADMINISTRATOR) return p;
        if (evRaw) p = (p & ~evRaw.deny) | evRaw.allow;
        const ro = t !== 'everyone' && raw.get(t);
        return ro ? (p & ~ro.deny) | ro.allow : p;
      };
      // A stage: listen-only, except for whoever could speak there without being brought up in Discord (Mute
      // Members and Speak in this stage, after its overrides). A role override's Speak alone doesn't let anyone
      // speak on a Discord stage, so it doesn't here either; a denied Speak stays denied.
      if (c.type === 13 && !dangerous && !speaksOnStage(dIn('everyone'))) {
        const e = byTarget.get('everyone') || { target: 'everyone', allow: 0, deny: 0 };
        e.allow &= ~P.SPEAK; e.deny |= P.SPEAK;
        byTarget.set('everyone', e);
        for (const r of kept) {
          if (r.admin) continue;
          const o = byTarget.get(r.key);
          if (speaksOnStage(dIn(r.key))) { const x = o || { target: r.key, allow: 0, deny: 0 }; x.allow |= P.SPEAK; x.deny &= ~P.SPEAK; byTarget.set(r.key, x); } else if (o) o.allow &= ~P.SPEAK;
        }
      }
      // @everyone first, then roles from the highest down (what's kept if there are too many).
      let overrides = [...byTarget.values()].filter((o) => o.allow || o.deny)
        .map((o) => [o.target === 'everyone' ? Infinity : keptRoles.get(o.target).position, o]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
      // One that took something away and doesn't come leaves that role with more here than in Discord (past the
      // 300 read, whatever they were).
      if (c.overwritesCut || overrides.slice(lim.overrides).some((o) => o.deny)) cutDenies.push(name);
      if (overrides.length > lim.overrides) { overrides = overrides.slice(0, lim.overrides); if (!notes.includes('override_limit')) notes.push('override_limit'); }
      if (!dangerous && (raw.size || overrides.length)) {
        // What Hearth lets someone do here that Discord's overrides took away: a deny Hearth can't set per channel
        // (Create invite, Mute members), or of something a Hearth permission bundles (Pin messages, Bypass
        // slowmode, webhooks, events). Only where Discord let them see the channel: invites, say, still go
        // through the channels they could see. What's already listed for the role server-wide isn't repeated.
        const hBy = new Map(overrides.map((o) => [o.target, o]));
        const hEv = hBy.get('everyone');
        const hIn = (t) => {
          let p = facts.get(t).hBase;
          if (hEv) p = (p & ~hEv.deny) | hEv.allow;
          const ro = t !== 'everyone' && hBy.get(t);
          if (ro) p = (p & ~ro.deny) | ro.allow;
          return p & P.VIEW_CHANNEL ? p : 0;
        };
        const targets = new Set(['everyone', ...raw.keys(), ...hBy.keys()]);
        const evDeny = evRaw ? evRaw.deny & PER_CHANNEL_ABILITY : 0;
        if (evDeny) for (const r of kept) if (facts.get(r.key).ability & evDeny) targets.add(r.key);
        const evWide = facts.get('everyone').wide;
        for (const t of targets) {
          const f = facts.get(t);
          if (f.admin) continue;
          const dp = dIn(t);
          if (!(dp & S.VIEW_CHANNEL)) continue;
          const more = abilities(f.hBase, hIn(t)) & ~dp & PER_CHANNEL_ABILITY & ~f.wide & ~evWide;
          if (more) for (let i = 0; i < SMALL_AT.length; i++) if (more & (1 << i)) { const b = SMALL_AT[i]; if (b < 32) wideLo |= 1 << b; else wideHi |= 1 << (b - 32); }
        }
        // Hearth honours Manage channels and Manage roles in a channel only for someone who has them server-wide
        // (editing the channel, its permissions): granted just here, they don't do what they did in Discord.
        // Show link previews is the same: readers' apps check the sender's server-wide permission (perms.js
        // mayEmbed), so a channel override can turn previews off, never on.
        for (const o of overrides) {
          const f = facts.get(o.target);
          if (f.admin) continue;
          if ((o.allow & P.MANAGE_CHANNELS) && !(f.hBase & P.MANAGE_CHANNELS)) dropLo |= 1 << DISCORD.MANAGE_CHANNELS;
          if ((o.allow & P.MANAGE_ROLES) && !(f.hBase & P.MANAGE_ROLES)) dropLo |= 1 << DISCORD.MANAGE_ROLES;
          if ((o.allow & P.EMBED_LINKS) && !(f.hBase & P.EMBED_LINKS)) dropLo |= 1 << DISCORD.EMBED_LINKS;
        }
        if (hEv && (hEv.allow & EVERYONE_CHANNEL_MANAGE)) everyoneChannelManage.push(name);
      }
      for (const x of namesOf(dropLo, dropHi)) notes.push(`dropped:${x}`);
      for (const x of namesOf(wideLo, wideHi)) notes.push(`widened:${x}`);
      // Private: @everyone can't see it (the lock in the preview).
      const eo = overrides.find((o) => o.target === 'everyone');
      const evView = eo ? (everyone.permissions & ~eo.deny) | eo.allow : everyone.permissions;
      // Slowmode comes over for voice channels too: in Discord it's their text chat's, and Hearth's voice channels
      // have a chat with slowmode (v19, voice chat).
      channels.push({
        key: c.key, name, sourceName: c.name, type: kind, group: g, category: catName.get(g), topic: c.topic,
        slowmode: c.slowmode, position, overrides, notes, private: !(evView & P.VIEW_CHANNEL) && !everyone.dangerous,
      });
    }
  }
  const categoryOrder = groupOrder.map((g) => catName.get(g));
  // A server needs somewhere to talk: like a new server, it gets #general.
  if (!channels.length) {
    channels.push({ key: 'default', name: 'general', sourceName: '', type: 'text', group: 'default', category: unique('Text'), topic: '', slowmode: 0, position: 0, overrides: [], notes: [], private: false });
    categoryOrder.push(channels[0].category);
    warnings.push({ code: 'added_default_channel' });
  }

  // ---- what doesn't come over (and what Hearth allows anyway), gathered for the report
  // A list of names, cut at WHERE_MAX with a count of the rest.
  const listed = (o, key, all) => { const { list, more } = capped(all); o[key] = list; if (more) o.more = more; return o; };
  const gather = (pairs) => {
    const m = new Map();
    for (const [k, who] of pairs) { let set = m.get(k); if (!set) m.set(k, (set = new Set())); set.add(who); }
    return [...m].sort((a, b) => (DISCORD[a[0]] ?? 99) - (DISCORD[b[0]] ?? 99)).map(([bit, set]) => listed({ bit }, 'where', [...set]));
  };
  const lost = gather([...everyone.lost.map((b) => [b, '@everyone']), ...kept.flatMap((r) => r.lost.map((b) => [b, r.name]))]);
  const dropped = gather(channels.flatMap((c) => c.notes.filter((n) => n.startsWith('dropped:')).map((n) => [n.slice(8), c.name])));
  const evWide = facts.get('everyone').wide;
  const widened = gather([...everyone.widened.map((b) => [b, '@everyone']), ...smallNames(evWide).map((b) => [b, '@everyone']),
    ...kept.flatMap((r) => smallNames(facts.get(r.key).wide & ~evWide).map((b) => [b, r.name])),
    ...channels.flatMap((c) => c.notes.filter((n) => n.startsWith('widened:')).map((n) => [n.slice(8), c.name]))]);
  if (everyoneChannelManage.length) warnings.push(listed({ code: 'everyone_channel_manage' }, 'channels', everyoneChannelManage));
  if (cutDenies.length) warnings.push(listed({ code: 'override_limit_widened' }, 'channels', cutDenies));
  const SETTING_NOTES = ['member_overwrite_dropped', 'overwrite_role_missing', 'override_limit', 'nsfw_dropped', 'user_limit_dropped', 'forum_tags_dropped', 'topic_trimmed'];
  const channelNotes = SETTING_NOTES.map((code) => listed({ code }, 'channels', channels.filter((c) => c.notes.includes(code)).map((c) => c.name))).filter((x) => x.channels.length);
  const sourceName = (key) => { const c = guild.channels.find((x) => x.key === key); return c ? c.name : null; };
  const st = guild.settings;
  const unmapped = [
    st.verification_level > 0 ? { field: 'verification_level', value: st.verification_level } : null,
    st.explicit_content_filter > 0 ? { field: 'explicit_content_filter', value: st.explicit_content_filter } : null,
    st.default_message_notifications > 0 ? { field: 'default_message_notifications', value: st.default_message_notifications } : null,
    st.afk_channel_id ? { field: 'afk_channel', value: sourceName(st.afk_channel_id) } : null,
    st.system_channel_id ? { field: 'system_channel', value: sourceName(st.system_channel_id) } : null,
    guild.iconHash ? { field: 'icon', value: null } : null,
  ].filter(Boolean);

  // Over Hearth's limits: the preview shows it and asks to untick some; creating refuses.
  const problems = [];
  const overrideCount = channels.reduce((n, c) => n + c.overrides.length, 0);
  if (channels.length > lim.channels) problems.push({ code: 'too_many_channels', count: channels.length, max: lim.channels });
  if (categoryOrder.length > lim.categories) problems.push({ code: 'too_many_categories', count: categoryOrder.length, max: lim.categories });
  if (overrideCount > lim.overridesTotal) problems.push({ code: 'too_many_overrides', count: overrideCount, max: lim.overridesTotal });

  const name = text(String(opts.name ?? guild.name ?? '').trim(), 64).trim() || 'Imported server';
  return {
    name,
    description: guild.description,
    everyone: { permissions: everyone.permissions, lost: everyone.lost, widened: everyone.widened, dangerous: everyone.dangerous },
    roles: roles.map(({ bits, imageIcon, ...r }) => r),
    categoryOrder,
    channels,
    report: {
      counts: { roles: kept.length, categories: categoryOrder.length, channels: channels.length, overrides: overrideCount, skipped: skipped.length },
      skipped, warnings, unmapped, lost, dropped, widened, channelNotes,
    },
    problems,
  };
}

module.exports = { ImportError, DISCORD, LIMITS, MAX_IN, discordBits, mapRolePermissions, mapOverwrite, parseTemplate, planFromTemplate, cleanChannelName };
