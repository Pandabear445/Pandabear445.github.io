# Hearth security overhaul: engineering report

This report covers the October 2026 security audit of Hearth 1.27.1 and the fixes that followed: what was found,
what was changed, how each change is proven, what was left for later and why, and what is still risky. It only
claims what was observed. Every result below carries one of these labels:

| Label | Meaning |
|---|---|
| **implemented** | The code is in the branch. Nothing more is claimed. |
| **tested locally** | A test that exercises it passed in this working copy (Linux container, Node 22.22.0), in the run reported in §6. |
| **tested in CI** | A GitHub Actions run on the pushed branch passed the job that covers it (run ids in §6). |
| **not verified** | Nobody in this effort observed it working; it may be fine, but treat it as unproven. |

Windows and Android builds were **not** run in this container (it has no Wine and no Android SDK). They were built
only by GitHub Actions (§6).

## 1. Baseline

The audit started from commit `c55a9dc` (Hearth 1.27.1, merged as "Add Hearth: self-hosted chat platform with E2E
encryption").

- **Tests:** 111 tests, 111 passing, 0 failing, across 12 test files (`npm test`, 161 s). This is the audit's own
  baseline run, kept with the audit notes; the GitHub Actions run on the same code (`4603d99`, run 38034561400)
  also passed. *Tested locally* (by the audit, not re-run for this report) and *tested in CI*.
- **Dependencies:** `npm audit` reported 0 vulnerabilities. The server's `package.json` and `package-lock.json` are
  unchanged since the baseline, and `npm audit` on today's tree still reports **0 vulnerabilities** (observed while
  writing this report, both the full audit and `--omit=dev --audit-level=high`).
- **Syntax:** the baseline syntax checks passed (audit notes). Re-run on today's tree: `node --check` on all 98
  JavaScript files in `server/`, `public/`, `desktop/`, `scripts/`, `tools/`, `mobile/www/` and `test/` passes,
  and `bash -n` passes on `hearth-update.sh`, `make-update-zip.sh`, `setup-turn.sh`, `harden-vps.sh` and
  `tools/update-hearth.sh`.
- **Routes:** 242 HTTP routes and 13 Socket.IO events at the baseline; 248 and 13 now (see [ROUTES.md](ROUTES.md)).

## 2. Method

1. **Map.** The code was split into 11 audit areas: accounts and sessions (`auth`), end-to-end encryption
   (`crypto`), server/channel/role authorization (`authz`), uploads and files (`files`), outbound requests
   (`ssrf`), calls and realtime (`voice`), admin and owner tools (`admin`), client rendering (`xss`),
   infrastructure/desktop/CI (`infra`), platform (`platform`) and the data layer (`data`). Each area got
   architecture notes and an annotated route inventory (the source of [ROUTES.md](ROUTES.md)).
2. **Audit.** Each area was audited against the code and against the claims in README.md, SECURITY.md and the
   landing page. 127 findings were recorded, each with locations, a scenario, a suggested fix and a suggested
   regression test.
3. **Adversarial verification.** A separate verifier re-read every finding against the code and tried to break the
   claim. 126 findings carry a "confirmed" verdict (one, `voice-15`, was added during verification and has no
   separate verdict). 94 verdicts come with a proof-of-concept test that reproduced the problem against a real
   server or the real client code; the rest were confirmed by reading code or documents. Eleven severities were
   lowered by the verifier (for example `files-1`, `ssrf-1`, `platform-1` from high to medium); the table uses the
   verified severity.
4. **Ten fix batches**, one per area group: `auth`, `authz`, `files`, `outbound` (ssrf and push), `voice`, `admin`,
   `client` (xss and desktop/Android), `infra`, `data`, `crypto`. Each batch was implemented on its own branch with
   new tests that fail on the baseline, and the full suite was run on it.
5. **Independent review and revise.** Each batch was reviewed by someone who hadn't written it (blocker, major and
   minor issues). Nine batches had a revise round that addressed the review (`overhaul/<batch>-r` branches). The
   `voice` review found no blockers or majors (five minors), and that batch was merged without a revise round.
6. **Merge integration.** The batches were merged in order onto the integration branch (after the separate
   search change, `d85e259`). Integration commits fixed cross-batch conflicts: `e40a88a` (the CLI owner change uses
   the keyed audit chain; tests send step-up passwords), `c3f4ad5` (tests send the password to delete a server;
   the authz tests allow a local push service), `4ce2d6c` (closed a v17 index block left open by a merge), and
   `47fb2b5` (tests aligned with each other's new rules: region creation needs the password, signing keys need
   proof, the CI copy step lists `.sig` files, a 300k-row timing test writes in chunks). `SCHEMA_VERSION` was
   bumped once, to 17.
7. **Documentation** (this commit): every user-facing security and encryption claim was checked against the merged
   code and corrected (§7).

| Batch | Implementation | Review | Revise round | Findings fixed (in full or part) |
|---|---|---|---|---|
| auth | `8747909` | 3 major, 4 minor | `ac218cb` | 11 |
| authz | `783823d` | 1 blocker, 1 major, 8 minor | `86c1f37` | 14 |
| files | `bdf3acd` | 1 major, 3 minor | `69705d9` | 12 |
| outbound | `562587c` | 2 major, 4 minor | `4d1bc4d` | 6 |
| voice | `7faf954` | 5 minor | none | 14 |
| admin | `dde6609` | 3 major, 4 minor | `6288f4a` | 13 |
| client | `d0dcbc9` | 1 blocker, 1 major, 3 minor | `b86d5a7` | 10 |
| infra | `c61dae5` | 3 major, 6 minor | `7532dd0` | 8 |
| data | `aaec1f6` | 2 major, 4 minor | `2682d70` | 9 |
| crypto | `3933a34` | 1 blocker, 3 major, 4 minor | `7f106a6` | 9 |

(The last column counts findings closed by that batch, in full or part: 106 in all. A batch also fixed findings
from other areas, e.g. `auth` fixed `admin-1` and `admin-3`. The 18 documented and 3 deferred findings belong to no
batch.)

## 3. Results at a glance

