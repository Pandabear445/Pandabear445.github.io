# Running Hearth: logs, health, alerts and the doctor

This page is for the person who runs a Hearth server. It covers what Hearth writes to its log, the health
endpoints and what each one means, how to wire them into a reverse proxy or Docker, metrics for Prometheus, the
`doctor` command, the alerts the owner gets and where else they can go, and how the updater checks an update. The
last section lists what Hearth still doesn't do.

Paths are relative to `hearth/`.

## 1. Logs

Hearth writes one line per event to standard output (warnings and errors to standard error). Docker keeps it with
its log driver (`docker compose logs hearth`); systemd sends it to the journal (`journalctl -u hearth`).

### Format

By default each line is a JSON object, which log tools (Loki, Vector, `jq`) read directly:

```json
{"ts":"2026-10-10T19:31:29.184Z","level":"info","component":"http","op":"request","reqId":"abc-123","method":"GET","route":"/api/users/:id","status":200,"durationMs":3.2,"outcome":"ok","uid":"5f0c1d2e9a7b","ip":"198.51.100.0/24"}
```

With `LOG_FORMAT=pretty` (the default when Hearth runs in a terminal) the same event reads:

```text
2026-10-10T19:31:29.184Z INFO  http request  reqId=abc-123 method=GET route=/api/users/:id status=200 durationMs=3.2 outcome=ok uid=5f0c1d2e9a7b ip=198.51.100.0/24
```

Fields:

| Field | Always | Meaning |
|---|---|---|
| `ts` | yes | Time, ISO 8601, UTC. |
| `level` | yes | `debug`, `info`, `warn`, `error` or `fatal`. |
| `component` | yes | Which part of Hearth: `http`, `server`, `jobs`, `backup`, `security`, `alerts`, `db`, `socket`, `process`, … |
| `op` | yes | What happened, as a short word: `request`, `slow_request`, `run_failed`, `listening`, `failed_login`, … |
| `msg` | often | A plain-English sentence for people. |
| `reqId` | in requests | The request id (see below). Every line written while a request is handled carries it. |
| `job` | in jobs | The background job that wrote the line. |
| `outcome` | often | `ok`, `denied` (4xx), `error`, `slow`, `sent`, `crash`. |
| `durationMs` | timed events | How long it took. |
| `errorCategory`, `error` | errors | A short, safe category (`db_busy`, `disk_full`, `network`, `timeout`, `permission`, `bug`, …) and the error's name, code, scrubbed message and stack. |

Settings (environment):

| Variable | Default | |
|---|---|---|
| `LOG_FORMAT` | `json` (`pretty` in a terminal) | `json` or `pretty`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `LOG_ACCESS` | `on` | `on`, `errors` (only 4xx/5xx and slow requests) or `off`. |
| `LOG_ACCESS_SAMPLE` | `0.2` | Share of *successful* GET/HEAD requests logged. Everything else (other methods, errors, slow requests) is always logged. `1` logs all. |
| `LOG_SLOW_MS` | `1000` | Requests at least this slow are logged as `slow_request` at `warn`. |
| `LOG_FULL_IP` | `false` | `true` logs full IP addresses instead of their network. |

### Request ids

Every HTTP response has an `X-Request-Id` header. If the request already had one (from Caddy, nginx or a load
balancer) made of letters, digits and `._:-`, up to 64 characters, Hearth keeps it; otherwise it makes one up.
When someone reports "it broke at 14:02", ask for the id from the browser's network tab and search the log for it.

To pass Caddy's own id through:

```caddyfile
reverse_proxy hearth:3000 {
	header_up X-Request-Id {http.request.uuid}
}
```

### The access log

