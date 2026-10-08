--[[
	Management dashboard. What you see grows with rank (DashboardLevel):
	  Personal -> Job -> Security -> Department -> Military -> Regional
	  -> Kingdom -> Full
	Managers see department status (workers required/assigned/active/
	inactive, production, efficiency, morale, problems) and each
	subordinate's attendance, activity, location, assignment and
	performance, and can act on them. Every action is validated server-side.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DepartmentConfig = require(ReplicatedStorage.Kingdom.Config.DepartmentConfig)
local Format = require(ReplicatedStorage.Kingdom.Shared.Format)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)
local Notifications = require(script.Parent.Parent.Notifications)

local Management = {
	Title = "Duties & Management",
	Short = "Duties",
	Icon = "🛡",
	Key = Enum.KeyCode.N,
	Size = UDim2.fromOffset(780, 580),
	RefreshSeconds = 6,
}

local function sortedKeys(map): { string }
	local keys = {}
	for key in pairs(map) do
		table.insert(keys, key)
	end
	table.sort(keys)
	return keys
end

local function act(domain: string, verb: string, payload, window)
	task.spawn(function()
		local ok, message = ClientNet.Action(domain, verb, payload)
		Notifications.Result(ok, message)
		if window then
			Management.Refresh(window)
		end
	end)
end

function Management.Build(window)
	local body = window.Body
	Kit.list(body, 6)
	local controls = Kit.Panel({ Style = "Stone", Size = UDim2.new(1, 0, 0, 44), LayoutOrder = 1, Parent = body, Padding = 6 })
	local row = Kit.Row({ Height = 30, Parent = controls })
	window.Reason = Kit.Input({ Placeholder = "Reason for any disciplinary action (required)", Size = UDim2.fromOffset(330, 28), Parent = row })
	window.Amount = Kit.Input({ Placeholder = "Coins / minutes", Size = UDim2.fromOffset(120, 28), Parent = row })
	window.Dept = Kit.Cycle({ Options = sortedKeys(DepartmentConfig.Departments), Prefix = "Dept: ", Size = UDim2.fromOffset(200, 28), Parent = row })
	window.Scroll = Kit.Scroll({ Size = UDim2.new(1, 0, 1, -54), LayoutOrder = 2, Parent = body, Spacing = 6 })
end

local function heading(parent: Instance, text: string, order: number)
	Kit.Text({ Text = text, Style = "Heading", TextSize = 19, LayoutOrder = order, Parent = parent })
end

local function smallButton(parent: Instance, text: string, onClick: () -> (), danger: boolean?)
	return Kit.Button({ Text = text, Size = UDim2.fromOffset(78, 24), TextSize = 12, Danger = danger, Parent = parent, OnClick = onClick })
end

function Management.Refresh(window)
	local data = ClientNet.Query("Dashboard")
	if type(data) ~= "table" then
		return
	end
	local scroll = window.Scroll
	Kit.clear(scroll)
	local order = 0
	local function nextOrder()
		order += 1
		return order
	end

	local me = data.Personal
	if me then
		heading(scroll, "Your performance", nextOrder())
		Kit.Text({
			Text = string.format("%s · %s · rating %.2f (%s) · mistakes %d · attendance %s · warnings %d", me.Rank, me.Job, me.Rating, me.Tier, me.Mistakes, me.Attendance, me.Warnings),
			TextSize = 13,
			LayoutOrder = nextOrder(),
			Parent = scroll,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.new(1, 0, 0, 0),
		})
	end

	if data.Security then
		heading(scroll, string.format("Security %s · guards on duty: %d", Format.percent(data.Security.Need), data.Security.GuardsOnDuty), nextOrder())
	end

	if data.Departments then
		heading(scroll, "Departments", nextOrder())
		for _, dept in ipairs(data.Departments) do
			local card = Kit.Panel({ Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, LayoutOrder = nextOrder(), Parent = scroll, Padding = 6 })
			Kit.list(card, 3)
			Kit.Text({
				Text = string.format("%s %s · priority %s · managers: %s", dept.Icon or "", dept.Name, dept.Priority, #dept.Managers > 0 and table.concat(dept.Managers, ", ") or "none"),
				Style = "Heading",
				TextSize = 15,
				Parent = card,
			})
			Kit.Text({
				Text = string.format(
					"Required %d · Assigned %d · Active %d · Inactive %d · Production %d%% (%d/%d tasks last hour) · Efficiency %d%% · Morale %d · last inspected %d min ago",
					dept.Required,
					dept.Assigned,
					dept.Active,
					dept.Inactive,
					math.floor(dept.Production * 100),
					dept.TasksLastHour,
					dept.ProductionTarget,
					math.floor(dept.Efficiency * 100),
					math.floor(dept.Morale),
					dept.MinutesSinceInspection
				),
				TextSize = 13,
				LayoutOrder = 1,
				AutomaticSize = Enum.AutomaticSize.Y,
				Size = UDim2.new(1, 0, 0, 0),
				Parent = card,
			})
			if #dept.Problems > 0 then
				Kit.Text({ Text = "⚠ " .. table.concat(dept.Problems, " · "), TextSize = 13, Color = Kit.Colors.Bad, LayoutOrder = 2, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = card })
			end
			local actions = Kit.Row({ Height = 26, LayoutOrder = 3, Parent = card })
			for _, priority in ipairs({ "Low", "Normal", "High", "Critical" }) do
				smallButton(actions, priority, function()
					act("Management", "SetPriority", { department = dept.Id, priority = priority }, window)
				end)
			end
			smallButton(actions, "Need staff", function()
				act("Management", "RequestStaff", { department = dept.Id, count = math.max(1, dept.Required - dept.Active) }, window)
			end)
		end
	end

	if data.Workers then
		heading(scroll, string.format("Your subordinates (%d)", #data.Workers), nextOrder())
		if #data.Workers == 0 then
			Kit.Text({ Text = "Nobody under your authority is online.", TextSize = 13, LayoutOrder = nextOrder(), Parent = scroll })
		end
		for _, worker in ipairs(data.Workers) do
			local card = Kit.Panel({ Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, LayoutOrder = nextOrder(), Parent = scroll, Padding = 6 })
			Kit.list(card, 3)
			Kit.Text({
				Text = string.format(
					"%s (%s) · %s · %s · %s · rating %.2f %s · hunger %d%s",
					worker.Name,
					worker.Rank,
					worker.Department or "no department",
					worker.Job,
					worker.Active and "active" or "AFK",
					worker.Rating,
					worker.Tier,
					worker.Hunger,
					worker.Sick and " · SICK" or ""
				),
				TextSize = 13,
				Parent = card,
				AutomaticSize = Enum.AutomaticSize.Y,
				Size = UDim2.new(1, 0, 0, 0),
			})
			Kit.Text({
				Text = string.format("Location %s · attendance %s · warnings %d · last task %s%s", worker.Location, worker.Attendance, worker.Warnings, worker.SecondsSinceTask and (worker.SecondsSinceTask .. "s ago") or "never", worker.Order and (" · order: " .. worker.Order) or ""),
				TextSize = 12,
				LayoutOrder = 1,
				Parent = card,
				AutomaticSize = Enum.AutomaticSize.Y,
				Size = UDim2.new(1, 0, 0, 0),
			})
			local actions = Kit.Row({ Height = 26, LayoutOrder = 2, Parent = card })
			local target = worker.UserId
			smallButton(actions, "Assign", function()
				act("Management", "AssignWorker", { target = target, department = window.Dept.Get() }, window)
			end)
			smallButton(actions, "Appoint", function()
				act("Management", "AppointManager", { target = target, department = window.Dept.Get(), appoint = true }, window)
			end)
			smallButton(actions, "Warn", function()
				act("Discipline", "Warn", { target = target, reason = window.Reason.Text }, window)
			end)
			smallButton(actions, "Fine", function()
				act("Discipline", "Fine", { target = target, amount = tonumber(window.Amount.Text) or 10, reason = window.Reason.Text }, window)
			end)
			smallButton(actions, "Suspend", function()
				act("Discipline", "Suspend", { target = target, minutes = tonumber(window.Amount.Text) or 30, reason = window.Reason.Text }, window)
			end)
			smallButton(actions, "Demote", function()
				act("Government", "Demote", { target = target, reason = window.Reason.Text }, window)
			end, true)
			smallButton(actions, "To Senate", function()
				act("Discipline", "RequestDemotion", { target = target, reason = window.Reason.Text }, window)
			end, true)
			smallButton(actions, "Remove", function()
				act("Government", "Remove", { target = target, reason = window.Reason.Text }, window)
			end, true)
		end
	end

	if data.Kingdom then
		heading(scroll, string.format("Kingdom: %s · stability %s · morale %d · treasury %s", data.Kingdom.Stage, Format.percent(data.Kingdom.Stability), math.floor(data.Kingdom.Morale), Format.number(data.Treasury and data.Treasury.Balance or 0)), nextOrder())
	end

	if data.Managers then
		heading(scroll, "Leadership performance", nextOrder())
		for _, manager in ipairs(data.Managers) do
			Kit.Text({
				Text = string.format(
					"%s (%s) · reputation %d · orders %d done / %d failed · inspections %d · targets met %d · crises prevented %d · %d h managed · attendance %s",
					manager.Name,
					manager.Rank,
					manager.Reputation,
					manager.OrdersCompleted,
					manager.OrdersFailed,
					manager.Inspections,
					manager.TargetsMet,
					manager.CrisesPrevented,
					manager.HoursManaged,
					manager.Attendance
				),
				TextSize = 12,
				LayoutOrder = nextOrder(),
				Parent = scroll,
				AutomaticSize = Enum.AutomaticSize.Y,
				Size = UDim2.new(1, 0, 0, 0),
			})
		end
	end

	-- Department self-service for everyone.
	heading(scroll, "Your department", nextOrder())
	local selfRow = Kit.Row({ Height = 28, LayoutOrder = nextOrder(), Parent = scroll })
	Kit.Button({
		Text = "Join selected dept",
		Size = UDim2.fromOffset(170, 26),
		TextSize = 13,
		Parent = selfRow,
		OnClick = function()
			act("Department", "Join", { department = window.Dept.Get() }, window)
		end,
	})
	Kit.Button({
		Text = "Leave department",
		Size = UDim2.fromOffset(170, 26),
		TextSize = 13,
		Parent = selfRow,
		OnClick = function()
			act("Department", "Leave", {}, window)
		end,
	})
	Kit.Button({
		Text = "Appeal discipline",
		Size = UDim2.fromOffset(170, 26),
		TextSize = 13,
		Parent = selfRow,
		OnClick = function()
			act("Discipline", "Appeal", {}, window)
		end,
	})
end

return Management
