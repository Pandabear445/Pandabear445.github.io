# Hearth performance

This page records how Hearth's performance was measured, what was changed because of it, and the numbers before
and after. The server sections cover schema version 18. Paths are relative to `hearth/`.

## Server

### Method

`npm run bench` (`scripts/bench.js`) measures the real server. No new dependencies are needed. Each run does this:

1. It makes a fresh data folder (`mkdtemp`). The schema comes from the server's own `server/db.js`.
2. It writes the dataset straight into SQLite. Seeding through the API would take hours and would hit the rate
   limits. Sign-in sessions are added the way the server makes them: SHA-256 of a random token in
   `sessions.token_hash`.
3. It starts `node server/index.js` with `DATA_DIR`, `PORT`, `HOST=127.0.0.1`, `HTTPS=false` and `NODE_ENV=test`.
4. It measures over HTTP (gzip accepted, like the app) and Socket.IO (websocket transport).

Rate limits and fairness:
- Requests rotate across many members. Each member has its own `X-Forwarded-For` address, which the server trusts
  from localhost. So no per-account, per-session or per-network rate limit is hit, and every timing is real work.
- The 1,000 Socket.IO connections run in 3 child processes, like apps on other machines. The bench process then
  doesn't spend its own time decoding 1,000 copies of every event.
- "Last socket has it" is measured on the shared wall clock (`performance.timeOrigin + performance.now()`). It runs
  from just before the HTTP request to the last socket receiving the event.

Statistics:
- Every item reports p50 and p95 over n samples, after warm-up requests.
- Before/after runs were done back to back on the same machine, alternating the order, three times each (five for
  the history and fan-out check). The tables show the median across runs of each run's p50 and p95.
- Raw JSON comes from `--out`. Query plans come from `--plans`. `--root` points the same script and dataset at
  another checkout. That is how the "before" column (commit `dec63ee`, schema v17) was measured.
- To check that each change helps on its own, it was measured against a copy of the code with only that change
  removed.

### Dataset (scale 1, the default)

| | |
|---|---|
| Users / sessions | 2,000 / 2,000 |
| Servers | 50, each with 5 text channels, 1 voice channel, @everyone plus 4 roles, and 4 channel overrides (channel 1 is private to "Staff", channel 2 is read-only except for "Regular") |
| Big server | 1,000 members; 90% hold Staff, so 908 of them can see the private channel |
| Other servers | 22 members each |
| Heavy user | Ordinary member (not owner) of all 50 servers, with 300 DMs and 200 friends |
| Channel messages | 520,001: 500,000 over a year, plus one 20,000-reply thread in the last hour of one channel. Of these, 148,986 are top-level in the big server's #general; 24,237 are thread replies in total; 20 are pinned in #general |
| Reactions | 49,812 |
| Attachment (`blobs`) rows | 10,000 |
| DMs | 1,000 conversations, 20,000 messages |
| Database file | 330 MB before, 358 MB after (the v18 indexes add 28 MB, about 8.5%) |

The 5% of the big server's members who never post there ("lurkers") are used to measure slowmode.
`--scale 0.1` runs everything at a tenth of this size in about 10 seconds.

### Environment

| | |
|---|---|
| CPU | Intel Xeon @ 2.10 GHz, 4 cores (shared with other work; load average 1.7 to 3 during the runs) |
| RAM | 16 GB |
| OS | Linux 6.18.44 |
| Node | v22.22.0, better-sqlite3 13, Socket.IO 4 |

Everything ran on one machine: the server, the bench and the socket client processes. Network latency is
therefore loopback only. Numbers on a quiet machine or with real clients will differ.

### Results: before (v17, `dec63ee`) and after (this branch)

Latency in milliseconds, given as p50 / p95. n is the number of samples per run. Each cell is the median over 3
alternating runs.

