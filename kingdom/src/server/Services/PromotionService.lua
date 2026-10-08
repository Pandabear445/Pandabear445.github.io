--[[
	PromotionService
	Decides WHEN hierarchy transactions run and tells everyone what happened.

	  join      -> Join + Rebalance       (new players enter at the bottom)
	  leave     -> Leave + Rebalance      (server scope: slot opens, cascade)
	  death     -> ResetLife + Rebalance  (XP 0, bottom rank, cascade)
	  demotion  -> Demote + Rebalance
	  removal   -> Remove + Rebalance
	  XP change -> SetXP + Rebalance      (debounced; XP never overtakes a holder,
	                                       it only reorders the queue)
	  periodic  -> Rebalance              (cooldowns/gates may have cleared)

	Announcements follow the order the design asks for:
	  "SERGEANT POSITION OPEN" -> "Promotion candidate selected: A"
	  -> "A has been promoted to Sergeant." -> cascade lines ...
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Format = require(ReplicatedStorage.Kingdom.Shared.Format)
local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Net = require(script.Parent.Parent.Core.Net)

local PromotionService = {
	Name = "PromotionService",
	Dependencies = { "RankService", "XPService", "DataService", "NotificationService", "AuditService", "StateService" },
}

local LOCAL_SYNC_DEBOUNCE = 1
local REBALANCE_SECONDS = 10

local REASON_TEXT = {
	Offline = "Offline",
	PromotionBlocked = "Recently demoted - promotion blocked for a while",
	MinXP = "Not enough XP for this rank yet",
	Cooldown = "Recently promoted - settling in",
	TopRank = "You hold the highest rank",
	RankDisabled = "This rank is disabled",
}

function PromotionService:Init()
	self._rank = self:Use("RankService")
	self._xp = self:Use("XPService")
	self._data = self:Use("DataService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")
	self._state = self:Use("StateService")

	self.Promoted = Signal.new("Promoted") -- (player, fromId, toId)
	self.Demoted = Signal.new("Demoted") -- (player, fromId, toId, cause)
	self._dirtyXP = {}
	self._syncScheduled = false

	self._xp.XPChanged:Connect(function(player)
		self._dirtyXP[player] = true
		if not self._rank.IsGlobal then
			self:_scheduleLocalSync()
		end
	end)

	self._rank.Changed:Connect(function(events, label)
		self:_announce(events, label)
		self:_publishQueues()
	end)

	Net.Query("PromotionQueue", { rate = 1, burst = 3 }, function(player, args)
		return self:GetQueueView(player, type(args.rank) == "string" and args.rank or nil)
	end)
end

function PromotionService:Start()
	self.Registry:Every(self.Name, "rebalance", REBALANCE_SECONDS, function()
		if not self._rank.IsGlobal then
			self:Rebalance("Periodic")
		end
	end)
	if self._rank.IsGlobal then
		self.Registry:Every(self.Name, "globalSync", GameConfig.Global.SyncIntervalSeconds, function()
			self:_globalSync()
		end)
	end
end

local function playerFromId(id: string): Player?
	local userId = tonumber(id)
	if userId and userId > 0 then
		return Players:GetPlayerByUserId(userId)
	end
	return nil
end

local function withRebalance(model, state, now, events)
	for _, event in ipairs(model:Rebalance(state, now)) do
		table.insert(events, event)
	end
	return events
end

-- Lifecycle ------------------------------------------------------------------

function PromotionService:OnPlayerJoin(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return
	end
	local xp = self._xp:GetTotal(player)
	local info = {
		xp = xp,
		name = player.DisplayName,
		savedRank = profile.Rank,
		life = profile.Life.Number,
		keepExisting = self._rank.IsGlobal,
	}
	self._rank:Run("Join", function(model, state, now)
		local events = model:Join(state, player.UserId, info, now)
		return withRebalance(model, state, now, events)
	end)
	-- Make sure attributes/state exist even when the rank did not change.
	if not player:GetAttribute("KingdomRank") then
		self._rank:_applyToPlayer(player, nil, self._rank:GetRankId(player), "Join")
	end
	self:_publishQueues()
end

function PromotionService:OnPlayerLeave(player: Player)
	self._dirtyXP[player] = nil
	local id = player.UserId
	local keep = self._rank.IsGlobal
	local xp = self._xp:GetTotal(player)
	self._rank:Run("Leave", function(model, state, now)
		if keep then
			model:SetXP(state, id, xp, now)
		end
		local events = model:Leave(state, id, now, keep)
		return withRebalance(model, state, now, events)
	end)
	self._rank:ForgetPlayer(player)
end

-- Death: XP already zeroed by XPService. Rank -> bottom, slot cascades.
function PromotionService:ResetLife(player: Player, cause: string, newLife: number?)
	local id = player.UserId
	return self._rank:Run("Death", function(model, state, now)
		local events = model:ResetLife(state, id, now, cause, newLife)
		return withRebalance(model, state, now, events)
	end)
end

-- target: Player or userId string (bots). Returns ok, error
function PromotionService:Demote(target, options)
	local id = if typeof(target) == "Instance" then (target :: Player).UserId else target
	local failure
	self._rank:Run("Demote", function(model, state, now)
		local events, err = model:Demote(state, id, now, options)
		failure = err
		return withRebalance(model, state, now, events)
	end)
	return failure == nil, failure
end

function PromotionService:Remove(target, options)
	local id = if typeof(target) == "Instance" then (target :: Player).UserId else target
	local failure
	self._rank:Run("Remove", function(model, state, now)
		local events, err = model:Remove(state, id, now, options)
		failure = err
		return withRebalance(model, state, now, events)
	end)
	return failure == nil, failure
end

function PromotionService:SetRank(target, rankId: string, cause: string?)
	local id = if typeof(target) == "Instance" then (target :: Player).UserId else target
	local failure
	self._rank:Run("SetRank", function(model, state, now)
		local events, err = model:SetRank(state, id, rankId, now, cause)
		failure = err
		return withRebalance(model, state, now, events)
	end)
	return failure == nil, failure
end

function PromotionService:Rebalance(label: string?)
	return self._rank:Run(label or "Rebalance", function(model, state, now)
		return model:Rebalance(state, now)
	end)
end

-- XP sync --------------------------------------------------------------------

function PromotionService:_collectDirty()
	local updates = {}
	for player in pairs(self._dirtyXP) do
		if player.Parent == Players then
			updates[player.UserId] = self._xp:GetTotal(player)
		end
	end
	self._dirtyXP = {}
	return updates
end

function PromotionService:_scheduleLocalSync()
	if self._syncScheduled then
		return
	end
	self._syncScheduled = true
	task.delay(LOCAL_SYNC_DEBOUNCE, function()
		self._syncScheduled = false
		local updates = self:_collectDirty()
		self._rank:Run("SyncXP", function(model, state, now)
			for userId, xp in pairs(updates) do
				model:SetXP(state, userId, xp, now)
			end
			return model:Rebalance(state, now)
		end)
	end)
end

function PromotionService:_globalSync()
	self:_collectDirty()
	local snapshot = {}
	for _, player in ipairs(Players:GetPlayers()) do
		if self._data:IsLoaded(player) and self._rank:IsInHierarchy(player) then
			snapshot[player.UserId] = { xp = self._xp:GetTotal(player), life = self._data:Get(player).Life.Number }
		end
	end
	local prune = {
		releaseAfter = GameConfig.Global.RankInactivityReleaseSeconds,
		forgetBottomAfter = GameConfig.Global.ForgetBottomRankAfterSeconds,
	}
	self._rank:Run("GlobalSync", function(model, state, now)
		for userId, info in pairs(snapshot) do
			local member = state.m[tostring(userId)]
			if member then
				model:SetXP(state, userId, info.xp, now)
			end
		end
		local events = model:PruneStale(state, now, prune)
		return withRebalance(model, state, now, events)
	end)
end

-- Announcements --------------------------------------------------------------

local function rankName(rankId: string?): string
	local def = RankConfig.Get(rankId)
	return def and def.DisplayName or tostring(rankId)
end

local function rankOrder(rankId: string?): number
	local def = RankConfig.Get(rankId)
	return def and def.Order or 0
end

function PromotionService:_announce(events, label: string)
	if #events == 0 then
		return
	end
	local announce = GameConfig.Announcements
	local lines = {}
	local headline
	local bigEvent = false

	for _, event in ipairs(events) do
		local name = self._rank:GetDisplayName(event.id)
		local player = playerFromId(event.id)

		if event.k == "Reset" then
			if rankOrder(event.from) >= announce.DeathMinOrder then
				headline = headline or string.format("%s %s has fallen.", rankName(event.from), name)
				table.insert(lines, string.format("%s has returned to the %s rank.", name, rankName(RankConfig.Bottom().Id)))
				bigEvent = true
			end
		elseif event.k == "Vacancy" then
			if rankOrder(event.rank) >= announce.VacancyMinOrder and event.cause ~= "Death" then
				table.insert(lines, string.format("%s POSITION OPEN", string.upper(rankName(event.rank))))
			end
		elseif event.k == "Promoted" then
			local order = rankOrder(event.to)
			if order >= announce.PromotionMinOrder then
				if order >= announce.VacancyMinOrder and not bigEvent then
					table.insert(lines, string.format("Promotion candidate selected: %s", name))
				end
				table.insert(lines, string.format("%s has been promoted to %s.", name, rankName(event.to)))
			end
			if player then
				self:_onPromoted(player, event)
			end
		elseif event.k == "Demoted" then
			if player then
				self._notify:Notify(
					player,
					"Warning",
					"Demoted",
					string.format("You are now %s (%s).", rankName(event.to), tostring(event.cause)),
					{ Sound = "Notification" }
				)
				self.Demoted:Fire(player, event.from, event.to, event.cause)
			end
			if rankOrder(event.from) >= announce.PromotionMinOrder then
				table.insert(lines, string.format("%s is no longer %s.", name, rankName(event.from)))
			end
		elseif event.k == "Repaired" and player then
			self._notify:Notify(player, "Information", "Records corrected", string.format("Your rank was corrected to %s.", rankName(event.to)))
		end
	end

	if #lines > 0 or headline then
		local title = headline and "Kingdom Notice" or "Promotions"
		local text = headline and (headline .. "\n" .. table.concat(lines, "\n")) or table.concat(lines, "\n")
		self._notify:Announce(bigEvent and "Critical" or "Promotion", title, text, { Banner = bigEvent or #lines >= 2 })
	end
	self.Log:Debug("%s produced %d events", label, #events)
end

function PromotionService:_onPromoted(player: Player, event)
	local def = RankConfig.Get(event.to)
	if not def then
		return
	end
	local profile = self._data:Get(player)
	if profile then
		profile.Life.Promotions += 1
		profile.Lifetime.Promotions += 1
	end
	Net.Fire("Effect", player, "Promotion", {
		From = rankName(event.from),
		To = def.DisplayName,
		Color = def.Color,
		Salary = def.Salary,
		PayMultiplier = def.PayMultiplier,
		ManageDepth = def.ManageDepth,
		Council = def.Council,
	})
	self._notify:Notify(
		player,
		"Promotion",
		"PROMOTED: " .. string.upper(def.DisplayName),
		string.format("Salary %d coins/day. %s", def.Salary or 0, (def.ManageDepth or 0) > 0 and "You now manage others." or ""),
		{ Sound = "Promotion" }
	)
	self.Promoted:Fire(player, event.from, event.to)
end

-- Queue views ----------------------------------------------------------------

function PromotionService:_publishQueues()
	local nowTime = os.time()
	for _, player in ipairs(Players:GetPlayers()) do
		local info = self._rank:GetPosition(player)
		if info then
			self._state:Set(player, "Queue", {
				Rank = info.Rank,
				RankName = rankName(info.Rank),
				Position = info.Position,
				QueueSize = info.QueueSize,
				NextRank = info.NextRank,
				NextRankName = info.NextRank and rankName(info.NextRank) or nil,
				NextRankCount = info.NextRankCount,
				NextRankMax = info.NextRankMax,
				Eligible = info.Eligible,
				Reason = info.Reason and (REASON_TEXT[info.Reason] or info.Reason) or nil,
				RankSince = info.RankSince,
				Tenure = Format.duration(nowTime - (info.RankSince or nowTime)),
			})
		end
	end
end

function PromotionService:GetQueueView(player: Player, rankId: string?)
	local myInfo = self._rank:GetPosition(player)
	rankId = rankId and RankConfig.Get(rankId) and rankId or (myInfo and myInfo.Rank) or RankConfig.Bottom().Id
	local queue = self._rank:GetQueue(rankId)
	local rows = {}
	local myId = tostring(player.UserId)
	for index, entry in ipairs(queue) do
		if index <= 25 or entry.id == myId then
			table.insert(rows, {
				Position = index,
				Name = entry.n or self._rank:GetDisplayName(entry.id),
				XP = entry.x,
				IsYou = entry.id == myId,
				Online = entry.o ~= false,
			})
		end
	end
	local above = self._rank.Model:RankAbove(rankId)
	local counts = self._rank:CountByRank()
	return {
		Rank = rankId,
		RankName = rankName(rankId),
		NextRank = above and above.Id or nil,
		NextRankName = above and above.DisplayName or nil,
		NextRankCount = above and counts[above.Id] or 0,
		NextRankMax = above and above.MaxSlots or nil,
		OpenSlots = above and above.MaxSlots and math.max(0, above.MaxSlots - (counts[above.Id] or 0)) or nil,
		Rows = rows,
		You = myInfo and {
			Position = myInfo.Position,
			Eligible = myInfo.Eligible,
			Reason = myInfo.Reason and (REASON_TEXT[myInfo.Reason] or myInfo.Reason) or nil,
		} or nil,
	}
end

return PromotionService
