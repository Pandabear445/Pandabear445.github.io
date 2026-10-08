--[[
	HierarchyModel
	Pure, deterministic rank-slot logic. No Roblox APIs are used here so the
	exact same code runs:
	  * in memory for a server-scoped kingdom,
	  * inside MemoryStore UpdateAsync transforms for a global kingdom,
	  * in the offline unit tests (tests/HierarchyModel.spec.luau).

	THE RULES
	  * Ranks have limited slots (MaxSlots). The bottom rank is unlimited.
	  * XP never directly grants a rank. XP is only promotion priority.
	  * When a slot opens in rank R, the highest-priority ELIGIBLE member of
	    the rank directly below R is promoted (one rung at a time).
	  * That promotion opens a slot below, which is filled the same way, so
	    promotions cascade until a rank with spare capacity is reached.
	  * Members below can never overtake a rank holder by gaining XP.
	  * Death (ResetLife) sets XP to 0, drops the member to the bottom rank
	    and puts them last in the queue. The slot they held cascades.

	STATE SHAPE (kept compact because the global kingdom stores it in a
	32KB MemoryStore value)
	  state = {
	    v = version number,
	    seq = join counter,
	    m = { [userIdString] = Member },
	  }
	  Member = {
	    r = rankId,        x = xp (promotion priority),
	    t = rank since,    p = last promotion time,
	    s = last seen,     j = join sequence (seniority),
	    o = online flag,   b = promotion blocked until,
	    l = life number,   n = display name,
	  }

	EVENTS returned by every mutating call
	  { k = "Placed",   id, to }
	  { k = "Left",     id, from }
	  { k = "Vacancy",  rank, id, cause }
	  { k = "Promoted", id, from, to, cause }
	  { k = "Demoted",  id, from, to, cause }
	  { k = "Reset",    id, from, cause }
	  { k = "Repaired", id, from, to, note }
]]

local HierarchyModel = {}
HierarchyModel.__index = HierarchyModel

HierarchyModel.Modes = {
	CASCADE = "CASCADE",
	HIGHEST_XP = "HIGHEST_XP",
	FIRST_PLAYER = "FIRST_PLAYER",
	MANUAL = "MANUAL",
	HYBRID = "HYBRID",
}

local MAX_REBALANCE_PASSES = 256

export type Settings = {
	Mode: string,
	PromotionCooldown: number?, -- seconds a member must wait between promotions
	RequireOnline: boolean?, -- only online members can be promoted
	OnlineWindow: number?, -- seconds since last seen still counted as online
	RejoinPolicy: string?, -- "Bottom" | "RestoreIfVacant"
	DemotionBlock: number?, -- seconds a demoted member cannot be re-promoted
}

local function copyRank(def, index)
	return {
		Id = def.Id,
		Order = def.Order,
		Index = index,
		MaxSlots = def.MaxSlots, -- nil = unlimited
		MinXP = def.MinXP or 0,
		MinActivePlayers = def.MinActivePlayers or 0,
		PromotionCooldown = def.PromotionCooldown,
		DisplayName = def.DisplayName or def.Id,
	}
end

