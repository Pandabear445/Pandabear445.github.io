// Notifications on Apple devices (iPhone and iPad Home Screen apps, Safari on Mac): Apple's push service wants a
// real VAPID contact and cancels a subscription whose pushes show no notification.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { vapidSubject, DEFAULT } = require('../server/vapid');

test('apple-push-1: the VAPID subject is a real mailto: or https: address when one is available', () => {
  const ok = (env, subject) => assert.deepEqual([vapidSubject(env).subject, vapidSubject(env).placeholder], [subject, false], JSON.stringify(env));
  ok({ VAPID_SUBJECT: 'mailto:owner@kappa.chat' }, 'mailto:owner@kappa.chat');
  ok({ VAPID_SUBJECT: '  mailto: <owner@kappa.chat> ' }, 'mailto:owner@kappa.chat'); // Apple refuses the space and brackets
  ok({ VAPID_SUBJECT: 'https://chat.example.org.uk' }, 'https://chat.example.org.uk');
  // Placeholders (e.g. .env.example's, uncommented as is) give way to the server's own address.
  ok({ VAPID_SUBJECT: 'mailto:you@example.com', PUBLIC_URL: 'https://kappachat.duckdns.org/' }, 'https://kappachat.duckdns.org');
  ok({ VAPID_SUBJECT: 'mailto:admin@localhost', PUBLIC_URL: 'https://kappachat.duckdns.org' }, 'https://kappachat.duckdns.org');
  ok({ PUBLIC_URL: 'https://kappachat.duckdns.org/some/path' }, 'https://kappachat.duckdns.org');
  ok({ VAPID_SUBJECT: 'not an address', PUBLIC_URL: 'https://chat.host.net' }, 'https://chat.host.net');
});

test('apple-push-2: with nothing usable it keeps working, flagged so the server warns', () => {
  for (const env of [{}, { VAPID_SUBJECT: 'mailto:you@example.com' }, { PUBLIC_URL: 'http://chat.host.net' }, { PUBLIC_URL: 'https://localhost:3000' },
    { VAPID_SUBJECT: 'mailto:admin@localhost' }, { VAPID_SUBJECT: 'garbage' }, { VAPID_SUBJECT: 'https://chat.test' }]) {
    const r = vapidSubject(env);
    assert.equal(r.placeholder, true, JSON.stringify(env));
    assert.match(r.subject, /^(mailto:|https:)/, 'still a well-formed subject');
  }
  assert.equal(vapidSubject({}).subject, DEFAULT);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /require\('\.\/vapid'\)\.vapidSubject\(\)/, 'the server uses it');
  assert.match(src, /if \(vs\.placeholder\) log\.warn\('push', 'vapid_subject'/, 'and warns about a placeholder');
});

// ---------------------------------------------------------------- the service worker's push handler, run for real
function runPush({ endpoint, focused, data = { title: 'Alex', body: 'New message', tag: 'dm:1', url: '/x' } }) {
  const listeners = {};
  const shown = []; const closed = [];
  const self = {
    addEventListener: (t, f) => { listeners[t] = f; },
    skipWaiting() {},
    clients: { matchAll: async () => (focused === null ? [] : [{ focused, url: 'https://kappa.chat/' }]), claim: async () => {} },
    registration: {
      pushManager: { getSubscription: async () => (endpoint ? { endpoint } : null) },
      showNotification: async (title, opts) => { shown.push({ title, ...opts }); },
      getNotifications: async ({ tag }) => shown.filter((n) => n.tag === tag).map((n) => ({ close: () => closed.push(n.tag) })),
    },
  };
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8').replace('__VERSION__', 't').replace("'__ASSETS__'", '[]');
  vm.runInNewContext(src, { self, caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [] }, fetch: async () => ({}), Request: class {}, URL, location: { origin: 'https://kappa.chat' }, Date, JSON, console });
  let wait;
  listeners.push({ data: { json: () => data, text: () => JSON.stringify(data) }, waitUntil: (p) => { wait = p; } });
  return wait.then(() => ({ shown, closed }));
}
const APPLE = 'https://web.push.apple.com/QGZ3x9';
const GOOGLE = 'https://fcm.googleapis.com/fcm/send/abc';

test('apple-push-3: Apple subscriptions always get a notification shown, closed at once when Hearth is open in front', async () => {
  const front = await runPush({ endpoint: APPLE, focused: true });
  assert.equal(front.shown.length, 1, 'shown, so Safari keeps the subscription');
  assert.deepEqual(front.closed, [front.shown[0].tag], 'and closed right away: the open app shows its own');
  const away = await runPush({ endpoint: APPLE, focused: false });
  assert.equal(away.shown.length, 1);
  assert.equal(away.shown[0].title, 'Alex');
  assert.equal(away.shown[0].body, 'New message');
  assert.equal(away.shown[0].tag, 'dm:1');
  assert.deepEqual(away.closed, [], 'a real notification stays');
  const none = await runPush({ endpoint: APPLE, focused: null });
  assert.equal(none.shown.length, 1);
});

test('apple-push-4: other push services keep the old behaviour (nothing shown while Hearth is focused)', async () => {
  assert.equal((await runPush({ endpoint: GOOGLE, focused: true })).shown.length, 0);
  assert.equal((await runPush({ endpoint: GOOGLE, focused: false })).shown.length, 1);
  assert.equal((await runPush({ endpoint: null, focused: true })).shown.length, 0, 'no subscription: not Apple');
  assert.equal((await runPush({ endpoint: 'https://web.push.apple.com.evil.net/x', focused: true })).shown.length, 0, 'only Apple\'s own host');
});
