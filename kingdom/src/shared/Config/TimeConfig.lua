--[[
	TimeConfig
	The kingdom day: 7:00 AM -> 10:00 PM in exactly 45 real minutes.
	15 in-game hours / 45 real minutes = 1 in-game hour every 3 real minutes.
	The cycle then restarts at 7:00 AM of the next day.

	Lighting keyframes are interpolated by the client using the server clock.
	Leave a property out to keep whatever your map already uses.
]]

local TimeConfig = {}

TimeConfig.StartHour = 7
TimeConfig.EndHour = 22
TimeConfig.RealMinutesPerDay = 45

-- Real seconds the screen takes to fade between 10 PM and the next 7 AM.
TimeConfig.DayTransitionSeconds = 4

-- Lighting keyframes by in-game hour. Colors are Color3, numbers interpolate.
-- ClockTime follows the in-game hour unless overridden here.
TimeConfig.Lighting = {
	Enabled = true,
	Keyframes = {
		{
			Hour = 7,
			Brightness = 1.6,
			Ambient = Color3.fromRGB(120, 105, 95),
			OutdoorAmbient = Color3.fromRGB(150, 130, 115),
			FogColor = Color3.fromRGB(210, 190, 170),
			FogEnd = 1400,
			ColorCorrection = { Brightness = 0.02, Contrast = 0.05, Saturation = -0.05, TintColor = Color3.fromRGB(255, 236, 214) },
			Atmosphere = { Density = 0.35, Haze = 1.5, Color = Color3.fromRGB(230, 200, 170) },
		},
		{
			Hour = 12,
			Brightness = 2.6,
			Ambient = Color3.fromRGB(135, 135, 135),
			OutdoorAmbient = Color3.fromRGB(150, 150, 150),
			FogColor = Color3.fromRGB(200, 210, 220),
			FogEnd = 2600,
			ColorCorrection = { Brightness = 0.03, Contrast = 0.08, Saturation = 0.05, TintColor = Color3.fromRGB(255, 252, 245) },
			Atmosphere = { Density = 0.25, Haze = 0.8, Color = Color3.fromRGB(200, 215, 230) },
		},
		{
			Hour = 17,
			Brightness = 2.0,
			Ambient = Color3.fromRGB(140, 115, 95),
			OutdoorAmbient = Color3.fromRGB(160, 125, 100),
			FogColor = Color3.fromRGB(225, 170, 120),
			FogEnd = 1800,
			ColorCorrection = { Brightness = 0.01, Contrast = 0.1, Saturation = 0.08, TintColor = Color3.fromRGB(255, 225, 190) },
			Atmosphere = { Density = 0.33, Haze = 1.8, Color = Color3.fromRGB(240, 180, 130) },
		},
		{
			Hour = 20,
			Brightness = 0.8,
			Ambient = Color3.fromRGB(70, 70, 95),
			OutdoorAmbient = Color3.fromRGB(80, 80, 110),
			FogColor = Color3.fromRGB(60, 60, 90),
			FogEnd = 900,
			ColorCorrection = { Brightness = -0.03, Contrast = 0.12, Saturation = -0.15, TintColor = Color3.fromRGB(200, 205, 255) },
			Atmosphere = { Density = 0.4, Haze = 2.2, Color = Color3.fromRGB(80, 85, 120) },
		},
		{
			Hour = 22,
			Brightness = 0.4,
			Ambient = Color3.fromRGB(45, 45, 70),
			OutdoorAmbient = Color3.fromRGB(55, 55, 85),
			FogColor = Color3.fromRGB(30, 30, 50),
			FogEnd = 700,
			ColorCorrection = { Brightness = -0.06, Contrast = 0.12, Saturation = -0.25, TintColor = Color3.fromRGB(180, 190, 255) },
			Atmosphere = { Density = 0.45, Haze = 2.5, Color = Color3.fromRGB(40, 45, 75) },
		},
	},
}

-- Named periods (UI and events).
TimeConfig.Periods = {
	{ FromHour = 7, Name = "Morning" },
	{ FromHour = 12, Name = "Noon" },
	{ FromHour = 13, Name = "Afternoon" },
	{ FromHour = 17, Name = "Evening" },
	{ FromHour = 20, Name = "Night" },
}

return TimeConfig
