// Global keys: push-to-talk, mute and deafen keep working while a game or any other app has focus.
// Uses uiohook, which only listens: the key still reaches the game, unlike Electron's globalShortcut, which
// would swallow it. Bindings come from Hearth's Settings → Keybinds and are sent here by the page.
//
// A binding is { code, ctrl, shift, alt, meta } where code is a browser KeyboardEvent.code ("KeyV", "F13",
// "Backquote", "ControlLeft"…) or a mouse button ("Mouse3" middle, "Mouse4"/"Mouse5" side buttons).
let hook = null;
let UK = null;
let bindings = {};
let emit = () => {};
let pttDown = false;
const held = new Set(); // keys down right now (to ignore key-repeat for toggles)

function load() {
  if (hook) return true;
  try {
    const m = require('uiohook-napi');
    hook = m.uIOhook; UK = m.UiohookKey;
  } catch (e) { hook = null; return false; }
  hook.on('keydown', (e) => onDown({ kind: 'key', keycode: e.keycode, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }));
  hook.on('keyup', (e) => onUp({ kind: 'key', keycode: e.keycode }));
  hook.on('mousedown', (e) => onDown({ kind: 'mouse', button: e.button, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }));
  hook.on('mouseup', (e) => onUp({ kind: 'mouse', button: e.button }));
  return true;
}

const MODS = { ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', ShiftLeft: 'Shift', ShiftRight: 'ShiftRight', AltLeft: 'Alt', AltRight: 'AltRight', MetaLeft: 'Meta', MetaRight: 'MetaRight' };
function keycodeOf(code) {
  if (!UK || !code) return null;
  if (/^Key[A-Z]$/.test(code)) return UK[code.slice(3)];
  if (/^Digit\d$/.test(code)) return UK[code.slice(5)];
  const k = UK[MODS[code] || code];
  return typeof k === 'number' ? k : null;
}
const isMouse = (b) => /^Mouse\d$/.test(b.code || '');
function same(b, ev, withMods) {
  if (!b || !b.code) return false;
  if (isMouse(b)) { if (ev.kind !== 'mouse' || ev.button !== +b.code.slice(5)) return false; }
  else if (ev.kind !== 'key' || ev.keycode !== keycodeOf(b.code)) return false;
  if (!withMods) return true;
  return !!b.ctrl === !!ev.ctrl && !!b.shift === !!ev.shift && !!b.alt === !!ev.alt && !!b.meta === !!ev.meta;
}
const idOf = (ev) => (ev.kind === 'mouse' ? `m${ev.button}` : `k${ev.keycode}`);

function onDown(ev) {
  const id = idOf(ev);
  const repeat = held.has(id);
  held.add(id);
  // Push-to-talk ignores Ctrl/Shift/Alt, so it still works while running or crouching in a game.
  if (same(bindings.ptt, ev, false) && !pttDown) { pttDown = true; emit({ action: 'ptt', down: true }); }
  if (repeat) return;
  if (same(bindings.mute, ev, true)) emit({ action: 'mute' });
  if (same(bindings.deafen, ev, true)) emit({ action: 'deafen' });
}
function onUp(ev) {
  held.delete(idOf(ev));
  if (pttDown && same(bindings.ptt, ev, false)) { pttDown = false; emit({ action: 'ptt', down: false }); }
}

let running = false;
// Returns { ok, global } — global=false means this computer can't listen globally (the page then falls back
// to keys that work while Hearth is focused).
function set(next, onEvent) {
  bindings = {};
  for (const k of ['ptt', 'mute', 'deafen']) {
    const b = next && next[k];
    if (b && typeof b.code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(b.code)) bindings[k] = { code: b.code, ctrl: !!b.ctrl, shift: !!b.shift, alt: !!b.alt, meta: !!b.meta };
  }
  emit = onEvent || (() => {});
  const any = Object.keys(bindings).length > 0;
  if (!any) { stop(); return { ok: true, global: false }; }
  if (!load()) return { ok: false, global: false, error: 'Global keys aren’t available on this computer.' };
  if (!running) {
    try { hook.start(); running = true; } catch (e) { return { ok: false, global: false, error: String(e && e.message || e) }; }
  }
  return { ok: true, global: true };
}
function stop() {
  if (pttDown) { pttDown = false; emit({ action: 'ptt', down: false }); }
  held.clear();
  if (hook && running) { try { hook.stop(); } catch { /* already stopped */ } running = false; }
}

module.exports = { set, stop, keycodeOf: (c) => { load(); return keycodeOf(c); } };
