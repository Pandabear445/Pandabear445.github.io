// Channel settings → Webhooks (server/webhooks.js has the rules): addresses that Uptime Kuma, Grafana, Home Assistant,
// GitHub and anything else that posts to a Discord or Slack webhook can post to instead. Each address holds a secret
// that's shown once (only a hash of it is kept), so "New address" is how a lost or leaked one is replaced.
import { h, clear, icon, toast, copyText } from './util.js';
import { api } from './api.js';
import { modal, field, confirmDialog } from './ui.js';

const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
// The open panel, so a change made elsewhere (another manager, another tab) redraws it.
let current = null;

// The address, this once. It's a password for posting here, so the dialog says so.
function showAddress(title, path) {
  const url = `${location.origin}${path}`;
  const input = h('input', { class: 'input mono', readonly: true, value: url, 'aria-label': 'Webhook address', onfocus: (e) => e.currentTarget.select() });
  modal({
    title, size: 'md',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted-p' }, 'Paste this where a program asks for a Discord webhook URL. Anyone who has it can post in this channel, so keep it like a password. It’s shown only now: if you lose it, get a new address.'),
      h('div', { class: 'row gap' }, input, h('button', { class: 'btn', type: 'button', onclick: () => copyText(url).then(() => toast('Copied.')) }, icon('copy'), 'Copy')),
      h('p', { class: 'field-hint' }, 'For Slack-style tools add /slack to the end. For a GitHub repository (Settings → Webhooks), add /github and pick the application/json content type.')),
    actions: [{ label: 'Done', kind: 'primary' }],
  });
}

function renameDialog(c, w, redraw) {
  const input = h('input', { class: 'input', maxlength: '32', value: w.name });
  modal({
    title: 'Rename webhook', size: 'sm',
    body: h('div', { class: 'stack' }, field('Name', input, 'Shown on its posts, unless the program sends its own name.')),
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: async () => {
      await api('PATCH', `/channels/${c.id}/webhooks/${w.id}`, { name: input.value });
      toast('Webhook renamed.');
      redraw();
    } }],
  });
  input.focus();
}

// Draws the panel into `body` for text channel `c`.
export async function webhooksPanel(c, body) {
  const redraw = () => { if (body.isConnected) webhooksPanel(c, body); };
  current = { channelId: c.id, redraw };
  let d;
  try { d = await api('GET', `/channels/${c.id}/webhooks`); } catch (e) { clear(body).append(h('p', { class: 'form-error' }, e.message)); return; }
  const name = h('input', { class: 'input', maxlength: '32', placeholder: 'Uptime Kuma', 'aria-label': 'New webhook name' });
  const create = async () => {
    try {
      const r = await api('POST', `/channels/${c.id}/webhooks`, { name: name.value.trim() || 'Webhook' });
      showAddress(`Webhook “${r.webhook.name}” made`, r.path);
      redraw();
    } catch (e) { toast(e.message, 'error'); }
  };
  // stopPropagation: Enter here makes a webhook, and mustn't also reach the settings dialog (its Save).
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (d.canPost) create(); } });
  // Making, renaming and re-keying need Send Messages here (and no timeout); changing someone's webhook needs a
  // higher role than theirs. The server checks both; the buttons only say so up front.
  const noPost = d.canPost ? null : 'You can’t send messages in this channel, so you can’t set up its webhooks.';
  const row = (w) => {
    const locked = w.canChange ? null : 'Its address was made by someone at or above your highest role.';
    const pings = h('input', { type: 'checkbox', checked: w.allowMentions, disabled: !!locked || (!d.canPing && !w.allowMentions), 'aria-label': `${w.name} can ping` });
    pings.addEventListener('change', async () => {
      try { await api('PATCH', `/channels/${c.id}/webhooks/${w.id}`, { allowMentions: pings.checked }); toast(pings.checked ? 'It can ping now.' : 'Its pings are off.'); redraw(); } catch (e) { pings.checked = !pings.checked; toast(e.message, 'error'); }
    });
    return h('div', { class: 'adm-row hook-row', dataset: { hook: w.id } },
      h('div', { class: 'act-text' },
        h('b', null, w.name, h('span', { class: 'bot-tag' }, 'BOT')),
        h('span', { class: 'act-sub' }, `Address made by ${w.createdByName ? `@${w.createdByName}${w.makerHere ? '' : ' (no longer in this server)'}` : 'a deleted account'} · last post ${ago(w.lastUsedAt)}${w.rotatedAt ? ` · new address ${ago(w.rotatedAt)}` : ''}`),
        // Paused because of the person who made its address: a new address from someone else makes it theirs.
        w.paused ? h('span', { class: 'act-sub form-error' }, `Paused. ${w.paused}${/address/.test(w.paused) ? ' A new address from someone else starts it again.' : ''}`) : null,
        h('label', { class: 'row gap tight hook-pings' }, pings, h('span', null, 'Can ping @everyone, @here, roles and people'))),
      h('span', { class: 'row gap tight' },
        h('button', { class: 'btn ghost sm', type: 'button', disabled: !!(locked || noPost), title: locked || noPost || null, onclick: () => renameDialog(c, w, redraw) }, icon('edit'), 'Rename'),
        h('button', { class: 'btn ghost sm', type: 'button', disabled: !!(locked || noPost), title: locked || noPost || null, onclick: async () => {
          if (!(await confirmDialog({ title: `New address for ${w.name}?`, text: 'The old address stops working right away. Paste the new one everywhere the old one was.', confirm: 'Get a new address' }))) return;
          try { const r = await api('POST', `/channels/${c.id}/webhooks/${w.id}/token`); showAddress(`New address for “${w.name}”`, r.path); redraw(); } catch (e) { toast(e.message, 'error'); }
        } }, icon('link'), 'New address'),
        h('button', { class: 'btn ghost sm danger-text', type: 'button', disabled: !!locked, title: locked || null, onclick: async () => {
          if (!(await confirmDialog({ title: `Delete ${w.name}?`, text: 'Programs using its address can’t post here any more. Its old posts stay.', confirm: 'Delete', danger: true }))) return;
          try { await api('DELETE', `/channels/${c.id}/webhooks/${w.id}`); toast('Webhook deleted.'); redraw(); } catch (e) { toast(e.message, 'error'); }
        } }, icon('trash'), 'Delete')));
  };
  clear(body).append(
    h('p', { class: 'muted-p' }, 'Let programs post here: Uptime Kuma, Grafana, Home Assistant, Jellyfin, GitHub, CI jobs and anything else that can post to a Discord or Slack webhook. Their posts appear from a bot and aren’t end-to-end encrypted. Everything people write still is.'),
    h('div', { class: 'row gap' }, name, h('button', { class: 'btn primary', type: 'button', disabled: d.webhooks.length >= d.max || !d.canPost, title: noPost, onclick: create }, icon('plus'), 'New webhook')),
    noPost ? h('p', { class: 'field-hint' }, noPost) : null,
    d.webhooks.length
      ? h('div', { class: 'adm-table' }, ...d.webhooks.map(row))
      : h('p', { class: 'field-hint' }, 'No webhooks in this channel yet.'),
    h('p', { class: 'field-hint' }, `${d.webhooks.length} of ${d.max}. Pings are off unless you turn them on${d.canPing ? '' : ' (that needs the Mention Everyone permission)'}: mentions in a webhook’s posts show as plain text.`));
}

// Socket "webhooks:update": someone changed this channel's webhooks.
export function onWebhooksUpdate(x) {
  if (current && x && x.channelId === current.channelId) current.redraw();
}
