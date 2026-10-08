--[[
	Inventory window: carried goods (eat / drop / store), tools with
	durability, carry weight and personal storage. Every button is only a
	request; the server validates location, counts and capacity.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ItemConfig = require(ReplicatedStorage.Kingdom.Config.ItemConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local ClientState = require(script.Parent.Parent.Parent.Controllers.ClientState)
local Kit = require(script.Parent.Parent.Kit)
local Notifications = require(script.Parent.Parent.Notifications)

local Inventory = {
	Title = "Pack & Tools",
	Short = "Pack",
	Icon = "🎒",
	Key = Enum.KeyCode.I,
	Size = UDim2.fromOffset(600, 520),
}

local function act(domain: string, verb: string, payload)
	task.spawn(function()
		local ok, message = ClientNet.Action(domain, verb, payload)
		Notifications.Result(ok, message)
	end)
end

function Inventory.Build(window)
	window.Scroll = Kit.Scroll({ Parent = window.Body, Spacing = 4 })
	ClientState.Changed:Connect(function(scope, key)
		if scope == "Player" and key == "Inventory" and window.Frame.Visible then
			Inventory.Refresh(window)
		end
	end)
end

local function smallButton(parent: Instance, text: string, onClick: () -> ())
	return Kit.Button({ Text = text, Size = UDim2.fromOffset(64, 24), TextSize = 13, Parent = parent, OnClick = onClick })
end

function Inventory.Refresh(window)
	local scroll = window.Scroll
	Kit.clear(scroll)
	local inventory = ClientState.Player.Inventory
	if not inventory then
		Kit.Text({ Text = "Loading…", Parent = scroll })
		return
	end
	local order = 0
	local function nextOrder()
		order += 1
		return order
	end
	local weightBar = Kit.Bar({ LayoutOrder = nextOrder(), Parent = scroll })
	local fraction = inventory.Weight / math.max(inventory.Capacity, 1)
	weightBar:Set(fraction, string.format("Carrying %.1f / %d", inventory.Weight, inventory.Capacity), fraction > 0.9 and Kit.Colors.Bad or Kit.Colors.Good)

	Kit.Text({ Text = "Carried goods", Style = "Heading", LayoutOrder = nextOrder(), Parent = scroll })
	local ids = {}
	for itemId in pairs(inventory.Items or {}) do
		table.insert(ids, itemId)
	end
	table.sort(ids)
	if #ids == 0 then
		Kit.Text({ Text = "Your pack is empty. Work at a farm, mine, forest or dock to gather goods, then deliver them to storage.", TextSize = 13, LayoutOrder = nextOrder(), Parent = scroll, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) })
	end
	for _, itemId in ipairs(ids) do
		local count = inventory.Items[itemId]
		local def = ResourceConfig.Resources[itemId]
		local row = Kit.Row({ Height = 28, LayoutOrder = nextOrder(), Parent = scroll })
		Kit.Text({ Text = string.format("%s %s x%d", def and def.Icon or "", def and def.DisplayName or itemId, count), Size = UDim2.fromOffset(220, 26), Parent = row })
		if ResourceConfig.IsFood(itemId) then
			smallButton(row, "Eat", function()
				act("Food", "Eat", { item = itemId })
			end)
		end
		smallButton(row, "Drop", function()
			act("Inventory", "Drop", { item = itemId, amount = 1 })
		end)
		smallButton(row, "Store", function()
			act("Inventory", "StoreItem", { item = itemId, amount = count })
		end)
	end

	Kit.Text({ Text = "Tools", Style = "Heading", LayoutOrder = nextOrder(), Parent = scroll })
	for _, tool in ipairs(inventory.Tools or {}) do
		local def = ItemConfig.Get(tool.Id)
		local quality = ItemConfig.Qualities[tool.Quality]
		local row = Kit.Row({ Height = 24, LayoutOrder = nextOrder(), Parent = scroll })
		Kit.Text({ Text = string.format("%s %s (%s)", def and def.Icon or "", def and def.DisplayName or tool.Id, quality and quality.DisplayName or tool.Quality), Size = UDim2.fromOffset(240, 22), Parent = row })
		local bar = Kit.Bar({ Size = UDim2.fromOffset(240, 14), Parent = row })
		local durability = tool.Durability / math.max(tool.Max, 1)
		bar:Set(durability, tool.Durability <= 0 and "BROKEN - visit a blacksmith" or string.format("%d / %d", tool.Durability, tool.Max), Kit.percentColor(durability))
	end
	if #(inventory.Tools or {}) == 0 then
		Kit.Text({ Text = "No tools. Requisition them at an armory or buy them from players.", TextSize = 13, LayoutOrder = nextOrder(), Parent = scroll })
	end

	Kit.Text({ Text = string.format("Personal storage (capacity %d) - use at your chest or home", inventory.PersonalCapacity or 0), Style = "Heading", TextSize = 16, LayoutOrder = nextOrder(), Parent = scroll })
	local stored = {}
	for itemId in pairs(inventory.Personal or {}) do
		table.insert(stored, itemId)
	end
	table.sort(stored)
	for _, itemId in ipairs(stored) do
		local def = ResourceConfig.Resources[itemId]
		local count = inventory.Personal[itemId]
		local row = Kit.Row({ Height = 28, LayoutOrder = nextOrder(), Parent = scroll })
		Kit.Text({ Text = string.format("%s %s x%d", def and def.Icon or "", def and def.DisplayName or itemId, count), Size = UDim2.fromOffset(220, 26), Parent = row })
		smallButton(row, "Take", function()
			act("Inventory", "TakeItem", { item = itemId, amount = count })
		end)
	end
end

return Inventory
