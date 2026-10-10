// Call diagnostics: how each of your own connections in the call is doing, from the browser's own statistics.
// Only this device's connections are shown (nobody else's), and never an address or a device id: the stats are
// summarised in voice.js (summarizeStats), which keeps only numbers and the kind of path.
import { h, clear } from './util.js';
import { modal } from './ui.js';

// What each number means, in one line. "Unavailable" means the browser didn't report it (it isn't zero).
const METRICS = [
  ['rttMs', 'Round trip', (v) => `${v} ms`, 'Time for a packet to reach them and come back. Under 150 ms feels instant.'],
  ['lossPct', 'Packet loss', (v) => `${v}%`, 'Share of their audio that never arrived lately. Above 5% sounds choppy.'],
  ['jitterMs', 'Jitter', (v) => `${v} ms`, 'How unevenly their audio arrives. High jitter adds delay to smooth it out.'],
  ['outKbps', 'Upload room', (v) => `${v} kbps`, 'How much the connection estimates you can send to them right now.'],
  ['audioFlowing', 'Their audio', (v) => (v ? 'arriving' : 'not arriving'), 'Whether sound from them reached this device in the last few seconds (silence counts if they’re muted).'],
  ['audioLevel', 'Their level', (v) => `${Math.round(v * 100)}%`, 'How loud their audio is as it arrives.'],
  ['inFps', 'Their video', (v) => `${Math.round(v)} fps`, 'Frames per second of their camera or screen, as received.'],
  ['inResolution', 'Their picture', (v) => v, 'Size of their video as received.'],
  ['outFps', 'Your video', (v) => `${Math.round(v)} fps`, 'Frames per second you’re sending them.'],
  ['outResolution', 'Your picture', (v) => v, 'Size of the video you’re sending them.'],
  ['path', 'Path', (v) => ({ host: 'direct (local network)', srflx: 'direct (over the internet)', prflx: 'direct (over the internet)', relay: 'through a relay' })[v] || v, 'Direct paths are fastest. A relay is used when a network blocks direct calls; it only sees encrypted audio.'],
  ['relay', 'Relay', (v) => v, 'Which relay region carries this connection, when it goes through one.'],
  ['relayProtocol', 'Relay link', (v) => v.toUpperCase(), 'UDP is best; TCP or TLS means a firewall forced a slower route.'],
];
const STATE = { new: 'starting', connecting: 'connecting', connected: 'connected', disconnected: 'interrupted, recovering', failed: 'failed', closed: 'closed' };
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function openCallDiagnostics({ voice, name, relays, region }) {
  const body = h('div', { class: 'diag', 'aria-live': 'polite' }, h('p', { class: 'muted-p' }, 'Collecting…'));
  let timer = null;
  let open = true;
  const draw = async () => {
    if (!open) return;
    if (!voice.channelId) { clear(body).append(h('p', { class: 'muted-p' }, 'You’re not in a call.')); return; }
    const d = await voice.diagnostics(relays);
    if (!open) return;
    const st = voice.status();
    const head = h('div', null,
      h('p', null, h('strong', null, st.label || d.state), st.detail ? ` — ${st.detail}` : ''),
      h('p', { class: 'field-hint' }, `Call region: ${region() || 'Automatic'}${d.relayFallback ? ' (its relay didn’t answer, so automatic relays are in use)' : ''}.`
        + (d.lastSwitchMs !== null ? ` Last region switch took ${d.lastSwitchMs} ms.` : '')));
    const peers = d.peers.length ? d.peers.map((p) => h('div', { class: 'diag-peer' },
      h('h3', null, name(p.userId), h('span', { class: 'field-hint' }, STATE[p.state] || p.state)),
      p.listed ? null : h('p', { class: 'diag-warn' }, 'The server doesn’t list this person in the call. If you didn’t expect them, leave the call.'),
      h('table', { class: 'diag-table' }, h('tbody', null,
        METRICS.map(([key, label, fmt, why]) => {
          const v = p.metrics[key];
          return h('tr', null, h('td', null, label), h('td', null, v === null || v === undefined ? h('span', { class: 'diag-na' }, 'unavailable') : fmt(v)), h('td', null, why));
        }),
        h('tr', null, h('td', null, 'Restarts'), h('td', null, String(p.restarts)), h('td', null, 'Network-path restarts since this connection was last healthy.')),
        h('tr', null, h('td', null, 'Set-up time'), h('td', null, p.setupMs === null ? h('span', { class: 'diag-na' }, 'unavailable') : `${p.setupMs} ms`), h('td', null, 'How long this connection took to come up.')))),
      p.events.length ? h('details', null, h('summary', null, 'Connection log'), h('ol', { class: 'diag-log' }, p.events.slice().reverse().map((e) => h('li', null, `${time(e.t)} · ${e.event}`)))) : null))
      : [h('p', { class: 'muted-p' }, 'Nobody else is in the call, so there are no connections to show.')];
    const log = h('details', null, h('summary', null, 'Call log'), h('ol', { class: 'diag-log' }, d.events.slice().reverse().map((e) => h('li', null, `${time(e.t)} · ${e.userId ? `${name(e.userId)}: ` : ''}${e.event}`))));
    clear(body).append(head, ...peers, log, h('p', { class: 'field-hint' }, 'Only your own connections are shown. Addresses and device names are never shown here.'));
  };
  const loop = async () => { try { await draw(); } catch { /* the call ended meanwhile */ } if (open) timer = setTimeout(loop, 2000); };
  modal({ title: 'Call diagnostics', body, size: 'lg', onClose: () => { open = false; clearTimeout(timer); } });
  loop();
}
