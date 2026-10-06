// Hearth web client.
// Layout: server rail | sidebar (home or server) | conversation | contextual right panel (members, pins, thread).
import { h, $, $$, clear, icon, fmtTime, fmtStamp, fmtDay, fmtSize, toast, playSound, copyText, debounce } from './util.js';
import { api, upload, getToken, setToken } from './api.js';
import * as E2EE from './e2ee.js';
import { render as md, renderDoc, extractImageUrls, isOnlyImageUrl, isJumbo, setResolvers } from './markdown.js';
import { PERMS, PERM_GROUPS, ALL as ALL_PERMS, has, memberRoles, basePerms, topColor } from './perms.js';
import { openCropper } from './cropper.js';
import { adminView, CATEGORY_LABEL } from './admin.js';
import { captchaWidget } from './captcha.js';
import { prepareImage, makeQueue, whenVisible } from './media.js';
import { EMOJI, EMOJI_NAMES, CATEGORY_ICONS, recentEmoji, pushRecentEmoji, searchEmoji } from './emoji.js';
import { Voice } from './voice.js';
import { createSecure } from './secure.js';
import { avatarEl, nameEl, displayName, profileCard, presenceOf, STATUS_LABEL, cropStyle } from './profile-ui.js';
import { modal, popover, closePopover, menu, contextMenu, confirmDialog, field, ibtn } from './ui.js';
import { openSettings, applyAppearance } from './settings.js';
import { loadAppearance, saveAppearance, setServerTheme, BACKGROUNDS } from './appearance.js';

// ======================================================================= state
const S = {
  config: null,
  me: null,
  privateKey: null,
  encPrivateKey: '',
  users: {},
  servers: [],          // includes group DMs (kind: 'group')
  dms: [],
  relationships: {},
  blocked: new Set(),
  voice: {},
  view: { type: 'home' },
  panel: null,          // right panel: 'members' | 'pins' | 'thread' | null
  thread: null,         // { rootId, channelId, serverId }
  msgs: {},             // 'c:<channelId>' | 'd:<dmId>' -> { list, hasMore, hasNewer, loaded }
  threads: {},          // rootId -> { root, list, loaded }
  previews: {},         // conversation key -> decrypted preview text
  unread: new Set(),
  mentions: new Map(),
  typing: {},
  speaking: new Set(),
  sending: false,
};
let socket;
let voice;
const sec = createSecure({ S, onKeysChanged, onKeyWarning });
const fetchingUsers = new Set();

// ---- per-device preferences
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};
const mine = (k) => `hearth.${k}.${S.me.id}`;
const P = {
  get favorites() { return LS.get(mine('favs'), []); },
  set favorites(v) { LS.set(mine('favs'), v); },
  get collapsed() { return LS.get(mine('collapsed'), {}); },
  set collapsed(v) { LS.set(mine('collapsed'), v); },
  get notify() { return LS.get(mine('notify'), {}); },
  set notify(v) { LS.set(mine('notify'), v); },
  get lastRead() { return LS.get(mine('lastRead'), {}); },
  set lastRead(v) { LS.set(mine('lastRead'), v); },
  get inbox() { return LS.get(mine('inbox'), []); },
  set inbox(v) { LS.set(mine('inbox'), v.slice(0, 200)); },
  get saved() { return LS.get(mine('saved'), []); },
  set saved(v) { LS.set(mine('saved'), v.slice(0, 500)); },
  get lastChannel() { return LS.get(mine('lastChannel'), {}); },
  set lastChannel(v) { LS.set(mine('lastChannel'), v); },
  get chat() { return { enterToSend: true, embeds: true, markdown: true, jumbo: true, ...LS.get('hearth.chat', {}) }; },
  get showMembers() { return localStorage.getItem('hearth.members') !== 'off'; },
  set showMembers(v) { localStorage.setItem('hearth.members', v ? 'on' : 'off'); },
};

// expose for settings.js
export const app = {
  S,
  sec,
  P,
  get voice() { return voice; },
  onMe(u) { setUser(u); renderUserPanel(); },
  logout,
  rerender: () => renderAll(),
  install: () => installApp(),
  get canInstall() { return !!installPrompt; },
  get isInstalled() { return isStandalone(); },
  push: {
    supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && S.config && S.config.pushEnabled,
    status: () => pushStatus(),
    enable: () => enablePush(),
    disable: () => disablePush(),
  },
  openServerSettings: (id) => openServerSettings(S.servers.find((s) => s.id === id)),
  unblock: (id) => toggleBlock(id, false),
  openAdmin: () => setView({ type: 'admin', tab: 'overview' }),
};

// ======================================================================= boot
init();

async function init() {
  applyAppearance();
  setupServiceWorker();
  const m = location.pathname.match(/^\/invite\/([A-Za-z0-9]+)/);
  if (m) { sessionStorage.setItem('hearth.pendingInvite', m[1]); history.replaceState(null, '', '/'); }
  try { S.config = await api('GET', '/config'); } catch { S.config = { name: 'Hearth', iceServers: [] }; }
  document.title = S.config.name;
  $$('[data-instance-name]').forEach((el) => { el.textContent = S.config.name; });

  const uid = localStorage.getItem('hearth.userId');
  if (getToken() && uid) {
    const key = await E2EE.loadKey(uid).catch(() => null);
    if (key) { S.privateKey = key; return startApp(); }
  }
  showAuth();
}

// ======================================================================= auth screen
function showAuth() {
  $('#app').hidden = true;
  $('#auth').hidden = false;
  const loginForm = $('#login-form');
  const regForm = $('#register-form');
  const secure = !!(window.crypto && window.crypto.subtle);
  $('#insecure-warning').hidden = secure;
  $('#reg-code-field').hidden = !S.config.registrationRequiresCode;
  if (!S.config.registrationOpen) $('#to-register').parentElement.hidden = true;

  // "I'm not a robot" checks. They start solving as soon as someone starts filling in the form.
  const loginCap = captchaWidget('login');
  const regCap = captchaWidget('register');
  if (!loginForm.querySelector('.captcha')) loginForm.querySelector('.form-error').before(loginCap.el);
  if (!regForm.querySelector('.captcha')) regForm.querySelector('.form-error').before(regCap.el);
  loginForm.addEventListener('focusin', () => loginCap.start());
  regForm.addEventListener('focusin', () => regCap.start());

  $('#to-register').onclick = (e) => { e.preventDefault(); loginForm.hidden = true; regForm.hidden = false; };
  $('#to-login').onclick = (e) => { e.preventDefault(); regForm.hidden = true; loginForm.hidden = false; };

  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = loginForm.querySelector('button[type=submit]');
    const err = loginForm.querySelector('.form-error');
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Unlocking…';
    try {
      const username = loginForm.username.value.trim();
      const password = loginForm.password.value;
      const params = await api('GET', '/auth/params?username=' + encodeURIComponent(username));
      const [{ authKey, wrapKey }, captcha] = await Promise.all([E2EE.deriveKeys(username, password, params), loginCap.token()]);
      const res = await api('POST', '/auth/login', { username, authKey, captcha }).finally(() => loginCap.reset());
      const priv = await E2EE.unwrapPrivateKey(wrapKey, res.encPrivateKey);
      if (params.kdf !== 'argon2id') {
        // Older account: upgrade password hashing from PBKDF2 to Argon2id. Same password, same keys.
        btn.textContent = 'Upgrading your encryption…';
        setToken(res.token);
        const salt = E2EE.newKdfSalt();
        const next = await E2EE.deriveKeys(username, password, { kdf: 'argon2id', salt });
        const encPrivateKey = await E2EE.rewrapPrivateKey(wrapKey, next.wrapKey, res.encPrivateKey);
        await api('POST', '/me/password', { oldAuthKey: authKey, newAuthKey: next.authKey, encPrivateKey, salt, keepSessions: true });
      }
      await finishLogin(res, priv);
    } catch (ex) {
      err.textContent = ex.message;
    } finally { btn.disabled = false; btn.textContent = 'Log in'; }
  };

  regForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = regForm.querySelector('button[type=submit]');
    const err = regForm.querySelector('.form-error');
    err.textContent = '';
    const username = regForm.username.value.trim();
    const pw = regForm.password.value;
    if (pw.length < 8) { err.textContent = 'Use at least 8 characters for your password.'; return; }
    if (pw !== regForm.confirm.value) { err.textContent = 'The passwords do not match.'; return; }
    btn.disabled = true; btn.textContent = 'Creating your keys…';
    try {
      const kdfSalt = E2EE.newKdfSalt();
      const [{ authKey, wrapKey }, captcha] = await Promise.all([E2EE.deriveKeys(username, pw, { kdf: 'argon2id', salt: kdfSalt }), regCap.token()]);
      const id = await E2EE.createIdentity(wrapKey);
      const res = await api('POST', '/auth/register', {
        captcha,
        username, authKey, kdfSalt, publicKey: id.publicKey, encPrivateKey: id.encPrivateKey, code: regForm.code ? regForm.code.value : '',
        acceptTos: regForm.tos && regForm.tos.checked ? S.config.termsVersion || 1 : 0,
      }).finally(() => regCap.reset());
      await finishLogin(res, id.privateKey);
    } catch (ex) {
      err.textContent = ex.message;
    } finally { btn.disabled = false; btn.textContent = 'Create account'; }
  };
}

async function finishLogin(res, privateKey) {
  setToken(res.token);
  localStorage.setItem('hearth.userId', res.user.id);
  await E2EE.storeKey(res.user.id, privateKey);
  S.privateKey = privateKey;
  startApp();
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  if (voice) await voice.leave().catch(() => {});
  setToken('');
  localStorage.removeItem('hearth.userId');
  sec.reset();
  await E2EE.clearKeys();
  location.href = '/';
}

// ======================================================================= realtime
function startApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#app').classList.add('loading');
  socket = io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
  voice = new Voice({
    // Lets the speaking detector ignore people whose mic is off (their state comes from the server).
    isPeerMuted: (userId) => { const st = voice && (S.voice[voice.channelId] || []).find((x) => x.userId === userId); return !!(st && (st.muted || st.deafened)); },
    socket,
    getIceServers: () => S.iceServers || S.config.iceServers || [],
    signSdp: (toUserId, desc) => sec.signSdp(voice.channelId, toUserId, desc),
    verifySdp: (fromUserId, desc, sig) => sec.verifySdp(voice.channelId, fromUserId, desc, sig),
    onSecurityWarning: (userId) => toast(`Blocked a voice connection from ${displayName(getUser(userId))}: its security signature didn't check out.`, 'error'),
    onChange: () => { renderVoicePanel(); renderUserPanel(); renderCallStages(); renderSidebarVoiceUsers(); if (S.view.type === 'channel' || S.view.type === 'dm') renderHeader(); },
    onSpeaking: (id, on) => {
      const uid = id === 'me' ? S.me.id : id;
      // Never show someone as speaking while they're muted or deafened, whatever audio arrives.
      if (on) { const st = (S.voice[voice.channelId] || []).find((x) => x.userId === uid); if (st && (st.muted || st.deafened)) on = false; }
      if (on) S.speaking.add(uid); else S.speaking.delete(uid);
      $$(`[data-speak="${uid}"]`).forEach((el) => el.classList.toggle('speaking', on));
    },
  });

  socket.on('connect', async () => {
    try {
      // Back after a restart: same version → carry on; new version → switch to it.
      if (S.restarting || S.config.version) {
        const cfg = await api('GET', '/config').catch(() => null);
        if (cfg && cfg.version && S.config.version && cfg.version !== S.config.version) return onNewVersion(cfg.version);
      }
      await loadBootstrap();
      hideUpdating();
      $('#app').classList.remove('loading');
      $('#conn-banner').hidden = true;
    } catch (e) {
      if (e.status === 401) return logout();
      toast(e.message, 'error');
    }
  });
  socket.on('connect_error', (e) => {
    if (e.message === 'maintenance') { api('GET', '/config').then((c) => showUpdating('Down for maintenance', c.maintenance || 'Back soon.')).catch(() => {}); return; }
    if (e.message === 'unauthorized') logout();
    else if (!S.restarting) $('#conn-banner').hidden = false;
  });
  socket.on('disconnect', (reason) => {
    if (S.restarting) return; // expected: the server is restarting for an update
    if (reason === 'io server disconnect') return logout(); // session was revoked
    $('#conn-banner').hidden = false;
  });
  socket.on('server:restarting', () => showUpdating());
  socket.on('server:maintenance', ({ text }) => showUpdating('Down for maintenance', text || 'Back soon.'));

  socket.on('user:update', (u) => { if (!S.me) return; setUser(u); sec.trust(u); refreshUserBits(u.id); });
  socket.on('keys:state', (st) => { if (S.me) sec.applyState(st); });
  socket.on('call:ring', (p) => onRing(p));
  socket.on('call:end', ({ room }) => stopRinging(room));
  socket.on('call:declined', ({ room, userId }) => {
    toast(`${displayName(getUser(userId))} declined the call.`);
    // In a 1-to-1 call nobody else is coming, so hang up.
    if (room.startsWith('dm:') && voice.channelId === room && (S.voice[room] || []).length <= 1) { voice.leave(); playSound('selfLeave'); }
  });
  socket.on('admin:report', ({ category }) => {
    S.adminReports = (S.adminReports || 0) + 1;
    renderRail();
    toast(`New report: ${CATEGORY_LABEL[category] || category}. Open Admin → Reports.`);
    playSound('mention');
    if (S.view.type === 'admin' && S.view.tab === 'reports') renderMain();
  });
  socket.on('config:update', (c) => {
    Object.assign(S.config, c);
    if ('announcement' in c) renderAnnouncement();
    if (c.termsVersion) askToAcceptTerms();
    if (composers.main) composers.main.renderExtras();
    if (S.view.type === 'channel' || S.view.type === 'dm') renderMain();
  });
  socket.on('relationship:update', ({ relationship, user }) => {
    if (!S.me) return;
    if (user) setUser(user);
    if (relationship.removed) delete S.relationships[relationship.userId];
    else {
      const prev = S.relationships[relationship.userId];
      S.relationships[relationship.userId] = relationship;
      if (relationship.direction === 'incoming' && !prev) {
        playSound('friend');
        addInbox({ type: 'friend', userId: user.id, title: `${displayName(user)} sent you a friend request`, text: 'Open Friends to accept or ignore it.' });
      }
      if (relationship.direction === 'mutual' && prev && prev.direction === 'outgoing') {
        playSound('friend');
        addInbox({ type: 'friend', userId: user.id, title: `${displayName(user)} accepted your friend request`, text: '' });
      }
    }
    renderRail();
    if (!S.view.serverId) renderSidebar();
    if (['friends', 'home'].includes(S.view.type) && S.view.tab !== 'add') renderMain();
  });
  socket.on('server:add', ({ server, users, voice: vs, keyState }) => {
    if (!S.me) return;
    Object.values(users || {}).forEach(setUser);
    Object.values(users || {}).forEach((u) => sec.trust(u));
    Object.assign(S.voice, vs || {});
    if (!S.servers.find((s) => s.id === server.id)) S.servers.push(server);
    if (keyState) sec.applyState(keyState);
    previewGroup(server);
    renderRail();
    if (!S.view.serverId) renderSidebar();
  });
  socket.on('server:update', (server) => {
    const i = S.servers.findIndex((s) => s.id === server.id);
    if (i >= 0) S.servers[i] = server;
    const w = serverWaiters.get(server.id);
    if (w) { serverWaiters.delete(server.id); setTimeout(w, 0); }
    previewGroup(server);
    renderRail();
    if (S.view.serverId === server.id) {
      applyServerTheme();
      // Lost access to the channel you're in (permissions changed)? Go somewhere you can see.
      if (S.view.channelId && !server.channels.some((c) => c.id === S.view.channelId)) { toast('You no longer have access to that channel.'); return openServer(server.id); }
      renderSidebar(); renderHeader(); renderPanel();
      if (composers.main) composers.main.renderExtras();
    }
    else if (server.kind === 'group' && !S.view.serverId) renderSidebar();
  });
  socket.on('server:remove', ({ serverId }) => {
    const was = S.servers.find((s) => s.id === serverId);
    S.servers = S.servers.filter((s) => s.id !== serverId);
    if (S.view.serverId === serverId) { toast(was && was.kind === 'group' ? 'You left the group.' : 'You are no longer in that server.'); goHome(); }
    else { renderRail(); if (!S.view.serverId) renderSidebar(); }
  });
  socket.on('member:add', ({ serverId, user }) => {
    setUser(user);
    sec.trust(user);
    const s = S.servers.find((x) => x.id === serverId);
    if (s && !s.memberIds.includes(user.id)) s.memberIds.push(user.id);
    if (S.view.serverId === serverId) { renderPanel(); renderHeader(); }
  });
  socket.on('member:remove', ({ serverId, userId }) => {
    const s = S.servers.find((x) => x.id === serverId);
    if (s) s.memberIds = s.memberIds.filter((i) => i !== userId);
    if (S.view.serverId === serverId) { renderPanel(); renderHeader(); }
  });
  socket.on('channel:create', (ch) => {
    const s = S.servers.find((x) => x.id === ch.serverId);
    if (s && !s.channels.find((c) => c.id === ch.id)) s.channels.push(ch);
    if (S.view.serverId === ch.serverId) renderSidebar();
  });
  socket.on('channel:update', (ch) => {
    const s = S.servers.find((x) => x.id === ch.serverId);
    if (!s) return;
    const i = s.channels.findIndex((c) => c.id === ch.id);
    if (i >= 0) s.channels[i] = ch;
    if (S.view.serverId === ch.serverId) { renderSidebar(); renderHeader(); }
  });
  socket.on('channel:delete', ({ id, serverId }) => {
    const s = S.servers.find((x) => x.id === serverId);
    if (s) s.channels = s.channels.filter((c) => c.id !== id);
    delete S.msgs['c:' + id];
    if (S.view.channelId === id) openServer(serverId);
    else if (S.view.serverId === serverId) renderSidebar();
  });

  socket.on('message:new', (m) => { if (!S.me) return; if (m.threadId) onThreadMessage(m); else onNewMessage('c:' + m.channelId, m); });
  socket.on('message:update', (m) => { if (m.threadId) onThreadUpdate(m); else onUpdateMessage('c:' + m.channelId, m); });
  socket.on('message:delete', ({ id, channelId, threadId }) => {
    if (threadId) {
      const t = S.threads[threadId];
      if (t) { t.list = t.list.filter((x) => x.id !== id); if (S.thread && S.thread.rootId === threadId) renderPanel(); }
    } else onDeleteMessage('c:' + channelId, id);
  });
  socket.on('thread:update', ({ rootId, channelId, threadCount, threadLastAt }) => {
    const store = S.msgs['c:' + channelId];
    const m = store && store.list.find((x) => x.id === rootId);
    if (m) { m.threadCount = threadCount || 0; m.threadLastAt = threadLastAt; if (currentKey() === 'c:' + channelId) replaceMessageEl(m); }
  });
  socket.on('reaction:update', (p) => {
    const key = p.channelId ? 'c:' + p.channelId : 'd:' + p.dmId;
    const store = S.msgs[key];
    const m = (store && store.list.find((x) => x.id === p.messageId)) || findThreadMessage(p.messageId);
    if (m) { m.reactions = p.reactions; replaceMessageEl(m); }
  });
  socket.on('pin:update', (p) => {
    const key = p.channelId ? 'c:' + p.channelId : 'd:' + p.dmId;
    const store = S.msgs[key];
    const m = (store && store.list.find((x) => x.id === p.messageId)) || findThreadMessage(p.messageId);
    if (m) { m.pinnedAt = p.pinnedAt; replaceMessageEl(m); }
    if (S.panel === 'pins' && currentKey() === key) renderPanel();
  });
  socket.on('dm:message', async ({ dm, message, user }) => {
    if (!S.me) return;
    if (user) setUser(user);
    const i = S.dms.findIndex((d) => d.id === dm.id);
    if (i >= 0) S.dms.splice(i, 1);
    S.dms.unshift(dm);
    await onNewMessage('d:' + dm.id, message);
    if (!S.view.serverId) renderSidebar();
  });
  socket.on('dm:update', (m) => onUpdateMessage('d:' + m.dmId, m));
  socket.on('dm:delete', ({ id, dmId }) => onDeleteMessage('d:' + dmId, id));
  socket.on('typing', (p) => {
    const key = p.channelId ? 'c:' + p.channelId : 'd:' + p.dmId;
    const t = (S.typing[key] ||= new Map());
    clearTimeout(t.get(p.userId));
    t.set(p.userId, setTimeout(() => { t.delete(p.userId); if (currentKey() === key) renderTyping(); }, 6000));
    if (currentKey() === key) renderTyping();
  });
  socket.on('voice:state', ({ channelId, users }) => {
    if (!S.me) return;
    const before = (S.voice[channelId] || []).map((u) => u.userId);
    if (channelId.startsWith('dm:') && voice.channelId === channelId) {
      const had = (S.voice[channelId] || []).some((u) => u.userId !== S.me.id);
      const has = users.some((u) => u.userId !== S.me.id);
      if (had && !has) { setTimeout(() => { if (voice.channelId === channelId && !(S.voice[channelId] || []).some((u) => u.userId !== S.me.id)) { voice.leave(); playSound('selfLeave'); toast('Call ended.'); } }, 1500); }
    }
    S.voice[channelId] = users;
    users.filter((u) => u.muted || u.deafened).forEach((u) => { if (S.speaking.delete(u.userId)) $$(`[data-speak="${u.userId}"]`).forEach((el) => el.classList.remove('speaking')); });
    if (voice.channelId === channelId) {
      const after = users.map((u) => u.userId);
      if (after.some((id) => !before.includes(id) && id !== S.me.id)) playSound('userJoin');
      if (before.some((id) => !after.includes(id) && id !== S.me.id)) playSound('userLeave');
    }
    renderSidebarVoiceUsers();
    // A call started or ended in the conversation you're looking at: show/hide its call area.
    const here = S.view.type === 'dm' ? dmRoom(S.view.dmId) : S.view.type === 'channel' ? callRoomFor(currentServer()) : S.view.type === 'voice' ? S.view.channelId : null;
    if (here === channelId) {
      const shown = !!$('.chat > .call-stage, .voice-room .call-stage');
      if (shown !== (users.length > 0) && S.view.type !== 'voice') renderMain(); else renderCallStages();
      renderHeader();
    } else renderCallStages();
    if (S.view.serverId) { const s = currentServer(); if (s && s.kind === 'group') renderHeader(); }
  });

  window.addEventListener('focus', () => { markRead(currentKey()); });
  window.addEventListener('pagehide', () => { if (voice && voice.channelId) socket.emit('voice:leave', {}); });
  window.addEventListener('hashchange', () => openLinkFromHash());
  document.addEventListener('keydown', globalKeys);
  document.querySelector('.nav-scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
  $('#sidebar').append(resizeHandle('sidebar'));
}

async function loadBootstrap() {
  const b = await api('GET', '/bootstrap');
  S.me = b.me;
  S.mediaToken = b.mediaToken;
  S.iceServers = b.iceServers;
  S.encPrivateKey = b.encPrivateKey;
  S.users = b.users;
  S.servers = b.servers;
  S.dms = b.dms;
  S.relationships = Object.fromEntries(b.relationships.map((r) => [r.userId, r]));
  S.blocked = new Set(b.blocked || []);
  S.voice = b.voice;
  S.msgs = {};
  S.threads = {};
  await sec.ensureSigningKey(b.encSignPrivateKey);
  Object.values(S.users).forEach((u) => sec.trust(u));
  for (const st of Object.values(b.keyStates || {})) await sec.applyState(st);
  if (S.view.serverId && !S.servers.find((s) => s.id === S.view.serverId)) S.view = { type: 'home' };
  if (S.view.dmId && !S.dms.find((d) => d.id === S.view.dmId)) S.view = { type: 'home' };
  if (!S.view.serverId && !S.view.dmId && S.view.type !== 'friends' && S.view.type !== 'saved') S.view = { type: 'home' };
  renderAll();
  loadPreviews();
  if ((b.termsVersion || 0) > (b.tosAccepted || 0)) askToAcceptTerms();
  restoreResume();
  renderAnnouncement();
  if (S.me.instanceAdmin) api('GET', '/admin/stats').then((st) => { S.adminReports = st.openReports; renderRail(); }).catch(() => {});
  const open = new URLSearchParams(location.search).get('open');
  if (open) { history.replaceState(null, '', '/' + location.hash); if (open === 'messages') openMessages(); if (open === 'friends') goFriends(); }
  if (localStorage.getItem('hearth.push') === 'on') enablePush({ quiet: true }).catch(() => {});
  const invite = sessionStorage.getItem('hearth.pendingInvite');
  if (invite) { sessionStorage.removeItem('hearth.pendingInvite'); openJoinModal(invite); }
  else if (location.hash) openLinkFromHash();
}

function setUser(u) {
  if (!u) return;
  S.users[u.id] = { ...(S.users[u.id] || {}), ...u };
  if (S.me && u.id === S.me.id) S.me = { ...S.me, ...u };
}
function getUser(id) {
  const u = S.users[id];
  if (u) return u;
  if (!fetchingUsers.has(id)) {
    fetchingUsers.add(id);
    api('GET', '/users/' + id).then((x) => { setUser(x); refreshUserBits(id); }).catch(() => {});
  }
  return { id, username: 'unknown', profile: { displayName: 'Unknown user' }, presence: 'offline' };
}
// Swap every rendered avatar/name for this user.
function refreshUserBits(id) {
  const u = S.users[id];
  if (!u || !S.me) return;
  $$(`[data-user-av="${id}"]`).forEach((el) => {
    const fresh = avatarEl(u, +el.dataset.size, { status: el.dataset.status === '1', meId: S.me.id });
    if (el.classList.contains('speaking')) fresh.classList.add('speaking');
    if (el.dataset.speak) fresh.dataset.speak = el.dataset.speak;
    el.replaceWith(fresh);
  });
  $$(`[data-user-name="${id}"]`).forEach((el) => {
    const fresh = nameEl(u, { tag: el.tagName.toLowerCase(), cls: [...el.classList].filter((c) => !c.startsWith('fx-') && c !== 'uname' && c !== 'grad' && !c.startsWith('font-')).join(' ') });
    el.replaceWith(fresh);
  });
  if (id === S.me.id) renderUserPanel();
  if (S.panel === 'members' || S.view.type === 'dm') renderPanel();
  if (['friends', 'home'].includes(S.view.type) && S.view.tab !== 'add') renderMain();
  if (S.view.type === 'voice') renderMain();
}

// ======================================================================= conversation previews (decrypted locally)
async function loadPreviews() {
  for (const d of S.dms) await previewDm(d);
  for (const s of S.servers.filter((x) => x.kind === 'group')) await previewGroup(s);
  if (!S.view.serverId) renderSidebar();
  if (S.view.type === 'home') renderMain();
}
async function previewDm(d) {
  if (!d.last) { S.previews['d:' + d.id] = ''; return; }
  const m = { ...d.last, dmId: d.id };
  await sec.decryptDmMessage(m);
  S.previews['d:' + d.id] = previewText(m);
}
async function previewGroup(s) {
  if (s.kind !== 'group' || !s.last) return;
  const m = { ...s.last, serverId: s.id };
  if (m.ciphertext) await sec.decryptChannelMessage(m); else m.dec = { t: '' };
  S.previews['g:' + s.id] = previewText(m, true);
}
function previewText(m, group = false) {
  if (!m.dec || m.dec.error) return 'Encrypted message';
  if (m.dec.pending) return 'Waiting for key…';
  const who = m.authorId === S.me.id ? 'You: ' : group ? `${displayName(getUser(m.authorId))}: ` : '';
  const t = (m.dec.t || '').replace(/\s+/g, ' ').trim();
  return who + (t || ((m.dec.f || []).length ? 'Sent an attachment' : ''));
}

