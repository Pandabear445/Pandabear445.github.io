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
const SCHEMA_VERSION = 16;
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
// (renamed to last_used_at in v13; only added to databases that don't have that yet)
if (!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'last_used_at')) addColumn('sessions', 'last_seen', 'INTEGER');
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
CREATE TABLE IF NOT EXISTS staff_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_notes_user ON staff_notes(user_id, created_at);
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

// v7: timed suspensions (staff roles live in instance_settings).
addColumn('users', 'suspended_until', 'INTEGER');
// v8: profile pages, upload limits, per-account admin switches.
addColumn('users', 'page', 'TEXT');
addColumn('users', 'page_bg', 'TEXT');
addColumn('users', 'page_views', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'upload_quota_mb', 'INTEGER');
addColumn('users', 'uploads_blocked', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'profile_locked', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS user_files (
  name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_files_user ON user_files(user_id, created_at);
CREATE TABLE IF NOT EXISTS profile_comments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_comments ON profile_comments(profile_id, created_at);
`);

// v9: supporters (people who chip in for hosting).
addColumn('users', 'supporter', 'INTEGER NOT NULL DEFAULT 0');
// v9: the server's own GIF library (no API key, no limits).
db.exec(`
CREATE TABLE IF NOT EXISTS gif_library (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  sticker INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER,
  source TEXT NOT NULL DEFAULT 'upload',
  source_id TEXT,
  added_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gif_library_uses ON gif_library(uses DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gif_library_source ON gif_library(source, source_id);
`);

// v10: polls (votes only; the question and options are inside the encrypted message) and server events.
db.exec(`
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, choice)
);
CREATE TABLE IF NOT EXISTS poll_closed (message_id TEXT PRIMARY KEY, closed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS server_events (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  channel_id TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  created_by TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_server ON server_events(server_id, starts_at);
CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id TEXT NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
`);

// v11: games and music people play and like, linked regions (call relays), automatic supporter payments.
db.exec(`
CREATE TABLE IF NOT EXISTS game_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cover_url TEXT,
  wide_url TEXT,
  link TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  ip TEXT,
  turn_urls TEXT NOT NULL DEFAULT '[]',
  setup_until INTEGER,
  last_seen INTEGER,
  stats TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  user_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (provider, ref)
);
CREATE INDEX IF NOT EXISTS idx_payments_time ON payments(created_at);
`);
addColumn('users', 'activity_cfg', "TEXT NOT NULL DEFAULT '{}'");
addColumn('users', 'supporter_until', 'INTEGER');
addColumn('users', 'support_code', 'TEXT');
addColumn('users', 'stripe_customer', 'TEXT');

// v12: sessions are stored as SHA-256 fingerprints of their tokens (see auth() in index.js). Existing raw tokens
// are converted once, so nobody gets signed out by the upgrade.
if (hasData && fromVersion < 12) {
  const rows = db.prepare('SELECT rowid, token FROM sessions').all();
  const upd = db.prepare('UPDATE sessions SET token = ? WHERE rowid = ?');
  db.transaction(() => { for (const r of rows) upd.run(require('crypto').createHash('sha256').update(String(r.token)).digest('hex'), r.rowid); })();
}
// v12: account recovery (email, recovery key) and two-factor sign-in; news feeds posted by the server's bot.
addColumn('users', 'email', 'TEXT');
addColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'enc_private_key_recovery', 'TEXT');
addColumn('users', 'recovery_salt', 'TEXT');
addColumn('users', 'totp_secret', 'TEXT');
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'totp_last_step', 'INTEGER');
addColumn('users', 'backup_codes', "TEXT NOT NULL DEFAULT '[]'");
addColumn('users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, kind);
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  query TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_check INTEGER,
  last_ok INTEGER,
  last_error TEXT,
  posted INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_feeds_server ON feeds(server_id);
CREATE TABLE IF NOT EXISTS feed_seen (
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (feed_id, item_key)
);
`);

// v13: sessions get a public id, an expiry and a revocation time, and the columns say what they hold.
//   id            random, shown to the account (Settings → Sessions) to pick a device; not usable to sign in
//   token_hash    SHA-256 of the sign-in token (the token itself is never stored)
//   last_used_at  last request; a session unused for SESSION_IDLE_DAYS expires
//   expires_at    when it stops working even if used (SESSION_MAX_DAYS after sign-in)
//   revoked_at    signed out (by the person, a password change/reset, 2FA, staff); rows are purged later
//   mfa_at        when this sign-in passed two-factor (recent → sensitive changes don't ask again)
{
  const cols = () => db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (cols().includes('token')) db.exec('ALTER TABLE sessions RENAME COLUMN token TO token_hash');
  if (cols().includes('last_seen')) db.exec('ALTER TABLE sessions RENAME COLUMN last_seen TO last_used_at');
  addColumn('sessions', 'id', 'TEXT');
  addColumn('sessions', 'expires_at', 'INTEGER');
  addColumn('sessions', 'revoked_at', 'INTEGER');
  addColumn('sessions', 'revoke_reason', 'TEXT');
  addColumn('sessions', 'mfa_at', 'INTEGER');
  const missing = db.prepare('SELECT rowid, created_at, last_used_at FROM sessions WHERE id IS NULL').all();
  if (missing.length) {
    // Existing sessions keep working: a fresh 60-day idle window from the upgrade, at most a year from sign-in.
    const upd = db.prepare('UPDATE sessions SET id = ?, expires_at = ? WHERE rowid = ?');
    const t = Date.now();
    db.transaction(() => { for (const r of missing) upd.run(crypto.randomBytes(12).toString('base64url'), Math.max(t + 60 * 86400000, (r.created_at || t) + 365 * 86400000), r.rowid); })();
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_id ON sessions(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
}
// v13: accounts can be deleted (the row stays as "Deleted user" so old messages keep an author).
addColumn('users', 'deleted_at', 'INTEGER');

// v13: the audit log is append-only. The database refuses to change or delete entries, and each entry carries
// a hash of the one before it, so editing the file by hand to hide something breaks the chain (Admin → Audit
// log shows whether it's intact).
addColumn('admin_log', 'prev_hash', 'TEXT');
addColumn('admin_log', 'hash', 'TEXT');
const auditHash = (prev, r) => crypto.createHash('sha256').update(JSON.stringify([prev || '', r.id, r.admin_id || '', r.action, r.target || '', r.detail || '', r.ip || '', r.created_at])).digest('hex');
{
  const unchained = db.prepare('SELECT * FROM admin_log WHERE hash IS NULL ORDER BY id').all();
  if (unchained.length) {
    db.exec('DROP TRIGGER IF EXISTS admin_log_no_update');
    let prev = (db.prepare('SELECT hash FROM admin_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1').get() || {}).hash || '';
    const upd = db.prepare('UPDATE admin_log SET prev_hash = ?, hash = ? WHERE id = ?');
    db.transaction(() => { for (const r of unchained) { const h = auditHash(prev, r); upd.run(prev, h, r.id); prev = h; } })();
  }
  db.exec(`
CREATE TRIGGER IF NOT EXISTS admin_log_no_update BEFORE UPDATE ON admin_log BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS admin_log_no_delete BEFORE DELETE ON admin_log BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
`);
}

// v14: server folders (synced across your devices), personal update tracking, and study tools.
addColumn('users', 'rail_layout', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'study_enabled', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS user_feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  query TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  notify INTEGER NOT NULL DEFAULT 1,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_check INTEGER,
  last_ok INTEGER,
  last_error TEXT,
  found INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_feeds_user ON user_feeds(user_id);
CREATE TABLE IF NOT EXISTS user_feed_items (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES user_feeds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  new INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  UNIQUE (feed_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_user_feed_items_user ON user_feed_items(user_id, created_at);
-- Study tools: each deck, task or day of focus stats is one row, end-to-end encrypted by the app (the
-- server only stores ciphertext), synced across the person's devices.
CREATE TABLE IF NOT EXISTS study_items (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_study_items_sync ON study_items(user_id, updated_at);
`);

// v15: a call's region (like Discord's region override): which relay everyone in a voice channel or DM call
// goes through. NULL = automatic (direct when possible, otherwise the nearest relays).
addColumn('channels', 'rtc_region', 'TEXT');
addColumn('dm_channels', 'rtc_region', 'TEXT');

// v16: creator memberships. A server's owner connects a Stripe account and sells monthly tiers; each tier
// gives a role (which can open private channels). Payments go to the creator through Stripe; this Hearth
// keeps the fee its owner set. Only Stripe ids and statuses are stored here, never card details.
db.exec(`
CREATE TABLE IF NOT EXISTS creator_accounts (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  stripe_account TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS membership_tiers (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  role_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_membership_tiers_server ON membership_tiers(server_id);
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_sub TEXT NOT NULL UNIQUE,
  stripe_customer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  cancel_at_end INTEGER NOT NULL DEFAULT 0,
  period_end INTEGER,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memberships_server_user ON memberships(server_id, user_id);
`);

if (fromVersion < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);

// Reuse compiled SQL statements instead of compiling the same query on every request (there are
// hundreds of them, many run per message). Statements are only used with get/all/run, so sharing is safe.
// Queries built with a variable number of placeholders stop being cached once the cache is full.
const compile = db.prepare.bind(db);
const statements = new Map();
db.prepare = (sql) => {
  let st = statements.get(sql);
  if (!st) { st = compile(sql); if (statements.size < 3000) statements.set(sql, st); }
  return st;
};

module.exports = { db, seal, unseal, newId, DATA_DIR, UPLOAD_DIR, atRestKey, auditHash };
