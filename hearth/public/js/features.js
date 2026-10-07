// Polls, voice messages, server events and message reminders.
import { h, clear, icon, toast, fmtStamp, fmtDay, fmtTime } from './util.js';
import { api } from './api.js';
import { modal, confirmDialog, field, menu } from './ui.js';

let X = null; // the app's helpers: S, getUser, displayName, avatarEl, socket(), notify, playSound, jump, addInbox, openChannel
export function initFeatures(ctx) { X = ctx; }

// ======================================================================= polls
// The question and options are inside the end-to-end encrypted message. The server only learns which
// option number each person picked, so it can count without knowing what the poll is about.
const pollViews = new Map(); // messageId -> redraw(state)
const pollStates = new Map();
export function onPollUpdate(st) {
  pollStates.set(st.messageId, st);
  const draw = pollViews.get(st.messageId);
  if (draw) draw(st);
}
export function pollEl(m) {
  const p = m.dec.p;
  const el = h('div', { class: 'poll' });
  const me = X.S.me.id;
  let st = pollStates.get(m.id) || { votes: {}, closed: false };
  let picked = new Set();
  const draw = (state) => {
    if (!el.isConnected && state !== st) { pollViews.delete(m.id); return; }
    st = state;
    const mine = new Set(Object.entries(st.votes).filter(([, ids]) => ids.includes(me)).map(([k]) => +k));
    picked = new Set(mine);
    const voters = new Set(Object.values(st.votes).flat());
    const total = voters.size;
    const counts = p.o.map((_, i) => (st.votes[i] || []).length);
    const top = Math.max(0, ...counts);
    const voted = mine.size > 0;
    const showResults = voted || st.closed || m.authorId === me;
    clear(el).append(
      h('div', { class: 'poll-head' }, h('span', { class: 'poll-tag' }, icon('check', 'ic'), st.closed ? 'Poll ended' : p.m ? 'Poll · pick any' : 'Poll'), h('strong', null, p.q || 'Poll')),
      ...p.o.map((label, i) => {
        const n = counts[i];
        const pct = total ? Math.round((n / total) * 100) : 0;
        return h('button', {
          class: `poll-opt${mine.has(i) ? ' mine' : ''}${showResults && n === top && n > 0 ? ' lead' : ''}`, disabled: st.closed,
          onclick: () => {
            const next = new Set(mine);
            if (p.m) { if (next.has(i)) next.delete(i); else next.add(i); } else if (next.has(i)) next.clear(); else { next.clear(); next.add(i); }
            api('POST', `/polls/${m.id}/vote`, { choices: [...next] }).then(onPollUpdate).catch((e) => toast(e.message, 'error'));
          },
        },
        showResults ? h('span', { class: 'poll-bar', style: { width: pct + '%' } }) : null,
        h('span', { class: 'poll-check' }, mine.has(i) ? '✔' : ''),
        h('span', { class: 'poll-label' }, label),
        showResults ? h('span', { class: 'poll-count', title: (st.votes[i] || []).map((id) => X.displayName(X.getUser(id))).join(', ') }, `${n} · ${pct}%`) : null);
      }),
      h('div', { class: 'poll-foot' }, `${total} ${total === 1 ? 'vote' : 'votes'}`, !showResults ? ' · vote to see results' : '',
        m.authorId === me && !st.closed ? h('button', { class: 'link-btn', onclick: async () => {
          if (await confirmDialog({ title: 'End this poll?', text: 'Nobody can vote after this. Results stay visible.', confirm: 'End poll' })) api('POST', `/polls/${m.id}/close`).then(onPollUpdate).catch((e) => toast(e.message, 'error'));
        } }, 'End poll') : null));
  };
  pollViews.set(m.id, draw);
  draw(st);
  if (!pollStates.has(m.id)) api('GET', `/polls/${m.id}`).then(onPollUpdate).catch(() => {});
  return el;
}
export function openPollCreator(onSend) {
  const q = h('input', { class: 'input', maxlength: '300', placeholder: 'What should we play tonight?' });
  const list = h('div', { class: 'stack' });
  const multi = h('input', { type: 'checkbox' });
  const opts = ['', ''];
  const draw = () => {
    clear(list).append(...opts.map((v, i) => h('div', { class: 'row gap' },
      h('input', { class: 'input', maxlength: '100', placeholder: `Option ${i + 1}`, value: v, oninput: (e) => { opts[i] = e.target.value; } }),
      opts.length > 2 ? h('button', { class: 'icon-btn sm', 'aria-label': 'Remove option', onclick: () => { opts.splice(i, 1); draw(); } }, icon('close')) : null)));
    if (opts.length < 10) list.append(h('button', { class: 'btn ghost sm', onclick: () => { opts.push(''); draw(); list.querySelectorAll('input')[opts.length - 1]?.focus(); } }, '+ Add option'));
  };
  draw();
  modal({
    title: 'Create a poll', size: 'sm',
    body: h('div', { class: 'stack' }, field('Question', q), h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Options'), list),
      h('label', { class: 'row gap' }, multi, 'People can pick more than one'),
      h('p', { class: 'field-hint' }, 'The question and options are end-to-end encrypted like any message.')),
    actions: [{ label: 'Cancel' }, { label: 'Send poll', kind: 'primary', action: () => {
      const o = opts.map((x) => x.trim()).filter(Boolean);
      if (!q.value.trim()) throw new Error('Write a question.');
      if (o.length < 2) throw new Error('Add at least two options.');
      onSend({ q: q.value.trim(), o, m: multi.checked });
    } }],
  });
}

