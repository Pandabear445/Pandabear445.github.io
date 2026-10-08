--[[
	ServiceRegistry
	Loads every service module, orders them by declared dependencies, and
	isolates failures.

	A service module looks like:
	  local MyService = {
	      Name = "MyService",
	      Dependencies = { "DataService" },   -- hard: must be healthy first
	  }
	  function MyService:Init(registry) end  -- wire up, no yielding loops
	  function MyService:Start() end         -- begin work (may spawn loops)
	  return MyService

	Rules
	  * Dependencies form a DAG. Cycles are detected and refused at boot.
	  * A service may only :Use() services it declared, so hidden coupling
	    is impossible.
	  * If a service fails Init it is retried, then Disabled; anything that
	    hard-depends on it is Disabled too. Everything else keeps running.
	  * Runtime loops go through registry:Every(), which catches errors,
	    marks the service Degraded, backs off and recovers automatically.
	  * Health is published as attributes "Status_<Service>" on
	    ReplicatedStorage.Kingdom so the UI can show
	    "Food systems temporarily unavailable." instead of breaking.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Logger = require(ReplicatedStorage.Kingdom.Shared.Logger)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)

local log = Logger.new("ServiceRegistry")

local ServiceRegistry = {}
ServiceRegistry.__index = ServiceRegistry

local INIT_RETRIES = 3

export type Status = "Pending" | "Ready" | "Degraded" | "Disabled"

function ServiceRegistry.new()
	return setmetatable({
		Services = {},
		Order = {},
		Status = {},
		StatusChanged = Signal.new("ServiceStatusChanged"),
		_started = false,
	}, ServiceRegistry)
end

function ServiceRegistry:Register(service)
	assert(type(service) == "table" and type(service.Name) == "string", "service must have a Name")
	assert(not self.Services[service.Name], "duplicate service " .. service.Name)
	service.Dependencies = service.Dependencies or {}
	service.Log = Logger.new(service.Name)
	self.Services[service.Name] = service
	self:_setStatus(service.Name, "Pending")
end

function ServiceRegistry:LoadFolder(folder: Instance)
	for _, child in ipairs(folder:GetChildren()) do
		if child:IsA("ModuleScript") then
			local ok, result = pcall(require, child)
			if ok and type(result) == "table" and result.Name then
				self:Register(result)
			elseif not ok then
				log:Error("failed to load %s: %s", child.Name, tostring(result))
			end
		end
	end
end

function ServiceRegistry:_setStatus(name: string, status: Status, reason: string?)
	if self.Status[name] == status then
		return
	end
	self.Status[name] = status
	local root = ReplicatedStorage:FindFirstChild("Kingdom")
	if root then
		root:SetAttribute("Status_" .. name, status)
	end
	if status == "Disabled" or status == "Degraded" then
		log:Warn("%s is %s%s", name, status, reason and (": " .. reason) or "")
	end
	self.StatusChanged:Fire(name, status, reason)
end

function ServiceRegistry:IsAvailable(name: string): boolean
	local status = self.Status[name]
	return status == "Ready" or status == "Degraded"
end

function ServiceRegistry:SetDegraded(name: string, reason: string?)
	if self.Status[name] == "Ready" then
		self:_setStatus(name, "Degraded", reason)
	end
end

function ServiceRegistry:SetRecovered(name: string)
	if self.Status[name] == "Degraded" then
		self:_setStatus(name, "Ready")
		log:Info("%s recovered", name)
	end
end

-- Topological sort over hard dependencies. Errors on cycles / unknown deps.
function ServiceRegistry:_sort()
	local order, state = {}, {}
	local function visit(name: string, path: { string })
		if state[name] == "done" then
			return
		end
		if state[name] == "visiting" then
			table.insert(path, name)
			error("circular dependency: " .. table.concat(path, " -> "))
		end
		local service = self.Services[name]
		if not service then
			error(string.format("unknown dependency '%s' (required by %s)", name, path[#path] or "?"))
		end
		state[name] = "visiting"
		table.insert(path, name)
		for _, dep in ipairs(service.Dependencies) do
			visit(dep, path)
		end
		table.remove(path)
		state[name] = "done"
		table.insert(order, name)
	end

	local names = {}
	for name in pairs(self.Services) do
		table.insert(names, name)
	end
	table.sort(names)
	for _, name in ipairs(names) do
		visit(name, {})
	end
	return order
end

-- Gives a service typed access only to what it declared.
function ServiceRegistry:_bind(service)
	local registry = self
	local allowed = {}
	for _, dep in ipairs(service.Dependencies) do
		allowed[dep] = true
	end
	service.Registry = registry
	function service.Use(_, depName: string)
		assert(allowed[depName], string.format("%s used undeclared dependency %s", service.Name, depName))
		return registry.Services[depName]
	end
end

function ServiceRegistry:Boot()
	local ok, orderOrError = pcall(self._sort, self)
	if not ok then
		log:Error("boot aborted: %s", tostring(orderOrError))
		error(orderOrError)
	end
	self.Order = orderOrError

	for _, name in ipairs(self.Order) do
		local service = self.Services[name]
		self:_bind(service)

		local blocked
		for _, dep in ipairs(service.Dependencies) do
			if self.Status[dep] == "Disabled" then
				blocked = dep
				break
			end
		end

		if blocked then
			self:_setStatus(name, "Disabled", "dependency " .. blocked .. " unavailable")
		elseif service.Init then
			local initialized = false
			for attempt = 1, INIT_RETRIES do
				local success, err = pcall(service.Init, service, self)
				if success then
					initialized = true
					break
				end
				log:Error("%s Init failed (attempt %d): %s", name, attempt, tostring(err))
				task.wait(0.25 * attempt)
			end
			self:_setStatus(name, initialized and "Ready" or "Disabled", not initialized and "Init failed" or nil)
		else
			self:_setStatus(name, "Ready")
		end
	end

	for _, name in ipairs(self.Order) do
		local service = self.Services[name]
		if self:IsAvailable(name) and service.Start then
			task.spawn(function()
				local success, err = pcall(service.Start, service)
				if not success then
					log:Error("%s Start failed: %s", name, tostring(err))
					self:_setStatus(name, "Degraded", "Start failed")
				end
			end)
		end
	end
	self._started = true
	log:Info("booted %d services", #self.Order)
end

-- Runs fn every `seconds` (real time) for a service, isolating errors.
-- Consecutive failures mark the service Degraded and back off; a success
-- marks it recovered. Returns a stop function.
function ServiceRegistry:Every(serviceName: string, label: string, seconds: number, fn: () -> ())
	local running = true
	local failures = 0
	task.spawn(function()
		while running do
			local delay = seconds * math.min(2 ^ math.max(failures - 2, 0), 8)
			task.wait(delay)
			if not running then
				break
			end
			if self.Status[serviceName] == "Disabled" then
				break
			end
			local ok, err = pcall(fn)
			if ok then
				if failures > 0 then
					failures = 0
					self:SetRecovered(serviceName)
				end
			else
				failures += 1
				log:Error("%s/%s loop error (%d): %s", serviceName, label, failures, tostring(err))
				if failures >= 3 then
					self:SetDegraded(serviceName, label .. " failing")
				end
			end
		end
	end)
	return function()
		running = false
	end
end

-- Calls service[method] safely. Returns ok, ...results.
function ServiceRegistry:SafeCall(serviceName: string, method: string, ...)
	if not self:IsAvailable(serviceName) then
		return false, serviceName .. " unavailable"
	end
	local service = self.Services[serviceName]
	local fn = service and service[method]
	if type(fn) ~= "function" then
		return false, "no method " .. method
	end
	return pcall(fn, service, ...)
end

return ServiceRegistry
