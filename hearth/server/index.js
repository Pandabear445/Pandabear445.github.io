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
const { db, seal, unseal, newId, DATA_DIR, UPLOAD_DIR, atRestKey } = require('./db');
const { sanitizeProfile, parseProfile } = require('./profile');
const { sanitizePage, parsePage } = require('./page');
const { PERMS: PM, ALL: ALL_PERMS, DEFAULT_EVERYONE, CHANNEL_SCOPED, makePerms } = require('./perms');
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
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (e) { next(e); }
};

// Very small in-memory rate limiter.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count += 1;
  if (b.count > max) fail(429, 'Too many attempts. Wait a minute and try again.');
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

// ---------------------------------------------------------------- presence + voice state
const onlineSockets = new Map(); // userId -> Set(socketId)
const voiceChannels = new Map(); // channelId -> Map(userId -> { socketId, muted, deafened })
const userVoice = new Map(); // userId -> channelId

const isOnline = (userId) => onlineSockets.has(userId) && onlineSockets.get(userId).size > 0;

// ---------------------------------------------------------------- serialization
const getUserRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function publicUser(row) {
  if (!row) return null;
  const profile = parseProfile(row);
  let presence = 'offline';
  if (isOnline(row.id) && row.status !== 'invisible') presence = row.status;
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
  u.staffRole = staffRole(row.id);
  u.instanceAdmin = (STAFF_RANK[u.staffRole] || 0) >= 2;
  return u;
}

// ---------------------------------------------------------------- end-to-end key state for a server
// What one member needs to know: the current key epoch, their own wrapped keys, and who still
// needs the current key. The server never sees the keys themselves.
function keyState(serverId, userId) {
  const s = db.prepare('SELECT key_epoch, needs_rotation FROM servers WHERE id = ?').get(serverId);
  if (!s) return null;
  const keys = db.prepare(`SELECT k.epoch, k.wrapped, k.wrapper_id, e.key_check FROM server_keys k
      JOIN server_epochs e ON e.server_id = k.server_id AND e.epoch = k.epoch
      WHERE k.server_id = ? AND k.user_id = ? ORDER BY k.epoch`).all(serverId, userId)
    .map((k) => ({ epoch: k.epoch, wrapped: k.wrapped, wrapperId: k.wrapper_id, check: k.key_check }));
  const missing = s.key_epoch
    ? db.prepare(`SELECT m.user_id FROM members m WHERE m.server_id = ? AND NOT EXISTS
        (SELECT 1 FROM server_keys k WHERE k.server_id = m.server_id AND k.user_id = m.user_id AND k.epoch = ?)`)
      .all(serverId, s.key_epoch).map((r) => r.user_id)
    : [];
  return { serverId, keyEpoch: s.key_epoch, needsRotation: !!s.needs_rotation, keys, missing };
}
function emitKeyState(serverId) {
  db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(serverId)
    .forEach((m) => io.to(`user:${m.user_id}`).emit('keys:state', keyState(serverId, m.user_id)));
}

const serializeChannel = (c) => ({ id: c.id, serverId: c.server_id, name: c.name, type: c.type, topic: c.topic, position: c.position, category: c.category, slowmode: c.slowmode || 0 });
const THEME_DEFAULT = { accent: '', banner: '', bannerCrop: null, background: { kind: 'none' }, welcome: '', roleColors: true, iconShape: 'rounded' };
const themeOf = (s) => { try { return { ...THEME_DEFAULT, ...JSON.parse(s.theme || '{}') }; } catch { return { ...THEME_DEFAULT }; } };
// What one member sees of a server: channels they can view (with their permissions), roles, emoji, theme.
function serializeServer(s, uid) {
  const myBase = perms.base(s, uid);
  const manage = (myBase & (PM.MANAGE_ROLES | PM.MANAGE_CHANNELS)) !== 0;
  const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position, created_at').all(s.id)
    .map((c) => ({ c, p: perms.channel(s, c, uid) }))
    .filter(({ p }) => p & PM.VIEW_CHANNEL)
    .map(({ c, p }) => ({
      ...serializeChannel(c), perms: p,
      overrides: manage ? db.prepare('SELECT target_type AS type, target_id AS id, allow, deny FROM channel_overrides WHERE channel_id = ?').all(c.id) : undefined,
    }));
  const mrows = db.prepare('SELECT user_id FROM members WHERE server_id = ? ORDER BY joined_at').all(s.id);
  const memberRoles = {};
  db.prepare('SELECT user_id, role_id FROM member_roles WHERE server_id = ?').all(s.id).forEach((r) => { (memberRoles[r.user_id] ||= []).push(r.role_id); });
  const roleDefs = db.prepare('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC').all(s.id)
    .map((r) => ({ id: r.id, name: r.name, color: r.color, icon: r.icon, position: r.position, permissions: r.permissions, hoist: !!r.hoist, mentionable: !!r.mentionable, everyone: r.id === s.id }));
  const emojis = db.prepare('SELECT id, name, url, animated FROM emojis WHERE server_id = ? ORDER BY name').all(s.id).map((e) => ({ ...e, animated: !!e.animated }));
  let categoryOrder = [];
  try { categoryOrder = JSON.parse(s.category_order || '[]'); } catch { /* ignore */ }
  const out = {
    id: s.id, name: s.name, icon: s.icon, ownerId: s.owner_id, kind: s.kind || 'server', channels, memberIds: mrows.map((r) => r.user_id),
    roleDefs, memberRoles, myPerms: myBase, emojis, theme: themeOf(s), description: s.description || '', categoryOrder,
  };
  if (out.kind === 'group') {
    const last = db.prepare(`SELECT m.* FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE c.server_id = ? AND m.thread_id IS NULL ORDER BY m.id DESC LIMIT 1`).get(s.id);
    out.last = last ? { id: last.id, authorId: last.author_id, channelId: last.channel_id, ciphertext: last.ciphertext, createdAt: last.created_at } : null;
    out.lastMessageAt = last ? last.created_at : s.created_at;
  }
  return out;
}
// Everyone gets their own view (private channels and permissions differ per person).
const emitServer = (serverId) => {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!row) return;
  db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(serverId)
    .forEach((m) => io.to(`user:${m.user_id}`).emit('server:update', serializeServer(row, m.user_id)));
};

