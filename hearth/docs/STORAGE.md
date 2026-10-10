# Files, attachments and media storage

How Hearth stores files: the upload pipeline, its limits, the resumable upload protocol, downloads, retention
and cleanup, backups, and what the server can and can't see. Paths are relative to `hearth/`.

Code: `server/storage.js` (resumable uploads, reports, cleanup), `server/index.js` (one-request uploads, quotas,
`/uploads/` serving, deletion paths), `public/js/files.js` (the app's upload and download helpers),
`public/js/app.js` (composer and attachments), `public/js/settings.js` and `public/js/admin.js` (Storage pages).
Tests: `test/storage.test.js`, plus `test/files-hardening.test.js` for the older upload rules.

## 1. What the server can and can't see

| | Server sees | Server never sees |
|---|---|---|
| Attachments (E2EE) | that a blob exists, its size, who uploaded it, when, and which message (so which channel/DM) it is attached to | its contents, name, type, dimensions, its key |
| Uploads in progress | declared size, bytes received so far, timestamps, the SHA-256 of the ciphertext | anything about the plaintext |
| Public media (avatars, banners, icons, emoji, profile songs, GIF library) | everything: these are stored as uploaded (pictures have their metadata stripped first) | |

Every attachment is encrypted in the app with its own random AES-256-GCM key before upload (`E2EE.encryptFile`:
`blob = iv(12) ‖ ciphertext ‖ tag(16)`). The key, name and type travel inside the encrypted message (`f[]`).
The server only links blob names to message ids (`blobs` table) so that deleting a message deletes its files.

Names, types and sizes the app shows come from the encrypted message. Settings → Storage shows names only for
files in conversations the device can open; the server's `/me/storage/files` returns sizes, dates and locations.

## 2. Upload pipeline

```
 app: pick file → resize/re-encode pictures (media.js) → encrypt (e2ee.js)
        ├── ciphertext ≤ 8 MB ─► POST /api/upload/encrypted        (one multipart request, multer)
        └── ciphertext > 8 MB ─► POST /api/uploads → PUT …?offset=N … → POST …/complete   (resumable)
                                                         │
 server: rate limits → quota / daily / per-file checks → file in data/uploads/<id>.bin
         + user_files row (quota) + blobs row (message_id NULL)
 app: POST message { ciphertext, files: [urls] } → attachBlobs links the blobs to the message (uploader only)
```

Both paths end in the same state: a `.bin` in `data/uploads/`, a `user_files` row (kind `attachment`) and an
unattached `blobs` row. Old apps keep using the one-request route; it isn't going away.

### Limits

| Limit | Default | Where |
|---|---|---|
| Largest file in a message (`fileMb`) | `MAX_UPLOAD_MB` (25) + 1 MB for encryption overhead | Admin → Security → Storage & limits; supporters may get more (Admin → Money) |
| Storage per person (`quotaMb`) | 1000 MB | same; per-person override on the user's admin page |
| Uploads per person per day (`dailyMb`) | 500 MB | same |
| Admins and the owner | no quota or daily limit (the per-file limit still applies) | |
| Unfinished resumable uploads per person | 4 | `MAX_SESSIONS` in `server/storage.js` |
| Chunk size | 4 MiB (`UPLOAD_CHUNK_BYTES`) | returned by `POST /api/uploads` |
| Idle time before an unfinished upload expires | 24 h (`UPLOAD_SESSION_IDLE_MS`) | |
| Sweep of expired uploads | every 10 min (`UPLOAD_SWEEP_MS`) | |
| Disk reserve | a session is refused (507) if it would leave less than 64 MB free | |

Rate limits (per minute unless noted): start an upload 20 per person (200 per hour) and 100 per network;
chunks 600 per person, 600 per session, 1200 per network; status 240; finish 60; cancel 120. The one-request
route keeps its own limits (60/min, 600/h per person, 40/min per session, 150/min per network, 4 at once).

## 3. Resumable upload protocol

All routes need a signed-in session. A session belongs to the account that started it: for anyone else every
route answers **404**, the same as for a session that doesn't exist (an admin included; admins have their own
tools, below).

