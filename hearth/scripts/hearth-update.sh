#!/usr/bin/env bash
# Hearth updater — installs an update zip on this server, safely.
#
#   hearth-update /tmp/hearth-update.zip     install an update
#   hearth-update --rollback [backup]        go back to the version before the last update (or a chosen backup)
#   hearth-update --status                   where Hearth is, how it runs, its version, health, backups, disk space
#   hearth-update --logs                     Hearth's last 80 log lines (handy when reporting a problem)
#   hearth-update --list                     the saved backups
#   add --yes to skip the "are you sure?" question (for scripts)
#
# What it does:
#   1. Finds your Hearth folder and how it runs (Docker, systemd, pm2 or plain node).
#   2. Saves a copy of the current program files and database.
#   3. Copies in the new files — never touching data/, .env, docker-compose.yml or deploy/Caddyfile.
#   4. Builds the new version while the old one keeps running (a failed build changes nothing).
#   5. Swaps to the new version and checks it actually answers. If not, it rolls back by itself.
set -Eeuo pipefail

BACKUP_ROOT=/root/hearth-backups
CONF=/etc/hearth-update.conf
KEEP=5

c_y=$'\033[1;33m'; c_g=$'\033[1;32m'; c_r=$'\033[1;31m'; c_b=$'\033[1m'; c_0=$'\033[0m'
step() { printf '%s▸%s %s\n' "$c_y" "$c_0" "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_g" "$c_0" "$*"; }
warn() { printf '%s!%s %s\n' "$c_y" "$c_0" "$*"; }
die()  { printf '%s✗ %s%s\n' "$c_r" "$*" "$c_0" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run this as root (or with sudo)."

# Parse arguments: one action plus an optional --yes.
ACTION=update; ARG=""; YES=0
for a in "$@"; do
  case "$a" in
    --rollback) ACTION=rollback ;;
    --status|--doctor) ACTION=status ;;
    --logs) ACTION=logs ;;
    --list) ACTION=list ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Unknown option: $a (try --help)" ;;
    *) ARG="$a" ;;
  esac
done

mkdir -p "$BACKUP_ROOT"
LOG="$BACKUP_ROOT/last-update.log"
if [ "$ACTION" = update ] || [ "$ACTION" = rollback ]; then
  # Everything an update prints is also saved, so a failed run can always be looked at afterwards.
  # (--status, --logs and --list don't overwrite it.)
  exec > >(tee "$LOG") 2>&1
  printf 'Hearth updater started %s (log: %s)\n' "$(date)" "$LOG"
  # Only one update at a time (a double-click or a second terminal can't start another one halfway through).
  if command -v flock >/dev/null 2>&1; then
    { exec 9>/run/lock/hearth-update.lock; } 2>/dev/null || exec 9>/tmp/hearth-update.lock
    flock -n 9 || die "Another update is already running on this server. Wait for it to finish, then try again."
  fi
fi

# If any command fails unexpectedly, say exactly which one, so a stop is never silent.
# (Only in the main script: inside $(…) many commands are allowed to fail, e.g. pgrep finding nothing.)
on_err() { [ "$BASH_SUBSHELL" -eq 0 ] || return 0; printf '%s✗ Step failed (line %s): %s%s\n' "$c_r" "$1" "$2" "$c_0" >&2; }
trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR
WORK=""
on_exit() {
  local code=$?
  [ -n "$WORK" ] && rm -rf "$WORK"
  [ "$code" -ne 0 ] && printf '%s✗ Stopped (exit code %s). Full log: %s%s\n' "$c_r" "$code" "$LOG" "$c_0"
  return 0
}
trap on_exit EXIT

