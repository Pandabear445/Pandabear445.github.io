#!/usr/bin/env bash
# Hearth updater — installs an update zip on this server, safely.
#
#   hearth-update /tmp/hearth-update.zip     install an update
#   hearth-update --rollback                 go back to the version before the last update
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

# Everything this script prints is also saved, so a failed run can always be looked at afterwards.
mkdir -p "$BACKUP_ROOT"
LOG="$BACKUP_ROOT/last-update.log"
exec > >(tee "$LOG") 2>&1
printf 'Hearth updater started %s (log: %s)\n' "$(date)" "$LOG"
# shellcheck disable=SC2154
trap 'code=$?; [ $code -ne 0 ] && printf "%s✗ Stopped (exit code %s). Full log: %s%s\n" "$c_r" "$code" "$LOG" "$c_0"' EXIT

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
      local pick; read -rp "Which one? [1] " pick </dev/tty; pick="${pick:-1}"
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
DC=""
if docker compose version >/dev/null 2>&1; then DC="docker compose"; elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; fi
MODE=plain; UNIT=""
if [ -n "$DC" ] && [ -f docker-compose.yml ] && [ -n "$($DC ps -a -q hearth 2>/dev/null)" ]; then MODE=docker
elif UNIT="$(grep -lsE "^WorkingDirectory=\"?${DIR}\"?\s*$" /etc/systemd/system/*.service 2>/dev/null | head -1)" && [ -n "$UNIT" ]; then MODE=systemd; UNIT="$(basename "$UNIT")"
elif command -v pm2 >/dev/null 2>&1 && pm2 describe hearth >/dev/null 2>&1; then MODE=pm2
fi

envval() { grep -E "^\s*$1\s*=" .env 2>/dev/null | tail -1 | sed -E "s/^\s*$1\s*=\s*//; s/^['\"]//; s/['\"]\s*$//"; }
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
}
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
healthy() {
  for _ in $(seq 1 45); do
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
version() { grep -m1 '"version"' "${1:-.}/package.json" 2>/dev/null | sed -E 's/.*"version": *"([^"]+)".*/\1/'; }

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

# ---------------------------------------------------------------- rollback mode
if [ "${1:-}" = "--rollback" ]; then
  LAST="$(ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | head -1)"
  [ -n "$LAST" ] || die "No backups found in $BACKUP_ROOT."
  printf '%sRoll back to the version saved on %s?%s Messages sent since then will be lost. [y/N] ' "$c_b" "$(basename "$LAST")" "$c_0"
  read -r yes </dev/tty || true
  [[ "$yes" =~ ^[Yy] ]] || die "Cancelled."
  restore "${LAST%/}"
  exit 0
fi

# ---------------------------------------------------------------- update
ZIP="${1:-/tmp/hearth-update.zip}"
[ -f "$ZIP" ] || die "Update file not found: $ZIP"
unzip -Z1 "$ZIP" 'hearth/server/index.js' >/dev/null 2>&1 || die "$ZIP doesn't look like a Hearth update."

printf '\n%sHearth update%s\n  folder:  %s\n  runs as: %s%s\n  current: %s\n\n' "$c_b" "$c_0" "$DIR" "$MODE" "${UNIT:+ ($UNIT)}" "$(version)"

WORK="$(mktemp -d)"
# shellcheck disable=SC2154
trap 'code=$?; rm -rf "$WORK"; [ $code -ne 0 ] && printf "%s✗ Stopped (exit code %s). Full log: %s%s\n" "$c_r" "$code" "$LOG" "$c_0"' EXIT
step "Unpacking the update…"
unzip -q "$ZIP" -d "$WORK"
NEW="$WORK/hearth"
ok "New version: $(version "$NEW")"

BK="$BACKUP_ROOT/$(date +%F-%H%M%S)"
mkdir -p "$BK"
step "Saving a copy of the current program files…"
tar -czf "$BK/code.tgz" -C "$DIR" --exclude=./data --exclude='./data-backup*' --exclude=./node_modules --exclude=./hearth.log .
if [ "$MODE" = docker ]; then
  CID="$($DC ps -a -q hearth | head -1)"
  [ -n "$CID" ] && echo "$(docker inspect -f '{{.Image}}' "$CID") $(docker inspect -f '{{.Config.Image}}' "$CID")" > "$BK/image"
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
  [ -d node_modules ] && mv node_modules "$BK/node_modules"
  mv "$NEW/node_modules" node_modules
fi
start_app

step "Checking the new version answers…"
if healthy; then
  T1=$(date +%s%N)
  ok "Hearth $(version) is running. Offline for $(awk "BEGIN { printf \"%.1f\", ($T1 - $T0) / 1e9 }") seconds."
  ok "Your database was backed up to $BK"
  [ "$MODE" = docker ] && docker image prune -f >/dev/null 2>&1 || true
  ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
  printf 'Log saved to %s\n' "$LOG"
  printf '\nPeople with Hearth open saw "Updating…" briefly and were switched to the new version automatically.\nTo undo this update later: %shearth-update --rollback%s\n' "$c_b" "$c_0"
else
  warn "The new version didn't come up. Its last log lines:"
  show_logs || true
  restore "$BK"
  die "The update was rolled back automatically. Send the log lines above to whoever gave you the update."
fi
