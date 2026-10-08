--[[
	DataService
	Persistent player data with session locking.

	Safety guarantees
	  * Loads and saves use UpdateAsync only (never blind SetAsync).
	  * A session lock (server JobId + timestamp) stops two servers from
	    owning one profile. Saves verify the lock is still ours; if another
	    server took it, this server stops writing and removes the player.
	  * A failed load NEVER produces default data that could be saved over
	    real data. The player enters Safe Mode: they can walk around, but
	    progression actions are refused and nothing is saved until a
	    background retry succeeds.
	  * One save at a time per player; a save requested during a save is
	    queued, not run in parallel.
	  * Death resets are saved immediately (SaveNow) so rejoining can never
	    load a pre-death profile.
	  * BindToClose saves every loaded player before shutdown.
	  * Saved rank is informational only; the hierarchy is rebuilt server-side.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local EconomyConfig = require(ReplicatedStorage.Kingdom.Config.EconomyConfig)
local FoodConfig = require(ReplicatedStorage.Kingdom.Config.FoodConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Net = require(script.Parent.Parent.Core.Net)
local StoreUtil = require(script.Parent.Parent.Core.StoreUtil)

local DataService = {
	Name = "DataService",
	Dependencies = { "AuditService" },
}

local SCHEMA_VERSION = 1
local SAFE_MODE_RETRY_SECONDS = 30

local function jobId(): string
	return game.JobId ~= "" and game.JobId or ("studio-" .. HttpService:GenerateGUID(false))
end

local SERVER_ID = jobId()

function DataService.NewProfile(userId: number)
	local now = os.time()
	local bottom = RankConfig.Bottom().Id
	return {
		Version = SCHEMA_VERSION,
		UserId = userId,
		Rank = bottom, -- informational; hierarchy is rebuilt server-side
		XP = { Job = 0, Management = 0, Leadership = 0, Contribution = 0 },
		Life = {
			Number = 1,
			StartedAt = now,
			HighestRank = bottom,
			HighestRankOrder = 1,
			XPEarned = 0,
			JobsCompleted = 0,
			Promotions = 0,
		},
		Lifetime = {
			XPEarned = 0,
			HighestXP = 0,
			HighestRank = bottom,
			HighestRankOrder = 1,
			JobsCompleted = 0,
			Deaths = 0,
			Contributions = 0,
			MoneyEarned = 0,
			Promotions = 0,
			ProjectsCompleted = 0,
			MeetingsAttended = 0,
			ActiveSeconds = 0,
		},
		CareerHistory = {},
		Coins = EconomyConfig.Currency.StartingCoins,
		Inventory = { Items = {}, Tools = {}, NextToolId = 1 },
		PersonalStorage = { Items = {} },
		Escrow = {},
		Hunger = FoodConfig.Hunger.Start,
		Sick = false,
		StarvingMinutes = 0,
		Department = nil,
		Reputation = { Management = 50 },
		ManagementStats = {
			OrdersCreated = 0,
			OrdersCompleted = 0,
			OrdersFailed = 0,
			Inspections = 0,
			CrisesPrevented = 0,
			DepartmentTargetsMet = 0,
			GameHoursManaged = 0,
		},
		Attendance = { Attended = 0, Missed = 0, ConsecutiveMissed = 0, Excused = 0 },
		Discipline = { History = {}, Warnings = {}, SuspendedUntil = 0, FinesPaid = 0 },
		Achievements = {},
		UnlockedJobs = {},
		JobStats = {},
		Cosmetics = {},
		Titles = {},
		ProcessedReceipts = {},
		StarterKitLife = 0,
		Meta = { Created = now, LastSaved = 0, LastJoin = now, SaveCount = 0 },
	}
end

-- Adds missing fields from the template without touching existing values.
local function reconcile(target, template)
	for key, value in pairs(template) do
		if target[key] == nil then
			if type(value) == "table" then
				target[key] = table.clone(value)
				reconcile(target[key], value)
			else
				target[key] = value
			end
		elseif type(value) == "table" and type(target[key]) == "table" then
			-- Only recurse into record-like templates (non-empty).
			if next(value) ~= nil then
				reconcile(target[key], value)
			end
		end
	end
end

local function finiteNonNegative(n): boolean
	return type(n) == "number" and n == n and n >= 0 and n < math.huge
end

-- Repairs individual invalid fields (never wipes the profile).
function DataService:_validate(profile, userId: number)
	local repairs = {}
	if type(profile.XP) ~= "table" then
		profile.XP = {}
		table.insert(repairs, "XP table")
	end
	for _, category in ipairs({ "Job", "Management", "Leadership", "Contribution" }) do
		if not finiteNonNegative(profile.XP[category]) then
			profile.XP[category] = 0
			table.insert(repairs, "XP." .. category)
		end
	end
	if not finiteNonNegative(profile.Coins) then
		profile.Coins = 0
		table.insert(repairs, "Coins")
	end
	profile.Coins = math.min(math.floor(profile.Coins), EconomyConfig.Currency.MaxCoins)
	if type(profile.Inventory) ~= "table" or type(profile.Inventory.Items) ~= "table" then
		profile.Inventory = { Items = {}, Tools = {}, NextToolId = 1 }
		table.insert(repairs, "Inventory")
	end
	for itemId, count in pairs(profile.Inventory.Items) do
		if not finiteNonNegative(count) or count == 0 then
			profile.Inventory.Items[itemId] = nil
		end
	end
	if not RankConfig.Get(profile.Rank) then
		profile.Rank = RankConfig.Bottom().Id
		table.insert(repairs, "Rank")
	end
	if type(profile.Hunger) ~= "number" or profile.Hunger ~= profile.Hunger then
		profile.Hunger = FoodConfig.Hunger.Start
	end
	profile.Hunger = math.clamp(profile.Hunger, 0, FoodConfig.Hunger.Max)
	profile.UserId = userId
	if #repairs > 0 then
		self._audit:Log("Data", "Repaired", { userId = userId, fields = table.concat(repairs, ",") })
	end
end

function DataService:Init()
	self._audit = self:Use("AuditService")
	self.Loaded = Signal.new("DataLoaded") -- (player, profile)
	self.LoadFailed = Signal.new("DataLoadFailed") -- (player, reason)
	self.Saved = Signal.new("DataSaved") -- (player, reason)

	self._sessions = {} -- [Player] = session
	self._store = StoreUtil.GetDataStore(GameConfig.Data.PlayerStore)
	self._banStore = StoreUtil.GetDataStore(GameConfig.Data.BanStore)
	self._leaderboard = StoreUtil.GetOrderedDataStore(GameConfig.Data.LeaderboardStore)

	-- Gate every progression remote on a loaded, non-safe-mode profile.
	Net.SetGate(function(player)
		local session = self._sessions[player]
		if not session or not session.loaded then
			return false, "Your records are still being fetched from the royal archive."
		end
		if session.safeMode then
			return false, "Kingdom records are unavailable. Progress is paused for your safety."
		end
		return true
	end)

	ReplicatedStorage.Kingdom:SetAttribute("SavesDisabled", StoreUtil.IsMock())

	game:BindToClose(function()
		self:_saveAllOnShutdown()
	end)
end

function DataService:Start()
	self.Registry:Every(self.Name, "autosave", GameConfig.Data.AutosaveSeconds, function()
		if self._shuttingDown then
			return
		end
		local players = Players:GetPlayers()
		local spacing = math.min(1, GameConfig.Data.AutosaveSeconds / math.max(#players, 1) / 2)
		for _, player in ipairs(players) do
			local session = self._sessions[player]
			if session and session.loaded and not session.safeMode then
				task.spawn(self.SaveNow, self, player, "Autosave")
				task.wait(spacing)
			end
		end
	end)
end

local function key(userId: number): string
	return "Player_" .. tostring(userId)
end

-- Returns ban record if banned.
function DataService:GetBan(userId: number)
	local ok, record = pcall(function()
		return self._banStore:GetAsync("Ban_" .. userId)
	end)
	if ok and type(record) == "table" then
		if record.Until and record.Until > 0 and os.time() > record.Until then
			return nil
		end
		return record
	end
	return nil
end

function DataService:SetBan(userId: number, reason: string, durationSeconds: number?, by: number?)
	local record = {
		Reason = reason,
		Until = durationSeconds and durationSeconds > 0 and (os.time() + durationSeconds) or 0,
		By = by,
		At = os.time(),
	}
	return StoreUtil.Retry("SetBan", 3, function()
		self._banStore:SetAsync("Ban_" .. userId, record)
	end)
end

function DataService:RemoveBan(userId: number)
	return StoreUtil.Retry("RemoveBan", 3, function()
		self._banStore:RemoveAsync("Ban_" .. userId)
	end)
end

-- Loads (yields). Returns profile or nil (player is then in Safe Mode).
function DataService:Load(player: Player)
	local session = {
		loaded = false,
		safeMode = false,
		saving = false,
		resaveQueued = false,
		profile = nil,
		releasing = false,
		lostLock = false,
	}
	self._sessions[player] = session

	local ban = self:GetBan(player.UserId)
	if ban then
		player:Kick("You are banned from the kingdom: " .. tostring(ban.Reason))
		return nil
	end

	local profile, failure = self:_loadProfile(player.UserId)
	if player.Parent ~= Players then
		-- Left while loading: release the lock we may have taken.
		if profile then
			task.spawn(self._releaseLock, self, player.UserId)
		end
		self._sessions[player] = nil
		return nil
	end

	if not profile then
		if failure == "Locked" then
			player:Kick("Your kingdom records are still being saved by another server. Please rejoin in a moment.")
			self._sessions[player] = nil
			return nil
		end
		session.safeMode = true
		session.loaded = true
		player:SetAttribute("KingdomSafeMode", true)
		self._audit:Log("Data", "SafeMode", { userId = player.UserId, reason = failure })
		self.LoadFailed:Fire(player, failure)
		task.spawn(self._safeModeRetry, self, player)
		return nil
	end

	self:_activate(player, session, profile)
	return profile
end

function DataService:_activate(player: Player, session, profile)
	reconcile(profile, DataService.NewProfile(player.UserId))
	self:_validate(profile, player.UserId)
	profile.Meta.LastJoin = os.time()
	session.profile = profile
	session.loaded = true
	session.safeMode = false
	session.dirty = false
	player:SetAttribute("KingdomSafeMode", false)
	player:SetAttribute("KingdomDataLoaded", true)
	self.Loaded:Fire(player, profile)
end

function DataService:_safeModeRetry(player: Player)
	while player.Parent == Players do
		task.wait(SAFE_MODE_RETRY_SECONDS)
		local session = self._sessions[player]
		if not session or not session.safeMode then
			return
		end
		local profile, failure = self:_loadProfile(player.UserId)
		if profile and player.Parent == Players then
			self._audit:Log("Data", "SafeModeRecovered", { userId = player.UserId })
			self:_activate(player, session, profile)
			return
		elseif failure == "Locked" then
			-- keep waiting; the other server will release or time out
		end
	end
end

function DataService:_loadProfile(userId: number)
	local lockedByOther = false
	local loaded = nil
	local attempts = GameConfig.Data.LoadRetries
	for attempt = 1, attempts do
		lockedByOther = false
		local ok, result = pcall(function()
			return self._store:UpdateAsync(key(userId), function(stored)
				stored = stored or {}
				local lock = stored.Lock
				if lock and lock.Job ~= SERVER_ID and os.time() - (lock.Time or 0) < GameConfig.Data.SessionLockTimeoutSeconds then
					lockedByOther = true
					return nil -- abort: do not write
				end
				lockedByOther = false
				stored.Lock = { Job = SERVER_ID, Time = os.time() }
				return stored
			end)
		end)
		if ok and not lockedByOther then
			local stored = result or {}
			loaded = stored.Data
			if type(loaded) ~= "table" then
				loaded = DataService.NewProfile(userId) -- genuinely new player
			end
			return loaded, nil
		end
		if not ok then
			self.Log:Warn("load %d failed (attempt %d): %s", userId, attempt, tostring(result))
		end
		task.wait(lockedByOther and 4 or math.min(2 ^ attempt, 10))
	end
	return nil, lockedByOther and "Locked" or "Unavailable"
end

function DataService:_write(userId: number, profile, release: boolean)
	local lostLock = false
	local ok, err = pcall(function()
		self._store:UpdateAsync(key(userId), function(stored)
			stored = stored or {}
			local lock = stored.Lock
			if lock and lock.Job ~= SERVER_ID then
				lostLock = true
				return nil
			end
			profile.Meta.LastSaved = os.time()
			profile.Meta.SaveCount = (profile.Meta.SaveCount or 0) + 1
			stored.Data = profile
			stored.Lock = (not release) and { Job = SERVER_ID, Time = os.time() } or nil
			return stored
		end)
	end)
	return ok, err, lostLock
end

function DataService:_releaseLock(userId: number)
	pcall(function()
		self._store:UpdateAsync(key(userId), function(stored)
			if stored and stored.Lock and stored.Lock.Job == SERVER_ID then
				stored.Lock = nil
				return stored
			end
			return nil
		end)
	end)
end

-- Saves immediately (yields). Returns true on success.
function DataService:SaveNow(player: Player, reason: string?, release: boolean?): boolean
	local session = self._sessions[player]
	if not session or not session.loaded or session.safeMode or not session.profile or session.lostLock then
		return false
	end
	-- Once shutdown begins every save releases the lock, so a late autosave
	-- can never re-lock a profile this server is about to abandon.
	if self._shuttingDown then
		release = true
	end
	if session.saving then
		session.resaveQueued = true
		session.resaveRelease = session.resaveRelease or release
		-- Wait for the in-flight save + queued save to finish.
		while session.saving do
			task.wait(0.1)
		end
		return session.lastSaveOk == true
	end
	session.saving = true
	local okResult = false
	repeat
		session.resaveQueued = false
		local doRelease = release or session.resaveRelease
		session.resaveRelease = nil
		for attempt = 1, GameConfig.Data.SaveRetries do
			local ok, err, lostLock = self:_write(player.UserId, session.profile, doRelease == true)
			if lostLock then
				session.lostLock = true
				self._audit:Log("Data", "LockLost", { userId = player.UserId })
				if player.Parent == Players then
					player:Kick("Your kingdom records were opened by another server.")
				end
				okResult = false
				break
			end
			if ok then
				okResult = true
				break
			end
			self.Log:Warn("save %s failed (attempt %d): %s", player.Name, attempt, tostring(err))
			task.wait(math.min(2 ^ attempt, 8))
		end
	until not session.resaveQueued or session.lostLock
	session.saving = false
	session.lastSaveOk = okResult
	if okResult then
		self.Saved:Fire(player, reason or "Save")
	end
	return okResult
end

-- Final save + lock release. Called by SessionService after every other
-- service finished its leave handling.
function DataService:Release(player: Player)
	local session = self._sessions[player]
	if not session then
		return
	end
	session.releasing = true
	if session.loaded and not session.safeMode and session.profile then
		self:SaveNow(player, "Leave", true)
		self:_updateLeaderboard(player.UserId, session.profile)
	end
	self._sessions[player] = nil
end

function DataService:_updateLeaderboard(userId: number, profile)
	if StoreUtil.IsMock() or not StoreUtil.HasBudget(Enum.DataStoreRequestType.SetIncrementSortedAsync, 3) then
		return
	end
	pcall(function()
		self._leaderboard:SetAsync(tostring(userId), math.floor(profile.Lifetime.XPEarned or 0))
	end)
end

function DataService:_saveAllOnShutdown()
	self._shuttingDown = true
	local pending = 0
	for player, session in pairs(self._sessions) do
		if session.loaded and not session.safeMode and session.profile then
			pending += 1
			task.spawn(function()
				self:SaveNow(player, "Shutdown", true)
				pending -= 1
			end)
		end
	end
	local deadline = os.clock() + 25
	while pending > 0 and os.clock() < deadline do
		task.wait(0.2)
	end
end

-- Accessors ---------------------------------------------------------------

function DataService:Get(player: Player)
	local session = self._sessions[player]
	if session and session.loaded and not session.safeMode then
		return session.profile
	end
	return nil
end

function DataService:IsLoaded(player: Player): boolean
	local session = self._sessions[player]
	return session ~= nil and session.loaded and not session.safeMode
end

function DataService:IsSafeMode(player: Player): boolean
	local session = self._sessions[player]
	return session ~= nil and session.safeMode
end

-- Admin data reset: replaces the profile with a fresh one but keeps the
-- session lock. Logged.
function DataService:ResetProfile(player: Player, keepLifetime: boolean?)
	local session = self._sessions[player]
	if not session or not session.profile then
		return false
	end
	local fresh = DataService.NewProfile(player.UserId)
	if keepLifetime then
		fresh.Lifetime = session.profile.Lifetime
		fresh.Achievements = session.profile.Achievements
		fresh.CareerHistory = session.profile.CareerHistory
	end
	session.profile = fresh
	self._audit:Log("Admin", "ProfileReset", { userId = player.UserId, keepLifetime = keepLifetime })
	task.spawn(self.SaveNow, self, player, "AdminReset")
	return true
end

return DataService