function reactionsFor(ids) {
  const map = {};
  if (!ids.length) return map;
  const rows = db.prepare(`SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`).all(...ids);
  for (const r of rows) {
    const list = (map[r.message_id] ||= []);
    let entry = list.find((e) => e.emoji === r.emoji);
    if (!entry) { entry = { emoji: r.emoji, userIds: [] }; list.push(entry); }
    entry.userIds.push(r.user_id);
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
    ...(e2ee || { legacy: true, content: data.content || '', attachments: data.attachments || [] }),
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
    id: row.id, userId: row.user_a === userId ? row.user_b : row.user_a, lastMessageAt: row.last_message_at,
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
// Real client IPs: by default we trust X-Forwarded-For only when the request comes from a local/private
// address (Caddy/nginx on this machine or in Docker). Set TRUST_PROXY to override.
const TRUSTED_PROXY = process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal';
app.set('trust proxy', TRUSTED_PROXY);
app.disable('x-powered-by');
const PRIVATE_IP = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '').slice(0, 64);
// Behind a proxy (HTTPS=false), refuse plain-HTTP requests that come straight from the internet, so nobody
// can bypass the proxy's HTTPS and send login tokens unencrypted. ALLOW_DIRECT_HTTP=true turns this off.
const directGuard = (remote) => USE_HTTPS || process.env.ALLOW_DIRECT_HTTP === 'true' || PRIVATE_IP.test(String(remote || ''));
app.use((req, res, next) => {
  if (!directGuard(req.socket.remoteAddress)) return res.status(403).type('text').send('Please use the https:// address of this server.');
  next();
});
app.use(express.json({ limit: '2mb' }));
// Strict browser security policy for the app's own pages. Scripts only from this server (plus WebAssembly
// for password hashing); no plugins; can't be framed by other sites.
const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' data: blob: https:", "media-src 'self' blob: data:",
  "connect-src 'self' ws: wss:", "worker-src 'self' blob:", "frame-src 'self' blob:", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'none'", "manifest-src 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), payment=(), usb=(), microphone=(self), display-capture=(self), fullscreen=(self)');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!req.path.startsWith('/uploads/') && !req.path.startsWith('/media/')) res.setHeader('Content-Security-Policy', CSP);
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
  const quotaMb = exempt ? 0 : (row && row.upload_quota_mb != null ? row.upload_quota_mb : lim.quotaMb);
  return { ...lim, quotaMb, dailyMb: exempt ? 0 : lim.dailyMb, used: usedBytes(uid), today: dayBytes(uid), blocked: !!(row && row.uploads_blocked), exempt };
}
const fmtMb = (b) => `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`;
// Wraps multer: refuses blocked accounts, caps the size at whatever is smallest of the per-file limit,
// the space left in the person's quota and what's left of today's allowance, and records the file.
// If the request then fails, the file is removed again so it doesn't count against anyone.
function limited(kind, base, field) {
  const perFile = { file: 'fileMb', image: 'imageMb', song: 'songMb' }[kind];
  return (req, res, next) => {
    const q = quotaOf(req.userId);
    if (q.blocked) return next(new HttpError(403, 'Uploads are turned off for your account. Ask an admin if you think that\u2019s a mistake.'));
    const fileCap = q[perFile] * MB + (kind === 'file' ? MB : 0); // encrypted attachments carry a little overhead
    const quotaLeft = q.quotaMb ? q.quotaMb * MB - q.used : Infinity;
    const dayLeft = q.dailyMb ? q.dailyMb * MB - q.today : Infinity;
    if (quotaLeft <= 0) return next(new HttpError(413, `You\u2019ve used all ${q.quotaMb} MB of your storage. Delete some old files or ask an admin for more room.`, 'quota'));
    if (dayLeft <= 0) return next(new HttpError(413, `You\u2019ve reached today\u2019s upload limit (${q.dailyMb} MB per day). Try again tomorrow.`, 'quota'));
    const cap = Math.max(1, Math.floor(Math.min(fileCap, quotaLeft, dayLeft)));
    multer({ ...base, limits: { fileSize: cap, files: 1 } }).single(field)(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        if (cap >= fileCap) return next(new HttpError(413, `That file is too big. ${{ file: 'Files', image: 'Images', song: 'Songs' }[kind]} can be up to ${q[perFile]} MB.`));
        if (cap >= dayLeft) return next(new HttpError(413, `That would go over today\u2019s upload limit. You have ${fmtMb(dayLeft)} left today.`, 'quota'));
        return next(new HttpError(413, `That would go over your storage limit. You have ${fmtMb(quotaLeft)} left of ${q.quotaMb} MB.`, 'quota'));
      }
      if (err) return next(err);
      if (req.file) {
        recordFile(req.userId, req.file.filename, kind === 'file' ? 'attachment' : kind, req.file.size);
        res.on('finish', () => { if (res.statusCode >= 400) removeUpload('/uploads/' + req.file.filename); });
      }
      next();
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
// Blobs uploaded but never attached to a message (abandoned sends) are removed after a day.
setInterval(() => {
  const old = db.prepare('SELECT name FROM blobs WHERE message_id IS NULL AND created_at < ?').all(Date.now() - 24 * 3600 * 1000);
  old.forEach((b) => removeUpload('/uploads/' + b.name));
  if (old.length) db.prepare('DELETE FROM blobs WHERE message_id IS NULL AND created_at < ?').run(Date.now() - 24 * 3600 * 1000);
}, 3600 * 1000).unref();

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
    id: '/', name: INSTANCE_NAME, short_name: INSTANCE_NAME.slice(0, 12),
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
app.get('/downloads/:file', (req, res) => {
  const hit = listDownloads().find((d) => d.name === req.params.file);
  if (!hit) return res.status(404).send('Not found');
  res.download(path.join(DOWNLOADS_DIR, hit.name), hit.name);
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
  if (token) db.prepare('UPDATE sessions SET ip = ? WHERE token = ?').run(ip, token);
}
// IP bans: single addresses or IPv4 ranges (CIDR), checked on sign-up, login and live connections.
const ipBans = () => { try { return JSON.parse(getSetting('ipBans') || '[]'); } catch { return []; } };
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
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = token && db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return res.status(401).json({ error: 'Not signed in.' });
  const u = db.prepare('SELECT id, suspended_at, suspend_reason, suspended_until FROM users WHERE id = ?').get(s.user_id);
  if (!u) return res.status(401).json({ error: 'Not signed in.' });
  if (stillSuspended(u)) return res.status(403).json({ error: suspendedMsg(u), code: 'suspended' });
  if (maintenance() && !isStaff(s.user_id) && !req.path.startsWith('/config')) return res.status(503).json({ error: maintenance(), code: 'maintenance' });
  req.userId = s.user_id;
  req.token = token;
  if (!s.last_seen || Date.now() - s.last_seen > 60000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
  recordIp(s.user_id, req.ip, token);
  next();
}

const api = express.Router();
app.use('/api', api);

// ---------------------------------------------------------------- public config
// ---------------------------------------------------------------- installable app: push, manifest, service worker, downloads
const webpush = require('web-push');
let vapid = null;
try {
  const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  else if (fs.existsSync(VAPID_FILE)) vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  else { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 }); }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
} catch (e) { console.warn('Push notifications are off:', e.message); vapid = null; }

const nameOf = (uid) => { const r = getUserRow(uid); return r ? (parseProfile(r).displayName || r.username) : 'Someone'; };
// Notify people who have no Hearth window open. Message contents are end-to-end encrypted, so the
// notification only says who and where — never what.
function pushTo(userIds, payload) {
  if (!vapid) return;
  for (const uid of new Set(userIds)) {
    if ((onlineSockets.get(uid) || new Set()).size) continue;
    const row = getUserRow(uid);
    if (!row || row.status === 'dnd') continue;
    for (const sub of db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(uid)) {
      webpush.sendNotification({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys) }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' })
        .catch((err) => { if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint); });
    }
  }
}
api.get('/push/key', (req, res) => res.json({ publicKey: vapid ? vapid.publicKey : null }));
api.post('/push/subscribe', auth, (req, res) => {
  const sub = (req.body || {}).subscription || {};
  if (!vapid) fail(400, 'Push notifications are turned off on this server.');
  if (typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000) fail(400, 'Bad subscription.');
  if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') fail(400, 'Bad subscription.');
  db.prepare('INSERT OR REPLACE INTO push_subs (endpoint, user_id, keys, ua, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sub.endpoint, req.userId, JSON.stringify({ p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) }), String(req.headers['user-agent'] || '').slice(0, 300), now());
  res.json({ ok: true });
});
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
      return { name, platform: hit[1], size: fs.statSync(path.join(DOWNLOADS_DIR, name)).size, url: '/downloads/' + encodeURIComponent(name) };
    }).filter(Boolean);
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
    name: INSTANCE_NAME,
    registrationOpen: regMode() !== 'closed',
    registrationRequiresCode: regMode() === 'code',
    termsVersion: termsInfo().version || 0,
    gifsEnabled: !!gifKey(),
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
  rateLimit('params:' + req.ip, 60, 60 * 1000);
  const username = String(req.query.username || '').slice(0, 24);
  const row = db.prepare('SELECT kdf, kdf_salt FROM users WHERE username = ?').get(username);
  if (row && row.kdf === 'argon2id') return res.json({ kdf: 'argon2id', salt: row.kdf_salt });
  if (row) return res.json({ kdf: 'pbkdf2' });
  const salt = crypto.createHmac('sha256', atRestKey).update('kdf-salt:' + username.toLowerCase()).digest().subarray(0, 16).toString('base64');
  res.json({ kdf: 'argon2id', salt });
});