need() {
  command -v "$1" >/dev/null 2>&1 && return
  step "Installing $1…"
  { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$1"; } >/dev/null 2>&1 || die "Couldn't install $1. Install it and try again."
}
need unzip; need rsync; need curl

# Keep a copy of this script at /usr/local/bin/hearth-update so "hearth-update --rollback" always works.
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
if [ "$SELF" != /usr/local/bin/hearth-update ] && [ -f "$SELF" ]; then cp "$SELF" /usr/local/bin/hearth-update && chmod +x /usr/local/bin/hearth-update; fi

# ---------------------------------------------------------------- find the install
find_install() {
  local d="${HEARTH_DIR:-}"
  [ -z "$d" ] && [ -f "$CONF" ] && d="$(cat "$CONF")"
  if [ -n "$d" ] && [ -f "$d/server/index.js" ] && [ -d "$d/data" ]; then echo "$d"; return; fi
  local list=()
  while IFS= read -r db; do
    local dir; dir="$(dirname "$(dirname "$db")")"
    [ -f "$dir/server/index.js" ] && list+=("$dir")
  done < <(find / \( -path /proc -o -path /sys -o -path /var/lib/docker -o -path /root/hearth-backups \) -prune -o -path '*/data/hearth.db' -print 2>/dev/null)
  [ ${#list[@]} -eq 0 ] && return 1
  if [ ${#list[@]} -gt 1 ]; then
    if [ -t 0 ]; then
      echo "Found more than one Hearth install:" >&2
      local i=1; for x in "${list[@]}"; do echo "  $i) $x" >&2; i=$((i+1)); done
      local pick; read -rp "Which one? [1] " pick </dev/tty || pick=1; pick="${pick:-1}"
      [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le ${#list[@]} ] || { echo "Not a choice: $pick" >&2; return 1; }
      echo "${list[$((pick-1))]}"; return
    fi
    echo "Several installs found; set HEARTH_DIR to choose." >&2; return 1
  fi
  echo "${list[0]}"
}
DIR="$(find_install)" || die "Couldn't find Hearth on this server. Tell me where it is: HEARTH_DIR=/path/to/hearth hearth-update <zip>"
echo "$DIR" > "$CONF"
cd "$DIR"

# ---------------------------------------------------------------- how does it run?
# The systemd service whose WorkingDirectory is this folder (compared as paths, so spaces and "(1)" are fine).
find_unit() {
  local f wd here; here="$(readlink -f "$DIR")"
  for f in /etc/systemd/system/*.service; do
    [ -f "$f" ] || continue
    wd="$(sed -n 's/^[[:space:]]*WorkingDirectory=[[:space:]]*//p' "$f" | head -1 | sed -E 's/^"//; s/"[[:space:]]*$//; s/[[:space:]]+$//')" || true
    [ -n "$wd" ] && [ "$(readlink -f "$wd" 2>/dev/null)" = "$here" ] && { basename "$f"; return 0; }
  done
  return 1
}
DC=""
if docker compose version >/dev/null 2>&1; then DC="docker compose"; elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; fi
MODE=plain; UNIT=""
if [ -n "$DC" ] && [ -f docker-compose.yml ] && [ -n "$($DC ps -a -q hearth 2>/dev/null)" ]; then MODE=docker
elif UNIT="$(find_unit)" && [ -n "$UNIT" ]; then MODE=systemd
elif command -v pm2 >/dev/null 2>&1 && pm2 describe hearth >/dev/null 2>&1; then MODE=pm2
fi

# Reads one setting from .env. A missing .env or setting is normal (defaults apply), so never fail here.
envval() { { grep -E "^\s*$1\s*=" .env 2>/dev/null || true; } | tail -1 | sed -E "s/^\s*$1\s*=\s*//; s/^['\"]//; s/['\"]\s*$//; s/\r$//"; }
PORT="$(envval PORT)"; PORT="${PORT:-3000}"

plain_pid() {
  for p in $(pgrep -f "node server/index.js" 2>/dev/null); do
    [ "$(cat "/proc/$p/comm" 2>/dev/null)" = node ] || continue
    [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$(readlink -f "$DIR")" ] && echo "$p"
  done
}
stop_app() {
  case $MODE in
    docker) $DC stop hearth >/dev/null 2>&1 || true ;;
    systemd) systemctl stop "$UNIT" ;;
    pm2) pm2 stop hearth >/dev/null ;;
    plain) for p in $(plain_pid); do kill "$p" 2>/dev/null || true; done; wait_stopped ;;
  esac
}
start_app() {
  case $MODE in
    docker) $DC up -d --no-deps --no-build hearth >/dev/null 2>&1 ;;
    systemd) systemctl start "$UNIT" ;;
    pm2) pm2 restart hearth >/dev/null ;;
    plain) nohup node server/index.js >> hearth.log 2>&1 < /dev/null & disown ;;
  esac
} 9>&- # Hearth (or a pm2 daemon) must not inherit the update lock, or the next update would think one is still running.
show_logs() {
  case $MODE in
    docker) $DC logs --tail 40 hearth 2>&1 ;;
    systemd) journalctl -u "$UNIT" -n 40 --no-pager ;;
    pm2) pm2 logs hearth --lines 40 --nostream ;;
    plain) tail -n 40 hearth.log 2>/dev/null ;;
  esac
}
# Is Hearth answering? Tries plain HTTP and HTTPS (self-signed) on its port.
# In Docker it also asks from inside the container, in case the port isn't published (only Caddy is).
INSIDE_CHECK="const u=['http','https'].map(s=>s+'://127.0.0.1:'+(process.env.PORT||3000)+'/api/config');Promise.any(u.map(x=>fetch(x).then(r=>r.ok?r.json():Promise.reject()))).then(j=>process.exit(j.name?0:1),()=>process.exit(1))"
healthy() { # $1 = attempts, 2 s apart (default 45 = 90 s)
  for _ in $(seq 1 "${1:-45}"); do
    for scheme in http https; do
      local out; out="$(curl -fsk --max-time 3 "$scheme://127.0.0.1:$PORT/api/config" 2>/dev/null || true)"
      [[ "$out" == *'"name"'* ]] && return 0
    done
    if [ "$MODE" = docker ] && $DC exec -T -e NODE_TLS_REJECT_UNAUTHORIZED=0 hearth node -e "$INSIDE_CHECK" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
install_deps() { [ "$MODE" = docker ] && return 0; npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1; }
# Non-Docker: build the new version's libraries in a staging folder, so the live site is untouched
# until everything is ready. If the library list didn't change, reuse the current ones (no download).
prepare_stage() { # $1 = staging dir, $2 = log file
  if cmp -s "$DIR/package-lock.json" "$1/package-lock.json" && [ -d "$DIR/node_modules" ]; then
    cp -a "$DIR/node_modules" "$1/node_modules"; return 0
  fi
  (cd "$1" && npm ci --omit=dev --no-audit --no-fund) > "$2" 2>&1
}
RSYNC_EXCLUDES=(--exclude /data --exclude '/data-backup*' --exclude /.env --exclude /node_modules --exclude /hearth.log
  --exclude /docker-compose.yml --exclude /deploy/Caddyfile --exclude /desktop/hearth.config.json --exclude /.git)
version() { { grep -m1 '"version"' "${1:-.}/package.json" 2>/dev/null || echo '"version": "unknown"'; } | sed -E 's/.*"version": *"([^"]+)".*/\1/'; }
backups() { ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | sed 's:/$::' || true; }
free_mb() { df -Pm "$1" 2>/dev/null | awk 'NR==2 { print $4 }' || echo 0; }

# Behind Caddy (Docker setup): make Caddy hold requests for a moment while Hearth restarts, instead of
# showing "502 Bad Gateway". Only touches that one setting, validates with Caddy, and undoes it on any doubt.
patch_caddy() {
  [ "$MODE" = docker ] || return 0
  local cf="$DIR/deploy/Caddyfile"
  [ -f "$cf" ] || return 0
  [ -n "$($DC --profile domain ps -q caddy 2>/dev/null)" ] || return 0
  grep -q 'lb_try_duration' "$cf" && return 0
  if ! grep -qE '^[[:space:]]*reverse_proxy[[:space:]]+hearth:3000[[:space:]]*$' "$cf"; then
    warn "Tip: add 'lb_try_duration 30s' to your Caddy reverse_proxy block so visitors never see an error during updates."
    return 0
  fi
  step "Teaching Caddy to hold requests during restarts (no error pages for visitors)…"
  cp "$cf" "$BK/Caddyfile.before"
  local tmp; tmp="$(mktemp)"
  awk '{
    if ($0 ~ /^[[:space:]]*reverse_proxy[[:space:]]+hearth:3000[[:space:]]*$/) {
      match($0, /^[[:space:]]*/); ind = substr($0, 1, RLENGTH)
      print ind "reverse_proxy hearth:3000 {"
      print ind "\t# Hold requests while Hearth restarts (updates) instead of showing an error page."
      print ind "\tlb_try_duration 30s"
      print ind "\tlb_try_interval 250ms"
      print ind "}"
    } else print
  }' "$cf" > "$tmp"
  cat "$tmp" > "$cf"; rm -f "$tmp"   # rewrite in place, so the file Docker has mounted sees the change
  if $DC --profile domain exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
     && $DC --profile domain exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    ok "Caddy will now hold requests during restarts."
  else
    cat "$BK/Caddyfile.before" > "$cf"
    warn "Couldn't update Caddy's settings automatically, so they were left exactly as they were."
  fi
}
wait_stopped() { # plain mode: wait (up to 6 s) for the old process to exit
  for _ in $(seq 1 30); do [ -z "$(plain_pid)" ] && return 0; sleep 0.2; done
}

