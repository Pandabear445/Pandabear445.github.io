--[[
	DisciplineService
	Controlled, logged discipline. Managers may act only on players they
	manage (PermissionService:CanManage), must give a reason, and are rate
	limited. Every action is written to the target's history and the audit
	log. Targets can appeal to the Senate.

	  Warn       expires after WarningExpiresGameHours; repeated active
	             warnings automatically raise a Senate demotion request
	  Fine       capped (MaxFine and a share of the target's coins);
	             goes to the treasury, not the manager
	  Suspend    removes job permissions for a while (capped)
	  Request demotion / removal  -> Senate proposal
	  Appeal     -> Senate pardon proposal
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GovernmentConfig = require(ReplicatedStorage.Kingdom.Config.GovernmentConfig)
local GameClock = require(ReplicatedStorage.Kingdom.Shared.GameClock)
local TimeConfig = require(ReplicatedStorage.Kingdom.Config.TimeConfig)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)

local DisciplineService = {
	Name = "DisciplineService",
	Dependencies = {
		"PermissionService",
		"RankService",
		"EconomyService",
		"NotificationService",
		"AuditService",
		"DataService",
		"TimeService",
		"GovernmentService",
		"JobService",
	},
}

local HISTORY_LIMIT = 50

function DisciplineService:Init()
	self._permission = self:Use("PermissionService")
	self._rank = self:Use("RankService")
	self._economy = self:Use("EconomyService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")
	self._data = self:Use("DataService")
	self._time = self:Use("TimeService")
	self._government = self:Use("GovernmentService")
	self._jobs = self:Use("JobService")

	self._actions = {} -- [userId] = { hour, count }
	self._appealed = {}
	self:_registerRemotes()
end

local function realSecondsPerGameHour(): number
	return GameClock.secondsPerGameHour(TimeConfig)
end

function DisciplineService:_record(target: Player, entry)
	local profile = self._data:Get(target)
	if not profile then
		return
	end
	entry.At = os.time()
	table.insert(profile.Discipline.History, entry)
	while #profile.Discipline.History > HISTORY_LIMIT do
		table.remove(profile.Discipline.History, 1)
	end
end

function DisciplineService:ActiveWarnings(player: Player): number
	local profile = self._data:Get(player)
	if not profile then
		return 0
	end
	local now = os.time()
	local warnings = profile.Discipline.Warnings
	for index = #warnings, 1, -1 do
		if warnings[index].Expires <= now then
			table.remove(warnings, index)
		end
	end
	return #warnings
end

-- Common checks: authority, reason, rate limit. Returns reasonText or nil, error.
function DisciplineService:_authorize(manager: Player, target: Player?, reason)
	local config = GovernmentConfig.Discipline
	if not target or target == manager then
		return nil, "Choose a player."
	end
	if not self._permission:Has(manager, "Manage.Discipline") then
		return nil, "Your rank cannot discipline others."
	end
	if not self._permission:CanManage(manager, target) then
		return nil, "That player is not under your authority."
	end
	local text = Check.string(reason, 200)
	if config.RequireReason and (not text or #text < config.MinReasonLength) then
		return nil, "Give a clear reason."
	end
	local hour = math.floor(self._time:GetAbsoluteMinutes() / 60)
	local record = self._actions[manager.UserId]
	if not record or record.hour ~= hour then
		record = { hour = hour, count = 0 }
		self._actions[manager.UserId] = record
	end
	if record.count >= config.ActionsPerManagerPerGameHour then
		return nil, "You have taken enough disciplinary actions for now."
	end
	record.count += 1
	return text or "", nil
end

-- System warnings (missed meetings) skip the manager checks.
function DisciplineService:SystemWarn(target: Player, reason: string)
	self:_applyWarning(target, nil, reason)
end

function DisciplineService:_applyWarning(target: Player, manager: Player?, reason: string)
	local profile = self._data:Get(target)
	if not profile then
		return
	end
	local config = GovernmentConfig.Discipline
	table.insert(profile.Discipline.Warnings, {
		By = manager and manager.DisplayName or "The Crown",
		Reason = reason,
		Expires = os.time() + config.WarningExpiresGameHours * realSecondsPerGameHour(),
	})
	self:_record(target, { Type = "Warning", By = manager and manager.UserId or 0, Reason = reason })
	self._audit:Log("Discipline", "Warning", { target = target.UserId, by = manager and manager.UserId, reason = reason })
	self._notify:Notify(target, "Warning", "Official warning", string.format("%s: %s", manager and manager.DisplayName or "The Crown", reason))
	if self:ActiveWarnings(target) >= config.AutoDemotionRequestWarnings then
		self._government:CreateSystemProposal("Demote", tostring(target.UserId), "Repeated warnings")
	end
end

function DisciplineService:Warn(manager: Player, target: Player?, reason)
	local text, err = self:_authorize(manager, target, reason)
	if not text or not target then
		return false, err
	end
	self:_applyWarning(target, manager, text)
	return true, "Warning issued."
end

function DisciplineService:Fine(manager: Player, target: Player?, amount, reason)
	local text, err = self:_authorize(manager, target, reason)
	if not text or not target then
		return false, err
	end
	local config = GovernmentConfig.Discipline
	local coins = self._economy:GetCoins(target)
	amount = math.min(amount or 0, config.MaxFine, math.floor(coins * config.FinePercentCap))
	if amount <= 0 then
		return false, "They cannot pay a fine."
	end
	if not self._economy:RemoveCoins(target, amount, "Fine") then
		return false, "Fine failed."
	end
	self._economy:TreasuryDeposit(amount, "Fines")
	local profile = self._data:Get(target)
	if profile then
		profile.Discipline.FinesPaid += amount
	end
	self:_record(target, { Type = "Fine", By = manager.UserId, Amount = amount, Reason = text })
	self._audit:Log("Discipline", "Fine", { target = target.UserId, by = manager.UserId, amount = amount, reason = text })
	self._notify:Notify(target, "Warning", "Fined", string.format("%s fined you %d coins: %s", manager.DisplayName, amount, text))
	return true, string.format("Fined %d coins.", amount)
end

function DisciplineService:Suspend(manager: Player, target: Player?, minutes, reason)
	local text, err = self:_authorize(manager, target, reason)
	if not text or not target then
		return false, err
	end
	local config = GovernmentConfig.Discipline
	minutes = math.clamp(minutes or 30, 5, config.MaxSuspensionGameMinutes)
	local profile = self._data:Get(target)
	if not profile then
		return false, "Not available."
	end
	profile.Discipline.SuspendedUntil = os.time() + minutes / 60 * realSecondsPerGameHour()
	self._jobs:CancelAll(target, "Suspended")
	self._permission:Publish(target)
	self:_record(target, { Type = "Suspension", By = manager.UserId, Minutes = minutes, Reason = text })
	self._audit:Log("Discipline", "Suspension", { target = target.UserId, by = manager.UserId, minutes = minutes, reason = text })
	self._notify:Notify(target, "Critical", "Suspended from work", string.format("%s suspended you for %d in-game minutes: %s", manager.DisplayName, minutes, text))
	task.delay(minutes / 60 * realSecondsPerGameHour() + 1, function()
		if target.Parent == Players then
			self._permission:Publish(target)
		end
	end)
	return true, "Suspended."
end

function DisciplineService:RequestSenate(manager: Player, target: Player?, proposalType: string, reason)
	local text, err = self:_authorize(manager, target, reason)
	if not text or not target then
		return false, err
	end
	self:_record(target, { Type = proposalType .. "Request", By = manager.UserId, Reason = text })
	return self._government:CreateSystemProposal(proposalType, tostring(target.UserId), manager.DisplayName .. ": " .. text)
end

function DisciplineService:Appeal(player: Player)
	local day = self._time:GetDay()
	if self._appealed[player.UserId] == day then
		return false, "You already appealed today."
	end
	if self:ActiveWarnings(player) == 0 and not self._permission:IsSuspended(player) then
		return false, "You have nothing to appeal."
	end
	self._appealed[player.UserId] = day
	return self._government:CreateSystemProposal("Pardon", tostring(player.UserId), player.DisplayName .. " (appeal)")
end

function DisciplineService:GetHistory(viewer: Player, requested: Player?)
	local target: Player = requested or viewer
	if target ~= viewer and not self._permission:CanManage(viewer, target) and not self._permission:IsAdmin(viewer) then
		return nil
	end
	local profile = self._data:Get(target)
	if not profile then
		return nil
	end
	local suspended, untilTime = self._permission:IsSuspended(target)
	return {
		Name = target.DisplayName,
		ActiveWarnings = self:ActiveWarnings(target),
		Warnings = profile.Discipline.Warnings,
		History = profile.Discipline.History,
		Suspended = suspended,
		SuspendedSeconds = suspended and math.max(0, untilTime - os.time()) or 0,
		FinesPaid = profile.Discipline.FinesPaid,
	}
end

local function targetPlayer(value): Player?
	local userId = Check.userId(value)
	return userId and Players:GetPlayerByUserId(userId) or nil
end

function DisciplineService:_registerRemotes()
	Net.Action("Discipline", "Warn", { rate = 0.3, burst = 2 }, function(player, payload)
		return self:Warn(player, targetPlayer(payload.target), payload.reason)
	end)
	Net.Action("Discipline", "Fine", { rate = 0.3, burst = 2 }, function(player, payload)
		return self:Fine(player, targetPlayer(payload.target), Check.integer(payload.amount, 1, 100000), payload.reason)
	end)
	Net.Action("Discipline", "Suspend", { rate = 0.3, burst = 2 }, function(player, payload)
		return self:Suspend(player, targetPlayer(payload.target), Check.integer(payload.minutes, 1, 1000), payload.reason)
	end)
	Net.Action("Discipline", "RequestDemotion", { rate = 0.2, burst = 1 }, function(player, payload)
		return self:RequestSenate(player, targetPlayer(payload.target), "Demote", payload.reason)
	end)
	Net.Action("Discipline", "RequestRemoval", { rate = 0.2, burst = 1 }, function(player, payload)
		return self:RequestSenate(player, targetPlayer(payload.target), "Remove", payload.reason)
	end)
	Net.Action("Discipline", "Appeal", { rate = 0.1, burst = 1 }, function(player)
		return self:Appeal(player)
	end)
	Net.Query("Discipline", { rate = 1, burst = 3 }, function(player, args)
		return self:GetHistory(player, targetPlayer(args.target))
	end)
end

return DisciplineService
