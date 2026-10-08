--[[
	DeathService
	THE DEFINING RULE:
	  When you die, your current XP becomes 0 and your current rank becomes
	  the lowest rank. The slot you held becomes vacant and cascades.
	  Lifetime statistics, achievements, gamepasses, cosmetics and career
	  history are never touched.

	The reset is a protected transaction:
	  1. respawn is held so the player can't act on the old state
	  2. the active job / work is cancelled (no completion rewards)
	  3. items follow DeathConfig (resources drop as a recoverable sack)
	  4. XP -> 0, life closed into career history, life counter + 1
	  5. hierarchy: rank -> bottom, queue position -> last, cascade
	  6. the profile is saved IMMEDIATELY (retrying), so leaving and
	     rejoining can never restore the pre-death state
	  7. only then is the reset confirmed and respawn released
	  8. the player sees "YOU HAVE FALLEN"; the kingdom hears about falls of
	     important ranks and every resulting promotion (PromotionService)
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DeathConfig = require(ReplicatedStorage.Kingdom.Config.DeathConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Net = require(script.Parent.Parent.Core.Net)

local DeathService = {
	Name = "DeathService",
	Dependencies = {
		"CharacterService",
		"XPService",
		"PromotionService",
		"RankService",
		"InventoryService",
		"JobService",
		"DataService",
		"NotificationService",
		"AuditService",
		"EconomyService",
		"ManagementService",
	},
}

local HOLD_KEY = "DeathSave"

function DeathService:Init()
	self._character = self:Use("CharacterService")
	self._xp = self:Use("XPService")
	self._promotion = self:Use("PromotionService")
	self._rank = self:Use("RankService")
	self._inventory = self:Use("InventoryService")
	self._jobs = self:Use("JobService")
	self._data = self:Use("DataService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")
	self._economy = self:Use("EconomyService")
	self._management = self:Use("ManagementService")

	self.PlayerReset = Signal.new("PlayerReset") -- (player, closedLife, cause, fromRank)
	self._processing = {}

	self._character.Died:Connect(function(player, cause, position, attacker)
		task.spawn(self.HandleDeath, self, player, cause, position, attacker)
	end)
end

function DeathService:HandleDeath(player: Player, cause: string, position: Vector3?, attacker: Player?)
	if self._processing[player] then
		return
	end
	local profile = self._data:Get(player)
	if not profile then
		-- Safe mode: nothing can be saved, so nothing is reset either.
		return
	end
	self._processing[player] = true
	self._character:HoldRespawn(player, HOLD_KEY)
	local fromRank = self._rank:GetRankId(player)
	local fromRankDef = RankConfig.Get(fromRank)

	-- 2. Cancel all work (no completion XP for unfinished tasks).
	pcall(self._jobs.CancelAll, self._jobs, player, "Death")
	pcall(self._management.OnPlayerLeave, self._management, player)

	-- 3. Items.
	local ok, err = pcall(self._inventory.ApplyDeathRules, self._inventory, player, position)
	if not ok then
		self.Log:Error("death item rules failed: %s", tostring(err))
	end
	local rules = DeathConfig.Inventory
	if rules.LoseCurrency and rules.CurrencyLossPercentage > 0 then
		local loss = math.floor(profile.Coins * rules.CurrencyLossPercentage)
		if loss > 0 and self._economy:RemoveCoins(player, loss, "DeathLoss") then
			self._economy:TreasuryDeposit(loss, "DeathTax")
		end
	end

	-- 4. XP and life.
	local closed = self._xp:ResetLife(player, cause)

	-- 5. Hierarchy reset + cascade.
	self._promotion:ResetLife(player, cause, profile.Life.Number)

	-- 6. Save immediately; keep retrying while the player is here.
	local saved = self._data:SaveNow(player, "Death")
	local attempts = 1
	while not saved and attempts < 5 and player.Parent do
		task.wait(2)
		attempts += 1
		saved = self._data:SaveNow(player, "Death")
	end
	self._audit:Log("Death", "Reset", {
		userId = player.UserId,
		cause = cause,
		fromRank = fromRank,
		peakXP = closed and closed.PeakXP or 0,
		saved = saved,
		attacker = attacker and attacker.UserId,
	})

	-- 7. Confirm and release respawn.
	self._character:ReleaseRespawn(player, HOLD_KEY)
	self._processing[player] = nil

	-- 8. Tell the player.
	Net.Fire("Effect", player, "Death", {
		Title = DeathConfig.Screen.Title,
		Lines = DeathConfig.Screen.Lines,
		Cause = cause,
		PreviousRank = fromRankDef and fromRankDef.DisplayName or fromRank,
		PreviousXP = closed and closed.PeakXP or 0,
		Life = profile.Life.Number,
		Lifetime = {
			HighestRank = RankConfig.Get(profile.Lifetime.HighestRank) and RankConfig.Get(profile.Lifetime.HighestRank).DisplayName or profile.Lifetime.HighestRank,
			HighestXP = profile.Lifetime.HighestXP,
			LifetimeXP = profile.Lifetime.XPEarned,
			Deaths = profile.Lifetime.Deaths,
		},
		Saved = saved,
		RespawnSeconds = 6,
	})
	self.PlayerReset:Fire(player, closed, cause, fromRank)
end

function DeathService:IsProcessing(player: Player): boolean
	return self._processing[player] == true
end

return DeathService
