--[[
	ManagementService
	Higher ranks get real responsibilities, and earn Management XP only from
	OUTCOMES, never from clicking "assign":

	  Work orders     create objectives ("Deliver 50 Wheat", "20 Mining tasks")
	                  with workers, priority, reward and deadline. Workers
	                  accept; progress comes from real deliveries/tasks. The
	                  manager earns XP only if it completes on time with at
	                  least MinDistinctContributors workers (not themselves).
	  Inspections     managers must visit their departments in person
	                  (KingdomInspectionPoint or the department's buildings).
	                  Uninspected departments lose efficiency.
	  Department XP   hourly: inspected departments that meet production
	                  targets pay their managers.
	  Crisis XP       managers active when the kingdom climbs out of a
	                  critical stage are rewarded.
	  Projects        approving a construction project pays only when built.
	  Assign workers, set priorities, request replacements, appoint
	  department managers, view dashboards scaled to rank.
]]

local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DepartmentConfig = require(ReplicatedStorage.Kingdom.Config.DepartmentConfig)
local JobConfig = require(ReplicatedStorage.Kingdom.Config.JobConfig)
local KingdomConfig = require(ReplicatedStorage.Kingdom.Config.KingdomConfig)
local PermissionConfig = require(ReplicatedStorage.Kingdom.Config.PermissionConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)
local PromptUtil = require(script.Parent.Parent.Core.PromptUtil)
local RateLimiter = require(script.Parent.Parent.Core.RateLimiter)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local ManagementService = {
	Name = "ManagementService",
	Dependencies = {
		"DepartmentService",
		"JobService",
		"RankService",
		"PermissionService",
		"XPService",
		"EconomyService",
		"NotificationService",
		"AuditService",
		"TimeService",
		"ActivityService",
		"ResourceService",
		"DataService",
		"StateService",
		"KingdomService",
		"FoodService",
		"BuildingService",
	},
}

local LIMITS = {
	MaxActiveOrdersPerManager = 3,
	MaxRewardXP = 400,
	RewardXPPerUnit = 8,
	MinTarget = 5,
	MaxTarget = 500,
	MaxDeadlineHours = 8,
	MinDistinctContributors = 2,
	ManagerBaseXP = 40,
	ManagerPriorityBonus = { Low = 0, Normal = 10, High = 25, Critical = 40 },
	DepartmentTargetXP = 25,
	DepartmentXPPerActive = 5,
	DepartmentXPCap = 90,
	CrisisPreventedXP = 120,
	ProjectApprovalXP = 80,
	InspectionDistance = 20,
}

local INSPECTION_TAG = "KingdomInspectionPoint"

function ManagementService:Init()
	self._depts = self:Use("DepartmentService")
	self._jobs = self:Use("JobService")
	self._rank = self:Use("RankService")
	self._permission = self:Use("PermissionService")
	self._xp = self:Use("XPService")
	self._economy = self:Use("EconomyService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")
	self._time = self:Use("TimeService")
	self._activity = self:Use("ActivityService")
	self._resources = self:Use("ResourceService")
	self._data = self:Use("DataService")
	self._state = self:Use("StateService")
	self._kingdom = self:Use("KingdomService")
	self._food = self:Use("FoodService")
	self._buildings = self:Use("BuildingService")

	self.OrderCompleted = Signal.new("WorkOrderCompleted") -- (order)
	self._orders = {}
	self._accepted = {} -- [Player] = orderId
	self._inspections = {} -- [deptId] = { [userId] = absoluteMinute }
	self._staffLimiter = RateLimiter.new(1 / 120, 1)

	self._jobs:SetOrdersProvider(function(player, jobId)
		local order = self._orders[self._accepted[player] or ""]
		if not order then
			return false
		end
		local objective = order.objective
		if objective.type == "Tasks" then
			return objective.job == jobId
		end
		return self._depts:GetDepartmentForJob(jobId) == order.department
	end)

	self._jobs.TaskCompleted:Connect(function(player, jobId, result)
		self:_onTask(player, jobId, result)
	end)
	self._resources.Deposited:Connect(function(resourceId, amount, source, player)
		if player and source == "Delivery" then
			self:_onDelivery(player, resourceId, amount)
		end
	end)
	self._depts.HourlyReport:Connect(function(deptId, status)
		self:_hourlyOutcome(deptId, status)
	end)
	self._kingdom.StageChanged:Connect(function(newStage, oldStage)
		self:_stageOutcome(newStage, oldStage)
	end)
	self._jobs.StationEvent:Connect(function(kind, _, data)
		if kind == "ProjectCompleted" and data.ApprovedBy then
			self:_projectOutcome(data)
		end
	end)
	self._time.MinuteChanged:Connect(function()
		self:_checkDeadlines()
	end)
	self:_registerRemotes()
end

function ManagementService:Start()
	local function setup(marker: Instance)
		if marker:GetAttribute("KingdomInspectReady") then
			return
		end
		marker:SetAttribute("KingdomInspectReady", true)
		local deptId = marker:GetAttribute("Department")
		if type(deptId) ~= "string" or not DepartmentConfig.Departments[deptId] then
			self.Log:Warn("Inspection point %s needs a valid Department attribute", marker:GetFullName())
			return
		end
		local parent = ZoneUtil.getPromptParent(marker) or PromptUtil.anchorFor(marker)
		local prompt = PromptUtil.create(parent, {
			Name = "KingdomInspect",
			ActionText = "Inspect department",
			ObjectText = DepartmentConfig.Departments[deptId].DisplayName,
			HoldDuration = 3,
			MaxDistance = 12,
			Permission = "Manage.Inspect",
			KeyCode = Enum.KeyCode.T,
		})
		PromptUtil.onTriggered(prompt, function(player, held)
			if PromptUtil.heldLongEnough(held, 3, JobConfig.Session.HoldTolerance) then
				local ok, message = self:Inspect(player, deptId, marker)
				self._notify:Notify(player, ok and "Success" or "Warning", "Inspection", message)
			end
		end)
	end
	for _, marker in ipairs(CollectionService:GetTagged(INSPECTION_TAG)) do
		setup(marker)
	end
	CollectionService:GetInstanceAddedSignal(INSPECTION_TAG):Connect(setup)
	-- Departments without inspection points can be inspected at their buildings.
	for _, entry in ipairs(self._buildings:GetAll()) do
		local deptId = entry.record.department
		local hasPoint = false
		for _, marker in ipairs(CollectionService:GetTagged(INSPECTION_TAG)) do
			if marker:GetAttribute("Department") == deptId then
				hasPoint = true
				break
			end
		end
		if not hasPoint and DepartmentConfig.Departments[deptId] then
			entry.instance:SetAttribute("Department", deptId)
			setup(entry.instance)
		end
	end
	self.Registry:Every(self.Name, "publishOrders", 3, function()
		self:_publishOrders()
	end)
end

-- Inspections ---------------------------------------------------------------------------

function ManagementService:Inspect(player: Player, deptId: string, marker: Instance)
	if not self._permission:Has(player, "Manage.Inspect") then
		return false, "Only managers can inspect departments."
	end
	if not self._permission:CanManageDepartment(player, deptId) then
		return false, "This department is outside your authority."
	end
	if ZoneUtil.playerDistance(player, marker) > LIMITS.InspectionDistance then
		return false, "Inspect in person."
	end
	local byDept = self._inspections[deptId] or {}
	self._inspections[deptId] = byDept
	local nowMinute = self._time:GetAbsoluteMinutes()
	local last = byDept[player.UserId]
	if last and nowMinute - last < 30 then
		return false, "You inspected this department recently."
	end
	byDept[player.UserId] = nowMinute
	self._depts:RecordInspection(player, deptId)
	self._activity:MarkTask(player, ZoneUtil.getPosition(marker))
	local profile = self._data:Get(player)
	if profile then
		profile.ManagementStats.Inspections += 1
	end
	local status = self._depts:GetStatus(deptId)
	local report = string.format(
		"%s: %d/%d workers active, production %d%%, efficiency %d%%.",
		status.Name,
		status.Active,
		status.Required,
		math.floor(status.Production * 100),
		math.floor(status.Efficiency * 100)
	)
	if #status.Problems > 0 then
		report ..= "\nProblems: " .. table.concat(status.Problems, "; ")
	end
	return true, report
end

function ManagementService:_activeManagersOf(deptId: string): { Player }
	local list = {}
	local byDept = self._inspections[deptId] or {}
	local def = DepartmentConfig.Departments[deptId]
	local nowMinute = self._time:GetAbsoluteMinutes()
	for userId, minute in pairs(byDept) do
		local player = Players:GetPlayerByUserId(userId)
		if player and nowMinute - minute <= def.InspectionHours * 60 and self._permission:CanManageDepartment(player, deptId) then
			table.insert(list, player)
		end
	end
	return list
end

-- Outcome-based Management XP ---------------------------------------------------------------

function ManagementService:_hourlyOutcome(deptId: string, status)
	for _, manager in ipairs(self:_activeManagersOf(deptId)) do
		local profile = self._data:Get(manager)
		if profile then
			profile.ManagementStats.GameHoursManaged += 1
			if status.Production >= 1 and status.Active >= 1 then
				local xp = math.min(LIMITS.DepartmentTargetXP + LIMITS.DepartmentXPPerActive * status.Active, LIMITS.DepartmentXPCap)
				self._xp:Award(manager, "Management", xp, { source = "Department:" .. deptId, ignoreAFK = true })
				profile.ManagementStats.DepartmentTargetsMet += 1
				self._notify:Notify(manager, "Success", status.Name .. " met its target", string.format("+%d Management XP", xp))
			elseif status.Production < 0.5 and status.Required > 0 then
				profile.Reputation.Management = math.max(0, profile.Reputation.Management - 1)
			end
		end
	end
end

function ManagementService:_stageOutcome(newStage: string, oldStage: string)
	local order = {}
	for index, stage in ipairs(KingdomConfig.Stages) do
		order[stage.Id] = index
	end
	order.Recovery = 4.5
	local improved = (order[newStage] or 0) < (order[oldStage] or 0)
	local fromBad = (order[oldStage] or 0) >= 4
	if not (improved and fromBad) then
		return
	end
	local rewarded = {}
	for deptId in pairs(DepartmentConfig.Departments) do
		for _, manager in ipairs(self:_activeManagersOf(deptId)) do
			if not rewarded[manager] then
				rewarded[manager] = true
				self._xp:Award(manager, "Leadership", LIMITS.CrisisPreventedXP, { source = "CrisisPrevented", ignoreAFK = true })
				local profile = self._data:Get(manager)
				if profile then
					profile.ManagementStats.CrisesPrevented += 1
				end
				self._notify:Notify(manager, "Success", "Crisis averted", "Your leadership helped the kingdom recover.")
			end
		end
	end
end

function ManagementService:_projectOutcome(data)
	local manager = Players:GetPlayerByUserId(data.ApprovedBy)
	if not manager then
		return
	end
	self._xp:Award(manager, "Management", LIMITS.ProjectApprovalXP, { source = "Project:" .. data.Name, ignoreAFK = true })
	local profile = self._data:Get(manager)
	if profile then
		profile.Lifetime.ProjectsCompleted += 1
	end
end

-- Work orders ---------------------------------------------------------------------------------

export type OrderSpec = {
	title: string?,
	department: string?,
	objective: string?, -- "Deliver" | "Tasks"
	resource: string?,
	job: string?,
	target: number?,
	workers: number?,
	priority: string?,
	hours: number?,
	rewardXP: number?,
}

function ManagementService:CreateOrder(manager: Player, spec)
	if not self._permission:Has(manager, "Manage.WorkOrders") then
		return false, "Your rank cannot issue work orders."
	end
	local deptId = Check.key(spec.department, DepartmentConfig.Departments)
	if not deptId or not self._permission:CanManageDepartment(manager, deptId) then
		return false, "Choose a department you manage."
	end
	local active = 0
	for _, order in pairs(self._orders) do
		if order.creator == manager.UserId and order.state == "Open" then
			active += 1
		end
	end
	if active >= LIMITS.MaxActiveOrdersPerManager then
		return false, "You already have the maximum number of open orders."
	end
	local target = Check.integer(spec.target, LIMITS.MinTarget, LIMITS.MaxTarget)
	if not target then
		return false, string.format("Target must be %d-%d.", LIMITS.MinTarget, LIMITS.MaxTarget)
	end
	local objective
	if spec.objective == "Deliver" then
		local resourceId = Check.key(spec.resource, ResourceConfig.Resources)
		if not resourceId then
			return false, "Choose a resource."
		end
		objective = { type = "Deliver", resource = resourceId, target = target }
	elseif spec.objective == "Tasks" then
		local jobId = Check.key(spec.job, JobConfig.Jobs)
		if not jobId or self._depts:GetDepartmentForJob(jobId) ~= deptId then
			return false, "Choose a job from that department."
		end
		objective = { type = "Tasks", job = jobId, target = target }
	else
		return false, "Choose an objective."
	end
	local priority = Check.oneOf(spec.priority, { "Low", "Normal", "High", "Critical" }) or "Normal"
	local hours = Check.number(spec.hours, 0.5, LIMITS.MaxDeadlineHours) or 2
	local rewardCap = math.min(LIMITS.MaxRewardXP, target * LIMITS.RewardXPPerUnit)
	local rewardXP = math.clamp(Check.integer(spec.rewardXP, 0, 100000) or rewardCap, 0, rewardCap)
	local title = Check.string(spec.title, 60) or ""
	if title == "" then
		if objective.type == "Deliver" then
			title = string.format("Deliver %d %s", target, ResourceConfig.Resources[objective.resource].DisplayName)
		else
			title = string.format("%d %s tasks", target, JobConfig.Jobs[objective.job].DisplayName)
		end
	end
	local id = HttpService:GenerateGUID(false)
	local order = {
		id = id,
		title = title,
		department = deptId,
		objective = objective,
		progress = 0,
		contributions = {},
		workers = Check.integer(spec.workers, 1, 50) or 3,
		priority = priority,
		rewardXP = rewardXP,
		deadline = self._time:GetAbsoluteMinutes() + hours * 60,
		creator = manager.UserId,
		creatorName = manager.DisplayName,
		state = "Open",
		accepted = {},
	}
	self._orders[id] = order
	local profile = self._data:Get(manager)
	if profile then
		profile.ManagementStats.OrdersCreated += 1
	end
	self._audit:Log("Management", "OrderCreated", { id = id, title = title, by = manager.UserId, reward = rewardXP })
	self._notify:NotifyWhere(function(player)
		return player ~= manager and self._permission:CanManage(manager, player)
	end, "Job", "New work order (" .. priority .. ")", string.format("%s - %s. Reward %d XP.", title, DepartmentConfig.Departments[deptId].DisplayName, rewardXP))
	self:_publishOrders()
	return true, "Work order issued."
end

function ManagementService:AcceptOrder(player: Player, orderId: string?)
	local order = orderId and self._orders[orderId]
	if not order or order.state ~= "Open" then
		return false, "That order is closed."
	end
	if order.creator == player.UserId then
		return false, "You can't work your own order."
	end
	local accepted = 0
	for _ in pairs(order.accepted) do
		accepted += 1
	end
	if accepted >= order.workers then
		return false, "Enough workers have accepted this order."
	end
	if self._accepted[player] then
		local previous = self._orders[self._accepted[player]]
		if previous then
			previous.accepted[player.UserId] = nil
		end
	end
	self._accepted[player] = orderId
	order.accepted[player.UserId] = true
	self._activity:MarkInteraction(player)
	self:_publishOrders()
	return true, "Order accepted: " .. order.title
end

function ManagementService:CancelOrder(player: Player, orderId: string?)
	local order = orderId and self._orders[orderId]
	if not order or order.state ~= "Open" then
		return false, "Not an open order."
	end
	local creator = Players:GetPlayerByUserId(order.creator)
	local allowed = order.creator == player.UserId or (creator and self._permission:CanManage(player, creator))
	if not allowed then
		return false, "Only the issuer or their superior may cancel it."
	end
	self:_closeOrder(order, "Cancelled")
	return true, "Order cancelled."
end

function ManagementService:_contribute(player: Player, order, amount: number)
	order.progress = math.min(order.objective.target, order.progress + amount)
	order.contributions[player.UserId] = (order.contributions[player.UserId] or 0) + amount
	if order.progress >= order.objective.target then
		self:_closeOrder(order, "Completed")
	end
end

function ManagementService:_onTask(player: Player, jobId: string, _)
	local order = self._orders[self._accepted[player] or ""]
	if order and order.state == "Open" and order.objective.type == "Tasks" and order.objective.job == jobId then
		self:_contribute(player, order, 1)
	end
end

function ManagementService:_onDelivery(player: Player, resourceId: string, amount: number)
	local order = self._orders[self._accepted[player] or ""]
	if order and order.state == "Open" and order.objective.type == "Deliver" and order.objective.resource == resourceId then
		self:_contribute(player, order, amount)
	end
end

function ManagementService:_closeOrder(order, state: string)
	order.state = state
	for userId in pairs(order.accepted) do
		local player = Players:GetPlayerByUserId(userId)
		if player and self._accepted[player] == order.id then
			self._accepted[player] = nil
		end
	end
	local creator = Players:GetPlayerByUserId(order.creator)
	local creatorProfile = creator and self._data:Get(creator)
	if state == "Completed" then
		local total = 0
		local distinct = 0
		for _, amount in pairs(order.contributions) do
			total += amount
			distinct += 1
		end
		for userId, amount in pairs(order.contributions) do
			local worker = Players:GetPlayerByUserId(userId)
			if worker and total > 0 and order.rewardXP > 0 then
				local xp = self._xp:Award(worker, "Contribution", order.rewardXP * amount / total, { source = "WorkOrder", ignoreAFK = true })
				self._notify:Notify(worker, "Success", "Work order complete", string.format("%s: +%d XP", order.title, xp))
			end
		end
		if creator and creatorProfile then
			creatorProfile.ManagementStats.OrdersCompleted += 1
			creatorProfile.Reputation.Management = math.min(100, creatorProfile.Reputation.Management + 2)
			if distinct >= LIMITS.MinDistinctContributors then
				local xp = LIMITS.ManagerBaseXP + (LIMITS.ManagerPriorityBonus[order.priority] or 0)
				self._xp:Award(creator, "Management", xp, { source = "WorkOrder", ignoreAFK = true })
				self._notify:Notify(creator, "Success", "Order fulfilled", string.format("%s: +%d Management XP", order.title, xp))
			else
				self._notify:Notify(creator, "Information", "Order fulfilled", "No Management XP: at least two workers must contribute.")
			end
		end
		self.OrderCompleted:Fire(order)
	elseif state == "Failed" and creatorProfile then
		creatorProfile.ManagementStats.OrdersFailed += 1
		creatorProfile.Reputation.Management = math.max(0, creatorProfile.Reputation.Management - 5)
		if creator then
			self._notify:Notify(creator, "Warning", "Work order failed", order.title .. " missed its deadline.")
		end
	end
	self._audit:Log("Management", "Order" .. state, { id = order.id, title = order.title, progress = order.progress })
	task.delay(60, function()
		self._orders[order.id] = nil
	end)
	self:_publishOrders()
end

function ManagementService:_checkDeadlines()
	local nowMinute = self._time:GetAbsoluteMinutes()
	for _, order in pairs(self._orders) do
		if order.state == "Open" and nowMinute >= order.deadline then
			self:_closeOrder(order, "Failed")
		end
	end
end

function ManagementService:_orderView(order, viewer: Player?)
	local accepted = 0
	for _ in pairs(order.accepted) do
		accepted += 1
	end
	return {
		Id = order.id,
		Title = order.title,
		Department = order.department,
		DepartmentName = DepartmentConfig.Departments[order.department].DisplayName,
		Objective = order.objective.type,
		Progress = order.progress,
		Target = order.objective.target,
		Workers = order.workers,
		Accepted = accepted,
		Priority = order.priority,
		RewardXP = order.rewardXP,
		MinutesLeft = math.max(0, math.floor(order.deadline - self._time:GetAbsoluteMinutes())),
		Creator = order.creatorName,
		State = order.state,
		Mine = viewer ~= nil and order.creator == viewer.UserId,
		AcceptedByMe = viewer ~= nil and self._accepted[viewer] == order.id,
	}
end

function ManagementService:GetOrders(viewer: Player)
	local list = {}
	for _, order in pairs(self._orders) do
		table.insert(list, self:_orderView(order, viewer))
	end
	table.sort(list, function(a, b)
		return a.MinutesLeft < b.MinutesLeft
	end)
	return list
end

function ManagementService:_publishOrders()
	for _, player in ipairs(Players:GetPlayers()) do
		local order = self._orders[self._accepted[player] or ""]
		self._state:Set(player, "Objective", order and {
			Title = order.title,
			Progress = order.progress,
			Target = order.objective.target,
			MinutesLeft = math.max(0, math.floor(order.deadline - self._time:GetAbsoluteMinutes())),
		} or nil)
	end
	local open = 0
	for _, order in pairs(self._orders) do
		if order.state == "Open" then
			open += 1
		end
	end
	self._state:SetGlobal("OpenOrders", open)
end

-- Workforce actions ---------------------------------------------------------------------------

function ManagementService:AssignWorker(manager: Player, target: Player?, deptId: string?)
	if not target or not deptId then
		return false, "Choose a worker and department."
	end
	if not self._permission:Has(manager, "Manage.AssignWorkers") then
		return false, "Your rank cannot assign workers."
	end
	if not self._permission:CanManage(manager, target) then
		return false, "That player is not under your authority."
	end
	if not self._permission:CanManageDepartment(manager, deptId) then
		return false, "That department is outside your authority."
	end
	self._depts:Assign(target, deptId, manager)
	return true, string.format("%s assigned to %s.", target.DisplayName, DepartmentConfig.Departments[deptId].DisplayName)
end

function ManagementService:RequestStaff(manager: Player, deptId: string?, count: number?)
	if not deptId or not count then
		return false, "Invalid request."
	end
	if not self._permission:Has(manager, "Manage.RequestReplacement") or not self._permission:CanManageDepartment(manager, deptId) then
		return false, "You cannot request staff for that department."
	end
	if not self._staffLimiter:Check(manager) then
		return false, "You requested staff recently."
	end
	local name = DepartmentConfig.Departments[deptId].DisplayName
	self._notify:NotifyWhere(function(player)
		return player ~= manager and self._permission:CanManage(manager, player)
	end, "Job", name .. " needs workers", string.format("%s requests %d workers. Join the department to work under orders (+%d%% performance).", manager.DisplayName, count, math.floor(JobConfig.Performance.FollowingOrdersBonus * 100)))
	self._audit:Log("Management", "StaffRequest", { by = manager.UserId, department = deptId, count = count })
	return true, "Request sent."
end

function ManagementService:SetPriority(manager: Player, deptId: string?, priority: string?)
	if not deptId or not priority then
		return false, "Invalid request."
	end
	if not self._permission:Has(manager, "Manage.SetPriorities") or not self._permission:CanManageDepartment(manager, deptId) then
		return false, "You cannot set priorities for that department."
	end
	if not self._depts:SetPriority(deptId, priority, manager) then
		return false, "Invalid priority."
	end
	return true, "Priority set."
end

function ManagementService:AppointManager(manager: Player, target: Player?, deptId: string?, appoint: boolean)
	if not target or not deptId then
		return false, "Invalid request."
	end
	if not self._permission:Has(manager, "Manage.Departments") then
		return false, "Your rank cannot appoint department managers."
	end
	if not self._permission:CanManage(manager, target) then
		return false, "That player is not under your authority."
	end
	if appoint and not self._permission:CanManageDepartment(target, deptId) then
		return false, "Their rank cannot manage that department."
	end
	self._depts:SetManager(deptId, target, appoint)
	self._notify:Notify(target, "Government", appoint and "Appointed" or "Relieved", string.format("%s %s you %s %s.", manager.DisplayName, appoint and "appointed" or "relieved", appoint and "manager of" or "from", DepartmentConfig.Departments[deptId].DisplayName))
	self._audit:Log("Management", "AppointManager", { by = manager.UserId, target = target.UserId, department = deptId, appoint = appoint })
	return true, "Done."
end

-- Dashboards ------------------------------------------------------------------------------------

function ManagementService:_workerView(player: Player)
	local profile = self._data:Get(player)
	local performance = self._jobs:GetPerformance(player)
	local jobId = self._jobs:GetCurrentJob(player)
	local root = ZoneUtil.getRoot(player)
	return {
		UserId = player.UserId,
		Name = player.DisplayName,
		Rank = self._rank:GetRankDef(player).DisplayName,
		Department = profile and profile.Department or nil,
		Job = jobId and JobConfig.Jobs[jobId] and JobConfig.Jobs[jobId].DisplayName or "Idle",
		Active = not self._activity:IsAFK(player),
		SecondsSinceTask = performance.SecondsSinceTask,
		Rating = math.floor(performance.Rating * 100) / 100,
		Tier = JobConfig.TierForScore(performance.Rating).Name,
		Mistakes = performance.Mistakes,
		Hunger = math.floor(self._food:GetHunger(player)),
		Sick = self._food:IsSick(player),
		Location = root and string.format("%d, %d", math.floor(root.Position.X), math.floor(root.Position.Z)) or "Unknown",
		Attendance = profile and string.format("%d/%d", profile.Attendance.Attended, profile.Attendance.Attended + profile.Attendance.Missed) or "-",
		Warnings = profile and #profile.Discipline.Warnings or 0,
		Order = self._accepted[player] and self._orders[self._accepted[player]] and self._orders[self._accepted[player]].title or nil,
	}
end

function ManagementService:_managerView(player: Player)
	local profile = self._data:Get(player)
	if not profile then
		return nil
	end
	local stats = profile.ManagementStats
	return {
		Name = player.DisplayName,
		Rank = self._rank:GetRankDef(player).DisplayName,
		Reputation = profile.Reputation.Management,
		OrdersCompleted = stats.OrdersCompleted,
		OrdersFailed = stats.OrdersFailed,
		Inspections = stats.Inspections,
		TargetsMet = stats.DepartmentTargetsMet,
		CrisesPrevented = stats.CrisesPrevented,
		HoursManaged = stats.GameHoursManaged,
		Attendance = string.format("%d/%d", profile.Attendance.Attended, profile.Attendance.Attended + profile.Attendance.Missed),
	}
end

function ManagementService:GetDashboard(player: Player)
	local levels = PermissionConfig.DashboardLevels
	local level = self._permission:GetDashboardLevel(player)
	local dashboard = {
		Level = level,
		Personal = self:_workerView(player),
		Orders = self:GetOrders(player),
	}
	if level >= levels.Security then
		dashboard.Security = {
			Need = self._kingdom:GetNeed("Security"),
			GuardsOnDuty = self._jobs:GetGuardsOnDuty(),
		}
	end
	if level >= levels.Department then
		local departments = {}
		for deptId in pairs(DepartmentConfig.Departments) do
			local visible = self._permission:CanManageDepartment(player, deptId)
			if level >= levels.Regional then
				visible = true
			end
			if visible then
				table.insert(departments, self._depts:GetStatus(deptId))
			end
		end
		table.sort(departments, function(a, b)
			return a.Name < b.Name
		end)
		dashboard.Departments = departments
		local workers = {}
		for _, other in ipairs(Players:GetPlayers()) do
			if other ~= player and self._permission:CanManage(player, other) then
				table.insert(workers, self:_workerView(other))
			end
		end
		dashboard.Workers = workers
	end
	if level >= levels.Kingdom then
		dashboard.Kingdom = self._kingdom:GetSnapshot()
		dashboard.Treasury = {
			Balance = self._economy:GetTreasury(),
			Taxes = self._economy:GetTaxes(),
		}
	end
	if level >= levels.Full then
		local managers = {}
		for _, other in ipairs(Players:GetPlayers()) do
			if (self._rank:GetRankDef(other).ManageDepth or 0) > 0 then
				table.insert(managers, self:_managerView(other))
			end
		end
		dashboard.Managers = managers
	end
	return dashboard
end

-- Leave handling: release assignments and accepted orders, notify managers.
function ManagementService:OnPlayerLeave(player: Player)
	local orderId = self._accepted[player]
	if orderId and self._orders[orderId] then
		self._orders[orderId].accepted[player.UserId] = nil
	end
	self._accepted[player] = nil
	for _, order in pairs(self._orders) do
		if order.creator == player.UserId and order.state == "Open" then
			-- Orders outlive their creator so workers' progress isn't wasted.
			order.creatorName ..= " (away)"
		end
	end
	local deptId = self._depts:GetPlayerDepartment(player)
	if deptId then
		for _, manager in ipairs(self:_activeManagersOf(deptId)) do
			self._notify:Notify(manager, "Information", "Worker left", string.format("%s (%s) has left the kingdom.", player.DisplayName, DepartmentConfig.Departments[deptId].DisplayName))
		end
	end
end

-- Remotes -----------------------------------------------------------------------------------------

local function targetPlayer(value): Player?
	local userId = Check.userId(value)
	return userId and Players:GetPlayerByUserId(userId) or nil
end

function ManagementService:_registerRemotes()
	Net.Query("Dashboard", { rate = 1, burst = 3 }, function(player)
		return self:GetDashboard(player)
	end)
	Net.Query("WorkOrders", { rate = 1, burst = 3 }, function(player)
		return self:GetOrders(player)
	end)
	Net.Action("Management", "CreateOrder", { rate = 0.2, burst = 2 }, function(player, payload)
		return self:CreateOrder(player, payload)
	end)
	Net.Action("Management", "AcceptOrder", { rate = 1, burst = 3 }, function(player, payload)
		return self:AcceptOrder(player, Check.string(payload.order, 64))
	end)
	Net.Action("Management", "CancelOrder", { rate = 1, burst = 3 }, function(player, payload)
		return self:CancelOrder(player, Check.string(payload.order, 64))
	end)
	Net.Action("Management", "AssignWorker", { rate = 1, burst = 4 }, function(player, payload)
		return self:AssignWorker(player, targetPlayer(payload.target), Check.key(payload.department, DepartmentConfig.Departments))
	end)
	Net.Action("Management", "RequestStaff", { rate = 0.2, burst = 1 }, function(player, payload)
		return self:RequestStaff(player, Check.key(payload.department, DepartmentConfig.Departments), Check.integer(payload.count, 1, 20))
	end)
	Net.Action("Management", "SetPriority", { rate = 0.5, burst = 2 }, function(player, payload)
		return self:SetPriority(player, Check.key(payload.department, DepartmentConfig.Departments), Check.string(payload.priority, 10))
	end)
	Net.Action("Management", "AppointManager", { rate = 0.5, burst = 2 }, function(player, payload)
		return self:AppointManager(player, targetPlayer(payload.target), Check.key(payload.department, DepartmentConfig.Departments), payload.appoint ~= false)
	end)
end

return ManagementService
