# Hearth security model

This is Hearth's threat model and its **security contract**: what Hearth protects, who from, and what happens
when each of them gets in. Every row of the contract names the automated test in `test/` that checks it. The
suite runs on every push and pull request (`.github/workflows/hearth-security.yml`), together with dependency,
secret and container scans. Run it locally with `npm test`. A few tests need a tool that isn't always installed
(Chromium with Playwright, Electron, a Java compiler, some shell tools); without it they say "skipped" instead of
passing, so check the run's skip count.

Found a problem? Please tell the server owner privately (not in a public channel), with steps to reproduce.

---

## 1. What we protect

| Asset | Where it lives | How it's protected |
|---|---|---|
| **Messages and files** (DMs, server channels, attachments) | Server database and `data/uploads`, as ciphertext only | End-to-end encrypted on the sender's device: AES-256-GCM with a fresh key per message (HKDF-SHA256), the conversation, author and key version bound in. Channel messages and key handoffs are signed (ECDSA P-256). Message text is padded so its length doesn't leak. **File sizes are not hidden:** an encrypted file is its exact size plus 28 bytes. A message's id, reply, thread, time and edit version are not bound in (see §4). |
| **Passwords** | Never leave the device | Argon2id (64 MiB, 3 passes, per-account salt) in the browser. One half signs in; the server stores only a **bcrypt hash** of it. The other half unlocks your keys and never leaves the device. |
| **Identity keys** (ECDH P-256 + ECDSA P-256) | Private halves on the server, locked | Locked with AES-256-GCM under the password-derived key. The server can't open them. It hands the locked copy out only after the password: at sign-in, with a reset link, or when you re-confirm (password, plus a two-factor code when that's on). A session token alone doesn't get it. |
| **Recovery keys** | Only with the person (password manager or paper) | 160 random bits. They lock a second copy of the identity key; the server stores only that locked copy. |
| **Sessions** | Server database | Only a **SHA-256 hash** of each 256-bit token is stored. Each session ends when revoked, after 60 days unused, or 365 days after sign-in. Ending one also closes its live connection, stops its push notifications and stops its picture-proxy links. |
| **Two-factor secrets and backup codes** | Server database | The TOTP secret is encrypted with the server's key (`data/secret.key`). Backup codes are HMACs keyed with it. Codes are single-use and attempts are rate-limited. |
| **Email addresses** | Server database | Shown only to the account itself, masked in the admin view. Used only for resets and security notices. |
| **Reset links and email codes** | Server database | Stored hashed, single-use, short-lived (30 minutes). A reset link stops working when the password changes, or when the email address it was sent to changes or is removed. |
| **Group membership, who talks to whom, when** | Server database | **Not hidden** (metadata). The server needs it to route messages. See §4 for the full list. |
| **SMTP password, API keys, payment secrets** | Server database or `.env` | In the database, sealed with `data/secret.key`: the SMTP password, the GIPHY, KLIPY, Last.fm and RAWG keys, the Ko-fi token, both Stripe webhook signing secrets and the memberships Stripe key. **The call relay (TURN) secret is stored in plain text**, because the relay setup scripts read it. Never in git. |
| **Study tools data** (decks, assignments, timer settings, stats) | Server database, as ciphertext only | Encrypted on your device with a key derived from your identity key (ECDH with itself → HKDF → AES-256-GCM). Each item is bound to its id and kind, so the server can't swap them. For reminders, the server stores only a time. |
| **Server folders, tracked feeds** | Server database | Not encrypted: they're personal settings the server needs (folders) or acts on (it fetches the feeds). They're only shown to the account itself. |
| **Saved messages, read markers, notification settings** | Server database | Message ids, times and settings only. Notes on saved messages are encrypted on your device with a key only you can derive. Drafts stay in your browser and are deleted when you send or sign out. |
| **Bot tokens and webhook secrets** | Server database | Tokens are stored only as SHA-256 hashes and shown once; webhook signing secrets are sealed with `data/secret.key`. |
| **Server logs** | stdout (journald, Docker logs) | Structured lines with secrets, tokens, message content and ciphertext redacted; IPs truncated unless `LOG_FULL_IP=true`. |
| **Public pictures** (avatars, banners, backgrounds, server icons, emoji, the GIF library) | `data/uploads`, readable by anyone with the link | Not encrypted: everyone is meant to see them. The server strips hidden metadata (EXIF and GPS position, XMP, IPTC, comments, data after the image) from JPEG, PNG and WebP uploads before storing them. GIF comments, profile songs' tags and pictures uploaded before this version keep theirs. |
| **Backups** | `data/backups/encrypted/*.hbk`, plus off-site copies | Encrypted with a separate backup key, made tamper-evident in chunks, and restore-tested when made. The plain snapshot a backup is made from only ever sits in the private folder `data/backups/.tmp`, and is deleted afterwards. |
| **The audit log** | Server database, plus `data/audit-anchor.json` | Append-only (the database refuses edits and deletes). Each entry is chained with an HMAC keyed from `data/secret.key`, and the newest entry is recorded in `data/audit-anchor.json`. Anyone without that key can't edit, delete or cut off entries unnoticed. Someone with root (the database and the key) can still rewrite it. |

## 2. Who we protect against

| Adversary | What they have |
|---|---|
| **Random internet attacker** | Can send any request to the server. |
| **Direct visitor** | Reaches Hearth's port without going through the reverse proxy (a LAN, Docker's published port) and can send any header, including a made-up `X-Forwarded-For`. |
| **Database thief** | A copy of `hearth.db`, for example from a stolen disk image or backup. Not the running server's memory. |
| **Stolen-session attacker** | One person's sign-in token (malware, a borrowed laptop, a shoulder-surfed token). A token alone doesn't give the password or the private key. |
| **Compromised email account** | Can read the victim's email, including reset links. |
| **Malicious user** | Has a normal account and tries to read or change others' data, climb permissions, or slow the server down for everyone. |
| **Compromised admin** | A staff account (moderator or admin) turned against the server. |
| **Server compromise** | Root on the VPS, or full control of Hearth's process. This includes a host who decides to spy. |

