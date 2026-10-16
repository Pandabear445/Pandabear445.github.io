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
- The inbox (`hearth.inbox.<userId>`) and reminders (`hearth.reminders.<userId>`) also copy messages' words into the
  browser. Signing out (Log out, being signed out, Delete account) removes them for every account, like drafts
  (`clearLocalCopies` in `usability.js`), and each time Hearth opens it drops any entry past its deadline
  (`expireLocalCopies`), whoever it belongs to.

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
    `membership: true`), roles, channels and categories (a channel's disappearing-messages timer too, as
    `channel_update` `changes.disappear`), channel overrides (before and after), invites, emoji,
    webhooks, bots, voice disconnect/move/mute, moderators deleting other people's messages (single, bulk, and
    instance staff removing a reported one, shown as "<instance name> staff"), pins, server settings (which ones
    changed, not the new text) and ownership. Never message text. Handling reports isn't logged there (the
    person reported may be able to read the log); who handled a report and when stays on the report.
  - `GET /servers/:id/audit` pages newest first and filters by kind and person (by id, or `username` for people
    who are no longer members). Names of channels the reader can't see stay hidden; a deleted channel counts as
    private if it was when deleted. Open Audit log tabs update live (`audit:watch`, `audit:new`, at most every
    2 seconds; the tab fetches at most every 3).
  - Append-only (database triggers), kept for a year and up to each server's newest 10,000 entries, never fewer
    than the last 7 days. Beyond 50,000, only moderation stays (kicks, bans, timeouts, roles and nicknames changed
    by others, deleted messages, permissions, roles, ownership, voice, webhooks, bots); beyond 200,000 nothing does
    (`serveraudit.prune`, hourly).
  - Invite creation is now limited (60 per 10 minutes per person), and so are revoking invites (60 per 10 minutes)
    and unbans (with bans, 30 a minute): each one is an entry, and a loop shouldn't bury the log. Making invites,
    and revoking your own, are written at most 10 times an hour per person; the invite dialog reuses a link you
    made in the last 10 minutes with the same settings.
  - Reports about a message in a server channel, or about a member reported from inside a server, also reach the
    server's moderators (Server settings → Reports), without the reporter: category, note, and the reported
    person's own messages from the reporter's chosen evidence (the rest stays with staff). Moderators mark them handled or dismissed (their own `server_status`); staff keep their own status
    and see the moderators' in Admin → Reports. The reporter can opt out; child-safety reports are staff-only.
- **Nicknames** (v19, `server/nicknames.js`): the name someone goes by in one server.
  - Two new permissions: **Change Nickname** (`1 << 20`, your own; in @everyone by default, and given once to
    @everyone of servers from before v19 when the database upgrades) and **Manage Nicknames** (`1 << 21`, other
    people's, only below your highest role and never the owner's; a moderator power, so never on a role that's sold
    or self-picked). Both are server-wide. A timeout takes Change Nickname away (`TALK`) and stops Manage Nicknames
    too; group chats have no nicknames.
  - `PUT /servers/:id/members/:uid/nickname { nickname }` sets one (empty or null removes it) and `DELETE` removes
    it. 32 characters after trimming, the instance's word filter (checked with every invisible character removed),
    control, direction and invisible (default-ignorable) characters dropped except zero-width joiners, variation
    selectors and flag tag sequences, a name with nothing visible left refused, a locked profile refused for your
    own. 20 a minute and 200 an hour per person, and your own set at most 10 times an hour per server (removing it
    always works).
  - Stored in `members.nickname`, so it goes when the person leaves. Every member's copy of the server has
    `nicknames: { userId: nickname }`; changes go live as `member:nick { serverId, userId, nickname }` to the
    server's room. The app shows them in that server only (member list, messages, replies, reactions, @mention
    suggestions, typing, notifications, pins, threads, voice, voice channels' chats, the lines saying who changed
    the disappearing-messages timer) and keeps the display name in DMs and profiles; a profile card opened in the
    server adds a "Nickname in …" line. Push titles for server messages use it too (voice channels' chats included;
    the Android app shows the push title as it comes). A scheduled message is posted as its sender, so readers see
    the nickname they have when it goes out.
  - Importing from Discord brings Change Nickname and Manage Nicknames over to the roles that had them (both
    server-wide, as in Discord); they're no longer listed as lost (docs/IMPORT.md).
  - Audit log: `member_nickname` with `from` and `to`, every change; your own are `self: true` (the 10-an-hour
    limit on them refuses the change instead of leaving it out of the log, so no name goes unrecorded). Instance
    staff resetting a profile clear its nicknames everywhere (`staff: true` entries). Once the person's account is
    deleted, the listing leaves out `from` and `to` (`erased: true`): the append-only rows keep the strings until
    retention removes them, but nobody reads them through the app. A member report made inside a server records
    the nickname they had there for staff (`targetNickname`).
  - Manage Nicknames reaches by role order, so self-assignable roles have to sit below every role with it, as with
    Kick, Ban, Manage Roles, Manage Messages, Mute Members and Move Members (`server/selfroles.js` REACH; Manage
    Messages and Move Members count in a channel override too, for a role or for one member, whose highest role
    then counts). Changing a webhook someone else made also goes by role order, but there roles members pick
    themselves don't count on either side (`perms.topAssigned`), so those can still sit above Manage Channels.
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
| `POST /me/read` `{ conv, messageId, unread?, threads?, pings? }` | session | conversation access checked; message must be in it; `t:<root>` for a thread (a reply in it, forward only); `threads: true` marks a channel's threads too; `messageId: '0'` marks an empty voice chat opened; `pings: true` reads the pings of a voice chat you don't follow without following it; 240/min |
| `POST /servers/:id/read` | member | channels you can see, their threads too; voice chats you follow, and the pings of ones you don't |
| `GET /channels/:id/threads` `?before=&limit=` | can view channel | text channels; latest reply first; 25 (max 50) a page; 60/min |
| `GET /me/notify` | session | your own only |
| `PUT /me/notify/:target` `{ level, muteUntil, suppressEveryone }` | member of that place | 120/min; up to 2000 rows |
| `PUT /me/notify-settings` `{ dnd, tz, previews }` | session | 120/min |
| `GET /channels/:id/pins/log` | can view channel | newest 50 |
| `GET /servers/:id/timeouts` | Kick Members | |
| `POST/DELETE /servers/:id/members/:uid/timeout` | Kick Members + role order | audit-logged; 30/min |
| `POST /servers/:id/voice/:uid/disconnect`, `/move` | Move Members (per channel) + role order | audit-logged; 60/min |
| `POST/DELETE /servers/:id/voice/:uid/mute` | Mute Members (server-wide) + role order | audit-logged; 60/min |
| `PUT/DELETE /servers/:id/members/:uid/nickname` | your own: Change Nickname or Manage Nicknames; others: Manage Nicknames + role order | audit-logged; 20/min, 200/hour; setting your own 10/hour per server |
| `POST /channels/:id/messages/bulk-delete` | Manage Messages in the channel (text or voice) | 100 messages, 14 days; audit-logged; 10/min |
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
| `read_states` | user, conversation key (`c:`, `d:`, `t:<thread root>`, `ct:<channel>` for "its threads read up to", `cp:<voice channel>` for "its pings read up to" in a voice chat you don't follow), last-read message id | no |
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
  404, a group's call 400 `bad_channel` (a server's voice channel has one for its chat). Limits: 10 changes a minute per person, and 10 an hour per person in each
  conversation (not one budget for the whole conversation, which one person could use up to lock the timer for
  everyone else). The same value again changes nothing (no log line, no event). `GET` on the same paths gives `{ seconds, log }` (the last 20
  changes). Live: `disappear:update { conv, channelId | dmId, id, seconds, prev, by, at }` to whoever can see the
  conversation (`toChannel`, or both DM users). In a server channel (a voice channel's chat too) a change is also a
  `channel_update` entry in the server's audit log, `changes: { disappear: { from, to } }`, like the channel's other
  settings ("Ana changed #general: set disappearing messages to 1 day"); group chats and DMs have no audit log, and
  messages disappearing by themselves aren't logged.
- **Shown.** `disappear_log` keeps who changed what and when (50 per conversation); history pages carry the changes
  that fall inside them (`timerEvents`) and the apps draw them between the messages, each under its own day's
  divider. A line says "You" only when the change's user id is the viewer's own (`sysLineParts` in `disappear.js`);
  anyone else's name is drawn in its own element, followed by the person's @username unless the name is simply that
  username (usernames are plain letters, digits, `_` and `.`), so nobody can make their change look like the
  viewer's, whatever look-alike letters their name uses. A name that reads as "You" (any case, spacing, accents,
  invisible characters, Hangul fillers included, or look-alike letters, capitals matched before lower-casing, or as
  its first word: `readsAsYou`) always gets it, and shows as "Someone" when the @username isn't known. Pages meet
  without gaps: a `?before=` page ends at its anchor's id time, an `?after=` page starts at its anchor's
  `created_at`. Channels carry `disappear` in `serializeChannel`, DMs in `serializeDm`. The app adds a timer button
  to the header, a note above the composer, a line in the welcome block, a badge on each disappearing message, and
  the choices in the DM, group and channel ⋯ menus and in Edit channel. Turning it on asks first and says what it
  can't do.
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
  its words (`exp` on each: a reminder that fires passes its `exp` on to the inbox entry it makes, its notification
  is tagged with the message so it closes too, and its bar on screen goes), removes it from open search results, and
  redraws pins and saved. Those copies go at their `exp` even when the app wasn't running then: the signed-in app
  purges its own at start-up, and every time Hearth opens (signed in or not) `expireLocalCopies` drops any account's
  copies past their deadline. Signing out (and deleting the account) removes every inbox and reminder list from the
  browser. Unread and mention
  counts are asked for again (`/me/unread`, debounced to at most every 30 seconds) when a conversation with unread
  messages lost some. A message that arrives live is in the expiry timer as soon as it's in the conversation.

Not built in this pass (the design's later phases): leaving disappearing messages out of backups
(`BACKUP_DISAPPEARING`, `scrubDisappearing`; backups keep them until they rotate out), the export checkbox (the zip
includes messages that haven't disappeared yet), the Android notification timeout (`setTimeoutAfter`; until then a
notification shown while the app was open, or posted from a push while it was closed, stays after it's closed, as the
README says; while the app runs, `closeNotificationFor` also cancels the app's own notification with that tag through
`alsoCloseNotifications`), a sender timestamp inside the
encrypted message (the server still controls `createdAt`), a group-owner lock, a personal default timer, and signed timer changes.

## Channel and category order

Dragging channels and categories in a server's sidebar, for people with Manage Channels (v19, no schema change:
`channels.position`, `channels.category` and `servers.category_order` already held the order). The drag code is
the server bar's (`public/js/folders.js` `dragDrop`), shared with the channel list in `app.js`.

**How it works**

