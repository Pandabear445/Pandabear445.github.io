--[[
	LightingController (client)
	Smoothly follows the SERVER clock through TimeConfig.Lighting keyframes
	(ClockTime, Brightness, Ambient, OutdoorAmbient, Fog, ColorCorrection,
	Atmosphere) and layers the server-chosen weather on top (fog, darkening,
	rain/snow particles, thunder flashes). Nothing is hard-coded: edit
	TimeConfig / WeatherConfig. Set TimeConfig.Lighting.Enabled = false to
	keep your own lighting.
]]

local Lighting = game:GetService("Lighting")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local TimeConfig = require(ReplicatedStorage.Kingdom.Config.TimeConfig)
local WeatherConfig = require(ReplicatedStorage.Kingdom.Config.WeatherConfig)
local Clock = require(script.Parent.Clock)

local LightingController = {}

local root = ReplicatedStorage:WaitForChild("Kingdom")
local colorCorrection: ColorCorrectionEffect
local atmosphere: Atmosphere
local particlePart: Part?
local emitter: ParticleEmitter?
local lastDay: number? = nil
local fadeGui: ScreenGui?

local function lerp(a, b, t: number)
	if typeof(a) == "number" then
		return a + (b - a) * t
	elseif typeof(a) == "Color3" then
		return a:Lerp(b, t)
	end
	return a
end

