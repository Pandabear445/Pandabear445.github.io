// Watch together: one shared video per call, kept in step for everyone.
// The server holds the truth (what's playing, the position at a moment in time, playing or paused);
// each player follows it, and reports what its viewer does (play, pause, seek) back to the server.
// YouTube and Vimeo are controlled through their embed's message API, so no outside script is loaded.
import { h, clear, icon, toast } from './util.js';

const DRIFT = 1.6; // seconds out of step before we correct

// What the shared position is right now, on this computer's clock.
export function expectedPosition(st, offset) {
  if (!st) return 0;
  const now = Date.now() + offset;
  return st.position + (st.playing ? ((now - st.updatedAt) / 1000) * st.rate : 0);
}

// ---- a small adapter per kind of player: load, play, pause, seek, rate, and "what time is it"
function youtubeAdapter(item, onEvent) {
  let t = 0; let state = -1; let ready = false;
  const src = `https://www.youtube-nocookie.com/embed/${item.src}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1&controls=1&origin=${encodeURIComponent(location.origin)}`;
  const frame = h('iframe', { class: 'wt-frame', src, allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true, title: item.title || 'YouTube video', referrerpolicy: 'strict-origin-when-cross-origin' });
  const send = (func, args = []) => frame.contentWindow && frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
  const onMsg = (e) => {
    if (e.source !== frame.contentWindow) return;
    let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!d || !d.event) return;
    if (d.event === 'onReady' || d.event === 'initialDelivery') { if (!ready) { ready = true; onEvent('ready'); } }
    const info = d.info || {};
    if (typeof info.currentTime === 'number') t = info.currentTime;
    const ps = d.event === 'onStateChange' ? d.info : info.playerState;
    if (typeof ps === 'number' && ps !== state) {
      state = ps;
      if (ps === 1) onEvent('play', t); else if (ps === 2) onEvent('pause', t); else if (ps === 0) onEvent('ended', t);
    }
  };
  window.addEventListener('message', onMsg);
  frame.addEventListener('load', () => {
    // Ask the player to report its state, and to tell us about play/pause.
    frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'hearth', channel: 'widget' }), '*');
    send('addEventListener', ['onStateChange']);
    setTimeout(() => { if (!ready) { ready = true; onEvent('ready'); } }, 1500);
  });
  return {
    el: frame, live: false,
    play: () => send('playVideo'), pause: () => send('pauseVideo'),
    seek: (s) => { t = s; send('seekTo', [s, true]); }, rate: (r) => send('setPlaybackRate', [r]),
    time: () => t, playing: () => state === 1 || state === 3,
    destroy: () => window.removeEventListener('message', onMsg),
  };
}
function vimeoAdapter(item, onEvent) {
  let t = 0; let playing = false;
  const frame = h('iframe', { class: 'wt-frame', src: `https://player.vimeo.com/video/${item.src}?api=1&dnt=1&autopause=0`, allow: 'autoplay; fullscreen; picture-in-picture', allowfullscreen: true, title: item.title || 'Vimeo video' });
  const send = (method, value) => frame.contentWindow && frame.contentWindow.postMessage(JSON.stringify(value === undefined ? { method } : { method, value }), 'https://player.vimeo.com');
  const onMsg = (e) => {
    if (e.source !== frame.contentWindow) return;
    let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!d) return;
    if (d.event === 'ready') { ['play', 'pause', 'seeked', 'timeupdate', 'ended'].forEach((ev) => send('addEventListener', ev)); onEvent('ready'); }
    if (d.data && typeof d.data.seconds === 'number') t = d.data.seconds;
    if (d.event === 'play') { playing = true; onEvent('play', t); }
    if (d.event === 'pause') { playing = false; onEvent('pause', t); }
    if (d.event === 'seeked') onEvent('seek', t);
    if (d.event === 'ended') { playing = false; onEvent('ended', t); }
  };
  window.addEventListener('message', onMsg);
  return {
    el: frame, live: false,
    play: () => send('play'), pause: () => send('pause'), seek: (s) => { t = s; send('setCurrentTime', s); }, rate: (r) => send('setPlaybackRate', r),
    time: () => t, playing: () => playing, destroy: () => window.removeEventListener('message', onMsg),
  };
}
function twitchAdapter(item) {
  const frame = h('iframe', { class: 'wt-frame', src: `https://player.twitch.tv/?channel=${encodeURIComponent(item.src)}&parent=${encodeURIComponent(location.hostname)}&muted=false&autoplay=true`, allow: 'autoplay; fullscreen', allowfullscreen: true, title: item.title || 'Twitch stream' });
  // Live: everyone already sees the same moment, so there's nothing to keep in step.
  return { el: frame, live: true, play() {}, pause() {}, seek() {}, rate() {}, time: () => 0, playing: () => true, destroy() {} };
}
function videoAdapter(item, onEvent) {
  const v = h('video', { class: 'wt-frame', src: item.src, controls: true, playsinline: true, preload: 'auto' });
  v.addEventListener('loadedmetadata', () => onEvent('ready'));
  v.addEventListener('play', () => onEvent('play', v.currentTime));
  v.addEventListener('pause', () => { if (!v.ended) onEvent('pause', v.currentTime); });
  v.addEventListener('seeked', () => onEvent('seek', v.currentTime));
  v.addEventListener('ratechange', () => onEvent('rate', v.playbackRate));
  v.addEventListener('ended', () => onEvent('ended', v.currentTime));
  v.addEventListener('error', () => onEvent('error'));
  return {
    el: v, live: false,
    play: () => v.play().catch(() => onEvent('blocked')), pause: () => v.pause(), seek: (s) => { v.currentTime = s; }, rate: (r) => { v.playbackRate = r; },
    time: () => v.currentTime, playing: () => !v.paused, destroy: () => { v.pause(); v.removeAttribute('src'); v.load(); },
  };
}
const ADAPTERS = { youtube: youtubeAdapter, vimeo: vimeoAdapter, twitch: twitchAdapter, video: videoAdapter };
const KIND_LABEL = { youtube: 'YouTube', vimeo: 'Vimeo', twitch: 'Twitch', video: 'Video' };

