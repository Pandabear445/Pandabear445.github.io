--[[
	ResourceConfig
	Every stackable resource in the kingdom.

	  Id                 unique key
	  DisplayName        UI name
	  Category           Food | Material | Fuel | Equipment | Medical | Water | Seed
	  MaxStack           max units in one inventory stack (inventory uses weight)
	  Weight             per unit (inventory capacity is weight based)
	  BaseValue          market base price in coins
	  DecayRate          fraction lost per in-game hour while stored (0 = never)
	  StorageType        which KingdomStorage markers accept it
	  Nutrition          hunger restored when eaten (food only)
	  TargetPerCapita    stock per player the market treats as "balanced"
	  ProductionSources  documentation / dashboard text
	  ConsumptionSources documentation / dashboard text
]]

local ResourceConfig = {}

ResourceConfig.Resources = {
	-- Raw food -------------------------------------------------------------
	Wheat = {
		DisplayName = "Wheat", Icon = "🌾", Category = "Food", MaxStack = 99, Weight = 1,
		BaseValue = 3, DecayRate = 0.002, StorageType = "Food", Nutrition = 4, TargetPerCapita = 20,
		ProductionSources = { "Farming" }, ConsumptionSources = { "Mill", "Eating" },
	},
	Vegetables = {
		DisplayName = "Vegetables", Icon = "🥕", Category = "Food", MaxStack = 99, Weight = 1,
		BaseValue = 4, DecayRate = 0.01, StorageType = "Food", Nutrition = 8, TargetPerCapita = 15,
		ProductionSources = { "Farming" }, ConsumptionSources = { "Kitchen", "Eating" },
	},
	Meat = {
		DisplayName = "Fresh Meat", Icon = "🍖", Category = "Food", MaxStack = 50, Weight = 2,
		BaseValue = 8, DecayRate = 0.04, StorageType = "Food", Nutrition = 14, TargetPerCapita = 8,
		ProductionSources = { "Hunting" }, ConsumptionSources = { "Kitchen", "Smokehouse", "Eating" },
	},
	Fish = {
		DisplayName = "Fish", Icon = "🐟", Category = "Food", MaxStack = 50, Weight = 1.5,
		BaseValue = 6, DecayRate = 0.05, StorageType = "Food", Nutrition = 12, TargetPerCapita = 8,
		ProductionSources = { "Fishing" }, ConsumptionSources = { "Kitchen", "Smokehouse", "Eating" },
	},
	-- Processed food -------------------------------------------------------
	Flour = {
		DisplayName = "Flour", Icon = "🌫", Category = "Food", MaxStack = 99, Weight = 1,
		BaseValue = 5, DecayRate = 0.003, StorageType = "Food", Nutrition = 2, TargetPerCapita = 10,
		ProductionSources = { "Mill" }, ConsumptionSources = { "Bakery" },
	},
	Bread = {
		DisplayName = "Bread", Icon = "🍞", Category = "Food", MaxStack = 50, Weight = 0.5,
		BaseValue = 9, DecayRate = 0.015, StorageType = "Food", Nutrition = 25, TargetPerCapita = 10,
		ProductionSources = { "Bakery" }, ConsumptionSources = { "Eating", "Mess hall" },
	},
	Meal = {
		DisplayName = "Hearty Stew", Icon = "🍲", Category = "Food", MaxStack = 20, Weight = 1,
		BaseValue = 16, DecayRate = 0.03, StorageType = "Food", Nutrition = 45, TargetPerCapita = 6,
		ProductionSources = { "Kitchen" }, ConsumptionSources = { "Eating", "Mess hall" },
	},
	PreservedFood = {
		DisplayName = "Preserved Rations", Icon = "🥫", Category = "Food", MaxStack = 50, Weight = 0.8,
		BaseValue = 14, DecayRate = 0.0005, StorageType = "Food", Nutrition = 22, TargetPerCapita = 10,
		ProductionSources = { "Smokehouse" }, ConsumptionSources = { "Eating", "Emergencies" },
	},
	Seeds = {
		DisplayName = "Seeds", Icon = "🌱", Category = "Seed", MaxStack = 99, Weight = 0.1,
		BaseValue = 1, DecayRate = 0, StorageType = "Food", TargetPerCapita = 10,
		ProductionSources = { "Harvest by-product", "Market" }, ConsumptionSources = { "Planting" },
	},
	Water = {
		DisplayName = "Water", Icon = "💧", Category = "Water", MaxStack = 50, Weight = 1,
		BaseValue = 1, DecayRate = 0.005, StorageType = "Water", TargetPerCapita = 20,
		ProductionSources = { "Wells" }, ConsumptionSources = { "Population", "Cooking", "Watering" },
	},
	Herbs = {
		DisplayName = "Herbs", Icon = "🌿", Category = "Medical", MaxStack = 99, Weight = 0.2,
		BaseValue = 4, DecayRate = 0.02, StorageType = "Medical", TargetPerCapita = 5,
		ProductionSources = { "Herb gardens" }, ConsumptionSources = { "Apothecary" },
	},
	Medicine = {
		DisplayName = "Medicine", Icon = "⚗", Category = "Medical", MaxStack = 20, Weight = 0.3,
		BaseValue = 20, DecayRate = 0.001, StorageType = "Medical", TargetPerCapita = 2,
		ProductionSources = { "Apothecary" }, ConsumptionSources = { "Hospital", "Sickness" },
	},
	-- Materials --------------------------------------------------------------
	Wood = {
		DisplayName = "Logs", Icon = "🪵", Category = "Material", MaxStack = 50, Weight = 3,
		BaseValue = 4, DecayRate = 0, StorageType = "General", TargetPerCapita = 25,
		ProductionSources = { "Logging" }, ConsumptionSources = { "Construction", "Repairs", "Tools", "Firewood" },
	},
	Firewood = {
		DisplayName = "Firewood", Icon = "🔥", Category = "Fuel", MaxStack = 50, Weight = 1.5,
		BaseValue = 3, DecayRate = 0, StorageType = "General", TargetPerCapita = 15,
		ProductionSources = { "Woodshed" }, ConsumptionSources = { "Kitchen", "Smokehouse", "Heating" },
	},
	Stone = {
		DisplayName = "Stone", Icon = "🪨", Category = "Material", MaxStack = 50, Weight = 4,
		BaseValue = 3, DecayRate = 0, StorageType = "General", TargetPerCapita = 20,
		ProductionSources = { "Mining", "Quarry" }, ConsumptionSources = { "Construction", "Repairs" },
	},
	Coal = {
		DisplayName = "Coal", Icon = "⬛", Category = "Fuel", MaxStack = 50, Weight = 2,
		BaseValue = 6, DecayRate = 0, StorageType = "Ore", TargetPerCapita = 10,
		ProductionSources = { "Mining" }, ConsumptionSources = { "Smelter", "Smokehouse", "Heating" },
	},
	IronOre = {
		DisplayName = "Iron Ore", Icon = "⛏", Category = "Material", MaxStack = 50, Weight = 4,
		BaseValue = 7, DecayRate = 0, StorageType = "Ore", TargetPerCapita = 8,
		ProductionSources = { "Mining" }, ConsumptionSources = { "Smelter" },
	},
	Iron = {
		DisplayName = "Iron Ingot", Icon = "🔩", Category = "Material", MaxStack = 50, Weight = 3,
		BaseValue = 18, DecayRate = 0, StorageType = "Ore", TargetPerCapita = 6,
		ProductionSources = { "Smelter" }, ConsumptionSources = { "Blacksmith", "Repairs" },
	},
	GoldOre = {
		DisplayName = "Gold Ore", Icon = "✨", Category = "Material", MaxStack = 50, Weight = 4,
		BaseValue = 25, DecayRate = 0, StorageType = "Ore", TargetPerCapita = 2,
		ProductionSources = { "Mining (rare)" }, ConsumptionSources = { "Smelter" },
	},
	Gold = {
		DisplayName = "Gold Bar", Icon = "🥇", Category = "Material", MaxStack = 20, Weight = 2,
		BaseValue = 60, DecayRate = 0, StorageType = "Treasury", TargetPerCapita = 1,
		ProductionSources = { "Smelter" }, ConsumptionSources = { "Trade", "Treasury" },
	},
	Hide = {
		DisplayName = "Hide", Icon = "🟫", Category = "Material", MaxStack = 50, Weight = 1.5,
		BaseValue = 6, DecayRate = 0.005, StorageType = "General", TargetPerCapita = 4,
		ProductionSources = { "Hunting" }, ConsumptionSources = { "Tailor" },
	},
	-- Equipment stock (requisitioned into personal tools) -------------------
	Tools = {
		DisplayName = "Tool Kits", Icon = "🛠", Category = "Equipment", MaxStack = 10, Weight = 3,
		BaseValue = 40, DecayRate = 0, StorageType = "Armory", TargetPerCapita = 1,
		ProductionSources = { "Blacksmith" }, ConsumptionSources = { "Requisitions" },
	},
	Weapons = {
		DisplayName = "Weapons", Icon = "⚔", Category = "Equipment", MaxStack = 10, Weight = 4,
		BaseValue = 55, DecayRate = 0, StorageType = "Armory", TargetPerCapita = 0.5,
		ProductionSources = { "Blacksmith" }, ConsumptionSources = { "Guards", "Defence" },
	},
	Clothing = {
		DisplayName = "Clothing", Icon = "🧥", Category = "Equipment", MaxStack = 10, Weight = 1,
		BaseValue = 20, DecayRate = 0.001, StorageType = "General", TargetPerCapita = 1,
		ProductionSources = { "Tailor" }, ConsumptionSources = { "Winter", "Morale" },
	},
}

