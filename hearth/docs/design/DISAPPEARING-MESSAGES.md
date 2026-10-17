# Disappearing messages for DMs, group chats and server channels

Status: design proposal for the release after Hearth 1.28.2. The schema moves from 18 to 19.
It was written against commit `1a4b684`. Paths are relative to `hearth/`.
Line numbers are hints taken from that commit; the function names are what counts.

**Since then** (built; [FEATURES.md](../FEATURES.md) §7 describes the code as it is):
- A server's voice channels have a text chat, and it takes a timer like a text channel (Manage Channels there).
  Only a group's call is refused: 400 `Only text channels and voice channels’ chats have disappearing messages.`
  (`bad_channel`). The "Voice channel" row in §4.1 is superseded.
- Changing a server channel's timer is also a `channel_update` entry in that server's audit log
  (`changes.disappear: { from, to }`); group chats and DMs have no audit log. Messages disappearing aren't logged.
- Scheduled messages ("Send later") carry the timer they were written for: re-encrypting one keeps the stricter of
  that and the conversation's timer at the time (FEATURES.md, Scheduled messages).

---

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| Timer choices | Off, 1 hour, 1 day, 1 week and 4 weeks, stored as `0`, `3600`, `86400`, `604800` and `2419200` seconds. When `NODE_ENV=test`, `5` is also accepted so browser tests can watch a message disappear. |
| Where the setting lives | On the conversation. Server channels and the text channel of a group chat use `channels.disappear_secs`. DMs use `dm_channels.disappear_secs`. |
| Is the timer stored per message? | **Yes.** Every message gets `expires_at`, stamped at send time from the setting in force: `created_at + secs × 1000`. Changing the setting never changes messages already sent (same as Signal and WhatsApp). Edits never move it. A restored backup can't bring an expired message back for longer than the first sweep. |
| When the clock starts | When the server stores the message (`created_at`). The moment is the same for everyone, as in WhatsApp. Signal's "starts when you read it" rule is out of reach (§2). |
| Who may change it | **DM:** either person, except after a block or when the other account was deleted. **Group chat:** any member, the same rule as renaming a group (`PATCH /servers/:id` allows it for `kind='group'`). **Server channel:** Manage Channels in that channel (`requireManageableChannel`). |
| How a change is shown | A system line in the conversation, such as "Alice turned on disappearing messages: 1 week". The app also shows a timer button in the header, a note above the composer, and a small timer on each disappearing message with its deadline. |
| How the system line is stored | In a new table, `disappear_log`, like `pin_log`. It is **not** a fake message row. History pages return the entries that fall inside them. |
| Who deletes | The server. A precise one-shot timer is armed for the next expiry, and a safety sweep runs every 60 s (`messages.expire`). It deletes 500 rows per transaction through new partial indexes. Every route that hands out content also refuses expired rows, even before the sweep runs. |
| What the apps do | Apps hide a message at the earlier of the server's `expiresAt` and `createdAt + x`. `x` is the timer inside the encrypted payload. When a message expires, the app purges its in-memory lists, the decrypted-file cache, the on-device inbox and reminders, open notifications and open search results. |
| Backups | Snapshot copies leave disappearing messages and their files out by default (`BACKUP_DISAPPEARING=skip`). This covers `.hbk` files, `hearth-auto-*.db` and `hearth-before-v*.db`. What stays in other copies is spelled out in §10. |
| Export | "Export my data" leaves disappearing messages out unless the person ticks a box. |
| Forensic traces | `PRAGMA secure_delete = ON`, and `PRAGMA wal_checkpoint(TRUNCATE)` after a sweep that deleted rows (at most every 10 minutes). |

---

## 1. Goals and non-goals

### Goals

1. A per-conversation timer for DMs, group chats and server text channels: off, 1 h, 1 d, 1 w or 4 w.
2. Each message keeps the timer it was sent with, so changes are never retroactive.
3. Expired messages are removed everywhere Hearth controls:
   - the live database, along with their attachment files, reactions, poll votes and closures, mention marks, saved-message entries and pin history;
   - every API response;
   - every open app;
   - the app's on-device caches.
4. People see clearly that a conversation is disappearing, who changed it, and when each message will go.
5. Fit with the existing end-to-end encryption design. The server stays blind to content and learns only the timer (metadata).
6. Be honest in the UI and in SECURITY.md about what this does and doesn't protect against.
7. Backward compatible. Old messages are untouched, and apps on the previous version keep working (§9).

### Non-goals

