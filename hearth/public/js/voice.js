// Voice & video: WebRTC peer-to-peer mesh, signaled over Socket.IO.
// Audio and video go directly between participants (DTLS-SRTP encrypted by the browser).
// Mesh works well for small rooms (voice up to ~8–10 people; video up to ~4–6).
//
// Every connection negotiates four lanes up front, always in this order:
//   0 microphone (audio) · 1 camera (video) · 2 screen (video) · 3 screen audio (audio)
// Turning the camera or a screen share on/off just plugs a track into its lane (replaceTrack), so no
// renegotiation is ever needed and two people toggling video at once can't collide.
//
// The call itself is a small state machine (see TRANSITIONS); `state` is the one place the UI reads from. The
// signaling connection can drop without ending the call: the media keeps flowing peer to peer while the app
// reconnects, and the server keeps our place for a short while (see docs/VOICE.md).
const LANE = { mic: 0, cam: 1, screen: 2, screenAudio: 3 };

// Which state may follow which. Anything else is a bug and is refused (and logged), never applied.
export const TRANSITIONS = {
  idle: ['joining'],
  joining: ['connecting', 'failed', 'leaving'],
  connecting: ['connected', 'degraded', 'reconnecting', 'switching', 'failed', 'leaving'],
  connected: ['connecting', 'degraded', 'reconnecting', 'switching', 'failed', 'leaving'],
  degraded: ['connected', 'connecting', 'reconnecting', 'switching', 'failed', 'leaving'],
  reconnecting: ['connecting', 'failed', 'leaving'],
  switching: ['connected', 'connecting', 'degraded', 'reconnecting', 'failed', 'leaving'],
  failed: ['leaving'],
  leaving: ['idle'],
};
// States where we're in the call and the media side decides between connecting / connected / degraded.
const LIVE = new Set(['connecting', 'connected', 'degraded', 'switching']);

// Rejoining after the server connection comes back: 0.5 s, 1 s, 2 s… up to 10 s apart, with jitter so a whole
// call doesn't knock on the server at the same instant after a restart. Gives up after this many tries.
export const REJOIN = { base: 500, max: 10000, tries: 8, deadline: 60000 };
// One connection that breaks: ICE restarts 1 s, 2 s, 4 s apart (plus jitter), then one fresh connection, then it's
// marked failed with a Retry button.
export const PEER_RECOVERY = { restarts: 2, base: 1000, max: 8000, check: 10000, firstCheck: 12000 };
// Someone the server no longer lists, but whose connection we still have (it restarted, say): kept this long.
export const UNLISTED_GRACE = 20000;
export const backoff = (n, { base, max }, rand = Math.random) => Math.round(Math.min(max, base * 2 ** n) * (0.7 + 0.6 * rand()));

const newPcId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const hasWindow = typeof window !== 'undefined';
const md = () => (typeof navigator !== 'undefined' && navigator.mediaDevices) || null;

export class Voice {
  constructor({ socket, getIceServers, ensureIce, onChange, onSpeaking, signSdp, verifySdp, onSecurityWarning, isPeerMuted, onNotice, onRegion, myId }) {
    this.socket = socket;
    this.isPeerMuted = isPeerMuted;
    // Offers/answers are signed with the sender's signing key and checked before use. The DTLS
    // fingerprint inside the SDP is what pins the encrypted audio connection, so a server that
    // swapped it to listen in would be caught here.
    this.signSdp = signSdp;
    this.verifySdp = verifySdp;
    this.onSecurityWarning = onSecurityWarning || (() => {});
    this.getIceServers = getIceServers;
    this.ensureIce = ensureIce; // fetches new relay logins first when the ones we have are about to run out
    this.onChange = onChange || (() => {});
    this.onSpeaking = onSpeaking || (() => {});
    this.onNotice = onNotice || (() => {}); // something the person should be told (a device went away, say)
    this.onRegion = onRegion || (() => {}); // the server's current region for the call we joined
    this.myId = myId || (() => null);
    this.channelId = null;
    this.peers = new Map(); // socketId -> { pc, pcId, remotePc, userId, socketId, initiator, audio, pending: [], … }
    this.localStream = null;
    this.muted = localStorage.getItem('hearth.muted') === '1';
    // Push-to-talk (Settings → Voice & video → Input mode): the mic only sends while the key is held.
    this.pttHeld = false;
    this.pttTimer = null;
    this.deafened = localStorage.getItem('hearth.deafened') === '1';
    this.volumes = JSON.parse(localStorage.getItem('hearth.volumes') || '{}');
    this.speaking = new Map();
    this.meters = new Map();
    this.audioCtx = null;
    this.connecting = false;
    this.camStream = null;
    this.screenStream = null;

    this.state = 'idle';
    this.stateSince = Date.now();
    this.failReason = '';
    // Every join, rejoin and leave gets a new number. Anything that finishes after a newer one started (an answer
    // from the server that took too long, a retry timer) sees the number changed and does nothing, so an old
    // attempt can never bring an old call back.
    this.attempt = 0;
    this.joinPromise = null;
    this.history = []; // what happened to the call: [{ t, event, userId? }] (never addresses or device ids)
    this.listed = new Set(); // who the server says is in the call (app.js passes it in)
    this.relayFallback = false; // the call's region relay didn't answer: this call uses automatic relays
    this.lastSwitchMs = null;
    this.listeners = [];

    // Signals from one person are handled one at a time, in the order they were sent: a network candidate that
    // arrives while their offer is still being checked waits for it instead of being lost.
    this.signalChains = new Map(); // socketId -> promise of the last signal handled
    this.early = new Map(); // socketId -> candidates that came before the connection they belong to
    socket.on('voice:signal', (p) => this.queueSignal(p));
    socket.on('voice:peer-left', ({ socketId } = {}) => this.closePeer(socketId, 'left the call'));
    socket.on('voice:peer-joined', (p) => this.onPeerJoined(p || {}));
    socket.on('voice:kicked', () => { if (this.channelId) { this.log('Removed from the call by the server'); this.cleanup(); } });
    // Someone changed what this person may do in the channel: without Speak, the mic goes off and stays off.
    socket.on('voice:perms', ({ channelId, canSpeak } = {}) => {
      if (!this.channelId || channelId !== this.channelId) return;
      this.canSpeak = canSpeak !== false;
      this.speakLocked = canSpeak === false || this.noMic;
      if (this.speakLocked && !this.muted) { this.muted = true; this.applyLocalTrackState(); this.sendState(); }
      this.onChange();
    });
    socket.on('disconnect', () => this.onSocketDown());
    socket.on('connect', () => this.onSocketUp());
  }

  get inVoice() { return !!this.channelId; }

