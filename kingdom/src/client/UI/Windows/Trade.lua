--[[
	Export ledger (opened at a KingdomTradePost). Merchants sell carried
	goods abroad; the treasury keeps most of the revenue.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)
local Notifications = require(script.Parent.Parent.Notifications)

local Trade = {
	Title = "Caravan Ledger",
	Hidden = true,
	Size = UDim2.fromOffset(540, 440),
	Data = nil,
}

function Trade.Build(window)
	local body = window.Body
	Kit.list(body, 6)
	window.Header = Kit.Text({ TextSize = 14, LayoutOrder = 1, Parent = body, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) })
	window.Scroll = Kit.Scroll({ Size = UDim2.new(1, 0, 1, -60), LayoutOrder = 2, Parent = body })
end

function Trade.Refresh(window)
	local data = Trade.Data
	Kit.clear(window.Scroll)
	if not data then
		return
	end
	window.Header.Text = string.format(
		"Your commission: %d%% (minus %d%% trade tax). %s",
		math.floor(data.Commission * 100),
		math.floor(data.TradeTax * 100),
		data.Bonus > 1 and string.format("Caravan bonus x%.1f!", data.Bonus) or ""
	)
	for index, offer in ipairs(data.Offers or {}) do
		local def = ResourceConfig.Resources[offer.Resource]
		local row = Kit.Row({ Height = 28, LayoutOrder = index, Parent = window.Scroll })
		Kit.Text({ Text = string.format("%s x%d @ %d each", def and def.DisplayName or offer.Resource, offer.Have, offer.Price), Size = UDim2.fromOffset(300, 26), Parent = row })
		Kit.Button({ Text = "Export all", Size = UDim2.fromOffset(120, 24), TextSize = 13, Parent = row, OnClick = function()
			task.spawn(function()
				local ok, message = ClientNet.Action("Job", "Interact", { station = data.Station, action = "Export", resource = offer.Resource, amount = offer.Have })
				Notifications.Result(ok, message)
				if ok then
					offer.Have = 0
					Trade.Refresh(window)
				end
			end)
		end })
	end
	if #(data.Offers or {}) == 0 then
		Kit.Text({ Text = "You carry nothing to export. Withdraw surplus from the warehouse first.", Parent = window.Scroll })
	end
end

return Trade
