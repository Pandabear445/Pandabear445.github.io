--[[
	Runtime scenario: boots the real server code on MockRoblox and plays
	through the core loops. Run with tests/runtime/run.sh
]]


---------------------------------------------------------------------------
-- Test map (markers only, like a builder would place them)
---------------------------------------------------------------------------
local ws = workspace

local warehouse = part("Warehouse01", Vector3.new(0, 2, 0), Vector3.new(10, 4, 10), { "KingdomStorage" }, { StorageType = "Food,General,Ore,Armory,Medical,Water", Capacity = 20000 })
local farmField = part("FarmZone01", Vector3.new(50, 0, 0), Vector3.new(20, 1, 20), { "KingdomFarm" }, { CropType = "Wheat", XPReward = 15, PlotCount = 4, MaxWorkers = 5 })
local mineBuilding = model("MineBuilding", { "KingdomBuilding" }, { BuildingType = "Mine", Department = "Mining" })
local mineZone = part("MineZone", Vector3.new(-60, 0, 0), Vector3.new(40, 20, 40), { "KingdomMine" }, {}, mineBuilding)
local oreNode = part("IronVein", Vector3.new(-60, 2, 5), Vector3.new(3, 3, 3), { "KingdomOreNode" }, { ResourceReward = "IronOre" }, mineBuilding)
local forest = part("Forest", Vector3.new(0, 0, 80), Vector3.new(40, 10, 40), { "KingdomForest" })
local tree = part("Oak", Vector3.new(5, 2, 80), Vector3.new(2, 10, 2), { "KingdomTree" })
local fishing = part("Pier", Vector3.new(0, 0, -80), Vector3.new(6, 1, 6), { "KingdomFishing" })
local kitchen = part("Kitchen", Vector3.new(20, 2, 20), Vector3.new(6, 4, 6), { "KingdomKitchen" })
local guardPost = part("NorthGate", Vector3.new(100, 2, 100), Vector3.new(4, 4, 4), { "KingdomGuardPost" })
local patrolA = part("TowerA", Vector3.new(110, 2, 100), nil, { "KingdomPatrolPoint" })
local patrolB = part("TowerB", Vector3.new(100, 2, 115), nil, { "KingdomPatrolPoint" })
local council = part("CouncilChamber", Vector3.new(-100, 2, -100), Vector3.new(30, 10, 30), { "KingdomMeetingRoom" }, { MeetingID = "*" })
part("Seat1", Vector3.new(-100, 2, -95), nil, { "KingdomMeetingSpawn" }, { MeetingID = "RoyalCouncil" })
local market = part("MarketSquare", Vector3.new(30, 2, -30), Vector3.new(10, 2, 10), { "KingdomMarket" })
local messHall = part("MessHall", Vector3.new(-30, 2, 30), Vector3.new(8, 4, 8), { "KingdomMessHall" })
local site = part("Bridge", Vector3.new(70, 2, 70), Vector3.new(8, 2, 8), { "KingdomConstruction" }, { ProjectName = "Stone Bridge", RequiredWood = 4, RequiredStone = 2, WorkRequired = 2, AutoApproved = true })
local desk = part("ClerkDesk", Vector3.new(-20, 2, -20), nil, { "KingdomAdminDesk" })
local tradePost = part("TradePost", Vector3.new(120, 2, -40), nil, { "KingdomTradePost" })
part("Hospital", Vector3.new(-40, 2, -40), nil, { "KingdomHospital" })
part("SpikeTrap", Vector3.new(500, 0, 500), Vector3.new(4, 4, 4), { "KingdomHazard" }, { HazardType = "Fire", DamagePerSecond = 50 })

---------------------------------------------------------------------------
-- Boot
---------------------------------------------------------------------------
section("Boot")
Mock.boot()
Sched.run(2)
local RS = game:GetService("ReplicatedStorage")
check("server ready", RS.Kingdom:GetAttribute("ServerReady") == true)
for _, name in ipairs({ "DataService", "RankService", "PromotionService", "JobService", "EconomyService", "FoodService", "MeetingService", "GovernmentService", "EventService", "AdminService", "SessionService", "KingdomService" }) do
	check("service " .. name .. " ready", RS.Kingdom:GetAttribute("Status_" .. name) == "Ready", RS.Kingdom:GetAttribute("Status_" .. name))
end
check("clock published", type(RS.Kingdom:GetAttribute("ClockEpoch")) == "number")

-- Grab live service tables for white-box checks.
local Data, Rank, XP, Promotion = svc("DataService"), svc("RankService"), svc("XPService"), svc("PromotionService")
local Inventory, Resources, Jobs = svc("InventoryService"), svc("ResourceService"), svc("JobService")

