# Message usability and notifications

This page covers saved messages, pins, unread tracking, notification preferences, drafts, data export and
moderation (slow mode, timeouts, reports), and link previews (the last section). It starts with what Hearth already had before this work (schema
v17), then describes what changed (schema v18). Paths are relative to `hearth/`.

Message content stays end-to-end encrypted throughout. The server stores and sends message ids, times and the
@mention user ids that apps already sent for push. Anything with words in it (a saved item's note, an export)
is encrypted or assembled on the device.

## 1. Inventory: what existed before (v17)

| Feature | Where | State before this work |
|---|---|---|
| Replies, edits, deletes, forwarding, message links | `server/index.js`, `public/js/app.js` | Complete. Links (`/#m/<id>`) resolve through `GET /messages/:id/locate`. |
| Threads | `GET /messages/:id/thread`, thread panel | Complete. Paged. Needs Create Threads. |
| Reactions | `POST /messages/:id/reactions` | Complete. Up to 20 different emoji per message. Needs Add Reactions. |
| Polls | encrypted payload `p`, `/polls/:id/*` | Complete. The server only counts option numbers. |
| Events | `/servers/:id/events`, `/events/:id/rsvp` | Complete. There is a reminder 15 minutes before, in the app and by push. |
| Search | `server/search.js`, `public/js/search-query.js` | Complete. The server filters on metadata, and the app matches words after decrypting. |
| Server folders | `PUT /me/rail`, `public/js/folders.js` | Complete. Synced across devices. |
| Pins | `POST/DELETE /messages/:id/pin`, `GET /channels/:id/pins`, pins panel | **Incomplete.** Authors could pin their own messages without Manage Messages. There was no history and no limit (the list showed 50). |
| Unread tracking | `app.js` `S.unread`, `S.mentions`, `P.lastRead` | **Incomplete.** Unread state lived only in memory for one session. Every reload cleared it, so nothing was unread after a restart. The read marker was kept per device in `localStorage`. There was a "New" divider and "Jump to latest", but no "Jump to first unread", no sync and no server state. |
| Notification levels and mute | `app.js` `P.notify` | **Device-only.** All, mentions or muted per server, channel or DM were kept in `localStorage`. They didn't sync, and **push ignored them**: a muted channel still pushed mentions. There was no "mute for a while", no @everyone switch and no quiet hours. |
| Do Not Disturb | user status `dnd` | The status only. It stopped push and in-app sounds. |
| Push notifications | `pushTo` in `server/index.js`, `public/sw.js` | Pushes went out for mentions, replies, DMs, group messages, calls, events and trackers. A push is sent only when the person has no open window. The payload carried **the sender's display name and the channel and server name** (or the group name), but never message text. |
| Saved messages | `app.js` `P.saved`, Saved view | **Device-only, stored as decrypted plaintext in `localStorage`** (text, author, place). Not synced. |
| Drafts | `app.js` `drafts` (a `Map`) | Kept in memory per conversation. Survived only the app's own auto-update reload (`sessionStorage`), not a normal reload. |
| In-app notification centre, message reminders | `app.js` `P.inbox`, `features.js` | Device-only, by design. Unchanged. |
| Slow mode | `channels.slowmode`, checked in `POST /channels/:id/messages` | **Complete.** 0–21600 s, enforced by the server. Manage Messages and Manage Channels are exempt. The composer shows a countdown. Unchanged, and now covered by tests. |
| Member timeouts | none | **Missing.** Only instance staff could suspend whole accounts. |
| Reports | `POST /reports`, Admin → Reports | Reports go to instance staff, with evidence the reporter decrypted and with staff statuses. A reporter couldn't see a report's status, and could file the same report many times. |
| Data export | none | **Missing.** |

## 2. What this work adds (v18)

### Saved messages (bookmarks)
- The server keeps **message ids only** (`saved_messages`), plus an optional note that the app encrypts with the
  person's own vault key (`x1:`, the same scheme as study data). They sync across devices, and changes reach the
  person's other devices over the socket (`saved:update`).
- Home → More → Saved messages fetches the messages, decrypts them on the device, and shows them with
  "Jump to message", "Add a note"/"Edit note" and "Remove". If a message was deleted, or its conversation
  can no longer be seen, the item shows **"This message is no longer available"**. The server returns no
  ciphertext for that item.
- Up to 1000 saved messages per account. You can only save a message you can read right now.
- Migration: the first time a device starts with this version, its old local saved list is uploaded (ids
  only), and **the plaintext copy in `localStorage` is deleted**.

### Pins
- Pinning in a server channel now **needs Manage Messages, for your own messages too**. Group chats and DMs
  are unchanged: anyone in the conversation can pin.
- Each pin and unpin is recorded in the channel's pin history (`pin_log`). Members who can see the channel can
  read it in the pins panel ("Pin history").
- Each conversation can have at most 50 pinned messages, the same number the list shows.

### Unread tracking
- The server stores **the last-read message id per person per conversation** (`read_states`). On first use, a
  per-account baseline counts everything older as read, so an upgrade doesn't mark every old conversation unread.
- `GET /me/unread` returns, for every channel and DM the person can see: the last-read id, the newest message
  id, the unread count and the mention count (each capped at 100). The app loads it at start-up together with
  `/bootstrap`, so badges survive reloads and are the same on every device.
- Mention counts come from `mention_marks`, which records the ids the sender's app already sends for push
  (mentions and replies) and `*` for a valid @everyone. A channel's `mentions` are its top-level messages; pings in
  its threads come apart as `threadMentions` (see Threads below). In DMs and group chats, every message counts.
- `POST /me/read` moves the marker. It only moves forward unless the request says `unread: true` ("Mark
  unread"), so a slow device can't undo progress made on another. Every change is pushed to the person's other
  devices as `read:update`. Those devices update their badges and close any notifications still shown for that
  conversation. Sending a message marks the conversation read up to that message.
- In the app:
  - a **"New messages"** divider above the first unread message;
  - an unread bar ("3 new messages since 7:46 PM · **Jump to first unread** · **Mark as read**"). Jump loads the
    page around the marker if it isn't loaded yet;
  - **Jump to latest**, which already existed;
  - **Mark as read** and **Mark unread** on messages, channels, DMs and group chats, and **Mark server as read**
    (`POST /servers/:id/read`).

### Threads: unread replies and the Threads list (v19)
Before this, a thread reply counted nowhere: not as unread, not as a mention, and nothing listed a channel's threads.
- **Each thread has its own read marker**, a `read_states` row keyed `t:<root message id>`. It moves forward only
  (threads have no "Mark unread") and syncs like a channel's: `POST /me/read { conv: 't:<root>', messageId: <a reply
  in that thread> }` sends `read:update` to the person's other devices. Opening a thread marks it read up to its newest
  reply, and so does replying in it (the server then tells the person's devices, since a channel's thread pings can't
  be worked out from the message alone).
- **Where a thread counts as read from** is the latest of: its own marker, the channel's "every thread read up to"
  marker (`ct:<channel id>`, written by Mark as read), and the account's baseline. A thread nobody has opened since the
  baseline therefore shows all its newer replies as new, like a channel nobody has opened.
- **Unread replies** are other people's replies after that point (capped at 100, like every count).
- **Pings in threads**: a thread reply's @mentions, a reply to your message and a valid @everyone are kept in
  `mention_marks` under `ct:<channel id>` with the thread's root in `thread_id`. Every other reply in a thread you
  started is not a ping (the server still pushes those as replies, as before); the thread's unread count shows them.
  `GET /me/unread` gives each channel `threadMentions`: the pings in its threads that their thread hasn't been read
  past. So do a thread's `read:update`, `state` in `GET /messages/:id/thread`, the first page of the Threads list and
  Mark as read; a plain channel read doesn't (it can't change the count, so the app keeps what it has). The app adds
  them to the channel's badge (not when the channel is muted). @everyone in a thread follows the same rules as in the
  channel (Mention Everyone, and "ignore @everyone").
- **The count looks at your newest 500 pings in the channel's threads.** Pings in threads you've already read stay in
  `mention_marks` (each thread has its own marker), so without a bound the count would walk all of them, on every
  thread read and `/me/unread`, and someone could pile them up on purpose. An unread ping older than your newest 500
  there is left out of the channel's badge; its thread still shows it ("@ 1 new" on its message and in the panel).
- **A ping that's deleted stops counting** on the server at once. The app asks for that thread's state again (with
  the channel's `threadMentions`) when a reply it may have counted is deleted, and opening a thread or the Threads
  panel sets the badge from the server too.
- **Reading a channel doesn't mark its threads read.** Scrolling through a channel moves only its own marker, so a
  ping in a thread stays on the channel's badge until that thread is opened. **Mark as read** in the channel's or a
  group's menu (`POST /me/read` with `threads: true`) and **Mark server as read** are the exception: they mark the
  channel's threads read too, up to the newest message in the channel at that moment (one `ct:` marker, not one per
  thread), because the badge they clear includes the threads' pings. The answer and `read:update` carry `threadsRead`
  (that id), so other devices clear their thread badges as well. The bar over the messages ("3 new messages since
  10:44 AM · Mark as read") counts the channel's own messages, so its Mark as read leaves the threads alone.
- **`GET /channels/:id/threads`** lists a channel's threads, the one with the latest reply first, 25 a page
  (`?limit=` up to 50, `?before=<lastReplyId>` for the next page). Each item has the first message as stored
  (ciphertext, decrypted by the app), `replyCount`, `lastReplyId`, `lastReplyAt`, `participants` (up to 5 people who
  replied most recently) and the caller's `unread`, `mentions` and `lastReadId`. The order comes from
  `thread_activity` (each thread's newest reply), written by `POST /channels/:id/messages` when a reply is posted and
  kept right by triggers when replies, threads or channels are deleted.
- `GET /channels/:id/messages` adds `threads: { <root id>: state }` for the messages on the page that start a
  thread, and `GET /messages/:id/thread` adds `state` (where the "New replies" line goes, and the channel's
  `threadMentions`). The first page of `GET /channels/:id/threads` carries the channel's `threadMentions` too.
- In the app:
  - the line under a message that starts a thread says what's new: "3 replies · **2 new**" (red with @ when one of
    them pings you), updated live as replies arrive;
  - a **Threads** button in the channel header (and in group chats) opens the Threads panel; the button carries the
    number of pings in the channel's threads, or a dot for new replies the app has seen;
  - the panel shows each thread's first message (decrypted on the device), who replied, how many replies, when the
    last one came and what's new; replies move their thread to the top live; picking one opens it, and closing it
    (or **Back to threads**) returns to the list, at the same place and with the keyboard on that thread's card;
  - a card shows its first message the way the channel does: a thread started by someone you blocked is folded away
    ("Thread started by someone you blocked. Show") and their picture stays out of the card's repliers; a bot's or a
    webhook's has the BOT tag, the webhook's own name and picture and the "not end-to-end encrypted" flag. Links in a
    card's preview are plain text (the card is one button: open the thread to follow them);
  - an open thread draws a **New replies** line above the first reply you hadn't read, and reading along keeps the
    thread read: only while the side panel shows it and the window is showing (a thread left chosen behind the
    member list doesn't mark replies read).
- **Permissions**: everything is checked against the channel, like its messages. A channel you can't read answers
  "Channel not found", and a thread in one answers "That thread doesn't exist", exactly as for ids that don't exist.
  Pings are only kept for people who can see the channel (as before). Rate limits: the list 60 a minute per person;
  read markers share the existing 240 a minute.

### Notification preferences
- Preferences for each server, channel and DM are stored on the server (`notify_prefs`) and synced
  (`notify:update`). Each one has:
  - a level: default, all, only @mentions, or nothing;
  - **mute for a while** (15 minutes, 1 hour, 8 hours, 24 hours) or until turned back on;
  - **ignore @everyone and @here**.
- **Quiet hours**, a Do Not Disturb schedule (`user_prefs.data.dnd`): a start time, an end time and the days a
  quiet period starts on, in the person's own time zone. The app sends its time zone, and the server uses Intl to
  work out local time.
- **The server applies all of this before it sends a web push** (`pushAllowed` in `server/usability.js`):
  - The DND status, or quiet hours in effect, blocks every push.
  - A conversation or server that is muted, or set to nothing, gets no message pushes.
  - Suppressed @everyone pushes are dropped. A direct mention still gets through.
  - Server channels push only pings (mentions, replies, @everyone) unless "All messages" was picked for the
    channel or its server. Then they push every message. DMs and group chats push every message by default.
  - Calls, event reminders and tracker updates follow quiet hours only.
- **@everyone push**: the app now marks messages that use @everyone, @channel or @here (`everyone: true`). The
  server honours this only from someone with Mention Everyone in that channel, then pushes the members who can
  see the channel. Before this, @everyone never pushed.
- **Android, with the app closed** (1.29): the Android app gets a Web Push address from a UnifiedPush push app
  (ntfy, or a self-hosted ntfy: `PUSH_NTFY_URL`) and subscribes it like a browser, so every rule here applies to
  it unchanged. Notifications go to three channels (Messages, Calls, Events and updates); a call push rings for
  at most 45 s, and one older than two minutes (`at`, the send time, is in every push) shows as a missed call, in
  the browser's service worker too. Tapping opens the message, the DM, or the call's conversation with its ring
  card if the call is still on (`#call/<room>`; only DM and group calls ring, the calls the server rings), and
  opening the app while a call rings does the same. Reading a conversation in the app also clears the
  notification posted while it was closed. The "In a call" notification names the call only with "Show who and
  where on the lock screen" on. Settings → Apps & devices → *Notifications when Hearth is closed*, with the push
  app's name, *Change*, and how it works; the app offers it once.
- **Lock-screen privacy**: what a push looked like before is described in the inventory above. Now **previews
  are hidden by default**: a push says only the instance name and "New message" (or "Incoming call", "An event
  is starting soon", "New updates"). Settings → Notifications → "Show who and where on the lock screen" brings
  back the sender and place. Message text is never in a push, either way.
- **One notification per message**:
  - **Across tabs**: the first tab to claim a message (a Web Lock plus a short list in `localStorage`) plays the
    sound and shows the desktop notification. The other tabs stay quiet.
  - **Across devices**: push goes only to accounts with no open window, as before. Reading on one device
    closes the notifications for that conversation on the others (`read:update`). Pushes use the conversation
    as their tag, so a new one replaces the last.
- The app applies the same quiet-hours rule to its own sounds and pop-ups.
- Migration: on first start with this version, a device's old local levels are uploaded if the server has none.
  The local copy is then removed.

### Drafts
- What you type is kept per conversation, and per thread, in `localStorage` under `hearth.drafts.<userId>`. It
  survives switching conversations and reloads, and is written right away when the page is hidden.
- It never leaves the device. Sending clears it, and signing out removes all drafts. Drafts older than 30 days
  are dropped, and at most 200 are kept.

### Export my data
- Settings → Privacy & safety → **Export my data**.
- Starting an export calls `POST /me/export`, which **needs the password, plus a 2FA code when 2FA is on**
  (`stepUp`). It is written to the audit log (`data_export`) and limited to 5 per hour.
- It returns a random token. The server keeps only the token's SHA-256 hash. The token works for 30 minutes,
  only from the same session, and for at most 200,000 messages in total.
- `GET /me/export/account` and `GET /me/export/messages` (header `X-Export-Token`) return:
  - the account and profile;
  - servers and groups (with your roles and the text channels you can read);
  - DMs, friends, blocked people, saved items, notification settings, read markers and the reports you filed;
  - then every readable conversation's messages **as ciphertext**, oldest first, with thread replies included.
  Access is checked again on every page.
- The app decrypts everything on the device and downloads a zip (stored entries, written by a small zip writer
  in `public/js/usability.js`, so no new dependency). The zip holds:
  - `account.json`;
  - `conversations/*.json` (author, time, text, replies, threads, reactions, polls, attachment details; messages
    that couldn't be decrypted are marked);
  - `attachments/` (decrypted);
  - `manifest.json` (totals and anything skipped, with the reason);
  - `README.txt`.
- **Limits**: 200,000 messages, 50,000 per conversation, 500 MB of attachments and 100 MB per file. Progress and
  a Cancel button are shown while it runs.
- **Not included**:
  - other people's private details (only the names and ids already shown in Hearth);
  - conversations you can no longer see;
  - passwords, keys and sessions.

### Moderation
- **Slow mode** already existed and was enforced by the server. Tests now cover it.
- **Timeouts**:
  - `POST /servers/:id/members/:uid/timeout` with `{ minutes: 1–40320, reason }`, and `DELETE` to lift one early.
  - It needs **Kick Members** and follows **role order** (`perms.top`): only people whose highest role is below
    yours. The owner, Administrators and yourself can't be timed out.
  - Both setting and lifting a timeout are written to the audit log (`member_timeout`, `member_timeout_removed`).
  - A timed-out member keeps reading. They can't post, edit, react, start threads, vote, type, invite or speak in
    calls. This is applied in `perms.js` (`TALK` bits removed in `base` and `channel`, and a channel override
    can't give them back), so every existing permission check enforces it. Their app shows the composer as
    read-only, with the end time. A timed-out moderator also can't use the moderator toolkit (voice moderation,
    bulk delete, a ban's message cleanup) until it ends; kicks, plain bans and single deletes work as before.
  - Timeouts are kept in their own table, so leaving and rejoining doesn't clear one.
  - Moderators can list active timeouts (`GET /servers/:id/timeouts`). In the app, the member menu has
    "Time out…".
- **Moderator toolkit** (later): voice moderation, ban with cleanup and bulk delete.
  - Two new permissions: **Mute Members** (`1 << 17`) and **Move Members** (`1 << 18`). Move Members is
    channel-scoped (it can be given in one voice channel only). Mute Members is server-wide only, because a server
    mute holds in every voice channel. Neither can be on a role that's sold as a membership.
  - `POST /servers/:id/voice/:uid/disconnect` and `/move { channelId }` (Move Members in the channel they're in,
    and for a move in the destination too, which they must be allowed to connect to); `POST`/`DELETE
    /servers/:id/voice/:uid/mute` (Mute Members server-wide, whether or not they're in a call). Role order as for
    timeouts; never the owner or yourself; not in group chats; not while you're timed out. Audit log:
    `voice_disconnect`, `voice_move`, `voice_mute`, `voice_unmute`.
  - Server mutes are kept in `voice_mutes` until lifted, so leaving the call or the server doesn't clear one. They
    never apply to the owner, and a transfer (yours or the instance staff's) drops the new owner's. People with
    Mute Members get `voiceMutes` (user ids) with the server, so the app can show and lift a mute outside calls
    (member menu, Server settings → Members). How the apps enforce them is in `docs/VOICE.md` (section 6).
  - `POST /servers/:id/bans` takes `deleteHours`: 0 (default), 1, 24 or 168. Their messages in every channel of
    the server from that window go, channel by channel in slices of 500, each slice in one transaction, letting
    other requests in between slices. A thread they started goes with other people's replies only if the
    moderator has Manage Messages in that channel and every other replier is below them (as bulk delete would);
    otherwise it stays. The answer is `{ deleted, replies, kept }`, and so is the audit entry
    (`ban_messages_deleted`). Refused while the moderator is timed out (a plain ban isn't).
  - `POST /channels/:id/messages/bulk-delete` with `{ ids: [...] }` (up to 100) or `{ count: 1–100 }` (the newest
    messages). Manage Messages in the channel; messages older than 14 days can't be picked; messages by people at
    or above your highest role are kept (the answer says how many). One transaction, one
    `message:delete-bulk { channelId, messages: [{ id, threadId }] }` event per channel, one audit log entry
    (`messages_bulk_deleted`). Like a single delete, thread replies, files, reactions and poll votes go too, and bots
    get `message.deleted` for each message (written in one transaction per channel, `BOTS.events`). Refused while
    you're timed out.
- **Server audit log and report inbox** (v19, `server/serveraudit.js`):
  - A new permission, **View Audit Log** (`1 << 19`), server-wide; owners and Administrators always have it. It
    counts as a moderator power, so it can't be on a role sold as a membership or one members pick themselves.
  - Every server-scoped moderation action and settings change also goes in that server's own log (`server_audit`):
    kicks, bans (with the cleanup's counts and the invites it revoked), unbans, timeouts, member role changes
    (picked by the member themselves: `self: true`, at most 20 such entries per member per hour; from a membership:
    `membership: true`), roles, channels and categories, channel overrides (before and after), invites, emoji,
    webhooks, bots, voice disconnect/move/mute, moderators deleting other people's messages (single, bulk, and
    instance staff removing a reported one, shown as "<instance name> staff"), pins, server settings (which ones
    changed, not the new text) and ownership. Never message text. Handling reports isn't logged there (the
    person reported may be able to read the log); who handled a report and when stays on the report.
  - `GET /servers/:id/audit` pages newest first and filters by kind and person (by id, or `username` for people
    who are no longer members). Names of channels the reader can't see stay hidden; a deleted channel counts as
    private if it was when deleted. Open Audit log tabs update live (`audit:watch`, `audit:new`, at most every
    2 seconds; the tab fetches at most every 3).
  - Append-only (database triggers), kept for a year and up to each server's newest 10,000 entries, never fewer
    than the last 7 days. Beyond 50,000, only moderation stays (kicks, bans, timeouts, roles given by others,
    deleted messages, permissions, roles, ownership, voice, webhooks, bots); beyond 200,000 nothing does
    (`serveraudit.prune`, hourly).
  - Invite creation is now limited (60 per 10 minutes per person), and so are revoking invites (60 per 10 minutes)
    and unbans (with bans, 30 a minute): each one is an entry, and a loop shouldn't bury the log. Making invites,
    and revoking your own, are written at most 10 times an hour per person; the invite dialog reuses a link you
    made in the last 10 minutes with the same settings.
  - Reports about a message in a server channel, or about a member reported from inside a server, also reach the
    server's moderators (Server settings → Reports), without the reporter: category, note, and the reported
    person's own messages from the reporter's chosen evidence (the rest stays with staff). Moderators mark them handled or dismissed (their own `server_status`); staff keep their own status
    and see the moderators' in Admin → Reports. The reporter can opt out; child-safety reports are staff-only.
- **Reports**:
  - Reporters can see the status of their own reports (`GET /me/reports`, without staff notes).
  - Reporting the same message again while the first report is still open returns the existing report
    instead of filing a new one.

## 3. API summary

| Route | Auth | Notes |
|---|---|---|
| `GET /me/saved`, `GET /me/saved/ids` | session | your own only; 120/min |
| `PUT /me/saved/:id` `{ note? }`, `DELETE /me/saved/:id` | session | message must be visible; note must be `x1:`; 60/min |
| `GET /me/unread` | session | 60/min |
| `POST /me/read` `{ conv, messageId, unread?, threads? }` | session | conversation access checked; message must be in it; `t:<root>` for a thread (a reply in it, forward only); `threads: true` marks a channel's threads too; 240/min |
| `POST /servers/:id/read` | member | channels you can see, their threads too |
| `GET /channels/:id/threads` `?before=&limit=` | can view channel | text channels; latest reply first; 25 (max 50) a page; 60/min |
| `GET /me/notify` | session | your own only |
| `PUT /me/notify/:target` `{ level, muteUntil, suppressEveryone }` | member of that place | 120/min; up to 2000 rows |
| `PUT /me/notify-settings` `{ dnd, tz, previews }` | session | 120/min |
| `GET /channels/:id/pins/log` | can view channel | newest 50 |
| `GET /servers/:id/timeouts` | Kick Members | |
| `POST/DELETE /servers/:id/members/:uid/timeout` | Kick Members + role order | audit-logged; 30/min |
| `POST /servers/:id/voice/:uid/disconnect`, `/move` | Move Members (per channel) + role order | audit-logged; 60/min |
| `POST/DELETE /servers/:id/voice/:uid/mute` | Mute Members (server-wide) + role order | audit-logged; 60/min |
| `POST /channels/:id/messages/bulk-delete` | Manage Messages in the channel | 100 messages, 14 days; audit-logged; 10/min |
| `POST /servers/:id/bans` `{ userId, reason, deleteHours }` | Ban Members + role order | cleanup audit-logged; 30/min |
| `GET /me/reports` | session | your own only |
| `POST /me/export` | **step-up** | audit-logged; 5/hour |
| `GET /me/export/account`, `GET /me/export/messages` | session + export token from the same session | 600 pages/min |

Socket events go only to `user:<you>`: `saved:update`, `read:update` (a thread's carries `conv: 't:<root>'`,
`rootId`, `channelId` and the channel's `threadMentions`), `notify:update`, `notify:settings` and `timeout:update`.
The Threads panel follows the channel's existing `message:new` and `thread:update` events.

## 4. Data model (v18, `server/db.js`)

| Table | Holds | Readable text? |
|---|---|---|
| `saved_messages` | user, message id, optional `x1:` note, time | no |
| `read_states` | user, conversation key (`c:`, `d:`, `t:<thread root>`, `ct:<channel>` for "its threads read up to"), last-read message id | no |
| `mention_marks` | message id, conversation (`ct:<channel>` for a thread reply), user id or `*`, thread root (v19) | no (ids the sender's app already sent for push) |
| `thread_activity` (v19) | thread root, channel, newest reply id | no |
| `notify_prefs` | user, target, level, mute-until, ignore-@everyone | no |
| `user_prefs` | user, JSON (quiet hours, time zone, previews), read baseline | no |
| `pin_log` | channel, message, who, pin or unpin, time | no |
| `member_timeouts` | server, user, until, reason, by whom | the reason a moderator typed |
| `voice_mutes` | server, user, by whom, when | no |

Rows in `mention_marks` are deleted with their messages (`forgetMessages`, `deleteMessageTree`, the orphan
sweep). Read markers and preferences for deleted channels, DMs and servers are swept daily.

**New metadata the server keeps**: who reads up to where, and when; who saved which message ids; who mutes what;
and quiet-hours times and time zone. The server could already see who was mentioned at the moment a message was
sent. It now keeps that list.

## 5. Tests

`test/threads.test.js` (10 tests, v19):
- **Threads list**: latest reply first, paged by `?before=`; reply counts, participants (most recent first, once
  each), the first message as ciphertext; your own replies aren't new to you; bad `before` and limits; voice
  channels refused; an empty channel lists nothing.
- **Thread markers**: the messages page and the thread view carry your state; reading the channel leaves threads
  alone; forward only, no "Mark unread"; the marker must be a reply in that thread; synced to your own devices only;
  replying reads the thread; outsiders get "not found" and nothing is stored.
- **Thread pings**: mentions and replies to you count in the channel's `threadMentions`, plain replies to the thread's
  starter don't; reading the channel keeps them (and its answer leaves the count out), opening the thread clears them;
  the thread view and the Threads list's first page carry the count; "Mark as read" (`threads: true`) and "Mark
  server as read" clear every thread; @everyone needs Mention Everyone and honours "ignore @everyone".
- **Deleted pings**: a deleted ping stops counting, and the thread view and the list say so.
- **The bound**: with 600 read pings stored after an unread one, the badge counts from the newest 500 (the old one is
  left out, its thread still shows it), and a newer ping counts as usual.
- **Private channels**: the list, markers and pings never reach people who can't read the channel, and answer exactly
  like ids that don't exist; losing access takes the list away.
- **Rate limit** on the list, per person.
- **thread_activity**: right after deleting a thread's newest reply, its only reply, the thread, a bulk delete and a
  deleted channel; rebuilt from the replies when the table is missing (an upgrade).
- **Query plans**: the list, unread replies and pings use their indexes; a channel's thread pings are merged newest
  first from two index ranges (no sort), so the walk stops at 500.

Browser flow (`test/e2e/flows.mjs`, "threads"): a ping in a thread shows on the message, the Threads button and the
channel's badge, survives a reload, and goes when the thread is opened from the Threads panel (with a "New replies"
line); **Back to threads** puts the keyboard on that thread's card; the panel follows a new reply live; a reply that
arrives while the member list covers the thread stays new; a ping that's deleted leaves no badge; a thread started by
someone you blocked is folded away in the panel; "Mark as read" on the channel clears its threads.

`test/usability.test.js` (12 tests):
- **Saved messages**: per account; other people can't read or delete your saved items; you can't save what you
  can't see; notes must be ciphertext; "no longer available" after a delete or after losing access; sync goes
  only to the owner's sockets.
- **Read state**:
  - counts and mention counts;
  - your own messages aren't counted;
  - the marker only moves forward unless marking unread;
  - socket sync goes only to your own devices;
  - outsiders and other members can't read or write your markers;
  - DM rules;
  - @everyone counts only from someone allowed to use it, and can be suppressed.
- **Preferences**: your own only; refused for places you're not in; input checked.
- **Push**, with a local push service that decrypts payloads (RFC 8291):
  - previews are hidden by default and names show on opt-in;
  - plain messages push only with "All messages";
  - "nothing", mute-for-a-while and unmute work;
  - @everyone pushes and can be suppressed, while a direct mention still gets through;
  - quiet hours block DMs and mentions, and a schedule that doesn't cover now lets them through;
  - a muted DM stays quiet.
- **Export**:
  - no password, a wrong password, or a missing 2FA code are refused;
  - a missing or made-up token is refused;
  - another user's token is refused;
  - the same token from another session of the same account is refused;
  - unreadable conversations are refused;
  - starting an export is audit-logged.
- **Pins**: Manage Messages is needed even for your own message; the history is recorded; outsiders can't read
  it; the limit is 50; group members can pin.
- **Slow mode** and **timeouts**: enforced by the server, with permission, role-order, owner, admin and self
  checks; post, edit, react, vote and typing are blocked; reading still works; rejoining doesn't clear a timeout;
  expiry and early lifting work; audit entries are written.
- **Reports**: you see your own, and repeats return the existing report.
- **App helpers**: quiet hours give the same answer as the server; the zip is valid (headers and CRC-32s); saving
  no longer writes plaintext to the browser.

Browser check (Playwright, not part of `npm test`): two real accounts registered through the UI, and a second
device for one of them. It covers:
- the unread badge after a reload;
- the divider position;
- unread bar text;
- "Jump to first unread" and "Mark as read";
- the server read marker;
- read sync to the second device;
- mark unread;
- the saved view (decrypted, encrypted note, synced, "no longer available");
- muting a channel (saved on the server, synced to the second device, no dot);
- quiet hours;
- drafts across conversation switches and reloads, cleared on send;
- Export my data (a wrong password is refused, then a valid zip with decrypted messages).

## 6. Known limitations

- Counts are capped at 100 per conversation (shown as "99+").
- Thread replies don't make a channel unread (bold): they count in their thread ("2 new" and the Threads panel), and
  their pings count in the channel's badge (v19).
- Mention counts depend on the sender's app sending mention ids, as push already did. A modified app could leave
  them out or add extra ones. It can't add ids for people who can't see the channel.
- The Threads button's dot only knows the threads this app has seen (on the loaded page, live, or in the panel);
  its count of pings is the server's.
- The channel's count of thread pings looks at your newest 500 pings in its threads (see above).
- Replies from someone you blocked still count as new in their thread, as their messages do in a channel; they never
  count as pings.
- Threads have no "Mark unread".
- Cross-device dedupe closes notifications when you read elsewhere. It doesn't pull back a push already
  delivered to a phone whose app is closed. Browsers can't be pushed silently.
- Quiet hours use the time zone of the last device that signed in.
- The export is held in browser memory before it downloads (hence the limits). There is no resume if the tab
  closes.
- Timeouts are enforced through permissions. Voice reacts to them through the existing `recheckVoice` when the
  server updates. The timeout end is swept every minute, plus an in-memory timer.
- The server enforces the new pin rule (Manage Messages for your own message), and the app hides the action.
  Older app versions still show it and get a friendly 403.

## Link previews

Built by the sender, carried inside the encrypted message. Design and the reasons behind each choice:
[design/LINK-PREVIEWS.md](design/LINK-PREVIEWS.md). No schema change: the only stored state is the
`linkPreviews` key in the owner's `features` setting.

**How it works**

1. The composer (`public/js/app.js` `createComposer`) looks for the first https link in the box, outside code
   and spoilers (`linkpreview.js` `findPreviewUrl`, using `markdown.js` `linkedUrls`). Image links, GIF media,
   links to this server, IP addresses, reserved names and other ports are skipped. It looks on paste, as soon
   as a space follows the link and the caret has left it, or after 1.2 s without typing, never when a draft is
   put back. Editing inside a link counts as typing it: the chip goes, and the new link waits for the pause.
2. In **Ask each time** mode (the default) a chip offers "Preview example.org?" and nothing leaves the device.
   **Preview** (or **Always** mode) calls `POST /api/link-previews { url }`. In Always mode, links that look
   private (sign-in, reset, invite and share links: `looksPrivate`) still ask.
3. The server (`server/linkpreview.js`) checks the link, fetches the page through `netguard.request` and reads
   its `<head>` in a worker thread: OpenGraph, then X/Twitter card tags, then `<title>` and
   `<meta name=description>`. It fetches at most one picture and checks it by its bytes. YouTube links use
   oEmbed and `i.ytimg.com` thumbnails (the watch page is never fetched); X post links use
   `publish.twitter.com/oembed` text (x.com is never fetched).
4. The app shrinks the picture to at most 400 px and 16 KiB (WebP, or JPEG where the browser can't make WebP;
   `media.js` `previewThumb`). The chip shows the card with a **Remove link preview** button.
5. Sending puts `l: [{ v: 1, url, title, desc, site, kind, img? }]` in the payload next to `t` and `f`, only
   if the card is ready (sending never waits) and its link is still in the text. If the ciphertext would be
   over 64,000 characters, the picture is dropped first, then the card (`payloadVariants`, `encryptFitting`).
6. Readers' apps (`secure.js` `openGroup`/`openDm` → `cleanLinks`) keep the card only if its URL is one of the
   message's links (outside code and spoilers), https, without credentials, without a mixed-script host or bidi
   characters, with every field capped and the picture a real WebP/JPEG of at most 16 KiB. `linkCardEl` draws
   it with text nodes only; the domain line is read from the link. The picture is a `data:` URL: nothing is
   fetched to show a card.

**Settings**: Settings → Chat → Link previews (*Ask each time*, *Always*, *Never*; and *Show link previews in
messages*), kept per device in `hearth.chat`. Owner switch: Admin → Owner → Features → Link previews
(`features.linkPreviews`; `LINK_PREVIEWS=false` starts it off). The role permission **Show link previews**
(EMBED_LINKS) is now used: readers show cards only from senders who have it server-wide (DMs always; groups
give it to everyone), since their apps can't see channel overrides, and the composer offers previews only where
readers will show them: with the permission server-wide and in that channel (`perms.js` `mayEmbed` on both
sides). A channel override can turn previews off, not on.

**Edits, forwards, export**: an edit keeps the previews whose links are still in the text (and the poll, which
edits used to drop); a link added in an edit gets none. Forwarding carries the card. The data export writes
`link: { url, title, description, site }` (no picture).

**API**

| Route | Auth | Notes |
|---|---|---|
| `POST /link-previews` `{ url }` | session | 404 `off` when the owner switched it off; 400 `bad_url` / `own_server`; 429 `rate_limited` (20/min per account and per session, 60/min per network, 100 fetches/hour per account) or `busy` (2 in flight per account, 8 on the server; `Retry-After: 2`). Fetch problems answer 200 `{ preview: null, reason }` with `none`, `not_html`, `blocked`, `unreachable`, `timeout`, `challenge` or `busy` (over 60 fetches a minute to one site, from everyone together). |

Fetch limits: https on port 443 only, at most 4 redirects for the page and 3 for the picture (each hop checked
again), 512 KiB of page (unpacked), 2 MiB of picture (48 to 8192 px a side, at most 25 megapixels), 10 seconds
for both together, 2 seconds to read the page. Answers are cached in memory per account (10 minutes for a
preview, 2 for a failure; at most 20 per account, 2,000 and 48 MiB in all) and never shared between accounts.
The job `linkpreview.cache_sweep` clears old entries every minute. The log gets one line per preview with the
outcome and timing, never the link, host or title.

**Tests**

- `test/linkpreview.test.js` (23 tests, a local HTTPS stand-in site answering for many names, and a fake DNS):
  OpenGraph, fallbacks and "first tag wins"; hostile HTML (comments, scripts, raw-text elements, entity tricks,
  `javascript:` and `data:` picture links, 5,000 meta tags, pathological markup including the short quote
  patterns that once made the tokenizer re-read each 8 KiB, each under a second for 512 KiB); named entities,
  escaped angle brackets and empty comments; a parse that times out fails alone (jobs queued behind it and
  sent just after still work, one reader thread is left); length caps and invisible
  characters; charsets (BOM, header, `<meta>`, windows-1252, Shift_JIS, UTF-16 labels); URL refusals; private,
  rebinding, NAT64, `OUTBOUND_BLOCK` and unlisted loopback names refused before connecting; redirects to http,
  private names, IP literals, reserved names, this server and 5-hop chains; an endless page, a gzip bomb, a
  late tag and a site that never answers; PDF, JSON, direct pictures, 404s; pictures that lie about their
  type or size; challenge and consent pages; every rate limit and the in-flight cap; the per-account cache;
  YouTube, X and GitHub; the owner switch (404, audit log, `/api/config`); signed-out and suspended sessions;
  and that the log never names the link.
- `test/linkpreview-client.test.js` (10 tests): which link the composer offers; `linkedUrls` matches `render()`;
  what `cleanLinks` keeps and drops (links not in the text, homographs, bidi, oversized or mislabelled
  pictures, junk); `looksPrivate`; a 4,000-character message with a full card fits, bigger ones drop the
  picture then the card (real `encryptGroup`/`encryptDm`); older apps still read the text; `mayEmbed` and that
  the composer and readers both use it; static checks that cards are built from text nodes and the 64,000
  limit matches the server.
- Browser flow (`npm run test:e2e`, "link previews"): the chip asks, a turned-down link goes out plain and
  nothing is fetched, then Preview → card → send; the reader sees the card with the link's own domain and a
  `data:` picture, and their app makes no request to the site or to `/api/link-previews`. Keyboard only: Enter
  on Preview leaves the focus in the box, so the next Enter sends. In Always mode, three Backspaces inside a
  link make no request until the pause, then one for the link as it is; the half-edited ones are never fetched.

**Known limitations**

- The server sees every link someone previews, who asked and when, and can match it to the encrypted message
  sent just after. In Always mode that includes links typed and then deleted before sending.
- A server-side GET can use up a one-time link (a magic sign-in or reset link) if someone previews it.
- The site sees this server's address and can tell that someone on it previewed the link just now.
- A modified app can send a card saying anything (the domain line can't lie), or send cards without the
  permission: readers check the sender's server-wide permission only, as for @everyone. So a channel override
  can't give someone previews, only take them away there.
- Pages rendered only by JavaScript, or with their tags after 512 KiB, get a title-only card or none. X's embed
  service has been unreliable, so X links often get no card.
- A message with a picture is about 30 KB of ciphertext instead of about 0.5 KB.

## 7. Disappearing messages (v19)

A timer per conversation; design and research in [design/DISAPPEARING-MESSAGES.md](design/DISAPPEARING-MESSAGES.md).
What this pass built, and where it differs from that design:

- **Setting it.** `PUT /api/channels/:id/disappearing` and `PUT /api/dms/:id/disappearing` with `{ seconds }`:
  0, 3600, 86400, 604800 or 2419200 (and 5 under `NODE_ENV=test`), anything else 400 `bad_timer`. DMs: either person,
  403 after a block either way, 403 `deleted` when the other account is deleted, 404 for outsiders. Group chats: any
  member. Server channels: Manage Channels in that channel (`requireManageableChannel`), a channel you can't see is
  404, voice channels 400 `bad_channel`. Limits: 10 changes a minute per person, and 10 an hour per person in each
  conversation (not one budget for the whole conversation, which one person could use up to lock the timer for
  everyone else). The same value again changes nothing (no log line, no event). `GET` on the same paths gives `{ seconds, log }` (the last 20
  changes). Live: `disappear:update { conv, channelId | dmId, id, seconds, prev, by, at }` to whoever can see the
  conversation (`toChannel`, or both DM users).
- **Shown.** `disappear_log` keeps who changed what and when (50 per conversation); history pages carry the changes
  that fall inside them (`timerEvents`) and the apps draw them between the messages, each under its own day's
  divider. Pages meet without gaps: a `?before=` page ends at its anchor's id time, an `?after=` page starts at its
  anchor's `created_at`. Channels carry `disappear` in
  `serializeChannel`, DMs in `serializeDm`. The app adds a timer button to the header, a note above the composer, a
  line in the welcome block, a badge on each disappearing message, and the choices in the DM, group and channel ⋯
  menus and in Edit channel. Turning it on asks first and says what it can't do.
- **Stamped.** Each send stamps `expires_at = created_at + timer` (`DISAPPEAR.stamp`), capped by the thread's first
  message for replies. Bot posts, webhook posts (`BOTS.botPost`) and the news bot are stamped too; a test checks that
  every `INSERT INTO messages / dm_messages` in `server/` sets `expires_at`. The app sends `ttl` (the timer it
  encrypted for) and puts the same timer inside the encrypted payload as `x`, next to the text, files, poll and link
  preview card (`l`, which a too-long message drops before anything else); a `ttl` that doesn't match gets 409
  `disappear_changed` and the app fetches the timer and sends again once, by itself only when the new timer is on or
  shorter than the one the message was written under; turned off or made longer, it asks first ("Send anyway?") and
  otherwise gives the words back. Apps that send no `ttl` are stamped from the
  conversation. Edits keep the deadline (and the app keeps `x`, the poll and any link preview whose link is still in
  the text inside an edited message).
- **Never served after its time.** History pages, threads, the Threads list (a thread whose first message has gone,
  or all of whose replies have, isn't listed), a thread's reply count, latest reply, who replied and its unread and
  ping counts, pins, search, saved, export, reply quotes, DM and group previews, `locate`, the bot API and
  `/uploads/` (404 for an expired file, `Cache-Control: no-store` for a disappearing one) skip expired rows in SQL
  (`LIVE`) or with `alive()`, so none of that depends on the sweep having run. Editing, deleting (by its author, a
  moderator or staff), reacting, pinning, voting, saving, reporting and marking a thread read (or read up to an
  expired reply) for an expired message are 404. Bulk delete and a ban's cleanup leave expired rows to the sweep: they
  aren't counted in the answer or in the audit log entry, and an expired reply doesn't hold a thread back. One thing
  still counts them until the sweep has run: a channel's or DM's own unread and ping counts (normally for a fraction
  of a second; the app asks for them again when a conversation with unread messages loses some). The sweep's deletes
  keep `thread_activity` right through the same triggers as any delete, and write nothing to a server's audit log
  (nobody deleted them; `disappearing.test.js` checks it). Entries written while the message was there stay: the
  audit log keeps who pinned, unpinned or deleted whose message in which channel, never the message itself, for up
  to a year.
- **Deleted.** `server/disappear.js`: a precise timer armed for the earliest deadline (`MIN(expires_at)` over the
  partial indexes; deadlines past setTimeout's 24.8-day limit wait for the sweep), plus the `messages.expire` sweep
  every minute (`DISAPPEAR_SWEEP_MS`), plus a run at start-up before the server listens (up to 50,000 rows; a bigger
  backlog carries on in the background). Batches of 500 per table, 5,000 per run, then `setImmediate`. Each batch
  deletes the messages with their thread's replies, `blobs` and files (quota freed through `removeUpload`),
  reactions, poll votes and closure, mention marks, saved entries and pin history, in one transaction; files after
  the commit.
- **Announced** with the events a normal delete sends, marked `expired: true`: `message:delete-bulk` (with a group
  chat's new `last`), `thread:update` for threads that lost replies, `dm:delete` per message (with the DM's new
  `last`), `saved:update { saved: false }` to everyone who saved one, and bots' `message.deleted` with
  `deletedBy: null, expired: true`. (The design had new `message:expire` / `dm:expire` events with a fallback for older
  apps; the moderator toolkit's `message:delete-bulk` landed meanwhile, so older apps already understand these.)
- **Forensics.** `PRAGMA secure_delete = ON` on the server's connection (deleted rows are zeroed in the file), and
  `wal_checkpoint(TRUNCATE)` after a sweep that deleted rows, at most every `DISAPPEAR_CHECKPOINT_MS` (10 minutes).
- **In the apps.** `public/js/disappear.js` (pure, tested under Node) works out a message's deadline: the earlier of
  `expiresAt` and `createdAt + x`, where `x` counts only if it's one of the timers `/config` offers (so a modified app
  can't make a message vanish from its readers' screens within seconds, before anyone could report it). `app.js` keeps the server's clock (`serverNow` from `/bootstrap`), hides messages
  at their deadline with one timer (re-checked at most hourly, and on focus and visibility), and when one goes drops
  its decrypted files (`fileUrls.drop(…, true)`), stops a voice message playing, closes the image viewer, cancels a
  reply or edit on it, closes its notification (`closeNotificationFor`), purges inbox entries and reminders that copy
  its words (`exp` on each), removes it from open search results, and redraws pins and saved. Unread and mention
  counts are asked for again (`/me/unread`, debounced to at most every 30 seconds) when a conversation with unread
  messages lost some. A message that arrives live is in the expiry timer as soon as it's in the conversation.

Not built in this pass (the design's later phases): leaving disappearing messages out of backups
(`BACKUP_DISAPPEARING`, `scrubDisappearing`; backups keep them until they rotate out), the export checkbox (the zip
includes messages that haven't disappeared yet), the Android notification timeout (`setTimeoutAfter`; until then a
notification shown while the app was open, or posted from a push while it was closed, stays after it's closed, as the
README says; while the app runs, `closeNotificationFor` also cancels the app's own notification with that tag through
`alsoCloseNotifications`), a sender timestamp inside the
encrypted message (the server still controls `createdAt`), a group-owner lock, a personal default timer, and signed timer changes.
