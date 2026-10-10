// Creator memberships in the app: the owner's "Memberships" tab in Server settings (connect Stripe, make
// tiers, see members) and the members' window (join a tier, see or cancel yours). Paying happens on Stripe's
// own page: in a browser this tab goes there and comes back; the desktop and Android apps open the browser.
import { h, clear, icon, toast } from './util.js';
import { api } from './api.js';
import { modal, field, confirmDialog } from './ui.js';
import { PERMS } from './perms.js';

const money = (cents, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${cur || ''}`; } };
const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const go = (url) => { if (/^https:\/\//.test(url)) location.href = url; };
const roleChip = (r) => (r ? h('span', { class: 'mb-role', style: r.color ? `--rc:${r.color}` : '' }, '@' + r.name) : null);

function statusLine(m) {
  if (m.status === 'past_due') return 'Payment didn’t go through — Stripe will try again. Check your card.';
  if (m.status === 'pending') return 'Waiting for the payment to finish…';
  if (m.cancelAtEnd) return `Cancelled · ends ${day(m.periodEnd)}`;
  return m.periodEnd ? `Renews ${day(m.periodEnd)}` : 'Active';
}

// ------------------------------------------------------------------ members: join / manage
export async function openMemberships(server) {
  let d;
  try { d = await api('GET', `/servers/${server.id}/memberships`); } catch (e) { toast(e.message, 'error'); return; }
  const body = h('div', { class: 'stack mb-join' });
  const mdl = modal({ title: `Memberships · ${server.name}`, size: 'md', body });
  const draw = () => {
    clear(body);
    const mine = new Map(d.mine.map((m) => [m.tierId, m]));
    body.append(h('p', { class: 'muted-p' }, 'Support this server with a monthly membership. You get the perks below, and the creator gets paid. Cancel any time; it stays on until the end of the month you paid for.'));
    if (!d.tiers.length) body.append(h('p', { class: 'field-hint' }, 'Nothing is on offer right now.'));
    for (const t of d.tiers) {
      const m = mine.get(t.id);
      body.append(h('div', { class: `mb-tier${m ? ' mine' : ''}` },
        h('div', { class: 'mb-tier-head' },
          h('div', null, h('h3', null, t.name), roleChip(t.role)),
          h('div', { class: 'mb-price' }, h('strong', null, money(t.priceCents, t.currency)), h('span', null, '/month'))),
        t.description ? h('p', { class: 'mb-desc' }, t.description) : null,
        m ? h('div', { class: 'mb-mine' }, h('span', { class: `mb-status ${m.status}` }, icon('check', 'ic'), statusLine(m)),
          !m.cancelAtEnd && m.status !== 'pending' ? h('button', { class: 'btn ghost sm', onclick: () => cancel(m) }, 'Cancel membership') : null)
          : h('button', { class: 'btn primary', onclick: (e) => join(t, e.currentTarget) }, `Join for ${money(t.priceCents, t.currency)}/month`)));
    }
    body.append(h('p', { class: 'field-hint mb-fine' }, icon('lock', 'ic'), 'Payments are handled by Stripe. Hearth never sees your card.'));
  };
  const join = async (t, btn) => {
    btn.disabled = true; btn.textContent = 'Opening Stripe…';
    try { const r = await api('POST', `/servers/${server.id}/memberships/tiers/${t.id}/checkout`); go(r.url); setTimeout(() => mdl.close(), 1500); }
    catch (e) { toast(e.message, 'error'); btn.disabled = false; draw(); }
  };
  const cancel = async (m) => {
    if (!await confirmDialog({ title: 'Cancel membership?', text: `You keep it until ${day(m.periodEnd) || 'the end of this month'}, and you won’t be charged again.`, confirm: 'Cancel membership', danger: true })) return;
    try { const u = await api('POST', `/servers/${server.id}/memberships/${m.id}/cancel`); d.mine = d.mine.map((x) => (x.id === u.id ? u : x)); draw(); toast('Cancelled. It stays on until the end of the month.'); }
    catch (e) { toast(e.message, 'error'); }
  };
  draw();
}

// ------------------------------------------------------------------ owner: Server settings → Memberships
export async function membershipsTab(s, body, { roles }) {
  clear(body).append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
  let d;
  try { d = await api('GET', `/servers/${s.id}/memberships`); } catch (e) { clear(body).append(h('p', { class: 'form-error' }, e.message)); return; }
  const o = d.owner || { connected: false, allTiers: [], members: [], monthlyCents: 0 };
  const redraw = () => membershipsTab(s, body, { roles });
  clear(body);
  body.append(h('div', { class: 'admin-head' }, h('h3', null, 'Memberships')),
    h('p', { class: 'field-hint' }, `Let people support you with a monthly membership, like Patreon inside your server. Each membership gives a role, and roles can open private channels (Roles, then a channel’s permissions). The money goes to your own Stripe account. This Hearth keeps ${d.feePercent}%, and Stripe charges its usual card fee. Everything else in your server stays free for everyone.`));
  if (!d.available) {
    body.append(h('div', { class: 'mb-note' }, icon('info', 'ic'), 'Memberships aren’t turned on for this Hearth yet. Its owner can turn them on in Admin → Money.'));
    return;
  }

  // 1. Getting paid
  const step = (n, title, ...kids) => h('section', { class: 'mb-step' }, h('div', { class: 'mb-step-n' }, String(n)), h('div', { class: 'mb-step-body' }, h('h4', null, title), ...kids));
  const connectBtn = h('button', { class: 'btn primary', onclick: async () => {
    connectBtn.disabled = true;
    try { go((await api('POST', `/servers/${s.id}/memberships/connect`)).url); } catch (e) { toast(e.message, 'error'); connectBtn.disabled = false; }
  } }, o.connected ? 'Finish setting up Stripe' : 'Connect Stripe');
  const checkBtn = h('button', { class: 'btn ghost', onclick: async () => {
    checkBtn.disabled = true;
    try { const r = await api('POST', `/servers/${s.id}/memberships/refresh`); toast(r.ready ? 'Stripe is ready: you can be paid.' : 'Stripe still needs a few details from you.'); redraw(); } catch (e) { toast(e.message, 'error'); checkBtn.disabled = false; }
  } }, 'Check again');
  const dashBtn = h('button', { class: 'btn ghost', onclick: async () => {
    try { window.open((await api('POST', `/servers/${s.id}/memberships/dashboard`)).url, '_blank', 'noopener'); } catch (e) { toast(e.message, 'error'); }
  } }, icon('external', 'ic'), 'Stripe dashboard');
  body.append(step(1, d.ready ? 'Getting paid — ready' : 'Get paid with Stripe',
    d.ready
      ? h('p', { class: 'muted-p' }, 'Your Stripe account is connected. Payouts, refunds and tax forms are in your Stripe dashboard.')
      : h('p', { class: 'muted-p' }, 'Stripe checks who you are and where to send your money (it takes a few minutes). You’ll come back here when you’re done.'),
    h('div', { class: 'row gap wrap' }, d.ready ? dashBtn : connectBtn, !d.ready && o.connected ? checkBtn : null)));

  // 2. Tiers
  const sellable = (roles || []).filter((r) => !r.everyone && !(r.permissions & POWERFUL));
  const tierForm = (t) => {
    const name = h('input', { class: 'input', maxlength: '40', placeholder: 'Supporter', value: t ? t.name : '' });
    const price = h('input', { class: 'input', type: 'number', min: '1', max: '500', step: '0.5', placeholder: '5', value: t ? String(t.priceCents / 100) : '' });
    const desc = h('textarea', { class: 'input', rows: '3', maxlength: '300', placeholder: 'What members get: early videos, a private channel, a shout-out…' });
    desc.value = t ? t.description : '';
    const role = h('select', { class: 'input' }, h('option', { value: '' }, 'No role'), ...sellable.map((r) => h('option', { value: r.id, selected: t && t.role && t.role.id === r.id }, '@' + r.name)));
    const save = async () => {
      const b = { name: name.value, description: desc.value, priceCents: Math.round(parseFloat(price.value || '0') * 100), roleId: role.value || null };
      if (t) await api('PATCH', `/servers/${s.id}/memberships/tiers/${t.id}`, b); else await api('POST', `/servers/${s.id}/memberships/tiers`, b);
      toast(t ? 'Saved.' : 'Membership created.'); redraw();
    };
    modal({ title: t ? `Edit “${t.name}”` : 'New membership', size: 'sm',
      body: h('div', { class: 'stack' }, field('Name', name), field(`Price per month (${d.currency})`, price, t ? 'A new price applies to people who join from now on.' : ''), field('What members get', desc),
        field('Role it gives', role, sellable.length ? 'Roles with moderator powers can’t be sold. Make a role (Roles tab) and use it to open private channels.' : 'Make a role first in the Roles tab (one without moderator powers).')),
      actions: [{ label: 'Cancel' }, { label: t ? 'Save' : 'Create', kind: 'primary', action: save }] });
  };
  const tiers = o.allTiers.filter((t) => t.active);
  body.append(step(2, 'Your memberships',
    tiers.length ? h('div', { class: 'stack' }, ...tiers.map((t) => h('div', { class: 'mb-tier owner' },
      h('div', { class: 'mb-tier-head' }, h('div', null, h('h3', null, t.name), roleChip(t.role) || h('span', { class: 'field-hint' }, 'no role')),
        h('div', { class: 'mb-price' }, h('strong', null, money(t.priceCents, t.currency)), h('span', null, '/month'))),
      t.description ? h('p', { class: 'mb-desc' }, t.description) : null,
      h('div', { class: 'row gap' }, h('button', { class: 'btn ghost sm', onclick: () => tierForm(t) }, 'Edit'),
        h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
          if (!await confirmDialog({ title: `Stop selling “${t.name}”?`, text: 'Nobody new can join it. People who already pay keep it until they cancel.', confirm: 'Stop selling', danger: true })) return;
          try { await api('DELETE', `/servers/${s.id}/memberships/tiers/${t.id}`); redraw(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Stop selling')))))
      : h('p', { class: 'muted-p' }, 'None yet. Most creators start with one, around $3–5 a month.'),
    tiers.length < 5 ? h('button', { class: 'btn', onclick: () => tierForm(null) }, icon('plus', 'ic'), 'New membership') : null,
    d.ready ? null : h('p', { class: 'field-hint' }, 'Members can join once Stripe is ready.')));

  // 3. Members
  const live = o.members.filter((m) => m.status !== 'ended');
  body.append(step(3, `Members · ${live.length} · ${money(o.monthlyCents, d.currency)}/month`,
    o.members.length ? h('div', { class: 'adm-table' }, ...o.members.map((m) => {
      const t = o.allTiers.find((x) => x.id === m.tierId);
      return h('div', { class: 'adm-row three' }, h('span', null, m.user ? (m.user.displayName || m.user.username) : 'deleted account'),
        h('span', null, t ? t.name : ''), h('span', { class: `mb-status ${m.status}` }, m.status === 'ended' ? 'Ended' : statusLine(m)));
    })) : h('p', { class: 'muted-p' }, 'Nobody yet. Tell your community where to find it: the server menu → Memberships.')));
}
// Roles with these can't be sold (the server refuses them too).
const POWERFUL = PERMS.ADMINISTRATOR | PERMS.MANAGE_SERVER | PERMS.MANAGE_ROLES | PERMS.MANAGE_CHANNELS | PERMS.MANAGE_MESSAGES
  | PERMS.MANAGE_EMOJIS | PERMS.KICK_MEMBERS | PERMS.BAN_MEMBERS;
