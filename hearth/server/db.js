// SQLite storage. Everything lives in DATA_DIR (default ./data).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hearth.db'));
db.pragma('journal_mode = WAL');

// ---------- safety: back up the database before any upgrade changes its structure ----------
// Each release that changes the schema bumps SCHEMA_VERSION. If this database is older and already
// has accounts in it, a full copy goes to data/backups/ first, so an upgrade can always be undone
// by stopping the server and copying the file back.
const SCHEMA_VERSION = 6;
const fromVersion = db.pragma('user_version', { simple: true });
const hasData = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
if (hasData && fromVersion < SCHEMA_VERSION) {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  db.pragma('wal_checkpoint(TRUNCATE)');
  const file = path.join(dir, `hearth-before-v${SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  fs.copyFileSync(path.join(DATA_DIR, 'hearth.db'), file);
  console.log(`Backed up the database before upgrading: ${file}`);
}
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  auth_hash TEXT NOT NULL,
  public_key TEXT NOT NULL,
  enc_private_key TEXT NOT NULL,
  avatar TEXT,
  banner TEXT,
  background TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  profile TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','voice')),
  topic TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
-- Server channel messages. New messages: ciphertext is end-to-end encrypted by clients.
-- Older messages (from before E2EE) keep their server-side AES-256-GCM sealed body.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  reply_to TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS dm_channels (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_a, user_b)
);
-- DM messages: ciphertext is end-to-end encrypted by the clients. The server cannot read it.
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  dm_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  reply_to TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dm_messages ON dm_messages(dm_id, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
);
`);

// End-to-end encryption for server channels: one random group key per server "epoch".
// Each member gets the key wrapped to their own public key. The server only stores wrapped keys.
db.exec(`
CREATE TABLE IF NOT EXISTS server_epochs (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  key_check TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, epoch)
);
CREATE TABLE IF NOT EXISTS server_keys (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped TEXT NOT NULL,
  wrapper_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, epoch, user_id)
);
-- Encrypted upload blobs, so only the uploader can attach/delete them and cleanup can find them.
CREATE TABLE IF NOT EXISTS blobs (
  name TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blobs_message ON blobs(message_id);
`);

// Add columns to older databases.
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('users', 'sign_public_key', 'TEXT');
addColumn('users', 'enc_sign_private_key', 'TEXT');
addColumn('users', 'kdf', "TEXT NOT NULL DEFAULT 'pbkdf2'");
addColumn('users', 'kdf_salt', 'TEXT');
addColumn('servers', 'key_epoch', 'INTEGER NOT NULL DEFAULT 0');
addColumn('servers', 'needs_rotation', 'INTEGER NOT NULL DEFAULT 1');
addColumn('messages', 'ciphertext', 'TEXT');
addColumn('messages', 'epoch', 'INTEGER');
// UI redesign: categories, roles, threads, pins, group DMs, privacy, sessions, blocking.
addColumn('channels', 'category', "TEXT NOT NULL DEFAULT ''");
addColumn('servers', 'category_order', "TEXT NOT NULL DEFAULT '[]'");
addColumn('servers', 'kind', "TEXT NOT NULL DEFAULT 'server'");
addColumn('members', 'role', "TEXT NOT NULL DEFAULT 'member'");
addColumn('messages', 'thread_id', 'TEXT');
addColumn('messages', 'pinned_at', 'INTEGER');
addColumn('messages', 'pinned_by', 'TEXT');
addColumn('dm_messages', 'pinned_at', 'INTEGER');
addColumn('dm_messages', 'pinned_by', 'TEXT');
addColumn('sessions', 'ua', 'TEXT');
addColumn('sessions', 'last_seen', 'INTEGER');
addColumn('users', 'privacy', "TEXT NOT NULL DEFAULT '{}'");
db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
`);
// Web Push subscriptions (one per installed app / browser that turned on push).
db.exec(`
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys TEXT NOT NULL,
  ua TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
`);
// Channels from before categories existed go into "Text" / "Voice".
db.prepare(`UPDATE channels SET category = CASE type WHEN 'voice' THEN 'Voice' ELSE 'Text' END WHERE category = ''`).run();

// ---------- encryption at rest for server-channel messages ----------
const KEY_FILE = path.join(DATA_DIR, 'secret.key');
let atRestKey;
if (process.env.AT_REST_KEY) {
  atRestKey = Buffer.from(process.env.AT_REST_KEY, 'hex');
} else if (fs.existsSync(KEY_FILE)) {
  atRestKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
} else {
  atRestKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, atRestKey.toString('hex'), { mode: 0o600 });
}
if (atRestKey.length !== 32) throw new Error('At-rest key must be 32 bytes (64 hex chars).');

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', atRestKey, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
function unseal(str) {
  try {
    const [iv, tag, ct] = str.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', atRestKey, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
  } catch {
    return { content: '[unable to decrypt]', attachments: [] };
  }
}

// Time-sortable unique ids.
let lastTs = 0;
function newId() {
  const ts = Math.max(Date.now(), lastTs + 1);
  lastTs = ts;
  return ts.toString(36).padStart(9, '0') + crypto.randomBytes(5).toString('hex');
}

// ---------- roles, permissions, server customization, custom emoji, bans (schema v5) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  permissions INTEGER NOT NULL DEFAULT 0,
  hoist INTEGER NOT NULL DEFAULT 0,
  mentionable INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id);
CREATE TABLE IF NOT EXISTS member_roles (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id)
);
CREATE TABLE IF NOT EXISTS channel_overrides (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('role', 'member')),
  target_id TEXT NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  deny INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS emojis (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  animated INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emojis_server ON emojis(server_id);
CREATE TABLE IF NOT EXISTS bans (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
`);
addColumn('servers', 'theme', "TEXT NOT NULL DEFAULT '{}'");
addColumn('servers', 'description', "TEXT NOT NULL DEFAULT ''");
addColumn('channels', 'slowmode', 'INTEGER NOT NULL DEFAULT 0');

