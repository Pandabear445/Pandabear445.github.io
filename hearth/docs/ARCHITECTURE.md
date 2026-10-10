# Hearth architecture overview

Hearth 1.27.1 is a self-hosted chat app with end-to-end encrypted (E2EE) messages and files. One Node process runs
everything: the HTTP API, the bot API, Socket.IO, voice signaling, background jobs and backups. It stores data in one
SQLite file (schema 18). This overview describes the code after the 2026 security overhaul (schema 17, see
[ENGINEERING-REPORT.md](ENGINEERING-REPORT.md)) and the seven workstreams merged since: observability, storage, bots,
recovery, usability, voice reliability and quality. Paths are relative to `hearth/`, except `.github/`, which is at
the repository root. Line numbers appear only in section 7. Everything else is cited by file and function name.
Every HTTP route and socket event is listed in [ROUTES.md](ROUTES.md) (the bot API in [BOTS.md](BOTS.md)); what each
protection guarantees is in [SECURITY.md](../SECURITY.md). Section 13 lists the topic documents.

## 1. Components and entry points

| Component | Entry point | What it is |
|---|---|---|
| Server | `server/index.js` | Express 4 app plus an `api` router mounted at `/api`. Socket.IO 4 is set up in `setupSockets`. `log.js` (structured logger) and `jobs.js` (safe background jobs) load first, before the database. An async block at the bottom starts HTTP or HTTPS (`loadTls` makes a self-signed cert if `SSL_CERT` is unset). Feature modules get a shared context object: `accounts.js` (email, 2FA, recovery, reset), `newsbot.js` (feeds, trackers), `study.js` (Recall sync), `activity.js` (games and music), `regions.js` (relays), `money.js` (Ko-fi and Stripe supporter badge), `memberships.js` (Stripe Connect tiers), `storage.js` (resumable uploads, storage report and cleanup), `search.js` (message search), `bots.js` (bot accounts, installations, the bot API, webhooks, slash commands), `usability.js` (saved messages, read state, notification preferences, timeouts, data export), `alerts.js` (owner alerts) and `health.js` (health endpoints). Support code: `db.js` (schema, migrations, sealing, audit chain), `perms.js`, `profile.js`, `page.js`, `backup.js`, and four guards added by the overhaul: `netguard.js` (outbound requests), `proxytrust.js` (which proxies may set the client address), `fetchlimit.js` (streamed size caps on `fetch()` answers) and `imagemeta.js` (strips picture metadata in a worker thread). `cli.js` is an operator CLI for TURN settings, backups and restore, `check-files`, `doctor` (`doctor.js`) and `set-owner`. |
| Web client | `public/index.html` | Loads `/socket.io/socket.io.js` and `public/js/app.js` as ES modules. There is no build step. Main modules: `api.js` (REST calls with a bearer token), `conn.js` (when a closed live connection means "signed out" and when it only reconnects), `e2ee.js` (crypto primitives), `secure.js` (key manager), `attachments.js` (keeps only attachment entries on this server), `files.js` (resumable uploads, downloads with progress, a cache of decrypted files), `search-query.js` (the search language, matched on the device), `voice.js` (the call engine), `call-diagnostics.js`, `relays.js`, `watch.js` (watch together), `bots.js` (bot settings, slash commands), `usability.js` (drafts, one notification per message across tabs, export zip), `viewport.js` (keeps the composer above an on-screen keyboard), `recall-host.js` plus `public/recall/` (study app in a sandboxed iframe), and `sw.js` (service worker, push, offline shell). The message list keeps at most 300 messages loaded (`HISTORY_WINDOW` in `app.js`). |
| Desktop | `desktop/main.js` | Electron app. The local `connect.html` picks a server. Then the `BrowserWindow` (`contextIsolation`, `sandbox`) loads the remote server origin. `preload.js` exposes `window.hearthDesktop`. `origin.js` does every exact-origin check, `permissions.js` decides which page permissions need the person's yes, `picker.html` is the app's own screen picker, and `update-verify.js` checks signed updates (Ed25519, key from `hearth.config.json` `updatePublicKey`). `detect.js` detects games and music, and `hotkeys.js` provides global push-to-talk. `build/sign-update.js` makes keys and signs `latest*.yml` in CI. |
| Android | `mobile/` | Capacitor 8 shell. `www/index.html` is the connect page, and then the WebView loads the remote server. `native/MainActivity.java` keeps navigation on that origin, prompts on certificate fingerprints, and runs the `HearthAndroid` bridge (notifications, file saving). `native/BridgePolicy.java` lets only the local connect screen change the saved server. The page side is `public/js/android.js`. |
| Bots | external programs; `scripts/example-bot.js` | Programs that bot owners run on their own https servers. A bot is a `users` row with `is_bot = 1` (it can't sign in) plus a `bots` row. It calls `/api/bot/v1` with `Authorization: Bot hb_<id>.<secret>` and receives signed webhooks. `scripts/example-bot.js` is a starting point with no dependencies. |
| Relays / regions | `server/regions.js` | An admin adds a region (password re-confirmed) and gets a `curl … \| sudo bash` command for `/regions/install/:id?k=`. The script installs coturn with the instance TURN secret, an upload-only SFTP account for backups, and an agent. A systemd timer runs the agent every minute to POST `/api/regions/:id/heartbeat`; the address it reports must be public. |
| TURN | `scripts/setup-turn.sh`, `deploy/turnserver.conf` | coturn in `use-auth-secret` mode with `denied-peer-ip` for private ranges and `no-tcp-relay`. `setup-turn.sh` also sets `max-bps` (`TURN_MAX_MBIT`, default 6) and `bps-capacity` (`TURN_CAPACITY_MBIT`). The sample `turnserver.conf` ships with `static-auth-secret` commented out and no bandwidth cap. The server issues credentials in `iceServersFor`. |
| Caddy | `deploy/Caddyfile` | Optional reverse proxy (compose profile `domain`). It terminates TLS and does `reverse_proxy hearth:3000`. |
| Hosting | `Dockerfile`, `docker-compose.yml`, `deploy/hearth.service`, `scripts/harden-vps.sh` | Docker, or systemd on a VPS. `docker-compose.yml` puts Caddy on a fixed network (`10.231.47.0/28`) and sets `TRUST_PROXY` to it unless `.env` names another proxy. |

```mermaid
flowchart LR
  subgraph clients["Clients"]
    WEB["Browser / PWA<br/>public/js"]
    DESK["Desktop<br/>desktop/main.js"]
    DROID["Android<br/>mobile/"]
  end
  CADDY["Caddy<br/>optional TLS proxy"]
  SRV["Hearth server<br/>server/index.js<br/>Express + Socket.IO"]
  DB[("SQLite WAL<br/>data/hearth.db")]
  FILES["data/: uploads, upload-parts, downloads, backups,<br/>secret.key, backup.key, vapid.json, audit-anchor.json"]
  EXT["Third parties: feeds, GIPHY/KLIPY,<br/>Steam, Wikipedia, RAWG, Last.fm, iTunes, oEmbed,<br/>Stripe, SMTP, web push services"]
  BOT["Bot servers<br/>run by bot owners"]
  MON["Docker healthcheck,<br/>uptime monitor"]
  TURN["coturn on main host"]
  REGION["Region VPS<br/>coturn + agent + SFTP"]
  OFF["rclone remote"]
  CI["GitHub Actions"]
  WEB -->|"HTTPS + WSS"| CADDY
  DESK -->|"loads remote UI"| CADDY
  DROID -->|"loads remote UI"| CADDY
  CADDY --> SRV
  WEB -.->|"direct HTTPS, no proxy"| SRV
  SRV --> DB
  SRV --> FILES
  SRV -->|"netguard: fetch / push; SMTP"| EXT
  SRV -->|"netguard: signed webhooks"| BOT
  BOT -->|"bot API /api/bot/v1"| SRV
  MON -.->|"GET /api/health/live, /ready"| SRV
  SRV -->|"sftp .hbk"| REGION
  REGION -->|"heartbeat every 60 s"| SRV
  SRV -->|"rclone copyto .hbk"| OFF
  PEER["Other call peers"]
  WEB -->|"WebRTC mesh, DTLS-SRTP"| PEER
  WEB -->|"TURN relay"| TURN
  WEB -->|"TURN relay"| REGION
  CI -->|"scp installers + latest*.yml + .sig<br/>(pinned host key)"| FILES
  DESK -->|"GET /updates/ (signature checked)"| SRV
```

## 2. Request and real-time flow

**Middleware order** (as registered in `server/index.js`):

1. `app.set('trust proxy', trustProxySetting(TRUST_PROXY))` (`proxytrust.js`). Unset means `loopback`: only a proxy on
   this machine may set the client address. A number is a hop count, `false` trusts nobody, and addresses or subnets
   name the proxies. `socketIp` runs the same walk (`clientIp`) for Socket.IO.
2. `log.requestLogger()` (`log.js`). It takes the incoming `X-Request-Id` if it matches `[A-Za-z0-9._:-]{1,64}`, or
   makes a random one, sets `req.id` and the `X-Request-Id` response header, and runs the rest of the request in an
   `AsyncLocalStorage` context so every log line carries `reqId`. It writes the access-log line on `finish` (§12).
3. `directGuard`. When `HTTPS=false` and `ALLOW_DIRECT_HTTP` is not `true`, requests from public peer addresses get a
   403. The same check is Socket.IO's `allowRequest`. When `X-Forwarded-For` arrives from an untrusted private
   address, the server logs a one-time hint with a safe `TRUST_PROXY` value (`ignoredXffHint`).
4. `express.json({ limit: '2mb' })`. It keeps the raw body for `/api/pay/*`, so webhook signatures can be checked.
5. Security headers on every response: nosniff, `X-Frame-Options: DENY`, COOP, Permissions-Policy, and HSTS when the request is secure. `cspFor` sets the CSP on everything except `/uploads/` and `/media/`. `connect-src` is `'self'` plus the server's own `wss:` (and `ws:` on plain HTTP); `img-src` and `media-src` allow any `https:`. `/api/` responses get `no-store` and CORP.
6. File routes: `/uploads/:file` (Range requests, §6), `/manifest.webmanifest`, `/sw.js`, `/download`, `/terms`, `/updates/:file` (installers, `latest*.yml` and `latest*.yml.sig`), `/downloads/:file`.
7. The CSP middleware for `/recall`, then an in-memory brotli/gzip handler for text assets, `express.static(public/)` and `/vendor/argon2.js`.
8. `app.use('/api', api)`. Inside the router: a gzip wrapper on `res.json` for bodies of 4 KB or more (256 KB or more are compressed off the main thread), an IP-ban guard on `/auth/register`, `/auth/login`, `/auth/forgot` and `/auth/reset`, then the routes, including each feature module's. **There is no router-wide auth.** Each route lists the `auth` middleware itself, and staff routes add `staffOnly`, `adminOnly` or `ownerOnly`. `GET /api/health/live` and `/ready` need no auth. `bots.js` mounts the bot API as a sub-router at `/api/bot/v1` with its own `botAuth` (a bot token, never a session) and its own `{error, code}` error handler.
9. App-level routes registered later in the file: `/media/gif` (index.js), `/media/news` (newsbot.js), `/media/art` and `/media/game` (activity.js), `/regions/install/:id` (regions.js).
10. `api` 404 JSON handler, then the error handler, then the SPA fallback for GETs outside `/api`, `/uploads` and `/socket.io`. The error handler turns broken or oversized bodies into 400 `bad_json`, 413 `too_large` or 415, and returns `HttpError` messages (with `Retry-After` when set). For any other error it logs `http unhandled_error` with the route template and returns a generic message.

**Auth.** The client fetches its KDF salt from `GET /api/auth/params`. `deriveKeys` in `e2ee.js` runs Argon2id and then HKDF. The result is an `authKey`, which is sent, and a `wrapKey`, which never leaves the device. The client solves a proof-of-work captcha (`GET /api/captcha`, `public/js/captcha-worker.js`). `POST /api/auth/login` then runs these steps in order:
- the per-network limit;
- `verifyCaptcha` (before every shared counter, so junk without a solved check counts against nobody else; it also refuses a check easier than the current difficulty with `captcha_harder`);
- the account's limits: a known device (a signed `device` note) or known network has its own daily bucket; anything else counts toward the per-account limits and the instance-wide counter (`countInstanceWide`, which raises the difficulty when busy instead of refusing, unless the captcha is off);
- a bcrypt compare (against `DUMMY_HASH` when the user is unknown); bot accounts are refused;
- `require2fa` in `accounts.js`;
- `createSession`.

The session token is 32 random bytes, returned once. The DB stores only its SHA-256 (`sessions.token_hash`). The client keeps the token in `localStorage['hearth.token']` and sends `Authorization: Bearer`. No cookies are used.

The `auth` middleware calls `sessionFor`, which accepts a 64-hex token whose session is not revoked, not past `expires_at` (default 365 days) and not idle for more than 60 days. It then rejects deleted users (401), suspended users (403), non-staff from a banned IP (403) and non-staff during maintenance (503); `POST /auth/logout` is always let through. On success it sets `req.userId` and `req.session`, touches `last_used_at` at most once a minute, and records the IP.

**Bot API auth** (`botAuth` in `bots.js`). `Authorization: Bot hb_<16 hex>.<43 base64url>` is matched against `bot_tokens.token_hash` (SHA-256, compared in constant time). A token anywhere in the URL is refused with 400 `token_in_url`, even when it is right. The bot must not be disabled, deleted or suspended, and maintenance returns 503. Every call then checks the installation's scopes and channel allow-list; a token made for one installation works only there.

`stepUp` re-checks the `authKey` (10 tries per 10 minutes, a right password gives its try back), and the 2FA code unless the session passed 2FA in the last 10 minutes. It guards: password, username, email and recovery-key changes; account deletion; `POST /me/keys/wrapped`; starting a data export; deleting or transferring a server; staff and ownership changes; deleting a backup, lowering backup retention, viewing the backup key; storage cleanup; turning alerts or alert emails off; making or rotating a bot token, and making a new webhook secret; payment destinations (`PUT /admin/money`, the funding link in `PUT /admin/owner`, the memberships key and webhook secret); `PUT /admin/turn`; creating and reinstalling regions. `POST /me/2fa/disable` always needs a fresh code.

**Authorization.** `server/perms.js` defines 17 permission bits plus ADMINISTRATOR. `perms.base` gives server-level permissions and `perms.channel` applies channel overrides; only roles held by a current member count. A member in `member_timeouts` loses the `TALK` bits (send, react, attach, mention everyone, threads, speak, embed, invite) until the timeout ends, and a channel override can't give them back. `perms.forServer` answers the same rules for many members at once (roles, held roles, timeouts and each channel's overrides read once), for `toChannel` and `emitServer`. The route helpers are `requireServer`, `requireChannel`, `requirePerm`, `requireOwner` and `requireDm`. Routes keyed by a channel, message, role or event ID load that row and check membership against its own `server_id`. Role assignment checks position and that the role's permissions (and its channel overrides) are a subset of the caller's. Override edits need Manage Roles in that channel and are refused when they touch, or take permissions away from, people at or above the editor. Channel edits need Manage Channels in that channel. Timeouts need Kick Members and a higher top role. Installing a bot needs Manage Server. `removeMember` deletes the member's roles, member overrides and RSVPs and records them in `former_members`. Instance staff come from `staffRole` and `ownerId`: the `owner` setting (settled once), `ADMIN_USERS` names claimed by account id (`envAdminClaims`), then the `staffRoles` setting.

