// Add a server → Import from Discord (docs/IMPORT.md): start a new server from a Discord server template.
//   1. The person pastes the template's JSON (or chooses it as a file). Hearth never contacts Discord: given a
//      template link, this only builds the address to open in their own browser.
//   2. The server works out the plan (server/discordmap.js) and this shows it: roles, channels by category, what
//      Hearth would allow that Discord didn't, and everything that won't come over, before anything exists.
//      Roles and channels can be left out; the plan is worked out again on the server each time (a moment after
//      the last change, and never once Create was pressed or the dialog closed).
//   3. Create: the server builds it again from the template (never from this plan) and the importer owns it.
// Everything from the template is shown as text (h() text nodes), never as HTML.
import { h, clear, icon, toast, copyText } from './util.js';
import { api } from './api.js';
import { modal, field } from './ui.js';
import { PERMS, PERM_GROUPS } from './perms.js';

const MAX_TEXT = 1.5 * 1024 * 1024; // a little under the server's 2 MB request cap

// "https://discord.new/CODE", "discord.com/template/CODE" (or discordapp.com), or a bare code → { code }.
// An invite link → { invite: true }. Anything else → null.
export function templateCode(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^(?:https?:\/\/)?(?:www\.|ptb\.|canary\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)/i.test(s)) return { invite: true };
  const m = /^(?:https?:\/\/)?(?:www\.|ptb\.|canary\.)?(?:discord\.new\/|discord(?:app)?\.com\/template\/)([A-Za-z0-9_-]{2,64})\/?(?:[?#].*)?$/i.exec(s)
    || /^([A-Za-z0-9_-]{2,64})$/.exec(s);
  return m ? { code: m[1] } : null;
}
const apiUrl = (code) => `https://discord.com/api/v10/guilds/templates/${encodeURIComponent(code)}`;

// ------------------------------------------------------------------ words
// Discord's permission names, as Discord shows them.
const DISCORD_LABEL = {
  CREATE_INSTANT_INVITE: 'Create invite', KICK_MEMBERS: 'Kick members', BAN_MEMBERS: 'Ban members', ADMINISTRATOR: 'Administrator',
  MANAGE_CHANNELS: 'Manage channels', MANAGE_GUILD: 'Manage server', ADD_REACTIONS: 'Add reactions', VIEW_AUDIT_LOG: 'View audit log',
  PRIORITY_SPEAKER: 'Priority speaker', STREAM: 'Video', VIEW_CHANNEL: 'View channels', SEND_MESSAGES: 'Send messages',
  SEND_TTS_MESSAGES: 'Send text-to-speech messages', MANAGE_MESSAGES: 'Manage messages', EMBED_LINKS: 'Embed links', ATTACH_FILES: 'Attach files',
  READ_MESSAGE_HISTORY: 'Read message history', MENTION_EVERYONE: 'Mention @everyone', USE_EXTERNAL_EMOJIS: 'Use external emoji',
  VIEW_GUILD_INSIGHTS: 'View server insights', CONNECT: 'Connect', SPEAK: 'Speak', MUTE_MEMBERS: 'Mute members', DEAFEN_MEMBERS: 'Deafen members',
  MOVE_MEMBERS: 'Move members', USE_VAD: 'Use voice activity', CHANGE_NICKNAME: 'Change nickname', MANAGE_NICKNAMES: 'Manage nicknames',
  MANAGE_ROLES: 'Manage roles', MANAGE_WEBHOOKS: 'Manage webhooks', MANAGE_GUILD_EXPRESSIONS: 'Manage expressions',
  USE_APPLICATION_COMMANDS: 'Use application commands', REQUEST_TO_SPEAK: 'Request to speak', MANAGE_EVENTS: 'Manage events',
  MANAGE_THREADS: 'Manage threads', CREATE_PUBLIC_THREADS: 'Create public threads', CREATE_PRIVATE_THREADS: 'Create private threads',
  USE_EXTERNAL_STICKERS: 'Use external stickers', SEND_MESSAGES_IN_THREADS: 'Send messages in threads', USE_EMBEDDED_ACTIVITIES: 'Use activities',
  MODERATE_MEMBERS: 'Timeout members', VIEW_CREATOR_MONETIZATION_ANALYTICS: 'View monetization analytics', USE_SOUNDBOARD: 'Use soundboard',
  CREATE_GUILD_EXPRESSIONS: 'Create expressions', CREATE_EVENTS: 'Create events', USE_EXTERNAL_SOUNDS: 'Use external sounds',
  SEND_VOICE_MESSAGES: 'Send voice messages', SET_VOICE_CHANNEL_STATUS: 'Set voice channel status', SEND_POLLS: 'Create polls',
  USE_EXTERNAL_APPS: 'Use external apps', PIN_MESSAGES: 'Pin messages', BYPASS_SLOWMODE: 'Bypass slowmode',
};
const discordLabel = (bit) => DISCORD_LABEL[bit] || bit.replace(/^BIT_(\d+)$/, 'Unknown permission $1');
// Why one doesn't come over, where it's not obvious.
const WHY_LOST = {
  PIN_MESSAGES: 'in Hearth it’s part of Manage messages', BYPASS_SLOWMODE: 'in Hearth it’s part of Manage messages',
  MODERATE_MEMBERS: 'in Hearth, timeouts need Kick members', MANAGE_EVENTS: 'in Hearth it’s part of Manage server and Manage channels',
  MANAGE_WEBHOOKS: 'in Hearth it’s part of Manage channels', CREATE_GUILD_EXPRESSIONS: 'in Hearth it’s part of Manage emoji',
  CREATE_PUBLIC_THREADS: 'Hearth’s Reply in threads needs both thread permissions', SEND_MESSAGES_IN_THREADS: 'Hearth’s Reply in threads needs both thread permissions',
  CHANGE_NICKNAME: 'only for the whole server', MANAGE_NICKNAMES: 'only for the whole server',
  CREATE_INSTANT_INVITE: 'Hearth invites are for the whole server', MUTE_MEMBERS: 'a Hearth server mute holds in every voice channel',
  KICK_MEMBERS: 'only for the whole server', BAN_MEMBERS: 'only for the whole server',
  // Granted in one channel only (these come over, but do less there than in Discord).
  MANAGE_CHANNELS: 'in Hearth, editing a channel takes Manage channels for the whole server',
  MANAGE_ROLES: 'in Hearth, changing a channel’s permissions takes Manage roles for the whole server',
  EMBED_LINKS: 'in Hearth, link previews take Show link previews for the whole server: a channel can turn them off, not on',
};
// What Hearth allows anyway, for permissions Discord withheld.
const WHY_WIDENED = {
  READ_MESSAGE_HISTORY: 'anyone who can see a Hearth channel can read all of its history',
  CREATE_EVENTS: 'anyone who can post in a channel can make events',
  SEND_POLLS: 'anyone who can post can make a poll',
  SEND_VOICE_MESSAGES: 'anyone who can post and attach files can send a voice message',
  // What a Hearth permission includes that the role (or the channel) didn't allow in Discord.
  MODERATE_MEMBERS: 'in Hearth, Kick members also times people out',
  MANAGE_WEBHOOKS: 'in Hearth, Manage channels and Manage server also manage webhooks, which post under any name',
  MANAGE_EVENTS: 'in Hearth, Manage channels and Manage server also change and delete anyone’s events',
  PIN_MESSAGES: 'in Hearth, Manage messages also pins messages',
  BYPASS_SLOWMODE: 'in Hearth, Manage messages and Manage channels also skip slowmode',
  CREATE_INSTANT_INVITE: 'Hearth invites are for the whole server: anyone with Create invites can still make one',
  MUTE_MEMBERS: 'a Hearth server mute holds in every voice channel: anyone with Mute members can still mute people there',
};
const REASON = {
  managed: 'managed by Discord (a bot’s or booster role)', limit: 'over the 100 roles a server can have (leave others out to bring it)',
  excluded: 'you left it out', empty: 'no channels left in it', type_10: 'threads don’t come with a template', type_11: 'threads don’t come with a template',
  type_12: 'threads don’t come with a template', type_14: 'directory channels aren’t something Hearth has',
};
const reasonText = (r) => REASON[r] || (r && r.startsWith('type_') ? `this kind of channel (type ${r.slice(5)}) isn’t something Hearth has` : r);
const NOTE = {
  member_overwrite_dropped: 'Permissions for single members (a template carries no members)',
  overwrite_role_missing: 'Permissions for roles that aren’t coming',
  override_limit: 'Permissions past 100 per channel',
  nsfw_dropped: 'Age-restricted (NSFW) flag',
  user_limit_dropped: 'User limit',
  forum_tags_dropped: 'Forum tags',
  topic_trimmed: 'Topic shortened to 300 characters',
};
const SETTING = {
  verification_level: () => 'Verification level',
  explicit_content_filter: () => 'Explicit media content filter',
  default_message_notifications: () => 'Default notifications (only @mentions)',
  afk_channel: (v) => `AFK channel${v ? ` (“${v}”)` : ''}`,
  system_channel: (v) => `System messages channel${v ? ` (“${v}”)` : ''}`,
  icon: () => 'Server icon (add it in Server settings → Overview)',
};
const CONVERTED = { announcement: 'Announcement channel → text', stage: 'Stage → voice, listen-only except moderators', forum: 'Forum → text' };

// A role's Hearth permissions, in the role editor's words.
const HEARTH_LABELS = PERM_GROUPS.flatMap(([, list]) => list.map(([k, l]) => [k, l]));
function hearthPerms(bits) {
  if (bits & PERMS.ADMINISTRATOR) return 'Administrator';
  const names = HEARTH_LABELS.filter(([k]) => bits & PERMS[k]).map(([, l]) => l);
  return names.length ? names.join(', ') : 'No permissions of its own';
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A list of names the server cut short (it says how many more there are).
const nameList = (list, more) => `${list.join(', ')}${more ? ` and ${more} more` : ''}`;

// Everything that won't come over, as [{ title, items: [text] }] (shown as lists, or copied as plain text).
function leftBehind(report) {
  const out = [];
  const add = (title, items) => { if (items.length) out.push({ title, items }); };
  const warn = (code) => report.warnings.filter((w) => w.code === code);
  add('Permissions Hearth doesn’t have', report.lost.map((l) => `${discordLabel(l.bit)}: ${nameList(l.where, l.more)}${WHY_LOST[l.bit] ? ` (${WHY_LOST[l.bit]})` : ''}`));
  add('Permissions Hearth can’t set per channel', report.dropped.map((l) => `${discordLabel(l.bit)}: ${nameList(l.where, l.more)}${WHY_LOST[l.bit] ? ` (${WHY_LOST[l.bit]})` : ''}`));
  add('Roles', [
    ...report.skipped.filter((s) => s.kind === 'role').map((s) => `${s.name}: ${reasonText(s.reason)}`),
    ...warn('role_icon_image_dropped').map((w) => `${w.name}: its picture icon (emoji icons come over)`),
    ...warn('bad_permissions').map((w) => `${w.name}: its permissions couldn’t be read, so it gets none`),
  ]);
  add('Channels and categories', [
    ...report.skipped.filter((s) => s.kind !== 'role').map((s) => `${s.kind === 'category' ? 'Category' : 'Channel'} ${s.name}: ${reasonText(s.reason)}`),
    ...warn('category_permissions_dropped').map((w) => `Category ${w.name}: its own permissions (each channel keeps its own)`),
  ]);
  add('Channel settings', report.channelNotes.map((n) => `${NOTE[n.code] || n.code}: ${nameList(n.channels, n.more)}`));
  add('Server settings', report.unmapped.map((u) => (SETTING[u.field] ? SETTING[u.field](u.value) : u.field)));
  add('Also', [
    ...warn('unreadable_items').map((w) => `${plural(w.count, 'item')} in the template couldn’t be read`),
    ...warn('added_default_channel').map(() => 'There were no channels to bring, so it starts with #general'),
  ]);
  return out;
}
// What Hearth will allow that Discord didn't, and moderator powers everyone who joins will have.
function widenedLines(plan) {
  const warn = (code) => plan.report.warnings.filter((w) => w.code === code);
  const lines = plan.report.widened.map((w) => `${discordLabel(w.bit)} (${nameList(w.where, w.more)}): ${WHY_WIDENED[w.bit] || 'Hearth has no separate permission for it'}`);
  for (const w of warn('override_limit_widened')) lines.push(`Permissions past 100 per channel (${nameList(w.channels, w.more)}): any that held a role back there won’t come, so that role can do more there`);
  if (warn('everyone_manage').length) lines.unshift('@everyone has moderator powers in this template, so everyone who joins will have them too');
  for (const w of warn('everyone_channel_manage')) lines.unshift(`@everyone has moderator powers in some channels (${nameList(w.channels, w.more)}), so everyone who joins will have them there too`);
  return lines;
}

function groupsEl(groups) {
  return h('div', { class: 'di-groups' }, groups.map((g) => h('div', null, h('h4', null, g.title), h('ul', { class: 'perk-list' }, g.items.map((t) => h('li', null, t))))));
}
function reportText(name, plan) {
  const c = plan.report.counts;
  const lines = [`Imported from Discord: ${name}`, `${plural(c.roles, 'role')}, ${plural(c.categories, 'category', 'categories')}, ${plural(c.channels, 'channel')}.`];
  const wide = widenedLines(plan);
  if (wide.length) lines.push('', 'Hearth allows more than Discord did:', ...wide.map((t) => `- ${t}`));
  for (const g of leftBehind(plan.report)) lines.push('', `${g.title}:`, ...g.items.map((t) => `- ${t}`));
  return lines.join('\n');
}

// ------------------------------------------------------------------ step 1: paste
// ctx: { S, sec, openServer(id), back() } — back() reopens "Add a server".
export function openDiscordImport(ctx, keep = {}) {
  const link = h('input', { class: 'input', placeholder: 'https://discord.new/…', value: keep.link || '', autocomplete: 'off', spellcheck: 'false' });
  const linkHint = h('span', { class: 'field-hint', 'aria-live': 'polite' });
  const json = h('textarea', { class: 'input mono di-json', rows: '6', spellcheck: 'false', autocomplete: 'off', placeholder: '{"code": "…", "serialized_source_guild": {…}}' });
  json.value = keep.text || '';
  const showLink = () => {
    clear(linkHint);
    const t = templateCode(link.value);
    if (!link.value.trim()) linkHint.append('Optional: paste it here and Hearth gives you the address to open.');
    else if (t && t.invite) linkHint.append('That’s an invite link. You need the server template link (Server Settings → Server Template in Discord).');
    else if (!t) linkHint.append('That doesn’t look like a Discord template link.');
    else {
      linkHint.append('Open ', h('a', { href: apiUrl(t.code), target: '_blank', rel: 'noopener noreferrer', class: 'di-api-link' }, 'the template as text'),
        ' in your browser, select everything on that page (Ctrl+A), copy it and paste it below (in Firefox, switch to “Raw Data” first). Or save that page (Ctrl+S) and choose the file.');
    }
  };
  link.addEventListener('input', showLink);
  showLink();
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json,.txt', hidden: true });
  const m = modal({
    title: 'Import from Discord', size: 'md',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted-p' }, 'Start a new server with a Discord server’s roles, categories, channels and channel permissions. You’ll see what comes over, and what doesn’t, before anything is made. Members, messages and emoji don’t come with it.'),
      h('ol', { class: 'perk-list' },
        h('li', null, 'In Discord, open the server’s settings → Server Template and copy its link (it takes Manage Server there).'),
        h('li', null, 'Paste the link here: Hearth gives you an address to open. Hearth itself never contacts Discord.'),
        h('li', null, 'Copy everything that page shows and paste it below.')),
      field('Template link', link, linkHint),
      field('Template', json, 'The whole template, or just its "serialized_source_guild" part.'),
      h('div', { class: 'row gap' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => fileIn.click() }, icon('file'), 'Choose a file'), fileIn)),
    actions: [
      { label: 'Back', action: () => ctx.back() },
      { label: 'Preview', kind: 'primary', action: async () => {
        const text = json.value.trim();
        if (!text) throw new Error('Paste the template first.');
        if (text.length > MAX_TEXT) throw new Error('That’s too big to be a Discord server template.');
        let template;
        try { template = JSON.parse(text); } catch {
          throw new Error('That isn’t the template’s text. Open the template address, select everything on the page, copy it and paste it here.');
        }
        const first = await api('POST', '/imports/discord/preview', { template });
        openPreview(ctx, { link: link.value, text, template, first });
      } },
    ],
  });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    if (f.size > MAX_TEXT) { toast('That file is too big to be a Discord server template.', 'error'); return; }
    json.value = await f.text();
    json.focus();
  });
  return m;
}

