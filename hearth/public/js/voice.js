// Voice & video: WebRTC peer-to-peer mesh, signaled over Socket.IO.
// Audio and video go directly between participants (DTLS-SRTP encrypted by the browser).
// Mesh works well for small rooms (voice up to ~8–10 people; video up to ~4–6).
//
// Every connection negotiates four lanes up front, always in this order:
//   0 microphone (audio) · 1 camera (video) · 2 screen (video) · 3 screen audio (audio)
// Turning the camera or a screen share on/off just plugs a track into its lane (replaceTrack), so no
// renegotiation is ever needed and two people toggling video at once can't collide.
const LANE = { mic: 0, cam: 1, screen: 2, screenAudio: 3 };

export class Voice {
  constructor({ socket, getIceServers, onChange, onSpeaking, signSdp, verifySdp, onSecurityWarning, isPeerMuted }) {
    this.socket = socket;
    this.isPeerMuted = isPeerMuted;
    // Offers/answers are signed with the sender's signing key and checked before use. The DTLS
    // fingerprint inside the SDP is what pins the encrypted audio connection, so a server that
    // swapped it to listen in would be caught here.
    this.signSdp = signSdp;
    this.verifySdp = verifySdp;
    this.onSecurityWarning = onSecurityWarning || (() => {});
    this.getIceServers = getIceServers;
    this.onChange = onChange || (() => {});
    this.onSpeaking = onSpeaking || (() => {});
    this.channelId = null;
    this.peers = new Map(); // socketId -> { pc, userId, audio, pending: [] }
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

    socket.on('voice:signal', (p) => this.handleSignal(p).catch((e) => console.warn('signal error', e)));
    socket.on('voice:peer-left', ({ socketId }) => this.closePeer(socketId));
    socket.on('voice:kicked', () => this.cleanup());
    socket.on('disconnect', () => { if (this.channelId) this.cleanup(); });
  }

  get inVoice() { return !!this.channelId; }