  // ---- the state machine
  setState(next, reason = '') {
    if (next === this.state) return true;
    if (!(TRANSITIONS[this.state] || []).includes(next)) {
      console.warn(`voice: refused ${this.state} → ${next}`);
      return false;
    }
    this.state = next;
    this.stateSince = Date.now();
    if (next === 'failed') this.failReason = reason;
    this.log(`State: ${next}${reason ? ` (${reason})` : ''}`);
    this.onChange();
    return true;
  }
  log(event, peer = null) {
    this.history.push({ t: Date.now(), event, userId: peer ? peer.userId : undefined });
    if (this.history.length > 80) this.history.splice(0, this.history.length - 80);
    if (peer) { (peer.events ||= []).push({ t: Date.now(), event }); if (peer.events.length > 30) peer.events.shift(); }
  }
  // Works out connecting / connected / degraded from the actual connections. "Connected" only ever means every
  // connection's media transport is up (or there's nobody else in the call).
  recompute() {
    if (!LIVE.has(this.state) || this.swapping) return;
    const peers = [...this.peers.values()];
    const up = (p) => p.pc.connectionState === 'connected';
    if (this.state === 'switching') {
      if (peers.every(up)) {
        this.lastSwitchMs = Date.now() - this.switchStarted;
        this.log(`Region switch finished in ${this.lastSwitchMs} ms`);
      } else if (Date.now() < this.switchUntil) return;
    }
    let next = 'connected';
    if (peers.some((p) => p.failed || ['failed', 'disconnected'].includes(p.pc.connectionState))) next = 'degraded';
    else if (!peers.every(up)) next = 'connecting';
    this.setState(next);
  }
  // What the call bar shows: one honest line, plus a longer explanation.
  status() {
    const peers = [...this.peers.values()];
    const up = peers.filter((p) => p.pc.connectionState === 'connected').length;
    const failed = peers.filter((p) => p.failed).length;
    const plural = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
    switch (this.state) {
      case 'joining': return { state: this.state, tone: 'wait', label: 'Joining\u2026', detail: 'Asking the server to let you in.' };
      case 'connecting': return { state: this.state, tone: 'wait', label: 'Connecting\u2026', detail: `Setting up audio with ${plural(peers.length - up)}.` };
      case 'connected': return { state: this.state, tone: 'ok', label: 'Connected', detail: peers.length ? `Audio is flowing with ${plural(up)}.` : 'You\u2019re the only one here.' };
      case 'degraded': return { state: this.state, tone: 'warn', label: failed ? 'Connection trouble' : 'Reconnecting audio\u2026', detail: failed ? `Can\u2019t reach ${plural(failed)}. Try again from their tile.` : 'A connection dropped. Trying to restore it.' };
      case 'reconnecting': return { state: this.state, tone: 'warn', label: 'Reconnecting\u2026', detail: up ? 'Lost the server. Audio may still be getting through while Hearth reconnects.' : 'Lost the connection. Trying again\u2026' };
      case 'switching': return { state: this.state, tone: 'wait', label: 'Switching region\u2026', detail: 'Moving the call to the new relay. A short blip is normal.' };
      case 'failed': return { state: this.state, tone: 'bad', label: 'Disconnected', detail: this.failReason || 'The call couldn\u2019t be restored.' };
      case 'leaving': return { state: this.state, tone: 'wait', label: 'Leaving\u2026', detail: '' };
      default: return { state: this.state, tone: 'idle', label: '', detail: '' };
    }
  }

