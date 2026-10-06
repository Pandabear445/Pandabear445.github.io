// Hearth sounds.
// Every sound is synthesized in the browser with real instrument techniques (FM bells, marimba/kalimba
// partials, plucked strings, glass), rendered once with a touch of room reverb, loudness-matched, and cached.
// People can put any sound on any event, or use their own audio file (kept on their device).

// ---------------------------------------------------------------- events people can customize
export const EVENTS = [
  // [id, label, description, group, default sound]
  ['mention', '@mentions of you', 'Someone writes @yourname.', 'Messages', 'bright'],
  ['everyone', '@everyone and @channel', 'An announcement to everyone (only from people allowed to use it).', 'Messages', 'fanfare'],
  ['roleMention', 'Role mentions', 'Someone mentions a role you have, like @Moderators.', 'Messages', 'triple'],
  ['dm', 'Direct messages', 'A new message in a one-to-one DM.', 'Messages', 'kalimba'],
  ['groupDm', 'Group DMs', 'A new message in a group DM.', 'Messages', 'marimba'],
  ['reply', 'Replies', 'Someone replies to your message or your thread.', 'Messages', 'pluck'],
  ['message', 'Other channel messages', 'Channels set to "All messages" that you aren\u2019t looking at.', 'Messages', 'none'],
  ['sent', 'Your message sent', 'When your own message goes out.', 'Messages', 'none'],
  ['friend', 'Friend requests', 'Someone sends or accepts a friend request.', 'People', 'harp'],
  ['ring', 'Incoming call', 'Someone is calling you (repeats until you answer).', 'Voice', 'ringtone'],
  ['selfJoin', 'You join voice', 'Confirms you\u2019re connected.', 'Voice', 'rise'],
  ['selfLeave', 'You leave voice', 'Confirms you\u2019ve disconnected.', 'Voice', 'fall'],
  ['userJoin', 'Someone joins your call', '', 'Voice', 'blipUp'],
  ['userLeave', 'Someone leaves your call', '', 'Voice', 'blipDown'],
  ['mute', 'Mute', '', 'Voice', 'clickDown'],
  ['unmute', 'Unmute', '', 'Voice', 'clickUp'],
  ['deafen', 'Deafen', '', 'Voice', 'muffleDown'],
  ['undeafen', 'Undeafen', '', 'Voice', 'clearUp'],
];

