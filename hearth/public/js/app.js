// Hearth web client.
// Layout: server rail | sidebar (home or server) | conversation | contextual right panel (members, pins, thread).
import { androidApp } from './android.js';
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
import { avatarEl, nameEl, displayName, profileCard, presenceOf, STATUS_LABEL, cropStyle, stopSong } from './profile-ui.js';
import { renderPage } from './page.js';
import { watchPlayer, dropWatchPlayer } from './watch.js';
import { initFeatures, pollEl, onPollUpdate, openPollCreator, voiceButton, voiceEl, openEvents, onEventsUpdate, eventsFor, loadEvents, upcomingSection, onEventStarting, remindItems, startReminders } from './features.js';
import { rankRelays, chooseIce, relayTime } from './relays.js';
import { unseenChanges } from './whatsnew.js';
import { initKeybinds, getKeybinds, comboLabel, reportCall, flashTaskbar, installUpdate } from './keybinds.js';
import { initActivity, activityLine, openActivityPicker, startDesktopDetection } from './activity.js';
import { modal, popover, closePopover, menu, contextMenu, confirmDialog, field, ibtn } from './ui.js';
import { openSettings, applyAppearance, confirmedCall, displayNameDialog } from './settings.js';
import { createFolders } from './folders.js';
import { createUpdates } from './updates.js';
import { createRecall } from './recall-host.js';
import { openMemberships, membershipsTab } from './memberships.js';
import { loadAppearance, saveAppearance, setServerTheme, BACKGROUNDS } from './appearance.js';

// ======================================================================= state
const S = {
  watch: {}, // call room -> shared video (watch together)
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
};
let socket;
let hadController = false; // was a service worker already in charge when the page loaded?
let voice;
const sec = createSecure({ S, onKeysChanged, onKeyWarning });
const fetchingUsers = new Set();

// ---- per-device preferences
// Kept in memory after the first read: these are read constantly while drawing (every channel's
// notification level, the saved list for every message…), and parsing them each time was slow.
const lsCache = new Map();
const LS = {
  get(k, d) {
    if (lsCache.has(k)) return lsCache.get(k);
    let v = d;
    try { const raw = localStorage.getItem(k); if (raw != null) v = JSON.parse(raw); } catch { /* default */ }
    lsCache.set(k, v);
    return v;
  },
  set(k, v) { lsCache.set(k, v); try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
};
// Another tab changed something: forget our copy so the next read picks it up.
window.addEventListener('storage', (e) => { if (e.key) lsCache.delete(e.key); else lsCache.clear(); });

// Several things asking to redraw the same part in one go (a burst of messages, people coming
// online) redraw it once, on the next frame.
const queuedDraws = new Set();
let drawFrame = 0;
function later(fn) {
  queuedDraws.add(fn);
  if (drawFrame) return;
  const run = () => { drawFrame = 0; const fns = [...queuedDraws]; queuedDraws.clear(); fns.forEach((f) => f()); };
  // Hidden tabs don't get animation frames; a timer keeps them up to date anyway.
  drawFrame = document.hidden ? setTimeout(run, 250) : requestAnimationFrame(run);
}
const mine = (k) => `hearth.${k}.${S.me.id}`;
// Below this width the member list floats over the chat, so it only opens when asked (not on every channel).
const wideEnoughForPanel = () => matchMedia('(min-width: 1241px)').matches;
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
  rerender: () => { lsCache.clear(); renderAll(); }, // settings.js writes some preferences straight to localStorage
  openProfile: (id) => openProfileModal(id),
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
  study: () => study,
};

// ======================================================================= boot
init();

