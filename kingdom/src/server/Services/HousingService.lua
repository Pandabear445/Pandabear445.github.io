--[[
	HousingService (optional, HousingConfig.Enabled)
	Players rent houses placed as KingdomHouse markers.
	  * MinRank / Premium (gamepass) restrictions, rank-based rent-free living
	  * rent is collected once per in-game day; unpaid rent leads to eviction
	  * a KingdomBed inside sets your respawn point
	  * at home you can use your personal storage, and the house adds space
	The last house is remembered and reclaimed on rejoin if it's still free.
]]

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local HousingConfig = require(ReplicatedStorage.Kingdom.Config.HousingConfig)
local JobConfig = require(ReplicatedStorage.Kingdom.Config.JobConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local PromptUtil = require(script.Parent.Parent.Core.PromptUtil)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local HousingService = {
	Name = "HousingService",
	Dependencies = {
		"DataService",
		"EconomyService",
		"RankService",
		"InventoryService",
		"CharacterService",
		"NotificationService",
		"TimeService",
		"MonetizationService",
		"AuditService",
	},
}

local HOUSE_TAG = "KingdomHouse"
local BED_TAG = "KingdomBed"

function HousingService:Init()
	self._data = self:Use("DataService")
	self._economy = self:Use("EconomyService")
	self._rank = self:Use("RankService")
	self._inventory = self:Use("InventoryService")
	self._character = self:Use("CharacterService")
	self._notify = self:Use("NotificationService")
	self._time = self:Use("TimeService")
	self._monetization = self:Use("MonetizationService")
	self._audit = self:Use("AuditService")

	self._houses = {} -- [Instance] = { id, tenant, missed, prompt }
	self._homeOf = {} -- [Player] = Instance

	self._inventory:RegisterStorageBonus("Housing", function(player)
		local house = self._homeOf[player]
		return house and ZoneUtil.readAttribute(house, "Storage", HousingConfig.DefaultStorage) or 0
	end)
	Players.PlayerRemoving:Connect(function(player)
		self:_vacate(player, false)
	end)
	self._time.MinuteChanged:Connect(function(_, hour)
		if math.abs(hour - HousingConfig.RentHour) < 1 / 120 then
			self:_collectRent()
		end
	end)
end

function HousingService:Start()
	if not HousingConfig.Enabled then
		return
	end
	for _, house in ipairs(CollectionService:GetTagged(HOUSE_TAG)) do
		self:_setup(house)
	end
	CollectionService:GetInstanceAddedSignal(HOUSE_TAG):Connect(function(house)
		self:_setup(house)
	end)
	self.Registry:Every(self.Name, "atHome", 2, function()
		for _, player in ipairs(Players:GetPlayers()) do
			local house = self._homeOf[player]
			player:SetAttribute("KingdomAtHome", house ~= nil and ZoneUtil.playerInside(player, house, 2))
		end
	end)
end

local function houseId(house: Instance): string
	return ZoneUtil.readAttribute(house, "HouseId", house.Name)
end

function HousingService:_setup(house: Instance)
	if self._houses[house] then
		return
	end
	local parent = ZoneUtil.getPromptParent(house) or PromptUtil.anchorFor(house)
	local record = { id = houseId(house), tenant = nil, missed = 0 }
	record.prompt = PromptUtil.create(parent, {
		Name = "KingdomHouse",
		ActionText = "Rent house",
		ObjectText = record.id,
		HoldDuration = 1,
		MaxDistance = 12,
	})
	self._houses[house] = record
	self:_refresh(house)
	PromptUtil.onTriggered(record.prompt, function(player, held)
		if not PromptUtil.heldLongEnough(held, 1, JobConfig.Session.HoldTolerance) then
			return
		end
		local ok, message
		if record.tenant == player.UserId then
			ok, message = self:_vacate(player, true)
		else
			ok, message = self:Rent(player, house)
		end
		if message then
			self._notify:Notify(player, ok and "Success" or "Warning", "Housing", message)
		end
	end)
	for _, bed in ipairs(house:GetDescendants()) do
		if bed:HasTag(BED_TAG) then
			local bedParent = ZoneUtil.getPromptParent(bed)
			if bedParent then
				local bedPrompt = PromptUtil.create(bedParent, {
					Name = "KingdomBed",
					ActionText = "Set home",
					HoldDuration = 1,
					MaxDistance = 8,
				})
				PromptUtil.onTriggered(bedPrompt, function(player)
					if record.tenant == player.UserId then
						local position = ZoneUtil.getPosition(bed) or Vector3.zero
						self._character:SetSpawnOverride(player, CFrame.new(position + Vector3.new(0, 4, 0)))
						self._notify:Notify(player, "Success", "Home", "You will wake up here.")
					end
				end)
			end
		end
	end
end

function HousingService:_refresh(house: Instance)
	local record = self._houses[house]
	if not record then
		return
	end
	local tenant = record.tenant and Players:GetPlayerByUserId(record.tenant)
	if tenant then
		record.prompt.ActionText = "Leave house"
		record.prompt.ObjectText = record.id .. " · home of " .. tenant.DisplayName
	else
		record.prompt.ActionText = "Rent house"
		local minRank = RankConfig.Get(house:GetAttribute("MinRank"))
		record.prompt.ObjectText = string.format(
			"%s · %d coins/day%s%s",
			record.id,
			ZoneUtil.readAttribute(house, "RentPrice", HousingConfig.DefaultRent),
			minRank and (" · " .. minRank.DisplayName .. "+") or "",
			house:GetAttribute("Premium") and " · Premium" or ""
		)
	end
end

function HousingService:_isRentFree(player: Player): boolean
	return self._rank:GetOrder(player) >= HousingConfig.RentFreeFromOrder
end

function HousingService:Rent(player: Player, house: Instance)
	local record = self._houses[house]
	if not record or record.tenant then
		return false, "This house is taken."
	end
	if self._homeOf[player] then
		return false, "You already have a home."
	end
	local minRank = RankConfig.Get(house:GetAttribute("MinRank"))
	if minRank and self._rank:GetOrder(player) < minRank.Order then
		return false, "Reserved for " .. minRank.DisplayName .. "s and above."
	end
	if house:GetAttribute("Premium") and not self._monetization:HasBenefit(player, "PremiumHouse") then
		return false, "This is a premium house."
	end
	local rent = ZoneUtil.readAttribute(house, "RentPrice", HousingConfig.DefaultRent)
	if rent > 0 and not self:_isRentFree(player) then
		if not self._economy:RemoveCoins(player, rent, "Rent") then
			return false, string.format("Rent is %d coins per day.", rent)
		end
		self._economy:TreasuryDeposit(rent, "Rent")
	end
	record.tenant = player.UserId
	record.missed = 0
	self._homeOf[player] = house
	local profile = self._data:Get(player)
	if profile then
		profile.Home = record.id
	end
	self._audit:Log("System", "HouseRented", { userId = player.UserId, house = record.id })
	self._inventory:Publish(player)
	self:_refresh(house)
	return true, "Welcome home!"
end

function HousingService:_vacate(player: Player, voluntary: boolean)
	local house = self._homeOf[player]
	if not house then
		return false, nil
	end
	local record = self._houses[house]
	if record then
		record.tenant = nil
		record.missed = 0
	end
	self._homeOf[player] = nil
	self._character:SetSpawnOverride(player, nil)
	if voluntary then
		local profile = self._data:Get(player)
		if profile then
			profile.Home = nil
		end
	end
	self:_refresh(house)
	return true, "You moved out."
end

function HousingService:_collectRent()
	for house, record in pairs(self._houses) do
		local tenant = record.tenant and Players:GetPlayerByUserId(record.tenant)
		if tenant and not self:_isRentFree(tenant) then
			local rent = ZoneUtil.readAttribute(house, "RentPrice", HousingConfig.DefaultRent)
			if rent > 0 then
				if self._economy:RemoveCoins(tenant, rent, "Rent") then
					self._economy:TreasuryDeposit(rent, "Rent")
					record.missed = 0
				else
					record.missed += 1
					if record.missed >= HousingConfig.EvictAfterMissedRent then
						self:_vacate(tenant, true)
						self._notify:Notify(tenant, "Warning", "Evicted", "You could not pay your rent.")
					else
						self._notify:Notify(tenant, "Warning", "Rent overdue", "Pay tomorrow or you will be evicted.")
					end
				end
			end
		end
	end
end

-- Rejoin: reclaim the remembered house if it's free.
function HousingService:OnPlayerJoin(player: Player)
	local profile = self._data:Get(player)
	if not HousingConfig.Enabled or not profile or not profile.Home then
		return
	end
	for house, record in pairs(self._houses) do
		if record.id == profile.Home and not record.tenant then
			record.tenant = player.UserId
			self._homeOf[player] = house
			self:_refresh(house)
			return
		end
	end
end

return HousingService
