--[[
	HUD - the always-visible side information panel.
	  time, next meeting, rank (+ tenure), XP, next rank and queue position,
	  current job and objective, coins, hunger, kingdom food/stability/stage,
	  and warnings when a system is degraded or progress is paused.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Format = require(ReplicatedStorage.Kingdom.Shared.Format)
local UIConfig = require(ReplicatedStorage.Kingdom.Config.UIConfig)
local ClientState = require(script.Parent.Parent.Controllers.ClientState)
local Clock = require(script.Parent.Parent.Controllers.Clock)
local App = require(script.Parent.App)
local Kit = require(script.Parent.Kit)

local HUD = {}

local player = Players.LocalPlayer
local root = ReplicatedStorage:WaitForChild("Kingdom")
local refs = {}

local FRIENDLY_SYSTEMS = {
	FoodService = "Food systems",
	EconomyService = "Economy",
	MeetingService = "Meetings",
	WeatherService = "Weather",
	JobService = "Jobs",
	RankService = "Hierarchy",
	MarketService = "Market",
	DataService = "Saving",
	EventService = "Events",
}

local function line(parent: Instance, name: string, order: number, props)
	props = props or {}
	local label = Kit.Text({
		Name = name,
		Text = "",
		TextSize = props.TextSize or 14,
		Style = props.Style,
		Color = props.Color,
		LayoutOrder = order,
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Rich = true,
		Parent = parent,
	})
	refs[name] = label
	return label
end

local function divider(parent: Instance, order: number)
	Kit.new("Frame", {
		BackgroundColor3 = Kit.Colors.WoodLight,
		BackgroundTransparency = 0.4,
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 1),
		LayoutOrder = order,
		Parent = parent,
	})
end

function HUD.Init()
	local panel = Kit.Panel({
		Name = "SidePanel",
		Style = "Parchment",
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -12, 0.55, 0),
		Size = UDim2.fromOffset(UIConfig.SidePanelWidth, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Padding = 10,
		Parent = App.Gui,
	})
	Kit.list(panel, 3)

	line(panel, "Clock", 1, { Style = "Title", TextSize = 30 })
	line(panel, "Day", 2, { TextSize = 13 })
	line(panel, "Meeting", 3)
	divider(panel, 4)
	line(panel, "Rank", 5, { Style = "Heading", TextSize = 20 })
	line(panel, "Tenure", 6, { TextSize = 12 })
	line(panel, "XP", 7)
	line(panel, "NextRank", 8)
	line(panel, "Position", 9)
	divider(panel, 10)
	line(panel, "Job", 11)
	line(panel, "Objective", 12, { TextSize = 13 })
	line(panel, "Coins", 13)
	refs.HungerBar = Kit.Bar({ Name = "Hunger", LayoutOrder = 14, Parent = panel })
	divider(panel, 15)
	line(panel, "Stage", 16, { Style = "Heading", TextSize = 16 })
	refs.FoodBar = Kit.Bar({ Name = "Food", LayoutOrder = 17, Parent = panel })
	refs.StabilityBar = Kit.Bar({ Name = "Stability", LayoutOrder = 18, Parent = panel })
	line(panel, "Alerts", 19, { TextSize = 12, Color = Kit.Colors.Bad })

	HUD.Panel = panel
	ClientState.Changed:Connect(function()
		HUD.Update()
	end)
	HUD.Update()
end

local function rankColor(): string
	local color = player:GetAttribute("KingdomRankColor")
	if typeof(color) == "Color3" then
		return "#" .. color:ToHex()
	end
	return "#2e2016"
end

function HUD.TickClock()
	local clock = Clock.Get()
	if not clock then
		refs.Clock.Text = "--:--"
		return
	end
	refs.Clock.Text = Format.clock(clock.Hour)
	local weather = ClientState.Global.Weather
	local season = root:GetAttribute("Season")
	refs.Day.Text = string.format(
		"%s · Day %d%s%s",
		Clock.Period(clock.Hour),
		clock.Day,
		(type(season) == "string" and season ~= "") and (" · " .. season) or "",
		weather and (" · " .. weather.Name) or ""
	)
	-- Tenure ticks too.
	local queue = ClientState.Player.Queue
	if queue and queue.RankSince then
		refs.Tenure.Text = "Rank held for " .. Format.duration(os.time() - queue.RankSince)
	end
end

function HUD.Update()
	local state = ClientState.Player
	local global = ClientState.Global

	local meeting = state.NextMeeting
	if meeting then
		refs.Meeting.Text = string.format(
			"Next meeting: <b>%s</b> %s%s",
			meeting.Time,
			meeting.Name,
			meeting.Required and " (required)" or ""
		)
	else
		refs.Meeting.Text = "No meetings for you today"
	end

	local rank = state.Rank
	refs.Rank.Text = string.format('<font color="%s">%s</font>', rankColor(), rank and rank.Name or "…")

	local xp = state.XP
	refs.XP.Text = xp and string.format("XP: <b>%s</b>  · Life #%d", Format.number(xp.Total), xp.Life or 1) or "XP: …"

	local queue = state.Queue
	if queue then
		if queue.NextRankName then
			refs.NextRank.Text = string.format(
				"Next rank: <b>%s</b> (%d/%s)",
				queue.NextRankName,
				queue.NextRankCount or 0,
				queue.NextRankMax and tostring(queue.NextRankMax) or "∞"
			)
			local text = string.format("Position: <b>#%d</b> of %d in promotion queue", queue.Position or 0, queue.QueueSize or 0)
			if queue.Reason and not queue.Eligible then
				text ..= "\n<i>" .. queue.Reason .. "</i>"
			end
			refs.Position.Text = text
		else
			refs.NextRank.Text = "You hold the highest rank"
			refs.Position.Text = ""
		end
	end

	local job = state.Job
	if job and job.JobName then
		refs.Job.Text = string.format("Job: <b>%s</b> · %s%s", job.JobName, job.Tier or "", (job.Streak or 0) > 1 and (" · streak " .. job.Streak) or "")
	else
		refs.Job.Text = job and job.OnDuty and "Job: <b>Guard duty</b>" or "Job: idle - visit a workplace"
	end
	local objective = state.Objective
	refs.Objective.Text = objective
			and string.format("Order: %s (%d/%d, %dm left)", objective.Title, objective.Progress, objective.Target, objective.MinutesLeft)
		or ""
	refs.Objective.Visible = objective ~= nil

	refs.Coins.Text = string.format("Coins: <b>%s</b>%s", Format.number(state.Coins or 0), state.Department and ("  · " .. state.Department) or "")

	local hunger = state.Hunger
	if hunger then
		local fraction = hunger.Value / math.max(hunger.Max, 1)
		refs.HungerBar:Set(fraction, string.format("Hunger %d%%%s", math.floor(fraction * 100), hunger.Sick and " · SICK" or ""), Kit.percentColor(fraction))
	end

	local kingdom = global.Kingdom
	if kingdom then
		local color = typeof(kingdom.StageColor) == "Color3" and kingdom.StageColor or Kit.Colors.Ink
		refs.Stage.Text = string.format('Kingdom: <font color="#%s">%s</font> · Morale %d', color:ToHex(), kingdom.Stage, math.floor(kingdom.Morale or 0))
		local food = kingdom.Needs and kingdom.Needs.Food and kingdom.Needs.Food.Value or 0
		refs.FoodBar:Set(food, "Food " .. Format.percent(food), Kit.percentColor(food))
		refs.StabilityBar:Set(kingdom.Stability or 0, "Stability " .. Format.percent(kingdom.Stability), Kit.percentColor(kingdom.Stability or 0))
	end

	-- Alerts: safe mode, saves disabled, degraded systems.
	local alerts = {}
	if player:GetAttribute("KingdomSafeMode") then
		table.insert(alerts, "Records unavailable - progress paused")
	end
	if root:GetAttribute("SavesDisabled") then
		table.insert(alerts, "Studio: saving disabled (no API access)")
	end
	for service, label in pairs(FRIENDLY_SYSTEMS) do
		local status = root:GetAttribute("Status_" .. service)
		if status == "Degraded" or status == "Disabled" then
			table.insert(alerts, label .. " temporarily unavailable.")
		end
	end
	refs.Alerts.Text = table.concat(alerts, "\n")
	refs.Alerts.Visible = #alerts > 0
end

return HUD