**Rate limiting.** `rateLimit(key, max, windowMs, cost)`, `countHit` and `limitNet` in `server/index.js` use an in-memory `Map` with fixed windows. Keys combine the user, the session, the network (IPv4 address or IPv6 /64) and a global key. The counters reset on restart and are not shared between processes. Examples:
- `limitMessages`: 30 per 10 s per user, 1500 per hour per user, 25 per 10 s per session, 120 per 10 s per network.
- One-request uploads (`limited`): 60 per minute per user, 600 per hour per user, 40 per minute per session, 150 per minute per network, and at most 4 in progress per user. Resumable uploads: starting one, 20 per minute and 200 per hour per user and 100 per minute per network, at most 4 unfinished per user; chunks, 600 per minute per user and per session and 1,200 per network.
- Login: 20 per 10 min per network, then (after the captcha) per-account and instance-wide counters. Registration: 5 per hour and 10 per day per network.
- Joining a server: 20 per hour per user, 60 per network. Profile writes: 30 per minute and 300 per hour per user, 120 per minute per network. Search: 60 per minute per user. `GET /api/ice`: 60 per hour per user.
- Bot API: 60 per 10 s and 5,000 per hour per bot; bad tokens 30 per minute per address. Slash commands: 20 per 10 s per user and 60 per 10 s per bot. Health probes: 600 per minute per network.

**Socket.IO.** Options: `pingInterval` 10 s, `pingTimeout` 8 s, `maxHttpBufferSize` 256 KB, `allowRequest` = `directGuard`.
- *Handshake* (`io.use`): `handshake.auth.token` goes through `sessionFor`. The user must not be deleted or suspended. The IP must not be banned and maintenance must be off (staff are exempt from both). At most 30 sockets per user, and 60 handshakes per minute per user (`too_many_connections`, `rate_limited`). The middleware stores `socket.data.sid`.
- *On connect*: each socket gets a bucket of 40 events (refilled 10 per second) and every event also spends from a per-user budget shared by all of that user's sockets (120, refilled 30 per second). A call's `voice:signal` events from the socket in the call have their own bucket (200, refilled 50 per second). Refused events are answered "Slow down."; strikes are forgiven 5 per second, and after more than 50 the socket gets a `flood` event and is disconnected. The socket joins `user:<uid>`, `admins` (staff only) and `server:<sid>` for each membership. Presence is broadcast.
- *Per event*: `guard(fn)` wraps every handler. It acks `{ok:true}` or `{error}`, and logs unexpected errors (`socket handler_error`) without the event's data. Each handler runs its own checks (`requireChannel`, `requireDm`, voice-room membership, blocks for typing). `voice:signal` data is capped at 64 KB. Typing is passed on at most once a second per user.
- Client-to-server events are `typing`, `voice:*`, `call:decline` and `watch:*`. Everything else goes over REST, and the server pushes the resulting events (`message:new`, `dm:message`, `keys:state`, `voice:state`, `voice:perms`, `voice:peer-joined`, `call:region`, `read:update`, `saved:update`, `notify:update`, `timeout:update`, `bot:interaction`, `admin:alert` and others).
- *Disconnect*: a socket that was in a call keeps the user's place for a grace window (§5).
- *Revocation*: `revokeSessions` disconnects the matching sockets with `session:revoked` and ends a call place kept for those sessions. A 60-second sweep closes sockets whose session has ended. On the client, `conn.js` treats only `session:revoked` or a refused reconnect (`unauthorized`) as a sign-out; any other server-side close reconnects.

**Sending a channel message.** On the client this starts in `sendTo` (`public/js/app.js`). On the server it is `POST /channels/:id/messages` (`server/index.js`).

