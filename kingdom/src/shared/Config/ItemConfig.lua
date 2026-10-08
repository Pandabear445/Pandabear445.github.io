--[[
	ItemConfig
	Tools and weapons. Unlike resources these are unique items with
	durability. Poorly maintained tools reduce productivity; broken tools
	cannot be used until a blacksmith repairs them.

	If ServerStorage.Kingdom.Tools.<ToolId> exists (a Tool instance you build),
	it is cloned into the player's Backpack. Otherwise a simple generated
	Tool with a Handle is used so the game works before art is ready.
]]

local ItemConfig = {}

ItemConfig.Tools = {
	Hoe = { DisplayName = "Hoe", Icon = "⛏", Weight = 3, BaseValue = 25, WearPerUse = 1, Color = Color3.fromRGB(120, 90, 60) },
	Pickaxe = { DisplayName = "Pickaxe", Icon = "⛏", Weight = 4, BaseValue = 35, WearPerUse = 1.5, Color = Color3.fromRGB(110, 110, 120) },
	Axe = { DisplayName = "Axe", Icon = "🪓", Weight = 4, BaseValue = 30, WearPerUse = 1.2, Color = Color3.fromRGB(140, 100, 70) },
	FishingRod = { DisplayName = "Fishing Rod", Icon = "🎣", Weight = 2, BaseValue = 20, WearPerUse = 0.8, Color = Color3.fromRGB(160, 130, 90) },
	Hammer = { DisplayName = "Hammer", Icon = "🔨", Weight = 3, BaseValue = 30, WearPerUse = 1, Color = Color3.fromRGB(100, 100, 100) },
	Bucket = { DisplayName = "Bucket", Icon = "🪣", Weight = 2, BaseValue = 12, WearPerUse = 0.5, Color = Color3.fromRGB(130, 100, 70) },
	HuntingSpear = { DisplayName = "Hunting Spear", Icon = "🗡", Weight = 3, BaseValue = 30, WearPerUse = 1.5, Color = Color3.fromRGB(150, 140, 120) },
	Sword = {
		DisplayName = "Sword", Icon = "⚔", Weight = 4, BaseValue = 60, WearPerUse = 0.6, Color = Color3.fromRGB(190, 190, 200),
		Weapon = { Damage = 18, Range = 7, Cooldown = 0.8 },
	},
}

-- Quality tiers. Durability = MaxDurability; Efficiency multiplies output.
ItemConfig.Qualities = {
	Starter = { DisplayName = "Worn", MaxDurability = 40, Efficiency = 0.9 },
	Standard = { DisplayName = "Standard", MaxDurability = 120, Efficiency = 1.0 },
	Fine = { DisplayName = "Fine", MaxDurability = 250, Efficiency = 1.1 },
}

-- Condition effects (fraction of max durability -> productivity multiplier).
ItemConfig.ConditionEfficiency = {
	{ Min = 0.5, Multiplier = 1.0 },
	{ Min = 0.25, Multiplier = 0.85 },
	{ Min = 0.0001, Multiplier = 0.65 },
}

-- Given to brand-new players and at the start of every new life when the
-- player has no tool of that type. Worn quality keeps blacksmiths relevant.
ItemConfig.StarterKit = {
	{ Id = "Hoe", Quality = "Starter" },
	{ Id = "Axe", Quality = "Starter" },
	{ Id = "Bucket", Quality = "Starter" },
	{ Id = "FishingRod", Quality = "Starter" },
}

-- Requisition: turn one kingdom "Tools" (or "Weapons") stock unit into a tool.
ItemConfig.Requisition = {
	Hoe = { Stock = "Tools", Quality = "Standard" },
	Pickaxe = { Stock = "Tools", Quality = "Standard" },
	Axe = { Stock = "Tools", Quality = "Standard" },
	FishingRod = { Stock = "Tools", Quality = "Standard" },
	Hammer = { Stock = "Tools", Quality = "Standard" },
	Bucket = { Stock = "Tools", Quality = "Standard" },
	HuntingSpear = { Stock = "Weapons", Quality = "Standard" },
	Sword = { Stock = "Weapons", Quality = "Standard" },
}

-- Blacksmith repairs.
ItemConfig.Repair = {
	IronPerRepair = 1,
	RestoreFraction = 1.0, -- restores to full
	FeeCoins = 8, -- paid by the owner to the blacksmith
	XP = 30,
	MaxQueuePerStation = 20,
}

-- Inventory capacity (weight). Gamepasses / Premium / houses can add more.
ItemConfig.BaseCarryWeight = 60
ItemConfig.BasePersonalStorage = 100
-- Perishables decay in pockets at this fraction of their storage DecayRate.
ItemConfig.InventoryDecayFactor = 1.0

for id, def in pairs(ItemConfig.Tools) do
	def.Id = id
end

function ItemConfig.Get(id: string?)
	return id and ItemConfig.Tools[id] or nil
end

return ItemConfig