restore() { # $1 = backup folder
  local bk="$1"
  step "Putting the previous version back…"
  stop_app
  tar -xzf "$bk/code.tgz" -C "$DIR"
  if [ -d "$bk/data" ]; then rm -f data/hearth.db-wal data/hearth.db-shm; rsync -a "$bk/data/" data/; fi
  if [ "$MODE" = docker ]; then
    if [ -f "$bk/image" ] && docker image inspect "$(cut -d' ' -f1 "$bk/image")" >/dev/null 2>&1; then
      docker tag "$(cut -d' ' -f1 "$bk/image")" "$(cut -d' ' -f2 "$bk/image")"
    else
      $DC build hearth >/dev/null 2>&1 || true
    fi
  elif [ -d "$bk/node_modules" ]; then
    rm -rf node_modules && cp -a "$bk/node_modules" node_modules
  else
    install_deps || true
  fi
  start_app
  if healthy; then ok "The previous version is running again."
  else warn "The previous version didn't answer either. Its last log lines:"; show_logs || true; fi
}

# ---------------------------------------------------------------- other modes
if [ "$ACTION" = list ]; then
  [ -n "$(backups)" ] || { echo "No backups yet in $BACKUP_ROOT."; exit 0; }
  echo "Backups (newest first) — roll back to one with: hearth-update --rollback <name>"
  while IFS= read -r b; do
    printf '  %s   version %s   %s\n' "$(basename "$b")" "$(cat "$b/version" 2>/dev/null || echo '?')" "$(du -sh "$b" 2>/dev/null | cut -f1)"
  done < <(backups)
  exit 0
