--[[
	TestingService (developer test mode)
	Enabled in Studio (GameConfig.TestingMode.EnabledInStudio) or explicitly
	for live test servers. Never available to normal players: every entry
	point is called from AdminService, which checks admin permission.

	Bots are simulated hierarchy members (negative ids) so one developer can
	test vacancies and cascades alone. They live only in a server-scoped
	hierarchy and are never saved.

	Simulations: xp, promotion, demotion, food shortage, meeting, server
	restart (hierarchy rebuild), player leaving, rank vacancy, full cascade,
	economic crisis, death.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local HierarchyModel = require(ReplicatedStorage.Kingdom.Shared.HierarchyModel)
local MeetingConfig = require(ReplicatedStorage.Kingdom.Config.MeetingConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)

local TestingService = {
	Name = "TestingService",
	Dependencies = {
		"RankService",
		"PromotionService",
		"XPService",
		"DataService",
		"KingdomService",
		"ResourceService",
		"EconomyService",
		"MeetingService",
		"FoodService",
		"CharacterService",
		"AuditService",
	},
}

function TestingService:Init()
	self._rank = self:Use("RankService")
	self._promotion = self:Use("PromotionService")
	self._xp = self:Use("XPService")
	self._data = self:Use("DataService")
	self._kingdom = self:Use("KingdomService")
	self._resources = self:Use("ResourceService")
	self._economy = self:Use("EconomyService")
	self._meetings = self:Use("MeetingService")
	self._food = self:Use("FoodService")
	self._character = self:Use("CharacterService")
	self._audit = self:Use("AuditService")
	self._nextBot = 0

	local config = GameConfig.TestingMode
	self.Enabled = (RunService:IsStudio() and config.EnabledInStudio) or config.EnabledInLiveServers
	game:GetService("ReplicatedStorage").Kingdom:SetAttribute("TestingMode", self.Enabled)
end

function TestingService:_guard(): (boolean, string?)
	if not self.Enabled then
		return false, "Testing mode is disabled on this server."
	end
	return true, nil
end

-- Bots ---------------------------------------------------------------------------

function TestingService:AddBots(rankId: string, xp: number, count: number)
	local ok, err = self:_guard()
	if not ok then
		return false, err
	end
	if self._rank.IsGlobal then
		return false, "Bots are only allowed in a server-scoped kingdom."
	end
	local rank = RankConfig.Get(rankId)
	if not rank then
		return false, "Unknown rank."
	end
	count = math.clamp(count, 1, GameConfig.TestingMode.MaxBots)
	local placed = 0
	self._rank:Run("TestBots", function(model, state, now)
		local counts = model:CountByRank(state)
		for _ = 1, count do
			if rank.MaxSlots and counts[rank.Id] >= rank.MaxSlots then
				break
			end
			self._nextBot += 1
			local id = tostring(-self._nextBot)
			model:Join(state, id, { xp = xp + math.random(0, 50), name = "Bot" .. self._nextBot }, now)
			state.m[id].r = rank.Id
			state.m[id].t = now - self._nextBot -- deterministic seniority
			counts[rank.Id] += 1
			placed += 1
		end
		return {}
	end)
	return true, string.format("Placed %d bots as %s.", placed, rank.DisplayName)
end

-- Fills every rank with bots (realistic XP spread) for cascade testing.
function TestingService:PopulateKingdom()
	local ok, err = self:_guard()
	if not ok then
		return false, err
	end
	local total = 0
	for _, rank in ipairs(RankConfig.Sorted()) do
		local slots = rank.MaxSlots or 10
		local _, message = self:AddBots(rank.Id, (rank.MinXP or 0) + rank.Order * 1000, math.min(slots, 30))
		total += tonumber(string.match(message or "", "%d+")) or 0
	end
	return true, string.format("Populated the kingdom with %d bots.", total)
end

function TestingService:KillMember(id: string)
	local ok, err = self:_guard()
	if not ok then
		return false, err
	end
	local member = self._rank:GetMember(id)
	if not member then
		return false, "No such member."
	end
	local player = Players:GetPlayerByUserId(tonumber(id) or 0)
	if player then
		self._character:Damage(player, 1e6, "Kingdom event")
		return true, "Killed " .. player.Name
	end
	local from = member.r
	self._rank:Run("TestDeath", function(model, state, now)
		local events = model:ResetLife(state, id, now, "Test")
		for _, event in ipairs(model:Rebalance(state, now)) do
			table.insert(events, event)
		end
		return events
	end)
	return true, string.format("Bot %s (%s) died; cascade applied.", id, from)
end

-- Kills the holder of the top occupied rank (bot or player).
function TestingService:KillTop()
	local sorted = RankConfig.Sorted()
	for index = #sorted, 1, -1 do
		local queue = self._rank:GetQueue(sorted[index].Id)
		if #queue > 0 then
			return self:KillMember(queue[1].id)
		end
	end
	return false, "Nobody to kill."
end

function TestingService:VacateRank(rankId: string)
	local queue = self._rank:GetQueue(rankId)
	for _, entry in ipairs(queue) do
		if tonumber(entry.id) and tonumber(entry.id) < 0 then
			self._rank:Run("TestLeave", function(model, state, now)
				local events = model:Leave(state, entry.id, now, false)
				for _, event in ipairs(model:Rebalance(state, now)) do
					table.insert(events, event)
				end
				return events
			end)
			return true, "A bot left " .. rankId .. "."
		end
	end
	return false, "No bot holds that rank."
end

function TestingService:ClearBots()
	self._rank:Run("TestClear", function(model, state, now)
		local events = {}
		for id in pairs(state.m) do
			if (tonumber(id) or 0) < 0 then
				for _, event in ipairs(model:Leave(state, id, now, false)) do
					table.insert(events, event)
				end
			end
		end
		for _, event in ipairs(model:Rebalance(state, now)) do
			table.insert(events, event)
		end
		return events
	end)
	return true, "Bots removed."
end

-- Simulations ---------------------------------------------------------------------

function TestingService:Simulate(player: Player, name: string, arg: string?)
	local ok, err = self:_guard()
	if not ok then
		return false, err
	end
	self._audit:Log("Admin", "Simulate", { by = player.UserId, sim = name, arg = arg })
	if name == "xp" then
		local amount = tonumber(arg) or 100
		local awarded = self._xp:Award(player, "Job", amount, { raw = true, source = "Test" })
		return true, string.format("+%d XP", awarded)
	elseif name == "promotion" then
		local rank = self._rank:GetRankDef(player)
		local above = self._rank.Model:RankAbove(rank.Id)
		if not above then
			return false, "Already at the top."
		end
		local success, reason = self._promotion:SetRank(player, above.Id, "TestPromotion")
		return success, success and ("Promoted to " .. above.DisplayName) or ("Failed: " .. tostring(reason))
	elseif name == "demotion" then
		local success, reason = self._promotion:Demote(player, { cause = "TestDemotion", block = 0 })
		return success, success and "Demoted." or tostring(reason)
	elseif name == "foodshortage" then
		for resourceId, def in pairs(ResourceConfig.Resources) do
			if def.Category == "Food" then
				self._resources:SetStock(resourceId, 0, "TestFoodShortage")
			end
		end
		self._kingdom:Evaluate()
		return true, "All food removed from storage."
	elseif name == "meeting" then
		local id = arg or (MeetingConfig.Meetings[1] and MeetingConfig.Meetings[1].MeetingID)
		local runId = id and self._meetings:ForceStart(id)
		return runId ~= nil, runId and ("Started " .. id) or "Unknown meeting."
	elseif name == "restart" then
		return self:SimulateRestart()
	elseif name == "leave" then
		self._promotion:OnPlayerLeave(player)
		task.delay(3, function()
			if player.Parent == Players then
				self._promotion:OnPlayerJoin(player)
			end
		end)
		return true, "You left the hierarchy; rejoining in 3 seconds."
	elseif name == "vacancy" then
		return self:VacateRank(arg or "Knight")
	elseif name == "cascade" then
		self:PopulateKingdom()
		task.wait(0.5)
		return self:KillTop()
	elseif name == "crisis" then
		self._economy:TreasuryWithdraw(self._economy:GetTreasury(), "TestCrisis")
		for _, need in ipairs({ "Food", "Water", "Tools", "Security" }) do
			self._kingdom:OverrideNeed(need, 0.05, 120)
		end
		self._kingdom:AddMorale(-60, "TestCrisis")
		for _ = 1, 4 do
			self._kingdom:Evaluate()
		end
		return true, "Treasury emptied, needs crashed; the stage will slide one step per evaluation."
	elseif name == "death" then
		self._character:Damage(player, 1e6, "Kingdom event")
		return true, "You died."
	end
	return false, "Unknown simulation. Try: xp, promotion, demotion, foodshortage, meeting, restart, leave, vacancy, cascade, crisis, death"
end

-- Saves everyone, throws the hierarchy away and rebuilds it from saved data
-- the same way a fresh server would.
function TestingService:SimulateRestart()
	for _, player in ipairs(Players:GetPlayers()) do
		self._data:SaveNow(player, "TestRestart")
	end
	if self._rank.IsGlobal then
		return false, "Global hierarchies persist across restarts by design."
	end
	self._rank.State = HierarchyModel.newState()
	for _, player in ipairs(Players:GetPlayers()) do
		self._rank:ForgetPlayer(player)
		player:SetAttribute("KingdomRank", nil)
	end
	for _, player in ipairs(Players:GetPlayers()) do
		self._promotion:OnPlayerJoin(player)
	end
	return true, "Hierarchy rebuilt from saved data (bots discarded)."
end

return TestingService
