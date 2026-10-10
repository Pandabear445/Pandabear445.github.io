# Running Hearth: capacity, regions, costs and money

Numbers here were measured with Hearth 1.16 (still true for 1.18) under load (simulated app windows connected over WebSockets,
real message traffic through the real server), not guessed. Your server: 6 vCPU, 12 GB RAM,
200 GB SSD (152.4 GB free), 300 Mbit/s.

## How many people can it hold?

Hearth runs its chat logic on one CPU core, so "per core" is what matters. Measured:

| What | Measured |
|---|---|
| Memory per open app window | about 10–35 KB |
| 5,000 people online, doing nothing | +40 MB RAM, 7.5 % of one core |
| Delivering messages | about 50,000–59,000 deliveries per second per core (one message to one online person = one delivery) |
| 2,000 people reconnecting at once (after an update) | 3 seconds of CPU, all 2,000 back |
| Start-up data / history page | 2.9 ms / 2.1 ms per request |

**People online at the same time.** If everyone online sends one message a minute and a message reaches the
~50 people online in that server, the server does about 830 deliveries a second per 1,000 people online —
under 2 % of one core. Using half a core leaves room for about **30,000 people online across many
friend-group-sized servers**. Everyone in *one* giant server is the hard case: about **1,200 people online all
chatting in the same server** at that rate (that's 20 messages a second — faster than anyone can read).

**Registered accounts.** Usually 5–10× the number online at peak, so tens of thousands.

**What runs out first: disk space.** Text is tiny (an encrypted message is about 1 KB, so a million messages
is about 1 GB). Pictures and files are what fill the disk:

| Average stored per person | People that fit in 152 GB |
|---|---|
| 1,000 MB (the default limit, everyone full) | ~150 |
| 250 MB | ~600 |
| 100 MB (typical heavy chat user, about a year) | ~1,500 |
| 30 MB (typical light user) | ~5,000 |

Recommendation: set **Storage per person to 250 MB** (Admin → Storage & limits) and give supporters more.
Watch the Storage tab; when free space drops under ~20 %, raise the plan's disk ("more storage available")
or lower limits. Keep the GIF library cap (default 5 GB) in mind too.

**Bandwidth (300 Mbit/s ≈ 37 MB/s).** Chat text is negligible. Calls go directly between people, so they use
none of your bandwidth — except calls that need the relay (TURN) if it runs on this same server: about
3,000 relayed voice streams or ~100 relayed video streams fill the port. `scripts/setup-turn.sh` caps each relayed
connection at 6 Mbit/s each way (`TURN_MAX_MBIT`); set `TURN_CAPACITY_MBIT` to cap all relayed calls together
(default: no total cap), e.g. `TURN_CAPACITY_MBIT=200 sudo bash scripts/setup-turn.sh`. Pictures: a 1.5 MB photo seen by 30
people is 45 MB. GIFs loaded "through this server" (privacy setting) are the biggest user of bandwidth; turn
that off in Settings → Instance if bandwidth ever becomes a problem.

**Connection limit.** Each open app window is one connection. Many Linux setups cap a program at 1,024 open
connections, which would cap you near 1,000 people online. Hearth's systemd file and docker-compose.yml now
raise it to 65,535; `hearth-update --status` tells you the current limit and how to raise it.

**When to upgrade.** Admin → Overview → Server health. If CPU stays above ~60 % or "Responsiveness" stays
above ~100 ms at busy times, move to a bigger plan (more CPU per core helps most). That's cheaper and simpler
than splitting Hearth across machines.

## Cost per person

If this is a ~$8/month VPS (check your bill): with 1,000 people using it in a month that's **under 1 cent per
person per month**; with 5,000 it's 0.16 cents. That's the honest, headline number for "cost effective".

## More regions, linked together

**What goes in a region, and what doesn't.** Chat stays on your one main server: one database means everyone sees
the same messages instantly and there's one thing to back up. A message crossing the world takes 0.1–0.3 s, which
nobody notices in chat. Copying the database between regions would mean conflicts, lag between copies and several
times the work, for no gain people can feel at this size.

What distance *does* hurt is calls that can't connect person-to-person (about 1 in 5: phones on mobile data, strict
school/office/home networks). Those go through a relay, and a relay on the other side of the world adds a noticeable
delay. So a region is a small relay server near people.

**How the regions link up (built in, Admin → Regions):**

1. *Add a region* → name it (e.g. "Frankfurt") → confirm with your password → you get a one-line install command.
   (Adding, reinstalling, renaming and removing regions are all written to the audit log.)
