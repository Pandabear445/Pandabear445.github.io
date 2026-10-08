--[[
	DepartmentService
	Departments group the kingdom's jobs (Agriculture, Mining, Military...).
	For each department it tracks:
	  Required workers  (scales with online population)
	  Assigned          (players who joined / were assigned)
	  Active            (anyone who did the department's work recently)
	  Inactive          (assigned but idle)
	  Production        (tasks in the last in-game hour vs target)
	  Efficiency        (building condition x management attention x priority
	                     x strikes) -> multiplies job yields
	  Problems          (understaffed, oversupplied, damaged buildings,
	                     neglected by management...)

	Management must be active: a department not inspected within
	InspectionHours loses efficiency every in-game hour.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DepartmentConfig = require(ReplicatedStorage.Kingdom.Config.DepartmentConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)

local DepartmentService = {
	Name = "DepartmentService",
	Dependencies = {
		"ActivityService",
		"RankService",
		"PermissionService",
		"BuildingService",
		"KingdomService",
		"StateService",
		"DataService",
		"TimeService",
		"NotificationService",
		"AuditService",
	},
}

local PRIORITIES = { Low = true, Normal = true, High = true, Critical = true }

function DepartmentService:Init()
	self._activity = self:Use("ActivityService")
	self._rank = self:Use("RankService")
	self._permission = self:Use("PermissionService")
	self._buildings = self:Use("BuildingService")
	self._kingdom = self:Use("KingdomService")
	self._state = self:Use("StateService")
	self._data = self:Use("DataService")
	self._time = self:Use("TimeService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")

	self.HourlyReport = Signal.new("DepartmentHourlyReport") -- (departmentId, status)
	self.Inspected = Signal.new("DepartmentInspected") -- (player, departmentId)
	self.AssignmentChanged = Signal.new("DepartmentAssignmentChanged") -- (player, departmentId?)

	self._jobToDept = {}
	self._depts = {}
	local startMinute = self._time:GetAbsoluteMinutes()
	for id, def in pairs(DepartmentConfig.Departments) do
		for _, jobId in ipairs(def.Jobs) do
			self._jobToDept[jobId] = id
		end
		self._depts[id] = {
			id = id,
			lastTask = {}, -- [Player] = absolute minute
			tasksThisHour = 0,
			tasksLastHour = 0,
			lastInspection = startMinute,
			inspectedBy = nil,
			priority = "Normal",
			managers = {}, -- [userId] = true
			strikePenalty = 0,
		}
	end
	self._jobToDept.Repair = "Construction"

	self._time.HourChanged:Connect(function()
		for id, dept in pairs(self._depts) do
			dept.tasksLastHour = dept.tasksThisHour
			dept.tasksThisHour = 0
			local ok, status = pcall(self.GetStatus, self, id)
			if ok then
				self.HourlyReport:Fire(id, status)
			end
		end
		self:_publish()
	end)

	Players.PlayerRemoving:Connect(function(player)
		for _, dept in pairs(self._depts) do
			dept.lastTask[player] = nil
			dept.managers[player.UserId] = nil
		end
	end)

	Net.Action("Department", "Join", { rate = 0.5, burst = 2 }, function(player, payload)
		local deptId = Check.key(payload.department, DepartmentConfig.Departments)
		if not deptId then
			return false, "Unknown department."
		end
		self:Assign(player, deptId, nil)
		return true, "You joined " .. DepartmentConfig.Departments[deptId].DisplayName .. "."
	end)
	Net.Action("Department", "Leave", { rate = 0.5, burst = 2 }, function(player)
		self:Assign(player, nil, nil)
		return true, "You left your department."
	end)
end

function DepartmentService:Start()
	self.Registry:Every(self.Name, "publish", 6, function()
		self:_publish()
	end)
end

function DepartmentService:GetDepartmentForJob(jobId: string): string?
	return self._jobToDept[jobId]
end

function DepartmentService:Exists(departmentId: string?): boolean
	return departmentId ~= nil and self._depts[departmentId] ~= nil
end

-- Called by JobService for every completed task.
function DepartmentService:RecordTask(player: Player, jobId: string)
	local deptId = self._jobToDept[jobId]
	local dept = deptId and self._depts[deptId]
	if not dept then
		return
	end
	dept.lastTask[player] = self._time:GetAbsoluteMinutes()
	dept.tasksThisHour += 1
end

function DepartmentService:GetRequiredWorkers(departmentId: string): number
	local def = DepartmentConfig.Departments[departmentId]
	local pop = math.max(#Players:GetPlayers(), DepartmentConfig.MinPopulation)
	return math.max(0, math.ceil(def.BaseWorkers + def.WorkersPerPlayer * pop - 0.25))
end

function DepartmentService:GetAssigned(departmentId: string): { Player }
	local list = {}
	for _, player in ipairs(Players:GetPlayers()) do
		local profile = self._data:Get(player)
		if profile and profile.Department == departmentId then
			table.insert(list, player)
		end
	end
	return list
end

function DepartmentService:GetActiveWorkers(departmentId: string): { Player }
	local dept = self._depts[departmentId]
	local list = {}
	if not dept then
		return list
	end
	local nowMinute = self._time:GetAbsoluteMinutes()
	for player, minute in pairs(dept.lastTask) do
		if player.Parent == Players and nowMinute - minute <= DepartmentConfig.ActiveWindowGameMinutes then
			table.insert(list, player)
		end
	end
	return list
end

function DepartmentService:GetPlayerDepartment(player: Player): string?
	local profile = self._data:Get(player)
	return profile and profile.Department or nil
end

-- Efficiency -----------------------------------------------------------------------

function DepartmentService:_neglectFactor(dept, def): number
	local hoursSince = (self._time:GetAbsoluteMinutes() - dept.lastInspection) / 60
	local overdue = hoursSince - def.InspectionHours
	if overdue <= 0 then
		return 1
	end
	local efficiency = DepartmentConfig.Efficiency
	return math.max(efficiency.MinNeglectMultiplier, 1 - overdue * efficiency.NeglectPenaltyPerHour)
end

function DepartmentService:GetEfficiency(departmentId: string): number
	local dept = self._depts[departmentId]
	local def = DepartmentConfig.Departments[departmentId]
	if not dept or not def then
		return 1
	end
	local efficiency = DepartmentConfig.Efficiency
	local value = self._buildings:GetDepartmentEfficiency(departmentId)
	value *= self:_neglectFactor(dept, def)
	local hoursSince = (self._time:GetAbsoluteMinutes() - dept.lastInspection) / 60
	if dept.inspectedBy and hoursSince <= efficiency.InspectionBoostHours then
		value *= 1 + efficiency.InspectionBoost
	end
	value *= 1 + (efficiency.PriorityBonus[dept.priority] or 0)
	value *= math.max(0.3, 1 - dept.strikePenalty)
	return value
end

function DepartmentService:SetStrikePenalty(departmentId: string?, penalty: number)
	for id, dept in pairs(self._depts) do
		if departmentId == nil or departmentId == id then
			dept.strikePenalty = math.clamp(penalty, 0, 0.7)
		end
	end
end

-- Management actions -----------------------------------------------------------------

function DepartmentService:Assign(player: Player, departmentId: string?, by: Player?)
	local profile = self._data:Get(player)
	if not profile then
		return false
	end
	if departmentId and not self._depts[departmentId] then
		return false
	end
	profile.Department = departmentId
	player:SetAttribute("KingdomDepartment", departmentId or "")
	self._state:Set(player, "Department", departmentId)
	self._audit:Log("Management", "Assign", { userId = player.UserId, department = departmentId, by = by and by.UserId })
	if by and departmentId then
		self._notify:Notify(
			player,
			"Job",
			"New assignment",
			string.format("%s assigned you to %s.", by.DisplayName, DepartmentConfig.Departments[departmentId].DisplayName)
		)
	end
	self.AssignmentChanged:Fire(player, departmentId)
	return true
end

function DepartmentService:RecordInspection(player: Player, departmentId: string)
	local dept = self._depts[departmentId]
	if not dept then
		return
	end
	dept.lastInspection = self._time:GetAbsoluteMinutes()
	dept.inspectedBy = player.UserId
	self._audit:Log("Management", "Inspection", { userId = player.UserId, department = departmentId })
	self.Inspected:Fire(player, departmentId)
end

function DepartmentService:SetPriority(departmentId: string, priority: string, by: Player?)
	local dept = self._depts[departmentId]
	if not dept or not PRIORITIES[priority] then
		return false
	end
	dept.priority = priority
	self._audit:Log("Management", "Priority", { department = departmentId, priority = priority, by = by and by.UserId })
	return true
end

function DepartmentService:SetManager(departmentId: string, player: Player, managing: boolean)
	local dept = self._depts[departmentId]
	if not dept then
		return false
	end
	dept.managers[player.UserId] = managing or nil
	player:SetAttribute("KingdomManagesDepartment", managing and departmentId or "")
	return true
end

function DepartmentService:GetManagers(departmentId: string): { Player }
	local dept = self._depts[departmentId]
	local list = {}
	if dept then
		for userId in pairs(dept.managers) do
			local player = Players:GetPlayerByUserId(userId)
			if player then
				table.insert(list, player)
			end
		end
	end
	return list
end

-- Status -------------------------------------------------------------------------------

function DepartmentService:GetStatus(departmentId: string)
	local dept = self._depts[departmentId]
	local def = DepartmentConfig.Departments[departmentId]
	if not dept or not def then
		return nil
	end
	local required = self:GetRequiredWorkers(departmentId)
	local assigned = self:GetAssigned(departmentId)
	local active = self:GetActiveWorkers(departmentId)
	local activeSet = {}
	for _, player in ipairs(active) do
		activeSet[player] = true
	end
	local inactive = 0
	for _, player in ipairs(assigned) do
		if not activeSet[player] then
			inactive += 1
		end
	end
	local staff = math.max(#active, 1)
	local target = def.ProductionTarget * math.max(required, 1)
	local production = target > 0 and dept.tasksLastHour / target or 1
	local efficiency = self:GetEfficiency(departmentId)

	local problems = {}
	if #active < required then
		table.insert(problems, string.format("Understaffed: %d of %d workers active", #active, required))
	end
	if required > 0 and #active > required * DepartmentConfig.OversupplyFactor then
		table.insert(problems, "Oversupplied: workers are needed elsewhere")
	end
	if self._buildings:GetDepartmentEfficiency(departmentId) < 0.75 then
		table.insert(problems, "Buildings damaged: repairs needed")
	end
	if self:_neglectFactor(dept, def) < 1 then
		table.insert(problems, "Neglected: no manager has inspected recently")
	end
	if dept.strikePenalty > 0 then
		table.insert(problems, "Workers are on strike")
	end
	if production < 0.5 and required > 0 then
		table.insert(problems, "Production far below target")
	end

	local managers = {}
	for _, player in ipairs(self:GetManagers(departmentId)) do
		table.insert(managers, player.DisplayName)
	end

	return {
		Id = departmentId,
		Name = def.DisplayName,
		Icon = def.Icon,
		Required = required,
		Assigned = #assigned,
		Active = #active,
		Inactive = inactive,
		TasksLastHour = dept.tasksLastHour,
		TasksThisHour = dept.tasksThisHour,
		ProductionTarget = target,
		Production = production,
		Efficiency = efficiency,
		Morale = math.clamp(self._kingdom:GetMorale() * (0.7 + 0.3 * efficiency), 0, 100),
		Priority = dept.priority,
		Managers = managers,
		MinutesSinceInspection = math.floor(self._time:GetAbsoluteMinutes() - dept.lastInspection),
		Problems = problems,
		StaffPerTask = staff,
	}
end

function DepartmentService:GetAllStatus()
	local list = {}
	for id in pairs(self._depts) do
		local status = self:GetStatus(id)
		if status then
			table.insert(list, status)
		end
	end
	table.sort(list, function(a, b)
		return a.Name < b.Name
	end)
	return list
end

function DepartmentService:_publish()
	local summary = {}
	for _, status in ipairs(self:GetAllStatus()) do
		table.insert(summary, {
			Id = status.Id,
			Name = status.Name,
			Icon = status.Icon,
			Required = status.Required,
			Active = status.Active,
			Production = status.Production,
			Efficiency = status.Efficiency,
			Problems = #status.Problems,
			Priority = status.Priority,
		})
	end
	self._state:SetGlobal("Departments", summary)
end

return DepartmentService
