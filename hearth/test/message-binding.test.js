// crypto-7: a message's identity, place and version are bound into its ciphertext (public/js/binding.js). Each new
// message carries a random id (u), what it replies to (r), its thread (th), when it was sent (ts) and its edit count
// (v) inside the encrypted payload; readers' apps compare that with what the server says and flag what doesn't match.
// The client modules run here as they are (e2ee.js, secure.js, binding.js, linkpreview.js), against a real server
// whose database the tests tamper with the way a malicious operator could: moving a message under another reply or
// out of its thread, re-dating it, replaying it, serving it from before an edit. Each is flagged, and nothing that
// happens normally is (a reply whose original was deleted, a scheduled message going out at its time or late, edits).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./helpers');

// Browser bits the client code needs. Pins live in localStorage, so each device gets its own store.
let store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { crypto: globalThis.crypto, hashwasm: require('hash-wasm') };

const js = (f) => pathToFileURL(path.join(__dirname, '..', 'public', 'js', f)).href;
let srv; let E; let API; let BD; let LP; let A; let createSecure;
let curIp = '198.51.100.7';
const realFetch = globalThis.fetch;
const MIN = 60000;
const HOUR = 60 * MIN;

before(async () => {
  srv = await H.startServer();
  globalThis.fetch = (url, opts = {}) => (String(url).startsWith('/')
    ? realFetch(srv.base + url, { ...opts, headers: { ...(opts.headers || {}), 'x-forwarded-for': curIp } })
    : realFetch(url, opts));
  E = await import(js('e2ee.js'));
  API = await import(js('api.js'));
  BD = await import(js('binding.js'));
  LP = await import(js('linkpreview.js'));
  A = await import(js('attachments.js'));
  ({ createSecure } = await import(js('secure.js')));
});
after(async () => { globalThis.fetch = realFetch; await srv.stop(); });

// ------------------------------------------------------------------ the rules, on their own
const msg = (over = {}) => ({ id: 'm1', authorId: 'alice', channelId: 'c1', replyTo: null, threadId: null, createdAt: 1_800_000_000_000, ...over });
const bound = (over = {}) => ({ u: 'AAAAAAAAAAAAAAAAAAAAAA', r: null, th: null, ts: 1_800_000_000_000, v: 0, ...over });
const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; };

test('a new message gets a fresh id with its reply, thread and time; an edit keeps them one version later; a forward is new', () => {
  const a = BD.bindNew({ replyTo: 'r1', threadId: 't1', at: 1234.6 });
  assert.match(a.u, /^[A-Za-z0-9_-]{22}$/, '16 random bytes, base64url');
  assert.deepEqual({ ...a, u: 'x' }, { u: 'x', r: 'r1', th: 't1', ts: 1235, v: 0 });
  const ids = new Set(Array.from({ length: 200 }, () => BD.bindNew({ at: 1 }).u));
  assert.equal(ids.size, 200, 'every message (a forward of the same words too) gets its own id');
  assert.deepEqual(BD.bindNew({ replyTo: 5, threadId: '../x', at: 1 }).r, null, 'only real ids go in');
  assert.equal(BD.bindNew({ at: 9, scheduled: true }).sch, 1);
  const e1 = BD.bindEdit(a);
  assert.deepEqual(e1, { ...a, v: 1 }, 'same id, place and time');
  assert.deepEqual(BD.bindEdit(e1), { ...a, v: 2 });
  assert.deepEqual(BD.bindEdit({ ...a, sch: 1 }).sch, 1, 'a scheduled message stays one through edits');
  // A scheduled message re-encrypted before it goes keeps the id, reply and thread it was scheduled with.
  const s = BD.bindNew({ replyTo: 'r9', at: 50, scheduled: true });
  assert.deepEqual(BD.bindScheduled(s, { at: 70 }), { u: s.u, r: 'r9', th: null, ts: 70, v: 0, sch: 1 });
  // A copy from before these fields gets none: filling them in from what the server holds would sign the server's
  // reply, thread and time into it.
  assert.deepEqual(BD.bindScheduled(undefined, { at: 80 }), {});
  assert.deepEqual(BD.bindScheduled({ u: 'short', ts: 5 }, { at: 80 }), {});
});

test('bindingOf: only a well-formed u counts; odd fields come out as values that fail the checks, never an exception', () => {
  for (const p of [undefined, null, 7, 'x', [], {}, { t: 'old message' }, { u: 'short' }, { u: 12 }, { u: 'A'.repeat(23) }, { u: 'A'.repeat(21) + '+' }]) {
    assert.equal(BD.bindingOf(p), undefined, JSON.stringify(p));
  }
  assert.deepEqual(BD.bindingOf({ t: 'x', ...bound({ r: 'r1', th: 't1', v: 3, sch: 1 }) }), bound({ r: 'r1', th: 't1', v: 3, sch: 1 }));
  const odd = BD.bindingOf({ u: 'AAAAAAAAAAAAAAAAAAAAAA', r: { x: 1 }, th: 'a b', ts: '1800000000000', v: -2, sch: true });
  assert.deepEqual(odd, { u: 'AAAAAAAAAAAAAAAAAAAAAA', r: null, th: null, ts: 0, v: 0 });
  assert.deepEqual(BD.checkBinding(msg(), odd).issues, ['time'], 'a missing time never passes the time check');
  assert.equal(BD.bindingOf({ u: 'AAAAAAAAAAAAAAAAAAAAAA', ts: 1, v: 1e12 }).v, 0, 'an absurd edit count counts as none');
});

test('checkBinding: everything matching is no flag; each check fails on its own', () => {
  const ok = BD.checkBinding(msg({ replyTo: 'r1', threadId: 't1', createdAt: 1_800_000_000_000 + 9 * MIN }), bound({ r: 'r1', th: 't1' }));
  assert.deepEqual(ok, { issues: [], notes: [] }, 'nine minutes off is within the clocks’ slack');
  assert.deepEqual(BD.checkBinding(msg({ createdAt: 1_800_000_000_000 - 9 * MIN }), bound()).issues, []);
  assert.deepEqual(BD.checkBinding(msg({ replyTo: 'r2' }), bound({ r: 'r1' })).issues, ['reply'], 'moved under another reply');
  assert.deepEqual(BD.checkBinding(msg({ replyTo: 'r2' }), bound()).issues, ['reply'], 'made into a reply');
  assert.deepEqual(BD.checkBinding(msg({ threadId: 't2' }), bound({ th: 't1' })).issues, ['thread'], 'moved to another thread');
  assert.deepEqual(BD.checkBinding(msg({ threadId: 't2' }), bound()).issues, ['thread'], 'moved into a thread');
  assert.deepEqual(BD.checkBinding(msg({ createdAt: 1_800_000_000_000 + 11 * MIN }), bound()).issues, ['time'], 're-dated later');
  assert.deepEqual(BD.checkBinding(msg({ createdAt: 1_800_000_000_000 - 3 * HOUR }), bound()).issues, ['time'], 're-dated earlier');
  assert.deepEqual(BD.checkBinding(msg(), bound(), { copies: 2 }).issues, ['repeated']);
  assert.deepEqual(BD.checkBinding(msg(), bound({ v: 1 }), { top: 2 }).issues, ['older']);
  assert.deepEqual(BD.checkBinding(msg(), bound({ v: 2 }), { top: 2 }).issues, [], 'the newest version seen is fine');
  const all = BD.checkBinding(msg({ replyTo: 'x', threadId: 'y', createdAt: 5 }), bound(), { copies: 3, top: 4 });
  assert.deepEqual(all.issues, ['reply', 'thread', 'time', 'repeated', 'older']);
  // The details name each check in plain words.
  const lines = BD.describe(all.issues, { m: msg({ replyTo: 'x', threadId: 'y', createdAt: 1_800_000_000_000 - 3 * HOUR }), b: bound(), copies: 3, top: 4 });
  assert.equal(lines.length, 5);
  assert.match(lines[0], /didn’t write it as a reply/);
  assert.match(lines[1], /not in a thread/);
  assert.match(lines[2], /shown about 3 hours earlier/);
  assert.match(lines[3], /3 times/);
  assert.match(lines[4], /already shown edit 4, and this is the original/);
});