// ======================================================================= navigation
const currentKey = () => (S.view.type === 'channel' ? 'c:' + S.view.channelId : S.view.type === 'dm' ? 'd:' + S.view.dmId : null);
const currentServer = () => S.servers.find((s) => s.id === S.view.serverId);
const isOwner = (server) => !!server && server.ownerId === S.me.id;
// ---- permissions (the server sends our own, already resolved, per server and per channel)
const myPerms = (server) => (!server ? 0 : server.kind === 'group' ? ALL_PERMS : server.myPerms || 0);
const can = (server, bit) => has(myPerms(server), bit);
const chanPerms = (c) => (!c ? 0 : c.perms ?? ALL_PERMS);
const canIn = (c, bit) => has(chanPerms(c), bit);
const isAdmin = (server) => can(server, PERMS.MANAGE_CHANNELS); // can manage channels & categories
const canManageServer = (server) => !!server && !isGroup(server) && (can(server, PERMS.MANAGE_SERVER) || can(server, PERMS.MANAGE_ROLES) || can(server, PERMS.MANAGE_EMOJIS) || can(server, PERMS.BAN_MEMBERS) || can(server, PERMS.KICK_MEMBERS));
// Name color + badge for a member, from their roles in this server.
function roleStyle(server, userId) {
  if (!server || isGroup(server)) return { color: '', badge: null };
  const roles = memberRoles(server, userId);
  const color = server.theme && server.theme.roleColors === false ? '' : topColor(server, userId);
  const iconRole = roles.find((r) => r.icon);
  return { color, top: roles[0] || null, iconRole, owner: server.ownerId === userId };
}
const allEmojis = () => S.servers.flatMap((s) => (s.emojis || []).map((e) => ({ ...e, serverId: s.id, serverName: s.name })));
const emojiToken = (e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
setResolvers({
  emoji: (id) => allEmojis().find((e) => e.id === id) || null,
  role: (id) => {
    for (const s of S.servers) {
      const r = (s.roleDefs || []).find((x) => x.id === id);
      if (r) return { name: r.name, color: r.color, mine: !!S.me && ((s.memberRoles || {})[S.me.id] || []).includes(id) };
    }
    return null;
  },
});
// Render an emoji string or a custom emoji token (used for reactions).
function emojiNode(str, cls = '') {
  const m = /^<a?:([A-Za-z0-9_]{2,32}):([a-z0-9]{6,40})>$/.exec(str);
  if (!m) return h('span', { class: cls }, str);
  const e = allEmojis().find((x) => x.id === m[2]);
  return e ? h('img', { class: `cemoji ${cls}`, src: e.url, alt: `:${m[1]}:`, title: `:${m[1]}:` }) : h('span', { class: cls }, `:${m[1]}:`);
}
const isGroup = (server) => !!server && server.kind === 'group';
const realServers = () => S.servers.filter((s) => s.kind !== 'group');
const groups = () => S.servers.filter((s) => s.kind === 'group');
const serverOfChannel = (channelId) => S.servers.find((s) => s.channels.some((c) => c.id === channelId));
const channelById = (id) => { for (const s of S.servers) { const c = s.channels.find((x) => x.id === id); if (c) return c; } return null; };
const textChannel = (server) => server.channels.find((c) => c.type === 'text');

function setView(v) {
  S.view = v;
  S.editing = null;
  if (S.panel === 'thread' && (!S.thread || S.thread.channelId !== v.channelId)) { S.panel = null; S.thread = null; }
  if (S.panel === 'pins') S.panel = null;
  if (S.panel === null && P.showMembers && (v.type === 'channel' || v.type === 'dm')) S.panel = 'members';
  document.body.classList.remove('nav-open');
  if (v.type === 'channel') { const lc = P.lastChannel; lc[v.serverId] = v.channelId; P.lastChannel = lc; }
  S.unreadMarker = S.unread.has(currentKey()) ? currentKey() : null;
  renderAll();
  markRead(currentKey());
}
function goHome() { setView({ type: 'home' }); }
function goFriends(tab = 'online') { setView({ type: 'friends', tab }); }
function openDm(dmId) { setView({ type: 'dm', dmId }); }
async function openDmWith(userId) {
  try {
    const d = await api('POST', '/dms', { userId });
    if (!S.dms.find((x) => x.id === d.id)) S.dms.unshift(d);
    openDm(d.id);
  } catch (e) { toast(e.message, 'error'); }
}
function openServer(serverId) {
  const s = S.servers.find((x) => x.id === serverId);
  if (!s) return;
  const last = P.lastChannel[serverId];
  const c = s.channels.find((x) => x.id === last && x.type === 'text') || orderedChannels(s).find((x) => x.type === 'text');
  if (c) openChannel(c.id, s.id); else setView({ type: 'empty-server', serverId });
}
function openChannel(channelId, serverId) { setView({ type: 'channel', channelId, serverId }); }
function openVoiceRoom(channelId, serverId) { setView({ type: 'voice', channelId, serverId }); }
function openGroup(serverId) {
  const s = S.servers.find((x) => x.id === serverId);
  const c = s && textChannel(s);
  if (c) openChannel(c.id, s.id);
}
function openMessages() {
  const recent = conversations()[0];
  if (recent) recent.open(); else goFriends();
}

// ======================================================================= unread + notification levels
// Levels: 'all' | 'mentions' | 'muted'. Channels inherit from their server unless set.
function notifyLevel(key) {
  const p = P.notify;
  if (p[key] && p[key] !== 'default') return p[key];
  if (key.startsWith('c:')) {
    const s = serverOfChannel(key.slice(2));
    if (s && p['s:' + s.id]) return p['s:' + s.id];
  }
  return 'all';
}
function setNotify(key, level) {
  const p = P.notify;
  if (level === 'default') delete p[key]; else p[key] = level;
  P.notify = p;
  renderSidebar(); renderRail(); renderHeader();
}
const isMuted = (key) => notifyLevel(key) === 'muted';
function serverUnread(s) {
  let unread = false;
  let mentions = 0;
  for (const c of s.channels) {
    const k = 'c:' + c.id;
    mentions += S.mentions.get(k) || 0;
    if (S.unread.has(k) && notifyLevel(k) === 'all') unread = true;
  }
  if (P.notify['s:' + s.id] === 'muted') unread = false;
  return { unread, mentions };
}
function markRead(key) {
  if (!key || document.hidden) return;
  S.unread.delete(key);
  S.mentions.delete(key);
  const store = S.msgs[key];
  if (store && store.list.length && !store.hasNewer) {
    const lr = P.lastRead;
    lr[key] = store.list[store.list.length - 1].id;
    P.lastRead = lr;
  }
  updateTitle();
  renderRail();
  renderSidebar();
}
function markUnread(key, msgId) {
  const lr = P.lastRead;
  const store = S.msgs[key];
  const i = store ? store.list.findIndex((m) => m.id === msgId) : -1;
  lr[key] = i > 0 ? store.list[i - 1].id : '0';
  P.lastRead = lr;
  S.unread.add(key);
  updateTitle(); renderRail(); renderSidebar();
  if (currentKey() === key) renderMessages(false);
}
function updateTitle() {
  let n = 0;
  S.mentions.forEach((c) => { n += c; });
  const inbox = P.inbox.filter((x) => !x.read).length;
  document.title = (n ? `(${n}) ` : '') + (S.config.name || 'Hearth');
  if (window.hearthDesktop) window.hearthDesktop.setBadge(n);
  if (navigator.setAppBadge && isStandalone()) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  const b = $('#rail .inbox-badge');
  if (b) { b.textContent = inbox > 99 ? '99+' : inbox; b.hidden = !inbox; }
}

// ======================================================================= notification center (kept on this device)
function addInbox(entry) {
  const list = P.inbox;
  list.unshift({ id: Math.random().toString(36).slice(2), at: Date.now(), read: false, ...entry });
  P.inbox = list;
  updateTitle();
}
function openInbox(anchor) {
  let tab = 'all';
  const body = h('div', { class: 'inbox-list' });
  const tabs = h('div', { class: 'seg' });
  const draw = () => {
    clear(tabs);
    [['all', 'All'], ['mention', 'Mentions'], ['reply', 'Replies'], ['friend', 'Friends']].forEach(([k, l]) => tabs.append(
      h('button', { class: `seg-btn${tab === k ? ' active' : ''}`, onclick: () => { tab = k; draw(); } }, l)));
    clear(body);
    const items = P.inbox.filter((x) => tab === 'all' || x.type === tab);
    if (!items.length) { body.append(h('div', { class: 'panel-empty' }, icon('inbox'), h('p', null, 'You\u2019re all caught up.'))); return; }
    let lastGroup = '';
    for (const it of items) {
      const g = dayGroup(it.at);
      if (g !== lastGroup) { body.append(h('div', { class: 'inbox-day' }, g)); lastGroup = g; }
      const u = it.userId ? getUser(it.userId) : null;
      body.append(h('button', {
        class: `inbox-item${it.read ? '' : ' unread'}`,
        onclick: () => {
          closePopover();
          const list = P.inbox; const x = list.find((y) => y.id === it.id); if (x) x.read = true; P.inbox = list; updateTitle();
          if (it.msgId) jumpToMessageId(it.msgId); else if (it.type === 'friend') goFriends(it.title.includes('accepted') ? 'all' : 'pending');
        },
      }, u ? avatarEl(u, 32) : h('span', { class: 'inbox-ic' }, icon('bell')),
      h('span', { class: 'inbox-text' }, h('strong', null, it.title), it.text ? h('span', { class: 'inbox-snippet' }, it.text) : null,
        h('span', { class: 'inbox-time' }, relTime(it.at)))));
    }
  };
  draw();
  const el = h('div', { class: 'inbox' },
    h('div', { class: 'inbox-head' }, h('h3', null, 'Notifications'),
      h('button', { class: 'link-btn', onclick: () => { P.inbox = P.inbox.map((x) => ({ ...x, read: true })); updateTitle(); draw(); } }, 'Mark all read'),
      ibtn('trash', 'Clear all', () => { P.inbox = []; updateTitle(); draw(); }, { cls: 'sm' })),
    tabs, body);
  popover(anchor, el, { side: anchor.closest('#rail') ? railSide() : 'bottom', className: 'pop-inbox' });
}
function dayGroup(ts) {
  const d = new Date(ts); const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtStamp(ts);
}

// ======================================================================= keyboard
function globalKeys(e) {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); openSearch(); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'm') { e.preventDefault(); toggleMute(); }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'd') { e.preventDefault(); toggleDeafen(); }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); stepChannel(e.key === 'ArrowUp' ? -1 : 1); }
  if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, .popover')) {
    if (S.editing) { S.editing = null; renderMessages(false); }
    else if (composers.main && composers.main.state.replyTo) composers.main.setReply(null);
    else if (S.panel === 'thread') closeThread();
  }
}
// Alt+↑/↓ moves through the channels of the current sidebar.
function stepChannel(dir) {
  const rows = $$('#sidebar-body [data-nav]');
  const i = rows.findIndex((r) => r.classList.contains('active'));
  const next = rows[Math.max(0, Math.min(rows.length - 1, i + dir))];
  if (next) next.click();
}

// ======================================================================= render: shell
function applyServerTheme() {
  const server = currentServer();
  setServerTheme(server && !isGroup(server) ? server.theme : null);
}
function renderAll() {
  applyServerTheme();
  const showPanel = !!panelMode();
  document.body.classList.toggle('panel-open', showPanel);
  renderRail();
  renderSidebar();
  renderMain();
  renderPanel();
  renderUserPanel();
  renderVoicePanel();
  updateTitle();
}
// What the right panel should show for the current view (or null).
function panelMode() {
  if (S.panel === 'thread' && S.thread) return 'thread';
  if (!['channel', 'dm'].includes(S.view.type)) return null;
  return S.panel;
}

// Which way popups from the server bar should open (it can sit left, right or on top).
function railSide() {
  const d = document.documentElement.dataset;
  return d.rail === 'top' ? 'bottom' : d.railSide === 'right' ? 'left' : 'right';
}

// ---- resizable sidebar / side panel (drag the inner edge, double-click to reset, arrow keys too)
function resizeHandle(which) {
  const el = h('div', { class: 'resize-handle', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', 'aria-label': which === 'sidebar' ? 'Resize sidebar' : 'Resize side panel', 'data-tip': 'Drag to resize \u00b7 double-click to reset' });
  const cfg = () => {
    const d = document.documentElement.dataset;
    if (which === 'sidebar') return { key: 'sideW', v: '--side-w', min: 200, max: 420, def: 256, dir: d.sidebarSide === 'right' ? -1 : 1, box: $('#sidebar') };
    const thread = panelMode() === 'thread';
    return { key: thread ? 'threadW' : 'panelW', v: thread ? '--thread-w' : '--members-w', min: thread ? 300 : 220, max: thread ? 680 : 520, def: thread ? 400 : 272, dir: d.panelSide === 'left' ? 1 : -1, box: $('#members') };
  };
  const save = (key, w) => { const a = loadAppearance(); a.layout[key] = Math.round(w); saveAppearance(a); };
  el.addEventListener('pointerdown', (e) => {
    const c = cfg();
    const startX = e.clientX;
    const startW = c.box.getBoundingClientRect().width;
    let w = startW;
    el.setPointerCapture(e.pointerId);
    el.classList.add('active'); document.body.classList.add('resizing');
    const move = (ev) => { w = Math.min(c.max, Math.max(c.min, startW + c.dir * (ev.clientX - startX))); document.documentElement.style.setProperty(c.v, w + 'px'); };
    const up = () => { el.removeEventListener('pointermove', move); el.classList.remove('active'); document.body.classList.remove('resizing'); save(c.key, w); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  });
  el.addEventListener('dblclick', () => { const c = cfg(); save(c.key, c.def); });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const c = cfg();
    const w = c.box.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 16 : -16) * c.dir;
    save(c.key, Math.min(c.max, Math.max(c.min, w)));
  });
  return el;
}

// ---- server rail: rounded tiles, favorites first
function renderRail() {
  const rail = clear($('#rail'));
  if (!S.me) return;
  const dmUnread = S.dms.reduce((n, d) => n + (S.mentions.get('d:' + d.id) || 0), 0) + groups().reduce((n, g) => n + serverUnread(g).mentions, 0);
  const pending = Object.values(S.relationships).filter((r) => r.direction === 'incoming').length;
  const homeActive = !S.view.serverId || isGroup(currentServer());
  const tile = (opts) => h('div', { class: `rail-item${opts.active ? ' active' : ''}${opts.unread ? ' unread' : ''}` },
    h('span', { class: 'pill', 'aria-hidden': 'true' }),
    h('button', {
      class: `rail-btn ${opts.cls || ''}${opts.active ? ' active' : ''}`,
      'aria-label': opts.label, 'data-tip': opts.label, 'data-tip-side': railSide(), 'aria-current': opts.active ? 'page' : null,
      onclick: opts.onclick, oncontextmenu: opts.oncontext, 'data-pop-anchor': opts.anchor ? '' : null,
    }, opts.content, opts.badge ? h('span', { class: 'badge', 'aria-label': `${opts.badge} unread` }, opts.badge > 99 ? '99+' : opts.badge) : null));

  rail.append(
    tile({ label: 'Home', cls: 'home', active: homeActive && S.view.type !== 'dm' && !isGroup(currentServer()), onclick: goHome, content: icon('flame'), badge: pending }),
    tile({ label: 'Direct messages', cls: 'nav', active: S.view.type === 'dm' || isGroup(currentServer()), onclick: openMessages, content: icon('message'), badge: dmUnread }),
    h('div', { class: 'rail-item' }, h('button', {
      class: 'rail-btn nav', 'aria-label': 'Notifications', 'data-tip': 'Notifications', 'data-tip-side': railSide(), 'data-pop-anchor': '',
      onclick: (e) => openInbox(e.currentTarget),
    }, icon('bell'), h('span', { class: 'badge inbox-badge', hidden: true }))),
    ...(S.me.instanceAdmin ? [tile({ label: 'Admin', cls: 'nav', active: S.view.type === 'admin', onclick: () => setView({ type: 'admin', tab: S.adminReports ? 'reports' : 'overview' }), content: icon('shield'), badge: S.adminReports })] : []),
    h('div', { class: 'rail-sep', role: 'separator' }),
  );
  const favs = P.favorites;
  const servers = realServers();
  const ordered = [...servers.filter((s) => favs.includes('s:' + s.id)), ...servers.filter((s) => !favs.includes('s:' + s.id))];
  ordered.forEach((s, i) => {
    if (i > 0 && favs.includes('s:' + ordered[i - 1].id) && !favs.includes('s:' + s.id)) rail.append(h('div', { class: 'rail-sep thin', role: 'separator' }));
    const { unread, mentions } = serverUnread(s);
    rail.append(tile({
      label: s.name + (favs.includes('s:' + s.id) ? ' (favorite)' : ''),
      active: S.view.serverId === s.id, unread,
      onclick: () => openServer(s.id),
      oncontext: (e) => contextMenu(e, serverMenuItems(s)),
      cls: `shape-${(s.theme && s.theme.iconShape) || 'rounded'}`,
      content: s.icon ? h('img', { src: s.icon, alt: '' }) : h('span', { class: 'rail-initials', style: s.theme && s.theme.accent ? { color: s.theme.accent } : null }, s.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3)),
      badge: mentions,
    }));
  });
  rail.append(
    tile({ label: 'Add a server', cls: 'add', onclick: openAddServer, content: icon('plus') }),
  );
  updateTitle();
}

// ---- sidebar
function renderSidebar() {
  const head = clear($('#sidebar-head'));
  head.classList.remove('has-banner');
  const body = clear($('#sidebar-body'));
  if (!S.me) return;
  const server = currentServer();
  if (server && !isGroup(server)) return renderServerSidebar(server, head, body);
  // Home / messages sidebar
  head.append(h('button', { class: 'find-btn', onclick: () => openSearch(), 'aria-label': 'Search (Ctrl+K)' }, icon('search'), h('span', null, 'Search or jump to\u2026'), h('kbd', null, 'Ctrl K')));
  const pending = Object.values(S.relationships).filter((r) => r.direction === 'incoming').length;
  const nav = (label, ic, active, onclick, badge) => h('button', { class: `nav-row${active ? ' active' : ''}`, 'data-nav': '', onclick }, icon(ic), h('span', null, label), badge ? h('span', { class: 'badge inline' }, badge) : null);
  body.append(
    nav('Home', 'home', S.view.type === 'home', goHome),
    nav('Friends', 'people', S.view.type === 'friends', () => goFriends(pending ? 'pending' : 'online'), pending),
    nav('Saved messages', 'bookmark', S.view.type === 'saved', () => setView({ type: 'saved' })),
  );
  const convs = conversations();
  const favs = P.favorites;
  const pinned = convs.filter((c) => favs.includes(c.fav));
  if (pinned.length) {
    body.append(h('div', { class: 'group-label' }, h('span', null, 'Pinned')));
    pinned.forEach((c) => body.append(convRow(c)));
  }
  body.append(h('div', { class: 'group-label' }, h('span', null, 'Direct messages'),
    ibtn('plus', 'New message or group', () => openNewConversation(), { cls: 'sm' })));
  const rest = convs.filter((c) => !favs.includes(c.fav));
  if (!rest.length && !pinned.length) body.append(h('p', { class: 'sidebar-empty' }, 'No conversations yet. Start one with a friend or someone from a server.'));
  rest.forEach((c) => body.append(convRow(c)));
}

// DMs and group DMs, newest first.
function conversations() {
  const out = S.dms.map((d) => {
    const u = getUser(d.userId);
    return {
      key: 'd:' + d.id, fav: 'd:' + d.id, at: d.lastMessageAt, active: S.view.dmId === d.id,
      title: displayName(u), avatar: avatarEl(u, 34, { status: true, meId: S.me.id }), preview: S.previews['d:' + d.id],
      unreadKey: 'd:' + d.id, open: () => openDm(d.id), menu: dmMenuItems(d), userId: u.id,
    };
  });
  for (const g of groups()) {
    const c = textChannel(g);
    out.push({
      key: 'g:' + g.id, fav: 'g:' + g.id, at: g.lastMessageAt || 0, active: S.view.serverId === g.id,
      title: groupName(g), avatar: groupAvatar(g, 34), preview: S.previews['g:' + g.id] || `${g.memberIds.length} members`,
      unreadKey: c ? 'c:' + c.id : '', open: () => openGroup(g.id), menu: groupMenuItems(g),
    });
  }
  return out.filter((c) => !c.userId || !S.blocked.has(c.userId) || c.active).sort((a, b) => (b.at || 0) - (a.at || 0));
}
function groupName(g) {
  if (g.name) return g.name;
  const others = g.memberIds.filter((id) => id !== S.me.id).map((id) => displayName(getUser(id)));
  return others.length ? others.slice(0, 3).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : '') : 'Just you';
}
function groupAvatar(g, size) {
  const others = g.memberIds.filter((id) => id !== S.me.id).slice(0, 2);
  return h('span', { class: 'group-av', style: { '--size': size + 'px' } }, others.map((id) => avatarEl(getUser(id), Math.round(size * 0.68))));
}
function convRow(c) {
  const unread = c.unreadKey && S.unread.has(c.unreadKey) && !isMuted(c.unreadKey);
  const mentions = c.unreadKey ? S.mentions.get(c.unreadKey) || 0 : 0;
  return h('button', {
    class: `dm-row${c.active ? ' active' : ''}${unread || mentions ? ' unread' : ''}${c.unreadKey && isMuted(c.unreadKey) ? ' muted' : ''}`,
    'data-nav': '', onclick: c.open, oncontextmenu: (e) => contextMenu(e, c.menu),
  }, c.avatar,
  h('span', { class: 'dm-row-text' },
    h('span', { class: 'dm-row-top' }, h('span', { class: 'dm-row-name' }, c.title), c.at ? h('span', { class: 'dm-row-time' }, shortTime(c.at)) : null),
    h('span', { class: 'dm-row-status' }, c.preview || '\u00a0')),
  mentions ? h('span', { class: 'badge', 'aria-label': `${mentions} unread` }, mentions) : unread ? h('span', { class: 'unread-dot', 'aria-label': 'Unread' }) : null);
}
function shortTime(ts) {
  const d = new Date(ts); const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ts);
  if (now - d < 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function toggleFavorite(id) {
  const f = P.favorites;
  P.favorites = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
  renderRail(); renderSidebar();
}
function dmMenuItems(d) {
  const u = getUser(d.userId);
  const fav = P.favorites.includes('d:' + d.id);
  return [
    { label: fav ? 'Unpin conversation' : 'Pin conversation', icon: 'pin', action: () => toggleFavorite('d:' + d.id) },
    { label: 'Mark as read', icon: 'check', action: () => { S.unread.delete('d:' + d.id); S.mentions.delete('d:' + d.id); renderSidebar(); renderRail(); updateTitle(); } },
    notifyItem('d:' + d.id),
    '-',
    { label: 'View profile', icon: 'user', action: () => openProfileModal(u.id) },
    { label: 'Verify encryption', icon: 'shield', action: () => openSafetyNumber(u) },
  ];
}
function groupMenuItems(g) {
  const c = textChannel(g);
  const fav = P.favorites.includes('g:' + g.id);
  return [
    { label: fav ? 'Unpin conversation' : 'Pin conversation', icon: 'pin', action: () => toggleFavorite('g:' + g.id) },
    c ? notifyItem('c:' + c.id) : null,
    { label: 'Rename group', icon: 'edit', action: () => renameGroup(g) },
    { label: 'Add people', icon: 'userPlus', action: () => openNewConversation(g) },
    '-',
    { label: 'Leave group', icon: 'logout', danger: true, action: () => leaveServer(g) },
  ];
}
function notifyItem(key) {
  const muted = isMuted(key);
  return { label: muted ? 'Unmute' : 'Mute', icon: muted ? 'bell' : 'bellOff', action: () => setNotify(key, muted ? 'default' : 'muted') };
}

// ---- server sidebar with categories
function orderedCategories(server) {
  const seen = [];
  const byPos = [...server.channels].sort((a, b) => a.position - b.position);
  byPos.forEach((c) => { const cat = c.category || (c.type === 'voice' ? 'Voice' : 'Text'); if (!seen.includes(cat)) seen.push(cat); });
  const order = (server.categoryOrder || []).filter((c) => seen.includes(c));
  return [...order, ...seen.filter((c) => !order.includes(c))];
}
function orderedChannels(server) {
  const out = [];
  for (const cat of orderedCategories(server)) {
    out.push(...server.channels.filter((c) => (c.category || (c.type === 'voice' ? 'Voice' : 'Text')) === cat).sort((a, b) => a.position - b.position));
  }
  return out;
}
function channelIcon(c) {
  if (c.type === 'voice') return 'speaker';
  if (/announce|news|updates/i.test(c.name)) return 'megaphone';
  if (/rules|info|welcome|faq|readme/i.test(c.name)) return 'book';
  return 'hash';
}

function renderServerSidebar(server, head, body) {
  const th = server.theme || {};
  head.classList.toggle('has-banner', !!th.banner);
  if (th.banner) head.append(h('div', { class: 'server-banner' }, h('img', { class: 'cropped', src: th.banner, alt: '', style: cropStyle(th.bannerCrop) })));
  head.append(h('button', { class: 'server-head', 'data-pop-anchor': '', 'aria-haspopup': 'menu', onclick: (e) => menu(e.currentTarget, serverMenuItems(server), { align: 'start' }) },
    h('span', { class: 'server-head-name' }, server.name), icon('chevron')));
  const admin = isAdmin(server);
  const collapsed = P.collapsed[server.id] || [];
  const cats = orderedCategories(server);
  cats.forEach((cat, ci) => {
    const chans = server.channels.filter((c) => (c.category || (c.type === 'voice' ? 'Voice' : 'Text')) === cat).sort((a, b) => a.position - b.position);
    const isCollapsed = collapsed.includes(cat);
    const catUnread = isCollapsed && chans.some((c) => S.unread.has('c:' + c.id) && !isMuted('c:' + c.id));
    body.append(h('div', { class: 'cat-head' },
      h('button', {
        class: `cat-toggle${catUnread ? ' unread' : ''}`, 'aria-expanded': String(!isCollapsed),
        onclick: () => {
          const all = P.collapsed; const list = all[server.id] || [];
          all[server.id] = isCollapsed ? list.filter((x) => x !== cat) : [...list, cat];
          P.collapsed = all; renderSidebar();
        },
        oncontextmenu: admin ? (e) => contextMenu(e, categoryMenuItems(server, cat, ci, cats)) : null,
      }, icon('chevron', `ic cat-chev${isCollapsed ? ' closed' : ''}`), h('span', null, cat)),
      admin ? ibtn('plus', `Create channel in ${cat}`, () => openCreateChannel(server, chans[0] ? chans[0].type : 'text', cat), { cls: 'sm' }) : null));
    for (const c of chans) {
      const active = S.view.channelId === c.id;
      const k = 'c:' + c.id;
      // Collapsed categories still show the channel you're in, plus ones with mentions.
      if (isCollapsed && !active && !S.mentions.get(k) && !(voice && voice.channelId === c.id)) continue;
      body.append(channelRow(c, server));
      if (c.type === 'voice') body.append(h('div', { class: 'vc-users', 'data-vc-users': c.id }));
    }
  });
  if (!server.channels.length) body.append(h('p', { class: 'sidebar-empty' }, admin ? 'No channels yet. Use the server menu to create one.' : 'No channels yet.'));
  renderSidebarVoiceUsers();
}
function channelRow(c, server) {
  const k = 'c:' + c.id;
  const active = S.view.channelId === c.id;
  const muted = isMuted(k);
  const unread = c.type === 'text' && S.unread.has(k) && notifyLevel(k) === 'all';
  const mentions = S.mentions.get(k) || 0;
  const connected = voice && voice.channelId === c.id;
  return h('div', {
    class: `ch-row${active ? ' active' : ''}${unread ? ' unread' : ''}${muted ? ' muted' : ''}${connected ? ' connected' : ''}`,
    dataset: { cid: c.id },
    oncontextmenu: (e) => contextMenu(e, channelMenuItems(c, server)),
  },
  h('button', {
    class: 'ch-main', 'data-nav': '', 'aria-current': active ? 'page' : null,
    'aria-label': `${c.type === 'voice' ? 'Voice channel' : 'Channel'} ${c.name}${mentions ? `, ${mentions} mentions` : unread ? ', unread' : ''}${muted ? ', muted' : ''}`,
    onclick: () => (c.type === 'voice' ? (connected ? openVoiceRoom(c.id, server.id) : joinVoice(c, server)) : openChannel(c.id, server.id)),
  }, icon(mentions ? 'at' : channelIcon(c), 'ic ch-ic'), h('span', { class: 'ch-name' }, c.name),
  muted ? icon('bellOff', 'ic ch-muted') : null,
  mentions ? h('span', { class: 'badge' }, mentions) : null),
  isAdmin(server) ? ibtn('gear', 'Edit channel', () => openEditChannel(c), { cls: 'sm ch-gear' }) : null);
}
function channelMenuItems(c, server) {
  const k = 'c:' + c.id;
  const admin = isAdmin(server);
  const roles = can(server, PERMS.MANAGE_ROLES);
  const lvl = P.notify[k] || 'default';
  return [
    c.type === 'text' ? { label: 'Mark as read', icon: 'check', action: () => { S.unread.delete(k); S.mentions.delete(k); renderSidebar(); renderRail(); updateTitle(); } } : null,
    c.type === 'text' ? { header: 'Notifications' } : null,
    ...(c.type === 'text' ? [['default', 'Use server default'], ['all', 'All messages'], ['mentions', 'Only @mentions'], ['muted', 'Muted']].map(([v, l]) => ({ label: l, checked: lvl === v, action: () => setNotify(k, v) })) : []),
    '-',
    { label: 'Copy channel link', icon: 'link', action: () => { copyText(`${location.origin}/#c/${c.id}`); toast('Link copied.'); } },
    admin ? { label: 'Edit channel', icon: 'edit', action: () => openEditChannel(c) } : null,
    roles ? { label: 'Permissions', icon: 'shield', action: () => openEditChannel(c, 'perms') } : null,
    roles && c.type === 'text' ? { label: 'Make read-only (announcements)', icon: 'megaphone', action: () => quickOverride(server, c, 'readonly') } : null,
    roles ? { label: 'Make private', icon: 'lock', action: () => quickOverride(server, c, 'private') } : null,
    admin ? { label: 'Move up', icon: 'arrowUp', action: () => moveChannel(server, c, -1) } : null,
    admin ? { label: 'Move down', icon: 'arrowDown', action: () => moveChannel(server, c, 1) } : null,
    admin ? { label: 'Delete channel', icon: 'trash', danger: true, action: () => deleteChannel(c) } : null,
  ];
}
// One-click channel setups: read-only for @everyone, or hidden from @everyone (then pick who can see it).
async function quickOverride(server, c, kind) {
  const list = (c.overrides || []).filter((o) => !(o.type === 'role' && o.id === server.id));
  const everyone = (c.overrides || []).find((o) => o.type === 'role' && o.id === server.id) || { type: 'role', id: server.id, allow: 0, deny: 0 };
  if (kind === 'readonly') everyone.deny |= PERMS.SEND_MESSAGES | PERMS.CREATE_THREADS;
  else everyone.deny |= PERMS.VIEW_CHANNEL;
  try {
    await api('PUT', `/channels/${c.id}/overrides`, { overrides: [...list, { ...everyone, allow: everyone.allow & ~everyone.deny }] });
    toast(kind === 'readonly' ? `#${c.name} is now read-only. Give roles "Send messages" in its permissions to let them post.` : `#${c.name} is now private. Add roles or people who should see it.`);
    if (kind === 'private') openEditChannel({ ...c, overrides: [...list, everyone] }, 'perms');
  } catch (e) { toast(e.message, 'error'); }
}

function categoryMenuItems(server, cat, i, cats) {
  return [
    { label: 'Create channel here', icon: 'plus', action: () => openCreateChannel(server, 'text', cat) },
    { label: 'Rename category', icon: 'edit', action: () => renameCategory(server, cat) },
    i > 0 ? { label: 'Move up', icon: 'arrowUp', action: () => moveCategory(server, cats, i, -1) } : null,
    i < cats.length - 1 ? { label: 'Move down', icon: 'arrowDown', action: () => moveCategory(server, cats, i, 1) } : null,
  ];
}
async function moveCategory(server, cats, i, dir) {
  const order = [...cats];
  [order[i], order[i + dir]] = [order[i + dir], order[i]];
  try { await api('PATCH', `/servers/${server.id}`, { categoryOrder: order }); } catch (e) { toast(e.message, 'error'); }
}
async function moveChannel(server, c, dir) {
  const cat = c.category;
  const list = server.channels.filter((x) => x.category === cat).sort((a, b) => a.position - b.position);
  const i = list.findIndex((x) => x.id === c.id);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const others = orderedChannels(server).filter((x) => x.category !== cat);
  try { await api('POST', `/servers/${server.id}/channel-order`, { ids: [...list, ...others].map((x) => x.id) }); } catch (e) { toast(e.message, 'error'); }
}
function renameCategory(server, cat) {
  const input = h('input', { class: 'input', value: cat, maxlength: '32' });
  modal({
    title: 'Rename category', size: 'sm', body: field('Category name', input),
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: async () => { await api('POST', `/servers/${server.id}/categories/rename`, { from: cat, to: input.value.trim() }); } }],
  });
}

function renderSidebarVoiceUsers() {
  $$('[data-vc-users]').forEach((el) => {
    clear(el);
    const list = S.voice[el.dataset.vcUsers] || [];
    for (const st of list) {
      const u = getUser(st.userId);
      const av = avatarEl(u, 22);
      av.dataset.speak = u.id;
      if (S.speaking.has(u.id)) av.classList.add('speaking');
      el.append(h('button', { class: 'vc-user', 'data-pop-anchor': '', onclick: (e) => openProfilePop(e.currentTarget, u.id, 'right') },
        av, nameEl(u),
        h('span', { class: 'vc-flags' }, st.deafened ? icon('headphonesOff', 'ic flag') : st.muted ? icon('micOff', 'ic flag') : null)));
    }
  });
  $$('.ch-row').forEach((r) => r.classList.toggle('connected', !!voice && r.dataset.cid === voice.channelId));
}

// ======================================================================= user + call panels
function renderUserPanel() {
  const el = clear($('#user-panel'));
  if (!S.me) return;
  const p = S.me.profile || {};
  const sub = p.customStatus && (p.customStatus.text || p.customStatus.emoji)
    ? `${p.customStatus.emoji || ''} ${p.customStatus.text || ''}`.trim()
    : STATUS_LABEL[S.me.status] || 'Online';
  const av = avatarEl(S.me, 34, { status: true, meId: S.me.id });
  av.dataset.speak = S.me.id;
  const inCall = voice && voice.channelId;
  el.append(
    h('button', { class: 'me-btn', 'data-pop-anchor': '', 'aria-label': 'Your status and profile', onclick: (e) => statusMenu(e.currentTarget) },
      av, h('span', { class: 'me-text' }, nameEl(S.me), h('span', { class: 'me-sub' }, sub))),
    h('div', { class: 'me-actions' },
      inCall ? ibtn(voice.muted ? 'micOff' : 'mic', voice.muted ? 'Unmute (Ctrl+Shift+M)' : 'Mute (Ctrl+Shift+M)', toggleMute, { cls: voice.muted ? 'off' : '', active: voice.muted }) : null,
      inCall ? ibtn(voice.deafened ? 'headphonesOff' : 'headphones', voice.deafened ? 'Undeafen' : 'Deafen (Ctrl+Shift+D)', toggleDeafen, { cls: voice.deafened ? 'off' : '', active: voice.deafened }) : null,
      ibtn('gear', 'Settings', () => openSettings(app))),
  );
}
function toggleMute() { if (!voice || !voice.channelId) return; if (voice.speakLocked && voice.muted) { toast('You can listen here, but your roles don\u2019t allow speaking in this channel.'); return; } voice.setMuted(!voice.muted); playSound(voice.muted ? 'mute' : 'unmute'); renderUserPanel(); }
function toggleDeafen() { if (!voice || !voice.channelId) return; voice.setDeafened(!voice.deafened); playSound(voice.deafened ? 'deafen' : 'undeafen'); renderUserPanel(); }

// Compact call bar docked above your profile while you're in voice.
function renderVoicePanel() {
  const el = clear($('#voice-panel'));
  if (!voice || !voice.channelId) { el.hidden = true; return; }
  el.hidden = false;
  const room = voice.channelId;
  const q = voice.connectionQuality();
  const others = (S.voice[room] || []).filter((x) => x.userId !== S.me.id).length;
  const label = q === 'failed' ? 'Connection trouble' : q === 'connecting' ? 'Connecting\u2026' : room.startsWith('dm:') && !others ? 'Calling\u2026' : 'In call';
  const ch = !room.startsWith('dm:') && channelById(room);
  const srv = ch && serverOfChannel(ch.id);
  const where = room.startsWith('dm:') ? `Call with ${roomTitle(room)}` : srv ? (isGroup(srv) ? groupName(srv) : `${ch.name} \u00b7 ${srv.name}`) : '';
  const go = () => { if (room.startsWith('dm:')) openDm(room.slice(3)); else if (isGroup(srv)) openGroup(srv.id); else if (ch) openVoiceRoom(ch.id, srv.id); };
  el.append(
    h('div', { class: 'vp-top' },
      h('div', { class: 'vp-info' }, h('div', { class: `vp-status q-${q}` }, label), h('button', { class: 'vp-where', onclick: go }, where))),
    h('div', { class: 'vp-controls' },
      ibtn(voice.muted ? 'micOff' : 'mic', voice.muted ? 'Unmute' : 'Mute', toggleMute, { cls: voice.muted ? 'off' : '' }),
      ibtn(voice.camStream ? 'video' : 'videoOff', voice.camStream ? 'Turn camera off' : 'Turn camera on', toggleCamera, { cls: voice.camStream ? 'on' : '' }),
      ibtn('monitor', voice.screenStream ? 'Stop sharing' : 'Share your screen', toggleScreen, { cls: voice.screenStream ? 'on' : '' }),
      ibtn('phoneOff', 'Leave call', () => { voice.leave(); playSound('selfLeave'); }, { cls: 'hang' })),
  );
}