// ======================================================================= voice messages
const VOICE_MAX = 5 * 60; // seconds
const pickMime = () => ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
// A mic button for the message box. While recording, the box shows a timer with cancel / send.
export function voiceButton(getComposer, onSend) {
  const btn = h('button', { class: 'icon-btn', 'aria-label': 'Record a voice message', 'data-tip': 'Voice message', onclick: () => start() }, icon('mic'));
  async function start() {
    const composerEl = typeof getComposer === 'function' ? getComposer() : getComposer;
    if (!window.MediaRecorder) return toast('This browser can’t record audio.', 'error');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) {
      return toast(e.name === 'NotAllowedError' ? 'Allow microphone access to record a voice message.' : 'No microphone found.', 'error');
    }
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    const t0 = Date.now();
    let cancelled = false;
    const time = h('span', { class: 'rec-time' }, '0:00');
    // A live level meter, so people can see it's hearing them.
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(an);
    const level = h('span', { class: 'rec-level' }, h('i'));
    const data = new Uint8Array(an.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      an.getByteTimeDomainData(data);
      let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      level.firstChild.style.transform = `scaleX(${Math.min(1, peak / 60)})`;
      const s = Math.floor((Date.now() - t0) / 1000);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s >= VOICE_MAX) stop(true);
      raf = requestAnimationFrame(tick);
    };
    const bar = h('div', { class: 'rec-bar', role: 'status', 'aria-label': 'Recording a voice message' },
      h('button', { class: 'icon-btn', 'aria-label': 'Cancel recording', 'data-tip': 'Cancel', onclick: () => stop(false) }, icon('trash')),
      h('span', { class: 'rec-dot' }), h('span', null, 'Recording'), time, level,
      h('button', { class: 'btn primary sm', onclick: () => stop(true) }, icon('send'), 'Send'));
    function stop(send) {
      if (rec.state === 'inactive') return;
      cancelled = !send;
      cancelAnimationFrame(raf);
      rec.stop();
    }
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      bar.remove(); composerEl.classList.remove('recording');
      const dur = Math.round((Date.now() - t0) / 1000);
      if (cancelled || dur < 1 || !parts.length) return;
      const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      onSend(new File(parts, `Voice message.${ext}`, { type }), dur);
    };
    composerEl.classList.add('recording');
    composerEl.append(bar);
    rec.start(250);
    tick();
  }
  return btn;
}
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// A voice message in the chat: play button, progress and length. The file decrypts when played.
export function voiceEl(f, getUrl) {
  const audio = new Audio();
  audio.preload = 'none';
  const bar = h('span', { class: 'vm-bar' }, h('i'));
  const time = h('span', { class: 'vm-time' }, fmtDur(f.dur || 0));
  const btn = h('button', { class: 'vm-play', 'aria-label': 'Play voice message' }, '▶');
  let loaded = false;
  const sync = () => {
    btn.textContent = audio.paused ? '▶' : '❚❚';
    const d = Number.isFinite(audio.duration) ? audio.duration : f.dur || 1;
    bar.firstChild.style.width = `${Math.min(100, (audio.currentTime / d) * 100)}%`;
    time.textContent = audio.paused && !audio.currentTime ? fmtDur(f.dur || 0) : fmtDur(audio.currentTime);
  };
  btn.addEventListener('click', async () => {
    if (!loaded) {
      btn.disabled = true;
      try { audio.src = await getUrl(); loaded = true; } catch { toast('Couldn’t load that voice message.', 'error'); return; } finally { btn.disabled = false; }
    }
    document.querySelectorAll('.vm audio').forEach(() => {});
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  });
  bar.addEventListener('click', (e) => {
    if (!loaded || !Number.isFinite(audio.duration)) return;
    const r = bar.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
  });
  ['play', 'pause', 'timeupdate', 'ended'].forEach((ev) => audio.addEventListener(ev, sync));
  const speed = h('button', { class: 'vm-speed', 'aria-label': 'Playback speed', onclick: () => { audio.playbackRate = audio.playbackRate >= 2 ? 1 : audio.playbackRate + 0.5; speed.textContent = `${audio.playbackRate}×`; } }, '1×');
  return h('div', { class: 'vm' }, btn, h('span', { class: 'vm-ic' }, icon('mic', 'ic')), bar, time, speed);
}