// ------------------------------------------------------------------ step 2: preview, leave things out, create
function openPreview(ctx, state) {
  let plan = state.first.plan;
  const skipRoles = new Set(plan.roles.filter((r) => r.skip === 'excluded').map((r) => r.key));
  const skipChannels = new Set();
  const nameIn = h('input', { class: 'input', maxlength: '64', value: plan.name });
  const summary = h('p', { class: 'muted-p', 'aria-live': 'polite' });
  const problems = h('div');
  const wide = h('div');
  const left = h('div');
  const adminOk = h('input', { type: 'checkbox' });
  let createBtn = null;
  // Create was pressed and hasn't been answered: nothing turns the button back on meanwhile (a second press would
  // make a second server).
  let creating = false;
  const ready = () => !creating && !plan.problems.length && (!plan.everyone.dangerous || adminOk.checked);
  const syncButton = () => { if (createBtn) createBtn.disabled = !ready(); };
  adminOk.addEventListener('change', syncButton);

  // ---- the parts that change when something is left out (worked out again on the server)
  const roleRows = new Map(); const channelRows = new Map();
  function draw() {
    const c = plan.report.counts;
    const groups = leftBehind(plan.report);
    summary.textContent = `Creates ${plural(c.roles, 'role')}, ${plural(c.categories, 'category', 'categories')} and ${plural(c.channels, 'channel')}, with ${plural(c.overrides, 'channel permission')}. You’ll own it, and nobody else is in it until you invite people.`
      + (groups.length ? ' Some things won’t come over: they’re listed under “These will be skipped”, at the end.' : '');
    clear(problems);
    for (const p of plan.problems) {
      problems.append(h('p', { class: 'warn-box bad', role: 'alert' }, p.code === 'too_many_channels'
        ? `That’s ${p.count} channels; Hearth brings up to ${p.max} at once. Leave some out below.`
        : p.code === 'too_many_overrides'
          ? `That’s ${p.count} channel permissions; Hearth brings up to ${p.max} at once. Leave out some channels or roles below.`
          : `That’s ${p.count} categories; a Hearth server has up to ${p.max}. Leave out some channels (a category goes when all its channels do).`));
    }
    if (state.first.source.isDirty) problems.append(h('p', { class: 'warn-box' }, 'This template has changes that weren’t synced in Discord, so it may be out of date. Ask the Discord server’s admin to sync it, then copy it again.'));
    clear(wide);
    const lines = widenedLines(plan);
    if (plan.everyone.dangerous || lines.length) {
      wide.append(h('div', { class: 'warn-box stack tight' },
        h('strong', null, 'Hearth will allow more than Discord did'),
        plan.everyone.dangerous ? h('label', { class: 'row gap tight' }, adminOk, h('span', null, 'In this template @everyone is an Administrator: everyone who joins could do anything. I understand.')) : null,
        lines.length ? h('ul', { class: 'perk-list' }, lines.map((t) => h('li', null, t))) : null));
    }
    clear(left);
    if (groups.length) left.append(h('section', { class: 'di-section' }, h('h3', { class: 'set-h' }, 'These will be skipped'), groupsEl(groups)));
    // Rows: what each role and channel becomes now. The boxes are the person's own choices and stay as they are.
    for (const r of plan.roles) {
      const row = roleRows.get(r.key);
      if (!row) continue;
      row.el.classList.toggle('off', !!r.skip);
      row.reason.textContent = r.skip && r.skip !== 'excluded' ? reasonText(r.skip) : '';
    }
    const now = new Map(plan.channels.map((c) => [c.key, c]));
    for (const [key, row] of channelRows) {
      const c = now.get(key);
      row.el.classList.toggle('off', !c);
      if (c) row.name.textContent = c.name;
    }
    // Category names can change too ("Text (2)" becomes "Text" once the category it made way for is left out).
    const catNow = new Map(plan.channels.map((c) => [c.group, c.category]));
    for (const [g, x] of groupHeads) {
      x.head.classList.toggle('off', !catNow.has(g));
      if (catNow.has(g)) x.title.textContent = catNow.get(g);
    }
    syncButton();
  }

  // ---- rows, made once from the first plan (so focus stays put while things are worked out again)
  const roleList = h('div', { class: 'di-list', role: 'group', 'aria-label': 'Roles' });
  for (const r of [...plan.roles].reverse()) {
    // A role over the limit stays ticked (wanted) and says why it isn't coming: leaving out others makes room.
    const box = h('input', { type: 'checkbox', checked: r.skip !== 'managed', disabled: r.skip === 'managed' });
    const reason = h('span', { class: 'field-hint warn' });
    const el = h('label', { class: 'di-row' }, box,
      h('span', { class: 'role-dot', style: { background: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : 'var(--muted)' } }),
      h('span', { class: 'di-main' },
        h('span', { class: 'di-name' }, r.icon ? h('span', { 'aria-hidden': 'true' }, r.icon) : null, r.name, r.admin ? h('span', { class: 'badge-tag role-admin' }, 'Administrator') : null),
        h('span', { class: 'di-sub' }, hearthPerms(r.permissions)),
        r.lost.length ? h('span', { class: 'di-sub' }, `Can’t bring: ${r.lost.map(discordLabel).join(', ')}`) : null,
        reason));
    box.addEventListener('change', () => { if (box.checked) skipRoles.delete(r.key); else skipRoles.add(r.key); recheck(); });
    roleRows.set(r.key, { el, box, reason });
    roleList.append(el);
  }
  const channelList = h('div', { class: 'di-list', role: 'group', 'aria-label': 'Channels' });
  const unsupported = plan.report.skipped.filter((s) => s.kind === 'channel' && s.reason.startsWith('type_'));
  // Channels by category, in order. A category is known by its key in the template (its name can change).
  const byGroup = new Map();
  for (const c of plan.channels) { if (!byGroup.has(c.group)) byGroup.set(c.group, []); byGroup.get(c.group).push(c); }
  const groupHeads = new Map();
  for (const [group, inCat] of byGroup) {
    const all = h('input', { type: 'checkbox', checked: true });
    const title = h('span', { class: 'di-name' }, inCat[0].category);
    const head = h('label', { class: 'di-row di-cat' }, all, h('span', { class: 'di-main' }, title));
    groupHeads.set(group, { head, title });
    const boxes = [];
    const syncAll = () => { const on = boxes.filter((b) => b.checked).length; all.checked = on === boxes.length; all.indeterminate = on > 0 && on < boxes.length; };
    all.addEventListener('change', () => {
      for (const [b, key] of boxes.map((x, i) => [x, inCat[i].key])) { b.checked = all.checked; if (all.checked) skipChannels.delete(key); else skipChannels.add(key); }
      all.indeterminate = false;
      recheck();
    });
    channelList.append(head);
    for (const c of inCat) {
      const box = h('input', { type: 'checkbox', checked: true });
      boxes.push(box);
      const name = h('span', null, c.name);
      const notes = [
        c.sourceName && c.name !== c.sourceName ? `was “${c.sourceName}”` : '',
        ...c.notes.filter((n) => CONVERTED[n]).map((n) => CONVERTED[n]),
        c.slowmode ? `slowmode ${c.slowmode} s` : '',
      ].filter(Boolean);
      const el = h('label', { class: 'di-row di-chan' }, box,
        h('span', { class: 'di-main' },
          h('span', { class: 'di-name' }, icon(c.type === 'voice' ? 'speaker' : 'hash'), name, c.private ? h('span', { class: 'di-lock', 'aria-label': 'private', title: 'Private: @everyone can’t see it' }, icon('lock')) : null),
          notes.length ? h('span', { class: 'di-sub' }, notes.join(' · ')) : null));
      box.addEventListener('change', () => { if (box.checked) skipChannels.delete(c.key); else skipChannels.add(c.key); syncAll(); recheck(); });
      channelRows.set(c.key, { el, name });
      channelList.append(el);
    }
  }
  for (const s of unsupported) {
    channelList.append(h('div', { class: 'di-row di-chan off' }, h('span', { class: 'di-gap' }), h('span', { class: 'di-main' }, h('span', { class: 'di-name' }, s.name), h('span', { class: 'di-sub' }, reasonText(s.reason)))));
  }

  // ---- asking the server again (it's the one that knows), a moment after the last change. An answer to an older
  // question (something changed after it was asked, Create was pressed or the dialog closed) is dropped.
  let seq = 0; let timer = null; let dirty = false;
  async function ask(mine) {
    try {
      const r = await api('POST', '/imports/discord/preview', { template: state.template, skipRoles: [...skipRoles], skipChannels: [...skipChannels] });
      if (mine !== seq) return;
      plan = r.plan;
      dirty = false;
      draw();
    } catch (e) { if (mine === seq) toast(e.message, 'error'); }
  }
  function recheck() { clearTimeout(timer); dirty = true; const mine = ++seq; timer = setTimeout(() => ask(mine), 450); }
  function stopAsking() { clearTimeout(timer); seq++; }

  const m = modal({
    title: 'Import from Discord', size: 'lg', className: 'di-modal', onClose: stopAsking,
    body: h('div', { class: 'stack' },
      field('Server name', nameIn), summary, problems, wide,
      h('section', { class: 'di-section' }, h('h3', { class: 'set-h' }, 'Roles'),
        h('p', { class: 'field-hint' }, 'Roles come over without members: give them out once people join. Untick any you don’t want.'), roleList),
      h('section', { class: 'di-section' }, h('h3', { class: 'set-h' }, 'Channels'), channelList),
      left),
    actions: [
      { label: 'Back', action: () => openDiscordImport(ctx, { link: state.link, text: state.text }) },
      { label: 'Create server', kind: 'primary', action: async () => {
        const name = nameIn.value.trim();
        if (!name) throw new Error('Give your server a name.');
        creating = true;
        stopAsking();
        let s;
        try {
          s = await api('POST', '/imports/discord', {
            template: state.template, name, skipRoles: [...skipRoles], skipChannels: [...skipChannels], allowEveryoneAdmin: plan.everyone.dangerous ? adminOk.checked : false,
          });
        } catch (e) {
          creating = false;
          if (dirty) recheck(); // the change that was still being worked out when Create was pressed
          setTimeout(syncButton); // after the dialog turns its button back on
          throw e;
        }
        const { report, importId, ...server } = s;
        if (!ctx.S.servers.find((x) => x.id === server.id)) ctx.S.servers.push(server);
        if (server.keyState) await ctx.sec.applyState(server.keyState);
        ctx.openServer(server.id);
        showReport(server, { ...plan, report }, ctx);
      } },
    ],
  });
  createBtn = m.box.querySelector('.modal-foot .btn.primary');
  draw();
  return m;
}

