# Map Marker Reference

You build the map. The scripts find everything through **CollectionService
tags** and **Attributes** — there are no hard-coded coordinates anywhere.

* Tag a **Part** or **Model** (use the Tag Editor or the Properties → Tags
  field). Models use their bounding box; parts use their own box.
* Add **Attributes** in the Properties panel. Every attribute is optional
  unless marked *required*; defaults come from the config modules.
* Markers can be added or removed while the server is running (e.g. a
  building finished in-game) — services listen for tag changes.
* Prompts (the "E" interactions) are created by the server on the marker.
  Give large Models a `PrimaryPart` so the prompt sits where you expect.
* Wrong attribute types are ignored (the default is used) and unknown
  `RequiredRank` names never lock players out, so a typo can't break play.

Common job attributes (accepted by **every** job marker):

| Attribute | Type | Meaning |
|---|---|---|
| `XPReward` | number | Base XP for a completed task (before performance tier / multipliers) |
| `Wage` | number | Base coins per task, paid by the treasury |
| `RequiredRank` | string | Minimum rank Id (e.g. `"Worker"`) |
| `RequiredPermission` | string | Permission key (PermissionConfig) instead of the job default |
| `RequiredDepartment` | string | Only members of this department may work here |
| `RequiredTool` | string | Tool Id from ItemConfig (`Hoe`, `Pickaxe`, `Axe`, `FishingRod`, `Hammer`, `Bucket`, `HuntingSpear`, `Sword`) |
| `WorkDuration` | number | Seconds the prompt must be held (server-timed) |
| `Cooldown` | number | Seconds before a depleted node recovers |
| `QualityMultiplier` | number | Multiplies yields at this marker |
| `MaxWorkers` | number | Max players working this spot/zone at once |
| `Enabled` | bool | `false` closes the workplace |

---

## Jobs

### `KingdomFarm` — farm field
A flat Part (or Model) the size of the field.

| Attribute | Default | Notes |
|---|---|---|
| `CropType` | `"Wheat"` | `Wheat`, `Vegetables`, `Herbs` |
| `PlotCount` | `8` | Plots generated in a grid when the field has none |
| `MaxWorkers` | `6` | |

**Plots:** children BaseParts named `Plot...` or tagged `KingdomFarmPlot`
are used as plots (each may have its own `CropType`). Otherwise plots are
generated on top of the field. Cycle: **Plant** (Hoe + 1 Seed) → **Water**
(Bucket; rain waters automatically) → grows on the in-game clock →
**Harvest** (Hoe) → crops + seeds into the farmer's pack. Ripe crops rot if
left (`RotAfterMinutes`) and must be cleared.

```
FarmZone01   Tag: KingdomFarm   CropType = "Wheat"  XPReward = 15  MaxWorkers = 5
```

### `KingdomMine` (zone) + `KingdomOreNode` (nodes)
`KingdomMine` is the mine's volume (players must be inside it to mine).
Put `KingdomOreNode` parts inside it. A mine with **no** ore nodes acts as one
big node so you can start simple.

| Node attribute | Default |
|---|---|
| `ResourceReward` | `"IronOre"` (`Coal`, `Stone`, `GoldOre` also valid) |
| `NodeUses` | `6` uses before it is depleted |
| `Cooldown` | `45` seconds to recover |
| `YieldMin` / `YieldMax` | `1` / `3` |

Bonus drops (stone, coal, rare gold) come from JobConfig. Mining requires a
Pickaxe and the `Job.Advanced` permission (Worker+). Mines are dangerous
during a Mine Collapse event (players get a 30 s warning to leave).

### `KingdomQuarry`
Stone gathering node (Pickaxe, `Job.Basic`).

### `KingdomForest` (zone) + `KingdomTree` (nodes)
Like mines. Trees disappear while regrowing (`Cooldown`, default 60 s).
Axe required.

### `KingdomFishing`
A fishing spot (pier end, shore). Cast → wait for the bite → react in time.
Fishing Rod required. Storms reduce catches.

### `KingdomHunting`
Hunting ground node. Yields meat and hide. **Dangerous**: a chance of
injury (damage, shown on the prompt) — hunters can die and lose their XP.

### `KingdomWell`
Water drawing (Bucket). Never depletes.

