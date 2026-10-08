--[[
	Royal Store: cosmetic / convenience GamePasses and Developer Products.
	Prompts use MarketplaceService; ownership is verified by the server.
	Nothing here buys rank or promotion priority.
]]

local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")

local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)

local Store = {
	Title = "Royal Store",
	Short = "Store",
	Icon = "👑",
	Size = UDim2.fromOffset(520, 480),
}

local player = Players.LocalPlayer

function Store.Build(window)
	window.Scroll = Kit.Scroll({ Parent = window.Body, Spacing = 6 })
end

function Store.Refresh(window)
	local data = ClientNet.Query("Store")
	local scroll = window.Scroll
	Kit.clear(scroll)
	Kit.Text({ Text = "Cosmetics and conveniences only - ranks are earned, never bought.", TextSize = 13, LayoutOrder = 0, Parent = scroll })
	if type(data) ~= "table" then
		return
	end
	for index, pass in ipairs(data.Passes or {}) do
		local row = Kit.Row({ Height = 32, LayoutOrder = index, Parent = scroll })
		Kit.Text({ Text = pass.Name, Size = UDim2.fromOffset(300, 30), Parent = row })
		if pass.Owned then
			Kit.Text({ Text = "Owned", Size = UDim2.fromOffset(100, 30), Parent = row })
		else
			Kit.Button({ Text = "Buy", Size = UDim2.fromOffset(100, 28), Parent = row, OnClick = function()
				MarketplaceService:PromptGamePassPurchase(player, pass.Id)
			end })
		end
	end
	for index, product in ipairs(data.Products or {}) do
		local row = Kit.Row({ Height = 32, LayoutOrder = 100 + index, Parent = scroll })
		Kit.Text({ Text = product.Name, Size = UDim2.fromOffset(300, 30), Parent = row })
		Kit.Button({ Text = "Buy", Size = UDim2.fromOffset(100, 28), Parent = row, OnClick = function()
			MarketplaceService:PromptProductPurchase(player, product.Id)
		end })
	end
	if #(data.Passes or {}) + #(data.Products or {}) == 0 then
		Kit.Text({ Text = "The store is not open yet (no GamePass ids configured).", TextSize = 13, LayoutOrder = 1, Parent = scroll })
	end
end

return Store
