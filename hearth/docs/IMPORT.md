# Import from Discord

Start a new Hearth server with a Discord server's skeleton: its roles, categories, channels and channel
permissions. This is phase 1 of [design/DISCORD-IMPORT.md](design/DISCORD-IMPORT.md); custom emoji (phase 2) and
message history (phase 3) aren't built yet.

What comes over: roles (name, colour, emoji icon, "show separately", mentionable, order, permissions), categories
in their order, text and voice channels (name, topic, slowmode, order) and each channel's permissions for
@everyone and for roles.

What doesn't: members and who has which role, messages, custom emoji and stickers, the server icon, bans,
invites, bots and webhooks, events, and Discord-only settings. The preview lists every one of these that's in the
template before anything is made.

## How to

1. In Discord, open the server's settings → **Server Template** and copy the template link (it needs Manage
   Server there). If the template says it has unsynced changes, sync it first.
2. In Hearth: **Add a server** (the + in the server list) → **Import from Discord**.
3. Paste the template link. Hearth shows an address on discord.com: open it in your browser. It shows the template
   as text. Select everything (Ctrl+A), copy it and paste it into the **Template** box. In Firefox, switch to
   **Raw Data** first. You can also save that page (Ctrl+S) and choose the file instead.
4. **Preview.** You'll see:
   - what will be made, and that you'll own the server, alone, until you invite people;
   - in an orange box, anything Hearth will allow that Discord didn't (see below);
   - the roles, highest first, with their Hearth permissions and what they can't bring;
   - the channels by category, with a lock on private ones and notes on converted ones (a stage, a forum);
   - **These will be skipped**: every permission, channel, category, role and setting that won't come over, and
     why.
5. Untick any role or channel you don't want (a category's box takes all its channels). The preview is worked out
   again on the server each time.
6. **Create server.** It opens straight away, followed by a report you can copy. **Invite people** on the report
   opens a 30-day invite link with **Copy a moving announcement for Discord**, a ready-made post with the link and
   when it expires (FEATURES.md, "Invite links that unfurl"). Then give out the roles (Server settings → Roles, or
   from the member list).

Hearth never contacts Discord for this. The template link only builds the address you open yourself. Hearth
doesn't ask for, keep or pass on any Discord login or token.

You can paste the whole template, just its `serialized_source_guild` part, or a guild-shaped JSON object with real
ids (`id`, `roles` and `channels`). For that last one, @everyone is the role whose id is the guild's id, and roles
are ordered by their `position`.

## How things map

### Permissions

The rule: **where Hearth can't match Discord exactly, it errs toward less, and anything Hearth would allow beyond
what Discord did is listed before creating** (in the orange box, "Hearth will allow more than Discord did").

- A role gets a Hearth permission only if it had every Discord permission behind it.
- In a channel override, Hearth allows a permission only if Discord allowed every one behind it. It denies it if
  Discord denied any of them.
- Only per-channel permissions are kept in overrides, as when you set them by hand.
- Some Hearth permissions do more than their Discord namesake, and some exist only server-wide. Those are the
  ones that can end up allowing more; see "Allowed anyway in Hearth" below.