```mermaid
sequenceDiagram
  autonumber
  participant A as Sender app (app.js, secure.js, e2ee.js, files.js)
  participant S as Server (index.js, storage.js, usability.js, bots.js)
  participant D as SQLite
  participant IO as Socket.IO rooms
  participant B as Recipient app
  A->>A: sec.ready(serverId): current epoch key from keys:state
  opt attachments
    A->>A: encryptFile per file and thumbnail (random AES-GCM key)
    alt up to 8 MB
      A->>S: POST /api/upload/encrypted (blob.bin, multipart)
    else over 8 MB
      A->>S: POST /api/uploads, PUT chunks in order, POST /api/uploads/:id/complete with SHA-256
    end
    S->>D: INSERT blobs (message_id NULL) and user_files
    S-->>A: url /uploads/ID.bin
  end
  A->>A: encryptGroup: c2 ciphertext, per-message HKDF key, AAD, ECDSA signature
  A->>S: POST /api/channels/:id/messages {ciphertext, epoch, files, mentions, nonce}
  S->>S: auth, requireChannel, limitMessages, SEND/ATTACH checks (lost in a timeout), requireCurrentEpoch
  S->>D: INSERT messages (ciphertext, epoch), then attachBlobs
  S->>IO: toChannel(c).emit message:new
  S->>D: mention_marks, the sender read marker, bot_deliveries (ids and times only)
  S--)B: web push (no content) to pinged members who can see the channel, as their preferences allow, queued after the response
  S-->>A: 200 message JSON with nonce echoed
  IO-->>B: message:new {ciphertext, epoch, authorId}
  B->>B: decryptGroup with the epoch key, verify signature with pinned sign key
  opt attachments
    B->>B: cleanFiles (attachments.js): keep only /uploads/<name> entries
    B->>S: GET /uploads/ID.bin (no auth, Range allowed)
    B->>B: decryptFile with f.k from the payload, cache as a blob URL
  end
```

`toChannel` emits to `server:<sid>`. For a restricted channel it emits only to the `user:<uid>` rooms of members who have VIEW (worked out with `perms.forServer`). Pushes go to mentioned and replied-to members, everyone on an allowed @everyone, and those who chose "All messages" (`notifyChannelMessage`). `usability.js` `pushAllowed` drops a push for Do Not Disturb (status or schedule), a muted or "none" conversation or server, and plain messages unless "All messages" was picked; `shapePush` replaces the title and body with the instance name and "New message" unless the person turned previews on. With several tabs open, only the first to claim a message shows its notification (`claimOnce`, a Web Lock plus `localStorage`). DMs follow the same pattern: `encryptDm` builds a `d2:` ciphertext, the client calls `POST /api/dms/:id/messages`, and the server emits `dm:message` to the two `user:` rooms. Bot events carry who, where and when, never text.

**Searching messages** (`server/search.js`). `GET /api/search/messages` takes only `scope` (`c:`, `d:`, `s:` or `all`), `from`, `before`, `after`, `cursor` and `limit` (1–200). Access is worked out again on every request; for `all` and `s:` it looks at no more than 100 conversations per page (those with the newest matches) through covering indexes. It returns ciphertext serialized exactly like the history routes. The words, phrases and `has:`/`is:` filters stay on the device (`search-query.js`), which decrypts each page and matches there, up to 1,000 messages per click.

## 3. Data model overview

`server/db.js` opens one `better-sqlite3` connection in WAL mode with `foreign_keys=ON`. All queries run synchronously on the event loop, and compiled statements are cached. The schema version is `PRAGMA user_version` = 18 (`SCHEMA_VERSION`). Tables use `CREATE TABLE IF NOT EXISTS` plus `addColumn`, and some data migrations are gated on the version. Users are soft-deleted (`deleted_at`).

**Migrations.** `db.js` first refuses a data folder that holds a `RESTORE-INCOMPLETE` marker (`HEARTH_RESTORE_INCOMPLETE`, §11). If the file's `user_version` is above `SCHEMA_VERSION`, it throws `HEARTH_DB_TOO_NEW` without touching the file. Before upgrading a database that has accounts, it writes one consistent copy with `VACUUM INTO` to `data/backups/hearth-before-v18-<ts>.db` (via a `.partial` name; skipped when a copy newer than the data already exists). Everything from `BEGIN IMMEDIATE` (after `PRAGMA foreign_keys = ON`) to the `user_version` bump runs as one transaction, so an interrupted upgrade changes nothing and runs again on the next start. The `// v17 (…)` and `// v18 (…)` blocks run inside it. The audit anchor file is written only after `COMMIT` (`anchorAfterCommit`). With `NODE_ENV=test`, `HEARTH_TEST_KILL_IN_MIGRATION=1` kills the process before the commit, for the upgrade drill.

| Area | Tables | Ciphertext / sealed / hashed | Plaintext metadata |
|---|---|---|---|
| Accounts | `users`, `user_key_history` | `enc_private_key`, `enc_private_key_recovery`, `enc_sign_private_key` (encrypted client-side). `auth_hash` = bcrypt(authKey). `totp_secret` sealed with `secret.key`. Backup codes are HMACs. | username, email, profile/page JSON, privacy, public and signing keys (kept after deletion), retired public keys (`user_key_history`), `last_ip`, `last_seen_at`, activity, supporter fields, `is_bot` |
| Sessions | `sessions`, `auth_tokens`, `user_ips`, `push_subs` | session token and reset token stored as SHA-256 | user agent, IPs, timestamps, `mfa_at`, `revoke_reason`; push endpoint, keys, `session_id`, `fails`, `retry_at`; reset tokens record the email they were sent to |
| Notifications | `notify_prefs`, `user_prefs` | none | per server, channel or DM: level, mute-until, @everyone suppression; Do Not Disturb schedule, time zone, push previews, read baseline |
| Structure | `servers`, `channels`, `members`, `roles`, `member_roles`, `channel_overrides`, `invites`, `bans`, `emojis`, `former_members`, `member_timeouts` | none | names, topics, themes, permissions, membership, who left when, call region and its version (`rtc_region_v`), timeouts (until, reason, by whom; kept across leave and rejoin) |
| Messages | `messages`, `dm_messages`, `dm_channels`, `reactions`, `poll_votes`, `poll_closed`, `saved_messages`, `read_states`, `mention_marks`, `pin_log` | `messages.ciphertext` (`c2:`), `dm_messages.ciphertext` (`d2:`). Legacy pre-E2EE, news-bot and bot bodies are in `messages.body`, sealed with `secret.key` (bot posts are marked `bot: true`). A saved message's note is `x1:` vault ciphertext. | author, channel/DM, `epoch`, `reply_to`, `thread_id`, timestamps, pins, reaction emoji, poll choice indexes, saved message ids, last-read ids, who each message pings, who pinned or unpinned what |
| Group keys | `server_epochs`, `server_keys`, `server_key_reports` | `server_keys.wrapped` (`w1:`, ECIES per member, at most 600 characters). `key_check` is a truncated hash. | epoch numbers, who made each epoch and when, who wrapped for whom, who reported a key broken |
| Files | `blobs`, `user_files`, `upload_sessions`, `gif_library` | `.bin` contents on disk; unfinished uploads in `data/upload-parts/` | sizes, uploader, linked message; GIF-library uploads count in `user_files`; a `user_files` row of kind `reserved` holds room for an unfinished upload |
| Bots | `bots`, `bot_installations`, `bot_tokens`, `bot_commands`, `bot_deliveries` | tokens as SHA-256; the webhook signing secret sealed (`sealSecret`) | owner, webhook URL, requested and granted scopes, channel allow-lists, commands, delivery queue (event ids, authors, times, status, attempts) |
| Recall | `study_items` | `data` (`x1:` vault ciphertext) | kind, size, timestamps |
| Events / feeds | `server_events`, `event_rsvps`, `feeds`, `feed_seen`, `user_feeds`, `user_feed_items` | none | everything |
| Moderation | `reports`, `staff_notes`, `admin_log` | none | Report evidence is the plaintext the reporter submits, plus the target's IPs. `admin_log` is append-only (triggers) with an HMAC-SHA256 chain (see §12). |
| Money | `payments`, `creator_accounts`, `membership_tiers`, `memberships`, `membership_cancellations` | none | Stripe IDs, amounts, statuses, cancellations still to confirm |
| Instance | `instance_settings`, `regions`, `game_catalog`, `profile_comments`, `job_health` | Sealed (`sealed:` prefix, `sealSecret`): the SMTP password, the GIPHY/KLIPY/Last.fm/RAWG keys, the Ko-fi token, the supporter Stripe signing secret, the memberships Stripe key and webhook secret. | Other settings, including the TURN secret, `owner`, `envAdminClaims`, `e2eeSince`, `auditKeyedFrom`, `alerts` and `alertState`; each background job's last run, last error and failure count |

Hot lookups have indexes added in v17: members by user, channels by server, DMs and friend requests by either side, a member's server keys, reports by target, push subscriptions by session, and the covering indexes `search.js` uses. v18 adds partial indexes for pinned messages, a channel's top-level messages (`idx_messages_channel_top`), `created_at` on both message tables, and indexes for the new tables (numbers in [PERFORMANCE.md](PERFORMANCE.md)).

Server-side key files live in `data/`. `secret.key` (or the `AT_REST_KEY` env var) is the AES-256-GCM key for `seal`/`unseal`; it also keys the HMACs (media tokens, captcha challenges, fake KDF salts, 2FA backup codes, user ids in logs) and, through HKDF, the audit-log chain. The others are `backup.key` (or `BACKUP_KEY`), `vapid.json`, `audit-anchor.json` and `region-backup/id_ed25519`.

## 4. Encryption architecture and key ownership

All E2EE runs in the browser through WebCrypto (`public/js/e2ee.js`). `public/js/secure.js` manages the keys for each session.

