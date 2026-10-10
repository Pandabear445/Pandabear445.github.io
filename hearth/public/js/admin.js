// Admin dashboard (server administrators only). Everything here is also enforced by the server.
import { h, clear, icon, toast, fmtStamp, fmtSize, copyText } from './util.js';
import { api } from './api.js';
import { avatarEl } from './profile-ui.js';
import { modal, confirmDialog, field, menu } from './ui.js';
import { renderDoc, render as md } from './markdown.js';
import { rankRelays, relayTime } from './relays.js';

// [key, label, icon, lowest role that sees it]. The server enforces the same rules.
const TABS = [['overview', 'Overview', 'home', 1], ['online', 'Online', 'people', 1], ['reports', 'Reports', 'shield', 1], ['users', 'Users', 'user', 1], ['servers', 'Servers', 'compass', 2], ['security', 'Security', 'lock', 2], ['admins', 'Team & roles', 'star', 1], ['registration', 'Registration & Terms', 'book', 2], ['log', 'Audit log', 'file', 1], ['regions', 'Regions', 'globe', 2], ['money', 'Money', 'coin', 2], ['owner', 'Owner', 'flame', 3]];
export const RANK = { moderator: 1, admin: 2, owner: 3 };
// Security groups three pages under one tab: protection (sign everyone out, blocked IPs, sign-in attempts),
// storage & limits, and broadcast.
const SECURITY_SUBS = [['security', 'Protection', 'shield'], ['storage', 'Storage & limits', 'download'], ['broadcast', 'Broadcast', 'megaphone']];
export const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator' };
const ROLE_HINT = {
  owner: 'Everything, plus giving and taking away staff roles.',
  admin: 'The whole dashboard and Settings \u2192 Instance.',
  moderator: 'Reports, users (suspend, sign out, reset profile, notes), who\u2019s online and the audit log.',
};
const roleTag = (role) => (role ? h('span', { class: `badge-tag role-${role}` }, ROLE_LABEL[role]) : null);
const DURATIONS = [[1, '1 hour'], [24, '1 day'], [72, '3 days'], [168, '1 week'], [720, '30 days'], [0, 'Until lifted']];
export const CATEGORY_LABEL = {
  spam: 'Spam', harassment: 'Harassment or bullying', hate: 'Hate speech', threats: 'Threats or violence', sexual: 'Sexual content',
  child_safety: 'Child safety', self_harm: 'Self-harm', illegal: 'Illegal content', impersonation: 'Impersonation', scam: 'Scam or fraud', other: 'Something else',
};
const asUser = (b) => (b ? { id: b.id, username: b.username, avatar: b.avatar, profile: { displayName: b.displayName } } : { id: '', username: 'deleted', profile: { displayName: 'Deleted user' } });
const fmtMb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb || 0} MB`);
const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtStamp(ts);
};
const dur = (ms) => { const m = Math.floor(ms / 60000); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`; };
export function device(ua) {
  ua = ua || '';
  const b = /HearthDesktop|Electron\//.test(ua) ? 'Desktop app' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const o = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b} \u00b7 ${o}` : b;
}
async function banIp(ip) {
  const reason = h('input', { class: 'input', maxlength: '200', placeholder: 'Optional note for other admins' });
  modal({ title: `Block ${ip}?`, size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'Nobody from this address can sign up, log in or connect. People already connected from it are disconnected. Note that IPs can be shared (schools, mobile carriers) and can change.'), field('Reason', reason)),
    actions: [{ label: 'Cancel' }, { label: 'Block', kind: 'danger', action: async () => { await api('POST', '/admin/ip-bans', { ip, reason: reason.value }); toast(`${ip} is blocked.`); } }] });
}
const ipChip = (ip) => h('button', { class: 'ip-chip', 'data-tip': 'IP options', 'data-pop-anchor': '', onclick: (e) => menu(e.currentTarget, [
  { label: 'Copy', icon: 'copy', action: () => { copyText(ip); toast(`Copied ${ip}`); } },
  { label: 'Block this IP', icon: 'ban', danger: true, action: () => banIp(ip) },
  /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? { label: `Block range ${ip.replace(/\.\d+$/, '.0')}/24`, icon: 'ban', danger: true, action: () => banIp(ip.replace(/\.\d+$/, '.0') + '/24') } : null,
]) }, ip);
const userCell = (b, onOpen) => h('button', { class: 'adm-user', onclick: () => b && onOpen && onOpen(b.id) }, avatarEl(asUser(b), 28),
  h('span', { class: 'adm-user-text' }, h('strong', null, b ? b.displayName : 'Deleted user'), h('span', null, b ? '@' + b.username : '')),
  b && b.suspended ? h('span', { class: 'badge-tag bad' }, 'Suspended') : null, b ? roleTag(b.role) : null);