  emit(event, payload, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ error: 'The server didn\u2019t answer. Check your connection.', timeout: true }), timeoutMs);
      this.socket.emit(event, payload, (res) => { clearTimeout(t); resolve(res || {}); });
    });
  }

  audioConstraints() {
    const prefs = JSON.parse(localStorage.getItem('hearth.audio') || '{}');
    return {
      deviceId: prefs.inputId ? { ideal: prefs.inputId } : undefined,
      echoCancellation: prefs.echoCancellation !== false,
      noiseSuppression: prefs.noiseSuppression !== false,
      autoGainControl: prefs.autoGainControl !== false,
    };
  }

  // One join at a time: asking again while one is in progress gets the same promise.
  join(channelId, opts = {}) {
    if (this.joinPromise) return this.joinPromise;
    if (this.channelId === channelId && this.state !== 'failed') return Promise.resolve();
    this.joinPromise = this.doJoin(channelId, opts).finally(() => { this.joinPromise = null; });
    return this.joinPromise;
  }
  async doJoin(channelId, { video = false } = {}) {
    if (!md() || !md().getUserMedia) {
      throw new Error('Voice needs a secure connection. Open this site over https:// (or on localhost).');
    }
    this.connecting = true;
    try {
      if (this.channelId) await this.leave();
      const a = ++this.attempt;
      this.setState('joining');
      this.wantVideo = video;
      // The raw mic stream is only analysed locally; peers get a clone, so the input-sensitivity gate
      // can silence what's sent while still hearing when you start talking again.
      let mic;
      try { mic = await this.openMic(); } catch (e) { if (a === this.attempt) this.cleanup(); throw e; }
      if (a !== this.attempt) { mic.raw.getTracks().forEach((t) => t.stop()); return; } // left meanwhile
      this.useMic(mic);
      const iceReady = this.ensureIce ? Promise.resolve(this.ensureIce()).catch(() => {}) : null;
      this.gateOpen = true;
      this.applyLocalTrackState();
      this.channelId = channelId;
      const res = await this.emit('voice:join', { channelId, muted: this.muted, deafened: this.deafened, video });
      if (a !== this.attempt) return; // left (or started over) while waiting: that answer is stale
      if (res.error) { this.cleanup(); throw new Error(res.error); }
      if (res.regionVersion !== undefined) this.onRegion(channelId, res.region || null, res.regionVersion);
      // Listen-only channel for this person: keep the mic off until they move somewhere they can speak.
      this.canSpeak = res.canSpeak !== false;
      this.speakLocked = res.canSpeak === false || this.noMic;
      if (this.speakLocked) { this.muted = true; this.applyLocalTrackState(); this.emit('voice:update', { muted: true, deafened: this.deafened }); }
      this.watch('me', this.rawStream);
      this.setState('connecting');
      this.addListeners();
      await iceReady;
      if (a !== this.attempt) return;
      for (const p of res.peers || []) {
        if (a !== this.attempt) return;
        // One connection that can't be set up doesn't stop the others (its own recovery takes over).
        if (!this.peerByUser(p.userId)) await this.createPeer(p.socketId, p.userId, true).catch((e) => { if (a === this.attempt) console.warn('voice: peer setup', e); });
      }
      if (a !== this.attempt) return;
      if (video) await this.setCamera(true).catch(() => {});
      this.recompute();
      this.onChange();
    } finally {
      this.connecting = false;
    }
  }
  // The microphone, or a silent stand-in when there's none (or it's busy in another app): listen-only.
  async openMic({ preferDefault = false } = {}) {
    const audio = this.audioConstraints();
    if (preferDefault) delete audio.deviceId;
    try {
      return { raw: await md().getUserMedia({ audio, video: false }), noMic: false };
    } catch (e) {
      if (e.name === 'NotAllowedError') throw e; // they said no: tell them how to allow it
      return { raw: this.silentStream(), noMic: true };
    }
  }
  silentStream() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      return ctx.createMediaStreamDestination().stream;
    } catch { return new MediaStream([]); }
  }
  useMic({ raw, noMic }) {
    this.noMic = noMic;
    this.rawStream = raw;
    this.localStream = new MediaStream(raw.getAudioTracks().map((t) => t.clone()));
    // A mic that's unplugged (or whose permission is taken away) ends its track: find out what happened.
    const t = raw.getAudioTracks()[0];
    if (t && !noMic) t.onended = () => this.checkDevices('ended');
  }

  async leave() {
    if (!this.channelId && this.state === 'idle') return;
    this.attempt++;
    // (Sent even while offline: it goes out first thing when the connection is back, so the server doesn't
    // keep our place for the rest of the grace period.)
    const pending = this.channelId ? this.emit('voice:leave', { channelId: this.channelId }, 2500) : null;
    this.cleanup(); // the call UI goes away immediately, whatever the network does
    await pending;
  }

  // Ends everything: connections, tracks, timers and listeners. Safe to call from any state, more than once.
  cleanup() {
    this.attempt++;
    if (this.state !== 'idle' && this.state !== 'leaving') this.setState('leaving');
    this.speakLocked = false;
    this.releaseMedia();
    this.removeListeners();
    this.channelId = null;
    this.relayFallback = false;
    this.failReason = '';
    this.listed = new Set();
    if (this.state === 'leaving') this.setState('idle');
    this.onChange();
  }
  // Peers, tracks and timers (but not the call itself: a failed call keeps showing, with Retry).
  releaseMedia() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.early.clear();
    this.signalChains.clear();
    clearTimeout(this.rejoinTimer);
    clearTimeout(this.reconnectDeadline);
    clearTimeout(this.switchTimer);
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    if (this.rawStream) this.rawStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    this.localStream = null;
    this.rawStream = null;
    if (this.camStream) this.camStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    if (this.screenStream) this.screenStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    this.camStream = null;
    this.screenStream = null;
    this.unwatch('me');
  }
  // Gives up on the call (the server won't take us back, or it's been unreachable for too long). The microphone
  // is released; the call bar stays with the reason and a Retry button.
  // retriable: it was the network, so coming back online (or waking up) tries again by itself. A refusal from the
  // server waits for the Retry button instead.
  fail(reason, { retriable = true } = {}) {
    this.attempt++;
    this.failRetriable = retriable;
    if (!this.setState('failed', reason)) return;
    this.releaseMedia();
    this.onChange();
  }
  // Retry after a failure (or from the Retry button): a fresh join of the same call.
  retry() {
    const room = this.channelId;
    if (!room || this.state !== 'failed') return Promise.resolve();
    return this.join(room, { video: false });
  }

  // ---- reconnecting to the server
  onSocketDown() {
    if (!this.channelId) return;
    if (this.state === 'joining') return; // the join's own answer times out and reports it
    if (!LIVE.has(this.state)) return;
    this.setState('reconnecting', 'lost the server');
    this.rejoinTries = 0;
    clearTimeout(this.reconnectDeadline);
    const since = this.stateSince;
    this.reconnectDeadline = setTimeout(() => {
      if (this.state === 'reconnecting' && this.stateSince === since) this.fail('Couldn\u2019t reach the server for a minute.');
    }, REJOIN.deadline);
  }
  onSocketUp() {
    if (this.state === 'reconnecting') { this.rejoinTries = 0; this.rejoin(++this.attempt); }
  }
  // Back on the server: ask for our place again (the server resumes it within its grace period, or treats it as
  // a fresh join after a restart). Connections that kept working stay as they are; broken ones start over.
  async rejoin(a) {
    clearTimeout(this.rejoinTimer);
    if (a !== this.attempt || !this.socket.connected || this.state !== 'reconnecting') return;
    const res = await this.emit('voice:join', { channelId: this.channelId, resume: true, muted: this.muted, deafened: this.deafened, video: !!this.camStream, screen: !!this.screenStream });
    if (a !== this.attempt || this.state !== 'reconnecting') return;
    if (res.error) {
      // Our own timeout or "slow down": try again a little later. Anything else is the server saying no.
      if (!res.timeout && res.error !== 'Slow down.') return this.fail(res.error, { retriable: false });
      if (++this.rejoinTries >= REJOIN.tries) return this.fail('Couldn\u2019t rejoin the call.');
      const wait = backoff(this.rejoinTries - 1, REJOIN);
      this.log(`Rejoin didn\u2019t go through; trying again in ${wait} ms`);
      this.rejoinTimer = setTimeout(() => this.rejoin(a), wait);
      return;
    }
    clearTimeout(this.reconnectDeadline);
    this.log(res.resumed ? 'Rejoined: the server kept our place' : 'Rejoined as a new member (the server had forgotten the call)');
    if (res.regionVersion !== undefined) this.onRegion(this.channelId, res.region || null, res.regionVersion);
    this.canSpeak = res.canSpeak !== false;
    this.speakLocked = res.canSpeak === false || this.noMic;
    this.setState('connecting');
    const listed = new Map((res.peers || []).map((p) => [p.userId, p]));
    for (const peer of [...this.peers.values()]) {
      const p = listed.get(peer.userId);
      if (!p) {
        // The server kept our place, so its list is current: they left while we were away. After a restart they
        // may just not be back yet: their connection stays for a while (UNLISTED_GRACE).
        if (res.resumed) this.closePeer(peer.socketId, 'left while we were away');
        continue;
      }
      if (p.socketId !== peer.socketId) this.rekey(peer, p.socketId);
      // Still connected: nothing to do. Broken: start it over, unless they're away too (they'll start it).
      if (peer.pc.connectionState !== 'connected' && !p.reconnecting) await this.reconnectPeer(peer.socketId).catch(() => {});
      if (a !== this.attempt) return;
    }
    for (const p of res.peers || []) {
      if (a !== this.attempt) return;
      if (!this.peerByUser(p.userId) && !p.reconnecting) await this.createPeer(p.socketId, p.userId, true).catch(() => {});
    }
    this.recompute();
  }
  // Someone (re)joined. If we still have a connection to them from before, it now goes through their new socket.
  onPeerJoined({ userId, socketId }) {
    if (!this.channelId || !userId || !socketId) return;
    const peer = this.peerByUser(userId);
    if (peer && peer.socketId !== socketId) { this.rekey(peer, socketId); this.log('Back on a new connection', peer); }
  }
  peerByUser(userId) { for (const p of this.peers.values()) if (p.userId === userId) return p; return null; }
  rekey(peer, socketId) {
    if (this.peers.get(peer.socketId) === peer) this.peers.delete(peer.socketId);
    this.early.delete(peer.socketId);
    const other = this.peers.get(socketId);
    if (other && other !== peer) this.closePeer(socketId);
    peer.socketId = socketId;
    this.peers.set(socketId, peer);
  }

  // ---- what the server says about who's in the call (app.js passes in every voice:state for our room)
  setListed(userIds) {
    this.listed = new Set(userIds);
    const t = Date.now();
    for (const p of this.peers.values()) {
      if (this.listed.has(p.userId)) { p.everListed = true; p.unlistedSince = null; } else if (!p.unlistedSince) p.unlistedSince = t;
    }
  }
  // Connections to people the server doesn't list. Someone never listed at all is the one to worry about: an
  // extra listener the server added without telling anyone (see docs/VOICE.md, "Hidden listeners").
  unlistedPeers(minAgeMs = 3000) {
    const t = Date.now();
    return [...this.peers.values()].filter((p) => !p.closed && !this.listed.has(p.userId) && t - (p.unlistedSince || p.createdAt) >= minAgeMs)
      .map((p) => ({ userId: p.userId, neverListed: !p.everListed, connected: p.pc.connectionState === 'connected' }));
  }

  // Housekeeping every 2 seconds while in a call: notices a wake from sleep, drops people the server stopped
  // listing a while ago, and keeps the state honest.
  tick() {
    if (!this.channelId) return;
    const t = Date.now();
    const gap = t - (this.lastTick || t);
    this.lastTick = t;
    if (gap > 15000) { this.log(`Woke up after ${Math.round(gap / 1000)} s asleep`); this.healthCheck(); }
    if (this.socket.connected && LIVE.has(this.state)) {
      for (const p of [...this.peers.values()]) {
        if (p.unlistedSince && t - p.unlistedSince > UNLISTED_GRACE && this.listed.size) this.closePeer(p.socketId, 'no longer in the call');
      }
    }
    this.recompute();
    if (this.unlistedPeers().length) this.onChange(); // the warning about them appears after a few seconds
  }
  // Back from sleep, back online, or the tab is visible again: get the server connection back, and give broken
  // connections an immediate try instead of waiting out their back-off.
  healthCheck() {
    if (!this.channelId) return;
    if (this.state === 'failed') { if (this.failRetriable && this.socket.connected) this.retry().catch(() => {}); return; }
    if (!this.socket.connected) {
      // Socket.IO may be waiting out a long back-off from while the network was gone: try right now instead.
      try { this.socket.disconnect(); this.socket.connect(); } catch { /* it reconnects by itself */ }
      return;
    }
    for (const p of this.peers.values()) {
      if (['failed', 'disconnected'].includes(p.pc.connectionState) && !p.failed) { clearTimeout(p.watchdog); this.recover(p); }
    }
  }
  addListeners() {
    this.removeListeners();
    const on = (target, ev, fn) => { if (target && target.addEventListener) { target.addEventListener(ev, fn); this.listeners.push(() => target.removeEventListener(ev, fn)); } };
    on(md(), 'devicechange', () => this.checkDevices('devicechange'));
    if (hasWindow) {
      on(window, 'online', () => { this.log('Network is back'); this.healthCheck(); });
      on(window, 'offline', () => this.log('Network went away'));
    }
    if (typeof document !== 'undefined') on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') this.healthCheck(); });
    // Permission taken away (or given back) in the browser's site settings while in the call.
    if (typeof navigator !== 'undefined' && navigator.permissions && navigator.permissions.query) {
      for (const name of ['microphone', 'camera']) {
        navigator.permissions.query({ name }).then((st) => {
          if (!this.channelId) return;
          const fn = () => this.onPermission(name, st.state);
          st.addEventListener('change', fn);
          this.listeners.push(() => st.removeEventListener('change', fn));
        }).catch(() => { /* this browser can't tell us */ });
      }
    }
    this.lastTick = Date.now();
    this.tickTimer = setInterval(() => this.tick(), 2000);
    this.listeners.push(() => clearInterval(this.tickTimer));
  }
  removeListeners() { for (const off of this.listeners.splice(0)) { try { off(); } catch { /* gone */ } } }

  // ---- devices
  // A device came or went (or the mic's track ended). The mic in use is gone: switch to the default one, or to
  // listen-only if there's none. The camera in use is gone: video goes off. Each time, say why.
  async checkDevices(why) {
    if (!this.channelId || (!LIVE.has(this.state) && this.state !== 'reconnecting')) return;
    let devs = null;
    try { devs = await md().enumerateDevices(); } catch { return; }
    if (!this.channelId) return;
    const mic = this.rawStream && this.rawStream.getAudioTracks()[0];
    const ins = devs.filter((d) => d.kind === 'audioinput');
    if (!this.noMic && mic) {
      const id = mic.getSettings ? mic.getSettings().deviceId : undefined;
      const gone = mic.readyState === 'ended' || !ins.length || (id && !ins.some((d) => d.deviceId === id));
      if (gone) {
        this.log('The microphone in use went away');
        const ok = await this.swapMic({ preferDefault: true });
        if (ok === 'mic') this.onNotice('Your microphone was disconnected, so Hearth switched to the default one.');
        else if (ok === 'none') this.onNotice('Your microphone was disconnected and there\u2019s no other one, so you\u2019re listen-only for now.', 'error');
      }
    } else if (this.noMic && !this.micDenied && ins.some((d) => d.deviceId) && why === 'devicechange') {
      // A mic was plugged in while listen-only: use it, muted, so nothing is sent by surprise.
      this.muted = true;
      if (await this.swapMic({ preferDefault: true }) === 'mic') { this.persist(); this.onNotice('A microphone was connected. Unmute when you\u2019re ready to talk.'); }
    }
    const cam = this.camStream && this.camStream.getVideoTracks()[0];
    if (cam) {
      const cams = devs.filter((d) => d.kind === 'videoinput');
      const id = cam.getSettings ? cam.getSettings().deviceId : undefined;
      if (cam.readyState === 'ended' || !cams.length || (id && !cams.some((d) => d.deviceId === id))) {
        this.log('The camera in use went away');
        await this.setCamera(false).catch(() => {});
        this.onNotice('Your camera was disconnected, so your video is off.');
      }
    }
    const prefs = JSON.parse(localStorage.getItem('hearth.audio') || '{}');
    if (prefs.outputId && !devs.some((d) => d.kind === 'audiooutput' && d.deviceId === prefs.outputId)) this.setOutputDevice('');
  }
  // Swaps the microphone everyone hears without renegotiating (same lane, new track). 'mic' | 'none' | 'denied'.
  async swapMic({ preferDefault = false } = {}) {
    const a = this.attempt;
    let mic;
    try { mic = await this.openMic({ preferDefault }); } catch (e) {
      if (a !== this.attempt) return 'stale';
      this.micBlocked();
      return 'denied';
    }
    if (a !== this.attempt || !this.channelId) { mic.raw.getTracks().forEach((t) => t.stop()); return 'stale'; }
    const oldRaw = this.rawStream; const oldLocal = this.localStream;
    this.useMic(mic);
    this.micDenied = false;
    this.speakLocked = this.canSpeak === false || this.noMic;
    if (this.speakLocked) this.muted = true;
    this.applyLocalTrackState();
    for (const p of this.peers.values()) await this.fillLanes(p);
    this.watch('me', this.rawStream);
    if (oldLocal) oldLocal.getTracks().forEach((t) => t.stop());
    if (oldRaw) oldRaw.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    this.sendState();
    this.onChange();
    return mic.noMic ? 'none' : 'mic';
  }
  // Settings → input device changed during a call: everyone hears the new mic straight away.
  async setInputDevice() {
    if (!this.channelId || !LIVE.has(this.state)) return;
    const r = await this.swapMic();
    if (r === 'mic') this.log('Switched microphone');
    return r;
  }
  async setCameraDevice() {
    if (!this.channelId || !this.camStream) return;
    await this.setCamera(false);
    await this.setCamera(true);
  }
  setOutputDevice(id) {
    for (const p of this.peers.values()) for (const el of [p.audio, p.screenAudio]) if (el && el.setSinkId) el.setSinkId(id || '').catch(() => {});
  }
  micBlocked() {
    this.micDenied = true;
    if (this.rawStream) this.rawStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    this.useMic({ raw: this.silentStream(), noMic: true });
    this.speakLocked = true;
    this.muted = true;
    this.applyLocalTrackState();
    for (const p of this.peers.values()) this.fillLanes(p);
    this.persist();
    this.onNotice('Microphone access was turned off for this site, so you\u2019re listen-only. Allow it in your browser\u2019s site settings, then switch your mic back on in Settings.', 'error');
  }
  onPermission(name, state) {
    if (!this.channelId) return;
    this.log(`${name === 'microphone' ? 'Microphone' : 'Camera'} permission is now "${state}"`);
    if (name === 'microphone' && state === 'denied' && !this.noMic) this.micBlocked();
    if (name === 'microphone' && state === 'granted' && this.micDenied) { this.muted = true; this.swapMic().then((r) => { if (r === 'mic') { this.persist(); this.onNotice('Microphone access is back. Unmute when you\u2019re ready.'); } }); }
    if (name === 'camera' && state === 'denied' && this.camStream) { this.setCamera(false).catch(() => {}); this.onNotice('Camera access was turned off for this site, so your video is off.', 'error'); }
  }

  // getIceServers() gives a list (automatic), or { iceServers, iceTransportPolicy } when the call has a region.
  rtcConfig() { const r = this.getIceServers({ automatic: this.relayFallback }); return Array.isArray(r) ? { iceServers: r } : r; }
  // New relay logins (the old ones run out): connections in progress use them from their next network change on.
  updateIceServers() {
    for (const peer of this.peers.values()) { try { peer.pc.setConfiguration(this.rtcConfig()); } catch { /* keeps the old ones */ } }
  }
  // The call's region changed: reconnect every connection through the new relays (like Discord moving a call to
  // another voice server: a short blip, nobody has to rejoin). Everyone gets the change at about the same time;
  // whoever started each connection rebuilds it, a moment later so both sides have the new region by then.
  // (Restarting the old connection in place isn't enough: browsers keep using the direct path they had.)
  switchNetwork() {
    this.relayFallback = false;
    if (!this.channelId) return;
    if (LIVE.has(this.state) && this.peers.size) {
      this.setState('switching');
      this.switchStarted = Date.now();
      this.switchUntil = this.switchStarted + 20000;
      clearTimeout(this.switchTimer);
      this.switchTimer = setTimeout(() => this.recompute(), 20500);
    }
    for (const peer of this.peers.values()) {
      if (!peer.initiator) continue;
      setTimeout(() => { if (this.peers.get(peer.socketId) === peer) this.reconnectPeer(peer.socketId).catch(() => {}); }, 800);
    }
    this.onChange();
  }
  // Starts one connection over: a fresh RTCPeerConnection (the other side sees the new one and replaces theirs).
  async reconnectPeer(socketId, hint = {}) {
    const old = this.peers.get(socketId);
    if (!old || !this.channelId) return;
    this.signal(socketId, { reset: true, ...hint }, old);
    // (The state isn't worked out in between: with the old connection gone and the new one not there yet, an
    // empty call would briefly count as "connected".)
    this.swapping = (this.swapping || 0) + 1;
    let peer;
    try {
      this.closePeer(socketId, null);
      peer = await this.createPeer(socketId, old.userId, true);
    } finally { this.swapping--; }
    if (peer) { peer.events = (old.events || []).slice(-20); this.log('Started a fresh connection', peer); }
    this.recompute();
    return peer;
  }
  // The Retry button on someone's tile.
  retryPeer(userId) {
    const p = this.peerByUser(userId);
    if (p) return this.reconnectPeer(p.socketId);
    return Promise.resolve();
  }

  async createPeer(socketId, userId, initiator) {
    // One connection per person: an older one (from before they reconnected) makes way.
    const dupe = this.peerByUser(userId);
    if (dupe) this.closePeer(dupe.socketId, null);
    const config = this.rtcConfig();
    const pc = new RTCPeerConnection(config);
    // hold: our own network candidates wait until our offer (or answer) has gone out, so they never arrive first.
    // pcId / remotePc: which connection each signal belongs to, so one meant for a connection that has since been
    // replaced is ignored instead of breaking the new one.
    const peer = { pc, pcId: newPcId(), remotePc: null, socketId, userId, audio: null, screenAudio: null, cam: null, screen: null, pending: [], initiator, hold: true, outbox: [], createdAt: Date.now(), events: [] };
    // Closing a connection leaves whatever it was still doing (making an offer, say) unsettled forever, so every
    // step on it also gives up when it closes (see op()).
    peer.closing = new Promise((_, reject) => { peer.abort = () => reject(new Error('This connection was closed.')); });
    peer.closing.catch(() => {});
    peer.everListed = this.listed.has(userId);
    if (!peer.everListed) peer.unlistedSince = Date.now();
    // Pinned to a region: everything must go through its relay. If that relay hands out no address at all, it's
    // down (or unreachable from here), and waiting for the usual restarts would only prolong the silence.
    peer.relayOnly = config.iceTransportPolicy === 'relay';
    peer.candidates = 0;
    if (peer.relayOnly) peer.relayTimer = setTimeout(() => { if (!peer.closed && !peer.candidates) this.relayDown(); }, 6000);
    this.peers.set(socketId, peer);
    this.log(initiator ? 'Calling' : 'Answering', peer);
    if (initiator) {
      // The caller creates the four lanes; the other side gets them from the offer (see setupLanes).
      pc.addTransceiver(this.localStream ? this.localStream.getAudioTracks()[0] : 'audio', { direction: 'sendrecv', streams: this.localStream ? [this.localStream] : [] });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      await this.fillLanes(peer);
    }

    pc.onicecandidate = (e) => {
      if (peer.closed) return;
      if (!e.candidate) { if (peer.relayOnly && !peer.candidates) this.relayDown(); return; } // gathering finished
      peer.candidates++;
      const candidate = e.candidate.toJSON();
      if (peer.hold) peer.outbox.push(candidate); else this.signal(peer.socketId, { candidate }, peer);
    };
    pc.ontrack = (e) => {
      if (peer.closed) return;
      const lane = pc.getTransceivers().indexOf(e.transceiver);
      if (lane === LANE.cam || lane === LANE.screen) {
        peer[lane === LANE.cam ? 'cam' : 'screen'] = e.track;
        e.track.onunmute = () => this.onChange();
        e.track.onmute = () => this.onChange();
        this.onChange();
        return;
      }
      if (lane === LANE.screenAudio) {
        if (!peer.screenAudio) {
          peer.screenAudio = document.createElement('audio');
          peer.screenAudio.autoplay = true;
          document.getElementById('audio-sink').append(peer.screenAudio);
        }
        peer.screenAudio.srcObject = new MediaStream([e.track]);
        peer.screenAudio.muted = this.deafened;
        peer.screenAudio.volume = this.volumeFor(userId);
        peer.screenAudio.play().catch(() => {});
        return;
      }
      const stream = new MediaStream([e.track]);
      if (!peer.audio) {
        peer.audio = document.createElement('audio');
        peer.audio.autoplay = true;
        peer.audio.playsInline = true;
        document.getElementById('audio-sink').append(peer.audio);
      }
      peer.audio.srcObject = stream;
      peer.audio.muted = this.deafened;
      peer.audio.volume = this.volumeFor(userId);
      const prefs = JSON.parse(localStorage.getItem('hearth.audio') || '{}');
      if (prefs.outputId && peer.audio.setSinkId) peer.audio.setSinkId(prefs.outputId).catch(() => {});
      peer.audio.play().catch(() => {});
      this.watch(userId, stream);
    };
    // If a connection doesn't come up (or breaks), retry with a fresh network path, backing off between tries
    // (see PEER_RECOVERY). Whoever started the connection does the restart; the other side asks for one.
    peer.restarts = 0;
    peer.watchdog = setTimeout(() => this.recover(peer), PEER_RECOVERY.firstCheck);
    pc.onconnectionstatechange = () => {
      if (peer.closed) return;
      const st = pc.connectionState;
      this.log(`Connection ${st}`, peer);
      if (st === 'connected') {
        if (peer.failed || peer.restarts) this.log(`Recovered after ${peer.restarts} restart${peer.restarts === 1 ? '' : 's'}`, peer);
        peer.failed = false; peer.restarts = 0; clearTimeout(peer.watchdog);
        peer.lastSetupMs = Date.now() - peer.createdAt;
      }
      if (st === 'failed' || st === 'disconnected') {
        clearTimeout(peer.watchdog);
        // "disconnected" often fixes itself within a few seconds; "failed" never does.
        peer.watchdog = setTimeout(() => this.recover(peer), st === 'failed' ? backoff(peer.restarts, PEER_RECOVERY) : 3000);
      }
      this.recompute();
      this.onChange();
    };

    if (initiator) await this.sendLocal(socketId, peer, await this.op(peer, pc.createOffer({ offerToReceiveAudio: true })));
    return peer;
  }
  op(peer, promise) { return Promise.race([promise, peer.closing]); }
  // One connection isn't up: restart its network path (twice, backing off), then start it over once, then mark it
  // failed. With the call pinned to a region whose relay doesn't answer, fall back to automatic relays first.
  recover(peer) {
    if (peer.closed || this.peers.get(peer.socketId) !== peer || !this.channelId) return;
    if (peer.pc.connectionState === 'connected') return;
    clearTimeout(peer.watchdog);
    // Nobody can be reached without the server: the rejoin takes care of it.
    if (!this.socket.connected || !LIVE.has(this.state)) { peer.watchdog = setTimeout(() => this.recover(peer), PEER_RECOVERY.check); return; }
    if (peer.restarts >= PEER_RECOVERY.restarts + 1) {
      if (peer.relayOnly && !this.relayFallback) return this.relayDown();
      peer.failed = true;
      this.log('Gave up: press Retry to try again', peer);
      this.recompute();
      this.onChange();
      return;
    }
    peer.restarts++;
    if (peer.restarts > PEER_RECOVERY.restarts) {
      // Restarting in place didn't work: a fresh connection (it keeps the count, so this happens once).
      const n = peer.restarts;
      this.reconnectPeer(peer.socketId).then((p) => { if (p) { p.restarts = n; clearTimeout(p.watchdog); p.watchdog = setTimeout(() => this.recover(p), PEER_RECOVERY.check); } }).catch(() => {});
      return;
    }
    this.log(`Restarting the network path (try ${peer.restarts})`, peer);
    if (peer.initiator) this.restartIce(peer.socketId, peer); else this.signal(peer.socketId, { restart: true }, peer);
    peer.watchdog = setTimeout(() => this.recover(peer), PEER_RECOVERY.check + backoff(peer.restarts - 1, PEER_RECOVERY));
  }

  // The pinned region's relay isn't working for us: this call falls back to automatic relays (direct paths and the
  // nearest relays), and the person is told. Connections that work stay as they are.
  relayDown() {
    if (this.relayFallback || !this.channelId) return;
    this.relayFallback = true;
    this.log('The call region\u2019s relay isn\u2019t answering: using automatic relays');
    this.onNotice('The call region\u2019s relay isn\u2019t answering, so your connection switched to automatic relays.', 'error');
    // (The others are told why, so they don't wait out their own timer before doing the same.)
    for (const p of [...this.peers.values()]) if (p.pc.connectionState !== 'connected') this.reconnectPeer(p.socketId, { relayDown: true }).catch(() => {});
  }
  // Every signal says which of our connections it's from, and which of theirs it's for.
  signal(to, data, peer = this.peers.get(to)) {
    // Offline, a signal would only be sent later from a new connection the server doesn't know yet: the rejoin
    // renegotiates whatever needs it instead.
    if (this.socket.connected === false) return;
    const out = peer ? { ...data, pc: peer.pcId, ...(peer.remotePc ? { topc: peer.remotePc } : {}) } : data;
    this.socket.emit('voice:signal', { to, data: out }, () => {});
  }
  // One restart at a time per connection: a second one asked for meanwhile runs after the answer arrives.
  async restartIce(socketId, peer) {
    if (peer.restarting) { peer.restartAgain = true; return; }
    peer.restarting = true;
    clearTimeout(peer.restartTimer);
    peer.restartTimer = setTimeout(() => this.restartDone(socketId, peer), 8000); // no answer: let the next try go
    try {
      await this.sendLocal(peer.socketId, peer, await this.op(peer, peer.pc.createOffer({ iceRestart: true })));
    } catch { this.restartDone(socketId, peer); /* try again on the next round */ }
  }
  restartDone(socketId, peer) {
    clearTimeout(peer.restartTimer);
    peer.restarting = false;
    if (peer.restartAgain && this.peers.get(peer.socketId) === peer) { peer.restartAgain = false; this.restartIce(peer.socketId, peer); }
  }
  // How each person's connection is doing: 'connected' | 'connecting' | 'reconnecting' | 'failed'
  peerState(userId) {
    const p = this.peerByUser(userId);
    if (!p) return null;
    if (p.failed) return 'failed';
    const st = p.pc.connectionState;
    if (st === 'connected') return 'connected';
    if (st === 'disconnected' || st === 'failed' || p.restarts) return 'reconnecting';
    return 'connecting';
  }

  async sendSdp(to, toUserId, desc, peer) {
    const sdp = { type: desc.type, sdp: desc.sdp };
    const sig = await this.signSdp(toUserId, sdp);
    if (peer && peer.closed) return;
    this.signal(peer ? peer.socketId : to, { sdp, sig }, peer);
  }
  // Sets our offer or answer and sends it (signed). The network candidates found meanwhile wait, and follow it once
  // it's out, so the other side never gets candidates for a description it hasn't seen. (If a newer offer started
  // meanwhile, they wait for that one instead.)
  async sendLocal(socketId, peer, description) {
    const gen = (peer.gen || 0) + 1;
    peer.gen = gen;
    peer.hold = true;
    await this.op(peer, peer.pc.setLocalDescription(description));
    await this.sendSdp(socketId, peer.userId, peer.pc.localDescription, peer);
    if (peer.gen !== gen || this.peers.get(peer.socketId) !== peer) return;
    peer.hold = false;
    for (const candidate of peer.outbox.splice(0)) this.signal(peer.socketId, { candidate }, peer);
  }

  queueSignal(p) {
    const from = p && p.from;
    // (One that takes too long, say a key that won't load, doesn't hold up the rest for more than 10 seconds.)
    const step = () => new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 10000);
      this.handleSignal(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
    const run = (this.signalChains.get(from) || Promise.resolve()).then(step).catch((e) => console.warn('signal error', e));
    this.signalChains.set(from, run);
    run.then(() => { if (this.signalChains.get(from) === run) this.signalChains.delete(from); });
    return run;
  }

  async handleSignal({ from, userId, data }) {
    if (!this.channelId || !data) return;
    let peer = this.peers.get(from);
    // Same person on a new socket (they reconnected and the news hasn't reached us yet): move the connection over.
    if (!peer && userId) { const known = this.peerByUser(userId); if (known) { this.rekey(known, from); peer = known; } }
    // Meant for one of our connections that has since been replaced: ignore it.
    if (peer && data.topc && data.topc !== peer.pcId) return;
    if (data.restart && peer && peer.initiator) { this.restartIce(from, peer); return; }
    // They fell back to automatic relays because the region's relay gave them nothing. If ours hasn't given us
    // anything either, do the same now (the fresh connection they're about to offer then works for both).
    if (data.reset && data.relayDown && peer && peer.relayOnly && !peer.candidates && !this.relayFallback) {
      this.relayFallback = true;
      this.log('The call region\u2019s relay isn\u2019t answering them either: using automatic relays');
      this.onNotice('The call region\u2019s relay isn\u2019t answering, so your connection switched to automatic relays.', 'error');
    }
    if (data.reset) { if (peer && !peer.initiator && (!data.pc || !peer.remotePc || data.pc === peer.remotePc)) this.closePeer(from, null); return; } // a fresh connection follows
    // From one of their connections that has since been replaced (candidates, answers): ignore it.
    if (peer && !data.sdp && data.pc && peer.remotePc && data.pc !== peer.remotePc) return;
    if (data.sdp) {
      const ok = data.sdp && typeof data.sdp.sdp === 'string' && await this.verifySdp(userId, data.sdp, data.sig);
      if (!ok) {
        console.warn('Rejected unsigned or tampered voice handshake from', userId);
        this.onSecurityWarning(userId);
        return;
      }
      if (!this.channelId) return;
      peer = this.peers.get(from) || (userId && this.peerByUser(userId)) || null;
      if (peer && peer.socketId !== from) this.rekey(peer, from);
      if (data.sdp.type === 'offer') {
        // A brand-new connection from them (they started over): it replaces ours.
        const replace = peer && data.pc && peer.remotePc && data.pc !== peer.remotePc && !data.topc;
        // Both sides started a fresh connection at the same moment: the one with the lower user id gives way.
        const glare = peer && !replace && !peer.remotePc && peer.pc.signalingState === 'have-local-offer';
        if (glare) { const me = this.myId(); if (me && userId && me > userId) return; } // ours wins; they'll answer it
        this.swapping = (this.swapping || 0) + 1; // (not "connected" while swapping one connection for another)
        try {
          if (replace || glare) { this.closePeer(peer.socketId, null); peer = null; }
          if (!peer) {
            peer = await this.createPeer(from, userId, false);
            peer.pending.push(...(this.early.get(from) || []));
            this.early.delete(from);
          }
        } finally { this.swapping--; }
        if (data.pc) peer.remotePc = data.pc;
        await this.op(peer, peer.pc.setRemoteDescription(data.sdp));
        await this.setupLanes(peer);
        await this.flush(peer);
        await this.sendLocal(from, peer, await this.op(peer, peer.pc.createAnswer()));
      } else if (data.sdp.type === 'answer' && peer) {
        if (data.pc && !peer.remotePc) peer.remotePc = data.pc;
        if (peer.pc.signalingState === 'have-local-offer') await this.op(peer, peer.pc.setRemoteDescription(data.sdp));
        await this.flush(peer);
        this.restartDone(from, peer);
      }
    } else if (data.candidate && peer) {
      if (!peer.pc.remoteDescription) peer.pending.push(data.candidate);
      else await this.op(peer, peer.pc.addIceCandidate(data.candidate)).catch(() => {});
    } else if (data.candidate) {
      // Their connection doesn't exist here yet (its offer is on the way): keep the candidate for it.
      const list = this.early.get(from) || [];
      if (list.length < 50) list.push(data.candidate);
      this.early.set(from, list);
    }
  }

  async flush(peer) {
    const list = peer.pending.splice(0);
    for (const c of list) await this.op(peer, peer.pc.addIceCandidate(c)).catch(() => {});
  }

  closePeer(socketId, why = 'closed') {
    this.early.delete(socketId);
    const peer = this.peers.get(socketId);
    if (!peer) return;
    peer.closed = true;
    peer.abort();
    if (why) this.log(`Connection closed: ${why}`, peer);
    clearTimeout(peer.watchdog);
    clearTimeout(peer.restartTimer);
    clearTimeout(peer.relayTimer);
    const pc = peer.pc;
    pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null;
    try { pc.close(); } catch { /* ignore */ }
    if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
    if (peer.screenAudio) { peer.screenAudio.srcObject = null; peer.screenAudio.remove(); }
    this.peers.delete(socketId);
    if (![...this.peers.values()].some((p) => p.userId === peer.userId)) this.unwatch(peer.userId);
    this.recompute();
    this.onChange();
  }

  pttMode() { try { return JSON.parse(localStorage.getItem('hearth.audio') || '{}').mode === 'ptt'; } catch { return false; } }
  // Key pressed / released. Releasing waits a moment (Settings: release delay) so word endings aren't cut off.
  setPtt(down) {
    clearTimeout(this.pttTimer);
    if (down) { if (!this.pttHeld) { this.pttHeld = true; this.applyLocalTrackState(); this.onChange(); } return; }
    let delay = 200;
    try { delay = Math.max(0, Math.min(2000, +(JSON.parse(localStorage.getItem('hearth.audio') || '{}').pttDelay ?? 200))); } catch { /* default */ }
    this.pttTimer = setTimeout(() => { this.pttHeld = false; this.applyLocalTrackState(); this.onChange(); }, delay);
  }
  talking() { return !this.muted && !this.deafened && (!this.pttMode() || this.pttHeld); }
  applyLocalTrackState() {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach((t) => { t.enabled = this.talking() && this.gateOpen !== false; });
  }

  setMuted(v) {
    if (!v && this.speakLocked) return;
    this.muted = v;
    if (!v && this.deafened) this.deafened = false;
    this.persist();
  }
  setDeafened(v) {
    this.deafened = v;
    this.persist();
  }
  persist() {
    localStorage.setItem('hearth.muted', this.muted ? '1' : '0');
    localStorage.setItem('hearth.deafened', this.deafened ? '1' : '0');
    this.applyLocalTrackState();
    for (const p of this.peers.values()) { if (p.audio) p.audio.muted = this.deafened; if (p.screenAudio) p.screenAudio.muted = this.deafened; }
    this.sendState();
    this.onChange();
  }

  volumeFor(userId) { return this.volumes[userId] ?? 1; }
  setVolume(userId, v) {
    this.volumes[userId] = v;
    localStorage.setItem('hearth.volumes', JSON.stringify(this.volumes));
    for (const p of this.peers.values()) if (p.userId === userId) { if (p.audio) p.audio.volume = v; if (p.screenAudio) p.screenAudio.volume = v; }
  }

  // ---- video: camera and screen sharing
  sendState() {
    if (this.channelId && this.state !== 'failed') this.socket.emit('voice:update', { muted: this.muted, deafened: this.deafened, video: !!this.camStream, screen: !!this.screenStream }, () => {});
  }
  // Answering side: make every lane two-way, then plug in whatever we're currently sending.
  async setupLanes(peer) {
    const ts = peer.pc.getTransceivers();
    ts.forEach((t) => { if (t.direction !== 'stopped' && t.direction !== 'sendrecv') t.direction = 'sendrecv'; });
    await this.fillLanes(peer);
  }
  async fillLanes(peer) {
    const ts = peer.pc.getTransceivers();
    const put = async (lane, track) => { const t = ts[lane]; if (t && t.sender && t.sender.track !== track) await this.op(peer, t.sender.replaceTrack(track || null)).catch(() => {}); };
    await put(LANE.mic, this.localStream ? this.localStream.getAudioTracks()[0] : null);
    await put(LANE.cam, this.camStream ? this.camStream.getVideoTracks()[0] : null);
    await put(LANE.screen, this.screenStream ? this.screenStream.getVideoTracks()[0] : null);
    await put(LANE.screenAudio, this.screenStream ? this.screenStream.getAudioTracks()[0] || null : null);
    this.tuneEncoding(peer);
  }
  // Camera: 720p, ~900 kbps. Screen: sharp text first, up to ~2.5 Mbps.
  tuneEncoding(peer) {
    const ts = peer.pc.getTransceivers();
    const tune = (lane, maxBitrate, extra = {}) => {
      const sender = ts[lane] && ts[lane].sender;
      if (!sender || !sender.track) return;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      Object.assign(params.encodings[0], { maxBitrate, ...extra });
      sender.setParameters(params).catch(() => {});
    };
    tune(LANE.cam, 900000);
    tune(LANE.screen, 2500000, { maxFramerate: 30 });
  }
  async refreshAllLanes() { for (const p of this.peers.values()) await this.fillLanes(p); }
  videoConstraints() {
    const prefs = JSON.parse(localStorage.getItem('hearth.audio') || '{}');
    return { deviceId: prefs.cameraId ? { ideal: prefs.cameraId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  }
  async setCamera(on) {
    if (!this.channelId) return;
    if (on && !this.camStream) {
      const stream = await md().getUserMedia({ video: this.videoConstraints(), audio: false });
      if (!this.channelId) { stream.getTracks().forEach((t) => t.stop()); return; } // left meanwhile
      this.camStream = stream;
      const t = this.camStream.getVideoTracks()[0];
      t.contentHint = 'motion';
      // Ended by the browser: unplugged, or permission taken away. Turn video off and say why.
      t.onended = () => { if (this.camStream && this.camStream.getVideoTracks()[0] === t) this.checkDevices('ended'); };
    } else if (!on && this.camStream) {
      this.camStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      this.camStream = null;
    }
    await this.refreshAllLanes();
    this.sendState();
    this.onChange();
  }
  async setScreen(on) {
    if (!this.channelId) return;
    if (on && !this.screenStream) {
      if (!md().getDisplayMedia) throw new Error('Screen sharing isn\u2019t supported in this browser.');
      this.screenStream = await md().getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 }, width: { max: 2560 }, height: { max: 1440 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      });
      const v = this.screenStream.getVideoTracks()[0];
      v.contentHint = 'detail';
      v.onended = () => this.setScreen(false); // stopped from the browser's own "Stop sharing" bar
    } else if (!on && this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }
    await this.refreshAllLanes();
    this.sendState();
    this.onChange();
  }
  // Remote video for a person (tracks exist even when they aren't sending; the call state says if they are).
  remoteMedia(userId) {
    for (const p of this.peers.values()) if (p.userId === userId) return { cam: p.cam, screen: p.screen };
    return { cam: null, screen: null };
  }

  // ---- diagnostics (only our own connections; see summarizeStats for what's shown and what never is)
  async diagnostics(relayNames = []) {
    const peers = [];
    for (const p of this.peers.values()) {
      let report = null;
      try { report = await p.pc.getStats(); } catch { /* closed meanwhile */ }
      const summary = summarizeStats(report, p.lastStats, relayNames);
      p.lastStats = summary.raw;
      peers.push({
        userId: p.userId, state: p.failed ? 'failed' : p.pc.connectionState, ice: p.pc.iceConnectionState || null,
        initiator: !!p.initiator, restarts: p.restarts || 0, listed: this.listed.has(p.userId), setupMs: p.lastSetupMs ?? null,
        metrics: summary.metrics, events: (p.events || []).slice(-20),
      });
    }
    return { state: this.state, since: this.stateSince, relayFallback: this.relayFallback, lastSwitchMs: this.lastSwitchMs, events: this.history.slice(-30), peers };
  }
  // For tests and the debug hook: how many connections this call has open.
  debugInfo() {
    return { state: this.state, attempt: this.attempt, peers: [...this.peers.values()].map((p) => ({ userId: p.userId, socketId: p.socketId, state: p.pc.connectionState, failed: !!p.failed })), lastSwitchMs: this.lastSwitchMs };
  }

  // ---- speaking detection (local analysis of each stream)
  watch(id, stream) {
    this.unwatch(id);
    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      const src = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let quietFor = 0;
      let loudFor = 0;
      let floor = 0.01; // learned background-noise level
      const prefs = JSON.parse(localStorage.getItem('hearth.audio') || '{}');
      const gate = id === 'me' && !!prefs.gate;
      const threshold = gate ? Math.min(0.2, Math.max(0.003, +prefs.threshold || 0.02)) : 0.02;
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        // Track the room's noise floor: drop to quiet moments quickly, rise slowly, so steady hum
        // (fans, mic hiss) never counts as talking.
        floor = rms < floor ? floor * 0.7 + rms * 0.3 : floor * 0.995 + rms * 0.005;
        const silent = (id === 'me' && !this.talking()) || (this.isPeerMuted && this.isPeerMuted(id));
        const above = !silent && rms > Math.max(threshold, floor * 2.5 + 0.006);
        loudFor = above ? loudFor + 1 : 0;
        quietFor = above ? 0 : quietFor + 1;
        // Start only after ~160 ms of real sound; stop after ~320 ms of quiet (no flicker between words).
        const was = !!this.speaking.get(id);
        const speaking = silent ? false : was ? quietFor < 4 : loudFor >= 2;
        if (gate) {
          const open = rms > threshold || quietFor < 5;
          if (open !== this.gateOpen) { this.gateOpen = open; this.applyLocalTrackState(); }
        }
        if (speaking !== was) {
          this.speaking.set(id, speaking);
          this.onSpeaking(id, speaking);
        }
      }, 80);
      this.meters.set(id, { src, analyser, timer });
    } catch { /* AudioContext unavailable */ }
  }
  unwatch(id) {
    const m = this.meters.get(id);
    if (!m) return;
    clearInterval(m.timer);
    try { m.src.disconnect(); } catch { /* ignore */ }
    this.meters.delete(id);
    if (this.speaking.get(id)) { this.speaking.set(id, false); this.onSpeaking(id, false); }
  }

  // Older name for the call bar's summary: 'connected' | 'connecting' | 'failed'.
  connectionQuality() {
    if (['failed', 'degraded', 'reconnecting'].includes(this.state)) return 'failed';
    if (this.state === 'connected') return 'connected';
    return 'connecting';
  }
}

