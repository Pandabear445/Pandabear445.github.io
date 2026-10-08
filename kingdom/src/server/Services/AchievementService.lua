--[[
	AchievementService
	Persistent achievements (they survive death resets). Conditions are
	re-checked whenever a relevant signal fires; optional Roblox badges are
	awarded through BadgeService.
]]

local BadgeService = game:GetService("BadgeService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local AchievementConfig = require(ReplicatedStorage.Kingdom.Config.AchievementConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Net = require(script.Parent.Parent.Core.Net)

local AchievementService = {
	Name = "AchievementService",
	Dependencies = {
		"DataService",
		"NotificationService",
		"RankService",
		"XPService",
		"PromotionService",
		"JobService",
		"ManagementService",
		"MeetingService",
		"EventService",
		"DeathService",
		"AuditService",
		"StateService",
	},
}

function AchievementService:Init()
	self._data = self:Use("DataService")
	self._notify = self:Use("NotificationService")
	self._rank = self:Use("RankService")
	self._xp = self:Use("XPService")
	self._promotion = self:Use("PromotionService")
	self._jobs = self:Use("JobService")
	self._management = self:Use("ManagementService")
	self._meetings = self:Use("MeetingService")
	self._events = self:Use("EventService")
	self._death = self:Use("DeathService")
	self._audit = self:Use("AuditService")
	self._state = self:Use("StateService")

	self.Earned = Signal.new("AchievementEarned") -- (player, id)

	local function check(player)
		if player and player.Parent == Players then
			self:CheckAll(player)
		end
	end
	self._data.Loaded:Connect(check)
	self._rank.PlayerRankChanged:Connect(check)
	self._promotion.Promoted:Connect(check)
	self._jobs.TaskCompleted:Connect(check)
	self._meetings.Attended:Connect(check)
	self._death.PlayerReset:Connect(check)
	self._management.OrderCompleted:Connect(function(order)
		check(Players:GetPlayerByUserId(order.creator))
	end)
	self._events.EventEnded:Connect(function(run, success)
		local rewardAchievement = run.def.Rewards and run.def.Rewards.Achievement
		if success and rewardAchievement then
			for userId in pairs(run.contributions) do
				local player = Players:GetPlayerByUserId(userId)
				if player then
					self:Grant(player, rewardAchievement)
				end
			end
		end
	end)

	Net.Query("Career", { rate = 1, burst = 3 }, function(player)
		return self:GetCareer(player)
	end)
end

function AchievementService:_met(player: Player, profile, condition): boolean
	local kind = condition.Type
	if kind == "ReachRank" then
		local target = RankConfig.Get(condition.Rank)
		return target ~= nil and self._rank:GetOrder(player) >= target.Order
	elseif kind == "Promotions" then
		return profile.Lifetime.Promotions >= condition.Count
	elseif kind == "ManagerRank" then
		return (self._rank:GetRankDef(player).ManageDepth or 0) > 0
	elseif kind == "JobsCompleted" then
		return profile.Lifetime.JobsCompleted >= condition.Count
	elseif kind == "Meetings" then
		return profile.Lifetime.MeetingsAttended >= condition.Count
	elseif kind == "Projects" then
		return profile.ManagementStats.OrdersCompleted + profile.Lifetime.ProjectsCompleted >= condition.Count
	elseif kind == "Deaths" then
		return profile.Lifetime.Deaths >= condition.Count
	elseif kind == "LifetimeXP" then
		return profile.Lifetime.XPEarned >= condition.Amount
	end
	return false -- "Event" achievements are granted explicitly
end

function AchievementService:CheckAll(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return
	end
	for id, def in pairs(AchievementConfig.Achievements) do
		if not profile.Achievements[id] and self:_met(player, profile, def.Condition) then
			self:Grant(player, id)
		end
	end
end

function AchievementService:Grant(player: Player, id: string)
	local def = AchievementConfig.Achievements[id]
	local profile = self._data:Get(player)
	if not def or not profile or profile.Achievements[id] then
		return false
	end
	profile.Achievements[id] = os.time()
	self._audit:Log("System", "Achievement", { userId = player.UserId, id = id })
	self._notify:Notify(player, "Success", "Achievement: " .. def.DisplayName, def.Description, { Sound = "Promotion" })
	if def.BadgeId and def.BadgeId > 0 then
		task.spawn(function()
			pcall(BadgeService.AwardBadge, BadgeService, player.UserId, def.BadgeId)
		end)
	end
	self.Earned:Fire(player, id)
	return true
end

function AchievementService:GetCareer(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return nil
	end
	local achievements = {}
	for id, def in pairs(AchievementConfig.Achievements) do
		table.insert(achievements, {
			Id = id,
			Name = def.DisplayName,
			Description = def.Description,
			EarnedAt = profile.Achievements[id],
		})
	end
	table.sort(achievements, function(a, b)
		return a.Name < b.Name
	end)
	local function rankName(id)
		local def = RankConfig.Get(id)
		return def and def.DisplayName or tostring(id)
	end
	local history = {}
	for _, life in ipairs(profile.CareerHistory) do
		table.insert(history, {
			Life = life.Life,
			HighestRank = rankName(life.HighestRank),
			PeakXP = life.PeakXP,
			JobsCompleted = life.JobsCompleted,
			Cause = life.Cause,
			Duration = (life.EndedAt or 0) - (life.StartedAt or 0),
		})
	end
	return {
		Life = {
			Number = profile.Life.Number,
			HighestRank = rankName(profile.Life.HighestRank),
			XPEarned = profile.Life.XPEarned,
			JobsCompleted = profile.Life.JobsCompleted,
			StartedAt = profile.Life.StartedAt,
		},
		Lifetime = {
			HighestRank = rankName(profile.Lifetime.HighestRank),
			HighestXP = profile.Lifetime.HighestXP,
			XPEarned = profile.Lifetime.XPEarned,
			JobsCompleted = profile.Lifetime.JobsCompleted,
			Deaths = profile.Lifetime.Deaths,
			MoneyEarned = profile.Lifetime.MoneyEarned,
			Contributions = profile.Lifetime.Contributions,
			Promotions = profile.Lifetime.Promotions,
			MeetingsAttended = profile.Lifetime.MeetingsAttended,
			ProjectsCompleted = profile.Lifetime.ProjectsCompleted,
		},
		Management = profile.ManagementStats,
		Attendance = profile.Attendance,
		Achievements = achievements,
		History = history,
	}
end

return AchievementService