test('checkBinding: a reply whose original is gone is a note, not a flag, unless the original is still there; a thread reply outside its thread always is', () => {
  // Replied to a message that was deleted (or disappeared) before this one was posted: the server rightly drops the
  // reply (replyIn), and the app says "Original message is no longer available".
  const gone = BD.checkBinding(msg({ replyTo: null }), bound({ r: 'r1' }), { present: () => false });
  assert.deepEqual(gone, { issues: [], notes: ['replyGone'] });
  // The original is loaded here and alive, or the server can still find it (createOriginals): the server took the
  // reply away.
  assert.deepEqual(BD.checkBinding(msg({ replyTo: null }), bound({ r: 'r1' }), { present: (id) => id === 'r1' }).issues, ['reply']);
  // This server never shows a thread reply outside its thread (the first message takes its replies with it), so
  // whether or not the thread's first message is loaded, that one was moved. (The recorded design had a "thread gone"
  // note here too; on this server it has no honest cause.)
  assert.deepEqual(BD.checkBinding(msg({ threadId: null }), bound({ th: 't1' }), { present: () => false }), { issues: ['thread'], notes: [] });
  assert.deepEqual(BD.checkBinding(msg({ threadId: null }), bound({ th: 't1' }), { present: (id) => id === 't1' }).issues, ['thread']);
  // The server keeps a reply's id when its original is deleted later (m.reply is then null): that matches.
  assert.deepEqual(BD.checkBinding(msg({ replyTo: 'r1', reply: null }), bound({ r: 'r1' })), { issues: [], notes: [] });
});

test('checkBinding: a scheduled message may go out up to a day late (server down, slow mode), never early', () => {
  const due = 1_800_000_000_000;
  const at = (late) => BD.checkBinding(msg({ createdAt: due + late }), bound({ ts: due, sch: 1 })).issues;
  assert.deepEqual(at(0), []);
  assert.deepEqual(at(6 * HOUR), [], 'slow mode or a server that was down for hours');
  assert.deepEqual(at(24 * HOUR + 9 * MIN), [], 'the server’s own one-day limit, plus the clocks’ slack');
  assert.deepEqual(at(24 * HOUR + 11 * MIN), ['time']);
  assert.deepEqual(at(-9 * MIN), []);
  assert.deepEqual(at(-11 * MIN), ['time'], 'posted before its time');
  assert.deepEqual(BD.checkBinding(msg({ createdAt: due + 6 * HOUR }), bound({ ts: due })).issues, ['time'], 'only a scheduled one gets the day');
});

test('versions: the highest edit per message survives a reload, per account, bounded; storage that throws changes nothing', () => {
  const st = memStorage();
  let who = 'me1';
  const v1 = BD.createVersions(st, () => (who ? 'hearth.msgv.' + who : ''), { max: 3 });
  assert.equal(v1.top('alice', 'u1'), -1);
  v1.see('alice', 'u1', 0);
  assert.equal(st.map.size, 0, 'an original has nothing older: nothing is stored');
  v1.see('alice', 'u1', 2);
  v1.see('alice', 'u1', 1);
  assert.equal(v1.top('alice', 'u1'), 2, 'never goes down');
  assert.equal(v1.top('bob', 'u1'), -1, 'per author: someone can’t mark another person’s message as edited');
  const v2 = BD.createVersions(st, () => 'hearth.msgv.me1');
  assert.equal(v2.top('alice', 'u1'), 2, 'kept across a reload');
  who = 'me2';
  assert.equal(v1.top('alice', 'u1'), -1, 'each account on this device has its own');
  who = 'me1';
  for (const u of ['u2', 'u3', 'u4']) v1.see('alice', u, 1);
  assert.equal(v1.top('alice', 'u1'), -1, 'the oldest goes once it’s full');
  assert.equal(v1.top('alice', 'u4'), 1);
  who = '';
  v1.see('alice', 'u9', 5);
  assert.equal(v1.top('alice', 'u9'), -1, 'signed out: nothing kept');
  const broken = BD.createVersions({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } }, () => 'k');
  broken.see('alice', 'u1', 3);
  assert.equal(broken.top('alice', 'u1'), 3, 'storage off (a private window): kept for this session');
  const junk = memStorage();
  junk.setItem('k', '{"not":"a list"}');
  assert.equal(BD.createVersions(junk, () => 'k').top('a', 'u'), -1);
});

test('versions: one account editing a flood of messages pushes out its own entries, not other people’s', () => {
  const st = memStorage();
  const v = BD.createVersions(st, () => 'k', { max: 50 });
  v.see('alice', 'AAAAAAAAAAAAAAAAAAAAAA', 2); // the reader saw Alice's second edit
  v.see('bob', 'BBBBBBBBBBBBBBBBBBBBBB', 1);
  // A sock puppet (the server's operator can make accounts) edits 500 messages once each.
  for (let i = 0; i < 500; i++) v.see('mallory', BD.newUid(), 1);
  const after = BD.createVersions(st, () => 'k', { max: 50 }); // after a reload
  assert.equal(after.top('alice', 'AAAAAAAAAAAAAAAAAAAAAA'), 2, 'Alice’s edit is still remembered');
  assert.equal(after.top('bob', 'BBBBBBBBBBBBBBBBBBBBBB'), 1);
  assert.deepEqual(BD.checkBinding(msg(), bound({ v: 1 }), { top: after.top('alice', 'AAAAAAAAAAAAAAAAAAAAAA') }).issues, ['older'], 'so serving her first edit is still flagged');
  assert.equal(JSON.parse(st.getItem('k')).length, 50, 'still bounded');
  // With everyone even, the oldest entry of the biggest goes first.
  const w = BD.createVersions(memStorage(), () => 'k', { max: 3 });
  w.see('a', 'u1', 1); w.see('b', 'u2', 1); w.see('a', 'u3', 1); w.see('c', 'u4', 1);
  assert.deepEqual([w.top('a', 'u1'), w.top('b', 'u2'), w.top('a', 'u3'), w.top('c', 'u4')], [-1, 1, 1, 1]);
});

test('copies: a deleted copy stops counting, and what’s left is drawn again; originals: asked once, found or gone', async () => {
  const c = BD.createCopies();
  c.add('c:c1', 'alice', 'u1', 'm1');
  c.add('c:c1', 'alice', 'u1', 'm2');
  c.add('c:c1', 'alice', 'u2', 'm3');
  c.add('c:c2', 'alice', 'u1', 'm1');
  assert.equal(c.count('c:c1', 'alice', 'u1'), 2);
  // A moderator deletes the replayed copy: the original left behind is redrawn, no longer "repeated".
  assert.deepEqual(c.drop('c:c1', new Set(['m2'])), ['m1']);
  assert.equal(c.count('c:c1', 'alice', 'u1'), 1);
  assert.equal(c.count('c:c2', 'alice', 'u1'), 1, 'other conversations are left alone');
  assert.deepEqual(c.drop('c:c1', ['m3']), [], 'the only copy gone: nothing to redraw');
  assert.equal(c.count('c:c1', 'alice', 'u2'), 0);

  const asked = [];
  const answers = { here: true, gone: false };
  const o = BD.createOriginals(async (id) => { asked.push(id); if (id === 'offline') throw new Error('no connection'); return answers[id]; });
  let found = 0;
  o.ask('here', () => found++);
  o.ask('here', () => found++);
  o.ask('gone', () => found++);
  o.ask('offline', () => found++);
  o.ask('../bad id', () => found++);
  assert.equal(o.found('here'), false, 'not before the answer: an unanswered question never flags');
  await H.sleep(10);
  assert.deepEqual(asked, ['here', 'gone', 'offline'], 'once each, real ids only');
  assert.equal(found, 1);
  assert.deepEqual([o.found('here'), o.found('gone'), o.found('offline')], [true, false, false]);
  o.ask('offline');
  await H.sleep(10);
  assert.deepEqual(asked.slice(3), ['offline'], 'no answer: asked again the next time');
});

