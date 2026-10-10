#!/usr/bin/env bash
# Sets up a TURN relay (coturn) so calls connect on every network: mobile data, CGNAT home internet,
# school/office Wi-Fi.
#
#   On the Hearth server:              bash scripts/setup-turn.sh
#   Extra relay in another region      bash setup-turn.sh --relay-only --secret <secret>
#   (a small, cheap VPS near people):  (get the secret with:  node server/cli.js get-turn-secret)
#
# Calls try every relay and use whichever works best, so people far from the main server get a
# nearby relay. Safe to run again: it keeps the existing secret, so other relays keep working.
#
# Bandwidth: each relayed connection is capped at TURN_MAX_MBIT megabits a second each way (default 6: enough
# for a camera plus a shared screen). TURN_CAPACITY_MBIT caps all calls together (default 0 = no cap; set it to
# what your VPS plan includes), e.g.  TURN_CAPACITY_MBIT=200 bash scripts/setup-turn.sh
set -Eeuo pipefail
c_y=$'\033[1;33m'; c_g=$'\033[1;32m'; c_r=$'\033[1;31m'; c_0=$'\033[0m'
step() { printf '%s▸%s %s\n' "$c_y" "$c_0" "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_g" "$c_0" "$*"; }
die()  { printf '%s✗ %s%s\n' "$c_r" "$*" "$c_0" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Run this as root (or with sudo)."
RELAY_ONLY=no; SECRET=""; NEW_SECRET=no; MANAGED=no
while [ $# -gt 0 ]; do
  case "$1" in
    --relay-only) RELAY_ONLY=yes ;;
    --secret) SECRET="${2:-}"; shift ;;
    --new-secret) NEW_SECRET=yes ;;
    --managed) MANAGED=yes ;; # installed from Admin → Regions: that install links the relay by itself
    *) die "Unknown option: $1" ;;
  esac
  shift
done
MAX_MBIT="${TURN_MAX_MBIT:-6}"; CAPACITY_MBIT="${TURN_CAPACITY_MBIT:-0}"
[[ "$MAX_MBIT" =~ ^[0-9]+$ ]] && [[ "$CAPACITY_MBIT" =~ ^[0-9]+$ ]] || die "TURN_MAX_MBIT and TURN_CAPACITY_MBIT are whole numbers (megabits a second)."
[ "$RELAY_ONLY" = yes ] && [ -z "$SECRET" ] && die "An extra relay needs the main server's secret: --secret <secret> (on the Hearth server: node server/cli.js get-turn-secret)"

# Find Hearth on this machine (not needed for --relay-only).
find_hearth() {
  local d="${HEARTH_DIR:-$(cat /etc/hearth-update.conf 2>/dev/null || true)}"
  if [ -z "$d" ] || [ ! -f "$d/server/index.js" ]; then
    d="$(find / \( -path /proc -o -path /sys -o -path /var/lib/docker -o -path /root/hearth-backups \) -prune -o -path '*/data/hearth.db' -print 2>/dev/null | head -1 | xargs -r dirname | xargs -r dirname)"
  fi
  echo "$d"
}
hearth_cli() { # run server/cli.js inside Hearth (Docker or plain), as the user that owns Hearth's data (e.g. "hearth")
  ( cd "$DIR" && if docker compose ps -q hearth 2>/dev/null | grep -q .; then docker compose exec -T hearth node server/cli.js "$@"
    else
      owner="$(stat -c %U data 2>/dev/null || echo root)"
      if [ "$owner" != root ] && [ "$owner" != UNKNOWN ] && command -v runuser >/dev/null 2>&1; then runuser -u "$owner" -- "$(command -v node)" server/cli.js "$@"
      else node server/cli.js "$@"; fi
    fi )
}
DIR=""
if [ "$RELAY_ONLY" = no ]; then
  DIR="$(find_hearth)"
  # Keep the secret Hearth already uses, so relays in other regions keep working.
  if [ -z "$SECRET" ] && [ "$NEW_SECRET" = no ] && [ -n "$DIR" ] && [ -f "$DIR/server/cli.js" ]; then SECRET="$(hearth_cli get-turn-secret 2>/dev/null | tail -1 || true)"; fi
