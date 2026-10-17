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
| 11 | Disappearing messages per DM, group and channel | big bet | M | Very good fit; the limit is that the host does the deleting (and backups keep copies until they rotate out). **Built** (schema v19, see FEATURES.md §7); leaving them out of backups, the export checkbox and the Android notification timeout are still to do |
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
- Per-server nicknames (Change Nickname and Manage Nicknames), shown only inside that server.
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
- "Away": picked by hand, or automatic after 5–30 minutes without input on every device; custom statuses that
  clear themselves.

## Not recommended, and why

- **Server-side AutoMod or content scanning.** It would need the server to read end-to-end encrypted text. Only a
  client-side word list that hides messages on each reader's device is compatible, and that is what Hearth has (the
  word filter in 1.29: your own encrypted list, plus a server's suggested list members can turn off; FEATURES.md).
  It can't block a message from being posted, and shouldn't pretend to.
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

## Design documents

Build-ready designs for the larger picks, each grounded in the current code (with sources for outside facts):

- [design/ANDROID-PUSH.md](design/ANDROID-PUSH.md): notifications when the Android app is closed. UnifiedPush
  delivers the Web Push the server already sends; no schema change; effort L.
- [design/DISAPPEARING-MESSAGES.md](design/DISAPPEARING-MESSAGES.md): timers per DM, group and channel; effort L.
- [design/LINK-PREVIEWS.md](design/LINK-PREVIEWS.md): previews built by the sender inside the encrypted message;
  effort M.
- [design/DISCORD-IMPORT.md](design/DISCORD-IMPORT.md): import a Discord server's structure, then emoji, then
  history. Whether Discord serves template links without a login couldn't be checked from the research
  environment, so the design falls back to pasting the template JSON.

## Progress

The work log for the picks above is kept in [ENGINEERING-REPORT.md](ENGINEERING-REPORT.md) as they land.

- Getting it to people ([GROWTH.md](GROWTH.md)): the server is published as a multi-arch image
  (`.github/workflows/hearth-image.yml`, `deploy/compose.image.yml`), with app store templates in
  `deploy/catalogs/` and a "Hearth vs Discord" page on the landing site (SECURITY.md rows 154–155). Left: publishing the
  first image and submitting to each store after a test install there.

- Pick 9, phase 1 (structure) is in: **Add a server → Import from Discord** takes a pasted server template and
  shows everything that won't come over before creating ([IMPORT.md](IMPORT.md)). Hearth doesn't fetch template
  links itself yet: whether Discord serves them without a login is still unconfirmed. Left: that server-side
  fetch (through `server/netguard.js`) or a bot-token export script, then emoji (phase 2) and history (phase 3).

- Picks 1 and 12 (Android): notifications with the app closed through UnifiedPush, calls kept going with a
  `microphone` foreground service, and invite links (`hearth://` and verified `https://`) are built (server, page,
  native code, CI). Waiting on a device test (mobile/README.md, "Not yet tested on a device") before an `app-v*`
  release. Left for later: the optional built-in Google push flavour, "dismiss" pushes for notifications read
  elsewhere, and signed payloads (docs/design/ANDROID-PUSH.md §15, §16.2).

- The runners-up are built (schema v19; FEATURES.md, SECURITY.md rows 114–127): drag-and-drop channels and
  categories (Move up / Move down from the keyboard), automatic Away and custom statuses that clear themselves, text
  chat in voice channels, scheduled messages (Send later) and per-server nicknames. Notable limits: categories are
  labels, not locks; Away reaches everyone on the instance as it happens, and in a browser only input in a Hearth
  tab counts; everyone who can see a voice channel can read its chat, and the upgrade carries over only per-channel
  limits on posting; the server holds scheduled messages until their time and is trusted with it, and Export my
  data leaves out ones not sent yet; nicknames aren't in search's `from:` or bot events yet, and display names
  don't drop invisible characters the way nicknames do.

- The batch-5 audit findings are in (1.29.0; SECURITY.md rows 128–138). Fixed: auth-6 (a fresh two-factor code for
  every sensitive change, with a one-time step-up ticket for two-step ones), auth-11 (a new sign-in token on a
  password change, turning on two-factor and "Log out all other devices" with the password), xss-8 (fonts served
  by Hearth, outside images and watch-together video files wait for a click) and data-4 (pre-upgrade copies pruned
  to `PRE_UPGRADE_KEEP`). Partly fixed: xss-7 (the security policy no longer names Google Fonts or allows blob:
  frames), files-6 (GIF comments and profile songs' tags stripped), files-10 (server-signed per-picture links for
  news, webhook avatars and album art, so `/media/news` is no longer an open proxy; webhook avatars only from known
  hosts or `WEBHOOK_AVATAR_HOSTS`) and crypto-2 (an account reset without its recovery key is held out of key
  sharing, invites and group adds until a member who knew them vouches, or an admin clears it with their password
  and a fresh code). Left ([ENGINEERING-REPORT.md](ENGINEERING-REPORT.md) §5): pictures and media still load from
  any https: site after a click; someone who follows a feed they host still picks what the news proxy fetches, and
  GIF proxy links aren't signed; OGG songs and earlier uploads keep their metadata; pre-upgrade copies aren't
  encrypted; a reset account's DMs and calls still rely on first-use trust, resets before 1.29.0 aren't marked, and
  an admin whose every server holds an attacker's second account can still be cleared by those accounts.

- The batch-6 items are in (1.29.0; SECURITY.md rows 139–151). Partly fixed: crypto-7 (each new message carries its
  own id, reply, thread, send time and edit count inside its encryption, and readers' apps flag one the server
  moved, re-dated, showed twice or rolled back; Send now and Reschedule re-encrypt so the time inside is the real
  one) and crypto-13 (a server setting, off by default, "New members can't read messages from before they joined":
  every join replaces the key and nothing from before is served to the newcomer). Also built: a word filter that
  only ever runs in each reader's app (your own list end-to-end encrypted, plus a server's suggested list members can
  turn off), and alert channels for owners (ntfy, a signed webhook, Discord, Slack) with a Prometheus `/metrics`
  behind `METRICS_TOKEN`. Left ([ENGINEERING-REPORT.md](ENGINEERING-REPORT.md) §5, §14): the binding is detection,
  not prevention, and messages from older apps, bots and webhooks carry none of it; a rollback is caught only on a
  device that saw the newer edit, and the server's clock can shift message times by up to a day; the history
  setting is the server's to enforce, deletions still name older messages' ids to newcomers, and file blobs aren't
  padded; the word filter can't stop anything being posted and can be spelled around; alerts aren't retried, and a
  webhook channel keeps its signing secret when its address changes.

- Growth, without discovery or tracking (1.29.0; FEATURES.md "Invite links that unfurl", SECURITY.md row 153): invite
  links unfurl in Discord, Reddit, X and texts, and the sign-in screen says what a link is for. Both say only "a
  server on *instance*" unless the server opts in to its name and member count. A new or imported server opens its
  invite link straight away, with a message to copy, Share on phones, a moving announcement for Discord imports, and
  an "It's just you here" card. Left: server icons in cards (through a short signed link, like files-10's), and an
  admin option letting a valid server invite also allow sign-up on code-only instances (needs its own security review).