test('the app’s side: copies are counted per conversation, an untrusted message is neither checked nor remembered', () => {
  const stores = { versions: BD.createVersions(memStorage(), () => 'k'), copies: BD.createCopies() };
  const b = bound({ v: 1 });
  const m1 = msg({ id: 'm1', dec: { t: 'x', b, verified: true } });
  assert.deepEqual(BD.noteMessage(m1, 'c:c1', stores), [], 'first time seen: nothing else to redraw');
  assert.deepEqual(BD.noteMessage(m1, 'c:c1', stores), [], 'seen again (a re-render, the pins list): still one copy');
  const m2 = msg({ id: 'm2', dec: { t: 'x', b, verified: true } });
  assert.deepEqual(BD.noteMessage(m2, 'c:c1', stores), ['m1'], 'a second id: the first copy is redrawn with the flag');
  assert.deepEqual(BD.bindingState(m1, 'c:c1', stores).issues, ['repeated']);
  assert.deepEqual(BD.noteMessage(msg({ id: 'm3', dec: { t: 'x', b, verified: true } }), 'c:c2', stores), [], 'another conversation is counted on its own');
  // A newer edit makes an already loaded copy the older one: it's redrawn too.
  const newer = msg({ id: 'm4', dec: { t: 'y', b: bound({ v: 2 }), verified: true } });
  assert.deepEqual(BD.noteMessage(newer, 'c:c1', stores).sort(), ['m1', 'm2']);
  assert.deepEqual(BD.bindingState(m1, 'c:c1', stores).issues, ['repeated', 'older']);
  // A channel message that didn't verify (anyone with the server key could have written it), one opened only with a
  // key the server merely lists, one that didn't decrypt: no binding state, nothing remembered.
  for (const dec of [{ b: bound({ u: 'BBBBBBBBBBBBBBBBBBBBBB', v: 9 }), verified: false }, { b: bound({ u: 'BBBBBBBBBBBBBBBBBBBBBB', v: 9 }), keyNote: 'listed', verified: false }, { error: true, b: bound({ u: 'BBBBBBBBBBBBBBBBBBBBBB', v: 9 }) }]) {
    const m = msg({ id: 'mx', dec });
    assert.deepEqual(BD.noteMessage(m, 'c:c1', stores), []);
    assert.equal(BD.bindingState(m, 'c:c1', stores), null);
  }
  assert.equal(stores.versions.top('alice', 'BBBBBBBBBBBBBBBBBBBBBB'), -1);
  const dmListed = msg({ id: 'd1', dmId: 'd', dec: { b: bound({ u: 'CCCCCCCCCCCCCCCCCCCCCC' }), keyNote: 'listed' } });
  assert.equal(BD.bindingState(dmListed, 'd:d', stores), null);
  // A DM opened only with a new key this device hasn't verified (the server may have swapped it): not checked, and
  // nothing it says is remembered.
  const dmNew = msg({ id: 'd3', dmId: 'd', dec: { b: bound({ u: 'DDDDDDDDDDDDDDDDDDDDDD', v: 999999 }), keyNote: 'new' } });
  assert.deepEqual(BD.noteMessage(dmNew, 'd:d', stores), []);
  assert.equal(BD.bindingState(dmNew, 'd:d', stores), null);
  assert.equal(stores.versions.top('alice', 'DDDDDDDDDDDDDDDDDDDDDD'), -1);
  assert.ok(BD.bindingState(msg({ id: 'd4', dmId: 'd', dec: { b: bound({ u: 'DDDDDDDDDDDDDDDDDDDDDD' }), keyNote: 'pinned' } }), 'd:d', stores), 'a key this device pinned back then is trusted');
  assert.ok(BD.bindingState(msg({ id: 'd2', dmId: 'd', dec: { b: bound({ u: 'CCCCCCCCCCCCCCCCCCCCCC' }) } }), 'd:d', stores), 'a DM that opened with a trusted key is checked (DMs aren’t signed)');
  assert.equal(BD.bindingState(msg({ dec: { t: 'old app' }, }), 'c:c1', stores), null, 'no u: an older app’s message is never flagged');
});

// What secure.js kept before this item, for the old-reader check below.
async function people() {
  const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const a = await E.createIdentity(wrapKey);
  const b = await E.createIdentity(wrapKey);
  const sk = await E.createSigningKey(a.privateKey, a.publicKey);
  return { a: { ...a, ...sk, id: 'alice-1' }, b: { ...b, id: 'bob-1' } };
}

test('older apps still read a bound message, and the longest message with a full link preview still fits', async () => {
  const { a, b } = await people();
  const raw = E.newGroupKey();
  const url = 'https://news.example-site.net/a';
  const card = { v: 1, url, title: 'T'.repeat(200), desc: 'D'.repeat(300), site: 'S'.repeat(60), kind: 'web', img: { type: 'image/jpeg', data: Buffer.alloc(16384, 7).fill(0xff, 0, 1).fill(0xd8, 1, 2).fill(0xff, 2, 3).toString('base64'), w: 400, h: 210 } };
  const payload = { t: `${url} ${'x'.repeat(3965)}`, f: [], x: 3600, l: [card], ...BD.bindNew({ replyTo: 'r1', at: Date.now() }) };
  const group = (p) => E.encryptGroup({ raw, serverId: 's1', channelId: 'c1', epoch: 1, authorId: a.id, signKey: a.signKey, payload: p });
  const dm = (p) => E.encryptDm({ myPriv: a.privateKey, theirPub: b.publicKey, dmId: 'd1', authorId: a.id, payload: p });
  for (const enc of [group, dm]) {
    let out; let used;
    for (const p of LP.payloadVariants(payload)) { out = await enc(p); used = p; if (out.length <= 64000) break; }
    assert.ok(out.length <= 64000, `${out.length} characters`);
    assert.ok(used.l && used.l[0].img, 'the whole preview still fits beside the binding');
    assert.equal(used.u, payload.u, 'every smaller variant keeps where it belongs');
  }
  const text = await group(payload);
  const { payload: opened, verified } = await E.decryptGroup({ raw, serverId: 's1', channelId: 'c1', authorId: a.id, authorSignPub: a.signPublicKey, text });
  assert.equal(verified, true, 'covered by the sender’s signature with the rest');
  // What an app from before this keeps (secure.js openGroup then): the text, files, poll, timer and preview, as before.
  const old = { t: String(opened.t || ''), f: A.cleanFiles(opened.f), x: opened.x };
  assert.deepEqual(old, { t: payload.t, f: [], x: 3600 });
  assert.deepEqual(BD.bindingOf(opened), { u: payload.u, r: 'r1', th: null, ts: payload.ts, v: 0 });
});