// Banned IPs can't sign up, log in or connect.
api.use(['/auth/register', '/auth/login'], (req, res, next) => {
  const b = ipBanned(req.ip);
  if (b) { secEvent('blocked_ip', req.ip, req.path); return res.status(403).json({ error: 'Access from your network has been blocked by this server\u2019s administrators.', code: 'ip_banned' }); }
  next();
});
api.post('/auth/register', wrap(async (req, res) => {
  rateLimit('reg:' + req.ip, 5, 60 * 60 * 1000);
  rateLimit('reg:all', 120, 60 * 60 * 1000); // slows bot floods across many IPs
  const mode = regMode();
  if (mode === 'closed') fail(403, 'Registration is closed on this server.');
  const { username, authKey, publicKey, encPrivateKey, code, kdfSalt, acceptTos } = req.body || {};
  if (mode === 'code' && (!regCode() || code !== regCode())) fail(403, 'That registration code is not right.');
  const tos = termsInfo();
  if (tos.version && +acceptTos !== tos.version) fail(400, 'Please read and accept the Terms of Service to create an account.');
  verifyCaptcha((req.body || {}).captcha, 'register');
  if (!USERNAME_RE.test(username || '')) fail(400, 'Usernames are 2–24 characters: letters, numbers, _ and . only.');
  if (!/^[0-9a-f]{64}$/.test(authKey || '')) fail(400, 'Bad auth key.');
  if (!isB64ish(publicKey, 2000) || !isB64ish(encPrivateKey, 4000)) fail(400, 'Bad key material.');
  if (!isSalt(kdfSalt)) fail(400, 'This page is out of date. Reload and try again.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'That username is taken.');
  const id = newId();
  const hash = await bcrypt.hash(authKey, 11);
  const profile = sanitizeProfile({ displayName: username });
  db.prepare(`INSERT INTO users (id, username, auth_hash, public_key, enc_private_key, profile, created_at, kdf, kdf_salt, tos_version)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'argon2id', ?, ?)`).run(id, username, hash, publicKey, encPrivateKey, JSON.stringify(profile), now(), kdfSalt, tos.version || null);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, ua, last_seen, ip) VALUES (?, ?, ?, ?, ?, ?)').run(token, id, now(), String(req.headers['user-agent'] || '').slice(0, 300), now(), cleanIp(req.ip));
  recordIp(id, req.ip, token);
  addSupportFriend(id);
  res.json({ token, user: selfUser(getUserRow(id)), encPrivateKey });
}));

api.post('/auth/login', wrap(async (req, res) => {
  rateLimit('login:' + req.ip, 20, 10 * 60 * 1000);
  const { username, authKey } = req.body || {};
  const row = typeof username === 'string' && db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Per-account limit too, so guessing one person's password from many IPs is slowed down. It doesn't
  // apply from IPs this account has signed in from before, so nobody can lock a person out by spamming.
  const knownIp = row && db.prepare('SELECT 1 FROM user_ips WHERE user_id = ? AND ip = ?').get(row.id, cleanIp(req.ip));
  if (!knownIp) rateLimit('loginuser:' + String(username || '').toLowerCase().slice(0, 40), 10, 15 * 60 * 1000);
  verifyCaptcha((req.body || {}).captcha, 'login');
  const ok = row && typeof authKey === 'string' && await bcrypt.compare(authKey, row.auth_hash);
  if (!ok) { noteAuthFailure(req.ip); secEvent('failed_login', req.ip, String(username || '').slice(0, 40)); fail(401, 'Wrong username or password.'); }
  if (maintenance() && !isStaff(row.id)) fail(503, maintenance(), 'maintenance');
  if (stillSuspended(row)) fail(403, suspendedMsg(row), 'suspended');
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, ua, last_seen, ip) VALUES (?, ?, ?, ?, ?, ?)').run(token, row.id, now(), String(req.headers['user-agent'] || '').slice(0, 300), now(), cleanIp(req.ip));
  recordIp(row.id, req.ip, token);
  res.json({ token, user: selfUser(row), encPrivateKey: row.enc_private_key });
}));

