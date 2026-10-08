--[[
	KingdomService
	The living-kingdom simulation: needs, stability, stage and morale.

	Every few in-game minutes it measures each need (0..1) from real state:
	stored food, water, tools, weapons, medicine, fuel and materials, guards
	on duty, houses, tool condition. Stability is their weighted average.

	The stage moves at most ONE step per evaluation, so the kingdom never
	collapses because of one bad moment:
	  Healthy -> Stable -> Strained -> Critical -> Crisis -> Collapse
	and climbs out of Crisis/Collapse through Recovery.

	Morale drifts with the stage, food, unpaid wages, taxes and security.
	Productivity (used for every job yield) = stage x morale x tax effect.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local EconomyConfig = require(ReplicatedStorage.Kingdom.Config.EconomyConfig)
local FoodConfig = require(ReplicatedStorage.Kingdom.Config.FoodConfig)
local KingdomConfig = require(ReplicatedStorage.Kingdom.Config.KingdomConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)

local KingdomService = {
	Name = "KingdomService",
	Dependencies = {
		"ResourceService",
		"FoodService",
		"BuildingService",
		"TimeService",
		"EconomyService",
		"StateService",
		"NotificationService",
		"InventoryService",
		"AuditService",
		"DataService",
	},
}

local RECOVERY_FROM_INDEX = 5 -- Crisis
local STABLE_INDEX = 2

function KingdomService:Init()
	self._resources = self:Use("ResourceService")
	self._food = self:Use("FoodService")
	self._buildings = self:Use("BuildingService")
	self._time = self:Use("TimeService")
	self._economy = self:Use("EconomyService")
	self._state = self:Use("StateService")
	self._notify = self:Use("NotificationService")
	self._inventory = self:Use("InventoryService")
	self._audit = self:Use("AuditService")
	self._data = self:Use("DataService")

	self.StageChanged = Signal.new("StageChanged") -- (newId, oldId)
	self.Evaluated = Signal.new("KingdomEvaluated") -- (snapshot)

	self._needs = {}
	for id in pairs(KingdomConfig.Needs) do
		self._needs[id] = 0.75
	end
	self._stageIndex = STABLE_INDEX
	self._recovering = false
	self._stability = 0.7
	self._morale = KingdomConfig.Morale.Start
	self._securityProvider = nil
	self._securityBonus = 0
	self._needOverrides = {} -- testing / events: [need] = { value, untilMinute }
	self._minutes = 0

	self._economy:SetRevenueModifier(function()
		return 0.4 + 0.8 * self._stability
	end)
	self._food:SetSicknessChanceProvider(function()
		local chance = FoodConfig.Sickness.BaseChancePerHour
		if (self._needs.Medicine or 1) < 0.3 then
			chance *= 3
		end
		return chance + (self._outbreakChance or 0)
	end)

	self._time.MinuteChanged:Connect(function()
		self._minutes += 1
		if self._minutes % KingdomConfig.EvaluateEveryGameMinutes == 0 then
			self:Evaluate()
		end
	end)
end

function KingdomService:Start()
	self:Evaluate()
end

-- Providers (registered by higher services; avoids circular dependencies) -----

-- fn() -> guardsOnDuty
function KingdomService:SetSecurityProvider(fn: () -> number)
	self._securityProvider = fn
end

function KingdomService:SetOutbreakChance(chance: number)
	self._outbreakChance = chance
end

function KingdomService:AddSecurityBonus(delta: number)
	self._securityBonus = math.clamp(self._securityBonus + delta, -0.6, 0.4)
end

function KingdomService:AddMorale(delta: number, reason: string)
	local old = self._morale
	self._morale = math.clamp(self._morale + delta, 0, 100)
	self._audit:Log("System", "Morale", { from = math.floor(old), to = math.floor(self._morale), reason = reason })
	self:_publish()
end

-- Testing tools: force a need for a number of in-game minutes.
function KingdomService:OverrideNeed(need: string, value: number, minutes: number)
	if KingdomConfig.Needs[need] then
		self._needOverrides[need] = { value = math.clamp(value, 0, 1), untilMinute = self._time:GetAbsoluteMinutes() + minutes }
	end
end

-- Measurement ------------------------------------------------------------------------

local function ratio(have: number, want: number): number
	if want <= 0 then
		return 1
	end
	return math.clamp(have / want, 0, 1)
end

function KingdomService:_stockSum(resources: { string }): number
	local total = 0
	for _, id in ipairs(resources) do
		total += self._resources:GetStock(id)
	end
	return total
end

function KingdomService:_averageToolCondition(): number
	local sum, count = 0, 0
	for _, player in ipairs(Players:GetPlayers()) do
		local profile = self._data:Get(player)
		if profile then
			for _, tool in pairs(profile.Inventory.Tools) do
				sum += tool.Durability / math.max(tool.Max, 1)
				count += 1
			end
		end
	end
	return count > 0 and sum / count or 1
end

function KingdomService:_measure()
	local targets = KingdomConfig.NeedTargets
	local players = #Players:GetPlayers()
	local pop = math.max(players, KingdomConfig.MinPopulationForNeeds)
	local needs = {}

	local food = FoodConfig.Kingdom
	local perHour = food.BaseConsumptionPerHour + food.PerPlayerConsumptionPerHour * pop
	needs.Food = ratio(self._resources:GetNutritionStock(), perHour * food.ReserveHours)
	if self._food:GetShortfall() > 0 then
		needs.Food = math.min(needs.Food, 0.1)
	end

	needs.Water = ratio(self._resources:GetStock(targets.Water.Resource), targets.Water.PerPlayer * pop)

	local houses = self._buildings:CountOfType("House", 0)
	needs.Housing = houses == 0 and 1 or ratio(houses * targets.Housing.PerHouse, math.max(players, 1))

	local guards = 0
	if self._securityProvider then
		local ok, value = pcall(self._securityProvider)
		guards = ok and value or 0
	end
	local neededGuards = math.max(targets.Security.MinimumGuards, math.ceil(pop / targets.Security.PlayersPerGuard))
	needs.Security = math.clamp(ratio(guards, neededGuards) * 0.8 + 0.2 + self._securityBonus, 0, 1)

	local toolStock = ratio(self._resources:GetStock(targets.Tools.Resource), targets.Tools.PerPlayer * pop)
	local weight = targets.Tools.ToolConditionWeight
	needs.Tools = toolStock * (1 - weight) + self:_averageToolCondition() * weight

	needs.Weapons = ratio(self._resources:GetStock(targets.Weapons.Resource), math.max(targets.Weapons.Minimum, neededGuards * targets.Weapons.PerGuard))
	needs.Medicine = ratio(self._resources:GetStock(targets.Medicine.Resource), targets.Medicine.PerPlayer * pop)
	needs.Fuel = ratio(self:_stockSum(targets.Fuel.Resources), targets.Fuel.PerPlayer * pop)
	needs.Materials = ratio(self:_stockSum(targets.Materials.Resources), targets.Materials.PerPlayer * pop)

	local nowMinute = self._time:GetAbsoluteMinutes()
	for need, override in pairs(self._needOverrides) do
		if override.untilMinute > nowMinute then
			needs[need] = override.value
		else
			self._needOverrides[need] = nil
		end
	end
	return needs, guards
end

local function stageIndexFor(stability: number): number
	for index, stage in ipairs(KingdomConfig.Stages) do
		if stability >= stage.MinStability then
			return index
		end
	end
	return #KingdomConfig.Stages
end

function KingdomService:Evaluate()
	local needs, guards = self:_measure()
	self._needs = needs
	self._guards = guards

	local weighted, totalWeight = 0, 0
	for id, def in pairs(KingdomConfig.Needs) do
		weighted += (needs[id] or 0) * def.Weight
		totalWeight += def.Weight
	end
	self._stability = totalWeight > 0 and weighted / totalWeight or 1

	-- Stage: one step at a time.
	local oldStage = self:GetStage()
	local target = stageIndexFor(self._stability)
	if self._recovering then
		if target <= STABLE_INDEX then
			self._recovering = false
			self._stageIndex = STABLE_INDEX
		elseif target >= RECOVERY_FROM_INDEX + 1 then
			self._recovering = false
			self._stageIndex = RECOVERY_FROM_INDEX
		end
	elseif target > self._stageIndex then
		self._stageIndex += 1
	elseif target < self._stageIndex then
		if self._stageIndex >= RECOVERY_FROM_INDEX then
			self._recovering = true
		else
			self._stageIndex -= 1
		end
	end
	local newStage = self:GetStage()

	-- Morale drift.
	local morale = KingdomConfig.Morale
	local stageDef = self:GetStageDef()
	local drift = stageDef.MoraleDrift
	drift += ((needs.Food or 0) - 0.5) * 10 * morale.FoodWeight
	drift += ((needs.Security or 0) - 0.5) * 10 * morale.SecurityWeight
	local unpaid = self._economy:TakeUnpaidWages()
	if unpaid > 0 then
		drift -= morale.UnpaidWagePenalty
	end
	local above = self._economy:GetTaxBurden()
	drift -= above * EconomyConfig.MoralePerPointAbove * 0.25
	if self._economy:GetTreasury() < EconomyConfig.Treasury.LowThreshold then
		drift -= 0.5
	end
	self._morale = math.clamp(self._morale + math.clamp(drift, -6, 6), 0, 100)
	self._securityBonus *= 0.9

	if newStage ~= oldStage then
		self:_announceStage(newStage, oldStage)
		self.StageChanged:Fire(newStage, oldStage)
	end
	self:_publish()
	self.Evaluated:Fire(self:GetSnapshot())
end

function KingdomService:_announceStage(newStage: string, oldStage: string)
	self._audit:Log("System", "StageChanged", { from = oldStage, to = newStage })
	local messages = {
		Healthy = "The kingdom thrives!",
		Stable = "The kingdom is stable.",
		Strained = "The kingdom is strained. Check food and supplies.",
		Critical = "The kingdom is in a CRITICAL state! Leaders must act.",
		Crisis = "CRISIS! Workers are suffering and production is failing.",
		Collapse = "The kingdom is COLLAPSING. Every hand is needed to recover.",
		Recovery = "The kingdom has begun to recover.",
	}
	local worse = { Strained = true, Critical = true, Crisis = true, Collapse = true }
	self._notify:Announce(worse[newStage] and "Critical" or "Success", "Kingdom: " .. string.upper(newStage), messages[newStage] or "")
	-- Specific food warning, as players expect it called out.
	if (self._needs.Food or 1) < 0.25 then
		self._notify:Announce("Critical", "Food Supply CRITICAL", "The Kingdom Food Supply has reached CRITICAL.")
	end
end

-- Accessors ---------------------------------------------------------------------------

function KingdomService:GetStageDef()
	if self._recovering then
		return KingdomConfig.RecoveryStage
	end
	return KingdomConfig.Stages[self._stageIndex]
end

function KingdomService:GetStage(): string
	return self:GetStageDef().Id
end

function KingdomService:GetNeeds()
	return table.clone(self._needs)
end

function KingdomService:GetNeed(need: string): number
	return self._needs[need] or 1
end

function KingdomService:GetStability(): number
	return self._stability
end

function KingdomService:GetMorale(): number
	return self._morale
end

function KingdomService:GetProductivity(): number
	local morale = KingdomConfig.Morale
	local stage = self:GetStageDef().Productivity
	local moraleFactor = morale.LowProductivity + (morale.HighProductivity - morale.LowProductivity) * (self._morale / 100)
	local above, below = self._economy:GetTaxBurden()
	local taxFactor = 1 + below * EconomyConfig.ProductivityPerPointBelow - above * EconomyConfig.ProductivityPerPointBelow
	return math.clamp(stage * moraleFactor * taxFactor, 0.2, 1.5)
end

function KingdomService:GetSnapshot()
	local needs = {}
	for id, def in pairs(KingdomConfig.Needs) do
		needs[id] = { Name = def.DisplayName, Value = self._needs[id] or 0 }
	end
	local stageDef = self:GetStageDef()
	return {
		Needs = needs,
		Stability = self._stability,
		Stage = stageDef.Id,
		StageColor = stageDef.Color,
		Morale = self._morale,
		Productivity = self:GetProductivity(),
		Population = #Players:GetPlayers(),
		Guards = self._guards or 0,
	}
end

function KingdomService:_publish()
	self._state:SetGlobal("Kingdom", self:GetSnapshot())
end

return KingdomService