| Key | Made by | Where it lives | Protection |
|---|---|---|---|
| Password master | Argon2id (64 MiB, 3 passes, 16-byte random salt). Legacy accounts use PBKDF2 and are upgraded at their next login. | never stored | - |
| `authKey` / `wrapKey` | HKDF(master, `hearth-auth-v2` / `hearth-wrap-v2`) | The server stores bcrypt(authKey). `wrapKey` stays in browser memory. | - |
| Identity key (ECDH P-256) | `createIdentity`, at registration or on a reset without recovery | `users.enc_private_key`, returned only by login, reset and `POST /me/keys/wrapped` (step-up), never by `/bootstrap`. The unwrapped key is stored non-extractable in IndexedDB `hearth/keys`. | AES-GCM under `wrapKey` |
| Signing key (ECDSA P-256) | `createSigningKey`, uploaded via `/me/sign-key` after `/me/sign-key/challenge` | `users.sign_public_key`, `enc_sign_private_key` | HKDF(ECDH(id, id)) "self key"; the upload proves possession of the identity key and the signing key |
| Server group key | 32 random bytes per epoch, generated by a member's client (`secure.js` `rotate`) | `server_keys` (one wrap per member), `server_epochs.key_check` | `wrapGroupKey`: ephemeral ECDH to the recipient, HKDF, AES-GCM. Context `hearth-gk\|server\|epoch\|recipient\|wrapper` is both HKDF info and AAD. Signed by the wrapper. Each member's app re-wraps the keys it holds to itself (`POST /servers/:id/keys/self`). |
| Channel message key | HKDF(group key, random 32-byte salt, `hearth-msg-v2\|channelId`) | not stored | Format `c2:<epoch>:<salt>:<iv>:<ct>:<sig>`. AAD `hearth-c2\|channelId\|epoch\|authorId`. ECDSA-signed. Plaintext padded (`padded`). Message id, reply, thread, time and edit version are not bound. |
| DM message key | HKDF(ECDH(me, peer), random salt, `hearth-dm-v2\|dmId`) | not stored | Format `d2:<salt>:<iv>:<ct>`. AAD binds the DM and the author. Not signed. |
| File key | random 256-bit key per file and per thumbnail (`encryptFile`) | inside the encrypted message payload (`f[].k`) | blob = iv‖ct, uploaded as `.bin` (one request or resumable chunks), not padded |
| Recovery key | 32 base32 characters (160 bits) from `newRecoveryCode` | Shown once to the user. The server holds only the rewrapped identity key (`PUT /me/recovery`, behind step-up). | HKDF(code, `recovery_salt`) + AES-GCM |
| Vault key (Recall, saved-message notes) | HKDF(ECDH(id, id)) (`vaultKey`) | not stored | `x1:` AES-GCM, AAD `hearth-vault\|kind\|id` (kind `saved` and the message id for notes) |
| At-rest key | `data/secret.key` | server | used for `seal()`: legacy messages, news-bot and bot posts, TOTP secrets, the sealed settings in §3 and bot webhook secrets; HKDF of it keys the audit chain |
| Backup key | `data/backup.key` or `BACKUP_KEY` | server | see section 11 |

**Group key lifecycle.** The server sends each member `keys:state` (from `keyState`, only to members online at that moment; others read it from `/bootstrap`): the current epoch, `needsRotation`, `keyCreatorId`/`keyCreatedAt`, the member's own wraps and the list of members who still need the key. `secure.js` `applyState` checks each wrap's signature against the wrapper's signing key and the `key_check`, then unwraps it. It refuses a current key wrapped by a non-member and never moves to a lower epoch within a session.
- `POST /servers/:id/keys/rotate` requires `epoch = current + 1`, a well-formed wrap for every current member, and runs in a transaction. A rotation nobody needs (or one by whoever caused the need, `causedRotation`) goes through `limitVoluntary`: non-managers wait until the current key is 10 minutes old and while fewer than 12 epochs were made in the server in the last hour; Manage Server holders have 30 an hour of their own. Refused attempts don't count.
- `POST /servers/:id/keys/share` adds wraps of the current epoch for members who lack it. The sharer must hold the current epoch, and shares are refused (409 `epoch`) while `needs_rotation` is set.
- `POST /servers/:id/keys/bad` deletes the caller's own wrap of the current epoch only. When the wrap came from the epoch's creator, `reportBroken` records a report; two reporters (or the only other member, or one with Manage Server) set `needs_rotation`. Reports count at most 12 per hour per member.
- `removeMember` (leave, kick, ban) sets `needs_rotation` and records `former_members`. `keyOnRejoin` sets it again when a former member (or someone holding old wraps) joins, so a returning account never gets the key made while it was away. Until some member's client rotates, sends and edits return 409. Other joiners receive the current epoch.
- Group DMs are servers with `kind='group'` and use the same group keys.

**Identity trust.** Each device pins other users' keys on first sight, in `localStorage` (`checkPin` / `acceptPin`; `checkPins` does a whole member list with one read and one write). A changed key pauses DM sending and key sharing with that user. The safety number is a 60-digit SHA-512 over both users' keys. Account reset (`accounts.js`) works one of two ways. With the recovery key plus an ECDH proof (`resetKeyProof`), the identity key is kept. Without it, the old public keys go to `user_key_history`, a new identity is created, and the user's own `server_keys` rows are deleted (no rotation). `GET /users/:id` and the `/bootstrap` users list carry those as `pastKeys`; a device trusts one only if it pinned it itself, for things written before it was retired, and labels anything else "Older key — not verified". Account deletion erases the private keys but keeps the public ones. At start-up the app refuses keys the server lists for the user that the password doesn't unlock.

**Legacy plaintext.** Rows with no ciphertext are served as `legacy` and labelled "sender not verified". `instance_settings.e2eeSince` (set once) is sent in `/bootstrap`; each device remembers the earliest value it was told and hides legacy channel messages dated after it, except bot posts from the news bot or a bot account.

**What the server can and cannot read** (assuming it serves the shipped client JS):
- **Cannot read:** channel, group and DM message text; attachment contents, file names and types; poll questions and options; Recall items; saved-message notes; voice and video media; passwords; recovery keys; private keys; group keys; search words. A data export (`POST /me/export`, step-up, a 30-minute token tied to the session) hands out ciphertext; the app decrypts it and builds the zip on the device.
- **Can read:** usernames, emails, profiles and profile pages, avatars and other public media, IPs, user agents, session metadata, membership, roles, timeouts, channel names and topics, who posted where and when, reply and thread structure, pins and pin history, reaction emoji, poll vote indexes, events, the @mention user IDs the client sends (also stored in `mention_marks`), which messages each person saved, read positions, notification preferences and quiet hours, attachment counts and exact sizes, presence, game and music activity, call participation, watch-together URLs, report evidence submitted by reporters, push endpoints, GIF picks (`/gifs/used`) and proxied GIF loads (the media token names the user and session), search metadata (scope, author, time window, paging), and what people type after a slash command, which passes through the server to the bot (warned first, not stored).
- **Can read with `secret.key`:** legacy pre-E2EE messages, news-bot and bot posts, TOTP secrets, bot webhook secrets and the sealed settings.
- All three clients run JavaScript served by the server, and the E2EE keys are derived in that JavaScript (SECURITY.md describes this).
- Private channels use the same server group key as the rest of the server. The server controls who receives their events (`toChannel`).

## 5. Voice and video

- **Mesh.** `public/js/voice.js` builds a full-mesh WebRTC call. A newcomer is the initiator toward every existing peer. Each peer connection has four fixed transceivers (mic, camera, screen, screen audio), switched with `replaceTrack`. Media is DTLS-SRTP between browsers. ICE candidates that arrive before or while an offer is verified are queued and applied in order.
- **Call engine.** One state machine (`TRANSITIONS`): `idle → joining → connecting → connected`, plus `degraded` (some connections down), `reconnecting` (lost the server), `switching` (region change), `failed` (with Retry) and `leaving → idle`. Any other transition is refused and logged; the UI reads only `state`. A 2-second `tick` notices a wake from sleep (a gap over 15 s); waking, the `online` event and the tab becoming visible run `healthCheck`. A connection that isn't up within 12 s, or goes `disconnected` or `failed`, gets up to two ICE restarts (1 s, then 2 s, with jitter), then one fresh connection, then a Retry button (`PEER_RECOVERY`). On `devicechange` or a revoked permission the app swaps a new microphone into lane 0 without renegotiation, or goes listen-only.
- **Signaling** goes through Socket.IO.
  - `voice:join` checks one of two cases. For a DM call, the user must be a participant and not blocked. For a channel, `requireChannel`, `type === 'voice'` and CONNECT must pass.
  - It returns the peers (socket ID and a `reconnecting` flag), `canSpeak` and the call's `region` and `regionVersion`. It rings callees on the first join (`call:ring` plus web push). `call:decline` is accepted only from someone who was rung or could join.
  - `voice:signal` relays `data` (at most 64 KB) only to a socket in the same room, and the server sets `from`/`userId` itself.
  - SDP offers and answers are ECDSA-signed over `hearth-voice|room|from|to|type|sdp`. The receiver verifies them against the sender's TOFU-pinned signing key (`secure.js` `verifySdp`). ICE candidates are unsigned.
  - Permission changes are re-checked mid-call (`recheckVoice`, run by `emitServer` after role, override, membership, ownership and timeout changes): losing CONNECT or VIEW removes the user from the call; losing SPEAK sends `voice:perms` and keeps them shown muted.
- **Grace and resume.** On `disconnect` the server keeps the member's place for `VOICE_GRACE_MS` (default 18 s, clamped to 1–60 s), shown as `reconnecting` in `voice:state`; a timer then calls `leaveVoice`. The app sends `voice:join {resume:true}` when Socket.IO is back (`rejoin`: 0.5 s doubling to 10 s with jitter, 8 tries, failed after 60 s; `REJOIN`). The server resumes only for the same session (`socket.data.sid`), after the join checks run again. It moves the place to the new socket and sends `voice:peer-joined {resumed:true}`, and the others re-point their existing `RTCPeerConnection`; connections that stayed up are kept. `voice:leave` from that session, or `revokeSessions`, ends a kept place. Call state (`voiceChannels`, `userVoice`, `watchRooms`) is still in memory: after a restart a resume becomes a fresh join that doesn't ring.
- **Who is in the call.** The app keeps the server's list (`setListed`, from every `voice:state`) next to its own connections. A connection to someone the server has never listed shows a warning on the call stage and in diagnostics (`unlistedPeers`). One to someone the server stopped listing is closed after 20 s (`UNLISTED_GRACE`).
- **Diagnostics** (`public/js/call-diagnostics.js`, refreshed every 2 s): for each of this device's connections, `getStats` numbers summarized in `voice.js` (round trip, loss, jitter, available send rate, audio level, frame rate, resolution, path type, relay region), restarts, set-up time and a connection log, plus the call log, the last region-switch time and media gap. It never shows addresses or device ids.
- **ICE / TURN.** STUN defaults to Google's servers (`STUN_URLS`). `iceServersFor` adds the main relay (the `turnUrls` setting or `TURN_URL`) and every region seen in the last 3 minutes (`REG.liveRelays`).
  - With a TURN secret set, credentials follow the coturn REST scheme: username `<expiry>:<uid>`, credential base64 HMAC-SHA1(secret, username). The expiry is rounded to a 6-hour boundary, 12–18 hours ahead, so a user has at most three logins alive and coturn's per-user quota applies per person. Each entry carries `expiresAt`; the app refreshes through `GET /api/ice` (60 per hour) before it runs out. The same credential works on every relay.
  - Without a secret, the static `TURN_USERNAME` / `TURN_CREDENTIAL` are used, and the server logs a warning at start-up. The list is delivered in `/api/bootstrap` (and `/api/ice`).
