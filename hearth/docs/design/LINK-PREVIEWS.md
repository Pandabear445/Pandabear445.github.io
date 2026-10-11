# Design: link previews built by the sender, carried inside the encrypted message

Status: built (after 1.29.0; the schema is unchanged) · NEXT.md pick #6 · User docs: README "Link previews", docs/FEATURES.md "Link previews"

**Build notes: where the code differs from this document, and why.**
- `LINK_PREVIEW_ALLOW_PRIVATE` takes `1` (any host) or a comma-separated list of host names that may be private. With a list, a test can still show that a redirect to some other private name is refused. Either form also allows ports other than 443, and `/api/config` then says `linkPreviewAnyPort: true` so the test apps offer and accept previews for the stand-in site's port. A normal server never sets it.
- `LINK_PREVIEW_TIMEOUT_MS` (tests only, default 10,000) scales the 10 s budget, so the "site never answers" test runs in about 2 s.
- Node's `TextDecoder('windows-1252')` decodes as ISO-8859-1 (0x80–0x9F become control characters), so `decodeHtml` decodes that family by hand.
- `example.com`/`.net`/`.org` are refused with their subdomains, and `home`, `corp` and `localdomain` join the reserved names. A thumbnail must decode to at most 16,384 bytes: base64 length alone allows 16,385.
- `secure.js` calls `cleanLinks` through one helper, `linksIn`, used by both `openGroup` and `openDm` (the static test checks the helper is used twice).
- A paste clears an earlier "no" for the links pasted, so someone can bring a dismissed preview back.
- Edits also keep the poll (`p`), fixing the existing problem noted in §14 risk 8.
- The card is not added to the "sending…" copy (optional in §8.5).
- The research brief proposed `GET /unfurl?url=` in `server/unfurl.js` and the picture as an encrypted attachment. This document's choices were kept: a `POST` route, so the link never sits in a query string that a reverse proxy might log, and an inline thumbnail (§6).
- Not built: gating hot-linked image-URL embeds on EMBED_LINKS (§15 step 11, a behaviour change), and the a11y pass for the chip. The chip is a polite live region and its buttons are named. Keyboard focus on the chip survives its redraw (same button if it's still there, else the message box), and Preview, Always and Preview anyway put the focus back in the box, so the next Enter sends.
- **Review fixes:**
  - *Tokenizer (§5.4 step 3).* A broken tag is given up on from where its reading stopped (the unquoted `<` that cut it short, or the end of its 8 KiB), never from one character after its `<`. Restarting there let quoted values carry each tag's scan over the following `<`s, so short repeated quote patterns re-read every 8 KiB window once per tag (seconds for 512 KiB, every time reaching the 2 s limit). It never goes back now, and a step budget (4 × the page length) stops it if that ever stops being true. `<!-->` and `<!--->` are whole empty comments, as in browsers.
  - *Text (§5.4 step 7).* Markup is dropped **before** entities are decoded, and only when shaped like a tag (`<b>`, `</p>`, `<!-- -->`; not `a < b > c` or `<3`). Stripping after decoding turned an escaped `List&lt;string&gt;` into `List`. Decoded text can contain `<` and `>`: the card is drawn with text nodes only, and a sender's app can put any text in a card anyway, so stripping was never a safety measure. The named table is HTML 4's whole set (Latin-1 letters, Greek, symbols, typography) plus the ASCII punctuation names, case-sensitive as in browsers, kept in a `Map` (so `&constructor;` stays as written).
  - *Parser worker.* Each worker keeps its own jobs. A late `exit` from a worker that was replaced after a timeout used to fail the new worker's jobs and drop the reference to it, leaving its thread running. Now a worker only fails its own jobs and only clears itself; the jobs queued behind a page that timed out move to the new worker with a fresh time limit.
  - *Detection (§8.5).* "Something follows it" means a space after the link **and** the caret outside it. Backspace inside a link with a chip (`…/story-one please`) makes a new link each time, so the chip goes at once and the new link waits for the 1.2 s pause, in Always mode too.
  - *EMBED_LINKS (§8.5, §11).* The composer needs the permission in the channel **and** server-wide (`perms.js` `mayEmbed`, the same function readers use). With only the channel check, a channel override allowing it for someone without the role permission let the server fetch the page for a card nobody, sender included, was shown. A channel override can now turn previews off, not on.

All code references are to files under `hearth/` and were checked against the current tree. Line numbers are approximate, to help you find things; function names are authoritative.

---

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| Who fetches the page? | The sender's own Hearth server fetches it, only when the sender asks, through a new `POST /api/link-previews` that uses `netguard.request` (no changes to netguard). Readers' devices never fetch anything. |
| Default behaviour | The person's setting defaults to **"Ask each time"**: nothing leaves the device until they press **Preview** on the chip. The owner switch `features.linkPreviews` defaults to on. |
| Preview image | The sender's device decodes it, shrinks it and re-encodes it as WebP (JPEG fallback) of at most **16 KiB**. It travels **inline in the ciphertext** as base64. It is not uploaded as an encrypted attachment (weighed in §6). |
| Payload change | One new optional top-level key, `l: [ { v: 1, url, title, desc, site, kind, img? } ]`, next to the existing `t` (text), `f` (files) and `p` (poll). At most one preview per message. |
| Older apps | `openGroup` and `openDm` in `public/js/secure.js` only keep `t`, `f` and `p`, so `l` is dropped silently. Older apps show the usual linkified URL. |
| Server data model | No tables, no columns, no migration. Only a new key in the `features` setting JSON. The cache lives in memory and is per user. |
| Socket events | None added or changed. |
| Rendering | A new `linkCardEl()` built with `h()` text nodes, the same safe path as `newsCard()`. The card is shown only if its URL appears as a link in the message text. Each reader's device works out the domain line itself. The image is shown as a `data:` URL. |
| YouTube | oEmbed plus a thumbnail from `i.ytimg.com`. The watch page itself is never fetched. |
| X / Twitter | `publish.twitter.com/oembed` text only, best effort. x.com and twitter.com pages are never fetched. |
| GitHub | The ordinary OpenGraph path; GitHub generates cards on `opengraph.githubassets.com`. |
| Permission | The existing EMBED_LINKS bit, "Show link previews", is currently never checked. It now gates the sender's composer and what readers display. Apps enforce it, not the server. |

---

## 1. Goals and non-goals

### Goals
1. Someone who sends an https link can attach a card (title, description, site name, small picture). The card travels inside the end-to-end encrypted payload (`c2:` for channels, `d2:` for DMs). As a result:
   - readers' devices never contact the linked site or any third party;
   - the server can't read the card in storage.
2. The fetch is SSRF-safe: `server/netguard.js` is reused as it is. It is bounded in bytes, time and concurrency, and remote HTML is never executed or rendered as HTML.
3. Privacy is explicit. Before the first request for a link, the person is told that their Hearth server will see that link.
4. No schema change, and messages stay readable by clients still running the previous JavaScript.
5. The browser, PWA, Electron desktop app and Android app behave identically, because all of them run the client code the server serves (ARCHITECTURE §1). There are no native or CI changes.

### Non-goals (v1)
- **Hiding the URL from the Hearth server.** Page JavaScript can't fetch other sites (§3.5). A native desktop or Android fetch path is listed in §14 as an open question.
- **Previews built by readers**, or built by the server from stored messages (it can't read them).
- **Players, iframes or oEmbed `html` rendering.** Watch together keeps its own `watchChips()` button.
- **Replacing hot-linked image-URL embeds** (`extractImageUrls`) with thumbnails built by the sender. This is a Phase 2 candidate (§14).
- Several previews per message.
- New previews for links added while editing.
- Previews for bot and news-bot posts; they keep `embed` and `newsCard`.
- Favicons, generic oEmbed discovery, and third-party mirrors such as fxtwitter or nitter.
- Server-side enforcement of EMBED_LINKS. The server can't tell whether a ciphertext contains a preview.

---

## 2. What exists today (the parts this design reuses or touches)

### Server
- **`server/netguard.js` `request(input, opts)`.**
  - Options: `protocols`, `allowUrl(u)` (checked on every hop), `allowPrivate`, `maxRedirects`, `timeout` (one deadline for the whole request), `maxBytes` with `truncate`, `decompress`, `signal`.
  - Returns `{ status, ok, headers, type, body: Buffer, url, truncated }`.
  - Throws `GuardError` with one of these codes: `BAD_URL`, `BAD_PROTOCOL`, `NOT_ALLOWED`, `NOT_FOUND`, `PRIVATE`, `TIMEOUT`, `ABORTED`, `TOO_BIG`, `REDIRECTS`, `NETWORK`, `BAD_ENCODING`.
  - It pins the DNS answer, re-checks every redirect, refuses this server's own addresses (except on ports 80 and 443) and anything in `OUTBOUND_BLOCK`, and caps the unpacked size while streaming.
  - **Some GuardError messages contain the host name** (`Couldn’t find ${host}.`, `Couldn’t connect to ${host}.`). Never log `e.message` from this module.
- **`server/activity.js`.**
  - `safeFetch` wraps `netguard.request` with a host allow-list on every hop, 3 redirects and 15 s.
  - `getText` reads at most 1 MB with truncation, and only as UTF-8.
  - `fromLink` → `og()` reads `og:title` and `og:image` on music.apple.com and Bandcamp with a regex (`<meta[^<>]+property=…[^<>]+content=…`).
  - `fetchImage` writes to the shared disk cache `data/cache/art`. That is fine for allow-listed public art but **not** right here.
  - `sendImage` sets `nosniff` and `default-src 'none'; sandbox`.
- **`server/newsbot.js`.**
  - `safeGet` sends the User-Agent `Mozilla/5.0 (compatible; HearthNewsBot/1.0; +self-hosted chat)`.
  - It has linear helpers `dropBlocks`, `entities` and `stripTags`.
  - `parserWorker` / `parseInWorker` parse in a worker with `FEED_PARSE_LIMIT_MS`; this is the pattern to copy.
  - The `/media/news` proxy fetches any public URL for anyone with a media token.
- **`server/index.js`.**
  - `watchTitle()` fetches YouTube and Vimeo oEmbed with plain `fetch`. `parseWatchUrl()` holds the YouTube video-id rules.
  - `/media/gif` uses `gifmedia.js` `MEDIA_HOSTS`.
  - `validCipher` accepts ciphertexts of **20 to 64,000 characters** (≈ line 2544).
  - `attachBlobs` links at most 20 URLs (≈ line 783).
  - `POST /channels/:id/messages` refuses any non-empty `files` list unless the sender has ATTACH_FILES. `PATCH /messages/:id` accepts no `files` at all.
  - The `uploads.unlinked_cleanup` job deletes unlinked blobs after 24 h.
  - Rate-limit helpers: `rateLimit`, `countHit`, `limitNet`.
  - `features()` and `FEATURE_DEFAULTS` (≈ line 4839, a `const`, so only read it at request time). `PUT /admin/owner` sets features from a fixed list `['customCss','comments','watch','gifs']` (≈ line 4913).
  - The CSP has `connect-src 'self'` and `img-src 'self' data: blob: https:`.

### Client
- **`public/js/markdown.js`.** `URL_RE`, `IMAGE_URL_RE`, `MEDIA_HOST_RE` (GIPHY and Tenor), `isImageUrl`, `extractImageUrls` (at most 4), `isOnlyImageUrl`, and `render()`, which escapes first and stashes code first.
- **`public/js/app.js`.**
  - `fillMessage()` (≈ line 2704) renders, in order:
    1. the text;
    2. `extractImageUrls` embeds, loaded via `mediaUrl()` (the GIF proxy) with `referrerpolicy=no-referrer`;
    3. `pollEl`;
    4. files;
    5. `watchChips()`;
    6. `newsCard(m.dec.embed)`.
  - `isGiphy()` also matches KLIPY hosts.
  - `P.chat` reads the `hearth.chat` localStorage key, with defaults `enterToSend, embeds, markdown, jumbo` (≈ line 117).
  - `createComposer()` (≈ line 3759) holds `state = { replyTo, pending }` and the functions `renderExtras()`, `send(overrideText, extra)` and `deliver()`.
  - `sendTo()` (≈ line 4146).
  - `editBox()` rebuilds the payload as `{ t, f }` and nothing else.
  - `openForward()` builds `{ t: fwd, f }`.
  - `pendingEl()` draws the "sending…" copy.
  - `senderMayPingEveryone()` uses `basePerms(server, m.authorId)`.
  - The GIF picker calls `send(url)`, i.e. with override text.
- **`public/js/secure.js`.**
  - `openGroup()` (≈ line 390) and `openDm()` (≈ line 474) return `{ t, f: cleanFiles(...), p: cleanPoll(...), … }`. **Unknown keys are dropped.**
  - `openLegacy()` passes `embed` through for bot posts.
- **`public/js/e2ee.js`.** `padded()` pads to 256-byte steps, then 1 KiB steps above 4 KiB. `encryptGroup()` produces `c2:<epoch>:<salt>:<iv>:<ct>:<sig>`; `encryptDm()` produces `d2:<salt>:<iv>:<ct>`. `b64()`.
- **`public/js/media.js`.** `scaled(bitmap, maxSide, quality)` encodes WebP and falls back to JPEG; `prepareImage()`.
- **Permissions.** EMBED_LINKS (`1 << 16`) is labelled "Show link previews — Image links in their messages show as pictures." It is part of `DEFAULT_EVERYONE`, `TALK` and `GROUP_MEMBER`, but **nothing checks it** (grep finds only its definitions and the role-editor list in `app.js`).
- **`public/js/usability.js`.** The export writes `rec.text`, `rec.poll` and attachments (≈ line 223).

---

## 3. Threat model and privacy (honest limits)

### 3.1 Who learns what

| Party | Learns | Does not learn |
|---|---|---|
| **Hearth server, honest operator** | The **full URL** the person asked about (path, query and anything after `#`; only the part before `#` is fetched); the account, session, IP and time of the request; the page metadata and image it fetched. The encrypted message usually follows seconds later and is about 20–30 KB instead of about 0.5 KB, so the server can **tie URL → conversation → sender → time**. The data is kept in memory for at most 10 minutes and is never written to disk or logged (§5.8). | The message text, or links the person never chose to preview (in "Ask" mode). |
| **Compromised or malicious server** | All of the above, kept forever. It can also: answer the sender with a fake preview (the sender's app trusts its server here, just as it already trusts the server's JavaScript); silently refuse previews for chosen URLs; fingerprint which links people share. | It can't change a preview once it is encrypted. Channel messages are ECDSA-signed over the whole ciphertext; DMs are bound to the DM and author through the AEAD associated data. It can't add previews to other people's messages. |
| **The linked site** | The Hearth server's IP; the User-Agent `HearthLinkPreview/<version>`; the instance-wide `Accept-Language`; the time. There is one fetch per previewing account (no cache shared between accounts), so a small site can tell that someone on that Hearth server previewed its link just now. | The sender's IP, cookies or identity. Anything about readers. |
| **Readers' devices** | Whatever the sender put in the card. | They make **no** network request for the card: the picture is an inline `data:` URL. |
| **Readers' Hearth server** | Nothing new: it already serves this ciphertext. | — |

### 3.2 Change to the published guarantees
Today SECURITY.md §4 and ARCHITECTURE §4 say the server cannot read message text, and that includes links. After this change, **links a person chooses to preview become visible to the server.**

The "Ask each time" default keeps the old guarantee unless the person opts in, one link at a time. "Always" mode gives that guarantee up for every link they type, including links they never send. This must be stated in SECURITY.md §4, ARCHITECTURE §4 ("Can read") and the settings copy (§13).

### 3.3 A malicious sender
- **A forged card** (a title or picture that looks like phishing) is no more powerful than writing the same words in the message. Readers apply these rules (modelled on Signal, §3.5):
  - The card's `url` must be one of the links `render()` would make from the message text, outside code and spoilers. Signal Desktop's `isValidLinkPreview` requires `urlsInBody.includes(url)` in the same way.
  - https only.
  - No user name or password in the URL.
  - Length at most 2048.
  - No host that mixes ASCII and non-ASCII letters, no bidi-override or box-drawing characters, at least two labels, no `%` in the host.
  - The domain line is computed by the reader from `new URL(url).hostname` (ASCII/punycode) and is **always shown**, so `site` can't hide where the link goes.
- **Oversized or malformed entries.** `cleanLinks()` caps every field, keeps one entry, and accepts an image only if it is base64 of at most 16 KiB with WebP or JPEG magic bytes. Otherwise it drops the image or the card. It never throws.
- **Image decoder bugs.** The thumbnail goes through the browser's normal image decoder, the same exposure as any attachment thumbnail.
- **Tracking pixels.** Impossible through the card, because nothing remote is loaded. (Hot-linked image URLs still are; that is unchanged, §9.)
- **Database growth.** Previews make messages bigger but stay under the existing 64,000-character `validCipher` ceiling and `limitMessages`. Any client can already post 64 KB ciphertexts at that rate, so this is not a new way to grow the database.

### 3.4 Abuse of the fetch endpoint
- **SSRF.** netguard checks every hop, pins DNS, and refuses this server's own addresses and `OUTBOUND_BLOCK`. On top of that: https only, port 443 only, no IP literals, reserved names refused, and this server's own host names refused by name (§5.2).
- **Using Hearth as a fetching proxy, or to flood a site.** Requests are GET only with fixed headers. The answer is cut down to metadata plus at most 2 MiB of image. Limits apply per user, per network, instance-wide, and per target host (§5.6). This is the same class of risk as the existing trackers and `/media/news`, which already fetch any public URL for a signed-in user.
- **One-time links** (magic sign-in links, password resets, unsubscribe links, invite tokens) can be used up by a server-side GET.
  - "Ask" is the default.
  - In "Always" mode, `looksPrivate(url)` stops automatic previews of URLs whose query has keys like `token`, `code`, `key`, `sig`, `signature`, `auth`, `session`, `password`, `otp`, `reset`, `invite`, `magic`, `ticket`, and of known share hosts: `docs.google.com`, `drive.google.com`, `dropbox.com`, `*.zoom.us`, `meet.google.com`, `1drv.ms`, `onedrive.live.com`, `icloud.com`, `wetransfer.com`. For those the chip asks again.
- **Illegal content.** The server downloads whatever page or picture a member asks about. It holds it in memory only and returns it only to that member. Operators must be told (README and OPERATIONS) and can switch the feature off.

### 3.5 Why the server has to fetch, and how others do it
- **Hearth.** The page can't fetch other sites: the CSP has `connect-src 'self'` (`cspFor` in `server/index.js`), and CORS stops scripts from reading cross-origin answers anyway ([MDN: CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)). A browser can't open a raw TLS tunnel either, so the Hearth server necessarily sees the URL. That is the honest difference from Signal.
- **Signal.**
  - The sender builds the preview. The protocol message is `Preview { url, title, image: AttachmentPointer, description, date }`, so the picture travels as an encrypted attachment ([SignalService.proto](https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/protowire/SignalService.proto)).
  - Signal-Android fetches with OkHttp, the User-Agent `WhatsApp/2`, 2 MB caps on both text and image, and a redirect-checking interceptor ([LinkPreviewRepository.java](https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/linkpreview/LinkPreviewRepository.java)).
  - Its URL rules: https only; reserved domains `example`, `i2p`, `invalid`, `localhost`, `onion`, `test` refused; private IP literals refused; mixed ASCII and non-ASCII domains refused; U+202C–U+202E and U+2500–U+25FF refused ([LinkUtil.kt](https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/util/LinkUtil.kt)).
  - Signal Desktop shows a preview only if its URL is in the body, and treats links longer than 4096 characters as suspicious ([LinkPreview.std.ts](https://github.com/signalapp/Signal-Desktop/blob/main/ts/types/LinkPreview.std.ts)).
  - Signal's help text says previews go through a privacy-enhancing proxy so the site never sees the user's IP ([How-To Geek summary](https://www.howtogeek.com/708607/how-to-turn-on-link-previews-in-signal-or-turn-them-off/)).
- **Matrix / Synapse.** The homeserver builds previews. `url_preview_enabled` is off by default and requires an IP blocklist. `url_preview_accept_language` defaults to a fixed `en`, and `max_spider_size` defaults to 10M ([Synapse config docs](https://github.com/element-hq/synapse/blob/develop/docs/usage/configuration/config_documentation.md)). Previews are commonly left off in encrypted rooms for exactly the "homeserver sees the URL" reason (secondary source: a [forum post quoting the Synapse 1.45.1 notes](https://lemm.ee/post/9955859)).
- **Hearth's position.** The server fetches, like Synapse. The result is stored end-to-end encrypted inside the sender's message, like Signal. Fetching is opt-in per link by default.

---

## 4. Flow

```mermaid
sequenceDiagram
  autonumber
  participant A as Sender app (app.js createComposer, linkpreview.js, media.js)
  participant S as Hearth server (server/linkpreview.js)
  participant W as Parser worker
  participant X as Linked site
  participant B as Reader app
  A->>A: findPreviewUrl(text) on paste / idle; chip "Preview example.org?" (no network)
  A->>S: POST /api/link-previews {url}  (only after the person presses Preview, or "Always")
  S->>S: auth, checkPreviewUrl, rate limits, per-user cache
  S->>X: netguard GET page (https:443, ≤4 redirects, ≤512 KiB, 10 s budget)
  S->>W: bytes + Content-Type → decode charset, parse <head>
  S->>X: netguard GET one og:image (≤2 MiB, ≤3 redirects)
  S->>S: sniff type and dimensions; cache for this user only
  S-->>A: {preview:{url,title,description,siteName,kind,image:{type,data,width,height}}}
  A->>A: previewThumb(): createImageBitmap → ≤400 px WebP ≤16 KiB; chip ready
  A->>A: Send: payload {t, f, l:[{v:1,…,img}]} → encryptChannel / encryptDm (size check)
  A->>S: POST /api/channels/:id/messages (unchanged)
  S-->>B: message:new {ciphertext} (unchanged)
  B->>B: decrypt → cleanLinks(l, t) → linkCardEl (data: thumbnail). No request to X, none to S.
```

---

## 5. Server design

### 5.1 New module `server/linkpreview.js`
- `module.exports = function setupLinkPreviews(ctx)`. It also exports pure helpers for tests: `checkPreviewUrl`, `decodeHtml`, `parseHead`, `decodeEntities`, `cleanText`, `sniffImage`, `youtubeId`, `xStatus`, `pickImage`, `looksLikeChallenge`.
- **Wiring.** Register it in `server/index.js` right after `BOTS = require('./bots')(…)` (≈ line 4863), which comes after `FEATURE_DEFAULTS` is defined:
  ```js
  require('./linkpreview')({ api, auth, fail, wrap, rateLimit, countHit, limitNet, features, getSetting,
    version: require('../package.json').version });
  ```
  `countHit` is not passed to modules today; add it to this call.
- The module has its own parser worker, copying newsbot's `parserWorker()` / `parseInWorker()`: `new Worker(__filename, { workerData: { linkParser: true } })`, `unref()`, and the worker is replaced on timeout.

### 5.2 Route `POST /api/link-previews`

| Item | Spec |
|---|---|
| Auth | `auth` (a session). Bots can't call it: the bot API is a separate router with `botAuth`. |
| Body | `{ url: string }`. Other keys are ignored. Body size is already capped at 2 MB by `express.json`. |
| Feature off | `features().linkPreviews === false` → **404** `{ error: 'Link previews are turned off on this server.', code: 'off' }` |
| URL checks (`checkPreviewUrl(raw, ownHosts)`) | In order, each failing with **400** `code: 'bad_url'` and a message fit to show people:<br>1. `typeof url === 'string'`, 1–2048 characters, no whitespace or C0/C1 control characters.<br>2. `new URL(url)` parses; `protocol === 'https:'`; no `username` or `password`; `port === ''` (443 only).<br>3. The host is not an IP literal (`net.isIP` after removing brackets).<br>4. At least 2 labels, each `[a-z0-9-]{1,63}` after punycoding; whole host at most 253 characters; no `%`.<br>5. The last label is not one of `localhost`, `local`, `lan`, `internal`, `test`, `example`, `invalid`, `onion`, `i2p`, `arpa`; the host is not and does not end in `home.arpa`; the host is not `example.com`, `example.net` or `example.org`. |
| Own host | The host is one of: the host of `PUBLIC_URL`, the `publicUrl` of the `mail` setting, `req.hostname`, or a name in `PUBLIC_HOSTS` → **400** `code: 'own_server'`. |
| Limits | §5.6. Exceeding them gives **429** `rate_limited` (from `rateLimit`) or **429** `busy` with `Retry-After: 2` (`fail(429, 'Still working on your last preview.', 'busy', 2)`). |
| Client disconnect | An `AbortController` aborts when `req` emits `close` before the answer is sent; its `signal` goes to every `netguard.request`. |
| 200 answer | `{ preview: Preview \| null, reason?: Reason, cached?: true }` |
| `Preview` | `{ url, title, description, siteName, kind, image }`<br>- `url` is the string the person sent, echoed exactly.<br>- `title`: at most 200 characters. `description`: at most 300. `siteName`: at most 60.<br>- `kind`: `'web' \| 'video' \| 'post' \| 'repo' \| 'image'`.<br>- `image`: `null` or `{ type: 'image/jpeg' \| 'image/png' \| 'image/gif' \| 'image/webp', data: <base64>, width, height, bytes }`. |
| `Reason` | `none` (nothing usable), `not_html`, `blocked` (private address, odd port, http redirect, too many redirects), `unreachable` (DNS, network, status other than 2xx), `timeout`, `challenge` (a bot wall or consent page), `busy` (the target host's limit) |
| GuardError → reason | `PRIVATE`, `NOT_ALLOWED`, `BAD_PROTOCOL`, `BAD_URL` (on a redirect), `REDIRECTS` → `blocked`<br>`NOT_FOUND`, `NETWORK`, `BAD_ENCODING`, status other than 2xx → `unreachable`<br>`TIMEOUT` → `timeout`<br>`ABORTED` → no answer is written |
| Headers | `/api/` answers already get `no-store` and CORP; the gzip wrapper on `res.json` compresses large answers. |

Invalid input gets 4xx. Anything that goes wrong while fetching gets **200 with `preview: null`**, so the chip can just say "No preview" and the call never shows up as an error in the app.

### 5.3 Fetch pipeline and limits

| Constant | Value | Why |
|---|---|---|
| `URL_MAX` | 2048 | Same as `WATCH_URL_MAX`; Signal Desktop treats over 4096 as suspicious |
| `PAGE_MAX_BYTES` | 512 KiB with `truncate: true` | Only `<head>` is needed. WhatsApp tells sites to put their tags in the first 300 KB ([WhatsApp link previews](https://developers.facebook.com/docs/whatsapp/link-previews/)). |
| `IMAGE_MAX_BYTES` | 2 MiB with `truncate: false` (`TOO_BIG` → no image) | Same as Signal's `FAILSAFE_MAX_IMAGE_SIZE` |
| `TOTAL_MS` | 10,000 for page and image together; page at most 7,000; image gets what is left, at least 1,500 | One budget, like netguard's own deadline |
| Redirects | page 4, image 3 | Like `safeGet` and `safeFetch` |
| `PARSE_LIMIT_MS` | 2,000 (`LINK_PREVIEW_PARSE_LIMIT_MS`) | Like `FEED_PARSE_LIMIT_MS` |
| Image dimensions | each side 48–8192 px; area at most 25,000,000 px | Drops tracking pixels and decompression bombs before they reach the browser |

**Page request.**
```js
netguard.request(fetchUrl /* hash removed */, {
  protocols: ['https:'], allowUrl: hopOk, allowPrivate: ALLOW_PRIVATE, maxRedirects: 4,
  timeout: Math.min(7000, deadline - Date.now()), maxBytes: 512 * 1024, truncate: true, decompress: true, signal,
  headers: {
    'User-Agent': `Mozilla/5.0 (compatible; HearthLinkPreview/${version}; +self-hosted chat)`,
    Accept: 'text/html,application/xhtml+xml;q=0.9,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1',
    'Accept-Language': process.env.LINK_PREVIEW_ACCEPT_LANGUAGE || 'en',
  },
});
// hopOk(u): https, (ALLOW_PRIVATE || u.port === ''), host not an IP literal, not reserved, not one of ownHosts
```
- **No cookies, Referer or Authorization.** netguard sends only the headers it is given.
- **`Accept-Language` is the same for the whole instance,** as Synapse does it. The person's own header is never forwarded, so the site can't fingerprint them.
- **Answer:**
  - A status other than 2xx → `unreachable`.
  - A final URL on `consent.youtube.com` or `consent.google.com` → `challenge`.
  - Content-Type `text/html` or `application/xhtml+xml` → parse it.
  - `image/(jpeg|png|gif|webp)` and not truncated → an image-only preview (`kind: 'image'`, title `''`).
  - Anything else → `not_html`.

**Image request.** Only one candidate is ever fetched (§5.4):
```js
netguard.request(imgUrl, { protocols: ['https:'], allowUrl: hopOk, allowPrivate: ALLOW_PRIVATE, maxRedirects: 3,
  timeout: Math.max(1500, deadline - Date.now()), maxBytes: 2 * 1024 * 1024, signal,
  headers: { 'User-Agent': UA, Accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9' } });
```

**`sniffImage(buf)`** reads the type from the bytes and ignores the header:
- JPEG: `FF D8 FF`.
- PNG: `89 50 4E 47 0D 0A 1A 0A`.
- GIF: `GIF87a` or `GIF89a`.
- WebP: `RIFF....WEBP`.

Dimensions:
- PNG: IHDR, bytes 16–23, big-endian.
- GIF: bytes 6–9, little-endian.
- WebP: `VP8 ` frame header, `VP8L` 14-bit fields, or the `VP8X` 24-bit canvas.
- JPEG: walk the markers to the first SOFn (C0–C3, C5–C7, C9–CB, CD–CF), at most 4096 markers (as `MAX_JPEG_MARKERS` in `imagemeta.js`).

Unknown types (SVG, AVIF, ICO, BMP…) or dimensions out of range → `image: null`, and the text part of the preview is still returned. The image bytes aren't cleaned on the server: the sender's device re-encodes them through a canvas, which drops EXIF and other metadata.

**Memory bound.** At most 8 in flight × (512 KiB page + 2 MiB image + about 2.7 MiB base64) ≈ 42 MiB in the worst case.

### 5.4 Parsing (in the worker; linear and never executed)
1. **`decodeHtml(bytes, contentType)`** follows a simplified WHATWG encoding-sniffing order ([HTML spec, "encoding sniffing algorithm"](https://html.spec.whatwg.org/multipage/parsing.html#encoding-sniffing-algorithm)):
   1. Byte order mark (`EF BB BF` → UTF-8; `FE FF` / `FF FE` → UTF-16BE/LE).
   2. The `charset=` parameter of `Content-Type`.
   3. A prescan of the first 4096 bytes, read as latin1, for `<meta charset=…>` or `<meta http-equiv="content-type" content="…charset=…">`. The spec suggests 1024 bytes; we scan a bit more.
   4. Default UTF-8.

   A label found by the prescan that is `utf-16be`/`utf-16le` becomes UTF-8, and `x-user-defined` becomes windows-1252, as the spec's prescan rules say. Check each label with `try { new TextDecoder(label) }` and decode with `fatal: false`. Node 22 builds come with full ICU, so `windows-1252`, `shift_jis`, `gbk`, `euc-kr`, `big5` and the rest work ([Node: WHATWG supported encodings](https://nodejs.org/docs/latest-v22.x/api/util.html#whatwg-supported-encodings)). The Docker image is `node:22.23-bookworm-slim`.
2. **Cut to the head.** Make one lowercase copy. Slice at the first `</head` or `<body`, and at 512 Ki characters at most.
3. **Tokenizer.** Use indexOf and a small state machine, never regexes with nested quantifiers on unbounded input (unlike activity.js `og()`):
   - Skip `<!-- … -->` comments.
   - Skip the raw-text elements `script`, `style`, `noscript`, `template`, `textarea`, `xmp` up to their closing tags, found in the lowercase copy.
   - Find the end of each tag while respecting quotes, scanning at most 8 KiB per tag; a tag that runs over or breaks is given up on from where its scan stopped (never back to just after its `<`; see the build notes). Read at most 4,000 tags.
   - Attribute parser: at most 32 attributes, names up to 64 characters, values up to 4096; handles double-quoted, single-quoted and unquoted values.
4. **Collect the first value** of each of these. The first tag wins, which is the OpenGraph rule for repeated tags ([ogp.me #array](https://ogp.me/#array)).
   - `meta[property|name]`, key lowercased: `og:title`, `og:description`, `og:site_name`, `og:type`, `og:image`, `og:image:url`, `og:image:secure_url`, `og:image:width`, `og:image:height`, `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`, `twitter:image:src`, `description`, `application-name`.
   - `link[rel~=image_src][href]`.
   - The first `<title>` text, at most 2,000 characters.

   X/Twitter card tags are read as a fallback for OpenGraph ([X Cards markup](https://developer.x.com/en/docs/x-for-websites/cards/overview/markup)).
5. **Choose.**
   - title = `og:title` ‖ `twitter:title` ‖ `<title>`.
   - description = `og:description` ‖ `twitter:description` ‖ `description`.
   - siteName = `og:site_name` ‖ `application-name`.
   - Image candidates, in order: `og:image:secure_url`, `og:image`, `og:image:url`, `twitter:image`, `twitter:image:src`, `image_src`. Resolve each against the **final** URL (`r.url`). An `http:` candidate becomes the same URL with `https:`. Skip `data:` and anything else. Take the first that parses.
6. **`looksLikeChallenge`.** A title matching `/^(just a moment\.\.\.|attention required!|access denied|are you a robot|before you continue)/i` → `challenge`, with no preview.
7. **`cleanText(s, max)`**, applied to every text field:
   1. Strip tag-shaped `<…>` fragments of up to 500 characters (built: before decoding, see the build notes).
   2. `decodeEntities` once: numeric entities for code points 1–0x10FFFF excluding surrogates, plus a named table (built: HTML 4's whole set and the ASCII punctuation names).
   3. Remove C0/C1 controls, U+200B, U+FEFF and the bidi controls U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069. U+200D (zero-width joiner, used in emoji) is kept.
   4. Collapse whitespace, normalize to NFC, trim.
   5. Cut by **code points**, not UTF-16 units, and add `…` when cut.
8. If there is no title, no description and no image → `{ preview: null, reason: 'none' }`.

### 5.5 Special handling for some sites

**YouTube.**
- Hosts: `youtube.com` (also with `www.`, `m.` or `music.`), `youtu.be`, `youtube-nocookie.com`.
- `youtubeId(u)` follows exactly the rules in `parseWatchUrl()`: `?v=`, `/shorts/`, `/embed/`, `/live/`, `/v/`, `youtu.be/<id>`, with the id matching `[\w-]{11}`. Either refactor `parseWatchUrl` to call it, or add a test that both agree.
- Fetch `${LINK_PREVIEW_YOUTUBE_OEMBED || 'https://www.youtube.com/oembed'}?format=json&url=` + `encodeURIComponent('https://www.youtube.com/watch?v=' + id)` through netguard, with `allowUrl` limited to the base's host, 64 KiB and 5 s. `watchTitle()` and activity.js `fromLink()` already depend on this endpoint. The [oEmbed spec](https://oembed.com/) defines `title`, `author_name` and `thumbnail_url`.
- Result: title = `title`; description = `author_name`; siteName `YouTube`; kind `video`.
- Image: `${LINK_PREVIEW_YTIMG_BASE || 'https://i.ytimg.com'}/vi/<id>/mqdefault.jpg` (320×180, no letterbox). If that gives 404, use `hqdefault.jpg` (480×360). The URL is built from the id; `thumbnail_url` from the answer isn't trusted. These file names are a convention, not a documented API ([dev.to](https://dev.to/alexlv_cheng/how-youtube-thumbnail-urls-work-a-simple-guide-36i6)), hence the fallback.
- If oEmbed fails (private, removed or age-restricted video) → `none`. **The watch page is never fetched**: it is large, rendered by JavaScript, and EU servers get consent walls.
- The card appears next to the existing "Watch together" chip.

**X / Twitter.**
- Hosts: `twitter.com` (also `www.` and `mobile.`), `x.com`, `www.x.com`. Path `/<handle>/status/<id>`, with handle `[A-Za-z0-9_]{1,15}` and id `\d{1,20}`. Extra segments such as `/photo/1` are ignored.
- Fetch `${LINK_PREVIEW_X_OEMBED || 'https://publish.twitter.com/oembed'}?url=` + `encodeURIComponent('https://twitter.com/<handle>/status/<id>')` + `&omit_script=1&dnt=true&hide_thread=true` through netguard, allowing only that host, 64 KiB and 5 s.
- Take `author_name`. For the text, take the inner part of the first `<p…>…</p>` in `html`, turn `<br>` into a space, strip tags, run `decodeEntities` then `cleanText(…, 300)`. The HTML is parsed, **never rendered**.
- Result: title `"<author_name> (@handle)"`, siteName `X`, kind `post`, no image.
- On failure, and for any other X URL (profiles, search), → `none`. x.com and twitter.com pages are never fetched.
- This is **best effort.** Third-party reports say this endpoint has been unreliable since 2023 ([Princeton](https://resources.princeton.edu/layout-blocks/blocks-reference/twitter), [WordPress #59142](https://core.trac.wordpress.org/ticket/59142)). Its status in October 2026 is not verified.

**GitHub.**
- `github.com` and `gist.github.com` go through the generic path. kind is `repo` when the host is `github.com`.
- Images usually come from `opengraph.githubassets.com`, where GitHub generates cards for repositories, issues, pull requests and commits ([GitHub blog](https://github.blog/open-source/git/framework-building-open-graph-images/)), or from `avatars.githubusercontent.com`. Both pass the generic rules.
- **Don't use `api.github.com`:** it allows 60 unauthenticated requests per hour per IP ([GitHub docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
- Private repositories answer 404 → `none`. The server never has a GitHub login, so private content is never previewed.

**Every other host** goes through the generic path (§5.3–5.4).

### 5.6 Rate limits and concurrency

| Key | Limit | Counted |
|---|---|---|
| `lp:<uid>` | 20 per minute | Every call, including cache hits |
| `lps:<sessionId>` | 20 per minute | Every call |
| `limitNet(req, 'lp', 60, 60000)` | 60 per minute per network (IPv4 address or IPv6 /64) | Every call |
| `lpf:<uid>` | 100 per hour | Cache misses only (real outbound fetches) |
| In flight per user | 2 | → 429 `busy`, `Retry-After: 2` |
| In flight instance-wide | 8 | → 429 `busy` |
| `countHit('lphost:' + host, 60000)` | over 60 per minute per **target host**, instance-wide | → 200 `{ preview: null, reason: 'busy' }`, not cached |
| `api:<uid>` (existing) | `API_RATE_LIMIT` | Applies automatically through `auth` |

The per-host counter is shared across accounts but only counts. It answers with a generic `busy`; the target host is never logged.

### 5.7 Cache: per user, short-lived, never shared
- A `Map` keyed by `` `${userId}\n${fetchUrl}` `` (the URL with the `#` part removed) → `{ expires, preview, reason, bytes }`.
- Lifetime: 10 minutes for a preview. 2 minutes for `none`, `not_html`, `blocked`, `unreachable`, `timeout` and `challenge`. `busy` is never cached.
- At most 20 entries per user (oldest dropped first). Instance-wide at most 2,000 entries and at most 48 MiB of image data, evicting the least recently used.
- In-flight requests are de-duplicated by the same key, so only for the same account.
- A sweep runs every minute: `jobs.every('linkpreview.cache_sweep', 60000, sweep)`.
- Nothing is persisted, written to disk or backed up. Unlike `data/cache/art`, nothing is shared.
- **Why it is never shared between accounts:**
  1. **Timing:** a fast answer would tell B that someone else previewed this URL in the last 10 minutes.
  2. **Poisoning:** a page whose content changes per request or over time would make A's copy what B sees.
  3. **Consent:** B's preview should come from B's own request.

  The cost is duplicate fetches of popular links, which is acceptable for small communities and bounded by the per-host limit.

### 5.8 Logging
- Use `const L = log.child('linkpreview')`. Write one `debug` line per call: `{ outcome, reason, kind, cached, ms, imageBytes }`.
- **Never log the URL, the host, the title or `e.message`** (GuardError messages contain the host). Log `e.code` only.
- The access log already records only the route template `/api/link-previews`, a keyed user hash and a shortened IP (ARCHITECTURE §12).

### 5.9 Feature switch and environment
- `FEATURE_DEFAULTS` gains `linkPreviews: process.env.LINK_PREVIEWS !== 'false'`.
- In `PUT /admin/owner`, the list `['customCss','comments','watch','gifs']` becomes `[…, 'linkPreviews']`. The change is audit-logged by the existing `adminLog(req, 'owner_settings', …)`, and `config:update` already sends `features()`. `GET /api/config` returns it in `features`.
- New environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `LINK_PREVIEWS` | `true` | Default for the owner switch |
| `LINK_PREVIEW_ACCEPT_LANGUAGE` | `en` | Instance-wide `Accept-Language` sent to sites |
| `LINK_PREVIEW_PARSE_LIMIT_MS` | `2000` | Time limit for the parser worker |
| `LINK_PREVIEW_ALLOW_PRIVATE` | off | `1` allows private addresses and ports other than 443. **Tests only**, like `FEED_ALLOW_PRIVATE`. |
| `LINK_PREVIEW_YOUTUBE_OEMBED`, `LINK_PREVIEW_YTIMG_BASE`, `LINK_PREVIEW_X_OEMBED` | real endpoints | Stand-ins for tests, like the `BASE` overrides in activity.js |

### 5.10 Data model
**No changes.** `SCHEMA_VERSION` stays 18. There is no migration and no new tables or columns. No `blobs` or `user_files` rows are created. The only new stored state is the `linkPreviews` key inside the `instance_settings` `features` JSON. Message rows keep their shape; previews only make their `ciphertext` longer.

### 5.11 Socket events
**None added or changed.** `message:new`, `message:update` and `dm:message` carry the same opaque ciphertext. No new client-to-server events either: everything goes over REST, following the existing convention (ARCHITECTURE §2).

---

## 6. The preview image: inline thumbnail or encrypted attachment?

| Criterion | Inline ≤16 KiB thumbnail in the ciphertext (**chosen**) | Encrypted attachment (`encryptFile` + `/upload/encrypted`), as Signal does |
|---|---|---|
| Message size | About 22 K extra base64 characters → a ciphertext of about 29–31 K characters. That is under `validCipher`'s 64,000 even with long text (§7.4). | Message stays about 0.5 KB; the blob is separate. |
| History and search pages | 100 messages, *all* with previews, ≈ 3 MB instead of about 70 KB. Search decrypts up to 1,000 messages per click. Acceptable because previews are a small share of messages; gzip runs off the main thread. | Smaller pages; the picture loads lazily through `whenVisible`. |
| What readers reveal | Nothing beyond fetching the history page. | A `GET /uploads/<id>.bin` (no sign-in, IP visible) **each time a reader scrolls to it**: a per-message "who looked at it" signal. |
| What the server learns from size | The ciphertext jumps in size. But the server already knows a preview was made, because it fetched it. | Blob of exact size + 28 bytes, uploaded right after the fetch. Same knowledge. |
| Permissions | No effect on the server. | Declaring the blob in `files` hits the server's ATTACH_FILES check, so someone allowed to embed but not attach couldn't send a picture. That needs a new body field and a route change. |
| Editing | The edit carries the preview unchanged (§8.5). | `PATCH /messages/:id` takes no `files`, so a new picture would be deleted as unlinked after 24 h. |
| Forwarding | Re-encrypted with the message; works. | Points at another message's blob, which breaks when the original is deleted. This already happens to forwarded files today. |
| Quotas and cleanup | None needed. | Counts toward `user_files`; needs `attachBlobs` raised past 20 and the 24 h cleanup. |
| Picture quality | Up to 400 px, ladder of quality settings. | Could be full size. |

**Decision: inline.** Signal uses attachments because its CDN and protocol are built around them. Hearth's 64 KB ciphertext ceiling, its unauthenticated `/uploads/` (which turns each view into server-side metadata) and the ATTACH_FILES and PATCH gaps all make inline the simpler and more private choice. If a later version needs full-size pictures, add an optional `img.att` attachment pointer next to the inline thumbnail (§14).

---

## 7. Payload format

### 7.1 Schema
```json
{
  "t": "look at this https://example.org/a",
  "f": [],
  "l": [{
    "v": 1,
    "url": "https://example.org/a",
    "title": "Page title",
    "desc": "Short description",
    "site": "Example",
    "kind": "web",
    "img": { "type": "image/webp", "data": "<base64, ≤ 21848 chars>", "w": 400, "h": 210 }
  }]
}
```
- `l` is present only when there is a preview. Never write `l: undefined` or `l: []`.
- `kind` is one of `web`, `video`, `post`, `repo`, `image`. `img` is optional.

### 7.2 Rules for the sender
- Exactly one entry.
- `url` is the exact substring `linkedUrls(t, { skipSpoilers: true })` returned.
- The fields are the server's values, capped again on the device.
- `img` comes from `previewThumb()`: type `image/webp` or `image/jpeg`; `w` and `h` from 1 to 400.

### 7.3 Rules for readers: `cleanLinks(list, text)` in `public/js/linkpreview.js`
```js
export function cleanLinks(list, text) {
  if (!Array.isArray(list)) return undefined;
  const linked = new Set(linkedUrls(text, { skipSpoilers: true }));
  for (const x of list.slice(0, 3)) {                 // looks at 3 entries, keeps the first good v1 one
    if (!x || typeof x !== 'object' || x.v !== 1) continue;
    const url = typeof x.url === 'string' ? x.url : '';
    if (!linked.has(url) || !previewableUrl(url)) continue;
    const out = { v: 1, url, title: cleanText(x.title, 200), desc: cleanText(x.desc, 300),
      site: cleanText(x.site, 60), kind: KINDS.has(x.kind) ? x.kind : 'web' };
    const img = cleanImg(x.img);                       // base64 ≤ 21848, magic WebP/JPEG, w/h 1..400
    if (img) out.img = img;
    if (out.title || out.desc || out.img) return [out];
  }
  return undefined;
}
```
`previewableUrl` applies these checks:
- https only;
- no user name or password;
- port empty;
- length at most 2048;
- host not an IP literal, at least 2 labels, no `%`, not a reserved name;
- **no mixed-script host** (test the raw host substring of the original text for both ASCII and non-ASCII letters, as Signal's `isLegalUrlInternal` does);
- no U+202A–U+202E, U+2066–U+2069 or U+2500–U+25FF anywhere in the URL.

### 7.4 Versioning and size
- **Versioning is per entry, through `v`.** Readers show only `v === 1` and ignore unknown keys; an unknown `kind` becomes `web`. A future format can be sent as `l: [{ v: 2, … }, { v: 1, … }]`; readers take the first entry they understand.
- **Older apps** (tabs or desktop and Android windows still running the previous JavaScript) drop `l` in `openGroup` and `openDm` and show the linkified URL as before. After an update the app reloads itself on reconnect when `/api/config` `version` changes (ARCHITECTURE §9), so this period is short.
- **Integrity.** The channel signature covers the whole ciphertext, so the card is provably the author's. DMs stay unsigned (deniable), as before.
- **Size.** Add `CIPHER_MAX = 64000` to `app.js`, mirroring `validCipher` in `server/index.js`, with a comment pointing at each other. `payloadVariants(payload)` in `linkpreview.js` returns, in order:
  1. the payload as it is;
  2. the payload with `l[0].img` removed;
  3. the payload without `l`.

  `encryptFitting(payload, encrypt)` in `app.js` encrypts each variant in turn and uses the first whose ciphertext is at most `CIPHER_MAX`. If even the last one is too long, it is sent as today and the server's existing 400 applies, so long messages without previews behave exactly as before.
  - Worst realistic case: 4,000 characters of text (`maxlength` on the textarea) plus a full preview ≈ 47 KB of padded plaintext → 62–63 K characters, which fits.
  - Text full of characters that JSON escapes (`"`, `\`, control characters) can push it over. Then the image is dropped first.

---

## 8. Client changes, file by file

### 8.1 `public/js/markdown.js`
- `export const URL_RE` (the existing regex, unchanged).
- New `export function linkedUrls(text, { skipSpoilers = false } = {})`:
  1. remove ```` ``` ```` blocks and `` `inline` `` code with the same regexes `render()` uses;
  2. if `skipSpoilers` is set, remove `||…||` spans;
  3. return `s.match(URL_RE) || []`.

This is the single source of "which URLs does the message link to", for both the sender and readers.

### 8.2 New `public/js/linkpreview.js`
Pure functions with no DOM access at the top level, so `node --test` can import it (as with `attachments.js` and `search-query.js`). It imports only `linkedUrls` from `markdown.js`.
- Constants: `THUMB_MAX_BYTES = 16384`, `THUMB_B64_MAX = 21848`, `TITLE_MAX = 200`, `DESC_MAX = 300`, `SITE_MAX = 60`, `URL_MAX = 2048`, `KINDS`, `RESERVED_TLDS`, `GIF_MEDIA_RE`. `GIF_MEDIA_RE` is the hosts in `gifmedia.js` `MEDIA_HOSTS` plus `media.tenor.com` and `c.tenor.com`, matching `isGiphy` and `MEDIA_HOST_RE`.
- `previewableUrl(url, { origin })`: §7.3, plus "not the same host as `origin`".
- `findPreviewUrl(text, { origin })`: the first URL from `linkedUrls(text, { skipSpoilers: true })` that is `previewableUrl`, is not `isImageUrl` (markdown.js), and does not match `GIF_MEDIA_RE`.
- `looksPrivate(url)`: §3.4.
- `cleanText`, `cleanImg`, `cleanLinks`, `payloadVariants`, and `hostLabel(url)`, which returns `new URL(url).hostname` without a leading `www.`.

### 8.3 `public/js/secure.js`
- `import { cleanLinks } from './linkpreview.js';`
- In `openGroup()`, after `const { payload, signedBy } = await E2EE.decryptGroup(…)`, compute `const l = cleanLinks(payload.l, String(payload.t || ''));` and add `...(l ? { l } : {})` to the returned object. Do the same in `openDm()`.
- `openLegacy()` is unchanged: bot and news posts keep `embed`.

### 8.4 `public/js/media.js`
New `export async function previewThumb(bytes, type)`:
1. `createImageBitmap(new Blob([bytes], { type }))`.
2. For each `[side, q]` of `[[400,.72],[320,.62],[240,.55]]`: `const r = await scaled(bitmap, side, q)`. If `r.blob && r.blob.size <= 16384`, return `{ type: r.blob.type, data: E2EE.b64(await r.blob.arrayBuffer()), w: r.w, h: r.h }`.
3. Otherwise return `null`, and also return `null` if decoding throws.
4. Close the bitmap in `finally`.

GIFs keep only their first frame. Re-encoding through the canvas removes EXIF and other metadata, as `prepareImage` already does.

### 8.5 `public/js/app.js`

**Preferences and helpers**
- `P.chat` (≈ line 117): add the defaults `linkPreviews: 'ask'` and `linkCards: true`.
- Next to `textOf` and `filesOf`: `const linksOf = (m) => (m.dec && m.dec.l) || [];`
- Next to `senderMayPingEveryone()`:
  ```js
  function senderMayEmbed(m) {           // members' apps enforce EMBED_LINKS; the server can't
    if (m.dmId) return true;
    const server = S.servers.find((x) => x.id === m.serverId);
    return !!server && has(basePerms(server, m.authorId), PERMS.EMBED_LINKS);
  }
  ```
  This is the same compromise as for @everyone: other members' apps can't see channel overrides. For groups, `basePerms` returns `GROUP_MEMBER`, which includes EMBED_LINKS.

**`linkCardEl(l)`**, next to `newsCard()`. Use **`h()` with text children only — never `html:` and never `md()`.**
```js
function linkCardEl(l) {
  const host = hostLabel(l.url);
  const big = l.img && l.img.w >= 280 && l.img.w / l.img.h >= 1.3;
  return h('a', { class: `news-card link-card kind-${l.kind}${big ? ' big' : ''}`, href: l.url, title: l.url,
      target: '_blank', rel: 'noopener noreferrer nofollow' },
    h('div', { class: 'news-text' },
      h('span', { class: 'news-source' }, l.site || host),
      l.title ? h('span', { class: 'news-title' }, l.title) : null,
      l.desc ? h('span', { class: 'news-summary' }, l.desc.length > 220 ? `${l.desc.slice(0, 220)}…` : l.desc) : null,
      h('span', { class: 'news-meta' }, host)),            // always the reader's own reading of the URL
    l.img ? h('img', { class: 'news-img link-img', src: `data:${l.img.type};base64,${l.img.data}`, alt: '',
      width: l.img.w, height: l.img.h, loading: 'lazy', decoding: 'async' }) : null);
}
```
- `href` comes only from `l.url`, which `cleanLinks` already limited to https links in the text.
- External opening already works in the apps: desktop `setWindowOpenHandler` → `shell.openExternal` for `^https?:`; Android `shouldOverrideUrlLoading` → `ACTION_VIEW`.

**`fillMessage()`** (≈ line 2704), in the readable branch:
- Right after the `msg-text` element:
  ```js
  const links = chat.linkCards !== false && senderMayEmbed(m) ? linksOf(m) : [];
  if (links.length) body.append(h('div', { class: 'msg-links' }, links.map(linkCardEl)));
  ```
- Change the image embeds to `const embeds = chat.embeds ? extractImageUrls(text).filter((u) => !links.some((l) => l.url === u)) : [];` as a safeguard.

**`createComposer()`**
- New state: `state.link = null | { key, url, status: 'ask'|'private'|'loading'|'ready'|'none'|'error', entry, msg }` and `state.linkDismissed = new Set()`.
- **Detection** (`checkLink()`):
  - Runs at once on `paste`. On `input`, it runs only when the URL found is followed by whitespace and the caret is outside it (built: so editing inside a link counts as typing it), or after 1,200 ms of idle typing (`debounce` from `util.js`). This avoids fetching URLs that are still being typed.
  - It is skipped when:
    - `(S.config.features || {}).linkPreviews === false`;
    - `P.chat.linkPreviews === 'never'`;
    - a slash command is being typed (`slashChannel() && SLASH.match(…)`);
    - the channel denies EMBED_LINKS (`ch && !canIn(ch, PERMS.EMBED_LINKS)`), or (built) the person lacks it server-wide (`!mayEmbed(server, S.me.id)`), which is what readers check;
    - the URL is in `state.linkDismissed`.
  - It **does not run on draft restore** (`ta.value = drafts.get(…)`), so switching channels never sends a request.
- **Mode.** `'ask'` → status `ask`, with no network request. `'always'` → status `private` if `looksPrivate(url)`, else `requestPreview(url)`.
- **`requestPreview(url)`:**
  1. `const gen = ++linkGen;`
  2. `api('POST', '/link-previews', { url })`.
  3. If `gen` is stale or `url` is no longer `findPreviewUrl(ta.value)`, ignore the answer (`api()` has no `AbortSignal`).
  4. Build `entry = { v: 1, url, title, desc: description, site: siteName, kind }`.
  5. If `image` is present: `img = await previewThumb(base64ToBytes(image.data), image.type)`.
  6. Status `ready`, or `none` / `error` with a message such as the 429 text.
- **Chip.** `linkChip()` is drawn in `renderExtras()` after the reply bar and before `pending-files`, inside `role="status"` with `aria-live="polite"`:
  - `ask`: "Preview example.org? Your Hearth server fetches the page, so it sees this link. People reading don't contact the site." with buttons [Preview], [Always] (sets `hearth.chat.linkPreviews = 'always'`) and [×].
  - `private`: "This link may be private (a sign-in, share or reset link)." with [Preview anyway] and [×].
  - `loading`: spinner, "Getting a preview…", [×].
  - `ready`: small thumbnail, the title, the host, and [×] with the label "Remove link preview".
  - `none` / `error`: a short muted note that hides itself after 4 s; [×].
  - [×] adds the URL to `state.linkDismissed` and clears `state.link`.
- **Changing conversation.** When `key() + (threadId() || '')` no longer equals `state.link.key`, clear `state.link` in `renderExtras()`.
- **`send(overrideText, extra)`:**
  - Attach a preview only when `overrideText == null` and there is no poll or voice message. The GIF picker's `send(url)`, polls and voice messages never get previews.
  - Attach only if `state.link.status === 'ready'` and `linkedUrls(text, { skipSpoilers: true }).includes(state.link.url)`. Then pass `links: [state.link.entry]` to `deliver`.
  - **Don't wait for a preview that is still loading**: send without it.
  - Clear `state.link` and `state.linkDismissed` after sending.
- **`deliver()`:**
  - The payload becomes `{ t: text, f, ...(poll ? { p: poll } : {}), ...(links ? { l: links } : {}) }`.
  - On failure, when the text is put back into the box, put `state.link` back too.

**`sendTo()`** (≈ line 4146):
- Channel: wrap the encryption in `encryptFitting(payload, (p) => sec.encryptChannel(server.id, channelId, p))` inside `withKeyRetry`.
- DM: `encryptFitting(payload, (p) => sec.encryptDm(key.slice(2), p))`.
- `mentionedIds` and `everyone` still read `payload.t`.

**`editBox()` save:** keep the previews whose URL is still linked in the edited text.
```js
const kept = linksOf(m).filter((x) => linkedUrls(content, { skipSpoilers: true }).includes(x.url));
const payload = { t: content, f: filesOf(m), ...(kept.length ? { l: kept } : {}) };
```
Then encrypt through `encryptFitting`. No new preview is fetched for links added in an edit (§14).

**`openForward()`:** `sendTo(d.key, null, { t: fwd, f: filesOf(m), ...(linksOf(m).length ? { l: linksOf(m) } : {}) }, null)`. The quoted `> ` lines still contain the URL, so readers keep the card.

**Optional:** in `pendingEl()`, put `l` in the fake `dec` so the "sending…" copy already shows the card.

### 8.6 `public/js/settings.js` → `chatTab()` (≈ line 1300)
- Add `linkPreviews: 'ask', linkCards: true` to the `cur()` defaults.
- New `section('Link previews', …)`:
  - A `<select>`, built like the notification selects: "When I send a link" with *Ask each time* (default), *Always*, *Never*. Hint: "To build a preview, your Hearth server fetches the page for you, so it sees the link (not your message). The site sees the server, not you."
  - A toggle, "Show link previews in messages" (`linkCards`). Hint: "Built by the sender and sent inside the encrypted message: your device never contacts the linked site."
  - The existing "Show image links as previews" toggle and its IP warning stay as they are.

### 8.7 `public/js/admin.js` → owner features
Next to `sw('Watch together', 'watch', …)` (≈ line 771): `sw('Link previews', 'linkPreviews', 'Members can ask this server to fetch a page so their message carries a preview. The server sees those links; people reading never contact the site.')`.

### 8.8 `public/js/perms.js`
Change the EMBED_LINKS description to: "Their links show a preview card and image links show as pictures. Members' apps enforce this."

### 8.9 `public/js/usability.js` (export, ≈ line 223)
After `rec.text`: `if (m.dec.l && m.dec.l[0]) rec.link = { url: m.dec.l[0].url, title: m.dec.l[0].title, description: m.dec.l[0].desc, site: m.dec.l[0].site };`. The thumbnail is not exported. Update the export README text in the same file to mention "link previews".

### 8.10 `public/css/app.css`
- `.link-card` reuses `.news-card` (≈ line 2563).
- `.link-card.big` stacks the image under the text at most 400 px wide.
- Border colours: `.link-card.kind-video` red like `.kind-youtube`, `.kind-repo` like `.kind-github`, `.kind-post` neutral.
- `.link-chip` follows `.reply-bar` and `.pending-files`.
- `.news-title, .news-summary { unicode-bidi: isolate; }` so right-to-left titles can't reorder the text around them.

### 8.11 No changes needed
- `mobile/native/*.java` and `desktop/*.js`: they don't parse message payloads.
- `public/sw.js`: `APP_ASSETS` is built by walking `public/js`, so the new module is included automatically.
- `.github/workflows/hearth-apps.yml`.

---

## 9. How this fits with existing embeds, GIPHY, news cards and watch together
- **Image-URL embeds** (`extractImageUrls`, which readers' browsers load from third-party sites): unchanged. The composer **does not offer previews** for `isImageUrl()` URLs, so the existing path keeps handling them.
  - A URL without an image extension that answers with `image/*` gets an image-only card (`kind: 'image'`). That is better for privacy: readers don't hot-link it.
  - The renderer drops an image embed whose URL also has a card.
  - The SECURITY.md §4 note "image links in messages" leak the reader's IP still applies; Phase 2 could fix it (§14).
- **GIPHY / KLIPY / Tenor:**
  - The GIF picker sends `send(url)` (override text), so no chip or preview is involved. `isOnlyImageUrl` hides the text, and `mediaUrl()` loads GIPHY and KLIPY through `/media/gif` with the media token, as before.
  - `findPreviewUrl` skips `GIF_MEDIA_RE` hosts.
  - A GIPHY *page* link (`giphy.com/gifs/…`) gets an ordinary OpenGraph card with a first-frame thumbnail, fetched by the server directly (not through `fetchGifMedia`), once, for that sender only.
- **News-bot and bot posts:** they keep `m.dec.embed` → `newsCard()` with the `/media/news` proxy. Link cards never use `/media/news`.
- **Watch together:** `watchChips(text)` is unchanged. A YouTube link shows both the card and the "Watch together" button.
- **EMBED_LINKS:** now meaningful. The sender's composer offers previews only with `canIn(ch, PERMS.EMBED_LINKS)` and the server-wide permission readers check (`mayEmbed`); readers show cards only when `senderMayEmbed(m)`. Gating the existing image embeds the same way is a separate, optional commit (a behaviour change; §15 step 11).
- **Spoilers and code:** a URL inside `||…||` or code is never previewed. Readers reject a preview whose URL appears only there (`skipSpoilers`).

---

## 10. Edge cases

| Case | Behaviour |
|---|---|
| Person types, pastes, then deletes the link | "Ask": no request was ever made. "Always": the request may already have gone out. The settings copy says so. |
| Link still being typed | The fetch starts only after whitespace, on paste, or after 1.2 s idle, and only for the current URL. Stale answers are ignored (`linkGen`). |
| Sending before the preview is ready | Sent without a preview; never blocks. |
| Several links | Only the first eligible one gets a preview. |
| Link inside code, inline code or a spoiler | Not offered; dropped by readers. |
| Link to this Hearth server (invites, `/#m/` links) | Not offered (same origin), and the server answers 400 `own_server`. |
| `http://` link, IP address, `.local`/`.lan`/`.test`/`.onion`, a port other than 443, credentials in the URL | Not offered; the server answers 400. |
| Redirect to http, to a private address or to an odd port | netguard or `hopOk` refuse → `blocked`. |
| Link shortener (bit.ly) | The card shows the destination's title, but the domain line shows `bit.ly` (from the URL in the text). Open question about showing "→ destination". |
| Page with tags after 512 KiB, or rendered by JavaScript only | `none` or `<title>`-only. |
| Non-UTF-8 page | Decoded by §5.4 step 1. Wrong labels fall back to UTF-8 with replacement characters. |
| Huge or endless page, gzip bomb, slow site | netguard's streamed cap (on unpacked bytes), `truncate`, and the 10 s total deadline. |
| `og:image` missing, http-only, private, SVG, too large, 1×1 or 100000×100000 | `image: null`; the text card is kept. |
| Cloudflare "Just a moment…" or a consent wall | `challenge` → no preview. |
| 401/403/404/429/5xx | `unreachable` → no preview. Negative answers are cached for 2 minutes for that user only. |
| Unlisted YouTube video, private repo, protected post | Whatever the public answer is; usually `none`. The server never has the person's logins. |
| Rate limited | The chip shows the 429 message briefly. Sending is never affected. |
| Owner switches the feature off mid-session | `config:update` hides chips; the server answers 404. Existing cards still render, because they are just ciphertext. |
| Reader has `linkCards` off, or the sender lacks EMBED_LINKS | No card; the linkified text stays. |
| Edit removes the URL | The preview is dropped from the edited payload. A newly added URL in an edit gets no preview (v1). |
| Edit of a message with a preview and very long new text | `encryptFitting` drops the image first, then the preview. |
| Forward to a DM, group or channel | The card is carried along, re-encrypted. Readers there still require the URL in the quoted text. |
| Message from a blocked user | Hidden as today; the card is inside the hidden body. |
| Right-to-left, emoji or zero-width text in titles | Bidi controls stripped; U+200D kept; CSS `unicode-bidi: isolate`. |
| Homograph domain (`аpple.com` in Cyrillic) | Mixed script → no preview on either side. Hosts entirely in one non-Latin script show as punycode. |
| Reports to moderators | Evidence is the plaintext the reporter submits (`textOf`); cards are not included, unchanged. |
| Search (`has:link`) | Still matches the URL in the text. Preview titles aren't searchable in v1 (§14). |
| Export | `rec.link` metadata, no thumbnail. |
| Bots | They get metadata only and never see previews, unchanged. |
| Server restart | The in-memory cache and rate limits reset (same documented limit as SECURITY.md §4). |
| Hide DMs while screen sharing | Cards in DMs are covered with the rest of the DM. |
| Safari without canvas WebP encoding | `scaled()` already falls back to JPEG; readers accept both. |

---

## 11. Migration and compatibility
- **Database:** none. Schema 18 is unchanged and `db.js` needs no `// v19` block. The upgrade drill (`scripts/upgrade-drill.sh`) and recovery drills are unaffected.
- **Settings:** a missing `features.linkPreviews` falls back to `FEATURE_DEFAULTS`.
- **Rollback** with `hearth-update.sh --rollback`: messages with `l` remain ordinary ciphertext. The old client drops `l` and old server code ignores the extra feature key. Nothing breaks.
- **Old JavaScript still running** (open tabs, PWA, desktop and Android windows): `l` is dropped by the whitelist, so readers see a normal link. These clients can't create previews. They reload by themselves on the next reconnect after the version changes.
- **Native apps:** no rebuild. Desktop and Android load the server's UI, so the feature arrives with the server update. No change to `hearth-apps.yml`.
- **Bots, webhooks and the search API:** unchanged. They return the same ciphertext, now sometimes bigger.
- **Older messages:** have no `l`, so they render exactly as before.

---

## 12. Tests to write

### 12.1 Server: new `test/linkpreview.test.js`
Follow the pattern of `test/outbound-hardening.test.js`:
- A fake DNS preload that maps names such as `blog.preview-site.net`, `github.com`, `www.youtube.com`, `i.ytimg.com` and `publish.twitter.com` to `127.0.0.1`.
- Local **HTTPS** stand-ins made with `selfsigned`, with those names as subject alternative names, trusted through `NODE_EXTRA_CA_CERTS`.
- A `loose` server with `LINK_PREVIEW_ALLOW_PRIVATE=1` and the `LINK_PREVIEW_*_OEMBED`/`YTIMG` stand-ins, and a `strict` server without them.

Tests:
1. `link previews: OpenGraph tags come back as title, description, site name and image` (the image base64 decodes to the served PNG bytes; `width`/`height` are sniffed from the bytes).
2. `link previews: Twitter card tags, <title> and meta description fill in when OpenGraph is missing; the first tag wins`.
3. `link previews: hostile HTML is parsed, never run: scripts, comments, raw-text elements and entity tricks never reach the fields` (an `og:title` inside a comment or `<script>` is ignored; `&lt;img onerror&gt;` becomes plain text with no tags; the title has no `<`).
4. `link previews: fields are capped (200/300/60 code points) and control, bidi and zero-width characters are removed (ZWJ kept)`.
5. `link previews: charset from BOM, Content-Type and <meta charset> (windows-1252, Shift_JIS); a UTF-16 <meta> is read as UTF-8`.
6. `link previews: only https on port 443 with a real host name; IP literals, credentials, reserved names and this server's own host get 400` (including `https://chat.example.test/…`, the tests' `PUBLIC_URL`).
7. `link previews: private, rebinding and disguised addresses are refused before any connection` (strict server; the stand-in's hit counter stays 0; `OUTBOUND_BLOCK` ranges are honoured).
8. `link previews: every redirect is checked again; https→http, a redirect to a private address and a 5-hop chain give no preview`.
9. `link previews: an endless page, a gzip bomb and a slow site end within the deadline; only the head of a 1 MiB page is read`.
10. `link previews: PDF and JSON give no preview; a direct image answer gives an image-only preview`.
11. `link previews: preview images must really be JPEG/PNG/GIF/WebP of sane size; SVG, a PNG claiming 100000×100000, HTML served as image/png and a 3 MB image are dropped, the card is kept`.
12. `link previews: Cloudflare-style challenge and consent pages give reason "challenge"`.
13. `link previews: limits per account, per session, per network and per target host; two in flight per account; cache hits don't use the hourly fetch budget`.
14. `link previews: the cache is per account — another account asking for the same URL triggers its own fetch and gets fresh content` (the stand-in answers differently on each request; check both its counter and the content).
15. `link previews: YouTube links use oEmbed and the video thumbnail; the watch page is never fetched` (watch-page counter stays 0; a removed video gives `none`).
16. `link previews: youtubeId agrees with parseWatchUrl on every YouTube URL form` (a table of URLs).
17. `link previews: X status links use oEmbed text, never fetch x.com, and give none when oEmbed fails`.
18. `link previews: GitHub links go through OpenGraph with kind "repo"`.
19. `link previews: the owner switch turns the route off (404), is audit-logged and reaches /api/config`.
20. `link previews: the requested URL and host never appear in the server log` (`LOG_FORMAT=json`, `LOG_LEVEL=debug`; search `srv.log` for the host and path).
21. `link previews: signed-out, revoked and suspended sessions get 401/403`. The generic sweeps in `access.test.js` and `attack.test.js` (hostile bodies) also pick up the new route automatically; confirm there are no 500s.

### 12.2 Client: new `test/linkpreview-client.test.js`
Uses `import(pathToFileURL('public/js/linkpreview.js'))` and `e2ee.js`, as in `quality-client.test.js` and `search-query.test.js`.

22. `findPreviewUrl: the first https link outside code and spoilers; image links, GIF media links, same-origin links, IP hosts and http links are skipped`.
23. `cleanLinks: kept only when its URL is linked in the text and is https without credentials, mixed-script host or bidi characters; fields are capped`.
24. `cleanLinks: images must be ≤16 KiB base64 WebP/JPEG with matching magic bytes; anything else drops the image, not the card`.
25. `cleanLinks: unknown versions, kinds and extra keys are ignored; at most one card; never throws on junk (null, strings, arrays, prototype keys)`.
26. `looksPrivate: tokens, reset, invite and share links are not previewed automatically`.
27. `payload size: a 4000-character message with a full preview fits in 64,000 ciphertext characters, or payloadVariants drops the image first, then the card` (real `encryptGroup` / `encryptDm` with throwaway keys).
28. `older apps: a payload with l still decrypts, and the previous opener (t, f, p only) shows the text unchanged` (decrypt through `E2EE.decryptGroup` and apply the old whitelist).
29. Static checks, in the style of `files-hardening.test.js` files-5:
    - `secure.js` contains `cleanLinks(` exactly twice (channel and DM);
    - the source of `linkCardEl` in `app.js` contains no `html:` and no `md(`;
    - `app.js` defines `CIPHER_MAX = 64000` and `server/index.js` `validCipher` still uses `64000`.

### 12.3 Browser (Playwright; run outside CI with `npm run test:e2e`)
30. Add to `test/e2e/flows.mjs` `FLOWS`: `['link previews: ask, preview, remove, send; the reader sees the card and never contacts the site', linkPreviews]`.
    - Alice pastes the stand-in URL, the chip asks, she presses Preview, the card is ready.
    - She removes it, previews again, and sends.
    - Bob sees `.link-card` with the title.
    - `page.on('request')` on Bob's page records **no request** to the stand-in's host or port, and none to `/api/link-previews`.
    - With a role that denies EMBED_LINKS, Alice gets no chip.

    Add the chip to the `test/a11y` pass (named buttons; `aria-live` announcements).

---

## 13. Docs to update
- **`SECURITY.md`**
  - §1 table: the "Messages and files" row should note that link previews are inside the message.
  - §3 contract, new rows 92–96, each naming its test:
    - 92: previews are fetched only through netguard (SSRF);
    - 93: readers never contact the linked site;
    - 94: a card must match a link in the text and is cleaned;
    - 95: the preview cache is per account and short-lived;
    - 96: the URL is never logged.
  - §4 honest limits: the server sees previewed links and who asked, and can link them to the conversation; "Always" mode reveals links even if they are never sent; one-time links can be used up; the linked site sees the server's IP; the sender can make the card say anything (the domain line can't lie); X support is best effort. Keep the existing "image links in messages" IP note.
- **`docs/ARCHITECTURE.md`**
  - §1: add `linkpreview.js` to the server modules and `linkpreview.js` to the client modules.
  - §2: the rate-limiting examples.
  - §4 "Can read": add "links a person chose to preview (and who asked, when)".
  - §4 key table: the payload now has an `l` field.
  - §7 jobs: `linkpreview.cache_sweep`.
  - §8 outbound table: a row for "Link previews | `server/linkpreview.js` | any https:443 page and one image; YouTube/X oEmbed; i.ytimg.com | netguard, 4/3 redirects, 512 KiB / 2 MiB, 10 s, worker parse".
- **`docs/ROUTES.md`:** add `POST /api/link-previews` (auth session; validation; rate limits; tests). Update the counts in the header ("313 HTTP routes" → 314; under `/api` 281 → 282).
- **`docs/FEATURES.md`:** a new "Link previews" section covering how it works, the settings, the payload, the limits and the known limitations. Also its §5 tests and §6 limitations.
- **`README.md`:**
  - the feature bullet;
  - the privacy paragraph (≈ line 435, "Other sites can see your IP address…"): previews come from the server, readers fetch nothing;
  - the environment table (≈ line 484): the `LINK_PREVIEW*` variables.
- **`.env.example`:** `LINK_PREVIEWS` and `LINK_PREVIEW_ACCEPT_LANGUAGE`, commented out, with one line on privacy.
- **`docs/OPERATIONS.md`:**
  - §1 "What never appears in the log": preview URLs.
  - §2 jobs: the cache sweep.
  - A note that the server downloads pages and pictures members ask for (memory only), and how to switch previews off.
- **`docs/PERFORMANCE.md`:** messages with previews are about 30 KB of ciphertext; the effect on history and search pages.
- **`docs/NEXT.md`** "Progress" and **`docs/ENGINEERING-REPORT.md`**: the work log entry.
- **The EMBED_LINKS description** in `public/js/perms.js` (shown in the role editor).

---

## 14. Risks and open questions

### Risks
1. **The privacy regression is real** for people who choose "Always". Mitigation: "Ask" by default, plain copy in the chip and settings, the `looksPrivate` skip, the owner switch, and SECURITY.md updates.
2. **One-time links used up** by the server's GET. "Ask" is the default, `looksPrivate` helps in "Always" mode, and the fetch is GET-only with no cookies. It is still possible if the person presses Preview.
3. **Abuse of the fetching proxy or legal exposure for the operator.** Bounded by rate limits, the per-host limit and the size caps; documented; owner switch.
4. **Database and bandwidth growth** of about 30 KB per previewed message. Bounded by `validCipher` and the message rate limits; dropped first when the message is too big.
5. **Parser bugs** (regex backtracking, entity edge cases). Linear tokenizer, worker with a hard time limit, fuzz-style tests (#3, #4).
6. **Third-party endpoints change.** X oEmbed is unreliable, YouTube thumbnail names aren't documented, and sites block unknown bots. Everything fails closed to "no preview".
7. **EMBED_LINKS is enforced only by members' apps.** A modified client can send cards anyway; readers then apply `senderMayEmbed` to the server-wide permission only (channel overrides are invisible to them, the same as @everyone today). The composer applies the same rule to its own person, so a channel override can take previews away but can't give them.
8. **Existing payload-whitelist bug.** `editBox()` already drops `p` (polls) when rebuilding the payload. Don't copy that pattern for `l`: carry `l` explicitly. Consider fixing `p` in the same commit as a separate change.

### Open questions
1. **Native fetch on desktop and Android.** The Electron main process or the Android bridge could fetch pages locally, as Signal does, so the Hearth server never sees the URL. The site would then see the person's IP. This needs a new `hearthDesktop` / `HearthAndroid` bridge method with exact origin checks.
2. **Phase 2: replace hot-linked image-URL embeds** with sender-built inline thumbnails (`kind: 'image'`), closing the remaining "image links in messages" IP leak. Possibly with a "Load original" button.
3. **Previews for links newly added in an edit.** Allowed, or v1 rule (none)?
4. **Should `findPreviewUrl` also support Discord's `<https://…>` "no embed" syntax?** It would need a change in `markdown.js`; today `URL_RE` would include the `>`.
5. **Showing the final destination for redirects/shorteners** ("bit.ly → example.org"). Note that the sender could fake it.
6. **Making preview titles searchable** (`viewOf()` in `app.js` and `search-query.js`).
7. **Showing Unicode** instead of punycode for single-script international domain names.
8. **An admin list of blocked domains or tracking-parameter stripping** before fetching (for example removing `utm_*` and `si=`).
9. **A full-size image option** (`img.att`, an encrypted attachment pointer next to the inline thumbnail) for large photo links.

---

## 15. Build plan (small commits, each with its tests)
1. **server: pure link-preview helpers.** `server/linkpreview.js` exporting `checkPreviewUrl`, `decodeEntities`, `cleanText`, `decodeHtml`, `parseHead`, `sniffImage`, `looksLikeChallenge`, `pickImage`; in-process tests #2–#5 (pure parts) and #11 (sniff).
2. **server: POST /api/link-previews (generic OpenGraph).** Route, worker, netguard calls, reason mapping, rate limits and in-flight caps, per-user cache with the `linkpreview.cache_sweep` job, logging without URLs. `FEATURE_DEFAULTS.linkPreviews` and the `PUT /admin/owner` list. Wire it in `index.js` after BOTS (pass `countHit`). Tests #1, #6–#14, #19–#21.
3. **server: YouTube, X and GitHub handling.** `youtubeId` (and optionally make `parseWatchUrl` use it), `xStatus`, the oEmbed calls, the env stand-ins. Tests #15–#18.
4. **client: pure helpers.** `markdown.js` `URL_RE` export and `linkedUrls()`; new `public/js/linkpreview.js`. Tests #22–#26.
5. **client: decrypt and render.** `secure.js` `cleanLinks` in `openGroup`/`openDm`; `app.js` `linksOf`, `senderMayEmbed`, `linkCardEl`, the `fillMessage` insertion and embed de-duplication; CSS. Tests #28, #29.
6. **client: size fallback.** `payloadVariants`, `CIPHER_MAX` and `encryptFitting` in `sendTo` and `editBox`. Test #27.
7. **client: thumbnail.** `media.js` `previewThumb()` (covered by the browser flow).
8. **client: composer chip and sending.** `state.link`, detection, `requestPreview`, `linkChip` in `renderExtras`, `send`/`deliver` changes, failure restore, clearing on conversation change; `P.chat` defaults.
9. **client: settings and admin.** `settings.js` chat section (`linkPreviews`, `linkCards`), `admin.js` owner switch, `perms.js` EMBED_LINKS text.
10. **client: edit, forward and export.** `editBox` keeps linked previews, `openForward` carries `l`, `usability.js` export `rec.link` and its README text.
11. **(optional, behaviour change) client: gate image-URL embeds on EMBED_LINKS** (`senderMayEmbed`) for consistency.
12. **tests and docs.** E2E flow #30 and the a11y pass; SECURITY.md (rows 92–96 and §4), ARCHITECTURE.md (§1, §2, §4, §7, §8), ROUTES.md, FEATURES.md, README.md, .env.example, OPERATIONS.md, PERFORMANCE.md, NEXT.md progress, ENGINEERING-REPORT.md.

Steps 1–3 can ship on their own: the route has no client yet and is off-path. Steps 4–5 make readers ready before any sender can produce previews. Step 8 turns the feature on for senders.

---

## 16. Sources (external claims)
- Signal protocol `Preview` message: https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/protowire/SignalService.proto
- Signal-Android fetcher (User-Agent `WhatsApp/2`, 2 MB caps, redirect validation): https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/linkpreview/LinkPreviewRepository.java
- Signal-Android URL rules: https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/util/LinkUtil.kt
- Signal-Android OpenGraph parsing: https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/linkpreview/LinkPreviewUtil.java
- Signal Desktop reader-side rules (URL must be in the body, `isLinkSneaky`): https://github.com/signalapp/Signal-Desktop/blob/main/ts/types/LinkPreview.std.ts
- Signal privacy-enhancing proxy (secondary): https://www.howtogeek.com/708607/how-to-turn-on-link-previews-in-signal-or-turn-them-off/
- Synapse URL preview configuration: https://github.com/element-hq/synapse/blob/develop/docs/usage/configuration/config_documentation.md
- Matrix encrypted rooms and server-side previews (secondary): https://lemm.ee/post/9955859
- OpenGraph protocol (first tag wins): https://ogp.me/#array (source: https://github.com/facebook/open-graph-protocol)
- X Cards markup: https://developer.x.com/en/docs/x-for-websites/cards/overview/markup
- oEmbed spec: https://oembed.com/
- X oEmbed reliability (secondary): https://core.trac.wordpress.org/ticket/59142 and https://resources.princeton.edu/layout-blocks/blocks-reference/twitter
- YouTube thumbnail file names (secondary, not a documented API): https://dev.to/alexlv_cheng/how-youtube-thumbnail-urls-work-a-simple-guide-36i6
- GitHub generated OpenGraph images: https://github.blog/open-source/git/framework-building-open-graph-images/
- GitHub REST API unauthenticated limit (60 per hour): https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- WhatsApp crawler User-Agent and 300 KB guidance: https://developers.facebook.com/docs/whatsapp/link-previews/
- WHATWG encoding sniffing (BOM → transport → prescan of 1024 bytes; UTF-16 → UTF-8; x-user-defined → windows-1252): https://html.spec.whatwg.org/multipage/parsing.html#encoding-sniffing-algorithm
- Node.js TextDecoder encodings with full ICU: https://nodejs.org/docs/latest-v22.x/api/util.html#whatwg-supported-encodings
- CORS: https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS


## Sources

- https://github.com/signalapp/Signal-Android/blob/main/lib/libsignal-service/src/main/protowire/SignalService.proto
- https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/linkpreview/LinkPreviewRepository.java
- https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/util/LinkUtil.kt
- https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/linkpreview/LinkPreviewUtil.java
- https://github.com/signalapp/Signal-Desktop/blob/main/ts/types/LinkPreview.std.ts
- https://www.howtogeek.com/708607/how-to-turn-on-link-previews-in-signal-or-turn-them-off/
- https://github.com/element-hq/synapse/blob/develop/docs/usage/configuration/config_documentation.md
- https://lemm.ee/post/9955859
- https://ogp.me/#array
- https://github.com/facebook/open-graph-protocol
- https://developer.x.com/en/docs/x-for-websites/cards/overview/markup
- https://oembed.com/
- https://core.trac.wordpress.org/ticket/59142
- https://resources.princeton.edu/layout-blocks/blocks-reference/twitter
- https://dev.to/alexlv_cheng/how-youtube-thumbnail-urls-work-a-simple-guide-36i6
- https://github.blog/open-source/git/framework-building-open-graph-images/
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://developers.facebook.com/docs/whatsapp/link-previews/
- https://html.spec.whatwg.org/multipage/parsing.html#encoding-sniffing-algorithm
- https://nodejs.org/docs/latest-v22.x/api/util.html#whatwg-supported-encodings
- https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS
- /home/user/Pandabear445.github.io/hearth/server/netguard.js
- /home/user/Pandabear445.github.io/hearth/server/activity.js
- /home/user/Pandabear445.github.io/hearth/server/newsbot.js
- /home/user/Pandabear445.github.io/hearth/server/index.js
- /home/user/Pandabear445.github.io/hearth/server/gifmedia.js
- /home/user/Pandabear445.github.io/hearth/server/perms.js
- /home/user/Pandabear445.github.io/hearth/public/js/markdown.js
- /home/user/Pandabear445.github.io/hearth/public/js/app.js
- /home/user/Pandabear445.github.io/hearth/public/js/secure.js
- /home/user/Pandabear445.github.io/hearth/public/js/e2ee.js
- /home/user/Pandabear445.github.io/hearth/public/js/media.js
- /home/user/Pandabear445.github.io/hearth/public/js/attachments.js
- /home/user/Pandabear445.github.io/hearth/public/js/settings.js
- /home/user/Pandabear445.github.io/hearth/public/js/admin.js
- /home/user/Pandabear445.github.io/hearth/public/js/perms.js
- /home/user/Pandabear445.github.io/hearth/public/js/usability.js
- /home/user/Pandabear445.github.io/hearth/docs/ARCHITECTURE.md
- /home/user/Pandabear445.github.io/hearth/SECURITY.md
- /home/user/Pandabear445.github.io/hearth/docs/NEXT.md
