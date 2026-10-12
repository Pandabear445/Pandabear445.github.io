# Bots and integrations

Hearth bots are programs that act in a server with only the access its owner approves. A bot can post
messages, add reactions, offer slash commands and hear about what happens through signed webhooks. The code is
in `server/bots.js` (server), `public/js/bots.js` (app) and `scripts/example-bot.js` (a working example).

## 1. What a bot can and can't see

Channel messages from people are **end-to-end encrypted**. The server only stores ciphertext, so it has nothing
readable to give a bot, and bots never get the server key (they aren't members). This sets hard limits:

- A bot **never** gets the text of people's messages, in events or through the API. It gets *metadata*: message
  ids, authors, channels and times.
- The only plaintext a bot gets from a person is what that person deliberately sends it with a **slash
  command**. The app warns first: "What you type after /roll goes to Dice without end-to-end encryption."
- **Bot messages are not end-to-end encrypted.** The server stores them sealed with its at-rest key (like the
  news bot's posts), and the app marks them "Bot · not end-to-end encrypted".
- A bot can't read DMs or group chats, and can't be added to a group chat.

## 2. Concepts

| Thing | What it is |
|---|---|
| **Bot** | An account (`users.is_bot = 1`, it can never sign in) plus a `bots` row: name, description, owner, webhook address and secret, the scopes it asks for, and whether it's listed. |
| **Installation** | A bot added to one server (`bot_installations`): the scopes and channels that server approved, on/off, and health. |
| **Scopes** | What an installation may do. Nothing by default. A server can only grant scopes the bot asks for. |
| **Channel allow-list** | `"*"` (every channel @everyone can see, including ones made later) or a list of channel ids the installer picked. Private channels must be listed by someone who can see them. |
| **Token** | `hb_<16 hex>.<43 base64url>`, 256 random bits. Whole-bot, or limited to one installation. |
| **Webhook** | An https address Hearth POSTs signed events to. |
| **Built-in news bot** | `server/newsbot.js`, unchanged. It keeps its own tables (`feeds`) and tab, and is listed under "Built in" in Server settings → Bots. |

Who can do what:

- **Make a bot:** set by the instance owner in Admin → Owner → "Who can make bots": admins (default), staff,
  or everyone.
- **Add a bot to a server:** the server owner or anyone with **Manage Server**, after approving the scopes and
  channels in a dialog. They can add their own bots and bots that are *listed* on the instance.
- **Change access:** taking access away is immediate. Adding scopes or channels needs approval again.
- **Pause, remove:** the same people, any time. Removing deletes the installation's tokens and pending events.
- **Switch a bot off everywhere:** its owner, or an instance admin (audit-logged).

## 3. Scopes

| Scope | Allows |
|---|---|
| `messages.send` | Posting, editing and deleting **its own** plaintext messages in allowed channels. Answering a slash command publicly. |
| `messages.read.metadata` | `message.created`, `message.deleted` and `reaction.added` events, and `GET /channels/:id/messages` (metadata only) for allowed channels. |
| `channels.read` | `GET /installations/:id/channels` (names, topics) and `channel.created` / `channel.deleted` events, for allowed channels. |
| `members.read` | `GET /installations/:id/members` and `member.joined` / `member.left` events. |
| `reactions.write` | Adding and removing its own reactions in allowed channels. |
| `commands` | Its slash commands are offered in allowed channels, and it gets `command.invoked`. |
| `webhooks.manage` | Choosing which events it gets, and listing and retrying its failed deliveries, through the API. |

Every API call and every event checks the scope and the channel allow-list on the server.

## 4. Tokens

- Shown **once**, when the bot is made or a new token is issued. Only `SHA-256(id.secret)` is stored.
- Send it as `Authorization: Bot <token>`. A token in the address (`?token=…`, or anything that looks like
  `hb_…` in the query string) is refused with `400 token_in_url`, even when it's right.
- **Rotate** (Server settings → Bots → Your bots → "New token (rotate)", or `POST /api/bots/:id/tokens` with
  `rotate: true`): needs your password (and two-factor code). The new token is issued and the old ones of the
  same kind are revoked in one step.
- **Revoke** any token at any time; it stops working on the next request.
- **One-server tokens** (`installationId`) only work for that installation. They can't register commands.
  They're deleted when the bot is removed from that server.
- Making, rotating and revoking tokens is recorded in the audit log, by token id, never the token.
- Hearth never logs tokens. Keep them out of git, chat and URLs.

## 5. Bot API reference

Base URL: `https://<your hearth>/api/bot/v1`. JSON in and out. Every error looks like
`{ "error": "A sentence for people", "code": "machine_code" }`.

| Code | Status | Meaning |
|---|---|---|
| `bad_token` | 401 | Missing, malformed, wrong, rotated or revoked token. |
| `token_in_url` | 400 | The token was in the address. |
| `bot_disabled` | 403 | The bot was switched off. |
| `not_installed` | 404 | The bot isn't in that server (or the token is for another installation). |
| `installation_paused` | 403 | The server paused it. |
| `missing_scope` | 403 | The installation didn't grant the scope. |
| `channel_not_allowed` | 403 | The channel isn't on the installation's allow-list. |
| `not_author` | 403 | Bots can only edit or delete their own messages. |
| `bad_content`, `too_long`, `blocked_word` | 400 | Empty, more than 2000 characters, or caught by the instance word filter. |
| `bad_commands`, `bot_token_needed` | 400, 403 | Command definitions are wrong / need a whole-bot token. |
| `unknown_interaction`, `interaction_expired` | 404, 410 | No such interaction for this bot / answered or timed out already. |
| `rate_limited` | 429 | Too many requests. `Retry-After` says how many seconds to wait. |
| `not_found` | 404 | No such route or object. |

### Identity and installations

- `GET /me` → `{ id, username, name, description, avatar, requestedScopes, token: { id, installationId }, webhook }`
- `GET /installations` → `{ installations: [{ id, serverId, serverName, scopes, allChannels, channelIds, events, enabled, createdAt }] }`
- `GET /installations/:id/channels` (`channels.read`) → `{ channels: [{ id, name, type, topic, category }] }`
- `GET /installations/:id/members?after=<userId>` (`members.read`) → `{ members: [{ id, username, displayName, nickname, joinedAt }], next }` (1000 per page; `nickname` is what they go by in this server, or null)

### Messages

- `GET /channels/:id/messages?before=<id>&limit=50` (`messages.read.metadata`) →
  `{ messages: [{ messageId, channelId, authorId, authorIsBot, createdAt, editedAt, threadId, replyTo, expiresAt }] }`
  (`expiresAt`: when a message in a channel with disappearing messages goes, or `null`; messages whose time has passed
  are never listed, and acting on one is 404)
- `POST /channels/:id/messages` (`messages.send`) `{ content, replyTo? }` → `{ message: { …metadata, content } }`
- `PATCH /messages/:id` (`messages.send`, own only) `{ content }`
- `DELETE /messages/:id` (`messages.send`, own only)
- `PUT /messages/:id/reactions/:emoji` / `DELETE …` (`reactions.write`; emoji URL-encoded, up to 64 characters)

Content is Markdown, up to 2000 characters, and goes through the instance word filter.

### Commands and interactions

- `GET /commands` → `{ commands }`
- `PUT /commands` `{ commands: [...] }` replaces the whole list (whole-bot token only). See section 7.
- `POST /interactions/:id/callback` `{ content, ephemeral? }`: answers a slash command (section 7).

### Deliveries (`webhooks.manage`)

- `PUT /installations/:id/events` `{ events: ["message.created", …] }` or `{ events: null }` for everything the
  scopes allow.
- `GET /installations/:id/deliveries` → `{ recent: [...], dead: [...] }`
- `POST /installations/:id/deliveries/retry` `{ ids? }`: retries dead letters (all of them without `ids`).

## 6. Events (webhooks)

Hearth POSTs each event to the bot's webhook address as JSON:

```json
{
  "v": 1,
  "id": "0mv2sowmv55f9a68b0b",
  "type": "message.created",
  "createdAt": 1791660986167,
  "botId": "…", "installationId": "…", "serverId": "…",
  "data": { "messageId": "…", "channelId": "…", "authorId": "…", "authorIsBot": false, "createdAt": 1791660986160, "editedAt": null, "threadId": null, "replyTo": null, "expiresAt": null }
}
```

Headers: `X-Hearth-Event`, `X-Hearth-Delivery` (the same as `id`), `X-Hearth-Timestamp` (Unix seconds, new for
each attempt), `X-Hearth-Signature: v1=<hex>`, `Content-Type: application/json`.

| Type | Needs | `data` |
|---|---|---|
| `message.created` | `messages.read.metadata`, channel allowed | `messageId, channelId, authorId, authorIsBot, createdAt, editedAt, threadId, replyTo, expiresAt` (`expiresAt`: when it disappears, in a channel with disappearing messages; else `null`) |
| `message.deleted` | `messages.read.metadata`, channel allowed | `messageId, channelId, authorId, threadId, deletedBy` (one per message, also for a moderator's bulk delete and a ban's message cleanup; a disappearing message that reached its time comes with `deletedBy: null, expired: true`) |
| `reaction.added` | `messages.read.metadata`, channel allowed | `messageId, channelId, userId, emoji` |
| `member.joined` | `members.read` | `serverId, userId, joinedAt` |
| `member.left` | `members.read` | `serverId, userId` |
| `channel.created` | `channels.read`, channel allowed | `channelId, name, type, category` |
| `channel.deleted` | `channels.read`, channel allowed (checked before it's deleted) | `channelId, name, type` |
| `bot.installed` | always | `serverId, serverName, scopes, channelIds, allChannels, installedBy` |
| `bot.uninstalled` | always | `serverId` |
| `command.invoked` | `commands`, channel allowed | `interactionId, command, args, channelId, userId, respondBy` |

Rules Hearth keeps:

- **Never about a channel the installation can't see.** With `"*"`, a channel that @everyone can't view is left
  out, even if it was public when the bot was added.
- **No content**, ever, except the arguments a person typed into one of this bot's commands.
- **No loops:** a bot never gets events about its own actions (its posts, deletes, reactions). Other bots do,
  with `authorIsBot: true`; ignore those if you don't want bots talking to each other.

### Verifying the signature

The signature is HMAC-SHA256 over `"<X-Hearth-Timestamp>.<raw body>"`, keyed with the webhook secret. Check it
against the **raw bytes** before parsing, compare in constant time, and refuse timestamps more than 5 minutes
away (the replay window). From `scripts/example-bot.js`:

```js
const crypto = require('crypto');
function verify(secret, headers, rawBody, { now = Date.now(), windowSec = 300 } = {}) {
  const ts = String(headers['x-hearth-timestamp'] || '');
  const sig = String(headers['x-hearth-signature'] || '');
  if (!/^\d{1,12}$/.test(ts) || !sig.startsWith('v1=')) return false;
  if (Math.abs(now / 1000 - Number(ts)) > windowSec) return false;
  const want = crypto.createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest();
  const got = Buffer.from(sig.slice(3), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
```

Also drop deliveries whose `id` you've already handled: a retry reuses the id (with a new timestamp).
A new webhook secret (shown once, needs your password) takes effect on the next delivery.

### Delivery, retries and dead letters

- Hearth answers only to **https** addresses on the **public internet**. Webhook addresses go through
  `server/netguard.js` when they're saved and again on every request: private, loopback, link-local (cloud
  metadata) and this server's own addresses are refused, DNS answers are pinned, and redirects aren't followed
  (a 3xx counts as a failure). `BOT_WEBHOOK_ALLOW_PRIVATE=1` lets an admin allow private addresses (for a bot
  on the same network).
- Answer with any **2xx** within **5 seconds**; do the work afterwards. Anything else is a failure.
- Failures are retried up to **6 attempts** in total, waiting about 15 s, 30 s, 1 min, 2 min and 4 min (each
  ±25%, so retries from many bots don't line up). Then the event goes to the **dead-letter list**.
- The installer sees recent deliveries and dead letters in Server settings → Bots → Deliveries, with "Retry",
  "Retry all" and "Clear". With `webhooks.manage`, the bot can list and retry them through the API.
- At most **4 deliveries per bot** are in flight at once; the rest wait their turn.
- Delivered events are kept 3 days, dead letters 30 days, at most 500 per bot.
- **Health** comes from the last delivery or API call that worked, not from the bot existing: "Working",
  "Failing" (the last failure is newer than the last success), "Not heard from yet", or "Paused".

## 7. Slash commands

Register them with a whole-bot token:

```json
PUT /api/bot/v1/commands
{ "commands": [
  { "name": "roll", "description": "Roll a die",
    "options": [{ "name": "sides", "type": "number", "required": false, "description": "How many sides" }] },
  { "name": "purge", "description": "Moderators only", "permission": "MANAGE_MESSAGES" }
] }
```

- Up to 25 commands. Names are 1–32 lowercase letters, numbers, `-` and `_`.
- Up to 10 arguments each, of type `string`, `number`, `user` (someone in the server; sent as their id) or
  `channel` (a channel the person can see; sent as its id). Required ones come first.
- `permission`: a permission name from `server/perms.js` (like `MANAGE_MESSAGES`). Only people who have it in
  that channel see and can run the command. Running any command also needs Send Messages.

In the app, typing `/` in a channel's composer lists the commands of the bots added to that server (with the
`commands` scope and the channel allowed). The bar above the composer shows the usage, checks the arguments,
and says that the text goes to the bot without end-to-end encryption. The first time a person uses a bot's
command, a dialog asks them to confirm. The server refuses the call unless the app says the warning was shown
(`ack: true`) and checks the arguments again.

Hearth then sends `command.invoked` **once** (no retries: the person is waiting) and is not stored. The bot answers
within **10 seconds**:

```json
POST /api/bot/v1/interactions/<interactionId>/callback
{ "content": "🎲 rolled **4**" }                    // posted in the channel (needs messages.send)
{ "content": "Only you see this", "ephemeral": true } // only the person who ran it sees it
```

An ephemeral answer goes over the invoker's own connection and is never stored. If nothing arrives in time, the
person sees "Dice didn't answer". One answer per interaction.

No bot code ever runs inside Hearth: commands are only forwarded to the bot's own server.

## 8. Rate limits

| What | Limit |
|---|---|
| Bot API calls | 60 per 10 s and 5000 per hour, per bot |
| Bot messages | 10 per 10 s per channel, 1000 per hour, per bot |
| Bot reactions | 20 per 10 s per bot |
| Registering commands | 10 per minute per bot |
| Requests with a bad token | 30 per minute per address |
| Running commands | 20 per 10 s per person, 60 per 10 s per bot |

Limits are in memory (like the rest of Hearth's) and reset when the server restarts.

## 9. Local development

1. Make a bot in Server settings → Bots → Your bots → "Make a bot". If the option isn't there, an admin can
   allow it in Admin → Owner → "Who can make bots". Save the token and the webhook secret shown.
2. Run the example bot with a certificate, or behind something that does https for it (Caddy, nginx, a tunnel):

   ```sh
   HEARTH_URL=https://chat.example.com BOT_TOKEN=hb_… WEBHOOK_SECRET=… \
   PORT=8443 TLS_CERT=cert.pem TLS_KEY=key.pem node scripts/example-bot.js
   ```

3. Set the bot's webhook address to where it listens, then add it to a server and try `/roll 20`.

For a Hearth and a bot on the same machine or network (development only):

- `BOT_WEBHOOK_ALLOW_PRIVATE=1` in Hearth's environment allows private addresses such as `https://127.0.0.1:8443/`.
- For a self-signed certificate, start Hearth with `NODE_EXTRA_CA_CERTS=/path/to/cert.pem` so it trusts it.
  Hearth never turns certificate checks off.

Tuning (rarely needed): `BOT_WEBHOOK_TIMEOUT_MS` (5000), `BOT_RETRY_BASE_MS` (15000),
`BOT_INTERACTION_TIMEOUT_MS` (10000), `BOT_MAX_CONCURRENCY` (4).

Tests: `test/bots.test.js` (the platform, against local mock HTTPS servers) and `test/bots-example.test.js`
(the example bot as its own process).

## 10. Incoming webhooks (Discord- and Slack-compatible)

For programs that only need to **post**, a channel can have webhook addresses, like Discord's. Uptime Kuma,
Grafana, Home Assistant, Jellyfin, GitHub Actions and most CI tools already post to Discord webhook URLs: paste a
Hearth one instead and they keep working, with no bot to write. The code is in `server/webhooks.js` (server) and
`public/js/webhooks.js` (Channel settings → Webhooks).

```
https://<your hearth>/api/webhooks/<id>/<secret>          Discord-style JSON, Slack-style JSON or form, plain text
https://<your hearth>/api/webhooks/<id>/<secret>/slack    Slack-style (text, attachments, blocks)
https://<your hearth>/api/webhooks/<id>/<secret>/github   a GitHub repository webhook (content type application/json)
```

**Who:** people with **Manage Channels** in that channel (and server-wide), or **Manage Server**, can make, rename,
re-key ("New address") and delete them, in Channel settings → Webhooks (or right-click the channel → Webhooks). Not
in group chats. Up to 10 per channel and 50 per server.

- Making, renaming and re-keying one is posting in that channel through it, so it also needs **Send Messages**
  there. Manage Channels doesn't get around a read-only channel, and a timed-out member can't do any of the three
  until the timeout ends (owners and Administrators have every permission, so this changes nothing for them).
- A webhook belongs to whoever made its **current address** (`created_by`; re-keying moves it to the person who
  re-keyed). Anyone else can rename, re-key, delete it or change its pings only if their highest role is above that
  person's, or that person has left the server. Roles members pick themselves don't count here, on either side, so
  picking one neither protects your webhook nor gets you past someone else's. Hearth has no separate Manage
  Webhooks permission.

**The address is the password.** Its secret (256 random bits) is shown once; only `SHA-256(id.secret)` is kept.
"New address" replaces it at once (the old one stops working). Making, changing, re-keying and deleting are in the
audit log (`webhook_created`, `webhook_changed`, `webhook_token_rotated`, `webhook_deleted`), by id, never the
secret. A wrong id and a wrong secret get the same `404 Unknown Webhook`. Hearth doesn't log full request
addresses, but a proxy in front of it might: keep its access log private, or re-key a webhook if it leaks.

**What a post looks like.** It comes from the webhook's own bot account (`users.is_bot = 1`, no `bots` row: it
can't sign in or use the bot API), with a **BOT** tag and the label **"Webhook · not end-to-end encrypted"**. Like
other bot posts it's stored sealed with the server's at-rest key, not end-to-end encrypted, and shown through the
app's escaping Markdown. What's understood:

| Sent | Becomes |
|---|---|
| `content` (up to 2000) | the text. `[label](https://…)` links show as `label (https://…)`, `<t:…>` as a UTC date, `#` headings as bold. |
| `username` (up to 80) | the name shown on this post: control, invisible and direction characters removed, at most 32 characters, checked by the word filter. The webhook's own name is in the label's tooltip, and its profile opens on click. |
| `avatar_url` | an `https` picture on Discord's (`cdn.discordapp.com`, `media.discordapp.net`), GitHub's (`avatars.githubusercontent.com`, `raw.githubusercontent.com`) or Gravatar's picture hosts, or a host the admin lists in `WEBHOOK_AVATAR_HOSTS`. It's shown through the server's avatar proxy (`/media/avatar`: netguard, images only, and only from those hosts, redirects included), by a link the server signs for that avatar when it sends the post to an app. The server never fetches it when the post arrives; the proxy fetches it when someone's app shows the post. An avatar anywhere else is kept with the post but not shown (the webhook's own picture is), so a webhook can't make the server fetch any picture on the internet. |
| `embeds[]` (up to 10, 6000 characters in all) | text: author, **title** with a coloured dot for `color` (🔴 🟠 🟡 🟢 🔵 🟣), `url`, description, **field name** / value, footer and timestamp (a time with no zone, like Uptime Kuma's `2026-10-11 05:00:00.123`, is UTC). Pictures (image, thumbnail, icons) are left out. |
| `allowed_mentions` | narrows what a webhook that may ping pings, as on Discord. |
| Slack `text`, `attachments[]`, `blocks[]` (header, section, context, rich_text) | the same, from Slack's mrkdwn (`<url\|label>`, `<!here>`, `*bold*`). Rich text (what Slack's composer and Block Kit Builder make) keeps its bold, italic, strike, code, links, emoji, lists, code blocks and quotes. With blocks, `text` is only the fallback, as in Slack: it's shown when none of the blocks is one of these kinds. A form body `payload=<json>` works too. |
| `text/plain` (up to 4000) | the text as it is. |
| GitHub `push`, `pull_request`, `issues`, `issue_comment`, `release`, `star`, `fork` | one line each, like Discord's `/github` address; `ping` and other events are accepted and not shown. |

**Answers** are Discord's: `204` (or the message with `?wait=true`), `400` with `{ message, code }`
(`50006` empty, `50035` Invalid Form Body with the field's path in `errors`, `50109` bad JSON or an unsupported type,
`200000` the word filter), `404 { code: 10015 }`, `413 { code: 40005 }` over 64 KB (1 MB for `/github`),
`429 { retry_after, global: false }` with `Retry-After`, `403 { code: 50001 }` while the webhook is paused (below) and
`403` from a banned address, `408` when the body doesn't arrive within 15 seconds of the request, `503` during
maintenance. `GET` on the address returns `{ type, id, name, channel_id, guild_id }` (never the secret).

The address is checked when the request arrives and the webhook is read again once the body is in, so a request
that was already on its way when the address was re-keyed, the webhook deleted or paused, or its pings turned off,
gets the answer it would get now.

**Pings are off by default.** `@everyone`, `@here`, role mentions and `@names` in a webhook's post are defused before
it's stored (an invisible space after the `@`; a role mention becomes the role's plain name), so nobody is pinged or
counted as mentioned. Only someone with **Mention Everyone** in that channel can turn pings on for a webhook, or get a
new address for one that has them (otherwise re-keying would hand them pings they don't have). Turning pings off is
always allowed. With pings on, mentions work as they would from a member allowed to ping, including push
notifications and mention counts. Either way, people who chose **All messages** for the channel or the server (and
can see the channel) get a push for each post, as for anyone's message. Role names put in place of a defused role
mention lose `<`, `>`, `@` and `&`, so a role named like a mention can't bring one back.

**Limits:** 5 posts per 2 seconds and 1000 per hour per webhook, 30 per minute per channel (from all its webhooks),
300 requests per minute per network, and 30 wrong addresses per minute per network (an IPv4 address, or an IPv6
/64). Managing them: 60 requests per
minute per person, 20 new webhooks per hour and 60 per day (each one is an account), 20 new addresses per hour.

**Pauses.** A paused webhook answers `403 { code: 50001 }` and the list says why. It pauses while the person who
made its current address is suspended on the instance, banned from the server or timed out there (they still know
the address), and while its own account is suspended (what an instance admin does when its posts are reported; the
admin's page for that account shows the webhook and who made its address). A new address from another manager
makes the webhook theirs and starts it again. A webhook keeps working when the person who made it simply leaves
the server (the list says so), as on Discord.

**Lifetime.** Deleting a webhook stops its address for good. While its posts are still in the channel, its row
stays as a tombstone and its account is marked deleted, so those posts keep their author and nothing can post as
it again. When no post of it is left (it never posted, or its channel or server is deleted), the row goes and its
account is wiped like a deleted person's: a freed `deleted-…` username and the name "Deleted webhook". Webhook
accounts aren't counted as users on the admin dashboard and don't appear in the admin's plain user list (searching
finds them, marked as bots).

## 11. Known limits

- Bot avatars: the `avatar` column exists, but there's no upload yet, so bots show their initials.
- Bot messages are text only (Markdown): no attachments or embeds. Webhook embeds are turned into text.
- Webhooks don't take files (multipart bodies are refused), can't edit or delete their posts afterwards, and ignore
  Discord's `thread_id`, `tts` and components.
- Interactions and rate limits are kept in memory, so a restart drops open interactions (the app then says the
  bot didn't answer) and resets counters. A multi-process setup would need a shared store.
- Bots can't post in threads or reply to people privately (DMs).