- **Regions.** `relays.js` `rankRelays` measures each relay and caches the result for 6 hours. `chooseIce` uses STUN plus the two fastest relays. `POST /api/calls/region` pins a call to one region (`channels.rtc_region` / `dm_channels.rtc_region`), which forces `iceTransportPolicy: 'relay'`. In a server channel this needs Manage Channels. In a DM or group, any participant can do it. Each change bumps `rtc_region_v` in the same `UPDATE … RETURNING`, and `call:region` carries that version. The app applies a change only if it isn't older than the one it has (`applyCallRegion`) and rebuilds its connections, showing `switching`, when the region they were built with (`S.callNet`) differs. A pinned region that is offline, or whose relay doesn't answer, falls back to automatic relays.
- **Watch together.** The server keeps the shared player state (at most 64 KB, links up to 2,048 characters, 25 queued items) and rebroadcasts it to `voice:<room>`, merging bursts. In host-only mode only the host skips; a "video ended" report from others advances the queue once most of the call has sent it. It fetches YouTube or Vimeo oEmbed titles. The client's player iframes are sandboxed.
- **What each party sees.**
  - A relay sees encrypted SRTP, packet sizes and timing, peer IPs, and the TURN username (which contains the user ID).
  - A region VPS also holds the instance-wide TURN secret and stores encrypted `.hbk` backups.
  - The Hearth server sees who is in each call, the mute, video, screen and reconnecting flags, and all signaling, including the SDP and the ICE candidates with their IPs.
  - In a direct (non-relayed) connection, peers see each other's IPs.

## 6. Files and uploads

- **Storage.** Uploads go into a flat `data/uploads/`. File names are generated (`newId` + 6 random bytes + a safe extension). Encrypted blobs always get `.bin`. Unfinished resumable uploads wait in `data/upload-parts/<id>.part` (folder 0700, files 0600), which is never served and never backed up. Other folders are `data/cache/art` (activity picture cache, pruned to 400 MB), `data/downloads` (installers and the update feed) and `data/backups`.
- **One-request uploads.** Multipart through multer, behind `auth` and `limited(kind, …)`. `limited` applies the rate limits, refuses blocked accounts, allows at most 4 uploads in progress per user (429 `busy`), and caps the file at the smallest of the per-file limit, the quota left and the day's allowance left. Multer also gets `FORM_LIMITS`: 8 text fields of 16 KB, 10 parts (400 `form_limit`). Public pictures (`image` and `gif` kinds) then go through `imagemeta.js` in a worker thread, which strips EXIF/XMP/IPTC/comments/trailing data from JPEG, PNG and WebP (orientation kept) and refuses what it can't clean (400 `bad_image`); a worker that stalls for `IMAGE_STRIP_LIMIT_MS` is replaced. Finally `overLimit` re-checks quota and allowance synchronously before `recordFile`, so parallel uploads can't overrun them. The file is deleted again if the response status is 400 or higher. Route-level permission checks run after the upload.
- **Resumable uploads** (`server/storage.js`, used by the app for attachments over 8 MB, `CHUNKED_ABOVE`).
  - `POST /api/uploads {size}` checks the per-file limit, quota and allowance (`overLimit`), at most 4 unfinished uploads per user, and free disk minus a 64 MB margin (507 `disk_full`). With no `await` in between, it reserves the room as a `user_files` row of kind `reserved` (`upload-<id>`), so every quota check counts it.
  - `PUT /api/uploads/:id?offset=N` takes `application/octet-stream` chunks in order, at most `chunkSize` (4 MiB, `UPLOAD_CHUNK_BYTES`), one request at a time per upload (409 `busy`). A wrong offset gets 409 `offset_mismatch` with the server's byte count; bytes past the last confirmed size are cut off first. `GET /api/uploads/:id` says where to carry on.
  - `POST /api/uploads/:id/complete {sha256}` hashes the part file and compares in constant time. A match is renamed into `data/uploads/` as a new `.bin` and, in one transaction, the reservation is swapped for the real `user_files` row and an unlinked `blobs` row. A mismatch drops the upload. `DELETE` cancels it. Each upload belongs to the account that started it (anyone else gets 404); account deletion and "delete all their files" cancel unfinished uploads.
- **Kinds.**
  - `/upload/encrypted`: attachments, no type filter. It creates a `blobs` row with `message_id` NULL.
  - Image routes (avatar, banner, background, page background, server icon and media, emoji): filtered on extension plus the declared `image/*` type; metadata stripped.
  - `/me/song`: audio (ID3 tags are not stripped).
  - `/gifs/library`: through `limited('gif')`, counted in `user_files`, refused when GIFs are off. Uploads from before v17 are counted once at start-up (`indexLibraryUploads`).
  - Two server-side downloads: emoji from GIPHY (rate limited, name checked first) and GIF "learn" (`/gifs/used`, only for GIFs this server returned in a search in the last 6 hours).
- **Linking and cleanup.** `attachBlobs` links blobs to a new message only if the sender uploaded them and they are not yet linked. An hourly job deletes blobs still unlinked after 24 hours. `removeMessageFiles` runs on message, channel and server deletes; deleting a server or group (or its last member leaving) also removes its emoji, icon, banner, background, reactions and poll votes. A daily sweep (`sweepOrphans`) removes leftovers whose message is gone. `storage.sweep_uploads` removes uploads idle for a day (`UPLOAD_SESSION_IDLE_MS`), uploads whose part file is missing, part files with no upload, and reservations with no upload.
- **Admin storage tools.** `GET /api/admin/storage/report` (admins, 30 per 10 min): use per person and per server, DMs, files not posted yet, unfinished uploads, free disk, and a dry run of orphans. A file counts as referenced if a live blob, the GIF library, any `/uploads/<name>` in any text column of any other table, or an opened server-sealed message points at it (`references`). `POST /api/admin/storage/cleanup` (step-up, 10 per hour, audit-logged as `storage_cleanup`) works the list out again with no `await` before deleting, and refuses (409) while any sealed message body can't be opened. `GET /api/me/storage/files` lists a person's 50 biggest files and unfinished uploads.
- **Serving.**
  - `GET /uploads/:file` needs no auth. It checks the name against a regex and takes the content type from an extension whitelist; anything else is sent as an `octet-stream` attachment. It sets a sandbox CSP. `sendFile` answers Range requests (206, and 416 with `Content-Range: bytes */<size>`). `.bin` blobs are `private, no-cache` (a cheap 304, so a deleted file stops loading at once); other uploads are `private, max-age=31536000, immutable`.
  - `/media/gif`, `/media/art` and `/media/news` are proxies. They need a 7-day media token `uid.sid.exp.sig` (`mediaToken`, sent in bootstrap) that `checkMediaToken` accepts only while that session is live and the account isn't suspended or deleted.
  - `/media/game/:id` is public for catalogued games.
- **Client side.** `public/js/attachments.js` (`cleanFiles`, `isUploadUrl`, `safeDownloadHref`) drops decrypted attachment entries that don't point at `/uploads/<name>` on this server. The client (`public/js/media.js`) resizes and re-encodes chat images before encrypting them. The real attachment list is inside the ciphertext, so `ATTACH_FILES` is enforced only on the declared `files` list. `files.js` uploads with progress, retries a dropped chunk upload with back-off (`uploadResumable`), downloads with progress and carries on with a Range request after a cut (`download`), and keeps decrypted copies as `blob:` URLs in a 256 MB least-recently-used cache that never revokes one still on screen and is released on sign-out (`makeUrlCache`). Pictures open in a gallery (`openViewer` in `app.js`); videos and songs play inline from a `blob:` URL, and encrypted ones over 20 MB download only when pressed.

## 7. Background jobs and timers

All of these run inside the single server process. Their state is in memory or SQLite, and nothing coordinates them across processes. Recurring work goes through `server/jobs.js`: `jobs.every(name, ms, fn, {firstDelay})`, `jobs.after(name, ms, fn)` and `jobs.job(name, fn)` (a wrapped function for debounce timers). A wrapped run catches and logs errors with the job's name, records health (§12), and skips a run while the previous one is still going. Rows marked *plain timer* use `setTimeout`/`setInterval` directly. Line numbers are as of schema 18.

