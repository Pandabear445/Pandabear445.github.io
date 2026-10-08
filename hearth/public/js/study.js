// Study tools (turn them on in Settings → Study tools):
//   Focus      a Pomodoro-style timer (focus / short break / long break). Run it alone, or start it in a voice
//              channel or call so everyone there studies on the same clock ("study together").
//   Flashcards decks with spaced repetition (cards you know come back less often), and quick quizzes.
//   Assignments due dates, subjects and reminders (a push notification even when the app is closed).
//   Stats      focus minutes per day, cards reviewed, streak.
// Decks, assignments, settings and stats are end-to-end encrypted with a key only your account can derive
// (E2EE.vaultKey), then synced through the server, so they follow you to every device.
import { h, clear, icon, toast } from './util.js';
import { api } from './api.js';
import { modal, field, confirmDialog, menu } from './ui.js';
import * as E2EE from './e2ee.js';

const DEFAULTS = { focus: 25, short: 5, long: 15, every: 4, autoStart: false, dnd: true, muteMic: false, sound: true, newPerDay: 20 };
const DAY = 86400000;
const dayId = (t = Date.now()) => { const d = new Date(t); return `day-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const PHASE_LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };

// The phase at time t for a cycle starting at `start` (used for the shared timer: everyone computes the same).
function phaseAt(cfg, start, t) {
  const seq = [];
  for (let i = 0; i < cfg.every; i++) { seq.push(['focus', cfg.focus]); seq.push([i === cfg.every - 1 ? 'long' : 'short', i === cfg.every - 1 ? cfg.long : cfg.short]); }
  const total = seq.reduce((n, [, m]) => n + m * 60000, 0);
  let e = (t - start) % total; const cycle = Math.floor((t - start) / total);
  for (let i = 0; i < seq.length; i++) {
    const len = seq[i][1] * 60000;
    if (e < len) return { phase: seq[i][0], left: len - e, len, index: cycle * seq.length + i, round: Math.floor(i / 2) + 1 };
    e -= len;
  }
  return { phase: 'focus', left: 0, len: 1, index: 0, round: 1 };
}

// Spaced repetition (a simplified SM-2, like Anki): grade 1 = again, 2 = hard, 3 = good, 4 = easy.
function schedule(card, grade, now = Date.now()) {
  const c = { ease: 2.5, interval: 0, reps: 0, lapses: 0, ...card };
  if (grade === 1) { c.reps = 0; c.lapses += 1; c.ease = Math.max(1.3, c.ease - 0.2); c.interval = 0; c.due = now + 60000; return c; }
  if (grade === 2) { c.ease = Math.max(1.3, c.ease - 0.15); c.interval = c.reps === 0 ? 0 : Math.max(1, c.interval * 1.2); c.due = now + (c.reps === 0 ? 10 * 60000 : c.interval * DAY); c.reps += c.reps === 0 ? 0 : 1; return c; }
  if (grade === 3) c.interval = c.reps === 0 ? 1 : c.reps === 1 ? 3 : Math.round(c.interval * c.ease);
  if (grade === 4) { c.interval = c.reps === 0 ? 4 : Math.round(c.interval * c.ease * 1.3); c.ease += 0.15; }
  c.reps += 1; c.due = now + c.interval * DAY;
  return c;
}
// "term - definition", "term<TAB>definition", "term,definition" or "term : definition", one card per line.
function parseCards(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.split('\t').length > 1 ? l.split('\t') : l.match(/^(.+?)\s+[-–—:]\s+(.+)$/) ? l.match(/^(.+?)\s+[-–—:]\s+(.+)$/).slice(1) : l.split(/,(.+)/);
    return m && m[0] && m[1] ? { id: rid(), front: m[0].trim().slice(0, 2000), back: m[1].trim().slice(0, 4000) } : null;
  }).filter(Boolean);
}

export function createStudy(ctx) {
  // ctx: { S, voice: () => voice|null, socket: () => socket, playSound, desktopNotify(title, body), setStatus(s), getStatus(),
  //        setMuted(bool), onChange() (redraw the main view if it shows Study), openStudy(tab) }
  const items = new Map(); // id -> { kind, obj, updatedAt }
  let key = null; let since = 0; let loaded = false; let loading = null;
  let room = null; // shared timer: { room, state, offset }

  // ------------------------------------------------------------------ encrypted sync
  async function vkey() { if (!key) key = await E2EE.vaultKey(ctx.S.privateKey, ctx.S.me.publicKey); return key; }
  function sync() {
    if (loading) return loading;
    loading = (async () => {
      const r = await api('GET', `/me/study?since=${since}`);
      const k = await vkey();
      for (const it of r.items) {
        if (it.deleted) { items.delete(it.id); continue; }
        try { items.set(it.id, { kind: it.kind, obj: await E2EE.openVault(k, it.kind, it.id, it.data), updatedAt: it.updatedAt }); } catch { /* unreadable (e.g. made before a reset with new keys) */ }
        since = Math.max(since, it.updatedAt);
      }
      since = Math.max(since, ...r.items.map((i) => i.updatedAt), 0);
      loaded = true;
    })().finally(() => { loading = null; });
    return loading;
  }
  async function put(kind, id, obj) {
    items.set(id, { kind, obj, updatedAt: Date.now() });
    const data = await E2EE.sealVault(await vkey(), kind, id, obj);
    const r = await api('PUT', `/me/study/${id}`, { kind, data });
    since = Math.max(since, r.updatedAt);
  }
  async function del(id) { items.delete(id); const r = await api('DELETE', `/me/study/${id}`); since = Math.max(since, r.updatedAt); }
  const all = (kind) => [...items.entries()].filter(([, v]) => v.kind === kind).map(([id, v]) => ({ id, ...v.obj }));
  const settings = () => ({ ...DEFAULTS, ...((items.get('settings') || {}).obj || {}) });
  async function saveSettings(patch) { await put('settings', 'settings', { ...settings(), ...patch }); }
  async function bumpDay(patch) {
    const id = dayId(); const cur = (items.get(id) || {}).obj || { focusMin: 0, sessions: 0, reviewed: 0, tasksDone: 0 };
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) next[k] = (next[k] || 0) + v;
    await put('day', id, next).catch(() => {});
  }

  // ------------------------------------------------------------------ the focus timer (this device)
  const T_KEY = 'hearth.study.timer';
  const loadTimer = () => { try { return JSON.parse(localStorage.getItem(T_KEY) || 'null'); } catch { return null; } };
  let timer = loadTimer(); // { phase, endsAt, pausedLeft, round, running }
  const saveTimer = () => { try { if (timer) localStorage.setItem(T_KEY, JSON.stringify(timer)); else localStorage.removeItem(T_KEY); } catch { /* */ } };
  let statusBefore = null;
  function focusStarted() {
    const s = settings();
    if (s.dnd && ctx.getStatus() !== 'dnd') { statusBefore = ctx.getStatus(); ctx.setStatus('dnd'); }
    if (s.muteMic && ctx.voice() && ctx.voice().channelId && !ctx.voice().muted) ctx.setMuted(true);
  }
  function focusEnded() { if (statusBefore) { ctx.setStatus(statusBefore); statusBefore = null; } }
  function startSolo(phase = 'focus') {
    const s = settings();
    const min = { focus: s.focus, short: s.short, long: s.long }[phase];
    timer = { phase, endsAt: Date.now() + min * 60000, len: min * 60000, round: (timer && timer.round) || 1, running: true };
    saveTimer();
    if (phase === 'focus') focusStarted(); else focusEnded();
    ctx.onChange();
  }
  function pauseSolo() { if (!timer || !timer.running) return; timer.pausedLeft = timer.endsAt - Date.now(); timer.running = false; saveTimer(); focusEnded(); ctx.onChange(); }
  function resumeSolo() { if (!timer || timer.running) return; timer.endsAt = Date.now() + timer.pausedLeft; timer.running = true; delete timer.pausedLeft; saveTimer(); if (timer.phase === 'focus') focusStarted(); ctx.onChange(); }
  function stopSolo() { timer = null; saveTimer(); focusEnded(); ctx.onChange(); }
  function chime(title, body) {
    if (settings().sound) ctx.playSound('friend', { force: true, sound: 'harp' });
    ctx.desktopNotify(title, body);
    toast(`${title} ${body}`);
  }
  function soloFinished() {
    const s = settings();
    const was = timer.phase;
    if (was === 'focus') {
      // Only the time actually spent counts (a skipped round counts what was done of it).
      const spent = Math.round((timer.len - (timer.skippedLeft || 0)) / 60000);
      if (spent > 0) bumpDay({ focusMin: spent, sessions: timer.skippedLeft ? 0 : 1 });
      const long = timer.round % s.every === 0;
      chime('Focus done.', long ? `Take a ${s.long}-minute break.` : `Take a ${s.short}-minute break.`);
      timer = { phase: long ? 'long' : 'short', endsAt: 0, len: (long ? s.long : s.short) * 60000, round: timer.round, running: false, pausedLeft: (long ? s.long : s.short) * 60000 };
      focusEnded();
    } else {
      chime('Break over.', 'Ready for the next focus round?');
      timer = { phase: 'focus', endsAt: 0, len: s.focus * 60000, round: timer.round + 1, running: false, pausedLeft: s.focus * 60000 };
    }
    saveTimer();
    if (s.autoStart) resumeSolo();
    ctx.onChange();
  }

  // ------------------------------------------------------------------ the shared timer (voice channel / call)
  function onRoomState({ room: r, state, by }) {
    if (!state) {
      if (room && room.room === r) { room = null; focusEnded(); if (by && by !== ctx.S.me.id) toast('The shared focus timer was stopped.'); }
      ctx.onChange(); return;
    }
    room = { room: r, state, offset: state.now - Date.now(), lastIndex: null };
    ctx.onChange();
  }
  const roomPhase = () => (room ? phaseAt(room.state, room.state.startedAt, Date.now() + room.offset) : null);
  function startRoom(cfg) { ctx.socket().emit('study:start', cfg, (r) => { if (r && r.error) toast(r.error, 'error'); }); }
  function stopRoom() { ctx.socket().emit('study:stop', {}, () => {}); }
  // Leaving the call ends your part in it.
  function inRoom() { const v = ctx.voice(); return !!(room && v && v.channelId === room.room); }

  // One clock for everything: updates the timer pill and notices phase changes.
  setInterval(() => {
    if (timer && timer.running && Date.now() >= timer.endsAt) soloFinished();
    if (room) {
      if (!inRoom()) { room = null; focusEnded(); ctx.onChange(); } else {
        const p = roomPhase();
        if (room.lastIndex !== null && p.index !== room.lastIndex) {
          const prev = p.phase === 'focus' ? 'break' : 'focus';
          if (prev === 'focus') bumpDay({ focusMin: room.state.focus, sessions: 1 });
          chime(p.phase === 'focus' ? 'Break over.' : 'Focus round done.', p.phase === 'focus' ? 'Back to it, everyone.' : `${PHASE_LABEL[p.phase]} for ${Math.round(p.len / 60000)} minutes.`);
          if (p.phase === 'focus') focusStarted(); else focusEnded();
        }
        if (room.lastIndex === null && p.phase === 'focus') focusStarted();
        room.lastIndex = p.index;
      }
    }
    document.querySelectorAll('[data-study-clock]').forEach((el) => { el.textContent = clockText(); });
    const pill = document.getElementById('study-pill');
    // (A shared timer already shows in the call bar.)
    const show = !!(timer && (timer.running || timer.pausedLeft)) && !(room && inRoom());
    if (pill) { pill.hidden = !show; if (show) pill.querySelector('.sp-text').textContent = clockText(); }
  }, 1000);
  function clockText() {
    if (room && inRoom()) { const p = roomPhase(); return `${PHASE_LABEL[p.phase]} · ${mmss(p.left)} (together)`; }
    if (!timer) return '';
    const left = timer.running ? timer.endsAt - Date.now() : timer.pausedLeft;
    return `${PHASE_LABEL[timer.phase]} · ${mmss(left)}${timer.running ? '' : ' (paused)'}`;
  }

  // ------------------------------------------------------------------ reminders
  async function setReminder(task) {
    const at = task.due && task.remind !== 'none' ? task.due - ({ due: 0, hour: 3600000, day: DAY }[task.remind] || 0) : null;
    await api('PUT', `/me/study-reminders/${task.id}`, { at: at && at > Date.now() ? at : null }).catch(() => {});
  }
  function onReminder({ id }) {
    const t = (items.get(id) || {}).obj;
    chime('⏰ Reminder', t ? `${t.title}${t.due ? ` — due ${new Date(t.due).toLocaleString()}` : ''}` : 'Something on your study list is due.');
  }

  // ------------------------------------------------------------------ the Study page
  function view(tab = 'focus', setTab) {
    const wrap = h('div', { class: 'study' });
    const body = h('div', { class: 'study-body' });
    const tabs = [['focus', 'Focus', 'timer'], ['cards', 'Flashcards', 'cards'], ['tasks', 'Assignments', 'tasks'], ['stats', 'Stats', 'chart']];
    wrap.append(h('div', { class: 'study-tabs', role: 'tablist' }, tabs.map(([k, l, ic]) => h('button', { class: `tab${tab === k ? ' active' : ''}`, role: 'tab', 'aria-selected': String(tab === k), onclick: () => setTab(k) }, icon(ic), l))), body);
    const draw = () => {
      clear(body);
      if (!loaded) { body.append(h('span', { class: 'spinner' })); return; }
      body.append(({ focus: focusTab, cards: cardsTab, tasks: tasksTab, stats: statsTab }[tab] || focusTab)(draw));
    };
    draw();
    sync().then(draw).catch((e) => { clear(body).append(h('p', { class: 'form-error' }, e.message)); });
    return wrap;
  }

  function focusTab(redraw) {
    const s = settings();
    const v = ctx.voice();
    const out = h('div', { class: 'stack' });
    const bigClock = h('div', { class: 'focus-clock', 'data-study-clock': '' }, clockText() || `${PHASE_LABEL.focus} · ${s.focus}:00`);
    out.append(h('div', { class: 'focus-card' }, bigClock,
      room && inRoom() ? h('div', { class: 'row gap center' }, h('span', { class: 'rpill ok' }, 'Studying together with your call'), h('button', { class: 'btn ghost', onclick: stopRoom }, 'Stop for everyone'))
        : h('div', { class: 'row gap center' },
          !timer ? h('button', { class: 'btn primary lg', onclick: () => startSolo('focus') }, icon('play'), `Start ${s.focus}-minute focus`)
            : timer.running ? h('button', { class: 'btn lg', onclick: pauseSolo }, icon('pause'), 'Pause')
              : h('button', { class: 'btn primary lg', onclick: resumeSolo }, icon('play'), timer.pausedLeft === timer.len ? `Start ${PHASE_LABEL[timer.phase].toLowerCase()}` : 'Resume'),
          timer ? h('button', { class: 'btn ghost', onclick: () => {
            if (timer.phase !== 'focus') return startSolo('focus');
            timer.skippedLeft = timer.running ? Math.max(0, timer.endsAt - Date.now()) : timer.pausedLeft;
            timer.endsAt = Date.now(); timer.running = true; soloFinished();
          } }, 'Skip') : null,
          timer ? h('button', { class: 'btn ghost', onclick: stopSolo }, 'Stop') : null),
      h('p', { class: 'field-hint center' }, `${s.focus} min focus, ${s.short} min break, a ${s.long}-minute break every ${s.every} rounds.${s.dnd ? ' Do Not Disturb turns on while you focus.' : ''}`)));
    out.append(h('div', { class: 'study-section' }, h('h3', null, 'Study together'),
      v && v.channelId
        ? (room && inRoom() ? h('p', { class: 'muted-p' }, 'A shared timer is running in your call. Everyone there sees the same countdown and hears the chime.')
          : h('div', { class: 'stack' }, h('p', { class: 'muted-p' }, 'Start a shared timer for everyone in your current call or voice channel.'),
            h('div', null, h('button', { class: 'btn primary', onclick: () => startRoom({ focus: s.focus, short: s.short, long: s.long, every: s.every }) }, icon('people'), 'Start a shared focus timer'))))
        : h('p', { class: 'muted-p' }, 'Join a voice channel or call with friends, then start a shared timer here (or from the call bar) so you all focus and take breaks together.')));
    out.append(h('div', { class: 'study-section' }, h('h3', null, 'Timer settings'), timerSettings(redraw)));
    return out;
  }
  function timerSettings(redraw) {
    const s = settings();
    const num = (k, label, min, max) => {
      const i = h('input', { class: 'input', type: 'number', min: String(min), max: String(max), value: String(s[k]) });
      i.onchange = () => saveSettings({ [k]: Math.min(max, Math.max(min, Math.round(+i.value) || DEFAULTS[k])) }).then(redraw);
      return field(label, i);
    };
    const chk = (k, label) => h('label', { class: 'row gap tight' }, h('input', { type: 'checkbox', checked: !!s[k], onchange: (e) => saveSettings({ [k]: e.target.checked }).then(redraw) }), h('span', null, label));
    return h('div', { class: 'stack' }, h('div', { class: 'grid-4' }, num('focus', 'Focus (min)', 5, 180), num('short', 'Short break', 1, 60), num('long', 'Long break', 1, 90), num('every', 'Long break every', 2, 8)),
      chk('dnd', 'Turn on Do Not Disturb while focusing'), chk('muteMic', 'Mute my mic during focus (in calls)'), chk('autoStart', 'Start the next round automatically'), chk('sound', 'Play a chime when a round ends'));
  }

  // ---- flashcards
  const dueCount = (d) => (d.cards || []).filter((c) => (c.due || 0) <= Date.now() && c.reps).length;
  const newCount = (d) => (d.cards || []).filter((c) => !c.reps).length;
  function cardsTab(redraw) {
    const decks = all('deck').sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const out = h('div', { class: 'stack' });
    out.append(h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: () => editDeck(null, redraw) }, icon('plus'), 'New deck'),
      h('button', { class: 'btn', onclick: () => importDeck(redraw) }, icon('download'), 'Import')));
    if (!decks.length) { out.append(h('div', { class: 'empty-state small' }, icon('cards'), h('p', null, 'Make a deck of flashcards: a word and its meaning, a question and its answer. Paste a list to make many at once (it works with Quizlet exports too).'))); return out; }
    out.append(h('div', { class: 'deck-grid' }, decks.map((d) => {
      const due = dueCount(d); const fresh = Math.min(newCount(d), settings().newPerDay);
      return h('div', { class: 'deck', style: { '--dc': d.color || '#5865f2' } },
        h('div', { class: 'deck-top' }, h('strong', null, d.name), ibtnMore(d, redraw)),
        h('span', { class: 'field-hint' }, `${(d.cards || []).length} cards · ${due} due · ${newCount(d)} new`),
        h('div', { class: 'row gap tight' },
          h('button', { class: 'btn primary sm', disabled: !due && !fresh, onclick: () => review(d, redraw) }, due || fresh ? `Study (${due + fresh})` : 'All caught up'),
          h('button', { class: 'btn ghost sm', disabled: (d.cards || []).length < 4, title: (d.cards || []).length < 4 ? 'Needs at least 4 cards' : '', onclick: () => quiz(d) }, 'Quiz'),
          h('button', { class: 'btn ghost sm', onclick: () => editDeck(d, redraw) }, 'Edit')));
    })));
    return out;
  }
  function ibtnMore(d, redraw) {
    return h('button', { class: 'icon-btn sm', 'aria-label': `More for ${d.name}`, 'data-pop-anchor': '', onclick: (e) => menu(e.currentTarget, [
      { label: 'Export as text', icon: 'download', action: () => {
        const text = (d.cards || []).map((c) => `${c.front}\t${c.back}`).join('\n');
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
        h('a', { href: url, download: `${(d.name || 'deck').replace(/[^\w -]+/g, '')}.txt` }).click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      } },
      { label: 'Reset progress', icon: 'arrowUp', action: async () => { await put('deck', d.id, { ...strip(d), cards: d.cards.map(({ id, front, back }) => ({ id, front, back })) }); redraw(); } },
      { label: 'Delete deck', icon: 'trash', danger: true, action: async () => { if (await confirmDialog({ title: `Delete ${d.name}?`, confirm: 'Delete', danger: true })) { await del(d.id); redraw(); } } },
    ], { align: 'end' }) }, icon('more'));
  }
  const strip = (d) => { const { id, ...rest } = d; void id; return rest; };
  function editDeck(d, redraw) {
    const deck = d ? { ...d, cards: (d.cards || []).map((c) => ({ ...c })) } : { id: 'deck-' + rid(), name: '', color: '#5865f2', cards: [] };
    const name = h('input', { class: 'input', maxlength: '60', value: deck.name, placeholder: 'e.g. Spanish verbs, Biology ch. 4' });
    const list = h('div', { class: 'card-edit-list' });
    const paste = h('textarea', { class: 'input', rows: '3', placeholder: 'Paste many at once, one per line:\nhola - hello\nadiós - goodbye' });
    const drawList = () => {
      clear(list);
      deck.cards.forEach((c, i) => {
        const f = h('textarea', { class: 'input', rows: '1', placeholder: 'Front (question / term)', value: c.front, oninput: (e) => { c.front = e.target.value; } });
        f.value = c.front;
        const b = h('textarea', { class: 'input', rows: '1', placeholder: 'Back (answer / meaning)', oninput: (e) => { c.back = e.target.value; } });
        b.value = c.back;
        list.append(h('div', { class: 'card-edit' }, h('span', { class: 'card-num' }, String(i + 1)), f, b, h('button', { class: 'icon-btn sm', 'aria-label': 'Delete card', onclick: () => { deck.cards.splice(i, 1); drawList(); } }, icon('trash'))));
      });
      list.append(h('button', { class: 'btn ghost sm', onclick: () => { deck.cards.push({ id: rid(), front: '', back: '' }); drawList(); setTimeout(() => list.querySelector('.card-edit:last-of-type textarea').focus(), 20); } }, icon('plus'), 'Add a card'));
    };
    drawList();
    modal({ title: d ? `Edit ${d.name}` : 'New deck', size: 'lg', body: h('div', { class: 'stack' }, field('Deck name', name), list, field('Add from a list', paste, 'Term and meaning separated by a tab, " - ", ":" or a comma.')),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', action: async () => {
        deck.name = name.value.trim() || 'Untitled deck';
        deck.cards = deck.cards.filter((c) => c.front.trim() && c.back.trim()).concat(parseCards(paste.value));
        await put('deck', deck.id, strip(deck));
        toast(`Saved ${deck.cards.length} cards.`); redraw();
      } }] });
  }
  function importDeck(redraw) {
    const name = h('input', { class: 'input', maxlength: '60', placeholder: 'Deck name' });
    const text = h('textarea', { class: 'input', rows: '8', placeholder: 'One card per line: term, then a tab, " - ", ":" or a comma, then the meaning.\n(Quizlet: Export → copy, and paste here.)' });
    const fileIn = h('input', { type: 'file', accept: '.txt,.csv,.tsv,text/plain', onchange: async () => { const f = fileIn.files[0]; if (f) { text.value = await f.text(); if (!name.value) name.value = f.name.replace(/\.\w+$/, ''); } } });
    modal({ title: 'Import flashcards', size: 'md', body: h('div', { class: 'stack' }, field('Deck name', name), text, field('Or a file', fileIn)),
      actions: [{ label: 'Cancel' }, { label: 'Import', kind: 'primary', action: async () => {
        const cards = parseCards(text.value);
        if (!cards.length) throw new Error('No cards found. Put one per line: term - meaning.');
        await put('deck', 'deck-' + rid(), { name: name.value.trim() || 'Imported deck', color: '#3ba55d', cards });
        toast(`Imported ${cards.length} cards.`); redraw();
      } }] });
  }
  // A review session: due cards first, then up to the daily number of new ones.
  function review(d, redraw) {
    const deck = { ...d, cards: d.cards.map((c) => ({ ...c })) };
    const s = settings();
    let queue = deck.cards.filter((c) => c.reps && (c.due || 0) <= Date.now()).concat(deck.cards.filter((c) => !c.reps).slice(0, s.newPerDay));
    let flipped = false; let done = 0;
    const box = h('div', { class: 'review' });
    let m;
    const finish = async () => {
      await put('deck', deck.id, strip(deck)).catch((e) => toast(e.message, 'error'));
      if (done) bumpDay({ reviewed: done });
      redraw();
    };
    const draw = () => {
      clear(box);
      if (!queue.length) { box.append(h('div', { class: 'review-done' }, h('h3', null, 'Done for now'), h('p', { class: 'muted-p' }, `You reviewed ${done} card${done === 1 ? '' : 's'}. Cards you know well come back later; tricky ones sooner.`), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close'))); return; }
      const c = queue[0];
      box.append(h('div', { class: 'review-count field-hint' }, `${queue.length} to go`),
        h('div', { class: `flashcard${flipped ? ' flipped' : ''}`, onclick: () => { if (!flipped) { flipped = true; draw(); } } },
          h('div', { class: 'fc-front' }, c.front), flipped ? h('div', { class: 'fc-back' }, c.back) : h('div', { class: 'fc-hint field-hint' }, 'Click or press Space to show the answer')),
        flipped ? h('div', { class: 'grade-row' }, [[1, 'Again', '<1 min'], [2, 'Hard', ''], [3, 'Good', ''], [4, 'Easy', '']].map(([g, l, sub]) => h('button', { class: `btn grade g${g}`, onclick: () => grade(g) }, h('strong', null, l), h('span', null, sub || `${g}`))))
          : h('button', { class: 'btn primary', onclick: () => { flipped = true; draw(); } }, 'Show answer'));
    };
    const grade = (g) => {
      const c = queue.shift();
      const next = schedule(c, g);
      Object.assign(deck.cards.find((x) => x.id === c.id), next);
      if (g === 1) queue.push(deck.cards.find((x) => x.id === c.id)); // again: back in this session
      done++; flipped = false; draw();
    };
    const keys = (e) => {
      if (e.target.closest('input, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); if (!flipped && queue.length) { flipped = true; draw(); } }
      if (flipped && ['1', '2', '3', '4'].includes(e.key)) grade(+e.key);
    };
    document.addEventListener('keydown', keys);
    m = modal({ title: d.name, size: 'md', className: 'review-modal', body: box, onClose: () => { document.removeEventListener('keydown', keys); finish(); } });
    draw();
  }
  function quiz(d) {
    const cards = [...d.cards].sort(() => Math.random() - 0.5).slice(0, 10);
    let i = 0; let score = 0; let answered = null;
    const box = h('div', { class: 'quiz' });
    let m;
    const draw = () => {
      clear(box);
      if (i >= cards.length) { box.append(h('div', { class: 'review-done' }, h('h3', null, `${score} / ${cards.length}`), h('p', { class: 'muted-p' }, score === cards.length ? 'Perfect!' : 'Use Study to practise the ones you missed.'), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close'))); return; }
      const c = cards[i];
      if (!c.options) c.options = [c.back, ...d.cards.filter((x) => x.id !== c.id && x.back !== c.back).sort(() => Math.random() - 0.5).slice(0, 3).map((x) => x.back)].sort(() => Math.random() - 0.5);
      box.append(h('div', { class: 'field-hint' }, `Question ${i + 1} of ${cards.length}`), h('div', { class: 'flashcard' }, h('div', { class: 'fc-front' }, c.front)),
        h('div', { class: 'quiz-options' }, c.options.map((o) => h('button', {
          class: `btn quiz-opt${answered !== null ? (o === c.back ? ' right' : o === answered ? ' wrong' : '') : ''}`, disabled: answered !== null,
          onclick: () => { answered = o; if (o === c.back) score++; draw(); },
        }, o))),
        answered !== null ? h('button', { class: 'btn primary', onclick: () => { i++; answered = null; draw(); } }, i + 1 < cards.length ? 'Next' : 'See score') : null);
    };
    m = modal({ title: `Quiz: ${d.name}`, size: 'md', className: 'review-modal', body: box });
    draw();
  }

  // ---- assignments
  function tasksTab(redraw) {
    const tasks = all('task');
    const out = h('div', { class: 'stack' });
    const title = h('input', { class: 'input', maxlength: '200', placeholder: 'What’s due? e.g. Chemistry lab report' });
    const subject = h('input', { class: 'input', maxlength: '40', placeholder: 'Subject (optional)', list: 'study-subjects' });
    const due = h('input', { class: 'input', type: 'datetime-local' });
    const remind = h('select', { class: 'input' }, h('option', { value: 'day' }, 'Remind me a day before'), h('option', { value: 'hour' }, 'An hour before'), h('option', { value: 'due' }, 'When it’s due'), h('option', { value: 'none' }, 'No reminder'));
    const add = async () => {
      if (!title.value.trim()) { title.focus(); return; }
      const t = { id: 'task-' + rid(), title: title.value.trim(), subject: subject.value.trim(), due: due.value ? new Date(due.value).getTime() : null, remind: remind.value, done: false, createdAt: Date.now() };
      await put('task', t.id, strip(t));
      await setReminder(t);
      redraw();
    };
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    const subjects = [...new Set(tasks.map((t) => t.subject).filter(Boolean))];
    out.append(h('div', { class: 'task-add' }, title, subject, due, remind, h('button', { class: 'btn primary', onclick: add }, icon('plus'), 'Add')),
      h('datalist', { id: 'study-subjects' }, subjects.map((s) => h('option', { value: s }))));
    const now = Date.now(); const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
    const groups = [
      ['Overdue', (t) => !t.done && t.due && t.due < now],
      ['Today', (t) => !t.done && t.due && t.due >= now && t.due <= endToday.getTime()],
      ['Next 7 days', (t) => !t.done && t.due && t.due > endToday.getTime() && t.due <= now + 7 * DAY],
      ['Later', (t) => !t.done && t.due && t.due > now + 7 * DAY],
      ['No due date', (t) => !t.done && !t.due],
      ['Done', (t) => t.done],
    ];
    if (!tasks.length) out.append(h('div', { class: 'empty-state small' }, icon('tasks'), h('p', null, 'Add homework, projects and exams with their due dates. You’ll get a reminder even when Hearth is closed.')));
    for (const [label, fn] of groups) {
      const list = tasks.filter(fn).sort((a, b) => (a.due || Infinity) - (b.due || Infinity));
      if (!list.length) continue;
      out.append(h('div', { class: `list-label${label === 'Overdue' ? ' danger-text' : ''}` }, `${label} — ${list.length}`),
        ...list.map((t) => h('div', { class: `task-row${t.done ? ' done' : ''}` },
          h('input', { type: 'checkbox', checked: !!t.done, 'aria-label': `Done: ${t.title}`, onchange: async (e) => {
            const next = { ...t, done: e.target.checked, doneAt: e.target.checked ? Date.now() : null };
            await put('task', t.id, strip(next));
            if (next.done) { bumpDay({ tasksDone: 1 }); api('PUT', `/me/study-reminders/${t.id}`, { at: null }).catch(() => {}); } else setReminder(next);
            redraw();
          } }),
          h('span', { class: 'task-text' }, h('strong', null, t.title), h('span', { class: 'field-hint' }, [t.subject, t.due ? `due ${new Date(t.due).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''].filter(Boolean).join(' · '))),
          h('button', { class: 'icon-btn sm', 'aria-label': `Delete ${t.title}`, onclick: async () => { await del(t.id); redraw(); } }, icon('trash')))));
    }
    return out;
  }

  // ---- stats
  function statsTab() {
    const days = []; for (let i = 6; i >= 0; i--) { const t = Date.now() - i * DAY; days.push({ t, d: (items.get(dayId(t)) || {}).obj || {} }); }
    const today = days[6].d;
    let streak = 0;
    for (let i = 0; ; i++) { const d = (items.get(dayId(Date.now() - i * DAY)) || {}).obj; if (d && (d.focusMin || d.reviewed)) streak++; else if (i > 0 || !(today.focusMin || today.reviewed)) break; if (i > 3650) break; }
    const max = Math.max(25, ...days.map((x) => x.d.focusMin || 0));
    const weekFocus = days.reduce((n, x) => n + (x.d.focusMin || 0), 0);
    return h('div', { class: 'stack' },
      h('div', { class: 'stat-cards' },
        h('div', { class: 'stat-card' }, h('strong', null, `${today.focusMin || 0} min`), h('span', null, 'focused today')),
        h('div', { class: 'stat-card' }, h('strong', null, `${Math.floor(weekFocus / 60)} h ${weekFocus % 60} min`), h('span', null, 'this week')),
        h('div', { class: 'stat-card' }, h('strong', null, `${today.reviewed || 0}`), h('span', null, 'cards reviewed today')),
        h('div', { class: 'stat-card' }, h('strong', null, `${streak} day${streak === 1 ? '' : 's'}`), h('span', null, 'streak'))),
      h('div', { class: 'study-section' }, h('h3', null, 'Focus minutes, last 7 days'),
        h('div', { class: 'bars' }, days.map((x) => h('div', { class: 'bar-col' },
          h('div', { class: 'bar', style: { height: `${Math.round(((x.d.focusMin || 0) / max) * 100)}%` }, title: `${x.d.focusMin || 0} min` }),
          h('span', { class: 'bar-label' }, new Date(x.t).toLocaleDateString(undefined, { weekday: 'short' })))))),
      h('p', { class: 'field-hint' }, 'Your study data is end-to-end encrypted: the server stores it scrambled and syncs it to your other devices.'));
  }

  // The little timer pill (bottom left) while a timer runs; click to open Study.
  function pill() {
    return h('button', { id: 'study-pill', class: 'study-pill', hidden: true, onclick: () => ctx.openStudy('focus') }, icon('timer'), h('span', { class: 'sp-text' }));
  }
  // For the call bar: start/stop the shared timer, and show it.
  function callControls() {
    if (room && inRoom()) return h('span', { class: 'call-study' }, icon('timer'), h('span', { 'data-study-clock': '' }, clockText()), h('button', { class: 'link-btn', onclick: stopRoom }, 'Stop'));
    if (!ctx.S.me.studyEnabled) return null;
    return h('button', { class: 'link-btn call-study-start', onclick: () => { const s = settings(); sync().then(() => startRoom({ focus: s.focus, short: s.short, long: s.long, every: s.every })); } }, icon('timer'), 'Study together');
  }

  // Settings → Study tools.
  function settingsSection({ section, toggle }) {
    const host = h('div', { class: 'stack' });
    const draw = () => {
      clear(host);
      host.append(section(null, toggle('Show study tools', !!ctx.S.me.studyEnabled, async (v) => {
        const r = await api('PATCH', '/me/study-settings', { enabled: v }); ctx.S.me.studyEnabled = r.enabled; ctx.onEnabled(); draw();
      }, 'Adds Study to your Home: a focus timer (alone or with your call), flashcards, assignments with reminders, and stats. Everything you save there is end-to-end encrypted.')));
      if (ctx.S.me.studyEnabled) {
        const t = h('div', null, h('span', { class: 'spinner' }));
        host.append(section('Focus timer', t));
        sync().then(() => { clear(t).append(timerSettings(draw)); }).catch((e) => clear(t).append(h('p', { class: 'form-error' }, e.message)));
        const np = h('input', { class: 'input', type: 'number', min: '0', max: '200', value: String(settings().newPerDay) });
        np.onchange = () => saveSettings({ newPerDay: Math.min(200, Math.max(0, Math.round(+np.value) || 0)) });
        host.append(section('Flashcards', field('New cards per day', np, 'How many cards you haven’t seen before are added to each study session.')));
      }
    };
    draw();
    return host;
  }

  return { view, pill, callControls, settingsSection, onRoomState, onReminder, sync, onRemoteChange: () => sync().then(() => ctx.onChange()), clockText };
}
export const _test = { schedule, parseCards, phaseAt };