| Hearth | Discord |
|---|---|
| View channels | View Channels |
| Send messages | Send Messages |
| Add reactions | Add Reactions |
| Attach files | Attach Files |
| Mention @everyone and @channel | Mention @everyone, @here and All Roles |
| Manage messages | Manage Messages |
| Connect | Connect |
| Speak | Speak |
| Create invites | Create Invite (roles only: Hearth invites are for the whole server) |
| Kick members | Kick Members |
| Ban members | Ban Members |
| Manage channels | Manage Channels |
| Manage roles | Manage Roles (per channel: Manage Permissions) |
| Manage server | Manage Server |
| Manage emoji | Manage Expressions |
| Reply in threads | Send Messages in Threads **and** Create Public Threads |
| Show link previews | Embed Links (it counts server-wide in Hearth: an override can turn previews off in a channel, not on) |
| Mute members | Mute Members (roles only: a Hearth server mute holds in every voice channel) |
| Move members | Move Members |
| View audit log | View Audit Log (roles only, as in Discord: each server's own audit log) |
| Change nickname | Change Nickname (roles only, as in Discord: your own nickname in this server) |
| Manage nicknames | Manage Nicknames (roles only, as in Discord: other people's, below your highest role) |
| Administrator | Administrator |

**Covered by a broader Hearth permission.** These aren't reported as lost when the role gets the Hearth one:

| Discord | Covered by |
|---|---|
| Pin Messages | Manage messages |
| Bypass Slowmode | Manage messages, or Manage channels in that channel |
| Timeout Members | Kick members (Hearth timeouts need it) |
| Manage Events | Manage server or Manage channels |
| Manage Webhooks | Manage server or Manage channels |
| Create Expressions | Manage emoji |

The other way round, a role that gets the broader Hearth permission without the Discord one can do more in Hearth
than it could in Discord, and the preview lists it (see below).

**Only in a channel in Discord, server-wide in Hearth.** Manage Channel and Manage Permissions granted in one
channel come over as that channel's override, but Hearth only lets someone edit a channel, or its permissions,
when they also have Manage channels or Manage roles server-wide. Embed Links is the same: a channel override that
allows it comes over, but Hearth shows someone's link previews only when they have Show link previews server-wide
(readers' apps check it), so an override can turn previews off in a channel, not on. A role (or @everyone) that
had any of these only per channel is listed under "Permissions Hearth can't set per channel".

**No Hearth equivalent** (listed per role as "can't bring"): Priority Speaker, Send TTS Messages,
View Server Insights, Deafen Members, Request to Speak, Manage Threads, Create Private Threads, Use External
Stickers, View Monetization Analytics, Use Soundboard, Use External Sounds, Set Voice Channel Status and Use External
Apps. Unknown bits are listed by number. (Change Nickname and Manage Nicknames come over: Hearth has per-server
nicknames, server-wide permissions as in Discord.)

**Allowed anyway in Hearth.** The preview lists each of these, with who or which channel, before creating:

- Things Discord can withhold but Hearth has no separate permission for, when @everyone lacks one or an override
  denies one:
  - Read Message History: anyone who can see a Hearth channel can read all of it. This is the one that matters
    most.
  - Create Events: anyone who can post in a channel can make events.
  - Create Polls and Send Voice Messages: anyone who can post (and attach files) can.
  - Video, Use Voice Activity, Use Application Commands and Use Activities.
- What a Hearth permission includes that the role didn't have in Discord:
  - Kick members also times people out (Timeout Members).
  - Manage channels and Manage server also manage webhooks, which post under any name, and change or delete
    anyone's events (Manage Webhooks, Manage Events).
  - Manage messages also pins (Pin Messages), and Manage messages or Manage channels also skip slowmode
    (Bypass Slowmode).
- A channel override that took one of those away (a Pin Messages deny for a role that can manage messages
  there, say), or took away something Hearth only has server-wide: Create Invite (Hearth invites are for the
  whole server) and Mute Members (a Hearth server mute holds in every voice channel). Only where the role could
  see the channel in Discord: a channel nobody could see took nothing away.
- Overrides past Hearth's 100 per channel (or past the 300 per channel the importer reads) that held a role back.

Not in the preview, because Discord has no permission to compare it with: in Hearth, members who can Manage
messages, Kick members or Ban members also see the reports people send about this server (Server settings →
Reports, without who sent them; [FEATURES.md](FEATURES.md)).

Use External Emoji is allowed anyway too, without a warning: custom emoji from any server work everywhere in
Hearth.

An @everyone with Administrator needs its own confirmation ("everyone who joins could do anything"). An @everyone
with moderator powers (Manage anything, Manage emoji, Manage nicknames, View audit log, Kick, Ban, Mute or Move
members) gets a warning, and so does
a channel that gives @everyone Manage messages, Move members, Manage channel, Manage permissions or Mention
@everyone (a template from someone else can carry these).

### Roles

- @everyone becomes the server's @everyone role. A default Discord @everyone becomes exactly Hearth's default.
- The other roles keep Discord's order, from position 1 up. You're the owner, above all of them.
- At most 99 roles come over: with @everyone, that's a server's 100. If there are more, the lowest stay behind
  (marked "over the 100 roles"). Leaving out others makes room for them.
- Roles Discord manages itself (a bot's role, Server Booster, linked roles) are skipped.
- Names are cut to 32 characters. A role called "@everyone" or "@here" becomes "everyone (role)" or
  "here (role)".
- An emoji role icon comes over. A picture icon doesn't.

### Categories and channels

| Discord | Hearth |
|---|---|
| Text (0) | text channel |
| Announcement (5) | text channel (following it from other servers isn't something Hearth has) |
| Forum and media (15, 16) | text channel (posts and tags don't come with a template) |
| Voice (2) | voice channel |
| Stage (13) | voice channel where @everyone can't speak; roles that could speak there without being brought up in Discord can (Mute Members and Speak in that stage, after its overrides) |
| Category (4) | a category; one with no channels left is skipped |
| Threads (10–12), directory (14), anything else | skipped, by type |

- Channels without a category go first under "Text" (text ones) or last under "Voice" (voice ones), as Hearth does.
- Two categories whose names differ only in case become "General" and "general (2)", since Hearth groups
  channels by name.
- In each category, text channels come before voice ones, each in Discord's order.
- Text channel names are cleaned exactly as Hearth cleans them: lower case, spaces become dashes, and anything
  but letters a–z, digits, `-` and `_` goes. So `📢・announcements` becomes `announcements`. A name with nothing
  left (`公告`) becomes `channel-<its position>`. Voice channel names are kept as they are, up to 48 characters.
- Topics are cut to 300 characters. Slowmode (0–6 hours) comes over for text channels, and for voice channels too,
  where it applies to their chat (Hearth's voice channels have a text chat, like Discord's).
- Skipped and listed in the report: a category's own permissions (each channel keeps its own, which is what
  Discord shows anyway), permissions for single members (a template has no members), overrides for roles that
  aren't coming, age-restricted (NSFW) flags, voice user limits and forum tags.
- Server settings that are skipped and listed: verification level, explicit media filter, default notifications,
  AFK channel, system messages channel and the server icon.

## Limits and who can

- Anyone who may create servers may import one. When the instance owner sets **Who can create servers** to staff
  only, the same applies here, with the same message.
- 5 imported servers an hour per account (a refused attempt doesn't count), 30 attempts an hour, and 60 previews
  per 10 minutes, plus a ceiling per network.
- At most 500 channels, 50 categories (Hearth's limit for a server's category order) and 5,000 channel
  permissions in all, counting the ones a stage adds for its speakers (every member's app loads them all with the
  server). Over that, the preview says so and Create stays off until you leave some out. At most 99 roles (above)
  and 100 overrides per channel.
- The template is at most 2 MB (every JSON request is), and the app refuses anything over 1.5 MB before sending.
  The server reads at most 300 roles, 600 channels, 300 overrides per channel and 10,000 overrides in all, and
  nothing but the fields it knows.
- Previews and imports also have a ceiling for the whole instance: working out the plan of a very large template
  takes the server a moment (tens of milliseconds for the largest it reads), so at most 1,000 plans per 10 minutes
  are worked out, however many accounts ask. Every request with a template counts (one with none is refused before
  anything is read). It's shared: once 500 were made in a window, only accounts that have had fewer than 20 this
  window get more, so a few accounts can't use it up and lock everyone else out (that takes dozens of accounts on
  many networks every 10 minutes). The preview the app gets back leaves out each channel's overrides (it counts
  them), so ticking boxes on a big template stays quick.

## For admins

- Routes (`server/imports.js`):
  - `POST /api/imports/discord/preview` returns `{ source, plan }` and creates nothing. Its channels carry the
    number of overrides each would get, not the overrides themselves.
  - `POST /api/imports/discord` creates the server and returns it like `POST /api/servers`, plus `importId` and
    `report`.
  - `GET /api/servers/:id/imports` lists a server's imports, for the owner and Administrators only (the report
    names private channels).
- The mapping is a pure function, `server/discordmap.js`. It runs for every preview and again on create, so the app
  can't send back a plan that grants more than the template did.
- Everything is created in one database transaction, then the importer's open apps get the server live
  (`server:add`), as for a new server. Its encryption starts like any new server's: no key until the importer's
  app makes the first one.
- Each import is recorded in `server_imports` (who, when, the template code if any, and the report: counts plus
  names of what was skipped and why, never the template itself). Lists of names in the report stop at 25 with a
  count of the rest, and the stored report is at most 128 KB. `import_map` maps the template's keys to the
  roles and channels made. Both go when the server is deleted. Each import also writes one `server_import` entry
  in the instance's audit log (Admin → Audit log). The new server's own audit log starts empty, as for any new
  server: creating it isn't a moderation action.
- Tests: `test/discord-map.test.js` (the mapping, against the sample template in
  `test/fixtures/discord-template.json`) and `test/discord-import.test.js` (the routes on a real server). The
  browser flow is the last one in `test/e2e/flows.mjs`.

## Not yet (later phases)

- Fetching the template from its link on the server. Whether Discord serves templates without a login couldn't be
  confirmed, so the paste works on its own. If it's added, it must go through `server/netguard.js`.
- A small script for server owners that exports a server's structure with their own Discord bot, for when the
  template address needs a login.
- Phase 2: custom emoji and the server icon.
- Phase 3: message history from a DiscordChatExporter export, encrypted on the importer's device and labelled
  "Imported from Discord by @importer · original author not verified".