| Status | Count | Meaning |
|---|---|---|
| Fixed | 78 | The problem is closed in code and a test proves it. |
| Partly fixed | 28 | The confirmed problem is closed; a remaining part was deferred (§5). |
| Documented | 18 | No code change: the docs now say what the code does (overclaims corrected, limitations stated). |
| Deferred | 3 | Not changed; documented as a limit (`auth-11`, `crypto-7`, `admin-12`). |
| **Total** | **127** | |

By severity: 8 high (6 fixed, 2 partly fixed), 47 medium (36 fixed, 10 partly fixed, 1 documented), 67 low (35
fixed, 14 partly fixed, 15 documented, 3 deferred), 5 info (1 fixed, 2 partly fixed, 2 documented). By kind: 40
vulnerabilities, 38 bugs, 19 overclaims, 14 limitations, 13 hardening, 3 performance.

All fixes are **implemented**. Every fixed or partly fixed finding with a proving test below is **tested locally**
(§6: 357 of 358 tests passed, 1 skipped) and **tested in CI** in the `tests` job at `dec63ee`, except the parts
§6 lists as skipped or not run there.

## 4. Findings

"Proving test" names the test file whose tests cover the fix (test titles start with the finding id where
practical; [SECURITY.md](../SECURITY.md) names the individual tests). For documented and deferred findings it names
where the docs now state the behaviour.

### Accounts and sessions (auth, 13 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| auth-1 | high | vulnerability | A freed ADMIN_USERS username can be registered by anyone and grants instance admin | Fixed | `auth-hardening.test.js` |
| auth-2 | medium | vulnerability | Per-account login limits are consumed before captcha and password check, so anyone can lock a user out of sign-in | Fixed | `auth-hardening.test.js` |
| auth-3 | medium | vulnerability | Instance-wide sign-up, sign-in and reset counters are consumed by captcha-less requests (cheap DoS for everyone) | Fixed | `auth-hardening.test.js` |
| auth-4 | medium | bug | Outstanding password-reset links survive password change, email change and email removal | Fixed | `auth-hardening.test.js` |
| auth-5 | medium | limitation | Any session token, including a stolen one, can fetch the password-wrapped identity key and its salt for offline password guessing | Fixed | `crypto-hardening.test.js` |
| auth-6 | low | overclaim | Docs promise a fresh 2FA code for sensitive changes, but stepUp skips it for 10 minutes after any 2FA sign-in | Documented | — (SECURITY.md row 6, §4) |
| auth-7 | low | bug | Push subscriptions are not tied to sessions: logged-out, revoked, password-changed and suspended devices keep getting notifications | Fixed | `outbound-hardening.test.js` |
| auth-8 | low | bug | IP bans don't stop existing sessions over HTTP, and /auth/reset hands banned IPs a fresh session | Fixed | `auth-hardening.test.js` |
| auth-9 | low | bug | Legacy PBKDF2 accounts: enumerable through /auth/params, and a full password change through the 'upgrade' flag skips revocation, audit log and email notice | Partly fixed | `auth-hardening.test.js` |
| auth-10 | low | vulnerability | POST /me/email reveals whether an address belongs to another account | Fixed | `auth-hardening.test.js` |
| auth-11 | low | hardening | The current session token is never rotated, so a copy of it survives password change, 2FA enable and 'log out other devices' | Deferred | — (SECURITY.md row 7, §4) |
| auth-12 | low | bug | Any server-initiated socket disconnect makes the client revoke its own session and wipe its keys | Fixed | `voice-hardening.test.js` |
| auth-13 | low | hardening | The 7-day media token in /bootstrap isn't bound to a session and outlives logout, suspension and account deletion | Fixed | `auth-hardening.test.js` |

### End-to-end encryption (crypto, 13 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| crypto-1 | high | bug | Server-channel history is lost for good when the member who handed out a key deletes their account or resets without a recovery key | Fixed | `crypto-hardening.test.js` |
| crypto-2 | medium | overclaim | An attacker who controls only the victim's email (no 2FA) can read the victim's servers and groups, but the docs say 'not its messages' | Documented | — (SECURITY.md row 10, §4; README) |
| crypto-3 | medium | bug | Any member can rotate the server key without limit and with junk key bundles: blocks sending and grows storage without bound | Partly fixed | `crypto-hardening.test.js` |
| crypto-4 | medium | bug | After someone deletes their account, the other person can no longer read any of their DMs, and all their channel messages show 'could not be verified' | Fixed | `crypto-hardening.test.js` |
| crypto-5 | low | overclaim | The server alone decides the key epoch: a key handoff from a non-member is accepted, rotation can be suppressed or rolled back, and the 'watch the member list' advice doesn't hold | Partly fixed | `crypto-hardening.test.js` |
| crypto-6 | low | overclaim | The server can post plaintext 'legacy' channel messages as any member; they are shown as verified with only an 'Older message' label | Fixed | `crypto-hardening.test.js` |
| crypto-7 | low | overclaim | Ciphertext isn't bound to message id, reply, thread, time or edit version: the server can replay, re-thread and undo edits | Deferred | — (SECURITY.md §1, §4; README) |
| crypto-8 | low | hardening | /bootstrap gives any session the password-wrapped identity key and its salt, and there is no way to rotate the identity key after a compromise | Partly fixed | `crypto-hardening.test.js` |
| crypto-9 | low | overclaim | The server learns which GIFs people send and view in end-to-end encrypted chats | Documented | — (SECURITY.md §4; README (GIFs)) |
| crypto-10 | low | bug | Recall sync stops at 5000 items; on a new device this can overwrite the study profile and delete pictures | Fixed | `data-hardening.test.js` |
| crypto-11 | low | hardening | Signing-key upload has no proof of possession, and contacts silently pin a first signing key | Partly fixed | `crypto-hardening.test.js` |
| crypto-12 | low | overclaim | README and landing-page claims are stronger than SECURITY.md and the code ('not even the person hosting it', 'none of it passes through your server') | Documented | — (README, index.html, SECURITY.md §4) |
| crypto-13 | info | limitation | Joining never rotates the key: new and re-joining members read the current-epoch backlog, including a kicked member who comes back with an old invite | Partly fixed | `crypto-hardening.test.js` |