// ------------------------------------------------------------------ step 3: what happened
// Then straight on to inviting people (app.js openInvite in its 'imported' welcome, with an announcement to post on
// Discord), when the app passed that in.
function showReport(server, plan, ctx = {}) {
  const c = plan.report.counts;
  const groups = leftBehind(plan.report);
  const lines = widenedLines(plan);
  modal({
    title: `Imported ${server.name}`, size: 'md',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted-p' }, `Made ${plural(c.roles, 'role')}, ${plural(c.categories, 'category', 'categories')} and ${plural(c.channels, 'channel')}. You own it.`),
      h('p', { class: 'muted-p' }, ctx.invite ? 'Next: invite your people, then give out roles in Server settings → Roles or from the member list.'
        : 'Next: invite people (server menu → Invite people), then give out roles in Server settings → Roles or from the member list.'),
      lines.length ? h('div', { class: 'warn-box stack tight' }, h('strong', null, 'Hearth allows more than Discord did'), h('ul', { class: 'perk-list' }, lines.map((t) => h('li', null, t)))) : null,
      groups.length ? h('section', { class: 'di-section' }, h('h3', { class: 'set-h' }, 'Skipped'), groupsEl(groups)) : null),
    actions: [
      { label: 'Copy report', action: async () => { await copyText(reportText(server.name, plan)); toast('Report copied.'); return false; } },
      ...(ctx.invite ? [{ label: 'Done' }, { label: 'Invite people', kind: 'primary', action: () => { setTimeout(() => ctx.invite(server)); } }] : [{ label: 'Done', kind: 'primary' }]),
    ],
  });
}
