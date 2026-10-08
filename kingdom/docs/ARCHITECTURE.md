# Architecture

## Layout (Rojo)

```
kingdom/
├── default.project.json          Rojo project
├── src/shared  -> ReplicatedStorage.Kingdom
│   ├── Config/                   every tunable number (see README)
│   └── Shared/                   pure modules used by server + client
│       ├── HierarchyModel.lua    rank slots, cascade, death reset (pure logic)
│       ├── GameClock.lua         server time -> kingdom time
│       ├── Remotes.lua           remote names
│       ├── Signal.lua, Logger.lua, Format.lua
├── src/server  -> ServerScriptService.Kingdom
│   ├── Main.server.lua           boots the registry
│   ├── Config/AdminConfig.lua    SERVER ONLY (admins, anti-cheat responses)
│   ├── Core/                     ServiceRegistry, Net, RateLimiter, Check,
│   │                             StoreUtil, ZoneUtil, PromptUtil
│   └── Services/                 one ModuleScript per service
│       └── Jobs/                 job "kinds" (interaction mechanics)
├── src/client  -> StarterPlayerScripts.Kingdom
│   ├── KingdomClient.client.lua
│   ├── Controllers/              net, state mirror, clock, lighting, effects,
│   │                             chat tags, prompt filter, combat input
│   └── UI/                       Kit, App, HUD, Notifications, Windows/*
├── docs/                         this folder
└── tests/                        unit + runtime tests (not part of the game)
```

## Services and dependencies

Services declare `Dependencies`. `ServiceRegistry` sorts them topologically,
refuses cycles, and only lets a service `:Use()` what it declared. Upward
communication happens through **signals** and **registered providers**
(e.g. `XPService:RegisterMultiplier`, `KingdomService:SetSecurityProvider`),
never through circular requires.