| Job | Location | Interval | What it does |
|---|---|---|---|
| `ratelimit.sweep` | `server/index.js:116` | 60 s | Drops expired rate-limit buckets. |
| `uploads.unlinked_cleanup` | `server/index.js:830` | 1 h | Deletes `.bin` blobs never attached to a message after 24 h. |
| `uploads.orphan_sweep` | `server/index.js:845` | first after 2 min (`ORPHAN_SWEEP_DELAY_MS`), then daily | Removes blobs, reactions, poll votes and mention marks whose message is gone. |
| `sessions.purge` | `server/index.js:1090` | 1 h | Deletes sessions revoked, expired or idled out more than 30 days ago. |
| Push queue | `server/index.js:1208` (`pumpPush`), `1266` (`pushTo`) | on demand | Sends after the response to people with no open socket whose preferences allow it: 16 at once, 2 per user, 8 per push host; failing endpoints back off from 1 minute to 1 hour and are dropped after 8 failures. |
| `presence.flush` | `server/index.js:1732` | 1 s debounce | Batches presence broadcasts (to every socket). |
| `users.flush_updates` | `server/index.js:1765` | 1 s debounce | Sends `user:update` to the people who share a server, friendship or DM with the user. |
| `captcha.sweep` | `server/index.js:3896` | 60 s | Clears used-captcha and failure maps. |
| `pages.view_sweep` | `server/index.js:4478` | 10 min | Clears the profile view-count map. |
| `events.reminders` | `server/index.js:4698` | 60 s | 15 min before an event: `event:starting` socket event and web push to members' RSVPs marked going or maybe. |
| `backup.daily` | `server/index.js:5057` | hourly check, first after `BACKUP_FIRST_CHECK_MS` (1 h) | If the last backup is more than 23.5 h old: plain DB copy, then encrypted backup (section 11). Raises an alert and fails the job on error. |
| `watch.emit` | `server/index.js:5251` | 250 ms throttle | Sends merged watch-together state, at most 4 times a second per call. |
| `sockets.session_sweep` | `server/index.js:5302` | 60 s | Disconnects sockets of dead sessions and touches `last_used_at` for live ones. |
| Socket flood refill (*plain timer*) | `server/index.js:5347` | 1 s per socket | Refills the event buckets and forgives strikes. |
| `voice.grace_end` | `server/index.js:5613` | `VOICE_GRACE_MS` per dropped call member (one-off, run as a safe job) | Ends a kept call place that wasn't resumed. |
| Start-up tasks | `server/index.js:5628`–`5629`, `5634`, `5635` | once; leftovers again after 11 min | Indexes old uploads and GIF-library uploads once (inline), then `backup.cleanup_leftovers` removes backup leftovers untouched for 10 minutes. |
| Shutdown (*plain timer*) | `server/index.js:5659`, `5666` | on SIGTERM/SIGINT | Saves job records, emits `server:restarting`, closes after 250 ms (WAL checkpoint and close), hard exit at 4 s. |
| Picture-cleaning worker (*plain timer*) | `server/imagemeta.js:349` | per picture, 15 s watchdog | Replaces a stalled worker and refuses the picture it was on. |
| `accounts.token_purge` | `server/accounts.js:148` | 1 h | Deletes expired `auth_tokens`. |
| `activity.art_cache_prune` | `server/activity.js:137` | 30 s after start, then 1 h | Keeps `data/cache/art` under 80% of the cap. |
| `activity.broadcast` | `server/activity.js:283` | debounce | Batches `user:activity` events. |
| `activity.expire` | `server/activity.js:335` | 30 s | Clears stale game and music status. |
| `activity.lastfm` | `server/activity.js:500` | 10 s | "Now playing" for opted-in online users, each user at most every 30 s or more. |
| `newsbot.feeds`, `newsbot.trackers` | `server/newsbot.js:290`, `291` | 60 s (first run at 20 s) | `tick`: server feeds due every 10 min, 20 per tick. `userTick`: personal trackers due every 30 min, 30 per tick. Feeds are parsed in a worker with a 5 s limit (`FEED_PARSE_LIMIT_MS`). |
| `money.supporter_expiry` | `server/money.js:82` | 1 h (first run at 20 s) | Removes the supporter flag once `supporter_until` has passed. |
| `memberships.reconcile`, `memberships.retry_cancellations` | `server/memberships.js:468`, `469` | 1 h (cancellations also 5 s after start) | Re-reads overdue Stripe subscriptions (up to 50) and retries queued cancellations of deleted servers' memberships. |
| `storage.sweep_uploads` | `server/storage.js:266` | 10 min (`UPLOAD_SWEEP_MS`), first after 1 s | Removes idle or broken resumable uploads, stray part files and orphan reservations. |
| `bots.deliveries` | `server/bots.js:243` | 5 s (first at 1 s) | Safety net for the delivery pump; the pump also wakes itself for the next retry and after each send, through the same safe job (`pumpSafely`, `bots.js:195`). |
| `bots.prune_deliveries` | `server/bots.js:245` | 1 h | Keeps delivered events 3 days and dead letters 30 days, at most 500 per bot. |
| Slash-command timeout (*plain timer*) | `server/bots.js:658`, `620` | 10 s per command (`BOT_INTERACTION_TIMEOUT_MS`) | Tells the person the bot didn't answer; forgets the interaction 60 s later. |
| `health.sample` | `server/health.js:57` | 60 s (first at 15 s) | Records the minute's p99 and max event-loop lag. |
| `alerts.check` | `server/health.js:190` | 60 s (first at 90 s) | Raises or clears disk-space and region-down alerts. |
| `usability.end_timeouts` | `server/usability.js:395` | 60 s (first at 5 s), plus a one-off run per timeout as it ends (`usability.js:377`) | Deletes ended timeouts and sends `timeout:update` and `server:update`. |
| `usability.sweep_stale` | `server/usability.js:396` | daily (first at 90 s) | Deletes read markers and preferences of deleted channels, DMs and servers. |
| Export token sweep (*plain timer*) | `server/usability.js:445` | 60 s | Forgets expired data-export tokens. |

Outside the server process:
- Region agent: a systemd timer runs it every 60 s on each region VPS. The timer is defined in the install script in `server/regions.js`.
- Docker `HEALTHCHECK`: every 30 s, on `/api/health/live`.
- Client side: message reminders kept in `localStorage`, checked every 20 s (`public/js/features.js`); a service-worker update check every 30 min and a relay-login check every 10 min (`public/js/app.js`); the call engine's 2-second `tick` during a call.
- Desktop: an update check 15 s after start and then every 4 h (`desktop/main.js`).

## 8. Outbound requests

Every place the server process makes a network request. `netguard.request` (in `server/netguard.js`) resolves the host once, refuses the request if **any** address is private, loopback, link-local, CGNAT, multicast, reserved or special-purpose (IPv4 inside IPv6 included), or one of this server's own addresses on a port other than 80/443, or listed in `OUTBOUND_BLOCK`; then connects to exactly the checked address (no rebinding), follows redirects by hand re-checking each hop, applies one deadline to the whole request, caps the answer while it streams (counting unpacked bytes), and stops unpacking the moment it refuses. Public names are resolved with Node's own DNS client; system lookups (local names) run at most two at a time.

| Caller | File / function | Target | Guard |
|---|---|---|---|
| Server feeds, personal trackers, YouTube handle lookup, `/media/news` | `server/newsbot.js` `safeGet` / `assertPublic` | Google News, Reddit, Steam, GitHub, YouTube, or any http(s) URL (`rss` kind) | `netguard.request`: 4 redirects, 3 MB (8 MB for images), 12 s for the whole request, parsing in a worker. `FEED_ALLOW_PRIVATE=1` is for tests only. |
| Bot webhooks | `server/bots.js` `post` (from the delivery pump and slash commands) | the bot's webhook URL, checked when saved (`checkWebhookUrl` → `netguard.checkPublicUrl`) | `netguard.request`: https only, public addresses (`BOT_WEBHOOK_ALLOW_PRIVATE=1` lifts that), no redirects, 5 s (`BOT_WEBHOOK_TIMEOUT_MS`), 64 KB answer, not unpacked. Signed `X-Hearth-Signature: v1=` HMAC-SHA256 over `<timestamp>.<body>` with the sealed webhook secret. 4 at once per bot (`BOT_MAX_CONCURRENCY`), 64 in all; 6 attempts with back-off from 15 s (doubling, ±25%, at most 1 h), then a dead letter. A slash command is sent once, never queued. |
| Game/music search and lookups | `server/activity.js` `getJson` | Steam store, Wikipedia, RAWG, Last.fm, iTunes; Spotify, YouTube and SoundCloud oEmbed | fixed hosts (env-overridable bases), 8 s timeout |
| Music link pages | `server/activity.js` `getText` via `safeFetch` | music.apple.com, bandcamp.com | `netguard.request` + https host allow-list on every hop, 1 MB truncating cap |
| Art proxy and cache | `server/activity.js` `fetchImage` via `safeFetch` | `ART_HOSTS` (+ `ART_PROXY_EXTRA_HOSTS`, which may be local) | `netguard.request` + host allow-list on every hop, 3 redirects, 15 s, streamed 6 MB cap |
| GIF search | `server/index.js` `gifFetch` | `api.giphy.com` / `api.klipy.com` (`GIPHY_API_BASE`, `KLIPY_API_BASE`) | 8 s timeout |
| GIF media proxy | `server/index.js` `/media/gif` → `fetchGifMedia` | `MEDIA_HOSTS` (+ `GIF_PROXY_EXTRA_HOSTS`) | host allow-list re-checked on each of up to 3 redirects, session-bound media token, 15 s, 20 MB, streamed |
| Emoji from GIPHY | `server/index.js` `/servers/:id/emojis/from-giphy` → `fetchGifMedia` | `MEDIA_HOSTS` | same, `readLimited` 2 MB |
| GIF "learn" | `server/index.js` `/gifs/used` → `fetchGifMedia` | `MEDIA_HOSTS` (+ `GIF_PROXY_EXTRA_HOSTS`) | same, `readLimited` to the library's per-file cap |
| Watch-together title | `server/index.js` `watchTitle` | youtube.com / vimeo.com oEmbed | 4 s timeout |
| Stripe API | `server/memberships.js` `stripe()` | `api.stripe.com` (`STRIPE_API_BASE`) | 15 s timeout |
| Web push | `server/index.js` `sendPush` → `netguard.request` (body built by `web-push`) | endpoint from the user's browser (`/push/subscribe`) | https only, public addresses (`PUSH_ALLOW_PRIVATE=1` lifts that), no redirects, 10 s, 64 KB answer; checked again at subscribe and before each send; 10 subscriptions per user, tied to the session that made them |
| Email (account mail and owner alerts) | `server/accounts.js` `sendMail` → nodemailer | the configured SMTP host | 15 s connect and greeting timeouts |
| Off-site backup | `server/backup.js` `uploadOffsite` → `rclone` child process | `BACKUP_RCLONE_REMOTE` | 6 h timeout |
| Region backup | `server/regions.js` `sftpPut` → `sftp` child process | region IP reported by its heartbeat (must be public) | `StrictHostKeyChecking=yes`, host key pinned per region |

