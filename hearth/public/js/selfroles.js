// Roles members can pick themselves: the "Pick your roles" window, and the hints the role editor shows next to
// "Members can pick this role themselves". The server checks everything again (server/selfroles.js); this only
// explains it up front.
import { h, clear, icon, toast } from './util.js';
import { api } from './api.js';
import { modal } from './ui.js';
import { PERMS, ALL } from './perms.js';

const P = PERMS;
// Moderator powers (the same list as server/memberships.js POWERFUL), and what self-assignable roles also can't have.
const POWERFUL = P.ADMINISTRATOR | P.MANAGE_SERVER | P.MANAGE_ROLES | P.MANAGE_CHANNELS | P.MANAGE_MESSAGES
  | P.MANAGE_EMOJIS | P.KICK_MEMBERS | P.BAN_MEMBERS | P.MUTE_MEMBERS | P.MOVE_MEMBERS | P.VIEW_AUDIT_LOG | P.MANAGE_NICKNAMES;
export const SELF_BLOCKED = POWERFUL | P.MENTION_EVERYONE;
const BLOCKED = SELF_BLOCKED;
// The powers that only reach people below you (kick, ban, timeouts, role changes, other people's nicknames,
// bulk delete and the report inbox, voice mute and move), as on the server: a marked role has to sit below every
// role with one of them. Manage Messages and Move Members count in a single channel too (REACH_IN_CHANNEL), given to
// a role or to one member (whose highest role, leaving out pickable ones, then counts).
const REACH = P.ADMINISTRATOR | P.KICK_MEMBERS | P.BAN_MEMBERS | P.MANAGE_ROLES | P.MANAGE_NICKNAMES
  | P.MANAGE_MESSAGES | P.MUTE_MEMBERS | P.MOVE_MEMBERS;
const REACH_IN_CHANNEL = P.MANAGE_MESSAGES | P.MOVE_MEMBERS;
// Channel permissions, as the server checks them for overrides.
const CHANNEL_SCOPED = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS | P.ATTACH_FILES | P.EMBED_LINKS
  | P.MENTION_EVERYONE | P.MANAGE_MESSAGES | P.CONNECT | P.SPEAK | P.CREATE_THREADS | P.MANAGE_CHANNELS | P.MANAGE_ROLES
  | P.MOVE_MEMBERS;

// Overrides are only sent to people who manage roles or channels; for everyone else this finds none.
const allowsIn = (server, roleId, bits) => (server.channels || []).find((c) => (c.overrides || []).some((o) => o.type === 'role' && o.id === roleId && (o.allow & bits)));
// The highest role (leaving out pickable ones) of each member given REACH_IN_CHANNEL by an override of their own, as
// server/selfroles.js lowestModRole counts them: not the owner, nor anyone whose highest is @everyone.
function memberModRoles(server) {
  const defs = new Map((server.roleDefs || []).map((r) => [r.id, r]));
  const out = [];
  const seen = new Set();
  for (const c of server.channels || []) {
    for (const o of c.overrides || []) {
      if (o.type !== 'member' || !(o.allow & REACH_IN_CHANNEL) || o.id === server.ownerId || seen.has(o.id)) continue;
      seen.add(o.id);
      const top = ((server.memberRoles || {})[o.id] || []).map((id) => defs.get(id)).filter((r) => r && !r.everyone && !r.selfAssign)
        .sort((a, b) => b.position - a.position)[0];
      if (top && top.position > 0) out.push(top);
    }
  }
  return out;
}

// Roles a member can see in "Pick your roles": the marked ones, highest first. A role that can't be picked right
// now is only listed for people who have it (so they can still drop it).
export function pickableRoles(server, myId) {
  if (!server || server.kind === 'group') return [];
  const mine = new Set((server.memberRoles || {})[myId] || []);
  return (server.roleDefs || []).filter((r) => r.selfAssign && !r.everyone && (!r.selfAssignIssue || mine.has(r.id)))
    .sort((a, b) => b.position - a.position);
}

