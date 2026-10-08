--[[
	MarketService
	Trading at KingdomMarket markers (players must be physically there).

	  Kingdom -> Player  buy from kingdom storage at a supply/demand price
	                     (scarce food gets expensive) + market tax
	  Player -> Kingdom  sell to the kingdom at the sell spread
	  Player -> Player   post listings; goods are held in escrow inside the
	                     seller's saved profile until sold, expired or the
	                     seller leaves, so nothing can be duplicated or lost.

	Every transfer re-checks stock/coins at execution time on the server.
]]

local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local EconomyConfig = require(ReplicatedStorage.Kingdom.Config.EconomyConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)
local PromptUtil = require(script.Parent.Parent.Core.PromptUtil)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local MarketService = {
	Name = "MarketService",
	Dependencies = {
		"EconomyService",
		"InventoryService",
		"ResourceService",
		"RankService",
		"NotificationService",
		"AuditService",
		"DataService",
		"TimeService",
		"ActivityService",
	},
}

local MARKET_TAG = "KingdomMarket"
local MARKET_DISTANCE = 24

function MarketService:Init()
	self._economy = self:Use("EconomyService")
	self._inventory = self:Use("InventoryService")
	self._resources = self:Use("ResourceService")
	self._rank = self:Use("RankService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")
	self._data = self:Use("DataService")
	self._time = self:Use("TimeService")
	self._activity = self:Use("ActivityService")

	self._listings = {} -- [listingId] = listing

	local function atMarket(player: Player): boolean
		for _, marker in ipairs(CollectionService:GetTagged(MARKET_TAG)) do
			if ZoneUtil.playerDistance(player, marker) <= MARKET_DISTANCE then
				return true
			end
		end
		return false
	end
	self._atMarket = atMarket

	Net.Query("Market", { rate = 1, burst = 3 }, function(player)
		return self:GetView(player)
	end)
	Net.Action("Market", "Buy", { rate = 2, burst = 4 }, function(player, payload)
		if not atMarket(player) then
			return false, "You must be at a market."
		end
		return self:BuyFromKingdom(player, Check.key(payload.resource, ResourceConfig.Resources), Check.integer(payload.amount, 1, EconomyConfig.Market.MaxUnitsPerTransaction))
	end)
	Net.Action("Market", "Sell", { rate = 2, burst = 4 }, function(player, payload)
		if not atMarket(player) then
			return false, "You must be at a market."
		end
		return self:SellToKingdom(player, Check.key(payload.resource, ResourceConfig.Resources), Check.integer(payload.amount, 1, EconomyConfig.Market.MaxUnitsPerTransaction))
	end)
	Net.Action("Market", "List", { rate = 0.5, burst = 2 }, function(player, payload)
		if not atMarket(player) then
			return false, "You must be at a market."
		end
		return self:PostListing(
			player,
			Check.key(payload.resource, ResourceConfig.Resources),
			Check.integer(payload.amount, 1, EconomyConfig.Market.MaxUnitsPerTransaction),
			Check.integer(payload.price, 1, 100000)
		)
	end)
	Net.Action("Market", "BuyListing", { rate = 2, burst = 4 }, function(player, payload)
		if not atMarket(player) then
			return false, "You must be at a market."
		end
		return self:BuyListing(player, Check.string(payload.listing, 64))
	end)
	Net.Action("Market", "CancelListing", { rate = 1, burst = 3 }, function(player, payload)
		return self:CancelListing(player, Check.string(payload.listing, 64), "Cancelled")
	end)

	self._time.HourChanged:Connect(function()
		self:_expire()
	end)
end

function MarketService:Start()
	local function setup(marker: Instance)
		if marker:GetAttribute("KingdomMarketReady") then
			return
		end
		marker:SetAttribute("KingdomMarketReady", true)
		local parent = ZoneUtil.getPromptParent(marker) or PromptUtil.anchorFor(marker)
		local prompt = PromptUtil.create(parent, {
			Name = "KingdomMarket",
			ActionText = "Trade",
			ObjectText = marker.Name,
			MaxDistance = 14,
		})
		PromptUtil.onTriggered(prompt, function(player)
			Net.Fire("Effect", player, "OpenMarket", {})
		end)
	end
	for _, marker in ipairs(CollectionService:GetTagged(MARKET_TAG)) do
		setup(marker)
	end
	CollectionService:GetInstanceAddedSignal(MARKET_TAG):Connect(setup)
end

-- Kingdom market ------------------------------------------------------------------