One line per HTTP request: method, **route template** (`/api/users/:id`, never the real URL with its ids, search
words or tokens), status, duration, a keyed hash of the user id (`uid`: lines about one person can be grouped,
but the hash can't be checked against a list of user ids), and the client's network. Socket.IO traffic isn't in
the access log.

### What never appears in the log

Redaction happens centrally in `server/log.js`, so a careless log call can't leak a secret:

- Fields named like `token`, `password`, `authKey`, `secret`, `authorization`, `cookie`, `recovery…`,
  `ciphertext`, `body`, `text`, `content`, `key`, … are written as `[redacted]`.
- In free text (messages, error messages, stack traces): `Bearer …` and `Basic …` credentials, `token=`, `key=`,
  `k=`, `code=` and similar values, URL query strings, 40+ character hex strings (session tokens, reset tokens,
  keys) and long base64 runs (ciphertext, wrapped keys) are replaced with `[redacted]`.
- IP addresses in address fields are cut to their network: `198.51.100.0/24` for IPv4, the first 48 bits for
  IPv6. `LOG_FULL_IP=true` turns that off. (Hints about your *proxy's* address, such as "X-Forwarded-For from
  172.19.0.3 was ignored", keep the address: you need it to set `TRUST_PROXY`.)
- Message contents can't appear: the server never has them (they're end-to-end encrypted), and request bodies
  are never logged.
- Link previews: the server does see the links people ask a preview for (it fetches them), but never logs
  them. Each preview writes one `debug` line, `linkpreview preview`, with the outcome, the reason, the kind,
  whether it came from the cache, the time taken and the picture's size: no link, host or title. Failures log
  netguard's error code only (its messages can name the host). The access log names the route,
  `/api/link-previews`, as for every request.

**Link previews and you, the operator.** When a member presses Preview, this server downloads that page and
one picture from it, holds them in memory for up to 10 minutes for that member only, and sends them to their
app. Nothing is written to disk or backed up. Like the news bot, it means your server fetches pages your members
choose. To stop it: **Admin → Owner → Features → Link previews** (or `LINK_PREVIEWS=false` before first start);
the route then answers 404 and apps stop offering previews. Cards already sent still show: they're inside the
messages. `OUTBOUND_BLOCK` applies to these fetches too.

The security log (Admin → Security) still keeps the last 500 events in memory with full addresses for staff;
each event also goes to the server log with the network only.

## 2. Background jobs

Everything Hearth does on a timer runs through `server/jobs.js`: rate-limit sweeps, upload clean-up, session
purge, each server's audit log retention (`serveraudit.prune`), event reminders, the news bot's feed and tracker polling, backups, Last.fm polling, supporter expiry,
membership reconciliation and retries, the socket session sweep, alert checks, disappearing messages
(`messages.expire`: a precise timer for the next deadline, a safety sweep every `DISAPPEAR_SWEEP_MS`, 60 s by
default, and a run at start-up), and the small debounced broadcasts (presence, profile updates, watch-together).

A `serveraudit` `hard_cap` warning means one server's audit log passed 200,000 entries and its oldest went,
moderation entries from the last week included. Normal servers never get near that: look at who wrote the flood
(it's in that server's log) before anything else.

- An error in a job, thrown or rejected, is caught and logged (`component: jobs`, `op: run_failed`, with
  `job` and `errorCategory`). It never reaches the top level. (Before, one `SQLITE_BUSY` in a timer could crash
  the server.)
- Each job keeps a health record: last run, last success, last error, failures in a row, total runs. A job
  failing 3 times in a row counts as broken; one that hasn't run for 3 of its periods counts as late.
- A run still going when the next one is due is skipped (counted), not stacked.
- Records are saved to the `job_health` table at most once a minute per job, and right away when a job starts or
  stops failing, so Admin → Health shows them after a restart and `doctor` can read them from outside.

Wake-up timers that touch the database run through the same wrapper (`jobs.job`): the bot delivery pump's
wake-ups (`bots.deliveries`), the end of a call's reconnect grace window (`voice.grace_end`), each timeout's
expiry (`usability.end_timeouts`) and the batched server update after members pick their own roles
(`selfroles.broadcast`). Timers that only do arithmetic or clean memory aren't jobs: each socket's
1-second flood-allowance refill, the export-token sweep, slash-command answer timeouts, fetch timeouts and the
shutdown timers.

### Crashes

- A promise rejection nobody handled is logged (`op: unhandled_rejection`) and the server keeps running.
- An exception nobody caught is logged (`level: fatal`, `op: uncaught_exception`, with the error and uptime),
  job records are saved, and the process **exits with status 1**. Its state can't be trusted after that, so it's
  better to start fresh: `deploy/hearth.service` (`Restart=on-failure`) and `docker-compose.yml`
  (`restart: unless-stopped`) restart it within seconds.

## 3. Health endpoints

| Endpoint | Who | Answers | Use it for |
|---|---|---|---|
| `GET /api/health/live` | anyone | `200 {"status":"ok"}` while the process answers HTTP. Nothing else. | Liveness: Docker `HEALTHCHECK`, systemd watchdogs, "restart if dead". |
| `GET /api/health/ready` | anyone | `200` or `503` with `{"status":"ok"\|"degraded"\|"fail","codes":[…]}` | Readiness: load balancers, uptime monitors, "send people here?" |
| `GET /api/admin/health` | instance admins | Everything below, in detail. | Admin → Health, and scripts with an admin session. |

`/api/health/live` and `/api/health/ready` need no sign-in, aren't affected by maintenance mode or IP bans, and
allow 600 requests a minute per network. They reveal no versions, paths, hostnames or numbers.

### Ready: what the codes mean

Ready checks four things, plus disk space:

| Code | Status | HTTP | Meaning |
|---|---|---|---|
| (none) | `ok` | 200 | All good. |
| `disk_low` | `degraded` | 200 | Under 10% (or 1 GB) free where the data lives. Still working. |
| `maintenance` | `degraded` | **503** | Maintenance mode is on: only staff can use the server. Not a fault, but don't send people here. |
| `db` | `fail` | 503 | The database didn't answer a query. |
| `schema` | `fail` | 503 | The database version isn't the one this code expects. |
| `data_dir` | `fail` | 503 | Hearth couldn't write a small file in its data folder (permissions, read-only mount, full disk). |
| `disk_full` | `fail` | 503 | Under 3% (or 200 MB) free. |

`HEALTH_DISK_WARN_PCT` and `HEALTH_DISK_FAIL_PCT` change the 10% and 3%.

**Degraded vs failed**: *degraded* means it works but someone should look; *fail* means it's broken or about to
be. `200` means "send people here", `503` means "don't".

### Admin health

`GET /api/admin/health` (Admin → **Health** in the dashboard, refreshing every 15 seconds) adds:

- **Background jobs**: every job's record and status (`ok`, `degraded` when failing or late, `fail` after 3
  failures in a row).
