// Call relays in several regions: measure which answer fastest from this device and use those.
// A relay "answers" when it hands out an address (one round trip to it and back, twice), so the time
// it takes is a good stand-in for distance. Results are kept for 6 hours.
const KEY = 'hearth.relayRtt';
const TTL = 6 * 3600000;
const isRelay = (e) => [].concat(e.urls || []).some((u) => /^turns?:/.test(u));
const sig = (e) => `${e.region || ''}|${[].concat(e.urls).join(',')}`;

export function measureRelay(entry, timeout = 4000) {
  return new Promise((resolve) => {
    let pc;
    const t0 = performance.now();
    const done = (v) => { clearTimeout(timer); try { pc && pc.close(); } catch { /* closed */ } resolve(v); };
    const timer = setTimeout(() => done(null), timeout);
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: entry.urls, username: entry.username, credential: entry.credential }], iceTransportPolicy: 'relay' });
      pc.onicecandidate = (e) => {
        if (e.candidate && / typ relay /.test(e.candidate.candidate)) done(Math.round(performance.now() - t0));
        else if (!e.candidate) done(null);
      };
      pc.createDataChannel('probe');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => done(null));
    } catch { done(null); }
  });
}

const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
// { "<region|urls>": ms or null }
export async function rankRelays(list, { force = false } = {}) {
  const relays = (list || []).filter(isRelay);
  const saved = load();
  if (!force && saved.at && Date.now() - saved.at < TTL && relays.every((e) => sig(e) in (saved.ms || {}))) return saved.ms;
  if (typeof RTCPeerConnection === 'undefined' || !relays.length) return {};
  const results = await Promise.all(relays.map((e) => measureRelay(e)));
  const ms = Object.fromEntries(relays.map((e, i) => [sig(e), results[i]]));
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), ms })); } catch { /* private mode */ }
  return ms;
}
export const relayTime = (ranks, e) => (ranks && sig(e) in ranks ? ranks[sig(e)] : undefined);

// What a call uses: every STUN server, plus the two relays that answered fastest (all of them until measured).
// Fewer relays = the connection is found sooner.
export function chooseIce(list, ranks) {
  const strip = (e) => { const { region, ...rest } = e; return rest; };
  const stun = (list || []).filter((e) => !isRelay(e));
  const relays = (list || []).filter(isRelay);
  if (relays.length <= 2 || !ranks) return [...stun, ...relays].map(strip);
  const scored = relays.map((e) => ({ e, ms: relayTime(ranks, e) }));
  const answered = scored.filter((x) => typeof x.ms === 'number').sort((a, b) => a.ms - b.ms);
  if (!answered.length) return [...stun, ...relays].map(strip);
  return [...stun, ...answered.slice(0, 2).map((x) => x.e)].map(strip);
}
