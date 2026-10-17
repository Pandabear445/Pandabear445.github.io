// Presence, the app's side (the server's is server/presence.js): automatic Away, and when a custom status clears.
//
// Automatic Away: tells the server whether this app has gone unused for the person's "Away after" time (Settings →
// Privacy & safety). The server shows someone whose status is Online as Away only while every one of their open
// apps says so, and never changes Do Not Disturb or Invisible (server/presence.js).
//   In a browser: a key, a click, a scroll, a touch or the pointer moving in this page counts as use, and so does
//   the page coming back into view.
//   In the desktop app: any input on the computer counts (the system's idle time, through the desktop bridge), so
//   playing a game or working in another app with Hearth in the background isn't being away.
//   In the Android app: like a browser, input in Hearth itself. Going to the background reports nothing by itself
//   (Away still comes only after the person's time), and nothing the app itself hands the page (a push, a
//   notification's Hang up, an invite, a tapped notification) counts as input; opening Hearth again does, since
//   the page comes back into view. A call keeps going in the background (android.js callState) and counts.
//   All: being in a call counts (talking, or watching someone's screen without touching anything), and so does
//   input in the Study page, whose frame of its own tells this page it's in use (recall-host.js calls used()).
// It checks every 15 seconds, and says it's back on the first input after being idle, so coming back is instant.
// Nothing is worked out or sent while the status isn't Online (minutes() is 0 then).
// Only "idle" or "in use" is ever sent, never what was typed or clicked. It's sent as it happens, though, so the
// server (and everyone who sees the dot change) can tell roughly when someone stopped and started using Hearth.
const CHECK_MS = 15000;
const INPUTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'];

// socket: the app's connection; minutes(): the "Away after" time while the status is Online (0 = never, or another
// status); busy(): in use whatever the input says (in a call).
export function initAway({ socket, minutes, busy = () => false }) {
  const desktop = window.hearthDesktop && typeof window.hearthDesktop.idleSeconds === 'function' ? window.hearthDesktop : null;
  let lastInput = Date.now();
  let told = false; // what the server was last told (it starts every new connection as "in use")
  let checking = false;

  const report = (idle) => {
    if (idle === told || !socket.connected) return;
    told = idle;
    // Refused (too many changes at once): the next check tries again.
    socket.emit('presence:idle', { idle }, (r) => { if (r && r.error) told = !idle; });
  };
  // How long nobody has used this app (or, in the desktop app, the computer), in ms. Use the page hears about
  // without input reaching it (a call, the Study page) counts in the desktop app too.
  const unusedFor = async () => {
    const page = Date.now() - lastInput;
    if (desktop) {
      try { const s = await desktop.idleSeconds(); if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, page); } catch { /* an older desktop app: use the page */ }
    }
    return page;
  };
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if (busy()) lastInput = Date.now();
      const m = Number(minutes()) || 0;
      report(m > 0 && (await unusedFor()) >= m * 60000);
    } finally { checking = false; }
  };
  const used = () => {
    lastInput = Date.now();
    if (told) report(false);
  };

  INPUTS.forEach((ev) => window.addEventListener(ev, used, { capture: true, passive: true }));
  window.addEventListener('focus', used);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) used(); });
  // A new connection (after a restart or a dropped network) starts as "in use" on the server: tell it again.
  socket.on('connect', () => { told = false; check(); });
  setInterval(check, CHECK_MS);
  return { check, used };
}

// A user:update about yourself (`u`, the server's whole copy) that changes nothing but whether you show as Away for
// being inactive, compared with what the app has (`me`): then the app only redraws the dots and the line under
// your name (app.js). Everything else in it must be the same, except what differs without anything changing:
//   rail      the server-folder layout is the app's own: it tidies the order in place without saving (folders.js),
//             and other devices' changes come as 'rail:update', so the copy in here says nothing new;
//   keysReset missing and null both mean verified (your public copy, which comes with a server or group you join,
//             leaves it out: secure.js mergeUser);
//   activity  the album art's link (music.artSrc) is signed again every few hours; the song itself is compared.
const PRESENCE_ONLY = new Set(['presence', 'autoAway']);
const withoutArt = (a) => (a && a.music ? { ...a, music: { ...a.music, artSrc: undefined } } : a);
const sameAs = (k, a, b) => {
  if (k === 'keysReset') return (a || null) === (b || null);
  if (k === 'activity') return JSON.stringify(withoutArt(a) || null) === JSON.stringify(withoutArt(b) || null);
  return JSON.stringify(a) === JSON.stringify(b);
};
export function onlyPresenceChanged(me, u) {
  if (!me || !u || u.id !== me.id) return false;
  return Object.keys(u).every((k) => PRESENCE_ONLY.has(k) || k === 'rail' || sameAs(k, u[k], me[k]));
}

// ------------------------------------------------------------------ custom status: "Clear after"
// The choices, in the order the dialog lists them. The app works out how long each lasts on this device, in the
// person's own time zone, and sends only that length (expiresIn) to the server.
export const CLEAR_AFTER = [['30m', '30 minutes'], ['1h', '1 hour'], ['4h', '4 hours'], ['today', 'Today'], ['week', 'This week'], ['never', 'Don\u2019t clear']];
const FIXED = { '30m': 30 * 60000, '1h': 3600000, '4h': 4 * 3600000 };
// The day a week starts on where the person is (0 = Sunday … 6 = Saturday); Monday when the browser can't say.
export function weekStart(locale) {
  try {
    const l = new Intl.Locale(locale || (typeof navigator !== 'undefined' && navigator.language) || 'en');
    const info = typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo;
    if (info && info.firstDay) return info.firstDay % 7;
  } catch { /* an unknown locale: use Monday */ }
  return 1;
}
// How long a status set now lasts, in ms (null: until it's cleared). "Today" ends at midnight here; "this week" at
// the end of the last day of this week. At least a minute (the server's shortest), so 23:59:30 still works.
export function clearAfterMs(choice, now = new Date(), firstDay = weekStart()) {
  if (FIXED[choice]) return FIXED[choice];
  if (choice !== 'today' && choice !== 'week') return null;
  const end = new Date(now.getTime());
  if (choice === 'week') end.setDate(end.getDate() + (((firstDay - end.getDay() + 7) % 7) || 7));
  else end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  return Math.max(60000, end.getTime() - now.getTime());
}
// "Clears at 5:30 PM", "Clears Sunday at 11:59 PM": when a status will go, said the way this device tells time.
export function clearsLabel(at, now = new Date()) {
  if (!at) return 'Stays until you clear it.';
  const d = new Date(at);
  // Midnight shows as the minute before, so "Today" reads as the day it is.
  if (d.getHours() === 0 && d.getMinutes() === 0) d.setTime(d.getTime() - 60000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Clears at ${time}.`;
  const tomorrow = new Date(now.getTime()); tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Clears tomorrow at ${time}.`;
  return `Clears ${d.toLocaleDateString([], { weekday: 'long' })} at ${time}.`;
}
