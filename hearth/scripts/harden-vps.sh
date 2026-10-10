#!/usr/bin/env bash
# Hearth server hardening — locks down a Debian/Ubuntu VPS that runs Hearth. Safe to run again any time.
#
#   sudo bash scripts/harden-vps.sh               explains each step and asks before changing anything
#   sudo bash scripts/harden-vps.sh --dry-run     only shows what it would do (changes nothing)
#   sudo bash scripts/harden-vps.sh --yes         no questions (for scripts)
#
#   --auto-reboot      let security updates restart the server at 04:00 when they need to (off by default)
#   --skip-firewall  --skip-ssh  --skip-fail2ban  --skip-updates  --skip-service    leave that part alone
#
# What it does:
#   1. Firewall (ufw): only SSH, web (80/443) and — if installed — the call relay are reachable.
#   2. SSH: key-only logins (only if you already have an SSH key set up, so you can't be locked out).
#   3. fail2ban: blocks addresses that keep guessing SSH passwords.
#   4. Automatic security updates.
#   5. Runs Hearth as its own unprivileged user in a sandbox (systemd installs).
#   6. Checks for common risky settings and lists what's reachable from the internet.
set -Eeuo pipefail

c_y=$'\033[1;33m'; c_g=$'\033[1;32m'; c_r=$'\033[1;31m'; c_b=$'\033[1m'; c_d=$'\033[2m'; c_0=$'\033[0m'
if [ ! -t 1 ]; then c_y=""; c_g=""; c_r=""; c_b=""; c_d=""; c_0=""; fi
title() { printf '\n%s== %s ==%s\n' "$c_b" "$*" "$c_0"; }
say()   { printf '%s\n' "$*" | fold -s -w 100 | sed 's/^/  /'; }
step()  { printf '%s▸%s %s\n' "$c_y" "$c_0" "$*"; }
ok()    { printf '%s✓%s %s\n' "$c_g" "$c_0" "$*"; }
warn()  { printf '%s!%s %s\n' "$c_y" "$c_0" "$*"; WARNINGS+=("$*"); }
loud()  { printf '\n%s!!! %s%s\n\n' "$c_r" "$*" "$c_0"; WARNINGS+=("$*"); }
die()   { printf '%s✗ %s%s\n' "$c_r" "$*" "$c_0" >&2; exit 1; }

YES=0; DRY=0; AUTO_REBOOT=0
DO_FW=1; DO_SSH=1; DO_F2B=1; DO_UPD=1; DO_SVC=1
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --dry-run|-n) DRY=1 ;;
    --auto-reboot) AUTO_REBOOT=1 ;;
    --skip-firewall) DO_FW=0 ;;
    --skip-ssh) DO_SSH=0 ;;
    --skip-fail2ban) DO_F2B=0 ;;
    --skip-updates) DO_UPD=0 ;;
    --skip-service) DO_SVC=0 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $a (try --help)" ;;
  esac
done

CHANGED=(); SKIPPED=(); WARNINGS=(); NEXT=()
BACKUP_ROOT=/root/hearth-backups
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ "$(id -u)" != 0 ]; then
  [ "$DRY" = 1 ] || die "Run this as root: sudo bash $0"
  printf '%s(Dry run without root: some checks may see less than they would with sudo.)%s\n' "$c_d" "$c_0"
fi

# If a command fails unexpectedly, say which one, so a stop is never silent.
# shellcheck disable=SC2329  # called by the ERR trap
on_err() { [ "$BASH_SUBSHELL" -eq 0 ] || return 0; printf '%s✗ Step failed (line %s): %s%s\n' "$c_r" "$1" "$2" "$c_0" >&2; }
trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR

# ---------------------------------------------------------------- helpers
# run CMD...: does it, or in a dry run just prints it. runq: the same, without the command's own output.
run() {
  if [ "$DRY" = 1 ]; then printf '    %swould run:%s' "$c_d" "$c_0"; printf ' %q' "$@"; printf '\n'; return 0; fi
  "$@"
}
runq() { if [ "$DRY" = 1 ]; then run "$@"; else "$@" >/dev/null 2>&1; fi; }
# put_file PATH MODE < content: writes a file (only if it changed). Returns 1 if it was already like that.
put_file() {
  local path="$1" mode="$2" tmp; tmp="$(mktemp)"; cat > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 1; fi
  if [ "$DRY" = 1 ]; then
    printf '    %swould write %s:%s\n' "$c_d" "$path" "$c_0"; sed 's/^/      | /' "$tmp"; rm -f "$tmp"; return 0
  fi
  mkdir -p "$(dirname "$path")"
  install -m "$mode" "$tmp" "$path"; rm -f "$tmp"
}
# ask "question": yes with --yes or --dry-run; otherwise asks (default yes).
ask() {
  [ "$YES" = 1 ] || [ "$DRY" = 1 ] && return 0
  local r=""; printf '%s? %s [Y/n]%s ' "$c_b" "$1" "$c_0"; read -r r </dev/tty || r=n
  [[ ! "$r" =~ ^[Nn] ]]
}
if [ "$YES" = 0 ] && [ "$DRY" = 0 ] && ! { : </dev/tty; } 2>/dev/null; then die "No terminal to ask questions in. Add --yes (or --dry-run to just look)."; fi
has() { command -v "$1" >/dev/null 2>&1; }
pkg_ok() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"; }
APT_UPDATED=0
apt_install() {
  local missing=() p
  for p in "$@"; do pkg_ok "$p" || missing+=("$p"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  step "Installing ${missing[*]}…"
  if [ "$DRY" = 1 ]; then run apt-get install -y "${missing[@]}"; return 0; fi
  if [ "$APT_UPDATED" = 0 ]; then apt-get update -qq >/dev/null 2>&1 || true; APT_UPDATED=1; fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null 2>&1 || { warn "Couldn't install ${missing[*]} (apt-get failed)."; return 1; }
}
is_local_addr() { [[ "$1" =~ ^(127\.|\[?::1\]?$|::1$|\[::ffff:127\.) ]] || [[ "$1" == *%lo ]]; }

# ---------------------------------------------------------------- what is this machine?
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
if ! [[ " ${ID:-} ${ID_LIKE:-} " =~ \ (debian|ubuntu)\  ]]; then
  [ "$DRY" = 1 ] || die "This script is for Debian or Ubuntu servers (this is: ${PRETTY_NAME:-unknown})."
  warn "This isn't Debian/Ubuntu (${PRETTY_NAME:-unknown}); the dry run continues, but a real run would stop here."
fi

# Find Hearth: the folder this script is in, the update tool's saved location, or a search.
find_hearth() {
  local here d; here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
  for d in "${HEARTH_DIR:-}" "$here" "$(cat /etc/hearth-update.conf 2>/dev/null || true)"; do
    [ -n "$d" ] && [ -f "$d/server/index.js" ] && { (cd "$d" && pwd); return 0; }
  done
  d="$(find / \( -path /proc -o -path /sys -o -path /var/lib/docker -o -path /root/hearth-backups \) -prune -o -path '*/data/hearth.db' -print 2>/dev/null | head -1)"
  [ -n "$d" ] && [ -f "$(dirname "$(dirname "$d")")/server/index.js" ] && { dirname "$(dirname "$d")"; return 0; }
  return 1
}
DIR="$(find_hearth || true)"
envval() { # one setting from Hearth's .env (empty if not set)
  [ -n "$DIR" ] || return 0
  { grep -E "^\s*$1\s*=" "$DIR/.env" 2>/dev/null || true; } | tail -1 | sed -E "s/^\s*$1\s*=\s*//; s/^['\"]//; s/['\"]\s*$//; s/\r$//"
}
PORT="$(envval PORT)"; PORT="${PORT:-3000}"

# How does Hearth run? (same detection as the update tool)
DC=""
if docker compose version >/dev/null 2>&1; then DC="docker compose"; elif has docker-compose; then DC="docker-compose"; fi
find_unit() {
  local f wd here; here="$(readlink -f "$DIR")"
  for f in /etc/systemd/system/*.service /lib/systemd/system/hearth*.service; do
    [ -f "$f" ] || continue
    wd="$(sed -n 's/^[[:space:]]*WorkingDirectory=[[:space:]]*//p' "$f" | head -1 | sed -E 's/^"//; s/"[[:space:]]*$//; s/[[:space:]]+$//')" || true
    [ -n "$wd" ] && [ "$(readlink -f "$wd" 2>/dev/null)" = "$here" ] && { basename "$f"; return 0; }
  done
  [ -f /etc/systemd/system/hearth.service ] && { echo hearth.service; return 0; }
  return 1
}
MODE=none; UNIT=""; CID=""
if [ -n "$DIR" ]; then
  if [ -n "$DC" ] && [ -f "$DIR/docker-compose.yml" ] && CID="$(cd "$DIR" && $DC ps -a -q hearth 2>/dev/null | head -1)" && [ -n "$CID" ]; then MODE=docker
  elif UNIT="$(find_unit)" && [ -n "$UNIT" ]; then MODE=systemd
  elif has pm2 && pm2 describe hearth >/dev/null 2>&1; then MODE=pm2
  elif pgrep -f "node server/index.js" >/dev/null 2>&1; then MODE=plain
  fi
elif [ -f /etc/systemd/system/hearth.service ]; then
  UNIT=hearth.service; MODE=systemd
  DIR="$(sed -n 's/^[[:space:]]*WorkingDirectory=[[:space:]]*//p' /etc/systemd/system/hearth.service | head -1 | sed -E 's/^"//; s/"[[:space:]]*$//')"
fi

# Is a web server (Caddy, nginx, …) in front of Hearth, answering on 443?
PROXY=""
if ss -H -tlnp 2>/dev/null | awk '$4 ~ /:443$/' | grep -qE 'caddy|nginx|apache|httpd|haproxy|traefik|docker-proxy'; then
  PROXY="$(ss -H -tlnp 2>/dev/null | awk '$4 ~ /:443$/' | grep -oE 'caddy|nginx|apache2?|httpd|haproxy|traefik|docker-proxy' | head -1)"
  [ "$PROXY" = docker-proxy ] && PROXY="Caddy (Docker)"
elif ss -H -tln 2>/dev/null | awk '{print $4}' | grep -qE '(^|[:.\]])443$'; then
  PROXY="a web server"
fi

# SSH ports: from sshd's real configuration, what sshd listens on, and the connection you're using right now.
ssh_ports() {
  {
    if has sshd; then sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }'; fi
    grep -hsE '^\s*Port\s+[0-9]+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk '{ print $2 }'
    ss -H -tlnp 2>/dev/null | grep -E '"sshd' | awk '{ n = split($4, a, ":"); print a[n] }'
    [ -n "${SSH_CONNECTION:-}" ] && echo "${SSH_CONNECTION##* }"
    # The ports of SSH sessions open right now (sudo hides SSH_CONNECTION).
    ss -H -tnp state established 2>/dev/null | grep -E '"sshd' | awk '{ n = split($3, a, ":"); print a[n] }'
  } | grep -E '^[0-9]+$' | sort -un
}
mapfile -t SSH_PORTS < <(ssh_ports)
[ ${#SSH_PORTS[@]} -gt 0 ] || SSH_PORTS=(22)

title "Hearth server hardening"
[ "$DRY" = 1 ] && say "DRY RUN: nothing will be changed; you'll see what would happen."
say "System:       ${PRETTY_NAME:-unknown}"
say "Hearth:       ${DIR:-not found on this server} ($( case $MODE in docker) echo "Docker";; systemd) echo "systemd service $UNIT";; pm2) echo "pm2";; plain) echo "plain node";; *) echo "not running";; esac ))"
say "Hearth port:  $PORT"
say "In front:     ${PROXY:-nothing on port 443 (Hearth is reached directly)}"
say "SSH port(s):  ${SSH_PORTS[*]}"

# ================================================================ 1. firewall
fw_turn_rules() { # prints "port/proto" rules for the call relay (coturn), if it's installed
  pkg_ok coturn || has turnserver || return 0
  local conf=/etc/turnserver.conf lp tlp minp maxp
  lp="$(sed -nE 's/^\s*listening-port\s*=\s*([0-9]+).*/\1/p' "$conf" 2>/dev/null | tail -1)"; lp="${lp:-3478}"
  tlp="$(sed -nE 's/^\s*tls-listening-port\s*=\s*([0-9]+).*/\1/p' "$conf" 2>/dev/null | tail -1)"
  minp="$(sed -nE 's/^\s*min-port\s*=\s*([0-9]+).*/\1/p' "$conf" 2>/dev/null | tail -1)"; minp="${minp:-49152}"
  maxp="$(sed -nE 's/^\s*max-port\s*=\s*([0-9]+).*/\1/p' "$conf" 2>/dev/null | tail -1)"; maxp="${maxp:-65535}"
  echo "$lp/udp"; echo "$lp/tcp"
  # TURN over TLS only if it's configured (a certificate or an explicit TLS port).
  if [ -n "$tlp" ] || grep -qE '^\s*cert\s*=' "$conf" 2>/dev/null; then echo "${tlp:-5349}/tcp"; echo "${tlp:-5349}/udp"; fi
  echo "$minp:$maxp/udp"
}

if [ "$DO_FW" = 1 ]; then
  title "1. Firewall"
  say "A firewall makes sure only the services you mean to offer can be reached from the internet. It will allow: SSH (so you can log in), web traffic on ports 80 and 443 (Caddy), and the call relay's ports if it's installed. Everything else coming in is blocked. Outgoing connections are not limited."
  mapfile -t TURN_RULES < <(fw_turn_rules)
  HEARTH_DIRECT=0
  if [ -z "$PROXY" ] && [ "$MODE" != none ] && [ "$MODE" != docker ]; then HEARTH_DIRECT=1; fi
  if [ "$HEARTH_DIRECT" = 1 ]; then
    say "Nothing answers on port 443, so people seem to reach Hearth directly on port $PORT. To avoid taking your site offline, $PORT/tcp stays open. Once Caddy is in front (see README: 'On a VPS with a domain'), run this again and it will be closed."
  fi
  if ask "Set up the firewall now?"; then
    if ! has ufw; then apt_install ufw || true; fi
    if has ufw || [ "$DRY" = 1 ]; then
      # SSH first, always — the firewall is never switched on without it.
      for p in "${SSH_PORTS[@]}"; do runq ufw allow "$p/tcp" comment 'SSH'; done
      runq ufw default deny incoming
      runq ufw default allow outgoing
      runq ufw allow 80/tcp comment 'web (Caddy)'
      runq ufw allow 443/tcp comment 'web (Caddy)'
      runq ufw allow 443/udp comment 'web HTTP/3 (Caddy)'
      for r in "${TURN_RULES[@]}"; do runq ufw allow "$r" comment 'Hearth call relay (coturn)'; done
      [ "$HEARTH_DIRECT" = 1 ] && runq ufw allow "$PORT/tcp" comment 'Hearth (direct, no proxy)'
      [ ${#TURN_RULES[@]} -gt 0 ] && ok "Call relay ports allowed: ${TURN_RULES[*]}"
      ssh_rule_ok=1
      if [ "$DRY" = 0 ]; then
        for p in "${SSH_PORTS[@]}"; do ufw show added 2>/dev/null | grep -qE "ufw allow $p/tcp( |$)" || ssh_rule_ok=0; done
      fi
      if [ "$ssh_rule_ok" = 0 ]; then
        loud "The SSH rule didn't show up in the firewall, so it was NOT switched on (that could lock you out). Check: ufw show added"
        SKIPPED+=("Firewall: rules added but not switched on (SSH rule missing)")
      else
        if [ "$DRY" = 0 ] && ufw status 2>/dev/null | grep -q "Status: active"; then
          runq ufw reload; ok "Firewall was already on; rules updated."
        else
          runq ufw --force enable; ok "Firewall switched on."
        fi
        CHANGED+=("Firewall (ufw): incoming blocked except SSH ${SSH_PORTS[*]}, 80/tcp, 443/tcp+udp${TURN_RULES:+, relay ${TURN_RULES[*]}}$( [ "$HEARTH_DIRECT" = 1 ] && echo ", $PORT/tcp (Hearth direct)")")
        if ufw status 2>/dev/null | grep -qE "^$PORT(/tcp)?\s+ALLOW" && [ "$HEARTH_DIRECT" = 0 ]; then
          warn "An older firewall rule still allows port $PORT. With Caddy in front it isn't needed: sudo ufw delete allow $PORT/tcp  (and/or: sudo ufw delete allow $PORT)"
        fi
      fi
      if [ "$MODE" = docker ]; then
        say "Note: ports published by Docker go around ufw. That's why the new docker-compose.yml lets you keep port $PORT private with HEARTH_BIND=127.0.0.1 (see below)."
      fi
      NEXT+=("If your VPS provider also has a firewall in its control panel, open the same ports there: SSH ${SSH_PORTS[*]}, 80/tcp, 443/tcp+udp${TURN_RULES:+, ${TURN_RULES[*]}}.")
    fi
  else SKIPPED+=("Firewall (you chose to skip it)"); fi
fi

# ================================================================ 2. SSH
# Lists the authorized_keys files sshd uses for a user, and says whether any has a real key in it.
user_has_key() {
  local user="$1" home pat f
  home="$(getent passwd "$user" | cut -d: -f6)"; [ -n "$home" ] || return 1
  local pats="%h/.ssh/authorized_keys %h/.ssh/authorized_keys2"
  if has sshd; then
    local cfg; cfg="$(sshd -T -C "user=$user,host=localhost,addr=127.0.0.1" 2>/dev/null | awk '$1 == "authorizedkeysfile" { $1 = ""; print }')"
    [ -n "$cfg" ] && pats="$cfg"
  fi
  for pat in $pats; do
    f="${pat//%h/$home}"; f="${f//%u/$user}"; f="${f//%%/%}"
    [[ "$f" = /* ]] || f="$home/$f"
    [ -s "$f" ] && grep -qE '^[^#]*(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-(ssh|ecdsa))' "$f" && return 0
  done
  return 1
}
if [ "$DO_SSH" = 1 ]; then
  title "2. SSH logins"
  say "Passwords can be guessed by bots that try thousands of them a day; SSH keys can't. This turns off password logins (keys only) and lets root log in with a key only. It does this only if you already log in with a key, so it can't lock you out."
  SSH_DROPIN=/etc/ssh/sshd_config.d/10-hearth-hardening.conf
  ME="${SUDO_USER:-root}"
  ADMINS=(root)
  for g in sudo admin wheel; do
    while IFS= read -r u; do [ -n "$u" ] && ADMINS+=("$u"); done < <(getent group "$g" 2>/dev/null | cut -d: -f4 | tr ',' '\n')
  done
  WITH_KEYS=()
  for u in $(printf '%s\n' "${ADMINS[@]}" | sort -u); do user_has_key "$u" && WITH_KEYS+=("$u"); done
  ssh_skip=""
  if ! has sshd && [ "$DRY" = 0 ]; then ssh_skip="the SSH server (sshd) isn't installed here"
  elif [ ${#WITH_KEYS[@]} -eq 0 ]; then ssh_skip="neither root nor any sudo user has an SSH key set up, so turning off passwords would lock you out"
  elif [ "$ME" != root ] && ! user_has_key "$ME"; then ssh_skip="you're logged in as '$ME', who has no SSH key yet (only: ${WITH_KEYS[*]}), so turning off passwords would lock '$ME' out"
  elif [ ! -d /etc/ssh/sshd_config.d ] || ! grep -qiE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config 2>/dev/null; then
    ssh_skip="this SSH version doesn't read /etc/ssh/sshd_config.d/, so the change can't be added safely as a separate file"
  fi
  if [ -n "$ssh_skip" ]; then
    loud "SSH NOT changed: $ssh_skip."
    say "To set up a key: on YOUR computer run  ssh-keygen -t ed25519  then  ssh-copy-id ${ME}@<this server>  — check that 'ssh ${ME}@<this server>' works without a password, then run this script again."
    SKIPPED+=("SSH hardening ($ssh_skip)")
    NEXT+=("Set up an SSH key, then run this script again to turn off password logins.")
  elif ask "Turn off SSH password logins (keys only)?"; then
    # Never loosen anything: if root login is already completely off, keep it off.
    root_now="$(sshd -T 2>/dev/null | awk '$1 == "permitrootlogin" { print $2 }')"
    root_val="prohibit-password"; [ "$root_now" = no ] && root_val=no
    prev=""; [ -f "$SSH_DROPIN" ] && prev="$(cat "$SSH_DROPIN")"
    if put_file "$SSH_DROPIN" 0644 <<CONF
# Written by Hearth's scripts/harden-vps.sh. Delete this file and reload ssh to undo.
# (Its name starts with 10- so it's read before other files here: for SSH, the first setting found wins.)
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin $root_val
CONF
    then
      # sshd's complaint is kept in a variable, not in a fixed file in /tmp that another account could plant.
      if [ "$DRY" = 1 ]; then run sshd -t; run systemctl reload ssh
      elif sshd_check="$(sshd -t 2>&1)"; then
        if systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null; then ok "SSH reloaded."
        else say "(SSH will use the new settings for the next login.)"; fi
        CHANGED+=("SSH: password and keyboard-interactive logins off, PermitRootLogin $root_val ($SSH_DROPIN)")
        loud "Keep this window open and check that you can still log in from a NEW terminal window (ssh ${ME}@<this server>). If not, in this window run: sudo rm $SSH_DROPIN && sudo systemctl reload ssh"
      else
        printf '%s\n' "$sshd_check" >&2
        if [ -n "$prev" ]; then printf '%s\n' "$prev" > "$SSH_DROPIN"; else rm -f "$SSH_DROPIN"; fi
        loud "SSH didn't accept the new settings, so they were removed again and nothing changed."
        SKIPPED+=("SSH hardening (sshd -t failed; rolled back)")
      fi
    else ok "SSH was already set up this way."; fi
    # Another file may still win (for SSH, the first value found counts). Check what's actually in effect.
    if [ "$DRY" = 0 ] && has sshd; then
      eff="$(sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" || $1 == "kbdinteractiveauthentication" { print $1 "=" $2 }' | tr '\n' ' ')"
      if [[ "$eff" == *"=yes"* ]]; then
        warn "SSH still allows passwords ($eff). Another setting wins over ours: grep -rniE 'PasswordAuthentication|KbdInteractive' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/"
      fi
    fi
  else SKIPPED+=("SSH hardening (you chose to skip it)"); fi
fi

# ================================================================ 3. fail2ban
if [ "$DO_F2B" = 1 ]; then
  title "3. fail2ban"
  say "fail2ban watches SSH logins and blocks an address for an hour after 5 failed attempts in 10 minutes, which stops password-guessing bots. (If you ever lock yourself out by mistake: sudo fail2ban-client set sshd unbanip <your IP>.)"
  if ask "Install and switch on fail2ban for SSH?"; then
    apt_install fail2ban python3-systemd || true
    ports_csv="$(IFS=,; echo "${SSH_PORTS[*]}")"
    if put_file /etc/fail2ban/jail.d/hearth-sshd.local 0644 <<CONF
# Written by Hearth's scripts/harden-vps.sh
[sshd]
enabled  = true
port     = $ports_csv
# Read SSH's log from the system journal (newer Debian has no /var/log/auth.log).
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
CONF
    then CHANGED+=("fail2ban: SSH jail on (5 tries / 10 min → 1 h ban)"); fi
    runq systemctl enable fail2ban || true
    run systemctl restart fail2ban || warn "fail2ban didn't start. Check: journalctl -u fail2ban -n 30"
    if [ "$DRY" = 0 ]; then
      sleep 2
      if fail2ban-client status sshd >/dev/null 2>&1; then ok "fail2ban is protecting SSH."; else warn "fail2ban's SSH jail isn't running. Check: sudo fail2ban-client status; journalctl -u fail2ban -n 30"; fi
    fi
  else SKIPPED+=("fail2ban (you chose to skip it)"); fi
fi

# ================================================================ 4. automatic security updates
if [ "$DO_UPD" = 1 ]; then
  title "4. Automatic security updates"
  say "Installs security fixes for the system every day by itself (only security updates, from Debian/Ubuntu)."
  if [ "$AUTO_REBOOT" = 1 ]; then say "Because of --auto-reboot, the server restarts at 04:00 when an update needs it (e.g. a new kernel). Hearth starts again by itself."
  else say "The server is never restarted automatically. When an update needs a restart, you'll find /var/run/reboot-required; restart when it suits you (add --auto-reboot to do that at 04:00 by itself)."; fi
  if ask "Switch on automatic security updates?"; then
    apt_install unattended-upgrades || true
    put_file /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'CONF' && CHANGED+=("Automatic security updates: on (daily)")
// Written by Hearth's scripts/harden-vps.sh
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
    if [ "$AUTO_REBOOT" = 1 ]; then reboot_cfg='Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";'
    else reboot_cfg='Unattended-Upgrade::Automatic-Reboot "false";'; fi
    put_file /etc/apt/apt.conf.d/52hearth-unattended-upgrades 0644 <<CONF && CHANGED+=("Automatic restart after updates: $( [ "$AUTO_REBOOT" = 1 ] && echo "on, at 04:00" || echo off)")
// Written by Hearth's scripts/harden-vps.sh (overrides 50unattended-upgrades; which updates are installed is set there).
$reboot_cfg
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
    runq systemctl enable --now unattended-upgrades || true
    ok "Security updates will install automatically."
    say "Not covered: Docker images and Node.js from other sources. Hearth's own updates come through hearth-update; rebuild Docker images now and then with: docker compose pull && docker compose up -d --build"
  else SKIPPED+=("Automatic security updates (you chose to skip it)"); fi
fi

# ================================================================ 5. Hearth as its own user
health_ok() { # $1 attempts, 2 s apart
  local host scheme out; host="$(envval HOST)"
  case "$host" in ""|0.0.0.0|::|"[::]") host=127.0.0.1 ;; *:*) host="[$host]" ;; esac
  for _ in $(seq 1 "${1:-30}"); do
    for scheme in http https; do
      out="$(curl -fsk --max-time 3 "$scheme://$host:$PORT/api/config" 2>/dev/null || true)"
      [[ "$out" == *'"version"'* || "$out" == *'"name"'* ]] && return 0
    done
    sleep 2
  done
  return 1
}
esc_unit() { printf '%s' "${1//%/%%}"; }            # "%" is special in unit files
q_unit() { printf '"%s"' "$(esc_unit "$1")"; }        # quoted, for lists that may contain spaces
abs_in() { case "$2" in /*) printf '%s' "$2" ;; *) printf '%s/%s' "$1" "${2#./}" ;; esac; }

harden_systemd() {
  local unit_file cur_user wd node exec_line data dl mail rw tmpl new reason="" envkeep
  unit_file="$(systemctl show -p FragmentPath --value "$UNIT" 2>/dev/null || true)"
  [ -n "$unit_file" ] || unit_file="/etc/systemd/system/$UNIT"
  [ -f "$unit_file" ] || { warn "Couldn't find the file for $UNIT."; return 0; }
  cur_user="$(sed -nE 's/^\s*User\s*=\s*//p' "$unit_file" | tail -1 | tr -d '"[:space:]')"
  if [ -n "$cur_user" ] && [ "$cur_user" != root ] && [ "$cur_user" != 0 ]; then
    ok "Hearth already runs as '$cur_user', not root."
    if ! grep -qE '^\s*ProtectSystem\s*=' "$unit_file"; then
      say "Tip: it isn't sandboxed yet. Compare $unit_file with deploy/hearth.service and copy the '# ---- Sandbox ----' lines into it (then: systemctl daemon-reload && systemctl restart $UNIT)."
      NEXT+=("Add the sandbox settings from deploy/hearth.service to $unit_file.")
    fi
    return 0
  fi
  say "Hearth's service ($UNIT) runs as root, so a bug in Hearth or one of its libraries would give an attacker the whole server. This creates a 'hearth' user that can only write Hearth's data folder, and runs Hearth in a sandbox (read-only system, no root powers). The program files stay owned by root, so Hearth can't change its own code. If Hearth doesn't come back up, the old setup is put back automatically."
  ask "Run Hearth as its own sandboxed user?" || { SKIPPED+=("Hearth service user (you chose to skip it)"); return 0; }

  wd="$(sed -n 's/^[[:space:]]*WorkingDirectory=[[:space:]]*//p' "$unit_file" | head -1 | sed -E 's/^"//; s/"[[:space:]]*$//; s/[[:space:]]+$//')"
  wd="${wd:-$DIR}"
  [ -f "$wd/server/index.js" ] || { warn "The service's folder ($wd) doesn't look like Hearth; left alone."; SKIPPED+=("Hearth service user (unknown folder)"); return 0; }
  DIR="$wd"
  exec_line="$(sed -nE 's/^\s*ExecStart\s*=\s*-?//p' "$unit_file" | head -1)"
  node="${exec_line%% *}"
  if [ "$(basename "$node")" != node ] || [ ! -x "$node" ]; then node="$(command -v node || true)"; fi
  node="$(readlink -f "$node" 2>/dev/null || echo "$node")"
  data="$(abs_in "$wd" "$(envval DATA_DIR)")"; [ -n "$(envval DATA_DIR)" ] || data="$wd/data"
  dl="$(envval DOWNLOADS_DIR)"; [ -n "$dl" ] && dl="$(abs_in "$wd" "$dl")"
  mail="$(envval MAIL_OUTBOX_DIR)"; [ -n "$mail" ] && mail="$(abs_in "$wd" "$mail")"

  # Things that would stop a non-root Hearth from working: say so instead of breaking the site.
  if [ -z "$node" ] || [ ! -x "$node" ]; then reason="Node.js wasn't found"
  elif [[ "$node" == /root/* || "$node" == /home/* ]]; then reason="Node.js is installed inside a home folder ($node, e.g. with nvm), which the hearth user can't (and shouldn't) see. Install Node system-wide (e.g. from nodesource.com or your distribution) and run this again"
  elif [[ "$wd" == /root/* ]]; then reason="Hearth lives in /root ($wd), which only root can open. Move it, e.g.: systemctl stop $UNIT && mv '$wd' /opt/hearth, set WorkingDirectory=/opt/hearth in $unit_file, then run this again"
  fi
  local port_n="${PORT//[^0-9]/}"; local low_port=0; [ -n "$port_n" ] && [ "$port_n" -lt 1024 ] && low_port=1
  for k in SSL_CERT SSL_KEY; do
    local v; v="$(envval "$k")"
    if [ -n "$v" ] && [[ "$(abs_in "$wd" "$v")" == /etc/letsencrypt/* ]]; then
      reason="${reason:-$k points into /etc/letsencrypt, which only root can read. Put Caddy in front instead (README: 'On a VPS with a domain'), or give the hearth group read access to that certificate, then run this again}"
    fi
  done
  if [ -n "$reason" ]; then loud "Hearth's service NOT changed: $reason."; SKIPPED+=("Hearth service user ($reason)"); return 0; fi

  step "Creating the 'hearth' system user (no password, no login shell)…"
  if ! id hearth >/dev/null 2>&1; then
    run useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin hearth
  else ok "User 'hearth' already exists."; fi
  if [ "$DRY" = 0 ] && ! runuser -u hearth -- test -r "$wd/server/index.js" -a -x "$wd/node_modules" -a -x "$node"; then
    loud "Hearth's service NOT changed: the hearth user can't read $wd (a parent folder is private). Move Hearth to /opt/hearth (or make its folders readable), then run this again."
    SKIPPED+=("Hearth service user (folder not readable for the hearth user)"); return 0
  fi

  # Build the new unit from deploy/hearth.service, with this server's paths.
  tmpl="$wd/deploy/hearth.service"
  [ -f "$tmpl" ] || tmpl="$(dirname "${BASH_SOURCE[0]}")/../deploy/hearth.service"
  [ -f "$tmpl" ] || { warn "deploy/hearth.service not found; left alone."; return 0; }
  rw="$(q_unit "$data")"
  [ -n "$dl" ] && [[ "$dl" != "$data"/* ]] && rw="$rw $(q_unit "$dl")"
  [ -n "$mail" ] && [[ "$mail" != "$data"/* ]] && rw="$rw $(q_unit "$mail")"
  envkeep="$(sed -nE '/^\s*\[Service\]/,/^\s*\[/{/^\s*(Environment|EnvironmentFile)\s*=/p}' "$unit_file" | grep -v 'NODE_ENV=production' || true)"
  new="$(awk -v wd="$(esc_unit "$wd")" -v ex="$(esc_unit "$node") server/index.js" -v rw="$rw" -v env="$envkeep" \
             -v home="$( [[ "$wd" == /home/* ]] && echo read-only || echo yes)" -v low="$low_port" '
    /^# The easy way|^# By hand|^#   sudo |^#   Copy this file|^#   and the node path|^#   sudo systemctl daemon-reload/ { next }
    /^# systemd unit to run Hearth/ { print "# Hearth chat server — installed by scripts/harden-vps.sh from deploy/hearth.service."; next }
    /^WorkingDirectory=/ { print "WorkingDirectory=" wd; next }
    /^ExecStart=/ { print "ExecStart=" ex; next }
    /^ReadWritePaths=/ { print "ReadWritePaths=" rw; next }
    /^ProtectHome=/ { print "ProtectHome=" home; next }
    /^Environment=NODE_ENV=production/ { print; if (env != "") print env; next }
    /^CapabilityBoundingSet=/ && low == 1 { print "CapabilityBoundingSet=CAP_NET_BIND_SERVICE"; next }
    /^AmbientCapabilities=/ && low == 1 { print "AmbientCapabilities=CAP_NET_BIND_SERVICE"; next }
    { print }' "$tmpl")"

  local target="/etc/systemd/system/$UNIT" saved="$BACKUP_ROOT/$UNIT.before-harden-$STAMP"
  local env_file="$wd/.env" env_mode="" env_group=""
  if [ "$DRY" = 1 ]; then
    run install -d -o hearth -g hearth -m 0700 "$data"
    if [ -n "$dl" ]; then run chown -R hearth:hearth "$dl"; fi
    if [ -f "$env_file" ]; then run chgrp hearth "$env_file"; run chmod 640 "$env_file"; fi
    printf '%s\n' "$new" | put_file "$target" 0644 || true
    run systemctl daemon-reload; run systemctl stop "$UNIT"
    run chown -R hearth:hearth "$data"; run systemctl start "$UNIT"
    say "…then it checks that Hearth answers on port $PORT, and puts the old service back if it doesn't."
    return 0
  fi

  mkdir -p "$BACKUP_ROOT"; cp -a "$unit_file" "$saved"
  step "Installing the sandboxed service…"
  printf '%s\n' "$new" > "$target"; chmod 0644 "$target"
  systemctl daemon-reload
  local eff_user; eff_user="$(systemctl show -p User --value "$UNIT" 2>/dev/null || true)"
  if [ "$eff_user" = hearth ]; then
    # Stop first, so the old (root) process can't create new root-owned files after the hand-over.
    step "Restarting Hearth as the hearth user (a few seconds offline)…"
    systemctl stop "$UNIT" || true
    install -d -o hearth -g hearth -m 0700 "$data"
    chown -R hearth:hearth "$data"
    if [ -n "$dl" ]; then mkdir -p "$dl"; chown -R hearth:hearth "$dl"; fi
    if [ -n "$mail" ]; then mkdir -p "$mail"; chown -R hearth:hearth "$mail"; fi
    if [ -f "$env_file" ]; then
      env_mode="$(stat -c %a "$env_file")"; env_group="$(stat -c %g "$env_file")"
      chgrp hearth "$env_file"; chmod 640 "$env_file"   # Hearth can read its settings; other users can't
    fi
    systemctl start "$UNIT" || true
    step "Checking that Hearth answers…"
    if health_ok 30; then
      ok "Hearth now runs as the 'hearth' user in a sandbox. Old service saved as $saved"
      CHANGED+=("Hearth runs as user 'hearth' with the sandboxed $UNIT (data: $data)")
      NEXT+=("Hearth's command-line tool now runs as that user: cd '$wd' && sudo -u hearth node server/cli.js …")
      say "How locked down it is now: systemd-analyze security $UNIT"
      return 0
    fi
    warn "Hearth didn't answer as the new user. Its last log lines:"
    journalctl -u "$UNIT" -n 25 --no-pager 2>/dev/null || true
  else
    warn "Something else sets the service's user (now: '${eff_user:-root}'); check: systemctl cat $UNIT"
  fi
  step "Putting the previous service back…"
  if [ "$unit_file" = "$target" ]; then cp -a "$saved" "$target"; else rm -f "$target"; fi
  if [ -n "$env_mode" ]; then chgrp "$env_group" "$env_file"; chmod "$env_mode" "$env_file"; fi
  systemctl daemon-reload; systemctl restart "$UNIT" || true
  if health_ok 20; then ok "Hearth is running again as before (the data folder now belongs to 'hearth'; root can still use it)."
  else loud "Hearth isn't answering. Check: journalctl -u $UNIT -n 50"; fi
  SKIPPED+=("Hearth service user (didn't come up; rolled back to the old service)")
}

harden_docker() {
  local uid="" bind
  uid="$(docker exec "$CID" sh -c 'awk "/^Uid:/ { print \$2 }" /proc/1/status' 2>/dev/null || true)"
  if [ "$uid" = 0 ]; then
    say "Hearth's container runs as root."
  elif [ -n "$uid" ]; then ok "Hearth's container already runs as an unprivileged user (uid $uid)."; fi
  if ! grep -qE '^\s*user:\s*"?1000' "$DIR/docker-compose.yml" 2>/dev/null; then
    say "Your docker-compose.yml is from before the security update (the update tool never replaces it, so your own changes are kept). The new one in this download runs Hearth as an unprivileged user on a read-only filesystem without any root powers, keeps port $PORT private behind Caddy, and fixes the data folder's owner by itself. To switch:"
    say "  cd '$DIR' && cp docker-compose.yml docker-compose.yml.old"
    say "  copy docker-compose.yml from the new Hearth download over it (re-add any changes you made)"
    say "  docker compose up -d --build        (with a domain: docker compose --profile domain up -d --build)"
    NEXT+=("Docker: switch to the new docker-compose.yml (see step 5 above).")
  else ok "docker-compose.yml already has the hardened settings."; fi
  bind="$(docker port "$CID" 3000/tcp 2>/dev/null | head -1 || true)"
  if [ -n "$PROXY" ] && [[ "$bind" == 0.0.0.0:* || "$bind" == "[::]:"* || "$bind" == :::* ]]; then
    warn "Hearth's port is published on all addresses ($bind). Docker goes around the firewall, so it's reachable from the internet, not just through Caddy. Put HEARTH_BIND=127.0.0.1 in $DIR/.env, then: docker compose --profile domain up -d"
  fi
}

if [ "$DO_SVC" = 1 ]; then
  title "5. Run Hearth without root"
  case $MODE in
    systemd) harden_systemd ;;
    docker) harden_docker ;;
    pm2|plain)
      say "Hearth is started with $( [ "$MODE" = plain ] && echo "a plain node command" || echo pm2 ) here, so this script leaves it alone. Safer: run it as a systemd service with deploy/hearth.service (its own user, sandboxed, restarts by itself) — copy it to /etc/systemd/system/, follow the steps at its top, stop the $MODE copy, then run this script again."
      NEXT+=("Move Hearth from $MODE to the systemd service in deploy/hearth.service.")
      ;;
    *) say "Hearth isn't running on this server (or wasn't found), so there's nothing to change here." ;;
  esac
fi

# ================================================================ 6. checks
title "6. Checks"
if [ -S /var/run/docker.sock ]; then
  perms="$(stat -c %a /var/run/docker.sock)"
  if (( 8#$perms & 8#006 )); then warn "The Docker socket (/var/run/docker.sock) is open to every user (mode $perms) — that's root for anyone. Fix: sudo chmod 660 /var/run/docker.sock"
  else ok "Docker socket is only open to root and the docker group."; fi
  dg="$(getent group docker | cut -d: -f4)"
  [ -n "$dg" ] && say "Members of the 'docker' group can control Docker, which is the same as root: $dg"
  if has docker; then
    while IFS= read -r line; do
      [ -n "$line" ] && warn "Container ${line%% *} has the Docker socket mounted (it can take over the server)."
    done < <(docker ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null | grep 'docker.sock' || true)
  fi
fi
if has sshd; then
  prl="$(sshd -T 2>/dev/null | awk '$1 == "permitrootlogin" { print $2 }')"
  case "$prl" in
    yes) warn "SSH lets root log in with a password (PermitRootLogin yes). Step 2 fixes this once you have a key." ;;
    "") [ "$(id -u)" = 0 ] && warn "Couldn't read SSH's settings (sshd -T)." ;;
    *) ok "Root login over SSH: $prl." ;;
  esac
  pa="$(sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" { print $2 }')"
  [ "$pa" = yes ] && warn "SSH still accepts passwords."
fi
if [ -n "$DIR" ] && [ -f "$DIR/.env" ] && (( 8#$(stat -c %a "$DIR/.env") & 8#004 )); then
  warn "$DIR/.env (it holds secrets) is readable by every user on this server. Fix: sudo chmod o-rwx '$DIR/.env'"
fi

# What can be reached from outside?
UFW_ON=0; [ "$DRY" = 0 ] && has ufw && ufw status 2>/dev/null | grep -q "Status: active" && UFW_ON=1
expected_port() { # $1 port, $2 tcp|udp
  local p="$1" r
  for r in "${SSH_PORTS[@]}"; do [ "$2" = tcp ] && [ "$p" = "$r" ] && return 0; done
  case "$p/$2" in 80/tcp|443/tcp|443/udp|68/udp|546/udp) return 0 ;; esac   # web, DHCP client
  if pkg_ok coturn; then
    local rr lo hi
    while IFS= read -r rr; do
      if [[ "$rr" == *:* ]]; then lo="${rr%%:*}"; hi="${rr#*:}"; hi="${hi%/*}"; [ "$p" -ge "$lo" ] && [ "$p" -le "$hi" ] && return 0
      elif [ "$rr" = "$p/$2" ]; then return 0; fi
    done < <(fw_turn_rules)
  fi
  [ -z "$PROXY" ] && [ "$p" = "$PORT" ] && [ "$2" = tcp ] && return 0
  return 1
}
if has ss; then
  step "Programs listening for connections (ss -tlnup):"
  ss -tulnp 2>/dev/null | sed 's/^/    /' || true
  declare -A seen=()
  while read -r proto _ _ _ local_addr _ rest; do
    addr="${local_addr%:*}"; port="${local_addr##*:}"
    is_local_addr "$addr" && continue
    [[ "$addr" == 127.0.0.53%* || "$addr" == 127.0.0.54 ]] && continue
    key="$port/$proto"; [ -n "${seen[$key]:-}" ] && continue; seen[$key]=1
    prog="$(grep -oE '"[^"]+"' <<<"$rest" | head -1 | tr -d '"')"
    if [ "$port" = "$PORT" ] && [ "$proto" = tcp ] && [ -n "$PROXY" ]; then
      if [ "$MODE" = docker ] || [ "$prog" = docker-proxy ]; then
        warn "Hearth's port $PORT listens on all addresses ($addr) although $PROXY is in front, and Docker goes around the firewall. Set HEARTH_BIND=127.0.0.1 in .env and run: docker compose --profile domain up -d"
      else
        warn "Hearth's port $PORT listens on all addresses ($addr) although $PROXY is in front.$( [ "$UFW_ON" = 1 ] && echo " The firewall blocks it, but better:") put HOST=127.0.0.1 in $DIR/.env and restart Hearth."
      fi
      continue
    fi
    expected_port "$port" "$proto" && continue
    note=""; [ "$UFW_ON" = 1 ] && [ "$prog" != docker-proxy ] && note=" (the firewall blocks it unless you allowed it)"
    [ "$prog" = docker-proxy ] && note=" (published by Docker, which goes around the firewall)"
    warn "Unexpected open port: $port/$proto on $addr${prog:+ by $prog}$note. If it doesn't need to be reachable from the internet, make it listen on 127.0.0.1 or turn it off."
  done < <(ss -H -tuln -p 2>/dev/null | awk '{ print $1, $2, $3, $4, $5, $6, $7 }')
else
  warn "'ss' isn't installed, so open ports weren't checked."
fi

# ================================================================ summary
title "Summary"
if [ "$DRY" = 1 ]; then say "Dry run — nothing was changed. This is what a real run would do:"; fi
if [ ${#CHANGED[@]} -gt 0 ]; then printf '%sChanged:%s\n' "$c_g" "$c_0"; printf '  ✓ %s\n' "${CHANGED[@]}"; else say "Nothing needed changing."; fi
[ ${#SKIPPED[@]} -gt 0 ] && { printf '%sLeft alone:%s\n' "$c_y" "$c_0"; printf '  - %s\n' "${SKIPPED[@]}"; }
[ ${#WARNINGS[@]} -gt 0 ] && { printf '%sWorth a look:%s\n' "$c_y" "$c_0"; printf '  ! %s\n' "${WARNINGS[@]}"; }
NEXT+=("Run this again any time (e.g. after installing the call relay): sudo bash scripts/harden-vps.sh")
printf '%sNext:%s\n' "$c_b" "$c_0"; printf '  → %s\n' "${NEXT[@]}"
[ "$DRY" = 0 ] && [ -d "$BACKUP_ROOT" ] && say "Copies of changed service files are in $BACKUP_ROOT."
exit 0
