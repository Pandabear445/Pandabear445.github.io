#!/usr/bin/env bash
# Makes a server update: the zip that hearth-update installs (operators upload it with its checksum file and
# signature, then run sudo hearth-update <zip> on the server), from the last commit (so nothing private or
# unfinished gets in).
#
#   bash scripts/make-update-zip.sh [--unsigned] [--new-key FILE] [output folder]   (default: hearth/dist, ignored by git)
#     -> hearth-update-<version>.zip, hearth-update-<version>.zip.sha256 and hearth-update-<version>.zip.sig
#
# Hand out all three files. hearth-update refuses a zip that doesn't match the .sha256 next to it, and prints the
# SHA-256 it's installing: also post it somewhere people see apart from the download (release notes, your
# announcement), so a swapped zip and checksum pair can still be spotted.
#
# Signing (docs/SIGNING.md, "Signing server updates"): with an update signing key (made once with
# node scripts/update-key.js keygen; HEARTH_UPDATE_KEY_FILE or HEARTH_UPDATE_KEY choose another one) the zip
# gets a .sig. Servers that pinned the key (update-signing.pub in this folder) refuse zips without a valid one,
# so once the key is committed this refuses to make an unsigned zip unless you pass --unsigned.
# An update whose update-signing.pub isn't the key it's signed with moves every server to that key, so it's only
# made when --new-key names the private half of that key too: a commit alone (or a stolen repository login) can't
# hand the servers to someone else's key ("Changing the key" in docs/SIGNING.md).
set -euo pipefail
OUT=""; UNSIGNED=0; NEXT_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --unsigned) UNSIGNED=1 ;;
    --new-key) [ $# -ge 2 ] || { echo "--new-key needs the new private key's file." >&2; exit 1; }; NEXT_KEY="$2"; shift ;;
    --new-key=*) NEXT_KEY="${1#--new-key=}" ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) OUT="$1" ;;
  esac
  shift
done
# A folder or key file you name is taken from where you are; nothing lands in the source tree unless you ask for it.
if [ -n "$OUT" ]; then mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"; fi
if [ -n "$NEXT_KEY" ] && [[ "$NEXT_KEY" != /* ]]; then NEXT_KEY="$PWD/$NEXT_KEY"; fi
cd "$(dirname "$0")/.."
OUT="${OUT:-$(pwd)/dist}"
if ! { command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; }; then
  echo "This needs git and a git checkout: the zip is made from the last commit." >&2; exit 1
fi
[ -z "$(git status --porcelain -- .)" ] || echo "Note: changes that aren't committed are left out (the zip is made from the last commit)." >&2
version="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' package.json | head -1)"
[[ "$version" =~ ^[0-9A-Za-z.+-]+$ ]] || { echo "Couldn't read the version from package.json." >&2; exit 1; }
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
name="hearth-update-$version.zip"
# Everything under hearth/ in the last commit, inside a top-level "hearth/" folder (what the updaters expect).
# (Run from the top of the repository: from a subfolder, git archive would only look inside that subfolder.)
prefix="$(git rev-parse --show-prefix)"
(cd "$(git rev-parse --show-toplevel)" && git archive --format=zip --prefix=hearth/ -o "$OUT/$name" "HEAD:${prefix%/}")
for f in hearth/server/index.js hearth/scripts/hearth-update.sh; do
  unzip -Z1 "$OUT/$name" "$f" >/dev/null 2>&1 || { echo "The zip is missing $f." >&2; exit 1; }
done
# The same format as sha256sum (Linux) / shasum -a 256 (macOS) / hearth-update read: "<hash>  <file name>".
if command -v sha256sum >/dev/null 2>&1; then sum="$(sha256sum "$OUT/$name" | cut -d' ' -f1)"
else sum="$(shasum -a 256 "$OUT/$name" | cut -d' ' -f1)"; fi
printf '%s  %s\n' "$sum" "$name" > "$OUT/$name.sha256"
echo "Made $OUT/$name"
echo "     $OUT/$name.sha256"

# Sign it. (A .sig left over from an earlier run of the same version would belong to another zip.)
rm -f "$OUT/$name.sig"
nothing() { rm -f "$OUT/$name" "$OUT/$name.sha256" "$OUT/$name.sig"; echo "$1 Nothing was made." >&2; exit 1; }
carried="$(unzip -p "$OUT/$name" hearth/update-signing.pub 2>/dev/null | grep -v '^[[:space:]]*#' | tr -d ' \t\r\n' || true)"
if [ -n "$carried" ] && [[ ! "$carried" =~ ^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$ ]]; then
  nothing "update-signing.pub isn't an update signing key (make it with: node scripts/update-key.js keygen)."
fi
if [ "$UNSIGNED" = 1 ]; then
  echo "Not signed (--unsigned). Servers that pinned an update signing key refuse it unless installed with --allow-unsigned."
elif command -v node >/dev/null 2>&1 && node scripts/update-key.js has-key; then
  signer="$(node scripts/update-key.js public)" || nothing "Signing failed."
  if [ -n "$carried" ] && [ "$carried" != "$signer" ]; then
    if [ -z "$NEXT_KEY" ]; then
      echo "update-signing.pub in the last commit is $carried, but you sign with $signer." >&2
      echo "Servers would install this update and then trust only $carried." >&2
      echo "Changing the key on purpose? Name its private half: --new-key FILE (docs/SIGNING.md, \"Changing the key\")." >&2
      nothing "If you didn't change it, someone else did: see git log -p -- update-signing.pub."
    fi
    next="$(node scripts/update-key.js public --key "$NEXT_KEY")" || nothing "Couldn't read the new key $NEXT_KEY."
    [ "$next" = "$carried" ] || nothing "--new-key $NEXT_KEY is the key $next, not the one in update-signing.pub ($carried)."
  elif [ -n "$NEXT_KEY" ]; then
    nothing "--new-key is for an update that changes the key, and this one doesn't: update-signing.pub in the last commit is the key you sign with (did you commit the new one?)."
  fi
  node scripts/update-key.js sign "$OUT/$name" || nothing "Signing failed."
  if [ -z "$carried" ]; then
    echo "Note: this update doesn't carry update-signing.pub, so servers that haven't pinned a key yet won't start checking signatures. Commit the public key (docs/SIGNING.md)."
  elif [ "$carried" != "$signer" ]; then
    echo "KEY CHANGE: servers that install this update switch from $signer"
    echo "            to $carried (you hold its private key: $NEXT_KEY)."
    echo "            Sign the updates after it with the new key, and say so in this release's notes."
  fi
elif [ -n "$carried" ]; then
  echo "This repository pins an update signing key (update-signing.pub), so servers that installed it refuse an unsigned update." >&2
  echo "Sign it: set HEARTH_UPDATE_KEY_FILE to your private key (or keep it at ~/.config/hearth/update-signing.key; needs Node)," >&2
  nothing "or run again with --unsigned if you really mean to hand out an unsigned one."
else
  echo "Not signed: there's no update signing key yet (docs/SIGNING.md, \"Signing server updates\")."
fi
echo "SHA-256: $sum"
