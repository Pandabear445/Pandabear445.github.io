--[[
	Meetings window: schedule (time, required ranks, location, purpose),
	live attendance, personal attendance record, and calling a meeting.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)
local Notifications = require(script.Parent.Parent.Notifications)

local Meetings = {
	Title = "Meetings",
	Short = "Meetings",
	Icon = "🔔",
	Key = Enum.KeyCode.M,
	Size = UDim2.fromOffset(580, 500),
	RefreshSeconds = 5,
}

function Meetings.Build(window)
	local body = window.Body
	Kit.list(body, 6)
	window.Record = Kit.Text({ TextSize = 14, LayoutOrder = 1, Parent = body })
	window.List = Kit.Scroll({ Size = UDim2.new(1, 0, 1, -110), LayoutOrder = 2, Parent = body })

	local row = Kit.Row({ Height = 34, LayoutOrder = 3, Parent = body })
	local ranks = {}
	for _, rank in ipairs(RankConfig.Sorted()) do
		table.insert(ranks, rank.Id)
	end
	local summon = Kit.Cycle({ Options = ranks, Value = ranks[3] or ranks[1], Prefix = "Summon: ", Size = UDim2.fromOffset(200, 30), Parent = row })
	local purpose = Kit.Input({ Placeholder = "Purpose", Size = UDim2.fromOffset(180, 30), Parent = row })
	Kit.Button({
		Text = "Call meeting",
		Size = UDim2.fromOffset(130, 30),
		TextSize = 14,
		Parent = row,
		OnClick = function()
			local ok, message = ClientNet.Action("Meeting", "Call", { ranks = { summon.Get() }, purpose = purpose.Text })
			Notifications.Result(ok, message)
		end,
	})
end

function Meetings.Refresh(window)
	local data = ClientNet.Query("Meetings")
	if type(data) ~= "table" then
		return
	end
	local record = data.Attendance
	window.Record.Text = record
			and string.format("Your attendance: %d attended · %d missed · %d excused", record.Attended, record.Missed, record.Excused)
		or ""
	Kit.clear(window.List)
	for index, meeting in ipairs(data.Meetings or {}) do
		local card = Kit.Panel({
			Style = meeting.Active and "Stone" or "Parchment",
			Size = UDim2.new(1, 0, 0, 0),
			AutomaticSize = Enum.AutomaticSize.Y,
			LayoutOrder = index,
			Parent = window.List,
			Padding = 6,
		})
		Kit.list(card, 2)
		local light = meeting.Active and "Light" or nil
		local when = meeting.Active and "IN SESSION" or (meeting.Tomorrow and ("Tomorrow " .. meeting.Time) or (meeting.Time .. (meeting.MinutesUntil and string.format(" (in %d min)", meeting.MinutesUntil) or "")))
		Kit.Text({ Text = meeting.Name .. " - " .. when, Style = light or "Heading", TextSize = 17, Parent = card, Font = Kit.Fonts.Heading })
		Kit.Text({
			Text = string.format("Required: %s\nOptional: %s\nLocation: %s\n%s", meeting.Required, meeting.Optional ~= "" and meeting.Optional or "-", meeting.Location, meeting.Purpose or ""),
			Style = light,
			TextSize = 13,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.new(1, 0, 0, 0),
			LayoutOrder = 1,
			Parent = card,
		})
		local you = meeting.YouRequired and "You are REQUIRED to attend." or (meeting.YouInvited and "You may attend." or "")
		if meeting.Active and meeting.Present then
			you ..= string.format(" Presence: %d%%", meeting.Present)
		end
		Kit.Text({ Text = you, Style = light, TextSize = 13, LayoutOrder = 2, Parent = card })
	end
end

return Meetings