| Request | Answer | Notes |
|---|---|---|
| `POST /api/uploads` `{ size }` | `{ id, size, received: 0, chunkSize, createdAt, updatedAt, expiresAt }` | `size` in bytes of the ciphertext. 400 bad size, 403 uploads blocked, 413 `too_big` / `quota` (per-file, storage or daily), 429 `too_many_uploads`, 507 `disk_full`. The full size is **reserved** at once. |
| `PUT /api/uploads/:id?offset=N` | `{ received, size }` | Body `application/octet-stream` (else 415). `N` must equal what the server has (else **409** `offset_mismatch` with `received`). At most `min(chunkSize, size − received)` bytes (else **413** `chunk_too_big`, checked from `Content-Length` before reading and again while reading; nothing of the chunk is kept). Empty chunk 400. One request per session at a time (409 `busy`). If the connection drops mid-chunk, the bytes that arrived are kept and `received` says so. |
| `GET /api/uploads/:id` | the session | Where to carry on. |
| `GET /api/uploads` | your unfinished uploads | Settings → Storage. |
| `POST /api/uploads/:id/complete` `{ sha256 }` | `{ url: "/uploads/<name>.bin", size }` | 409 `incomplete` until every byte is there. The server hashes the part file; a mismatch is **400** `hash_mismatch` and the session is removed (reservation released). On a match the part file is **renamed** into `data/uploads/` (one atomic rename on the same filesystem) and, in one transaction, the reservation row becomes the file's `user_files` row and a `blobs` row is added. |
| `DELETE /api/uploads/:id` | `{ ok: true }` | Cancels: aborts a chunk in flight, deletes the part file, releases the reservation. 409 while it is finishing. |

**Reservation.** The room a session needs is a `user_files` row (kind `reserved`, name `upload-<id>`), so every
existing quota check (`quotaOf`, `overLimit`, the one-request route) already counts it, and uploads started at the
same time can't share the last of the quota: the check and the reservation run with no `await` in between.

**Where the bytes wait.** `data/upload-parts/<id>.part` (folder mode 0700). It is outside `data/uploads/`, so a
partial file is never served by `/uploads/` and is never visible as a blob.

**Expiry.** A sweep (1 s after start, then every `UPLOAD_SWEEP_MS`) removes sessions idle for
`UPLOAD_SESSION_IDLE_MS`, sessions whose part file is missing (for example after a restore), part files without
a session (older than a minute), and `reserved` rows without a session. A session busy with a request is never
swept. Sessions survive a server restart; on the next chunk anything past `received` is truncated first.

**Account and admin actions.** Deleting an account and Admin → "Delete all their files" cancel the person's
unfinished uploads too.

**The app** (`public/js/files.js` `uploadResumable`): computes the SHA-256 of the ciphertext, starts a session,
sends chunks with progress, and on a network error, timeout, 5xx or 429 waits (1, 2, 4 … 30 s; `Retry-After` on
429; waits for the browser to be online), asks `GET /api/uploads/:id` where to carry on, and continues. It gives up
after 10 tries in a row without progress. Cancel (composer) aborts and sends `DELETE`. A failure also sends
`DELETE`, so the room comes back at once. The ciphertext lives in memory for the page's lifetime: a reload starts
the file again (the abandoned session expires by itself).

## 4. Downloads

`GET /uploads/:file` (no sign-in, see below):

- **Range requests**: `Accept-Ranges: bytes`, `206 Partial Content` with `Content-Range`, suffix ranges
  (`bytes=-N`), and **416** with `Content-Range: bytes */<size>` for ranges past the end (a malformed range header
  may get 200 or 416). Videos and songs can seek without downloading everything first.
