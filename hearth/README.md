# Hearth

A self-hosted place to hang out with your friends: servers with text and voice channels, direct messages, a friends list, and profiles you can customize as much as you like. Run it on your own computer or a cheap VPS and send your friends an invite link.

- **Servers** with categories you can collapse and reorder, text and voice channels, invites, bans and per-server notification levels.
- **Roles and permissions:** unlimited custom roles with colors, emoji badges, hierarchy, "show separately" in the member list and @mentions; 17 permissions; per-channel overrides for any role or person (private channels, read-only announcements, listen-only voice); slowmode per channel.
- **Make your server yours:** banner (positionable, GIFs animate), description, accent color, a server-wide background (presets, custom gradients or an image), welcome message, icon shape, role-colored names, and up to 200 custom emoji — animated GIF, WebP and APNG included, uploaded in bulk or grabbed straight from GIPHY — that members can use in any server or DM.
- **Conversations** with replies, threads, reactions, pins, edits, forwarding, saved messages, @mentions (including @everyone and @channel), Markdown, spoilers, code blocks, GIFs, emoji search, and image/video/file attachments with a full-screen image viewer.
- **GIFs and stickers** from GIPHY: categories, trending, search with endless scrolling, favorites, and a privacy proxy so GIPHY never sees your members' IP addresses.
- **Direct messages and group DMs** (up to 10 people, with group voice calls).
- **Home screen** with recent and pinned conversations, online friends, your servers and recent activity.
- **Search everything with Ctrl+K**: people, channels, servers, messages, files and links. Because messages are end-to-end encrypted, message search runs in your browser.
- **Notification center** for mentions, replies and friend requests, plus unread and mention indicators that respect muted channels and servers.
- **Voice and video:** voice channels, group DM calls and 1-to-1 **DM calls that ring** (accept, accept with video, decline). **Webcam** and **screen sharing with sound** everywhere, with a spotlight view, fullscreen, picture-in-picture and per-person volume. Everything goes directly between participants, encrypted (DTLS-SRTP); none of it passes through your server. Mute, deafen, speaking indicators and an optional input-sensitivity gate.
- **End-to-end encryption for everything:** server channels, DMs, group DMs and every attachment are encrypted in your browser before they're sent. The server stores only scrambled data — not even the person hosting it can read your chats.
- **Admin dashboard** for server administrators: live stats, who's online (with IP addresses and devices), reports with evidence, user lookup with IP history, suspend / unsuspend, sign out everywhere, registration control (open, invite code, closed), a Terms of Service editor, and an audit log of every admin action.
- **Reporting:** anyone can report a message or a person. Because messages are end-to-end encrypted, the reporter's app shares the messages they choose (shown to them first); the server verifies who sent them and when.
- **Terms of Service** that everyone accepts at sign-up (and again when you change them); public page at `/terms`.
- **Sounds you choose:** 30+ built-in sounds (bells, marimba, kalimba, plucked strings, glass, chiptune…) for every event — DMs, group DMs, @you, @everyone, role mentions, replies, voice — or your own sound files.
- **Privacy and safety:** blocking, who can DM you, who can send friend requests, and a list of signed-in devices you can sign out remotely.
- **Profiles, all free:** GIF or image avatar, banner and full-card background; display name, pronouns, bio, links and custom status; name colors, gradients, 12 fonts and glow/shimmer/rainbow effects; avatar shapes and animated rings; card colors, presets, glass style and animated effects.
- **Your layout:** rearrange the server bar, channels, conversation and side panel in any order (or pick a preset), put the server bar across the top, drag panel edges to resize, and choose floating, attached or spacious panels.
- **Pictures you can position:** move and zoom your avatar, banner and profile background after uploading — animated GIFs keep animating.
- **Installable apps:** install from the browser on Windows, Mac, Linux, Android and iPhone, with push notifications when the app is closed; plus a desktop app (Windows/Mac/Linux) built automatically by GitHub Actions and a `/download` page for your users.
- **Look and layout:** three message densities (comfortable, compact, minimal), text size, accent color and reduced motion. **Themes and backgrounds:** Dark (default), Midnight, Dim, Ember and Light themes; 22 background presets (adaptive glows and patterns, dark and bright gradients); your own gradient builder (linear, radial, mesh, conic, 2–3 colors) or your own image/GIF, with panel transparency, darken/fade, blur and a slow-drift animation. Saved per device.
- **Settings** grouped into Account (profile, security, sessions), App (appearance, chat, notifications, voice & audio), Privacy & safety, and Server settings.

