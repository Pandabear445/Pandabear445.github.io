# Hearth

A self-hosted place to hang out with your friends: servers with text and voice channels, direct messages, a friends list, and profiles you can customize as much as you like. Run it on your own computer or a cheap VPS and send your friends an invite link.

- **Servers** with categories you can collapse, channels and categories you drag into order (or move from their menus), text and voice channels, invites, bans and per-server notification levels.
- **Roles and permissions:** unlimited custom roles with colors, emoji badges, hierarchy, "show separately" in the member list and @mentions; roles members pick themselves (ping roles, pronouns, colors, opt-in channels); 17 permissions; per-channel overrides for any role or person (private channels, read-only announcements, listen-only voice); slowmode per channel.
- **Make your server yours:** banner (positionable, GIFs animate), description, accent color, a server-wide background (presets, custom gradients or an image), welcome message, icon shape, role-colored names, and up to 200 custom emoji — animated GIF, WebP and APNG included, uploaded in bulk or grabbed straight from GIPHY — that members can use in any server or DM.
- **Conversations** with replies, threads (with what's new in each, and a Threads list per channel), reactions, pins, edits, forwarding, saved messages, @mentions (including @everyone and @channel), #channel links, Markdown with Discord's headings, lists and >>> quotes, spoilers, timestamps (`<t:…>`), code blocks, GIFs, emoji search, and image/video/file attachments (with spoilers and image descriptions) with a full-screen image viewer.
- **GIFs, stickers and emoji in one picker, laid out like Discord's:** GIFs / Stickers / Emoji tabs, big Favorites, Trending and category tiles, a back arrow out of any category or search, results in two steady columns that keep loading as you scroll, and a star on every GIF. Through KLIPY or GIPHY, with a privacy proxy so they never see your members' IP addresses.
- **Direct messages and group DMs** (up to 25 people, with group voice calls).
- **Home screen** with recent and pinned conversations, online friends, your servers and recent activity.
- **Search everything with Ctrl+K**: people, channels, servers, messages, files and links, with filters like `from:`, `in:`, `before:` and `has:`. Because messages are end-to-end encrypted, message search runs on your device; the server never sees the words (see [Search](#search-ctrlk)).
- **Notification center** for mentions, replies and friend requests, plus unread and mention indicators that respect muted channels and servers.
- **Voice and video:** voice channels (each with a text chat beside the call), group DM calls and 1-to-1 **DM calls that ring** (accept, accept with video, decline). **Webcam** and **screen sharing with sound** everywhere, with a spotlight view, fullscreen, picture-in-picture and per-person volume. Calls go directly between participants when they can, encrypted (DTLS-SRTP). When a network blocks that, they go through a TURN relay (this server, if `setup-turn.sh` installed it here, or a linked region), which only ever sees encrypted packets. Mute, deafen, speaking indicators and an optional input-sensitivity gate.
- **End-to-end encryption for everything:** server channels, DMs, group DMs and every attachment are encrypted in your browser before they're sent. The server stores only scrambled data, so the person hosting it can't read your chats from it, as long as the app code the server sends you is honest. It does see who talks to whom and when (see [what's protected](#security-and-privacy--whats-protected) and [SECURITY.md](SECURITY.md)).
- **Admin dashboard** for server administrators: live stats, who's online (with IP addresses and devices), reports with evidence, user lookup with IP history, suspend / unsuspend, sign out everywhere, registration control (open, invite code, closed), a Terms of Service editor, and an audit log of every admin action.
- **Reporting:** anyone can report a message or a person. Because messages are end-to-end encrypted, the reporter's app shares the messages they choose (shown to them first); the server verifies who sent them and when.
- **Terms of Service** that everyone accepts at sign-up (and again when you change them); public page at `/terms`.
- **Sounds you choose:** 30+ built-in sounds (bells, marimba, kalimba, plucked strings, glass, chiptune…) for every event — DMs, group DMs, @you, @everyone, role mentions, replies, voice — or your own sound files.
- **Privacy and safety:** blocking (the DM freezes both ways: no new messages, edits, reactions, pins, poll votes or typing; people can still delete their own), who can DM you ("friends only" also stops non-friends adding you to group chats), who can send friend requests, whether picture links to other sites load by themselves (they ask first by default, since that site sees your IP address), and a list of signed-in devices you can sign out remotely.
- **MySpace-style profile pages:** everyone gets a full page (open anyone's profile): headline (it can scroll like a marquee), mood, glitter name, profile song (optional autoplay), "Who I'd like to meet", an interests table, custom details (Location, Zodiac…), a Friend Space with your top 8 and a friend count, a **comment wall** (anyone / friends only / nobody), a retro profile-view counter and a **cursor trail**. Style it with six starter themes or by hand: layout, background (gradient, color, 8 patterns, or your own tiling image), box colors, opacity, 9 border styles, corners, shadows, fonts and text size. **Custom CSS** works too, safely: it only affects your own page, and anything that would load from another site is stripped. It can't cover the rest of the app or the close button, or hide text, and visitors leave comments in Hearth's own dialog.
- **Make your own effects:** pick any characters or emoji (up to 6), how they move (fall, rise, float, drift, twinkle, spin, zoom, bounce), how many, speed, size, color and glow; it plays on your card and across your whole page. Names can use up to 4 colors with flowing, pulse, wave, neon, glitch, outline and retro-shadow effects; avatar rings can spin with 3 colors at the speed you choose.
- **Profiles, all free:** GIF or image avatar, banner and full-card background; display name, pronouns, bio, links and a custom status that can clear itself; name colors, gradients, 12 fonts and glow/shimmer/rainbow effects; avatar shapes and animated rings; card colors, presets, glass style and animated effects.
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
- **Events:** plan game nights and hangouts in any server with a time, place and description; members RSVP (going / maybe / can't), the next event shows at the top of the channel list and on Home under "Coming up", everyone gets a heads-up 15 minutes before, and events can be added to your calendar (.ics). Events can **repeat** every week, every 2 weeks or every month (see [Events](#events-and-repeating-events)).
- **Reminders:** right-click any message → *Remind me* (in 20 minutes, in 1 hour, tonight, tomorrow morning).
- **People:** a directory of everyone you share a server with (search, online first, friends badge), and every profile card opens a full MySpace-style page with a big header — banner, avatar, name, headline, mood, status and when they joined.
- **Games & music:** show the game you're playing ("Playing ELDEN RING · for 1h 20m") and the song you're listening to (album art, artist, "on Spotify" with an *Open in Spotify* button), in member lists, friends, profile cards and pages. The desktop app detects both by itself (any Steam game plus 60+ popular others like Fortnite, Valorant, League, Minecraft, Roblox; the Spotify app; Apple Music on Mac; any player on Linux). Anywhere else, link Last.fm (works with Spotify, Apple Music, YouTube Music, TIDAL, Deezer) or set it by hand by pasting a song link. Plus **favorite games** (up to 12 covers) and **recently played** with hours. Pictures come from Steam and Wikipedia, cached on your server.
- **Regions:** each region also keeps copies of your encrypted backups. Add call relays in other parts of the world from Admin → Regions with one install command each; they check in every minute, show their load and traffic, and a call can be switched to any region (🌐 in the call bar, like Discord's region override) and everyone in it moves together; otherwise everyone's app uses the nearest two automatically.
- **Automatic supporters:** Ko-fi and Stripe payments turn on the 💜 supporter badge and perks (more storage, bigger files) by themselves for as long as someone paid, and count toward the funding card.
- **Android app:** an APK built by GitHub Actions that opens your server with calls, voice messages, notifications and file saving; works with a self-signed certificate (asks once, like the desktop app). Notifications arrive even after you swipe it away (through a push app such as ntfy, no Google needed), calls keep going with the screen locked, and invite links open in the app.
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

**Updates barely interrupt anyone.** The new version is prepared while the old one keeps running; the switch itself takes a couple of seconds. During that moment, people with Hearth open see an "Updating…" spinner, and then their app moves to the new version on its own — same conversation, unsent message kept (if they're in a call, they get a "reload when you're ready" bar instead). Behind Caddy, requests during the switch are held for a moment instead of failing, so nobody sees an error page. (`hearth-update` adds that Caddy setting for you; manually, it's `lb_try_duration 30s` inside your `reverse_proxy` block.)

**The easy way: `hearth-update` on the server.** Each release is a zip plus a `.sha256` file and, once its publisher signs updates, a `.sig` file next to it (made with `bash scripts/make-update-zip.sh [folder]`; the default folder is `hearth/dist`). **Keep them in the same folder.**

1. Upload all three to the server, into a folder only you can write to (your home folder, not `/tmp`). From your computer: `scp hearth-update-<version>.zip hearth-update-<version>.zip.sha256 hearth-update-<version>.zip.sig you@your-server:` (leave out the `.sig` if the release has none).
2. **The first time only**, install the updater from the Hearth that's already on the server, so the copy you already trust checks every update, not the one inside the zip: in the Hearth folder, `sudo install -m 755 scripts/hearth-update.sh /usr/local/bin/hearth-update`. Each update keeps it current after that.
3. On the server: `sudo hearth-update ~/hearth-update-<version>.zip`. To only check a zip (checksum, signature, version) without installing anything: `sudo hearth-update --verify ~/hearth-update-<version>.zip`.

`hearth-update` refuses a zip that doesn't match its `.sha256`, and always prints the SHA-256 it installs: compare it with the one in the release notes. A checksum alone catches a damaged zip, not a swapped one (whoever swaps the zip can swap its `.sha256` too); the signature does. Once your server has an **update signing key** pinned (the one your Hearth came with, or the one the first update that brings a key carries), it refuses any zip that isn't signed with that key before anything in it runs, and never installs an older version by itself. Checking needs OpenSSL 3.0 or newer (Debian 12, Ubuntu 22.04) or Node.js; a server with neither pins no key and stays on checksums, and says so. The update log and `hearth-update --status` show the pinned key: compare it with the one in the release notes. For a zip you checked yourself, `--allow-unsigned` installs it anyway and says so loudly. Publishing your own updates: [docs/SIGNING.md](docs/SIGNING.md#signing-server-updates).

It checks a private copy of the zip (checksum, then signature) before anything in it runs. It backs up the program files and database, copies in the new files (never touching `data/`, `.env`, `docker-compose.yml` or `deploy/Caddyfile`), builds the new version while the old one keeps running, switches over, checks the new version answers, and **rolls back automatically** if it doesn't. It works with Docker, systemd, pm2 or plain `node`; a plain install is restarted, and its libraries installed, as the owner of `data/`, never as root (one that root itself started stays root, with a warning). Also on the server: `hearth-update --rollback [backup]`, `hearth-update --list`, `hearth-update --status` and `hearth-update --logs`. If an update stops, the log names the exact step that failed ("Step failed …"); the whole log is kept in `/root/hearth-backups/last-update.log`. Backups go to `/root/hearth-backups` (the last 5 are kept).

**The manual way:**

Upgrades keep your accounts, passwords, encryption keys and messages, but they're not only additions: some convert existing data (for example how sign-in sessions or the audit log are stored). That's why Hearth copies the database first.

1. **Back up** the `data/` folder and `.env` (copy them somewhere safe). Hearth also makes its own copy automatically: before applying a database upgrade it saves `data/backups/hearth-before-vN-<date>.db` (a consistent copy, made once per upgrade; the newest 3 are kept, see `PRE_UPGRADE_KEEP`).
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
- **Arranging channels and categories** (Manage Channels): drag a channel up or down in the sidebar, or onto another category's name to move it into that category (it goes first there); drag a category by its name to move it with all its channels. A line shows where it will land. Without a mouse, open a channel's menu (right-click, or **More** in the channel header) or a category's menu → **Move up** / **Move down**; at the top or bottom of its category a channel moves on into the next one (the menu says where: "Move down · to Voice"; a collapsed category opens), and the focus stays on it. Everyone sees the new order straight away. If someone else changed the order while you were moving something, your move is refused ("The channel list changed in the meantime") instead of undoing theirs. A channel where Manage Channels is denied to you can't be dragged or put in another category, and a category holding one can't be dragged or renamed; the channels and categories you do manage go around them (categories are labels, not locks: your channels can still go into such a category, and moving the others around it can put it anywhere). Channels and categories you can't see keep their place, and nothing shows you a category of channels you can't see, nor how many channels you can't see or where they are. Renaming a category to the name of another merges the two; that takes seeing every channel in it. Moves go in the server's audit log ("Ana moved #news in the channel list", "Ana changed #chat: moved it to “Voice”"). Each person can make 30 changes a minute.
- **Roles members pick themselves:** in a role's settings, turn on **Members can pick this role themselves**. Everyone then finds it under **Pick your roles** in the server menu (and at the start of each channel), and can add or drop it whenever they like — handy for ping roles like @game-night, pronoun and color roles, and opt-in private channels (give the role access to the channel as usual). Picking a role works exactly like a moderator giving it: channels it opens appear within a moment (in a busy server, everyone's picks go out together), and dropping it closes them again (and takes you out of a voice channel you can no longer join right away). It can't hand out power: roles with moderator powers (Administrator, any Manage permission, Kick or Ban, itself or in a channel) or Mention @everyone can't be marked, and a marked role can't gain them later; a marked role has to sit below every role that can kick, ban, manage roles or manage nicknames (those only work on people below you), so picking it never puts anyone out of a moderator's reach; and marking a role takes what giving it to anyone would (Manage Roles, the role below yours, and all its permissions, in each channel too). A role sold as a membership can't be marked, and the other way round. When you pick a role, it's refused if it would undo a limit another of your roles puts on you in a channel (say, a "quiet" role that can't post in #general); a moderator can still give it to you. That's only checked when you pick: a "quiet" role given to someone *after* they picked a role that allows posting there doesn't stop them (between roles, an allow beats a deny). To keep someone quiet for sure, time them out. Timed-out members can't change their roles until the timeout ends. Turning it off leaves the role with the people who have it; they just can't drop it themselves any more. Adding or removing a role for someone (the member menu, or a role's member list) changes just that role, so it never undoes a role they picked or dropped a moment before.
- **Nicknames:** the name someone goes by in one server. Open the server menu → **Change nickname** (or right-click yourself in the member list) to pick yours: people in that server see it instead of your display name in the member list, on your messages, in @mention suggestions, in typing and notifications, and on call tiles. Everywhere else (DMs, friends, your profile page) still shows your display name, and a profile card opened inside the server shows the nickname as an extra line, so nobody's real name is hidden. @mentions still go to the username. Everyone can change their own by default (**Change nickname**, in @everyone; take it off @everyone and give it to some roles if you prefer). **Manage nicknames** lets moderators change or remove the nicknames of people below their highest role (right-click → **Change nickname…**), never the owner's. Nicknames follow the display-name rules: up to 32 characters and the instance's word filter (which sees through invisible characters, so a blocked word can't be split with one), and no invisible or right-to-left trick characters: a nickname needs at least one character people can see. Timed-out members can't change nicknames, nor can someone whose profile an admin locked; an admin resetting a profile clears its nicknames too. Leaving the server takes your nickname away. Every change is in the server's audit log, your own included, so moderators can see every name someone went by; to keep the log readable, you can set your own nickname up to 10 times an hour in each server (removing it always works). Once someone deletes their account, the log keeps its entries about their nicknames but no longer shows the names (like the rest of their profile, they're erased). Group chats have no nicknames. Manage nicknames is a moderator power: it can't be sold as a membership or picked by members themselves, and a role members pick themselves has to sit below every role with it (so nobody can pick their way out of a nickname moderator's reach).
- **Members:** add or remove roles, kick or ban (only people below you). Leaving, a kick or a ban removes the person's roles and per-channel permissions; rejoining starts from @everyone (roles from a membership they still pay for come back by themselves). **Bans** stop people rejoining through invites until unbanned, and revoke the invite links the banned person made. The ban dialog can also **delete their messages from the last hour, 24 hours or 7 days** in every channel of the server, with their files. A thread they started goes with its replies only where you could delete those replies yourself (Manage Messages in that channel, and every reply by someone below you); otherwise the thread stays, and the answer says how many were kept.
- **Moderator toolkit** (right-click someone in the member list or in a voice channel, or Server settings → Members → Manage):
  - **Disconnect from voice** and **Move to another voice channel** need **Move Members**, which can be given per voice channel (a move needs it in both channels).
  - **Server mute** needs **Mute Members**, a server-wide permission: the mute holds in every voice channel of the server, whether or not they're in a call, and lasts until someone with Mute Members lifts it, even if they leave and come back. Server settings → Members lists who is server-muted, with **Remove mute**; the member menu offers **Remove server mute** too. The owner can't be muted, and handing someone the server lifts their mute. Audio goes straight between the people in a call, so a server mute is carried out by the apps: theirs keeps the mic off and everyone else's in the call stops playing their audio. A modified app can still send sound, but nobody's normal app plays it.
  - These only work on people below your highest role (never the owner), and not while you're timed out yourself.
  - **Bulk delete** (Manage Messages): right-click a message from the last 14 days → **Select messages to delete…** and tick up to 100, or right-click a channel → **Delete recent messages…** for the newest ones. Only messages from the last 14 days; messages by people at or above your highest role are kept, and so are threads with replies by them. Open apps remove them straight away. Esc stops picking.
  - Every disconnect, move, mute, bulk delete and ban cleanup goes in the instance's audit log (Admin → Audit log), and in the server's own audit log (below).
- **Audit log (Server settings → Audit log):** who did what in this server, in plain sentences: "Ana banned Sam and deleted their messages from the last 24 hours (12 messages)", "Ben changed permissions in #general", "Sam picked the role game-night". It covers kicks, bans and unbans, timeouts, role changes (roles members picked themselves are marked as such), nicknames, roles, channels and categories (a channel's disappearing-messages timer too), channel permissions, invites, emoji, webhooks, bots, voice disconnects, moves and mutes, moderators deleting other people's messages (one at a time or in bulk), pins, server settings and ownership. It never shows what anyone wrote, only whose message and where. Filter by kind and by person (type a username: people who were banned or kicked long ago are found too), and load older entries; new ones appear while it's open. Readers need the new **View audit log** permission (owners and Administrators always have it). Someone who can't see a channel gets "a private channel" instead of its name, and nothing else the entry says about it; once a channel is deleted, its name stays hidden (from everyone but Administrators) if it was private when it was deleted. Invite codes are shown whole only to people with Manage Server. Handling reports isn't in the log (the person reported could read it there): who handled a report, and when, is on the report in Reports. Entries can't be edited or deleted (the database refuses), and are kept for a year, up to the newest 10,000 per server (never less than the last week, so a flood of new entries can't push recent ones out; past 50,000 entries only that week's moderation is kept, and past 200,000 the oldest go whatever they are). Invites someone makes or revokes are listed up to 10 an hour per person, and the invite dialog hands back the link you made a few minutes ago instead of making another, so ordinary members can't fill the log with them. View audit log is a moderator power: it can't be sold as a membership or picked by members themselves.
- **Reports (Server settings → Reports):** a report about a message in one of the server's channels, or about a member reported from their profile while you're in the server, also goes to the server's moderators (Manage Messages in that channel, or Kick or Ban Members), not only to this Hearth's staff. They see the category, the reporter's note and, of the messages the reporter chose to share (decrypted on the reporter's device, as for staff), the reported person's own, never who reported it: the reporter's own messages (and anyone else's) go to staff only, since they would give the reporter away. Each moderator sees reports about people below their highest role, from channels they can see, and never about themselves. They can mark a report handled or dismissed with a short note, or reopen it; that's their own status, so this Hearth's staff still see every report and handle it on their own (the admin dashboard shows where the server's moderators are with it). The reporter can untick "Also show it to the moderators of …" in the report dialog, and child-safety reports always go to staff only.
- **Invites:** new invite links expire after 7 days unless you choose otherwise (1 hour, 1 day, 30 days or never). **Server settings → Invites** (Manage Server) lists the links that still work and revokes them; anyone can revoke the links they made. A new or imported server opens its invite link right away, with a message to copy or share. Pasted into Discord, Reddit, X or a text, an invite link shows a preview ("You're invited to a server on *your instance*"), and so does the sign-in screen for someone without an account; the server's name and member count appear only if you turn on **Server settings → Overview → Privacy → Show this server's name and member count in invite link previews** (docs/FEATURES.md).
- **Appearance:** accent color, server background (preset, custom gradient or image, with darkening), role-colored names, and a welcome message shown at the top of every channel. Members can turn server themes off for themselves under Settings → Appearance.
- **Overview:** icon (GIFs work) and its shape, name, description, and a banner you can position and zoom. Under **Privacy**: [New members can't read messages from before they joined](#new-members-cant-read-messages-from-before-they-joined) (off by default).
- **Emoji:** upload PNG/GIF/WebP emoji (up to 200 per server, 2 MB each). Type `:name` in the message box or use the emoji picker; they work in every server and DM, and as reactions.

Good to know: private channels are enforced by the server — people without access never receive those messages. Like the rest of the server, they're end-to-end encrypted with the server's key, which every member holds, so private channels keep things away from other members by the server's choice rather than by separate encryption. "Speak" is enforced by the apps (listen-only members join muted, and everyone else's app doesn't play audio from someone without Speak or under a server mute), and the server keeps them shown as muted. Permission changes apply mid-call: losing Speak mutes you at once, and losing Connect or View (role edits, role removal, overrides, a membership ending, ownership transfer) takes you out of the call. @everyone and role mentions only notify people in the app when the sender is allowed to use them; that takes Mention @everyone as a server-wide (role) permission, because people's apps can't see channel overrides. Phone push notifications for @mentions go only to people who can see the channel, at most 50 per message, based on the sender's app's list.

## Moving from Discord

**Add a server → Import from Discord** starts a new server with a Discord server's roles, categories, channels and channel permissions:

1. In Discord, copy the server's template link (Server Settings → Server Template).
2. Paste it into Hearth, which gives you the template's address to open in your browser.
3. Copy what that page shows and paste it back.

Hearth itself never contacts Discord and never asks for a Discord login. Before anything is made, the preview shows:

- each role with its Hearth permissions;
- the channels by category;
- what Hearth will allow that Discord didn't (most importantly, anyone who can see a channel can read all of its history);
- a full list of what will be skipped: Discord permissions Hearth doesn't have, channel kinds it doesn't have (threads, directories), member-specific permissions, NSFW flags, user limits and server settings.

You can leave out roles or channels, and you own the new server. Where Hearth can't match Discord exactly, it errs toward less, and anything Hearth would allow beyond what Discord did is listed before creating: for example, Kick Members also times people out in Hearth, Manage Channels also manages webhooks and events, and an invite that a channel took away in Discord can't be taken away per channel in Hearth. Members, messages and emoji don't come with it; emoji and message history are later phases.

Limits: 99 roles besides @everyone, 500 channels, 50 categories, 5,000 channel permissions and 5 imported servers an hour; the same people who may create servers may import one. The full mapping is in [docs/IMPORT.md](docs/IMPORT.md).

## Docker

```bash
docker compose up -d          # https://<host>:3000 with a self-signed certificate
docker compose logs -f        # see the startup addresses and any errors
docker compose up -d --build   # rebuild after updating the files
```

Everything is stored in `./data`. Requires Docker Compose 2.24 or newer.

**Without building: the ready-made image.** Each release (a `hearth-v<version>` tag) is published as
`ghcr.io/pandabear445/hearth:<version>` for 64-bit Intel/AMD and ARM (Raspberry Pi 4 and 5 included), scanned before
it's pushed and with a build provenance attestation and an SBOM attached (`.github/workflows/hearth-image.yml`).
[`deploy/compose.image.yml`](deploy/compose.image.yml) is the same hardened setup as `docker-compose.yml` with that
image in place of the build, and works on its own in an empty folder (the domain setup is in its header):

```bash
curl -fsSLo compose.yaml https://raw.githubusercontent.com/Pandabear445/Hearth-chat/main/hearth/deploy/compose.image.yml
docker compose up -d          # https://<host>:3000; then sign up first: the first account is the owner
```

Without Compose (it starts as root only to hand `./data` to uid 1000, then drops to it with no capabilities):

```bash
docker run -d --name hearth --restart unless-stopped -p 3000:3000 -v "$PWD/data:/data" \
  --read-only --tmpfs /tmp:size=64m,mode=1777 --security-opt no-new-privileges:true --pids-limit 512 \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH --cap-add SETUID --cap-add SETGID \
  ghcr.io/pandabear445/hearth:1.29.0
```

To update, change the version and run `docker compose pull && docker compose up -d` (or start a new container
from the new tag). If the registry says the image isn't there, that release hasn't been published yet: use the
steps above. Templates for the Unraid, CasaOS, Umbrel, Dokploy and Coolify app stores are in
[`deploy/catalogs/`](deploy/catalogs/README.md), with what each needs (https, a way in for friends, who signs up
first).

**Hardened by default.**

- **Runs unprivileged**: Hearth's container runs as an unprivileged user (uid 1000) on a read-only filesystem, with no Linux capabilities and no way to gain any. Only `./data` and a small `/tmp` are writable, and logs are rotated.
- **Fixes old file ownership**: on start, a tiny one-shot helper (`hearth-perms`) hands `./data` to uid 1000, because older versions wrote it as root.
- **No direct internet exposure with a domain**: set `HEARTH_BIND=127.0.0.1` in `.env`; Caddy reaches Hearth over an internal network.

**Upgrading an existing Docker install:** `hearth-update` never replaces your `docker-compose.yml`.

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
- **Reports:** what was reported, the messages the reporter shared, the reported account's IP addresses, and buttons to suspend the account, delete the message, resolve or dismiss. You get a live notification when a report comes in. Reports from inside a server also reach that server's moderators (without the reporter's name); a card says when they did, and whether they handled or dismissed it. Their status never changes yours.
- **Users:** search by name or IP; see IP history, signed-in devices and reports; suspend (signs them out everywhere at once, and they see your reason when they try to log in) or sign them out everywhere.
- **Registration & Terms:** switch sign-ups between open, invite-code only and closed in one click (handy during a spam wave), and edit your Terms of Service (everyone is asked to accept changes).
- **Audit log:** every staff action and account security event (password changes and resets, two-factor on/off, sessions signed out, deleted accounts, backups, and changes to payments, memberships, GIF, music and relay settings and regions), who did it and from which IP. It's append-only: nobody can edit or delete entries. Each entry is signed with a key derived from `data/secret.key`, and the newest one is also recorded in `data/audit-anchor.json`, so the page shows if someone edited, deleted or cut off entries in the database file without that key. Someone with root on the server (the database and the key) could still rewrite it.
- **Storage & limits:** set the largest file, picture and profile song, a storage limit per person and a daily upload limit (all optional). See total use, today's uploads, free disk space and who uses the most; give one person a bigger (or smaller) limit, turn off someone's uploads, lock someone's profile, delete everything someone uploaded (their GIF-library uploads included) or all their profile comments. People see their own usage under Settings → Security & storage; GIF-library uploads count too. Limits hold even when someone uploads many files at once (at most 4 at a time per person). Admins and the owner aren't held to quotas.
- **Word filter:** words and phrases that can't be used in names, bios, profile pages and profile comments. Chats are end-to-end encrypted, so the server can't filter them; each person (and each server, as a suggestion) can set a word filter that their own apps apply instead (see **Word filter** below).
- **Team & roles:** three staff levels. The **owner** is the only one who can make people **admins** or **moderators**, change or take away those roles, and hand ownership to someone else (you stay on as an admin). Each of those needs your password again (and a two-factor code if it's on), and the old owner is emailed when ownership moves. Who the owner is gets settled once, at the first sign-up (see `ADMIN_USERS` in the settings table), and never moves by itself after that. Lost the owner's account? `node server/cli.js set-owner <username>` names a new owner (see [Backups](#backups)). **Admins** get the whole dashboard and Settings → Instance. **Moderators** get reports, users, who's online and the audit log. Staff can only act on people ranked below them, so a moderator can't suspend an admin and nobody can touch the owner. That covers messages too: staff can't remove messages by staff at or above their rank, and can remove DMs and group-chat messages only when they were reported. Admins can't delete or take over servers the owner owns, delete group chats, or IP-ban the owner's or higher staff's networks. People see the dashboard appear or disappear the moment their role changes.
- **Moderation tools:** timed suspensions (1 hour, 1 day, 3 days, 1 week, 30 days or until lifted; they end by themselves), private staff notes on any account, "reset profile" for offensive names, pictures and bios, user filters (online, suspended, staff), handing a server to another member when its owner has left, and an emergency "sign everyone out" (staff stay signed in).

**About IP addresses:** the server records which IP addresses each account connects from, for security and abuse reports. The default Terms say so; keep that in your terms if you edit them, and check what your local privacy laws require.

### Security built in
- **Captcha on sign-up and login:** a private, self-hosted "I'm not a robot" check (proof of work, like ALTCHA). People's browsers solve a small puzzle — about a fifth of a second on a computer, usually finished before they've typed their password — which makes mass sign-ups and password guessing expensive for bots. Puzzles are signed, single-use and expire after 5 minutes. Networks (IPv6 per /64) that keep failing get harder puzzles. When sign-ups (more than 120 an hour) or sign-ins (more than 3,000 in 10 minutes) are unusually busy, the puzzle gets harder for everyone, up to a few seconds in a browser, instead of turning people away; the app solves the harder one by itself. With the robot check switched off, those limits refuse requests instead. "Forgot password" uses the login robot check. No Google/hCaptcha scripts and no tracking. Turn it on or off for login and sign-up in Admin → Registration & Terms. It's proof of work, so a determined attacker with fast hardware pays less than a browser does.
- Strict browser security policy (only this server's own scripts can run, and the app's own requests can only go back to this server), clickjacking protection, HSTS on HTTPS, locked-down browser permissions. Pictures and videos can still load from other sites, so the policy alone doesn't stop data leaving (see [SECURITY.md](SECURITY.md) row 25).
- Rate limits by network (IPv6 per /64), per account (from any number of IPs) and per session on sign-in, sign-up, password reset, two-factor codes, email codes, messages, uploads, joining servers and profile edits. Requests without a solved robot check don't count toward the per-account or instance-wide limits. The devices that have signed in to an account before (they keep a signed note) and the networks it has been used from (for IPv6, the whole /64) have their own limit, so a stranger can't lock someone out of their usual devices. Someone who keeps solving robot checks can still hold up a brand-new device on a new network for a while (10 tries per 15 minutes, 100 a day per account).
- **Sessions:** every device is listed in Settings → Security → Signed-in devices (device, IP, last active) and can be signed out on its own, or all at once with "Log out all other devices". Sessions also end after 60 days unused or 365 days in total. Signing out, changing the password, a reset and turning on two-factor all cut off the other devices immediately, including open app windows and their push notifications, and messages they [scheduled](#send-later-scheduled-messages) wait until you confirm them. The device you make the change on stays signed in, but with a new sign-in token, so a copy of its old token taken earlier stops working too: an app window still connected with it is closed (at once, and within a minute at the latest), push notifications set up with it stop, and that window is told its sign-in was renewed somewhere else. (It stays the same sign-in: its windows reconnect with the new token, showing as Online again after a moment offline and as Away once they're idle again, and the app re-confirms what it scheduled by itself, so that still goes out as planned, while anything a copy of the old token queued waits and can only be cancelled.) "Log out all other devices" asks for your password (and a two-factor code if it's on) and does the same; someone who only has a copy of your sign-in can't get a new token and shut your device out. Other tabs of the same browser pick up the new token by themselves and stay signed in.
- **Re-confirm before sensitive changes:** these need your password again, plus a two-factor code if it's on: changing your password, email, recovery key or username, turning off two-factor, deleting your account, and deleting or handing over a server you own. For admins also: team and ownership changes, deleting backups or keeping fewer of them, showing the backup key, changing where payments go, changing the call relay's secret or addresses, creating or reinstalling a region, and marking someone's new keys as verified after a reset without their recovery key (Admin → Users). With two-factor on, each of these asks for a fresh code every time, even right after you signed in with one, so someone who copied your sign-in and saw your password still needs your phone. (A change that takes two steps, like a new recovery key, asks once: the app is given a one-time pass for the second step, for 5 minutes, that only it ever sees and that only works for that change.) A change that can't go through anyway (a mistyped email, a username that's taken) is turned down before your code is used; if one is turned down after, the app says the code was used and asks for a new one. Right codes don't count toward the two-factor guess limits, so a run of changes never locks you out of signing in. Two low-risk ones also accept a two-factor sign-in from the last 10 minutes: starting a data export (it only covers what your sign-in can read anyway) and an admin's clean-up of files nothing uses. 10 wrong passwords per 10 minutes.
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

It installs coturn, locks it down (relay passwords per person that run out within 12–18 hours, no relaying into private networks, each relayed connection capped at 6 Mbit/s each way — `TURN_MAX_MBIT` — with an optional total cap `TURN_CAPACITY_MBIT`, and a limit on how many relayed connections one person can hold), opens the firewall ports, and connects it to Hearth — no restart needed. The relay secret never appears on a command line or on screen: it's in `/etc/turnserver.conf` (the `static-auth-secret=` line), which only root and coturn can read. The app fetches new relay passwords before the old ones run out, so an app left open for days keeps working calls. Check it with **Settings → Instance → Calls → Test relay**. If your VPS provider has its own firewall in their control panel, open UDP+TCP 3478 and UDP 49160–49400 there.

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

**Push notifications** reach people when Hearth is closed. Each person turns them on per device in *Settings → Apps & devices*. Because messages are end-to-end encrypted, a notification only says who and where (e.g. "Alex mentioned you · #general"), never the message. To work out who was @mentioned, the sender's app tells the server which member IDs it mentions — that's the only extra thing the server learns. Each account can have up to 10 devices with notifications on (turning it on somewhere new drops the oldest). Signing a device out, from that device or from Settings → Sessions, or changing your password, stops its notifications. Logging out turns notifications off in that browser. A device whose push service keeps failing is paused and, after a while, dropped; the app turns notifications back on the next time it starts. Push services must be public `https` addresses; `PUSH_HOSTS` limits them to the ones you name, and `PUSH_PRIVATE_HOSTS` lets one on your own network through (a self-hosted ntfy). The keys a device hands over must be a real P-256 key and a 16-byte secret. A push service that says "too many" (429) is left alone for as long as it asks, without counting against the device; one that refuses or errors is backed off and dropped after 8 failures in a row (the server logs which push service refused, by host, at most once an hour). Every notification is padded to a multiple of 256 bytes before it's encrypted, so a push service can't tell names apart by size. The server creates its push keys in `data/vapid.json` on first start; set `VAPID_SUBJECT=mailto:you@yourdomain` in `.env` (Apple's push service rejects placeholder addresses). Without a real one the server uses its `PUBLIC_URL` (when it's `https://`), and otherwise logs a warning at start. **iPhone and iPad:** notifications work for Hearth added to the Home Screen, on iOS 16.4 and newer. In Safari the app says so once; opened from the Home Screen, it offers notifications once. Apple's push service drops a device that gets pushes without a notification, so for Apple devices a push that arrives while Hearth is open in front is shown and closed at once.

**In the Android app** a browser's push service isn't available, so the app uses [UnifiedPush](https://unifiedpush.org/): a push app on the phone, usually [ntfy](https://ntfy.sh/) (free on F-Droid and Google Play), gives Hearth a Web Push address, and the server sends to it exactly as it sends to a browser: encrypted for that phone, so ntfy only ever carries ciphertext. Settings → Apps & devices → *Notifications when Hearth is closed* (the app also offers it once). It's off until someone turns it on; without a push app, Settings says how to get one. With the public ntfy.sh, ntfy's operator learns when this phone gets a notification from your server (never what it says); to avoid that, run your own ntfy and set `PUSH_NTFY_URL` (see [docs/OPERATIONS.md](docs/OPERATIONS.md#7-self-hosted-ntfy-for-android-notifications)).

### Desktop app (Windows, macOS, Linux)

The `desktop/` folder is an Electron app for Windows (and Mac/Linux). It loads the interface from your server, so most updates reach people without reinstalling, and adds what a browser can't:

- **Push to talk, mute and deafen keys that work while a game is focused** (Settings → Keybinds; keyboard keys, combos or mouse side buttons). The key still reaches the game.
- **Updates itself** from your server (Windows and Linux): downloads in the background, then asks before installing ("Restart to update" shows a confirmation; nothing installs on quit). Apps built with your update key (the `UPDATE_PUBLIC_KEY` variable, the public half of the `UPDATE_SIGNING_KEY` secret) only install updates signed with it; others say the update can't be verified (Settings → Apps & devices shows which). See [Signing desktop updates](docs/SIGNING.md#signing-desktop-updates).
- **Asks before using your mic, camera or clipboard** on each server (Help → Reset permissions undoes it), and screen sharing always goes through the app's own picker window.
- **Taskbar:** unread count on the icon, the button flashes when someone @mentions you, and Mute/Deafen buttons in the taskbar preview while you're in a call.
- **Invite links open in the app** (`hearth://invite/…`; the browser's join window offers "Open this invite in the app").
- **Detects the game you're playing and your music** (Settings → Games & music).
- Tray icon, start with Windows (minimized or not), remembers its size and position, reconnects right after your PC wakes up, screen sharing with sound, and a "What's new" note after updates.

**Make updates automatic (once):** in your GitHub repository → Settings → Environments → `production` (create it if it isn't there yet) → Environment secrets, add the secrets below. Only the jobs that sign and publish releases run in that environment; give it protection rules too (only the default branch and `app-v*` tags, and required reviewers if you want to approve each release; see [docs/SIGNING.md](docs/SIGNING.md#where-each-secret-and-variable-goes)). If you made any of these as repository secrets before, delete those (Settings → Secrets and variables → Actions): any branch's workflow can read a repository secret, so the environment's rules protect nothing while they're there:

- `VPS_HOST` (your server's IP);
- `VPS_USER`: a user made just for this, with no sudo, that can only write `data/downloads` (not `root`);
- `VPS_SSH_KEY` (a private key made just for this; its public half goes in that user's `~/.ssh/authorized_keys`);
- `VPS_HOST_FINGERPRINT` (**required** with `VPS_HOST`): your server's SSH host key fingerprint, the `SHA256:…` value from `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server. Without it the copy step fails and copies nothing; with it, the copy refuses any other machine;
- `VPS_DOWNLOADS_DIR` (the full path of Hearth's `data/downloads` folder; `hearth-update --status` shows where Hearth is);
- `UPDATE_SIGNING_KEY` (recommended) and, as a repository variable (Settings → Secrets and variables → Actions → Variables), `UPDATE_PUBLIC_KEY`: the key pair that signs desktop updates, made with `node hearth/desktop/build/sign-update.js keygen`. Already have `UPDATE_SIGNING_KEY`? Don't make a new pair (installed apps only accept the one they have): set `UPDATE_PUBLIC_KEY` to its public half, which the next release build prints. See [docs/SIGNING.md](docs/SIGNING.md#signing-desktop-updates).

Release builds (`app-v*` tags and the default branch) then copy the installers and update files there, keep the two newest, and every desktop app offers the update within a few hours. Builds of other branches and manual runs from them never reach people's apps. Without these, download the installer from the Actions run and put it (with `latest*.yml`, the `.blockmap` and `latest*.yml.sig`, which is in the separate `hearth-desktop-update-signatures` artifact, made only for tags and the default branch) in `data/downloads` yourself.

**Point it at your server:** edit `desktop/hearth.config.json`:

| Key | What it does |
|---|---|
| `defaultServer` | Your address, e.g. `https://chat.example.com` (set to `https://kappachat.duckdns.org`). Empty = ask on first launch. The repository variable `HEARTH_SERVER` overrides it at build time. |
| `lockServer` | `true` to hide "Change server" (a branded app for your community). |
| `appName`, `appId` | Window title, and the ID Windows/macOS use for notifications. Also change `productName`/`appId` in `desktop/package.json` if you rebrand. |
| `closeToTray` | Keep running in the tray when the window is closed (Windows/Linux). |
| `trustedSelfSignedHosts` | Hosts for which **any** certificate is accepted without asking, so a man-in-the-middle would go unnoticed. Leave it empty: the app then asks once and remembers that exact certificate. |
| `updatePublicKey` | Filled in at build time from the `UPDATE_PUBLIC_KEY` variable (the public half of the `UPDATE_SIGNING_KEY` secret). When set, the app only installs updates signed with the matching private key. |

**Build installers automatically (recommended):** GitHub builds them whenever the apps change, on a tag (`git tag app-v1.17.0 && git push --tags`, attached to a release), or when you run the *Hearth apps* workflow from the Actions tab (you can type your server address there, or set the repository variable `HEARTH_SERVER`). The workflow is `.github/workflows/hearth-apps.yml` at the top of the repository; if Hearth lives in a repository of its own, `.github/workflows/desktop.yml` inside this folder does the desktop part. GitHub builds `.exe` (Windows), `.dmg` (macOS) and `.AppImage`/`.deb` (Linux) and attaches them to a release. To also copy them to your server automatically, add the `production` environment secrets above (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_HOST_FINGERPRINT`, `VPS_DOWNLOADS_DIR`).

**Build on your own computer:** `cd desktop && npm install && npm run dist` (builds for the system you're on).

**Publish them:** put the installer files in `data/downloads/` on the server (or set `DESKTOP_DOWNLOAD_URL` to your GitHub releases page). They appear on `/download` automatically.

**Code signing:** unsigned builds work, but Windows shows a SmartScreen warning ("More info → Run anyway") and macOS needs right-click → Open the first time. Removing those warnings needs a code-signing certificate (Windows) and an Apple Developer account ($99/year, macOS notarization); electron-builder picks them up from environment variables when you have them. Auto-update works on Windows and Linux and comes from your server's `/updates` (its `data/downloads` folder), not from GitHub, so whoever controls that folder decides what's offered: sign your updates with `UPDATE_SIGNING_KEY` so the apps refuse anything else. macOS builds don't update themselves.

### Android app

The `mobile/` folder is an Android app (Capacitor) that opens your server, like the desktop app: chats, calls, video, voice messages, watch together, notifications, and saving files to *Downloads/Hearth*. It works with a self-signed certificate (an IP address like `https://1.2.3.4:3000`): it shows the fingerprint and asks once. It updates whenever you update the server.

- **Notifications when it's closed** through a UnifiedPush push app such as ntfy (see *Push notifications* above). They say "New message" or "Incoming call" (or who, if the person shows names); a call older than two minutes shows as a missed call instead of ringing. Tapping one opens the message, the conversation or the call.
- **Calls keep going with the screen locked** or the app in the background: while you're in a call the app shows an "In a call" notification with *Hang up* (an Android foreground service; it needs the microphone permission, which joining a call asks for).
- **Invite links open in the app:** `hearth://invite/CODE` on any build, and `https://your-server/invite/CODE` when the app is built for your server (`HEARTH_SERVER`) and the server has `ANDROID_CERT_SHA256` set (Android checks `/.well-known/assetlinks.json`).

Parts of this need a real phone to prove; [mobile/README.md](mobile/README.md#not-yet-tested-on-a-device) lists what CI checks and what it can't.

**Get the APK:** GitHub builds it with the desktop installers — repository **Actions** tab → *Hearth apps* → latest run → *Artifacts* → `hearth-android` (or push a tag `app-v1.17.0` to get a release). That needs your own signing key in the `ANDROID_KEYSTORE_*` secrets; without them the build only makes `hearth-android-UNSIGNED`, which Android won't install. Put the `.apk` in `data/downloads/` and the `/download` page offers it to Android visitors. Details, signing and limits: [mobile/README.md](mobile/README.md).

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

## Text chat in voice channels

Every voice channel in a server has a text chat beside its call, for links, notes and whatever you'd rather type.
Open it with the **chat button** in the call's header, or right-click the voice channel → **Open chat** (you don't
have to join the call to read or write). It's the same conversation view as a text channel: replies, reactions, pins,
edits, files, polls, voice messages, link previews, @mentions, search (Ctrl+K) and Export my data, end-to-end
encrypted with the server's key like every channel.

- **Who can use it:** anyone who can see the voice channel and has **Send Messages** there. Connect isn't needed, so
  people who can only see a call can still chat. To keep a voice channel voice-only, deny Send Messages in its
  permissions, or use **Make the chat read-only** in its menu. Slow mode, Attach Files, Add Reactions, Mention
  @everyone and Manage Messages work there as in text channels.
- **Unread:** a voice chat counts as unread only for people who follow it: who have opened it once or written there
  (on any of their devices), who picked *All messages* for it, or who are in its call. Until then only pings show:
  an @mention of you, a reply to you, a role you have, or an allowed @everyone. Notifications follow the same rule:
  a server set to *All messages* doesn't notify you about voice chats you don't follow. Set *All messages* on the
  voice channel itself (right-click → Chat notifications) to follow it and hear about every message there from then
  on. **Mark as read** on a chat you don't follow (or Mark server as read) only clears its pings: it doesn't make
  you follow it.
- **Not there:** threads, bots, webhooks and slash commands stay in text channels. A group chat's call has no separate
  chat: the group's own conversation is it.
- **Moderation:** pins, Delete recent messages, picking messages to delete, a ban's message cleanup and the server's
  audit log all cover voice chats.
- **Upgrading:** voice channels that already exist get a chat too, with the limits your server already had on
  posting carried over, once, on the first start: whoever is denied **Connect** on a voice channel is denied Send
  Messages there too, a role or member denied Send Messages in every text channel they can see (a "Muted" role,
  @everyone on a read-only server) is denied it in the voice channels as well, and when every text channel has slow
  mode the voice channels get the shortest one. Each change is in the server's audit log, by Hearth. Nothing else
  changes, so on most servers everyone who can see a voice channel can chat there: deny Send Messages (or use
  **Make the chat read-only**) on channels that should stay voice-only, and remember that everyone who can see a
  voice channel can read its chat, whether or not they may join the call. A staff-only call room keeps a closed
  chat until an admin allows Send Messages for the people who may use it.

Details: [docs/FEATURES.md](docs/FEATURES.md#voice-channel-chats).

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
| Whether each of your open apps is in use or idle (for automatic **Away**), and how long a custom status should last | Yes. Away, like Online, goes to everyone signed in on this Hearth (people you've blocked too), so it shows when you stop and start using Hearth. See [Away and custom statuses](#away-and-custom-statuses) |
| Links you ask a **link preview** for (and that it was you, and when) | Yes: the server fetches the page for you. The preview itself then travels inside the encrypted message. See [Link previews](#link-previews) |
| **Scheduled messages** (Send later) | **No** for what they say: encrypted on your device like any message. Yes for where each is going, when it's due, when and from which session you wrote or changed it and how big it is, before it's sent. See [Send later](#send-later-scheduled-messages) |
| Messages sent before the encryption upgrade | Yes, with `data/secret.key` (shown in the app as "Older message — not end-to-end encrypted, sender not verified"; plaintext messages dated after encryption was switched on are hidden) |

### How it works

| Part | What's used |
|---|---|
| Your password | Never sent anywhere. Hardened in the browser with **Argon2id** (64 MiB memory, 3 passes, random salt). One half logs you in; the other unlocks your private keys. Older accounts are upgraded from PBKDF2 automatically at their next login. |
| Your identity key | **ECDH P-256** key pair. The private half is stored on the server only after being locked (AES-256-GCM) with your password-derived key. |
| Your signing key | **ECDSA P-256**. Signs channel messages, key handoffs and voice handshakes so nobody can impersonate you. |
| Each message | **AES-256-GCM** with its own key, derived by **HKDF-SHA256** from the conversation key and a random 256-bit salt. The channel or DM, the author and the key version are bound in, so the server can't change a message's content, move it to another conversation or change who sent it. Inside it also go its own id, what it replies to, its thread, when it was sent and how many times it was edited, so apps flag a message the server replays, moves under another reply or thread, re-dates or serves from before an edit (see [Moved, repeated or rolled back messages](#moved-repeated-or-rolled-back-messages)). |
| Each attachment | Its own random AES-256-GCM key, carried inside the encrypted message. The app only accepts attachments stored on this server. |
| Message length | Padded before encrypting (to 256-byte steps, 1 KiB steps above 4 KiB), so the server can't tell "ok" from a sentence. File sizes are not padded: the server sees how big each file is. |
| Sign-in sessions | The database stores only a SHA-256 hash of each session token, so a copy of the database can't be used to sign in as anyone. |
| Recovery key | 160 random bits, shown once. Locks a second copy of your private key (HKDF-SHA256 + AES-256-GCM, its own salt). The server never sees it. |
| Two-factor | Standard authenticator codes (RFC 6238). A code can't be used twice, guesses are rate-limited, backup codes are stored hashed. |
| DMs | Conversation key from ECDH between the two of you. DMs aren't signed, so they stay deniable (like Signal). |
| Server channels | A random 256-bit **group key** per server, sent to each member encrypted to their identity key (ECIES) and signed by whoever shared it. Each app keeps its own copy of every key it receives, so history doesn't depend on whoever shared it. When anyone leaves or is removed, a new key is created automatically and given only to the remaining members, so former members can't read anything new. New members can read from the key that was current when they joined; older messages stay locked to the people who were there. A server can also keep everything from before someone joined away from them ([below](#new-members-cant-read-messages-from-before-they-joined)). Someone who was a member before with the same account (left, kicked, banned) and comes back gets a new key, even after resetting their password, so they can't read what was said while they were away. A different account using an invite someone kept still gets the current key like any new member, so revoke invites after removing someone. **Replace key now** works for members once the key is 10 minutes old (at most 12 new keys an hour per server); members with Manage Server can use it any time (30 an hour). A new key the others can't open is replaced once two members (or one with Manage Server) report it, which their apps do by themselves. The encryption dialog shows who made the current key. |

### Verifying people

Your browser remembers everyone's keys the first time it sees them. If the server ever hands out different keys for someone (the classic way to secretly listen in), you'll see **Security key changed**, sending to them pauses, and key sharing with them stops until you check. Someone who reset their password without their recovery key has a shield next to their name (**Not verified**) in each server and group until a member there who knew them before verifies them; nobody's app shares that server's or group's key with them until then. To verify someone, open a DM, click **End-to-end encrypted**, and compare the 60-digit safety number with them in person or on a call. Safety numbers cover people's current keys. Messages written with an older key are labelled: **"Written with an older key"** (a key this device trusted back then), or **"⚠ Older key — not verified"** (a key the server says they had before a password reset, which this device never confirmed, so the server could have written it). Server encryption details (key version, who made it, who holds it, "Replace key now") are under the **End-to-end encrypted** badge in any channel.

### Moved, repeated or rolled back messages

Every message your app sends carries, inside its encryption, a random id of its own, the message it replies to, the thread it's in, when it was sent and how many times it was edited. Everyone's apps compare that with what the server says, and when they don't match the message gets one small yellow flag: **⚠ The server may have moved, repeated or rolled back this message**. Hover over it or click it to see which check failed:

- **a different reply or thread** than its sender wrote it in: shown as a reply to another message, or as no reply while the original is still there (your app asks the server about an original it hasn't loaded), or a thread reply shown outside its thread (Hearth deletes a thread's replies with its first message, so that never happens by itself);
- **a time more than 10 minutes off** from when it was sent. A scheduled message may go out up to a day late (if the server was down, or slow mode held it), never early. The time inside it is the one you picked, or the moment you pressed **Send now**: your app never takes a time from the server, so re-encrypting one by itself (after a key change) keeps your time, and one the server has down for earlier than you picked waits for you;
- **the same message more than once** in the conversation, under different ids;
- **an older version** than one your device has already shown (each device remembers the latest edit it saw of up to 2,000 edited messages; when that's full, the author with the most entries loses their oldest, so one account editing a flood of messages pushes out its own).

What happens normally is never flagged: a reply to a message that was deleted, or disappeared, before the reply went out just says **Original message is no longer available**, and editing, forwarding (a forward is a new message) and scheduling are all fine. The words themselves are always the sender's; this is about where and when the server shows them. Limits: messages from apps before this version, bots, webhooks and the news bot carry none of this and are never flagged; the checks run on each device, so a device that never saw an edit can't tell it was rolled back (and a server with very many accounts could wear down what a device remembers), and two copies are only spotted while both are loaded; the server can still hold a message back, or make a reply read as orphaned by denying its original everywhere (to your app's question too); and message times rely on the clock correction your app gets from the server when it starts (as disappearing messages do), at most a day either way: a device whose own clock is off by more than that is told so, since the times inside its messages would be off too. A scheduled message carries a mark saying it was scheduled, so everyone's apps can tell, and when it was due. Direct messages from the very first version of Hearth (which bound nothing in) say **Older encryption format**.

### New members can't read messages from before they joined

Off by default, for new servers and existing ones alike: with it on, every join makes everyone's apps switch keys, and newcomers wait a moment for theirs, while many communities want newcomers to read back. Turn it on in **Server settings → Overview → Privacy** (needs Manage Server). With it on:

- **Each join switches keys.** Before the next message goes out, the members' apps make a new server key, and the newcomer only ever gets keys from then on: never the one in use when they joined, nor an older one (not even their own from an earlier membership, if they're coming back).
- **Nothing from before is sent to them.** Messages and thread replies, threads, pins and pin history, search results, saved messages, unread and ping counts, exports, quotes of older messages in replies, changes to the disappearing-messages timer, and edits, reactions or pins on older messages as they happen. A thread started before they joined stays closed to them, replies written since included. If they become a moderator, reports filed before they joined still reach them, but without the messages from before. Where the history starts, their app shows one line, *Messages from before you joined are hidden in this server*, instead of rows of messages they could never open. Voice channels' chats work the same way.
- **Everyone already there keeps everything.** Turning it on switches keys once, right away, so what's been said so far is under a key that's never handed out again.
- **Joins close together share one new key**, and a flood of joins can't keep everyone switching: a join waits until the current key is a minute old for each key made in the last hour (so at worst about one switch every eight minutes under a steady flood). Chat carries on meanwhile, the newcomer's app says their key is on its way, and what's said in that short wait is left out for them too.
- **Turning it off** lets people who join later read back as before. Whoever joined while it was on keeps their own starting point (they never got the older keys).
- Changes are in the server's audit log, and limited to 10 an hour per person (so nobody can use up everyone's changes and leave it off). Group chats don't have it: anyone in a group can add people.

Like the rest of the key handling, it's the server that decides when keys change and who gets which ([SECURITY.md](SECURITY.md) §4: a malicious server can hold back a key change or give the key to someone it adds). So this keeps the history from newcomers as long as the server is honest, like private channels do.

### Things to know

- **What syncs and what stays on this device:** saved messages, notification settings (per server, channel and DM, mute timers, quiet hours), read positions and server folders follow your account to every device. Layout, favorites and collapsed categories are kept per device, in that browser or app.
- **Forgot your password?** Add an email (Settings → My Account → Email) and the sign-in screen's **Forgot your password?** link emails you a reset link (good for 30 minutes, one use; it stops working if the password or the email address changes first). Your password is what unlocks your keys, so what you keep depends on the **recovery key**:
  - **With your recovery key** (Settings → My Account → Recovery key, shown once — write it down): you keep everything, including all old messages.
  - **Without it:** you get your account, name, friends and servers back, but with new keys. You can't read your old encrypted messages any more (the people you talked to still can), and friends see "Security key changed" on you. Since anyone who got into your email could do this, your servers and group chats show you as **not verified**: nobody's app shares a server's or group's keys with you, and you can't make invites there or add people to it, until someone in it who was in a server or group with you before compares safety numbers with you and presses **Numbers match — verify and share keys** (the shield next to your name). Their word counts in the servers and groups they're in themselves. Once every server and group you were in before has had someone do that, or an instance admin does it in Admin → Users (with their password and, if it's on, a fresh two-factor code; logged), you're verified everywhere; until then you can't start group chats or give out staff roles. Your app's **Ask a member to verify you** lists the people who can. Members' apps then share the current keys with you again, so you can read what's said from those keys on. Invite links you made before the reset keep working. An account that shares no server or group with anyone isn't held back, and resets before 1.29.0 weren't marked.
  - That's also what someone who gets into your email can do if two-factor is off: they get the account with new keys. They don't get a server's or group's key unless a member of it is fooled into verifying them (a second account of theirs in one of your public servers can only open that server, which it reads anyway), but people whose device never saw your old key would still send them new direct messages. Turn on two-factor sign-in.
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
- **Disappearing messages are deleted by the server** (see [Disappearing messages](#disappearing-messages)): backups
  made before a message's time keep it until they rotate out, and anyone can screenshot or copy what they see.
- **Other sites can see your IP address** when you open a picture link to another site in a message, play a video file from another site in watch together, or watch through the YouTube, Vimeo and Twitch players. Picture links wait for a click by default, wherever a message shows (channels, a voice channel's chat, DMs, group chats and threads): they show the site's name and a **Load image** button (Settings → Privacy & safety → **Outside images**: *Ask first*, *Always load* or *Never load*; the choice follows you to your other devices). A picture link to your own Hearth server shows only if it's a file uploaded there; any other address on the server stays a plain link, since some of them would have the server fetch a site the sender picked for everyone who reads the message. A watch-together video file from another site says that site will see your IP address and loads only when you click **Load video**. The app's fonts are served by your Hearth server, so opening the app contacts no font host. GIFs (with the server's GIF proxy on), news pictures and game and music art go through the server instead. Link preview cards load nothing at all: their picture is inside the message (so it disappears with a disappearing message, too).
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

**Disappearing messages** are in every backup made before their time, until that backup is pruned (an upgrade
copy, `hearth-before-v*.db`, once it's no longer among the newest `PRE_UPGRADE_KEEP`; off-site copies when
deleted by hand). Restoring an older backup deletes the ones whose time has passed at the first start, before anyone
can connect.

**Database copies** (`data/backups/*.db`) are for undoing an update on this machine. They're as sensitive as the database itself, so they never leave the server and can't be downloaded. Copies made before upgrades (`hearth-before-v*.db`) are pruned after each upgrade that goes through: the newest `PRE_UPGRADE_KEEP` (3 by default) stay, the one that upgrade made always stays, and only files with exactly that name pattern are ever removed (rename a copy to keep it for good; `PRE_UPGRADE_KEEP=0` keeps them all). Like the database itself they aren't encrypted, so remove ones you don't need.

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
| `PUSH_ALLOW_PRIVATE` | off | `1` allows push endpoints on private/LAN addresses (tests only; for one push service on your network use `PUSH_PRIVATE_HOSTS`) |
| `PUSH_HOSTS` | any public host | Comma-separated push service hosts the server will subscribe and send to: exact names or `*.suffix` (e.g. `fcm.googleapis.com,*.push.services.mozilla.com,*.notify.windows.com,web.push.apple.com,ntfy.sh`) |
| `PUSH_PRIVATE_HOSTS` | — | Push services on your own network that may have private addresses (a self-hosted ntfy): exact names, port 443 unless given (`ntfy.lan:8443`) |
| `PUSH_NTFY_URL` | — | Your own ntfy (`https://…` only): the Android app's settings tell people to use it |
| `ANDROID_CERT_SHA256` | — | SHA-256 fingerprint(s) of the key the Android app is signed with: lets an app built for this server open `https://…/invite/…` links (served as `/.well-known/assetlinks.json`) |
| `ANDROID_PACKAGE` | `app.hearth.mobile` | The Android app's package name, for the same file |
| `WEBHOOK_AVATAR_HOSTS` | — | Comma-separated hosts (or `host:port`; `*.example.com` for every name under it) whose pictures webhook posts may use as their avatar, on top of Discord's, GitHub's and Gravatar's. These may be on your own network |
| `OUTBOUND_BLOCK` | — | Comma-separated addresses or ranges (CIDR) that feeds, pictures, link previews and push may never reach, on any port. For example this server's public IP when it's behind NAT, or your router's |
| `LINK_PREVIEWS` | `true` | `false` starts with link previews switched off (the owner can switch them in Admin → Owner → Features) |
| `LINK_PREVIEW_ACCEPT_LANGUAGE` | `en` | The language sites are asked for when this server fetches a page for a preview (the same for everyone, so it doesn't single anyone out) |
| `DATA_DIR` | `./data` | Where data lives |
| `VAPID_SUBJECT` | your `PUBLIC_URL`, else `mailto:admin@example.com` | Contact address for push services — set your real email. Apple devices (iPhone, iPad, Mac) need a real one |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto | Push keys (default: generated into `data/vapid.json`) |
| `DOWNLOADS_DIR` | `data/downloads` | Installers offered on `/download` |
| `DESKTOP_DOWNLOAD_URL` | — | Link `/download` to your GitHub releases page instead |
| `AT_REST_KEY` | — | 64-hex-char key instead of `data/secret.key` (for pre-upgrade messages) |
| `PRE_UPGRADE_KEEP` | `3` | How many `data/backups/hearth-before-v*.db` copies (made before each database upgrade) to keep; older ones are removed after an upgrade goes through, never the one it just made. `0` keeps every copy |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | — | Email for password resets (or set it in Admin → Owner → Email) |
| `PUBLIC_URL` | — | This server's public address, used in reset links |
| `SESSION_IDLE_DAYS` / `SESSION_MAX_DAYS` | `60` / `365` | A device is signed out after this many days unused / after this many days in total |
| `API_RATE_LIMIT` | `1200` | Requests a minute one signed-in account can make in all (the sensitive routes have tighter limits of their own); `0` turns it off |
| `BACKUP_KEY` | `data/backup.key` | 64 hex characters: the key encrypted backups use (made automatically if not set) |
| `BACKUP_RCLONE_REMOTE` | — | Copy every encrypted backup off-site with rclone, e.g. `b2:my-bucket/hearth` |
| `DISAPPEAR_SWEEP_MS` | `60000` | How often the safety sweep deletes disappearing messages whose time has passed (each one is also deleted at its own time by a precise timer) |
| `DISAPPEAR_CHECKPOINT_MS` | `600000` | The shortest gap between resets of the database's write-ahead log after a sweep that deleted something (so deleted messages' bytes don't linger there) |
| `ALERT_PRIVATE_HOSTS` | — | Alert channels (ntfy, webhooks) on your own network that may have private addresses, and may use plain `http`: exact names or addresses, on the default port unless given (`ntfy.lan:8080`). Nothing else private is reachable |
| `ALERT_CHANNEL_TIMEOUT_MS` | `8000` | How long one delivery to an alert channel may take |
| `METRICS_TOKEN` | — (off) | Turns on `GET /metrics` (Prometheus text) for scrapers that send `Authorization: Bearer <token>`. At least 16 characters (`openssl rand -hex 32`); shorter keeps it off |
| `HEARTH_BIND` | all interfaces | Docker only: the address port 3000 listens on. Set `127.0.0.1` behind Caddy |

---

## Keyboard shortcuts

- **Ctrl/⌘ + /** shows all of these in the app (also Settings → Keybinds → See all shortcuts, or the menu on your name)
- **Ctrl/⌘ + K** search anything
- **Enter** send, **Shift+Enter** new line (switchable to Ctrl+Enter in Settings → Chat)
- **@** then a name to mention someone, **#** then a name to link a channel, **:** then a name for an emoji; **↑/↓** and **Enter** to pick
- **↑** in an empty message box edits your last message, **Esc** cancels editing, a reply, or closes a thread
- **Alt + ↑/↓** move between channels or conversations in the sidebar
- **Shift + Esc** marks the server you're in as read
- **Ctrl + Shift + M** mute, **Ctrl + Shift + D** deafen (change them in Settings → Keybinds)
- In the image viewer: **←/→** previous/next, **+/−** zoom, **Esc** close
- Right-click messages, channels, servers and people for more actions

## Not included (yet)

App Store / Play Store listings, screen sharing in the Android app, a full-screen incoming-call screen on Android, separate encryption keys per private channel, and encrypted reactions.

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
  can't be deleted while the membership is on sale or held. A role members can pick themselves can't be sold. Nothing that's free changes: memberships only add what
  a creator chooses to offer.

## News bot

In a server's **Server Settings → News bot** (needs Manage Server), follow a topic (Google News), a YouTube channel, a subreddit, a Steam game's news, a GitHub project's releases, or any RSS/Atom feed, and pick the channel to post in. Press **Preview** to see what it would find. When you follow something, the bot posts the newest item right away so you can see it working; after that it posts only new things — never a backlog of old news — at most 3 at a time, checking every 10 minutes. The bot shows as online in the member list of servers it posts in. Add keywords to post only matching items (for example `patch, update`). Bot posts show a **BOT** tag and a card with the picture, which loads through your server so readers' IPs aren't shared. The server signs a link for each picture when it sends the post to someone's app, and the picture proxy fetches nothing else. Previews show no pictures. The pictures are whatever the feed names, so anyone who follows a feed they wrote themselves still chooses which public pictures your server fetches, a few at a time.

Bot posts come from public feeds, so they aren't end-to-end encrypted (the server writes them). The bot can't sign in and can't read your encrypted messages. The server needs outgoing internet access to the sites you follow.

## Link previews

Paste or type an https link and the composer offers a small card for it: **Preview news.example.org?** Press **Preview** and the card (the page's title, a line of description, the site's name and a small picture) appears above the box, with an **×** to take it off. Send, and the card goes **inside the encrypted message**. People reading it see the card without their app contacting the linked site, or this server, for it: the picture is a small copy (at most 400 px, 16 KB) that the sender's app made and put in the message. Readers' apps also check the card belongs to a link really in the message, and always show the link's real domain under it, so a card can't hide where a link goes.

What to know:

- **Your Hearth server sees the links you preview, and that it was you.** Your browser can't fetch other sites itself, so the server fetches the page for you (and the site sees the server, not you). It can tell which conversation it was for from the encrypted message you send just after. It keeps the answer in memory for up to 10 minutes, for you only, and never writes the link to its log or disk. Links you don't preview stay private as always.
- **Settings → Chat → Link previews:** *Ask each time* (the default: nothing leaves your device until you press Preview), *Always* (every link you type is fetched, except ones that look like sign-in, reset, invite or share links, which still ask), or *Never*. **Show link previews in messages** turns cards from others off on your device.
- YouTube links use YouTube's own title and thumbnail service (the video page itself isn't fetched); X/Twitter post links use X's embed service for the text, when it answers. GitHub, news sites, shops and most other sites work through the usual OpenGraph tags.
- Only `https` links on the usual port, with a real host name, get a preview. Links inside `code` or `||spoilers||`, image links (they show as pictures already, after a click for a picture on another site) and links to this server don't. Editing a message keeps a preview whose link is still there; a link added in an edit gets none.
- Server roles: **Show link previews** (on by default) decides whose cards show; members' apps enforce it, since the server can't see inside messages. It counts as a role permission: a channel override can turn previews off in that channel, but not on. Owners can switch previews off for everyone in **Admin → Owner → Features → Link previews**: the server then fetches nothing (cards already sent still show).
- Limits: 20 previews a minute per person, 2 at once, 60 a minute from one network, 100 fetches an hour per person; a page is read up to 512 KB and its picture up to 2 MB, all within 10 seconds. Older apps that don't know about previews just show the link.

Details: [docs/design/LINK-PREVIEWS.md](docs/design/LINK-PREVIEWS.md) and [docs/FEATURES.md](docs/FEATURES.md#link-previews).

## Away and custom statuses

- **Away by itself:** when you haven't used Hearth for a while, people see you as **Away** (the moon), and as
  **Online** again the moment you're back. Pick how long in **Settings → Privacy & safety → Show me as Away after**:
  5, 10 (the default), 15 or 30 minutes, or **Never**. It follows your account, so all your devices use the same time.
- **What counts as using it:** in a browser, a key, click, scroll or touch in the Hearth tab (the Study page
  included), or coming back to it. In the desktop app, anything you do on your computer, so playing a game with
  Hearth in the background doesn't make you Away. Being in a call always counts, so you aren't Away while you watch a shared
  screen without touching anything. With Hearth open on several devices (or tabs), you're Away only once none of
  them is in use.
- **Your choice wins:** it only ever changes **Online**. Do Not Disturb, Invisible and Away picked by hand stay as
  they are, and while you use one of them your apps don't report anything. Your own status dot shows when you're
  Away by yourself, and the status menu says why.
- **A custom status that clears itself:** in the status menu → **Set a custom status**, pick **Clear after**:
  30 minutes, 1 hour, 4 hours, Today, This week or Don't clear. "Today" and "This week" follow your own time zone
  (the week starts on the day your browser's language says). The server clears it when it's due and everyone sees
  it go right away; until then, only you see when it clears. A status set in Settings → Profile stays until you
  clear it, and saving your profile keeps the time of one you set from the menu.
- **What the server sees, and who else does:** only whether each of your open apps is in use or idle (never what you
  typed or clicked), and how long a status should last. Your apps say so as it happens, so the switch to Away and
  back shows *when* you stopped and started using Hearth (in the desktop app, your computer): to within about a
  quarter of a minute plus your Away time when you stop, and to the second when you're back. Like Online, Away isn't
  end-to-end encrypted, and presence (Online, Away, Do Not Disturb, Offline) is sent to everyone signed in on this
  Hearth, including people who share no server with you and people you've blocked. Set **Never** (or Invisible)
  if you'd rather not show it.
- **Limits:** 15 status changes a minute and 120 an hour per account (Online/Away/Do Not Disturb/Invisible, the Away
  time and custom statuses together). Each app's idle reports, 20 changes a minute per account. A custom status is up
  to 128 characters (one line) with one emoji, and can clear itself from 1 minute to a week from now.

## Send later (scheduled messages)

Write a message, then press the **clock** next to the send button (or right-click the send button) and pick a time:
in 1 hour, in 3 hours, this evening, tomorrow morning, Monday morning, or **Pick a date and time…** (up to 30 days
ahead). Works in server channels (voice channels' chats too), threads, group chats and DMs, with files and link
previews. At that time it's posted as if you sent it then: everyone gets it live, with notifications and @mentions
as usual.

- **Still end-to-end encrypted.** Your app encrypts the message the moment you schedule it, exactly as it would to
  send it now (same format, key and signature); your Hearth server keeps that ciphertext and posts it at the time.
  It never gets the words. It does know where it's going, when, and how big it is, ahead of time. Your app also
  keeps its own copy there, locked with a key only your account's keys make, which is what your list shows and the
  only thing your app ever re-encrypts (see below).
- **Disappearing messages:** in a conversation with a timer, it's encrypted for the timer in force when you schedule
  it, and it disappears that long after it's **posted** (not after you scheduled it), or sooner if the conversation's
  timer is shorter by then. It keeps that timer when your app re-encrypts it (after an edit or a key change), even if
  the conversation's timer was turned off or made longer meanwhile. The list shows "Disappears after …" on each one
  like that.
- **It doesn't mark anything read for you.** When it goes out you may well be away, so @mentions and messages that
  arrived in that conversation meanwhile stay unread (unlike a message you send yourself).
- **Your list:** a bar above the message box says what's scheduled in that conversation (also in the ⋯ menu →
  **Scheduled messages**). From there you can **Edit** the words, **Reschedule**, **Send now** or **Cancel**. Up to
  25 scheduled messages at a time. The time it goes out is inside the encryption too (readers' apps flag one the
  server posts early, or more than a day late), so Reschedule and Send now re-encrypt it on your device. Only you
  change that time: when your app re-encrypts one by itself, it keeps the time you picked, never one the server
  gives it, and if the server has it down for earlier than you picked, the list says so and it waits for you.
- **If it can't go out at its time** (you were timed out, removed or banned, lost permission to post there, the
  channel, thread or DM is gone, they blocked you or deleted their account), it isn't sent: it shows as **Not sent**
  with the reason, and you're told (in the app, or by push if it's closed). Slow mode only delays it. One that came
  due more than a day ago while the server was down isn't posted that late either.
- **If the conversation's key changes first** (someone left the server, or the person you're writing to reset their
  password without their recovery key), the stored message would be locked with the old key, which newer members
  can't open (and a removed member could). So the server **holds** it instead, and your app re-encrypts it with the
  new key the next time it's open, by itself if the time is still ahead (or passed less than 10 minutes ago); for a
  DM, once you've checked their new safety number. Later than that it asks you first (**Send now** or a new time),
  and saving an edit of one asks too. If **your own** keys changed (a password reset without your recovery key), the
  old message can't be re-encrypted any more: it shows as not sent, so write it again.
- **Signed out means stopped.** If the device or session that scheduled a message is signed out before it goes (you
  log out there, sign it out in Settings → Signed-in devices or with **Log out all other devices**, or change or reset your
  password), the message waits for you: open the list on a device that's still signed in and choose **Keep** (or
  Send now, Edit, Reschedule, Cancel). So signing out a stolen session also stops what it queued. (The device you
  make the change on keeps its sign-in with a new token, so what it scheduled goes out as planned.)
- **Only what you scheduled.** Your app re-encrypts a scheduled message only from its own copy, never from what the
  server hands back. A message in your list that your app can't confirm you wrote (it wasn't scheduled by one of
  your signed-in apps) says so and can only be cancelled: neither the server nor someone with a stolen session can
  get your app to re-sign their words, or an old message of yours, under your name.
- **Honest limits:** the server is trusted to keep the time and to really delete a message you cancel (it holds a
  valid encrypted message, and your app's copy, until then: a dishonest server could bring back one you cancelled,
  into the same conversation). The time it should go is inside the message, so readers' apps flag one posted early
  or more than a day late, but within that day the server can still hold it back. That also means everyone's apps
  can tell the message was scheduled, and when it was due (it's marked inside, for that day of leeway). Holding a
  signed-out session's messages is done by the server too. Server backups taken meanwhile keep a copy until they
  rotate out, as for any message.

Details: [docs/FEATURES.md](docs/FEATURES.md#scheduled-messages-send-later).

## Search (Ctrl+K)

**Search (Ctrl+K).** Messages are end-to-end encrypted, so search runs on your device: the app fetches messages page by page, decrypts them, and matches your words there. Each click checks up to 1,000 messages, newest first; **Search further back** continues. Filters: `from:@username`, `from:me`, `in:#channel`, `in:@username`, `before:` / `after:` / `during:` a date (`2025-05-31`), month or year, `has:file` / `has:image` / `has:link`, `is:edited` / `is:pinned`, `"exact phrase"`; several words must all appear. Recent searches stay in this browser and can be turned off.

The server never receives the words, phrases or `has:`/`is:` filters. It sees that you searched, when, where (a channel, DM, server or everything), whose messages and which dates, and how far back you went. Details: [SECURITY.md](SECURITY.md) row 69.

## Never lose your place

- **Unread badges and a "New messages" line** that follow you across devices, **Jump to first unread**, Mark as
  read/unread, and **drafts** that survive reloads (kept only on your device). Signing out removes drafts, the inbox
  and reminders from the browser.
- **Threads you won't miss:** a message that starts a thread shows how many replies are new to you ("3 replies · 2
  new", red with @ when one pings you), and a "New replies" line marks where you stopped. The **Threads** button in
  a channel's header lists its threads, the most recent reply first, with what's new in each; it carries a count when
  someone @mentions you or replies to you in one. Each thread is read on its own: reading the channel doesn't mark its
  threads read, opening (or replying in) a thread does, on all your devices. A ping in a thread counts in the channel's
  badge until you open that thread. **Mark as read** in the channel's or server's menu clears its threads too (the
  one on the "new messages" bar marks only the channel's own messages).
- **Saved messages** synced to all your devices, with private notes only you can read.
- **Notifications your way:** all, mentions only or nothing per server, channel and DM; mute for a while; ignore
  @everyone; quiet hours on a schedule. Push follows these too, and lock screens just say "New message" unless you
  choose otherwise.
- **Export my data** (Settings → Privacy & safety, needs your password): a zip of your account and every message you
  can read, decrypted on your device.
- **Moderation:** slow mode, timeouts (members can read but not post or talk; a timed-out moderator also can't use the
  moderator toolkit until it ends), pin history, bulk delete, ban with
  message cleanup, and voice disconnect, move and server mute (see [Roles, permissions and server
  customization](#roles-permissions-and-server-customization)). Pinning in a server channel needs Manage Messages.
  See `docs/FEATURES.md`.

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

### Webhooks (Uptime Kuma, Grafana, Home Assistant, GitHub…)

Anything that can post to a **Discord webhook URL** can post to a Hearth channel instead: right-click a text channel
→ **Webhooks** (needs Manage Channels, or Manage Server, plus being able to send messages there), make one, and paste
its address where the program asks for a Discord webhook. Discord-style posts (text, a display name, embeds with fields, footers and colours) and Slack-style
posts work as they are; add `/slack` to the address for Slack tools, or `/github` for a GitHub repository's webhook.
Embeds are turned into text with a coloured dot (🔴 down, 🟢 up…).

- The address is the password: it's shown once (Hearth keeps only a hash), and **New address** replaces a leaked one.
- Posts come from the webhook's bot, marked **"Webhook · not end-to-end encrypted"** (they come from outside, so the
  server stores them sealed with its own key, like other bot posts). Everything people write stays end-to-end
  encrypted.
- They **don't ping anyone** unless you allow it: `@everyone`, `@here`, roles and names show as plain text. Only
  someone who may mention @everyone in that channel can turn pings on. People who chose **All messages** for the
  channel get push notifications for webhook posts either way.
- A webhook **pauses** while the person who made its address is suspended, banned from the server or timed out (they
  still know the address), and while its own account is suspended. A **New address** from another manager makes it
  theirs and starts it again. Managers can only change webhooks whose address was made by someone below their
  highest role (or by themselves).
- Limits like Discord's (5 posts per 2 seconds per webhook, 30 a minute per channel). Nothing is fetched when a post
  arrives. A post's own avatar (`avatar_url`) is shown only if it's on Discord's, GitHub's or Gravatar's picture
  hosts, or a host you list in `WEBHOOK_AVATAR_HOSTS`; it loads through this server's avatar proxy (images only,
  by a link the server signs for that avatar) when people view the post. Any other avatar shows the webhook's own
  picture, so a webhook can't make your server fetch pictures from anywhere.

Details, every field that's understood and the error codes: `docs/BOTS.md` ("Incoming webhooks").

## Monitoring and troubleshooting

Hearth logs one JSON line per event (set `LOG_FORMAT=pretty` for readable lines). Secrets, tokens and message content
are never logged, and IP addresses are cut to their network (`LOG_FULL_IP=true` keeps them). Every response carries an
`X-Request-Id` to search the log by.

- `GET /api/health/live`: the process is up (use it for Docker/systemd health checks).
- `GET /api/health/ready`: ready for people (database, data folder, schema, maintenance, disk). `200` or `503`.
- Admin → **Health**: background jobs, the news bot, relays, backups and restore tests, disk, responsiveness, and
  alerts to the owner by email.
- **Where alerts go** (Admin → Health): besides the email, alerts can go to ntfy (ntfy.sh or your own, with an access
  token), a webhook signed like the bots' (HMAC-SHA256), or a Discord or Slack webhook. Each has a Test button and
  shows its last delivery. Addresses and tokens are kept encrypted and only ever shown masked. Any admin can add one;
  turning one off, changing where it points or removing it needs the password again (that's how someone would hide
  alerts), and so does a cooldown longer than an hour. Channels that keep failing raise one alert between them, so
  they never hold back real ones. They must be public `https` addresses unless `ALERT_PRIVATE_HOSTS` names the host
  (a self-hosted ntfy on your network).
- `GET /metrics`: numbers for Prometheus (uptime, event-loop lag, memory, requests by status class, sockets, jobs,
  backup age, disk, account and message totals), nothing about anyone. Off unless `METRICS_TOKEN` is set; scrapers
  send `Authorization: Bearer <token>`.
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

## Events and repeating events

Open **Events** at the top of a server's channel list → **Plan an event**. Anyone who can send messages in the server can plan one; the person who made it, and people with Manage Server or Manage Channels, can change or delete it.

- **Repeats:** *Does not repeat*, *Every week*, *Every 2 weeks* or *Every month* (on the same day of the month; an event on the 29th–31st falls on the last day of shorter months, then goes back to its day). **Ends:** never, on a date (that day is included), or after a number of times (counting the first one, up to 500). A repeating event can last up to 6 days, so one time always ends before the next starts, even in a week when the clocks go forward.
- **One event, always the next time.** When a time ends, the event moves on to the next one: its start and end move, the 15-minute reminder is armed again, and **everyone answers again**. A "going" for this week isn't a "going" for next week, and reminders only go to people who said going or maybe, so old answers would remind people who weren't planning to come. The person who made the event is put down as going again, as when they made it (they can change that). Home's **Coming up** and the channel list show the next time and say "Every week" and so on.
- **Same time on the clock.** A repeating event remembers the time zone of the person who planned it and stays at the same local time when the clocks change (8 pm stays 8 pm). Someone editing it from another time zone doesn't move it. Everyone in the server can see that time zone (the editor says so, and it's in the calendar file). Events made through the API without a time zone are kept in UTC and shift by an hour for people whose clocks change.
- **Changes apply to this time and every later one.** Editing or deleting a repeating event changes the whole rest of the series; there are no exceptions for single dates (to skip one, people can just answer "can't go"). Choose *Does not repeat* to stop it after the current time. If a time ends while you have the event open to edit, saving puts your other changes on the next time; a changed time or repeat setting asks you to open it again, since it was based on the time that ended.
- **Add to my calendar** downloads an .ics file with the repeat rule and the time zone, so calendar apps show every time. The zone's clock changes are written as yearly rules where they fit, and listed date by date for the next ten years where they don't (Israel, Egypt, Morocco, Chile and a few others).
- **Not end-to-end encrypted:** the server needs the times to send reminders, so it can read event titles, descriptions and places (the app says so).

## Disappearing messages

Set a timer on a DM, a group chat or a server channel, and new messages there disappear for everyone that long after
they're sent: **off, 1 hour, 1 day, 1 week or 4 weeks**.

- **Who can set it:** either person in a DM (not after one of you blocked the other), anyone in a group chat, and in
  a server people with **Manage Channels** in that channel. It's in the conversation's ⋯ menu, and for server
  channels also under Edit channel → Disappearing messages. Every change shows in the conversation ("Alice turned on
  disappearing messages: 1 week"; "You" only for your own, and anyone else's @username follows a name that isn't
  simply their username, so no name can pass for "You"), and while it's on there's a timer in the header, a note
  above the message box and a small timer on each disappearing message (hover it to see when it goes).
- **Never retroactive:** each message keeps the timer it was sent with. Changing the timer or turning it off doesn't
  change messages already sent, and editing a message doesn't move its time. A thread reply never outlives the
  message that started the thread.
- **What goes with a message:** its files (they stop loading at once), reactions, poll votes, pins and pin history,
  mention counts and everyone's saved copies. Replies quoting it say "Original message is no longer available".
  Posts by bots, webhooks and the news bot in a disappearing channel go too.
- **On your devices:** the app hides a message at its time even before the server has deleted it, and lets go of
  what it kept: the decrypted files, its notification (while the app is running, see below), inbox entries, reminders
  and search results. The timer is also inside the encrypted message, so the app hides it on time even if the server
  forgets to delete it; a dishonest server can still change a message's send time and keep it showing longer. Only
  the timers listed above count inside a message, so a modified app can't make one vanish from your screen within
  seconds, before you could report it.
- **If the timer changes while you send:** turned on or made shorter, your message goes with the new timer. Turned off
  or made longer, the app asks before sending it, since you wrote it expecting it to disappear.

**What it doesn't do — read this before relying on it:**

- **The host does the deleting.** Messages are deleted on the Hearth server, once, for everyone. Someone who runs
  or breaks into the server can skip that, change the code, or keep copies of the database. End-to-end encrypted
  messages stay unreadable to them, but anyone who later gets a member's keys could read such copies (there's no
  forward secrecy for history, see [Things to know](#things-to-know)).
- **Backups keep copies until they rotate out.** Every backup made before a message's time holds it: the daily
  encrypted backups (the newest 7 days by default), their copies on your regions (14 by default), `hearth-auto-*.db`
  copies, the newest `hearth-before-v*.db` upgrade copies (3 by default), and — until you delete them — off-site
  rclone copies and the snapshots `scripts/hearth-update.sh` keeps. Restoring an older backup brings such messages
  back only until the first sweep after start-up, which deletes everything whose time has passed.
- **Anyone can screenshot.** People can copy, forward, download, export ("Export my data" keeps them in the zip) or
  photograph what they see, and a modified app can keep everything. A report sends the reported messages' text to
  this server's staff (and, when you also show it to a server's moderators, the reported person's messages to them),
  who keep it with the report.
- **The server controls message times.** The app's deadline is the earlier of the server's and the send time plus
  the timer inside the message, but the send time comes from the server too: a dishonest server can make a message
  look newer and keep it on screen longer.
- **Notifications can stay.** The app closes a disappearing message's notification when the message goes, but only
  while it's running. On Android, a notification shown while the app was open stays after the app is closed, and so
  does one that arrived while it was closed (those never carry the message's words, only "New message" or who and
  where), until you dismiss it or open that conversation; phones and computers that keep a notification history keep
  it there too.
- **Below the database:** deleted rows are overwritten in the database file and its write-ahead log is reset after
  each sweep that deleted something (at most every 10 minutes), but SSDs, copy-on-write file systems and VPS
  snapshots can keep old blocks.
- **Metadata stays:** the server still sees who wrote when, each conversation's timer and who changed it, and when
  each message is due to disappear. In a server, the audit log also keeps who pinned, unpinned or deleted someone's
  message, whose it was, in which channel and when (never the message itself), for up to a year after the message is
  gone, and people with View Audit Log can read it.

## Word filter

Hide or blur messages with words you'd rather not see. Chats are end-to-end encrypted, so the server can't filter
them: **your app does, on your device**, and never tells the server what it hid.

- **Your own list:** Settings → **Privacy & safety** → **Word filter**. One word or phrase per line; whole words, any
  capitalization. A `*` stands for any letters inside a word: `cat*` also catches "category", `*cat` catches
  "bobcat". Chinese, Japanese and Thai entries match inside longer runs of text, since those languages don't put
  spaces between words. Accents, fancy Unicode letters (bold, circled, small capitals), look-alike letters from
  other alphabets (in either direction, without hiding ordinary Russian or Greek words), formatting (`c**at**`),
  invisible characters, letters spaced out ("c a t") and stretched letters ("caaat") don't get around it. A letter
  written just twice is read as another word ("god" doesn't catch "good", so "caat" isn't "cat"): add that spelling
  if it matters. A **Try it** box shows what a message would do before you save. Your list is end-to-end encrypted
  with your own key and synced to your devices: the server can't read it, and a device that has seen your list
  notices if the server later hands back an older copy or none (it keeps using its own and says so). It applies
  everywhere, DMs and group chats included.
- **Hide or blur:** a hidden message leaves a row "*name* · Hidden by your word filter · Show"; a blurred one shows
  like a spoiler, once you click it. Previews, notifications, search results, replies quoting it, the reply bar,
  reminders, pins and saved messages say it's hidden instead of quoting it. Your own messages are never filtered.
  Only the words are hidden: a warning about the message (a sender that couldn't be verified, or a server that may
  have moved, repeated or rolled it back) stays on its row.
- **A server's suggested list:** people with **Manage Server** can suggest one in Server settings → **Word filter**,
  hiding or blurring. It isn't secret: every member can read it (Privacy & safety → Word filter shows each server's
  list behind a click), and every member's app applies it in that server's channels and threads, unless they turn
  it off for themselves there (that choice is encrypted with their list, so the server doesn't know it either).
  Changes are in the server's audit log.
- **What it isn't:** a block. It only changes what each person sees: it doesn't stop anyone from posting those
  words, a server's list is a suggestion members can turn off, and people can always spell around a list (digits for
  letters, say). Moderation still needs moderators and reports.
- Up to 200 entries per list, 60 characters each. Checking a message is bounded, so no list can freeze the app: a
  message that would take too long to check (only possible with a list built for that) counts as a match, one click
  from showing.

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
- **Desktop updates:** sign them with your own key (`UPDATE_SIGNING_KEY` and `UPDATE_PUBLIC_KEY`, made with `node desktop/build/sign-update.js keygen`), so installed apps only take updates from you, whoever controls your server's downloads folder. This is separate from Windows code signing and works on Windows and Linux.

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
server/selfroles.js Roles members pick themselves (and what keeps them from handing out power)
server/imports.js   Import from Discord: preview and create a server from a pasted template
server/discordmap.js Discord template → Hearth roles, channels and permissions (pure, no I/O)
server/presence.js  Automatic Away, status changes, custom statuses that clear themselves
public/js/presence.js Tells the server when this app goes idle; "Clear after" times
server/nicknames.js Per-server nicknames: who may change whose, the name rules, live updates
server/joinhistory.js "New members can't read messages from before they joined": key changes on join, what's served
server/wordfilter.js Word filters: your sealed list, a server's suggested list and the rules for entries
server/alertchannels.js Where else owner alerts go: ntfy, a signed webhook, Discord, Slack
server/metrics.js   GET /metrics for Prometheus (off unless METRICS_TOKEN is set)
public/             The web app (plain JavaScript modules, no build)
public/js/e2ee.js   Encryption primitives (WebCrypto + Argon2id)
public/js/secure.js Key management: group keys, rotation, verification
public/js/binding.js Each message's own id, reply, thread, time and edit count, and the flag when they don't match
public/js/wordfilter.js Word filter matching: folding, wildcards, a bounded amount of work per message
public/js/wordfilter-app.js The word filter in the app: your sealed list, servers' lists, hiding and blurring
public/js/features.js Polls, voice messages, events, reminders
public/js/ics.js    Calendar files for events (repeat rule, time zone)
server/recurrence.js Repeating events: the next time, on the event's own clock
public/js/activity.js Games & music: playing / listening, favorite games
public/js/outside.js Pictures and videos from other sites: click to load (Privacy & safety → Outside images)
public/fonts/       The app's own fonts (served by Hearth, no font host), with their licences
server/activity.js  Game search and pictures, Last.fm, live activity
server/regions.js   Linked regions (call relays) and their install script
server/money.js     Ko-fi / Stripe webhooks, supporter time and perks
server/search.js    Message search: metadata filters only, returns ciphertext
server/netguard.js  Outbound request guard (public addresses only, pinned lookups, caps)
server/proxytrust.js Which proxies may set the visitor's address (TRUST_PROXY)
server/imagemeta.js Strips hidden metadata from public pictures (and runs audiometa.js on profile songs, in a worker of their own)
server/audiometa.js Strips tags (ID3, APE, WAV INFO, M4A iTunes and purchase boxes) from profile songs
server/mediasign.js Signed links for the news, webhook-avatar and album-art picture proxies
server/upgradecopies.js Prunes old pre-upgrade database copies (PRE_UPGRADE_KEEP)
public/sw.js        Service worker: offline app shell, updates, push notifications
scripts/            hearth-update.sh — safe server-side updater with automatic rollback;
                    make-update-zip.sh — release zip + .sha256
desktop/            Electron desktop app + build config
mobile/             Android app (Capacitor) + its native code
.github/workflows/  Builds the desktop installers on GitHub (when Hearth is its own repository)
deploy/             Caddy, coturn and systemd examples; compose.image.yml (the published image)
deploy/catalogs/    App store templates: Unraid, CasaOS, Umbrel, Dokploy, Coolify
```

MIT licensed ([LICENSE](LICENSE)).
