--[[
	CombatInput (client)
	When a weapon tool is used, ask the server to swing. The server decides
	whether anything was hit and for how much.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ItemConfig = require(ReplicatedStorage.Kingdom.Config.ItemConfig)
local ClientNet = require(script.Parent.ClientNet)

local CombatInput = {}

local player = Players.LocalPlayer

local function watchTool(tool: Instance)
	if not tool:IsA("Tool") or tool:GetAttribute("KingdomCombatHooked") then
		return
	end
	local toolId = tool:GetAttribute("KingdomTool")
	local def = toolId and ItemConfig.Get(toolId)
	if not def or not def.Weapon then
		return
	end
	tool:SetAttribute("KingdomCombatHooked", true)
	tool.Activated:Connect(function()
		ClientNet.Input("Swing")
	end)
end

function CombatInput.Init()
	local function onCharacter(character: Model)
		for _, child in ipairs(character:GetChildren()) do
			watchTool(child)
		end
		character.ChildAdded:Connect(watchTool)
	end
	player.CharacterAdded:Connect(onCharacter)
	if player.Character then
		onCharacter(player.Character)
	end
end

return CombatInput
