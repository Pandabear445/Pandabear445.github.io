require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { db, seal, unseal, newId, DATA_DIR, UPLOAD_DIR, atRestKey, auditAppend, auditVerify, sealSecret, openSecret } = require('./db');
const { sanitizeProfile, parseProfile } = require('./profile');
const { sanitizePage, parsePage } = require('./page');
const { PERMS: PM, ALL: ALL_PERMS, DEFAULT_EVERYONE, CHANNEL_SCOPED, makePerms } = require('./perms');
const { stripFile, ImageRejected } = require('./imagemeta');
const { readLimited, cancel: cancelBody } = require('./fetchlimit');
const perms = makePerms(db);

// ---------------------------------------------------------------- config
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const USE_HTTPS = (process.env.HTTPS || 'true').toLowerCase() !== 'false';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '25', 10);
const REGISTRATION_CODE = process.env.REGISTRATION_CODE || '';
const REGISTRATION_OPEN = (process.env.REGISTRATION_OPEN || 'true').toLowerCase() !== 'false';
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'Hearth';

const iceServers = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(','),
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  });
}

// ---------------------------------------------------------------- helpers
const now = () => Date.now();
const randomCode = (len) => {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
};

class HttpError extends Error {
  constructor(status, message, code, retryAfter) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
const fail = (status, message, code, retryAfter) => { throw new HttpError(status, message, code, retryAfter); };
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (e) { next(e); }
};

// Small in-memory rate limiter: at most `max` hits per key per window. Sensitive routes check several keys at
// once (the network it comes from, the account it targets, the session using it, and everyone together), so
// switching IP addresses doesn't get around the account's limit and one account can't use up another's.
// `cost` lets a limit count something other than requests (bytes sent, say); a cost of 0 only checks it.
const buckets = new Map();
function rateLimit(key, max, windowMs, cost = 1) {
  const t = now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count += cost;
  if (b.count > max) {
    const wait = Math.ceil((b.reset - t) / 1000);
    fail(429, `Too many attempts. Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`, 'rate_limited', wait);
  }
}
// Counts a hit without ever refusing it (for limits where refusing would reveal something; check with overLimit).
function countHit(key, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  return ++b.count;
}
// How many hits a key has in its current window, without counting one.
const hitsSoFar = (key) => { const b = buckets.get(key); return b && b.reset >= now() ? b.count : 0; };
// The "network" an address belongs to for rate limits: the address itself for IPv4, its /64 for IPv6 (a home
// connection or a VPS usually gets a whole /64, so rotating addresses inside it changes nothing).
function netOf(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const a = head ? head.split(':') : []; const b = tail ? tail.split(':') : [];
  const full = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return full.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}
const limitNet = (req, name, max, windowMs) => rateLimit(`${name}:net:${netOf(req.ip)}`, max, windowMs);
// Sending messages: per account (bursts and per hour), per session, and per network (many accounts, one place).
function limitMessages(req) {
  rateLimit('msg:' + req.userId, 30, 10000);
  rateLimit('msgh:' + req.userId, 1500, 3600000);
  if (req.session) rateLimit('msgs:' + req.session.id, 25, 10000);
  limitNet(req, 'msg', 120, 10000);
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

// ---------------------------------------------------------------- presence + voice state
const onlineSockets = new Map(); // userId -> Set(socketId)
const voiceChannels = new Map(); // channelId -> Map(userId -> { socketId, muted, deafened })
const userVoice = new Map(); // userId -> channelId

const isOnline = (userId) => onlineSockets.has(userId) && onlineSockets.get(userId).size > 0;
// Games/music people are playing (server/activity.js fills these in once everything it needs exists).
let ACT = { activityFor: () => null, recentFor: () => undefined };
let ACCT = null; // server/accounts.js: email, recovery key, two-factor

// ---------------------------------------------------------------- serialization
const getUserRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function publicUser(row) {
  if (!row) return null;
  const profile = parseProfile(row);
  let presence = 'offline';
  if (isOnline(row.id) && row.status !== 'invisible') presence = row.status;
  if (row.is_bot) presence = 'online'; // bots run inside this server: they're up whenever it is
  return {
    id: row.id,
    username: row.username,
    avatar: row.avatar,
    banner: row.banner,
    background: row.background,
    song: row.song || null,
    presence,
    profile,
    publicKey: row.public_key,
    signPublicKey: row.sign_public_key || null,
    supporter: !!row.supporter || undefined,
    bot: !!row.is_bot || undefined,
    deleted: !!row.deleted_at || undefined,
    activity: row.deleted_at ? undefined : ACT.activityFor(row) || undefined,
    recentGames: ACT.recentFor(row),
    createdAt: row.created_at,
  };
}
function selfUser(row) {
  const u = publicUser(row);
  u.status = row.status;
  u.kdf = row.kdf;
  u.kdfSalt = row.kdf_salt;
  u.privacy = privacyOf(row);
  u.pageBg = row.page_bg || null;
  u.profileLocked = !!row.profile_locked;
  u.rail = railOf(row);
  u.studyEnabled = !!row.study_enabled;
  u.updatesUnread = NEWS ? NEWS.unreadUpdates(row.id) : 0;
  u.staffRole = staffRole(row.id);
  u.instanceAdmin = (STAFF_RANK[u.staffRole] || 0) >= 2;
  if (ACCT) Object.assign(u, ACCT.selfExtras(row));
  return u;
}

// ---------------------------------------------------------------- end-to-end key state for a server
// What one member needs to know: the current key epoch, their own wrapped keys, and who still
// needs the current key. The server never sees the keys themselves.
// The part that's the same for every member (worked out once when it goes to everyone, see emitKeyState).
function serverKeyInfo(serverId) {
  const s = db.prepare('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?').get(serverId);
  if (!s) return null;
  const missing = s.key_epoch
    ? db.prepare(`SELECT m.user_id FROM members m WHERE m.server_id = ? AND NOT EXISTS
        (SELECT 1 FROM server_keys k WHERE k.server_id = m.server_id AND k.user_id = m.user_id AND k.epoch = ?)`)
      .all(serverId, s.key_epoch).map((r) => r.user_id)
    : [];
  return { keyEpoch: s.key_epoch, needsRotation: !!s.needs_rotation, missing };
}
function keyState(serverId, userId, info = serverKeyInfo(serverId)) {
  if (!info) return null;
  const keys = db.prepare(`SELECT k.epoch, k.wrapped, k.wrapper_id, e.key_check FROM server_keys k
      JOIN server_epochs e ON e.server_id = k.server_id AND e.epoch = k.epoch
      WHERE k.server_id = ? AND k.user_id = ? ORDER BY k.epoch`).all(serverId, userId)
    .map((k) => ({ epoch: k.epoch, wrapped: k.wrapped, wrapperId: k.wrapper_id, check: k.key_check }));
  return { serverId, keyEpoch: info.keyEpoch, needsRotation: info.needsRotation, keys, missing: info.missing };
}
// Is this person connected right now? Updates for anyone who isn't would go nowhere (they get the current state
// when their app starts), so a big server's fan-out only does work for the people actually online.
const connected = (userId) => io.sockets.adapter.rooms.has(`user:${userId}`);
function emitKeyState(serverId) {
  const info = serverKeyInfo(serverId);
  if (!info) return;
  db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(serverId)
    .forEach((m) => { if (connected(m.user_id)) io.to(`user:${m.user_id}`).emit('keys:state', keyState(serverId, m.user_id, info)); });
}

const serializeChannel = (c) => ({ id: c.id, serverId: c.server_id, name: c.name, type: c.type, topic: c.topic, position: c.position, category: c.category, slowmode: c.slowmode || 0, region: c.type === 'voice' ? c.rtc_region || null : undefined });
const THEME_DEFAULT = { accent: '', banner: '', bannerCrop: null, background: { kind: 'none' }, welcome: '', roleColors: true, iconShape: 'rounded' };
const themeOf = (s) => { try { return { ...THEME_DEFAULT, ...JSON.parse(s.theme || '{}') }; } catch { return { ...THEME_DEFAULT }; } };
const NEWS_BOT_ID = require('./newsbot').BOT_ID;
// The parts of a server that look the same to every member. Sending an update to everyone reads these once,
// not once per member (that made a big server's updates cost members × members).
function serverCommon(s) {
  const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position, created_at').all(s.id);
  const memberIds = db.prepare('SELECT user_id FROM members WHERE server_id = ? ORDER BY joined_at').all(s.id).map((r) => r.user_id);
  const memberRoles = {};
  db.prepare(`SELECT mr.user_id, mr.role_id FROM member_roles mr JOIN members m ON m.server_id = mr.server_id AND m.user_id = mr.user_id
    WHERE mr.server_id = ?`).all(s.id).forEach((r) => { (memberRoles[r.user_id] ||= []).push(r.role_id); });
  const roleDefs = db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC').all(s.id)
    .map((r) => ({ id: r.id, name: r.name, color: r.color, icon: r.icon, position: r.position, permissions: r.permissions, hoist: !!r.hoist, mentionable: !!r.mentionable, everyone: r.id === s.id }));
  const emojis = db.prepare('SELECT id, name, url, animated FROM emojis WHERE server_id = ? ORDER BY name').all(s.id).map((e) => ({ ...e, animated: !!e.animated }));
  let categoryOrder = [];
  try { categoryOrder = JSON.parse(s.category_order || '[]'); } catch { /* ignore */ }
  const out = {
    channels, memberIds, memberRoles, roleDefs, emojis, categoryOrder,
    // Bots working for this server (shown in the member list like on Discord): the news bot while it follows something.
    bots: db.prepare('SELECT 1 FROM feeds WHERE server_id = ? AND paused = 0 LIMIT 1').get(s.id) ? [NEWS_BOT_ID] : [],
    // This server sells memberships (the app shows "Memberships" in its menu); owners see the tab either way.
    memberships: s.kind !== 'group' && MEMB.offers(s.id),
    membershipsOn: s.kind !== 'group' && MEMB.usable(),
  };
  if ((s.kind || 'server') === 'group') {
    // The newest message, looked up channel by channel (the channel index). Joining on the group's id instead made
    // SQLite walk every top-level message on the whole instance until it reached one from this group.
    let last = null;
    for (const c of channels) {
      const m = db.prepare('SELECT * FROM messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT 1').get(c.id);
      if (m && (!last || m.id > last.id)) last = m;
    }
    out.last = last ? { id: last.id, authorId: last.author_id, channelId: last.channel_id, ciphertext: last.ciphertext, createdAt: last.created_at } : null;
    out.lastMessageAt = last ? last.created_at : s.created_at;
  }
  return out;
}
// What one member sees of a server: channels they can view (with their permissions), roles, emoji, theme.
function serializeServer(s, uid, common = serverCommon(s)) {
  const myBase = perms.base(s, uid);
  const manage = (myBase & (PM.MANAGE_ROLES | PM.MANAGE_CHANNELS)) !== 0;
  const channels = common.channels
    .map((c) => ({ c, p: perms.channel(s, c, uid) }))
    .filter(({ p }) => p & PM.VIEW_CHANNEL)
    .map(({ c, p }) => ({
      ...serializeChannel(c), perms: p,
      overrides: manage ? db.prepare('SELECT target_type AS type, target_id AS id, allow, deny FROM channel_overrides WHERE channel_id = ?').all(c.id) : undefined,
    }));
  const out = {
    id: s.id, name: s.name, icon: s.icon, ownerId: s.owner_id, kind: s.kind || 'server', channels, memberIds: common.memberIds,
    roleDefs: common.roleDefs, memberRoles: common.memberRoles, myPerms: myBase, emojis: common.emojis, theme: themeOf(s), description: s.description || '', categoryOrder: common.categoryOrder,
    bots: common.bots, memberships: common.memberships, membershipsOn: common.membershipsOn,
  };
  if (out.kind === 'group') { out.last = common.last; out.lastMessageAt = common.lastMessageAt; }
  return out;
}
// Everyone gets their own view (private channels and permissions differ per person). Every change to roles,
// role permissions, channel overrides or ownership ends here, so this is also where people already in a voice
// channel are checked again (recheckVoice).
const emitServer = (serverId) => {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!row) return;
  recheckVoice(row);
  const online = db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(serverId).map((m) => m.user_id).filter(connected);
  if (!online.length) return;
  const common = serverCommon(row);
  online.forEach((uid) => io.to(`user:${uid}`).emit('server:update', serializeServer(row, uid, common)));
};
// Permissions are checked when someone joins a call, and again here after anything that can change them: whoever
// can no longer see the channel or connect to it (or is no longer a member) leaves the call, and anyone whose
// permission to talk changed is told, so their app turns the mic off (or allows it again).
function recheckVoice(srv) {
  if (!voiceChannels.size) return;
  for (const c of db.prepare("SELECT * FROM channels WHERE server_id = ? AND type = 'voice'").all(srv.id)) {
    const m = voiceChannels.get(c.id);
    if (!m) continue;
    for (const [uid, st] of [...m]) {
      const p = isMember(srv.id, uid) ? perms.channel(srv, c, uid) : 0;
      if (!(p & PM.CONNECT)) { leaveVoice(uid, true); continue; }
      const speak = !!(p & PM.SPEAK);
      if (speak === st.speak) continue;
      st.speak = speak;
      if (!speak) st.muted = true;
      io.to(st.socketId).emit('voice:perms', { channelId: c.id, canSpeak: speak });
      emitVoiceState(c.id);
    }
  }
}

function reactionsFor(ids) {
  const map = {};
  if (!ids.length) return map;
  // In slices: SQLite refuses a query with more than 32766 placeholders. All of a message's reactions are in one
  // slice, so sorting each slice keeps them in the order they were added. Rows are taken one at a time: a page can
  // have hundreds of thousands, and spreading that many into one call overflows the stack.
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${part.map(() => '?').join(',')}) ORDER BY created_at`).iterate(...part)) {
      const list = (map[r.message_id] ||= []);
      let entry = list.find((e) => e.emoji === r.emoji);
      if (!entry) { entry = { emoji: r.emoji, userIds: [] }; list.push(entry); }
      entry.userIds.push(r.user_id);
    }
  }
  return map;
}

function serializeMessage(row, channel, reactions) {
  let reply = null;
  if (row.reply_to) {
    const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.reply_to);
    if (r && r.ciphertext) reply = { id: r.id, authorId: r.author_id, ciphertext: r.ciphertext, epoch: r.epoch };
    else if (r) {
      const rd = unseal(r.body);
      reply = { id: r.id, authorId: r.author_id, content: (rd.content || '').slice(0, 140), hasAttachments: (rd.attachments || []).length > 0 };
    }
  }
  // End-to-end encrypted message: the server only has ciphertext.
  const e2ee = row.ciphertext ? { ciphertext: row.ciphertext, epoch: row.epoch } : null;
  const data = e2ee ? {} : unseal(row.body);
  return {
    id: row.id,
    channelId: row.channel_id,
    serverId: channel.server_id,
    authorId: row.author_id,
    ...(e2ee || { legacy: true, content: data.content || '', attachments: data.attachments || [], ...(data.embed ? { embed: data.embed } : {}), ...(data.bot ? { bot: true } : {}) }),
    replyTo: row.reply_to,
    reply,
    threadId: row.thread_id || null,
    ...threadInfo(row),
    pinnedAt: row.pinned_at || null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    reactions: reactions ? reactions[row.id] || [] : reactionsFor([row.id])[row.id] || [],
  };
}
function threadInfo(row) {
  if (row.thread_id) return {};
  const t = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE thread_id = ?').get(row.id);
  return t.n ? { threadCount: t.n, threadLastAt: t.last } : {};
}

function serializeDmMessage(row, reactions) {
  let reply = null;
  if (row.reply_to) {
    const r = db.prepare('SELECT id, author_id, ciphertext FROM dm_messages WHERE id = ?').get(row.reply_to);
    if (r) reply = { id: r.id, authorId: r.author_id, ciphertext: r.ciphertext };
  }
  return {
    id: row.id,
    dmId: row.dm_id,
    authorId: row.author_id,
    ciphertext: row.ciphertext,
    replyTo: row.reply_to,
    reply,
    pinnedAt: row.pinned_at || null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    reactions: reactions ? reactions[row.id] || [] : reactionsFor([row.id])[row.id] || [],
  };
}

function serializeDm(row, userId) {
  const last = db.prepare('SELECT id, author_id, ciphertext, created_at FROM dm_messages WHERE dm_id = ? ORDER BY id DESC LIMIT 1').get(row.id);
  return {
    id: row.id, userId: row.user_a === userId ? row.user_b : row.user_a, lastMessageAt: row.last_message_at, region: row.rtc_region || null,
    last: last ? { id: last.id, authorId: last.author_id, ciphertext: last.ciphertext, createdAt: last.created_at } : null,
  };
}

function relationshipFor(row, userId) {
  const other = row.requester_id === userId ? row.addressee_id : row.requester_id;
  return {
    userId: other,
    status: row.status,
    direction: row.status === 'accepted' ? 'mutual' : row.requester_id === userId ? 'outgoing' : 'incoming',
  };
}

function voiceStateList(channelId) {
  const m = voiceChannels.get(channelId);
  if (!m) return [];
  return [...m.entries()].map(([userId, s]) => ({ userId, muted: s.muted, deafened: s.deafened, video: !!s.video, screen: !!s.screen }));
}

// ---------------------------------------------------------------- access checks
const isMember = (serverId, userId) => !!db.prepare('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
function requireServer(serverId, userId) {
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!s || !isMember(serverId, userId)) fail(404, 'Server not found.');
  return s;
}
function requireOwner(serverId, userId) {
  const s = requireServer(serverId, userId);
  if (s.owner_id !== userId) fail(403, 'Only the server owner can do that.');
  return s;
}
// ---- permissions (see perms.js)
const can = (s, userId, bit) => (perms.base(s, userId) & bit) === bit;
const canIn = (s, c, userId, bit) => (perms.channel(s, c, userId) & bit) === bit;
function requirePerm(serverId, userId, bit, msg) {
  const s = requireServer(serverId, userId);
  if (!can(s, userId, bit)) fail(403, msg || 'You don\u2019t have permission to do that.');
  return s;
}
const requireAdmin = (serverId, userId) => requirePerm(serverId, userId, PM.MANAGE_CHANNELS, 'You need the Manage Channels permission.');
const serverOf = (c) => db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
// Send a channel event only to people who can see the channel (private channels), else the whole server.
function toChannel(c, except) {
  const srv = serverOf(c);
  if (!srv || !perms.restricted(srv, c)) return except ? except.to(`server:${c.server_id}`) : io.to(`server:${c.server_id}`);
  const rooms = db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(c.server_id).map((r) => r.user_id)
    .filter((u) => perms.channel(srv, c, u) & PM.VIEW_CHANNEL).map((u) => `user:${u}`);
  return rooms.length ? (except ? except.to(rooms) : io.to(rooms)) : { emit() {} };
}
const isBlocked = (a, b) => !!db.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').get(a, b, b, a);
const privacyOf = (row) => { try { return { dms: 'everyone', friendRequests: 'everyone', ...JSON.parse(row.privacy || '{}') }; } catch { return { dms: 'everyone', friendRequests: 'everyone' }; } };
function requireChannel(channelId, userId) {
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!c || !isMember(c.server_id, userId)) fail(404, 'Channel not found.');
  if (!(perms.channel(serverOf(c), c, userId) & PM.VIEW_CHANNEL)) fail(404, 'Channel not found.');
  return c;
}
function requireDm(dmId, userId) {
  const d = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dmId);
  if (!d || (d.user_a !== userId && d.user_b !== userId)) fail(404, 'Conversation not found.');
  return d;
}
function sharesServer(a, b) {
  return !!db.prepare('SELECT 1 FROM members x JOIN members y ON x.server_id = y.server_id WHERE x.user_id = ? AND y.user_id = ? LIMIT 1').get(a, b);
}
function areFriends(a, b) {
  return !!db.prepare(`SELECT 1 FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`).get(a, b, b, a);
}

// ---------------------------------------------------------------- app + uploads
const app = express();
// Real client IPs: X-Forwarded-For only counts when the request comes from a proxy we trust. By default that's
// this machine only (Caddy/nginx on the same host); docker-compose.yml names its own Caddy. See proxytrust.js.
const { trustProxySetting, clientIp, ignoredXffHint, netContext } = require('./proxytrust');
try {
  app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));
} catch (e) {
  throw new Error(`TRUST_PROXY=${process.env.TRUST_PROXY} isn't valid (${e.message}). Use your proxy's addresses or subnets, a number of proxies, or false.`);
}
app.disable('x-powered-by');
const PRIVATE_IP = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '').slice(0, 64);
// Behind a proxy (HTTPS=false) on another address (an older docker-compose.yml, nginx in its own container)
// whose header we now ignore: say so in the log, so a site where everyone suddenly shares one address is
// easy to fix. (Not with HTTPS on: there's no proxy then, and the header can only come from a visitor.) The
// advice never suggests trusting Docker's gateway on its own, which every visitor to port 3000 can come from.
// Once per address (a few at most), so a direct visitor arriving first can't hide the line about the real proxy.
const xffIgnoredNoted = new Set();
function noteIgnoredXff(remote, xff) {
  if (USE_HTTPS || !xff || !PRIVATE_IP.test(String(remote || ''))) return;
  const ip = cleanIp(remote);
  if (xffIgnoredNoted.has(ip) || xffIgnoredNoted.size >= 5) return;
  if (app.get('trust proxy fn')(String(remote), 0)) return;
  xffIgnoredNoted.add(ip);
  console.warn(`  ${ignoredXffHint(ip, netContext())}`);
}
// Behind a proxy (HTTPS=false), refuse plain-HTTP requests that come straight from the internet, so nobody
// can bypass the proxy's HTTPS and send login tokens unencrypted. ALLOW_DIRECT_HTTP=true turns this off.
const directGuard = (remote) => USE_HTTPS || process.env.ALLOW_DIRECT_HTTP === 'true' || PRIVATE_IP.test(String(remote || ''));
app.use((req, res, next) => {
  if (!directGuard(req.socket.remoteAddress)) return res.status(403).type('text').send('Please use the https:// address of this server.');
  noteIgnoredXff(req.socket.remoteAddress, req.headers['x-forwarded-for']);
  next();
});
// Stripe signs the exact bytes it sends, so keep them for that one route.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/pay/')) req.rawBody = buf; } }));
// Strict browser security policy for the app's own pages:
//   scripts       only files from this server (+ WebAssembly for password hashing) — no inline or injected code
//   connections   only back to this server (its API and live connection), so a bug can't send data elsewhere
//   framing       nobody can put Hearth inside their page (clickjacking); no plugins; forms only post here
//   styles        inline style attributes are allowed (the UI sets colours and sizes that way); CSS can't run code
//   images/media  any https: source, for link previews and profile songs people choose (and blob: for decrypted files)
const CSP_BASE = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "script-src-attr 'none'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' data: blob: https:", "media-src 'self' blob: data: https:",
  "worker-src 'self' blob:", "frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://player.twitch.tv", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'", "manifest-src 'self'",
].join('; ');
// 'self' covers the live connection (wss://) in current browsers; the host is named too for older Safari.
const cspFor = (req) => {
  const host = String(req.headers.host || '').toLowerCase();
  const own = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/.test(host) ? ` wss://${host}${req.secure ? '' : ` ws://${host}`}` : '';
  return `${CSP_BASE}; connect-src 'self'${own}${req.secure ? '; upgrade-insecure-requests' : ''}`;
};
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), microphone=(self), display-capture=(self), fullscreen=(self)');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!req.path.startsWith('/uploads/') && !req.path.startsWith('/media/')) res.setHeader('Content-Security-Policy', cspFor(req));
  // API answers are personal: never cached by browsers or proxies, and other sites can't embed them.
  if (req.path.startsWith('/api/')) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); }
  if (req.path.startsWith('/uploads/')) res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const INLINE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};
const safeExt = (name) => {
  const ext = path.extname(name || '').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
};
const fileName = (ext) => newId() + crypto.randomBytes(6).toString('hex') + ext;

const diskStorage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, fileName(safeExt(file.originalname))),
});
const encryptedStorage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, fileName('.bin')),
});
// Upload kinds. Size limits come from the admin's settings (Admin → Storage & limits), see limited().
const uploadEncrypted = { storage: encryptedStorage };
const uploadImage = {
  storage: diskStorage,
  fileFilter: (req, file, cb) => {
    if (IMAGE_EXT.includes(safeExt(file.originalname)) && /^image\//.test(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, 'Use a PNG, JPG, GIF or WebP image.'));
  },
};

// Every uploaded file is listed with who uploaded it and its size, for storage quotas and the admin's
// Storage tab. Removing a file removes its row.
function recordFile(userId, name, kind, size) {
  if (!userId || !name) return;
  db.prepare('INSERT OR REPLACE INTO user_files (name, user_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?)').run(name, userId, kind, size || 0, now());
}
function removeUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const name = path.basename(url);
  db.prepare('DELETE FROM user_files WHERE name = ?').run(name);
  fs.promises.unlink(path.join(UPLOAD_DIR, name)).catch(() => {});
}

// ---------------------------------------------------------------- upload limits
// fileMb: largest attachment · imageMb: avatars, banners, icons, emoji sources · songMb: profile songs
// quotaMb: total storage per person · dailyMb: uploads per person per 24 hours. 0 = no limit.
// Admins and the owner aren't limited by quota/daily (per-file limits still apply).
const LIMIT_DEFAULTS = { fileMb: MAX_UPLOAD_MB, imageMb: 12, songMb: 10, quotaMb: 1000, dailyMb: 500 };
function uploadLimits() {
  let v = {};
  try { v = JSON.parse(getSetting('uploadLimits') || '{}') || {}; } catch { /* defaults */ }
  const n = (x, d, max) => (Number.isFinite(+x) && +x >= 0 ? Math.min(max, Math.round(+x)) : d);
  return {
    fileMb: Math.max(1, n(v.fileMb, LIMIT_DEFAULTS.fileMb, 2048)), imageMb: Math.max(1, n(v.imageMb, LIMIT_DEFAULTS.imageMb, 100)),
    songMb: Math.max(1, n(v.songMb, LIMIT_DEFAULTS.songMb, 200)), quotaMb: n(v.quotaMb, LIMIT_DEFAULTS.quotaMb, 1e6), dailyMb: n(v.dailyMb, LIMIT_DEFAULTS.dailyMb, 1e6),
  };
}
const MB = 1024 * 1024;
const usedBytes = (uid) => db.prepare('SELECT COALESCE(SUM(size), 0) n FROM user_files WHERE user_id = ?').get(uid).n;
const dayBytes = (uid) => db.prepare('SELECT COALESCE(SUM(size), 0) n FROM user_files WHERE user_id = ? AND created_at > ?').get(uid, now() - 86400000).n;
function quotaOf(uid) {
  const row = getUserRow(uid);
  const lim = uploadLimits();
  const exempt = isInstanceAdmin(uid);
  let quotaMb = exempt ? 0 : (row && row.upload_quota_mb != null ? row.upload_quota_mb : lim.quotaMb);
  const sq = +(getSetting('supporterQuotaMb') || 0);
  if (!exempt && row && row.supporter && row.upload_quota_mb == null && sq && quotaMb && sq > quotaMb) quotaMb = sq;
  // Supporters can also send bigger files, if the owner set that perk (Admin → Money).
  const sf = row && row.supporter ? MONEY.supporterFileMb() : 0;
  if (sf > lim.fileMb) lim.fileMb = sf;
  return { ...lim, quotaMb, dailyMb: exempt ? 0 : lim.dailyMb, used: usedBytes(uid), today: dayBytes(uid), blocked: !!(row && row.uploads_blocked), exempt };
}
const fmtMb = (b) => `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`;
// The final word on quota and daily allowance, once the file's real size is known. Uploads that ran at the same
// time all started from the same "used" figure; this runs (with recordFile right after it) without any await in
// between, so whichever finishes first takes the room and the others are refused.
function overLimit(uid, q, size) {
  if (q.quotaMb) {
    const used = usedBytes(uid);
    if (used + size > q.quotaMb * MB) return new HttpError(413, `That would go over your storage limit. You have ${fmtMb(Math.max(0, q.quotaMb * MB - used))} left of ${q.quotaMb} MB.`, 'quota');
  }
  if (q.dailyMb) {
    const today = dayBytes(uid);
    if (today + size > q.dailyMb * MB) return new HttpError(413, `That would go over today\u2019s upload limit. You have ${fmtMb(Math.max(0, q.dailyMb * MB - today))} left today.`, 'quota');
  }
  return null;
}
// Public pictures lose their hidden metadata (EXIF, GPS position, XMP…) before anyone can download them;
// see server/imagemeta.js. That runs in a worker thread, so a big (or hostile) picture can't hold up the server.
// A picture that can't be cleaned is refused rather than kept with its metadata.
async function stripUploadedImage(file) {
  try {
    const size = await stripFile(file.path);
    if (size != null) file.size = size;
  } catch (e) {
    if (e instanceof ImageRejected) throw new HttpError(400, 'That picture couldn\u2019t be checked for hidden data (like a GPS position), so it wasn\u2019t saved. Save it again as a normal JPG or PNG and try once more.', 'bad_image');
    throw new HttpError(503, 'Pictures can\u2019t be saved right now. Try again in a moment.');
  }
}
// Text fields that come with an upload (a name, a crop, a title…). Without these limits multer keeps any number
// of fields of up to 1 MB each in memory, so a single request could use up the server's memory.
const FORM_LIMITS = { fields: 8, fieldSize: 16 * 1024, parts: 10 };
const FORM_ERRORS = new Set(['LIMIT_FIELD_COUNT', 'LIMIT_FIELD_VALUE', 'LIMIT_FIELD_KEY', 'LIMIT_PART_COUNT']);
const MAX_PARALLEL_UPLOADS = 4; // per person; the app sends files one after another
const uploading = new Map(); // userId -> uploads in progress
const PUBLIC_KINDS = new Set(['image', 'gif']); // pictures anyone can download: their metadata is removed
// Wraps multer: refuses blocked accounts, caps the size at whatever is smallest of the per-file limit,
// the space left in the person's quota and what's left of today's allowance, and records the file.
// If the request then fails, the file is removed again so it doesn't count against anyone.
// kind: file (encrypted attachments), image, song, or gif (the server's GIF library, LIB_MAX_MB each).
function limited(kind, base, field) {
  const perFile = { file: 'fileMb', image: 'imageMb', song: 'songMb' }[kind];
  const label = { file: 'Files', image: 'Images', song: 'Songs', gif: 'GIFs for the library' }[kind];
  return (req, res, next) => {
    // Counted before the file is received, so a flood never reaches the disk.
    try {
      rateLimit(`up:user:${req.userId}`, 60, 60000);
      rateLimit(`up:userh:${req.userId}`, 600, 3600000);
      rateLimit(`up:session:${req.session.id}`, 40, 60000);
      limitNet(req, 'up', 150, 60000);
    } catch (e) { return next(e); }
    const q = quotaOf(req.userId);
    if (q.blocked) return next(new HttpError(403, 'Uploads are turned off for your account. Ask an admin if you think that\u2019s a mistake.'));
    const perFileMb = kind === 'gif' ? LIB_MAX_MB : q[perFile];
    const fileCap = perFileMb * MB + (kind === 'file' ? MB : 0); // encrypted attachments carry a little overhead
    const quotaLeft = q.quotaMb ? q.quotaMb * MB - q.used : Infinity;
    const dayLeft = q.dailyMb ? q.dailyMb * MB - q.today : Infinity;
    if (quotaLeft <= 0) return next(new HttpError(413, `You\u2019ve used all ${q.quotaMb} MB of your storage. Delete some old files or ask an admin for more room.`, 'quota'));
    if (dayLeft <= 0) return next(new HttpError(413, `You\u2019ve reached today\u2019s upload limit (${q.dailyMb} MB per day). Try again tomorrow.`, 'quota'));
    // A few uploads at a time per person, so parallel requests can't fill the disk before the quota check below.
    const busy = uploading.get(req.userId) || 0;
    if (busy >= MAX_PARALLEL_UPLOADS) return next(new HttpError(429, 'Wait for your other uploads to finish, then try again.', 'busy'));
    uploading.set(req.userId, busy + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (uploading.get(req.userId) || 1) - 1;
      if (n > 0) uploading.set(req.userId, n); else uploading.delete(req.userId);
    };
    res.once('close', release); // also when the sender hangs up halfway
    const cap = Math.max(1, Math.floor(Math.min(fileCap, quotaLeft, dayLeft)));
    multer({ ...base, limits: { ...FORM_LIMITS, fileSize: cap, files: 1 } }).single(field)(req, res, (err) => {
      if (err) release();
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        if (cap >= fileCap) return next(new HttpError(413, `That file is too big. ${label} can be up to ${perFileMb} MB.`));
        if (cap >= dayLeft) return next(new HttpError(413, `That would go over today\u2019s upload limit. You have ${fmtMb(dayLeft)} left today.`, 'quota'));
        return next(new HttpError(413, `That would go over your storage limit. You have ${fmtMb(quotaLeft)} left of ${q.quotaMb} MB.`, 'quota'));
      }
      if (err && FORM_ERRORS.has(err.code)) return next(new HttpError(400, 'That upload has more (or longer) form fields than this server accepts.', 'form_limit'));
      if (err) return next(err);
      const file = req.file;
      if (!file) { release(); return next(); }
      // Still counted as in progress while the picture is cleaned, so the disk can't fill up meanwhile.
      const cleaned = PUBLIC_KINDS.has(kind) && file.path ? stripUploadedImage(file) : Promise.resolve();
      cleaned.then(() => {
        release();
        try {
          // No await from here to recordFile(): see overLimit().
          const over = overLimit(req.userId, q, file.size);
          if (over) {
            if (file.path) fs.promises.unlink(file.path).catch(() => {});
            return next(over);
          }
          recordFile(req.userId, file.filename, kind === 'file' ? 'attachment' : kind, file.size);
        } catch (e) {
          if (file.path) fs.promises.unlink(file.path).catch(() => {});
          return next(e);
        }
        res.on('finish', () => { if (res.statusCode >= 400) removeUpload('/uploads/' + file.filename); });
        next();
      }, (e) => {
        release();
        if (file.path) fs.promises.unlink(file.path).catch(() => {});
        next(e);
      });
    });
  };
}
// Admin-wide word filter for text the server can read: names, bios, profile pages and profile comments.
// (Chats are end-to-end encrypted, so they can't be filtered here.)
const blockedWords = () => { try { return JSON.parse(getSetting('blockedWords') || '[]'); } catch { return []; } };
function checkWords(...texts) {
  const words = blockedWords();
  if (!words.length) return;
  const hay = texts.flat(3).filter((t) => typeof t === 'string').join('\n').toLowerCase();
  for (const w of words) {
    const esc = w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(hay)) fail(400, 'That contains a word that isn\u2019t allowed on this server.');
  }
}
// An admin can freeze someone's profile (after abuse) so it can't be changed until unlocked.
function requireUnlocked(uid) {
  const r = getUserRow(uid);
  if (r && r.profile_locked) fail(403, 'An admin has locked your profile, so it can\u2019t be changed right now.');
}

// Encrypted attachments are opaque blobs. The sender lists the blob URLs (not their contents) when
// posting, so only the uploader can attach a blob and deleting a message removes its files.
function attachBlobs(files, userId, messageId) {
  if (!Array.isArray(files)) return;
  const stmt = db.prepare('UPDATE blobs SET message_id = ? WHERE name = ? AND uploader_id = ? AND message_id IS NULL');
  files.slice(0, 20).forEach((u) => { // up to 10 attachments, each with a thumbnail
    if (typeof u === 'string' && /^\/uploads\/[a-z0-9]+\.bin$/.test(u)) stmt.run(messageId, path.basename(u), userId);
  });
}
function removeMessageFiles(messageIds) {
  if (!messageIds.length) return;
  for (let i = 0; i < messageIds.length; i += 500) {
    const ids = messageIds.slice(i, i + 500);
    const q = ids.map(() => '?').join(',');
    db.prepare(`SELECT name FROM blobs WHERE message_id IN (${q})`).all(...ids).forEach((b) => removeUpload('/uploads/' + b.name));
    db.prepare(`DELETE FROM blobs WHERE message_id IN (${q})`).run(...ids);
    // Older, server-encrypted messages keep their attachment list in the sealed body.
    db.prepare(`SELECT body FROM messages WHERE id IN (${q}) AND ciphertext IS NULL`).all(...ids)
      .forEach((m) => (unseal(m.body).attachments || []).forEach((a) => removeUpload(a.url)));
  }
}
// Everything that hangs off messages: their files, reactions and poll votes. These tables have no foreign key to
// the messages (channel and DM messages share them), so every way of deleting messages calls this first.
function forgetMessages(messageIds) {
  if (!messageIds.length) return;
  removeMessageFiles(messageIds);
  for (let i = 0; i < messageIds.length; i += 500) {
    const ids = messageIds.slice(i, i + 500);
    const q = ids.map(() => '?').join(',');
    for (const t of ['reactions', 'poll_votes', 'poll_closed']) db.prepare(`DELETE FROM ${t} WHERE message_id IN (${q})`).run(...ids);
  }
}
// Before a server or group is deleted: its messages' files, reactions and votes, and its own pictures (icon,
// banner, background, emoji). The database cascade removes the rows, but not files or quota bookkeeping.
function purgeServerContent(s) {
  forgetMessages(db.prepare('SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ?').all(s.id).map((r) => r.id));
  const th = themeOf(s);
  [s.icon, th.banner, th.background && th.background.image, ...db.prepare('SELECT url FROM emojis WHERE server_id = ?').all(s.id).map((e) => e.url)]
    .forEach((u) => { if (typeof u === 'string') removeUpload(u); });
}
// Deletes a channel message, with its thread's replies if it starts one, their reactions, poll votes and files. The rows
// are picked with subqueries (a thread can have more replies than SQLite allows placeholders in one query) and go in
// one transaction; the files are removed only once that has committed, so a failure can't leave a message behind
// whose attachments are already gone.
function deleteMessageTree(id) {
  const tree = 'SELECT id FROM messages WHERE id = ? OR thread_id = ?';
  const files = db.prepare(`SELECT name FROM blobs WHERE message_id IN (${tree})`).all(id, id).map((b) => '/uploads/' + b.name);
  // Older, server-encrypted messages keep their attachment list in the sealed body.
  db.prepare('SELECT body FROM messages WHERE (id = ? OR thread_id = ?) AND ciphertext IS NULL').all(id, id)
    .forEach((m) => (unseal(m.body).attachments || []).forEach((a) => files.push(a.url)));
  db.transaction(() => {
    db.prepare(`DELETE FROM blobs WHERE message_id IN (${tree})`).run(id, id);
    for (const x of ['reactions', 'poll_votes', 'poll_closed']) db.prepare(`DELETE FROM ${x} WHERE message_id IN (${tree})`).run(id, id);
    db.prepare('DELETE FROM messages WHERE id = ? OR thread_id = ?').run(id, id);
  })();
  files.forEach((u) => removeUpload(u));
}
// Blobs uploaded but never attached to a message (abandoned sends) are removed after a day.
setInterval(() => {
  const old = db.prepare('SELECT name FROM blobs WHERE message_id IS NULL AND created_at < ?').all(Date.now() - 24 * 3600 * 1000);
  old.forEach((b) => removeUpload('/uploads/' + b.name));
  if (old.length) db.prepare('DELETE FROM blobs WHERE message_id IS NULL AND created_at < ?').run(Date.now() - 24 * 3600 * 1000);
}, 3600 * 1000).unref();
// Leftovers whose message is gone: from before the cleanup above existed (groups that emptied out, for example).
// Once shortly after start, then daily.
function sweepOrphans() {
  const gone = (t) => `${t}.message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages WHERE id = ${t}.message_id) AND NOT EXISTS (SELECT 1 FROM dm_messages WHERE id = ${t}.message_id)`;
  const blobs = db.prepare(`SELECT name FROM blobs WHERE ${gone('blobs')}`).all();
  blobs.forEach((b) => removeUpload('/uploads/' + b.name));
  if (blobs.length) db.prepare(`DELETE FROM blobs WHERE ${gone('blobs')}`).run();
  for (const t of ['reactions', 'poll_votes', 'poll_closed']) db.prepare(`DELETE FROM ${t} WHERE ${gone(t)}`).run();
  return blobs.length;
}
setTimeout(() => {
  try { sweepOrphans(); } catch (e) { console.error('Orphan cleanup failed:', e.message); }
  setInterval(() => { try { sweepOrphans(); } catch (e) { console.error('Orphan cleanup failed:', e.message); } }, 24 * 3600 * 1000).unref();
}, +(process.env.ORPHAN_SWEEP_DELAY_MS || 2 * 60 * 1000)).unref();

app.get('/uploads/:file', (req, res) => {
  const f = req.params.file;
  if (!/^[a-z0-9]+(\.[a-z0-9]{1,8})?$/i.test(f)) return res.sendStatus(404);
  const p = path.join(UPLOAD_DIR, f);
  if (!fs.existsSync(p)) return res.sendStatus(404);
  const type = INLINE_TYPES[path.extname(f).toLowerCase()];
  if (type) {
    res.type(type);
  } else {
    res.type('application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
  }
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(p);
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    id: '/', name: brand().name, short_name: brand().name.slice(0, 12),
    description: 'Private, self-hosted chat with end-to-end encryption.',
    start_url: '/?source=app', scope: '/', display: 'standalone', orientation: 'any',
    background_color: '#100e16', theme_color: '#100e16', categories: ['social', 'communication'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Direct messages', url: '/?open=messages', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Friends', url: '/?open=friends', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  });
});
// The service worker is versioned by a hash of the app files, so every update is picked up.
const SW_TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), base + d.name + '/') : [base + d.name]));
}
const APP_ASSETS = ['/', '/manifest.webmanifest', '/vendor/argon2.js', '/socket.io/socket.io.js',
  ...walk(PUBLIC_DIR).filter((f) => /^(js|css|icons)\//.test(f) || f === 'favicon.svg').map((f) => '/' + f)];
const BUILD = crypto.createHash('sha256').update(walk(PUBLIC_DIR).sort().map((f) => f + fs.readFileSync(path.join(PUBLIC_DIR, f)).length + fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs).join('|')).digest('hex').slice(0, 12);
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript').send(SW_TEMPLATE.replace('__VERSION__', BUILD).replace("'__ASSETS__'", JSON.stringify(APP_ASSETS)));
});
app.get('/download', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'download.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'terms.html')));
// The desktop app's self-updater reads latest.yml (latest-linux.yml…) here, then downloads the installer it
// names. electron-builder writes these next to the installers; GitHub Actions copies them to data/downloads.
// latest*.yml.sig is the publisher's signature over latest*.yml (desktop/build/sign-update.js): apps built
// with a signing key refuse an update without it, whatever this server serves.
const UPDATE_FILE = /^(latest(-mac|-linux)?\.yml(\.sig)?|[\w.-]+\.(exe|blockmap|AppImage|zip|dmg))$/;
app.get('/updates/:file', (req, res) => {
  const name = String(req.params.file);
  if (!UPDATE_FILE.test(name) || name.includes('..')) return res.status(404).send('Not found');
  const file = path.join(DOWNLOADS_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  if (/\.yml(\.sig)?$/.test(name)) res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(file);
});
app.get('/downloads/:file', (req, res) => {
  const hit = listDownloads().find((d) => d.name === req.params.file);
  if (!hit) return res.status(404).send('Not found');
  res.download(path.join(DOWNLOADS_DIR, hit.name), hit.name);
});
// Recall (the study tools, public/recall/) runs inside Hearth in a sandboxed frame: it gets an origin of its own,
// so it can't read Hearth's sign-in or storage, can't connect anywhere, and only Hearth itself may embed it.
// Hearth hands it your decrypted decks and encrypts whatever it sends back (see public/js/recall-host.js).
const RECALL_CSP = ["default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "img-src data: blob:",
  "media-src data: blob:", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'", 'sandbox allow-scripts allow-modals allow-downloads'].join('; ');
app.use('/recall', (req, res, next) => {
  res.setHeader('Content-Security-Policy', RECALL_CSP);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
// The app's text files (JavaScript, styles, pages) are sent compressed, about 4-5x smaller, and kept
// compressed in memory. Behind Caddy this changes nothing; without it, first loads get much faster.
const zlib = require('zlib');
const TEXT_TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const packed = new Map(); // file -> { mtime, tag, raw, br, gzip }
const pickEncoding = (req) => { const ae = String(req.headers['accept-encoding'] || ''); return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null; };
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let rel;
  try { rel = decodeURIComponent(req.path); } catch { return next(); }
  if (rel === '/') rel = '/index.html';
  const type = TEXT_TYPES[path.extname(rel).toLowerCase()];
  const enc = type && pickEncoding(req);
  if (!enc) return next();
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return next();
  let st;
  try { st = fs.statSync(file); } catch { return next(); }
  if (!st.isFile()) return next();
  let e = packed.get(file);
  if (!e || e.mtime !== st.mtimeMs) {
    e = { mtime: st.mtimeMs, tag: `${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}`, raw: fs.readFileSync(file) };
    packed.set(file, e);
  }
  if (!e[enc]) e[enc] = enc === 'br' ? zlib.brotliCompressSync(e.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : zlib.gzipSync(e.raw, { level: 9 });
  const etag = `W/"${e.tag}-${enc}"`;
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', 'public, max-age=0');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('Content-Encoding', enc);
  res.type(type);
  res.setHeader('Content-Length', e[enc].length);
  res.end(req.method === 'HEAD' ? undefined : e[enc]);
});
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
// Argon2id (WebAssembly) for password hardening in the browser, served from the npm package.
const ARGON2_JS = require.resolve('hash-wasm/dist/argon2.umd.min.js');
app.get('/vendor/argon2.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('application/javascript').sendFile(ARGON2_JS);
});

// auth middleware
// Remember which IPs an account uses (for abuse reports). Throttled so it's one write a minute at most.
const ipSeen = new Map();
function recordIp(userId, ip, token) {
  ip = cleanIp(ip);
  if (!ip) return;
  const k = userId + '|' + ip;
  const t = Date.now();
  if (t - (ipSeen.get(k) || 0) < 60000) return;
  ipSeen.set(k, t);
  db.prepare('UPDATE users SET last_ip = ?, last_seen_at = ? WHERE id = ?').run(ip, t, userId);
  db.prepare('INSERT INTO user_ips (user_id, ip, first_seen, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = excluded.last_seen').run(userId, ip, t, t);
  if (token) db.prepare('UPDATE sessions SET ip = ? WHERE token_hash = ?').run(ip, tokenId(token));
}
// IP bans: single addresses or IPv4 ranges (CIDR), checked on sign-up, login, password resets, every signed-in
// request (staff excepted) and live connections. The parsed list is kept until the setting changes.
let banCache = { raw: null, list: [] };
const ipBans = () => {
  const raw = getSetting('ipBans') || '[]';
  if (raw !== banCache.raw) { let list = []; try { list = JSON.parse(raw); } catch { /* none */ } banCache = { raw, list: Array.isArray(list) ? list : [] }; }
  return banCache.list;
};
const BANNED_MSG = 'Access from your network has been blocked by this server\u2019s administrators.';
const ip4num = (ip) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip); return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null; };
function ipBanned(ip) {
  ip = cleanIp(ip);
  for (const b of ipBans()) {
    const [base, bits] = String(b.ip).split('/');
    if (!bits) { if (base === ip) return b; continue; }
    const a = ip4num(ip); const n = ip4num(base); const k = +bits;
    if (a !== null && n !== null && k >= 0 && k <= 32) { const mask = k === 0 ? 0 : (~0 << (32 - k)) >>> 0; if (((a & mask) >>> 0) === ((n & mask) >>> 0)) return b; }
  }
  return null;
}
// Security log: recent failed logins, captcha failures and blocked IPs (kept in memory, newest first).
const securityLog = [];
function secEvent(type, ip, detail = '') {
  securityLog.unshift({ type, ip: cleanIp(ip), detail: String(detail).slice(0, 120), at: Date.now() });
  if (securityLog.length > 500) securityLog.length = 500;
}
const maintenance = () => getSetting('maintenance') || '';
const suspendedMsg = (row) => `This account is suspended${row.suspended_until ? ` until ${new Date(row.suspended_until).toUTCString().replace(/:\d\d GMT$/, ' UTC')}` : ''}${row.suspend_reason ? `: ${row.suspend_reason}` : '.'}`;
// True while the account is suspended. A timed suspension that has run out is lifted here, on first use.
function stillSuspended(row) {
  if (!row || !row.suspended_at) return false;
  if (row.suspended_until && row.suspended_until <= Date.now()) {
    db.prepare('UPDATE users SET suspended_at = NULL, suspend_reason = NULL, suspended_until = NULL WHERE id = ?').run(row.id);
    return false;
  }
  return true;
}
// Sessions are stored by a SHA-256 fingerprint of the token, never the token itself: someone with a copy of
// the database (a stolen backup, say) can't use it to sign in as anyone.
const tokenId = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
// A session ends when it's signed out (revoked), when it hasn't been used for SESSION_IDLE_DAYS (default 60), or
// SESSION_MAX_DAYS (default 365) after sign-in, whichever comes first. Then the person signs in again.
const SESSION_IDLE_MS = Math.max(1, +process.env.SESSION_IDLE_DAYS || 60) * 86400000;
const SESSION_MAX_MS = Math.max(1, +process.env.SESSION_MAX_DAYS || 365) * 86400000;
const sessionLive = (s, t = Date.now()) => !!s && !s.revoked_at && s.expires_at > t && (s.last_used_at || s.created_at) + SESSION_IDLE_MS > t;
const tokenFrom = (req) => { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };
// The session for a sign-in token, only if it still works. A token is 64 hex characters; anything else
// (including a token_hash copied out of a stolen database) never matches.
function sessionFor(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenId(token));
  return sessionLive(s) ? s : null;
}
function createSession(req, userId, { mfa = false } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const t = now();
  db.prepare(`INSERT INTO sessions (id, token_hash, user_id, created_at, last_used_at, expires_at, ua, ip, mfa_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomBytes(12).toString('base64url'), tokenId(token), userId, t, t, t + SESSION_MAX_MS, String(req.headers['user-agent'] || '').slice(0, 300), cleanIp(req.ip), mfa ? t : null);
  recordIp(userId, req.ip, token);
  return token;
}
// Signs sessions out: { id } one session, { except } every other one, or all of them. Open app windows using
// them are disconnected right away (and a sweep every minute catches anything else, like expiry).
function revokeSessions(userId, { id = null, except = null, reason = 'signed_out' } = {}) {
  const t = now();
  const where = id ? 'AND id = ?' : except ? 'AND id != ?' : '';
  const args = id ? [id] : except ? [except] : [];
  const ids = db.prepare(`SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL ${where}`).all(userId, ...args).map((r) => r.id);
  if (!ids.length) return 0;
  db.prepare(`UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL ${where}`).run(t, reason, userId, ...args);
  // Their push notifications stop too (a signed-out laptop shouldn't keep showing who messaged you). Ones
  // saved before subscriptions recorded their session can't be told apart, so they go as well; the app
  // turns push back on for the sessions still signed in the next time it starts.
  const dropPush = db.prepare('DELETE FROM push_subs WHERE user_id = ? AND session_id = ?');
  ids.forEach((sid) => dropPush.run(userId, sid));
  db.prepare('DELETE FROM push_subs WHERE user_id = ? AND session_id IS NULL').run(userId);
  const gone = new Set(ids);
  if (io) io.in(`user:${userId}`).fetchSockets().then((socks) => socks.forEach((x) => { if (gone.has(x.data.sid)) { x.emit('session:revoked', { reason }); x.disconnect(true); } })).catch(() => {});
  return ids.length;
}
// Revoked and expired sessions are kept 30 days (so Settings → Sessions can say what happened), then deleted.
setInterval(() => {
  const t = now();
  db.prepare('DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ? OR COALESCE(last_used_at, created_at) < ?')
    .run(t - 30 * 86400000, t - 30 * 86400000, t - SESSION_IDLE_MS - 30 * 86400000);
}, 3600000).unref();
function auth(req, res, next) {
  const token = tokenFrom(req);
  const s = sessionFor(token);
  if (!s) return res.status(401).json({ error: 'Not signed in.', code: 'signed_out' });
  const u = db.prepare('SELECT id, suspended_at, suspend_reason, suspended_until, deleted_at FROM users WHERE id = ?').get(s.user_id);
  if (!u || u.deleted_at) return res.status(401).json({ error: 'Not signed in.', code: 'signed_out' });
  if (stillSuspended(u)) return res.status(403).json({ error: suspendedMsg(u), code: 'suspended' });
  // Logging out always works: it only takes access away, and an app turned away here would drop its copy of the
  // token while the session stayed live on the server.
  const loggingOut = req.path === '/auth/logout';
  // A ban covers people who were already signed in, too (staff excepted, so nobody locks the admins out).
  if (!loggingOut && ipBanned(req.ip) && !isStaff(s.user_id)) { secEvent('blocked_ip', req.ip, req.path); return res.status(403).json({ error: BANNED_MSG, code: 'ip_banned' }); }
  if (!loggingOut && maintenance() && !isStaff(s.user_id) && !req.path.startsWith('/config')) return res.status(503).json({ error: maintenance(), code: 'maintenance' });
  req.userId = s.user_id;
  req.token = token;
  req.session = s;
  if (!s.last_used_at || Date.now() - s.last_used_at > 60000) db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(Date.now(), s.id);
  recordIp(s.user_id, req.ip, token);
  next();
}

const api = express.Router();
app.use('/api', api);
// Bigger API answers (the start-up data, message history) go out gzip-compressed.
api.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return json(body);
    const text = JSON.stringify(body);
    if (text === undefined || text.length < 4096) return json(body);
    const send = (buf) => {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.type('application/json');
      res.end(buf);
    };
    if (text.length < 256 * 1024) return send(zlib.gzipSync(text, { level: 4 }));
    // Big answers are compressed off the main thread, so everyone else's requests don't wait for it.
    zlib.gzip(text, { level: 4 }, (err, buf) => {
      if (res.headersSent) return;
      if (err) { res.type('application/json'); return res.end(text); }
      send(buf);
    });
    return res;
  };
  next();
});

// ---------------------------------------------------------------- public config
// ---------------------------------------------------------------- installable app: push, manifest, service worker, downloads
const webpush = require('web-push');
const netguard = require('./netguard');
let vapid = null;
try {
  const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  else if (fs.existsSync(VAPID_FILE)) vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  else { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 }); }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
} catch (e) { console.warn('Push notifications are off:', e.message); vapid = null; }

const nameOf = (uid) => { const r = getUserRow(uid); return r ? (parseProfile(r).displayName || r.username) : 'Someone'; };
// A push endpoint is a web address the app hands us, so sending to it is an outbound request like a feed and
// goes through netguard (public addresses only, pinned, with a deadline and a cap on the answer).
// PUSH_ALLOW_PRIVATE=1 is for tests, or a push service on your own network.
const PUSH_ALLOW_PRIVATE = process.env.PUSH_ALLOW_PRIVATE === '1';
const PUSH_MAX_PER_USER = 10; // phones, browsers, desktop apps; turning push on somewhere new drops the oldest
const PUSH_TIMEOUT_MS = 10000;
// Sending is shared out fairly, so an account whose push services never answer can't hold up everyone else's
// notifications: the people with something waiting take turns, and only so many sends are in flight at once
// for the whole server, for one person's devices, and to one push service.
const PUSH_CONCURRENCY = 16;
const PUSH_PER_USER = 2;
const PUSH_PER_HOST = 8;
const PUSH_WAITING_PER_USER = 30; // past this, the oldest notification still waiting for that person goes
const PUSH_QUEUE_MAX = 5000; // for everyone together (a push service that's down, a flood)
// A push service that times out or can't be reached sits out a while after each failure in a row (1, 2, 4…
// minutes, at most an hour) and is dropped after this many. The app turns push on again when it next starts.
const PUSH_MAX_FAILS = 8;
const pushWaiting = new Map(); // user id → jobs waiting, oldest first; the Map's order is whose turn is next
const pushBusy = { total: 0, user: new Map(), host: new Map() };
let pushWaitingCount = 0;
const bump = (m, k, d) => { const n = (m.get(k) || 0) + d; if (n > 0) m.set(k, n); else m.delete(k); };
const pushHost = (endpoint) => { try { return new URL(endpoint).hostname.toLowerCase(); } catch { return ''; } };
const dropPushSub = (endpoint) => db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
const pushUserOk = (row) => !!row && !row.deleted_at && !stillSuspended(row);
// A subscription belongs to the session that turned it on: once that session is signed out, revoked or
// expired, the device gets nothing more. Subscriptions saved before sessions were recorded go along with the
// account's sessions as a whole (and are dropped when any of them is signed out; the app re-subscribes).
function pushSubLive(uid, sub, t = now()) {
  if (sub.session_id) return sessionLive(db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sub.session_id, uid), t);
  return db.prepare('SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL').all(uid).some((x) => sessionLive(x, t));
}
function pushSubsFor(uid) {
  const t = now();
  return db.prepare('SELECT * FROM push_subs WHERE user_id = ? ORDER BY created_at DESC').all(uid).filter((sub) => {
    if (!pushSubLive(uid, sub, t)) { dropPushSub(sub.endpoint); return false; }
    return !(sub.retry_at > t); // sitting out after failed sends
  }).slice(0, PUSH_MAX_PER_USER);
}
function queuePush(uid, sub, payload) {
  let jobs = pushWaiting.get(uid);
  // A newer notification for the same device and conversation takes the place of one still waiting (the
  // device would replace it on screen anyway), so a flood of messages is still one send per device.
  const same = jobs && jobs.find((j) => j.endpoint === sub.endpoint && j.payload.tag === payload.tag);
  if (same) { same.payload = payload; return; }
  if (!jobs) {
    if (pushWaitingCount >= PUSH_QUEUE_MAX) return;
    jobs = []; pushWaiting.set(uid, jobs);
  } else if (jobs.length >= PUSH_WAITING_PER_USER) { jobs.shift(); pushWaitingCount--; } else if (pushWaitingCount >= PUSH_QUEUE_MAX) return;
  jobs.push({ uid, endpoint: sub.endpoint, host: pushHost(sub.endpoint), payload });
  pushWaitingCount++;
}
function pumpPush() {
  for (let started = true; started && pushBusy.total < PUSH_CONCURRENCY;) {
    started = false;
    // One send per person per round, in turn.
    for (const [uid, jobs] of [...pushWaiting]) {
      if (pushBusy.total >= PUSH_CONCURRENCY) break;
      if ((pushBusy.user.get(uid) || 0) >= PUSH_PER_USER) continue;
      const i = jobs.findIndex((j) => (pushBusy.host.get(j.host) || 0) < PUSH_PER_HOST);
      if (i < 0) continue;
      const [job] = jobs.splice(i, 1);
      pushWaitingCount--;
      pushWaiting.delete(uid);
      if (jobs.length) pushWaiting.set(uid, jobs); // back of the line
      pushBusy.total++; bump(pushBusy.user, uid, 1); bump(pushBusy.host, job.host, 1);
      started = true;
      sendPush(job).catch(() => {}).finally(() => {
        pushBusy.total--; bump(pushBusy.user, uid, -1); bump(pushBusy.host, job.host, -1);
        setImmediate(pumpPush);
      });
    }
  }
}
async function sendPush({ uid, endpoint, payload }) {
  // Checked again now, not only when it was queued: a device signed out (or an account suspended) while this
  // waited gets nothing.
  const sub = db.prepare('SELECT * FROM push_subs WHERE endpoint = ? AND user_id = ?').get(endpoint, uid);
  if (!sub || !pushUserOk(getUserRow(uid)) || sub.retry_at > now()) return;
  if (!pushSubLive(uid, sub)) { dropPushSub(endpoint); return; }
  let details;
  // web-push only encrypts the payload and signs the VAPID header here; the request itself goes through
  // netguard, never through web-push's own (unguarded, unbounded) https.request.
  try {
    details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys) }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' });
  } catch { dropPushSub(sub.endpoint); return; } // keys that can never work
  try {
    const r = await netguard.request(details.endpoint, { method: details.method, headers: details.headers, body: details.body, protocols: ['https:'], allowPrivate: PUSH_ALLOW_PRIVATE,
      maxRedirects: 0, timeout: PUSH_TIMEOUT_MS, maxBytes: 64 * 1024, truncate: true, decompress: false });
    if (r.status === 404 || r.status === 410) dropPushSub(sub.endpoint); // the browser unsubscribed
    else if (sub.fails) db.prepare('UPDATE push_subs SET fails = 0, retry_at = NULL WHERE endpoint = ?').run(sub.endpoint);
  } catch (e) {
    // Its host now points inside a private network (or it was never a usable address): stop trying it.
    if (['PRIVATE', 'BAD_URL', 'BAD_PROTOCOL'].includes(e.code)) dropPushSub(sub.endpoint);
    else if (e.code === 'TIMEOUT' || e.code === 'NETWORK') pushFailed(sub.endpoint);
  }
}
function pushFailed(endpoint) {
  db.prepare('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').run(endpoint);
  const row = db.prepare('SELECT fails FROM push_subs WHERE endpoint = ?').get(endpoint);
  if (!row) return;
  if (row.fails >= PUSH_MAX_FAILS) { dropPushSub(endpoint); return; }
  db.prepare('UPDATE push_subs SET retry_at = ? WHERE endpoint = ?').run(now() + Math.min(60000 * 2 ** (row.fails - 1), 3600000), endpoint);
}
// Notify people who have no Hearth window open. Message contents are end-to-end encrypted, so the
// notification only says who and where — never what. It's worked out after the request that caused it has
// been answered and sent a few at a time, so a big group or a slow push service never holds anyone up.
function pushTo(userIds, payload) {
  if (!vapid) return;
  const ids = [...new Set(userIds)];
  setImmediate(() => {
    for (const uid of ids) {
      if ((onlineSockets.get(uid) || new Set()).size) continue;
      const row = getUserRow(uid);
      if (!row || row.status === 'dnd' || !pushUserOk(row)) continue;
      for (const sub of pushSubsFor(uid)) queuePush(uid, sub, payload);
    }
    pumpPush();
  });
}
api.get('/push/key', (req, res) => res.json({ publicKey: vapid ? vapid.publicKey : null }));
api.post('/push/subscribe', auth, wrap(async (req, res) => {
  const sub = (req.body || {}).subscription || {};
  if (!vapid) fail(400, 'Push notifications are turned off on this server.');
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) fail(400, 'Bad subscription.');
  if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') fail(400, 'Bad subscription.');
  rateLimit('pushsub-any:' + req.userId, 60, 3600000);
  // The app turns push on again each time it starts. An endpoint this account already has was checked when it
  // was saved (and every send checks it again), so only new ones are looked up and count toward this limit.
  if (!db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ? AND user_id = ?').get(sub.endpoint, req.userId)) {
    rateLimit('pushsub:' + req.userId, 10, 3600000);
    // Push services are public https sites. (Each send checks again, pinned, since DNS answers can change.)
    try { await netguard.checkPublicUrl(sub.endpoint, { protocols: ['https:'], allowPrivate: PUSH_ALLOW_PRIVATE }); } catch (e) { fail(400, e.code === 'NOT_FOUND' ? 'Bad subscription: its push service couldn’t be found.' : 'Bad subscription.'); }
  }
  db.transaction(() => {
    // Saving it again keeps its count of failed sends: subscribing again doesn't restart a dead push service's back-off.
    db.prepare(`INSERT INTO push_subs (endpoint, user_id, keys, ua, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys, ua = excluded.ua, created_at = excluded.created_at, session_id = excluded.session_id`)
      .run(sub.endpoint, req.userId, JSON.stringify({ p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) }), String(req.headers['user-agent'] || '').slice(0, 300), now(), req.session.id);
    // Only the newest few per account are kept.
    db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)')
      .run(req.userId, req.userId, PUSH_MAX_PER_USER);
  })();
  res.json({ ok: true });
}));
api.post('/push/unsubscribe', auth, (req, res) => {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String((req.body || {}).endpoint || ''), req.userId);
  res.json({ ok: true });
});

// Installers for the desktop app (or anything else) dropped into data/downloads are offered on /download.
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(DATA_DIR, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
const PLATFORM_OF = [[/\.(exe|msi|msix)$/i, 'windows'], [/\.(dmg|pkg)$/i, 'mac'], [/\.(appimage|deb|rpm|tar\.gz|snap|flatpak)$/i, 'linux'], [/\.apk$/i, 'android']];
function listDownloads() {
  try {
    return fs.readdirSync(DOWNLOADS_DIR).map((name) => {
      const hit = PLATFORM_OF.find(([re]) => re.test(name));
      if (!hit || name.startsWith('.')) return null;
      const st = fs.statSync(path.join(DOWNLOADS_DIR, name));
      return { name, platform: hit[1], size: st.size, at: st.mtimeMs, url: '/downloads/' + encodeURIComponent(name) };
    }).filter(Boolean).sort((a, b) => b.at - a.at); // newest first
  } catch { return []; }
}

api.get('/config', (req, res) => {
  res.json({
    version: require('../package.json').version,
    announcement: (() => { try { return JSON.parse(getSetting('announcement') || 'null'); } catch { return null; } })(),
    maintenance: maintenance() || null,
    pushEnabled: !!vapid,
    downloads: listDownloads(),
    desktopUrl: process.env.DESKTOP_DOWNLOAD_URL || null,
    name: brand().name,
    tagline: brand().tagline,
    features: features(),
    funding: fundingPublic(),
    support: MONEY.available(),
    emailEnabled: !!(ACCT && ACCT.mailReady()),
    registrationOpen: regMode() !== 'closed',
    registrationRequiresCode: regMode() === 'code',
    termsVersion: termsInfo().version || 0,
    gifsEnabled: true, // the server's own library always works
    gifLibraryOnly: !gifKey(),
    gifProvider: gifProvider(),
    gifProxy: gifProxyOn(),
    maxUploadMb: uploadLimits().fileMb,
    imageMb: uploadLimits().imageMb,
    songMb: uploadLimits().songMb,
    iceServers: [iceServers[0]], // STUN only here; TURN relay details are given to signed-in users
  });
});

// ---------------------------------------------------------------- auth
// The browser never sends the raw password: it derives an "auth key" with PBKDF2 and a separate
// key that wraps the user's private E2EE key. The server only stores a bcrypt hash of the auth key
// and the wrapped private key, so it can never decrypt DMs.
const USERNAME_RE = /^[a-zA-Z0-9_.]{2,24}$/;
const isB64ish = (s, max) => typeof s === 'string' && s.length > 10 && s.length <= max;
const isSalt = (s) => typeof s === 'string' && /^[A-Za-z0-9+/=]{20,64}$/.test(s);

// Which password-hashing scheme and salt to use for a username. For unknown usernames we return a
// stable fake salt so this endpoint doesn't reveal which accounts exist.
api.get('/auth/params', (req, res) => {
  limitNet(req, 'params', 60, 60 * 1000); // per network: rotating addresses inside one IPv6 /64 doesn't get around it
  const username = String(req.query.username || '').slice(0, 24);
  const row = db.prepare('SELECT kdf, kdf_salt FROM users WHERE username = ?').get(username);
  if (row && row.kdf === 'argon2id') return res.json({ kdf: 'argon2id', salt: row.kdf_salt });
  if (row) return res.json({ kdf: 'pbkdf2' });
  const salt = crypto.createHmac('sha256', atRestKey).update('kdf-salt:' + username.toLowerCase()).digest().subarray(0, 16).toString('base64');
  res.json({ kdf: 'argon2id', salt });
});

// Banned IPs can't sign up, log in, reset a password (which hands out a new session) or connect.
api.use(['/auth/register', '/auth/login', '/auth/forgot', '/auth/reset'], (req, res, next) => {
  const b = ipBanned(req.ip);
  if (b) { secEvent('blocked_ip', req.ip, req.path); return res.status(403).json({ error: BANNED_MSG, code: 'ip_banned' }); }
  next();
});
api.post('/auth/register', wrap(async (req, res) => {
  limitNet(req, 'reg', 5, 60 * 60 * 1000);
  rateLimit('reg:day:' + netOf(req.ip), 10, 24 * 60 * 60 * 1000);
  const mode = regMode();
  if (mode === 'closed') fail(403, 'Registration is closed on this server.');
  const { username, authKey, publicKey, encPrivateKey, code, kdfSalt, acceptTos } = req.body || {};
  if (mode === 'code' && (!regCode() || typeof code !== 'string' || !safeEqual(code, regCode()))) fail(403, 'That registration code is not right.');
  const tos = termsInfo();
  if (tos.version && +acceptTos !== tos.version) fail(400, 'Please read and accept the Terms of Service to create an account.');
  verifyCaptcha((req.body || {}).captcha, 'register', req.ip);
  // Slows bot floods across many IPs: past the instance-wide limit the robot check gets harder for everyone,
  // rather than turning everyone away (see busyBits). Counted only after the check, so requests without a
  // solved one don't count at all.
  countInstanceWide('register');
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) fail(400, 'Usernames are 2–24 characters: letters, numbers, _ and . only.');
  if (typeof authKey !== 'string' || !/^[0-9a-f]{64}$/.test(authKey)) fail(400, 'Bad auth key.');
  if (!isB64ish(publicKey, 2000) || !isB64ish(encPrivateKey, 4000)) fail(400, 'Bad key material.');
  if (!isSalt(kdfSalt)) fail(400, 'This page is out of date. Reload and try again.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'That username is taken.');
  // An ADMIN_USERS name its account renamed away from (or deleted) is still that account's: it brings admin powers.
  if (envAdmins().includes(username.toLowerCase()) && envClaims()[username.toLowerCase()]) fail(409, 'That username is reserved.');
  const id = newId();
  const hash = await bcrypt.hash(authKey, 11);
  const profile = sanitizeProfile({ displayName: username });
  try {
    db.prepare(`INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, profile, created_at, kdf, kdf_salt, tos_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'argon2id', ?, ?)`).run(id, username, hash, publicKey, encPrivateKey, JSON.stringify(profile), now(), kdfSalt, tos.version || null);
  } catch (e) {
    // Two sign-ups for the same name at the same moment: the second one loses.
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) fail(409, 'That username is taken.');
    throw e;
  }
  // The first account to take a free ADMIN_USERS name keeps it for good; and the very first account settles who
  // owns the server (nothing awaits between the insert and here, so two sign-ups can't both claim).
  claimEnvAdmin(getUserRow(id));
  settleOwnerAtFirstSignUp();
  const token = createSession(req, id);
  addSupportFriend(id);
  res.json({ token, user: selfUser(getUserRow(id)), encPrivateKey, device: deviceNote(getUserRow(id)) });
}));

// Compared against when the username doesn't exist, so a wrong username takes as long as a wrong password
// (otherwise the response time would tell which accounts exist).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 11);
// "This device has signed in to this account before": a note the app keeps after signing in and shows again
// next time, so an account's own devices get their own sign-in limit wherever they are (a phone's address
// changes all the time). It's signed with the server's key over the account and its current password hash, so
// it can't be made up, works for no other account, and stops counting once the password changes.
const deviceSig = (row, n) => crypto.createHmac('sha256', atRestKey).update(`login-device|${row.id}|${n}|${row.auth_hash}`).digest('base64url').slice(0, 22);
function deviceKnown(row, note) {
  const [n, sig, extra] = String(note || '').split('.');
  if (!/^[\w-]{22}$/.test(n || '') || !/^[\w-]{22}$/.test(sig || '') || extra !== undefined) return null;
  return safeEqual(sig, deviceSig(row, n)) ? n : null;
}
function deviceNote(row, keep = null) {
  const n = keep || crypto.randomBytes(16).toString('base64url');
  return `${n}.${deviceSig(row, n)}`;
}
// A network this account has been used from (IPv6: the same /64, since devices pick a new address in it
// every day or so).
function knownNetwork(uid, ip) {
  const net = netOf(ip);
  if (!net.includes(':')) return !!db.prepare('SELECT 1 FROM user_ips WHERE user_id = ? AND ip = ?').get(uid, net);
  return db.prepare("SELECT ip FROM user_ips WHERE user_id = ? AND ip LIKE '%:%' ORDER BY last_seen DESC LIMIT 1000").all(uid).some((r) => netOf(r.ip) === net);
}
api.post('/auth/login', wrap(async (req, res) => {
  limitNet(req, 'login', 20, 10 * 60 * 1000);
  // The robot check comes before every shared limit: a request without a solved one is turned away here, so
  // junk can't use up the instance-wide limit or an account's own (which would lock real people out).
  verifyCaptcha((req.body || {}).captcha, 'login', req.ip);
  const { username, authKey } = req.body || {};
  const name = typeof username === 'string' ? username.slice(0, 40) : '';
  const row = name ? db.prepare('SELECT * FROM users WHERE username = ?').get(name) : null;
  // Per-account limits too, so guessing one person's password from many IPs is slowed down. Attempts from the
  // account's own devices and from networks it has been used from are counted apart (per device or network,
  // per day), so nobody can lock a person out of their usual devices by spamming from somewhere else.
  // (The name is encoded so a made-up one like "day:alice" can't land in alice's buckets.)
  const lname = Buffer.from(name.toLowerCase()).toString('base64url');
  const device = row && deviceKnown(row, (req.body || {}).device);
  const known = device ? 'd:' + device : row && knownNetwork(row.id, req.ip) ? netOf(req.ip) : null;
  if (known) rateLimit(`loginuser:known:${lname}:${known}`, 100, 24 * 60 * 60 * 1000);
  else {
    // Password checks are slow on purpose; this keeps a flood from using all the CPU. An account's own devices
    // and networks don't count (there are only so many of those), so a flood never stands in their way.
    countInstanceWide('login');
    rateLimit('loginuser:' + lname, 10, 15 * 60 * 1000);
    rateLimit('loginuser:day:' + lname, 100, 24 * 60 * 60 * 1000);
  }
  const key = typeof authKey === 'string' ? authKey.slice(0, 128) : '';
  const ok = await bcrypt.compare(key, row ? row.auth_hash : DUMMY_HASH);
  if (!ok || !row || row.is_bot || row.deleted_at) { noteAuthFailure(req.ip); secEvent('failed_login', req.ip, name); fail(401, 'Wrong username or password.'); }
  if (maintenance() && !isStaff(row.id)) fail(503, maintenance(), 'maintenance');
  if (stillSuspended(row)) fail(403, suspendedMsg(row), 'suspended');
  // Two-factor sign-in: the right password isn't enough on its own.
  ACCT.require2fa(row, req.body, req);
  const token = createSession(req, row.id, { mfa: !!row.totp_enabled });
  res.json({ token, user: selfUser(row), encPrivateKey: row.enc_private_key, device: deviceNote(row, device) });
}));

api.post('/auth/logout', auth, (req, res) => {
  revokeSessions(req.userId, { id: req.session.id, reason: 'logged_out' });
  res.json({ ok: true });
});

// "Is it really you?" before sensitive changes: the current password, plus a two-factor code when it's on
// (unless this session passed two-factor in the last 10 minutes, e.g. you just signed in).
async function stepUp(req, body, authKeyField = 'authKey') {
  const row = getUserRow(req.userId);
  const b = body || {};
  // 10 tries per 10 minutes, counted before the (slow) check so guesses sent in parallel are limited too. A right
  // password gives its try back, so an owner confirming a run of team or backup changes isn't locked out.
  const limitKey = 'stepup:' + req.userId;
  rateLimit(limitKey, 10, 10 * 60 * 1000);
  const key = b[authKeyField];
  if (typeof key !== 'string' || !(await bcrypt.compare(key.slice(0, 128), row.auth_hash))) { secEvent('failed_stepup', req.ip, row.username); fail(401, 'Your password is not right.', 'bad_password'); }
  const tries = buckets.get(limitKey);
  if (tries && tries.count > 0) tries.count -= 1;
  if (row.totp_enabled && !(req.session.mfa_at && now() - req.session.mfa_at < 10 * 60000)) {
    ACCT.require2fa(row, b, req);
    db.prepare('UPDATE sessions SET mfa_at = ? WHERE id = ?').run(now(), req.session.id);
  }
  return row;
}

// ---------------------------------------------------------------- changing a username
// The old name is free for anyone the moment it changes. Passwords don't depend on the username (the password
// salt is stored per account), except for accounts still on the old pbkdf2 format: those are upgraded at their
// next sign-in and only then can be renamed. Staff powers that come from ADMIN_USERS are tied to the account
// that first held the name, so a rename can't take them away or hand them to someone else.
function renameUser(uid, wanted, beforeWrite) {
  const row = getUserRow(uid);
  if (!row) fail(404, 'User not found.');
  const name = String(wanted || '').trim().replace(/^@/, '');
  if (!USERNAME_RE.test(name)) fail(400, 'Usernames are 2\u201324 characters: letters, numbers, _ and . only.');
  if (name === row.username) return row;
  if (row.kdf !== 'argon2id') fail(400, 'This account still uses the old password format. Sign out and back in once (it upgrades by itself), then try again.');
  const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(name, uid);
  if (taken) fail(409, 'That username is taken.');
  // ADMIN_USERS names: only the account that holds one may take it back (an unclaimed one would bring powers).
  if (name.toLowerCase() !== row.username.toLowerCase() && envNameReserved(name, uid)) fail(409, 'That username is reserved.');
  // Staff powers already belong to the account, not the name: the owner is written down (ownerId) and
  // ADMIN_USERS names are claimed by account id (claimEnvAdmin), so a rename can't move them.
  ownerId();
  if (beforeWrite) beforeWrite();
  try {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, uid);
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) fail(409, 'That username is taken.'); // two people at the same moment
    throw e;
  }
  broadcastUser(uid);
  return getUserRow(uid);
}
// Change your own username: needs your password (and a two-factor code when that's on), like other account changes.
api.post('/me/username', auth, wrap(async (req, res) => {
  rateLimit('rename-try:' + req.userId, 30, 3600 * 1000);
  const before = await stepUp(req, req.body);
  // Three actual changes a day, so a name can't be flipped back and forth to confuse people.
  const row = renameUser(req.userId, (req.body || {}).username, () => rateLimit('rename:' + req.userId, 3, 24 * 3600 * 1000));
  if (row.username !== before.username) {
    secEvent('username_changed', req.ip, `${before.username} -> ${row.username}`);
    ACCT.notify(row, 'your username was changed', `Your username was changed from ${before.username} to ${row.username}. Sign in with the new one from now on. If this wasn't you, change your password now.`);
  }
  res.json(selfUser(row));
}));

api.post('/me/password', auth, wrap(async (req, res) => {
  rateLimit('pw:' + req.userId, 10, 10 * 60 * 1000);
  const { newAuthKey, encPrivateKey, salt, keepSessions } = req.body || {};
  const row = await stepUp(req, req.body, 'oldAuthKey');
  if (typeof newAuthKey !== 'string' || !/^[0-9a-f]{64}$/.test(newAuthKey) || !isB64ish(encPrivateKey, 4000)) fail(400, 'Bad key material.');
  if (!isSalt(salt)) fail(400, 'This page is out of date. Reload and try again.');
  db.prepare(`UPDATE users SET auth_hash = ?, enc_private_key = ?, kdf = 'argon2id', kdf_salt = ? WHERE id = ?`)
    .run(await bcrypt.hash(newAuthKey, 11), encPrivateKey, salt, req.userId);
  ACCT.dropResetLinks(req.userId); // a reset link sent before the change can't be used to undo it
  // Every other device is signed out — except for the automatic hashing upgrade the app does right after
  // signing in to an old-format account (same password). Only a session that has just signed in can ask for
  // that, and it's still logged and emailed: the server can't tell it from a change to a new password.
  const kept = keepSessions === true && row.kdf !== 'argon2id' && now() - req.session.created_at < 10 * 60000;
  if (kept) {
    auditLog(req, 'password_upgraded', req.userId, row.username);
    ACCT.notify(row, 'your password was re-saved', `Someone signed in to ${row.username} and the app re-saved its password in the newer, stronger format (this happens once, at the first sign-in after an update). Other devices stay signed in.`);
  } else {
    revokeSessions(req.userId, { except: req.session.id, reason: 'password_changed' });
    auditLog(req, 'password_changed', req.userId, row.username);
    ACCT.notify(row, 'your password was changed', `The password for ${row.username} was just changed, and every other device was signed out.`);
  }
  res.json({ ok: true });
}));

// Deleting your account. Needs your password (and a two-factor code when it's on). What happens:
//   - you're signed out everywhere, and the account can never sign in again; the username is freed
//   - your keys, email, two-factor, recovery key, profile, pictures, friends, blocks and push devices are erased
//   - you leave every server and group (the others switch to a new server key, as when anyone leaves)
//   - messages you sent stay where they are (still end-to-end encrypted) and show "Deleted user"
// Owners first hand over or delete their servers; the instance owner first hands over ownership.
api.delete('/me', auth, wrap(async (req, res) => {
  rateLimit('deleteme:' + req.userId, 5, 60 * 60 * 1000);
  const row = await stepUp(req, req.body);
  if ((req.body || {}).confirm !== row.username) fail(400, 'Type your username to confirm.', 'confirm');
  if (ownerId() === row.id) fail(400, 'You own this Hearth server. Hand ownership to someone else first (Admin → Team & roles).', 'is_owner');
  const owned = db.prepare("SELECT id, name FROM servers WHERE owner_id = ? AND COALESCE(kind, 'server') != 'group'").all(row.id);
  if (owned.length) fail(400, `First delete or hand over the servers you own: ${owned.map((x) => x.name).join(', ')}.`, 'owns_servers');
  // Who has them on screen, worked out before their servers and friendships go: they all see "Deleted user".
  const audience = userAudience(row.id);
  revokeSessions(row.id, { reason: 'account_deleted' });
  for (const m of db.prepare('SELECT s.id, s.kind, s.owner_id FROM members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = ?').all(row.id)) {
    if (m.kind === 'group' && m.owner_id === row.id) {
      const next = db.prepare('SELECT user_id FROM members WHERE server_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1').get(m.id, row.id);
      if (next) db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(next.user_id, m.id);
    }
    removeMember(m.id, row.id);
    if (m.kind === 'group' && !db.prepare('SELECT 1 FROM members WHERE server_id = ?').get(m.id)) {
      purgeServerContent(db.prepare('SELECT * FROM servers WHERE id = ?').get(m.id));
      db.prepare('DELETE FROM servers WHERE id = ?').run(m.id);
    } else emitServer(m.id);
  }
  const files = [row.avatar, row.banner, row.background, row.song, row.page_bg];
  const friends = db.prepare('SELECT requester_id, addressee_id FROM friendships WHERE requester_id = ? OR addressee_id = ?').all(row.id, row.id);
  db.transaction(() => {
    db.prepare(`UPDATE users SET username = ?, auth_hash = '!', public_key = '', enc_private_key = '', sign_public_key = NULL, enc_sign_private_key = NULL,
      enc_private_key_recovery = NULL, recovery_salt = NULL, email = NULL, email_verified = 0, totp_enabled = 0, totp_secret = NULL, backup_codes = '[]',
      avatar = NULL, banner = NULL, background = NULL, song = NULL, page = NULL, page_bg = NULL, profile = ?, status = 'offline', activity_cfg = '{}',
      last_ip = NULL, support_code = NULL, deleted_at = ? WHERE id = ?`)
      .run(`deleted-${crypto.randomBytes(5).toString('hex')}`, JSON.stringify(sanitizeProfile({ displayName: 'Deleted user' })), now(), row.id);
    for (const t of ['friendships WHERE requester_id = ? OR addressee_id = ?', 'blocks WHERE blocker_id = ? OR blocked_id = ?']) db.prepare(`DELETE FROM ${t}`).run(row.id, row.id);
    for (const t of ['push_subs', 'user_ips', 'auth_tokens', 'server_keys', 'user_feeds', 'study_items', 'event_rsvps']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(row.id);
    db.prepare("UPDATE users SET rail_layout = '', study_enabled = 0 WHERE id = ?").run(row.id);
    const roles = staffRoles();
    if (roles[row.id]) { delete roles[row.id]; saveStaffRoles(roles); }
  })();
  files.forEach((f) => removeUpload(f));
  friends.forEach((f) => emitRelationship(null, f.requester_id, f.addressee_id));
  broadcastUser(row.id, audience);
  io.in(`user:${row.id}`).disconnectSockets(true);
  auditLog(req, 'account_deleted', row.id, row.username);
  ACCT.notify(row, 'your account was deleted', `The account ${row.username} was deleted. This can't be undone.`);
  res.json({ ok: true });
}));

// One-time upload of the user's message-signing key. Its private half is encrypted by the
// browser with a key only the account's own identity key can derive.
api.post('/me/sign-key', auth, wrap(async (req, res) => {
  const { signPublicKey, encSignPrivateKey } = req.body || {};
  if (!isB64ish(signPublicKey, 2000) || !isB64ish(encSignPrivateKey, 4000)) fail(400, 'Bad key material.');
  const row = getUserRow(req.userId);
  if (row.sign_public_key) fail(409, 'You already have a signing key.');
  db.prepare('UPDATE users SET sign_public_key = ?, enc_sign_private_key = ? WHERE id = ?').run(signPublicKey, encSignPrivateKey, req.userId);
  broadcastUser(req.userId);
  res.json(selfUser(getUserRow(req.userId)));
}));

// ---------------------------------------------------------------- bootstrap
api.get('/bootstrap', auth, (req, res) => {
  const uid = req.userId;
  const me = getUserRow(uid);
  if (!me) return res.status(401).json({ error: 'Not signed in.' });
  const servers = db.prepare('SELECT s.* FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY m.joined_at').all(uid).map((x) => serializeServer(x, uid));
  const dms = db.prepare('SELECT * FROM dm_channels WHERE user_a = ? OR user_b = ? ORDER BY last_message_at DESC').all(uid, uid).map((d) => serializeDm(d, uid));
  const relationships = db.prepare('SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?').all(uid, uid).map((r) => relationshipFor(r, uid));
  const ids = new Set([uid]);
  servers.forEach((s) => { s.memberIds.forEach((i) => ids.add(i)); (s.bots || []).forEach((i) => ids.add(i)); });
  dms.forEach((d) => ids.add(d.userId));
  relationships.forEach((r) => ids.add(r.userId));
  const users = {};
  for (const id of ids) { const u = publicUser(getUserRow(id)); if (u) users[id] = u; }
  users[uid] = selfUser(me);
  const voice = {};
  servers.forEach((s) => s.channels.filter((c) => c.type === 'voice').forEach((c) => { voice[c.id] = voiceStateList(c.id); }));
  dms.forEach((d) => { const st = voiceStateList('dm:' + d.id); if (st.length) voice['dm:' + d.id] = st; });
  const keyStates = {};
  servers.forEach((s) => { keyStates[s.id] = keyState(s.id, uid); });
  const blocked = db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?').all(uid).map((r) => r.blocked_id);
  res.json({ iceServers: iceServersFor(uid), termsVersion: termsInfo().version || 0, tosAccepted: me.tos_version || 0, mediaToken: mediaToken(uid, req.session.id), me: selfUser(me), encPrivateKey: me.enc_private_key, encSignPrivateKey: me.enc_sign_private_key, servers, dms, relationships, users, voice, keyStates, blocked });
});

// ---------------------------------------------------------------- profile
// Coming online, going offline and status changes only send the new presence (a few bytes),
// not the whole profile, so a busy server doesn't flood everyone's app.
// Changes are collected for a second and sent as one list, so when hundreds of people reconnect at once
// (after an update, say) it's a handful of messages instead of one per person per person.
const presenceQueue = new Map();
let presenceTimer = null;
function flushPresence() {
  presenceTimer = null;
  const list = [...presenceQueue].map(([id, presence]) => ({ id, presence }));
  presenceQueue.clear();
  if (list.length) io.emit('user:presence', list);
}
function broadcastPresence(userId) {
  const row = getUserRow(userId);
  if (!row) return;
  presenceQueue.set(userId, isOnline(row.id) && row.status !== 'invisible' ? row.status : 'offline');
  if (!presenceTimer) presenceTimer = setTimeout(flushPresence, 1000);
  io.to(`user:${userId}`).emit('user:update', selfUser(row));
}
// Who sees a person in their app: everyone in a server with them, friends and friend requests, and DM partners.
// Profile changes go only there (not to every socket on the instance), and a burst of changes becomes one
// update a second, so one account editing in a loop can't make every open app redraw.
function userAudience(userId) {
  const rooms = db.prepare('SELECT server_id FROM members WHERE user_id = ?').all(userId).map((r) => `server:${r.server_id}`);
  const peers = db.prepare(`SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id FROM friendships WHERE requester_id = ? OR addressee_id = ?
    UNION SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END FROM dm_channels WHERE user_a = ? OR user_b = ?`).all(userId, userId, userId, userId, userId, userId);
  return [...rooms, ...peers.map((p) => `user:${p.id}`)];
}
const userUpdateQueue = new Map(); // user id -> rooms told on top of whoever shares something with them then
let userUpdateTimer = null;
function flushUserUpdates() {
  userUpdateTimer = null;
  const queued = [...userUpdateQueue];
  userUpdateQueue.clear();
  for (const [id, extra] of queued) {
    const row = getUserRow(id);
    const rooms = row ? [...new Set([...extra, ...userAudience(id)])] : [];
    if (rooms.length) io.to(rooms).except(`user:${id}`).emit('user:update', publicUser(row));
  }
}
// audience: rooms worked out before a change that also ends what they shared (deleting an account leaves every
// server and friendship first), so the people who still have that person on screen hear about it too.
function broadcastUser(userId, audience) {
  const row = getUserRow(userId);
  if (!row) return;
  io.to(`user:${userId}`).emit('user:update', selfUser(row)); // their own apps: right away
  const rooms = userUpdateQueue.get(userId) || new Set();
  if (Array.isArray(audience)) audience.forEach((r) => rooms.add(r));
  userUpdateQueue.set(userId, rooms);
  if (!userUpdateTimer) userUpdateTimer = setTimeout(flushUserUpdates, 1000);
}
// Profile edits: plenty for a person saving changes, not enough to flood the instance from a script.
function limitProfileWrites(req) {
  rateLimit('profile:' + req.userId, 30, 60000);
  rateLimit('profileh:' + req.userId, 300, 3600000);
  limitNet(req, 'profile', 120, 60000);
}

api.patch('/me/profile', auth, (req, res) => {
  requireUnlocked(req.userId);
  limitProfileWrites(req);
  const row = getUserRow(req.userId);
  const profile = sanitizeProfile(req.body || {}, parseProfile(row));
  checkWords(profile.displayName, profile.pronouns, profile.bio, profile.aboutMe, profile.headline, profile.mood.text, profile.customStatus.text, profile.interests, profile.songTitle, profile.links.map((l) => l.label));
  if (!profile.displayName) profile.displayName = row.username;
  // Top friends must actually be friends.
  profile.topFriends = profile.topFriends.filter((id) => areFriends(req.userId, id));
  const json = JSON.stringify(profile);
  if (json !== row.profile) { // saving the same thing again changes nothing, so nobody needs telling
    db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(json, req.userId);
    broadcastUser(req.userId);
  }
  res.json(selfUser(getUserRow(req.userId)));
});

api.patch('/me/status', auth, (req, res) => {
  const status = (req.body || {}).status;
  if (!['online', 'idle', 'dnd', 'invisible'].includes(status)) fail(400, 'Unknown status.');
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.userId);
  broadcastPresence(req.userId);
  res.json({ ok: true });
});

const MEDIA_KINDS = { avatar: 'avatar', banner: 'banner', background: 'background', pagebg: 'page_bg' };
function setMediaCrop(userId, kind, c) {
  const row = getUserRow(userId);
  const profile = sanitizeProfile({ [kind + 'Crop']: c }, parseProfile(row));
  db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify(profile), userId);
}
// Profile song (MySpace-style). Plays only when someone presses play on your profile.
const uploadAudio = {
  storage: diskStorage,
  fileFilter: (req, file, cb) => {
    if (['.mp3', '.ogg', '.m4a', '.wav'].includes(safeExt(file.originalname)) && /^audio\//.test(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, `Use an MP3, M4A, OGG or WAV file (up to ${uploadLimits().songMb} MB).`));
  },
};
api.post('/me/song', auth, (req, res, next) => { try { requireUnlocked(req.userId); next(); } catch (e) { next(e); } }, limited('song', uploadAudio, 'file'), (req, res) => {
  if (!req.file) fail(400, 'Choose a song.');
  const row = getUserRow(req.userId);
  db.prepare('UPDATE users SET song = ? WHERE id = ?').run('/uploads/' + req.file.filename, req.userId);
  removeUpload(row.song);
  const title = String((req.body || {}).title || req.file.originalname.replace(/\.[^.]+$/, '')).slice(0, 80);
  db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify(sanitizeProfile({ songTitle: title }, parseProfile(row))), req.userId);
  broadcastUser(req.userId);
  res.json(selfUser(getUserRow(req.userId)));
});
api.delete('/me/song', auth, (req, res) => {
  limitProfileWrites(req);
  const row = getUserRow(req.userId);
  if (row.song) {
    db.prepare('UPDATE users SET song = NULL WHERE id = ?').run(req.userId);
    removeUpload(row.song);
    broadcastUser(req.userId);
  }
  res.json(selfUser(getUserRow(req.userId)));
});
api.post('/me/media/:kind', auth, (req, res, next) => { try { requireUnlocked(req.userId); next(); } catch (e) { next(e); } }, limited('image', uploadImage, 'file'), (req, res) => {
  const col = Object.hasOwn(MEDIA_KINDS, req.params.kind) ? MEDIA_KINDS[req.params.kind] : null;
  if (!col) fail(404, 'Unknown media type.');
  if (!req.file) fail(400, 'Choose an image.');
  const old = getUserRow(req.userId)[col];
  db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run('/uploads/' + req.file.filename, req.userId);
  let c = {};
  try { c = JSON.parse((req.body && req.body.crop) || '{}'); } catch { /* ignore */ }
  setMediaCrop(req.userId, req.params.kind, c);
  removeUpload(old);
  broadcastUser(req.userId);
  res.json(selfUser(getUserRow(req.userId)));
});
api.delete('/me/media/:kind', auth, (req, res) => {
  const col = Object.hasOwn(MEDIA_KINDS, req.params.kind) ? MEDIA_KINDS[req.params.kind] : null;
  if (!col) fail(404, 'Unknown media type.');
  limitProfileWrites(req);
  const old = getUserRow(req.userId)[col];
  if (old) {
    db.prepare(`UPDATE users SET ${col} = NULL WHERE id = ?`).run(req.userId);
    setMediaCrop(req.userId, req.params.kind, {});
    removeUpload(old);
    broadcastUser(req.userId);
  }
  res.json(selfUser(getUserRow(req.userId)));
});

api.get('/users/:id', auth, (req, res) => {
  const u = publicUser(getUserRow(req.params.id));
  if (!u) fail(404, 'User not found.');
  res.json(u);
});

// ---------------------------------------------------------------- friends
function emitRelationship(row, a, b) {
  for (const [me, other] of [[a, b], [b, a]]) {
    const payload = row ? relationshipFor(row, me) : { userId: other, removed: true };
    io.to(`user:${me}`).emit('relationship:update', { relationship: payload, user: publicUser(getUserRow(other)) });
  }
}

api.post('/friends', auth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(String((req.body || {}).username || ''));
  if (!target) fail(404, 'No one with that username is on this server. Usernames are case-insensitive.');
  if (target.id === req.userId) fail(400, 'You cannot add yourself.');
  if (isBlocked(req.userId, target.id)) fail(403, 'You can\u2019t send a friend request to this person.');
  const existing = db.prepare('SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)')
    .get(req.userId, target.id, target.id, req.userId);
  if (existing) {
    if (existing.status === 'accepted') fail(409, 'You are already friends.');
    if (existing.requester_id === req.userId) fail(409, 'Friend request already sent.');
    db.prepare(`UPDATE friendships SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ?`).run(target.id, req.userId);
  } else {
    const pref = privacyOf(target).friendRequests;
    if (pref === 'nobody' || (pref === 'mutual' && !sharesServer(req.userId, target.id))) fail(403, 'This person isn\u2019t accepting friend requests right now.');
    db.prepare(`INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)`).run(req.userId, target.id, now());
  }
  const row = db.prepare('SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)')
    .get(req.userId, target.id, target.id, req.userId);
  emitRelationship(row, req.userId, target.id);
  res.json({ ok: true });
});

api.post('/friends/:id/accept', auth, (req, res) => {
  const r = db.prepare(`UPDATE friendships SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`).run(req.params.id, req.userId);
  if (!r.changes) fail(404, 'No pending request from that person.');
  emitRelationship(db.prepare('SELECT * FROM friendships WHERE requester_id = ? AND addressee_id = ?').get(req.params.id, req.userId), req.userId, req.params.id);
  res.json({ ok: true });
});

api.delete('/friends/:id', auth, (req, res) => {
  db.prepare('DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)')
    .run(req.userId, req.params.id, req.params.id, req.userId);
  emitRelationship(null, req.userId, req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- servers
api.post('/servers', auth, (req, res, next) => (features().createServers === 'staff' && !isStaff(req.userId) ? next(new HttpError(403, 'On this Hearth, only staff can create servers. Ask an admin.')) : next()), limited('image', uploadImage, 'icon'), (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 64);
  if (!name) fail(400, 'Give your server a name.');
  const id = newId();
  const t = now();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO servers (id, name, icon, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, req.file ? '/uploads/' + req.file.filename : null, req.userId, t);
    db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, req.userId, t);
    db.prepare(`INSERT INTO channels (id, server_id, name, type, position, created_at, category) VALUES (?, ?, 'general', 'text', 0, ?, 'Text')`).run(newId(), id, t);
    db.prepare(`INSERT INTO channels (id, server_id, name, type, position, created_at, category) VALUES (?, ?, 'Lounge', 'voice', 1, ?, 'Voice')`).run(newId(), id, t);
    db.prepare(`INSERT INTO roles (id, server_id, name, position, permissions, created_at) VALUES (?, ?, '@everyone', 0, ?, ?)`).run(id, id, DEFAULT_EVERYONE, t);
  });
  tx();
  io.in(`user:${req.userId}`).socketsJoin(`server:${id}`);
  const server = serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(id), req.userId);
  io.to(`user:${req.userId}`).emit('server:add', { server, users: {}, voice: {}, keyState: keyState(id, req.userId) });
  res.json({ ...server, keyState: keyState(id, req.userId) });
});

api.patch('/servers/:id', auth, (req, res) => {
  const srv = requireServer(req.params.id, req.userId);
  // Anyone in a group DM can rename it; servers need Manage Server (or Manage Channels for category order).
  const body = req.body || {};
  const onlyOrder = Object.keys(body).every((k) => k === 'categoryOrder');
  if (srv.kind !== 'group' && !can(srv, req.userId, onlyOrder ? PM.MANAGE_CHANNELS : PM.MANAGE_SERVER)) fail(403, 'You need the Manage Server permission.');
  if (body.description !== undefined) db.prepare('UPDATE servers SET description = ? WHERE id = ?').run(String(body.description || '').slice(0, 300), srv.id);
  if (body.theme && typeof body.theme === 'object') {
    const cur = themeOf(srv);
    const next = cleanTheme(body.theme, cur);
    db.prepare('UPDATE servers SET theme = ? WHERE id = ?').run(JSON.stringify(next), srv.id);
    // Switching the background from a picture to colours drops the picture: remove its file too.
    const oldImage = cur.background && cur.background.image;
    if (oldImage && oldImage !== (next.background && next.background.image)) removeUpload(oldImage);
  }
  if (Array.isArray(body.categoryOrder)) {
    const order = [...new Set(body.categoryOrder.map((c) => String(c).trim().slice(0, 32)).filter(Boolean))].slice(0, 50);
    db.prepare('UPDATE servers SET category_order = ? WHERE id = ?').run(JSON.stringify(order), srv.id);
  }
  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 64);
    if (!name && srv.kind !== 'group') fail(400, 'Server name cannot be empty.');
    db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(name, req.params.id);
  }
  emitServer(srv.id);
  res.json(serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(srv.id), req.userId));
});

api.post('/servers/:id/icon', auth, limited('image', uploadImage, 'icon'), (req, res) => {
  const srv = requireServer(req.params.id, req.userId);
  // Anyone in a group chat can change its picture (like its name); servers need Manage Server.
  if (srv.kind !== 'group' && !can(srv, req.userId, PM.MANAGE_SERVER)) fail(403, 'You don’t have permission to do that.');
  if (!req.file) fail(400, 'Choose an image.');
  db.prepare('UPDATE servers SET icon = ? WHERE id = ?').run('/uploads/' + req.file.filename, srv.id);
  removeUpload(srv.icon);
  emitServer(srv.id);
  res.json(serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(srv.id), req.userId));
});

function kickFromVoiceInServer(serverId, userId) {
  const ch = userVoice.get(userId);
  if (!ch) return;
  const c = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(ch);
  if (!c || c.server_id === serverId) leaveVoice(userId, true);
}

// Deleting a server or handing it to someone else can't be undone, so like other sensitive changes it needs your
// password (and a two-factor code when that's on): a stolen sign-in alone can't wipe or take your servers.
api.delete('/servers/:id', auth, wrap(async (req, res) => {
  requireOwner(req.params.id, req.userId);
  const row = await stepUp(req, req.body);
  const s = requireOwner(req.params.id, req.userId); // checked again: the password check took a moment
  db.prepare('SELECT id FROM channels WHERE server_id = ?').all(s.id).forEach((c) => {
    const m = voiceChannels.get(c.id);
    if (m) [...m.keys()].forEach((uid) => leaveVoice(uid, true));
  });
  purgeServerContent(s);
  MEMB.onServerDeleted(s.id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  io.to(`server:${s.id}`).emit('server:remove', { serverId: s.id });
  io.in(`server:${s.id}`).socketsLeave(`server:${s.id}`);
  auditLog(req, 'server_deleted', s.id, s.name);
  ACCT.notify(row, 'a server was deleted', `${row.username} deleted the server "${s.name}" with all its channels, messages and files.`);
  res.json({ ok: true });
}));

// Leaving is never rate limited. Every leave needs a membership, which for a server takes a join (limited below), and
// a group never has more than GROUP_MAX people to tell. A limit here would also trap people: anyone in a group can
// add you back, so someone could re-add you faster than you were allowed to leave.
api.post('/servers/:id/leave', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  if (s.kind === 'group' && s.owner_id === req.userId) {
    const next = db.prepare('SELECT user_id FROM members WHERE server_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1').get(s.id, req.userId);
    if (next) db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(next.user_id, s.id);
  } else if (s.owner_id === req.userId) fail(400, 'Owners cannot leave their own server. Delete it or hand it off first.');
  removeMember(s.id, req.userId);
  const left = db.prepare('SELECT COUNT(*) AS n FROM members WHERE server_id = ?').get(s.id).n;
  if (s.kind === 'group' && !left) {
    purgeServerContent(s);
    db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  }
  // A server's members already got member:remove (their apps drop the person from the list). A group may also
  // have a new owner, so its members get the whole group again.
  else if (s.kind === 'group') emitServer(s.id);
  res.json({ ok: true });
});

function removeMember(serverId, userId) {
  MEMB.onLeave(serverId, userId);
  kickFromVoiceInServer(serverId, userId);
  // Everything that was theirs as a member goes too: roles and per-channel overrides (or rejoining with any
  // invite, even after an unban, would hand back Administrator and private channels) and event RSVPs (or
  // they'd keep getting reminders about events they can no longer see).
  db.transaction(() => {
    db.prepare('DELETE FROM members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
    db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?').run(serverId, userId);
    db.prepare("DELETE FROM channel_overrides WHERE target_type = 'member' AND target_id = ? AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)").run(userId, serverId);
    db.prepare('DELETE FROM event_rsvps WHERE user_id = ? AND event_id IN (SELECT id FROM server_events WHERE server_id = ?)').run(userId, serverId);
  })();
  // They still hold old keys, so the remaining members must switch to a fresh key.
  db.prepare('UPDATE servers SET needs_rotation = 1 WHERE id = ?').run(serverId);
  io.in(`user:${userId}`).socketsLeave(`server:${serverId}`);
  io.to(`user:${userId}`).emit('server:remove', { serverId });
  io.to(`server:${serverId}`).emit('member:remove', { serverId, userId });
  emitKeyState(serverId);
}

api.delete('/servers/:id/members/:uid', auth, (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.KICK_MEMBERS, 'You need the Kick Members permission.');
  if (req.params.uid === s.owner_id) fail(400, 'You cannot remove the owner.');
  if (!isMember(s.id, req.params.uid)) fail(404, 'That person is not in this server.');
  if (perms.top(s, req.params.uid) >= perms.top(s, req.userId)) fail(403, 'You can only remove people whose highest role is below yours.');
  removeMember(s.id, req.params.uid);
  emitServer(s.id);
  res.json({ ok: true });
});

// Give/take roles. You can only hand out roles below your own highest role, and only roles whose permissions
// you have yourself (or a Manage Roles holder could give anyone, themselves included, an Administrator role
// that happens to sit lower in the list). A role's per-channel overrides count too: giving it can't allow, and
// taking it away can't lift a deny on, anything you don't have in that channel yourself (or a lower role that
// can see a private channel, or one that keeps someone out of it, would be a way in).
api.put('/servers/:id/members/:uid/roles', auth, (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.MANAGE_ROLES, 'You need the Manage Roles permission.');
  const uid = req.params.uid;
  if (!isMember(s.id, uid)) fail(404, 'That person is not in this server.');
  const myTop = perms.top(s, req.userId);
  const mine = perms.base(s, req.userId);
  if (uid === s.owner_id && req.userId !== s.owner_id) fail(403, 'Only the owner can change the owner\u2019s roles.');
  if (uid !== req.userId && uid !== s.owner_id && perms.top(s, uid) >= myTop) fail(403, 'You can only change roles for people below you.');
  const wanted = new Set((Array.isArray((req.body || {}).roleIds) ? req.body.roleIds : []).map(String));
  const all = db.prepare('SELECT * FROM roles WHERE server_id = ? AND id != ?').all(s.id, s.id);
  const current = new Set(db.prepare('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(s.id, uid).map((r) => r.role_id));
  const changed = all.filter((r) => current.has(r.id) !== wanted.has(r.id));
  const lifted = new Map(); // channel id -> deny bits of roles being taken away there
  const myIn = (chId) => perms.channel(s, { id: chId }, req.userId);
  for (const r of changed) {
    const want = wanted.has(r.id);
    if (r.position >= myTop) fail(403, `You can't assign or remove "${r.name}" — it's not below your highest role.`);
    if (want && (r.permissions & ALL_PERMS & ~mine)) fail(403, `You can't give "${r.name}": it has permissions you don't have.`);
    for (const o of db.prepare("SELECT channel_id, allow, deny FROM channel_overrides WHERE target_type = 'role' AND target_id = ?").all(r.id)) {
      if (want && (o.allow & CHANNEL_SCOPED & ~myIn(o.channel_id))) fail(403, `You can't give "${r.name}": it has channel permissions you don't have.`);
      if (!want && o.deny) lifted.set(o.channel_id, (lifted.get(o.channel_id) || 0) | o.deny);
    }
  }
  // Only what the person really gets back counts (unmuting someone in a channel where everyone is muted anyway is fine).
  const was = [...lifted.keys()].map((chId) => [chId, perms.channel(s, { id: chId }, uid), myIn(chId)]);
  db.transaction(() => {
    for (const r of changed) {
      if (wanted.has(r.id)) db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(s.id, uid, r.id);
      else db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').run(s.id, uid, r.id);
    }
    for (const [chId, before, my] of was) {
      if ((perms.channel(s, { id: chId }, uid) & ~before) & lifted.get(chId) & ~my) fail(403, 'You can\u2019t take that role away: it limits them in a channel where you don\u2019t have that permission yourself.');
    }
  })();
  emitServer(s.id);
  res.json({ ok: true });
});

api.post('/servers/:id/transfer', auth, wrap(async (req, res) => {
  const to = String((req.body || {}).userId || '');
  if (!isMember(requireOwner(req.params.id, req.userId).id, to)) fail(404, 'That person is not in this server.');
  const row = await stepUp(req, req.body); // see DELETE /servers/:id
  const s = requireOwner(req.params.id, req.userId);
  if (!isMember(s.id, to)) fail(404, 'That person is not in this server.');
  db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(to, s.id);
  emitServer(s.id);
  const toName = (getUserRow(to) || {}).username || to;
  auditLog(req, 'server_transferred', s.id, `${s.name} \u2192 ${toName}`);
  ACCT.notify(row, 'you handed over a server', `${row.username} made ${toName} the owner of the server "${s.name}".`);
  const out = serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(s.id), req.userId);
  res.json(out);
}));

// ---------------------------------------------------------------- invites
api.post('/servers/:id/invites', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  if (s.kind === 'group') fail(400, 'Add people to a group from its member list.');
  if (!can(s, req.userId, PM.CREATE_INVITE)) fail(403, 'You don\u2019t have permission to create invites.');
  const b = req.body || {};
  const maxUses = Math.max(0, Math.min(1000, parseInt(b.maxUses || '0', 10) || 0));
  // A link expires after 7 days unless the request picks something else (0 = never), so API clients and older
  // apps that leave it out don't make permanent links by accident.
  const hours = b.expiresHours === undefined || b.expiresHours === null || b.expiresHours === '' ? 168
    : Math.max(0, Math.min(24 * 30, parseInt(b.expiresHours, 10) || 0));
  const code = randomCode(8);
  db.prepare('INSERT INTO invites (code, server_id, creator_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, s.id, req.userId, maxUses, hours ? now() + hours * 3600000 : null, now());
  res.json({ code });
});

// The invites that still work. People with Manage Server see them all (to revoke a leaked one); anyone else
// sees only the ones they made.
const inviteOut = (i) => ({ code: i.code, creatorId: i.creator_id, uses: i.uses, maxUses: i.max_uses, expiresAt: i.expires_at, createdAt: i.created_at });
api.get('/servers/:id/invites', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  const all = can(s, req.userId, PM.MANAGE_SERVER);
  res.json(db.prepare(`SELECT * FROM invites WHERE server_id = ? AND (? OR creator_id = ?) AND (expires_at IS NULL OR expires_at > ?)
      AND (max_uses = 0 OR uses < max_uses) ORDER BY created_at DESC LIMIT 200`).all(s.id, all ? 1 : 0, req.userId, now()).map(inviteOut));
});
// Revoke an invite: whoever made it, or anyone with Manage Server in the invite's own server.
api.delete('/invites/:code', auth, (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(String(req.params.code));
  if (!inv) fail(404, 'That invite does not exist.');
  const s = requireServer(inv.server_id, req.userId);
  if (inv.creator_id !== req.userId && !can(s, req.userId, PM.MANAGE_SERVER)) fail(403, 'Only the person who made this invite (or someone with Manage Server) can revoke it.');
  db.prepare('DELETE FROM invites WHERE code = ?').run(inv.code);
  res.json({ ok: true });
});

function validInvite(code) {
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!inv) fail(404, 'That invite does not exist.');
  if (inv.expires_at && inv.expires_at < now()) fail(410, 'That invite has expired.');
  if (inv.max_uses && inv.uses >= inv.max_uses) fail(410, 'That invite has been used up.');
  return inv;
}

api.get('/invites/:code', auth, (req, res) => {
  const inv = validInvite(req.params.code);
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(inv.server_id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM members WHERE server_id = ?').get(s.id).n;
  res.json({ serverId: s.id, name: s.name, icon: s.icon, memberCount: count, alreadyMember: isMember(s.id, req.userId) });
});

// Joining updates everyone in the server (and their keys), so it's limited: a script that joins and leaves a big
// community in a loop would otherwise keep the whole instance busy.
api.post('/invites/:code/join', auth, (req, res) => {
  rateLimit('join:' + req.userId, 20, 3600000);
  limitNet(req, 'join', 60, 3600000);
  const inv = validInvite(req.params.code);
  const sid = inv.server_id;
  if (db.prepare('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?').get(sid, req.userId)) fail(403, 'You are banned from this server.');
  const joined = !isMember(sid, req.userId);
  if (joined) {
    db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(sid, req.userId, now());
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(inv.code);
    io.to(`server:${sid}`).emit('member:add', { serverId: sid, user: publicUser(getUserRow(req.userId)) });
    io.in(`user:${req.userId}`).socketsJoin(`server:${sid}`);
    MEMB.syncRoles(sid, req.userId); // back with a membership they still pay for: their role comes back too
  }
  const server = serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(sid), req.userId);
  const users = {};
  server.memberIds.forEach((id) => { users[id] = publicUser(getUserRow(id)); });
  const voice = {};
  server.channels.filter((c) => c.type === 'voice').forEach((c) => { voice[c.id] = voiceStateList(c.id); });
  io.to(`user:${req.userId}`).emit('server:add', { server, users, voice, keyState: keyState(sid, req.userId) });
  // Someone new needs the server key, so the members holding it hear about that (nothing changed if they were in already).
  if (joined) emitKeyState(sid);
  res.json({ ...server, keyState: keyState(sid, req.userId) });
});

// ---------------------------------------------------------------- server encryption keys
const isWrapped = (s) => typeof s === 'string' && s.length > 40 && s.length < 2000;
// Which wrapped keys were made for a public key the person no longer has (the sharer's app had stale info).
// Apps send the public key they wrapped for; older apps that don't are trusted as before.
function staleWraps(pubs, ids) {
  if (!pubs || typeof pubs !== 'object') return [];
  const get = db.prepare('SELECT public_key FROM users WHERE id = ?');
  return ids.filter((uid) => typeof pubs[uid] === 'string' && (get.get(uid) || {}).public_key !== pubs[uid]);
}

api.get('/servers/:id/keys', auth, (req, res) => {
  requireServer(req.params.id, req.userId);
  res.json(keyState(req.params.id, req.userId));
});

// Start a new key epoch. The client generated a fresh random key and wrapped it to every member.
api.post('/servers/:id/keys/rotate', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  rateLimit('rotate:' + req.userId, 30, 60 * 1000);
  const { epoch, check, wraps, pubs } = req.body || {};
  if (typeof check !== 'string' || !/^[A-Za-z0-9+/=]{16,64}$/.test(check)) fail(400, 'Bad key check.');
  if (!wraps || typeof wraps !== 'object') fail(400, 'Missing wrapped keys.');
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT key_epoch FROM servers WHERE id = ?').get(s.id).key_epoch;
    if (Number(epoch) !== cur + 1) fail(409, 'Someone else just refreshed the key.', 'epoch');
    const members = db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(s.id).map((r) => r.user_id);
    const ids = Object.keys(wraps);
    if (ids.length !== members.length || !members.every((m) => isWrapped(wraps[m]))) fail(409, 'The member list changed. Try again.', 'members');
    const stale = staleWraps(pubs, members);
    if (stale.length) fail(409, 'A member\u2019s keys just changed. Try again.', 'stale_keys');
    const t = now();
    db.prepare('INSERT INTO server_epochs (server_id, epoch, key_check, creator_id, created_at) VALUES (?, ?, ?, ?, ?)').run(s.id, cur + 1, check, req.userId, t);
    const ins = db.prepare('INSERT INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    members.forEach((m) => ins.run(s.id, cur + 1, m, wraps[m], req.userId, t));
    db.prepare('UPDATE servers SET key_epoch = ?, needs_rotation = 0 WHERE id = ?').run(cur + 1, s.id);
  });
  tx();
  emitKeyState(s.id);
  res.json(keyState(s.id, req.userId));
});

// Give the current key to members who don't have it yet (new joiners).
api.post('/servers/:id/keys/share', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  rateLimit('share:' + req.userId, 60, 60 * 1000);
  const { epoch, wraps, pubs } = req.body || {};
  const cur = db.prepare('SELECT key_epoch FROM servers WHERE id = ?').get(s.id).key_epoch;
  if (!cur || Number(epoch) !== cur) fail(409, 'That key is out of date.', 'epoch');
  if (!db.prepare('SELECT 1 FROM server_keys WHERE server_id = ? AND epoch = ? AND user_id = ?').get(s.id, cur, req.userId)) fail(403, 'You do not have this key.');
  const ins = db.prepare('INSERT OR IGNORE INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  const stale = staleWraps(pubs, Object.keys(wraps || {}));
  for (const [uid, w] of Object.entries(wraps || {}).slice(0, 200)) {
    if (stale.includes(uid)) continue;
    if (isMember(s.id, uid) && isWrapped(w)) n += ins.run(s.id, cur, uid, w, req.userId, now()).changes;
  }
  if (n) emitKeyState(s.id);
  res.json({ shared: n, stale });
});
// A member's app couldn't unlock the key it was given (wrapped for keys it no longer has, e.g. right after
// a password reset): drop it so the others share it again.
api.post('/servers/:id/keys/bad', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  rateLimit('badkey:' + req.userId, 20, 60 * 60 * 1000);
  const epoch = Number((req.body || {}).epoch);
  const n = db.prepare('DELETE FROM server_keys WHERE server_id = ? AND user_id = ? AND epoch = ?').run(s.id, req.userId, epoch).changes;
  if (n) emitKeyState(s.id);
  res.json({ removed: n });
});

// ---------------------------------------------------------------- channels
const cleanCategory = (c) => String(c || '').trim().slice(0, 32);

// Reorder channels (ids in display order) — admins only.
api.post('/servers/:id/channel-order', auth, (req, res) => {
  const s = requireAdmin(req.params.id, req.userId);
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String) : [];
  const upd = db.prepare('UPDATE channels SET position = ? WHERE id = ? AND server_id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id, s.id)))();
  emitServer(s.id);
  res.json({ ok: true });
});
api.post('/servers/:id/categories/rename', auth, (req, res) => {
  const s = requireAdmin(req.params.id, req.userId);
  const from = cleanCategory((req.body || {}).from);
  const to = cleanCategory((req.body || {}).to);
  if (!from || !to) fail(400, 'Give the category a name.');
  db.prepare('UPDATE channels SET category = ? WHERE server_id = ? AND category = ?').run(to, s.id, from);
  let order = [];
  try { order = JSON.parse(s.category_order || '[]'); } catch { /* ignore */ }
  db.prepare('UPDATE servers SET category_order = ? WHERE id = ?').run(JSON.stringify([...new Set(order.map((c) => (c === from ? to : c)))]), s.id);
  emitServer(s.id);
  res.json({ ok: true });
});

const cleanChannelName = (name, type) => {
  let n = String(name || '').trim().slice(0, 48);
  if (type === 'text') n = n.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '');
  return n;
};

api.post('/servers/:id/channels', auth, (req, res) => {
  const s = requireAdmin(req.params.id, req.userId);
  const type = (req.body || {}).type === 'voice' ? 'voice' : 'text';
  const name = cleanChannelName((req.body || {}).name, type);
  if (!name) fail(400, 'Give the channel a name.');
  const category = cleanCategory((req.body || {}).category) || (type === 'voice' ? 'Voice' : 'Text');
  const pos = (db.prepare('SELECT MAX(position) AS p FROM channels WHERE server_id = ?').get(s.id).p ?? -1) + 1;
  const id = newId();
  db.prepare('INSERT INTO channels (id, server_id, name, type, position, created_at, category) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, s.id, name, type, pos, now(), category);
  const ch = serializeChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(id));
  emitServer(s.id);
  res.json(ch);
});

// Editing or deleting a channel needs Manage Channels in that channel: a channel you can't see stays "not found",
// and a per-channel deny of Manage Channels is respected.
function requireManageableChannel(channelId, userId) {
  const c = requireChannel(channelId, userId);
  const s = requireAdmin(c.server_id, userId);
  if (!canIn(s, c, userId, PM.MANAGE_CHANNELS)) fail(403, 'You don\u2019t have permission to manage this channel.');
  return c;
}
api.patch('/channels/:id', auth, (req, res) => {
  const c = requireManageableChannel(req.params.id, req.userId);
  const name = req.body.name !== undefined ? cleanChannelName(req.body.name, c.type) : c.name;
  const topic = req.body.topic !== undefined ? String(req.body.topic).slice(0, 300) : c.topic;
  const category = req.body.category !== undefined ? (cleanCategory(req.body.category) || c.category) : c.category;
  if (req.body.slowmode !== undefined) db.prepare('UPDATE channels SET slowmode = ? WHERE id = ?').run(Math.max(0, Math.min(21600, parseInt(req.body.slowmode, 10) || 0)), c.id);
  if (!name) fail(400, 'Channel name cannot be empty.');
  db.prepare('UPDATE channels SET name = ?, topic = ?, category = ? WHERE id = ?').run(name, topic, category, c.id);
  const ch = serializeChannel(db.prepare('SELECT * FROM channels WHERE id = ?').get(c.id));
  emitServer(c.server_id);
  res.json(ch);
});

api.delete('/channels/:id', auth, (req, res) => {
  const c = requireManageableChannel(req.params.id, req.userId);
  const m = voiceChannels.get(c.id);
  if (m) [...m.keys()].forEach((uid) => leaveVoice(uid, true));
  forgetMessages(db.prepare('SELECT id FROM messages WHERE channel_id = ?').all(c.id).map((r) => r.id));
  db.prepare('DELETE FROM channels WHERE id = ?').run(c.id);
  emitServer(c.server_id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- channel messages
const MAX_MESSAGE = 4000;

// Page through a conversation: newest (default), ?before=id (older), ?after=id (newer) or ?around=id (jump).
function pageRows(table, col, containerId, q, extra = '') {
  // Between 1 and 100 (SQLite reads a negative LIMIT as "no limit": the whole history in one go).
  const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 50));
  const base = `SELECT * FROM ${table} WHERE ${col} = ? ${extra}`;
  if (q.around) {
    const older = db.prepare(`${base} AND id <= ? ORDER BY id DESC LIMIT 26`).all(containerId, String(q.around));
    const newer = db.prepare(`${base} AND id > ? ORDER BY id ASC LIMIT 25`).all(containerId, String(q.around));
    return { rows: [...older.reverse(), ...newer], hasMore: older.length === 26, hasNewer: newer.length === 25 };
  }
  if (q.after) {
    const rows = db.prepare(`${base} AND id > ? ORDER BY id ASC LIMIT ?`).all(containerId, String(q.after), limit);
    return { rows, hasMore: true, hasNewer: rows.length === limit };
  }
  const rows = q.before
    ? db.prepare(`${base} AND id < ? ORDER BY id DESC LIMIT ?`).all(containerId, String(q.before), limit)
    : db.prepare(`${base} ORDER BY id DESC LIMIT ?`).all(containerId, limit);
  return { rows: rows.reverse(), hasMore: rows.length === limit, hasNewer: false };
}

api.get('/channels/:id/messages', auth, (req, res) => {
  const c = requireChannel(req.params.id, req.userId);
  // Thread replies live in their thread, not the main channel.
  const { rows, hasMore, hasNewer } = pageRows('messages', 'channel_id', c.id, req.query, 'AND thread_id IS NULL');
  const reactions = reactionsFor(rows.map((r) => r.id));
  res.json({ messages: rows.map((r) => serializeMessage(r, c, reactions)), hasMore, hasNewer });
});

// Who gets a push for a channel message. The sender's app tells us which members it @mentions
// (that's the only part of the message the server learns), plus replies and group DMs.
function notifyChannelMessage(c, id, senderId, replyTo, threadId, mentions) {
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
  const members = db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(c.server_id).map((r) => r.user_id).filter((u) => u !== senderId);
  const url = '/#m/' + id;
  if (srv.kind === 'group') return pushTo(members, { title: nameOf(senderId), body: srv.name ? `New message in ${srv.name}` : 'New message in your group', tag: 'c:' + c.id, url });
  const where = `#${c.name} \u00b7 ${srv.name}`;
  // Only people who can see the channel: a push to anyone else would tell them a private channel's name.
  const open = !perms.restricted(srv, c);
  const reaches = (u) => members.includes(u) && (open || (perms.channel(srv, c, u) & PM.VIEW_CHANNEL) !== 0);
  const mentioned = Array.isArray(mentions) ? [...new Set(mentions.slice(0, 50).map(String))].filter(reaches) : [];
  pushTo(mentioned, { title: `${nameOf(senderId)} mentioned you`, body: where, tag: 'c:' + c.id, url });
  const replyAuthor = replyTo && (db.prepare('SELECT author_id FROM messages WHERE id = ?').get(replyTo) || {}).author_id;
  const rootAuthor = threadId && (db.prepare('SELECT author_id FROM messages WHERE id = ?').get(threadId) || {}).author_id;
  pushTo([replyAuthor, rootAuthor].filter((u) => u && u !== senderId && !mentioned.includes(u) && reaches(u)),
    { title: `${nameOf(senderId)} replied to you`, body: where, tag: 'c:' + c.id, url });
}

const validCipher = (c) => {
  if (typeof c !== 'string' || c.length < 20 || c.length > 64000) fail(400, 'Bad encrypted payload. Reload the page.');
};
function requireCurrentEpoch(serverId, epoch) {
  const s = db.prepare('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?').get(serverId);
  if (s.needs_rotation || !s.key_epoch) fail(409, 'This server needs a fresh encryption key first.', 'rotate');
  if (Number(epoch) !== s.key_epoch) fail(409, 'Your encryption key for this server is out of date.', 'stale-key');
  return s.key_epoch;
}

// The sender's app tags each message with a random nonce so it can swap its "sending…" copy for the
// real one the moment it arrives. It's echoed back, never stored.
function withNonce(msg, body) {
  const n = body && body.nonce;
  if (typeof n === 'string' && /^[a-z0-9]{8,40}$/i.test(n)) msg.nonce = n;
  return msg;
}
// Channel messages are end-to-end encrypted by the sender. The server stores ciphertext only.
api.post('/channels/:id/messages', auth, (req, res) => {
  const c = requireChannel(req.params.id, req.userId);
  if (c.type !== 'text') fail(400, 'You can only send messages in text channels.');
  limitMessages(req);
  const { ciphertext, epoch, files } = req.body || {};
  validCipher(ciphertext);
  const srvRow = serverOf(c);
  const cp = perms.channel(srvRow, c, req.userId);
  if (!(cp & PM.SEND_MESSAGES)) fail(403, 'You don\u2019t have permission to send messages here.');
  if (Array.isArray(files) && files.length && !(cp & PM.ATTACH_FILES)) fail(403, 'You don\u2019t have permission to attach files here.');
  if ((req.body || {}).threadId && !(cp & PM.CREATE_THREADS)) fail(403, 'You don\u2019t have permission to reply in threads here.');
  if (c.slowmode > 0 && !(cp & (PM.MANAGE_MESSAGES | PM.MANAGE_CHANNELS))) {
    const last = db.prepare('SELECT created_at FROM messages WHERE channel_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1').get(c.id, req.userId);
    const wait = last ? Math.ceil((last.created_at + c.slowmode * 1000 - now()) / 1000) : 0;
    if (wait > 0) fail(429, `Slowmode is on. You can send another message in ${wait}s.`, 'slowmode');
  }
  const ep = requireCurrentEpoch(c.server_id, epoch);
  let replyTo = (req.body || {}).replyTo || null;
  if (replyTo && !db.prepare('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?').get(replyTo, c.id)) replyTo = null;
  let threadId = (req.body || {}).threadId || null;
  if (threadId) {
    const root = db.prepare('SELECT id, thread_id FROM messages WHERE id = ? AND channel_id = ?').get(String(threadId), c.id);
    if (!root || root.thread_id) fail(404, 'That thread no longer exists.');
  }
  const id = newId();
  db.prepare('INSERT INTO messages (id, channel_id, author_id, body, ciphertext, epoch, reply_to, created_at, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, c.id, req.userId, '', ciphertext, ep, replyTo, now(), threadId);
  attachBlobs(files, req.userId, id);
  const msg = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id), c);
  withNonce(msg, req.body);
  toChannel(c).emit('message:new', msg);
  notifyChannelMessage(c, id, req.userId, replyTo, threadId, (req.body || {}).mentions);
  if (threadId) toChannel(c).emit('thread:update', { rootId: threadId, channelId: c.id, ...threadInfo({ id: threadId }) });
  res.json(msg);
});

api.patch('/messages/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!m || m.author_id !== req.userId) fail(404, 'Message not found.');
  const c = requireChannel(m.channel_id, req.userId);
  const { ciphertext, epoch } = req.body || {};
  validCipher(ciphertext);
  const ep = requireCurrentEpoch(c.server_id, epoch);
  // Editing an older server-encrypted message: drop its readable text, keep the file list for cleanup.
  const body = m.ciphertext ? m.body : seal({ content: '', attachments: unseal(m.body).attachments || [] });
  db.prepare('UPDATE messages SET body = ?, ciphertext = ?, epoch = ?, edited_at = ? WHERE id = ?').run(body, ciphertext, ep, now(), m.id);
  const msg = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id), c);
  toChannel(c).emit('message:update', msg);
  res.json(msg);
});

api.delete('/messages/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!m) fail(404, 'Message not found.');
  const c = requireChannel(m.channel_id, req.userId);
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
  if (m.author_id !== req.userId && !canIn(s, c, req.userId, PM.MANAGE_MESSAGES)) fail(403, 'You can only delete your own messages.');
  deleteMessageTree(m.id);
  toChannel(c).emit('message:delete', { id: m.id, channelId: c.id, threadId: m.thread_id || null });
  if (m.thread_id) toChannel(c).emit('thread:update', { rootId: m.thread_id, channelId: c.id, threadCount: 0, ...threadInfo({ id: m.thread_id }) });
  res.json({ ok: true });
});

api.get('/messages/:id/thread', auth, (req, res) => {
  const root = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!root || root.thread_id) fail(404, 'Thread not found.');
  const c = requireChannel(root.channel_id, req.userId);
  // Paged like a channel (newest replies first, ?before=id for older ones): a thread can be any size.
  const { rows, hasMore, hasNewer } = pageRows('messages', 'thread_id', root.id, { limit: '100', ...req.query });
  const reactions = reactionsFor([root.id, ...rows.map((r) => r.id)]);
  res.json({ root: serializeMessage(root, c, reactions), messages: rows.map((r) => serializeMessage(r, c, reactions)), hasMore, hasNewer });
});

// Where does a message live? Used by message links, search results and notifications.
api.get('/messages/:id/locate', auth, (req, res) => {
  const m = db.prepare('SELECT id, channel_id, thread_id FROM messages WHERE id = ?').get(req.params.id);
  if (m) {
    const c = requireChannel(m.channel_id, req.userId);
    return res.json({ kind: 'channel', channelId: c.id, serverId: c.server_id, threadId: m.thread_id || null });
  }
  const dm = db.prepare('SELECT id, dm_id FROM dm_messages WHERE id = ?').get(req.params.id);
  if (!dm) fail(404, 'That message was deleted or you can\u2019t see it.');
  requireDm(dm.dm_id, req.userId);
  res.json({ kind: 'dm', dmId: dm.dm_id });
});

// Pins: shared per conversation. In servers, admins and the author can pin; in DMs, either person.
function pinTarget(id, userId) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (m) {
    const c = requireChannel(m.channel_id, userId);
    const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
    if (s.kind !== 'group' && m.author_id !== userId && !canIn(s, c, userId, PM.MANAGE_MESSAGES)) fail(403, 'You need the Manage Messages permission to pin other people\u2019s messages.');
    return { table: 'messages', room: toChannel(c), payload: { messageId: m.id, channelId: c.id } };
  }
  const dm = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(id);
  if (!dm) fail(404, 'Message not found.');
  const d = requireDm(dm.dm_id, userId);
  if (isBlocked(d.user_a, d.user_b)) fail(403, 'You can\u2019t interact with this person.');
  return { table: 'dm_messages', room: [`user:${d.user_a}`, `user:${d.user_b}`], payload: { messageId: dm.id, dmId: d.id } };
}
api.post('/messages/:id/pin', auth, (req, res) => {
  const t = pinTarget(req.params.id, req.userId);
  const at = now();
  db.prepare(`UPDATE ${t.table} SET pinned_at = ?, pinned_by = ? WHERE id = ?`).run(at, req.userId, req.params.id);
  (typeof t.room === 'object' && !Array.isArray(t.room) ? t.room : io.to(t.room)).emit('pin:update', { ...t.payload, pinnedAt: at, pinnedBy: req.userId });
  res.json({ ok: true });
});
api.delete('/messages/:id/pin', auth, (req, res) => {
  const t = pinTarget(req.params.id, req.userId);
  db.prepare(`UPDATE ${t.table} SET pinned_at = NULL, pinned_by = NULL WHERE id = ?`).run(req.params.id);
  (typeof t.room === 'object' && !Array.isArray(t.room) ? t.room : io.to(t.room)).emit('pin:update', { ...t.payload, pinnedAt: null });
  res.json({ ok: true });
});
api.get('/channels/:id/pins', auth, (req, res) => {
  const c = requireChannel(req.params.id, req.userId);
  const rows = db.prepare('SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 50').all(c.id);
  const reactions = reactionsFor(rows.map((r) => r.id));
  res.json(rows.map((r) => serializeMessage(r, c, reactions)));
});
api.get('/dms/:id/pins', auth, (req, res) => {
  const d = requireDm(req.params.id, req.userId);
  const rows = db.prepare('SELECT * FROM dm_messages WHERE dm_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 50').all(d.id);
  const reactions = reactionsFor(rows.map((r) => r.id));
  res.json(rows.map((r) => serializeDmMessage(r, reactions)));
});

// Reactions work for both server messages and DMs.
api.post('/messages/:id/reactions', auth, (req, res) => {
  const emoji = String((req.body || {}).emoji || '').slice(0, 64);
  if (!emoji) fail(400, 'Pick an emoji.');
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  let target;
  let payload;
  if (m) {
    const c = requireChannel(m.channel_id, req.userId);
    const mine = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(m.id, req.userId, emoji);
    if (!mine && !canIn(serverOf(c), c, req.userId, PM.ADD_REACTIONS)) fail(403, 'You don\u2019t have permission to react here.');
    target = toChannel(c);
    payload = { messageId: m.id, channelId: c.id };
  } else {
    const dm = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
    if (!dm) fail(404, 'Message not found.');
    const d = requireDm(dm.dm_id, req.userId);
    // After a block, nobody in the conversation can add reactions (taking your own away is still fine).
    const mine = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(dm.id, req.userId, emoji);
    if (!mine && isBlocked(d.user_a, d.user_b)) fail(403, 'You can\u2019t interact with this person.');
    target = [`user:${d.user_a}`, `user:${d.user_b}`];
    payload = { messageId: dm.id, dmId: d.id };
  }
  const exists = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(req.params.id, req.userId, emoji);
  if (exists) db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(req.params.id, req.userId, emoji);
  else {
    const distinct = db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?').get(req.params.id).n;
    if (distinct >= 20) fail(400, 'That message has too many different reactions.');
    db.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(req.params.id, req.userId, emoji, now());
  }
  payload.reactions = reactionsFor([req.params.id])[req.params.id] || [];
  (typeof target === 'object' && !Array.isArray(target) ? target : io.to(target)).emit('reaction:update', payload);
  res.json(payload);
});

// ---------------------------------------------------------------- DMs (end-to-end encrypted)
api.post('/dms', auth, (req, res) => {
  const other = String((req.body || {}).userId || '');
  if (other === req.userId || !getUserRow(other)) fail(404, 'User not found.');
  const [a, b] = [req.userId, other].sort();
  let d = db.prepare('SELECT * FROM dm_channels WHERE user_a = ? AND user_b = ?').get(a, b);
  if (isBlocked(req.userId, other)) fail(403, 'You can\u2019t message this person.');
  if (!d) {
    if (!sharesServer(a, b) && !areFriends(a, b)) fail(403, 'You can message friends and people who share a server with you.');
    if (privacyOf(getUserRow(other)).dms === 'friends' && !areFriends(a, b)) fail(403, 'This person only accepts messages from friends.');
    const id = newId();
    db.prepare('INSERT INTO dm_channels (id, user_a, user_b, last_message_at, created_at) VALUES (?, ?, ?, ?, ?)').run(id, a, b, now(), now());
    d = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(id);
  }
  res.json(serializeDm(d, req.userId));
});

api.get('/dms/:id/messages', auth, (req, res) => {
  const d = requireDm(req.params.id, req.userId);
  const { rows, hasMore, hasNewer } = pageRows('dm_messages', 'dm_id', d.id, req.query);
  const reactions = reactionsFor(rows.map((r) => r.id));
  res.json({ messages: rows.map((r) => serializeDmMessage(r, reactions)), hasMore, hasNewer });
});

api.post('/dms/:id/messages', auth, (req, res) => {
  const d = requireDm(req.params.id, req.userId);
  limitMessages(req);
  if (isBlocked(d.user_a, d.user_b)) fail(403, 'You can\u2019t message this person.');
  const { ciphertext, files } = req.body || {};
  validCipher(ciphertext);
  let replyTo = (req.body || {}).replyTo || null;
  if (replyTo && !db.prepare('SELECT 1 FROM dm_messages WHERE id = ? AND dm_id = ?').get(replyTo, d.id)) replyTo = null;
  const id = newId();
  const t = now();
  db.prepare('INSERT INTO dm_messages (id, dm_id, author_id, ciphertext, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, d.id, req.userId, ciphertext, replyTo, t);
  attachBlobs(files, req.userId, id);
  pushTo([d.user_a === req.userId ? d.user_b : d.user_a], { title: nameOf(req.userId), body: 'Sent you a message', tag: 'd:' + d.id, url: '/#m/' + id });
  db.prepare('UPDATE dm_channels SET last_message_at = ? WHERE id = ?').run(t, d.id);
  const msg = serializeDmMessage(db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(id));
  withNonce(msg, req.body);
  for (const uid of [d.user_a, d.user_b]) {
    const dm = serializeDm({ ...d, last_message_at: t }, uid);
    io.to(`user:${uid}`).emit('dm:message', { dm, message: msg, user: publicUser(getUserRow(dm.userId)) });
  }
  res.json(msg);
});

api.patch('/dm-messages/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
  if (!m || m.author_id !== req.userId) fail(404, 'Message not found.');
  const d = requireDm(m.dm_id, req.userId);
  // Editing is sending new words: a block stops it like it stops new messages (deleting your own still works).
  if (isBlocked(d.user_a, d.user_b)) fail(403, 'You can\u2019t message this person.');
  const { ciphertext } = req.body || {};
  validCipher(ciphertext);
  db.prepare('UPDATE dm_messages SET ciphertext = ?, edited_at = ? WHERE id = ?').run(ciphertext, now(), m.id);
  const msg = serializeDmMessage(db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(m.id));
  io.to([`user:${d.user_a}`, `user:${d.user_b}`]).emit('dm:update', msg);
  res.json(msg);
});

api.delete('/dm-messages/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
  if (!m || m.author_id !== req.userId) fail(404, 'Message not found.');
  const d = requireDm(m.dm_id, req.userId);
  forgetMessages([m.id]);
  db.prepare('DELETE FROM dm_messages WHERE id = ?').run(m.id);
  io.to([`user:${d.user_a}`, `user:${d.user_b}`]).emit('dm:delete', { id: m.id, dmId: d.id });
  res.json({ ok: true });
});

// Encrypted attachment blobs. The client encrypts each file with its own random key before upload.
api.post('/upload/encrypted', auth, limited('file', uploadEncrypted, 'file'), (req, res) => {
  if (!req.file) fail(400, 'No file.');
  rateLimit('blob:' + req.userId, 120, 60 * 1000);
  db.prepare('INSERT INTO blobs (name, uploader_id, created_at) VALUES (?, ?, ?)').run(req.file.filename, req.userId, now());
  res.json({ url: '/uploads/' + req.file.filename });
});

// ---------------------------------------------------------------- server customization
const HEX = /^#[0-9a-f]{6}$/i;
function cleanTheme(t, cur) {
  const out = { ...cur };
  if (t.accent !== undefined) out.accent = HEX.test(t.accent) ? t.accent : '';
  if (t.welcome !== undefined) out.welcome = String(t.welcome || '').slice(0, 600);
  if (t.roleColors !== undefined) out.roleColors = !!t.roleColors;
  if (['circle', 'rounded', 'square'].includes(t.iconShape)) out.iconShape = t.iconShape;
  if (t.bannerCrop !== undefined) {
    const c = t.bannerCrop || {};
    const n = (v, a, b, d) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d);
    out.bannerCrop = { x: n(c.x, -200, 200, 0), y: n(c.y, -200, 200, 0), z: n(c.z, 1, 5, 1) };
  }
  if (t.background && typeof t.background === 'object') {
    const b = t.background;
    const kind = ['none', 'preset', 'gradient', 'image'].includes(b.kind) ? b.kind : 'none';
    out.background = {
      kind,
      preset: String(b.preset || '').slice(0, 32),
      colors: (Array.isArray(b.colors) ? b.colors : []).filter((x) => HEX.test(x)).slice(0, 3),
      angle: Math.max(0, Math.min(360, parseInt(b.angle, 10) || 135)),
      style: ['linear', 'radial', 'mesh', 'conic'].includes(b.style) ? b.style : 'linear',
      three: !!b.three,
      image: kind === 'image' ? (cur.background && cur.background.image) || '' : '',
      dim: Math.max(0, Math.min(0.8, +b.dim || 0)),
    };
  }
  return out;
}
// Banner and background images for the server.
api.post('/servers/:id/media/:kind', auth, limited('image', uploadImage, 'file'), (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.MANAGE_SERVER, 'You need the Manage Server permission.');
  if (!['banner', 'background'].includes(req.params.kind)) fail(404, 'Unknown media type.');
  if (!req.file) fail(400, 'Choose an image.');
  const th = themeOf(s);
  const url = '/uploads/' + req.file.filename;
  if (req.params.kind === 'banner') { removeUpload(th.banner); th.banner = url; th.bannerCrop = null; }
  else { removeUpload(th.background && th.background.image); th.background = { ...(th.background || {}), kind: 'image', image: url, dim: (th.background && th.background.dim) || 0.3 }; }
  db.prepare('UPDATE servers SET theme = ? WHERE id = ?').run(JSON.stringify(th), s.id);
  emitServer(s.id);
  res.json(serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(s.id), req.userId));
});
api.delete('/servers/:id/media/:kind', auth, (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.MANAGE_SERVER, 'You need the Manage Server permission.');
  const th = themeOf(s);
  if (req.params.kind === 'banner') { removeUpload(th.banner); th.banner = ''; }
  else if (req.params.kind === 'background') { removeUpload(th.background && th.background.image); th.background = { kind: 'none' }; }
  db.prepare('UPDATE servers SET theme = ? WHERE id = ?').run(JSON.stringify(th), s.id);
  emitServer(s.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- roles
const cleanColor = (c) => (HEX.test(c || '') ? c : '');
const cleanIcon = (i) => [...String(i || '')].slice(0, 2).join('');
api.post('/servers/:id/roles', auth, (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.MANAGE_ROLES, 'You need the Manage Roles permission.');
  if (db.prepare('SELECT COUNT(*) AS n FROM roles WHERE server_id = ?').get(s.id).n >= 100) fail(400, 'A server can have up to 100 roles.');
  const b = req.body || {};
  const name = String(b.name || 'new role').trim().slice(0, 32) || 'new role';
  const mine = perms.base(s, req.userId);
  // New roles go just below your highest role (or on top, for the owner).
  const myTop = perms.top(s, req.userId);
  const maxPos = db.prepare('SELECT MAX(position) AS p FROM roles WHERE server_id = ?').get(s.id).p || 0;
  const pos = Number.isFinite(myTop) ? Math.max(1, myTop) : maxPos + 1;
  db.prepare('UPDATE roles SET position = position + 1 WHERE server_id = ? AND position >= ? AND id != ?').run(s.id, pos, s.id);
  const id = newId();
  db.prepare('INSERT INTO roles (id, server_id, name, color, icon, position, permissions, hoist, mentionable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, s.id, name, cleanColor(b.color), cleanIcon(b.icon), pos, (parseInt(b.permissions, 10) || 0) & mine & ALL_PERMS, b.hoist ? 1 : 0, b.mentionable ? 1 : 0, now());
  emitServer(s.id);
  res.json({ id });
});
function requireManageableRole(roleId, userId) {
  const r = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
  if (!r) fail(404, 'Role not found.');
  const s = requirePerm(r.server_id, userId, PM.MANAGE_ROLES, 'You need the Manage Roles permission.');
  if (r.id !== s.id && r.position >= perms.top(s, userId)) fail(403, 'You can only edit roles below your highest role.');
  return { r, s };
}
api.patch('/roles/:id', auth, (req, res) => {
  const { r, s } = requireManageableRole(req.params.id, req.userId);
  const b = req.body || {};
  const everyone = r.id === s.id;
  const mine = perms.base(s, req.userId);
  const name = everyone ? '@everyone' : b.name !== undefined ? (String(b.name).trim().slice(0, 32) || r.name) : r.name;
  // You can't grant permissions you don't have yourself.
  const permissions = b.permissions !== undefined ? (((parseInt(b.permissions, 10) || 0) & mine) | (r.permissions & ~mine)) & ALL_PERMS : r.permissions;
  // A role sold as a membership can't get moderator powers (they'd be for sale).
  const tier = MEMB.tierForRole(r.id);
  if (tier && (permissions & MEMB.POWERFUL & ~r.permissions)) fail(400, `This role is sold as the "${tier.name}" membership, so it can't have moderator powers.`);
  db.prepare('UPDATE roles SET name = ?, color = ?, icon = ?, permissions = ?, hoist = ?, mentionable = ? WHERE id = ?').run(
    name, everyone ? '' : b.color !== undefined ? cleanColor(b.color) : r.color, everyone ? '' : b.icon !== undefined ? cleanIcon(b.icon) : r.icon,
    permissions, everyone ? 0 : b.hoist !== undefined ? (b.hoist ? 1 : 0) : r.hoist, everyone ? 0 : b.mentionable !== undefined ? (b.mentionable ? 1 : 0) : r.mentionable, r.id);
  emitServer(s.id);
  res.json({ ok: true });
});
api.delete('/roles/:id', auth, (req, res) => {
  const { r, s } = requireManageableRole(req.params.id, req.userId);
  if (r.id === s.id) fail(400, 'The @everyone role can\u2019t be deleted.');
  // Paying members would silently lose what they pay for, and the membership would keep selling nothing.
  const tier = MEMB.tierForRole(r.id);
  if (tier) fail(409, `This role is sold as the "${tier.name}" membership. Give that membership another role, or stop selling it and wait for its members to end, first.`);
  db.prepare('DELETE FROM roles WHERE id = ?').run(r.id);
  db.prepare("DELETE FROM channel_overrides WHERE target_type = 'role' AND target_id = ?").run(r.id);
  emitServer(s.id);
  res.json({ ok: true });
});
// Reorder: ids from highest to lowest. Only roles below your own top role can move.
api.post('/servers/:id/roles/order', auth, (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.MANAGE_ROLES, 'You need the Manage Roles permission.');
  const myTop = perms.top(s, req.userId);
  const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(String).filter((x) => x !== s.id);
  const roles = db.prepare('SELECT * FROM roles WHERE server_id = ? AND id != ?').all(s.id, s.id);
  const movable = roles.filter((r) => r.position < myTop);
  const slots = movable.map((r) => r.position).sort((a, b) => b - a);
  const order = ids.filter((id) => movable.some((r) => r.id === id));
  if (order.length !== movable.length) fail(400, 'Include every role you can move.');
  db.transaction(() => order.forEach((id, i) => db.prepare('UPDATE roles SET position = ? WHERE id = ?').run(slots[i], id)))();
  emitServer(s.id);
  res.json({ ok: true });
});
// Members whose highest role is at or above `top` (with no role of your own above @everyone, that's everyone).
const membersAtOrAbove = (serverId, top) => db.prepare(`SELECT m.user_id FROM members m WHERE m.server_id = ? AND (? <= 0 OR EXISTS
    (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = m.server_id AND mr.user_id = m.user_id AND r.position >= ?))`)
  .all(serverId, top, top).map((r) => r.user_id);
// Per-channel overrides: [{ type: 'role'|'member', id, allow, deny }]. The list replaces the channel's overrides,
// within your reach: you need Manage Roles in this channel (one you can see), you can only allow or deny what you
// have here yourself (other bits keep their old value), and overrides for roles or people at or above your
// highest role aren't yours to add, change or remove, the same rule as editing roles. Unless you're the owner or
// an Administrator, the change also can't take anything away from anyone at or above your highest role, yourself
// included: denying @everyone reaches everyone, so checking targets alone would still let a junior moderator lock
// seniors out of a channel (or lock themselves out with no way back).
api.put('/channels/:id/overrides', auth, (req, res) => {
  const c = requireChannel(req.params.id, req.userId);
  const s = requirePerm(c.server_id, req.userId, PM.MANAGE_ROLES, 'You need the Manage Roles permission.');
  if (!canIn(s, c, req.userId, PM.MANAGE_ROLES)) fail(403, 'You don\u2019t have permission to change this channel\u2019s permissions.');
  const list = Array.isArray((req.body || {}).overrides) ? req.body.overrides.slice(0, 100) : [];
  const roles = new Map(db.prepare('SELECT id, position FROM roles WHERE server_id = ?').all(s.id).map((r) => [r.id, r]));
  const mine = perms.channel(s, c, req.userId) & CHANNEL_SCOPED;
  const myTop = perms.top(s, req.userId);
  const reachable = (o) => (o.type === 'role'
    ? o.id === s.id || (roles.has(o.id) && roles.get(o.id).position < myTop)
    : o.id === req.userId || perms.top(s, o.id) < myTop);
  const key = (o) => `${o.type}:${o.id}`;
  // What's stored now, cleaned the same way new entries are (so an untouched override compares equal).
  const old = new Map();
  for (const r of db.prepare('SELECT * FROM channel_overrides WHERE channel_id = ?').all(c.id)) {
    const allow = r.allow & CHANNEL_SCOPED; const deny = r.deny & CHANNEL_SCOPED & ~allow;
    const o = { type: r.target_type, id: r.target_id, allow, deny };
    if (allow || deny) old.set(key(o), o);
  }
  const next = new Map();
  for (const o of list) {
    const t = { type: o.type === 'member' ? 'member' : 'role', id: String(o.id || '') };
    if (t.type === 'role' ? !roles.has(t.id) : !isMember(s.id, t.id)) continue;
    // Roles sold as memberships can't get moderator powers in a channel either.
    const tier = t.type === 'role' && MEMB.tierForRole(t.id);
    if (tier && ((parseInt(o.allow, 10) || 0) & mine & MEMB.POWERFUL)) fail(400, `That role is sold as the "${tier.name}" membership, so it can't have moderator powers here.`);
    const prev = old.get(key(t)) || { allow: 0, deny: 0 };
    const allow = (((parseInt(o.allow, 10) || 0) & mine) | (prev.allow & ~mine)) & CHANNEL_SCOPED;
    const deny = (((parseInt(o.deny, 10) || 0) & mine) | (prev.deny & ~mine)) & CHANNEL_SCOPED & ~allow;
    if (allow || deny) next.set(key(t), { ...t, allow, deny });
  }
  for (const k of new Set([...old.keys(), ...next.keys()])) {
    const o = old.get(k); const n = next.get(k);
    if (reachable(o || n)) continue;
    if (!o || !n || o.allow !== n.allow || o.deny !== n.deny) fail(403, 'You can only change overrides for roles and people below your highest role.');
  }
  const guarded = perms.base(s, req.userId) === ALL_PERMS ? [] : membersAtOrAbove(s.id, myTop).filter((u) => u !== s.owner_id);
  const had = guarded.map((u) => [u, perms.channel(s, c, u)]);
  // Write, then compare what each guarded person can do here now; any loss throws, which undoes the write.
  db.transaction(() => {
    db.prepare('DELETE FROM channel_overrides WHERE channel_id = ?').run(c.id);
    for (const o of next.values()) db.prepare('INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)').run(c.id, o.type, o.id, o.allow, o.deny);
    for (const [u, was] of had) {
      if (!(was & ~perms.channel(s, c, u))) continue;
      if (u === req.userId) fail(409, 'That would take permissions in this channel away from you too, and you couldn\u2019t undo it. Allow them for yourself in the same change.');
      fail(403, 'That would take permissions in this channel away from people at or above your highest role.');
    }
  })();
  emitServer(s.id); // anyone who just lost access leaves the voice channel (recheckVoice)
  res.json({ ok: true });
});

// ---------------------------------------------------------------- bans
api.get('/servers/:id/bans', auth, (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.BAN_MEMBERS, 'You need the Ban Members permission.');
  res.json(db.prepare('SELECT user_id, reason, banned_by, created_at FROM bans WHERE server_id = ? ORDER BY created_at DESC').all(s.id)
    .map((b) => ({ user: publicUser(getUserRow(b.user_id)), reason: b.reason, bannedBy: b.banned_by, createdAt: b.created_at })));
});
api.post('/servers/:id/bans', auth, (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.BAN_MEMBERS, 'You need the Ban Members permission.');
  const uid = String((req.body || {}).userId || '');
  if (!getUserRow(uid) || uid === s.owner_id || uid === req.userId) fail(400, 'You can\u2019t ban that person.');
  if (isMember(s.id, uid) && perms.top(s, uid) >= perms.top(s, req.userId)) fail(403, 'You can only ban people whose highest role is below yours.');
  db.prepare('INSERT OR REPLACE INTO bans (server_id, user_id, banned_by, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(s.id, uid, req.userId, String((req.body || {}).reason || '').slice(0, 300), now());
  // Invites a banned person made stop working too: they could have handed them to a new account.
  db.prepare('DELETE FROM invites WHERE server_id = ? AND creator_id = ?').run(s.id, uid);
  if (isMember(s.id, uid)) removeMember(s.id, uid);
  emitServer(s.id);
  res.json({ ok: true });
});
api.delete('/servers/:id/bans/:uid', auth, (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.BAN_MEMBERS, 'You need the Ban Members permission.');
  db.prepare('DELETE FROM bans WHERE server_id = ? AND user_id = ?').run(s.id, req.params.uid);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- custom emoji
// Animated emoji: GIF, animated WebP and APNG all keep animating. We look inside the file rather than
// trusting its type, so an animated WebP or APNG is recognised too.
function isAnimatedImage(buf) {
  if (buf.slice(0, 3).toString('latin1') === 'GIF') {
    let frames = 0; // count image descriptors (0x2C) that follow a graphic control extension
    for (let i = 0; i < buf.length - 1 && frames < 2; i++) if (buf[i] === 0x21 && buf[i + 1] === 0xF9) frames++;
    return frames > 1;
  }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return buf.indexOf('ANIM', 12, 'latin1') !== -1;
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') { const idat = buf.indexOf('IDAT', 8, 'latin1'); const actl = buf.indexOf('acTL', 8, 'latin1'); return actl !== -1 && (idat === -1 || actl < idat); }
  return false;
}
const EMOJI_MAX = 2 * 1024 * 1024;
const emojiName = (n) => String(n || '').trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
function checkEmojiRoom(s, name) {
  if (name.length < 2) fail(400, 'Emoji names need at least 2 letters, numbers or underscores.');
  if (db.prepare('SELECT COUNT(*) AS n FROM emojis WHERE server_id = ?').get(s.id).n >= 200) fail(400, 'A server can have up to 200 emoji.');
  if (db.prepare('SELECT 1 FROM emojis WHERE server_id = ? AND name = ?').get(s.id, name)) fail(409, `There's already an emoji called :${name}:.`);
}
function addEmoji(s, name, url, animated, userId) {
  checkEmojiRoom(s, name);
  const id = newId();
  db.prepare('INSERT INTO emojis (id, server_id, name, url, animated, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, s.id, name, url, animated ? 1 : 0, userId, now());
  emitServer(s.id);
  return { id, name, animated: !!animated };
}
api.post('/servers/:id/emojis', auth, limited('image', uploadImage, 'file'), (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.MANAGE_EMOJIS, 'You need the Manage Emoji permission.');
  if (!req.file) fail(400, 'Choose an image.');
  const url = '/uploads/' + req.file.filename;
  try {
    if (req.file.size > EMOJI_MAX) fail(400, 'Emoji images can be up to 2 MB.');
    const animated = isAnimatedImage(fs.readFileSync(path.join(UPLOAD_DIR, req.file.filename)));
    res.json(addEmoji(s, emojiName((req.body || {}).name), url, animated, req.userId));
  } catch (e) { removeUpload(url); throw e; }
});
// Turn a GIPHY GIF or sticker into a server emoji (uses a small rendition so it stays light).
api.post('/servers/:id/emojis/from-giphy', auth, wrap(async (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.MANAGE_EMOJIS, 'You need the Manage Emoji permission.');
  if (!gifKey()) fail(400, 'GIF search isn\u2019t set up on this server yet.');
  const gid = String((req.body || {}).gifId || '');
  if (!/^[A-Za-z0-9]{4,40}$/.test(gid)) fail(400, 'Pick a GIF.');
  const name = emojiName((req.body || {}).name);
  if (name.length < 2) fail(400, 'Give the emoji a name.');
  // The cheap checks come first, so a request that can't succeed never costs a GIPHY/KLIPY call or a download.
  rateLimit('giphyemoji:' + req.userId, 20, 10 * 60000);
  checkEmojiRoom(s, name);
  const q = quotaOf(req.userId);
  if (q.blocked) fail(403, 'Uploads are turned off for your account. Ask an admin if you think that\u2019s a mistake.');
  const pickR = await gifForEmoji(gid);
  if (!pickR) fail(400, 'That GIF is too big to use as an emoji. Try another one.');
  let media;
  try { media = new URL(pickR.url); } catch { fail(400, 'Unexpected GIF location.'); }
  const r = await fetchGifMedia(media, AbortSignal.timeout(15000)).catch(() => fail(502, 'Couldn\u2019t download that GIF from GIPHY.'));
  if (!r) fail(400, 'Unexpected GIF location.');
  if (!r.ok) { cancelBody(r.body); fail(502, 'Couldn\u2019t download that GIF from GIPHY.'); }
  const buf = await readLimited(r, EMOJI_MAX).catch(() => fail(502, 'Couldn\u2019t download that GIF from GIPHY.'));
  if (!buf) fail(400, 'That GIF is too big to use as an emoji.');
  const over = overLimit(req.userId, q, buf.length);
  if (over) throw over;
  const file = `${newId()}${crypto.randomBytes(8).toString('hex')}.gif`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  recordFile(req.userId, file, 'emoji', buf.length);
  try { res.json(addEmoji(s, name, '/uploads/' + file, isAnimatedImage(buf), req.userId)); } catch (e) { removeUpload('/uploads/' + file); throw e; }
}));
api.patch('/emojis/:id', auth, (req, res) => {
  const e = db.prepare('SELECT * FROM emojis WHERE id = ?').get(req.params.id);
  if (!e) fail(404, 'Emoji not found.');
  requirePerm(e.server_id, req.userId, PM.MANAGE_EMOJIS, 'You need the Manage Emoji permission.');
  const name = emojiName((req.body || {}).name);
  if (name.length < 2) fail(400, 'Emoji names need at least 2 characters.');
  if (db.prepare('SELECT 1 FROM emojis WHERE server_id = ? AND name = ? AND id != ?').get(e.server_id, name, e.id)) fail(409, 'That name is taken.');
  db.prepare('UPDATE emojis SET name = ? WHERE id = ?').run(name, e.id);
  emitServer(e.server_id);
  res.json({ ok: true });
});
api.delete('/emojis/:id', auth, (req, res) => {
  const e = db.prepare('SELECT * FROM emojis WHERE id = ?').get(req.params.id);
  if (!e) fail(404, 'Emoji not found.');
  requirePerm(e.server_id, req.userId, PM.MANAGE_EMOJIS, 'You need the Manage Emoji permission.');
  db.prepare('DELETE FROM emojis WHERE id = ?').run(e.id);
  removeUpload(e.url);
  emitServer(e.server_id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- group DMs
// A group DM is a small private "server" (one text channel + one call channel) so it gets the same
// end-to-end encrypted group keys, key rotation and voice. It never shows up in the server rail.
// You can add friends and people you share a server with, but someone who takes DMs only from friends can't be
// pulled into a group chat (and rung in it) by a non-friend either.
function requireGroupAddable(adder, uid) {
  const row = uid !== adder && getUserRow(uid);
  const friends = !!row && areFriends(adder, uid);
  if (!row || isBlocked(adder, uid) || !(friends || sharesServer(adder, uid))) fail(403, 'You can add friends and people who share a server with you.');
  if (!friends && privacyOf(row).dms === 'friends') fail(403, `${row.username} only accepts messages from friends.`);
}
// Group chats: up to GROUP_MAX people, end-to-end encrypted like servers (they are small servers with one chat
// and one call). Anyone in the group can add friends or people they share a server with; the person who made
// it (the owner, passed on if they leave) can also remove people.
const GROUP_MAX = 25;
api.post('/groups', auth, (req, res) => {
  rateLimit('groupnew:' + req.userId, 30, 3600000);
  const ids = [...new Set(((req.body || {}).userIds || []).map(String))].filter((u) => u !== req.userId);
  if (!ids.length) fail(400, 'Pick at least one person.');
  if (ids.length > GROUP_MAX - 1) fail(400, `Group chats can have up to ${GROUP_MAX} people.`);
  ids.forEach((u) => requireGroupAddable(req.userId, u));
  const id = newId();
  const t = now();
  db.transaction(() => {
    db.prepare(`INSERT INTO servers (id, name, icon, owner_id, created_at, kind) VALUES (?, ?, NULL, ?, ?, 'group')`)
      .run(id, String((req.body || {}).name || '').trim().slice(0, 64), req.userId, t);
    [req.userId, ...ids].forEach((u) => db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, u, t));
    db.prepare(`INSERT INTO channels (id, server_id, name, type, position, created_at, category) VALUES (?, ?, 'chat', 'text', 0, ?, 'Text')`).run(newId(), id, t);
    db.prepare(`INSERT INTO channels (id, server_id, name, type, position, created_at, category) VALUES (?, ?, 'call', 'voice', 1, ?, 'Voice')`).run(newId(), id, t);
  })();
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  const server = serializeServer(row, req.userId);
  const users = {};
  server.memberIds.forEach((u) => { users[u] = publicUser(getUserRow(u)); });
  server.memberIds.forEach((u) => {
    io.in(`user:${u}`).socketsJoin(`server:${id}`);
    io.to(`user:${u}`).emit('server:add', { server: serializeServer(row, u), users, voice: {}, keyState: keyState(id, u) });
  });
  res.json({ ...server, keyState: keyState(id, req.userId) });
});
api.post('/groups/:id/members', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  if (s.kind !== 'group') fail(400, 'Use an invite to add people to a server.');
  const uid = String((req.body || {}).userId || '');
  if (isMember(s.id, uid)) fail(409, 'They\u2019re already in this group.');
  if (db.prepare('SELECT COUNT(*) AS n FROM members WHERE server_id = ?').get(s.id).n >= GROUP_MAX) fail(400, `Group chats can have up to ${GROUP_MAX} people.`);
  requireGroupAddable(req.userId, uid);
  db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(s.id, uid, now());
  io.to(`server:${s.id}`).emit('member:add', { serverId: s.id, user: publicUser(getUserRow(uid)) });
  io.in(`user:${uid}`).socketsJoin(`server:${s.id}`);
  const server = serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(s.id), uid);
  const users = {};
  server.memberIds.forEach((u) => { users[u] = publicUser(getUserRow(u)); });
  io.to(`user:${uid}`).emit('server:add', { server, users, voice: {}, keyState: keyState(s.id, uid) });
  emitKeyState(s.id);
  emitServer(s.id);
  res.json({ ok: true });
});

api.delete('/groups/:id/members/:uid', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  if (s.kind !== 'group') fail(400, 'This isn\u2019t a group chat.');
  const uid = String(req.params.uid);
  if (uid === req.userId) fail(400, 'Use Leave group to leave.');
  if (s.owner_id !== req.userId) fail(403, 'Only the group\u2019s owner can remove people.');
  if (!isMember(s.id, uid)) fail(404, 'They\u2019re not in this group.');
  removeMember(s.id, uid); // the others switch to a new key, so they can't read what's said next
  emitServer(s.id);
  res.json({ ok: true });
});
// Hand the group to someone else in it.
api.post('/groups/:id/owner', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  if (s.kind !== 'group') fail(400, 'This isn\u2019t a group chat.');
  if (s.owner_id !== req.userId) fail(403, 'Only the group\u2019s owner can do that.');
  const uid = String((req.body || {}).userId || '');
  if (!isMember(s.id, uid) || uid === req.userId) fail(404, 'Pick someone in the group.');
  db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(uid, s.id);
  emitServer(s.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- blocking, privacy, sessions
api.post('/blocks/:id', auth, (req, res) => {
  const other = req.params.id;
  if (other === req.userId || !getUserRow(other)) fail(404, 'User not found.');
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(req.userId, other, now());
  const had = db.prepare('DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)').run(req.userId, other, other, req.userId).changes;
  if (had) emitRelationship(null, req.userId, other);
  res.json({ ok: true });
});
api.delete('/blocks/:id', auth, (req, res) => {
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.userId, req.params.id);
  res.json({ ok: true });
});
// Server folders: how you've arranged the servers in your left bar (folders with a name, colour and emoji, their
// order, which are open, and an optional "focus" folder). Kept on the server so every device shows the same.
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
function cleanRail(input) {
  const b = input && typeof input === 'object' ? input : {};
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const id = (v) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : null);
  const folders = (Array.isArray(b.folders) ? b.folders : []).slice(0, 50).map((f) => (f && id(f.id) ? {
    id: f.id, name: str(f.name, 32) || 'Folder', color: HEX_COLOR.test(f.color) ? f.color : '#5865f2', emoji: str(f.emoji, 8),
    open: !!f.open, muted: !!f.muted, servers: [...new Set((Array.isArray(f.servers) ? f.servers : []).map(id).filter(Boolean))].slice(0, 200),
  } : null)).filter(Boolean);
  const order = [...new Set((Array.isArray(b.order) ? b.order : []).filter((x) => typeof x === 'string' && /^[fs]:[\w-]{1,40}$/.test(x)))].slice(0, 500);
  const focus = id(b.focus) && folders.some((f) => f.id === b.focus) ? b.focus : null;
  return { folders, order, focus };
}
function railOf(row) { try { return row.rail_layout ? cleanRail(JSON.parse(row.rail_layout)) : { folders: [], order: [], focus: null }; } catch { return { folders: [], order: [], focus: null }; } }
api.put('/me/rail', auth, (req, res) => {
  rateLimit('rail:' + req.userId, 120, 60000);
  const rail = cleanRail(req.body);
  const text = JSON.stringify(rail);
  if (text.length > 64000) fail(400, 'That\u2019s too many folders.');
  db.prepare('UPDATE users SET rail_layout = ? WHERE id = ?').run(text, req.userId);
  // Other devices of yours pick it up right away.
  io.to(`user:${req.userId}`).emit('rail:update', { rail, from: req.session.id });
  res.json(rail);
});
api.patch('/me/privacy', auth, (req, res) => {
  const row = getUserRow(req.userId);
  const p = privacyOf(row);
  const b = req.body || {};
  if (['everyone', 'friends'].includes(b.dms)) p.dms = b.dms;
  if (['everyone', 'mutual', 'nobody'].includes(b.friendRequests)) p.friendRequests = b.friendRequests;
  db.prepare('UPDATE users SET privacy = ? WHERE id = ?').run(JSON.stringify(p), req.userId);
  res.json(p);
});
// Settings → Sessions: every device signed in (and recently signed out), with where and when it was last used.
const sessionOut = (r, current) => ({
  id: r.id, current: r.id === current, createdAt: r.created_at, lastUsed: r.last_used_at || r.created_at, expiresAt: r.expires_at,
  revokedAt: r.revoked_at || null, revokeReason: r.revoke_reason || null, ua: r.ua || '', ip: r.ip || '', twoFactor: !!r.mfa_at,
  online: !!r.id && sessionSockets(r.user_id).has(r.id),
});
function sessionSockets(uid) {
  const out = new Set();
  if (!io) return out;
  for (const sid of onlineSockets.get(uid) || []) { const sock = io.sockets.sockets.get(sid); if (sock && sock.data.sid) out.add(sock.data.sid); }
  return out;
}
api.get('/me/sessions', auth, (req, res) => {
  const t = now();
  const rows = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY COALESCE(revoked_at, 0) ASC, last_used_at DESC LIMIT 100').all(req.userId);
  res.json({
    active: rows.filter((r) => sessionLive(r, t)).map((r) => sessionOut(r, req.session.id)),
    ended: rows.filter((r) => !sessionLive(r, t) && Math.max(r.revoked_at || 0, r.expires_at < t ? r.expires_at : 0, r.last_used_at || 0) > t - 30 * 86400000).slice(0, 20)
      .map((r) => ({ ...sessionOut(r, req.session.id), revokeReason: r.revoke_reason || 'expired' })),
    idleDays: Math.round(SESSION_IDLE_MS / 86400000), maxDays: Math.round(SESSION_MAX_MS / 86400000),
  });
});
api.delete('/me/sessions/:id', auth, (req, res) => {
  rateLimit('sessrevoke:' + req.userId, 60, 60 * 60 * 1000);
  const id = String(req.params.id);
  const hit = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!hit || !sessionLive(hit)) fail(404, 'Session not found.');
  if (hit.id === req.session.id) fail(400, 'Use Log out to end this session.');
  revokeSessions(req.userId, { id: hit.id, reason: 'revoked' });
  auditLog(req, 'session_revoked', req.userId, (hit.ua || '').slice(0, 120));
  res.json({ ok: true });
});
// "Log out all other devices".
api.post('/me/sessions/revoke-others', auth, (req, res) => {
  rateLimit('sessrevoke:' + req.userId, 60, 60 * 60 * 1000);
  const n = revokeSessions(req.userId, { except: req.session.id, reason: 'revoked' });
  if (n) auditLog(req, 'sessions_revoked_others', req.userId, `${n} device${n === 1 ? '' : 's'}`);
  res.json({ ok: true, count: n });
});

// ---------------------------------------------------------------- instance settings + GIPHY
// Instance staff, highest first:
//   owner      one person, settled once (see ownerId) and then only changed by handing it over. Only the owner
//              can give or take away staff roles, and hand over ownership.
//   admin      the whole admin dashboard and Settings → Instance. The accounts that took ADMIN_USERS names
//              are always admins.
//   moderator  reports, users (suspend, sign out, reset profile, notes), who's online and the audit log.
// Staff can only act on people ranked below them.
const getSetting = (k) => (db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(k) || {}).value;
const setSetting = (k, v) => (v === null || v === undefined
  ? db.prepare('DELETE FROM instance_settings WHERE key = ?').run(k)
  : db.prepare('INSERT OR REPLACE INTO instance_settings (key, value) VALUES (?, ?)').run(k, String(v)));
const firstAccount = () => (db.prepare('SELECT id FROM users WHERE is_bot = 0 AND deleted_at IS NULL ORDER BY created_at, rowid LIMIT 1').get() || {}).id;
// A person's account that can still sign in (not deleted, not a bot): the only kind that can hold staff powers.
const liveAccount = (id) => { const r = id && getUserRow(id); return r && !r.deleted_at && !r.is_bot ? r : null; };
const STAFF_RANK = { moderator: 1, admin: 2, owner: 3 };
const envAdmins = () => (process.env.ADMIN_USERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
// ADMIN_USERS names are matched to an account once: { name: userId }. The first account to hold a listed name
// keeps it, with its powers, even after renaming or deleting itself. So the name stays reserved, and nobody can
// register it later and become an admin. (Removing the name from ADMIN_USERS takes the powers away.)
// HELD_BACK marks a listed name nobody had when this was first set up on a server that already had accounts
// (see the start-up code below): nobody may take it, since it may have been an admin's before a rename.
const HELD_BACK = '!';
function envClaims() {
  try { const c = JSON.parse(getSetting('envAdminClaims') || '{}'); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; } catch { return {}; }
}
function claimEnvAdmin(row) {
  const n = String((row && row.username) || '').toLowerCase();
  if (!envAdmins().includes(n) || row.deleted_at || row.is_bot) return;
  const c = envClaims();
  if (c[n]) return;
  c[n] = row.id;
  setSetting('envAdminClaims', JSON.stringify(c));
}
// The ADMIN_USERS name an account holds its powers through, if any (it may have been renamed since).
const envAdminName = (uid) => { const c = envClaims(); return envAdmins().find((n) => c[n] === uid) || null; };
// True when nobody but `uid` may take this name because it's in ADMIN_USERS: it already belongs to another
// account, or (for renames) nobody has it yet and it would bring admin powers with it.
const envNameReserved = (name, uid) => { const n = String(name).toLowerCase(); return envAdmins().includes(n) && envClaims()[n] !== uid; };
// { userId: 'admin' | 'moderator' }. Older versions kept a plain list of extra admins under 'admins'.
function staffRoles() {
  let r = null;
  try { r = JSON.parse(getSetting('staffRoles') || 'null'); } catch { /* rebuilt below */ }
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    r = {};
    try { (JSON.parse(getSetting('admins') || '[]') || []).forEach((id) => { r[id] = 'admin'; }); } catch { /* none */ }
  }
  return r;
}
const saveStaffRoles = (r) => setSetting('staffRoles', JSON.stringify(r));
// Who owns the server is settled once and written down ('owner'), so a later sign-up can never take it over:
//   - an account holding an ADMIN_USERS name owns it (the first such name in the list), else the first account;
//   - except on a server set up with ADMIN_USERS before anyone signed up, whose first account took none of its
//     names ('ownerAwaitsEnv', see settleOwnerAtFirstSignUp): there the first listed name owns the server as
//     soon as it's registered, as documented. Until then ownerStandIn() runs it, without being written down.
// After that it changes only by handing it over in the app, or with `node server/cli.js set-owner`.
const ownerStandIn = (c) => envAdmins().map((n) => c[n]).find((x) => liveAccount(x)) || firstAccount();
function ownerId() {
  const set = getSetting('owner');
  if (set && liveAccount(set)) return set;
  const c = envClaims();
  const awaited = getSetting('ownerAwaitsEnv');
  if (awaited && envAdmins().includes(awaited) && !c[awaited]) return ownerStandIn(c); // still waiting for that sign-up
  if (awaited) setSetting('ownerAwaitsEnv', null); // registered now (or taken off ADMIN_USERS): settle below
  const id = (awaited && liveAccount(c[awaited]) && c[awaited]) || ownerStandIn(c);
  if (id && id !== set) setSetting('owner', id);
  return id;
}
// Right after an account is created. The very first one settles the owner, unless ADMIN_USERS names someone else
// who hasn't signed up yet: the operator set it up before signing up, so the first listed name gets the server.
function settleOwnerAtFirstSignUp() {
  const admins = envAdmins(); const c = envClaims();
  if (!getSetting('owner') && !getSetting('ownerAwaitsEnv') && admins.length && !admins.some((n) => c[n])) setSetting('ownerAwaitsEnv', admins[0]);
  ownerId();
}
function staffRole(uid) {
  const row = uid && getUserRow(uid);
  if (!row || row.deleted_at) return null;
  if (ownerId() === uid) return 'owner';
  if (envAdminName(uid)) return 'admin';
  const r = staffRoles()[uid];
  return STAFF_RANK[r] && r !== 'owner' ? r : null;
}
// At start-up (ADMIN_USERS may have changed): tie listed names to the accounts holding them now, then settle
// the owner. Sign-ups claim names as they're registered (see /auth/register).
{
  const firstTime = getSetting('envAdminClaims') === undefined;
  for (const n of envAdmins()) claimEnvAdmin(db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(n));
  const c = envClaims();
  // The first start of this version on a server that already has accounts: before it, an ADMIN_USERS admin could
  // rename or delete their account and leave the name free, and the next person to register it became an admin.
  // There's no telling which free names were someone's, so all of them are held back.
  if (firstTime && firstAccount()) for (const n of envAdmins()) if (!c[n]) c[n] = HELD_BACK;
  // A held-back name taken off ADMIN_USERS is let go (listed again later, it goes to whoever registers it first).
  for (const n of Object.keys(c)) if (c[n] === HELD_BACK && !envAdmins().includes(n)) delete c[n];
  setSetting('envAdminClaims', JSON.stringify(c));
  const owner = ownerId();
  const who = (id) => (getUserRow(id) || {}).username;
  const held = envAdmins().filter((n) => c[n] === HELD_BACK);
  if (held.length) console.warn(`\n  ADMIN_USERS lists ${held.join(', ')}, which no account has. Nobody can sign up with ${held.length > 1 ? 'these names' : 'it'}: before this update, an admin who renamed or deleted their account left the name free for anyone. If you're keeping one for someone who hasn't signed up yet, take it off ADMIN_USERS and restart (then give them a role in Admin \u2192 Team & roles once they've signed up).`);
  const first = envAdmins()[0];
  if (getSetting('ownerAwaitsEnv')) console.warn(`\n  ${getSetting('ownerAwaitsEnv')} (the first name in ADMIN_USERS when this server got its first account) will own this server once that account is signed up.${owner ? ` Until then ${who(owner)} runs it.` : ''}`);
  else if (first && owner && c[first] !== owner && !held.includes(first)) console.warn(`\n  ADMIN_USERS starts with ${first}, but ${who(owner)} owns this server (the owner is settled once and doesn't follow ADMIN_USERS). To change it, hand ownership over in Admin \u2192 Team & roles, or run: node server/cli.js set-owner ${liveAccount(c[first]) ? who(c[first]) : '<username>'}`);
}
const staffRank = (uid) => STAFF_RANK[staffRole(uid)] || 0;
const isStaff = (uid) => staffRank(uid) >= 1;
function isInstanceAdmin(uid) { return staffRank(uid) >= 2; }
const requireInstanceAdmin = (uid) => { if (!isInstanceAdmin(uid)) fail(403, 'Only the server administrator can change this.'); };
// Email, recovery key and two-factor sign-in (server/accounts.js).
ACCT = require('./accounts')({ api, auth, db, fail, wrap, rateLimit, countHit, limitNet, getSetting, setSetting, getUserRow, selfUser, broadcastUser, bcrypt, seal, unseal,
  tokenId, requireInstanceAdmin: (uid) => requireInstanceAdmin(uid), requireOutranks: (req, id) => requireOutranks(req, id), auditLog, secEvent: (...a) => secEvent(...a), cleanIp,
  emitKeyState: (sid) => emitKeyState(sid), brandName: () => brand().name, isB64ish, isSalt, atRestKey, stepUp, createSession, revokeSessions, hitsSoFar, verifyCaptcha: (...a) => verifyCaptcha(...a) });
// The key saved in the app wins over .env, so the admin never has to edit files. Keys saved in the app are
// sealed with data/secret.key (sealSecret in db.js), like the SMTP password.
const giphyKey = () => openSecret(getSetting('giphyKey')) || GIPHY_API_KEY;
const giphyRating = () => (['g', 'pg', 'pg-13', 'r'].includes(getSetting('giphyRating')) ? getSetting('giphyRating') : 'pg-13');
const gifProxyOn = () => (getSetting('gifProxy') ?? (process.env.GIF_PROXY || 'true')) !== 'false';
const GIPHY_API = process.env.GIPHY_API_BASE || 'https://api.giphy.com';

// GIF providers. KLIPY (free, unlimited production keys; same API shape as the retired Tenor) is the
// default; GIPHY is still supported. Results are cached and shared by everyone, so popular searches,
// trending and categories cost one API call per 15–30 minutes instead of one per person.
const klipyKey = () => openSecret(getSetting('klipyKey')) || process.env.KLIPY_API_KEY || '';
const gifProvider = () => {
  const p = getSetting('gifProvider');
  if (p === 'klipy' || p === 'giphy' || p === 'library') return p;
  return klipyKey() ? 'klipy' : giphyKey() ? 'giphy' : 'klipy';
};
const gifKey = (provider = gifProvider()) => (provider === 'library' ? '' : provider === 'klipy' ? klipyKey() : giphyKey());
const KLIPY_API = process.env.KLIPY_API_BASE || 'https://api.klipy.com';
const gifCache = new Map(); // key -> { at, ttl, value }
let gifLimitedUntil = 0; // after a "too many requests", use the library for a while instead of asking again
async function cachedGif(key, ttlMs, fetcher) {
  const hit = gifCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  let value;
  try { value = await fetcher(); } catch (e) {
    // Limit reached or provider down: an older answer is much better than an error.
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
  gifCache.set(key, { at: Date.now(), ttl: ttlMs, value });
  if (gifCache.size > 600) gifCache.delete(gifCache.keys().next().value); // forget the oldest
  return value;
}
async function gifFetch(provider, base, pathname, params, key = gifKey(provider)) {
  const url = new URL(base + pathname);
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== '' && url.searchParams.set(k, String(v)));
  url.searchParams.set(provider === 'klipy' ? 'key' : 'api_key', key);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const name = provider === 'klipy' ? 'KLIPY' : 'GIPHY';
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 401 || r.status === 403) fail(502, `${name} rejected the API key. An admin can fix it in Settings \u2192 Instance.`);
    if (r.status === 429) { gifLimitedUntil = Date.now() + 10 * 60000; fail(503, `${name}\u2019s hourly limit was reached. Request a free production key in ${name}\u2019s dashboard to remove the limit.`, 'gif_limit'); }
    if (!r.ok) fail(502, 'GIF search is unavailable right now.');
    return await r.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail(502, `Couldn\u2019t reach ${name} from this server.`);
  } finally { clearTimeout(timer); }
}
const giphy = (pathname, params, key) => gifFetch('giphy', GIPHY_API, pathname, params, key);
const klipy = (pathname, params, key) => gifFetch('klipy', KLIPY_API, pathname, { client_key: 'hearth', ...params }, key);
// A reasonably sized file to send and a small one for the picker.
function gifItem(g) {
  const im = g.images || {};
  const send = im.downsized_medium || im.downsized || im.original || {};
  const prev = im.fixed_width_downsampled || im.fixed_width || send;
  return { id: g.id, title: g.title || '', url: send.url, preview: prev.url, width: Number(prev.width) || 200, height: Number(prev.height) || 200 };
}
function klipyItem(r) {
  const f = r.media_formats || {};
  const send = f.mediumgif || f.gif || f.gif_transparent || f.tinygif || {};
  const prev = f.tinygif || f.tinygif_transparent || f.nanogif || send;
  const dims = prev.dims || send.dims || [200, 200];
  return { id: String(r.id), title: r.content_description || r.title || '', url: send.url, preview: prev.url, width: +dims[0] || 200, height: +dims[1] || 200, size: +send.size || 0 };
}
async function gifSearch({ q, type, pos }) {
  const provider = gifProvider();
  const ck = `${provider}|${type}|${q.toLowerCase()}|${pos}`;
  return cachedGif(ck, q ? 15 * 60000 : 30 * 60000, async () => {
    if (provider === 'klipy') {
      const params = { limit: 24, pos, contentfilter: 'medium', media_filter: 'gif,tinygif,mediumgif,nanogif,gif_transparent,tinygif_transparent', searchfilter: type === 'stickers' ? 'sticker' : undefined };
      const json = await klipy(q ? '/v2/search' : '/v2/featured', { q: q || undefined, ...params });
      const items = (json.results || []).map(klipyItem).filter((g) => g.url && g.preview);
      return { items, nextOffset: json.next && items.length ? String(json.next) : null };
    }
    const offset = Math.max(0, Math.min(4999, parseInt(pos, 10) || 0));
    const json = await giphy(`/v1/${type}/${q ? 'search' : 'trending'}`, { q: q || undefined, limit: 24, offset, rating: giphyRating(), bundle: 'messaging_non_clips' });
    const items = (json.data || []).map(gifItem).filter((g) => g.url && g.preview);
    const p = json.pagination || {};
    const next = (p.offset || offset) + (p.count || items.length);
    return { items, nextOffset: items.length && next < (p.total_count || 0) ? next : null };
  });
}
async function gifCategories() {
  const provider = gifProvider();
  return cachedGif(`${provider}|categories`, 6 * 3600000, async () => {
    if (provider === 'klipy') {
      const json = await klipy('/v2/categories', { type: 'featured' });
      return (json.tags || []).slice(0, 30).map((t) => ({ name: t.searchterm || t.name, preview: t.image })).filter((c) => c.name && c.preview);
    }
    const json = await giphy('/v1/gifs/categories', {});
    return (json.data || []).slice(0, 30).map((c) => ({ name: c.name, preview: c.gif ? gifItem(c.gif).preview : null })).filter((c) => c.preview);
  });
}
// One GIF by id, as a small file suitable for a custom emoji.
async function gifForEmoji(id) {
  if (gifProvider() === 'klipy') {
    const json = await klipy('/v2/posts', { ids: id, media_filter: 'tinygif,nanogif,gif,tinygif_transparent' });
    const f = ((json.results || [])[0] || {}).media_formats || {};
    return [f.tinygif_transparent, f.tinygif, f.nanogif, f.gif].find((x) => x && x.url && (+x.size || 0) <= 2 * 1024 * 1024);
  }
  const json = await giphy(`/v1/gifs/${id}`, {});
  const im = (json.data && json.data.images) || {};
  return [im.fixed_height_small, im.fixed_width_small, im.fixed_height, im.downsized].find((x) => x && x.url && (+x.size || 0) <= 2 * 1024 * 1024);
}

api.get('/gifs', auth, wrap(async (req, res) => {
  if (!features().gifs) fail(404, 'GIFs are turned off on this server.');
  rateLimit('gif:' + req.userId, 90, 60000);
  const q = String(req.query.q || '').trim().slice(0, 100);
  const type = req.query.type === 'stickers' ? 'stickers' : 'gifs';
  const pos = String(req.query.offset || '').slice(0, 200);
  // The server's own library: always free, never limited.
  if (req.query.source === 'library' || !gifKey() || Date.now() < gifLimitedUntil) {
    return res.json({ ...librarySearch({ q, sticker: type === 'stickers', offset: parseInt(pos, 10) || 0 }), library: true, limited: Date.now() < gifLimitedUntil && req.query.source !== 'library' });
  }
  try {
    const found = await gifSearch({ q, type, pos });
    rememberServedGifs(found.items, q, type === 'stickers');
    res.json(found);
  } catch (e) {
    if (e.code !== 'gif_limit' && !(e.status >= 500)) throw e;
    res.json({ ...librarySearch({ q, sticker: type === 'stickers', offset: 0 }), library: true, limited: true });
  }
}));
api.get('/gifs/categories', auth, wrap(async (req, res) => {
  if (req.query.source === 'library' || !gifKey() || Date.now() < gifLimitedUntil) return res.json(libraryCategories());
  try { res.json(await gifCategories()); } catch { res.json(libraryCategories()); }
}));

// ---------------------------------------------------------------- the server's own GIF library
// GIFs live on this server, so searching and sending them costs nothing and has no limits. They come
// from people uploading them (Settings \u2192 GIFs) and, if the admin turns it on, from GIFs people
// send from KLIPY/GIPHY (each one is downloaded once, so popular GIFs stop costing API calls).
const LIB_MAX_MB = 8;
const libSetting = (k, d) => getSetting(k) ?? d;
const libraryWho = () => (['everyone', 'staff'].includes(libSetting('gifLibraryWho')) ? libSetting('gifLibraryWho') : 'everyone');
const libraryLearn = () => libSetting('gifLibraryLearn', 'false') === 'true';
const libraryCapMb = () => Math.max(100, Math.min(500000, parseInt(libSetting('gifLibraryCapMb', '5000'), 10) || 5000));
const libOut = (g) => ({ id: 'lib:' + g.id, title: g.title, url: '/uploads/' + g.file, preview: '/uploads/' + g.file, width: g.width || 200, height: g.height || 200, library: true, uses: g.uses });
function librarySearch({ q, sticker, offset = 0 }) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  const where = ['sticker = ?'];
  const args = [sticker ? 1 : 0];
  words.forEach((w) => { where.push("(lower(title) LIKE ? OR (' ' || tags || ' ') LIKE ?)"); args.push(`%${w}%`, `% ${w}%`); });
  const rows = db.prepare(`SELECT * FROM gif_library WHERE ${where.join(' AND ')} ORDER BY uses DESC, created_at DESC LIMIT 25 OFFSET ?`).all(...args, Math.max(0, offset));
  const items = rows.slice(0, 24).map(libOut);
  return { items, nextOffset: rows.length > 24 ? String(offset + 24) : null };
}
function libraryCategories() {
  const counts = new Map();
  db.prepare('SELECT tags, file FROM gif_library WHERE sticker = 0 ORDER BY uses DESC LIMIT 400').all().forEach((r) => {
    r.tags.split(' ').filter((t) => t.length > 2).forEach((t) => { const c = counts.get(t) || { n: 0, file: r.file }; c.n++; counts.set(t, c); });
  });
  return [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 24).map(([name, c]) => ({ name, preview: '/uploads/' + c.file }));
}
const cleanTags = (...parts) => [...new Set(parts.join(' ').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 1 && t.length < 24))].slice(0, 24).join(' ');
function imageDims(buf) {
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 12, 16) === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  return [0, 0];
}
// Adds a GIF to the library: either bytes downloaded from a provider (buf) or a file already uploaded to
// UPLOAD_DIR (file + size, recorded in user_files by limited() so it counts toward the uploader's storage).
function addToLibrary({ buf, file, size, ext, title, tags, sticker, source, sourceId, userId }) {
  let head = buf;
  if (buf) {
    file = fileName(ext);
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    size = buf.length;
  } else {
    head = Buffer.alloc(32);
    const fd = fs.openSync(path.join(UPLOAD_DIR, file), 'r');
    try { head = head.subarray(0, fs.readSync(fd, head, 0, 32, 0)); } finally { fs.closeSync(fd); }
  }
  const [w, hgt] = imageDims(head);
  const id = newId();
  try {
    db.prepare(`INSERT INTO gif_library (id, file, title, tags, width, height, size, sticker, source, source_id, added_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, file, String(title || '').slice(0, 120), cleanTags(title || '', tags || ''), w, hgt, size, sticker ? 1 : 0, source, sourceId || null, userId || null, now());
  } catch (e) {
    if (buf) fs.promises.unlink(path.join(UPLOAD_DIR, file)).catch(() => {}); // e.g. two people sent the same new GIF at once
    throw e;
  }
  trimLibrary();
  return db.prepare('SELECT * FROM gif_library WHERE id = ?').get(id);
}
// Removes a library GIF and its file (and its storage bookkeeping, if someone uploaded it).
function removeLibraryGif(g) {
  db.prepare('DELETE FROM gif_library WHERE id = ?').run(g.id);
  removeUpload('/uploads/' + g.file);
}
// Over the size the admin allows: the least used GIFs that were collected automatically go first.
function trimLibrary() {
  const cap = libraryCapMb() * MB;
  let total = db.prepare('SELECT COALESCE(SUM(size), 0) n FROM gif_library').get().n;
  if (total <= cap) return;
  for (const g of db.prepare("SELECT id, file, size FROM gif_library ORDER BY (source = 'upload') ASC, uses ASC, created_at ASC LIMIT 200").all()) {
    if (total <= cap) break;
    removeLibraryGif(g);
    total -= g.size;
  }
}
const uploadGif = {
  storage: diskStorage,
  fileFilter: (req, file, cb) => (['.gif', '.webp', '.png'].includes(safeExt(file.originalname)) && /^image\//.test(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Use a GIF, animated WebP or PNG.'))),
};
api.get('/gifs/library', auth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM gif_library').get();
  res.json({ count: total.n, bytes: total.bytes, capMb: libraryCapMb(), who: libraryWho(), learn: libraryLearn(), canAdd: libraryWho() === 'everyone' || isStaff(req.userId) });
});
// Library uploads go through limited() like every other upload: they count toward the uploader's storage and
// daily allowance, and an admin's "delete their files" removes them too.
api.post('/gifs/library', auth, (req, res, next) => {
  try {
    if (!features().gifs) fail(404, 'GIFs are turned off on this server.');
    if (libraryWho() === 'staff' && !isStaff(req.userId)) fail(403, 'Only staff can add GIFs to this server\u2019s library.');
    rateLimit('giflib:' + req.userId, 60, 3600000); // before the file is received
    next();
  } catch (e) { next(e); }
}, limited('gif', uploadGif, 'file'), (req, res) => {
  if (!req.file) fail(400, 'Choose a GIF.');
  const b = req.body || {};
  checkWords(b.title, b.tags);
  const g = addToLibrary({ file: req.file.filename, size: req.file.size, title: b.title, tags: b.tags, sticker: b.sticker === 'true', source: 'upload', userId: req.userId });
  res.json(libOut(g));
});
// GIFs this server recently found for someone (provider search results), so a GIF that's sent can be checked
// against what the provider really returned: its address, title and the search it came from. The app only says
// which one was picked; it can't choose what gets stored or how it's tagged.
const servedGifs = new Map(); // `${provider}|${id}` -> { url, title, q, sticker, at }
function rememberServedGifs(items, q, sticker) {
  const provider = gifProvider();
  const at = Date.now();
  for (const g of items || []) {
    if (!g || !g.id || typeof g.url !== 'string') continue;
    const key = `${provider}|${g.id}`;
    servedGifs.delete(key); // keep the map in "last seen" order
    servedGifs.set(key, { url: g.url, title: String(g.title || ''), q, sticker, at });
  }
  while (servedGifs.size > 5000) servedGifs.delete(servedGifs.keys().next().value);
}
const learning = new Set(); // downloads in progress, so one GIF sent twice at once is fetched once
// Someone sent a GIF: count it (library GIFs) or, if allowed, keep a copy of a KLIPY/GIPHY one.
api.post('/gifs/used', auth, wrap(async (req, res) => {
  const b = req.body || {};
  rateLimit('gifused:' + req.userId, 60, 60000);
  if (typeof b.id === 'string' && b.id.startsWith('lib:')) {
    db.prepare('UPDATE gif_library SET uses = uses + 1, last_used = ? WHERE id = ?').run(now(), b.id.slice(4));
    return res.json({ ok: true });
  }
  if (!libraryLearn() || typeof b.url !== 'string' || typeof b.id !== 'string' || !/^[\w-]{2,64}$/.test(b.id)) return res.json({ ok: true });
  const source = gifProvider();
  const have = db.prepare('SELECT id FROM gif_library WHERE source = ? AND source_id = ?').get(source, b.id);
  if (have) { db.prepare('UPDATE gif_library SET uses = uses + 1, last_used = ? WHERE id = ?').run(now(), have.id); return res.json({ ok: true }); }
  // Only a GIF this server found for someone in the last few hours, at the address the provider gave for it.
  // Its title and tags come from the provider and the search, and go through the word filter like uploads.
  const key = `${source}|${b.id}`;
  const seen = servedGifs.get(key);
  if (!seen || seen.url !== b.url || Date.now() - seen.at > 6 * 3600000 || learning.has(key)) return res.json({ ok: true });
  let u;
  try { u = new URL(seen.url); } catch { return res.json({ ok: true }); }
  if (!gifHostOk(u)) return res.json({ ok: true });
  try { checkWords(seen.title, seen.q); } catch { return res.json({ ok: true }); }
  res.json({ ok: true }); // the download happens in the background
  learning.add(key);
  try {
    const r = await fetchGifMedia(u, AbortSignal.timeout(15000));
    const type = (r && r.headers.get('content-type')) || '';
    if (!r || !r.ok || !/^image\/(gif|webp|png)/.test(type)) { if (r) cancelBody(r.body); return; }
    const buf = await readLimited(r, LIB_MAX_MB * MB);
    if (!buf) return;
    const ext = type.includes('webp') ? '.webp' : type.includes('png') ? '.png' : '.gif';
    // added_by: who caused it to be stored, so admins can trace (and clear) what an account added.
    addToLibrary({ buf, ext, title: seen.title, tags: seen.q, sticker: seen.sticker, source, sourceId: b.id, userId: req.userId });
  } catch { /* not important */ } finally { learning.delete(key); }
}));
api.delete('/gifs/library/:id', auth, (req, res) => {
  if (!isStaff(req.userId)) fail(403, 'Only staff can remove GIFs from the library.');
  const g = db.prepare('SELECT * FROM gif_library WHERE id = ?').get(String(req.params.id).replace(/^lib:/, ''));
  if (!g) fail(404, 'Already gone.');
  removeLibraryGif(g);
  adminLog(req, 'gif_removed', g.id, g.title);
  res.json({ ok: true });
});
api.put('/admin/gif-library', auth, (req, res) => {
  requireInstanceAdmin(req.userId);
  const b = req.body || {};
  if (['everyone', 'staff'].includes(b.who)) setSetting('gifLibraryWho', b.who);
  if (b.learn !== undefined) setSetting('gifLibraryLearn', b.learn ? 'true' : 'false');
  if (b.capMb !== undefined) { setSetting('gifLibraryCapMb', String(Math.max(100, Math.min(500000, parseInt(b.capMb, 10) || 5000)))); trimLibrary(); }
  adminLog(req, 'gif_library_settings', null, `who=${libraryWho()} learn=${libraryLearn()} cap=${libraryCapMb()}MB`);
  io.emit('config:update', { gifsEnabled: true });
  res.json({ who: libraryWho(), learn: libraryLearn(), capMb: libraryCapMb() });
});

// GIF privacy proxy: viewers load GIPHY media through this server, so GIPHY never sees their IP.
// Links carry a short-lived signed token (images can't send login headers), and only GIPHY's media
// hosts are allowed, so this can't be used as an open proxy.
const MEDIA_HOSTS = /^(media\d*\.giphy\.com|i\.giphy\.com|static\.klipy\.com|static\.klipy\.co|media\.klipy\.com)$/i;
const EXTRA_MEDIA_HOSTS = (process.env.GIF_PROXY_EXTRA_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean);
const gifHostOk = (u) => (u.protocol === 'https:' && MEDIA_HOSTS.test(u.hostname)) || EXTRA_MEDIA_HOSTS.includes(u.host);
const GIF_MEDIA_MAX = 20 * 1024 * 1024;
// Fetches GIF media, following up to 3 redirects itself and checking each one, so a redirect can't send this
// server anywhere but the GIF providers' media hosts. null if it leads elsewhere.
async function fetchGifMedia(u, signal) {
  let target = u;
  for (let hop = 0; hop < 4; hop++) {
    if (!gifHostOk(target)) return null;
    const r = await fetch(target, { signal, redirect: 'manual', headers: { 'User-Agent': 'Hearth' } });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!loc) return r;
    await cancelBody(r.body);
    try { target = new URL(loc, target); } catch { return null; }
  }
  return null;
}
// The token belongs to one sign-in session: it stops working when that session ends (log out, revoked, expired)
// or the account is suspended or deleted, not just after its 7 days.
const mediaSig = (uid, sid, exp) => crypto.createHmac('sha256', atRestKey).update(`media|${uid}|${sid}|${exp}`).digest('base64url').slice(0, 22);
function mediaToken(uid, sid) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  return `${uid}.${sid}.${exp}.${mediaSig(uid, sid, exp)}`;
}
function checkMediaToken(t) {
  const [uid, sid, exp, sig, extra] = String(t || '').split('.');
  if (!uid || !sid || !exp || !sig || extra !== undefined || +exp < Date.now() / 1000) return false;
  const good = mediaSig(uid, sid, exp);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  const u = s && s.user_id === uid && sessionLive(s) && db.prepare('SELECT id, suspended_at, suspended_until, deleted_at FROM users WHERE id = ?').get(uid);
  return !!u && !u.deleted_at && !stillSuspended(u);
}
app.get(['/media/gif', '/media/gif/:key'], wrap(async (req, res) => {
  if (!gifProxyOn()) return res.status(404).end();
  if (!checkMediaToken(req.query.t)) return res.status(403).end();
  let u;
  try { u = new URL(String(req.query.u || '')); } catch { return res.status(400).end(); }
  if (!gifHostOk(u)) return res.status(400).end();
  rateLimit('gifmedia:' + req.ip, 600, 60000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetchGifMedia(u, ctl.signal);
    if (!r) return res.status(502).end();
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^(image|video)\//.test(type)) { cancelBody(r.body); return res.status(502).end(); }
    const len = +(r.headers.get('content-length') || 0);
    if (len > GIF_MEDIA_MAX) { cancelBody(r.body); return res.status(413).end(); }
    res.setHeader('Content-Type', type);
    if (len) res.setHeader('Content-Length', String(len));
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    const { Readable, Transform, pipeline } = require('stream');
    // The size limit holds even when the provider doesn't say the size up front: past it, the copy stops.
    let sent = 0;
    const cap = new Transform({ transform(chunk, enc, cb) { sent += chunk.length; if (sent > GIF_MEDIA_MAX) cb(new Error('too big')); else cb(null, chunk); } });
    pipeline(Readable.fromWeb(r.body), cap, res, () => {});
  } catch { if (!res.headersSent) res.status(502).end(); } finally { clearTimeout(timer); }
}));

// The news bot (server/newsbot.js): follows feeds and posts new items into channels.
const NEWS = require('./newsbot')({ api, app, auth, db, fail, wrap, rateLimit, seal, newId, requireServer,
  canManageServer: (s, uid) => can(s, uid, PM.MANAGE_SERVER), serializeMessage, toChannel, checkMediaToken, emitServerFeeds: (serverId) => emitServer(serverId),
  searchSteam: (q) => ACT.searchGames(q),
  // Personal trackers found something: tell the person's open apps, and push a notification if they want one.
  notifyUser: (uid, p) => {
    io.to(`user:${uid}`).emit('updates:new', p);
    if (p.notify) pushTo([uid], { title: `${p.count} new \u2014 ${p.title}`, body: p.first.title, tag: `updates-${p.feedId}`, url: '/#updates' });
  } });
// Study tools (server/study.js): encrypted sync for Recall's decks, pictures and profile.
require('./study')({ api, auth, db, fail, rateLimit, pushTo: (...a) => pushTo(...a), emitToUser: (uid, ev, data) => io && io.to(`user:${uid}`).emit(ev, data) });
ACT = require('./activity')({ api, app, auth, db, emit: (...a) => io && io.emit(...a), fail, wrap, rateLimit, isOnline, getUserRow, getSetting, setSetting, checkMediaToken, sealSecret, openSecret, auditLog,
  requireInstanceAdmin, checkWords, broadcastUser: (id) => broadcastUser(id), DATA_DIR, version: require('../package.json').version });

// Admin: GIF settings (key, rating, privacy proxy) without editing .env.
api.get('/admin/settings', auth, (req, res) => {
  requireInstanceAdmin(req.userId);
  const appKey = getSetting('giphyKey');
  res.json({ gifProvider: gifProvider(), klipyKeySet: !!klipyKey(), klipyKeyHint: klipyKey() ? '\u2022\u2022\u2022\u2022' + klipyKey().slice(-4) : '', cacheEntries: gifCache.size,
    giphyKeySet: !!giphyKey(), giphyKeySource: appKey ? 'app' : GIPHY_API_KEY ? 'env' : null, giphyKeyHint: giphyKey() ? '\u2022\u2022\u2022\u2022' + giphyKey().slice(-4) : '', giphyRating: giphyRating(), gifProxy: gifProxyOn() });
});
api.patch('/admin/settings', auth, (req, res) => {
  requireInstanceAdmin(req.userId);
  const b = req.body || {};
  if (b.giphyKey !== undefined) setSetting('giphyKey', sealSecret(String(b.giphyKey || '').trim().slice(0, 100)) || null);
  if (b.klipyKey !== undefined) setSetting('klipyKey', sealSecret(String(b.klipyKey || '').trim().slice(0, 200)) || null);
  if (['klipy', 'giphy', 'library'].includes(b.gifProvider)) { setSetting('gifProvider', b.gifProvider); gifCache.clear(); gifLimitedUntil = 0; }
  if (b.giphyRating !== undefined && ['g', 'pg', 'pg-13', 'r'].includes(b.giphyRating)) setSetting('giphyRating', b.giphyRating);
  if (b.gifProxy !== undefined) setSetting('gifProxy', b.gifProxy ? 'true' : 'false');
  io.emit('config:update', { gifsEnabled: true, gifLibraryOnly: !gifKey(), gifProvider: gifProvider(), gifProxy: gifProxyOn() });
  const changed = ['giphyKey', 'klipyKey', 'gifProvider', 'giphyRating', 'gifProxy'].filter((k) => b[k] !== undefined);
  if (changed.length) adminLog(req, 'gif_settings', null, changed.join(', '));
  res.json({ ok: true });
});
api.post('/admin/giphy/test', auth, wrap(async (req, res) => {
  requireInstanceAdmin(req.userId);
  const provider = (req.body || {}).provider === 'giphy' ? 'giphy' : (req.body || {}).provider === 'klipy' ? 'klipy' : gifProvider();
  const key = String((req.body || {}).key || '').trim() || gifKey(provider);
  if (!key) fail(400, 'Paste a key first.');
  if (provider === 'klipy') {
    const json = await klipy('/v2/featured', { limit: 1, media_filter: 'tinygif' }, key);
    const r = (json.results || [])[0];
    return res.json({ ok: Array.isArray(json.results), sample: r ? klipyItem(r).preview : null });
  }
  const json = await giphy('/v1/gifs/trending', { limit: 1, rating: 'g' }, key);
  res.json({ ok: Array.isArray(json.data), sample: json.data && json.data[0] ? gifItem(json.data[0]).preview : null });
}));


// ---------------------------------------------------------------- TURN relay for calls
// Some networks (mobile data, CGNAT home routers, school/office Wi-Fi) block direct connections, so calls
// need a relay. With coturn's shared-secret mode, every signed-in user gets short-lived relay passwords
// (valid 12 to 18 hours), so only people with an account here can use the relay (anyone, while sign-ups are
// open). Set up with scripts/setup-turn.sh, which also caps each relayed connection's bandwidth.
const turnUrls = () => String(getSetting('turnUrls') || process.env.TURN_URL || '').split(',').map((x) => x.trim()).filter(Boolean);
const turnSecret = () => getSetting('turnSecret') || process.env.TURN_SECRET || '';
// The older static TURN_USERNAME/TURN_CREDENTIAL still work, but then every signed-in user (and every former
// member) holds the same relay password, forever. Say so, so it gets replaced by the shared-secret mode.
if (process.env.TURN_USERNAME && !turnSecret()) console.warn('  TURN_USERNAME/TURN_CREDENTIAL hand everyone the same relay password that never expires. Use TURN_SECRET instead (sudo bash scripts/setup-turn.sh sets it all up).');
// Relays: this server's own (if set up) plus every linked region that's up (server/regions.js). Each is its own
// entry with a region name, so the app can measure which answer fastest and use those.
const REG = require('./regions')({ api, app, auth, db, fail, wrap, rateLimit, getSetting, setSetting, requireInstanceAdmin, newId, DATA_DIR, ROOT: path.join(__dirname, '..'), stepUp, auditLog });
const TURN_STEP = 6 * 3600; // seconds
function iceServersFor(uid) {
  const list = [iceServers[0]];
  const urls = turnUrls();
  const relays = [...(urls.length ? [{ id: 'main', region: 'Main server', urls }] : []), ...REG.liveRelays().map((r) => ({ id: r.id, region: r.name, urls: r.urls }))];
  if (relays.length && turnSecret()) {
    // Relay logins run out 12 to 18 hours from now, at a 6-hour boundary, so a person has at most three logins
    // alive at once. (The relay's per-login limits then work per person, not per request.) expiresAt tells the
    // app when to fetch new ones (GET /api/ice): an app left open for days keeps working calls.
    const exp = (Math.floor(Date.now() / 1000 / TURN_STEP) + 3) * TURN_STEP;
    const username = `${exp}:${uid}`;
    const credential = crypto.createHmac('sha1', turnSecret()).update(username).digest('base64');
    for (const r of relays) list.push({ urls: r.urls, username, credential, region: r.region, regionId: r.id, expiresAt: exp * 1000 });
  } else if (urls.length && process.env.TURN_USERNAME) {
    list.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL || '' });
  }
  return list;
}
api.get('/ice', auth, (req, res) => {
  rateLimit('ice:' + req.userId, 60, 3600000);
  res.json(iceServersFor(req.userId));
});

// A call's region, like Discord's: pick which relay everyone in a voice channel or DM call goes through, and
// everyone in the call switches together. "auto" (null) = direct when possible, otherwise the nearest relays.
// Who can change it: in a server, people with Manage Channels; in a group chat or DM call, anyone in it.
api.post('/calls/region', auth, (req, res) => {
  rateLimit('callregion:' + req.userId, 20, 60000);
  const b = req.body || {};
  const room = String(b.room || '');
  const want = b.region === null || b.region === 'auto' || b.region === undefined ? null : String(b.region);
  if (want !== null) {
    const known = want === 'main' ? turnUrls().length > 0 : !!db.prepare('SELECT 1 FROM regions WHERE id = ?').get(want);
    if (!known) fail(400, 'No such region.');
  }
  const me = req.userId;
  const tell = (ids, extra = {}) => {
    const out = { room, region: want, by: me, ...extra };
    io.to(`voice:${room}`).emit('call:region', out);
    ids.forEach((id) => io.to(`user:${id}`).emit('call:region', out));
  };
  if (room.startsWith('dm:')) {
    const d = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(room.slice(3));
    if (!d || (d.user_a !== me && d.user_b !== me)) fail(404, 'No such call.');
    db.prepare('UPDATE dm_channels SET rtc_region = ? WHERE id = ?').run(want, d.id);
    tell([d.user_a, d.user_b]);
    return res.json({ room, region: want });
  }
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(room);
  const srv = c && db.prepare('SELECT * FROM servers WHERE id = ?').get(c.server_id);
  if (!c || !srv || c.type !== 'voice' || !isMember(srv.id, me) || !(perms.channel(srv, c, me) & PM.VIEW_CHANNEL)) fail(404, 'No such call.');
  if (srv.kind !== 'group' && !canIn(srv, c, me, PM.MANAGE_CHANNELS)) fail(403, 'You need the Manage Channels permission to change this channel’s region.');
  db.prepare('UPDATE channels SET rtc_region = ? WHERE id = ?').run(want, c.id);
  emitServer(srv.id);
  tell([]);
  res.json({ room, region: want });
});
api.get('/admin/turn', auth, (req, res) => {
  requireInstanceAdmin(req.userId);
  res.json({ urls: turnUrls(), secretSet: !!turnSecret(), source: getSetting('turnUrls') ? 'app' : process.env.TURN_URL ? 'env' : null });
});
// The relay secret signs every relay login (on every region too), and the relay addresses decide where everyone's
// calls are relayed: changing either needs the password again and is always logged.
api.put('/admin/turn', auth, wrap(async (req, res) => {
  requireInstanceAdmin(req.userId);
  await stepUp(req, req.body);
  const b = req.body || {};
  const before = turnUrls().join(',');
  if (b.urls !== undefined) setSetting('turnUrls', String(b.urls || '').split(/[\s,]+/).filter((u) => /^turns?:/.test(u)).slice(0, 12).join(',') || null);
  if (b.secret !== undefined) setSetting('turnSecret', String(b.secret || '').trim().slice(0, 200) || null);
  const changed = [turnUrls().join(',') !== before ? `relays: ${turnUrls().join(', ') || 'none'}` : '', b.secret !== undefined ? 'secret changed' : ''].filter(Boolean).join('; ');
  auditLog(req, 'turn_settings', null, changed || 'saved, no change');
  res.json({ ok: true, urls: turnUrls(), secretSet: !!turnSecret() });
}));

// ---------------------------------------------------------------- captcha (self-hosted proof of work)
// The browser must find a number that, hashed together with a random challenge, starts with N zero bits.
// That takes a person's browser well under a second, but makes every bot attempt cost real computing time.
// Challenges are signed (can't be forged or made easier), single-use, and expire after 5 minutes.
// Networks that keep failing logins get harder puzzles automatically, and so does everyone while the instance is
// unusually busy (see busyBits). No third parties, no tracking.
const CAPTCHA_BASE = 18;
const CAPTCHA_MAX = 24;
const captchaFails = new Map(); // network (netOf) -> { n, at }
const usedCaptchas = new Map(); // salt -> expires
setInterval(() => {
  const t = Date.now();
  for (const [k, exp] of usedCaptchas) if (exp < t) usedCaptchas.delete(k);
  for (const [k, f] of captchaFails) if (t - f.at > 3600000) captchaFails.delete(k);
}, 60000).unref();
const captchaMode = (purpose) => getSetting(purpose === 'register' ? 'captchaRegister' : 'captchaLogin') || 'on';
// The instance-wide limits on sign-ups and sign-ins. Past one, the robot check gets harder for everyone (one more
// bit, so twice the work, for every half a limit over, up to CAPTCHA_MAX) instead of turning everyone away: a
// flood then costs its sender more and more computing time, while a real person still gets in after one slower
// check. With the check switched off there's nothing to make harder, so the limit turns requests away instead.
const INSTANCE_LIMITS = { register: { key: 'reg:all', max: 120, windowMs: 60 * 60 * 1000 }, login: { key: 'login:all', max: 3000, windowMs: 10 * 60 * 1000 } };
function busyBits(purpose) {
  const l = INSTANCE_LIMITS[purpose];
  const n = hitsSoFar(l.key);
  return n < l.max ? 0 : 1 + Math.floor((n - l.max) / (l.max / 2));
}
function countInstanceWide(purpose) {
  const l = INSTANCE_LIMITS[purpose];
  if (captchaMode(purpose) === 'off') rateLimit(l.key, l.max, l.windowMs);
  else countHit(l.key, l.windowMs);
}
// How hard the check has to be for a request from this address right now. Failures are counted per network
// (an IPv6 /64), so hopping between addresses in one doesn't make it easy again.
function captchaDifficulty(ip, purpose) {
  const f = captchaFails.get(netOf(cleanIp(ip)));
  const n = f && Date.now() - f.at < 3600000 ? f.n : 0;
  return Math.min(CAPTCHA_MAX, CAPTCHA_BASE + Math.floor(n / 3) + busyBits(purpose));
}
function noteAuthFailure(ip) {
  const k = netOf(cleanIp(ip));
  const f = captchaFails.get(k) || { n: 0, at: 0 };
  f.n++; f.at = Date.now();
  captchaFails.set(k, f);
}
const captchaSig = (salt, d, exp, purpose) => crypto.createHmac('sha256', atRestKey).update(`captcha|${salt}|${d}|${exp}|${purpose}`).digest('hex');
api.get('/captcha', (req, res) => {
  limitNet(req, 'captcha', 60, 10 * 60 * 1000);
  const purpose = req.query.purpose === 'register' ? 'register' : 'login';
  if (captchaMode(purpose) === 'off') return res.json({ required: false });
  const salt = crypto.randomBytes(16).toString('hex');
  const difficulty = captchaDifficulty(req.ip, purpose);
  const expires = now() + 5 * 60 * 1000;
  res.json({ required: true, salt, difficulty, expires, purpose, sig: captchaSig(salt, difficulty, expires, purpose) });
});
function zeroBits(buf) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}
// Checks a solved robot check. It has to be at least as hard as one handed out to this address right now:
// puzzles aren't tied to an address, so otherwise easy ones could be fetched elsewhere, or before a rush.
function verifyCaptcha(c, purpose, ip) {
  if (captchaMode(purpose) === 'off') return;
  const bad = (msg) => fail(400, msg, 'captcha');
  if (!c || typeof c !== 'object') bad('Please complete the \u201cI\u2019m not a robot\u201d check.');
  const { salt, difficulty, expires, sig, nonce } = c;
  if (!/^[0-9a-f]{32}$/.test(String(salt)) || !Number.isInteger(difficulty) || difficulty < CAPTCHA_BASE || difficulty > CAPTCHA_MAX
    || !Number.isInteger(nonce) || nonce < 0 || typeof sig !== 'string' || sig.length !== 64) bad('The robot check didn\u2019t work. Please try again.');
  if (!safeEqual(sig, captchaSig(salt, difficulty, expires, purpose))) bad('The robot check didn\u2019t work. Please try again.');
  if (+expires < now()) bad('The robot check expired. Please try again.');
  if (usedCaptchas.has(salt)) bad('That robot check was already used. Please try again.');
  // The app solves a new, harder one by itself when it sees this code.
  if (difficulty < captchaDifficulty(ip, purpose)) fail(400, 'The robot check needs to be a little harder right now. Please try again.', 'captcha_harder');
  if (zeroBits(crypto.createHash('sha256').update(`${salt}:${nonce}`).digest()) < difficulty) { secEvent('captcha_failed', '', purpose); bad('The robot check didn\u2019t work. Please try again.'); }
  usedCaptchas.set(salt, +expires);
}

// ---------------------------------------------------------------- registration mode, Terms of Service
// Registration can be switched from the admin page: open, closed, or invite-code only (overrides .env).
const regMode = () => getSetting('regMode') || (!REGISTRATION_OPEN ? 'closed' : REGISTRATION_CODE ? 'code' : 'open');
const regCode = () => getSetting('regCode') || REGISTRATION_CODE;
const DEFAULT_TERMS = `# Terms of Service

_Last updated: {{date}}. The administrators of this server should review and adapt these terms._

## Using this server
- You must be old enough to use online services where you live (at least 13).
- Don't use this server for anything illegal, including sharing content that sexualizes minors, which is reported to authorities.
- No harassment, threats, hate speech, doxxing, spam, scams, malware, or impersonation.
- Respect other people's privacy and intellectual property.
- Server owners and moderators may set extra rules for their own servers.

## Privacy and encryption
- Messages and files are end-to-end encrypted: the server stores them in a form it cannot read.
- The server does store account details, who is in which server, when messages are sent (not what they say), and the **IP addresses** your devices connect from, for security and abuse prevention.
- **Reports:** if someone reports a message, the messages they choose to include are shared with the administrators, along with account details and IP addresses of the reported account.
- Messages sent to the **Support** account are read by this server's support team.

## Enforcement
Administrators may remove content, suspend or delete accounts that break these terms, and cooperate with lawful requests from authorities.

## No warranty
This service is provided as-is, without guarantees of availability. Keep your own copies of anything important.`;
function termsInfo() {
  const text = getSetting('tos');
  const version = +(getSetting('tosVersion') || 0);
  return { text: text || DEFAULT_TERMS.replace('{{date}}', new Date().toISOString().slice(0, 10)), version: text ? version : 1, custom: !!text };
}
api.get('/terms', (req, res) => { const t = termsInfo(); res.json({ text: t.text, version: t.version }); });
api.post('/terms/accept', auth, (req, res) => {
  db.prepare('UPDATE users SET tos_version = ? WHERE id = ?').run(termsInfo().version || null, req.userId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- moderation helpers
// Same rule as req.ip (TRUST_PROXY), so a live connection can't claim an address that HTTP wouldn't accept.
function socketIp(socket) {
  const remote = socket.handshake.address || (socket.request && socket.request.socket.remoteAddress);
  return cleanIp(clientIp(remote, socket.handshake.headers['x-forwarded-for'], app.get('trust proxy fn')));
}
// The audit log: staff actions and security events on accounts (password changes and resets, two-factor,
// sessions, deletions). Append-only — the database refuses to edit or delete entries (see db.js). Each entry's
// hash covers the previous one and is keyed with a secret from data/secret.key, and the newest entry is anchored
// in a file outside the database, so editing the database by hand, or cutting entries off the end, shows up.
// `req` may be null for things the server does by itself; actorId then says whose account it was.
function auditLog(req, action, target, detail = '', actorId = undefined) {
  auditAppend({ admin_id: actorId !== undefined ? actorId : (req && req.userId) || null, action, target: target || null, detail: String(detail), ip: req ? cleanIp(req.ip) : null });
}
const adminLog = auditLog;
// Walks the whole chain (see auditVerify in db.js): { ok, entries, brokenAt, reason, gaps, … }.
const verifyAuditChain = () => auditVerify();
function suspendUser(uid, reason, hours = 0) {
  const until = hours > 0 ? now() + hours * 3600000 : null;
  db.prepare('UPDATE users SET suspended_at = ?, suspend_reason = ?, suspended_until = ? WHERE id = ?').run(now(), String(reason || '').slice(0, 300), until, uid);
  revokeSessions(uid, { reason: 'suspended' });
  io.in(`user:${uid}`).disconnectSockets(true);
}
const ipsOf = (uid) => db.prepare('SELECT ip, first_seen AS firstSeen, last_seen AS lastSeen FROM user_ips WHERE user_id = ? ORDER BY last_seen DESC LIMIT 20').all(uid);
// Placeholder until the Support account exists (phase 2): every new account will get it as a friend.
function addSupportFriend() {}

// ---------------------------------------------------------------- reports
// Messages are end-to-end encrypted, so the server can't see what was said. When someone reports, their
// app includes the messages they choose (already decrypted on their device). The server checks those
// messages really exist in a conversation the reporter is part of, and who sent them and when.
const REPORT_CATEGORIES = ['spam', 'harassment', 'hate', 'threats', 'sexual', 'child_safety', 'self_harm', 'illegal', 'impersonation', 'scam', 'other'];
api.post('/reports', auth, (req, res) => {
  rateLimit('report:' + req.userId, 10, 60 * 60 * 1000);
  const b = req.body || {};
  const category = REPORT_CATEGORIES.includes(b.category) ? b.category : 'other';
  const ctx = b.context || {};
  let targetId = String(b.targetId || '');
  const context = { kind: ctx.kind === 'message' ? 'message' : 'user' };
  const evidence = [];
  if (context.kind === 'message') {
    const id = String(ctx.messageId || '');
    const cm = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    const dm = !cm && db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(id);
    if (!cm && !dm) fail(404, 'That message no longer exists.');
    let inConvo;
    if (cm) {
      const c = requireChannel(cm.channel_id, req.userId);
      const srv = serverOf(c);
      Object.assign(context, { messageId: id, channelId: c.id, channelName: c.name, serverId: srv.id, serverName: srv.kind === 'group' ? 'Group DM' : srv.name });
      inConvo = (mid) => db.prepare('SELECT author_id, created_at FROM messages WHERE id = ? AND channel_id = ?').get(mid, c.id);
      targetId = cm.author_id;
    } else {
      const d = requireDm(dm.dm_id, req.userId);
      Object.assign(context, { messageId: id, dmId: d.id });
      inConvo = (mid) => db.prepare('SELECT author_id, created_at FROM dm_messages WHERE id = ? AND dm_id = ?').get(mid, d.id);
      targetId = dm.author_id;
    }
    for (const e of (Array.isArray(b.evidence) ? b.evidence : []).slice(0, 25)) {
      const row = inConvo(String(e.id || ''));
      if (!row) continue;
      evidence.push({ id: e.id, authorId: row.author_id, createdAt: row.created_at, text: String(e.text || '').slice(0, 4000), files: (Array.isArray(e.files) ? e.files : []).slice(0, 10).map((f) => String(f).slice(0, 200)), reported: e.id === id });
    }
    if (!evidence.some((e) => e.reported)) fail(400, 'Include the reported message.');
  }
  if (!getUserRow(targetId) || targetId === req.userId) fail(400, 'You can\u2019t report that account.');
  const target = getUserRow(targetId);
  const ips = [...new Set([target.last_ip, ...ipsOf(targetId).map((x) => x.ip)].filter(Boolean))].slice(0, 20);
  const id = newId();
  db.prepare(`INSERT INTO reports (id, reporter_id, target_id, category, details, context, evidence, target_ips, reporter_ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.userId, targetId, category, String(b.details || '').slice(0, 2000), JSON.stringify(context), JSON.stringify(evidence), JSON.stringify(ips), cleanIp(req.ip), now());
  io.to('admins').emit('admin:report', { id, category });
  res.json({ ok: true, id });
});

// ---------------------------------------------------------------- admin API (instance administrators only)
// adminOnly: admins and the owner. staffOnly: moderators too. ownerOnly: just the owner.
const adminOnly = (req, res, next) => { try { requireInstanceAdmin(req.userId); next(); } catch (e) { next(e); } };
const staffOnly = (req, res, next) => (isStaff(req.userId) ? next() : next(new HttpError(403, 'Only staff can see this.')));
const ownerOnly = (req, res, next) => (staffRole(req.userId) === 'owner' ? next() : next(new HttpError(403, 'Only the owner can do that.')));
// Staff can only act on people ranked below them (the owner on everyone else).
function requireOutranks(req, targetId) {
  const r = getUserRow(targetId);
  if (!r) fail(404, 'User not found.');
  if (targetId === req.userId) fail(400, 'You can\u2019t do that to your own account.');
  if (staffRank(req.userId) <= staffRank(targetId)) fail(403, `You can\u2019t do that to ${staffRole(targetId) === 'owner' ? 'the owner' : 'staff at your level or above'}.`);
  return r;
}
const brief = (uid) => { const r = uid && getUserRow(uid); return r ? { id: r.id, username: r.username, displayName: parseProfile(r).displayName || r.username, avatar: r.avatar, suspended: !!r.suspended_at, role: staffRole(r.id) } : null; };
let diskCache = { at: 0, bytes: 0 };
function uploadsBytes() {
  if (Date.now() - diskCache.at < 5 * 60 * 1000) return diskCache.bytes;
  let bytes = 0;
  try { for (const f of fs.readdirSync(UPLOAD_DIR)) { try { bytes += fs.statSync(path.join(UPLOAD_DIR, f)).size; } catch { /* gone */ } } } catch { /* none */ }
  diskCache = { at: Date.now(), bytes };
  return bytes;
}
api.get('/admin/stats', auth, staffOnly, (req, res) => {
  const day = 86400000; const t = now();
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const from = new Date(new Date(t - i * day).toDateString()).getTime(); const to = from + day;
    series.push({
      day: new Date(from).toISOString().slice(0, 10),
      messages: count('SELECT COUNT(*) n FROM messages WHERE created_at >= ? AND created_at < ?', from, to) + count('SELECT COUNT(*) n FROM dm_messages WHERE created_at >= ? AND created_at < ?', from, to),
      signups: count('SELECT COUNT(*) n FROM users WHERE created_at >= ? AND created_at < ?', from, to),
      active: count('SELECT COUNT(*) n FROM users WHERE last_seen_at >= ? AND last_seen_at < ?', from, to),
    });
  }
  let dbBytes = 0;
  try { dbBytes = fs.statSync(path.join(DATA_DIR, 'hearth.db')).size + (fs.existsSync(path.join(DATA_DIR, 'hearth.db-wal')) ? fs.statSync(path.join(DATA_DIR, 'hearth.db-wal')).size : 0); } catch { /* ignore */ }
  res.json({
    users: count('SELECT COUNT(*) n FROM users'), online: onlineSockets.size,
    newUsers24h: count('SELECT COUNT(*) n FROM users WHERE created_at > ?', t - day), newUsers7d: count('SELECT COUNT(*) n FROM users WHERE created_at > ?', t - 7 * day),
    active24h: count('SELECT COUNT(*) n FROM users WHERE last_seen_at > ?', t - day), active7d: count('SELECT COUNT(*) n FROM users WHERE last_seen_at > ?', t - 7 * day),
    messages24h: series[series.length - 1].messages, servers: count("SELECT COUNT(*) n FROM servers WHERE kind = 'server'"), groups: count("SELECT COUNT(*) n FROM servers WHERE kind = 'group'"),
    suspended: count('SELECT COUNT(*) n FROM users WHERE suspended_at IS NOT NULL'), openReports: count("SELECT COUNT(*) n FROM reports WHERE status IN ('open','reviewing')"),
    inVoice: [...voiceChannels.values()].reduce((a, m) => a + m.size, 0),
    uploadsBytes: uploadsBytes(), dbBytes, uptime: Math.round(process.uptime()), version: require('../package.json').version, node: process.version,
    regMode: regMode(), series, health: health(),
  });
});
api.get('/admin/online', auth, staffOnly, async (req, res) => {
  const byUser = new Map();
  for (const sock of await io.fetchSockets()) {
    const e = byUser.get(sock.userId) || { user: brief(sock.userId), ips: new Set(), since: Infinity, devices: new Set(), connections: 0 };
    e.ips.add(sock.data.ip); e.since = Math.min(e.since, sock.data.since || Date.now()); e.devices.add(sock.data.ua || ''); e.connections++;
    byUser.set(sock.userId, e);
  }
  const voiceOf = new Map();
  for (const [cid, members] of voiceChannels) for (const [uid] of members) voiceOf.set(uid, cid);
  res.json([...byUser.entries()].map(([uid, e]) => {
    const vc = voiceOf.get(uid) && db.prepare('SELECT c.name, s.name AS sname, s.kind FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = ?').get(voiceOf.get(uid));
    return { ...e, ips: [...e.ips].filter(Boolean), devices: [...e.devices].filter(Boolean), voice: vc ? (vc.kind === 'group' ? 'Group call' : `${vc.name} \u00b7 ${vc.sname}`) : null, status: (getUserRow(uid) || {}).status };
  }).sort((a, b) => a.since - b.since));
});
api.get('/admin/users', auth, staffOnly, (req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const only = req.query.filter === 'suspended' ? 'AND suspended_at IS NOT NULL' : '';
  let rows = db.prepare(`SELECT id, username, created_at, last_seen_at, last_ip, suspended_at FROM users WHERE (lower(username) LIKE ? OR lower(profile) LIKE ? OR last_ip LIKE ?) ${only} ORDER BY created_at DESC LIMIT ${req.query.filter === 'staff' || req.query.filter === 'online' ? 2000 : 100}`).all(q, q, q);
  if (req.query.filter === 'staff') rows = rows.filter((r) => staffRole(r.id));
  if (req.query.filter === 'online') rows = rows.filter((r) => onlineSockets.has(r.id));
  res.json(rows.slice(0, 100)
    .map((r) => ({ ...brief(r.id), createdAt: r.created_at, lastSeen: r.last_seen_at, lastIp: r.last_ip, online: onlineSockets.has(r.id),
      reportsAgainst: db.prepare('SELECT COUNT(*) n FROM reports WHERE target_id = ?').get(r.id).n })));
});
api.get('/admin/users/:id', auth, staffOnly, (req, res) => {
  const r = getUserRow(req.params.id);
  if (!r) fail(404, 'User not found.');
  res.json({
    ...brief(r.id), createdAt: r.created_at, lastSeen: r.last_seen_at, lastIp: r.last_ip, suspendedAt: r.suspended_at, suspendReason: r.suspend_reason,
    online: onlineSockets.has(r.id), isAdmin: isInstanceAdmin(r.id), ips: ipsOf(r.id), suspendedUntil: r.suspended_until,
    canAct: r.id !== req.userId && staffRank(req.userId) > staffRank(r.id), myRole: staffRole(req.userId),
    storage: quotaOf(r.id), quotaOverride: r.upload_quota_mb, profileLocked: !!r.profile_locked, supporter: !!r.supporter,
    emailMasked: ACCT ? ACCT.mask(r.email) : '', totpEnabled: !!r.totp_enabled, hasRecovery: !!r.enc_private_key_recovery,
    commentsWritten: db.prepare('SELECT COUNT(*) n FROM profile_comments WHERE author_id = ?').get(r.id).n,
    notes: db.prepare('SELECT id, author_id, text, created_at FROM staff_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(r.id)
      .map((n) => ({ id: n.id, text: n.text, createdAt: n.created_at, author: brief(n.author_id), mine: n.author_id === req.userId })),
    sessions: db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC').all(r.id).filter((x) => sessionLive(x)).map((x) => ({ ua: x.ua, ip: x.ip, createdAt: x.created_at, lastSeen: x.last_used_at })),
    servers: db.prepare("SELECT s.name, s.owner_id = ? AS owner FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ? AND s.kind = 'server'").all(r.id, r.id),
    reportsAgainst: db.prepare('SELECT id, category, status, created_at AS createdAt FROM reports WHERE target_id = ? ORDER BY created_at DESC LIMIT 20').all(r.id),
    reportsBy: db.prepare('SELECT COUNT(*) n FROM reports WHERE reporter_id = ?').get(r.id).n,
  });
});
api.post('/admin/users/:id/suspend', auth, staffOnly, (req, res) => {
  const r = requireOutranks(req, req.params.id);
  const hours = Math.max(0, Math.min(24 * 365, Number((req.body || {}).hours) || 0)); // 0 = until unsuspended
  suspendUser(r.id, (req.body || {}).reason, hours);
  adminLog(req, 'suspend', r.id, `${hours ? `${hours} h` : 'until lifted'}${(req.body || {}).reason ? ` \u2014 ${req.body.reason}` : ''}`);
  res.json({ ok: true });
});
// Staff (admins and the owner) can change someone's username, e.g. an offensive or impersonating one.
api.post('/admin/users/:id/username', auth, staffOnly, (req, res) => {
  if (!isInstanceAdmin(req.userId)) fail(403, 'Only admins and the owner can change usernames.');
  const target = requireOutranks(req, req.params.id);
  const row = renameUser(target.id, (req.body || {}).username);
  if (row.username !== target.username) {
    adminLog(req, 'rename', row.id, `${target.username} \u2192 ${row.username}`);
    ACCT.notify(row, 'your username was changed by an admin', `An admin changed your username from ${target.username} to ${row.username}. Sign in with the new one from now on.`);
  }
  res.json({ ok: true, username: row.username });
});
api.post('/admin/users/:id/unsuspend', auth, staffOnly, (req, res) => {
  requireOutranks(req, req.params.id);
  db.prepare('UPDATE users SET suspended_at = NULL, suspend_reason = NULL, suspended_until = NULL WHERE id = ?').run(req.params.id);
  adminLog(req, 'unsuspend', req.params.id);
  res.json({ ok: true });
});
// Private notes about an account, shared between staff ("warned on 3 May about spam").
api.post('/admin/users/:id/notes', auth, staffOnly, (req, res) => {
  if (!getUserRow(req.params.id)) fail(404, 'User not found.');
  const text = String((req.body || {}).text || '').trim().slice(0, 1000);
  if (!text) fail(400, 'Write a note first.');
  db.prepare('INSERT INTO staff_notes (id, user_id, author_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(newId(), req.params.id, req.userId, text, now());
  adminLog(req, 'note_added', req.params.id);
  res.json({ ok: true });
});
api.delete('/admin/notes/:id', auth, staffOnly, (req, res) => {
  const n = db.prepare('SELECT * FROM staff_notes WHERE id = ?').get(req.params.id);
  if (!n) fail(404, 'Note not found.');
  if (n.author_id !== req.userId && !isInstanceAdmin(req.userId)) fail(403, 'Only the person who wrote it, or an admin, can delete a note.');
  db.prepare('DELETE FROM staff_notes WHERE id = ?').run(n.id);
  adminLog(req, 'note_deleted', n.user_id);
  res.json({ ok: true });
});
// Clear an offensive profile: pictures, song, name, bio, status and links go back to the defaults.
api.post('/admin/users/:id/reset-profile', auth, staffOnly, (req, res) => {
  const r = requireOutranks(req, req.params.id);
  db.prepare("UPDATE users SET avatar = NULL, banner = NULL, background = NULL, song = NULL, page_bg = NULL, page = NULL, profile = '{}' WHERE id = ?").run(r.id);
  [r.avatar, r.banner, r.background, r.song, r.page_bg].forEach((u) => removeUpload(u));
  broadcastUser(r.id);
  adminLog(req, 'profile_reset', r.id, r.username);
  res.json({ ok: true });
});
api.post('/admin/users/:id/logout', auth, staffOnly, (req, res) => {
  requireOutranks(req, req.params.id);
  revokeSessions(req.params.id, { reason: 'staff' });
  io.in(`user:${req.params.id}`).disconnectSockets(true);
  adminLog(req, 'sign_out_everywhere', req.params.id);
  res.json({ ok: true });
});
api.get('/admin/reports', auth, staffOnly, (req, res) => {
  const st = ['open', 'reviewing', 'resolved', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const rows = st === 'all' ? db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 200').all()
    : st === 'open' ? db.prepare("SELECT * FROM reports WHERE status IN ('open','reviewing') ORDER BY created_at DESC LIMIT 200").all()
      : db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(st);
  res.json(rows.map((r) => ({
    id: r.id, category: r.category, details: r.details, status: r.status, createdAt: r.created_at, resolution: r.resolution, handledAt: r.handled_at,
    reporter: brief(r.reporter_id), target: brief(r.target_id), handledBy: brief(r.handled_by), reporterIp: r.reporter_ip,
    targetIps: JSON.parse(r.target_ips || '[]'), context: JSON.parse(r.context || '{}'),
    evidence: JSON.parse(r.evidence || '[]').map((e) => ({ ...e, author: brief(e.authorId) })),
    priorReports: db.prepare('SELECT COUNT(*) n FROM reports WHERE target_id = ? AND id != ?').get(r.target_id, r.id).n,
  })));
});
// Staff can't close (or reopen) reports about themselves or about staff at their level or above: those are for
// someone ranked higher. The owner handles reports about the owner (nobody is above them).
function requireCanHandleReport(req, r) {
  if (staffRole(req.userId) === 'owner') return;
  if (r.target_id === req.userId) fail(403, 'This report is about you, so someone ranked above you handles it.');
  if (r.target_id && staffRank(r.target_id) >= staffRank(req.userId)) fail(403, `This report is about ${staffRole(r.target_id) === 'owner' ? 'the owner' : 'staff at your level or above'}, so someone ranked above them handles it.`);
}
api.patch('/admin/reports/:id', auth, staffOnly, (req, res) => {
  const b = req.body || {};
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r) fail(404, 'Report not found.');
  requireCanHandleReport(req, r);
  const status = ['open', 'reviewing', 'resolved', 'dismissed'].includes(b.status) ? b.status : r.status;
  db.prepare('UPDATE reports SET status = ?, resolution = ?, handled_by = ?, handled_at = ? WHERE id = ?').run(status, String(b.resolution ?? r.resolution).slice(0, 1000), req.userId, now(), r.id);
  adminLog(req, 'report_' + status, r.id, b.resolution || '');
  res.json({ ok: true });
});
// Whether a message is part of a report (the reported message or one of the messages included with it).
const inReport = (mid) => !!db.prepare(`SELECT 1 FROM reports r WHERE (CASE WHEN json_valid(r.context) THEN json_extract(r.context, '$.messageId') END) = ?
  OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(r.evidence) THEN r.evidence ELSE '[]' END) e WHERE json_extract(e.value, '$.id') = ?) LIMIT 1`).get(mid, mid);
// Remove a reported message for everyone. Like every other staff action on a person, only messages by people
// ranked below you (or your own) can be removed; that goes for the replies in its thread too, since they go with
// it. Direct messages and group chats are private, so staff can only remove ones that were reported.
api.delete('/admin/messages/:id', auth, staffOnly, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  const d = !m && db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
  if (!m && !d) fail(404, 'Message already gone.');
  const outranks = (author) => !author || author === req.userId || staffRank(author) < staffRank(req.userId);
  const author = (m || d).author_id;
  if (!outranks(author)) fail(403, `You can’t remove messages by ${staffRole(author) === 'owner' ? 'the owner' : 'staff at your level or above'}.`);
  const c = m && db.prepare('SELECT * FROM channels WHERE id = ?').get(m.channel_id);
  const group = !!c && !!db.prepare("SELECT 1 FROM servers WHERE id = ? AND kind = 'group'").get(c.server_id);
  if ((d || group) && !inReport((m || d).id)) fail(403, `${d ? 'Direct messages' : 'Group chat messages'} can only be removed when they were reported.`);
  if (m) {
    const above = db.prepare('SELECT DISTINCT author_id FROM messages WHERE thread_id = ?').all(m.id).map((x) => x.author_id).find((a) => !outranks(a));
    if (above) fail(403, `This thread has replies by ${staffRole(above) === 'owner' ? 'the owner' : 'staff at your level or above'}, so someone ranked above them has to remove it.`);
    deleteMessageTree(m.id);
    if (c) toChannel(c).emit('message:delete', { id: m.id, channelId: c.id, threadId: m.thread_id || null });
  } else {
    const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(d.dm_id);
    forgetMessages([d.id]);
    db.prepare('DELETE FROM dm_messages WHERE id = ?').run(d.id);
    if (dm) io.to([`user:${dm.user_a}`, `user:${dm.user_b}`]).emit('dm:delete', { id: d.id, dmId: dm.id });
  }
  adminLog(req, 'delete_message', req.params.id);
  res.json({ ok: true });
});
// Staff roles. Everyone on staff can see the team; only the owner can change it.
function staffList() {
  const claims = envClaims();
  const ids = new Set([ownerId(), ...Object.keys(staffRoles()), ...envAdmins().map((n) => claims[n])]);
  return [...ids].filter((id) => id && staffRole(id)).map((id) => ({ ...brief(id), role: staffRole(id), fromEnv: !!envAdminName(id) && staffRole(id) !== 'owner' }))
    .sort((x, y) => STAFF_RANK[y.role] - STAFF_RANK[x.role] || x.username.localeCompare(y.username));
}
function staffChanged(uid) {
  if (isStaff(uid)) io.in(`user:${uid}`).socketsJoin('admins'); else io.in(`user:${uid}`).socketsLeave('admins');
  broadcastUser(uid); // their app shows or hides the dashboard right away
}
api.get('/admin/staff', auth, staffOnly, (req, res) => res.json({ staff: staffList(), me: staffRole(req.userId) }));
// Give someone a role, change it, or take it away (role: 'admin' | 'moderator' | null).
// Needs the owner's password (and two-factor) again: a stolen session alone can't add itself to the team.
api.put('/admin/staff', auth, ownerOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const row = b.userId ? getUserRow(String(b.userId)) : db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(String(b.username || '').trim().replace(/^@/, '').toLowerCase());
  if (!row) fail(404, 'No account with that username.');
  if (row.id === ownerId()) fail(400, 'You\u2019re the owner. To step down, hand ownership to someone else first.');
  const role = b.role === 'admin' || b.role === 'moderator' ? b.role : null;
  if (!role && envAdminName(row.id)) fail(400, `${row.username} is an admin through ADMIN_USERS (as ${envAdminName(row.id)}) in the server's .env file. Remove the name there and restart to take it away.`);
  await stepUp(req, b);
  const roles = staffRoles();
  if (role) roles[row.id] = role; else delete roles[row.id];
  saveStaffRoles(roles);
  staffChanged(row.id);
  adminLog(req, role ? `role_${role}` : 'role_removed', row.id, row.username);
  res.json({ staff: staffList(), me: staffRole(req.userId) });
}));
// Hand the whole instance to someone else. They become owner; the old owner stays on as an admin.
// It can't be undone from the old owner's side, so it needs the password (and two-factor) again, and the old
// owner gets an email about it (if they have a confirmed one) in case it wasn't them.
api.post('/admin/owner', auth, ownerOnly, wrap(async (req, res) => {
  const row = getUserRow(String((req.body || {}).userId || ''));
  if (!row) fail(404, 'User not found.');
  if (row.id === req.userId) fail(400, 'You already own this server.');
  // A deleted account or a bot can never sign in, so it could never use (or hand back) ownership.
  if (row.deleted_at || row.is_bot) fail(400, 'That account can’t sign in, so it can’t own this server.');
  if (row.suspended_at) fail(400, 'Unsuspend them first.');
  const me = await stepUp(req, req.body);
  const roles = staffRoles();
  delete roles[row.id];
  roles[req.userId] = 'admin';
  saveStaffRoles(roles);
  setSetting('owner', row.id);
  setSetting('ownerAwaitsEnv', null); // handed over: no ADMIN_USERS sign-up takes it later
  staffChanged(row.id); staffChanged(req.userId);
  adminLog(req, 'ownership_transferred', row.id, `${me.username} \u2192 ${row.username}`);
  secEvent('ownership_transferred', req.ip, `${me.username} -> ${row.username}`);
  ACCT.notify(me, 'you handed over ownership', `${me.username} handed ownership of ${brand().name} to ${row.username} (from ${cleanIp(req.ip)}). You're now an admin, and only ${row.username} can give ownership back.`);
  ACCT.notify(row, 'you now own this Hearth', `${me.username} made ${row.username} the owner of ${brand().name}.`);
  res.json({ ok: true });
}));
// IP bans
api.get('/admin/ip-bans', auth, adminOnly, (req, res) => res.json(ipBans()));
// Whether a ban entry ("203.0.113.7" or "203.0.113.0/24") covers an address (same rules as ipBanned).
function banCovers(entry, ip) {
  ip = cleanIp(ip);
  const [base, bits] = String(entry).split('/');
  if (bits === undefined) return base.toLowerCase() === ip.toLowerCase();
  const a = ip4num(ip); const n = ip4num(base); const k = +bits;
  if (a === null || n === null || !(k >= 0 && k <= 32)) return false;
  const mask = k === 0 ? 0 : (~0 << (32 - k)) >>> 0;
  return ((a & mask) >>> 0) === ((n & mask) >>> 0);
}
api.post('/admin/ip-bans', auth, adminOnly, (req, res) => {
  const ip = String((req.body || {}).ip || '').trim();
  if (!/^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-f:]{3,39})$/i.test(ip)) fail(400, 'Enter an IP address like 203.0.113.7 or a range like 203.0.113.0/24.');
  if (ipBanned(req.ip) || banCovers(ip, req.ip)) fail(400, 'That would block your own connection.');
  // Like every other staff action: no banning the networks the owner, or staff at your level or above, use.
  const mine = staffRank(req.userId);
  for (const s of staffList().filter((x) => x.id !== req.userId && STAFF_RANK[x.role] >= mine)) {
    const row = getUserRow(s.id);
    const seen = [row && row.last_ip, ...ipsOf(s.id).map((x) => x.ip)].filter(Boolean);
    if (seen.some((a) => banCovers(ip, a))) fail(403, `That would block ${s.role === 'owner' ? 'the owner' : 'staff at your level or above'} (${s.username}).`);
  }
  const list = ipBans().filter((b) => b.ip !== ip);
  list.unshift({ ip, reason: String((req.body || {}).reason || '').slice(0, 200), by: req.userId, at: now() });
  setSetting('ipBans', JSON.stringify(list.slice(0, 1000)));
  // Disconnect anyone currently connected from there (except admins).
  io.fetchSockets().then((socks) => socks.forEach((x) => { if (ipBanned(x.data.ip) && !isStaff(x.userId)) x.disconnect(true); })).catch(() => {});
  adminLog(req, 'ip_banned', ip, (req.body || {}).reason || '');
  res.json({ ok: true });
});
api.delete('/admin/ip-bans', auth, adminOnly, (req, res) => {
  const ip = String((req.body || {}).ip || '');
  setSetting('ipBans', JSON.stringify(ipBans().filter((b) => b.ip !== ip)));
  adminLog(req, 'ip_unbanned', ip);
  res.json({ ok: true });
});
// Servers on this instance
api.get('/admin/servers', auth, adminOnly, (req, res) => {
  res.json(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) AS members,
      (SELECT COUNT(*) FROM messages x JOIN channels c ON c.id = x.channel_id WHERE c.server_id = s.id) AS messages,
      (SELECT MAX(x.created_at) FROM messages x JOIN channels c ON c.id = x.channel_id WHERE c.server_id = s.id) AS lastActive
    FROM servers s WHERE s.kind = 'server' ORDER BY members DESC LIMIT 500`).all()
    .map((x) => ({ id: x.id, name: x.name, icon: x.icon, owner: brief(x.owner_id), members: x.members, messages: x.messages, createdAt: x.created_at, lastActive: x.lastActive })));
});
// Staff can only act on servers whose owner ranks below them (or their own servers).
function requireOutranksServerOwner(req, srv) {
  if (srv.owner_id !== req.userId && staffRank(srv.owner_id) >= staffRank(req.userId)) {
    fail(403, `This server belongs to ${staffRole(srv.owner_id) === 'owner' ? 'the owner' : 'staff at your level or above'}.`);
  }
}
// Group chats are private conversations, not servers: they can't be deleted from here.
api.delete('/admin/servers/:id', auth, adminOnly, (req, res) => {
  const srv = db.prepare("SELECT * FROM servers WHERE id = ? AND kind = 'server'").get(req.params.id);
  if (!srv) fail(404, 'Server not found.');
  requireOutranksServerOwner(req, srv);
  const memberIds = db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(srv.id).map((r) => r.user_id);
  purgeServerContent(srv);
  MEMB.onServerDeleted(srv.id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(srv.id);
  memberIds.forEach((u) => io.to(`user:${u}`).emit('server:remove', { serverId: srv.id }));
  io.in(`server:${srv.id}`).socketsLeave(`server:${srv.id}`);
  adminLog(req, 'server_deleted', srv.id, srv.name);
  res.json({ ok: true });
});
// Give a server to another of its members (e.g. its owner left or went quiet).
api.post('/admin/servers/:id/transfer', auth, adminOnly, (req, res) => {
  const srv = db.prepare("SELECT * FROM servers WHERE id = ? AND kind = 'server'").get(req.params.id);
  if (!srv) fail(404, 'Server not found.');
  requireOutranksServerOwner(req, srv);
  const row = db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(String((req.body || {}).username || '').trim().replace(/^@/, '').toLowerCase());
  if (!row) fail(404, 'No account with that username.');
  if (!isMember(srv.id, row.id)) fail(400, `${row.username} isn\u2019t a member of ${srv.name}.`);
  db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(row.id, srv.id);
  emitServer(srv.id);
  adminLog(req, 'server_transferred', srv.id, `${srv.name} \u2192 ${row.username}`);
  res.json({ ok: true });
});
// Emergency: sign every account out of every device (for example after a leaked password list). Staff stay signed in.
api.post('/admin/sign-out-all', auth, adminOnly, (req, res) => {
  const victims = db.prepare('SELECT DISTINCT user_id FROM sessions WHERE revoked_at IS NULL').all().map((r) => r.user_id).filter((id) => !isStaff(id));
  db.transaction(() => victims.forEach((id) => revokeSessions(id, { reason: 'staff' })))();
  victims.forEach((id) => io.in(`user:${id}`).disconnectSockets(true));
  adminLog(req, 'sign_out_all', null, `${victims.length} accounts`);
  res.json({ ok: true, count: victims.length });
});
// Announcement banner for everyone
api.put('/admin/announcement', auth, adminOnly, (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  const level = ['info', 'warning', 'success'].includes((req.body || {}).level) ? req.body.level : 'info';
  const a = text ? { id: newId(), text, level, at: now() } : null;
  setSetting('announcement', a ? JSON.stringify(a) : null);
  io.emit('config:update', { announcement: a });
  adminLog(req, a ? 'announcement' : 'announcement_cleared', null, text);
  res.json({ ok: true, announcement: a });
});
// Maintenance mode: only admins can use the app until it's turned off.
api.put('/admin/maintenance', auth, adminOnly, (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 300);
  setSetting('maintenance', text || null);
  if (text) io.fetchSockets().then((socks) => socks.forEach((x) => { if (!isStaff(x.userId)) { x.emit('server:maintenance', { text }); x.disconnect(true); } })).catch(() => {});
  adminLog(req, text ? 'maintenance_on' : 'maintenance_off', null, text);
  res.json({ ok: true, maintenance: text || null });
});
api.get('/admin/security', auth, adminOnly, (req, res) => {
  const byIp = {};
  securityLog.filter((e) => e.type === 'failed_login' && Date.now() - e.at < 3600000).forEach((e) => { byIp[e.ip] = (byIp[e.ip] || 0) + 1; });
  res.json({ events: securityLog.slice(0, 200), topFailedIps: Object.entries(byIp).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ip, n]) => ({ ip, n })) });
});

api.get('/admin/log', auth, staffOnly, (req, res) => {
  const before = Math.floor(+req.query.before) || Number.MAX_SAFE_INTEGER;
  res.json(db.prepare('SELECT * FROM admin_log WHERE id < ? ORDER BY id DESC LIMIT 200').all(before)
    .map((r) => ({ ...r, admin: brief(r.admin_id), targetUser: r.target && getUserRow(r.target) ? brief(r.target) : null })));
});
api.get('/admin/log/verify', auth, staffOnly, (req, res) => res.json(verifyAuditChain()));
api.get('/admin/registration', auth, adminOnly, (req, res) => res.json({ mode: regMode(), code: regCode(), captchaLogin: captchaMode('login'), captchaRegister: captchaMode('register') }));
api.put('/admin/registration', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  if (['open', 'closed', 'code'].includes(b.mode)) setSetting('regMode', b.mode);
  if (b.code !== undefined) setSetting('regCode', String(b.code || '').trim().slice(0, 64) || null);
  if (['on', 'off'].includes(b.captchaLogin)) setSetting('captchaLogin', b.captchaLogin);
  if (['on', 'off'].includes(b.captchaRegister)) setSetting('captchaRegister', b.captchaRegister);
  adminLog(req, 'registration', null, `${regMode()}`);
  res.json({ mode: regMode(), code: regCode(), captchaLogin: captchaMode('login'), captchaRegister: captchaMode('register') });
});
api.put('/admin/terms', auth, adminOnly, (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 50000);
  if (text) { setSetting('tos', text); setSetting('tosVersion', String(now())); } else { setSetting('tos', null); setSetting('tosVersion', null); }
  adminLog(req, 'terms_updated', null, text ? `${text.length} chars` : 'reset to default');
  io.emit('config:update', { termsVersion: termsInfo().version || 0 });
  res.json({ ok: true, version: termsInfo().version });
});

// ---------------------------------------------------------------- profile pages (MySpace style)
const pageViews = new Map(); // "viewer:owner" -> last counted, so reloading doesn't inflate the counter
setInterval(() => { const t = now() - 3600000; for (const [k, v] of pageViews) if (v < t) pageViews.delete(k); }, 600000).unref();
function canCommentOn(viewerId, row, page) {
  if (!features().comments) return false;
  if (viewerId === row.id) return true;
  if (page.comments === 'off' || isBlocked(viewerId, row.id)) return false;
  return page.comments === 'everyone' ? true : areFriends(viewerId, row.id);
}
const commentOut = (c) => ({ id: c.id, text: c.text, createdAt: c.created_at, author: publicUser(getUserRow(c.author_id)) });
// "Last seen", as the app shows it: the day only. Nothing at all while the person is invisible, or when
// either of you has blocked the other: the exact time would tell a watcher when they're using Hearth.
const DAY_MS = 86400000;
function lastSeenFor(viewerId, row, blocked = row && viewerId !== row.id && isBlocked(viewerId, row.id)) {
  if (!row || !row.last_seen_at || row.status === 'invisible' || row.is_bot || blocked) return null;
  return Math.floor(row.last_seen_at / DAY_MS) * DAY_MS + DAY_MS / 2; // noon UTC: the same date almost everywhere
}
api.get('/users/:id/page', auth, (req, res) => {
  const row = getUserRow(req.params.id);
  if (!row) fail(404, 'User not found.');
  let views = row.page_views || 0;
  const key = `${req.userId}:${row.id}`;
  if (row.id !== req.userId && !pageViews.has(key)) {
    pageViews.set(key, now());
    db.prepare('UPDATE users SET page_views = page_views + 1 WHERE id = ?').run(row.id);
    views++;
  }
  const page = parsePage(row);
  const prof = parseProfile(row);
  const blocked = isBlocked(req.userId, row.id);
  res.json({
    page: features().customCss ? page : { ...page, css: '' }, pageBg: row.page_bg || null, views,
    friendCount: db.prepare("SELECT COUNT(*) n FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)").get(row.id, row.id).n,
    topFriends: blocked ? [] : prof.topFriends.map((id) => publicUser(getUserRow(id))).filter(Boolean),
    isFriend: areFriends(req.userId, row.id),
    lastSeen: lastSeenFor(req.userId, row, blocked),
    comments: blocked ? [] : db.prepare('SELECT * FROM profile_comments WHERE profile_id = ? ORDER BY created_at DESC LIMIT 100').all(row.id).map(commentOut),
    commentCount: db.prepare('SELECT COUNT(*) n FROM profile_comments WHERE profile_id = ?').get(row.id).n,
    canComment: canCommentOn(req.userId, row, page),
    locked: !!row.profile_locked,
  });
});
api.put('/me/page', auth, (req, res) => {
  requireUnlocked(req.userId);
  limitProfileWrites(req);
  const row = getUserRow(req.userId);
  const page = sanitizePage(req.body || {}, parsePage(row));
  checkWords(page.meet, page.details.map((d) => [d.label, d.value]), Object.values(page.interests));
  db.prepare('UPDATE users SET page = ? WHERE id = ?').run(JSON.stringify(page), req.userId);
  res.json({ page });
});
api.post('/users/:id/comments', auth, (req, res) => {
  const row = getUserRow(req.params.id);
  if (!row) fail(404, 'User not found.');
  if (!canCommentOn(req.userId, row, parsePage(row))) fail(403, 'You can\u2019t comment on this profile.');
  rateLimit('pcomment:' + req.userId, 8, 60 * 1000);
  const text = String((req.body || {}).text || '').trim().slice(0, 1000);
  if (!text) fail(400, 'Write something first.');
  checkWords(text);
  const c = { id: newId(), profile_id: row.id, author_id: req.userId, text, created_at: now() };
  db.prepare('INSERT INTO profile_comments (id, profile_id, author_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(c.id, c.profile_id, c.author_id, c.text, c.created_at);
  // Keep walls from growing forever: the newest 500 stay.
  db.prepare('DELETE FROM profile_comments WHERE profile_id = ? AND id NOT IN (SELECT id FROM profile_comments WHERE profile_id = ? ORDER BY created_at DESC LIMIT 500)').run(row.id, row.id);
  if (row.id !== req.userId) io.to(`user:${row.id}`).emit('profile:comment', { from: req.userId });
  res.json(commentOut(c));
});
// The writer, the profile's owner and staff can remove a comment.
api.delete('/profile-comments/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM profile_comments WHERE id = ?').get(req.params.id);
  if (!c) fail(404, 'That comment is already gone.');
  const mine = c.author_id === req.userId || c.profile_id === req.userId;
  if (!mine && !isStaff(req.userId)) fail(403, 'You can\u2019t delete that comment.');
  db.prepare('DELETE FROM profile_comments WHERE id = ?').run(c.id);
  if (!mine) adminLog(req, 'profile_comment_deleted', c.profile_id, c.text.slice(0, 200));
  res.json({ ok: true });
});
// ---------------------------------------------------------------- polls
// The question and options travel inside the encrypted message; the server only stores which option
// number each person picked, so it can count votes without knowing what they're about.
// act: voting or ending it, which a block stops in a DM like any other new interaction (reading it still works).
function pollTarget(messageId, userId, act = false) {
  const cm = db.prepare('SELECT id, channel_id FROM messages WHERE id = ?').get(messageId);
  if (cm) { const c = requireChannel(cm.channel_id, userId); return { emit: (ev, data) => toChannel(c).emit(ev, data) }; }
  const dm = db.prepare('SELECT id, dm_id FROM dm_messages WHERE id = ?').get(messageId);
  if (dm) {
    const d = requireDm(dm.dm_id, userId);
    if (act && isBlocked(d.user_a, d.user_b)) fail(403, 'You can\u2019t interact with this person.');
    return { emit: (ev, data) => io.to([`user:${d.user_a}`, `user:${d.user_b}`]).emit(ev, data) };
  }
  fail(404, 'That poll no longer exists.');
}
function pollState(messageId) {
  const votes = {};
  db.prepare('SELECT user_id, choice FROM poll_votes WHERE message_id = ? ORDER BY created_at').all(messageId).forEach((v) => { (votes[v.choice] ||= []).push(v.user_id); });
  return { messageId, votes, closed: !!db.prepare('SELECT 1 FROM poll_closed WHERE message_id = ?').get(messageId) };
}
api.get('/polls/:id', auth, (req, res) => { pollTarget(req.params.id, req.userId); res.json(pollState(req.params.id)); });
api.post('/polls/:id/vote', auth, (req, res) => {
  const t = pollTarget(req.params.id, req.userId, true);
  rateLimit('vote:' + req.userId, 60, 60000);
  if (db.prepare('SELECT 1 FROM poll_closed WHERE message_id = ?').get(req.params.id)) fail(400, 'This poll has ended.');
  const choices = [...new Set((Array.isArray((req.body || {}).choices) ? req.body.choices : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 10))].slice(0, 10);
  db.transaction(() => {
    db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(req.params.id, req.userId);
    choices.forEach((c) => db.prepare('INSERT INTO poll_votes (message_id, user_id, choice, created_at) VALUES (?, ?, ?, ?)').run(req.params.id, req.userId, c, now()));
  })();
  const st = pollState(req.params.id);
  t.emit('poll:update', st);
  res.json(st);
});
api.post('/polls/:id/close', auth, (req, res) => {
  const t = pollTarget(req.params.id, req.userId, true);
  const row = db.prepare('SELECT author_id FROM messages WHERE id = ? UNION SELECT author_id FROM dm_messages WHERE id = ?').get(req.params.id, req.params.id);
  if (!row || row.author_id !== req.userId) fail(403, 'Only the person who made the poll can end it.');
  db.prepare('INSERT OR IGNORE INTO poll_closed (message_id, closed_at) VALUES (?, ?)').run(req.params.id, now());
  const st = pollState(req.params.id);
  t.emit('poll:update', st);
  res.json(st);
});

// ---------------------------------------------------------------- server events (hangouts, game nights…)
// Not end-to-end encrypted (the server needs the time to send reminders) — the app says so.
// An event's channel, for this person: only a channel they can see (a private channel's id isn't for everyone).
function eventChannelFor(e, uid) {
  const c = e.channel_id && db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(e.channel_id, e.server_id);
  return c && isMember(c.server_id, uid) && (perms.channel(serverOf(c), c, uid) & PM.VIEW_CHANNEL) ? c.id : null;
}
const mayEditEvent = (e, srv, uid) => e.created_by === uid || can(srv, uid, PM.MANAGE_SERVER) || can(srv, uid, PM.MANAGE_CHANNELS);
const eventOut = (e, uid) => {
  // RSVPs of current members only (someone who left or was removed isn't coming).
  const rsvps = db.prepare('SELECT r.user_id, r.status FROM event_rsvps r JOIN members m ON m.server_id = ? AND m.user_id = r.user_id WHERE r.event_id = ?').all(e.server_id, e.id);
  const channelId = eventChannelFor(e, uid);
  // Someone who may edit it learns only that it links to a channel they can't see, so the editor can keep that
  // link instead of showing "no channel" and quietly dropping or replacing it on save.
  const channelHidden = !channelId && !!e.channel_id && !!db.prepare('SELECT 1 FROM channels WHERE id = ? AND server_id = ?').get(e.channel_id, e.server_id)
    && mayEditEvent(e, serverOf(e), uid);
  return { id: e.id, serverId: e.server_id, title: e.title, description: e.description, location: e.location, channelId, startsAt: e.starts_at, endsAt: e.ends_at, createdBy: e.created_by,
    ...(channelHidden ? { channelHidden: true } : {}),
    going: rsvps.filter((r) => r.status === 'going').map((r) => r.user_id), maybe: rsvps.filter((r) => r.status === 'maybe').map((r) => r.user_id), no: rsvps.filter((r) => r.status === 'no').map((r) => r.user_id),
    mine: (rsvps.find((r) => r.user_id === uid) || {}).status || null };
};
// uid: who's saving it (they can only link a channel they can see); keep: the channel it already links to.
function cleanEvent(b, srv, uid, keep = null) {
  const title = String(b.title || '').trim().slice(0, 100);
  if (!title) fail(400, 'Give the event a name.');
  const startsAt = Number(b.startsAt);
  if (!Number.isFinite(startsAt) || startsAt < now() - 3600000 || startsAt > now() + 400 * 86400000) fail(400, 'Pick a time in the next year.');
  const endsAt = b.endsAt ? Number(b.endsAt) : null;
  if (endsAt && (!Number.isFinite(endsAt) || endsAt <= startsAt)) fail(400, 'The end has to be after the start.');
  const want = b.channelId ? String(b.channelId) : null;
  const channelId = want && (want === keep || eventChannelFor({ channel_id: want, server_id: srv.id }, uid)) ? want : null;
  const out = { title, description: String(b.description || '').slice(0, 2000), location: String(b.location || '').slice(0, 120), startsAt, endsAt, channelId };
  checkWords(out.title, out.description, out.location);
  return out;
}
const emitEvents = (serverId) => io.to(`server:${serverId}`).emit('events:update', { serverId });
api.get('/servers/:id/events', auth, (req, res) => {
  const srv = requireServer(req.params.id, req.userId);
  res.json(db.prepare('SELECT * FROM server_events WHERE server_id = ? AND COALESCE(ends_at, starts_at + 3 * 3600000) > ? ORDER BY starts_at LIMIT 50').all(srv.id, now()).map((e) => eventOut(e, req.userId)));
});
// Everything coming up in all your servers (Home screen).
api.get('/events', auth, (req, res) => {
  res.json(db.prepare(`SELECT e.* FROM server_events e JOIN members m ON m.server_id = e.server_id WHERE m.user_id = ? AND COALESCE(e.ends_at, e.starts_at + 3 * 3600000) > ? AND e.starts_at < ? ORDER BY e.starts_at LIMIT 20`)
    .all(req.userId, now(), now() + 14 * 86400000).map((e) => eventOut(e, req.userId)));
});
// Events show up for everyone in the server, so posting one takes what posting a message does: someone muted
// everywhere can't post events instead. Admins always can.
function requireEventPoster(srv, uid) {
  if (can(srv, uid, PM.MANAGE_SERVER) || can(srv, uid, PM.MANAGE_CHANNELS)) return;
  const text = db.prepare("SELECT * FROM channels WHERE server_id = ? AND type = 'text'").all(srv.id);
  if (!text.some((c) => canIn(srv, c, uid, PM.VIEW_CHANNEL | PM.SEND_MESSAGES))) fail(403, 'You need permission to send messages here to post events.');
}
api.post('/servers/:id/events', auth, (req, res) => {
  const srv = requireServer(req.params.id, req.userId);
  if (srv.kind === 'group') fail(400, 'Events are for servers.');
  rateLimit('event:' + req.userId, 20, 3600000);
  requireEventPoster(srv, req.userId);
  const e = cleanEvent(req.body || {}, srv, req.userId);
  const id = newId();
  db.prepare('INSERT INTO server_events (id, server_id, title, description, location, channel_id, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, srv.id, e.title, e.description, e.location, e.channelId, e.startsAt, e.endsAt, req.userId, now());
  db.prepare("INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, 'going')").run(id, req.userId);
  emitEvents(srv.id);
  res.json(eventOut(db.prepare('SELECT * FROM server_events WHERE id = ?').get(id), req.userId));
});
function requireEventEditor(eventId, uid) {
  const e = db.prepare('SELECT * FROM server_events WHERE id = ?').get(eventId);
  if (!e) fail(404, 'That event no longer exists.');
  const srv = requireServer(e.server_id, uid);
  if (!mayEditEvent(e, srv, uid)) fail(403, 'Only the person who made it (or a server admin) can change this event.');
  return { e, srv };
}
api.patch('/events/:id', auth, (req, res) => {
  const { e, srv } = requireEventEditor(req.params.id, req.userId);
  requireEventPoster(srv, req.userId);
  const v = cleanEvent({ ...{ title: e.title, description: e.description, location: e.location, startsAt: e.starts_at, endsAt: e.ends_at, channelId: e.channel_id }, ...(req.body || {}) }, srv, req.userId, e.channel_id);
  db.prepare('UPDATE server_events SET title = ?, description = ?, location = ?, channel_id = ?, starts_at = ?, ends_at = ?, reminded = CASE WHEN starts_at = ? THEN reminded ELSE 0 END WHERE id = ?')
    .run(v.title, v.description, v.location, v.channelId, v.startsAt, v.endsAt, v.startsAt, e.id);
  emitEvents(srv.id);
  res.json(eventOut(db.prepare('SELECT * FROM server_events WHERE id = ?').get(e.id), req.userId));
});
api.delete('/events/:id', auth, (req, res) => {
  const { e, srv } = requireEventEditor(req.params.id, req.userId);
  db.prepare('DELETE FROM server_events WHERE id = ?').run(e.id);
  emitEvents(srv.id);
  res.json({ ok: true });
});
api.post('/events/:id/rsvp', auth, (req, res) => {
  const e = db.prepare('SELECT * FROM server_events WHERE id = ?').get(req.params.id);
  if (!e) fail(404, 'That event no longer exists.');
  requireServer(e.server_id, req.userId);
  const st = (req.body || {}).status;
  if (['going', 'maybe', 'no'].includes(st)) db.prepare('INSERT OR REPLACE INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, ?)').run(e.id, req.userId, st);
  else db.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?').run(e.id, req.userId);
  emitEvents(e.server_id);
  res.json(eventOut(e, req.userId));
});
// Reminders: 15 minutes before, everyone going (or maybe) gets a nudge — in the app and as a push notification.
setInterval(() => {
  const soon = db.prepare('SELECT * FROM server_events WHERE reminded = 0 AND starts_at <= ? AND starts_at > ?').all(now() + 15 * 60000, now() - 5 * 60000);
  for (const e of soon) {
    db.prepare('UPDATE server_events SET reminded = 1 WHERE id = ?').run(e.id);
    // Only people still in the server (an RSVP doesn't outlive membership).
    const who = db.prepare(`SELECT r.user_id FROM event_rsvps r JOIN members m ON m.server_id = ? AND m.user_id = r.user_id
      WHERE r.event_id = ? AND r.status IN ('going', 'maybe')`).all(e.server_id, e.id).map((r) => r.user_id);
    const srv = db.prepare('SELECT name FROM servers WHERE id = ?').get(e.server_id) || {};
    who.forEach((u) => io.to(`user:${u}`).emit('event:starting', { id: e.id, serverId: e.server_id, title: e.title, startsAt: e.starts_at, channelId: eventChannelFor(e, u) }));
    pushTo(who, { title: `Starting soon: ${e.title}`, body: srv.name || 'Event', tag: 'event:' + e.id, url: '/' });
  }
}, 60000).unref();

// People directory: everyone you share a server with, plus your friends, with what their profile shows.
api.get('/people', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const sort = ['online', 'new', 'views', 'name'].includes(req.query.sort) ? req.query.sort : 'online';
  const rows = db.prepare(`SELECT DISTINCT u.* FROM users u WHERE u.id != ? AND u.suspended_at IS NULL AND (
      u.id IN (SELECT y.user_id FROM members x JOIN members y ON x.server_id = y.server_id WHERE x.user_id = ?)
      OR u.id IN (SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)))
    LIMIT 2000`).all(req.userId, req.userId, req.userId, req.userId, req.userId);
  const blockedIds = new Set(db.prepare('SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id FROM blocks WHERE blocked_id = ?').all(req.userId, req.userId).map((b) => b.id));
  let list = rows.map((r) => ({ ...publicUser(r), views: r.page_views || 0, lastSeen: lastSeenFor(req.userId, r, blockedIds.has(r.id)) || 0 }))
    .filter((u) => !q || u.username.toLowerCase().includes(q) || (u.profile.displayName || '').toLowerCase().includes(q)
      || (u.profile.interests || []).some((t) => t.toLowerCase().includes(q)) || (u.profile.headline || '').toLowerCase().includes(q));
  const on = (u) => (u.presence && u.presence !== 'offline' ? 1 : 0);
  const cmp = { online: (a, b) => on(b) - on(a) || b.lastSeen - a.lastSeen, new: (a, b) => b.createdAt - a.createdAt, views: (a, b) => b.views - a.views, name: (a, b) => (a.profile.displayName || a.username).localeCompare(b.profile.displayName || b.username) }[sort];
  list.sort(cmp);
  res.json({ total: list.length, people: list.slice(0, 120) });
});

// Your own storage use (Settings → Account).
api.get('/me/storage', auth, (req, res) => {
  const q = quotaOf(req.userId);
  const byKind = db.prepare('SELECT kind, COUNT(*) files, COALESCE(SUM(size), 0) bytes FROM user_files WHERE user_id = ? GROUP BY kind').all(req.userId);
  res.json({ ...q, byKind });
});

// ---------------------------------------------------------------- admin: storage, limits, words, per-account switches
api.get('/admin/storage', auth, adminOnly, (req, res) => {
  let diskFree = null;
  try { const st = fs.statfsSync(UPLOAD_DIR); diskFree = st.bavail * st.bsize; } catch { /* older Node */ }
  const top = db.prepare('SELECT user_id, COUNT(*) files, SUM(size) bytes, MAX(created_at) last FROM user_files GROUP BY user_id ORDER BY bytes DESC LIMIT 50').all()
    .map((r) => ({ user: brief(r.user_id), files: r.files, bytes: r.bytes, last: r.last, quotaMb: quotaOf(r.user_id).quotaMb, blocked: !!(getUserRow(r.user_id) || {}).uploads_blocked }));
  const byKind = db.prepare('SELECT kind, COUNT(*) files, COALESCE(SUM(size), 0) bytes FROM user_files GROUP BY kind ORDER BY bytes DESC').all();
  const today = db.prepare('SELECT COALESCE(SUM(size), 0) n FROM user_files WHERE created_at > ?').get(now() - 86400000).n;
  const total = db.prepare('SELECT COALESCE(SUM(size), 0) n FROM user_files').get().n;
  res.json({ limits: uploadLimits(), total, today, diskFree, top, byKind, words: blockedWords() });
});
api.put('/admin/limits', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const cur = uploadLimits();
  const next = { ...cur };
  for (const k of Object.keys(LIMIT_DEFAULTS)) if (b[k] !== undefined && Number.isFinite(+b[k]) && +b[k] >= 0) next[k] = Math.round(+b[k]);
  setSetting('uploadLimits', JSON.stringify(next));
  adminLog(req, 'upload_limits', null, Object.entries(uploadLimits()).map(([k, v]) => `${k}=${v}`).join(' '));
  io.emit('config:update', { maxUploadMb: uploadLimits().fileMb, imageMb: uploadLimits().imageMb, songMb: uploadLimits().songMb });
  res.json(uploadLimits());
});
api.put('/admin/words', auth, adminOnly, (req, res) => {
  const list = [...new Set((Array.isArray((req.body || {}).words) ? req.body.words : String((req.body || {}).words || '').split(/[\n,]/))
    .map((w) => String(w).trim().toLowerCase().slice(0, 40)).filter((w) => w.length >= 2))].slice(0, 500);
  setSetting('blockedWords', JSON.stringify(list));
  adminLog(req, 'word_filter', null, `${list.length} words`);
  res.json({ words: list });
});
// Per-account switches: block uploads, lock profile, custom storage limit (null = the server default).
api.patch('/admin/users/:id/limits', auth, staffOnly, (req, res) => {
  const r = requireOutranks(req, req.params.id);
  const b = req.body || {};
  const changes = [];
  if (b.uploadsBlocked !== undefined) { db.prepare('UPDATE users SET uploads_blocked = ? WHERE id = ?').run(b.uploadsBlocked ? 1 : 0, r.id); changes.push(b.uploadsBlocked ? 'uploads_blocked' : 'uploads_allowed'); }
  if (b.supporter !== undefined) {
    if (!isInstanceAdmin(req.userId)) fail(403, 'Only admins can mark supporters.');
    db.prepare('UPDATE users SET supporter = ?, supporter_until = NULL WHERE id = ?').run(b.supporter ? 1 : 0, r.id); // marked by hand = no end date
    changes.push(b.supporter ? 'supporter_added' : 'supporter_removed'); broadcastUser(r.id);
  }
  if (b.profileLocked !== undefined) { db.prepare('UPDATE users SET profile_locked = ? WHERE id = ?').run(b.profileLocked ? 1 : 0, r.id); changes.push(b.profileLocked ? 'profile_locked' : 'profile_unlocked'); broadcastUser(r.id); }
  if (b.quotaMb !== undefined) {
    if (!isInstanceAdmin(req.userId)) fail(403, 'Only admins can change storage limits.');
    const v = b.quotaMb === null || b.quotaMb === '' ? null : Math.max(0, Math.min(1e6, Math.round(+b.quotaMb) || 0));
    db.prepare('UPDATE users SET upload_quota_mb = ? WHERE id = ?').run(v, r.id);
    changes.push(`quota=${v === null ? 'default' : v + 'MB'}`);
  }
  changes.forEach((c) => adminLog(req, c.startsWith('quota') ? 'storage_limit' : c, r.id, c));
  res.json({ ok: true });
});
// Remove everything someone uploaded (attachments included). For spam or abuse; can't be undone.
api.delete('/admin/users/:id/files', auth, adminOnly, (req, res) => {
  const r = requireOutranks(req, req.params.id);
  const files = db.prepare('SELECT name FROM user_files WHERE user_id = ?').all(r.id);
  files.forEach((f) => removeUpload('/uploads/' + f.name));
  // GIFs they put in the server's library (uploaded, or collected from what they sent).
  db.prepare('SELECT id, file FROM gif_library WHERE added_by = ?').all(r.id).forEach((g) => removeLibraryGif(g));
  db.prepare('UPDATE users SET avatar = NULL, banner = NULL, background = NULL, song = NULL, page_bg = NULL WHERE id = ?').run(r.id);
  db.prepare('DELETE FROM blobs WHERE uploader_id = ?').run(r.id);
  broadcastUser(r.id);
  adminLog(req, 'files_deleted', r.id, `${files.length} files`);
  res.json({ ok: true, count: files.length });
});
// Clear everyone's comments by one person (spam waves).
api.delete('/admin/users/:id/comments', auth, staffOnly, (req, res) => {
  const r = requireOutranks(req, req.params.id);
  const n = db.prepare('DELETE FROM profile_comments WHERE author_id = ?').run(r.id).changes;
  adminLog(req, 'comments_deleted', r.id, `${n} comments`);
  res.json({ ok: true, count: n });
});

// ---------------------------------------------------------------- owner tools
// Branding, feature switches, funding, backups and server health.
const brand = () => ({ name: (getSetting('brandName') || INSTANCE_NAME).slice(0, 40), tagline: (getSetting('brandTagline') || '').slice(0, 140) });
const FEATURE_DEFAULTS = { customCss: true, comments: true, watch: true, gifs: true, createServers: 'everyone' };
function features() {
  let v = {};
  try { v = JSON.parse(getSetting('features') || '{}') || {}; } catch { /* defaults */ }
  return { ...FEATURE_DEFAULTS, ...v };
}
function funding() {
  let v = {};
  try { v = JSON.parse(getSetting('funding') || '{}') || {}; } catch { /* none */ }
  return { enabled: !!v.enabled, url: typeof v.url === 'string' ? v.url : '', monthly: +v.monthly || 0, raised: +v.raised || 0, currency: typeof v.currency === 'string' ? v.currency.slice(0, 3) : 'USD', note: typeof v.note === 'string' ? v.note : '' };
}
// Payments through Ko-fi / Stripe (server/money.js) count toward "raised this month" by themselves.
const MONEY = require('./money')({ api, auth, db, fail, wrap, rateLimit, getSetting, setSetting, requireInstanceAdmin, getUserRow, broadcastUser, newId, express, brief, auditLog, stepUp, sealSecret, openSecret,
  emitTo: (uid, ev, data) => io && io.to(`user:${uid}`).emit(ev, data), onChange: () => io && io.emit('config:update', { funding: fundingPublic(), support: MONEY.available() }) });
// Creator memberships (server/memberships.js): server owners sell monthly tiers that give a role.
const MEMB = require('./memberships')({ api, auth, db, fail, wrap, rateLimit, getSetting, setSetting, requireInstanceAdmin, requireServer, requireOwner,
  isMember, emitServer, seal, unseal, newId, brief, PM, auditLog, stepUp, sealSecret, openSecret, emitTo: (uid, ev, data) => io && io.to(`user:${uid}`).emit(ev, data),
  mailPublicUrl: () => { let v = {}; try { v = JSON.parse(getSetting('mail') || '{}') || {}; } catch { /* none */ } return String(v.publicUrl || process.env.PUBLIC_URL || '').replace(/\/+$/, ''); } });
// Message search (server/search.js): filters by where, who and when; the search words stay in the app.
require('./search')({ api, auth, db, fail, rateLimit, canIn, PM, requireServer, requireChannel, requireDm, serializeMessage, serializeDmMessage, reactionsFor });
function fundingTotals() {
  const f = funding();
  const auto = MONEY.raisedThisMonth();
  return auto === null ? f : { ...f, raised: Math.round((f.raised + auto) * 100) / 100 };
}
const fundingPublic = () => { const f = fundingTotals(); return f.enabled ? { ...f, supporters: db.prepare('SELECT COUNT(*) n FROM users WHERE supporter = 1').get().n } : null; };
// How the machine is doing: CPU, memory, disk, connections and how responsive the server is.
const { monitorEventLoopDelay } = require('perf_hooks');
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
function health() {
  let disk = null;
  try { const st = fs.statfsSync(DATA_DIR); disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; } catch { /* older Node */ }
  const h = {
    cores: os.cpus().length, load: os.loadavg().map((x) => Math.round(x * 100) / 100), memTotal: os.totalmem(), memFree: os.freemem(),
    rss: process.memoryUsage().rss, disk, sockets: io ? io.engine.clientsCount : 0, lagMs: Math.round(loopDelay.percentile(99) / 1e6), uptime: Math.round(process.uptime()),
  };
  loopDelay.reset();
  return h;
}
api.get('/admin/owner', auth, ownerOnly, (req, res) => {
  res.json({ brand: brand(), features: features(), funding: funding(), supporterQuotaMb: +(getSetting('supporterQuotaMb') || 0),
    supporters: db.prepare('SELECT id FROM users WHERE supporter = 1').all().map((r) => brief(r.id)), ...backupInfo(), autoBackup: autoBackup() });
});
// The donation link is where supporters' money goes, and fewer (or no) automatic backups means older ones get
// deleted sooner: like deleting a backup or changing payment destinations, those need the password (and
// two-factor) again, so a stolen session can't quietly do it.
api.put('/admin/owner', auth, ownerOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const fundingUrl = b.funding && b.funding.url !== undefined ? String(b.funding.url || '').slice(0, 300) : null;
  if (fundingUrl && !/^https:\/\/[^\s]+$/i.test(fundingUrl)) fail(400, 'The donation link must start with https://');
  const urlChanged = fundingUrl !== null && fundingUrl !== funding().url;
  const was = autoBackup();
  const nextBackup = b.autoBackup ? { enabled: !!b.autoBackup.enabled, keep: Math.max(1, Math.min(60, Math.round(+b.autoBackup.keep) || 7)) } : null;
  const fewerBackups = !!nextBackup && ((was.enabled && !nextBackup.enabled) || nextBackup.keep < was.keep);
  if (urlChanged || fewerBackups) await stepUp(req, b);
  if (b.brand) {
    checkWords(b.brand.name, b.brand.tagline);
    if (b.brand.name !== undefined) setSetting('brandName', String(b.brand.name).trim().slice(0, 40) || null);
    if (b.brand.tagline !== undefined) setSetting('brandTagline', String(b.brand.tagline).trim().slice(0, 140) || null);
  }
  if (b.features) {
    const f = features();
    for (const k of ['customCss', 'comments', 'watch', 'gifs']) if (b.features[k] !== undefined) f[k] = !!b.features[k];
    if (['everyone', 'staff'].includes(b.features.createServers)) f.createServers = b.features.createServers;
    setSetting('features', JSON.stringify(f));
  }
  if (b.funding) {
    const f = { ...funding(), ...b.funding };
    if (f.url && !/^https:\/\/[^\s]+$/i.test(f.url)) fail(400, 'The donation link must start with https://');
    setSetting('funding', JSON.stringify({ enabled: !!f.enabled, url: String(f.url || '').slice(0, 300), monthly: Math.max(0, Math.min(1e6, +f.monthly || 0)), raised: Math.max(0, Math.min(1e6, +f.raised || 0)),
      currency: /^[A-Z]{3}$/.test(f.currency) ? f.currency : 'USD', note: String(f.note || '').slice(0, 300) }));
  }
  if (b.supporterQuotaMb !== undefined) setSetting('supporterQuotaMb', String(Math.max(0, Math.min(1e6, Math.round(+b.supporterQuotaMb) || 0))));
  if (nextBackup) setSetting('autoBackup', JSON.stringify(nextBackup));
  const what = Object.keys(b).filter((k) => !['authKey', 'totp', 'backupCode'].includes(k)).map((k) => (k === 'funding' && urlChanged ? 'funding (donation link changed)'
    : k === 'autoBackup' ? `autoBackup (${was.enabled ? 'on' : 'off'}, keep ${was.keep} → ${nextBackup.enabled ? 'on' : 'off'}, keep ${nextBackup.keep})` : k));
  adminLog(req, 'owner_settings', null, what.join(', '));
  io.emit('config:update', { name: brand().name, tagline: brand().tagline, features: features(), funding: fundingPublic() });
  res.json({ ok: true });
}));
// Backups, two kinds:
//   - database copies in data/backups/*.db (daily, and before every upgrade): for quickly undoing a bad update on
//     this machine. They never leave the server (not even as a download): they're as sensitive as the database.
//   - encrypted full backups in data/backups/encrypted/*.hbk (server/backup.js): database + keys + uploads, sealed
//     with the backup key, restore-tested right after they're made, and copied off-site if BACKUP_RCLONE_REMOTE is set.
//     These are what you download or keep elsewhere.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ENC_DIR = path.join(BACKUP_DIR, 'encrypted');
// The plaintext database snapshot a backup starts from lives here (private), never in ENC_DIR: that folder is the
// one people copy off-site as it is.
const BACKUP_TMP = path.join(BACKUP_DIR, '.tmp');
const BK = require('./backup');
// Leftovers untouched this long can't belong to a backup that's still running (it keeps writing to its files).
const STALE_BACKUP_MS = 10 * 60000;
const cleanStaleBackups = (olderThanMs = STALE_BACKUP_MS) => {
  const removed = BK.cleanStale({ outDir: ENC_DIR, tmpDir: BACKUP_TMP, scratchDir: BACKUP_DIR, olderThanMs });
  if (removed.length) console.log(`Removed leftovers of an interrupted backup: ${removed.join(', ')}`);
};
const autoBackup = () => { try { return { enabled: true, keep: 7, ...JSON.parse(getSetting('autoBackup') || '{}') }; } catch { return { enabled: true, keep: 7 }; } };
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^hearth-[\w.-]+\.db$/.test(f)).map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, at: st.mtimeMs }; }).sort((a, b) => b.at - a.at);
  } catch { return []; }
}
function listEncBackups() {
  const status = backupStatus();
  try {
    return fs.readdirSync(ENC_DIR).filter((f) => /^hearth-[\w.-]+\.hbk$/.test(f)).map((f) => { const st = fs.statSync(path.join(ENC_DIR, f)); return { name: f, size: st.size, at: st.mtimeMs, ...(status.files[f] || {}) }; }).sort((a, b) => b.at - a.at);
  } catch { return []; }
}
const backupStatus = () => { try { return { files: {}, ...JSON.parse(getSetting('backupStatus') || '{}') }; } catch { return { files: {} }; } };
const saveBackupStatus = (name, patch) => {
  const st = backupStatus();
  st.files[name] = { ...(st.files[name] || {}), ...patch };
  const keep = new Set(fs.existsSync(ENC_DIR) ? fs.readdirSync(ENC_DIR) : []);
  for (const k of Object.keys(st.files)) if (!keep.has(k)) delete st.files[k];
  setSetting('backupStatus', JSON.stringify(st));
};
async function makeBackup(kind) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `hearth-${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  await db.backup(path.join(BACKUP_DIR, name));
  return name;
}
// Which encrypted backups retention removes (list: newest first). It keeps the newest `keep` (at least 2), and also
// the newest backup of each of the last `keep` days that have one, so a burst of backups made by hand (say, by a
// stolen session) can't push older days out any faster than the daily schedule does.
function backupsToPrune(list, keep) {
  const n = Math.max(2, keep);
  const kept = new Set(list.slice(0, n).map((x) => x.name));
  const days = new Set();
  for (const x of list) {
    const day = new Date(x.at).toISOString().slice(0, 10);
    if (!days.has(day) && days.size < n) { days.add(day); kept.add(x.name); }
  }
  return list.filter((x) => !kept.has(x.name));
}
let encBusy = null;
// Make → restore-test → copy off-site. One at a time.
function makeEncryptedBackup() {
  if (encBusy) return encBusy;
  encBusy = (async () => {
    cleanStaleBackups(3600000); // anything this old belongs to a backup that was cut off, not one still running
    const b = await BK.createBackup({ db, dataDir: DATA_DIR, uploadDir: UPLOAD_DIR, outDir: ENC_DIR, tmpDir: BACKUP_TMP });
    let verified;
    try { verified = { ...(await BK.verifyBackup(b.file, BK.loadKey(DATA_DIR), BACKUP_DIR)), at: now() }; } catch (e) { verified = { ok: false, error: e.message, at: now() }; }
    saveBackupStatus(b.name, { verified });
    if (!verified.ok) { console.error(`Encrypted backup ${b.name} FAILED its restore test: ${verified.error}`); auditLog(null, 'backup_restore_test_failed', null, `${b.name}: ${verified.error}`); return { ...b, verified }; }
    const offsite = await BK.uploadOffsite(b.file);
    if (!offsite.skipped) {
      saveBackupStatus(b.name, { offsite: { ...offsite, at: now() } });
      if (!offsite.ok) { console.error(`Copying ${b.name} off-site failed: ${offsite.error}`); auditLog(null, 'backup_offsite_failed', null, `${b.name}: ${offsite.error}`); }
    }
    // A copy on each linked region with backup space (server/regions.js), so losing this machine isn't losing it all.
    const regions = await REG.copyBackup(b.file).catch((e) => ({ error: { ok: false, error: e.message, at: now() } }));
    if (Object.keys(regions).length) {
      saveBackupStatus(b.name, { regions });
      for (const r of Object.values(regions)) if (!r.ok) { console.error(`Copying ${b.name} to region ${r.name || ''} failed: ${r.error}`); auditLog(null, 'backup_region_failed', null, `${b.name} → ${r.name || '?'}: ${r.error}`); }
    }
    const keep = autoBackup().keep;
    for (const x of backupsToPrune(listEncBackups(), keep)) {
      try { fs.unlinkSync(path.join(ENC_DIR, x.name)); auditLog(null, 'backup_pruned', null, `${x.name} (keeping ${keep})`); } catch { /* already gone */ }
    }
    return { ...b, verified, offsite, regions };
  })().finally(() => { encBusy = null; });
  return encBusy;
}
const backupInfo = () => ({ backups: listBackups(), encrypted: listEncBackups(), offsite: (process.env.BACKUP_RCLONE_REMOTE || '').trim() || null, keyFrom: process.env.BACKUP_KEY ? 'env' : 'file',
  regionCopies: db.prepare('SELECT name, stats FROM regions').all().map((r) => { try { const b = JSON.parse(r.stats || '{}').backup; return b && b.ready ? r.name : null; } catch { return null; } }).filter(Boolean) });
api.post('/admin/backups', auth, ownerOnly, wrap(async (req, res) => {
  rateLimit('backup:' + req.userId, 6, 3600000);
  const b = await makeEncryptedBackup();
  auditLog(req, 'backup_made', null, `${b.name}${b.verified && b.verified.ok ? ', restore test passed' : ', RESTORE TEST FAILED'}`);
  res.json({ name: b.name, verified: b.verified, offsite: b.offsite, ...backupInfo() });
}));
api.post('/admin/backups/:name/verify', auth, ownerOnly, wrap(async (req, res) => {
  rateLimit('backupverify:' + req.userId, 20, 3600000);
  const hit = listEncBackups().find((b) => b.name === req.params.name);
  if (!hit) fail(404, 'Backup not found.');
  let verified;
  try { verified = { ...(await BK.verifyBackup(path.join(ENC_DIR, hit.name), BK.loadKey(DATA_DIR), BACKUP_DIR)), at: now() }; } catch (e) { verified = { ok: false, error: e.message, at: now() }; }
  saveBackupStatus(hit.name, { verified });
  auditLog(req, 'backup_restore_test', null, `${hit.name}: ${verified.ok ? 'passed' : verified.error}`);
  res.json({ verified, ...backupInfo() });
}));
// Only encrypted backups can be downloaded.
api.get('/admin/backups/:name', auth, ownerOnly, (req, res) => {
  const hit = listEncBackups().find((b) => b.name === req.params.name);
  if (!hit) fail(404, 'Backup not found.');
  auditLog(req, 'backup_downloaded', null, hit.name);
  res.download(path.join(ENC_DIR, hit.name), hit.name);
});
// Deleting a backup can't be undone (and is what someone covering their tracks would do), so it needs the
// password (and two-factor) again.
api.delete('/admin/backups/:name', auth, ownerOnly, wrap(async (req, res) => {
  const hit = listEncBackups().find((b) => b.name === req.params.name) || listBackups().find((b) => b.name === req.params.name);
  if (!hit) fail(404, 'Backup not found.');
  await stepUp(req, req.body);
  fs.unlinkSync(path.join(hit.name.endsWith('.hbk') ? ENC_DIR : BACKUP_DIR, hit.name));
  auditLog(req, 'backup_deleted', null, hit.name);
  res.json(backupInfo());
}));
// The backup key, to keep in a password manager. Needs the password (and two-factor) again; always logged.
api.post('/admin/backups/key', auth, ownerOnly, wrap(async (req, res) => {
  await stepUp(req, req.body);
  if (process.env.BACKUP_KEY) fail(400, 'This server’s backup key is BACKUP_KEY in its .env file.');
  const key = BK.loadKey(DATA_DIR).toString('hex');
  auditLog(req, 'backup_key_viewed', null, '');
  res.json({ key });
}));
// Every day: a database copy (for quick rollback here) and an encrypted, restore-tested, off-site backup.
setInterval(async () => {
  const a = autoBackup();
  if (!a.enabled) return;
  const autos = listBackups().filter((b) => b.name.startsWith('hearth-auto-'));
  if (!autos.length || Date.now() - autos[0].at > 23.5 * 3600000) {
    try {
      await makeBackup('auto');
      listBackups().filter((b) => b.name.startsWith('hearth-auto-')).slice(a.keep).forEach((b) => fs.promises.unlink(path.join(BACKUP_DIR, b.name)).catch(() => {}));
    } catch (e) { console.error('Automatic backup failed:', e.message); }
  }
  const enc = listEncBackups();
  if (!enc.length || Date.now() - enc[0].at > 23.5 * 3600000) {
    try { await makeEncryptedBackup(); } catch (e) { console.error('Encrypted backup failed:', e.message); auditLog(null, 'backup_failed', null, e.message); }
  }
}, 3600000).unref();

// One-time: list files uploaded before storage tracking existed, so quotas count them too.
function indexOldFiles() {
  if (getSetting('filesIndexed')) return;
  const sizeOf = (url) => { try { return fs.statSync(path.join(UPLOAD_DIR, path.basename(url))).size; } catch { return -1; } };
  const add = (uid, url, kind) => { if (!uid || !url || !url.startsWith('/uploads/')) return; const sz = sizeOf(url); if (sz >= 0) db.prepare('INSERT OR IGNORE INTO user_files (name, user_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?)').run(path.basename(url), uid, kind, sz, now()); };
  db.transaction(() => {
    db.prepare('SELECT name, uploader_id, created_at FROM blobs').all().forEach((b) => add(b.uploader_id, '/uploads/' + b.name, 'attachment'));
    db.prepare('SELECT id, avatar, banner, background, song, page_bg FROM users').all().forEach((u) => {
      add(u.id, u.avatar, 'image'); add(u.id, u.banner, 'image'); add(u.id, u.background, 'image'); add(u.id, u.song, 'song'); add(u.id, u.page_bg, 'image');
    });
    db.prepare('SELECT owner_id, icon FROM servers').all().forEach((x) => add(x.owner_id, x.icon, 'image'));
    db.prepare('SELECT created_by, url FROM emojis').all().forEach((e) => add(e.created_by, e.url, 'emoji'));
  })();
  setSetting('filesIndexed', '1');
}
// One-time: GIFs people uploaded to the server's GIF library before library uploads counted toward storage, so
// they count (and show under "GIF library" in Storage) like the ones uploaded since. Learned GIFs aren't anyone's
// upload and stay uncounted. The original upload time is kept, so they don't use up today's allowance.
function indexLibraryUploads() {
  if (getSetting('gifLibraryIndexed')) return;
  const add = db.prepare('INSERT OR IGNORE INTO user_files (name, user_id, kind, size, created_at) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare("SELECT g.file, g.added_by, g.size, g.created_at FROM gif_library g JOIN users u ON u.id = g.added_by WHERE g.source = 'upload'").all()
      .forEach((g) => { if (fs.existsSync(path.join(UPLOAD_DIR, path.basename(g.file)))) add.run(path.basename(g.file), g.added_by, 'gif', g.size, g.created_at); });
  })();
  setSetting('gifLibraryIndexed', '1');
}

// ---------------------------------------------------------------- errors + SPA fallback
api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Files can be up to ${MAX_UPLOAD_MB} MB.` : err.message;
    return res.status(400).json({ error: msg });
  }
  // Broken or oversized request bodies (from express.json) are the sender's mistake, not a server error.
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request wasn’t valid JSON.', code: 'bad_json' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too big.', code: 'too_large' });
  if (err.type && /^(encoding|charset)\./.test(err.type)) return res.status(415).json({ error: 'Unsupported request encoding.' });
  const status = err.status || 500;
  const expected = err instanceof HttpError; // our own, user-facing errors keep their message
  if (!expected) console.error(err);
  if (expected && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
  res.status(status).json({ error: expected ? err.message : 'Something broke on the server.', code: err.code });
});
app.get(/^\/(?!api|uploads|socket\.io).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------------------------------------------------------------- HTTP(S) + sockets
async function loadTls() {
  if (process.env.SSL_CERT && process.env.SSL_KEY) {
    return { cert: fs.readFileSync(process.env.SSL_CERT), key: fs.readFileSync(process.env.SSL_KEY) };
  }
  const certPath = path.join(DATA_DIR, 'cert.pem');
  const keyPath = path.join(DATA_DIR, 'key.pem');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    const selfsigned = require('selfsigned');
    const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) altNames.push({ type: 7, ip: n.address });
    }
    (process.env.PUBLIC_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean).forEach((h) => {
      altNames.push(/^\d+\.\d+\.\d+\.\d+$/.test(h) ? { type: 7, ip: h } : { type: 2, value: h });
    });
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + 5);
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'hearth.local' }], {
      keySize: 2048, algorithm: 'sha256', notAfterDate: notAfter,
      extensions: [{ name: 'basicConstraints', cA: false }, { name: 'subjectAltName', altNames }],
    });
    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
    console.log('Generated a self-signed certificate in', DATA_DIR);
  }
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

let io;

// Voice rooms are server voice channels (by channel id) or 1-to-1 DM calls ("dm:<dmId>").
const dmOfRoom = (room) => (String(room).startsWith('dm:') ? db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(String(room).slice(3)) : null);
function emitVoiceState(room) {
  const payload = { channelId: room, users: voiceStateList(room) };
  const d = dmOfRoom(room);
  if (d) return io.to([`user:${d.user_a}`, `user:${d.user_b}`]).emit('voice:state', payload);
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(room);
  if (c) toChannel(c).emit('voice:state', payload);
}
// Who should hear the phone ring when a call starts in this room (everyone else who can join it).
function callees(room, callerId) {
  const d = dmOfRoom(room);
  if (d) return [d.user_a === callerId ? d.user_b : d.user_a];
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(room);
  const srv = c && serverOf(c);
  if (!srv || srv.kind !== 'group') return [];
  return db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(srv.id).map((r) => r.user_id).filter((u) => u !== callerId);
}
// ---------------------------------------------------------------- watch together
// One shared player per call: what's playing, where it was at `updatedAt` and whether it's playing.
// Everyone in the call keeps their player in step with it; late joiners jump straight in.
const watchRooms = new Map(); // room -> { item, queue, playing, position, rate, updatedAt, by, hostOnly }
// The whole shared state (queue included) goes to everyone in the call on every change, so it stays small:
// links are capped, and so is the state as a whole.
const WATCH_URL_MAX = 2048;
const WATCH_STATE_MAX = 64 * 1024;
function parseWatchUrl(raw) {
  let u;
  const text = String(raw || '').trim();
  if (text.length > WATCH_URL_MAX) fail(400, 'That link is too long.');
  try { u = new URL(text); } catch { fail(400, 'Paste a link to a video.'); }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const secs = (t) => { if (!t) return 0; if (/^\d+$/.test(t)) return +t; const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
  if (!/^https?:$/.test(u.protocol)) fail(400, 'Paste a link to a video.');
  if (['youtube.com', 'youtube-nocookie.com'].includes(host) || host === 'youtu.be') {
    const id = host === 'youtu.be' ? u.pathname.slice(1, 12) : (u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) || [])[1]);
    if (!/^[\w-]{11}$/.test(id || '')) fail(400, 'That YouTube link doesn\u2019t point to a video.');
    return { kind: 'youtube', src: id, start: secs(u.searchParams.get('t') || u.searchParams.get('start')), link: `https://www.youtube.com/watch?v=${id}` };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = (u.pathname.match(/(\d{5,12})/) || [])[1];
    if (!id) fail(400, 'That Vimeo link doesn\u2019t point to a video.');
    return { kind: 'vimeo', src: id, start: 0, link: `https://vimeo.com/${id}` };
  }
  if (host === 'twitch.tv') {
    const ch = u.pathname.split('/')[1] || '';
    if (!/^[a-z0-9_]{3,25}$/i.test(ch) || ['videos', 'directory', 'settings'].includes(ch)) fail(400, 'Paste the link of a live Twitch channel (twitch.tv/name).');
    return { kind: 'twitch', src: ch.toLowerCase(), start: 0, link: `https://twitch.tv/${ch}`, live: true };
  }
  if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(u.pathname) && /^https?:$/.test(u.protocol)) {
    if (u.href.length > WATCH_URL_MAX) fail(400, 'That link is too long.'); // URL() can lengthen it (escaping)
    return { kind: 'video', src: u.href, start: 0, link: u.href };
  }
  fail(400, 'That site isn\u2019t supported yet. YouTube, Vimeo, Twitch (live) and direct video files (.mp4, .webm) work. For anything else, share your screen.');
}
async function watchTitle(item) {
  try {
    const api = item.kind === 'youtube' ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(item.link)}`
      : item.kind === 'vimeo' ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(item.link)}` : null;
    if (!api) return item.kind === 'twitch' ? `${item.src} (live on Twitch)` : decodeURIComponent(item.src.split('/').pop()).slice(0, 120);
    const r = await fetch(api, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return '';
    const j = await r.json();
    return String(j.title || '').slice(0, 150);
  } catch { return ''; }
}
const watchOut = (room) => { const w = watchRooms.get(room); if (!w) return null; const { votes, ...out } = w; return { ...out, serverNow: Date.now() }; };
// Changes are sent at most 4 times a second per call: quick bursts (dragging through a video, a stream of
// controls) go out as one update carrying the latest state, so a flood of tiny events can't turn into a
// flood of full-state broadcasts.
const watchEmits = new Map(); // room -> { last, timer }
function emitWatch(room) {
  const e = watchEmits.get(room) || { last: 0, timer: null };
  watchEmits.set(room, e);
  if (e.timer) return;
  const send = () => { e.timer = null; e.last = Date.now(); io.to(`voice:${room}`).emit('watch:state', { room, state: watchOut(room) }); };
  const wait = e.last + 250 - Date.now();
  if (wait <= 0) send(); else e.timer = setTimeout(send, wait);
}
const dropWatch = (room) => { const e = watchEmits.get(room); if (e) clearTimeout(e.timer); watchEmits.delete(room); watchRooms.delete(room); };
// Where the video is right now, according to the shared state.
const watchPos = (w) => w.position + (w.playing ? ((Date.now() - w.updatedAt) / 1000) * w.rate : 0);

// Study together: a shared focus timer in a voice channel or call. Everyone in the room sees the same countdown
// (worked out from when it started), so only the settings and start time live here; it ends when the room empties.
function leaveVoice(userId, notifyUser = false) {
  const channelId = userVoice.get(userId);
  if (!channelId) return;
  const m = voiceChannels.get(channelId);
  const state = m && m.get(userId);
  if (m) { m.delete(userId); if (!m.size) { voiceChannels.delete(channelId); dropWatch(channelId); } }
  userVoice.delete(userId);
  if (state) {
    const sock = io.sockets.sockets.get(state.socketId);
    if (sock) sock.leave(`voice:${channelId}`);
    io.to(`voice:${channelId}`).emit('voice:peer-left', { socketId: state.socketId, userId });
    if (notifyUser) io.to(state.socketId).emit('voice:kicked', { channelId });
  }
  emitVoiceState(channelId);
  // Caller hung up before anyone answered (or everyone left): stop the other phones ringing.
  if (!voiceChannels.has(channelId)) callees(channelId, userId).concat(userId).forEach((u) => io.to(`user:${u}`).emit('call:end', { room: channelId }));
}

// Realtime flood limits shared by all of a person's connections (each connection also has its own; see below).
const MAX_SOCKETS_PER_USER = 30;
const USER_BURST = 120; const USER_RATE = 30; // events: at most 120 at once, then 30 a second
const userBudget = new Map(); // userId -> { tokens, at }
function spendUserBudget(uid) {
  const t = Date.now();
  const b = userBudget.get(uid) || { tokens: USER_BURST, at: t };
  b.tokens = Math.min(USER_BURST, b.tokens + ((t - b.at) / 1000) * USER_RATE);
  b.at = t;
  userBudget.set(uid, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
// "Typing…" fans out to a whole server (and, in private channels, works out who may see it for every member),
// so one person's typing events are passed on at most once a second, however many windows send them.
const typingAt = new Map(); // userId -> when their last typing event was passed on

function setupSockets(server) {
  // Every realtime event is small (the largest, a call offer, is a few kilobytes), so a message can be at most
  // 256 KB: bigger ones only cost the server time to read.
  io = new Server(server, { pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 256 * 1024, allowRequest: (req, cb) => cb(null, directGuard(req.socket.remoteAddress)) });
  // Every minute: an open connection whose session has ended (signed out, expired, account suspended or
  // deleted) is closed; one that's still fine counts as use, so an app left open never idles out.
  setInterval(() => {
    const t = now();
    const touch = db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?');
    const seen = new Set();
    for (const sock of io.sockets.sockets.values()) {
      const s = sock.data.sid && db.prepare('SELECT * FROM sessions WHERE id = ?').get(sock.data.sid);
      const u = s && db.prepare('SELECT suspended_at, suspended_until, deleted_at FROM users WHERE id = ?').get(s.user_id);
      if (!sessionLive(s, t) || !u || u.deleted_at || (u.suspended_at && (!u.suspended_until || u.suspended_until > t))) {
        sock.emit('session:revoked', { reason: s && s.revoke_reason ? s.revoke_reason : 'expired' });
        sock.disconnect(true);
      } else if (!seen.has(s.id) && t - (s.last_used_at || 0) > 5 * 60000) { seen.add(s.id); touch.run(t, s.id); }
    }
  }, 60000).unref();

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const s = sessionFor(token);
    if (!s) return next(new Error('unauthorized'));
    const u = db.prepare('SELECT id, suspended_at, suspended_until, deleted_at FROM users WHERE id = ?').get(s.user_id);
    if (!u || u.deleted_at || stillSuspended(u)) return next(new Error('unauthorized'));
    if (ipBanned(socketIp(socket)) && !isStaff(s.user_id)) { secEvent('blocked_ip', socketIp(socket), 'connection'); return next(new Error('unauthorized')); }
    if (maintenance() && !isStaff(s.user_id)) return next(new Error('maintenance'));
    // Every window is one connection. Far more than anyone has open only multiplies what one account can send,
    // and connecting over and over (each one is checked and recorded) only costs the server time.
    if ((onlineSockets.get(s.user_id)?.size || 0) >= MAX_SOCKETS_PER_USER) return next(new Error('too_many_connections'));
    try { rateLimit('sockconn:' + s.user_id, 60, 60000); } catch { return next(new Error('rate_limited')); }
    socket.userId = s.user_id;
    socket.data.token = token;
    socket.data.sid = s.id;
    socket.data.ip = socketIp(socket);
    socket.data.since = Date.now();
    socket.data.ua = String(socket.handshake.headers['user-agent'] || '').slice(0, 200);
    recordIp(s.user_id, socket.data.ip, token);
    next();
  });

  io.on('connection', (socket) => {
    const uid = socket.userId;
    // Flood protection. A connection may send 40 events per 4 seconds, and all of a person's connections together
    // 120, so opening more windows doesn't buy more. Call signaling has its own, larger allowance: joining a call
    // sends an offer and a dozen network candidates to every person in it at once. A refused event is answered
    // with "Slow down." so the app isn't left waiting. Refusals are forgiven over time (5 a second), so a busy
    // call never adds up to a disconnect; only flooding that keeps going closes the connection, and the app is
    // told why first ('flood'), so it reconnects instead of taking it for a sign-out.
    let bucket = 40; let signalBucket = 200; let strikes = 0;
    const refill = setInterval(() => {
      bucket = Math.min(40, bucket + 10);
      signalBucket = Math.min(200, signalBucket + 50);
      strikes = Math.max(0, strikes - 5);
    }, 1000);
    socket.on('disconnect', () => clearInterval(refill));
    const refuse = (packet) => { const ack = packet[packet.length - 1]; if (typeof ack === 'function') ack({ error: 'Slow down.' }); };
    socket.use((packet, next) => {
      // (The bigger signaling allowance is only for the one connection this person is in a call with.)
      const signal = packet[0] === 'voice:signal' && voiceChannels.get(userVoice.get(uid))?.get(uid)?.socketId === socket.id;
      if (signal ? signalBucket > 0 : bucket > 0) {
        if (signal) { signalBucket--; return next(); }
        bucket--;
        if (spendUserBudget(uid)) return next();
        return refuse(packet); // this person's other windows used up the shared allowance: no strike for this one
      }
      refuse(packet);
      if (++strikes > 50 && socket.connected) { socket.emit('flood', { reason: 'too_many_events' }); socket.disconnect(true); }
    });
    socket.join(`user:${uid}`);
    if (isStaff(uid)) socket.join('admins');
    db.prepare('SELECT server_id FROM members WHERE user_id = ?').all(uid).forEach((r) => socket.join(`server:${r.server_id}`));

    const wasOnline = isOnline(uid);
    if (!onlineSockets.has(uid)) onlineSockets.set(uid, new Set());
    onlineSockets.get(uid).add(socket.id);
    if (!wasOnline) broadcastPresence(uid);

    const guard = (fn) => (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
      try { cb(fn(...args) || { ok: true }); } catch (e) { cb({ error: e.message || 'Error' }); }
    };

    // "Is typing…" goes only where the person could actually send: not in channels where they can't post,
    // and never to someone who blocked them (or whom they blocked).
    socket.on('typing', guard((p = {}) => {
      if (p.channelId) {
        const c = requireChannel(String(p.channelId), uid);
        if (!(perms.channel(serverOf(c), c, uid) & PM.SEND_MESSAGES)) fail(403, 'You can\u2019t send messages here.');
        if (Date.now() - (typingAt.get(uid) || 0) < 1000) return;
        typingAt.set(uid, Date.now());
        toChannel(c, socket).emit('typing', { channelId: c.id, userId: uid });
      } else if (p.dmId) {
        const d = requireDm(String(p.dmId), uid);
        if (isBlocked(d.user_a, d.user_b)) return; // quietly: they can't message, so they aren't typing to anyone
        if (Date.now() - (typingAt.get(uid) || 0) < 1000) return;
        typingAt.set(uid, Date.now());
        const other = d.user_a === uid ? d.user_b : d.user_a;
        io.to(`user:${other}`).emit('typing', { dmId: d.id, userId: uid });
      }
    }));

    socket.on('voice:join', guard((p = {}) => {
      const roomId = String(p.channelId || '');
      let room; let vp = PM.CONNECT | PM.SPEAK;
      if (roomId.startsWith('dm:')) {
        const d = requireDm(roomId.slice(3), uid);
        if (isBlocked(d.user_a, d.user_b)) fail(403, 'You can\u2019t call this person.');
        room = roomId;
      } else {
        const c = requireChannel(roomId, uid);
        if (c.type !== 'voice') fail(400, 'Not a voice channel.');
        vp = perms.channel(serverOf(c), c, uid);
        if (!(vp & PM.CONNECT)) fail(403, 'You don\u2019t have permission to join this voice channel.');
        room = c.id;
      }
      const c = { id: room };
      if (userVoice.has(uid)) {
        const prev = voiceChannels.get(userVoice.get(uid))?.get(uid);
        leaveVoice(uid, prev && prev.socketId !== socket.id);
      }
      if (!voiceChannels.has(c.id)) voiceChannels.set(c.id, new Map());
      const m = voiceChannels.get(c.id);
      const peers = [...m.entries()].map(([userId, s]) => ({ userId, socketId: s.socketId }));
      // speak: whether they may talk here (the app keeps the mic off without it; recheckVoice keeps it current).
      const speak = !!(vp & PM.SPEAK);
      m.set(uid, { socketId: socket.id, muted: !!p.muted || !speak, deafened: !!p.deafened, video: false, screen: false, speak });
      userVoice.set(uid, c.id);
      socket.join(`voice:${c.id}`);
      emitVoiceState(c.id);
      if (watchRooms.has(c.id)) socket.emit('watch:state', { room: c.id, state: watchOut(c.id) });
      // First one in a DM or group call: ring everyone else (and push-notify them if their app is closed).
      if (!peers.length) {
        const ring = callees(c.id, uid);
        const d = dmOfRoom(c.id);
        const ch = !d && db.prepare('SELECT * FROM channels WHERE id = ?').get(c.id);
        ring.forEach((u) => io.to(`user:${u}`).emit('call:ring', { room: c.id, dmId: d ? d.id : null, serverId: ch ? ch.server_id : null, from: uid, video: !!p.video }));
        if (ring.length) pushTo(ring, { title: nameOf(uid), body: p.video ? 'is video calling you' : 'is calling you', tag: 'call:' + c.id, url: '/' });
      }
      return { ok: true, peers, canSpeak: speak };
    }));

    socket.on('voice:signal', guard((p = {}) => {
      const ch = userVoice.get(uid);
      const m = ch && voiceChannels.get(ch);
      if (!m || m.get(uid)?.socketId !== socket.id) fail(400, 'You are not in voice.');
      const target = [...m.values()].find((s) => s.socketId === p.to);
      if (!target) fail(404, 'Peer left.');
      // An offer or answer is a few kilobytes and a network candidate a few hundred bytes; signaling has a bigger
      // allowance than other events, so it can't be used to push megabytes at someone.
      if (JSON.stringify(p.data ?? null).length > 64 * 1024) fail(413, 'That signal is too big.');
      io.to(p.to).emit('voice:signal', { from: socket.id, userId: uid, data: p.data });
    }));

    socket.on('voice:update', guard((p = {}) => {
      const ch = userVoice.get(uid);
      const s = ch && voiceChannels.get(ch)?.get(uid);
      if (!s || s.socketId !== socket.id) return;
      s.muted = !!p.muted || !s.speak;
      s.deafened = !!p.deafened;
      if (p.video !== undefined) s.video = !!p.video;
      if (p.screen !== undefined) s.screen = !!p.screen;
      emitVoiceState(ch);
    }));

    // Declining a call: tell whoever is calling, and stop this person's other devices ringing.
    socket.on('call:decline', guard((p = {}) => {
      const room = String(p.room || '');
      // Only someone who could join the call can decline it (or anyone could fake "X declined" into any call).
      const d = dmOfRoom(room);
      if (d && d.user_a !== uid && d.user_b !== uid) fail(403, 'Not your call.');
      // Only calls that ring can be declined: a DM call, or a group chat's call by one of its members.
      if (!d) {
        const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(room);
        const srv = c && serverOf(c);
        if (!srv || srv.kind !== 'group' || c.type !== 'voice' || !isMember(srv.id, uid)) fail(404, 'No such call.');
      }
      const m = voiceChannels.get(room);
      if (m) for (const [u] of m) io.to(`user:${u}`).emit('call:declined', { room, userId: uid });
      io.to(`user:${uid}`).emit('call:end', { room });
    }));

    // Watch together (only people in the call).
    const myWatchRoom = () => {
      const room = userVoice.get(uid);
      if (!room || voiceChannels.get(room)?.get(uid)?.socketId !== socket.id) fail(400, 'Join the call first.');
      return room;
    };
    const mayControl = (room, w) => !w.hostOnly || w.by === uid || isStaff(uid)
      || (!room.startsWith('dm:') && (() => { const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(room); return c && (perms.channel(serverOf(c), c, uid) & PM.MANAGE_CHANNELS); })());
    socket.on('watch:start', guard((p = {}) => {
      if (!features().watch) fail(403, 'Watch together is turned off on this server.');
      const room = myWatchRoom();
      const item = { ...parseWatchUrl(p.url), id: newId(), title: '', addedBy: uid };
      const cur = watchRooms.get(room);
      if (cur && p.queue) {
        if (!mayControl(room, cur) && cur.hostOnly) fail(403, 'Only the host can add videos.');
        if (cur.queue.length >= 25) fail(400, 'The queue is full (25).');
        if (JSON.stringify(cur).length + JSON.stringify(item).length > WATCH_STATE_MAX) fail(400, 'The queue is full.');
        cur.queue.push(item);
      } else {
        if (cur && !mayControl(room, cur)) fail(403, 'Only the host can change the video.');
        watchRooms.set(room, { item, queue: cur ? cur.queue : [], playing: true, position: item.start || 0, rate: 1, updatedAt: Date.now(), by: cur && cur.hostOnly ? cur.by : uid, hostOnly: cur ? cur.hostOnly : !!p.hostOnly, seq: ((cur && cur.seq) || 0) + 1, lastBy: uid, lastAction: 'start' });
      }
      emitWatch(room);
      watchTitle(item).then((t) => { if (t && watchRooms.has(room)) { item.title = t; emitWatch(room); } });
      return { ok: true };
    }));
    socket.on('watch:control', guard((p = {}) => {
      const room = myWatchRoom();
      const w = watchRooms.get(room);
      if (!w) fail(404, 'Nothing is playing.');
      if (!mayControl(room, w)) fail(403, 'Only the host controls playback.');
      if (p.itemId && p.itemId !== w.item.id) return { ok: true }; // about an older video
      const pos = Number.isFinite(+p.position) ? Math.max(0, +p.position) : watchPos(w);
      if (p.action === 'play') { w.playing = true; w.position = pos; }
      else if (p.action === 'pause') { w.playing = false; w.position = pos; }
      else if (p.action === 'seek') { w.position = pos; }
      else if (p.action === 'rate' && [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(+p.rate)) { w.position = watchPos(w); w.rate = +p.rate; }
      else if (p.action === 'hostOnly' && (w.by === uid || isStaff(uid))) { w.hostOnly = !!p.value; }
      else return { ok: true };
      w.updatedAt = Date.now();
      // Who did what, so everyone else's app can say "ana jumped to 12:30".
      w.seq = (w.seq || 0) + 1; w.lastBy = uid; w.lastAction = p.action;
      emitWatch(room);
      return { ok: true };
    }));
    // The video ended (or someone pressed "next"): play the next one in the queue.
    socket.on('watch:next', guard((p = {}) => {
      const room = myWatchRoom();
      const w = watchRooms.get(room);
      if (!w || (p.itemId && p.itemId !== w.item.id)) return { ok: true };
      if (!mayControl(room, w)) {
        // Only the host skips. "My video ended" from anyone else counts once most of the call says so (players
        // finish a moment apart), so one person can't skip or stop the video for everyone.
        if (p.skip || !p.itemId) fail(403, 'Only the host can skip.');
        const m = voiceChannels.get(room);
        if (!w.votes || w.votes.item !== w.item.id) w.votes = { item: w.item.id, users: new Set() };
        w.votes.users.add(uid);
        const ended = [...w.votes.users].filter((u) => m && m.has(u)).length;
        if (ended * 2 <= (m ? m.size : 1)) return { ok: true };
      }
      w.votes = null;
      if (!w.queue.length) { w.playing = false; w.position = watchPos(w); w.updatedAt = Date.now(); emitWatch(room); return { ok: true }; }
      w.item = w.queue.shift();
      Object.assign(w, { playing: true, position: w.item.start || 0, rate: 1, updatedAt: Date.now() });
      emitWatch(room);
      return { ok: true };
    }));
    socket.on('watch:remove', guard((p = {}) => {
      const room = myWatchRoom();
      const w = watchRooms.get(room);
      if (!w) return { ok: true };
      const it = w.queue.find((x) => x.id === p.itemId);
      if (it && (it.addedBy === uid || mayControl(room, w))) { w.queue = w.queue.filter((x) => x !== it); emitWatch(room); }
      return { ok: true };
    }));
    socket.on('watch:stop', guard(() => {
      const room = myWatchRoom();
      const w = watchRooms.get(room);
      if (!w) return { ok: true };
      if (!mayControl(room, w)) fail(403, 'Only the host can stop it.');
      dropWatch(room);
      io.to(`voice:${room}`).emit('watch:state', { room, state: null });
      return { ok: true };
    }));

    socket.on('voice:leave', guard(() => {
      const ch = userVoice.get(uid);
      const s = ch && voiceChannels.get(ch)?.get(uid);
      if (s && s.socketId === socket.id) leaveVoice(uid);
    }));

    socket.on('disconnect', () => {
      const ch = userVoice.get(uid);
      const s = ch && voiceChannels.get(ch)?.get(uid);
      if (s && s.socketId === socket.id) leaveVoice(uid);
      const set = onlineSockets.get(uid);
      if (set) { set.delete(socket.id); if (!set.size) onlineSockets.delete(uid); }
      if (!isOnline(uid)) { userBudget.delete(uid); typingAt.delete(uid); broadcastPresence(uid); }
    });
  });
}

(async () => {
  let server;
  if (USE_HTTPS) server = https.createServer(await loadTls(), app);
  else server = http.createServer(app);
  setupSockets(server);
  try { indexOldFiles(); } catch (e) { console.error('Could not index existing uploads:', e.message); }
  try { indexLibraryUploads(); } catch (e) { console.error('Could not index GIF library uploads:', e.message); }
  // A backup cut off by a crash or a forced stop may have left a plaintext snapshot or a half-written file. Files
  // touched in the last few minutes may belong to a backup that's still running (`node server/cli.js backup` from
  // a cron job, say), so those are looked at again a little later instead.
  const cleanLeftovers = () => { try { cleanStaleBackups(STALE_BACKUP_MS); } catch (e) { console.error('Could not clean up old backup files:', e.message); } };
  cleanLeftovers();
  setTimeout(cleanLeftovers, STALE_BACKUP_MS + 60000).unref();
  server.listen(PORT, HOST, () => {
    const scheme = USE_HTTPS ? 'https' : 'http';
    console.log(`\n  ${INSTANCE_NAME} is running.\n`);
    console.log(`  This computer:  ${scheme}://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`  Your network:   ${scheme}://${n.address}:${PORT}`);
    }
    if (USE_HTTPS && !process.env.SSL_CERT) console.log('\n  Using a self-signed certificate: browsers will show a warning the first time. Click "Advanced" → "Proceed".');
    if (!USE_HTTPS) console.log('\n  HTTPS is off. Voice chat and encryption only work on localhost or behind an HTTPS reverse proxy.');
    console.log('');
  });

  // Fast, clean restarts (updates, docker restart, systemctl restart). Without this, Docker waits
  // 10 seconds and then force-kills the process. We tell everyone we're restarting (their app shows
  // "Updating…" and reconnects by itself), stop accepting connections, save the database, and exit.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n  ${signal} received: restarting cleanly.`);
    try { io.emit('server:restarting', { at: Date.now() }); } catch { /* ignore */ }
    // A backup still running can't finish now: don't leave its plaintext snapshot or half-written file behind.
    const exit = () => { try { BK.removeInFlight(); } catch { /* ignore */ } process.exit(0); };
    setTimeout(() => {
      try { io.close(); } catch { /* ignore */ }
      server.close();
      server.closeAllConnections?.();
      try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* ignore */ }
      exit();
    }, 250);
    setTimeout(exit, 4000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
