# Hearth security model

This is Hearth's threat model and its **security contract**: what Hearth protects, who from, and what happens
when each of them gets in. Every row of the contract is checked by the automated test suite in `test/`. It runs
on every push and pull request (`.github/workflows/hearth-security.yml`), together with dependency, secret and
container scans. Run it locally with `npm test`.

Found a problem? Please tell the server owner privately (not in a public channel), with steps to reproduce.

---

## 1. What we protect

| Asset | Where it lives | How it's protected |
|---|---|---|
| **Messages and files** (DMs, server channels, attachments) | Server database and `data/uploads`, as ciphertext only | End-to-end encrypted on the sender's device: AES-256-GCM with a fresh key per message (HKDF-SHA256), the conversation, author and key version bound in. Channel messages and key handoffs are signed (ECDSA P-256). Plaintext is padded so length doesn't leak. |
| **Passwords** | Never leave the device | Argon2id (64 MiB, 3 passes, per-account salt) in the browser. One half signs in; the server stores only a **bcrypt hash** of it. The other half unlocks your keys and never leaves the device. |
| **Identity keys** (ECDH P-256 + ECDSA P-256) | Private halves on the server, locked | Locked with AES-256-GCM under the password-derived key. The server can't open them. |
| **Recovery keys** | Only with the person (password manager or paper) | 160 random bits. They lock a second copy of the identity key; the server stores only that locked copy. |
| **Sessions** | Server database | Only a **SHA-256 hash** of each 256-bit token is stored. Each session ends when revoked, after 60 days unused, or 365 days after sign-in. Revoking one cuts off its live connection too. |
| **Two-factor secrets and backup codes** | Server database | The TOTP secret is encrypted with the server's key (`data/secret.key`). Backup codes are HMACs keyed with it. Codes are single-use and attempts are rate-limited. |
| **Email addresses** | Server database | Shown only to the account itself, masked in the admin view. Used only for resets and security notices. |
| **Reset links and email codes** | Server database | Stored hashed, single-use, short-lived (30 minutes). |
| **Group membership, who talks to whom, when** | Server database | **Not hidden** (metadata). The server needs it to route messages. |
| **SMTP password, API keys** | Server database or `.env` | Encrypted with `data/secret.key` (database), or kept in `.env`. Never in git. |
| **Study tools data** (decks, assignments, timer settings, stats) | Server database, as ciphertext only | Encrypted on your device with a key derived from your identity key (ECDH with itself → HKDF → AES-256-GCM). Each item is bound to its id and kind, so the server can't swap them. For reminders, the server stores only a time. |
| **Server folders, tracked feeds** | Server database | Not encrypted: they're personal settings the server needs (folders) or acts on (it fetches the feeds). They're only shown to the account itself. |
| **Backups** | `data/backups/encrypted/*.hbk`, plus off-site copies | Encrypted with a separate backup key, made tamper-evident in chunks, and restore-tested when made. |
| **The audit log** | Server database | Append-only (the database refuses edits and deletes), with a hash chain so hand edits to the file are detected. |

## 2. Who we protect against

| Adversary | What they have |
|---|---|
| **Random internet attacker** | Can send any request to the server. |
| **Database thief** | A copy of `hearth.db`, for example from a stolen disk image or backup. Not the running server's memory. |
| **Stolen-session attacker** | One person's sign-in token (malware, a borrowed laptop, a shoulder-surfed token). |
| **Compromised email account** | Can read the victim's email, including reset links. |
| **Malicious user** | Has a normal account and tries to read or change others' data, or climb permissions. |
| **Compromised admin** | A staff account (moderator or admin) turned against the server. |
| **Server compromise** | Root on the VPS, or full control of Hearth's process. |

## 3. The contract

