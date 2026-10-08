--[[
	BuildingConfig
	Functional buildings are map markers tagged "KingdomBuilding".
	Attributes: BuildingType, Department, StorageCapacity, ProductionType,
	RequiredRank, Health (condition 0..100), Enabled, Outdoor.

	Stations (job markers) inside a building model, or with a Building
	attribute naming it, are affected by its condition.
]]

local BuildingConfig = {}

BuildingConfig.Types = {
	Farm = { DecayPerGameHour = 0.4, Department = "Agriculture" },
	Mine = { DecayPerGameHour = 0.8, Department = "Mining" },
	Warehouse = { DecayPerGameHour = 0.4, Department = "Trade" },
	Granary = { DecayPerGameHour = 0.4, Department = "Food" },
	Blacksmith = { DecayPerGameHour = 0.6, Department = "Blacksmithing" },
	Castle = { DecayPerGameHour = 0.2, Department = "Government" },
	Barracks = { DecayPerGameHour = 0.5, Department = "Military" },
	Kitchen = { DecayPerGameHour = 0.6, Department = "Food" },
	Market = { DecayPerGameHour = 0.4, Department = "Trade" },
	Hospital = { DecayPerGameHour = 0.3, Department = "Food" },
	MeetingHall = { DecayPerGameHour = 0.2, Department = "Government" },
	House = { DecayPerGameHour = 0.3, Department = "Construction" },
	Mill = { DecayPerGameHour = 0.5, Department = "Food" },
	Other = { DecayPerGameHour = 0.3, Department = "Construction" },
}

-- Condition bands and their effects.
BuildingConfig.Bands = {
	{ Name = "Excellent", Min = 75, Efficiency = 1.0, Storage = 1.0 },
	{ Name = "Good", Min = 50, Efficiency = 0.9, Storage = 0.95 },
	{ Name = "Damaged", Min = 25, Efficiency = 0.7, Storage = 0.8 },
	{ Name = "Critical", Min = 0.01, Efficiency = 0.45, Storage = 0.6 },
	{ Name = "Disabled", Min = -1, Efficiency = 0, Storage = 0.35 },
}

BuildingConfig.Repair = {
	Permission = "Job.Advanced",
	Tool = "Hammer",
	Duration = 4, -- seconds hold
	ConditionPerRepair = 12,
	Materials = { Wood = 2, Stone = 1 }, -- taken from kingdom storage
	XP = 20,
	Wage = 5,
	Cooldown = 3,
}

-- Buildings can't decay below this without events (storms, collapses).
BuildingConfig.NaturalDecayFloor = 20

return BuildingConfig
