# Hearth

A self-hosted place to hang out with your friends: servers with text and voice channels, direct messages, a friends list, and profiles you can customize as much as you like. Run it on your own computer or a cheap VPS and send your friends an invite link.

- **Servers** with categories you can collapse and reorder, text and voice channels, invites, bans and per-server notification levels.
- **Roles and permissions:** unlimited custom roles with colors, emoji badges, hierarchy, "show separately" in the member list and @mentions; 17 permissions; per-channel overrides for any role or person (private channels, read-only announcements, listen-only voice); slowmode per channel.
- **Make your server yours:** banner (positionable, GIFs animate), description, accent color, a server-wide background (presets, custom gradients or an image), welcome message, icon shape, role-colored names, and up to 200 custom emoji — animated GIF, WebP and APNG included, uploaded in bulk or grabbed straight from GIPHY — that members can use in any server or DM.
- **Conversations** with replies, threads, reactions, pins, edits, forwarding, saved messages, @mentions (including @everyone and @channel), Markdown, spoilers, code blocks, GIFs, emoji search, and image/video/file attachments with a full-screen image viewer.
- **GIFs, stickers and emoji in one picker, laid out like Discord's:** GIFs / Stickers / Emoji tabs, big Favorites, Trending and category tiles, a back arrow out of any category or search, results in two steady columns that keep loading as you scroll, and a star on every GIF. Through KLIPY or GIPHY, with a privacy proxy so they never see your members' IP addresses.
- **Direct messages and group DMs** (up to 10 people, with group voice calls).
- **Home screen** with recent and pinned conversations, online friends, your servers and recent activity.
- **Search everything with Ctrl+K**: people, channels, servers, messages, files and links, with filters like `from:`, `in:`, `before:` and `has:`. Because messages are end-to-end encrypted, message search runs on your device; the server never sees the words (see [Search](#search-ctrlk)).
- **Notification center** for mentions, replies and friend requests, plus unread and mention indicators that respect muted channels and servers.
- **Voice and video:** voice channels, group DM calls and 1-to-1 **DM calls that ring** (accept, accept with video, decline). **Webcam** and **screen sharing with sound** everywhere, with a spotlight view, fullscreen, picture-in-picture and per-person volume. Calls go directly between participants when they can, encrypted (DTLS-SRTP). When a network blocks that, they go through a TURN relay (this server, if `setup-turn.sh` installed it here, or a linked region), which only ever sees encrypted packets. Mute, deafen, speaking indicators and an optional input-sensitivity gate.
- **End-to-end encryption for everything:** server channels, DMs, group DMs and every attachment are encrypted in your browser before they're sent. The server stores only scrambled data, so the person hosting it can't read your chats from it, as long as the app code the server sends you is honest. It does see who talks to whom and when (see [what's protected](#security-and-privacy--whats-protected) and [SECURITY.md](SECURITY.md)).
- **Admin dashboard** for server administrators: live stats, who's online (with IP addresses and devices), reports with evidence, user lookup with IP history, suspend / unsuspend, sign out everywhere, registration control (open, invite code, closed), a Terms of Service editor, and an audit log of every admin action.
- **Reporting:** anyone can report a message or a person. Because messages are end-to-end encrypted, the reporter's app shares the messages they choose (shown to them first); the server verifies who sent them and when.
- **Terms of Service** that everyone accepts at sign-up (and again when you change them); public page at `/terms`.
- **Sounds you choose:** 30+ built-in sounds (bells, marimba, kalimba, plucked strings, glass, chiptune…) for every event — DMs, group DMs, @you, @everyone, role mentions, replies, voice — or your own sound files.
- **Privacy and safety:** blocking (the DM freezes both ways: no new messages, edits, reactions, pins, poll votes or typing; people can still delete their own), who can DM you ("friends only" also stops non-friends adding you to group chats), who can send friend requests, and a list of signed-in devices you can sign out remotely.
- **MySpace-style profile pages:** everyone gets a full page (open anyone's profile): headline (it can scroll like a marquee), mood, glitter name, profile song (optional autoplay), "Who I'd like to meet", an interests table, custom details (Location, Zodiac…), a Friend Space with your top 8 and a friend count, a **comment wall** (anyone / friends only / nobody), a retro profile-view counter and a **cursor trail**. Style it with six starter themes or by hand: layout, background (gradient, color, 8 patterns, or your own tiling image), box colors, opacity, 9 border styles, corners, shadows, fonts and text size. **Custom CSS** works too, safely: it only affects your own page, and anything that would load from another site is stripped. It can't cover the rest of the app or the close button, or hide text, and visitors leave comments in Hearth's own dialog.
- **Make your own effects:** pick any characters or emoji (up to 6), how they move (fall, rise, float, drift, twinkle, spin, zoom, bounce), how many, speed, size, color and glow; it plays on your card and across your whole page. Names can use up to 4 colors with flowing, pulse, wave, neon, glitch, outline and retro-shadow effects; avatar rings can spin with 3 colors at the speed you choose.
- **Profiles, all free:** GIF or image avatar, banner and full-card background; display name, pronouns, bio, links and custom status; name colors, gradients, 12 fonts and glow/shimmer/rainbow effects; avatar shapes and animated rings; card colors, presets, glass style and animated effects.
- **Your layout:** rearrange the server bar, channels, conversation and side panel in any order (or pick a preset), put the server bar across the top, drag panel edges to resize, and choose floating, attached or spacious panels.
- **Pictures you can position:** move and zoom your avatar, banner and profile background after uploading — animated GIFs keep animating.
- **Installable apps:** install from the browser on Windows, Mac, Linux, Android and iPhone, with push notifications when the app is closed; plus a desktop app (Windows/Mac/Linux) built automatically by GitHub Actions and a `/download` page for your users.
- **Fonts, corners and shareable looks:** pick the interface font (Figtree, System, Readable, Rounded, Serif, Mono) and corner style (sharp, normal, round), then save your whole look to a small file to back it up, move it to another device or give it to a friend (Settings → Appearance → Save or share your look).
- **Look and layout:** three message densities (comfortable, compact, minimal), text size, accent color and reduced motion. **Themes and backgrounds:** Dark (default), Midnight, Dim, Ember and Light themes; 22 background presets (adaptive glows and patterns, dark and bright gradients); your own gradient builder (linear, radial, mesh, conic, 2–3 colors) or your own image/GIF, with panel transparency, darken/fade, blur and a slow-drift animation. Saved per device.
- **Settings** grouped into Account (profile, security, sessions), App (appearance, chat, notifications, voice & audio), Privacy & safety, and Server settings.

- **Watch together:** in any call (voice channels, DMs, groups) share a YouTube, Vimeo, Twitch (live) or video-file link and everyone watches the same moment — play, pause, seek and speed stay in sync, people who join late jump right in, there's an "up next" queue, and the starter can keep control to themselves (then only they skip; the next video starts once most of the call has reached the end). Links can be up to 2,048 characters; the queue holds up to 25 videos.
- **GIFs without limits:** besides KLIPY/GIPHY, every Hearth has its own GIF library (upload GIFs, search them, no key, no limits). When a provider says "too many requests", the picker quietly switches to recent results and the library instead of failing.
- **Owner tools:** server health (CPU, memory, disk, connections, responsiveness), one-click and automatic daily database backups with download, server name and tagline, feature switches (watch together, GIFs, comment walls, custom CSS, who can create servers), and a funding card with 💜 supporter badges and optional extra storage for supporters.
- **Polls:** ask a question with 2–10 answers (single or multiple choice); votes update live for everyone and the poll creator can close it.
- **Voice messages:** hold a conversation without typing — record from the mic button in any chat; they're end-to-end encrypted like every other file and play with a waveform and speed control.
- **Events:** plan game nights and hangouts in any server with a time, place and description; members RSVP (going / maybe / can't), the next event shows at the top of the channel list and on Home under "Coming up", everyone gets a heads-up 15 minutes before, and events can be added to your calendar (.ics).
- **Reminders:** right-click any message → *Remind me* (in 20 minutes, in 1 hour, tonight, tomorrow morning).
- **People:** a directory of everyone you share a server with (search, online first, friends badge), and every profile card opens a full MySpace-style page with a big header — banner, avatar, name, headline, mood, status and when they joined.
- **Games & music:** show the game you're playing ("Playing ELDEN RING · for 1h 20m") and the song you're listening to (album art, artist, "on Spotify" with an *Open in Spotify* button), in member lists, friends, profile cards and pages. The desktop app detects both by itself (any Steam game plus 60+ popular others like Fortnite, Valorant, League, Minecraft, Roblox; the Spotify app; Apple Music on Mac; any player on Linux). Anywhere else, link Last.fm (works with Spotify, Apple Music, YouTube Music, TIDAL, Deezer) or set it by hand by pasting a song link. Plus **favorite games** (up to 12 covers) and **recently played** with hours. Pictures come from Steam and Wikipedia, cached on your server.
- **Regions:** each region also keeps copies of your encrypted backups. Add call relays in other parts of the world from Admin → Regions with one install command each; they check in every minute, show their load and traffic, and a call can be switched to any region (🌐 in the call bar, like Discord's region override) and everyone in it moves together; otherwise everyone's app uses the nearest two automatically.
- **Automatic supporters:** Ko-fi and Stripe payments turn on the 💜 supporter badge and perks (more storage, bigger files) by themselves for as long as someone paid, and count toward the funding card.
- **Android app:** an APK built by GitHub Actions that opens your server with calls, voice messages, notifications and file saving; works with a self-signed certificate (asks once, like the desktop app).
- **Fast:** messages send instantly (they show as "sending…" until delivered, and you can keep typing), long chats stay light, the app's files are sent compressed, and **Performance mode** (Settings → Appearance) turns off blur, moving backgrounds and decorative animations on slower computers — it switches on by itself on low-powered devices.

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

Open the first one, click through the certificate warning (see below), and create your account. The first person to sign up becomes this Hearth's owner and gets the admin dashboard (unless `ADMIN_USERS` names someone else, see the settings table). In chat they're like everyone else, and anyone can create servers.

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
   HEARTH_BIND=127.0.0.1
   ```
   (`HEARTH_BIND` keeps port 3000 off the internet: Docker-published ports go around the server's firewall. `docker-compose.yml` already trusts its own Caddy for visitors' addresses; set `TRUST_PROXY` in `.env` only for a different proxy, and it then replaces that default. If Docker says the proxy network overlaps another network, change the subnet in both places in `docker-compose.yml`.)
5. Start it:
   ```bash
   docker compose --profile domain up -d
   ```
6. Open `https://chat.example.com`. Caddy gets a real certificate automatically, so there's no warning.

Open ports 80 and 443 in the VPS firewall. Then lock the server down with `sudo bash scripts/harden-vps.sh` (see [Locking down the VPS](#locking-down-the-vps)).

**Without Docker:** install Node 20+, run `npm ci --omit=dev`, use `deploy/hearth.service` for systemd (it runs Hearth as its own `hearth` user in a sandbox), and install [Caddy](https://caddyserver.com/docs/install) with a Caddyfile that says `reverse_proxy localhost:3000`. Caddy on the same machine needs no `TRUST_PROXY`.

### Locking down the VPS

First run `sudo bash scripts/harden-vps.sh --dry-run` to see what it would do, then `sudo bash scripts/harden-vps.sh`. Add `--yes` for no questions, or `--auto-reboot` to allow restarts at 04:00 after security updates. It:

- switches on the firewall (SSH, 80, 443, and the call relay's ports if installed);
- turns off SSH password logins, but only if you already log in with a key, so it never locks you out (keep your session open and test a new login);
- sets up fail2ban for SSH and automatic security updates;
- moves a root-run systemd Hearth to the sandboxed `hearth` user, putting the old service back automatically if Hearth doesn't answer;
- lists anything else reachable from the internet.

It's safe to run again any time. If your VPS provider has its own firewall, open the same ports there. The full threat model and what each protection guarantees are in [SECURITY.md](SECURITY.md).

---

## Upgrading a server that already has users

**Updates barely interrupt anyone.** The new version is prepared while the old one keeps running; the switch itself takes a couple of seconds. During that moment, people with Hearth open see an "Updating…" spinner, and then their app moves to the new version on its own — same conversation, unsent message kept (if they're in a call, they get a "reload when you're ready" bar instead). Behind Caddy, requests during the switch are held for a moment instead of failing, so nobody sees an error page. (The update tool adds that Caddy setting for you; manually, it's `lb_try_duration 30s` inside your `reverse_proxy` block.)

**The easy way: the update tool.** Keep the `tools/` folder from this download on your computer.

- **Windows:** double-click `tools/Update-Hearth.bat` (or drag the new zip onto it). Undo with `Rollback-Hearth.bat`. `Check-Server.bat` shows the version, whether Hearth is answering, free disk space and backups without changing anything.
- **Mac/Linux:** `tools/update-hearth.sh path/to/update.zip` (undo: `--rollback`, check: `--status`, logs: `--logs`). Given no zip, it offers the newest Hearth zip in Downloads and uses it only once you say yes.

Each release is a zip plus a `.sha256` file next to it (made with `bash scripts/make-update-zip.sh [folder]`; the default folder is `hearth/dist`). **Keep both in the same folder.** The tools refuse a zip that doesn't match its `.sha256`, and always print the SHA-256 they install: compare it with the one in the release notes. A checksum catches a damaged or swapped zip only when you check it against one published somewhere else; it isn't a signature.

The first time, it asks for your server address and offers password-free login (with password login you type it twice per update: upload, then install). On the server the upload goes into a private temporary folder and is checked again before anything runs. It backs up the program files and database, copies in the new files (never touching `data/`, `.env`, `docker-compose.yml` or `deploy/Caddyfile`), builds the new version while the old one keeps running, switches over, checks the new version answers, and **rolls back automatically** if it doesn't. It works with Docker, systemd, pm2 or plain `node`; a plain install is restarted, and its libraries installed, as the owner of `data/`, never as root (one that root itself started stays root, with a warning). On the server you can also run `hearth-update <zip>` (the zip path is required), `hearth-update --rollback [backup]`, `hearth-update --list`, `hearth-update --status` or `hearth-update --logs` directly. If an update stops, the log names the exact step that failed ("Step failed …") and the Windows tool saves the whole log as `tools/last-update-log.txt`. Backups go to `/root/hearth-backups` (the last 5 are kept).

**The manual way:**

Upgrades keep your accounts, passwords, encryption keys and messages, but they're not only additions: some convert existing data (for example how sign-in sessions or the audit log are stored). That's why Hearth copies the database first.

1. **Back up** the `data/` folder and `.env` (copy them somewhere safe). Hearth also makes its own copy automatically: before applying a database upgrade it saves `data/backups/hearth-before-vN-<date>.db` (a consistent copy, made once per upgrade).
2. Replace the program files with the new version, **keeping `data/` and `.env`**.
3. Install dependencies and restart:
   - Without Docker: `npm ci --omit=dev`, then `sudo systemctl restart hearth` (or however you start it).
   - With Docker: `docker compose up -d --build`.
4. Check the log for `Backed up the database before upgrading: …` (or `The database was already backed up before this upgrade: …` when an upgrade is tried again) followed by `Hearth is running.` People with Hearth open get a "new version ready" prompt; nobody is logged out.

An upgrade is all-or-nothing: if Hearth is stopped part-way through, nothing has changed and it simply runs again on the next start.

**If something goes wrong**, stop the server and put the backup back. Hearth refuses to start on a database written by a newer version ("This database … was written by a newer version of Hearth"), so going back to older program files **needs** the copy from before the upgrade:
```bash
sudo systemctl stop hearth            # or: docker compose down
cp data/backups/hearth-before-v<N>-<date>.db data/hearth.db
rm -f data/hearth.db-wal data/hearth.db-shm
# then run the previous version of the program files again
```

**What this upgrade (roles) changes for existing servers:** every server gets an `@everyone` role with the usual permissions, and anyone who was an Admin gets a new "Admin" role with the Administrator permission — so everyone keeps exactly the access they had.

## Roles, permissions and server customization

Open the server name menu → **Server settings** (or **Roles**). Tabs appear based on what you're allowed to do.

- **Roles:** create roles, pick a color and an emoji badge, drag them up or down (higher roles outrank lower ones), toggle "show separately" and "@mentionable", and switch individual permissions on. You can only edit and hand out roles *below* your own highest role, and only roles whose permissions (including their per-channel overrides) you already have — so a moderator can't promote themselves, even to an Administrator role that sits lower. The owner and anyone with **Administrator** can do everything.
- **Channel permissions:** right-click a channel → **Permissions**, **Make private** or **Make read-only**. Each permission can be set to allow (✓), deny (✕) or inherit (/) for @everyone, any role, or a specific person. Editing a channel or its permissions needs Manage Channels or Manage Roles *in that channel*, and you can only allow or deny what you have there. A moderator who isn't an Administrator can't take anything away from people at or above them, even through @everyone (the owner or an Administrator gives those roles their own access first); "Make private" and "Make read-only" keep the moderator's own access. Invites are for the whole server, so there's no per-channel invite permission.
- **Members:** add or remove roles, kick or ban (only people below you). Leaving, a kick or a ban removes the person's roles and per-channel permissions; rejoining starts from @everyone (roles from a membership they still pay for come back by themselves). **Bans** stop people rejoining through invites until unbanned, and revoke the invite links the banned person made.
- **Invites:** new invite links expire after 7 days unless you choose otherwise (1 hour, 1 day, 30 days or never). **Server settings → Invites** (Manage Server) lists the links that still work and revokes them; anyone can revoke the links they made.
- **Appearance:** accent color, server background (preset, custom gradient or image, with darkening), role-colored names, and a welcome message shown at the top of every channel. Members can turn server themes off for themselves under Settings → Appearance.
- **Overview:** icon (GIFs work) and its shape, name, description, and a banner you can position and zoom.
- **Emoji:** upload PNG/GIF/WebP emoji (up to 200 per server, 2 MB each). Type `:name` in the message box or use the emoji picker; they work in every server and DM, and as reactions.

Good to know: private channels are enforced by the server — people without access never receive those messages. Like the rest of the server, they're end-to-end encrypted with the server's key, which every member holds, so private channels keep things away from other members by the server's choice rather than by separate encryption. "Speak" is enforced by the app (listen-only members join muted), and the server keeps them shown as muted. Permission changes apply mid-call: losing Speak mutes you at once, and losing Connect or View (role edits, role removal, overrides, a membership ending, ownership transfer) takes you out of the call. @everyone and role mentions only notify people in the app when the sender is allowed to use them; that takes Mention @everyone as a server-wide (role) permission, because people's apps can't see channel overrides. Phone push notifications for @mentions go only to people who can see the channel, at most 50 per message, based on the sender's app's list.

## Docker

```bash
docker compose up -d          # https://<host>:3000 with a self-signed certificate
docker compose logs -f        # see the startup addresses and any errors
docker compose up -d --build   # rebuild after updating the files
```

Everything is stored in `./data`. Requires Docker Compose 2.24 or newer.

**Hardened by default.**

- **Runs unprivileged**: Hearth's container runs as an unprivileged user (uid 1000) on a read-only filesystem, with no Linux capabilities and no way to gain any. Only `./data` and a small `/tmp` are writable, and logs are rotated.
- **Fixes old file ownership**: on start, a tiny one-shot helper (`hearth-perms`) hands `./data` to uid 1000, because older versions wrote it as root.
- **No direct internet exposure with a domain**: set `HEARTH_BIND=127.0.0.1` in `.env`; Caddy reaches Hearth over an internal network.

**Upgrading an existing Docker install:** the update tool never replaces your `docker-compose.yml`.

- Updates keep working with the old file: the new image fixes `./data` and drops root by itself.
- Hearth now believes the visitor address Caddy passes on only from a trusted proxy. For an older file, the updater adds `TRUST_PROXY=<your "proxy" network's subnet>` to `.env` by itself and says so (a rollback puts the old `.env` back). If your proxy is something else (nginx on the host, Traefik, a tunnel), add `TRUST_PROXY=<its address or subnet>` to `.env` and run `docker compose up -d`; otherwise every visitor shares the proxy's address and one set of sign-in limits.
- To get all the protections, first save your file: `cp docker-compose.yml docker-compose.yml.old`.
- Copy in the new `docker-compose.yml` and re-add your own changes.
- Then run `docker compose up -d --build` (with a domain: `docker compose --profile domain up -d --build`).

---

## Admin dashboard, reports and safety

The owner (normally the first account created on the server), the admins and moderators they appoint, and anyone listed in `ADMIN_USERS` see a shield button in the left bar: the **admin dashboard**.

- **Overview:** accounts, who's online, activity, message counts (never content), storage, open reports, 14-day charts.
- **Online:** everyone connected right now, with their IP addresses, devices and voice channel.
- **Reports:** what was reported, the messages the reporter shared, the reported account's IP addresses, and buttons to suspend the account, delete the message, resolve or dismiss. You get a live notification when a report comes in.
- **Users:** search by name or IP; see IP history, signed-in devices and reports; suspend (signs them out everywhere at once, and they see your reason when they try to log in) or sign them out everywhere.
- **Registration & Terms:** switch sign-ups between open, invite-code only and closed in one click (handy during a spam wave), and edit your Terms of Service (everyone is asked to accept changes).
- **Audit log:** every staff action and account security event (password changes and resets, two-factor on/off, sessions signed out, deleted accounts, backups, and changes to payments, memberships, GIF, music and relay settings and regions), who did it and from which IP. It's append-only: nobody can edit or delete entries. Each entry is signed with a key derived from `data/secret.key`, and the newest one is also recorded in `data/audit-anchor.json`, so the page shows if someone edited, deleted or cut off entries in the database file without that key. Someone with root on the server (the database and the key) could still rewrite it.
- **Storage & limits:** set the largest file, picture and profile song, a storage limit per person and a daily upload limit (all optional). See total use, today's uploads, free disk space and who uses the most; give one person a bigger (or smaller) limit, turn off someone's uploads, lock someone's profile, delete everything someone uploaded (their GIF-library uploads included) or all their profile comments. People see their own usage under Settings → Security & storage; GIF-library uploads count too. Limits hold even when someone uploads many files at once (at most 4 at a time per person). Admins and the owner aren't held to quotas.
- **Word filter:** words and phrases that can't be used in names, bios, profile pages and profile comments (chats are end-to-end encrypted, so they can't be filtered).
- **Team & roles:** three staff levels. The **owner** is the only one who can make people **admins** or **moderators**, change or take away those roles, and hand ownership to someone else (you stay on as an admin). Each of those needs your password again (and a two-factor code if it's on), and the old owner is emailed when ownership moves. Who the owner is gets settled once, at the first sign-up (see `ADMIN_USERS` in the settings table), and never moves by itself after that. Lost the owner's account? `node server/cli.js set-owner <username>` names a new owner (see [Backups](#backups)). **Admins** get the whole dashboard and Settings → Instance. **Moderators** get reports, users, who's online and the audit log. Staff can only act on people ranked below them, so a moderator can't suspend an admin and nobody can touch the owner. That covers messages too: staff can't remove messages by staff at or above their rank, and can remove DMs and group-chat messages only when they were reported. Admins can't delete or take over servers the owner owns, delete group chats, or IP-ban the owner's or higher staff's networks. People see the dashboard appear or disappear the moment their role changes.
- **Moderation tools:** timed suspensions (1 hour, 1 day, 3 days, 1 week, 30 days or until lifted; they end by themselves), private staff notes on any account, "reset profile" for offensive names, pictures and bios, user filters (online, suspended, staff), handing a server to another member when its owner has left, and an emergency "sign everyone out" (staff stay signed in).

**About IP addresses:** the server records which IP addresses each account connects from, for security and abuse reports. The default Terms say so; keep that in your terms if you edit them, and check what your local privacy laws require.

### Security built in
- **Captcha on sign-up and login:** a private, self-hosted "I'm not a robot" check (proof of work, like ALTCHA). People's browsers solve a small puzzle — about a fifth of a second on a computer, usually finished before they've typed their password — which makes mass sign-ups and password guessing expensive for bots. Puzzles are signed, single-use and expire after 5 minutes. Networks (IPv6 per /64) that keep failing get harder puzzles. When sign-ups (more than 120 an hour) or sign-ins (more than 3,000 in 10 minutes) are unusually busy, the puzzle gets harder for everyone, up to a few seconds in a browser, instead of turning people away; the app solves the harder one by itself. With the robot check switched off, those limits refuse requests instead. "Forgot password" uses the login robot check. No Google/hCaptcha scripts and no tracking. Turn it on or off for login and sign-up in Admin → Registration & Terms. It's proof of work, so a determined attacker with fast hardware pays less than a browser does.
- Strict browser security policy (only this server's own scripts can run, and the app's own requests can only go back to this server), clickjacking protection, HSTS on HTTPS, locked-down browser permissions. Pictures and videos can still load from other sites, so the policy alone doesn't stop data leaving (see [SECURITY.md](SECURITY.md) row 25).
- Rate limits by network (IPv6 per /64), per account (from any number of IPs) and per session on sign-in, sign-up, password reset, two-factor codes, email codes, messages, uploads, joining servers and profile edits. Requests without a solved robot check don't count toward the per-account or instance-wide limits. The devices that have signed in to an account before (they keep a signed note) and the networks it has been used from (for IPv6, the whole /64) have their own limit, so a stranger can't lock someone out of their usual devices. Someone who keeps solving robot checks can still hold up a brand-new device on a new network for a while (10 tries per 15 minutes, 100 a day per account).
- **Sessions:** every device is listed in Settings → Security → Signed-in devices (device, IP, last active) and can be signed out on its own, or all at once with "Log out all other devices". Sessions also end after 60 days unused or 365 days in total. Signing out, changing the password, a reset and turning on two-factor all cut off the other devices immediately, including open app windows and their push notifications. (The device you make the change on keeps its own sign-in.)
- **Re-confirm before sensitive changes:** these need your password again, plus a two-factor code if it's on: changing your password, email, recovery key or username, turning off two-factor, deleting your account, and deleting or handing over a server you own. For admins also: team and ownership changes, deleting backups or keeping fewer of them, showing the backup key, changing where payments go, changing the call relay's secret or addresses, and creating or reinstalling a region. If you passed two-factor in the last 10 minutes (say, you just signed in with a code), the password alone is enough; turning two-factor off always needs a fresh code. 10 wrong passwords per 10 minutes.
- **Blocked IP addresses** (Admin → Security) also cut off people already signed in from that address, and its "forgot password" and reset links. Staff are exempt, and logging out always works.
- **Automated attacker:** the test suite (`npm test`, run by GitHub Actions on every push) tries every API route without signing in, with other people's ids, and with hostile input, and checks the rules in [SECURITY.md](SECURITY.md).
- Live connections are rate-limited per window and per account (at most 30 open windows per account). Refused events get "Slow down.", and only a flood that keeps going is disconnected. The app then reconnects by itself; it signs out only when the session really was revoked.
- Visitors' addresses are taken from `X-Forwarded-For` only when it comes from a trusted proxy: by default this machine (Caddy/nginx on the same host), and in `docker-compose.yml` its own Caddy. For a proxy elsewhere, for example nginx in another container, set `TRUST_PROXY` in `.env` to its address or subnet. Someone who reaches Hearth directly can't fake their address, so IP bans and per-network limits hold. Plain-HTTP requests that bypass your proxy from the internet are refused (`ALLOW_DIRECT_HTTP=true` turns that off).
- Suspended accounts are cut off instantly, including open connections.

## Calls not connecting for some people? Set up the relay (5 minutes, once)

Calls go directly between people. Some networks (mobile data, many home routers, school/office Wi-Fi) block that, so those people need a **relay** (TURN server). On your VPS run:

```bash
cd "/opt/hearth (1)/hearth"     # your Hearth folder
bash scripts/setup-turn.sh
```

It installs coturn, locks it down (relay passwords per person that run out within 12–18 hours, no relaying into private networks, each relayed connection capped at 6 Mbit/s each way — `TURN_MAX_MBIT` — with an optional total cap `TURN_CAPACITY_MBIT`, and a limit on how many relayed connections one person can hold), opens the firewall ports, and connects it to Hearth — no restart needed. The app fetches new relay passwords before the old ones run out, so an app left open for days keeps working calls. Check it with **Settings → Instance → Calls → Test relay**. If your VPS provider has its own firewall in their control panel, open UDP+TCP 3478 and UDP 49160–49400 there.

Already set up? Run `scripts/setup-turn.sh` again (and **Reinstall** each region) to get the bandwidth caps. Anyone who can sign up to your Hearth can use the relay; relay passwords can't be taken back early.

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
- **Privacy proxy (on by default):** GIFs are fetched by your server and passed on, so GIPHY sees your server, not your members. Only GIPHY's and KLIPY's media hosts are allowed (the server rebuilds every address it fetches from that list), and links carry a token tied to the viewer's sign-in, so it can't be used as a general proxy. It uses some bandwidth; turn it off in Settings → Instance if you'd rather not.
- GIF searches go from your server to GIPHY, which sees the search words (not who searched). Sent GIFs are links inside your encrypted messages, but **your server learns which GIFs people pick and load**: the app reports each pick (that's how the server's own GIF library learns), and proxied GIFs are fetched with the viewer's token.
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

**Push notifications** reach people when Hearth is closed. Each person turns them on per device in *Settings → Apps & devices*. Because messages are end-to-end encrypted, a notification only says who and where (e.g. "Alex mentioned you · #general"), never the message. To work out who was @mentioned, the sender's app tells the server which member IDs it mentions — that's the only extra thing the server learns. Each account can have up to 10 devices with notifications on (turning it on somewhere new drops the oldest). Signing a device out, from that device or from Settings → Sessions, or changing your password, stops its notifications. Logging out turns notifications off in that browser. A device whose push service keeps failing is paused and, after a while, dropped; the app turns notifications back on the next time it starts. Push services must be public `https` addresses (`PUSH_ALLOW_PRIVATE=1` allows one on your own network). The server creates its push keys in `data/vapid.json` on first start; set `VAPID_SUBJECT=mailto:you@yourdomain` in `.env` (Apple's push service rejects placeholder addresses).

### Desktop app (Windows, macOS, Linux)

The `desktop/` folder is an Electron app for Windows (and Mac/Linux). It loads the interface from your server, so most updates reach people without reinstalling, and adds what a browser can't:

- **Push to talk, mute and deafen keys that work while a game is focused** (Settings → Keybinds; keyboard keys, combos or mouse side buttons). The key still reaches the game.
- **Updates itself** from your server (Windows and Linux): downloads in the background, then asks before installing ("Restart to update" shows a confirmation; nothing installs on quit). Apps built with the `UPDATE_SIGNING_KEY` secret only install updates signed with your key; others say the update can't be verified (Settings → Apps & devices shows which). See [Signing desktop updates](docs/SIGNING.md#signing-desktop-updates).
- **Asks before using your mic, camera or clipboard** on each server (Help → Reset permissions undoes it), and screen sharing always goes through the app's own picker window.
- **Taskbar:** unread count on the icon, the button flashes when someone @mentions you, and Mute/Deafen buttons in the taskbar preview while you're in a call.
- **Invite links open in the app** (`hearth://invite/…`; the browser's join window offers "Open this invite in the app").
- **Detects the game you're playing and your music** (Settings → Games & music).
- Tray icon, start with Windows (minimized or not), remembers its size and position, reconnects right after your PC wakes up, screen sharing with sound, and a "What's new" note after updates.

**Make updates automatic (once):** in your GitHub repository → Settings → Secrets and variables → Actions, add the secrets:

- `VPS_HOST` (your server's IP);
- `VPS_USER`: a user made just for this, with no sudo, that can only write `data/downloads` (not `root`);
- `VPS_SSH_KEY` (a private key made just for this; its public half goes in that user's `~/.ssh/authorized_keys`);
- `VPS_HOST_FINGERPRINT` (**required** with `VPS_HOST`): your server's SSH host key fingerprint, the `SHA256:…` value from `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server. Without it the copy step fails and copies nothing; with it, the copy refuses any other machine;
- `VPS_DOWNLOADS_DIR` (the full path of Hearth's `data/downloads` folder; `hearth-update --status` shows where Hearth is);
- `UPDATE_SIGNING_KEY` (recommended): the private key that signs desktop updates, made with `node hearth/desktop/build/sign-update.js keygen`. See [docs/SIGNING.md](docs/SIGNING.md#signing-desktop-updates).

Release builds (`app-v*` tags and the default branch) then copy the installers and update files there, keep the two newest, and every desktop app offers the update within a few hours. Builds of other branches and manual runs from them never reach people's apps. Without these, download the installer from the Actions run and put it (with `latest*.yml`, `latest*.yml.sig` and the `.blockmap`) in `data/downloads` yourself.

**Point it at your server:** edit `desktop/hearth.config.json`:

| Key | What it does |
|---|---|
| `defaultServer` | Your address, e.g. `https://chat.example.com` (set to `https://kappachat.duckdns.org`). Empty = ask on first launch. The repository variable `HEARTH_SERVER` overrides it at build time. |
| `lockServer` | `true` to hide "Change server" (a branded app for your community). |
| `appName`, `appId` | Window title, and the ID Windows/macOS use for notifications. Also change `productName`/`appId` in `desktop/package.json` if you rebrand. |
| `closeToTray` | Keep running in the tray when the window is closed (Windows/Linux). |
| `trustedSelfSignedHosts` | Hosts for which **any** certificate is accepted without asking, so a man-in-the-middle would go unnoticed. Leave it empty: the app then asks once and remembers that exact certificate. |
| `updatePublicKey` | Filled in at build time from the `UPDATE_SIGNING_KEY` secret. When set, the app only installs updates signed with the matching private key. |

**Build installers automatically (recommended):** GitHub builds them whenever the apps change, on a tag (`git tag app-v1.17.0 && git push --tags`, attached to a release), or when you run the *Hearth apps* workflow from the Actions tab (you can type your server address there, or set the repository variable `HEARTH_SERVER`). The workflow is `.github/workflows/hearth-apps.yml` at the top of the repository; if Hearth lives in a repository of its own, `.github/workflows/desktop.yml` inside this folder does the desktop part. GitHub builds `.exe` (Windows), `.dmg` (macOS) and `.AppImage`/`.deb` (Linux) and attaches them to a release. To also copy them to your server automatically, add the repository secrets above (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_HOST_FINGERPRINT`, `VPS_DOWNLOADS_DIR`).

**Build on your own computer:** `cd desktop && npm install && npm run dist` (builds for the system you're on).

**Publish them:** put the installer files in `data/downloads/` on the server (or set `DESKTOP_DOWNLOAD_URL` to your GitHub releases page). They appear on `/download` automatically.

**Code signing:** unsigned builds work, but Windows shows a SmartScreen warning ("More info → Run anyway") and macOS needs right-click → Open the first time. Removing those warnings needs a code-signing certificate (Windows) and an Apple Developer account ($99/year, macOS notarization); electron-builder picks them up from environment variables when you have them. Auto-update works on Windows and Linux and comes from your server's `/updates` (its `data/downloads` folder), not from GitHub, so whoever controls that folder decides what's offered: sign your updates with `UPDATE_SIGNING_KEY` so the apps refuse anything else. macOS builds don't update themselves.

### Android app

The `mobile/` folder is an Android app (Capacitor) that opens your server, like the desktop app: chats, calls, video, voice messages, watch together, notifications while it's open or in the background, and saving files to *Downloads/Hearth*. It works with a self-signed certificate (an IP address like `https://1.2.3.4:3000`): it shows the fingerprint and asks once. It updates whenever you update the server.

**Get the APK:** GitHub builds it with the desktop installers — repository **Actions** tab → *Hearth apps* → latest run → *Artifacts* → `hearth-android` (or push a tag `app-v1.17.0` to get a release). Put the `.apk` in `data/downloads/` and the `/download` page offers it to Android visitors. Details, signing and limits: [mobile/README.md](mobile/README.md).

**iPhone / iPad:** use the installable web app (Safari → Share → Add to Home Screen). A native iPhone app needs an Apple Developer account ($99/year) and App Store review.

---

## Video calls and screen sharing — good to know

- Calls are peer-to-peer (each person sends to each other person), which keeps them private and costs your server nothing unless they need the relay. It works best with **up to about 4–6 people on camera** at once; voice-only handles more.
- **Screen audio:** in Chrome/Edge, tick "Share audio" in the picker (tab audio everywhere; whole-system audio on Windows). Firefox and Safari share the picture only. In the desktop app, Windows shares system audio automatically.
- **Desktop app:** screen sharing needs the new desktop build (it adds a "Choose what to share" picker, its own window on every system). Rebuild with the GitHub workflow (push a new `app-v…` tag; `desktop-v…` only applies to `.github/workflows/desktop.yml` when Hearth has a repository of its own) — everything else in the app updates on its own.
- **Calls go through a relay when they can't connect directly** (this server's, if you ran `setup-turn.sh`, or a region's). The relay only forwards encrypted packets.
- Behind strict networks (some offices, mobile carriers), add a TURN server (see below) so video can always connect.

### Calls that survive hiccups

If your connection to the server drops mid-call, the call keeps going (audio usually flows straight between
participants) and Hearth rejoins by itself. Others see you as "reconnecting" for up to 18 seconds (`VOICE_GRACE_MS`).
After a server restart, everyone rejoins automatically. The call bar always shows the real state, and **Call
diagnostics** (the ⓘ button in a call) shows round trip, loss, jitter, path type and relay for your own connections.
Developers: `npm run test:voice` runs a two-browser call test. See `docs/VOICE.md`.

## Voice not working?

Voice goes directly between people's browsers (peer to peer). Most home connections work with the default STUN servers. If someone can join a channel but nobody can hear them (or the panel stays on "Connecting…"), their network is blocking direct connections and you need a **TURN relay**:

1. On the VPS, run `sudo bash scripts/setup-turn.sh` (see [above](#calls-not-connecting-for-some-people-set-up-the-relay-5-minutes-once)). By hand instead: install coturn and use `deploy/turnserver.conf`. It uses shared-secret logins and blocks private networks. Its `static-auth-secret` line ships commented out: remove the `#` and set a long random secret (`openssl rand -hex 32`); left as it is, the relay accepts no one. That sample has no bandwidth cap; add coturn's `max-bps` if you want one (`setup-turn.sh` does).
2. Add to Hearth's `.env` (if you didn't use `setup-turn.sh`):
   ```
   TURN_URL=turn:your.vps.ip:3478
   TURN_SECRET=<the static-auth-secret>
   ```
   Everyone then gets their own relay password that runs out within 12–18 hours. (`TURN_USERNAME` / `TURN_CREDENTIAL` still work but give everyone, including people you remove, one password that never expires; the server logs a warning.)

Other things to check: the browser has microphone permission for the site, the page is on `https://`, and the right mic is picked in **Settings → Voice & audio** (use **Test microphone**).

Each person sends audio to everyone else, so a voice channel works best with up to about 8–10 people.

---

## Security and privacy — what's protected

All chats are end-to-end encrypted: your browser encrypts each message and file before it leaves your device, and only the people in the conversation can decrypt it. Whoever runs the server — including you — stores only ciphertext. That holds as long as the app code the server sends is honest: the web, desktop and Android apps all load their code from the server, so someone who controls the server could change it to leak keys at the next sign-in (see [SECURITY.md](SECURITY.md) §4).

| | Can the server read it? |
|---|---|
| Server channel messages and files | **No** — end-to-end encrypted, signed by the sender |
| Direct messages and files | **No** — end-to-end encrypted |
| Voice | **No** — encrypted between browsers (DTLS-SRTP), handshakes signed; a relay, when one is needed, only forwards encrypted packets |
| Who's in which server, who messages whom and when, emoji reactions, server/channel names, avatars and profiles, file sizes, which GIFs people pick and load, and when and where (not what) you search | Yes |
| Messages sent before the encryption upgrade | Yes, with `data/secret.key` (shown in the app as "Older message — not end-to-end encrypted, sender not verified"; plaintext messages dated after encryption was switched on are hidden) |

### How it works

| Part | What's used |
|---|---|
| Your password | Never sent anywhere. Hardened in the browser with **Argon2id** (64 MiB memory, 3 passes, random salt). One half logs you in; the other unlocks your private keys. Older accounts are upgraded from PBKDF2 automatically at their next login. |
| Your identity key | **ECDH P-256** key pair. The private half is stored on the server only after being locked (AES-256-GCM) with your password-derived key. |
| Your signing key | **ECDSA P-256**. Signs channel messages, key handoffs and voice handshakes so nobody can impersonate you. |
| Each message | **AES-256-GCM** with its own key, derived by **HKDF-SHA256** from the conversation key and a random 256-bit salt. The channel or DM, the author and the key version are bound in, so the server can't change a message's content, move it to another conversation or change who sent it. It can still replay a message, change what it replies to or which thread it's in, change its time, or serve a version from before an edit. |
| Each attachment | Its own random AES-256-GCM key, carried inside the encrypted message. The app only accepts attachments stored on this server. |
| Message length | Padded before encrypting (to 256-byte steps, 1 KiB steps above 4 KiB), so the server can't tell "ok" from a sentence. File sizes are not padded: the server sees how big each file is. |
| Sign-in sessions | The database stores only a SHA-256 hash of each session token, so a copy of the database can't be used to sign in as anyone. |
| Recovery key | 160 random bits, shown once. Locks a second copy of your private key (HKDF-SHA256 + AES-256-GCM, its own salt). The server never sees it. |
| Two-factor | Standard authenticator codes (RFC 6238). A code can't be used twice, guesses are rate-limited, backup codes are stored hashed. |
| DMs | Conversation key from ECDH between the two of you. DMs aren't signed, so they stay deniable (like Signal). |
| Server channels | A random 256-bit **group key** per server, sent to each member encrypted to their identity key (ECIES) and signed by whoever shared it. Each app keeps its own copy of every key it receives, so history doesn't depend on whoever shared it. When anyone leaves or is removed, a new key is created automatically and given only to the remaining members, so former members can't read anything new. New members can read from the key that was current when they joined; older messages stay locked to the people who were there. Someone who was a member before with the same account (left, kicked, banned) and comes back gets a new key, even after resetting their password, so they can't read what was said while they were away. A different account using an invite someone kept still gets the current key like any new member, so revoke invites after removing someone. **Replace key now** works for members once the key is 10 minutes old (at most 12 new keys an hour per server); members with Manage Server can use it any time (30 an hour). A new key the others can't open is replaced once two members (or one with Manage Server) report it, which their apps do by themselves. The encryption dialog shows who made the current key. |

### Verifying people

Your browser remembers everyone's keys the first time it sees them. If the server ever hands out different keys for someone (the classic way to secretly listen in), you'll see **Security key changed**, sending to them pauses, and key sharing with them stops until you check. To verify someone, open a DM, click **End-to-end encrypted**, and compare the 60-digit safety number with them in person or on a call. Safety numbers cover people's current keys. Messages written with an older key are labelled: **"Written with an older key"** (a key this device trusted back then), or **"⚠ Older key — not verified"** (a key the server says they had before a password reset, which this device never confirmed, so the server could have written it). Server encryption details (key version, who made it, who holds it, "Replace key now") are under the **End-to-end encrypted** badge in any channel.

### Things to know

- **Saved messages, the notification center and per-device preferences** (layout, favorites, collapsed categories, notification levels) live in your browser, not on the server.
- **Forgot your password?** Add an email (Settings → My Account → Email) and the sign-in screen's **Forgot your password?** link emails you a reset link (good for 30 minutes, one use; it stops working if the password or the email address changes first). Your password is what unlocks your keys, so what you keep depends on the **recovery key**:
  - **With your recovery key** (Settings → My Account → Recovery key, shown once — write it down): you keep everything, including all old messages.
  - **Without it:** you get your account, name, friends and servers back, but with new keys. You can't read your old encrypted messages any more (the people you talked to still can), and friends see "Security key changed" on you. Devices that knew your old key share server keys with you again once their owner verifies you (click the shield next to your name). A device that never saw your old key (someone's new phone, a new member) shares the current server key without asking, so you can read what's said from that key on.
  - That's also what someone who gets into your email can do if two-factor is off: they get the account with new keys, and from any member's device that never saw your old key, each server's current key, which opens what was said since that key was made. Turn on two-factor sign-in.
- **Two-factor sign-in** (Settings → My Account → Two-factor sign-in): after your password, sign-in asks for a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator…). You get 10 one-time backup codes. Password resets also need the code. If someone loses their phone and their backup codes, an admin can turn it off for them in Admin → Users.
- **Deleting your account** (Settings → Security & storage → Delete account, password and two-factor code needed):
  - erases your private keys, email, two-factor, profile, pictures and friends. Your public keys stay, so the people you talked to can still read your old DMs, check your old posts and unlock server keys you handed out;
  - takes you out of every server and signs out every device; the username becomes free again;
  - leaves the messages you sent in place, still encrypted and readable by the people they were sent to, under "Deleted user". Nobody can send new DMs to a deleted account.

  Owners hand over or delete their servers first.
- **Check my encryption** (Settings → My Account) runs every lock on your device — including that tampered, misaddressed and outsider messages are refused — and checks your own keys and every server key, without sending anything.
- **Logging out removes your keys from that browser.** Log back in to read everything again — your history works on every device you log in from.
- **New members need someone online.** A member who already has the server's key must be online (any open tab, even in the background) to hand it to a new member. Until then they see "Waiting for the encryption key".
- **Trust on first use.** The key-change warning protects you from the moment your browser first sees someone. On a brand-new device you're trusting the server's first answer — that's what safety numbers are for.
- **Membership is controlled by the server.** A malicious host could add a hidden member to a server, who would then be given the key, or hold back a key change, or roll a key back across a page reload. Apps refuse a current key handed out by someone who isn't a member, won't go back to an older key during a session, and refuse to start if the server lists keys for your own account that your password doesn't unlock. For strong guarantees, compare safety numbers. The same goes for calls: a malicious host could add a hidden listener, since apps trust the server's list of who is in a call.
- **No forward secrecy for history.** To let your full history follow you to every device, your long-term key can decrypt your past messages. If someone gets both your password and the server's data, they can read your history. Changing your password locks the same key with the new password; it doesn't replace the key. (Signal makes the opposite trade-off.)
- **Metadata isn't hidden** — see the table above. Run the server on hardware you control and use HTTPS.
- **Other sites can see your IP address** when the app loads its fonts (Google Fonts), picture links in messages (turn off Settings → Chat → "Show image links as previews"), direct video files in watch together, and the YouTube, Vimeo and Twitch players. GIFs, news pictures and game and music art go through the server instead.
- Treat a self-hosted server like any small website: keep the machine updated and use `REGISTRATION_CODE` or `REGISTRATION_OPEN=false` if you don't want strangers signing up.

---

## Backups

Hearth makes two kinds of backup by itself every day (Admin → Owner → Backups).

**Encrypted full backups** (`data/backups/encrypted/*.hbk`)
- **Contents**: the database, `secret.key`, `vapid.json` and every uploaded file, in one file.
- **Encrypted** with the backup key, so the file is safe to keep on another provider.
- **Restore-tested** right after it's made: the backup is decrypted into a scratch folder and the database is checked. "Test restore" repeats this.
- **Copies on your regions**: every linked region (Admin → Regions, installed or reinstalled with 1.25+) keeps the newest 14 encrypted backups, so losing your main VPS doesn't lose everything. The main server uploads each one over SFTP to an account on the region that can only write into one folder (no shell, locked in that folder), and only to the region's own SSH host key, which it reports when it checks in. The region can't read them without the backup key. If your main VPS is gone, on the region: `sudo ls -t /var/lib/hearth-backup/backups/` to find the newest, copy it to the new machine and restore it as below. `REGION_BACKUP_KEEP` changes how many are kept; `REGION_BACKUPS=off` turns this off.
- **Off-site copies**: set `BACKUP_RCLONE_REMOTE` (for example `b2:my-bucket/hearth`; any [rclone](https://rclone.org) remote works) and each backup is copied there. With Docker, run rclone from the host on `data/backups/encrypted/` instead, for example `rclone copy data/backups/encrypted remote:hearth --include '*.hbk'`. That folder only ever holds encrypted `.hbk` files (and `.hbk.part` while one is being written): the plain database snapshot a backup is made from lives in `data/backups/.tmp`, readable by Hearth alone, and is deleted afterwards, at shutdown, and at start-up if a crash left one behind (anything untouched for 10 minutes, so a backup still running from the command line is left alone).
- **How many are kept**: Admin → Owner → Backups. Keeping fewer, or turning automatic backups off, needs your password again; the newest backup of each of the last days is kept too, so backups made by hand can't push out older days. Every backup removed this way is logged.
- **Keep the backup key somewhere safe and separate**, such as a password manager: Admin → Owner → **Show backup key** (it asks for your password again). Without the key, no backup can be restored.
- **Restore on a new machine**:
  ```bash
  node server/cli.js restore hearth-2026-….hbk /opt/hearth/data <backup key>
  ```
  Then start Hearth (for a different folder, set `DATA_DIR`). `node server/cli.js verify-backup <file> <key>` checks a backup without restoring it, and `node server/cli.js backup` makes one from the command line. `verify-backup` warns when a backup comes from a newer Hearth; `restore` refuses it (exit code 2) and restores nothing: install that newer version first.
- **Restore safely**: `restore` only writes into an empty folder. While it runs, the folder holds `RESTORE-INCOMPLETE`, and Hearth won't start on a folder that has it, so an interrupted restore can't pass for a complete one. Exit code 3 means some files the database refers to aren't in the backup (they're listed); `node server/cli.js check-files` gives the same report for any data folder.
- **After a break-in**, add `--sign-out-everyone` to `restore`: sessions signed out after the backup was made would otherwise work again.
- **Full guide**, including what each kind of account recovery can and can't bring back: [docs/RECOVERY.md](docs/RECOVERY.md). `node scripts/recovery-drill.js` and `bash scripts/upgrade-drill.sh` prove it end to end.
- **Lost the owner's account?** `node server/cli.js set-owner <username>` makes another account the owner. It works while Hearth is running, refuses deleted, bot and suspended accounts, drops the new owner's other staff role, and is written to the audit log (`ownership_set_cli`).

**Database copies** (`data/backups/*.db`) are for undoing an update on this machine. They're as sensitive as the database itself, so they never leave the server and can't be downloaded. Copies made before upgrades (`hearth-before-v*.db`) are never deleted automatically; remove old ones by hand once you're happy with an upgrade.

Also back up `.env`. `cert.pem` and `key.pem` (the self-signed certificate) are regenerated if missing.

---

## Settings reference (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `INSTANCE_NAME` | `Hearth` | Name in the tab and login screen |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where to listen |
| `HTTPS` | `true` | Self-signed HTTPS. Set `false` behind a reverse proxy |
| `SSL_CERT` / `SSL_KEY` | — | Use your own certificate files |
| `PUBLIC_HOSTS` | — | Extra IPs/hostnames for the self-signed certificate |
| `TRUST_PROXY` | `loopback` (this machine; with `docker-compose.yml`, its Caddy network) | Proxies allowed to set the visitor's address (`X-Forwarded-For`): their IPs or subnets (comma-separated), a number of proxies in front (e.g. `1`; only safe if Hearth's port is reachable only through them), or `false`. In Docker a value in `.env` replaces the compose default. Never name a number or Docker's gateway (`x.x.x.1`) unless `HEARTH_BIND=127.0.0.1` |
| `REGISTRATION_OPEN` | `true` | Allow new sign-ups |
| `REGISTRATION_CODE` | — | Require this code to sign up |
| `MAX_UPLOAD_MB` | `25` | Starting max size per file (change it any time in Admin → Storage & limits) |
| `GIPHY_API_KEY` | — | Turns on GIF search (or set it in Settings → Instance) |
| `ADMIN_USERS` | — (the first account is the owner) | Usernames that are always admins. Each listed name belongs to the first account that takes it, for good: renaming or deleting that account doesn't free the name for anyone else. Set before anyone signs up, the first account owns the server if it took one of these names; if not, the first name here owns it as soon as it's registered (until then the first account runs it). Names added later are admins, never the owner. Removing a name and restarting takes its powers away. The start-up log says so when the first name isn't (or isn't yet) the owner, and lists names held back by an upgrade. Hand ownership over in Admin → Team & roles, or run `node server/cli.js set-owner <username>`. More admins and moderators can be added in Admin → Team & roles |
| `ALLOW_DIRECT_HTTP` | `false` | Allow plain-HTTP access from the internet when `HTTPS=false` (not recommended) |
| `GIF_PROXY` | `true` | Load GIPHY media through this server (also switchable in the app) |
| `STUN_URLS` | Google STUN | Comma-separated STUN servers |
| `TURN_URL` / `TURN_SECRET` | — | TURN relay for calls and its shared secret (coturn's `static-auth-secret`); `scripts/setup-turn.sh` sets these up in the app instead |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | Legacy: one relay password for everyone that never expires (the server warns). Use `TURN_SECRET` |
| `PUSH_ALLOW_PRIVATE` | off | `1` allows push endpoints on private/LAN addresses (tests, or a push service on your own network) |
| `OUTBOUND_BLOCK` | — | Comma-separated addresses or ranges (CIDR) that feeds, pictures and push may never reach, on any port. For example this server's public IP when it's behind NAT, or your router's |
| `DATA_DIR` | `./data` | Where data lives |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact address for push services — set your real email |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto | Push keys (default: generated into `data/vapid.json`) |
| `DOWNLOADS_DIR` | `data/downloads` | Installers offered on `/download` |
| `DESKTOP_DOWNLOAD_URL` | — | Link `/download` to your GitHub releases page instead |
| `AT_REST_KEY` | — | 64-hex-char key instead of `data/secret.key` (for pre-upgrade messages) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | — | Email for password resets (or set it in Admin → Owner → Email) |
| `PUBLIC_URL` | — | This server's public address, used in reset links |
| `SESSION_IDLE_DAYS` / `SESSION_MAX_DAYS` | `60` / `365` | A device is signed out after this many days unused / after this many days in total |
| `API_RATE_LIMIT` | `1200` | Requests a minute one signed-in account can make in all (the sensitive routes have tighter limits of their own); `0` turns it off |
| `BACKUP_KEY` | `data/backup.key` | 64 hex characters: the key encrypted backups use (made automatically if not set) |
| `BACKUP_RCLONE_REMOTE` | — | Copy every encrypted backup off-site with rclone, e.g. `b2:my-bucket/hearth` |
| `HEARTH_BIND` | all interfaces | Docker only: the address port 3000 listens on. Set `127.0.0.1` behind Caddy |

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

App Store / Play Store listings, screen sharing in the Android app, push notifications for the Android app while it's swiped away, separate encryption keys per private channel, drag-and-drop reordering of channels (use the Move up/down menu items), and encrypted reactions.

## Email (password resets)

Password resets need the server to send email. In **Admin → Owner → Email**, fill in an SMTP server and press **Send a test email**. Free options:

- **Brevo** (300 emails/day free): SMTP host `smtp-relay.brevo.com`, port `587`, your Brevo login and SMTP key.
- **Resend** (3,000/month free): host `smtp.resend.com`, port `465`, user `resend`, password = your API key. Needs your own domain.
- **Gmail**: host `smtp.gmail.com`, port `465`, your address and an *app password* (Google Account → Security → 2-Step Verification → App passwords).

Set **Your server’s address** to the public URL people use (for example `https://kappachat.duckdns.org`) — reset links point there. Or use `.env`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `PUBLIC_URL`. The SMTP password is stored encrypted.

## Usernames

People change their username in **Settings → Security** (with their password, and a two-factor code if that's
on). Any free name works; the old one is free for others right away, and their password, friends and messages
stay the same. Admins (and the owner) can rename someone below them from **Admin → Users** (logged in the audit
log). Names listed in `ADMIN_USERS` are reserved, and staff roles stay with the account, never with a name. An
`ADMIN_USERS` admin who renames can take their old name back; nobody else can.

## Creator memberships

Server owners can sell monthly memberships to their community, like Patreon inside the server. Each membership
gives a role, and roles can open private channels, so "supporters get #behind-the-scenes" works with the
permissions you already have. Members join from the server's **Memberships** row (or its menu), pay on
Stripe's page, and get the role within seconds; they can cancel any time and keep it until the end of the month
they paid for.

- **Hearth's owner** turns it on once in **Admin → Money → Creator memberships**: Stripe Connect (Express
  accounts), a secret key (stored encrypted), a webhook to `/api/pay/memberships`, and the fee this Hearth keeps
  (default 5%).
- **Server owners** set it up in **Server settings → Memberships**: connect Stripe (Stripe checks who they are and
  pays them out), then make up to 5 memberships with a name, a monthly price, what members get and the role.
- Money goes to the creator's own Stripe account; Hearth only stores Stripe ids and statuses, never card details.
  Roles with moderator powers can't be sold, and a sold role can't gain them later; a role a membership uses
  can't be deleted while the membership is on sale or held. Nothing that's free changes: memberships only add what
  a creator chooses to offer.

## News bot

In a server's **Server Settings → News bot** (needs Manage Server), follow a topic (Google News), a YouTube channel, a subreddit, a Steam game's news, a GitHub project's releases, or any RSS/Atom feed, and pick the channel to post in. Press **Preview** to see what it would find. When you follow something, the bot posts the newest item right away so you can see it working; after that it posts only new things — never a backlog of old news — at most 3 at a time, checking every 10 minutes. The bot shows as online in the member list of servers it posts in. Add keywords to post only matching items (for example `patch, update`). Bot posts show a **BOT** tag and a card with the picture, which loads through your server so readers' IPs aren't shared.

Bot posts come from public feeds, so they aren't end-to-end encrypted (the server writes them). The bot can't sign in and can't read your encrypted messages. The server needs outgoing internet access to the sites you follow.

## Search (Ctrl+K)

**Search (Ctrl+K).** Messages are end-to-end encrypted, so search runs on your device: the app fetches messages page by page, decrypts them, and matches your words there. Each click checks up to 1,000 messages, newest first; **Search further back** continues. Filters: `from:@username`, `from:me`, `in:#channel`, `in:@username`, `before:` / `after:` / `during:` a date (`2025-05-31`), month or year, `has:file` / `has:image` / `has:link`, `is:edited` / `is:pinned`, `"exact phrase"`; several words must all appear. Recent searches stay in this browser and can be turned off.

The server never receives the words, phrases or `has:`/`is:` filters. It sees that you searched, when, where (a channel, DM, server or everything), whose messages and which dates, and how far back you went. Details: [SECURITY.md](SECURITY.md) row 69.

## Never lose your place

- **Unread badges and a "New messages" line** that follow you across devices, **Jump to first unread**, Mark as
  read/unread, and **drafts** that survive reloads (kept only on your device).
- **Saved messages** synced to all your devices, with private notes only you can read.
- **Notifications your way:** all, mentions only or nothing per server, channel and DM; mute for a while; ignore
  @everyone; quiet hours on a schedule. Push follows these too, and lock screens just say "New message" unless you
  choose otherwise.
- **Export my data** (Settings → Privacy & safety, needs your password): a zip of your account and every message you
  can read, decrypted on your device.
- **Moderation:** slow mode, timeouts (members can read but not post or talk), pin history. Pinning in a server
  channel needs Manage Messages. See `docs/FEATURES.md`.

## Big files and storage

Files over 8 MB upload in resumable pieces: you see real progress, can cancel, and a dropped connection carries on
where it stopped. Videos and songs can seek, pictures open in a gallery, and files that were deleted say so plainly.
*Settings → Storage* shows what you use and your biggest files (names come from your own encrypted messages, not the
server). Admins get *Admin → Security → Storage & limits*: space per person and per server, uploads in progress, free
disk, and "Clean up orphans now" (password required, logged). See `docs/STORAGE.md`.

## Bots

Servers can add bots: programs that post messages, offer slash commands and hear about events through signed
webhooks, with only the access the server approves. Bots can't read people's messages (those stay end-to-end
encrypted); they only see text someone sends them with a slash command, after a warning. Bot messages aren't
end-to-end encrypted and are marked that way. Make one in Server settings → Bots; admins choose who may (Admin →
Owner). Developer guide: `docs/BOTS.md`; example: `scripts/example-bot.js`. `BOT_WEBHOOK_ALLOW_PRIVATE=1` allows
webhooks to private addresses (for bots on your own network).

## Monitoring and troubleshooting

Hearth logs one JSON line per event (set `LOG_FORMAT=pretty` for readable lines). Secrets, tokens and message content
are never logged, and IP addresses are cut to their network (`LOG_FULL_IP=true` keeps them). Every response carries an
`X-Request-Id` to search the log by.

- `GET /api/health/live`: the process is up (use it for Docker/systemd health checks).
- `GET /api/health/ready`: ready for people (database, data folder, schema, maintenance, disk). `200` or `503`.
- Admin → **Health**: background jobs, the news bot, relays, backups and restore tests, disk, responsiveness, and
  alerts to the owner by email.
- `node server/cli.js doctor`: read-only checks of your install, exit 0/1/2. Add `--relays` to test relays, or
  `--fix-permissions` to tighten key file permissions.
- `node server/cli.js who <pseudonym>`: logs name people by a pseudonym, not their user id (the access log's `uid`, and
  the part after the colon in a relay login). This finds the account behind one.

See `docs/OPERATIONS.md`.

## Server folders

Organise the servers in your left bar into folders:

- **Right-click a server → Move to folder**, or open **Organize servers** (right-click the + at the bottom of the bar), a plain list with a folder picker and up/down buttons for each server. You can also drag servers in the bar: drop one onto another to make a folder, or between two to reorder.
- **Folders have a name, a colour and an emoji.** When closed they show a combined unread dot and @mention count.
- **Focus on a folder** (right-click it) to show only its servers, for example "School" during the week. Click the focus tile at the top of the bar to switch back.
- **Mute a folder or mark it all as read** in one click.
- **They follow you:** your folders are saved to your account, so every device shows the same arrangement.

## Group chats

**New group chat** is under the + next to Direct messages on Home, and on the Friends page. A friend's ⋯ menu can also start a group chat or add them to one.

- **Up to 25 people.** Everyone in the group can add friends or people they share a server with (unless that person only takes DMs from friends), talk, call, pin, rename it and change its picture.
- **The owner can remove people**, delete other people's messages, change the group's channels and hand the group to someone else (group menu → Members). In group calls, "Only I control" for watch together really limits playback to the host (and the owner).
- **End-to-end encrypted** like servers. When someone is removed or leaves, the group switches to a new key. Leaving always works.

## Updates (track anything)

Home → **Updates** → **Track something**: a topic in the news, a YouTube channel, a subreddit, a game's patch notes (Steam), a GitHub project's releases, or any RSS feed.

- **Only new posts:** you see posts published after you started tracking, never old news.
- **Checked about every 30 minutes,** with an optional notification (even when the app is closed, if push is on) and an optional keyword filter.
- **Not end-to-end encrypted:** your server fetches the feeds, so it knows what you track (it can't read your chats). Pictures load through the server, so the sites don't see your IP.

## Study tools (Recall)

Off until someone turns them on: **Settings → Study tools**. Then **More → Study** in the sidebar opens **Recall**:

- **Decks** of cards with pictures, formatting for science and maths (`H_2O`, `x^2`, `\alpha`), and fill-in-the-blank cards (`{{word}}`).
  - Paste a list, import CSV, text or a Recall file, or drag a file onto the page. Export to CSV (Anki, Quizlet) or a Recall file.
- **Study modes:** Flashcards, Learn, Smart Review (spaced repetition), Write, Match, Practice test, Blitz, Fill the gap, Explain it, Brain dump, Listen & spell and Quick Fire.
- **Courses and exam dates** with a countdown, a daily goal, a streak, and studying several decks together.
- **Focus timer** (Pomodoro). It keeps running while you chat elsewhere in Hearth.
- **Print** a study sheet or cut-out cards.

Your decks, pictures and progress are **end-to-end encrypted** with a key only your account can derive, and synced between your devices.

Recall runs in a **sandboxed frame** with its own origin. It can't read your Hearth sign-in or storage and can't connect anywhere, so even a booby-trapped deck file someone shares can't reach your account. Hearth hands Recall your decrypted decks and encrypts everything it sends back.

Decks made with the earlier Hearth study tools are moved into Recall the first time you open it.

## Desktop app: signing (no more "Windows protected your PC")

See [docs/SIGNING.md](docs/SIGNING.md):

- **Windows:** sign the app and installer for free through the SignPath Foundation (Hearth is open source; you approve each release on signpath.io), or with Azure Artifact Signing (about $10 a month, your own name as publisher) or a code-signing certificate.
- **Android:** publish through Google Play's internal testing track ($25 once), so friends install from Play without warnings.
- **Desktop updates:** sign them with your own key (`UPDATE_SIGNING_KEY`, made with `node desktop/build/sign-update.js keygen`), so installed apps only take updates from you, whoever controls your server's downloads folder. This is separate from Windows code signing and works on Windows and Linux.

The GitHub workflow signs automatically once the secrets are added.

## Games & music: setup

Works out of the box (game search, pictures, setting things by hand, desktop detection). Two free keys in Admin → Owner → Games & music make it better:

- **Last.fm API key** (free, instant at last.fm/api/account/create): people can link their Last.fm username in Settings → Games & music, and their song updates by itself. Spotify connects to Last.fm in Last.fm → Settings → Applications; Apple Music, YouTube Music and others through a scrobbler app.
- **RAWG API key** (optional, free at rawg.io/apidocs): more console and mobile games in the search.

Activity shows only while someone is online and not invisible, and each person can turn games and music off separately. It isn't end-to-end encrypted (like online status, the server has to see it to show it). Your Hearth server needs outgoing internet access to store.steampowered.com, en.wikipedia.org, itunes.apple.com and ws.audioscrobbler.com for this.

## Capacity, regions and costs

See [docs/RUNNING-HEARTH.md](docs/RUNNING-HEARTH.md): measured capacity (how many people one VPS holds), linked regions (Admin → Regions) and what they cost, cost per person, automatic supporter payments with Ko-fi and Stripe (Admin → Money), and how to talk about it.

## Project layout

```
server/index.js     HTTP API, Socket.IO realtime, voice signaling
server/db.js        SQLite schema, encrypted-key storage
server/profile.js   Profile validation
server/perms.js     Roles and permission rules
public/             The web app (plain JavaScript modules, no build)
public/js/e2ee.js   Encryption primitives (WebCrypto + Argon2id)
public/js/secure.js Key management: group keys, rotation, verification
public/js/features.js Polls, voice messages, events, reminders
public/js/activity.js Games & music: playing / listening, favorite games
server/activity.js  Game search and pictures, Last.fm, live activity
server/regions.js   Linked regions (call relays) and their install script
server/money.js     Ko-fi / Stripe webhooks, supporter time and perks
server/search.js    Message search: metadata filters only, returns ciphertext
server/netguard.js  Outbound request guard (public addresses only, pinned lookups, caps)
server/proxytrust.js Which proxies may set the visitor's address (TRUST_PROXY)
server/imagemeta.js Strips hidden metadata from public pictures
public/sw.js        Service worker: offline app shell, updates, push notifications
scripts/            hearth-update.sh — safe server-side updater with automatic rollback;
                    make-update-zip.sh — release zip + .sha256
tools/              One-click update tool for Windows / Mac / Linux
desktop/            Electron desktop app + build config
mobile/             Android app (Capacitor) + its native code
.github/workflows/  Builds the desktop installers on GitHub (when Hearth is its own repository)
deploy/             Caddy, coturn and systemd examples
```

MIT licensed.