Inbound webhooks (`/api/pay/kofi`, `/api/pay/stripe`, `/api/pay/memberships`), bot API calls, health probes and region heartbeats arrive at the server and make no outbound calls. `server/fetchlimit.js` (`readLimited`) gives the plain-`fetch()` callers a streamed size cap. Outside the server process, `node server/cli.js doctor --relays` opens a TCP connection to each region's TURN port (3 s).

## 9. Packaging and updates

**Server.**
- The `Dockerfile` has two stages on `node:22.23-bookworm-slim`. It runs `npm ci --omit=dev`, removes npm from the runtime image, installs `openssh-client` for region backups, and sets a `HEALTHCHECK` on `/api/health/live` (https first unless `HTTPS=false`, then the other scheme).
- `deploy/docker-entrypoint.sh` drops root to uid 1000.
- `docker-compose.yml` defines three services. `hearth-perms` is a one-shot chown. `hearth` runs read-only with `cap_drop: ALL`, port 3000 and `TRUST_PROXY` defaulting to the Caddy network. `caddy` is under the `domain` profile, on `10.231.47.0/28`.
- The alternative is systemd with `deploy/hearth.service` (`Restart=on-failure`, which also restarts after an uncaught exception, §12).

**Server updates** are manual. `scripts/make-update-zip.sh [folder]` builds `hearth-update-<v>.zip` from the last commit plus a `.sha256` (default folder `hearth/dist`). `scripts/hearth-update.sh` (run as root, often uploaded by `tools/update-hearth.sh` or `Update-Hearth.ps1` over SSH) does the following:
1. Takes the zip path (required). If `<zip>.sha256` is next to it, a mismatch stops everything; otherwise it prints the SHA-256 to compare. The tools upload into the account's home under a random name, then the install command moves it into a private `mktemp -d` folder and checks it against the hash the tool computed before running the updater from it.
2. Detects how Hearth runs: Docker, systemd, pm2 or plain. In plain mode it restarts Hearth (and installs libraries) as the owner of `data/`, never root, unless root itself started it (a warning then).
3. Backs up the code and `data/` (without uploads, upload-parts, backups and downloads) to `/root/hearth-backups`, keeping 5. No fixed `/tmp` names are used.
4. Builds in a staging folder (`npm ci`).
5. Rsyncs the new files, skipping `data/`, `.env`, the compose file and the Caddyfile. For older Docker installs it adds `TRUST_PROXY=<the proxy network's subnet>` to `.env`.
6. Restarts Hearth and checks `/api/config`, rolling back automatically on failure. The database upgrade itself runs in one transaction after a `hearth-before-v18-*` copy (§3).

**Web client.** The server serves the client directly. `/sw.js` is versioned by a hash of the `public/` files. On reconnect the client compares `/api/config` `version` and reloads if it changed.

**Desktop.**
- electron-builder targets Windows NSIS, macOS dmg, and Linux AppImage and deb.
- `electron-updater` uses the generic provider with its feed set to `<chosen server>/updates/`, served from `data/downloads`. `autoDownload` is on, `autoInstallOnAppQuit` is off, and installing always waits for a native confirmation dialog.
- With `updatePublicKey` set (baked in CI by `build/sign-update.js bake` from the `UPDATE_SIGNING_KEY` secret), `update-verify.js` accepts an update only when `latest*.yml.sig` is a valid Ed25519 signature over that file and its name, the version is newer, and the installer's SHA-512 is one the signed file lists (checked again before it runs). Without a key the dialog says the update can't be verified.
- Updating is disabled on macOS and in unpackaged builds.
- `desktop/build/configure-signing.js` picks the Windows signing method: Azure, pfx, SignPath or none. `after-signing.js` rewrites the sha512 in `latest.yml`, after which CI signs the `.yml` files.
- Navigation, IPC and redirects are checked with exact origins (`origin.js`); a start page that redirects elsewhere opens in the browser and shows the connect screen. Mic, camera and clipboard-read need a native yes per server; screen capture goes through `picker.html`, and a legacy `chromeMediaSource:'desktop'` capture is ended by restarting the renderer about 3 s after the pick. `beforeunload` is ignored.

**Android.** The app UI is remote, so it changes whenever the server updates. CI builds the APK with `npm ci` and copies every `native/*.java`. The signing key comes from secrets, or is generated once and kept in the Actions cache. Release builds can be uploaded to Google Play internal testing. Users get the APK from `data/downloads` (the `/download` page) or a GitHub release.

## 10. CI/CD workflows

- **`.github/workflows/hearth-security.yml`**
  - *Triggers:* push to any branch or PR touching `hearth/**` or `.github/**`, a weekly cron, and manual runs.
  - *Settings:* `contents: read`, actions pinned to SHAs, `persist-credentials: false`.
  - *Jobs:* `tests` (`npm ci`, `npm test`); `audit` (`npm audit --omit=dev --audit-level=high`, which fails for the server and only reports for desktop); `secrets` (gitleaks, binary checksum verified); `image` (`docker build`, then Trivy image and config scans); `codeql` (JavaScript, with `security-events: write`); `upgrade-drill` (full history checkout, `npm ci`, `bash scripts/upgrade-drill.sh c55a9dc HEAD`, then `node scripts/recovery-drill.js`). Playwright and Electron aren't installed there, so the browser and Electron tests skip themselves in CI.
- **`.github/workflows/hearth-apps.yml`**
  - *Triggers:* push to any branch touching `hearth/desktop/**`, `hearth/mobile/**` or the workflow file; `app-v*` tags; manual runs with an optional `server` input (or the `HEARTH_SERVER` repo variable; empty falls back to the committed config).
  - *Settings:* workflow-wide `contents: read`; only `release` has `contents: write`. Every action is pinned to a commit, checkouts use `persist-credentials: false`, desktop and Android install with `npm ci`, and `@capacitor/assets` is a pinned devDependency.
  - *Jobs:* `desktop` (Windows, macOS and Linux matrix, with Windows signing, SignPath for release builds, and update-file signing when `UPDATE_SIGNING_KEY` exists); `android` (builds and signs the APK, optional Google Play upload); `release` (tags only, creates a GitHub release).
  - `publish-to-vps` runs for `app-v*` tags and the default branch only. It uses the runner's own `ssh`/`scp`: `VPS_HOST_FINGERPRINT` is required and turned into a `known_hosts` entry from `ssh-keyscan` output, and the installers, `latest*.yml` and `.sig` files are copied with `StrictHostKeyChecking=yes`; it then keeps the two newest of each.
- **`hearth/.github/workflows/desktop.yml`** does not run in this repository, because GitHub reads only the root `.github/`. It is kept for standalone use (`desktop-v*` tags) and follows the same pinning and permission rules.
- **`.github/dependabot.yml`**: weekly updates for npm (server, desktop, mobile), GitHub Actions, Docker and docker-compose.
- **Tests:** `npm test` runs `node --test --test-concurrency=1 test/*.test.js`. `test/helpers.js` spawns real server instances in temp data folders and solves robot checks with the app's own solver. `test/recovery-upgrade.test.js` upgrades a committed v16 fixture (`test/fixtures/upgrade-v16-c55a9dc.hfx.gz`). Browser suites need Playwright and Chromium and run outside CI: `npm run test:e2e` (`test/e2e`, several people in the real app), `npm run test:voice` (`test/e2e-voice`, two browsers in a call), `npm run test:a11y` (`test/a11y`) and `npm run test:visual` (`test/visual`, baselines made on the checking machine). Benchmarks, also outside `npm test`: `scripts/bench.js` (server, seeded dataset), `scripts/bench-client.mjs` (`npm run bench:client`), `scripts/bench-search.js` and `test/data-bench.js`.
- No workflow deploys the server itself.

## 11. Backups and restore

```text
jobs.every('backup.daily'), hourly check (server/index.js)
  ├─ makeBackup('auto')     db.backup() → data/backups/hearth-auto-<ts>.db   (plain SQLite, local, keep N)
  └─ makeEncryptedBackup()  backup.js createBackup → verifyBackup → uploadOffsite (rclone) → regions copyBackup (sftp) → prune
```

- **Encrypted backup** (`server/backup.js` `createBackup`):
  1. `db.backup()` takes a consistent snapshot into `data/backups/.tmp/` (created with mode 0700), never into `data/backups/encrypted/`.
  2. `referencedFiles` reads which upload files the database refers to (`blobs`, `user_files` except `reserved`, `gif_library`) before the folder is listed.
  3. The snapshot, `secret.key`, `vapid.json` and every file in `uploads/` are streamed into `encrypted/hearth-<ts>.hbk.part`. An upload deleted while the backup streams is left out instead of failing it.
  4. Encryption is AES-256-GCM in 1 MiB chunks. The key is HKDF-SHA256(backup key, 32-byte random salt). Each nonce is a 7-byte random prefix, a u32 counter and a last-chunk flag. The header is the AAD.
  5. The `.part` file is renamed to `.hbk` and the snapshot is deleted. A failure leaves no `.part`. Referenced files that weren't on disk are returned as `missing`: the backup is kept, and the gap is logged, audit-logged (`backup_files_missing`) and saved in its status.
  6. `verifyBackup` decrypts into `data/backups/.verify-*`, runs `PRAGMA integrity_check` and counts rows.
  7. Copies go to `BACKUP_RCLONE_REMOTE`, if set, and to each live region with backup space. A region keeps `REGION_BACKUP_KEEP` copies (default 14).
  8. Retention keeps the newest `keep` backups and the newest backup of each of the last `keep` days; each one removed is logged as `backup_pruned`. Status goes into the `backupStatus` setting. Failures are logged, audit-logged and raised as alerts (`backup_failed`, `backup_verify_failed`, `backup_offsite_failed`).