  emit(event, payload, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ error: 'The server didn\u2019t answer. Check your connection.' }), timeoutMs);
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

  async join(channelId, { video = false } = {}) {
    if (this.connecting) return;
    if (this.channelId === channelId) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Voice needs a secure connection. Open this site over https:// (or on localhost).');
    }
    this.connecting = true;
    try {
      if (this.channelId) await this.leave();
      // The raw mic stream is only analysed locally; peers get a clone, so the input-sensitivity gate
      // can silence what's sent while still hearing when you start talking again.
      this.noMic = false;
      try {
        this.rawStream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(), video: false });
      } catch (e) {
        if (e.name === 'NotAllowedError') throw e; // they said no: tell them how to allow it
        // No microphone, or it's busy in another app: join listen-only instead of failing.
        this.noMic = true;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.rawStream = ctx.createMediaStreamDestination().stream;
      }
      this.localStream = new MediaStream(this.rawStream.getAudioTracks().map((t) => t.clone()));
      this.gateOpen = true;
      this.applyLocalTrackState();
      this.channelId = channelId;
      const res = await this.emit('voice:join', { channelId, muted: this.muted, deafened: this.deafened, video });
      if (res.error) { this.cleanup(); throw new Error(res.error); }
      // Listen-only channel for this person: keep the mic off until they move somewhere they can speak.
      this.speakLocked = res.canSpeak === false || this.noMic;
      if (this.speakLocked) { this.muted = true; this.applyLocalTrackState(); this.emit('voice:update', { muted: true, deafened: this.deafened }); }
      this.watch('me', this.rawStream);
      for (const p of res.peers || []) await this.createPeer(p.socketId, p.userId, true);
      if (video) await this.setCamera(true).catch(() => {});
      this.onChange();
    } finally {
      this.connecting = false;
    }
  }

  async leave() {
    if (!this.channelId) return;
    const pending = this.emit('voice:leave', {}, 2500);
    this.cleanup(); // the call UI goes away immediately, whatever the network does
    await pending;
  }

  cleanup() {
    this.speakLocked = false;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    if (this.rawStream) this.rawStream.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.rawStream = null;
    if (this.camStream) this.camStream.getTracks().forEach((t) => t.stop());
    if (this.screenStream) this.screenStream.getTracks().forEach((t) => t.stop());
    this.camStream = null;
    this.screenStream = null;
    this.unwatch('me');
    this.channelId = null;
    this.onChange();
  }

  // getIceServers() gives a list (automatic), or { iceServers, iceTransportPolicy } when the call has a region.
  rtcConfig() { const r = this.getIceServers(); return Array.isArray(r) ? { iceServers: r } : r; }
  // The call's region changed: reconnect every connection through the new relays (like Discord moving a call to
  // another voice server: a short blip, nobody has to rejoin). Everyone gets the change at about the same time;
  // whoever started each connection rebuilds it, a moment later so both sides have the new region by then.
  // (Restarting the old connection in place isn't enough: browsers keep using the direct path they had.)
  switchNetwork() {
    for (const [socketId, peer] of this.peers) {
      if (!peer.initiator) continue;
      setTimeout(() => { if (this.peers.get(socketId) === peer) this.reconnectPeer(socketId).catch(() => {}); }, 800);
    }
    this.onChange();
  }
  async reconnectPeer(socketId) {
    const old = this.peers.get(socketId);
    if (!old || !this.channelId) return;
    this.signal(socketId, { reset: true });
    this.closePeer(socketId);
    await this.createPeer(socketId, old.userId, true);
  }

  async createPeer(socketId, userId, initiator) {
    const pc = new RTCPeerConnection(this.rtcConfig());
    const peer = { pc, userId, audio: null, screenAudio: null, cam: null, screen: null, pending: [], initiator };
    this.peers.set(socketId, peer);
    if (initiator) {
      // The caller creates the four lanes; the other side gets them from the offer (see setupLanes).
      pc.addTransceiver(this.localStream ? this.localStream.getAudioTracks()[0] : 'audio', { direction: 'sendrecv', streams: this.localStream ? [this.localStream] : [] });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      await this.fillLanes(peer);
    }

    pc.onicecandidate = (e) => { if (e.candidate) this.signal(socketId, { candidate: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
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
    // If a connection doesn't come up (or breaks), retry with a fresh network path. Whoever started the
    // connection does the restart; the other side asks for one. After two tries we report it.
    peer.restarts = 0;
    const retry = () => {
      if (!this.peers.has(socketId) || pc.connectionState === 'connected') return;
      if (peer.restarts >= 2) { peer.failed = true; this.onChange(); return; }
      peer.restarts++;
      if (peer.initiator) this.restartIce(socketId, peer); else this.signal(socketId, { restart: true });
      clearTimeout(peer.watchdog);
      peer.watchdog = setTimeout(retry, 12000);
    };
    peer.watchdog = setTimeout(retry, 12000);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { peer.failed = false; peer.restarts = 0; clearTimeout(peer.watchdog); }
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        clearTimeout(peer.watchdog);
        peer.watchdog = setTimeout(retry, pc.connectionState === 'failed' ? 300 : 4000);
      }
      this.onChange();
    };

    if (initiator) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await this.sendSdp(socketId, userId, pc.localDescription);
    }
    return peer;
  }

  signal(to, data) { this.socket.emit('voice:signal', { to, data }, () => {}); }
  // One restart at a time per connection: a second one asked for meanwhile runs after the answer arrives.
  async restartIce(socketId, peer) {
    if (peer.restarting) { peer.restartAgain = true; return; }
    peer.restarting = true;
    clearTimeout(peer.restartTimer);
    peer.restartTimer = setTimeout(() => this.restartDone(socketId, peer), 8000); // no answer: let the next try go
    try {
      const offer = await peer.pc.createOffer({ iceRestart: true });
      await peer.pc.setLocalDescription(offer);
      await this.sendSdp(socketId, peer.userId, peer.pc.localDescription);
    } catch { this.restartDone(socketId, peer); /* try again on the next round */ }
  }
  restartDone(socketId, peer) {
    clearTimeout(peer.restartTimer);
    peer.restarting = false;
    if (peer.restartAgain && this.peers.get(socketId) === peer) { peer.restartAgain = false; this.restartIce(socketId, peer); }
  }
  // How each person's connection is doing: 'connected' | 'connecting' | 'failed'
  peerState(userId) {
    for (const p of this.peers.values()) {
      if (p.userId !== userId) continue;
      if (p.failed) return 'failed';
      return p.pc.connectionState === 'connected' ? 'connected' : 'connecting';
    }
    return null;
  }

  async sendSdp(to, toUserId, desc) {
    const sdp = { type: desc.type, sdp: desc.sdp };
    this.signal(to, { sdp, sig: await this.signSdp(toUserId, sdp) });
  }

  async handleSignal({ from, userId, data }) {
    if (!this.channelId || !data) return;
    let peer = this.peers.get(from);
    if (data.restart && peer && peer.initiator) { this.restartIce(from, peer); return; }
    if (data.reset) { if (peer && !peer.initiator) this.closePeer(from); return; } // a fresh connection follows
    if (data.sdp) {
      const ok = data.sdp && typeof data.sdp.sdp === 'string' && await this.verifySdp(userId, data.sdp, data.sig);
      if (!ok) {
        console.warn('Rejected unsigned or tampered voice handshake from', userId);
        this.onSecurityWarning(userId);
        return;
      }
      if (data.sdp.type === 'offer') {
        if (!peer) peer = await this.createPeer(from, userId, false);
        await peer.pc.setRemoteDescription(data.sdp);
        await this.setupLanes(peer);
        await this.flush(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await this.sendSdp(from, userId, peer.pc.localDescription);
      } else if (data.sdp.type === 'answer' && peer) {
        if (peer.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription(data.sdp);
        await this.flush(peer);
        this.restartDone(from, peer);
      }
    } else if (data.candidate && peer) {
      if (!peer.pc.remoteDescription) peer.pending.push(data.candidate);
      else await peer.pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  async flush(peer) {
    const list = peer.pending.splice(0);
    for (const c of list) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  closePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    clearTimeout(peer.watchdog);
    try { peer.pc.close(); } catch { /* ignore */ }
    if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
    if (peer.screenAudio) { peer.screenAudio.srcObject = null; peer.screenAudio.remove(); }
    this.peers.delete(socketId);
    if (![...this.peers.values()].some((p) => p.userId === peer.userId)) this.unwatch(peer.userId);
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
    if (this.channelId) this.socket.emit('voice:update', { muted: this.muted, deafened: this.deafened, video: !!this.camStream, screen: !!this.screenStream }, () => {});
  }
  // Answering side: make every lane two-way, then plug in whatever we're currently sending.
  async setupLanes(peer) {
    const ts = peer.pc.getTransceivers();
    ts.forEach((t) => { if (t.direction !== 'stopped' && t.direction !== 'sendrecv') t.direction = 'sendrecv'; });
    await this.fillLanes(peer);
  }
  async fillLanes(peer) {
    const ts = peer.pc.getTransceivers();
    const put = async (lane, track) => { const t = ts[lane]; if (t && t.sender && t.sender.track !== track) await t.sender.replaceTrack(track || null).catch(() => {}); };
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
      this.camStream = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints(), audio: false });
      const t = this.camStream.getVideoTracks()[0];
      t.contentHint = 'motion';
      t.onended = () => this.setCamera(false);
    } else if (!on && this.camStream) {
      this.camStream.getTracks().forEach((t) => t.stop());
      this.camStream = null;
    }
    await this.refreshAllLanes();
    this.sendState();
    this.onChange();
  }
  async setScreen(on) {
    if (!this.channelId) return;
    if (on && !this.screenStream) {
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Screen sharing isn\u2019t supported in this browser.');
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
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

  connectionQuality() {
    const states = [...this.peers.values()].map((p) => p.pc.connectionState);
    if (!states.length) return 'connected';
    if (states.some((s) => s === 'failed')) return 'failed';
    if (states.some((s) => s === 'connecting' || s === 'new')) return 'connecting';
    return 'connected';
  }
}