- **News bot**: whether the feed worker actually *ran* recently, not just that the bot account exists. With feeds
  or trackers set up, it's degraded when the worker is over 2.5 minutes late and failed after 5 minutes (it runs
  every minute), or when more than half the feeds are failing.
- **Relay regions**: each region's last heartbeat; one that was installed and has been silent for 3 minutes is
  down (degraded).
- **Backups**: the newest encrypted backup and its age (degraded after 26 hours, failed after 50), the last
  restore test, the last off-site copy, and the backup job. Automatic backups off is degraded; a failed restore
  test of the newest backup is a failure.
- **Disk** for the data folder, with the same thresholds as ready.
- **Process**: event-loop lag (p99 and worst over the last minute: degraded over 200 ms, failed over 1 s),
  memory, uptime, version, Node version, schema version, open connections.
- **Security**: failed sign-ins, robot checks and blocked connections in the last 10 minutes, and unexpected
  server errors in the same window.
- **Alerts**: the settings, the alert channels (masked) with their last delivery, and the last 30 alerts.
- **Alert channels**: degraded when a switched-on channel's last 3 deliveries failed (`channel_failing`).

The overall status is the worst of the parts.

### Reverse proxy and Docker health checks

Docker: the image's own `HEALTHCHECK` (Dockerfile) already probes `/api/health/live`. To use readiness instead, or
for another orchestrator, add one in `docker-compose.yml`. The image has no curl, so use Node:

```yaml
services:
  hearth:
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
```

(With `HTTPS=true` and a self-signed certificate, the shipped `Dockerfile` check, which tries both http and https,
is the one to keep; point its URL at `/api/health/live` instead of `/api/config`.)

Use **live** for restarts: a server in maintenance or short of disk is still alive, and restarting it doesn't
help. Use **ready** to decide whether to send traffic.

Caddy, with active health checks (useful with more than one upstream, or to have Caddy answer 503 itself):

```caddyfile
chat.example.com {
	reverse_proxy hearth:3000 {
		health_uri /api/health/ready
		health_interval 15s
		health_timeout 5s
		header_up X-Request-Id {http.request.uuid}
	}
}
```

nginx (open source) has no active checks; point an uptime monitor (Uptime Kuma, Gatus, healthchecks.io's HTTP
check, a cron job with curl) at `https://your.domain/api/health/ready` and alert on anything but `200`.

### Metrics for Prometheus (`/metrics`)

`GET /metrics` answers in Prometheus's text format (`text/plain; version=0.0.4`). It's **off** unless
`METRICS_TOKEN` is set in the environment, at least 16 characters (`openssl rand -hex 32`); shorter keeps it off
and says so in the log. Off, it's a plain `404`.

