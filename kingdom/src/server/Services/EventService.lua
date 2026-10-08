--[[
	EventService
	Modular kingdom events (EventConfig) that create temporary GROUP
	objectives fed by the same systems as everything else:
	  Deliver / DeliverCategory  real deliveries to storage
	  Tasks                      completed jobs (Repair = building repairs)
	  Roles                      distinct participants per job / a manager
	  Defend                     hostiles defeated, or guard watch calls
	                             when no hostile template exists
	Success splits an XP pool by contribution and applies kingdom rewards.
	Failure applies consequences gradually (stolen goods, morale, damage).
	Dangerous events always warn first (e.g. mine collapse rumbling).
]]

local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DeathConfig = require(ReplicatedStorage.Kingdom.Config.DeathConfig)
local EventConfig = require(ReplicatedStorage.Kingdom.Config.EventConfig)
local JobConfig = require(ReplicatedStorage.Kingdom.Config.JobConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local EventService = {
	Name = "EventService",
	Dependencies = {
		"TimeService",
		"WeatherService",
		"ResourceService",
		"KingdomService",
		"JobService",
		"BuildingService",
		"NotificationService",
		"XPService",
		"CharacterService",
		"CombatService",
		"AuditService",
		"EconomyService",
		"StateService",
		"DepartmentService",
	},
}

function EventService:Init()
	self._time = self:Use("TimeService")
	self._weather = self:Use("WeatherService")
	self._resources = self:Use("ResourceService")
	self._kingdom = self:Use("KingdomService")
	self._jobs = self:Use("JobService")
	self._buildings = self:Use("BuildingService")
	self._notify = self:Use("NotificationService")
	self._xp = self:Use("XPService")
	self._character = self:Use("CharacterService")
	self._combat = self:Use("CombatService")
	self._audit = self:Use("AuditService")
	self._economy = self:Use("EconomyService")
	self._state = self:Use("StateService")
	self._depts = self:Use("DepartmentService")

	self.EventStarted = Signal.new("EventStarted") -- (run)
	self.EventEnded = Signal.new("EventEnded") -- (run, success)
	self._active = {}
	self._lastStartedMinute = -math.huge

	self._jobs:RegisterYieldModifier("Events", function(_, jobId)
		local multiplier = 1
		for _, run in pairs(self._active) do
			local modifiers = run.def.Modifiers
			if modifiers and modifiers.JobMultipliers and modifiers.JobMultipliers[jobId] then
				multiplier *= modifiers.JobMultipliers[jobId]
			end
		end
		return multiplier
	end)

	-- Objective feeds ------------------------------------------------------------
	self._resources.Deposited:Connect(function(resourceId, amount, source, player)
		if source == "Delivery" and player then
			self:_progress(player, function(objective)
				if objective.Type == "Deliver" and objective.Resource == resourceId then
					return amount
				end
				if objective.Type == "DeliverCategory" then
					local def = ResourceConfig.Resources[resourceId]
					if def and def.Category == objective.Category then
						return amount
					end
				end
				return 0
			end)
		end
	end)
	self._jobs.TaskCompleted:Connect(function(player, jobId, result)
		self:_role(player, jobId)
		self:_progress(player, function(objective)
			if objective.Type == "Tasks" and objective.Job == jobId then
				return 1
			end
			if objective.Type == "Defend" and result.extra and result.extra.defend and self._combat:CountHostiles() == 0 then
				return 1
			end
			return 0
		end)
	end)
	self._buildings.Repaired:Connect(function(player)
		self:_role(player, "Construction")
		self:_progress(player, function(objective)
			return (objective.Type == "Tasks" and objective.Job == "Repair") and 1 or 0
		end)
	end)
	self._combat.HostileDefeated:Connect(function(killer)
		if killer then
			self:_role(killer, "GuardDuty")
			self:_progress(killer, function(objective)
				return objective.Type == "Defend" and 1 or 0
			end)
		end
	end)
	self._depts.Inspected:Connect(function(player, deptId)
		for _, run in pairs(self._active) do
			for _, objective in ipairs(run.objectives) do
				if objective.Type == "Roles" and objective.Roles.Manager and (objective.ManagerDepartment == nil or objective.ManagerDepartment == deptId) then
					self:_addRole(run, objective, "Manager", player)
				end
			end
		end
	end)

	self._time.HourChanged:Connect(function()
		self:_rollTriggers()
	end)
	self._time.MinuteChanged:Connect(function()
		self:_tick()
	end)
end

function EventService:Start()
	self:_publish()
end

-- Triggers -------------------------------------------------------------------------

function EventService:_isActive(eventId: string): boolean
	for _, run in pairs(self._active) do
		if run.def.Id == eventId then
			return true
		end
	end
	return false
end

function EventService:_activeCount(): number
	local count = 0
	for _ in pairs(self._active) do
		count += 1
	end
	return count
end

function EventService:_conditionsMet(def): boolean
	local trigger = def.Trigger or {}
	if #Players:GetPlayers() < (trigger.MinPlayers or 0) then
		return false
	end
	if trigger.Seasons then
		local season = self._time:GetSeason()
		if not season or not table.find(trigger.Seasons, season) then
			return false
		end
	end
	if trigger.Stages and not table.find(trigger.Stages, self._kingdom:GetStage()) then
		return false
	end
	return true
end

function EventService:_rollTriggers()
	local nowMinute = self._time:GetAbsoluteMinutes()
	if self:_activeCount() >= EventConfig.MaxConcurrent then
		return
	end
	if nowMinute - self._lastStartedMinute < EventConfig.GlobalCooldownGameMinutes then
		return
	end
	for id, def in pairs(EventConfig.Events) do
		if not self:_isActive(id) and self:_conditionsMet(def) then
			local trigger = def.Trigger or {}
			local fire = false
			if trigger.WhenFoodBelow and self._kingdom:GetNeed("Food") < trigger.WhenFoodBelow then
				fire = true
			elseif trigger.WhenTreasuryBelow and self._economy:GetTreasury() < trigger.WhenTreasuryBelow then
				fire = true
			elseif trigger.ChancePerGameHour and math.random() < trigger.ChancePerGameHour then
				fire = true
			end
			if fire then
				self:StartEvent(id)
				return
			end
		end
	end
end

-- Running events -------------------------------------------------------------------

function EventService:StartEvent(eventId: string)
	local def = EventConfig.Events[eventId]
	if not def or self:_isActive(eventId) then
		return nil
	end
	def.Id = eventId
	local nowMinute = self._time:GetAbsoluteMinutes()
	local run = {
		id = HttpService:GenerateGUID(false),
		def = def,
		endsAt = nowMinute + def.DurationGameMinutes,
		objectives = {},
		contributions = {},
		hostiles = {},
	}
	for _, objective in ipairs(def.Objectives or {}) do
		local copy = table.clone(objective)
		copy.Progress = 0
		copy.Members = {}
		table.insert(run.objectives, copy)
	end
	self._active[run.id] = run
	self._lastStartedMinute = nowMinute
	self._audit:Log("System", "EventStarted", { event = eventId })
	self._notify:Announce(def.Dangerous and "Critical" or "Information", string.upper(def.DisplayName), def.Description, { Banner = true })

	local modifiers = def.Modifiers or {}
	if modifiers.ExportMultiplier then
		require(script.Parent.Jobs.TradePost).SetExportBonus(modifiers.ExportMultiplier)
	end
	if def.ForceWeather then
		self._weather:SetWeather(def.ForceWeather, math.ceil(def.DurationGameMinutes / 60))
	end
	if def.SicknessChancePerHour then
		self._kingdom:SetOutbreakChance(def.SicknessChancePerHour)
	end
	if def.Hostiles then
		run.hostiles = self._combat:SpawnHostiles(def.Hostiles.Template, def.Hostiles.Count, def.Hostiles.SpawnTag)
	end
	if def.DangerZoneTag then
		self:_dangerSequence(run)
	end
	if def.Rewards and def.Rewards.Morale and def.Id == "RoyalWedding" then
		self._kingdom:AddMorale(def.Rewards.Morale / 3, "Celebration")
	end
	self.EventStarted:Fire(run)
	self:_publish()
	return run
end

-- Understandable danger: warn, give time to leave, then strike.
function EventService:_dangerSequence(run)
	local def = run.def
	local zones = CollectionService:GetTagged(def.DangerZoneTag)
	for _, zone in ipairs(zones) do
		for _, player in ipairs(ZoneUtil.playersInside(zone, 4)) do
			self._notify:Notify(player, "Critical", "GET OUT!", string.format("The ground rumbles! Leave within %d seconds!", def.WarningSeconds), { Banner = true })
		end
	end
	task.delay(def.WarningSeconds, function()
		if not self._active[run.id] then
			return
		end
		for _, zone in ipairs(zones) do
			for _, player in ipairs(ZoneUtil.playersInside(zone, 4)) do
				self._character:Damage(player, def.DamageInZone, DeathConfig.Causes.MineCollapse)
			end
		end
		if def.CollapseDamage then
			self._buildings:DamageType(def.CollapseDamage.Type, def.CollapseDamage.Amount, def.DisplayName)
		end
	end)
end

function EventService:_contribute(run, player: Player, amount: number)
	run.contributions[player.UserId] = (run.contributions[player.UserId] or 0) + amount
end

function EventService:_progress(player: Player, measure: (any) -> number)
	for _, run in pairs(self._active) do
		local changed = false
		for _, objective in ipairs(run.objectives) do
			local target = objective.Amount or objective.Count or 0
			if target > 0 and objective.Progress < target then
				local amount = measure(objective)
				if amount > 0 then
					objective.Progress = math.min(target, objective.Progress + amount)
					self:_contribute(run, player, amount)
					changed = true
				end
			end
		end
		if changed then
			self:_checkComplete(run)
		end
	end
end

function EventService:_addRole(run, objective, role: string, player: Player)
	local members = objective.Members[role] or {}
	objective.Members[role] = members
	if not members[player.UserId] then
		members[player.UserId] = true
		self:_contribute(run, player, 3)
		self:_checkComplete(run)
	end
end

function EventService:_role(player: Player, jobId: string)
	for _, run in pairs(self._active) do
		for _, objective in ipairs(run.objectives) do
			if objective.Type == "Roles" and objective.Roles[jobId] then
				self:_addRole(run, objective, jobId, player)
			end
		end
	end
end

local function objectiveDone(objective): boolean
	if objective.Type == "Roles" then
		for role, needed in pairs(objective.Roles) do
			local count = 0
			for _ in pairs(objective.Members[role] or {}) do
				count += 1
			end
			if count < needed then
				return false
			end
		end
		return true
	end
	return objective.Progress >= (objective.Amount or objective.Count or 0)
end

function EventService:_checkComplete(run)
	for _, objective in ipairs(run.objectives) do
		if not objectiveDone(objective) then
			self:_publish()
			return
		end
	end
	self:EndEvent(run.id, true)
end

function EventService:EndEvent(runId: string, success: boolean)
	local run = self._active[runId]
	if not run then
		return
	end
	self._active[runId] = nil
	local def = run.def
	if def.Modifiers and def.Modifiers.ExportMultiplier then
		require(script.Parent.Jobs.TradePost).SetExportBonus(1)
	end
	if def.SicknessChancePerHour then
		self._kingdom:SetOutbreakChance(0)
	end
	for _, model in ipairs(run.hostiles) do
		if model.Parent then
			model:Destroy()
		end
	end
	if success then
		self:_reward(run)
	else
		self:_consequences(run)
	end
	self._audit:Log("System", "EventEnded", { event = def.Id, success = success })
	self.EventEnded:Fire(run, success)
	self:_publish()
end

function EventService:_reward(run)
	local def = run.def
	local rewards = def.Rewards or {}
	local total = 0
	for _, amount in pairs(run.contributions) do
		total += amount
	end
	for userId, amount in pairs(run.contributions) do
		local player = Players:GetPlayerByUserId(userId)
		if player and total > 0 and rewards.XPPool then
			local xp = self._xp:Award(player, "Contribution", rewards.XPPool * amount / total, { source = "Event:" .. def.Id, ignoreAFK = true })
			self._notify:Notify(player, "Success", def.DisplayName, string.format("Your contribution earned %d XP.", xp))
		end
	end
	if rewards.Morale then
		self._kingdom:AddMorale(rewards.Morale, "Event:" .. def.Id)
	end
	if rewards.Treasury then
		self._economy:TreasuryDeposit(rewards.Treasury, "EventReward")
	end
	self._notify:Announce("Success", def.DisplayName .. " - SUCCESS", "The kingdom rose to the challenge!")
end

function EventService:_consequences(run)
	local def = run.def
	local consequences = def.Consequences or {}
	if consequences.StealResources then
		for key, fraction in pairs(consequences.StealResources) do
			for resourceId, resource in pairs(ResourceConfig.Resources) do
				if resourceId == key or resource.Category == key then
					local stock = self._resources:GetStock(resourceId)
					if stock > 0 then
						self._resources:Destroy(resourceId, math.floor(stock * fraction), "Event:" .. def.Id)
					end
				end
			end
		end
	end
	if consequences.Morale then
		self._kingdom:AddMorale(consequences.Morale, "EventFailed:" .. def.Id)
	end
	if consequences.Security then
		self._kingdom:AddSecurityBonus(consequences.Security)
	end
	if consequences.BuildingDamage then
		self._buildings:DamageType(consequences.BuildingDamage.Type, consequences.BuildingDamage.Amount, def.DisplayName)
	end
	if consequences.BuildingDamageAll then
		self._buildings:DamageAll(consequences.BuildingDamageAll, def.DisplayName)
	end
	self._notify:Announce("Critical", def.DisplayName .. " - FAILED", "The kingdom suffers the consequences.")
end

function EventService:_tick()
	local nowMinute = self._time:GetAbsoluteMinutes()
	for runId, run in pairs(self._active) do
		if nowMinute >= run.endsAt then
			self:EndEvent(runId, false)
		end
	end
	self:_publish()
end

function EventService:_publish()
	local list = {}
	local nowMinute = self._time:GetAbsoluteMinutes()
	for _, run in pairs(self._active) do
		local objectives = {}
		for _, objective in ipairs(run.objectives) do
			local text, progress, target
			if objective.Type == "Deliver" then
				text = "Deliver " .. ResourceConfig.Resources[objective.Resource].DisplayName
				progress, target = objective.Progress, objective.Amount
			elseif objective.Type == "DeliverCategory" then
				text = "Deliver any " .. objective.Category
				progress, target = objective.Progress, objective.Amount
			elseif objective.Type == "Tasks" then
				local job = JobConfig.Jobs[objective.Job]
				text = (job and job.DisplayName or objective.Job) .. " tasks"
				progress, target = objective.Progress, objective.Count
			elseif objective.Type == "Defend" then
				text = "Defend the kingdom"
				progress, target = objective.Progress, objective.Count
			elseif objective.Type == "Roles" then
				local parts = {}
				progress, target = 0, 0
				for role, needed in pairs(objective.Roles) do
					local count = 0
					for _ in pairs(objective.Members[role] or {}) do
						count += 1
					end
					target += needed
					progress += math.min(count, needed)
					table.insert(parts, string.format("%s %d/%d", role, count, needed))
				end
				text = "Crew: " .. table.concat(parts, ", ")
			end
			table.insert(objectives, { Text = text, Progress = progress or 0, Target = target or 0 })
		end
		table.insert(list, {
			Id = run.def.Id,
			Name = run.def.DisplayName,
			Description = run.def.Description,
			MinutesLeft = math.max(0, math.floor(run.endsAt - nowMinute)),
			Objectives = objectives,
			Dangerous = run.def.Dangerous == true,
		})
	end
	self._state:SetGlobal("Events", list)
end

function EventService:GetActive()
	local list = {}
	for runId, run in pairs(self._active) do
		table.insert(list, { RunId = runId, Id = run.def.Id })
	end
	return list
end

return EventService