// ---------------------------------------------------------------- the library
// A sound is an instrument + notes: [note, start (s), length (s), loudness 0..1, glide-to note?]
export const LIBRARY = [
  { id: 'bright', name: 'Bright chime', group: 'Chimes', inst: 'bell', notes: [['E6', 0, 1.1, 0.9], ['B6', 0.11, 1.3, 0.8]] },
  { id: 'sparkle', name: 'Sparkle', group: 'Chimes', inst: 'glass', notes: [['E6', 0, 0.9, 0.7], ['G#6', 0.07, 0.9, 0.7], ['B6', 0.14, 0.9, 0.7], ['E7', 0.21, 1.2, 0.75]] },
  { id: 'triple', name: 'Triple ding', group: 'Chimes', inst: 'bell', notes: [['A6', 0, 0.6, 0.75], ['A6', 0.13, 0.6, 0.7], ['E7', 0.26, 1.1, 0.8]] },
  { id: 'fanfare', name: 'Fanfare', group: 'Chimes', inst: 'marimba', notes: [['C5', 0, 0.5, 0.8], ['E5', 0.09, 0.5, 0.8], ['G5', 0.18, 0.5, 0.85], ['C6', 0.3, 0.9, 1]] },
  { id: 'harp', name: 'Harp run', group: 'Chimes', inst: 'pluck', notes: [['C5', 0, 1, 0.8], ['E5', 0.06, 1, 0.8], ['G5', 0.12, 1, 0.8], ['C6', 0.18, 1, 0.85], ['E6', 0.24, 1.4, 0.9]] },
  { id: 'doorbell', name: 'Doorbell', group: 'Chimes', inst: 'bell', notes: [['E6', 0, 1, 0.85], ['C6', 0.32, 1.4, 0.85]] },
  { id: 'alert', name: 'Soft alert', group: 'Chimes', inst: 'kalimba', notes: [['A5', 0, 0.35, 0.8], ['E6', 0.1, 0.35, 0.8], ['A5', 0.2, 0.35, 0.8], ['E6', 0.3, 0.7, 0.9]] },
  { id: 'kalimba', name: 'Kalimba', group: 'Gentle', inst: 'kalimba', notes: [['A5', 0, 0.6, 0.85], ['E6', 0.11, 0.9, 0.8]] },
  { id: 'marimba', name: 'Marimba', group: 'Gentle', inst: 'marimba', notes: [['G5', 0, 0.5, 0.85], ['D6', 0.1, 0.7, 0.85]] },
  { id: 'pluck', name: 'Pluck', group: 'Gentle', inst: 'pluck', notes: [['D5', 0, 0.8, 0.85], ['A5', 0.09, 1.1, 0.8]] },
  { id: 'softding', name: 'Soft ding', group: 'Gentle', inst: 'bell', notes: [['A6', 0, 1.2, 0.6]] },
  { id: 'glassdrop', name: 'Glass drop', group: 'Gentle', inst: 'glass', notes: [['C7', 0, 0.7, 0.65], ['G6', 0.12, 1, 0.6]] },
  { id: 'vibes', name: 'Vibraphone', group: 'Gentle', inst: 'vibes', notes: [['E5', 0, 0.9, 0.85], ['B5', 0.14, 1.2, 0.8]] },
  { id: 'whisper', name: 'Whisper', group: 'Gentle', inst: 'soft', notes: [['E5', 0, 0.5, 0.7], ['A5', 0.12, 0.6, 0.6]] },
  { id: 'bubble', name: 'Bubbles', group: 'Playful', inst: 'bubble', notes: [['A5', 0, 0.14, 0.8], ['E6', 0.1, 0.16, 0.8]] },
  { id: 'pop', name: 'Pop', group: 'Playful', inst: 'pop', notes: [['C6', 0, 0.09, 1]] },
  { id: 'popop', name: 'Pop pop', group: 'Playful', inst: 'pop', notes: [['C6', 0, 0.09, 1], ['G6', 0.1, 0.09, 1]] },
  { id: 'chirp', name: 'Chirp', group: 'Playful', inst: 'bubble', notes: [['E6', 0, 0.08, 0.8], ['B6', 0.07, 0.08, 0.8], ['E7', 0.14, 0.12, 0.85]] },
  { id: 'boop', name: 'Boop', group: 'Playful', inst: 'soft', notes: [['G5', 0, 0.22, 0.9, 'C5']] },
  { id: 'coin', name: 'Coin', group: 'Retro', inst: 'chip', notes: [['B5', 0, 0.08, 0.9], ['E6', 0.08, 0.35, 0.9]] },
  { id: 'powerup', name: 'Power-up', group: 'Retro', inst: 'chip', notes: [['C5', 0, 0.07, 0.8], ['E5', 0.06, 0.07, 0.8], ['G5', 0.12, 0.07, 0.8], ['C6', 0.18, 0.25, 0.9]] },
  { id: 'powerdown', name: 'Power-down', group: 'Retro', inst: 'chip', notes: [['C6', 0, 0.07, 0.8], ['G5', 0.06, 0.07, 0.8], ['E5', 0.12, 0.07, 0.8], ['C5', 0.18, 0.25, 0.8]] },
  { id: 'ringtone', name: 'Hearth ringtone', group: 'Ringtones', inst: 'marimba', notes: [['E5', 0, 0.3, 0.9], ['G#5', 0.15, 0.3, 0.9], ['B5', 0.3, 0.3, 0.9], ['E6', 0.45, 0.5, 1], ['B5', 0.75, 0.3, 0.8], ['E6', 0.9, 0.7, 0.95]] },
  { id: 'classicring', name: 'Classic phone', group: 'Ringtones', inst: 'bell', notes: Array.from({ length: 12 }, (_, i) => [i % 2 ? 'C7' : 'A6', i * 0.05, 0.12, 0.55]).concat(Array.from({ length: 12 }, (_, i) => [i % 2 ? 'C7' : 'A6', 0.75 + i * 0.05, 0.12, 0.55])) },
  { id: 'kalimbaring', name: 'Kalimba ring', group: 'Ringtones', inst: 'kalimba', notes: [['C6', 0, 0.4, 0.9], ['E6', 0.12, 0.4, 0.9], ['G6', 0.24, 0.4, 0.9], ['E6', 0.36, 0.4, 0.85], ['C6', 0.6, 0.4, 0.9], ['G6', 0.72, 0.8, 0.95]] },
  { id: 'harpring', name: 'Harp ring', group: 'Ringtones', inst: 'pluck', notes: [['G4', 0, 1, 0.8], ['B4', 0.08, 1, 0.8], ['D5', 0.16, 1, 0.85], ['G5', 0.24, 1, 0.9], ['B5', 0.32, 1, 0.9], ['D6', 0.4, 1.3, 0.95]] },
  { id: 'rise', name: 'Rise', group: 'Voice & controls', inst: 'marimba', whoosh: 'up', notes: [['G4', 0.04, 0.4, 0.8], ['D5', 0.15, 0.7, 0.9]] },
  { id: 'fall', name: 'Fall', group: 'Voice & controls', inst: 'marimba', whoosh: 'down', notes: [['D5', 0, 0.4, 0.85], ['G4', 0.12, 0.7, 0.8]] },
  { id: 'blipUp', name: 'Blip up', group: 'Voice & controls', inst: 'soft', notes: [['C5', 0, 0.22, 0.7, 'G5']] },
  { id: 'blipDown', name: 'Blip down', group: 'Voice & controls', inst: 'soft', notes: [['G5', 0, 0.24, 0.65, 'C5']] },
  { id: 'clickDown', name: 'Click down', group: 'Voice & controls', inst: 'click', notes: [['E5', 0, 0.09, 0.8, 'A4']] },
  { id: 'clickUp', name: 'Click up', group: 'Voice & controls', inst: 'click', notes: [['A5', 0, 0.09, 0.8, 'E6']] },
  { id: 'muffleDown', name: 'Muffle down', group: 'Voice & controls', inst: 'muffled', notes: [['C5', 0, 0.25, 0.85], ['G4', 0.1, 0.4, 0.85]] },
  { id: 'clearUp', name: 'Clear up', group: 'Voice & controls', inst: 'kalimba', notes: [['G4', 0, 0.3, 0.75], ['C5', 0.1, 0.5, 0.8]] },
  { id: 'swoosh', name: 'Swoosh', group: 'Voice & controls', inst: 'none', whoosh: 'out', notes: [] },
];