| # | Attack | Expected result | Proven by |
|---|---|---|---|
| 1 | DB stolen | Messages and files stay encrypted; there is no key on the server to open them | `crypto.test.js`, `platform.test.js` › stolen database |
| 2 | DB stolen | Passwords can't be recovered: only bcrypt hashes of an Argon2id-derived key | `auth.test.js` › bcrypt hashes |
| 3 | DB stolen | Sessions can't be used: only token hashes, and a hash isn't a token | `sessions.test.js` › stolen database |
| 4 | DB stolen | Reset links, email codes, backup codes and the 2FA secret aren't usable from the file alone | `recovery.test.js` › reset link stored as hash, `platform.test.js` › no usable secrets |
| 5 | Session stolen | The owner sees it in **Settings → Sessions** and revokes it (or "Log out all other devices"); it dies at once, live connection included | `sessions.test.js` › Sessions lists devices… |
| 6 | Session stolen + password | With 2FA on: can't change the password, email or recovery key, turn off 2FA, or delete the account without a fresh code | `recovery.test.js` › step-up |
| 7 | Session left behind | Logout, password change, password reset and turning on 2FA end the other sessions immediately | `sessions.test.js`, `recovery.test.js` |
| 8 | Old session | Expires after 60 idle days or 365 days in total | `sessions.test.js` › expired session |
| 9 | Email compromised (2FA on) | The reset link alone doesn't work; a 2FA code is needed | `recovery.test.js` › 2FA is needed for a password reset |
| 10 | Email compromised (no 2FA) | The account can be reset, but **only with new keys**: old messages stay unreadable, contacts see "Security key changed", and the owner gets a notice email. Keeping the old keys needs proof of the recovery key. | `recovery.test.js` › keeping keys needs proof |
| 11 | Password forgotten | Email reset plus the recovery key restores the same identity: all old messages stay readable | `recovery.test.js` › recovery-key restoration, `crypto.test.js` › recovery key restores |
| 12 | Reset link misused | Wrong, expired or reused links fail; two racing uses of one link: only one wins | `recovery.test.js` › reset links…, racing |
| 13 | Reset spam / probing | "Forgot password" answers the same for every account and is limited per network and per account (silently, so it reveals nothing) | `recovery.test.js` › forgot password |
| 14 | Password guessing | Limited per network (IPv6 per /64) and per account across all IPs; unknown usernames take as long as wrong passwords | `auth.test.js` |
| 15 | 2FA guessing / bypass | Missing, malformed, wrong and reused codes fail. 8 tries per 15 minutes and 30 per day per account; the owner is emailed after 3 failures | `recovery.test.js` › 2FA… |
| 16 | Ciphertext modified | Decryption fails (ciphertext, tag, salt, nonce or epoch changed, truncated, moved to another chat) | `crypto.test.js` |
| 17 | Wrong encryption key | Decryption fails (outsiders, old server keys, wrong recovery key, wrong password) | `crypto.test.js` |
| 18 | Group key swapped or replayed | Handoffs must be signed by the sharer and bound to server, epoch and recipient; anything else is refused | `crypto.test.js` › server key handoff |
| 19 | Member impersonates another | The signature check marks the message as not from them | `crypto.test.js` › channel messages |
| 20 | User reads someone else's messages | 403/404 for every route, with real victim ids; the automated attacker tries every route | `access.test.js`, `attack.test.js` › someone else's ids |
| 21 | Normal user calls admin API | 401 signed out, 403 signed in, for every admin route | `access.test.js` › every admin endpoint |
| 22 | Permission escalation | Manage Roles can't grant Administrator, can't touch higher roles or the owner; moderators can't act on admins; admins can't act on the owner or hand out staff roles | `access.test.js` |
| 23 | Hostile input | Malformed, huge, mistyped, SQL-like, HTML/JS, path traversal, prototype-pollution and concurrent requests never cause a server error or a hang | `attack.test.js` |
| 24 | Path traversal to files | Never reaches the database, the source or settings | `attack.test.js` › path traversal |
| 25 | Malicious script on the page (XSS) | A strict Content-Security-Policy allows scripts only from Hearth itself (no inline, no eval) and connections only back to Hearth; framing is blocked | `platform.test.js` › Content-Security-Policy |
| 26 | Cross-site request forgery | No cookies at all: requests need a bearer token that other sites can't read | `platform.test.js` › no cookies |
| 27 | Admin hides their tracks | Audit entries can't be edited or deleted; hand edits to the database file break the hash chain, and Admin → Audit log says so | `platform.test.js` › audit log |
| 28 | Backup stolen | Useless without the backup key; tampering or truncation is detected; restores really work | `backup.test.js` |
| 29 | VPS filesystem compromised | No plaintext messages, passwords or private keys are stored (see rows 1–4) | `platform.test.js`, `crypto.test.js` |
| 30 | Someone reads another person's study data, trackers or folders | Every route only returns the caller's own items; study data is ciphertext anyway | `features.test.js` |
| 31 | A tracker is pointed at an internal address (SSRF) | Private, loopback, link-local and cloud-metadata addresses are refused, including after redirects | `features.test.js` › trackers: private and internal addresses |
| 32 | A group member removes others or takes over the group | Only the owner can remove people or hand the group over | `features.test.js` › group chats |

## 4. What each adversary can still do (honest limits)

- **Server compromise is the big one.** Someone who controls the running server can't decrypt stored messages, but
  could change the web app it sends to browsers so the *next* sign-in leaks a password or keys. This is true of
  every end-to-end encrypted web app. Mitigations:
  - the desktop and Android apps load the same code, so they don't help here;
  - **run the server on a machine you trust, keep it updated, and use `scripts/harden-vps.sh`** (firewall,
    SSH keys only, automatic security updates, Hearth as an unprivileged sandboxed user, see §5).
