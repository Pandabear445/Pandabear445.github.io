--[[
	InventoryService
	Server-authoritative personal inventory.
	  Items  stackable resources (ResourceConfig) limited by carry weight
	  Tools  unique items with durability (ItemConfig)
	Clients can only REQUEST drop / requisition / storage moves. Every add or
	remove goes through here with a reason, which AuditService records.

	Carrying matters: resources must be physically transported to storage,
	and anything carried can be dropped on death (DeathConfig).
]]

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local DeathConfig = require(ReplicatedStorage.Kingdom.Config.DeathConfig)
local ItemConfig = require(ReplicatedStorage.Kingdom.Config.ItemConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local InventoryService = {
	Name = "InventoryService",
	Dependencies = { "DataService", "AuditService", "StateService", "TimeService" },
}

local SACK_TAG = "KingdomLootSack"
local PERSONAL_STORAGE_TAG = "KingdomPersonalStorage"

function InventoryService:Init()
	self._data = self:Use("DataService")
	self._audit = self:Use("AuditService")
	self._state = self:Use("StateService")
	self._time = self:Use("TimeService")

	self.Changed = Signal.new("InventoryChanged") -- (player)
	self._carryBonus = {} -- name -> fn(player) -> number
	self._storageBonus = {}
	self._sacks = {}

	self._data.Loaded:Connect(function(player)
		self:Publish(player)
		self:SyncBackpack(player)
	end)
	Players.PlayerAdded:Connect(function(player)
		player.CharacterAdded:Connect(function()
			task.wait(0.2)
			self:SyncBackpack(player)
		end)
	end)
	for _, player in ipairs(Players:GetPlayers()) do
		player.CharacterAdded:Connect(function()
			task.wait(0.2)
			self:SyncBackpack(player)
		end)
	end

	self._time.HourChanged:Connect(function()
		for _, player in ipairs(Players:GetPlayers()) do
			pcall(self._decay, self, player)
		end
	end)

	Net.Action("Inventory", "Drop", { rate = 1, burst = 3 }, function(player, payload)
		local itemId = Check.key(payload.item, ResourceConfig.Resources)
		local amount = Check.integer(payload.amount, 1, 999)
		if not itemId or not amount then
			return false, "Invalid item."
		end
		local root = ZoneUtil.getRoot(player)
		if not root or not ZoneUtil.isAlive(player) then
			return false, "You cannot do that now."
		end
		amount = math.min(amount, self:Count(player, itemId))
		if amount <= 0 or not self:Remove(player, itemId, amount, "Dropped") then
			return false, "You don't have that."
		end
		self:DropSack(root.Position, { [itemId] = amount }, {}, player)
		return true, string.format("Dropped %d %s.", amount, ResourceConfig.Resources[itemId].DisplayName)
	end)

	Net.Action("Inventory", "StoreItem", { rate = 2, burst = 4 }, function(player, payload)
		return self:_personalStorageAction(player, payload, true)
	end)
	Net.Action("Inventory", "TakeItem", { rate = 2, burst = 4 }, function(player, payload)
		return self:_personalStorageAction(player, payload, false)
	end)
end

function InventoryService:Start() end

-- Capacity -------------------------------------------------------------------

function InventoryService:RegisterCarryBonus(name: string, fn: (Player) -> number)
	self._carryBonus[name] = fn
end

function InventoryService:RegisterStorageBonus(name: string, fn: (Player) -> number)
	self._storageBonus[name] = fn
end

local function sumBonuses(map, player: Player): number
	local total = 0
	for _, fn in pairs(map) do
		local ok, value = pcall(fn, player)
		if ok and type(value) == "number" then
			total += value
		end
	end
	return total
end

function InventoryService:GetCapacity(player: Player): number
	return ItemConfig.BaseCarryWeight + sumBonuses(self._carryBonus, player)
end

function InventoryService:GetPersonalStorageCapacity(player: Player): number
	return ItemConfig.BasePersonalStorage + sumBonuses(self._storageBonus, player)
end

local function itemsWeight(items): number
	local weight = 0
	for itemId, count in pairs(items) do
		local def = ResourceConfig.Resources[itemId]
		weight += (def and def.Weight or 1) * count
	end
	return weight
end

function InventoryService:GetWeight(player: Player): number
	local profile = self._data:Get(player)
	if not profile then
		return 0
	end
	local weight = itemsWeight(profile.Inventory.Items)
	for _, tool in pairs(profile.Inventory.Tools) do
		local def = ItemConfig.Get(tool.Id)
		weight += def and def.Weight or 2
	end
	return weight
end

-- How many units of itemId the player can still carry.
function InventoryService:RoomFor(player: Player, itemId: string): number
	local def = ResourceConfig.Resources[itemId]
	if not def then
		return 0
	end
	local free = self:GetCapacity(player) - self:GetWeight(player)
	return math.max(0, math.floor(free / math.max(def.Weight, 0.01) + 1e-6))
end

-- Items ------------------------------------------------------------------------

function InventoryService:Count(player: Player, itemId: string): number
	local profile = self._data:Get(player)
	return profile and (profile.Inventory.Items[itemId] or 0) or 0
end

-- Adds up to `amount` (limited by weight). Returns the number added.
function InventoryService:Add(player: Player, itemId: string, amount: number, reason: string): number
	local profile = self._data:Get(player)
	if not profile or not ResourceConfig.Resources[itemId] or amount <= 0 then
		return 0
	end
	local added = math.min(math.floor(amount), self:RoomFor(player, itemId))
	if added <= 0 then
		return 0
	end
	profile.Inventory.Items[itemId] = (profile.Inventory.Items[itemId] or 0) + added
	self._audit:Log("Resource", "InventoryAdd", { userId = player.UserId, item = itemId, amount = added, reason = reason })
	self:_changed(player)
	return added
end

-- All-or-nothing removal.
function InventoryService:Remove(player: Player, itemId: string, amount: number, reason: string): boolean
	local profile = self._data:Get(player)
	if not profile or amount <= 0 then
		return false
	end
	local have = profile.Inventory.Items[itemId] or 0
	if have < amount then
		return false
	end
	local remaining = have - amount
	profile.Inventory.Items[itemId] = remaining > 0 and remaining or nil
	self:_clampTaint(profile, itemId)
	self._audit:Log("Resource", "InventoryRemove", { userId = player.UserId, item = itemId, amount = amount, reason = reason })
	self:_changed(player)
	return true
end

-- Taint: units that came OUT of kingdom storage or the kingdom market.
-- Depositing them back earns no contribution XP/wage, which closes the
-- withdraw -> deposit XP loop. Taint is consumed first when depositing.
function InventoryService:AddTaint(player: Player, itemId: string, amount: number)
	local profile = self._data:Get(player)
	if not profile or amount <= 0 then
		return
	end
	local tainted = profile.Inventory.Tainted or {}
	profile.Inventory.Tainted = tainted
	tainted[itemId] = math.min((tainted[itemId] or 0) + amount, profile.Inventory.Items[itemId] or 0)
end

-- Splits a deposit of `amount` into (untainted, tainted) and clears the taint.
function InventoryService:ConsumeTaint(player: Player, itemId: string, amount: number): (number, number)
	local profile = self._data:Get(player)
	if not profile then
		return 0, amount
	end
	local tainted = profile.Inventory.Tainted or {}
	local taintedUnits = math.min(tainted[itemId] or 0, amount)
	local left = (tainted[itemId] or 0) - taintedUnits
	tainted[itemId] = left > 0 and left or nil
	return amount - taintedUnits, taintedUnits
end

function InventoryService:_clampTaint(profile, itemId: string)
	local tainted = profile.Inventory.Tainted
	if tainted and tainted[itemId] then
		local have = profile.Inventory.Items[itemId] or 0
		tainted[itemId] = have > 0 and math.min(tainted[itemId], have) or nil
	end
end

function InventoryService:HasItems(player: Player, items: { [string]: number }): boolean
	for itemId, amount in pairs(items) do
		if self:Count(player, itemId) < amount then
			return false
		end
	end
	return true
end

-- Atomic multi-item removal: checks everything first.
function InventoryService:RemoveItems(player: Player, items: { [string]: number }, reason: string): boolean
	if not self:HasItems(player, items) then
		return false
	end
	for itemId, amount in pairs(items) do
		self:Remove(player, itemId, amount, reason)
	end
	return true
end

function InventoryService:GetItems(player: Player): { [string]: number }
	local profile = self._data:Get(player)
	return profile and table.clone(profile.Inventory.Items) or {}
end

-- Tools ------------------------------------------------------------------------

function InventoryService:AddTool(player: Player, toolId: string, quality: string?, durability: number?, reason: string?): string?
	local profile = self._data:Get(player)
	local def = ItemConfig.Get(toolId)
	if not profile or not def then
		return nil
	end
	local q = ItemConfig.Qualities[quality or "Standard"] and (quality or "Standard") or "Standard"
	local max = ItemConfig.Qualities[q].MaxDurability
	local uid = tostring(profile.Inventory.NextToolId or 1)
	profile.Inventory.NextToolId = (profile.Inventory.NextToolId or 1) + 1
	profile.Inventory.Tools[uid] = {
		Id = toolId,
		Quality = q,
		Durability = math.clamp(durability or max, 0, max),
		Max = max,
	}
	self._audit:Log("Resource", "ToolAdd", { userId = player.UserId, tool = toolId, quality = q, reason = reason })
	self:_changed(player)
	self:SyncBackpack(player)
	return uid
end

function InventoryService:RemoveTool(player: Player, uid: string, reason: string?)
	local profile = self._data:Get(player)
	if not profile then
		return nil
	end
	local tool = profile.Inventory.Tools[uid]
	if tool then
		profile.Inventory.Tools[uid] = nil
		self._audit:Log("Resource", "ToolRemove", { userId = player.UserId, tool = tool.Id, reason = reason })
		self:_changed(player)
		self:SyncBackpack(player)
	end
	return tool
end

function InventoryService:GetTool(player: Player, uid: string)
	local profile = self._data:Get(player)
	return profile and profile.Inventory.Tools[uid] or nil
end

function InventoryService:HasToolType(player: Player, toolId: string): boolean
	local profile = self._data:Get(player)
	if not profile then
		return false
	end
	for _, tool in pairs(profile.Inventory.Tools) do
		if tool.Id == toolId then
			return true
		end
	end
	return false
end

-- Best usable tool of a type (highest durability > 0).
function InventoryService:GetBestTool(player: Player, toolId: string): (string?, any)
	local profile = self._data:Get(player)
	if not profile then
		return nil, nil
	end
	local bestUid, best
	for uid, tool in pairs(profile.Inventory.Tools) do
		if tool.Id == toolId and tool.Durability > 0 then
			if not best or tool.Durability > best.Durability then
				bestUid, best = uid, tool
			end
		end
	end
	return bestUid, best
end

function InventoryService.ToolEfficiency(tool): number
	if not tool or tool.Durability <= 0 then
		return 0
	end
	local fraction = tool.Durability / math.max(tool.Max, 1)
	local quality = ItemConfig.Qualities[tool.Quality] or ItemConfig.Qualities.Standard
	for _, band in ipairs(ItemConfig.ConditionEfficiency) do
		if fraction >= band.Min then
			return band.Multiplier * quality.Efficiency
		end
	end
	return 0
end

-- Uses (wears) the best tool of a type. Returns ok, efficiency, reason, tool.
function InventoryService:UseTool(player: Player, toolId: string?): (boolean, number, string?, any)
	if not toolId or toolId == "" then
		return true, 1, nil, nil
	end
	local def = ItemConfig.Get(toolId)
	if not def then
		return true, 1, nil, nil
	end
	local uid, tool = self:GetBestTool(player, toolId)
	if not uid or not tool then
		if self:HasToolType(player, toolId) then
			return false, 0, string.format("Your %s is broken. Take it to a blacksmith.", def.DisplayName), nil
		end
		return false, 0, string.format("You need a %s.", def.DisplayName), nil
	end
	local efficiency = InventoryService.ToolEfficiency(tool)
	tool.Durability = math.max(0, tool.Durability - (def.WearPerUse or 1))
	if tool.Durability <= 0 then
		local owner = player
		task.defer(function()
			if owner.Parent == Players then
				Net.Fire("Notify", owner, {
					Kind = "Warning",
					Title = def.DisplayName .. " broke",
					Text = "A blacksmith can repair it.",
					Time = os.time(),
				})
			end
		end)
	end
	self:_changed(player)
	return true, efficiency, nil, tool
end

function InventoryService:RepairTool(player: Player, uid: string, fraction: number?): boolean
	local tool = self:GetTool(player, uid)
	if not tool then
		return false
	end
	tool.Durability = math.min(tool.Max, tool.Durability + tool.Max * (fraction or 1))
	self:_changed(player)
	return true
end

function InventoryService:DamageAllTools(player: Player, fraction: number)
	local profile = self._data:Get(player)
	if not profile then
		return
	end
	for _, tool in pairs(profile.Inventory.Tools) do
		tool.Durability = math.max(0, tool.Durability - tool.Max * fraction)
	end
	self:_changed(player)
end

-- Starter kit: given once per life for tool types the player lacks.
function InventoryService:GiveStarterKit(player: Player)
	local profile = self._data:Get(player)
	if not profile or profile.StarterKitLife == profile.Life.Number then
		return
	end
	profile.StarterKitLife = profile.Life.Number
	for _, entry in ipairs(ItemConfig.StarterKit) do
		if not self:HasToolType(player, entry.Id) then
			self:AddTool(player, entry.Id, entry.Quality, nil, "StarterKit")
		end
	end
end

-- Backpack visuals ---------------------------------------------------------------

local function buildTool(toolId: string): Tool
	local template = ServerStorage:FindFirstChild("Kingdom")
	template = template and template:FindFirstChild("Tools")
	template = template and template:FindFirstChild(toolId)
	if template and template:IsA("Tool") then
		return template:Clone()
	end
	local def = ItemConfig.Get(toolId)
	local tool = Instance.new("Tool")
	tool.CanBeDropped = false
	local handle = Instance.new("Part")
	handle.Name = "Handle"
	handle.Size = Vector3.new(0.4, 3.2, 0.4)
	handle.Color = def and def.Color or Color3.fromRGB(120, 90, 60)
	handle.Material = Enum.Material.Wood
	handle.CanCollide = false
	handle.Massless = true
	handle.Parent = tool
	local head = Instance.new("Part")
	head.Name = "Head"
	head.Size = Vector3.new(1.2, 0.5, 0.3)
	head.Material = Enum.Material.Metal
	head.Color = Color3.fromRGB(150, 150, 160)
	head.CanCollide = false
	head.Massless = true
	head.CFrame = handle.CFrame * CFrame.new(0, 1.5, 0)
	head.Parent = tool
	local weld = Instance.new("WeldConstraint")
	weld.Part0 = handle
	weld.Part1 = head
	weld.Parent = handle
	return tool
end

-- Keeps one Tool instance per owned tool type in the Backpack.
function InventoryService:SyncBackpack(player: Player)
	local profile = self._data:Get(player)
	local backpack = player:FindFirstChildOfClass("Backpack")
	if not profile or not backpack then
		return
	end
	local owned = {}
	for _, tool in pairs(profile.Inventory.Tools) do
		owned[tool.Id] = true
	end
	local present = {}
	local containers = { backpack, player.Character }
	for _, container in ipairs(containers) do
		if container then
			for _, child in ipairs(container:GetChildren()) do
				if child:IsA("Tool") and child:GetAttribute("KingdomTool") then
					local id = child:GetAttribute("KingdomTool")
					if not owned[id] or present[id] then
						child:Destroy()
					else
						present[id] = true
					end
				end
			end
		end
	end
	for toolId in pairs(owned) do
		if not present[toolId] then
			local def = ItemConfig.Get(toolId)
			local instance = buildTool(toolId)
			instance.Name = def and def.DisplayName or toolId
			instance:SetAttribute("KingdomTool", toolId)
			instance.Parent = backpack
		end
	end
end

-- Loot sacks ---------------------------------------------------------------------

function InventoryService:DropSack(position: Vector3, items: { [string]: number }, tools: { any }, owner: Player?)
	if not next(items) and #tools == 0 then
		return nil
	end
	local sack = Instance.new("Part")
	sack.Name = "LootSack"
	sack.Shape = Enum.PartType.Ball
	sack.Size = Vector3.new(1.6, 1.6, 1.6)
	sack.Color = Color3.fromRGB(130, 100, 60)
	sack.Material = Enum.Material.Fabric
	sack.Anchored = true
	sack.CanCollide = false
	sack.Position = position + Vector3.new(0, -1.5, 0)
	sack:AddTag(SACK_TAG)

	local prompt = Instance.new("ProximityPrompt")
	prompt.ActionText = "Pick up"
	prompt.ObjectText = owner and (owner.DisplayName .. "'s belongings") or "Sack"
	prompt.HoldDuration = 0.8
	prompt.MaxActivationDistance = 10
	prompt.RequiresLineOfSight = false
	prompt.Parent = sack

	local record = {
		items = table.clone(items),
		tools = tools,
		owner = owner and owner.UserId or nil,
		createdAt = os.clock(),
	}
	self._sacks[sack] = record
	prompt.Triggered:Connect(function(player)
		self:_pickUp(player, sack)
	end)
	sack.Parent = workspace
	task.delay(DeathConfig.LootSack.DespawnSeconds, function()
		if sack.Parent then
			self._audit:Log("Resource", "SackExpired", { items = record.items })
			self._sacks[sack] = nil
			sack:Destroy()
		end
	end)
	return sack
end

function InventoryService:_pickUp(player: Player, sack: BasePart)
	local record = self._sacks[sack]
	if not record or not self._data:IsLoaded(player) or not ZoneUtil.isAlive(player) then
		return
	end
	if ZoneUtil.playerDistance(player, sack) > 12 then
		return
	end
	local ownerOnly = DeathConfig.LootSack.OwnerOnlySeconds
	if record.owner and record.owner ~= player.UserId and os.clock() - record.createdAt < ownerOnly then
		return
	end
	for itemId, count in pairs(record.items) do
		local added = self:Add(player, itemId, count, "PickedUp")
		local remaining = count - added
		record.items[itemId] = remaining > 0 and remaining or nil
	end
	for i = #record.tools, 1, -1 do
		local tool = record.tools[i]
		if self:AddTool(player, tool.Id, tool.Quality, tool.Durability, "PickedUp") then
			table.remove(record.tools, i)
		end
	end
	if not next(record.items) and #record.tools == 0 then
		self._sacks[sack] = nil
		sack:Destroy()
	end
end

-- Death handling: drops resources per DeathConfig. Returns what was dropped.
function InventoryService:ApplyDeathRules(player: Player, position: Vector3?)
	local profile = self._data:Get(player)
	if not profile then
		return {}
	end
	local rules = DeathConfig.Inventory
	local dropped = {}
	if rules.DropResourcesOnDeath then
		for itemId, count in pairs(profile.Inventory.Items) do
			local amount = math.floor(count * rules.DropPercentage + 0.5)
			if amount > 0 then
				dropped[itemId] = amount
				local remaining = count - amount
				profile.Inventory.Items[itemId] = remaining > 0 and remaining or nil
			end
		end
	end
	local droppedTools = {}
	if rules.LoseHeldItems and player.Character then
		local held = player.Character:FindFirstChildOfClass("Tool")
		local heldId = held and held:GetAttribute("KingdomTool")
		if heldId then
			local uid = self:GetBestTool(player, heldId)
			local tool = uid and self:RemoveTool(player, uid, "DeathDrop")
			if tool then
				table.insert(droppedTools, tool)
			end
		end
	end
	if rules.LoseEquipmentDurability then
		self:DamageAllTools(player, rules.DurabilityLossFraction)
	end
	if position and (next(dropped) or #droppedTools > 0) then
		self:DropSack(position, dropped, droppedTools, player)
	end
	self._audit:Log("Death", "ItemsDropped", { userId = player.UserId, items = dropped })
	self:_changed(player)
	return dropped
end

-- Personal storage ---------------------------------------------------------------

function InventoryService:_nearPersonalStorage(player: Player): boolean
	for _, marker in ipairs(CollectionService:GetTagged(PERSONAL_STORAGE_TAG)) do
		if ZoneUtil.playerDistance(player, marker) <= 12 then
			return true
		end
	end
	-- Housing can allow access at home.
	return player:GetAttribute("KingdomAtHome") == true
end

function InventoryService:_personalStorageAction(player: Player, payload, toStorage: boolean)
	local itemId = Check.key(payload.item, ResourceConfig.Resources)
	local amount = Check.integer(payload.amount, 1, 999)
	if not itemId or not amount then
		return false, "Invalid item."
	end
	if not self:_nearPersonalStorage(player) then
		return false, "You must be at your personal storage chest."
	end
	local profile = self._data:Get(player)
	if not profile then
		return false, "Not ready."
	end
	local storage = profile.PersonalStorage.Items
	if toStorage then
		amount = math.min(amount, self:Count(player, itemId))
		local def = ResourceConfig.Resources[itemId]
		local free = self:GetPersonalStorageCapacity(player) - itemsWeight(storage)
		amount = math.min(amount, math.floor(free / math.max(def.Weight, 0.01)))
		if amount <= 0 or not self:Remove(player, itemId, amount, "ToPersonalStorage") then
			return false, "No room in storage."
		end
		storage[itemId] = (storage[itemId] or 0) + amount
	else
		amount = math.min(amount, storage[itemId] or 0)
		if amount <= 0 then
			return false, "Nothing stored."
		end
		local added = self:Add(player, itemId, amount, "FromPersonalStorage")
		if added <= 0 then
			return false, "You can't carry more."
		end
		local remaining = (storage[itemId] or 0) - added
		storage[itemId] = remaining > 0 and remaining or nil
	end
	self:_changed(player)
	return true, "Done."
end

-- Decay & publishing ------------------------------------------------------------

function InventoryService:_decay(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return
	end
	local changed = false
	for itemId, count in pairs(profile.Inventory.Items) do
		local def = ResourceConfig.Resources[itemId]
		local rate = def and def.DecayRate or 0
		if rate > 0 then
			local expected = count * rate * ItemConfig.InventoryDecayFactor
			local lost = math.floor(expected)
			if math.random() < expected - lost then
				lost += 1
			end
			if lost > 0 then
				local remaining = count - lost
				profile.Inventory.Items[itemId] = remaining > 0 and remaining or nil
				changed = true
			end
		end
	end
	if changed then
		self:_changed(player)
	end
end

function InventoryService:_changed(player: Player)
	self:Publish(player)
	self.Changed:Fire(player)
end

function InventoryService:Publish(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return
	end
	local tools = {}
	for uid, tool in pairs(profile.Inventory.Tools) do
		table.insert(tools, {
			Uid = uid,
			Id = tool.Id,
			Quality = tool.Quality,
			Durability = math.floor(tool.Durability),
			Max = tool.Max,
		})
	end
	table.sort(tools, function(a, b)
		return a.Id < b.Id
	end)
	self._state:Set(player, "Inventory", {
		Items = table.clone(profile.Inventory.Items),
		Tools = tools,
		Weight = math.floor(self:GetWeight(player) * 10) / 10,
		Capacity = self:GetCapacity(player),
		Personal = table.clone(profile.PersonalStorage.Items),
		PersonalCapacity = self:GetPersonalStorageCapacity(player),
	})
end

return InventoryService
