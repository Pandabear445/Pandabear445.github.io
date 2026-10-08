# Medieval Kingdom — Roblox gameplay framework

A complete, server-authoritative scripting architecture for a living medieval
kingdom: a limited-slot rank hierarchy with XP-ordered cascade promotions,
death resets, physical jobs, a resource/food economy that can thrive or
collapse, management, meetings, a Senate, events, monetization and admin
tools. **You build the map; the scripts find everything through tags and
attributes** (see [docs/MAP_MARKERS.md](docs/MAP_MARKERS.md)).

```
JOIN ─► low-rank job ─► travel to the workplace ─► real work ─► XP + coins + goods
 ─► deliver to storage ─► higher place in the promotion queue ─► a slot opens
 ─► highest XP directly below is promoted ─► cascade ─► manage others,
 attend meetings, run departments, sit in the Senate ... until you die,
 and start again from the bottom with your legacy intact.
```

## Quick start

1. Install [Rojo](https://rojo.space) (7.x) and the Rojo Studio plugin.
2. `cd kingdom && rojo serve`, then *Connect* from the plugin in your place.
   (Or `rojo build -o MedievalKingdom.rbxlx` and open the file.)
3. Game Settings → Security → **Enable Studio Access to API Services**
   (otherwise saving is simulated in memory — the side panel says so).
4. Place markers (start with the checklist at the end of
   [MAP_MARKERS.md](docs/MAP_MARKERS.md)) and press Play.
5. Put your user id in `src/server/Config/AdminConfig.lua` for live servers.

Rojo maps:

| Folder | Becomes |
|---|---|
| `src/shared/Config`, `src/shared/Shared` | `ReplicatedStorage.Kingdom.Config/Shared` |
| `src/server` | `ServerScriptService.Kingdom` (incl. server-only `Config/AdminConfig`) |
| `src/client` | `StarterPlayer.StarterPlayerScripts.Kingdom` |

## The rules that matter most

* **Ranks have limited slots** (RankConfig). The bottom rank is unlimited.
* **XP decides who is next in line, never your current rank.** When a slot
  opens, the highest-XP *eligible* player in the rank **directly below** is
  promoted; the slot that opens below is filled the same way — a cascade.
* **Nobody below can overtake a rank holder** by gaining XP.
* **New players start at the bottom.** Small servers keep leadership vacant
  (HYBRID mode population gates), so nobody becomes King alone in a server.
* **No passive XP.** Every point comes from validated actions at physical
  workplaces; AFK players earn nothing, salaries need recent work.
* **Death resets everything current:** XP → 0, rank → bottom, last in the
  queue, and the slot cascades. Lifetime stats, achievements, cosmetics,
  gamepasses and career history are kept. The reset is saved immediately.
* **Higher rank = more responsibility:** managers must inspect departments,
  issue and complete work orders, attend meetings and govern; their XP comes
  from outcomes, not button presses.

## Configuration

Everything tunable lives in `src/shared/Config` (plus server-only
`AdminConfig`). Nothing about ranks, jobs or numbers is hard-coded.

| File | Controls |
|---|---|
| `GameConfig` | Kingdom scope (Server/Global), EmptyRankFillingMode, rejoin policy, cooldowns, XP weights and caps, AFK, data store names, testing mode, debug logs, announcements |
| `RankConfig` | Ranks: slots, MinXP floors, population gates, permissions, management depth, departments, dashboards, pay/XP multipliers, salaries, privileges, meetings, council, chat tags |
| `PermissionConfig` | Permission keys and dashboard levels |
| `JobConfig` | Every job: tags, kind, defaults, steps, crops, recipes, performance tiers, travel limits |
| `ResourceConfig` | Resources (value, weight, decay, storage type, nutrition), storage types, starting stock |
| `ItemConfig` | Tools/weapons, qualities, durability effects, starter kit, requisitions, repairs, carry weight |
| `EconomyConfig` | Coins, treasury, crown revenue & production levy, taxes, paydays, market pricing, imports |
| `FoodConfig` | Hunger, sickness, kingdom consumption, mess halls |
| `KingdomConfig` | Needs and weights, stage thresholds, recovery, morale |
| `DepartmentConfig` | Departments, staffing targets, inspection, efficiency |
| `TimeConfig` | 7:00 AM → 10:00 PM in 45 real minutes, lighting keyframes |
| `MeetingConfig` | Meetings, announcements, attendance, teleport rules, called meetings |
| `WeatherConfig` | Weather states, effects, seasons |
| `BuildingConfig` | Building types, decay, condition bands, repairs |
| `EventConfig` | Kingdom events, triggers, objectives, rewards, consequences, hostiles |
| `GovernmentConfig` | Senate, voting rules, direct authority limits, discipline, petitions |
| `GamepassConfig` | GamePasses, products, Premium (cosmetic / quality of life only) |
| `AchievementConfig`, `DeathConfig`, `HousingConfig`, `UIConfig` | as named |

## Player controls

Prompts (`E`, plus `F`/`G`/`R`/`T` for secondary actions) do all the work.
Windows: **P** promotion queue · **K** kingdom · **M** meetings · **I** pack ·
**O** work orders · **N** duties & management · **J** Senate · **B** market ·
**C** career · **F2** admin. **Q** reels in a fish. Weapons attack on click.

## Monetization

Set real ids in `GamepassConfig` (entries with `Id = 0` are ignored). Passes
give cosmetics, carry/storage space, houses, private rooms and an optional
capped JobXP boost — never ranks, slots or death protection. Developer
products are processed idempotently.

## Documentation

* [docs/MAP_MARKERS.md](docs/MAP_MARKERS.md) — every tag and attribute
* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — services, data safety, security, failure handling
* [docs/TESTING.md](docs/TESTING.md) — tests, test mode, admin commands

## Notes and limits

* Verified with the offline unit tests, `luau-lsp` type analysis against the
  Roblox API definitions, and runtime scenarios on a mock engine
  (`tests/runtime`). It has not been run inside Roblox Studio by the author,
  so expect to tune numbers and check visuals once your map exists.
* Global scope stores the hierarchy in one MemoryStore value (≈32 KB): about
  400 ranked members plus online bottom-rank players. Idle bottom-rank
  entries are pruned automatically.
* PvP is off by default (`DeathConfig.PvP`), because a kill erases a
  career. Turn it on only with protections you are happy with.
* UI art uses gradients/strokes; set `UIConfig.Textures` and
  `UIConfig.Sounds` to your own asset ids for parchment/wood textures,
  fanfares and bells.
