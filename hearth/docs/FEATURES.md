# Message usability and notifications

This page covers saved messages, pins, unread tracking, notification preferences, drafts, data export and
moderation (slow mode, timeouts, reports). It starts with what Hearth already had before this work (schema
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
  (mentions and replies) and `*` for a valid @everyone. Only top-level channel messages are counted. In DMs and
  group chats, every message counts.
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
    read-only, with the end time.
  - Timeouts are kept in their own table, so leaving and rejoining doesn't clear one.
  - Moderators can list active timeouts (`GET /servers/:id/timeouts`). In the app, the member menu has
    "Time out…".
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
| `POST /me/read` `{ conv, messageId, unread? }` | session | conversation access checked; message must be in it; 240/min |
| `POST /servers/:id/read` | member | channels you can see |
| `GET /me/notify` | session | your own only |
| `PUT /me/notify/:target` `{ level, muteUntil, suppressEveryone }` | member of that place | 120/min; up to 2000 rows |
| `PUT /me/notify-settings` `{ dnd, tz, previews }` | session | 120/min |
| `GET /channels/:id/pins/log` | can view channel | newest 50 |
| `GET /servers/:id/timeouts` | Kick Members | |
| `POST/DELETE /servers/:id/members/:uid/timeout` | Kick Members + role order | audit-logged; 30/min |
| `GET /me/reports` | session | your own only |
| `POST /me/export` | **step-up** | audit-logged; 5/hour |
| `GET /me/export/account`, `GET /me/export/messages` | session + export token from the same session | 600 pages/min |

Socket events go only to `user:<you>`: `saved:update`, `read:update`, `notify:update`, `notify:settings` and
`timeout:update`.

## 4. Data model (v18, `server/db.js`)

| Table | Holds | Readable text? |
|---|---|---|
| `saved_messages` | user, message id, optional `x1:` note, time | no |
| `read_states` | user, conversation key, last-read message id | no |
| `mention_marks` | message id, conversation, user id or `*` | no (ids the sender's app already sent for push) |
| `notify_prefs` | user, target, level, mute-until, ignore-@everyone | no |
| `user_prefs` | user, JSON (quiet hours, time zone, previews), read baseline | no |
| `pin_log` | channel, message, who, pin or unpin, time | no |
| `member_timeouts` | server, user, until, reason, by whom | the reason a moderator typed |

Rows in `mention_marks` are deleted with their messages (`forgetMessages`, `deleteMessageTree`, the orphan
sweep). Read markers and preferences for deleted channels, DMs and servers are swept daily.

**New metadata the server keeps**: who reads up to where, and when; who saved which message ids; who mutes what;
and quiet-hours times and time zone. The server could already see who was mentioned at the moment a message was
sent. It now keeps that list.

## 5. Tests

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
- Thread replies don't count toward a channel's unread or mention count. They still push and appear in the
  notification centre.
- Mention counts depend on the sender's app sending mention ids, as push already did. A modified app could leave
  them out or add extra ones. It can't add ids for people who can't see the channel.
- Read markers sync only for conversations. There is no per-thread read state.
- Cross-device dedupe closes notifications when you read elsewhere. It doesn't pull back a push already
  delivered to a phone whose app is closed. Browsers can't be pushed silently.
- Quiet hours use the time zone of the last device that signed in.
- The export is held in browser memory before it downloads (hence the limits). There is no resume if the tab
  closes.
- Timeouts are enforced through permissions. Voice reacts to them through the existing `recheckVoice` when the
  server updates. The timeout end is swept every minute, plus an in-memory timer.
- The server enforces the new pin rule (Manage Messages for your own message), and the app hides the action.
  Older app versions still show it and get a friendly 403.
