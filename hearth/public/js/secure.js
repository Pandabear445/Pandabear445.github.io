// Per-session key management on top of e2ee.js:
// - unlocks/creates your signing key
// - keeps every server's group keys (epochs) you've been given, verifying who shared them
// - rotates a server's key when someone leaves, and shares the current key with new members
// - encrypts/decrypts channel messages and DMs, and signs/verifies voice handshakes
import * as E2EE from './e2ee.js';
import { api } from './api.js';
import { cleanFiles } from './attachments.js';
import { cleanLinks } from './linkpreview.js';
import { cleanX } from './disappear.js';
import { bindingOf } from './binding.js';

// The news bot's account (server/newsbot.js): the only one that still posts plaintext channel messages.
const NEWS_BOT_ID = 'newsbot00000000000001';

// A poll inside a message: question, 2–10 options, single or multiple choice. Anything else is dropped.
function cleanPoll(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.o)) return undefined;
  const o = p.o.map((x) => String(x || '').slice(0, 100)).filter(Boolean).slice(0, 10);
  if (o.length < 2) return undefined;
  return { q: String(p.q || '').slice(0, 300), o, m: !!p.m };
}

// Marks the server sends only while they're set (server/index.js publicUser: keysReset, deleted, bot).
const ONLY_WHILE_SET = ['keysReset', 'deleted', 'bot'];
// A user object from the server on top of what the app had. A whole one (it always has publicKey) that leaves one of
// those marks out means it's off now (keysReset: they're verified; deleted: the account isn't), so it mustn't linger
// from before: a single record that said "deleted" would otherwise refuse that person's calls until a reload.
export function mergeUser(old, x) {
  const u = { ...(old || {}), ...x };
  if (x && 'publicKey' in x) for (const k of ONLY_WHILE_SET) if (!(k in x)) delete u[k];
  return u;
}

// What the app says when it refused a call connection (app.js callWarning; why from checkSdp, or 'self' from
// voice.js handleSignal).
export function callRefusedText(why, name) {
  if (why === 'key-changed') return `${name}’s security key changed, so their call connection was blocked. Compare safety numbers with them (their profile → Verify encryption) before you talk.`;
  if (why === 'deleted') return `Blocked a call connection in the name of ${name}: that account was deleted, so it can’t be in a call.`;
  if (why === 'no-key') return `Blocked a call connection from ${name}: the server lists no usable security key for them, so it can’t be checked.`;
  if (why === 'lookup-failed') return `Blocked a call connection from ${name}: their security key couldn’t be loaded to check it.`;
  if (why === 'self') return 'Blocked a call connection that claimed to come from your own account. Only the server could have sent it.';
  return `Blocked a voice connection from ${name}: its security signature didn't check out.`;
}
// Why there are no safety numbers to compare with someone (app.js openSafetyNumber), or null when there are: the
// server lists no identity key for them (one that blanked or left it out, a bot, or an account deleted long ago).
export function noSafetyNumbersText(user, name) {
  if (!user || (typeof user.publicKey === 'string' && user.publicKey)) return null;
  return user.deleted ? 'This account was deleted, so there are no safety numbers to compare.'
    : `The server lists no security key for ${name}, so there are no safety numbers to compare. Calls with them stay blocked until it lists their key again.`;
}