// Why the role editor can't turn "Members can pick this role themselves" on, or ''.
//   permissions: the editor's current (unsaved) choice
//   mine:        the editor's own server-wide permissions (marking a role takes what giving it would)
export function selfAssignProblem(server, role, permissions, mine = ALL) {
  if (permissions & BLOCKED) return 'Roles with moderator powers or Mention @everyone can’t be picked by members.';
  const ch = allowsIn(server, role.id, BLOCKED);
  if (ch) return `It has moderator powers or Mention @everyone in #${ch.name}, so members can’t pick it.`;
  // Only sent to people who manage roles, who are the ones who see this.
  const sold = (server.soldRoles || {})[role.id];
  if (sold && !role.selfAssign) return `It’s sold as the "${sold}" membership, so members can’t pick it for free.`;
  const low = (server.roleDefs || []).filter((r) => !r.everyone && r.id !== role.id && ((r.permissions & REACH) || allowsIn(server, r.id, REACH_IN_CHANNEL)))
    .sort((a, b) => a.position - b.position)[0];
  const lowMember = memberModRoles(server).sort((a, b) => a.position - b.position)[0];
  if (lowMember && (!low || lowMember.position < low.position)) {
    if (lowMember.id === role.id) return 'It’s the highest role of someone who moderates a channel: anyone who picked it would be level with them, out of their reach.';
    if (role.position >= lowMember.position) return `It sits above "${lowMember.name}", the highest role of someone who moderates a channel: anyone who picked it would be out of their reach. Move it below "${lowMember.name}" first.`;
  }
  if (low && role.position >= low.position) return `It sits above "${low.name}", a moderator role that only reaches people below it: anyone who picked it would be out of that role’s reach. Move it below "${low.name}" first.`;
  if (!role.selfAssign) {
    if (permissions & ALL & ~mine) return 'It has permissions you don’t have, so you can’t let members pick it (that would give it to anyone).';
    // Channels this app knows about (ones you can see); the server also checks the rest.
    const c = (server.channels || []).find((x) => (x.overrides || []).some((o) => o.type === 'role' && o.id === role.id && ((o.allow | o.deny) & CHANNEL_SCOPED & ~(x.perms ?? ALL))));
    if (c) return `It has permissions in #${c.name} you don’t have there, so you can’t let members pick it.`;
  }
  if (role.selfAssignIssue) return `Members can’t pick it right now: ${role.selfAssignIssue}.`;
  return '';
}

// The members' window. live(): the server as the app has it now; nextUpdate(): resolves after the next live
// update of this server (so the list redraws with what the server says).
export function openRolePicker(server, { myId, live, nextUpdate }) {
  const body = h('div', { class: 'stack pick-roles' });
  const busy = new Set();
  const draw = () => {
    const s = live() || server;
    const mine = new Set((s.memberRoles || {})[myId] || []);
    const roles = pickableRoles(s, myId);
    const timedOut = !!s.timeout;
    clear(body).append(h('p', { class: 'muted-p' }, 'Pick the roles you want in this server: some get pinged for things, some open channels. You can change them any time.'));
    if (timedOut) body.append(h('p', { class: 'muted-p warn' }, icon('timer', 'ic'), ' You’re timed out here, so you can’t change your roles until it ends.'));
    if (!roles.length) { body.append(h('p', { class: 'field-hint' }, 'There’s nothing to pick here right now.')); return; }
    body.append(h('div', { class: 'pick-roles-list', role: 'group', 'aria-label': 'Roles you can pick' }, roles.map((r) => {
      const has = mine.has(r.id);
      const stuck = !has && !!r.selfAssignIssue;
      return h('label', { class: `toggle-row pick-role${has ? ' mine' : ''}` },
        h('span', { class: 'toggle-text' },
          h('span', { class: 'toggle-label pick-role-name' }, h('span', { class: 'role-dot', style: { background: r.color || 'var(--muted)' } }), r.icon ? h('span', { 'aria-hidden': 'true' }, r.icon) : null, h('span', null, r.name)),
          r.selfAssignIssue && has ? h('span', { class: 'field-hint' }, 'You can drop it, but it can’t be picked again for now.') : null),
        h('span', { class: 'switch' }, h('input', {
          type: 'checkbox', checked: has, disabled: timedOut || stuck || busy.has(r.id), 'data-rid': r.id,
          onchange: (e) => toggle(r, e.target.checked),
        }), h('span', { class: 'switch-track' })));
    })));
  };
  const toggle = async (r, on) => {
    busy.add(r.id);
    draw();
    try {
      const wait = nextUpdate();
      const res = await api(on ? 'POST' : 'DELETE', `/servers/${server.id}/me/roles/${encodeURIComponent(r.id)}`);
      // The server's new view can take a moment when many people are picking (it batches them): until it comes,
      // show what the server answered.
      const s = live();
      if (s && s.memberRoles) {
        const list = (s.memberRoles[myId] || []).filter((x) => x !== r.id);
        s.memberRoles[myId] = res.has ? [...list, r.id] : list;
      }
      await wait;
    } catch (e) { toast(e.message, 'error'); }
    busy.delete(r.id);
    draw();
    // Keep the keyboard where it was: draw() replaced the switch.
    const again = body.querySelector(`.pick-role input[data-rid="${CSS.escape(r.id)}"]`);
    if (again && !again.disabled) again.focus();
  };
  draw();
  modal({ title: `Pick your roles · ${server.name}`, size: 'sm', body });
}