// ------------------------------------------------------------------ against a real server
const as = (u, m, p, body) => srv.api(m, p, { token: u.token, ip: u.ip, body });
async function uploadSignKey(p, sk) {
  const ch = (await as(p, 'POST', '/me/sign-key/challenge')).json;
  const keyProof = await E.signKeyProof(p.privateKey, ch.serverPublicKey, ch.nonce, p.id, sk.signPublicKey);
  const signature = await E.sign(sk.signKey, `hearth-sign-key|${p.id}|${p.publicKey}|${ch.nonce}`);
  return as(p, 'POST', '/me/sign-key', { signPublicKey: sk.signPublicKey, encSignPrivateKey: sk.encSignPrivateKey, nonce: ch.nonce, keyProof, signature });
}
// A person registered the way the app does it (real password hashing and keys).
async function person(base) {
  const name = `${base}${H.hex(3)}`;
  const kdfSalt = E.newKdfSalt();
  const { authKey, wrapKey } = await E.deriveKeys(name, `pw-${name}`, { kdf: 'argon2id', salt: kdfSalt });
  const id = await E.createIdentity(wrapKey);
  const ip = H.newIp();
  const r = await srv.api('POST', '/auth/register', { ip, body: { username: name, authKey, kdfSalt, publicKey: id.publicKey, encPrivateKey: id.encPrivateKey, acceptTos: srv.config.termsVersion || undefined } });
  assert.equal(r.status, 200, r.text);
  const p = { username: name, ip, token: r.json.token, id: r.json.user.id, ...id };
  const sk = await E.createSigningKey(id.privateKey, id.publicKey);
  Object.assign(p, sk);
  assert.equal((await uploadSignKey(p, sk)).status, 200);
  return p;
}
// A server with its first key (made by the owner's app), and everyone in it.
async function serverWith(owner, others) {
  const s = (await as(owner, 'POST', '/servers', { name: 'bind' })).json;
  const code = (await as(owner, 'POST', `/servers/${s.id}/invites`, {})).json.code;
  for (const u of others) assert.equal((await as(u, 'POST', `/invites/${code}/join`, {})).status, 200);
  const raw = await keyFor(owner, s.id, [owner, ...others]);
  return { s, ch: s.channels.find((c) => c.type === 'text').id, raw };
}
async function keyFor(by, serverId, members, epoch = 1) {
  const raw = E.newGroupKey();
  const wraps = {}; const pubs = {};
  for (const u of members) {
    wraps[u.id] = await E.wrapGroupKey({ raw, serverId, epoch, recipientId: u.id, recipientPub: u.publicKey, wrapperId: by.id, signKey: by.signKey });
    pubs[u.id] = u.publicKey;
  }
  const r = await as(by, 'POST', `/servers/${serverId}/keys/rotate`, { epoch, check: await E.keyCheck(raw, serverId, epoch), wraps, pubs });
  assert.equal(r.status, 200, r.text);
  return raw;
}
// The app's start-up on one device (app.js loadBootstrap), with that device's pins.
async function device(user) {
  store = new Map(); curIp = user.ip; API.setToken(user.token);
  const boot = (await as(user, 'GET', '/bootstrap')).json;
  const S = { me: boot.me, users: boot.users, servers: boot.servers, dms: boot.dms, privateKey: user.privateKey, e2eeSince: boot.e2eeSince };
  const sec = createSecure({ S });
  await sec.ensureSigningKey(boot.encSignPrivateKey);
  Object.values(S.users).forEach((u) => sec.trust(u));
  for (const st of Object.values(boot.keyStates || {})) await sec.applyState(st);
  return { sec, S, versions: BD.createVersions(memStorage(), () => 'hearth.msgv.' + user.id) };
}
// Sends a channel message the way the app does (app.js sendOnce): the payload with where it belongs inside.
async function sendC(u, sid, ch, raw, t, { replyTo = null, threadId = null, at = Date.now(), bind = true } = {}) {
  const b = bind ? BD.bindNew({ replyTo, threadId, at }) : null;
  const payload = { t, f: [], ...(b || {}) };
  const ciphertext = await E.encryptGroup({ raw, serverId: sid, channelId: ch, epoch: 1, authorId: u.id, signKey: u.signKey, payload });
  const r = await as(u, 'POST', `/channels/${ch}/messages`, { ciphertext, epoch: 1, replyTo, threadId });
  assert.equal(r.status, 200, r.text);
  return { id: r.json.id, b, payload, ciphertext };
}
// An edit the way the app makes one (app.js editBox): same id, place and time, one version later.
async function editC(u, sid, ch, raw, sent, t) {
  const payload = { ...sent.payload, t, ...BD.bindEdit(sent.b) };
  const ciphertext = await E.encryptGroup({ raw, serverId: sid, channelId: ch, epoch: 1, authorId: u.id, signKey: u.signKey, payload });
  const r = await as(u, 'PATCH', `/messages/${sent.id}`, { ciphertext, epoch: 1 });
  assert.equal(r.status, 200, r.text);
  return { ...sent, b: BD.bindingOf(payload), payload, ciphertext };
}
// What a reader's app shows for a page of messages (app.js decryptMessage + bindingOfMessage): per id, the issues
// and notes, or null for a message with nothing to check. A fresh page load each time (a new copies index), with
// this device's stored versions. lookup: as the app does, a reply shown without an original that isn't loaded asks
// the server whether that original is still there (GET /messages/:id/locate), and is drawn again once it knows.
async function view(dev, conv, list, { lookup = false } = {}) {
  const stores = { versions: dev.versions, copies: BD.createCopies() };
  for (const m of list) {
    if (m.dmId) await dev.sec.decryptDmMessage(m); else await dev.sec.decryptChannelMessage(m);
    BD.noteMessage(m, conv, stores);
  }
  const originals = BD.createOriginals(async (id) => {
    try { await API.api('GET', `/messages/${encodeURIComponent(id)}/locate`); return true; } catch (e) {
      if (e.status === 404 || e.status === 403) return false;
      throw e;
    }
  });
  const present = (id) => list.some((x) => x.id === id) || originals.found(id);
  const draw = () => {
    const out = {};
    for (const m of list) { const st = BD.bindingState(m, conv, { ...stores, present }); out[m.id] = st && { issues: st.issues, notes: st.notes }; }
    return out;
  };
  const out = draw();
  if (!lookup) return out;
  await Promise.all(list.filter((m) => out[m.id] && out[m.id].notes.includes('replyGone')).map((m) => originals.ask(m.dec.b.r)));
  return draw();
}
const channelPage = async (u, ch) => (await as(u, 'GET', `/channels/${ch}/messages`)).json.messages;
const threadPage = async (u, root) => { const r = (await as(u, 'GET', `/messages/${root}/thread`)).json; return [r.root, ...r.messages]; };
const dmPage = async (u, dmId) => (await as(u, 'GET', `/dms/${dmId}/messages`)).json.messages;
const CLEAN = { issues: [], notes: [] };
const newId = () => Date.now().toString(36).padStart(9, '0') + H.hex(5);

