# Testing & Admin Tools

## 1. Offline tests (no Roblox needed)

Requirements: [Luau](https://github.com/luau-lang/luau/releases) (`luau`),
[Rojo](https://github.com/rojo-rbx/rojo) (`rojo`), Python 3.

```bash
cd kingdom
luau tests/HierarchyModel.spec.luau      # rank-slot / cascade / death rules
tests/runtime/run.sh                      # boots the real game code on MockRoblox
```

`tests/runtime/MockRoblox.luau` is a small deterministic stand-in for the
engine (instances, attributes, tags, events, DataStores, MemoryStore, a
virtual-time task scheduler). `build.py` bundles the Rojo tree with it and a
scenario, so the **real** services boot and play:

| Scenario | Covers |
|---|---|
| `Scenario.luau` | boot, join, farming cycle, deliveries, permissions, XP → promotion with cooldown/population gates, requisition + mining, fishing, bot cascade after a king dies, real death reset (saved immediately, lifetime kept), leave/rejoin, market, admin commands, every query, a full simulated day, shutdown saves |
| `Scenario2.luau` | meeting teleport + attendance XP, guard duty (patrols, watch calls), construction, work orders (manager gets no XP from a one-worker order), Senate vote, direct demotion/appointment, discipline, duplicate action ids, crafting from storage, event objectives, player listings with escrow, death loot sacks, mess hall, hospital, housing, blacksmith repair queue, receipt idempotency, Safe Mode during a DataStore outage, session locks |
| `Scenario3.luau` | global (cross-server) hierarchy: kept slots while offline, remote changes, voided rank after dying elsewhere, inactivity release, DataStore backup/restore, shared treasury |
| `ClientScenario.luau` | client UI against the live server in one process: side panel, every window, storage/trade popups, promotion, death screen, lighting, notifications |

Static analysis (optional):
```bash
rojo sourcemap default.project.json -o sourcemap.json
luau-lsp analyze --sourcemap=sourcemap.json --definitions=globalTypes.d.luau --platform=roblox src/
```

## 2. In Studio

* Studio without "Enable Studio Access to API Services" uses in-memory
  stores (nothing is saved; the side panel says so). Turn API access on to
  test real DataStores.
* Everyone is an admin in Studio (`AdminConfig.StudioIsAdmin`) and **test
  mode** is on (`GameConfig.TestingMode.EnabledInStudio`).
* Open the admin panel with **F2** or the toolbar, or type in chat:
  `/k <command>` (chat commands use `Player.Chatted`; if your chat setup
  doesn't fire it, the panel always works).
* Use *Test → Clients and Servers* with 2–4 players to test promotions and
  meetings with real people; use bots for large hierarchies.

## 3. Admin commands

`<player>` accepts a name prefix, a UserId or `me`.

| Command | Effect |
|---|---|
| `help` | List commands |
| `givexp <player> <amount> [category]` | Add XP (Job/Management/Leadership/Contribution) |
| `removexp <player> <amount>` | Remove XP |
| `setrank <player> <rank>` | Place in a rank (needs a free slot; lower ranks demote) |
| `resetlife <player>` | Death-style reset without dying |
| `wipe <player> [keeplifetime]` | Reset saved data (player is kicked) |
| `kill <player>` | Real death (reset + cascade) |
| `heal <player>` | Full health |
| `coins <player> <amount>` | Add/remove coins |
| `treasury <amount>` | Add/remove treasury funds |
| `reseteconomy [players]` | Reset treasury/taxes (and player coins) |
| `spawn <resource> <amount>` | Add to kingdom storage |
| `setstock <resource> <amount>` | Set storage stock |
| `resetresources` | Starting stock |
| `give <player> <resource> <amount>` | Into a player's pack (tainted: no deposit XP) |
| `tool <player> <tool> [quality]` | Give a tool |
| `tp <player> [to]` | Teleport (whitelisted for anti-cheat) |
| `kick <player> <reason>` | Kick |
| `ban <player\|userId> <hours\|perm> <reason>` / `unban <userId>` | Bans (DataStore) |
| `startmeeting <MeetingID>` / `endmeetings` | Meetings |
| `repairall [amount]` / `damage <BuildingType\|all> <amount>` | Building condition |
| `settime <hour>` / `timespeed <x>` / `pausetime on\|off` | Clock |
| `weather <id> [hours]` | Weather |
| `event <EventId>` / `endevent <EventId> [success]` | Kingdom events |
| `morale <delta>` / `need <Need> <0-1> [minutes]` | Kingdom state |
| `hierarchy` | Print every rank's holders |
| `resetkingdom` | Resources, buildings, economy, bots |
| `sim <name> [arg]` | Simulations (test mode) |
| `bot add <rank> <xp> [count]` / `bot kill <id>` / `bot killtop` / `bot populate` / `bot clear` | Bots (test mode) |

Simulations: `xp <n>`, `promotion`, `demotion`, `foodshortage`,
`meeting [id]`, `restart` (save all + rebuild the hierarchy from saved
data), `leave` (leave and rejoin the hierarchy), `vacancy <rank>`,
`cascade` (populate with bots and kill the top rank), `crisis` (empty
treasury, crash needs, morale), `death`.

Every admin command is written to the audit log (admin panel → Log filter).