export function createSecure({ S, onKeysChanged = () => {}, onKeyWarning = () => {} }) {
  // A link preview the sender put in the message (linkpreview.js cleanLinks), as { l } or nothing at all.
  // Never throws: a bad preview must not make the message itself unreadable.
  const linksIn = (payload) => {
    if (payload.l === undefined) return {};
    try {
      const origin = typeof location !== 'undefined' ? location.host : '';
      const l = cleanLinks(payload.l, String(payload.t || ''), { origin, anyPort: !!(S.config && S.config.linkPreviewAnyPort) });
      return l ? { l } : {};
    } catch { return {}; }
  };
  // Where the message says it belongs (binding.js, crypto-7), as { b } or nothing: the app checks it against what
  // the server says. Never throws either.
  const bindIn = (payload) => {
    try { const b = bindingOf(payload); return b ? { b } : {}; } catch { return {}; }
  };
  const groupKeys = new Map(); // serverId -> Map(epoch -> Uint8Array)
  const states = new Map(); // serverId -> key state from the server
  const waiters = new Map(); // serverId -> [resolve]
  const busy = new Set();
  const warned = new Set();
  const fetching = new Map();
  const generation = new Map(); // serverId -> bumps whenever new keys arrive
  const reported = new Set(); // keys we couldn't unlock and asked to be re-shared
  const rewrapped = new Set(); // `${serverId}|${epoch}`: keys already re-wrapped to ourselves this session
  const unverified = new Set(); // `${serverId}|${epoch}`: keys only a server-listed past key vouched for (reading only)

  // ---------------------------------------------------------------- people + trust
  async function userWithKeys(id) {
    let u = S.users[id];
    if (u && (u.publicKey || u.deleted)) return u;
    if (!fetching.has(id)) fetching.set(id, api('GET', '/users/' + id).then((x) => { S.users[id] = mergeUser(S.users[id], x); return S.users[id]; }).finally(() => fetching.delete(id)));
    u = await fetching.get(id);
    return u;
  }
  // crypto-2: someone whose keys a password reset without their recovery key replaced, and who is still held back in
  // at least one server or group they were in before (nobody there who knew them has verified them yet).
  const awaitingVerify = (user) => !!user && !!user.keysReset;
  // Held back in this server or group: the server keeps its key from them (and won't store one handed to them) until
  // someone here verifies them, so the apps don't try either; their own app says to ask for it. A member's word only
  // counts where they're a member, so someone can be held in one server and not in another: the server's list says
  // which (a state without one falls back on the account-wide mark).
  function isHeld(serverId, id) {
    const st = states.get(serverId);
    if (st && Array.isArray(st.held)) return st.held.includes(id);
    return awaitingVerify(id === S.me.id ? S.me : S.users[id]);
  }
  const heldBack = (serverId, id) => id !== S.me.id && isHeld(serverId, id);
  function trust(user) {
    if (!user || user.id === S.me.id) return true;
    const ok = E2EE.checkPin(S.me.id, user) === 'ok';
    if (!ok && !warned.has(user.id)) { warned.add(user.id); onKeyWarning(user); }
    return ok;
  }
  const keyChanged = (user) => !!user && user.id !== S.me.id && E2EE.checkPin(S.me.id, user) === 'changed';
  // keyChanged for a whole list at once (the member list): a Set of the ids whose keys changed.
  const keysChanged = (users) => E2EE.checkPins(S.me.id, users);
  // false (and nothing trusted) for a record with no identity key: there's nothing to verify.
  function acceptKeys(user) { const ok = E2EE.acceptPin(S.me.id, user); if (ok) warned.delete(user.id); return ok; }
  // Someone's keys to open (which: 'e', identity keys) or check (which: 's', signing keys) what they wrote at
  // `at` (ms; 0 if unknown), best first, each with how far it's trusted:
  //   'now'     their current key, or the one this device pinned for them (the same one unless it changed)
  //   'new'     their current key when it changed and you haven't verified it yet
  //   'pinned'  a key this device trusted for them before they changed keys; only for what was written while
  //             they still had it (when the server says it was replaced, if it says so)
  //   'listed'  a key the server says they had before a password reset, that this device never saw as theirs.
  //             Nothing vouches for it (the server could list a key of its own), so whatever only it opens or
  //             checks out is shown as "older key, not verified", and it never vouches for the key to write with.
  function keysOf(user, which, at = 0) {
    const out = [];
    if (!user) return out;
    const add = (key, trust) => { if (key && !out.some((x) => x.key === key)) out.push({ key, trust }); };
    const field = which === 'e' ? 'publicKey' : 'signPublicKey';
    if (user.id === S.me.id) { if (proven) add(proven[which], 'now'); return out; }
    const changed = keyChanged(user);
    const p = E2EE.pinnedKeys(S.me.id, user, at);
    // A key the server lists counts as theirs only next to the identity key this device pinned for them (pinned on
    // first sight, so that's everyone with keys): never from a record that leaves the identity key out, whatever
    // the pin check made of it.
    if (!changed && p.e && user.publicKey === p.e) add(user[field], 'now');
    if (p[which]) {
      if (!changed) add(p[which], 'now');
      else {
        // Pinned here, but the server now lists other keys for them: theirs until it says they were replaced.
        const gone = E2EE.listedRetiredAt(user, p.e);
        if (!gone || (at > 0 && at <= gone)) add(p[which], 'pinned');
      }
    }
    if (changed) add(user[field], 'new');
    p.old.forEach((k) => add(k[which], 'pinned'));
    E2EE.listedPastKeys(user, at).forEach((k) => add(k[which], 'listed'));
    return out;
  }
  // The signing keys that vouch for what someone signed: their current key (unless it changed and you haven't
  // verified it yet), and for the past (older server keys, messages; past: true) the keys this device trusted for
  // them before, e.g. before they reset their password without a recovery key, for what was written while they
  // had them (`at`: when it was written). Keys the server merely lists for them never vouch for anything.
  function signKeysFor(user, { past = true, at = 0 } = {}) {
    return keysOf(user, 's', at).filter((k) => k.trust === 'now' || (past && k.trust === 'pinned')).map((k) => k.key);
  }

  // ---------------------------------------------------------------- your own keys
  // Your public keys come from the server. Before anything is trusted or locked with them, this device checks
  // they really belong to the private keys it unlocked: your identity key (an ECDH round trip) and your signing
  // key (sign and verify a fresh text). A server that hands out keys of its own as yours could otherwise plant a
  // "current" server key that looks like your own copy, or read whatever you lock for yourself. Checked again
  // whenever the server lists different keys for you; until then, the ones proven last are the ones used.
  let ownCheck = null; // { e, s, signKey, ok }: the check for the keys S.me lists now
  let proven = null; // { e, s }: your public keys as last proven
  function ownKeysOk() {
    const e = S.me && S.me.publicKey;
    const s = S.me && S.me.signPublicKey;
    if (!ownCheck || ownCheck.e !== e || ownCheck.s !== s || ownCheck.signKey !== S.signKey) {
      const signKey = S.signKey;
      const ok = (async () => {
        if (!signKey || !e || !s) return false;
        if (!(await E2EE.ownsPublicKey(S.privateKey, e))) return false;
        const text = `hearth-own-key|${S.me.id}|${E2EE.b64(crypto.getRandomValues(new Uint8Array(16)))}`;
        return E2EE.verify(s, text, await E2EE.sign(signKey, text));
      })().catch(() => false).then((r) => { if (r) proven = { e, s }; return r; });
      ownCheck = { e, s, signKey, ok };
    }
    return ownCheck.ok;
  }
  function ownKeysMismatch() {
    const err = new Error('The keys this server lists for your account aren’t the ones your password unlocks, so nothing was decrypted or sent. Reload the page; if it keeps happening, tell the server’s owner.');
    err.code = 'own_key_mismatch';
    return err;
  }

  // ---------------------------------------------------------------- signing key
  async function ensureSigningKey(encSignPrivateKey) {
    // Your signing key is locked with your public key: that must really be yours before it's used for that.
    if (!(await E2EE.ownsPublicKey(S.privateKey, S.me.publicKey))) throw ownKeysMismatch();
    if (S.me.signPublicKey && encSignPrivateKey) {
      S.signKey = await E2EE.unwrapSigningKey(S.privateKey, S.me.publicKey, encSignPrivateKey);
      if (!(await ownKeysOk())) throw ownKeysMismatch();
      return;
    }
    const k = await E2EE.createSigningKey(S.privateKey, S.me.publicKey);
    try {
      // The server wants proof that this device holds both your identity key and the new signing key.
      const ch = await api('POST', '/me/sign-key/challenge');
      const keyProof = await E2EE.signKeyProof(S.privateKey, ch.serverPublicKey, ch.nonce, S.me.id, k.signPublicKey);
      const signature = await E2EE.sign(k.signKey, `hearth-sign-key|${S.me.id}|${S.me.publicKey}|${ch.nonce}`);
      const me = await api('POST', '/me/sign-key', { signPublicKey: k.signPublicKey, encSignPrivateKey: k.encSignPrivateKey, nonce: ch.nonce, keyProof, signature });
      S.me = { ...S.me, ...me };
      S.users[S.me.id] = { ...S.users[S.me.id], ...me };
      S.signKey = k.signKey;
    } catch (e) {
      if (e.status === 409) throw new Error('Your signing key changed on another device. Reload the page.');
      throw e;
    }
    if (!(await ownKeysOk())) throw ownKeysMismatch();
  }

  // ---------------------------------------------------------------- group keys
  function keysFor(serverId) {
    if (!groupKeys.has(serverId)) groupKeys.set(serverId, new Map());
    return groupKeys.get(serverId);
  }
  // The server says the current key is older than one this app already holds for that server. Only a server
  // that's been rolled back (or is up to something) does that, e.g. to bring back a key a removed member has.
  function rolledBack(serverId) {
    const st = states.get(serverId);
    const held = [...keysFor(serverId).keys()];
    return !!st && !!st.keyEpoch && held.length > 0 && st.keyEpoch < Math.max(...held);
  }
  function currentKey(serverId) {
    const st = states.get(serverId);
    if (!st || st.needsRotation || !st.keyEpoch || rolledBack(serverId) || unverified.has(`${serverId}|${st.keyEpoch}`)) return null;
    const raw = keysFor(serverId).get(st.keyEpoch);
    return raw ? { epoch: st.keyEpoch, raw } : null;
  }
  const stateOf = (serverId) => states.get(serverId) || null;

  async function applyState(st) {
    if (!st) return;
    const heldList = (x) => (Array.isArray(x && x.held) ? [...x.held].sort().join() : '');
    const heldChanged = heldList(states.get(st.serverId)) !== heldList(st); // the member list's shields
    states.set(st.serverId, st);
    const mine = keysFor(st.serverId);
    const server = S.servers.find((s) => s.id === st.serverId);
    let added = false;
    const fresh = []; // keys someone else handed us (re-wrapped to ourselves below)
    for (const k of st.keys || []) {
      const current = k.epoch === st.keyEpoch;
      const tag = `${st.serverId}|${k.epoch}`;
      // Held already. A key held only for reading history (see `unverified`) is looked at again if the server
      // now says it's the one to write with.
      if (mine.has(k.epoch) && !(current && unverified.has(tag))) continue;
      try {
        // A key "newer" than the current one: nobody made it through the server's rotation (only the server
        // itself could have put it there).
        if (k.epoch > st.keyEpoch) throw new Error('untrusted sharer');
        // The key everyone encrypts with now must come from a member. One handed out by someone who isn't in
        // the server (only the server itself could arrange that) is never used.
        const self = k.wrapperId === S.me.id;
        if (current && !st.needsRotation && server && !self && !server.memberIds.includes(k.wrapperId)) throw new Error('untrusted sharer');
        // Our own copy: only if the keys the server lists as ours really are ours (see ownKeysOk).
        if (self && !(await ownKeysOk())) throw new Error('untrusted sharer');
        const wrapper = self ? S.me : await userWithKeys(k.wrapperId);
        if (!self) trust(wrapper); // warns (once) if their key changed
        // The key to encrypt with from now on: only from someone's current, trusted key. Older server keys (for
        // reading history) may also come from keys this device trusted for them before, or, failing that, from a
        // key the server lists as theirs before a reset. Such a key is only ever read with: every message in it
        // is still checked against its own author's keys, and it's never kept as our own copy nor written with.
        const at = Number(k.createdAt) || 0;
        const keys = keysOf(wrapper, 's', at);
        const trusted = keys.filter((x) => x.trust === 'now' || (!current && x.trust === 'pinned')).map((x) => x.key);
        const listed = current ? [] : keys.filter((x) => x.trust === 'listed').map((x) => x.key);
        if (!trusted.length && !listed.length) throw new Error('untrusted sharer');
        const unwrap = (pubs) => E2EE.unwrapGroupKey({
          wrapped: k.wrapped, serverId: st.serverId, epoch: k.epoch, myId: S.me.id, myPriv: S.privateKey,
          wrapperId: k.wrapperId, wrapperSignPub: pubs,
        });
        let raw;
        let onlyListed = false;
        try {
          if (!trusted.length) throw new Error('Key signature did not verify');
          raw = await unwrap(trusted);
        } catch (e) {
          if (!/did not verify/.test(e.message)) throw e;
          if (listed.length) { raw = await unwrap(listed); onlyListed = true; }
          // Signed by a new key of theirs you haven't verified (and none you trusted before): wait for that.
          else if (keyChanged(wrapper)) throw new Error('untrusted sharer');
          else throw e;
        }
        if ((await E2EE.keyCheck(raw, st.serverId, k.epoch)) !== k.check) throw new Error('key check mismatch');
        mine.set(k.epoch, raw);
        if (onlyListed) unverified.add(tag); else unverified.delete(tag);
        added = true;
        generation.set(st.serverId, (generation.get(st.serverId) || 0) + 1);
        if (!self && !onlyListed) fresh.push({ epoch: k.epoch, raw });
      } catch (e) {
        console.warn('Could not unlock a server key', st.serverId, k.epoch, e.message);
        // Locked for keys this account no longer has (or damaged): ask for it to be shared again. Once per
        // key per session, and only the current key (nobody can share an older one again, so the server keeps
        // those). Not for "untrusted sharer": that one waits for you to verify them.
        if (current && e.message !== 'untrusted sharer' && !reported.has(tag)) { reported.add(tag); api('POST', `/servers/${st.serverId}/keys/bad`, { epoch: k.epoch }).catch(() => {}); }
      }
    }
    if (fresh.length) keepForMyself(st.serverId, fresh);
    (waiters.get(st.serverId) || []).forEach((r) => r());
    waiters.delete(st.serverId);
    onKeysChanged(st.serverId, added, heldChanged);
    maintain(st.serverId);
  }

  // Keys someone else handed us are wrapped again to ourselves (signed by us) and stored back in place of the
  // copy we got, once per key. Our history then no longer depends on the sharer keeping their keys: deleting
  // their account or resetting their password can't lock us out of what was said back then.
  const keeping = new Map(); // serverId -> promise of the last upload (so tests and callers can wait for it)
  function keepForMyself(serverId, list) {
    const todo = list.filter((k) => !rewrapped.has(`${serverId}|${k.epoch}`));
    if (!todo.length || !S.signKey || !S.me || !S.me.publicKey) return keeping.get(serverId);
    todo.forEach((k) => rewrapped.add(`${serverId}|${k.epoch}`));
    const job = (async () => {
      // Our public key as the server tells it must really be ours before we wrap every key we hold to it.
      if (!(await ownKeysOk())) throw new Error('our public keys don’t match our private keys');
      for (let i = 0; i < todo.length; i += 100) {
        const wraps = {};
        for (const k of todo.slice(i, i + 100)) {
          wraps[k.epoch] = await E2EE.wrapGroupKey({ raw: k.raw, serverId, epoch: k.epoch, recipientId: S.me.id, recipientPub: S.me.publicKey, wrapperId: S.me.id, signKey: S.signKey });
        }
        await api('POST', `/servers/${serverId}/keys/self`, { wraps });
      }
    })().catch((e) => {
      todo.forEach((k) => rewrapped.delete(`${serverId}|${k.epoch}`)); // tried again on the next start-up
      console.warn('Could not keep a copy of server keys', e.message);
    });
    keeping.set(serverId, job);
    return job;
  }

  function waitForState(serverId, ms) {
    return new Promise((resolve) => {
      const list = waiters.get(serverId) || [];
      list.push(resolve);
      waiters.set(serverId, list);
      setTimeout(resolve, ms);
    });
  }

  // Keep a server's keys healthy: rotate if needed, hand the current key to anyone missing it.
  function maintain(serverId) {
    const st = states.get(serverId);
    if (!st || busy.has(serverId)) return;
    const server = S.servers.find((s) => s.id === serverId);
    if (!server) return;
    const needsRotate = (st.needsRotation || !st.keyEpoch) && !held(serverId) && mayMakeKey(server);
    const shareWith = (st.missing || []).filter((id) => id !== S.me.id && !heldBack(serverId, id));
    // Held back here yourself: the server takes no key from you to pass on (it might be one you made alone).
    const needsShare = !needsRotate && !isHeld(serverId, S.me.id) && shareWith.length > 0 && currentKey(serverId);
    if (!needsRotate && !needsShare) return;
    busy.add(serverId);
    // Runs right away (no timers: background tabs throttle them). If several members do this at once,
    // the server keeps the first rotation and ignores duplicate shares.
    (async () => {
      try {
        if (needsRotate) await rotate(serverId);
        else await share(serverId, shareWith);
      } catch (e) {
        if (!['epoch', 'members', 'keys_unverified', ...LIMITED].includes(e.code)) console.warn('Key maintenance failed', e.message);
      } finally { busy.delete(serverId); }
    })();
  }
  // While you wait to be verified here yourself, you can only make the key of a server nobody else is in (the server
  // refuses otherwise: the others would be handed a key that your unverified keys chose).
  const mayMakeKey = (server) => !isHeld(server.id, S.me.id) || server.memberIds.every((id) => id === S.me.id);
  // The server said "not you, not now" to a new key from us (we came back after being away, or we reported the
  // last key broken, so someone else makes the next one): don't keep asking for a minute.
  const LIMITED = ['rotate_too_soon', 'rate_limited'];
  const holds = new Map(); // serverId -> time we may try to rotate again
  const held = (serverId) => (holds.get(serverId) || 0) > Date.now();

  async function wrapFor(serverId, epoch, raw, userIds) {
    const wraps = {};
    const pubs = {}; // the public key each one is wrapped for, so the server can refuse stale ones
    for (const uid of userIds) {
      const u = uid === S.me.id ? S.me : await userWithKeys(uid);
      if (!u || !u.publicKey) throw new Error(`Missing encryption key for a member.`);
      if (!trust(u)) {
        const err = new Error(`${u.username}'s security key changed. Verify them before sharing keys.`);
        err.code = 'untrusted';
        throw err;
      }
      wraps[uid] = await E2EE.wrapGroupKey({ raw, serverId, epoch, recipientId: uid, recipientPub: u.publicKey, wrapperId: S.me.id, signKey: S.signKey });
      pubs[uid] = u.publicKey;
    }
    return { wraps, pubs };
  }
  // Someone's keys changed under us: fetch them fresh before trying again.
  async function refreshUsers(ids) {
    await Promise.all(ids.map((id) => api('GET', '/users/' + id).then((x) => { S.users[id] = mergeUser(S.users[id], x); }).catch(() => {})));
  }

  async function rotate(serverId) {
    const server = S.servers.find((s) => s.id === serverId);
    const st = states.get(serverId);
    if (!server || !st) return;
    const epoch = st.keyEpoch + 1;
    const raw = E2EE.newGroupKey();
    // Everyone but whoever waits to be verified (the server wouldn't keep their copy).
    const { wraps, pubs } = await wrapFor(serverId, epoch, raw, server.memberIds.filter((id) => !heldBack(serverId, id)));
    const check = await E2EE.keyCheck(raw, serverId, epoch);
    const next = await api('POST', `/servers/${serverId}/keys/rotate`, { epoch, check, wraps, pubs }).catch(async (e) => {
      if (e.code === 'stale_keys') { await refreshUsers(server.memberIds.filter((id) => id !== S.me.id)); setTimeout(() => maintain(serverId), 500); }
      if (LIMITED.includes(e.code)) holds.set(serverId, Date.now() + 60000);
      throw e;
    });
    keysFor(serverId).set(epoch, raw);
    await applyState(next);
  }

  async function share(serverId, userIds) {
    const ck = currentKey(serverId);
    const server = S.servers.find((s) => s.id === serverId);
    if (!ck || !server || !userIds.length) return;
    const ids = userIds.filter((id) => server.memberIds.includes(id) && !heldBack(serverId, id));
    if (!ids.length) return;
    const { wraps, pubs } = await wrapFor(serverId, ck.epoch, ck.raw, ids);
    const r = await api('POST', `/servers/${serverId}/keys/share`, { epoch: ck.epoch, wraps, pubs });
    if (r && r.stale && r.stale.length) { await refreshUsers(r.stale); setTimeout(() => maintain(serverId), 500); }
  }

  // Wait until we can send in this server (rotating ourselves if the key needs refreshing).
  async function ready(serverId) {
    const server = S.servers.find((s) => s.id === serverId);
    // Waiting to be verified: nobody shares the key with you, so there's nothing to wait for here.
    if (!currentKey(serverId) && server && !mayMakeKey(server)) {
      const err = new Error('Your password was reset without your recovery key, so someone here who knew you before has to verify you before you can read or send messages here. Ask one of them to compare safety numbers with you.');
      err.code = 'unverified';
      throw err;
    }
    for (let i = 0; i < 4; i++) {
      if (i && rolledBack(serverId)) break; // still older than a key we have, even after asking again
      const ck = currentKey(serverId);
      if (ck) return ck;
      const st = states.get(serverId);
      if (st && (st.needsRotation || !st.keyEpoch) && !busy.has(serverId) && !held(serverId) && (!server || mayMakeKey(server))) {
        busy.add(serverId);
        // Refused for us (see holds): another member's app makes the new key, so wait for it like for a share.
        try { await rotate(serverId); } catch (e) {
          if (!['epoch', 'members', ...LIMITED].includes(e.code)) throw e;
        } finally { busy.delete(serverId); }
        if (currentKey(serverId)) return currentKey(serverId);
      }
      await refresh(serverId);
      if (!currentKey(serverId) && !rolledBack(serverId)) await waitForState(serverId, 1500);
    }
    if (rolledBack(serverId)) {
      const err = new Error('This server offered an older encryption key than the one you already use, so nothing was sent. Reload the page; if it keeps happening, tell the server\u2019s owner.');
      err.code = 'rollback';
      throw err;
    }
    // Joined a server that keeps what came before from new members: the key is the next one, made for you (since:
    // where your history starts, server/joinhistory.js), never the one in use when you joined.
    const st = states.get(serverId);
    const err = new Error(st && st.since && st.since.epoch > st.keyEpoch
      ? 'Your encryption key for this server is on its way: it gives new members a fresh key, which can take a few minutes.'
      : 'You don\u2019t have this server\u2019s encryption key yet. It arrives as soon as another member comes online.');
    err.code = 'no-key';
    throw err;
  }
  async function refresh(serverId) {
    try { await applyState(await api('GET', `/servers/${serverId}/keys`)); } catch { /* ignore */ }
  }
  async function forceRotate(serverId) {
    const st = states.get(serverId);
    if (st) states.set(serverId, { ...st });
    await rotate(serverId);
  }

  // ---------------------------------------------------------------- channel messages
  async function encryptChannel(serverId, channelId, payload) {
    const ck = await ready(serverId);
    const ciphertext = await E2EE.encryptGroup({ raw: ck.raw, serverId, channelId, epoch: ck.epoch, authorId: S.me.id, signKey: S.signKey, payload });
    return { ciphertext, epoch: ck.epoch };
  }

  async function openGroup(serverId, channelId, authorId, text, at = 0) {
    const epoch = E2EE.groupEpoch(text);
    const mine = keysFor(serverId);
    const raw = mine.get(epoch);
    if (!raw) {
      // Only the current key is ever handed out later (keys/share), so a missing key older than one we hold
      // never arrives: written before we joined, or while we were away (a rejoin always gets a new key).
      const held = [...mine.keys()];
      return { pending: true, before: held.length > 0 && epoch < Math.max(...held), t: '', f: [] };
    }
    try {
      const author = await userWithKeys(authorId);
      if (authorId === S.me.id) await ownKeysOk();
      // Checked against every key we know for them (see keysOf); only 'now' and 'pinned' ones verify it. keyNote
      // says when it wasn't their current trusted key, so the message can say so.
      const keys = keysOf(author, 's', at);
      const { payload, signedBy } = await E2EE.decryptGroup({ raw, serverId, channelId, authorId, authorSignPub: keys.map((k) => k.key), text });
      const how = signedBy ? keys.find((k) => k.key === signedBy).trust : null;
      return {
        t: String(payload.t || ''), f: cleanFiles(payload.f), p: cleanPoll(payload.p), x: cleanX(payload.x), ...linksIn(payload), ...bindIn(payload),
        verified: how === 'now' || how === 'pinned', ...(how && how !== 'now' ? { keyNote: how } : {}),
      };
    } catch {
      return { error: true, t: '', f: [] };
    }
  }

  // A plaintext ("older") channel message. Nothing proves who wrote one, so it's never shown as verified.
  // Only this server's news bot still posts them; any other one dated after the server switched on end-to-end
  // encryption can't have come from a member's app at all (only the server could have written it), so it isn't
  // shown. S.e2eeSince is when that was, as this device first heard it (see app.js).
  function openLegacy(m) {
    const author = S.users[m.authorId];
    const bot = !!m.bot && (m.authorId === NEWS_BOT_ID || (!!author && !!author.bot));
    if (!bot && S.e2eeSince && Number(m.createdAt) > S.e2eeSince) return { forged: true, error: true, t: '', f: [] };
    return { t: m.content || '', f: cleanFiles(m.attachments), legacy: true, verified: false, embed: m.embed || null, bot, webhook: bot ? hookOf(m.webhook) : null };
  }
  // A channel webhook's post: the name and picture the program asked for (the picture is an https address the app
  // only loads through this server's avatar proxy, by the link the server signed for it: avatarSrc, sent only for
  // pictures on known avatar hosts), and whether it may ping.
  function hookOf(w) {
    if (!w || typeof w !== 'object') return null;
    return {
      id: String(w.id || ''), name: typeof w.name === 'string' && w.name ? w.name.slice(0, 64) : null,
      avatar: typeof w.avatar === 'string' && /^https:\/\//.test(w.avatar) ? w.avatar : null, pings: w.pings === true,
      avatarSrc: typeof w.avatarSrc === 'string' && /^\/media\/avatar\//.test(w.avatarSrc) ? w.avatarSrc : null,
    };
  }
  // A bot post from an account this device hasn't loaded (a channel webhook's, or a bot removed since): load it first,
  // so it's checked as a bot's instead of being hidden as a message only the server could have written.
  async function loadBotAuthor(x) {
    if (x && x.bot && x.authorId && !S.users[x.authorId]) { try { await userWithKeys(x.authorId); } catch { /* stays unknown */ } }
  }

  async function decryptChannelMessage(m) {
    if (m.dec && !m.dec.pending) return;
    if (m.legacy) await loadBotAuthor(m);
    if (m.reply && !m.reply.ciphertext) await loadBotAuthor(m.reply);
    if (m.legacy) m.dec = openLegacy(m);
    else {
      // If a key arrives while we're decrypting, try again so we never keep a stale "waiting" result.
      for (let i = 0; i < 3; i++) {
        const gen = generation.get(m.serverId) || 0;
        m.dec = await openGroup(m.serverId, m.channelId, m.authorId, m.ciphertext, Number(m.createdAt) || 0);
        if (!m.dec.pending || gen === (generation.get(m.serverId) || 0)) break;
      }
    }
    if (m.reply && (!m.reply.dec || m.reply.dec.pending)) {
      m.reply.dec = m.reply.ciphertext ? await openGroup(m.serverId, m.channelId, m.reply.authorId, m.reply.ciphertext, Number(m.reply.createdAt) || 0) : openLegacy(m.reply);
    }
  }

  // ---------------------------------------------------------------- DMs
  async function dmPeer(dmId) {
    const d = S.dms.find((x) => x.id === dmId);
    if (!d) throw new Error('Conversation not found.');
    const u = await userWithKeys(d.userId);
    if (!u || !u.publicKey) throw new Error('Missing key');
    return u;
  }
  async function encryptDm(dmId, payload) {
    const peer = await dmPeer(dmId);
    if (peer.deleted) throw new Error('This account was deleted, so nobody can read new messages to it.');
    if (keyChanged(peer)) {
      const err = new Error(`${peer.username}'s security key changed. Verify it before sending.`);
      err.code = 'untrusted';
      throw err;
    }
    trust(peer);
    return E2EE.encryptDm({ myPriv: S.privateKey, theirPub: peer.publicKey, dmId, authorId: S.me.id, payload });
  }
  // The other person's identity keys a DM written at `at` may be locked with, best first (see keysOf): it's
  // locked with whichever key they had then (before a password reset, or before they deleted their account).
  async function dmKeys(dmId, at) {
    const d = S.dms.find((x) => x.id === dmId);
    if (!d) throw new Error('Conversation not found.');
    const peer = await userWithKeys(d.userId);
    if (peer && peer.publicKey) trust(peer);
    return keysOf(peer, 'e', at);
  }
  // DMs aren't signed (so they stay deniable): the key that opens one is all that says who could have written it.
  // keyNote says when that wasn't their current trusted key, so the message can say so.
  async function openDm(dmId, authorId, text, at = 0) {
    try {
      for (const { key, trust: how } of await dmKeys(dmId, at)) {
        try {
          const { payload, legacy } = await E2EE.decryptDm({ myPriv: S.privateKey, theirPub: key, dmId, authorId, text });
          return { t: String(payload.t || ''), f: cleanFiles(payload.f), p: cleanPoll(payload.p), x: cleanX(payload.x), ...linksIn(payload), ...bindIn(payload), legacyFormat: !!legacy, ...(how !== 'now' ? { keyNote: how } : {}) };
        } catch { /* not this key */ }
      }
      throw new Error('Missing key');
    } catch {
      return { error: true, t: '', f: [] };
    }
  }
  async function decryptDmMessage(m) {
    if (m.dec) return;
    m.dec = await openDm(m.dmId, m.authorId, m.ciphertext, Number(m.createdAt) || 0);
    if (m.reply && m.reply.ciphertext && !m.reply.dec) m.reply.dec = await openDm(m.dmId, m.reply.authorId, m.reply.ciphertext, Number(m.reply.createdAt) || 0);
  }

  // ---------------------------------------------------------------- attachments
  async function decryptAttachment(m, f, buf) {
    if (f.k) return E2EE.decryptFile(f.k, buf);
    if (m.dmId) {
      // Files from the oldest DM format are locked with the conversation key itself: the same keys as the text.
      for (const { key } of await dmKeys(m.dmId, Number(m.createdAt) || 0)) {
        try { return await E2EE.decryptLegacyDmFile(S.privateKey, key, buf); } catch { /* not this key */ }
      }
      throw new Error('Missing key');
    }
    throw new Error('Missing file key');
  }

  // ---------------------------------------------------------------- voice handshakes
  const sdpText = (channelId, from, to, desc) => `hearth-voice|${channelId}|${from}|${to}|${desc.type}|${desc.sdp}`;
  const signSdp = (channelId, toUserId, desc) => E2EE.sign(S.signKey, sdpText(channelId, S.me.id, toUserId, desc));
  // Whether an offer or answer really comes from that person: { ok: true }, or { ok: false, why } with why one of
  //   'no-key'         the server lists no identity key for them (a bot has none), or no signing key at all
  //   'deleted'        the server says the account was deleted (it can't sign in, so it's never in a call)
  //   'key-changed'    their keys aren't the ones this device pinned for them (e2ee.js judgePin), until you compare
  //                    safety numbers and accept the new ones
  //   'lookup-failed'  their keys couldn't be loaded
  //   'bad-signature'  no signature, a wrong one, or one claiming to come from your own account
  // The signature is checked with the signing key this device pinned for them (pinned on first sight, trust on first
  // use), never just the one the server lists now: the DTLS fingerprint inside the SDP is what the encrypted
  // connection is checked against, so a server that could get its own key accepted could sit in the middle.
  async function checkSdp(channelId, fromUserId, desc, sig) {
    if (!fromUserId || fromUserId === S.me.id || !desc || typeof desc.sdp !== 'string' || !sig) return { ok: false, why: 'bad-signature' };
    let u;
    try { u = await userWithKeys(fromUserId); } catch { u = null; }
    if (!u) return { ok: false, why: 'lookup-failed' };
    // (An account deleted by an older version has no keys at all; one that lists a signing key without an identity
    // key is no real deletion, e2ee.js judgePin.)
    if (!u.publicKey) return { ok: false, why: u.deleted && !keyChanged(u) ? 'deleted' : 'no-key' };
    if (keyChanged(u)) return { ok: false, why: 'key-changed' };
    if (u.deleted) return { ok: false, why: 'deleted' };
    const signKey = E2EE.pinnedKeys(S.me.id, u).s;
    if (!signKey) return { ok: false, why: 'no-key' };
    return (await E2EE.verify(signKey, sdpText(channelId, fromUserId, S.me.id, desc), sig)) ? { ok: true } : { ok: false, why: 'bad-signature' };
  }
  const verifySdp = async (channelId, fromUserId, desc, sig) => (await checkSdp(channelId, fromUserId, desc, sig)).ok;

  function reset() {
    groupKeys.clear(); states.clear(); busy.clear(); warned.clear(); rewrapped.clear(); keeping.clear(); unverified.clear(); holds.clear();
    ownCheck = null; proven = null; E2EE.clearCaches();
  }

  return {
    ensureSigningKey, applyState, stateOf, currentKey, ready, refresh, forceRotate, maintain, awaitingVerify, heldBack, isHeld,
    encryptChannel, decryptChannelMessage, encryptDm, decryptDmMessage, decryptAttachment,
    signSdp, verifySdp, checkSdp, keyChanged, keysChanged, acceptKeys, trust, userWithKeys, reset,
    heldEpochs: (serverId) => [...keysFor(serverId).keys()],
    keysSaved: (serverId) => keeping.get(serverId) || Promise.resolve(), // our own copies are stored back
    signKeysFor,
  };
}