| Service | Depends on | Responsibility |
|---|---|---|
| AuditService | – | Ring-buffer + batched DataStore audit log |
| NotificationService | – | Toasts, banners, chat lines |
| StateService | – | Batched replication of player/kingdom state |
| TimeService | – | Kingdom clock, minute/hour/day signals |
| ActivityService | – | Movement/AFK sampling, task positions, teleport whitelist |
| DataService | Audit | Session-locked profiles, safe mode, bans |
| RankService | Data, Audit, State | Hierarchy storage (server memory or MemoryStore) |
| XPService | Data, Rank, Activity, Audit, State | XP categories, gates, multipliers, caps, life reset |
| PermissionService | Rank, Data, Audit | Permissions, management authority, admins |
| PromotionService | Rank, XP, Data, Notification, Audit, State | When hierarchy ops run; announcements; queues |
| InventoryService | Data, Audit, State, Time | Items, tools, taint, loot sacks, personal storage |
| ResourceService | Time, Audit, State | Kingdom storage, capacity, decay, flows |
| EconomyService | Data, Audit, State, Time, Notification, Rank, Resource, XP | Coins, treasury, wages, salaries, taxes, prices |
| WeatherService | Time, State, Notification, Audit | Weather + seasons, job/growth/speed modifiers |
| BuildingService | Resource, Time, State, …, Weather | Building condition, repairs, efficiency |
| CharacterService | Data, Rank, Activity, Weather, Audit | Spawning, death causes, hazards, speed, nameplates |
| FoodService | Data, Resource, Time, Character, … | Hunger, sickness, mess halls, hospitals, consumption |
| KingdomService | Resource, Food, Building, Time, Economy, … | Needs, stability, stage, morale, productivity |
| DepartmentService | Activity, Rank, Permission, Building, Kingdom, … | Staffing, production, efficiency, inspections |
| JobService (+ Jobs/*) | Inventory, Resource, XP, Economy, Permission, … | Stations, validation, performance, rewards |
| CombatService | Character, Inventory, Permission, … | Server-validated melee, hostile NPCs |
| MarketService | Economy, Inventory, Resource, … | Kingdom market + escrowed player listings |
| ManagementService | Department, Job, Rank, Permission, XP, … | Work orders, inspections, outcome XP, dashboards |
| GovernmentService | Rank, Promotion, Permission, Economy, … | Senate, votes, direct authority, petitions |
| DisciplineService | Permission, Rank, Economy, Government, Job, … | Warnings, fines, suspensions, appeals |
| MeetingService | Time, Rank, Character, XP, Discipline, … | Schedule, teleports, attendance |
| AntiExploitService | Activity, Audit, Notification, Permission, XP, Character, Data | Suspicion scores, flags |
| DeathService | Character, XP, Promotion, Inventory, Job, Data, … | The death reset transaction |
| EventService | Time, Weather, Resource, Kingdom, Job, Combat, … | Kingdom events and objectives |
| MonetizationService | Data, XP, Inventory, Character, Economy, … | GamePasses, products, Premium |
| HousingService | Data, Economy, Rank, Inventory, Character, … | Houses, rent, beds |
| AchievementService | Data, Promotion, Job, Management, Meeting, Event, Death, … | Persistent achievements, badges |
| TestingService | Rank, Promotion, XP, Kingdom, … | Bots and simulations (test mode) |
| AdminService | (almost everything) | Admin commands |
| SessionService | Data, Promotion, Inventory, Character, Job, Market, … | Join / leave orchestration |

## The hierarchy

`HierarchyModel` is pure Luau with no Roblox APIs. The same code runs in
memory (server scope), inside MemoryStore `UpdateAsync` transforms (global
scope) and in the offline unit tests.

* **XP orders the queue; it never grants a rank.** Each rank has
  `MaxSlots`; the bottom rank is unlimited.
* `Rebalance` walks ranks **top-down**: an open slot pulls the best eligible
  member from the rank directly below, which opens a slot that the next
  step fills — a cascade, one rung at a time.
* Eligibility: online, not promotion-blocked (recently demoted), meets the
  rank's `MinXP` floor, outside the promotion cooldown, and (HYBRID) the
  server has `MinActivePlayers`.
* Holders are never displaced by XP. Only death, leaving (server scope),
  demotion, removal, inactivity (global scope) or admin action vacate a slot.
* Every transaction ends with `Validate` (unknown ranks → bottom,
  over-capacity → newest arrivals move down), so a crash or config change
  can't leave two players in one slot.

Fill modes (`GameConfig.EmptyRankFillingMode`): `CASCADE`, `HIGHEST_XP`,
`FIRST_PLAYER`, `MANUAL`, `HYBRID` (default).

### Server vs global scope

| | Server (default) | Global |
|---|---|---|
| Hierarchy lives in | server memory | MemoryStore HashMap (atomic `UpdateAsync`) |
| On leave | slot vacates → cascade | slot kept while offline (released after `RankInactivityReleaseSeconds`) |
| On join | bottom rank (or `RestoreIfVacant`) | stored rank, unless the player's life counter changed (died elsewhere) |
| XP sync | debounced per change | batched every `SyncIntervalSeconds` |
| Other servers | – | MessagingService notice + periodic refresh |
| Backup | – | DataStore snapshot every `BackupIntervalSeconds`; restored if the MemoryStore entry expires |
| Treasury | per server | shared via DataStore deltas (`PersistTreasury`) |

Resources, jobs, meetings and buildings are always per server ("local
production"); player progression is always saved globally.

## Death transaction

`CharacterService` determines the cause server-side (damage tags, fall
damage, hazards, drowning) and `DeathService` runs:

1. hold respawn → 2. cancel work (no completion rewards) → 3. item rules
(resources drop as a recoverable sack) → 4. XP → 0, life closed into
career history, lifetime stats kept → 5. hierarchy reset + cascade →
6. **save immediately** (retries) → 7. release respawn → 8. death screen +
kingdom announcements. `SessionService` waits for an in-progress death reset
before the leave-save, so leaving can't restore pre-death data.

## Data safety

* `UpdateAsync` only; session lock = `{ Job = JobId, Time }`.
* Load failure → **Safe Mode** (walk only, no progression, no saves),
  background retry. Defaults are never saved over real data.
* Locked by another server → retry, then ask the player to rejoin.
* Saves are serialized per player; a lost lock stops writes and kicks.
* Shutdown saves every player and releases locks; autosave stops.
* Death resets and developer-product receipts save immediately.
* Escrow (market listings, repair queue) lives in the owner's profile and is
  returned on the next join.

## Network security

All remotes are created by `Core/Net` and pass through:
payload sanitizing (plain data, bounded size/depth) → per-endpoint token
bucket + global budget → readiness gate (data loaded, not safe mode) →
duplicate action-id check → error-isolated handler. Clients send intents
("Interact with station 12", "Reel", "Buy 3 Bread"); the server validates
distance, zone, rank, permission, tools, cooldowns, node state, travel time,
capacity and stock, and computes every reward itself.

Additional protections: server-timed prompt holds, taint on withdrawn /
bought goods (no deposit-XP loops), XP caps per award and per minute,
manager XP only from outcomes with ≥2 contributors, rank tags in chat and
nameplates set from server attributes, admin config never replicated.

## Failure isolation

* A service that fails `Init` is retried, then **Disabled**; dependents are
  disabled; everything else runs.
* Periodic work uses `registry:Every`, which catches errors, marks the
  service **Degraded**, backs off and recovers automatically.
* Status is published as `ReplicatedStorage.Kingdom` attributes
  (`Status_<Service>`); the HUD shows e.g. "Food systems temporarily
  unavailable."
* Signal listeners, prompt handlers, session steps and remote handlers are
  all individually error-isolated.

## Chain reactions (why the kingdom feels alive)

```
farmers stop ──► stored food falls ──► Food need falls ──► stage slides one
step per evaluation ──► morale drifts down ──► productivity (all yields)
falls ──► fewer deliveries ──► production levy falls ──► treasury can't pay
wages/salaries ──► unpaid wages hit morale ──► ... ──► Crisis / Collapse
```
Recovery runs the other way, through the **Recovery** stage. Scarcity also
raises market prices (food gets expensive), hunger lowers performance, and
starving players fall sick (slower, weaker) until treated.

## Performance

* One loop per concern for all players (activity 1 s, hazards 0.5 s,
  NPC brains 0.5 s, job ticks 1 s / per in-game minute), never per-frame
  per-player loops on the server.
* State replication is coalesced (4 Hz) and resource snapshots every 3 s.
* Audit writes are batched (one new key per minute); XP/currency/resource
  events are aggregated into counters.
* Autosaves are staggered across the interval.
