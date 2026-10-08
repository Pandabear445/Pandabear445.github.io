--[[
	StoreUtil
	DataStore / OrderedDataStore / MemoryStore access with:
	  * an in-memory mock when Studio has no API access (so the game is
	    playable while building; nothing is ever written to a real store
	    from a mock, and the UI shows that saves are disabled)
	  * retry with exponential backoff
	  * request budget awareness
]]

local DataStoreService = game:GetService("DataStoreService")
local MemoryStoreService = game:GetService("MemoryStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local Logger = require(ReplicatedStorage.Kingdom.Shared.Logger)

local log = Logger.new("StoreUtil")

local StoreUtil = {}

local apiAvailable: boolean? = nil

-- Mock implementations ------------------------------------------------------

local MockStore = {}
MockStore.__index = MockStore

function MockStore.new()
	return setmetatable({ _data = {} }, MockStore)
end

function MockStore:GetAsync(key)
	local value = self._data[key]
	return value and table.clone({ v = value }).v or nil
end

function MockStore:SetAsync(key, value)
	self._data[key] = value
end

function MockStore:UpdateAsync(key, transform)
	local result = transform(self._data[key])
	if result ~= nil then
		self._data[key] = result
	end
	return result
end

function MockStore:RemoveAsync(key)
	local old = self._data[key]
	self._data[key] = nil
	return old
end

function MockStore:IncrementAsync(key, delta)
	self._data[key] = (self._data[key] or 0) + delta
	return self._data[key]
end

function MockStore:GetSortedAsync()
	return nil
end

local mockStores = {}

local function mock(name: string)
	if not mockStores[name] then
		mockStores[name] = MockStore.new()
	end
	return mockStores[name]
end

-------------------------------------------------------------------------------

function StoreUtil.IsApiAvailable(): boolean
	if apiAvailable ~= nil then
		return apiAvailable
	end
	if not RunService:IsStudio() then
		apiAvailable = true
		return true
	end
	local ok = pcall(function()
		DataStoreService:GetDataStore("__KingdomApiProbe"):GetAsync("probe")
	end)
	apiAvailable = ok
	if not ok then
		if GameConfig.Data.UseMockInStudioWithoutAPI then
			log:Warn("Studio has no DataStore API access: using in-memory mock stores. Nothing will be saved.")
		end
	end
	return ok
end

function StoreUtil.IsMock(): boolean
	return not StoreUtil.IsApiAvailable() and GameConfig.Data.UseMockInStudioWithoutAPI
end

function StoreUtil.GetDataStore(name: string): any
	if StoreUtil.IsMock() then
		return mock("ds:" .. name)
	end
	return DataStoreService:GetDataStore(name)
end

function StoreUtil.GetOrderedDataStore(name: string): any
	if StoreUtil.IsMock() then
		return mock("ods:" .. name)
	end
	return DataStoreService:GetOrderedDataStore(name)
end

function StoreUtil.GetHashMap(name: string): any
	if StoreUtil.IsMock() then
		return mock("mem:" .. name)
	end
	return MemoryStoreService:GetHashMap(name)
end

-- Retries fn with exponential backoff. Returns ok, result.
function StoreUtil.Retry(label: string, attempts: number, fn: () -> any)
	local lastError
	for attempt = 1, attempts do
		local ok, result = pcall(fn)
		if ok then
			return true, result
		end
		lastError = result
		log:Warn("%s failed (attempt %d/%d): %s", label, attempt, attempts, tostring(result))
		if attempt < attempts then
			task.wait(math.min(2 ^ (attempt - 1), 16))
		end
	end
	return false, lastError
end

-- True when the server has budget for the request type (always true on mocks).
function StoreUtil.HasBudget(requestType: Enum.DataStoreRequestType, minimum: number?): boolean
	if StoreUtil.IsMock() then
		return true
	end
	local ok, budget = pcall(DataStoreService.GetRequestBudgetForRequestType, DataStoreService, requestType)
	return not ok or budget >= (minimum or 1)
end

return StoreUtil