// One player per call room. It stays alive while the call screen redraws around it.
const players = new Map();
export function watchPlayer(room, ctx) {
  let p = players.get(room);
  if (!p) { p = createPlayer(room, ctx); players.set(room, p); }
  p.ctx = ctx;
  return p;
}
export function dropWatchPlayer(room) {
  const p = players.get(room);
  if (p) { p.destroy(); players.delete(room); }
}

function createPlayer(room, initialCtx) {
  const self = { ctx: initialCtx, state: null, offset: 0 };
  const el = h('div', { class: 'wt', hidden: true });
  const bar = h('div', { class: 'wt-bar' });
  const stage = h('div', { class: 'wt-stage' });
  const queueEl = h('div', { class: 'wt-queue' });
  el.append(stage, bar, queueEl);
  let adapter = null; let itemId = null;
  let quietUntil = 0; // ignore our own player's events for a moment after we move it
  let timer = null;
  const quiet = (ms = 1200) => { quietUntil = Date.now() + ms; };
  const emit = (ev, data) => self.ctx.socket.emit(ev, { ...data, itemId }, (r) => { if (r && r.error) { toast(r.error, 'error'); follow(true); } });
  const canControl = () => {
    const st = self.state;
    return !!st && (!st.hostOnly || st.by === self.ctx.me.id || self.ctx.isStaff);
  };

  // The viewer did something in the player itself.
  const onEvent = (ev, value) => {
    if (ev === 'ready') { follow(true); return; }
    if (ev === 'blocked') { drawBar(true); return; }
    if (ev === 'error') { toast('That video couldn’t be played here.', 'error'); return; }
    if (ev === 'ended') { self.ctx.socket.emit('watch:next', { itemId }, () => {}); return; }
    if (Date.now() < quietUntil || !self.state || adapter.live) return;
    if (!canControl()) { follow(true); return; }
    if (ev === 'play' && !self.state.playing) emit('watch:control', { action: 'play', position: value });
    else if (ev === 'pause' && self.state.playing) emit('watch:control', { action: 'pause', position: value });
    else if (ev === 'seek' && Math.abs(value - expectedPosition(self.state, self.offset)) > DRIFT) emit('watch:control', { action: 'seek', position: value });
    else if (ev === 'rate' && value !== self.state.rate) emit('watch:control', { action: 'rate', rate: value });
  };

  // Move our player to where the shared state says it should be.
  function follow(force = false) {
    const st = self.state;
    if (!adapter || !st || adapter.live) return;
    const want = expectedPosition(st, self.offset);
    const off = Math.abs(adapter.time() - want);
    if (force || off > DRIFT) { quiet(); adapter.seek(want); }
    if (st.playing && (!adapter.playing() || force)) { quiet(); adapter.play(); }
    if (!st.playing && (adapter.playing() || force)) { quiet(); adapter.pause(); }
    if (force) adapter.rate(st.rate);
  }

  function drawBar(blocked = false) {
    const st = self.state;
    clear(bar);
    if (!st) return;
    const who = self.ctx.userName(st.item.addedBy);
    bar.append(
      h('div', { class: 'wt-title' }, h('span', { class: 'wt-kind' }, KIND_LABEL[st.item.kind] || 'Video'),
        h('strong', null, st.item.title || st.item.link), h('span', { class: 'wt-sub' }, `shared by ${who}${st.hostOnly ? ` · ${self.ctx.userName(st.by)} controls playback` : ' · anyone can control'}`)),
      h('div', { class: 'wt-actions' },
        blocked ? h('button', { class: 'btn primary sm', onclick: () => { adapter.play(); drawBar(); } }, icon('send'), 'Click to start playing') : null,
        h('button', { class: 'btn ghost sm', onclick: () => addDialog(true) }, '+ Queue'),
        st.queue.length && canControl() ? h('button', { class: 'btn ghost sm', onclick: () => self.ctx.socket.emit('watch:next', { itemId, skip: true }, (r) => r && r.error && toast(r.error, 'error')) }, 'Skip') : null,
        st.by === self.ctx.me.id || self.ctx.isStaff ? h('button', { class: `btn ghost sm${st.hostOnly ? ' active' : ''}`, onclick: () => self.ctx.socket.emit('watch:control', { action: 'hostOnly', value: !st.hostOnly }, () => {}) }, st.hostOnly ? 'Let everyone control' : 'Only I control') : null,
        h('a', { class: 'btn ghost sm', href: st.item.link, target: '_blank', rel: 'noopener noreferrer' }, icon('external')),
        canControl() ? h('button', { class: 'btn ghost sm danger-text', onclick: () => self.ctx.socket.emit('watch:stop', {}, (r) => r && r.error && toast(r.error, 'error')) }, 'Stop') : null));
    clear(queueEl);
    if (st.queue.length) {
      queueEl.append(h('div', { class: 'wt-qh' }, `Up next — ${st.queue.length}`),
        ...st.queue.map((q, i) => h('div', { class: 'wt-qi' }, h('span', { class: 'wt-qn' }, String(i + 1)), h('span', { class: 'wt-qt' }, q.title || q.link), h('span', { class: 'wt-sub' }, self.ctx.userName(q.addedBy)),
          q.addedBy === self.ctx.me.id || canControl() ? h('button', { class: 'icon-btn sm', 'aria-label': 'Remove from queue', onclick: () => self.ctx.socket.emit('watch:remove', { itemId: q.id }, () => {}) }, icon('close')) : null)));
    }
  }

  function addDialog(queue) { self.ctx.openStart(queue); }

  self.apply = (st) => {
    if (st) self.offset = st.serverNow - Date.now();
    self.state = st;
    el.hidden = !st;
    if (!st) {
      if (adapter) { adapter.destroy(); adapter = null; }
      itemId = null; clear(stage); clear(bar); clear(queueEl);
      clearInterval(timer); timer = null;
      return;
    }
    if (st.item.id !== itemId) {
      if (adapter) adapter.destroy();
      itemId = st.item.id;
      adapter = (ADAPTERS[st.item.kind] || videoAdapter)(st.item, onEvent);
      clear(stage).append(adapter.el);
      quiet(2500);
    } else follow();
    drawBar();
    if (!timer) timer = setInterval(() => follow(), 3000); // gentle drift correction
  };
  self.destroy = () => { if (adapter) adapter.destroy(); clearInterval(timer); el.remove(); };
  self.el = el;
  return self;
}
