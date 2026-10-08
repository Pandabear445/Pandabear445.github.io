--[[
	AchievementConfig
	Persistent achievements. They survive death resets.
	BadgeId (optional) also awards a Roblox badge.

	Condition types (checked by AchievementService)
	  ReachRank     { Rank }            reach (or pass) a rank this life
	  Promotions    { Count }           lifetime promotions
	  ManagerRank   {}                  hold any rank with ManageDepth > 0
	  JobsCompleted { Count }           lifetime jobs
	  Meetings      { Count }           meetings attended
	  Projects      { Count }           projects / work orders completed as manager
	  Deaths        { Count }
	  LifetimeXP    { Amount }
	  Event         { Id }              awarded by a kingdom event / system
]]

local AchievementConfig = {}

AchievementConfig.Achievements = {
	FirstPromotion = { DisplayName = "Moving Up", Description = "Earn your first promotion.", Condition = { Type = "Promotions", Count = 1 } },
	FirstManagement = { DisplayName = "In Charge", Description = "Hold your first management rank.", Condition = { Type = "ManagerRank" } },
	FirstProject = { DisplayName = "Foreman", Description = "Complete your first work order as a manager.", Condition = { Type = "Projects", Count = 1 } },
	FirstMeeting = { DisplayName = "Present!", Description = "Attend your first meeting.", Condition = { Type = "Meetings", Count = 1 } },
	Jobs100 = { DisplayName = "Hard Worker", Description = "Complete 100 jobs.", Condition = { Type = "JobsCompleted", Count = 100 } },
	Jobs1000 = { DisplayName = "Pillar of the Realm", Description = "Complete 1,000 jobs.", Condition = { Type = "JobsCompleted", Count = 1000 } },
	PreventFoodCrisis = { DisplayName = "Granary Saviour", Description = "Help end a food shortage.", Condition = { Type = "Event", Id = "PreventFoodCrisis" } },
	BecomeKnight = { DisplayName = "Dubbed", Description = "Become a Knight.", Condition = { Type = "ReachRank", Rank = "Knight" } },
	BecomeLord = { DisplayName = "Landed", Description = "Become a Lord.", Condition = { Type = "ReachRank", Rank = "Lord" } },
	BecomeKing = { DisplayName = "Long Live the King", Description = "Become King.", Condition = { Type = "ReachRank", Rank = "King" } },
	FirstFall = { DisplayName = "Memento Mori", Description = "Die and begin a new life.", Condition = { Type = "Deaths", Count = 1 } },
	Veteran = { DisplayName = "Veteran", Description = "Earn 100,000 lifetime XP.", Condition = { Type = "LifetimeXP", Amount = 100000 } },
}

for id, def in pairs(AchievementConfig.Achievements) do
	def.Id = id
end

return AchievementConfig
