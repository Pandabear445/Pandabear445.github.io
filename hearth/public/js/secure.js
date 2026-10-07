// Per-session key management on top of e2ee.js:
// - unlocks/creates your signing key
// - keeps every server's group keys (epochs) you've been given, verifying who shared them
// - rotates a server's key when someone leaves, and shares the current key with new members
// - encrypts/decrypts channel messages and DMs, and signs/verifies voice handshakes
import * as E2EE from './e2ee.js';
import { api } from './api.js';

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

  // ---------------------------------------------------------------- people + trust
  async function userWithKeys(id) {
    let u = S.users[id];
    if (u && u.publicKey) return u;
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

  // ---------------------------------------------------------------- signing key
  async function ensureSigningKey(encSignPrivateKey) {
    if (S.me.signPublicKey && encSignPrivateKey) {
      S.signKey = await E2EE.unwrapSigningKey(S.privateKey, S.me.publicKey, encSignPrivateKey);
      return;
    }
    const k = await E2EE.createSigningKey(S.privateKey, S.me.publicKey);
    try {
      const me = await api('POST', '/me/sign-key', { signPublicKey: k.signPublicKey, encSignPrivateKey: k.encSignPrivateKey });
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
  function currentKey(serverId) {
    const st = states.get(serverId);
    if (!st || st.needsRotation || !st.keyEpoch) return null;
    const raw = keysFor(serverId).get(st.keyEpoch);
    return raw ? { epoch: st.keyEpoch, raw } : null;
  }
  const stateOf = (serverId) => states.get(serverId) || null;

  async function applyState(st) {
    if (!st) return;
    states.set(st.serverId, st);
    const mine = keysFor(st.serverId);
    let added = false;
    for (const k of st.keys || []) {
      if (mine.has(k.epoch)) continue;
      try {
        const wrapper = await userWithKeys(k.wrapperId);
        if (!wrapper.signPublicKey || !trust(wrapper)) throw new Error('untrusted sharer');
        const raw = await E2EE.unwrapGroupKey({
          wrapped: k.wrapped, serverId: st.serverId, epoch: k.epoch, myId: S.me.id, myPriv: S.privateKey,
          wrapperId: k.wrapperId, wrapperSignPub: wrapper.signPublicKey,
        });
        if ((await E2EE.keyCheck(raw, st.serverId, k.epoch)) !== k.check) throw new Error('key check mismatch');
        mine.set(k.epoch, raw);
        added = true;
        generation.set(st.serverId, (generation.get(st.serverId) || 0) + 1);
      } catch (e) {
        console.warn('Could not unlock a server key', st.serverId, k.epoch, e.message);
      }
    }
    (waiters.get(st.serverId) || []).forEach((r) => r());
    waiters.delete(st.serverId);
    onKeysChanged(st.serverId, added);
    maintain(st.serverId);
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
    for (const uid of userIds) {
      const u = uid === S.me.id ? S.me : await userWithKeys(uid);
      if (!u || !u.publicKey) throw new Error(`Missing encryption key for a member.`);
      if (!trust(u)) {
        const err = new Error(`${u.username}'s security key changed. Verify them before sharing keys.`);
        err.code = 'untrusted';
        throw err;
      }
      wraps[uid] = await E2EE.wrapGroupKey({ raw, serverId, epoch, recipientId: uid, recipientPub: u.publicKey, wrapperId: S.me.id, signKey: S.signKey });
    }
    return wraps;
  }

  async function rotate(serverId) {
    const server = S.servers.find((s) => s.id === serverId);
    const st = states.get(serverId);
    if (!server || !st) return;
    const epoch = st.keyEpoch + 1;
    const raw = E2EE.newGroupKey();
    const wraps = await wrapFor(serverId, epoch, raw, server.memberIds);
    const check = await E2EE.keyCheck(raw, serverId, epoch);
    const next = await api('POST', `/servers/${serverId}/keys/rotate`, { epoch, check, wraps });
    keysFor(serverId).set(epoch, raw);
    await applyState(next);
  }

  async function share(serverId, userIds) {
    const ck = currentKey(serverId);
    const server = S.servers.find((s) => s.id === serverId);
    if (!ck || !server || !userIds.length) return;
    const ids = userIds.filter((id) => server.memberIds.includes(id));
    if (!ids.length) return;
    const wraps = await wrapFor(serverId, ck.epoch, ck.raw, ids);
    await api('POST', `/servers/${serverId}/keys/share`, { epoch: ck.epoch, wraps });
  }

  // Wait until we can send in this server (rotating ourselves if the key needs refreshing).
  async function ready(serverId) {
    for (let i = 0; i < 4; i++) {
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
      if (!currentKey(serverId)) await waitForState(serverId, 1500);
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

  async function openGroup(serverId, channelId, authorId, text) {
    const epoch = E2EE.groupEpoch(text);
    const mine = keysFor(serverId);
    const raw = mine.get(epoch);
    if (!raw) {
      const held = [...mine.keys()];
      return { pending: true, before: held.length > 0 && epoch < Math.min(...held), t: '', f: [] };
    }
    try {
      const author = await userWithKeys(authorId);
      const { payload, verified } = await E2EE.decryptGroup({ raw, serverId, channelId, authorId, authorSignPub: author.signPublicKey, text });
      return { t: String(payload.t || ''), f: Array.isArray(payload.f) ? payload.f : [], p: cleanPoll(payload.p), verified: verified && !keyChanged(author) };
    } catch {
      return { error: true, t: '', f: [] };
    }
  }

  async function decryptChannelMessage(m) {
    if (m.dec && !m.dec.pending) return;
    if (m.legacy) m.dec = { t: m.content || '', f: m.attachments || [], legacy: true, verified: true };
    else {
      // If a key arrives while we're decrypting, try again so we never keep a stale "waiting" result.
      for (let i = 0; i < 3; i++) {
        const gen = generation.get(m.serverId) || 0;
        m.dec = await openGroup(m.serverId, m.channelId, m.authorId, m.ciphertext);
        if (!m.dec.pending || gen === (generation.get(m.serverId) || 0)) break;
      }
    }
    if (m.reply && (!m.reply.dec || m.reply.dec.pending)) {
      m.reply.dec = m.reply.ciphertext ? await openGroup(m.serverId, m.channelId, m.reply.authorId, m.reply.ciphertext) : { t: m.reply.content || '' };
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
    if (keyChanged(peer)) {
      const err = new Error(`${peer.username}'s security key changed. Verify it before sending.`);
      err.code = 'untrusted';
      throw err;
    }
    trust(peer);
    return E2EE.encryptDm({ myPriv: S.privateKey, theirPub: peer.publicKey, dmId, authorId: S.me.id, payload });
  }
  async function openDm(dmId, authorId, text) {
    try {
      const peer = await dmPeer(dmId);
      trust(peer);
      const { payload, legacy } = await E2EE.decryptDm({ myPriv: S.privateKey, theirPub: peer.publicKey, dmId, authorId, text });
      return { t: String(payload.t || ''), f: Array.isArray(payload.f) ? payload.f : [], p: cleanPoll(payload.p), legacyFormat: !!legacy };
    } catch {
      return { error: true, t: '', f: [] };
    }
  }
  async function decryptDmMessage(m) {
    if (m.dec) return;
    m.dec = await openDm(m.dmId, m.authorId, m.ciphertext);
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

  function reset() { groupKeys.clear(); states.clear(); busy.clear(); warned.clear(); E2EE.clearCaches(); }

  return {
    ensureSigningKey, applyState, stateOf, currentKey, ready, refresh, forceRotate, maintain,
    encryptChannel, decryptChannelMessage, encryptDm, decryptDmMessage, decryptAttachment,
    signSdp, verifySdp, keyChanged, acceptKeys, trust, userWithKeys, reset,
    heldEpochs: (serverId) => [...keysFor(serverId).keys()],
  };
}