- **Caching**: encrypted blobs (`.bin`) are `Cache-Control: private, no-cache` with an `ETag`: browsers check back
  every time (a cheap 304), so a deleted file stops loading at once. Other uploads change name whenever they change,
  so they are `private, max-age=31536000, immutable`. `private` keeps shared proxies from storing either.
- **Headers kept**: `X-Content-Type-Options: nosniff`, a sandbox CSP, `Cross-Origin-Resource-Policy: same-origin`;
  `.bin` and unknown types are `application/octet-stream` with `Content-Disposition: attachment`.
- **Deleted files are 404 every way**: plain, Range, `If-None-Match`, and `HEAD`, for the file and its thumbnail
  (a separate blob attached to the same message). Unfinished uploads have no URL at all.

**Why no sign-in for `/uploads/`.** Blob names are random (an 88-bit random part plus a timestamp) and only
appear inside encrypted messages; the content is ciphertext whose key is only in the message. A sign-in check
would add no confidentiality and would break `<img>`/`<video>` loading (the app uses bearer tokens, not cookies).
Public media is meant to be public. This is a deliberate choice; revisit it if non-E2EE private files are ever added.

**The app** (`download` in `files.js`) streams the response with progress, carries on with a Range request after
a dropped connection (3 tries), and turns a 404/410 into "This file is no longer available".

## 5. Media in the app

All decryption happens in the app; the server only ever sends ciphertext.

- **Pictures**: thumbnail first (when the sender made one), full size on demand. Clicking opens the gallery: every
  picture in the conversation's loaded messages, ← → keys and buttons, wraps around, zoom, download, copy image.
- **Video and audio**: played from a decrypted `blob:` URL with the browser's controls. Encrypted videos and songs
  over 20 MB show "Play video · size" and download (with a progress bar) only when pressed.
- **Other files**: a card with the name, size, kind ("PDF document", "ZIP archive", "XYZ file"), "Encrypted"
  badge and Download (with a percentage for big files). "Copy link" appears only for unencrypted files from older
  messages: an encrypted file's link leads to ciphertext, useless without the key in the message.
- **Gone files**: "This file is no longer available" in place of a retry button.
- **Memory**: decrypted copies are kept in a cache of up to 256 MB (`makeUrlCache`); the least recently used are
  revoked (`URL.revokeObjectURL`) unless something on screen still shows them; everything is released on sign-out.

## 6. Retention: what happens to files when…

