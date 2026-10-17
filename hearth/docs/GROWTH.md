# Getting Hearth its first users, fast and cheap

A research note from 16 October 2026. The budget is close to zero, so every step below costs time, not money.
It covers three things: what to fix first, where to post and in what order, and texts to start from. The sources
found for dated claims are footnotes at the end. Anything without one is marked *unverified*: check it on the page
named before relying on it, since these rules change.

**Status (16 October 2026, 1.29.0):** built with this note: the `LICENSE` files, the image workflow
(`.github/workflows/hearth-image.yml`) and `deploy/compose.image.yml`, the app store templates
(`deploy/catalogs/`), and the "Hearth vs Discord" page with `sitemap.xml`, `robots.txt`, canonical links and
JSON-LD on the GitHub Pages site. Still to do by hand: the rest of step 0, publishing the first image (a `hearth-v1.29.0` tag),
the store submissions and the posts.

## The short version

1. **Timing is good.** Discord announced worldwide age checks in February 2026 for a March start, and they went
   live in late September 2026[^age] (one report dates the start to 22 September; the exact day is *unverified*
   against Discord's own pages). Accounts that aren't confirmed as adults are restricted, and confirming means a
   face scan or an ID[^age]. That the February announcement sent searches for "Discord alternative" up sharply, and
   that Stoat (formerly Revolt) buckled under the sign-ups, is *unverified*. People who look now land on Stoat,
   Matrix and TeamSpeak. Hearth isn't listed anywhere yet.
2. **Fix three things before posting anywhere.** There is no LICENSE file, no ready-made Docker image, and the
   README doesn't say how the code was written. Self-hosting communities check all three within minutes.
   A pending task also plans to make the repo private, which would end every listing below.
3. **Then post where the rules allow a 10-day-old project:**
   - r/selfhosted's weekly New Project Megathread[^rss];
   - AlternativeTo;
   - an email to selfh.st;
   - a Show HN that links to the repo;
   - after the Docker image exists, the app stores built into home-server systems: Unraid Community Apps, CasaOS,
     Umbrel, Dokploy and Coolify.
4. **The cheapest growth lever is already in the product: invite links.** Each server owner is a recruiter. But a
   Hearth invite link pasted into Discord, Reddit or X shows a bare "Hearth" with no card, and a signed-out visitor
   gets a sign-in form with no mention of the invite. The two in-product items fix that.
5. **Wait on two things.** awesome-selfhosted requires the first release to be more than 4 months old[^ash], so
   the earliest is about February 2027. r/selfhosted keeps projects younger than 3 months in the megathread[^rss].

## Step 0: before posting anywhere (this week, $0, about half a day)

| What | Why | Effort |
|---|---|---|
| Add `LICENSE` (MIT) at the repo root and in `hearth/` | `package.json` and the landing page say MIT, but there's no license file. GitHub then shows "no license", and Unraid Community Apps requires an OSI-approved license in the repo. The first Hearth commit reads "Add Hearth 1.11.0 source as received", so confirm you hold the rights and put the right name in the file. | 10 min |
| Keep the repo public: drop the pending "make repo private" task | Every directory, catalog and Show HN below needs public source. The landing page promises "open source". | 0 |
| One clearly named public repo | The landing page told people to `git clone .../Pandabear445.github.io`. A repo named after a GitHub Pages site looks odd to self-hosters, and its name never appears in "discord alternative" searches. The repository is already `Pandabear445/Hearth-chat` (the old `Pandabear445.github.io` address redirects there), and the landing page's clone command and links now use that name. Give it a one-line description, topics (`discord-alternative`, `self-hosted`, `chat`, `voice-chat`, `end-to-end-encryption`, `webrtc`) and a social preview image (reuse `site/og.png`). | 30 min |
| Say how it was built | 165 commits on the 1.29.0 branch carry an AI co-author line. r/selfhosted and Lemmy's c/selfhosted both ask for AI-involvement labels, and HN readers will check the commit log. Add a short "How Hearth is built" paragraph to the README: what was AI-written, how you review and test, that the security reviews and the attacker test suite were automated, and that no independent human audit has happened yet. Saying it first costs little; being "caught" sinks the thread. | 20 min |
| Make the root README concrete | The repo-root `README.md` uses vague lines ("Encrypted messaging features", "Privacy-conscious by design"). The detailed one is `hearth/README.md`. Self-hosters skim the first screen: one sentence, a screenshot, the install command, an honest limits list and links. | 30 min |
| Move the public instance off DuckDNS | `kappachat.duckdns.org` is a free dynamic-DNS name. School and work filters often block that category, and some link scanners treat it with suspicion (*unverified for Discord and Reddit specifically*). A custom domain avoids this. The old `arc32.me` has lapsed, so this needs a domain registered first; until then the public instance stays on DuckDNS. Once you have one, point a subdomain (e.g. `chat.<domain>`) at the VPS, add it to the Caddyfile, and keep the old name as a redirect. | 30 min |
| Publish a Docker image (see "Build: site and listings", item 1) | Every app store and PikaPods expects a pullable image. Right now `docker-compose.yml` builds from source. | 1–2 h |
| Get ready for a spike on the public instance | Check that the robot check (captcha) is on for sign-ups (Admin → Registration & Terms; it's on by default), check the Terms, and check that reports reach you. Watch Admin → Health on launch day. | 15 min |
| Clean install by someone else | Ask one friend to follow the landing page's "about ten minutes" on a fresh VPS and time it. Fix whatever trips them before any launch post. | 1 h of theirs |

## Ranked plan

Ranked by expected users per hour of your time. None of it costs money.

| # | Channel | When | Cost / effort | Expected impact (honest) |
|---|---|---|---|---|
| 1 | In-product: invite links that unfurl, and a "you're invited" welcome (build item) | This week | $0 / S–M dev | Compounding. Every invite shared on Discord, Reddit or X becomes an advert, and invitees who arrive signed out know why they're there. |
| 2 | In-product: invite prompt right after creating or importing a server, with a share sheet and a "we're moving" message (build item) | This week | $0 / S dev | A new server with one member is a dead server. This turns new owners into recruiters. |
| 3 | r/selfhosted **New Project Megathread** | The week of 23 October (a new thread each week: the March 2026 rules said Fridays, the May 2026 thread says any day[^rss]; check the current one) | 30 min + 2 h replying | Modest: tens to low hundreds of visits and the first outside bug reports. Standalone posts about projects under 3 months old are removed[^rss]. |
| 4 | **AlternativeTo** listing as an alternative to Discord, TeamSpeak, Stoat and Element | This week | 20 min | Small but lasting. It ranks for "Discord alternative" searches (*unverified*), and it covered Discord's age checks in its news[^age]. |
| 5 | **selfh.st** (directory and the Friday "Self-Host Weekly" newsletter) | This week | 10 min email | How to get listed: see https://selfh.st/apps-about/ (*unverified* that it asks for an email with project details). A newsletter mention is the main upside. |
| 6 | **Show HN** linking to the repo | After step 0 and the image, a weekday | 1 h writing + a day in the comments | High variance: most Show HNs sink, and a front-page one brings thousands of visits and stars. E2EE claims and AI-built code will be questioned hard. Answer plainly. |
| 7 | **App stores** (Unraid Community Apps, CasaOS, Umbrel, Dokploy, Coolify) | Weeks 2–4, after the image | 1–3 h each incl. a test install | Lasting, steady installs from people browsing their NAS's store. Umbrel requires amd64 and arm64 images (*unverified*; the image has both). |
| 8 | **Fediverse**: a Mastodon post with #selfhosted #selfhosting #discord #privacy, and Lemmy c/selfhosted | Mastodon now; Lemmy once your account is 30+ days old | 15 min | Small and friendly audience. Lemmy's free-software exception requires an account at least 30 days old, staying in the comments, and AI tags ([CBH]/[AIP])[^lemmy]; check the sidebar. |
| 9 | **YouTube self-hosting channels** (DB Tech, Techno Tim, and similar) | After the app stores | 30 min of emails | A lottery ticket. Creators favour apps that install in one click, so do this after #7. |
| 10 | **awesome-selfhosted** | About February 2027 | 20 min | High and lasting, but the first release must be over 4 months old[^ash]. |
| — | Product Hunt | Skip for now | — | No evidence it brings self-hosters. Revisit if you launch a hosted plan. |

**Don't:**
- buy upvotes or ask friends to upvote: HN and Reddit both penalise voting rings;
- post invite links in other people's Discord servers: that's unsolicited advertising under Discord's rules
  (*unverified*: see its Community Guidelines);
- lead with "no age verification": it attracts the wrong crowd, and age-check laws apply to whoever runs a
  server. Lead with what's true and durable: Hearth doesn't collect ID documents, so there's no ID database to
  leak. Discord disclosed a breach at one of its third-party support vendors in October 2025 that exposed about
  70,000 users' ID photos[^breach], so that point resonates without needing exaggeration.

**How to measure without tracking anyone:**
- GitHub Insights → Traffic: referrers, clones, stars;
- the image's pull count on GHCR;
- sign-ups and active users in the public instance's Admin dashboard;
- likes on AlternativeTo.

Don't add analytics scripts to the landing site. The privacy stance is part of the pitch.

## The week, day by day

- **Fri 16 Oct – Sun 18 Oct:** step 0 (license, repo, README honesty, image workflow). Start the
  two in-product items.
- **Mon 19 Oct:** AlternativeTo submission and the selfh.st email. Mastodon post.
- **Tue 20 – Thu 22 Oct:** a friend's clean install, fixes, and the comparison page on the landing site.
- **Fri 23 Oct:** r/selfhosted megathread comment. Stay in the replies all day.
- **The week after:** Show HN (Tuesday to Thursday morning US Eastern is the usual advice, *unverified*). Then the
  Unraid and CasaOS submissions.

## Texts to start from

Rewrite each in your own voice; people can tell. Show HN and awesome-selfhosted have explicit rules against
machine-written submissions, so for those two you get an outline and a checklist, not a finished text.

### r/selfhosted: comment in the weekly New Project Megathread

The megathread asks for the project name and a repo or website link[^rss]. Use the flair or AI label the current
rules require.

> **Hearth**: self-hosted chat for friend groups and small communities (Discord-style servers, voice, video,
> screen share)
>
> Repo: <repo link> · Site: https://pandabear445.github.io/Hearth-chat · Public instance to try (needs an account): https://kappachat.duckdns.org
> License: MIT · One Node.js process + SQLite, Docker Compose, no outside services required
>
> What's in it:
> - Servers with text and voice channels, roles and permissions, threads, DMs and group chats (up to 25)
> - Voice, video and screen sharing with sound; watch YouTube, Twitch or a video file together in a call
> - Messages and files are end-to-end encrypted in the app (the server stores ciphertext); calls are encrypted between the people in them (DTLS-SRTP, no media server)
> - Desktop app (Windows/Mac/Linux), Android app, installable web app
> - Import a Discord server's roles and channels from a server template (not message history)
>
> Honest limits:
> - The server sees metadata: who talks to whom, and when
> - The web app's code comes from the server, so you trust whoever runs it (true of any web app)
> - No federation or bridges, by design
> - Calls go directly between people or through a TURN relay, with no media server, so big group video calls
>   won't scale, and people in a direct call can see each other's IP address
> - No independent security audit yet
>
> How it's built: <one or two true sentences, e.g. "Most of the code was written with <the AI coding tool you
> used>. I review and test every change, and CI runs an automated attacker suite.">
>
> It went public ten days ago. I'm mostly looking for people to try the Docker install and tell me what breaks.

### Show HN: title and outline (write the text yourself)

HN's moderators have said generated text isn't allowed on the site (*unverified*). Show HN is for something people
can try, and sign-up pages are off topic[^showhn], so link the **repo**, not the landing page or the public
instance's sign-up form.

Title (under 80 characters): `Show HN: Hearth – a self-hosted, end-to-end encrypted Discord alternative`

Outline for the text, in about 150–250 words:
1. One sentence on what it is and who it's for: friend groups and small communities.
2. Why you built it, in a sentence or two of your own story.
3. How to try it: `docker compose up -d` (the image from step 0), or the public instance, which needs an account.
4. How the encryption works, in two lines, and its limits: the server sees metadata, and the code is served by
   the server.
5. The stack: Node, Express, Socket.IO, SQLite, vanilla JS, WebRTC, Electron.
6. How it's built: AI involvement, tests, no independent audit yet.
7. What feedback you want.

Have answers ready for these:
- "Why not Matrix?" There's no federation, so it's one small process, simpler to run, and there are no bridges
  that would decrypt messages.
- "How is it E2EE if the server serves the JS?" Say yes, that's the trust model. SECURITY.md §4 covers it, and
  so do the desktop and Android apps with signed updates.
- "Was this vibe-coded?" Answer straight.
- "What does the server see?" Point to SECURITY.md.
- "Why MIT and not AGPL?"

### AlternativeTo: description

Mark it as an alternative to Discord, TeamSpeak, Stoat and Element. Licence: open source (MIT). Platforms:
self-hosted, Windows, Mac, Linux, Android, web. Suggested tags: chat, voice chat, self-hosted, end-to-end
encryption, screen sharing.

> Hearth is a chat app for friend groups and small communities that you can host yourself. It has servers with
> text and voice channels, roles, threads, direct messages and group chats, voice and video calls with screen
> sharing, and a player for watching videos together. Messages and files are end-to-end encrypted in the
> app, so the server stores only encrypted data (it still sees who talks to whom and when), and calls are
> encrypted between the people in them. It runs as one
> Node.js process with SQLite, installs with Docker, and has desktop apps for Windows, Mac and Linux, an Android
> app and an installable web app. Free and MIT licensed, with no ads, and every feature works for everyone (each
> server's owner decides whether supporters get extra storage and bigger files).

### awesome-selfhosted: the rules, not a draft

Their pull request template asks the submitter to confirm "The submission was done by a human, not a
machine/LLM" (*unverified*: the template quoted in the sources shows the age and maintenance boxes[^ash]), so write
the entry yourself. I can check it against the rules afterwards. What it needs (only the 4-month rule and active
maintenance are sourced; check the rest in the repository's `CONTRIBUTING.md` before writing):

- **Eligible from about 6 February 2027.** The first release must be more than 4 months old, and Hearth's public
  history starts on 6 October 2026 (the repository's two older commits are the 2021 GitHub Pages site). The
  project also needs to be actively maintained, with working install instructions.
- **Where it goes:** one file, `software/hearth.yml` (kebab-case), in `awesome-selfhosted/awesome-selfhosted-data`,
  one item per PR. Fields: `name`, `website_url`, `source_code_url`, `description`, `licenses` (`MIT`),
  `platforms`, `tags`, and optionally `demo_url`, `related_software_url` and `icon_url`.
- **Description:** under 250 characters, sentence case. Leave out "open-source", "free" and "self-hosted", and
  end it with `(alternative to Discord)`.
- **Tag:** `Communication - Custom Communication Systems` (Stoat's tag). Platform: `Nodejs`. Only list a
  `demo_url` if it's an interactive demo.
- Remove comments and unused optional fields. Expect the merge about a week after approval.

### Email to selfh.st and YouTube creators (personalise each one)

> Subject: Hearth, a self-hosted Discord alternative (MIT, Docker)
>
> Hi <name>, I make Hearth, a self-hosted chat app for friend groups: Discord-style servers, voice, video and
> screen sharing, with messages and files end-to-end encrypted in the app. It's one Node process with SQLite and
> installs with Docker Compose <or "from the Unraid/CasaOS store">. Repo: <link>. Honest limits are in the README
> (the server sees metadata, no independent audit yet). If it's useful for <the newsletter / a video>, I'm happy
> to answer questions or set up a test server. Thanks for <something specific of theirs you liked>.

## Things to build now

Status: the three site and listing items are built (see the top of this note); the two in-product items aren't
yet.

**In the product**
1. Invite links that unfurl, and a "you're invited" welcome for signed-out visitors. The server name only shows
   if the server opts in.
2. An invite prompt right after creating or importing a server, with a share sheet and a ready-made "we're
   moving" message.

**Site and listings**
1. A multi-arch Docker image on GHCR, and a compose file that uses it.
2. App store templates in `hearth/deploy/catalogs/`: Unraid, CasaOS, Umbrel, Dokploy and Coolify.
3. A "Hearth vs Discord" page on the landing site, plus SEO basics: sitemap, robots.txt, canonical links, JSON-LD.

All five stay inside NEXT.md's "Not recommended" list:
- no public directory of servers (an invite preview only reaches people who already have the link);
- no tracking or referral counting;
- nothing that reads messages.

## What's already there (don't rebuild)

- Import from Discord: structure from a server template.
- Invite links that expire and have use limits, and invite links that open the desktop and Android apps.
- The landing page's Open Graph card.
- The GitHub workflows that build the desktop and Android apps.
- The money and supporter tools.
- The "Telling people about it" notes in RUNNING-HEARTH.md. This note replaces their "Where" bullet with dated,
  rule-checked steps.

## Sources

Found on 16 October 2026. Most are reports about a rule or an announcement, not the rule itself, so check the live
page before relying on a detail.

[^age]: Discord's worldwide age checks: TechRepublic, "Discord to Roll Out Global Age Verification Using Facial
    Scans, ID", https://www.techrepublic.com/article/news-discord-global-age-verification-teens/; AlternativeTo
    news, February 2026,
    https://alternativeto.net/news/2026/2/discord-will-require-global-age-verification-through-a-face-scan-or-id-for-full-access;
    Digital Citizen, "Discord Rolls Out Global Age Checks With ID Scans Handled by Vendor k-ID",
    https://www.digitalcitizen.life/discord-global-age-checks-k-id-vendor-id-scan/ (the September start).
[^breach]: The October 2025 vendor breach (Discord's statements of 3 and 8 October, as reported): CyberInsider,
    https://cyberinsider.com/discord-confirms-70000-government-ids-exposed-in-third-party-breach/
[^rss]: r/selfhosted: "Rules update: New Project Friday here to stay" (March 2026),
    https://www.reddit.com/r/selfhosted/comments/1rmt39o/rules_update_new_project_friday_here_to_stay/, and "New
    Project Megathread, week of 28 May 2026",
    https://www.reddit.com/r/selfhosted/comments/1tqhzoo/new_project_megathread_week_of_28_may_2026/ (projects
    younger than 3 months, counted from first public presence, go in the weekly thread; a top-level comment with
    the name and a repo or site link). The two disagree on whether it's Fridays only.
[^ash]: awesome-selfhosted: its pull request checklist, as quoted by a maintainer and in mirrors of the repository
    ("first released more than 4 months ago", "actively maintained", "working installation instructions"). The
    rules themselves: https://github.com/awesome-selfhosted/awesome-selfhosted-data (`CONTRIBUTING.md` and the pull
    request template).
[^lemmy]: c/selfhosted on lemmy.world, rule 7 as quoted in comments there (promotion needs an account at least 30
    days old and active participation; free software without a paywall has exceptions; [CBH]/[AIP] tags for AI
    involvement): https://lemmy.world/c/selfhosted (sidebar and its linked rules post).
[^showhn]: Show HN guidelines: https://news.ycombinator.com/showhn.html
