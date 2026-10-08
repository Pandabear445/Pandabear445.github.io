--[[
	MeetingService
	Scheduled and called meetings on the kingdom clock.

	  Announcements  30 / 10 / 1 in-game minutes before, then "has begun".
	  Teleport       required ranks are moved to KingdomMeetingSpawn markers
	                 (never dead players; protected/combat players only if
	                 configured). Everyone else may walk there.
	  Attendance     presence inside the KingdomMeetingRoom is sampled; a
	                 player must be present for RequiredFraction of the
	                 meeting for credit + RewardXP (Leadership).
	  Absences       a required player who was online for the whole meeting
	                 but never attended is marked missed; repeated misses
	                 produce warnings and lower management reputation.
	                 Joining late or disconnecting is always excused.
]]

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Format = require(ReplicatedStorage.Kingdom.Shared.Format)
local MeetingConfig = require(ReplicatedStorage.Kingdom.Config.MeetingConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local MeetingService = {
	Name = "MeetingService",
	Dependencies = {
		"TimeService",
		"RankService",
		"PermissionService",
		"CharacterService",
		"XPService",
		"NotificationService",
		"AuditService",
		"DataService",
		"ActivityService",
		"StateService",
		"DisciplineService",
	},
}

local ROOM_TAG = "KingdomMeetingRoom"
local SPAWN_TAG = "KingdomMeetingSpawn"

function MeetingService:Init()
	self._time = self:Use("TimeService")
	self._rank = self:Use("RankService")
	self._permission = self:Use("PermissionService")
	self._character = self:Use("CharacterService")
	self._xp = self:Use("XPService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")
	self._data = self:Use("DataService")
	self._activity = self:Use("ActivityService")
	self._state = self:Use("StateService")
	self._discipline = self:Use("DisciplineService")

	self.MeetingStarted = Signal.new("MeetingStarted")
	self.MeetingEnded = Signal.new("MeetingEnded")
	self.Attended = Signal.new("MeetingAttended") -- (player, meetingId)

	self._active = {} -- [runId] = run
	self._called = {} -- extra one-off meetings { def, startMinute }
	self._lastCall = {}
	self._runCounter = 0

	self._time.MinuteChanged:Connect(function(_, hour)
		self:_minute(hour)
	end)
	Players.PlayerRemoving:Connect(function(player)
		for _, run in pairs(self._active) do
			run.disconnected[player.UserId] = true
		end
	end)
	self:_registerRemotes()
end

function MeetingService:Start()
	self.Registry:Every(self.Name, "attendance", MeetingConfig.Attendance.CheckEveryRealSeconds, function()
		self:_sampleAttendance()
	end)
	self:_publish()
end

-- Who must / may attend ----------------------------------------------------------------

local function rankMatches(list: { string }?, rankId: string): boolean
	if not list then
		return false
	end
	return table.find(list, "*") ~= nil or table.find(list, rankId) ~= nil
end

function MeetingService:IsRequired(player: Player, def): boolean
	return rankMatches(def.RequiredRanks, self._rank:GetRankId(player))
end

function MeetingService:IsInvited(player: Player, def): boolean
	local rankId = self._rank:GetRankId(player)
	return rankMatches(def.RequiredRanks, rankId) or rankMatches(def.OptionalRanks, rankId)
end

-- Locations ----------------------------------------------------------------------------

function MeetingService:_findRoom(def): Instance?
	local fallback
	for _, room in ipairs(CollectionService:GetTagged(ROOM_TAG)) do
		local id = room:GetAttribute("MeetingID")
		if id == def.MeetingLocation or id == def.MeetingID then
			return room
		elseif id == "*" then
			fallback = room
		end
	end
	return fallback
end

function MeetingService:_findSpawns(def, room: Instance?): { Instance }
	local spawns = {}
	for _, marker in ipairs(CollectionService:GetTagged(SPAWN_TAG)) do
		local id = marker:GetAttribute("MeetingID")
		if id == def.MeetingLocation or id == def.MeetingID or (room and marker:IsDescendantOf(room)) then
			table.insert(spawns, marker)
		end
	end
	if #spawns == 0 and room then
		table.insert(spawns, room)
	end
	return spawns
end

-- Schedule -------------------------------------------------------------------------------

function MeetingService:_scheduled()
	local list = {}
	for _, def in ipairs(MeetingConfig.Meetings) do
		table.insert(list, def)
	end
	return list
end

function MeetingService:_minute(hour: number)
	local nowMinute = math.floor(self._time:GetAbsoluteMinutes() + 0.5)
	for _, def in ipairs(self:_scheduled()) do
		local minutesUntil = math.floor((def.StartTime - hour) * 60 + 0.5)
		self:_maybeAnnounce(def, minutesUntil)
		if minutesUntil == 0 then
			self:StartMeeting(def)
		end
	end
	for index = #self._called, 1, -1 do
		local entry = self._called[index]
		local minutesUntil = entry.startMinute - nowMinute
		self:_maybeAnnounce(entry.def, minutesUntil)
		if minutesUntil <= 0 then
			table.remove(self._called, index)
			self:StartMeeting(entry.def)
		end
	end
	for runId, run in pairs(self._active) do
		if nowMinute >= run.endMinute then
			self:EndMeeting(runId)
		end
	end
	self:_publish()
end

function MeetingService:_maybeAnnounce(def, minutesUntil: number)
	if not table.find(MeetingConfig.AnnouncementMinutes, minutesUntil) then
		return
	end
	local text
	if minutesUntil == 1 then
		text = string.format("%s begins in 1 minute.", def.Name)
	else
		text = string.format("%s in %d minutes.", def.Name, minutesUntil)
	end
	self._notify:NotifyWhere(function(player)
		return self:IsInvited(player, def)
	end, "Meeting", "Meeting soon", text, { Chat = true, Sound = minutesUntil == 1 and "Bell" or nil })
end

-- Running meetings --------------------------------------------------------------------------

function MeetingService:StartMeeting(def)
	for _, run in pairs(self._active) do
		if run.def.MeetingID == def.MeetingID then
			return nil -- already running
		end
	end
	self._runCounter += 1
	local runId = self._runCounter
	local room = self:_findRoom(def)
	local nowMinute = math.floor(self._time:GetAbsoluteMinutes() + 0.5)
	local run = {
		id = runId,
		def = def,
		room = room,
		startMinute = nowMinute,
		endMinute = nowMinute + def.Duration,
		durationSeconds = self._time:GameMinutesToSeconds(def.Duration),
		presence = {},
		requiredAtStart = {},
		disconnected = {},
	}
	self._active[runId] = run
	for _, player in ipairs(Players:GetPlayers()) do
		if self:IsRequired(player, def) then
			run.requiredAtStart[player.UserId] = true
		end
	end
	self._audit:Log("Meeting", "Started", { meeting = def.MeetingID, room = room and room.Name })
	self._notify:Announce("Meeting", def.Name, def.Name .. " has begun.", { Sound = "Bell", Banner = true })
	if not room then
		self.Log:Warn("No KingdomMeetingRoom for %s; attendance cannot be tracked.", def.MeetingID)
	end
	if def.TeleportPlayers and room then
		self:_teleportRequired(run)
	end
	self.MeetingStarted:Fire(def)
	self:_publish()
	return runId
end

function MeetingService:_teleportRequired(run)
	local spawns = self:_findSpawns(run.def, run.room)
	if #spawns == 0 then
		return
	end
	local index = 0
	for _, player in ipairs(Players:GetPlayers()) do
		if run.requiredAtStart[player.UserId] and ZoneUtil.isAlive(player) then
			local protected = self._character:IsProtected(player)
			if not protected or MeetingConfig.Teleport.TeleportProtectedPlayers then
				index += 1
				local marker = spawns[(index - 1) % #spawns + 1]
				local position = ZoneUtil.getPosition(marker)
				if position then
					local ring = math.floor((index - 1) / #spawns)
					local angle = (index * 2.4)
					local offset = Vector3.new(math.cos(angle), 0, math.sin(angle)) * (ring * 3)
					self._character:Teleport(player, CFrame.new(position + offset + Vector3.new(0, 3, 0)), "Meeting:" .. run.def.MeetingID)
				end
			else
				self._notify:Notify(player, "Meeting", run.def.Name, "You are in danger, so you were not summoned. Come when you are safe.")
			end
		end
	end
end

function MeetingService:_sampleAttendance()
	local interval = MeetingConfig.Attendance.CheckEveryRealSeconds
	for _, run in pairs(self._active) do
		if run.room then
			for _, player in ipairs(Players:GetPlayers()) do
				if self:IsInvited(player, run.def) and ZoneUtil.playerInside(player, run.room, MeetingConfig.Attendance.ZonePadding) then
					run.presence[player.UserId] = (run.presence[player.UserId] or 0) + interval
				end
			end
		end
	end
end

function MeetingService:EndMeeting(runId: number)
	local run = self._active[runId]
	if not run then
		return
	end
	self._active[runId] = nil
	local def = run.def
	local attendance = MeetingConfig.Attendance
	local needed = run.durationSeconds * attendance.RequiredFraction
	local attendedCount, missedCount = 0, 0

	for _, player in ipairs(Players:GetPlayers()) do
		local profile = self._data:Get(player)
		if profile then
			local userId = player.UserId
			local attended = run.room ~= nil and (run.presence[userId] or 0) >= needed
			if attended then
				attendedCount += 1
				profile.Attendance.Attended += 1
				profile.Attendance.ConsecutiveMissed = 0
				profile.Lifetime.MeetingsAttended += 1
				if run.requiredAtStart[userId] then
					profile.Reputation.Management = math.min(100, profile.Reputation.Management + attendance.ManagementReputationPerAttend)
				end
				local xp = self._xp:Award(player, "Leadership", def.RewardXP or 0, { source = "Meeting:" .. def.MeetingID, ignoreAFK = true })
				self._notify:Notify(player, "Meeting", "Attendance recorded", string.format("%s: +%d XP", def.Name, xp))
				self.Attended:Fire(player, def.MeetingID)
			elseif run.requiredAtStart[userId] and not run.disconnected[userId] and run.room then
				-- Online for the whole meeting and required: a real absence.
				missedCount += 1
				profile.Attendance.Missed += 1
				profile.Attendance.ConsecutiveMissed += 1
				profile.Reputation.Management = math.max(0, profile.Reputation.Management - attendance.ManagementReputationPerMiss)
				local streak = profile.Attendance.ConsecutiveMissed
				if streak >= attendance.DisciplineAfterConsecutiveMisses then
					self._discipline:SystemWarn(player, string.format("Missed %d required meetings in a row.", streak))
				elseif streak >= attendance.WarningAfterConsecutiveMisses then
					self._notify:Notify(player, "Warning", "Missed meeting", string.format("You missed %s. Repeated absences lead to discipline.", def.Name))
				else
					self._notify:Notify(player, "Meeting", "Missed meeting", "You did not attend " .. def.Name .. ".")
				end
			elseif self:IsRequired(player, def) then
				profile.Attendance.Excused += 1
			end
		end
	end
	self._audit:Log("Meeting", "Ended", { meeting = def.MeetingID, attended = attendedCount, missed = missedCount })
	self._notify:NotifyWhere(function(player)
		return self:IsInvited(player, def)
	end, "Meeting", def.Name, "The meeting has ended.")
	self.MeetingEnded:Fire(def)
	self:_publish()
end

-- Called meetings -----------------------------------------------------------------------------

function MeetingService:CallMeeting(caller: Player, rankIds, purpose: string?, location: string?)
	local rank = self._rank:GetRankDef(caller)
	if not (rank.Meeting and rank.Meeting.CanCall) then
		return false, "Your rank cannot call meetings."
	end
	local config = MeetingConfig.CalledMeetings
	local nowMinute = self._time:GetAbsoluteMinutes()
	local last = self._lastCall[caller.UserId]
	if last and nowMinute - last < config.CooldownGameMinutes then
		return false, "You called a meeting recently."
	end
	local required = {}
	for _, rankId in ipairs(type(rankIds) == "table" and rankIds or {}) do
		local def = RankConfig.Get(rankId)
		if def and def.Order <= rank.Meeting.MaxSummonOrder and def.Order < rank.Order then
			table.insert(required, def.Id)
		end
		if #required >= 10 then
			break
		end
	end
	if #required == 0 then
		return false, "Choose ranks you may summon."
	end
	table.insert(required, rank.Id)
	self._lastCall[caller.UserId] = nowMinute
	local def = {
		MeetingID = "Called_" .. caller.UserId .. "_" .. math.floor(nowMinute),
		Name = caller.DisplayName .. "'s Meeting",
		Duration = config.Duration,
		RequiredRanks = required,
		OptionalRanks = {},
		MeetingLocation = location or config.DefaultLocation,
		TeleportPlayers = true,
		RewardXP = config.RewardXP,
		Purpose = Check.string(purpose, 120) or "Orders from your superior.",
	}
	table.insert(self._called, { def = def, startMinute = math.floor(nowMinute + config.LeadMinutes + 0.5) })
	self._audit:Log("Meeting", "Called", { by = caller.UserId, ranks = table.concat(required, ",") })
	self:_maybeAnnounce(def, config.LeadMinutes)
	self:_publish()
	return true, string.format("Meeting called in %d minutes.", config.LeadMinutes)
end

-- Views ------------------------------------------------------------------------------------------

function MeetingService:_nextOccurrences()
	local clock = self._time:GetClock()
	local list = {}
	for _, def in ipairs(self:_scheduled()) do
		local minutesUntil = (def.StartTime - clock.Hour) * 60
		local today = minutesUntil > -def.Duration
		table.insert(list, {
			def = def,
			minutesUntil = today and minutesUntil or nil,
			time = Format.clock(def.StartTime),
			tomorrow = not today,
		})
	end
	local nowMinute = self._time:GetAbsoluteMinutes()
	for _, entry in ipairs(self._called) do
		table.insert(list, {
			def = entry.def,
			minutesUntil = entry.startMinute - nowMinute,
			time = Format.clock(clock.Hour + (entry.startMinute - nowMinute) / 60),
		})
	end
	table.sort(list, function(a, b)
		return (a.minutesUntil or 1e9) < (b.minutesUntil or 1e9)
	end)
	return list
end

local function rankNames(list: { string }?): string
	local names = {}
	for _, id in ipairs(list or {}) do
		if id == "*" then
			table.insert(names, "Everyone")
		else
			local def = RankConfig.Get(id)
			table.insert(names, def and def.DisplayName or id)
		end
	end
	return table.concat(names, ", ")
end

function MeetingService:GetSchedule(player: Player)
	local list = {}
	local activeIds = {}
	for _, run in pairs(self._active) do
		activeIds[run.def.MeetingID] = run
	end
	for _, entry in ipairs(self:_nextOccurrences()) do
		local def = entry.def
		local run = activeIds[def.MeetingID]
		local room = self:_findRoom(def)
		table.insert(list, {
			Id = def.MeetingID,
			Name = def.Name,
			Time = entry.time,
			Tomorrow = entry.tomorrow,
			MinutesUntil = entry.minutesUntil and math.floor(entry.minutesUntil) or nil,
			Duration = def.Duration,
			Required = rankNames(def.RequiredRanks),
			Optional = rankNames(def.OptionalRanks),
			Location = room and room.Name or (def.MeetingLocation or "?"),
			Purpose = def.Purpose,
			YouRequired = self:IsRequired(player, def),
			YouInvited = self:IsInvited(player, def),
			Active = run ~= nil,
			Present = run and math.floor((run.presence[player.UserId] or 0) / math.max(run.durationSeconds, 1) * 100) or nil,
		})
	end
	local profile = self._data:Get(player)
	return {
		Meetings = list,
		Attendance = profile and profile.Attendance or nil,
	}
end

function MeetingService:_publish()
	for _, player in ipairs(Players:GetPlayers()) do
		local nextMeeting
		for _, entry in ipairs(self:_nextOccurrences()) do
			if self:IsInvited(player, entry.def) and entry.minutesUntil and entry.minutesUntil > -entry.def.Duration then
				nextMeeting = {
					Name = entry.def.Name,
					Time = entry.time,
					MinutesUntil = math.floor(entry.minutesUntil),
					Required = self:IsRequired(player, entry.def),
				}
				break
			end
		end
		self._state:Set(player, "NextMeeting", nextMeeting)
	end
end

function MeetingService:_registerRemotes()
	Net.Query("Meetings", { rate = 1, burst = 3 }, function(player)
		return self:GetSchedule(player)
	end)
	Net.Action("Meeting", "Call", { rate = 0.1, burst = 1 }, function(player, payload)
		return self:CallMeeting(player, payload.ranks, payload.purpose, Check.string(payload.location, 60))
	end)
end

-- Admin / testing.
function MeetingService:ForceStart(meetingId: string)
	for _, def in ipairs(MeetingConfig.Meetings) do
		if def.MeetingID == meetingId then
			return self:StartMeeting(def)
		end
	end
	return nil
end

function MeetingService:ForceEndAll()
	for runId in pairs(self._active) do
		self:EndMeeting(runId)
	end
end

return MeetingService
