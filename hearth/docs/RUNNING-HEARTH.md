# Running Hearth: capacity, regions, costs and money

Numbers here were measured with Hearth 1.16 under load (simulated app windows connected over WebSockets,
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

## More regions, cheaply

* **Text chat doesn't need regions.** A message crossing the world takes 100–300 ms, which nobody notices in
  chat. Running copies of the server in several regions means syncing the database between them — a big
  rebuild that isn't worth it at this size.
* **Calls are where distance shows**, and only for the 10–20 % of people whose network needs the relay. Add
  small relay servers near those people. A relay only forwards call traffic, so the cheapest VPS works:
  * Oracle Cloud "Always Free" ARM VM — $0, generous traffic (sign-up needs a card).
  * Hetzner, Vultr, DigitalOcean, Contabo small plans — roughly $4–6/month, many regions.

  Setup (5 minutes per region):
  ```bash
  # on your Hearth server: print the shared secret
  node server/cli.js get-turn-secret
  # on the new small VPS (as root), with setup-turn.sh copied over:
  bash setup-turn.sh --relay-only --secret <that secret>
  # back on the Hearth server: add the address it prints
  node server/cli.js add-turn "turn:<ip>:3478?transport=udp,turn:<ip>:3478?transport=tcp"
  ```
  Calls try every relay and use whichever works best, automatically. Up to 6 relays (12 addresses).
* **Optional: Cloudflare's free plan** in front of your domain gives global caching of the app's files,
  DDoS protection and free HTTPS (WebSockets work on the free plan). Tell Caddy to trust Cloudflare's
  addresses so Hearth still sees real visitor IPs.

## Making money without being invasive

Hearth's chats are end-to-end encrypted, so there's no data to sell even if you wanted to — that's a selling
point, not a limit. Ways that fit:

1. **Community funding (built in).** Admin → Owner → Funding: show the real monthly cost, how much is covered
   and a Ko-fi / Patreon / Open Collective / Stripe link. It's a small card on Home that people can hide.
   Mark people who chip in as **supporters**: a 💜 badge and, if you like, more storage.
2. **Fair supporter perks.** Charge for things that cost you money to provide — more storage, bigger uploads,
   bigger GIF library — never for privacy, basic chat or profile customization (keep those free; that's the
   promise that makes people trust you).
3. **Hosted Hearth for other communities.** Clubs, classes, gaming groups pay ~$3–10/month and you run their
   own private Hearth (one per small VPS or several per server with Docker). Your updater and backup tools
   already make this manageable.
4. **One-off support.** Sponsor-a-month, stickers, merch for the community's in-jokes.

Avoid: ads, tracking pixels, selling data, paywalling safety features.

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