1. Each category and its channels are one `.cat-group` in the sidebar. A channel is dragged by its name and lands
   before or after another channel, or on a category's name (first in that category); a category is dragged by
   its name and lands before or after another category. The app shows the new order at once and puts it back if
   the server refuses.
2. **Move up** / **Move down** in a channel's or category's menu do the same from the keyboard. At the top or
   bottom of a category, a channel's item moves it into the category above (last) or below (first). Where it goes
   is worked out again when the item is chosen, from the list as it is then, so a menu left open while someone
   else reorders never sends the old order back. A move into a collapsed category opens it, so the channel stays
   drawn and keeps the focus (`openCategory`, `refocus` in `app.js`).
3. Channels: `POST /api/servers/:id/channel-order { ids, categories?, from? }`. `ids` is every channel the person can
   see, top to bottom; `categories` maps the ones changing category to their new one (it must be a category they
   can see); `from` is the layout the app showed (`[[category, [channel ids]], …]`). Categories:
   `PATCH /api/servers/:id { categoryOrder, categoryOrderFrom? }`. If `from` / `categoryOrderFrom` isn't the
   current layout as the person sees it, the move is refused with the same 400 as a list that isn't theirs ("The
   channel list changed in the meantime"), so one person's full list can't silently undo another's move. Both need
   Manage Channels (in group chats too, so only the owner), and share a limit of 30 a minute per person with
   renaming a category. `PATCH` with `categoryOrder` and other fields needs Manage Channels as well as Manage
   Server, and is checked before anything is saved.
4. `server/channelorder.js` decides what a full list may change. Channels the person can't see stay in their
   category, right after the channel they followed before (the nearest one before them that the person sees and
   that's still there), or first; categories they see no channel of keep their slot in `category_order`. A list
   that isn't exactly the channels they see (a hidden channel's id, a made-up one, one left out) gets the same
   400, and so does moving into a category they can't see or that doesn't exist. Channels where Manage Channels is
   denied to them (a channel override) can't change category and keep their order among themselves; categories
   holding such a channel keep theirs. Everything else goes where it was put.
5. Open apps get `server:update` (only when something changed). Each member's `categoryOrder` now lists only
   categories they have a channel in, so a category of private channels doesn't give its name away, and each
   channel's `position` is its place among the channels that member sees (0, 1, 2…), so gaps don't tell how many
   private channels there are or where they sit.
6. Renaming a category (`POST /api/servers/:id/categories/rename { from, to }`, its menu → Rename category) relabels
   every channel in it, so it goes by the same rules (`planRename`): Manage Channels in every channel of it the
   person sees (the menu item isn't offered otherwise), and a category they see no channel of gets the same 400 as
   a made-up name. Renaming onto another category's name merges the two, which moves the channels, so that also
   needs seeing every channel in it (a hidden one keeps its category); the merged category takes the other one's
   place. A plain rename takes hidden channels along, since they stay in the same (renamed) category. Merging into
   a category the person sees no channel of is refused (400, "You can't add channels to that category…"), and so
   is Create channel's or Edit channel's category field naming one (`hiddenCategory`, `claimCategory` in
   `index.js`): nothing goes into, merges into or renames a category of private channels from someone who can't see
   them, and its place never shows in their sidebar. Create channel with no category uses Text or Voice as ever,
   unless that's such a category: then the first of the person's categories with a channel of that type (or their
   first), and the app's dialog starts with one of their categories for the same reason. The refusal does tell
   them that a category by that name exists (a new name would be accepted): categories are names shared by the
   whole server, so a Manage Channels holder can still confirm a guessed name, but not its place or its channels.
   A new name (no channels) starts outside the stored `category_order`, so one left there by a deleted category
   doesn't bring back that category's place.
7. The server's audit log gets a `channel_update` (`changes.category { from, to }`) for each channel that changed
   category, and one `channel_reorder { count }` for the channels that changed place inside their category
   (counted as everything outside the longest run that kept its order, so dragging one channel is one move),
   naming the channel (`channel`, target and channel id) when only one moved. `category_reorder` has no detail.

**Tests**

- `test/channel-order.test.js` (10 tests): reorder and move into another category with live updates and audit
  entries; nothing changed means no update and no entry; emptying a category, and older channels without a
  category; refusals (members, outsiders, Manage Server alone, group members); channels and categories with
  Manage Channels denied; hidden channels and categories keep their place and are refused like made-up ids, and
  their names never reach the moderator; a list built on an older layout (`from`, `categoryOrderFrom`) is refused
  and the other move stands; positions without gaps; renaming a category (denied channels, hidden categories and
  channels, merges, the shared limit); validation and the rate limit; the rules on their own.
- Browser flow (`npm run test:e2e`, "channel order"): bob drags a channel onto the Voice category's name and the
  Voice category above Text, alice sees both live and has nothing to drag or move; then Move down by keyboard,
  within Voice and on into Text while Text is collapsed (it opens), with the focus staying on the channel; then a
  menu left open while another of bob's devices reorders Text moves the channel from the new order, keeping that
  other move.

**Known limitations**

- Categories are labels on channels, not channels with permissions of their own, so "Manage Channels in a
  category" means in every channel of it the person can see, and it only covers moving or renaming the category
  itself: categories holding a channel the person can't manage keep their order among themselves, but a single
  such category can end up anywhere when the others move around it, and channels the person manages can go into
  it (as Edit channel's category field already allows).
- Dragging needs a mouse or pen (HTML drag and drop); on touch screens, use Move up / Move down.
- Other channels can be moved around one the person can't manage (that's how lists work), so it can still end up
  above or below different neighbours; what can't happen is moving it itself or swapping two such channels.

## Away and custom statuses that clear themselves

Automatic Away after a while without input, and an expiry for custom statuses. v19 adds `users.away_after`
(minutes, 0 = never, default 10) and `users.status_expires_at` with the partial index `idx_users_status_expires`.

**How it works**

1. Each open app (one socket) says whether it has gone unused for the account's "Away after" time:
   `presence:idle { idle }` (`public/js/presence.js` `initAway`, checked every 15 seconds, and "in use" again on
   the first key, click, scroll, touch or pointer move, or when the page comes back into view). The desktop app
   uses the computer's idle time instead (`hearthDesktop.idleSeconds()` → `powerMonitor.getSystemIdleTime()`,
   answered only to the main window showing the server), so a game in front of Hearth doesn't count as away.
   The Android app counts like a browser: input in Hearth itself. Going to the background reports nothing by
   itself, so Away still comes only after the person's time (a backgrounded web view may check only once a
   minute); the app's own messages to the page (`hearth-push`, `hearth-hangup`, `hearth-open`, `hearth-invite`, a
   notification click) are never input; opening Hearth again, from the launcher or a notification, is use the
   moment the page is visible. A call that carries on with the screen off (the app's call notification,
   `androidApp.callState`) counts as use like any call.
   Being in a call counts as use (`busy()`), and so does input in the Study page: the Recall frame is a sandbox of
   its own whose input never reaches the page, so it posts `{ t: 'active' }` (at most every 30 seconds, nothing
   else) and `recall-host.js` calls the tracker's `used()`. While the status isn't Online the app reports nothing.
