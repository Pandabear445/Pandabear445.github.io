// Bots in the app (server/bots.js has the rules):
//  - Server settings → Bots: the built-in news bot, installed bots (health, access, deliveries, remove), adding
//    one from this Hearth's list after approving its scopes and channels, and the bots you made (tokens shown
//    once, webhook secret, delete).
//  - Slash commands in the composer: suggestions, argument hints and checks, the "goes to the bot without
//    end-to-end encryption" warning, and answers only you can see (kept in memory, never stored).
import { h, clear, icon, toast } from './util.js';
import { api } from './api.js';
import { modal, field, confirmDialog } from './ui.js';

export const NEWS_BOT_ID = 'newsbot00000000000001';
const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const HEALTH = { ok: ['ok', 'Working'], failing: ['bad', 'Failing'], waiting: ['warn', 'Not heard from yet'], paused: ['warn', 'Paused'] };
const healthPill = (x, tip) => { const [cls, label] = HEALTH[x] || HEALTH.waiting; return h('span', { class: `rpill ${cls}`, 'data-tip': tip || null }, label); };
const scopeChip = (sc, fresh) => h('span', { class: `bot-scope${fresh ? ' fresh' : ''}` }, sc, fresh ? h('b', null, ' new') : null);

// A token or secret, shown this once (only a hash of a token is kept, so it can't be shown again).
function secretsOnce(title, intro, items) {
  return new Promise((resolve) => {
    const ok = h('input', { type: 'checkbox' });
    let m;
    const done = h('button', { class: 'btn primary', disabled: true, onclick: () => { m.close(); resolve(); } }, 'Done');
    ok.addEventListener('change', () => { done.disabled = !ok.checked; });
    m = modal({ title, size: 'md', dismissable: false,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, intro),
        ...items.map(([label, value]) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label),
          h('div', { class: 'cmd-box secret-box' }, h('code', null, value)),
          h('div', null, h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(value).then(() => toast('Copied.')) }, icon('copy'), 'Copy')))),
        h('p', { class: 'field-hint' }, 'Keep these out of git, chat and web addresses. Send the token only in the Authorization header: "Authorization: Bot <token>".'),
        h('label', { class: 'row gap tight' }, ok, h('span', null, 'I saved them somewhere safe')),
        h('div', null, done)) });
  });
}

// The approval dialog. Lists every scope the bot asks for (and any it already has) with what it means, and the
// channels it may use. Resolves { scopes, channels } when approved, null when not.
export function approveAccess({ bot, scopes: about, server, current = null }) {
  return new Promise((resolve) => {
    const had = current ? current.scopes : [];
    const asked = [...new Set([...(bot.requestedScopes || []), ...had])];
    const order = Object.keys(about).filter((k) => asked.includes(k));
    const boxes = order.map((sc) => ({ sc, box: h('input', { type: 'checkbox', checked: current ? had.includes(sc) || (current.review && asked.includes(sc)) : true }) }));
    const text = (server.channels || []).filter((c) => c.type === 'text');
    const curCh = current ? current.channels : [];
    const all = h('input', { type: 'radio', name: 'bot-ch', checked: curCh === '*' });
    const some = h('input', { type: 'radio', name: 'bot-ch', checked: curCh !== '*' });
    const chBoxes = text.map((c) => ({ c, box: h('input', { type: 'checkbox', checked: Array.isArray(curCh) && curCh.includes(c.id), onchange: () => { some.checked = true; } }) }));
    let done = false;
    modal({
      title: current ? `Change what ${bot.name} can do` : `Add ${bot.name} to ${server.name}?`,
      size: 'md',
      onClose: () => { if (!done) resolve(null); },
      body: h('div', { class: 'stack bot-approve' },
        h('p', { class: 'muted-p' }, bot.description || 'A bot.', bot.ownerName ? h('span', { class: 'field-hint' }, ` Made by @${bot.ownerName}.`) : null),
        h('div', { class: 'key-bar' }, icon('lock'), h('span', null, 'Bots can’t read what people write here: messages stay end-to-end encrypted. A bot only sees text someone sends it with one of its slash commands, and its own messages aren’t encrypted.')),
        h('h4', null, order.length ? 'It asks to:' : 'It doesn’t ask for any access.'),
        ...boxes.map(({ sc, box }) => h('label', { class: 'bot-perm' }, box, h('span', { class: 'toggle-text' },
          h('span', { class: 'toggle-label' }, sc, current && !had.includes(sc) ? h('span', { class: 'rpill warn' }, 'new') : null), h('span', { class: 'field-hint' }, about[sc])))),
        h('h4', null, 'In which channels?'),
        h('label', { class: 'row gap tight' }, all, h('span', null, 'Every channel everyone can see (and new ones)')),
        h('label', { class: 'row gap tight' }, some, h('span', null, 'Only these:')),
        h('div', { class: 'bot-channels' }, ...chBoxes.map(({ c, box }) => h('label', { class: 'row gap tight' }, box, h('span', null, `#${c.name}`)))),
        h('p', { class: 'field-hint' }, 'You can change or take away any of this later, or remove the bot.')),
      actions: [
        { label: 'Cancel' },
        { label: current ? 'Save' : 'Allow and add', kind: 'primary', action: () => { done = true; resolve({ scopes: boxes.filter((b) => b.box.checked).map((b) => b.sc), channels: all.checked ? '*' : chBoxes.filter((b) => b.box.checked).map((b) => b.c.id) }); } },
      ],
    });
  });
}