No build step, no external services required. One Node process and a SQLite file.

---

## Quick start (your own computer)

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

The terminal prints two addresses:

```
This computer:  https://localhost:3000
Your network:   https://192.168.1.20:3000
```

Open the first one, click through the certificate warning (see below), and create your account. The first person to sign up has no special powers — anyone can create servers.

To change settings, copy `.env.example` to `.env` and edit it. Restart after changes.

### About the certificate warning

Browsers only allow microphones and encryption on secure (`https://`) pages. Hearth makes its own certificate on first start so this works out of the box, but because no authority signed it, every browser shows a warning the first time. Click **Advanced → Proceed** (Chrome/Edge) or **Advanced → Accept the risk** (Firefox). Your connection is still encrypted.

To get rid of the warning, use a domain name with Caddy (see the VPS section).

---

## Letting friends connect

### Same Wi-Fi / LAN

Send friends the **Your network** address. That's it.

### Over the internet from home

1. In your router, forward **TCP port 3000** to the computer running Hearth.
2. Find your public IP (search "what is my ip").
3. Add it to `.env` so the certificate covers it, then delete `data/cert.pem` and `data/key.pem` and restart:
   ```
   PUBLIC_HOSTS=203.0.113.7
   ```
4. Friends open `https://203.0.113.7:3000`.

If your IP changes often, a free dynamic DNS name (DuckDNS, No-IP) works too — put that name in `PUBLIC_HOSTS`.

Your computer has to stay on for the server to be reachable.

### On a VPS with a domain (recommended for always-on)

Any small Linux VPS works (1 GB RAM is plenty for a friend group).

1. Point a domain or subdomain (for example `chat.example.com`) at the VPS's IP with an **A record**.
2. Copy this folder to the VPS.
3. Edit `deploy/Caddyfile` and replace `chat.example.com` with your domain.
4. Create `.env` with:
   ```
   HTTPS=false
   TRUST_PROXY=1
   ```
5. Start it:
   ```bash
   docker compose --profile domain up -d
   ```
6. Open `https://chat.example.com`. Caddy gets a real certificate automatically, so there's no warning.

Open ports 80 and 443 in the VPS firewall. Port 3000 doesn't need to be public in this setup; you can remove the `ports` line from the `hearth` service.

