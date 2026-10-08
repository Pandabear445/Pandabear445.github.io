--[[
	Market window (use at a KingdomMarket): buy from / sell to the kingdom
	at supply-and-demand prices, browse and post player listings.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)
local Notifications = require(script.Parent.Parent.Notifications)

local Market = {
	Title = "Market",
	Short = "Market",
	Icon = "⚖",
	Key = Enum.KeyCode.B,
	Size = UDim2.fromOffset(720, 560),
	RefreshSeconds = 5,
}

local function act(verb: string, payload, window)
	task.spawn(function()
		local ok, message = ClientNet.Action("Market", verb, payload)
		Notifications.Result(ok, message)
		Market.Refresh(window)
	end)
end

function Market.Build(window)
	local body = window.Body
	Kit.list(body, 6)
	local controls = Kit.Row({ Height = 32, LayoutOrder = 1, Parent = body })
	window.Amount = Kit.Input({ Placeholder = "Amount", Text = "1", Size = UDim2.fromOffset(80, 30), Parent = controls })
	window.Price = Kit.Input({ Placeholder = "Listing total price", Size = UDim2.fromOffset(150, 30), Parent = controls })
	window.Status = Kit.Text({ TextSize = 13, Size = UDim2.fromOffset(360, 30), Parent = controls })
	window.Scroll = Kit.Scroll({ Size = UDim2.new(1, 0, 1, -42), LayoutOrder = 2, Parent = body })
end

function Market.Refresh(window)
	local data = ClientNet.Query("Market")
	if type(data) ~= "table" then
		return
	end
	window.Status.Text = (data.AtMarket and "You are at the market." or "Go to a market to trade.") .. string.format(" Coins: %d", data.Coins or 0)
	local scroll = window.Scroll
	Kit.clear(scroll)
	local amount = function()
		return math.max(1, math.floor(tonumber(window.Amount.Text) or 1))
	end
	Kit.Text({ Text = "Kingdom prices (buy includes taxes)", Style = "Heading", LayoutOrder = 1, Parent = scroll })
	local ids = {}
	for id in pairs(data.Prices or {}) do
		table.insert(ids, id)
	end
	table.sort(ids)
	for index, id in ipairs(ids) do
		local price = data.Prices[id]
		local row = Kit.Row({ Height = 28, LayoutOrder = 10 + index, Background = index % 2 == 0 and Kit.Colors.ParchmentDark or nil, Parent = scroll })
		local trend = price.Buy > price.Base * 1.3 and " ▲" or (price.Buy < price.Base * 0.8 and " ▼" or "")
		Kit.Text({ Text = string.format("%s %s", price.Icon or "", price.Name), Size = UDim2.fromOffset(190, 26), Parent = row })
		Kit.Text({ Text = string.format("buy %d%s · sell %d · stock %d", price.Buy, trend, price.Sell, price.Stock), Size = UDim2.fromOffset(250, 26), TextSize = 13, Parent = row })
		Kit.Button({ Text = "Buy", Size = UDim2.fromOffset(60, 24), TextSize = 13, Parent = row, OnClick = function()
			act("Buy", { resource = id, amount = amount() }, window)
		end })
		Kit.Button({ Text = "Sell", Size = UDim2.fromOffset(60, 24), TextSize = 13, Parent = row, OnClick = function()
			act("Sell", { resource = id, amount = amount() }, window)
		end })
		Kit.Button({ Text = "List", Size = UDim2.fromOffset(60, 24), TextSize = 13, Parent = row, OnClick = function()
			act("List", { resource = id, amount = amount(), price = tonumber(window.Price.Text) }, window)
		end })
	end
	Kit.Text({ Text = "Player listings", Style = "Heading", LayoutOrder = 500, Parent = scroll })
	for index, listing in ipairs(data.Listings or {}) do
		local def = ResourceConfig.Resources[listing.Resource]
		local row = Kit.Row({ Height = 28, LayoutOrder = 500 + index, Parent = scroll })
		Kit.Text({ Text = string.format("%d %s for %d coins - %s", listing.Amount, def and def.DisplayName or listing.Resource, listing.Price, listing.Seller), Size = UDim2.fromOffset(420, 26), TextSize = 13, Parent = row })
		if listing.Mine then
			Kit.Button({ Text = "Cancel", Danger = true, Size = UDim2.fromOffset(80, 24), TextSize = 13, Parent = row, OnClick = function()
				act("CancelListing", { listing = listing.Id }, window)
			end })
		else
			Kit.Button({ Text = "Buy", Size = UDim2.fromOffset(80, 24), TextSize = 13, Parent = row, OnClick = function()
				act("BuyListing", { listing = listing.Id }, window)
			end })
		end
	end
end

return Market
