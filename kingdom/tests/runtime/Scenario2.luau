--[[
	Runtime scenario 2: guard duty, construction, work orders, meetings,
	the Senate, discipline, duplicate protection, crafting, events, player
	listings, death loot, safe mode and session locks.
]]

local warehouse = part("Warehouse", Vector3.new(0, 2, 0), Vector3.new(10, 4, 10), { "KingdomStorage" }, { StorageType = "Food,General,Ore,Armory,Medical,Water", Capacity = 20000 })
local kitchen = part("Kitchen", Vector3.new(20, 2, 20), Vector3.new(6, 4, 6), { "KingdomKitchen" })
local post = part("NorthGate", Vector3.new(100, 2, 100), nil, { "KingdomGuardPost" })
local towerA = part("TowerA", Vector3.new(110, 2, 100), nil, { "KingdomPatrolPoint" })
local towerB = part("TowerB", Vector3.new(100, 2, 115), nil, { "KingdomPatrolPoint" })
local site = part("Bridge", Vector3.new(70, 2, 70), Vector3.new(8, 2, 8), { "KingdomConstruction" }, { ProjectName = "Stone Bridge", RequiredWood = 4, RequiredStone = 2, WorkRequired = 2, AutoApproved = true })
part("CouncilChamber", Vector3.new(-100, 2, -100), Vector3.new(30, 10, 30), { "KingdomMeetingRoom" }, { MeetingID = "*" })
part("Seat1", Vector3.new(-100, 2, -95), nil, { "KingdomMeetingSpawn" }, { MeetingID = "RoyalCouncil" })
local pier = part("Pier", Vector3.new(0, 0, -80), Vector3.new(6, 1, 6), { "KingdomFishing" })
local market = part("MarketSquare", Vector3.new(30, 2, -30), Vector3.new(10, 2, 10), { "KingdomMarket" })

section("Boot")
Mock.boot()
Sched.run(2)
local Data, XP, Jobs, Inventory = svc("DataService"), svc("XPService"), svc("JobService"), svc("InventoryService")
local Economy, Permission = svc("EconomyService"), svc("PermissionService")

local alice = Mock.addPlayer(301, "Alice")
local bob = Mock.addPlayer(302, "Bob")
local cara = Mock.addPlayer(303, "Cara")
local dan = Mock.addPlayer(304, "Dan")
Sched.run(3)
local everyone = { alice, bob, cara, dan }
local function tick(seconds, keepActive)
	local steps = math.max(1, math.floor(seconds / 5))
	for _ = 1, steps do
		if keepActive ~= false then
			for _, p in ipairs(everyone) do
				wiggle(p)
			end
		end
		Sched.run(seconds / steps)
	end
end
local function admin(command)
	local ok, message = Mock.action(alice, "Admin", "Run", { command = command })
	if not ok then
		Mock.print("    admin '" .. command .. "' -> " .. tostring(message))
	end
	return ok, message
end

section("Appointments")
check("setrank King", admin("setrank Alice King"))
check("setrank Council", admin("setrank Bob RoyalCouncil"))
check("setrank Duke", admin("setrank Dan Duke"))
check("setrank Guard", admin("setrank Cara Guard"))
Sched.run(1)
check("ranks applied", alice:GetAttribute("KingdomRank") == "King" and bob:GetAttribute("KingdomRank") == "RoyalCouncil" and dan:GetAttribute("KingdomRank") == "Duke" and cara:GetAttribute("KingdomRank") == "Guard")
local full, err2 = admin("setrank Cara King")
check("setrank refuses a full rank", not full, err2)

---------------------------------------------------------------------------
section("Meeting: teleport, attendance, reward")
check("set time 7:45", admin("settime 7.75"))
local meetingStarted = false
for _ = 1, 90 do
	tick(1)
	if alice.Character.HumanoidRootPart.Position.X < -80 then
		meetingStarted = true
		break
	end
end
check("required King teleported to the meeting", meetingStarted, alice.Character.HumanoidRootPart.Position)
check("required Council teleported too", bob.Character.HumanoidRootPart.Position.X < -80)
check("Guard (not invited) not teleported", cara.Character.HumanoidRootPart.Position.X > -80)
local leadershipBefore = Data:Get(alice).XP.Leadership
tick(200)
check("attendance recorded", Data:Get(alice).Attendance.Attended == 1, Data:Get(alice).Attendance.Attended)
check("meeting XP awarded (Leadership)", Data:Get(alice).XP.Leadership > leadershipBefore)

