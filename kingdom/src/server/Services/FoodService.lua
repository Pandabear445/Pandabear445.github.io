--[[
	FoodService
	Personal hunger + sickness, kingdom food consumption, mess halls,
	hospitals.

	Chain reaction (gradual, never instant):
	  farmers stop -> stored food falls -> kingdom consumption can't be met
	  -> meals cost more / run out -> players grow hungry (performance
	  penalty) -> starving (bigger penalty) -> sick (slow, weak) ...
	By default starvation never kills (FoodConfig.Hunger.StarvingCanKill).
]]

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DeathConfig = require(ReplicatedStorage.Kingdom.Config.DeathConfig)
local FoodConfig = require(ReplicatedStorage.Kingdom.Config.FoodConfig)
local JobConfig = require(ReplicatedStorage.Kingdom.Config.JobConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)
local PromptUtil = require(script.Parent.Parent.Core.PromptUtil)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local FoodService = {
	Name = "FoodService",
	Dependencies = {
		"DataService",
		"ResourceService",
		"TimeService",
		"CharacterService",
		"InventoryService",
		"NotificationService",
		"StateService",
		"EconomyService",
		"RankService",
		"WeatherService",
		"AuditService",
		"ActivityService",
	},
}

local HUNGER_TICK_MINUTES = 5

function FoodService:Init()
	self._data = self:Use("DataService")
	self._resources = self:Use("ResourceService")
	self._time = self:Use("TimeService")
	self._character = self:Use("CharacterService")
	self._inventory = self:Use("InventoryService")
	self._notify = self:Use("NotificationService")
	self._state = self:Use("StateService")
	self._economy = self:Use("EconomyService")
	self._rank = self:Use("RankService")
	self._weather = self:Use("WeatherService")
	self._audit = self:Use("AuditService")
	self._activity = self:Use("ActivityService")

	self.Ate = Signal.new("Ate") -- (player, resourceId, source)
	self.BecameSick = Signal.new("BecameSick")
	self._mealsToday = {}
	self._lastMeal = {}
	self._shortfall = 0
	self._sicknessChance = nil
	self._minuteCounter = 0

	self._character:RegisterSpeedModifier("Sickness", function(player)
		local profile = self._data:Get(player)
		return (profile and profile.Sick) and FoodConfig.Sickness.WalkSpeedMultiplier or 1
	end)

	self._data.Loaded:Connect(function(player)
		self:_publish(player)
	end)
	Players.PlayerRemoving:Connect(function(player)
		self._mealsToday[player] = nil
		self._lastMeal[player] = nil
	end)

	self._time.MinuteChanged:Connect(function()
		self._minuteCounter += 1
		if self._minuteCounter % HUNGER_TICK_MINUTES == 0 then
			self:_hungerTick(HUNGER_TICK_MINUTES)
		end
	end)
	self._time.HourChanged:Connect(function()
		self:_kingdomConsumption()
		self:_sicknessTick()
	end)
	self._time.DayStarted:Connect(function()
		self._mealsToday = {}
	end)

	Net.Action("Food", "Eat", { rate = 1, burst = 2 }, function(player, payload)
		local itemId = Check.key(payload.item, ResourceConfig.Resources)
		if not itemId or not ResourceConfig.IsFood(itemId) then
			return false, "That isn't food."
		end
		return self:EatFromInventory(player, itemId)
	end)
end

function FoodService:Start()
	for _, tag in ipairs(FoodConfig.MessHall.Tags) do
		for _, marker in ipairs(CollectionService:GetTagged(tag)) do
			self:_setupMessHall(marker)
		end
		CollectionService:GetInstanceAddedSignal(tag):Connect(function(marker)
			self:_setupMessHall(marker)
		end)
	end
	for _, tag in ipairs(FoodConfig.Hospital.Tags) do
		for _, marker in ipairs(CollectionService:GetTagged(tag)) do
			self:_setupHospital(marker)
		end
		CollectionService:GetInstanceAddedSignal(tag):Connect(function(marker)
			self:_setupHospital(marker)
		end)
	end
end

-- Hunger ---------------------------------------------------------------------------

