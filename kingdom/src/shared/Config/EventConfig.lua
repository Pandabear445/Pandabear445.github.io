--[[
	EventConfig
	Kingdom events create temporary group objectives.

	Objective types
	  Deliver   { Resource, Amount }          resources deposited to storage
	  Tasks     { Job, Count }                completed tasks of a job
	  Roles     { Roles = { Job = n } }       distinct participants per job
	                                          ("Manager" = an inspecting manager)
	  Defend    { Count }                     hostiles defeated (or guard checks
	                                          when no hostile template exists)
	Rewards go to participants (XP split by contribution) and the kingdom.
	Failure applies Consequences gradually (never instant collapse).

	Trigger
	  ChancePerGameHour   random roll each in-game hour (if conditions hold)
	  MinPlayers          online players required
	  Seasons             allowed seasons (nil = any)
	  Stages              allowed kingdom stages (nil = any)
	  WhenFoodBelow       auto-trigger when food need < value
]]

local EventConfig = {}

EventConfig.MaxConcurrent = 2
EventConfig.GlobalCooldownGameMinutes = 90

EventConfig.Events = {
	HarvestFestival = {
		DisplayName = "Harvest Festival",
		Description = "The harvest is in! Bring wheat and vegetables to the granary.",
		DurationGameMinutes = 180,
		Trigger = { ChancePerGameHour = 0.15, MinPlayers = 2, Seasons = { "Autumn" } },
		Objectives = {
			{ Type = "Deliver", Resource = "Wheat", Amount = 60 },
			{ Type = "Deliver", Resource = "Vegetables", Amount = 30 },
		},
		Modifiers = { JobMultipliers = { Farming = 1.25 } },
		Rewards = { XPPool = 600, Morale = 10, Treasury = 200 },
		Consequences = {},
	},
	BanditAttack = {
		DisplayName = "Bandit Attack",
		Description = "Bandits approach! Guards to your posts and defend the kingdom.",
		DurationGameMinutes = 60,
		Trigger = { ChancePerGameHour = 0.05, MinPlayers = 4 },
		Objectives = { { Type = "Defend", Count = 6 } },
		Hostiles = { Template = "Bandit", Count = 6, SpawnTag = "KingdomBanditSpawn" },
		Rewards = { XPPool = 500, Morale = 6 },
		Consequences = { StealResources = { Food = 0.1, Gold = 0.2 }, Morale = -8, Security = -0.2 },
		Dangerous = true,
	},
	FoodShortage = {
		DisplayName = "Food Shortage",
		Description = "Granaries are nearly empty. Bring any food to storage!",
		DurationGameMinutes = 240,
		Trigger = { WhenFoodBelow = 0.25, MinPlayers = 1 },
		Objectives = { { Type = "DeliverCategory", Category = "Food", Amount = 120 } },
		Rewards = { XPPool = 500, Morale = 8, Achievement = "PreventFoodCrisis" },
		Consequences = { Morale = -10 },
	},
	MineCollapse = {
		DisplayName = "Mine Collapse",
		Description = "A tunnel has collapsed! Miners clear the rubble, builders repair the mine, a manager must inspect Mining.",
		DurationGameMinutes = 120,
		Trigger = { ChancePerGameHour = 0.04, MinPlayers = 3 },
		WarningSeconds = 30, -- real seconds of rumbling before the collapse (get out!)
		DangerZoneTag = "KingdomMine", -- players still inside take damage
		DamageInZone = 45,
		CollapseDamage = { Type = "Mine", Amount = 40 }, -- building condition lost
		Objectives = {
			-- Roles: distinct players per job. "Construction" also counts
			-- building repairs; "Manager" counts a Mining inspection.
			{ Type = "Roles", Roles = { Mining = 5, Construction = 2, Manager = 1 }, ManagerDepartment = "Mining" },
			{ Type = "Tasks", Job = "Mining", Count = 15 },
		},
		Rewards = { XPPool = 700, Morale = 5 },
		Consequences = { BuildingDamage = { Type = "Mine", Amount = 30 }, Morale = -6 },
		Dangerous = true,
	},
	Storm = {
		DisplayName = "Great Storm",
		Description = "A great storm batters the kingdom. Repair damaged buildings!",
		DurationGameMinutes = 120,
		Trigger = { ChancePerGameHour = 0.04, MinPlayers = 2 },
		ForceWeather = "Storm",
		Objectives = { { Type = "Tasks", Job = "Repair", Count = 6 } },
		Rewards = { XPPool = 300, Morale = 4 },
		Consequences = { BuildingDamageAll = 10 },
	},
	MerchantCaravan = {
		DisplayName = "Merchant Caravan",
		Description = "Foreign merchants pay double for exports at the trade post!",
		DurationGameMinutes = 120,
		Trigger = { ChancePerGameHour = 0.08, MinPlayers = 1 },
		Objectives = { { Type = "Tasks", Job = "Trading", Count = 5 } },
		Modifiers = { ExportMultiplier = 2.0 },
		Rewards = { XPPool = 250, Treasury = 150 },
		Consequences = {},
	},
	RoyalWedding = {
		DisplayName = "Royal Wedding",
		Description = "Prepare a feast! Cooks and bakers, to the kitchens.",
		DurationGameMinutes = 150,
		Trigger = { ChancePerGameHour = 0.02, MinPlayers = 8 },
		Objectives = {
			{ Type = "Deliver", Resource = "Meal", Amount = 30 },
			{ Type = "Deliver", Resource = "Bread", Amount = 30 },
		},
		Rewards = { XPPool = 600, Morale = 15 },
		Consequences = { Morale = -3 },
	},
	TaxCrisis = {
		DisplayName = "Tax Crisis",
		Description = "The treasury is empty. Merchants must export goods to refill it.",
		DurationGameMinutes = 180,
		Trigger = { WhenTreasuryBelow = 150, MinPlayers = 2 },
		Objectives = { { Type = "Tasks", Job = "Trading", Count = 8 } },
		Rewards = { XPPool = 400, Morale = 5 },
		Consequences = { Morale = -8 },
	},
	DiseaseOutbreak = {
		DisplayName = "Disease Outbreak",
		Description = "Sickness spreads. Brew medicine and stock the hospital.",
		DurationGameMinutes = 180,
		Trigger = { ChancePerGameHour = 0.03, MinPlayers = 4 },
		SicknessChancePerHour = 0.12,
		Objectives = { { Type = "Deliver", Resource = "Medicine", Amount = 12 } },
		Rewards = { XPPool = 450, Morale = 6 },
		Consequences = { Morale = -8 },
	},
	War = {
		DisplayName = "War Mobilisation",
		Description = "A rival realm threatens war. Forge weapons and man the posts.",
		DurationGameMinutes = 300,
		Trigger = { ChancePerGameHour = 0.01, MinPlayers = 12, Stages = { "Healthy", "Stable", "Strained" } },
		Objectives = {
			{ Type = "Deliver", Resource = "Weapons", Amount = 10 },
			{ Type = "Tasks", Job = "GuardDuty", Count = 30 },
		},
		Rewards = { XPPool = 1200, Morale = 12, Treasury = 500 },
		Consequences = { StealResources = { Gold = 0.4, Food = 0.25 }, Morale = -15, BuildingDamageAll = 15 },
		Dangerous = true,
	},
	ConstructionProject = {
		DisplayName = "Royal Construction Project",
		Description = "The crown commissions new works. Deliver materials and build!",
		DurationGameMinutes = 240,
		Trigger = { ChancePerGameHour = 0.05, MinPlayers = 3 },
		Objectives = {
			{ Type = "Deliver", Resource = "Wood", Amount = 50 },
			{ Type = "Deliver", Resource = "Stone", Amount = 40 },
			{ Type = "Tasks", Job = "Construction", Count = 10 },
		},
		Rewards = { XPPool = 650, Morale = 6 },
		Consequences = {},
	},
}

-- Hostile NPCs: put Model templates (with a Humanoid + HumanoidRootPart) in
-- ServerStorage.Kingdom.NPCs.<Template>. Without a template, Defend
-- objectives are completed by guards answering watch checks at posts.
EventConfig.Hostiles = {
	Bandit = { Health = 60, Damage = 10, AttackCooldown = 1.4, AggroRange = 60, WalkSpeed = 14, XPOnKill = 25 },
}

return EventConfig