test('channel: moved under another reply, out of one, re-dated, replayed and rolled back are each flagged; a reply to a deleted message is not', async () => {
  const alice = await person('alice'); const bob = await person('bob');
  const { s, ch, raw } = await serverWith(alice, [bob]);
  const root = await sendC(alice, s.id, ch, raw, 'first');
  const other = await sendC(alice, s.id, ch, raw, 'second');
  const reply = await sendC(bob, s.id, ch, raw, 'a reply to the first', { replyTo: root.id });
  const later = await sendC(bob, s.id, ch, raw, 'later');
  const drafted = await sendC(alice, s.id, ch, raw, 'draft words');
  const edited = await editC(alice, s.id, ch, raw, drafted, 'final words');
  const old = await sendC(alice, s.id, ch, raw, 'from an older app', { bind: false });
  const dev = await device(bob);
  let seen = await view(dev, `c:${ch}`, await channelPage(bob, ch));
  for (const id of [root.id, other.id, reply.id, later.id, edited.id]) assert.deepEqual(seen[id], CLEAN, 'nothing flagged while nothing was touched');
  assert.equal(seen[old.id], null, 'no u: nothing to check');
  assert.equal(dev.versions.top(alice.id, edited.b.u), 1, 'the edit was noted');

  // The server moves a reply under another message, makes a message into a reply and re-dates another.
  srv.sql('UPDATE messages SET reply_to = ? WHERE id = ?', other.id, reply.id);
  srv.sql('UPDATE messages SET reply_to = ? WHERE id = ?', root.id, later.id);
  srv.sql('UPDATE messages SET created_at = created_at - ? WHERE id = ?', 3 * HOUR, other.id);
  // Another message's words under this one's id: the same message twice.
  const scratch = await sendC(alice, s.id, ch, raw, 'scratch');
  srv.sql('UPDATE messages SET ciphertext = ? WHERE id = ?', scratch.ciphertext, root.id);
  // Rolled back: the words from before the edit, served again.
  srv.sql('UPDATE messages SET ciphertext = ? WHERE id = ?', drafted.ciphertext, edited.id);
  // Replayed: the same ciphertext posted again under a new id (a copy of the row).
  const copyId = newId();
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, reply_to, created_at, thread_id) SELECT ?, channel_id, author_id, body, ciphertext, epoch, reply_to, created_at, thread_id FROM messages WHERE id = ?', copyId, old.id);
  const copy2 = newId();
  srv.sql('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, reply_to, created_at, thread_id) SELECT ?, channel_id, author_id, body, ciphertext, epoch, reply_to, ?, thread_id FROM messages WHERE id = ?', copy2, Date.now() + 1000, later.id);

  seen = await view(dev, `c:${ch}`, await channelPage(bob, ch));
  assert.deepEqual(seen[reply.id].issues, ['reply'], 'moved under another message');
  assert.deepEqual(seen[later.id].issues, ['reply', 'repeated'], 'made into a reply, and replayed');
  assert.deepEqual(seen[copy2].issues, ['reply', 'repeated'], 'the replayed copy is flagged too');
  assert.deepEqual(seen[other.id].issues, ['time'], 're-dated');
  assert.deepEqual([seen[root.id].issues, seen[scratch.id].issues], [['repeated'], ['repeated']], 'another message’s words under this id');
  assert.deepEqual(seen[edited.id].issues, ['older'], 'served from before the edit');
  assert.equal(seen[copyId], null, 'an older app’s message, copied: nothing to check, so no flag (a stated limit)');

  // A reply whose original was deleted before it was posted: the server leaves the reply out, and that's no flag.
  const still = await sendC(alice, s.id, ch, raw, 'still here, further up');
  const answer = await sendC(bob, s.id, ch, raw, 'answering it', { replyTo: still.id });
  const doomed = await sendC(alice, s.id, ch, raw, 'about to go');
  assert.equal((await as(alice, 'DELETE', `/messages/${doomed.id}`)).status, 200);
  const orphan = await sendC(bob, s.id, ch, raw, 'replying to something just deleted', { replyTo: doomed.id });
  const row = srv.sql('SELECT reply_to FROM messages WHERE id = ?', orphan.id)[0];
  assert.equal(row.reply_to, null, 'the server dropped the reply (replyIn)');
  // And one whose original goes after it was posted: the server keeps its id; the app says the original is gone.
  const target = await sendC(alice, s.id, ch, raw, 'deleted later');
  const keeps = await sendC(bob, s.id, ch, raw, 'reply kept', { replyTo: target.id });
  assert.equal((await as(alice, 'DELETE', `/messages/${target.id}`)).status, 200);
  const fresh = await device(bob);
  seen = await view(fresh, `c:${ch}`, await channelPage(bob, ch), { lookup: true });
  assert.deepEqual(seen[orphan.id], { issues: [], notes: ['replyGone'] }, 'asked, the server can’t find its original either');
  assert.deepEqual(seen[keeps.id], CLEAN);
  assert.deepEqual(seen[answer.id], CLEAN);
  assert.deepEqual(seen[edited.id].issues, [], 'a new device never saw the edit: a rollback can’t be told (a stated limit)');
  // The server drops the reply from a message whose original is still there but not loaded (further up than the page
  // the reader has open). Before asking it reads as "no longer available"; the server's own lookup finds the original,
  // so it's flagged. (To pass it off, the server would have to deny that message everywhere.)
  srv.sql('UPDATE messages SET reply_to = NULL WHERE id = ?', answer.id);
  const page = (await channelPage(bob, ch)).filter((m) => m.id !== still.id);
  assert.deepEqual((await view(fresh, `c:${ch}`, page))[answer.id], { issues: [], notes: ['replyGone'] });
  seen = await view(fresh, `c:${ch}`, page, { lookup: true });
  assert.deepEqual(seen[answer.id], { issues: ['reply'], notes: [] });
  assert.deepEqual(seen[orphan.id], { issues: [], notes: ['replyGone'] });
});

test('threads: a reply taken out of its thread or a message put into one is flagged, whether or not its first message is loaded', async () => {
  const alice = await person('alice'); const bob = await person('bob');
  const { s, ch, raw } = await serverWith(alice, [bob]);
  const root = await sendC(alice, s.id, ch, raw, 'thread start');
  const inThread = await sendC(bob, s.id, ch, raw, 'in the thread', { threadId: root.id });
  const second = await sendC(bob, s.id, ch, raw, 'also in the thread', { threadId: root.id });
  const main = await sendC(alice, s.id, ch, raw, 'in the channel');
  const dev = await device(bob);
  let seen = await view(dev, `c:${ch}`, await threadPage(bob, root.id));
  assert.deepEqual([seen[root.id], seen[inThread.id], seen[second.id]], [CLEAN, CLEAN, CLEAN]);
  srv.sql('UPDATE messages SET thread_id = NULL WHERE id = ?', inThread.id);
  srv.sql('UPDATE messages SET thread_id = ? WHERE id = ?', root.id, main.id);
  seen = await view(dev, `c:${ch}`, [...await channelPage(bob, ch), ...await threadPage(bob, root.id)]);
  assert.deepEqual(seen[inThread.id].issues, ['thread'], 'taken out of the thread while its first message is right here');
  assert.deepEqual(seen[main.id].issues, ['thread'], 'put into a thread');
  // Taken out of its thread while the thread's first message isn't loaded (an older thread, further up than the page
  // the reader has open): flagged all the same.
  srv.sql('UPDATE messages SET thread_id = NULL WHERE id = ?', second.id);
  seen = await view(dev, `c:${ch}`, (await channelPage(bob, ch)).filter((m) => m.id !== root.id));
  assert.deepEqual(seen[second.id], { issues: ['thread'], notes: [] });
  // There's no honest way to a thread reply outside its thread: deleting the first message takes its replies with
  // it, and a reply to a thread that's gone is refused.
  const third = await sendC(bob, s.id, ch, raw, 'third in the thread', { threadId: root.id });
  assert.equal((await as(alice, 'DELETE', `/messages/${root.id}`)).status, 200);
  assert.deepEqual(srv.sql('SELECT id FROM messages WHERE id IN (?, ?)', root.id, third.id), []);
  const payload = { t: 'too late', f: [], ...BD.bindNew({ threadId: root.id, at: Date.now() }) };
  const ciphertext = await E.encryptGroup({ raw, serverId: s.id, channelId: ch, epoch: 1, authorId: bob.id, signKey: bob.signKey, payload });
  assert.equal((await as(bob, 'POST', `/channels/${ch}/messages`, { ciphertext, epoch: 1, threadId: root.id })).status, 404);
});

test('voice channel chats and group chats get the same checks', async () => {
  const alice = await person('alice'); const bob = await person('bob');
  const { s, raw } = await serverWith(alice, [bob]);
  const vc = (await as(alice, 'POST', `/servers/${s.id}/channels`, { name: 'hangout', type: 'voice' })).json;
  const a = await sendC(alice, s.id, vc.id, raw, 'in the voice chat');
  const b = await sendC(bob, s.id, vc.id, raw, 'reply in the voice chat', { replyTo: a.id });
  const g = (await as(alice, 'POST', '/groups', { userIds: [bob.id] })).json;
  assert.ok(g.id, JSON.stringify(g));
  const graw = await keyFor(alice, g.id, [alice, bob]);
  const gch = g.channels.find((c) => c.type === 'text').id;
  const ga = await sendC(alice, g.id, gch, graw, 'in the group');
  const gb = await sendC(bob, g.id, gch, graw, 'group reply', { replyTo: ga.id });
  const dev = await device(bob);
  assert.deepEqual(await view(dev, `c:${vc.id}`, await channelPage(bob, vc.id)), { [a.id]: CLEAN, [b.id]: CLEAN });
  assert.deepEqual(await view(dev, `c:${gch}`, await channelPage(bob, gch)), { [ga.id]: CLEAN, [gb.id]: CLEAN });
  srv.sql('UPDATE messages SET created_at = created_at + ? WHERE id = ?', 2 * HOUR, a.id);
  srv.sql('UPDATE messages SET reply_to = NULL WHERE id = ?', gb.id);
  assert.deepEqual((await view(dev, `c:${vc.id}`, await channelPage(bob, vc.id)))[a.id].issues, ['time']);
  assert.deepEqual((await view(dev, `c:${gch}`, await channelPage(bob, gch)))[gb.id].issues, ['reply'], 'reply taken away while the original is here');
});

