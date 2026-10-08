--[[
	Storage popup (opened by the server when you use "Withdraw /
	Requisition" at a storage marker). Withdrawals are limited per in-game
	hour by rank and are checked again on the server.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ItemConfig = require(ReplicatedStorage.Kingdom.Config.ItemConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)
local Notifications = require(script.Parent.Parent.Notifications)

local Storage = {
	Title = "Kingdom Storage",
	Hidden = true,
	Size = UDim2.fromOffset(560, 480),
	Data = nil,
}

function Storage.Build(window)
	local body = window.Body
	Kit.list(body, 6)
	window.Header = Kit.Text({ Style = "Heading", LayoutOrder = 1, Parent = body })
	window.Amount = Kit.Input({ Placeholder = "Amount", Text = "10", Size = UDim2.fromOffset(100, 28), LayoutOrder = 2, Parent = body })
	window.Scroll = Kit.Scroll({ Size = UDim2.new(1, 0, 1, -80), LayoutOrder = 3, Parent = body })
end

local function interact(window, payload)
	task.spawn(function()
		local data = Storage.Data
		if not data then
			return
		end
		payload.station = data.Station
		local ok, message = ClientNet.Action("Job", "Interact", payload)
		Notifications.Result(ok, message)
		if ok and payload.action == "Withdraw" and data.Stock[payload.resource] then
			data.Stock[payload.resource] = math.max(0, data.Stock[payload.resource] - (payload.amount or 0))
			Storage.Refresh(window)
		end
	end)
end

function Storage.Refresh(window)
	local data = Storage.Data
	local scroll = window.Scroll
	Kit.clear(scroll)
	if not data then
		return
	end
	window.Header.Text = data.Name .. (data.CanWithdraw and "" or " (your rank cannot withdraw)")
	local ids = {}
	for id in pairs(data.Stock or {}) do
		table.insert(ids, id)
	end
	table.sort(ids)
	for index, id in ipairs(ids) do
		local def = ResourceConfig.Resources[id]
		local row = Kit.Row({ Height = 28, LayoutOrder = index, Parent = scroll })
		Kit.Text({ Text = string.format("%s %s - %d", def and def.Icon or "", def and def.DisplayName or id, data.Stock[id]), Size = UDim2.fromOffset(300, 26), Parent = row })
		Kit.Button({ Text = "Withdraw", Size = UDim2.fromOffset(110, 24), TextSize = 13, Parent = row, OnClick = function()
			interact(window, { action = "Withdraw", resource = id, amount = math.max(1, math.floor(tonumber(window.Amount.Text) or 1)) })
		end })
	end
	for index, requisition in ipairs(data.Requisitions or {}) do
		local def = ItemConfig.Get(requisition.Tool)
		local row = Kit.Row({ Height = 28, LayoutOrder = 200 + index, Parent = scroll })
		Kit.Text({ Text = string.format("Requisition %s (uses 1 %s, %d left)", def and def.DisplayName or requisition.Tool, requisition.Stock, requisition.Available), Size = UDim2.fromOffset(360, 26), TextSize = 13, Parent = row })
		Kit.Button({ Text = "Requisition", Size = UDim2.fromOffset(110, 24), TextSize = 13, Parent = row, OnClick = function()
			interact(window, { action = "Requisition", tool = requisition.Tool })
		end })
	end
end

return Storage
