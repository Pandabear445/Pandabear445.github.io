--[[
	Clock (client)
	Kingdom time derived from the SERVER's published epoch and
	workspace:GetServerTimeNow(), never from the player's computer clock.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GameClock = require(ReplicatedStorage.Kingdom.Shared.GameClock)
local TimeConfig = require(ReplicatedStorage.Kingdom.Config.TimeConfig)

local Clock = {}

local root = ReplicatedStorage:WaitForChild("Kingdom")

function Clock.Get()
	local params = GameClock.readParams(root)
	if not params then
		return nil
	end
	return GameClock.compute(TimeConfig, params, workspace:GetServerTimeNow())
end

function Clock.Period(hour: number): string
	local name = TimeConfig.Periods[1].Name
	for _, period in ipairs(TimeConfig.Periods) do
		if hour >= period.FromHour then
			name = period.Name
		end
	end
	return name
end

return Clock
