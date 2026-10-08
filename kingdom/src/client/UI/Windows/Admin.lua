--[[
	Admin panel. Only shown when the server marks you as an admin, and every
	command is re-checked on the server (non-admins are refused and flagged).
	Includes developer test-mode shortcuts.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)

local Admin = {
	Title = "Administration",
	Short = "Admin",
	Icon = "⚙",
	Key = Enum.KeyCode.F2,
	Size = UDim2.fromOffset(820, 580),
	Visible = function()
		return Players.LocalPlayer:GetAttribute("KingdomAdmin") == true
	end,
}

local QUICK = {
	{ "+100 XP", "sim xp 100" },
	{ "+10k XP", "sim xp 10000" },
	{ "Promote me", "sim promotion" },
	{ "Demote me", "sim demotion" },
	{ "Populate bots", "bot populate" },
	{ "Kill top rank", "bot killtop" },
	{ "Knight vacancy", "sim vacancy Knight" },
	{ "Cascade test", "sim cascade" },
	{ "Food shortage", "sim foodshortage" },
	{ "Crisis", "sim crisis" },
	{ "Meeting", "sim meeting" },
	{ "Restart sim", "sim restart" },
	{ "Leave sim", "sim leave" },
	{ "Die", "sim death" },
	{ "Hierarchy", "hierarchy" },
	{ "Clear bots", "bot clear" },
}

local function run(window, command: string)
	task.spawn(function()
		local ok, message = ClientNet.Action("Admin", "Run", { command = command })
		window.Output.Text = (ok and "✔ " or "✖ ") .. command .. "\n" .. tostring(message or "")
		Admin.Refresh(window)
	end)
end

function Admin.Build(window)
	local body = window.Body
	Kit.list(body, 6)
	local row = Kit.Row({ Height = 32, LayoutOrder = 1, Parent = body })
	local input = Kit.Input({ Placeholder = "Command (try 'help')", Size = UDim2.fromOffset(560, 30), Parent = row })
	Kit.Button({ Text = "Run", Size = UDim2.fromOffset(80, 30), Parent = row, OnClick = function()
		run(window, input.Text)
	end })
	input.FocusLost:Connect(function(enter)
		if enter then
			run(window, input.Text)
		end
	end)

	local quick = Kit.new("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 64), LayoutOrder = 2, Parent = body })
	Kit.new("UIGridLayout", { CellSize = UDim2.fromOffset(120, 28), CellPadding = UDim2.fromOffset(4, 4), Parent = quick })
	for _, entry in ipairs(QUICK) do
		Kit.Button({ Text = entry[1], TextSize = 12, Parent = quick, OnClick = function()
			run(window, entry[2])
		end })
	end
	window.Output = Kit.Text({ Text = "", TextSize = 13, LayoutOrder = 3, Parent = body, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Font = Enum.Font.Code })
	local filters = Kit.Row({ Height = 30, LayoutOrder = 4, Parent = body })
	window.Category = Kit.Cycle({
		Options = { "All", "Rank", "Promotion", "Death", "Government", "Treasury", "Discipline", "AntiCheat", "Admin", "Meeting", "Data", "System", "Market", "Management" },
		Prefix = "Log: ",
		Size = UDim2.fromOffset(200, 28),
		Parent = filters,
		OnChange = function()
			Admin.Refresh(window)
		end,
	})
	window.Search = Kit.Input({ Placeholder = "Search logs", Size = UDim2.fromOffset(200, 28), Parent = filters })
	Kit.Button({ Text = "Refresh", Size = UDim2.fromOffset(90, 28), TextSize = 13, Parent = filters, OnClick = function()
		Admin.Refresh(window)
	end })
	window.Logs = Kit.Scroll({ Size = UDim2.new(1, 0, 1, -230), LayoutOrder = 5, Parent = body, Spacing = 1 })
end

function Admin.Refresh(window)
	local category = window.Category.Get()
	local data = ClientNet.Query("AdminInfo", {
		category = category ~= "All" and category or nil,
		text = window.Search.Text ~= "" and window.Search.Text or nil,
	})
	if type(data) ~= "table" or not data.IsAdmin then
		return
	end
	Kit.clear(window.Logs)
	local suspicion = {}
	for _, entry in ipairs(data.Suspicion or {}) do
		table.insert(suspicion, string.format("%s %d", entry.Name, entry.Score))
	end
	Kit.Text({
		Text = (data.Testing and "TEST MODE ON" or "Test mode off") .. (#suspicion > 0 and (" · Suspicion: " .. table.concat(suspicion, ", ")) or ""),
		TextSize = 13,
		LayoutOrder = 0,
		Parent = window.Logs,
	})
	for index, entry in ipairs(data.Logs or {}) do
		local ok, detail = pcall(HttpService.JSONEncode, HttpService, entry.d)
		Kit.Text({
			Text = string.format("%s [%s] %s %s", os.date("%H:%M:%S", entry.t), entry.c, entry.e, ok and detail or ""),
			TextSize = 12,
			Font = Enum.Font.Code,
			LayoutOrder = index,
			Parent = window.Logs,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.new(1, 0, 0, 0),
		})
	end
end

return Admin
