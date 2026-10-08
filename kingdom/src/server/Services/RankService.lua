--[[
	RankService
	Owns the hierarchy state and applies HierarchyModel operations to it.
	Policy (when to promote, what to announce) lives in PromotionService.

	Storage backends (GameConfig.KingdomScope)
	  Server: state lives in this server's memory. Ranks exist only while the
	          player is here; XP persists in their profile.
	  Global: state lives in a MemoryStore HashMap shared by every server.
	          Every change is an atomic UpdateAsync transform running the
	          same pure HierarchyModel code, so two servers can never fill
	          one slot twice. A DataStore backup is written periodically and
	          restored if the MemoryStore entry expires. Other servers are
	          told about changes through MessagingService and refresh.

	Transactions
	  RankService:Run(label, mutator) runs mutator(model, state, now) and
	  returns the events. In Global mode it retries, and failed operations are
	  queued and replayed in order instead of being dropped.
	  After every run the state is validated (no over-capacity ranks).
]]

local HttpService = game:GetService("HttpService")
local MessagingService = game:GetService("MessagingService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local HierarchyModel = require(ReplicatedStorage.Kingdom.Shared.HierarchyModel)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local StoreUtil = require(script.Parent.Parent.Core.StoreUtil)

local RankService = {
	Name = "RankService",
	Dependencies = { "DataService", "AuditService", "StateService" },
}

local MEMORY_EXPIRATION = 30 * 24 * 3600
local MAX_ENCODED_BYTES = 30000

function RankService:Init()
	self._data = self:Use("DataService")
	self._audit = self:Use("AuditService")
	self._state = self:Use("StateService")

	self.Changed = Signal.new("HierarchyChanged") -- (events, label)
	self.PlayerRankChanged = Signal.new("PlayerRankChanged") -- (player, oldId, newId, cause)

	self.IsGlobal = GameConfig.KingdomScope == "Global"
	self.Model = HierarchyModel.new(RankConfig.Ranks, {
		Mode = GameConfig.EmptyRankFillingMode,
		PromotionCooldown = GameConfig.PromotionCooldownSeconds,
		RequireOnline = not (self.IsGlobal and GameConfig.Global.PromoteOfflinePlayers),
		OnlineWindow = self.IsGlobal and GameConfig.Global.OnlineWindowSeconds or nil,
		RejoinPolicy = GameConfig.RejoinPolicy,
		DemotionBlock = GameConfig.DemotionPromotionBlockSeconds,
	})
	self.State = HierarchyModel.newState()
	self._busy = false
	self._pending = {}
	self._lastKnownRank = {} -- [userIdString] = rankId for local players

	if self.IsGlobal then
		self._map = StoreUtil.GetHashMap(GameConfig.Global.HierarchyMapName)
		self._backup = StoreUtil.GetDataStore(GameConfig.Global.BackupDataStore)
		self:_loadGlobalSeed()
	end
end

function RankService:Start()
	if self.IsGlobal then
		local topic = GameConfig.Global.MessagingTopic
		pcall(function()
			MessagingService:SubscribeAsync(topic, function(message)
				local data = message.Data
				if type(data) == "table" and data.server ~= game.JobId and (data.v or 0) > (self.State.v or 0) then
					task.spawn(self.Refresh, self)
				end
			end)
		end)
		self.Registry:Every(self.Name, "refresh", 20, function()
			self:Refresh()
		end)
		self.Registry:Every(self.Name, "replayPending", 5, function()
			self:_replayPending()
		end)
		self.Registry:Every(self.Name, "backup", GameConfig.Global.BackupIntervalSeconds, function()
			self:_backupState()
		end)
	end
	self.Registry:Every(self.Name, "publishSummary", 2, function()
		self:_publishSummary()
	end)
end

-- Serialization ---------------------------------------------------------------

local function encode(state): string
	return HttpService:JSONEncode(state)
end

local function decode(value)
	if type(value) == "string" then
		local ok, result = pcall(HttpService.JSONDecode, HttpService, value)
		if ok and type(result) == "table" and type(result.m) == "table" then
			return result
		end
	elseif type(value) == "table" and type(value.m) == "table" then
		return value
	end
	return nil
end

function RankService:_loadGlobalSeed()
	local ok, current = pcall(function()
		return self._map:GetAsync(GameConfig.Global.HierarchyKey)
	end)
	local state = ok and decode(current) or nil
	if not state then
		local backupOk, backup = pcall(function()
			return self._backup:GetAsync(GameConfig.Global.HierarchyKey)
		end)
		state = backupOk and decode(backup) or nil
		if state then
			self._audit:Log("Rank", "RestoredFromBackup", { version = state.v })
		end
	end
	self._seed = state or HierarchyModel.newState()
	self.State = self._seed
end

-- Core transaction -----------------------------------------------------------

local function now(): number
	return os.time()
end

function RankService:_runLocal(label: string, mutator)
	local t = now()
	local events = mutator(self.Model, self.State, t) or {}
	for _, event in ipairs(self.Model:Validate(self.State, t)) do
		table.insert(events, event)
	end
	self.State.v = (self.State.v or 0) + 1
	return events
end

function RankService:_runGlobal(label: string, mutator)
	local events, resultState
	local ok, err = StoreUtil.Retry("Hierarchy:" .. label, 3, function()
		self._map:UpdateAsync(GameConfig.Global.HierarchyKey, function(old)
			local state = decode(old) or self._seed or HierarchyModel.newState()
			local t = now()
			events = mutator(self.Model, state, t) or {}
			for _, event in ipairs(self.Model:Validate(state, t)) do
				table.insert(events, event)
			end
			state.v = (state.v or 0) + 1
			local encoded = encode(state)
			if #encoded > MAX_ENCODED_BYTES then
				-- Shed idle bottom-rank entries to stay within MemoryStore limits.
				self.Model:PruneStale(state, t, { forgetBottomAfter = 60 })
				encoded = encode(state)
			end
			resultState = state
			return encoded
		end, MEMORY_EXPIRATION)
	end)
	if not ok then
		return nil, err
	end
	self.State = resultState
	self._seed = resultState
	task.spawn(function()
		pcall(MessagingService.PublishAsync, MessagingService, GameConfig.Global.MessagingTopic, {
			v = resultState.v,
			server = game.JobId,
		})
	end)
	return events
end

-- Runs a hierarchy transaction. Yields in Global mode. Returns events.
function RankService:Run(label: string, mutator): { any }
	while self._busy do
		task.wait()
	end
	self._busy = true
	local ok, events, err = pcall(function()
		if self.IsGlobal then
			return self:_runGlobal(label, mutator)
		end
		return self:_runLocal(label, mutator)
	end)
	self._busy = false

	if not ok or events == nil then
		self.Log:Error("transaction %s failed: %s", label, tostring(ok and err or events))
		if self.IsGlobal then
			-- Never drop a hierarchy change: queue it for replay.
			table.insert(self._pending, { label = label, mutator = mutator })
			self.Registry:SetDegraded(self.Name, "hierarchy store unavailable")
		end
		return {}
	end

	self:_afterChange(events, label)
	return events
end

function RankService:_replayPending()
	if #self._pending == 0 then
		return
	end
	local queue = self._pending
	self._pending = {}
	for index, op in ipairs(queue) do
		local events, err = nil, nil
		while self._busy do
			task.wait()
		end
		self._busy = true
		local ok, result, resultErr = pcall(self._runGlobal, self, op.label, op.mutator)
		self._busy = false
		events, err = result, resultErr
		if not ok or events == nil then
			-- Put this and everything after it back, in order.
			for i = index, #queue do
				table.insert(self._pending, queue[i])
			end
			error("replay failed: " .. tostring(ok and err or result))
		end
		self:_afterChange(events, op.label)
	end
	self.Registry:SetRecovered(self.Name)
end

-- Re-reads the global state (another server changed it).
function RankService:Refresh()
	if not self.IsGlobal then
		return
	end
	local ok, value = pcall(function()
		return self._map:GetAsync(GameConfig.Global.HierarchyKey)
	end)
	local state = ok and decode(value) or nil
	if state and (state.v or 0) > (self.State.v or 0) then
		self.State = state
		self._seed = state
		self:_afterChange({}, "Refresh")
	end
end

function RankService:_backupState()
	local snapshot = self.State
	if not snapshot or not snapshot.v or snapshot.v == 0 then
		return
	end
	local acquired = false
	pcall(function()
		self._map:UpdateAsync("BackupLock", function(old)
			if old and old ~= game.JobId then
				return nil
			end
			acquired = true
			return game.JobId
		end, GameConfig.Global.BackupIntervalSeconds)
	end)
	if not acquired then
		return
	end
	pcall(function()
		self._backup:UpdateAsync(GameConfig.Global.HierarchyKey, function(old)
			local stored = decode(old)
			if stored and (stored.v or 0) >= snapshot.v then
				return nil
			end
			return encode(snapshot)
		end)
	end)
end

-- Local side effects ---------------------------------------------------------

function RankService:_afterChange(events, label: string)
	-- Update every online player whose rank differs from what we last applied
	-- (covers both local events and refreshes from other servers).
	for _, player in ipairs(Players:GetPlayers()) do
		local id = tostring(player.UserId)
		local member = self.State.m[id]
		local rankId = member and member.r or nil
		local previous = self._lastKnownRank[id]
		if rankId and rankId ~= previous then
			self._lastKnownRank[id] = rankId
			local cause = "Sync"
			for _, event in ipairs(events) do
				if event.id == id and event.to == rankId then
					cause = event.cause or event.k
				elseif event.id == id and event.k == "Reset" then
					cause = "Death"
				end
			end
			self:_applyToPlayer(player, previous, rankId, cause)
		end
	end
	for _, event in ipairs(events) do
		self._audit:Log("Rank", event.k, event)
	end
	self.Changed:Fire(events, label)
end

function RankService:_applyToPlayer(player: Player, oldId: string?, newId: string, cause: string)
	local def = RankConfig.Get(newId)
	if not def then
		return
	end
	player:SetAttribute("KingdomRank", def.Id)
	player:SetAttribute("KingdomRankName", def.DisplayName)
	player:SetAttribute("KingdomRankOrder", def.Order)
	player:SetAttribute("KingdomChatTag", def.ChatTag)
	player:SetAttribute("KingdomRankColor", def.Color)
	player:SetAttribute("KingdomRankSince", os.time())

	local profile = self._data:Get(player)
	if profile then
		profile.Rank = def.Id
		if def.Order > (profile.Life.HighestRankOrder or 1) then
			profile.Life.HighestRankOrder = def.Order
			profile.Life.HighestRank = def.Id
		end
		if def.Order > (profile.Lifetime.HighestRankOrder or 1) then
			profile.Lifetime.HighestRankOrder = def.Order
			profile.Lifetime.HighestRank = def.Id
		end
	end
	self._state:Set(player, "Rank", {
		Id = def.Id,
		Name = def.DisplayName,
		Order = def.Order,
		Since = os.time(),
	})
	self.PlayerRankChanged:Fire(player, oldId, newId, cause)
end

function RankService:ForgetPlayer(player: Player)
	self._lastKnownRank[tostring(player.UserId)] = nil
end

function RankService:_publishSummary()
	local counts = self.Model:CountByRank(self.State)
	local summary = {}
	for _, rank in ipairs(RankConfig.Sorted()) do
		local holders
		if rank.MaxSlots and rank.MaxSlots <= 3 then
			holders = {}
			for _, entry in ipairs(self.Model:GetQueue(self.State, rank.Id)) do
				table.insert(holders, entry.n or entry.id)
			end
		end
		table.insert(summary, {
			Id = rank.Id,
			Name = rank.DisplayName,
			Count = counts[rank.Id] or 0,
			Max = rank.MaxSlots,
			Holders = holders,
		})
	end
	self._state:SetGlobal("Hierarchy", summary)
end

-- Queries ------------------------------------------------------------------

local function idOf(target): string
	if typeof(target) == "Instance" and target:IsA("Player") then
		return tostring(target.UserId)
	end
	return tostring(target)
end

function RankService:GetMember(target)
	return self.State.m[idOf(target)]
end

function RankService:GetRankId(target): string
	local member = self.State.m[idOf(target)]
	return member and member.r or RankConfig.Bottom().Id
end

function RankService:GetRankDef(target)
	return RankConfig.Get(self:GetRankId(target)) or RankConfig.Bottom()
end

function RankService:GetOrder(target): number
	return self:GetRankDef(target).Order
end

function RankService:IsInHierarchy(target): boolean
	return self.State.m[idOf(target)] ~= nil
end

function RankService:GetQueue(rankId: string)
	return self.Model:GetQueue(self.State, rankId)
end

function RankService:GetPosition(target)
	return self.Model:GetPosition(self.State, idOf(target), now())
end

function RankService:GetActiveCount(): number
	return self.Model:ActiveCount(self.State, now())
end

function RankService:CountByRank()
	return self.Model:CountByRank(self.State)
end

-- Online players holding a rank (in this server).
function RankService:GetPlayersOfRank(rankId: string): { Player }
	local result = {}
	for _, player in ipairs(Players:GetPlayers()) do
		if self:GetRankId(player) == rankId then
			table.insert(result, player)
		end
	end
	return result
end

function RankService:GetDisplayName(id: string): string
	local member = self.State.m[id]
	if member and member.n then
		return member.n
	end
	local userId = tonumber(id)
	local player = userId and Players:GetPlayerByUserId(userId)
	return player and player.DisplayName or ("#" .. id)
end

return RankService
