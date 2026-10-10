// Client performance changes that touch security code (quality workstream): the key-pin store in
// public/js/e2ee.js now keeps its parsed copy while the stored text is unchanged, and the member list checks
// everyone's keys in one go (checkPins). These tests prove neither changes an answer: a changed key is still
// reported, a change made elsewhere (another tab, another device's store) is still seen at once, and a failed
// save doesn't leave a pin that was never stored.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// Browser bits e2ee.js needs. Pins live in localStorage; swapping `store` is a different device.
let store = new Map();
let failWrites = false;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { if (failWrites) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis.window || { crypto: globalThis.crypto, hashwasm: require('hash-wasm') };

let E;
before(async () => { E = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'e2ee.js')).href); });

const key = () => crypto.randomBytes(65).toString('base64');
const person = (over = {}) => ({ id: 'u' + crypto.randomBytes(4).toString('hex'), publicKey: key(), signPublicKey: key(), ...over });
const ME = 'me-1';
const pinsOf = (me = ME) => JSON.parse(store.get(`hearth.pins.${me}`) || '{}');

test('checkPins gives the same answers and stores the same pins as checkPin, person by person', () => {
  const a = person(); const b = person(); const c = person({ signPublicKey: null }); const d = person(); const noKey = { id: 'nokey' };
  const me = { id: ME, publicKey: key() };
  const later = { cSign: key(), bKey: key(), dSign: key() };
  // Device 1 meets everyone one at a time; device 2 meets them as one list.
  const run = (fn) => {
    store = new Map();
    fn([a, b, c, d, me, noKey]); // first sight: pins
    c.signPublicKey = later.cSign; // c uploads a signing key later: added to the pin, not a change
    const changedB = { ...b, publicKey: later.bKey }; // b's identity key changes
    const changedD = { ...d, signPublicKey: later.dSign }; // d's signing key changes
    const out = fn([a, changedB, c, changedD, me, noKey]);
    c.signPublicKey = null;
    return { out, pins: pinsOf() };
  };
  const one = run((list) => new Set(list.filter((u) => E.checkPin(ME, u) === 'changed').map((u) => u.id)));
  const many = run((list) => E.checkPins(ME, list));
  assert.deepEqual([...many.out].sort(), [...one.out].sort());
  assert.deepEqual([...many.out].sort(), [b.id, d.id].sort(), 'both kinds of key change are reported');
  assert.deepEqual(many.pins, one.pins, 'the same pins end up stored');
  assert.equal(many.pins[b.id].e, b.publicKey, 'a changed key never replaces the pinned one');
  assert.ok(!many.pins[ME] && !many.pins.nokey, 'yourself and people without keys are not pinned');
});

test('a change to the stored pins made elsewhere is seen at once (no stale copy)', () => {
  store = new Map();
  const a = person();
  assert.equal(E.checkPin(ME, a), 'ok'); // pinned and cached
  assert.equal(E.checkPin(ME, a), 'ok');
  // Another tab trusts a different key for a (e.g. after comparing safety numbers there).
  const other = key();
  store.set(`hearth.pins.${ME}`, JSON.stringify({ [a.id]: { e: other, s: a.signPublicKey } }));
  assert.equal(E.checkPin(ME, a), 'changed', 'denied: the key the server sends no longer matches the pin');
  assert.deepEqual(E.checkPins(ME, [a]), new Set([a.id]));
  assert.equal(E.checkPin(ME, { ...a, publicKey: other }), 'ok');
  // A whole different store (another device) doesn't inherit this one's pins.
  store = new Map();
  const changed = { ...a, publicKey: key() };
  assert.equal(E.checkPin(ME, changed), 'ok', 'first sight on the other device');
  assert.equal(pinsOf()[a.id].e, changed.publicKey);
});

test('a pin that failed to save is not remembered', () => {
  store = new Map();
  const a = person();
  failWrites = true;
  try { assert.throws(() => E.checkPin(ME, a), /Quota/); } finally { failWrites = false; }
  assert.equal(store.get(`hearth.pins.${ME}`), undefined);
  // Meanwhile the stored pins (written elsewhere) say a has a different key: that must show as changed,
  // not be hidden by the pin that never got saved.
  store.set(`hearth.pins.${ME}`, JSON.stringify({ [a.id]: { e: key(), s: null } }));
  assert.equal(E.checkPin(ME, a), 'changed');
  failWrites = true;
  try { assert.throws(() => E.checkPins(ME, [person()]), /Quota/); } finally { failWrites = false; }
  assert.equal(E.checkPin(ME, a), 'changed');
});

test('each account on a device has its own pins', () => {
  store = new Map();
  const a = person();
  E.checkPin('me-A', a);
  const changed = { ...a, publicKey: key() };
  assert.equal(E.checkPin('me-A', changed), 'changed');
  assert.equal(E.checkPin('me-B', changed), 'ok', 'a different account meets a fresh');
  assert.equal(E.checkPin('me-A', changed), 'changed', 'and the first account still remembers its pin');
});

test('a damaged pin store is read as empty instead of breaking', () => {
  for (const bad of ['{nope', 'null', '[1,2]', '42']) {
    store = new Map([[`hearth.pins.${ME}`, bad]]);
    const a = person();
    assert.equal(E.checkPin(ME, a), 'ok');
    assert.equal(pinsOf()[a.id].e, a.publicKey);
  }
});