async function init() {
  applyAppearance();
  setupServiceWorker();
  const resetToken = (location.hash.match(/^#reset=([A-Za-z0-9_-]{20,100})$/) || [])[1];
  if (resetToken) { history.replaceState(null, '', '/'); sessionStorage.setItem('hearth.resetToken', resetToken); } // keep it out of the address bar
  const m = location.pathname.match(/^\/invite\/([A-Za-z0-9]+)/);
  if (m) { sessionStorage.setItem('hearth.pendingInvite', m[1]); history.replaceState(null, '', '/'); }
  try { S.config = await api('GET', '/config'); } catch { S.config = { name: 'Hearth', iceServers: [] }; }
  document.title = S.config.name;
  $$('[data-instance-name]').forEach((el) => { el.textContent = S.config.name; });
  $$('[data-instance-tagline]').forEach((el) => { el.textContent = S.config.tagline || ''; el.hidden = !S.config.tagline; });

  // A reset link opened in a tab that already shows Hearth only changes the #part: catch that too.
  window.addEventListener('hashchange', () => {
    const t = (location.hash.match(/^#reset=([A-Za-z0-9_-]{20,100})$/) || [])[1];
    if (t) { history.replaceState(null, '', '/'); if (S.me) { sessionStorage.setItem('hearth.resetToken', t); location.reload(); } else openReset(t); }
  });
  // A password-reset link: show the sign-in screen with the reset window on top.
  const pendingReset = sessionStorage.getItem('hearth.resetToken');
  if (pendingReset) { sessionStorage.removeItem('hearth.resetToken'); showAuth(); openReset(pendingReset); return; }
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
  // Why this device was signed out, if it was done from somewhere else.
  const why = sessionStorage.getItem('hearth.signedOutWhy');
  if (why) { sessionStorage.removeItem('hearth.signedOutWhy'); loginForm.querySelector('.form-error').textContent = why; }

  $('#to-register').onclick = (e) => { e.preventDefault(); loginForm.hidden = true; regForm.hidden = false; };
  $('#to-login').onclick = (e) => { e.preventDefault(); regForm.hidden = true; loginForm.hidden = false; };

  // Two-factor step: after a right password, the server asks for the app's code (or a backup code).
  const totpField = $('#totp-field');
  let useBackup = false;
  let derived = null; // { who, params, keys } so the slow password step isn't repeated for the 2FA code
  $('#totp-switch').onclick = (e) => {
    e.preventDefault(); useBackup = !useBackup;
    $('#totp-label').textContent = useBackup ? 'Backup code' : 'Two-factor code';
    e.currentTarget.textContent = useBackup ? 'Use the code from my app' : 'Use a backup code instead';
    loginForm.totp.value = ''; loginForm.totp.inputMode = useBackup ? 'text' : 'numeric'; loginForm.totp.focus();
  };
  $('#to-forgot').onclick = (e) => { e.preventDefault(); openForgot(loginForm.username.value.trim()); };
  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = loginForm.querySelector('button[type=submit]');
    const err = loginForm.querySelector('.form-error');
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Unlocking…';
    try {
      const username = loginForm.username.value.trim();
      const password = loginForm.password.value;
      const who = `${username}\n${password}`;
      if (!derived || derived.who !== who) {
        const params = await api('GET', '/auth/params?username=' + encodeURIComponent(username));
        derived = { who, params, keys: await E2EE.deriveKeys(username, password, params) };
      }
      const { params } = derived;
      const { authKey, wrapKey } = derived.keys;
      const captcha = await loginCap.token();
      const second = !totpField.hidden && loginForm.totp.value.trim() ? (useBackup ? { backupCode: loginForm.totp.value.trim() } : { totp: loginForm.totp.value.trim() }) : {};
      const res = await api('POST', '/auth/login', { username, authKey, captcha, ...second }).finally(() => loginCap.reset())
        .catch((ex) => {
          if (ex.code === 'need_2fa' || ex.code === 'bad_2fa') { totpField.hidden = false; setTimeout(() => loginForm.totp.focus(), 30); }
          throw ex;
        });
      totpField.hidden = true; loginForm.totp.value = ''; derived = null;
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

// "Forgot your password?": a reset link goes to the account's verified email.
function openForgot(prefill) {
  const input = h('input', { class: 'input', value: prefill || '', placeholder: 'Username or email', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' });
  modal({ title: 'Reset your password', size: 'sm',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'We\u2019ll email a reset link to the address on your account (if it has a confirmed one).'), field('Username or email', input)),
    actions: [{ label: 'Cancel' }, { label: 'Send reset link', kind: 'primary', action: async () => {
      if (!input.value.trim()) throw new Error('Enter your username or email.');
      await api('POST', '/auth/forgot', { login: input.value.trim() });
      toast('If that account has a confirmed email, a reset link is on its way. Check your inbox (and spam).');
    } }] });
}
// The link from that email: #reset=<token>. Recovery key → everything stays readable; without → new keys.
async function openReset(token) {
  let info;
  try { info = await api('POST', '/auth/reset/info', { token }); } catch (e) { toast(e.message, 'error'); return; }
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const rec = h('input', { class: 'input mono', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters' });
  const noRec = h('input', { type: 'checkbox' });
  const code = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456 (or a backup code)' });
  const recBox = info.hasRecovery ? h('div', { class: 'stack' }, field('Recovery key', rec, 'With it, all your messages stay readable.'),
    h('label', { class: 'row gap tight' }, noRec, h('span', { class: 'field-hint' }, 'I don\u2019t have it: start over with new keys (old direct messages can\u2019t be read any more)')))
    : h('p', { class: 'warn-box' }, 'You don\u2019t have a recovery key, so this reset makes you new encryption keys: you\u2019ll get back into all your servers and friends, but your old direct messages can\u2019t be read any more. (That\u2019s the price of nobody, not even this server, being able to read them.)');
  modal({ title: `Choose a new password for ${info.username}`, size: 'md', dismissable: true,
    body: h('div', { class: 'stack' }, field('New password', pw), field('Confirm new password', pw2), recBox, info.need2fa ? field('Two-factor code', code, 'From your authenticator app, or one of your backup codes.') : ''),
    actions: [{ label: 'Cancel' }, { label: 'Reset password', kind: 'primary', action: async () => {
      if (pw.value.length < 8) throw new Error('Use at least 8 characters.');
      if (pw.value !== pw2.value) throw new Error('The passwords do not match.');
      const kdfSalt = E2EE.newKdfSalt();
      const next = await E2EE.deriveKeys(info.username, pw.value, { kdf: 'argon2id', salt: kdfSalt });
      const body = { token, authKey: next.authKey, kdfSalt };
      const c = code.value.trim();
      if (info.need2fa) { if (!c) throw new Error('Enter your two-factor code.'); Object.assign(body, /^\d{6}$/.test(c.replace(/\s/g, '')) ? { totp: c } : { backupCode: c }); }
      let privateKey;
      if (info.hasRecovery && !noRec.checked) {
        // Unlock the old key with the recovery key and lock it again with the new password.
        const rk = await E2EE.recoveryWrapKey(rec.value, info.recoverySalt);
        try { body.encPrivateKey = await E2EE.rewrapPrivateKey(rk, next.wrapKey, info.encPrivateKeyRecovery); } catch { throw new Error('That recovery key isn\u2019t right.'); }
        privateKey = await E2EE.unwrapPrivateKey(next.wrapKey, body.encPrivateKey);
        body.keepKeys = true;
        body.keyProof = await E2EE.resetKeyProof(privateKey, info.keyChallenge.serverPublicKey, info.keyChallenge.nonce, info.userId);
      } else {
        const id = await E2EE.createIdentity(next.wrapKey);
        Object.assign(body, { encPrivateKey: id.encPrivateKey, publicKey: id.publicKey });
        privateKey = id.privateKey;
      }
      const res = await api('POST', '/auth/reset', body);
      history.replaceState(null, '', '/');
      toast(body.keepKeys ? 'Password reset. All your messages are still here.' : 'Password reset with new keys. Add a recovery key in Settings so this can\u2019t happen again.');
      await finishLogin(res, privateKey);
    } }] });
}

async function finishLogin(res, privateKey) {
  setToken(res.token);
  localStorage.setItem('hearth.userId', res.user.id);
  await E2EE.storeKey(res.user.id, privateKey);
  S.privateKey = privateKey;
  startApp();
}

async function logout() {
  // This browser stops getting notifications for the account (the server drops the subscription too), and
  // doesn't pass them on to whoever signs in here next. Never holds up signing out for more than a moment.
  if (localStorage.getItem('hearth.push') === 'on' && 'serviceWorker' in navigator) await Promise.race([disablePush().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
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
  // Desktop app: Ctrl+, (and the tray's "Settings…") open Settings.
  if (window.hearthDesktop && typeof window.hearthDesktop.onOpenSettings === 'function' && !window.__hearthSettingsHook) {
    window.__hearthSettingsHook = true;
    window.hearthDesktop.onOpenSettings(() => { if (!document.querySelector('.settings-modal, .set-nav')) openSettings(app); });
  }
  initActivity({
    mediaToken: () => S.mediaToken || '',
    changed: (a) => { if (!S.me) return; S.me.activity = a; if (S.users[S.me.id]) S.users[S.me.id].activity = a; renderUserPanel(); },
  });
  initFeatures({
    S, getUser, displayName, avatarEl, playSound, addInbox,
    jump: (key, id) => jumpToMessage(key, id),
    canManage: (server) => isAdmin(server) || can(server, PERMS.MANAGE_SERVER),
    openChannelOrVoice: (c, server) => (c.type === 'voice' ? joinVoice(c, server) : openChannel(c.id, server.id)),
    onEventsChanged: (serverId) => { if (S.view.serverId === serverId) later(renderSidebar); if (S.view.type === 'home') later(renderMain); },
    notify: ({ title, body }) => {
      if (!('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && document.hasFocus())) return;
      try { new Notification(title, { body, icon: '/icons/icon-192.png' }); } catch { /* ignore */ }
    },
  });
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#app').classList.add('loading');
  socket = io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
  // Keybinds (push-to-talk, mute, deafen) and the desktop app's extras. Global keys in the desktop app.
  if (!S.keybindsOn) {
    S.keybindsOn = true;
    initKeybinds({
      onPtt: (isDown) => { if (voice && voice.channelId) voice.setPtt(isDown); else if (voice) voice.pttHeld = false; },
      onMute: () => toggleMute(),
      onDeafen: () => toggleDeafen(),
      reconnect: () => { if (socket && !socket.connected) socket.connect(); },
      showUpdate: (version) => showAppUpdate(version),
    }).catch(() => {});
  }
  voice = new Voice({
    // Lets the speaking detector ignore people whose mic is off (their state comes from the server).
    isPeerMuted: (userId) => { const st = voice && (S.voice[voice.channelId] || []).find((x) => x.userId === userId); return !!(st && (st.muted || st.deafened)); },
    socket,
    getIceServers: () => chooseIce(S.iceServers || S.config.iceServers || [], S.relayRanks, voice && voice.channelId ? callRegion(voice.channelId) : null),
    signSdp: (toUserId, desc) => sec.signSdp(voice.channelId, toUserId, desc),
    verifySdp: (fromUserId, desc, sig) => sec.verifySdp(voice.channelId, fromUserId, desc, sig),
    onSecurityWarning: (userId) => toast(`Blocked a voice connection from ${displayName(getUser(userId))}: its security signature didn't check out.`, 'error'),
    onChange: () => { shareChanged(); renderVoicePanel(); renderUserPanel(); renderCallStages(); syncWatchDock(); renderSidebarVoiceUsers(); if (S.view.type === 'channel' || S.view.type === 'dm') renderHeader(); reportCall({ inCall: !!voice.channelId, muted: voice.muted, deafened: voice.deafened }); },
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
  // This device was signed out from somewhere else (Settings → Sessions, a password change or reset, staff).
  socket.on('session:revoked', ({ reason } = {}) => {
    const why = { password_changed: 'Your password was changed', password_reset: 'Your password was reset', '2fa_enabled': 'Two-factor sign-in was turned on', expired: 'Your sign-in expired', account_deleted: 'This account was deleted' }[reason];
    sessionStorage.setItem('hearth.signedOutWhy', `${why || 'This device was signed out'}. Sign in again.`);
    logout();
  });
  socket.on('server:restarting', () => showUpdating());
  socket.on('server:maintenance', ({ text }) => showUpdating('Down for maintenance', text || 'Back soon.'));

  // Someone came online, went offline or changed status: just update their dots and lists.
  socket.on('user:presence', (list) => {
    if (!S.me) return;
    let changed = false;
    for (const { id, presence } of Array.isArray(list) ? list : [list]) {
      if (!S.users[id] || id === S.me.id || S.users[id].presence === presence) continue;
      changed = true;
      S.users[id] = { ...S.users[id], presence };
      $$(`[data-user-av="${id}"][data-status="1"] .status-dot`).forEach((d) => {
        d.className = d.className.replace(/\bst-\S+/, `st-${presence}`);
        d.title = STATUS_LABEL[presence] || '';
      });
    }
    if (!changed) return;
    if (S.panel === 'members' || S.view.type === 'dm') later(renderPanel);
    if (['friends', 'home'].includes(S.view.type) && S.view.tab !== 'add') later(renderMain);
  });
  // Someone started or stopped a game or a song.
  socket.on('user:activity', (list) => {
    if (!S.me) return;
    for (const { id, activity } of Array.isArray(list) ? list : []) {
      if (!S.users[id]) continue;
      S.users[id] = { ...S.users[id], activity: activity || null };
      if (id === S.me.id) { S.me.activity = activity || null; renderUserPanel(); }
    }
    if (S.panel === 'members' || S.view.type === 'dm') later(renderPanel);
    if (['friends', 'home', 'people'].includes(S.view.type) && S.view.tab !== 'add') later(renderMain);
  });
  socket.on('user:update', (u) => {
    if (!S.me) return;
    const roleBefore = S.me.staffRole;
    setUser(u); sec.trust(u); refreshUserBits(u.id);
    // Given or lost a staff role: show or hide the admin dashboard right away.
    if (u.id === S.me.id && 'staffRole' in u && (u.staffRole || null) !== (roleBefore || null)) {
      if (S.view.type === 'admin' && !u.staffRole) setView({ type: 'home' }); else app.rerender();
      toast(u.staffRole ? `You\u2019re now ${({ owner: 'the owner', admin: 'an admin', moderator: 'a moderator' })[u.staffRole]} on this server.` : 'You\u2019re no longer on the staff team.');
    }
  });
  socket.on('membership:update', ({ serverId, membership: m }) => {
    const sv = S.servers.find((x) => x.id === serverId);
    const where = sv ? sv.name : 'the server';
    if (m.status === 'active' && !m.cancelAtEnd && Date.now() - m.since < 10 * 60000) { toast(`\u2B50 You\u2019re a member of ${where}. Thank you!`); playSound('mention'); }
    else if (m.status === 'past_due') toast(`Your membership payment for ${where} didn\u2019t go through. Stripe will try again; check your card.`, 'error');
    else if (m.status === 'ended') toast(`Your membership of ${where} has ended.`);
  });
  socket.on('support:thanks', ({ until, forever }) => {
    toast(forever ? '\uD83D\uDC9C Thank you for your support!' : `\uD83D\uDC9C Thank you! You\u2019re a supporter until ${new Date(until).toLocaleDateString()}.`);
    playSound('mention');
  });
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
  socket.on('profile:comment', ({ from }) => toast(`${displayName(getUser(from))} commented on your profile.`));
  socket.on('config:update', (c) => {
    Object.assign(S.config, c);
    if ('name' in c || 'tagline' in c) { document.title = S.config.name; $$('[data-instance-name]').forEach((el) => { el.textContent = S.config.name; }); }
    if ('funding' in c && S.view.type === 'home') later(renderMain);
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
  socket.on('rail:update', ({ rail }) => folders.applyRemote(rail));
  socket.on('study:changed', () => { if (S.me.studyEnabled) study.onRemoteChange(); });
  socket.on('study:enabled', ({ enabled }) => { S.me.studyEnabled = enabled; if (!S.view.serverId) renderSidebar(); });
  socket.on('updates:new', (p) => { updates.onNew(p); if (S.view.type === 'updates') renderMain(); });
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
  socket.on('call:region', (p) => onCallRegion(p));
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
  socket.on('poll:update', (st) => onPollUpdate(st));
  socket.on('events:update', (p) => onEventsUpdate(p));
  socket.on('event:starting', (e) => onEventStarting(e));
  socket.on('watch:state', ({ room, state }) => {
    if (!S.me) return;
    if (!voice || voice.channelId !== room) return;
    S.watch[room] = state;
    watchPlayer(room, watchCtx(room)).apply(state);
    if (state) wtDock.hidden = false; // a new video shows up even if you hid the last one
    renderCallStages();
    syncWatchDock();
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
  // With relays in several regions, find the nearest ones in the background (cached for 6 hours).
  if ((b.iceServers || []).filter((e) => [].concat(e.urls || []).some((u) => /^turns?:/.test(u))).length > 2) setTimeout(() => rankRelays(b.iceServers).then((r) => { S.relayRanks = r; }).catch(() => {}), 4000);
  S.encPrivateKey = b.encPrivateKey;
  S.users = b.users;
  S.servers = b.servers;
  S.serversLoaded = true;
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
  if (!S.view.serverId && !S.view.dmId && !['friends', 'saved', 'people'].includes(S.view.type)) S.view = { type: 'home' };
  renderAll();
  loadPreviews();
  if (!S.remindersOn) { S.remindersOn = true; startReminders(); }
  if (window.hearthDesktop && window.hearthDesktop.detectActivity) api('GET', '/me/activity-settings').then(startDesktopDetection).catch(() => {});
  if ((b.termsVersion || 0) > (b.tosAccepted || 0)) askToAcceptTerms();
  restoreResume();
  renderAnnouncement();
  if (S.me.staffRole) api('GET', '/admin/stats').then((st) => { S.adminReports = st.openReports; renderRail(); }).catch(() => {});
  backFromStripe();
  const open = new URLSearchParams(location.search).get('open');
  if (open) { history.replaceState(null, '', '/' + location.hash); if (open === 'messages') openMessages(); if (open === 'friends') goFriends(); }
  if (localStorage.getItem('hearth.push') === 'on') enablePush({ quiet: true }).catch(() => {});
  const invite = sessionStorage.getItem('hearth.pendingInvite');
  if (invite) { sessionStorage.removeItem('hearth.pendingInvite'); openJoinModal(invite); }
  else if (!S.whatsNewShown) {
    S.whatsNewShown = true;
    const news = unseenChanges(S.config.version);
    if (news.length) {
      modal({ title: 'What\u2019s new', size: 'md', className: 'whatsnew',
        body: h('div', { class: 'stack' }, ...news.map((c) => h('section', null, h('h3', { class: 'set-h' }, `Version ${c.version}`), h('ul', { class: 'perk-list' }, c.items.map((t) => h('li', null, t)))))),
        actions: [{ label: 'Nice', kind: 'primary' }] });
    }
  }
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

// ---- screen sharing: keep DMs private
// While you share your screen, direct messages and group chats are covered (and their previews and pop-up
// notifications hidden), so you can't show a private conversation by accident. "Show while sharing" opens one
// conversation for the rest of this share. Settings → Chat can turn this off.
const shareAllowed = new Set(); // conversation keys shown anyway during the current share
let wasSharing = false;
const isSharing = () => !!(voice && voice.screenStream) && P.chat.hideDmsWhileSharing !== false;
// The conversation key ('d:<dm>' or 'c:<group text channel>') if this view is a private conversation.
function privateKey(v = S.view) {
  if (v.type === 'dm') return 'd:' + v.dmId;
  if (v.type === 'channel') { const s = currentServer(); if (s && isGroup(s)) return 'c:' + v.channelId; }
  return null;
}
const hiddenWhileSharing = (key) => !!key && isSharing() && !shareAllowed.has(key);
function shareChanged() {
  const now = isSharing();
  if (now === wasSharing) return;
  wasSharing = now;
  if (!now) shareAllowed.clear();
  renderMain(); renderSidebar(); renderPanel();
  if (now && privateKey()) toast('You\u2019re sharing your screen, so this conversation is hidden from view.');
}
function shareCover(key) {
  const v = S.view;
  const who = v.type === 'dm' ? displayName(getUser((S.dms.find((d) => d.id === v.dmId) || {}).userId)) : groupName(currentServer());
  return h('div', { class: 'share-cover' },
    h('div', { class: 'share-cover-card' }, icon('monitor', 'ic share-cover-ic'),
      h('h2', null, 'Hidden while you share your screen'),
      h('p', null, `Your conversation with ${who} stays private: anyone watching your screen sees this instead.`),
      h('div', { class: 'row gap center' },
        h('button', { class: 'btn primary', onclick: () => { shareAllowed.add(key); renderMain(); renderSidebar(); renderPanel(); } }, 'Show while sharing'),
        h('button', { class: 'btn ghost', onclick: () => toggleScreen() }, 'Stop sharing')),
      h('p', { class: 'field-hint' }, 'Only for this conversation, until you stop sharing. You can turn this off in Settings \u2192 Chat.')));
}

// ---- call regions (like Discord's region override)
// A voice channel or DM call can be pinned to one region's relay; everyone in it switches together.
// null = automatic: direct when possible, otherwise the nearest relays.
function callRegion(room) {
  if (!room) return null;
  if (room.startsWith('dm:')) return (S.dms.find((d) => d.id === room.slice(3)) || {}).region || null;
  return (channelById(room) || {}).region || null;
}
// Regions this server can relay calls through right now: [{ id, name, ms }]
function callRegions() {
  const seen = new Map();
  for (const e of S.iceServers || []) if (e.regionId && !seen.has(e.regionId)) seen.set(e.regionId, { id: e.regionId, name: e.region || 'Relay', ms: relayTime(S.relayRanks, e) });
  return [...seen.values()];
}
const regionName = (id) => (id ? (callRegions().find((r) => r.id === id) || {}).name || 'an offline region' : 'Automatic');
function canSetRegion(room) {
  if (room.startsWith('dm:')) return true;
  const c = channelById(room); const s = c && serverOfChannel(c.id);
  return !!s && (isGroup(s) || can(s, PERMS.MANAGE_CHANNELS));
}
function regionMenuItems(room) {
  const cur = callRegion(room);
  const regions = callRegions();
  const set = (region) => api('POST', '/calls/region', { room, region }).catch((e) => toast(e.message, 'error'));
  const items = [{ header: 'Call region' }];
  if (!canSetRegion(room)) {
    items.push({ label: regionName(cur), icon: 'globe', checked: true, action: () => toast('Only people who can manage this channel can change its region.') });
    return items;
  }
  items.push({ label: 'Automatic', hint: 'fastest for each person', checked: !cur, action: () => set(null) });
  for (const r of regions) items.push({ label: r.name, hint: typeof r.ms === 'number' ? `${r.ms} ms` : '', checked: cur === r.id, action: () => set(r.id) });
  if (cur && !regions.some((r) => r.id === cur)) items.push({ label: 'Pinned region is offline \u2014 using Automatic', icon: 'globe', checked: true, action: () => set(null) });
  return items;
}
function onCallRegion(p) {
  if (!p || typeof p.room !== 'string') return;
  if (p.room.startsWith('dm:')) { const d = S.dms.find((x) => x.id === p.room.slice(3)); if (d) d.region = p.region; }
  else { const c = channelById(p.room); if (c) c.region = p.region; }
  if (voice && voice.channelId === p.room) {
    voice.switchNetwork();
    const who = p.by === S.me.id ? 'You' : displayName(getUser(p.by));
    toast(`${who} moved the call to ${p.region ? regionName(p.region) : 'automatic region'}. Everyone is switching over.`);
  }
  renderVoicePanel();
}
const textChannel = (server) => server.channels.find((c) => c.type === 'text');

function setView(v) {
  S.view = v;
  S.editing = null;
  if (S.panel === 'thread' && (!S.thread || S.thread.channelId !== v.channelId)) { S.panel = null; S.thread = null; }
  if (S.panel === 'pins') S.panel = null;
  if (S.panel === null && P.showMembers && wideEnoughForPanel() && (v.type === 'channel' || v.type === 'dm')) S.panel = 'members';
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
  const st = S.msgs[key];
  const lastId = st && st.list.length && !st.hasNewer ? st.list[st.list.length - 1].id : null;
  const badges = S.unread.has(key) || S.mentions.has(key);
  // Called on every scroll near the bottom: only do the work when something actually changes.
  if (!badges && (!lastId || P.lastRead[key] === lastId)) return;
  if (lastId && P.lastRead[key] !== lastId) {
    const lr = P.lastRead;
    lr[key] = lastId;
    P.lastRead = lr;
  }
  // Only unread dots and mention counts show in the server bar and channel list.
  if (!badges) return;
  S.unread.delete(key);
  S.mentions.delete(key);
  updateTitle();
  later(renderRail);
  later(renderSidebar);
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
const serverIconEl = (s) => (s.icon ? h('img', { src: s.icon, alt: '' }) : h('span', { class: 'rail-initials', style: s.theme && s.theme.accent ? { color: s.theme.accent } : null }, s.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3)));
const updates = createUpdates({
  S, mediaNewsUrl: (u) => mediaNewsUrl(u),
  onUnread: () => { if (!S.view.serverId) renderSidebar(); renderRail(); },
});
// Study tools: Recall in a sandboxed frame, with its decks end-to-end encrypted and synced (recall-host.js).
const study = createRecall({ S, onEnabled: () => { if (!S.view.serverId) renderSidebar(); } });
const folders = createFolders({
  S, servers: () => realServers(), favorites: () => new Set(P.favorites.filter((f) => f.startsWith('s:')).map((f) => f.slice(2))),
  rerender: () => renderRail(), serverUnread: (s) => serverUnread(s), setNotify: (k, v) => setNotify(k, v), railSide: () => railSide(),
  markServerRead: (server) => { server.channels.forEach((c) => { S.unread.delete('c:' + c.id); S.mentions.delete('c:' + c.id); }); renderAll(); },
  serverIcon: (s) => serverIconEl(s),
});
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
    tile({ label: 'Home', cls: 'home', active: homeActive && S.view.type !== 'dm' && !isGroup(currentServer()), onclick: goHome, content: icon('flame'), badge: pending + (S.me.updatesUnread || 0) }),
    tile({ label: 'Direct messages', cls: 'nav', active: S.view.type === 'dm' || isGroup(currentServer()), onclick: openMessages, content: icon('message'), badge: dmUnread }),
    h('div', { class: 'rail-item' }, h('button', {
      class: 'rail-btn nav', 'aria-label': 'Notifications', 'data-tip': 'Notifications', 'data-tip-side': railSide(), 'data-pop-anchor': '',
      onclick: (e) => openInbox(e.currentTarget),
    }, icon('bell'), h('span', { class: 'badge inbox-badge', hidden: true }))),
    ...(S.me.staffRole ? [tile({ label: 'Admin', cls: 'nav', active: S.view.type === 'admin', onclick: () => setView({ type: 'admin', tab: S.adminReports ? 'reports' : 'overview' }), content: icon('shield'), badge: S.adminReports })] : []),
    h('div', { class: 'rail-sep', role: 'separator' }),
  );
  // Favorites first, then your folders and the rest in your own order (see folders.js).
  const favs = P.favorites;
  const serverTile = (s, inFolder) => {
    const { unread, mentions } = serverUnread(s);
    return tile({
      label: s.name + (favs.includes('s:' + s.id) ? ' (favorite)' : ''),
      active: S.view.serverId === s.id, unread,
      onclick: () => openServer(s.id),
      oncontext: (e) => contextMenu(e, serverMenuItems(s)),
      cls: `shape-${(s.theme && s.theme.iconShape) || 'rounded'}`,
      content: serverIconEl(s),
      badge: mentions,
    });
  };
  const favServers = realServers().filter((s) => favs.includes('s:' + s.id));
  favServers.forEach((s) => rail.append(serverTile(s)));
  if (favServers.length) rail.append(h('div', { class: 'rail-sep thin', role: 'separator' }));
  folders.render(rail, serverTile);
  rail.append(
    tile({ label: 'Add a server', cls: 'add', onclick: openAddServer, oncontext: (e) => contextMenu(e, [{ label: 'Organize servers\u2026', icon: 'folder', action: () => folders.openOrganize() }]), content: icon('plus') }),
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
  );
  // The less-used pages sit behind one "More" row so the sidebar stays about your conversations.
  const extras = [
    nav('Updates', 'rss', S.view.type === 'updates', () => setView({ type: 'updates' }), S.me.updatesUnread || 0),
    S.me.studyEnabled ? nav('Study', 'graduation', S.view.type === 'study', () => setView({ type: 'study' })) : null,
    nav('People', 'user', S.view.type === 'people', () => setView({ type: 'people' })),
    nav('Saved messages', 'bookmark', S.view.type === 'saved', () => setView({ type: 'saved' })),
  ].filter(Boolean);
  const extraActive = ['updates', 'study', 'people', 'saved'].includes(S.view.type);
  let moreOpen = extraActive;
  try { moreOpen = moreOpen || localStorage.getItem('hearth.navMore') === '1'; } catch { /* storage blocked */ }
  const moreBox = h('div', { class: 'nav-more', id: 'nav-more', hidden: !moreOpen }, extras);
  body.append(h('button', {
    class: `nav-row nav-more-btn${moreOpen ? ' open' : ''}`, 'aria-expanded': String(moreOpen), 'aria-controls': 'nav-more',
    onclick: (e) => {
      const open = moreBox.hidden;
      moreBox.hidden = !open;
      e.currentTarget.classList.toggle('open', open);
      e.currentTarget.setAttribute('aria-expanded', String(open));
      try { localStorage.setItem('hearth.navMore', open ? '1' : '0'); } catch { /* storage blocked */ }
    },
  }, icon('chevronRight'), h('span', null, 'More'),
  !moreOpen && S.me.updatesUnread ? h('span', { class: 'badge inline' }, S.me.updatesUnread) : null), moreBox);
  const convs = conversations();
  const favs = P.favorites;
  const pinned = convs.filter((c) => favs.includes(c.fav));
  if (pinned.length) {
    body.append(h('div', { class: 'group-label' }, h('span', null, 'Pinned')));
    pinned.forEach((c) => body.append(convRow(c)));
  }
  body.append(h('div', { class: 'group-label' }, h('span', null, 'Direct messages'),
    ibtn('plus', 'New message or group chat', (e) => menu(e.currentTarget, [
      { label: 'New message', icon: 'message', action: () => openNewConversation() },
      { label: 'New group chat', icon: 'people', action: () => openNewConversation(null, { group: true }) },
    ], { align: 'end' }), { cls: 'sm', attrs: { 'data-pop-anchor': '' } })));
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
  if (g.icon) return h('span', { class: 'group-av icon', style: { '--size': size + 'px' } }, h('img', { src: g.icon, alt: '' }));
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
    h('span', { class: 'dm-row-status' }, isSharing() && !shareAllowed.has(c.unreadKey) ? 'Hidden while sharing' : c.preview || '\u00a0')),
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
    { label: 'Change group picture', icon: 'image', action: () => changeGroupIcon(g) },
    { label: 'Add people', icon: 'userPlus', action: () => openNewConversation(g) },
    { label: 'Members', icon: 'people', action: () => manageGroup(g) },
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

const eventsLoaded = new Set();
function renderServerSidebar(server, head, body) {
  const th = server.theme || {};
  head.classList.toggle('has-banner', !!th.banner);
  if (th.banner) head.append(h('div', { class: 'server-banner' }, h('img', { class: 'cropped', src: th.banner, alt: '', style: cropStyle(th.bannerCrop) })));
  head.append(h('button', { class: 'server-head', 'data-pop-anchor': '', 'aria-haspopup': 'menu', onclick: (e) => menu(e.currentTarget, serverMenuItems(server), { align: 'start' }) },
    h('span', { class: 'server-head-name' }, server.name), icon('chevron')));
  const admin = isAdmin(server);
  // Events: what's planned in this server (loaded once, kept fresh by live updates).
  const evs = eventsFor(server.id);
  if (!eventsLoaded.has(server.id)) { eventsLoaded.add(server.id); loadEvents(server.id).then(() => later(renderSidebar)); }
  const next = evs[0];
  body.append(h('button', { class: `ev-row${next ? ' has' : ''}`, onclick: () => openEvents(server) }, icon('book'),
    h('span', { class: 'ev-row-text' }, next ? h('span', null, h('strong', null, next.title), h('small', null, new Date(next.startsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))) : 'Events'),
    evs.length ? h('span', { class: 'badge inline' }, evs.length) : null));
  // Memberships this server sells (support the creator, get a role / private channels).
  if (server.memberships) body.append(h('button', { class: 'ev-row mb-row', onclick: () => (isOwner(server) ? openServerSettings(server, 'memberships') : openMemberships(server)) }, icon('star'), h('span', { class: 'ev-row-text' }, 'Memberships')));
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
    ...(c.type === 'voice' && callRegions().length ? [...regionMenuItems(c.id), '-'] : []),
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
  const act = S.me.activity || {};
  const sub = act.game ? `Playing ${act.game.name}` : act.music ? `\u266B ${act.music.title}` : p.customStatus && (p.customStatus.text || p.customStatus.emoji)
    ? `${p.customStatus.emoji || ''} ${p.customStatus.text || ''}`.trim()
    : STATUS_LABEL[S.me.status] || 'Online';
  const av = avatarEl(S.me, 34, { status: true, meId: S.me.id });
  av.dataset.speak = S.me.id;
  const inCall = voice && voice.channelId;
  el.append(
    h('button', { class: 'me-btn', 'data-pop-anchor': '', 'aria-label': 'Your status and profile', onclick: (e) => statusMenu(e.currentTarget) },
      av, h('span', { class: 'me-text' }, nameEl(S.me), h('span', { class: 'me-sub' }, sub))),
    h('div', { class: 'me-actions' },
      inCall ? ibtn(voice.muted ? 'micOff' : 'mic', `${voice.muted ? 'Unmute' : 'Mute'}${getKeybinds().mute ? ` (${comboLabel(getKeybinds().mute)})` : ''}`, toggleMute, { cls: voice.muted ? 'off' : '', active: voice.muted }) : null,
      inCall ? ibtn(voice.deafened ? 'headphonesOff' : 'headphones', `${voice.deafened ? 'Undeafen' : 'Deafen'}${getKeybinds().deafen ? ` (${comboLabel(getKeybinds().deafen)})` : ''}`, toggleDeafen, { cls: voice.deafened ? 'off' : '', active: voice.deafened }) : null,
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
  const go = () => goToCall(room);
  el.append(
    h('div', { class: 'vp-top' },
      h('div', { class: 'vp-info' }, h('div', { class: `vp-status q-${q}` }, label), h('button', { class: 'vp-where', onclick: go }, where)),
      callRegions().length ? h('button', {
        class: `vp-region${callRegion(room) ? ' pinned' : ''}`, 'data-pop-anchor': '', 'data-tip': 'Call region: everyone in the call switches together',
        onclick: (e) => menu(e.currentTarget, regionMenuItems(room), { align: 'end' }),
      }, icon('globe'), h('span', null, callRegion(room) ? regionName(callRegion(room)) : 'Auto')) : null),
    h('div', { class: 'vp-controls' },
      ibtn(voice.muted ? 'micOff' : 'mic', voice.muted ? 'Unmute' : 'Mute', toggleMute, { cls: voice.muted ? 'off' : '' }),
      ibtn(voice.camStream ? 'video' : 'videoOff', voice.camStream ? 'Turn camera off' : 'Turn camera on', toggleCamera, { cls: voice.camStream ? 'on' : '' }),
      ibtn('monitor', voice.screenStream ? 'Stop sharing' : 'Share your screen', toggleScreen, { cls: voice.screenStream ? 'on' : '' }),
      ibtn('phoneOff', 'Leave call', () => { voice.leave(); playSound('selfLeave'); }, { cls: 'hang' })),
    voice.pttMode() ? h('div', { class: `ptt-hint${voice.pttHeld && !voice.muted ? ' on' : ''}` }, icon('mic'),
      getKeybinds().ptt ? (voice.pttHeld && !voice.muted ? 'Talking' : `Push to talk: hold ${comboLabel(getKeybinds().ptt)}`) : h('button', { class: 'link-btn', onclick: () => openSettings(app, 'keybinds') }, 'Push to talk is on, but no key is set')) : '',
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
    h('button', { class: 'menu-item', onclick: () => { closePopover(); openActivityPicker(S.me.activity); } }, icon('gamepad', 'ic menu-ic'), 'Set what I\u2019m playing or listening to'),
    S.config.funding || S.config.support ? h('button', { class: 'menu-item', onclick: () => { closePopover(); openSupport(); } }, icon('coin', 'ic menu-ic'), `Support ${S.config.name}`) : null,
    h('button', { class: 'menu-item', onclick: () => { closePopover(); openProfileModal(S.me.id); } }, icon('user', 'ic menu-ic'), 'View my profile'),
    h('button', { class: 'menu-item', onclick: () => { closePopover(); displayNameDialog(app); } }, icon('user', 'ic menu-ic'), 'Change display name'),
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
  else if (v.type === 'people') main.append(peopleView());
  else if (v.type === 'updates') main.append(updates.view());
  else if (v.type === 'study') main.append(study.view());
  else if (v.type === 'admin' && S.me.staffRole) main.append(S.adminEl = adminView({ role: S.me.staffRole, confirm: (fn, opts) => confirmedCall(app, fn, opts), tab: v.tab, setTab: (t) => { S.view.tab = t; }, openReports: S.adminReports, onCount: (n) => { if (S.adminReports !== n) { S.adminReports = n; renderRail(); } } }));
  else if ((v.type === 'channel' || v.type === 'dm') && hiddenWhileSharing(privateKey(v))) main.append(shareCover(privateKey(v)));
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
  const PIN_ITEM = { label: S.panel === 'pins' ? 'Hide pinned messages' : 'Pinned messages', icon: 'pin', action: () => togglePanel('pins') };
  if (v.type === 'channel' && server && !isGroup(server)) {
    const c = server.channels.find((x) => x.id === v.channelId);
    if (!c) return;
    head.append(
      h('div', { class: 'head-title' }, icon(channelIcon(c), 'ic head-ic'), h('h1', null, c.name),
        c.topic ? h('span', { class: 'head-topic', title: c.topic }, c.topic) : null),
      headTools(
        encBadge(() => openServerSecurity(server)),
        ibtn('search', 'Search this channel (Ctrl+K)', () => openSearch({ scope: key })),
        // Notification options live in the ⋯ menu; the bell only shows up as a reminder when it's muted.
        isMuted(key) ? ibtn('bellOff', 'Muted. Click to change.', (e) => menu(e.currentTarget, notifyMenu(key), { align: 'end' }), { attrs: { 'data-pop-anchor': '' } }) : null,
        ibtn('people', S.panel === 'members' ? 'Hide members' : 'Show members', () => togglePanel('members'), { active: S.panel === 'members' }),
        ibtn('more', 'More', (e) => menu(e.currentTarget, [PIN_ITEM, ...channelMenuItems(c, server)], { align: 'end' }), { attrs: { 'data-pop-anchor': '' }, active: S.panel === 'pins' })));
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
        ibtn('people', 'Members', () => togglePanel('members'), { active: S.panel === 'members' }),
        ibtn('more', 'More', (e) => menu(e.currentTarget, [PIN_ITEM, ...groupMenuItems(server)], { align: 'end' }), { attrs: { 'data-pop-anchor': '' }, active: S.panel === 'pins' })));
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
        ibtn('user', S.panel === 'members' ? 'Hide profile' : 'Show profile', () => togglePanel('members'), { active: S.panel === 'members' }),
        ibtn('more', 'More', (e) => menu(e.currentTarget, [PIN_ITEM, ...dmMenuItems(d), '-', blockItem(u)], { align: 'end' }), { attrs: { 'data-pop-anchor': '' }, active: S.panel === 'pins' })));
  } else if (v.type === 'voice' && server) {
    const c = server.channels.find((x) => x.id === v.channelId);
    head.append(h('div', { class: 'head-title' }, icon('speaker', 'ic head-ic'), h('h1', null, c ? c.name : 'Voice')),
      headTools(h('span', { class: 'head-note' }, icon('lock', 'ic'), c && c.region && callRegions().some((r) => r.id === c.region) ? `Audio goes through ${regionName(c.region)}, encrypted end to end` : 'Audio goes directly between members, encrypted')));
  } else if (v.type === 'friends') {
    const pending = Object.values(S.relationships).filter((r) => r.direction === 'incoming').length;
    const tab = (k, label, extra) => h('button', { class: `tab${v.tab === k ? ' active' : ''}${k === 'add' ? ' tab-add' : ''}`, role: 'tab', 'aria-selected': String(v.tab === k), onclick: () => goFriends(k) }, label, extra);
    head.append(h('div', { class: 'head-title' }, icon('people', 'ic head-ic'), h('h1', null, 'Friends')),
      h('div', { class: 'tabs', role: 'tablist' }, tab('online', 'Online'), tab('all', 'All'), tab('pending', 'Pending', pending ? h('span', { class: 'badge inline' }, pending) : null), tab('add', 'Add friend')));
  } else if (v.type === 'home') {
    head.append(h('div', { class: 'head-title' }, icon('home', 'ic head-ic'), h('h1', null, 'Home')),
      headTools(ibtn('search', 'Search (Ctrl+K)', () => openSearch())));
  } else if (v.type === 'admin') {
    head.append(h('div', { class: 'head-title' }, icon('shield', 'ic head-ic'), h('h1', null, 'Admin'), h('span', { class: 'head-topic' }, `Only staff can see this \u00b7 you\u2019re ${({ owner: 'the owner', admin: 'an admin', moderator: 'a moderator' })[S.me.staffRole] || 'staff'}`)));
  } else if (v.type === 'people') {
    head.append(h('div', { class: 'head-title' }, icon('user', 'ic head-ic'), h('h1', null, 'People'), h('span', { class: 'head-topic' }, 'Profiles of people you share a server with')),
      headTools(h('button', { class: 'btn ghost sm', onclick: () => openProfileModal(S.me.id) }, icon('user'), 'My page')));
  } else if (v.type === 'study') {
    head.append(h('div', { class: 'head-title' }, icon('graduation', 'ic head-ic'), h('h1', null, 'Study'), h('span', { class: 'head-topic' }, 'Recall flashcards \u00b7 end-to-end encrypted, on all your devices')));
  } else if (v.type === 'updates') {
    head.append(h('div', { class: 'head-title' }, icon('rss', 'ic head-ic'), h('h1', null, 'Updates'), h('span', { class: 'head-topic' }, 'Topics, channels and projects you track')),
      headTools(h('button', { class: 'btn ghost sm', onclick: () => updates.trackDialog(() => renderMain()) }, icon('plus'), 'Track something')));
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
// "Keep this server running": the owner's monthly cost, how much is covered, and where to chip in.
// No ads, no tracking: just an honest number. It can be hidden for a month.
function fundingCard() {
  const f = S.config.funding;
  if (!f || !f.enabled || !f.url) return null;
  const hidKey = `hearth.fundHidden.${S.me.id}`;
  if (+(localStorage.getItem(hidKey) || 0) > Date.now()) return null;
  const money = (n) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: f.currency || 'USD', maximumFractionDigits: 0 }).format(n); } catch { return `${n} ${f.currency}`; } };
  const pct = f.monthly ? Math.min(100, Math.round((f.raised / f.monthly) * 100)) : 0;
  const card = h('section', { class: 'fund-card' },
    h('div', { class: 'fund-text' },
      h('strong', null, `Keep ${S.config.name} running`),
      h('span', null, f.note || `No ads, no selling your data. This server costs ${money(f.monthly)} a month and is paid for by the people who use it.`),
      f.monthly ? h('div', { class: 'fund-bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i', { style: { width: pct + '%' } })) : null,
      h('span', { class: 'fund-meta' }, f.monthly ? `${money(f.raised)} of ${money(f.monthly)} this month` : '', f.supporters ? ` \u00b7 ${f.supporters} supporter${f.supporters === 1 ? '' : 's'} \uD83D\uDC9C` : '')),
    h('div', { class: 'fund-actions' },
      h('button', { class: 'btn primary sm', onclick: () => openSupport() }, 'Chip in'),
      h('button', { class: 'btn ghost sm', onclick: () => { localStorage.setItem(hidKey, String(Date.now() + 30 * 86400000)); card.remove(); } }, 'Hide for a month')));
  return card;
}
// The Support window: perks, the person's own support code, and the ways to pay (Stripe / Ko-fi / the
// owner's own link). Payments with the code turn on the supporter badge by themselves.
async function openSupport() {
  let d;
  try { d = await api('GET', '/me/support'); } catch (e) { return toast(e.message, 'error'); }
  const f = S.config.funding || {};
  const money = (cents) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: d.currency }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${d.currency}`; } };
  const perks = [h('li', null, '\uD83D\uDC9C Supporter badge on your profile'),
    d.perks.storageMb ? h('li', null, `${d.perks.storageMb >= 1024 ? `${(d.perks.storageMb / 1024).toFixed(d.perks.storageMb % 1024 ? 1 : 0)} GB` : `${d.perks.storageMb} MB`} of storage`) : null,
    d.perks.fileMb ? h('li', null, `Send files up to ${d.perks.fileMb} MB`) : null,
    h('li', null, 'The good feeling of keeping this place ad-free')];
  const codeBox = h('div', { class: 'cmd-box' }, h('code', null, d.code), h('button', { class: 'btn sm', onclick: () => { copyText(d.code); toast('Code copied.'); } }, icon('copy'), 'Copy'));
  const ways = [];
  if (d.stripeUrl) ways.push(h('a', { class: 'btn primary', href: d.stripeUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Pay with card, Apple Pay or Google Pay'));
  if (d.kofiUrl) ways.push(h('a', { class: 'btn', href: d.kofiUrl, target: '_blank', rel: 'noopener noreferrer', onclick: () => { copyText(d.code); toast('Your code is copied: paste it into the Ko-fi message.'); } }, 'Tip on Ko-fi'));
  if (!ways.length && f.url) ways.push(h('a', { class: 'btn primary', href: f.url, target: '_blank', rel: 'noopener noreferrer' }, 'Chip in'));
  modal({
    title: `Support ${S.config.name}`, size: 'md',
    body: h('div', { class: 'stack support-modal' },
      d.supporter ? h('p', { class: 'support-now' }, d.until ? `\uD83D\uDC9C You\u2019re a supporter until ${new Date(d.until).toLocaleDateString()}. Thank you!` : '\uD83D\uDC9C You\u2019re a supporter. Thank you!') : null,
      h('p', { class: 'muted-p' }, f.note || `No ads, no selling data. ${S.config.name} is paid for by the people who use it.`),
      h('p', { class: 'muted-p' }, `${money(d.monthlyCents)} keeps you a supporter for a month (pay more, it lasts longer). You get:`),
      h('ul', { class: 'perk-list' }, perks),
      ways.length ? h('div', { class: 'row gap wrap' }, ways) : h('p', { class: 'field-hint' }, 'The owner hasn\u2019t set up a way to pay yet.'),
      d.kofiUrl ? h('div', { class: 'stack tight' }, h('span', { class: 'field-label' }, 'Your support code'), codeBox,
        h('p', { class: 'field-hint' }, 'On Ko-fi, put this code in your message so the payment finds you. Card payments find you by themselves.')) : null,
      d.mine.length ? h('div', { class: 'stack tight' }, h('span', { class: 'field-label' }, 'Your payments'),
        ...d.mine.map((p) => h('div', { class: 'kv' }, h('span', null, `${new Date(p.created_at).toLocaleDateString()} \u00b7 ${p.kind}`), h('b', null, money(p.amount_cents))))) : null),
  });
}
function homeView() {
  const wrap = h('div', { class: 'home-view' });
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  wrap.append(h('div', { class: 'home-hero' }, h('h2', null, `${greet}, ${displayName(S.me)}`)));

  const convs = conversations();
  const favs = P.favorites;
  const pinned = convs.filter((c) => favs.includes(c.fav));
  const section = (title, action, ...kids) => h('section', { class: 'home-sec' }, h('div', { class: 'home-sec-head' }, h('h3', null, title), action), ...kids);

  const fundCard = fundingCard();
  if (fundCard) wrap.append(fundCard);
  const upcomingSlot = h('div', { hidden: true }); // no empty gap while it loads (or when there's nothing coming up)
  wrap.append(upcomingSlot);
  upcomingSection().then((sec) => { if (sec) upcomingSlot.replaceWith(sec); });
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
    c.avatar, h('span', { class: 'conv-card-text' }, h('strong', null, c.title), h('span', null, isSharing() && !shareAllowed.has(c.unreadKey) ? 'Hidden while sharing' : c.preview || 'No messages yet')),
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
          { label: 'Start a group chat with them', icon: 'people', action: () => openNewConversation(null, { group: true, preselect: [u.id] }) },
          ...groups().filter((g) => !g.memberIds.includes(u.id) && g.memberIds.length < GROUP_MAX).slice(0, 8).map((g) => ({ label: `Add to ${groupName(g)}`, icon: 'userPlus', action: () => api('POST', `/groups/${g.id}/members`, { userId: u.id }).then(() => toast('Added.')).catch((x) => toast(x.message, 'error')) })),
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
          h('span', { class: 'friend-text' }, h('span', { class: 'friend-name' }, nameEl(u), h('span', { class: 'friend-handle' }, u.username)), h('span', { class: 'friend-sub' }, (r.status === 'accepted' && activityLine(u)) || sub))),
        h('div', { class: 'friend-actions' }, actions)));
    }
  };
  search.addEventListener('input', draw);
  draw();
  wrap.append(h('div', { class: 'friends-top' }, h('div', { class: 'friends-search' }, icon('search'), search),
    h('button', { class: 'btn', onclick: () => openNewConversation(null, { group: true }) }, icon('people'), 'New group chat')), listEl);
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
  if (mode === 'latest' && store && store.loaded && !store.hasNewer) {
    trimStore(store, 120);
    await decryptAll(key); return renderMessages(true);
  }
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
      if (!prependOlder(sc, store, fresh)) renderMessages(false);
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
// Keep only the newest messages of a conversation in memory and on screen; older ones load again
// when you scroll up. Without this, a long session made the page heavier and heavier.
function trimStore(store, keep) {
  if (store.list.length <= keep * 1.5 || store.hasNewer) return false;
  store.list.splice(0, store.list.length - keep);
  store.hasMore = true;
  return true;
}
// Scrolling up: add just the older messages at the top instead of redrawing everything.
function prependOlder(sc, store, fresh) {
  const first = sc.querySelector('.msg[data-mid]');
  if (!first) return false;
  const firstMsg = store.list.find((x) => x.id === first.dataset.mid);
  const older = fresh.filter((m) => !firstMsg || m.id < firstMsg.id).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (fresh.length !== older.length) return false;
  const frag = document.createDocumentFragment();
  if (!store.hasMore) frag.append(welcomeBlock());
  let prev = null;
  for (const m of older) {
    if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
      frag.append(h('div', { class: 'day-div', role: 'separator' }, h('span', null, fmtDay(m.createdAt))));
      prev = null;
    }
    frag.append(messageEl(m, prev, 'main'));
    prev = m;
  }
  // The message that used to be first may now join the group above it, and its day divider may be a repeat.
  if (prev && firstMsg) {
    const before = first.previousElementSibling;
    if (before && before.classList.contains('day-div') && new Date(prev.createdAt).toDateString() === new Date(firstMsg.createdAt).toDateString()) before.remove();
    const top = first.previousElementSibling && first.previousElementSibling.classList.contains('day-div') ? null : prev;
    first.replaceWith(messageEl(firstMsg, top, 'main'));
  }
  sc.prepend(frag);
  return true;
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
  const me = S.me.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  if (!store.hasNewer) redrawPendingSends(key);
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
      (author.bot || m.bot || (m.dec && m.dec.bot)) ? h('span', { class: 'bot-tag' }, 'BOT') : null,
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
    const embed = m.dec && m.dec.embed;
    if (text && !hideText && !(embed && text === embed.title)) {
      const html = chat.markdown ? md(text, { mentionName: S.me.username, everyone: authorMayPingEveryone(m) }) : escapeText(text);
      body.append(h('div', { class: `msg-text${chat.jumbo && isJumbo(text) ? ' jumbo' : ''}`, html: html + (m.editedAt ? '<span class="edited" title="Edited">(edited)</span>' : '') }));
    }
    const embeds = chat.embeds ? extractImageUrls(text) : [];
    if (embeds.length) body.append(h('div', { class: 'msg-embeds' }, embeds.map((u) => h('div', { class: `embed-wrap${isGiphy(u) ? ' giphy' : ''}` },
      h('img', { class: 'embed-img', src: mediaUrl(u), alt: isGiphy(u) ? 'GIF' : 'Linked image', loading: 'lazy', referrerpolicy: 'no-referrer', onclick: (e) => openViewer(e.currentTarget) }),
      isGiphy(u) ? h('span', { class: 'giphy-tag' }, /klipy/i.test(u) ? 'KLIPY' : 'GIPHY') : null))));
    if (m.dec && m.dec.p) body.append(pollEl(m));
    const files = filesOf(m);
    if (files.length) body.append(h('div', { class: 'msg-files' }, files.map((f) => attachmentEl(f, m))));
    const wc = watchChips(text);
    if (wc) body.append(wc);
    if (embed) body.append(newsCard(embed));
    if (m.dec && m.dec.bot) body.append(h('div', { class: 'msg-flag', 'data-tip': 'Posted by this server\u2019s news bot from a public feed, so it isn\u2019t end-to-end encrypted. Everything people write still is.' }, 'News bot \u00b7 public feed, not end-to-end encrypted'));
    else if (m.dec && m.dec.legacy) body.append(h('div', { class: 'msg-flag', 'data-tip': 'Sent before end-to-end encryption was turned on. Protected by the server\u2019s encryption only.' }, 'Older message \u2014 not end-to-end encrypted'));
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
// Each GIF gets its own path (/media/gif/<short hash>), not just its own "?u=…". Older app caches ignored
// everything after "?" and showed the same GIF everywhere; a distinct path can't be mixed up.
const urlKey = (u) => { let x = 5381; for (let i = 0; i < u.length; i++) x = ((x * 33) ^ u.charCodeAt(i)) >>> 0; return x.toString(36); };
const mediaUrl = (u) => (isGiphy(u) && S.config.gifProxy && S.mediaToken ? `/media/gif/${urlKey(u)}?u=${encodeURIComponent(u)}&t=${encodeURIComponent(S.mediaToken)}` : u);
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
    ...(ok ? remindItems(m, keyOfMessage(m), textOf(m) || (m.dec && m.dec.p ? `Poll: ${m.dec.p.q}` : 'Attachment')) : []),
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
  if (hsh === '#updates') return setView({ type: 'updates' });
  if (hsh === '#study') return setView({ type: 'study' });
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
    const job = (async () => {
      const res = await fetch(f.url).catch(() => { throw new Error('Couldn\u2019t reach the server. Check your connection and try again.'); });
      if (res.status === 404) throw new Error('This file was deleted.');
      if (!res.ok) throw new Error(`The server couldn\u2019t send this file (${res.status}). Try again in a moment.`);
      const plain = await sec.decryptAttachment(m, f, await res.arrayBuffer());
      return URL.createObjectURL(new Blob([plain], { type: f.type || 'application/octet-stream' }));
    })();
    blobCache.set(f.url, job);
    // A failed try isn't remembered: the next click fetches again instead of failing straight away.
    job.catch(() => { if (blobCache.get(f.url) === job) blobCache.delete(f.url); });
  }
  return blobCache.get(f.url);
}
function fileIcon(type, name) {
  if (/^image\//.test(type)) return 'image';
  if (/pdf|text|document|msword|sheet|presentation/.test(type) || /\.(pdf|txt|md|docx?|xlsx?|pptx?|csv)$/i.test(name)) return 'file';
  return 'file';
}
async function downloadAttachment(m, f, btn) {
  if (btn && btn.disabled) return;
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try {
    const enc = !!f.k || !!m.dmId;
    const href = enc ? await decryptedUrl(m, f) : f.url;
    const a = h('a', { href, download: f.name || 'file' });
    document.body.append(a); a.click(); a.remove();
  } catch (e) {
    toast(`Couldn\u2019t download ${f.name || 'the file'}: ${e.message}`, 'error');
  } finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); } }
}
// A small "Download" button on photos, videos and audio, which otherwise have no way to save them.
function mediaDownloadBtn(m, f) {
  const b = h('button', { class: 'att-dl', type: 'button', title: `Download ${f.name || 'file'}`, 'aria-label': `Download ${f.name || 'file'}`,
    onclick: (e) => { e.stopPropagation(); downloadAttachment(m, f, b); } }, icon('download'));
  return b;
}
const loadQueue = makeQueue(3);
function attachmentEl(f, m) {
  if (f.voice) return voiceEl(f, () => ((f.k || m.dmId) ? decryptedUrl(m, f) : Promise.resolve(f.url)));
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
    holder.append(mediaDownloadBtn(m, f));
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
  // The whole card downloads the file, not just the button.
  const btn = h('button', { class: 'btn ghost sm', type: 'button', onclick: (e) => { e.stopPropagation(); downloadAttachment(m, f, btn); } }, icon('download'), 'Download');
  return h('div', { class: 'att-file', title: `Download ${f.name || 'file'}`, onclick: () => downloadAttachment(m, f, btn) },
    h('span', { class: 'att-file-badge' }, icon(fileIcon(type, f.name || ''), 'ic'), h('span', null, ((f.name || '').split('.').pop() || 'file').slice(0, 4).toUpperCase())),
    h('div', { class: 'att-file-text' }, h('span', { class: 'att-name', title: f.name }, f.name || 'file'), h('span', { class: 'att-size' }, fmtSize(f.size || 0), enc ? h('span', { class: 'att-enc' }, icon('lock', 'ic'), 'Encrypted') : null)),
    btn);
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
  if (m.nonce) dropPendingSend(m.nonce);
  if (key.startsWith('d:')) { S.previews[key] = previewText(m); }
  else {
    const s = S.servers.find((x) => x.id === m.serverId);
    if (isGroup(s)) { s.last = m; s.lastMessageAt = m.createdAt; S.previews['g:' + s.id] = previewText(m, true); }
  }
  if (store && store.loaded && !store.hasNewer && !store.list.find((x) => x.id === m.id)) {
    store.list.push(m);
    const viewingThis = currentKey() === key;
    const scNow = viewingThis && $('#messages');
    const atEnd = scNow && scNow.scrollHeight - scNow.scrollTop - scNow.clientHeight < 160;
    // Busy channel: drop the oldest when you're reading the latest (or not looking at it at all).
    if ((!viewingThis || atEnd) && trimStore(store, 150) && viewingThis) { renderMessages(true); }
    else if (viewingThis) {
      const sc = $('#messages');
      const near = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
      const prev = store.list[store.list.length - 2];
      if (sc) {
        const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
        // Real messages go above any of your own still "sending…".
        const firstPending = sc.querySelector('.msg.sending');
        const put = (node) => (firstPending ? sc.insertBefore(node, firstPending) : sc.append(node));
        if (newDay) put(h('div', { class: 'day-div', role: 'separator' }, h('span', null, fmtDay(m.createdAt))));
        put(messageEl(m, newDay ? null : prev, 'main'));
        if (near || m.authorId === S.me.id) sc.scrollTop = sc.scrollHeight;
      }
    }
  }
  const t = S.typing[key];
  if (t && t.has(m.authorId)) { clearTimeout(t.get(m.authorId)); t.delete(m.authorId); if (currentKey() === key) renderTyping(); }
  if (m.authorId === S.me.id) { if (!S.view.serverId) later(renderSidebar); return; }
  const viewing = currentKey() === key && !document.hidden;
  const level = notifyLevel(key);
  const isDm = key.startsWith('d:') || isGroup(S.servers.find((x) => x.id === m.serverId));
  const mentioned = mentionsMe(m);
  const repliedToMe = m.reply && m.reply.authorId === S.me.id;
  if (!viewing) {
    S.unread.add(key);
    if ((isDm || mentioned || repliedToMe) && level !== 'muted' && !S.blocked.has(m.authorId)) {
      S.mentions.set(key, (S.mentions.get(key) || 0) + 1);
      if (S.me.status !== 'dnd') { playSound(mentionKind(m) || (isDm ? (key.startsWith('d:') ? 'dm' : 'groupDm') : 'reply')); notify(getUser(m.authorId), previewText(m).replace(/^You: /, ''), key); if (!document.hasFocus()) flashTaskbar(); }
    } else if (level === 'all' && !S.blocked.has(m.authorId) && S.me.status !== 'dnd') playSound('message');
  }
  if ((mentioned || repliedToMe) && !S.blocked.has(m.authorId)) {
    addInbox({
      type: mentioned ? 'mention' : 'reply', userId: m.authorId, msgId: m.id,
      title: `${displayName(getUser(m.authorId))} ${mentioned ? 'mentioned you' : 'replied to you'} in ${whereLabel(m)}`,
      text: textOf(m).slice(0, 140),
    });
  }
  // Reading this very channel: nothing in the server bar or channel list changes.
  if (viewing && !isDm && !mentioned && !repliedToMe) return;
  updateTitle();
  later(renderRail);
  if ((isDm && !S.view.serverId) || (!isDm && S.view.serverId === m.serverId) || (isDm && isGroup(currentServer()))) later(renderSidebar);
  if (S.view.type === 'home') later(renderMain);
}
function notify(author, body, key) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && document.hasFocus())) return;
  if (localStorage.getItem('hearth.notify') === 'off') return;
  try {
    const priv = key.startsWith('d:') || isGroup(serverOfChannel(key.slice(2)));
    const shown = priv && isSharing() && !shareAllowed.has(key) ? 'New message (hidden while you share your screen)' : body.slice(0, 140);
    const n = new Notification(displayName(author), { body: shown, icon: author.avatar || undefined, tag: key });
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
  S.panel = P.showMembers && wideEnoughForPanel() && ['channel', 'dm'].includes(S.view.type) ? 'members' : null;
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
  if ((mode === 'thread' || mode === 'pins') && hiddenWhileSharing(privateKey())) return el.append(h('p', { class: 'sidebar-empty' }, 'Hidden while you share your screen.'));
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
          sec.keyChanged(u) ? h('span', { class: 'key-warn', role: 'button', tabindex: '0', 'data-tip': 'Security key changed \u2014 click to verify', onclick: (e) => { e.stopPropagation(); openSafetyNumber(u); } }, icon('shield')) : null),
        activityLine(u) ? h('span', { class: 'member-status' }, activityLine(u)) : cs ? h('span', { class: 'member-status' }, cs) : null));
    };
    for (const r of hoisted) {
      const list2 = sections.get(r.id).sort(byName);
      if (list2.length) list.append(h('div', { class: 'group-label' }, h('span', { style: r.color ? { color: r.color } : null }, `${r.icon ? r.icon + ' ' : ''}${r.name} \u2014 ${list2.length}`)), ...list2.map(row));
    }
    if (online.length) list.append(h('div', { class: 'group-label' }, h('span', null, `Online \u2014 ${online.length}`)), ...online.sort(byName).map(row));
    // Bots working for this server (the news bot while it follows something), like Discord shows them.
    const bots = (server.bots || []).map(getUser).filter((u) => !q || u.username.toLowerCase().includes(q) || displayName(u).toLowerCase().includes(q));
    if (bots.length) list.append(h('div', { class: 'group-label' }, h('span', null, `Bots \u2014 ${bots.length}`)), ...bots.map((u) => h('button', {
      class: 'member', 'data-pop-anchor': '', onclick: (e) => openProfilePop(e.currentTarget, u.id, 'left'),
    }, avatarEl(u, 34, { status: true, meId: S.me.id }),
    h('span', { class: 'member-text' }, h('span', { class: 'member-name' }, nameEl(u), h('span', { class: 'bot-tag' }, 'BOT')),
      h('span', { class: 'member-status' }, 'Posting news from the feeds this server follows')))));
    if (offline.length) list.append(h('div', { class: 'group-label' }, h('span', null, `Offline \u2014 ${offline.length}`)), ...offline.sort(byName).map(row));
    if (!users.length && !bots.length) list.append(h('p', { class: 'sidebar-empty' }, 'No one matches.'));
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
    h('button', { class: 'icon-btn attach', 'aria-label': 'Attach a file or create a poll', 'data-tip': 'Attach or poll', 'data-pop-anchor': '', onclick: (e) => menu(e.currentTarget, [
      { label: 'Upload a file', icon: 'file', action: () => fileIn.click() },
      { label: 'Create a poll', icon: 'check', action: () => openPollCreator((poll) => send('', { poll })) },
    ], { side: 'top' }) }, icon('plus')),
    ta,
    h('div', { class: 'composer-tools' },
      h('button', { class: 'icon-btn', 'aria-label': 'Emoji', 'data-tip': 'Emoji', 'data-pop-anchor': '', onclick: (e) => emojiPicker(e.currentTarget, (em) => insertAtCursor(ta, em), { keepOpen: true }) }, icon('smile')),
      voiceButton(() => box, (file, dur) => send('', { files: [{ file, voice: true, dur }] })),
      (S.config.features || {}).gifs === false ? null : h('button', { class: 'icon-btn', 'aria-label': 'GIFs', 'data-tip': 'GIFs', 'data-pop-anchor': '', onclick: (e) => gifPicker(e.currentTarget, (url) => send(url), { onEmoji: (em) => insertAtCursor(ta, em) }) }, icon('gif')),
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
  // Sending never blocks typing: the box clears at once, the message shows up right away as
  // "sending…", and messages go out one after another in the background (so they stay in order).
  let queue = Promise.resolve();
  // extra: { poll } for a poll, { files } for a voice message; the typed text stays in the box for those.
  function send(overrideText, extra = {}) {
    const text = overrideText != null ? overrideText : ta.value;
    const files = extra.files || (overrideText != null ? [] : state.pending.slice());
    const poll = extra.poll || null;
    if (!text.trim() && !files.length && !poll) return;
    const kk = key();
    const tid = threadId();
    const replyTo = state.replyTo ? state.replyTo.id : null;
    if (overrideText == null) {
      ta.value = '';
      drafts.delete(kk + (tid || ''));
      state.pending = [];
    }
    const old = state.replyTo;
    state.replyTo = null;
    if (old) replaceMessageEl(old);
    renderExtras(); autosize(); update();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, '0')).join('');
    if (id === 'main' && !tid) showPendingSend(kk, nonce, poll ? `\uD83D\uDCCA ${poll.q}` : files.some((f) => f.voice) ? '\uD83C\uDFA4 Voice message' : text, files.some((f) => f.voice) ? 0 : files.length, replyTo);
    queue = queue.then(() => deliver({ kk, tid, text, files, replyTo, nonce, poll }));
    return queue;
  }
  async function deliver({ kk, tid, text, files, replyTo, nonce, poll }) {
    const bar = extras.querySelector('.upload-progress');
    const setProgress = (f) => { if (!bar) return; bar.hidden = f >= 1; bar.firstChild.style.width = Math.round(f * 100) + '%'; };
    try {
      const f = await uploadEncryptedFiles(kk, files, setProgress);
      const msg = await sendTo(kk, tid, { t: text, f, ...(poll ? { p: poll } : {}) }, replyTo, nonce);
      files.forEach((p) => p.url && URL.revokeObjectURL(p.url));
      playSound('sent');
      // Normally the live connection delivers it first; this covers a slow or dropped connection.
      if (msg && msg.id) { if (msg.threadId) onThreadMessage(msg); else onNewMessage(kk, msg); }
      dropPendingSend(nonce);
      const sch = kk.startsWith('c:') ? channelById(kk.slice(2)) : null;
      if (sch && sch.slowmode > 0 && !canIn(sch, PERMS.MANAGE_MESSAGES)) startSlow(sch.slowmode);
    } catch (e) {
      dropPendingSend(nonce);
      const wait = /in (\d+)s/.exec(e.message || '');
      if (e.code === 'slowmode' && wait) startSlow(+wait[1]);
      toast(e.message, 'error');
      // Give the words back so nothing is lost (unless they've already typed something new).
      if (!poll && !files.some((f) => f.voice) && !ta.value.trim() && key() === kk) { ta.value = text; if (!state.pending.length) state.pending = files; renderExtras(); autosize(); update(); }
    } finally { setProgress(1); }
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
  for (const p of files) prepared.push({ ...(p.voice ? { file: p.file } : await prepareImage(p.file, { compress })), orig: p.file, voice: p.voice, dur: p.dur });
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
    out.push({ url: main.url, name: p.file.name, type: p.file.type, size: p.file.size, k: main.k, ...(p.w ? { w: p.w, h: p.h } : {}), ...(th ? { th: { url: th.url, k: th.k } } : {}),
      ...(p.voice ? { voice: true, dur: p.dur } : {}) });
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

async function sendTo(key, threadId, payload, replyTo, nonce) {
  const files = (payload.f || []).flatMap((x) => [x.url, x.th && x.th.url]).filter(Boolean);
  if (key.startsWith('c:')) {
    const channelId = key.slice(2);
    const server = serverOfChannel(channelId);
    if (!server) throw new Error('Channel not found.');
    return withKeyRetry(server.id, async () => {
      const { ciphertext, epoch } = await sec.encryptChannel(server.id, channelId, payload);
      return api('POST', `/channels/${channelId}/messages`, { ciphertext, epoch, replyTo, threadId, files, mentions: mentionedIds(server, payload.t), nonce });
    });
  }
  const ciphertext = await sec.encryptDm(key.slice(2), payload);
  return api('POST', `/dms/${key.slice(2)}/messages`, { ciphertext, replyTo, files, nonce });
}
// "Sending…" copies of your own messages, shown until the real one arrives.
const pendingSends = new Map(); // nonce -> { key, text, files, replyTo, el }
function pendingEl(p) {
  const prevList = (S.msgs[p.key] || { list: [] }).list;
  const fake = { id: 'pending-' + p.nonce, authorId: S.me.id, createdAt: Date.now(), dec: { t: p.text, f: [] }, reactions: [], replyTo: null };
  let el;
  try { el = messageEl(fake, prevList[prevList.length - 1] || null, 'main'); } catch { el = h('div', { class: 'msg' }, h('div', { class: 'msg-gutter' }), h('div', { class: 'msg-body' }, p.text)); }
  el.classList.add('sending');
  el.removeAttribute('data-mid');
  el.oncontextmenu = null;
  if (p.files) el.append(h('div', { class: 'sending-note' }, `Uploading ${p.files} file${p.files === 1 ? '' : 's'}\u2026`));
  return el;
}
function showPendingSend(key, nonce, text, files, replyTo) {
  const p = { key, nonce, text, files, replyTo };
  pendingSends.set(nonce, p);
  const sc = $('#messages');
  if (sc && currentKey() === key) { p.el = pendingEl(p); sc.append(p.el); sc.scrollTop = sc.scrollHeight; }
}
function dropPendingSend(nonce) {
  const p = pendingSends.get(nonce);
  if (!p) return;
  pendingSends.delete(nonce);
  if (p.el) p.el.remove();
}
function redrawPendingSends(key) {
  const sc = $('#messages');
  if (!sc) return;
  for (const p of pendingSends.values()) if (p.key === key) { p.el = pendingEl(p); sc.append(p.el); }
}

// ======================================================================= emoji + GIF pickers
function emojiPicker(anchor, onPick, { keepOpen = false } = {}) {
  popover(anchor, emojiPanel(onPick, { keepOpen }), { side: 'top', align: 'end' });
}
// The emoji grid on its own, so it can also live in the GIF picker's "Emoji" tab.
function emojiPanel(onPick, { keepOpen = false } = {}) {
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
      onmouseenter: () => { clear(preview).append(h('span', { class: 'ep-big' }, isCustom ? h('img', { class: 'cemoji', src: e.url, alt: '' }) : node.cloneNode ? node.cloneNode(true) : node), h('span', null, label), isCustom ? h('span', { class: 'ep-src' }, e.serverName) : ''); },
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
  setTimeout(() => search.focus(), 20);
  return h('div', { class: 'emoji-picker' }, h('div', { class: 'emoji-top' }, search), tabs, grid, preview);
}

// GIF picker, laid out like Discord's: GIFs / Stickers / Emoji tabs; a home screen of big tiles (Favorites,
// Trending, this server's own GIFs, then categories); a back arrow out of any category or search; and results in a
// masonry of two columns that stay put while more load in as you scroll. Also used for "emoji from GIPHY".
const GIF_FAVS = 'hearth.gifFavs';
const gifFavs = () => LS.get(GIF_FAVS, []);
function gifPanel({ onPick, startTab = 'gifs', height = 440, onEmoji = null } = {}) {
  const libOnly = !!S.config.gifLibraryOnly;
  let tab = startTab === 'stickers' ? 'stickers' : startTab === 'emoji' && onEmoji ? 'emoji' : 'gifs';
  let view = startTab === 'favs' ? 'favs' : 'home'; // home | search | trending | library | favs
  let q = '';
  let next = null;
  let loading = false;
  let reqId = 0;
  let lib = null; // { canAdd, count }
  let cols = [];
  const provName = S.config.gifProvider === 'giphy' ? 'GIPHY' : 'KLIPY';
  const tabsEl = h('div', { class: 'xp-tabs', role: 'tablist' });
  const back = h('button', { class: 'xp-back', 'aria-label': 'Back', 'data-tip': 'Back', onclick: () => goHome() }, icon('chevronLeft'));
  const title = h('span', { class: 'xp-title' });
  const input = h('input', { class: 'xp-input', 'aria-label': 'Search GIFs', autocomplete: 'off', spellcheck: 'false' });
  const clearBtn = h('button', { class: 'xp-clear', 'aria-label': 'Clear search', onclick: () => { input.value = ''; q = ''; goHome(); input.focus(); } }, icon('close'));
  const bar = h('div', { class: 'xp-bar' }, back, title, input, h('span', { class: 'xp-search-ic' }, icon('search')), clearBtn);
  const notice = h('div', { class: 'gif-notice', hidden: true });
  const scroller = h('div', { class: 'xp-scroll', role: 'listbox' });
  const credit = h('div', { class: 'gif-credit' });
  const body = h('div', { class: 'xp-body' }, bar, notice, scroller, credit);
  const root = h('div', { class: 'gif-picker xp', style: { height: height + 'px' } }, tabsEl, body);

  const sticker = () => tab === 'stickers';
  const source = () => (view === 'library' || libOnly ? '&source=library' : '');
  // Picking a GIF: library GIFs are sent as a link to this server; the server also counts what's popular.
  const pick = (g) => {
    const out = g.library ? { ...g, url: location.origin + g.url } : g;
    api('POST', '/gifs/used', { id: g.id, url: g.url, title: g.title, query: q, sticker: sticker() }).catch(() => {});
    onPick(out);
  };
  const tile = (g) => {
    const fav = gifFavs().some((x) => x.id === g.id);
    return h('div', { class: 'gif-btn', role: 'option', tabindex: '0', 'aria-label': g.title || 'GIF', title: g.title || '',
      onclick: () => pick(g), onkeydown: (e) => { if (e.key === 'Enter') pick(g); } },
    h('img', { src: mediaUrl(g.preview), alt: '', loading: 'lazy', style: sticker() ? null : { aspectRatio: `${g.width || 1} / ${g.height || 1}` } }),
    h('button', { class: `gif-fav${fav ? ' on' : ''}`, 'aria-label': fav ? 'Remove from favorites' : 'Add to favorites', 'data-tip': fav ? 'Unfavorite' : 'Favorite',
      onclick: (e) => {
        e.stopPropagation();
        const list = gifFavs();
        const has = list.some((x) => x.id === g.id);
        LS.set(GIF_FAVS, has ? list.filter((x) => x.id !== g.id) : [{ ...g, sticker: sticker() }, ...list].slice(0, 200));
        e.currentTarget.classList.toggle('on', !has);
        if (view === 'favs' && has) e.currentTarget.closest('.gif-btn').remove();
      } }, icon('star')),
    g.library && S.me.staffRole ? h('button', { class: 'gif-del', 'aria-label': 'Remove from library', 'data-tip': 'Remove from library', onclick: async (e) => {
      e.stopPropagation();
      if (!(await confirmDialog({ title: 'Remove this GIF from the library?', confirm: 'Remove', danger: true }))) return;
      await api('DELETE', `/gifs/library/${g.id}`).catch((x) => toast(x.message, 'error'));
      e.target.closest('.gif-btn').remove();
    } }, icon('close')) : null);
  };
  // Masonry: each GIF goes into the shortest column, so nothing jumps when more arrive.
  const startMasonry = () => {
    const n = sticker() ? 3 : 2;
    cols = Array.from({ length: n }, () => ({ el: h('div', { class: 'gif-col' }), h: 0 }));
    scroller.append(h('div', { class: `gif-masonry${sticker() ? ' stickers' : ''}` }, cols.map((c) => c.el)));
  };
  const place = (g) => {
    const c = cols.reduce((a, b2) => (b2.h < a.h ? b2 : a));
    c.el.append(tile(g));
    c.h += sticker() ? 1 : (g.height || 1) / (g.width || 1) + 0.04;
  };
  const empty = (msg, ...extra) => scroller.append(h('div', { class: 'gif-empty' }, h('p', null, msg), ...extra));
  const spinner = () => scroller.append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
  const showError = (msg) => {
    clear(scroller);
    empty(msg, S.me && S.me.instanceAdmin && /set up|key/i.test(msg) ? h('button', { class: 'btn primary sm', onclick: () => { closePopover(); openSettings(app, 'instance'); } }, 'Set up GIF search') : null);
  };
  // Add a GIF to this server's library (title + words people will search for).
  const addGif = () => {
    const fileIn = h('input', { type: 'file', accept: 'image/gif,image/webp,image/png', hidden: true });
    fileIn.addEventListener('change', () => {
      const f = fileIn.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) return toast('GIFs for the library can be up to 8 MB.', 'error');
      const titleIn = h('input', { class: 'input', maxlength: '120', placeholder: 'e.g. cat falling off couch', value: f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') });
      const tags = h('input', { class: 'input', maxlength: '200', placeholder: 'funny, cat, fail' });
      const stk = h('input', { type: 'checkbox' });
      closePopover();
      modal({ title: 'Add to this server’s GIFs', size: 'sm',
        body: h('div', { class: 'stack' }, field('Name', titleIn), field('Search words', tags, 'Words people might type to find it.'), h('label', { class: 'row gap' }, stk, 'It’s a sticker (transparent background)')),
        actions: [{ label: 'Cancel' }, { label: 'Add GIF', kind: 'primary', action: async () => {
          const fd = new FormData(); fd.append('file', f, f.name); fd.append('title', titleIn.value); fd.append('tags', tags.value); fd.append('sticker', String(stk.checked));
          await upload('/gifs/library', fd); toast('Added. Everyone on this server can use it now.');
        } }] });
    });
    fileIn.click();
  };

  // ---- results: search, trending, this server's library (infinite scroll)
  const load = async (more = false) => {
    if (loading || (more && next == null)) return;
    loading = true;
    const id = ++reqId;
    if (!more) { clear(scroller); spinner(); }
    try {
      const res = await api('GET', `/gifs?type=${sticker() ? 'stickers' : 'gifs'}&q=${encodeURIComponent(q)}&offset=${more ? encodeURIComponent(next) : ''}${source()}`);
      if (id !== reqId) return;
      if (!more) { clear(scroller); startMasonry(); }
      notice.hidden = !res.limited && !res.stale;
      notice.textContent = res.limited ? `${provName}’s limit was reached for now, so these come from this server’s own GIFs.` : res.stale ? 'Showing saved results while GIF search catches its breath.' : '';
      res.items.forEach(place);
      next = res.nextOffset;
      if (!more && !res.items.length) {
        clear(scroller);
        empty(res.library ? (q ? 'No GIFs here match that yet.' : 'This server has no GIFs of its own yet.') : 'No results. Try another word.',
          res.library && lib && lib.canAdd ? h('button', { class: 'btn primary sm', onclick: addGif }, '+ Add a GIF') : null);
      }
    } catch (e) { if (id === reqId) showError(e.message); } finally { loading = false; }
    // Short first page on a tall picker: keep filling until it scrolls.
    if (id === reqId && next != null && scroller.scrollHeight <= scroller.clientHeight + 50) load(true);
  };

  // ---- home: big tiles, like Discord
  const bigTile = (label, onclick, { img = '', ic = null, cls = '' } = {}) => {
    const t = h('button', { class: `gif-cat ${cls}`, onclick }, img ? h('img', { src: img, alt: '', loading: 'lazy' }) : null, h('span', { class: 'gif-cat-label' }, ic, h('b', null, label)));
    return t;
  };
  const home = async () => {
    const id = ++reqId;
    clear(scroller);
    const grid = h('div', { class: 'gif-home' });
    scroller.append(grid);
    const favs = gifFavs();
    grid.append(bigTile('Favorites', () => go('favs'), { img: favs[0] ? mediaUrl(favs[0].preview) : '', ic: icon('star'), cls: 'fav-tile' }));
    const trend = bigTile(libOnly ? 'Most used' : 'Trending GIFs', () => go('trending'), { ic: icon('flame'), cls: 'trend-tile' });
    grid.append(trend);
    if (!libOnly && lib) grid.append(bigTile(`${S.config.name}’s GIFs`, () => go('library'), { ic: icon('home'), cls: 'lib-tile' }));
    // A moving picture behind "Trending", from the first trending GIF (the server caches it).
    api('GET', `/gifs?type=gifs&q=&offset=${libOnly ? '&source=library' : ''}`).then((r) => {
      const g = r.items && r.items[0];
      if (g && id === reqId) trend.prepend(h('img', { src: mediaUrl(g.preview), alt: '', loading: 'lazy' }));
    }).catch(() => {});
    try {
      const cats = await api('GET', `/gifs/categories${libOnly ? '?source=library' : ''}`);
      if (id !== reqId) return;
      cats.forEach((c) => grid.append(bigTile(c.name, () => { input.value = c.name; q = c.name; go('search'); }, { img: c.preview ? mediaUrl(c.preview) : '' })));
    } catch (e) {
      if (id !== reqId) return;
      if (!/limit/i.test(e.message)) scroller.append(h('div', { class: 'gif-empty' }, h('p', null, e.message),
        S.me && S.me.instanceAdmin && /set up|key/i.test(e.message) ? h('button', { class: 'btn primary sm', onclick: () => { closePopover(); openSettings(app, 'instance'); } }, 'Set up GIF search') : null));
    }
  };
  const favsView = () => {
    reqId++;
    clear(scroller);
    const list = gifFavs();
    if (!list.length) return empty('You haven’t favorited any GIFs yet. Hover over one and click the star.');
    startMasonry();
    list.forEach(place);
  };

  // ---- the top bar and tabs
  const drawTabs = () => {
    clear(tabsEl);
    [['gifs', 'GIFs'], ['stickers', 'Stickers'], ...(onEmoji ? [['emoji', 'Emoji']] : [])].forEach(([k, l]) => tabsEl.append(h('button', {
      class: `xp-tab${tab === k ? ' active' : ''}`, role: 'tab', 'aria-selected': String(tab === k),
      onclick: () => { if (tab === k) return; tab = k; q = ''; input.value = ''; view = 'home'; render(); },
    }, l)));
  };
  const drawBar = () => {
    const titled = view === 'favs' || view === 'trending';
    back.hidden = view === 'home' || (sticker() && view === 'search' && !q);
    title.hidden = !titled;
    title.textContent = view === 'favs' ? 'Favorites' : view === 'trending' ? (libOnly ? 'Most used' : 'Trending GIFs') : '';
    input.hidden = titled;
    clearBtn.hidden = titled || !input.value;
    input.placeholder = sticker() ? `Search ${provName} stickers` : view === 'library' || libOnly ? `Search ${S.config.name}’s GIFs` : `Search ${provName}`;
    clear(credit).append(view === 'library' || libOnly ? h('span', null, 'This server’s own GIFs: free, no limits') : h('span', null, `Powered by ${provName}`));
    if ((view === 'library' || libOnly) && lib && lib.canAdd) credit.append(h('button', { class: 'link-btn', onclick: addGif }, '+ Add a GIF'));
  };
  const go = (v) => { view = v; render(); scroller.scrollTop = 0; };
  const goHome = () => { q = ''; input.value = ''; view = sticker() ? 'search' : 'home'; render(); };
  function render() {
    drawTabs();
    if (tab === 'emoji') {
      reqId++;
      root.classList.add('emoji-mode');
      clear(body).append(emojiPanel(onEmoji, { keepOpen: true }));
      return;
    }
    root.classList.remove('emoji-mode');
    if (!body.contains(bar)) clear(body).append(bar, notice, scroller, credit);
    if (sticker() && view === 'home') view = 'search'; // stickers open straight on trending stickers
    notice.hidden = true;
    drawBar();
    if (view === 'favs') return favsView();
    if (view === 'home') return home();
    load();
  }
  input.addEventListener('input', debounce(() => {
    q = input.value.trim();
    clearBtn.hidden = !input.value;
    if (view === 'library') return render();
    view = q || sticker() ? 'search' : 'home';
    render();
  }, 300));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = scroller.querySelector('.gif-btn'); if (first) first.click(); }
    if (e.key === 'Backspace' && !input.value && view !== 'home') goHome();
  });
  scroller.addEventListener('scroll', () => { if (view !== 'home' && view !== 'favs' && scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 400) load(true); });
  api('GET', '/gifs/library').then((x) => { lib = x; render(); }).catch(() => render());
  setTimeout(() => input.focus(), 30);
  return root;
}
function gifPicker(anchor, onPick, { onEmoji = null } = {}) {
  popover(anchor, gifPanel({ onPick: (g) => { closePopover(); onPick(g.url); }, onEmoji }), { side: 'top', align: 'end' });
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
      // While you share your screen, messages from DMs and group chats stay out of the results (see shareCover).
      const privateHidden = (key) => (key.startsWith('d:') || isGroup(serverOfChannel(key.slice(2)))) && hiddenWhileSharing(key);
      const pool = (scopeKey ? convoMessages(scopeKey).map((m) => ({ m, key: scopeKey })) : allLoaded()).filter(({ key }) => !privateHidden(key));
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
  // The full page is the best part of a profile: make it one obvious click away.
  const open = () => openProfileModal(u.id);
  card.querySelector('.pc-inner')?.prepend(h('button', { class: 'btn primary pc-open-page', onclick: open }, icon('user'), u.id === S.me.id ? 'View my page' : 'View full profile'));
  card.querySelectorAll('.pc-av, .pc-name').forEach((el) => { el.style.cursor = 'pointer'; el.addEventListener('click', open); });
  if (S.blocked.has(u.id)) card.prepend(h('div', { class: 'pc-blocked' }, icon('ban'), 'Blocked'));
  popover(anchor, card, { side, className: 'pop-profile' });
}
function topFriendsEl(u) {
  const ids = ((u.profile || {}).topFriends || []).filter((id) => S.users[id]);
  if (!ids.length) return null;
  return h('div', { class: 'pc-section' }, h('div', { class: 'pc-label' }, 'Top friends'),
    h('div', { class: 'pc-friends' }, ids.map((id) => { const f = getUser(id); return h('button', { class: 'pc-friend', onclick: () => openProfileModal(id) }, avatarEl(f, 44), h('span', null, displayName(f))); })));
}
// ---- People: browse everyone's profile (MySpace "browse"), sorted and searchable.
function peopleView() {
  const wrap = h('div', { class: 'people-view' });
  const search = h('input', { class: 'input search-input', placeholder: 'Search names, headlines and interests' });
  let sort = 'online';
  const grid = h('div', { class: 'people-grid' });
  const seg = h('div', { class: 'seg' });
  const drawSeg = () => clear(seg).append(...[['online', 'Online first'], ['new', 'Newest'], ['views', 'Most viewed'], ['name', 'A\u2013Z']].map(([k, l]) => h('button', { class: `seg-btn${sort === k ? ' active' : ''}`, onclick: () => { sort = k; drawSeg(); load(); } }, l)));
  let t = 0; let req = 0;
  const load = async () => {
    const id = ++req;
    try {
      const r = await api('GET', `/people?sort=${sort}&q=${encodeURIComponent(search.value.trim())}`);
      if (id !== req) return;
      r.people.forEach(setUser);
      clear(grid);
      if (!r.people.length) grid.append(h('div', { class: 'panel-empty' }, icon('user'), h('p', null, search.value ? 'Nobody matches that.' : 'Join a server or add friends to see people here.')));
      r.people.forEach((u) => grid.append(personCard(u)));
    } catch (e) { toast(e.message, 'error'); }
  };
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  drawSeg();
  wrap.append(
    h('div', { class: 'people-me' }, avatarEl(S.me, 48), h('div', { class: 'people-me-text' }, h('strong', null, 'Your profile page'), h('span', null, 'Make it yours: themes, a song, a comment wall, your own effects.')),
      h('button', { class: 'btn ghost sm', onclick: () => openProfileModal(S.me.id) }, 'View'), h('button', { class: 'btn primary sm', onclick: () => openSettings(app, 'page') }, 'Edit')),
    h('div', { class: 'people-tools' }, h('div', { class: 'friends-search' }, icon('search'), search), seg),
    grid);
  load();
  return wrap;
}
function personCard(u) {
  const p = u.profile || {};
  const online = u.presence && u.presence !== 'offline';
  return h('button', { class: 'person-card', onclick: () => openProfileModal(u.id), style: { '--c1': p.themePrimary, '--c2': p.themeSecondary } },
    h('div', { class: 'person-banner', style: { background: p.bannerColor || 'var(--accent)' } }, u.banner ? h('img', { class: 'cropped', src: u.banner, alt: '', loading: 'lazy', style: cropStyle(p.bannerCrop) }) : null),
    h('div', { class: 'person-av' }, avatarEl(u, 64, { status: true, meId: S.me.id })),
    h('div', { class: 'person-body' },
      nameEl(u, { tag: 'strong', cls: 'person-name' }),
      h('span', { class: 'person-handle' }, '@' + u.username, u.supporter ? ' \uD83D\uDC9C' : ''),
      p.headline ? h('span', { class: 'person-headline' }, `\u201C${p.headline}\u201D`) : p.mood && p.mood.text ? h('span', { class: 'person-headline' }, `${p.mood.emoji || ''} ${p.mood.text}`) : null,
      (p.interests || []).length ? h('div', { class: 'pc-tags' }, p.interests.slice(0, 3).map((x) => h('span', { class: 'pc-tag' }, x))) : null,
      h('span', { class: 'person-meta' }, online ? 'Online now' : `Joined ${fmtDay(u.createdAt)}`, u.views ? ` \u00b7 ${u.views} views` : '')));
}
// The full, MySpace-style profile page.
async function openProfileModal(userId) {
  closePopover();
  let data;
  try { data = await api('GET', `/users/${userId}/page`); } catch (e) { return toast(e.message, 'error'); }
  (data.topFriends || []).forEach(setUser);
  data.comments.forEach((c) => c.author && setUser(c.author));
  const u = getUser(userId);
  let m = null;
  const view = renderPage(data, u, {
    me: S.me, isStaff: !!S.me.staffRole,
    actions: u.id === S.me.id ? null : relationshipActions(u),
    openUser: (id) => { m.close(); openProfileModal(id); },
    onEdit: () => { m.close(); openSettings(app, 'page'); },
  });
  m = modal({ size: 'full', className: 'mys-modal', title: `${displayName(u)}'s profile`, body: h('div', { class: 'mys-host' }, h('button', { class: 'icon-btn mys-close', 'aria-label': 'Close', onclick: () => m.close() }, icon('close')), view), onClose: stopSong });
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

// Coming back from Stripe (memberships): say what happened and open the right place.
function backFromStripe() {
  const q = new URLSearchParams(location.search);
  const what = q.get('membership');
  if (!what) return;
  history.replaceState(null, '', '/' + location.hash);
  const sv = S.servers.find((x) => x.id === q.get('server'));
  if (what === 'thanks') toast('\u2B50 Thanks! Your membership starts as soon as Stripe confirms the payment (a few seconds).');
  else if (what === 'cancelled') toast('No payment was made.');
  else if ((what === 'connected' || what === 'connect') && sv) {
    openServerSettings(sv, 'memberships');
    if (what === 'connected') api('POST', `/servers/${sv.id}/memberships/refresh`).then((r) => toast(r.ready ? 'Stripe is connected: you can be paid.' : 'Stripe still needs a few details from you.')).catch(() => {});
  }
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
    server.memberships && !isOwner(server) ? { label: 'Memberships', icon: 'star', action: () => openMemberships(server) } : null,
    { label: fav ? 'Remove from favorites' : 'Add to favorites', icon: 'star', action: () => toggleFavorite('s:' + server.id) },
    ...folders.serverMenuExtras(server),
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
    body: h('div', { class: 'stack' }, field('Invite link or code', input), preview,
      // In a browser on a computer: hand the invite to the installed desktop app instead.
      code && !window.hearthDesktop && !/Android|iPhone|iPad/.test(navigator.userAgent)
        ? h('p', { class: 'field-hint' }, 'Have the desktop app? ', h('a', { href: `hearth://invite/${encodeURIComponent(code)}` }, 'Open this invite in the app')) : null),
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
// Server settings → News bot: follow topics, YouTube channels, subreddits, Steam games, GitHub projects or any
// RSS feed; the bot posts only new items into the chosen channel.
const FEED_KINDS = [
  ['topic', 'Topic', 'Anything: a game, a team, a band, a company\u2026', 'e.g. Elden Ring DLC'],
  ['youtube', 'YouTube', 'A channel\u2019s new videos.', 'youtube.com/@channel or @handle'],
  ['reddit', 'Reddit', 'New posts in a subreddit.', 'e.g. pcgaming'],
  ['steam', 'Steam game', 'Patch notes and announcements for a game.', 'Game name or Steam store link'],
  ['github', 'GitHub', 'New releases of a project.', 'owner/project'],
  ['rss', 'RSS', 'Any site\u2019s RSS or Atom feed.', 'https://example.com/feed.xml'],
];
async function newsBotTab(s, body) {
  clear(body).append(h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
  let feeds = [];
  try { feeds = await api('GET', `/servers/${s.id}/feeds`); } catch (e) { clear(body).append(h('p', { class: 'form-error' }, e.message)); return; }
  const textChannels = (s.channels || []).filter((c) => c.type === 'text');
  const chName = (id) => (textChannels.find((c) => c.id === id) || {}).name || 'deleted channel';
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  let kind = 'topic';
  const query = h('input', { class: 'input', placeholder: FEED_KINDS[0][3] });
  const hint = h('span', { class: 'field-hint' }, FEED_KINDS[0][2]);
  const channel = h('select', { class: 'input' }, textChannels.map((c) => h('option', { value: c.id }, `#${c.name}`)));
  const keywords = h('input', { class: 'input', placeholder: 'optional: patch, update, release' });
  const postNow = h('input', { type: 'checkbox', checked: true });
  const preview = h('div', { class: 'stack' });
  const kindChips = h('div', { class: 'chips' });
  const drawKinds = () => {
    clear(kindChips).append(...FEED_KINDS.map(([k, l, d, ph]) => h('button', { type: 'button', class: `chip${kind === k ? ' active' : ''}`, onclick: () => { kind = k; query.placeholder = ph; hint.textContent = d; clear(preview); drawKinds(); } }, l)));
  };
  drawKinds();
  const doPreview = async (btn) => {
    btn.disabled = true; clear(preview).append(h('span', { class: 'spinner' }));
    try {
      const r = await api('POST', `/servers/${s.id}/feeds/preview`, { kind, query: query.value });
      clear(preview).append(h('p', { class: 'muted-p' }, h('b', null, r.title || 'Feed'), ` \u2014 the newest items right now (these count as already seen; only newer ones get posted):`),
        ...r.items.map((i) => h('div', { class: 'feed-prev' }, i.image ? h('img', { src: mediaNewsUrl(i.image), alt: '', loading: 'lazy' }) : h('span', { class: 'feed-prev-ph' }, icon('megaphone')),
          h('div', { class: 'act-text' }, h('a', { class: 'act-title', href: i.link, target: '_blank', rel: 'noopener noreferrer' }, i.title), h('span', { class: 'act-sub' }, i.date ? new Date(i.date).toLocaleString() : '')))));
      if (!r.items.length) preview.append(h('p', { class: 'field-hint' }, 'Nothing in it right now, which is fine: new items will still get posted.'));
    } catch (e) { clear(preview).append(h('p', { class: 'form-error' }, e.message)); }
    btn.disabled = false;
  };
  const list = h('div', { class: 'adm-table' }, ...feeds.map((f) => h('div', { class: 'adm-row feed-row' },
    h('div', { class: 'act-text' }, h('b', null, f.title), h('span', { class: 'act-sub' }, `${f.kindName} \u00b7 into #${chName(f.channelId)}${f.keywords ? ` \u00b7 only \u201c${f.keywords}\u201d` : ''}`)),
    h('span', { class: 'stat-sub' }, `${f.posted} posted \u00b7 checked ${ago(f.lastCheck)}`),
    f.paused ? h('span', { class: 'rpill warn' }, 'Paused') : f.lastError ? h('span', { class: 'rpill bad', 'data-tip': f.lastError }, 'Problem') : h('span', { class: 'rpill ok' }, 'Working'),
    h('span', { class: 'row gap tight' },
      h('button', { class: 'btn ghost sm', onclick: async (e) => { e.currentTarget.disabled = true; try { const r = await api('POST', `/feeds/${f.id}/check`); toast(r.posted ? `Posted ${r.posted} new item${r.posted === 1 ? '' : 's'}.` : r.feed.lastError ? `Problem: ${r.feed.lastError}` : 'Working \u2014 nothing new since the last check. New items are posted as soon as they come out.'); } catch (x) { toast(x.message, 'error'); } newsBotTab(s, body); } }, 'Check now'),
      h('button', { class: 'btn ghost sm', onclick: async () => { await api('PATCH', `/feeds/${f.id}`, { paused: !f.paused }); newsBotTab(s, body); } }, f.paused ? 'Resume' : 'Pause'),
      h('button', { class: 'btn ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: `Stop following ${f.title}?`, confirm: 'Remove', danger: true })) { await api('DELETE', `/feeds/${f.id}`); newsBotTab(s, body); } } }, 'Remove')))));
  clear(body).append(
    h('h3', null, 'News bot'),
    h('p', { class: 'muted-p' }, 'Follow things your server cares about. The bot checks every 10 minutes and posts only new items, never old news. Its posts are public news, so they aren\u2019t end-to-end encrypted (and say so); everything people write still is.'),
    feeds.length ? list : h('p', { class: 'field-hint' }, 'Not following anything yet.'),
    h('h4', null, 'Follow something new'),
    kindChips,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'What to follow'), query, hint),
    h('div', { class: 'grid-2' }, field('Post into', channel), field('Only posts mentioning (optional)', keywords, 'Comma-separated words. Leave empty for everything.')),
    h('label', { class: 'row gap tight' }, postNow, h('span', null, 'Post the newest item right now, so you can see it working')),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn', onclick: (e) => doPreview(e.currentTarget) }, 'Preview'),
      h('button', { class: 'btn primary', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try {
          if (!textChannels.length) throw new Error('Make a text channel first.');
          const f = await api('POST', `/servers/${s.id}/feeds`, { kind, query: query.value, channelId: channel.value, keywords: keywords.value, postLatest: postNow.checked });
          toast(`Following ${f.title}. New items will show up in #${chName(f.channelId)}.`);
          newsBotTab(s, body);
        } catch (x) { toast(x.message, 'error'); b.disabled = false; }
      } }, 'Follow')),
    preview);
}
const newsKey = (u) => { let x = 5381; for (let i = 0; i < u.length; i++) x = ((x * 33) ^ u.charCodeAt(i)) >>> 0; return x.toString(36); };
const mediaNewsUrl = (u) => (u ? `/media/news/${newsKey(u)}?u=${encodeURIComponent(u)}&t=${encodeURIComponent(S.mediaToken || '')}` : '');
function newsCard(e) {
  let host = '';
  try { host = new URL(e.url).hostname.replace(/^www\./, ''); } catch { /* bad link */ }
  return h('a', { class: `news-card kind-${e.kind || 'rss'}`, href: e.url, target: '_blank', rel: 'noopener noreferrer nofollow' },
    h('div', { class: 'news-text' },
      h('span', { class: 'news-source' }, e.source || host),
      h('span', { class: 'news-title' }, e.title),
      e.summary ? h('span', { class: 'news-summary' }, e.summary.length > 220 ? `${e.summary.slice(0, 220)}\u2026` : e.summary) : null,
      h('span', { class: 'news-meta' }, [host, e.date ? fmtStamp(e.date) : ''].filter(Boolean).join(' \u00b7 '))),
    e.image ? h('img', { class: 'news-img', src: mediaNewsUrl(e.image), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (ev) => ev.currentTarget.remove() }) : null);
}

function openServerSettings(server, startTab = 'overview') {
  if (!server) return;
  const live = () => S.servers.find((s) => s.id === server.id) || server;
  const TABS = [
    ['overview', 'Overview', 'info', (s) => can(s, PERMS.MANAGE_SERVER)],
    ['appearance', 'Appearance', 'palette', (s) => can(s, PERMS.MANAGE_SERVER)],
    ['roles', 'Roles', 'shield', (s) => can(s, PERMS.MANAGE_ROLES)],
    ['members', 'Members', 'people', (s) => can(s, PERMS.MANAGE_ROLES) || can(s, PERMS.KICK_MEMBERS) || can(s, PERMS.BAN_MEMBERS)],
    ['emoji', 'Emoji', 'smile', (s) => can(s, PERMS.MANAGE_EMOJIS)],
    ['news', 'News bot', 'megaphone', (s) => !isGroup(s) && can(s, PERMS.MANAGE_SERVER)],
    ['bans', 'Bans', 'ban', (s) => can(s, PERMS.BAN_MEMBERS)],
    ['memberships', 'Memberships', 'star', (s) => !isGroup(s) && isOwner(s) && s.membershipsOn],
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
    ({ overview, appearance, roles, members, emoji, news: (sv) => newsBotTab(sv, body), memberships: (sv) => membershipsTab(sv, body, { roles: sv.roleDefs }), bans, danger })[tab](s);
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

// New DM, new group chat, or adding people to a group. Friends are listed first, then people you share a server
// with (those are the only people a group can include).
const GROUP_MAX = 25;
function openNewConversation(existingGroup = null, { group = false, preselect = [] } = {}) {
  const isFriend = (id) => (S.relationships[id] || {}).status === 'accepted';
  const known = Object.values(S.users).filter((u) => u.id !== S.me.id && !u.bot && !u.deleted && !S.blocked.has(u.id) && (!existingGroup || !existingGroup.memberIds.includes(u.id)));
  const room = existingGroup ? GROUP_MAX - existingGroup.memberIds.length : GROUP_MAX - 1;
  const picked = new Set(preselect.filter((id) => known.some((u) => u.id === id)));
  const groupMode = () => !!existingGroup || group || picked.size > 1;
  const input = h('input', { class: 'input', placeholder: 'Search friends and people you know', 'aria-label': 'Search people' });
  const nameIn = h('input', { class: 'input', maxlength: '64', placeholder: 'Optional, e.g. "Study group" or "Squad"' });
  const nameField = field('Group name', nameIn);
  const chips = h('div', { class: 'pick-chips' });
  const results = h('div', { class: 'quick-list' });
  const hint = h('p', { class: 'field-hint' });
  const row = (u) => h('button', { class: `quick-row${picked.has(u.id) ? ' picked' : ''}`, 'aria-pressed': String(picked.has(u.id)), onclick: () => {
    if (picked.has(u.id)) picked.delete(u.id); else if (picked.size < room) picked.add(u.id); else toast(`A group chat can have up to ${GROUP_MAX} people.`);
    draw();
  } },
  avatarEl(u, 30, { status: true, meId: S.me.id }), h('span', { class: 'quick-text' }, h('strong', null, displayName(u)), h('span', null, u.username)),
  h('span', { class: 'pick-box' }, picked.has(u.id) ? icon('check') : null));
  const draw = () => {
    clear(chips);
    picked.forEach((id) => { const u = getUser(id); chips.append(h('button', { class: 'chip active', onclick: () => { picked.delete(id); draw(); } }, displayName(u), icon('close'))); });
    clear(results);
    const q = input.value.trim().toLowerCase();
    const match = (u) => !q || u.username.toLowerCase().includes(q) || displayName(u).toLowerCase().includes(q);
    const byName = (a, b) => displayName(a).localeCompare(displayName(b));
    const friends = known.filter((u) => isFriend(u.id) && match(u)).sort(byName);
    const others = known.filter((u) => !isFriend(u.id) && match(u)).sort(byName).slice(0, 40);
    if (friends.length) results.append(h('div', { class: 'list-label' }, `Friends — ${friends.length}`), ...friends.map(row));
    if (others.length) results.append(h('div', { class: 'list-label' }, 'From your servers'), ...others.map(row));
    if (!friends.length && !others.length) results.append(h('p', { class: 'muted-p' }, q ? 'No one matches.' : 'Add some friends first (Friends → Add friend). You can also include anyone who shares a server with you.'));
    nameField.hidden = !!existingGroup || !groupMode();
    hint.textContent = existingGroup ? `Pick people to add (room for ${room - picked.size} more).`
      : groupMode() ? `${picked.size ? `${picked.size + 1} people including you` : 'Pick the people to include'} — up to ${GROUP_MAX}. Everyone in the group can add more people later.`
        : 'Pick one person for a direct message, or several for a group chat.';
    startBtn.textContent = existingGroup ? 'Add' : groupMode() ? 'Create group chat' : 'Start';
  };
  input.addEventListener('input', draw);
  let startBtn;
  const mdl = modal({
    title: existingGroup ? `Add people to ${groupName(existingGroup)}` : group ? 'New group chat' : 'New message', size: 'sm',
    body: h('div', { class: 'stack' }, nameField, input, chips, results, hint),
    actions: [{ label: 'Cancel' }, { label: existingGroup ? 'Add' : 'Start', kind: 'primary', action: async () => {
      const ids = [...picked];
      if (!ids.length) throw new Error('Pick at least one person.');
      if (existingGroup) { for (const id of ids) await api('POST', `/groups/${existingGroup.id}/members`, { userId: id }); toast(ids.length === 1 ? 'Added.' : `Added ${ids.length} people.`); return; }
      if (ids.length === 1 && !group) return openDmWith(ids[0]);
      const g = await api('POST', '/groups', { userIds: ids, name: nameIn.value.trim() });
      if (!S.servers.find((x) => x.id === g.id)) S.servers.push(g);
      if (g.keyState) await sec.applyState(g.keyState);
      openGroup(g.id);
    } }],
  });
  startBtn = mdl.box.querySelector('.modal-foot .btn.primary');
  draw();
  setTimeout(() => input.focus(), 30);
  return mdl;
}
// Members of a group chat: who's in it, who owns it; the owner can remove people or hand the group over.
function manageGroup(g) {
  const list = h('div', { class: 'quick-list' });
  const draw = () => {
    const cur = S.servers.find((x) => x.id === g.id) || g;
    clear(list);
    const mine = cur.ownerId === S.me.id;
    cur.memberIds.map(getUser).sort((a, b) => (a.id === cur.ownerId ? -1 : b.id === cur.ownerId ? 1 : displayName(a).localeCompare(displayName(b)))).forEach((u) => list.append(h('div', { class: 'quick-row static' },
      avatarEl(u, 30, { status: true, meId: S.me.id }),
      h('span', { class: 'quick-text' }, h('strong', null, displayName(u), u.id === S.me.id ? ' (you)' : ''), h('span', null, u.id === cur.ownerId ? 'Owner' : u.username)),
      mine && u.id !== S.me.id ? h('span', { class: 'row gap tight' },
        h('button', { class: 'btn ghost sm', onclick: async () => { if (await confirmDialog({ title: `Make ${displayName(u)} the owner?`, text: 'They’ll be able to remove people. You stay in the group.', confirm: 'Make owner' })) { await api('POST', `/groups/${cur.id}/owner`, { userId: u.id }).catch((e) => toast(e.message, 'error')); setTimeout(draw, 300); } } }, 'Make owner'),
        h('button', { class: 'btn ghost sm danger-text', onclick: async () => { if (await confirmDialog({ title: `Remove ${displayName(u)}?`, text: 'They won’t see new messages. The group switches to a new encryption key.', confirm: 'Remove', danger: true })) { await api('DELETE', `/groups/${cur.id}/members/${u.id}`).catch((e) => toast(e.message, 'error')); setTimeout(draw, 300); } } }, 'Remove')) : null)));
  };
  draw();
  modal({ title: `${groupName(g)} — members`, size: 'sm', body: h('div', { class: 'stack' }, list,
    h('button', { class: 'btn', onclick: () => openNewConversation(S.servers.find((x) => x.id === g.id) || g) }, icon('userPlus'), 'Add people')) });
}
// Group picture: any member can set one (like the name).
function changeGroupIcon(g) {
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true });
  fileIn.onchange = async () => {
    const f = fileIn.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('icon', f);
    try { await upload(`/servers/${g.id}/icon`, fd); toast('Group picture updated.'); } catch (e) { toast(e.message, 'error'); }
  };
  document.body.append(fileIn); fileIn.click(); setTimeout(() => fileIn.remove(), 60000);
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
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || !!window.hearthDesktop || androidApp.on;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Installed. You can open it from your apps like any other program.'); });
async function installApp() {
  if (!installPrompt) return false;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  return outcome === 'accepted';
}
// The desktop app downloaded an update from this server: offer to restart into it (never mid-call by itself).
function showAppUpdate(version) {
  if (document.querySelector('.update-bar.app-update')) return;
  const bar = h('div', { class: 'update-bar app-update', role: 'status' }, icon('download'),
    h('span', null, `The ${S.config.name || 'Hearth'} app ${version ? `${version} ` : ''}is ready to install.`),
    h('button', { class: 'btn primary sm', onclick: async () => { if (voice && voice.channelId && !(await confirmDialog({ title: 'Restart now?', text: 'Restarting leaves your call. It takes a few seconds.', confirm: 'Restart' }))) return; installUpdate(); } }, 'Restart now'),
    ibtn('close', 'Later (it installs when you quit)', () => bar.remove(), { cls: 'sm' }));
  document.body.append(bar);
}
function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  hadController = !!navigator.serviceWorker.controller;
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
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (wantReload) { wantReload = false; location.reload(); return; }
    // A new version took over in the background: the next reload uses it. Let people do it when it suits them.
    if (S.me && !document.querySelector('.update-bar') && hadController) {
      document.body.append(h('div', { class: 'update-bar', role: 'status' }, icon('arrowUp'), h('span', null, 'Hearth was updated.'),
        h('button', { class: 'btn primary sm', onclick: () => location.reload() }, 'Reload'), ibtn('close', 'Later', (e) => e.currentTarget.closest('.update-bar').remove(), { cls: 'sm' })));
    }
  });
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
    (S.config.features || {}).watch === false ? null : h('button', { class: `round-btn${S.watch[room] ? ' on' : ''}`, 'data-tip': S.watch[room] ? 'Add a video to the queue' : 'Watch together', 'aria-label': 'Watch together', onclick: () => openWatchStart(room, !!S.watch[room]) }, icon('eye')),
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
  // The shared video only has a placeholder here: the player itself lives in its own layer and is laid over this
  // box (moving a video in the page would reload it), or shrinks to a mini player when you're elsewhere.
  const inCall = voice && voice.channelId === room;
  let host = el.querySelector(':scope > .cs-watch-host');
  if (inCall && S.watch[room]) {
    if (!host) host = h('div', { class: 'cs-watch-host', dataset: { room } });
  } else if (host) { host.remove(); host = null; }
  syncWatchDock();
  [...el.children].forEach((c) => { if (c !== host) c.remove(); });
  const rest = [tiles.length ? body : h('div', { class: 'empty-state' }, h('p', null, 'No one\u2019s here yet.')), callControls(room)];
  if (host) { if (!host.parentNode) el.append(host); el.insertBefore(head, host); el.append(...rest); el.classList.add('watching'); }
  else { el.append(head, ...rest); el.classList.remove('watching'); }
}
const watchCtx = (room) => ({
  socket, me: S.me, isStaff: !!S.me.staffRole,
  userName: (id) => (id ? displayName(getUser(id)) : 'someone'),
  openStart: (queue) => openWatchStart(room, queue),
});
// Open the page of the call you're in (voice channel, DM or group).
function goToCall(room) {
  if (!room) return;
  if (room.startsWith('dm:')) return openDm(room.slice(3));
  const ch = channelById(room);
  const srv = ch && serverOfChannel(ch.id);
  if (srv && isGroup(srv)) openGroup(srv.id); else if (ch && srv) openVoiceRoom(ch.id, srv.id);
}

// ---- the watch-together dock
// The shared video lives in one fixed layer that is never moved around the page (moving a video reloads it,
// which paused it and made it jump). When the call is on screen it's laid exactly over the call's video box;
// anywhere else in the app it becomes a mini player in the corner that keeps playing in sync. You can drag the
// mini player, go back to the call, or hide it (the sound keeps playing; it comes back in the call).
const wtDock = { el: null, body: null, head: null, title: null, room: null, hidden: false, raf: 0, pos: null, mode: '' };
function wtDockEl() {
  if (wtDock.el) return wtDock.el;
  try { wtDock.pos = JSON.parse(sessionStorage.getItem('hearth.wtMini') || 'null'); } catch { wtDock.pos = null; }
  wtDock.title = h('span', { class: 'wt-dock-title' });
  wtDock.head = h('div', { class: 'wt-dock-head' },
    icon('eye', 'ic'), wtDock.title,
    ibtn('maximize', 'Back to the call', () => goToCall(wtDock.room), { cls: 'sm' }),
    ibtn('close', 'Hide (it keeps playing)', () => { wtDock.hidden = true; placeWatchDock(); }, { cls: 'sm' }));
  wtDock.body = h('div', { class: 'wt-dock-body' });
  wtDock.el = h('div', { class: 'wt-dock', hidden: true }, wtDock.head, wtDock.body);
  // Drag the mini player by its top bar.
  wtDock.head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || wtDock.mode !== 'mini') return;
    const r = wtDock.el.getBoundingClientRect(); const dx = e.clientX - r.left; const dy = e.clientY - r.top;
    wtDock.head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      wtDock.pos = { x: Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx)), y: Math.max(0, Math.min(innerHeight - r.height, ev.clientY - dy)) };
      placeWatchDock();
    };
    const up = () => { wtDock.head.removeEventListener('pointermove', move); try { sessionStorage.setItem('hearth.wtMini', JSON.stringify(wtDock.pos)); } catch { /* private mode */ } };
    wtDock.head.addEventListener('pointermove', move);
    wtDock.head.addEventListener('pointerup', up, { once: true });
  });
  wtDock.head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) goToCall(wtDock.room); });
  document.body.append(wtDock.el);
  return wtDock.el;
}
// Called whenever the call or the shared video changes: show, move or drop the player.
function syncWatchDock() {
  const room = voice && voice.channelId;
  const state = room && S.watch[room];
  // Left the call (or switched to another one): that video is done for us.
  if (wtDock.room && wtDock.room !== room) { dropWatchPlayer(wtDock.room); delete S.watch[wtDock.room]; wtDock.room = null; }
  if (!state) {
    if (wtDock.room) { dropWatchPlayer(wtDock.room); wtDock.room = null; }
    if (wtDock.el) wtDock.el.hidden = true;
    cancelAnimationFrame(wtDock.raf); wtDock.raf = 0; wtDock.hidden = false;
    return;
  }
  const p = watchPlayer(room, watchCtx(room));
  wtDockEl();
  if (p.el.parentNode !== wtDock.body) { clear(wtDock.body).append(p.el); p.apply(state); }
  wtDock.room = room;
  wtDock.title.textContent = state.item.title || state.item.link || 'Watching together';
  if (!wtDock.raf) { const loop = () => { placeWatchDock(); wtDock.raf = requestAnimationFrame(loop); }; wtDock.raf = requestAnimationFrame(loop); }
}
// Every frame while something is playing: over the call's box if it's on screen, otherwise the mini player.
function placeWatchDock() {
  const el = wtDock.el;
  if (!el || !wtDock.room) return;
  if (wtDock.body.querySelector('.wt-is-full')) { el.style.clipPath = ''; el.hidden = false; return; } // full screen: leave it be
  const host = $$('.cs-watch-host').find((x) => x.dataset.room === wtDock.room && x.isConnected && x.getClientRects().length);
  const style = el.style;
  if (host) {
    wtDock.hidden = false;
    const r = host.getBoundingClientRect();
    // Only the part of the box that's visible in its scrolling area (the video mustn't float over other things).
    let clip = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
    for (let a = host.parentElement; a && a !== document.body; a = a.parentElement) {
      const o = getComputedStyle(a);
      if (/(auto|scroll|hidden)/.test(o.overflowY + o.overflowX)) { const ar = a.getBoundingClientRect(); clip = { top: Math.max(clip.top, ar.top), bottom: Math.min(clip.bottom, ar.bottom), left: Math.max(clip.left, ar.left), right: Math.min(clip.right, ar.right) }; }
    }
    // The call's buttons stick to the bottom of the call while you scroll: never cover them.
    const ctl = host.parentElement && host.parentElement.querySelector(':scope > .cs-controls');
    if (ctl) { const c = ctl.getBoundingClientRect(); if (c.height && c.top < clip.bottom) clip.bottom = c.top; }
    if (wtDock.mode !== 'inline') { wtDock.mode = 'inline'; el.classList.remove('mini'); el.classList.add('inline'); }
    el.hidden = false;
    style.left = `${r.left}px`; style.top = `${r.top}px`; style.width = `${r.width}px`; style.right = ''; style.bottom = '';
    const ct = Math.max(0, clip.top - r.top); const cb = Math.max(0, r.top + el.offsetHeight - clip.bottom);
    const cl = Math.max(0, clip.left - r.left); const cr = Math.max(0, r.right - clip.right);
    style.clipPath = ct || cb || cl || cr ? `inset(${ct}px ${cr}px ${cb}px ${cl}px)` : '';
    // The placeholder takes the player's height, so the call's tiles and buttons sit below it.
    const want = `${el.offsetHeight}px`;
    if (host.style.height !== want) host.style.height = want;
    return;
  }
  if (wtDock.mode !== 'mini') { wtDock.mode = 'mini'; el.classList.remove('inline'); el.classList.add('mini'); style.clipPath = ''; style.width = ''; }
  el.hidden = wtDock.hidden;
  if (wtDock.pos) {
    const w = el.offsetWidth || 320; const hgt = el.offsetHeight || 200;
    style.left = `${Math.max(0, Math.min(innerWidth - w, wtDock.pos.x))}px`; style.top = `${Math.max(0, Math.min(innerHeight - hgt, wtDock.pos.y))}px`; style.right = 'auto'; style.bottom = 'auto';
  } else { style.left = 'auto'; style.top = 'auto'; style.right = ''; style.bottom = ''; }
}
// Start (or queue) a video for everyone in the call.
// What kind of link this is (the server checks again): YouTube, Vimeo, Twitch or a video file.
function watchKind(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (/^(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(host)) return 'YouTube video';
  if (/^(player\.)?vimeo\.com$/.test(host)) return 'Vimeo video';
  if (host === 'twitch.tv') return 'Twitch live stream';
  if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(u.pathname)) return 'Video file';
  return null;
}
const watchRecent = () => { try { return JSON.parse(localStorage.getItem('hearth.watchRecent') || '[]').slice(0, 6); } catch { return []; } };
function rememberWatch(link) { try { localStorage.setItem('hearth.watchRecent', JSON.stringify([link, ...watchRecent().filter((x) => x !== link)].slice(0, 6))); } catch { /* private mode */ } }
function startWatching(room, link, queue) {
  return new Promise((resolve, reject) => {
    socket.emit('watch:start', { url: link, queue }, (r) => {
      if (r && r.error) return reject(new Error(r.error));
      rememberWatch(String(link).trim());
      resolve();
    });
  });
}
function openWatchStart(room, queue = false) {
  const url = h('input', { class: 'input', placeholder: 'Paste a YouTube, Vimeo or Twitch link', autocomplete: 'off', spellcheck: 'false' });
  const kind = h('span', { class: 'field-hint' }, 'YouTube, Vimeo, Twitch (live) and video files (.mp4, .webm). For anything else (like Netflix), share your screen.');
  const hostOnly = h('input', { type: 'checkbox' });
  const check = () => { const k = watchKind(url.value); kind.textContent = url.value.trim() ? (k ? `✓ ${k}` : 'That link isn’t a video this can play. Try a YouTube, Vimeo or Twitch link.') : kind.textContent; kind.classList.toggle('ok', !!k); };
  url.addEventListener('input', check);
  let m;
  const submit = () => startWatching(room, url.value, queue).then(() => m && m.close());
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit().catch((x) => toast(x.message, 'error')); } });
  const paste = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { try { url.value = (await navigator.clipboard.readText()).trim(); check(); url.focus(); } catch { url.focus(); toast('Press Ctrl+V to paste the link.'); } } }, 'Paste');
  const recent = watchRecent();
  m = modal({
    title: queue ? 'Add to the queue' : 'Watch together', size: 'sm',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted-p' }, queue ? 'It plays for everyone when the current video ends.' : 'Everyone in this call sees the same video at the same moment, and anyone can pause or skip ahead (unless you keep the controls).'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Link'), h('div', { class: 'row gap' }, url, paste), kind),
      recent.length ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Watched recently'),
        h('div', { class: 'wt-recent' }, recent.map((link) => h('button', { class: 'chip', type: 'button', title: link, onclick: () => { url.value = link; check(); submit().catch((x) => toast(x.message, 'error')); } }, link.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40))))) : null,
      queue ? null : h('label', { class: 'row gap' }, hostOnly, 'Only I can play, pause and skip'),
      h('p', { class: 'field-hint' }, 'The video loads straight from YouTube/Vimeo/Twitch, so they can see each viewer’s IP address, like when you watch there.')),
    actions: [{ label: 'Cancel' }, { label: queue ? 'Add to queue' : 'Start watching', kind: 'primary', action: () => new Promise((resolve, reject) => {
      socket.emit('watch:start', { url: url.value, queue, hostOnly: hostOnly.checked }, (r) => { if (r && r.error) return reject(new Error(r.error)); rememberWatch(url.value.trim()); resolve(); });
    }) }],
  });
  setTimeout(() => url.focus(), 50);
}
// Video links in chat get a "Watch together" button: one click plays it for everyone in your call.
const WATCH_LINK = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s<>"']*v=|shorts\/|live\/)[\w-]{11}[^\s<>"']*|youtu\.be\/[\w-]{11}[^\s<>"']*|vimeo\.com\/\d{5,12}[^\s<>"']*|twitch\.tv\/[a-z0-9_]{3,25}(?=[\s/?#]|$)|[^\s<>"']+\.(?:mp4|webm|m4v)(?=[\s?#]|$))/gi;
function watchChips(text) {
  if ((S.config.features || {}).watch === false || !text) return null;
  const links = [...new Set(String(text).match(WATCH_LINK) || [])].slice(0, 2);
  if (!links.length) return null;
  return h('div', { class: 'watch-chips' }, links.map((link) => h('button', {
    class: 'watch-chip', 'data-tip': 'Play it for everyone in your call',
    onclick: () => {
      const room = voice && voice.channelId;
      if (!room) return toast('Join a voice channel or call first, then press this to watch it together.');
      const queued = !!S.watch[room];
      startWatching(room, link, queued).then(() => toast(queued ? 'Added to the watch queue.' : 'Playing for everyone in the call.')).catch((e) => toast(e.message, 'error'));
    },
  }, icon('play'), `Watch together${links.length > 1 ? ` · ${watchKind(link) || 'video'}` : ''}`)));
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