### Server, channel and role authorization (authz, 16 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| authz-1 | high | bug | Kick, ban and leave keep a member's roles and channel overrides; rejoining with any invite restores Administrator | Fixed | `authz-hardening.test.js` |
| authz-2 | high | vulnerability | Manage Roles can rewrite overrides on a private channel it can't see, granting itself access or locking out higher roles | Fixed | `authz-hardening.test.js` |
| authz-3 | medium | bug | Manage Channels works on private channels the holder can't see; channel-level denies of Manage Channels/Roles/Invite are ignored | Fixed | `authz-hardening.test.js` |
| authz-4 | medium | bug | Any group-chat member can delete the group's chat channel (all history), create channels, and delete others' messages | Fixed | `authz-hardening.test.js` |
| authz-5 | medium | bug | Losing a role doesn't remove you from a private voice channel; later joiners still connect to you | Fixed | `voice-hardening.test.js` |
| authz-6 | medium | bug | 'DMs from friends only' is bypassed by group chats: anyone sharing a server can pull you into a group and ring you | Partly fixed | `authz-hardening.test.js` |
| authz-7 | low | bug | Blocking someone doesn't stop their DM typing, reactions, pins or edits to old messages | Fixed | `authz-hardening.test.js` |
| authz-8 | low | bug | Mention and reply push notifications reach members who can't see the channel, leaking its name, and skip any @everyone permission check | Partly fixed | `authz-hardening.test.js` |
| authz-9 | low | overclaim | README promises role mentions only notify when the sender may use them; neither the server nor the receiving client checks | Fixed | `authz-hardening.test.js` |
| authz-10 | low | bug | Server events: private channel ids exposed to all members, events posted by muted members, reminders sent to ex-members | Fixed | `authz-hardening.test.js` |
| authz-11 | low | bug | An outsider can inject call:declined into any voice channel or group call by id | Fixed | `authz-hardening.test.js` |
| authz-12 | medium | overclaim | SECURITY.md says Manage Roles can't grant Administrator, but it can assign any lower role that has Administrator, including to itself | Fixed | `authz-hardening.test.js` |
| authz-13 | low | limitation | Invites can't be listed or revoked, and the UI defaults to never-expiring, unlimited invites | Partly fixed | `authz-hardening.test.js` |
| authz-14 | low | hardening | Deleting a server or transferring ownership needs no password or 2FA step-up | Fixed | `authz-hardening.test.js` |
| authz-15 | low | limitation | Presence and profile updates go to every connected user on the instance; blocking doesn't hide them | Documented | — (SECURITY.md §4) |
| authz-16 | info | limitation | Private channels have no cryptographic isolation: one key per server, held by every member (not stated in SECURITY.md) | Documented | — (SECURITY.md §4) |

### Uploads and files (files, 11 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| files-1 | medium | vulnerability | Multipart text fields are unbounded: one authenticated upload request can exhaust memory and crash the server | Fixed | `files-hardening.test.js` |
| files-2 | medium | bug | Deleting a server, or the last member leaving a group, orphans uploaded files that stay on disk and publicly downloadable | Fixed | `files-hardening.test.js` |
| files-3 | medium | vulnerability | Storage quota and daily upload limit are not reserved, so concurrent uploads overrun them by an unbounded multiple | Fixed | `files-hardening.test.js` |
| files-4 | medium | vulnerability | GIF library uploads bypass storage accounting, daily limits, admin bulk-delete and the GIFs feature switch | Fixed | `files-hardening.test.js` |
| files-5 | medium | vulnerability | Crafted attachment metadata makes recipients fetch arbitrary third-party URLs, ignoring the 'image previews' privacy switch | Fixed | `files-hardening.test.js` |
| files-6 | low | limitation | Profile avatars, banners and backgrounds are stored and served byte-for-byte, keeping EXIF/GPS metadata, and are public to any signed-in user | Partly fixed | `files-hardening.test.js` |
| files-7 | low | overclaim | SECURITY.md and README claim file lengths are padded, but attachment blobs are uploaded unpadded (exact plaintext size leaks) | Documented | — (SECURITY.md §1; README) |
| files-8 | low | overclaim | SECURITY.md claims API keys are encrypted at rest, but GIPHY/KLIPY/RAWG/Last.fm keys are stored in plaintext | Fixed | `admin-hardening.test.js` |
| files-9 | low | limitation | Attachment permission and moderation controls are advisory because the encrypted payload references blobs the server never sees | Documented | — (SECURITY.md §4) |
| files-10 | low | hardening | Media proxy tokens are not bound to the target URL and proxies follow redirects, widening SSRF/open-proxy exposure | Partly fixed | `files-hardening.test.js` |
| files-11 | low | vulnerability | Learned (auto-collected) library GIFs skip the word filter and bind the chosen URL to a client-supplied id, enabling library poisoning | Fixed | `files-hardening.test.js` |

### Outbound requests (SSRF) (ssrf, 5 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| ssrf-1 | medium | vulnerability | DNS-rebinding SSRF: feed/tracker guard validates then re-resolves, reaching cloud metadata & internal services | Fixed | `outbound-hardening.test.js` |
| ssrf-2 | medium | vulnerability | SSRF guard bypass: IPv4-mapped IPv6 literals (e.g. [::ffff:169.254.169.254]) are treated as public | Fixed | `outbound-hardening.test.js` |
| ssrf-3 | low | vulnerability | Image proxy buffers entire remote body into memory before the 6 MB cap (memory-amplification DoS) | Fixed | `files-hardening.test.js` |
| ssrf-5 | medium | vulnerability | Web push to a user-chosen endpoint has no response size/time limit and no host restriction: one user can crash the server | Partly fixed | `outbound-hardening.test.js` |
| ssrf-4 | low | hardening | Emoji-from-GIPHY does the provider API call and full GIF download before the cheap duplicate/limit checks, with no rate limit | Fixed | `files-hardening.test.js` |

