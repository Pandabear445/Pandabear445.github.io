--[[
	FoodConfig
	Personal hunger, sickness and kingdom food consumption.

	Hunger is 0..100 (100 = full). It falls every in-game minute. Players eat
	at mess halls / taverns (kingdom food) or from their inventory.
	Consequences are gradual: Hungry -> Starving -> Sick. By default hunger
	never kills (deaths should be understandable choices, not slow timers).
]]

local FoodConfig = {}

FoodConfig.Hunger = {
	Max = 100,
	Start = 80,
	LossPerGameHour = 7, -- a full player lasts ~14 in-game hours (~42 real minutes)
	WorkLossPerTask = 0.4, -- extra hunger from working
	HungryThreshold = 35,
	StarvingThreshold = 10,
	StarvingCanKill = false,
	StarvingDamagePerGameHour = 10, -- only if StarvingCanKill
	-- Hunger restored at a mess hall per meal (best available food is used).
	MealNutritionCap = 60,
}

FoodConfig.Sickness = {
	-- In-game minutes spent starving before becoming sick.
	StarvingMinutesToSick = 90,
	-- Base chance per in-game hour to fall sick while the kingdom Medicine
	-- need is below 30% (disease outbreaks raise it).
	BaseChancePerHour = 0.01,
	WalkSpeedMultiplier = 0.8,
	-- Natural recovery chance per in-game hour when well fed.
	RecoveryChancePerHour = 0.15,
	TreatmentCost = 10, -- coins at a hospital (plus 1 Medicine from storage)
	TreatmentXP = 0,
}

-- Kingdom-level consumption every in-game hour, in nutrition units.
-- Represents the townsfolk and upkeep, so food always matters.
FoodConfig.Kingdom = {
	BaseConsumptionPerHour = 20,
	PerPlayerConsumptionPerHour = 6,
	WaterPerPlayerPerHour = 1,
	-- Food need % = nutrition in storage / (players * ReserveHours * per-player)
	ReserveHours = 10,
	MinPopulationForNeed = 4, -- small servers are measured as if this many players
	-- Preferred order when the kingdom consumes stored food (preserve first?)
	ConsumptionOrder = { "Meat", "Fish", "Vegetables", "Meal", "Bread", "Wheat", "Flour", "PreservedFood" },
}

-- Mess halls and taverns.
FoodConfig.MessHall = {
	Tags = { "KingdomMessHall", "KingdomTavern" },
	MealCooldownSeconds = 20,
	PreferredFoods = { "Meal", "Bread", "PreservedFood", "Fish", "Meat", "Vegetables", "Wheat" },
	PaidMealPriceMultiplier = 1.0, -- of market price, plus Food tax
}

FoodConfig.Hospital = {
	Tags = { "KingdomHospital" },
}

return FoodConfig