function deliveriesDialog(s, inst) {
  const body = h('div', { class: 'stack' });
  const base = `/servers/${s.id}/bots/${inst.bot.id}/deliveries`;
  const row = (d, dead) => h('div', { class: 'adm-row' },
    h('div', { class: 'act-text' }, h('b', null, d.type), h('span', { class: 'act-sub' }, `${new Date(d.createdAt).toLocaleString()} · ${d.attempts} attempt${d.attempts === 1 ? '' : 's'}${d.lastError ? ` · ${d.lastError}` : ''}`)),
    d.status === 'ok' ? h('span', { class: 'rpill ok' }, 'Delivered') : d.status === 'pending' ? h('span', { class: 'rpill warn' }, 'Retrying') : h('span', { class: 'rpill bad' }, 'Failed'),
    dead ? h('button', { class: 'btn ghost sm', onclick: async () => { await api('POST', `${base}/retry`, { ids: [d.id] }); draw(); } }, 'Retry') : null);
  const draw = async () => {
    let d;
    try { d = await api('GET', base); } catch (e) { clear(body).append(h('p', { class: 'form-error' }, e.message)); return; }
    clear(body).append(
      h('p', { class: 'muted-p' }, 'Events are tried up to 6 times, waiting longer each time. What still fails ends up here, so nothing is lost silently.'),
      h('h4', null, `Failed (${d.dead.length})`),
      d.dead.length ? h('div', { class: 'adm-table' }, ...d.dead.map((x) => row(x, true))) : h('p', { class: 'field-hint' }, 'Nothing failed.'),
      d.dead.length ? h('div', { class: 'row gap' },
        h('button', { class: 'btn', onclick: async () => { const r = await api('POST', `${base}/retry`, {}); toast(`Trying ${r.retried} again.`); draw(); } }, 'Retry all'),
        h('button', { class: 'btn ghost danger-text', onclick: async () => { if (await confirmDialog({ title: 'Clear failed deliveries?', text: 'The bot won’t get these events.', confirm: 'Clear', danger: true })) { await api('DELETE', `${base}/dead`); draw(); } } }, 'Clear')) : null,
      h('h4', null, 'Recent'),
      d.recent.length ? h('div', { class: 'adm-table' }, ...d.recent.map((x) => row(x, false))) : h('p', { class: 'field-hint' }, 'No events yet.'));
  };
  modal({ title: `${inst.bot.name}: deliveries`, size: 'lg', body });
  draw();
}

