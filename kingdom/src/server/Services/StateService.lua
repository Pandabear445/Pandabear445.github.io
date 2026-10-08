--[[
	StateService
	Batches replicated state to clients. Services call Set/SetGlobal as often
	as they like; changes are coalesced and flushed a few times per second,
	so the network never sees per-frame spam.

	Player state keys (examples): Rank, XP, Queue, Job, Coins, Hunger, Inventory
	Global state keys (examples): Resources, Needs, Stage, Morale, Weather,
	                              Meetings, Events, Treasury, Taxes
]]

local Players = game:GetService("Players")

local Net = require(script.Parent.Parent.Core.Net)

local StateService = {
	Name = "StateService",
	Dependencies = {},
}

local FLUSH_SECONDS = 0.25

function StateService:Init()
	self._player = {} -- [Player] = { full state }
	self._dirty = {} -- [Player] = { key = true }
	self._global = {}
	self._globalDirty = {}

	Net.Query("StateSnapshot", { rate = 1, burst = 3, allowUnloaded = true }, function(player)
		return {
			Player = self._player[player] or {},
			Global = self._global,
		}
	end)

	Players.PlayerRemoving:Connect(function(player)
		self._player[player] = nil
		self._dirty[player] = nil
	end)
end

function StateService:Start()
	task.spawn(function()
		while true do
			task.wait(FLUSH_SECONDS)
			local ok, err = pcall(self.Flush, self)
			if not ok then
				self.Log:Error("flush failed: %s", tostring(err))
			end
		end
	end)
end

function StateService:Set(player: Player, key: string, value: any)
	local state = self._player[player]
	if not state then
		state = {}
		self._player[player] = state
	end
	state[key] = value
	local dirty = self._dirty[player]
	if not dirty then
		dirty = {}
		self._dirty[player] = dirty
	end
	dirty[key] = true
end

function StateService:Get(player: Player, key: string)
	local state = self._player[player]
	return state and state[key]
end

function StateService:SetGlobal(key: string, value: any)
	self._global[key] = value
	self._globalDirty[key] = true
end

function StateService:GetGlobal(key: string)
	return self._global[key]
end

function StateService:Flush()
	if next(self._globalDirty) then
		local delta = {}
		for key in pairs(self._globalDirty) do
			delta[key] = self._global[key]
		end
		self._globalDirty = {}
		Net.FireAll("State", "Global", delta)
	end
	for player, dirty in pairs(self._dirty) do
		if player.Parent == Players then
			local state = self._player[player] or {}
			local delta = {}
			for key in pairs(dirty) do
				delta[key] = state[key]
			end
			Net.Fire("State", player, "Player", delta)
		end
	end
	self._dirty = {}
end

return StateService
