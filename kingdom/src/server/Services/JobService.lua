--[[
	JobService
	The universal job framework. Jobs are defined in JobConfig and bound to
	map markers by CollectionService tags. Each job has a Kind module in
	Services/Jobs that implements the actual interaction mechanics.

	There is no "select Farmer from a menu and earn XP anywhere":
	  * players must physically be at the marker (distance + zone checks)
	  * every step is a real interaction (held prompts with server-timed
	    holds, reaction windows, quizzes, patrols, deliveries)
	  * the server validates rank, permission, department, tools, cooldowns,
	    node availability, travel plausibility and capacity before anything
	    is rewarded, and computes every reward itself.

	Performance
	  score = 1 + skill + following orders + streak - mistakes
	          - hunger/sickness + fine tool
	  tier  = Poor 0.5x | Normal 1x | Excellent 1.25x | Outstanding 1.5x
	Yields are multiplied by productivity: kingdom (stage x morale x taxes),
	department efficiency, building condition, weather/season, events,
	tool condition and the marker's QualityMultiplier.

	This service is the "ctx" every Kind module receives.
]]

local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ItemConfig = require(ReplicatedStorage.Kingdom.Config.ItemConfig)
local JobConfig = require(ReplicatedStorage.Kingdom.Config.JobConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)
local PromptUtil = require(script.Parent.Parent.Core.PromptUtil)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local JobService = {
	Name = "JobService",
	Dependencies = {
		"InventoryService",
		"ResourceService",
		"XPService",
		"EconomyService",
		"PermissionService",
		"ActivityService",
		"BuildingService",
		"KingdomService",
		"DepartmentService",
		"WeatherService",
		"FoodService",
		"CharacterService",
		"NotificationService",
		"AuditService",
		"TimeService",
		"DataService",
		"StateService",
		"RankService",
	},
}

local GENERIC_TAG = "KingdomJobStation"

function JobService:Init()
	self.Inventory = self:Use("InventoryService")
	self.Resources = self:Use("ResourceService")
	self.XP = self:Use("XPService")
	self.Economy = self:Use("EconomyService")
	self.Permission = self:Use("PermissionService")
	self.Activity = self:Use("ActivityService")
	self.Buildings = self:Use("BuildingService")
	self.Kingdom = self:Use("KingdomService")
	self.Departments = self:Use("DepartmentService")
	self.Weather = self:Use("WeatherService")
	self.Food = self:Use("FoodService")
	self.Character = self:Use("CharacterService")
	self.Notify = self:Use("NotificationService")
	self.Audit = self:Use("AuditService")
	self.Time = self:Use("TimeService")
	self.Data = self:Use("DataService")
	self.State = self:Use("StateService")
	self.Rank = self:Use("RankService")
	self.Net = Net
	self.PromptUtil = PromptUtil
	self.ZoneUtil = ZoneUtil
	self.Config = JobConfig

	self.TaskCompleted = Signal.new("TaskCompleted") -- (player, jobId, info)
	self.MistakeMade = Signal.new("MistakeMade") -- (player, jobId, reason)
	self.StationEvent = Signal.new("StationEvent") -- (kind, station, data)

	self._kinds = {}
	self._stations = {} -- [stationId] = station
	self._byInstance = {} -- [Instance] = station
	self._sessions = {} -- [Player] = session
	self._withdrawn = {} -- [Player] = { hour, units }
	self._yieldModifiers = {}
	self._ordersProvider = nil
	self._nextId = 0

	local kindsFolder = script.Parent:FindFirstChild("Jobs")
	if kindsFolder then
		for _, module in ipairs(kindsFolder:GetChildren()) do
			if module:IsA("ModuleScript") then
				local ok, kind = pcall(require, module)
				if ok and type(kind) == "table" then
					self._kinds[module.Name] = kind
				else
					self.Log:Error("job kind %s failed to load: %s", module.Name, tostring(kind))
				end
			end
		end
	end

	self.Kingdom:SetSecurityProvider(function()
		return self:GetGuardsOnDuty()
	end)

	Players.PlayerRemoving:Connect(function(player)
		self:CancelAll(player, "Left")
		self._sessions[player] = nil
		self._withdrawn[player] = nil
	end)

	self.Time.MinuteChanged:Connect(function()
		for name, kind in pairs(self._kinds) do
			if kind.GameMinuteTick then
				local ok, err = pcall(kind.GameMinuteTick, self)
				if not ok then
					self.Log:Error("%s minute tick failed: %s", name, tostring(err))
				end
			end
		end
	end)

	Net.Action("Job", "Interact", { rate = 3, burst = 6 }, function(player, payload)
		local stationId = Check.string(payload.station, 40)
		local station = stationId and self._stations[stationId]
		if not station then
			return false, "That workplace is gone."
		end
		local kind = self._kinds[station.KindName]
		if not kind or not kind.HandleAction then
			return false, "Nothing to do here."
		end
		return kind.HandleAction(self, player, station, payload)
	end)

	Net.Query("JobStatus", { rate = 1, burst = 2 }, function(player)
		return self:_sessionView(player)
	end)