async function joinVoice(c, server, { stay = false } = {}) {
  try {
    await voice.join(c.id);
    playSound('selfJoin');
    if (!stay) openVoiceRoom(c.id, server.id);
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Allow microphone access in your browser to join voice.' : e.message, 'error');
  }
}

function statusMenu(anchor) {
  const opts = ['online', 'idle', 'dnd', 'invisible'];
  const desc = { idle: 'Shown as away', dnd: 'Silences notifications', invisible: 'Appear offline, keep full access' };
  const el = h('div', { class: 'menu status-menu' },
    opts.map((s) => h('button', {
      class: `menu-item${S.me.status === s ? ' current' : ''}`,
      onclick: async () => {
        closePopover();
        try { await api('PATCH', '/me/status', { status: s }); S.me.status = s; S.users[S.me.id].status = s; renderUserPanel(); } catch (e) { toast(e.message, 'error'); }
      },
    }, h('span', { class: `status-dot inline st-${s}` }), h('span', { class: 'menu-col' }, s === 'idle' ? 'Away' : STATUS_LABEL[s], desc[s] ? h('span', { class: 'menu-desc' }, desc[s]) : null))),
    h('div', { class: 'menu-sep' }),
    h('button', { class: 'menu-item', onclick: () => { closePopover(); openCustomStatus(); } }, icon('smile', 'ic menu-ic'), 'Set a custom status'),
    h('button', { class: 'menu-item', onclick: () => { closePopover(); openProfileModal(S.me.id); } }, icon('user', 'ic menu-ic'), 'View my profile'),
    h('button', { class: 'menu-item', onclick: () => { closePopover(); openSettings(app, 'profile'); } }, icon('edit', 'ic menu-ic'), 'Edit profile'),
    h('button', { class: 'menu-item', onclick: () => { closePopover(); openSettings(app, 'appearance'); } }, icon('palette', 'ic menu-ic'), 'Theme and appearance'),
  );
  popover(anchor, el, { side: 'top' });
}
function openCustomStatus() {
  const cs = (S.me.profile && S.me.profile.customStatus) || {};
  const emoji = h('input', { class: 'input emoji-input', maxlength: '16', value: cs.emoji || '', placeholder: '😊', 'aria-label': 'Status emoji' });
  const text = h('input', { class: 'input', maxlength: '128', value: cs.text || '', placeholder: "What's happening?", 'aria-label': 'Status text' });
  const pickBtn = ibtn('smile', 'Pick emoji', (e) => emojiPicker(e.currentTarget, (em) => { emoji.value = em; }), { attrs: { type: 'button', 'data-pop-anchor': '' } });
  modal({
    title: 'Set a custom status', size: 'sm',
    body: h('div', { class: 'stack' }, h('div', { class: 'row gap' }, pickBtn, emoji, text)),
    actions: [
      { label: 'Clear', action: () => saveCustomStatus('', '') },
      { label: 'Save', kind: 'primary', action: () => saveCustomStatus(emoji.value.trim(), text.value.trim()) },
    ],
  });
}
async function saveCustomStatus(emoji, text) {
  const u = await api('PATCH', '/me/profile', { customStatus: { emoji, text } });
  setUser(u);
  renderUserPanel();
}

// ======================================================================= main column
function renderMain() {
  if (S.adminEl && S.adminEl._stop) S.adminEl._stop();
  S.adminEl = null;
  const main = clear($('#main'));
  if (!S.me) return;
  main.append(h('header', { id: 'main-head' }));
  renderHeader();
  const v = S.view;
  if (v.type === 'home') main.append(homeView());
  else if (v.type === 'friends') main.append(friendsView());
  else if (v.type === 'saved') main.append(savedView());
  else if (v.type === 'admin' && S.me.instanceAdmin) main.append(S.adminEl = adminView({ tab: v.tab, setTab: (t) => { S.view.tab = t; }, openReports: S.adminReports, onCount: (n) => { if (S.adminReports !== n) { S.adminReports = n; renderRail(); } } }));
  else if (v.type === 'channel' || v.type === 'dm') main.append(chatView());
  else if (v.type === 'voice') main.append(voiceRoomView());
  else if (v.type === 'empty-server') {
    main.append(h('div', { class: 'empty-state' }, h('h3', null, 'No text channels yet'),
      h('p', null, isAdmin(currentServer()) ? 'Create one from the server menu.' : 'Ask an admin to create one.')));
  }
}
const navToggle = () => ibtn('menu', 'Open navigation', () => document.body.classList.toggle('nav-open'), { cls: 'nav-toggle' });
function headTools(...items) { return h('div', { class: 'head-tools', role: 'toolbar', 'aria-label': 'Conversation tools' }, items.filter(Boolean)); }
function togglePanel(mode) {
  S.panel = S.panel === mode ? null : mode;
  if (mode === 'members') P.showMembers = S.panel === 'members';
  if (S.panel !== 'thread') S.thread = null;
  document.body.classList.toggle('panel-open', !!panelMode());
  renderPanel(); renderHeader();
}

function renderHeader() {
  const head = $('#main-head');
  if (!head || !S.me) return;
  clear(head);
  head.append(navToggle());
  const v = S.view;
  const key = currentKey();
  const server = currentServer();
  if (v.type === 'channel' && server && !isGroup(server)) {
    const c = server.channels.find((x) => x.id === v.channelId);
    if (!c) return;
    head.append(
      h('div', { class: 'head-title' }, icon(channelIcon(c), 'ic head-ic'), h('h1', null, c.name),
        c.topic ? h('span', { class: 'head-topic', title: c.topic }, c.topic) : null),
      headTools(
        encBadge(() => openServerSecurity(server)),
        ibtn('search', 'Search this channel (Ctrl+K)', () => openSearch({ scope: key })),
        ibtn('pin', 'Pinned messages', () => togglePanel('pins'), { active: S.panel === 'pins' }),
        ibtn(isMuted(key) ? 'bellOff' : 'bell', 'Notification settings', (e) => menu(e.currentTarget, notifyMenu(key), { align: 'end' }), { attrs: { 'data-pop-anchor': '' } }),
        ibtn('people', S.panel === 'members' ? 'Hide members' : 'Show members', () => togglePanel('members'), { active: S.panel === 'members' }),
        ibtn('more', 'More', (e) => menu(e.currentTarget, channelMenuItems(c, server), { align: 'end' }), { attrs: { 'data-pop-anchor': '' } })));
  } else if (v.type === 'channel' && isGroup(server)) {
    const call = server.channels.find((c) => c.type === 'voice');
    const inCall = voice && call && voice.channelId === call.id;
    const callers = call ? (S.voice[call.id] || []).length : 0;
    head.append(
      h('div', { class: 'head-title' }, groupAvatar(server, 26), h('h1', null, groupName(server)),
        h('span', { class: 'head-topic' }, `${server.memberIds.length} members`)),
      headTools(
        encBadge(() => openServerSecurity(server)),
        call && !inCall ? ibtn('video', 'Start a video call', () => joinRoom(call.id, { video: true })) : null,
        call ? h('button', { class: `btn sm ${inCall ? 'danger' : callers ? 'primary' : 'ghost'}`, onclick: () => (inCall ? voice.leave() : joinRoom(call.id)) },
          icon(inCall ? 'phoneOff' : 'phone'), inCall ? 'Leave call' : callers ? `Join call (${callers})` : 'Call') : null,
        ibtn('search', 'Search (Ctrl+K)', () => openSearch({ scope: key })),
        ibtn('pin', 'Pinned messages', () => togglePanel('pins'), { active: S.panel === 'pins' }),
        ibtn('people', 'Members', () => togglePanel('members'), { active: S.panel === 'members' }),
        ibtn('more', 'More', (e) => menu(e.currentTarget, groupMenuItems(server), { align: 'end' }), { attrs: { 'data-pop-anchor': '' } })));
  } else if (v.type === 'dm') {
    const d = S.dms.find((x) => x.id === v.dmId);
    if (!d) return;
    const u = getUser(d.userId);
    const p = presenceOf(u, S.me.id);
    head.append(
      h('div', { class: 'head-title' }, avatarEl(u, 26, { status: true, meId: S.me.id }), h('h1', null, displayName(u)),
        h('span', { class: 'head-topic' }, STATUS_LABEL[p] || '')),
      headTools(
        sec.keyChanged(u)
          ? h('button', { class: 'head-badge warn', 'data-tip': 'This person\u2019s security key changed. Click to verify.', onclick: () => openSafetyNumber(u) }, icon('shield'), 'Key changed')
          : encBadge(() => openSafetyNumber(u), 'Compare safety numbers'),
        ...(() => {
          const room = dmRoom(d.id);
          const inCall = voice && voice.channelId === room;
          const live = (S.voice[room] || []).length;
          if (S.blocked.has(u.id)) return [];
          if (inCall) return [h('button', { class: 'btn sm danger', onclick: () => { voice.leave(); playSound('selfLeave'); } }, icon('phoneOff'), 'Leave call')];
          return [ibtn('phone', live ? 'Join the call' : 'Start a voice call', () => startDmCall(d.id)), ibtn('video', live ? 'Join with video' : 'Start a video call', () => startDmCall(d.id, true))];
        })(),
        ibtn('search', 'Search (Ctrl+K)', () => openSearch({ scope: key })),
        ibtn('pin', 'Pinned messages', () => togglePanel('pins'), { active: S.panel === 'pins' }),
        ibtn('user', S.panel === 'members' ? 'Hide profile' : 'Show profile', () => togglePanel('members'), { active: S.panel === 'members' }),
        ibtn('more', 'More', (e) => menu(e.currentTarget, [...dmMenuItems(d), '-', blockItem(u)], { align: 'end' }), { attrs: { 'data-pop-anchor': '' } })));
  } else if (v.type === 'voice' && server) {
    const c = server.channels.find((x) => x.id === v.channelId);
    head.append(h('div', { class: 'head-title' }, icon('speaker', 'ic head-ic'), h('h1', null, c ? c.name : 'Voice')),
      headTools(h('span', { class: 'head-note' }, icon('lock', 'ic'), 'Audio goes directly between members, encrypted')));
  } else if (v.type === 'friends') {
    const pending = Object.values(S.relationships).filter((r) => r.direction === 'incoming').length;
    const tab = (k, label, extra) => h('button', { class: `tab${v.tab === k ? ' active' : ''}${k === 'add' ? ' tab-add' : ''}`, role: 'tab', 'aria-selected': String(v.tab === k), onclick: () => goFriends(k) }, label, extra);
    head.append(h('div', { class: 'head-title' }, icon('people', 'ic head-ic'), h('h1', null, 'Friends')),
      h('div', { class: 'tabs', role: 'tablist' }, tab('online', 'Online'), tab('all', 'All'), tab('pending', 'Pending', pending ? h('span', { class: 'badge inline' }, pending) : null), tab('add', 'Add friend')));
  } else if (v.type === 'home') {
    head.append(h('div', { class: 'head-title' }, icon('home', 'ic head-ic'), h('h1', null, 'Home')),
      headTools(ibtn('search', 'Search (Ctrl+K)', () => openSearch())));
  } else if (v.type === 'admin') {
    head.append(h('div', { class: 'head-title' }, icon('shield', 'ic head-ic'), h('h1', null, 'Admin'), h('span', { class: 'head-topic' }, 'Only server administrators can see this')));
  } else if (v.type === 'saved') {
    head.append(h('div', { class: 'head-title' }, icon('bookmark', 'ic head-ic'), h('h1', null, 'Saved messages')),
      headTools(h('span', { class: 'head-note' }, 'Saved on this device only')));
  } else if (server) {
    head.append(h('div', { class: 'head-title' }, h('h1', null, server.name)));
  }
}
function encBadge(onclick, tip = 'End-to-end encrypted. Click for details.') {
  return h('button', { class: 'head-badge e2ee', 'data-tip': tip, 'aria-label': tip, onclick }, icon('lock'));
}
function notifyMenu(key) {
  const lvl = P.notify[key] || 'default';
  return [{ header: 'Notify me about' },
    ...[['default', 'Server default'], ['all', 'All messages'], ['mentions', 'Only @mentions'], ['muted', 'Nothing (mute)']].map(([v, l]) => ({ label: l, checked: lvl === v, action: () => setNotify(key, v) }))];
}

// ---- Home: a quick launchpad, not a wall of content
function homeView() {
  const wrap = h('div', { class: 'home-view' });
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  wrap.append(h('div', { class: 'home-hero' }, h('h2', null, `${greet}, ${displayName(S.me)}`),
    h('button', { class: 'home-search', onclick: () => openSearch() }, icon('search'), h('span', null, 'Search messages, people, channels and servers'), h('kbd', null, 'Ctrl K'))));

  const convs = conversations();
  const favs = P.favorites;
  const pinned = convs.filter((c) => favs.includes(c.fav));
  const section = (title, action, ...kids) => h('section', { class: 'home-sec' }, h('div', { class: 'home-sec-head' }, h('h3', null, title), action), ...kids);

  if (pinned.length) wrap.append(section('Pinned conversations', null, h('div', { class: 'conv-cards' }, pinned.map(convCard))));
  wrap.append(section('Recent conversations', h('button', { class: 'link-btn', onclick: () => openNewConversation() }, 'New message'),
    convs.length ? h('div', { class: 'conv-cards' }, convs.filter((c) => !favs.includes(c.fav)).slice(0, 6).map(convCard))
      : h('p', { class: 'muted-p' }, 'No conversations yet.')));

  const online = Object.values(S.relationships).filter((r) => r.status === 'accepted').map((r) => getUser(r.userId)).filter((u) => (u.presence || 'offline') !== 'offline');
  wrap.append(section(`Online friends \u2014 ${online.length}`, h('button', { class: 'link-btn', onclick: () => goFriends('all') }, 'All friends'),
    online.length ? h('div', { class: 'friend-chips' }, online.map((u) => h('button', { class: 'friend-chip', 'data-pop-anchor': '', onclick: (e) => openProfilePop(e.currentTarget, u.id, 'bottom') },
      avatarEl(u, 30, { status: true, meId: S.me.id }), h('span', null, displayName(u)))))
      : h('p', { class: 'muted-p' }, 'Nobody\u2019s online right now.')));

  const servers = realServers();
  wrap.append(section('Your servers', h('button', { class: 'link-btn', onclick: openAddServer }, 'Create or join'),
    servers.length ? h('div', { class: 'server-cards' }, servers.map((s) => {
      const { unread, mentions } = serverUnread(s);
      return h('button', { class: `server-card${unread ? ' unread' : ''}`, onclick: () => openServer(s.id) },
        s.icon ? h('img', { src: s.icon, alt: '' }) : h('span', { class: 'server-card-initials' }, s.name.slice(0, 2)),
        h('span', { class: 'server-card-text' }, h('strong', null, s.name), h('span', null, `${s.memberIds.length} members`)),
        mentions ? h('span', { class: 'badge' }, mentions) : unread ? h('span', { class: 'unread-dot' }) : null);
    })) : h('p', { class: 'muted-p' }, 'You\u2019re not in any servers yet.')));

  const activity = P.inbox.slice(0, 5);
  if (activity.length) {
    wrap.append(section('Recent activity', h('button', { class: 'link-btn', 'data-pop-anchor': '', onclick: (e) => openInbox(e.currentTarget) }, 'All notifications'),
      h('div', { class: 'activity' }, activity.map((it) => h('button', { class: 'activity-row', onclick: () => (it.msgId ? jumpToMessageId(it.msgId) : goFriends('pending')) },
        icon(it.type === 'mention' ? 'at' : it.type === 'reply' ? 'reply' : 'userPlus', 'ic activity-ic'),
        h('span', { class: 'activity-text' }, it.title, it.text ? h('span', null, it.text) : null),
        h('span', { class: 'activity-time' }, relTime(it.at)))))));
  }
  return wrap;
}
function convCard(c) {
  const unread = c.unreadKey && S.unread.has(c.unreadKey) && !isMuted(c.unreadKey);
  return h('button', { class: `conv-card${unread ? ' unread' : ''}`, onclick: c.open, oncontextmenu: (e) => contextMenu(e, c.menu) },
    c.avatar, h('span', { class: 'conv-card-text' }, h('strong', null, c.title), h('span', null, c.preview || 'No messages yet')),
    c.at ? h('span', { class: 'conv-card-time' }, shortTime(c.at)) : null);
}

function friendsView() {
  const v = S.view;
  const wrap = h('div', { class: 'friends' });
  const rels = Object.values(S.relationships);
  if (v.tab === 'add') {
    const input = h('input', { class: 'input', placeholder: 'Enter a username', maxlength: '24', autocomplete: 'off', 'aria-label': 'Username' });
    const msg = h('p', { class: 'add-msg', role: 'status' });
    const send = async () => {
      msg.className = 'add-msg';
      try {
        await api('POST', '/friends', { username: input.value.trim() });
        msg.textContent = `Friend request sent to ${input.value.trim()}.`;
        msg.classList.add('ok');
        input.value = '';
      } catch (e) { msg.textContent = e.message; msg.classList.add('bad'); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    wrap.append(h('div', { class: 'add-friend' },
      h('h2', null, 'Add a friend'),
      h('p', { class: 'muted-p' }, 'Type their username on this server. Usernames aren\u2019t case-sensitive.'),
      h('div', { class: 'add-row' }, input, h('button', { class: 'btn primary', onclick: send }, 'Send request')), msg));
    return wrap;
  }
  const search = h('input', { class: 'input search-input', placeholder: 'Search friends', 'aria-label': 'Search friends' });
  const listEl = h('div', { class: 'friend-list' });
  const draw = () => {
    clear(listEl);
    let list;
    if (v.tab === 'pending') list = rels.filter((r) => r.status === 'pending');
    else {
      list = rels.filter((r) => r.status === 'accepted');
      if (v.tab === 'online') list = list.filter((r) => (getUser(r.userId).presence || 'offline') !== 'offline');
    }
    const q = search.value.trim().toLowerCase();
    if (q) list = list.filter((r) => { const u = getUser(r.userId); return u.username.toLowerCase().includes(q) || displayName(u).toLowerCase().includes(q); });
    list.sort((a, b) => displayName(getUser(a.userId)).localeCompare(displayName(getUser(b.userId))));
    const label = { online: 'Online', all: 'All friends', pending: 'Pending' }[v.tab];
    listEl.append(h('div', { class: 'list-label' }, `${label} \u2014 ${list.length}`));
    if (!list.length) {
      const msg = { online: 'No friends are online right now.', all: 'No friends yet. Add someone by their username.', pending: 'No pending requests.' }[v.tab];
      listEl.append(h('div', { class: 'empty-state small' }, h('p', null, q ? 'No one matches that search.' : msg),
        v.tab !== 'pending' && !q ? h('button', { class: 'btn primary', onclick: () => goFriends('add') }, 'Add friend') : null));
    }
    for (const r of list) {
      const u = getUser(r.userId);
      const p = u.profile || {};
      const sub = r.status === 'pending'
        ? (r.direction === 'incoming' ? 'Wants to be friends' : 'Request sent')
        : (p.customStatus && (p.customStatus.text || p.customStatus.emoji) ? `${p.customStatus.emoji || ''} ${p.customStatus.text || ''}` : STATUS_LABEL[presenceOf(u, S.me.id)]);
      const actions = [];
      if (r.status === 'accepted') {
        actions.push(ibtn('message', 'Message', () => openDmWith(u.id)));
        actions.push(ibtn('more', 'More', (e) => menu(e.currentTarget, [
          { label: 'View profile', icon: 'user', action: () => openProfileModal(u.id) },
          { label: 'Remove friend', icon: 'trash', danger: true, action: async () => {
            if (await confirmDialog({ title: `Remove ${displayName(u)}?`, text: 'You can add them again later.', confirm: 'Remove friend', danger: true })) api('DELETE', '/friends/' + u.id).catch((e2) => toast(e2.message, 'error'));
          } },
          blockItem(u)], { align: 'end' }), { attrs: { 'data-pop-anchor': '' } }));
      } else if (r.direction === 'incoming') {
        actions.push(h('button', { class: 'btn primary sm', onclick: () => api('POST', `/friends/${u.id}/accept`).catch((e) => toast(e.message, 'error')) }, 'Accept'));
        actions.push(h('button', { class: 'btn ghost sm', onclick: () => api('DELETE', '/friends/' + u.id).catch((e) => toast(e.message, 'error')) }, 'Ignore'));
      } else {
        actions.push(h('button', { class: 'btn ghost sm', onclick: () => api('DELETE', '/friends/' + u.id).catch((e) => toast(e.message, 'error')) }, 'Cancel request'));
      }
      listEl.append(h('div', { class: 'friend-row' },
        h('button', { class: 'friend-who', 'data-pop-anchor': '', onclick: (e) => openProfilePop(e.currentTarget, u.id, 'right') },
          avatarEl(u, 38, { status: true, meId: S.me.id }),
          h('span', { class: 'friend-text' }, h('span', { class: 'friend-name' }, nameEl(u), h('span', { class: 'friend-handle' }, u.username)), h('span', { class: 'friend-sub' }, sub))),
        h('div', { class: 'friend-actions' }, actions)));
    }
  };
  search.addEventListener('input', draw);
  draw();
  wrap.append(h('div', { class: 'friends-search' }, icon('search'), search), listEl);
  return wrap;
}

function savedView() {
  const wrap = h('div', { class: 'saved' });
  const list = P.saved;
  if (!list.length) {
    wrap.append(h('div', { class: 'empty-state' }, h('h3', null, 'Nothing saved yet'),
      h('p', null, 'Hover a message and choose More \u2192 Save message to keep it here. Saved messages stay on this device.')));
    return wrap;
  }
  for (const it of list) {
    const u = getUser(it.authorId);
    wrap.append(h('div', { class: 'saved-row' },
      avatarEl(u, 36),
      h('div', { class: 'saved-body' },
        h('div', { class: 'saved-meta' }, nameEl(u), h('span', null, `${it.where} \u00b7 ${fmtStamp(it.createdAt)}`)),
        h('div', { class: 'saved-text md' , html: md(it.text || (it.files ? 'Attachment' : ''), { mentionName: S.me.username }) })),
      h('div', { class: 'saved-actions' },
        ibtn('arrowUp', 'Jump to message', () => jumpToMessageId(it.msgId)),
        ibtn('trash', 'Remove from saved', () => { P.saved = P.saved.filter((x) => x.msgId !== it.msgId); renderMain(); }))));
  }
  return wrap;
}

// ======================================================================= conversation view
function chatView() {
  const wrap = h('div', { class: 'chat' });
  const scroller = h('div', { class: 'messages', id: 'messages', tabindex: '0', 'aria-label': 'Messages', role: 'log' });
  scroller.addEventListener('scroll', onMessagesScroll);
  scroller.addEventListener('click', onMessageAreaClick);
  const jump = h('button', { class: 'jump-latest', id: 'jump-latest', hidden: true, onclick: () => jumpToLatest() }, icon('arrowDown'), 'Jump to latest');
  const key = currentKey();
  const comp = createComposer({ id: 'main', key: () => currentKey(), threadId: () => null });
  composers.main = comp;
  const room = S.view.type === 'dm' ? dmRoom(S.view.dmId) : callRoomFor(currentServer());
  if (room && ((S.voice[room] || []).length || (voice && voice.channelId === room))) wrap.append(callStage(room, { compact: true }));
  wrap.append(scroller, jump, comp.el);
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dropping'); });
  wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('dropping'); });
  wrap.addEventListener('drop', (e) => { e.preventDefault(); wrap.classList.remove('dropping'); comp.addFiles(e.dataTransfer.files); });
  queueMicrotask(() => { comp.renderExtras(); if (S.view.jumpTo) { const id = S.view.jumpTo; S.view.jumpTo = null; jumpToMessage(key, id); } else loadMessages(key); });
  return wrap;
}
function onMessageAreaClick(e) {
  const sp = e.target.closest('.md-spoiler');
  if (sp) sp.classList.add('revealed');
  const mention = e.target.closest('.mention[data-user]');
  if (mention) openProfilePop(mention, mention.dataset.user, 'right');
}

const msgUrl = (key) => (key.startsWith('c:') ? `/channels/${key.slice(2)}/messages` : `/dms/${key.slice(2)}/messages`);
// mode: 'latest' | 'older' | 'newer' | { around: id }
async function loadMessages(key, mode = 'latest') {
  let store = S.msgs[key];
  if (mode === 'latest' && store && store.loaded && !store.hasNewer) { await decryptAll(key); return renderMessages(true); }
  if (!store || (mode === 'latest' && store.hasNewer) || typeof mode === 'object') store = S.msgs[key] = { list: [], hasMore: true, hasNewer: false, loaded: false, loading: false };
  if (store.loading || (mode === 'older' && !store.hasMore) || (mode === 'newer' && !store.hasNewer)) return;
  store.loading = true;
  let q = '';
  if (mode === 'older' && store.list.length) q = `?before=${store.list[0].id}`;
  else if (mode === 'newer' && store.list.length) q = `?after=${store.list[store.list.length - 1].id}`;
  else if (typeof mode === 'object') q = `?around=${mode.around}`;
  if (!store.loaded) renderMessages(true);
  try {
    const res = await api('GET', msgUrl(key) + q);
    const known = new Set(store.list.map((m) => m.id));
    const fresh = res.messages.filter((m) => !known.has(m.id));
    store.list = [...store.list, ...fresh].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (mode !== 'newer') store.hasMore = res.hasMore;
    if (mode !== 'older') store.hasNewer = !!res.hasNewer;
    store.loaded = true;
    await decryptAll(key);
    if (currentKey() !== key) return;
    const sc = $('#messages');
    if (mode === 'older') {
      const prevH = sc.scrollHeight;
      const prevTop = sc.scrollTop;
      renderMessages(false);
      sc.scrollTop = sc.scrollHeight - prevH + prevTop;
    } else if (mode === 'newer') {
      const top = sc.scrollTop;
      renderMessages(false);
      sc.scrollTop = top;
    } else renderMessages(typeof mode !== 'object');
    if (!store.hasNewer) markRead(key);
  } catch (e) {
    toast(e.message, 'error');
  } finally { store.loading = false; }
}
function onMessagesScroll(e) {
  const sc = e.target;
  const key = currentKey();
  const store = S.msgs[key];
  if (!store) return;
  if (sc.scrollTop < 200 && store.hasMore && !store.loading) loadMessages(key, 'older');
  const fromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
  if (fromBottom < 200 && store.hasNewer && !store.loading) loadMessages(key, 'newer');
  const jl = $('#jump-latest');
  if (jl) jl.hidden = !(store.hasNewer || fromBottom > 1200);
  if (fromBottom < 40 && !store.hasNewer) markRead(key);
}
function jumpToLatest() {
  const key = currentKey();
  const store = S.msgs[key];
  if (store && store.hasNewer) { delete S.msgs[key]; loadMessages(key); }
  else { const sc = $('#messages'); if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
}

// ---- decryption (DMs and channels are both end-to-end encrypted)
async function decryptMessage(m) {
  if (m.dmId) await sec.decryptDmMessage(m);
  else await sec.decryptChannelMessage(m);
}
async function decryptAll(key) {
  const store = S.msgs[key];
  if (store) await Promise.all(store.list.map(decryptMessage));
}
const textOf = (m) => (m.dec && m.dec.t) || '';
const filesOf = (m) => (m.dec && m.dec.f) || [];
const readable = (m) => !!m.dec && !m.dec.error && !m.dec.pending;
const keyOfMessage = (m) => (m.dmId ? 'd:' + m.dmId : 'c:' + m.channelId);
// Does this message ping me? @username, or @everyone/@channel/@here in a server channel.
// Does this message ping me? @me, a role I have, or @everyone/@channel from someone allowed to use it.
// How does this message ping me? 'mention' (@me), 'everyone' (@everyone/@channel/@here from someone
// allowed to use it), 'roleMention' (a role I have), or null.
function mentionKind(m) {
  const t = textOf(m);
  if (!t) return null;
  const me = S.me.username.replace(/[.]/g, '\\.');
  if (new RegExp(`(^|\\s)@${me}(?![\\w.])`, 'i').test(t)) return 'mention';
  if (m.dmId) return null;
  const server = S.servers.find((x) => x.id === m.serverId);
  const mine = server ? (server.memberRoles || {})[S.me.id] || [] : [];
  for (const [, id] of t.matchAll(/<@&([a-z0-9]{6,40})>/g)) if (mine.includes(id)) return 'roleMention';
  if (/(^|\s)@(everyone|channel|here)\b/i.test(t) && authorMayPingEveryone(m)) return 'everyone';
  return null;
}
const mentionsMe = (m) => !!mentionKind(m);

async function onKeysChanged(serverId, added) {
  if (!S.me) return;
  if (added) {
    const server = S.servers.find((s) => s.id === serverId);
    for (const c of server ? server.channels : []) {
      const store = S.msgs['c:' + c.id];
      if (!store) continue;
      store.list.forEach((m) => {
        if (m.dec && m.dec.pending) m.dec = null;
        if (m.reply && m.reply.dec && m.reply.dec.pending) m.reply.dec = null;
      });
      await decryptAll('c:' + c.id);
      if (!store.loaded) continue;
      if (currentKey() === 'c:' + c.id) {
        const sc = $('#messages');
        const atBottom = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
        const top = sc ? sc.scrollTop : 0;
        renderMessages(atBottom);
        if (sc && !atBottom) sc.scrollTop = top;
      }
    }
    if (server && isGroup(server)) { await previewGroup(server); if (!S.view.serverId) renderSidebar(); }
  }
  if (S.view.serverId === serverId && composers.main) { composers.main.renderExtras(); renderHeader(); }
}
function onKeyWarning(user) {
  toast(`${displayName(user)}'s security key changed. Compare safety numbers before trusting it.`, 'error');
  if (S.view.type === 'dm' || S.view.serverId) { renderHeader(); if (composers.main) composers.main.renderExtras(); }
}
// Run a channel send/edit, refreshing our key and retrying once if the server says it's out of date.
async function withKeyRetry(serverId, fn) {
  try { return await fn(); } catch (e) {
    if (e.status === 409 && ['rotate', 'stale-key'].includes(e.code)) {
      await sec.refresh(serverId);
      return fn();
    }
    throw e;
  }
}

// ---- rendering the list
const GROUP_GAP = 7 * 60 * 1000;
function grouped(m, prev) {
  return !!prev && prev.authorId === m.authorId && !m.reply && m.createdAt - prev.createdAt < GROUP_GAP
    && new Date(prev.createdAt).toDateString() === new Date(m.createdAt).toDateString();
}
function renderMessages(stick) {
  const sc = $('#messages');
  if (!sc) return;
  const key = currentKey();
  const store = S.msgs[key];
  clear(sc);
  if (!store || !store.loaded) {
    sc.append(h('div', { class: 'msg-skeleton', 'aria-label': 'Loading messages' }, [1, 2, 3, 4].map(() => h('div', { class: 'sk-row' }, h('span', { class: 'sk-av' }), h('span', { class: 'sk-lines' }, h('i'), h('i'))))));
    return;
  }
  if (!store.hasMore) sc.append(welcomeBlock());
  const lastRead = P.lastRead[key];
  let newShown = false;
  let prev = null;
  for (const m of store.list) {
    if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
      sc.append(h('div', { class: 'day-div', role: 'separator' }, h('span', null, fmtDay(m.createdAt))));
      prev = null;
    }
    if (!newShown && lastRead && m.id > lastRead && m.authorId !== S.me.id && S.unreadMarker === key) {
      sc.append(h('div', { class: 'new-div', role: 'separator', 'aria-label': 'New messages' }, h('span', null, 'New')));
      newShown = true;
      prev = null;
    }
    sc.append(messageEl(m, prev, 'main'));
    prev = m;
  }
  if (stick) {
    const marker = sc.querySelector('.new-div');
    if (marker && marker.offsetTop > sc.clientHeight * 0.6) sc.scrollTop = marker.offsetTop - 80;
    else sc.scrollTop = sc.scrollHeight;
  }
  const jl = $('#jump-latest');
  if (jl) jl.hidden = !store.hasNewer;
  renderTyping();
}
function welcomeBlock() {
  if (S.view.type === 'dm') {
    const d = S.dms.find((x) => x.id === S.view.dmId);
    const u = getUser(d.userId);
    return h('div', { class: 'welcome' }, avatarEl(u, 72), nameEl(u, { tag: 'h2' }),
      h('p', null, `This is the start of your conversation with ${displayName(u)}.`),
      h('p', { class: 'welcome-note' }, icon('lock'), 'Messages and files here are end-to-end encrypted. Only the two of you can read them.'));
  }
  const server = currentServer();
  if (isGroup(server)) {
    return h('div', { class: 'welcome' }, groupAvatar(server, 72), h('h2', null, groupName(server)),
      h('p', null, 'This is the start of your group.'),
      h('p', { class: 'welcome-note' }, icon('lock'), 'End-to-end encrypted. Only people in this group can read it.'));
  }
  const c = server.channels.find((x) => x.id === S.view.channelId);
  const th = server.theme || {};
  return h('div', { class: 'welcome' }, h('div', { class: 'welcome-ic' }, icon(channelIcon(c))), h('h2', null, `Welcome to #${c.name}`),
    h('p', null, c.topic || 'This is the start of the channel.'),
    th.welcome ? h('div', { class: 'server-welcome', html: md(th.welcome, { mentionName: S.me.username }) }) : null,
    h('p', { class: 'welcome-note' }, icon('lock'), 'End-to-end encrypted. Only members of this server can read it.'));
}