// ---------------------------------------------------------------- preferences (this device)
const KEY = 'hearth.soundPrefs';
export function soundPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ignore */ }
  const events = {};
  for (const [id, , , , def] of EVENTS) {
    const e = (p.events || {})[id];
    const legacyOff = p.on && p.on[id] === false; // older settings stored on/off per sound
    events[id] = { sound: e && e.sound ? e.sound : legacyOff ? 'none' : def };
  }
  return { enabled: localStorage.getItem('hearth.sounds') !== 'off', volume: Number.isFinite(+p.volume) ? Math.min(1, Math.max(0, +p.volume)) : 0.7, events };
}
export function setSoundPrefs({ enabled, volume, event, sound }) {
  const cur = soundPrefs();
  if (enabled !== undefined) localStorage.setItem('hearth.sounds', enabled ? 'on' : 'off');
  const next = { volume: volume ?? cur.volume, events: cur.events };
  if (event) next.events[event] = { sound };
  localStorage.setItem(KEY, JSON.stringify(next));
}
export function resetSoundPrefs() { localStorage.removeItem(KEY); localStorage.removeItem('hearth.sounds'); }

// ---------------------------------------------------------------- your own sound files (IndexedDB, this device)
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('hearth-ui', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function store(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('files', mode);
    const req = fn(t.objectStore('files'));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}
const customCache = new Map();
export async function setCustomSound(event, file) {
  if (file.size > 3 * 1024 * 1024) throw new Error('Sound files can be up to 3 MB.');
  const buf = await audio().decodeAudioData(await file.arrayBuffer()).catch(() => { throw new Error('That file isn\u2019t an audio format this browser can play.'); });
  await store('readwrite', (s) => s.put({ blob: file, name: file.name }, 'sound:' + event));
  customCache.set(event, buf);
  setSoundPrefs({ event, sound: 'custom' });
}
export async function customSoundName(event) {
  const rec = await store('readonly', (s) => s.get('sound:' + event)).catch(() => null);
  return rec ? rec.name : '';
}
async function customBuffer(event) {
  if (customCache.has(event)) return customCache.get(event);
  const rec = await store('readonly', (s) => s.get('sound:' + event)).catch(() => null);
  if (!rec) return null;
  const buf = await audio().decodeAudioData(await rec.blob.arrayBuffer()).catch(() => null);
  if (buf) customCache.set(event, buf);
  return buf;
}

// ---------------------------------------------------------------- synthesis
let ctx = null;
const audio = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());
const hz = (name) => {
  const m = /^([A-G])(#?)(\d)$/.exec(name);
  const semis = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] ? 1 : 0) + (+m[3] - 4) * 12;
  return 440 * 2 ** (semis / 12);
};
function env(gainNode, t, attack, peak, decay) {
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}
function osc(c, type, f, t, stop, to, glideTime) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + glideTime);
  o.start(t);
  o.stop(stop);
  return o;
}
// A sum of sine partials: [frequency ratio, level, decay seconds]
function partials(c, out, f, t, d, v, list, to) {
  for (const [ratio, level, decay] of list) {
    const g = c.createGain();
    env(g, t, 0.004, v * level, Math.min(d, decay));
    osc(c, 'sine', f * ratio, t, t + d + 0.1, to ? to * ratio : null, d * 0.6).connect(g).connect(out);
  }
}
function noise(c, out, t, d, v, freq, q) {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * d) + 1, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(); src.buffer = buf;
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
  const g = c.createGain(); env(g, t, 0.002, v, d);
  src.connect(bp).connect(g).connect(out);
  src.start(t);
}
const INSTRUMENTS = {
  // FM bell: brightness fades as the modulation index decays.
  bell(c, out, f, t, d, v) {
    const car = c.createOscillator(); car.frequency.value = f;
    const mod = c.createOscillator(); mod.frequency.value = f * 3.5;
    const idx = c.createGain();
    idx.gain.setValueAtTime(f * 2.2, t);
    idx.gain.exponentialRampToValueAtTime(f * 0.05, t + d * 0.8);
    mod.connect(idx).connect(car.frequency);
    const g = c.createGain(); env(g, t, 0.003, v * 0.55, d);
    car.connect(g).connect(out);
    car.start(t); mod.start(t); car.stop(t + d + 0.1); mod.stop(t + d + 0.1);
    partials(c, out, f, t, d, v * 0.25, [[2, 0.5, d * 0.5]]);
  },
  marimba(c, out, f, t, d, v) { partials(c, out, f, t, d, v, [[1, 0.7, d], [4, 0.18, 0.12], [9.9, 0.05, 0.04]]); },
  kalimba(c, out, f, t, d, v) { partials(c, out, f, t, d, v, [[1, 0.65, d], [5.4, 0.12, 0.18], [8.9, 0.04, 0.06]]); },
  glass(c, out, f, t, d, v) { partials(c, out, f, t, d, v, [[1, 0.45, d], [2.32, 0.25, d * 0.7], [4.25, 0.14, d * 0.45], [6.63, 0.07, d * 0.3]]); },
  vibes(c, out, f, t, d, v) {
    const trem = c.createGain(); trem.gain.value = 0.85; trem.connect(out);
    const lfo = osc(c, 'sine', 5.5, t, t + d + 0.1); const depth = c.createGain(); depth.gain.value = 0.25;
    lfo.connect(depth).connect(trem.gain);
    partials(c, trem, f, t, d, v, [[1, 0.6, d], [4, 0.12, d * 0.4]]);
  },
  soft(c, out, f, t, d, v, to) {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.connect(out);
    const g = c.createGain(); env(g, t, 0.015, v * 0.6, d);
    osc(c, 'triangle', f, t, t + d + 0.1, to, d * 0.8).connect(g).connect(lp);
  },
  muffled(c, out, f, t, d, v) {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.connect(out);
    partials(c, lp, f, t, d, v * 1.4, [[1, 0.7, d], [2, 0.3, d * 0.6]]);
  },
  bubble(c, out, f, t, d, v) {
    const g = c.createGain(); env(g, t, 0.004, v * 0.6, d);
    osc(c, 'sine', f * 0.8, t, t + d + 0.05, f * 1.5, d * 0.7).connect(g).connect(out);
  },
  pop(c, out, f, t, d, v) {
    const g = c.createGain(); env(g, t, 0.002, v * 0.7, d);
    osc(c, 'sine', f * 1.6, t, t + d + 0.05, f * 0.45, d * 0.7).connect(g).connect(out);
    noise(c, out, t, 0.012, v * 0.2, 3500, 1);
  },
  chip(c, out, f, t, d, v) {
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.connect(out);
    const g = c.createGain();
    g.gain.setValueAtTime(v * 0.18, t); g.gain.setValueAtTime(v * 0.18, t + d * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc(c, 'square', f, t, t + d + 0.02).connect(g).connect(lp);
  },
  click(c, out, f, t, d, v, to) {
    noise(c, out, t, 0.008, v * 0.35, 2500, 2);
    INSTRUMENTS.soft(c, out, f, t, d, v * 0.8, to);
  },
  // Plucked string (Karplus-Strong), computed straight into a buffer.
  pluck(c, out, f, t, d, v) {
    const sr = c.sampleRate;
    const len = Math.ceil(sr * d);
    const buf = c.createBuffer(1, len, sr);
    const y = buf.getChannelData(0);
    const n = Math.max(2, Math.round(sr / f));
    for (let i = 0; i < n && i < len; i++) y[i] = (Math.random() * 2 - 1) * 0.6;
    for (let i = n; i < len; i++) y[i] = 0.996 * 0.5 * (y[i - n] + y[Math.max(0, i - n - 1)]);
    const src = c.createBufferSource(); src.buffer = buf;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(9000, f * 8);
    const g = c.createGain(); g.gain.value = v * 0.9;
    src.connect(lp).connect(g).connect(out);
    src.start(t);
  },
  none() {},
};
function whoosh(c, out, kind) {
  const d = kind === 'out' ? 0.18 : 0.3;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * d), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(); src.buffer = buf;
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
  const [a, b] = kind === 'down' ? [2200, 350] : kind === 'out' ? [900, 4200] : [350, 2200];
  bp.frequency.setValueAtTime(a, 0); bp.frequency.exponentialRampToValueAtTime(b, d);
  const g = c.createGain(); g.gain.setValueAtTime(0.0001, 0); g.gain.exponentialRampToValueAtTime(kind === 'out' ? 0.35 : 0.22, d * 0.35); g.gain.exponentialRampToValueAtTime(0.0001, d);
  src.connect(bp).connect(g).connect(out);
  src.start(0);
}
// A small, soft room: decaying stereo noise used as an impulse response.
function roomImpulse(c, seconds = 1.1) {
  const len = Math.ceil(c.sampleRate * seconds);
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2;
  }
  return ir;
}
const rendered = new Map();
export async function renderPreset(p, sampleRate) {
  const key = p.id + '@' + (sampleRate || 'live');
  if (rendered.has(key)) return rendered.get(key);
  const sr = sampleRate || audio().sampleRate;
  const end = Math.max(0.35, ...p.notes.map(([, t, d]) => t + d)) + 1.0;
  const off = new OfflineAudioContext(2, Math.ceil(sr * end), sr);
  const dry = off.createGain();
  const wet = off.createGain(); wet.gain.value = 0.22;
  const verb = off.createConvolver(); verb.buffer = roomImpulse(off);
  const comp = off.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 4;
  dry.connect(comp); dry.connect(verb).connect(wet).connect(comp); comp.connect(off.destination);
  for (const [n, t, d, v, to] of p.notes) INSTRUMENTS[p.inst](off, dry, hz(n), t, d, v, to ? hz(to) : null);
  if (p.whoosh) whoosh(off, dry, p.whoosh);
  const buf = await off.startRendering();
  // Loudness-match: every sound peaks at the same level, so none is jarringly louder than another.
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); }
  const k = peak > 0 ? 0.85 / peak : 1;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= k; }
  rendered.set(key, buf);
  return buf;
}

// ---------------------------------------------------------------- playback
const last = {};
export async function playSound(event, { force = false, sound } = {}) {
  const prefs = soundPrefs();
  const choice = sound || (prefs.events[event] || {}).sound;
  if (!choice || choice === 'none' || !prefs.volume) return;
  if (!force && !prefs.enabled) return;
  const now = Date.now();
  if (!force && now - (last[event] || 0) < 350) return; // don't stack when lots happens at once
  last[event] = now;
  try {
    const c = audio();
    if (c.state === 'suspended') await c.resume();
    let buf = null;
    if (choice === 'custom') buf = await customBuffer(event);
    else { const p = LIBRARY.find((x) => x.id === choice); if (p) buf = await renderPreset(p); }
    if (!buf) return;
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); g.gain.value = prefs.volume * prefs.volume; // perceptual volume curve
    src.connect(g).connect(c.destination);
    src.start();
    if (choice === 'custom') src.stop(c.currentTime + 5); // keep custom sounds short
  } catch { /* audio unavailable */ }
}
