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
3,000 relayed voice streams or ~100 relayed video streams fill the port. Pictures: a 1.5 MB photo seen by 30
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

1. *Add a region* → name it (e.g. "Frankfurt") → you get a one-line install command.
2. Rent the cheapest VPS there, log in as root, paste the line. It installs the relay with your server's secret,
   plus a tiny check-in that reports to your server every minute (address, CPU, memory, traffic this month).
3. Within a minute the region shows **Online** in Admin → Regions, and every call includes it.
4. Each person's app measures which relays answer fastest from where they are and uses the two nearest. A region
   that stops checking in is dropped from calls after 3 minutes and comes back by itself.
5. *Measure from this device* shows the times from wherever you are.

**Switching a call's region (like Discord).** Press the 🌐 region button in the call bar (or right-click a voice
channel) and pick a region, or *Automatic*. Everyone in the call moves over together within a second, without
hanging up; people who join later land in the same region. With a region picked, all of the call's audio and video
goes through that region's relay (still end-to-end encrypted: the relay only forwards scrambled packets). On
*Automatic*, people connect directly when they can and otherwise use the relays nearest to each of them.
In a server, changing a voice channel's region needs **Manage Channels**; in DM and group calls anyone in the call
can change it. If a picked region goes offline, the call falls back to Automatic by itself.

The install link expires after 24 hours (*Reinstall* makes a new one). When your server uses its own self-signed
certificate, the command pins that exact certificate, so the new region only ever talks to your server.

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
2. **Perks that cost you money to provide, never basics.** More storage (Owner → Funding), bigger files (Money →
   perks), the badge. Keep chat, privacy, calls, profiles, games & music free: that's the promise that makes
   people trust you.
3. **The funding card.** Shows the real monthly cost and how much is covered on everyone's Home screen (they can
   hide it). Honest numbers are the best fundraiser: see "Cost per person" above.
4. **Hosted Hearth for other communities.** Clubs, classes, gaming groups pay ~$3–10/month and you run their own
   private Hearth (one per small VPS, or several per server with Docker). Your updater and backups already make
   this manageable, and each one is another source of supporters.
5. **One-off support.** Sponsor-a-month, stickers/merch of the community's in-jokes.

What a realistic month looks like: at $3/month per supporter, about 5% of active people chipping in covers a
$10–15 server for a community of 100. Bigger communities cover regions and hosting for smaller ones.

Avoid: ads, tracking pixels, selling data, paywalling safety or privacy features.

## Telling people about it

* **The pitch:** "Private by design — the people running it can't read your chats. No ads, no tracking.
  MySpace-style profiles, watch-together, voice and video. Runs for under a cent per person a month, paid for
  by the community." Back it with real numbers (this page) and a public "what it costs" note on the funding
  card.
* **Where:** short videos of profile customization (MySpace nostalgia travels well), invite links passed
  between friend groups (each server owner becomes a recruiter), privacy and self-hosting communities
  (r/privacy, r/selfhosted), and a "Show HN"/Product Hunt launch when you're ready for a spike — the
  capacity numbers above say one server can take it.
* **Be careful with:** claims you can't back up. "End-to-end encrypted" is true for messages, files and calls;
  who-talks-to-whom (metadata) is visible to the server — say so.

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
