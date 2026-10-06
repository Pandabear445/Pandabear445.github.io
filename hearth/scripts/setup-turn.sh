#!/usr/bin/env bash
# One-time setup of a TURN relay (coturn) so calls connect on every network: mobile data, CGNAT home
# internet, school/office Wi-Fi. Run on the VPS as root:   bash scripts/setup-turn.sh
# Safe to run again (it re-applies the same settings with a fresh secret).
set -Eeuo pipefail
c_y=$'\033[1;33m'; c_g=$'\033[1;32m'; c_r=$'\033[1;31m'; c_0=$'\033[0m'
step() { printf '%s▸%s %s\n' "$c_y" "$c_0" "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_g" "$c_0" "$*"; }
die()  { printf '%s✗ %s%s\n' "$c_r" "$*" "$c_0" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Run this as root (or with sudo)."

step "Installing coturn (the standard TURN relay)…"
{ apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn curl openssl; } >/dev/null 2>&1 || die "Couldn't install coturn."

PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org || curl -fsS --max-time 8 https://ifconfig.me || true)"
[ -n "$PUBLIC_IP" ] || die "Couldn't detect this server's public IP address."
PRIVATE_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}' | head -1)"
EXTERNAL="$PUBLIC_IP"
[ -n "$PRIVATE_IP" ] && [ "$PRIVATE_IP" != "$PUBLIC_IP" ] && EXTERNAL="$PUBLIC_IP/$PRIVATE_IP"
SECRET="$(openssl rand -hex 32)"

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
# Limits so nobody can use this relay as a free bandwidth pipe.
total-quota=400
user-quota=16
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
step "Connecting Hearth to the relay…"
DIR="${HEARTH_DIR:-$(cat /etc/hearth-update.conf 2>/dev/null || true)}"
if [ -z "$DIR" ] || [ ! -f "$DIR/server/index.js" ]; then
  DIR="$(find / \( -path /proc -o -path /sys -o -path /var/lib/docker -o -path /root/hearth-backups \) -prune -o -path '*/data/hearth.db' -print 2>/dev/null | head -1 | xargs -r dirname | xargs -r dirname)"
fi
saved=no
if [ -n "$DIR" ] && [ -f "$DIR/server/cli.js" ]; then
  cd "$DIR"
  if docker compose ps -q hearth 2>/dev/null | grep -q .; then docker compose exec -T hearth node server/cli.js set-turn "$URLS" "$SECRET" && saved=yes
  elif command -v node >/dev/null 2>&1; then node server/cli.js set-turn "$URLS" "$SECRET" && saved=yes; fi
fi
if [ "$saved" = yes ]; then
  ok "Done. Calls now fall back to the relay automatically when a direct connection isn't possible."
else
  printf '\nCouldn'"'"'t save it into Hearth automatically. In Hearth go to Settings \u2192 Instance \u2192 Calls and enter:\n  Relay addresses: %s\n  Shared secret:   %s\n' "$URLS" "$SECRET"
fi
printf '\nIf your VPS provider has its own firewall (in their control panel), open UDP+TCP 3478 and UDP 49160-49400 there too.\n'
