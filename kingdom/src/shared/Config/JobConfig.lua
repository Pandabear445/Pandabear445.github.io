--[[
	JobConfig
	Every job is driven by map markers (CollectionService tags). Each job
	names the tags it listens to and the Kind of interaction module that runs
	it (server/Services/Jobs/<Kind>.lua).

	Any marker may override these defaults with Attributes:
	  JobType, XPReward, ResourceReward, RequiredRank, RequiredTool, Cooldown,
	  WorkDuration, QualityMultiplier, RequiredDepartment, RequiredPermission,
	  MaxWorkers, YieldMin, YieldMax, Enabled
	(see docs/MAP_MARKERS.md for each tag's full attribute list).

	Rewards are always computed on the server:
	  XP    = XPReward x step share x performance tier x rank XPMultiplier x boosts
	  Coins = Wage x rank PayMultiplier x performance tier (paid by the treasury)
	  Yield = base yield x productivity (tool, building, weather, season,
	          hunger, morale, department efficiency)
]]

local JobConfig = {}

-- Performance score -> tier. Score starts at 1.0 and is modified by skill,
-- following orders, streaks, mistakes, hunger and sickness.
JobConfig.PerformanceTiers = {
	{ Name = "Poor", MinScore = -math.huge, Multiplier = 0.5 },
	{ Name = "Normal", MinScore = 0.8, Multiplier = 1.0 },
	{ Name = "Excellent", MinScore = 1.1, Multiplier = 1.25 },
	{ Name = "Outstanding", MinScore = 1.3, Multiplier = 1.5 },
}

JobConfig.Performance = {
	FollowingOrdersBonus = 0.1, -- working in your assigned department / accepted order
	StreakBonusPerTask = 0.02,
	MaxStreakBonus = 0.2,
	MistakePenalty = 0.15,
	MistakeMemorySeconds = 180,
	HungryPenalty = 0.15, -- hunger below FoodConfig.HungryThreshold
	StarvingPenalty = 0.35,
	SickPenalty = 0.25,
	FineToolBonus = 0.05,
	RatingSmoothing = 0.15, -- EMA weight for the long-term performance rating
}

JobConfig.Session = {
	ActiveWindowSeconds = 300, -- "current job" sticks this long after the last task
	MaxInteractDistance = 14, -- studs from the marker (server re-checks)
	ZonePadding = 4, -- studs of tolerance when checking "inside zone"
	HoldTolerance = 0.85, -- prompt hold must last >= duration * this (server timed)
	MinSecondsBetweenTasks = 0.75, -- per player, any job
}

-- Travel validation: two tasks far apart need plausible travel time.
JobConfig.Travel = {
	MaxStudsPerSecond = 40, -- generous: sprinting + horses
	GraceStuds = 60,
}

JobConfig.Jobs = {
	Farming = {
		DisplayName = "Farmer",
		Department = "Agriculture",
		Permission = "Job.Basic",
		Kind = "FarmPlot",
		Tags = { "KingdomFarm" },
		StationAliases = { "Farm", "Farming" },
		Defaults = {
			CropType = "Wheat",
			XPReward = 15,
			Wage = 4,
			MaxWorkers = 6,
			PlotCount = 8, -- virtual plots when the farm has no Plot children
			QualityMultiplier = 1,
		},
		Steps = {
			Plant = { Tool = "Hoe", Duration = 2.5, XPShare = 0.3, WageShare = 0.25, Consumes = { Seeds = 1 } },
			Water = { Tool = "Bucket", Duration = 1.5, XPShare = 0.2, WageShare = 0.15 },
			Harvest = { Tool = "Hoe", Duration = 3, XPShare = 1.0, WageShare = 1.0 },
		},
		-- GrowMinutes are in-game minutes (1 in-game hour = 3 real minutes).
		Crops = {
			Wheat = { GrowMinutes = 60, WateredSpeedup = 0.5, Yield = { Wheat = { 3, 5 }, Seeds = { 1, 2 } } },
			Vegetables = { GrowMinutes = 80, WateredSpeedup = 0.5, Yield = { Vegetables = { 2, 4 }, Seeds = { 1, 1 } } },
			Herbs = { GrowMinutes = 70, WateredSpeedup = 0.5, Yield = { Herbs = { 2, 4 }, Seeds = { 0, 1 } } },
		},
		-- Unwatered crops grow at this speed; overripe crops rot after this.
		UnwateredGrowthMultiplier = 0.6,
		RotAfterMinutes = 240,
	},

	Mining = {
		DisplayName = "Miner",
		Department = "Mining",
		Permission = "Job.Advanced",
		Kind = "GatherNode",
		Tags = { "KingdomOreNode" },
		ZoneTags = { "KingdomMine" }, -- nodes must be inside one of these if any exist
		ZoneAsNodeTag = "KingdomMine", -- a mine with no ore nodes acts as one node
		StationAliases = { "Mine", "Mining" },
		Defaults = {
			ResourceReward = "IronOre",
			XPReward = 18,
			Wage = 5,
			RequiredTool = "Pickaxe",
			WorkDuration = 4,
			Cooldown = 45, -- real seconds for a depleted node to recover
			NodeUses = 6,
			YieldMin = 1,
			YieldMax = 3,
			MaxWorkers = 10,
		},
		BonusDrops = {
			{ Resource = "Stone", Chance = 0.5, Min = 1, Max = 2 },
			{ Resource = "Coal", Chance = 0.3, Min = 1, Max = 2 },
			{ Resource = "GoldOre", Chance = 0.03, Min = 1, Max = 1 },
		},
		VerbText = "Mine",
		Dangerous = true,
	},

	Quarrying = {
		DisplayName = "Quarryman",
		Department = "Mining",
		Permission = "Job.Basic",
		Kind = "GatherNode",
		Tags = { "KingdomQuarry" },
		StationAliases = { "Quarry" },
		Defaults = {
			ResourceReward = "Stone",
			XPReward = 12,
			Wage = 3,
			RequiredTool = "Pickaxe",
			WorkDuration = 3.5,
			Cooldown = 30,
			NodeUses = 8,
			YieldMin = 2,
			YieldMax = 3,
			MaxWorkers = 8,
		},
		VerbText = "Quarry",
	},

	Logging = {
		DisplayName = "Woodcutter",
		Department = "Forestry",
		Permission = "Job.Basic",
		Kind = "GatherNode",
		Tags = { "KingdomTree" },
		ZoneTags = { "KingdomForest" },
		ZoneAsNodeTag = "KingdomForest",
		StationAliases = { "Forest", "Logging", "Tree" },
		Defaults = {
			ResourceReward = "Wood",
			XPReward = 14,
			Wage = 4,
			RequiredTool = "Axe",
			WorkDuration = 3.5,
			Cooldown = 60,
			NodeUses = 3,
			YieldMin = 2,
			YieldMax = 3,
			MaxWorkers = 10,
		},
		VerbText = "Chop",
		HideWhenDepleted = true,
	},

	Fishing = {
		DisplayName = "Fisher",
		Department = "Fishing",
		Permission = "Job.Basic",
		Kind = "FishingSpot",
		Tags = { "KingdomFishing" },
		StationAliases = { "Fishing" },
		Defaults = {
			ResourceReward = "Fish",
			XPReward = 14,
			Wage = 4,
			RequiredTool = "FishingRod",
			YieldMin = 1,
			YieldMax = 2,
			MaxWorkers = 4,
			Cooldown = 1,
		},
		BiteDelay = { 3, 9 }, -- real seconds before a bite
		ReelWindow = 1.8, -- seconds to react after the bite
		PerfectReaction = 0.45, -- reaction faster than this = skill bonus
	},

	Hunting = {
		DisplayName = "Hunter",
		Department = "Food",
		Permission = "Job.Basic",
		Kind = "GatherNode",
		Tags = { "KingdomHunting" },
		StationAliases = { "Hunting" },
		Defaults = {
			ResourceReward = "Meat",
			XPReward = 20,
			Wage = 5,
			RequiredTool = "HuntingSpear",
			WorkDuration = 5,
			Cooldown = 50,
			NodeUses = 2,
			YieldMin = 2,
			YieldMax = 3,
			MaxWorkers = 4,
		},
		BonusDrops = {
			{ Resource = "Hide", Chance = 0.8, Min = 1, Max = 2 },
		},
		-- Understandable danger: shown on the prompt. Damage, not instant death.
		Injury = { Chance = 0.12, MinDamage = 12, MaxDamage = 30, Cause = "Hunting accident" },
		VerbText = "Hunt",
		Dangerous = true,
	},

	WaterCarrying = {
		DisplayName = "Water Carrier",
		Department = "Food",
		Permission = "Job.Basic",
		Kind = "GatherNode",
		Tags = { "KingdomWell" },
		StationAliases = { "Well" },
		Defaults = {
			ResourceReward = "Water",
			XPReward = 6,
			Wage = 2,
			RequiredTool = "Bucket",
			WorkDuration = 2,
			Cooldown = 0,
			NodeUses = 0, -- 0 = never depletes
			YieldMin = 3,
			YieldMax = 4,
			MaxWorkers = 4,
		},
		VerbText = "Draw water",
	},

	Cleaning = {
		DisplayName = "Cleaner",
		Department = "Construction",
		Permission = "Job.Basic",
		Kind = "GatherNode",
		Tags = { "KingdomCleaning" },
		StationAliases = { "Cleaning" },
		Defaults = {
			ResourceReward = "",
			XPReward = 9,
			Wage = 3,
			WorkDuration = 3,
			Cooldown = 120,
			NodeUses = 1,
			YieldMin = 0,
			YieldMax = 0,
			MaxWorkers = 2,
		},
		RepairsNearbyBuilding = 2, -- condition points restored to the containing building
		VerbText = "Clean",
		HideWhenDepleted = true,
	},

	Milling = {
		DisplayName = "Miller",
		Department = "Food",
		Permission = "Job.Advanced",
		Kind = "CraftStation",
		Tags = { "KingdomMill" },
		StationAliases = { "Mill" },
		Defaults = { XPReward = 12, Wage = 3, MaxWorkers = 2 },
		Recipes = {
			Flour = { Inputs = { Wheat = 3 }, Outputs = { Flour = 2 }, Duration = 4, XPShare = 1 },
		},
	},

	Baking = {
		DisplayName = "Baker",
		Department = "Food",
		Permission = "Job.Advanced",
		Kind = "CraftStation",
		Tags = { "KingdomBakery" },
		StationAliases = { "Bakery" },
		Defaults = { XPReward = 16, Wage = 4, MaxWorkers = 2 },
		Recipes = {
			Bread = { Inputs = { Flour = 2, Water = 1, Firewood = 1 }, Outputs = { Bread = 3 }, Duration = 5, XPShare = 1 },
		},
	},

	Cooking = {
		DisplayName = "Cook",
		Department = "Food",
		Permission = "Job.Advanced",
		Kind = "CraftStation",
		Tags = { "KingdomKitchen" },
		StationAliases = { "Kitchen", "Cooking" },
		Defaults = { XPReward = 20, Wage = 5, MaxWorkers = 3 },
		Recipes = {
			MeatStew = {
				DisplayName = "Meat Stew",
				Inputs = { Meat = 1, Vegetables = 1, Water = 1, Firewood = 1 },
				Outputs = { Meal = 2 },
				Duration = 5,
				XPShare = 1,
			},
			FishStew = {
				DisplayName = "Fish Stew",
				Inputs = { Fish = 1, Vegetables = 1, Water = 1, Firewood = 1 },
				Outputs = { Meal = 2 },
				Duration = 5,
				XPShare = 1,
			},
			Bread = { Inputs = { Flour = 2, Water = 1, Firewood = 1 }, Outputs = { Bread = 3 }, Duration = 6, XPShare = 0.8 },
		},
	},

	Smoking = {
		DisplayName = "Smoker",
		Department = "Food",
		Permission = "Job.Advanced",
		Kind = "CraftStation",
		Tags = { "KingdomSmokehouse" },
		StationAliases = { "Smokehouse" },
		Defaults = { XPReward = 16, Wage = 4, MaxWorkers = 2 },
		Recipes = {
			PreserveMeat = { DisplayName = "Preserve Meat", Inputs = { Meat = 2, Firewood = 1 }, Outputs = { PreservedFood = 3 }, Duration = 5, XPShare = 1 },
			PreserveFish = { DisplayName = "Preserve Fish", Inputs = { Fish = 2, Firewood = 1 }, Outputs = { PreservedFood = 3 }, Duration = 5, XPShare = 1 },
		},
	},

	Firewood = {
		DisplayName = "Woodsplitter",
		Department = "Forestry",
		Permission = "Job.Basic",
		Kind = "CraftStation",
		Tags = { "KingdomWoodshed" },
		StationAliases = { "Woodshed" },
		Defaults = { XPReward = 8, Wage = 2, MaxWorkers = 3 },
		Recipes = {
			Firewood = { Inputs = { Wood = 1 }, Outputs = { Firewood = 2 }, Duration = 2.5, Tool = "Axe", XPShare = 1 },
		},
	},

	Smelting = {
		DisplayName = "Smelter",
		Department = "Blacksmithing",
		Permission = "Job.Advanced",
		Kind = "CraftStation",
		Tags = { "KingdomSmelter" },
		StationAliases = { "Smelter" },
		Defaults = { XPReward = 18, Wage = 5, MaxWorkers = 2 },
		Recipes = {
			Iron = { DisplayName = "Smelt Iron", Inputs = { IronOre = 2, Coal = 1 }, Outputs = { Iron = 1 }, Duration = 5, XPShare = 1 },
			Gold = { DisplayName = "Smelt Gold", Inputs = { GoldOre = 2, Coal = 1 }, Outputs = { Gold = 1 }, Duration = 6, XPShare = 1.5 },
		},
	},

	Blacksmithing = {
		DisplayName = "Blacksmith",
		Department = "Blacksmithing",
		Permission = "Job.Advanced",
		Kind = "CraftStation",
		Tags = { "KingdomBlacksmith" },
		StationAliases = { "Blacksmith", "Forge" },
		Defaults = { XPReward = 28, Wage = 7, MaxWorkers = 3, RequiredTool = "Hammer" },
		Recipes = {
			Tools = { DisplayName = "Forge Tool Kit", Inputs = { Iron = 2, Wood = 1 }, Outputs = { Tools = 1 }, Duration = 6, XPShare = 1 },
			Weapons = { DisplayName = "Forge Weapon", Inputs = { Iron = 3, Wood = 1, Coal = 1 }, Outputs = { Weapons = 1 }, Duration = 7, XPShare = 1.2 },
		},
		RepairQueue = true, -- players drop broken tools here; smiths repair them
	},

	Apothecary = {
		DisplayName = "Apothecary",
		Department = "Food",
		Permission = "Job.Advanced",
		Kind = "CraftStation",
		Tags = { "KingdomApothecary" },
		StationAliases = { "Apothecary" },
		Defaults = { XPReward = 20, Wage = 5, MaxWorkers = 2 },
		Recipes = {
			Medicine = { Inputs = { Herbs = 3, Water = 1 }, Outputs = { Medicine = 1 }, Duration = 5, XPShare = 1 },
		},
	},

	Tailoring = {
		DisplayName = "Tailor",
		Department = "Trade",
		Permission = "Job.Advanced",
		Kind = "CraftStation",
		Tags = { "KingdomTailor" },
		StationAliases = { "Tailor" },
		Defaults = { XPReward = 16, Wage = 4, MaxWorkers = 2 },
		Recipes = {
			Clothing = { Inputs = { Hide = 2 }, Outputs = { Clothing = 1 }, Duration = 5, XPShare = 1 },
		},
	},

	Warehousing = {
		DisplayName = "Warehouse Keeper",
		Department = "Trade",
		Permission = "Job.Basic",
		Kind = "StorageDepot",
		Tags = { "KingdomStorage", "KingdomWarehouse" },
		StationAliases = { "Storage", "Warehouse" },
		Defaults = { XPReward = 1, Wage = 0, MaxWorkers = 50 },
		-- Deliveries: Contribution XP = ceil(value delivered x XPPerValue)
		XPPerValue = 0.35,
		WagePerValue = 0.25, -- coins per coin of value delivered (treasury pays)
		MaxXPPerDeposit = 300,
		Audit = { Duration = 6, XP = 20, DecayReduction = 0.5, LastsGameMinutes = 60, Cooldown = 90 },
	},

	GuardDuty = {
		DisplayName = "Guard",
		Department = "Military",
		Permission = "Job.Security",
		Kind = "GuardPost",
		Tags = { "KingdomGuardPost" },
		StationAliases = { "GuardPost", "Guard" },
		Defaults = { XPReward = 12, Wage = 4, MaxWorkers = 2, PostRadius = 30 },
		PatrolTag = "KingdomPatrolPoint",
		PatrolXP = 8, -- per checkpoint visited in a new order
		CircuitBonusXP = 25, -- after visiting every checkpoint on the route
		WatchCheckInterval = { 60, 120 }, -- real seconds
		WatchCheckWindow = 25,
		LeavePostGraceSeconds = 45,
	},

	Construction = {
		DisplayName = "Builder",
		Department = "Construction",
		Permission = "Job.Advanced",
		Kind = "ConstructionSite",
		Tags = { "KingdomConstruction" },
		StationAliases = { "Construction" },
		Defaults = { XPReward = 22, Wage = 6, MaxWorkers = 8, RequiredTool = "Hammer", WorkDuration = 4 },
		CompletionXP = 150, -- split between contributors
	},

	Trading = {
		DisplayName = "Merchant",
		Department = "Trade",
		Permission = "Job.Advanced",
		Kind = "TradePost",
		Tags = { "KingdomTradePost" },
		StationAliases = { "TradePost", "Merchant" },
		Defaults = { XPReward = 1, Wage = 0, MaxWorkers = 4 },
		ExportPriceMultiplier = 0.9, -- of current market price
		MerchantCommission = 0.25, -- merchant keeps this share, the rest is treasury income
		XPPerValue = 0.3,
		MaxXPPerExport = 250,
		LoadDuration = 4,
	},

	Administration = {
		DisplayName = "Clerk",
		Department = "Government",
		Permission = "Job.Administration",
		Kind = "AdminDesk",
		Tags = { "KingdomAdminDesk" },
		StationAliases = { "AdminDesk", "Administration" },
		Defaults = { XPReward = 16, Wage = 4, MaxWorkers = 3, Cooldown = 4 },
		AnswerSeconds = 20,
		EfficiencyBoost = 0.02, -- government department efficiency per correct ledger
	},
}

-- Filled in for convenience.
for id, job in pairs(JobConfig.Jobs) do
	job.Id = id
end

function JobConfig.Get(id: string?)
	return id and JobConfig.Jobs[id] or nil
end

-- KingdomJobStation markers use the JobType attribute; resolve aliases.
function JobConfig.ResolveJobType(jobType)
	if type(jobType) ~= "string" then
		return nil
	end
	if JobConfig.Jobs[jobType] then
		return JobConfig.Jobs[jobType]
	end
	local lower = string.lower(jobType)
	for _, job in pairs(JobConfig.Jobs) do
		for _, alias in ipairs(job.StationAliases or {}) do
			if string.lower(alias) == lower then
				return job
			end
		end
	end
	return nil
end

function JobConfig.TierForScore(score: number)
	local chosen = JobConfig.PerformanceTiers[1]
	for _, tier in ipairs(JobConfig.PerformanceTiers) do
		if score >= tier.MinScore then
			chosen = tier
		end
	end
	return chosen
end

return JobConfig
