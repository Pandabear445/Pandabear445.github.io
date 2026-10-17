// Server settings → Audit log and Reports (server/serveraudit.js has the rules).
//  - Audit log: who did what in this server, as sentences ("Ana banned Sam and deleted their messages from the last
//    24 hours"), newest first, filtered by kind and by person (anyone, by username: people who were banned or left
//    too), with older entries on request. While it's open, new entries appear by themselves (the server says when;
//    this tab fetches them with its own permissions, at most every few seconds however many come).
//  - Reports: reports about messages and members of this server that reached its moderators. Who reported stays
//    hidden; the messages are the reported person's, of the ones the reporter chose to share, decrypted on their
//    device. Moderators mark them handled or dismissed; instance staff handle their own copy separately.
// Everything people typed (names, reasons, notes, report text) goes in as text nodes, or through the app's escaping
// Markdown for the shared messages, never as HTML.
import { h, clear, icon, toast, fmtStamp } from './util.js';
import { api } from './api.js';
import { modal, field } from './ui.js';
import { PERMS, PERM_GROUPS } from './perms.js';
import { avatarEl } from './profile-ui.js';
import { render as md } from './markdown.js';
import { CATEGORY_LABEL } from './admin.js';
import { label as timerLabel } from './disappear.js';

// ------------------------------------------------------------------ live updates
let sock = null;
let watching = null; // { serverId, onNew } for the open Audit log tab
let reportsOpen = null; // { serverId, reload } for the open Reports tab
let brand = () => 'Hearth'; // this instance's name (it can be renamed)
const watch = (serverId, on) => { if (sock) sock.emit('audit:watch', { serverId, on }, () => {}); };
// Once, when the app connects. onFreshReport(p): a new report reached this person as a moderator. instanceName():
// what this instance is called, for "<name> staff".
export function initServerAudit(socket, { onFreshReport, instanceName } = {}) {
  sock = socket;
  if (instanceName) brand = () => instanceName() || 'Hearth';
  socket.on('audit:new', ({ serverId } = {}) => {
    if (!watching || watching.serverId !== serverId) return;
    // The tab was closed or switched away from: stop following.
    if (!watching.alive()) { watch(serverId, false); watching = null; return; }
    watching.onNew();
  });
  socket.on('server:report', (p = {}) => {
    if (reportsOpen && reportsOpen.serverId === p.serverId && reportsOpen.alive()) reportsOpen.reload();
    if (p.fresh && onFreshReport) onFreshReport(p);
  });
  // A reconnect starts with no rooms: follow the open log again.
  socket.on('connect', () => { if (watching && watching.alive()) watch(watching.serverId, true); });
}

// ------------------------------------------------------------------ words
const PERM_LABEL = new Map(PERM_GROUPS.flatMap(([, list]) => list.map(([k, label]) => [k, label])));
const permNames = (bits) => Object.entries(PERMS).filter(([, b]) => bits & b).map(([k]) => PERM_LABEL.get(k) || k.toLowerCase().replace(/_/g, ' '));
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const HOURS = { 1: 'the last hour', 24: 'the last 24 hours', 168: 'the last 7 days' };
const duration = (min) => (min % 1440 === 0 ? plural(min / 1440, 'day', 'days') : min % 60 === 0 ? plural(min / 60, 'hour', 'hours') : plural(min, 'minute', 'minutes'));
const SETTING = {
  name: 'the name', description: 'the description', icon: 'the icon', banner: 'the banner', background: 'the background', accent: 'the accent color',
  welcome: 'the welcome message', roleColors: 'names colored by role', iconShape: 'the icon shape', bannerCrop: 'the banner position',
};
// Kinds of entries for the filter (the server takes the action names).
export const AUDIT_KINDS = [
  ['', 'Everything'],
  ['members', 'Members', ['member_kick', 'member_ban', 'member_unban', 'member_timeout', 'member_timeout_remove', 'member_roles', 'member_nickname']],
  ['messages', 'Messages', ['message_delete', 'message_bulk_delete', 'message_pin', 'message_unpin']],
  ['roles', 'Roles', ['role_create', 'role_update', 'role_delete', 'role_reorder']],
  ['channels', 'Channels and permissions', ['channel_create', 'channel_update', 'channel_delete', 'channel_reorder', 'channel_overrides', 'category_reorder', 'category_rename']],
  ['voice', 'Voice', ['voice_disconnect', 'voice_move', 'voice_mute', 'voice_unmute']],
  ['invites', 'Invites', ['invite_create', 'invite_revoke']],
  ['emoji', 'Emoji', ['emoji_create', 'emoji_rename', 'emoji_delete']],
  ['integrations', 'Webhooks and bots', ['webhook_create', 'webhook_update', 'webhook_rotate', 'webhook_delete', 'bot_add', 'bot_update', 'bot_remove']],
  ['server', 'Server settings', ['server_update', 'server_transfer', 'word_filter_update']],
];

