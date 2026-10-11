# What to build next

This is a research note from October 2026. It shows what Hearth has, what people moving from Discord, Slack,
Matrix or Revolt would miss, and what is half done. Three research passes fed it:

- an inventory of 105 existing features, each checked in the code;
- 59 competitor features, each checked against the code (present, partial or absent);
- 35 unfinished or deferred items from the docs and code.

A product review then ranked the candidates and spot-checked every pick in the code. Each pick is scored on value
to small self-hosted communities, adoption, effort in this codebase, fit with end-to-end encryption, and risk.

## Ranked picks

| # | Pick | Kind | Effort | Fit with end-to-end encryption |
|---|---|---|---|---|
| 1 | Android notifications after the app is swiped away (UnifiedPush over the existing Web Push path) | platform | M | Good: pushes never carry message text, and ntfy can be self-hosted |
| 2 | Incoming webhook URLs per channel, accepting Discord/Slack-style payloads (Uptime Kuma, Home Assistant, Grafana, CI) | quick win | S | Like bot posts: sealed at rest, labelled "not end-to-end encrypted" |
| 3 | Self-assignable roles (ping roles, pronoun and colour roles, opt-in channels) | quick win | S | Neutral: role membership is already server metadata |
| 4 | Moderator toolkit: disconnect, server-mute and move in voice; ban with message cleanup; bulk delete | quick win | M | Fine: deletion works on metadata; server mute is enforced by the apps |
| 5 | Signed server update zips with a pinned trust anchor (finding admin-11) | platform | M | Core: it protects the code that does the encryption |
| 6 | Link previews built by the sender inside the encrypted message (as Signal does) | big bet | M | Good: receivers never contact the linked site |
| 7 | Per-server audit log, then a report inbox for server moderators | quick win | M | Fine: metadata only, never message content |
| 8 | Recurring events (weekly game night) | quick win | S | Neutral: event text is already stored in plaintext on the server |
| 9 | Import from Discord: structure first (template link), emoji next, history last | big bet | L | Structure is metadata; imported history must be encrypted on the importer's device and labelled |
| 10 | Thread unread counts and a list of threads per channel | quick win | M | Fine: read markers are metadata |
| 11 | Disappearing messages per DM, group and channel | big bet | M | Very good fit; the limit is that the host does the deleting (and backups keep copies until they rotate out) |
| 12 | Android: keep calls alive when the phone locks (foreground service); open invite links in the app | platform | M | Neutral |

Suggested order:

1. Release A: picks 2, 3, 4 and 8, plus an Android push spike.
2. Release B: picks 5, 7 and 10, plus a device test for Android calls.
3. Then the big bets (6, 9 and 11), each as its own release with an honest-limits note in README and SECURITY.md.

## Already in Hearth (don't rebuild)

- Feeds into channels: the news bot handles RSS/Atom, YouTube, subreddits, Steam and GitHub releases.
- Announcement channels: the one-click read-only override.
- A basic stage: listen-only voice through the Speak permission.
- Moderation: slow mode, and timeouts that survive rejoining.
- Invites: they can expire and have a use limit.
- Events: RSVP, reminders and .ics export.
- Messaging:
  - polls with encrypted questions;
  - encrypted voice messages;
  - forwarding, spoilers, pins with history;
  - saved messages synced across devices.
- Notifications: per-place levels, mute timers and quiet hours, all synced.
- Search (Ctrl+K) with filters.
- Unread state and drafts across devices.
- Calls and media:
  - screen share with audio;
  - push-to-talk with global hotkeys;
  - picture-in-picture;
  - automatic call rejoin;
  - call diagnostics;
  - watch together.
- Organising and media: server folders, custom and animated emoji, and a self-hosted GIF library.
- Bots: slash commands and signed outgoing webhooks.
- Account and privacy:
  - Export my data;
  - 2FA, recovery key, safety numbers;
  - hiding DMs while screen sharing.
- Group chats of up to 25 people.
- A manual "Away" status.

## Not recommended, and why

- **Server-side AutoMod or content scanning.** It would need the server to read end-to-end encrypted text. Only a
  client-side word list that hides messages on each reader's device is compatible.
- **Federation, or Matrix/Discord bridges.** A bridge must decrypt to relay messages, which drops end-to-end
  encryption. It is also XL work with a large attack surface.
- **An SFU for big calls, or Go Live, before media E2EE.** Without SFrame (VOICE.md stages 2–4) the media server
  hears everyone.
- **A native iOS app now.** It needs a paid Apple account, CallKit and APNs work. The PWA already gets push on iOS
  16.4 and later.
- **Postgres, multiple processes, S3 storage.** They add operational burden for one-VPS operators. Delta server
  updates are the better scaling lever.
- **Public server discovery.** It invites raids, and small private communities don't want to be listed.
- **Read receipts on by default.** That runs against the privacy stance. If they are ever added, they should be
  opt-in, mutual and DM-only.
- **Server-side translation, transcription or summaries.** They need plaintext or third-party services.
- **Passkeys replacing passwords.** The password unwraps the identity key, so this needs the WebAuthn PRF
  extension. Passkeys could come first as a second factor.
- **Encrypted reactions, forum/stage channel types, all-at-once translation of the UI, call recording,
  soundboard.** Too costly for their value here.

## Docs that contradicted the code (fixed with this note)

- **README:** group DMs hold 25 people, not 10. Saved messages and notification settings sync to the account;
  they are not browser-only.
- **SECURITY.md §4:** calls now rejoin after short drops, and the server has an access log.
- **The comment above `leaveVoice` in server/index.js** described the removed "study together" timer.

## Progress

The work log for the picks above is kept in [ENGINEERING-REPORT.md](ENGINEERING-REPORT.md) as they land.