fi

step "Installing coturn (the standard TURN relay)…"
{ apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn curl openssl; } >/dev/null 2>&1 || die "Couldn't install coturn."

PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org || curl -fsS --max-time 8 https://ifconfig.me || true)"
[ -n "$PUBLIC_IP" ] || die "Couldn't detect this server's public IP address."
PRIVATE_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}' | head -1)"
EXTERNAL="$PUBLIC_IP"
[ -n "$PRIVATE_IP" ] && [ "$PRIVATE_IP" != "$PUBLIC_IP" ] && EXTERNAL="$PUBLIC_IP/$PRIVATE_IP"
[ -n "$SECRET" ] || SECRET="$(openssl rand -hex 32)"

step "Writing /etc/turnserver.conf…"
[ -f /etc/turnserver.conf ] && cp /etc/turnserver.conf "/etc/turnserver.conf.bak-$(date +%s)"
cat > /etc/turnserver.conf <<CONF
# TURN relay for Hearth calls (written by scripts/setup-turn.sh)
listening-port=3478
external-ip=$EXTERNAL
min-port=49160
max-port=49400
fingerprint
use-auth-secret
static-auth-secret=$SECRET
realm=hearth
# Limits. Quotas count relayed connections (at most 400 at once, 16 per relay login; a login is per person and
# changes every 6 hours). max-bps caps each connection's bandwidth, bps-capacity all of them together (bytes a
# second, each way; 0 = no cap).
total-quota=400
user-quota=16
max-bps=$((MAX_MBIT * 125000))
bps-capacity=$((CAPACITY_MBIT * 125000))
stale-nonce=600
no-cli
no-tlsv1
no-tlsv1_1
no-multicast-peers
no-loopback-peers
# Never relay into private or internal networks (blocks a well-known TURN abuse).
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
simple-log
CONF
chmod 640 /etc/turnserver.conf
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 1
systemctl is-active --quiet coturn || die "coturn didn't start. Check: journalctl -u coturn -n 30"
ok "Relay running on $PUBLIC_IP (port 3478, relay ports 49160–49400)."

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  step "Opening firewall ports…"
  ufw allow 3478/udp >/dev/null; ufw allow 3478/tcp >/dev/null; ufw allow 49160:49400/udp >/dev/null
  ok "Firewall updated."
fi

URLS="turn:$PUBLIC_IP:3478?transport=udp,turn:$PUBLIC_IP:3478?transport=tcp"
if [ "$RELAY_ONLY" = yes ] && [ "$MANAGED" = yes ]; then exit 0; fi
if [ "$RELAY_ONLY" = yes ]; then
  printf '\n%s✓ Extra relay ready.%s Now add it to Hearth. On the Hearth server run:\n\n  node server/cli.js add-turn "%s"\n\n(or Settings → Instance → Calls → add these to the relay addresses).\n' "$c_g" "$c_0" "$URLS"
  printf '\nIf this VPS provider has its own firewall (in their control panel), open UDP+TCP 3478 and UDP 49160-49400 there too.\n'
  exit 0
fi
step "Connecting Hearth to the relay…"
saved=no
if [ -n "$DIR" ] && [ -f "$DIR/server/cli.js" ]; then
  hearth_cli add-turn "$URLS" "$SECRET" && saved=yes
fi
if [ "$saved" = yes ]; then
  ok "Done. Calls now fall back to the relay automatically when a direct connection isn't possible."
  printf 'To add a relay in another region later, run this on a small VPS there:\n  bash setup-turn.sh --relay-only --secret %s\n' "$SECRET"
else
  printf '\nCouldn'"'"'t save it into Hearth automatically. In Hearth go to Settings \u2192 Instance \u2192 Calls and enter:\n  Relay addresses: %s\n  Shared secret:   %s\n' "$URLS" "$SECRET"
fi
printf '\nIf your VPS provider has its own firewall (in their control panel), open UDP+TCP 3478 and UDP 49160-49400 there too.\n'
