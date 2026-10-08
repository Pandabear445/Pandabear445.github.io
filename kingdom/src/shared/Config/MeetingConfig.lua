--[[
	MeetingConfig
	Scheduled kingdom meetings. Times are in-game hours (8.5 = 8:30 AM).

	Meeting locations are map markers:
	  KingdomMeetingRoom  (Part/Model, attribute MeetingID = "<MeetingID>")
	  KingdomMeetingSpawn (Parts inside or tagged with the same MeetingID)
	A room with MeetingID = "*" is used for any meeting without its own room.
]]

local MeetingConfig = {}

MeetingConfig.Meetings = {
	{
		MeetingID = "RoyalCouncil",
		Name = "Royal Council",
		StartTime = 8,
		Duration = 60, -- in-game minutes (3 real minutes)
		RequiredRanks = { "King", "RoyalCouncil" },
		OptionalRanks = { "Duke" },
		MeetingLocation = "RoyalCouncil",
		TeleportPlayers = true,
		RewardXP = 60,
		Purpose = "Review the kingdom, policies and Senate business.",
	},
	{
		MeetingID = "DepartmentMeeting",
		Name = "Department Meeting",
		StartTime = 12,
		Duration = 45,
		RequiredRanks = { "Lord", "KnightCommander", "Knight", "Sergeant" },
		OptionalRanks = { "Duke", "Guard", "Worker" },
		MeetingLocation = "DepartmentMeeting",
		TeleportPlayers = true,
		RewardXP = 40,
		Purpose = "Department reports, staffing and work orders.",
	},
	{
		MeetingID = "KingdomMeeting",
		Name = "Kingdom Meeting",
		StartTime = 18,
		Duration = 45,
		RequiredRanks = { "King", "RoyalCouncil", "Duke", "Lord" },
		OptionalRanks = { "*" },
		MeetingLocation = "KingdomMeeting",
		TeleportPlayers = true,
		RewardXP = 35,
		Purpose = "Kingdom announcements open to every citizen.",
	},
}

-- In-game minutes before start when announcements are made.
MeetingConfig.AnnouncementMinutes = { 30, 10, 1 }

MeetingConfig.Attendance = {
	CheckEveryRealSeconds = 5,
	RequiredFraction = 0.6, -- of the meeting spent in the room for credit
	ZonePadding = 6,
	-- Missed-meeting consequences (excused absences never count).
	WarningAfterConsecutiveMisses = 2,
	DisciplineAfterConsecutiveMisses = 4,
	ManagementReputationPerMiss = 5,
	ManagementReputationPerAttend = 2,
}

MeetingConfig.Teleport = {
	-- Attribute on the player/character that blocks teleporting (combat etc.)
	ProtectedAttribute = "KingdomProtected",
	TeleportProtectedPlayers = false,
	CombatProtectionSeconds = 10, -- recently damaged players are not pulled away
}

-- Unscheduled meetings called by managers.
MeetingConfig.CalledMeetings = {
	LeadMinutes = 15, -- in-game minutes of notice
	Duration = 30,
	CooldownGameMinutes = 120, -- per caller
	RewardXP = 15,
	DefaultLocation = "DepartmentMeeting",
}

return MeetingConfig