end

function JobService:Start()
	for _, job in pairs(JobConfig.Jobs) do
		for _, tag in ipairs(job.Tags or {}) do
			for _, instance in ipairs(CollectionService:GetTagged(tag)) do
				self:_attach(instance, job)
			end
			CollectionService:GetInstanceAddedSignal(tag):Connect(function(instance)
				self:_attach(instance, job)
			end)
		end
	end
	for _, instance in ipairs(CollectionService:GetTagged(GENERIC_TAG)) do
		self:_attachGeneric(instance)
	end
	CollectionService:GetInstanceAddedSignal(GENERIC_TAG):Connect(function(instance)
		self:_attachGeneric(instance)
	end)
	for name, kind in pairs(self._kinds) do
		if kind.AfterAttach then
			local ok, err = pcall(kind.AfterAttach, self)
			if not ok then
				self.Log:Error("%s AfterAttach failed: %s", name, tostring(err))
			end
		end
	end
	self.Registry:Every(self.Name, "realTick", 1, function()
		for name, kind in pairs(self._kinds) do
			if kind.RealTick then
				local ok, err = pcall(kind.RealTick, self)
				if not ok then
					self.Log:Error("%s real tick failed: %s", name, tostring(err))
				end
			end
		end
	end)
	self.Registry:Every(self.Name, "publishSessions", 2, function()
		for _, player in ipairs(Players:GetPlayers()) do
			self:_publishSession(player)
		end
	end)
	local count = 0
	for _ in pairs(self._stations) do
		count += 1
	end
	self.Log:Info("%d job stations active", count)
end

-- Station registry -----------------------------------------------------------------

function JobService:_attachGeneric(instance: Instance)
	local job = JobConfig.ResolveJobType(instance:GetAttribute("JobType"))
	if not job then
		self.Log:Warn("KingdomJobStation %s has unknown JobType '%s'", instance:GetFullName(), tostring(instance:GetAttribute("JobType")))
		return
	end
	self:_attach(instance, job)
end

function JobService:_attach(instance: Instance, job)
	if self._byInstance[instance] then
		return
	end
	if not instance:IsDescendantOf(workspace) then
		return
	end
	local kind = self._kinds[job.Kind]
	if not kind or not kind.Attach then
		self.Log:Warn("job %s has no kind module %s", job.Id, tostring(job.Kind))
		return
	end
	local ok, station = pcall(kind.Attach, self, instance, job)
	if not ok then
		self.Log:Error("attaching %s to %s failed: %s", job.Id, instance:GetFullName(), tostring(station))
		return
	end
	if station then
		self:RegisterStation(station, instance, job, job.Kind)
	end
end

-- Kinds call this for every station they create (including generated plots).
function JobService:RegisterStation(station, instance: Instance, job, kindName: string)
	self._nextId += 1
	station.Id = station.Id or tostring(self._nextId)
	station.Instance = instance
	station.Job = job
	station.KindName = kindName
	self._stations[station.Id] = station
	self._byInstance[instance] = station
	instance:SetAttribute("KingdomStationId", station.Id)
	instance.Destroying:Connect(function()
		self._stations[station.Id] = nil
		self._byInstance[instance] = nil
	end)
	return station
end

function JobService:GetStation(stationId: string)
	return self._stations[stationId]
end