api.post('/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

api.post('/me/password', auth, wrap(async (req, res) => {
  rateLimit('pw:' + req.userId, 10, 10 * 60 * 1000);
  const { oldAuthKey, newAuthKey, encPrivateKey, salt, keepSessions } = req.body || {};
  const row = getUserRow(req.userId);
  if (!(await bcrypt.compare(oldAuthKey || '', row.auth_hash))) fail(401, 'Your current password is not right.');
  if (!/^[0-9a-f]{64}$/.test(newAuthKey || '') || !isB64ish(encPrivateKey, 4000)) fail(400, 'Bad key material.');
  if (!isSalt(salt)) fail(400, 'This page is out of date. Reload and try again.');
  db.prepare(`UPDATE users SET auth_hash = ?, enc_private_key = ?, kdf = 'argon2id', kdf_salt = ? WHERE id = ?`)
    .run(await bcrypt.hash(newAuthKey, 11), encPrivateKey, salt, req.userId);
  if (!keepSessions) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.userId, req.token);
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
  servers.forEach((s) => s.memberIds.forEach((i) => ids.add(i)));
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
  res.json({ iceServers: iceServersFor(uid), termsVersion: termsInfo().version || 0, tosAccepted: me.tos_version || 0, mediaToken: mediaToken(uid), me: selfUser(me), encPrivateKey: me.enc_private_key, encSignPrivateKey: me.enc_sign_private_key, servers, dms, relationships, users, voice, keyStates, blocked });
});

// ---------------------------------------------------------------- profile
function broadcastUser(userId) {
  const row = getUserRow(userId);
  io.except(`user:${userId}`).emit('user:update', publicUser(row));
  io.to(`user:${userId}`).emit('user:update', selfUser(row));
}

api.patch('/me/profile', auth, (req, res) => {
  requireUnlocked(req.userId);
  const row = getUserRow(req.userId);
  const profile = sanitizeProfile(req.body || {}, parseProfile(row));
  checkWords(profile.displayName, profile.pronouns, profile.bio, profile.aboutMe, profile.headline, profile.mood.text, profile.customStatus.text, profile.interests, profile.songTitle, profile.links.map((l) => l.label));
  if (!profile.displayName) profile.displayName = row.username;
  // Top friends must actually be friends.
  profile.topFriends = profile.topFriends.filter((id) => areFriends(req.userId, id));
  db.prepare('UPDATE users SET profile = ? WHERE id = ?').run(JSON.stringify(profile), req.userId);
  broadcastUser(req.userId);
  res.json(selfUser(getUserRow(req.userId)));
});

api.patch('/me/status', auth, (req, res) => {
  const status = (req.body || {}).status;
  if (!['online', 'idle', 'dnd', 'invisible'].includes(status)) fail(400, 'Unknown status.');
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.userId);
  broadcastUser(req.userId);
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
  const row = getUserRow(req.userId);
  db.prepare('UPDATE users SET song = NULL WHERE id = ?').run(req.userId);
  removeUpload(row.song);
  broadcastUser(req.userId);
  res.json(selfUser(getUserRow(req.userId)));
});
api.post('/me/media/:kind', auth, (req, res, next) => { try { requireUnlocked(req.userId); next(); } catch (e) { next(e); } }, limited('image', uploadImage, 'file'), (req, res) => {
  const col = MEDIA_KINDS[req.params.kind];
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
  const col = MEDIA_KINDS[req.params.kind];
  if (!col) fail(404, 'Unknown media type.');
  const old = getUserRow(req.userId)[col];
  db.prepare(`UPDATE users SET ${col} = NULL WHERE id = ?`).run(req.userId);
  setMediaCrop(req.userId, req.params.kind, {});
  removeUpload(old);
  broadcastUser(req.userId);
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
api.post('/servers', auth, limited('image', uploadImage, 'icon'), (req, res) => {
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
  if (body.theme && typeof body.theme === 'object') db.prepare('UPDATE servers SET theme = ? WHERE id = ?').run(JSON.stringify(cleanTheme(body.theme, themeOf(srv))), srv.id);
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
  const srv = requirePerm(req.params.id, req.userId, PM.MANAGE_SERVER);
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

api.delete('/servers/:id', auth, (req, res) => {
  const s = requireOwner(req.params.id, req.userId);
  db.prepare('SELECT id FROM channels WHERE server_id = ?').all(s.id).forEach((c) => {
    const m = voiceChannels.get(c.id);
    if (m) [...m.keys()].forEach((uid) => leaveVoice(uid, true));
  });
  removeMessageFiles(db.prepare('SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ?').all(s.id).map((r) => r.id));
  db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ?)').run(s.id);
  db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  removeUpload(s.icon);
  io.to(`server:${s.id}`).emit('server:remove', { serverId: s.id });
  io.in(`server:${s.id}`).socketsLeave(`server:${s.id}`);
  res.json({ ok: true });
});

api.post('/servers/:id/leave', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  if (s.kind === 'group' && s.owner_id === req.userId) {
    const next = db.prepare('SELECT user_id FROM members WHERE server_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1').get(s.id, req.userId);
    if (next) db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(next.user_id, s.id);
  } else if (s.owner_id === req.userId) fail(400, 'Owners cannot leave their own server. Delete it or hand it off first.');
  removeMember(s.id, req.userId);
  const left = db.prepare('SELECT COUNT(*) AS n FROM members WHERE server_id = ?').get(s.id).n;
  if (s.kind === 'group' && !left) db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
  else emitServer(s.id);
  res.json({ ok: true });
});

function removeMember(serverId, userId) {
  kickFromVoiceInServer(serverId, userId);
  db.prepare('DELETE FROM members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
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

// Give/take roles. You can only hand out roles below your own highest role.
api.put('/servers/:id/members/:uid/roles', auth, (req, res) => {
  const s = requirePerm(req.params.id, req.userId, PM.MANAGE_ROLES, 'You need the Manage Roles permission.');
  const uid = req.params.uid;
  if (!isMember(s.id, uid)) fail(404, 'That person is not in this server.');
  const myTop = perms.top(s, req.userId);
  if (uid !== req.userId && uid !== s.owner_id && perms.top(s, uid) >= myTop) fail(403, 'You can only change roles for people below you.');
  const wanted = new Set((Array.isArray((req.body || {}).roleIds) ? req.body.roleIds : []).map(String));
  const all = db.prepare('SELECT * FROM roles WHERE server_id = ? AND id != ?').all(s.id, s.id);
  const current = new Set(db.prepare('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?').all(s.id, uid).map((r) => r.role_id));
  db.transaction(() => {
    for (const r of all) {
      const has = current.has(r.id); const want = wanted.has(r.id);
      if (has === want) continue;
      if (r.position >= myTop) fail(403, `You can't assign or remove "${r.name}" — it's not below your highest role.`);
      if (want) db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(s.id, uid, r.id);
      else db.prepare('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?').run(s.id, uid, r.id);
    }
  })();
  emitServer(s.id);
  res.json({ ok: true });
});

api.post('/servers/:id/transfer', auth, (req, res) => {
  const s = requireOwner(req.params.id, req.userId);
  const to = String((req.body || {}).userId || '');
  if (!isMember(s.id, to)) fail(404, 'That person is not in this server.');
  db.prepare('UPDATE servers SET owner_id = ? WHERE id = ?').run(to, s.id);
  emitServer(s.id);
  const out = serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(s.id), req.userId);
  res.json(out);
});

// ---------------------------------------------------------------- invites
api.post('/servers/:id/invites', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  if (s.kind === 'group') fail(400, 'Add people to a group from its member list.');
  if (!can(s, req.userId, PM.CREATE_INVITE)) fail(403, 'You don\u2019t have permission to create invites.');
  const maxUses = Math.max(0, Math.min(1000, parseInt((req.body || {}).maxUses || '0', 10) || 0));
  const hours = Math.max(0, Math.min(24 * 30, parseInt((req.body || {}).expiresHours || '0', 10) || 0));
  const code = randomCode(8);
  db.prepare('INSERT INTO invites (code, server_id, creator_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, s.id, req.userId, maxUses, hours ? now() + hours * 3600000 : null, now());
  res.json({ code });
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

api.post('/invites/:code/join', auth, (req, res) => {
  const inv = validInvite(req.params.code);
  const sid = inv.server_id;
  if (db.prepare('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?').get(sid, req.userId)) fail(403, 'You are banned from this server.');
  if (!isMember(sid, req.userId)) {
    db.prepare('INSERT INTO members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(sid, req.userId, now());
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(inv.code);
    io.to(`server:${sid}`).emit('member:add', { serverId: sid, user: publicUser(getUserRow(req.userId)) });
    io.in(`user:${req.userId}`).socketsJoin(`server:${sid}`);
  }
  const server = serializeServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(sid), req.userId);
  const users = {};
  server.memberIds.forEach((id) => { users[id] = publicUser(getUserRow(id)); });
  const voice = {};
  server.channels.filter((c) => c.type === 'voice').forEach((c) => { voice[c.id] = voiceStateList(c.id); });
  io.to(`user:${req.userId}`).emit('server:add', { server, users, voice, keyState: keyState(sid, req.userId) });
  emitKeyState(sid);
  res.json({ ...server, keyState: keyState(sid, req.userId) });
});

// ---------------------------------------------------------------- server encryption keys
const isWrapped = (s) => typeof s === 'string' && s.length > 40 && s.length < 2000;

api.get('/servers/:id/keys', auth, (req, res) => {
  requireServer(req.params.id, req.userId);
  res.json(keyState(req.params.id, req.userId));
});

// Start a new key epoch. The client generated a fresh random key and wrapped it to every member.
api.post('/servers/:id/keys/rotate', auth, (req, res) => {
  const s = requireServer(req.params.id, req.userId);
  rateLimit('rotate:' + req.userId, 30, 60 * 1000);
  const { epoch, check, wraps } = req.body || {};
  if (typeof check !== 'string' || !/^[A-Za-z0-9+/=]{16,64}$/.test(check)) fail(400, 'Bad key check.');
  if (!wraps || typeof wraps !== 'object') fail(400, 'Missing wrapped keys.');
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT key_epoch FROM servers WHERE id = ?').get(s.id).key_epoch;
    if (Number(epoch) !== cur + 1) fail(409, 'Someone else just refreshed the key.', 'epoch');
    const members = db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(s.id).map((r) => r.user_id);
    const ids = Object.keys(wraps);
    if (ids.length !== members.length || !members.every((m) => isWrapped(wraps[m]))) fail(409, 'The member list changed. Try again.', 'members');
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
  const { epoch, wraps } = req.body || {};
  const cur = db.prepare('SELECT key_epoch FROM servers WHERE id = ?').get(s.id).key_epoch;
  if (!cur || Number(epoch) !== cur) fail(409, 'That key is out of date.', 'epoch');
  if (!db.prepare('SELECT 1 FROM server_keys WHERE server_id = ? AND epoch = ? AND user_id = ?').get(s.id, cur, req.userId)) fail(403, 'You do not have this key.');
  const ins = db.prepare('INSERT OR IGNORE INTO server_keys (server_id, epoch, user_id, wrapped, wrapper_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const [uid, w] of Object.entries(wraps || {}).slice(0, 200)) {
    if (isMember(s.id, uid) && isWrapped(w)) n += ins.run(s.id, cur, uid, w, req.userId, now()).changes;
  }
  if (n) emitKeyState(s.id);
  res.json({ shared: n });
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

api.patch('/channels/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!c) fail(404, 'Channel not found.');
  requireAdmin(c.server_id, req.userId);
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
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!c) fail(404, 'Channel not found.');
  requireAdmin(c.server_id, req.userId);
  const m = voiceChannels.get(c.id);
  if (m) [...m.keys()].forEach((uid) => leaveVoice(uid, true));
  removeMessageFiles(db.prepare('SELECT id FROM messages WHERE channel_id = ?').all(c.id).map((r) => r.id));
  db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').run(c.id);
  db.prepare('DELETE FROM channels WHERE id = ?').run(c.id);
  emitServer(c.server_id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- channel messages
const MAX_MESSAGE = 4000;

// Page through a conversation: newest (default), ?before=id (older), ?after=id (newer) or ?around=id (jump).
function pageRows(table, col, containerId, q, extra = '') {
  const limit = Math.min(100, parseInt(q.limit || '50', 10) || 50);
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
  const mentioned = Array.isArray(mentions) ? mentions.slice(0, 50).map(String).filter((u) => members.includes(u)) : [];
  pushTo(mentioned, { title: `${nameOf(senderId)} mentioned you`, body: where, tag: 'c:' + c.id, url });
  const replyAuthor = replyTo && (db.prepare('SELECT author_id FROM messages WHERE id = ?').get(replyTo) || {}).author_id;
  const rootAuthor = threadId && (db.prepare('SELECT author_id FROM messages WHERE id = ?').get(threadId) || {}).author_id;
  pushTo([replyAuthor, rootAuthor].filter((u) => u && u !== senderId && !mentioned.includes(u) && members.includes(u)),
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

// Channel messages are end-to-end encrypted by the sender. The server stores ciphertext only.
api.post('/channels/:id/messages', auth, (req, res) => {
  const c = requireChannel(req.params.id, req.userId);
  if (c.type !== 'text') fail(400, 'You can only send messages in text channels.');
  rateLimit('msg:' + req.userId, 30, 10000);
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
  const ids = [m.id, ...db.prepare('SELECT id FROM messages WHERE thread_id = ?').all(m.id).map((r) => r.id)];
  removeMessageFiles(ids);
  const q = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM reactions WHERE message_id IN (${q})`).run(...ids);
  db.prepare(`DELETE FROM messages WHERE id IN (${q})`).run(...ids);
  toChannel(c).emit('message:delete', { id: m.id, channelId: c.id, threadId: m.thread_id || null });
  if (m.thread_id) toChannel(c).emit('thread:update', { rootId: m.thread_id, channelId: c.id, threadCount: 0, ...threadInfo({ id: m.thread_id }) });
  res.json({ ok: true });
});

api.get('/messages/:id/thread', auth, (req, res) => {
  const root = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!root || root.thread_id) fail(404, 'Thread not found.');
  const c = requireChannel(root.channel_id, req.userId);
  const rows = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').all(root.id);
  const reactions = reactionsFor([root.id, ...rows.map((r) => r.id)]);
  res.json({ root: serializeMessage(root, c, reactions), messages: rows.map((r) => serializeMessage(r, c, reactions)) });
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
  rateLimit('msg:' + req.userId, 30, 10000);
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
  removeMessageFiles([m.id]);
  db.prepare('DELETE FROM reactions WHERE message_id = ?').run(m.id);
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
  db.prepare('UPDATE roles SET name = ?, color = ?, icon = ?, permissions = ?, hoist = ?, mentionable = ? WHERE id = ?').run(
    name, everyone ? '' : b.color !== undefined ? cleanColor(b.color) : r.color, everyone ? '' : b.icon !== undefined ? cleanIcon(b.icon) : r.icon,
    permissions, everyone ? 0 : b.hoist !== undefined ? (b.hoist ? 1 : 0) : r.hoist, everyone ? 0 : b.mentionable !== undefined ? (b.mentionable ? 1 : 0) : r.mentionable, r.id);
  emitServer(s.id);
  res.json({ ok: true });
});
api.delete('/roles/:id', auth, (req, res) => {
  const { r, s } = requireManageableRole(req.params.id, req.userId);
  if (r.id === s.id) fail(400, 'The @everyone role can\u2019t be deleted.');
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
// Per-channel overrides: [{ type: 'role'|'member', id, allow, deny }]
api.put('/channels/:id/overrides', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!c) fail(404, 'Channel not found.');
  const s = requirePerm(c.server_id, req.userId, PM.MANAGE_ROLES, 'You need the Manage Roles permission.');
  const list = Array.isArray((req.body || {}).overrides) ? req.body.overrides.slice(0, 100) : [];
  const roleIds = new Set(db.prepare('SELECT id FROM roles WHERE server_id = ?').all(s.id).map((r) => r.id));
  const mine = perms.base(s, req.userId);
  db.transaction(() => {
    db.prepare('DELETE FROM channel_overrides WHERE channel_id = ?').run(c.id);
    for (const o of list) {
      const type = o.type === 'member' ? 'member' : 'role';
      const id = String(o.id || '');
      if (type === 'role' ? !roleIds.has(id) : !isMember(s.id, id)) continue;
      const allow = (parseInt(o.allow, 10) || 0) & CHANNEL_SCOPED & mine;
      const deny = (parseInt(o.deny, 10) || 0) & CHANNEL_SCOPED & ~allow;
      if (allow || deny) db.prepare('INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)').run(c.id, type, id, allow, deny);
    }
  })();
  // Anyone who just lost access leaves the voice channel.
  for (const [uid] of voiceChannels.get(c.id) || []) if (!(perms.channel(s, c, uid) & PM.CONNECT)) leaveVoice(uid, true);
  emitServer(s.id);
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
function addEmoji(s, name, url, animated, userId) {
  if (name.length < 2) fail(400, 'Emoji names need at least 2 letters, numbers or underscores.');
  if (db.prepare('SELECT COUNT(*) AS n FROM emojis WHERE server_id = ?').get(s.id).n >= 200) fail(400, 'A server can have up to 200 emoji.');
  if (db.prepare('SELECT 1 FROM emojis WHERE server_id = ? AND name = ?').get(s.id, name)) fail(409, `There's already an emoji called :${name}:.`);
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
  const pickR = await gifForEmoji(gid);
  if (!pickR) fail(400, 'That GIF is too big to use as an emoji. Try another one.');
  const media = new URL(pickR.url);
  if (!(MEDIA_HOSTS.test(media.hostname) || EXTRA_MEDIA_HOSTS.includes(media.host))) fail(400, 'Unexpected GIF location.');
  const r = await fetch(media);
  if (!r.ok) fail(502, 'Couldn\u2019t download that GIF from GIPHY.');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > EMOJI_MAX) fail(400, 'That GIF is too big to use as an emoji.');
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
const canAddToGroup = (adder, uid) => uid !== adder && getUserRow(uid) && !isBlocked(adder, uid) && (areFriends(adder, uid) || sharesServer(adder, uid));
api.post('/groups', auth, (req, res) => {
  const ids = [...new Set(((req.body || {}).userIds || []).map(String))].filter((u) => u !== req.userId);
  if (!ids.length) fail(400, 'Pick at least one person.');
  if (ids.length > 9) fail(400, 'Group DMs can have up to 10 people.');
  ids.forEach((u) => { if (!canAddToGroup(req.userId, u)) fail(403, 'You can add friends and people who share a server with you.'); });
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
  if (db.prepare('SELECT COUNT(*) AS n FROM members WHERE server_id = ?').get(s.id).n >= 10) fail(400, 'Group DMs can have up to 10 people.');
  if (!canAddToGroup(req.userId, uid)) fail(403, 'You can add friends and people who share a server with you.');
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
api.patch('/me/privacy', auth, (req, res) => {
  const row = getUserRow(req.userId);
  const p = privacyOf(row);
  const b = req.body || {};
  if (['everyone', 'friends'].includes(b.dms)) p.dms = b.dms;
  if (['everyone', 'mutual', 'nobody'].includes(b.friendRequests)) p.friendRequests = b.friendRequests;
  db.prepare('UPDATE users SET privacy = ? WHERE id = ?').run(JSON.stringify(p), req.userId);
  res.json(p);
});
const sessionId = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
api.get('/me/sessions', auth, (req, res) => {
  res.json(db.prepare('SELECT token, created_at, last_seen, ua FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(req.userId)
    .map((r) => ({ id: sessionId(r.token), current: r.token === req.token, createdAt: r.created_at, lastSeen: r.last_seen || r.created_at, ua: r.ua || '' })));
});
api.delete('/me/sessions/:id', auth, (req, res) => {
  const rows = db.prepare('SELECT token FROM sessions WHERE user_id = ?').all(req.userId);
  const hit = rows.find((r) => sessionId(r.token) === req.params.id);
  if (!hit) fail(404, 'Session not found.');
  if (hit.token === req.token) fail(400, 'Use Log out to end this session.');
  db.prepare('DELETE FROM sessions WHERE token = ?').run(hit.token);
  io.in(`user:${req.userId}`).fetchSockets().then((socks) => socks.filter((x) => x.data.token === hit.token).forEach((x) => x.disconnect(true))).catch(() => {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- instance settings + GIPHY
// Instance staff, highest first:
//   owner      one person: the first account (or the first ADMIN_USERS name that exists) until handed over.
//              Only the owner can give or take away staff roles, and hand over ownership.
//   admin      the whole admin dashboard and Settings → Instance. ADMIN_USERS names are always admins.
//   moderator  reports, users (suspend, sign out, reset profile, notes), who's online and the audit log.
// Staff can only act on people ranked below them.
const getSetting = (k) => (db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(k) || {}).value;
const setSetting = (k, v) => (v === null || v === undefined
  ? db.prepare('DELETE FROM instance_settings WHERE key = ?').run(k)
  : db.prepare('INSERT OR REPLACE INTO instance_settings (key, value) VALUES (?, ?)').run(k, String(v)));
const firstAccount = () => (db.prepare('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1').get() || {}).id;
const STAFF_RANK = { moderator: 1, admin: 2, owner: 3 };
const envAdmins = () => (process.env.ADMIN_USERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
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
function ownerId() {
  const set = getSetting('owner');
  if (set && getUserRow(set)) return set;
  for (const n of envAdmins()) { const r = db.prepare('SELECT id FROM users WHERE lower(username) = ?').get(n); if (r) return r.id; }
  return firstAccount();
}
function staffRole(uid) {
  const row = uid && getUserRow(uid);
  if (!row) return null;
  if (ownerId() === uid) return 'owner';
  if (envAdmins().includes(row.username.toLowerCase())) return 'admin';
  const r = staffRoles()[uid];
  return STAFF_RANK[r] && r !== 'owner' ? r : null;
}
const staffRank = (uid) => STAFF_RANK[staffRole(uid)] || 0;
const isStaff = (uid) => staffRank(uid) >= 1;
function isInstanceAdmin(uid) { return staffRank(uid) >= 2; }
const requireInstanceAdmin = (uid) => { if (!isInstanceAdmin(uid)) fail(403, 'Only the server administrator can change this.'); };
// The key saved in the app wins over .env, so the admin never has to edit files.
const giphyKey = () => getSetting('giphyKey') || GIPHY_API_KEY;
const giphyRating = () => (['g', 'pg', 'pg-13', 'r'].includes(getSetting('giphyRating')) ? getSetting('giphyRating') : 'pg-13');
const gifProxyOn = () => (getSetting('gifProxy') ?? (process.env.GIF_PROXY || 'true')) !== 'false';
const GIPHY_API = process.env.GIPHY_API_BASE || 'https://api.giphy.com';

// GIF providers. KLIPY (free, unlimited production keys; same API shape as the retired Tenor) is the
// default; GIPHY is still supported. Results are cached and shared by everyone, so popular searches,
// trending and categories cost one API call per 15–30 minutes instead of one per person.
const klipyKey = () => getSetting('klipyKey') || process.env.KLIPY_API_KEY || '';
const gifProvider = () => {
  const p = getSetting('gifProvider');
  if (p === 'klipy' || p === 'giphy') return p;
  return klipyKey() ? 'klipy' : giphyKey() ? 'giphy' : 'klipy';
};
const gifKey = (provider = gifProvider()) => (provider === 'klipy' ? klipyKey() : giphyKey());
const KLIPY_API = process.env.KLIPY_API_BASE || 'https://api.klipy.com';
const gifCache = new Map(); // key -> { at, ttl, value }
async function cachedGif(key, ttlMs, fetcher) {
  const hit = gifCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = await fetcher();
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
    if (r.status === 429) fail(503, `${name}\u2019s hourly limit was reached. Request a free production key in ${name}\u2019s dashboard to remove the limit.`);
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
  if (!gifKey()) fail(404, 'GIF search isn\u2019t set up yet. The server administrator can add a free KLIPY key in Settings \u2192 Instance.');
  rateLimit('gif:' + req.userId, 90, 60000);
  const q = String(req.query.q || '').trim().slice(0, 100);
  const type = req.query.type === 'stickers' ? 'stickers' : 'gifs';
  res.json(await gifSearch({ q, type, pos: String(req.query.offset || '').slice(0, 200) }));
}));
api.get('/gifs/categories', auth, wrap(async (req, res) => {
  if (!gifKey()) fail(404, 'GIF search isn\u2019t set up yet.');
  res.json(await gifCategories());
}));

// GIF privacy proxy: viewers load GIPHY media through this server, so GIPHY never sees their IP.
// Links carry a short-lived signed token (images can't send login headers), and only GIPHY's media
// hosts are allowed, so this can't be used as an open proxy.
const MEDIA_HOSTS = /^(media\d*\.giphy\.com|i\.giphy\.com|static\.klipy\.com|static\.klipy\.co|media\.klipy\.com)$/i;
const EXTRA_MEDIA_HOSTS = (process.env.GIF_PROXY_EXTRA_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean);
function mediaToken(uid) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const sig = crypto.createHmac('sha256', atRestKey).update(`media|${uid}|${exp}`).digest('base64url').slice(0, 22);
  return `${uid}.${exp}.${sig}`;
}
function checkMediaToken(t) {
  const [uid, exp, sig] = String(t || '').split('.');
  if (!uid || !exp || !sig || +exp < Date.now() / 1000) return false;
  const good = crypto.createHmac('sha256', atRestKey).update(`media|${uid}|${exp}`).digest('base64url').slice(0, 22);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) && !!getUserRow(uid);
}
app.get('/media/gif', wrap(async (req, res) => {
  if (!gifProxyOn()) return res.status(404).end();
  if (!checkMediaToken(req.query.t)) return res.status(403).end();
  let u;
  try { u = new URL(String(req.query.u || '')); } catch { return res.status(400).end(); }
  if (!(u.protocol === 'https:' && MEDIA_HOSTS.test(u.hostname)) && !EXTRA_MEDIA_HOSTS.includes(u.host)) return res.status(400).end();
  rateLimit('gifmedia:' + req.ip, 600, 60000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'Hearth' } });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^(image|video)\//.test(type)) return res.status(502).end();
    const len = +(r.headers.get('content-length') || 0);
    if (len > 20 * 1024 * 1024) return res.status(413).end();
    res.setHeader('Content-Type', type);
    if (len) res.setHeader('Content-Length', String(len));
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    const { Readable } = require('stream');
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch { if (!res.headersSent) res.status(502).end(); } finally { clearTimeout(timer); }
}));

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
  if (b.giphyKey !== undefined) setSetting('giphyKey', String(b.giphyKey || '').trim().slice(0, 100) || null);
  if (b.klipyKey !== undefined) setSetting('klipyKey', String(b.klipyKey || '').trim().slice(0, 200) || null);
  if (b.gifProvider === 'klipy' || b.gifProvider === 'giphy') { setSetting('gifProvider', b.gifProvider); gifCache.clear(); }
  if (b.giphyRating !== undefined && ['g', 'pg', 'pg-13', 'r'].includes(b.giphyRating)) setSetting('giphyRating', b.giphyRating);
  if (b.gifProxy !== undefined) setSetting('gifProxy', b.gifProxy ? 'true' : 'false');
  io.emit('config:update', { gifsEnabled: !!gifKey(), gifProvider: gifProvider(), gifProxy: gifProxyOn() });
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
// (valid 12 hours), so the relay can't be used by outsiders. Set up with scripts/setup-turn.sh.
const turnUrls = () => String(getSetting('turnUrls') || process.env.TURN_URL || '').split(',').map((x) => x.trim()).filter(Boolean);
const turnSecret = () => getSetting('turnSecret') || process.env.TURN_SECRET || '';
function iceServersFor(uid) {
  const list = [iceServers[0]];
  const urls = turnUrls();
  if (urls.length && turnSecret()) {
    const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${uid}`;
    const credential = crypto.createHmac('sha1', turnSecret()).update(username).digest('base64');
    list.push({ urls, username, credential });
  } else if (urls.length && process.env.TURN_USERNAME) {
    list.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL || '' });
  }
  return list;
}
api.get('/ice', auth, (req, res) => res.json(iceServersFor(req.userId)));
api.get('/admin/turn', auth, (req, res) => {
  requireInstanceAdmin(req.userId);
  res.json({ urls: turnUrls(), secretSet: !!turnSecret(), source: getSetting('turnUrls') ? 'app' : process.env.TURN_URL ? 'env' : null });
});
api.put('/admin/turn', auth, (req, res) => {
  requireInstanceAdmin(req.userId);
  const b = req.body || {};
  if (b.urls !== undefined) setSetting('turnUrls', String(b.urls || '').split(/[\s,]+/).filter((u) => /^turns?:/.test(u)).slice(0, 6).join(',') || null);
  if (b.secret !== undefined) setSetting('turnSecret', String(b.secret || '').trim().slice(0, 200) || null);
  res.json({ ok: true, urls: turnUrls(), secretSet: !!turnSecret() });
});

// ---------------------------------------------------------------- captcha (self-hosted proof of work)
// The browser must find a number that, hashed together with a random challenge, starts with N zero bits.
// That takes a person's browser well under a second, but makes every bot attempt cost real computing time.
// Challenges are signed (can't be forged or made easier), single-use, and expire after 5 minutes.
// IPs that keep failing logins get harder puzzles automatically. No third parties, no tracking.
const CAPTCHA_BASE = 18;
const CAPTCHA_MAX = 24;
const captchaFails = new Map(); // ip -> { n, at }
const usedCaptchas = new Map(); // salt -> expires
setInterval(() => {
  const t = Date.now();
  for (const [k, exp] of usedCaptchas) if (exp < t) usedCaptchas.delete(k);
  for (const [k, f] of captchaFails) if (t - f.at > 3600000) captchaFails.delete(k);
}, 60000).unref();
const captchaMode = (purpose) => getSetting(purpose === 'register' ? 'captchaRegister' : 'captchaLogin') || 'on';
function captchaDifficulty(ip) {
  const f = captchaFails.get(ip);
  const n = f && Date.now() - f.at < 3600000 ? f.n : 0;
  return Math.min(CAPTCHA_MAX, CAPTCHA_BASE + Math.floor(n / 3));
}
function noteAuthFailure(ip) {
  ip = cleanIp(ip);
  const f = captchaFails.get(ip) || { n: 0, at: 0 };
  f.n++; f.at = Date.now();
  captchaFails.set(ip, f);
}
const captchaSig = (salt, d, exp, purpose) => crypto.createHmac('sha256', atRestKey).update(`captcha|${salt}|${d}|${exp}|${purpose}`).digest('hex');
api.get('/captcha', (req, res) => {
  rateLimit('captcha:' + req.ip, 60, 10 * 60 * 1000);
  const purpose = req.query.purpose === 'register' ? 'register' : 'login';
  if (captchaMode(purpose) === 'off') return res.json({ required: false });
  const salt = crypto.randomBytes(16).toString('hex');
  const difficulty = captchaDifficulty(cleanIp(req.ip));
  const expires = now() + 5 * 60 * 1000;
  res.json({ required: true, salt, difficulty, expires, purpose, sig: captchaSig(salt, difficulty, expires, purpose) });
});
function zeroBits(buf) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}
function verifyCaptcha(c, purpose) {
  if (captchaMode(purpose) === 'off') return;
  const bad = (msg) => fail(400, msg, 'captcha');
  if (!c || typeof c !== 'object') bad('Please complete the \u201cI\u2019m not a robot\u201d check.');
  const { salt, difficulty, expires, sig, nonce } = c;
  if (!/^[0-9a-f]{32}$/.test(String(salt)) || !Number.isInteger(difficulty) || difficulty < CAPTCHA_BASE || difficulty > CAPTCHA_MAX
    || !Number.isInteger(nonce) || nonce < 0 || typeof sig !== 'string' || sig.length !== 64) bad('The robot check didn\u2019t work. Please try again.');
  const good = captchaSig(salt, difficulty, expires, purpose);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) bad('The robot check didn\u2019t work. Please try again.');
  if (+expires < now()) bad('The robot check expired. Please try again.');
  if (usedCaptchas.has(salt)) bad('That robot check was already used. Please try again.');
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
function socketIp(socket) {
  const remote = socket.handshake.address || (socket.request && socket.request.socket.remoteAddress);
  if (PRIVATE_IP.test(String(remote || ''))) {
    const xff = String(socket.handshake.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (let i = xff.length - 1; i >= 0; i--) if (!PRIVATE_IP.test(xff[i])) return cleanIp(xff[i]);
  }
  return cleanIp(remote);
}
function adminLog(req, action, target, detail = '') {
  db.prepare('INSERT INTO admin_log (admin_id, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.userId, action, target || null, String(detail).slice(0, 1000), cleanIp(req.ip), now());
}
function suspendUser(uid, reason, hours = 0) {
  const until = hours > 0 ? now() + hours * 3600000 : null;
  db.prepare('UPDATE users SET suspended_at = ?, suspend_reason = ?, suspended_until = ? WHERE id = ?').run(now(), String(reason || '').slice(0, 300), until, uid);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
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
const ownerOnly = (req, res, next) => (staffRole(req.userId) === 'owner' ? next() : next(new HttpError(403, 'Only the owner can change staff roles.')));
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
    regMode: regMode(), series,
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
    storage: quotaOf(r.id), quotaOverride: r.upload_quota_mb, profileLocked: !!r.profile_locked,
    commentsWritten: db.prepare('SELECT COUNT(*) n FROM profile_comments WHERE author_id = ?').get(r.id).n,
    notes: db.prepare('SELECT id, author_id, text, created_at FROM staff_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(r.id)
      .map((n) => ({ id: n.id, text: n.text, createdAt: n.created_at, author: brief(n.author_id), mine: n.author_id === req.userId })),
    sessions: db.prepare('SELECT ua, ip, created_at AS createdAt, last_seen AS lastSeen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(r.id),
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
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
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
api.patch('/admin/reports/:id', auth, staffOnly, (req, res) => {
  const b = req.body || {};
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r) fail(404, 'Report not found.');
  const status = ['open', 'reviewing', 'resolved', 'dismissed'].includes(b.status) ? b.status : r.status;
  db.prepare('UPDATE reports SET status = ?, resolution = ?, handled_by = ?, handled_at = ? WHERE id = ?').run(status, String(b.resolution ?? r.resolution).slice(0, 1000), req.userId, now(), r.id);
  adminLog(req, 'report_' + status, r.id, b.resolution || '');
  res.json({ ok: true });
});
// Remove a reported message (or any message) for everyone.
api.delete('/admin/messages/:id', auth, staffOnly, (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (m) {
    const c = db.prepare('SELECT * FROM channels WHERE id = ?').get(m.channel_id);
    const ids = [m.id, ...db.prepare('SELECT id FROM messages WHERE thread_id = ?').all(m.id).map((x) => x.id)];
    removeMessageFiles(ids);
    const q = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM reactions WHERE message_id IN (${q})`).run(...ids);
    db.prepare(`DELETE FROM messages WHERE id IN (${q})`).run(...ids);
    if (c) toChannel(c).emit('message:delete', { id: m.id, channelId: c.id, threadId: m.thread_id || null });
  } else {
    const d = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
    if (!d) fail(404, 'Message already gone.');
    const dm = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(d.dm_id);
    removeMessageFiles([d.id]);
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(d.id);
    db.prepare('DELETE FROM dm_messages WHERE id = ?').run(d.id);
    if (dm) io.to([`user:${dm.user_a}`, `user:${dm.user_b}`]).emit('dm:delete', { id: d.id, dmId: dm.id });
  }
  adminLog(req, 'delete_message', req.params.id);
  res.json({ ok: true });
});
// Staff roles. Everyone on staff can see the team; only the owner can change it.
function staffList() {
  const ids = new Set([ownerId(), ...Object.keys(staffRoles())]);
  envAdmins().forEach((n) => { const r = db.prepare('SELECT id FROM users WHERE lower(username) = ?').get(n); if (r) ids.add(r.id); });
  return [...ids].filter((id) => id && staffRole(id)).map((id) => ({ ...brief(id), role: staffRole(id), fromEnv: envAdmins().includes((getUserRow(id) || {}).username?.toLowerCase()) && staffRole(id) !== 'owner' }))
    .sort((x, y) => STAFF_RANK[y.role] - STAFF_RANK[x.role] || x.username.localeCompare(y.username));
}
function staffChanged(uid) {
  if (isStaff(uid)) io.in(`user:${uid}`).socketsJoin('admins'); else io.in(`user:${uid}`).socketsLeave('admins');
  broadcastUser(uid); // their app shows or hides the dashboard right away
}
api.get('/admin/staff', auth, staffOnly, (req, res) => res.json({ staff: staffList(), me: staffRole(req.userId) }));
// Give someone a role, change it, or take it away (role: 'admin' | 'moderator' | null).
api.put('/admin/staff', auth, ownerOnly, (req, res) => {
  const b = req.body || {};
  const row = b.userId ? getUserRow(String(b.userId)) : db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(String(b.username || '').trim().replace(/^@/, '').toLowerCase());
  if (!row) fail(404, 'No account with that username.');
  if (row.id === ownerId()) fail(400, 'You\u2019re the owner. To step down, hand ownership to someone else first.');
  const role = b.role === 'admin' || b.role === 'moderator' ? b.role : null;
  if (!role && envAdmins().includes(row.username.toLowerCase())) fail(400, `${row.username} is an admin through ADMIN_USERS in the server's .env file. Remove the name there and restart to take it away.`);
  const roles = staffRoles();
  if (role) roles[row.id] = role; else delete roles[row.id];
  saveStaffRoles(roles);
  staffChanged(row.id);
  adminLog(req, role ? `role_${role}` : 'role_removed', row.id, row.username);
  res.json({ staff: staffList(), me: staffRole(req.userId) });
});
// Hand the whole instance to someone else. They become owner; the old owner stays on as an admin.
api.post('/admin/owner', auth, ownerOnly, (req, res) => {
  const row = getUserRow(String((req.body || {}).userId || ''));
  if (!row) fail(404, 'User not found.');
  if (row.id === req.userId) fail(400, 'You already own this server.');
  if (row.suspended_at) fail(400, 'Unsuspend them first.');
  const roles = staffRoles();
  delete roles[row.id];
  roles[req.userId] = 'admin';
  saveStaffRoles(roles);
  setSetting('owner', row.id);
  staffChanged(row.id); staffChanged(req.userId);
  adminLog(req, 'ownership_transferred', row.id, row.username);
  res.json({ ok: true });
});
// IP bans
api.get('/admin/ip-bans', auth, adminOnly, (req, res) => res.json(ipBans()));
api.post('/admin/ip-bans', auth, adminOnly, (req, res) => {
  const ip = String((req.body || {}).ip || '').trim();
  if (!/^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-f:]{3,39})$/i.test(ip)) fail(400, 'Enter an IP address like 203.0.113.7 or a range like 203.0.113.0/24.');
  if (ipBanned(req.ip) || (ip.includes('/') ? false : ip === cleanIp(req.ip))) fail(400, 'That would block your own connection.');
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
api.delete('/admin/servers/:id', auth, adminOnly, (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!srv) fail(404, 'Server not found.');
  const memberIds = db.prepare('SELECT user_id FROM members WHERE server_id = ?').all(srv.id).map((r) => r.user_id);
  const ids = db.prepare('SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ?').all(srv.id).map((r) => r.id);
  if (ids.length) removeMessageFiles(ids);
  removeUpload(srv.icon);
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
  const keep = new Set(db.prepare('SELECT DISTINCT user_id FROM sessions').all().map((r) => r.user_id).filter((id) => isStaff(id)));
  const victims = db.prepare('SELECT DISTINCT user_id FROM sessions').all().map((r) => r.user_id).filter((id) => !keep.has(id));
  const del = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  db.transaction(() => victims.forEach((id) => del.run(id)))();
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
  res.json(db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 200').all().map((r) => ({ ...r, admin: brief(r.admin_id) })));
});
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
  if (viewerId === row.id) return true;
  if (page.comments === 'off' || isBlocked(viewerId, row.id)) return false;
  return page.comments === 'everyone' ? true : areFriends(viewerId, row.id);
}
const commentOut = (c) => ({ id: c.id, text: c.text, createdAt: c.created_at, author: publicUser(getUserRow(c.author_id)) });
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
    page, pageBg: row.page_bg || null, views,
    friendCount: db.prepare("SELECT COUNT(*) n FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)").get(row.id, row.id).n,
    topFriends: prof.topFriends.map((id) => publicUser(getUserRow(id))).filter(Boolean),
    isFriend: areFriends(req.userId, row.id),
    lastSeen: row.last_seen_at || null,
    comments: blocked ? [] : db.prepare('SELECT * FROM profile_comments WHERE profile_id = ? ORDER BY created_at DESC LIMIT 100').all(row.id).map(commentOut),
    commentCount: db.prepare('SELECT COUNT(*) n FROM profile_comments WHERE profile_id = ?').get(row.id).n,
    canComment: canCommentOn(req.userId, row, page),
    locked: !!row.profile_locked,
  });
});
api.put('/me/page', auth, (req, res) => {
  requireUnlocked(req.userId);
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

// ---------------------------------------------------------------- errors + SPA fallback
api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Files can be up to ${MAX_UPLOAD_MB} MB.` : err.message;
    return res.status(400).json({ error: msg });
  }
  const status = err.status || 500;
  const expected = err instanceof HttpError; // our own, user-facing errors keep their message
  if (!expected) console.error(err);
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
function leaveVoice(userId, notifyUser = false) {
  const channelId = userVoice.get(userId);
  if (!channelId) return;
  const m = voiceChannels.get(channelId);
  const state = m && m.get(userId);
  if (m) { m.delete(userId); if (!m.size) voiceChannels.delete(channelId); }
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

function setupSockets(server) {
  io = new Server(server, { pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 1e6, allowRequest: (req, cb) => cb(null, directGuard(req.socket.remoteAddress)) });

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const s = token && db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!s) return next(new Error('unauthorized'));
    const u = db.prepare('SELECT id, suspended_at, suspended_until FROM users WHERE id = ?').get(s.user_id);
    if (!u || stillSuspended(u)) return next(new Error('unauthorized'));
    if (ipBanned(socketIp(socket)) && !isStaff(s.user_id)) { secEvent('blocked_ip', socketIp(socket), 'connection'); return next(new Error('unauthorized')); }
    if (maintenance() && !isStaff(s.user_id)) return next(new Error('maintenance'));
    socket.userId = s.user_id;
    socket.data.token = token;
    socket.data.ip = socketIp(socket);
    socket.data.since = Date.now();
    socket.data.ua = String(socket.handshake.headers['user-agent'] || '').slice(0, 200);
    recordIp(s.user_id, socket.data.ip, token);
    next();
  });

  io.on('connection', (socket) => {
    const uid = socket.userId;
    // Flood protection: at most 40 events per 4 seconds per connection; persistent flooding disconnects.
    let bucket = 40; let strikes = 0;
    const refill = setInterval(() => { bucket = Math.min(40, bucket + 10); }, 1000);
    socket.on('disconnect', () => clearInterval(refill));
    socket.use((packet, next) => {
      if (bucket > 0) { bucket--; return next(); }
      if (++strikes > 50) socket.disconnect(true);
      return next(new Error('Slow down.'));
    });
    socket.join(`user:${uid}`);
    if (isStaff(uid)) socket.join('admins');
    db.prepare('SELECT server_id FROM members WHERE user_id = ?').all(uid).forEach((r) => socket.join(`server:${r.server_id}`));

    const wasOnline = isOnline(uid);
    if (!onlineSockets.has(uid)) onlineSockets.set(uid, new Set());
    onlineSockets.get(uid).add(socket.id);
    if (!wasOnline) broadcastUser(uid);

    const guard = (fn) => (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
      try { cb(fn(...args) || { ok: true }); } catch (e) { cb({ error: e.message || 'Error' }); }
    };

    socket.on('typing', guard((p = {}) => {
      if (p.channelId) {
        const c = requireChannel(String(p.channelId), uid);
        toChannel(c, socket).emit('typing', { channelId: c.id, userId: uid });
      } else if (p.dmId) {
        const d = requireDm(String(p.dmId), uid);
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
      m.set(uid, { socketId: socket.id, muted: !!p.muted, deafened: !!p.deafened, video: false, screen: false });
      userVoice.set(uid, c.id);
      socket.join(`voice:${c.id}`);
      emitVoiceState(c.id);
      // First one in a DM or group call: ring everyone else (and push-notify them if their app is closed).
      if (!peers.length) {
        const ring = callees(c.id, uid);
        const d = dmOfRoom(c.id);
        const ch = !d && db.prepare('SELECT * FROM channels WHERE id = ?').get(c.id);
        ring.forEach((u) => io.to(`user:${u}`).emit('call:ring', { room: c.id, dmId: d ? d.id : null, serverId: ch ? ch.server_id : null, from: uid, video: !!p.video }));
        if (ring.length) pushTo(ring, { title: nameOf(uid), body: p.video ? 'is video calling you' : 'is calling you', tag: 'call:' + c.id, url: '/' });
      }
      return { ok: true, peers, canSpeak: !!(vp & PM.SPEAK) };
    }));

    socket.on('voice:signal', guard((p = {}) => {
      const ch = userVoice.get(uid);
      const m = ch && voiceChannels.get(ch);
      if (!m || m.get(uid)?.socketId !== socket.id) fail(400, 'You are not in voice.');
      const target = [...m.values()].find((s) => s.socketId === p.to);
      if (!target) fail(404, 'Peer left.');
      io.to(p.to).emit('voice:signal', { from: socket.id, userId: uid, data: p.data });
    }));

    socket.on('voice:update', guard((p = {}) => {
      const ch = userVoice.get(uid);
      const s = ch && voiceChannels.get(ch)?.get(uid);
      if (!s || s.socketId !== socket.id) return;
      s.muted = !!p.muted;
      s.deafened = !!p.deafened;
      if (p.video !== undefined) s.video = !!p.video;
      if (p.screen !== undefined) s.screen = !!p.screen;
      emitVoiceState(ch);
    }));

    // Declining a call: tell whoever is calling, and stop this person's other devices ringing.
    socket.on('call:decline', guard((p = {}) => {
      const room = String(p.room || '');
      const d = dmOfRoom(room);
      if (d && d.user_a !== uid && d.user_b !== uid) fail(403, 'Not your call.');
      const m = voiceChannels.get(room);
      if (m) for (const [u] of m) io.to(`user:${u}`).emit('call:declined', { room, userId: uid });
      io.to(`user:${uid}`).emit('call:end', { room });
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
      if (!isOnline(uid)) broadcastUser(uid);
    });
  });
}

(async () => {
  let server;
  if (USE_HTTPS) server = https.createServer(await loadTls(), app);
  else server = http.createServer(app);
  setupSockets(server);
  try { indexOldFiles(); } catch (e) { console.error('Could not index existing uploads:', e.message); }
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
    setTimeout(() => {
      try { io.close(); } catch { /* ignore */ }
      server.close();
      server.closeAllConnections?.();
      try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* ignore */ }
      process.exit(0);
    }, 250);
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
