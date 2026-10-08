--[[
	BuildingService
	Gives the map's buildings functionality. Tag a Model/Part "KingdomBuilding"
	and set BuildingType, Department, Health, Enabled, Outdoor.

	Condition (0..100, attribute "Condition") degrades every in-game hour and
	in storms/events. Bands (BuildingConfig.Bands) control efficiency:
	  mine damaged       -> mining yields fall
	  warehouse damaged  -> storage capacity falls
	  kitchen failing    -> food production slows
	  0% (Disabled)      -> stations inside stop working
	Builders repair buildings with a Hammer and materials from storage.
]]

local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local BuildingConfig = require(ReplicatedStorage.Kingdom.Config.BuildingConfig)
local JobConfig = require(ReplicatedStorage.Kingdom.Config.JobConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local PromptUtil = require(script.Parent.Parent.Core.PromptUtil)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local BuildingService = {
	Name = "BuildingService",
	Dependencies = {
		"ResourceService",
		"TimeService",
		"StateService",
		"NotificationService",
		"PermissionService",
		"InventoryService",
		"XPService",
		"EconomyService",
		"WeatherService",
		"AuditService",
		"ActivityService",
		"DataService",
	},
}

local TAG = "KingdomBuilding"

function BuildingService:Init()
	self._resources = self:Use("ResourceService")
	self._time = self:Use("TimeService")
	self._state = self:Use("StateService")
	self._notify = self:Use("NotificationService")
	self._permission = self:Use("PermissionService")
	self._inventory = self:Use("InventoryService")
	self._xp = self:Use("XPService")
	self._economy = self:Use("EconomyService")
	self._weather = self:Use("WeatherService")
	self._audit = self:Use("AuditService")
	self._activity = self:Use("ActivityService")
	self._data = self:Use("DataService")

	self.Repaired = Signal.new("BuildingRepaired") -- (player, instance)
	self.ConditionChanged = Signal.new("BuildingConditionChanged") -- (instance, condition, band)
	self._buildings = {}
	self._byName = {}
	self._cooldowns = {}
	self._dirty = true

	for _, instance in ipairs(CollectionService:GetTagged(TAG)) do
		self:_add(instance)
	end
	CollectionService:GetInstanceAddedSignal(TAG):Connect(function(instance)
		self:_add(instance)
	end)
	CollectionService:GetInstanceRemovedSignal(TAG):Connect(function(instance)
		local record = self._buildings[instance]
		if record then
			self._byName[instance.Name] = nil
			self._buildings[instance] = nil
		end
	end)

	self._resources:RegisterCapacityModifier("BuildingCondition", function(marker)
		local building = self:FindBuilding(marker)
		return building and self:GetBand(building).Storage or 1
	end)

	self._time.HourChanged:Connect(function()
		self:_hourly()
	end)
end

function BuildingService:Start()
	self.Registry:Every(self.Name, "publish", 5, function()
		if self._dirty then
			self._dirty = false
			self:_publish()
		end
	end)
end

function BuildingService:_add(instance: Instance)
	if self._buildings[instance] then
		return
	end
	local buildingType = ZoneUtil.readAttribute(instance, "BuildingType", "Other")
	local typeDef = BuildingConfig.Types[buildingType] or BuildingConfig.Types.Other
	local record = {
		instance = instance,
		type = buildingType,
		department = ZoneUtil.readAttribute(instance, "Department", typeDef.Department),
		condition = math.clamp(ZoneUtil.readAttribute(instance, "Health", 100), 0, 100),
		outdoor = ZoneUtil.readAttribute(instance, "Outdoor", true),
	}
	self._buildings[instance] = record
	self._byName[instance.Name] = instance
	instance:SetAttribute("Condition", record.condition)
	self:_createRepairPrompt(record)
	self._dirty = true
end

-- Bands ------------------------------------------------------------------------

function BuildingService.BandFor(condition: number)
	for _, band in ipairs(BuildingConfig.Bands) do
		if condition >= band.Min then
			return band
		end
	end
	return BuildingConfig.Bands[#BuildingConfig.Bands]
end

function BuildingService:GetBand(instance: Instance)
	local record = self._buildings[instance]
	if not record then
		return BuildingConfig.Bands[1]
	end
	if instance:GetAttribute("Enabled") == false then
		return BuildingConfig.Bands[#BuildingConfig.Bands]
	end
	return BuildingService.BandFor(record.condition)
end

-- The building a station belongs to: tagged ancestor, or Building attribute.
function BuildingService:FindBuilding(instance: Instance): Instance?
	if self._buildings[instance] then
		return instance
	end
	local ancestor = ZoneUtil.findTaggedAncestor(instance, TAG)
	if ancestor then
		return ancestor
	end
	local name = instance:GetAttribute("Building")
	if type(name) == "string" then
		return self._byName[name]
	end
	return nil
end

-- Efficiency multiplier for a station (1 if not inside a building).
function BuildingService:GetEfficiencyFor(instance: Instance): number
	local building = self:FindBuilding(instance)
	return building and self:GetBand(building).Efficiency or 1
end

function BuildingService:IsDisabledFor(instance: Instance): boolean
	return self:GetEfficiencyFor(instance) <= 0
end

function BuildingService:GetDepartmentEfficiency(departmentId: string): number
	local sum, count = 0, 0
	for instance, record in pairs(self._buildings) do
		if record.department == departmentId then
			sum += self:GetBand(instance).Efficiency
			count += 1
		end
	end
	return count > 0 and sum / count or 1
end

function BuildingService:CountOfType(buildingType: string, minCondition: number?): number
	local count = 0
	for _, record in pairs(self._buildings) do
		if record.type == buildingType and record.condition > (minCondition or 0) then
			count += 1
		end
	end
	return count
end

function BuildingService:GetAll()
	local list = {}
	for instance, record in pairs(self._buildings) do
		table.insert(list, { instance = instance, record = record })
	end
	return list
end

-- Condition changes ---------------------------------------------------------------

function BuildingService:SetCondition(instance: Instance, condition: number, reason: string)
	local record = self._buildings[instance]
	if not record then
		return
	end
	local oldBand = BuildingService.BandFor(record.condition)
	record.condition = math.clamp(condition, 0, 100)
	instance:SetAttribute("Condition", math.floor(record.condition + 0.5))
	local newBand = BuildingService.BandFor(record.condition)
	self._dirty = true
	if oldBand.Name ~= newBand.Name then
		self._audit:Log("System", "BuildingBand", { building = instance.Name, band = newBand.Name, reason = reason })
		if newBand.Min < oldBand.Min and (newBand.Name == "Critical" or newBand.Name == "Disabled") then
			self._notify:Broadcast(
				"Warning",
				instance.Name .. " is " .. newBand.Name,
				newBand.Name == "Disabled" and "It no longer functions. Builders must repair it." or "Repairs are needed soon."
			)
		end
		self.ConditionChanged:Fire(instance, record.condition, newBand.Name)
	end
end

function BuildingService:Damage(instance: Instance, amount: number, reason: string)
	local record = self._buildings[instance]
	if record then
		self:SetCondition(instance, record.condition - amount, reason)
	end
end

function BuildingService:DamageType(buildingType: string, amount: number, reason: string)
	for instance, record in pairs(self._buildings) do
		if record.type == buildingType then
			self:Damage(instance, amount, reason)
		end
	end
end

function BuildingService:DamageAll(amount: number, reason: string)
	for instance in pairs(self._buildings) do
		self:Damage(instance, amount, reason)
	end
end

function BuildingService:RepairAll(amount: number, reason: string)
	for instance, record in pairs(self._buildings) do
		self:SetCondition(instance, record.condition + amount, reason)
	end
end

function BuildingService:_hourly()
	local stormDamage = self._weather:GetBuildingDamagePerHour()
	for instance, record in pairs(self._buildings) do
		local typeDef = BuildingConfig.Types[record.type] or BuildingConfig.Types.Other
		local decay = typeDef.DecayPerGameHour
		local floor = BuildingConfig.NaturalDecayFloor
		local target = record.condition
		if target > floor then
			target = math.max(floor, target - decay)
		end
		if stormDamage > 0 and record.outdoor ~= false then
			target -= stormDamage
		end
		if target ~= record.condition then
			self:SetCondition(instance, target, "Decay")
		end
	end
end

-- Repairs ---------------------------------------------------------------------------

function BuildingService:_createRepairPrompt(record)
	local repair = BuildingConfig.Repair
	local parent = record.instance:IsA("BasePart") and record.instance or PromptUtil.anchorFor(record.instance)
	local prompt = PromptUtil.create(parent, {
		Name = "KingdomRepair",
		ActionText = "Repair",
		ObjectText = record.instance.Name,
		HoldDuration = repair.Duration,
		MaxDistance = 14,
		Permission = repair.Permission,
		KeyCode = Enum.KeyCode.R,
	})
	local function refresh()
		prompt.Enabled = record.condition < 100
		prompt.ObjectText = string.format("%s (%d%%)", record.instance.Name, math.floor(record.condition))
	end
	refresh()
	record.instance:GetAttributeChangedSignal("Condition"):Connect(refresh)
	PromptUtil.onTriggered(prompt, function(player, held)
		local ok, message = self:_repair(player, record, held)
		if message then
			self._notify:Notify(player, ok and "Job" or "Warning", ok and "Repaired" or "Cannot repair", message)
		end
	end)
end

function BuildingService:_repair(player: Player, record, held: number)
	local repair = BuildingConfig.Repair
	if not self._data:IsLoaded(player) or not ZoneUtil.isAlive(player) then
		return false, nil
	end
	if not self._permission:Has(player, repair.Permission) then
		return false, "Only workers trusted with advanced jobs can repair buildings."
	end
	if not PromptUtil.heldLongEnough(held, repair.Duration, JobConfig.Session.HoldTolerance) then
		return false, nil
	end
	if record.condition >= 100 then
		return false, "This building is already in excellent condition."
	end
	local anchor = record.instance:IsA("BasePart") and record.instance or PromptUtil.anchorFor(record.instance)
	if ZoneUtil.playerDistance(player, anchor) > JobConfig.Session.MaxInteractDistance + 6 then
		return false, "Get closer to the building."
	end
	local last = self._cooldowns[player]
	if last and os.clock() - last < repair.Cooldown then
		return false, nil
	end
	if not self._resources:Has(repair.Materials) then
		return false, "Storage lacks the materials (wood and stone) for repairs."
	end
	local toolOk, efficiency, reason = self._inventory:UseTool(player, repair.Tool)
	if not toolOk then
		return false, reason
	end
	if not self._resources:WithdrawMany(repair.Materials, "Repair:" .. record.instance.Name, player) then
		return false, "Storage lacks the materials for repairs."
	end
	self._cooldowns[player] = os.clock()
	self._activity:MarkTask(player, ZoneUtil.getPosition(anchor))
	self:SetCondition(record.instance, record.condition + repair.ConditionPerRepair * math.max(efficiency, 0.5), "Repair")
	local xp = self._xp:Award(player, "Job", repair.XP, { source = "Job:Repair", jobId = "Repair" })
	local coins = self._economy:PayWage(player, repair.Wage, "Wage:Repair")
	self.Repaired:Fire(player, record.instance)
	return true, string.format("+%d XP, +%d coins. %s is now %d%%.", xp, coins, record.instance.Name, math.floor(record.condition))
end

function BuildingService:_publish()
	local list = {}
	for instance, record in pairs(self._buildings) do
		table.insert(list, {
			Name = instance.Name,
			Type = record.type,
			Department = record.department,
			Condition = math.floor(record.condition),
			Band = self:GetBand(instance).Name,
		})
	end
	table.sort(list, function(a, b)
		return a.Condition < b.Condition
	end)
	self._state:SetGlobal("Buildings", list)
end

return BuildingService