function JobService:GetStationsOfJob(jobId: string)
	local list = {}
	for _, station in pairs(self._stations) do
		if station.Job.Id == jobId then
			table.insert(list, station)
		end
	end
	return list
end

-- Per-marker attribute with job default fallback.
function JobService:Attr(instance: Instance, job, name: string, fallback: any): any
	local default = job.Defaults and job.Defaults[name]
	if default == nil then
		default = fallback
	end
	return ZoneUtil.readAttribute(instance, name, default)
end

-- Validation ------------------------------------------------------------------------

export type ValidateOptions = {
	zone: Instance?, -- player must be inside this zone
	maxDistance: number?,
	requireTool: string?,
	skipTravel: boolean?,
	anchor: Instance?, -- distance is measured to this instead of station.Instance
}

-- Returns ok, reason (reason nil = silent failure).
function JobService:Validate(player: Player, station, options)
	local opts = options or {}
	local job = station.Job
	local instance = station.AttrSource or station.Instance
	if not self.Data:IsLoaded(player) then
		return false, "Your records are still loading."
	end
	if not ZoneUtil.isAlive(player) then
		return false, nil
	end
	if instance:GetAttribute("Enabled") == false then
		return false, "This workplace is closed."
	end
	if station.Zone and station.Zone:GetAttribute("Enabled") == false then
		return false, "This area is closed."
	end
	local permission = self:Attr(instance, job, "RequiredPermission", job.Permission)
	if permission and permission ~= "" and not self.Permission:Has(player, permission) then
		local suspended = self.Permission:IsSuspended(player)
		if suspended then
			return false, "You are suspended from work."
		end
		return false, "Your rank cannot do this job yet."
	end
	local requiredRank = self:Attr(instance, job, "RequiredRank", "")
	if not self.Permission:MeetsRank(player, requiredRank) then
		local def = RankConfig.Get(requiredRank)
		return false, string.format("Requires the rank of %s.", def and def.DisplayName or requiredRank)
	end
	local requiredDept = self:Attr(instance, job, "RequiredDepartment", "")
	if requiredDept ~= "" and self.Departments:GetPlayerDepartment(player) ~= requiredDept then
		return false, string.format("Only members of %s may work here.", requiredDept)
	end
	if self.Buildings:IsDisabledFor(instance) then
		return false, "This building is too damaged to use. Builders must repair it."
	end
	local anchor = opts.anchor or station.Instance
	local maxDistance = opts.maxDistance or JobConfig.Session.MaxInteractDistance
	if ZoneUtil.playerDistance(player, anchor) > maxDistance then
		return false, "You must be at the workplace."
	end
	local zone = opts.zone or station.Zone
	if zone and not ZoneUtil.playerInside(player, zone, JobConfig.Session.ZonePadding) then
		return false, "You must be inside the work area."
	end
	local session = self:_session(player)
	if os.clock() - session.lastTaskClock < JobConfig.Session.MinSecondsBetweenTasks then
		return false, nil
	end
	if not opts.skipTravel then
		local ok, reason = self:_checkTravel(player, anchor)
		if not ok then
			return false, reason
		end
	end
	return true, nil
end

-- A task far from the previous one needs plausible travel time.
function JobService:_checkTravel(player: Player, anchor: Instance)
	local lastClock, lastPosition = self.Activity:GetLastTask(player)
	local position = ZoneUtil.getPosition(anchor)
	if not lastPosition or not position or lastClock == 0 then
		return true
	end
	local elapsed = os.clock() - lastClock
	local distance = (position - lastPosition).Magnitude
	local allowed = JobConfig.Travel.GraceStuds + elapsed * JobConfig.Travel.MaxStudsPerSecond
	if distance > allowed and not self.Activity:IsTeleportAllowed(player) then
		self.Audit:Log("AntiCheat", "ImpossibleTravel", {
			userId = player.UserId,
			distance = math.floor(distance),
			seconds = math.floor(elapsed * 10) / 10,
		})
		self.Activity.Sampled:Fire(player, position, distance, math.max(elapsed, 0.01), false)
		return false, nil
	end
	return true
end