- **Auth:** `Authorization: Bearer <METRICS_TOKEN>`, compared in constant time. Anything else is `401` with
  `WWW-Authenticate: Bearer`. The token is never accepted in the address. 20 wrong tokens from one network
  (an IPv4 address or an IPv6 /64) in 10 minutes and that network gets `429` for the rest of the window, the right
  token included, so guessing doesn't pay. 600 scrapes a minute per network. So scrape from an address that
  visitors don't share: if people reach Hearth's published port directly, Docker can show them all as its gateway
  (`172.x.0.1`), and someone sending wrong tokens could then lock out a scraper on that same address. Scraping
  `http://hearth:3000/metrics` from a container on the same Docker network, or through the proxy with
  `TRUST_PROXY` set, keeps the scraper's address its own.
- **What's in it:** only numbers about the instance. Labels are a status class, a background job's fixed name, a
  message kind, and the version; never a person, a name, an id, an IP or a server.

| Metric | Type | What |
|---|---|---|
| `hearth_info{version,schema,node}` | gauge | always 1 |
| `hearth_ready` | gauge | 1 when `/api/health/ready` would say ready |
| `hearth_process_uptime_seconds` | gauge | since the process started |
| `hearth_event_loop_lag_p99_seconds`, `hearth_event_loop_lag_max_seconds` | gauge | over the last sampled minute (the first sample is 15 s after start) |
| `hearth_process_resident_memory_bytes`, `hearth_process_heap_used_bytes`, `hearth_process_heap_total_bytes` | gauge | memory |
| `hearth_http_requests_total{class="1xx".."5xx"}` | counter | HTTP answers by status class (Socket.IO traffic isn't counted) |
| `hearth_unexpected_errors_total` | counter | error-level log lines (the same ones the "repeated errors" alert counts) |
| `hearth_sockets` | gauge | open live connections |
| `hearth_job_last_run_timestamp_seconds{job}`, `hearth_job_last_success_timestamp_seconds{job}` | gauge | Unix time; absent until the job has run (or succeeded) |
| `hearth_job_runs_total{job}`, `hearth_job_failures_total{job}` | counter | since the process started |
| `hearth_job_consecutive_failures{job}` | gauge | failures in a row (3 is "broken" in Admin → Health) |
| `hearth_backups` | gauge | encrypted backups kept |
| `hearth_backup_last_timestamp_seconds`, `hearth_backup_age_seconds` | gauge | the newest encrypted backup; absent when there's none |
| `hearth_disk_free_bytes`, `hearth_disk_total_bytes` | gauge | where the data lives |
| `hearth_registered_users` | gauge | accounts (bots and webhooks not counted); counted at most once a minute |
| `hearth_messages{kind="channel"\|"direct"}` | gauge | messages stored; counted at most once a minute |

Counters start again at 0 when Hearth restarts (Prometheus's `rate()` and `increase()` handle that).

A scrape config:

```yaml
scrape_configs:
  - job_name: hearth
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/hearth-token   # the same value as METRICS_TOKEN
    static_configs:
      - targets: ['chat.example.com']
```

Behind Caddy with `HTTPS=false`, Hearth refuses plain-HTTP requests that come straight from the internet, so
Prometheus either goes through the proxy (as above) or scrapes `http://hearth:3000/metrics` from the same Docker
network or machine. To keep `/metrics` off the public site, add `respond /metrics 404` before `reverse_proxy` in
the Caddyfile and scrape Hearth directly.

Some alerting rules to start from: `hearth_ready == 0` for 5m; `hearth_backup_age_seconds > 26*3600`;
`hearth_job_consecutive_failures >= 3`; `rate(hearth_http_requests_total{class="5xx"}[5m]) > 0.1`;
`hearth_disk_free_bytes / hearth_disk_total_bytes < 0.1`; `hearth_event_loop_lag_p99_seconds > 0.2`.

## 4. The doctor

```sh
node server/cli.js doctor                    # in Docker: docker compose exec hearth node server/cli.js doctor
node server/cli.js doctor --relays           # also try to reach each relay region's TURN port
node server/cli.js doctor --integrity        # also run SQLite's quick_check (slower on big databases)
node server/cli.js doctor --json             # machine-readable
node server/cli.js doctor --fix-permissions  # the one repair: key files to 600, the data folder to 700
```

It reads the same `.env` and `DATA_DIR` as the server and prints one line per check:

```text
PASS  Database schema: version 18 (current)
WARN  Email (SMTP): not set. Password resets and owner alerts by email won't work.
FAIL  Backups: newest hearth-….hbk, 3 days ago; 7 kept. No backup for over two days: check the server log for "backup".

1 problem(s) to fix, 1 warning(s).
```

Exit status: **0** everything passed, **1** warnings only, **2** at least one failure. So `doctor` fits in a cron
job or a monitoring script.

What it checks:

- Hearth, Node and SQLite versions.
- The data folder: exists, writable by this user, not readable by everyone; key files (`secret.key`,
  `backup.key`, `vapid.json`, `key.pem`, the region SSH key) owner-only.
- The database: opens, its schema version against the code's (older: upgraded on next start; newer: fail).
- Configuration, **never printing values** ("set" / "not set"): `PUBLIC_URL` (and that it's https), the at-rest
  key, email, `ADMIN_USERS`, TURN.
- TLS and proxy assumptions: self-signed vs `SSL_CERT`; with `HTTPS=false`, that a proxy is expected and
  `ALLOW_DIRECT_HTTP` isn't on; `TRUST_PROXY` valid and consistent with how Hearth is reached (trusting
  forwarded addresses while serving HTTPS directly, or hop counts with `HOST=0.0.0.0`, are warnings).
- Disk space, with the same thresholds as the health checks.
- Backups: the backup key present (and a reminder that it isn't inside backups), the newest encrypted backup's
  age and restore-test result, off-site copies configured.
- Relay regions' last heartbeats (and, with `--relays`, a TCP connection to each one's TURN port).
- Background jobs as last recorded by the server: any job failing (3+ in a row is a failure).

**Read-only**: it never creates folders or files and never changes the database. A database without a `-wal`
file (Hearth stopped) of up to 256 MB is read from an in-memory copy, so not even SQLite's companion files
appear; otherwise it opens it read-only. It's safe to run while Hearth is running. The only change it can make is
`--fix-permissions`, which prints each `chmod` it does and why.

## 5. Alerts

The owner gets alerts for:

| Alert | When | Severity |
|---|---|---|
| Repeated errors | 10 or more unexpected errors (`ALERT_ERRORS`) in 10 minutes | warning |
| Daily backup failed | the hourly backup check failed to make the database copy or the encrypted backup | critical |
| Restore test failed | a new encrypted backup couldn't be restored in its test | critical |
| Off-site copy failed | rclone couldn't copy the backup to `BACKUP_RCLONE_REMOTE` | warning |
| Job keeps failing | any background job failed 3 times in a row (`ALERT_JOB_FAILURES`) | warning |
| Relay region down | an installed region hasn't sent a heartbeat for 3 minutes | warning |
| Disk low / almost full | under 10% / 3% free (the health thresholds) | warning / critical |
| Sign-in abuse | 50 or more failed sign-ins, failed password re-checks, failed robot checks or blocked connections (`ALERT_AUTH_FAILS`) in 10 minutes | warning |

Where they go:

- **The owner's email**, through the same mail path as account notices, if email is set up (Admin → Owner →
  Email) and the owner's account has a confirmed address.
- **The admin dashboard, live**: the `admin:alert` event to the `admins` room. Staff who have the app open see a
  toast; Admin → Health lists the last 30.
- **Alert channels** an admin added in Admin → Health → *Where alerts go*: ntfy, a signed webhook, Discord or
  Slack (below).

No storms:

- The same alert is sent **at most once per cooldown** (default 60 minutes; Admin → Health, or
  `ALERT_COOLDOWN_MIN`). What was held back in between is counted and mentioned in the next one.
- **At most 12 alerts an hour** in all. The one saying alert channels are failing has its own slot instead (at most
  once an hour), so it never holds back a real alert.
- The state is saved, so a restart (or a crash loop) doesn't send everything again.
- When a condition clears (a job works again, disk is freed, a region comes back), its alert is armed again.

Alerts never include secrets or message contents: only what happened, counts, and short, scrubbed error
descriptions.

Switching: Admin → Health → Alerts (on/off, email on/off, cooldown) or `ALERTS=off` in the environment as the
default. Turning alerts or alert emails **off** needs the password (and two-factor) again, like reducing backups,
because it's what someone covering their tracks would do; so does a cooldown longer than an hour (at a week, each
kind of alert would reach the owner once a week). Both are recorded in the audit log. "Send a test alert"
checks that they reach you (the email and every channel that's on).

### Alert channels

Admin → Health → **Where alerts go** adds places besides the owner's email (up to 10):

| Kind | What you give it | What it sends |
|---|---|---|
| **ntfy** | the server (`https://ntfy.sh`, or your own), a topic, and optionally an access token (`tk_…`) | a JSON publish to the server: the topic, `title` ("<instance name>: <alert>"), `message`, `priority` 5 for urgent alerts and 4 for the others, a tag; `Authorization: Bearer <token>` when there's a token |
| **Webhook** | an address | `POST` with JSON `{ v: 1, id, type: "alert" \| "alert.test", createdAt, server, alert: { key, severity, title, detail, held, at } }`, signed (below) |
| **Discord** | a Discord webhook URL (or anything that takes Discord's format) | `{ content, allowed_mentions: { parse: [] } }`, so nothing in an alert can ping anyone |
| **Slack** | an incoming-webhook URL from Slack, Mattermost, Rocket.Chat… | `{ text }`, with `&`, `<` and `>` escaped as Slack asks |

The words are the email's: the alert's title and details, how many were held back, and "Open Admin → Health". No
names, addresses or message content, as with the email.

**Webhook signature**, the same scheme as bot webhooks (`docs/BOTS.md`): headers `X-Hearth-Event`,
`X-Hearth-Delivery` (the body's `id`), `X-Hearth-Timestamp` (Unix seconds) and
`X-Hearth-Signature: v1=<hex>`, where `<hex>` is HMAC-SHA256 of `"<timestamp>.<raw body>"` with the channel's
signing secret. The secret is shown once, when the channel is added; to get a new one, remove the channel and add it
again. Check the signature against the raw bytes, compare in constant time, and refuse old timestamps.

**Secrets:** addresses, topics (on a public ntfy, whoever knows the topic can read it) and tokens are sealed at rest
with the server's key (`data/secret.key`, like the SMTP password) in the `alertChannels` setting, and only a masked
form ever goes to the browser or the audit log: the server and the last four characters (`https://discord.com/••••x9Qz`,
`topic ••••ab12`). A long first part of a host name is masked too, since some services put the secret there
(`https://••••7e64.m.pipedream.net/••••`), and so is the path of an ntfy server. Restoring a backup without its `secret.key` leaves channels unreadable: remove and add them again.

**Who can do what:** instance admins add channels, rename them, turn them on and use **Test**. Turning one **off**,
changing where it points (address, topic or token) or **removing** it needs the password again, and a fresh
two-factor code each time when that's on, for the same reason as turning alerts off: someone covering their tracks
would quietly redirect alerts. So does making the cooldown longer than an hour. A new address is checked before the
code is asked for, so a typo doesn't use one up. Everything is in the audit log. Limits: 30 changes and 20 tests an hour per admin.

Moving an ntfy channel to a **different server** needs its topic typed again (and its access token, if the new
server needs one): the saved ones are never sent to another server, since whoever runs it would learn them. The
ntfy topic's own address pasted as the server (`https://ntfy.sh/my-topic`, with the topic `my-topic`) is taken
apart into the server and the topic; end the address with `/` when the path is your ntfy's own
(`https://example.com/alerts/` with the topic `alerts`).

**The network:** deliveries go through the same guard as feeds and push (`server/netguard.js`): `https` only, every
address the name has must be public (no private, loopback, link-local, CGNAT or cloud-metadata addresses, however
they're written), the connection goes to the address that was checked (no DNS rebinding), redirects aren't
followed, one delivery may take `ALERT_CHANNEL_TIMEOUT_MS` (8 s) in all, and at most 16 KB of the answer is read.
A service on your own network (a self-hosted ntfy on the LAN or a Docker network) must be named in
`ALERT_PRIVATE_HOSTS`: exact names or addresses, on the default port unless the entry has one (`ntfy.lan:8080`,
`[fd00::5]:8443`). Only those hosts may use plain `http`. Addresses are checked when a channel is saved and again
on every delivery.

**Status:** each channel shows its last delivery (when, the answer, the error) and how many real alerts failed in a
row. Any 2xx answer counts as delivered. A switched-on channel whose last 3 alerts failed makes Admin → Health
*degraded* and raises an alert ("Alerts can't reach the … channel", or "… N alert channels" naming them), which goes
out through the email and the other channels. That's one alert for all failing channels, at most once an hour and
outside the 12-an-hour cap, so broken channels (or an admin adding a pile of them) can't hold back real alerts.
**Test** sends a test to that one channel, on or off, and shows what came back; a failed Test is shown but doesn't
count toward "failing", and one that gets through resets it.

**ntfy tips:** on ntfy.sh, pick a long random topic. On your own ntfy with `auth-default-access: deny-all`, make a
token for a user with write access to the topic (`ntfy token add <user>`, `ntfy access <user> <topic> write-only`).
`401`/`403` from ntfy means the token or its access is wrong.

## 6. Updates: checksums and signatures

`hearth-update` checks a private copy of each update zip before anything in it is unpacked or run:

1. **Checksum:** `<zip>.sha256` next to it must match. Without one it prints the SHA-256 for you to compare.
2. **Signature**, once this server has an update signing key pinned in `/etc/hearth-update.pub`: `<zip>.sig` must
   be a valid signature by that key (docs/SIGNING.md, "Signing server updates"). The key is pinned from the
   installed Hearth's `update-signing.pub` at its first update (when that file and the folders above it are
   root's alone), or from the first update that brings one; after that it only changes when an update signed
   with the current key brings a new one. Checking takes OpenSSL 3.0 or newer (Debian 12, Ubuntu 22.04) or, on
   older systems, Node.js; a server with neither pins nothing and stays on checksums.
3. **Version**, on a server that checks signatures: an older version is refused (`--allow-downgrade` overrides;
   `--rollback` puts back your own backup instead).

```sh
hearth-update --status              # "update key: …" says which key is pinned, or that none is
hearth-update --verify update.zip   # all three checks, nothing installed or changed (not even the pinned key);
                                    # the zip's path is from where you are, its .sha256 and .sig next to it
```

What the update log says, and what to do:

| Message | Meaning |
|---|---|
| `isn't signed … This server has no update signing key pinned yet` | Checked against the checksum only, as before signing. Fine until the publisher signs updates. |
| `now only installs updates signed with the key this update brought: …` / `Pinned the update signing key that came with this Hearth` | A key was pinned. Compare it with the one in the release notes. |
| `The update signing key is now …` | A key change, from an update the old key signed. |
| `isn't signed (no ….sig next to it). Nothing was changed.` | Put the `.sig` from the release next to the zip and run again. |
| `has a signature that doesn't match this server's update key` | Not the published zip, or signed with another key (a key change you skipped: install the release that changed it first). Don't override this unless you checked the zip some other way. |
| `can't be checked: … isn't an update signing key` | `/etc/hearth-update.pub` is damaged. Every update is refused until it's fixed or deleted. |
| `can't be checked: this server can't check Ed25519 signatures` | A key is pinned, but neither OpenSSL 3.0 or newer nor Node.js is installed (OpenSSL 1.1.1, as on Ubuntu 20.04 and Debian 11, can't check them). Install Node.js (Hearth's own, outside Docker) or a newer OpenSSL. |
| `… but this server can't check Ed25519 signatures …, so it isn't pinned` | No key is pinned yet and this server couldn't check one, so updates stay on checksums. Install Node.js or OpenSSL 3.0+ and the next key-carrying update pins its key. |
| `update-signing.pub (or a folder it's in) can be changed by an account other than root, so it isn't trusted` | The installed Hearth's own key isn't pinned (its folder belongs to Hearth's account, as in plain installs); the first update that brings a key pins that one. Compare it with the release notes. |
| `is Hearth X, older than the installed Y` | Use `hearth-update --rollback` to go back, or, if you really mean it, put the zip and its `.sig` on the server and run `sudo hearth-update --allow-downgrade <zip>` there. |
| `Going ahead anyway because of --allow-unsigned` / `installed WITHOUT a valid signature` | Someone overrode the check for this update. The full log stays in `/root/hearth-backups/last-update.log`. |

Run the updater that's already installed (`sudo hearth-update <zip>`), not the copy inside a new zip: then the
copy you already trust does the checking. On a server that has never run it, install it once from the current
Hearth folder: `sudo install -m 755 scripts/hearth-update.sh /usr/local/bin/hearth-update`. An updater from before
signed updates doesn't check signatures; `hearth-update --status` without an "update key" line means it's one of
those, so install the current one the same way.

### Database copies made before upgrades

Before a database upgrade, Hearth saves `data/backups/hearth-before-v<version>-<date>.db` (see
[RECOVERY.md](RECOVERY.md), "Upgrades and rolling back"). Once the upgrade has gone through, older copies beyond the
newest `PRE_UPGRADE_KEEP` (in `.env`, default `3`) are deleted, and the log says which (`db upgrade_backup_pruned`).

- The copy that upgrade made, or found already made, always stays. While an upgrade keeps failing, nothing is pruned.
- Only plain files named exactly the way Hearth names them are removed. A renamed copy, a link, a folder, the daily
  `hearth-auto-*.db` copies and the encrypted backups are never touched by this.
- `PRE_UPGRADE_KEEP=0` keeps every copy (the behaviour before 1.29.0). A value that isn't a whole number logs
  `db upgrade_backup_keep` and uses 3.
- The copies aren't encrypted: each holds what the database holds. Keep the data folder private, and use the
  encrypted backups for anything that leaves the machine.

## 7. Self-hosted ntfy for Android notifications

The Android app gets notifications while it's closed through a UnifiedPush push app, usually ntfy, which by default
uses the public ntfy.sh. That works, but ntfy.sh then learns that a phone gets notifications from your server, and
when (never what: everything is encrypted for the phone), and it has daily limits. Running your own ntfy next to
Hearth avoids both. The phone's ntfy app is the same; only its server changes.

1. **Run ntfy** (server 2.12 or newer) behind the same reverse proxy, on its own name, for example in
   `docker-compose.yml`:

   ```yaml
     ntfy:
       image: binwiederhier/ntfy   # pin a version you've checked
       command: serve
       restart: unless-stopped
       volumes: ["./ntfy:/etc/ntfy", "./ntfy-cache:/var/cache/ntfy"]
   ```

   with `ntfy/server.yml`:

   ```yaml
   base-url: https://ntfy.example.com
   behind-proxy: true
   cache-file: /var/cache/ntfy/cache.db
   auth-file: /var/cache/ntfy/user.db
   auth-default-access: deny-all
   # Every notification comes from Hearth's address: don't rate-limit it like one visitor.
   visitor-request-limit-exempt-hosts: <your Hearth server's public IP>
   ```

   and in the Caddyfile `ntfy.example.com { reverse_proxy ntfy:80 }`.
2. **Access:** Hearth publishes without an account, to topics starting with `up`:
   `docker compose exec ntfy ntfy access '*' 'up*' write-only`. People's ntfy apps need to read: create a user
   (`ntfy user add hearth`, then `ntfy access hearth 'up*' read-only`) and have people sign in with it in the ntfy
   app (Settings → Manage users). Without `deny-all` anyone could use your ntfy for anything.
3. **Tell Hearth:** `PUSH_NTFY_URL=https://ntfy.example.com` in `.env`. Settings → Apps & devices then tells people
   to set it as the ntfy app's default server (and to turn notifications off and on once). Optionally
   `PUSH_HOSTS=…,ntfy.example.com` so Hearth sends nowhere else (list the browser push services your people use too:
   `fcm.googleapis.com,*.push.services.mozilla.com,*.notify.windows.com,web.push.apple.com`).
4. **Same machine or LAN:** if `ntfy.example.com` resolves to a private address from where Hearth runs (a Docker
   network, split DNS), Hearth refuses it like any private address; name it in `PUSH_PRIVATE_HOSTS=ntfy.example.com`
   (port 443 unless you write `name:port`). Nothing else private is let through.

**Troubleshooting:** the log line `push refused host=ntfy.example.com status=403` means ntfy turned Hearth away
(the `up*` write rule is missing); `status=507` means nobody listens on that topic any more (the phone unregistered:
it's dropped after a few tries); `status=429` means ntfy's rate limit (Hearth waits as long as ntfy asks, and keeps
the phone). Each host and answer is logged at most once an hour, and never the address itself.

## 8. What's still missing

- **Metrics history.** `/metrics` (section 3) is point-in-time like Admin → Health; keeping history is up to
  Prometheus (or whatever scrapes it). There's no OpenMetrics format, no per-route timings and no histograms.
- **Multiple instances.** Job health, alert counters, rate limits and the security log live in one process (job
  health and alert state are also saved in that instance's database). Running several Hearth processes against
  one database isn't supported anyway.
- **External monitoring.** Hearth can't tell you it's down: if the process or the machine is gone, nothing sends
  an alert. Point an external uptime monitor at `/api/health/ready` for that.
- **More alert channels.** Email, the dashboard, ntfy, signed webhooks, Discord and Slack; no SMS, Matrix or
  Telegram (a webhook to a bridge works). A failed delivery isn't retried: the next alert, or Test, tries again.
- **Log shipping and retention** are up to Docker's log driver or journald (the compose file rotates at
  3 × 10 MB).
- **The security log** is still kept in memory (500 events) for Admin → Security; the server log now has a copy
  of each event.
- **Socket.IO events** aren't in the access log; unexpected errors in socket handlers are logged.
