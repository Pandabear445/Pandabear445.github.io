#!/usr/bin/env bash
# Upgrade drill: earlier Hearth releases, upgraded in place to this checkout.
#
#   bash scripts/upgrade-drill.sh [--write-fixture] [REF ...]       (from hearth/, after npm ci)
#
# For each REF (default: c55a9dc, the last release before the security overhaul, database version 16; and HEAD):
#   1. checks that commit out into a scratch folder and starts it on a new, empty data folder
#   2. fills it through its API (scripts/upgrade-drill.js seed): accounts with real keys, two-factor, an encrypted
#      server and DM, an attachment, settings with API keys in plain text, staff changes in the audit log
#   3. stops it, starts THIS checkout on the same data folder and checks everything (scripts/upgrade-drill.js
#      verify): sign-in, the same keys open the messages, files byte-equal, secrets sealed, audit log verifies
#   4. restarts it twice, checking again each time
#   5. on a second copy of the old data: kills the upgrade half-way (an env-gated test hook in server/db.js),
#      checks nothing changed, then starts normally and checks everything again
# --write-fixture also saves the old data as test/fixtures/upgrade-v<version>-<ref>.hfx.gz for the fast test
# (test/recovery-upgrade.test.js). Nothing outside the scratch folder is touched; it's removed at the end.
set -euo pipefail

cd "$(dirname "$0")/.."
HEARTH="$(pwd)"
REPO="$(git rev-parse --show-toplevel)"
WRITE_FIXTURE=0
REFS=()
for a in "$@"; do
  case "$a" in
    --write-fixture) WRITE_FIXTURE=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) REFS+=("$a") ;;
  esac
done
[ "${#REFS[@]}" -gt 0 ] || REFS=(c55a9dc HEAD)

NEW_SCHEMA="$(sed -n 's/^const SCHEMA_VERSION = \([0-9]*\);$/\1/p' server/db.js)"
WORK="$(mktemp -d -t hearth-upgrade.XXXXXX)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
fail() { say "FAIL: $*"; [ -f "$WORK/server.log" ] && { say '--- server log ---'; tail -n 40 "$WORK/server.log"; }; exit 1; }
free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
schema_of() { node -e "console.log(require('$HEARTH/server/backup').schemaOf(process.argv[1]))" "$1/hearth.db"; }

# start CODE_DIR DATA_DIR [ENV=VALUE ...]: starts Hearth in the background; sets PID and BASE.
start() {
  local code="$1" data="$2"; shift 2
  local port; port="$(free_port)"
  BASE="http://127.0.0.1:$port"
  (cd "$code" && exec env DATA_DIR="$data" PORT="$port" HOST=127.0.0.1 HTTPS=false NODE_ENV=test \
      MAIL_OUTBOX_DIR="$data/outbox" PUBLIC_URL=https://chat.example.test "$@" node server/index.js) >"$WORK/server.log" 2>&1 &
  PID=$!
  PIDS+=("$PID")
}
# Waits for the server started last to answer, or fails if it exits first.
wait_up() {
  for _ in $(seq 1 150); do
    node -e "fetch(process.argv[1]+'/api/config').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" "$BASE" && return 0
    kill -0 "$PID" 2>/dev/null || fail "the server exited while starting"
    sleep 0.1
  done
  fail "the server didn't start"
}
stop() { kill -TERM "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
drill() { node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/upgrade-drill.js "$@"; }
verify() { EXPECT_SCHEMA="$NEW_SCHEMA" drill verify "$BASE" "$1" "$2" "$3" || fail "checks failed ($4)"; }

say "Hearth upgrade drill: ${REFS[*]} -> this checkout (database version $NEW_SCHEMA)"
for ref in "${REFS[@]}"; do
  short="$(git -C "$REPO" rev-parse --short "$ref^{commit}")"
  code="$WORK/code-$short"
  data="$WORK/data-$short"
  state="$WORK/state-$short.json"
  say ""
  say "== from $ref ($short)"
  mkdir -p "$code"
  git -C "$REPO" archive "$short" hearth | tar -x -C "$code"
  code="$code/hearth"
  # Same lockfile: share this checkout's dependencies; otherwise install that version's own.
  if cmp -s "$code/package-lock.json" "$HEARTH/package-lock.json"; then ln -s "$HEARTH/node_modules" "$code/node_modules"
  else (cd "$code" && npm ci --omit=dev --no-audit --no-fund >/dev/null); fi

  mkdir -p "$data"
  start "$code" "$data"; wait_up
  say "   old version $(node -e "fetch(process.argv[1]+'/api/config').then(r=>r.json()).then(j=>console.log(j.version))" "$BASE") is up"
  drill seed "$BASE" "$code" "$state" | sed 's/^/   /' || fail "seeding $ref"
  stop
  old_schema="$(drill stamp "$data" "$state")"
  say "   stopped; its database is version $old_schema"
  if [ "$WRITE_FIXTURE" = 1 ]; then
    drill pack "$data" "$state" "$HEARTH/test/fixtures/upgrade-v$old_schema-$short.hfx.gz" | sed 's/^/   /'
  fi
  cp -a "$data" "$data-crash"
  rm -rf "$data-crash/outbox"

  # The upgrade itself, then two restarts.
  for round in 0 1 2; do
    start "$HEARTH" "$data"; wait_up
    [ "$round" = 0 ] && say "   upgraded: this checkout started on the old data" || say "   restart $round"
    verify "$data" "$state" "$round" "$ref, round $round" | sed 's/^/   /'
    stop
  done

  # An upgrade killed half-way (SIGKILL inside the migration transaction), then a normal start.
  if [ "$old_schema" -lt "$NEW_SCHEMA" ]; then
    start "$HEARTH" "$data-crash" HEARTH_TEST_KILL_IN_MIGRATION=1
    set +e; { wait "$PID"; } 2>/dev/null; code_exit=$?; set -e
    [ "$code_exit" = 137 ] || fail "expected the upgrade to be killed (exit 137), got $code_exit"
    after="$(schema_of "$data-crash")"
    [ "$after" = "$old_schema" ] || fail "a killed upgrade changed the database version ($old_schema -> $after)"
    ls "$data-crash/backups/hearth-before-v$NEW_SCHEMA-"*.db >/dev/null 2>&1 || fail "no pre-upgrade copy was made"
    say "   upgrade killed half-way: database still version $after, pre-upgrade copy in backups/"
    start "$HEARTH" "$data-crash"; wait_up
    say "   started again: the upgrade finished"
    verify "$data-crash" "$state" 3 "$ref, after the killed upgrade" | sed 's/^/   /'
    stop
  else
    say "   (no migration from version $old_schema, so there's no upgrade to interrupt)"
  fi
  say "   PASS"
done
say ""
say "Upgrade drill passed for: ${REFS[*]}"