function MarketService:QuoteBuy(player: Player, resourceId: string, amount: number): (number, number)
	local unit = self._economy:GetBuyPrice(resourceId)
	local discount = self._rank:GetRankDef(player).Privileges.MarketDiscount or 0
	local subtotal = math.ceil(unit * amount * (1 - discount))
	local tax = math.ceil(subtotal * self._economy:GetTax("Market"))
	if ResourceConfig.IsFood(resourceId) then
		tax += math.ceil(subtotal * self._economy:GetTax("Food"))
	end
	return subtotal, tax
end

function MarketService:BuyFromKingdom(player: Player, resourceId: string?, amount: number?)
	if not resourceId or not amount then
		return false, "Invalid order."
	end
	amount = math.min(amount, self._resources:GetStock(resourceId), self._inventory:RoomFor(player, resourceId))
	if amount <= 0 then
		return false, "None available, or your pack is full."
	end
	local subtotal, tax = self:QuoteBuy(player, resourceId, amount)
	if not self._economy:RemoveCoins(player, subtotal + tax, "MarketBuy") then
		return false, string.format("That costs %d coins.", subtotal + tax)
	end
	local taken = self._resources:Withdraw(resourceId, amount, "MarketSale", player)
	if taken < amount then
		-- Stock moved between checks: refund the difference.
		local refundSubtotal, refundTax = self:QuoteBuy(player, resourceId, amount - taken)
		self._economy:AddCoins(player, refundSubtotal + refundTax, "MarketRefund")
		subtotal -= refundSubtotal
		tax -= refundTax
		amount = taken
	end
	if amount <= 0 then
		return false, "Sold out."
	end
	local added = self._inventory:Add(player, resourceId, amount, "MarketBuy")
	self._inventory:AddTaint(player, resourceId, added)
	self._economy:TreasuryDeposit(subtotal, "MarketSales")
	if tax > 0 then
		self._economy:TreasuryDeposit(tax, "MarketTax")
	end
	self._activity:MarkInteraction(player)
	self._audit:Log("Market", "Buy", { userId = player.UserId, resource = resourceId, amount = amount, paid = subtotal + tax })
	return true, string.format("Bought %d %s for %d coins.", amount, ResourceConfig.Resources[resourceId].DisplayName, subtotal + tax)
end

function MarketService:SellToKingdom(player: Player, resourceId: string?, amount: number?)
	if not resourceId or not amount then
		return false, "Invalid order."
	end
	amount = math.min(amount, self._inventory:Count(player, resourceId), self._resources:FreeSpaceFor(resourceId))
	if amount <= 0 then
		return false, "You have none, or the kingdom's storage is full."
	end
	local unit = self._economy:GetSellPrice(resourceId)
	local gross = unit * amount
	local tax = math.floor(gross * self._economy:GetTax("Market"))
	if self._economy:GetTreasury() < gross then
		return false, "The treasury cannot afford to buy that right now."
	end
	if not self._inventory:Remove(player, resourceId, amount, "MarketSell") then
		return false, "You have none."
	end
	self._inventory:ConsumeTaint(player, resourceId, amount)
	self._resources:Deposit(resourceId, amount, "MarketPurchase", player)
	self._economy:TreasuryWithdraw(gross, "MarketPurchases")
	if tax > 0 then
		self._economy:TreasuryDeposit(tax, "MarketTax")
	end
	self._economy:AddCoins(player, gross - tax, "MarketSell", true)
	self._activity:MarkInteraction(player)
	self._audit:Log("Market", "Sell", { userId = player.UserId, resource = resourceId, amount = amount, received = gross - tax })
	return true, string.format("Sold %d for %d coins.", amount, gross - tax)
end

-- Player listings -------------------------------------------------------------------

function MarketService:_countListings(player: Player): number
	local count = 0
	for _, listing in pairs(self._listings) do
		if listing.seller == player then
			count += 1
		end
	end
	return count
end

function MarketService:PostListing(player: Player, resourceId: string?, amount: number?, price: number?)
	if not resourceId or not amount or not price then
		return false, "Invalid listing."
	end
	if self:_countListings(player) >= EconomyConfig.Market.MaxListingsPerPlayer then
		return false, "You have too many listings."
	end
	if not self._inventory:Remove(player, resourceId, amount, "Listing") then
		return false, "You don't have that many."
	end
	local profile = self._data:Get(player)
	local id = HttpService:GenerateGUID(false)
	profile.Escrow[id] = { Type = "Listing", Item = resourceId, Amount = amount }
	self._listings[id] = {
		id = id,
		seller = player,
		resource = resourceId,
		amount = amount,
		price = price,
		expiresAt = self._time:GetAbsoluteMinutes() + EconomyConfig.Market.ListingDurationGameHours * 60,
	}
	self._audit:Log("Market", "List", { userId = player.UserId, resource = resourceId, amount = amount, price = price })
	return true, "Listed."
