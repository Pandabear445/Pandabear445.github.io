# Design: Import from Discord (structure, then emoji, then history)

Status: proposal for a builder agent. Target: Hearth 1.28.x (`package.json` says 1.28.2; docs/ARCHITECTURE.md still says 1.27.1), schema 18 → 19.

**Built so far:** phase 1, paste path only (`server/discordmap.js`, `server/imports.js`, `public/js/discord-import.js`; user guide in [../IMPORT.md](../IMPORT.md)). Where it differs from this design, and why:
- Hearth 1.29 has Mute Members, Move Members and View Audit Log (each server's own audit log), so Discord's map to
  them. The sample's Moderator becomes 919088, not 1584, and View Audit Log is no longer in its "can't bring" list.
- A Discord bit that a broader Hearth bit covers isn't reported as lost when the role has that bit: Pin Messages and Bypass Slowmode (Manage messages), Timeout Members (Kick), Manage Events and Manage Webhooks (Manage server or channels), Create Expressions (Manage emoji).
- Use External Emoji is allowed anyway, so it isn't "lost" either.
- Create Events is "widened": in Hearth anyone who can post makes events. So the sample's @everyone has one widened warning.
- `invite_override_dropped` became the general note `dropped:<DISCORD_BIT>`, which also covers Mute Members and other server-wide bits in overrides.
- The tables are a `// v19 (discord import)` block: schema 19 is unreleased and ships them with the rest of 1.29. `messages.import_id` waits for phase 3.
- Since then Hearth has per-server nicknames (`server/nicknames.js`): Change Nickname and Manage Nicknames map to
  Hearth's (server-wide only, as in Discord) and are no longer "can't bring". The sample's @everyone is therefore
  `1147343` (Hearth's `DEFAULT_EVERYONE`, which now has Change Nickname), not `98767`, and Change Nickname is no
  longer in its lost list. An @everyone with Manage Nicknames or View Audit Log gets the `everyone_manage` warning,
  like Kick. The rows below that say otherwise (the lost-bits list, the @everyone value, the test names and
  Appendix A) are superseded by this.
- There is no `features.discordImport` switch, since Hearth doesn't contact Discord. "Who can create servers" governs imports.
- Too many channels or categories is a `problems` entry: the preview still shows everything so people can untick, and create refuses.
- Real Discord category names win over the "Text" and "Voice" groups for uncategorised channels (those become "Text (2)").
- Names lose control and text-direction characters.
- "Never grant more" holds where Hearth can express it; where it can't, the preview lists it as widened. Besides the
  bits Hearth can't withhold, that covers what a Hearth permission bundles that the role lacked (Kick → Timeout
  Members; Manage channels or server → Manage Webhooks and Manage Events; Manage messages → Pin Messages and Bypass
  Slowmode; Manage channels in a channel → Bypass Slowmode), per-channel denies of what Hearth only has server-wide
  (Create Invite, Mute Members) or of those bundled bits, and overrides cut by a limit that denied something.
- Manage Channel, Manage Permissions or Embed Links granted in one channel to a role (or @everyone) without it
  server-wide is reported as `dropped:` (the override stays; Hearth honours it only with the server-wide
  permission, and for Embed Links readers' apps check Show link previews server-wide).
- Stage speakers: Discord lets someone speak on a stage unasked only with Mute Members there (the rule for
  unsuppressing yourself), so a role gets Speak on an imported stage only if, after that stage's own overrides, it
  has Mute Members and Speak. Not "any of Mute, Move or Manage Channels", which let Builder (Manage Channels only)
  speak, and turned an explicit Speak deny into an allow. A Speak allow for a role that isn't a speaker is removed.
- Limits added after review: 10,000 overwrites read in all (not 25,000), 5,000 overrides made in all (stage
  speakers included) as a `too_many_overrides` problem, lists of names in the report cut at 25, the stored report
  at most 128 KB, and a ceiling of 300 previews and imports per 10 minutes for the instance.
Pick #9 in `docs/NEXT.md` ("Import from Discord: structure first (template link), emoji next, history last").

Paths are relative to `hearth/`. Every code reference below was checked against the tree. External facts carry their source URLs. Facts I could **not** verify live are marked **(unverified)**: the research environment's proxy blocked `discord.com`, `docs.discord.com`, `support.discord.com` and `cdn.discordapp.com`. I read Discord's API docs from their source repository on GitHub instead.

---

## 0. TL;DR

| Phase | What | Where it runs | E2EE impact | Effort |
|---|---|---|---|---|
| 1 | Create a **new** Hearth server from a Discord server template: roles (colour, hoist, mentionable, unicode icon, position, permissions), categories, text/voice channels (topic, slowmode, position), @everyone and role channel overrides | Mapping is a pure function on the server (`server/discordmap.js`). The template comes from a server-side fetch of the template link through `netguard`, from JSON pasted by the user, or from a JSON file | None. Structure is server-visible metadata, as it is today when made by hand | M |
| 2 | Custom emoji (and the server icon) from Discord's CDN, or from image files the user uploads | Server-side fetch with a strict host and path allow-list, or the existing upload route | None. Emoji and icons are public pictures (SECURITY.md §1) | S |
| 3 | Message history from a DiscordChatExporter (DCE) JSON export | **Only on the importer's device**: parse, transform, encrypt with the server's current group key, sign as the importer, upload in batches | Ciphertext only on the server. Each message is labelled "Imported from Discord by @importer · original author not verified" | L |

---

## 1. Goals and non-goals

### Goals
1. A community moving from Discord gets its server skeleton in one step: roles, permissions, categories, channels and private-channel setup. A link or paste, a preview, then Create.
2. Be honest about what doesn't carry over. Show a per-item report **before** anything is created: dropped permissions, permissions Hearth can't restrict, renamed channels, skipped channel types.
3. Never grant more than Discord did. Where the mapping is lossy it errs toward *less* access, and every case where Hearth must allow more (a capability Hearth can't restrict) is a warning.
4. Phase 2: bring custom emoji (≤ 200, Hearth's limit) and the server icon.
5. Phase 3: bring readable channel history without weakening E2EE.
   - The server never sees plaintext.
   - History is encrypted on the importer's device under the server key.
   - It is visibly labelled as imported, with original authors not verified.
   - It never pings anyone.
   - It can be undone.

### Non-goals
- Importing into an **existing** Hearth server in phase 1. That adds role and permission-escalation questions; only new servers are created.
- Members, member↔role assignments, bans, invites, webhooks, bots and integrations, AutoMod, onboarding, scheduled events, stickers, soundboard, forum tags, voice bitrate and user limits, NSFW flags, verification levels.
- Any Discord **user token** handling. Hearth never asks for, stores or forwards a Discord token.
- A live bridge or sync. NEXT.md lists bridges as not recommended, because a bridge must decrypt.
- DM or group-DM history import.
- Re-uploading Discord **attachments** in phase 3 MVP. They are listed by name and size; actual upload is a 3b option.
- Proving original authorship. That is impossible from an export file.

---

## 2. External research (with sources)

### 2.1 The guild template API

- **Endpoint:** `GET /guilds/templates/{template.code}`. "Returns a guild template object for the given code."
  - Every *other* template route (list, create, sync, modify, delete) says "Requires the `MANAGE_GUILD` permission". Get-by-code states **no** permission requirement.
  - Source: [Discord docs, Guild Template](https://docs.discord.com/developers/resources/guild-template), read from its source [developers/resources/guild-template.mdx](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild-template.mdx).
- **Reachable without auth? (unverified).** The docs don't say "no auth" explicitly. The rate-limit page says: "If no authorization header is provided, then the limit is applied to the IP address" ([Rate Limits](https://docs.discord.com/developers/topics/rate-limits), [source](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rate-limits.mdx)). So unauthenticated calls are an anticipated case.
  - Libraries expose it as a plain fetch by code or URL: discord.js `client.fetchGuildTemplate('https://discord.new/…')`, [Client.js](https://github.com/discordjs/discord.js/blob/main/packages/discord.js/src/client/Client.js); discord.py `fetch_template(code)`, [discord.py API](https://discordpy.readthedocs.io/en/stable/api.html).
  - **Action:** verify with one `curl -A 'DiscordBot (…)' https://discord.com/api/v10/guilds/templates/<code>` before building the link path (§13, open question 1).
- **Template link forms:** discord.js recognises `discord(?:app)?\.(?:com\/template|new)\/(?<code>[\w-]{2,255})` ([GuildTemplate.js](https://github.com/discordjs/discord.js/blob/main/packages/discord.js/src/structures/GuildTemplate.js)), e.g. `https://discord.new/hgM48av5Q69A`.
- **Rate limits:**
  - No per-route number is documented, and Discord says not to hard-code limits. Parse `X-RateLimit-*` and honour `Retry-After` / `retry_after` on 429.
  - Global: 50 requests per second, applied per IP when there is no `Authorization` header.
  - **Invalid request limit:** 10,000 requests per 10 minutes per IP, counting 401, 403 and 429 responses. Exceeding it gets a temporary Cloudflare ban.
  - Source: [Rate Limits](https://docs.discord.com/developers/topics/rate-limits). Hearth must therefore cache, rate-limit itself instance-wide, and back off on 429.
- **User-Agent:** must be `DiscordBot ($url, $versionNumber)`, or Cloudflare may block the request ([Reference › User Agent](https://docs.discord.com/developers/reference), [source](https://github.com/discord/discord-api-docs/blob/main/developers/reference.mdx)).
- **Error code:** `10057 Unknown guild template` ([Opcodes and Status Codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes)).
- **API versions:** v10 and v9 are "Available"; v8 and below are deprecated ([Reference](https://docs.discord.com/developers/reference)). Use v10.

#### Shape of `serialized_source_guild`

- **Docs:** "the guild snapshot this template contains; placeholder IDs are given as integers" ([guild-template.mdx](https://github.com/discord/discord-api-docs/blob/main/developers/resources/guild-template.mdx)).
- **Example:** the official example has:
  - server-level fields `name`, `description`, `region`, `verification_level`, `default_message_notifications`, `explicit_content_filter`, `preferred_locale`, `afk_timeout`, `afk_channel_id`, `system_channel_id`, `system_channel_flags`, `icon_hash`;
  - `roles: [{ id: 0, name: "@everyone", permissions: 104324689, color: 0, hoist, mentionable }]`;
  - `channels: [{ id, type, name, position, topic, bitrate, user_limit, nsfw, rate_limit_per_user, parent_id, permission_overwrites: [] }]`.
- **Typed as the create-guild body.** discord-api-types defines `APITemplateSerializedSourceGuild extends Omit<RESTPostAPIGuildsJSONBody,'icon'>` plus `description`, `preferred_locale`, `icon_hash` ([payloads/v10/template.ts](https://github.com/discordjs/discord-api-types/blob/main/payloads/v10/template.ts)). In that body ([rest/v10/guild.ts](https://github.com/discordjs/discord-api-types/blob/main/rest/v10/guild.ts)):
  - **roles:** "the first member of the array is used to change properties of the guild's `@everyone` role". The role `id` is an integer placeholder.
  - **channels:** `id` and `parent_id` may be integer placeholders, `position` "is ignored", and "Category channels must be listed before any children".
  - **overwrites:** `RESTAPIGuildCreateOverwrite { id: number|string, type, allow, deny }`.
- **Role order (unverified):** role objects in this body have no `position`. **Inference:** array order is position order, with index 0 = @everyone. The mapper uses `position` when every role has one, and array order otherwise (§13, open question 2).
- **Permission strings:** "In API v8 and above, all permissions are serialized as strings, including the `allow` and `deny` fields in overwrites". Use BigInt ([Permissions](https://docs.discord.com/developers/topics/permissions), [source](https://github.com/discord/discord-api-docs/blob/main/developers/topics/permissions.mdx)).
  - The official template example shows a number (`104324689`). Accept both.
  - Bits go up to `1 << 52` (`BYPASS_SLOWMODE`), so plain JS `|`/`&` (32-bit) are wrong. **BigInt is mandatory.**
- **Role colours:** `color` is deprecated in favour of `colors.primary_color`. Accept both.
- **Overwrite object:** `{ id: snowflake, type: 0 (role) | 1 (member), allow: string, deny: string }` ([Channel resource](https://docs.discord.com/developers/resources/channel)).
- **What a template copies:** Discord's support article says templates copy categories, channels, roles and permissions, not members, messages or emoji ([Server Templates](https://support.discord.com/hc/en-us/articles/360041033511), seen only as a search snippet, unverified).
  - Prior art: Root's importer maps "Permission overwrites" to channel role permissions and doesn't import members ([Root docs](https://support.rootapp.com/docs/leader/community/import-discord-template), search snippet only).

### 2.2 Discord permission resolution (identical to Hearth's)

Discord applies these in order: @everyone base, then role bases ORed, then ADMINISTRATOR short-circuit, then the @everyone overwrite (deny then allow), then all role overwrites aggregated (deny then allow), then the member overwrite ([Permissions › Permission Overwrites](https://docs.discord.com/developers/topics/permissions)).

`baseFrom` and `channelFrom` in `server/perms.js` implement **the same algorithm**: @everyone override, aggregated held-role overrides, member override, and `VIEW_CHANNEL` gating. So bit-for-bit translation of overwrites keeps semantics, apart from the bits Hearth doesn't have.

### 2.3 Channel types ([Channel resource](https://docs.discord.com/developers/resources/channel))

| # | Discord | Hearth |
|---|---|---|
| 0 | GUILD_TEXT | text |
| 2 | GUILD_VOICE | voice |
| 4 | GUILD_CATEGORY | the `channels.category` string (Hearth has no category rows) |
| 5 | GUILD_ANNOUNCEMENT | text (follow and publish not supported; noted) |
| 13 | GUILD_STAGE_VOICE | voice, @everyone denied SPEAK, stage moderators allowed (NEXT.md "A basic stage: listen-only voice through the Speak permission") |
| 15 / 16 | GUILD_FORUM / GUILD_MEDIA | text (posts can come later via history import as threads; tags dropped) |
| 10 / 11 / 12 | threads | skipped (templates don't carry them) |
| 14 | GUILD_DIRECTORY | skipped |
| 1 / 3 | DM / GROUP_DM | not in guilds |

### 2.4 Discord limits

From [Opcodes and Status Codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes) and the [Channel resource](https://docs.discord.com/developers/resources/channel):
- 250 roles (30005), 500 channels (30013), 50 channels per category.
- Topic up to 1,024 characters (4,096 for forum).
- Slowmode 0–21,600 s.
- Emoji files ≤ 256 KiB ([Emoji resource](https://docs.discord.com/developers/resources/emoji)).

### 2.5 Emoji and CDN

- Custom emoji markup is `<:NAME:ID>` and `<a:NAME:ID>`. The CDN path is `https://cdn.discordapp.com/emojis/{emoji_id}.png` (PNG, JPEG, WebP or GIF; WebP recommended). Source: [Reference › Message formatting / Image formatting](https://docs.discord.com/developers/reference).
- The server icon is `icons/{guild_id}/{guild_icon}.png` on the same CDN; animated hashes start with `a_` (same page).
- Hearth's own custom emoji token is the **same syntax** (`CUSTOM_EMOJI = /<(a?):([A-Za-z0-9_]{2,32}):([a-z0-9]{6,40})>/g` in `public/js/markdown.js`). Discord snowflakes match `[a-z0-9]{6,40}`, so an unmapped Discord token just renders as `:name:` (no lookup hit).

### 2.6 DiscordChatExporter (DCE) JSON

From [JsonMessageWriter.cs](https://github.com/Tyrrrz/DiscordChatExporter/blob/master/DiscordChatExporter.Core/Exporting/JsonMessageWriter.cs):
- **Root:** `{ guild: {id,name,iconUrl}, channel: {id,type,categoryId,category,name,topic[,iconUrl]}, dateRange: {after,before}, exportedAt, messages: [...], messageCount }`.
  - `channel.category` is the *parent* channel for threads; the source comment says "'category' actually refers to the parent channel".
- **Message:** `{ id, type, timestamp, timestampEdited, callEndedTimestamp, isPinned, content, author: {id,name,discriminator,nickname,color,isBot,roles[],avatarUrl}, attachments: [{id,url,fileName,fileSizeBytes}], embeds: [...], stickers: [{id,name,format,sourceUrl}], reactions: [{emoji:{id,name,code,isAnimated,imageUrl},count,users:[...]}], mentions: [user], reference?: {type,messageId,channelId,guildId}, forwardedMessage?: {...}, interaction?: {...}, inlineEmojis: [emoji] }`.
- **`type`** is the `MessageKind` name: `Default`, `RecipientAdd`, `RecipientRemove`, `Call`, `ChannelNameChange`, `ChannelIconChange`, `ChannelPinnedMessage`, `GuildMemberJoin`, `ThreadCreated`, `Reply`, `ThreadStarterMessage`, `PollResult` ([MessageKind.cs](https://github.com/Tyrrrz/DiscordChatExporter/blob/master/DiscordChatExporter.Core/Discord/Data/MessageKind.cs)).
- **`channel.type`** is the `ChannelKind` name (`GuildTextChat`, `GuildVoiceChat`, `GuildCategory`, `GuildNews`, `GuildNewsThread`, `GuildPublicThread`, `GuildPrivateThread`, `GuildStageVoice`, `GuildDirectory`, `GuildForum`, `DirectTextChat`, `DirectGroupTextChat`) ([ChannelKind.cs](https://github.com/Tyrrrz/DiscordChatExporter/blob/master/DiscordChatExporter.Core/Discord/Data/ChannelKind.cs)).
- **Markdown formatting:** by default `content` is "plain-text formatted": custom emoji become `:name:`, user mentions `@DisplayName`, channels `#name` (plus ` [voice]`), roles `@RoleName`, timestamps formatted ([PlainTextMarkdownVisitor.cs](https://github.com/Tyrrrz/DiscordChatExporter/blob/master/DiscordChatExporter.Core/Exporting/PlainTextMarkdownVisitor.cs)). With markdown formatting off, raw `<@id>` tokens remain. The parser must handle both.
- **ToS:** DCE's README warns that "automating user accounts is against Discord TOS and may result in you getting banned" ([Readme](https://github.com/Tyrrrz/DiscordChatExporter/blob/master/Readme.md)). Its token guide links Discord's [automated user accounts article](https://support.discord.com/hc/en-us/articles/115002192352) ([Token-and-IDs.md](https://github.com/Tyrrrz/DiscordChatExporter/blob/master/.docs/Token-and-IDs.md)). Hearth's docs must recommend a **bot token** export, made by the server's admins.
- **Attachment URLs** are signed and expire (`?ex=…&is=…&hm=…`, [Reference](https://docs.discord.com/developers/reference)). They can't be fetched later, which is another reason attachments are not imported in MVP.

---

## 3. How it fits the E2EE and threat model (honest limits)

### Phase 1 (structure)
- Roles, channel names, topics, categories and overrides are already server-readable metadata (ARCHITECTURE.md §3 "Structure … none" encrypted). The import adds no new class of data.
- **Server-side link fetch:**
  - Discord learns the Hearth instance's IP, the template code and the time.
  - The request carries no user identifiers, no cookies and no token.
  - The User-Agent must **not** contain the instance's `PUBLIC_URL` (privacy). Use a fixed project URL (§13, open question 5).
- **Paste path:** Hearth never contacts Discord. The user's own browser does, when they open the API link. The owner can force this with `features.discordImport = 'paste'`.
- **SSRF:** the fetch goes through `netguard.request` (SECURITY.md row 31). Only `https://discord.com/api/v10/guilds/templates/<code>` is allowed (the `allowUrl` hook), with `maxRedirects: 0`, a 1 MB cap and a 10 s deadline.
- **Escalation:** the importer becomes the owner of a **new** server, where owners have `ALL` anyway. The import grants nothing beyond what Discord granted (§5.3). Nobody but the importer is a member at creation.

### Phase 2 (emoji and icon)
- These are public pictures, readable by anyone with the link (SECURITY.md §1 "Public pictures"). They go through the same metadata stripping (`stripFile` in `server/imagemeta.js`, as `stripUploadedImage` in `server/index.js` does) and the same quota bookkeeping (`overLimit`, `recordFile`).
- Discord's CDN sees the instance IP.

### Phase 3 (history)
- **Plaintext never leaves the device.** The DCE file is read with `File.text()` in the importer's app, transformed by a pure function, encrypted by `E2EE.encryptGroup` (via `sec.encryptChannel` in `public/js/secure.js`) under the server's **current epoch key**, and signed with the importer's ECDSA key.
- **What readers can verify.** The `c2:` format binds channel, epoch and *author = importer* in the AAD (`hearth-c2|channelId|epoch|authorId`) and signs the whole thing. Readers can therefore verify that **the importer posted this into this channel**, and nothing more:
  - The original author's name, the original time, reactions and pin state are inside the ciphertext, so the server can't change them.
  - But the **importer** could have written anything. Hence the mandatory label: **"Imported from Discord by @importer · original author not verified"**. It never links to a Hearth profile, never shows a Hearth avatar, and never pings.
- **The server still learns:**
  - that an import happened, by whom, into which channels, and how many messages;
  - each message's claimed original timestamp (stored in `created_at` and encoded into the message id for ordering), padded size, and reply and thread structure;
  - opaque per-message source tags (HMACs, not Discord ids; §7.4).
  - It can't read text, author names, attachments' names, or reactions.
- **Newcomers after a key change can't read imported history.** Hearth hands later joiners only the *current* epoch ("Only the current key is ever handed out later (keys/share)", the comment in `openGroup`, `public/js/secure.js`).
  - Imported messages are encrypted under the epoch current at import time. Members present then, and anyone who joins before the next rotation, can read them.
  - After the next rotation (any member leaving, `removeMember` in `server/index.js` sets `needs_rotation`), new joiners see "Sent before you joined. Only members who had the key then can read it."
  - This matches Hearth's existing semantics and is documented as a limit. Phase **3b** (optional, §7.10) proposes per-import "history keys" that are re-shared to newcomers.
- **Private channels.** Imported history in a private channel is protected exactly like other private-channel messages: by the shared server key plus the server's access checks (SECURITY.md §4, "Private channels share the server's key").
- **Consent and privacy of third parties.** An export contains other people's messages. The UI requires the importer to confirm the community agreed, and the docs say so. Hearth can't verify consent.
- **No pings or pushes.** The import route never calls `notifyChannelMessage`, `USE.recordMentions` or `BOTS.event('message.created')`.
- **Malicious export files.**
  - Everything is parsed defensively, rendered through `md()` (escape-first, `public/js/markdown.js`) or text nodes, with length caps.
  - URLs inside imported embeds are https-only and rendered as plain links (never fetched automatically). Existing image-URL embeds in *text* keep today's behaviour (SECURITY.md §4 lists image links as a third-party IP leak).
- **Undo** removes every imported message, its reactions and its source map.

New SECURITY.md contract rows are in §11.

---

## 4. Where it runs (decision)

| Option | How | Pros | Cons | Decision |
|---|---|---|---|---|
| A. Server fetch of template link | `POST /api/imports/discord/preview {link}` → `netguard.request` | One paste, works on phones | Instance IP talks to Discord. Depends on unauthenticated access (unverified). Instance-wide Discord rate limits | **Default** (`features.discordImport = 'on'`) |
| B. Paste or upload JSON in the browser | User opens `https://discord.com/api/v10/guilds/templates/<code>` in their browser, copies the JSON, pastes it (or saves it and uploads the `.json`) | Hearth never contacts Discord | Fiddly on mobile. Also depends on unauthenticated access | Always available; the only path when `'paste'` |
| C. Local bot script | `scripts/discord-structure-export.js` (new, no dependencies): the owner runs it on their own computer with their **own bot token**. It calls `GET /guilds/{id}`, `/roles`, `/channels` and writes template-shaped JSON (real snowflake ids) | Works even if template GET needs auth. Exact `position`s. Hearth never sees the token | Needs a Discord bot in the source server | Ship as the documented fallback; the mapper accepts its output |

- The browser can't fetch Discord itself: `cspFor` restricts `connect-src` to `'self'` (ARCHITECTURE.md §2, point 5). Pasting is the only browser path.
- **Mapping always runs on the server** (`server/discordmap.js`, pure, CommonJS). It runs for preview and again for create, so the server never trusts a client-built plan.
- **History (phase 3) always runs on the importer's device**, because of E2EE.

---

## 5. Phase 1: structure

### 5.1 Data model (schema 18 → 19)

Changes in `server/db.js`, a new block before the `if (fromVersion < SCHEMA_VERSION) db.pragma(...)` line:
- `const SCHEMA_VERSION = 19;`
- Add a `// v19 (import)` block.

```sql
CREATE TABLE IF NOT EXISTS server_imports (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,          -- who ran it
  kind TEXT NOT NULL CHECK (kind IN ('discord_template','discord_emoji','discord_history')),
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('running','done','failed','undone')),
  source TEXT NOT NULL DEFAULT '',     -- template code; '' for paste; 'dce:<sha256 hex>' fingerprint for history. Never file contents.
  epoch INTEGER,                       -- history: server key epoch when the import started
  channels TEXT NOT NULL DEFAULT '[]', -- history: JSON array of target channel ids
  total INTEGER NOT NULL DEFAULT 0,    -- history: messages the importer declared
  done INTEGER NOT NULL DEFAULT 0,     -- items written so far
  report TEXT NOT NULL DEFAULT '{}',   -- JSON: counts, skipped item names and reasons, warnings (no message content)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_server_imports_server ON server_imports(server_id, created_at);
CREATE TABLE IF NOT EXISTS import_map (
  import_id TEXT NOT NULL REFERENCES server_imports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('role','channel','emoji','message')),
  source_id TEXT NOT NULL,    -- template placeholder key, Discord emoji id, or opaque message source tag (§7.4)
  target_id TEXT NOT NULL,    -- Hearth role / channel / emoji / message id
  PRIMARY KEY (import_id, kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_import_map_target ON import_map(kind, target_id);
```

Also add `addColumn('messages', 'import_id', 'TEXT');` plus `CREATE INDEX IF NOT EXISTS idx_messages_import ON messages(import_id) WHERE import_id IS NOT NULL;`. Phase 3 uses it, but it lands with v19 so there is only one schema bump.

- No change to `roles`, `channels`, `channel_overrides`, `emojis`, `servers`. Categories stay strings (`channels.category`, `servers.category_order` JSON), as today.
- `test/quality.test.js` hard-codes 18 and `hearth-before-v18-` (lines ~69–90). Update it to 19.
- The upgrade-before-migrate copy becomes `hearth-before-v19-*.db` automatically.

### 5.2 The pure mapper: `server/discordmap.js` (new, CommonJS, no I/O)

It requires only `./perms`, which has no side effects. Exports:

```js
templateCode(str) -> string|null
// Accepts "https://discord.new/CODE", "https://discord.com/template/CODE", "discordapp.com/template/CODE" (with or
// without scheme), or a bare CODE. CODE must match /^[A-Za-z0-9_-]{2,64}$/. A discord.gg/… or /invite/… link
// returns null; the caller then says "that's an invite link, not a template link".

parseTemplate(input) -> { guild, meta }   // throws ImportError(code, message)
// input: the full template object, or just serialized_source_guild, or C-script output.
// Reads only known fields with typeof checks. Never spreads input objects. Ignores __proto__ and constructor.
// Limits: roles ≤ 300, channels ≤ 600, overwrites per channel ≤ 300, strings truncated (name 200, topic 5000).
// meta: { code, name, description, usageCount, updatedAt, isDirty, sourceGuildId, iconHash }

discordBits(v) -> bigint|null
// "123" → 123n; a safe non-negative integer → BigInt; masked to 64 bits; anything else → null.

mapRolePermissions(bits: bigint) -> { hearth: number, lost: string[], widened: string[] }
mapOverwrite(allow: bigint, deny: bigint) -> { allow: number, deny: number, dropped: string[], widened: string[] }

planFromTemplate(guild, opts) -> Plan
// opts: { maxRoles = 99, maxChannels = 500, maxCategories = 50, maxOverrides = 100,
//         skipRoles: Set<key>, skipChannels: Set<key> }
// Deterministic: same input gives a deep-equal Plan. Throws ImportError('too_many_channels' | 'too_many_categories'
// | 'no_roles' | …) only for unrecoverable input.
```

`Plan`:
```js
{
  name, description,                // name trimmed to 64 ("Imported server" if empty), description to 300
  everyone: { permissions, lost, widened, dangerous },   // dangerous: ADMINISTRATOR/MANAGE_* on @everyone
  roles: [{ key, name, color, icon, hoist, mentionable, position, permissions, lost, widened, admin }],
  categoryOrder: [name, ...],
  channels: [{ key, name, type: 'text'|'voice', category, topic, slowmode, position,
               overrides: [{ target: 'everyone' | roleKey, allow, deny }],
               notes: [...] }],     // §5.6 note codes
  report: { skipped: [{ kind, key, name, reason }], warnings: [{ code, ... }], unmapped: [{ field, value }] }
}
```

### 5.3 Permission mapping (Discord → Hearth bits in `server/perms.js` `PERMS`)

Rule:
- **Role base permissions:** a Hearth bit is set iff **all** of its Discord source bits are set.
- **Overwrites:**
  - Hearth `allow` needs **all** sources in `allow`.
  - Hearth `deny` needs **any** source in `deny`.
  - Then `allow &= CHANNEL_SCOPED; deny &= CHANNEL_SCOPED & ~allow`, as `PUT /channels/:id/overrides` does.
- This never grants more than Discord did.

| Hearth bit (`server/perms.js`) | Discord source bit(s) | Notes |
|---|---|---|
| VIEW_CHANNEL `1<<0` | VIEW_CHANNEL `1<<10` | |
| SEND_MESSAGES `1<<1` | SEND_MESSAGES `1<<11` | Hearth also gates thread replies on SEND (`POST /channels/:id/messages`) |
| ADD_REACTIONS `1<<2` | ADD_REACTIONS `1<<6` | |
| ATTACH_FILES `1<<3` | ATTACH_FILES `1<<15` | |
| MENTION_EVERYONE `1<<4` | MENTION_EVERYONE `1<<17` | |
| MANAGE_MESSAGES `1<<5` | MANAGE_MESSAGES `1<<13` | Hearth's also pins and bypasses slowmode. Discord PIN_MESSAGES / BYPASS_SLOWMODE alone don't map (listed as lost) |
| CONNECT `1<<6` | CONNECT `1<<20` | |
| SPEAK `1<<7` | SPEAK `1<<21` | |
| CREATE_INVITE `1<<8` | CREATE_INSTANT_INVITE `1<<0` | Roles only. Not in `CHANNEL_SCOPED`, so channel overwrites of it are dropped (note `invite_override_dropped`) |
| KICK_MEMBERS `1<<9` | KICK_MEMBERS `1<<1` | Hearth timeouts need Kick. Discord MODERATE_MEMBERS alone is lost |
| BAN_MEMBERS `1<<10` | BAN_MEMBERS `1<<2` | |
| MANAGE_CHANNELS `1<<11` | MANAGE_CHANNELS `1<<4` | |
| MANAGE_ROLES `1<<12` | MANAGE_ROLES `1<<28` | Per channel = "Manage Permissions", same as Hearth |
| MANAGE_SERVER `1<<13` | MANAGE_GUILD `1<<5` | |
| MANAGE_EMOJIS `1<<14` | MANAGE_GUILD_EXPRESSIONS `1<<30` | CREATE_GUILD_EXPRESSIONS `1<<43` alone is lost (Hearth's bit also deletes others' emoji) |
| CREATE_THREADS `1<<15` | SEND_MESSAGES_IN_THREADS `1<<38` **and** CREATE_PUBLIC_THREADS `1<<35` | Composite |
| EMBED_LINKS `1<<16` | EMBED_LINKS `1<<14` | |
| ADMINISTRATOR `1<<30` | ADMINISTRATOR `1<<3` | On @everyone: `dangerous`. Create refuses unless `allowEveryoneAdmin: true` |

Unmappable Discord bits (listed per role in `lost`; source of the bit list: [Permissions](https://docs.discord.com/developers/topics/permissions)):
- VIEW_AUDIT_LOG (1<<7); PRIORITY_SPEAKER (8); SEND_TTS_MESSAGES (12); VIEW_GUILD_INSIGHTS (19).
- MUTE_MEMBERS (22), DEAFEN_MEMBERS (23), MOVE_MEMBERS (24). NEXT.md pick #4 (moderator toolkit) could map these later.
- CHANGE_NICKNAME (26), MANAGE_NICKNAMES (27). Hearth has no per-server nicknames. (Superseded: it has them now, and both map; see "Built so far".)
- MANAGE_WEBHOOKS (29); REQUEST_TO_SPEAK (32); MANAGE_EVENTS (33); MANAGE_THREADS (34); CREATE_PRIVATE_THREADS (36); USE_EXTERNAL_STICKERS (37); MODERATE_MEMBERS (40); VIEW_CREATOR_MONETIZATION_ANALYTICS (41); USE_SOUNDBOARD (42); CREATE_GUILD_EXPRESSIONS (43); CREATE_EVENTS (44); USE_EXTERNAL_SOUNDS (45); SET_VOICE_CHANNEL_STATUS (48); USE_EXTERNAL_APPS (50); PIN_MESSAGES (51); BYPASS_SLOWMODE (52).
- In Hearth, events are managed with Manage Server or Manage Channels (the events route around `server/index.js:4677`). So MANAGE_EVENTS is lost unless the role also has those.

**Widened:** Discord can withhold these but Hearth can't. A warning appears when @everyone lacks one, or when any overwrite *denies* one:
- `READ_MESSAGE_HISTORY` (Hearth: anyone who can view a channel reads all of its history). **This is the important one.**
- `STREAM` (screen share in calls).
- `USE_VAD`.
- `USE_APPLICATION_COMMANDS` (bot slash commands).
- `USE_EMBEDDED_ACTIVITIES` (watch together).
- `SEND_VOICE_MESSAGES`, `SEND_POLLS` (inside ciphertext in Hearth; gated only by Send/Attach).
- USE_EXTERNAL_EMOJIS is also widened (Hearth lets custom emoji from every server be used anywhere), but it is harmless, so it is listed as lost-but-harmless rather than a warning.

### 5.4 Roles

- **@everyone** is `guild.roles[0]`, or for C-script input the role whose id equals the guild id. Its permissions go to the `roles` row with `id = server.id` (Hearth's @everyone convention: the `POST /servers` route in `server/index.js`).
  - For the sample template the mapping yields `98767`, exactly Hearth's `DEFAULT_EVERYONE`. (Now `1147343`, with Change Nickname; see "Built so far".)
- **Other roles:**
  - Sorted by `position` if every role has a numeric one, else by array index, ties by index.
  - Hearth `position` = 1..n in that order (@everyone stays 0). The owner is above everyone via `perms.top` → `Infinity`.
  - **Cap 99** (Hearth refuses a 101st role in `POST /servers/:id/roles`). Overflow drops the *lowest* roles, reports them (`reason: 'limit'`), and drops overrides that target them (`overwrite_role_missing`). The preview lets the user untick roles instead.
  - Skip *managed* roles: `managed === true`, or `tags` with `bot_id`, `integration_id`, `premium_subscriber` or `subscription_listing_id`. Reason `managed`.
- **Fields:**
  - `name`: trim, 32 chars (as in `POST /servers/:id/roles`). Empty becomes `role`. A non-everyone role literally named `@everyone` or `@here` becomes `everyone (role)` / `here (role)`.
  - `color`: `colors.primary_color` ?? `color`. 0 becomes `''`, otherwise `#rrggbb` lower-case, which passes `cleanColor`.
  - `icon`: `unicode_emoji`, first 2 code points (`cleanIcon`). Image role icons (`icon` hash) are dropped (note `role_icon_image_dropped`).
  - `hoist`, `mentionable`: booleans.

### 5.5 Categories, channels and order

- **Categories** (type 4), sorted by `(position, id)`.
  - Hearth category name = `cleanCategory` (trim, 32 chars).
  - Empty becomes `Category N`.
  - **Deduplicated case-insensitively**: "General", then "General (2)", etc. Hearth categories are just strings, so two Discord categories with one name would otherwise merge.
- **Category permission overwrites are dropped** (note `category_permissions_dropped`): Hearth categories have no permissions. Each child keeps its **own** overwrites, which in Discord is the channel's actual permission set (sync only copies).
- **Uncategorised channels** (no `parent_id`, or a parent that isn't a known category):
  - Text-like ones go into a first group named `Text`; voice-like ones into a last group `Voice` (Hearth's defaults in `POST /servers/:id/channels`).
  - Both pass through the same dedupe, so a Discord category already called "Text" makes this one "Text (2)".
- **Within a group**, text-like channels (0, 5, 15, 16) come before voice-like ones (2, 13), each sorted by `(position, id)`. This is Discord's sidebar order.
  - Hearth `channels.position` = a running index over the whole server in that order.
  - `servers.category_order` = group names in order (≤ 50; `PATCH /servers/:id` also caps at 50).
- **Empty categories** are skipped (`reason: 'empty'`). The Hearth UI derives categories from channels (`orderedCategories` in `public/js/app.js`) and says "Every category needs at least one channel" (`openCreateCategory`).
- **Names:**
  - Text: exactly the server's `cleanChannelName(name,'text')` (lower-case, whitespace to `-`, strip `[^a-z0-9\-_]`, 48 chars). E.g. `📢・announcements` → `announcements`. If nothing is left (`公告`), it becomes `channel-N`, where N = 1-based position. Note `renamed` whenever the result differs from the source.
  - Voice: trim, 48 chars.
- **Other fields:**
  - `topic`: 300 chars (`PATCH /channels/:id`).
  - `slowmode` = `rate_limit_per_user` clamped 0–21600 (same range as Hearth).
  - Dropped with notes: `nsfw` (`nsfw_dropped`), `user_limit > 0` (`user_limit_dropped`), `bitrate`, `rtc_region`, `video_quality_mode`, `default_*`, `available_tags` (`forum_tags_dropped`).
- **Overwrites:**
  - `type 1` / `'member'`: dropped (`member_overwrite_dropped`). Templates contain no members.
  - Target id equal to @everyone's id: target `everyone` (written with `target_id = server.id`).
  - Unknown or skipped role: `overwrite_role_missing`.
  - Empty results (allow = deny = 0) are not stored.
  - Cap 100 per channel (as in `PUT /channels/:id/overrides`); overflow is reported.
- **Stage (13):** voice, plus @everyone `deny |= SPEAK` (and `allow &= ~SPEAK`). Every kept role whose Discord base has MUTE_MEMBERS, MOVE_MEMBERS or MANAGE_CHANNELS (stage moderators), and isn't Administrator, gets `allow |= SPEAK` on that channel. Note `stage`.
- **Announcement (5):** text, overwrites as-is (note `announcement`). No automatic read-only: Discord announcement channels only restrict sending if their overwrites do. The report suggests Hearth's "Make read-only (announcements)" menu item (`quickOverride` in `public/js/app.js`) if the user wants it.
- **Forum / media (15, 16):** text (note `forum`).
- **Skipped:** 10, 11, 12, 14 and unknown types (`reason: 'type_<n>'`).
- **No usable channels left:** if the import yields zero channels, create `general` in `Text` (warning `added_default_channel`), as `POST /servers` does.
- **Server-level fields not mapped** (go to `report.unmapped`): `verification_level`, `explicit_content_filter`, `default_message_notifications`, `afk_channel_id` / `afk_timeout`, `system_channel_id` / `system_channel_flags`, `preferred_locale`, `region`.
  - `icon_hash` is offered in phase 2.
  - `is_dirty: true` gives warning `template_unsynced` ("ask the Discord admin to sync the template first").

### 5.6 Note and warning codes (stable strings for UI and tests)

- **Channel notes:** `renamed`, `announcement`, `stage`, `forum`, `forum_tags_dropped`, `nsfw_dropped`, `user_limit_dropped`, `member_overwrite_dropped`, `overwrite_role_missing`, `invite_override_dropped`, `override_limit`, `widened:<DISCORD_BIT>`.
- **Report skipped reasons:** `managed`, `limit`, `empty`, `type_<n>`, `excluded`.
- **Warnings:** `template_unsynced`, `everyone_admin`, `everyone_manage`, `widened_everyone:<BIT>`, `added_default_channel`, `category_permissions_dropped:<name>`, `role_icon_image_dropped:<name>`.

### 5.7 Routes (phase 1)

All are JSON and behind `auth`. They are mounted from a new `server/imports.js` (`module.exports = function setupImports(ctx)`), wired in `server/index.js` next to `require('./search')(...)`. The ctx passes:
- `api, auth, db, fail, wrap, rateLimit, limitNet, newId, now`;
- `features, isStaff, perms, PM, ALL_PERMS, CHANNEL_SCOPED, DEFAULT_EVERYONE`;
- `serializeServer, keyState, emitServer, io getter, auditLog`;
- `requireServer, requirePerm, requireChannel, canIn, serverOf, toChannel`;
- `forgetMessages, removeUpload, uploadPath, fileName, UPLOAD_DIR, recordFile, overLimit, quotaOf, stripFile, isAnimatedImage, addEmoji, emojiName, VERSION`.

| Method + path | Who | Body (validated) | Limits | Result / errors |
|---|---|---|---|---|
| `POST /api/imports/discord/preview` | any signed-in user allowed to create servers: same gate as `POST /servers` (`features().createServers === 'staff'` → staff only) and `features().discordImport !== 'off'` | `{ link: string ≤ 300 }` XOR `{ template: object }` | `rateLimit('dimp:'+uid, 30, 10 min)`. Link fetch also `rateLimit('dtpl:'+uid, 20, 1 h)`, `limitNet(req,'dtpl',40,1 h)`, `rateLimit('dtpl:all', 300, 1 h)` | `{ source: {kind:'link'\|'paste', code, name, usageCount, updatedAt}, plan }`. 400 `not_template` / `invite_link` / `bad_template`; 403 `paste_only` (link given while `'paste'`); 404 `template_not_found` (Discord 404 / 10057); 503 `discord_busy` + `Retry-After` (Discord 429, capped 3600 s); 502 `discord_unreachable` (`GuardError`, 5xx, bad JSON). Express returns 413 `too_large` over 2 MB |
| `POST /api/imports/discord` | same | `{ link \| template, name?: string ≤ 64, skipRoles?: string[] ≤ 300, skipChannels?: string[] ≤ 600, allowEveryoneAdmin?: boolean }` | `rateLimit('dimpc:'+uid, 5, 1 h)` (server creations) | Creates everything in **one** `db.transaction` (below). `{ ...serializeServer(row, uid), keyState, importId, report }`. 400 `everyone_admin` unless confirmed; 400 `too_many_*` |
| `GET /api/servers/:id/imports` | `requirePerm(id, MANAGE_SERVER)` | none | 60/min/user | `[{ id, kind, status, source, done, total, report, createdBy, createdAt, finishedAt }]` |

Link fetch (in `server/imports.js`):
```js
const DISCORD_API = (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
const API_ORIGIN = new URL(DISCORD_API).origin;
const r = await netguard.request(`${DISCORD_API}/guilds/templates/${encodeURIComponent(code)}`, {
  allowUrl: (u) => u.origin === API_ORIGIN && /\/guilds\/templates\/[A-Za-z0-9_-]{2,64}$/.test(u.pathname),
  allowPrivate: process.env.DISCORD_IMPORT_ALLOW_PRIVATE === '1',   // tests only (like FEED_ALLOW_PRIVATE)
  maxRedirects: 0, timeout: 10000, maxBytes: 1024 * 1024,
  headers: { 'User-Agent': DISCORD_UA, Accept: 'application/json' },
});
```
- Cache successful templates in memory: `Map(code → {at, template})`, 10 min TTL, at most 50 entries, oldest evicted. Preview and create then cost one Discord call.
- Never cache failures beyond the 429 `Retry-After`. Remember that one per instance and answer 503 without calling Discord until it passes.

The create transaction:
1. `INSERT servers (id, name, icon NULL, owner_id = uid, created_at, description, category_order)`.
2. `INSERT members` (owner).
3. `INSERT roles` @everyone (`id = server.id`, `permissions = plan.everyone.permissions & ALL_PERMS`).
4. `INSERT roles` for each kept role (`newId()`, `permissions & ALL_PERMS`, `cleanColor` / `cleanIcon` / hoist / mentionable).
5. `INSERT channels` (`newId()`, name, type, topic, position, category, slowmode).
6. `INSERT channel_overrides` (`target_type 'role'`, `allow & CHANNEL_SCOPED`, `deny & CHANNEL_SCOPED & ~allow`).
7. `INSERT server_imports (kind 'discord_template', status 'done', source = code or '', report = JSON.stringify(plan.report))`.
8. `INSERT import_map` rows (`'role'`: key → role id; `'channel'`: key → channel id).
9. After commit:
   - `io.in('user:'+uid).socketsJoin('server:'+id)`;
   - emit `server:add` exactly as `POST /servers` does;
   - `auditLog(req, 'server_import', id, 'discord template: <n> roles, <m> channels, <k> skipped')`;
   - `server:` key state stays at epoch 0 / `needs_rotation 1`, as for any new server, so the first client `rotate` makes epoch 1.

Socket events (phase 1): none new. It reuses `server:add` (server → client). Client → server stays REST-only, per ARCHITECTURE.md §2.

New env and settings:
- `.env.example`: `DISCORD_API_BASE`, `DISCORD_CDN_BASE` (phase 2), `DISCORD_IMPORT_ALLOW_PRIVATE` (tests only).
- `FEATURE_DEFAULTS` in `server/index.js` gets `discordImport: 'on'`.
- `PUT /admin/owner` accepts `['on','paste','off'].includes(b.features.discordImport)`.
- `features()` is already sent in `/api/config` (`server/index.js` ~line 1357) and in `config:update`.

### 5.8 Client (phase 1)

- **New `public/js/discord-import.js`** (ES module; exported functions take an explicit ctx, like `botsTab` in `public/js/bots.js`):
  - `openDiscordImport(ctx)` with ctx `{ api, S, sec, modal, field, h, icon, toast, openServer, PERMS, PERM_GROUPS }`.
  - **Step 1, input:**
    - link input (placeholder `https://discord.new/…`);
    - "or paste the template JSON" textarea;
    - "or choose a .json file" `<input type=file accept="application/json,.json">`;
    - help text: "In Discord: Server Settings → Server Template → copy the link (needs Manage Server)". Discord's exact menu wording is unverified; keep it generic.
    - When `S.config.features.discordImport === 'paste'`, hide the link field and show "Open `https://discord.com/api/v10/guilds/templates/<code>` in your browser, select all, copy, paste here", with a code input that builds the link.
    - Client-side size check: ≤ 1.5 MB, else "That file is too big to be a template".
  - **Step 2, preview:**
    - server name field (prefilled);
    - roles list: colour dot, name, unicode icon, a summary of mapped permissions using the labels in `PERM_GROUPS` (`public/js/perms.js`), an "Administrator" badge, a "Can't bring:" line from `lost` (friendly names table, §5.9), and a checkbox;
    - channel tree grouped by category: `hash` / `speaker` icon, note chips from §5.6, checkbox, lock icon when @everyone is denied VIEW;
    - a red warnings box (widened permissions, `everyone_admin` needs its own checkbox, `template_unsynced`);
    - a skipped list.
  - **Step 3, create:** `api('POST','/imports/discord',…)`, then:
    - `S.servers.push`, `await sec.applyState(s.keyState)`, `openServer(s.id)` (same as `openCreateServer`);
    - a report modal with "Copy report" (`copyText`);
    - a hint: "Roles came over unassigned. Give them out in Server settings → Members."
- **`public/js/app.js`:**
  - `openAddServer()`: add a third `choice` button "Import from Discord" with `icon('download')`. The icon exists in `public/js/util.js`. Hide it when `features.discordImport === 'off'`, or when `createServers === 'staff'` and the user isn't staff (mirror the server gate).
  - Import `openDiscordImport` at the top with the other modules.
- **`public/js/admin.js`:** in the Features block next to "Who can create servers", add `kv` chips "Import from Discord": On / Paste only / Off → `save({ features: { discordImport: k } })`.
- No changes in `desktop/` or `mobile/`.
  - Both load the remote UI (ARCHITECTURE.md §1).
  - File inputs already work: Android uses Capacitor's `BridgeActivity` chrome client (`mobile/native/MainActivity.java` only overrides the WebView *client*, `HearthClient extends BridgeWebViewClient`).
  - External links (the Discord API link in paste mode) open in the system browser via `setWindowOpenHandler` / `will-navigate` in `desktop/main.js`.

### 5.9 Friendly names for Discord bits (client table)

For the "Can't bring" lines, a frozen object in `discord-import.js`:
- `MODERATE_MEMBERS` → "Timeout members"
- `MUTE_MEMBERS` → "Mute members in voice"
- `MOVE_MEMBERS` → "Move members"
- `MANAGE_NICKNAMES` → "Manage nicknames"
- `VIEW_AUDIT_LOG` → "View audit log"
- `PIN_MESSAGES` → "Pin messages (Hearth: part of Manage messages)"
- `BYPASS_SLOWMODE` → "Bypass slowmode (Hearth: part of Manage messages)"
- `READ_MESSAGE_HISTORY` → "Read message history (Hearth always allows it for people who can see a channel)"
- `MANAGE_EVENTS` → "Manage events (Hearth: Manage server or Manage channels)"
- … one entry for every bit in §5.3.

### 5.10 Phase-1 edge cases

- An invite link pasted instead of a template → 400 `invite_link` with an explanation.
- A link pasted whose code has no template → 404 `template_not_found`.
- JSON that is a *guild object* (C-script output with snowflake ids) → accepted. @everyone = role whose id equals `guild.id`, or `position 0` named `@everyone`. Overwrites of type 1 are dropped. String ids are used as keys.
- `permissions` absent or garbage → 0 + warning `bad_permissions:<role>`.
- Overwrite `type` as the string `"role"` / `"member"` (older shape) → accepted.
- `parent_id` pointing at a non-category or a missing id → treated as uncategorised.
- More than 50 non-empty categories → 400 `too_many_categories` (the preview shows the count; the user unticks channels).
- More than 500 channels → 400 `too_many_channels`.
- @everyone with ADMINISTRATOR → preview warning, create refused without `allowEveryoneAdmin: true`.
- @everyone with MANAGE_* → warning only.
- @everyone lacking VIEW_CHANNEL (private-by-default server) → fine: `perms.restricted` handles it, and all channels are restricted.
- Duplicate role names → allowed (Hearth allows them). Duplicate text-channel names → allowed (no unique constraint).
- Template from a big community (250 roles) → the top 99 are kept by default, and the preview shows the rest unticked with the reason.
- `createServers: 'staff'` → non-staff get the same 403 text as `POST /servers`.
- Concurrent double-click on Create → the 5/hour limit plus a client-side busy flag. Two servers would be created otherwise; acceptable.
- Template JSON over 2 MB → Express 413 (`too_large`) before the route runs.

---

## 6. Phase 2: emoji and server icon

### 6.1 Sources of the emoji list (client)

1. **Paste tokens.** Any text containing `<:name:id>` / `<a:name:id>`. In Discord, typing `\:name:` shows the token (well-known behaviour; not in the fetched docs). The client extracts `{id, name, animated}` with `/<(a?):([A-Za-z0-9_]{2,32}):(\d{15,21})>/g` and dedupes by id.
2. **DCE export files.** Collect `inlineEmojis[]` and `reactions[].emoji` where `id` is a non-empty digit string (standard emoji have empty or null ids).
3. **Image files** (paste mode or no CDN wanted). Multiple `<input type=file accept="image/png,image/gif,image/webp,image/jpeg">`. Names come from file names via the server's `emojiName`. Each file goes through the **existing** `POST /servers/:id/emojis` (multipart, `limited('image', …)`) one at a time.

### 6.2 Routes

| Method + path | Who | Body | Limits | Behaviour |
|---|---|---|---|---|
| `POST /api/servers/:id/imports/emoji` | `requirePerm(id, MANAGE_EMOJIS)`; `features().discordImport === 'on'` else 403 `paste_only` | `{ importId?: string, emojis: [{ id: /^\d{15,21}$/, name: string, animated: bool }] (1..25) }` | `rateLimit('demoji:'+uid, 300, 1 h)`, `limitNet(req,'demoji',600,1 h)`, `rateLimit('demoji:all', 2000, 1 h)`; `quotaOf(uid).blocked` → 403 | Detailed below. Returns `{ importId, results: [{ id, status, emojiId?, name? }] }` |
| `POST /api/servers/:id/imports/icon` | `requirePerm(id, MANAGE_SERVER)`; feature `'on'` | `{ guildId: /^\d{15,21}$/, iconHash: /^(a_)?[0-9a-f]{32}$/ }` | 10/hour/user | Fetch `${CDN}/icons/{guildId}/{hash}.{gif\|png}?size=512` (≤ `uploadLimits().imageMb`), sniff, strip, `recordFile(…,'image',…)`, `UPDATE servers SET icon`, `removeUpload(old)`, `emitServer` (same effects as `POST /servers/:id/icon`) |

`POST /api/servers/:id/imports/emoji` in detail:
- Creates or reuses a `server_imports` row with kind `discord_emoji` (reuse only if it's the caller's, in this server, under 1 h old).
- Processes the emoji in order, two at a time:
  - **(a)** If `import_map` already maps this Discord id for any import of this server → `exists`.
  - **(b)** Pick a unique name: `emojiName(name)`, then `name_2`, `name_3`… (≤ 32 chars) against `emojis`.
  - **(c)** At 200 emoji → `limit` (stop) — the same cap as `checkEmojiRoom`.
  - **(d)** Fetch `${DISCORD_CDN}/emojis/{id}.{gif|png}`:
    - `allowUrl`: origin = CDN origin, path `^/emojis/\d{15,21}\.(png|gif)$`;
    - `maxRedirects: 0`, `timeout: 10000`, `maxBytes: 512 * 1024`;
    - 404 → `not_found`; `TOO_BIG` → `too_big`.
  - **(e)** Sniff magic bytes (PNG `\x89PNG`, `GIF87a` / `GIF89a`) → else `bad_image`.
  - **(f)** Write `fileName('.png'|'.gif')` into `UPLOAD_DIR`, then `await stripFile(path)` → `ImageRejected` → `bad_image`.
  - **(g)** With no `await` between them (as `limited()` does): `overLimit(uid, q, size)` → `quota`; `recordFile(uid, file, 'emoji', size)`; `addEmoji(s, name, '/uploads/'+file, isAnimatedImage(buf), uid)`; insert `import_map('emoji', discordId → emojiId)`.
  - On any failure after writing, `removeUpload`.

Other server changes:
- `DELETE /emojis/:id` (`server/index.js`) also runs `DELETE FROM import_map WHERE kind='emoji' AND target_id=?`, so a re-import works.
- `GET /api/servers/:id/imports/map?kind=emoji` (MANAGE_SERVER) → `[[discordId, emojiId, name, animated], …]` (≤ 200). Phase 3 uses it to rewrite emoji.

### 6.3 Client
- Server settings → **Emoji** tab (the `TABS` list in `openServerSettings`, `public/js/app.js`; gated by `MANAGE_EMOJIS`): add an "Import from Discord" button that opens `openEmojiImport(server, ctx)` in `discord-import.js`. It has three source tabs (§6.1), a preview grid and per-item results.
- After the phase-1 create, the report modal offers "Also copy the server icon from Discord" when `meta.iconHash` is set (calls `/imports/icon`).

### 6.4 Edge cases
- Discord emoji names are 2–32 alphanumeric/underscore; the same rule as Hearth's `emojiName`. Collisions get a suffix.
- Animated emoji over 512 KB → `too_big` (Discord caps uploads at 256 KiB).
- AVIF originals: request `.png` / `.gif` (Discord serves those formats; [Reference](https://docs.discord.com/developers/reference)). Hearth's `uploadImage` filter doesn't accept AVIF.
- Deleted Discord emoji → CDN 404 → `not_found`.

---

## 7. Phase 3: message history from a DCE JSON export

### 7.1 Flow (importer's device)

1. Server settings gets a new tab **Import history**: `['import', 'Import', 'download', (s) => !isGroup(s) && can(s, PERMS.MANAGE_SERVER)]` in `TABS`.
2. **Choose files.**
   - One or more DCE `.json` files, each ≤ 50 MB. Larger ones get: "Export in parts: DiscordChatExporter's 'Partition' option".
   - `JSON.parse` runs in the main thread; files are parsed one at a time.
3. **Map each file to a channel.**
   - Default: an existing Hearth text channel with the same cleaned name, preferring one in a category with the same name (`file.channel.category`).
   - Otherwise "Create #name" (via the existing `POST /servers/:id/channels`).
   - Threads (`GuildPublicThread` / `GuildPrivateThread` / `GuildNewsThread`) map onto their parent's channel (§7.6).
4. **Consent.** Show the label text and a checkbox: "People in this Discord server agreed to bring their messages here. Hearth will show them under their Discord names, marked *imported, original author not verified*, posted by you."
5. **Start:** `POST /servers/:id/imports/history` with `{ channels, total, source: 'dce:'+sha256hex(fingerprint), epoch }`. The fingerprint is the concatenation of channel ids, first and last message ids, and counts. Then encrypt and upload in batches (§7.3), with a progress bar and a Cancel (pause) button.
6. **Finish:** `POST /imports/:id/finish` with counts. Show a summary of imported messages and of what was skipped, by kind.
7. **Resume:** on reopening, list `running` imports (`GET /servers/:id/imports`). `GET /imports/:id/sources` returns the already-imported source tags; the client skips those.
8. **Undo:** `DELETE /imports/:id`.

### 7.2 Pure transform: `public/js/discord-history.js` (new ES module, testable in Node like `search-query.js`)

```js
export function parseExport(text) -> { guild, channel, messages, exportedAt }   // throws Error('not_dce_export' | 'dm_export' | …)
export function buildItems(exp, { emojiMap, maxText = 4000 }) -> { items: [{ srcId, at, replyToSrcId, threadSrcId, payload }], skipped: { system, empty, unknownType, … } }
export function fallbackText(imp) -> string
export const IMPORT_FORMAT = 1;
```

**Rules:**
- **System kinds are skipped and counted:** `RecipientAdd`, `RecipientRemove`, `Call`, `ChannelNameChange`, `ChannelIconChange`, `ChannelPinnedMessage`, `GuildMemberJoin`, `ThreadCreated`, `PollResult`, unknown.
- **Kept:** `Default`, `Reply`, `ThreadStarterMessage`.
- **Mentions:** if `content` still has raw tokens (markdown formatting off), replace:
  - `<@id>` / `<@!id>` → `@name` from `message.mentions` (else `@unknown`);
  - `<#id>` → `#channel`;
  - `<@&id>` → `@role`;
  - `<t:…>` → an ISO date.
  - The result must not contain Hearth role-mention syntax `<@&hearthId>` (it would ping-highlight). Strip `<@&` entirely.
- **Custom emoji:**
  - `:name:` becomes `<:name:hearthId>` / `<a:name:hearthId>` only when `name` is in this message's `inlineEmojis` **and** `emojiMap` (from §6.2's map) has that Discord id.
  - Raw `<:name:discordId>` tokens are rewritten the same way, else to `:name:`.
- **`at`** = `Date.parse(timestamp)`; `ed` = `Date.parse(timestampEdited) || 0`. Messages whose `at` is outside [1420070400000 (2015-01-01, Discord epoch), now + 5 min] are skipped (`bad_time`).
- **Reply:** `reference.messageId` when `type === 'Reply'` → `replyToSrcId`.
- **Forward:** `forwardedMessage` present → `fw: true`; text = forwarded content.

**Payload v1** (inside the ciphertext). `JSON.stringify(payload)` must be ≤ 45,000 UTF-8 bytes, so `padded()` plus `c2:` stays under `validCipher`'s 64,000 characters. Otherwise drop the fallback text and then truncate `imp.t`.
```js
{
  t: "[Imported from Discord] Maple · 2024-03-01 17:05 UTC\nTrail report: …",   // fallback for apps without import support
  imp: {
    v: 1, src: 'discord',
    a: 'Maple',                 // nickname ?? name, ≤ 64
    u: 'maple',                 // username, ≤ 64
    ai: '80351110224678912',    // Discord user id or ''
    bot: false,
    at: 1709312712345,          // original send time (ms)
    ed: 1709312760000,          // original edit time or 0
    t: 'Trail report: the ridge is clear <:pinecone:mh8x2k3p0a1b2c3d4e5> @everyone',  // ≤ 4000
    pin: true,
    r: [['👍', 3], ['<:pinecone:mh8x2k3p0a1b2c3d4e5>', 1]],    // ≤ 20, count ≤ 1e6
    att: [['ridge.jpg', 482113]],                              // ≤ 10, name ≤ 120
    st: ['Wave'],                                              // stickers ≤ 3
    em: [{ ti: 'Trailhead map', u: 'https://example.org/map', d: '…' }],   // ≤ 3, https only, d ≤ 1000
    fw: false,
  }
}
```

### 7.3 Encrypt and upload (client)

- A new helper in `public/js/discord-import.js`, `runHistoryImport(ctx, plan)`.
  - Batches go oldest-first per channel, ≤ 100 items and ≤ 1.5 MB of JSON body (Express caps bodies at 2 MB, `express.json({ limit: '2mb' })`).
  - For each item:
    - `const { ciphertext, epoch } = await sec.encryptChannel(serverId, channelId, payload)` (existing; uses `ready()` → current epoch);
    - `src = await sec.importTag(serverId, importEpoch, importId, srcId)`.
  - `POST /imports/:id/messages`.
  - On 409 `stale-key` / `rotate`: `await sec.refresh(serverId)`, re-encrypt the **same batch** with the new epoch, retry. This mirrors `withKeyRetry` in `public/js/app.js`.
  - Yield to the UI between batches.

### 7.4 Source tags (no Discord ids on the server)

- In `public/js/e2ee.js`, new:
  ```js
  export async function importSourceTag({ raw, serverId, importId, sourceId })
  ```
  It returns `HMAC-SHA-256(HKDF(raw, salt = utf8(importId), info = 'hearth-import-src|' + serverId), utf8(sourceId))`, the first 16 bytes, base64url (22 chars).
- In `public/js/secure.js`, new `importTag(serverId, epoch, importId, sourceId)`, using `keysFor(serverId).get(epoch)`. `epoch` is the import's starting epoch (`server_imports.epoch`), so tags stay stable across rotations and devices.
- These tags are the idempotency keys for retries and resume, and let the server resolve replies and threads within an import without learning Discord ids.

### 7.5 Routes (phase 3)

| Method + path | Who | Body | Limits | Behaviour |
|---|---|---|---|---|
| `POST /api/servers/:id/imports/history` | `requirePerm(id, MANAGE_SERVER)`, not timed out (`perms.timedOut`); for every channel: `requireChannel`, `type === 'text'`, `canIn(SEND_MESSAGES)` | `{ channels: string[] (1..50), total: int 1..IMPORT_MAX (env `HEARTH_IMPORT_MAX_MESSAGES`, default 200000), source?: /^dce:[0-9a-f]{64}$/, epoch: int }` | `rateLimit('imph:'+uid, 10, 1 h)`; one `running` history import per server (409 `import_running`); `epoch` must equal `servers.key_epoch` and `needs_rotation = 0` (`requireCurrentEpoch`) | Inserts `server_imports` (running, epoch, channels). `auditLog('history_import_started')`. Warns `duplicate_source` if a previous import of this server has the same `source` (returned, not refused). `{ importId }` |
| `POST /api/imports/:id/messages` | the import's `user_id`, status `running`; re-check MANAGE_SERVER and per-channel VIEW+SEND (`perms.forServer`) | `{ epoch: int, items: [{ channelId, ciphertext, src: /^[A-Za-z0-9_-]{22}$/, at: int, replyToSrc?, threadSrc? }] (1..100) }` | `rateLimit('impb:'+uid, 60, 60 s)`, `rateLimit('impbh:'+uid, 2000, 1 h)`, `rateLimit('impb:all', 600, 60 s)`; `done + new ≤ total` else 400 `over_total` | Detailed below. `{ results: [{ src, id, dup? }], done }` |
| `POST /api/imports/:id/finish` | creator | `{ skipped?: { [kind]: int } }` (≤ 20 keys, ints) | 10/min | status `done`, `finished_at`, merges counts into `report`. `auditLog('history_import_finished', …, '<n> messages')`. `import:update` |
| `DELETE /api/imports/:id` | creator or server owner | none | 10/hour | Detailed below. Status `undone`. `auditLog('history_import_undone')`. `{ removed }` |
| `GET /api/imports/:id/sources?after=&limit=` | creator or owner | `limit` 1..1000 | 60/min | `[[src, messageId, channelId]]` ordered by src (resume) |
| `GET /api/servers/:id/imports/map?kind=emoji` | MANAGE_SERVER | none | 60/min | phase 2 map |

`POST /api/imports/:id/messages` in detail:
- `requireCurrentEpoch`. Each item:
  - `validCipher`;
  - `E2EE` prefix check: `ciphertext.startsWith('c2:'+epoch+':')`;
  - `channelId` must be in the import's channels;
  - `at` must be in [1420070400000, now + 300000].
- In **one transaction**, per item:
  1. If `import_map(id,'message',src)` exists → result `{src, id, dup:true}`.
  2. Resolve `replyToSrc` / `threadSrc` via `import_map`. The target must be in the **same channel**; the thread root must have `thread_id IS NULL`. Otherwise set to null.
  3. `id = importMsgId(at)`, i.e. `Math.floor(at).toString(36).padStart(9,'0') + crypto.randomBytes(5).toString('hex')`. This is the same shape and order as `newId()` in `server/db.js`; retry on a primary-key clash.
  4. `INSERT messages (id, channel_id, author_id = uid, body '', ciphertext, epoch, reply_to, created_at = at, thread_id, import_id)`.
  5. `INSERT import_map`.
- `UPDATE server_imports SET done, updated_at`.
- After commit:
  - per channel, `toChannel(c).emit('messages:imported', { channelId, importId, count, newestId })`;
  - `io.to('user:'+uid).emit('import:update', {...})`.
- **Never** calls `notifyChannelMessage`, `USE.recordMentions`, `USE.markSent`, `BOTS.event`, `attachBlobs`, `limitMessages`, or the slowmode check.

`DELETE /api/imports/:id` in detail:
- In chunks of 500, in transactions:
  - `ids = SELECT id FROM messages WHERE import_id = ?`, **plus** native replies in threads rooted at those ids;
  - `forgetMessages(ids)`, then `DELETE FROM messages WHERE id IN (…)`.
- `DELETE FROM import_map WHERE import_id = ? AND kind = 'message'`.
- Emit `messages:imported {removed:true}` per channel.

Existing code to touch:
- **`serializeMessage`** (`server/index.js`): add `...(row.import_id ? { importId: row.import_id, importedAt: importedAtOf(row.import_id) } : {})`. `importedAtOf` is a small `Map` cache over `server_imports.created_at`.
- **`PATCH /messages/:id`:** `if (m.import_id) fail(409, 'Imported messages can’t be edited. Delete it instead.', 'imported')`.
- **`forgetMessages`:** add `DELETE FROM import_map WHERE kind = 'message' AND target_id IN (…)` in its chunk loop.
- **Admin activity count** (`server/index.js` ~line 4140, `SELECT COUNT(*) … FROM messages WHERE created_at >= ? AND created_at < ?`): add `AND import_id IS NULL`, so imports don't inflate recent days.
- **New job** `jobs.every('imports.sweep', 6 h, …)`: mark `running` history imports idle for more than 24 h as `failed` (messages kept; undo still works).

### 7.6 Threads, forums, pins

- **Discord thread from a message:** the thread id equals the source message id ([Channel resource](https://docs.discord.com/developers/resources/channel), "The id of the created thread will be the same as the id of the source message"). For a thread export, `threadSrcId = channel.id`.
  - If that root was imported (same import, same Hearth channel), replies go into the Hearth thread.
  - Otherwise they are imported top-level with `[thread: <name>]` prefixed to `imp.t`.
- **Forum posts:** each post is a thread whose `ThreadStarterMessage` (or first message) becomes the root in the mapped text channel; the rest become thread replies.
- **Pins:** `imp.pin` shows a "Pinned on Discord" badge. Real Hearth pins (`MAX_PINS = 50`) are not created automatically (open question 9).

### 7.7 Client changes (phase 3)

**`public/js/secure.js`:**
- `cleanImport(p)` (like `cleanPoll`) sanitises `payload.imp`:
  - `v === 1`, `src === 'discord'`;
  - strings truncated and typed;
  - `at` in range;
  - arrays capped;
  - `em[].u` must be `https:` (`new URL`), else dropped.
- `openGroup` returns `imp`, and sets `t = imp.t` when `imp` is valid (so search via `search-query.js`, reply previews, `textOf` and export see the original text).
- `decryptChannelMessage` passes `Number(m.importedAt || m.createdAt)` as `at`. Key selection is then based on when the importer actually signed (§3), not the claimed 2019 date.
- Expose `importTag`.

**`public/js/e2ee.js`:** `importSourceTag` (§7.4).

**`public/js/app.js`:**
- `fillMessage`: when `m.importId && m.dec && m.dec.imp`:
  - **header:** a neutral initials avatar (colour from a hash of `imp.ai || imp.a`, no `openProfilePop`); name `imp.a` plus a small "Discord" tag; "BOT" if `imp.bot`; time `fmtStamp(imp.at)` with title "Original time on Discord (not verified)";
  - **body:** `md(imp.t, { mentionName: '', everyone: false })`;
  - attachments line "📎 ridge.jpg · 471 KB — not imported";
  - static reaction chips (tip "Reactions on Discord");
  - an embed card as text and link;
  - "edited on Discord" if `imp.ed`;
  - **flag (always):** `h('div', { class: 'msg-flag', 'data-tip': 'Copied from a Discord export by @importer. Hearth checks only that @importer posted it here; who wrote it on Discord and when can’t be verified.' }, 'Imported from Discord by @importer · original author not verified')`;
  - if `m.dec.verified === false`, the existing "⚠ Sender could not be verified" flag (about the importer).
  - If `dec.imp` is present but **no** server `importId` (a member posted a crafted payload normally), render as a normal message showing the fallback `payload.t`. That fallback already says "[Imported from Discord]" and is attributed to the real poster.
- `grouped(m, prev)`: group imported messages by `imp.ai || imp.a` instead of `authorId`, using `imp.at`.
- `mentionKind(m)`: return `null` for imported messages.
- `messageMenuItems`: hide "Edit message" when `m.importId`.
- Socket handler `socket.on('messages:imported', ({ channelId, removed }) => { delete S.msgs['c:'+channelId]; if (currentKey() === 'c:'+channelId) loadMessages('c:'+channelId); })`.
- `openServerSettings`: the `import` tab.

**`public/js/usability.js`** (export): in the record builder, if `m.dec.imp`, add `rec.imported = { from: 'discord', originalAuthor: imp.a, originalAt: ISO, importedBy: rec.author, verified: false }`. `rec.text` is already `imp.t`.

**CSS** (`public/css/*`): the initials avatar and "Discord" tag. No new colours; reuse the `.msg-flag` style.

### 7.8 Edge cases (phase 3)

- **A member leaves mid-import:** rotation → 409 → re-encrypt. Part of the import ends up under epoch N and part under N+1. Readers who hold both keys see everything.
- **The importer loses MANAGE_SERVER mid-import:** 403. The import stays `running`, the owner can undo, and the sweep marks it `failed` after 24 h.
- **A target channel is deleted mid-import:** its items get 404; the client marks that file failed.
- **The importer's account is deleted:** users are soft-deleted (`users.deleted_at`) and public keys are kept (SECURITY.md row 62). Imported messages stay readable and verifiable.
- **The same export is imported twice:** `duplicate_source` warning; within one import, src idempotency.
- **Replies to messages outside the export:** dropped. Count `reply_target_missing`.
- **Empty text with attachments only:** imported, showing the attachment list.
- **DM exports** (`DirectTextChat` / `DirectGroupTextChat`): refused (`dm_export`).
- **Exports of voice-channel text chats** (`GuildVoiceChat`): imported into a mapped *text* channel. The server refuses voice targets, as `POST /channels/:id/messages` does.
- **`@everyone` / `@here` in imported text:** no push, no mention mark, no highlight.
- **Very old timestamps:** ids sort before all native messages. They are below every existing read marker (`read_states.last_read_id` compares ids), so there is no unread storm.
- **Search** (`server/search.js` orders by `(created_at, id)`) finds imported messages by their original date.
- **`pageRows` and the client `store.list` sort** order by id, so imported history interleaves by time with any native messages in the same channel. The UI warns before importing into a non-empty channel.

### 7.9 What phase 3 deliberately doesn't do (MVP)

- Re-upload attachments.
  - 3b: if the user exported with DCE's media download, select the media folder (`webkitdirectory`; desktop and web only), then `encryptFile` + `uploadSimple` / `uploadResumable` (`public/js/files.js`), and put entries into `payload.f`. Quotas apply to the importer.
- Polls, voice messages, real Hearth reactions or pins.
- Server-side "who wrote it" claims.

### 7.10 Optional phase 3b: history keys for newcomers (open decision)

- **Problem (§3):** after the next rotation, new members can't read imported history.
- **Proposal:**
  - Each history import gets its own random 32-byte **history key** (`newGroupKey()`).
  - It is wrapped to every member with `wrapGroupKey`, using `epoch = 'i.' + importId` (domain-separated context `hearth-gk|server|i.<id>|recipient|wrapper`).
  - It is stored in a new table `import_keys(import_id, user_id, wrapped, wrapper_id, created_at)` plus `server_imports.key_check`.
  - Messages use `c2:i.<importId>:…` (the AAD carries the same string). The import route requires that prefix instead of `requireCurrentEpoch`.
- **Rules:**
  - Any member holding it re-shares it to newcomers (extend `keyState` with `imports: [...]` and `secure.js maintain()`). Like the current key, it is accepted only from a current member's verified signature.
  - It is **never rotated**. Once the import is `done` the server refuses any further write under it, so former members gain nothing new.
- **Trade-off:** someone removed from the server (who already saw this history on Discord) could still decrypt it with a copy of the database. That's acceptable for an archive, and must be stated in SECURITY.md.
- **Effort:** +M. **Recommendation:** decide before phase 3 ships widely, because data imported under epoch keys can't be moved to history keys without re-encryption by the importer.

---

## 8. Migration and compatibility

- **Database:** schema 19 runs in the existing single migration transaction (`BEGIN IMMEDIATE` … `COMMIT` in `server/db.js`), and makes the `hearth-before-v19-*.db` copy.
  - Older code refuses a v19 database (`HEARTH_DB_TOO_NEW`) and older restore refuses v19 backups (`HEARTH_BACKUP_TOO_NEW`). Document rollback via the before-v19 copy (docs/RECOVERY.md).
  - `scripts/upgrade-drill.sh` / `scripts/upgrade-drill.js` should run unchanged. Verify in CI.
- **Clients:** web, desktop and Android all load the UI from the server (ARCHITECTURE.md §1, §9). Clients reload when `/api/config` `version` changes, so they update with the server.
  - Native shells need **no** changes or new releases. The `.github/workflows/hearth-apps.yml` builds are untouched.
- **Stale tabs:** imported messages show the fallback `payload.t` ("[Imported from Discord] Maple · 2024-03-01 17:05 UTC\n…"), attributed to the importer. Honest, just less pretty.
- **Bot API:** no `message.created` events for imported messages (docs/BOTS.md: add a sentence). Message metadata calls show the importer as author.
- **Data export:** includes the `imported` block (§7.7).
- **Search, read state, pins, reactions, threads:** work on imported messages. Editing is refused (409 `imported`).

---

## 9. Tests to write (named, concrete)

Fixtures:
- `test/fixtures/discord-template.json` (Appendix A).
- `test/fixtures/discord-guild-script.json`: the C-script shape, with snowflake ids and a member overwrite.
- `test/fixtures/dce-export.json` (Appendix B).

### 9.1 `test/discord-map.test.js` (pure; requires `server/discordmap.js`)

- `templateCode accepts discord.new, discord.com/template and discordapp.com/template links and bare codes`
- `templateCode refuses invite links, other hosts, and codes with odd characters`
- `discordBits reads permission strings above 2^32 and 2^53 with BigInt, and numbers up to 2^53`
- `mapRolePermissions maps every bit in the table, one at a time`
- `mapRolePermissions: Reply in threads needs both SEND_MESSAGES_IN_THREADS and CREATE_PUBLIC_THREADS`
- `mapRolePermissions lists lost bits (MODERATE_MEMBERS, PIN_MESSAGES, BYPASS_SLOWMODE, MUTE/MOVE)`
- `mapOverwrite: allow needs all mapped Discord bits, deny needs any; allow and deny never overlap`
- `mapOverwrite drops Create Invite and non-channel bits from overrides`
- `planFromTemplate(sample): @everyone is 98767 (Hearth's DEFAULT_EVERYONE)` (now 1147343, see "Built so far")
- `planFromTemplate(sample): roles keep Discord order as positions 1..6 with mapped bits` (Appendix A.2 table)
- `planFromTemplate(sample): colours, hoist, mentionable and unicode role icons carry over`
- `planFromTemplate(sample): categories in Discord order, uncategorised text first under "Text", empty "Archive" skipped`
- `planFromTemplate(sample): text names cleaned like cleanChannelName; 公告 becomes channel-8`
- `planFromTemplate(sample): stage becomes voice with @everyone denied Speak and stage moderators allowed`
- `planFromTemplate(sample): announcement and forum become text channels with notes`
- `planFromTemplate(sample): member overwrite, NSFW, user limit and category permissions are reported, not applied`
- `planFromTemplate(sample): a denied Read Message History is reported as widened`
- `planFromTemplate: duplicate category names become "Name (2)", compared without case`
- `planFromTemplate: 120 roles keeps the highest 99 and reports 21; their overwrites are dropped`
- `planFromTemplate: 501 channels or 51 categories refuses with too_many_*`
- `planFromTemplate: skipRoles and skipChannels remove items and the overwrites that point at them`
- `planFromTemplate: @everyone with Administrator is marked dangerous`
- `planFromTemplate accepts the bare serialized_source_guild and the guild-script shape (@everyone = guild id)`
- `planFromTemplate is deterministic`
- `parseTemplate survives hostile input (__proto__ keys, wrong types, 10 MB strings, deep nesting) without throwing anything but ImportError`

### 9.2 `test/discord-import-routes.test.js` (real server via `test/helpers.js` `startServer`, with a local HTTP stub and `DISCORD_API_BASE=http://127.0.0.1:<port>/api/v10`, `DISCORD_IMPORT_ALLOW_PRIVATE=1`)

- `preview of a pasted template returns the plan and creates nothing`
- `import creates server, roles, channels, overrides and category order in one transaction; importer owns it`
- `after import, a member with Muted can't post in #general, @everyone can't post in #rules, only Moderator sees #mod-chat`. Join via invite, assign roles with `PUT /servers/:id/members/:uid/roles`, then probe `POST /channels/:id/messages` / `GET /channels/:id/messages`.
- `stage channel: plain members join listen-only (voice:join canSpeak false), Moderator can speak`
- `template link is fetched once (cache) through the guard with the DiscordBot user agent and no Authorization header`
- `Discord 404 → template_not_found; 429 → discord_busy with Retry-After and no further calls until it passes; redirects are not followed`
- `features.discordImport = 'paste' never contacts Discord; 'off' hides both routes`
- `createServers = 'staff' applies to imports too`
- `the sixth import in an hour is refused with 429`
- `malformed template → 400 bad_template; over 2 MB → 413 too_large`
- `@everyone Administrator needs allowEveryoneAdmin`
- `audit log has a server_import entry; GET /servers/:id/imports lists it for managers only`

### 9.3 `test/discord-import-emoji.test.js` (local CDN stub, `DISCORD_CDN_BASE`)

- `imports emoji: metadata stripped, counted in the importer's storage, animated GIF detected`
- `existing names get _2; a Discord emoji imported twice is reported as exists`
- `stops at 200 emoji with status limit`
- `refuses non-image bytes, files over 512 KB and any path other than /emojis/<id>.(png|gif)`
- `needs Manage Emoji; paste-only setting refuses server fetches`
- `server icon import replaces the icon and removes the old file`

### 9.4 `test/discord-history.test.js` (pure; dynamic import of `public/js/discord-history.js`, like `test/search-query.test.js`)

- `parseExport reads the DCE fixture and refuses non-exports and DM exports`
- `system messages are skipped and counted; Reply keeps its reference`
- `payload carries imp fields and a fallback text; total stays under 45,000 bytes for a 4,000-character message`
- `custom emoji are rewritten only when the name is in inlineEmojis and mapped`
- `raw mention tokens become plain names; Hearth role-mention syntax never survives`
- `reactions, attachments, stickers and embeds are summarised and capped; embed links must be https`

### 9.5 `test/import-crypto.test.js` (real `public/js/e2ee.js` in Node, as `test/crypto.test.js` does)

- `an imported message decrypts with its imp block and verifies as the importer's`
- `changing the original author or time inside the ciphertext breaks decryption`
- `importSourceTag is stable for the same key, server and import, and differs across imports and keys`

### 9.6 `test/discord-history-routes.test.js` (real server; the client crypto in Node to make real `c2:` ciphertexts)

- `batches land with their original times, ordered by id, before newer native messages`
- `no web push, no mention marks, no bot message.created events, no read-state change`
- `retrying a batch creates no duplicates`
- `replyToSrc and threadSrc resolve within the import and channel only`
- `a stale epoch gives 409 stale-key; a finished import refuses more; one running import per server`
- `only Manage Server plus Send in every target channel can start or continue an import`
- `PATCH on an imported message gives 409 imported`
- `undo removes imported messages, their reactions and source map; native messages stay`
- `limits: 101 items → 400; over the declared total → 400; times before 2015 → 400; batch rate → 429`
- `admin activity counts ignore imported messages`

### 9.7 Browser (outside CI, `npm run test:e2e`)

`test/e2e/discord-import.mjs`:
- Owner imports the template.
- A member joins.
- The owner imports the DCE fixture.
- The member sees "Imported from Discord by @owner · original author not verified" and no notification.

Also add the import modal to `test/a11y`.

---

## 10. Docs to update

- `README.md`: a new section "Moving from Discord" (template link → preview → create; emoji; history with DCE + bot token; limits; consent).
- `docs/IMPORT.md` (new): user guide, the full §5.3 mapping table, channel-type table, note codes, the paste path and the bot-script path, the phase-3 label and limits.
- `SECURITY.md`:
  - **§3 new rows:**
    - imported message impersonation (label, no profile link, signature = importer);
    - who can import and the limits;
    - template-fetch SSRF (row 31 callers);
    - mapping never grants more than Discord did, with widened permissions warned.
  - **§4 new limits:**
    - imported authorship and time are unverifiable;
    - newcomers after a key change can't read imported history (unless 3b);
    - Discord sees the instance IP for template, CDN emoji and icon fetches;
    - the server learns import counts and original timestamps;
    - third-party consent.
- `docs/ARCHITECTURE.md`:
  - §3: the v19 tables and `messages.import_id`; schema 19;
  - §7: the `imports.sweep` job;
  - §8: outbound rows for the template fetch and CDN emoji / icon;
  - §4: "imported history" paragraph.
- `docs/ROUTES.md`: the new routes (regenerate with the grep in its header note).
- `docs/BOTS.md`: imported messages don't emit events.
- `docs/OPERATIONS.md`: the `discordImport` feature switch and env vars.
- `.env.example`: `DISCORD_API_BASE`, `DISCORD_CDN_BASE`, `DISCORD_IMPORT_ALLOW_PRIVATE` (tests only), `HEARTH_IMPORT_MAX_MESSAGES`.
- `docs/NEXT.md`: progress note under pick 9.
- `docs/ENGINEERING-REPORT.md`: work log.
- `docs/RECOVERY.md`: the schema 19 rollback note.

---

## 11. Proposed SECURITY.md contract rows (wording draft)

| # | Attack | Expected result | Proven by |
|---|---|---|---|
| 92 | An imported message passes itself off as a real person | Imported history shows the Discord name with "Imported from Discord by @importer · original author not verified". It never links to a Hearth profile, never pings, and only the importer's signature is checked. A normal message that carries import fields is shown as an ordinary message from its real poster | `discord-history-routes.test.js`, `import-crypto.test.js` |
| 93 | Someone imports history they shouldn't | Needs Manage Server and Send in every target channel; one running import per server; batch, hourly and total caps; undo by the importer or owner; audit-logged | `discord-history-routes.test.js` |
| 94 | A template link is used to reach inside the network | Only `https://discord.com/api/v10/guilds/templates/<code>` through the outbound guard, no redirects, 1 MB, 10 s; emoji only from `cdn.discordapp.com/emojis/<id>.png\|gif` | `discord-import-routes.test.js`, `discord-import-emoji.test.js` |
| 95 | An imported template grants more than Discord did | A Hearth permission is allowed only if every Discord permission behind it is; denied if any is; member overrides dropped; whatever Hearth can't restrict is listed before creating | `discord-map.test.js` |

---

## 12. Risks

- **Template access changes:** Discord could require auth, or Cloudflare-block server IPs. Mitigation: the paste and bot-script paths; cache; instance-wide caps; honour 429.
- **Field drift** (`color` → `colors`, ordering): a tolerant parser plus fixtures for both shapes.
- **Permission semantics differ in places** (READ_MESSAGE_HISTORY, thread sending, MODERATE_MEMBERS). Mitigation: conservative mapping plus explicit warnings.
- **Big servers:** `serializeServer` reads overrides **one query per channel** for managers (the `overrides:` line in `serializeServer`). 500 channels means 500 indexed queries per manager update. Acceptable, but a grouped query is a good follow-up (`docs/PERFORMANCE.md`).
- **Browser memory** for big exports. Mitigation: a 50 MB per-file cap and partition advice.
- **Legal and ToS:**
  - Discord's Developer Policy governs API data use ([Developer Policy](https://support-dev.discord.com/hc/articles/25280499088279); not fetchable from here, so the wording is unverified).
  - User-token exports violate Discord's ToS (DCE README).
  - Owners must decide; Hearth never handles tokens.
- **History privacy:** third parties' messages. Mitigation: consent checkbox, labels, undo, docs.
- **Key-rotation readability gap** (§7.10).
- **Phase-3 ids by original time** put imported rows anywhere in the channel's id space. Code that assumes "id ≈ insertion time" (none found beyond paging and read markers, which behave well) could surprise later features, e.g. disappearing messages (NEXT.md pick 11) must use the insertion time, not `created_at`.

## 13. Open questions

1. **Is `GET /guilds/templates/{code}` reachable without auth today?** One curl from a normal network. If not, phase 1 ships the paste-from-bot-script path only, and the link field is hidden.
2. **Does the template's `roles` array come in ascending position order, and does it carry `position`?** Check with a real template.
3. **Default for `features.discordImport`:** `'on'` (recommended: one GET, no user data) or `'paste'` (Hearth never contacts Discord unless the owner opts in)?
4. **Template `is_dirty`:** refuse or just warn? (Proposed: warn.)
5. **User-Agent URL:** which fixed project URL to put in `DiscordBot (<url>, <version>)`? The repo may go private (task #43). Never use the instance's own address.
6. **Phase 3b history keys:** build before phase 3 ships widely?
7. **Should the importer be allowed into non-empty channels?** (Proposed: allowed with a warning.)
8. **Keep empty Discord categories** by adding a placeholder `#archive` channel instead of skipping?
9. **Turn `isPinned` into real Hearth pins** (≤ 50 per channel)?
10. **Instance cap on imported messages per server** (beyond the per-import cap) for disk use?

---

## 14. Build plan (small commits)

Each commit runs `npm test` green.

**Phase 1**
1. `discordmap: pure template parser and permission mapper`. Adds `server/discordmap.js`, `test/fixtures/discord-template.json`, `test/fixtures/discord-guild-script.json`, `test/discord-map.test.js`. No wiring.
2. `db: schema 19 (server_imports, import_map, messages.import_id)`. Changes `server/db.js` and updates `test/quality.test.js` (18 → 19).
3. `imports: preview and create from pasted templates`. Adds `server/imports.js` (paste only), wiring in `server/index.js`, the `FEATURE_DEFAULTS.discordImport` and `PUT /admin/owner` validation, the routes tests (paste cases), and `auditLog`.
4. `imports: fetch template links through netguard`. Link parsing, the guarded fetch, cache, 429 handling, env vars, `.env.example`, stub-based tests.
5. `app: Import from Discord in Add a server`. Adds `public/js/discord-import.js` (input / preview / create / report), `openAddServer` in `public/js/app.js`, and the admin feature chips in `public/js/admin.js`.
6. `docs: Discord structure import`. README, `docs/IMPORT.md`, `docs/ROUTES.md`, SECURITY rows 94–95, ARCHITECTURE §3 and §8.

**Phase 2**

7. `imports: Discord emoji from the CDN`. The route, the emoji map, `DELETE /emojis/:id` cleanup, tests.
8. `imports: server icon from the template`. Route and tests.
9. `app: emoji import (tokens, export files, image files) and icon option`. UI and docs.

**Phase 3**

10. `e2ee: import source tags; secure: imported message fields`. Changes `public/js/e2ee.js` (`importSourceTag`) and `public/js/secure.js` (`cleanImport`, `openGroup`, `importTag`, the `at` choice). Adds `test/import-crypto.test.js`.
11. `discord-history: DCE parser and payload builder`. Adds `public/js/discord-history.js`, `test/fixtures/dce-export.json`, `test/discord-history.test.js`.
12. `imports: history routes`. Start, batches, finish, undo and sources. Changes the `serializeMessage` import fields, the `PATCH /messages/:id` refusal, `forgetMessages` cleanup, the activity-count exclusion and the `imports.sweep` job. Adds `test/discord-history-routes.test.js`.
13. `app: show imported messages`. The `fillMessage` header and flag, `grouped`, `mentionKind`, the edit menu, the `messages:imported` handler, the export block in `public/js/usability.js`, CSS.
14. `app: history import runner`. The settings tab, file mapping, consent, batches with key retry, progress, resume, undo.
15. `docs + e2e: history import`. SECURITY rows 92–93 and §4 limits, README, `docs/IMPORT.md`, `docs/BOTS.md`, the NEXT progress note, ENGINEERING-REPORT, `test/e2e/discord-import.mjs`.
16. (optional, 3b) `history keys for imported archives` (§7.10).

---

## Appendix A: sample template for unit tests (`test/fixtures/discord-template.json`)

- Values follow the documented structure.
- Permission values are strings, as API v8+ serialises them.
- Role array order is ascending position (§13, open question 2).
- Channel ids are placeholder integers; the member overwrite uses a real-looking snowflake to exercise the "drop member overwrite" path.

```json
{
  "code": "hEaRtHtEsT01",
  "name": "Pinecone Club",
  "description": "Template for the Pinecone Club community",
  "usage_count": 3,
  "creator_id": "132837293881950208",
  "creator": { "id": "132837293881950208", "username": "pinecone_admin", "avatar": null, "discriminator": "0", "public_flags": 0 },
  "created_at": "2026-09-30T18:04:11+00:00",
  "updated_at": "2026-10-01T09:12:45+00:00",
  "source_guild_id": "1199887766554433221",
  "serialized_source_guild": {
    "name": "Pinecone Club",
    "description": "Hiking, photos and bad puns",
    "region": "us-west",
    "verification_level": 1,
    "default_message_notifications": 1,
    "explicit_content_filter": 2,
    "preferred_locale": "en-US",
    "afk_timeout": 300,
    "roles": [
      { "id": 0, "name": "@everyone", "permissions": "1799872721571393", "color": 0, "colors": { "primary_color": 0, "secondary_color": null, "tertiary_color": null }, "hoist": false, "mentionable": false, "icon": null, "unicode_emoji": null },
      { "id": 1, "name": "Muted", "permissions": "0", "color": 9807270, "colors": { "primary_color": 9807270, "secondary_color": null, "tertiary_color": null }, "hoist": false, "mentionable": false, "icon": null, "unicode_emoji": null },
      { "id": 2, "name": "Member", "permissions": "0", "color": 0, "colors": { "primary_color": 0, "secondary_color": null, "tertiary_color": null }, "hoist": false, "mentionable": false, "icon": null, "unicode_emoji": null },
      { "id": 3, "name": "Event Host", "permissions": "17600776110336", "color": 3066993, "colors": { "primary_color": 3066993, "secondary_color": null, "tertiary_color": null }, "hoist": true, "mentionable": true, "icon": null, "unicode_emoji": "🎪" },
      { "id": 4, "name": "Builder", "permissions": "8797972070416", "color": 15844367, "colors": { "primary_color": 15844367, "secondary_color": null, "tertiary_color": null }, "hoist": false, "mentionable": false, "icon": null, "unicode_emoji": null },
      { "id": 5, "name": "Moderator", "permissions": "6756516287881350", "color": 3447003, "colors": { "primary_color": 3447003, "secondary_color": null, "tertiary_color": null }, "hoist": true, "mentionable": true, "icon": null, "unicode_emoji": "🛡️" },
      { "id": 6, "name": "Admin", "permissions": "8", "color": 15158332, "colors": { "primary_color": 15158332, "secondary_color": null, "tertiary_color": null }, "hoist": true, "mentionable": false, "icon": null, "unicode_emoji": null }
    ],
    "channels": [
      { "id": 40, "type": 0, "name": "👋・welcome", "position": 0, "topic": "Start here", "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": null,
        "permission_overwrites": [ { "id": 0, "type": 0, "allow": "0", "deny": "309237647424" } ] },
      { "id": 10, "type": 4, "name": "Information", "position": 0, "topic": null, "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": null,
        "permission_overwrites": [ { "id": 0, "type": 0, "allow": "0", "deny": "2048" } ] },
      { "id": 11, "type": 5, "name": "📢・announcements", "position": 0, "topic": "Club news. Follow this channel to get it in your own server.", "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": 10,
        "permission_overwrites": [ { "id": 0, "type": 0, "allow": "0", "deny": "2048" }, { "id": 5, "type": 0, "allow": "133120", "deny": "0" } ] },
      { "id": 12, "type": 0, "name": "rules", "position": 1, "topic": "Be kind. No spoilers for trail reports.", "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": 10,
        "permission_overwrites": [ { "id": 0, "type": 0, "allow": "0", "deny": "309237647424" } ] },
      { "id": 20, "type": 4, "name": "Text Channels", "position": 1, "topic": null, "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": null, "permission_overwrites": [] },
      { "id": 21, "type": 0, "name": "general", "position": 0, "topic": "Talk about anything", "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": 20,
        "permission_overwrites": [ { "id": 1, "type": 0, "allow": "0", "deny": "309239744576" }, { "id": "80351110224678912", "type": 1, "allow": "0", "deny": "2048" } ] },
      { "id": 22, "type": 0, "name": "trail-photos", "position": 1, "topic": "Pictures only, please", "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 30, "parent_id": 20, "permission_overwrites": [] },
      { "id": 23, "type": 0, "name": "mod-chat", "position": 2, "topic": null, "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": 20,
        "permission_overwrites": [ { "id": 0, "type": 0, "allow": "0", "deny": "1024" }, { "id": 5, "type": 0, "allow": "1025", "deny": "0" } ] },
      { "id": 24, "type": 15, "name": "help-forum", "position": 3, "topic": "Ask a question, one post per question.", "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": 20, "permission_overwrites": [] },
      { "id": 25, "type": 0, "name": "公告", "position": 4, "topic": null, "bitrate": 64000, "user_limit": 0, "nsfw": true, "rate_limit_per_user": 0, "parent_id": 20,
        "permission_overwrites": [ { "id": 0, "type": 0, "allow": "0", "deny": "65536" } ] },
      { "id": 30, "type": 4, "name": "Voice Channels", "position": 2, "topic": null, "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": null, "permission_overwrites": [] },
      { "id": 31, "type": 2, "name": "Campfire", "position": 0, "topic": null, "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": 30, "permission_overwrites": [] },
      { "id": 32, "type": 13, "name": "Town Hall", "position": 1, "topic": null, "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": 30, "permission_overwrites": [] },
      { "id": 33, "type": 2, "name": "AFK", "position": 2, "topic": null, "bitrate": 64000, "user_limit": 10, "nsfw": false, "rate_limit_per_user": 0, "parent_id": 30,
        "permission_overwrites": [ { "id": 0, "type": 0, "allow": "0", "deny": "2097152" } ] },
      { "id": 50, "type": 4, "name": "Archive", "position": 3, "topic": null, "bitrate": 64000, "user_limit": 0, "nsfw": false, "rate_limit_per_user": 0, "parent_id": null, "permission_overwrites": [] }
    ],
    "afk_channel_id": 33,
    "system_channel_id": 40,
    "system_channel_flags": 0,
    "icon_hash": "a_1f2e3d4c5b6a79881f2e3d4c5b6a7988"
  },
  "is_dirty": null
}
```

### A.1 How the permission strings were built (Discord bit names)

- **@everyone `1799872721571393`:** CREATE_INSTANT_INVITE, ADD_REACTIONS, STREAM, VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS, ATTACH_FILES, READ_MESSAGE_HISTORY, USE_EXTERNAL_EMOJIS, CONNECT, SPEAK, USE_VAD, CHANGE_NICKNAME, USE_APPLICATION_COMMANDS, REQUEST_TO_SPEAK, CREATE_PUBLIC_THREADS, CREATE_PRIVATE_THREADS, USE_EXTERNAL_STICKERS, SEND_MESSAGES_IN_THREADS, USE_EMBEDDED_ACTIVITIES, USE_SOUNDBOARD, USE_EXTERNAL_SOUNDS, SEND_VOICE_MESSAGES, SEND_POLLS, USE_EXTERNAL_APPS.
- **Event Host `17600776110336`:** MANAGE_EVENTS, CREATE_EVENTS, PRIORITY_SPEAKER, MENTION_EVERYONE.
- **Builder `8797972070416`:** MANAGE_CHANNELS, MANAGE_ROLES, MANAGE_GUILD_EXPRESSIONS, MANAGE_WEBHOOKS, CREATE_GUILD_EXPRESSIONS.
- **Moderator `6756516287881350`:** KICK_MEMBERS, BAN_MEMBERS, MANAGE_MESSAGES, VIEW_AUDIT_LOG, MANAGE_NICKNAMES, MUTE_MEMBERS, MOVE_MEMBERS, MANAGE_THREADS, MODERATE_MEMBERS, PIN_MESSAGES, BYPASS_SLOWMODE, MENTION_EVERYONE. This is above 2^52, so it needs BigInt.
- **Admin `8`:** ADMINISTRATOR.
- **Overwrites:**
  - `2048` = SEND_MESSAGES; `1024` = VIEW_CHANNEL; `2097152` = SPEAK; `65536` = READ_MESSAGE_HISTORY;
  - `133120` = SEND_MESSAGES + MENTION_EVERYONE; `1025` = VIEW_CHANNEL + CREATE_INSTANT_INVITE;
  - `309237647424` = SEND_MESSAGES + ADD_REACTIONS + CREATE_PUBLIC_THREADS + SEND_MESSAGES_IN_THREADS;
  - `309239744576` = the same + SPEAK.

### A.2 Expected plan (checked with a throwaway prototype of the rules above)

- **@everyone** → `98767` (= Hearth `DEFAULT_EVERYONE`; now `1147343` with Change Nickname, which is no longer lost: see "Built so far"). Lost: USE_EXTERNAL_EMOJIS, CHANGE_NICKNAME, REQUEST_TO_SPEAK, CREATE_PRIVATE_THREADS, USE_EXTERNAL_STICKERS, USE_SOUNDBOARD, USE_EXTERNAL_SOUNDS, USE_EXTERNAL_APPS. No widened warnings (everyone has all of the widenable bits).

| key | Hearth role | pos | colour | icon | hoist / mention | Hearth perms | lost |
|---|---|---|---|---|---|---|---|
| 1 | Muted | 1 | `#95a5a6` | | no / no | 0 | — |
| 2 | Member | 2 | `''` | | no / no | 0 | — |
| 3 | Event Host | 3 | `#2ecc71` | 🎪 | yes / yes | 16 (MENTION_EVERYONE) | PRIORITY_SPEAKER, MANAGE_EVENTS, CREATE_EVENTS |
| 4 | Builder | 4 | `#f1c40f` | | no / no | 22528 (MANAGE_CHANNELS + MANAGE_ROLES + MANAGE_EMOJIS) | MANAGE_WEBHOOKS, CREATE_GUILD_EXPRESSIONS |
| 5 | Moderator | 5 | `#3498db` | 🛡️ | yes / yes | 1584 (MENTION_EVERYONE + MANAGE_MESSAGES + KICK + BAN) | VIEW_AUDIT_LOG, MUTE_MEMBERS, MOVE_MEMBERS, MANAGE_NICKNAMES, MANAGE_THREADS, MODERATE_MEMBERS, PIN_MESSAGES, BYPASS_SLOWMODE |
| 6 | Admin | 6 | `#e74c3c` | | yes / no | 1073741824 (ADMINISTRATOR) | — |

- `categoryOrder` = `["Text", "Information", "Text Channels", "Voice Channels"]`. "Archive" is skipped (`empty`).

| pos | key | Hearth channel | type | category | overrides (target: allow / deny) | notes |
|---|---|---|---|---|---|---|
| 0 | 40 | welcome | text | Text | everyone: 0 / 32774 | renamed |
| 1 | 11 | announcements | text | Information | everyone: 0 / 2; role 5: 18 / 0 | renamed, announcement |
| 2 | 12 | rules | text | Information | everyone: 0 / 32774 | — |
| 3 | 21 | general | text | Text Channels | role 1: 0 / 32902 | member_overwrite_dropped |
| 4 | 22 | trail-photos | text (slowmode 30) | Text Channels | — | — |
| 5 | 23 | mod-chat | text | Text Channels | everyone: 0 / 1; role 5: 1 / 0 | invite_override_dropped |
| 6 | 24 | help-forum | text | Text Channels | — | forum |
| 7 | 25 | channel-8 | text | Text Channels | — (READ_MESSAGE_HISTORY has no Hearth bit) | renamed, nsfw_dropped, widened:READ_MESSAGE_HISTORY |
| 8 | 31 | Campfire | voice | Voice Channels | — | — |
| 9 | 32 | Town Hall | voice | Voice Channels | everyone: 0 / 128; role 4: 128 / 0; role 5: 128 / 0 | stage |
| 10 | 33 | AFK | voice | Voice Channels | everyone: 0 / 128 | user_limit_dropped |

- **Report** includes:
  - warning `category_permissions_dropped:Information`;
  - `unmapped`: verification_level 1, explicit_content_filter 2, default_message_notifications 1, afk_channel_id, system_channel_id.
- `meta.iconHash` = `a_1f2e3d4c5b6a79881f2e3d4c5b6a7988` (offered in phase 2 as `.gif`).

## Appendix B: sample DCE export (`test/fixtures/dce-export.json`)

```json
{
  "guild": { "id": "1199887766554433221", "name": "Pinecone Club", "iconUrl": "https://cdn.discordapp.com/icons/1199887766554433221/a_1f2e3d4c5b6a79881f2e3d4c5b6a7988.png" },
  "channel": { "id": "1200000000000000021", "type": "GuildTextChat", "categoryId": "1200000000000000020", "category": "Text Channels", "name": "general", "topic": "Talk about anything" },
  "dateRange": { "after": null, "before": null },
  "exportedAt": "2026-10-01T10:00:00+00:00",
  "messages": [
    { "id": "1201000000000000001", "type": "GuildMemberJoin", "timestamp": "2024-03-01T17:00:00+00:00", "timestampEdited": null, "callEndedTimestamp": null, "isPinned": false,
      "content": "Joined the server.",
      "author": { "id": "222222222222222222", "name": "birch", "discriminator": "0000", "nickname": "Birch", "color": null, "isBot": false, "roles": [], "avatarUrl": "https://cdn.discordapp.com/embed/avatars/1.png" },
      "attachments": [], "embeds": [], "stickers": [], "reactions": [], "mentions": [], "inlineEmojis": [] },
    { "id": "1201000000000000002", "type": "Default", "timestamp": "2024-03-01T17:05:12.345+00:00", "timestampEdited": "2024-03-01T17:06:00+00:00", "callEndedTimestamp": null, "isPinned": true,
      "content": "Trail report: the ridge is clear :pinecone: @everyone",
      "author": { "id": "80351110224678912", "name": "maple", "discriminator": "0000", "nickname": "Maple", "color": "#3498DB", "isBot": false,
        "roles": [ { "id": "1200000000000000005", "name": "Moderator", "color": "#3498DB", "position": 5 } ], "avatarUrl": "https://cdn.discordapp.com/embed/avatars/0.png" },
      "attachments": [ { "id": "1201000000000000099", "url": "https://cdn.discordapp.com/attachments/1200000000000000021/1201000000000000099/ridge.jpg?ex=6700000a&is=66fe0000&hm=00ff", "fileName": "ridge.jpg", "fileSizeBytes": 482113 } ],
      "embeds": [], "stickers": [],
      "reactions": [
        { "emoji": { "id": "", "name": "👍", "code": "thumbsup", "isAnimated": false, "imageUrl": "https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/1f44d.svg" }, "count": 3, "users": [] },
        { "emoji": { "id": "1199000000000000001", "name": "pinecone", "code": "pinecone", "isAnimated": false, "imageUrl": "https://cdn.discordapp.com/emojis/1199000000000000001.png" }, "count": 1, "users": [] }
      ],
      "mentions": [],
      "inlineEmojis": [ { "id": "1199000000000000001", "name": "pinecone", "code": "pinecone", "isAnimated": false, "imageUrl": "https://cdn.discordapp.com/emojis/1199000000000000001.png" } ] },
    { "id": "1201000000000000003", "type": "Reply", "timestamp": "2024-03-01T17:09:40+00:00", "timestampEdited": null, "callEndedTimestamp": null, "isPinned": false,
      "content": "Thanks @Maple! <@80351110224678912>",
      "author": { "id": "222222222222222222", "name": "birch", "discriminator": "0000", "nickname": "Birch", "color": null, "isBot": false, "roles": [], "avatarUrl": "https://cdn.discordapp.com/embed/avatars/1.png" },
      "attachments": [], "embeds": [], "stickers": [], "reactions": [],
      "mentions": [ { "id": "80351110224678912", "name": "maple", "discriminator": "0000", "nickname": "Maple", "color": "#3498DB", "isBot": false, "roles": [], "avatarUrl": "https://cdn.discordapp.com/embed/avatars/0.png" } ],
      "reference": { "type": "Default", "messageId": "1201000000000000002", "channelId": "1200000000000000021", "guildId": "1199887766554433221" },
      "inlineEmojis": [] }
  ],
  "messageCount": 3
}
```

Expected `buildItems(exp, { emojiMap: { '1199000000000000001': { id: 'mh8x2k3p0a1b2c3d4e5', animated: false } } })`:
- `skipped.system === 1` (GuildMemberJoin).
- **Item 1** (src `1201000000000000002`):
  - `imp.a === 'Maple'`, `imp.u === 'maple'`, `imp.ai === '80351110224678912'`;
  - `imp.at === Date.parse('2024-03-01T17:05:12.345+00:00')`, `imp.ed === Date.parse('2024-03-01T17:06:00+00:00')`, `imp.pin === true`;
  - `imp.t === 'Trail report: the ridge is clear <:pinecone:mh8x2k3p0a1b2c3d4e5> @everyone'`;
  - `imp.r` deep-equals `[['👍', 3], ['<:pinecone:mh8x2k3p0a1b2c3d4e5>', 1]]`;
  - `imp.att` deep-equals `[['ridge.jpg', 482113]]`;
  - `t` starts with `'[Imported from Discord] Maple · 2024-03-01 17:05 UTC\n'`.
- **Item 2** (src `1201000000000000003`):
  - `replyToSrcId === '1201000000000000002'`;
  - `imp.t === 'Thanks @Maple! @Maple'` (the raw `<@id>` resolved from `mentions`).
