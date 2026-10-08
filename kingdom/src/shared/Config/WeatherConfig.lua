--[[
	WeatherConfig
	Weather states, seasonal weights and their gameplay effects.

	JobMultipliers multiply yield for a job Id (or a Department via "Dept:").
	GrowthMultiplier speeds/slows crop growth. WalkSpeedMultiplier is a
	travel penalty. Visual settings are applied by the client.
]]

local WeatherConfig = {}

WeatherConfig.Enabled = true
WeatherConfig.DurationGameHours = { 2, 5 }

WeatherConfig.States = {
	Clear = {
		DisplayName = "Clear",
		JobMultipliers = {},
		GrowthMultiplier = 1,
		WalkSpeedMultiplier = 1,
		Visual = { FogEndMultiplier = 1, Particles = nil },
	},
	Rain = {
		DisplayName = "Rain",
		JobMultipliers = { Farming = 1.15, Logging = 0.95 },
		GrowthMultiplier = 1.3, -- farming bonus
		WalkSpeedMultiplier = 0.95,
		WatersCrops = true,
		Visual = { FogEndMultiplier = 0.6, Particles = "Rain", DarkenBrightness = 0.25 },
	},
	Storm = {
		DisplayName = "Storm",
		JobMultipliers = { Fishing = 0.5, Logging = 0.8, Trading = 0.8 },
		GrowthMultiplier = 1.1,
		WalkSpeedMultiplier = 0.85,
		WatersCrops = true,
		BuildingDamagePerHour = 2, -- condition points to outdoor buildings
		Visual = { FogEndMultiplier = 0.4, Particles = "Rain", DarkenBrightness = 0.5, Thunder = true },
	},
	Fog = {
		DisplayName = "Fog",
		JobMultipliers = { Fishing = 0.85, GuardDuty = 0.9 },
		GrowthMultiplier = 1,
		WalkSpeedMultiplier = 0.95,
		Visual = { FogEndMultiplier = 0.2 },
	},
	Snow = {
		DisplayName = "Snow",
		JobMultipliers = { Farming = 0.6, Hunting = 0.85 },
		GrowthMultiplier = 0.5,
		WalkSpeedMultiplier = 0.8, -- travel penalty
		Visual = { FogEndMultiplier = 0.5, Particles = "Snow", DarkenBrightness = 0.1 },
	},
}

WeatherConfig.Seasons = {
	Enabled = true,
	DaysPerSeason = 3, -- in-game days
	Order = { "Spring", "Summer", "Autumn", "Winter" },
	Definitions = {
		Spring = {
			GrowthMultiplier = 1.2,
			JobMultipliers = { Farming = 1.1 },
			WeatherWeights = { Clear = 4, Rain = 4, Storm = 1, Fog = 2, Snow = 0 },
		},
		Summer = {
			GrowthMultiplier = 1.35,
			JobMultipliers = { Farming = 1.2, Fishing = 1.1 },
			WeatherWeights = { Clear = 7, Rain = 2, Storm = 1, Fog = 1, Snow = 0 },
		},
		Autumn = {
			GrowthMultiplier = 1.0,
			JobMultipliers = { Farming = 1.3, Hunting = 1.15 }, -- harvest season
			WeatherWeights = { Clear = 4, Rain = 3, Storm = 2, Fog = 3, Snow = 0 },
		},
		Winter = {
			GrowthMultiplier = 0.5,
			JobMultipliers = { Farming = 0.6, Hunting = 0.9 },
			WeatherWeights = { Clear = 3, Rain = 0, Storm = 1, Fog = 2, Snow = 5 },
			HungerMultiplier = 1.2,
		},
	},
}

-- Used when seasons are disabled.
WeatherConfig.DefaultWeights = { Clear = 6, Rain = 3, Storm = 1, Fog = 2, Snow = 0 }

return WeatherConfig
