--[[
	EconomyConfig
	Personal coins, the kingdom treasury, taxes, salaries and market pricing.

	Money flow
	  Treasury IN : taxes (income/market/trade/food), kingdom market sales,
	                exports by merchants, crown revenue (scaled by stability)
	  Treasury OUT: job wages, delivery payments, salaries, imports,
	                construction funding, repairs
	When the treasury cannot pay, wages are paid partially and morale falls.
]]

local EconomyConfig = {}

EconomyConfig.Currency = {
	Name = "Coins",
	Symbol = "c",
	StartingCoins = 25,
	MaxCoins = 10_000_000,
}

EconomyConfig.Treasury = {
	Starting = 2500,
	-- Crown revenue per in-game hour = (Base + PerPlayer * players) * stabilityFactor
	CrownRevenueBase = 30,
	CrownRevenuePerPlayer = 10,
	-- The crown earns this share of the base value of goods delivered to
	-- storage each hour (the kingdom's economy putting them to use). Working
	-- kingdoms fund themselves; idle ones go broke and can't pay wages.
	ProductionLevy = 0.6,
	-- Below this the government is "poor": warnings + morale penalty.
	LowThreshold = 300,
}

-- Taxes: rate bounds and the default. "Fair" is the rate players accept
-- without a morale penalty; each 1% above it costs MoralePerPointAbove.
EconomyConfig.Taxes = {
	Income = { Default = 0.10, Min = 0, Max = 0.40, Fair = 0.12, DisplayName = "Income Tax" },
	Market = { Default = 0.05, Min = 0, Max = 0.30, Fair = 0.08, DisplayName = "Market Tax" },
	Trade = { Default = 0.10, Min = 0, Max = 0.40, Fair = 0.12, DisplayName = "Trade Tax" },
	Food = { Default = 0.05, Min = 0, Max = 0.30, Fair = 0.06, DisplayName = "Food Tax" },
}
EconomyConfig.MoralePerPointAbove = 0.6 -- morale points per 1% above fair (summed)
EconomyConfig.ProductivityPerPointBelow = 0.004 -- productivity bonus per 1% below fair
EconomyConfig.TaxChangeCooldownGameMinutes = 60

-- Salaries are paid at these in-game hours (rank Salary split across paydays).
EconomyConfig.PaydayHours = { 12, 21 }
-- A player must have earned at least this much XP since the last payday to
-- receive a salary. Salaries are never paid for simply being online.
EconomyConfig.SalaryMinActivityXP = 40

-- Market pricing: price = BaseValue * clamp((target / stock) ^ Elasticity)
EconomyConfig.Market = {
	Elasticity = 0.6,
	MinMultiplier = 0.4,
	MaxMultiplier = 4.0,
	SellSpread = 0.6, -- kingdom buys from players at 60% of the buy price
	MaxUnitsPerTransaction = 50,
	ListingDurationGameHours = 6,
	MaxListingsPerPlayer = 5,
	MinTargetStock = 20,
}

-- Imports (Government.Treasury): buy goods from abroad at a premium.
EconomyConfig.Imports = {
	PriceMultiplier = 1.6,
	MaxUnitsPerOrder = 200,
	ArrivalGameMinutes = 30,
}

-- Player to player trades.
EconomyConfig.Trade = {
	MaxItemsPerSide = 8,
	OfferTimeoutSeconds = 60,
	MaxDistance = 25,
}

return EconomyConfig