### `KingdomCleaning`
Dirty spot inside a `KingdomBuilding`. Cleaning restores a little building
condition and pays a small wage.

### Crafting stations
One prompt per recipe (max 4 per marker; split recipes over several
markers with the `Recipes` attribute, e.g. `Recipes = "Bread"`).
Ingredients come from the worker's pack first, then kingdom storage (if
their rank has `Storage.Withdraw`, hourly limit per rank).

| Tag | Job | Recipes (JobConfig) |
|---|---|---|
| `KingdomMill` | Milling | Wheat → Flour |
| `KingdomBakery` | Baking | Flour + Water + Firewood → Bread |
| `KingdomKitchen` | Cooking | Meat/Fish + Vegetables + Water + Firewood → Hearty Stew; Bread |
| `KingdomSmokehouse` | Smoking | Meat/Fish + Firewood → Preserved Rations |
| `KingdomWoodshed` | Firewood | Logs → Firewood (Axe) |
| `KingdomSmelter` | Smelting | Iron Ore + Coal → Iron; Gold Ore + Coal → Gold |
| `KingdomBlacksmith` | Blacksmithing | Iron + Wood → Tool Kits; Iron + Wood + Coal → Weapons. **Repair queue** (players leave damaged tools; smiths repair them with iron) |
| `KingdomApothecary` | Apothecary | Herbs + Water → Medicine |
| `KingdomTailor` | Tailoring | Hide → Clothing |

### `KingdomStorage` / `KingdomWarehouse` — storage
| Attribute | Default | Notes |
|---|---|---|
| `StorageType` | `"General"` | Comma list of `Food`, `General`, `Ore`, `Armory`, `Medical`, `Water`, `Treasury` |
| `Capacity` | per type (ResourceConfig) | Split evenly across the listed types; scaled by the building's condition |

Prompts: **Deposit goods** (pays Contribution XP + delivery wage),
**Withdraw / Requisition** (ranks with `Storage.Withdraw`; tool kits /
weapons become personal tools), **Audit stock** (managers; slows spoilage).
If the map has no storage markers the game uses a virtual store so you can
test early.

```
Warehouse01   Tag: KingdomStorage   StorageType = "Food"   Capacity = 5000
```

### `KingdomGuardPost` + `KingdomPatrolPoint`
| Attribute | Where | Default |
|---|---|---|
| `PostRadius` | post | `30` studs guards must stay within (or on the route) |
| `MaxWorkers` | post | `2` |
| `Route` | post and points | Only points with the same `Route` belong to that post's circuit (blank = all points) |

Begin watch → patrol points → answer watch calls at the post. Guards on duty
raise the kingdom's **Security**.

### `KingdomConstruction` — construction project
| Attribute | Default | Notes |
|---|---|---|
| `ProjectName` | marker name | |
| `RequiredWood` / `RequiredStone` / `RequiredIron` | 0 | Materials builders must deliver |
| `WorkRequired` | `10` | Build actions (Hammer) |
| `AutoApproved` | `false` | Otherwise a manager with `Projects.Approve` (or the Senate) approves |
| `FundingCost` | `0` | Treasury coins spent on approval |
| `Repeatable` | `false` | Reset two minutes after completion |

Children named **`Scaffold`** are hidden and children named **`Completed`**
are revealed when the project is finished.

### `KingdomTradePost`
Merchants export carried goods abroad. Revenue goes mostly to the treasury.

### `KingdomAdminDesk`
Clerks answer ledger questions built from the real stock figures.

### `KingdomJobStation` — generic station
Any job by name: set **`JobType`** (*required*) to a job Id or alias, e.g.
`"Blacksmith"`, `"Kitchen"`, `"Mine"`, `"Farm"`, `"GuardPost"`.

```
Blacksmith01   Tag: KingdomJobStation   JobType = "Blacksmith"   RequiredRank = "Worker"
```

---

## Buildings & places

### `KingdomBuilding`
| Attribute | Default | Notes |
|---|---|---|
| `BuildingType` | `"Other"` | `Farm`, `Mine`, `Warehouse`, `Granary`, `Blacksmith`, `Castle`, `Barracks`, `Kitchen`, `Market`, `Hospital`, `MeetingHall`, `House`, `Mill`, `Other` |
| `Department` | from type | Department whose efficiency it affects |
| `Health` | `100` | Starting condition (0–100); live value is the `Condition` attribute |
| `Outdoor` | `true` | Outdoor buildings take storm damage |
| `Enabled` | `true` | |