function FoodService:GetHunger(player: Player): number
	local profile = self._data:Get(player)
	return profile and profile.Hunger or FoodConfig.Hunger.Max
end

function FoodService:IsSick(player: Player): boolean
	local profile = self._data:Get(player)
	return profile ~= nil and profile.Sick == true
end

function FoodService:GetCondition(player: Player): string
	local hunger = self:GetHunger(player)
	if hunger <= FoodConfig.Hunger.StarvingThreshold then
		return "Starving"
	elseif hunger <= FoodConfig.Hunger.HungryThreshold then
		return "Hungry"
	end
	return "Fed"
end

-- Penalty applied to job performance score.
function FoodService:GetPerformancePenalty(player: Player): number
	local penalty = 0
	local condition = self:GetCondition(player)
	if condition == "Starving" then
		penalty += JobConfig.Performance.StarvingPenalty
	elseif condition == "Hungry" then
		penalty += JobConfig.Performance.HungryPenalty
	end
	if self:IsSick(player) then
		penalty += JobConfig.Performance.SickPenalty
	end
	return penalty
end

function FoodService:AddHunger(player: Player, delta: number)
	local profile = self._data:Get(player)
	if not profile then
		return
	end
	local before = self:GetCondition(player)
	profile.Hunger = math.clamp(profile.Hunger + delta, 0, FoodConfig.Hunger.Max)
	local after = self:GetCondition(player)
	if before ~= after and delta < 0 then
		if after == "Hungry" then
			self._notify:Notify(player, "Warning", "You are hungry", "Eat at a mess hall or tavern. Hunger lowers your work performance.")
		elseif after == "Starving" then
			self._notify:Notify(player, "Critical", "You are starving", "Find food quickly or you will fall sick.")
		end
	end
	self:_publish(player)
end

-- Extra hunger from physical work (called by JobService).
function FoodService:OnWork(player: Player)
	self:AddHunger(player, -FoodConfig.Hunger.WorkLossPerTask)
end

function FoodService:_hungerTick(minutes: number)
	local loss = FoodConfig.Hunger.LossPerGameHour * minutes / 60 * self._weather:GetHungerMultiplier()
	for _, player in ipairs(Players:GetPlayers()) do
		local profile = self._data:Get(player)
		if profile and ZoneUtil.isAlive(player) then
			self:AddHunger(player, -loss)
			if self:GetCondition(player) == "Starving" then
				profile.StarvingMinutes = (profile.StarvingMinutes or 0) + minutes
				if not profile.Sick and profile.StarvingMinutes >= FoodConfig.Sickness.StarvingMinutesToSick then
					self:MakeSick(player, "Starvation")
				end
				if FoodConfig.Hunger.StarvingCanKill and profile.Hunger <= 0 then
					self._character:Damage(player, FoodConfig.Hunger.StarvingDamagePerGameHour * minutes / 60, DeathConfig.Causes.Starvation)
				end
			else
				profile.StarvingMinutes = 0
			end
		end
	end
end

-- Sickness -------------------------------------------------------------------------

-- KingdomService/EventService provide the outbreak chance per in-game hour.
function FoodService:SetSicknessChanceProvider(fn: () -> number)
	self._sicknessChance = fn
end

function FoodService:MakeSick(player: Player, reason: string)
	local profile = self._data:Get(player)
	if not profile or profile.Sick then
		return
	end
	profile.Sick = true
	self._audit:Log("System", "Sick", { userId = player.UserId, reason = reason })
	self._notify:Notify(player, "Critical", "You have fallen ill", "Visit a hospital for treatment. Sickness slows you and lowers your performance.")
	self.BecameSick:Fire(player)
	self:_publish(player)
end

function FoodService:Cure(player: Player, reason: string)
	local profile = self._data:Get(player)
	if not profile or not profile.Sick then
		return
	end
	profile.Sick = false
	profile.StarvingMinutes = 0
	self._audit:Log("System", "Cured", { userId = player.UserId, reason = reason })
	self._notify:Notify(player, "Success", "You feel better", "Your sickness has passed.")
	self:_publish(player)
