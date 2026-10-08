--[[
	EconomyService
	Personal coins, the kingdom treasury, taxes, wages and salaries.

	Wages and salaries are paid FROM the treasury. When the treasury cannot
	afford them, workers are paid partially and the shortfall is recorded;
	KingdomService turns unpaid wages into falling morale. This is one link of
	the chain:  production falls -> income falls -> wages unpaid ->
	morale falls -> productivity falls.

	Taxes raise treasury income but cost morale above their "fair" level
	and reduce productivity; low taxes do the opposite.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local EconomyConfig = require(ReplicatedStorage.Kingdom.Config.EconomyConfig)
local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local StoreUtil = require(script.Parent.Parent.Core.StoreUtil)

local EconomyService = {
	Name = "EconomyService",
	Dependencies = {
		"DataService",
		"AuditService",
		"StateService",
		"TimeService",
		"NotificationService",
		"RankService",
		"ResourceService",
		"XPService",
	},
}

local TREASURY_KEY = "Treasury"

function EconomyService:Init()
	self._data = self:Use("DataService")
	self._audit = self:Use("AuditService")
	self._state = self:Use("StateService")
	self._time = self:Use("TimeService")
	self._notify = self:Use("NotificationService")
	self._rank = self:Use("RankService")
	self._resources = self:Use("ResourceService")
	self._xp = self:Use("XPService")

	self.TaxChanged = Signal.new("TaxChanged") -- (name, rate)
	self.WagesUnpaid = Signal.new("WagesUnpaid") -- (amount)
	self.TreasuryChanged = Signal.new("TreasuryChanged")

	self._treasury = EconomyConfig.Treasury.Starting
	self._pendingDelta = 0
	self._taxes = {}
	self._taxChangedAt = {}
	for name, def in pairs(EconomyConfig.Taxes) do
		self._taxes[name] = def.Default
	end
	self._ledger = { current = { income = {}, expense = {} }, previous = { income = {}, expense = {} } }
	self._unpaidThisPeriod = 0
	self._xpSincePayday = {}
	self._revenueModifier = nil

	self._global = GameConfig.KingdomScope == "Global" and GameConfig.Global.PersistTreasury
	if self._global then
		self._treasuryStore = StoreUtil.GetDataStore(GameConfig.Global.TreasuryDataStore)
		self:_syncGlobalTreasury()
	end

	self._xp.XPChanged:Connect(function(player, _, delta)
		if delta > 0 then
			self._xpSincePayday[player] = (self._xpSincePayday[player] or 0) + delta
		end
	end)
	Players.PlayerRemoving:Connect(function(player)
		self._xpSincePayday[player] = nil
	end)
	self._data.Loaded:Connect(function(player)
		self:PublishPlayer(player)
	end)

	self._time.MinuteChanged:Connect(function(_, hour)
		for _, payday in ipairs(EconomyConfig.PaydayHours) do
			if math.abs(hour - payday) < 1 / 120 then
				self:_payday()
			end
		end
	end)
	self._time.HourChanged:Connect(function()
		self:_crownRevenue()
		self._ledger.previous = self._ledger.current
		self._ledger.current = { income = {}, expense = {} }
		self:_publishTreasury()
	end)
end

function EconomyService:Start()
	self:_publishTreasury()
	if self._global then
		self.Registry:Every(self.Name, "treasurySync", 30, function()
			self:_syncGlobalTreasury()
		end)
	end
end

-- Coins ---------------------------------------------------------------------------

function EconomyService:GetCoins(player: Player): number
	local profile = self._data:Get(player)
	return profile and profile.Coins or 0
end

-- earned = true counts toward lifetime money earned.
function EconomyService:AddCoins(player: Player, amount: number, reason: string, earned: boolean?): number
	local profile = self._data:Get(player)
	if not profile or amount <= 0 or amount ~= amount then
		return 0
	end
	amount = math.floor(amount)
	local room = EconomyConfig.Currency.MaxCoins - profile.Coins
	amount = math.min(amount, room)
	if amount <= 0 then
		return 0
	end
	profile.Coins += amount
	if earned then
		profile.Lifetime.MoneyEarned += amount
	end
	self._audit:Log("Currency", "Add", { userId = player.UserId, amount = amount, reason = reason })
	self:PublishPlayer(player)
	return amount
end

function EconomyService:RemoveCoins(player: Player, amount: number, reason: string): boolean
	local profile = self._data:Get(player)
	amount = math.floor(amount)
	if not profile or amount <= 0 or profile.Coins < amount then
		return false
	end
	profile.Coins -= amount
	self._audit:Log("Currency", "Remove", { userId = player.UserId, amount = amount, reason = reason })
	self:PublishPlayer(player)
	return true
end

function EconomyService:Transfer(from: Player, to: Player, amount: number, reason: string): boolean
	if from == to or not self._data:Get(to) then
		return false
	end
	if not self:RemoveCoins(from, amount, "TransferOut:" .. reason) then
		return false
	end
	self:AddCoins(to, amount, "TransferIn:" .. reason, false)
	return true
end

function EconomyService:PublishPlayer(player: Player)
	local profile = self._data:Get(player)
	if profile then
		player:SetAttribute("KingdomCoins", profile.Coins)
		self._state:Set(player, "Coins", profile.Coins)
	end
end

-- Treasury -----------------------------------------------------------------------

local function bump(map, category: string, amount: number)
	map[category] = (map[category] or 0) + amount
end

function EconomyService:GetTreasury(): number
	return math.floor(self._treasury)
end

function EconomyService:TreasuryDeposit(amount: number, category: string)
	if amount <= 0 or amount ~= amount then
		return
	end
	self._treasury += amount
	self._pendingDelta += amount
	bump(self._ledger.current.income, category, amount)
	self._audit:Log("Treasury", "Income", { amount = math.floor(amount), category = category })
	self.TreasuryChanged:Fire()
end

function EconomyService:TreasuryWithdraw(amount: number, category: string): boolean
	if amount <= 0 or amount ~= amount or self._treasury < amount then
		return false
	end
	self._treasury -= amount
	self._pendingDelta -= amount
	bump(self._ledger.current.expense, category, amount)
	self._audit:Log("Treasury", "Expense", { amount = math.floor(amount), category = category })
	self.TreasuryChanged:Fire()
	return true
end

-- Pays a wage from the treasury, taxed by income tax. Returns net paid.
function EconomyService:PayWage(player: Player, gross: number, reason: string): number
	gross = math.floor(gross + 0.5)
	if gross <= 0 or not self._data:Get(player) then
		return 0
	end
	local payable = math.min(gross, math.floor(self._treasury))
	if payable < gross then
		local unpaid = gross - payable
		self._unpaidThisPeriod += unpaid
		self.WagesUnpaid:Fire(unpaid)
	end
	if payable <= 0 then
		return 0
	end
	self:TreasuryWithdraw(payable, "Wages")
	local tax = math.floor(payable * self:GetTax("Income") + 0.5)
	if tax > 0 then
		self:TreasuryDeposit(tax, "IncomeTax")
	end
	return self:AddCoins(player, payable - tax, reason, true)
end

-- Unpaid wages since last call (KingdomService reads & resets for morale).
function EconomyService:TakeUnpaidWages(): number
	local amount = self._unpaidThisPeriod
	self._unpaidThisPeriod = 0
	return amount
end

function EconomyService:SetRevenueModifier(fn: () -> number)
	self._revenueModifier = fn
end

function EconomyService:_crownRevenue()
	local players = #Players:GetPlayers()
	local base = EconomyConfig.Treasury.CrownRevenueBase + EconomyConfig.Treasury.CrownRevenuePerPlayer * players
	local modifier = 1
	if self._revenueModifier then
		local ok, value = pcall(self._revenueModifier)
		if ok and type(value) == "number" then
			modifier = value
		end
	end
	self:TreasuryDeposit(base * modifier, "CrownRevenue")
end

function EconomyService:_payday()
	local paydays = #EconomyConfig.PaydayHours
	local paid, skipped = 0, 0
	for _, player in ipairs(Players:GetPlayers()) do
		local rank = self._rank:GetRankDef(player)
		local salary = (rank.Salary or 0) / paydays
		if salary > 0 and self._data:IsLoaded(player) then
			if (self._xpSincePayday[player] or 0) >= EconomyConfig.SalaryMinActivityXP then
				local net = self:PayWage(player, salary, "Salary")
				paid += net
				self._notify:Notify(player, "Economy", "Payday", string.format("Salary received: %d coins.", net))
			else
				skipped += 1
				self._notify:Notify(player, "Economy", "No salary", "Salaries are only paid to those who worked since the last payday.")
			end
		end
		self._xpSincePayday[player] = 0
	end
	self._audit:Log("Treasury", "Payday", { paid = paid, skipped = skipped })
	self:_publishTreasury()
end

-- Global treasury: each server flushes its delta and adopts the shared balance.
function EconomyService:_syncGlobalTreasury()
	if not self._treasuryStore then
		return
	end
	local delta = self._pendingDelta
	self._pendingDelta = 0
	local taxes = self._taxes
	local ok, result = pcall(function()
		return self._treasuryStore:UpdateAsync(TREASURY_KEY, function(stored)
			stored = stored or { Balance = EconomyConfig.Treasury.Starting, Taxes = taxes, TaxVersion = 0 }
			stored.Balance = math.max(0, (stored.Balance or 0) + delta)
			if self._taxDirty then
				stored.Taxes = taxes
				stored.TaxVersion = (stored.TaxVersion or 0) + 1
			end
			return stored
		end)
	end)
	if ok and type(result) == "table" then
		self._treasury = result.Balance
		if not self._taxDirty and type(result.Taxes) == "table" then
			for name, rate in pairs(result.Taxes) do
				if EconomyConfig.Taxes[name] and type(rate) == "number" then
					self._taxes[name] = rate
				end
			end
		end
		self._taxDirty = false
		self:_publishTreasury()
	else
		self._pendingDelta += delta -- retry next time; never lose the delta
	end
end

-- Taxes ----------------------------------------------------------------------------

function EconomyService:GetTax(name: string): number
	return self._taxes[name] or 0
end

function EconomyService:GetTaxes()
	return table.clone(self._taxes)
end

-- Returns ok, message. Permission is checked by the caller (Government).
function EconomyService:SetTax(name: string, rate: number, byName: string?): (boolean, string)
	local def = EconomyConfig.Taxes[name]
	if not def or type(rate) ~= "number" or rate ~= rate then
		return false, "Unknown tax."
	end
	rate = math.clamp(math.floor(rate * 100 + 0.5) / 100, def.Min, def.Max)
	local nowMinute = self._time:GetAbsoluteMinutes()
	local last = self._taxChangedAt[name]
	if last and nowMinute - last < EconomyConfig.TaxChangeCooldownGameMinutes then
		return false, "That tax was changed too recently."
	end
	local old = self._taxes[name]
	self._taxes[name] = rate
	self._taxChangedAt[name] = nowMinute
	self._taxDirty = true
	self._audit:Log("Government", "TaxChanged", { tax = name, from = old, to = rate, by = byName })
	self._notify:Announce(
		"Government",
		"Royal Decree",
		string.format("%s set to %d%% (was %d%%).", def.DisplayName, math.floor(rate * 100 + 0.5), math.floor(old * 100 + 0.5))
	)
	self.TaxChanged:Fire(name, rate)
	self:_publishTreasury()
	return true, "Tax updated."
end

-- Sum of percentage points above fair across all taxes (morale input).
function EconomyService:GetTaxBurden(): (number, number)
	local above, below = 0, 0
	for name, def in pairs(EconomyConfig.Taxes) do
		local diff = (self._taxes[name] - def.Fair) * 100
		if diff > 0 then
			above += diff
		else
			below += -diff
		end
	end
	return above, below
end

-- Prices -----------------------------------------------------------------------------

function EconomyService:GetBuyPrice(resourceId: string): number
	local def = ResourceConfig.Resources[resourceId]
	if not def then
		return math.huge
	end
	local market = EconomyConfig.Market
	local players = math.max(#Players:GetPlayers(), 1)
	local target = math.max(market.MinTargetStock, (def.TargetPerCapita or 5) * players)
	local stock = math.max(self._resources:GetStock(resourceId), 1)
	local multiplier = math.clamp((target / stock) ^ market.Elasticity, market.MinMultiplier, market.MaxMultiplier)
	return math.max(1, math.floor(def.BaseValue * multiplier + 0.5))
end

function EconomyService:GetSellPrice(resourceId: string): number
	return math.max(1, math.floor(self:GetBuyPrice(resourceId) * EconomyConfig.Market.SellSpread))
end

function EconomyService:_publishTreasury()
	local function total(map)
		local sum = 0
		for _, value in pairs(map) do
			sum += value
		end
		return math.floor(sum)
	end
	self._state:SetGlobal("Treasury", {
		Balance = self:GetTreasury(),
		Taxes = self:GetTaxes(),
		LastHourIncome = total(self._ledger.previous.income),
		LastHourExpense = total(self._ledger.previous.expense),
		Income = self._ledger.previous.income,
		Expense = self._ledger.previous.expense,
		Low = self._treasury < EconomyConfig.Treasury.LowThreshold,
	})
end

-- Admin: reset economy (treasury, taxes; player coins optional).
function EconomyService:ResetEconomy(resetPlayers: boolean)
	self._treasury = EconomyConfig.Treasury.Starting
	self._pendingDelta = 0
	for name, def in pairs(EconomyConfig.Taxes) do
		self._taxes[name] = def.Default
	end
	if resetPlayers then
		for _, player in ipairs(Players:GetPlayers()) do
			local profile = self._data:Get(player)
			if profile then
				profile.Coins = EconomyConfig.Currency.StartingCoins
				self:PublishPlayer(player)
			end
		end
	end
	self._audit:Log("Admin", "EconomyReset", { players = resetPlayers })
	self:_publishTreasury()
end

return EconomyService