- **Leftovers:** `cleanStale` removes `.part` files and `.tmp` snapshots at shutdown, at start-up (if untouched for 10 minutes, checked again 11 minutes later) and before each new backup, so a CLI backup running across a restart isn't broken.
- **Not inside an `.hbk`:** `backup.key`, the TLS cert and key, the region SSH key, `data/downloads`, `data/upload-parts` (unfinished uploads), `audit-anchor.json` (a restore into a new folder starts a new anchor, logged as `audit_anchor_reset`).
- **Policy:** the `autoBackup` setting (default on, keep 7). Lowering `keep` or turning it off needs step-up.
- **Manual (owner only):** `POST /api/admin/backups` (6 per hour), plus verify, download (`.hbk` only) and delete (step-up). `POST /api/admin/backups/key` shows the key after step-up, unless `BACKUP_KEY` is set in the environment.
- **Restore** (`restoreBackup`, `node server/cli.js restore FILE NEW_DATA_DIR [KEY] [--sign-out-everyone]`):
  - The target must be empty. A `RESTORE-INCOMPLETE` marker is written first and removed only as the last step, and `db.js` refuses to start in a folder that has it. On any failure everything unpacked is removed and the marker stays, with the reason.
  - A backup whose database version is newer than this code is refused (`HEARTH_BACKUP_TOO_NEW`, exit 2). The restored database must pass `integrity_check`, and `uploadReport` compares it with `uploads/` (missing files give exit 3). `--sign-out-everyone` revokes every session in the copy (`revoke_reason = 'restored'`).
- **CLI:** `node server/cli.js backup | verify-backup FILE [KEY] | restore … | check-files | doctor | set-owner USERNAME`. `check-files` compares the live database with `data/uploads/`. `verify-backup` warns when a backup is newer than this code. Exit codes (the doctor's are in §12): 0 done, 1 failed, 2 restore refused, 3 done with files missing.
- **Drills:** `scripts/recovery-drill.js` runs the app's own crypto against throwaway servers to show what each recovery path restores. `scripts/upgrade-drill.sh` (with `scripts/upgrade-drill.js`) fills an older release through its API, upgrades it in place, kills one upgrade half-way, and checks sign-in, keys, files, sealed secrets and the audit log. Both run in CI (§10); `npm test` runs the drill's steps (`test/recovery-drill.test.js`) and a fast upgrade check from a fixture.
- **Other copies:**
  - `db.js` copies `hearth.db` to `data/backups/hearth-before-v18-<ts>.db` before migrating an older schema (never pruned).
  - `hearth-update.sh` keeps 5 code-and-data snapshots in `/root/hearth-backups` for `--rollback`.
  - The Docker image has no rclone. The docs say to run rclone on the host over `data/backups/encrypted/`, with `--include '*.hbk'`.

## 12. Logging and monitoring

- **Logger** (`server/log.js`). It loads before `db.js` and has no dependencies on the rest of the server. Each event is one line: JSON by default, or a readable line when stdout is a terminal or `LOG_FORMAT=pretty`. Every line has `ts`, `level`, `component` and `op`. Lines written during a request carry `reqId`, and lines from a job carry `job` (both from `AsyncLocalStorage`). Errors add `error` (`category`, `name`, `code`, `message`, `stack`) and `errorCategory` (`db_busy`, `disk_full`, `network`, `timeout`, `bug`…). Levels run from debug to fatal (`LOG_LEVEL`, default info); warn and above go to stderr, fatal synchronously. Only `cli.js` still writes with `console.*`.
- **Redaction** happens inside the logger. Fields named like tokens, passwords, keys, signatures, message bodies or ciphertext become `[redacted]`. Free text loses Bearer and Basic credentials, `key=value` secrets, URL query strings, hex runs of 40 or more and base64 runs of 80 or more. IP addresses are cut to /24 or /48 unless `LOG_FULL_IP=true`. User ids appear as `uid`, a 12-hex HMAC keyed from the at-rest key (`userHash`).
- **Access log.** One `http request` line per response: method, route template (`routeOf`, never the real URL), status, `durationMs`, `outcome`, `uid` and the cut IP. `LOG_ACCESS` is `on`, `errors` or `off`. Successful GET and HEAD lines are sampled (`LOG_ACCESS_SAMPLE`, default 0.2). A request over `LOG_SLOW_MS` (default 1000) is always written, at warn, as `slow_request`.
- **Process.** `installProcessHandlers` logs an unhandled rejection and carries on. An uncaught exception is logged at fatal, job records are saved, and the process exits with status 1 for systemd or Docker to restart. Docker keeps output in the json-file driver, rotated at 3 × 10 MB; systemd sends it to the journal; `hearth-update.sh --logs` shows the last 80 lines. Caddy's access log is commented out by default; when enabled, it strips query strings.
- **Job health** (`server/jobs.js`). Each job keeps its last run, last success, last error and its category, failures in a row, totals and skipped runs. A job is `fail` after 3 failures in a row (`FAIL_AFTER`), and `degraded` while failing or late (no run for 3 periods plus 60 s). Records are saved to `job_health` at most once a minute per job, at once when a job starts or stops failing, and all at shutdown.
- **Health endpoints** (`server/health.js`).
  - `GET /api/health/live` (public) answers `{status:'ok'}`. `GET /api/health/ready` (public) answers 503 with codes (`db`, `schema`, `data_dir`, `disk_full`, `maintenance`) when not ready; `disk_low` only degrades it.
  - `GET /api/admin/health` (admins, 120 per minute) reports: database and schema; whether the data folder takes writes (a probe file, at most every 30 s); maintenance; disk (degraded under 10% or 1 GB free, failing under 3% or 200 MB); every job with its status; the news-bot worker; regions; backup freshness and the last restore test (degraded after 26 h, failing after 50 h or a failed test); event-loop lag p99 (degraded over 200 ms, failing over 1 s); memory; sockets; and the alert counters. The overall status is the worst part.
  - `GET /api/admin/stats` (staff) includes the 14-day activity series and `health()`. Region load comes from the heartbeats (Admin → Regions). New reports reach staff live as `admin:report`.
- **Alerts** (`server/alerts.js`).
  - Sources: error-level log lines (`log.onError`; 10 in 10 minutes, `ALERT_ERRORS`); `secEvent` sign-in failures, failed captchas and blocked addresses (50 in 10 minutes, `ALERT_AUTH_FAILS`); a job failing 3 times in a row (`ALERT_JOB_FAILURES`, cleared when it recovers); backup, restore-test and off-site failures; and the `alerts.check` job (low or full disk, a region with no heartbeat).
  - Delivery: `admin:alert` to the `admins` room and, unless email is off, an email to the owner's confirmed address through `accounts.js` `notify` (when mail is set up). Each key is sent at most once per cooldown (default 60 minutes, `ALERT_COOLDOWN_MIN`), and at most 12 alerts go out per hour; held-back ones are counted in the next. State is saved in the `alertState` setting, so a restart doesn't resend. `PUT /api/admin/alerts` sets on/off, email and cooldown (turning either off needs step-up; audit-logged). `POST /api/admin/alerts/test` sends a test (3 per hour). `ALERTS=off` changes the default.
- **Doctor** (`server/doctor.js`, `node server/cli.js doctor`). It is read-only and safe while Hearth runs. It opens the database read-only (from an in-memory copy when Hearth isn't running) and never prints a secret. It checks the Hearth and Node versions, the data folder, the key files and their permissions, the database and schema, disk, TLS, `TRUST_PROXY`, `PUBLIC_URL`, the reverse proxy, `ADMIN_USERS`, SMTP, TURN, regions, the backup key and backup freshness, and the `job_health` records. `--integrity` runs `quick_check`, `--relays` tries each region's TURN port, `--json` prints JSON, and `--fix-permissions` sets key files to 600 and the data folder to 700. Exit status: 0 all passed, 1 warnings, 2 failures.
- **Security log.** `secEvent` keeps an in-memory ring of the last 500 events: failed logins, captcha failures, blocked IPs, step-up and 2FA failures, 2FA changes, resets, capped reset requests and username changes. Each one is also a `security` log line (with the IP cut) and counts toward the sign-in alert. `GET /api/admin/security` shows recent events and the top failing IPs. The ring is lost on restart.
- **Audit log.** The `admin_log` table, written through `auditAppend` (`db.js`), is append-only through triggers. Entries from `auditKeyedFrom` on are chained with HMAC-SHA256 under a key derived from `secret.key`; older entries keep their plain SHA-256 links. The newest entry's id and hash are written, with their own MAC, to `data/audit-anchor.json` after every append (after the commit during an upgrade). `auditVerify` reports edits, deletions (the tail included), NULLed hashes, a changed or missing anchor and a deleted switch-over marker; problems found while appending are logged as `audit_log_gap`. `GET /api/admin/log` and `/api/admin/log/verify` show it to staff ("signed entries since <date>"). Backup results, missing files, storage cleanup, alert settings, timeouts, data exports, bot installs and token changes, payment, membership, GIF, music, relay and region settings are recorded there too.
- External uptime monitors and proxies probe `/api/health/live` and `/api/health/ready`; [OPERATIONS.md](OPERATIONS.md) has Docker, Caddy and monitor examples.

## 13. Where to read more

- [OPERATIONS.md](OPERATIONS.md): logs, request ids, background jobs, health endpoints, the doctor and alerts.
- [STORAGE.md](STORAGE.md): uploads, resumable protocol, Range downloads, media in the app, retention and cleanup.
- [BOTS.md](BOTS.md): scopes, tokens, the bot API, webhook events and signatures, slash commands.
- [RECOVERY.md](RECOVERY.md): account recovery, backups, restore, upgrades and rollback, the drills.
- [FEATURES.md](FEATURES.md): saved messages, pins, unread tracking, notification preferences, drafts, export, timeouts.
- [VOICE.md](VOICE.md): the call state machine, recovery, regions, devices, diagnostics and the voice security analysis.
- [PERFORMANCE.md](PERFORMANCE.md): server and client measurements, the v18 indexes, batched permissions.
- [ACCESSIBILITY.md](ACCESSIBILITY.md): accessibility, responsive layout and the browser checks.
- [ENGINEERING-REPORT.md](ENGINEERING-REPORT.md): the security overhaul and what each fix changed.
- [ROUTES.md](ROUTES.md): every HTTP route (the bot API is in BOTS.md) and socket event, with the audit's notes.
- Also: [SECURITY.md](../SECURITY.md) (guarantees; limits in §4), [RUNNING-HEARTH.md](RUNNING-HEARTH.md) (capacity, regions, costs) and [SIGNING.md](SIGNING.md) (signing the apps).