- Timers that start when each reader reads the message (Signal). The server deletes once, for everyone (§2).
- View-once media, screenshot blocking or screenshot detection. A web page can't do these reliably.
- WhatsApp-style "keep in chat" exceptions.
- A personal default timer for new chats (Signal has one), a per-server default for new channels, an owner-only lock for group chats, and an instance-wide switch or minimum. All are listed in §13 as follow-ups.
- Cryptographic erasure (destroying keys so old copies become unreadable). The group epoch keys and identity keys are long-lived on purpose (SECURITY.md §4, "No forward secrecy for history").
- Scrubbing backups that already exist, off-site copies of earlier backups, or update snapshots made by `scripts/hearth-update.sh`.
- Incoming webhooks (NEXT.md pick #2, not built yet). When that pick is built, it must call the same stamping helper (§6.5).

---

## 2. Prior art, and why Hearth differs

- **Signal.**
  - For messages you send, the timer starts when you send them. For messages you receive, it starts once you've read them. ([Signal support](https://support.signal.org/hc/en-us/articles/360007320771-Set-and-manage-disappearing-messages), [Signal blog, 2016](https://signal.org/blog/disappearing-messages/))
  - Anyone in the chat can change the timer, and group admins can limit who may. ([Signal group chats](https://support.signal.org/hc/articles/360007319331-Group-chats))
  - Signal has a personal default timer for new chats, and custom times up to 4 weeks. ([TechCrunch, 2021](https://techcrunch.com/2021/08/10/signal-disappearing-message-settings))
  - The setting applies to messages sent after it changes.
- **WhatsApp.** In WhatsApp's own FAQ, as reported:
  - a forwarded disappearing message stops expiring in a chat where the feature is off;
  - a backup made before a message disappears keeps it, and restoring deletes it;
  - quoted replies can keep the quoted text after the original is gone.

  Sources: [XDA](https://www.xda-developers.com/whatsapp-publishes-faq-on-upcoming-disappearing-messages-feature/), [WABetaInfo](https://wabetainfo.com/whatsapp-releases-details-about-disappearing-messages/), [PhoneArena](https://www.phonearena.com/news/WhatsApps-Disappearing-Messages-feature-detailed-in-a-FAQ-document_id128175). In groups any participant can toggle it unless admins restrict it ([IOL, 2021](https://iol.co.za/technology/software-and-internet/2021-12-07-whatsapp-to-enable-messages-to-disappear-for-privacy-sake-and-more-honest-conversations/)).
- **Hearth, by comparison.**
  - In Signal and WhatsApp each phone deletes its own copy. In Hearth the server holds the only stored copy (ciphertext) and serves history to every device, so deletion happens once, on the server, for everyone. That is why the clock starts at send time.
  - Hearth's reply quotes are looked up live from the original row (`serializeMessage` → `reply`), so they disappear with it. That is better than WhatsApp's quoted text.
  - Forwarding follows WhatsApp: the copy takes the destination's timer.
  - Backups go one better than both: they leave disappearing messages out by default (§6.9).

---

## 3. Fit with end-to-end encryption and the threat model (honest)

### 3.1 What it achieves

- **A stolen or seized database** (SECURITY.md adversary "Database thief") taken after a message expired doesn't contain it. With `secure_delete` and the WAL truncation, the bytes are overwritten in `hearth.db` and its WAL as well (§6.7.5).
- **A later account takeover** (password plus session, or email reset plus server keys, row 10) can't fetch expired history from the live server.
- **Hearth's own on-device copies go away**: memory, the decrypted-file cache, the inbox and reminders in `localStorage`, notifications, open search results.
- **By default, backups made after this feature never contain disappearing messages** (§6.9). So the backup thief and region-compromise rows (28 and 35) no longer cover them.
- **Bot and news-bot posts** in a disappearing channel are removed too. These are sealed with `secret.key` and readable by the server.

### 3.2 What it does not do

These limits go into SECURITY.md §4 and the in-app explainer.

1. **People can keep what they see.** Screenshots, copy and paste, the "Download" button on files, "Forward", "Export my data" with the box ticked, "Report" (which sends evidence text to staff, §4.4), or a modified app. A disappearing timer is a shared intention, not enforcement.
2. **The server does the deleting.**
   - A malicious or compromised server can skip deleting, keep copies of the ciphertext, or stop the sweep.
   - It can't read end-to-end encrypted content, but it can keep it.
   - Any member whose long-term keys later leak could then read those copies. There is no forward secrecy for history (SECURITY.md §4): members keep every server epoch key, and DMs use static ECDH.
   - Apps still hide messages on time, using the encrypted timer `x` (§3.4).
3. **The server controls message times.**
   - SECURITY.md §4 already says the server can "change its time".
   - The app's deadline is `min(expiresAt, createdAt + x)`. Both values come from the server, so a lying server can make a message live longer on readers' screens.
   - Binding a sender timestamp inside the payload is an open question (§13).
4. **Backups made before this release, plus some other copies, keep everything until they are pruned or deleted:**
   - update snapshots by `hearth-update.sh` in `/root/hearth-backups` (5 kept);
   - off-site rclone copies, which Hearth never prunes;
   - pre-upgrade copies `hearth-before-v*.db` made by versions without the scrub;
   - anything an operator copies by hand;
   - also everything kept while an operator sets `BACKUP_DISAPPEARING=keep` (§10).
5. **Storage forensics below SQLite.**
   - On SSDs (wear levelling), copy-on-write file systems (btrfs, ZFS) and VPS snapshots, overwritten blocks can survive physically.
   - `secure_delete` only overwrites what SQLite controls. ([SQLite pragma docs](https://www.sqlite.org/pragma.html#pragma_secure_delete); on WAL caveats see [antonz.org](https://antonz.org/sqlite-secure-delete/))
6. **Copies outside Hearth's control on people's devices:**
   - operating-system notification history (Android keeps dismissed notifications in its history when the user turned that on);
   - keyboards that learn words;
   - swap;
   - the browser's HTTP disk cache of ciphertext `.bin` files. That cache holds ciphertext only, and the file key lived inside the message. §6.8 asks browsers not to store these at all.
7. **Metadata stays as before.** The server still sees who wrote when, and now also the timer. Report evidence submitted by a reporter is kept with the report (§4.4).

### 3.3 New metadata the server learns

- Each conversation's timer, who changed it and when (`disappear_log`).
- Each message's `expires_at`.

All of this is metadata the server needs in order to delete. ARCHITECTURE.md §4 ("Can read") gets a new bullet.

### 3.4 The encrypted timer `x`, and trust

- The sender's app adds `x: <seconds>` to the encrypted payload. The payload today is `{ t, f, p }`, built in `sendTo` (app.js ~4146) and the composer (~4040).
- `x` is covered by the AEAD and, in channels, by the ECDSA signature (`encryptGroup` signs the whole ciphertext).
- Readers use it as an **upper bound** on the server's deadline.
  - So a server that drops or extends `expires_at` can't make a message stay on readers' screens longer than the sender asked, apart from the `createdAt` caveat in §3.2 (3).
  - When `x` says the message should be gone but the server still serves it, the app hides it and notes that "this server didn't delete a message it should have" (§7.3, low priority).
- The system line ("X turned on…") is **server-asserted**.
  - It comes from `disappear_log`, not from an end-to-end message.
  - A malicious server could invent one or change the setting silently. It is already trusted to carry out the deletion, so this adds little risk.
  - A signed timer change is listed in §13.

---

## 4. Behaviour

### 4.1 Who can set it

| Conversation | Route | Allowed | Refused with |
|---|---|---|---|
| DM (`dm_channels`) | `PUT /api/dms/:id/disappearing` | Either participant (`requireDm`) | 404 for non-participants. 403 `You can’t message this person.` after a block in either direction (`isBlocked`). 403 code `deleted` when the other account is deleted. |
| Group chat (a `servers` row with `kind='group'`, which has one text channel `chat`, created in `POST /groups`) | `PUT /api/channels/:id/disappearing` on the group's text channel | Any member (`requireChannel`) | 404 for non-members |
| Server text channel | `PUT /api/channels/:id/disappearing` | Manage Channels in that channel (`requireManageableChannel`, index.js:2449). A per-channel deny is respected, and a channel you can't see is 404. | 403 `You don’t have permission to manage this channel.` |
| Voice channel | — | — | 400 `Only text channels have disappearing messages.` code `bad_channel` (superseded: a server's voice channels have a chat and take a timer like a text channel; only a group's call is refused, see "Since then" above) |

Timeouts don't apply: Manage Channels isn't in `TALK` (perms.js), and group chats have no timeouts.

### 4.2 How it's shown and changed

- **Menus.**
  - `dmMenuItems` (app.js:1622), `groupMenuItems` (:1634) and `channelMenuItems` (:1754) get a section `{ header: 'Disappearing messages' }`.
  - The section lists five items (Off, 1 hour, 1 day, 1 week, 4 weeks), with `checked` on the current one, built the way the notification levels are.
  - In server channels, people without Manage Channels see one non-clickable line ("Disappearing messages: 1 week") when the timer is on, and nothing when it is off.
- **Channel settings.**
  - `openEditChannel` (app.js:5589), overview tab, gets a `field('Disappearing messages', select, hint)` next to Slowmode.
  - The hint reads: "New messages disappear this long after they’re sent. Messages already here aren’t affected."
  - Save calls the new PUT only if the value changed. It doesn't go through `PATCH /channels/:id`, so every change is logged in one place.
- **Turning it on for the first time** opens `confirmDialog`:
  - Title: "Turn on disappearing messages?"
  - Text: "New messages here will disappear for everyone 1 week after they’re sent. Messages already sent aren’t affected. People can still screenshot, copy, forward or save what they see. This server’s backups `{skip|keep}` messages set to disappear (as the server reports)."
  - The `{skip|keep}` value comes from `/api/config` → `disappearing.backups`.
- **Header.** When the timer is on, `drawHeader` (app.js:2002) adds `ibtn('timer', 'Disappearing messages: 1 week', …)` for channel, group and DM views. It opens the same menu, or info only when the person can't change it. The `timer` icon already exists in `util.js`.
- **Composer.**
  - `createComposer` (app.js:3759) gets a `disNote` next to `slowNote` (:3791).
  - It reads: "{timer icon} New messages disappear after 1 week."
  - It is hidden when the timer is off and updated on `disappear:update`.
- **The conversation's welcome block** (`welcomeBlock`) adds a line under the end-to-end encryption note when the timer is on.
- **On each disappearing message.**
  - In `fillMessage` (app.js:2704), next to the "(edited)" label, add `<span class="msg-exp" title="Disappears {fmtStamp(deadline)}" aria-label="Disappears {…}">{timer icon}</span>`.
  - There is no live countdown (cheaper, and calmer).
- **The system line.**
  - It is drawn inside the message list in time order: `<div class="sys-line" role="note">{timer icon} {text} · {time}</div>`.
  - Text comes from `sysLineText(entry, meId, nameOf)` in the new `public/js/disappear.js`:
    - turned on (`prev == 0`, `secs > 0`): "Alice turned on disappearing messages: 1 week"
    - changed: "Alice changed disappearing messages to 1 day"
    - turned off: "Alice turned off disappearing messages"
  - "You" replaces the name for your own changes, and "Someone" stands in for a deleted account.
- **Optional extras.** A small timer icon next to the channel name in the sidebar, and next to the DM in the DM list.

### 4.3 Sending and stamping

- The app sends `ttl: <its idea of the current setting>` in the POST body and `x` inside the payload (omitted when 0).
- On the server:
  - `ttl` absent or `null`: this is an older app. Stamp from the conversation's setting.
  - `ttl` present and not equal to the setting: 409 `Disappearing messages were just changed here.` with code `disappear_changed`. The app refreshes the setting and re-encrypts with the new `x`, retrying once. This merges with the existing `withKeyRetry` loop, which retries `rotate` and `stale-key` 409s.
  - Otherwise: `expires_at = t + secs × 1000`, where `t` is the same `now()` used for `created_at`.
- **Thread replies:**
  - `expires_at = min(own, root.expires_at)` when the root has one.
  - This applies even when the channel's timer is off now, so a reply never outlives the message that starts its thread. Deleting a root already deletes its thread (`deleteMessageTree`).
  - `ttl` is compared only with the channel's setting. The root cap is the server's job, and readers still use `min()`.
- **Bots and the news bot** are stamped from the channel setting (§6.5). There is no opt-out: the channel's rule covers everything posted there.

### 4.4 How it interacts with existing features

| Feature | Behaviour |
|---|---|
| **Edits** (`PATCH /messages/:id`, `PATCH /dm-messages/:id`; app `editBox` :2969) | `expires_at` never changes. An expired message can't be edited (404). **Client fix needed:** `editBox` builds `payload = { t, f }` and drops `p` and the new `x`. It must keep both: `{ t, f, ...(dec.p && { p: dec.p }), ...(dec.x && { x: dec.x }) }`. |
| **Polls** (`poll_votes`, `poll_closed`; `pollTarget` index.js:4585) | The poll goes with its message. Votes and the closed flag are deleted by the sweep (existing list in `forgetMessages`). Voting on or closing an expired poll gives 404 (`pollTarget` uses `alive`). |
| **Voice messages** | These are attachments with `voice: true` (app `uploadEncryptedFiles` :4110). Their blobs go like any file. An app playing one stops it when the element is removed (§7.3). |
| **Files** | `blobs` rows linked through `attachBlobs` are deleted with the message, and so are their files via `removeUpload`. That also frees quota through `user_files`. Undeclared files were never linked, so `uploads.unlinked_cleanup` already deletes them after 24 h. |
| **Forwarding** (`openForward` :3033) | Allowed. The copy follows the **destination's** timer (its `x` and `ttl`). The copy points at the same blobs (STORAGE.md §6), so **its files stop loading when the original disappears**. The forward dialog says so when the source is disappearing: "This message is set to disappear. Your copy follows the setting where you send it, and its files stop loading when the original disappears." |
| **Replies** (`reply_to`) | A reply keeps its own expiry. When the original is gone, `serializeMessage` and `serializeDmMessage` return `reply: null` and the app shows "Original message was deleted". Change that text to "Original message is no longer available". Apps also clear `m.reply` for expired ids right away (§7.3). |
| **Threads** | Replies are capped at the root's deadline (§4.3). When a root expires its replies go with it (the sweep pulls in `thread_id` children). When replies expire, `thread:update`-style counts are sent in `message:expire.threads`. |
| **Pins** | Pinning a disappearing message is allowed, and the pin goes with it. The sweep also deletes the message's `pin_log` rows (new index), so the channel's pin history doesn't keep ids of disappeared messages. The pin cap (`MAX_PINS = 50`) frees up. |
| **Reactions** | Deleted by the sweep. Reacting to an expired message gives 404. |
| **Saved messages** (`saved_messages`, usability.js) | Saving is allowed, and the saved entry (with its `x1:` note) is **deleted** when the message expires. Each person who saved it gets `saved:update { messageId, saved: false }`. Today a manual delete leaves the saved row and shows "unavailable"; for expiry we delete it. The saved view says "Saved messages from disappearing conversations disappear with them." |
| **Read markers** (`read_states`) | Unchanged. They are ids, and ids sort by time (`newId` in db.js), so `id > lastReadId` still works after the message is gone. The app's `markRead` must send the last **live** message id (§7.3). |
| **Mentions and unread counts** | `mention_marks` rows are deleted by the sweep (existing list). `/me/unread` counts drop on the next fetch. The app debounces a `GET /me/unread` refresh (once per 30 s at most) after an expiry in a conversation that shows a badge. |
| **Push notifications** | They never carry text (`shapePush`), so nothing to do. A tap on one for a message that's gone hits `/messages/:id/locate` → 404 → the existing toast. |
| **In-app and native notifications** (app `notify` :3370; android.js `AppNotification`) | They carry up to 140 characters of decrypted text. They are closed when their message expires (§7.3). The Android app also gets a native timeout so a notification goes away when the app isn't running (§7.5). |
| **Search** (`server/search.js`; app `openSearch` :4491) | The server returns ciphertext only and builds no index. Its load step drops expired rows (§6.6). The app's search is in memory (`scans`, `S.msgs`, `S.threads`), and `messageHits` skips expired messages. There is no on-device search index to purge. |
| **Export** (`/me/export/messages`; client `runExport`) | The server filters out expired rows. The app skips disappearing messages unless the person ticks "Include messages set to disappear (the copies in the zip won’t disappear)". The manifest counts the skipped ones. |
| **Reports** (`POST /reports` index.js:4061) | Reporting a disappearing message stays allowed, so abuse can be reported. The evidence (decrypted text of up to 25 messages, sent by the reporter's app) is stored in `reports.evidence` and **is not removed** when the messages expire. Staff need it. The report dialog (`openReport` :5880) warns: "Reporting sends the text of these messages to this Hearth’s staff, who keep it with the report after the messages disappear here." |
| **Bots** (`server/bots.js`) | Bot posts are stamped. `metaOf` gets `expiresAt`. The bot API's message list and lookups skip expired rows. A new webhook event `messages.expired { channelId, messageIds }` uses the `messages.read.metadata` scope. Bots still never get content. |
| **News bot** (`server/newsbot.js` `post`) | Posts are stamped. A news channel with a 1-hour timer shows the last hour of news. |
| **At-rest sealing** (`seal` in db.js) | Bot, news-bot and legacy bodies are sealed with `secret.key`. Expiry deletes the row; there is no separate key to destroy. `secret.key` is inside every `.hbk`, so a sealed post copied into a backup is readable by anyone who holds the backup key. The default backup scrub keeps disappearing ones out (§6.9). |
| **Legacy pre-E2EE messages** | They predate the feature, have no `expires_at`, and are never touched. |
| **Slowmode, timeouts, read-only channels** | Independent. Timed-out members can't send, so there is nothing to stamp. |
| **Admin "Delete message"** (`DELETE /admin/messages/:id`) | Unchanged. It works on unexpired disappearing messages like any other. |
| **Drafts** (client `createDrafts`) | Not affected. They are the person's own unsent words, cleared on send or sign-out. |

---

## 5. Data model (schema 19)

Add a `// v19 (disappearing)` block in `server/db.js`, before the `if (fromVersion < SCHEMA_VERSION) db.pragma(...)` line at the end of the migration transaction, and bump `SCHEMA_VERSION` to 19.

`ALTER TABLE … ADD COLUMN` with a NULL or constant default doesn't rewrite the table, so this is cheap on big databases. The partial indexes start out empty.

```sql
-- the setting, per conversation
-- (addColumn helper)
addColumn('channels',    'disappear_secs', 'INTEGER NOT NULL DEFAULT 0');
addColumn('dm_channels', 'disappear_secs', 'INTEGER NOT NULL DEFAULT 0');
-- the deadline, per message (NULL = never)
addColumn('messages',    'expires_at', 'INTEGER');
addColumn('dm_messages', 'expires_at', 'INTEGER');
-- copied from the message by attachBlobs: lets /uploads/ answer 404 / no-store with one primary-key lookup
addColumn('blobs',       'expires_at', 'INTEGER');

CREATE INDEX IF NOT EXISTS idx_messages_expires    ON messages(expires_at)    WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dm_messages_expires ON dm_messages(expires_at) WHERE expires_at IS NOT NULL;
-- the sweep deletes by message id from these, which today have no index starting with message_id
CREATE INDEX IF NOT EXISTS idx_saved_messages_message ON saved_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_pin_log_message        ON pin_log(message_id);

-- who changed a conversation's timer, from what to what, when (the system lines)
CREATE TABLE IF NOT EXISTS disappear_log (
  id         TEXT PRIMARY KEY,          -- newId()
  conv       TEXT NOT NULL,             -- 'c:<channelId>' | 'd:<dmId>' (same keys as read_states / notify_prefs)
  user_id    TEXT,                      -- who changed it (kept as an id, like pin_log.user_id)
  secs       INTEGER NOT NULL,
  prev_secs  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disappear_log_conv ON disappear_log(conv, created_at);
```

Notes:

- **Query plans.** I checked these with the repo's own `better-sqlite3@13.0.3` (SQLite 3.53.4).
  - `SELECT … FROM messages WHERE expires_at <= ? ORDER BY expires_at LIMIT ?` uses `SEARCH … USING INDEX idx_messages_expires (expires_at<?)`.
  - `MIN(expires_at)` uses the covering partial index.
  - A comparison operator on the column satisfies the index's `IS NOT NULL` condition ([SQLite partial indexes](https://sqlite.org/partialindex.html)).
  - `DELETE … WHERE message_id IN (SELECT value FROM json_each(?))` uses the primary key or the new indexes for `reactions`, `saved_messages`, `blobs`, `messages` and `mentions`. This is the same `json_each` pattern as `perms.forServer`, and it avoids SQLite's limit on placeholders.
- **Log size.** `disappear_log` keeps at most 50 rows per conversation; older ones are deleted on insert. `usability.js` `sweepStale` (daily) gets two more deletes for `disappear_log` rows whose channel or DM no longer exists, copying the `read_states` statements there. A channel delete doesn't cascade because `conv` is polymorphic, like `read_states`.
- **No `messages.kind`.** No system-message rows are added. Older apps would show a row without ciphertext as "forged" (`openLegacy` hides plaintext after `e2eeSince`) or as "could not decrypt" in DMs (`dm_messages.ciphertext NOT NULL`).
- **`PRAGMA secure_delete = ON`.** Set it in `db.js` right after `db.pragma('foreign_keys = ON')`, outside the migration transaction. It is per connection, not persisted, so it must run on every start. ([SQLite](https://www.sqlite.org/pragma.html#pragma_secure_delete))

---

## 6. Server design

### 6.1 New module `server/disappear.js`

It follows the `setupX(ctx)` pattern of `usability.js` and `search.js`. In `index.js`:

- declare `let DIS = null; // server/disappear.js` next to `let USE` (:1286);
- set it up after `USE` (≈:4867) with the context below.

```js
DIS = require('./disappear')({ api, auth, db, fail, rateLimit, now, newId, perms, PM, jobs, log,
  requireChannel, requireDm, requireManageableChannel, serverOf, isBlocked, getUserRow, toChannel,
  getIo: () => io, emitTo: (uid, ev, d) => io && io.to(`user:${uid}`).emit(ev, d),
  removeUpload, unseal, threadInfo, BOTS: () => BOTS, groupLast /* see 6.6 */ });
```

What it exports:

| Export | Purpose |
|---|---|
| `CHOICES` | `[0, 3600, 86400, 604800, 2419200]`, plus `5` when `NODE_ENV === 'test'` |
| `parseTimer(v)` | Returns `v` if it is an integer in `CHOICES`. Otherwise `fail(400, 'Pick off, 1 hour, 1 day, 1 week or 4 weeks.', 'bad_timer')`. |
| `stamp({ secs, t, root })` | Returns `expires_at` or `null`, with the thread-root cap applied. The single place every insert site calls. |
| `checkTtl(body, secs)` | Throws the 409 `disappear_changed` described in §4.3. |
| `alive(row, t = now())` | `!!row && (row.expires_at == null \|\| row.expires_at > t)`. Also exported from `index.js` for routes. |
| `eventsBetween(conv, rows, hasMore, hasNewer)` | The `timerEvents` for a history page (§6.3). |
| `arm(at)` | Re-arms the precise timer if `at` is earlier than what's armed. Called after each insert with a deadline. |
| `kick()` | `setImmediate` run. Called by routes that filtered out an expired row, so the sweep catches up at once. |
| `run()` | The sweep (§6.7). |

### 6.2 New routes

All need `auth`. Error bodies are the usual `{ error, code }`.

**`PUT /api/channels/:id/disappearing`** with body `{ seconds: 0 | 3600 | 86400 | 604800 | 2419200 }`

- Limits:
  - `rateLimit('disappear:' + uid, 10, 60_000)`;
  - `rateLimit('disappear-conv:c:' + channelId, 30, 3_600_000)` (stops log spam).
- Checks, in order:
  1. `c = requireChannel(id, uid)`.
  2. `c.type === 'text'`, else 400 `bad_channel`.
  3. `srv = serverOf(c)`. If `srv.kind !== 'group'`, call `requireManageableChannel(c.id, uid)`.
  4. `secs = parseTimer(body.seconds)`.
- Same value as now: return the current state with 200, without logging or emitting.
- Otherwise, in one transaction:
  - `UPDATE channels SET disappear_secs = ? WHERE id = ?`;
  - insert a `disappear_log` row;
  - prune the log to 50 for the conversation.
- Then `toChannel(c).emit('disappear:update', out)`. `toChannel` already sends private-channel events only to people who can see the channel.
- No `emitServer`: apps patch their `channel.disappear` from the event, and `serializeChannel` carries it on the next `server:update` or `/bootstrap`.
- Response: `out = { conv: 'c:<id>', channelId, seconds, prev, by: uid, at, serverNow }`.

**`PUT /api/dms/:id/disappearing`** with body `{ seconds }`

- `d = requireDm(id, uid)`.
- 403 if `isBlocked(d.user_a, d.user_b)`.
- 403 code `deleted` if the other account has `deleted_at`.
- Same rate limits (key `disappear-conv:d:<id>`), the same transaction on `dm_channels`, then `io.to([user:a, user:b]).emit('disappear:update', out)`, where `out` has `dmId` instead of `channelId`.

**`GET /api/channels/:id/disappearing`** and **`GET /api/dms/:id/disappearing`**

- Checks: `requireChannel` (VIEW) or `requireDm`; `rateLimit('disappear-read:' + uid, 60, 60_000)`.
- Response: `{ conv, seconds, log: [{ by, secs, prev, at }] }`, with up to 20 entries, newest first.
- The app uses this after a 409 `disappear_changed`, and for an optional "History" item in the menu.

The attack suite in `test/attack.test.js` finds routes by reading the source, so it covers these routes for unauthenticated calls, fuzzing and other people's ids automatically.

### 6.3 Changed routes

| Route (file:line at 1a4b684) | Change |
|---|---|
| `POST /channels/:id/messages` (index.js:2562) | 1. `checkTtl(req.body, c.disappear_secs)`.<br>2. Capture `t = now()` once.<br>3. Read the root with `SELECT id, thread_id, expires_at …`; a root that isn't `alive` gives 404 `That thread no longer exists.`<br>4. Insert `expires_at = DIS.stamp({ secs: c.disappear_secs, t, root })`.<br>5. Change `attachBlobs(files, uid, id)` to `attachBlobs(files, uid, id, exp)`.<br>6. If `exp` is set, call `DIS.arm(exp)`.<br>7. The response and `message:new` carry `expiresAt` (via `serializeMessage`). |
| `POST /dms/:id/messages` (:2766) | The same: `d.disappear_secs`, no thread. Each `dm:message` carries a fresh `serializeDm` (which now has `disappear`) and the message's `expiresAt`. |
| `GET /channels/:id/messages` (:2503), `GET /dms/:id/messages` (:2759) | `rows = rows.filter(alive)` after `pageRows` (keep `hasMore` from the unfiltered count). Add `timerEvents: DIS.eventsBetween(conv, rows, hasMore, hasNewer)`: log rows with `created_at` in `[lo, hi)`, where `lo = hasMore ? rows[0].created_at : 0` and `hi = hasNewer ? last.created_at : +∞`, capped at 50. Older apps ignore the extra field. |
| `PATCH /messages/:id` (:2603), `PATCH /dm-messages/:id` (:2792) | 404 if `!alive(m)`. Never write `expires_at`. |
| `GET /messages/:id/thread` (:2632) | 404 if the root isn't alive; filter the replies. |
| `GET /messages/:id/locate` (:2643) | 404 with the existing text if not alive. |
| `GET /channels/:id/pins`, `GET /dms/:id/pins` (:2693, :2699) | Filter. |
| `pinTarget` (:2659), reactions (:2707), `pollTarget` (:4585) | 404 if not alive. |
| `POST /reports` (:4061) | 404 `That message no longer exists.` if the reported message isn't alive. `inConvo` skips evidence ids that aren't alive. |
| `/bootstrap` (:1708) | Add `serverNow: Date.now()`. Channels carry `disappear` through `serializeChannel` (:247), which gains `disappear: c.type === 'text' ? c.disappear_secs \|\| 0 : undefined`. DMs carry it through `serializeDm` (:427), which gains `disappear: row.disappear_secs \|\| 0`. |
| `/config` (:1347) | Add `disappearing: { choices: DIS.CHOICES, backups: process.env.BACKUP_DISAPPEARING === 'keep' ? 'keep' : 'skip' }`. |
| `GET /uploads/:file` (:856) | For `.bin`: `b = SELECT expires_at FROM blobs WHERE name = ?`. If `b.expires_at <= now()`, answer 404. If `b.expires_at` is set, use `Cache-Control: no-store` instead of `private, no-cache`. |
| `server/search.js` load step | `load(...)` then `.filter(alive)` (pass `alive` in the ctx). The position scans keep their covering indexes; a page may hold fewer than `limit`. |
| `usability.js` `visibleMessage` (:61) | Return `null` when `!alive(row)`. That covers `GET /me/saved` (`savedOut`) and `PUT /me/saved/:id`. |
| `usability.js` `GET /me/export/messages` (:492) | Filter. |
| `bots.js` `bapi.get('/channels/:id/messages')` (:478), `botMessage` | Filter, or 404. `metaOf` (:390) gains `expiresAt: m.expires_at \|\| null`. |
| `bots.js` `postAsBot` (:374), `newsbot.js` `post` (:245) | Stamp (§6.5). |

### 6.4 Socket events (server to client)

| Event | Room | Payload | Limits |
|---|---|---|---|
| `disappear:update` | `toChannel(c)`, or both DM user rooms | `{ conv, channelId?, dmId?, seconds, prev, by, at, serverNow }` | — |
| `message:expire` | `toChannel(c)` | `{ channelId, ids: string[], threads: [{ rootId, threadCount, threadLastAt }], last? }`. `last` only for group chats: the new newest live top-level message, shaped like `serverCommon().last`. | ≤ 500 ids per event, one event per channel per batch |
| `dm:expire` | `user:<a>`, `user:<b>` | `{ dmId, ids, last }`, where `last` is the new `serializeDm().last` (or `null`) | ≤ 500 ids |
| `saved:update` (existing) | `user:<saver>` | `{ messageId, saved: false }` | one per saved row deleted |
| Fallback for apps still on the old version | the same rooms `.except('cap:expire')` | per id: `message:delete { id, channelId, threadId }` / `dm:delete { id, dmId }` | at most 100 ids per conversation per batch |

- New apps join the room `cap:expire` by connecting with `io({ auth: { token, caps: ['expire'] } })` (app.js:431).
- In the server's connection handler, add: `if (Array.isArray(socket.handshake.auth?.caps) && socket.handshake.auth.caps.includes('expire')) socket.join('cap:expire')`.
- `BroadcastOperator.except()` is standard Socket.IO 4 ([docs](https://socket.io/docs/v4/server-api/)). `toChannel` can return a no-op `{ emit() {} }`, so check that `.except` exists before calling it.
- The fallback can be removed one release later (§9).

### 6.5 Stamping at every insert site

| Site | Code |
|---|---|
| `index.js` channel send (:2589) | `INSERT INTO messages (…, expires_at) VALUES (…, ?)` with `DIS.stamp({ secs: c.disappear_secs, t, root })` |
| `index.js` DM send (:2783) | `INSERT INTO dm_messages (…, expires_at)` with `DIS.stamp({ secs: d.disappear_secs, t })` |
| `bots.js` `postAsBot` (:381) | Add `stamp` to the bots ctx as a lazy closure (`stamp: (o) => DIS.stamp(o)`), because `BOTS` is set up before `DIS`. Use `c.disappear_secs`. |
| `newsbot.js` `post` (:250) | The same lazy closure in the `NEWS` ctx (set up at index.js:3770). |
| `attachBlobs` (index.js:783) | `UPDATE blobs SET message_id = ?, expires_at = ? WHERE …` |

Any future insert path (incoming webhooks, imports) must go through `DIS.stamp`. A test greps for this (§11, `T-S16`).

### 6.6 Serving filter (`alive`)

- Defined once in `index.js`: `const alive = (r) => !!r && (r.expires_at == null || r.expires_at > now());`. Pass it into the `search`, `usability` and `bots` contexts.
- The precise timer (§6.7) keeps the time an expired row still exists down to milliseconds. The filter makes "never served after its deadline" true regardless of sweep lag or backlog.
- Reply quotes:
  - in `serializeMessage` (:371), `if (r && r.ciphertext)` becomes `if (r && alive(r) && r.ciphertext)`, and the same for the legacy branch;
  - in `serializeDmMessage` (:407), add `expires_at` to the SELECT and check `alive`;
  - both reply objects gain `expiresAt`, and both serializers add `expiresAt: row.expires_at || null`.
- Previews:
  - `serializeDm` `last`: `… WHERE dm_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 1`, and include `expires_at`;
  - `serverCommon` group `last` (:273): the same filter. Factor it as `groupLast(channelId)` so the sweep can reuse it for `message:expire.last`.
- Not filtered:
  - `/me/unread` counts and `/servers/:id/read` (counts may lag by one sweep, which is harmless);
  - `/me/read`. The app sends live ids (§7.3).
- When a list route dropped at least one row because it had expired, call `DIS.kick()`.

### 6.7 The deletion job

#### 6.7.1 Scheduling

- **Precise timer.**
  - `arm(at)` keeps one `setTimeout` for the earliest `expires_at`. That is `MIN(expires_at)` over both partial indexes, a covering index read, after each run.
  - It is replaced when an insert stamps an earlier deadline.
  - **Node fires any timeout over 2,147,483,647 ms (about 24.8 days) after 1 ms** ([Node docs](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args); confirmed locally: `TimeoutOverflowWarning … set to 1`). 4 weeks is 2,419,200,000 ms. So `arm` doesn't arm when `wait > 2**31 - 1` and leaves those to the safety sweep, exactly as `usability.js` `scheduleEnd` already does.
  - Use `setTimeout(jobs.job('messages.expire', run), wait + 25).unref()`.
- **Safety sweep.** `jobs.every('messages.expire', +process.env.DISAPPEAR_SWEEP_MS || 60_000, run, { firstDelay: 1000 })`. It appears in Admin → Health and in the doctor's `job_health`.
- **At startup.** Call `run()` once, synchronously, inside `setupDisappear`. That happens before the HTTP server listens (the listen block is at the end of `index.js`), so messages that expired while the server was down are gone before anyone connects. `io` is still null then, so the announcements are skipped.
- **No overlap.** `jobs.job` skips a run while one is in progress.

#### 6.7.2 One run

```js
const BATCH = 500;           // rows per table per transaction
const MAX_PER_RUN = 5000;    // then yield and continue on the next tick
function run() {
  let total = 0, n;
  do { n = expireTable('c') + expireTable('d'); total += n; } while (n >= BATCH && total < MAX_PER_RUN);
  if (n >= BATCH) setImmediate(runSafely); else arm();
  if (total) maybeCheckpoint();
  return total;
}

function expireTable(kind) {
  const t = now();
  const table = kind === 'c' ? 'messages' : 'dm_messages';
  const due = db.prepare(`SELECT id, ${kind === 'c' ? 'channel_id, thread_id' : 'dm_id'} FROM ${table}
                          WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`).all(t, BATCH);      // idx_*_expires
  if (!due.length) return 0;
  if (kind === 'c') {   // a thread's replies go with its first message (normally already due: replies are capped)
    const more = db.prepare(`SELECT id, channel_id, thread_id FROM messages
                             WHERE thread_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(due.map((r) => r.id)));
    for (const r of more) if (!due.some((x) => x.id === r.id)) due.push(r);       // use a Set in the real code
  }
  const J = JSON.stringify(due.map((r) => r.id));
  const files = db.prepare('SELECT name FROM blobs WHERE message_id IN (SELECT value FROM json_each(?))').all(J).map((b) => '/uploads/' + b.name);
  if (kind === 'c') db.prepare('SELECT body FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND ciphertext IS NULL').all(J)
    .forEach((m) => (unseal(m.body).attachments || []).forEach((a) => files.push(a.url)));                      // as deleteMessageTree
  const savers = db.prepare('SELECT user_id, message_id FROM saved_messages WHERE message_id IN (SELECT value FROM json_each(?))').all(J);
  db.transaction(() => {
    db.prepare('DELETE FROM blobs WHERE message_id IN (SELECT value FROM json_each(?))').run(J);
    for (const x of ['reactions', 'poll_votes', 'poll_closed', 'mention_marks', 'saved_messages', 'pin_log'])
      db.prepare(`DELETE FROM ${x} WHERE message_id IN (SELECT value FROM json_each(?))`).run(J);
    db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).run(J);
  })();
  files.forEach((u) => removeUpload(u));           // after the commit, like deleteMessageTree; also frees user_files quota
  announce(kind, due, savers);
  return due.length;
}
```

#### 6.7.3 Announcements (`announce`)

Group the deleted rows by `channel_id` or `dm_id`.

- **Channels.** Load `c`. The payload is:
  - `ids`;
  - `threads`: for each `thread_id` whose root was **not** deleted, `{ rootId, ...threadInfo({ id: rootId }) }`;
  - `last: groupLast(c.id)` when `serverOf(c).kind === 'group'`.

  Emit `message:expire` to `toChannel(c)`, plus the fallback (§6.4). Then `BOTS.event('messages.expired', c.server_id, { channelId: c.id, messageIds: ids }, { channel: c })`.
- **DMs.** Emit `dm:expire { dmId, ids, last }` to both users, plus the fallback.
- **Savers.** `emitTo(user_id, 'saved:update', { messageId, saved: false })`.
- If `getIo()` returns null (startup), skip everything.

#### 6.7.4 Bots

- Add `'messages.expired': 'messages.read.metadata'` to `EVENTS` (bots.js:35). The event list in `bapi.put('/installations/:id/events')` and in `/bots` picks it up from there.
- One event per channel per batch, not one per message. This keeps the delivery queue (`bot_deliveries`, kept 3 days) small.

#### 6.7.5 Forensic hygiene

- `secure_delete = ON` zeroes deleted cells and freed pages, including the overflow pages that large ciphertexts (up to 64 KB, `validCipher`) use. `FAST` would leave freelist pages unscrubbed, so it isn't enough.
- In WAL mode the old frames survive in `hearth.db-wal` until it is reset. So `maybeCheckpoint()` runs `db.pragma('wal_checkpoint(TRUNCATE)')` when the run deleted something and the last checkpoint was more than `DISAPPEAR_CHECKPOINT_MS` ago (default 600,000 ms). A `busy` result is logged at debug level and retried next time. ([SQLite wal_checkpoint](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint))
- `db.js` already uses `wal_checkpoint(TRUNCATE)` before upgrade copies, so this is an existing pattern.
- Measure the cost of `secure_delete` with `scripts/bench.js` (PERFORMANCE.md method). If it costs more than about 10% on the send and delete benchmarks, fall back to switching it on only around the sweep's transaction (`db.pragma('secure_delete = ON')` … `OFF`) and document that manual deletes aren't scrubbed.

#### 6.7.6 Performance targets (to measure, then record in PERFORMANCE.md)

- One batch of 500 messages with one file each finishes in under 50 ms on the bench machine.
- `GET /api/health/live` stays under 100 ms p99 while 20,000 expired rows are cleared (the backlog test, §11).
- The extra cost on the send path is one comparison and one `arm` check. `c` and `d` are already loaded with `SELECT *` by `requireChannel` and `requireDm`.

### 6.8 Uploads

- `attachBlobs` copies `expires_at` onto `blobs`.
- `GET /uploads/:file` for `.bin`:
  - expired: 404, even before the sweep unlinks the file;
  - disappearing: `Cache-Control: no-store`, so browsers and the desktop app's Chromium don't keep the ciphertext in their disk cache. `no-store` is a request; browsers honour it, but it isn't a guarantee.
- The lookup is one primary-key read per `.bin` request.

### 6.9 Backups: leave disappearing messages out (default)

There is a new helper in `server/backup.js`:

```js
// Removes messages set to disappear (and everything hanging off them) from a database copy, then VACUUMs it.
// Returns the upload file names it dropped, so the archive leaves them out too.
function scrubDisappearing(file) {
  const d = new Database(file);
  try {
    if (!d.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'expires_at'").get()) return { messages: 0, files: [] };
    d.pragma('secure_delete = ON');
    const ids = `SELECT id FROM messages WHERE expires_at IS NOT NULL
                 UNION ALL SELECT id FROM messages WHERE thread_id IN (SELECT id FROM messages WHERE expires_at IS NOT NULL)
                 UNION ALL SELECT id FROM dm_messages WHERE expires_at IS NOT NULL`;
    const files = d.prepare(`SELECT name FROM blobs WHERE message_id IN (${ids})`).all().map((r) => r.name);
    let n = 0;
    d.transaction(() => {
      d.prepare(`DELETE FROM user_files WHERE name IN (SELECT name FROM blobs WHERE message_id IN (${ids}))`).run();
      for (const t of ['blobs', 'reactions', 'poll_votes', 'poll_closed', 'mention_marks', 'saved_messages', 'pin_log'])
        d.prepare(`DELETE FROM ${t} WHERE message_id IN (${ids})`).run();
      n += d.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL OR thread_id IN (SELECT id FROM messages WHERE expires_at IS NOT NULL)').run().changes;
      n += d.prepare('DELETE FROM dm_messages WHERE expires_at IS NOT NULL').run().changes;
    })();
    d.exec('VACUUM');   // a separate file, not in a transaction: drops the freed pages entirely
    return { messages: n, files };
  } finally { d.close(); }
}
```

- **Deleting `user_files` matters.** `referencedFiles` counts `user_files` rows. Without this step, every restore would report the skipped files as missing (exit 3).
- Where it is called, unless `BACKUP_DISAPPEARING=keep`:

  | Copy | Where | Change |
  |---|---|---|
  | `.hbk` | `createBackup` | Right after `await db.backup(tmpDb)`. Skip `scrub.files` in the uploads loop, remove them from `referenced` (which is still read from the live DB, to keep its race handling), and return `scrubbed: n` for `backupStatus`. |
  | `hearth-auto-*.db` | `makeBackup` (index.js:4970) | After `db.backup(...)`. |
  | `hearth-before-v*.db` | `db.js` upgrade copy | Scrub `${file}.partial` before the rename. This is a no-op for databases older than v19. Running it later is cheap. |

- `verifyBackup` and `restoreBackup` need no change.
- Restoring such a backup loses the disappearing messages that hadn't expired yet. That is the point; RECOVERY.md must say so.
- Recording: `auditLog(null, 'backup_disappearing_skipped', …)` is too noisy. Put `scrubbed` in the `backupStatus` setting and show it in Admin → Owner → Backups.
- `node server/cli.js doctor` warns when `BACKUP_DISAPPEARING=keep`.

### 6.10 Configuration (README settings table and `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_DISAPPEARING` | `skip` | `keep` puts disappearing messages and their files in backups (until those backups rotate out). |
| `DISAPPEAR_SWEEP_MS` | `60000` | Safety-sweep interval. The tests use `200`. |
| `DISAPPEAR_CHECKPOINT_MS` | `600000` | Minimum gap between WAL truncations after sweeps. |

---

## 7. Client design

### 7.1 New pure module `public/js/disappear.js`

It has no DOM and no network, so it is testable under Node like `search-query.js`.

```js
export const TIMERS = [[0, 'Off'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week'], [2419200, '4 weeks']];
export const MAX_WAIT = 2 ** 31 - 1;
export function label(secs)                       // '1 week', '4 weeks', 'Off', '5 seconds' (tests)
export function cleanX(v)                         // integer 1..2419200, else undefined (used by secure.js)
export function deadline(m)                       // Math.min(m.expiresAt || Infinity, m.dec?.x ? m.createdAt + m.dec.x * 1000 : Infinity)
export function expired(m, nowServer)             // deadline(m) <= nowServer
export function serverKept(m)                     // m.dec?.x && (!m.expiresAt || m.expiresAt > m.createdAt + m.dec.x * 1000 + 60_000)
export function nextDeadline(items, nowServer)    // smallest finite deadline > now, or null
export function waitFor(at, nowServer)            // clamp(at - now, 250, 3_600_000): long waits re-check hourly (also covers sleep)
export function sysLineText(entry, meId, nameOf)  // the three sentences in 4.2
export function remaining(ms)                     // 'in 3 days', 'in 5 hours', 'in less than a minute'
```

### 7.2 `public/js/secure.js`

- `openGroup` (:390) and `openDm` (:472) return `{ t, f, p, … }` from a whitelist. Add `x: cleanX(payload.x)`, imported from `disappear.js`. Anything else in the payload is still dropped.
- `encryptChannel` and `encryptDm` are unchanged: the payload comes from the caller.

### 7.3 `public/js/app.js`

| Function or place | Change |
|---|---|
| Socket creation (:431) | `io({ auth: { token: getToken(), caps: ['expire'] }, … })` |
| `loadBootstrap` (:835) | `S.clockOffset = clamp(b.serverNow - midpoint(requestStart, Date.now()), ±1 day)`. `nowServer = () => Date.now() + S.clockOffset`. Call `purgeInboxAndReminders()` at the end. |
| Socket handlers (≈:719–:756) | `message:expire` → `applyExpired('c:' + channelId, ids, threads, last)`. `dm:expire` → `applyExpired('d:' + dmId, ids, null, last)`. `disappear:update` → patch `channel.disappear` or `dm.disappear`; if that conversation's store is loaded with no newer page (`!hasNewer`), push the entry into `store.events`; redraw the header, composer note and messages. |
| `loadMessages` (:2387) | Merge `res.timerEvents` into `store.events` (deduplicated by `at` + `by`). After decrypting, drop expired messages (`expired(m, nowServer())`) and call `armClientExpiry()`. |
| `renderMessages` (:2592), `prependOlder` | Interleave `store.events` with messages by time, using `sys-line` elements (role `note`). |
| `fillMessage` (:2704) | The timer badge. When `serverKept(m)` is true, the title adds "(the server kept it longer than its timer)". |
| `onNewMessage` (:3295), `onThreadMessage` (:3453) | `armClientExpiry()` when the new message has a deadline. Pass `exp: deadline(m)` (finite only) to `addInbox`. Pass `msgId` and `exp` to `notify`. |
| `addInbox` (:1311) | Store `exp`. New `purgeInboxAndReminders(goneIds)` filters out entries with `exp <= now` or `msgId ∈ goneIds`. |
| `notify` (:3370) | `rememberNotification(key, n, msgId)`. Pass `ttl: exp - nowServer()` in the options; only the Android shim reads it (§7.5). |
| `sendTo` (:4146) | `const secs = convSecs(key)`. Payload `{ ...payload, ...(secs ? { x: secs } : {}) }`. Body `ttl: secs`. On 409 `disappear_changed`: `GET …/disappearing`, update the conversation, re-encrypt, retry once. Fold this into `withKeyRetry` so a key 409 and a timer 409 can happen in the same send. |
| Composer send (≈:4040) | Unchanged apart from the payload going through `sendTo`. The pending "Sending…" copy needs no timer. |
| `editBox` (:2969) | Keep `p` and `x` (§4.4). If the message expires while it's being edited: cancel editing and toast "This message disappeared." |
| `openForward` (:3033) | `sendTo` applies the destination's `x`. Show the note from §4.4 when `deadline(m)` is finite. |
| `decryptedUrl` (:3066) | Refuse (reject with code `gone`) when `expired(m)`. When a job finishes for an expired message, `fileUrls.drop(url)`. |
| New `applyExpired(key, ids, threads, last)` | The one path for socket events and local timers:<br>1. Remove the ids from `S.msgs[key].list` and from every `S.threads[*]` (a root → delete `S.threads[root]` and `closeThread()` if open).<br>2. Clear `x.reply` where `x.reply.id ∈ ids`.<br>3. `fileUrls.drop(f.url)` and `f.th.url` for each removed message's `filesOf(m)`.<br>4. Pause and remove a playing voice or video element.<br>5. Close `openViewer` (:3212) if its current image belongs to a removed message (tag images with `data-mid`).<br>6. Cancel the composer reply (`composers[*].state.replyTo`) and the edit (`S.editing`) when they point at a removed message.<br>7. `closeNotificationFor(id)`.<br>8. `purgeInboxAndReminders(ids)`.<br>9. Update `S.previews` from `last` (`d.last = last; previewDm(d)` / `s.last = last; previewGroup(s)`).<br>10. Re-render: `keepAnchor` + `renderMessages(false)` if viewing, `renderPanel()` if the pins or thread panel is open, `renderMain()` if on the saved view.<br>11. Notify the open search modal (a registry of callbacks; `gone.add(id)`, `draw()`).<br>12. Debounced `GET /me/unread` (≤ 1 per 30 s) if `S.unread.has(key)`.<br>13. `armClientExpiry()`. |
| New `armClientExpiry()` / `purgeExpired()` | One `setTimeout(purgeExpired, waitFor(nextDeadline(all loaded messages, threads, inbox, reminders)))`. `purgeExpired` runs `applyExpired` for every key whose messages have expired locally. Also run `purgeExpired()` on `visibilitychange` (visible), `focus`, and socket `connect`. Chrome checks timers in long-hidden pages only once a minute ([Chrome 88 throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)). |
| `previewDm` (:929), `previewGroup` (:935) | Treat an expired `last` as no preview. |
| `markRead` (:1253), `markConvRead` | Use the last **live** message id. |
| `messageHits` in `openSearch` (:4491) | `consider()` returns early for `expired(m, nowServer())`. Register an `applyExpired` listener while the modal is open. |
| `pinsPanel` (:3638), `savedView` (:2292), `threadPanel` (:3672) | Filter expired items when drawing. They redraw through `applyExpired`. |
| `drawHeader` (:2002), `dmMenuItems` (:1622), `groupMenuItems` (:1634), `channelMenuItems` (:1754), `openEditChannel` (:5589), `createComposer` (:3759), `welcomeBlock` | The UI described in §4.2. The new `setDisappearing(key, secs)` calls the PUT route, confirming first when turning the timer on. |
| `openReport` (:5880) | The warning from §4.4 when any evidence message has a deadline. |
| `fillMessage` reply branch | Change the text to "Original message is no longer available". |

### 7.4 Other client modules

- **`public/js/usability.js`**
  - `rememberNotification(tag, n, msgId)` keeps a map from `msgId` to the notification.
  - The new `closeNotificationFor(msgId)` closes it, both in-tab and through `reg.getNotifications({ tag })` like `closeNotifications`.
  - `runExport(ctx)` takes `ctx.includeDisappearing`. When it is false, it skips messages where `m.expiresAt || m.dec?.x` and counts them in `manifest.totals.disappearingSkipped`, adding one `skipped` entry per conversation.
  - Update the `README` constant to describe this.
- **`public/js/settings.js`** (≈:1493, the export dialog): a checkbox "Include messages set to disappear (the copies in the zip won’t disappear)", default off, passed to `runExport`.
- **`public/js/features.js`**
  - `remindItems(m, key, preview)` (:323) stores `exp: deadline(m)` and doesn't offer a reminder later than the deadline.
  - `startReminders`' `check` (:334) drops expired entries without notifying, and `purgeInboxAndReminders` removes them.
- **`public/js/android.js`**: `AppNotification` passes `ttl` through: `send({ type: 'notify', title, body, tag, ttl: Math.max(0, Math.round(opts.ttl || 0)) })`.
- **`public/sw.js`**: no change. Pushes carry no text (`shapePush`), and `/uploads/` is never cached by the service worker.

### 7.5 Native shells

- **Android** (`mobile/native/MainActivity.java`):
  - `case "notify": notify(m.optString("title"), m.optString("body"), m.optString("tag"), m.optLong("ttl", 0));`
  - in `notify(...)`: `if (ttl > 0) b.setTimeoutAfter(ttl);`
  - `NotificationCompat.Builder#setTimeoutAfter(long)` cancels the notification after that long ([AndroidX reference](https://developer.android.com/reference/androidx/core/app/NotificationCompat.Builder); platform [`Notification.Builder#setTimeoutAfter`](https://developer.android.com/reference/android/app/Notification.Builder), API 26+). On older Android versions the compat call does nothing, so the page's `close()` while running is the only path there.
  - Older APKs ignore the extra JSON field (`optString` / `optLong`), so the page code is safe with them.
  - It ships through `.github/workflows/hearth-apps.yml`, which copies `native/*.java`.
- **Desktop** (`desktop/`): no change. Notifications are Chromium's, and the page closes them. Electron's HTTP cache follows `no-store` (§6.8).

---

## 8. Edge cases

1. **Timer changed while someone is typing or sending.** The server refuses the mismatch with 409 `disappear_changed`, and the app re-encrypts with the new timer and retries once (§4.3). Two members changing it at the same time: last write wins, and both log entries are kept and shown in order. One process emits in commit order.
2. **Turning the timer off** affects only new messages. Messages already stamped still disappear. The confirm dialog and the system line make this clear: "Messages already sent keep their timer".
3. **Turning it on** doesn't touch older messages. That matches Signal and WhatsApp.
4. **Server down when messages expire.** The startup `run()` deletes them before `listen`, and `alive` covers any gap.
5. **Big backlog** (for example 1M rows after a long outage). 500 per transaction, 5,000 per tick, `setImmediate` between ticks. History routes never serve the backlog.
6. **Expired rows in the gap before the sweep.** A history page full of rows that expired but weren't swept yet comes back empty with `hasMore: true`. The route calls `DIS.kick()`, so the app's next scroll gets the next page within milliseconds.
7. **4-week timers and `setTimeout`.** Both server and app cap their waits (§6.7.1, §7.1). The server falls back to the 60 s sweep; the app re-checks hourly.
8. **Clock skew.** Deadlines are server times (`created_at`, `expires_at`). The app compares them with `Date.now() + S.clockOffset` from `serverNow`, as `watch.js` already does (`st.serverNow`). A device whose clock is hours off still hides on time.
9. **A thread whose first message expires** takes its replies with it, including replies sent after the channel's timer was turned off. Replies are capped at the root's deadline when they are sent (§4.3), so their own badge shows the right time.
10. **Replies to an expired message.** The quote shows "Original message is no longer available". The reply itself stays.
11. **Forwarding.** The copy follows the destination's timer, and its attachments break when the original's files are deleted (§4.4).
12. **Pins.** An expired pinned message leaves the pin list and the pin history. `MAX_PINS` frees up.
13. **Saved.** The entry and its encrypted note are deleted, and `saved:update` reaches the saver's devices.
14. **Search.**
    - Cursors are positions `[created_at, id]`, so a cursor pointing at a message that has since gone still pages correctly.
    - A result clicked after it expired gets `locate` → 404 → marked as gone (existing behaviour).
15. **Message links and notification taps** (`#m/<id>`) to an expired message: `locate` 404, then the existing toast.
16. **Export started before expiry** with the box ticked: the zip keeps the messages. That is the person's explicit choice, and the export dialog says so.
17. **Reports**: evidence is kept (§4.4).
18. **Blocked DM**: neither person can change the timer, but existing messages still expire.
19. **The other DM account deleted**: the timer can't be changed, and existing messages expire normally.
20. **Leaving a group or channel** doesn't matter: messages expire on the server for everyone.
21. **A member who joins later** sees unexpired messages they can decrypt. That is unchanged: new members get only the current epoch key.
22. **Private channel**: `disappear:update` and `message:expire` go through `toChannel`, so only people with VIEW receive them. Bots receive `messages.expired` only for channels on their allow-list (`channelAllowed` in `BOTS.event`).
23. **News or bot posting in a disappearing channel** is stamped. Bot edits (`bapi.patch`) never extend the deadline.
24. **Restoring a backup made with `BACKUP_DISAPPEARING=keep`** brings back unexpired disappearing messages with their original `expires_at`. Already-expired ones are deleted by the startup sweep.
25. **A malicious client sends a huge `x`.** `cleanX` caps it at 4 weeks, and `min()` means `x` can never extend the server's deadline. A small `x` makes the message disappear sooner on readers' screens; that is the sender's choice.
26. **Old apps** (open tabs on the previous version, mainly people in a call on upgrade day, see `onNewVersion` at app.js:6338) get the per-id `message:delete` / `dm:delete` fallback (§6.4). They don't show timers.
27. **`HISTORY_WINDOW` trimming** (`dropNewest`, `trimStore`) is unrelated. `applyExpired` must run before trimming decisions so ids aren't counted twice.
28. **Group "last message" previews and the DM list order.** `dm_channels.last_message_at` still sorts the list by the last message time, including expired ones. That time is metadata the server already had. The preview goes blank or shows the previous live message.
29. **Disk full during a sweep.** The transaction fails and the job is marked failing (jobs.js records it and raises alerts after 3 failures). Rows stay, `alive` still hides them, and the next run retries.

---

## 9. Migration and compatibility

- **Database.**
  - v18 to v19 is additive: columns, a table and indexes, inside the existing one-transaction upgrade, after the automatic `hearth-before-v19-*` copy.
  - No data is rewritten, and every existing message has `expires_at NULL` (never expires).
  - A v19 database opened by v18 code is refused (`HEARTH_DB_TOO_NEW`), as for any upgrade. Rollback goes through the pre-upgrade copy, as RECOVERY.md already describes.
- **Web, desktop and Android UI.**
  - These are served by the server, so they switch to the new code on the next reconnect when `/api/config` `version` changes (app.js `connect` handler → `onNewVersion`).
  - The exception is a tab in a call, which waits ("Reload after your call"). It still sends without `ttl`, so the server stamps from the setting. It receives the legacy delete events (§6.4) and keeps working, but shows no timer UI.
  - Remove the fallback in the release after next. Note it in the ENGINEERING-REPORT work log.
- **Android APK.** Old APKs work fully. Only the native self-expiring notification needs the new APK (§7.5). Document this in `mobile/README.md`.
- **Desktop app.** No change.
- **Bots.** They get a new field (`expiresAt`) and a new event (`messages.expired`). Bots with an explicit `events` list don't receive the new event until they add it. Document this in BOTS.md.
- **Tests that hard-code version 18** need updating:
  - `test/quality.test.js` ("the database is at version 18…" and the upgrade test that uses `user_version = 19` as "newer"; change that to 20);
  - any doc text that says "schema 18".

---

## 10. What backups and exports keep, and for how long

"Removed" in the table means the copy holds nothing for messages that were disappearing when it was made.

| Copy | Made by | Kept for | With the default `BACKUP_DISAPPEARING=skip` | With `keep` |
|---|---|---|---|---|
| Live `hearth.db` and `-wal` | — | — | Deleted at the deadline (usually within a second, at most one 60 s sweep). Overwritten via `secure_delete`. The WAL is truncated within 10 min. | Same |
| `data/backups/encrypted/*.hbk` | `backup.daily` → `createBackup` | Newest `keep` plus the newest of each of the last `keep` days (default 7, range 1–60; `backupsToPrune`) | Removed, files included | Included until that backup is pruned. Readable by whoever holds the backup key for sealed bot posts (`secret.key` is inside), and by anyone with a member's keys for end-to-end encrypted ones. |
| Region copies of `.hbk` | `regions.js` `copyBackup` | `REGION_BACKUP_KEEP` (default 14, range 2–60) | Removed | Up to 14 days by default |
| Off-site rclone copies | `uploadOffsite` (`rclone copyto`) | **Never pruned by Hearth** (the operator's remote policy) | Removed from new backups. **Older copies keep whatever they had.** | Indefinitely |
| `data/backups/hearth-auto-*.db` (plain SQLite) | `makeBackup('auto')` | `keep` newest (default 7) | Removed | Up to `keep` days |
| `data/backups/hearth-before-v*.db` | `db.js` before each upgrade | **Never pruned** | Removed (scrubbed before rename) from v19 on | Indefinitely |
| `/root/hearth-backups/*` | `scripts/hearth-update.sh` | 5 snapshots | **Not scrubbed**: a copy of `data/` at update time. Honest limit. | Same |
| "Export my data" zip | On the person's device | Forever (their file) | Left out unless they tick the box | Same |
| Report evidence | `POST /reports` | Until staff delete the report (no automatic pruning) | Kept | Kept |
| `bot_deliveries` | `bots.js` | 3 days delivered, 30 days dead letters | Ids and times only, never content | Same |

SECURITY.md §6, README "Backups" and RECOVERY.md "What a backup holds" must carry this table, or a short form of it.

---

## 11. Tests

All server tests use `startServer` from `test/helpers.js`. They use `srv.sql(...)` to move `expires_at` into the past, and `DISAPPEAR_SWEEP_MS=200` where the sweep is meant to run. They use `DISAPPEAR_SWEEP_MS=3600000` where the test must show that `alive` alone protects (no sweep).

### New `test/disappearing.test.js` (in `npm test`)

| ID | Test name |
|---|---|
| T-S1 | `timer: only off, 1 hour, 1 day, 1 week and 4 weeks are accepted (5 s only under NODE_ENV=test); junk, negatives, strings and floats get 400 bad_timer` |
| T-S2 | `timer: in a DM either person can set it; a block (either way) or a deleted partner stops it; outsiders get 404` |
| T-S3 | `timer: in a group chat any member can set it; in a server channel only Manage Channels in that channel, and a per-channel deny of it is respected; voice channels are refused` |
| T-S4 | `timer: each change is logged (who, from, to, when), capped at 50 per conversation, returned by GET …/disappearing and inside the history page it falls in; setting the same value logs nothing` |
| T-S5 | `timer: disappear:update reaches the DM pair, the group, and in a private channel only people with View Channel` |
| T-S6 | `send: expires_at = created_at + timer at send time; turning it off or changing it later leaves sent messages as they were` |
| T-S7 | `send: a ttl that doesn't match the setting gets 409 disappear_changed; no ttl (an older app) is stamped from the setting` |
| T-S8 | `send: a thread reply never outlives its first message, even with the channel's timer off; a root that expired can't take new replies` |
| T-S9 | `edit: editing never moves expires_at; an expired message can't be edited, reacted to, pinned, voted on, saved, reported or located (404), even before the sweep` |
| T-S10 | `serve: with the sweep paused, an expired message is not in history pages, threads, pins, search (all, s:, c:, d:), saved, export, reply quotes, DM and group previews, or the bot API` |
| T-S11 | `sweep: deletes expired messages with their files (404 from /uploads), blobs, reactions, poll votes and closure, mention marks, saved entries and pin history; the uploader's storage use goes down` |
| T-S12 | `sweep: open apps get message:expire / dm:expire (ids, new thread counts, new last message); savers get saved:update; a socket without caps gets message:delete / dm:delete instead` |
| T-S13 | `sweep: a backlog of 20,000 expired messages is cleared in batches while /api/health/live keeps answering quickly` |
| T-S14 | `sweep: messages that expired while the server was stopped are gone before the first request after a restart` |
| T-S15 | `forensics: after the sweep and checkpoint, a unique marker that was in an expired message's ciphertext is nowhere in hearth.db or hearth.db-wal` (scan the raw bytes) |
| T-S16 | `every INSERT INTO messages / dm_messages in server/*.js stamps expires_at` (a source check, like attack.test.js reads routes) |
| T-S17 | `uploads: a disappearing message's file is served with Cache-Control: no-store, and is 404 once its time has passed even before the sweep` |
| T-S18 | `rate limits: changing a conversation's timer is limited per person and per conversation` |

### Additions to existing files

| ID | File | Test name |
|---|---|---|
| T-B1 | `test/bots.test.js` | `bots: posts by a bot and by the news bot follow the channel timer; the bot API and webhooks carry expiresAt and a messages.expired event with ids only, never content` |
| T-K1 | `test/backup.test.js` | `backups leave out messages set to disappear and their files (snapshot and plain copy); restore of such a backup reports no missing files; BACKUP_DISAPPEARING=keep includes them` |
| T-K2 | `test/recovery-backup.test.js` | `a restore of a backup made with keep: messages already past their time are deleted on first start` |
| T-Q1 | `test/quality.test.js` | Update: `the database is at version 19 and has the v18 and v19 indexes`. The upgrade test goes from 18 to 19, and version 20 counts as "newer". |
| T-Q2 | `test/quality.test.js` | `the sweep uses idx_messages_expires / idx_dm_messages_expires and the saved/pin_log message indexes` (with `EXPLAIN QUERY PLAN`, like the existing "hot statements" test) |
| T-U1 | `test/usability.test.js` | `export: the server hands out no expired message; read markers keep working after the message they point at disappeared` |
| T-C1 | `test/client-hardening.test.js` | `infra-7b: MainActivity passes the page's ttl to setTimeoutAfter; android.js forwards it` (source check; compiles with `javac` when present, like infra-7) |
| T-C2 | `test/usability.test.js` (static, like "app: saved messages and read markers are no longer kept as plaintext") | `app: inbox entries and reminders carry their message's deadline and are purged; editBox keeps p and x; the socket asks for caps ['expire']` |

### New `test/disappear-client.test.js` (pure module, in `npm test`)

| ID | Test name |
|---|---|
| T-D1 | `deadline is the earlier of the server's expiresAt and createdAt + the encrypted timer; no timer means never` |
| T-D2 | `serverKept flags a message the server kept past its encrypted timer (with a minute of slack)` |
| T-D3 | `nextDeadline ignores messages without timers; waitFor clamps to 250 ms … 1 hour (never past setTimeout's limit)` |
| T-D4 | `system lines read "turned on: 1 week", "changed to 1 day", "turned off", with You and Someone` |
| T-D5 | `cleanX accepts 1..2419200 integers only` |

### Browser and end-to-end (outside CI, `npm run test:e2e`)

- New flow in `test/e2e/flows.mjs` → `FLOWS`: `['disappearing: turn on in a DM (system line on both screens), a 5-second message with a picture vanishes on both screens and its file stops loading, the inbox entry goes, turn off', disappearing]`.
  - Run the server with `NODE_ENV=test` so the 5 s choice is allowed.
- `npm run test:a11y`: the system line and the badge have accessible names, and the timer menu works by keyboard.

---

## 12. Docs to update

| Doc | What changes |
|---|---|
| `SECURITY.md` | §1: a row "Disappearing messages". §3: new contract rows 92–96, each naming its test. §4: the honest limits in §3.2 as one bullet. §6: backups (`BACKUP_DISAPPEARING`). |
| `docs/ARCHITECTURE.md` | Header: "schema 19". §2: the send flow sets `expires_at`. §3: the new table and columns. §4 "Can read": timers and expiry times. §7: jobs table `messages.expire` (precise timer plus 60 s sweep). §11: backup scrub. |
| `docs/ROUTES.md` | The new routes, the changed send and serve routes, socket events `disappear:update`, `message:expire`, `dm:expire`, and the `caps` handshake. |
| `docs/FEATURES.md` | A new "Disappearing messages" section, the API summary, the data model, tests, known limitations. |
| `docs/STORAGE.md` | §6 Retention: a row "A message disappears". §6.8 headers (`no-store`). §9 Backups. |
| `docs/RECOVERY.md` | "What a backup holds", "Unrecoverable, by design", and the restore behaviour. |
| `docs/BOTS.md` | §6 Events: `messages.expired`. §5 Messages: `expiresAt`. A note on posting into disappearing channels. |
| `docs/OPERATIONS.md` | The job, the env vars, the doctor warning. |
| `docs/PERFORMANCE.md` | Sweep numbers, the `secure_delete` cost, the new indexes. |
| `README.md` | A short "Disappearing messages" section. "Security and privacy → Things to know". "Backups". The settings table (`BACKUP_DISAPPEARING`, `DISAPPEAR_SWEEP_MS`, `DISAPPEAR_CHECKPOINT_MS`). |
| `.env.example` | The three variables, commented. |
| `docs/NEXT.md` | Progress line for pick #11. |
| `docs/ENGINEERING-REPORT.md` | Work log entry, including "remove the legacy delete fallback next release". |
| `mobile/README.md` | Self-expiring notifications need the new APK. |
| `public/js/usability.js` | The export `README` text. |

The SECURITY.md contract rows:

| Row | Attack | Expected result | Proven by |
|---|---|---|---|
| 92 | Someone loads a message after its disappearing time | No route serves it, even before deletion. It is deleted with its files, reactions, votes, saved entries and pin history. | T-S9, T-S10, T-S11 |
| 93 | Someone outside a conversation changes its timer | DM pair / group members / Manage Channels only. Every change is logged in the conversation. | T-S2, T-S3, T-S4 |
| 94 | A stolen backup is searched for disappearing messages | By default backups never contain them | T-K1 |
| 95 | A stolen database file is searched for expired messages | Their bytes are gone from the file and its WAL (`secure_delete`, checkpoint). Disks and snapshots below SQLite aren't covered. | T-S15 |
| 96 | The server keeps a message past its timer | Apps hide it by the timer inside the encrypted message | T-D1, T-D2 |

---

## 13. Risks and open questions

### Risks

1. **People over-trust it.** This is the main risk. Mitigations: the confirm dialog and README wording, the SECURITY.md §4 limits, and showing the operator's backup policy (as the server reports it).
2. **`secure_delete` cost** on every DELETE and UPDATE. Measure it; the fallback is §6.7.5.
3. **Sweep load** on busy instances, and event fan-out to restricted channels (`toChannel` runs `perms.forServer` per channel per batch). It is bounded by the batch size and the message rate limits. Benchmark before release.
4. **Touch-point coverage.** There are many read paths (§6.3/§6.6). T-S10 must cover each one, and T-S16 guards future insert paths.
5. **Breaking forwarded attachments.** A forward from a disappearing conversation loses its files when the original expires. This is intended for privacy but can surprise people, so the forward dialog explains it.
6. **Moderation.** Moderators of a disappearing channel lose context. Reports keep evidence, and the per-server audit log (NEXT.md #7) doesn't depend on content.
7. **Operator expectations of restores.** The default backup scrub means a disaster restore loses unexpired disappearing messages. RECOVERY.md must say so plainly.

### Open questions (with recommendations)

1. **Group lock.** Should group owners be able to restrict timer changes to themselves, like Signal and WhatsApp admins? *Recommend:* yes in a follow-up, as `servers.theme`-style group settings.
2. **Personal default timer for new DMs and groups** (Signal). *Recommend:* a follow-up stored in `user_prefs.data`, applied by the creator's app right after creating the conversation.
3. **Instance policy.** An admin switch to disable the feature, or a minimum retention for communities that must keep records. *Recommend:* not in v1. If added, show it in `/api/config` and refuse with 403 `disappearing_off`.
4. **Sender timestamp in the payload** (`s`) to bound a server lying about `created_at`. The cost is clock skew between senders. *Recommend:* add `s` now (cheap), but only use it for a "timer looks wrong" warning, not for hiding.
5. **Signed timer changes.** The changer's app could post an end-to-end encrypted, signed control notice so readers can verify who changed the timer. *Recommend:* defer; the server is trusted to delete anyway.
6. **Manual deletes and saved entries / pin history.** Should a manual delete also remove saved entries and pin history, for consistency with expiry? *Recommend:* yes, as a separate small change after this one.
7. **Scrubbing `hearth-update.sh` snapshots.** That would mean running a Node helper from the shell script. *Recommend:* document it now; consider it with signed update zips (NEXT.md #5).
8. **Keeping the system line** when a conversation's log exceeds 50 entries. Older lines are dropped. Fine for now.

---

## 14. Build plan (small commits, each with its tests)

1. **`db: schema 19 for disappearing messages`.** The v19 block (§5), `secure_delete`, `SCHEMA_VERSION = 19`. Update `test/quality.test.js` (T-Q1). Run `npm test`.
2. **`server: disappear.js with timer routes and log`.** Constants, `parseTimer`, the PUT and GET routes, the log with pruning, `disappear:update`, `serializeChannel` / `serializeDm` `disappear`, `/config`, `/bootstrap` `serverNow`, the `sweepStale` addition. Tests T-S1–T-S5, T-S18.
3. **`server: stamp expires_at on every send`.** Channel and DM POST (`ttl` check and thread cap), `attachBlobs` copying `expires_at`, `bots.js` `postAsBot`, `newsbot.js` `post`, `expiresAt` in serializers and `metaOf`, `timerEvents` in history. Tests T-S6–T-S8, T-S16.
4. **`server: never serve an expired message`.** `alive` everywhere listed in §6.3/§6.6, plus `DIS.kick()`. Tests T-S9, T-S10.
5. **`server: the messages.expire sweep`.** Precise `arm` plus the safety sweep, the startup run, the batched delete, announcements, saved and pin history cleanup, the legacy fallback with the `caps` handshake, and the `messages.expired` bot event. Tests T-S11–T-S14, T-B1, T-Q2.
6. **`server: scrub deleted messages from disk`.** The WAL checkpoint after sweeps, then measure `secure_delete` with `scripts/bench.js`. Test T-S15.
7. **`server: uploads of disappearing messages`.** 404 after the deadline and `no-store`. Test T-S17.
8. **`backups: leave out disappearing messages`.** `scrubDisappearing` in `.hbk`, the auto copy and the pre-upgrade copy, plus `BACKUP_DISAPPEARING`, `backupStatus.scrubbed` and the doctor warning. Tests T-K1, T-K2.
9. **`client: disappear.js pure helpers`.** Tests T-D1–T-D5.
10. **`client: encrypted timer and sending`.** `secure.js` `x`, `sendTo` `x`/`ttl` with the 409 retry, `editBox` keeping `p`/`x`, `serverNow` offset, socket `caps`.
11. **`client: show and change the timer`.** Menus, header, channel settings, composer note, welcome line, confirm dialog, message badge, system lines (`store.events`, `timerEvents`).
12. **`client: remove expired messages everywhere`.** `applyExpired`, `armClientExpiry` / `purgeExpired`, the socket handlers, file cache, viewer, voice, reply and edit state, previews, saved, pins, threads, search, unread refresh, `markRead` using live ids.
13. **`client: inbox, reminders and notifications follow the timer`.** `addInbox` `exp`, `features.js` reminders, `closeNotificationFor`, `ttl` to the Android shim. Test T-C2.
14. **`client: export and report notes`.** The export checkbox and manifest, the README text in `usability.js`, the report warning, the forward note. Test T-U1.
15. **`android: notifications cancel themselves`.** `MainActivity.java` `setTimeoutAfter`. Test T-C1. Build through `hearth-apps.yml`.
16. **`e2e: disappearing flow`.** In `test/e2e/flows.mjs`, plus a11y checks.
17. **`docs: disappearing messages`.** Everything in §12, including the SECURITY.md rows 92–96 and the backup retention table.
18. **`release: version bump`.** Bump `package.json` and add release notes. Note in ENGINEERING-REPORT.md that the legacy delete fallback is removed next release.

---

## 15. Effort

**L.** NEXT.md rated it M. The server core (commits 1–8) is about M on its own. The client purge across many caches, the backup scrub, the Android change, the forensic work and the documentation push it to L: roughly 2–3 weeks for one engineer, including tests and benchmarks.

---

## Sources (external facts)

- Signal: timer start, who can change it, groups. https://support.signal.org/hc/en-us/articles/360007320771-Set-and-manage-disappearing-messages · https://signal.org/blog/disappearing-messages/ · https://support.signal.org/hc/articles/360007319331-Group-chats · https://techcrunch.com/2021/08/10/signal-disappearing-message-settings
- WhatsApp: forwarding, backups, quoted replies, group controls (as reported from its FAQ). https://www.xda-developers.com/whatsapp-publishes-faq-on-upcoming-disappearing-messages-feature/ · https://wabetainfo.com/whatsapp-releases-details-about-disappearing-messages/ · https://www.phonearena.com/news/WhatsApps-Disappearing-Messages-feature-detailed-in-a-FAQ-document_id128175 · https://iol.co.za/technology/software-and-internet/2021-12-07-whatsapp-to-enable-messages-to-disappear-for-privacy-sake-and-more-honest-conversations/
- SQLite `secure_delete` and `wal_checkpoint`: https://www.sqlite.org/pragma.html#pragma_secure_delete · https://www.sqlite.org/pragma.html#pragma_wal_checkpoint. WAL caveats: https://antonz.org/sqlite-secure-delete/
- SQLite partial indexes: https://sqlite.org/partialindex.html. `json_each`: https://www.sqlite.org/json1.html#jeach
- Node timer overflow (delays over 2^31−1 ms fire after 1 ms): https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
- Chrome timer throttling in hidden tabs: https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- Socket.IO `except()`: https://socket.io/docs/v4/server-api/
- Android `setTimeoutAfter`: https://developer.android.com/reference/androidx/core/app/NotificationCompat.Builder · https://developer.android.com/reference/android/app/Notification.Builder

Checked locally against the repo's own dependencies (`better-sqlite3` 13.0.3, SQLite 3.53.4, Node 22.22.0):

- the query plans in §5;
- the `json_each` delete plans;
- Node's `TimeoutOverflowWarning … Timeout duration was set to 1` for `setTimeout(fn, 2**31)`.


## Sources

- https://support.signal.org/hc/en-us/articles/360007320771-Set-and-manage-disappearing-messages
- https://signal.org/blog/disappearing-messages/
- https://support.signal.org/hc/articles/360007319331-Group-chats
- https://techcrunch.com/2021/08/10/signal-disappearing-message-settings
- https://www.xda-developers.com/whatsapp-publishes-faq-on-upcoming-disappearing-messages-feature/
- https://wabetainfo.com/whatsapp-releases-details-about-disappearing-messages/
- https://www.phonearena.com/news/WhatsApps-Disappearing-Messages-feature-detailed-in-a-FAQ-document_id128175
- https://iol.co.za/technology/software-and-internet/2021-12-07-whatsapp-to-enable-messages-to-disappear-for-privacy-sake-and-more-honest-conversations/
- https://www.sqlite.org/pragma.html#pragma_secure_delete
- https://www.sqlite.org/pragma.html#pragma_wal_checkpoint
- https://antonz.org/sqlite-secure-delete/
- https://sqlite.org/partialindex.html
- https://www.sqlite.org/json1.html#jeach
- https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
- https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- https://socket.io/docs/v4/server-api/
- https://developer.android.com/reference/androidx/core/app/NotificationCompat.Builder
- https://developer.android.com/reference/android/app/Notification.Builder