---------------------------------------------------------------------------
section("Guard duty")
Mock.moveTo(cara, post.Position + Vector3.new(0, 3, 2))
Sched.run(6)
Mock.firePrompt(Mock.findPrompt(post, "Begin watch"), cara, 1.6)
check("on duty", cara:GetAttribute("KingdomOnDuty") == true)
check("guards counted for security", Jobs:GetGuardsOnDuty() == 1)
local guardXP = XP:GetTotal(cara)
Mock.moveTo(cara, towerA.Position + Vector3.new(0, 3, 2))
Sched.run(2)
Mock.firePrompt(Mock.findPrompt(towerA, "Check post"), cara, 1.6)
check("patrol checkpoint XP", XP:GetTotal(cara) > guardXP, XP:GetTotal(cara))
Mock.moveTo(cara, towerB.Position + Vector3.new(0, 3, 2))
Sched.run(2)
local firstCheckpoint = XP:GetTotal(cara) - guardXP
local beforeCircuit = XP:GetTotal(cara)
Mock.firePrompt(Mock.findPrompt(towerB, "Check post"), cara, 1.6)
-- (performance tier varies with hunger, so compare against the first point)
check("circuit bonus", XP:GetTotal(cara) - beforeCircuit > firstCheckpoint * 2, XP:GetTotal(cara) - beforeCircuit)
Mock.moveTo(cara, post.Position + Vector3.new(0, 3, 2))
local called = false
for _ = 1, 130 do
	Sched.run(1)
	wiggle(cara)
	for _, effect in ipairs(Mock.effectsFor(cara, "WatchCheck")) do
		if effect.Active then
			called = true
		end
	end
	if called then
		break
	end
end
check("watch call issued", called)
local beforeAnswer = XP:GetTotal(cara)
Mock.firePrompt(Mock.findPrompt(post, "Begin watch"), cara, 1.6)
check("watch call answered for XP", XP:GetTotal(cara) > beforeAnswer)

---------------------------------------------------------------------------
section("Construction")
admin("give Bob Wood 4")
admin("give Bob Stone 2")
admin("tool Bob Hammer")
Mock.moveTo(bob, site.Position + Vector3.new(0, 3, 2))
Sched.run(6)
Mock.firePrompt(Mock.findPrompt(site, "Deliver materials"), bob, 1.6)
check("materials delivered", Inventory:Count(bob, "Wood") == 0 and Inventory:Count(bob, "Stone") == 0)
Mock.firePrompt(Mock.findPrompt(site, "Build"), bob, 4.2)
Sched.run(1)
Mock.firePrompt(Mock.findPrompt(site, "Build"), bob, 4.2)
check("project completed", site:GetAttribute("ProjectState") == "Completed", site:GetAttribute("ProjectState"))

