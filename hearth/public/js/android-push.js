// Notifications while the Hearth Android app is closed. The app gets a Web Push address from a UnifiedPush push
// app on the phone (usually ntfy) and hands it, with its public keys, to this page; the page subscribes it with
// the server exactly as a browser subscribes its own (POST /api/push/subscribe). The sign-in token never leaves
// the page. No DOM here, so it's tested in Node (test/android-push.test.js).

// Where a tapped notification may take you: the app's own links only (the same rule as PushPolicy.java). #scheduled
// is your scheduled messages (a push says one wasn't sent, or is waiting for you).
export const OPEN_RE = /^\/(#(?:m|c|d)\/[a-z0-9]{1,64}|#call\/(?:dm:)?[a-z0-9]{1,64}|#updates|#study|#scheduled)?$/;
export const safeOpenHash = (path) => { const m = OPEN_RE.exec(String(path ?? '')); return m && m[1] ? m[1] : ''; };
// An invite link the app was opened with: only the code travels (InviteLinks.java).
export const safeInviteHash = (code) => (/^[A-Za-z0-9]{2,64}$/.test(String(code ?? '')) ? `#invite/${code}` : '');

// What the person is told when it doesn't work, by the app's reason code.
export const reasonText = {
  noDistributor: 'To get notifications when Hearth is closed, install a push app such as ntfy (from F-Droid or Google Play), then turn this on again. ntfy only passes on encrypted notifications; it can\u2019t read them.',
  blocked: 'Notifications are turned off for Hearth. Turn them on in Android Settings \u2192 Apps \u2192 Hearth \u2192 Notifications.',
  NETWORK: 'The push app couldn\u2019t reach its server. Check your connection and try again.',
  ACTION_REQUIRED: 'Open your push app (for example ntfy) and finish setting it up, then try again.',
  VAPID_REQUIRED: 'That push app can\u2019t be used with Hearth. Pick another one.',
  VAPID_INVALID: 'That push app can\u2019t be used with Hearth. Pick another one.',
  INTERNAL_ERROR: 'Something went wrong setting up notifications. Try again.',
  NO_KEYS: 'Something went wrong setting up notifications. Try again.',
  DISTRIBUTOR_GONE: 'Your push app was removed. Install one (such as ntfy) and turn notifications on again.',
  UNREGISTERED: 'Your push app stopped delivering Hearth\u2019s notifications. Turn them on again.',
  CANCELLED: '',
  timeout: 'The push app didn\u2019t answer. Open it once, then try again.',
};

// The error a registration ends with, from the app's state ({ state, reason }); null while it's still going.
export function failureOf(st) {
  if (!st || st.state === 'pending' || st.state === 'registered') return null;
  if (st.state === 'noDistributor' || st.state === 'blocked') return st.state;
  if (st.state === 'failed') return st.reason || 'INTERNAL_ERROR';
  return st.reason === 'CANCELLED' ? 'CANCELLED' : st.reason || 'UNREGISTERED';
}
const fail = (code) => Object.assign(new Error(reasonText[code] || reasonText.INTERNAL_ERROR), { code });

// send(msg): posts to the app. initial: the push state the app gave in its first answer.
export function createAndroidPush({ send, initial = null, timeoutMs = 30000, stateMs = 3000, unregisterMs = 2000 }) {
  let last = initial || { state: 'none' };
  const listeners = new Set();
  let stateWaiters = [];
  let reg = null; // the registration being waited for: { resolve, reject, timer }

  const finishReg = (st) => {
    if (!reg) return;
    // The person backed out of the list of push apps. After "Change" the registration it had stays (registered),
    // so this comes first.
    if (st.cancelled) { const r = reg; reg = null; clearTimeout(r.timer); r.reject(fail('CANCELLED')); return; }
    if (st.state === 'registered' && st.endpoint && st.p256dh && st.auth) { const r = reg; reg = null; clearTimeout(r.timer); r.resolve(st); return; }
    const code = failureOf(st);
    if (code) { const r = reg; reg = null; clearTimeout(r.timer); r.reject(fail(code)); }
  };
  const take = (st) => {
    if (!st || typeof st !== 'object') return;
    last = st;
    const w = stateWaiters; stateWaiters = [];
    w.forEach((x) => { clearTimeout(x.timer); x.resolve(st); });
    finishReg(st);
  };

  return {
    get last() { return last; },
    // The app's current state (or the last one known, if it doesn't answer in time).
    state() {
      return new Promise((resolve) => {
        const x = { resolve, timer: setTimeout(() => { stateWaiters = stateWaiters.filter((y) => y !== x); resolve(last); }, stateMs) };
        stateWaiters.push(x);
        send({ type: 'pushState' });
      });
    },
    // Asks the app for a push address for this server, signed for `vapid` (the server's key). choose: show the
    // list of push apps even if one was picked before. Resolves with { endpoint, p256dh, auth, ... }.
    register(vapid, { choose = false } = {}) {
      if (reg) { clearTimeout(reg.timer); reg.reject(fail('CANCELLED')); reg = null; }
      return new Promise((resolve, reject) => {
        reg = { resolve, reject, timer: setTimeout(() => { if (reg) { reg = null; reject(fail('timeout')); } }, timeoutMs) };
        send({ type: choose ? 'pushPick' : 'pushRegister', vapid: String(vapid || '') });
      });
    },
    // Removes this phone's registration for this server (resolves when done, or after a moment regardless).
    unregister() {
      return new Promise((resolve) => {
        const x = { resolve: () => resolve(), timer: setTimeout(() => { stateWaiters = stateWaiters.filter((y) => y !== x); resolve(); }, unregisterMs) };
        stateWaiters.push(x);
        send({ type: 'pushUnregister' });
      });
    },
    // Called for every change the app reports by itself (a new address, a failure, the push app gone).
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    _reply(msg) { take(msg); },
    _event(detail) { take(detail); if (detail && typeof detail === 'object') listeners.forEach((cb) => { try { cb(detail); } catch { /* one listener */ } }); },
  };
}