**Without Docker:** install Node 20+, run `npm ci --omit=dev`, use `deploy/hearth.service` for systemd, and install [Caddy](https://caddyserver.com/docs/install) with a Caddyfile that says `reverse_proxy localhost:3000`.

---

## Upgrading a server that already has users

**Updates barely interrupt anyone.** The new version is prepared while the old one keeps running; the switch itself takes a couple of seconds. During that moment, people with Hearth open see an "Updating…" spinner, and then their app moves to the new version on its own — same conversation, unsent message kept (if they're in a call, they get a "reload when you're ready" bar instead). Behind Caddy, requests during the switch are held for a moment instead of failing, so nobody sees an error page. (The update tool adds that Caddy setting for you; manually, it's `lb_try_duration 30s` inside your `reverse_proxy` block.)

**The easy way: the update tool.** Keep the `tools/` folder from this download on your computer.

- **Windows:** double-click `tools/Update-Hearth.bat` (or drag the new zip onto it). Undo with `Rollback-Hearth.bat`.
- **Mac/Linux:** `tools/update-hearth.sh path/to/update.zip` (undo: `--rollback`).

The first time, it asks for your server address and offers password-free login. On the server it backs up the program files and database, copies in the new files (never touching `data/`, `.env`, `docker-compose.yml` or `deploy/Caddyfile`), builds the new version while the old one keeps running, switches over, checks the new version answers, and **rolls back automatically** if it doesn't. It works with Docker, systemd, pm2 or plain `node`. On the server you can also run `hearth-update <zip>` or `hearth-update --rollback` directly. Backups go to `/root/hearth-backups` (the last 5 are kept).

**The manual way:**

Upgrades never touch accounts, passwords, encryption keys or messages — they only add new tables and columns.

1. **Back up** the `data/` folder and `.env` (copy them somewhere safe). Hearth also makes its own copy automatically: before applying a database upgrade it saves `data/backups/hearth-before-vN-<date>.db`.
2. Replace the program files with the new version, **keeping `data/` and `.env`**.
3. Install dependencies and restart:
   - Without Docker: `npm install --omit=dev`, then `sudo systemctl restart hearth` (or however you start it).
   - With Docker: `docker compose up -d --build`.
4. Check the log for `Backed up the database before upgrading: …` followed by `Hearth is running.` People with Hearth open get a "new version ready" prompt; nobody is logged out.

**If something goes wrong**, stop the server and put the backup back:
```bash
sudo systemctl stop hearth            # or: docker compose down
cp data/backups/hearth-before-v5-<date>.db data/hearth.db
rm -f data/hearth.db-wal data/hearth.db-shm
# then run the previous version of the program files again
```

**What this upgrade (roles) changes for existing servers:** every server gets an `@everyone` role with the usual permissions, and anyone who was an Admin gets a new "Admin" role with the Administrator permission — so everyone keeps exactly the access they had.

## Roles, permissions and server customization

Open the server name menu → **Server settings** (or **Roles**). Tabs appear based on what you're allowed to do.

- **Roles:** create roles, pick a color and an emoji badge, drag them up or down (higher roles outrank lower ones), toggle "show separately" and "@mentionable", and switch individual permissions on. You can only edit and hand out roles *below* your own highest role, and you can't give permissions you don't have — so a moderator can't promote themselves. The owner and anyone with **Administrator** can do everything.
- **Channel permissions:** right-click a channel → **Permissions**, **Make private** or **Make read-only**. Each permission can be set to allow (✓), deny (✕) or inherit (/) for @everyone, any role, or a specific person.
- **Members:** add or remove roles, kick or ban (only people below you). **Bans** stop people rejoining through invites until unbanned.
- **Appearance:** accent color, server background (preset, custom gradient or image, with darkening), role-colored names, and a welcome message shown at the top of every channel. Members can turn server themes off for themselves under Settings → Appearance.
- **Overview:** icon (GIFs work) and its shape, name, description, and a banner you can position and zoom.
- **Emoji:** upload PNG/GIF/WebP emoji (up to 200 per server, 1 MB each). Type `:name` in the message box or use the emoji picker; they work in every server and DM, and as reactions.

Good to know: private channels are enforced by the server — people without access never receive those messages. Like the rest of the server, they're end-to-end encrypted with the server's key, which every member holds, so private channels keep things away from other members by the server's choice rather than by separate encryption. "Speak" is enforced by the app (listen-only members join muted). @everyone and role mentions only notify people when the sender is allowed to use them.

## Docker

```bash
docker compose up -d          # https://<host>:3000 with a self-signed certificate
docker compose logs -f        # see the startup addresses and any errors
docker compose up -d --build   # rebuild after updating the files
```

Everything is stored in `./data`. Requires Docker Compose 2.24 or newer.

---

## Admin dashboard, reports and safety

The first account created on the server (or anyone listed in `ADMIN_USERS`) sees a shield button in the left bar: the **admin dashboard**.

- **Overview:** accounts, who's online, activity, message counts (never content), storage, open reports, 14-day charts.
- **Online:** everyone connected right now, with their IP addresses, devices and voice channel.
- **Reports:** what was reported, the messages the reporter shared, the reported account's IP addresses, and buttons to suspend the account, delete the message, resolve or dismiss. You get a live notification when a report comes in.
- **Users:** search by name or IP; see IP history, signed-in devices and reports; suspend (signs them out everywhere at once, and they see your reason when they try to log in) or sign them out everywhere.
- **Registration & Terms:** switch sign-ups between open, invite-code only and closed in one click (handy during a spam wave), and edit your Terms of Service (everyone is asked to accept changes).
- **Audit log:** every admin action, who did it and from which IP.

**About IP addresses:** the server records which IP addresses each account connects from, for security and abuse reports. The default Terms say so; keep that in your terms if you edit them, and check what your local privacy laws require.

### Security built in
- **Captcha on sign-up and login:** a private, self-hosted "I'm not a robot" check (proof of work, like ALTCHA). People's browsers solve a small puzzle — about a fifth of a second on a computer, usually finished before they've typed their password — which makes mass sign-ups and password guessing expensive for bots. Puzzles are signed, single-use and expire after 5 minutes; IPs that keep failing get harder puzzles automatically. No Google/hCaptcha scripts and no tracking. Turn it on or off for login and sign-up in Admin → Registration & Terms.
- Strict browser security policy (only this server's own scripts can run), clickjacking protection, HSTS on HTTPS, locked-down browser permissions.
- Login throttling per IP *and* per account (an account's usual IPs are exempt, so nobody can lock someone out by spamming wrong passwords). Sign-ups are limited per IP and overall.
- Live connections are rate-limited; floods are disconnected.
- Behind Caddy/nginx, real client IPs are detected automatically. Plain-HTTP requests that bypass your proxy from the internet are refused (`ALLOW_DIRECT_HTTP=true` turns that off).
- Suspended accounts are cut off instantly, including open connections.

## Calls not connecting for some people? Set up the relay (5 minutes, once)

Calls go directly between people. Some networks (mobile data, many home routers, school/office Wi-Fi) block that, so those people need a **relay** (TURN server). On your VPS run:

```bash
cd "/opt/hearth (1)/hearth"     # your Hearth folder
bash scripts/setup-turn.sh
```

It installs coturn, locks it down (short-lived passwords per user, no relaying into private networks, bandwidth limits), opens the firewall ports, and connects it to Hearth — no restart needed. Check it with **Settings → Instance → Calls → Test relay**. If your VPS provider has its own firewall in their control panel, open UDP+TCP 3478 and UDP 49160–49400 there.

## Turning on GIFs (KLIPY, free)

Tenor shut down in June 2026; GIPHY's free keys allow only ~100 searches an hour. **KLIPY** (used by Discord and WhatsApp) has free keys, and its **production keys are free and unlimited**:

1. Sign up at [partner.klipy.com](https://partner.klipy.com/api-keys) and create an API key.
2. In Hearth: **Settings → Instance → GIF search → KLIPY**, paste the key, **Test**, **Save**.
3. In KLIPY's panel, **request production access** (free) to remove the 100/hour test limit.

Hearth also caches GIF results and shares them between everyone (trending and categories for 30 minutes, searches for 15), so popular searches cost one API call instead of one per person. GIPHY still works if you prefer it.

## Turning on GIFs (GIPHY)

GIPHY needs a free API key (GIPHY no longer offers a shared public key):

1. Sign in at [developers.giphy.com/dashboard](https://developers.giphy.com/dashboard/), click **Create an App**, choose **API** (not SDK), and copy the key.
2. In Hearth, open **Settings → Instance**, paste the key, click **Test**, then **Save key**. GIFs turn on for everyone immediately — no restart, no file editing.

(Alternatively put `GIPHY_API_KEY=...` in `.env`; a key saved in the app takes priority.)

**Who can see Settings → Instance?** The server administrator: the people listed in `ADMIN_USERS` in `.env` (comma-separated usernames), or — if that's not set — the first account created on the server.

Good to know:
- New keys are "beta" keys limited to roughly **100 searches per hour** for the whole server. If your community outgrows that, apply for a free production key in the GIPHY dashboard and paste it in.
- **Privacy proxy (on by default):** GIFs are fetched by your server and passed on, so GIPHY sees your server, not your members. Only GIPHY's media hosts are allowed, and links are signed per user, so it can't be used as a general proxy. It uses some bandwidth; turn it off in Settings → Instance if you'd rather not.
- GIF searches go from your server to GIPHY, which sees the search words (not who searched). Sent GIFs are links inside your encrypted messages.
- Content rating defaults to PG-13 and can be changed in Settings → Instance.
- People with **Manage emoji** can turn any GIPHY GIF or sticker into a server emoji (Server settings → Emoji → Add from GIPHY).

## Getting the app to your users

Send people **`https://your-server/download`**. It detects their device and shows the right option.

### Install from the browser (all platforms, nothing to build)

Hearth is an installable web app. Once your server has a real HTTPS certificate (see the VPS section — browsers won't install apps or send push notifications from a self-signed certificate):

- **Windows / Mac / Linux (Chrome, Edge):** the install icon in the address bar, or *Settings → Apps & devices → Install app*.
- **Android:** browser menu → *Install app*.
- **iPhone / iPad:** Safari → Share → *Add to Home Screen* (iOS 16.4+ for notifications).

Installed apps open in their own window, start instantly from cache, update themselves (users get a "new version ready" prompt), and show an unread badge where the system supports it.

**Push notifications** reach people when Hearth is closed. Each person turns them on per device in *Settings → Apps & devices*. Because messages are end-to-end encrypted, a notification only says who and where (e.g. "Alex mentioned you · #general"), never the message. To work out who was @mentioned, the sender's app tells the server which member IDs it mentions — that's the only extra thing the server learns. The server creates its push keys in `data/vapid.json` on first start; set `VAPID_SUBJECT=mailto:you@yourdomain` in `.env` (Apple's push service rejects placeholder addresses).

### Desktop app (Windows, macOS, Linux)

The `desktop/` folder is an Electron app: its own window, tray icon, unread badge, native notifications, start-at-login, and microphone/notification permissions limited to your server. It loads the interface from your server, so web updates reach desktop users without reinstalling.

**Point it at your server:** edit `desktop/hearth.config.json`:

| Key | What it does |
|---|---|
| `defaultServer` | Your address, e.g. `https://chat.example.com`. Empty = ask on first launch. |
| `lockServer` | `true` to hide "Change server" (a branded app for your community). |
| `appName`, `appId` | Window title, and the ID Windows/macOS use for notifications. Also change `productName`/`appId` in `desktop/package.json` if you rebrand. |
| `closeToTray` | Keep running in the tray when the window is closed (Windows/Linux). |
| `trustedSelfSignedHosts` | Hosts whose self-signed certificate is accepted without asking. Otherwise the app asks once and remembers that exact certificate. |

**Build installers automatically (recommended):** push this project to a GitHub repository, then either push a tag (`git tag desktop-v1.0.0 && git push --tags`) or run the *Desktop app* workflow from the Actions tab (you can type your server address there). GitHub builds `.exe` (Windows), `.dmg` (macOS) and `.AppImage`/`.deb` (Linux) and attaches them to a release. To also copy them to your server automatically, add repository secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` and `VPS_DOWNLOADS_DIR` (the absolute path of your `data/downloads` folder).

**Build on your own computer:** `cd desktop && npm install && npm run dist` (builds for the system you're on).

**Publish them:** put the installer files in `data/downloads/` on the server (or set `DESKTOP_DOWNLOAD_URL` to your GitHub releases page). They appear on `/download` automatically.

**Code signing:** unsigned builds work, but Windows shows a SmartScreen warning ("More info → Run anyway") and macOS needs right-click → Open the first time. Removing those warnings needs a code-signing certificate (Windows) and an Apple Developer account ($99/year, macOS notarization); electron-builder picks them up from environment variables when you have them. Auto-update via GitHub releases works on Windows and Linux.

**Phones:** use the installable web app above. Publishing to the App Store / Play Store means wrapping it (e.g. with Capacitor) and going through their review — not included.

---

## Video calls and screen sharing — good to know

- Calls are peer-to-peer (each person sends to each other person), which keeps them private and costs your server nothing. It works best with **up to about 4–6 people on camera** at once; voice-only handles more.
- **Screen audio:** in Chrome/Edge, tick "Share audio" in the picker (tab audio everywhere; whole-system audio on Windows). Firefox and Safari share the picture only. In the desktop app, Windows shares system audio automatically.
- **Desktop app:** screen sharing needs the new desktop build (it adds a "Choose what to share" picker). Rebuild with the GitHub workflow (push a new `desktop-v…` tag) — everything else in the app updates on its own.
- Behind strict networks (some offices, mobile carriers), add a TURN server (see below) so video can always connect.

## Voice not working?

Voice goes directly between people's browsers (peer to peer). Most home connections work with the default STUN servers. If someone can join a channel but nobody can hear them (or the panel stays on "Connecting…"), their network is blocking direct connections and you need a **TURN relay**:

1. On a VPS, install coturn and use `deploy/turnserver.conf` as a starting point.
2. Add to Hearth's `.env`:
   ```
   TURN_URL=turn:your.vps.ip:3478
   TURN_USERNAME=hearth
   TURN_CREDENTIAL=change-me
   ```

Other things to check: the browser has microphone permission for the site, the page is on `https://`, and the right mic is picked in **Settings → Voice & audio** (use **Test microphone**).

Each person sends audio to everyone else, so a voice channel works best with up to about 8–10 people.

---

## Security and privacy — what's protected

All chats are end-to-end encrypted: your browser encrypts each message and file before it leaves your device, and only the people in the conversation can decrypt it. Whoever runs the server — including you — sees only ciphertext.

| | Can the server read it? |
|---|---|
| Server channel messages and files | **No** — end-to-end encrypted, signed by the sender |
| Direct messages and files | **No** — end-to-end encrypted |
| Voice | **No** — encrypted directly between browsers (DTLS-SRTP), handshakes signed |
| Who's in which server, who messages whom and when, emoji reactions, server/channel names, avatars and profiles | Yes |
| Messages sent before the encryption upgrade | Yes, with `data/secret.key` (shown in the app as "Older message — not end-to-end encrypted") |

### How it works

| Part | What's used |
|---|---|
| Your password | Never sent anywhere. Hardened in the browser with **Argon2id** (64 MiB memory, 3 passes, random salt). One half logs you in; the other unlocks your private keys. Older accounts are upgraded from PBKDF2 automatically at their next login. |
| Your identity key | **ECDH P-256** key pair. The private half is stored on the server only after being locked (AES-256-GCM) with your password-derived key. |
| Your signing key | **ECDSA P-256**. Signs channel messages, key handoffs and voice handshakes so nobody can impersonate you. |
| Each message | **AES-256-GCM** with its own key, derived by **HKDF-SHA256** from the conversation key and a random 256-bit salt. The channel or DM, the author and the key version are bound in, so the server can't move a message or change who sent it. |
| Each attachment | Its own random AES-256-GCM key, carried inside the encrypted message. |
| DMs | Conversation key from ECDH between the two of you. DMs aren't signed, so they stay deniable (like Signal). |
| Server channels | A random 256-bit **group key** per server, sent to each member encrypted to their identity key (ECIES) and signed by whoever shared it. When anyone leaves or is removed, a new key is created automatically and given only to the remaining members, so former members can't read anything new. New members can read from the key that was current when they joined; older messages stay locked to the people who were there. |

### Verifying people

Your browser remembers everyone's keys the first time it sees them. If the server ever hands out different keys for someone (the classic way to secretly listen in), you'll see **Security key changed**, sending to them pauses, and key sharing with them stops until you check. To verify someone, open a DM, click **End-to-end encrypted**, and compare the 60-digit safety number with them in person or on a call. Server encryption details (key version, who holds it, "Replace key now") are under the **End-to-end encrypted** badge in any channel.

### Things to know

- **Saved messages, the notification center and per-device preferences** (layout, favorites, collapsed categories, notification levels) live in your browser, not on the server.
- **There is no password reset.** Your password is what unlocks your keys. If you forget it, your messages can't be decrypted by anyone, including the host. You can make a new account.
- **Logging out removes your keys from that browser.** Log back in to read everything again — your history works on every device you log in from.
- **New members need someone online.** A member who already has the server's key must be online (any open tab, even in the background) to hand it to a new member. Until then they see "Waiting for the encryption key".
- **Trust on first use.** The key-change warning protects you from the moment your browser first sees someone. On a brand-new device you're trusting the server's first answer — that's what safety numbers are for.
- **Membership is controlled by the server.** A malicious host could add a hidden member to a server, who would then be given the key. They would show up in the member list, so keep an eye on it in sensitive servers.
- **No forward secrecy for history.** To let your full history follow you to every device, your long-term key can decrypt your past messages. If someone gets both your password and the server's data, they can read your history. (Signal makes the opposite trade-off.)
- **Metadata isn't hidden** — see the table above. Run the server on hardware you control and use HTTPS.
- Treat a self-hosted server like any small website: keep the machine updated and use `REGISTRATION_CODE` or `REGISTRATION_OPEN=false` if you don't want strangers signing up.

---

## Backups

Back up the whole `data/` folder:

- `hearth.db` — accounts, servers, messages
- `secret.key` — only needed for messages sent before end-to-end encryption was turned on (and keeps the login screen from revealing which usernames exist)
- `uploads/` — images and files
- `backups/` — automatic copies made before each database upgrade (safe to delete old ones)
- `vapid.json` — push notification keys (if lost, everyone has to turn push back on)
- `downloads/` — installers you publish
- `cert.pem`, `key.pem` — the self-signed certificate (safe to delete; it's regenerated)

Stop the server (or copy while idle) for a clean copy of the database.

---

## Settings reference (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `INSTANCE_NAME` | `Hearth` | Name in the tab and login screen |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where to listen |
| `HTTPS` | `true` | Self-signed HTTPS. Set `false` behind a reverse proxy |
| `SSL_CERT` / `SSL_KEY` | — | Use your own certificate files |
| `PUBLIC_HOSTS` | — | Extra IPs/hostnames for the self-signed certificate |
| `TRUST_PROXY` | — | Set to `1` behind Caddy/nginx |
| `REGISTRATION_OPEN` | `true` | Allow new sign-ups |
| `REGISTRATION_CODE` | — | Require this code to sign up |
| `MAX_UPLOAD_MB` | `25` | Max size per file |
| `GIPHY_API_KEY` | — | Turns on GIF search (or set it in Settings → Instance) |
| `ADMIN_USERS` | first account | Usernames that can open the admin dashboard and Settings → Instance |
| `ALLOW_DIRECT_HTTP` | `false` | Allow plain-HTTP access from the internet when `HTTPS=false` (not recommended) |
| `GIF_PROXY` | `true` | Load GIPHY media through this server (also switchable in the app) |
| `STUN_URLS` | Google STUN | Comma-separated STUN servers |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | — | TURN relay for voice |
| `DATA_DIR` | `./data` | Where data lives |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact address for push services — set your real email |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto | Push keys (default: generated into `data/vapid.json`) |
| `DOWNLOADS_DIR` | `data/downloads` | Installers offered on `/download` |
| `DESKTOP_DOWNLOAD_URL` | — | Link `/download` to your GitHub releases page instead |
| `AT_REST_KEY` | — | 64-hex-char key instead of `data/secret.key` (for pre-upgrade messages) |

---

## Keyboard shortcuts

- **Ctrl/⌘ + K** search anything
- **Enter** send, **Shift+Enter** new line (switchable to Ctrl+Enter in Settings → Chat)
- **@** then a name to mention someone; **↑/↓** and **Enter** to pick
- **↑** in an empty message box edits your last message, **Esc** cancels editing, a reply, or closes a thread
- **Alt + ↑/↓** move between channels or conversations in the sidebar
- **Ctrl/⌘ + Shift + M** mute, **Ctrl/⌘ + Shift + D** deafen
- In the image viewer: **←/→** previous/next, **+/−** zoom, **Esc** close
- Right-click messages, channels, servers and people for more actions

## Not included (yet)

Video and screen sharing, App Store / Play Store builds, separate encryption keys per private channel, drag-and-drop reordering of channels (use the Move up/down menu items), and encrypted reactions.

## Project layout

```
server/index.js     HTTP API, Socket.IO realtime, voice signaling
server/db.js        SQLite schema, encrypted-key storage
server/profile.js   Profile validation
server/perms.js     Roles and permission rules
public/             The web app (plain JavaScript modules, no build)
public/js/e2ee.js   Encryption primitives (WebCrypto + Argon2id)
public/js/secure.js Key management: group keys, rotation, verification
public/sw.js        Service worker: offline app shell, updates, push notifications
scripts/            hearth-update.sh — safe server-side updater with automatic rollback
tools/              One-click update tool for Windows / Mac / Linux
desktop/            Electron desktop app + build config
.github/workflows/  Builds desktop installers on GitHub
deploy/             Caddy, coturn and systemd examples
```

MIT licensed.
