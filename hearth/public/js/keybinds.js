// Keybinds (push-to-talk, mute, deafen) and the desktop app's extras: keys that work while a game has focus,
// Mute/Deafen in the taskbar preview, the "update ready" banner, reconnecting after sleep, and flashing the
// taskbar on @mentions.
//
// In a browser (or if global keys aren't available), the keys work while Hearth is the focused window.
// In the desktop app they work everywhere, and the app — not this page — listens, so nothing fires twice.
const KEY = 'hearth.keybinds';
export const DEFAULT_KEYBINDS = {
  ptt: null,
  mute: { code: 'KeyM', ctrl: true, shift: true },
  deafen: { code: 'KeyD', ctrl: true, shift: true },
};
export function getKeybinds() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* defaults */ }
  return { ...DEFAULT_KEYBINDS, ...saved };
}

const NAMES = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space',
  ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left Win', MetaRight: 'Right Win',
  CapsLock: 'Caps Lock', Mouse3: 'Middle mouse', Mouse4: 'Mouse 4 (back)', Mouse5: 'Mouse 5 (forward)', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
export function comboLabel(b) {
  if (!b || !b.code) return 'Not set';
  const key = NAMES[b.code] || b.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
  return [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', b.meta && (/Mac/.test(navigator.platform) ? '⌘' : 'Win'), key].filter(Boolean).join(' + ');
}
const isModifier = (code) => /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code);
const mouseCode = (e) => (e.button === 1 ? 'Mouse3' : e.button === 3 ? 'Mouse4' : e.button === 4 ? 'Mouse5' : null);
function same(b, code, e, withMods) {
  if (!b || b.code !== code) return false;
  if (!withMods) return true;
  return !!b.ctrl === (e.ctrlKey || false) && !!b.shift === (e.shiftKey || false) && !!b.alt === (e.altKey || false) && !!b.meta === (e.metaKey || false);
}

let ctx = { onPtt: () => {}, onMute: () => {}, onDeafen: () => {}, reconnect: () => {}, showUpdate: () => {} };
let global = false;
let localPtt = false;
let recording = false; // while a keybind is being recorded, keys don't trigger anything
const desktop = () => window.hearthDesktop || null;

export const globalKeysActive = () => global;
export function setRecording(v) { recording = v; }

export async function saveKeybinds(b) {
  try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* private mode */ }
  return apply();
}
async function apply() {
  const d = desktop();
  global = false;
  if (d && d.setKeybinds) {
    try { const r = await d.setKeybinds(getKeybinds()); global = !!(r && r.global); return r; } catch { /* fall back to in-window keys */ }
  }
  return { ok: true, global: false };
}

function down(code, e) {
  if (recording || global) return false;
  const b = getKeybinds();
  let hit = false;
  if (same(b.ptt, code, e, false)) { if (!localPtt) { localPtt = true; ctx.onPtt(true); } hit = true; }
  if (!e.repeat && same(b.mute, code, e, true)) { ctx.onMute(); hit = true; }
  if (!e.repeat && same(b.deafen, code, e, true)) { ctx.onDeafen(); hit = true; }
  return hit;
}
function up(code) {
  if (localPtt && getKeybinds().ptt && getKeybinds().ptt.code === code) { localPtt = false; ctx.onPtt(false); }
}

export async function initKeybinds(c) {
  ctx = { ...ctx, ...c };
  document.addEventListener('keydown', (e) => {
    // Mute/deafen combos shouldn't also type; a plain push-to-talk key keeps typing like in Discord.
    if (down(e.code, e) && (e.ctrlKey || e.altKey || e.metaKey)) e.preventDefault();
  }, true);
  document.addEventListener('keyup', (e) => up(e.code), true);
  document.addEventListener('mousedown', (e) => { const c2 = mouseCode(e); if (c2) down(c2, e); }, true);
  document.addEventListener('mouseup', (e) => { const c2 = mouseCode(e); if (c2) up(c2); }, true);
  // Switching windows while holding the key: there'll be no key-up, so let go now.
  window.addEventListener('blur', () => { if (localPtt) { localPtt = false; ctx.onPtt(false); } });
  const d = desktop();
  if (d && d.onHotkey) {
    d.onHotkey((ev) => {
      if (recording) return;
      if (ev.action === 'ptt') ctx.onPtt(!!ev.down);
      else if (ev.action === 'mute') ctx.onMute();
      else if (ev.action === 'deafen') ctx.onDeafen();
    });
  }
  if (d && d.onResume) d.onResume(() => ctx.reconnect());
  if (d && d.onUpdateReady) {
    d.onUpdateReady((u) => ctx.showUpdate(u && u.version));
    try { const v = d.updateReady && d.updateReady(); if (v) ctx.showUpdate(v); } catch { /* older app */ }
  }
  return apply();
}

// Records the next key / mouse button / combo pressed. Resolves to a binding, or null on Escape.
export function recordCombo({ allowMods = true } = {}) {
  return new Promise((resolve) => {
    recording = true;
    const finish = (v) => {
      recording = false;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('mousedown', onMouse, true);
      resolve(v);
    };
    let lastMod = null;
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') return finish(null);
      if (isModifier(e.code)) { lastMod = e.code; return; } // wait: maybe Ctrl+Shift+M, maybe just Left Ctrl
      finish({ code: e.code, ...(allowMods ? { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey } : {}) });
    };
    // A modifier pressed and released on its own is the binding itself (e.g. push-to-talk on Left Ctrl).
    const onKeyUp = (e) => { if (lastMod && e.code === lastMod) { e.preventDefault(); finish({ code: lastMod }); } };
    const onMouse = (e) => { const c2 = mouseCode(e); if (!c2) return; e.preventDefault(); e.stopPropagation(); finish({ code: c2 }); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('mousedown', onMouse, true);
  });
}

// ---- small desktop helpers used by the app
export function reportCall(state) { const d = desktop(); if (d && d.setCallState) d.setCallState(state); }
export function flashTaskbar() { const d = desktop(); if (d && d.flash) d.flash(); }
export function installUpdate() { const d = desktop(); if (d && d.installUpdate) d.installUpdate(); }