end

function FoodService:_sicknessTick()
	local chance = FoodConfig.Sickness.BaseChancePerHour
	if self._sicknessChance then
		local ok, value = pcall(self._sicknessChance)
		if ok and type(value) == "number" then
			chance = value
		end
	end
	for _, player in ipairs(Players:GetPlayers()) do
		local profile = self._data:Get(player)
		if profile then
			if profile.Sick then
				if self:GetCondition(player) == "Fed" and math.random() < FoodConfig.Sickness.RecoveryChancePerHour then
					self:Cure(player, "Recovered")
				end
			elseif chance > 0 and math.random() < chance then
				self:MakeSick(player, "Illness")
			end
		end
	end
end

-- Eating -----------------------------------------------------------------------------

function FoodService:_restore(player: Player, resourceId: string, source: string)
	local def = ResourceConfig.Resources[resourceId]
	local amount = math.min(def.Nutrition or 0, FoodConfig.Hunger.MealNutritionCap)
	self:AddHunger(player, amount)
	self._activity:MarkInteraction(player)
	self.Ate:Fire(player, resourceId, source)
end

function FoodService:EatFromInventory(player: Player, itemId: string)
	if not ZoneUtil.isAlive(player) then
		return false, "You can't eat right now."
	end
	if self:GetHunger(player) >= FoodConfig.Hunger.Max - 2 then
		return false, "You're full."
	end
	if not self._inventory:Remove(player, itemId, 1, "Eaten") then
		return false, "You don't have any."
	end
	self:_restore(player, itemId, "Inventory")
	return true, "You eat " .. ResourceConfig.Resources[itemId].DisplayName .. "."
end

function FoodService:_setupMessHall(marker: Instance)
	if marker:GetAttribute("KingdomFoodReady") then
		return
	end
	marker:SetAttribute("KingdomFoodReady", true)
	local parent = ZoneUtil.getPromptParent(marker) or PromptUtil.anchorFor(marker)
	local prompt = PromptUtil.create(parent, {
		Name = "KingdomEat",
		ActionText = "Eat a meal",
		ObjectText = marker.Name,
		HoldDuration = 1.5,
		MaxDistance = 12,
	})
	PromptUtil.onTriggered(prompt, function(player, held)
		if not PromptUtil.heldLongEnough(held, 1.5, JobConfig.Session.HoldTolerance) then
			return
		end
		local ok, message = self:_messHallMeal(player, marker)
		self._notify:Notify(player, ok and "Success" or "Warning", ok and "Meal" or "No meal", message)
	end)
end

function FoodService:_messHallMeal(player: Player, marker: Instance)
	local profile = self._data:Get(player)
	if not profile or not ZoneUtil.isAlive(player) then
		return false, "You can't eat now."
	end
	if ZoneUtil.playerDistance(player, marker) > 16 then
		return false, "Come closer to the tables."
	end
	local last = self._lastMeal[player]
	if last and os.clock() - last < FoodConfig.MessHall.MealCooldownSeconds then
		return false, "You just ate."
	end
	if profile.Hunger >= FoodConfig.Hunger.Max - 2 then
		return false, "You're full."
	end
	local chosen
	for _, resourceId in ipairs(FoodConfig.MessHall.PreferredFoods) do
		if self._resources:GetStock(resourceId) > 0 then
			chosen = resourceId
			break
		end
	end
	if not chosen then
		return false, "The kingdom's food stores are EMPTY. Farmers, hunters and fishers are needed!"
	end

	local rank = self._rank:GetRankDef(player)
	local used = self._mealsToday[player] or 0
	local free = used < (rank.Privileges and rank.Privileges.FreeMeals or 0)
	local price = 0
	if not free then
		local base = self._economy:GetBuyPrice(chosen) * FoodConfig.MessHall.PaidMealPriceMultiplier
		local tax = math.floor(base * self._economy:GetTax("Food") + 0.5)
		price = math.max(1, math.floor(base + 0.5)) + tax
		if not self._economy:RemoveCoins(player, price, "Meal") then
			return false, string.format("A meal costs %d coins today (free meals used).", price)
		end
		self._economy:TreasuryDeposit(price - tax, "MealSales")
		if tax > 0 then
			self._economy:TreasuryDeposit(tax, "FoodTax")
		end
	end
	if self._resources:Withdraw(chosen, 1, "MessHall", player) < 1 then
		if price > 0 then
			-- Refund: the food vanished between check and withdraw.
			self._economy:TreasuryWithdraw(price, "Refund")
			self._economy:AddCoins(player, price, "MealRefund")
		end
		return false, "The last portion was just taken."
	end
	self._mealsToday[player] = used + 1
	self._lastMeal[player] = os.clock()
	self:_restore(player, chosen, "MessHall")
	return true, string.format("%s %s", ResourceConfig.Resources[chosen].DisplayName, free and "(free ration)" or string.format("for %d coins", price))