Stations **inside** a building Model (or with a `Building` attribute naming
it) are affected by its condition: Excellent ≥75%, Good ≥50% (90%),
Damaged ≥25% (70%), Critical (45%), Disabled at 0% (stations stop working).
Storage inside a damaged warehouse holds less. Builders repair with a Hammer
and wood/stone from storage. `House` buildings count toward the Housing need.

### `KingdomMessHall` / `KingdomTavern`
Players eat kingdom food here (free rations per rank per day, then paid).

### `KingdomHospital`
Sick players get treated (uses Medicine from storage + a fee).

### `KingdomMarket`
Players must be near one to trade (kingdom prices + player listings).

### `KingdomMeetingRoom` + `KingdomMeetingSpawn`
| Attribute | Notes |
|---|---|
| `MeetingID` (room) | Meeting id from MeetingConfig (`RoyalCouncil`, `DepartmentMeeting`, `KingdomMeeting`) or `"*"` for any meeting without its own room |
| `MeetingID` (spawn) | Same id; spawns inside the room Model also count |

The room's volume is used for attendance. Required ranks are teleported to
the spawn markers when the meeting starts.

```
MeetingRoom   Tag: KingdomMeetingRoom   MeetingID = "RoyalCouncil"
```

### `KingdomInspectionPoint`
Managers inspect a department here. **`Department`** (*required*):
`Agriculture`, `Mining`, `Forestry`, `Fishing`, `Food`, `Construction`,
`Blacksmithing`, `Military`, `Trade`, `Government`. Departments without a
point can be inspected at their `KingdomBuilding`s.

### `KingdomHouse` + `KingdomBed` (optional housing)
| Attribute | Default |
|---|---|
| `HouseId` | marker name |
| `RentPrice` | `15` coins per in-game day |
| `MinRank` | none |
| `Premium` | `false` (requires the PremiumHouse gamepass) |
| `Storage` | `40` extra personal storage while you live there |

A `KingdomBed` inside the house lets the tenant set their respawn point.

### `KingdomPersonalStorage`
A chest where players can use their personal (saved) storage.

### `KingdomHazard`
Damages players inside it every half second.
| Attribute | Default |
|---|---|
| `HazardType` | `"Hazard"` (`Fire`, `Drowning`, ... map to death causes) |
| `DamagePerSecond` | `10` |
| `Cause` | custom death-cause text |
| `Enabled` | `true` |

### `KingdomBanditSpawn`
Where bandits appear during a Bandit Attack. Put a bandit **Model** (with
`Humanoid` + `HumanoidRootPart`) in `ServerStorage.Kingdom.NPCs.Bandit`.
Without a template, guards defend by answering watch calls instead.

### `KingdomCelebrationPoint`
Where purchased fireworks go off.

### `KingdomHostile`
Tag any NPC Model to make it hostile (attribute `HostileType` = an
EventConfig.Hostiles key, default `Bandit`).

---

## Optional assets (ServerStorage)

| Path | Used for |
|---|---|
| `ServerStorage.Kingdom.Tools.<ToolId>` | Tool models given to players (otherwise a simple generated tool) |
| `ServerStorage.Kingdom.NPCs.<Template>` | Hostile NPC templates |

## Checklist for a first playable map

1. One `KingdomStorage` (StorageType `"Food,General,Ore,Armory,Medical,Water"`).
2. One `KingdomFarm`, one `KingdomForest` with a few `KingdomTree`s, one
   `KingdomFishing`, one `KingdomWell`.
3. A `KingdomMine` with a few `KingdomOreNode`s.
4. `KingdomKitchen`, `KingdomBakery`, `KingdomMill`, `KingdomBlacksmith`, `KingdomSmelter`.
5. `KingdomMessHall`, `KingdomMarket`, `KingdomHospital`.
6. A `KingdomGuardPost` with two or three `KingdomPatrolPoint`s.
7. A `KingdomMeetingRoom` (`MeetingID = "*"`) with a `KingdomMeetingSpawn`.
8. A `SpawnLocation` for players.