2. Rent the cheapest VPS there, log in as root, paste the line. It installs the relay with your server's secret,
   plus a tiny check-in that reports to your server every minute (address, CPU, memory, traffic this month). The
   address a region reports must be a real public IP; private, loopback and look-alike spellings are refused.
3. Within a minute the region shows **Online** in Admin → Regions, and every call includes it.
4. Each person's app measures which relays answer fastest from where they are and uses the two nearest. A region
   that stops checking in is dropped from calls after 3 minutes and comes back by itself.
5. *Measure from this device* shows the times from wherever you are.

**What the second server does for you.** Chat can't be split across machines without two databases disagreeing,
so the main server keeps running chat, and each region takes the jobs that make sense on another machine:

- **Calls**: relays near people (and a whole call can be moved to a region, below).
- **Backups**: a copy of every encrypted daily backup, so your community survives losing the main VPS. Copies go
  to an upload-only account on the region, checked against the region's own key; the region can't open them.
  *Already have a region? Press Reinstall in Admin → Regions and run the new command on it once to add backup space.*

**Switching a call's region (like Discord).** Press the 🌐 region button in the call bar (or right-click a voice
channel) and pick a region, or *Automatic*. Everyone in the call moves over together within a second, without
hanging up; people who join later land in the same region. With a region picked, all of the call's audio and video
goes through that region's relay (still end-to-end encrypted: the relay only forwards scrambled packets). On
*Automatic*, people connect directly when they can and otherwise use the relays nearest to each of them.
In a server, changing a voice channel's region needs **Manage Channels**; in DM and group calls anyone in the call
can change it. If a picked region goes offline, the call falls back to Automatic by itself.

The install link expires after 24 hours (*Reinstall* makes a new one, and needs your password too). When your
server uses its own self-signed certificate, the command pins that exact certificate, so the new region only ever
talks to your server.

**What a region holds.** The relay secret is the same on every relay (the main one and each region), so someone
who breaks into one region can make relay logins that work on all of them, and can change the address that region
reports. Only rent regions from providers you'd trust with that. To change the secret, set a new one (Settings →
Instance → Calls, or `sudo bash scripts/setup-turn.sh` again) and **Reinstall** every region. Relay logins already
handed out keep working until they run out (12–18 hours).

**Where to put them, cheaply** (prices checked October 2026; they change):

| Provider | Cost | Notes |
|---|---|---|
| Oracle Cloud Always Free | $0 | Arm VM (2 CPU / 12 GB since mid-2026) with **10 TB traffic a month**. Many regions. Needs a card; free VMs can be hard to get in busy regions. |
| Hetzner Cloud | ≈ €5.50/mo | Germany/Finland with 20 TB traffic: best value for Europe. US (1 TB) and Singapore (0.5 TB) include little traffic. Cheapest plans sometimes sold out. |
| Contabo (your current host) | ≈ $5–7/mo | EU, US, UK, Asia, Australia; lots of traffic. Same account you have. |
| Vultr / DigitalOcean / Linode | $4–6/mo | 30+ cities, 0.5–2 TB traffic. For South America, India, Japan, Australia. |

Traffic is the number to watch, not CPU: a relayed video call is about 1–2 Mbit/s per person each way, so 1 TB
is roughly 1,000 hours of relayed video. Admin → Regions shows each region's traffic this month.

**A sensible plan:** start with nothing extra (your main server already relays if you ran setup-turn.sh). When
people in one area have trouble with calls, add one region there. Europe + US East covers most friend groups; a
third (Asia or US West) covers thousands of people. Oracle's free tier makes the first one $0.

**Optional, for the web app itself:** Cloudflare's free plan in front of your domain serves the app's files from
near everyone, hides your server's IP and blocks floods, also at $0. WebSockets work on the free plan. It needs
a domain (next section).

## Operating notes

**Visitors' addresses behind a proxy (`TRUST_PROXY`).** IP bans, sign-in limits and the addresses in the audit log
all depend on knowing who a visitor is. Hearth believes the `X-Forwarded-For` header only from a trusted proxy: by
default this machine (Caddy or nginx on the same host), and with `docker-compose.yml` its own Caddy network
(`10.231.47.0/28`). Anything else — nginx in another container, Traefik, a tunnel, a proxy on another machine —
needs `TRUST_PROXY=<its address or subnet>` in `.env`, or every visitor shares the proxy's address and one set of
sign-in limits; Hearth's log names each ignored proxy address once. In Docker, a value in `.env` replaces the
compose default. Never set it to a number, or to Docker's gateway (`x.x.x.1`), unless `HEARTH_BIND=127.0.0.1`:
then anyone reaching port 3000 directly could claim any address. `TRUST_PROXY=1` now really means "one proxy in
front" (before, that value never matched, so everyone behind Caddy shared one address). Older Docker installs keep
their `docker-compose.yml`, so `hearth-update` adds `TRUST_PROXY=<your proxy network's subnet>` to `.env` by itself
and says so.

