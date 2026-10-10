// Per-session key management on top of e2ee.js:
// - unlocks/creates your signing key
// - keeps every server's group keys (epochs) you've been given, verifying who shared them
// - rotates a server's key when someone leaves, and shares the current key with new members
// - encrypts/decrypts channel messages and DMs, and signs/verifies voice handshakes
import * as E2EE from './e2ee.js';
import { api } from './api.js';

// The news bot's account (server/newsbot.js): the only one that still posts plaintext channel messages.
const NEWS_BOT_ID = 'newsbot00000000000001';

// A poll inside a message: question, 2–10 options, single or multiple choice. Anything else is dropped.
function cleanPoll(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.o)) return undefined;
  const o = p.o.map((x) => String(x || '').slice(0, 100)).filter(Boolean).slice(0, 10);
  if (o.length < 2) return undefined;
  return { q: String(p.q || '').slice(0, 300), o, m: !!p.m };
}

export function createSecure({ S, onKeysChanged = () => {}, onKeyWarning = () => {} }) {
  const groupKeys = new Map(); // serverId -> Map(epoch -> Uint8Array)
  const states = new Map(); // serverId -> key state from the server
  const waiters = new Map(); // serverId -> [resolve]
  const busy = new Set();
  const warned = new Set();
  const fetching = new Map();
  const generation = new Map(); // serverId -> bumps whenever new keys arrive
  const reported = new Set(); // keys we couldn't unlock and asked to be re-shared
  const rewrapped = new Set(); // `${serverId}|${epoch}`: keys already re-wrapped to ourselves this session

  // ---------------------------------------------------------------- people + trust
  async function userWithKeys(id) {
    let u = S.users[id];
    if (u && (u.publicKey || u.deleted)) return u;
    if (!fetching.has(id)) fetching.set(id, api('GET', '/users/' + id).then((x) => { S.users[id] = { ...(S.users[id] || {}), ...x }; return S.users[id]; }).finally(() => fetching.delete(id)));
    u = await fetching.get(id);
    return u;
  }
  function trust(user) {
    if (!user || user.id === S.me.id) return true;
    const ok = E2EE.checkPin(S.me.id, user) === 'ok';
    if (!ok && !warned.has(user.id)) { warned.add(user.id); onKeyWarning(user); }
    return ok;
  }
  const keyChanged = (user) => !!user && user.id !== S.me.id && E2EE.checkPin(S.me.id, user) === 'changed';
  function acceptKeys(user) { E2EE.acceptPin(S.me.id, user); warned.delete(user.id); }
  // The signing keys accepted for what someone signed: their current key (unless it changed and you haven't
  // verified it yet). For the past (older server keys, messages; past: true), also the keys this device trusted
  // for them before, e.g. before they reset their password without a recovery key: those still count for what
  // was written while they had them (`at`: when it was written, if known).
  function signKeysFor(user, { past = true, at = 0 } = {}) {
    if (!user) return [];
    if (user.id === S.me.id) return [S.me.signPublicKey || user.signPublicKey].filter(Boolean);
    const keys = user.signPublicKey && !keyChanged(user) ? [user.signPublicKey] : [];
    if (past) for (const k of E2EE.pinnedKeys(S.me.id, user, at).s) if (!keys.includes(k)) keys.push(k);
    return keys;
  }

  // ---------------------------------------------------------------- signing key
  async function ensureSigningKey(encSignPrivateKey) {
    if (S.me.signPublicKey && encSignPrivateKey) {
      S.signKey = await E2EE.unwrapSigningKey(S.privateKey, S.me.publicKey, encSignPrivateKey);
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
    if (!st || st.needsRotation || !st.keyEpoch || rolledBack(serverId)) return null;
    const raw = keysFor(serverId).get(st.keyEpoch);
    return raw ? { epoch: st.keyEpoch, raw } : null;
  }
  const stateOf = (serverId) => states.get(serverId) || null;

  async function applyState(st) {
    if (!st) return;
    states.set(st.serverId, st);
    const mine = keysFor(st.serverId);
    const server = S.servers.find((s) => s.id === st.serverId);
    let added = false;
    const fresh = []; // keys someone else handed us (re-wrapped to ourselves below)
    for (const k of st.keys || []) {
      if (mine.has(k.epoch)) continue;
      const current = k.epoch === st.keyEpoch;
      try {
        // The key everyone encrypts with now must come from a member. One handed out by someone who isn't in
        // the server (only the server itself could arrange that) is never used.
        if (current && !st.needsRotation && server && k.wrapperId !== S.me.id && !server.memberIds.includes(k.wrapperId)) throw new Error('untrusted sharer');
        const wrapper = await userWithKeys(k.wrapperId);
        if (k.wrapperId !== S.me.id) trust(wrapper); // warns (once) if their key changed
        // The key to encrypt with from now on: only from someone's current, trusted key. Older server keys (for
        // reading history) may also come from keys they had before.
        const signKeys = signKeysFor(wrapper, { past: !current });
        if (!signKeys.length) throw new Error('untrusted sharer');
        let raw;
        try {
          raw = await E2EE.unwrapGroupKey({
            wrapped: k.wrapped, serverId: st.serverId, epoch: k.epoch, myId: S.me.id, myPriv: S.privateKey,
            wrapperId: k.wrapperId, wrapperSignPub: signKeys,
          });
        } catch (e) {
          // Signed by a new key of theirs you haven't verified (and none you trusted before): wait for that.
          if (/did not verify/.test(e.message) && keyChanged(wrapper)) throw new Error('untrusted sharer');
          throw e;
        }
        if ((await E2EE.keyCheck(raw, st.serverId, k.epoch)) !== k.check) throw new Error('key check mismatch');
        mine.set(k.epoch, raw);
        added = true;
        generation.set(st.serverId, (generation.get(st.serverId) || 0) + 1);
        if (k.wrapperId !== S.me.id) fresh.push({ epoch: k.epoch, raw });
      } catch (e) {
        console.warn('Could not unlock a server key', st.serverId, k.epoch, e.message);
        // Locked for keys this account no longer has (or damaged): ask for it to be shared again. Once per
        // key per session, and only the current key (nobody can share an older one again, so the server keeps
        // those). Not for "untrusted sharer": that one waits for you to verify them.
        const tag = `${st.serverId}|${k.epoch}`;
        if (current && e.message !== 'untrusted sharer' && !reported.has(tag)) { reported.add(tag); api('POST', `/servers/${st.serverId}/keys/bad`, { epoch: k.epoch }).catch(() => {}); }
      }
    }
    if (fresh.length) keepForMyself(st.serverId, fresh);
    (waiters.get(st.serverId) || []).forEach((r) => r());
    waiters.delete(st.serverId);
    onKeysChanged(st.serverId, added);
    maintain(st.serverId);
  }

  // Keys someone else handed us are wrapped again to ourselves (signed by us) and stored back in place of the
  // copy we got, once per key. Our history then no longer depends on the sharer keeping their keys: deleting
  // their account or resetting their password can't lock us out of what was said back then.
  const keeping = new Map(); // serverId -> promise of the last upload (so tests and callers can wait for it)
  // Our public key as the server tells it must really be ours before we wrap every key we hold to it: a round
  // trip (wrap to it, open with our private key) proves it. Checked once per session.
  let ownKeyCheck = null;
  function ownKeyOk() {
    if (!ownKeyCheck) {
      ownKeyCheck = (async () => {
        const raw = E2EE.newGroupKey();
        const ctx = { serverId: 'self-check', epoch: 0, wrapperId: S.me.id };
        const w = await E2EE.wrapGroupKey({ ...ctx, raw, recipientId: S.me.id, recipientPub: S.me.publicKey, signKey: S.signKey });
        const back = await E2EE.unwrapGroupKey({ ...ctx, wrapped: w, myId: S.me.id, myPriv: S.privateKey, wrapperSignPub: S.me.signPublicKey });
        return back.length === raw.length && back.every((b, i) => b === raw[i]);
      })().catch(() => false);
    }
    return ownKeyCheck;
  }
  function keepForMyself(serverId, list) {
    const todo = list.filter((k) => !rewrapped.has(`${serverId}|${k.epoch}`));
    if (!todo.length || !S.signKey || !S.me || !S.me.publicKey) return keeping.get(serverId);
    todo.forEach((k) => rewrapped.add(`${serverId}|${k.epoch}`));
    const job = (async () => {
      if (!(await ownKeyOk())) throw new Error('our public key doesn’t match our private key');
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
    const needsRotate = st.needsRotation || !st.keyEpoch;
    const needsShare = !needsRotate && st.missing && st.missing.some((id) => id !== S.me.id) && currentKey(serverId);
    if (!needsRotate && !needsShare) return;
    busy.add(serverId);
    // Runs right away (no timers: background tabs throttle them). If several members do this at once,
    // the server keeps the first rotation and ignores duplicate shares.
    (async () => {
      try {
        if (needsRotate) await rotate(serverId);
        else await share(serverId, st.missing.filter((id) => id !== S.me.id));
      } catch (e) {
        if (!['epoch', 'members'].includes(e.code)) console.warn('Key maintenance failed', e.message);
      } finally { busy.delete(serverId); }
    })();
  }

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
    await Promise.all(ids.map((id) => api('GET', '/users/' + id).then((x) => { S.users[id] = { ...(S.users[id] || {}), ...x }; }).catch(() => {})));
  }

  async function rotate(serverId) {
    const server = S.servers.find((s) => s.id === serverId);
    const st = states.get(serverId);
    if (!server || !st) return;
    const epoch = st.keyEpoch + 1;
    const raw = E2EE.newGroupKey();
    const { wraps, pubs } = await wrapFor(serverId, epoch, raw, server.memberIds);
    const check = await E2EE.keyCheck(raw, serverId, epoch);
    const next = await api('POST', `/servers/${serverId}/keys/rotate`, { epoch, check, wraps, pubs }).catch(async (e) => {
      if (e.code === 'stale_keys') { await refreshUsers(server.memberIds.filter((id) => id !== S.me.id)); setTimeout(() => maintain(serverId), 500); }
      throw e;
    });
    keysFor(serverId).set(epoch, raw);
    await applyState(next);
  }

  async function share(serverId, userIds) {
    const ck = currentKey(serverId);
    const server = S.servers.find((s) => s.id === serverId);
    if (!ck || !server || !userIds.length) return;
    const ids = userIds.filter((id) => server.memberIds.includes(id));
    if (!ids.length) return;
    const { wraps, pubs } = await wrapFor(serverId, ck.epoch, ck.raw, ids);
    const r = await api('POST', `/servers/${serverId}/keys/share`, { epoch: ck.epoch, wraps, pubs });
    if (r && r.stale && r.stale.length) { await refreshUsers(r.stale); setTimeout(() => maintain(serverId), 500); }
  }

  // Wait until we can send in this server (rotating ourselves if the key needs refreshing).
  async function ready(serverId) {
    for (let i = 0; i < 4; i++) {
      if (i && rolledBack(serverId)) break; // still older than a key we have, even after asking again
      const ck = currentKey(serverId);
      if (ck) return ck;
      const st = states.get(serverId);
      if (st && (st.needsRotation || !st.keyEpoch) && !busy.has(serverId)) {
        busy.add(serverId);
        try { await rotate(serverId); } catch (e) {
          if (!['epoch', 'members'].includes(e.code)) throw e;
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
    const err = new Error('You don\u2019t have this server\u2019s encryption key yet. It arrives as soon as another member comes online.');
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
      const held = [...mine.keys()];
      return { pending: true, before: held.length > 0 && epoch < Math.min(...held), t: '', f: [] };
    }
    try {
      const author = await userWithKeys(authorId);
      // Their current key if you trust it, or one you trusted for them before (posts from before a reset).
      const { payload, verified } = await E2EE.decryptGroup({ raw, serverId, channelId, authorId, authorSignPub: signKeysFor(author, { at }), text });
      return { t: String(payload.t || ''), f: Array.isArray(payload.f) ? payload.f : [], p: cleanPoll(payload.p), verified };
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
    return { t: m.content || '', f: m.attachments || [], legacy: true, verified: false, embed: m.embed || null, bot };
  }

  async function decryptChannelMessage(m) {
    if (m.dec && !m.dec.pending) return;
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
      m.reply.dec = m.reply.ciphertext ? await openGroup(m.serverId, m.channelId, m.reply.authorId, m.reply.ciphertext) : openLegacy(m.reply);
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
  async function openDm(dmId, authorId, text, at = 0) {
    try {
      const d = S.dms.find((x) => x.id === dmId);
      if (!d) throw new Error('Conversation not found.');
      const peer = await userWithKeys(d.userId);
      if (peer && peer.publicKey) trust(peer);
      // Their current key first, then the keys this device trusted for them before: a message is locked with
      // whichever they had when it was written (before a password reset, or before they deleted their account).
      const keys = [...new Set([peer && peer.publicKey, ...E2EE.pinnedKeys(S.me.id, peer, at).e].filter(Boolean))];
      for (const theirPub of keys) {
        try {
          const { payload, legacy } = await E2EE.decryptDm({ myPriv: S.privateKey, theirPub, dmId, authorId, text });
          return { t: String(payload.t || ''), f: Array.isArray(payload.f) ? payload.f : [], p: cleanPoll(payload.p), legacyFormat: !!legacy };
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
    if (m.reply && m.reply.ciphertext && !m.reply.dec) m.reply.dec = await openDm(m.dmId, m.reply.authorId, m.reply.ciphertext);
  }

  // ---------------------------------------------------------------- attachments
  async function decryptAttachment(m, f, buf) {
    if (f.k) return E2EE.decryptFile(f.k, buf);
    if (m.dmId) return E2EE.decryptLegacyDmFile(S.privateKey, (await dmPeer(m.dmId)).publicKey, buf);
    throw new Error('Missing file key');
  }

  // ---------------------------------------------------------------- voice handshakes
  const sdpText = (channelId, from, to, desc) => `hearth-voice|${channelId}|${from}|${to}|${desc.type}|${desc.sdp}`;
  const signSdp = (channelId, toUserId, desc) => E2EE.sign(S.signKey, sdpText(channelId, S.me.id, toUserId, desc));
  async function verifySdp(channelId, fromUserId, desc, sig) {
    const u = await userWithKeys(fromUserId);
    if (!u || !u.signPublicKey || keyChanged(u)) return false;
    return E2EE.verify(u.signPublicKey, sdpText(channelId, fromUserId, S.me.id, desc), sig);
  }

  function reset() { groupKeys.clear(); states.clear(); busy.clear(); warned.clear(); rewrapped.clear(); keeping.clear(); ownKeyCheck = null; E2EE.clearCaches(); }

  return {
    ensureSigningKey, applyState, stateOf, currentKey, ready, refresh, forceRotate, maintain,
    encryptChannel, decryptChannelMessage, encryptDm, decryptDmMessage, decryptAttachment,
    signSdp, verifySdp, keyChanged, acceptKeys, trust, userWithKeys, reset,
    heldEpochs: (serverId) => [...keysFor(serverId).keys()],
    keysSaved: (serverId) => keeping.get(serverId) || Promise.resolve(), // our own copies are stored back
    signKeysFor,
  };
}
