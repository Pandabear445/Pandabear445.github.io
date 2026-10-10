#!/usr/bin/env bash
# Hearth updater for Mac/Linux:  ./update-hearth.sh [update.zip]  |  --rollback  |  --status  |  --logs  |  --setup
# Uploads the update to your server and runs the safe updater there (backups + automatic rollback).
# With no zip given it offers the newest Hearth zip in Downloads, and only installs it once you say yes.
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
ZIP="${1:-}"
if [ -z "$ZIP" ]; then
  # No file given: offer the newest Hearth zip in Downloads, but only once you've said yes to that exact file.
  # (Any download named like an update would otherwise be installed on the server as root.)
  ZIP="$(ls -t "$HOME"/Downloads/*hearth*.zip "$HOME"/Downloads/*update*.zip 2>/dev/null | head -1 || true)"
  [ -n "$ZIP" ] || { echo "Usage: $0 path/to/update.zip"; exit 1; }
  [ -t 0 ] || { echo "Found $ZIP, but won't install a file nobody picked. Run: $0 path/to/update.zip"; exit 1; }
  read -rp "Install $(basename "$ZIP") from $(dirname "$ZIP")? [Y/n] " a
  [[ ! "$a" =~ ^[Nn] ]] || { echo "Cancelled. Run: $0 path/to/update.zip"; exit 1; }
fi
[ -f "$ZIP" ] || { echo "Usage: $0 path/to/update.zip"; exit 1; }
unzip -Z1 "$ZIP" hearth/server/index.js >/dev/null 2>&1 || { echo "$ZIP doesn't look like a Hearth update."; exit 1; }
# Its SHA-256: compared with update.zip.sha256 when that file is next to it (published with each release), and
# handed to the server, which checks the upload against it before unpacking or running anything from it.
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print tolower($1) }'; }
SUM="$(sha256 "$ZIP")"
if [ -f "$ZIP.sha256" ]; then
  WANT="$(tr -d '\r' < "$ZIP.sha256" | awk 'NR == 1 { print tolower($1) }')"
  [ "$WANT" = "$SUM" ] || { echo "$ZIP doesn't match $(basename "$ZIP").sha256: it's damaged or not the published update. Nothing was uploaded."; exit 1; }
  echo "Checksum matches ($SUM)."
else
  echo "SHA-256 of this update: $SUM (no $(basename "$ZIP").sha256 next to it to compare with)."
fi
# Upload into a private folder on the server (mktemp: only this account can open it), not a fixed /tmp name
# that another account could create first and swap before it runs as root.
D="$(ssh "${OPTS[@]}" -p "$PORT" "$T" 'mktemp -d' | tr -d '\r')" || true
[[ "$D" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "Couldn't make a temporary folder on the server."; exit 1; }
echo "Uploading $(basename "$ZIP")…"
scp "${OPTS[@]}" -P "$PORT" "$ZIP" "$T:$D/update.zip"
code=0
# On the server: the folder goes away afterwards; 12 = the upload isn't the file checked above.
ssh "${OPTS[@]}" -t -p "$PORT" "$T" "trap 'rm -rf $D' EXIT; command -v unzip >/dev/null 2>&1 || { ${SUDO}apt-get update -qq && ${SUDO}apt-get install -y -qq unzip; } >/dev/null 2>&1; cd $D || exit 13; echo '$SUM  update.zip' > update.zip.sha256; sha256sum -c --quiet update.zip.sha256 >/dev/null 2>&1 || exit 12; unzip -p update.zip hearth/scripts/hearth-update.sh > hearth-update.sh || exit 11; ${SUDO}bash hearth-update.sh $D/update.zip" || code=$?
if [ "$code" -eq 12 ]; then echo "The upload doesn't match the file on this computer (damaged on the way?). Nothing was installed; try again."; exit 12; fi
if [ "$code" -ne 0 ]; then
  LOGF="$(dirname "$0")/last-update-log.txt"
  ssh "${OPTS[@]}" -p "$PORT" "$T" "${SUDO}cat /root/hearth-backups/last-update.log 2>/dev/null || echo '(no log on the server - the updater never started)'" > "$LOGF" || true
  echo; echo "The update did not finish (exit code $code). Last lines of the server log (full log: $LOGF):"
  tail -n 25 "$LOGF" | sed 's/^/  /'
  exit "$code"
fi