- **Metadata is visible to the server**: who is in which server, who messages whom and when, reactions, server and
  channel names, profiles, online status and game/music activity.
- **News bot posts aren't end-to-end encrypted.** They come from public feeds and the server writes them.
- **A malicious server could add a hidden member** to a server, who would then be given the key. The member list
  shows everyone, so watch it in sensitive servers. Key changes ("Security key changed") must be verified with
  safety numbers.
- **Without 2FA, an email compromise takes over the account** (not its messages). Turn on 2FA.
- **A compromised admin** can suspend users, remove someone's 2FA (only for people ranked below them; it's logged
  and the person is emailed), read the audit log and see IP addresses. They can't read messages, act on the
  owner, or erase the log.
- **No forward secrecy for history.** Your long-term key can decrypt your past messages, so they follow you to new
  devices. Someone with your password **and** a copy of the database could read your history.
- **Session location** ("Reno, NV") isn't shown, only the IP address: showing a place needs a GeoIP database or
  sending everyone's IPs to a third-party service.
- **Rate limits are kept in memory**, so a restart resets them. That's fine for a single server; a multi-server
  setup would need a shared store.

## 5. Running it safely (infrastructure)

```
Internet ─► VPS firewall (ufw: 22, 80, 443, relay ports) ─► Caddy (HTTPS, HSTS) ─► Hearth (uid 1000, sandboxed)
                                                                              └─► data/ (SQLite file — no network database)
```

- **Docker** (`docker-compose.yml`):
  - Hearth runs as uid 1000 on a read-only filesystem, with no Linux capabilities and no-new-privileges, a
    process limit and rotated logs.
  - No Docker socket is mounted.
  - Caddy reaches Hearth over an internal network. With a domain, set `HEARTH_BIND=127.0.0.1` so port 3000 isn't
    public: Docker ports bypass ufw.
- **systemd** (`deploy/hearth.service`):
  - A dedicated `hearth` user; the whole system is read-only except the data folder (`ProtectSystem=strict`).
  - No capabilities, a system-call filter, and private `/tmp`; home folders are hidden.
  - Program files are owned by root, so Hearth can't change its own code.
- **The VPS** (`scripts/harden-vps.sh`):
  - Firewall on; SSH password logins off, but only once a key works, so you can't be locked out.
  - fail2ban, automatic security updates.
  - Moves a root-run Hearth to the sandboxed user, rolling back if it doesn't come up.
- **Database**: SQLite, a file inside `data/`. It never listens on a network port, so there's nothing to expose.
- **Secrets** (`.env`, `data/secret.key`, `data/backup.key`, SMTP password, API keys):
  - never committed: `.gitignore` covers them and `gitleaks` scans every push;
  - turn on GitHub secret scanning and push protection too.

## 6. Backups

- **Encrypted full backup every day**: database, keys and uploads in one `.hbk` file. It's encrypted with
  `data/backup.key` (or `BACKUP_KEY`) using AES-256-GCM in chunks, so any change, reordering or truncation is
  detected.
- **Restore-tested automatically**: each backup is decrypted into a scratch folder and the database is
  integrity-checked right after it's made. Admin → Owner shows the result, and "Test restore" repeats it.
- **Off-site**: set `BACKUP_RCLONE_REMOTE` and each backup is copied with rclone (Backblaze B2, S3, Google Drive,
  SFTP…). With Docker, run rclone on the host over `data/backups/encrypted/` instead.
- **Keep the backup key somewhere else** (Admin → Owner → "Show backup key", which needs your password and is
  logged). Never store it next to the backups.
- **Restore on a new machine**: `node server/cli.js restore <file.hbk> <empty-folder> <backup-key>`, then start
  Hearth with `DATA_DIR` pointing there.
- **Plain database copies** (`data/backups/*.db`, for undoing updates) never leave the server and can't be
  downloaded.

## 7. Supply chain

- **Lockfiles**: `npm ci` everywhere.
- **Dependabot** (`.github/dependabot.yml`): weekly for npm (server, desktop, mobile), GitHub Actions and Docker
  images.
- **CI** (`hearth-security.yml`) runs on every push, every pull request and weekly:
  - the security test suite;
  - `npm audit` (fails on high or critical in server dependencies);
  - gitleaks over the full git history;
  - a Trivy scan of the Docker image (fails on fixable high or critical) and of its configuration;
  - CodeQL.
- **Actions pinned**: third-party actions are pinned to full commit SHAs.
- **On GitHub** (Settings → Code security), switch on: Dependabot alerts and security updates, secret scanning,
  and push protection.