// A person as the log's users map has them (they may have left the server since).
const personOf = (users, id) => {
  const u = id && users[id];
  return u ? { id: u.id, username: u.username, avatar: u.avatar, profile: { displayName: u.deleted ? 'Deleted user' : u.displayName } } : null;
};
const nameOf = (users, id, fallback = 'someone') => { const p = personOf(users, id); return p ? p.profile.displayName : fallback; };
const strong = (t) => h('strong', null, t);
const channelText = (c) => (!c ? 'a channel' : c.hidden ? (c.deleted ? 'a deleted private channel' : 'a private channel') : `#${c.name}${c.deleted ? ' (deleted)' : c.now ? ` (now #${c.now})` : ''}`);
// The channel an entry is about, after "created" or "deleted": "the channel #news", "a private voice channel".
// (Deleting one says it's gone already.)
const theChannel = (d, deleting) => {
  const c = d.channel; const kind = d.type === 'voice' ? 'voice channel' : 'channel';
  if (!c) return `a ${kind}`;
  if (c.hidden) return `a private ${kind}`;
  return `the ${kind} #${c.name}${c.deleted && !deleting ? ' (deleted)' : c.now ? ` (now #${c.now})` : ''}`;
};
const quoted = (t) => `“${t}”`;

// Hearth's own entries from the upgrade that gave voice channels a chat (v19, see server/db.js).
const VOICE_CHAT_NOTE = 'Voice channels have a text chat now: this keeps the limits the server had on who may post.';

// One entry as a sentence: [parts of the sentence, an optional second line].
export function sentence(e, users) {
  const d = e.detail || {};
  const who = e.actorId ? strong(nameOf(users, e.actorId)) : strong(d.staff ? `${brand()} staff` : brand());
  const them = strong(nameOf(users, e.targetId));
  const ch = channelText(d.channel);
  const reason = d.reason ? `Reason: ${d.reason}` : null;
  switch (e.action) {
    case 'member_kick': return [[who, ' kicked ', them]];
    case 'member_ban': {
      const out = [who, ' banned ', them];
      if (d.hours) {
        out.push(` and deleted their messages from ${HOURS[d.hours] || `the last ${d.hours} hours`}`);
        if (d.count !== undefined) out.push(` (${plural(d.count, 'message', 'messages')}${d.replies ? `, and ${plural(d.replies, 'reply', 'replies')} by others in their threads` : ''})`);
        if (d.failed) out.push(' (the cleanup stopped part-way)');
      }
      if (d.member === false) out.push(' (who wasn’t in the server)');
      const extra = [reason, d.kept ? `${plural(d.kept, 'thread they started was', 'threads they started were')} kept: other people replied there.` : null,
        d.invites ? `${plural(d.invites, 'invite', 'invites')} they made stopped working.` : null].filter(Boolean).join(' ');
      return [out, extra || null];
    }
    case 'member_unban': return [[who, ' unbanned ', them]];
    case 'member_timeout': return [[who, ' timed out ', them, ` for ${duration(d.minutes || 0)}`], reason];
    case 'member_timeout_remove': return [[who, ' ended the timeout of ', them]];
    case 'member_roles': {
      const add = (d.added || []).map((r) => quoted(r.name)); const rem = (d.removed || []).map((r) => quoted(r.name));
      if (d.self) return [[them, add.length ? ` picked the role ${list(add)}` : ` dropped the role ${list(rem)}`], d.last ? 'They changed their roles a lot: more changes this hour aren’t listed.' : null];
      if (d.membership) return [[them, add.length ? ` got ${list(add)} with their membership` : '', add.length && rem.length ? ' and' : '', rem.length ? ` lost ${list(rem)} as their membership ended` : '']];
      return [[who, add.length ? ` gave ${list(add)} to ` : ' took ', ...(add.length ? [them] : [list(rem), ' away from ', them]), add.length && rem.length ? ` and took away ${list(rem)}` : '']];
    }
    // Nicknames (server/nicknames.js): people's own, a moderator's, or instance staff clearing them with a profile.
    // Once the person's account is deleted, the server leaves the names out (erased).
    case 'member_nickname': {
      const from = d.from ? quoted(d.from) : null; const to = d.to ? quoted(d.to) : null;
      if (d.erased) return [d.self ? [them, ' changed their nickname'] : [who, ' changed the nickname of ', them], 'The names aren\u2019t shown: their account was deleted.'];
      if (d.self) {
        return [to ? (from ? [them, ` changed their nickname from ${from} to ${to}`] : [them, ` set their nickname to ${to}`]) : [them, ` removed their nickname${from ? ` (${from})` : ''}`]];
      }
      if (!to) return [[who, ' removed the nickname of ', them, from ? ` (${from})` : ''], d.staff ? 'Their profile was reset by staff.' : null];
      return [from ? [who, ' changed the nickname of ', them, ` from ${from} to ${to}`] : [who, ' gave ', them, ` the nickname ${to}`]];
    }
    case 'message_delete': return [[who, d.staff ? ' removed a reported message by ' : ` deleted a ${d.thread ? 'thread reply' : 'message'} by `, them, ` in ${ch}`]];
    case 'message_bulk_delete': return [[who, ` deleted ${plural(d.count || 0, 'message', 'messages')} at once in ${ch}`, d.replies ? ` (and ${plural(d.replies, 'thread reply', 'thread replies')})` : ''],
      d.kept ? `${plural(d.kept, 'message was', 'messages were')} kept: by people at or above their highest role.` : null];
    case 'message_pin': return [[who, ' pinned a message by ', them, ` in ${ch}`]];
    case 'message_unpin': return [[who, ' unpinned a message by ', them, ` in ${ch}`]];
    case 'role_create': return [[who, ` created the role ${quoted(d.name || '')}`], d.permissions ? `With: ${list(permNames(d.permissions))}.` : null];
    case 'role_update': {
      const c = d.changes || {}; const bits = [];
      if (c.name) bits.push(`renamed it from ${quoted(c.name.from)}`);
      if (c.permissions && c.permissions.added) bits.push(`gave it ${list(permNames(c.permissions.added))}`);
      if (c.permissions && c.permissions.removed) bits.push(`took away ${list(permNames(c.permissions.removed))}`);
      if (c.color) bits.push('changed its color');
      if (c.icon) bits.push('changed its icon');
      if (c.hoist !== undefined) bits.push(c.hoist ? 'shows it separately in the member list' : 'stopped showing it separately');
      if (c.mentionable !== undefined) bits.push(c.mentionable ? 'let anyone mention it' : 'stopped letting anyone mention it');
      if (c.selfAssign !== undefined) bits.push(c.selfAssign ? 'let members pick it themselves' : 'stopped letting members pick it');
      return [[who, ` changed the role ${quoted(d.name || '')}`], bits.length ? `${bits.join('; ')}.`.replace(/^./, (x) => x.toUpperCase()) : null];
    }
    case 'role_delete': return [[who, ` deleted the role ${quoted(d.name || '')}`, d.count ? ` (${plural(d.count, 'person', 'people')} had it)` : '']];
    case 'role_reorder': return [[who, ` reordered the roles (${plural(d.count || 0, 'role', 'roles')} moved)`]];
    case 'channel_create': return [[who, ` created ${theChannel(d, false)}`]];
    case 'channel_update': {
      const c = d.changes || {}; const bits = [];
      if (c.name) bits.push(`renamed it from #${c.name.from} to #${c.name.to}`);
      if (c.topic) bits.push('changed the topic');
      if (c.category) bits.push(`moved it to ${quoted(c.category.to)}`);
      if (c.slowmode) bits.push(c.slowmode.to ? `set slowmode to ${c.slowmode.to < 60 ? plural(c.slowmode.to, 'second', 'seconds') : duration(Math.round(c.slowmode.to / 60))}` : 'turned slowmode off');
      if (c.disappear) bits.push(c.disappear.to ? `set disappearing messages to ${timerLabel(c.disappear.to).toLowerCase()}` : 'turned disappearing messages off');
      return [[who, ` changed ${ch}`], [bits.length ? `${bits.join('; ')}.`.replace(/^./, (x) => x.toUpperCase()) : null, d.voiceChat ? VOICE_CHAT_NOTE : null].filter(Boolean).join(' ') || null];
    }
    case 'channel_delete': return [[who, ` deleted ${theChannel(d, true)}`]];
    // One channel dragged (or moved from its menu) is named; a bigger reorder says how many moved.
    case 'channel_reorder': return [[who, d.channel ? ` moved ${ch} in the channel list` : ` reordered the channels (${plural(d.count || 0, 'channel', 'channels')} moved)`]];
    case 'category_reorder': return [[who, ' reordered the categories']];
    case 'category_rename': return [[who, ` renamed the category ${quoted(d.from || '')} to ${quoted(d.to || '')}`]];
    case 'channel_overrides': {
      const lines = (d.changes || []).map((o) => {
        const target = o.type === 'member' ? nameOf(users, o.id) : o.name || 'a role';
        const was = o.was || { allow: 0, deny: 0 };
        const parts = [];
        const allowed = o.allow & ~was.allow; const denied = o.deny & ~was.deny; const reset = (was.allow | was.deny) & ~(o.allow | o.deny);
        if (allowed) parts.push(`allowed ${list(permNames(allowed))}`);
        if (denied) parts.push(`denied ${list(permNames(denied))}`);
        if (reset) parts.push(`reset ${list(permNames(reset))}`);
        return `${target}: ${parts.join('; ') || 'changed'}`;
      });
      return [[who, ` changed permissions in ${ch}`], [lines.length ? lines.join(' · ') : null, d.voiceChat ? VOICE_CHAT_NOTE : null].filter(Boolean).join('. ') || null];
    }
    case 'invite_create': return [[who, ` created an invite (${e.targetId})`], [d.maxUses ? `Works ${plural(d.maxUses, 'time', 'times')}` : 'No use limit', d.hours ? `expires after ${duration(d.hours * 60)}` : 'never expires'].join(', ') + '.'
      + (d.last ? ' More invites they made this hour aren’t listed.' : '')];
    case 'invite_revoke': return [[who, ` revoked the invite ${e.targetId}`, d.creatorId && d.creatorId !== e.actorId ? ` made by ${nameOf(users, d.creatorId)}` : '', d.uses !== undefined ? ` (used ${plural(d.uses, 'time', 'times')})` : ''],
      d.last ? 'More invites they revoked this hour aren’t listed.' : null];
    case 'emoji_create': return [[who, ` added the emoji :${d.name}:`]];
    case 'emoji_rename': return [[who, ` renamed the emoji :${d.from}: to :${d.to}:`]];
    case 'emoji_delete': return [[who, ` deleted the emoji :${d.name}:`]];
    case 'webhook_create': return [[who, d.name ? ` created the webhook ${quoted(d.name)} in ${ch}` : ` created a webhook in ${ch}`, d.pings ? ' (it may ping)' : '']];
    case 'webhook_update': return [[who, d.name ? ` changed the webhook ${quoted(d.name)} in ${ch}` : ` changed a webhook in ${ch}`],
      [d.renamed ? `Renamed from ${quoted(d.renamed.from)}.` : null, d.pings !== undefined ? (d.pings ? 'It may ping now.' : 'It can’t ping any more.') : null].filter(Boolean).join(' ') || null];
    case 'webhook_rotate': return [[who, d.name ? ` gave the webhook ${quoted(d.name)} in ${ch} a new address` : ` gave a webhook in ${ch} a new address`]];
    case 'webhook_delete': return [[who, d.name ? ` deleted the webhook ${quoted(d.name)} in ${ch}` : ` deleted a webhook in ${ch}`]];
    case 'bot_add': return [[who, ` added the bot ${quoted(d.name || '')}`], d.scopes ? `Allowed: ${d.scopes.join(', ') || 'nothing yet'}; channels: ${d.channels === 'all' ? 'all public ones' : d.channels}.` : null];
    case 'bot_update': return [[who, ` changed what the bot ${quoted(d.name || '')} may do`], [d.scopes ? `Allowed: ${d.scopes.join(', ') || 'nothing'}; channels: ${d.channels === 'all' ? 'all public ones' : d.channels}.` : null, d.paused !== undefined ? (d.paused ? 'Paused it.' : 'Resumed it.') : null].filter(Boolean).join(' ') || null];
    case 'bot_remove': return [[who, ` removed the bot ${quoted(d.name || '')}`]];
    case 'voice_disconnect': return [[who, ' disconnected ', them, ` from ${ch}`]];
    case 'voice_move': return [[who, ' moved ', them, ` from ${ch} to ${channelText(d.toChannel)}`]];
    case 'voice_mute': return [[who, ' server-muted ', them, d.channel ? ` (in ${ch})` : '']];
    case 'voice_unmute': return [[who, ' lifted the server mute of ', them]];
    case 'server_update': {
      const ch2 = (d.changes || []).filter((k) => k !== 'name' && k !== 'hideHistory' && k !== 'invitePreview').map((k) => SETTING[k] || k);
      const out = [who];
      if (d.name) out.push(` renamed the server from ${quoted(d.name.from)} to ${quoted(d.name.to)}`);
      if (ch2.length) out.push(`${d.name ? ' and' : ''} ${d.removed ? 'removed' : 'changed'} ${list(ch2)}`);
      // "New members can't read messages from before they joined" (the entry says which way it went).
      if ((d.changes || []).includes('hideHistory')) out.push(`${d.name || ch2.length ? ' and' : ''} turned ${d.hideHistory ? 'on' : 'off'} ${quoted('New members can’t read messages from before they joined')}`);
      // Invite link previews showing the server's name (server/invitepreview.js), the same way.
      if ((d.changes || []).includes('invitePreview')) out.push(`${d.name || ch2.length || (d.changes || []).includes('hideHistory') ? ' and' : ''} turned ${d.invitePreview ? 'on' : 'off'} ${quoted('Show this server’s name and member count in invite link previews')}`);
      return [out];
    }
    case 'server_transfer': return [[who, ' made ', them, ' the owner', d.from ? ` (it was ${nameOf(users, d.from)})` : '']];
    // The server's suggested word filter (server/wordfilter.js): what was added and removed, and what it does now.
    case 'word_filter_update': {
      const words = (xs, more) => `${list((xs || []).map(quoted))}${more ? ` and ${more} more` : ''}`;
      const bits = [];
      if ((d.added || []).length) bits.push(`Added ${words(d.added, d.addedMore)}.`);
      if ((d.removed || []).length) bits.push(`Removed ${words(d.removed, d.removedMore)}.`);
      if (d.action && d.action.to) bits.push(d.action.to === 'blur' ? 'Members’ apps blur matching messages.' : 'Members’ apps hide matching messages.');
      // An entry whose details were too long to keep (only older ones lost even the count): never read as "cleared".
      if (d.truncated && typeof d.count !== 'number') return [[who, ' changed the server’s suggested word filter (details too long to keep)']];
      if (!d.count) return [[who, ' cleared the server’s suggested word filter'], bits.join(' ') || null];
      return [[who, ` changed the server’s suggested word filter (${plural(d.count, 'entry', 'entries')})`], bits.join(' ') || null];
    }
    default: return [[who, ` ${String(e.action || '').replace(/_/g, ' ')}`]];
  }
}

// ------------------------------------------------------------------ Audit log tab
const LIVE_GAP = 3000; // fetch new entries at most this often, however many notices come
const MAX_MEMBERS = 1000; // members suggested in the person box (everyone the log has shown is too)
export async function auditTab(s, body, { memberIds = [], userOf = () => null } = {}) {
  const root = h('div', { class: 'stack audit' });
  const kind = h('select', { class: 'input sm', 'aria-label': 'Show' }, AUDIT_KINDS.map(([k, l]) => h('option', { value: k }, l)));
  // Anyone, by username: suggestions are this server's members and everyone the log has shown so far, and a name
  // it doesn't know is looked up by the server (someone banned or kicked long ago isn't a member any more).
  const people = h('datalist', { id: `audit-people-${s.id}` });
  const person = h('input', { class: 'input sm', type: 'search', list: people.id, 'aria-label': 'Done by or to', placeholder: 'Anyone (username)', autocomplete: 'off', spellcheck: 'false', maxlength: '64' });
  const known = new Map(); // lowercased username -> { id, username, name }
  const know = (id, u) => {
    if (!u || !u.username || known.has(u.username.toLowerCase())) return;
    const name = (u.profile && u.profile.displayName) || u.displayName || u.username;
    known.set(u.username.toLowerCase(), { id, username: u.username, name });
    people.append(h('option', { value: u.username, label: name !== u.username ? name : null }));
  };
  const learn = (map) => Object.entries(map || {}).forEach(([id, u]) => { if (!u.deleted) know(id, u); });
  // What's typed: a username (with or without @), or a display name only one known person has.
  const lookup = (typed) => {
    const t = typed.toLowerCase();
    if (known.has(t)) return known.get(t);
    const named = [...known.values()].filter((p) => p.name.toLowerCase() === t);
    return named.length === 1 ? named[0] : null;
  };
  const listEl = h('div', { class: 'audit-list', role: 'list', 'aria-live': 'polite' });
  const more = h('button', { class: 'btn ghost sm', hidden: true }, 'Older entries');
  const empty = h('div', { class: 'panel-empty', hidden: true }, icon('file'), h('p', null, 'Nothing here yet.'));
  let newest = 0; let next = null; let users = {};
  const query = (extra) => {
    const q = new URLSearchParams(extra);
    const k = AUDIT_KINDS.find((x) => x[0] === kind.value);
    if (k && k[2]) q.set('action', k[2].join(','));
    const typed = person.value.trim().replace(/^@/, '');
    const p = typed && lookup(typed);
    if (p) q.set('user', p.id);
    else if (typed) q.set('username', typed);
    return `/servers/${s.id}/audit?${q}`;
  };
  const row = (e) => {
    const [parts, second] = sentence(e, users);
    const actor = personOf(users, e.actorId);
    return h('div', { class: 'audit-row', role: 'listitem', dataset: { id: String(e.id) } },
      actor ? avatarEl(actor, 30) : h('span', { class: 'audit-sys', 'aria-hidden': 'true' }, icon('shield')),
      h('div', { class: 'audit-text' }, h('div', null, ...parts, '.'), second ? h('div', { class: 'audit-sub' }, second) : null),
      h('time', { class: 'audit-time', datetime: new Date(e.createdAt).toISOString(), title: new Date(e.createdAt).toLocaleString() }, fmtStamp(e.createdAt)));
  };
  const load = async () => {
    const r = await api('GET', query({ limit: '50' }));
    users = r.users || {};
    learn(users);
    clear(listEl).append(...r.entries.map(row));
    // A reload brings the newest, so nothing that came in while it ran is missed.
    newest = Math.max(newest, r.entries.length ? r.entries[0].id : 0);
    next = r.next;
    more.hidden = !r.hasMore;
    empty.hidden = r.entries.length > 0;
  };
  more.onclick = async () => {
    more.disabled = true;
    try {
      const r = await api('GET', query({ limit: '50', before: String(next) }));
      Object.assign(users, r.users || {});
      learn(r.users);
      listEl.append(...r.entries.map(row));
      next = r.next;
      more.hidden = !r.hasMore;
    } catch (x) { toast(x.message, 'error'); }
    more.disabled = false;
  };
  // New entries while it's open: fetched with the same filters, added on top (or the whole list again if many came).
  // A busy moment sends a notice every couple of seconds: at most one fetch per LIVE_GAP, and a notice that comes
  // while one is running or waiting means one more fetch afterwards, never a lost one (?after= gets all since).
  let fetching = false; let dirty = false; let timer = null; let lastFetch = 0;
  const onNew = () => {
    dirty = true;
    if (fetching || timer) return;
    timer = setTimeout(fetchNew, Math.max(0, lastFetch + LIVE_GAP - Date.now()));
  };
  const fetchNew = async () => {
    timer = null;
    if (!root.isConnected) return;
    dirty = false; fetching = true; lastFetch = Date.now();
    try {
      const r = await api('GET', query({ after: String(newest), limit: '100' }));
      Object.assign(users, r.users || {});
      learn(r.users);
      if (r.hasMore) await load();
      else if (r.entries.length) { listEl.prepend(...r.entries.map(row)); newest = r.entries[0].id; empty.hidden = true; }
    } catch { /* the next notice tries again, from the same place */ }
    fetching = false;
    if (dirty) onNew();
  };
  const reload = () => load().catch((x) => toast(x.message, 'error'));
  kind.onchange = reload;
  // On Enter, picking a suggestion or leaving the box; and when it's cleared.
  person.onchange = reload;
  person.addEventListener('input', () => { if (!person.value) reload(); });
  for (const id of memberIds.slice(0, MAX_MEMBERS)) know(id, userOf(id));
  clear(body).append(root);
  root.append(h('h3', null, 'Audit log'),
    h('p', { class: 'muted-p' }, 'Who did what in this server: moderation, roles, channels, permissions, invites and settings, newest first. Never what anyone wrote. Entries can’t be edited or deleted, and are kept for a year (the newest 10,000).'),
    h('div', { class: 'row gap wrap audit-filters' }, field('Show', kind), field('Done by or to', person), people),
    listEl, empty, h('div', null, more));
  try { await load(); } catch (x) { clear(root).append(h('p', { class: 'form-error' }, x.message)); return; }
  if (watching && watching.serverId !== s.id) watch(watching.serverId, false);
  watching = { serverId: s.id, onNew, alive: () => root.isConnected };
  watch(s.id, true);
}

// ------------------------------------------------------------------ Reports tab
export async function reportsTab(s, body, { jumpTo = null, onCount = null } = {}) {
  const root = h('div', { class: 'stack' });
  let status = 'open';
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Which reports' });
  const listEl = h('div', { class: 'stack' });
  const more = h('button', { class: 'btn ghost sm', hidden: true }, 'Older reports');
  let next = null; let users = {};
  const set = async (r, st, note) => {
    try {
      await api('PATCH', `/servers/${s.id}/reports/${r.id}`, note === undefined ? { status: st } : { status: st, note });
      toast(st === 'handled' ? 'Marked as handled.' : st === 'dismissed' ? 'Dismissed.' : 'Reopened.');
      await load();
    } catch (x) { toast(x.message, 'error'); }
  };
  const noteThen = (title, st, r) => {
    const note = h('input', { class: 'input', maxlength: '500', placeholder: 'Optional: what you did, for the other moderators' });
    if (r.note) note.value = r.note;
    modal({ title, size: 'sm', body: field('Note', note), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: () => set(r, st, note.value) }] });
  };
  const card = (r) => {
    const target = personOf(users, r.targetId);
    const handler = r.handledBy ? nameOf(users, r.handledBy) : null;
    return h('div', { class: `report-card st-${r.status === 'open' ? 'open' : 'done'}`, role: 'listitem' },
      h('div', { class: 'report-top' },
        h('span', { class: `badge-tag cat-${r.category}` }, CATEGORY_LABEL[r.category] || r.category),
        h('span', { class: 'stat-sub' }, `${fmtStamp(r.createdAt)} · ${r.status === 'open' ? 'open' : r.status}`),
        r.staffStatus === 'resolved' || r.staffStatus === 'dismissed' ? h('span', { class: 'badge-tag' }, `${brand()} staff: ${r.staffStatus}`) : null),
      h('div', { class: 'row gap tight' }, h('span', { class: 'field-label' }, 'Reported'), target ? avatarEl(target, 22) : null, h('strong', null, target ? target.profile.displayName : 'Deleted user'),
        target ? h('span', { class: 'stat-sub' }, `@${target.username}`) : null),
      h('p', { class: 'stat-sub' }, r.context.kind === 'message' ? `A message in ${r.context.channelName ? `#${r.context.channelName}` : 'a channel'}` : 'A report about the member'),
      r.details ? h('blockquote', { class: 'report-details' }, r.details) : null,
      r.evidence.length ? h('div', { class: 'evidence' },
        h('p', { class: 'field-hint' }, 'Their messages that the reporter chose to share, from the reporter’s device. Who sent them and when is checked by the server; the wording comes from the reporter. Who reported isn’t shown, and nor is anyone else’s message: the channel has those.'),
        ...r.evidence.map((e) => {
          const a = personOf(users, e.authorId);
          return h('div', { class: `ev${e.reported ? ' reported' : ''}` }, a ? avatarEl(a, 22) : null,
            h('div', { class: 'ev-body' }, h('div', { class: 'ev-meta' }, h('strong', null, a ? a.profile.displayName : 'Deleted user'), h('span', null, fmtStamp(e.createdAt)), e.reported ? h('span', { class: 'badge-tag bad' }, 'Reported') : null),
              h('div', { class: 'ev-text', html: e.text ? md(e.text) : '' }, e.text ? null : (e.files && e.files.length ? `[${e.files.join(', ')}]` : '(no text)'))));
        })) : null,
      // This server hides messages from before someone joined (server/joinhistory.js): shared ones from before you did too.
      r.evidenceHidden ? h('p', { class: 'field-hint' }, `${r.evidenceHidden === 1 ? 'One shared message is' : `${r.evidenceHidden} shared messages are`} from before you joined, so ${r.evidenceHidden === 1 ? 'it isn’t' : 'they aren’t'} shown: this server hides older messages from new members.`) : null,
      r.note || handler ? h('p', { class: 'stat-sub' }, [r.note ? `Note: ${r.note}` : '', handler && r.status !== 'open' ? `${r.status === 'handled' ? 'Handled' : 'Dismissed'} by ${handler}${r.handledAt ? `, ${fmtStamp(r.handledAt)}` : ''}` : ''].filter(Boolean).join(' — ')) : null,
      h('div', { class: 'report-actions' },
        jumpTo && r.context.messageId ? h('button', { class: 'btn ghost sm', onclick: () => jumpTo(r.context.messageId) }, 'Go to message') : null,
        r.status === 'open' ? h('button', { class: 'btn primary sm', onclick: () => noteThen('Mark as handled', 'handled', r) }, 'Mark handled') : null,
        r.status === 'open' ? h('button', { class: 'btn ghost sm', onclick: () => noteThen('Dismiss report', 'dismissed', r) }, 'Dismiss') : null,
        r.status !== 'open' ? h('button', { class: 'btn ghost sm', onclick: () => set(r, 'open') }, 'Reopen') : null));
  };
  const drawSeg = () => clear(seg).append(...[['open', 'Open'], ['handled', 'Handled'], ['dismissed', 'Dismissed'], ['all', 'All']].map(([k, l]) => h('button', {
    class: `seg-btn${status === k ? ' active' : ''}`, 'aria-pressed': status === k ? 'true' : 'false', onclick: () => { status = k; drawSeg(); load().catch((x) => toast(x.message, 'error')); },
  }, l)));
  const load = async (append = false) => {
    const r = await api('GET', `/servers/${s.id}/reports?status=${status}${append && next ? `&before=${next}` : ''}`);
    users = append ? { ...users, ...r.users } : r.users || {};
    if (!append) clear(listEl);
    listEl.append(...r.reports.map(card));
    if (!listEl.children.length) listEl.append(h('div', { class: 'panel-empty' }, icon('shield'), h('p', null, status === 'open' ? 'No open reports.' : 'Nothing here.')));
    next = r.next; more.hidden = !next;
    if (onCount) onCount(r.open);
  };
  more.onclick = () => load(true).catch((x) => toast(x.message, 'error'));
  drawSeg();
  clear(body).append(root);
  root.append(h('h3', null, 'Reports'),
    h('p', { class: 'muted-p' }, `Reports about messages and members of this server, for its moderators. The staff of ${brand()} get every report too and handle them on their own. You see reports about people below your highest role, from channels you can see.`),
    seg, h('div', { class: 'stack', role: 'list' }, listEl), h('div', null, more));
  try { await load(); } catch (x) { clear(root).append(h('p', { class: 'form-error' }, x.message)); return; }
  reportsOpen = { serverId: s.id, reload: () => load().catch(() => {}), alive: () => root.isConnected };
}
