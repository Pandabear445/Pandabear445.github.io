#!/usr/bin/env bash
# Makes a server update: the zip that tools/Update-Hearth.bat, tools/update-hearth.sh and hearth-update install,
# plus its checksum file, from the last commit (so nothing private or unfinished gets in).
#
#   bash scripts/make-update-zip.sh [output folder]      (default: hearth/dist, which git ignores)
#     -> hearth-update-<version>.zip and hearth-update-<version>.zip.sha256
#
# Hand out both files. The update tools refuse a zip that doesn't match the .sha256 next to it, and print the
# SHA-256 they're installing: also post it somewhere people see apart from the download (release notes, your
# announcement), so a swapped zip and checksum pair can still be spotted.
set -euo pipefail
# A folder you name is taken from where you are; nothing lands in the source tree unless you ask for it.
if [ -n "${1:-}" ]; then mkdir -p "$1"; OUT="$(cd "$1" && pwd)"; fi
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
# The same format as sha256sum (Linux) / shasum -a 256 (macOS) / the update tools read: "<hash>  <file name>".
if command -v sha256sum >/dev/null 2>&1; then sum="$(sha256sum "$OUT/$name" | cut -d' ' -f1)"
else sum="$(shasum -a 256 "$OUT/$name" | cut -d' ' -f1)"; fi
printf '%s  %s\n' "$sum" "$name" > "$OUT/$name.sha256"
echo "Made $OUT/$name"
echo "     $OUT/$name.sha256"
echo "SHA-256: $sum"
