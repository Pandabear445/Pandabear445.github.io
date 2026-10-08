--[[
	TimeService
	The server owns kingdom time. It publishes an epoch on
	ReplicatedStorage.Kingdom; every client derives the same clock from
	workspace:GetServerTimeNow() via Shared/GameClock (never the local clock).

	Default: 7:00 AM -> 10:00 PM in 45 real minutes (1 in-game hour = 3 real
	minutes), then the next day starts at 7:00 AM.

	Signals (fired once per in-game minute/hour/day, even after hitches):
	  MinuteChanged(day, hour)   hour is decimal (8.5 = 8:30)
	  HourChanged(day, wholeHour)
	  DayStarted(day)
	  DayEnded(day)
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GameClock = require(ReplicatedStorage.Kingdom.Shared.GameClock)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local TimeConfig = require(ReplicatedStorage.Kingdom.Config.TimeConfig)
local WeatherConfig = require(ReplicatedStorage.Kingdom.Config.WeatherConfig)

local TimeService = {
	Name = "TimeService",
	Dependencies = {},
}

local MAX_CATCHUP_MINUTES = 30

function TimeService:Init()
	self.MinuteChanged = Signal.new("MinuteChanged")
	self.HourChanged = Signal.new("HourChanged")
	self.DayStarted = Signal.new("DayStarted")
	self.DayEnded = Signal.new("DayEnded")

	self._root = ReplicatedStorage:WaitForChild("Kingdom")
	self._params = {
		Epoch = workspace:GetServerTimeNow(),
		DayOffset = 1,
		Speed = 1,
		Paused = false,
		PausedProgress = 0,
	}
	self:_publish()
	self._lastMinuteIndex = self:_minuteIndex(self:GetClock())
end

function TimeService:_publish()
	local root = self._root
	root:SetAttribute("ClockEpoch", self._params.Epoch)
	root:SetAttribute("ClockDayOffset", self._params.DayOffset)
	root:SetAttribute("ClockSpeed", self._params.Speed)
	root:SetAttribute("ClockPaused", self._params.Paused)
	root:SetAttribute("ClockPausedProgress", self._params.PausedProgress)
	root:SetAttribute("ClockStartHour", TimeConfig.StartHour)
	root:SetAttribute("ClockEndHour", TimeConfig.EndHour)
	root:SetAttribute("ClockRealMinutes", TimeConfig.RealMinutesPerDay)
end

function TimeService:_minuteIndex(clock): number
	local minutesPerDay = GameClock.hoursPerDay(TimeConfig) * 60
	return clock.Day * minutesPerDay + GameClock.minuteOfDay(TimeConfig, clock.Hour)
end

function TimeService:Start()
	local minutesPerDay = GameClock.hoursPerDay(TimeConfig) * 60
	task.spawn(function()
		while true do
			task.wait(0.5)
			local ok, err = pcall(function()
				local clock = self:GetClock()
				local index = self:_minuteIndex(clock)
				if index == self._lastMinuteIndex then
					return
				end
				if index < self._lastMinuteIndex or index - self._lastMinuteIndex > MAX_CATCHUP_MINUTES then
					-- Admin time change or long pause: jump without replaying.
					self._lastMinuteIndex = index - 1
				end
				for i = self._lastMinuteIndex + 1, index do
					local day = i // minutesPerDay
					local minute = i % minutesPerDay
					local hour = TimeConfig.StartHour + minute / 60
					if minute == 0 then
						if day > 1 or i > 0 then
							self.DayEnded:Fire(day - 1)
						end
						self.DayStarted:Fire(day)
					end
					self.MinuteChanged:Fire(day, hour)
					if minute % 60 == 0 then
						self.HourChanged:Fire(day, math.floor(hour + 1e-6))
					end
				end
				self._lastMinuteIndex = index
			end)
			if not ok then
				self.Log:Error("tick failed: %s", tostring(err))
			end
		end
	end)
end

function TimeService:GetClock()
	return GameClock.compute(TimeConfig, self._params, workspace:GetServerTimeNow())
end

function TimeService:GetHour(): number
	return self:GetClock().Hour
end

function TimeService:GetDay(): number
	return self:GetClock().Day
end

-- Absolute in-game minutes since day 0 (used for deadlines/timers).
function TimeService:GetAbsoluteMinutes(): number
	local clock = self:GetClock()
	return clock.Day * GameClock.hoursPerDay(TimeConfig) * 60 + (clock.Hour - TimeConfig.StartHour) * 60
end

function TimeService:GetSeason(): string?
	return GameClock.seasonForDay(WeatherConfig.Seasons, self:GetDay())
end

-- Real seconds for a number of in-game minutes at the current speed.
function TimeService:GameMinutesToSeconds(minutes: number): number
	return GameClock.realSecondsForGameMinutes(TimeConfig, minutes) / math.max(self._params.Speed, 1e-3)
end

-- Admin / testing controls ---------------------------------------------------

function TimeService:SetHour(hour: number)
	hour = math.clamp(hour, TimeConfig.StartHour, TimeConfig.EndHour - 1 / 60)
	local clock = self:GetClock()
	local progress = (hour - TimeConfig.StartHour) / GameClock.hoursPerDay(TimeConfig)
	local dayLength = GameClock.dayLengthSeconds(TimeConfig)
	self._params.DayOffset = clock.Day
	self._params.Epoch = workspace:GetServerTimeNow() - progress * dayLength / self._params.Speed
	self._params.PausedProgress = progress
	self:_publish()
end

function TimeService:SetSpeed(speed: number)
	speed = math.clamp(speed, 0.1, 60)
	local clock = self:GetClock()
	local dayLength = GameClock.dayLengthSeconds(TimeConfig)
	self._params.Speed = speed
	self._params.DayOffset = clock.Day
	self._params.Epoch = workspace:GetServerTimeNow() - clock.Progress * dayLength / speed
	self:_publish()
end

function TimeService:SetPaused(paused: boolean)
	local clock = self:GetClock()
	self._params.Paused = paused
	self._params.PausedProgress = clock.Progress
	self._params.DayOffset = clock.Day
	if not paused then
		local dayLength = GameClock.dayLengthSeconds(TimeConfig)
		self._params.Epoch = workspace:GetServerTimeNow() - clock.Progress * dayLength / self._params.Speed
	end
	self:_publish()
end

return TimeService