end

function FoodService:_setupHospital(marker: Instance)
	if marker:GetAttribute("KingdomHospitalReady") then
		return
	end
	marker:SetAttribute("KingdomHospitalReady", true)
	local parent = ZoneUtil.getPromptParent(marker) or PromptUtil.anchorFor(marker)
	local prompt = PromptUtil.create(parent, {
		Name = "KingdomTreat",
		ActionText = "Receive treatment",
		ObjectText = marker.Name,
		HoldDuration = 3,
		MaxDistance = 12,
	})
	PromptUtil.onTriggered(prompt, function(player, held)
		if not PromptUtil.heldLongEnough(held, 3, JobConfig.Session.HoldTolerance) then
			return
		end
		local ok, message = self:_treat(player, marker)
		self._notify:Notify(player, ok and "Success" or "Warning", "Hospital", message)
	end)
end

function FoodService:_treat(player: Player, marker: Instance)
	if not self:IsSick(player) then
		return false, "You are healthy."
	end
	if ZoneUtil.playerDistance(player, marker) > 16 then
		return false, "Come closer."
	end
	if self._resources:GetStock("Medicine") < 1 then
		return false, "The hospital has no medicine. Apothecaries are needed!"
	end
	local cost = FoodConfig.Sickness.TreatmentCost
	if not self._economy:RemoveCoins(player, cost, "Treatment") then
		return false, string.format("Treatment costs %d coins.", cost)
	end
	self._economy:TreasuryDeposit(cost, "Hospital")
	self._resources:Withdraw("Medicine", 1, "Treatment", player)
	self:Cure(player, "Treatment")
	return true, "You have been treated."
end

-- Kingdom consumption -------------------------------------------------------------

function FoodService:_kingdomConsumption()
	local players = #Players:GetPlayers()
	local config = FoodConfig.Kingdom
	local needed = config.BaseConsumptionPerHour + config.PerPlayerConsumptionPerHour * players
	for _, resourceId in ipairs(config.ConsumptionOrder) do
		if needed <= 0 then
			break
		end
		local def = ResourceConfig.Resources[resourceId]
		local stock = self._resources:GetStock(resourceId)
		if def and def.Nutrition and stock > 0 then
			local units = math.min(stock, math.ceil(needed / def.Nutrition))
			local taken = self._resources:Withdraw(resourceId, units, "KingdomConsumption")
			needed -= taken * def.Nutrition
		end
	end
	self._shortfall = math.max(0, needed)
	local water = math.ceil(config.WaterPerPlayerPerHour * math.max(players, 1))
	self._resources:Withdraw("Water", water, "KingdomConsumption")
	if self._shortfall > 0 then
		self._audit:Log("System", "FoodShortfall", { nutrition = self._shortfall })
	end
end

-- Nutrition the kingdom failed to supply last hour.
function FoodService:GetShortfall(): number
	return self._shortfall
end

function FoodService:_publish(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return
	end
	player:SetAttribute("KingdomHunger", math.floor(profile.Hunger))
	self._state:Set(player, "Hunger", {
		Value = math.floor(profile.Hunger),
		Max = FoodConfig.Hunger.Max,
		Condition = self:GetCondition(player),
		Sick = profile.Sick == true,
	})
end

return FoodService