fi

if [ "$ACTION" = logs ]; then
  printf 'Last log lines of Hearth (%s, %s):\n\n' "$DIR" "$MODE"
  case $MODE in
    docker) $DC logs --tail 80 hearth 2>&1 || true ;;
    systemd) journalctl -u "$UNIT" -n 80 --no-pager || true ;;
    pm2) pm2 logs hearth --lines 80 --nostream || true ;;
    plain) tail -n 80 hearth.log 2>/dev/null || echo "(no hearth.log)" ;;
  esac
  exit 0
fi

if [ "$ACTION" = status ]; then
  printf '\n%sHearth status%s\n' "$c_b" "$c_0"
  printf '  folder:    %s\n  runs as:   %s%s\n  version:   %s\n  port:      %s\n' "$DIR" "$MODE" "${UNIT:+ ($UNIT)}" "$(version)" "$PORT"
  if healthy 3; then ok "Hearth is answering."; else warn "Hearth is not answering right now. See: hearth-update --logs"; fi
  printf '  free disk: %s MB\n' "$(free_mb "$DIR")"
  printf '  database:  %s\n' "$(du -sh data/hearth.db 2>/dev/null | cut -f1 || echo '?')"
  printf '  backups:   %s in %s (newest: %s)\n' "$(backups | wc -l)" "$BACKUP_ROOT" "$(basename "$(backups | head -1)" 2>/dev/null || echo none)"
  [ -f .env ] || warn "There's no .env file, so every setting is at its default (that's fine for a quick start)."
  # How many connections Hearth may hold open (each open app window is one).
  HPID=""
  case $MODE in
    docker) HPID="$(docker inspect -f '{{.State.Pid}}' "$($DC ps -q hearth 2>/dev/null | head -1)" 2>/dev/null || true)" ;;
    systemd) HPID="$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || true)" ;;
    *) HPID="$(plain_pid | head -1)" ;;
  esac
  if [ -n "$HPID" ] && [ "$HPID" != 0 ] && [ -r "/proc/$HPID/limits" ]; then
    NOFILE="$(awk '/Max open files/ { print $4 }' "/proc/$HPID/limits")"
    printf '  max connections: about %s\n' "$NOFILE"
    if [ "${NOFILE:-0}" -lt 10000 ] 2>/dev/null; then
      warn "Hearth can only keep about $NOFILE connections open, so roughly that many people can be online. Raise it: systemd: add LimitNOFILE=65535 under [Service] in $UNIT; Docker: add 'ulimits: nofile: 65535' to the hearth service in docker-compose.yml. Then restart."
    fi
  fi
  if [ "$MODE" = docker ] && [ -f deploy/Caddyfile ] && grep -q 'chat.example.com' deploy/Caddyfile && [ -n "$($DC --profile domain ps -q caddy 2>/dev/null || true)" ]; then
    warn "deploy/Caddyfile still says chat.example.com — replace it with your domain."
  fi
  exit 0