// ------------------------------------------------------------------ Server settings → Bots
// confirm(fn, opts): asks for the password (and two-factor code) and calls fn with them (settings.js confirmedCall).
export async function botsTab(s, body, { confirm }) {
  clear(body).append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
  let here; let all;
  try { [here, all] = await Promise.all([api('GET', `/servers/${s.id}/bots`), api('GET', '/bots')]); } catch (e) { clear(body).append(h('p', { class: 'form-error' }, e.message)); return; }
  const redraw = () => botsTab(s, body, { confirm });
  const chName = (id) => ((s.channels || []).find((c) => c.id === id) || {}).name;
  const where = (i) => (i.channels === '*' ? 'every public channel' : i.channels.length ? i.channels.map((id) => `#${chName(id) || 'hidden channel'}`).join(', ') : 'no channels');
  const news = here.builtIn[0];

  const installed = here.installed.map((i) => h('div', { class: 'adm-row bot-row' },
    h('div', { class: 'act-text' },
      h('b', null, i.bot.name, h('span', { class: 'bot-tag' }, 'BOT')),
      h('span', { class: 'act-sub' }, `@${i.bot.username || ''} · in ${where(i)}${i.webhook ? '' : ' · no webhook set'}`),
      h('span', { class: 'bot-scopes' }, ...(i.scopes.length ? i.scopes.map((x) => scopeChip(x)) : [h('span', { class: 'field-hint' }, 'No access granted')])),
      i.pendingScopes.length ? h('span', { class: 'field-hint' }, `Asks for more: ${i.pendingScopes.join(', ')}. Review it under Access.`) : null),
    h('span', { class: 'stat-sub' }, `Last OK ${ago(i.lastOkAt)}`),
    healthPill(i.health, i.lastError || null),
    h('span', { class: 'row gap tight' },
      h('button', { class: 'btn ghost sm', onclick: async () => {
        const got = await approveAccess({ bot: i.bot, scopes: here.scopes, server: s, current: { scopes: i.scopes, channels: i.channels, review: true } });
        if (!got) return;
        try { await api('PATCH', `/servers/${s.id}/bots/${i.bot.id}`, { ...got, confirm: true }); toast('Saved.'); } catch (e) { toast(e.message, 'error'); }
        redraw();
      } }, 'Access'),
      h('button', { class: 'btn ghost sm', onclick: () => deliveriesDialog(s, i) }, 'Deliveries'),
      h('button', { class: 'btn ghost sm', onclick: async () => { await api('PATCH', `/servers/${s.id}/bots/${i.bot.id}`, { enabled: !i.enabled }); redraw(); } }, i.enabled ? 'Pause' : 'Resume'),
      h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
        if (!(await confirmDialog({ title: `Remove ${i.bot.name}?`, text: 'It loses all access to this server right away. Its old messages stay.', confirm: 'Remove', danger: true }))) return;
        try { await api('DELETE', `/servers/${s.id}/bots/${i.bot.id}`); toast(`${i.bot.name} was removed.`); } catch (e) { toast(e.message, 'error'); }
        redraw();
      } }, 'Remove'))));

  const notHere = all.available.filter((b) => !here.installed.some((i) => i.bot.id === b.id));
  const pick = h('select', { class: 'input' }, ...notHere.map((b) => h('option', { value: b.id }, `${b.name}${b.ownerName ? ` (by @${b.ownerName})` : ''}`)));
  const addSection = notHere.length ? h('div', { class: 'row gap' }, pick, h('button', { class: 'btn primary', onclick: async () => {
    const b = notHere.find((x) => x.id === pick.value);
    const got = b && await approveAccess({ bot: b, scopes: here.scopes, server: s });
    if (!got) return;
    try { await api('POST', `/servers/${s.id}/bots`, { botId: b.id, ...got, confirm: true }); toast(`${b.name} was added.`); } catch (e) { toast(e.message, 'error'); }
    redraw();
  } }, 'Review and add')) : h('p', { class: 'field-hint' }, 'No other bots are listed on this Hearth yet.');

  // One block that keeps its full height (the settings pane is a shrinking flex column).
  clear(body).append(h('div', { class: 'stack bots-panel' },
    h('h3', null, 'Bots'),
    h('p', { class: 'muted-p' }, 'Bots are programs that can post here, offer slash commands and hear about what happens, with only the access you approve. They can’t read what people write: that stays end-to-end encrypted. Their own messages aren’t encrypted, and they’re marked that way.'),
    h('h4', null, 'Built in'),
    h('div', { class: 'adm-table' }, h('div', { class: 'adm-row bot-row' },
      h('div', { class: 'act-text' }, h('b', null, news.name, h('span', { class: 'bot-tag' }, 'BOT')), h('span', { class: 'act-sub' }, `${news.description} Set it up in the News bot tab.`)),
      h('span', { class: 'stat-sub' }, `${news.feeds} feed${news.feeds === 1 ? '' : 's'}`),
      news.active ? h('span', { class: 'rpill ok' }, 'Working') : h('span', { class: 'rpill warn' }, 'Not following anything'))),
    h('h4', null, 'Added to this server'),
    here.installed.length ? h('div', { class: 'adm-table' }, ...installed) : h('p', { class: 'field-hint' }, 'No bots yet.'),
    h('h4', null, 'Add a bot'),
    addSection,
    myBots(all, { confirm, redraw })));
}