export function adminView({ tab = 'overview', setTab, openReports = 0, onCount, role = 'admin', confirm = null } = {}) {
  const myRank = RANK[role] || 0;
  const tabs = TABS.filter((t) => myRank >= t[3]);
  // Old links to the Storage or Broadcast tab open them inside Security.
  let secSub = SECURITY_SUBS.some(([k]) => k === tab) ? tab : 'security';
  if (secSub !== 'security') tab = 'security';
  if (!tabs.some((t) => t[0] === tab)) tab = 'overview';
  const wrap = h('div', { class: 'admin' });
  const nav = h('nav', { class: 'admin-tabs', role: 'tablist' });
  const body = h('div', { class: 'admin-body' });
  let timer = null;
  const go = (t) => { clearInterval(timer); tab = t; setTab && setTab(t); draw(); };
  const openUser = (id) => userModal(id, () => draw(), myRank);
  const draw = () => {
    clear(nav).append(...tabs.map(([k, l, ic]) => h('button', { class: `admin-tab${tab === k ? ' active' : ''}`, role: 'tab', onclick: () => go(k) }, icon(ic), l,
      k === 'reports' && openReports ? h('span', { class: 'badge inline' }, openReports) : null)));
    clear(body).append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
    const page = tab === 'security' ? secSub : tab;
    ({ overview, online, reports, users, servers, security, storage, broadcast, admins, registration, log, regions, money, owner })[page]().catch((e) => clear(body).append(h('p', { class: 'form-error' }, e.message)));
  };
  // Security's sub-tabs stay on top of whichever page is showing (pages redraw the body themselves).
  const subBar = h('div', { class: 'set-subtabs admin-subtabs', role: 'tablist' });
  const drawSubBar = () => clear(subBar).append(...SECURITY_SUBS.map(([k, l, ic]) => h('button', { class: `set-subtab${secSub === k ? ' active' : ''}`, role: 'tab', onclick: () => { secSub = k; draw(); } }, icon(ic), l)));
  new MutationObserver(() => { if (tab === 'security' && body.firstChild !== subBar) { drawSubBar(); body.prepend(subBar); } }).observe(body, { childList: true });

  async function overview() {
    const s = await api('GET', '/admin/stats');
    openReports = s.openReports;
    if (onCount) onCount(openReports);
    const card = (label, value, sub, warn) => h('div', { class: `stat${warn ? ' warn' : ''}` }, h('span', { class: 'stat-label' }, label), h('strong', null, String(value)), sub ? h('span', { class: 'stat-sub' }, sub) : null);
    const max = Math.max(1, ...s.series.map((d) => d.messages));
    const maxU = Math.max(1, ...s.series.map((d) => Math.max(d.signups, d.active)));
    const chart = (title, key, mx, cls) => h('div', { class: 'chart' }, h('div', { class: 'chart-title' }, title),
      h('div', { class: 'bars' }, s.series.map((d) => h('div', { class: 'bar-col', 'data-tip': `${d.day}: ${d[key]}` }, h('div', { class: `bar ${cls}`, style: { height: `${Math.max(2, (d[key] / mx) * 100)}%` } }), h('span', null, d.day.slice(8))))));
    clear(body).append(
      h('div', { class: 'stats' },
        card('Online now', s.online, `${s.inVoice} in voice`),
        card('Accounts', s.users, `+${s.newUsers24h} today \u00b7 +${s.newUsers7d} this week`),
        card('Active', s.active24h, `today \u00b7 ${s.active7d} this week`),
        card('Messages today', s.messages24h, 'counted, never read'),
        card('Servers', s.servers, `${s.groups} group DMs`),
        card('Open reports', s.openReports, s.openReports ? 'need a look' : 'all clear', s.openReports > 0),
        card('Suspended', s.suspended, ''),
        card('Storage', fmtSize(s.uploadsBytes + s.dbBytes), `files ${fmtSize(s.uploadsBytes)} \u00b7 database ${fmtSize(s.dbBytes)}`),
        card('Registration', { open: 'Open', closed: 'Closed', code: 'Invite code' }[s.regMode], ''),
        card('Running', dur(s.uptime * 1000), `v${s.version} \u00b7 Node ${s.node}`)),
      h('div', { class: 'charts' }, chart('Messages per day', 'messages', max, ''), chart('New accounts per day', 'signups', maxU, 'alt'), chart('Active people per day', 'active', maxU, 'alt2')),
      healthCards(s.health));
  }
  function healthCards(hl) {
    if (!hl) return '';
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    const memUsed = hl.memTotal - hl.memFree;
    const cpu = Math.round((hl.load[0] / hl.cores) * 100);
    const card = (label, value, sub, warn) => h('div', { class: `stat${warn ? ' warn' : ''}` }, h('span', { class: 'stat-label' }, label), h('strong', null, value), sub ? h('span', { class: 'stat-sub' }, sub) : null);
    return h('div', null,
      h('div', { class: 'admin-head' }, h('h3', null, 'Server health'), h('span', { class: 'field-hint' }, 'Right now, on this machine')),
      h('div', { class: 'stats' },
        card('CPU', `${cpu}%`, `load ${hl.load.join(' / ')} on ${hl.cores} cores`, cpu > 80),
        card('Memory', `${pct(memUsed, hl.memTotal)}%`, `${fmtSize(memUsed)} of ${fmtSize(hl.memTotal)} \u00b7 Hearth uses ${fmtSize(hl.rss)}`, pct(memUsed, hl.memTotal) > 90),
        hl.disk ? card('Disk', `${pct(hl.disk.total - hl.disk.free, hl.disk.total)}% used`, `${fmtSize(hl.disk.free)} free of ${fmtSize(hl.disk.total)}`, hl.disk.free < 5 * 1024 ** 3) : null,
        card('Connections', String(hl.sockets), 'open app windows'),
        card('Responsiveness', `${hl.lagMs} ms`, hl.lagMs < 50 ? 'snappy' : hl.lagMs < 200 ? 'a little busy' : 'struggling \u2014 consider a bigger server', hl.lagMs >= 200)));
  }

  async function online() {
    const load = async () => {
      const list = await api('GET', '/admin/online');
      if (tab !== 'online') return;
      clear(body).append(h('div', { class: 'admin-head' }, h('h3', null, `Online now \u2014 ${list.length}`), h('span', { class: 'field-hint' }, 'Refreshes every 10 seconds')),
        h('div', { class: 'adm-table' },
          h('div', { class: 'adm-row head' }, h('span', null, 'Person'), h('span', null, 'IP addresses'), h('span', null, 'Connected'), h('span', null, 'Devices'), h('span', null, '')),
          ...list.map((o) => h('div', { class: 'adm-row' },
            userCell(o.user, openUser),
            h('span', { class: 'ip-list' }, ...o.ips.map(ipChip)),
            h('span', null, dur(Date.now() - o.since), o.voice ? h('span', { class: 'stat-sub' }, '\uD83D\uDD0A ' + o.voice) : null),
            h('span', { class: 'stat-sub' }, o.devices.map(device).join(', ')),
            h('button', { class: 'btn ghost sm', onclick: () => openUser(o.user.id) }, 'Details')))));
    };
    await load();
    timer = setInterval(() => load().catch(() => {}), 10000);
  }

  async function reports(status = 'open') {
    const list = await api('GET', `/admin/reports?status=${status}`);
    if (status === 'open' && onCount) { openReports = list.length; onCount(openReports); }
    const seg = h('div', { class: 'seg' }, [['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['all', 'All']].map(([k, l]) => h('button', {
      class: `seg-btn${status === k ? ' active' : ''}`, onclick: () => reports(k).catch((e) => toast(e.message, 'error')),
    }, l)));
    const act = async (r, body2, msg) => { await api('PATCH', `/admin/reports/${r.id}`, body2); toast(msg); reports(status); };
    clear(body).append(h('div', { class: 'admin-head' }, h('h3', null, 'Reports'), seg),
      ...(list.length ? [] : [h('div', { class: 'panel-empty' }, icon('shield'), h('p', null, status === 'open' ? 'No open reports. \uD83C\uDF89' : 'Nothing here.'))]),
      ...list.map((r) => h('div', { class: `report-card st-${r.status}` },
        h('div', { class: 'report-top' },
          h('span', { class: `badge-tag cat-${r.category}` }, CATEGORY_LABEL[r.category] || r.category),
          h('span', { class: 'stat-sub' }, `${ago(r.createdAt)} \u00b7 ${r.status}${r.priorReports ? ` \u00b7 ${r.priorReports} other report${r.priorReports === 1 ? '' : 's'} about this person` : ''}`)),
        h('div', { class: 'report-who' },
          h('div', null, h('span', { class: 'field-label' }, 'Reported'), userCell(r.target, openUser), h('div', { class: 'ip-list' }, ...r.targetIps.map(ipChip))),
          h('div', null, h('span', { class: 'field-label' }, 'By'), userCell(r.reporter, openUser), r.reporterIp ? h('div', { class: 'ip-list' }, ipChip(r.reporterIp)) : null)),
        r.context.kind === 'message' ? h('p', { class: 'stat-sub' }, r.context.dmId ? 'In a direct message' : `In #${r.context.channelName} \u00b7 ${r.context.serverName}`) : h('p', { class: 'stat-sub' }, 'Report about the account'),
        r.details ? h('blockquote', { class: 'report-details' }, r.details) : null,
        r.evidence.length ? h('div', { class: 'evidence' },
          h('p', { class: 'field-hint' }, 'Messages shared by the reporter from their device. Who sent them and when is checked by the server; the wording comes from the reporter.'),
          ...r.evidence.map((e) => h('div', { class: `ev${e.reported ? ' reported' : ''}` },
            avatarEl(asUser(e.author), 22),
            h('div', { class: 'ev-body' }, h('div', { class: 'ev-meta' }, h('strong', null, e.author ? e.author.displayName : 'Deleted user'), h('span', null, fmtStamp(e.createdAt)), e.reported ? h('span', { class: 'badge-tag bad' }, 'Reported') : null),
              h('div', { class: 'ev-text', html: e.text ? md(e.text) : (e.files.length ? `[${e.files.map((f) => f.replace(/[<>&"]/g, '')).join(', ')}]` : '(no text)') })),
            e.reported ? h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
              if (await confirmDialog({ title: 'Delete this message for everyone?', text: 'It disappears from the conversation for all members.', confirm: 'Delete', danger: true })) { await api('DELETE', `/admin/messages/${e.id}`).catch((x) => toast(x.message, 'error')); toast('Message deleted.'); }
            } }, 'Delete message') : null))) : null,
        r.resolution ? h('p', { class: 'stat-sub' }, `Note: ${r.resolution}${r.handledBy ? ` \u2014 ${r.handledBy.displayName}` : ''}`) : null,
        h('div', { class: 'report-actions' },
          r.status === 'open' ? h('button', { class: 'btn ghost sm', onclick: () => act(r, { status: 'reviewing' }, 'Marked as reviewing.') }, 'I\u2019m on it') : null,
          r.target && !r.target.suspended ? h('button', { class: 'btn danger sm', onclick: () => suspendDialog(r.target, () => act(r, { status: 'resolved', resolution: 'Account suspended' }, 'Suspended and resolved.')) }, 'Suspend account') : null,
          h('button', { class: 'btn ghost sm', onclick: () => noteDialog('Resolve report', (note) => act(r, { status: 'resolved', resolution: note }, 'Resolved.')) }, 'Resolve'),
          h('button', { class: 'btn ghost sm', onclick: () => noteDialog('Dismiss report', (note) => act(r, { status: 'dismissed', resolution: note }, 'Dismissed.')) }, 'Dismiss')))));
  }

  async function users(q = '', filter = '') {
    const search = h('input', { class: 'input search-input', placeholder: 'Search by username, name or IP', value: q });
    const listEl = h('div', { class: 'adm-table' });
    const seg = h('div', { class: 'seg' }, [['', 'Everyone'], ['online', 'Online'], ['suspended', 'Suspended'], ['staff', 'Staff']].map(([k, l]) => h('button', {
      class: `seg-btn${filter === k ? ' active' : ''}`, onclick: () => users(search.value, k).catch((e) => toast(e.message, 'error')),
    }, l)));
    const run = async () => {
      const list = await api('GET', `/admin/users?q=${encodeURIComponent(search.value.trim())}&filter=${filter}`);
      if (!list.length) return clear(listEl).append(h('div', { class: 'adm-row three' }, h('span', { class: 'stat-sub' }, 'Nobody matches.')));
      clear(listEl).append(h('div', { class: 'adm-row head' }, h('span', null, 'Person'), h('span', null, 'Last IP'), h('span', null, 'Joined'), h('span', null, 'Last seen'), h('span', null, 'Reports')),
        ...list.map((u) => h('div', { class: 'adm-row' }, userCell(u, openUser), h('span', null, u.lastIp ? ipChip(u.lastIp) : '\u2014'),
          h('span', { class: 'stat-sub' }, fmtStamp(u.createdAt)), h('span', { class: 'stat-sub' }, u.online ? h('span', { class: 'online-dot' }, 'online') : ago(u.lastSeen)),
          h('span', null, u.reportsAgainst ? h('span', { class: 'badge-tag bad' }, u.reportsAgainst) : '0'))));
    };
    let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => run().catch((e) => toast(e.message, 'error')), 250); });
    clear(body).append(h('div', { class: 'admin-head' }, h('h3', null, 'Users'), seg), h('div', { class: 'friends-search' }, icon('search'), search), listEl);
    await run();
  }

  async function registration() {
    const reg = await api('GET', '/admin/registration');
    const terms = await api('GET', '/terms');
    const code = h('input', { class: 'input mono', value: reg.code || '', placeholder: 'invite code people must enter' });
    const ta = h('textarea', { class: 'input mono', rows: '16', spellcheck: 'true' });
    ta.value = terms.text;
    const preview = h('div', { class: 'tos-text md', html: renderDoc(terms.text) });
    ta.addEventListener('input', () => { preview.innerHTML = renderDoc(ta.value); });
    const setMode = async (mode) => { await api('PUT', '/admin/registration', { mode, code: code.value }); toast('Saved.'); registration(); };
    clear(body).append(
      h('div', { class: 'admin-head' }, h('h3', null, 'Registration')),
      h('div', { class: 'chips' }, [['open', 'Open to anyone'], ['code', 'Invite code only'], ['closed', 'Closed']].map(([k, l]) => h('button', { class: `chip${reg.mode === k ? ' active' : ''}`, onclick: () => setMode(k) }, l))),
      h('p', { class: 'field-hint' }, 'Close registration instantly if you\u2019re getting spam sign-ups. Existing accounts are unaffected.'),
      h('div', { class: 'row gap' }, field('Invite code', code), h('button', { class: 'btn ghost', onclick: () => setMode(reg.mode) }, 'Save code')),
      h('div', { class: 'admin-head' }, h('h3', null, 'Robot check (captcha)')),
      h('p', { class: 'field-hint' }, 'A private, self-hosted "I\u2019m not a robot" check: people\u2019s browsers solve a small puzzle (well under a second), which makes mass sign-ups and password guessing expensive for bots. IPs that keep failing get harder puzzles automatically.'),
      ...[['captchaRegister', 'On sign-up'], ['captchaLogin', 'On login']].map(([k, l]) => h('div', { class: 'kv' }, h('span', null, l),
        h('div', { class: 'chips' }, [['on', 'On'], ['off', 'Off']].map(([v, vl]) => h('button', {
          class: `chip${reg[k] === v ? ' active' : ''}`, onclick: async () => { await api('PUT', '/admin/registration', { [k]: v }); toast('Saved.'); registration(); },
        }, vl))))),
      h('div', { class: 'admin-head' }, h('h3', null, 'Terms of Service')),
      h('p', { class: 'field-hint' }, 'Markdown: # headings, - bullet lists, **bold**. Saving asks everyone to accept the new version. Public page: /terms'),
      h('div', { class: 'terms-edit' }, ta, preview),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary', onclick: async () => {
          if (!(await confirmDialog({ title: 'Publish these terms?', text: 'Everyone will be asked to accept them the next time they use the app.', confirm: 'Publish' }))) return;
          await api('PUT', '/admin/terms', { text: ta.value }); toast('Terms published.');
        } }, 'Publish terms'),
        h('button', { class: 'btn ghost', onclick: async () => { await api('PUT', '/admin/terms', { text: '' }); toast('Back to the default terms.'); registration(); } }, 'Use the default terms')));
  }

  async function servers() {
    const list = await api('GET', '/admin/servers');
    clear(body).append(h('div', { class: 'admin-head' }, h('h3', null, `Servers \u2014 ${list.length}`), h('span', { class: 'field-hint' }, 'Messages are counted, never read')),
      h('div', { class: 'adm-table' }, h('div', { class: 'adm-row head' }, h('span', null, 'Server'), h('span', null, 'Owner'), h('span', null, 'Members \u00b7 messages'), h('span', null, 'Last active'), h('span', null, '')),
        ...list.map((x) => h('div', { class: 'adm-row' },
          h('span', { class: 'adm-user' }, x.icon ? h('img', { class: 'adm-srv-ic', src: x.icon, alt: '' }) : h('span', { class: 'adm-srv-ic' }, x.name.slice(0, 2)), h('span', { class: 'adm-user-text' }, h('strong', null, x.name), h('span', null, `created ${fmtStamp(x.createdAt)}`))),
          userCell(x.owner, openUser),
          h('span', null, `${x.members} \u00b7 ${x.messages}`),
          h('span', { class: 'stat-sub' }, ago(x.lastActive)),
          h('span', { class: 'row gap tight' }, h('button', { class: 'btn ghost sm', onclick: () => transferServer(x, servers) }, 'Give to\u2026'), h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
            if (await confirmDialog({ title: `Delete ${x.name}?`, text: 'Every channel, message and file in it is deleted for everyone. This can\u2019t be undone.', confirm: 'Delete server', danger: true })) { await api('DELETE', `/admin/servers/${x.id}`); toast('Server deleted.'); servers(); }
          } }, 'Delete'))))));
  }

  async function security() {
    const [sec, bans] = await Promise.all([api('GET', '/admin/security'), api('GET', '/admin/ip-bans')]);
    const ipIn = h('input', { class: 'input mono', placeholder: '203.0.113.7 or 203.0.113.0/24' });
    const label = { failed_login: 'Failed login', captcha_failed: 'Failed robot check', blocked_ip: 'Blocked IP', username_changed: 'Username changed' };
    clear(body).append(
      h('div', { class: 'admin-head' }, h('h3', null, 'Emergency')),
      h('p', { class: 'field-hint' }, 'Sign every account out of every device \u2014 for example if you think passwords leaked. Staff stay signed in. People just log in again; nothing is lost.'),
      h('div', { class: 'row gap' }, h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog({ title: 'Sign everyone out?', text: 'Every account except staff is signed out of every device right now.', confirm: 'Sign everyone out', danger: true }))) return;
        const r = await api('POST', '/admin/sign-out-all'); toast(`Signed out ${r.count} account${r.count === 1 ? '' : 's'}.`);
      } }, 'Sign everyone out')),
      h('div', { class: 'admin-head' }, h('h3', null, 'Blocked IP addresses')),
      h('div', { class: 'row gap' }, ipIn, h('button', { class: 'btn danger', onclick: () => ipIn.value.trim() && banIp(ipIn.value.trim()) }, 'Block')),
      bans.length ? h('div', { class: 'adm-table' }, ...bans.map((b) => h('div', { class: 'adm-row three' }, h('span', { class: 'ip-chip static' }, b.ip), h('span', { class: 'stat-sub' }, `${b.reason || 'No note'} \u00b7 ${fmtStamp(b.at)}`),
        h('button', { class: 'btn ghost sm', onclick: async () => { await api('DELETE', '/admin/ip-bans', { ip: b.ip }); toast('Unblocked.'); security(); } }, 'Unblock'))))
        : h('p', { class: 'field-hint' }, 'No addresses are blocked.'),
      h('div', { class: 'admin-head' }, h('h3', null, 'Most failed logins (last hour)')),
      sec.topFailedIps.length ? h('div', { class: 'ip-list' }, ...sec.topFailedIps.map((x) => h('span', { class: 'row gap tight' }, ipChip(x.ip), h('span', { class: 'stat-sub' }, `\u00d7${x.n}`)))) : h('p', { class: 'field-hint' }, 'None. \uD83C\uDF89'),
      h('div', { class: 'admin-head' }, h('h3', null, 'Recent security events'), h('span', { class: 'field-hint' }, 'Since the server last started')),
      h('div', { class: 'adm-table' }, ...(sec.events.length ? sec.events.slice(0, 100).map((e) => h('div', { class: 'adm-row three' }, h('strong', null, label[e.type] || e.type),
        e.ip ? ipChip(e.ip) : h('span', { class: 'stat-sub' }, '\u2014'), h('span', { class: 'stat-sub' }, `${e.detail ? e.detail + ' \u00b7 ' : ''}${ago(e.at)}`))) : [h('div', { class: 'adm-row three' }, h('span', { class: 'stat-sub' }, 'Nothing yet.'))])));
  }

  async function storage() {
    const [st, gl] = await Promise.all([api('GET', '/admin/storage'), api('GET', '/gifs/library')]);
    const gifCap = h('input', { class: 'input', type: 'number', min: '100', step: '100', value: String(gl.capMb) });
    const saveGif = async (patch) => { try { await api('PUT', '/admin/gif-library', patch); toast('Saved.'); storage(); } catch (e) { toast(e.message, 'error'); } };
    const gifSection = [
      h('div', { class: 'admin-head' }, h('h3', null, 'GIF library')),
      h('p', { class: 'field-hint' }, `${gl.count} GIFs, ${fmtSize(gl.bytes)}. These live on this server: free to search and send, no limits, and the picker falls back to them whenever KLIPY or GIPHY says "too many requests".`),
      h('div', { class: 'kv' }, h('span', null, 'Who can add GIFs'), h('div', { class: 'chips' }, [['everyone', 'Everyone'], ['staff', 'Staff only']].map(([k, l]) => h('button', { class: `chip${gl.who === k ? ' active' : ''}`, onclick: () => saveGif({ who: k }) }, l)))),
      h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, 'Keep a copy of GIFs people send from KLIPY/GIPHY'),
        h('span', { class: 'field-hint' }, 'Popular GIFs then work even when the API limit is reached. Check your provider\u2019s terms first: some don\u2019t allow storing their GIFs.')),
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: gl.learn, onchange: (e) => saveGif({ learn: e.target.checked }) }), h('span', { class: 'switch-track' }))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Largest the library may get'), h('div', { class: 'row gap tight' }, gifCap, h('span', { class: 'stat-sub' }, 'MB'), h('button', { class: 'btn ghost sm', onclick: () => saveGif({ capMb: gifCap.value }) }, 'Save')),
        h('span', { class: 'field-hint' }, 'When it\u2019s full, the least-used automatically collected GIFs make room first.')),
    ];
    const L = { ...st.limits };
    const num = (k, label, hint) => {
      const inp = h('input', { class: 'input', type: 'number', min: '0', step: '1', value: String(L[k]), oninput: (e) => { L[k] = e.target.value; } });
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('div', { class: 'row gap tight' }, inp, h('span', { class: 'stat-sub' }, 'MB')), hint ? h('span', { class: 'field-hint' }, hint) : null);
    };
    const kinds = { attachment: 'Files in messages', image: 'Pictures (avatars, banners, icons\u2026)', song: 'Profile songs', emoji: 'Emoji', gif: 'GIF library' };
    const words = h('textarea', { class: 'input', rows: '5', placeholder: 'one word or phrase per line' });
    words.value = (st.words || []).join('\n');
    clear(body).append(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Uploads in total'), h('strong', null, fmtSize(st.total))),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Uploaded today'), h('strong', null, fmtSize(st.today))),
        st.diskFree != null ? h('div', { class: `stat${st.diskFree < 2 * 1024 ** 3 ? ' warn' : ''}` }, h('span', { class: 'stat-label' }, 'Free disk space'), h('strong', null, fmtSize(st.diskFree))) : null,
        ...st.byKind.map((k) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, kinds[k.kind] || k.kind), h('strong', null, fmtSize(k.bytes)), h('span', { class: 'stat-sub' }, `${k.files} files`)))),
      h('div', { class: 'admin-head' }, h('h3', null, 'Upload limits')),
      h('p', { class: 'field-hint' }, '0 means no limit. Admins and the owner aren\u2019t held to the storage or daily limits. You can give one person more (or less) room from their page under Users.'),
      h('div', { class: 'grid-2' },
        num('fileMb', 'Largest file in a message'),
        num('imageMb', 'Largest picture', 'Avatars, banners, backgrounds, server icons.'),
        num('songMb', 'Largest profile song'),
        num('quotaMb', 'Storage per person', 'Everything one person has uploaded, together.'),
        num('dailyMb', 'Uploads per person per day', 'Stops someone filling your disk in one go.')),
      h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: async () => {
        try { await api('PUT', '/admin/limits', L); toast('Limits saved.'); storage(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Save limits')),
      h('div', { class: 'admin-head' }, h('h3', null, 'Who uses the most space')),
      h('div', { class: 'adm-table' },
        h('div', { class: 'adm-row head' }, h('span', null, 'Person'), h('span', null, 'Files'), h('span', null, 'Used'), h('span', null, 'Last upload'), h('span', null, '')),
        ...st.top.map((r) => h('div', { class: 'adm-row' }, userCell(r.user, openUser), h('span', null, String(r.files)),
          h('span', null, `${fmtSize(r.bytes)}${r.quotaMb ? ` / ${r.quotaMb} MB` : ''}`, r.blocked ? h('span', { class: 'badge-tag bad' }, 'Uploads off') : null),
          h('span', { class: 'stat-sub' }, ago(r.last)),
          h('button', { class: 'btn ghost sm', onclick: () => r.user && openUser(r.user.id) }, 'Manage')))),
      ...gifSection,
      h('div', { class: 'admin-head' }, h('h3', null, 'Word filter')),
      h('p', { class: 'field-hint' }, 'Names, bios, profile pages and profile comments can\u2019t contain these (whole words, any capitalization). Chats are end-to-end encrypted, so they can\u2019t be filtered.'),
      words,
      h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: async () => {
        try { const r = await api('PUT', '/admin/words', { words: words.value }); toast(`Word filter saved (${r.words.length}).`); } catch (e) { toast(e.message, 'error'); }
      } }, 'Save word filter')));
  }

  async function broadcast() {
    const cfg = await api('GET', '/config');
    const text = h('textarea', { class: 'input', rows: '3', maxlength: '500', placeholder: 'e.g. Voice calls will be down for 10 minutes tonight at 9pm.' });
    text.value = cfg.announcement ? cfg.announcement.text : '';
    let level = cfg.announcement ? cfg.announcement.level : 'info';
    const levels = h('div', { class: 'chips' });
    const drawLevels = () => clear(levels).append(...[['info', 'Info'], ['warning', 'Warning'], ['success', 'Good news']].map(([k, l]) => h('button', { class: `chip${level === k ? ' active' : ''}`, onclick: () => { level = k; drawLevels(); } }, l)));
    drawLevels();
    const maint = h('input', { class: 'input', maxlength: '300', value: cfg.maintenance || '', placeholder: 'e.g. Upgrading the server, back in 15 minutes.' });
    clear(body).append(
      h('div', { class: 'admin-head' }, h('h3', null, 'Announcement banner')),
      h('p', { class: 'field-hint' }, 'Shown at the top of the app for everyone, right away. Each person can dismiss it.'),
      text, levels,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary', onclick: async () => { await api('PUT', '/admin/announcement', { text: text.value, level }); toast(text.value.trim() ? 'Announcement posted.' : 'Announcement removed.'); } }, 'Post announcement'),
        cfg.announcement ? h('button', { class: 'btn ghost', onclick: async () => { await api('PUT', '/admin/announcement', { text: '' }); toast('Announcement removed.'); broadcast(); } }, 'Remove') : null),
      h('div', { class: 'admin-head' }, h('h3', null, 'Maintenance mode')),
      h('p', { class: 'field-hint' }, cfg.maintenance ? '\u26a0 Maintenance mode is ON: only admins can use the app right now.' : 'Locks everyone except admins out of the app (with your message) until you turn it off. Useful during big changes.'),
      maint,
      h('div', { class: 'row gap' },
        h('button', { class: `btn ${cfg.maintenance ? 'ghost' : 'danger'}`, onclick: async () => {
          if (!maint.value.trim()) return toast('Write a short message for people first.', 'error');
          if (!cfg.maintenance && !(await confirmDialog({ title: 'Turn on maintenance mode?', text: 'Everyone except admins is disconnected until you turn it off.', confirm: 'Turn on', danger: true }))) return;
          await api('PUT', '/admin/maintenance', { text: maint.value }); toast('Maintenance mode is on.'); broadcast();
        } }, cfg.maintenance ? 'Update message' : 'Turn on'),
        cfg.maintenance ? h('button', { class: 'btn primary', onclick: async () => { await api('PUT', '/admin/maintenance', { text: '' }); toast('Maintenance mode is off.'); broadcast(); } }, 'Turn off') : null));
  }

  async function admins() {
    const { staff, me } = await api('GET', '/admin/staff');
    const owner = me === 'owner';
    const setRole = async (who, newRole) => {
      const r = await api('PUT', '/admin/staff', { ...who, role: newRole });
      toast(newRole ? `Now ${ROLE_LABEL[newRole].toLowerCase()}.` : 'Removed from staff.');
      admins();
      return r;
    };
    const roleMenu = (a) => h('button', { class: 'btn ghost sm', 'data-pop-anchor': '', onclick: (e) => menu(e.currentTarget, [
      a.role !== 'admin' ? { label: 'Make admin', icon: 'star', action: () => setRole({ userId: a.id }, 'admin').catch((x) => toast(x.message, 'error')) } : null,
      a.role !== 'moderator' ? { label: 'Make moderator', icon: 'shield', action: () => setRole({ userId: a.id }, 'moderator').catch((x) => toast(x.message, 'error')) } : null,
      { label: 'Make owner\u2026', icon: 'star', action: () => transferOwner(a) },
      { label: 'Remove from staff', icon: 'close', danger: true, action: async () => {
        if (await confirmDialog({ title: `Remove ${a.displayName} from staff?`, text: 'They lose access to the dashboard right away.', confirm: 'Remove', danger: true })) setRole({ userId: a.id }, null).catch((x) => toast(x.message, 'error'));
      } },
    ]) }, 'Change role');
    const transferOwner = async (a) => {
      const typed = h('input', { class: 'input', placeholder: a.username, autocomplete: 'off' });
      modal({ title: `Make ${a.displayName} the owner?`, size: 'sm',
        body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'They get full control, including staff roles. You stay on as an admin, and only they can give ownership back.'), field(`Type ${a.username} to confirm`, typed)),
        actions: [{ label: 'Cancel' }, { label: 'Make owner', kind: 'danger', action: async () => {
          if (typed.value.trim().toLowerCase() !== a.username.toLowerCase()) { toast('The name doesn\u2019t match.', 'error'); return false; }
          await api('POST', '/admin/owner', { userId: a.id }); toast(`${a.displayName} is now the owner.`); admins();
        } }] });
    };
    const name = h('input', { class: 'input', placeholder: 'username' });
    let newRole = 'moderator';
    const roleChips = h('div', { class: 'chips' });
    const drawChips = () => clear(roleChips).append(...[['moderator', 'Moderator'], ['admin', 'Admin']].map(([k, l]) => h('button', { class: `chip${newRole === k ? ' active' : ''}`, onclick: () => { newRole = k; drawChips(); } }, l)));
    drawChips();
    clear(body).append(h('div', { class: 'admin-head' }, h('h3', null, 'Team & roles')),
      h('div', { class: 'role-guide' }, ...['owner', 'admin', 'moderator'].map((r) => h('div', null, roleTag(r), h('span', { class: 'stat-sub' }, ROLE_HINT[r])))),
      h('div', { class: 'adm-table' }, ...staff.map((a) => h('div', { class: 'adm-row three' }, userCell(a, openUser),
        h('span', { class: 'stat-sub' }, a.role === 'owner' ? 'Owner' : a.fromEnv ? 'Admin through ADMIN_USERS in .env' : ROLE_LABEL[a.role]),
        owner && a.role !== 'owner' ? h('span', { style: { justifySelf: 'end' } }, a.fromEnv ? h('button', { class: 'btn ghost sm', onclick: () => transferOwner(a) }, 'Make owner\u2026') : roleMenu(a)) : h('span')))),
      owner ? h('div', { class: 'stack' },
        h('div', { class: 'admin-head' }, h('h3', null, 'Add someone to the team')),
        h('p', { class: 'field-hint' }, 'Only give roles to people you trust: staff can see IP addresses and reports, and suspend people below them.'),
        roleChips,
        h('div', { class: 'row gap' }, name, h('button', { class: 'btn primary', onclick: async () => {
          const u = name.value.trim().replace(/^@/, '');
          if (!u) return toast('Type a username first.', 'error');
          if (!(await confirmDialog({ title: `Make ${u} ${newRole === 'admin' ? 'an admin' : 'a moderator'}?`, text: ROLE_HINT[newRole], confirm: 'Add' }))) return;
          await setRole({ username: u }, newRole).catch((x) => toast(x.message, 'error'));
        } }, 'Add')))
        : h('p', { class: 'field-hint' }, 'Only the owner can change roles.'));
  }

  // ---------------------------------------------------------------- regions (call relays near people)
  async function regions() {
    const d = await api('GET', '/admin/regions');
    const showCommand = (title, command) => modal({
      title, size: 'lg',
      body: h('div', { class: 'stack' },
        h('ol', { class: 'steps' },
          h('li', null, 'Rent the cheapest VPS in that part of the world (1 CPU and 1 GB is plenty; Ubuntu or Debian). See the price guide below.'),
          h('li', null, 'Log in to it as root (ssh root@its-ip) and paste this one line:'),
        ),
        h('div', { class: 'cmd-box' }, h('code', null, command), h('button', { class: 'btn sm', onclick: () => { copyText(command); toast('Copied.'); } }, icon('copy'), 'Copy')),
        h('p', { class: 'field-hint' }, 'The link works for 24 hours. It installs the call relay with this server\u2019s secret and a tiny check-in that reports here every minute. Within a minute of finishing, the region shows as online and calls start using it.'),
        h('p', { class: 'field-hint' }, 'If the VPS provider has a firewall in its control panel, open UDP + TCP 3478 and UDP 49160\u201349400 there.')),
    });
    // An install command carries this server's relay secret, so making one asks for your password again.
    const withPassword = (fn) => (confirm ? confirm(fn, { title: 'Confirm it\u2019s you', text: 'The install command carries this server\u2019s relay secret.' }) : fn({}));
    const add = () => {
      const name = h('input', { class: 'input', maxlength: '40', placeholder: 'e.g. Frankfurt, US West, Singapore' });
      modal({ title: 'Add a region', size: 'sm', body: h('div', { class: 'stack' }, field('Name', name, 'Shown to you here and to people choosing a relay.')),
        actions: [{ label: 'Cancel' }, { label: 'Get install command', kind: 'primary', action: async () => {
          if (!name.value.trim()) throw new Error('Give the region a name, like "Frankfurt" or "US West".');
          const r = await withPassword((x) => api('POST', '/admin/regions', { name: name.value.trim(), origin: location.origin, ...x }));
          if (!r) return false;
          regions(); setTimeout(() => showCommand(`Set up ${r.region.name}`, r.command), 150);
        } }] });
    };
    const measured = h('div', { class: 'stack' });
    const measure = async (btn) => {
      btn.disabled = true; clear(measured).append(h('span', { class: 'spinner' }));
      const ice = await api('GET', '/ice');
      const ranks = await rankRelays(ice, { force: true });
      clear(measured);
      const relays = ice.filter((e) => [].concat(e.urls || []).some((u) => /^turns?:/.test(u)));
      if (!relays.length) measured.append(h('p', { class: 'field-hint' }, 'No relays yet.'));
      relays.map((e) => ({ e, ms: relayTime(ranks, e) })).sort((a, b) => (a.ms ?? 1e9) - (b.ms ?? 1e9)).forEach(({ e, ms }) => measured.append(h('div', { class: 'kv' }, h('span', null, e.region || [].concat(e.urls)[0]), h('b', null, typeof ms === 'number' ? `${ms} ms` : 'no answer'))));
      btn.disabled = false;
    };
    const status = (r) => r.alive ? h('span', { class: 'rpill ok' }, 'Online') : r.waitingForInstall ? h('span', { class: 'rpill warn' }, r.installOpen ? 'Waiting for install' : 'Install link expired') : h('span', { class: 'rpill bad' }, `Offline since ${ago(r.lastSeen)}`);
    clear(body).append(
      h('div', { class: 'admin-head' }, h('h3', null, 'Regions'), h('button', { class: 'btn primary', onclick: add }, icon('plus'), 'Add a region')),
      h('p', { class: 'field-hint' }, 'Chat lives on this one server: everyone sees the same messages instantly, and there\u2019s one database to back up. What distance slows down is calls that can\u2019t connect directly (about 1 in 5) and go through a relay. Regions put relays near people; each person\u2019s app measures which answer fastest and uses those two.'),
      h('div', { class: 'adm-table' },
        h('div', { class: 'adm-row region-row' }, h('b', null, 'This server'), h('span', { class: 'stat-sub' }, d.mainTurn.length ? d.mainTurn[0].replace(/^turn:|\?.*$/g, '') : 'No relay here (run scripts/setup-turn.sh to add one)'), h('span', { class: `rpill ${d.mainTurn.length ? 'ok' : 'warn'}` }, d.mainTurn.length ? 'Relay on' : 'Chat only'), h('span'), h('span')),
        ...d.regions.map((r) => h('div', { class: 'adm-row region-row' },
          h('b', null, r.name), h('span', { class: 'stat-sub' }, r.ip || '\u2014'), status(r),
          h('span', { class: 'stat-sub' }, r.alive ? `load ${r.load ?? '?'} / ${r.cpus || 1} CPU \u00b7 ${r.mbps ?? 0} Mbit/s now \u00b7 ${r.monthGb ?? 0} GB this month${r.relayUp ? '' : ' \u00b7 relay stopped!'}` : ''),
          // Backup space on the region (Hearth 1.25+): keeps copies of this server's encrypted backups.
          h('span', { class: 'stat-sub', 'data-tip': r.backup && r.backup.last && !r.backup.last.ok ? r.backup.last.error : null },
            !r.backup ? 'Backups: reinstall to add backup space' : !r.backup.ready ? 'Backups: no backup space (needs SSH)'
              : `Backups: ${r.backup.files} cop${r.backup.files === 1 ? 'y' : 'ies'}, ${fmtMb(r.backup.usedMb)} (${fmtMb(r.backup.freeMb)} free)${r.backup.last ? (r.backup.last.ok ? ` \u00b7 last copy ${ago(r.backup.last.at)} \u2713` : ' \u00b7 last copy FAILED') : ' \u00b7 waiting for the next backup'}`),
          h('span', { class: 'row gap tight' },
            h('button', { class: 'btn ghost sm', onclick: async () => {
              try {
                const x = await withPassword((y) => api('POST', `/admin/regions/${r.id}/reinstall`, { origin: location.origin, ...y }));
                if (x) showCommand(`Reinstall ${r.name}`, x.command);
              } catch (e) { if (!e.cancelled) toast(e.message, 'error'); }
            } }, r.waitingForInstall ? 'Install command' : 'Reinstall'),
            h('button', { class: 'btn ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: `Remove ${r.name}?`, text: 'Calls stop using it right away. The VPS keeps running until you cancel it with your provider.', confirm: 'Remove', danger: true })) { await api('DELETE', `/admin/regions/${r.id}`); regions(); } } }, 'Remove'))))),
      d.regions.length ? '' : h('p', { class: 'field-hint' }, 'No regions yet.'),
      h('div', { class: 'admin-head' }, h('h3', null, 'Which relay is nearest to me?')),
      h('div', null, h('button', { class: 'btn', onclick: (e) => measure(e.currentTarget) }, 'Measure from this device')), measured,
      h('div', { class: 'admin-head' }, h('h3', null, 'Cheap places to put a region')),
      h('p', { class: 'field-hint' }, 'A relay only forwards call traffic, so the smallest plan is enough. Traffic matters more than CPU: one relayed video call is about 1\u20132 Mbit/s per person. Prices change; check before buying.'),
      h('div', { class: 'adm-table price-table' },
        ...[
          ['Oracle Cloud Always Free', '$0', 'Arm VM (2 CPU / 12 GB since mid-2026) with 10 TB traffic a month. Many regions. Needs a card to sign up; free VMs can be hard to get in busy regions.'],
          ['Hetzner Cloud', '\u2248 \u20ac5.50/mo', 'Germany and Finland with 20 TB traffic: best value for Europe. Their US (1 TB) and Singapore (0.5 TB) plans include little traffic. The cheapest plans sell out at times.'],
          ['Contabo (your current host)', '\u2248 $5\u20137/mo', 'EU, US, UK, Asia, Australia. Lots of traffic included. Same account you already have.'],
          ['Vultr / DigitalOcean / Linode', '$4\u20136/mo', '30+ cities worldwide, 0.5\u20132 TB traffic. Good for places the others don\u2019t cover (South America, India, Japan, Australia).'],
        ].map(([n, p2, t]) => h('div', { class: 'adm-row three' }, h('b', null, n), h('span', null, p2), h('span', { class: 'stat-sub' }, t)))),
      h('p', { class: 'field-hint' }, 'Start with the region where most people who can\u2019t connect live (Europe and US East cover most friend groups). Two or three regions is plenty for thousands of people.'));
    timer = setInterval(() => { api('GET', '/admin/regions').then((x) => { if (JSON.stringify(x.regions.map((r) => [r.alive, r.mbps])) !== JSON.stringify(d.regions.map((r) => [r.alive, r.mbps]))) regions(); }).catch(() => {}); }, 20000);
  }

  // ---------------------------------------------------------------- money (Ko-fi / Stripe → automatic supporters)
  async function money() {
    const d = await api('GET', '/admin/money');
    const c = d.config;
    const cur = (cents, code = c.currency) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: code || 'USD' }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${code}`; } };
    const save = async (patch) => { try { await api('PUT', '/admin/money', patch); toast('Saved.'); money(); } catch (e) { toast(e.message, 'error'); } };
    const hook = (p) => `${location.origin}/api/pay/${p}`;
    const f = {
      price: h('input', { class: 'input', type: 'number', min: '1', step: '0.5', value: String(c.monthlyCents / 100) }),
      currency: h('input', { class: 'input', maxlength: '3', value: c.currency }),
      fileMb: h('input', { class: 'input', type: 'number', min: '0', value: String(c.fileMb || ''), placeholder: '0 = same as everyone' }),
      kofiUrl: h('input', { class: 'input', value: c.kofiUrl, placeholder: 'https://ko-fi.com/yourname' }),
      kofiToken: h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: c.kofiTokenSet ? 'Saved (paste to replace)' : 'Verification token from Ko-fi' }),
      stripeLink: h('input', { class: 'input', value: c.stripeLink, placeholder: 'https://buy.stripe.com/\u2026' }),
      stripeSecret: h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: c.stripeSecretSet ? 'Saved (paste to replace)' : 'whsec_\u2026' }),
    };
    const copyRow = (label, text) => h('div', { class: 'kv' }, h('span', null, label), h('span', { class: 'row gap tight' }, h('code', { class: 'mono-sm' }, text), h('button', { class: 'btn ghost sm', onclick: () => { copyText(text); toast('Copied.'); } }, 'Copy')));
    const assign = (p) => {
      const who = h('input', { class: 'input', placeholder: 'username' });
      modal({ title: 'Who is this payment from?', size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, `${cur(p.cents, p.currency)} \u00b7 ${p.kind}${p.note ? ` \u00b7 \u201c${p.note}\u201d` : ''}`), field('Their username', who)),
        actions: [{ label: 'Cancel' }, { label: 'Give them supporter time', kind: 'primary', action: async () => { await api('POST', `/admin/money/payments/${p.id}/assign`, { username: who.value }); toast('Done.'); money(); } }] });
    };
    const local = /^https:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(location.origin) || location.protocol !== 'https:';
    clear(body).append(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'This month'), h('strong', null, cur(d.totals.monthCents))),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'All time'), h('strong', null, cur(d.totals.allCents))),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Supporters now'), h('strong', null, String(d.totals.supporters))),
        h('div', { class: `stat${d.totals.unmatched ? ' warn' : ''}` }, h('span', { class: 'stat-label' }, 'Need matching'), h('strong', null, String(d.totals.unmatched)))),
      h('p', { class: 'field-hint' }, 'People pay through Ko-fi or Stripe and become supporters automatically: \uD83D\uDC9C badge, your supporter perks, and it shows in the funding card\u2019s \u201craised this month\u201d. Each person has a support code (in their Support window) that links the payment to them. Nothing is charged by Hearth; the money goes straight to you.'),
      local ? h('p', { class: 'warn-box' }, 'Ko-fi and Stripe only deliver to a real HTTPS address. Put a domain in front of this server first (README \u2192 "On a VPS with a domain"); the webhook addresses below then use it.') : '',

      h('div', { class: 'admin-head' }, h('h3', null, 'Perks and price')),
      h('div', { class: 'grid-2' },
        field('One month of supporter costs', f.price, 'Payments buy time at this rate: paying twice this gives two months. Monthly subscriptions always give at least a month.'),
        field('Currency', f.currency),
        field('Biggest file supporters can send (MB)', f.fileMb, 'Bigger than everyone else\u2019s limit, or 0. Extra storage for supporters is under Owner \u2192 Funding.')),
      h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, 'Count payments in the funding card'), h('span', { class: 'field-hint' }, 'Adds Ko-fi and Stripe payments this month to \u201craised this month\u201d (plus anything you enter by hand).')),
        h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: c.autoRaised, onchange: (e) => save({ autoRaised: e.target.checked }) }), h('span', { class: 'switch-track' }))),
      h('div', null, h('button', { class: 'btn primary', onclick: () => save({ monthlyCents: Math.round(+f.price.value * 100), currency: f.currency.value, fileMb: f.fileMb.value }) }, 'Save')),

      h('div', { class: 'admin-head' }, h('h3', null, 'Ko-fi (free for one-off tips)')),
      h('ol', { class: 'steps' },
        h('li', null, 'Make a page at ko-fi.com and put its address below.'),
        h('li', null, 'On Ko-fi: Settings \u2192 More \u2192 API \u2192 Webhook URL, paste the address below, then copy the Verification Token back here.'),
        h('li', null, 'People paste their support code into the Ko-fi message. Payments without a code wait in the list below for you to match.')),
      copyRow('Webhook URL', hook('kofi')),
      h('div', { class: 'grid-2' }, field('Your Ko-fi page', f.kofiUrl), field('Verification token', f.kofiToken)),
      h('div', null, h('button', { class: 'btn primary', onclick: () => save({ kofiUrl: f.kofiUrl.value, ...(f.kofiToken.value.trim() ? { kofiToken: f.kofiToken.value.trim() } : {}) }) }, 'Save Ko-fi')),

      h('div', { class: 'admin-head' }, h('h3', null, 'Stripe (cards, Apple Pay, Google Pay, monthly)')),
      h('ol', { class: 'steps' },
        h('li', null, 'In Stripe, create a Payment Link (a one-off amount, or a monthly price for automatic renewals) and paste it below.'),
        h('li', null, 'Developers \u2192 Webhooks \u2192 Add endpoint with the address below and the events checkout.session.completed and invoice.paid. Copy its signing secret (whsec_\u2026) here.'),
        h('li', null, 'Hearth adds each person\u2019s code to the link, so their payment matches them without typing anything.')),
      copyRow('Webhook URL', hook('stripe')),
      h('div', { class: 'grid-2' }, field('Payment Link', f.stripeLink), field('Webhook signing secret', f.stripeSecret)),
      h('div', null, h('button', { class: 'btn primary', onclick: () => save({ stripeLink: f.stripeLink.value, ...(f.stripeSecret.value.trim() ? { stripeSecret: f.stripeSecret.value.trim() } : {}) }) }, 'Save Stripe')),

      h('div', { class: 'admin-head' }, h('h3', null, 'Payments')),
      d.payments.length ? h('div', { class: 'adm-table' }, ...d.payments.map((p) => h('div', { class: 'adm-row pay-row' },
        h('span', { class: 'stat-sub' }, ago(p.at)), h('b', null, cur(p.cents, p.currency)), h('span', null, p.kind),
        p.user ? userCell(p.user, openUser) : h('button', { class: 'btn sm', onclick: () => assign(p) }, 'Match to someone'),
        h('span', { class: 'stat-sub' }, p.note || '')))) : h('p', { class: 'field-hint' }, 'No payments yet.'),
      await membershipsAdmin(cur, hook, copyRow));
  }

  // Creator memberships: server owners sell monthly tiers through their own Stripe accounts (Stripe Connect);
  // this Hearth keeps a small fee. Set up once here.
  async function membershipsAdmin(cur, hook, copyRow) {
    const m = await api('GET', '/admin/memberships').catch(() => null);
    if (!m) return '';
    const c = m.config;
    const save = async (patch) => { try { await api('PUT', '/admin/memberships', patch); toast('Saved.'); money(); } catch (e) { toast(e.message, 'error'); } };
    const f = {
      key: h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: c.keySet ? `Saved (${c.keyMode} mode, paste to replace)` : 'sk_live_\u2026 or rk_live_\u2026' }),
      secret: h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: c.webhookSet ? 'Saved (paste to replace)' : 'whsec_\u2026' }),
      fee: h('input', { class: 'input', type: 'number', min: '0', max: '30', step: '0.5', value: String(c.feePercent) }),
      currency: h('input', { class: 'input', maxlength: '3', value: c.currency }),
    };
    const ready = c.keySet && c.webhookSet;
    return h('div', { class: 'stack' },
      h('div', { class: 'admin-head' }, h('h3', null, 'Creator memberships')),
      h('p', { class: 'field-hint' }, 'Let server owners sell monthly memberships (a role, private channels, perks they choose), like Patreon inside their server. Members pay on Stripe\u2019s page; the money goes to the creator\u2019s own Stripe account, and this Hearth keeps the fee you set below. It\u2019s purely extra: nothing that\u2019s free today changes.'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Creators getting paid'), h('strong', null, String(m.stats.creators))),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Paying members'), h('strong', null, String(m.stats.members))),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Memberships a month'), h('strong', null, cur(m.stats.monthlyCents, c.currency))),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, `Your ${c.feePercent}% a month`), h('strong', null, cur(m.stats.feeCents, c.currency)))),
      h('ol', { class: 'steps' },
        h('li', null, 'In Stripe, turn on Connect (Connect \u2192 Get started, choose \u201cExpress\u201d accounts). Stripe handles the creators\u2019 identity checks, payouts and tax forms.'),
        h('li', null, 'Developers \u2192 API keys: paste your secret key below (or a restricted key with write access to Accounts, Account Links, Checkout Sessions and Subscriptions).'),
        h('li', null, 'Developers \u2192 Webhooks \u2192 Add endpoint with the address below and the events checkout.session.completed, customer.subscription.updated, customer.subscription.deleted and invoice.paid. Copy its signing secret (whsec_\u2026) here.'),
        h('li', null, 'Turn memberships on. Server owners then find them in Server settings \u2192 Memberships.')),
      copyRow('Webhook URL', hook('memberships')),
      h('div', { class: 'grid-2' }, field('Stripe secret key', f.key, 'Stored encrypted. Never shown again.'), field('Webhook signing secret', f.secret),
        field('Your fee (%)', f.fee, 'Taken from each payment automatically (0\u201330). Stripe\u2019s own card fee is separate. Most platforms take 5\u201310%.'), field('Currency', f.currency)),
      h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: () => save({ feePercent: +f.fee.value, currency: f.currency.value, ...(f.key.value.trim() ? { key: f.key.value.trim() } : {}), ...(f.secret.value.trim() ? { webhookSecret: f.secret.value.trim() } : {}) }) }, 'Save')),
      h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, 'Let server owners sell memberships'), h('span', { class: 'field-hint' }, ready ? 'Turning this off stops new memberships; existing ones keep running until people cancel.' : 'Save the key and webhook secret first.')),
        h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: c.enabled, disabled: !ready && !c.enabled, onchange: (e) => save({ enabled: e.target.checked }) }), h('span', { class: 'switch-track' }))));
  }

  async function owner() {
    const o = await api('GET', '/admin/owner');
    const act = await api('GET', '/admin/activity').catch(() => ({}));
    const mail = await api('GET', '/admin/mail').catch(() => ({}));
    const mf = {
      publicUrl: h('input', { class: 'input', value: mail.publicUrl || location.origin, placeholder: 'https://chat.example.com' }),
      host: h('input', { class: 'input', value: mail.host || '', placeholder: 'smtp-relay.brevo.com' }),
      port: h('input', { class: 'input', type: 'number', value: String(mail.port || 587) }),
      user: h('input', { class: 'input', value: mail.user || '', autocomplete: 'off' }),
      pass: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: mail.passSet ? 'Saved (paste to replace)' : 'SMTP password / API key' }),
      from: h('input', { class: 'input', value: mail.from || '', placeholder: 'Hearth <no-reply@yourdomain.com>' }),
      test: h('input', { class: 'input', type: 'email', placeholder: 'you@example.com' }),
    };
    const lastfmKey = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: act.lastfmKeySet ? 'Saved (paste to replace, or clear)' : 'Last.fm API key' });
    const rawgKey = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: act.rawgKeySet ? 'Saved (paste to replace, or clear)' : 'RAWG API key (optional)' });
    const saveKeys = async (patch) => { try { await api('PATCH', '/admin/activity', patch); toast('Saved.'); owner(); } catch (e) { toast(e.message, 'error'); } };
    const save = async (patch, msg = 'Saved.') => { try { await api('PUT', '/admin/owner', patch); toast(msg); owner(); } catch (e) { toast(e.message, 'error'); } };
    const name = h('input', { class: 'input', maxlength: '40', value: o.brand.name });
    const tagline = h('input', { class: 'input', maxlength: '140', value: o.brand.tagline, placeholder: 'e.g. Our little corner of the internet' });
    const sw = (label, key, hint) => h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, label), hint ? h('span', { class: 'field-hint' }, hint) : null),
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!o.features[key], onchange: (e) => save({ features: { [key]: e.target.checked } }) }), h('span', { class: 'switch-track' })));
    const F = o.funding;
    const fund = { url: h('input', { class: 'input', value: F.url, placeholder: 'https://ko-fi.com/yourname' }), monthly: h('input', { class: 'input', type: 'number', min: '0', value: String(F.monthly || '') }),
      raised: h('input', { class: 'input', type: 'number', min: '0', value: String(F.raised || '') }), currency: h('input', { class: 'input', maxlength: '3', value: F.currency || 'USD' }),
      note: h('input', { class: 'input', maxlength: '300', value: F.note, placeholder: 'Optional: your own message' }) };
    const supQuota = h('input', { class: 'input', type: 'number', min: '0', value: String(o.supporterQuotaMb || '') , placeholder: '0 = same as everyone' });
    const keep = h('input', { class: 'input', type: 'number', min: '1', max: '60', value: String(o.autoBackup.keep) });
    const download = async (b) => {
      try {
        const r = await fetch(`/api/admin/backups/${encodeURIComponent(b.name)}`, { headers: { authorization: 'Bearer ' + localStorage.getItem('hearth.token') } });
        if (!r.ok) throw new Error('Download failed.');
        const url = URL.createObjectURL(await r.blob());
        h('a', { href: url, download: b.name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) { toast(e.message, 'error'); }
    };
    clear(body).append(
      h('div', { class: 'admin-head' }, h('h3', null, 'Name and welcome')),
      h('div', { class: 'grid-2' }, field('Server name', name, 'Shown in the browser tab, on the login screen and in installed apps.'), field('Tagline', tagline, 'One line under the name on the login screen.')),
      h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: () => save({ brand: { name: name.value, tagline: tagline.value } }) }, 'Save')),

      h('div', { class: 'admin-head' }, h('h3', null, 'Features')),
      h('p', { class: 'field-hint' }, 'Turn whole features on or off for everyone. Nothing is deleted when you turn something off.'),
      sw('Watch together', 'watch', 'Synced YouTube, Vimeo, Twitch and video links in calls.'),
      sw('GIF picker', 'gifs'),
      sw('Profile comment walls', 'comments'),
      sw('Custom CSS on profile pages', 'customCss', 'Turned off, everyone\u2019s page shows without their CSS (it\u2019s kept, not deleted).'),
      h('div', { class: 'kv' }, h('span', null, 'Who can create servers'), h('div', { class: 'chips' }, [['everyone', 'Everyone'], ['staff', 'Staff only']].map(([k, l]) => h('button', { class: `chip${o.features.createServers === k ? ' active' : ''}`, onclick: () => save({ features: { createServers: k } }) }, l)))),

      h('div', { class: 'admin-head' }, h('h3', null, 'Funding and supporters')),
      h('p', { class: 'field-hint' }, 'Show people what the server costs and where to chip in (Ko-fi, Patreon, Open Collective, Stripe link\u2026). It appears as a small card on everyone\u2019s Home screen that they can hide. Mark people who chip in as supporters under Users: they get a \uD83D\uDC9C badge and, if you like, more storage.'),
      h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, 'Show the funding card')), h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: F.enabled, onchange: (e) => save({ funding: { enabled: e.target.checked } }) }), h('span', { class: 'switch-track' }))),
      h('div', { class: 'grid-2' }, field('Donation link', fund.url), field('Monthly cost', fund.monthly), field('Raised this month', fund.raised), field('Currency (USD, EUR\u2026)', fund.currency)),
      field('Message', fund.note),
      field('Storage for supporters (MB)', supQuota, 'More room for people who help pay. Empty or 0 = same limit as everyone. Automatic payments and other perks: the Money tab.'),
      h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: () => save({ funding: { url: fund.url.value.trim(), monthly: fund.monthly.value, raised: fund.raised.value, currency: fund.currency.value.toUpperCase(), note: fund.note.value }, supporterQuotaMb: supQuota.value }) }, 'Save')),
      o.supporters.length ? h('div', { class: 'adm-table' }, ...o.supporters.map((u) => h('div', { class: 'adm-row three' }, userCell(u, openUser), h('span', { class: 'supporter-tag' }, '\uD83D\uDC9C Supporter'), h('button', { class: 'btn ghost sm', onclick: () => openUser(u.id) }, 'Manage')))) : h('p', { class: 'field-hint' }, 'No supporters yet.'),

      h('div', { class: 'admin-head' }, h('h3', null, 'Email (password resets)'), h('span', { class: `rpill ${mail.ready ? 'ok' : 'warn'}` }, mail.ready ? 'Working' : 'Not set up')),
      h('p', { class: 'field-hint' }, 'Lets people confirm an email and reset a forgotten password. Any SMTP service works. Free options: Brevo (300 emails/day), Resend (100/day) or a Gmail account with an app password (Google Account \u2192 Security \u2192 App passwords; host smtp.gmail.com, port 465).'),
      h('div', { class: 'grid-2' },
        field('Your server\u2019s address', mf.publicUrl, 'Used in reset links. Must be https://.'), field('From', mf.from, 'The sender people see.'),
        field('SMTP host', mf.host), field('Port', mf.port, '587 (STARTTLS) or 465 (SSL).'),
        field('Username', mf.user), field('Password', mf.pass)),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn primary', onclick: async () => { try { await api('PUT', '/admin/mail', { publicUrl: mf.publicUrl.value.trim(), host: mf.host.value.trim(), port: mf.port.value, user: mf.user.value.trim(), from: mf.from.value.trim(), ...(mf.pass.value ? { pass: mf.pass.value } : {}) }); toast('Saved.'); owner(); } catch (e) { toast(e.message, 'error'); } } }, 'Save email settings'),
        mf.test, h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await api('POST', '/admin/mail/test', { to: mf.test.value.trim() }); toast('Test email sent. Check that inbox (and spam).'); } catch (x) { toast(x.message, 'error'); } b.disabled = false; } }, 'Send a test email')),

      h('div', { class: 'admin-head' }, h('h3', null, 'Games & music')),
      h('p', { class: 'field-hint' }, `People show what they\u2019re playing and listening to, and their favorite games. Game pictures come from Steam and Wikipedia with no setup (${act.games || 0} games looked up so far). Two free keys make it better:`),
      h('div', { class: 'grid-2' },
        field('Last.fm API key', lastfmKey, 'Lets people link Last.fm so their song updates by itself from Spotify, Apple Music, YouTube Music\u2026 Free and instant: last.fm/api/account/create (any app name; callback can stay empty).'),
        field('RAWG API key', rawgKey, 'Optional. More console and mobile games with pictures. Free at rawg.io/apidocs.')),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary', onclick: () => saveKeys({ ...(lastfmKey.value.trim() ? { lastfmKey: lastfmKey.value.trim() } : {}), ...(rawgKey.value.trim() ? { rawgKey: rawgKey.value.trim() } : {}) }) }, 'Save keys'),
        act.lastfmKeySet ? h('button', { class: 'btn ghost sm', onclick: () => saveKeys({ lastfmKey: '' }) }, 'Remove Last.fm key') : null,
        act.rawgKeySet ? h('button', { class: 'btn ghost sm', onclick: () => saveKeys({ rawgKey: '' }) }, 'Remove RAWG key') : null),

      h('div', { class: 'admin-head' }, h('h3', null, 'Backups')),
      h('p', { class: 'field-hint' }, 'Encrypted backups hold everything needed to bring this server back on a new machine: the database, its keys and every uploaded file, locked with the backup key. Each one is test-restored right after it’s made. Plain database copies (for undoing an update) stay on the server and can’t be downloaded.'),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn primary', onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Backing up…';
          try { const r = await api('POST', '/admin/backups'); toast(r.verified && r.verified.ok ? 'Backup made and restore-tested.' : `Backup made, but its restore test FAILED: ${(r.verified || {}).error || ''}`, r.verified && r.verified.ok ? undefined : 'error'); owner(); } catch (x) { toast(x.message, 'error'); btn.disabled = false; btn.textContent = 'Back up now'; }
        } }, 'Back up now'),
        h('label', { class: 'row gap tight' }, h('input', { type: 'checkbox', checked: o.autoBackup.enabled, onchange: (e) => save({ autoBackup: { enabled: e.target.checked, keep: keep.value } }) }), 'Automatic daily backup, keep'),
        keep, h('button', { class: 'btn ghost sm', onclick: () => save({ autoBackup: { enabled: o.autoBackup.enabled, keep: keep.value } }) }, 'Save'),
        o.keyFrom === 'file' && confirm ? h('button', { class: 'btn ghost sm', onclick: async () => {
          try {
            const r = await confirm((x) => api('POST', '/admin/backups/key', x), { title: 'Show the backup key', text: 'Save it in a password manager. Without it, no backup can be restored (for example if this server is lost).' });
            if (!r) return;
            modal({ title: 'Backup key', size: 'md', body: h('div', { class: 'stack' }, h('div', { class: 'cmd-box secret-box' }, h('code', null, r.key)),
              h('button', { class: 'btn', onclick: () => copyText(r.key) }, icon('copy'), 'Copy'),
              h('p', { class: 'field-hint' }, 'Restore on a new machine: node server/cli.js restore <backup.hbk> <new-data-folder> <this key>. Never keep this key in the same place as the backups.')) });
          } catch (x) { if (!x.cancelled) toast(x.message, 'error'); }
        } }, 'Show backup key') : null),
      h('p', { class: 'field-hint' }, o.regionCopies && o.regionCopies.length ? `Every backup is also copied to your region${o.regionCopies.length === 1 ? '' : 's'} ${o.regionCopies.join(', ')} (still locked with the backup key).` : 'Tip: a linked region (Admin \u2192 Regions) keeps copies of every backup on another machine automatically.'),
      h('p', { class: 'field-hint' }, o.offsite ? `Off-site copies go to ${o.offsite} (rclone).` : 'Off-site copies to a storage provider are off. Set BACKUP_RCLONE_REMOTE in .env (for example b2:my-bucket/hearth) to add one.'),
      o.encrypted.length ? h('div', { class: 'adm-table' }, ...o.encrypted.map((b) => h('div', { class: 'adm-row' }, h('span', { class: 'mono-sm' }, b.name), h('span', { class: 'stat-sub' }, fmtSize(b.size)), h('span', { class: 'stat-sub' }, ago(b.at)),
        h('span', { class: b.verified && b.verified.ok ? 'rpill ok' : 'rpill' }, b.verified ? (b.verified.ok ? `restore test passed ${ago(b.verified.at)}` : `restore test FAILED: ${b.verified.error}`) : 'not tested'),
        b.offsite ? h('span', { class: 'stat-sub' }, b.offsite.ok ? 'off-site ✓' : `off-site failed: ${b.offsite.error}`) : h('span'),
        b.regions ? h('span', { class: 'stat-sub' }, Object.values(b.regions).map((x) => (x.ok ? `${x.name} \u2713` : `${x.name}: failed`)).join(' \u00b7 ')) : null,
        h('button', { class: 'btn ghost sm', onclick: async () => { try { const r = await api('POST', `/admin/backups/${encodeURIComponent(b.name)}/verify`); toast(r.verified.ok ? `Restore test passed: ${r.verified.users} accounts, ${r.verified.messages} messages, ${r.verified.files} files.` : `Restore test FAILED: ${r.verified.error}`, r.verified.ok ? undefined : 'error'); owner(); } catch (x) { toast(x.message, 'error'); } } }, 'Test restore'),
        h('button', { class: 'btn ghost sm', onclick: () => download(b) }, 'Download'),
        h('button', { class: 'btn ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: 'Delete this backup?', confirm: 'Delete', danger: true })) { await api('DELETE', `/admin/backups/${encodeURIComponent(b.name)}`); owner(); } } }, 'Delete')))) : h('p', { class: 'field-hint' }, 'No encrypted backups yet.'),
      o.backups.length ? h('p', { class: 'field-hint' }, `${o.backups.length} plain database cop${o.backups.length === 1 ? 'y' : 'ies'} on the server for undoing updates (newest ${ago(o.backups[0].at)}).`) : null);
  }

  async function log() {
    const [list, chain] = await Promise.all([api('GET', '/admin/log'), api('GET', '/admin/log/verify').catch(() => null)]);
    const table = h('div', { class: 'adm-table' });
    const addRows = (rows) => table.append(...rows.map((l) => h('div', { class: 'adm-row log' },
      h('span', { class: 'stat-sub' }, fmtStamp(l.created_at)), l.admin ? userCell(l.admin) : h('span', { class: 'stat-sub' }, 'server'), h('strong', null, l.action.replace(/_/g, ' ')),
      h('span', { class: 'stat-sub' }, [l.targetUser ? `@${l.targetUser.username}` : l.target, l.detail].filter(Boolean).join(' \u2014 ')), h('span', null, l.ip ? ipChip(l.ip) : ''))));
    addRows(list);
    let oldest = list.length ? list[list.length - 1].id : 0;
    const more = h('button', { class: 'btn ghost sm', hidden: list.length < 200, onclick: async () => {
      const next = await api('GET', `/admin/log?before=${oldest}`); addRows(next); if (next.length) oldest = next[next.length - 1].id; more.hidden = next.length < 200;
    } }, 'Older entries');
    clear(body).append(h('div', { class: 'admin-head' }, h('h3', null, 'Audit log'), h('span', { class: 'field-hint' }, 'Staff actions and account security events, newest first. Entries can\u2019t be edited or deleted.')),
      chain ? (chain.ok ? h('div', { class: 'chain-ok' }, icon('check'), `Tamper check passed: all ${chain.entries} entries are intact and in order.`)
        : h('div', { class: 'chain-bad' }, icon('shield'), `Tamper check FAILED at entry #${chain.brokenAt}: the log was changed outside Hearth (someone edited the database file).`)) : '',
      table, h('div', null, more));
  }

  wrap.append(nav, body);
  draw();
  wrap._stop = () => clearInterval(timer);
  return wrap;
}

function transferServer(x, after) {
  const who = h('input', { class: 'input', placeholder: 'username of a member' });
  modal({ title: `Give ${x.name} to someone else?`, size: 'sm',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, `They become the owner of ${x.name}. They must already be a member. Useful when the owner has left or gone quiet.`), field('New owner', who)),
    actions: [{ label: 'Cancel' }, { label: 'Give server', kind: 'primary', action: async () => { await api('POST', `/admin/servers/${x.id}/transfer`, { username: who.value }); toast('Server handed over.'); after(); } }] });
}
function noteDialog(title, onSave) {
  const note = h('input', { class: 'input', maxlength: '500', placeholder: 'Optional note for other admins' });
  modal({ title, size: 'sm', body: field('Note', note), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: () => onSave(note.value) }] });
}
export function suspendDialog(user, after) {
  const reason = h('input', { class: 'input', maxlength: '300', placeholder: 'Shown to them when they try to log in' });
  let hours = 24;
  const chipsEl = h('div', { class: 'chips' });
  const drawChips = () => clear(chipsEl).append(...DURATIONS.map(([v, l]) => h('button', { type: 'button', class: `chip${hours === v ? ' active' : ''}`, onclick: () => { hours = v; drawChips(); } }, l)));
  drawChips();
  modal({
    title: `Suspend ${user.displayName}?`, size: 'sm',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'They\u2019re signed out everywhere immediately and can\u2019t log back in until the time is up (or you unsuspend them). Their messages stay.'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'For how long'), chipsEl), field('Reason', reason)),
    actions: [{ label: 'Cancel' }, { label: 'Suspend', kind: 'danger', action: async () => { await api('POST', `/admin/users/${user.id}/suspend`, { reason: reason.value, hours }); toast(`${user.displayName} is suspended.`); if (after) await after(); } }],
  });
}
async function userModal(id, refresh, myRank = 2) {
  const u = await api('GET', `/admin/users/${id}`).catch((e) => { toast(e.message, 'error'); return null; });
  if (!u) return;
  const setLimits = async (patch, msg) => {
    try { await api('PATCH', `/admin/users/${id}/limits`, patch); toast(msg); m.close(); userModal(id, refresh, myRank); refresh(); } catch (e) { toast(e.message, 'error'); }
  };
  const m = modal({
    title: `${u.displayName} (@${u.username})`, size: 'lg', className: 'admin-user',
    body: h('div', { class: 'stack' },
      h('div', { class: 'row gap wrap' },
        u.online ? h('span', { class: 'badge-tag ok' }, 'Online') : h('span', { class: 'badge-tag' }, `Last seen ${ago(u.lastSeen)}`),
        roleTag(u.role),
        u.suspendedAt ? h('span', { class: 'badge-tag bad' }, `Suspended ${ago(u.suspendedAt)}${u.suspendedUntil ? ` until ${fmtStamp(u.suspendedUntil)}` : ''}${u.suspendReason ? `: ${u.suspendReason}` : ''}`) : null,
        h('span', { class: 'stat-sub' }, `Joined ${fmtStamp(u.createdAt)} \u00b7 ${u.servers.length} servers \u00b7 made ${u.reportsBy} reports`)),
      h('h4', null, 'IP addresses'),
      h('div', { class: 'adm-table' }, ...u.ips.map((x) => h('div', { class: 'adm-row three' }, ipChip(x.ip), h('span', { class: 'stat-sub' }, `first ${fmtStamp(x.firstSeen)}`), h('span', { class: 'stat-sub' }, `last ${ago(x.lastSeen)}`)))),
      h('p', { class: 'field-hint' }, `Email: ${u.emailMasked || 'none'} \u00b7 Two-factor: ${u.totpEnabled ? 'on' : 'off'} \u00b7 Recovery key: ${u.hasRecovery ? 'saved' : 'none'}`),
      h('h4', null, `Signed-in devices \u2014 ${u.sessions.length}`),
      h('div', { class: 'adm-table' }, ...u.sessions.map((x) => h('div', { class: 'adm-row three' }, h('span', null, device(x.ua)), x.ip ? ipChip(x.ip) : h('span'), h('span', { class: 'stat-sub' }, `active ${ago(x.lastSeen)}`)))),
      u.reportsAgainst.length ? h('h4', null, `Reports about them \u2014 ${u.reportsAgainst.length}`) : null,
      u.reportsAgainst.length ? h('div', { class: 'adm-table' }, ...u.reportsAgainst.map((r) => h('div', { class: 'adm-row three' }, h('span', null, CATEGORY_LABEL[r.category] || r.category), h('span', { class: 'stat-sub' }, r.status), h('span', { class: 'stat-sub' }, fmtStamp(r.createdAt))))) : null,
      h('h4', null, 'Uploads & profile'),
      h('div', { class: 'stack' },
        h('div', { class: 'kv' }, h('span', null, 'Storage used'), h('strong', null, `${fmtSize(u.storage.used)}${u.storage.quotaMb ? ` of ${u.storage.quotaMb} MB` : ' (no limit)'}${u.quotaOverride != null ? ' \u00b7 custom limit' : ''}`)),
        h('div', { class: 'kv' }, h('span', null, 'Profile comments written'), h('strong', null, String(u.commentsWritten))),
        u.canAct ? h('div', { class: 'row gap wrap' },
          h('button', { class: `chip${u.storage.blocked ? ' active' : ''}`, onclick: () => setLimits({ uploadsBlocked: !u.storage.blocked }, u.storage.blocked ? 'Uploads turned back on.' : 'Uploads turned off.') }, u.storage.blocked ? 'Uploads are off \u2014 turn on' : 'Turn off uploads'),
          myRank >= 2 && u.totpEnabled ? h('button', { class: 'chip', onclick: async () => { if (!(await confirmDialog({ title: `Remove two-factor sign-in for ${u.username}?`, text: 'Only do this if you\u2019re sure it\u2019s really them (they lost their phone and backup codes). They can set it up again in Settings.', confirm: 'Remove 2FA', danger: true }))) return; await api('POST', `/admin/users/${u.id}/2fa/remove`); toast('Two-factor sign-in removed.'); refresh(); } }, '\uD83D\uDD10 2FA on \u2014 remove') : null,
          myRank >= 2 ? h('button', { class: `chip${u.supporter ? ' active' : ''}`, onclick: () => setLimits({ supporter: !u.supporter }, u.supporter ? 'No longer a supporter.' : 'Marked as a supporter. Thank you, them!') }, u.supporter ? '\uD83D\uDC9C Supporter \u2014 remove' : 'Mark as supporter') : null,
          myRank >= 2 ? h('button', { class: 'chip', onclick: () => {
            const inp = h('input', { class: 'input', maxlength: '24', value: u.username, autocomplete: 'off', spellcheck: 'false' });
            modal({ title: `Change @${u.username}\u2019s username`, size: 'sm',
              body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'For offensive or impersonating names. They sign in with the new name from now on (their password stays the same), and they\u2019re told by email if they have one. The old name is free for anyone right away.'), inp),
              actions: [{ label: 'Cancel' }, { label: 'Change username', kind: 'primary', action: async () => {
                const r = await api('POST', `/admin/users/${id}/username`, { username: inp.value });
                toast(`Now @${r.username}.`); m.close(); userModal(id, refresh, myRank); refresh();
              } }] });
            setTimeout(() => inp.select(), 50);
          } }, 'Change username') : null,
          h('button', { class: `chip${u.profileLocked ? ' active' : ''}`, onclick: () => setLimits({ profileLocked: !u.profileLocked }, u.profileLocked ? 'Profile unlocked.' : 'Profile locked.') }, u.profileLocked ? 'Profile is locked \u2014 unlock' : 'Lock profile'),
          myRank >= 2 ? h('button', { class: 'chip', onclick: () => {
            const inp = h('input', { class: 'input', type: 'number', min: '0', placeholder: 'empty = server default', value: u.quotaOverride != null ? String(u.quotaOverride) : '' });
            modal({ title: 'Storage limit for this person', size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'In MB. 0 means no limit; leave it empty to use the server\u2019s default.'), inp),
              actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: () => setLimits({ quotaMb: inp.value === '' ? null : +inp.value }, 'Storage limit saved.') }] });
          } }, 'Change storage limit') : null,
          u.commentsWritten ? h('button', { class: 'chip', onclick: async () => {
            if (!(await confirmDialog({ title: 'Delete all their profile comments?', text: `${u.commentsWritten} comments on people\u2019s pages are removed.`, confirm: 'Delete', danger: true }))) return;
            const r = await api('DELETE', `/admin/users/${id}/comments`); toast(`Deleted ${r.count} comments.`); m.close(); userModal(id, refresh, myRank);
          } }, 'Delete their comments') : null,
          myRank >= 2 && u.storage.used ? h('button', { class: 'chip danger-text', onclick: async () => {
            if (!(await confirmDialog({ title: 'Delete everything they uploaded?', text: 'Pictures, songs and every file they attached to messages are deleted for good. Their messages stay, without the files.', confirm: 'Delete files', danger: true }))) return;
            const r = await api('DELETE', `/admin/users/${id}/files`); toast(`Deleted ${r.count} files.`); m.close(); userModal(id, refresh, myRank);
          } }, 'Delete all their files') : null) : null),
      notesBox(u, () => { m.close(); userModal(id, refresh, myRank); }, myRank),
      u.myRole === 'owner' && u.canAct ? h('div', { class: 'row gap wrap' }, h('span', { class: 'field-label' }, 'Staff role'),
        ...[['moderator', 'Moderator'], ['admin', 'Admin'], [null, 'None']].map(([r, l]) => h('button', { class: `chip${(u.role || null) === r ? ' active' : ''}`, onclick: async () => {
          await api('PUT', '/admin/staff', { userId: id, role: r }).then(() => { toast(r ? `Now ${l.toLowerCase()}.` : 'Removed from staff.'); m.close(); userModal(id, refresh, myRank); refresh(); }, (x) => toast(x.message, 'error'));
        } }, l))) : null,
      u.canAct ? null : h('p', { class: 'field-hint' }, 'You can look, but only someone ranked above this account can suspend, sign out or reset it.')),
    actions: !u.canAct ? [] : [
      { label: 'Reset profile', action: async () => {
        if (!(await confirmDialog({ title: `Reset ${u.displayName}\u2019s profile?`, text: 'Their avatar, banner, background, song, display name, bio, status and links are cleared. Use it for offensive profiles. It can\u2019t be undone.', confirm: 'Reset profile', danger: true }))) return false;
        await api('POST', `/admin/users/${id}/reset-profile`); toast('Profile reset.'); refresh();
      } },
      { label: 'Sign out everywhere', action: async () => { await api('POST', `/admin/users/${id}/logout`); toast('Signed out of all devices.'); refresh(); } },
      u.suspendedAt
        ? { label: 'Unsuspend', kind: 'primary', action: async () => { await api('POST', `/admin/users/${id}/unsuspend`); toast('Unsuspended.'); refresh(); } }
        : { label: 'Suspend\u2026', kind: 'danger', action: () => { m.close(); suspendDialog(u, refresh); return false; } },
    ].filter(Boolean),
  });
}
// Private staff notes on an account.
function notesBox(u, reload, myRank) {
  const ta = h('textarea', { class: 'input', rows: '2', maxlength: '1000', placeholder: 'Add a private note for staff (e.g. \u201cwarned about spam on 3 May\u201d)' });
  return h('div', { class: 'stack' },
    h('h4', null, `Staff notes${u.notes.length ? ` \u2014 ${u.notes.length}` : ''}`),
    u.notes.length ? h('div', { class: 'adm-table' }, ...u.notes.map((n) => h('div', { class: 'adm-row note' },
      h('div', { class: 'note-body' }, h('span', { class: 'note-text' }, n.text), h('span', { class: 'stat-sub' }, `${n.author ? n.author.displayName : 'Former staff'} \u00b7 ${fmtStamp(n.createdAt)}`)),
      n.mine || myRank >= 2 ? h('button', { class: 'btn ghost sm danger-text', onclick: async () => { await api('DELETE', `/admin/notes/${n.id}`).catch((x) => toast(x.message, 'error')); reload(); } }, 'Delete') : h('span')))) : h('p', { class: 'field-hint' }, 'Only staff can see these. Nothing yet.'),
    ta,
    h('div', null, h('button', { class: 'btn ghost sm', onclick: async () => {
      if (!ta.value.trim()) return;
      await api('POST', `/admin/users/${u.id}/notes`, { text: ta.value }).then(reload, (x) => toast(x.message, 'error'));
    } }, 'Add note')));
}
