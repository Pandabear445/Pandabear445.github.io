// Admin dashboard (server administrators only). Everything here is also enforced by the server.
import { h, clear, icon, toast, fmtStamp, fmtSize, copyText } from './util.js';
import { api } from './api.js';
import { avatarEl } from './profile-ui.js';
import { modal, confirmDialog, field, menu } from './ui.js';
import { renderDoc, render as md } from './markdown.js';

const TABS = [['overview', 'Overview', 'home'], ['online', 'Online', 'people'], ['reports', 'Reports', 'shield'], ['users', 'Users', 'user'], ['servers', 'Servers', 'compass'], ['security', 'Security', 'lock'], ['broadcast', 'Broadcast', 'megaphone'], ['admins', 'Admins', 'star'], ['registration', 'Registration & Terms', 'book'], ['log', 'Audit log', 'file']];
export const CATEGORY_LABEL = {
  spam: 'Spam', harassment: 'Harassment or bullying', hate: 'Hate speech', threats: 'Threats or violence', sexual: 'Sexual content',
  child_safety: 'Child safety', self_harm: 'Self-harm', illegal: 'Illegal content', impersonation: 'Impersonation', scam: 'Scam or fraud', other: 'Something else',
};
const asUser = (b) => (b ? { id: b.id, username: b.username, avatar: b.avatar, profile: { displayName: b.displayName } } : { id: '', username: 'deleted', profile: { displayName: 'Deleted user' } });
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
  b && b.suspended ? h('span', { class: 'badge-tag bad' }, 'Suspended') : null);

export function adminView({ tab = 'overview', setTab, openReports = 0, onCount } = {}) {
  const wrap = h('div', { class: 'admin' });
  const nav = h('nav', { class: 'admin-tabs', role: 'tablist' });
  const body = h('div', { class: 'admin-body' });
  let timer = null;
  const go = (t) => { clearInterval(timer); tab = t; setTab && setTab(t); draw(); };
  const openUser = (id) => userModal(id, () => draw());
  const draw = () => {
    clear(nav).append(...TABS.map(([k, l, ic]) => h('button', { class: `admin-tab${tab === k ? ' active' : ''}`, role: 'tab', onclick: () => go(k) }, icon(ic), l,
      k === 'reports' && openReports ? h('span', { class: 'badge inline' }, openReports) : null)));
    clear(body).append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
    ({ overview, online, reports, users, servers, security, broadcast, admins, registration, log })[tab]().catch((e) => clear(body).append(h('p', { class: 'form-error' }, e.message)));
  };

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
      h('div', { class: 'charts' }, chart('Messages per day', 'messages', max, ''), chart('New accounts per day', 'signups', maxU, 'alt'), chart('Active people per day', 'active', maxU, 'alt2')));
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

  async function users(q = '') {
    const search = h('input', { class: 'input search-input', placeholder: 'Search by username, name or IP', value: q });
    const listEl = h('div', { class: 'adm-table' });
    const run = async () => {
      const list = await api('GET', `/admin/users?q=${encodeURIComponent(search.value.trim())}`);
      clear(listEl).append(h('div', { class: 'adm-row head' }, h('span', null, 'Person'), h('span', null, 'Last IP'), h('span', null, 'Joined'), h('span', null, 'Last seen'), h('span', null, 'Reports')),
        ...list.map((u) => h('div', { class: 'adm-row' }, userCell(u, openUser), h('span', null, u.lastIp ? ipChip(u.lastIp) : '\u2014'),
          h('span', { class: 'stat-sub' }, fmtStamp(u.createdAt)), h('span', { class: 'stat-sub' }, u.online ? h('span', { class: 'online-dot' }, 'online') : ago(u.lastSeen)),
          h('span', null, u.reportsAgainst ? h('span', { class: 'badge-tag bad' }, u.reportsAgainst) : '0'))));
    };
    let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => run().catch((e) => toast(e.message, 'error')), 250); });
    clear(body).append(h('div', { class: 'admin-head' }, h('h3', null, 'Users')), h('div', { class: 'friends-search' }, icon('search'), search), listEl);
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
          h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
            if (await confirmDialog({ title: `Delete ${x.name}?`, text: 'Every channel, message and file in it is deleted for everyone. This can\u2019t be undone.', confirm: 'Delete server', danger: true })) { await api('DELETE', `/admin/servers/${x.id}`); toast('Server deleted.'); servers(); }
          } }, 'Delete')))));
  }

  async function security() {
    const [sec, bans] = await Promise.all([api('GET', '/admin/security'), api('GET', '/admin/ip-bans')]);
    const ipIn = h('input', { class: 'input mono', placeholder: '203.0.113.7 or 203.0.113.0/24' });
    const label = { failed_login: 'Failed login', captcha_failed: 'Failed robot check', blocked_ip: 'Blocked IP' };
    clear(body).append(
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
    const list = await api('GET', '/admin/admins');
    const name = h('input', { class: 'input', placeholder: 'username' });
    clear(body).append(h('div', { class: 'admin-head' }, h('h3', null, 'Administrators')),
      h('p', { class: 'field-hint' }, 'Admins can see this dashboard: reports, IP addresses, users, and all the controls here. Only give it to people you trust.'),
      h('div', { class: 'adm-table' }, ...list.map((a) => h('div', { class: 'adm-row three' }, userCell(a, openUser),
        h('span', { class: 'stat-sub' }, a.owner ? 'Owner (first account)' : a.fromEnv ? 'Set in .env (ADMIN_USERS)' : 'Added here'),
        a.removable ? h('button', { class: 'btn ghost sm danger-text', onclick: async () => { await api('DELETE', `/admin/admins/${a.id}`); toast('No longer an admin.'); admins(); } }, 'Remove') : h('span')))),
      h('div', { class: 'row gap' }, name, h('button', { class: 'btn primary', onclick: async () => {
        if (!(await confirmDialog({ title: `Make ${name.value} an admin?`, text: 'They\u2019ll be able to see reports, IP addresses and suspend people.', confirm: 'Make admin' }))) return;
        await api('POST', '/admin/admins', { username: name.value }); toast('Added.'); admins();
      } }, 'Add admin')));
  }

  async function log() {
    const list = await api('GET', '/admin/log');
    clear(body).append(h('div', { class: 'admin-head' }, h('h3', null, 'Audit log'), h('span', { class: 'field-hint' }, 'Every admin action, newest first')),
      h('div', { class: 'adm-table' }, ...list.map((l) => h('div', { class: 'adm-row log' },
        h('span', { class: 'stat-sub' }, fmtStamp(l.created_at)), userCell(l.admin), h('strong', null, l.action.replace(/_/g, ' ')),
        h('span', { class: 'stat-sub' }, [l.target, l.detail].filter(Boolean).join(' \u2014 ')), h('span', null, l.ip ? ipChip(l.ip) : '')))));
  }

  wrap.append(nav, body);
  draw();
  wrap._stop = () => clearInterval(timer);
  return wrap;
}

