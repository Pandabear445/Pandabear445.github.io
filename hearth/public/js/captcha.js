// "I'm not a robot" check, self-hosted. The browser solves a small proof-of-work puzzle (in a worker,
// usually well under a second); the server checks it. No third-party scripts, no tracking.
import { h, icon } from './util.js';
import { api } from './api.js';

export function captchaWidget(purpose) {
  let state = 'idle'; // idle | working | done | error | off
  let challenge = null;
  let solution = null;
  let pending = null;
  let worker = null;
  const box = h('span', { class: 'cap-box', 'aria-hidden': 'true' });
  const label = h('span', { class: 'cap-label' }, 'I\u2019m not a robot');
  const bar = h('span', { class: 'cap-bar' });
  const el = h('button', { type: 'button', class: 'captcha', role: 'checkbox', 'aria-checked': 'false', onclick: () => { if (state === 'idle' || state === 'error') start(); } },
    box, label, h('span', { class: 'cap-brand' }, icon('shield'), h('span', null, 'Private check')), bar);
  const set = (s, text) => {
    state = s;
    el.dataset.state = s;
    el.setAttribute('aria-checked', String(s === 'done'));
    label.textContent = text;
    el.hidden = s === 'off';
  };
  const solve = (c) => new Promise((resolve, reject) => {
    try {
      worker = new Worker('/js/captcha-worker.js');
      worker.onmessage = (e) => {
        if (e.data.progress !== undefined) bar.style.width = `${Math.round(e.data.progress * 100)}%`;
        if (e.data.nonce !== undefined) { worker.terminate(); worker = null; resolve(e.data.nonce); }
      };
      worker.onerror = (err) => { worker.terminate(); worker = null; reject(err); };
      worker.postMessage({ salt: c.salt, difficulty: c.difficulty });
    } catch (err) { reject(err); }
  });
  function start() {
    if (pending) return pending;
    pending = (async () => {
      set('working', 'Checking\u2026');
      bar.style.width = '0%';
      try {
        challenge = await api('GET', `/captcha?purpose=${purpose}`);
        if (!challenge.required) { set('off', ''); return null; }
        const nonce = await solve(challenge);
        solution = { salt: challenge.salt, difficulty: challenge.difficulty, expires: challenge.expires, sig: challenge.sig, nonce };
        bar.style.width = '100%';
        set('done', 'Verified \u2713');
        return solution;
      } catch (e) {
        set('error', e && e.message ? `Couldn\u2019t check (${e.message}). Click to retry.` : 'Couldn\u2019t check. Click to retry.');
        throw new Error('Please complete the \u201cI\u2019m not a robot\u201d check.');
      } finally { pending = null; }
    })();
    return pending;
  }
  set('idle', 'I\u2019m not a robot');
  return {
    el,
    start: () => { if (state === 'idle') start().catch(() => {}); },
    // A fresh, unexpired solution (solving now if needed). null when the server doesn't require one.
    async token() {
      if (state === 'off') return null;
      if (state === 'done' && solution && solution.expires - Date.now() > 15000) return solution;
      return start();
    },
    // Each solution works once; call after every attempt.
    reset() { if (worker) { worker.terminate(); worker = null; } solution = null; if (state !== 'off') { set('idle', 'I\u2019m not a robot'); bar.style.width = '0%'; } },
  };
}