// ---- one message
function messageEl(m, prev, ctx = 'main') {
  const author = getUser(m.authorId);
  const mine = m.authorId === S.me.id;
  const isGrouped = grouped(m, prev);
  const text = textOf(m);
  const mentioned = !mine && mentionsMe(m);
  const replying = composers[ctx] && composers[ctx].state.replyTo && composers[ctx].state.replyTo.id === m.id;
  const el = h('div', {
    class: `msg${isGrouped ? ' grouped' : ''}${mentioned ? ' mentioned' : ''}${replying ? ' replying' : ''}${m.pinnedAt ? ' pinned' : ''}`,
    dataset: { mid: m.id, ctx }, tabindex: '-1',
    oncontextmenu: (e) => { if (!e.target.closest('a, .md-code, .md-pre') || e.shiftKey) contextMenu(e, messageMenuItems(m, ctx)); },
  });
  if (S.blocked.has(m.authorId) && !el._reveal) {
    el.classList.add('blocked');
    el.append(h('div', { class: 'msg-gutter' }), h('div', { class: 'msg-body' }, h('div', { class: 'blocked-note' }, icon('ban'), 'Message from someone you blocked. ',
      h('button', { class: 'link-btn', onclick: () => { el._reveal = true; const fresh = messageElRevealed(m, prev, ctx); el.replaceWith(fresh); } }, 'Show'))));
    return el;
  }
  return fillMessage(el, m, prev, ctx, { author, mine, isGrouped, text });
}
function messageElRevealed(m, prev, ctx) {
  const el = h('div', { class: 'msg', dataset: { mid: m.id, ctx }, tabindex: '-1' });
  return fillMessage(el, m, prev, ctx, { author: getUser(m.authorId), mine: false, isGrouped: false, text: textOf(m) });
}
function fillMessage(el, m, prev, ctx, { author, mine, isGrouped, text }) {
  if (m.reply) {
    const ru = getUser(m.reply.authorId);
    const rd = m.reply.dec;
    const rtext = rd && !rd.error && !rd.pending ? rd.t : '';
    el.append(h('button', { class: 'msg-reply', 'aria-label': `Replying to ${displayName(ru)}. Jump to original.`, onclick: () => jumpToMessage(keyOfMessage(m), m.reply.id) },
      h('span', { class: 'reply-spine' }), avatarEl(ru, 16), nameEl(ru, { cls: 'reply-name' }),
      h('span', { class: 'reply-text', html: rtext ? md(rtext, { inline: true }) : '<em>Attachment or encrypted message</em>' })));
  } else if (m.replyTo) {
    el.append(h('div', { class: 'msg-reply gone' }, h('span', { class: 'reply-spine' }), 'Original message was deleted'));
  }
  const gutter = h('div', { class: 'msg-gutter', dataset: { time: fmtTime(m.createdAt) } });
  if (isGrouped) gutter.append(h('time', { class: 'msg-hover-time', datetime: new Date(m.createdAt).toISOString() }, fmtTime(m.createdAt)));
  else gutter.append(h('button', { class: 'msg-av', 'data-pop-anchor': '', 'aria-label': `View ${displayName(author)}'s profile`, onclick: (e) => openProfilePop(e.currentTarget, author.id, 'right') }, avatarEl(author, 40)));
  const body = h('div', { class: 'msg-body' });
  if (!isGrouped) {
    const server = m.serverId && S.servers.find((s) => s.id === m.serverId);
    const rs = roleStyle(server, author.id);
    body.append(h('div', { class: 'msg-head' },
      h('button', { class: 'msg-name', 'data-pop-anchor': '', onclick: (e) => openProfilePop(e.currentTarget, author.id, 'right') }, nameEl(author, { roleColor: rs.color })),
      rs.iconRole ? h('span', { class: 'role-icon', 'data-tip': rs.iconRole.name }, rs.iconRole.icon) : null,
      rs.owner ? h('span', { class: 'role-icon', 'data-tip': 'Server owner' }, '\uD83D\uDC51') : null,
      h('time', { class: 'msg-time', datetime: new Date(m.createdAt).toISOString(), title: new Date(m.createdAt).toLocaleString() }, fmtStamp(m.createdAt)),
      m.pinnedAt ? h('span', { class: 'msg-pin', 'data-tip': 'Pinned' }, icon('pin')) : null));
  }
  if (S.editing === m.id) body.append(editBox(m, ctx));
  else if (m.dec && m.dec.error) body.append(h('div', { class: 'msg-text undecryptable' }, icon('lock'), 'This message could not be decrypted on this device.'));
  else if (m.dec && m.dec.pending) {
    body.append(h('div', { class: 'msg-text undecryptable' }, icon('lock'), m.dec.before
      ? 'Sent before you joined. Only members who had the key then can read it.'
      : 'Waiting for the encryption key from another member\u2026'));
  } else {
    const chat = P.chat;
    const hideText = chat.embeds && isOnlyImageUrl(text) && !filesOf(m).length;
    if (text && !hideText) {
      const html = chat.markdown ? md(text, { mentionName: S.me.username, everyone: authorMayPingEveryone(m) }) : escapeText(text);
      body.append(h('div', { class: `msg-text${chat.jumbo && isJumbo(text) ? ' jumbo' : ''}`, html: html + (m.editedAt ? '<span class="edited" title="Edited">(edited)</span>' : '') }));
    }
    const embeds = chat.embeds ? extractImageUrls(text) : [];
    if (embeds.length) body.append(h('div', { class: 'msg-embeds' }, embeds.map((u) => h('div', { class: `embed-wrap${isGiphy(u) ? ' giphy' : ''}` },
      h('img', { class: 'embed-img', src: mediaUrl(u), alt: isGiphy(u) ? 'GIF' : 'Linked image', loading: 'lazy', referrerpolicy: 'no-referrer', onclick: (e) => openViewer(e.currentTarget) }),
      isGiphy(u) ? h('span', { class: 'giphy-tag' }, /klipy/i.test(u) ? 'KLIPY' : 'GIPHY') : null))));
    const files = filesOf(m);
    if (files.length) body.append(h('div', { class: 'msg-files' }, files.map((f) => attachmentEl(f, m))));
    if (m.dec && m.dec.legacy) body.append(h('div', { class: 'msg-flag', 'data-tip': 'Sent before end-to-end encryption was turned on. Protected by the server\u2019s encryption only.' }, 'Older message \u2014 not end-to-end encrypted'));
    else if (m.dec && m.dec.verified === false && !m.dmId) body.append(h('div', { class: 'msg-flag bad', 'data-tip': 'The signature on this message does not match the sender\u2019s key.' }, '\u26a0 Sender could not be verified'));
  }
  if (m.reactions && m.reactions.length) {
    body.append(h('div', { class: 'reactions' }, m.reactions.map((r) => {
      const mineR = r.userIds.includes(S.me.id);
      const names = r.userIds.slice(0, 6).map((id) => displayName(getUser(id))).join(', ') + (r.userIds.length > 6 ? ` and ${r.userIds.length - 6} more` : '');
      const label = r.emoji.startsWith('<') ? r.emoji.replace(/^<a?(:[A-Za-z0-9_]+:).*$/, '$1') : r.emoji;
      return h('button', { class: `reaction${mineR ? ' mine' : ''}`, 'data-tip': `${names} reacted with ${label}`, 'aria-pressed': String(mineR), 'aria-label': `${label} ${r.userIds.length}`, onclick: () => react(m, r.emoji) },
        emojiNode(r.emoji, 'r-emoji'), h('span', { class: 'r-count' }, r.userIds.length));
    }), h('button', { class: 'reaction add-r', 'data-pop-anchor': '', 'aria-label': 'Add reaction', 'data-tip': 'Add reaction', onclick: (e) => emojiPicker(e.currentTarget, (em) => react(m, em)) }, icon('smile'))));
  }
  if (m.threadCount && ctx === 'main') {
    body.append(h('button', { class: 'thread-chip', onclick: () => openThread(m) }, icon('thread'),
      h('strong', null, `${m.threadCount} ${m.threadCount === 1 ? 'reply' : 'replies'}`),
      m.threadLastAt ? h('span', null, `Last reply ${relTime(m.threadLastAt)}`) : null, icon('chevronRight')));
  }
  el.append(gutter, body, messageTools(m, ctx));
  return el;
}
// GIPHY media goes through our server (if the admin left the privacy proxy on), so GIPHY never sees viewers' IPs.
const isGiphy = (u) => /^https:\/\/(media\d*\.giphy\.com|i\.giphy\.com|static\.klipy\.com|static\.klipy\.co|media\.klipy\.com)\//i.test(u);
const mediaUrl = (u) => (isGiphy(u) && S.config.gifProxy && S.mediaToken ? `/media/gif?u=${encodeURIComponent(u)}&t=${encodeURIComponent(S.mediaToken)}` : u);
const escapeText = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])).replace(/\n/g, '<br>');

// Hover toolbar: just the essentials. Everything else lives in the ⋯ menu / right-click.
function messageTools(m, ctx) {
  const ok = readable(m);
  return h('div', { class: 'msg-tools', role: 'toolbar', 'aria-label': 'Message actions' },
    h('button', { class: 'tool quick', 'data-tip': 'React with 👍', 'aria-label': 'React with thumbs up', onclick: () => react(m, '👍') }, '👍'),
    h('button', { class: 'tool', 'data-tip': 'Add reaction', 'aria-label': 'Add reaction', 'data-pop-anchor': '', onclick: (e) => emojiPicker(e.currentTarget, (em) => react(m, em)) }, icon('smile')),
    ok ? h('button', { class: 'tool', 'data-tip': 'Reply', 'aria-label': 'Reply', onclick: () => startReply(m, ctx) }, icon('reply')) : null,
    ok && !m.dmId && !m.threadId && ctx === 'main' ? h('button', { class: 'tool', 'data-tip': m.threadCount ? 'Open thread' : 'Reply in thread', 'aria-label': 'Reply in thread', onclick: () => openThread(m) }, icon('thread')) : null,
    h('button', { class: 'tool', 'data-tip': 'More', 'aria-label': 'More actions', 'data-pop-anchor': '', onclick: (e) => menu(e.currentTarget, messageMenuItems(m, ctx), { align: 'end' }) }, icon('more')),
  );
}
function canModerate(m) {
  if (m.dmId) return false;
  return canIn(channelById(m.channelId), PERMS.MANAGE_MESSAGES);
}
function authorMayPingEveryone(m) {
  if (m.dmId) return false;
  const server = S.servers.find((x) => x.id === m.serverId);
  return !!server && has(basePerms(server, m.authorId), PERMS.MENTION_EVERYONE);
}

function messageMenuItems(m, ctx) {
  const mine = m.authorId === S.me.id;
  const ok = readable(m);
  const saved = P.saved.some((x) => x.msgId === m.id);
  const server = m.serverId && S.servers.find((s) => s.id === m.serverId);
  const canPin = m.dmId || isGroup(server) || mine || canModerate(m);
  return [
    { label: 'Add reaction', icon: 'smile', action: () => { const el = $(`[data-mid="${m.id}"] .msg-tools .tool:nth-child(2)`); emojiPicker(el || $('#main'), (em) => react(m, em)); } },
    ok ? { label: 'Reply', icon: 'reply', action: () => startReply(m, ctx) } : null,
    ok && !m.dmId && !m.threadId && ctx === 'main' ? { label: m.threadCount ? 'Open thread' : 'Reply in thread', icon: 'thread', action: () => openThread(m) } : null,
    ok ? { label: 'Forward', icon: 'forward', action: () => openForward(m) } : null,
    '-',
    canPin ? { label: m.pinnedAt ? 'Unpin message' : 'Pin message', icon: 'pin', action: () => togglePin(m) } : null,
    ok ? { label: saved ? 'Remove from saved' : 'Save message', icon: 'bookmark', action: () => toggleSaved(m) } : null,
    ctx === 'main' ? { label: 'Mark unread', icon: 'eye', action: () => markUnread(keyOfMessage(m), m.id) } : null,
    '-',
    ok && textOf(m) ? { label: 'Copy text', icon: 'copy', action: () => { copyText(textOf(m)); toast('Copied.'); } } : null,
    { label: 'Copy message link', icon: 'link', action: () => { copyText(messageLink(m)); toast('Message link copied. It only works for people who can see this conversation.'); } },
    mine && ok ? { label: 'Edit message', icon: 'edit', hint: '\u2191', action: () => { S.editing = m.id; replaceMessageEl(m); } } : null,
    mine || canModerate(m) ? { label: 'Delete message', icon: 'trash', danger: true, action: () => deleteMessage(m) } : null,
    !mine && readable(m) ? { label: 'Report message', icon: 'shield', danger: true, action: () => openReport({ message: m, ctx }) } : null,
  ];
}
const messageLink = (m) => `${location.origin}/#m/${m.id}`;

function replaceMessageEl(m) {
  $$(`[data-mid="${m.id}"]`).forEach((el) => {
    const ctx = el.dataset.ctx || 'main';
    const list = ctx === 'thread' ? threadList() : (S.msgs[keyOfMessage(m)] || { list: [] }).list;
    const i = list.findIndex((x) => x.id === m.id);
    const fresh = messageEl(m, i > 0 ? list[i - 1] : null, ctx);
    el.replaceWith(fresh);
    if (S.editing === m.id) { const ta = fresh.querySelector('textarea'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  });
}

// ---- jumping to messages (replies, links, search results, notifications)
function flash(el) {
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2000);
}
async function jumpToMessage(key, id) {
  if (currentKey() !== key) {
    if (key.startsWith('d:')) setView({ type: 'dm', dmId: key.slice(2), jumpTo: id });
    else { const s = serverOfChannel(key.slice(2)); if (s) setView({ type: 'channel', channelId: key.slice(2), serverId: s.id, jumpTo: id }); }
    return;
  }
  const el = $(`#messages [data-mid="${id}"]`);
  if (el) return flash(el);
  await loadMessages(key, { around: id });
  const again = $(`#messages [data-mid="${id}"]`);
  if (again) flash(again); else toast('That message was deleted.');
}
async function jumpToMessageId(id) {
  try {
    const loc = await api('GET', `/messages/${id}/locate`);
    if (loc.kind === 'dm') return jumpToMessage('d:' + loc.dmId, id);
    if (loc.threadId) {
      await jumpToMessage('c:' + loc.channelId, loc.threadId);
      const store = S.msgs['c:' + loc.channelId];
      const root = store && store.list.find((x) => x.id === loc.threadId);
      if (root) openThread(root, id);
      return;
    }
    return jumpToMessage('c:' + loc.channelId, id);
  } catch (e) { toast(e.message, 'error'); }
}
// Links: /#m/<messageId> or /#c/<channelId>
function openLinkFromHash() {
  const hsh = location.hash;
  if (!S.me || !hsh) return;
  history.replaceState(null, '', location.pathname);
  let m = hsh.match(/^#m\/([a-z0-9]+)$/i);
  if (m) return jumpToMessageId(m[1]);
  m = hsh.match(/^#c\/([a-z0-9]+)$/i);
  if (m) { const s = serverOfChannel(m[1]); if (s) openChannel(m[1], s.id); else toast('You don\u2019t have access to that channel.'); }
}

// ---- message actions
function editBox(m, ctx) {
  const ta = h('textarea', { class: 'edit-input', rows: '1', 'aria-label': 'Edit message' });
  ta.value = textOf(m);
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 300) + 'px'; };
  ta.addEventListener('input', autosize);
  setTimeout(autosize);
  const done = () => { S.editing = null; replaceMessageEl(m); const c = composers[ctx]; if (c) c.focus(); };
  const save = async () => {
    const content = ta.value;
    if (!content.trim() && !filesOf(m).length) return deleteMessage(m);
    if (content === textOf(m)) return done();
    try {
      const payload = { t: content, f: filesOf(m) };
      if (m.dmId) await api('PATCH', `/dm-messages/${m.id}`, { ciphertext: await sec.encryptDm(m.dmId, payload) });
      else {
        await withKeyRetry(m.serverId, async () => {
          const { ciphertext, epoch } = await sec.encryptChannel(m.serverId, m.channelId, payload);
          await api('PATCH', `/messages/${m.id}`, { ciphertext, epoch });
        });
      }
      S.editing = null;
    } catch (e) { toast(e.message, 'error'); }
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
  });
  return h('div', { class: 'edit-wrap' }, ta, h('div', { class: 'edit-hint' }, 'Esc to ', h('button', { class: 'link-btn', onclick: done }, 'cancel'), ' \u00b7 Enter to ', h('button', { class: 'link-btn', onclick: save }, 'save')));
}
async function deleteMessage(m) {
  if (!(await confirmDialog({ title: 'Delete message?', text: m.threadCount ? 'This removes the message and its thread for everyone.' : 'This removes it for everyone.', confirm: 'Delete', danger: true }))) return;
  try {
    if (m.dmId) await api('DELETE', `/dm-messages/${m.id}`);
    else await api('DELETE', `/messages/${m.id}`);
  } catch (e) { toast(e.message, 'error'); }
}
async function react(m, emoji) {
  pushRecentEmoji(emoji);
  try { await api('POST', `/messages/${m.id}/reactions`, { emoji }); } catch (e) { toast(e.message, 'error'); }
}
async function togglePin(m) {
  const wasPinned = !!m.pinnedAt; // read before the request: the live update can land first
  try { await api(wasPinned ? 'DELETE' : 'POST', `/messages/${m.id}/pin`); toast(wasPinned ? 'Message unpinned.' : 'Message pinned. Find it under the pin icon in the header.'); } catch (e) { toast(e.message, 'error'); }
}
function whereLabel(m) {
  if (m.dmId) { const d = S.dms.find((x) => x.id === m.dmId); return d ? `DM with ${displayName(getUser(d.userId))}` : 'Direct message'; }
  const s = S.servers.find((x) => x.id === m.serverId);
  if (isGroup(s)) return groupName(s);
  const c = channelById(m.channelId);
  return s && c ? `#${c.name} \u00b7 ${s.name}` : 'Channel';
}
function toggleSaved(m) {
  const list = P.saved;
  if (list.some((x) => x.msgId === m.id)) { P.saved = list.filter((x) => x.msgId !== m.id); toast('Removed from saved.'); }
  else {
    list.unshift({ msgId: m.id, authorId: m.authorId, text: textOf(m), files: filesOf(m).length, createdAt: m.createdAt, where: whereLabel(m), savedAt: Date.now() });
    P.saved = list;
    toast('Saved. Find it under Home \u2192 Saved messages.');
  }
  if (S.view.type === 'saved') renderMain();
}
function startReply(m, ctx = 'main') {
  const c = composers[ctx];
  if (c) c.setReply(m);
}
// Forward: re-encrypt the message (and its file keys) for another conversation.
function openForward(m) {
  const input = h('input', { class: 'input', placeholder: 'Search conversations and channels', 'aria-label': 'Search destinations' });
  const note = h('input', { class: 'input', placeholder: 'Add a message (optional)', maxlength: '2000' });
  const list = h('div', { class: 'quick-list' });
  const dests = [
    ...conversations().map((c) => ({ label: c.title, sub: c.key.startsWith('g:') ? 'Group' : 'Direct message', key: c.key.startsWith('g:') ? c.unreadKey : c.key, av: c.avatar })),
    ...realServers().flatMap((s) => s.channels.filter((c) => c.type === 'text').map((c) => ({ label: `#${c.name}`, sub: s.name, key: 'c:' + c.id, av: h('span', { class: 'dest-ic' }, icon('hash')) }))),
  ].filter((d) => d.key);
  let mdl;
  const draw = () => {
    clear(list);
    const q = input.value.trim().toLowerCase();
    dests.filter((d) => !q || d.label.toLowerCase().includes(q) || d.sub.toLowerCase().includes(q)).slice(0, 40).forEach((d) => list.append(
      h('button', { class: 'quick-row', onclick: async () => {
        try {
          const fwd = `${note.value.trim() ? note.value.trim() + '\n' : ''}> Forwarded from ${displayName(getUser(m.authorId))}\n${textOf(m).split('\n').map((l) => '> ' + l).join('\n')}`;
          await sendTo(d.key, null, { t: fwd, f: filesOf(m) }, null);
          mdl.close();
          toast(`Forwarded to ${d.label}.`);
        } catch (e) { toast(e.message, 'error'); }
      } }, d.av.cloneNode(true), h('span', { class: 'quick-text' }, h('strong', null, d.label), h('span', null, d.sub)))));
  };
  input.addEventListener('input', draw);
  mdl = modal({ title: 'Forward message', size: 'sm', body: h('div', { class: 'stack' }, input, list, note) });
  draw();
  input.focus();
}

// ======================================================================= attachments + media viewer
const blobCache = new Map();
function decryptedUrl(m, f) {
  if (!blobCache.has(f.url)) {
    blobCache.set(f.url, (async () => {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error('File is gone');
      const plain = await sec.decryptAttachment(m, f, await res.arrayBuffer());
      return URL.createObjectURL(new Blob([plain], { type: f.type || 'application/octet-stream' }));
    })());
  }
  return blobCache.get(f.url);
}
function fileIcon(type, name) {
  if (/^image\//.test(type)) return 'image';
  if (/pdf|text|document|msword|sheet|presentation/.test(type) || /\.(pdf|txt|md|docx?|xlsx?|pptx?|csv)$/i.test(name)) return 'file';
  return 'file';
}
async function downloadAttachment(m, f) {
  try {
    const enc = !!f.k || !!m.dmId;
    const href = enc ? await decryptedUrl(m, f) : f.url;
    const a = h('a', { href, download: f.name || 'file' });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { toast(e.message, 'error'); }
}
const loadQueue = makeQueue(3);
function attachmentEl(f, m) {
  const enc = !!f.k || !!m.dmId;
  const type = f.type || '';
  const media = /^image\//.test(type) ? 'img' : /^video\//.test(type) ? 'video' : /^audio\//.test(type) ? 'audio' : null;
  if (media) {
    const el = media === 'img'
      ? h('img', { class: 'att-img', alt: f.name || 'Image', tabindex: '0', role: 'button', 'aria-label': `Open ${f.name || 'image'}` })
      : h(media, { class: `att-${media}`, controls: true, preload: 'metadata' });
    const holder = h('div', { class: `att-media${enc ? ' locked' : ''}`, dataset: { name: f.name || '' } }, el);
    // Reserve the right space up front so the chat doesn't jump while images load.
    if (media === 'img' && f.w && f.h) {
      const w = Math.min(440, f.w, Math.round(340 * f.w / f.h));
      holder.style.width = `${w}px`;
      holder.style.aspectRatio = `${f.w} / ${f.h}`;
      holder.classList.add('sized');
    }
    const full = () => (enc ? decryptedUrl(m, f) : Promise.resolve(f.url));
    if (media === 'img') {
      el._full = full;
      el.addEventListener('click', () => openViewer(el, { name: f.name, download: () => downloadAttachment(m, f) }));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.click(); });
    }
    if (media === 'audio') holder.prepend(h('div', { class: 'att-audio-name' }, icon('file', 'ic'), f.name));
    // Load only when it scrolls near the screen, a few at a time; images show the small thumbnail first.
    const load = () => {
      holder.classList.add('loading');
      const want = media === 'img' && f.th ? () => decryptedUrl(m, { ...f.th, type: 'image/webp' }) : full;
      loadQueue(want).then((u) => { el.src = u; holder.classList.remove('locked', 'loading', 'failed'); })
        .catch(() => {
          holder.classList.remove('loading'); holder.classList.add('failed');
          const again = h('button', { class: 'att-retry', onclick: (e) => { e.stopPropagation(); again.remove(); blobCache.delete(f.url); if (f.th) blobCache.delete(f.th.url); load(); } }, icon('arrowDown'), 'Couldn\u2019t load \u2014 tap to retry');
          holder.append(again);
        });
    };
    if (enc || f.th) whenVisible(holder, load); else el.src = f.url;
    return holder;
  }
  return h('div', { class: 'att-file' },
    h('span', { class: 'att-file-badge' }, icon(fileIcon(type, f.name || ''), 'ic'), h('span', null, ((f.name || '').split('.').pop() || 'file').slice(0, 4).toUpperCase())),
    h('div', { class: 'att-file-text' }, h('span', { class: 'att-name', title: f.name }, f.name || 'file'), h('span', { class: 'att-size' }, fmtSize(f.size || 0), enc ? h('span', { class: 'att-enc' }, icon('lock', 'ic'), 'Encrypted') : null)),
    h('button', { class: 'btn ghost sm', onclick: () => downloadAttachment(m, f) }, icon('download'), 'Download'));
}

function openViewer(fromImg, { name, download } = {}) {
  const imgs = $$('#messages .att-img, #messages .embed-img, .thread-list .att-img').filter((i) => i.src);
  let idx = Math.max(0, imgs.indexOf(fromImg));
  let scale = 1; let tx = 0; let ty = 0;
  const img = h('img', { class: 'viewer-img', alt: '' });
  const caption = h('span', { class: 'viewer-name' });
  const counter = h('span', { class: 'viewer-count' });
  const stage = h('div', { class: 'viewer-stage' }, img);
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; stage.classList.toggle('zoomed', scale > 1); };
  const show = (i) => {
    idx = (i + imgs.length) % imgs.length;
    const src = imgs[idx];
    img.src = src.src; // thumbnail (instant)…
    stage.classList.add('loading-full');
    if (src._full) src._full().then((u) => { if (imgs[idx] === src) { img.src = u; } }).catch(() => {}).finally(() => stage.classList.remove('loading-full'));
    else stage.classList.remove('loading-full');
    const nm = src.closest('.att-media') ? src.closest('.att-media').dataset.name : src.alt;
    caption.textContent = nm || 'Image';
    counter.textContent = imgs.length > 1 ? `${idx + 1} / ${imgs.length}` : '';
    scale = 1; tx = 0; ty = 0; apply();
  };
  const zoom = (f) => { scale = Math.min(6, Math.max(1, scale * f)); if (scale === 1) { tx = 0; ty = 0; } apply(); };
  const close = () => { overlay.classList.add('closing'); setTimeout(() => overlay.remove(), 140); document.removeEventListener('keydown', keys, true); };
  const keys = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowRight') show(idx + 1);
    if (e.key === 'ArrowLeft') show(idx - 1);
    if (e.key === '+' || e.key === '=') zoom(1.4);
    if (e.key === '-') zoom(1 / 1.4);
  };
  const dl = async () => {
    if (imgs[idx] === fromImg && download) return download();
    const a = h('a', { href: img.src, download: caption.textContent || 'image', target: '_blank', rel: 'noopener noreferrer' });
    document.body.append(a); a.click(); a.remove();
  };
  const copy = async () => {
    try {
      const blob = await (await fetch(img.src)).blob();
      const png = blob.type === 'image/png' ? blob : await toPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toast('Image copied.');
    } catch { copyText(img.src.startsWith('blob:') ? '' : img.src); toast(img.src.startsWith('blob:') ? 'Your browser can\u2019t copy this image.' : 'Image link copied.'); }
  };
  const bar = h('div', { class: 'viewer-bar' }, caption, counter, h('span', { class: 'spacer' }),
    ibtn('zoomOut', 'Zoom out (−)', () => zoom(1 / 1.4)), ibtn('zoomIn', 'Zoom in (+)', () => zoom(1.4)),
    ibtn('maximize', 'Fullscreen', () => (document.fullscreenElement ? document.exitFullscreen() : overlay.requestFullscreen().catch(() => {}))),
    ibtn('copy', 'Copy image', copy), ibtn('download', 'Download', dl), ibtn('close', 'Close (Esc)', close));
  const overlay = h('div', { class: 'viewer', role: 'dialog', 'aria-label': 'Image viewer', 'aria-modal': 'true' }, bar, stage,
    imgs.length > 1 ? h('button', { class: 'viewer-nav prev', 'aria-label': 'Previous image', onclick: () => show(idx - 1) }, icon('chevronLeft')) : null,
    imgs.length > 1 ? h('button', { class: 'viewer-nav next', 'aria-label': 'Next image', onclick: () => show(idx + 1) }, icon('chevronRight')) : null);
  stage.addEventListener('click', (e) => { if (e.target === stage) close(); });
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  img.addEventListener('dblclick', () => { if (scale > 1) { scale = 1; tx = 0; ty = 0; apply(); } else zoom(2.5); });
  let drag = null;
  img.addEventListener('pointerdown', (e) => { if (scale <= 1) return; drag = { x: e.clientX - tx, y: e.clientY - ty }; img.setPointerCapture(e.pointerId); });
  img.addEventListener('pointermove', (e) => { if (!drag) return; tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); });
  img.addEventListener('pointerup', () => { drag = null; });
  document.addEventListener('keydown', keys, true);
  document.body.append(overlay);
  show(idx);
  overlay.querySelector('.viewer-bar .icon-btn:last-child').focus();
}
async function toPng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

