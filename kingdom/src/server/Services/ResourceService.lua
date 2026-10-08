--[[
	ResourceService
	The kingdom's stored resources (per server instance: "local production").

	Storage is physical: KingdomStorage / KingdomWarehouse markers declare
	StorageType (comma list allowed) and Capacity. Capacity is scaled by the
	condition of the building the marker sits in (BuildingService registers a
	modifier), so a damaged warehouse really holds less.

	Food and other perishables decay every in-game hour (ResourceConfig
	DecayRate). Warehouse audits temporarily slow decay for a storage type.

	All updates are batched: clients get one replicated snapshot every few
	seconds, never per change.
]]

local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local ResourceService = {
	Name = "ResourceService",
	Dependencies = { "TimeService", "AuditService", "StateService" },
}

local STORAGE_TAGS = { "KingdomStorage", "KingdomWarehouse" }

function ResourceService:Init()
	self._time = self:Use("TimeService")
	self._audit = self:Use("AuditService")
	self._state = self:Use("StateService")

	self.Deposited = Signal.new("ResourceDeposited") -- (resourceId, amount, source, player?)
	self.Withdrawn = Signal.new("ResourceWithdrawn") -- (resourceId, amount, reason, player?)

	self._stock = {}
	self._markers = {}
	self._capacityModifiers = {}
	self._decayModifiers = {} -- [storageType] = { multiplier, untilMinute }
	self._flow = { current = {}, previous = {} }
	self._dirty = true

	for resourceId, amount in pairs(ResourceConfig.StartingStock) do
		if ResourceConfig.Resources[resourceId] then
			self._stock[resourceId] = amount
		end
	end

	for _, tag in ipairs(STORAGE_TAGS) do
		for _, marker in ipairs(CollectionService:GetTagged(tag)) do
			self:_addMarker(marker)
		end
		CollectionService:GetInstanceAddedSignal(tag):Connect(function(marker)
			self:_addMarker(marker)
		end)
		CollectionService:GetInstanceRemovedSignal(tag):Connect(function(marker)
			self._markers[marker] = nil
			self._dirty = true
		end)
	end

	self._time.HourChanged:Connect(function()
		self:_decay()
		self._flow.previous = self._flow.current
		self._flow.current = {}
		self._dirty = true
	end)
end

function ResourceService:Start()
	if not next(self._markers) then
		self.Log:Warn("No KingdomStorage markers found: using virtual storage (%d per type).", ResourceConfig.VirtualStorageCapacity)
	end
	self.Registry:Every(self.Name, "replicate", ResourceConfig.ReplicateSeconds, function()
		if self._dirty then
			self._dirty = false
			self:_publish()
		end
	end)
end

local function parseTypes(value): { string }
	local types = {}
	if type(value) == "string" then
		for part in string.gmatch(value, "[^,%s]+") do
			if ResourceConfig.StorageTypes[part] then
				table.insert(types, part)
			end
		end
	end
	return types
end

function ResourceService:_addMarker(marker: Instance)
	local types = parseTypes(marker:GetAttribute("StorageType"))
	if #types == 0 then
		types = { "General" }
	end
	local capacity = marker:GetAttribute("Capacity")
	self._markers[marker] = {
		types = types,
		capacity = type(capacity) == "number" and capacity or nil,
	}
	self._dirty = true
end

-- Capacity -------------------------------------------------------------------

function ResourceService:RegisterCapacityModifier(name: string, fn: (Instance) -> number)
	self._capacityModifiers[name] = fn
end

function ResourceService:_markerCapacity(marker: Instance, info, storageType: string): number
	local base = info.capacity or ResourceConfig.StorageTypes[storageType].DefaultCapacity
	base /= #info.types -- a multi-type store splits its space
	local multiplier = 1
	for _, fn in pairs(self._capacityModifiers) do
		local ok, value = pcall(fn, marker)
		if ok and type(value) == "number" then
			multiplier *= value
		end
	end
	if marker:GetAttribute("Enabled") == false then
		multiplier = 0
	end
	return base * multiplier
end

function ResourceService:GetCapacity(storageType: string): number
	local total, found = 0, false
	for marker, info in pairs(self._markers) do
		if table.find(info.types, storageType) then
			found = true
			total += self:_markerCapacity(marker, info, storageType)
		end
	end
	if not found then
		return ResourceConfig.VirtualStorageCapacity
	end
	return math.floor(total)
end

function ResourceService:GetUsed(storageType: string): number
	local used = 0
	for resourceId, amount in pairs(self._stock) do
		local def = ResourceConfig.Resources[resourceId]
		if def and def.StorageType == storageType then
			used += amount
		end
	end
	return used
end

function ResourceService:FreeSpaceFor(resourceId: string): number
	local def = ResourceConfig.Resources[resourceId]
	if not def then
		return 0
	end
	return math.max(0, self:GetCapacity(def.StorageType) - self:GetUsed(def.StorageType))
end

-- Stock ------------------------------------------------------------------------

function ResourceService:GetStock(resourceId: string): number
	return self._stock[resourceId] or 0
end

function ResourceService:GetAllStock(): { [string]: number }
	return table.clone(self._stock)
end

function ResourceService:Has(items: { [string]: number }): boolean
	for resourceId, amount in pairs(items) do
		if self:GetStock(resourceId) < amount then
			return false
		end
	end
	return true
end

local function track(flow, resourceId: string, field: string, amount: number)
	local entry = flow.current[resourceId]
	if not entry then
		entry = { produced = 0, consumed = 0 }
		flow.current[resourceId] = entry
	end
	entry[field] += amount
end

