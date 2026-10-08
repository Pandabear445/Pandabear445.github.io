--[[
	GameClock
	Pure conversion between synchronized server time and kingdom time.

	The server owns the clock (TimeService). It publishes an epoch and speed as
	attributes on ReplicatedStorage.Kingdom; every client converts
	workspace:GetServerTimeNow() (the server-synchronized clock, never the
	client's local computer clock) into kingdom time with this module.

	With the default TimeConfig the 15 in-game hours from 7:00 AM to 10:00 PM
	take exactly 45 real minutes, i.e. 1 in-game hour = 3 real minutes.
]]

local GameClock = {}

export type ClockParams = {
	Epoch: number, -- server time at which DayOffset started (7:00 AM)
	DayOffset: number, -- day number at Epoch
	Speed: number, -- 1 = normal
	Paused: boolean?,
	PausedProgress: number?, -- 0..1 progress through the day while paused
}

export type ClockState = {
	Day: number,
	Hour: number, -- decimal hour, e.g. 8.7 = 8:42 AM
	Progress: number, -- 0..1 through the day
	SecondsIntoDay: number, -- real seconds
	SecondsPerGameHour: number,
}

function GameClock.dayLengthSeconds(timeConfig): number
	return timeConfig.RealMinutesPerDay * 60
end

function GameClock.hoursPerDay(timeConfig): number
	return timeConfig.EndHour - timeConfig.StartHour
end

function GameClock.secondsPerGameHour(timeConfig): number
	return GameClock.dayLengthSeconds(timeConfig) / GameClock.hoursPerDay(timeConfig)
end

function GameClock.compute(timeConfig, params: ClockParams, now: number): ClockState
	local dayLength = GameClock.dayLengthSeconds(timeConfig)
	local progress
	local day
	if params.Paused then
		progress = math.clamp(params.PausedProgress or 0, 0, 0.999999)
		day = params.DayOffset
	else
		local elapsed = math.max(0, (now - params.Epoch) * (params.Speed or 1))
		day = params.DayOffset + math.floor(elapsed / dayLength)
		progress = (elapsed % dayLength) / dayLength
	end
	return {
		Day = day,
		Hour = timeConfig.StartHour + progress * GameClock.hoursPerDay(timeConfig),
		Progress = progress,
		SecondsIntoDay = progress * dayLength,
		SecondsPerGameHour = GameClock.secondsPerGameHour(timeConfig) / math.max(params.Speed or 1, 1e-3),
	}
end

-- Converts a decimal in-game hour into whole in-game minutes since StartHour.
function GameClock.minuteOfDay(timeConfig, hour: number): number
	return math.floor((hour - timeConfig.StartHour) * 60 + 1e-6)
end

-- In-game minutes until a target hour later today (negative if already passed).
function GameClock.minutesUntil(currentHour: number, targetHour: number): number
	return (targetHour - currentHour) * 60
end

-- Real seconds that correspond to a number of in-game minutes.
function GameClock.realSecondsForGameMinutes(timeConfig, minutes: number): number
	return minutes / 60 * GameClock.secondsPerGameHour(timeConfig)
end

-- Reads the published attributes from a container (ReplicatedStorage.Kingdom).
function GameClock.readParams(container: Instance): ClockParams?
	local epoch = container:GetAttribute("ClockEpoch")
	if type(epoch) ~= "number" then
		return nil
	end
	return {
		Epoch = epoch,
		DayOffset = container:GetAttribute("ClockDayOffset") or 1,
		Speed = container:GetAttribute("ClockSpeed") or 1,
		Paused = container:GetAttribute("ClockPaused") == true,
		PausedProgress = container:GetAttribute("ClockPausedProgress") or 0,
	}
end

function GameClock.seasonForDay(seasonConfig, day: number): string?
	if not seasonConfig or not seasonConfig.Enabled then
		return nil
	end
	local order = seasonConfig.Order
	local index = ((day - 1) // seasonConfig.DaysPerSeason) % #order + 1
	return order[index]
end

return GameClock
