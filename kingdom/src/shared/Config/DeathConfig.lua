--[[
	DeathConfig
	Death is the defining risk mechanic:

	  WHEN YOU DIE, YOUR CURRENT XP BECOMES 0 AND YOUR CURRENT RANK BECOMES
	  THE LOWEST RANK. The slot you held cascades to the next in line.

	The XP/rank reset is ALWAYS on and cannot be configured off here.
	Lifetime statistics, achievements, gamepasses, cosmetics and career
	history are never touched. The options below only control items.
]]

local DeathConfig = {}

DeathConfig.Inventory = {
	DropResourcesOnDeath = true, -- carried resources drop as a loot sack
	DropPercentage = 1.0, -- share of each carried resource stack dropped
	LoseHeldItems = false, -- drop the currently equipped tool
	LoseCurrency = false,
	CurrencyLossPercentage = 0.0,
	LoseEquipmentDurability = true,
	DurabilityLossFraction = 0.15, -- of max durability, every tool
	LosePermanentItems = false,
	LoseGamepasses = false, -- never change this
	LoseCosmetics = false, -- never change this
}

DeathConfig.LootSack = {
	DespawnSeconds = 180,
	OwnerOnlySeconds = 0, -- 0 = anyone can recover it immediately
}

-- Server-side cause detection.
DeathConfig.Causes = {
	Combat = "Combat",
	Fall = "Fall",
	Drowning = "Drowning",
	Fire = "Fire",
	Hazard = "Environmental hazard",
	Monster = "Monster",
	Bandit = "Bandit",
	Event = "Kingdom event",
	MineCollapse = "Mine collapse",
	Player = "Other player",
	Starvation = "Starvation",
	Unknown = "Other",
}

-- Optional fall damage so "Fall" is a real, understandable danger.
DeathConfig.FallDamage = {
	Enabled = true,
	MinVelocity = 70, -- studs/s downward on landing before damage
	DamagePerVelocity = 1.1,
}

DeathConfig.TagSeconds = 10 -- damage tags older than this don't count

-- Shown to the player.
DeathConfig.Screen = {
	Title = "YOU HAVE FALLEN",
	Lines = {
		"Your life has ended.",
		"Current XP has been reset to 0.",
		"Your rank has been lost.",
		"You have returned to the lowest rank.",
		"Your next life begins now.",
	},
}

-- Combat between players. Off by default: griefing would erase progress.
DeathConfig.PvP = {
	Enabled = false,
	-- When enabled, only these job/rank permissions may attack players.
	RequiredPermission = "Job.Security",
}

return DeathConfig
