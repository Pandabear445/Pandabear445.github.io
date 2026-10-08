--[[
	DepartmentConfig
	Departments group jobs. Each has a staffing target that scales with the
	online population, so the kingdom always needs a mix of specialists.

	  Jobs                 JobConfig ids counted as this department's work
	  BaseWorkers          staffing target at MinPopulation
	  WorkersPerPlayer     extra target per online player
	  ProductionTarget     tasks per in-game hour per required worker
	  InspectionHours      in-game hours before an uninspected department
	                       starts losing efficiency
]]

local DepartmentConfig = {}

DepartmentConfig.Departments = {
	Agriculture = {
		DisplayName = "Agriculture", Icon = "🌾",
		Jobs = { "Farming" },
		BaseWorkers = 1, WorkersPerPlayer = 0.2,
		ProductionTarget = 6, InspectionHours = 3,
	},
	Mining = {
		DisplayName = "Mining", Icon = "⛏",
		Jobs = { "Mining", "Quarrying" },
		BaseWorkers = 1, WorkersPerPlayer = 0.12,
		ProductionTarget = 6, InspectionHours = 3,
	},
	Forestry = {
		DisplayName = "Forestry", Icon = "🌲",
		Jobs = { "Logging", "Firewood" },
		BaseWorkers = 1, WorkersPerPlayer = 0.1,
		ProductionTarget = 6, InspectionHours = 3,
	},
	Fishing = {
		DisplayName = "Fishing", Icon = "🐟",
		Jobs = { "Fishing" },
		BaseWorkers = 0, WorkersPerPlayer = 0.08,
		ProductionTarget = 6, InspectionHours = 4,
	},
	Food = {
		DisplayName = "Food & Kitchens", Icon = "🍲",
		Jobs = { "Cooking", "Baking", "Milling", "Smoking", "Hunting", "WaterCarrying", "Apothecary" },
		BaseWorkers = 1, WorkersPerPlayer = 0.15,
		ProductionTarget = 5, InspectionHours = 3,
	},
	Construction = {
		DisplayName = "Construction", Icon = "🔨",
		Jobs = { "Construction", "Cleaning" },
		BaseWorkers = 0, WorkersPerPlayer = 0.08,
		ProductionTarget = 4, InspectionHours = 4,
	},
	Blacksmithing = {
		DisplayName = "Blacksmithing", Icon = "⚒",
		Jobs = { "Blacksmithing", "Smelting" },
		BaseWorkers = 0, WorkersPerPlayer = 0.06,
		ProductionTarget = 4, InspectionHours = 4,
	},
	Military = {
		DisplayName = "Military", Icon = "🛡",
		Jobs = { "GuardDuty" },
		BaseWorkers = 1, WorkersPerPlayer = 0.15,
		ProductionTarget = 4, InspectionHours = 2,
	},
	Trade = {
		DisplayName = "Trade & Storage", Icon = "⚖",
		Jobs = { "Trading", "Warehousing", "Tailoring" },
		BaseWorkers = 0, WorkersPerPlayer = 0.06,
		ProductionTarget = 4, InspectionHours = 4,
	},
	Government = {
		DisplayName = "Government", Icon = "👑",
		Jobs = { "Administration" },
		BaseWorkers = 0, WorkersPerPlayer = 0.04,
		ProductionTarget = 3, InspectionHours = 6,
	},
}

DepartmentConfig.MinPopulation = 3
-- A worker counts as "active" if they completed a task within this window.
DepartmentConfig.ActiveWindowGameMinutes = 20
-- Efficiency
DepartmentConfig.Efficiency = {
	NeglectPenaltyPerHour = 0.05, -- per in-game hour past InspectionHours
	MinNeglectMultiplier = 0.6,
	InspectionBoost = 0.1, -- temporary bonus right after an inspection
	InspectionBoostHours = 2,
	PriorityBonus = { Low = 0, Normal = 0, High = 0.05, Critical = 0.1 },
}
-- Oversupply: more than this multiple of the target is "oversupplied".
DepartmentConfig.OversupplyFactor = 2.0

return DepartmentConfig