-- Max workers in a zone/station (counts players active there recently).
function JobService:HasCapacity(player: Player, key: any, maxWorkers: number): boolean
	if not maxWorkers or maxWorkers <= 0 then
		return true
	end
	local now = os.clock()
	local count = 0
	for other, session in pairs(self._sessions) do
		if other ~= player and session.workplace == key and now - session.lastTaskClock < 90 then
			count += 1
		end
	end
	return count < maxWorkers
end

-- Storage withdrawals for work are limited per in-game hour by rank.
function JobService:TryWithdrawForWork(player: Player, items: { [string]: number }, reason: string): (boolean, string?)
	if not self.Permission:Has(player, "Storage.Withdraw") then
		return false, "Your rank may not take materials from storage."
	end
	local total = 0
	for _, amount in pairs(items) do
		total += amount
	end
	local hour = math.floor(self.Time:GetAbsoluteMinutes() / 60)
	local record = self._withdrawn[player]
	if not record or record.hour ~= hour then
		record = { hour = hour, units = 0 }
		self._withdrawn[player] = record
	end
	local limit = self.Rank:GetRankDef(player).Privileges.WithdrawPerHour or 0
	if record.units + total > limit then
		return false, string.format("Storage limit reached for this hour (%d units).", limit)
	end
	if not self.Resources:WithdrawMany(items, reason, player) then
		return false, "Kingdom storage does not have those materials."
	end
	record.units += total
	return true, nil
end

-- Productivity ----------------------------------------------------------------------

function JobService:RegisterYieldModifier(name: string, fn: (Player, string) -> number)
	self._yieldModifiers[name] = fn
end

function JobService:SetOrdersProvider(fn: (Player, string) -> boolean)
	self._ordersProvider = fn
end

function JobService:GetProductivity(player: Player, station): number
	local job = station.Job
	local value = self.Kingdom:GetProductivity()
	local deptId = self.Departments:GetDepartmentForJob(job.Id)
	if deptId then
		value *= self.Departments:GetEfficiency(deptId)
	end
	value *= self.Buildings:GetEfficiencyFor(station.Instance)
	value *= self.Weather:GetJobMultiplier(job.Id)
	value *= self:Attr(station.AttrSource or station.Instance, job, "QualityMultiplier", 1)
	for _, fn in pairs(self._yieldModifiers) do
		local ok, mult = pcall(fn, player, job.Id)
		if ok and type(mult) == "number" then
			value *= mult
		end
	end
	return math.clamp(value, 0.05, 3)
end

-- Scales a yield with randomized rounding so small multipliers still matter.
function JobService.ScaleYield(amount: number, multiplier: number): number
	local scaled = amount * multiplier
	local whole = math.floor(scaled)
	if math.random() < scaled - whole then
		whole += 1
	end
	return whole
end

-- Sessions & performance ---------------------------------------------------------------

function JobService:_session(player: Player)
	local session = self._sessions[player]
	if not session then
		session = {
			jobId = nil,
			workplace = nil,
			lastTaskClock = 0,
			streak = 0,
			mistakes = {},
			rating = 1,
			lastTier = "Normal",
			tasks = 0,
		}
		self._sessions[player] = session
	end
	return session
end

function JobService:_recentMistakes(session): number
	local now = os.clock()
	local memory = JobConfig.Performance.MistakeMemorySeconds
	local i = 1
	while i <= #session.mistakes do
		if now - session.mistakes[i] > memory then
			table.remove(session.mistakes, i)
		else
			i += 1
		end
	end
	return #session.mistakes
end

function JobService:IsFollowingOrders(player: Player, jobId: string): boolean
	local deptId = self.Departments:GetDepartmentForJob(jobId)
	if deptId and self.Departments:GetPlayerDepartment(player) == deptId then
		return true
	end
	if self._ordersProvider then
		local ok, result = pcall(self._ordersProvider, player, jobId)
		return ok and result == true
	end
	return false
end

function JobService:ComputeScore(player: Player, jobId: string, skill: number?, tool): number
	local perf = JobConfig.Performance
	local session = self:_session(player)
	local score = 1 + (skill or 0)
	if self:IsFollowingOrders(player, jobId) then
		score += perf.FollowingOrdersBonus
	end
	score += math.min(session.streak * perf.StreakBonusPerTask, perf.MaxStreakBonus)
	score -= self:_recentMistakes(session) * perf.MistakePenalty
	score -= self.Food:GetPerformancePenalty(player)
	if tool and tool.Quality == "Fine" then
		score += perf.FineToolBonus
	end
	return score
