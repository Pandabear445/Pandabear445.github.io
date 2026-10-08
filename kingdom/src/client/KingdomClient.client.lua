--[[
	Medieval Kingdom - client entry point.
	Builds the UI and starts the client controllers. Each piece starts in
	isolation so one failure never takes the whole interface down.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local root = ReplicatedStorage:WaitForChild("Kingdom")
root:WaitForChild("Remotes", 30)

local Controllers = script.Parent:WaitForChild("Controllers")
local UI = script.Parent:WaitForChild("UI")

local function start(label: string, fn: () -> ())
	local ok, err = pcall(fn)
	if not ok then
		warn(string.format("[KingdomClient] %s failed: %s", label, tostring(err)))
	end
end

local ClientState = require(Controllers.ClientState)
local App = require(UI.App)
local Notifications = require(UI.Notifications)
local HUD = require(UI.HUD)

start("State", ClientState.Init)
start("App", App.Init)
start("Notifications", Notifications.Init)
start("HUD", HUD.Init)

local windowModules = {}
local WINDOW_ORDER = {
	"Queue",
	"Kingdom",
	"Meetings",
	"Inventory",
	"Orders",
	"Management",
	"Government",
	"Market",
	"Career",
	"Store",
	"Admin",
	"Storage",
	"Trade",
}
for _, name in ipairs(WINDOW_ORDER) do
	start("Window " .. name, function()
		local module = require(UI.Windows:WaitForChild(name))
		windowModules[name] = module
		App.Register(name, module)
	end)
end

start("Effects", function()
	require(Controllers.Effects).Init(windowModules)
end)
start("Lighting", function()
	require(Controllers.LightingController).Init()
end)
start("ChatTags", function()
	require(Controllers.ChatTags).Init()
end)
start("PromptFilter", function()
	require(Controllers.PromptFilter).Init()
end)
start("Combat", function()
	require(Controllers.CombatInput).Init()
end)

-- Status changes (degraded systems, safe mode) refresh the side panel.
root.AttributeChanged:Connect(function(attribute)
	if string.sub(attribute, 1, 7) == "Status_" or attribute == "SavesDisabled" then
		HUD.Update()
	end
end)
Players.LocalPlayer.AttributeChanged:Connect(function()
	HUD.Update()
end)

task.spawn(function()
	local toolbarTimer = 0
	while true do
		task.wait(0.5)
		pcall(HUD.TickClock)
		pcall(App.Tick)
		toolbarTimer += 0.5
		if toolbarTimer >= 2 then
			toolbarTimer = 0
			pcall(App.RefreshToolbar)
		end
	end
end)