end

function MarketService:BuyListing(buyer: Player, listingId: string?)
	local listing = listingId and self._listings[listingId]
	if not listing then
		return false, "That listing is gone."
	end
	local seller = listing.seller
	if seller == buyer then
		return false, "You can't buy your own listing."
	end
	if seller.Parent ~= Players or not self._data:Get(seller) then
		self._listings[listingId] = nil
		return false, "The seller has left."
	end
	if self._inventory:RoomFor(buyer, listing.resource) < listing.amount then
		return false, "Your pack is too full."
	end
	local total = listing.price
	local tax = math.floor(total * self._economy:GetTax("Market"))
	-- Remove from the registry first so two buyers can never both win.
	self._listings[listingId] = nil
	if not self._economy:RemoveCoins(buyer, total, "ListingBuy") then
		self._listings[listingId] = listing
		return false, string.format("That costs %d coins.", total)
	end
	local sellerProfile = self._data:Get(seller)
	sellerProfile.Escrow[listingId] = nil
	self._inventory:Add(buyer, listing.resource, listing.amount, "ListingBuy")
	self._economy:AddCoins(seller, total - tax, "ListingSale", true)
	if tax > 0 then
		self._economy:TreasuryDeposit(tax, "MarketTax")
	end
	self._notify:Notify(seller, "Economy", "Sold!", string.format("%s bought your %d %s for %d coins.", buyer.DisplayName, listing.amount, ResourceConfig.Resources[listing.resource].DisplayName, total - tax))
	self._audit:Log("Market", "ListingSold", { seller = seller.UserId, buyer = buyer.UserId, resource = listing.resource, amount = listing.amount, price = total })
	return true, "Purchased."
end

function MarketService:CancelListing(player: Player, listingId: string?, reason: string)
	local listing = listingId and self._listings[listingId]
	if not listing or listing.seller ~= player then
		return false, "Not your listing."
	end
	self._listings[listingId] = nil
	self:_returnEscrow(player, listingId)
	self._audit:Log("Market", "ListingCancelled", { userId = player.UserId, reason = reason })
	return true, "Listing cancelled."
end

function MarketService:_returnEscrow(player: Player, escrowId: string)
	local profile = self._data:Get(player)
	local escrow = profile and profile.Escrow[escrowId]
	if not escrow or escrow.Type ~= "Listing" then
		return
	end
	local added = self._inventory:Add(player, escrow.Item, escrow.Amount, "EscrowReturn")
	if added >= escrow.Amount then
		profile.Escrow[escrowId] = nil
	else
		escrow.Amount -= added -- stays in escrow; returned next time there's room
	end
end

function MarketService:_expire()
	local nowMinute = self._time:GetAbsoluteMinutes()
	for id, listing in pairs(self._listings) do
		if nowMinute >= listing.expiresAt then
			self._listings[id] = nil
			if listing.seller.Parent == Players then
				self:_returnEscrow(listing.seller, id)
				self._notify:Notify(listing.seller, "Economy", "Listing expired", "Your unsold goods were returned.")
			end
		end
	end
end

-- Session hooks -------------------------------------------------------------------

function MarketService:OnPlayerJoin(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return
	end
	for escrowId, escrow in pairs(profile.Escrow) do
		if escrow.Type == "Listing" and not self._listings[escrowId] then
			self:_returnEscrow(player, escrowId)
		end
	end
end

-- Rollback on leave: listings close, goods stay in the saved escrow and
-- are returned on the next join.
function MarketService:OnPlayerLeave(player: Player)
	for id, listing in pairs(self._listings) do
		if listing.seller == player then
			self._listings[id] = nil
			self:_returnEscrow(player, id)
		end
	end
end

function MarketService:GetView(player: Player)
	local prices = {}
	for resourceId, def in pairs(ResourceConfig.Resources) do
		local subtotal, tax = self:QuoteBuy(player, resourceId, 1)
		prices[resourceId] = {
			Name = def.DisplayName,
			Icon = def.Icon,
			Buy = subtotal + tax,
			Sell = self._economy:GetSellPrice(resourceId),
			Stock = self._resources:GetStock(resourceId),
			Base = def.BaseValue,
		}
	end
	local listings = {}
	for id, listing in pairs(self._listings) do
		table.insert(listings, {
			Id = id,
			Seller = listing.seller.DisplayName,
			Mine = listing.seller == player,
			Resource = listing.resource,
			Amount = listing.amount,
			Price = listing.price,
		})
	end
	return {
		AtMarket = self._atMarket(player),
		Prices = prices,
		Listings = listings,
		Taxes = self._economy:GetTaxes(),
		Coins = self._economy:GetCoins(player),
	}
end

return MarketService
