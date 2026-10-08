--[[
	ActivityService
	Server-side observation of what players are actually doing.
	  * Samples every character's position once per second (one loop for
	    all players, not per-frame) to detect movement and AFK.
	  * Records interactions/tasks reported by other services.
	  * Keeps a short position history for anti-cheat travel validation.
	  * Holds the server-teleport whitelist so legitimate teleports
	    (meetings, respawns, admin) are never flagged.

	There is NO XP for being here. AFK players are refused work XP.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local ActivityService = {
	Name = "ActivityService",
	Dependencies = {},
}

local SAMPLE_SECONDS = 1
local HISTORY = 30
local MOVE_THRESHOLD = 1.5

function ActivityService:Init()
	self.Sampled = Signal.new("ActivitySampled") -- (player, position, distance, dt, teleportAllowed)
	self.WentAFK = Signal.new("WentAFK")
	self.CameBack = Signal.new("CameBack")
	self._records = {}

	Players.PlayerAdded:Connect(function(player)
		self:_record(player)
	end)
	for _, player in ipairs(Players:GetPlayers()) do
		self:_record(player)
	end
	Players.PlayerRemoving:Connect(function(player)
		self._records[player] = nil
	end)
end

function ActivityService:_record(player: Player)
	local record = self._records[player]
	if not record then
		local now = os.clock()
		record = {
			lastMove = now,
			lastInteraction = now,
			lastTask = 0,
			lastTaskPosition = nil,
			history = {},
			teleportUntil = 0,
			afk = false,
			activeSeconds = 0,
			joinedAt = now,
		}
		self._records[player] = record
	end
	return record
end

function ActivityService:Start()
	task.spawn(function()
		while true do
			task.wait(SAMPLE_SECONDS)
			for _, player in ipairs(Players:GetPlayers()) do
				local ok, err = pcall(self._sample, self, player)
				if not ok then
					self.Log:Error("sample failed: %s", tostring(err))
				end
			end
		end
	end)
end

function ActivityService:_sample(player: Player)
	local record = self:_record(player)
	local root = ZoneUtil.getRoot(player)
	local now = os.clock()
	if not root then
		return
	end
	local position = root.Position
	local last = record.history[#record.history]
	local distance = 0
	local dt = SAMPLE_SECONDS
	if last then
		distance = (position - last.p).Magnitude
		dt = math.max(now - last.t, 1e-3)
	end
	table.insert(record.history, { p = position, t = now })
	if #record.history > HISTORY then
		table.remove(record.history, 1)
	end
	if distance > MOVE_THRESHOLD then
		record.lastMove = now
	end

	local afk = self:IsAFK(player)
	if afk ~= record.afk then
		record.afk = afk
		if afk then
			self.WentAFK:Fire(player)
		else
			self.CameBack:Fire(player)
		end
	end
	if not afk then
		record.activeSeconds += dt
	end
	self.Sampled:Fire(player, position, distance, dt, now < record.teleportUntil)
end

function ActivityService:MarkInteraction(player: Player)
	local record = self:_record(player)
	record.lastInteraction = os.clock()
end

function ActivityService:MarkTask(player: Player, position: Vector3?)
	local record = self:_record(player)
	local now = os.clock()
	record.lastInteraction = now
	record.lastTask = now
	record.lastTaskPosition = position
end

function ActivityService:GetLastTask(player: Player): (number, Vector3?)
	local record = self:_record(player)
	return record.lastTask, record.lastTaskPosition
end

function ActivityService:IsAFK(player: Player): boolean
	local record = self._records[player]
	if not record then
		return true
	end
	local now = os.clock()
	local idleFor = now - math.max(record.lastMove, record.lastInteraction)
	return idleFor > GameConfig.AFKSeconds
end

function ActivityService:SecondsSinceTask(player: Player): number
	local record = self._records[player]
	if not record or record.lastTask == 0 then
		return math.huge
	end
	return os.clock() - record.lastTask
end

function ActivityService:GetActiveSeconds(player: Player): number
	local record = self._records[player]
	return record and record.activeSeconds or 0
end

-- Whitelist a server-initiated teleport so anti-cheat ignores the jump.
function ActivityService:AllowTeleport(player: Player, seconds: number?)
	local record = self:_record(player)
	record.teleportUntil = os.clock() + (seconds or 3)
	record.history = {}
end

function ActivityService:IsTeleportAllowed(player: Player): boolean
	local record = self._records[player]
	return record ~= nil and os.clock() < record.teleportUntil
end

return ActivityService