**Shipping a server update.** `bash scripts/make-update-zip.sh [folder]` makes `hearth-update-<version>.zip` and
`hearth-update-<version>.zip.sha256` from the last commit (default folder: `hearth/dist`, which git ignores). Hand
out both, and put the SHA-256 in the release notes too. The update tools and `hearth-update` refuse a zip that
doesn't match the `.sha256` next to it, print the SHA-256 they install, and check the upload again on the server
in a private temporary folder. Without a `.sha256` they only print the SHA-256, so compare it yourself. A checksum
isn't a signature: someone who can replace both files can replace both, which is why the published copy matters.
Exit codes 90–92 from the tools mean the updater never ran (damaged upload, no updater in the zip, no private
folder).

**Shipping the desktop apps.** Set the `UPDATE_SIGNING_KEY` secret so installed apps only take updates you signed
(see [SIGNING.md](SIGNING.md#signing-desktop-updates)). To have GitHub copy the installers to your server, add
`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_DOWNLOADS_DIR` **and** `VPS_HOST_FINGERPRINT`: the `SHA256:…` value from
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server. Without the fingerprint the copy step fails and
copies nothing. Use a user with no sudo that can only write `data/downloads`, not root. Only `app-v*` tags and the
default branch are copied.

**The call relay (TURN).** Relay passwords are per person and run out 12–18 hours after they're handed out; the app
fetches new ones by itself. Relay setups made before the bandwidth caps need `sudo bash scripts/setup-turn.sh` run
again, and each region reinstalled. Setting coturn up by hand from `deploy/turnserver.conf`: remove the `#` from
`static-auth-secret=` and set a long random secret (left as it is, the relay accepts no one), add `max-bps` if you
want a cap, and give Hearth `TURN_URL` and `TURN_SECRET`. `TURN_USERNAME`/`TURN_CREDENTIAL` still work but hand
everyone, including people you remove, one password that never expires (the server warns at start-up). Changing
the relay's secret or addresses needs your password and is audit-logged.

**Outbound requests and push.** Feeds, trackers, news and music pictures and push notifications may only reach
public internet addresses, never this server's own (except ports 80 and 443). Behind NAT the public IP isn't on a
network interface, so list it in `OUTBOUND_BLOCK` (comma-separated addresses or CIDR ranges, refused on every port),
together with anything else on your network that should never be reached. `PUSH_ALLOW_PRIVATE=1` allows push
endpoints on private addresses: only for tests, or a push service on your own network.

**Backups.** The encrypted backups in `data/backups/encrypted/` are the only thing to copy off-site; that folder
only ever holds `.hbk` files (and `.hbk.part` while one is being written). The plain database snapshot each backup
is made from lives in `data/backups/.tmp` (readable by Hearth alone) and is deleted afterwards, at shutdown, and at
start-up when a crash left one (anything untouched for 10 minutes). Copying with rclone yourself? Use
`rclone copy data/backups/encrypted remote:hearth --include '*.hbk'`. `cli.js restore` and `verify-backup` warn
when a backup comes from a newer Hearth, which this version won't start on.

## Making money without being invasive

Hearth's chats are end-to-end encrypted, so there's no data to sell even if you wanted to. That's a selling
point, not a limit. Everything below is built in (Admin → Money and Admin → Owner).

**First: get a domain (about $10/year).** Ko-fi and Stripe only send payment notices to a real HTTPS address, and
a domain also makes the Android app, installable app and push notifications work without certificate warnings.
Point it at your server and put Caddy in front (README → "On a VPS with a domain").

1. **Automatic supporters (Admin → Money).** People pay, and their 💜 supporter badge and perks switch on by
   themselves, for as long as they paid for (price per month is yours to set; paying twice as much lasts twice as
   long; monthly subscriptions renew themselves).
   * **Ko-fi:** 0% fee on one-off tips. People paste their personal support code (shown in their Support window)
     into the Ko-fi message.
   * **Stripe Payment Link:** cards, Apple Pay, Google Pay, monthly subscriptions (~2.9% + 30¢). The app adds each
     person's code to the link, so nothing needs pasting.
   * Payments without a code wait in Admin → Money: one click gives them to the right person.
   * Payments also count toward the funding card's "raised this month" by themselves.
   * Changing where money goes (the Ko-fi page or token, the Stripe link or signing secret, the funding card's
     donation link) needs your password again, and every change is audit-logged (without the secrets).
   * Refunds and chargebacks don't take supporter time away; unmark the supporter by hand in Admin → Users.
   * If one Stripe account sends events to both webhooks, `/api/pay/stripe` ignores creator-membership payments,
     so they aren't counted as donations.
2. **Perks that cost you money to provide, never basics.** More storage (Owner → Funding), bigger files (Money →
   perks), the badge. Keep chat, privacy, calls, profiles, games & music free: that's the promise that makes
   people trust you.
3. **The funding card.** Shows the real monthly cost and how much is covered on everyone's Home screen (they can
   hide it). Honest numbers are the best fundraiser: see "Cost per person" above.
4. **Hosted Hearth for other communities.** Clubs, classes, gaming groups pay ~$3–10/month and you run their own
   private Hearth (one per small VPS, or several per server with Docker). Your updater and backups already make
   this manageable, and each one is another source of supporters.
5. **One-off support.** Sponsor-a-month, stickers/merch of the community's in-jokes.
6. **Creator memberships (Admin → Money → Creator memberships).** Server owners sell monthly memberships to
   their own fans, like Patreon built into their server: each membership gives a role, and roles can open
   private channels (#behind-the-scenes, early videos, study notes). Members pay on Stripe's own page; the money
   goes straight to the creator's Stripe account (Stripe Connect Express handles their identity checks, payouts
   and tax forms), and your Hearth keeps the fee you set (5% by default, 0–30%) automatically. Nobody who doesn't
   join pays anything, and nothing that's free today moves behind it: you earn when creators earn.
   * Set up once: Stripe → Connect (Express accounts), paste a secret key and add a webhook to
     `https://your-server/api/pay/memberships` (events `checkout.session.completed`,
     `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`), then turn it on.
   * Setting or changing the Stripe key or webhook secret needs your password again.
   * Roles with moderator powers can't be sold, and a sold role can't gain them later. Leaving or being removed
     from a server stops renewals at the end of the paid month; deleting a server ends all its memberships right
     away. If Stripe is down at that moment, the cancellations are kept and retried every hour until Stripe
     confirms them; Admin → Money shows how many are waiting and Stripe's last error.
   * With Express accounts the platform (you) is responsible for refunds and disputes Stripe can't recover
     from the creator, so only enable it for creators you trust, and read Stripe's Connect terms.

What a realistic month looks like: at $3/month per supporter, about 5% of active people chipping in covers a
$10–15 server for a community of 100. Bigger communities cover regions and hosting for smaller ones.

Avoid: ads, tracking pixels, selling data, paywalling safety or privacy features.

## Telling people about it

* **The pitch:** "Private by design — your chats are end-to-end encrypted, so the server only stores scrambled
  data. No ads, no tracking.
  MySpace-style profiles, watch-together, voice and video. Runs for under a cent per person a month, paid for
  by the community." Back it with real numbers (this page) and a public "what it costs" note on the funding
  card.
* **Where:** short videos of profile customization (MySpace nostalgia travels well), invite links passed
  between friend groups (each server owner becomes a recruiter), privacy and self-hosting communities
  (r/privacy, r/selfhosted), and a "Show HN"/Product Hunt launch when you're ready for a spike — the
  capacity numbers above say one server can take it.
* **Be careful with:** claims you can't back up. "End-to-end encrypted" is true for messages, files and calls;
  who-talks-to-whom (metadata) is visible to the server — say so. Don't promise that even a hostile host can't
  read chats: the apps load their code from the server, so people are trusting whoever runs it (see SECURITY.md
  §4).

## Things to keep an eye on legally

* GIFs: storing copies of KLIPY/GIPHY GIFs ("keep a copy of GIFs people send") may break their terms —
  it's off by default; check before turning it on. Your own uploaded library is fine.
* User uploads: have a way to receive takedown requests (the Terms page and Reports cover most of this),
  and set the age requirement in your Terms (13+ in most places).
* Watch together embeds the official YouTube/Vimeo/Twitch players, which is allowed; each viewer loads the
  video from them directly.
* Game pictures: Hearth shows Steam store art and Wikipedia images to identify games (and caches them on your
  server so Steam/Wikipedia never see your members). That's how game launchers and chat apps commonly show games;
  don't reuse the art for anything else.
* Last.fm: their API is free for non-commercial use. If you start charging for Hearth itself (hosting it for
  others), read their API terms first.
* Payments: money from Ko-fi/Stripe is income. Keep the Admin → Money list (or your Ko-fi/Stripe exports) for
  taxes, and make clear supporters are paying for the server, not buying a guaranteed service.
* Memberships: your fee is income too (Stripe lists it as application fees). Creators are responsible for
  delivering what they promise; your Terms should say memberships are between the member and the creator.