// ======================================================================= incoming events
async function onNewMessage(key, m) {
  const store = S.msgs[key];
  await decryptMessage(m);
  if (key.startsWith('d:')) { S.previews[key] = previewText(m); }
  else {
    const s = S.servers.find((x) => x.id === m.serverId);
    if (isGroup(s)) { s.last = m; s.lastMessageAt = m.createdAt; S.previews['g:' + s.id] = previewText(m, true); }
  }
  if (store && store.loaded && !store.hasNewer && !store.list.find((x) => x.id === m.id)) {
    store.list.push(m);
    if (currentKey() === key) {
      const sc = $('#messages');
      const near = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
      const prev = store.list[store.list.length - 2];
      if (sc) {
        const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
        if (newDay) sc.append(h('div', { class: 'day-div', role: 'separator' }, h('span', null, fmtDay(m.createdAt))));
        sc.append(messageEl(m, newDay ? null : prev, 'main'));
        if (near || m.authorId === S.me.id) sc.scrollTop = sc.scrollHeight;
      }
    }
  }
  const t = S.typing[key];
  if (t && t.has(m.authorId)) { clearTimeout(t.get(m.authorId)); t.delete(m.authorId); if (currentKey() === key) renderTyping(); }
  if (m.authorId === S.me.id) { if (!S.view.serverId) renderSidebar(); return; }
  const viewing = currentKey() === key && !document.hidden;
  const level = notifyLevel(key);
  const isDm = key.startsWith('d:') || isGroup(S.servers.find((x) => x.id === m.serverId));
  const mentioned = mentionsMe(m);
  const repliedToMe = m.reply && m.reply.authorId === S.me.id;
  if (!viewing) {
    S.unread.add(key);
    if ((isDm || mentioned || repliedToMe) && level !== 'muted' && !S.blocked.has(m.authorId)) {
      S.mentions.set(key, (S.mentions.get(key) || 0) + 1);
      if (S.me.status !== 'dnd') { playSound(mentionKind(m) || (isDm ? (key.startsWith('d:') ? 'dm' : 'groupDm') : 'reply')); notify(getUser(m.authorId), previewText(m).replace(/^You: /, ''), key); }
    } else if (level === 'all' && !S.blocked.has(m.authorId) && S.me.status !== 'dnd') playSound('message');
  }
  if ((mentioned || repliedToMe) && !S.blocked.has(m.authorId)) {
    addInbox({
      type: mentioned ? 'mention' : 'reply', userId: m.authorId, msgId: m.id,
      title: `${displayName(getUser(m.authorId))} ${mentioned ? 'mentioned you' : 'replied to you'} in ${whereLabel(m)}`,
      text: textOf(m).slice(0, 140),
    });
  }
  updateTitle();
  renderRail();
  if ((isDm && !S.view.serverId) || (!isDm && S.view.serverId === m.serverId) || (isDm && isGroup(currentServer()))) renderSidebar();
  if (S.view.type === 'home') renderMain();
}
function notify(author, body, key) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && document.hasFocus())) return;
  if (localStorage.getItem('hearth.notify') === 'off') return;
  try {
    const n = new Notification(displayName(author), { body: body.slice(0, 140), icon: author.avatar || undefined, tag: key });
    n.onclick = () => { window.focus(); if (window.hearthDesktop) window.hearthDesktop.focus(); if (key.startsWith('d:')) openDm(key.slice(2)); else { const s = serverOfChannel(key.slice(2)); if (s) openChannel(key.slice(2), s.id); } n.close(); };
  } catch { /* ignore */ }
}
async function onUpdateMessage(key, m) {
  const store = S.msgs[key];
  if (!store) return;
  const i = store.list.findIndex((x) => x.id === m.id);
  if (i < 0) return;
  await decryptMessage(m);
  store.list[i] = m;
  if (S.editing === m.id) S.editing = null;
  replaceMessageEl(m);
}
function onDeleteMessage(key, id) {
  const store = S.msgs[key];
  if (!store) return;
  store.list = store.list.filter((x) => x.id !== id);
  store.list.forEach((x) => { if (x.reply && x.reply.id === id) x.reply = null; });
  if (S.thread && S.thread.rootId === id) closeThread();
  if (currentKey() === key) {
    const sc = $('#messages');
    const top = sc ? sc.scrollTop : 0;
    renderMessages(false);
    if (sc) sc.scrollTop = top;
  }
}
function renderTyping() {
  $$('.typing').forEach((el) => {
    clear(el);
    const key = el.dataset.key;
    const t = S.typing[key];
    const ids = t ? [...t.keys()].filter((id) => id !== S.me.id) : [];
    if (!ids.length) return;
    const names = ids.map((id) => displayName(getUser(id)));
    const text = names.length === 1 ? `${names[0]} is typing\u2026` : names.length < 4 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing\u2026` : 'Several people are typing\u2026';
    el.append(h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', null, text));
  });
}

// ======================================================================= threads
function threadList() {
  const t = S.thread && S.threads[S.thread.rootId];
  return t ? [t.root, ...t.list] : [];
}
function findThreadMessage(id) {
  for (const t of Object.values(S.threads)) {
    if (t.root && t.root.id === id) return t.root;
    const m = t.list.find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}
async function openThread(root, focusId) {
  if (root.threadId) return;
  S.thread = { rootId: root.id, channelId: root.channelId, serverId: root.serverId, focusId };
  S.panel = 'thread';
  document.body.classList.add('panel-open');
  renderPanel(); renderHeader();
  try {
    const res = await api('GET', `/messages/${root.id}/thread`);
    const t = { root: res.root, list: res.messages, loaded: true };
    await Promise.all([t.root, ...t.list].map(decryptMessage));
    S.threads[root.id] = t;
    if (S.thread && S.thread.rootId === root.id) renderPanel();
  } catch (e) { toast(e.message, 'error'); closeThread(); }
}
function closeThread() {
  S.thread = null;
  S.panel = P.showMembers && ['channel', 'dm'].includes(S.view.type) ? 'members' : null;
  document.body.classList.toggle('panel-open', !!panelMode());
  delete composers.thread;
  renderPanel(); renderHeader();
}
async function onThreadMessage(m) {
  await decryptMessage(m);
  const t = S.threads[m.threadId];
  if (t && !t.list.find((x) => x.id === m.id)) {
    t.list.push(m);
    if (S.thread && S.thread.rootId === m.threadId) {
      const list = $('.thread-list');
      if (list) {
        list.append(messageEl(m, t.list[t.list.length - 2] || null, 'thread'));
        const div = list.querySelector('.thread-divider span');
        if (div) div.textContent = `${t.list.length} ${t.list.length === 1 ? 'reply' : 'replies'}`;
        list.scrollTop = list.scrollHeight;
      }
    }
  }
  if (m.authorId !== S.me.id && (mentionsMe(m) || (m.reply && m.reply.authorId === S.me.id)) && !S.blocked.has(m.authorId)) {
    addInbox({ type: mentionsMe(m) ? 'mention' : 'reply', userId: m.authorId, msgId: m.id, title: `${displayName(getUser(m.authorId))} ${mentionsMe(m) ? 'mentioned you' : 'replied to you'} in a thread in ${whereLabel(m)}`, text: textOf(m).slice(0, 140) });
    if (S.me.status !== 'dnd' && notifyLevel('c:' + m.channelId) !== 'muted') playSound(mentionKind(m) || 'reply');
  }
}
async function onThreadUpdate(m) {
  const t = S.threads[m.threadId];
  if (!t) return;
  const i = t.list.findIndex((x) => x.id === m.id);
  if (i < 0) return;
  await decryptMessage(m);
  t.list[i] = m;
  if (S.editing === m.id) S.editing = null;
  replaceMessageEl(m);
}

// ======================================================================= right panel (contextual)
function renderPanel() {
  const el = $('#members');
  if (!el) return;
  clear(el);
  const mode = panelMode();
  document.body.classList.toggle('panel-open', !!mode);
  el.hidden = !mode;
  if (!mode || !S.me) return;
  el.dataset.mode = mode;
  queueMicrotask(() => { if (!el.querySelector(':scope > .resize-handle')) el.append(resizeHandle('panel')); });
  if (mode === 'thread') return threadPanel(el);
  if (mode === 'pins') return pinsPanel(el);
  if (S.view.type === 'dm') return dmProfilePanel(el);
  return membersPanel(el);
}
function panelHead(title, sub, extra) {
  return h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, h('h2', null, title), sub ? h('span', null, sub) : null),
    extra, ibtn('close', 'Close panel', () => (S.panel === 'thread' ? closeThread() : togglePanel(S.panel))));
}

function membersPanel(el) {
  const server = currentServer();
  if (!server) return;
  const group = isGroup(server);
  const search = h('input', { class: 'input search-input', placeholder: 'Search members', 'aria-label': 'Search members' });
  const list = h('div', { class: 'member-list' });
  const draw = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const users = server.memberIds.map(getUser).filter((u) => !q || u.username.toLowerCase().includes(q) || displayName(u).toLowerCase().includes(q));
    // Like Discord: online people grouped under their highest "show separately" role, then Online, then Offline.
    const hoisted = (server.roleDefs || []).filter((r) => r.hoist && !r.everyone).sort((a, b) => b.position - a.position);
    const sections = new Map(hoisted.map((r) => [r.id, []]));
    const online = []; const offline = [];
    for (const u of users) {
      if (presenceOf(u, S.me.id) === 'offline') { offline.push(u); continue; }
      const top = memberRoles(server, u.id).find((r) => r.hoist);
      if (top && sections.has(top.id)) sections.get(top.id).push(u); else online.push(u);
    }
    const byName = (a, b) => displayName(a).localeCompare(displayName(b));
    const row = (u) => {
      const p = u.profile || {};
      const cs = p.customStatus && (p.customStatus.text || p.customStatus.emoji) ? `${p.customStatus.emoji || ''} ${p.customStatus.text || ''}`.trim() : '';
      const rs = roleStyle(server, u.id);
      return h('button', {
        class: `member${presenceOf(u, S.me.id) === 'offline' ? ' dim' : ''}`, 'data-pop-anchor': '',
        onclick: (e) => openProfilePop(e.currentTarget, u.id, 'left'),
        oncontextmenu: (e) => contextMenu(e, memberMenuItems(server, u)),
      }, avatarEl(u, 34, { status: true, meId: S.me.id }),
      h('span', { class: 'member-text' },
        h('span', { class: 'member-name' }, nameEl(u, { roleColor: rs.color }),
          rs.owner ? h('span', { class: 'role-icon', 'data-tip': 'Server owner' }, '\uD83D\uDC51') : null,
          rs.iconRole ? h('span', { class: 'role-icon', 'data-tip': rs.iconRole.name }, rs.iconRole.icon) : null,
          sec.keyChanged(u) ? h('span', { class: 'key-warn', 'data-tip': 'Security key changed' }, icon('shield')) : null),
        cs ? h('span', { class: 'member-status' }, cs) : null));
    };
    for (const r of hoisted) {
      const list2 = sections.get(r.id).sort(byName);
      if (list2.length) list.append(h('div', { class: 'group-label' }, h('span', { style: r.color ? { color: r.color } : null }, `${r.icon ? r.icon + ' ' : ''}${r.name} \u2014 ${list2.length}`)), ...list2.map(row));
    }
    if (online.length) list.append(h('div', { class: 'group-label' }, h('span', null, `Online \u2014 ${online.length}`)), ...online.sort(byName).map(row));
    if (offline.length) list.append(h('div', { class: 'group-label' }, h('span', null, `Offline \u2014 ${offline.length}`)), ...offline.sort(byName).map(row));
    if (!users.length) list.append(h('p', { class: 'sidebar-empty' }, 'No one matches.'));
  };
  search.addEventListener('input', draw);
  draw();
  el.append(panelHead(group ? 'People' : 'Members', `${server.memberIds.length}`,
    group ? ibtn('userPlus', 'Add people', () => openNewConversation(server), { cls: 'sm' }) : can(server, PERMS.CREATE_INVITE) ? ibtn('userPlus', 'Invite people', () => openInvite(server), { cls: 'sm' }) : null),
  h('div', { class: 'panel-search' }, icon('search'), search), list);
}

function memberMenuItems(server, u) {
  const me = u.id === S.me.id;
  const items = [
    { label: 'View profile', icon: 'user', action: () => openProfileModal(u.id) },
    !me ? { label: 'Message', icon: 'message', action: () => openDmWith(u.id) } : null,
    { label: 'Copy username', icon: 'copy', action: () => { copyText(u.username); toast('Copied.'); } },
  ];
  if (isGroup(server)) return items;
  const isOwnerTarget = server.ownerId === u.id;
  const myTop = server.ownerId === S.me.id ? Infinity : Math.max(0, ...memberRoles(server, S.me.id).map((r) => r.position));
  const theirTop = isOwnerTarget ? Infinity : Math.max(0, ...memberRoles(server, u.id).map((r) => r.position));
  if (can(server, PERMS.MANAGE_ROLES)) {
    const assignable = (server.roleDefs || []).filter((r) => !r.everyone && r.position < myTop);
    if (assignable.length && (me || theirTop < myTop)) {
      items.push('-', { header: 'Roles' });
      const current = (server.memberRoles || {})[u.id] || [];
      assignable.forEach((r) => items.push({
        label: `${r.icon ? r.icon + ' ' : ''}${r.name}`, checked: current.includes(r.id),
        action: () => api('PUT', `/servers/${server.id}/members/${u.id}/roles`, { roleIds: current.includes(r.id) ? current.filter((x) => x !== r.id) : [...current, r.id] }).catch((e) => toast(e.message, 'error')),
      }));
    }
  }
  if (!me && !isOwnerTarget && theirTop < myTop) {
    if (can(server, PERMS.KICK_MEMBERS) || can(server, PERMS.BAN_MEMBERS)) items.push('-');
    if (can(server, PERMS.KICK_MEMBERS)) items.push({ label: `Kick ${displayName(u)}`, icon: 'logout', danger: true, action: async () => {
      if (await confirmDialog({ title: `Kick ${displayName(u)}?`, text: 'They can rejoin with an invite. The server\u2019s encryption key is replaced automatically so they can\u2019t read new messages.', confirm: 'Kick', danger: true })) api('DELETE', `/servers/${server.id}/members/${u.id}`).catch((e) => toast(e.message, 'error'));
    } });
    if (can(server, PERMS.BAN_MEMBERS)) items.push({ label: `Ban ${displayName(u)}`, icon: 'ban', danger: true, action: () => openBan(server, u) });
  }
  return items;
}
function openBan(server, u) {
  const reason = h('input', { class: 'input', maxlength: '300', placeholder: 'Optional — only moderators see it' });
  modal({ title: `Ban ${displayName(u)}?`, size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'They\u2019re removed now and can\u2019t rejoin, even with an invite, until someone unbans them.'), field('Reason', reason)),
    actions: [{ label: 'Cancel' }, { label: 'Ban', kind: 'danger', action: () => api('POST', `/servers/${server.id}/bans`, { userId: u.id, reason: reason.value }).then(() => toast(`${displayName(u)} is banned.`)) }] });
}

function dmProfilePanel(el) {
  const d = S.dms.find((x) => x.id === S.view.dmId);
  if (!d) return;
  const u = getUser(d.userId);
  const mutual = realServers().filter((s) => s.memberIds.includes(u.id));
  el.append(h('div', { class: 'dm-profile' }, profileCard(u, {
    meId: S.me.id,
    mutual: mutual.length ? h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, `Mutual servers \u2014 ${mutual.length}`),
      h('div', { class: 'pc-mutuals' }, mutual.map((s) => h('button', { class: 'pc-mutual', onclick: () => openServer(s.id) }, s.icon ? h('img', { src: s.icon, alt: '' }) : h('span', null, s.name.slice(0, 1)), s.name)))) : null,
  })));
}
async function pinsPanel(el) {
  const key = currentKey();
  el.append(panelHead('Pinned messages', null));
  const list = h('div', { class: 'pin-list' }, h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
  el.append(list);
  try {
    const url = key.startsWith('c:') ? `/channels/${key.slice(2)}/pins` : `/dms/${key.slice(2)}/pins`;
    const pins = await api('GET', url);
    await Promise.all(pins.map(decryptMessage));
    if (currentKey() !== key || panelMode() !== 'pins') return;
    clear(list);
    if (!pins.length) { list.append(h('div', { class: 'panel-empty' }, icon('pin'), h('p', null, 'No pinned messages yet. Pin important messages from the \u22ef menu so everyone can find them.'))); return; }
    pins.forEach((m) => {
      const u = getUser(m.authorId);
      list.append(h('div', { class: 'pin-card' },
        h('div', { class: 'pin-meta' }, avatarEl(u, 20), nameEl(u), h('span', null, fmtStamp(m.createdAt))),
        h('div', { class: 'pin-text', html: readable(m) ? md(textOf(m) || (filesOf(m).length ? '_Attachment_' : ''), { mentionName: S.me.username }) : '<em>Encrypted message</em>' }),
        h('div', { class: 'pin-actions' },
          h('button', { class: 'btn ghost sm', onclick: () => jumpToMessage(key, m.id) }, 'Jump'),
          ibtn('close', 'Unpin', () => togglePin(m), { cls: 'sm' }))));
    });
  } catch (e) { clear(list).append(h('p', { class: 'sidebar-empty' }, e.message)); }
}
function threadPanel(el) {
  const t = S.threads[S.thread.rootId];
  const c = channelById(S.thread.channelId);
  el.append(panelHead('Thread', c ? `#${c.name}` : ''));
  if (!t) { el.append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' }))); return; }
  const list = h('div', { class: 'thread-list', role: 'log', 'aria-label': 'Thread messages' });
  list.addEventListener('click', onMessageAreaClick);
  list.append(messageEl(t.root, null, 'thread'));
  list.append(h('div', { class: 'thread-divider' }, h('span', null, t.list.length ? `${t.list.length} ${t.list.length === 1 ? 'reply' : 'replies'}` : 'No replies yet')));
  let prev = null;
  t.list.forEach((m) => { list.append(messageEl(m, prev, 'thread')); prev = m; });
  const comp = createComposer({ id: 'thread', key: () => 'c:' + S.thread.channelId, threadId: () => S.thread.rootId, placeholder: 'Reply in thread\u2026' });
  composers.thread = comp;
  el.append(list, comp.el);
  comp.renderExtras();
  requestAnimationFrame(() => {
    list.scrollTop = list.scrollHeight;
    if (S.thread && S.thread.focusId) { const f = list.querySelector(`[data-mid="${S.thread.focusId}"]`); if (f) flash(f); S.thread.focusId = null; }
    comp.focus();
  });
}

// ======================================================================= composer
const composers = {};
const drafts = new Map();
let lastTypingSent = 0;
function createComposer({ id, key, threadId, placeholder }) {
  const state = { replyTo: null, pending: [] };
  const k = key();
  const ta = h('textarea', { class: 'composer-input', rows: '1', maxlength: '4000', 'aria-label': 'Message', id: id === 'main' ? 'composer-input' : null });
  ta.placeholder = placeholder || placeholderFor(k);
  ta.value = drafts.get(k + (threadId() || '')) || '';
  const extras = h('div', { class: 'composer-extras' });
  const typing = h('div', { class: 'typing', 'aria-live': 'polite', dataset: { key: k } });
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { addFiles(fileIn.files); fileIn.value = ''; } });
  const sendBtn = h('button', { class: 'send-btn', 'data-tip': P.chat.enterToSend ? 'Send (Enter)' : 'Send (Ctrl+Enter)', 'aria-label': 'Send message', onclick: () => send() }, icon('send'));
  const suggest = h('div', { class: 'suggest', role: 'listbox', hidden: true });
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; };
  const update = () => { sendBtn.disabled = !ta.value.trim() && !state.pending.length; };
  const box = h('div', { class: 'composer' },
    h('button', { class: 'icon-btn attach', 'aria-label': 'Attach files', 'data-tip': 'Attach files', onclick: () => fileIn.click() }, icon('plus')),
    ta,
    h('div', { class: 'composer-tools' },
      h('button', { class: 'icon-btn', 'aria-label': 'Emoji', 'data-tip': 'Emoji', 'data-pop-anchor': '', onclick: (e) => emojiPicker(e.currentTarget, (em) => insertAtCursor(ta, em), { keepOpen: true }) }, icon('smile')),
      h('button', { class: 'icon-btn', 'aria-label': 'GIFs', 'data-tip': 'GIFs', 'data-pop-anchor': '', onclick: (e) => gifPicker(e.currentTarget, (url) => send(url)) }, icon('gif')),
      sendBtn),
    fileIn);
  const slowNote = h('div', { class: 'slow-note', hidden: true });
  let slowUntil = 0;
  const startSlow = (secs) => {
    slowUntil = Date.now() + secs * 1000;
    const tick = () => {
      const left = Math.ceil((slowUntil - Date.now()) / 1000);
      if (left <= 0 || !document.body.contains(slowNote)) { slowUntil = 0; renderExtras(); return; }
      slowNote.hidden = false; slowNote.textContent = `Slowmode: you can send again in ${fmtDuration(left)}`;
      setTimeout(tick, 1000);
    };
    tick();
  };
  const el = h('div', { class: `composer-wrap cw-${id}` }, suggest, extras, box, slowNote, typing);

  // ---- @mention autocomplete
  let sugg = { items: [], i: 0, start: -1 };
  // Autocomplete: @people, @roles, @everyone (if allowed) and :emoji: (standard + custom from all your servers)
  const candidates = () => {
    const kk = key();
    if (kk.startsWith('d:')) { const d = S.dms.find((x) => x.id === kk.slice(2)); return d ? [getUser(d.userId)] : []; }
    const s = serverOfChannel(kk.slice(2));
    if (!s) return [];
    const people = s.memberIds.filter((x) => x !== S.me.id).map(getUser);
    if (isGroup(s)) return people;
    const ch = channelById(kk.slice(2));
    const pingAll = canIn(ch, PERMS.MENTION_EVERYONE);
    const roles = (s.roleDefs || []).filter((r) => !r.everyone && (r.mentionable || pingAll)).map((r) => ({ role: r }));
    return [...people, ...roles, ...(pingAll ? [{ special: 'everyone', hint: 'Notify everyone in this server' }, { special: 'channel', hint: 'Notify everyone in this channel' }] : [])];
  };
  const closeSuggest = () => { suggest.hidden = true; sugg = { items: [], i: 0, start: -1 }; };
  const drawSuggest = () => {
    clear(suggest);
    sugg.items.forEach((c, i) => suggest.append(h('button', {
      class: `suggest-item${i === sugg.i ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === sugg.i),
      onmousedown: (e) => { e.preventDefault(); pick(i); },
    },
    c.emoji ? h('span', { class: 'suggest-emoji' }, c.custom ? h('img', { class: 'cemoji', src: c.custom.url, alt: '' }) : c.emoji)
      : c.special ? h('span', { class: 'suggest-at' }, icon('at'))
        : c.role ? h('span', { class: 'suggest-at role', style: c.role.color ? { color: c.role.color } : null }, c.role.icon || icon('shield'))
          : avatarEl(c, 24),
    h('span', { class: 'suggest-name', style: c.role && c.role.color ? { color: c.role.color } : null },
      c.emoji ? `:${c.name}:` : c.special ? `@${c.special}` : c.role ? `@${c.role.name}` : displayName(c)),
    h('span', { class: 'suggest-hint' }, c.emoji ? (c.custom ? c.custom.serverName : '') : c.special ? c.hint : c.role ? 'Role' : c.username))));
    suggest.hidden = !sugg.items.length;
  };
  const checkSuggest = () => {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const em = before.match(/(^|\s):([A-Za-z0-9_]{2,32})$/);
    if (em) {
      const q = em[2].toLowerCase();
      const custom = allEmojis().filter((e) => e.name.toLowerCase().includes(q)).slice(0, 6).map((e) => ({ emoji: true, custom: e, name: e.name }));
      const std = searchEmoji(q).slice(0, 8 - custom.length).map((e) => ({ emoji: e, name: (EMOJI_NAMES.get(e) || q).split(' ')[0] }));
      sugg = { items: [...custom, ...std], i: 0, start: pos - em[2].length - 1, kind: 'emoji' };
      return drawSuggest();
    }
    const m = before.match(/(^|\s)@([\w.]{0,24})$/);
    if (!m) return closeSuggest();
    const q = m[2].toLowerCase();
    const items = candidates().filter((c) => (c.special ? c.special.startsWith(q) : c.role ? c.role.name.toLowerCase().includes(q) : (c.username.toLowerCase().startsWith(q) || displayName(c).toLowerCase().includes(q)))).slice(0, 8);
    sugg = { items, i: 0, start: pos - m[2].length - 1, kind: 'at' };
    drawSuggest();
  };
  const pick = (i) => {
    const c = sugg.items[i];
    if (!c) return;
    const insert = c.emoji ? (c.custom ? emojiToken(c.custom) : c.emoji) : c.role ? `<@&${c.role.id}>` : '@' + (c.special || c.username);
    if (c.emoji) pushRecentEmoji(c.custom ? emojiToken(c.custom) : c.emoji);
    ta.value = ta.value.slice(0, sugg.start) + insert + ' ' + ta.value.slice(ta.selectionStart);
    const at = sugg.start + insert.length + 1;
    ta.setSelectionRange(at, at);
    closeSuggest(); update(); ta.focus();
  };

  ta.addEventListener('input', () => {
    autosize(); update(); checkSuggest();
    drafts.set(key() + (threadId() || ''), ta.value);
    const kk = key();
    if (ta.value && Date.now() - lastTypingSent > 3000 && !threadId()) {
      lastTypingSent = Date.now();
      socket.emit('typing', kk.startsWith('c:') ? { channelId: kk.slice(2) } : { dmId: kk.slice(2) });
    }
  });
  ta.addEventListener('keydown', (e) => {
    if (!suggest.hidden && sugg.items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sugg.i = (sugg.i + 1) % sugg.items.length; return drawSuggest(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sugg.i = (sugg.i - 1 + sugg.items.length) % sugg.items.length; return drawSuggest(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(sugg.i); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeSuggest(); }
    }
    const enterSends = P.chat.enterToSend;
    if (e.key === 'Enter' && ((enterSends && !e.shiftKey) || (!enterSends && (e.ctrlKey || e.metaKey)))) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape' && state.replyTo) { e.preventDefault(); e.stopPropagation(); setReply(null); return; }
    if (e.key === 'ArrowUp' && !ta.value && id === 'main') {
      const store = S.msgs[key()];
      const last = store && [...store.list].reverse().find((m) => m.authorId === S.me.id && readable(m));
      if (last) { e.preventDefault(); S.editing = last.id; replaceMessageEl(last); }
    }
  });
  ta.addEventListener('blur', () => setTimeout(closeSuggest, 120));
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  function addFiles(list) {
    const max = (S.config.maxUploadMb || 25) * 1024 * 1024;
    for (const f of list) {
      if (f.size > max) { toast(`${f.name} is larger than ${S.config.maxUploadMb || 25} MB.`, 'error'); continue; }
      if (state.pending.length >= 10) { toast('You can attach up to 10 files at once.', 'error'); break; }
      state.pending.push({ file: f, url: /^image\//.test(f.type) ? URL.createObjectURL(f) : null });
    }
    renderExtras(); update(); ta.focus();
  }
  function setReply(m) {
    const old = state.replyTo;
    state.replyTo = m;
    renderExtras();
    if (old) replaceMessageEl(old);
    if (m) { replaceMessageEl(m); ta.focus(); }
  }
  function renderExtras() {
    clear(extras);
    if (id === 'main') { const notice = keyNotice(); if (notice) extras.append(notice); }
    if (state.replyTo) {
      const ru = getUser(state.replyTo.authorId);
      extras.append(h('div', { class: 'reply-bar' }, icon('reply', 'ic'),
        h('span', { class: 'reply-bar-text' }, 'Replying to ', h('strong', null, displayName(ru)),
          h('span', { class: 'reply-bar-quote' }, (textOf(state.replyTo) || 'Attachment').slice(0, 120))),
        ibtn('close', 'Cancel reply (Esc)', () => setReply(null), { cls: 'sm' })));
    }
    if (state.pending.length) {
      extras.append(h('div', { class: 'pending-files' }, state.pending.map((p, i) => h('div', { class: 'pending' },
        p.url ? h('img', { src: p.url, alt: '' }) : h('div', { class: 'pending-ic' }, icon('file')),
        h('span', { class: 'pending-name', title: p.file.name }, p.file.name),
        h('span', { class: 'pending-size' }, fmtSize(p.file.size)),
        h('button', { class: 'pending-x', 'aria-label': `Remove ${p.file.name}`, 'data-tip': 'Remove', onclick: () => { if (p.url) URL.revokeObjectURL(p.url); state.pending.splice(i, 1); renderExtras(); update(); } }, icon('close'))))));
    }
    extras.append(h('div', { class: 'upload-progress', hidden: true }, h('div', { class: 'bar' })));
    const blockedNote = blockedDmNotice();
    const kk = key();
    const ch = kk && kk.startsWith('c:') ? channelById(kk.slice(2)) : null;
    const noSend = ch && !canIn(ch, threadId() ? PERMS.CREATE_THREADS : PERMS.SEND_MESSAGES);
    ta.disabled = !!blockedNote || !!noSend;
    box.querySelector('.attach').hidden = !!ch && !canIn(ch, PERMS.ATTACH_FILES);
    if (blockedNote) extras.append(blockedNote);
    if (noSend) extras.append(h('div', { class: 'key-bar' }, icon('lock'), h('span', null, threadId() ? 'You can read this thread but not reply.' : `You can read #${ch.name} but you don\u2019t have permission to send messages here.`)));
    ta.placeholder = noSend ? 'Read only' : placeholder || placeholderFor(kk);
    slowNote.hidden = !(ch && ch.slowmode > 0 && !canIn(ch, PERMS.MANAGE_MESSAGES));
    if (!slowNote.hidden && !slowUntil) slowNote.textContent = `Slowmode is on: one message every ${fmtDuration(ch.slowmode)}`;
    update();
  }
  async function send(overrideText) {
    const text = overrideText != null ? overrideText : ta.value;
    const files = overrideText != null ? [] : state.pending.slice();
    if (!text.trim() && !files.length) return;
    if (S.sending) return;
    const kk = key();
    S.sending = true;
    sendBtn.disabled = true;
    const bar = extras.querySelector('.upload-progress');
    const setProgress = (f) => { if (!bar) return; bar.hidden = f >= 1; bar.firstChild.style.width = Math.round(f * 100) + '%'; };
    try {
      const f = await uploadEncryptedFiles(kk, files, setProgress);
      await sendTo(kk, threadId(), { t: text, f }, state.replyTo ? state.replyTo.id : null);
      playSound('sent');
      if (overrideText == null) {
        ta.value = '';
        drafts.delete(kk + (threadId() || ''));
        files.forEach((p) => p.url && URL.revokeObjectURL(p.url));
        state.pending = [];
      }
      const old = state.replyTo;
      state.replyTo = null;
      if (old) replaceMessageEl(old);
      renderExtras(); autosize();
      const sch = kk.startsWith('c:') ? channelById(kk.slice(2)) : null;
      if (sch && sch.slowmode > 0 && !canIn(sch, PERMS.MANAGE_MESSAGES)) startSlow(sch.slowmode);
      if (id === 'main') { const sc = $('#messages'); if (sc) sc.scrollTop = sc.scrollHeight; }
    } catch (e) {
      const wait = /in (\d+)s/.exec(e.message || '');
      if (e.code === 'slowmode' && wait) startSlow(+wait[1]);
      toast(e.message, 'error');
    } finally { S.sending = false; setProgress(1); update(); }
  }
  setTimeout(() => { autosize(); update(); }, 0);
  return { el, state, focus: () => ta.focus(), addFiles, setReply, renderExtras, send };
}
const fmtDuration = (sec) => (sec >= 3600 ? `${Math.round(sec / 3600)}h` : sec >= 60 ? `${Math.round(sec / 60)}m` : `${sec}s`);
function placeholderFor(k) {
  if (!k) return 'Message';
  if (k.startsWith('d:')) { const d = S.dms.find((x) => x.id === k.slice(2)); return d ? `Message ${displayName(getUser(d.userId))}` : 'Message'; }
  const s = serverOfChannel(k.slice(2));
  if (isGroup(s)) return `Message ${groupName(s)}`;
  const c = channelById(k.slice(2));
  return c ? `Message #${c.name}` : 'Message';
}
function insertAtCursor(ta, text) {
  const s = ta.selectionStart; const e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.setSelectionRange(s + text.length, s + text.length);
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}
// A bar above the composer when we can't encrypt here yet (or shouldn't).
function keyNotice() {
  if (S.view.type === 'dm') {
    const d = S.dms.find((x) => x.id === S.view.dmId);
    const u = d && getUser(d.userId);
    if (u && sec.keyChanged(u)) {
      return h('div', { class: 'key-bar bad' }, icon('shield'),
        h('span', null, `${displayName(u)}'s security key changed. Sending is paused until you verify it.`),
        h('button', { class: 'btn sm ghost', onclick: () => openSafetyNumber(u) }, 'Verify'));
    }
    return null;
  }
  if (S.view.type !== 'channel') return null;
  const st = sec.stateOf(S.view.serverId);
  if (!st || sec.currentKey(S.view.serverId) || st.needsRotation || !st.keyEpoch) return null;
  return h('div', { class: 'key-bar' }, h('span', { class: 'spinner' }),
    h('span', null, 'Waiting for another member to come online and share this conversation\u2019s encryption key with you.'));
}
function blockedDmNotice() {
  if (S.view.type !== 'dm') return null;
  const d = S.dms.find((x) => x.id === S.view.dmId);
  if (!d || !S.blocked.has(d.userId)) return null;
  return h('div', { class: 'key-bar' }, icon('ban'), h('span', null, `You blocked ${displayName(getUser(d.userId))}.`),
    h('button', { class: 'btn sm ghost', onclick: () => toggleBlock(d.userId, false) }, 'Unblock'));
}

// ---- sending (every file gets its own random key, carried inside the encrypted message)
async function uploadEncryptedFiles(key, files, onProgress) {
  if (!files.length) return [];
  if (key.startsWith('c:')) await sec.ready(serverOfChannel(key.slice(2)).id);
  const compress = P.chat.compressImages !== false;
  // Optimize images first (resize big photos, make thumbnails), then encrypt and upload.
  const prepared = [];
  for (const p of files) prepared.push({ ...(await prepareImage(p.file, { compress })), orig: p.file });
  const total = prepared.reduce((a, p) => a + p.file.size + (p.thumb ? p.thumb.size : 0), 0) || 1;
  let done = 0;
  onProgress(0);
  const send = async (blobLike, weight) => {
    const { blob, k } = await E2EE.encryptFile(await blobLike.arrayBuffer());
    const fd = new FormData();
    fd.append('file', new Blob([blob]), 'blob.bin');
    const res = await upload('/upload/encrypted', fd, (x) => onProgress((done + x * weight) / total));
    done += weight;
    return { url: res.url, k };
  };
  const out = [];
  for (const p of prepared) {
    const th = p.thumb ? await send(p.thumb, p.thumb.size) : null;
    const main = await send(p.file, p.file.size);
    out.push({ url: main.url, name: p.file.name, type: p.file.type, size: p.file.size, k: main.k, ...(p.w ? { w: p.w, h: p.h } : {}), ...(th ? { th: { url: th.url, k: th.k } } : {}) });
  }
  return out;
}

function mentionedIds(server, text) {
  const t = String(text || '');
  const names = new Set([...t.matchAll(/(?:^|\s)@([\w.]{2,24})/g)].map((m) => m[1].toLowerCase()));
  const roleIds = new Set([...t.matchAll(/<@&([a-z0-9]{6,40})>/g)].map((m) => m[1]));
  if (!names.size && !roleIds.size) return [];
  return server.memberIds.filter((id) => id !== S.me.id && (names.has((getUser(id).username || '').toLowerCase())
    || ((server.memberRoles || {})[id] || []).some((r) => roleIds.has(r))));
}

async function sendTo(key, threadId, payload, replyTo) {
  const files = (payload.f || []).flatMap((x) => [x.url, x.th && x.th.url]).filter(Boolean);
  if (key.startsWith('c:')) {
    const channelId = key.slice(2);
    const server = serverOfChannel(channelId);
    if (!server) throw new Error('Channel not found.');
    await withKeyRetry(server.id, async () => {
      const { ciphertext, epoch } = await sec.encryptChannel(server.id, channelId, payload);
      await api('POST', `/channels/${channelId}/messages`, { ciphertext, epoch, replyTo, threadId, files, mentions: mentionedIds(server, payload.t) });
    });
  } else {
    const ciphertext = await sec.encryptDm(key.slice(2), payload);
    await api('POST', `/dms/${key.slice(2)}/messages`, { ciphertext, replyTo, files });
  }
}

// ======================================================================= emoji + GIF pickers
function emojiPicker(anchor, onPick, { keepOpen = false } = {}) {
  const search = h('input', { class: 'input emoji-search', placeholder: 'Search emoji', 'aria-label': 'Search emoji' });
  const grid = h('div', { class: 'emoji-grid', role: 'listbox' });
  const tabs = h('div', { class: 'emoji-tabs', role: 'tablist' });
  const preview = h('div', { class: 'emoji-preview' });
  const custom = allEmojis();
  // Custom emoji from every server you're in can be used anywhere.
  const serverSections = S.servers.filter((sv) => (sv.emojis || []).length).map((sv) => [sv.name, sv.emojis.map((e) => ({ ...e, serverName: sv.name })), sv]);
  const sections = [['Frequently used', recentEmoji()], ...serverSections, ...Object.entries(EMOJI)].filter(([, l]) => l.length);
  const pick = (val) => { pushRecentEmoji(val); onPick(val); if (!keepOpen) closePopover(); };
  const btn = (e) => {
    const isCustom = typeof e === 'object';
    const token = isCustom ? emojiToken(e) : e;
    const node = isCustom ? h('img', { class: 'cemoji', src: e.url, alt: `:${e.name}:`, loading: 'lazy' }) : (token.startsWith('<') ? emojiNode(token) : token);
    const label = isCustom ? `:${e.name}:` : token.startsWith('<') ? token.replace(/^<a?(:[^:]+:).*$/, '$1') : (EMOJI_NAMES.get(e) || '').split(' ')[0];
    return h('button', {
      class: 'emoji-btn', role: 'option', 'aria-label': label, onclick: () => pick(token),
      onmouseenter: () => { clear(preview).append(h('span', { class: 'ep-big' }, isCustom ? h('img', { class: 'cemoji', src: e.url, alt: '' }) : node.cloneNode ? node.cloneNode(true) : node), h('span', null, label), isCustom ? h('span', { class: 'ep-src' }, e.serverName) : null); },
    }, node);
  };
  const slug = (n) => 'ecat-' + n.replace(/[^A-Za-z0-9]/g, '');
  const drawAll = () => {
    clear(grid);
    sections.forEach(([name, list]) => grid.append(h('div', { class: 'emoji-cat', id: slug(name) }, name), ...list.map(btn)));
  };
  sections.forEach(([name, , sv]) => tabs.append(h('button', {
    class: 'emoji-tab', role: 'tab', 'data-tip': name, 'aria-label': name,
    onclick: () => { search.value = ''; drawAll(); const t = grid.querySelector('#' + slug(name)); if (t) grid.scrollTop = t.offsetTop - grid.offsetTop; },
  }, name === 'Frequently used' ? icon('star') : sv ? (sv.icon ? h('img', { class: 'emoji-tab-img', src: sv.icon, alt: '' }) : h('span', { class: 'emoji-tab-txt' }, sv.name.slice(0, 2))) : CATEGORY_ICONS[name])));
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return drawAll();
    clear(grid);
    const r = [...custom.filter((e) => e.name.toLowerCase().includes(q)), ...searchEmoji(q)];
    if (!r.length) grid.append(h('p', { class: 'muted-p' }, 'No emoji found.'));
    r.forEach((e) => grid.append(btn(e)));
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = grid.querySelector('.emoji-btn'); if (first) first.click(); } });
  drawAll();
  popover(anchor, h('div', { class: 'emoji-picker' }, h('div', { class: 'emoji-top' }, search), tabs, grid, preview), { side: 'top', align: 'end' });
  setTimeout(() => search.focus(), 20);
}

// GIF picker: GIFs / Stickers / Favorites, categories + trending, infinite scroll. Reused for "emoji from GIPHY".
const GIF_FAVS = 'hearth.gifFavs';
const gifFavs = () => LS.get(GIF_FAVS, []);
function gifPanel({ onPick, startTab = 'gifs', height = 440 } = {}) {
  let tab = startTab;
  let q = '';
  let next = null;
  let loading = false;
  let reqId = 0;
  const provName = S.config.gifProvider === 'giphy' ? 'GIPHY' : 'KLIPY';
  const input = h('input', { class: 'input', placeholder: `Search ${provName}`, 'aria-label': 'Search GIFs' });
  const seg = h('div', { class: 'seg' });
  const grid = h('div', { class: 'gif-grid', role: 'listbox' });
  const status = h('div', { class: 'gif-status' });
  const tile = (g) => {
    const fav = gifFavs().some((x) => x.id === g.id);
    return h('div', { class: 'gif-btn', role: 'option', tabindex: '0', 'aria-label': g.title || 'GIF',
      onclick: () => onPick(g), onkeydown: (e) => { if (e.key === 'Enter') onPick(g); } },
    h('img', { src: mediaUrl(g.preview), alt: '', loading: 'lazy', style: { aspectRatio: `${g.width} / ${g.height}` } }),
    h('button', { class: `gif-fav${fav ? ' on' : ''}`, 'aria-label': fav ? 'Remove from favorites' : 'Add to favorites', 'data-tip': fav ? 'Unfavorite' : 'Favorite',
      onclick: (e) => {
        e.stopPropagation();
        const list = gifFavs();
        const has = list.some((x) => x.id === g.id);
        LS.set(GIF_FAVS, has ? list.filter((x) => x.id !== g.id) : [g, ...list].slice(0, 100));
        e.currentTarget.classList.toggle('on', !has);
        if (tab === 'favs') draw();
      } }, icon('star')));
  };
  const showError = (msg) => {
    clear(grid);
    status.textContent = '';
    grid.append(h('div', { class: 'gif-empty' }, h('p', null, msg),
      S.me && S.me.instanceAdmin && /set up|key/i.test(msg) ? h('button', { class: 'btn primary sm', onclick: () => { closePopover(); openSettings(app, 'instance'); } }, 'Set up GIF search') : null));
  };
  const load = async (more = false) => {
    if (loading || (more && next == null)) return;
    loading = true;
    const id = ++reqId;
    if (!more) { clear(grid); status.textContent = ''; grid.append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' }))); }
    try {
      const res = await api('GET', `/gifs?type=${tab === 'stickers' ? 'stickers' : 'gifs'}&q=${encodeURIComponent(q)}&offset=${more ? encodeURIComponent(next) : ''}`);
      if (id !== reqId) return;
      if (!more) clear(grid);
      res.items.forEach((g) => grid.append(tile(g)));
      next = res.nextOffset;
      if (!more && !res.items.length) grid.append(h('div', { class: 'gif-empty' }, h('p', null, 'No results. Try another word.')));
    } catch (e) { if (id === reqId) showError(e.message); } finally { loading = false; }
  };
  const categories = async () => {
    const id = ++reqId;
    clear(grid).append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
    try {
      const cats = await api('GET', '/gifs/categories');
      if (id !== reqId) return;
      clear(grid);
      grid.append(h('button', { class: 'gif-cat trending', onclick: () => { q = ''; tab = 'gifs'; draw(true); } }, icon('arrowUp'), h('span', null, 'Trending')));
      cats.forEach((c) => grid.append(h('button', { class: 'gif-cat', onclick: () => { input.value = c.name; q = c.name; draw(); } },
        h('img', { src: mediaUrl(c.preview), alt: '', loading: 'lazy' }), h('span', null, c.name))));
    } catch (e) { if (id === reqId) showError(e.message); }
  };
  const draw = (trending = false) => {
    clear(seg);
    [['gifs', 'GIFs'], ['stickers', 'Stickers'], ['favs', '\u2605 Favorites']].forEach(([k, l]) => seg.append(h('button', { class: `seg-btn${tab === k ? ' active' : ''}`, onclick: () => { tab = k; draw(); } }, l)));
    grid.classList.toggle('cats', tab === 'gifs' && !q && !trending);
    if (tab === 'favs') {
      reqId++;
      clear(grid);
      const favs = gifFavs().filter((g) => !q || (g.title || '').toLowerCase().includes(q.toLowerCase()));
      if (!favs.length) grid.append(h('div', { class: 'gif-empty' }, h('p', null, 'Star GIFs to keep them here. Favorites are saved on this device.')));
      favs.forEach((g) => grid.append(tile(g)));
      return;
    }
    if (tab === 'gifs' && !q && !trending) return categories();
    load();
  };
  input.addEventListener('input', debounce(() => { q = input.value.trim(); if (tab === 'favs') return draw(); draw(); }, 300));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = grid.querySelector('.gif-btn'); if (first) first.click(); } });
  grid.addEventListener('scroll', () => { if (tab !== 'favs' && grid.scrollTop + grid.clientHeight > grid.scrollHeight - 300) load(true); });
  if (!S.config.gifsEnabled) showError(S.me && S.me.instanceAdmin ? 'GIF search isn\u2019t set up yet. Add a free GIPHY key to turn it on for everyone.' : 'GIF search isn\u2019t turned on for this server yet. Ask the server admin to set it up.');
  else draw();
  setTimeout(() => input.focus(), 30);
  return h('div', { class: 'gif-picker', style: { height: height + 'px' } }, input, seg, grid, status, h('div', { class: 'gif-credit' }, `Powered by ${provName}`));
}
function gifPicker(anchor, onPick) {
  popover(anchor, gifPanel({ onPick: (g) => { closePopover(); onPick(g.url); } }), { side: 'top', align: 'end' });
}