2. The server combines them (`presenceFor` in `server/index.js`): someone whose status is Online shows as `idle`
   only while every socket of theirs has said idle; a new socket starts in use, and one that never reports (an
   older app) counts as in use. Do Not Disturb, Away picked by hand and Invisible never change, and "never"
   (`awayAfter: 0`) ignores the reports. Changes go out through the existing `broadcastPresence` (a presence
   entry to every socket, batched each second) and `user:update` to the person's own apps, which carries
   `autoAway` so their own dot and status menu can say why. Connecting, disconnecting, idle reports and
   `PATCH /me/status` all compare `presenceFor` before and after and send a presence entry only when it changed,
   so an Invisible or Do Not Disturb account opening and closing windows (or changing "Away after") tells nobody
   anything. In the app, a `user:update` about yourself that changes only `presence` and `autoAway` patches your
   dots and the line under your name in place (`onlyPresenceChanged` in `presence.js`), so a call in full screen,
   a button being pressed and keyboard focus are left alone. It doesn't count what differs without anything
   changing: the server-folder layout (the app's own, tidied in place by `folders.js`), a missing `keysReset`
   against `null`, and the re-signed album-art link (`activity.music.artSrc`). Other people's presence redraws
   only the rows of the friends and member lists (their search boxes keep what's typed) and Home's online friends
   (`redrawPeople`).
3. `PUT /me/custom-status` takes `expiresIn` in ms. The app works out "today" and "this week" in the person's time
   zone (`clearAfterMs`; the week starts where the browser's language says) and sends only the length, so the
   server needs no time zone and a wrong device clock doesn't matter. The `status.expire` job (every 15 s,
   `STATUS_SWEEP_MS`) clears due statuses and sends `user:update`; until it runs, `publicUser` already leaves an
   expired status out. Only the person's own apps get `customStatusExpiresAt`.
4. `PATCH /me/profile` (the profile editor sends the whole profile) keeps the expiry when the status is unchanged
   and drops it when the status changes; the editor sends the status only when it was edited there, so one that
   cleared itself since the page opened isn't put back.

**API**

| Route / event | Auth | Notes |
|---|---|---|
| `PATCH /me/status` `{ status?, awayAfter? }` | session | `online`, `idle`, `dnd`, `invisible`; `awayAfter` one of 0, 5, 10, 15, 30; answers `{ ok, status, awayAfter }` |
| `PUT /me/custom-status` `{ emoji, text, expiresIn? }` | session | one line (control characters become spaces), text ≤ 128, emoji ≤ 16 UTF-16 units; `expiresIn` an integer from 60,000 to 8 days, or null; word filter; a locked profile can clear but not set; answers the person's own user |
| socket `presence:idle { idle }` | socket | only `idle: true` counts as idle; repeats change nothing |

Limits: status changes (both routes, and a changed status through `PATCH /me/profile`) 15 a minute and 120 an hour
per account, 120 a minute per network; idle changes 20 a minute per account (an app sends at most two per period).
A refused idle report changes nothing, and the app tries again on its next check.

**Tests**

- `test/presence.test.js` (14 tests): defaults and the "Away after" choices; Away only once every socket is idle,
  back on one, Away when the socket in use closes, Online when a new one opens, Offline when all close; never over
  Do Not Disturb, Invisible or a hand-picked Away, and "never" ignores reports; an Invisible or Do Not Disturb
  account's windows opening and closing (and its "Away after" changing) send nobody a presence entry, an Invisible
  one's first and last window included; the idle and status limits (custom
  statuses included, also through the profile editor); custom status validation, the expiry, the editor keeping or
  dropping it, the sweep clearing it live for others and the person's own apps; the word filter and a locked profile;
  an expired status never sent before the sweep, and cleared after a restart; the app's `clearAfterMs`,
  `clearsLabel` and `weekStart`; `initAway` with page input, visibility, "never", a refused report, reconnects, the
  desktop idle time, an older desktop app, a call counting as use and `used()`; the Android app going to the
  background saying nothing by itself, its own events never counting as input, and coming back or a call counting; the Study frame's throttled
  "active" message reaching the tracker; the desktop bridge only answering the main window.
- Browser flow (`npm run test:e2e`, "away and status"): a new member sets "Away after" to 5 minutes; with her page's
  clock moved on, another member sees her dot turn to Away and her own panel says "Away (inactive)" without its
  buttons being rebuilt, and a mouse move brings her back; a status set to clear after 30 minutes shows for others,
  reopening the dialog offers to keep its time, and when it's due both apps drop it without a reload; Settings →
  Profile saves a status, then clears it in the same tab.

**Known limitations**

- Away isn't end-to-end encrypted, like Online, and presence goes to every account signed in on the instance
  (`io.emit`), people who share no server with you and people you've blocked included. Because apps report as it
  happens, everyone learns roughly when you stop using Hearth (within about 15 seconds plus your Away time) and the
  second you're back; in the desktop app, that's any input on your computer. "Never", Invisible or Do Not Disturb
  turns that off. (Proposed for SECURITY.md's honest limits.)
- In a browser, only input in a Hearth tab counts: someone working in another tab or app shows as Away after their
  time. The desktop app counts the whole computer.
- A tab in the background may check only once a minute (browsers slow timers there), so Away can come a minute late.
- An older app that never reports keeps the person Online while it's open.
- Open apps drop a status up to 15 seconds after its time (when the sweep runs); anything the server sends from the
  moment it's due already leaves it out.
- "Keep" in the dialog works out the remaining time on the device, so a device clock that's off shifts it by that much.

## Voice channel chats

Every voice channel in a server has a text chat beside its call (like Discord's text in voice). It is that channel's
ordinary messages: no new table, no new route and no schema change. `POST /channels/:id/messages` now takes a
server's voice channels (`hasChat` in `server/index.js`); the app opens the chat in the call view's side panel.

**What it shares with text channels**

- **Encryption:** the same server key and epoch (`requireCurrentEpoch`), the same ciphertext-only storage and the
  same `secure.js` path (the channel id is bound into every message, as for text channels). The server never sees
  the text. Since the key is the server's, someone held back after a password reset without their recovery key
  (`crypto-2`) has no key for the chat either until a member verifies them, and the bar above its box says so.
- **Pictures from other sites:** an image link in the chat waits for a click like anywhere else (`xss-8`, Settings →
  Privacy & safety → Outside images), since the chat's messages are drawn by the same code (`fillMessage`).
- **Permissions:** View Channel to read it, Send Messages to write; Attach Files, Add Reactions, Mention @everyone,
  Show link previews and Manage Messages as in text channels, all per channel. **Connect isn't needed**: someone who
  may see a voice channel but not join its call can still chat, and can read what's said there. Timeouts take it
  away like any other channel's. Slow mode applies (the Overview tab shows it for voice channels now). The
  permission editor lists these for voice channels (Send Messages says who can read the chat), and the channel's
  menu has **Make the chat read-only** (Send Messages denied for @everyone).
- **The rest:** replies, edits, reactions, pins (Manage Messages, with pin history), polls, voice messages, files,
  link previews, typing, saved messages, reminders, message links, reports, the message rate limits, `GET
  /messages/:id/locate`, and deleting the channel (its messages go with it).
- **Disappearing messages:** the voice channel's timer is its chat's, set and shown as in a text channel
  (`PUT /channels/:id/disappearing` takes a server's voice channel, `serializeChannel` carries `disappear` for it,
  Manage Channels there sets it, the ⋯ menu, Edit channel, the header's timer button and the note above the box
  offer it). Messages are stamped, checked against the `ttl` the app encrypted for and never served after their
  time, exactly as in text channels. A group's call has no chat and no timer (400 `bad_channel`).
- **Moderation:** bulk delete (`POST /channels/:id/messages/bulk-delete` used to refuse voice channels), Delete
  recent messages and select-to-delete in the app, a ban's message cleanup (it already went through every channel),
  and the server audit log.
- **Search:** `scope=s:<server>` and `scope=all` now look in voice channels too (`server/search.js`); `in:` finds a
  voice channel by name when no text channel has that name. **Export my data** lists voice channels with
  `type: 'voice'` and exports their messages.

**What it doesn't have**

- **Threads:** `threadId` is refused (400), `GET /channels/:id/threads` already was, and the app offers no thread
  buttons there. A voice chat stays one conversation next to the call.
- **Bots, webhooks and slash commands:** bots still post only in text channels (`bad_channel`), webhooks can't be
  made there, and the composer doesn't offer commands. Bots with the message metadata scope still see that messages
  were sent there, as for any channel they may read.
- **Group calls:** a group's `call` channel has no chat (400 "A group call has no chat of its own"); the group's
  own conversation, shown with the call above it, is its chat.

**Unread, mentions and notifications (the decision)**

A voice chat counts as unread only for people who **follow** it: who opened it or wrote there once, on any device,
who picked *All messages* for it, or who are in its call right now. Pings always count. The reasoning: most members
never look at most voice channels' chats, and a server where every call's side chatter lit up the channel list would
teach people to ignore it. The server (`followsVoiceChat` in `server/index.js`, for pushes) and the app
(`followsVoiceChat` in `app.js`, for dots and sounds) use this one rule.

- "Following" is a read marker (`read_states`, `c:<voice channel>`). Opening the chat reads it up to the newest
  message; an empty chat is marked opened with the marker `'0'` (`POST /me/read { conv, messageId: '0' }`, allowed
  for voice chats only and forward only, so it never moves an existing marker back). Sending there leaves one too.
- **Picking *All messages*** for a voice chat (`PUT /me/notify/c:<id> { level: 'all' }`) leaves one as well: at the
  newest message, or just before the first ping you haven't read so it still counts, or `'0'` in an empty chat.
  Every device hears it (`read:update`), so its dot and sound start at once. Picking another level later doesn't
  take it away (like a chat you opened). Text channels and a group's call get no marker from it.
- **Mark as read** (the voice channel's menu, when it pinged you) and **Mark server as read** on a chat you don't
  follow read only its pings, with a `cp:<channel>` marker ("pings read up to"): they don't make you follow it.
  The app sends `POST /me/read { pings: true }` for that; on a chat you follow, or one on screen, it's an ordinary
  read.
- `GET /me/unread` gives voice chats `opened: true | false`. Not followed: `lastReadId: null`, `unread: 0`, and
  `mentions` counted from the person's baseline or their `cp:` marker, whichever is later. Followed: counted from
  the marker like a text channel.
- In the app, a new message in a voice chat you don't follow adds no unread dot and makes no sound; while you're
  in its call it does (the server doesn't keep that part: after a reload in a call, only what arrives next counts).
  Opening the chat then puts "New messages" just after the last message the app knew of before it turned unread,
  not above everything ever said there.
- **Mentions** (@you, a reply to you, a role you have, an allowed @everyone/@here) count, show in the inbox and push
  whether or not you follow the chat.
- **"All messages"** pushes for a voice chat reach only followers: people in its call, people with a marker there,
  and people who picked *All messages* on that voice channel itself. A server set to *All messages* doesn't push
  every line said next to every call.
- The channel's menu has **Chat notifications** (the same levels, mute and @everyone settings as a text channel).
- Moderators don't follow every voice chat because of Manage Messages: members report what they see, and the
  upgrade below keeps the limits a server already had.

**In the app**

- The call view's header has a **chat button** (Show chat / Hide chat). While the chat is hidden it carries your
  ping count, or a dot for new messages that count for you. Open or closed is remembered on this device.
- Right-click a voice channel → **Open chat** opens the call view with the chat, without joining the call.
  Notifications, message links, search results, pins and saved messages open voice chats the same way. Pinned
  messages (More → Pinned messages) show in the chat's place; their **Jump** (and Pin history's) goes back to the
  chat at that message.
- The chat button's label says what it does (Show chat / Hide chat), so it has no pressed state as well.
- The chat is the same conversation view as a text channel (`chatView`) in the side panel (`#members`, mode
  `chat`, the thread panel's width). It isn't rebuilt when the panel redraws for other reasons (people joining,
  server updates), so typing and scroll position survive. Pinned messages open in its place.
- Placeholders and labels name it "🔊 Lounge" instead of "#lounge".

**Tests**

- `test/voice-chat.test.js` (9 tests): sending, reading, editing, reacting, replying and typing in a voice chat,
  ciphertext only; Connect not needed; refusals (hidden channel, no Send Messages, no Attach Files, timeout, group
  call, threads, bad and stale payloads, slow mode, webhooks, bots); a disappearing timer on a voice chat (set by
  Manage Channels only, `ttl` checked, stamped, an expired message never served, none for a group's call); the
  message rate limits; unread (`opened`,
  pings, the `'0'` marker, sending opens it, Mark server read and `pings: true` read pings without following);
  *All messages* follows a chat (the marker before an unread ping, at the newest, `'0'`; not for text channels or
  group calls); push (server-wide *All messages* only for followers, pings always, channel-level *All messages*);
  pins, search, bulk delete, a ban's cleanup, Export my data and deleting the channel; the upgrade (Connect denied,
  a muted role, a read-only server with slow mode, an open server untouched, the audit log, once only).
- Browser flow (`npm run test:e2e`, "voice chat"): open the chat from the voice channel's menu without joining,
  both ways decrypted, no thread button, a never-opened chat shows only a ping, the header button hides and shows
  it, once opened a new message makes it unread; Jump from Pinned messages; *All messages* on a never-opened chat
  gives a dot and the sound; in a call whose chat was never opened, "New messages" sits above what was said since
  joining.

**Known limitations**

- Being "in the call" only counts on the device in the call, live: the server doesn't remember it for unread counts.
- Voice channels that existed before this get a chat too. On the first start of this version (once: the
  `voiceChatLimits` mark in `instance_settings`, set in the same transaction as the rest of the upgrade) the limits
  a server had on posting are carried over to them (`server/db.js`): an override denying Connect on a voice channel
  also denies Send Messages there; a role, member or @everyone denied Send Messages in every text channel it isn't
  hidden from is denied it on the voice channels too; and when every text channel has slow mode, the voice
  channels get the shortest. Only denies are added (an explicit allow is left alone), and each change is a
  `channel_overrides` or `channel_update` entry in the server's audit log, by Hearth, marked `voiceChat`. So a
  staff-only call room keeps a closed chat (staff included) until an admin allows Send Messages for the people who
  may use it. Limits set only server-wide (a role without Connect at all) aren't carried over, and everyone who can
  see a voice channel can read its chat. Deny Send Messages (or use Make the chat read-only) on channels that
  should stay voice-only.
- The chat's history isn't tied to calls: it stays after everyone leaves, like a text channel's.

## Scheduled messages (Send later)

The sender's app encrypts a message exactly as it would to send it now; the server holds that ciphertext until
the chosen time and then posts it as if it were sent then. Server channels (voice channels' chats too), threads,
group chats and DMs. Code:
`server/scheduled.js` (rules, routes, the timer), `public/js/scheduled.js` (picker, list, re-encrypting), the
composer in `public/js/app.js` (`sendLater`, `sealFor`, `sendTo`). Schema: the `scheduled_messages` table (v19).

**How it works**

1. **Send later** (the clock next to the send button, or a right-click / long press on it) offers *In 1 hour*,
   *In 3 hours*, *This evening* (19:00, when that's over 90 minutes away), *Tomorrow morning* (9:00), *Monday
   morning* and *Pick a date and time…* (a `datetime-local` field in the device's time zone, at most 30 days
   ahead). The words in the box, its files and a ready link preview go, as for Send; polls, voice messages, GIFs
   and bot commands can't be scheduled.
2. The app builds the payload and encrypts it with `sealFor`, the same function sending uses: for a channel the
   current server key epoch, the ECDSA signature, the `@mention` ids and `everyone` (always `true` or `false`); for
   a DM the `d2:` format. Files are uploaded encrypted at once. With it goes the sender's **own copy** (`draft`):
   the same payload (the version that fitted the size limit) sealed with their personal vault key
   (`E2EE.sealVault(vaultKey, 'scheduled', '<ref>|<c:channel or d:dm>|<thread>')`, the key saved-message notes and
   Recall use, which only the account's identity key derives), bound to `ref` (16 random bytes the app picks), the
   conversation and the thread. It posts `{ ciphertext, epoch, ref, draft, sendAt, replyTo, threadId, files,
   mentions, everyone }` to `POST /channels/:id/scheduled-messages` (or `{ ciphertext, ref, draft, sendAt, replyTo,
   files }` to `POST /dms/:id/scheduled-messages`). Inside the payload, `sendOnce` puts where it belongs (`binding.js`,
   ARCHITECTURE.md §4): a new id `u`, `r` and `th`, and `ts` = its due time with `sch: 1`. Readers' apps flag one
   posted more than 10 minutes before that or more than a day after (the server's own limit for posting late), so
   every change of when it goes that the sender makes re-encrypts it (Reschedule: `ts` = the new time; Send now:
   `ts` = now). Every other re-encrypt (an edit, Keep, one done by itself after a key change) keeps the `ts` of the
   sender's own copy, never the server's `sendAt`, and its `u`, `r` and `th` stay those of that copy (a copy from
   before these fields gets none: nothing of the server's is signed in). A held one is re-encrypted by itself only
   while its copy's time is ahead or less than 10 minutes past and the server's `sendAt` isn't earlier than it (the
   server only ever moves one later: slow mode, a retry); otherwise it waits for the sender, and the list says when
   the server has an earlier time than the one they picked. Because of `sch`, every recipient's app can tell the
   message was scheduled, and when it was due.
3. Scheduling is checked like sending: you can see and post in the channel (Send Messages, Attach Files for
   files, Create Threads for a thread), aren't timed out, and the key epoch is current (409 `stale-key`
   otherwise, which the app's usual retry handles); in a DM, no block either way and the other account exists.
   The time must be a whole number of milliseconds in the future and at most 30 days ahead (`send_at`). Up to 25
   pending or held per person (`too_many`; failed ones don't count). Scheduling counts against the message rate
   limits (`limitMessages`) plus 30 a minute of its own.
4. One timer, armed for the soonest due message (and at least once a minute; `scheduled.watch` restarts it if a
   run ever failed before re-arming), takes due messages 50 at a time. Each is checked again exactly as a message
   sent then would be (`prepare`): account suspended; channel, server or DM gone, not a member, or can't see the
   channel (`no_access`); timed out; no permission to post, attach or reply in threads (`no_permission`); the
   thread deleted (`thread_gone`); a block (`blocked`); the other account deleted (`deleted`); keys (below). A
   refusal marks it **failed** with that reason, sends `scheduled:update` to the sender's open apps and a push to
   devices without one ("A scheduled message wasn't sent", tag `sched:<id>`, opening `/#scheduled`). Slow mode
   doesn't refuse it: the time moves to when slow mode allows. A message due more than a day ago that wasn't
   re-encrypted since (the server was down or in maintenance for that long, or brought back from an old backup)
   fails as `too_late` instead of being posted that late. Nothing is sent during maintenance.
5. Otherwise it's posted by `postChannelMessage` / `postDmMessage` (with `{ scheduled: true }`), the code
   `POST /channels/:id/messages` and `POST /dms/:id/messages` use: a new message id, `created_at` = the moment it
   goes out, `message:new` / `dm:message`, pushes, `mention_marks`, bot `message.created` events, thread activity.
   One difference: the author may well be away, so their read marker (and thread marker) isn't moved, and the copy
   their own apps get carries `scheduled: true`, so they don't clear the conversation's unread count, pings or
   notifications either; pings and messages that came meanwhile stay unread. Nobody else's copy (or the history)
   says it was scheduled. In the same transaction the scheduled row is deleted and its files (blobs whose
   `message_id` was the row's id) become the message's, so it can't be posted twice or lose its files. The sender's
   apps get `scheduled:remove` with the new message id.

**Disappearing messages and voice chats.** A scheduled message is encrypted like one sent now, so `sealFor` puts the
conversation's timer as it is then inside it (`x`) and sends it beside it (`ttl`): scheduling (and every re-encrypt,
`PATCH` with new ciphertext) is refused with 409 `disappear_changed` when the timer just changed, and the app fetches
it and encrypts again, once (`refreshTimer`). The row keeps `ttl`. When it's posted, `postChannelMessage` /
`postDmMessage` stamp its deadline from that moment (`created_at` is the send time), by the conversation's timer
then, never later than `ttl` (`sendSecs` in `index.js`): turned on or shortened since, the conversation's timer
wins; turned off or made longer, it still goes when its sender expected, so the server deletes it when readers' apps
(which take the earlier of `expiresAt` and `createdAt + x`) hide it anyway. Re-encrypting it (an edit, Keep, Send now,
or the app by itself after a key change) keeps that: `open()` keeps the `x` of the sender's own copy, `sealFor` puts
the stricter of it and the conversation's timer now inside the new ciphertext (`stricter` in `disappear.js`), and
`PATCH` stores the stricter of the row's `ttl` and the new one (`keepTtl`), whatever the app sends. So a timer turned
off or made longer before a re-encrypt never makes the message last longer, and nothing needs asking (unlike sending a
message written under an older timer, `stillSend`). Its files get the same deadline when
they're handed over. A reply or thread that has disappeared by its time counts as gone (`replyIn`, `threadRootIn`
check `alive`). The list shows "Disappears after …" on each one encrypted for a timer. A voice channel's chat takes
scheduled messages like a text channel (`hasChat`; a group's call has no chat, 400), but threads stay in text
channels (400 "Threads are only in text channels.").

**Only what the sender scheduled is ever re-encrypted.** Re-encrypting a message re-signs it with the sender's key
under the current server key, so the app does it only from the sender's own copy (`draft`), never from the
ciphertext the server hands back. Without that, the server, or anyone with a stolen session token (who has no
identity key), could slip a forged message (or one of the sender's ordinary old messages, from a key epoch newer
members never had) into the sender's list as "held" and have their open app re-sign it under their name, or re-lock
old words for people who joined since. A copy only opens with the account's own keys and for its ref, conversation
and thread, so it can't be made, moved or swapped by anyone else. The list shows what a scheduled message says from
that copy too. One whose copy is missing or doesn't open shows as "This device can't confirm you wrote this one",
is never re-encrypted, and offers only **Cancel**.

**A copy put back isn't re-encrypted by itself.** A stolen session can read the sender's copies from the list and,
after the sender sent or cancelled the message, put one back as a new scheduled message (the server only checks a
copy's shape), then get the key changed so it's held. So each copy names the scheduled message it belongs to (`sid`
inside it): the composer seals it again with the id as soon as the server answers and hands it back with the very same
ciphertext (`bindScheduled` in `app.js`), and every re-encrypt keeps it. The app re-encrypts a held one by itself
only if its copy names it, or if this device scheduled it (its ids are kept in `hearth.schedHere.<userId>`, for when
that second step didn't go through; dropped as they're sent or cancelled, and at sign-out). A copy that names another
scheduled message shows as can't-confirm (Cancel only). One that names none waits for the person ("Waiting for you",
with **Keep** first), and confirming it binds it. Not covered: a copy names its scheduled message, not which version
of it, so a stolen session can put an earlier copy of the same scheduled message back (its words before an edit),
and that one is re-encrypted by itself after a key change.

**Sessions.** Each scheduled message records the session that last wrote it (`session_id`: the one that scheduled,
edited or re-encrypted it). When that session ends through the server (`revokeSessions`: logged out, signed out in
Settings → Signed-in devices or by *Log out all other devices*, a password change or reset, turning on two-factor, a
suspension or staff), what it scheduled is **held** (`session_ended`), so signing out a stolen session stops what it
queued. It goes out only once the person confirms it from a session still signed in: **Keep**, **Send now**,
**Edit** or **Reschedule** in the list re-encrypt it from their own copy (which ties it to the new session). The app
never does that by itself, a key change doesn't turn it into an ordinary key hold, and `POST …/send` and a
reschedule alone answer 409 `held`. At its time the person is told it's waiting, as for any held one. A session
that simply expires doesn't count. A new sign-in token for the session itself (`rotateToken`: the device that changes
the password, turns on two-factor or uses *Log out all other devices* with the password keeps its session id) isn't a
sign-out, but it's what shuts out a copy of the old token, and the server can't tell what the device scheduled from
what a copy did. So what the session had pending is held too (`token_renewed`, `tokenRenewed`), and the person's app
re-encrypts it by itself, as after a key change (`fixHeld`), from their own copy: what the device wrote goes out as
planned, and what a copy of the token queued (its copy can't open without the identity key) stays held and can only
be cancelled. The news that it's held can reach the app just before it has the new token; a re-encrypt turned away
then (401) is tried again when it reconnects.

**Key changes, decided honestly.** A channel message is locked with one epoch of the server key, and members who
joined after a rotation never receive older keys; posting old ciphertext would make a message they can't open,
and one a removed member could. A DM is locked with both people's identity keys. So the server never posts
ciphertext written with keys that changed since:

- **The server's key changed or needs replacing** (someone left or was removed; `needs_rotation`): the message is
  **held** (`key`). That happens as soon as the key state changes (`emitKeyState` → `recheckServer`, for senders
  still in the server), when the list is fetched, and at the latest at its time. The sender's app re-encrypts it
  with the current key (`PATCH` with new ciphertext, making the new key itself if needed, as sending would) and
  it's **pending** again with the same time. The app does that **by itself** when its time is ahead or passed
  under 10 minutes ago, as soon as it's open and has the key (at start-up, on `scheduled:update`, on new keys).
  Later than that it waits for the person: **Send now** or **Reschedule** re-encrypt first, and saving an **Edit**
  (or **Keep**) asks "Send it now, or pick a new time?". A message re-encrypted after its time goes out at once, so
  the server insists on being told: new ciphertext for a held message whose time has passed needs `sendNow: true`
  or a new `sendAt`, else 409 `overdue` (the automatic path sends `sendNow`, since it only runs within 10 minutes).
- **The other person's identity key changed** (a password reset without the recovery key): held (`peer_key`),
  found at listing and at send time. The app can only re-encrypt once the sender has checked the new safety
  number, since it never encrypts to an unchecked key; marking it verified retries.
- **The sender's own keys changed** (the identity key, or for channels the signing key): **failed**
  (`keys_changed`). The old private key is gone, so the ciphertext can't be opened to re-encrypt, and its
  signature would no longer check out.
- `own_key` / `peer_key` are SHA-256 fingerprints of the public keys (`users.public_key`, `sign_public_key`) at
  the time the ciphertext was written; `epoch` is the server key epoch the app said it used (as for sending, the
  server can't check that against the ciphertext, and a wrong one only hurts the sender).
- A held message whose time comes is checked again then: one that can't go anyway (removed, timed out…) fails,
  else the sender is told once (`told_at`) that it's waiting. Held messages nobody re-encrypts go 30 days after
  their time; failed ones a week after their time (`scheduled.prune`, hourly).

**The app** (`public/js/scheduled.js`): the list comes from `GET /scheduled-messages` at start-up and reconnect and
follows `scheduled:update` / `scheduled:remove` on every device. A bar above the main composer says what's
scheduled in that conversation ("2 messages scheduled here, the next tomorrow at 9:00 AM", or in red when one
wasn't sent or is waiting for you) with **View**; the conversation's ⋯ menu has **Scheduled messages** too (with a
count, worked out when the menu opens), and the push opens the list of all of them. The list opens each message's
own copy on the device and offers **Send now**, **Edit** (Enter saves: new ciphertext and a new copy, with the
files, the poll and the link previews still in the text kept), **Reschedule** and **Cancel**, plus **Keep** for one
from a signed-out session; failed ones show the reason, **Copy text** and **Dismiss**; unconfirmed ones only
**Cancel**. Times read "Sends tomorrow at 9:00 AM", "Waiting · was due today at 11:48 AM", "Rescheduled for
Monday at 9:00 AM". Words are put on the page as text nodes only. The 25 limit, the times and the reasons come from
the server, which also sends its words for each reason (`note`). Settings → Storage lists a scheduled message's
files as "Waiting with a scheduled message (due …)", and the admin storage report counts them on their own.

**API**

| Route | Auth | Notes |
|---|---|---|
| `GET /scheduled-messages` | session | your own, soonest first, with `max` and `maxDays`; key changes are checked first; 60/min |
| `POST /channels/:id/scheduled-messages` | can post in the channel, not timed out | see above; 30/min, plus the message limits |
| `POST /dms/:id/scheduled-messages` | your DM, no block, the other account exists | see above |
| `PATCH /scheduled-messages/:id` `{ sendAt?, ciphertext?, draft?, epoch?, ttl?, mentions?, everyone?, sendNow? }` | your own, the conversation still yours | new ciphertext needs its new `draft` (400 `draft`), replaces `mentions` and `everyone` (missing means none) and the session, keeps the stricter of its `ttl` and the conversation's timer now (`ttl` checked, 409 `disappear_changed`), and makes a held one pending; a held one whose time has passed needs `sendNow: true` or a `sendAt` with it (409 `overdue`); a held one can't just be rescheduled (409 `held`); a failed one can't be changed (409 `failed`); 60/min |
| `POST /scheduled-messages/:id/send` `{ ciphertext?, epoch?, ttl?, mentions?, everyone? }` | your own | sends now with the same checks; a refusal is answered (403, 404, 429 `slowmode`) and the message left as it was; 409 `held` marks it held. With new ciphertext (checked like a `PATCH`: current epoch, the other person's key, the timer), that copy is posted instead; the app always sends one, saying "now" inside (`binding.js`), so readers don't take it for a message the server posted early. Refused, the copy is dropped and nothing changes |
| `DELETE /scheduled-messages/:id` | your own | cancels or dismisses; its files are deleted; 120/min |

Anyone else's id (or a malformed one) answers 404 "Scheduled message not found.", like one that doesn't exist.
Socket events go only to `user:<you>`: `scheduled:update` (the item) and `scheduled:remove` (`{ id, messageId }`).
Items carry `id`, `serverId`, `channelId`, `dmId`, `threadId`, `replyTo`, `ciphertext`, `epoch`, `ref`, `draft`,
`files` (a count), `sendAt`, `status` (`pending`, `held`, `failed`), `reason` (for held: `key`, `peer_key`,
`session_ended`, `token_renewed`), `note`, `createdAt` and `encryptedAt`. `ref` must be 16–64 of `A-Z a-z 0-9 _ -` and `draft` an
`x1:` string of at most 66,000 characters (400 `draft` otherwise); the server can't open it.

**Data model** (`scheduled_messages`, v19): owner, server, channel or DM (exactly one; no foreign key, so a deleted
one is reported at send time), thread, reply, ciphertext, epoch, `ref` and `draft` (the sender's own copy),
`session_id` (the session that last wrote it), `own_key`, `peer_key`, file URLs, mention ids, `everyone`,
`send_at`, `status`, `reason`, `told_at`, `created_at`, `updated_at` (when the ciphertext was written). No
plaintext column. A scheduled message's files are `blobs` rows whose `message_id` is its id: the
orphan sweep (`uploads.orphan_sweep`) and *Clean up orphans now* count them as in use. Deleting the account
deletes its scheduled messages and their files at once.

**Tests**

- `test/scheduled.test.js` (24 tests): a channel message goes out at its time as a normal one (live event,
  `createdAt` at the time, a new id, no nonce, the ping recorded, nobody else told, `scheduled: true` on the
  sender's own copy only); going out marks nothing read for the sender (a ping, a DM and a thread reply with a ping
  that came meanwhile all stay unread); thread replies, replies, and a reply whose target was deleted; DMs and group
  chats; disappearing messages (scheduling and re-encrypting refused for a timer that just changed, the timer kept,
  the deadline counted from when it goes out and its file's with it, the conversation's timer winning when it got
  shorter or was turned on meanwhile, the one it was written for when it got longer or was turned off, in a channel
  and a DM); voice channels' chats taking scheduled messages, with threads there and a group's call refused;
  list, edit, reschedule, send now and cancel, and that nobody else can do any of it or tell an id from a
  missing one; new words replace who it pings (@everyone and @names edited out ping nobody; rescheduling keeps
  them); the sender's own copy and its ref required and checked for shape, and replaced with the ciphertext;
  validation of the time
  (strings, booleans, past, 31 days, huge numbers, arrays), the ciphertext (the size limit as for sending),
  mentions, files, replies, threads, a group's call, outsiders and stale epochs; the 25 limit (DMs included,
  failed ones not counted) and the rate limit; refusals when scheduling (no permission, files without Attach
  Files, timed out, blocked either way, deleted account); refusals at the time (timed out, kicked, channel
  deleted, thread deleted, permission taken away; blocked, account deleted), each failed with its reason and the
  sender told, nothing posted; send now refused while timed out, and slow mode moving the time; key rotation
  (held at once when someone leaves, held at its time when the epoch changed unseen, not reschedulable or sendable
  until re-encrypted, a stale epoch refused, sent once re-encrypted, an overdue one only with `sendNow` (409
  `overdue` otherwise), failed when the sender was removed meanwhile); a DM partner's new key holds it, the sender's own new keys fail it (the signing key for
  channels only); a message overdue by more than a day fails as `too_late` unless re-encrypted since; files (only
  your own unused uploads, handed to the message, kept by *Clean up orphans now*, deleted on cancel); a deleted
  account's messages never go out; a message due while the server was down goes out once after a restart, and the
  start-up orphan sweep keeps a waiting message's file; a session that ends (*Log out all other devices*, logging
  out, signing one out) holds what it scheduled (`session_ended`): not posted at its time, the sender told, not
  sendable or reschedulable as it is, not turned into a key hold by a key change, sent once confirmed with new
  ciphertext, and what other sessions scheduled untouched; a new sign-in token for the same session (`auth-11`)
  holds what it had pending (`token_renewed`), a copy of the old token can't confirm one, and the app re-encrypts
  its own from the new token (after a 401 too) but never one whose copy doesn't open; Settings → Storage and the admin report label a
  scheduled message's file; static checks that `public/js/scheduled.js` never builds HTML and never decrypts the
  ciphertext it's given (it re-encrypts only from the vault-sealed copy, bound to ref, conversation and thread).
- Browser flow (`npm run test:e2e`, "send later"): a right-click on Send offers the times; the clock schedules
  "In 1 hour", the box empties and the bar appears, Bob sees nothing; the list decrypts it, Edit changes the
  words, Reschedule with a date and time changes when, Send now posts it and Bob reads the edited words; in a DM,
  one is scheduled, found from the ⋯ menu and cancelled. Then Bob schedules one and Alice leaves and comes back:
  his open app re-encrypts it by itself with each new key (the stored copy ends on the current epoch), and once
  sent Alice reads it with the key made after her return. Then two "held" messages are slipped into Bob's list in
  the database (one of his own old messages from an earlier epoch, without a copy and with a made-up one): after a
  reload his app sends no PATCH, leaves both exactly as they were, shows "can't confirm you wrote this one" with
  Cancel only, and he cancels them. Last, one of Alice's is held as if its session had been signed out, three hours
  overdue: after a reload her app leaves it alone, the bar says it's waiting for her, the card says "was due today
  at …", saving an edit asks "Its time has passed" (and Cancel leaves it unsent), and **Keep** → **Send now** sends
  it to Bob.
- `test/message-binding.test.js` (where a message belongs, crypto-7): posted at its time, a day late, or replying to
  a message deleted before it went: no flag; the old copy posted two hours early by a plain `POST …/send`, or more
  than a day late, flagged; `POST …/send` with a fresh copy posts that copy (the same `u`, no flag), and a refusal
  (slow mode, a bad copy, a stale epoch, someone else's message) leaves the scheduled one exactly as it was. The
  sender's `scheduled.js` (run in Node): a server that marks one held and "due now" (or due earlier than the copy
  says) gets no re-encrypt; one it says is due three days late is re-encrypted with the copy's own time, so posting
  it then is flagged; one just past its time keeps that time; one hours past waits; a copy from before these fields
  gets no binding. The browser flow "message binding" checks that nothing the send-later flow sent is flagged.

**Known limitations**

- The server learns, ahead of time, that a message is coming, where, when, its size, and when and from which
  session it was written or edited. It holds a valid, signed message until the time, and is trusted to send it then
  and to really delete one that's cancelled. Since 1.29.0 the time it should go is inside it (`binding.js`), so
  readers' apps flag one posted more than 10 minutes early or more than a day late, or twice while both copies are
  loaded; within that day it can still hold one back, and it can't get the sender's app to put another time inside
  (that time only ever comes from the sender's own copy or their own Reschedule or Send now). Recipients' apps can
  tell a message was scheduled and when it was due (`sch`). A dishonest server that kept a cancelled one (its
  ciphertext and the sender's copy) could bring it back into the same conversation and thread, and after a key
  change the sender's app would re-encrypt it if it were due within minutes. Holding a signed-out session's messages is the server's doing too: it protects against
  a stolen session token, not against the server.
- A message held because of a key change goes out late if the sender's app isn't opened before its time; over 10
  minutes late, the app asks before sending it.
- *Export my data* doesn't include scheduled messages that haven't gone out yet.
- Server backups taken while a message waits keep its ciphertext until they rotate out.

## Word filter

Hide or blur messages with words you'd rather not see. Messages are end-to-end encrypted, so a filter on the server
can't work (NEXT.md, "Not recommended"): the matching runs only in each reader's app, which never tells the server
what matched. Code: `public/js/wordfilter.js` (the matching, no page around it), `public/js/wordfilter-app.js` (the
lists, what's hidden or blurred, the settings), `server/wordfilter.js` (where the lists are kept), and the drawing in
`public/js/app.js` (`messageEl`, `filteredEl`, `fillMessage`).

**Two lists.**

- **Yours** (Settings → Privacy & safety → Word filter). Sealed by your app with your personal vault key (the one
  saved-message notes and scheduled messages use; only your identity key can make it), bound to your account
  (`hearth-vault|wordfilter|<your id>`), padded to 8 KB steps so its size says little about its length, and synced
  to your devices. The server stores ciphertext only. It applies everywhere: server channels, voice channels' chats,
  threads, DMs and group chats. Each save seals a number one higher than any this device has seen (`n`), and the
  device keeps the highest-numbered sealed copy it has opened or saved (`localStorage` `hearth.wordFilter.<id>`,
  ciphertext only). If the server later answers with a lower number or no list at all, that device keeps using its
  own copy and Privacy & safety says so ("Save this device's copy again" puts it back), so a server can't quietly
  roll back or strip someone's list. Saving from the editor is made against the version it showed (`base`): a list
  saved on another device meanwhile is refused (409 `stale`) and shown, never overwritten. A live change redraws an
  open editor if nothing was typed in it, and otherwise says so above the Save button.
- **A server's suggested list** (Server settings → Word filter, for people with **Manage Server**: it applies in
  every channel, like the server's name, so Manage Messages isn't enough). Plain text that every member can see
  (Privacy & safety lists it behind "Show the list"); members' apps apply it in that server's channels, voice
  channels' chats and threads, never in DMs. Each member can turn it off for themselves; which servers they turned
  off is inside their sealed list, so the server doesn't learn that either. It's a suggestion: it doesn't stop
  anyone from posting anything, and the UI says so on both pages. Group chats have none.

**Matching** (`wordfilter.js`): whole words, any capitalization; a phrase is its words in a row, whatever spaces or
punctuation sit between them; `*` stands for any letters inside one word (`cat*`, `*cat`, `c*t`) and never reaches
into the next one. An entry in a script written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar)
matches anywhere inside a run of text, as if it had a `*` at each end (not counted against the four). No other
syntax, and entries are never turned into regular expressions: each word is compared with a small walk whose cost
is the word's length times the entry's. Both the list and the text are folded the same way first: NFKC, small
capitals and letters in black circles and squares (🅒, 🅲) read as plain letters (flag letters stay flags), lower
case, marks dropped from Latin, Greek and Cyrillic letters (other scripts keep theirs), `ß ø ł đ ð ħ ı ŧ æ œ þ` read
as plain letters and `ς` as `σ`, default-ignorable and format characters removed (zero-width spaces and joiners,
soft hyphens, direction marks, variation selectors, tags, fillers), Cyrillic and Greek look-alikes (`а с е о р х…`)
read as the Latin letters they look like in every word on both sides, letters spelled out one at a time with short
gaps on one line (`c a t`, `c.a.t`) also read as one word, and a letter written three or more times matching it
written once or twice in the entry (`caaat`), while a doubled letter isn't stretched (`god` doesn't catch `good`,
and so `caat` doesn't catch `cat`). Because look-alikes are read alike everywhere, mixing scripts in a word gets
nowhere either way (`сat` with a Cyrillic с, `пидоp` with a Latin p, `xуй`). A word written wholly in one script only
stands for an entry in another in context, so ordinary words aren't hidden: look-alike-only Cyrillic or Greek words
count as Latin when the message has no other Cyrillic or Greek letters (`сат` in English text is `cat`, but `но`,
`как`, `не`, `рот` in Russian sentences aren't `ho`, `kak`, `he`, `pot`), and a Latin word counts for a Cyrillic or
Greek entry when the message is otherwise written in that script (`Закрой pot` is `рот`; `I like pot` isn't). The
text is read twice when its formatting changes it: as typed and as shown (`markdown.js` applied, tags removed), so
`c**at**`, `c*at*`, `ca~~t~~`, `` c`at` `` and `c||at||` are `cat` too. Line breaks, code blocks and line blocks
(headings, small print, list items, quotes) stay apart as shown, so two list items never join into one word. Digits or symbols standing for letters
(`c4t`) aren't guessed at.

**Cost.** Each different word in a message is prepared once and compared with each entry's word at most once. An
entry starting with a word without `*` is found by a `Map` lookup of that word; the others by looking up each stretch
of a text word as long as an entry's needed letters (the longest run of letters it can't do without), so the work
goes with the text, not the list. Before a walk, a word must have those letters, start and end with what the entry
starts and ends with, and be long enough. A word longer than 256 characters (a link, a pasted key) is compared by
its first and last 128 with a break no letter matches between them, so whatever matches there matches the whole
word too. And each message gets a budget of 1,000,000 steps per list (a walk costs its length times the entry
word's, plus a little per comparison): a message that would take more counts as matching, so it's hidden or blurred
with Show one click away, rather than slipping through or freezing the app. Honest long messages with large lists
use a small part of it; the worst lists and messages found in review (up to 6.5 s each before) now take tens of
milliseconds.

**Limits**: 200 entries per list, 60 characters, 5 words and 4 `*`'s per entry, at least 2 letters or numbers, and
a `*` inside a word (not on its own). Entries lose invisible, format and direction characters (the matcher ignores
them anyway, and in a list they could make an entry read as another, like `‮emit` showing as "time"); one with half a
character (a lone surrogate) is refused. The app shows what's wrong with each entry as you type, refuses to save
until it's fixed, and has a **Try it** box that runs the list as typed (and as shown). The server checks a server's
list by the same rules, folding the same way (`cleanList` mirrors `parseEntry`; a test runs both over the same
entries), and says which entry is wrong; a sealed personal list is at most 96 KB. Text past 50,000 characters isn't
looked at (more than the app ever sends).

**What a match does.** Each list says **Hide** (a row "Hidden by your word filter" or "…by this server's word filter"
with **Show**) or **Blur** (the words, link previews, pictures, polls and files under a blur with a button on top;
`inert` until shown, so nothing in it can be clicked, focused or read out). Hiding wins when both lists match. Your
own messages are never filtered. **Show** lasts until the page reloads. A hidden row names its author unless the row
above already does, and the next message never groups under a hidden one, so nothing reads as someone else's;
after **Show** the next one is drawn again (it may group now). A hidden row keeps the message's warnings: a key or
signature that doesn't check out, and the ⚠ flag (with its details) when the server may have moved, repeated or
rolled it back (crypto-7, `binding.js`); only the words are hidden, so a server can't keep its tampering out of sight
by putting a word from the message on its suggested list. Hidden rows are out of the Tab order like any message
that isn't the current one. Everywhere else a message appears, a match says "Hidden by … word filter" instead of
quoting it: reply quotes, the reply bar, reminders, search results, conversation previews, the notifications the app
shows, the inbox, pins, saved messages and the Threads panel; **Copy text** isn't offered until Show. When a list
changes, only the message rows whose filtering changed are drawn again (each row keeps what it was drawn with in
`data-wf`), never one being edited, so an open edit and anything else on screen stay as they are. What's checked is everything a
message shows as text: its words, link previews' title, description and site name, a poll's question and options, a
bot's card, and file names and descriptions (alt text).

**What the server learns.** Nothing about matches: the lists are fetched whole, matching and Show stay on the device,
and a hidden message is still drawn out of sight so it loads what it would have shown (its pictures, a poll's votes)
when its row comes near the screen, like any other; a blurred one is laid out as usual. So downloads look the same
whether or not anything was hidden. Push notifications sent by the server never had message text in them.

| Route | Auth | Notes |
|---|---|---|
| `GET /me/word-filter` | session | `{ data, updatedAt }`, your own only; 120/min |
| `PUT /me/word-filter` `{ data, base? }` | session | `data` an `x1:` string (≤ 96 KB, else 413) or `null` to delete; `base` the version the app last saw, a newer one is refused with 409 `stale` (the app reloads it); 30/min, 300/hour, 120/min per network; live `wordfilter:changed { updatedAt, from }` to your own apps |
| `GET /servers/:id/word-filter` | member | `{ words, action, updatedAt }`; 400 for a group chat |
| `PUT /servers/:id/word-filter` `{ words, action }` | Manage Server | `words` an array or the text as typed (lines or commas; `[]` clears it), `action` `hide` or `blur`; 400 `bad_entry` naming the entry; an unchanged list writes nothing; audit-logged as `word_filter_update` (`added`, `removed`, `count`, `action`; a detail too long to keep loses list items, never its counts, and the log never reads a cut entry as "cleared"); live `server:wordfilter { serverId, wordFilter }` to the server's room; 20/min, 100/hour, 60/min per network |

Every member's copy of a server carries `wordFilter` (`{ words, action, updatedAt }`, or null).

**Data model** (v19): `word_filters` (user, `data` sealed or NULL, `updated_at`), deleted with the account;
`servers.word_filter` (JSON, NULL for none).

**Tests**

- `test/wordfilter.test.js` (31 tests): whole words and phrases; wildcards; NFKC, styled and circled letters,
  accents, strike-through and Zalgo marks, zero-width and joiner characters, soft hyphen, direction overrides,
  variation selectors, Cyrillic look-alikes (mixed and whole-word) while real Cyrillic words and Devanagari keep
  their spelling; spelled-out and stretched letters, within reason; list checks and caps (and that the server uses
  the same rules); hostile entries (regex syntax is plain text) and the worst lists against the worst texts finishing
  quickly, the text cap; link preview, poll, card and file-name text; the app module run in Node with the real vault
  encryption (sealed and padded, bound to the account, opened on another device of the same account and not by
  another key; never your own messages; your list everywhere, a server's only in that server and not after you turn
  it off; hiding beats blurring; a stale save refused and reloaded); the server list's permissions (Manage Server,
  not Manage Messages, not outsiders, not group chats), limits and bad input, audit entries with what was added and
  removed, live updates, an unchanged save writing nothing; the personal list's validation, size cap, per-account
  reads, stale saves, live event to your other apps, deletion and removal with the account; and a static check that
  no route takes anything about matches. Added in review: look-alikes inside Cyrillic and Greek words (`пидоp`,
  `xуй`, `μαλάκaς`) while ordinary Russian sentences aren't caught by `ho`, `kak`, `he`, `pot`, `coke`; small
  capitals and black-boxed letters; Chinese, Japanese and Thai inside runs of text; formatting (`c**at**`, `c||at||`
  and the rest); the doubled-letter trade-off; the review's worst lists and texts each finishing fast, the budget
  counting as a match, an honest long text with a clumsy list staying inside it; invisible, direction and half
  characters in entries; the server and the app agreeing on a corpus of odd entries; an editor's stale save refused
  with the other device's change kept; a rolled-back or stripped sealed list ignored by a device that saw a newer
  one; news of this device's own save loading nothing, and another device's during a save loading after it; half characters refused by the server with the audit entry complete; audit trimming keeping counts; and an
  old cut entry never reading as "cleared".
- Browser flow (`npm run test:e2e`, "word filter"): Alice's list refuses a lone `*` as she types, the Try it box
  catches "T A M A R I L L O S" and "ta\*\*marillos\*\*", and the server holds it sealed; Bob's "tämarillos" is hidden on
  her screen behind Show (never on his), his next message still shows his name and the hidden row names him,
  replying to it from its menu quotes the filter's note in the reply bar, search says it's hidden instead of quoting
  it, and Show reveals it (and the next message groups under it again); Bob sets a blurring list for the server while
  Alice has an edit open, the audit log has it, his next match is blurred (inert) on her screen at once, and her edit
  is as she typed it; she reads the server's list and turns it off for herself, and the blur goes. Added in review:
  Bob's own list hides the reply the message binding flow tampered with, and its row still carries the ⚠ flag, whose
  details open.

**Known limitations**

- It changes what you see, not what's sent. A server's list is a suggestion members can turn off, and people can
  always spell around a word list (digits for letters, words split other ways). Moderation still needs moderators.
- A message already on screen when a list changes is redrawn; one already notified isn't recalled.
- A letter written exactly twice isn't read as once (that would make `god` catch `good`): add that spelling, or use
  a `*`. A Cyrillic or Greek word spelled wholly in Latin letters in an otherwise Latin message (`cyka`) isn't read as
  the Cyrillic entry, so ordinary English words aren't hidden by look-alike entries; flag letters (🇨🇦) aren't read
  as letters.
- A word longer than 256 characters is compared by its start and end only, and a message that would cost more than
  the budget counts as matching (it's hidden or blurred; Show is one click).
- The rollback check needs a device that has already seen the newer list: a newly signed-in device takes what the
  server gives it.
- **Show** isn't remembered after a reload, and turning a list off for one conversation isn't possible (only for a
  server).
- Your list is sealed with your identity key: if a password reset makes a new identity, the old list can't be opened
  and the next save starts a new one (the settings page says so).

## New members can't read messages from before they joined

A server setting (`servers.hide_history`, v19), in **Server settings → Overview → Privacy**: the option
ENGINEERING-REPORT crypto-13 left open. Rules and the key handling are in `server/joinhistory.js`; the routes it
touches are in `server/index.js`, `server/usability.js`, `server/search.js`, `server/bots.js`, `server/disappear.js`,
`server/scheduled.js` and `server/serveraudit.js` (report evidence); the app's side is the Overview switch,
`historyStart`, the key bar and the encryption dialog's count in `public/js/app.js`, the waiting message in
`public/js/secure.js` and Settings → Check my encryption (`public/js/settings.js`), and the audit sentence and the
report note in `public/js/serveraudit.js`.

**Off by default**, for new and existing servers: with it on, every join replaces the key for every member's app and
newcomers wait a moment for theirs, and many communities want newcomers to read back (Discord's default too).

**With it on**

1. A join (an invite: the only way into a server) records where the newcomer's history starts: `members.key_from`
   (the next key epoch) and `joined_at`. Members who were in before, and people who joined while it was off, have
   none and see everything. Leaving drops it with the membership row; coming back starts again from then.
2. The key needs replacing (`needs_rotation`, as after a kick), so the apps make a new one, wrapped to everyone in
   the server, before the next message goes out (sends return 409 `rotate` until then). Joins close together share
   it, and a flood can't keep everyone switching keys: a join waits until the current key is a minute old for each
   key made in the last hour (at least one). Meanwhile `servers.join_rotate_at` holds the time (a restart keeps it),
   messages keep flowing under the old key and the newcomer's app says "Your encryption key is on its way". Any key
   made meanwhile, for whatever reason, covers them. A rejoin (same account) still replaces the key at once.
3. The newcomer is only ever handed keys from `key_from` on: the key state (`GET /servers/:id/keys`, `/bootstrap`,
   `server:add`, `keys:state`) carries only those rows, plus `since: { at, epoch }`; `missing` leaves out members
   waiting for a newer key (so no app tries to share it; they're listed in `waiting`, so the encryption dialog counts
   who holds the current key right) and `keys/share` skips them; `keys/self` doesn't touch their older rows (an
   earlier membership's). The key their join asked for is made by an older member's app: while one is online, the
   newcomer's own `keys/rotate` counts as a voluntary one (10 minutes, 12 an hour), so nobody can join just to put in
   a key the others can't open. A newcomer alone in the server makes it themselves. A member held back until someone
   verifies them (a reset without the recovery key, `crypto-2`) gets no key either way: the key a join asks for is
   wrapped for everyone else, `keys/share` skips them, and they don't count as an older member who could make it.
   Once verified, they're handed the current key like any member missing it (`keys/share` only ever hands on the
   current key). Keys made while they were held, the one their join asked for included unless it's still the
   current one, stay out of their reach, as for any member held back: messages written under those after they
   joined are served to them but stay locked.
4. Nothing from before is served to them. "Before" means written before `joined_at`, or locked with an epoch below
   `key_from` (the few messages sent while their key was on its way, which they could never open):
   - channel and voice-chat pages (`GET /channels/:id/messages`, every paging mode), with `hidden: true` on the page
     that reaches the start when something was left out; the app then shows one line, *Messages from before you
     joined are hidden in this server*, under the channel's welcome, instead of rows of locked messages;
   - threads (`GET /messages/:id/thread` is 404 for an older first message; the Threads panel leaves those out),
     pins and the pin history, search (every scope), saved messages (one saved during an earlier membership shows as
     unavailable), the data export, unread and ping counts (a channel's thread pings too), jumps
     (`/messages/:id/locate`), and acting on an older message unseen (react, pin, edit your own, vote, report it or
     attach it as evidence: 404);
   - a thread started before stays closed, replies written after the join included: every path above goes by the
     thread's first message as well as the reply (search, locate, saving, reacting, pins, export, the thread's read
     marker `POST /me/read { conv: 't:<root>' }`, thread pings), and replying into it (now or scheduled) is 404 like
     a thread that doesn't exist;
   - disappearing-timer changes from before they joined (`timerEvents` on history pages, the log in
     `GET /channels/:id/disappearing`);
   - as a moderator later on, the evidence of a report filed about a message from before: the report is in their
     inbox to handle as usual, with `evidenceHidden: <count>` instead of those messages (the app says "from before you
     joined, so it isn't shown"), since the reporter's app decrypted them;
   - a reply's quote of an older message: `reply: null` with `replyHidden: true` ("Replying to a message from before
     you joined");
   - live events: a new message under a key from before theirs, edits, reactions, pins, poll updates and thread
     counts of older messages (after a reply is deleted, bulk-deleted or disappears too), and replies in an older
     thread don't reach them; pushes and mention marks skip them too. Link previews travel inside messages, so they
     go with them; scheduled messages are only ever their author's own.
5. Turning it on replaces the key once, so what's been said so far is under a key that's never handed out again
   (only the current key ever is). Turning it off lets later joiners read back as before; whoever joined while it was
   on keeps their start (they never got those keys). Each change is a `server_update` entry with
   `changes: ['hideHistory']` and `hideHistory: true|false` in the server's audit log ("Ana turned on “New members
   can't read messages from before they joined”"), at most 10 changes an hour per person in each server (one budget
   for the whole server could be used up by one manager, ending on off, so that nobody could turn it back on).

**Group chats** don't have it (400): anyone in a group can add people, and groups have no server settings.

| Route | Who | What |
|---|---|---|
| `PATCH /servers/:id { hideHistory: true\|false }` | Manage Server | turns it on or off; on sets `needs_rotation`; not for group chats; anything but a boolean is 400; 10 changes an hour per person in each server (429) |

The server's copy of a server carries `hideHistory`; the key state carries `since` for the members it applies to, and
`waiting` (who's waiting for the next key) while anyone is.

**Tests**

- `test/join-history.test.js` (18 tests): the setting (off by default, Manage Server only, outsiders and group chats
  refused, the audit log both ways, no entry for no change, the hourly limit, a key switch on turning it on and none
  on turning it off; a co-manager using up their own changes and leaving it off doesn't stop the owner turning it
  back on); keys with it on (only the epoch after the join, the current one never shared, not listed as
  missing) and off (shared, history readable as before); a rejoin (no old rows handed back or rewritable, their own
  older messages hidden and not editable); a join flood (the first join switches at once, the rest share one wait of
  a gap per key made in the last hour, nothing under the old key reaches or is served to the waiting member, unread
  counts too, a key made meanwhile cancels the wait); a wait that survives a restart; every way history is served
  (pages and paging modes, threads and the Threads panel, pins and pin history, search in every scope, locate,
  saving, reactions, polls, reports and evidence, export, unread counts, quotes); a message saved during an earlier
  membership; voice channel chats and turning it off again; live events (edits, reactions, pins, thread replies and
  counts of older messages skip the newcomer; a reply to an older message arrives without its quote); members
  already in keep everything; a thread from before (a reply written after the join isn't found by search in any
  scope, located, saved, reacted to, pinned for them, quoted, exported or read-marked, its @everyone ping doesn't
  count, live reactions and thread counts after a bulk delete skip them, and nothing can be posted or scheduled into
  it); the newcomer's own key change refused while an older member is online, allowed alone; report evidence for a
  moderator who joined later; timer changes, the pin history of a message sent during the key wait, and `waiting` in
  the key state; and the app's own key code (`secure.js`): the newcomer's device holds only the new key, reads what
  came after with no locked rows, and an older member's device keeps both keys.
- Browser flow (`npm run test:e2e`, "join history"): Dana leaves the server; Bob turns it on (the audit log says so)
  and writes in #general and the Lounge's chat; Dana joins again with an invite and sees the one line, no earlier
  messages and no locked rows, in #general and in the Lounge's chat; what's said after goes both ways; Alice, there
  all along, sees everything; Bob turns it off again. (The flows' sign-ups from one network are used up by then, so a
  first-time joiner is left to the server tests.)

**Known limitations**

- It's the server that decides when keys change and who is handed which (SECURITY.md §4, crypto-5): a malicious
  server could skip the key change or list a newcomer as missing the current key. It keeps history from newcomers on
  an honest server, like private channels.
- Messages sent while a newcomer's key is on its way (only when joins come faster than the limit) stay hidden from
  them for good, though they were written after they joined.
- A thread whose first message is from before stays closed to the newcomer, replies written after they joined
  included.
- Deletions are announced to everyone who can see the channel (`message:delete`, `message:delete-bulk`), older
  messages included: the event carries ids only, nothing the newcomer could open, and their app has nothing to
  remove.

## Invite links that unfurl, and inviting your people

Every invite link someone shares is a small advertisement for their server. Before this, `/invite/<code>` was the app's
bare page: pasted into Discord, Reddit, X or a text message it previewed as nothing, and a signed-out visitor saw a plain
sign-in form with no word about why they were there. Server owners also got no nudge to invite anyone after making a
server. This adds both, with no tracking and nothing public by default (`server/invitepreview.js`,
`public/js/invite-share.js`).

**Link previews** (`GET /invite/:code`): the app's page, with Open Graph and Twitter card tags in place of its title.

- By default the card says "You're invited to a server on *instance*" and "Hearth is free, private chat. Messages are
  end-to-end encrypted." It is byte for byte the same for every code (unknown, expired, used up and revoked ones too),
  so the page can't be used to check whether a code works.
- A server can opt in: **Server settings → Overview → Privacy → "Show this server's name and member count in invite
  link previews"** (Manage Server, off by default, in the server's audit log, `servers.invite_preview` in v19). Then a
  link that still works shows "Join *server* on *instance*" and "*n* members". Never the icon, the description,
  channels, members' names or anything anyone wrote. Group chats have no invite links, so no setting.
- The picture is the instance's own app icon (`/icons/icon-512.png`) at the configured public address: Admin → Email's
  public address, `PUBLIC_URL`, or the first `PUBLIC_HOSTS` name when Hearth serves https itself. It is never built from
  the request's Host header, so a forged one can't put another site into a card that a bot or cache keeps. Without a
  configured address the card has no picture. Server icons stay out (`/uploads` is for signed-in members); a signed
  link like the news pictures' could add them later.
- Invite pages say `noindex` (a meta tag and `X-Robots-Tag`) and are never cached (`no-store`). Every value is
  HTML-escaped, quotes included, with control and direction-changing characters dropped and lengths capped (titles 120
  characters, descriptions 300, never half an emoji).
- The app's own page (`/`, `/index.html` and every other app address) carries the instance's name and tagline the same
  way, so the bare address unfurls too. It is still sent compressed. The page keeps its own `theme-color`, which some
  apps use for the card's accent.

**The sign-in screen** (`GET /api/invites/:code/preview`, no sign-in): `{ instance, server: { name, memberCount } | null }`,
`server` only when the server opted in and the link works. Signed out with an invite link, the sign-in screen shows
"You're invited to *the server, or "a server"* on *instance*. Create an account or sign in to join." with a **Create an
account** button (on an instance that wants a sign-up code: "create an account with a sign-up code from whoever invited
you"; closed: "Sign in to join"). The join dialog opens after signing in, as before.

**Limits**: the page and the JSON share one allowance of 60 look-ups a minute per network. The JSON answers 429 past
it; the page never refuses (someone following a link still gets the app) and shows the generic card without looking the
code up.

**Inviting your people** (client only):

- Creating a server opens the invite dialog in a welcome mode: "Your server is ready. Invite your people." with the
  link already made. **Import from Discord** ends with **Invite people** on its report, which opens the same welcome
  with a 30-day link and **Copy a moving announcement for Discord** ("We're trying Hearth… Our channels and roles are
  already set up: *link* (link expires in 30 days)", with the link's real expiry; nothing about expiry for Never).
- Every invite dialog has **Copy invite message** ("Join me in *server* on Hearth: *link*", then what Hearth is and
  where they'll make an account), and **Share…** where the device has a share sheet (`navigator.share`: phones and
  some desktop browsers; not the desktop app or the Android app's web view). Share hands over the link and a message
  without it.
- The words follow how the instance lets new people in (`registrationOpen` and `registrationRequiresCode` in
  `/api/config`). Open: "You'll make an account on *instance* first." Sign-up code: the message says making an account
  needs a sign-up code and to ask the sender for it (never the code itself), and the dialog says to send the code
  separately (an instance owner or admin is told it's in Admin → Registration & Terms; anyone else that whoever runs
  the instance has it). Closed: the message says it only works with an account they already have there, and the
  dialog says only people with an account can join. Outside the welcome, the dialog shows that line only for a code
  or a closed instance. The moving announcement says the same before the link.
- Alone in a server where you may invite people, its first text channel starts with "It's just you here." and an
  **Invite people** button; it goes by itself once someone joins, or when you dismiss it (remembered per server in this
  browser, `hearth.inviteNudgeDismissed`).
- Nothing is sent by Hearth: no contacts, no automatic messages, no referral counts.

**API**

| Route | Who | What |
|---|---|---|
| `GET /invite/:code` | anyone | the app's page with the card's tags; generic unless opted in and working |
| `GET /api/invites/:code/preview` | anyone | `{ instance, server }`; 60 a minute per network, shared with the page |
| `PATCH /api/servers/:id` `{ invitePreview }` | Manage Server | the server's name in previews on or off (audited) |

**Tests**

- `test/invite-preview.test.js` (8 tests): off by default, an unknown, expired and working code (and a hostile one)
  get the byte-identical generic card, noindex and `no-store`, and the JSON names no server; only Manage Server can
  turn it on (members, outsiders, group chats and non-booleans refused), members see it, and it's audited; opted in, a
  working link names the server and its member count and nothing else, while expired, used-up and revoked links and
  turning it off again give the generic card; a name with quotes, `<script>`, `&`, `$&` and control characters is
  escaped (one title, only the app's own scripts) and long text is cut whole; the per-network limit (JSON 429 on the
  61st, the page quietly generic, other networks unaffected, a page flood counting against the JSON); the app's page
  with the instance's name and tagline escaped on `/`, `/index.html` and app addresses, a forged Host header changing
  nothing, still compressed; and `invite-share.js` (the messages carry the link and the real expiry, an open, a
  sign-up code and a closed instance each get their own words with no false promise, Share only with a share sheet,
  the card's rules, and dismissals when storage fails).
- `test/attack.test.js`: the preview JSON is in the list of routes that answer without a sign-in, and gets the
  every-route sweep like the rest.
- Browser flows (`npm run test:e2e`): "servers" (creating the server opens the welcome with a link, no Share button
  without a share sheet, the copied message carries the link, the card in #general opens the dialog and Share hands
  the link to a share sheet, a signed-out visitor's banner says "a server" and the page doesn't name it, the card goes
  when Bob joins, Alice turns previews on (audited) and the visitor's banner and the page then name the server with
  its member count, and **Create an account** goes to the sign-up form); "step-up" (the card dismissed in a new server
  stays away); "discord import" (Invite people on the report, a 30-day link and the moving announcement with it).

**Known limitations**

- Whoever holds a link to an opted-in server, and every preview bot it passes through, learns the server's name and
  member count: that's the point, and the setting's hint says so. A link stays a key to the server for as long as it
  works (expiry and use limits as before).
- Preview bots keep the cards they made: turning the setting off or revoking a link changes what Hearth serves at once,
  not a card a bot already stored.
- On an instance whose sign-ups need a code, a server invite still doesn't let someone sign up. An admin option for
  that would help invites on closed instances, but needs its own security review.

## Discord habits: #channel links, line formatting, attachment options, shortcuts

Small additions in the app for communities moving over from Discord. None needs a server or schema change: the
tokens and options travel inside the encrypted message, and the server never sees them.

**#channel links** (`public/js/markdown.js` `CHANNEL_MENTION`; the composer's `checkSuggest` and
`onMessageAreaClick` in `public/js/app.js`). Typing `#` in a server channel lists that server's text and voice
channels (not in DMs or group chats); picking one puts `<#id>` in the box. Readers' apps look the id up in their own
list of servers, which only holds channels they can see, so a link shows `#name` and opens the channel in place
(`#c/<id>` is the same link from anywhere), and any other id shows as plain `#unknown-channel`, with no link and no
name. Previews, notifications and the reply bar show `#name` as text (`readableText`). A server's welcome message
(Server settings) has no picker, so `#rules` there links to the channel called rules (`linkChannelNames`).

**Line formatting** (`render`). `# `, `## ` and `### ` headings, `-# ` small print, `- ` or `* ` bullets and `1. `
numbered items (indent to nest; counted on from the first number), `> ` for one quoted line and `>>> ` for the rest
of the message. Each needs a space after the marker, so `#general` and `#1` stay text; code blocks are left alone;
everything is escaped first, as before. On one line (replies, thread cards, previews) the markers are dropped and
bullets become dots. `<t:seconds>` and `<t:seconds:style>` (t, T, d, D, f, F, R) show in the reader's time zone, the
same syntax `server/webhooks.js` already turns into dates for webhook posts.

**Attachment options** (the pencil on a file in the box: `editPending`; `uploadEncryptedFiles`; `attachmentEl`,
`altChip` and `spoilerCover`; `public/js/attachments.js` `cleanFiles`). A description (alt text, up to 1,000
characters) for pictures and videos, and "Mark as spoiler" for any file, sent as `alt` and `sp: 1` on the file's
entry. Readers keep `alt` only as a trimmed string and `sp` only as 1. Pictures use the description as their alt
text and show an ALT button that opens it; spoilers are blurred under a Spoiler button, and the first click or Enter
only uncovers them (videos and songs stay paused, file cards say Spoiler). The picture viewer's arrows skip spoilers
nobody has opened yet.

**Keyboard shortcuts** (`public/js/keybinds.js` `SHORTCUTS` and `shortcutGroups`; `openShortcuts` in app.js).
Ctrl+/ (⌘+/) opens a sheet of every shortcut, in navigation, messages, calls (this person's own keybinds) and the
picture viewer; pressed again, it closes. Also from Settings → Keybinds → See all shortcuts and the menu on your
name. Shift+Esc marks the server you're in as read (not in a group chat, nor while a dialog or menu is open).

**Tests**: `test/markdown-client.test.js`, `test/attachments-client.test.js`, `test/shortcuts-client.test.js` (every
key `globalKeys` handles is in the sheet), the e2e flow "discord habits", and the shortcuts sheet and the attachment
dialog in `npm run test:a11y`.
