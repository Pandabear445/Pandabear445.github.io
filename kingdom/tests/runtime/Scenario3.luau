--[[
	Runtime scenario 3: GLOBAL kingdom scope (one hierarchy for all servers)
	backed by MemoryStore with a DataStore backup and a shared treasury.
]]

local RS = game:GetService("ReplicatedStorage")
local GameConfig = require(RS.Kingdom.Config.GameConfig)
GameConfig.KingdomScope = "Global"

section("Boot (global scope)")
Mock.boot()
Sched.run(2)
local Rank, Data = svc("RankService"), svc("DataService")
local HttpService = game:GetService("HttpService")
check("rank service is global", Rank.IsGlobal == true)

local alice = Mock.addPlayer(401, "Alice")
local bob = Mock.addPlayer(402, "Bob")
Sched.run(3)
local map = Mock.Stores["memory:" .. GameConfig.Global.HierarchyMapName]
local function stored()
	local raw = map and map.data[GameConfig.Global.HierarchyKey]
	return raw and HttpService:JSONDecode(raw) or nil
end
local state = stored()
check("hierarchy stored in MemoryStore", state ~= nil and state.m["401"] ~= nil and state.m["402"] ~= nil)

section("Promotion through the global sync")
local ok = Mock.action(alice, "Admin", "Run", { command = "givexp Alice 400" })
check("xp given", ok)
for _ = 1, 8 do
	wiggle(alice)
	wiggle(bob)
	Sched.run(5)
end
check("promoted by global sync", alice:GetAttribute("KingdomRank") == "Worker", alice:GetAttribute("KingdomRank"))
check("store agrees", stored().m["401"].r == "Worker")

section("Leaving keeps the slot in a global kingdom")
Mock.removePlayer(alice)
Sched.run(3)
state = stored()
check("member kept with rank", state.m["401"] and state.m["401"].r == "Worker", state.m["401"] and state.m["401"].r)
check("marked offline", state.m["401"] and state.m["401"].o == false)

section("Another server changes the hierarchy")
state = stored()
state.m["402"].r = "Worker"
state.m["402"].t = os.time()
state.v += 1
map.data[GameConfig.Global.HierarchyKey] = HttpService:JSONEncode(state)
Rank:Refresh()
Sched.run(1)
check("refresh applied remote promotion to local player", bob:GetAttribute("KingdomRank") == "Worker", bob:GetAttribute("KingdomRank"))

section("Died on another server -> stored rank voided on rejoin")
local profileStore = Mock.Stores[GameConfig.Data.PlayerStore]
local record = profileStore.data["Player_401"]
record.Data.Life.Number = record.Data.Life.Number + 1
record.Data.XP = { Job = 0, Management = 0, Leadership = 0, Contribution = 0 }
local alice2 = Mock.addPlayer(401, "Alice")
Sched.run(4)
check("life mismatch voided Worker rank", alice2:GetAttribute("KingdomRank") == "Peasant", alice2:GetAttribute("KingdomRank"))

section("Inactive rank holders release their slot")
state = stored()
state.m["999"] = { r = "Lord", x = 50000, t = 0, s = os.time() - GameConfig.Global.RankInactivityReleaseSeconds - 10, j = 99, o = false, l = 1, n = "Ghost" }
state.v += 1
map.data[GameConfig.Global.HierarchyKey] = HttpService:JSONEncode(state)
Rank:Refresh()
Sched.run(GameConfig.Global.SyncIntervalSeconds + 2)
state = stored()
check("inactive lord released", state.m["999"] == nil or state.m["999"].r ~= "Lord", state.m["999"] and state.m["999"].r)

section("Backups and shared treasury")
Sched.run(GameConfig.Global.BackupIntervalSeconds + 5)
local backup = Mock.Stores[GameConfig.Global.BackupDataStore]
check("hierarchy backed up to DataStore", backup and backup.data[GameConfig.Global.HierarchyKey] ~= nil)
local treasury = Mock.Stores[GameConfig.Global.TreasuryDataStore]
check("treasury synced globally", treasury and treasury.data.Treasury ~= nil and type(treasury.data.Treasury.Balance) == "number")

section("MemoryStore expiry -> restore from backup on boot")
-- Simulated by checking the seed loader directly.
map.data[GameConfig.Global.HierarchyKey] = nil
Rank:_loadGlobalSeed()
check("seed restored from backup", Rank.State and Rank.State.m["402"] ~= nil)

finish("Scenario 3 (global)")