local function keyframesAround(hour: number)
	local frames = TimeConfig.Lighting.Keyframes
	local previous, nextFrame = frames[1], frames[#frames]
	for index, frame in ipairs(frames) do
		if frame.Hour <= hour then
			previous = frame
			nextFrame = frames[index + 1] or frame
		end
	end
	local span = nextFrame.Hour - previous.Hour
	local t = span > 0 and math.clamp((hour - previous.Hour) / span, 0, 1) or 0
	return previous, nextFrame, t
end

local function value(previous, nextFrame, t: number, key: string, sub: string?)
	local a = sub and previous[sub] and previous[sub][key] or (not sub and previous[key])
	local b = sub and nextFrame[sub] and nextFrame[sub][key] or (not sub and nextFrame[key])
	if a == nil then
		return b
	end
	if b == nil then
		return a
	end
	return lerp(a, b, t)
end

local function ensureObjects()
	local found = Lighting:FindFirstChild("KingdomColorCorrection")
	if found and found:IsA("ColorCorrectionEffect") then
		colorCorrection = found
	else
		local created = Instance.new("ColorCorrectionEffect")
		created.Name = "KingdomColorCorrection"
		created.Parent = Lighting
		colorCorrection = created
	end
	local existing = Lighting:FindFirstChildOfClass("Atmosphere")
	if existing then
		atmosphere = existing
	else
		atmosphere = Instance.new("Atmosphere")
		atmosphere.Name = "KingdomAtmosphere"
		atmosphere.Parent = Lighting
	end
end

local function setParticles(kind: string?)
	if not kind then
		if emitter then
			emitter.Enabled = false
		end
		return
	end
	local part = particlePart
	local e = emitter
	if not part or not e then
		part = Instance.new("Part")
		part.Name = "KingdomWeatherParticles"
		part.Anchored = true
		part.CanCollide = false
		part.CanQuery = false
		part.CanTouch = false
		part.Transparency = 1
		part.Size = Vector3.new(80, 1, 80)
		part.Parent = workspace.CurrentCamera
		e = Instance.new("ParticleEmitter")
		e.EmissionDirection = Enum.NormalId.Bottom
		e.Parent = part
		particlePart = part
		emitter = e
	end
	e.Enabled = true
	if kind == "Snow" then
		e.Rate = 180
		e.Speed = NumberRange.new(6, 10)
		e.Lifetime = NumberRange.new(4, 6)
		e.Size = NumberSequence.new(0.25)
		e.Color = ColorSequence.new(Color3.new(1, 1, 1))
		e.Transparency = NumberSequence.new(0.2)
	else
		e.Rate = 600
		e.Speed = NumberRange.new(60, 80)
		e.Lifetime = NumberRange.new(0.6, 0.9)
		e.Size = NumberSequence.new(0.08)
		e.Color = ColorSequence.new(Color3.fromRGB(170, 190, 220))
		e.Transparency = NumberSequence.new(0.4)
	end
end

local function fadeTransition()
	local gui = fadeGui
	if not gui then
		local playerGui = game:GetService("Players").LocalPlayer:FindFirstChildOfClass("PlayerGui")
		if not playerGui then
			return
		end
		gui = Instance.new("ScreenGui")
		gui.Name = "KingdomDayFade"
		gui.IgnoreGuiInset = true
		gui.DisplayOrder = 100
		gui.Parent = playerGui
		local frame = Instance.new("Frame")
		frame.Name = "Fade"
		frame.BackgroundColor3 = Color3.new(0, 0, 0)
		frame.BackgroundTransparency = 1
		frame.Size = UDim2.fromScale(1, 1)
		frame.Parent = gui
		fadeGui = gui
	end
	local frame = gui:FindFirstChild("Fade") :: Frame
	local half = TimeConfig.DayTransitionSeconds / 2
	TweenService:Create(frame, TweenInfo.new(half), { BackgroundTransparency = 0 }):Play()
	task.delay(half, function()
		TweenService:Create(frame, TweenInfo.new(half), { BackgroundTransparency = 1 }):Play()
	end)
end

local thunderAt = 0

function LightingController.Update()
	local clock = Clock.Get()
	if not clock then
		return
	end
	if lastDay and clock.Day ~= lastDay then
		fadeTransition()
	end
	lastDay = clock.Day

	local weatherId = root:GetAttribute("Weather")
	local weather = WeatherConfig.Enabled and type(weatherId) == "string" and WeatherConfig.States[weatherId] or nil
	local visual = weather and weather.Visual or {}

	local previous, nextFrame, t = keyframesAround(clock.Hour)
	Lighting.ClockTime = clock.Hour
	local brightness = value(previous, nextFrame, t, "Brightness")
	if brightness then
		Lighting.Brightness = brightness * (1 - (visual.DarkenBrightness or 0))
	end
	local ambient = value(previous, nextFrame, t, "Ambient")
	if ambient then
		Lighting.Ambient = ambient
	end
	local outdoor = value(previous, nextFrame, t, "OutdoorAmbient")
	if outdoor then
		Lighting.OutdoorAmbient = outdoor
	end
	local fogColor = value(previous, nextFrame, t, "FogColor")
	if fogColor then
		Lighting.FogColor = fogColor
	end
	local fogEnd = value(previous, nextFrame, t, "FogEnd")
	if fogEnd then
		Lighting.FogEnd = fogEnd * (visual.FogEndMultiplier or 1)
	end
	for _, key in ipairs({ "Brightness", "Contrast", "Saturation", "TintColor" }) do
		local v = value(previous, nextFrame, t, key, "ColorCorrection")
		if v ~= nil then
			(colorCorrection :: any)[key] = v
		end
	end
	for _, key in ipairs({ "Density", "Haze", "Color" }) do
		local v = value(previous, nextFrame, t, key, "Atmosphere")
		if v ~= nil then
			if key == "Density" and visual.FogEndMultiplier and visual.FogEndMultiplier < 1 then
				v = math.min(1, v + (1 - visual.FogEndMultiplier) * 0.3)
			end
			(atmosphere :: any)[key] = v
		end
	end

	setParticles(visual.Particles)
	local camera = workspace.CurrentCamera
	if particlePart and camera then
		particlePart.CFrame = CFrame.new(camera.CFrame.Position + Vector3.new(0, 30, 0))
	end
	if visual.Thunder and os.clock() > thunderAt then
		thunderAt = os.clock() + math.random(8, 20)
		local original = colorCorrection.Brightness
		colorCorrection.Brightness = original + 0.5
		task.delay(0.12, function()
			colorCorrection.Brightness = original
		end)
	end
end

function LightingController.Init()
	if not TimeConfig.Lighting.Enabled then
		return
	end
	ensureObjects()
	local accumulator = 0
	RunService.Heartbeat:Connect(function(dt)
		accumulator += dt
		if accumulator >= 0.1 then
			accumulator = 0
			LightingController.Update()
		end
	end)
end

return LightingController