function noteDialog(title, onSave) {
  const note = h('input', { class: 'input', maxlength: '500', placeholder: 'Optional note for other admins' });
  modal({ title, size: 'sm', body: field('Note', note), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: () => onSave(note.value) }] });
}
export function suspendDialog(user, after) {
  const reason = h('input', { class: 'input', maxlength: '300', placeholder: 'Shown to them when they try to log in' });
  modal({
    title: `Suspend ${user.displayName}?`, size: 'sm',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'They\u2019re signed out everywhere immediately and can\u2019t log back in until you unsuspend them. Their messages stay.'), field('Reason', reason)),
    actions: [{ label: 'Cancel' }, { label: 'Suspend', kind: 'danger', action: async () => { await api('POST', `/admin/users/${user.id}/suspend`, { reason: reason.value }); toast(`${user.displayName} is suspended.`); if (after) await after(); } }],
  });
}
async function userModal(id, refresh) {
  const u = await api('GET', `/admin/users/${id}`).catch((e) => { toast(e.message, 'error'); return null; });
  if (!u) return;
  const m = modal({
    title: `${u.displayName} (@${u.username})`, size: 'lg', className: 'admin-user',
    body: h('div', { class: 'stack' },
      h('div', { class: 'row gap wrap' },
        u.online ? h('span', { class: 'badge-tag ok' }, 'Online') : h('span', { class: 'badge-tag' }, `Last seen ${ago(u.lastSeen)}`),
        u.isAdmin ? h('span', { class: 'badge-tag' }, 'Administrator') : null,
        u.suspendedAt ? h('span', { class: 'badge-tag bad' }, `Suspended ${ago(u.suspendedAt)}${u.suspendReason ? `: ${u.suspendReason}` : ''}`) : null,
        h('span', { class: 'stat-sub' }, `Joined ${fmtStamp(u.createdAt)} \u00b7 ${u.servers.length} servers \u00b7 made ${u.reportsBy} reports`)),
      h('h4', null, 'IP addresses'),
      h('div', { class: 'adm-table' }, ...u.ips.map((x) => h('div', { class: 'adm-row three' }, ipChip(x.ip), h('span', { class: 'stat-sub' }, `first ${fmtStamp(x.firstSeen)}`), h('span', { class: 'stat-sub' }, `last ${ago(x.lastSeen)}`)))),
      h('h4', null, `Signed-in devices \u2014 ${u.sessions.length}`),
      h('div', { class: 'adm-table' }, ...u.sessions.map((x) => h('div', { class: 'adm-row three' }, h('span', null, device(x.ua)), x.ip ? ipChip(x.ip) : h('span'), h('span', { class: 'stat-sub' }, `active ${ago(x.lastSeen)}`)))),
      u.reportsAgainst.length ? h('h4', null, `Reports about them \u2014 ${u.reportsAgainst.length}`) : null,
      u.reportsAgainst.length ? h('div', { class: 'adm-table' }, ...u.reportsAgainst.map((r) => h('div', { class: 'adm-row three' }, h('span', null, CATEGORY_LABEL[r.category] || r.category), h('span', { class: 'stat-sub' }, r.status), h('span', { class: 'stat-sub' }, fmtStamp(r.createdAt))))) : null),
    actions: [
      { label: 'Sign out everywhere', action: async () => { await api('POST', `/admin/users/${id}/logout`); toast('Signed out of all devices.'); refresh(); } },
      u.isAdmin ? null : u.suspendedAt
        ? { label: 'Unsuspend', kind: 'primary', action: async () => { await api('POST', `/admin/users/${id}/unsuspend`); toast('Unsuspended.'); refresh(); } }
        : { label: 'Suspend\u2026', kind: 'danger', action: () => { m.close(); suspendDialog(u, refresh); return false; } },
    ].filter(Boolean),
  });
}
