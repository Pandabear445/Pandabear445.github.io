--[[
	KingdomConfig
	Kingdom-wide needs, stability stages and morale.

	Needs are 0..1. Stability is the weighted average of needs. The kingdom
	stage moves at most ONE step per evaluation so failure is never instant:
	  Healthy -> Stable -> Strained -> Critical -> Crisis -> Collapse
	When improving from Crisis/Collapse the kingdom enters Recovery until it
	reaches Stable again.
]]

local KingdomConfig = {}

KingdomConfig.EvaluateEveryGameMinutes = 15

KingdomConfig.Needs = {
	Food = { DisplayName = "Food", Weight = 3 },
	Water = { DisplayName = "Water", Weight = 1.5 },
	Housing = { DisplayName = "Housing", Weight = 1 },
	Security = { DisplayName = "Security", Weight = 1.5 },
	Tools = { DisplayName = "Tools", Weight = 1 },
	Weapons = { DisplayName = "Weapons", Weight = 0.75 },
	Medicine = { DisplayName = "Medicine", Weight = 0.75 },
	Fuel = { DisplayName = "Fuel", Weight = 1 },
	Materials = { DisplayName = "Construction Materials", Weight = 0.75 },
}

-- Per-player stock targets for needs measured from storage.
KingdomConfig.NeedTargets = {
	Water = { Resource = "Water", PerPlayer = 15 },
	Tools = { Resource = "Tools", PerPlayer = 0.5, ToolConditionWeight = 0.5 },
	Weapons = { Resource = "Weapons", PerGuard = 1, Minimum = 3 },
	Medicine = { Resource = "Medicine", PerPlayer = 0.6 },
	Fuel = { Resources = { "Coal", "Firewood" }, PerPlayer = 6 },
	Materials = { Resources = { "Wood", "Stone" }, PerPlayer = 15 },
	Housing = { PerHouse = 4 }, -- players housed per KingdomBuilding with BuildingType=House
	Security = { PlayersPerGuard = 6, MinimumGuards = 1 },
}

KingdomConfig.MinPopulationForNeeds = 4

-- Stages from best to worst with the stability needed to sit in them.
KingdomConfig.Stages = {
	{ Id = "Healthy", MinStability = 0.8, Productivity = 1.1, MoraleDrift = 2, Color = Color3.fromRGB(90, 170, 90) },
	{ Id = "Stable", MinStability = 0.6, Productivity = 1.0, MoraleDrift = 1, Color = Color3.fromRGB(150, 170, 90) },
	{ Id = "Strained", MinStability = 0.45, Productivity = 0.92, MoraleDrift = -1, Color = Color3.fromRGB(200, 170, 70) },
	{ Id = "Critical", MinStability = 0.3, Productivity = 0.82, MoraleDrift = -2.5, Color = Color3.fromRGB(210, 120, 50) },
	{ Id = "Crisis", MinStability = 0.15, Productivity = 0.7, MoraleDrift = -4, Color = Color3.fromRGB(200, 60, 50) },
	{ Id = "Collapse", MinStability = -1, Productivity = 0.55, MoraleDrift = -6, Color = Color3.fromRGB(120, 30, 30) },
}
KingdomConfig.RecoveryStage = {
	Id = "Recovery",
	Productivity = 0.9,
	MoraleDrift = 2,
	Color = Color3.fromRGB(110, 150, 200),
}

-- Morale 0..100.
KingdomConfig.Morale = {
	Start = 65,
	FoodWeight = 0.25, -- pull toward food need
	PayWeight = 0.2, -- unpaid wages hurt
	SecurityWeight = 0.1,
	-- Productivity = lerp(LowProductivity, HighProductivity, morale/100)
	LowProductivity = 0.6,
	HighProductivity = 1.15,
	StrikeThreshold = 30, -- petitions/strikes may be organized below this
	VeryLowThreshold = 20,
	UnpaidWagePenalty = 3, -- per evaluation with unpaid wages
	ProjectBonus = 4,
	FestivalBonus = 10,
}

return KingdomConfig