// ======================================================================= server events
const RSVP = [['going', 'Going'], ['maybe', 'Maybe'], ['no', 'Can’t go']];
const eventCache = new Map(); // serverId -> events
export function eventsFor(serverId) { return eventCache.get(serverId) || []; }
export async function loadEvents(serverId) {
  try { eventCache.set(serverId, await api('GET', `/servers/${serverId}/events`)); } catch { eventCache.set(serverId, []); }
  return eventsFor(serverId);
}
const when = (e) => {
  const d = new Date(e.startsAt);
  const day = fmtDay(e.startsAt);
  return `${day} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};
const relative = (ts) => {
  const m = Math.round((ts - Date.now()) / 60000);
  if (m <= 0) return 'happening now';
  if (m < 60) return `in ${m} min`;
  if (m < 48 * 60) return `in ${Math.round(m / 60)} h`;
  return `in ${Math.round(m / 1440)} days`;
};
// Download an .ics file so it can go in any calendar app.
function icsFor(e, serverName) {
  const z = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hearth//Events//EN', 'BEGIN:VEVENT', `UID:${e.id}@hearth`, `DTSTAMP:${z(Date.now())}`, `DTSTART:${z(e.startsAt)}`, `DTEND:${z(e.endsAt || e.startsAt + 3600000)}`,
    `SUMMARY:${esc(e.title)}`, `DESCRIPTION:${esc(e.description)}`, `LOCATION:${esc(e.location || serverName)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
  h('a', { href: url, download: `${e.title.replace(/[^\w -]+/g, '').slice(0, 40) || 'event'}.ics` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export function eventCard(e, server, { onChange } = {}) {
  const avatars = h('div', { class: 'ev-people' }, e.going.slice(0, 8).map((id) => X.avatarEl(X.getUser(id), 24)), e.going.length > 8 ? h('span', null, `+${e.going.length - 8}`) : null);
  const canEdit = e.createdBy === X.S.me.id || X.canManage(server);
  const channel = e.channelId && (server.channels || []).find((c) => c.id === e.channelId);
  return h('div', { class: 'ev-card' },
    h('div', { class: 'ev-date' }, h('span', null, new Date(e.startsAt).toLocaleDateString(undefined, { month: 'short' })), h('strong', null, String(new Date(e.startsAt).getDate()))),
    h('div', { class: 'ev-body' },
      h('div', { class: 'ev-when' }, when(e), h('span', { class: 'ev-rel' }, relative(e.startsAt))),
      h('strong', { class: 'ev-title' }, e.title),
      e.location || channel ? h('span', { class: 'ev-where' }, channel ? `${channel.type === 'voice' ? '🔊' : '#'} ${channel.name}` : '', channel && e.location ? ' · ' : '', e.location || '') : null,
      e.description ? h('p', { class: 'ev-desc' }, e.description) : null,
      h('div', { class: 'ev-foot' },
        avatars, h('span', { class: 'ev-count' }, `${e.going.length} going${e.maybe.length ? ` · ${e.maybe.length} maybe` : ''}`),
        h('div', { class: 'chips' }, RSVP.map(([k, l]) => h('button', {
          class: `chip${e.mine === k ? ' active' : ''}`,
          onclick: () => api('POST', `/events/${e.id}/rsvp`, { status: e.mine === k ? null : k }).then(() => onChange && onChange()).catch((x) => toast(x.message, 'error')),
        }, l))),
        h('button', { class: 'icon-btn sm', 'aria-label': 'More', 'data-pop-anchor': '', onclick: (ev) => menu(ev.currentTarget, [
          { label: 'Add to my calendar', icon: 'download', action: () => icsFor(e, server.name) },
          channel ? { label: channel.type === 'voice' ? 'Join the voice channel' : 'Open the channel', icon: 'hash', action: () => X.openChannelOrVoice(channel, server) } : null,
          canEdit ? { label: 'Edit', icon: 'edit', action: () => openEventEditor(server, e, onChange) } : null,
          canEdit ? { label: 'Delete', icon: 'trash', danger: true, action: async () => { if (await confirmDialog({ title: `Delete ${e.title}?`, confirm: 'Delete', danger: true })) api('DELETE', `/events/${e.id}`).then(() => onChange && onChange()).catch((x) => toast(x.message, 'error')); } } : null,
        ]) }, icon('more')))));
}
export function openEvents(server) {
  const list = h('div', { class: 'ev-list' }, h('div', { class: 'panel-loading' }, h('span', { class: 'spinner' })));
  const draw = async () => {
    const evs = await loadEvents(server.id);
    clear(list);
    if (!evs.length) list.append(h('div', { class: 'panel-empty' }, icon('book'), h('p', null, 'Nothing planned yet. Start something: a game night, a watch party, a study session.')));
    evs.forEach((e) => list.append(eventCard(e, server, { onChange: draw })));
  };
  const m = modal({
    title: `Events in ${server.name}`, size: 'md', className: 'events-modal',
    body: h('div', { class: 'stack' },
      h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: () => openEventEditor(server, null, draw) }, icon('plus'), 'Plan an event'),
        h('span', { class: 'field-hint' }, 'Everyone going gets a reminder 15 minutes before. Events aren’t end-to-end encrypted.')),
      list),
  });
  eventsModal = { serverId: server.id, draw, m };
  draw();
}
let eventsModal = null;
export function onEventsUpdate({ serverId }) {
  loadEvents(serverId).then(() => {
    if (eventsModal && eventsModal.serverId === serverId && eventsModal.m.box.isConnected) eventsModal.draw();
    X.onEventsChanged(serverId);
  });
}
function openEventEditor(server, e, onDone) {
  const pad = (n) => String(n).padStart(2, '0');
  const local = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const start0 = e ? e.startsAt : (() => { const d = new Date(Date.now() + 86400000); d.setHours(20, 0, 0, 0); return d.getTime(); })();
  const title = h('input', { class: 'input', maxlength: '100', value: e ? e.title : '', placeholder: 'Game night' });
  const starts = h('input', { class: 'input', type: 'datetime-local', value: local(start0) });
  const hours = h('input', { class: 'input', type: 'number', min: '0', max: '48', step: '0.5', value: e && e.endsAt ? String((e.endsAt - e.startsAt) / 3600000) : '2' });
  const chans = (server.channels || []).filter((c) => c.type === 'voice' || c.type === 'text');
  const chan = h('select', { class: 'input' }, h('option', { value: '' }, 'No channel'), chans.map((c) => h('option', { value: c.id }, `${c.type === 'voice' ? '🔊' : '#'} ${c.name}`)));
  chan.value = e && e.channelId ? e.channelId : (chans.find((c) => c.type === 'voice') || {}).id || '';
  const where = h('input', { class: 'input', maxlength: '120', value: e ? e.location : '', placeholder: 'Optional: somewhere else, a link…' });
  const desc = h('textarea', { class: 'input', rows: '3', maxlength: '2000', placeholder: 'What’s happening? What to bring?' });
  desc.value = e ? e.description : '';
  modal({
    title: e ? 'Edit event' : 'Plan an event', size: 'sm',
    body: h('div', { class: 'stack' }, field('Name', title), h('div', { class: 'grid-2' }, field('Starts', starts), field('Lasts (hours)', hours)), field('Where', chan), field('Place or link', where), field('Details', desc)),
    actions: [{ label: 'Cancel' }, { label: e ? 'Save' : 'Create event', kind: 'primary', action: async () => {
      const startsAt = new Date(starts.value).getTime();
      const len = Math.max(0, +hours.value || 0);
      const body = { title: title.value, startsAt, endsAt: len ? startsAt + len * 3600000 : null, channelId: chan.value || null, location: where.value, description: desc.value };
      await api(e ? 'PATCH' : 'POST', e ? `/events/${e.id}` : `/servers/${server.id}/events`, body);
      toast(e ? 'Event updated.' : 'Event created. Everyone in the server can see it.');
      if (onDone) onDone();
    } }],
  });
}
// Home screen: what's coming up in all your servers.
export async function upcomingSection() {
  let evs = [];
  try { evs = await api('GET', '/events'); } catch { return null; }
  if (!evs.length) return null;
  const sec = h('section', { class: 'home-sec' }, h('div', { class: 'home-sec-head' }, h('h3', null, 'Coming up')));
  const refresh = async () => { const fresh = await upcomingSection(); if (fresh) sec.replaceWith(fresh); else sec.remove(); };
  evs.slice(0, 5).forEach((e) => { const s = X.S.servers.find((x) => x.id === e.serverId); if (s) sec.append(h('div', { class: 'ev-home' }, h('span', { class: 'ev-home-server' }, s.name), eventCard(e, s, { onChange: refresh }))); });
  return sec;
}
export function onEventStarting(e) {
  const s = X.S.servers.find((x) => x.id === e.serverId);
  X.playSound('mention');
  X.notify({ title: `Starting soon: ${e.title}`, body: s ? s.name : '' });
  const t = h('div', { class: 'update-bar ev-toast', role: 'status' }, icon('bell'), h('span', null, `${e.title} starts ${relative(e.startsAt)}`),
    e.channelId && s ? h('button', { class: 'btn primary sm', onclick: () => { const c = s.channels.find((x) => x.id === e.channelId); if (c) X.openChannelOrVoice(c, s); t.remove(); } }, 'Go there') : null,
    h('button', { class: 'icon-btn sm', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('close')));
  document.body.append(t);
  setTimeout(() => t.remove(), 5 * 60000);
}

// ======================================================================= reminders ("remind me about this")
// Kept on this device. When the time comes: a sound, a notification and an entry in your inbox.
const RKEY = () => `hearth.reminders.${X.S.me.id}`;
const getR = () => { try { return JSON.parse(localStorage.getItem(RKEY()) || '[]'); } catch { return []; } };
const setR = (v) => { try { localStorage.setItem(RKEY(), JSON.stringify(v.slice(0, 200))); } catch { /* full */ } };
export function remindItems(m, key, preview) {
  const at = (ms) => () => { setR([...getR(), { at: Date.now() + ms, key, msgId: m.id, text: preview.slice(0, 140), authorId: m.authorId }]); toast(`Okay — I’ll remind you ${relative(Date.now() + ms).replace('in ', 'in ')}.`); };
  const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime() - Date.now(); };
  const tonight = () => { const d = new Date(); d.setHours(20, 0, 0, 0); return d.getTime() - Date.now(); };
  return [
    { label: 'Remind me in 20 minutes', icon: 'bell', action: at(20 * 60000) },
    { label: 'Remind me in 1 hour', icon: 'bell', action: at(3600000) },
    tonight() > 30 * 60000 ? { label: 'Remind me tonight (8 pm)', icon: 'bell', action: at(tonight()) } : null,
    { label: 'Remind me tomorrow (9 am)', icon: 'bell', action: at(tomorrow9()) },
  ];
}
export function startReminders() {
  const check = () => {
    if (!X.S.me) return;
    const all = getR();
    const due = all.filter((r) => r.at <= Date.now());
    if (!due.length) return;
    setR(all.filter((r) => r.at > Date.now()));
    due.forEach((r) => {
      const who = X.displayName(X.getUser(r.authorId));
      X.playSound('mention');
      X.notify({ title: 'Reminder', body: `${who}: ${r.text}` });
      X.addInbox({ type: 'reminder', userId: r.authorId, msgId: r.msgId, title: `Reminder: message from ${who}`, text: r.text });
      const t = h('div', { class: 'update-bar ev-toast', role: 'status' }, icon('bell'), h('span', null, `Reminder: ${who} — “${r.text.slice(0, 60)}”`),
        h('button', { class: 'btn primary sm', onclick: () => { X.jump(r.key, r.msgId); t.remove(); } }, 'Show'),
        h('button', { class: 'icon-btn sm', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('close')));
      document.body.append(t);
    });
  };
  check();
  setInterval(check, 20000);
}
export { fmtStamp, fmtTime };