## 3. The contract

| # | Attack | Expected result | Proven by |
|---|---|---|---|
| 1 | DB stolen | Messages and files stay encrypted; there is no key on the server to open them | `crypto.test.js`, `platform.test.js` › a stolen database holds no usable secrets |
| 2 | DB stolen | Passwords can't be recovered: only bcrypt hashes of an Argon2id-derived key | `auth.test.js` › bcrypt hashes |
| 3 | DB stolen | Sessions can't be used: only token hashes, and a hash isn't a token | `sessions.test.js` › stolen database |
| 4 | DB stolen | Reset links, email codes, backup codes and the 2FA secret aren't usable from the file alone | `recovery.test.js` › reset link stored as hash, `platform.test.js` › no usable secrets |
| 5 | Session stolen | The owner sees it in **Settings → Security → Signed-in devices** and revokes it (or "Log out all other devices"). It dies at once: its live connection closes, its push notifications stop (one still waiting to go out is checked again first), and its picture-proxy links stop working | `sessions.test.js` › Sessions lists devices…, `outbound-hardening.test.js` › push: delivery works, and stops for a device once its session is revoked…, › a notification still waiting…, `auth-hardening.test.js` › the media token belongs to its session… |
| 6 | Session stolen + password | With 2FA on, a two-factor code is needed too to change the password, email, recovery key or username, delete the account, delete or hand over a server, or fetch the password-locked private key. **Exception:** a session that passed two-factor in the last 10 minutes (at sign-in or an earlier re-confirm) isn't asked again, so a token stolen in those minutes plus the password is enough. Turning 2FA off always needs a fresh code | `recovery.test.js` › step-up…, › turning 2FA on…; `authz-hardening.test.js` › authz-14…; `crypto-hardening.test.js` › the password-locked key needs a two-factor code… |
| 7 | Session left behind | Logout, password change, password reset and turning on 2FA end the other sessions immediately, live connections included. The session that made the change keeps its own token (§4) | `sessions.test.js`, `recovery.test.js` |
| 8 | Old session | Expires after 60 idle days or 365 days in total | `sessions.test.js` › expired session |
| 9 | Email compromised (2FA on) | The reset link alone doesn't work; a 2FA code is needed | `recovery.test.js` › 2FA is needed for a password reset |
| 10 | Email compromised (no 2FA) | The attacker can reset the password, but only with new keys. DMs and older server keys stay unreadable to them. Devices that knew the old key show "Security key changed" and stop sharing keys with the account; the owner gets a notice email. **Not protected:** a device that never saw the old key (a member's new phone or cleared browser, or a new member) shares the server's current key with the new identity without asking. That opens everything said since the server's key last changed, and everything after. Keeping the old keys needs proof of the recovery key. Turn on 2FA | `recovery.test.js` › reset without the recovery key…, › keeping keys needs proof… |
| 11 | Password forgotten | Email reset plus the recovery key restores the same identity: all old messages stay readable | `recovery.test.js` › recovery-key restoration, `crypto.test.js` › recovery key restores |
| 12 | Reset link misused | Wrong, expired or reused links fail; two racing uses of one link: only one wins. A link stops working once the password changes, or once the email it went to is changed or removed | `recovery.test.js` › reset links…, racing; `auth-hardening.test.js` › a reset link stops working… |
| 13 | Reset spam / probing | "Forgot password" needs the robot check (when sign-in has one) before anything is counted. It answers the same for every account and is limited per network and per account (3 emails an hour), silently. Only an account's first email in an hour counts toward the instance-wide cap (300 an hour); when that is full, everyone gets the same "try again later", which says nothing about any account | `recovery.test.js` › "forgot password" answers the same…, › is limited per network; `auth-hardening.test.js` › password resets: the robot check comes first… |
| 14 | Password guessing | Limited per network (IPv6 per /64) and per account across all networks (10 tries per 15 minutes, 100 a day). A request without a solved robot check never counts toward an account's limit or the instance-wide one. The account's own devices and networks have a separate allowance, so a stranger can't lock it out of them. Unknown usernames take as long as wrong passwords | `auth.test.js`, `auth-hardening.test.js` › sign-in and sign-up limits |
| 15 | 2FA guessing / bypass | Missing, malformed, wrong and reused codes fail. 8 tries per 15 minutes and 30 per day per account; the owner is emailed after 3 failures | `recovery.test.js` › 2FA… |
| 16 | Ciphertext modified | Decryption fails (ciphertext, tag, salt, nonce or epoch changed, truncated, moved to another chat) | `crypto.test.js` |
| 17 | Wrong encryption key | Decryption fails (outsiders, old server keys, wrong recovery key, wrong password) | `crypto.test.js` |
| 18 | Group key swapped or replayed | Handoffs must be signed by the sharer and bound to server, epoch and recipient; anything else is refused. Apps also refuse a current key handed out by someone who isn't a member, and never go back to an older key during a session | `crypto.test.js` › server key handoff, `crypto-hardening.test.js` › the app never uses a current key handed out by a non-member… |
| 19 | Member impersonates another | The signature check marks the message as not from them | `crypto.test.js` › channel messages |
| 20 | User reads someone else's messages | 403/404 for every route, with real victim ids; the automated attacker tries every route | `access.test.js`, `attack.test.js` › someone else's ids |
| 21 | Normal user calls admin API | 401 signed out, 403 signed in, for every admin route | `access.test.js` › every admin endpoint |
| 22 | Permission escalation | Manage Roles can only give roles below its own highest role, and only roles whose permissions it already has, including the role's per-channel overrides. So it can't hand out Administrator even when an Administrator role sits lower, or a role that sees a private channel it can't. Moderators can't act on admins; admins can't act on the owner or hand out staff roles | `access.test.js`, `authz-hardening.test.js` › authz-12… |
| 23 | Hostile input | Malformed, huge, mistyped, SQL-like, HTML/JS, path traversal, prototype-pollution and concurrent requests never cause a server error or a hang | `attack.test.js` |
| 24 | Path traversal to files | Never reaches the database, the source or settings | `attack.test.js` › path traversal |
| 25 | Malicious script on the page (XSS) | A strict Content-Security-Policy allows scripts only from Hearth itself (no inline, no eval), lets fetch, XHR and live connections go only back to Hearth, and blocks framing. **It doesn't stop data leaving:** pictures and media may load from any https site, the watch-together players come from YouTube, Vimeo and Twitch, and a page can navigate away. Injected script could still send the sign-in token out inside a picture address | `platform.test.js` › Content-Security-Policy |
| 26 | Cross-site request forgery | No cookies at all: requests need a bearer token that other sites can't read | `platform.test.js` › no cookies |
| 27 | Admin hides their tracks | Audit entries can't be edited or deleted. The chain is keyed with `data/secret.key` and its newest entry is anchored in `data/audit-anchor.json`, so hand edits, deleted or cut-off entries, NULLed hashes and a changed or missing anchor all show in Admin → Audit log. Relay, region, payment, membership, GIF and music settings and backup retention changes are logged too. Someone with root (the database and the key) can still rewrite the whole log | `platform.test.js` › audit log…, `admin-hardening.test.js` › admin-7…, admin-6…; `voice-hardening.test.js` › voice-14… |
| 28 | Backup stolen | Useless without the backup key; tampering or truncation is detected; restores really work. `data/backups/encrypted/` only ever holds encrypted files, so syncing it off-site never ships a plain database | `backup.test.js`, `admin-hardening.test.js` › admin-8/data-6… |
| 29 | VPS filesystem compromised | No plaintext messages, passwords or private keys are stored (see rows 1–4) | `platform.test.js`, `crypto.test.js` |
| 30 | Someone reads another person's study data, trackers or folders | Every route only returns the caller's own items; study data is ciphertext anyway | `features.test.js` |
| 31 | A feed, tracker, news or music picture, or push endpoint is pointed at an internal address (SSRF) | Every address the host name resolves to must be public. Refused: private, loopback, link-local and cloud-metadata, carrier-grade NAT, multicast and reserved ranges, including IPv4 hidden in IPv6 (mapped, NAT64, 6to4); numeric forms like `2130706433` are normalized first. Also refused: this server's own addresses, even public ones (except ports 80 and 443), and anything in `OUTBOUND_BLOCK`. The connection goes to the address that was checked, so DNS rebinding can't swap it. Every redirect is checked again (a few at most). One deadline covers the whole request, and the answer is capped while it streams | `outbound-hardening.test.js` › netguard…, trackers and feeds…; `features.test.js` › trackers: private and internal addresses |
| 32 | A group member removes others or takes over the group | Only the owner can remove people, hand the group over, delete other people's messages or change the group's channels | `features.test.js` › group chats, `authz-hardening.test.js` › authz-4… |
| 33 | A booby-trapped deck file (study tools) runs code | Recall runs in a sandboxed frame with its own origin: no access to Hearth's sign-in or storage, no network, only Hearth may embed it. Imported decks are cleaned (ids, pictures, colours) before they're shown | `features.test.js` › Recall runs sandboxed |
| 34 | Someone moves a call to a region to listen in | A region's relay only forwards end-to-end encrypted packets it can't read. Changing a server voice channel's region needs Manage Channels; outsiders can't change DM calls | `calls.test.js` |
| 35 | A region server is broken into | It holds encrypted backups (useless without the backup key, which never leaves the main server) and relays encrypted call packets. **It also holds the instance-wide relay secret**, which makes relay logins valid on every relay, the main one included, and its own check-in token, which lets it change the address it reports. Private, loopback, link-local and disguised (IPv4-inside-IPv6) addresses are refused there. The main server pushes copies to an upload-only, chrooted SFTP account and never accepts commands from the region; uploads go only to the SSH host key the region reports with its token | `calls.test.js` › regions with backup space…, `voice-hardening.test.js` › voice-11… |
| 36 | Someone gets a paid role without paying, or charges a member twice | Roles come only from Stripe webhooks with a valid signature less than 5 minutes old; each Stripe subscription is stored once; checkout amounts, fees and destinations are set by the server, never the app; roles with moderator powers can't be sold, and a sold role can't gain them later; the Stripe key is encrypted at rest and never sent back | `memberships.test.js`, `admin-hardening.test.js` › admin-10… |
| 37 | Someone renames themselves into a name that comes with powers, or to impersonate | Renaming needs the password (and two-factor code, row 6). A name listed in `ADMIN_USERS` belongs to the account that first took it, even after it renames or deletes itself, so nobody else can register or take it. 3 renames a day; email notice; admin renames are audit-logged and only admins can do them, on people below them | `username.test.js`, `auth-hardening.test.js` › ADMIN_USERS names and the owner |
| 38 | Someone registers an `ADMIN_USERS` name to become admin or owner | The owner is settled once: at the first sign-up, or by the first listed name when `ADMIN_USERS` was set before anyone signed up. Registering a freed or newly listed name never brings ownership. On an upgraded server, listed names nobody had are held back until the operator takes them off the list. `node server/cli.js set-owner` refuses deleted, bot and suspended accounts and is audit-logged | `auth-hardening.test.js` › ADMIN_USERS names and the owner, › names added later, and names held back…, › the CLI won't make a suspended account the owner… |
| 39 | Junk sign-ins or sign-ups use up the shared limits, locking everyone out | The robot check comes before every shared counter, so requests without a solved one never count. Past the instance-wide limits (120 sign-ups an hour, 3000 sign-ins in 10 minutes) the check gets harder for everyone instead of turning people away. With the robot check switched off, those limits refuse requests | `auth-hardening.test.js` › instance-wide sign-up limit…, › instance-wide sign-in limit…, › busy times… |
| 40 | A banned network is already signed in | An IP ban also refuses signed-in requests and live connections from that address (staff excepted), and "forgot password" and reset links. Logging out still works and really ends the session | `auth-hardening.test.js` › IP bans cut off existing sessions…, › logging out works from a banned address… |
| 41 | A picture-proxy link is copied or kept | The GIF, music-art and news picture proxies need a token tied to one sign-in session. It stops working at logout, revocation, suspension and account deletion, not only after its 7 days | `auth-hardening.test.js` › the media token belongs to its session… |
| 42 | A removed member comes back with their old powers | Leaving, a kick or a ban removes the person's roles, per-channel overrides and event RSVPs. Rejoining later, even after an unban, starts from @everyone (except roles from a membership they still pay for) | `authz-hardening.test.js` › authz-1…, data-11… |
| 43 | A moderator edits channel permissions above them | Editing a channel's overrides needs Manage Roles in that channel, only allows or denies what the editor has there, and can't touch roles or people at or above the editor. Unless the editor is the owner or an Administrator, a change can't take anything in that channel away from people at or above them, even through @everyone. Editing or deleting a channel needs Manage Channels in that channel; channels you can't see are "not found" | `authz-hardening.test.js` › authz-2…, authz-3… |
| 44 | A leaked or old invite link | New links expire after 7 days unless the creator picks otherwise (1 hour to 30 days, or never), API requests included. People with Manage Server can list and revoke every working link; anyone can revoke the links they made. Banning someone revokes the links they made | `authz-hardening.test.js` › authz-13… |
| 45 | A stolen session does lasting damage | Besides row 6, these need the password again (and a two-factor code under row 6's rule): handing over the instance or changing any staff role; deleting a backup, keeping fewer backups or turning them off, showing the backup key; changing where payments go (Ko-fi page or token, Stripe link or signing secret, donation link, memberships Stripe key or webhook secret); changing the call relay's secret or addresses; adding or reinstalling a region. The old owner is emailed when ownership moves. 10 wrong passwords per 10 minutes per account | `admin-hardening.test.js` › admin-2…, admin-6…; `voice-hardening.test.js` › voice-14…; `backup.test.js` › showing the backup key needs the password… |
| 46 | Staff overreach | Staff can't remove messages by staff at or above their rank (or a thread with such replies), can only remove DMs and group-chat messages that were reported, and can't close reports about themselves or higher staff. Admins can't delete or take servers owned by the owner or staff at their level, can't delete group chats from Admin → Servers, and can't IP-ban the owner's, higher staff's or their own network | `admin-hardening.test.js` › admin-4…, admin-5… |
| 47 | Uploads fill the memory or the disk | Each upload takes at most 8 text fields of 16 KB and 10 parts. One account has at most 4 uploads in progress. Storage quota and daily allowance are checked when an upload starts and again before it is recorded, so parallel uploads can't overrun them. GIF-library uploads count too, and are refused when GIFs are off | `files-hardening.test.js` › files-1…, files-3…, files-4… |
| 48 | A public picture gives away where it was taken | Profile and server pictures, emoji and GIF-library uploads lose their hidden metadata ("Public pictures" in §1) in a worker thread before they're stored. A picture that can't be cleaned is refused, never stored as it is | `files-hardening.test.js` › files-6…, review-1…, review-2… |
| 49 | A crafted attachment entry in an encrypted message | Apps keep only attachment entries that point at a file on this server (`/uploads/<name>`). Anything else is dropped, so a message can't make readers' apps load another site or open one on click | `files-hardening.test.js` › files-5/xss-3…, review-3… |
| 50 | One account floods or stalls the server through push | At most 10 push devices per account, 10 new ones and 60 subscribe calls an hour. Endpoints must be public https push services (row 31's rules; `PUSH_ALLOW_PRIVATE=1` lifts the private-address rule). Sending happens after the request is answered and is shared fairly: at most 16 at once, 2 per account and 8 per push service, with a 10 s timeout and a 64 KB cap on each answer. A push service that keeps failing sits out, then is dropped | `outbound-hardening.test.js` › push… |
| 51 | One account floods live connections | Each connection has its own event allowance, and all of an account's connections share one more (120 at once, then 30 a second). An account can have at most 30 connections open and open 60 a minute. Refused events get "Slow down."; only a flood that keeps going is disconnected, and the app is told why, so it reconnects instead of signing out. Messages over 256 KB and call signals over 64 KB are refused. Typing is passed on at most once a second per person | `voice-hardening.test.js` › voice-4…, voice-2…, auth-12… |
| 52 | Relay logins abused or left to run out | Relay passwords are per person and run out 12 to 18 hours after they're issued. The app fetches new ones before that (`GET /api/ice`, 60 an hour). A login names the person by a keyed pseudonym (the one in the access log; `node server/cli.js who` finds the account), never by their user id, so relays, which may run on other machines, don't learn user ids. `scripts/setup-turn.sh` caps each relayed connection at 6 Mbit/s each way, with an optional total cap, and refuses relaying into private networks | `voice-hardening.test.js` › voice-6/9…, voice-6…, voice-9…; `infra-hardening.test.js` › deploy/turnserver.conf… |
| 53 | Someone loses access during a call | Losing Speak mutes you at once and the server keeps you shown muted. Losing Connect or View (role edits, role removal, overrides, a membership ending) takes you out of the call. Only someone who was rung, or could join, can decline a call | `voice-hardening.test.js` › voice-3…, authz-5…, voice-5…; `memberships.test.js` › when a membership ends… |
| 54 | A server pushes a malicious desktop update | The desktop app never installs an update without asking. Apps built with the `UPDATE_SIGNING_KEY` secret install an update only when its `latest*.yml` carries a valid Ed25519 signature from the publisher, the version is newer, and the installer's SHA-512 matches. Apps built without it say the update can't be verified | `client-hardening.test.js` › infra-1… |
| 55 | A look-alike address in the desktop app | Navigation, the `hearthDesktop` bridge and screen sharing compare the server's exact origin, never the start of the address. A redirect to another site opens in the browser | `client-hardening.test.js` › xss-4/infra-6… |
| 56 | The server's page grabs the screen, mic or clipboard in the desktop app | The screen picker is the app's own window; the page never sees window titles or thumbnails, and every capture needs the person's pick there. Mic, camera and clipboard reading need a native yes per server (Help → Reset permissions undoes it). Limit: an old-style capture request gets the whole screen for about 3 seconds after a pick, until the app reloads the page | `client-hardening.test.js` › infra-2… |
| 57 | The server's page changes the Android app's server | Only the app's own connect screen can change the saved server; the bridge checks who sent each message | `client-hardening.test.js` › infra-7… (needs a Java compiler) |
| 58 | A visitor fakes their address with `X-Forwarded-For` | The header counts only from a trusted proxy (`TRUST_PROXY`): by default this machine, and with `docker-compose.yml` its own Caddy network. HTTP and live connections work it out the same way. So IP bans and per-network limits hold for direct and LAN visitors | `infra-hardening.test.js` › TRUST_PROXY values…, › by default, a visitor arriving from a private address…, › a proxy Hearth does not trust… |
| 59 | A tampered build or deploy | Every workflow job's token can only read the repository, except the job that creates releases (and CodeQL, which uploads its results). Actions are pinned to commits, checkouts drop the token, and installs use the lockfiles. Only `app-v*` tags and the default branch reach people's apps. The server copy uses the runner's own ssh, and only to the host key in `VPS_HOST_FINGERPRINT` | `infra-hardening.test.js` › workflows… |
| 60 | A server update zip is swapped or damaged | `scripts/make-update-zip.sh` writes a `.sha256` next to each zip. `hearth-update` and both update tools refuse a zip that doesn't match it (without one they print the SHA-256 to compare), check the upload again on the server, and use private temporary folders. Plain installs are restarted as the owner of `data/`, never as root. A checksum isn't a signature (§4) | `infra-hardening.test.js` › hearth-update refuses an update that does not match its .sha256…, › nothing run as root writes to a fixed name in /tmp, › updating a plain-node install… |
| 61 | An upgrade is cut short, or old code meets a newer database | An upgrade runs as one transaction: stopped part-way, nothing has changed, and it runs again on the next start. One consistent copy of the database is made per upgrade. Hearth refuses to start on a database written by a newer version, without touching it; `verify-backup` and `restore` warn about backups from a newer version | `data-hardening.test.js` › an upgrade that was cut short…, › a failing upgrade changes nothing…, › a database from a newer Hearth is refused… |
| 62 | Someone who handed out keys deletes their account or resets | Each app keeps its own copy of every server key it receives, re-wrapped and signed by itself, so history doesn't depend on whoever shared it. Deleting an account erases its private keys but keeps its public keys, so contacts still read old DMs and check old posts. After a reset without a recovery key the old public keys stay on record, but a device trusts one only if it had pinned it, and only for what was written before the change; anything else is labelled "Older key — not verified" | `crypto-hardening.test.js` › a member who handed out keys deletes their account…, › the sharer resets…, › keys the server lists as someone's past keys never vouch… |
| 63 | A kicked member rejoins to read what they missed | Someone who was a member before with the same account (left, kicked or banned) and comes back gets a new server key, even after resetting their password. Apps don't share the current key while a new one is needed. A different account using a kept invite still gets the current key like any new member, so revoke invites after removing someone | `crypto-hardening.test.js` › a kicked member who rejoins…, › a kicked member who resets their password and rejoins… |
| 64 | A member keeps replacing the server key | Key bundles are checked strictly. Members without Manage Server can replace the key only once it's 10 minutes old and while fewer than 12 keys were made in that server in the last hour; members with Manage Server have their own 30 an hour. A new key the others can't open is replaced once two members (or one with Manage Server) report it; each member's reports count at most 12 times an hour | `crypto-hardening.test.js` › junk key bundles are refused…, › a member who rotates to a key nobody else can open…, › refused rotations don't use up the hour…, › reporting a good key doesn't let anyone skip… |
| 65 | A stolen session guesses the password offline | The start-up data no longer includes the password-locked private key. It comes only at sign-in, with a reset link, or from `POST /api/me/keys/wrapped`, which needs the password (and a two-factor code under row 6's rule). Uploading a signing key needs proof of the identity key and of the new signing key | `crypto-hardening.test.js` › a session alone no longer gets the password-locked private key…, › a signing key can only be uploaded with proof… |
| 66 | The server forges an old-style plaintext message | Plaintext "older" messages are labelled "sender not verified". Apps hide plaintext channel messages dated after the instance switched on end-to-end encryption (`e2eeSince`, as each device first heard it), except news-bot posts | `crypto-hardening.test.js` › plaintext "older" messages… |
| 67 | The server lists its own key as yours | Apps refuse to start if the server lists keys for your account that your password doesn't unlock, and never wrap keys to a wrong key for yourself | `crypto-hardening.test.js` › an app told the wrong public key for itself…, › a server that lists its own keys as yours… |
| 68 | DB stolen: API keys and payment secrets | Sealed with `data/secret.key` (§1), older plain values included. The relay secret is the exception | `admin-hardening.test.js` › files-8… |
| 69 | Searching messages leaks the words | The server builds no search index and never receives the search words, quoted phrases or `has:`/`is:` filters. The app calls `GET /api/search/messages` with only scope, author, time window, cursor and limit, and gets back the same ciphertext the history endpoints return. Access is re-checked on every request; cursors only mark a position. Limits: 200 per page, 100 conversations per page for `all`/server scope, 60 searches a minute. The server learns that you searched, when, which scope/author/time window, and how far back you paged | `search.test.js`, `search-query.test.js` |
| 70 | Profile CSS or status leaks | Custom profile CSS can't cover the rest of the app or the close button, mask text or rename the app's animations. "Last seen" is a day only, and hidden while you're invisible and between people who blocked each other. Profile edits are rate limited, and profile changes reach only people who share a server, a friendship or a DM with you | `client-hardening.test.js` › xss-1…, xss-2…, xss-5… |
| 71 | Huge pages stall the server | History and thread pages hold 1 to 100 messages whatever is asked; big threads open and delete a page at a time; study sync comes in pages of a few MB and is limited by requests and by data | `data-hardening.test.js` › message pages hold 1 to 100…, › a thread with more replies…, › study sync… |
| 72 | Fill the disk or get past the storage limit with unfinished or parallel uploads | The whole size is reserved against the quota and daily limit before the first byte; at most 4 unfinished uploads each; they expire after a day idle and the room comes back | `storage.test.js` › storage-5, -6, -8 |
| 73 | Tamper with or touch someone else's upload | Only its owner can see, add to, finish or cancel it (404 for everyone else, admins included); chunks go in order and are size-capped; a file is stored only if its SHA-256 matches, and appears all at once | `storage.test.js` › storage-1, -2, -3, -7 |
| 74 | A deleted file keeps being served | 404 by every route (plain, Range, conditional, HEAD) for the file and its thumbnail; encrypted files are revalidated every time and never cached by proxies | `storage.test.js` › storage-9 |
| 75 | An admin cleanup deletes files still in use | Only files nothing in the database points at, older than a grace period; needs the password again; audit-logged; refuses if any message can't be checked | `storage.test.js` › storage-10 |
| 76 | Unfinished uploads leak through backups | Unfinished uploads live outside `uploads/` and are never in a backup; finished files are | `storage.test.js` › storage-13 |
| 77 | A bot (or its stolen token) tries to read people's messages or act outside its grant | Bots get metadata only, never message text, and nothing about channels outside their allow-list. Every call and event checks the approved scopes and channels. Wrong, revoked or rotated tokens get 401; tokens in URLs are refused. Tokens are stored hashed, shown once, and creating, rotating and revoking them is audit-logged | `bots.test.js` |
| 78 | A bot's webhook is pointed inside the network (SSRF), or forged webhooks are sent to a bot | Webhooks are https only through the outbound guard; private and loopback addresses are refused when saved and when used. Each delivery is HMAC-signed over the timestamp and body, with a 5-minute replay window | `bots.test.js`, `bots-example.test.js` |
| 79 | Restore interrupted, damaged or from a newer version | Never leaves a data folder that looks complete: Hearth refuses to start on a half-restored one; a newer backup is refused; damaged files are detected | `recovery-backup.test.js` |
| 80 | Restoring after a break-in | `restore --sign-out-everyone` ends every session in the restored copy | `recovery-backup.test.js`, `recovery-drill.test.js` |
| 81 | Crash in the middle of an upgrade | Nothing changes; the next start finishes it; the audit log still verifies | `recovery-upgrade.test.js`, `integration.test.js`, `scripts/upgrade-drill.sh` |
| 82 | Removed member | Can't read anything sent after removal (new key, even with the database); keeps what they had (not retroactive) | `recovery-drill.test.js` |
| 83 | Someone reads or changes another person's saved messages, read markers or notification settings | Every route uses only the caller's own rows; places you're not in are refused | `usability.test.js` |
| 84 | A stolen session exports everything | Starting an export needs the password (and the 2FA code when it's on), is audit-logged, and gives a 30-minute token tied to that session; the server only hands out ciphertext | `usability.test.js` › export |
| 85 | A phone's lock screen leaks who wrote and where | Pushes never contain message text; by default they say only "New message". Muted conversations and quiet hours get no push | `usability.test.js` › push |
| 86 | A timed-out member keeps posting, or a moderator times out someone above them | The server refuses posts, edits, reactions, votes and typing until the timeout ends, even after rejoining; Kick Members and role order are required; it's audit-logged | `usability.test.js` › timeouts |
| 87 | Secrets end up in the server log | Session tokens, `authKey`s, passwords, recovery keys, cookies, Authorization headers, ciphertext and request bodies are redacted centrally; the access log records route templates (never URLs) and a keyed hash of the user id; IPs are cut to /24 or /48 unless `LOG_FULL_IP=true` | `observability.test.js` |
| 88 | Health checks leak internals, or a background job takes the server down | `/api/health/live` and `/ready` say only ok/degraded/fail and short codes; `/api/admin/health` is for instance admins. Job errors are caught, recorded and alerted, never fatal; a client hanging up mid-request can't crash the access log | `observability.test.js` |
| 89 | Someone takes over a dropped call place | Rejoining a call after a dropped connection only works from the same session, within the grace window, re-checks permissions, and ends as soon as that session is signed out | `voice-reliability.test.js` |
| 90 | The server slips an unlisted listener into a call | The app warns when it has a live call connection to someone the server never listed, and closes connections to people it stops listing after 20 s. A server that lists the extra participant openly is not detected (§4) | `voice-reliability.test.js`, `npm run test:voice` › hidden listener |
| 91 | One account floods the server with ordinary requests | Every signed-in request counts toward a per-account ceiling (1200 a minute by default, `API_RATE_LIMIT`), on top of the tighter limits on sign-in, uploads, messages and the other sensitive routes. Bots have their own ceiling, and the routes that work without signing in limit themselves. Logging out is never refused | `scan-hardening.test.js` › per-account ceiling |

## 4. What each adversary can still do (honest limits)

- **Server compromise is the big one.** Someone who controls the running server can't decrypt stored messages, but
  could change the web app it sends to browsers so the *next* sign-in leaks a password or keys. This is true of
  every end-to-end encrypted web app. Mitigations:
  - the desktop and Android apps load the same code from the server, so they don't help here;
  - the desktop app adds native powers: a compromised server can offer it updates. Apps built with
    `UPDATE_SIGNING_KEY` refuse unsigned ones, but builds made before signing, forks without the key and the first
    update to a signed build install them after asking. In the desktop app the page can also get the whole screen
    for about 3 seconds after you pick something to share (row 56);
  - **run the server on a machine you trust, keep it updated, and use `scripts/harden-vps.sh`** (firewall,
    SSH keys only, automatic security updates, Hearth as an unprivileged sandboxed user, see §5).
- **A malicious server can also:**
  - add a hidden member to a server, who is then given the key, or hold back a key change after someone leaves,
    or roll the key back across a page reload. Apps refuse keys from non-members and older keys within a session,
    but nothing binds the member list into the key. Compare safety numbers when it matters;
  - add a hidden listener to a call: apps accept any correctly signed call offer and draw the call only from what
    the server says is in it;
  - replay a message, change what it replies to or which thread it's in, change its time, or serve a version from
    before an edit. It can't change a message's content or author;
  - read which GIFs people pick (the app reports picks to build the server's GIF library) and, with the GIF proxy
    on, which ones each person loads.
- **Metadata is visible to the server**: who is in which server, who messages whom and when, reactions, server and
  channel names, profiles, online status, game/music activity, file sizes, who was @mentioned (for push), GIF
  picks, and when and where (never what) you search.
- **Private channels share the server's key.** Every member holds it; private channels rest only on the server's
  access checks. A bug in those, or a malicious server, opens them to any member.
- **Online status and profiles reach everyone on the instance.** Presence goes to every connected user, and any
  signed-in user can look up any profile. Blocking doesn't hide them (invisible mode hides presence).
- **News bot posts aren't end-to-end encrypted.** They come from public feeds and the server writes them.
- **Without 2FA, an email compromise takes over the account**, and with it the server keys (row 10): what was
  said since each server's key last changed, and everything after. Turn on 2FA.
- **The 10-minute two-factor grace.** Right after a sign-in with a code, re-confirming asks only for the password
  (row 6).
- **The current session isn't given a new token** when you change your password, turn on 2FA or log out other
  devices: a copy of that one token keeps working until it's revoked.
- **Old-format accounts are recognisable.** Accounts still on the old (PBKDF2) password format can be told apart
  from unknown usernames through `/api/auth/params` until they sign in once.
- **The robot check is proof of work.** Graphics cards and native code solve it much faster than browsers, so it
  raises the cost of a flood without capping it. Someone who keeps solving it can hold up a brand-new device on a
  new network from signing in for a while (10 tries per 15 minutes, 100 a day).
- **A compromised admin** can suspend users, remove someone's 2FA (only for people ranked below them; it's logged
  and the person is emailed), read the audit log and see IP addresses. They can't read messages, act on the
  owner, or erase the log.
- **No forward secrecy for history.** Your long-term key can decrypt your past messages, so they follow you to new
  devices. Someone with your password **and** a copy of the database could read your history. Changing your
  password re-wraps the same identity key; it doesn't replace it. The database copies made before upgrades
  (`data/backups/hearth-before-v*.db`) are never pruned.
- **Attachment rules are best effort.** The real attachment list is inside the encrypted message, so the server
  can't enforce "Attach files" or clean up files that were never declared. Uploaded files are served to anyone
  who has the link.
- **Other sites see people's IP addresses** for: Google Fonts on every load, image links in messages (embeds are
  on by default), direct video files in watch together, the YouTube, Vimeo and Twitch players, and the default
  STUN servers (Google). GIFs, news pictures and game and music art go through the server.
- **Calls end on any connection blip.** A dropped live connection or a server restart ends every call, with no
  rejoin, and changing the microphone mid-call doesn't switch the live one.
- **The relay:** relay logins can't be revoked early, anyone who can sign up can get one, and the relay secret is
  shared by every region and stored in plain text. The hand-written `deploy/turnserver.conf` has no bandwidth cap
  (`setup-turn.sh` adds one; installs from before need it run again).
- **Push:** anyone can make the server send an opaque, encrypted push to any public https host with a real
  certificate (that's how web push works). They get no answer back. The server's own public addresses stay
  reachable on ports 80 and 443; behind NAT, list the public IP in `OUTBOUND_BLOCK`.
- **Server update zips are checksum-checked, not signed.** A swapped zip shipped with a matching `.sha256` would
  be installed. Publish the SHA-256 somewhere separate (release notes) and compare.
- **`trustedSelfSignedHosts`** in the desktop app accepts any certificate for those hosts. Leave it empty so the
  app asks once and pins that exact certificate.
- **The audit log** can be rewritten by root. Someone who can write the data folder but lacks the key can make it
  look like a log from before the keyed chain; Hearth then starts a new signed section and shows the date, so the
  reset shows, but edits before it can't be proven.
- **Supporter payments** ignore refunds and chargebacks; unmark the supporter by hand in Admin → Users.
- **Session location** ("Reno, NV") isn't shown, only the IP address: showing a place needs a GeoIP database or
  sending everyone's IPs to a third-party service.
- **Rate limits and the security log are kept in memory**, so a restart resets them, and a multi-server setup
  would need a shared store. There is no access log: failed sign-ins, robot-check failures and blocked addresses
  are kept only in that in-memory log (the last 500 events). Staff actions and account security events go to the
  audit log.

- **Bot messages and slash-command text aren't end-to-end encrypted.** What you type after a bot's command goes to
  that bot's operator (the app warns first), and the bot's posts are readable by the server.
- **Reading habits are metadata.** The server knows how far you've read in each conversation, which message ids you
  saved, your mute choices and quiet hours, and who was mentioned, but not what any message says.
- **Uploaded files are served without sign-in, by design.** Blob names are random and the contents are ciphertext
  whose key is only inside the message. Profile pictures and server images are not encrypted.
- **Calls:** ICE candidates are not signed, so a malicious server can reroute or disrupt a call (not decrypt it).
  The server decides who is in a call; an extra participant it lists openly is not detected. Media is DTLS-SRTP
  between participants, with no extra media end-to-end layer yet (see `docs/VOICE.md` for the staged design).
- **A plain restore brings back sessions** that were signed out after the backup was made. After a break-in, restore
  with `--sign-out-everyone`.
- **Monitoring is per process.** Job health, alert counters and the security log live in one server; Hearth can't
  report that it is down itself, so point an external monitor at `/api/health/ready`.

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
  - `TRUST_PROXY` defaults to the compose file's own Caddy network. A value in `.env` replaces it; never set it to
    a number or to Docker's gateway (`x.x.x.1`) unless `HEARTH_BIND=127.0.0.1`.
- **systemd** (`deploy/hearth.service`):
  - A dedicated `hearth` user; the whole system is read-only except the data folder (`ProtectSystem=strict`).
  - No capabilities, a system-call filter, and private `/tmp`; home folders are hidden.
  - Program files are owned by root, so Hearth can't change its own code.
- **The VPS** (`scripts/harden-vps.sh`):
  - Firewall on; SSH password logins off, but only once a key works, so you can't be locked out.
  - fail2ban, automatic security updates.
  - Moves a root-run Hearth to the sandboxed user, rolling back if it doesn't come up.
- **Client addresses**: behind a proxy on another machine or container, set `TRUST_PROXY` to its address, or every
  visitor shares the proxy's address (and one set of sign-in limits). Hearth's log names an ignored proxy once.
- **Database**: SQLite, a file inside `data/`. It never listens on a network port, so there's nothing to expose.
- **Secrets** (`.env`, `data/secret.key`, `data/backup.key`, SMTP password, API keys):
  - never committed: `.gitignore` covers them and `gitleaks` scans every push;
  - turn on GitHub secret scanning and push protection too.
- **Desktop releases**: set the `UPDATE_SIGNING_KEY` secret (see `docs/SIGNING.md`) and `VPS_HOST_FINGERPRINT`
  with the server-copy secrets. Use a deploy user that can only write `data/downloads`, not root.

## 6. Backups

- **Encrypted full backup every day**: database, keys and uploads in one `.hbk` file. It's encrypted with
  `data/backup.key` (or `BACKUP_KEY`) using AES-256-GCM in chunks, so any change, reordering or truncation is
  detected.
- **Restore-tested automatically**: each backup is decrypted into a scratch folder and the database is
  integrity-checked right after it's made. Admin → Owner shows the result, and "Test restore" repeats it.
- **The plain snapshot** a backup is made from lives only in `data/backups/.tmp` (readable by Hearth alone). It's
  deleted when the backup is done, at shutdown, and at start-up if a crash left one.
- **Off-site**: set `BACKUP_RCLONE_REMOTE` and each backup is copied with rclone (Backblaze B2, S3, Google Drive,
  SFTP…). With Docker, run rclone on the host over `data/backups/encrypted/` instead, ideally with
  `--include '*.hbk'`.
- **Keep the backup key somewhere else** (Admin → Owner → "Show backup key", which needs your password and is
  logged). Never store it next to the backups.
- **Restore on a new machine**: `node server/cli.js restore <file.hbk> <empty-folder> <backup-key>`, then start
  Hearth with `DATA_DIR` pointing there. `restore` only writes into an empty folder and refuses a backup from a newer
  Hearth (exit 2). While it runs the folder holds `RESTORE-INCOMPLETE`, and Hearth won't start on a folder that has it.
  Add `--sign-out-everyone` after a break-in.
- **Missing files are reported, not hidden**: a backup made while files the database refers to are missing still
  completes and lists them (CLI exit 3, audit entry `backup_files_missing`); `node server/cli.js check-files` gives the
  same report for any data folder. A failed backup (disk full, for example) leaves nothing behind and is audit-logged.
- **Drills**: `node scripts/recovery-drill.js` and `bash scripts/upgrade-drill.sh` prove recovery and upgrades end to
  end; see `docs/RECOVERY.md`.
- **Plain database copies** (`data/backups/*.db`, for undoing updates) never leave the server and can't be
  downloaded.

## 7. Supply chain

- **Lockfiles**: `npm ci` in CI (server, desktop and Android), in the Docker image and when the updater builds a
  new version. The updater's rollback falls back to `npm install` only when the old libraries weren't saved.
- **Dependabot** (`.github/dependabot.yml`): weekly for npm (server, desktop, mobile), GitHub Actions and Docker
  images.
- **CI** (`hearth-security.yml`) runs on every push, every pull request and weekly:
  - the security test suite;
  - `npm audit` (fails on high or critical in server dependencies);
  - gitleaks over the full git history;
  - a Trivy scan of the Docker image (fails on fixable high or critical) and of its configuration;
  - CodeQL (`security-extended`; `.github/codeql/codeql-config.yml` says what's left out and why).
- **Release workflow** (`hearth-apps.yml`): read-only token for every job except the one that creates the GitHub
  release; Android installs exactly what its `package-lock.json` lists; installers reach people's apps only from `app-v*` tags and the default branch; the server copy needs a
  pinned host key.
- **Actions pinned**: every action in both workflows is pinned to a full commit SHA.
- **On GitHub** (Settings → Code security), switch on: Dependabot alerts and security updates, secret scanning,
  and push protection.