// ------------------------------------------------------------------ the bots you made
function myBots(all, { confirm, redraw }) {
  const wrap = h('div', { class: 'stack' }, h('h4', null, 'Your bots'));
  if (!all.mine.length) wrap.append(h('p', { class: 'field-hint' }, all.canCreate ? 'You haven’t made any bots.' : 'On this Hearth, only some people can make bots.'));
  for (const b of all.mine) {
    const url = h('input', { class: 'input', value: b.webhookUrl, placeholder: 'https://bot.example.com/hearth' });
    const listed = h('input', { type: 'checkbox', checked: b.listed });
    const asks = Object.keys(all.scopes).map((sc) => ({ sc, box: h('input', { type: 'checkbox', checked: b.requestedScopes.includes(sc) }) }));
    const live = b.tokens.filter((t) => !t.revokedAt);
    wrap.append(h('details', { class: 'bot-mine' },
      h('summary', null, h('b', null, b.name), ` @${b.username || ''} · in ${b.installations.length} server${b.installations.length === 1 ? '' : 's'}${b.disabled ? ' · turned off by an admin' : ''}`),
      h('div', { class: 'stack' },
        field('Webhook address', url, 'Where events and slash commands are sent: https only, on the public internet.'),
        h('label', { class: 'row gap tight' }, listed, h('span', null, 'List it on this Hearth, so other servers can add it')),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Access it asks for'), h('div', { class: 'bot-scopes' }, ...asks.map(({ sc, box }) => h('label', { class: 'row gap tight' }, box, h('span', null, sc)))),
          h('span', { class: 'field-hint' }, 'Servers approve new access before it applies there.')),
        h('div', null, h('button', { class: 'btn primary sm', onclick: async () => {
          try { await api('PATCH', `/bots/${b.id}`, { webhookUrl: url.value.trim(), listed: listed.checked, scopes: asks.filter((x) => x.box.checked).map((x) => x.sc) }); toast('Saved.'); redraw(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Save')),
        h('h4', null, 'Tokens'),
        live.length ? h('div', { class: 'adm-table' }, ...live.map((t) => h('div', { class: 'adm-row' },
          h('div', { class: 'act-text' }, h('code', null, `hb_${t.id}.…`), h('span', { class: 'act-sub' }, `${t.installationId ? 'one server only' : 'whole bot'} · made ${ago(t.createdAt)} · used ${ago(t.lastUsedAt)}`)),
          h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
            if (!(await confirmDialog({ title: 'Revoke this token?', text: 'Anything using it stops working right away.', confirm: 'Revoke', danger: true }))) return;
            await api('DELETE', `/bots/${b.id}/tokens/${t.id}`); redraw();
          } }, 'Revoke')))) : h('p', { class: 'field-hint' }, 'No working tokens.'),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn sm', onclick: async () => {
            const r = await confirm((x) => api('POST', `/bots/${b.id}/tokens`, { rotate: true, ...x }), { title: 'New token', text: `Make a new token for ${b.name}? Its other whole-bot tokens stop working right away.`, button: 'Make a new token' }).catch((e) => { if (!e.cancelled) toast(e.message, 'error'); return null; });
            if (r && r.token) { await secretsOnce(`${b.name}: new token`, 'Shown once. Put it in your bot’s settings now.', [['Token', r.token]]); redraw(); }
          } }, 'New token (rotate)'),
          h('button', { class: 'btn sm', onclick: async () => {
            const r = await confirm((x) => api('POST', `/bots/${b.id}/webhook-secret`, x), { title: 'New webhook secret', text: 'Webhooks are signed with the new secret from now on.', button: 'Make a new secret' }).catch((e) => { if (!e.cancelled) toast(e.message, 'error'); return null; });
            if (r && r.webhookSecret) await secretsOnce(`${b.name}: new webhook secret`, 'Shown once. Your bot checks every webhook with it.', [['Webhook secret', r.webhookSecret]]);
          } }, 'New webhook secret'),
          h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
            if (!(await confirmDialog({ title: `Delete ${b.name}?`, text: 'It’s removed from every server and its tokens stop working. This can’t be undone.', confirm: 'Delete', danger: true }))) return;
            await api('DELETE', `/bots/${b.id}`); redraw();
          } }, 'Delete')))));
  }
  if (all.canCreate) {
    const name = h('input', { class: 'input', maxlength: '32', placeholder: 'Dice' });
    const desc = h('input', { class: 'input', maxlength: '300', placeholder: 'Rolls dice with /roll' });
    const url = h('input', { class: 'input', placeholder: 'https://bot.example.com/hearth (you can add it later)' });
    const listed = h('input', { type: 'checkbox' });
    const asks = Object.entries(all.scopes).map(([sc, about]) => ({ sc, box: h('input', { type: 'checkbox' }), about }));
    wrap.append(h('details', { class: 'bot-mine' }, h('summary', null, icon('plus'), ' Make a bot'),
      h('div', { class: 'stack' },
        h('div', { class: 'grid-2' }, field('Name', name), field('What it does', desc)),
        field('Webhook address (optional)', url, 'https only. See docs/BOTS.md for what it receives.'),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Access it will ask for'),
          ...asks.map(({ sc, box, about }) => h('label', { class: 'bot-perm' }, box, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, sc), h('span', { class: 'field-hint' }, about))))),
        h('label', { class: 'row gap tight' }, listed, h('span', null, 'List it on this Hearth, so other servers can add it')),
        h('div', null, h('button', { class: 'btn primary', onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          try {
            const r = await api('POST', '/bots', { name: name.value, description: desc.value, webhookUrl: url.value.trim() || null, listed: listed.checked, scopes: asks.filter((x) => x.box.checked).map((x) => x.sc) });
            await secretsOnce(`${r.bot.name} is ready`, 'These are shown once. The token lets your program act as the bot; the webhook secret lets it check that webhooks really come from this Hearth.', [['Token', r.token], ['Webhook secret', r.webhookSecret]]);
            redraw();
          } catch (x) { toast(x.message, 'error'); btn.disabled = false; }
        } }, 'Make bot')))));
  }
  return wrap;
}