// Turns one RTCStatsReport into the numbers the diagnostics panel shows. A number that the browser didn't report
// is null ("unavailable"), never 0. Addresses, ports, relay URLs and device ids are read only to work out the kind
// of path and the relay's region name: none of them is ever copied into the result.
// relayNames: [{ urls, region }] (the relay list the app has), used to name the relay in use.
export function summarizeStats(report, prev, relayNames = []) {
  const all = [];
  if (report && typeof report.forEach === 'function') report.forEach((s) => all.push(s));
  const byId = new Map(all.map((s) => [s.id, s]));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const transport = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  const pair = (transport && byId.get(transport.selectedCandidatePairId))
    || all.find((s) => s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded')));
  const local = pair && byId.get(pair.localCandidateId);
  const remote = pair && byId.get(pair.remoteCandidateId);
  const inAudio = all.find((s) => s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'audio' && (s.packetsReceived || 0) > 0)
    || all.find((s) => s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'audio');
  const inVideo = all.filter((s) => s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'video').sort((a, b) => (b.bytesReceived || 0) - (a.bytesReceived || 0))[0];
  const outVideo = all.filter((s) => s.type === 'outbound-rtp' && (s.kind || s.mediaType) === 'video').sort((a, b) => (b.bytesSent || 0) - (a.bytesSent || 0))[0];
  const ts = num(inAudio && inAudio.timestamp) ?? num(pair && pair.timestamp);
  const raw = {
    t: ts, lost: num(inAudio && inAudio.packetsLost), recv: num(inAudio && inAudio.packetsReceived),
    bytes: num(inAudio && inAudio.bytesReceived), vbytes: num(inVideo && inVideo.bytesReceived),
  };
  // Loss over the last interval when there's an earlier sample (what's happening now), else since the start.
  let loss = null;
  if (raw.lost !== null && raw.recv !== null) {
    const dl = prev && prev.lost !== null ? raw.lost - prev.lost : raw.lost;
    const dr = prev && prev.recv !== null ? raw.recv - prev.recv : raw.recv;
    loss = dl + dr > 0 ? Math.max(0, Math.round((dl / (dl + dr)) * 1000) / 10) : (dl === 0 && dr === 0 && prev ? null : 0);
  }
  let flowing = null;
  if (raw.bytes !== null && prev && prev.bytes !== null) flowing = raw.bytes > prev.bytes;
  else if (raw.bytes !== null) flowing = raw.bytes > 0;
  const relayUrl = local && local.candidateType === 'relay' ? String(local.url || '') : '';
  let relay = null;
  if (local && local.candidateType === 'relay') {
    const hit = relayUrl && relayNames.find((e) => [].concat(e.urls || []).some((u) => relayUrl && String(u).replace(/\?.*$/, '') === relayUrl.replace(/\?.*$/, '')));
    relay = hit && hit.region ? hit.region : 'a relay';
  }
  const ms = (s) => (s === null ? null : Math.round(s * 1000));
  const res = inVideo && num(inVideo.frameWidth) && num(inVideo.frameHeight) ? `${inVideo.frameWidth}\u00d7${inVideo.frameHeight}` : null;
  const outRes = outVideo && num(outVideo.frameWidth) && num(outVideo.frameHeight) ? `${outVideo.frameWidth}\u00d7${outVideo.frameHeight}` : null;
  return {
    raw,
    metrics: {
      rttMs: ms(num(pair && pair.currentRoundTripTime)),
      lossPct: loss,
      jitterMs: ms(num(inAudio && inAudio.jitter)),
      outKbps: num(pair && pair.availableOutgoingBitrate) === null ? null : Math.round(pair.availableOutgoingBitrate / 1000),
      inFps: num(inVideo && inVideo.framesPerSecond),
      outFps: num(outVideo && outVideo.framesPerSecond),
      inResolution: res,
      outResolution: outRes,
      audioLevel: num(inAudio && inAudio.audioLevel),
      audioFlowing: flowing,
      path: local ? (['host', 'srflx', 'prflx', 'relay'].includes(local.candidateType) ? local.candidateType : null) : null,
      remotePath: remote ? (['host', 'srflx', 'prflx', 'relay'].includes(remote.candidateType) ? remote.candidateType : null) : null,
      relayProtocol: local && local.candidateType === 'relay' && ['udp', 'tcp', 'tls'].includes(local.relayProtocol) ? local.relayProtocol : null,
      relay,
    },
  };
}