end

-- Records a mistake (affects performance score and the manager view).
function JobService:Mistake(player: Player, station, reason: string)
	local session = self:_session(player)
	table.insert(session.mistakes, os.clock())
	session.streak = 0
	session.rating = session.rating * (1 - JobConfig.Performance.RatingSmoothing) + 0.5 * JobConfig.Performance.RatingSmoothing
	self.MistakeMade:Fire(player, station.Job.Id, reason)
	self.Notify:Notify(player, "Warning", "Mistake", reason)
end

export type CompleteInfo = {
	xpShare: number?, -- fraction of XPReward (default 1)
	wageShare: number?, -- fraction of Wage (default = xpShare)
	yields: { [string]: number }?, -- resources produced (already productivity scaled)
	skill: number?, -- performance skill bonus
	tool: any?, -- tool used (for fine-tool bonus)
	units: number?, -- department task units (default 1)
	category: string?, -- XP category (default Job)
	xpOverride: number?, -- explicit base XP (contribution work)
	wageOverride: number?,
	label: string?, -- toast label
	silent: boolean?,
	extra: { [string]: any }?,
}

-- Grants the rewards for a validated, completed task. Returns summary.
function JobService:Complete(player: Player, station, info: CompleteInfo)
	local job = station.Job
	local session = self:_session(player)
	local profile = self.Data:Get(player)
	if not profile then
		return nil
	end
	local position = ZoneUtil.getPosition(station.Anchor or station.Instance)
	-- Mark the task BEFORE awarding so the AFK gate sees the interaction.
	self.Activity:MarkTask(player, position)

	local score = self:ComputeScore(player, job.Id, info.skill, info.tool)
	local tier = JobConfig.TierForScore(score)

	-- Resources into the worker's inventory (they must haul them to storage).
	local gained, lost = {}, {}
	for resourceId, amount in pairs(info.yields or {}) do
		if amount > 0 and ResourceConfig.Resources[resourceId] then
			local added = self.Inventory:Add(player, resourceId, amount, "Job:" .. job.Id)
			if added > 0 then
				gained[resourceId] = added
			end
			if added < amount then
				lost[resourceId] = amount - added
			end
		end
	end

	local source = station.AttrSource or station.Instance
	local baseXP = info.xpOverride or (self:Attr(source, job, "XPReward", 10) * (info.xpShare or 1))
	local xp = 0
	if baseXP > 0 then
		xp = self.XP:Award(player, info.category or "Job", baseXP, {
			source = "Job:" .. job.Id,
			jobId = job.Id,
			performance = tier.Multiplier,
		})
	end
	local wageBase = info.wageOverride
		or (self:Attr(source, job, "Wage", 0) * (info.wageShare or info.xpShare or 1))
	local coins = 0
	if wageBase > 0 then
		local rank = self.Rank:GetRankDef(player)
		coins = self.Economy:PayWage(player, wageBase * (rank.PayMultiplier or 1) * tier.Multiplier, "Wage:" .. job.Id)
	end

	session.jobId = job.Id
	session.workplace = station.Zone or station.Instance
	session.lastTaskClock = os.clock()
	session.streak += 1
	session.tasks += 1
	session.lastTier = tier.Name
	local smoothing = JobConfig.Performance.RatingSmoothing
	session.rating = session.rating * (1 - smoothing) + score * smoothing

	profile.Life.JobsCompleted += 1
	profile.Lifetime.JobsCompleted += 1
	local stats = profile.JobStats[job.Id] or { Completed = 0, XP = 0 }
	stats.Completed += 1
	stats.XP += xp
	profile.JobStats[job.Id] = stats

	self.Departments:RecordTask(player, job.Id)
	self.Food:OnWork(player)

	local result = {
		jobId = job.Id,
		station = station,
		xp = xp,
		coins = coins,
		tier = tier.Name,
		score = score,
		gained = gained,
		lost = lost,
		units = info.units or 1,
		extra = info.extra,
	}
	self.TaskCompleted:Fire(player, job.Id, result)

	if not info.silent then
		local parts = {}
		if xp > 0 then
			table.insert(parts, string.format("+%d XP", xp))
		end
		if coins > 0 then
			table.insert(parts, string.format("+%d coins", coins))
		end
		for resourceId, amount in pairs(gained) do
			table.insert(parts, string.format("+%d %s", amount, ResourceConfig.Resources[resourceId].DisplayName))
		end
		local text = table.concat(parts, "  ")
		if next(lost) then
			text ..= "\nInventory full! Deliver goods to storage."
		end
		self.Notify:Notify(player, "Job", (info.label or job.DisplayName) .. " · " .. tier.Name, text)
	end
	self:_publishSession(player)
	return result