-- Returns the amount accepted (bounded by storage space).
function ResourceService:Deposit(resourceId: string, amount: number, source: string, player: Player?): number
	if not ResourceConfig.Resources[resourceId] or amount <= 0 then
		return 0
	end
	local accepted = math.min(math.floor(amount), self:FreeSpaceFor(resourceId))
	if accepted <= 0 then
		return 0
	end
	self._stock[resourceId] = self:GetStock(resourceId) + accepted
	track(self._flow, resourceId, "produced", accepted)
	self._dirty = true
	self._audit:Log("Resource", "Deposit", { resource = resourceId, amount = accepted, source = source, userId = player and player.UserId })
	self.Deposited:Fire(resourceId, accepted, source, player)
	return accepted
end

-- Takes up to amount. Returns amount taken.
function ResourceService:Withdraw(resourceId: string, amount: number, reason: string, player: Player?): number
	local have = self:GetStock(resourceId)
	local taken = math.min(math.floor(amount), have)
	if taken <= 0 then
		return 0
	end
	self._stock[resourceId] = have - taken
	track(self._flow, resourceId, "consumed", taken)
	self._dirty = true
	self._audit:Log("Resource", "Withdraw", { resource = resourceId, amount = taken, reason = reason, userId = player and player.UserId })
	self.Withdrawn:Fire(resourceId, taken, reason, player)
	return taken
end

-- All-or-nothing.
function ResourceService:WithdrawMany(items: { [string]: number }, reason: string, player: Player?): boolean
	if not self:Has(items) then
		return false
	end
	for resourceId, amount in pairs(items) do
		self:Withdraw(resourceId, amount, reason, player)
	end
	return true
end

-- Removes a fraction of matching resources (bandits, spoilage events).
function ResourceService:Destroy(resourceId: string, amount: number, reason: string): number
	local taken = self:Withdraw(resourceId, amount, reason)
	self._audit:Log("Resource", "Destroyed", { resource = resourceId, amount = taken, reason = reason })
	return taken
end

function ResourceService:SetStock(resourceId: string, amount: number, reason: string)
	if not ResourceConfig.Resources[resourceId] then
		return
	end
	self._stock[resourceId] = math.max(0, math.floor(amount))
	self._dirty = true
	self._audit:Log("Resource", "SetStock", { resource = resourceId, amount = amount, reason = reason })
end

function ResourceService:ResetToStarting(reason: string)
	self._stock = {}
	for resourceId, amount in pairs(ResourceConfig.StartingStock) do
		self._stock[resourceId] = amount
	end
	self._dirty = true
	self._audit:Log("Resource", "Reset", { reason = reason })
end

-- Sum of nutrition stored (food need).
function ResourceService:GetNutritionStock(): number
	local total = 0
	for resourceId, amount in pairs(self._stock) do
		local def = ResourceConfig.Resources[resourceId]
		if def and def.Category == "Food" and def.Nutrition then
			total += def.Nutrition * amount
		end
	end
	return total
end

function ResourceService:GetCategoryStock(category: string): number
	local total = 0
	for resourceId, amount in pairs(self._stock) do
		local def = ResourceConfig.Resources[resourceId]
		if def and def.Category == category then
			total += amount
		end
	end
	return total
end

-- Decay --------------------------------------------------------------------------

function ResourceService:SetDecayModifier(storageType: string, multiplier: number, untilAbsoluteMinute: number)
	self._decayModifiers[storageType] = { multiplier = multiplier, untilMinute = untilAbsoluteMinute }
end

function ResourceService:_decay()
	local nowMinute = self._time:GetAbsoluteMinutes()
	for resourceId, amount in pairs(self._stock) do
		local def = ResourceConfig.Resources[resourceId]
		local rate = def and def.DecayRate or 0
		if rate > 0 and amount > 0 then
			local modifier = self._decayModifiers[def.StorageType]
			if modifier and modifier.untilMinute > nowMinute then
				rate *= modifier.multiplier
			end
			local expected = amount * rate
			local lost = math.floor(expected)
			if math.random() < expected - lost then
				lost += 1
			end
			if lost > 0 then
				self._stock[resourceId] = amount - lost
				track(self._flow, resourceId, "consumed", lost)
				self._audit:Log("Resource", "Spoiled", { resource = resourceId, amount = lost })
			end
		end
	end
	self._dirty = true
end

-- Location helpers --------------------------------------------------------------

-- Storage markers within reach of the player that accept the resource type.
function ResourceService:FindStorageNear(player: Player, storageType: string?, maxDistance: number?): Instance?
	maxDistance = maxDistance or 14
	local best, bestDistance = nil, math.huge
	for marker, info in pairs(self._markers) do
		if not storageType or table.find(info.types, storageType) then
			local distance = ZoneUtil.playerDistance(player, marker)
			if distance <= maxDistance and distance < bestDistance then
				best, bestDistance = marker, distance
			end
		end
	end
	return best
end

function ResourceService:GetMarkerTypes(marker: Instance): { string }
	local info = self._markers[marker]
	return info and info.types or {}
end

function ResourceService:HasPhysicalStorage(): boolean
	return next(self._markers) ~= nil
end

-- Replication -------------------------------------------------------------------

function ResourceService:_publish()
	local capacity, used = {}, {}
	for storageType in pairs(ResourceConfig.StorageTypes) do
		capacity[storageType] = self:GetCapacity(storageType)
		used[storageType] = self:GetUsed(storageType)
	end
	local flow = {}
	for resourceId, entry in pairs(self._flow.previous) do
		flow[resourceId] = { P = entry.produced, C = entry.consumed }
	end
	self._state:SetGlobal("Resources", {
		Stock = table.clone(self._stock),
		Capacity = capacity,
		Used = used,
		LastHour = flow,
	})
end

return ResourceService
