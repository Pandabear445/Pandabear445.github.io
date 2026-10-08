--[[
	Promotion queue window.
	  SERGEANT PROMOTION QUEUE
	  1. PlayerA - 42,120 XP
	  2. PlayerB - 39,500 XP
	  3. YOU     - 35,820 XP
	XP orders the queue; the rank above must have an open slot.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Format = require(ReplicatedStorage.Kingdom.Shared.Format)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)

local Queue = {
	Title = "Promotion Queue",
	Short = "Queue",
	Icon = "⚜",
	Key = Enum.KeyCode.P,
	Size = UDim2.fromOffset(520, 500),
	RefreshSeconds = 4,
}

local viewRank: string? = nil

function Queue.Build(window)
	local body = window.Body
	Kit.list(body, 6)
	local header = Kit.Row({ Height = 34, LayoutOrder = 1, Parent = body })
	local ranks = {}
	for _, rank in ipairs(RankConfig.Sorted()) do
		table.insert(ranks, rank.Id)
	end
	local cycle = Kit.Cycle({
		Options = ranks,
		Value = ranks[1],
		Prefix = "Rank: ",
		Size = UDim2.fromOffset(220, 30),
		Parent = header,
		OnChange = function(value)
			viewRank = value
			Queue.Refresh(window)
		end,
	})
	window.RankCycle = cycle
	Kit.Button({
		Text = "My queue",
		Size = UDim2.fromOffset(110, 30),
		TextSize = 14,
		Parent = header,
		OnClick = function()
			viewRank = nil
			Queue.Refresh(window)
		end,
	})
	window.Heading = Kit.Text({ Style = "Heading", TextSize = 20, LayoutOrder = 2, Parent = body })
	window.Info = Kit.Text({ TextSize = 14, LayoutOrder = 3, Parent = body, Rich = true, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) })
	window.List = Kit.Scroll({ Size = UDim2.new(1, 0, 1, -120), LayoutOrder = 4, Parent = body })
end

function Queue.Refresh(window)
	local data = ClientNet.Query("PromotionQueue", { rank = viewRank })
	if type(data) ~= "table" then
		return
	end
	window.Heading.Text = string.upper(data.NextRankName or data.RankName) .. " PROMOTION QUEUE"
	local info = string.format("Members of <b>%s</b>, ordered by XP.", data.RankName)
	if data.NextRankName then
		info ..= string.format(
			"\nNext rank: <b>%s</b> - %d / %s held%s.",
			data.NextRankName,
			data.NextRankCount or 0,
			data.NextRankMax and tostring(data.NextRankMax) or "∞",
			data.OpenSlots and data.OpenSlots > 0 and string.format(" · <b>%d open</b>", data.OpenSlots) or " · full"
		)
		info ..= "\nWhen a slot opens, #1 here is promoted. XP below can never overtake a rank holder."
	else
		info ..= "\nThis is the highest rank."
	end
	if data.You and not viewRank then
		info ..= string.format("\nYou are <b>#%d</b>%s", data.You.Position or 0, data.You.Reason and (" - " .. data.You.Reason) or "")
	end
	window.Info.Text = info
	Kit.clear(window.List)
	for _, row in ipairs(data.Rows or {}) do
		local frame = Kit.Row({
			Height = 26,
			Background = row.IsYou and Kit.Colors.Gold or (row.Position % 2 == 0 and Kit.Colors.ParchmentDark or nil),
			LayoutOrder = row.Position,
			Parent = window.List,
		})
		Kit.Text({ Text = string.format("%d.", row.Position), Size = UDim2.fromOffset(40, 24), Parent = frame, Font = Kit.Fonts.Heading })
		Kit.Text({
			Text = (row.IsYou and "YOU" or row.Name) .. (row.Online and "" or " (away)"),
			Size = UDim2.fromOffset(250, 24),
			Parent = frame,
		})
		Kit.Text({ Text = Format.number(row.XP) .. " XP", Size = UDim2.fromOffset(140, 24), Align = Enum.TextXAlignment.Right, Parent = frame })
	end
	if #(data.Rows or {}) == 0 then
		Kit.Text({ Text = "Nobody holds this rank right now.", Parent = window.List })
	end
end

return Queue