// A message in the first DM format (v1: the conversation key alone, nothing bound in), the way the oldest apps wrote it.
async function v1Dm(me, theirPubB64, payload) {
  const pub = await crypto.subtle.importKey('spki', Buffer.from(theirPubB64, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, me.privateKey, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('hearth-dm-salt'), info: new TextEncoder().encode('hearth-dm-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  return `v1:${Buffer.from(iv).toString('base64')}:${Buffer.from(ct).toString('base64')}`;
}

test('DMs: moved, re-dated, replayed and rolled back are flagged; the first DM format is marked as such', async () => {
  const alice = await person('alice'); const bob = await person('bob');
  await serverWith(alice, [bob]); // sharing a server lets them message each other
  const dm = (await as(alice, 'POST', '/dms', { userId: bob.id })).json;
  const sendD = async (from, to, t, { replyTo = null, payload: base = null, bind = true } = {}) => {
    const b = bind ? BD.bindNew({ replyTo, at: Date.now() }) : null;
    const payload = base || { t, f: [], ...(b || {}) };
    const ciphertext = await E.encryptDm({ myPriv: from.privateKey, theirPub: to.publicKey, dmId: dm.id, authorId: from.id, payload });
    const r = await as(from, 'POST', `/dms/${dm.id}/messages`, { ciphertext, replyTo });
    assert.equal(r.status, 200, r.text);
    return { id: r.json.id, b, payload, ciphertext };
  };
  const one = await sendD(alice, bob, 'hello');
  const two = await sendD(bob, alice, 'hi back', { replyTo: one.id });
  const three = await sendD(alice, bob, 'third');
  const edited = await sendD(alice, bob, 'typo');
  const editPayload = { ...edited.payload, t: 'fixed', ...BD.bindEdit(edited.b) };
  assert.equal((await as(alice, 'PATCH', `/dm-messages/${edited.id}`, { ciphertext: await E.encryptDm({ myPriv: alice.privateKey, theirPub: bob.publicKey, dmId: dm.id, authorId: alice.id, payload: editPayload }) })).status, 200);
  const legacy = await as(alice, 'POST', `/dms/${dm.id}/messages`, { ciphertext: await v1Dm(alice, bob.publicKey, { t: 'from the very first version' }) });
  assert.equal(legacy.status, 200, legacy.text);
  const dev = await device(bob);
  let page = await dmPage(bob, dm.id);
  let seen = await view(dev, `d:${dm.id}`, page);
  for (const x of [one, two, three, edited]) assert.deepEqual(seen[x.id], CLEAN);
  const lm = page.find((m) => m.id === legacy.json.id);
  assert.equal(lm.dec.t, 'from the very first version');
  assert.equal(lm.dec.legacyFormat, true, 'the app shows “Older encryption format” on it');
  assert.equal(seen[lm.id], null);

  srv.sql('UPDATE dm_messages SET reply_to = ? WHERE id = ?', three.id, two.id);
  srv.sql('UPDATE dm_messages SET created_at = created_at - ? WHERE id = ?', 2 * HOUR, three.id);
  srv.sql('UPDATE dm_messages SET ciphertext = ? WHERE id = ?', edited.ciphertext, edited.id);
  const copyId = newId();
  srv.sql('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, reply_to, created_at) SELECT ?, dm_id, author_id, ciphertext, reply_to, created_at FROM dm_messages WHERE id = ?', copyId, one.id);
  page = await dmPage(bob, dm.id);
  seen = await view(dev, `d:${dm.id}`, page);
  assert.deepEqual(seen[two.id].issues, ['reply']);
  assert.deepEqual(seen[three.id].issues, ['time']);
  assert.deepEqual(seen[edited.id].issues, ['older']);
  assert.deepEqual([seen[one.id].issues, seen[copyId].issues], [['repeated'], ['repeated']]);
});

test('scheduled: at its time, a day late or replying to a message that went first, no flag; the old copy posted early is flagged', async () => {
  const alice = await person('alice'); const bob = await person('bob');
  const { s, ch, raw } = await serverWith(alice, [bob]);
  const draft = () => 'x1:' + H.b64(60);
  const ref = () => H.hex(12);
  // The app's scheduling (app.js sendOnce with sendAt): ts is when it's due, marked scheduled.
  const schedule = async (u, t, { sendAt, at = sendAt, replyTo = null, sch = true }) => {
    const payload = { t, f: [], ...BD.bindNew({ replyTo, at, scheduled: sch }) };
    const ciphertext = await E.encryptGroup({ raw, serverId: s.id, channelId: ch, epoch: 1, authorId: u.id, signKey: u.signKey, payload });
    const r = await as(u, 'POST', `/channels/${ch}/scheduled-messages`, { ciphertext, epoch: 1, ref: ref(), draft: draft(), sendAt, replyTo });
    assert.equal(r.status, 200, r.text);
    return { item: r.json, payload };
  };
  const target = await sendC(bob, s.id, ch, raw, 'will be gone');
  const onTime = await schedule(alice, 'on time', { sendAt: Date.now() + 1500 });
  // Due three hours ago (the server was down): it goes out late, still within the server's one-day limit.
  const late = await schedule(alice, 'three hours late', { sendAt: Date.now() + 1500, at: Date.now() - 3 * HOUR });
  const notSched = await schedule(alice, 'not marked scheduled', { sendAt: Date.now() + 1500, at: Date.now() - 3 * HOUR, sch: false });
  const tooLate = await schedule(alice, 'a day and more late', { sendAt: Date.now() + 1500, at: Date.now() - 25 * HOUR });
  const orphan = await schedule(alice, 'reply to one that goes first', { sendAt: Date.now() + 1500, replyTo: target.id });
  assert.equal((await as(bob, 'DELETE', `/messages/${target.id}`)).status, 200);
  const early = await schedule(alice, 'posted early', { sendAt: Date.now() + 2 * HOUR });
  // Send now the old way (no new copy): the server posts the ciphertext that says it's due in two hours.
  assert.equal((await as(alice, 'POST', `/scheduled-messages/${early.item.id}/send`)).status, 200);
  let page;
  for (let i = 0; i < 100; i++) {
    page = await channelPage(bob, ch);
    if (page.length >= 6) break;
    await H.sleep(100);
  }
  const byText = async () => {
    const dev = await device(bob);
    const seen = await view(dev, `c:${ch}`, page);
    return Object.fromEntries(page.map((m) => [m.dec.t, seen[m.id]]));
  };
  const seen = await byText();
  assert.deepEqual(seen['on time'], CLEAN);
  assert.deepEqual(seen['three hours late'], CLEAN, 'late within a day, as the server allows, is no flag');
  assert.deepEqual(seen['not marked scheduled'].issues, ['time']);
  assert.deepEqual(seen['a day and more late'].issues, ['time']);
  assert.deepEqual(seen['reply to one that goes first'], { issues: [], notes: ['replyGone'] }, 'its original was deleted before it went: no flag');
  assert.deepEqual(seen['posted early'].issues, ['time'], 'two hours before the time it says: flagged (the app re-encrypts for Send now, below)');
  assert.ok(onTime.item.id && late.item.id && notSched.item.id && tooLate.item.id && orphan.item.id);
});

test('Send now with a fresh copy: that copy is the one posted; refused, the scheduled message stays exactly as it was', async () => {
  const alice = await person('alice'); const bob = await person('bob');
  const { s, ch, raw } = await serverWith(alice, [bob]);
  const seal = (u, t, b) => E.encryptGroup({ raw, serverId: s.id, channelId: ch, epoch: 1, authorId: u.id, signKey: u.signKey, payload: { t, f: [], ...b } });
  const sendAt = Date.now() + 2 * HOUR;
  const b0 = BD.bindNew({ at: sendAt, scheduled: true });
  const first = await seal(bob, 'for later', b0);
  const r = await as(bob, 'POST', `/channels/${ch}/scheduled-messages`, { ciphertext: first, epoch: 1, ref: H.hex(12), draft: 'x1:' + H.b64(60), sendAt });
  assert.equal(r.status, 200, r.text);
  const id = r.json.id;
  const row = () => srv.sql('SELECT status, ciphertext, epoch, send_at FROM scheduled_messages WHERE id = ?', id)[0];
  // Re-encrypted the way the app does it (scheduled.js sendNow): same id, ts = now.
  const now = await seal(bob, 'for later', BD.bindScheduled(b0, { at: Date.now() }));
  // Refused: slow mode (bob just wrote), a bad copy, a stale key. Each time the scheduled one stays as it was.
  srv.sql('UPDATE channels SET slowmode = 120 WHERE id = ?', ch);
  await sendC(bob, s.id, ch, raw, 'just now');
  const slow = await as(bob, 'POST', `/scheduled-messages/${id}/send`, { ciphertext: now, epoch: 1 });
  assert.equal(slow.status, 429, slow.text);
  assert.deepEqual(row(), { status: 'pending', ciphertext: first, epoch: 1, send_at: sendAt });
  srv.sql('UPDATE channels SET slowmode = 0 WHERE id = ?', ch);
  const bad = await as(bob, 'POST', `/scheduled-messages/${id}/send`, { ciphertext: 'short', epoch: 1 });
  assert.equal(bad.status, 400);
  const stale = await as(bob, 'POST', `/scheduled-messages/${id}/send`, { ciphertext: now, epoch: 7 });
  assert.equal(stale.status, 409, stale.text);
  assert.deepEqual(row(), { status: 'pending', ciphertext: first, epoch: 1, send_at: sendAt });
  // Someone else's scheduled message can't be sent with a copy of theirs.
  assert.equal((await as(alice, 'POST', `/scheduled-messages/${id}/send`, { ciphertext: now, epoch: 1 })).status, 404);
  const ok = await as(bob, 'POST', `/scheduled-messages/${id}/send`, { ciphertext: now, epoch: 1 });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.message.ciphertext, now, 'the fresh copy went out');
  assert.equal(row(), undefined, 'and the scheduled one is gone');
  const dev = await device(alice);
  const page = await channelPage(alice, ch);
  const seen = await view(dev, `c:${ch}`, page);
  const sent = page.find((m) => m.id === ok.json.message.id);
  assert.equal(sent.dec.t, 'for later');
  assert.deepEqual(seen[sent.id], CLEAN, 'sent now, and it says now: no flag');
  assert.equal(sent.dec.b.u, b0.u, 'the same message it was when scheduled');
});

// The sender's side (public/js/scheduled.js), run here with its screen and network bits replaced by small fakes (as
// in scheduled.test.js). A re-encrypt the app makes by itself (a key changed while one waits) keeps the time in the
// sender's own copy. The server's sendAt never goes inside: otherwise a server could mark a message held and "due
// now", get the sender's open app to re-encrypt it saying "now", and post it a day early with no flag.
let createScheduled = null;
async function loadScheduled() {
  if (createScheduled) return createScheduled;
  const { register } = require('node:module');
  const fakes = {
    './util.js': `export const h = () => ({ append() {}, classList: { add() {} } }); export const clear = (x) => x; export const icon = () => null;
      export const toast = (...a) => globalThis.__sched.toasts.push(a); export const fmtTime = (t) => String(t); export const copyText = async () => {};`,
    './api.js': 'export const api = (...a) => globalThis.__sched.api(...a);',
    './ui.js': 'export const modal = () => ({ box: null, close() {} }); export const menu = () => {}; export const confirmDialog = async () => false; export const showError = () => {}; export const field = () => null;',
    './markdown.js': 'export const linkedUrls = () => [];',
    './disappear.js': 'export const label = (s) => `${s} seconds`;',
  };
  const urls = Object.fromEntries(Object.entries(fakes).map(([k, src]) => [k, 'data:text/javascript,' + encodeURIComponent(src)]));
  register('data:text/javascript,' + encodeURIComponent(`const urls = ${JSON.stringify(urls)};
    export async function resolve(spec, ctx, next) {
      if (ctx.parentURL && ctx.parentURL.endsWith('/public/js/scheduled.js') && urls[spec]) return { url: urls[spec], shortCircuit: true };
      return next(spec, ctx);
    }`));
  ({ createScheduled } = await import(js('scheduled.js')));
  return createScheduled;
}
// One scheduled item as the server describes it (held for a key change unless said otherwise), with the sender's own
// copy; what the app then seals and asks of the server. The copy names its scheduled message (sid), as the composer's
// do once the server has answered (scheduled.js: only those, or ones this device made, are re-encrypted by themselves);
// bound: false leaves that out.
async function senderApp(item, copy, { settle = 400, bound = true } = {}) {
  const make = await loadScheduled();
  const calls = []; const sealed = [];
  globalThis.__sched = {
    toasts: [],
    api: async (method, p, body) => { calls.push({ method, p, body }); return { ...item, status: 'pending', reason: null, ciphertext: body.ciphertext, draft: body.draft }; },
  };
  const sched = make({
    me: () => ({ id: 'u1' }), openDraft: async (it) => (copy && bound ? { ...copy, sid: it.id } : copy),
    sealFor: async (key, payload, keep) => { sealed.push({ payload, keep }); return { ciphertext: 'new-' + sealed.length, epoch: 2, ttl: 0, draft: 'x1:again' }; },
    withKeyRetry: (serverId, fn) => fn(), refreshTimer: async () => {}, placeOf: () => ({ label: '#x', dm: false }), onChange: () => {}, openKey: () => {},
    clock: () => Date.now(),
  });
  sched.onUpdate({ serverId: 's1', channelId: 'c1', dmId: null, threadId: null, replyTo: null, ref: 'a'.repeat(16), draft: 'x1:copy', ttl: 0, files: 0,
    ciphertext: 'old', status: 'held', reason: 'key', id: 'sch1', ...item });
  for (let i = 0; i < settle / 20 && !calls.length; i++) await H.sleep(20);
  return { calls, sealed: sealed.map((x) => x.payload) };
}

test('scheduled, the sender’s app: re-encrypting by itself keeps the time in its own copy; a server that says “due now” gets nothing', async () => {
  const DAY = 24 * HOUR;
  const due = Date.now() + DAY; // when Alice scheduled it for
  const b = BD.bindNew({ replyTo: 'r1', at: due, scheduled: true });
  const copy = { t: 'Happy birthday', f: [], ...b };
  // The server marks it held and says it was due a minute ago: the app doesn't re-encrypt it (nothing to post early).
  let r = await senderApp({ sendAt: Date.now() - MIN }, copy);
  assert.deepEqual([r.calls.length, r.sealed.length], [0, 0], 'no copy saying “now”, no request');
  // The same, due in a few minutes by the server's account (still earlier than the copy says): left for Alice too.
  r = await senderApp({ sendAt: Date.now() + 5 * MIN }, copy);
  assert.deepEqual([r.calls.length, r.sealed.length], [0, 0]);
  // So all the server has is the old ciphertext, which says the real time: posted now, it's flagged.
  assert.deepEqual(BD.checkBinding({ replyTo: 'r1', threadId: null, createdAt: Date.now() }, BD.bindingOf(copy)).issues, ['time']);

  // Held with the right time (a key changed): re-encrypted at once, with the same id, reply and time inside.
  r = await senderApp({ sendAt: due }, copy);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].method, 'PATCH');
  assert.equal(r.calls[0].body.sendNow, true, 'it may go at once if its time has just passed');
  assert.equal(r.calls[0].body.sendAt, undefined, 'the server’s time isn’t changed');
  assert.deepEqual(BD.bindingOf(r.sealed[0]), { ...b, v: 0, sch: 1 });
  assert.equal('sid' in r.sealed[0], false, 'the scheduled message’s id goes inside the sender’s copy only, never the message');
  // The server claims it's due three days later: still re-encrypted with the real time inside, so posting it then is
  // flagged (more than a day late).
  r = await senderApp({ sendAt: due + 3 * DAY }, copy);
  assert.equal(BD.bindingOf(r.sealed[0]).ts, due);
  assert.deepEqual(BD.checkBinding({ replyTo: 'r1', threadId: null, createdAt: due + 3 * DAY }, BD.bindingOf(r.sealed[0])).issues, ['time']);
  // Its time passed a few minutes ago (a key changed just then): it goes at once, still saying when it was due, which
  // readers allow (a scheduled message may be up to a day late).
  const just = BD.bindNew({ at: Date.now() - 4 * MIN, scheduled: true });
  r = await senderApp({ sendAt: just.ts }, { t: 'x', f: [], ...just });
  assert.equal(BD.bindingOf(r.sealed[0]).ts, just.ts, 'not “now”: the app never picks a time by itself');
  assert.deepEqual(BD.checkBinding({ replyTo: null, threadId: null, createdAt: Date.now() }, BD.bindingOf(r.sealed[0])).issues, []);
  // Its time passed hours ago by its own copy: it waits for Alice (Send now or a new time), whatever the server says.
  const old = BD.bindNew({ at: Date.now() - 3 * HOUR, scheduled: true });
  r = await senderApp({ sendAt: Date.now() + HOUR }, { t: 'x', f: [], ...old });
  assert.deepEqual([r.calls.length, r.sealed.length], [0, 0]);
  // A copy from before these fields: re-encrypted as before, but with nothing of the server's (reply, thread, time)
  // signed into it; it reads like a message from an older app.
  r = await senderApp({ sendAt: Date.now() + HOUR, replyTo: 'r2', threadId: null }, { t: 'from before', f: [] });
  assert.equal(r.calls.length, 1);
  assert.equal(BD.bindingOf(r.sealed[0]), undefined);
  for (const k of ['u', 'r', 'th', 'ts', 'v', 'sch']) assert.equal(k in r.sealed[0], false, k);
  // One from a signed-out session, or that doesn't open here, is never re-encrypted by itself.
  r = await senderApp({ sendAt: due, reason: 'session_ended' }, copy);
  assert.equal(r.calls.length, 0);
  // Nor one whose copy opens but doesn't name it (and that this device didn't make): it waits for its sender too.
  r = await senderApp({ sendAt: due }, copy, { bound: false });
  assert.deepEqual([r.calls.length, r.sealed.length], [0, 0]);
  r = await senderApp({ sendAt: due }, null);
  assert.deepEqual([r.calls.length, r.sealed.length], [0, 0]);
});