function HierarchyModel.new(rankDefs, settings: Settings)
	assert(type(rankDefs) == "table" and #rankDefs >= 2, "HierarchyModel needs at least two ranks")
	local sorted = table.clone(rankDefs)
	table.sort(sorted, function(a, b)
		return a.Order < b.Order
	end)

	local ranks, byId = {}, {}
	for index, def in ipairs(sorted) do
		assert(type(def.Id) == "string", "rank missing Id")
		assert(not byId[def.Id], "duplicate rank Id " .. def.Id)
		local rank = copyRank(def, index)
		ranks[index] = rank
		byId[def.Id] = rank
	end
	assert(ranks[1].MaxSlots == nil, "the bottom rank (" .. ranks[1].Id .. ") must be unlimited (MaxSlots = nil)")

	local mode = settings.Mode or "HYBRID"
	assert(HierarchyModel.Modes[mode], "unknown EmptyRankFillingMode " .. tostring(mode))

	return setmetatable({
		Ranks = ranks,
		ById = byId,
		Bottom = ranks[1],
		Top = ranks[#ranks],
		Settings = {
			Mode = mode,
			PromotionCooldown = settings.PromotionCooldown or 0,
			RequireOnline = settings.RequireOnline ~= false,
			OnlineWindow = settings.OnlineWindow,
			RejoinPolicy = settings.RejoinPolicy or "Bottom",
			DemotionBlock = settings.DemotionBlock or 0,
		},
	}, HierarchyModel)
end

function HierarchyModel.newState()
	return { v = 0, seq = 0, m = {} }
end

local function key(id): string
	return tostring(id)
end

--------------------------------------------------------------------------
-- Queries
--------------------------------------------------------------------------

function HierarchyModel:GetRank(rankId: string)
	return self.ById[rankId]
end

function HierarchyModel:RankAbove(rankId: string)
	local rank = self.ById[rankId]
	return rank and self.Ranks[rank.Index + 1]
end

function HierarchyModel:RankBelow(rankId: string)
	local rank = self.ById[rankId]
	return rank and self.Ranks[rank.Index - 1]
end

function HierarchyModel:IsOnline(member, now: number): boolean
	if member.o ~= true then
		return false
	end
	local window = self.Settings.OnlineWindow
	if window and member.s and now - member.s > window then
		return false
	end
	return true
end

-- Priority ordering inside a rank: XP desc, then longest in rank, then
-- seniority, then id (fully deterministic).
function HierarchyModel.ComparePriority(a, b): boolean
	if a.x ~= b.x then
		return a.x > b.x
	end
	if (a.t or 0) ~= (b.t or 0) then
		return (a.t or 0) < (b.t or 0)
	end
	if (a.j or 0) ~= (b.j or 0) then
		return (a.j or 0) < (b.j or 0)
	end
	return a.id < b.id
end

local function compareSeniority(a, b): boolean
	if (a.j or 0) ~= (b.j or 0) then
		return (a.j or 0) < (b.j or 0)
	end
	return HierarchyModel.ComparePriority(a, b)
end

function HierarchyModel:CountByRank(state)
	local counts = {}
	for _, rank in ipairs(self.Ranks) do
		counts[rank.Id] = 0
	end
	for _, member in pairs(state.m) do
		if counts[member.r] then
			counts[member.r] += 1
		end
	end
	return counts
end

function HierarchyModel:ActiveCount(state, now: number): number
	local count = 0
	for _, member in pairs(state.m) do
		if self:IsOnline(member, now) then
			count += 1
		end
	end
	return count
end

-- Returns the members of a rank sorted by promotion priority. Each entry is
-- a shallow view { id, x, t, j, n, o } so callers cannot mutate state.
function HierarchyModel:GetQueue(state, rankId: string)
	local list = {}
	for id, member in pairs(state.m) do
		if member.r == rankId then
			table.insert(list, { id = id, x = member.x, t = member.t, j = member.j, n = member.n, o = member.o })
		end
	end
	table.sort(list, HierarchyModel.ComparePriority)
	return list
end

-- Why a member cannot currently be promoted into targetRank (nil = eligible).
function HierarchyModel:IneligibleReason(member, targetRank, now: number): string?
	local settings = self.Settings
	if settings.RequireOnline and not self:IsOnline(member, now) then
		return "Offline"
	end
	if member.b and now < member.b then
		return "PromotionBlocked"
	end
	if member.x < targetRank.MinXP then
		return "MinXP"
	end
	local cooldown = targetRank.PromotionCooldown or settings.PromotionCooldown
	if cooldown > 0 and member.p and now - member.p < cooldown then
		return "Cooldown"
	end
	return nil
end

function HierarchyModel:GetPosition(state, id, now: number)
	local member = state.m[key(id)]
	if not member then
		return nil
	end
	local queue = self:GetQueue(state, member.r)
	local position = 0
	for index, entry in ipairs(queue) do
		if entry.id == key(id) then
			position = index
			break
		end
	end
	local counts = self:CountByRank(state)
	local nextRank = self:RankAbove(member.r)
	local info = {
		Rank = member.r,
		Position = position,
		QueueSize = #queue,
		XP = member.x,
		RankSince = member.t,
		NextRank = nextRank and nextRank.Id or nil,
		NextRankCount = nextRank and counts[nextRank.Id] or 0,
		NextRankMax = nextRank and nextRank.MaxSlots or nil,
		Eligible = false,
		Reason = if nextRank then nil else "TopRank",
	}
	if nextRank then
		info.Reason = self:IneligibleReason(member, nextRank, now)
		info.Eligible = info.Reason == nil
		if nextRank.MaxSlots == 0 then
			info.Reason = "RankDisabled"
			info.Eligible = false
		end
	end
	return info
end

--------------------------------------------------------------------------
-- Internal mutation helpers
--------------------------------------------------------------------------

local function setRank(member, rankId: string, now: number)
	member.r = rankId
	member.t = now
end

function HierarchyModel:_hasCapacity(counts, rank): boolean
	return rank.MaxSlots == nil or counts[rank.Id] < rank.MaxSlots
end

-- Highest rank at or below startRank (by index) that has a free slot.
function HierarchyModel:_highestOpenAtOrBelow(counts, startIndex: number)
	for index = startIndex, 1, -1 do
		local rank = self.Ranks[index]
		if self:_hasCapacity(counts, rank) then
			return rank
		end
	end
	return self.Bottom
end

function HierarchyModel:_vacate(events, rankId: string, id: string, cause: string)
	local rank = self.ById[rankId]
	if rank and rank.MaxSlots ~= nil then
		table.insert(events, { k = "Vacancy", rank = rankId, id = id, cause = cause })
	end
end

--------------------------------------------------------------------------
-- Mutations (all return an events array)
--------------------------------------------------------------------------

export type JoinInfo = {
	xp: number,
	name: string?,
	savedRank: string?,
	life: number?,
	keepExisting: boolean?, -- global kingdoms keep the stored rank
}

function HierarchyModel:Join(state, id, info: JoinInfo, now: number)
	local events = {}
	local k = key(id)
	local member = state.m[k]
	local xp = math.max(0, math.floor(info.xp or 0))

	if member and info.keepExisting then
		-- Returning member of a persistent (global) hierarchy. Validate the
		-- stored rank against the authoritative life counter: if the player
		-- died since the hierarchy last saw them, the old rank is void.
		if info.life and member.l and info.life ~= member.l then
			local from = member.r
			if from ~= self.Bottom.Id then
				self:_vacate(events, from, k, "LifeMismatch")
				table.insert(events, { k = "Repaired", id = k, from = from, to = self.Bottom.Id, note = "LifeMismatch" })
			end
			setRank(member, self.Bottom.Id, now)
		end
		if not self.ById[member.r] then
			local from = member.r
			setRank(member, self.Bottom.Id, now)
			table.insert(events, { k = "Repaired", id = k, from = from, to = self.Bottom.Id, note = "UnknownRank" })
		end
		member.x = xp
		member.o = true
		member.s = now
		member.l = info.life or member.l
		member.n = info.name or member.n
		table.insert(events, { k = "Placed", id = k, to = member.r })
		return events
	end

	if member then
		-- Already present in a server-scoped hierarchy (duplicate join): keep.
		member.x = xp
		member.o = true
		member.s = now
		return events
	end

	state.seq = (state.seq or 0) + 1
	member = {
		r = self.Bottom.Id,
		x = xp,
		t = now,
		p = nil,
		s = now,
		j = state.seq,
		o = true,
		l = info.life,
		n = info.name,
	}
	state.m[k] = member

	if self.Settings.RejoinPolicy == "RestoreIfVacant" and info.savedRank and self.ById[info.savedRank] then
		-- Only restores into a slot that is currently empty, and never above
		-- the saved rank. Gates (MinXP / population) still apply.
		local counts = self:CountByRank(state)
		local saved = self.ById[info.savedRank]
		local active = self:ActiveCount(state, now)
		for index = saved.Index, 2, -1 do
			local rank = self.Ranks[index]
			local populationOk = self.Settings.Mode ~= "HYBRID" or active >= rank.MinActivePlayers
			if self:_hasCapacity(counts, rank) and xp >= rank.MinXP and populationOk and rank.MaxSlots ~= 0 then
				setRank(member, rank.Id, now)
				break
			end
		end
	end

	table.insert(events, { k = "Placed", id = k, to = member.r })
	return events
end

-- keepRank = true for persistent (global) kingdoms: the member keeps the slot
-- while offline (subject to PruneStale). Otherwise the slot is vacated.
function HierarchyModel:Leave(state, id, now: number, keepRank: boolean?)
	local events = {}
	local k = key(id)
	local member = state.m[k]
	if not member then
		return events
	end
	if keepRank then
		member.o = false
		member.s = now
		return events
	end
	state.m[k] = nil
	self:_vacate(events, member.r, k, "Left")
	table.insert(events, { k = "Left", id = k, from = member.r })
	return events
end

function HierarchyModel:SetXP(state, id, xp: number, now: number)
	local member = state.m[key(id)]
	if member then
		member.x = math.max(0, math.floor(xp))
		member.s = now
		member.o = true
	end
end

-- Death: XP -> 0, rank -> bottom, queue position -> last.
function HierarchyModel:ResetLife(state, id, now: number, cause: string?, newLife: number?)
	local events = {}
	local k = key(id)
	local member = state.m[k]
	if not member then
		return events
	end
	local from = member.r
	member.x = 0
	member.p = nil
	member.b = nil
	member.l = newLife or member.l
	setRank(member, self.Bottom.Id, now) -- t = now puts them last among equals
	table.insert(events, { k = "Reset", id = k, from = from, cause = cause or "Death" })
	if from ~= self.Bottom.Id then
		self:_vacate(events, from, k, "Death")
	end
	return events
end

export type DemoteOptions = {
	toRank: string?, -- explicit destination (must be lower)
	steps: number?, -- default 1
	block: number?, -- seconds of promotion block (defaults to Settings.DemotionBlock)
	cause: string?,
}

function HierarchyModel:Demote(state, id, now: number, options)
	options = options or {}
	local events = {}
	local k = key(id)
	local member = state.m[k]
	if not member then
		return events, "NotFound"
	end
	local current = self.ById[member.r]
	if not current or current.Index == 1 then
		return events, "AlreadyBottom"
	end

	local targetIndex
	if options.toRank then
		local target = self.ById[options.toRank]
		if not target or target.Index >= current.Index then
			return events, "InvalidTarget"
		end
		targetIndex = target.Index
	else
		targetIndex = math.max(1, current.Index - (options.steps or 1))
	end

	-- Land in the highest rank at/below the target that has room.
	local counts = self:CountByRank(state)
	local destination = self:_highestOpenAtOrBelow(counts, targetIndex)
	local from = member.r
	setRank(member, destination.Id, now)
	member.b = now + (options.block or self.Settings.DemotionBlock)
	local cause = options.cause or "Demoted"
	table.insert(events, { k = "Demoted", id = k, from = from, to = destination.Id, cause = cause })
	self:_vacate(events, from, k, cause)
	return events, nil
end

-- Removal / impeachment: straight to the bottom rank with a promotion block.
function HierarchyModel:Remove(state, id, now: number, options)
	options = options or {}
	options.toRank = self.Bottom.Id
	options.cause = options.cause or "Removed"
	return self:Demote(state, id, now, options)
end

-- Administrative placement. Requires a free slot unless the rank is lower
-- than the member's current rank (which is a demotion).
function HierarchyModel:SetRank(state, id, rankId: string, now: number, cause: string?)
	local events = {}
	local k = key(id)
	local member = state.m[k]
	local target = self.ById[rankId]
	if not member then
		return events, "NotFound"
	end
	if not target then
		return events, "UnknownRank"
	end
	if member.r == rankId then
		return events, "AlreadyRank"
	end
	local current = self.ById[member.r]
	if current and target.Index < current.Index then
		return self:Demote(state, id, now, { toRank = rankId, cause = cause or "AdminSetRank", block = 0 })
	end
	local counts = self:CountByRank(state)
	if not self:_hasCapacity(counts, target) then
		return events, "RankFull"
	end
	local from = member.r
	setRank(member, rankId, now)
	member.p = now
	table.insert(events, { k = "Promoted", id = k, from = from, to = rankId, cause = cause or "Appointed" })
	self:_vacate(events, from, k, "Appointed")
	return events, nil
end

export type RebalanceContext = {
	activeCount: number?, -- online population used by HYBRID gates
}

function HierarchyModel:_findCandidate(state, rank, now: number)
	local mode = self.Settings.Mode
	local best, bestId
	local below = self.Ranks[rank.Index - 1]
	local compare = mode == "FIRST_PLAYER" and compareSeniority or HierarchyModel.ComparePriority

	for id, member in pairs(state.m) do
		local memberRank = self.ById[member.r]
		local inPool
		if mode == "HIGHEST_XP" then
			inPool = memberRank ~= nil and memberRank.Index < rank.Index
		else
			inPool = below ~= nil and member.r == below.Id
		end
		if inPool and self:IneligibleReason(member, rank, now) == nil then
			local view = { id = id, x = member.x, t = member.t, j = member.j }
			if not best or compare(view, best) then
				best = view
				bestId = id
			end
		end
	end
	return bestId
end

-- Fills vacancies top-down. Processing the highest rank first means a
-- vacancy at the top pulls one member up from directly below, and that new
-- vacancy is filled when the loop reaches the next rank: a cascade.
function HierarchyModel:Rebalance(state, now: number, context)
	local events = {}
	local mode = self.Settings.Mode
	if mode == "MANUAL" then
		return events
	end
	context = context or {}
	local activeCount = context.activeCount or self:ActiveCount(state, now)
	local counts = self:CountByRank(state)

	for _ = 1, MAX_REBALANCE_PASSES do
		local changed = false
		for index = #self.Ranks, 2, -1 do
			local rank = self.Ranks[index]
			local gated = mode == "HYBRID" and activeCount < rank.MinActivePlayers
			if not gated and rank.MaxSlots ~= 0 then
				while self:_hasCapacity(counts, rank) do
					local candidateId = self:_findCandidate(state, rank, now)
					if not candidateId then
						break
					end
					local member = state.m[candidateId]
					local from = member.r
					counts[from] -= 1
					counts[rank.Id] += 1
					setRank(member, rank.Id, now)
					member.p = now
					table.insert(events, {
						k = "Promoted",
						id = candidateId,
						from = from,
						to = rank.Id,
						cause = "Vacancy",
					})
					changed = true
				end
			end
		end
		if not changed then
			break
		end
	end
	return events
end

-- Repairs invalid state: unknown ranks and over-capacity ranks (e.g. after a
-- config change). Over-capacity is resolved by moving the most recent
-- arrivals down, which preserves existing holders' positions.
function HierarchyModel:Validate(state, now: number)
	local events = {}
	for id, member in pairs(state.m) do
		if type(member.x) ~= "number" or member.x ~= member.x then
			member.x = 0
		end
		if not self.ById[member.r] then
			local from = member.r
			setRank(member, self.Bottom.Id, now)
			table.insert(events, { k = "Repaired", id = id, from = from, to = self.Bottom.Id, note = "UnknownRank" })
		end
	end

	for index = #self.Ranks, 2, -1 do
		local rank = self.Ranks[index]
		if rank.MaxSlots ~= nil then
			local holders = {}
			for id, member in pairs(state.m) do
				if member.r == rank.Id then
					table.insert(holders, { id = id, t = member.t or 0, x = member.x, j = member.j or 0 })
				end
			end
			if #holders > rank.MaxSlots then
				-- Oldest holders keep the slots.
				table.sort(holders, function(a, b)
					if a.t ~= b.t then
						return a.t < b.t
					end
					return HierarchyModel.ComparePriority(a, b)
				end)
				local below = self.Ranks[index - 1]
				for i = rank.MaxSlots + 1, #holders do
					local member = state.m[holders[i].id]
					setRank(member, below.Id, now)
					table.insert(events, {
						k = "Repaired",
						id = holders[i].id,
						from = rank.Id,
						to = below.Id,
						note = "OverCapacity",
					})
				end
			end
		end
	end
	return events
end

export type PruneOptions = {
	releaseAfter: number?, -- offline seconds after which a ranked member loses the slot
	forgetBottomAfter: number?, -- offline seconds after which a bottom-rank member is dropped
}

-- Global kingdoms: free slots held by long-inactive members and keep the
-- stored document small.
function HierarchyModel:PruneStale(state, now: number, options: PruneOptions)
	local events = {}
	for id, member in pairs(state.m) do
		local offlineFor = now - (member.s or 0)
		local isBottom = member.r == self.Bottom.Id
		local online = self:IsOnline(member, now)
		if not online then
			member.o = false
		end
		if not online and not isBottom and options.releaseAfter and offlineFor > options.releaseAfter then
			local from = member.r
			setRank(member, self.Bottom.Id, now)
			table.insert(events, { k = "Demoted", id = id, from = from, to = self.Bottom.Id, cause = "Inactive" })
			self:_vacate(events, from, id, "Inactive")
			isBottom = true
		end
		if not online and isBottom and options.forgetBottomAfter and offlineFor > options.forgetBottomAfter then
			state.m[id] = nil
		end
	end
	return events
end

-- Convenience used by tests and the testing tools: run an op then rebalance.
function HierarchyModel:ApplyAndRebalance(state, now: number, op: () -> { any }, context)
	local events = op() or {}
	for _, event in ipairs(self:Rebalance(state, now, context)) do
		table.insert(events, event)
	end
	state.v = (state.v or 0) + 1
	return events
end

return HierarchyModel