| What | n | Before | After |
|---|---|---|---|
| `/api/bootstrap`, heavy user (50 servers, 300 DMs) | 30 | 145.9 / 227.6 | 115.0 / 143.4 |
| Member list: `/api/bootstrap` of someone only in the 1,000-member server ¹ | 30 | 70.5 / 100.8 | 60.3 / 77.9 |
| History: newest page (50) of #general (148,986 messages) | 50 | 3.8 / 5.6 | 3.4 / 6.2 |
| History: `?before=` page at depths across the whole history | 50 | 3.0 / 5.6 | 4.1 / 8.3 ² |
| History: paging back 100 at a time, 50 pages | 50 | 3.7 / 7.3 | 4.3 / 7.4 ² |
| History: newest page of a channel whose last 20,000 messages are thread replies | 30 | 10.1 / 17.5 | 5.7 / 9.9 |
| Thread view (newest 100 of 20,000 replies) | 30 | 5.2 / 7.3 | 6.9 / 10.0 ² |
| Pinned messages of #general | 30 | 364.3 / 418.5 | 2.9 / 5.5 |
| `/api/admin/stats` (every staff app asks for it at start-up) | 10 | 410.6 / 511.8 | 9.6 / 12.2 |
| Search, `scope=all`, heavy user (250 channels and 300 DMs) | 30 | 17.2 / 28.0 | 17.3 / 25.9 |
| Search, one channel (#general), newest 100 | 30 | 5.1 / 7.2 | 4.2 / 7.8 |
| Send in a slowmode channel, sender never wrote there | 40 | 123.4 / 158.1 | 2.5 / 9.0 |
| Send to #general: POST answered (1,000 sockets online) | 40 | 21.2 / 44.1 | 27.8 / 56.5 ² |
| Send to #general: last of 1,000 sockets has `message:new` | 40 | 21.4 / 43.3 | 30.4 / 63.6 ² |
| Send to private channel: POST answered | 40 | 35.9 / 54.6 | 22.0 / 33.8 |
| Send to private channel: last of 908 sockets has it (no socket outside the channel got it) | 40 | 40.6 / 67.2 | 26.2 / 39.9 |
| Role change in the big server: PUT answered | 10 | 702.9 / 1015.0 | 40.3 / 144.7 |
| Role change: last of 1,000 sockets has its `server:update` | 10 | 701.7 / 1038.8 | 193.4 / 429.4 |
| Join the big server (1,000 online) | 20 | 101.2 / 132.3 | 70.7 / 94.6 |
| Leave the big server (1,000 online) | 20 | 54.5 / 84.2 | 40.0 / 63.0 |
| Server start to `/api/config` OK | 5 | 442 / 530 (330 MB) | 444 / 549 (358 MB) |
| Upgrade from the previous schema: start to `/api/config` OK ³ | 3 | 2,827 / 2,908 (v16 → v17, 14 indexes) | 2,548 / 2,596 (v17 → v18, 5 indexes) |

¹ There is no separate member-list route. The app gets a server's members (ids, roles and profiles) in
`/api/bootstrap` and in `server:add` on joining.

² These rows didn't change in a repeat run of 5 alternating runs that measured only history and fan-out. The
differences above are noise from the shared machine. Repeat run, before → after, p50 / p95:
- newest page: 3.5 / 7.3 → 3.2 / 7.5
- `?before=`: 3.3 / 5.2 → 2.9 / 4.6
- paging back: 3.8 / 6.4 → 3.8 / 5.1
- thread view: 4.7 / 7.0 → 4.7 / 6.5
- busy-thread page: 8.9 / 12.0 → 4.9 / 8.8
- send to #general, POST: 14.4 / 31.8 → 13.6 / 26.0
- send to #general, last socket: 14.3 / 32.9 → 13.5 / 27.4
- send to private channel, POST: 29.7 / 40.3 → 14.1 / 17.8
- send to private channel, last socket: 32.7 / 42.2 → 16.5 / 21.3

The open channel's path only gained two index inserts per message. Its send time stayed within the noise in every
run.

³ For the upgrade measurement, the database is set one version back and that version's new indexes are dropped. It
is then started, which runs the backup copy (`VACUUM INTO`) and the migration transaction that builds the indexes.
Most of the time is the copy of the 358 MB file.

Permission micro-benchmark (in process, per call, 1,000 members, p50 / p95, unchanged):
- `perms.channel` without overrides: 0.01 / 0.02 ms
- `perms.channel` with overrides: 0.01–0.02 / 0.02–0.03 ms
- the `requireChannel` path: 0.02 / 0.04 ms

Working out who may see the private channel (`toChannel`) for 1,000 members dropped from 26.4 / 34.8 ms to
1.6 / 4.5 ms.

Server memory (RSS, MB, three runs):

| | Before | After |
|---|---|---|
| Idle after start | 93–94 | 94–95 |
| With 1,000 sockets | 166–176 | 165–169 |
| After the whole load (including 10 role changes to 1,000 online members) | 266–293 | 178–184 |

### What changed and why

Changes are listed from the biggest effect down. Each one was measured against the same code with only that change
removed, and kept because it helped.

1. **Server updates are built once per distinct view, not once per member** (`emitServer` in `server/index.js`,
   `perms.forServer` in `server/perms.js`).
   - The problem: after any role, override, channel or ownership change, every online member got their own
     `server:update`. Each one was built with roughly 20 permission queries and JSON-encoded separately. In a
     1,000-member server that was about 60 MB of encoding per change, and it blocked the event loop for 0.6–1 s.
   - What a member sees depends only on their server-wide permissions and their permissions in each channel. So
     members are grouped by those numbers, and each group's update is built once and sent with one
     `io.to([...rooms]).emit` call.
   - Measured on its own: PUT 582 → 40 ms; last socket 594 → 172 ms. Memory after load fell by about 100 MB.

2. **Permissions for many members are worked out at once** (`perms.forServer`).
   - It reads the server's roles and all members' held roles in one query each, and each channel's overrides once.
   - It uses the same rule functions as `perms.base` and `perms.channel` (`baseFrom` and `channelFrom`), so the two
     paths can't drift apart.
   - Nothing is kept after the call. It is created fresh for each fan-out or update, so it is not a cache, and a
     change to a role, override or membership is seen by the very next event.
   - `toChannel` uses it for private channels. That used 3 queries per member per message before.
   - Measured on its own: private-channel send 28 → 13 ms; working out the audience 16 → 1.6 ms.

3. **v18 indexes** (`server/db.js`, one idempotent block, `// v18 (quality):`).
   - `idx_messages_pins` (`messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL`) and `idx_dm_messages_pins`:
     the pins list read the whole conversation, and then sorted it. Result: 312 → 2.5 ms.
   - `idx_messages_created` and `idx_dm_messages_created` (`created_at`): the admin chart counts messages per day,
     14 times. Each count scanned both message tables in full. Every staff member's app calls this route when it
     starts (`public/js/app.js`). Result: 349 → 6.6 ms.
   - `idx_messages_channel_top` (`messages(channel_id, id) WHERE thread_id IS NULL`): a channel's history skips
     thread replies, but they share the channel's index. When a thread is busy, the newest page had to step over all
     its recent replies. Result: 9.9 → 5.5 ms with 20,000 recent replies; ordinary pages are unchanged.
   - The cost is 28 MB on 520k messages (about 8.5%) and two or three more index inserts per message (not
     measurable in send latency here). The upgrade is one transaction inside the migration, after the existing backup
     copy.

4. **Slowmode check** (`POST /channels/:id/messages`).
   - It used to look up the sender's last message with `ORDER BY id DESC LIMIT 1` on `(channel_id, author_id)`.
     SQLite walked the channel index newest first and read every row until it found one by that author. For someone
     who had never written there, that was the whole channel.
   - It now asks for `MAX(created_at)`, which is one seek in the existing covering index
     `idx_messages_channel_author_time`. No new index was needed.
   - Result: 109 → 2.6 ms. Slowmode behaves the same: it uses the latest send time, as before.

5. **One `Intl.Segmenter` for the process** (`server/profile.js`).
   - `parseProfile` runs for every user in a member list or start-up data. It created a new segmenter each time, to
     count emoji in the profile effect.
   - Measured on its own: heavy start-up data 123 → 109 ms; join 74 → 62 ms; leave 40 → 33 ms.

6. **Member rows and key updates in one query each** (`userRows` and `emitKeyState` in `server/index.js`).
   - Start-up data and joins fetched each member's user row separately. Joining or leaving sent every connected
     member their key state with one query per member.
   - Both now read everything in one query. For key updates, that is limited to the connected members, through
     `idx_server_keys_user`.
   - Measured on its own: join 72 → 62 ms; leave 37 → 33 ms; heavy start-up data 115 → 109 ms.

EXPLAIN QUERY PLAN for the statements that changed. Before is v17; after is v18. Plans are the same with and without
data, because Hearth never runs ANALYZE.

| Statement | Before | After |
|---|---|---|
| `messages WHERE channel_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT ?` | `SEARCH messages USING INDEX idx_messages_channel (channel_id=?)` | `SEARCH messages USING INDEX idx_messages_channel_top (channel_id=?)` |
| same with `AND id < ?` | `… idx_messages_channel (channel_id=? AND id<?)` | `… idx_messages_channel_top (channel_id=? AND id<?)` |
| `messages WHERE channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 50` | `SEARCH messages USING INDEX idx_messages_channel_author_time (channel_id=?) \| USE TEMP B-TREE FOR ORDER BY` | `SEARCH messages USING INDEX idx_messages_pins (channel_id=? AND pinned_at>?)` |
| `dm_messages WHERE dm_id = ? AND pinned_at IS NOT NULL …` | `SEARCH dm_messages USING INDEX idx_dm_messages_author_time (dm_id=?) \| USE TEMP B-TREE FOR ORDER BY` | `SEARCH dm_messages USING INDEX idx_dm_messages_pins (dm_id=? AND pinned_at>?)` |
| `COUNT(*) FROM messages WHERE created_at >= ? AND created_at < ?` | `SCAN messages USING COVERING INDEX idx_messages_channel_time` | `SEARCH messages USING COVERING INDEX idx_messages_created (created_at>? AND created_at<?)` |
| `COUNT(*) FROM dm_messages WHERE created_at >= ? AND created_at < ?` | `SCAN dm_messages USING COVERING INDEX idx_dm_messages_author_time` | `SEARCH dm_messages USING COVERING INDEX idx_dm_messages_created (created_at>? AND created_at<?)` |
| Slowmode: v17 `SELECT created_at … WHERE channel_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1` → v18 `SELECT MAX(created_at) … WHERE channel_id = ? AND author_id = ?` | `SEARCH messages USING INDEX idx_messages_channel (channel_id=?)` | `SEARCH messages USING COVERING INDEX idx_messages_channel_author_time (channel_id=? AND author_id=?)` |
| `perms.forServer`: all members' roles | (one `rolesOf` and one held-roles query per member and channel) | `SEARCH mr USING COVERING INDEX sqlite_autoindex_member_roles_1 (server_id=?) \| SEARCH m USING COVERING INDEX sqlite_autoindex_members_1 (server_id=? AND user_id=?)` |
| `emitKeyState`: wrapped keys of the connected members | (one query per member) | uses `idx_server_keys_user` for each id in the `json_each` list |

Other hot statements were checked and already use indexes: session lookup, the bootstrap queries, `serverCommon`,
`keyState`, reactions, `threadInfo`, the socket connect and the search queries (`npm run bench -- --plans` prints
them all). `test/quality.test.js` asserts the plans above.

### Tried and reverted

- **Permissions in one batch per server inside `/api/bootstrap`.** This used `perms.forServer(server, [me])`
  instead of `perms.base`/`perms.channel` per channel. It saves queries on paper, but measured on its own it was no
  faster: 109 vs 106 ms heavy, 58 vs 55 ms member list (p50, 3 runs each, within the noise). It was reverted.
  `serializeServer` keeps its optional `ev` argument, which `emitServer` uses.

### Not changed (findings left as they are)

- **Member list sorting.** `SELECT user_id FROM members WHERE server_id = ? ORDER BY joined_at` sorts in a temporary
  B-tree. That is about 1,000 rows for the big server, under a millisecond. An index wasn't worth its write cost.
- **`threadInfo`.** It counts a thread's replies and reads `MAX(created_at)` through `idx_messages_thread`. It reads
  the reply rows for `created_at`, which is about 1–2 ms for a 20,000-reply thread. It is left as is.
- **Payload size of `server:update` and start-up data.** A 1,000-member server's update is still about 60 KB per
  member: it carries all member ids and member roles. Delivering it to 1,000 sockets takes about 190 ms of writes
  and client decoding, even though the server now builds it in about 40 ms. Fixing this needs smaller (delta)
  updates in the protocol and the app, which is outside this server-only change.
- **Admin routes.** `/api/admin/servers` and other admin routes count messages per server with a join over all
  messages. They are rarely used and were not measured.

### Limitations

- The scale measured is the one in the dataset table: 2,000 users, one 1,000-member server, 520k messages, and
  1,000 concurrent sockets on one machine. Nothing larger was measured, so no claim is made for it.
- Clients, bench and server share 4 cores on a machine that was also running other work. That is why runs were
  repeated and alternated. Small differences (under about 20%, or a few milliseconds) are within the noise.
- Network latency is loopback only.
- The upgrade time is dominated by the pre-upgrade backup copy, which grows with the database file size.
- The dataset is synthetic. Profiles are short, there are no avatars, and there are few reactions per message.

## Frontend

_Filled in by the frontend part of this workstream._