// Instance-wide settings an admin can change from the app (e.g. the GIPHY key), overriding .env.
db.exec(`CREATE TABLE IF NOT EXISTS instance_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

// One-time move from the old Owner/Admin/Member labels to real roles. Every server gets its
// @everyone role (same id as the server), and existing admins get an "Admin" role with full rights.
const { DEFAULT_EVERYONE, PERMS } = require('./perms');
if (fromVersion < 5) {
  db.transaction(() => {
    for (const srv of db.prepare('SELECT id FROM servers').all()) {
      if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(srv.id)) {
        db.prepare(`INSERT INTO roles (id, server_id, name, position, permissions, created_at) VALUES (?, ?, '@everyone', 0, ?, ?)`).run(srv.id, srv.id, DEFAULT_EVERYONE, Date.now());
      }
      const admins = db.prepare(`SELECT user_id FROM members WHERE server_id = ? AND role = 'admin'`).all(srv.id);
      if (admins.length) {
        const rid = newId();
        db.prepare(`INSERT INTO roles (id, server_id, name, color, position, permissions, hoist, mentionable, created_at) VALUES (?, ?, 'Admin', '#f2a541', 1, ?, 1, 1, ?)`).run(rid, srv.id, PERMS.ADMINISTRATOR, Date.now());
        admins.forEach((a) => db.prepare('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(srv.id, a.user_id, rid));
      }
    }
  })();
}
// ---------- moderation, safety and admin (schema v6) ----------
addColumn('sessions', 'ip', 'TEXT');
addColumn('users', 'last_ip', 'TEXT');
addColumn('users', 'last_seen_at', 'INTEGER');
addColumn('users', 'suspended_at', 'INTEGER');
addColumn('users', 'suspend_reason', 'TEXT');
addColumn('users', 'tos_version', 'INTEGER');
addColumn('users', 'song', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS user_ips (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (user_id, ip)
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '{}',
  evidence TEXT NOT NULL DEFAULT '[]',
  target_ips TEXT NOT NULL DEFAULT '[]',
  reporter_ip TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  handled_by TEXT,
  handled_at INTEGER,
  resolution TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT,
  created_at INTEGER NOT NULL
);
`);

if (fromVersion < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);

module.exports = { db, seal, unseal, newId, DATA_DIR, UPLOAD_DIR, atRestKey };
