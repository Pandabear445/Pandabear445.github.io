--[[
	HousingConfig (optional system)
	Houses are KingdomHouse markers (Model or Part) with attributes:
	  HouseId     unique name
	  RentPrice   coins per in-game day (0 = free for eligible ranks)
	  MinRank     lowest rank Id allowed
	  Premium     requires the PremiumHouse gamepass
	  Storage     extra personal storage weight while you live there
	A KingdomBed inside the house sets your respawn point.
]]

local HousingConfig = {}

HousingConfig.Enabled = true
HousingConfig.DefaultRent = 15
HousingConfig.DefaultStorage = 40
HousingConfig.RentHour = 7.5 -- in-game hour when rent is collected
HousingConfig.EvictAfterMissedRent = 2
-- Ranks at or above this Order live rent-free.
HousingConfig.RentFreeFromOrder = 7

return HousingConfig