-- Storage types recognized on KingdomStorage markers.
ResourceConfig.StorageTypes = {
	Food = { DisplayName = "Granary / Food Store", DefaultCapacity = 2000 },
	General = { DisplayName = "Warehouse", DefaultCapacity = 3000 },
	Ore = { DisplayName = "Ore Yard", DefaultCapacity = 2000 },
	Armory = { DisplayName = "Armory", DefaultCapacity = 300 },
	Medical = { DisplayName = "Apothecary Store", DefaultCapacity = 500 },
	Water = { DisplayName = "Cistern", DefaultCapacity = 1500 },
	Treasury = { DisplayName = "Treasury Vault", DefaultCapacity = 500 },
}

-- Stock in kingdom storage at server start.
ResourceConfig.StartingStock = {
	Bread = 60,
	Wheat = 80,
	PreservedFood = 40,
	Water = 200,
	Seeds = 120,
	Wood = 120,
	Stone = 80,
	Coal = 30,
	IronOre = 20,
	Iron = 10,
	Tools = 10,
	Weapons = 6,
	Medicine = 8,
	Firewood = 40,
	Clothing = 10,
}

-- If the map has no KingdomStorage markers yet, a virtual store with this
-- capacity per storage type keeps the game playable while building the map.
ResourceConfig.VirtualStorageCapacity = 1500

-- Resources are processed in batches; dashboards update at this cadence.
ResourceConfig.ReplicateSeconds = 3

-- Build the indexed list (Id filled in).
for id, def in pairs(ResourceConfig.Resources) do
	def.Id = id
end

function ResourceConfig.Get(id: string?)
	return id and ResourceConfig.Resources[id] or nil
end

function ResourceConfig.IsFood(id: string): boolean
	local def = ResourceConfig.Resources[id]
	return def ~= nil and def.Category == "Food" and (def.Nutrition or 0) > 0
end

return ResourceConfig