---------------------------------------------------------------------------
-- Players join
---------------------------------------------------------------------------
section("Join")
local p1 = Mock.addPlayer(101, "Alice")
local p2 = Mock.addPlayer(102, "Bob")
local p3 = Mock.addPlayer(103, "Cara")
local p4 = Mock.addPlayer(104, "Dan")
Sched.run(3)
for _, p in ipairs({ p1, p2, p3, p4 }) do
	check(p.Name .. " loaded", Data:IsLoaded(p))
	check(p.Name .. " is Peasant", p:GetAttribute("KingdomRank") == "Peasant", p:GetAttribute("KingdomRank"))
	check(p.Name .. " has character", p.Character ~= nil)
end
check("starter kit given", Inventory:HasToolType(p2, "Hoe") and Inventory:HasToolType(p2, "Bucket"))
check("admin flag (studio)", p1:GetAttribute("KingdomAdmin") == true)


---------------------------------------------------------------------------
-- Farming loop: plant -> water -> grow -> harvest -> deliver
---------------------------------------------------------------------------
section("Farming")
local plots = farmField:FindFirstChild("KingdomPlots")
check("plots generated", plots ~= nil and #plots:GetChildren() == 4)
local plot = plots and plots:GetChildren()[1]
Mock.moveTo(p2, plot.Position + Vector3.new(0, 3, 0))
Sched.run(1)
local prompt = Mock.findPrompt(plot)
check("plot prompt exists", prompt ~= nil)
local xpBefore = XP:GetTotal(p2)
local plantCutoff = #Mock.ClientEvents
Mock.firePrompt(prompt, p2, 3)
for _, note in ipairs(Mock.notificationsFor(p2, plantCutoff)) do
	if note.Kind == "Warning" then
		Mock.print("    note: " .. tostring(note.Title) .. " / " .. tostring(note.Text))
	end
end
-- (Rain waters new crops automatically, so the prompt may skip "Water".)
check("planted", string.find(prompt.ObjectText, "growing") ~= nil, prompt.ObjectText)
check("planting gave XP", XP:GetTotal(p2) > xpBefore, XP:GetTotal(p2))
-- Too-short hold is rejected.
local xpMid = XP:GetTotal(p2)
Mock.firePrompt(prompt, p2, 0.2)
check("short hold rejected", XP:GetTotal(p2) == xpMid)
Sched.run(1)
if prompt.Enabled then
	Mock.firePrompt(prompt, p2, 2)
	Sched.run(1)
end
check("watered (prompt disabled while growing)", prompt.Enabled == false, prompt.ActionText)
-- Grow: 60 in-game minutes x 3s, watered 1.5x speed (weather varies).
for _ = 1, 30 do
	wiggle(p2)
	Sched.run(10)
	if prompt.ActionText == "Harvest" then
		break
	end
end
check("crop ripened", prompt.ActionText == "Harvest", prompt.ActionText)
local harvestCutoff = #Mock.ClientEvents
Mock.firePrompt(prompt, p2, 3.5)
for _, note in ipairs(Mock.notificationsFor(p2, harvestCutoff)) do
	Mock.print("    note: " .. tostring(note.Title) .. " / " .. tostring(note.Text))
end
local wheat = Inventory:Count(p2, "Wheat")
check("harvest yielded wheat", wheat > 0, wheat)

-- Deliver to storage.
Mock.moveTo(p2, warehouse.Position + Vector3.new(0, 3, 0))
Sched.run(1)
local stockBefore = Resources:GetStock("Wheat")
local contribution = Data:Get(p2).XP.Contribution
Mock.firePrompt(Mock.findPrompt(warehouse, "Deposit"), p2, 1.5)
check("wheat deposited", Resources:GetStock("Wheat") > stockBefore and Inventory:Count(p2, "Wheat") == 0)
check("delivery gave contribution XP", Data:Get(p2).XP.Contribution > contribution, Data:Get(p2).XP.Contribution)

---------------------------------------------------------------------------
-- Permissions: a Peasant cannot mine
---------------------------------------------------------------------------
section("Job permissions & tools")
Mock.moveTo(p3, oreNode.Position + Vector3.new(0, 3, 2))
Sched.run(1)
local minePrompt = Mock.findPrompt(oreNode, "Mine")
local cutoff = #Mock.ClientEvents
Mock.firePrompt(minePrompt, p3, 4.5)
local refused = false
for _, note in ipairs(Mock.notificationsFor(p3, cutoff)) do
	if note.Text and string.find(note.Text, "rank cannot") then
		refused = true
	end
end
check("peasant refused mining", refused)
check("no ore given", Inventory:Count(p3, "IronOre") == 0)

---------------------------------------------------------------------------
-- XP -> promotion (HYBRID gates: MinXP + cooldown + population)
---------------------------------------------------------------------------
section("Promotion")
local ok, message = Mock.action(p1, "Admin", "Run", { command = "givexp Cara 400" })
check("admin givexp", ok, message)
Sched.run(3)
check("Cara promoted to Worker", p3:GetAttribute("KingdomRank") == "Worker", p3:GetAttribute("KingdomRank"))
Sched.run(30)
check("cooldown holds Cara at Worker", p3:GetAttribute("KingdomRank") == "Worker")
for _ = 1, 8 do
	wiggle(p3)
	Sched.run(10)
end
check("after cooldown Cara is Guard (2+ active players)", p3:GetAttribute("KingdomRank") == "Guard", p3:GetAttribute("KingdomRank"))
local promotionEffects = Mock.effectsFor(p3, "Promotion")
check("promotion effect sent", #promotionEffects >= 1)

-- Worker can mine with a pickaxe from the armory.
local reqOk, reqMessage = Mock.action(p3, "Job", "Interact", { station = warehouse:GetAttribute("KingdomStationId"), action = "Requisition", tool = "Pickaxe" })
check("requisition needs to be at storage", not reqOk, reqMessage)
Mock.moveTo(p3, warehouse.Position + Vector3.new(0, 3, 0))
Sched.run(1)
reqOk, reqMessage = Mock.action(p3, "Job", "Interact", { station = warehouse:GetAttribute("KingdomStationId"), action = "Requisition", tool = "Pickaxe" })
check("requisitioned pickaxe", reqOk and Inventory:HasToolType(p3, "Pickaxe"), reqMessage)
-- Teleport-to-job travel check: jump straight to the mine (far) right after a task.
Mock.moveTo(p3, oreNode.Position + Vector3.new(0, 3, 2))
Sched.run(6)
Mock.firePrompt(minePrompt, p3, 4.5)
check("guard mined ore", Inventory:Count(p3, "IronOre") > 0, Inventory:Count(p3, "IronOre"))

---------------------------------------------------------------------------
-- Fishing reaction
---------------------------------------------------------------------------
section("Fishing")
Mock.moveTo(p4, fishing.Position + Vector3.new(0, 3, 2))
Sched.run(1)
Mock.firePrompt(Mock.findPrompt(fishing, "Cast"), p4, 0.7)
local casts = Mock.effectsFor(p4, "FishingCast")
check("cast effect", #casts == 1)
local bites = {}
for _ = 1, 100 do
	Sched.run(0.1)
	bites = Mock.effectsFor(p4, "FishingBite")
	if #bites > 0 then
		break
	end
end
check("bite effect", #bites == 1)
if bites[1] then
	local fishOk, fishMessage = Mock.action(p4, "Job", "Interact", { station = bites[1].Station, action = "Reel", session = bites[1].Session })
	check("reeled in fish", fishOk and Inventory:Count(p4, "Fish") > 0, fishMessage)
end

---------------------------------------------------------------------------
-- Cascade with bots and a death reset
---------------------------------------------------------------------------
section("Cascade & death")
ok, message = Mock.action(p1, "Admin", "Run", { command = "bot populate" })
check("bots populated", ok, message)
Sched.run(1)
local kingQueue = Rank:GetQueue("King")
check("a king exists", #kingQueue == 1)
local dukeTop = Rank:GetQueue("RoyalCouncil")[1]
ok, message = Mock.action(p1, "Admin", "Run", { command = "bot killtop" })
check("killed the king", ok, message)
Sched.run(1)
local newKing = Rank:GetQueue("King")[1]
check("highest council member became king", newKing and dukeTop and newKing.id == dukeTop.id, newKing and newKing.id)
local hierarchyValid = true
for _, rankDef in ipairs(require(RS.Kingdom.Config.RankConfig).Ranks) do
	if rankDef.MaxSlots and #Rank:GetQueue(rankDef.Id) > rankDef.MaxSlots then
		hierarchyValid = false
	end
end
check("no rank over capacity", hierarchyValid)

-- Real player death: Cara (Guard) dies to a hazard.
local caraXP = XP:GetTotal(p3)
check("Cara had XP before death", caraXP > 0, caraXP)
Mock.moveTo(p3, Vector3.new(500, 2, 500))
Sched.run(4)
check("Cara died -> XP 0", XP:GetTotal(p3) == 0, XP:GetTotal(p3))
check("Cara died -> Peasant", p3:GetAttribute("KingdomRank") == "Peasant", p3:GetAttribute("KingdomRank"))
local stored = Mock.Stores["KingdomPlayers_v1"].data["Player_103"]
check("death reset saved immediately", stored and stored.Data and stored.Data.XP.Job == 0 and stored.Data.Lifetime.Deaths == 1, stored and stored.Data and stored.Data.XP.Job)
check("lifetime XP kept", Data:Get(p3).Lifetime.XPEarned >= caraXP)
check("death screen sent", #Mock.effectsFor(p3, "Death") == 1)
Sched.run(10)
check("respawned after save", p3.Character ~= nil and p3.Character:FindFirstChildOfClass("Humanoid").Health > 0)

---------------------------------------------------------------------------
-- Leave & rejoin keeps data (and the death reset)
---------------------------------------------------------------------------
section("Leave & rejoin")
local bobXP = XP:GetTotal(p2)
Mock.removePlayer(p2)
Sched.run(3)
local bobRecord = Mock.Stores["KingdomPlayers_v1"].data["Player_102"]
check("Bob saved on leave + lock released", bobRecord and bobRecord.Lock == nil and bobRecord.Data.XP.Job > 0)
local p2b = Mock.addPlayer(102, "Bob")
Sched.run(3)
check("Bob XP restored", XP:GetTotal(p2b) == bobXP, XP:GetTotal(p2b))
check("Bob rejoins at bottom", p2b:GetAttribute("KingdomRank") == "Peasant")

---------------------------------------------------------------------------
-- Market & economy
---------------------------------------------------------------------------
section("Market")
Mock.moveTo(p4, market.Position + Vector3.new(0, 3, 0))
Sched.run(1)
local coins = Data:Get(p4).Coins
local buyOk, buyMessage = Mock.action(p4, "Market", "Buy", { resource = "Bread", amount = 1 })
check("bought bread", buyOk and Inventory:Count(p4, "Bread") == 1 and Data:Get(p4).Coins < coins, buyMessage)
local view = Mock.query(p4, "Market")
check("market view", type(view) == "table" and view.AtMarket == true)
local eatOk = Mock.action(p4, "Food", "Eat", { item = "Bread" })
check("ate bread", eatOk and Inventory:Count(p4, "Bread") == 0)

---------------------------------------------------------------------------
-- Admin simulations & queries don't error
---------------------------------------------------------------------------
section("Admin & queries")
for _, command in ipairs({ "hierarchy", "sim foodshortage", "sim meeting KingdomMeeting", "endmeetings", "sim crisis", "settime 11.9", "weather Rain 1", "event HarvestFestival", "repairall", "damage Mine 30", "spawn Wood 50", "sim restart", "bot clear" }) do
	local cmdOk, cmdMessage = Mock.action(p1, "Admin", "Run", { command = command })
	check("admin " .. command, cmdOk, cmdMessage)
	Sched.run(1)
end
local errorsBefore = #Mock.Errors
for _, queryName in ipairs({ "PromotionQueue", "Dashboard", "WorkOrders", "Government", "Meetings", "Career", "Store", "JobStatus", "Discipline", "AdminInfo", "StateSnapshot", "Market" }) do
	local result = Mock.query(p1, queryName, {})
	check("query " .. queryName, result ~= nil)
end
check("no errors from queries", #Mock.Errors == errorsBefore)
local unknownOk, unknownMessage = Mock.action(p4, "Admin", "Nonexistent", {})
check("unknown remote action refused", unknownOk == false and unknownMessage == "Unknown action.", unknownMessage)
local spamRefused = false
for _ = 1, 40 do
	local spamOk, spamMessage = Mock.action(p4, "Food", "Eat", { item = "Bread" })
	if not spamOk and spamMessage == "Slow down." then
		spamRefused = true
		break
	end
end
check("remote spam is rate limited", spamRefused)

---------------------------------------------------------------------------
-- A full in-game day of simulation (ticks, paydays, decay, events)
---------------------------------------------------------------------------
section("Full day")
local errors = #Mock.Errors
for _ = 1, 45 * 6 do
	for _, p in ipairs(Mock.Players:GetPlayers()) do
		wiggle(p)
	end
	Sched.run(10)
end
check("a full day ran without runtime errors", #Mock.Errors == errors, #Mock.Errors - errors)
local Kingdom = svc("KingdomService")
Mock.print(string.format("  stage=%s stability=%.2f morale=%.1f treasury=%d", Kingdom:GetStage(), Kingdom:GetStability(), Kingdom:GetMorale(), svc("EconomyService"):GetTreasury()))

---------------------------------------------------------------------------
-- Shutdown saves
---------------------------------------------------------------------------
section("Shutdown")
for _, handler in ipairs(Mock.CloseHandlers or {}) do
	task.spawn(handler)
end
Sched.run(30)
local dan = Mock.Stores["KingdomPlayers_v1"].data["Player_104"]
check("shutdown saved + unlocked", dan and dan.Lock == nil, dan and dan.Lock and (dan.Lock.Job .. " " .. tostring(dan.Lock.Time) .. " now " .. os.time()))
if not (dan and dan.Lock == nil) then
	for _, k in ipairs(Mock.Kicks) do
		Mock.print("    kick: " .. k.player.Name .. " " .. tostring(k.message))
	end
	Mock.print("    p4 parent: " .. tostring(p4.Parent))
end

finish("Scenario 1")
