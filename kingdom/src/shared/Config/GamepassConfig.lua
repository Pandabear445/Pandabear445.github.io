--[[
	GamepassConfig (monetization)
	GamePasses and Developer Products. Nothing here can buy a rank, a slot,
	promotion priority over other players, or protection from death resets.
	Replace the 0 IDs with your real asset IDs; entries with Id 0 are ignored.

	Benefit keys understood by MonetizationService:
	  ExtraCarryWeight      number   extra inventory weight
	  ExtraPersonalStorage  number   extra personal storage slots (weight)
	  Title                 string   cosmetic title on nameplate / chat
	  NameplateStyle        string   cosmetic nameplate style
	  Cosmetic              string   cosmetic id (aura/banner/armor tint)
	  Emotes                {string} extra emote ids
	  PremiumHouse          true     may claim houses marked Premium
	  PrivateMeetingRoom    true     may book rooms marked Private
	  JobXPBoost            number   small, capped boost to JobXP only
	  Mount                 string   cosmetic mount id
]]

local GamepassConfig = {}

GamepassConfig.GamePasses = {
	RoyalCosmetics = { Id = 0, DisplayName = "Royal Cosmetic Pack", Benefits = { Cosmetic = "RoyalTrim", Title = "the Resplendent" } },
	ExtraInventory = { Id = 0, DisplayName = "Extra Inventory", Benefits = { ExtraCarryWeight = 30 } },
	ExpandedStorage = { Id = 0, DisplayName = "Expanded Personal Storage", Benefits = { ExtraPersonalStorage = 150 } },
	PremiumHouse = { Id = 0, DisplayName = "Premium House", Benefits = { PremiumHouse = true } },
	PremiumNameplate = { Id = 0, DisplayName = "Premium Nameplate", Benefits = { NameplateStyle = "Gilded" } },
	CosmeticHorse = { Id = 0, DisplayName = "Cosmetic Horse", Benefits = { Mount = "Palfrey" } },
	SpecialEmotes = { Id = 0, DisplayName = "Special Emotes", Benefits = { Emotes = { "Bow", "Salute", "Cheer" } } },
	CustomBanner = { Id = 0, DisplayName = "Custom Banner", Benefits = { Cosmetic = "Banner" } },
	PrivateMeetingRoom = { Id = 0, DisplayName = "Private Meeting Room", Benefits = { PrivateMeetingRoom = true } },
	DecorativeWeapons = { Id = 0, DisplayName = "Decorative Weapons", Benefits = { Cosmetic = "GildedWeapons" } },
	-- Controlled XP boost: JobXP only, and the total multiplier is still capped
	-- by GameConfig.XPLimits.MaxTotalMultiplier.
	ApprenticeLedger = { Id = 0, DisplayName = "Apprentice's Ledger", Benefits = { JobXPBoost = 0.1 } },
}

-- Developer products (consumables). Handlers live in MonetizationService.
GamepassConfig.Products = {
	Fireworks = { Id = 0, DisplayName = "Kingdom Celebration Fireworks", Handler = "Fireworks", Announce = true },
	CosmeticAura = { Id = 0, DisplayName = "Temporary Aura (30 min)", Handler = "TemporaryCosmetic", Cosmetic = "Aura", DurationSeconds = 1800 },
	CosmeticBanner = { Id = 0, DisplayName = "Temporary Banner (30 min)", Handler = "TemporaryCosmetic", Cosmetic = "Banner", DurationSeconds = 1800 },
	-- Donations give a cosmetic title. TreasuryAmount defaults to 0 so money
	-- can't buy kingdom power; raise it only if you accept that trade-off.
	DonationSmall = { Id = 0, DisplayName = "Donation (Patron)", Handler = "Donation", Title = "Patron", TreasuryAmount = 0 },
	DonationLarge = { Id = 0, DisplayName = "Donation (Benefactor)", Handler = "Donation", Title = "Benefactor", TreasuryAmount = 0 },
}

-- Roblox Premium members.
GamepassConfig.Premium = {
	Enabled = true,
	Benefits = { ExtraCarryWeight = 5, Emotes = { "Wave" }, Cosmetic = "PremiumSash" },
}

-- Hard ceiling on any purchasable XP boost.
GamepassConfig.MaxPurchasedXPBoost = 0.15

return GamepassConfig