### Calls and realtime (voice, 15 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| voice-1 | medium | vulnerability | Watch together: unbounded video URL length lets any user freeze and bloat the whole server with a few control events | Partly fixed | `voice-hardening.test.js` |
| voice-2 | medium | bug | Flood-limiter strikes never decay, and the app treats the resulting disconnect as a revocation and signs the user out | Fixed | `voice-hardening.test.js` |
| voice-3 | medium | vulnerability | Losing CONNECT/VIEW_CHANNEL through roles never removes a user from a voice call they are already in | Fixed | `memberships.test.js`, `voice-hardening.test.js` |
| voice-6 | medium | bug | TURN credentials expire after 12 h but the app only fetches them on socket (re)connect, so long-open apps lose relay connectivity | Fixed | `voice-hardening.test.js` |
| voice-4 | low | vulnerability | Flood protection is per connection only; one session can open unlimited sockets and multiply its event budget | Partly fixed | `voice-hardening.test.js` |
| voice-5 | low | vulnerability | call:decline has no authorization for non-DM rooms: anyone can push 'X declined the call' to any voice channel | Fixed | `authz-hardening.test.js`, `voice-hardening.test.js` |
| voice-15 | low | bug | Watch together host-only mode can be bypassed with watch:next (skip/pause without being the host) | Fixed | `voice-hardening.test.js` |
| voice-7 | low | bug | ICE candidates that arrive before (or while) an offer is verified are silently dropped | Fixed | `voice-hardening.test.js` |
| voice-8 | low | limitation | A malicious server can add an invisible listener to any call: the client accepts any validly signed offer and draws participants only from server state | Documented | — (SECURITY.md §4; README) |
| voice-9 | low | overclaim | TURN 'bandwidth limits' are only allocation-count quotas; one account can exhaust them, and the relay is open to anyone who registers | Partly fixed | `voice-hardening.test.js` |
| voice-10 | low | overclaim | SECURITY.md row 35 understates a region compromise: every region holds the instance-wide TURN secret, valid on all relays | Documented | — (SECURITY.md row 35, §4; RUNNING-HEARTH.md) |
| voice-11 | low | hardening | Region heartbeat IP filter accepts IPv6 loopback and IPv4-mapped private addresses | Fixed | `voice-hardening.test.js` |
| voice-12 | low | bug | typing socket event ignores blocks (DMs) and Send Messages (channels) | Fixed | `voice-hardening.test.js` |
| voice-13 | low | limitation | Calls are tied to the signaling socket: any blip or server restart ends every call, with no rejoin; device changes are not handled | Documented | — (SECURITY.md §4) |
| voice-14 | low | hardening | TURN secret/URL changes and region add/reinstall/delete are not audit-logged and need no step-up | Fixed | `voice-hardening.test.js` |