// ------------------------------------------------------------------ slash commands
// Commands per channel (cached a minute), argument parsing, the warning, and answers only you can see.
export function createSlash({ getSocketId, onEphemeral, members }) {
  const cache = new Map(); // channel id -> { at, list }
  const ephemeral = []; // { channelId, botName, content, at }: memory only
  const cached = (channelId) => { const c = cache.get(channelId); return c && Date.now() - c.at < 60000 ? c.list : null; };
  async function load(channelId) {
    try { const r = await api('GET', `/channels/${channelId}/commands`); cache.set(channelId, { at: Date.now(), list: r.commands }); } catch { cache.set(channelId, { at: Date.now(), list: [] }); }
    return cache.get(channelId).list;
  }
  // "/roll 20" → the roll command (only for text that starts with one of this channel's commands).
  const match = (channelId, text) => {
    const m = /^\/([a-z0-9_-]{1,32})(?:\s|$)/i.exec(text || '');
    return m ? (cached(channelId) || []).find((c) => c.name === m[1].toLowerCase()) || null : null;
  };
  const usage = (c) => `/${c.name}${c.options.map((o) => ` ${o.required ? '<' : '['}${o.name}:${o.type}${o.required ? '>' : ']'}`).join('')}`;
  // Positional arguments: words, or "quoted words"; a text argument at the end takes the rest of the line.
  function parse(cmd, text, server) {
    let rest = text.replace(/^\/\S+\s*/, '');
    const args = {};
    for (let i = 0; i < cmd.options.length; i++) {
      const o = cmd.options[i];
      rest = rest.trimStart();
      let word;
      if (!rest) { if (o.required) return { error: `/${cmd.name} needs ${o.name} (${o.type}).` }; break; }
      if (o.type === 'string' && i === cmd.options.length - 1) { word = rest.replace(/^"([\s\S]*)"$/, '$1'); rest = ''; } else {
        const m = /^"([^"]*)"|^(\S+)/.exec(rest);
        word = m[1] !== undefined ? m[1] : m[2]; rest = rest.slice(m[0].length);
      }
      if (o.type === 'number') {
        if (!Number.isFinite(Number(word))) return { error: `${o.name} has to be a number.` };
        args[o.name] = Number(word);
      } else if (o.type === 'user') {
        const name = word.replace(/^@/, '').toLowerCase();
        const u = members(server).find((x) => x.id === word.replace(/^<@|>$/g, '') || (x.username || '').toLowerCase() === name);
        if (!u) return { error: `No one called @${name} is in this server.` };
        args[o.name] = u.id;
      } else if (o.type === 'channel') {
        const c = (server.channels || []).find((x) => x.name === word.replace(/^#/, '').toLowerCase() || x.id === word);
        if (!c) return { error: `There's no #${word.replace(/^#/, '')} here.` };
        args[o.name] = c.id;
      } else args[o.name] = word;
    }
    if (rest.trim()) return { error: `Too much after /${cmd.name}. Usage: ${usage(cmd)}` };
    return { args };
  }
  // The bar above the composer while typing a command: usage, the warning, and any problem with the arguments.
  function hint(cmd, text, server) {
    const p = parse(cmd, text, server);
    const complete = !p.error || !/needs/.test(p.error);
    return h('div', { class: 'cmd-hint' },
      h('div', null, h('code', null, usage(cmd)), ` — ${cmd.description || 'a command'} · `, h('b', null, cmd.botName), h('span', { class: 'bot-tag' }, 'BOT')),
      h('div', { class: 'cmd-warn' }, icon('lock'), h('span', null, `What you type after /${cmd.name} goes to ${cmd.botName} without end-to-end encryption.`)),
      p.error && complete ? h('div', { class: 'form-error' }, p.error) : null);
  }
  const pending = new Map(); // interaction id -> { botName, channelId }
  // Runs a command. Resolves true when it was sent (the composer then clears), false to keep the text.
  async function run(channelId, cmd, text, server) {
    const p = parse(cmd, text, server);
    if (p.error) { toast(p.error, 'error'); return false; }
    // The warning, once per bot on this device (and always in the bar above the composer).
    const seenKey = `hearth.botWarned.${cmd.botId}`;
    let seen = false;
    try { seen = localStorage.getItem(seenKey) === '1'; } catch { /* private mode */ }
    if (!seen) {
      const ok = await confirmDialog({ title: `Send this to ${cmd.botName}?`, text: `What you type after /${cmd.name} goes to the bot ${cmd.botName} without end-to-end encryption, so the people who run it can read it. Messages in this channel stay encrypted.`, confirm: 'Send to the bot' });
      if (!ok) return false;
      try { localStorage.setItem(seenKey, '1'); } catch { /* fine */ }
    }
    try {
      const r = await api('POST', `/channels/${channelId}/commands`, { botId: cmd.botId, name: cmd.name, args: p.args, ack: true, socketId: getSocketId() });
      pending.set(r.interactionId, { botName: cmd.botName, channelId });
      // If the server's answer never comes (it restarted, the connection dropped), still say so.
      setTimeout(() => onInteraction({ interactionId: r.interactionId, status: 'timeout' }), Math.min(30000, Math.max(5000, r.respondBy - Date.now())) + 3000);
      toast(`Sent /${cmd.name} to ${cmd.botName}…`);
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }
  // The server's answer to a command (socket "bot:interaction").
  function onInteraction(x) {
    const p = pending.get(x.interactionId);
    if (!p) return;
    pending.delete(x.interactionId);
    if (x.status === 'timeout') toast(`${p.botName} didn’t answer.`, 'error');
    else if (x.status === 'failed') toast(x.error || `${p.botName} couldn’t be reached.`, 'error');
    else if (x.ephemeral) {
      ephemeral.push({ channelId: p.channelId, botName: p.botName, content: String(x.ephemeral.content || ''), at: Date.now() });
      if (ephemeral.length > 20) ephemeral.shift();
      onEphemeral(p.channelId);
    }
  }
  const ephemeralFor = (channelId) => ephemeral.filter((e) => e.channelId === channelId);
  const dismiss = (e) => { const i = ephemeral.indexOf(e); if (i >= 0) ephemeral.splice(i, 1); onEphemeral(e.channelId); };
  return { cached, load, match, parse, hint, run, usage, onInteraction, ephemeralFor, dismiss };
}