// ======================================================================= global search (Ctrl+K)
// Messages are end-to-end encrypted, so the server can't search them. Search runs here, over messages
// this browser has decrypted, and can dig further back through a conversation on request.
function openSearch({ scope = null } = {}) {
  let tab = scope ? 'messages' : 'all';
  let scopeKey = scope;
  const input = h('input', { class: 'search-main', placeholder: scope ? 'Search this conversation' : 'Search messages, people, channels, servers', 'aria-label': 'Search' });
  const tabsEl = h('div', { class: 'seg' });
  const results = h('div', { class: 'search-results', role: 'listbox' });
  const scopeChip = h('div', { class: 'search-scope' });
  let sel = 0;
  let rows = [];
  let deepRunning = false;
  const go = (fn) => () => { mdl.close(); fn(); };

  const convoMessages = (key) => (S.msgs[key] ? S.msgs[key].list.filter(readable) : []);
  const allLoaded = () => Object.keys(S.msgs).flatMap((k) => convoMessages(k).map((m) => ({ m, key: k })));
  const matchMsg = (m, q, kind) => {
    const t = textOf(m).toLowerCase();
    const files = filesOf(m);
    if (kind === 'files') return files.length && (!q || files.some((f) => (f.name || '').toLowerCase().includes(q)));
    if (kind === 'links') return /https?:\/\//i.test(t) && (!q || t.includes(q));
    return q && (t.includes(q) || files.some((f) => (f.name || '').toLowerCase().includes(q)));
  };
  const snippet = (t, q) => {
    const i = q ? t.toLowerCase().indexOf(q) : -1;
    const s = i > 40 ? '\u2026' + t.slice(i - 40) : t;
    return s.slice(0, 180);
  };
  const highlight = (text, q) => {
    if (!q) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    const lower = text.toLowerCase();
    let i = 0;
    for (;;) {
      const j = lower.indexOf(q, i);
      if (j < 0) { frag.append(text.slice(i)); break; }
      frag.append(text.slice(i, j), h('mark', null, text.slice(j, j + q.length)));
      i = j + q.length;
    }
    return frag;
  };

  const draw = () => {
    clear(tabsEl);
    [['all', 'All'], ['messages', 'Messages'], ['people', 'People'], ['places', 'Channels & servers'], ['files', 'Files'], ['links', 'Links']].forEach(([k, l]) => tabsEl.append(
      h('button', { class: `seg-btn${tab === k ? ' active' : ''}`, onclick: () => { tab = k; sel = 0; draw(); input.focus(); } }, l)));
    clear(scopeChip);
    if (scopeKey) {
      const label = scopeKey.startsWith('d:') ? `In DM with ${displayName(getUser((S.dms.find((d) => d.id === scopeKey.slice(2)) || {}).userId))}` : (() => { const s = serverOfChannel(scopeKey.slice(2)); return isGroup(s) ? `In ${groupName(s)}` : `In #${(channelById(scopeKey.slice(2)) || {}).name}`; })();
      scopeChip.append(h('span', { class: 'chip active' }, label, h('button', { class: 'chip-x', 'aria-label': 'Search everywhere', onclick: () => { scopeKey = null; draw(); } }, icon('close'))));
    }
    const q = input.value.trim().toLowerCase();
    clear(results);
    rows = [];
    const add = (section, items) => {
      if (!items.length) return;
      results.append(h('div', { class: 'search-sec' }, section));
      items.forEach((it) => { const i = rows.length; rows.push(it); results.append(it.el(i)); });
    };
    const item = (opts) => (i) => h('button', {
      class: `search-item${i === sel ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === sel),
      onclick: opts.action, onmouseenter: () => { sel = i; [...results.querySelectorAll('.search-item')].forEach((b, n) => b.classList.toggle('active', n === sel)); },
    }, opts.av, h('span', { class: 'search-item-text' }, h('span', { class: 'search-item-title' }, opts.title), opts.sub ? h('span', { class: 'search-item-sub' }, opts.sub) : null), opts.meta ? h('span', { class: 'search-item-meta' }, opts.meta) : null);

    if (!scopeKey && (tab === 'all' || tab === 'people')) {
      const people = Object.values(S.users).filter((u) => u.id !== S.me.id && (!q || u.username.toLowerCase().includes(q) || displayName(u).toLowerCase().includes(q)))
        .sort((a, b) => displayName(a).localeCompare(displayName(b))).slice(0, tab === 'all' ? 5 : 30);
      add('People', people.map((u) => ({ el: item({ av: avatarEl(u, 30, { status: true, meId: S.me.id }), title: displayName(u), sub: u.username, action: go(() => openDmWith(u.id)) }), action: go(() => openDmWith(u.id)) })));
    }
    if (!scopeKey && (tab === 'all' || tab === 'places')) {
      const places = [];
      realServers().forEach((s) => {
        if (!q || s.name.toLowerCase().includes(q)) places.push({ av: s.icon ? h('img', { class: 'search-img', src: s.icon, alt: '' }) : h('span', { class: 'search-ic' }, s.name.slice(0, 2)), title: s.name, sub: 'Server', action: go(() => openServer(s.id)) });
        s.channels.forEach((c) => { if (!q || c.name.toLowerCase().includes(q)) places.push({ av: h('span', { class: 'search-ic' }, icon(channelIcon(c))), title: c.name, sub: s.name, action: go(() => (c.type === 'voice' ? joinVoice(c, s) : openChannel(c.id, s.id))) }); });
      });
      groups().forEach((g) => { if (!q || groupName(g).toLowerCase().includes(q)) places.push({ av: groupAvatar(g, 30), title: groupName(g), sub: 'Group', action: go(() => openGroup(g.id)) }); });
      add('Channels & servers', places.slice(0, tab === 'all' ? 6 : 50).map((p) => ({ el: item(p), action: p.action })));
    }
    if (['all', 'messages', 'files', 'links'].includes(tab) && (q || tab === 'files' || tab === 'links')) {
      const kind = tab === 'files' ? 'files' : tab === 'links' ? 'links' : 'text';
      const pool = scopeKey ? convoMessages(scopeKey).map((m) => ({ m, key: scopeKey })) : allLoaded();
      const hits = pool.filter(({ m }) => matchMsg(m, q, kind)).sort((a, b) => b.m.createdAt - a.m.createdAt).slice(0, tab === 'all' ? 8 : 60);
      add(tab === 'files' ? 'Files' : tab === 'links' ? 'Links' : 'Messages', hits.map(({ m, key }) => {
        const u = getUser(m.authorId);
        const files = filesOf(m);
        const t = kind === 'files' ? files.map((f) => f.name).join(', ') : snippet(textOf(m), q);
        const action = go(() => jumpToMessage(key, m.id));
        return { el: item({ av: avatarEl(u, 30), title: h('span', null, h('strong', null, displayName(u)), h('span', { class: 'search-where' }, ` \u00b7 ${whereLabel(m)}`)), sub: highlight(t, kind === 'files' ? '' : q), meta: fmtDay(m.createdAt), action }), action };
      }));
      if (!hits.length && q) results.append(h('div', { class: 'search-empty' }, 'No loaded messages match.'));
    }
    if (scopeKey && (tab === 'messages' || tab === 'files' || tab === 'links')) {
      const store = S.msgs[scopeKey];
      if (store && store.hasMore) {
        results.append(h('div', { class: 'search-deep' },
          h('span', null, `Searched ${store.list.length} messages decrypted on this device.`),
          h('button', { class: 'btn ghost sm', disabled: deepRunning, onclick: async (e) => {
            deepRunning = true; e.target.textContent = 'Decrypting older messages\u2026';
            for (let i = 0; i < 20 && S.msgs[scopeKey].hasMore; i++) await loadOlderQuiet(scopeKey);
            deepRunning = false; draw();
          } }, 'Search older history')));
      }
    }
    if (!rows.length && !q && tab === 'all') results.append(h('div', { class: 'search-empty' }, 'Type to search. Messages are searched on this device because the server can\u2019t read them.'));
    sel = Math.min(sel, Math.max(0, rows.length - 1));
  };
  input.addEventListener('input', debounce(() => { sel = 0; draw(); }, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); draw(); results.querySelector('.search-item.active')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); results.querySelector('.search-item.active')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter' && rows[sel]) { e.preventDefault(); rows[sel].action(); }
  });
  const mdl = modal({ size: 'search', className: 'search-modal', body: h('div', { class: 'search' },
    h('div', { class: 'search-bar' }, icon('search'), input, h('kbd', null, 'Esc')), scopeChip, tabsEl, results,
    h('div', { class: 'search-foot' }, h('span', null, h('kbd', null, '\u2191'), h('kbd', null, '\u2193'), ' to move'), h('span', null, h('kbd', null, 'Enter'), ' to open'), h('span', null, icon('lock', 'ic'), 'Searched privately on this device'))) });
  draw();
  input.focus();
  requestAnimationFrame(() => { if (document.activeElement !== input) input.focus(); });
}
// Load one older page into a store without touching the screen (for deep search).
async function loadOlderQuiet(key) {
  const store = S.msgs[key];
  if (!store || !store.hasMore || !store.list.length) return;
  const res = await api('GET', msgUrl(key) + `?before=${store.list[0].id}`);
  await Promise.all(res.messages.map(decryptMessage));
  store.list = [...res.messages, ...store.list];
  store.hasMore = res.hasMore;
  if (currentKey() === key) { const sc = $('#messages'); const prevH = sc.scrollHeight; const top = sc.scrollTop; renderMessages(false); sc.scrollTop = sc.scrollHeight - prevH + top; }
}

// ======================================================================= voice room
function voiceRoomView() {
  const wrap = h('div', { class: 'voice-room' });
  wrap.append(callStage(S.view.channelId));
  return wrap;
}
// The call room that belongs to a group DM (its built-in voice channel).
function callRoomFor(server) {
  if (!server || !isGroup(server)) return null;
  const c = server.channels.find((x) => x.type === 'voice');
  return c ? c.id : null;
}

// ======================================================================= profiles, blocking, verification
function relationshipActions(u) {
  const r = S.relationships[u.id];
  const out = [];
  if (u.id === S.me.id) {
    out.push(h('button', { class: 'btn primary sm', onclick: () => { closePopover(); openSettings(app, 'profile'); } }, icon('edit'), 'Edit profile'));
    return out;
  }
  out.push(h('button', { class: 'btn primary sm', onclick: () => { closePopover(); openDmWith(u.id); } }, icon('message'), 'Message'));
  if (!S.blocked.has(u.id)) {
    if (!r) out.push(h('button', { class: 'btn ghost sm', onclick: (e) => api('POST', '/friends', { username: u.username }).then(() => { e.target.textContent = 'Request sent'; e.target.disabled = true; }).catch((x) => toast(x.message, 'error')) }, icon('userPlus'), 'Add friend'));
    else if (r.direction === 'incoming') out.push(h('button', { class: 'btn ghost sm', onclick: () => api('POST', `/friends/${u.id}/accept`).then(closePopover).catch((x) => toast(x.message, 'error')) }, 'Accept request'));
    else if (r.direction === 'outgoing') out.push(h('button', { class: 'btn ghost sm', disabled: true }, 'Request sent'));
  }
  out.push(h('button', { class: 'icon-btn', 'aria-label': 'More', 'data-tip': 'More', 'data-pop-anchor': '', onclick: (e) => {
    const items = [
      { label: 'View full profile', icon: 'user', action: () => openProfileModal(u.id) },
      { label: 'Verify encryption', icon: 'shield', action: () => openSafetyNumber(u) },
      { label: 'Copy username', icon: 'copy', action: () => { copyText(u.username); toast('Copied.'); } },
      r && r.status === 'accepted' ? { label: 'Remove friend', icon: 'trash', action: () => api('DELETE', '/friends/' + u.id).catch((x) => toast(x.message, 'error')) } : null,
      '-', blockItem(u), { label: 'Report', icon: 'shield', danger: true, action: () => openReport({ user: u }) }];
    menu(e.currentTarget, items, { align: 'end' });
  } }, icon('more')));
  return out;
}
function blockItem(u) {
  const blocked = S.blocked.has(u.id);
  return { label: blocked ? 'Unblock' : 'Block', icon: 'ban', danger: !blocked, action: () => toggleBlock(u.id, !blocked) };
}
async function toggleBlock(userId, on) {
  const u = getUser(userId);
  if (on && !(await confirmDialog({ title: `Block ${displayName(u)}?`, text: 'They won\u2019t be able to message you or send friend requests, and their messages in servers are hidden behind a click. They aren\u2019t told.', confirm: 'Block', danger: true }))) return;
  try {
    await api(on ? 'POST' : 'DELETE', `/blocks/${userId}`);
    if (on) S.blocked.add(userId); else S.blocked.delete(userId);
    toast(on ? `${displayName(u)} is blocked.` : `${displayName(u)} is unblocked.`);
    renderAll();
  } catch (e) { toast(e.message, 'error'); }
}
function mutualServersEl(u) {
  if (u.id === S.me.id) return null;
  const mutual = realServers().filter((s) => s.memberIds.includes(u.id));
  if (!mutual.length) return null;
  return h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, `Mutual servers \u2014 ${mutual.length}`),
    h('div', { class: 'pc-mutuals' }, mutual.slice(0, 6).map((s) => h('button', { class: 'pc-mutual', onclick: () => { closePopover(); $$('.modal-backdrop').forEach((b) => b._close && b._close()); openServer(s.id); } }, s.icon ? h('img', { src: s.icon, alt: '' }) : h('span', null, s.name.slice(0, 1)), s.name))));
}
function openProfilePop(anchor, userId, side = 'right') {
  const u = getUser(userId);
  const card = profileCard(u, { meId: S.me.id, compact: true, actions: relationshipActions(u), mutual: mutualServersEl(u) });
  if (S.blocked.has(u.id)) card.prepend(h('div', { class: 'pc-blocked' }, icon('ban'), 'Blocked'));
  popover(anchor, card, { side, className: 'pop-profile' });
}
function topFriendsEl(u) {
  const ids = ((u.profile || {}).topFriends || []).filter((id) => S.users[id]);
  if (!ids.length) return null;
  return h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'Top friends'),
    h('div', { class: 'pc-friends' }, ids.map((id) => { const f = getUser(id); return h('button', { class: 'pc-friend', onclick: () => openProfileModal(id) }, avatarEl(f, 44), h('span', null, displayName(f))); })));
}
function openProfileModal(userId) {
  closePopover();
  const u = getUser(userId);
  const friendsInCommon = Object.values(S.relationships).filter((r) => r.status === 'accepted').map((r) => r.userId)
    .filter((id) => realServers().some((s) => s.memberIds.includes(id) && s.memberIds.includes(u.id)) && id !== u.id).slice(0, 8);
  modal({
    size: 'md', className: 'profile-modal',
    body: h('div', { class: 'profile-full' },
      profileCard(u, { meId: S.me.id, actions: relationshipActions(u), mutual: mutualServersEl(u), topFriends: topFriendsEl(u) }),
      friendsInCommon.length ? h('div', { class: 'pf-common' }, h('h3', null, 'People you both know'), h('div', { class: 'friend-chips' }, friendsInCommon.map((id) => { const f = getUser(id); return h('span', { class: 'friend-chip' }, avatarEl(f, 24), displayName(f)); }))) : null),
  });
}
async function openSafetyNumber(u) {
  try {
    const user = await sec.userWithKeys(u.id);
    const groupsN = await E2EE.safetyNumber(S.me, user);
    const changed = sec.keyChanged(user);
    modal({
      title: changed ? 'Security key changed' : 'Verify encryption',
      size: 'sm',
      body: h('div', { class: 'stack' },
        changed ? h('p', { class: 'key-bar bad' }, icon('shield'), h('span', null, `${displayName(user)}'s keys are different from the ones this browser saw before. That happens if someone \u2014 including whoever runs this server \u2014 tries to listen in. Only continue once the numbers match on both screens.`)) : null,
        h('p', { class: 'muted-p' }, `Compare these numbers with ${displayName(user)} in person or on a call. If they match on both screens, nobody \u2014 not even the server \u2014 can read or fake your messages.`),
        h('div', { class: 'safety' }, groupsN.map((g) => h('span', null, g)))),
      actions: [
        { label: changed ? 'Not now' : 'Close' },
        { label: changed ? 'Numbers match \u2014 trust new key' : 'Numbers match', kind: 'primary', action: () => {
          sec.acceptKeys(user);
          toast(`${displayName(user)} is verified on this device.`);
          renderHeader(); if (composers.main) composers.main.renderExtras();
          S.servers.filter((s) => s.memberIds.includes(user.id)).forEach((s) => sec.maintain(s.id));
        } },
      ],
    });
  } catch (e) { toast(e.message, 'error'); }
}
function openServerSecurity(server) {
  if (!server) return;
  const st = sec.stateOf(server.id) || { keyEpoch: 0, missing: [] };
  const holders = server.memberIds.length - (st.missing || []).length;
  const changed = server.memberIds.map(getUser).filter((u) => sec.keyChanged(u));
  const label = isGroup(server) ? 'this group' : server.name;
  modal({
    title: 'End-to-end encryption',
    size: 'sm',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted-p' }, `Messages and files in ${label} are encrypted on your device with a key that only members have. The server stores scrambled data it can\u2019t read, and every message is signed by its sender.`),
      h('p', { class: 'muted-p' }, 'When someone leaves or is removed, the key is replaced automatically so they can\u2019t read anything new.'),
      h('div', { class: 'kv' }, h('span', null, 'Key version'), h('strong', null, st.keyEpoch ? `#${st.keyEpoch}` : 'Not set up yet')),
      h('div', { class: 'kv' }, h('span', null, 'Members with the current key'), h('strong', null, `${Math.max(0, holders)} of ${server.memberIds.length}`)),
      changed.length ? h('p', { class: 'key-bar bad' }, icon('shield'), h('span', null, `Security key changed for ${changed.map(displayName).join(', ')}. Verify them from their profile before the key can be shared.`)) : null,
      h('p', { class: 'field-hint' }, 'To make sure nobody is impersonating a member, compare safety numbers with them from their profile (\u22ef \u2192 Verify encryption).')),
    actions: [
      { label: 'Close' },
      { label: 'Replace key now', kind: 'ghost', action: async () => { await sec.forceRotate(server.id); toast('New encryption key created and shared with every member.'); } },
    ],
  });
}

// ======================================================================= servers, groups, channels, invites
function serverMenuItems(server) {
  const admin = isAdmin(server);
  const fav = P.favorites.includes('s:' + server.id);
  const lvl = P.notify['s:' + server.id] || 'all';
  return [
    can(server, PERMS.CREATE_INVITE) ? { label: 'Invite people', icon: 'userPlus', action: () => openInvite(server) } : null,
    canManageServer(server) ? { label: 'Server settings', icon: 'gear', action: () => openServerSettings(server) } : null,
    canManageServer(server) && can(server, PERMS.MANAGE_ROLES) ? { label: 'Roles', icon: 'shield', action: () => openServerSettings(server, 'roles') } : null,
    { label: 'Members', icon: 'people', action: () => { if (S.view.serverId !== server.id) openServer(server.id); S.panel = 'members'; P.showMembers = true; renderAll(); } },
    { label: fav ? 'Remove from favorites' : 'Add to favorites', icon: 'star', action: () => toggleFavorite('s:' + server.id) },
    '-',
    { header: 'Notifications' },
    ...[['all', 'All messages'], ['mentions', 'Only @mentions'], ['muted', 'Muted']].map(([v, l]) => ({ label: l, checked: lvl === v, action: () => setNotify('s:' + server.id, v === 'all' ? 'default' : v) })),
    '-',
    admin ? { label: 'Create channel', icon: 'plus', action: () => openCreateChannel(server, 'text') } : null,
    admin ? { label: 'Create category', icon: 'folderPlus', action: () => openCreateCategory(server) } : null,
    { label: 'Encryption details', icon: 'lock', action: () => openServerSecurity(server) },
    { label: 'Mark server as read', icon: 'check', action: () => { server.channels.forEach((c) => { S.unread.delete('c:' + c.id); S.mentions.delete('c:' + c.id); }); renderAll(); } },
    !isOwner(server) ? '-' : null,
    !isOwner(server) ? { label: 'Leave server', icon: 'logout', danger: true, action: () => leaveServer(server) } : null,
  ];
}
async function leaveServer(server) {
  const group = isGroup(server);
  if (!(await confirmDialog({ title: group ? 'Leave group?' : `Leave ${server.name}?`, text: group ? 'You won\u2019t get its messages anymore unless someone adds you back.' : 'You can rejoin with an invite.', confirm: 'Leave', danger: true }))) return;
  try { await api('POST', `/servers/${server.id}/leave`); } catch (e) { toast(e.message, 'error'); }
}
function openAddServer() {
  const m = modal({
    title: 'Add a server', size: 'sm',
    body: h('div', { class: 'stack' },
      h('button', { class: 'choice', onclick: () => { m.close(); openCreateServer(); } }, icon('plus', 'ic choice-ic'), h('span', null, h('strong', null, 'Create my own'), h('span', null, 'Start a space for you and your friends.'))),
      h('button', { class: 'choice', onclick: () => { m.close(); openJoinModal(''); } }, icon('link', 'ic choice-ic'), h('span', null, h('strong', null, 'Join with an invite'), h('span', null, 'Paste an invite link or code from a friend.')))),
  });
}
function openCreateServer() {
  const name = h('input', { class: 'input', maxlength: '64', value: `${displayName(S.me)}'s place` });
  let iconFile = null;
  const preview = h('div', { class: 'icon-preview' }, icon('image'));
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: (e) => {
    iconFile = e.target.files[0];
    if (iconFile) clear(preview).append(h('img', { src: URL.createObjectURL(iconFile), alt: '' }));
  } });
  modal({
    title: 'Create a server', size: 'sm',
    body: h('div', { class: 'stack center' },
      h('button', { class: 'icon-upload', onclick: () => fileIn.click() }, preview, h('span', null, 'Upload an icon (GIFs work)')), fileIn,
      field('Server name', name)),
    actions: [
      { label: 'Back', action: () => openAddServer() },
      { label: 'Create', kind: 'primary', action: async () => {
        const fd = new FormData();
        fd.append('name', name.value);
        if (iconFile) fd.append('icon', iconFile);
        const s = await api('POST', '/servers', fd);
        if (!S.servers.find((x) => x.id === s.id)) S.servers.push(s);
        if (s.keyState) await sec.applyState(s.keyState);
        openServer(s.id);
      } },
    ],
  });
}
function parseInvite(v) {
  const m = String(v).trim().match(/(?:invite\/)?([A-Za-z0-9]{6,16})\/?$/);
  return m ? m[1] : '';
}
function openJoinModal(code) {
  const input = h('input', { class: 'input', placeholder: `${location.origin}/invite/abcd2345`, value: code ? `${location.origin}/invite/${code}` : '' });
  const preview = h('div', { class: 'invite-preview' });
  const look = async () => {
    clear(preview);
    const c = parseInvite(input.value);
    if (!c) return;
    try {
      const info = await api('GET', '/invites/' + c);
      preview.append(info.icon ? h('img', { src: info.icon, alt: '' }) : h('span', { class: 'ip-initial' }, [...info.name][0]),
        h('div', null, h('strong', null, info.name), h('span', null, `${info.memberCount} member${info.memberCount === 1 ? '' : 's'}${info.alreadyMember ? ' \u00b7 you\u2019re already in it' : ''}`)));
    } catch (e) { preview.append(h('span', { class: 'bad' }, e.message)); }
  };
  input.addEventListener('input', debounce(look, 300));
  modal({
    title: 'Join a server', size: 'sm',
    body: h('div', { class: 'stack' }, field('Invite link or code', input), preview),
    actions: [
      { label: 'Cancel' },
      { label: 'Join server', kind: 'primary', action: async () => {
        const c = parseInvite(input.value);
        if (!c) throw new Error('Paste an invite link or code.');
        const s = await api('POST', `/invites/${c}/join`);
        if (!S.servers.find((x) => x.id === s.id)) S.servers.push(s);
        if (s.keyState) await sec.applyState(s.keyState);
        openServer(s.id);
      } },
    ],
  });
  if (code) look();
}
function openInvite(server) {
  const out = h('input', { class: 'input mono', readonly: true, value: 'Creating\u2026', 'aria-label': 'Invite link' });
  const expires = h('select', { class: 'input' }, [['0', 'Never'], ['1', '1 hour'], ['24', '1 day'], ['168', '7 days']].map(([v, l]) => h('option', { value: v }, l)));
  const uses = h('select', { class: 'input' }, [['0', 'No limit'], ['1', '1 use'], ['5', '5 uses'], ['10', '10 uses'], ['25', '25 uses']].map(([v, l]) => h('option', { value: v }, l)));
  const make = async () => {
    try {
      const { code } = await api('POST', `/servers/${server.id}/invites`, { expiresHours: expires.value, maxUses: uses.value });
      out.value = `${location.origin}/invite/${code}`;
    } catch (e) { out.value = e.message; }
  };
  expires.onchange = make; uses.onchange = make;
  modal({
    title: `Invite people to ${server.name}`, size: 'sm',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted-p' }, 'Send this link to people. They need to be able to reach this computer or VPS.'),
      h('div', { class: 'row gap' }, out, h('button', { class: 'btn primary', onclick: async (e) => { await copyText(out.value); e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1500); } }, 'Copy')),
      h('div', { class: 'row gap' }, field('Expires after', expires), field('Max uses', uses))),
  });
  make();
}

