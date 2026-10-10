# Running Hearth: logs, health, alerts and the doctor

This page is for the person who runs a Hearth server. It covers what Hearth writes to its log, the health
endpoints and what each one means, how to wire them into a reverse proxy or Docker, the `doctor` command, and the
alerts the owner gets. The last section lists what Hearth still doesn't do.

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

The security log (Admin → Security) still keeps the last 500 events in memory with full addresses for staff;
each event also goes to the server log with the network only.

## 2. Background jobs

Everything Hearth does on a timer runs through `server/jobs.js`: rate-limit sweeps, upload clean-up, session
purge, event reminders, the news bot's feed and tracker polling, backups, Last.fm polling, supporter expiry,
membership reconciliation and retries, the socket session sweep, alert checks, and the small debounced
broadcasts (presence, profile updates, watch-together).

- An error in a job, thrown or rejected, is caught and logged (`component: jobs`, `op: run_failed`, with
  `job` and `errorCategory`). It never reaches the top level. (Before, one `SQLITE_BUSY` in a timer could crash
  the server.)
- Each job keeps a health record: last run, last success, last error, failures in a row, total runs. A job
  failing 3 times in a row counts as broken; one that hasn't run for 3 of its periods counts as late.
- A run still going when the next one is due is skipped (counted), not stacked.
- Records are saved to the `job_health` table at most once a minute per job, and right away when a job starts or
  stops failing, so Admin → Health shows them after a restart and `doctor` can read them from outside.

The one timer not converted is each socket's 1-second flood-allowance refill: it's per connection and only does
arithmetic. Fetch timeouts and the shutdown timers aren't jobs either.

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
- **Alerts**: the settings and the last 30 alerts.

The overall status is the worst of the parts.

### Reverse proxy and Docker health checks

Docker (in `docker-compose.yml`, or a `HEALTHCHECK` in the Dockerfile). The image has no curl, so use Node:

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

No storms:

- The same alert is sent **at most once per cooldown** (default 60 minutes; Admin → Health, or
  `ALERT_COOLDOWN_MIN`). What was held back in between is counted and mentioned in the next one.
- **At most 12 alerts an hour** in all.
- The state is saved, so a restart (or a crash loop) doesn't send everything again.
- When a condition clears (a job works again, disk is freed, a region comes back), its alert is armed again.

Alerts never include secrets or message contents: only what happened, counts, and short, scrubbed error
descriptions.

Switching: Admin → Health → Alerts (on/off, email on/off, cooldown) or `ALERTS=off` in the environment as the
default. Turning alerts or alert emails **off** needs the password (and two-factor) again, like reducing backups,
because it's what someone covering their tracks would do; it's recorded in the audit log. "Send a test alert"
checks that they reach you.

## 6. What's still missing

- **Metrics export.** There's no Prometheus/OpenMetrics endpoint. Admin → Health and `/api/admin/health` are
  point-in-time; there's no history beyond the logs.
- **Multiple instances.** Job health, alert counters, rate limits and the security log live in one process (job
  health and alert state are also saved in that instance's database). Running several Hearth processes against
  one database isn't supported anyway.
- **External monitoring.** Hearth can't tell you it's down: if the process or the machine is gone, nothing sends
  an alert. Point an external uptime monitor at `/api/health/ready` for that.
- **Other alert channels.** Email and the dashboard only: no webhooks, Slack, ntfy or SMS yet.
- **Log shipping and retention** are up to Docker's log driver or journald (the compose file rotates at
  3 × 10 MB).
- **The security log** is still kept in memory (500 events) for Admin → Security; the server log now has a copy
  of each event.
- **Socket.IO events** aren't in the access log; unexpected errors in socket handlers are logged.