test('static: both openers hand the binding over, every send and edit carries it, and scheduled messages re-encrypt for Send now and Reschedule', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const secure = read('public', 'js', 'secure.js');
  assert.equal((secure.match(/\.\.\.bindIn\(payload\)/g) || []).length, 2, 'channel and DM messages');
  const app = read('public', 'js', 'app.js');
  const sendOnce = app.slice(app.indexOf('async function sendOnce('), app.indexOf('\n}\n', app.indexOf('async function sendOnce(')));
  assert.match(sendOnce, /bindNew\(\{ replyTo, threadId, at: sendAt \|\| nowServer\(\), scheduled: !!sendAt \}\)/, 'every send, forward and schedule gets a new id');
  const edit = app.slice(app.indexOf('function editBox('), app.indexOf('\nasync function deleteMessage('));
  assert.match(edit, /bindEdit\(m\.dec\.b\)/);
  assert.match(app, /async function decryptMessage\(m\) \{\n[^}]*noteBinding\(m\);\n\}/, 'every decrypted message is noted');
  const fill = app.slice(app.indexOf('function fillMessage('), app.indexOf('\n}\n', app.indexOf('function fillMessage(')));
  assert.match(fill, /bindingFlag\(m, bind\)/);
  assert.doesNotMatch(app.slice(app.indexOf('function bindingFlag('), app.indexOf('\n}\n', app.indexOf('function bindingFlag('))), /html:/, 'the details are text only');
  const sched = read('public', 'js', 'scheduled.js');
  assert.match(sched, /withFresh\(cur, \{ at: clock\(\) \}, async \(body\) => api\('POST', `\/scheduled-messages\/\$\{cur\.id\}\/send`, body\)\)/);
  assert.match(sched.slice(sched.indexOf('async function reschedule('), sched.indexOf('async function reschedule(') + 300), /await reseal\(it, \{ sendAt \}\)/);
  // The time inside a re-encrypted one is the copy's own, one the person just picked, or now for Send now: never the
  // server's sendAt (nor its reply or thread).
  const body = (name) => sched.slice(sched.indexOf(`async function ${name}(`), sched.indexOf('\n  }\n', sched.indexOf(`async function ${name}(`)));
  for (const name of ['sealed', 'reseal']) assert.doesNotMatch(body(name), /it\.sendAt|it\.replyTo/, name);
  assert.match(body('reseal'), /const at = sendAt \|\| \(now \? clock\(\) : null\);/);
  // The tolerance for a scheduled message is the server's own limit for posting one late.
  assert.match(read('server', 'scheduled.js'), /const LATE_LIMIT_MS = 24 \* 3600 \* 1000;/);
  assert.match(read('public', 'js', 'binding.js'), /export const SCHEDULED_LATE = 24 \* 3600 \* 1000;/);
});

