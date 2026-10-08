--[[
	XPService
	Current-life XP in four categories:
	  Job          physical work
	  Management   successful outcomes of managed work
	  Leadership   meetings, government, crisis leadership
	  Contribution deliveries and kingdom contributions
	Total XP (promotion priority) = weighted sum (GameConfig.XPWeights).

	There is no passive/time XP anywhere in the game. Every award must come
	from a server-validated action, and passes through:
	  gates        (AFK, safe mode, suspensions...) registered by other services
	  multipliers  (rank, performance, morale, purchased boost...) clamped to
	               GameConfig.XPLimits
	  caps         max single award and a rolling per-minute ceiling;
	               anything above is dropped and reported as an anomaly.

	Other services extend XP without XPService depending on them:
	  XPService:RegisterMultiplier(name, fn(player, category, context) -> number)
	  XPService:RegisterGate(name, fn(player, category, context) -> ok, reason)
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)

local XPService = {
	Name = "XPService",
	Dependencies = { "DataService", "RankService", "ActivityService", "AuditService", "StateService" },
}

XPService.Categories = { "Job", "Management", "Leadership", "Contribution" }
local VALID = { Job = true, Management = true, Leadership = true, Contribution = true }

function XPService:Init()
	self._data = self:Use("DataService")
	self._rank = self:Use("RankService")
	self._activity = self:Use("ActivityService")
	self._audit = self:Use("AuditService")
	self._state = self:Use("StateService")

	self.XPChanged = Signal.new("XPChanged") -- (player, total, delta, category, source)
	self.Anomaly = Signal.new("XPAnomaly") -- (player, kind, detail)
	self._multipliers = {}
	self._gates = {}
	self._windows = {}

	self:RegisterGate("AFK", function(player, _, context)
		if context.ignoreAFK then
			return true
		end
		if self._activity:IsAFK(player) then
			return false, "AFK"
		end
		return true
	end)

	self:RegisterMultiplier("Rank", function(player)
		return self._rank:GetRankDef(player).XPMultiplier or 1
	end)

	self._data.Loaded:Connect(function(player)
		self:Publish(player)
	end)
end

function XPService:RegisterMultiplier(name: string, fn)
	self._multipliers[name] = fn
end

function XPService:RegisterGate(name: string, fn)
	self._gates[name] = fn
end

function XPService.ComputeTotal(xp): number
	local total = 0
	for _, category in ipairs(XPService.Categories) do
		total += (xp[category] or 0) * (GameConfig.XPWeights[category] or 1)
	end
	return math.floor(total)
end

function XPService:GetTotal(player: Player): number
	local profile = self._data:Get(player)
	return profile and XPService.ComputeTotal(profile.XP) or 0
end

function XPService:GetBreakdown(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return nil
	end
	return table.clone(profile.XP)
end

function XPService:Publish(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return
	end
	local total = XPService.ComputeTotal(profile.XP)
	player:SetAttribute("KingdomXP", total)
	self._state:Set(player, "XP", {
		Total = total,
		Job = math.floor(profile.XP.Job),
		Management = math.floor(profile.XP.Management),
		Leadership = math.floor(profile.XP.Leadership),
		Contribution = math.floor(profile.XP.Contribution),
		Life = profile.Life.Number,
		LifetimeXP = math.floor(profile.Lifetime.XPEarned),
		HighestXP = math.floor(profile.Lifetime.HighestXP),
	})
end

function XPService:_windowRemaining(player: Player, nowClock: number): number
	local window = self._windows[player]
	if not window then
		window = {}
		self._windows[player] = window
	end
	local sum = 0
	local i = 1
	while i <= #window do
		if nowClock - window[i].t > 60 then
			table.remove(window, i)
		else
			sum += window[i].a
			i += 1
		end
	end
	return math.max(0, GameConfig.XPLimits.MaxPerMinute - sum)
end

export type AwardContext = {
	source: string?, -- e.g. "Job:Farming", "Meeting:RoyalCouncil"
	performance: number?, -- performance tier multiplier
	jobId: string?,
	ignoreAFK: boolean?,
	raw: boolean?, -- admin/testing: skip gates and multipliers
}

-- Awards XP. Returns the amount actually awarded (may be 0).
function XPService:Award(player: Player, category: string, base: number, context): number
	context = context or {}
	if not VALID[category] or type(base) ~= "number" or base ~= base or base <= 0 then
		return 0
	end
	local profile = self._data:Get(player)
	if not profile then
		return 0
	end

	local amount
	if context.raw then
		amount = math.floor(base + 0.5)
	else
		for name, gate in pairs(self._gates) do
			local ok, allowed, reason = pcall(gate, player, category, context)
			if ok and allowed == false then
				self.Log:Debug("award to %s blocked by %s (%s)", player.Name, name, tostring(reason))
				return 0
			end
		end
		local multiplier = context.performance or 1
		for name, fn in pairs(self._multipliers) do
			local ok, value = pcall(fn, player, category, context)
			if ok and type(value) == "number" and value == value then
				multiplier *= value
			elseif not ok then
				self.Log:Warn("multiplier %s failed: %s", name, tostring(value))
			end
		end
		multiplier = math.clamp(multiplier, GameConfig.XPLimits.MinTotalMultiplier, GameConfig.XPLimits.MaxTotalMultiplier)
		amount = math.floor(base * multiplier + 0.5)
		if amount > GameConfig.XPLimits.MaxSingleAward then
			self.Anomaly:Fire(player, "SingleAwardCap", { requested = amount, source = context.source })
			amount = GameConfig.XPLimits.MaxSingleAward
		end
		local nowClock = os.clock()
		local remaining = self:_windowRemaining(player, nowClock)
		if amount > remaining then
			self.Anomaly:Fire(player, "RateCap", { requested = amount, allowed = remaining, source = context.source })
			amount = remaining
		end
		if amount > 0 then
			table.insert(self._windows[player], { t = nowClock, a = amount })
		end
	end
	if amount <= 0 then
		return 0
	end

	profile.XP[category] += amount
	profile.Life.XPEarned += amount
	profile.Lifetime.XPEarned += amount
	local total = XPService.ComputeTotal(profile.XP)
	if total > (profile.Lifetime.HighestXP or 0) then
		profile.Lifetime.HighestXP = total
	end
	self._audit:Log("XP", "Award", { userId = player.UserId, category = category, amount = amount, source = context.source })
	self:Publish(player)
	self.XPChanged:Fire(player, total, amount, category, context.source)
	return amount
end

-- Admin tool: removes XP, Job first, never below zero.
function XPService:Remove(player: Player, amount: number, reason: string?): number
	local profile = self._data:Get(player)
	if not profile or amount <= 0 then
		return 0
	end
	local remaining = amount
	for _, category in ipairs({ "Job", "Contribution", "Management", "Leadership" }) do
		local take = math.min(profile.XP[category], remaining)
		profile.XP[category] -= take
		remaining -= take
		if remaining <= 0 then
			break
		end
	end
	local removed = amount - remaining
	self._audit:Log("XP", "Remove", { userId = player.UserId, amount = removed, reason = reason })
	self:Publish(player)
	self.XPChanged:Fire(player, XPService.ComputeTotal(profile.XP), -removed, "Job", reason)
	return removed
end

-- Death: current XP -> 0, life counter advances, lifetime stats untouched.
-- Returns the life summary that was closed.
function XPService:ResetLife(player: Player, cause: string)
	local profile = self._data:Get(player)
	if not profile then
		return nil
	end
	local closing = {
		Life = profile.Life.Number,
		StartedAt = profile.Life.StartedAt,
		EndedAt = os.time(),
		HighestRank = profile.Life.HighestRank,
		PeakXP = math.max(XPService.ComputeTotal(profile.XP), 0),
		XPEarned = profile.Life.XPEarned,
		JobsCompleted = profile.Life.JobsCompleted,
		Promotions = profile.Life.Promotions,
		Cause = cause,
	}
	table.insert(profile.CareerHistory, closing)
	while #profile.CareerHistory > 50 do
		table.remove(profile.CareerHistory, 1)
	end

	for _, category in ipairs(XPService.Categories) do
		profile.XP[category] = 0
	end
	profile.Lifetime.Deaths += 1
	profile.Life = {
		Number = closing.Life + 1,
		StartedAt = os.time(),
		HighestRank = RankConfig.Bottom().Id,
		HighestRankOrder = RankConfig.Bottom().Order,
		XPEarned = 0,
		JobsCompleted = 0,
		Promotions = 0,
	}
	self._windows[player] = nil
	self._audit:Log("XP", "LifeReset", { userId = player.UserId, life = closing.Life, peak = closing.PeakXP, cause = cause })
	self:Publish(player)
	self.XPChanged:Fire(player, 0, -closing.PeakXP, "Job", "Death")
	return closing
end

return XPService