fi

if [ "$ACTION" = rollback ]; then
  if [ -n "$ARG" ]; then
    LAST="$BACKUP_ROOT/$(basename "$ARG")"
    [ -f "$LAST/code.tgz" ] || die "No backup called $(basename "$ARG"). See: hearth-update --list"
  else
    LAST="$(backups | head -1)"
  fi
  [ -n "$LAST" ] || die "No backups found in $BACKUP_ROOT."
  if [ "$YES" != 1 ]; then
    printf '%sRoll back to the version saved on %s (version %s)?%s Messages sent since then will be lost. [y/N] ' "$c_b" "$(basename "$LAST")" "$(cat "$LAST/version" 2>/dev/null || echo '?')" "$c_0"
    yes=""; read -r yes </dev/tty || true
    [[ "$yes" =~ ^[Yy] ]] || die "Cancelled."
  fi
  restore "$LAST"
  exit 0
fi

# ---------------------------------------------------------------- update
ZIP="${ARG:-/tmp/hearth-update.zip}"
[ -f "$ZIP" ] || die "Update file not found: $ZIP"
unzip -Z1 "$ZIP" 'hearth/server/index.js' >/dev/null 2>&1 || die "$ZIP doesn't look like a Hearth update."

printf '\n%sHearth update%s\n  folder:  %s\n  runs as: %s%s\n  current: %s\n\n' "$c_b" "$c_0" "$DIR" "$MODE" "${UNIT:+ ($UNIT)}" "$(version)"

# Enough room for the unpacked update, the backup and (Docker) the new image?
NEED_MB=$(( $(du -sm --exclude=uploads --exclude=backups --exclude=downloads data 2>/dev/null | cut -f1 || echo 0) + 400 ))
[ "$MODE" = docker ] && NEED_MB=$((NEED_MB + 600))
HAVE_MB="$(free_mb "$DIR")"
if [ "${HAVE_MB:-0}" -lt "$NEED_MB" ]; then
  die "Not enough free disk space: ${HAVE_MB} MB free, about ${NEED_MB} MB needed. Free some space (e.g. 'docker system prune' or delete old folders in $BACKUP_ROOT) and try again."