### Admin and owner tools (admin, 12 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| admin-1 | high | vulnerability | Anyone can register a free ADMIN_USERS name and become an admin, or even the instance owner | Fixed | `auth-hardening.test.js` |
| admin-2 | high | vulnerability | Ownership transfer and staff grants need no step-up: a stolen owner session becomes a permanent instance takeover, including the backup key | Fixed | `admin-hardening.test.js` |
| admin-3 | low | bug | Ownership can be handed to a deleted or bot account, leaving the instance without a usable owner | Fixed | `auth-hardening.test.js` |
| admin-4 | medium | vulnerability | Moderators can delete any message, including the owner's and admins' and any DM, with no rank or report check | Fixed | `admin-hardening.test.js` |
| admin-5 | medium | vulnerability | Admins can delete or seize servers owned by the instance owner, delete group DMs, and IP-ban the owner | Fixed | `admin-hardening.test.js` |
| admin-6 | medium | vulnerability | Any admin can rewire payments and grant paid status with no audit entry (money and memberships config) | Fixed | `access.test.js`, `admin-hardening.test.js` |
| admin-7 | low | overclaim | The audit-log hash chain is unkeyed and unanchored: tail truncation and re-hashed edits verify as intact, and the server re-chains NULL hashes itself | Fixed | `admin-hardening.test.js`, `platform.test.js` |
| admin-8 | medium | vulnerability | Plaintext database snapshot is written inside data/backups/encrypted/ (the folder the docs say to rclone off-site) and is never cleaned up after a crash | Fixed | `admin-hardening.test.js` |
| admin-9 | low | bug | Creator-membership invoices are also recorded as instance donations by /api/pay/stripe | Fixed | `admin-hardening.test.js` |
| admin-10 | low | bug | 'Roles with moderator powers can't be sold' is only checked when a tier is created or edited; later role edits or channel overrides bypass it | Fixed | `admin-hardening.test.js` |
| admin-11 | low | vulnerability | Server update packages are not authenticated; the Mac/Linux tool silently installs the newest *hearth*/*update* zip from ~/Downloads as root | Partly fixed | `infra-hardening.test.js` |
| admin-12 | low | limitation | Supporter payments ignore refunds and chargebacks; a one-off payment can grant up to 400 days | Deferred | — (SECURITY.md §4; RUNNING-HEARTH.md) |

### Client rendering (xss, 9 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| xss-3 | medium | vulnerability | Attachment URLs from E2EE payloads are trusted: one click on a file card navigates the Hearth tab or window to an attacker site, and image entries load from any host | Fixed | `files-hardening.test.js` |
| xss-4 | medium | vulnerability | Desktop app checks navigation and IPC origins with startsWith(origin), so https://<server>@evil or https://<server>.evil counts as Hearth | Fixed | `client-hardening.test.js` |
| xss-1 | medium | vulnerability | Profile custom CSS can switch off the page's containment and cover the whole window, including the close controls; the comment box on the page can be disguised as a password prompt | Fixed | `client-hardening.test.js` |
| xss-2 | medium | vulnerability | Invisible status leaks through lastSeen on profile pages and People, including to users the owner has blocked | Fixed | `client-hardening.test.js` |
| xss-5 | medium | vulnerability | Profile writes have no rate limit, and each one pushes the full public profile to every connected socket on the instance | Fixed | `client-hardening.test.js` |
| xss-6 | low | bug | A shared 'look' file can inject CSS into the app background via an unchecked bg.angle (persistent outside-URL beacon) | Fixed | `client-hardening.test.js` |
| xss-7 | low | overclaim | The CSP comment and SECURITY.md row 25 say data can't leave, but img-src/media-src https:, third-party frames and navigation allow it | Documented | — (SECURITY.md row 25; README) |
| xss-8 | low | limitation | Users' IPs reach third parties: Google Fonts on every load, auto-loaded image links, direct watch-together videos | Documented | — (SECURITY.md §4; README) |
| xss-9 | info | hardening | Watch-together iframes have no sandbox attribute, and YouTube commands are posted with targetOrigin '*' | Fixed | `client-hardening.test.js` |

### Infrastructure, desktop and CI (infra, 12 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| infra-1 | high | vulnerability | Desktop app silently installs native code served by whatever server it is connected to; no signature check on Linux or on unsigned Windows builds, and the Hearth process can write its own update feed | Partly fixed | `client-hardening.test.js` |
| infra-2 | medium | vulnerability | Desktop app lets the remote page decide screen-capture consent (and sends it titles and thumbnails of every window); clipboard-read and mic/camera are auto-granted with no prompt | Partly fixed | `client-hardening.test.js` |
| infra-3 | medium | vulnerability | hearth-apps.yml grants contents:write to every job, persists the token, runs unlocked npm/npx code and tag-pinned third-party actions that receive the root VPS SSH key | Partly fixed | `infra-hardening.test.js` |
| infra-4 | medium | bug | hearth-update.sh restarts a plain-mode Hearth as root (and installs its deps as root) | Fixed | `infra-hardening.test.js` |
| infra-5 | medium | vulnerability | README's TURN instructions produce an open, static-password relay that can reach private networks | Partly fixed | `infra-hardening.test.js` |
| infra-6 | low | hardening | Desktop origin checks use string prefix (startsWith) and there is no will-redirect handler, so look-alike hosts pass as 'our server' | Fixed | `client-hardening.test.js` |
| infra-7 | low | vulnerability | Android bridge accepts setServer from the remote server page, so a compromised server or XSS can permanently re-point the app | Fixed | `client-hardening.test.js` |
| infra-8 | low | vulnerability | Docker quick start + default TRUST_PROXY ('uniquelocal') lets clients forwarded by Docker's proxy spoof their IP via X-Forwarded-For (IP bans, per-network limits) | Fixed | `infra-hardening.test.js` |
| infra-9 | low | overclaim | SECURITY.md claims 'npm ci everywhere' and 'third-party actions pinned to full commit SHAs'; the release workflow does neither | Documented | — (SECURITY.md §7) |
| infra-10 | low | overclaim | Threat model and signing docs overstate update-channel safety and omit what the desktop app adds to a server compromise | Documented | — (SECURITY.md §4, row 54; SIGNING.md; README) |
| infra-11 | low | hardening | Root update/install flows use fixed /tmp paths and never check the update zip's integrity | Fixed | `infra-hardening.test.js` |
| infra-12 | info | overclaim | Smaller doc and behaviour mismatches: trustedSelfSignedHosts disables TLS checks entirely; 'leave empty to ask' still bakes in the author's server; wrong tag name | Partly fixed | — (wording only; README (desktop config, tag name); workflow input wording) |

### Platform (platform, 6 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| platform-2 | medium | vulnerability | Web push subscription endpoint is a server-side SSRF: any account can make Hearth POST to an arbitrary internal https URL | Partly fixed | `outbound-hardening.test.js` |
| platform-3 | high | vulnerability | Push fan-out is a single-user event-loop DoS: no per-user subscription cap, no subscribe rate limit, synchronous crypto fan-out, no send timeout | Partly fixed | `outbound-hardening.test.js` |
| platform-1 | medium | vulnerability | Default `trust proxy` trusts any private-range hop, so a client reaching Hearth from a private source address (Docker quick-start) fully spoofs its IP, bypassing IP bans and per-network rate limits | Fixed | `infra-hardening.test.js` |
| platform-4 | low | hardening | Rate-limiter keys grow unboundedly from attacker-chosen input on routes with no global cap (notably /auth/params) | Partly fixed | `auth-hardening.test.js` |
| platform-5 | info | limitation | In-memory rate limits and security log are per-process: incorrect under multi-instance and lost on restart (disclosed) | Documented | — (SECURITY.md §4) |
| platform-6 | low | limitation | No access or structured security logging; SSRF/ban/rate-limit events are not durably recorded | Documented | — (SECURITY.md §4) |

### Data layer (data, 15 findings)

| ID | Severity | Kind | Title | Status | Proving test |
|---|---|---|---|---|---|
| data-1 | medium | bug | Negative ?limit= turns message paging into an unbounded history dump (SQL LIMIT -1) | Fixed | `data-hardening.test.js` |
| data-13 | medium | bug | Any account can stall the whole server for 2.5-4 s per request with GET /api/me/study (100 MB in one synchronous response); sync also silently truncates at 5000 rows | Fixed | `data-hardening.test.js` |
| data-3 | medium | performance | Join/leave triggers O(members^2) work (emitServer + emitKeyState) with no rate limit; one invited user can freeze a large server's instance | Partly fixed | `data-hardening.test.js` |
| data-2 | medium | bug | Threads are fetched without LIMIT and deleted with one IN(?...) list: big threads stall the server, and over 32766 replies the root can't be viewed or deleted (files already gone) | Fixed | `data-hardening.test.js` |
| data-4 | low | bug | Migrations are not atomic and the v12 step is not idempotent: an interrupted upgrade (or interrupted first start) leaves a permanent crash loop, and each restart writes another full DB copy | Partly fixed | `data-hardening.test.js` |
| data-6 | medium | vulnerability | Encrypted backup writes a plaintext DB snapshot into backups/encrypted/ and leaves it there if the process stops mid-backup | Fixed | `admin-hardening.test.js` |
| data-7 | medium | bug | Any upload deleted while a backup streams aborts the whole encrypted backup and leaves a large .hbk.part that is never cleaned | Fixed | `admin-hardening.test.js` |
| data-8 | medium | bug | Deleting a server cascade-deletes membership rows even when the Stripe cancellation failed, so subscribers keep being billed with no local record | Fixed | `admin-hardening.test.js` |
| data-5 | low | bug | Group auto-deletion and admin server deletion skip content cleanup: encrypted attachments stay on disk, in backups and in the uploader's quota forever; reactions and poll rows are orphaned | Fixed | `files-hardening.test.js` |
| data-9 | medium | performance | Group 'last message' query scans every top-level message on the instance, so bootstrap cost grows with groups x total messages | Partly fixed | `data-hardening.test.js` |
| data-10 | low | performance | Missing indexes on hot lookups: members(user_id), dm_channels(user_b), friendships(addressee_id), channels(server_id) | Partly fixed | `data-hardening.test.js` |
| data-11 | low | bug | RSVPs survive leave/kick/ban/account deletion, so banned ex-members keep receiving event reminders with post-ban event titles | Fixed | `authz-hardening.test.js` |
| data-12 | low | bug | Deleting a role that a paid membership tier grants leaves the tier on sale with no role (no FK or guard on membership_tiers.role_id) | Fixed | `admin-hardening.test.js` |
| data-14 | low | limitation | No downgrade guard: older code silently runs against a newer schema, and restore does not compare schema versions | Fixed | `data-hardening.test.js` |
| data-15 | low | overclaim | README says upgrades 'only add new tables and columns', but migrations rename columns, rewrite session and audit rows, and drop a table | Documented | — (README (Upgrading)) |

## 5. Deferred items, and why

**Fully deferred findings**

| ID | What stays | Why |
|---|---|---|
| auth-11 | The session that changes the password, turns on 2FA or logs out other devices keeps its token, so a copy of that one token survives. | Rotating it changes the response contract and the client's token handling: tabs share one token in `localStorage`, and a naive server-only change would sign users out of their other tabs and wipe their keys. A design (rotate in place, tabs pick up the new token, sweeper closes sockets on the old one) is recorded. |
| crypto-7 | A message's id, reply, thread, time and edit version are not inside the ciphertext, so the server can replay, re-thread, re-date or roll back an edit. | A protocol change with false-positive risk (the server legitimately clears a reply whose target is gone). The recorded design adds a client UUID, reply, thread, time and edit counter to the encrypted payload, backward compatible, with a "may have been moved" flag. |
| admin-12 | Refunds and chargebacks don't reduce supporter time; a one-off payment can give up to 400 days. | Needs product decisions (partial refunds, Ko-fi has no refund webhook) and a schema change to store charge ids. The manual workaround (unmark in Admin → Users) is logged. |

**Deferred parts of partly fixed findings**

| Finding | What stays | Why |
|---|---|---|
| auth-9 | Old-format (PBKDF2) accounts can be told apart from unknown names via `/auth/params`. | Hiding it needs double key-derivation work per login or a forced migration of dormant accounts: a product decision. |
| platform-4 | No instance-wide cap on `/auth/params`; the in-memory limiter map isn't size-bounded. | A global cap would let anyone stop everyone signing in; growth is now bounded by the networks (per /64) an attacker controls. |
| auth review-2/3 | Proof of work is cheap on GPUs, so busy-time difficulty raises a flood's cost without capping it; a brand-new device on a new network can be held up by someone solving checks. | The old hard caps were a cheap lock-everyone-out denial of service; per-account limits stay hard so nobody can guess one password with enough compute. |
| authz-6 | Group adds need no consent, and group chats still count as a "shared server" for DMs and friend requests. | Product decisions; the actual bypass ("DMs from friends only") is fixed. |
| authz-8 | The server can't tell role mentions from user mentions for push (content is encrypted); the 50-per-message cap stays. | Needs a protocol change (send mentioned users and roles separately). The channel-name leak is fixed. |
| authz-13 | A kicked (not banned) member's invite links keep working. | Revoking them would silently break links shared legitimately; owners can now list and revoke any link. |
| crypto-3 | `keyState` is not paged. | Growth is now bounded (strict 600-character bundles, rotation limits); paging fits the message-pagination work. |
| crypto-5 | The member list isn't bound into a key handoff, and nothing stops a rollback across page reloads. | A persisted maximum epoch would lock everyone out after a legitimate backup restore until an admin restore flow exists. |
| crypto-8 | No "replace my identity key" feature; pre-upgrade database copies aren't pruned or encrypted. | New user-facing feature, and backup infrastructure work. |
| crypto-11 | A contact's first signing key is still pinned silently. | Flagging it would show a false "security key changed" for every contact of every older account. Uploads now need proof of possession. |
| crypto-13 | No "new members can't read history" option; file blobs aren't padded. | Product decisions, and padding needs a versioned blob format. Same-account rejoin now forces a new key. |
| crypto review-4/5 | A second account can make one account leave and rejoin to trigger rotations; a different account with a kept invite still gets the current key. | Needed rotations are never held up; broken keys are replaced after two reports. Documented: revoke invites after removing someone. |
| files-6 | Pictures uploaded before this version keep their metadata; GIF comment blocks and profile songs' ID3 tags aren't stripped. | Rewriting existing user files in place is irreversible if an edge case slips through. |
| files-10 | Media tokens aren't bound to the target URL; `/media/news` is an open image proxy for signed-in users; `ART_HOSTS` has broad suffixes. | Needs server-issued signed URLs on all three clients; narrowing hosts could break music art. |
| ssrf-5 / platform-2 / platform-3 | No process-wide `uncaughtException` policy; no push-service allow-list; push encryption runs on the main thread. | Platform-wide policy; an allow-list would break self-hosted push services; the work is now bounded. |
| outbound review-3 | Local-name lookups (`.local`, single-label) share two system-lookup slots. | Removing them breaks `/etc/hosts` names that `ART_PROXY_EXTRA_HOSTS` relies on; public names can't be delayed. |
| voice-1 | Watch-together state is sent whole on every change. | Delta updates change the protocol; amplification is bounded (64 KB state, 4 broadcasts a second). |
| voice-4 | No per-session socket cap and no per-network handshake limit. | Tabs share one session; a NAT full of users reconnecting after a restart would be locked out. The per-user cap of 30 sockets and shared event budget cover it. |
| voice-9 | Anyone who can sign up gets relay logins; no default total bandwidth cap; existing installs need `setup-turn.sh` again. | Product decision; the right total depends on each VPS plan. |
| admin-11 | Server update zips are checksum-checked, not signed. | Needs a release signing key and a key-management decision (minisign or `ssh-keygen -Y` design recorded). |
| infra-1 | Updates come from whatever server the app is connected to; `data/downloads` is writable by Hearth; the SignPath certificate thumbprint isn't pinned. | Signed updates make the feed's origin irrelevant for builds with a key; the rest are deploy changes or need external information. Apps released before signing install the hop to the first signed build the old way. |
| infra-2 | No always-visible native "sharing your screen" indicator; an old-style capture request gets the whole screen for about 3 s after a pick. | UX work; Electron can't tell the two request kinds apart, so the window is shortened, not closed. |
| infra-3 | Using a non-root deploy user is up to the operator. | The workflow can't enforce VPS and GitHub settings; the docs recommend it. |
| infra-5 | Static `TURN_USERNAME`/`TURN_CREDENTIAL` still work. | Removing them would break existing deployments; the server warns at start-up. |
| infra-12 | `trustedSelfSignedHosts` still accepts any certificate; the committed `defaultServer` is the author's server. | Desktop behaviour change and product decision; the docs now warn. |
| data-3 / data-9 / data-10 / data-4 | Full server views on role/channel edits; no `/bootstrap` rate limit; no admin-only indexes; old pre-upgrade copies never pruned. | Protocol change; a 429 there breaks start-up; write cost on the busiest table; product decision. |

## 6. Verification

**Local test run (this report, after all documentation changes).** `npm test` in `hearth/`
(`node --test --test-concurrency=1 test/*.test.js`, 24 test files):

| Tests | Suites | Passed | Failed | Cancelled | Skipped | Duration |
|---|---|---|---|---|---|---|
| 358 | 7 | **357** | **0** | 0 | 1 | 529 s |

(358 tests in 336 top-level entries; the baseline had 111. Exit code 0.)

The same suite run on the merged code before these documentation changes gave the same result: 358 tests,
357 passed, 0 failed, 1 skipped, in 543 s. Tests that need tools ran here: the two Chromium/Playwright tests and the
Java (`javac`) Android bridge test passed. The one skipped test is the opt-in Electron test (`infra-2: in Electron,
a hostile page can't keep an old-style desktop capture…`): Electron isn't installed in this container, so that
behaviour is **not verified** here (the client batch reports it passed under `xvfb-run` with Electron 44.7.0; not
observed for this report).

**GitHub Actions** (observed through the Actions API for the integration branch, whose head `dec63ee` this commit builds on):

| Run | Commit | Job | Result |
|---|---|---|---|
| Hearth security #50 (38079189149) | `dec63ee` (code identical to this commit) | `tests` | passed: 358 tests, 355 pass, 0 fail, 3 skipped (the Electron test and, without Playwright in CI, the two browser tests) |
| | | `audit` (`npm audit`, server fails on high/critical) | passed |
| | | `image` (Docker build, Trivy image and config scans) | passed |
| | | `codeql` | passed |
| | | `secrets` (gitleaks over full history) | **failed**: one finding, `generic-api-key` in `hearth/test/admin-hardening.test.js` line 266, commit `dde6609` — the made-up test value `GIPHY-KEY-1234`. A false positive, but the job is red until it is allow-listed (§9). |
| Hearth apps #15 (38076649443) | `47fb2b5` (same app code) | `desktop (windows-latest)`, `desktop (macos-latest)`, `desktop (ubuntu-latest)`, `android` | all passed (installers and APK built; unsigned, because Windows signing and SignPath run only for release builds; `release` and `publish-to-vps` skipped on this branch) |

Whether the repository has the `UPDATE_SIGNING_KEY` secret is **not verified**: the "Bake in the update signing key"
and "Sign the update files" steps succeed either way. The signing and verification code itself is tested locally
and in CI (`client-hardening.test.js` › infra-1…).

**Status by area**

| Area | Status |
|---|---|
| Server fixes (auth, authz, files, outbound, voice, admin, data, crypto server side) | implemented; tested locally; tested in CI |
| Client-side guards (attachments, profile CSS, message labels, key trust) | implemented; tested locally (Node unit tests and two Chromium tests); tested in CI except the Chromium tests |
| Desktop app main process (origins, permissions, picker, update verification) | implemented; tested locally with plain-Node unit tests; the Electron end-to-end test not verified here |
| Desktop builds (Windows, macOS, Linux) | tested in CI (build only); not run here (no Wine) |
| Android bridge policy | implemented; tested locally (`javac`) and in CI |
| Android build | tested in CI (build only); not run here (no Android SDK) |
| Update tools and `hearth-update.sh` | tested locally with stubbed system commands; not verified on a real VPS |
| CI workflow rules (permissions, pinning, host-key pinning, release-only publishing) | static checks tested locally and in CI; the publish step itself not verified (it only runs for release builds) |
| TURN bandwidth caps | config generation tested locally; not verified against a running coturn |
| Watch-together sandboxed players | implemented; not verified against the live YouTube, Vimeo and Twitch players |
| Docs (this commit) | checked by reading against the code; no automated test reads the docs |

## 7. Documentation changes in this commit

- `SECURITY.md`: the asset table, adversaries, contract and honest limits rewritten against the merged code. Rows
  1–37 kept their numbers (with corrected wording); rows 38–71 are new, one per protection the batches added, each
  naming its test. All 19 overclaims are corrected here or in README (`auth-6`, `crypto-2`, `crypto-5`, `crypto-6`,
  `crypto-7`, `crypto-9`, `crypto-12`, `authz-9`, `authz-12`, `files-7`, `files-8`, `voice-9`, `voice-10`,
  `admin-7`, `xss-7`, `infra-9`, `infra-10`, `infra-12`, `data-15`), and all 14 limitations are stated as they now
  stand (`auth-5`, `crypto-13`, `authz-13`, `authz-15`, `authz-16`, `files-6`, `files-9`, `voice-8`, `voice-13`,
  `admin-12`, `xss-8`, `platform-5`, `platform-6`, `data-14`).
- `README.md`: encryption and call claims qualified; step-up list, invites, roles and overrides, desktop update
  signing, `TRUST_PROXY`, `PUSH_ALLOW_PRIVATE`, `OUTBOUND_BLOCK`, `TURN_SECRET`, `ADMIN_USERS`, `cli.js set-owner`,
  update zips and checksums, upgrades and rollback, backups, push limits, GIF privacy and the search syntax.
- `index.html` (landing page) and `code-signing.html`: "can't read" claims qualified, calls through relays, update
  signing described.
- `docs/ARCHITECTURE.md`, `docs/RUNNING-HEARTH.md`, `docs/SIGNING.md`: updated for the changed modules and
  operator steps; `docs/ROUTES.md` generated, with a note on counts and regeneration.

## 8. Search design

Messages are end-to-end encrypted, so the server can't search their text. Search is split so the server only ever
handles metadata.

- **On the device** (`public/js/search-query.js`, `public/js/app.js`): the search box's language — words that must
  all appear, `"exact phrases"`, `from:@username` / `from:me`, `in:#channel` / `in:@username`, `before:` /
  `after:` / `during:` a day, month or year, `has:file|image|link`, `is:edited|pinned` — is parsed and matched
  locally. Only `from:`, `in:` and the dates become server parameters. The app fetches pages, decrypts them and
  matches; each click checks up to 1,000 messages, newest first, and **Search further back** continues from the
  cursor. Recent searches are kept only in that browser and can be turned off.
- **On the server** (`server/search.js`, `GET /api/search/messages`): parameters are `scope` (`c:<channel>`,
  `d:<dm>`, `s:<server>`, `all`), `from` (a user id), `before`/`after` (ms), `cursor` and `limit` (1–200, default
  100). It builds no search index and never receives the words, phrases or `has:`/`is:` filters. It returns the
  same ciphertext, serialized the same way, as the history routes.
- **Access** is worked out again on every request: servers you're in, channels you can view (checked per channel
  for `all` and `s:`), DMs you're part of. A cursor is only a position (`[createdAt, id]`, validated); editing it
  can't reach anything the access checks don't allow.
- **Bounds:** 200 messages per page; for `all` and `s:` at most 100 conversations per page (the ones with the newest
  matches; the rest come on later pages, so nothing is skipped); 60 searches a minute per person. Queries use
  covering indexes added in v17, so a page never reads whole channels (`scripts/bench-search.js` prints the plans).
- **What the server learns:** that you searched, when, which scope, author and time window, and how far back you
  paged.
- **Proven by:** `search.test.js` (scopes, hidden channels, other servers, deleted messages, filters, stable paging,
  bounded conversations, membership changes, forged cursors, limits, rate limit) and `search-query.test.js` (the
  language, matching, dates, highlighting). Tested locally and in CI.

## 9. Remaining risks

The full list is [SECURITY.md](../SECURITY.md) §4. The ones that matter most:

1. **A malicious or compromised server** can serve modified app code (web, desktop and Android all load it), add
   hidden members or call listeners, hold back or roll back key changes across reloads, and replay or re-thread
   messages. End-to-end encryption protects stored data, not a hostile host.
2. **Email takeover without 2FA** gets the account with new keys, and with them each server's current key from any
   member device that never saw the old key (`crypto-2`).
3. **Metadata** stays visible to the server: who talks to whom and when, file sizes, GIF picks and loads, search
   metadata, presence (to everyone on the instance) and profiles.
4. **Private channels** share the server's key; only access checks separate them.
5. **CI is red**: the `secrets` job fails on a fake key in a test file (`admin-hardening.test.js:266`, commit
   `dde6609`). Until it's allow-listed, real secret findings would be hidden behind a job that is always failing.
6. **Update zips** are checksum-checked, not signed; apps built before update signing (and forks without the key)
   can't verify desktop updates.
7. **The relay secret** is shared by every region and stored in plain text; relay logins can't be revoked early.
8. **In-memory state**: rate limits and the security log reset on restart and aren't shared between processes;
   there is no access log or durable security log.
9. **Open review minors** (reported by batch reviewers, not fixed, low impact): the typing throttle is per user
   rather than per conversation; `voice:signal` allows bursts of large (64 KB) signals; the region address check
   doesn't refuse documentation and benchmark ranges (`192.0.2.0/24`, `198.18.0.0/15`, `2001:db8::/32`) or the
   IPv4-translated form; in host-only watch together a viewer whose video ended may replay its start until the host
   finishes (reported, not re-verified); the per-channel Manage Channels rule doesn't cover channel reordering.
10. **The CSP comment** in `server/index.js` above `CSP_BASE` still says connections "can't send data elsewhere";
    the docs are corrected, the code comment isn't.

## 10. Recommended next tasks

1. Allow-list the gitleaks false positive so the `secrets` job is green again: add
   `dde6609d2d22e5495b1c6b40b477b0d71bcaccb1:hearth/test/admin-hardening.test.js:generic-api-key:266` to a
   `.gitleaksignore` at the repository root (a `gitleaks:allow` comment can't fix a finding in an old commit), and
   use values that don't look like keys in new tests.
2. Set the `UPDATE_SIGNING_KEY` secret (if it isn't set) and `VPS_HOST_FINGERPRINT`, and publish one signed
   release so installed apps move to signed updates.
3. Sign server update zips (`admin-11`), and pin the trust anchor in `hearth-update`.
4. Make step-up always ask for a code for password, email, recovery-key and key-export changes (`auth-6`), and rotate
   the current session token on password change (`auth-11`).
5. Bind message id, reply, thread, time and edit version into the ciphertext (`crypto-7`), and the member list into
   key handoffs (`crypto-5`).
6. Rotate the server key after a reset without a recovery key, or keep a reset account out of key sharing until a
   member verifies it (`crypto-2`).
7. Per-region relay secrets and a rotate action (`voice-10`); a total bandwidth cap per region.
8. Self-host the app's fonts and offer click-to-load for outside images (`xss-8`), then tighten `img-src` and
   `media-src` (`xss-7`).
9. Close the open review minors in §9 item 9.
10. Run the Electron end-to-end test and the Chromium tests in CI (install Playwright and Electron there), and run a
    real `hearth-update` and `setup-turn.sh` on a test VPS.
