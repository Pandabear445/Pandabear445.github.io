--[[
	Work orders: accept orders from your superiors, watch progress, and (for
	managers) issue new ones. Rewards and limits are decided by the server.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DepartmentConfig = require(ReplicatedStorage.Kingdom.Config.DepartmentConfig)
local JobConfig = require(ReplicatedStorage.Kingdom.Config.JobConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)
local Notifications = require(script.Parent.Parent.Notifications)

local Orders = {
	Title = "Work Orders",
	Short = "Orders",
	Icon = "📜",
	Key = Enum.KeyCode.O,
	Size = UDim2.fromOffset(640, 540),
	RefreshSeconds = 4,
}

local player = Players.LocalPlayer

local function hasPermission(key: string): boolean
	local list = player:GetAttribute("KingdomPermissions")
	return type(list) == "string" and string.find("," .. list .. ",", "," .. key .. ",", 1, true) ~= nil
end

local function sortedKeys(map): { string }
	local keys = {}
	for key in pairs(map) do
		table.insert(keys, key)
	end
	table.sort(keys)
	return keys
end

function Orders.Build(window)
	local body = window.Body
	Kit.list(body, 6)
	window.List = Kit.Scroll({ Size = UDim2.new(1, 0, 1, -150), LayoutOrder = 1, Parent = body })

	local form = Kit.Panel({ Style = "Stone", Size = UDim2.new(1, 0, 0, 132), LayoutOrder = 2, Parent = body, Padding = 6 })
	window.Form = form
	Kit.list(form, 4)
	Kit.Text({ Text = "Issue a work order (managers)", Style = "Light", TextSize = 15, Parent = form, Font = Kit.Fonts.Heading })
	local row1 = Kit.Row({ Height = 30, LayoutOrder = 1, Parent = form })
	local dept = Kit.Cycle({ Options = sortedKeys(DepartmentConfig.Departments), Prefix = "", Size = UDim2.fromOffset(150, 28), Parent = row1 })
	local objective = Kit.Cycle({ Options = { "Deliver", "Tasks" }, Size = UDim2.fromOffset(100, 28), Parent = row1 })
	local resource = Kit.Cycle({ Options = sortedKeys(ResourceConfig.Resources), Prefix = "Res: ", Size = UDim2.fromOffset(170, 28), Parent = row1 })
	local job = Kit.Cycle({ Options = sortedKeys(JobConfig.Jobs), Prefix = "Job: ", Size = UDim2.fromOffset(170, 28), Parent = row1 })
	local row2 = Kit.Row({ Height = 30, LayoutOrder = 2, Parent = form })
	local target = Kit.Input({ Placeholder = "Target (5-500)", Size = UDim2.fromOffset(120, 28), Parent = row2 })
	local workers = Kit.Input({ Placeholder = "Workers", Size = UDim2.fromOffset(80, 28), Parent = row2 })
	local hours = Kit.Input({ Placeholder = "Hours", Size = UDim2.fromOffset(70, 28), Parent = row2 })
	local priority = Kit.Cycle({ Options = { "Normal", "High", "Critical", "Low" }, Size = UDim2.fromOffset(100, 28), Parent = row2 })
	Kit.Button({
		Text = "Issue",
		Size = UDim2.fromOffset(90, 28),
		TextSize = 14,
		Parent = row2,
		OnClick = function()
			local ok, message = ClientNet.Action("Management", "CreateOrder", {
				department = dept.Get(),
				objective = objective.Get(),
				resource = resource.Get(),
				job = job.Get(),
				target = tonumber(target.Text),
				workers = tonumber(workers.Text),
				hours = tonumber(hours.Text),
				priority = priority.Get(),
			})
			Notifications.Result(ok, message)
			Orders.Refresh(window)
		end,
	})
end

function Orders.Refresh(window)
	window.Form.Visible = hasPermission("Manage.WorkOrders")
	local list = ClientNet.Query("WorkOrders")
	if type(list) ~= "table" then
		return
	end
	Kit.clear(window.List)
	if #list == 0 then
		Kit.Text({ Text = "No open work orders. Managers issue them for their departments.", Parent = window.List })
	end
	for index, order in ipairs(list) do
		local card = Kit.Panel({ Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, LayoutOrder = index, Parent = window.List, Padding = 6 })
		Kit.list(card, 3)
		Kit.Text({ Text = string.format("[%s] %s", order.Priority, order.Title), Style = "Heading", TextSize = 16, Parent = card })
		Kit.Text({
			Text = string.format("%s · by %s · %d/%d workers · reward %d XP · %d min left · %s", order.DepartmentName, order.Creator, order.Accepted, order.Workers, order.RewardXP, order.MinutesLeft, order.State),
			TextSize = 13,
			LayoutOrder = 1,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.new(1, 0, 0, 0),
			Parent = card,
		})
		local bar = Kit.Bar({ LayoutOrder = 2, Parent = card })
		bar:Set(order.Progress / math.max(order.Target, 1), string.format("%d / %d", order.Progress, order.Target))
		if order.State == "Open" then
			local row = Kit.Row({ Height = 28, LayoutOrder = 3, Parent = card })
			if not order.Mine and not order.AcceptedByMe then
				Kit.Button({
					Text = "Accept",
					Size = UDim2.fromOffset(90, 26),
					TextSize = 13,
					Parent = row,
					OnClick = function()
						local ok, message = ClientNet.Action("Management", "AcceptOrder", { order = order.Id })
						Notifications.Result(ok, message)
						Orders.Refresh(window)
					end,
				})
			elseif order.AcceptedByMe then
				Kit.Text({ Text = "You accepted this order.", Size = UDim2.fromOffset(200, 26), Parent = row })
			end
			if order.Mine then
				Kit.Button({
					Text = "Cancel",
					Danger = true,
					Size = UDim2.fromOffset(90, 26),
					TextSize = 13,
					Parent = row,
					OnClick = function()
						local ok, message = ClientNet.Action("Management", "CancelOrder", { order = order.Id })
						Notifications.Result(ok, message)
						Orders.Refresh(window)
					end,
				})
			end
		end
	end
end

return Orders