// Server settings: Overview, Roles, Members, Danger zone — tabs inside one modal.
// Wait for the server's next live update (after a settings change) so screens redraw with fresh data.
const serverWaiters = new Map();
function nextServerUpdate(id, ms = 1500) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); serverWaiters.set(id, () => { clearTimeout(t); resolve(); }); });
}

// Server settings: overview, appearance, roles, members, emoji, bans, danger zone.
function openServerSettings(server, startTab = 'overview') {
  if (!server) return;
  const live = () => S.servers.find((s) => s.id === server.id) || server;
  const TABS = [
    ['overview', 'Overview', 'info', (s) => can(s, PERMS.MANAGE_SERVER)],
    ['appearance', 'Appearance', 'palette', (s) => can(s, PERMS.MANAGE_SERVER)],
    ['roles', 'Roles', 'shield', (s) => can(s, PERMS.MANAGE_ROLES)],
    ['members', 'Members', 'people', (s) => can(s, PERMS.MANAGE_ROLES) || can(s, PERMS.KICK_MEMBERS) || can(s, PERMS.BAN_MEMBERS)],
    ['emoji', 'Emoji', 'smile', (s) => can(s, PERMS.MANAGE_EMOJIS)],
    ['bans', 'Bans', 'ban', (s) => can(s, PERMS.BAN_MEMBERS)],
    ['danger', 'Danger zone', 'trash', (s) => isOwner(s)],
  ];
  const add = (el, ...kids) => el.append(...kids.filter((k) => k != null && k !== false));
  let tab = startTab;
  let roleSel = null;
  const nav = h('nav', { class: 'ss-nav' });
  const body = h('div', { class: 'ss-body' });
  const run = async (fn, okMsg) => {
    try { const wait = nextServerUpdate(server.id); await fn(); await wait; if (okMsg) toast(okMsg); draw(); } catch (e) { toast(e.message, 'error'); }
  };
  const draw = () => {
    const s = live();
    const allowed = TABS.filter(([, , , ok]) => ok(s));
    if (!allowed.some(([k]) => k === tab)) tab = allowed[0] ? allowed[0][0] : 'overview';
    clear(nav).append(...allowed.map(([k, l, ic]) => h('button', { class: `ss-tab${tab === k ? ' active' : ''}`, onclick: () => { tab = k; draw(); } }, icon(ic), l)));
    clear(body);
    ({ overview, appearance, roles, members, emoji, bans, danger })[tab](s);
  };

  function overview(s) {
    const th = s.theme || {};
    const name = h('input', { class: 'input', maxlength: '64', value: s.name });
    const desc = h('textarea', { class: 'input', rows: '3', maxlength: '300', placeholder: 'What is this server about?' });
    desc.value = s.description || '';
    const pickFile = (cb) => { const f = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', onchange: () => f.files[0] && cb(f.files[0]) }); f.click(); };
    const upload2 = (path, file, field = 'file') => { const fd = new FormData(); fd.append(field, file); return api('POST', path, fd); };
    add(body, h('h3', null, 'Overview'),
      h('div', { class: 'ss-icon-row' },
        s.icon ? h('img', { class: `ss-icon shape-${th.iconShape || 'rounded'}`, src: s.icon, alt: '' }) : h('span', { class: `ss-icon shape-${th.iconShape || 'rounded'}` }, s.name.slice(0, 2)),
        h('div', { class: 'stack tight' },
          h('button', { class: 'btn ghost sm', onclick: () => pickFile((f) => run(() => upload2(`/servers/${s.id}/icon`, f, 'icon'), 'Icon updated.')) }, 'Change icon (GIFs work)'),
          h('div', { class: 'chips' }, [['rounded', 'Rounded'], ['circle', 'Circle'], ['square', 'Square']].map(([v, l]) => h('button', {
            class: `chip${(th.iconShape || 'rounded') === v ? ' active' : ''}`, onclick: () => run(() => api('PATCH', `/servers/${s.id}`, { theme: { iconShape: v } })),
          }, l))))),
      field('Server name', name), field('Description', desc, 'Shown on invites and at the top of the server.'),
      h('div', null, h('button', { class: 'btn primary', onclick: () => run(() => api('PATCH', `/servers/${s.id}`, { name: name.value, description: desc.value }), 'Saved.') }, 'Save')),
      h('h3', null, 'Banner'),
      h('p', { class: 'muted-p' }, 'Shown above the channel list. Animated GIFs work.'),
      th.banner ? h('div', { class: 'ss-banner' }, h('img', { class: 'cropped', src: th.banner, alt: '', style: cropStyle(th.bannerCrop) })) : null,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn ghost sm', onclick: () => pickFile((f) => run(() => upload2(`/servers/${s.id}/media/banner`, f), 'Banner updated.')) }, th.banner ? 'Change banner' : 'Upload banner'),
        th.banner ? h('button', { class: 'btn ghost sm', onclick: () => openCropper({ src: th.banner, kind: 'banner', crop: th.bannerCrop, onSave: (crop) => run(() => api('PATCH', `/servers/${s.id}`, { theme: { bannerCrop: crop } }), 'Banner position saved.') }) }, 'Adjust') : null,
        th.banner ? h('button', { class: 'btn ghost sm', onclick: () => run(() => api('DELETE', `/servers/${s.id}/media/banner`)) }, 'Remove') : null));
  }

  function appearance(s) {
    const th = s.theme || {};
    const bg = { kind: 'none', colors: ['#120338', '#d53369', '#ffb347'], angle: 160, style: 'linear', dim: 0.25, ...(th.background || {}) };
    const save = (theme, msg) => run(() => api('PATCH', `/servers/${s.id}`, { theme }), msg);
    const accentIn = h('input', { type: 'color', class: 'color-in', value: th.accent || '#f2a541', 'aria-label': 'Server accent' });
    const welcome = h('textarea', { class: 'input', rows: '4', maxlength: '600', placeholder: 'Welcome! Read **#rules** and say hi in #general.' });
    welcome.value = th.welcome || '';
    const colorInputs = (bg.colors.length ? bg.colors : ['#120338', '#d53369']).concat(['#ffb347']).slice(0, 3).map((c, i) => h('input', { type: 'color', class: 'color-in', value: c, 'aria-label': `Gradient color ${i + 1}` }));
    const angle = h('input', { type: 'range', class: 'range', min: '0', max: '360', value: String(bg.angle || 160), 'aria-label': 'Gradient angle' });
    const dim = h('input', { type: 'range', class: 'range', min: '0', max: '80', value: String(Math.round((bg.dim ?? 0.25) * 100)), 'aria-label': 'Darken background' });
    const presetGrid = h('div', { class: 'bg-grid' }, BACKGROUNDS.filter((b) => !b.solid).map((b) => h('button', {
      class: `bg-tile${bg.kind === 'preset' && bg.preset === b.id ? ' active' : ''}`,
      onclick: () => save({ background: { ...bg, kind: 'preset', preset: b.id, dim: +dim.value / 100 } }),
    }, h('span', { class: 'bg-sw', style: { background: b.css } }), h('span', { class: 'bg-tile-name' }, b.name))));
    add(body, h('h3', null, 'Appearance'),
      h('p', { class: 'muted-p' }, 'Everyone sees this while they\u2019re in the server (unless they turned off server themes in their own settings).'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Accent color'),
        h('div', { class: 'row gap' }, accentIn,
          h('button', { class: 'btn ghost sm', onclick: () => save({ accent: accentIn.value }, 'Accent saved.') }, 'Use this color'),
          th.accent ? h('button', { class: 'btn ghost sm', onclick: () => save({ accent: '' }) }, 'Use each person\u2019s own') : null)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Background'),
        h('div', { class: 'chips' }, [['none', 'Their own'], ['preset', 'Preset'], ['gradient', 'Custom gradient'], ['image', 'Image']].map(([v, l]) => h('button', {
          class: `chip${bg.kind === v ? ' active' : ''}`,
          onclick: () => (v === 'image' ? (() => { const f = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', onchange: () => { const fd = new FormData(); fd.append('file', f.files[0]); run(() => api('POST', `/servers/${s.id}/media/background`, fd), 'Background updated.'); } }); f.click(); })()
            : v === 'preset' ? save({ background: { ...bg, kind: 'preset', preset: bg.preset || 'nebula' } }) : save({ background: { ...bg, kind: v } })),
        }, l)))),
      bg.kind === 'preset' ? presetGrid : null,
      bg.kind === 'gradient' ? h('div', { class: 'grad-builder' },
        h('div', { class: 'row gap' }, ...colorInputs),
        h('label', { class: 'slider-row' }, h('span', null, 'Angle'), angle, h('span', { class: 'counter' }, '')),
        h('div', null, h('button', { class: 'btn ghost sm', onclick: () => save({ background: { ...bg, kind: 'gradient', colors: colorInputs.map((c) => c.value), angle: +angle.value, three: true } }, 'Gradient saved.') }, 'Apply gradient'))) : null,
      bg.kind !== 'none' ? h('label', { class: 'slider-row' }, h('span', null, 'Darken'), dim, h('button', { class: 'btn ghost sm', onclick: () => save({ background: { ...bg, dim: +dim.value / 100 } }) }, 'Apply')) : null,
      h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, 'Color names by role'), h('span', { class: 'field-hint' }, 'People who haven\u2019t chosen their own name color show their top role\u2019s color.')),
        h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: th.roleColors !== false, onchange: (e) => save({ roleColors: e.target.checked }) }), h('span', { class: 'switch-track' }))),
      field('Welcome message', welcome, 'Shown at the top of every channel. Markdown works.'),
      h('div', null, h('button', { class: 'btn primary', onclick: () => save({ welcome: welcome.value }, 'Welcome message saved.') }, 'Save welcome message')));
  }

  function roles(s) {
    const myTop = s.ownerId === S.me.id ? Infinity : Math.max(0, ...memberRoles(s, S.me.id).map((r) => r.position));
    const list = (s.roleDefs || []).slice().sort((a, b) => b.position - a.position);
    if (!roleSel || !list.some((r) => r.id === roleSel)) roleSel = (list.find((r) => !r.everyone) || list[0] || {}).id;
    const sel = list.find((r) => r.id === roleSel);
    const editable = (r) => r.everyone || r.position < myTop;
    const move = (r, dir) => {
      const movable = list.filter((x) => !x.everyone && x.position < myTop);
      const i = movable.findIndex((x) => x.id === r.id); const j = i + dir;
      if (i < 0 || j < 0 || j >= movable.length) return;
      [movable[i], movable[j]] = [movable[j], movable[i]];
      run(() => api('POST', `/servers/${s.id}/roles/order`, { ids: movable.map((x) => x.id) }));
    };
    const side = h('div', { class: 'role-list' },
      h('button', { class: 'btn primary sm block', onclick: () => run(async () => { const r = await api('POST', `/servers/${s.id}/roles`, { name: 'new role', color: '#5c8dff' }); roleSel = r.id; }) }, icon('plus'), 'Create role'),
      ...list.map((r) => h('div', { class: `role-row${r.id === roleSel ? ' active' : ''}` },
        h('button', { class: 'role-pick', onclick: () => { roleSel = r.id; draw(); } },
          h('span', { class: 'role-dot', style: { background: r.color || 'var(--muted)' } }), r.icon ? h('span', null, r.icon) : null,
          h('span', { class: 'role-name' }, r.name), h('span', { class: 'role-count' }, r.everyone ? '' : String(Object.values(s.memberRoles || {}).filter((l) => l.includes(r.id)).length))),
        !r.everyone && editable(r) ? h('span', { class: 'role-move' }, ibtn('arrowUp', 'Move up', () => move(r, -1), { cls: 'sm' }), ibtn('arrowDown', 'Move down', () => move(r, 1), { cls: 'sm' })) : null)),
      h('p', { class: 'field-hint' }, 'Higher roles outrank lower ones. You can only edit roles below your own highest role.'));
    const editor = h('div', { class: 'role-editor' });
    if (sel) {
      const locked = !editable(sel);
      const d = { name: sel.name, color: sel.color, icon: sel.icon, hoist: sel.hoist, mentionable: sel.mentionable, permissions: sel.permissions };
      const nameIn = h('input', { class: 'input', maxlength: '32', value: d.name, disabled: sel.everyone || locked, oninput: (e) => { d.name = e.target.value; } });
      const iconIn = h('input', { class: 'input emoji-input', maxlength: '4', value: d.icon || '', placeholder: '\u2728', disabled: sel.everyone || locked, oninput: (e) => { d.icon = e.target.value; } });
      const swatches = ['#f2a541', '#ef5466', '#ff7ab6', '#b07cff', '#5c8dff', '#38c6d9', '#3fcf83', '#c4e05a', '#ffffff', ''];
      const swEl = h('div', { class: 'swatches' });
      const drawSw = () => clear(swEl).append(...swatches.map((c) => h('button', { class: `swatch${d.color === c ? ' active' : ''}${c ? '' : ' none'}`, style: c ? { background: c } : null, 'aria-label': c || 'No color', disabled: sel.everyone || locked, onclick: () => { d.color = c; drawSw(); } }, c ? null : icon('ban'))),
        h('input', { type: 'color', class: 'color-in', value: d.color || '#5c8dff', 'aria-label': 'Custom role color', disabled: sel.everyone || locked, oninput: (e) => { d.color = e.target.value; drawSw(); } }));
      drawSw();
      const tg = (label, hint, val, on) => h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, label), hint ? h('span', { class: 'field-hint' }, hint) : null),
        h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!val, disabled: locked, onchange: (e) => on(e.target.checked) }), h('span', { class: 'switch-track' })));
      const mine = myPerms(s);
      const permsEl = h('div', { class: 'perm-groups' }, PERM_GROUPS.map(([g, list2]) => h('div', { class: 'perm-group' }, h('div', { class: 'perm-group-label' }, g),
        ...list2.map(([k, label, hint]) => tg(label, hint + (has(mine, PERMS[k]) ? '' : ' (You don\u2019t have this yourself, so you can\u2019t give it.)'), has(d.permissions, PERMS[k]), (on) => { d.permissions = on ? d.permissions | PERMS[k] : d.permissions & ~PERMS[k]; })))));
      const holders = s.memberIds.filter((id) => ((s.memberRoles || {})[id] || []).includes(sel.id));
      const addSel = h('select', { class: 'input sm', 'aria-label': 'Add member to role' }, h('option', { value: '' }, 'Add member\u2026'),
        s.memberIds.filter((id) => !holders.includes(id)).map((id) => h('option', { value: id }, displayName(getUser(id)))));
      addSel.onchange = () => { const id = addSel.value; if (id) run(() => api('PUT', `/servers/${s.id}/members/${id}/roles`, { roleIds: [...((s.memberRoles || {})[id] || []), sel.id] })); };
      add(editor, 
        h('div', { class: 'role-editor-head' }, h('h3', null, sel.everyone ? '@everyone' : `Edit role \u2014 ${sel.name}`),
          locked ? h('span', { class: 'role-tag' }, 'Above your highest role') : null),
        sel.everyone ? h('p', { class: 'muted-p' }, 'Default permissions for everyone in the server. Other roles add to these.') : h('div', { class: 'stack' },
          h('div', { class: 'row gap' }, field('Role name', nameIn), field('Icon', iconIn)),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Color'), swEl),
          tg('Show separately in the member list', 'Members with this as their highest such role get their own section.', d.hoist, (v) => { d.hoist = v; }),
          tg('Allow anyone to @mention this role', 'People with "Mention @everyone" can always mention it.', d.mentionable, (v) => { d.mentionable = v; })),
        h('h3', null, 'Permissions'), permsEl,
        sel.everyone ? null : h('h3', null, `Members \u2014 ${holders.length}`),
        sel.everyone ? null : h('div', { class: 'role-members' },
          ...holders.map((id) => { const u = getUser(id); return h('span', { class: 'chip active' }, avatarEl(u, 20), displayName(u), locked ? null : h('button', { class: 'chip-x', 'aria-label': `Remove ${displayName(u)} from role`, onclick: () => run(() => api('PUT', `/servers/${s.id}/members/${id}/roles`, { roleIds: ((s.memberRoles || {})[id] || []).filter((x) => x !== sel.id) })) }, icon('close'))); }),
          locked ? null : addSel),
        locked ? null : h('div', { class: 'role-actions' },
          !sel.everyone ? h('button', { class: 'btn danger-ghost', onclick: async () => { if (await confirmDialog({ title: `Delete ${sel.name}?`, text: 'Everyone loses this role. This can\u2019t be undone.', confirm: 'Delete role', danger: true })) run(() => api('DELETE', `/roles/${sel.id}`), 'Role deleted.'); } }, 'Delete role') : h('span'),
          h('button', { class: 'btn primary', onclick: () => run(() => api('PATCH', `/roles/${sel.id}`, d), 'Role saved.') }, 'Save changes')));
    }
    add(body, h('div', { class: 'roles-layout' }, side, editor));
  }

  function members(s) {
    const q = h('input', { class: 'input search-input', placeholder: 'Search members' });
    const listEl = h('div', { class: 'stack tight' });
    const drawList = () => {
      clear(listEl);
      const term = q.value.trim().toLowerCase();
      s.memberIds.map(getUser).filter((u) => !term || u.username.toLowerCase().includes(term) || displayName(u).toLowerCase().includes(term)).forEach((u) => {
        const rs = memberRoles(s, u.id);
        add(listEl, h('div', { class: 'ss-row' }, avatarEl(u, 32, { status: true, meId: S.me.id }),
          h('span', { class: 'ss-row-name' }, nameEl(u, { roleColor: topColor(s, u.id) }), h('span', null, u.username + (s.ownerId === u.id ? ' \u00b7 Owner' : ''))),
          h('span', { class: 'role-chips' }, ...rs.map((r) => h('span', { class: 'role-chip', style: r.color ? { '--rc': r.color } : null }, r.icon ? r.icon + ' ' : '', r.name))),
          ibtn('more', 'Manage', (e) => menu(e.currentTarget, memberMenuItems(s, u), { align: 'end' }), { cls: 'sm', attrs: { 'data-pop-anchor': '' } })));
      });
    };
    q.addEventListener('input', drawList);
    drawList();
    add(body, h('h3', null, `Members \u2014 ${s.memberIds.length}`), h('div', { class: 'friends-search' }, icon('search'), q), listEl);
  }

  function emoji(s) {
    const list = s.emojis || [];
    const nameOf = (f) => f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32) || 'emoji';
    // Pick one or many images (animated GIF/WebP/PNG welcome), name them, upload them all.
    const queue = h('div', { class: 'emoji-queue' });
    const pending = [];
    const fileIn = h('input', { type: 'file', multiple: true, accept: 'image/png,image/gif,image/webp,image/jpeg', hidden: true, onchange: () => {
      for (const f of fileIn.files) {
        if (f.size > 2 * 1024 * 1024) { toast(`${f.name} is over 2 MB.`, 'error'); continue; }
        const item = { file: f, url: URL.createObjectURL(f), name: nameOf(f) };
        pending.push(item);
      }
      fileIn.value = '';
      drawQueue();
    } });
    const drawQueue = () => {
      clear(queue);
      pending.forEach((it, i) => queue.append(h('div', { class: 'emoji-admin pending-emoji' },
        h('img', { class: 'cemoji big', src: it.url, alt: '' }),
        h('input', { class: 'input sm', value: it.name, 'aria-label': 'Emoji name', oninput: (e) => { it.name = e.target.value; } }),
        ibtn('close', 'Remove', () => { URL.revokeObjectURL(it.url); pending.splice(i, 1); drawQueue(); }, { cls: 'sm' }))));
      if (pending.length) queue.append(h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: async () => {
        let ok = 0;
        for (const it of [...pending]) {
          const fd = new FormData(); fd.append('file', it.file); fd.append('name', it.name);
          try { await api('POST', `/servers/${s.id}/emojis`, fd); ok++; pending.splice(pending.indexOf(it), 1); URL.revokeObjectURL(it.url); } catch (e) { toast(`:${it.name}: \u2014 ${e.message}`, 'error'); }
        }
        if (ok) toast(`Added ${ok} emoji.`);
        await nextServerUpdate(s.id);
        draw();
      } }, `Upload ${pending.length} emoji`), h('span', { class: 'field-hint' }, 'Names can use letters, numbers and _')));
    };
    const fromGiphy = () => {
      let m;
      const panel = gifPanel({ startTab: 'stickers', height: 420, onPick: (g) => {
        m.close();
        const nameIn = h('input', { class: 'input', maxlength: '32', value: nameOf({ name: g.title || 'gif' }).toLowerCase().slice(0, 32) });
        modal({ title: 'Name your emoji', size: 'sm', body: h('div', { class: 'stack' }, h('div', { class: 'row gap' }, h('img', { class: 'cemoji big', src: mediaUrl(g.preview), alt: '' }), field('Name', nameIn))),
          actions: [{ label: 'Cancel' }, { label: 'Add emoji', kind: 'primary', action: () => run(() => api('POST', `/servers/${s.id}/emojis/from-giphy`, { gifId: g.id, name: nameIn.value }), `Added :${nameIn.value}:`) }] });
      } });
      m = modal({ title: 'Add an emoji from GIPHY', size: 'md', className: 'giphy-emoji', body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'Stickers make great emoji. A small version is saved to this server.'), panel) });
    };
    const animated = list.filter((e) => e.animated).length;
    add(body, h('h3', null, `Emoji \u2014 ${list.length} / 200`),
      h('p', { class: 'muted-p' }, `Members can use these in any server or DM and as reactions. PNG, JPG, GIF or WebP up to 2 MB \u2014 animated GIF, WebP and PNG keep moving. 128\u00d7128 looks best.${animated ? ` (${animated} animated)` : ''}`),
      h('div', { class: 'emoji-upload' },
        h('button', { class: 'btn primary', onclick: () => fileIn.click() }, icon('plus'), 'Upload emoji'),
        S.config.gifsEnabled ? h('button', { class: 'btn ghost', onclick: fromGiphy }, icon('gif'), 'Add from GIPHY') : null,
        h('span', { class: 'field-hint' }, 'You can pick several files at once.'), fileIn),
      queue,
      h('div', { class: 'emoji-admin-grid' }, list.map((e) => h('div', { class: 'emoji-admin' },
        h('img', { class: 'cemoji big', src: e.url, alt: '' }),
        h('input', { class: 'input sm', value: e.name, 'aria-label': 'Emoji name', onchange: (ev) => run(() => api('PATCH', `/emojis/${e.id}`, { name: ev.target.value })) }),
        e.animated ? h('span', { class: 'gif-badge', 'data-tip': 'Animated' }, 'GIF') : null,
        ibtn('trash', `Delete :${e.name}:`, () => run(() => api('DELETE', `/emojis/${e.id}`)), { cls: 'sm' })))));
    drawQueue();
  }

  async function bans(s) {
    add(body, h('h3', null, 'Bans'));
    const host = h('div', { class: 'stack tight' }, h('span', { class: 'spinner' }));
    add(body, host);
    try {
      const list = await api('GET', `/servers/${s.id}/bans`);
      clear(host);
      if (!list.length) add(host, h('p', { class: 'muted-p' }, 'No one is banned.'));
      list.forEach((b) => add(host, h('div', { class: 'ss-row' }, avatarEl(b.user, 30), h('span', { class: 'ss-row-name' }, displayName(b.user), h('span', null, b.reason || 'No reason given')),
        h('button', { class: 'btn ghost sm', onclick: () => api('DELETE', `/servers/${s.id}/bans/${b.user.id}`).then(() => { toast('Unbanned.'); draw(); }).catch((e) => toast(e.message, 'error')) }, 'Unban'))));
    } catch (e) { clear(host).append(h('p', { class: 'form-error' }, e.message)); }
  }

  function danger(s) {
    const transfer = h('select', { class: 'input' }, h('option', { value: '' }, 'Choose a member'),
      s.memberIds.filter((id) => id !== S.me.id).map((id) => h('option', { value: id }, `${displayName(getUser(id))} (${getUser(id).username})`)));
    add(body, h('h3', null, 'Danger zone'),
      h('div', { class: 'danger-zone' }, h('strong', null, 'Transfer ownership'), h('p', { class: 'muted-p' }, 'You\u2019ll keep your roles but lose owner powers.'),
        h('div', { class: 'row gap' }, transfer, h('button', { class: 'btn ghost', onclick: async () => {
          if (!transfer.value) return;
          if (await confirmDialog({ title: 'Transfer ownership?', text: 'You will lose owner controls for this server.', confirm: 'Transfer', danger: true })) run(() => api('POST', `/servers/${s.id}/transfer`, { userId: transfer.value }), 'Ownership transferred.');
        } }, 'Transfer'))),
      h('div', { class: 'danger-zone' }, h('strong', null, 'Delete server'), h('p', { class: 'muted-p' }, 'Deletes every channel, message and file. This can\u2019t be undone.'),
        h('div', null, h('button', { class: 'btn danger', onclick: async () => { if (await deleteServer(s)) mdl.close(); } }, 'Delete server'))));
  }

  const mdl = modal({ title: `${server.name} \u2014 server settings`, size: 'xl', className: 'server-settings', body: h('div', { class: 'ss' }, nav, body) });
  draw();
}

