--[[
	PromptFilter (client)
	Hides ProximityPrompts this player can't use (missing permission, not on
	guard duty, not a manager) so the world isn't cluttered. Purely visual:
	the server validates every interaction regardless.
]]

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")

local PromptFilter = {}

local player = Players.LocalPlayer
local TAG = "KingdomPrompt"

local function hasPermission(key: string): boolean
	local list = player:GetAttribute("KingdomPermissions")
	return type(list) == "string" and string.find("," .. list .. ",", "," .. key .. ",", 1, true) ~= nil
end

local function shouldShow(prompt: ProximityPrompt): boolean
	local permission = prompt:GetAttribute("KingdomPermission")
	if type(permission) == "string" and permission ~= "" and not hasPermission(permission) then
		return false
	end
	local audience = prompt:GetAttribute("KingdomAudience")
	if audience == "OnDuty" and not player:GetAttribute("KingdomOnDuty") then
		return false
	end
	if audience == "Manager" and (player:GetAttribute("KingdomManageDepth") or 0) <= 0 then
		return false
	end
	if audience == "Admin" and not player:GetAttribute("KingdomAdmin") then
		return false
	end
	return true
end

-- Remember what the SERVER wants (it toggles Enabled for depleted nodes,
-- growing crops...) separately from our local visibility filter.
local serverEnabled: { [ProximityPrompt]: boolean } = {}
local applying = false

local function apply(prompt: Instance)
	if not prompt:IsA("ProximityPrompt") then
		return
	end
	if serverEnabled[prompt] == nil then
		serverEnabled[prompt] = prompt.Enabled
		prompt:GetPropertyChangedSignal("Enabled"):Connect(function()
			if not applying then
				serverEnabled[prompt] = prompt.Enabled
				apply(prompt)
			end
		end)
		prompt.Destroying:Connect(function()
			serverEnabled[prompt] = nil
		end)
	end
	local desired = serverEnabled[prompt] and shouldShow(prompt)
	if prompt.Enabled ~= desired then
		applying = true
		prompt.Enabled = desired
		applying = false
	end
end

local function refreshAll()
	for _, prompt in ipairs(CollectionService:GetTagged(TAG)) do
		apply(prompt)
	end
end

function PromptFilter.Init()
	CollectionService:GetInstanceAddedSignal(TAG):Connect(apply)
	for _, attribute in ipairs({ "KingdomPermissions", "KingdomOnDuty", "KingdomManageDepth", "KingdomAdmin" }) do
		player:GetAttributeChangedSignal(attribute):Connect(refreshAll)
	end
	refreshAll()
	task.spawn(function()
		while true do
			task.wait(5)
			refreshAll()
		end
	end)
end

return PromptFilter