---------------------------------------------------------------------------
section("Work order (anti-farm: manager XP needs 2+ contributors)")
local created, createMessage = Mock.action(alice, "Management", "CreateOrder", { department = "Fishing", objective = "Tasks", job = "Fishing", target = 5, workers = 3, hours = 4, priority = "High" })
check("order created", created, createMessage)
local orders = Mock.query(dan, "WorkOrders")
local order = orders and orders[1]
check("order visible", order ~= nil)
local accepted, acceptMessage = Mock.action(dan, "Management", "AcceptOrder", { order = order and order.Id })
check("order accepted", accepted, acceptMessage)
admin("tool Dan FishingRod")
Mock.moveTo(dan, pier.Position + Vector3.new(0, 3, 2))
Sched.run(6)
local function fishOnce(p)
	local cut = #Mock.effectsFor(p, "FishingBite")
	Mock.firePrompt(Mock.findPrompt(pier, "Cast"), p, 0.7)
	for _ = 1, 120 do
		Sched.run(0.1)
		local bites = Mock.effectsFor(p, "FishingBite")
		if #bites > cut then
			local bite = bites[#bites]
			return Mock.action(p, "Job", "Interact", { station = bite.Station, action = "Reel", session = bite.Session })
		end
	end
	return false
end
local contributionBefore = Data:Get(dan).XP.Contribution
for _ = 1, 5 do
	fishOnce(dan)
	Sched.run(1)
end
check("worker rewarded on completion", Data:Get(dan).XP.Contribution > contributionBefore, Data:Get(dan).XP.Contribution)
check("manager not paid for a one-worker order", Data:Get(alice).XP.Management == 0, Data:Get(alice).XP.Management)
check("order stats recorded", Data:Get(alice).ManagementStats.OrdersCompleted == 1)

---------------------------------------------------------------------------
section("Senate")
local proposed, proposeMessage = Mock.action(alice, "Government", "Propose", { type = "SetTax", params = { tax = "Income", rate = 0.15 } })
check("proposal opened", proposed, proposeMessage)
local gov = Mock.query(bob, "Government")
local proposal = gov and gov.Proposals and gov.Proposals[1]
check("proposal listed", proposal ~= nil)
for _, voter in ipairs({ bob, dan, alice }) do
	local voted, voteMessage = Mock.action(voter, "Government", "Vote", { proposal = proposal and proposal.Id, yes = true })
	check(voter.Name .. " voted", voted, voteMessage)
end
Sched.run(1)
check("tax changed by vote", math.abs(Economy:GetTax("Income") - 0.15) < 1e-6, Economy:GetTax("Income"))
local demoted, demoteMessage = Mock.action(alice, "Government", "Demote", { target = dan.UserId, reason = "Neglected the mines" })
check("King demotes Duke", demoted and dan:GetAttribute("KingdomRank") == "Lord", demoteMessage)
local noReason = Mock.action(alice, "Government", "Demote", { target = bob.UserId, reason = "" })
check("demotion needs a reason", noReason == false)
local appointed, appointMessage = Mock.action(alice, "Government", "Appoint", { target = cara.UserId, rank = "Sergeant" })
check("appoint into empty slot", appointed and cara:GetAttribute("KingdomRank") == "Sergeant", appointMessage)

---------------------------------------------------------------------------
section("Discipline")
check("warn", (Mock.action(alice, "Discipline", "Warn", { target = bob.UserId, reason = "Late to the council" })))
check("warning stored", #Data:Get(bob).Discipline.Warnings == 1)
local bobCoins = Data:Get(bob).Coins
check("fine", (Mock.action(alice, "Discipline", "Fine", { target = bob.UserId, amount = 5, reason = "Late to the council" })))
check("fine deducted (capped)", Data:Get(bob).Coins < bobCoins)
check("suspend", (Mock.action(alice, "Discipline", "Suspend", { target = bob.UserId, minutes = 30, reason = "Repeated lateness" })))
check("suspension removes job permissions", not Permission:Has(bob, "Job.Basic"))
local selfWarn = Mock.action(bob, "Discipline", "Warn", { target = alice.UserId, reason = "Revenge warning" })
check("cannot discipline a superior", selfWarn == false)

---------------------------------------------------------------------------
section("Duplicate action protection")
local remote = Mock.remote("Action")
local results = {}
for i = 1, 2 do
	task.spawn(function()
		results[i] = table.pack(remote.OnServerInvoke(dan, "Department", "Join", { department = "Mining" }, "same-action-id-1"))
	end)
	Sched.run(0.5)
end
check("first request processed", results[1] and results[1][1] == true)
check("replay refused", results[2] and results[2][1] == false and results[2][2] == "Already processed.", results[2] and results[2][2])

---------------------------------------------------------------------------
section("Crafting from storage")
admin("spawn Meat 40")
admin("spawn Vegetables 40")
Mock.moveTo(dan, kitchen.Position + Vector3.new(0, 3, 2))
Sched.run(6)
local cookCut = #Mock.ClientEvents
Mock.firePrompt(Mock.findPrompt(kitchen, "Meat Stew"), dan, 5.2)
for _, note in ipairs(Mock.notificationsFor(dan, cookCut)) do
	if note.Kind == "Warning" then
		Mock.print("    note: " .. tostring(note.Text))
	end
end
check("cooked meals", Inventory:Count(dan, "Meal") >= 1, Inventory:Count(dan, "Meal"))

---------------------------------------------------------------------------
section("Event objective")
check("start food shortage", admin("event FoodShortage"))
Mock.moveTo(dan, warehouse.Position + Vector3.new(0, 3, 0))
Sched.run(6)
local meals = Inventory:Count(dan, "Meal")
Mock.firePrompt(Mock.findPrompt(warehouse, "Deposit"), dan, 1.3)
local Events = svc("EventService")
local progress = 0
for _, run in pairs(Events._active) do
	for _, objective in ipairs(run.objectives) do
		progress += objective.Progress
	end
end
check("delivery advanced event objective", meals > 0 and progress >= meals, progress)

---------------------------------------------------------------------------
section("Player listings")
admin("give Dan Fish 1")
Mock.moveTo(dan, market.Position + Vector3.new(0, 3, 0))
Mock.moveTo(cara, market.Position + Vector3.new(2, 3, 0))
Sched.run(2)
local listed, listMessage = Mock.action(dan, "Market", "List", { resource = "Fish", amount = 1, price = 10 })
check("listed", listed, listMessage)
check("listing escrowed", Inventory:Count(dan, "Fish") == 0 and next(Data:Get(dan).Escrow) ~= nil)
local view = Mock.query(cara, "Market")
local listing = view and view.Listings and view.Listings[1]
local danCoins = Data:Get(dan).Coins
local bought, buyMessage = Mock.action(cara, "Market", "BuyListing", { listing = listing and listing.Id })
check("bought listing", bought and Inventory:Count(cara, "Fish") == 1, buyMessage)
check("seller paid", Data:Get(dan).Coins > danCoins)
check("escrow cleared", next(Data:Get(dan).Escrow) == nil)

---------------------------------------------------------------------------
section("Death drops carried goods as a recoverable sack")
admin("give Dan Wood 3")
admin("kill Dan")
Sched.run(2)
local sack
for _, desc in ipairs(workspace:GetChildren()) do
	if desc.Name == "LootSack" then
		sack = desc
	end
end
check("loot sack dropped", sack ~= nil)
check("dead Duke's slot cascaded / reset", dan:GetAttribute("KingdomRank") == "Peasant")
if sack then
	Mock.moveTo(cara, sack.Position + Vector3.new(0, 2, 0))
	Sched.run(1)
	Mock.firePrompt(Mock.findPrompt(sack, "Pick up"), cara, 1)
	check("another player recovered the goods", Inventory:Count(cara, "Wood") >= 3)
end

---------------------------------------------------------------------------
section("Safe mode when the archive is down")
local store = Mock.Stores["KingdomPlayers_v1"]
local realUpdate = store.UpdateAsync
local archiveDown = true
store.UpdateAsync = function(self, key, transform)
	if archiveDown and key == "Player_305" then
		error("DataStore request failed (mock outage)")
	end
	return realUpdate(self, key, transform)
end
local eve = Mock.addPlayer(305, "Eve")
Sched.run(60)
check("eve in safe mode", Data:IsSafeMode(eve))
local safeOk, safeMessage = Mock.action(eve, "Department", "Join", { department = "Mining" })
check("progression refused in safe mode", safeOk == false and string.find(tostring(safeMessage), "unavailable") ~= nil, safeMessage)
check("nothing saved for eve", store.data["Player_305"] == nil)
archiveDown = false
Sched.run(40)
check("eve recovered", Data:IsLoaded(eve) and not Data:IsSafeMode(eve))
check("eve placed in hierarchy", eve:GetAttribute("KingdomRank") == "Peasant")

---------------------------------------------------------------------------
section("Session lock held by another server")
store.data["Player_306"] = { Lock = { Job = "other-server", Time = os.time() }, Data = { UserId = 306 } }
local frank = Mock.addPlayer(306, "Frank")
Sched.run(60)
local kicked = false
for _, entry in ipairs(Mock.Kicks) do
	if entry.player == frank and string.find(entry.message, "another server") then
		kicked = true
	end
end
check("locked profile not loaded twice (player asked to rejoin)", kicked)
check("other server's data untouched", store.data["Player_306"].Lock.Job == "other-server")

finish("Scenario 2")