async function deleteServer(server) {
  if (!(await confirmDialog({ title: `Delete ${server.name}?`, text: 'This deletes every channel and message in it. This cannot be undone.', confirm: 'Delete server', danger: true }))) return false;
  try { await api('DELETE', `/servers/${server.id}`); return true; } catch (e) { toast(e.message, 'error'); return false; }
}
function categoryField(server, value) {
  const cats = orderedCategories(server);
  const input = h('input', { class: 'input', maxlength: '32', value: value || '', list: 'cat-options', placeholder: 'Text' });
  return { input, el: h('div', null, input, h('datalist', { id: 'cat-options' }, cats.map((c) => h('option', { value: c })))) };
}
function openCreateChannel(server, type, category) {
  let t = type;
  const name = h('input', { class: 'input', maxlength: '48', placeholder: type === 'text' ? 'new-channel' : 'Hangout' });
  const cat = categoryField(server, category || (type === 'voice' ? 'Voice' : 'Text'));
  const opt = (val, label, desc) => h('label', { class: 'radio-card' },
    h('input', { type: 'radio', name: 'ctype', value: val, checked: t === val, onchange: () => { t = val; } }),
    icon(val === 'text' ? 'hash' : 'speaker'), h('span', null, h('strong', null, label), h('span', null, desc)));
  modal({
    title: 'Create channel', size: 'sm',
    body: h('div', { class: 'stack' }, opt('text', 'Text', 'Messages, images, GIFs, files'), opt('voice', 'Voice', 'Talk together with your mic'), field('Channel name', name), field('Category', cat.el, 'Pick an existing category or type a new one.')),
    actions: [
      { label: 'Cancel' },
      { label: 'Create channel', kind: 'primary', action: async () => {
        const ch = await api('POST', `/servers/${server.id}/channels`, { name: name.value, type: t, category: cat.input.value.trim() });
        if (ch.type === 'text') openChannel(ch.id, server.id);
      } },
    ],
  });
  setTimeout(() => name.focus(), 30);
}
function openCreateCategory(server) {
  const name = h('input', { class: 'input', maxlength: '32', placeholder: 'Information' });
  const chan = h('input', { class: 'input', maxlength: '48', placeholder: 'announcements' });
  modal({
    title: 'Create category', size: 'sm',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'Categories group channels in the sidebar. Every category needs at least one channel.'),
      field('Category name', name), field('First channel', chan)),
    actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', action: async () => {
      if (!name.value.trim()) throw new Error('Give the category a name.');
      const ch = await api('POST', `/servers/${server.id}/channels`, { name: chan.value || 'general', type: 'text', category: name.value.trim() });
      openChannel(ch.id, server.id);
    } }],
  });
}
function openEditChannel(c, startTab = 'overview') {
  const server = serverOfChannel(c.id) || S.servers.find((s) => s.id === c.serverId);
  if (!server) return;
  let tab = can(server, PERMS.MANAGE_CHANNELS) ? startTab : 'perms';
  const fresh = () => (serverOfChannel(c.id) || server).channels.find((x) => x.id === c.id) || c;
  const ch0 = fresh();
  // Overrides being edited: [{ type, id, allow, deny }]; @everyone always listed first.
  let ovs = (ch0.overrides || []).map((o) => ({ ...o }));
  if (!ovs.some((o) => o.type === 'role' && o.id === server.id)) ovs.unshift({ type: 'role', id: server.id, allow: 0, deny: 0 });
  let selKey = `role:${server.id}`;
  const name = h('input', { class: 'input', maxlength: '48', value: ch0.name });
  const topic = h('textarea', { class: 'input', maxlength: '300', rows: '3', placeholder: 'What is this channel for?' });
  topic.value = ch0.topic || '';
  const cat = categoryField(server, ch0.category);
  const slow = h('select', { class: 'input' }, [[0, 'Off'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'], [21600, '6 hours']].map(([v, l]) => h('option', { value: String(v) }, l)));
  slow.value = String(ch0.slowmode || 0);
  const tabs = h('div', { class: 'seg' });
  const body = h('div', { class: 'stack' });
  const scoped = PERM_GROUPS.flatMap(([, l]) => l).filter(([k]) => (c.type === 'voice'
    ? ['VIEW_CHANNEL', 'CONNECT', 'SPEAK', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'CREATE_INVITE']
    : ['VIEW_CHANNEL', 'SEND_MESSAGES', 'CREATE_THREADS', 'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'CREATE_INVITE']).includes(k));
  const label = (o) => {
    if (o.type === 'member') return displayName(getUser(o.id));
    const r = (server.roleDefs || []).find((x) => x.id === o.id);
    return r ? (r.everyone ? '@everyone' : r.name) : 'Deleted role';
  };
  const draw = () => {
    clear(tabs);
    [['overview', 'Overview'], ['perms', 'Permissions']].filter(([k]) => k === 'perms' ? can(server, PERMS.MANAGE_ROLES) : can(server, PERMS.MANAGE_CHANNELS))
      .forEach(([k, l]) => tabs.append(h('button', { class: `seg-btn${tab === k ? ' active' : ''}`, onclick: () => { tab = k; draw(); } }, l)));
    clear(body);
    if (tab === 'overview') {
      body.append(field('Channel name', name), ...(c.type === 'text' ? [field('Topic', topic), field('Slowmode', slow, 'How long people wait between messages. Anyone with Manage Messages skips it.')] : []), field('Category', cat.el));
      return;
    }
    const sel = ovs.find((o) => `${o.type}:${o.id}` === selKey) || ovs[0];
    const addable = [
      ...(server.roleDefs || []).filter((r) => !ovs.some((o) => o.type === 'role' && o.id === r.id)).map((r) => ({ type: 'role', id: r.id, label: r.name })),
      ...server.memberIds.filter((id) => !ovs.some((o) => o.type === 'member' && o.id === id)).map((id) => ({ type: 'member', id, label: displayName(getUser(id)) })),
    ];
    const addSel = h('select', { class: 'input sm', 'aria-label': 'Add a role or member' }, h('option', { value: '' }, '+ Add role or member'),
      addable.map((a) => h('option', { value: `${a.type}:${a.id}` }, `${a.type === 'role' ? '\u25C6 ' : '\u25CF '}${a.label}`)));
    addSel.onchange = () => { const [type, id] = addSel.value.split(':'); if (!id) return; ovs.push({ type, id, allow: 0, deny: 0 }); selKey = `${type}:${id}`; draw(); };
    const state = (o, bit) => (o.allow & bit ? 'allow' : o.deny & bit ? 'deny' : 'inherit');
    const setState = (o, bit, v) => { o.allow &= ~bit; o.deny &= ~bit; if (v === 'allow') o.allow |= bit; if (v === 'deny') o.deny |= bit; draw(); };
    body.append(
      h('p', { class: 'muted-p' }, 'Override what roles or specific people can do in this channel. \u2713 allows, \u2715 denies, and / uses their normal role permissions.'),
      h('div', { class: 'ov-layout' },
        h('div', { class: 'ov-list' }, ...ovs.map((o) => h('div', { class: `role-row${`${o.type}:${o.id}` === `${sel.type}:${sel.id}` ? ' active' : ''}` },
          h('button', { class: 'role-pick', onclick: () => { selKey = `${o.type}:${o.id}`; draw(); } },
            o.type === 'member' ? avatarEl(getUser(o.id), 18) : h('span', { class: 'role-dot', style: { background: ((server.roleDefs || []).find((r) => r.id === o.id) || {}).color || 'var(--muted)' } }),
            h('span', { class: 'role-name' }, label(o))),
          o.type === 'role' && o.id === server.id ? null : ibtn('close', 'Remove override', () => { ovs = ovs.filter((x) => x !== o); selKey = `role:${server.id}`; draw(); }, { cls: 'sm' }))), addSel),
        h('div', { class: 'ov-perms' }, h('div', { class: 'perm-group-label' }, label(sel)),
          ...scoped.map(([k, l, hint]) => {
            const bit = PERMS[k]; const st = state(sel, bit);
            return h('div', { class: 'ov-row' }, h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, l), hint ? h('span', { class: 'field-hint' }, hint) : null),
              h('div', { class: 'tri', role: 'radiogroup', 'aria-label': l },
                h('button', { class: `tri-btn deny${st === 'deny' ? ' on' : ''}`, 'aria-label': 'Deny', 'data-tip': 'Deny', onclick: () => setState(sel, bit, 'deny') }, icon('close')),
                h('button', { class: `tri-btn${st === 'inherit' ? ' on' : ''}`, 'aria-label': 'Inherit', 'data-tip': 'Use role permissions', onclick: () => setState(sel, bit, 'inherit') }, '/'),
                h('button', { class: `tri-btn allow${st === 'allow' ? ' on' : ''}`, 'aria-label': 'Allow', 'data-tip': 'Allow', onclick: () => setState(sel, bit, 'allow') }, icon('check'))));
          }))));
  };
  modal({
    title: `${c.type === 'voice' ? '\uD83D\uDD0A' : '#'} ${ch0.name} \u2014 settings`, size: 'lg', className: 'channel-settings',
    body: h('div', { class: 'stack' }, tabs, body),
    actions: [
      can(server, PERMS.MANAGE_CHANNELS) ? { label: 'Delete channel', kind: 'danger-ghost', action: () => deleteChannel(c) } : null,
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', action: async () => {
        if (can(server, PERMS.MANAGE_CHANNELS)) await api('PATCH', `/channels/${c.id}`, { name: name.value, topic: topic.value, category: cat.input.value.trim(), slowmode: +slow.value });
        if (can(server, PERMS.MANAGE_ROLES)) await api('PUT', `/channels/${c.id}/overrides`, { overrides: ovs.filter((o) => o.allow || o.deny) });
        toast('Channel saved.');
      } },
    ].filter(Boolean),
  });
  draw();
}

async function deleteChannel(c) {
  if (await confirmDialog({ title: `Delete ${c.name}?`, text: 'All of its messages will be deleted too.', confirm: 'Delete channel', danger: true })) await api('DELETE', `/channels/${c.id}`).catch((e) => toast(e.message, 'error'));
}

// New DM or group (or add people to an existing group).
function openNewConversation(existingGroup = null) {
  const known = Object.values(S.users).filter((u) => u.id !== S.me.id && !S.blocked.has(u.id) && (!existingGroup || !existingGroup.memberIds.includes(u.id)));
  const picked = new Set();
  const input = h('input', { class: 'input', placeholder: 'Search people you know', 'aria-label': 'Search people' });
  const chips = h('div', { class: 'pick-chips' });
  const results = h('div', { class: 'quick-list' });
  const hint = h('p', { class: 'field-hint' });
  const draw = () => {
    clear(chips);
    picked.forEach((id) => { const u = getUser(id); chips.append(h('button', { class: 'chip active', onclick: () => { picked.delete(id); draw(); } }, displayName(u), icon('close'))); });
    clear(results);
    const q = input.value.trim().toLowerCase();
    const list = known.filter((u) => !q || u.username.toLowerCase().includes(q) || displayName(u).toLowerCase().includes(q)).slice(0, 40);
    if (!list.length) results.append(h('p', { class: 'muted-p' }, 'No one matches. You can message friends and anyone who shares a server with you.'));
    list.forEach((u) => results.append(h('button', { class: `quick-row${picked.has(u.id) ? ' picked' : ''}`, 'aria-pressed': String(picked.has(u.id)), onclick: () => { if (picked.has(u.id)) picked.delete(u.id); else if (picked.size < 9) picked.add(u.id); draw(); } },
      avatarEl(u, 30, { status: true, meId: S.me.id }), h('span', { class: 'quick-text' }, h('strong', null, displayName(u)), h('span', null, u.username)),
      h('span', { class: 'pick-box' }, picked.has(u.id) ? icon('check') : null))));
    hint.textContent = existingGroup ? 'Pick people to add.' : picked.size > 1 ? `Creates a group with ${picked.size} people. Up to 10 total.` : 'Pick one person for a DM, or several for a group.';
  };
  input.addEventListener('input', draw);
  const mdl = modal({
    title: existingGroup ? 'Add people' : 'New message', size: 'sm',
    body: h('div', { class: 'stack' }, input, chips, results, hint),
    actions: [{ label: 'Cancel' }, { label: existingGroup ? 'Add' : 'Start', kind: 'primary', action: async () => {
      const ids = [...picked];
      if (!ids.length) throw new Error('Pick at least one person.');
      if (existingGroup) { for (const id of ids) await api('POST', `/groups/${existingGroup.id}/members`, { userId: id }); return; }
      if (ids.length === 1) return openDmWith(ids[0]);
      const g = await api('POST', '/groups', { userIds: ids });
      if (!S.servers.find((x) => x.id === g.id)) S.servers.push(g);
      if (g.keyState) await sec.applyState(g.keyState);
      openGroup(g.id);
    } }],
  });
  draw();
  setTimeout(() => input.focus(), 30);
  return mdl;
}
function renameGroup(g) {
  const input = h('input', { class: 'input', maxlength: '64', value: g.name || '', placeholder: groupName(g) });
  modal({ title: 'Rename group', size: 'sm', body: field('Group name', input, 'Leave empty to show everyone\u2019s names.'),
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: () => api('PATCH', `/servers/${g.id}`, { name: input.value }) }] });
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) markRead(currentKey()); });

// ======================================================================= installable app (PWA), updates, push
let installPrompt = null;
let wantReload = false;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || !!window.hearthDesktop;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Installed. You can open it from your apps like any other program.'); });
async function installApp() {
  if (!installPrompt) return false;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  return outcome === 'accepted';
}
function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    const offer = (w) => {
      // A new version finished installing in the background: offer to switch.
      if (S.autoUpdating) { w.postMessage('skipWaiting'); return; }
      if (document.querySelector('.update-bar')) return;
      const bar = h('div', { class: 'update-bar', role: 'status' }, icon('arrowUp'), h('span', null, 'A new version of Hearth is ready.'),
        h('button', { class: 'btn primary sm', onclick: () => { wantReload = true; w.postMessage('skipWaiting'); } }, 'Reload'),
        ibtn('close', 'Later', () => bar.remove(), { cls: 'sm' }));
      document.body.append(bar);
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch(() => {});
  // Only reload when the person asked for the update — the very first install also fires this event.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (wantReload) { wantReload = false; location.reload(); } });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open' && e.data.url) {
      const hash = e.data.url.split('#')[1];
      if (hash) location.hash = hash;
    }
  });
}
const b64url = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
async function pushStatus() {
  if (!app.push.supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}
async function enablePush({ quiet = false } = {}) {
  if (!app.push.supported()) throw new Error(/iPhone|iPad/.test(navigator.userAgent) && !isStandalone() ? 'On iPhone and iPad, add Hearth to your Home Screen first, then turn this on from the app.' : 'This browser doesn\u2019t support push notifications.');
  if (Notification.permission !== 'granted') {
    if (quiet) return;
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site in your browser settings.');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api('GET', '/push/key');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(publicKey) });
  }
  await api('POST', '/push/subscribe', { subscription: sub.toJSON() });
  localStorage.setItem('hearth.push', 'on');
}
async function disablePush() {
  localStorage.setItem('hearth.push', 'off');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
}

// ======================================================================= Terms of Service
async function askToAcceptTerms() {
  if (document.querySelector('.terms-modal')) return;
  let t;
  try { t = await api('GET', '/terms'); } catch { return; }
  modal({
    title: 'Terms of Service', size: 'md', className: 'terms-modal', dismissable: false,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted-p' }, 'Please read and accept this server\u2019s terms to keep using it.'),
      h('div', { class: 'tos-text md', html: renderDoc(t.text) })),
    actions: [
      { label: 'Log out', action: () => logout() },
      { label: 'I agree', kind: 'primary', action: () => api('POST', '/terms/accept') },
    ],
  });
}

// ======================================================================= reporting
// Messages are end-to-end encrypted, so admins can only see what the reporter chooses to share from
// their own device. The dialog shows exactly what will be sent.
function openReport({ message, user, ctx = 'main' }) {
  const target = user || getUser(message.authorId);
  let category = '';
  const cats = h('div', { class: 'report-cats', role: 'radiogroup' }, Object.entries(CATEGORY_LABEL).map(([k, l]) => h('label', { class: 'radio-card sm' },
    h('input', { type: 'radio', name: 'rcat', value: k, onchange: () => { category = k; } }), h('span', null, l))));
  const details = h('textarea', { class: 'input', rows: '3', maxlength: '2000', placeholder: 'Anything that helps the admins understand (optional)' });
  let evidence = [];
  let includeContext = true;
  const preview = h('div', { class: 'evidence' });
  const drawPreview = () => {
    if (!message) return;
    const list = ctx === 'thread' ? threadList() : (S.msgs[keyOfMessage(message)] || { list: [] }).list;
    const i = list.findIndex((x) => x.id === message.id);
    const before = includeContext && i > 0 ? list.slice(Math.max(0, i - 4), i).filter(readable) : [];
    evidence = [...before, message].map((x) => ({ id: x.id, text: textOf(x), files: filesOf(x).map((f) => f.name), reported: x.id === message.id, authorId: x.authorId, createdAt: x.createdAt }));
    clear(preview).append(...evidence.map((e) => h('div', { class: `ev${e.reported ? ' reported' : ''}` }, avatarEl(getUser(e.authorId), 22),
      h('div', { class: 'ev-body' }, h('div', { class: 'ev-meta' }, h('strong', null, displayName(getUser(e.authorId))), h('span', null, fmtStamp(e.createdAt))),
        h('div', { class: 'ev-text', html: e.text ? md(e.text) : escapeText(e.files.length ? `[${e.files.join(', ')}]` : '') })))));
  };
  drawPreview();
  modal({
    title: message ? 'Report message' : `Report ${displayName(target)}`, size: 'md',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted-p' }, 'Reports go to this server\u2019s administrators. The person you report isn\u2019t told who reported them.'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'What\u2019s wrong?'), cats),
      field('Details', details),
      message ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'These messages will be shared with the admins'),
        h('label', { class: 'tos-check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { includeContext = e.target.checked; drawPreview(); } }), h('span', null, 'Include up to 4 earlier messages for context')),
        preview,
        h('p', { class: 'field-hint' }, 'Messages are end-to-end encrypted, so admins can only see what you share here.')) : null,
      h('p', { class: 'field-hint' }, 'In danger right now? Contact your local emergency services.')),
    actions: [
      { label: 'Cancel' },
      { label: 'Send report', kind: 'danger', action: async () => {
        if (!category) throw new Error('Pick what\u2019s wrong.');
        await api('POST', '/reports', {
          category, details: details.value, targetId: target.id,
          context: message ? { kind: 'message', messageId: message.id } : { kind: 'user' },
          evidence: evidence.map(({ id, text, files }) => ({ id, text, files })),
        });
        toast('Thanks \u2014 the admins have your report.');
        if (!S.blocked.has(target.id)) setTimeout(() => toggleBlock(target.id, true), 200); // offers to block them too
      } },
    ],
  });
}

// ======================================================================= calls: video, screen sharing, DM calls
// A "room" is a server voice channel id, or "dm:<dmId>" for a 1-to-1 DM call.
const dmRoom = (dmId) => 'dm:' + dmId;
const videoEls = new Map(); // reused <video> elements so tiles don't flicker on re-render
function videoEl(key, track, mirror) {
  let v = videoEls.get(key);
  if (!v) {
    v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = true; // sound comes through the call's audio elements
    v.className = 'cs-video';
    videoEls.set(key, v);
  }
  v.classList.toggle('mirror', !!mirror);
  const cur = v.srcObject && v.srcObject.getVideoTracks()[0];
  if (track && cur !== track) { v.srcObject = new MediaStream([track]); v.play().catch(() => {}); }
  if (!track && v.srcObject) v.srcObject = null;
  return v;
}
const stageSpotlight = new Map(); // room -> tile key
function roomTitle(room) {
  if (room.startsWith('dm:')) { const d = S.dms.find((x) => x.id === room.slice(3)); return d ? displayName(getUser(d.userId)) : 'Call'; }
  const c = channelById(room); const s = c && serverOfChannel(c.id);
  return s ? (isGroup(s) ? groupName(s) : c.name) : 'Call';
}
// Everyone's tiles for a room: a screen share tile (if sharing) and a camera/avatar tile per person.
function stageTiles(room) {
  const inCall = voice && voice.channelId === room;
  const tiles = [];
  for (const st of S.voice[room] || []) {
    const me = st.userId === S.me.id;
    const media = !inCall ? {} : me ? { cam: voice.camStream && voice.camStream.getVideoTracks()[0], screen: voice.screenStream && voice.screenStream.getVideoTracks()[0] } : voice.remoteMedia(st.userId);
    const u = getUser(st.userId);
    if (st.screen && media.screen) tiles.push({ key: `${st.userId}:screen`, u, st, kind: 'screen', track: media.screen, me });
    tiles.push({ key: `${st.userId}:cam`, u, st, kind: st.video && media.cam ? 'cam' : 'avatar', track: media.cam, me });
  }
  return tiles;
}
function tileEl(room, t, big) {
  const name = t.kind === 'screen' ? `${displayName(t.u)}\u2019s screen` : displayName(t.u);
  const el = h('div', {
    class: `cs-tile kind-${t.kind}${big ? ' big' : ''}${t.kind !== 'screen' && S.speaking.has(t.u.id) ? ' speaking' : ''}`,
    dataset: { speak: t.kind === 'screen' ? '' : t.u.id, key: t.key }, tabindex: '0',
    'aria-label': name, onclick: (e) => { if (e.target.closest('button')) return; stageSpotlight.set(room, stageSpotlight.get(room) === t.key ? null : t.key); renderCallStages(); },
  });
  if (t.kind === 'avatar') {
    if (t.u.banner) el.append(h('div', { class: 'vr-bg' }, h('img', { class: 'cropped', src: t.u.banner, alt: '', style: cropStyle(t.u.profile.bannerCrop) })));
    const av = avatarEl(t.u, big ? 96 : 64); av.dataset.speak = t.u.id;
    if (S.speaking.has(t.u.id)) av.classList.add('speaking');
    el.append(av);
  } else {
    const v = videoEl(t.key, t.track, t.me && t.kind === 'cam');
    el.append(v, h('div', { class: 'cs-tools' },
      document.pictureInPictureEnabled ? ibtn('external', 'Pop out (picture-in-picture)', () => v.requestPictureInPicture().catch(() => {}), { cls: 'sm' }) : null,
      ibtn('maximize', 'Fullscreen', () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen().catch(() => {})), { cls: 'sm' })));
  }
  const ps = !t.me && t.kind !== 'screen' && voice && voice.channelId === room ? voice.peerState(t.u.id) : null;
  if (ps === 'connecting') el.append(h('div', { class: 'cs-conn' }, h('span', { class: 'spinner' }), 'Connecting\u2026'));
  if (ps === 'failed') el.append(h('div', { class: 'cs-conn bad', 'data-tip': 'Their network or yours blocks direct calls. The server admin can fix this by setting up the call relay (scripts/setup-turn.sh).' }, icon('shield'), 'Can\u2019t connect'));
  el.append(h('div', { class: 'cs-name' }, t.kind === 'screen' ? icon('monitor', 'ic') : null, h('span', null, name),
    t.kind !== 'screen' && t.st.deafened ? icon('headphonesOff', 'ic flag') : t.kind !== 'screen' && t.st.muted ? icon('micOff', 'ic flag') : null));
  if (!t.me && t.kind !== 'screen' && voice && voice.channelId === room) {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const slider = h('input', { type: 'range', class: 'range', min: '0', max: '2', step: '0.05', value: String(voice.volumeFor(t.u.id)), 'aria-label': `Volume for ${displayName(t.u)}`, oninput: (ev) => voice.setVolume(t.u.id, +ev.target.value) });
      const pt = h('span', { style: { position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px' } }); document.body.append(pt);
      popover(pt, h('div', { class: 'menu vol-pop' }, h('div', { class: 'menu-header' }, `Volume \u2014 ${displayName(t.u)}`), slider), { side: 'bottom' });
      pt.remove();
    });
  }
  return el;
}
function callControls(room) {
  const inCall = voice && voice.channelId === room;
  if (!inCall) {
    return h('div', { class: 'cs-controls' },
      h('button', { class: 'btn primary', onclick: () => joinRoom(room) }, icon('phone'), 'Join call'),
      h('button', { class: 'btn ghost', onclick: () => joinRoom(room, { video: true }) }, icon('video'), 'Join with video'));
  }
  const camOn = !!voice.camStream; const scrOn = !!voice.screenStream;
  return h('div', { class: 'cs-controls' },
    h('button', { class: `round-btn${voice.muted ? ' off' : ''}`, 'data-tip': voice.muted ? 'Unmute' : 'Mute', 'aria-label': voice.muted ? 'Unmute' : 'Mute', onclick: () => { toggleMute(); renderCallStages(); } }, icon(voice.muted ? 'micOff' : 'mic')),
    h('button', { class: `round-btn${voice.deafened ? ' off' : ''}`, 'data-tip': voice.deafened ? 'Undeafen' : 'Deafen', 'aria-label': voice.deafened ? 'Undeafen' : 'Deafen', onclick: () => { toggleDeafen(); renderCallStages(); } }, icon(voice.deafened ? 'headphonesOff' : 'headphones')),
    h('button', { class: `round-btn${camOn ? ' on' : ''}`, 'data-tip': camOn ? 'Turn camera off' : 'Turn camera on', 'aria-label': camOn ? 'Turn camera off' : 'Turn camera on', 'aria-pressed': String(camOn), onclick: () => toggleCamera() }, icon(camOn ? 'video' : 'videoOff')),
    h('button', { class: `round-btn${scrOn ? ' on' : ''}`, 'data-tip': scrOn ? 'Stop sharing' : 'Share your screen', 'aria-label': scrOn ? 'Stop sharing your screen' : 'Share your screen', 'aria-pressed': String(scrOn), onclick: () => toggleScreen() }, icon('monitor')),
    h('button', { class: 'round-btn hang', 'data-tip': 'Leave call', 'aria-label': 'Leave call', onclick: () => { voice.leave(); playSound('selfLeave'); } }, icon('phoneOff')));
}
// The call area: a grid, or one big spotlighted tile (screen shares get it automatically) with the rest in a strip.
function callStage(room, { compact = false } = {}) {
  const el = h('section', { class: `call-stage${compact ? ' compact' : ''}`, dataset: { room }, 'aria-label': 'Call' });
  fillStage(el);
  return el;
}
function fillStage(el) {
  const room = el.dataset.room;
  const tiles = stageTiles(room);
  let spot = stageSpotlight.get(room);
  if (!tiles.some((t) => t.key === spot)) spot = (tiles.find((t) => t.kind === 'screen') || {}).key || null;
  const people = (S.voice[room] || []).length;
  const head = h('div', { class: 'cs-head' }, h('span', { class: 'cs-live' }, people ? `${people} in call` : 'Call'),
    el.classList.contains('compact') ? ibtn(el.classList.contains('tall') ? 'chevron' : 'maximize', el.classList.contains('tall') ? 'Smaller' : 'Bigger', () => { el.classList.toggle('tall'); fillStage(el); }, { cls: 'sm' }) : null);
  const body = spot
    ? h('div', { class: 'cs-spot' }, tileEl(room, tiles.find((t) => t.key === spot), true), h('div', { class: 'cs-strip' }, tiles.filter((t) => t.key !== spot).map((t) => tileEl(room, t, false))))
    : h('div', { class: `cs-grid n${Math.min(tiles.length, 9)}` }, tiles.map((t) => tileEl(room, t, false)));
  clear(el).append(head, tiles.length ? body : h('div', { class: 'empty-state' }, h('p', null, 'No one\u2019s here yet.')), callControls(room));
}
function renderCallStages() { $$('.call-stage').forEach(fillStage); }

async function joinRoom(room, { video = false } = {}) {
  try {
    stopRinging(room);
    await voice.join(room, { video });
    playSound('selfJoin');
    if (voice.noMic) toast('No microphone found (or it\u2019s in use by another app), so you joined listen-only.');
    renderCallStages();
    renderHeader();
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Allow microphone (and camera) access in your browser to join.' : e.message, 'error');
  }
}
async function toggleCamera() {
  try { await voice.setCamera(!voice.camStream); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Allow camera access in your browser to turn your camera on.' : e.name === 'NotFoundError' ? 'No camera found.' : e.message, 'error'); }
  renderCallStages(); renderVoicePanel();
}
async function toggleScreen() {
  try { await voice.setScreen(!voice.screenStream); } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast(e.message, 'error'); }
  renderCallStages(); renderVoicePanel();
}
async function startDmCall(dmId, video = false) {
  const room = dmRoom(dmId);
  if (voice.channelId === room) return;
  await joinRoom(room, { video });
}

// ---- ringing
const ringing = new Map(); // room -> { el, timer, stop }
function stopRinging(room) {
  const r = ringing.get(room);
  if (!r) return;
  clearInterval(r.timer); clearTimeout(r.timeout); r.el.remove();
  ringing.delete(room);
}
function onRing({ room, from, video }) {
  if (!S.me || from === S.me.id || ringing.has(room) || (voice && voice.channelId === room) || S.me.status === 'dnd') return;
  const u = getUser(from);
  const where = room.startsWith('dm:') ? '' : ` in ${roomTitle(room)}`;
  const decline = () => { socket.emit('call:decline', { room }, () => {}); stopRinging(room); };
  const el = h('div', { class: 'ring-card', role: 'alertdialog', 'aria-label': `Incoming call from ${displayName(u)}` },
    h('div', { class: 'ring-av' }, avatarEl(u, 56)),
    h('div', { class: 'ring-text' }, h('strong', null, displayName(u)), h('span', null, `${video ? 'Video call' : 'Calling'}${where}\u2026`)),
    h('div', { class: 'ring-actions' },
      h('button', { class: 'round-btn hang', 'aria-label': 'Decline', 'data-tip': 'Decline', onclick: decline }, icon('phoneOff')),
      h('button', { class: 'round-btn accept', 'aria-label': 'Accept', 'data-tip': 'Accept', onclick: () => acceptRing(room) }, icon('phone')),
      h('button', { class: 'round-btn accept', 'aria-label': 'Accept with video', 'data-tip': 'Accept with video', onclick: () => acceptRing(room, true) }, icon('video'))));
  document.body.append(el);
  playSound('ring');
  const timer = setInterval(() => playSound('ring'), 3000);
  const timeout = setTimeout(() => stopRinging(room), 45000);
  ringing.set(room, { el, timer, timeout });
  notify(u, video ? 'Incoming video call' : 'Incoming call', room.startsWith('dm:') ? 'd:' + room.slice(3) : 'c:' + room);
}
async function acceptRing(room, video = false) {
  stopRinging(room);
  if (room.startsWith('dm:')) openDm(room.slice(3));
  else { const s = serverOfChannel(room); if (s) { const c = textChannel(s); if (isGroup(s) && c) openChannel(c.id, s.id); } }
  await joinRoom(room, { video });
}

// Desktop app: "Choose what to share" picker for screen sharing (Electron has none built in).
if (window.hearthDesktop && window.hearthDesktop.onPickScreen) {
  window.hearthDesktop.onPickScreen((sources) => {
    let answered = false;
    const answer = (id) => { if (!answered) { answered = true; window.hearthDesktop.pickScreen(id); } };
    const grid = (list) => h('div', { class: 'pick-grid' }, list.map((src) => h('button', { class: 'pick-src', onclick: () => { answer(src.id); m.close(); } },
      h('img', { src: src.thumb, alt: '' }), h('span', null, src.name))));
    const screens = sources.filter((x) => x.screen); const windows = sources.filter((x) => !x.screen);
    const m = modal({
      title: 'Choose what to share', size: 'lg', className: 'screen-picker', onClose: () => answer(null),
      body: h('div', { class: 'stack' },
        screens.length ? h('h4', null, 'Screens') : null, screens.length ? grid(screens) : null,
        windows.length ? h('h4', null, 'Windows') : null, windows.length ? grid(windows) : null,
        h('p', { class: 'field-hint' }, window.hearthDesktop.platform === 'win32' ? 'Your computer\u2019s sound is shared too.' : 'Sharing sound from your computer isn\u2019t available on this system.')),
      actions: [{ label: 'Cancel', action: () => answer(null) }],
    });
  });
}

// ======================================================================= updates without the fuss
// When the server restarts (an update), it tells everyone first. We show "Updating…", wait for it to
// come back, then either carry on (same version) or switch to the new version, landing right where
// you were with any unsent message kept. During a call we don't interrupt you.
let updatingTimer = null;
function showUpdating(text = 'Updating Hearth\u2026', sub = 'You\u2019ll be right back \u2014 this usually takes a few seconds.') {
  S.restarting = S.restarting || Date.now();
  // The server may have closed our connection on purpose (maintenance) or refused it for now; Socket.IO
  // doesn't retry those by itself, so keep knocking every few seconds until we're back.
  if (!S.retryTimer) S.retryTimer = setInterval(() => { if (!S.restarting) { clearInterval(S.retryTimer); S.retryTimer = null; return; } if (socket && !socket.connected) socket.connect(); }, 4000);
  let el = $('#update-overlay');
  if (!el) {
    el = h('div', { id: 'update-overlay', class: 'update-overlay', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'uo-card' }, h('span', { class: 'uo-spinner', 'aria-hidden': 'true' }), h('strong', { class: 'uo-title' }), h('span', { class: 'uo-sub' })));
    document.body.append(el);
  }
  el.querySelector('.uo-title').textContent = text;
  el.querySelector('.uo-sub').textContent = sub;
  $('#conn-banner').hidden = true;
  clearTimeout(updatingTimer);
  updatingTimer = setTimeout(() => { if ($('#update-overlay')) showUpdating('Still updating\u2026', 'This is taking longer than usual. It will reconnect by itself.'); }, 45000);
}
function hideUpdating() {
  S.restarting = 0;
  clearTimeout(updatingTimer);
  const el = $('#update-overlay');
  if (el) { el.classList.add('done'); setTimeout(() => el.remove(), 250); }
}
function onNewVersion(version) {
  if (voice && voice.channelId) {
    // Don't cut off a call: offer the update for when they're done.
    hideUpdating();
    loadBootstrap().catch(() => {});
    if (!document.querySelector('.update-bar')) {
      const bar = h('div', { class: 'update-bar', role: 'status' }, icon('arrowUp'), h('span', null, `Hearth ${version} is ready. Reload after your call.`),
        h('button', { class: 'btn primary sm', onclick: () => updateAndReload() }, 'Reload now'), ibtn('close', 'Later', () => bar.remove(), { cls: 'sm' }));
      document.body.append(bar);
    }
    return;
  }
  showUpdating('Updated!', `Loading Hearth ${version}\u2026`);
  updateAndReload();
}
// Remember where you were (and unsent messages) across the reload.
function saveResume() {
  try { sessionStorage.setItem('hearth.resume', JSON.stringify({ view: S.view, drafts: [...drafts.entries()].filter(([, v]) => v) })); } catch { /* ignore */ }
}
function restoreResume() {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem('hearth.resume') || 'null'); sessionStorage.removeItem('hearth.resume'); } catch { /* ignore */ }
  if (!r) return;
  for (const [k, v] of r.drafts || []) drafts.set(k, v);
  const v = r.view || {};
  if ((v.type === 'channel' && channelById(v.channelId)) || (v.type === 'dm' && S.dms.some((d) => d.id === v.dmId)) || ['home', 'friends', 'saved'].includes(v.type)) setView({ ...v, jumpTo: undefined });
}
async function updateAndReload() {
  saveResume();
  S.autoUpdating = true;
  wantReload = true;
  const fallback = setTimeout(() => location.reload(), 8000);
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) {
      await reg.update(); // fetch the new version's files into the offline cache first
      const w = reg.installing || reg.waiting;
      if (w) {
        const go = () => w.postMessage('skipWaiting'); // the page reloads when the new version takes over
        if (w.state === 'installed') go(); else w.addEventListener('statechange', () => { if (w.state === 'installed') go(); });
        return;
      }
    }
  } catch { /* fall through */ }
  clearTimeout(fallback);
  location.reload();
}

// ======================================================================= announcement banner (from the admins)
function renderAnnouncement() {
  const a = S.config.announcement;
  let el = $('#announce');
  if (!a || localStorage.getItem('hearth.annDismissed') === a.id) { if (el) el.remove(); return; }
  if (!el) { el = h('div', { id: 'announce', role: 'status' }); document.body.append(el); }
  el.className = `announce lvl-${a.level || 'info'}`;
  clear(el).append(icon(a.level === 'warning' ? 'shield' : a.level === 'success' ? 'check' : 'megaphone'),
    h('span', { class: 'announce-text', html: md(a.text, { inline: true }) }),
    ibtn('close', 'Dismiss', () => { localStorage.setItem('hearth.annDismissed', a.id); el.remove(); }, { cls: 'sm' }));
}