| Event | Files | Quota |
|---|---|---|
| A message is deleted (by its author, a moderator, or an admin) | Its attachments and thumbnails are deleted at once (`deleteMessageTree` / `forgetMessages` → `removeMessageFiles`), files after the rows commit | Freed |
| A channel is deleted | Every message's files are deleted | Freed |
| A server or group is deleted (or a group's last member leaves) | Every message's files, plus the server's icon, banner, background and emoji (`purgeServerContent`) | Freed |
| A member leaves, is kicked or banned | Nothing: the files they posted stay with the conversation | Still counts against the uploader |
| An account is deleted | Avatar, banner, background, profile song and page background are deleted; unfinished uploads are cancelled. Messages they sent stay (still encrypted) with their attachments | Profile files freed; attachments stay counted to the deleted account |
| A file is uploaded but never posted | Removed after 24 h (hourly sweep) | Freed |
| An upload is never finished | Removed after 24 h idle (sweep every 10 min) | Reservation freed |
| An admin uses "Delete all their files" | Everything they uploaded, attachments included (messages remain and show "no longer available"), their library GIFs, unfinished uploads | Freed |
| A message is forwarded | The copy points at the same blobs; if the original is deleted, the copy's files show "no longer available" | Counted once, to the uploader |

Leftovers from before these rules existed (blobs whose message is gone) are swept once shortly after start and
daily (`sweepOrphans`).

## 7. Storage report and orphan cleanup (Admin → Security → Storage & limits)

`GET /api/admin/storage/report` (admins and the owner; 30 per 10 min): total use; top people; top servers (sum of
the attachments of messages in each server's channels) and direct messages; files uploaded but not posted yet;
unfinished uploads (who, how far, when they expire); free and total disk; and a **dry run** of orphans.

**What counts as referenced** (`references` in `server/storage.js`), built from the database, never from names
or guesses:

1. blobs whose message exists (channel or DM), and unattached blobs younger than max(grace, 24 h);
2. every GIF library file;
3. every `/uploads/<name>` written in any text column of any other table (avatars, banners, songs, server icons and
   themes, emoji, profile pages, settings, …), so a future feature that stores a picture is covered automatically;
4. the attachment lists inside older server-encrypted messages and news bot posts (opened with the server key),
   and their raw text for very old plain-text bodies.

An **orphan** is a file in `data/uploads/` that none of these reference and whose last change is older than the
grace period (default 24 h, at least 1 h). Also reported: quota rows for files no longer on disk, and blob rows
whose message is gone or that were never posted in time. Unfinished uploads are never orphans (they're not in
`data/uploads/`).

`POST /api/admin/storage/cleanup` `{ authKey, totp?, graceHours? }`: admins and the owner, **step-up** (password,
and a two-factor code when it's on), 10 per hour, **audit-logged** (`storage_cleanup`, with counts and bytes). The
list is worked out again at that moment, with no `await` between finding and deleting, so nothing that gained a
reference meanwhile is touched. If any sealed message body can't be opened with this server's key
(`unverifiable`), cleanup refuses (409) and deletes nothing, because the files those messages use can't be known.

## 8. Settings → Storage

`GET /api/me/storage` (totals, limits) and `GET /api/me/storage/files` (your 50 biggest files: size, date, kind,
and where they were posted; your unfinished uploads). The app fills in names from the messages it can open
(fetching the message if needed), shows "Encrypted file" otherwise, has "Show" to jump to the message and Cancel
for unfinished uploads. Settings → Security & storage keeps the short summary.

## 9. Backups

The encrypted backup (`server/backup.js`) packs the database snapshot, `secret.key`, `vapid.json` and every regular
file directly in `data/uploads/`. So:

- **finished blobs are included** (they are in `data/uploads/`);
- **unfinished uploads are not** (they are in `data/upload-parts/`, which the backup never reads);
- the restored database still has the `upload_sessions` rows, but their part files aren't there, so the first
  sweep after starting removes them and frees the reserved room.

`scripts/hearth-update.sh` likewise leaves `upload-parts/` out of its pre-update data snapshot. Proven by
`test/storage.test.js` › storage-13 (a real backup restored with `cli.js restore`).

## 10. Measured (this machine, localhost, no TLS)

- 200 MB uploaded in 50 chunks of 4 MiB: about 1.0 s (about 200 MB/s); `complete` (SHA-256 of 200 MB + rename):
  about 0.7 s.
- Storage report with 5,000 extra files and blob rows: 40–50 ms.

## 11. Known limits

- The app encrypts a file whole (the existing `iv ‖ ct` format, so older apps can still open it), so the whole
  ciphertext is in memory while it uploads, and a page reload means starting over. Streaming encryption would need a
  new file format.
- Download progress for an encrypted file covers the download; decryption then runs in one step.
- A `complete` whose answer is lost on the way back is retried and gets 404 (the upload did finish): the app reports
  a failure and the finished but unposted blob is removed after a day.
- Per-server totals count attachments only (not the server's icon, banner or emoji), and only messages still there.
- The cleanup's reference scan reads every text column of every table and opens every server-encrypted message, so it
  is linear in the database size (fine at the sizes measured above; it is admin-triggered and rate-limited).
- Rate limits and the "busy" lock are in memory: a restart resets them (sessions themselves persist).