// A message the word filter hides is one row with Show (app.js filteredEl), drawn from a full copy kept out of sight.
// Its warnings must reach that row: else a server could put a word from a message it tampered with on its suggested
// list (plain text it serves, applied by default) and every member would see only "Hidden by this server's word
// filter" until they pressed Show. The browser flow ("word filter") checks the same on screen.
test('static: a message the word filter hides keeps its tampering flag and its key and signature warnings', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const fn = (name) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n}\n', app.indexOf(`function ${name}(`)));
  const fill = fn('fillMessage');
  // In the copy, every warning is a .msg-flag.bad or .msg-flag.warn straight on the message's body, outside any blur.
  assert.match(fill, /body\.append\(bindingFlag\(m, bind\)\)/);
  assert.match(fn('bindingFlag'), /class: 'msg-flag warn'/);
  for (const what of ['Older key', 'New key', 'Sender could not be verified']) {
    assert.match(fill, new RegExp(`body\\.append\\(h\\('div', \\{ class: 'msg-flag bad'[^\\n]*${what}`), what);
  }
  // The folded row takes them over from the copy, as they are (the flag's button keeps its details dialog).
  const folded = fn('filteredEl');
  assert.match(folded, /const flags = shadow\.querySelectorAll\(':scope > \.msg-body > \.msg-flag\.bad, :scope > \.msg-body > \.msg-flag\.warn'\);/);
  assert.match(folded, /h\('div', \{ class: 'msg-body' \}, h\('div', \{ class: 'filtered-note' \}[^\n]*\n[^\n]*'Show'\)\), \.\.\.flags\)\)/);
});
