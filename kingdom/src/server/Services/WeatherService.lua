--[[
	WeatherService
	Modular weather + optional seasons. The server picks the weather; the
	client renders it (LightingController). Gameplay effects are exposed as
	multipliers so jobs/crops/movement just ask:
	  Weather:GetJobMultiplier(jobId)   yield modifier (weather x season)
	  Weather:GetGrowthMultiplier()     crop growth speed
	  Weather:GetWalkSpeedMultiplier()  travel penalty
	  Weather:WatersCrops()             rain waters fields
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local WeatherConfig = require(ReplicatedStorage.Kingdom.Config.WeatherConfig)

local WeatherService = {
	Name = "WeatherService",
	Dependencies = { "TimeService", "StateService", "NotificationService", "AuditService" },
}

function WeatherService:Init()
	self._time = self:Use("TimeService")
	self._state = self:Use("StateService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")

	self.WeatherChanged = Signal.new("WeatherChanged") -- (weatherId)
	self.SeasonChanged = Signal.new("SeasonChanged") -- (season)
	self._current = "Clear"
	self._endsAt = 0
	self._season = self._time:GetSeason()

	self._time.HourChanged:Connect(function()
		if WeatherConfig.Enabled and self._time:GetAbsoluteMinutes() >= self._endsAt then
			self:_roll()
		end
	end)
	self._time.DayStarted:Connect(function()
		local season = self._time:GetSeason()
		if season and season ~= self._season then
			self._season = season
			self._notify:Announce("Information", "The season turns", season .. " has arrived in the kingdom.")
			self.SeasonChanged:Fire(season)
			self:_publish()
		end
	end)
end

function WeatherService:Start()
	if WeatherConfig.Enabled then
		self:_roll()
	else
		self:_publish()
	end
end

function WeatherService:_weights()
	local season = self._time:GetSeason()
	local seasonDef = season and WeatherConfig.Seasons.Definitions[season]
	return (seasonDef and seasonDef.WeatherWeights) or WeatherConfig.DefaultWeights
end

function WeatherService:_roll()
	local weights = self:_weights()
	local total = 0
	for id, weight in pairs(weights) do
		if WeatherConfig.States[id] then
			total += weight
		end
	end
	local pick = math.random() * total
	local chosen = "Clear"
	for id, weight in pairs(weights) do
		if WeatherConfig.States[id] then
			pick -= weight
			if pick <= 0 then
				chosen = id
				break
			end
		end
	end
	local range = WeatherConfig.DurationGameHours
	self:SetWeather(chosen, math.random(range[1], range[2]))
end

function WeatherService:SetWeather(weatherId: string, hours: number?)
	if not WeatherConfig.States[weatherId] then
		return false
	end
	local changed = weatherId ~= self._current
	self._current = weatherId
	self._endsAt = self._time:GetAbsoluteMinutes() + (hours or 3) * 60
	if changed then
		self._audit:Log("System", "Weather", { weather = weatherId })
		if weatherId == "Storm" or weatherId == "Snow" then
			self._notify:Broadcast("Warning", "Weather: " .. WeatherConfig.States[weatherId].DisplayName, "Travel and outdoor work are affected.")
		end
		self.WeatherChanged:Fire(weatherId)
	end
	self:_publish()
	return true
end

function WeatherService:_publish()
	ReplicatedStorage.Kingdom:SetAttribute("Weather", self._current)
	ReplicatedStorage.Kingdom:SetAttribute("Season", self._season or "")
	self._state:SetGlobal("Weather", {
		Id = self._current,
		Name = WeatherConfig.States[self._current].DisplayName,
		Season = self._season,
		Day = self._time:GetDay(),
	})
end

function WeatherService:GetWeather(): string
	return self._current
end

function WeatherService:GetDefinition()
	return WeatherConfig.States[self._current]
end

function WeatherService:_seasonDef()
	local season = self._time:GetSeason()
	return season and WeatherConfig.Seasons.Definitions[season] or nil
end

function WeatherService:GetJobMultiplier(jobId: string): number
	local multiplier = 1
	local weather = self:GetDefinition()
	if WeatherConfig.Enabled and weather and weather.JobMultipliers[jobId] then
		multiplier *= weather.JobMultipliers[jobId]
	end
	local season = self:_seasonDef()
	if season and season.JobMultipliers and season.JobMultipliers[jobId] then
		multiplier *= season.JobMultipliers[jobId]
	end
	return multiplier
end

function WeatherService:GetGrowthMultiplier(): number
	local multiplier = 1
	local weather = self:GetDefinition()
	if WeatherConfig.Enabled and weather then
		multiplier *= weather.GrowthMultiplier or 1
	end
	local season = self:_seasonDef()
	if season then
		multiplier *= season.GrowthMultiplier or 1
	end
	return multiplier
end

function WeatherService:GetWalkSpeedMultiplier(): number
	local weather = self:GetDefinition()
	return (WeatherConfig.Enabled and weather and weather.WalkSpeedMultiplier) or 1
end

function WeatherService:GetHungerMultiplier(): number
	local season = self:_seasonDef()
	return season and season.HungerMultiplier or 1
end

function WeatherService:WatersCrops(): boolean
	local weather = self:GetDefinition()
	return WeatherConfig.Enabled and weather ~= nil and weather.WatersCrops == true
end

function WeatherService:GetBuildingDamagePerHour(): number
	local weather = self:GetDefinition()
	return (WeatherConfig.Enabled and weather and weather.BuildingDamagePerHour) or 0
end

return WeatherService