end

-- Session hook: kinds restore anything owed to a returning player (escrow).
function JobService:OnPlayerJoin(player: Player)
	for name, kind in pairs(self._kinds) do
		if kind.OnPlayerJoin then
			local ok, err = pcall(kind.OnPlayerJoin, self, player)
			if not ok then
				self.Log:Error("%s OnPlayerJoin failed: %s", name, tostring(err))
			end
		end
	end
	self:_publishSession(player)
end

-- Cancels in-progress work (death, leaving, suspension). No rewards.
function JobService:CancelAll(player: Player, reason: string)
	for _, kind in pairs(self._kinds) do
		if kind.Cancel then
			pcall(kind.Cancel, self, player, reason)
		end
	end
	local session = self._sessions[player]
	if session then
		session.streak = 0
		session.jobId = nil
		session.workplace = nil
	end
	self.Net.Fire("Effect", player, "JobCancelled", { Reason = reason })
end

function JobService:GetGuardsOnDuty(): number
	local kind = self._kinds.GuardPost
	if kind and kind.CountOnDuty then
		local ok, count = pcall(kind.CountOnDuty, self)
		return ok and count or 0
	end
	return 0
end

function JobService:IsOnGuardDuty(player: Player): boolean
	local kind = self._kinds.GuardPost
	return kind ~= nil and kind.IsOnDuty ~= nil and kind.IsOnDuty(self, player) == true
end

function JobService:GetCurrentJob(player: Player): string?
	local session = self._sessions[player]
	if session and session.jobId and os.clock() - session.lastTaskClock <= JobConfig.Session.ActiveWindowSeconds then
		return session.jobId
	end
	if self:IsOnGuardDuty(player) then
		return "GuardDuty"
	end
	return nil
end

function JobService:GetPerformance(player: Player)
	local session = self:_session(player)
	return {
		Rating = session.rating,
		Streak = session.streak,
		Mistakes = self:_recentMistakes(session),
		LastTier = session.lastTier,
		Tasks = session.tasks,
		SecondsSinceTask = session.lastTaskClock > 0 and math.floor(os.clock() - session.lastTaskClock) or nil,
	}
end

function JobService:_sessionView(player: Player)
	local jobId = self:GetCurrentJob(player)
	local job = jobId and JobConfig.Get(jobId)
	local performance = self:GetPerformance(player)
	return {
		JobId = jobId,
		JobName = job and job.DisplayName or nil,
		Department = jobId and self.Departments:GetDepartmentForJob(jobId) or nil,
		Rating = math.floor(performance.Rating * 100) / 100,
		Tier = JobConfig.TierForScore(performance.Rating).Name,
		Streak = performance.Streak,
		Mistakes = performance.Mistakes,
		OnDuty = self:IsOnGuardDuty(player),
		FollowingOrders = jobId and self:IsFollowingOrders(player, jobId) or false,
	}
end

function JobService:_publishSession(player: Player)
	self.State:Set(player, "Job", self:_sessionView(player))
end

-- Helpers for kinds --------------------------------------------------------------

function JobService:NewSessionId(): string
	return HttpService:GenerateGUID(false)
end

function JobService:ToolDisplay(toolId: string?): string
	local def = toolId and ItemConfig.Get(toolId)
	return def and def.DisplayName or ""
end

function JobService:Feedback(player: Player, ok: boolean, message: string?)
	if message then
		self.Notify:Notify(player, ok and "Job" or "Warning", ok and "Work" or "Cannot work", message)
	end
end

return JobService
