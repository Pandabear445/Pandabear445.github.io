#!/usr/bin/env bash
# Hearth updater for Mac/Linux:  ./update-hearth.sh [update.zip]  |  --rollback  |  --status  |  --logs  |  --setup
# Uploads the update to your server and runs the safe updater there (backups + automatic rollback).
set -euo pipefail
CFG="$HOME/.hearth-update"
if [ ! -f "$CFG" ] || [ "${1:-}" = "--setup" ]; then
  read -rp "Your server's address (IP or domain): " HOST
  read -rp "User name on the server [root]: " USR; USR="${USR:-root}"
  read -rp "SSH port [22]: " PORT; PORT="${PORT:-22}"
  printf 'HOST=%q\nUSR=%q\nPORT=%q\n' "$HOST" "$USR" "$PORT" > "$CFG"
  [ "${1:-}" = "--setup" ] && exit 0
fi
# shellcheck disable=SC1090
. "$CFG"
T="$USR@$HOST"; OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15)
[ -f "$HOME/.ssh/id_ed25519" ] && OPTS+=(-i "$HOME/.ssh/id_ed25519")
SUDO=""; [ "$USR" = root ] || SUDO="sudo "
if ! ssh "${OPTS[@]}" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=8 "$T" true 2>/dev/null; then
  read -rp "Set up password-free login (type the server password once)? [Y/n] " a
  if [[ ! "$a" =~ ^[Nn] ]]; then
    [ -f "$HOME/.ssh/id_ed25519" ] || ssh-keygen -t ed25519 -q -N "" -C hearth-updater -f "$HOME/.ssh/id_ed25519"
    OPTS+=(-i "$HOME/.ssh/id_ed25519")
    # Add the key once, on its own line (even if the file didn't end with a newline), with the permissions sshd wants.
    ssh "${OPTS[@]}" -p "$PORT" "$T" 'umask 077; mkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; t=$(mktemp); tr -d "\r" > $t; [ -s $t ] || exit 3; sed -i -e "\$a\\" ~/.ssh/authorized_keys; grep -qxF -f $t ~/.ssh/authorized_keys || cat $t >> ~/.ssh/authorized_keys; rm -f $t; true' < "$HOME/.ssh/id_ed25519.pub"
    if ssh "${OPTS[@]}" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=8 "$T" true 2>/dev/null; then echo "Password-free login is set up."
    else echo "The key was sent, but the server still asks for a password (it may only allow passwords). Carrying on."; fi
  fi
fi
case "${1:-}" in
  --rollback) exec ssh "${OPTS[@]}" -t -p "$PORT" "$T" "${SUDO}hearth-update --rollback" ;;
  --status) exec ssh "${OPTS[@]}" -t -p "$PORT" "$T" "${SUDO}hearth-update --status" ;;
  --logs) exec ssh "${OPTS[@]}" -t -p "$PORT" "$T" "${SUDO}hearth-update --logs" ;;
esac
ZIP="${1:-$(ls -t "$HOME"/Downloads/*hearth*.zip "$HOME"/Downloads/*update*.zip 2>/dev/null | head -1 || true)}"
[ -n "$ZIP" ] && [ -f "$ZIP" ] || { echo "Usage: $0 path/to/update.zip"; exit 1; }
unzip -Z1 "$ZIP" hearth/server/index.js >/dev/null 2>&1 || { echo "$ZIP doesn't look like a Hearth update."; exit 1; }
echo "Uploading $(basename "$ZIP")…"
scp "${OPTS[@]}" -P "$PORT" "$ZIP" "$T:/tmp/hearth-update.zip"
code=0
ssh "${OPTS[@]}" -t -p "$PORT" "$T" "command -v unzip >/dev/null 2>&1 || { ${SUDO}apt-get update -qq && ${SUDO}apt-get install -y -qq unzip; } >/dev/null 2>&1; unzip -p /tmp/hearth-update.zip hearth/scripts/hearth-update.sh > /tmp/hearth-update.sh && ${SUDO}bash /tmp/hearth-update.sh /tmp/hearth-update.zip" || code=$?
if [ "$code" -ne 0 ]; then
  LOGF="$(dirname "$0")/last-update-log.txt"
  ssh "${OPTS[@]}" -p "$PORT" "$T" "${SUDO}cat /root/hearth-backups/last-update.log 2>/dev/null || echo '(no log on the server - the updater never started)'" > "$LOGF" || true
  echo; echo "The update did not finish (exit code $code). Last lines of the server log (full log: $LOGF):"
  tail -n 25 "$LOGF" | sed 's/^/  /'
  exit "$code"
fi
