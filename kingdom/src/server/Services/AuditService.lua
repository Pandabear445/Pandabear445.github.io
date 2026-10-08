--[[
	AuditService
	Server-side log of important events: promotions, demotions, removals,
	XP/currency awards, resource creation/destruction, votes, meetings,
	treasury transactions, discipline, admin commands, anti-cheat flags.

	* Kept in a ring buffer for the admin panel.
	* Flushed in batches to a DataStore (one new key per flush, so no write
	  contention) when the API is available.
	* Mirrored to debug output when Debug is enabled for the "Audit" tag.
]]

local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local Logger = require(ReplicatedStorage.Kingdom.Shared.Logger)
local StoreUtil = require(script.Parent.Parent.Core.StoreUtil)

local AuditService = {
	Name = "AuditService",
	Dependencies = {},
}

local RING_SIZE = 3000
local FLUSH_SECONDS = 60
local MAX_BATCH = 400

local auditLog = Logger.new("Audit")

function AuditService:Init()
	self._ring = table.create(RING_SIZE)
	self._head = 0
	self._count = 0
	self._pending = {}
	self._seq = 0
	-- Categories that are too chatty to persist individually.
	self._volatile = { XP = true, Currency = true, Resource = true }
	self._volatileCounters = {}
end

function AuditService:Start()
	self.Registry:Every(self.Name, "flush", FLUSH_SECONDS, function()
		self:Flush()
	end)
	game:BindToClose(function()
		pcall(self.Flush, self)
	end)
end

local function compact(data)
	if type(data) ~= "table" then
		return data
	end
	local result = {}
	for k, v in pairs(data) do
		local kind = typeof(v)
		if kind == "Instance" then
			result[k] = v:GetFullName()
		elseif kind == "table" then
			local ok, encoded = pcall(HttpService.JSONEncode, HttpService, v)
			result[k] = ok and string.sub(encoded, 1, 300) or "<table>"
		elseif kind == "string" or kind == "number" or kind == "boolean" then
			result[k] = v
		else
			result[k] = tostring(v)
		end
	end
	return result
end

-- category: Rank | Promotion | XP | Currency | Treasury | Resource | Government
--           | Meeting | Discipline | Admin | AntiCheat | Data | Death | Market | System
function AuditService:Log(category: string, event: string, data: { [string]: any }?)
	local entry = {
		t = os.time(),
		c = category,
		e = event,
		d = compact(data or {}),
	}
	self._head = self._head % RING_SIZE + 1
	self._ring[self._head] = entry
	self._count = math.min(self._count + 1, RING_SIZE)

	if self._volatile[category] then
		-- Aggregate per minute instead of persisting every single award.
		local counterKey = category .. ":" .. event
		self._volatileCounters[counterKey] = (self._volatileCounters[counterKey] or 0) + 1
	else
		table.insert(self._pending, entry)
		if #self._pending > MAX_BATCH * 3 then
			table.remove(self._pending, 1) -- never grow unbounded if saves fail
		end
	end
	if GameConfig.Debug.Enabled then
		auditLog:Debug("%s/%s %s", category, event, data and HttpService:JSONEncode(entry.d) or "")
	end
end

-- Newest first, optionally filtered.
function AuditService:Query(filter)
	filter = filter or {}
	local limit = math.clamp(filter.limit or 100, 1, 500)
	local results = {}
	local index = self._head
	for _ = 1, self._count do
		local entry = self._ring[index]
		if entry then
			local matches = (not filter.category or entry.c == filter.category)
			if matches and filter.text and filter.text ~= "" then
				local blob = string.lower(entry.e .. " " .. HttpService:JSONEncode(entry.d))
				matches = string.find(blob, string.lower(filter.text), 1, true) ~= nil
			end
			if matches then
				table.insert(results, entry)
				if #results >= limit then
					break
				end
			end
		end
		index -= 1
		if index < 1 then
			index = RING_SIZE
		end
	end
	return results
end

function AuditService:Flush()
	if next(self._volatileCounters) then
		table.insert(self._pending, { t = os.time(), c = "Summary", e = "Counters", d = self._volatileCounters })
		self._volatileCounters = {}
	end
	if #self._pending == 0 or StoreUtil.IsMock() then
		if StoreUtil.IsMock() then
			self._pending = {}
		end
		return
	end
	if not StoreUtil.HasBudget(Enum.DataStoreRequestType.SetIncrementAsync, 5) then
		return
	end
	local batch = {}
	for i = 1, math.min(MAX_BATCH, #self._pending) do
		batch[i] = self._pending[i]
	end
	self._seq += 1
	local key = string.format("%s/%s/%d", os.date("!%Y-%m-%d"), game.JobId ~= "" and game.JobId or "studio", self._seq)
	local store = StoreUtil.GetDataStore(GameConfig.Data.AuditStore)
	local ok = pcall(function()
		store:SetAsync(key, batch)
	end)
	if ok then
		for _ = 1, #batch do
			table.remove(self._pending, 1)
		end
	end
end

return AuditService
