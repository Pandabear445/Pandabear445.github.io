#!/usr/bin/env bash
# Hearth updater for Mac/Linux:  ./update-hearth.sh [update.zip]  |  --rollback  |  --status  |  --logs  |  --setup
# Uploads the update to your server and runs the safe updater there (backups + automatic rollback).
# With no zip given it offers the newest Hearth zip in Downloads, and only installs it once you say yes.
# --allow-unsigned installs an update the server would refuse for its signature (only one you checked yourself).
set -euo pipefail
ALLOW=""; ARGS=()
for a in "$@"; do if [ "$a" = --allow-unsigned ]; then ALLOW=" --allow-unsigned"; else ARGS+=("$a"); fi; done
set -- ${ARGS[@]+"${ARGS[@]}"}
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
# Its signature (update.zip.sig, published with each signed release) goes along with it: the server checks it
# against the key it pinned. Only a well-formed one, since it becomes part of the command run there.
SIG=""
if [ -f "$ZIP.sig" ]; then
  SIG="$(tr -d '\r' < "$ZIP.sig" | awk 'NF { print $1; exit }')"
  [[ "$SIG" =~ ^[A-Za-z0-9+/]{86}==$ ]] || { echo "$(basename "$ZIP").sig isn't a signature file. Nothing was uploaded."; exit 1; }
  echo "Signed: the server checks the signature before installing."
else
  echo "Not signed (no $(basename "$ZIP").sig next to it): a server that checks signatures will refuse it."
fi
[ -z "$ALLOW" ] || echo "WARNING: --allow-unsigned: the server installs this update even if its signature is missing or wrong."
# Upload under a random name into the server account's home folder (no other account can write there), never a
# fixed /tmp name that another account could create first and swap before it runs as root. The install login
# then moves it into a private mktemp folder and checks it against the SHA-256 above before anything is unpacked
# or run. Two logins in all (with a password, you type it twice).
# The signature is checked with the updater already installed on the server (a trusted copy) before anything
# from the zip runs, even the zip's own updater. It's looked at through sudo: it may be root's alone. A server whose
# updater predates signing skips that step, unless it pins a key: then nothing runs (93), or with --allow-unsigned
# the zip's own updater does, after a warning.
UP=".hearth-upload-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n').zip"
[[ "$UP" =~ ^\.hearth-upload-[0-9a-f]{16}\.zip$ ]] || { echo "Couldn't pick a name for the upload."; exit 1; }
echo "Uploading $(basename "$ZIP")…"
scp "${OPTS[@]}" -P "$PORT" "$ZIP" "$T:$UP" || { echo "The upload failed. Check the server address and your connection."; exit 1; }
code=0
# On the server. 90-93 mean the updater never started: 90 = the upload isn't the file checked above, 91 = no
# updater in the zip, 92 = no private folder, 93 = the installed updater refused it (signature or version; it
# says why), or the server pins a key its updater can't check. The updater's own exit codes in that range are
# passed on as 1.
SIGCMD=""; [ -z "$SIG" ] || SIGCMD="echo '$SIG' > update.zip.sig; "
# (No apostrophes or double quotes: Update-Hearth.ps1 sends the same text.)
NOCHECK="echo 'This server pins an update signing key (/etc/hearth-update.pub), but its installed updater (/usr/local/bin/hearth-update) cannot check signatures. Nothing was installed. Check the zip on your computer (docs/SIGNING.md), then run again with --allow-unsigned (Windows: -AllowUnsigned).'; exit 93"
[ -z "$ALLOW" ] || NOCHECK="echo 'WARNING: this server pins an update signing key, but its installed updater cannot check signatures. Going ahead because of --allow-unsigned.'"
ssh "${OPTS[@]}" -t -p "$PORT" "$T" "D=\$(mktemp -d) || exit 92; trap 'rm -rf \$D' EXIT; mv ~/$UP \$D/update.zip || exit 92; cd \$D || exit 92; command -v unzip >/dev/null 2>&1 || { ${SUDO}apt-get update -qq && ${SUDO}apt-get install -y -qq unzip; } >/dev/null 2>&1; echo '$SUM  update.zip' > update.zip.sha256; sha256sum -c --quiet update.zip.sha256 >/dev/null 2>&1 || exit 90; ${SIGCMD}V=/usr/local/bin/hearth-update; if ${SUDO}grep -qs hearth-server-update-v1 \$V; then ${SUDO}\$V --verify$ALLOW \$D/update.zip || exit 93; elif ${SUDO}test -e /etc/hearth-update.pub; then $NOCHECK; fi; unzip -p update.zip hearth/scripts/hearth-update.sh > hearth-update.sh || exit 91; ${SUDO}bash hearth-update.sh \$D/update.zip$ALLOW; c=\$?; case \$c in 9[0-3]) c=1 ;; esac; exit \$c" || code=$?
case "$code" in
  90) echo "The upload doesn't match the file on this computer (damaged on the way?). Nothing was installed; try again."; exit 90 ;;
  91) echo "$(basename "$ZIP") doesn't contain the updater (hearth/scripts/hearth-update.sh). Nothing was installed; use the newest Hearth update."; exit 91 ;;
  92) echo "Couldn't set the upload aside in a private folder on the server (is its disk full?). Nothing was installed."; exit 92 ;;
  93) echo "The updater on the server refused $(basename "$ZIP") (the lines above say why). Nothing was installed."; exit 93 ;;
esac
# Anything else came from the updater (or the connection): its log says what happened.
if [ "$code" -ne 0 ]; then
  LOGF="$(dirname "$0")/last-update-log.txt"
  ssh "${OPTS[@]}" -p "$PORT" "$T" "${SUDO}cat /root/hearth-backups/last-update.log 2>/dev/null || echo '(no log on the server - the updater never started)'" > "$LOGF" || true
  echo; echo "The update did not finish (exit code $code). Last lines of the server log (full log: $LOGF):"
  tail -n 25 "$LOGF" | sed 's/^/  /'
  exit "$code"
fi