fi

WORK="$(mktemp -d)"
step "Unpacking the update…"
unzip -q "$ZIP" -d "$WORK"
NEW="$WORK/hearth"
ok "New version: $(version "$NEW")"
# Keep the updater itself up to date too (when run as "hearth-update <zip>", the old copy is what's running).
if [ -f "$NEW/scripts/hearth-update.sh" ]; then cp "$NEW/scripts/hearth-update.sh" /usr/local/bin/hearth-update && chmod +x /usr/local/bin/hearth-update; fi

BK="$BACKUP_ROOT/$(date +%F-%H%M%S)"
mkdir -p "$BK"
version > "$BK/version"
step "Saving a copy of the current program files…"
tar -czf "$BK/code.tgz" -C "$DIR" --exclude=./data --exclude='./data-backup*' --exclude=./node_modules --exclude=./hearth.log .
if [ "$MODE" = docker ]; then
  CID="$($DC ps -a -q hearth 2>/dev/null | head -1 || true)"
  if [ -n "$CID" ]; then echo "$(docker inspect -f '{{.Image}}' "$CID") $(docker inspect -f '{{.Config.Image}}' "$CID")" > "$BK/image"; fi
fi

if [ "$MODE" = docker ]; then
  # Docker builds from this folder; the running container keeps using its own copy of the old code.
  step "Copying in the new files (your data, .env and server settings are left alone)…"
  rsync -a "${RSYNC_EXCLUDES[@]}" "$NEW/" "$DIR/"
  step "Building the new version (your site is still running)…"
  if ! $DC build hearth > "$BK/build.log" 2>&1; then
    tail -n 25 "$BK/build.log"
    tar -xzf "$BK/code.tgz" -C "$DIR"
    die "The new version didn't build, so nothing was changed — your site is still on the old version. Full log: $BK/build.log"
  fi
else
  step "Preparing the new version in a staging folder (your site is still running)…"
  if ! prepare_stage "$NEW" "$BK/npm.log"; then
    tail -n 20 "$BK/npm.log"
    die "Couldn't install the new version's libraries, so nothing was changed. Full log: $BK/npm.log (Is Node.js 20 or newer installed? node -v)"
  fi
fi
ok "Ready."

patch_caddy || true

step "Switching over (people with Hearth open see \"Updating…\" for a moment)…"
T0=$(date +%s%N)
stop_app
mkdir -p "$BK/data"
rsync -a --exclude uploads --exclude backups --exclude downloads data/ "$BK/data/"
if [ "$MODE" != docker ]; then
  rsync -a "${RSYNC_EXCLUDES[@]}" "$NEW/" "$DIR/"
  if [ -d node_modules ]; then mv node_modules "$BK/node_modules"; fi
  mv "$NEW/node_modules" node_modules
fi
start_app

step "Checking the new version answers…"
if healthy; then
  T1=$(date +%s%N)
  ok "Hearth $(version) is running. Offline for $(awk "BEGIN { printf \"%.1f\", ($T1 - $T0) / 1e9 }") seconds."
  ok "Your database was backed up to $BK"
  if [ "$MODE" = docker ]; then docker image prune -f >/dev/null 2>&1 || true; fi
  backups | tail -n +$((KEEP + 1)) | xargs -r -d '\n' rm -rf
  printf 'Log saved to %s\n' "$LOG"
  printf '\nPeople with Hearth open saw "Updating…" briefly and were switched to the new version automatically.\nTo undo this update later: %shearth-update --rollback%s   (status: hearth-update --status)\n' "$c_b" "$c_0"
else
  warn "The new version didn't come up. Its last log lines:"
  show_logs || true
  restore "$BK"
  die "The update was rolled back automatically. Send the log lines above to whoever gave you the update."
fi
