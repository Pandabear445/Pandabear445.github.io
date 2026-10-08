#!/bin/bash
# Boots the real code on MockRoblox and runs the runtime scenarios:
#   Scenario.luau        core server loops (join, jobs, promotion, death, economy)
#   Scenario2.luau       guards, construction, orders, meetings, senate,
#                        discipline, safe mode, session locks, crafting, events
#   ClientScenario.luau  server + client UI in one process
# Needs rojo + luau (set ROJO / LUAU to override) and python3.
set -e
cd "$(dirname "$0")/../.."
ROJO="${ROJO:-rojo}"
LUAU="${LUAU:-luau}"
OUT="${TMPDIR:-/tmp}/kingdom-runtime"
T=tests/runtime
mkdir -p "$OUT"
"$ROJO" sourcemap default.project.json -o "$OUT/sourcemap.json" > /dev/null
python3 $T/build.py "$OUT/sourcemap.json" "$OUT/server.luau" $T/Common.luau $T/Scenario.luau > /dev/null
python3 $T/build.py "$OUT/sourcemap.json" "$OUT/server2.luau" $T/Common.luau $T/Scenario2.luau > /dev/null
INCLUDE_CLIENT=1 python3 $T/build.py "$OUT/sourcemap.json" "$OUT/client.luau" $T/Common.luau $T/ClientScenario.luau > /dev/null
for name in server server2 client; do
	echo "### $name"
	"$LUAU" "$OUT/$name.luau"
done
