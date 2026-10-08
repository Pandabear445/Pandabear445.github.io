--[[
	Career window: this life, lifetime legacy (kept through every death),
	achievements and the history of past lives.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Format = require(ReplicatedStorage.Kingdom.Shared.Format)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)

local Career = {
	Title = "Career & Legacy",
	Short = "Career",
	Icon = "📖",
	Key = Enum.KeyCode.C,
	Size = UDim2.fromOffset(620, 540),
}

function Career.Build(window)
	window.Scroll = Kit.Scroll({ Parent = window.Body, Spacing = 4 })
end

function Career.Refresh(window)
	local data = ClientNet.Query("Career")
	if type(data) ~= "table" then
		return
	end
	local scroll = window.Scroll
	Kit.clear(scroll)
	local order = 0
	local function add(text: string, style: string?, size: number?)
		order += 1
		Kit.Text({ Text = text, Style = style, TextSize = size, LayoutOrder = order, Parent = scroll, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) })
	end
	local life, lifetime = data.Life, data.Lifetime
	add(string.format("LIFE #%d", life.Number), "Heading", 22)
	add(string.format("Highest rank this life: %s · XP earned: %s · jobs: %s · alive for %s", life.HighestRank, Format.number(life.XPEarned), Format.number(life.JobsCompleted), Format.duration(os.time() - (life.StartedAt or os.time()))), nil, 14)
	add("Lifetime legacy", "Heading", 20)
	add(
		string.format(
			"Highest rank ever: %s\nHighest XP ever: %s\nLifetime XP earned: %s\nJobs completed: %s\nPromotions: %d · Deaths: %d\nMoney earned: %s · Contributions: %s\nMeetings attended: %d · Projects: %d",
			lifetime.HighestRank,
			Format.number(lifetime.HighestXP),
			Format.number(lifetime.XPEarned),
			Format.number(lifetime.JobsCompleted),
			lifetime.Promotions,
			lifetime.Deaths,
			Format.number(lifetime.MoneyEarned),
			Format.number(lifetime.Contributions),
			lifetime.MeetingsAttended,
			lifetime.ProjectsCompleted
		),
		nil,
		14
	)
	local management = data.Management
	if management then
		add(string.format("Management: %d orders completed, %d failed · %d inspections · %d targets met · %d crises prevented", management.OrdersCompleted, management.OrdersFailed, management.Inspections, management.DepartmentTargetsMet, management.CrisesPrevented), nil, 13)
	end
	add("Achievements", "Heading", 20)
	for _, achievement in ipairs(data.Achievements or {}) do
		add(string.format("%s %s - %s", achievement.EarnedAt and "★" or "☆", achievement.Name, achievement.Description), nil, 14)
	end
	add("Past lives", "Heading", 20)
	if #(data.History or {}) == 0 then
		add("You have never fallen.", nil, 14)
	end
	for index = #(data.History or {}), 1, -1 do
		local past = data.History[index]
		add(string.format("Life #%d - reached %s, peak %s XP, %s jobs, lived %s, fell to: %s", past.Life, past.HighestRank, Format.number(past.PeakXP), Format.number(past.JobsCompleted or 0), Format.duration(past.Duration), tostring(past.Cause)), nil, 13)
	end
end

return Career
