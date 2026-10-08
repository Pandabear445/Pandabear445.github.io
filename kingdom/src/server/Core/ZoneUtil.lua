--[[
	ZoneUtil
	Spatial helpers for markers placed by the map builder. A marker can be a
	BasePart (oriented box) or a Model (bounding box).
]]

local Players = game:GetService("Players")

local ZoneUtil = {}

function ZoneUtil.getRoot(player: Player): BasePart?
	local character = player.Character
	if not character then
		return nil
	end
	local root = character:FindFirstChild("HumanoidRootPart")
	if root and root:IsA("BasePart") then
		return root
	end
	return nil
end

function ZoneUtil.getHumanoid(player: Player): Humanoid?
	local character = player.Character
	return character and character:FindFirstChildOfClass("Humanoid") or nil
end

function ZoneUtil.isAlive(player: Player): boolean
	local humanoid = ZoneUtil.getHumanoid(player)
	return humanoid ~= nil and humanoid.Health > 0 and ZoneUtil.getRoot(player) ~= nil
end

-- Returns CFrame + size describing the marker's volume.
function ZoneUtil.getBox(instance: Instance): (CFrame?, Vector3?)
	if instance:IsA("BasePart") then
		return instance.CFrame, instance.Size
	elseif instance:IsA("Model") then
		local ok, cframe, size = pcall(instance.GetBoundingBox, instance)
		if ok then
			return cframe, size
		end
	elseif instance:IsA("Attachment") then
		return instance.WorldCFrame, Vector3.new(4, 4, 4)
	end
	return nil, nil
end

function ZoneUtil.getPosition(instance: Instance): Vector3?
	local cframe = ZoneUtil.getBox(instance)
	return cframe and cframe.Position or nil
end

function ZoneUtil.containsPoint(instance: Instance, point: Vector3, padding): boolean
	local cframe, size = ZoneUtil.getBox(instance)
	if not cframe or not size then
		return false
	end
	padding = padding or 0
	local localPoint = cframe:PointToObjectSpace(point)
	local half = size / 2
	-- Generous vertical tolerance: zones are often flat floor parts.
	local verticalPad = padding + math.max(8, half.Y)
	return math.abs(localPoint.X) <= half.X + padding
		and math.abs(localPoint.Z) <= half.Z + padding
		and math.abs(localPoint.Y) <= half.Y + verticalPad
end

-- Distance from a point to the closest point of the marker's box.
function ZoneUtil.distanceTo(instance: Instance, point: Vector3): number
	local cframe, size = ZoneUtil.getBox(instance)
	if not cframe or not size then
		return math.huge
	end
	local localPoint = cframe:PointToObjectSpace(point)
	local half = size / 2
	local clamped = Vector3.new(
		math.clamp(localPoint.X, -half.X, half.X),
		math.clamp(localPoint.Y, -half.Y, half.Y),
		math.clamp(localPoint.Z, -half.Z, half.Z)
	)
	return (localPoint - clamped).Magnitude
end

function ZoneUtil.playerDistance(player: Player, instance: Instance): number
	local root = ZoneUtil.getRoot(player)
	if not root then
		return math.huge
	end
	return ZoneUtil.distanceTo(instance, root.Position)
end

function ZoneUtil.playerInside(player: Player, instance: Instance, padding: number?): boolean
	local root = ZoneUtil.getRoot(player)
	return root ~= nil and ZoneUtil.containsPoint(instance, root.Position, padding)
end

function ZoneUtil.playersInside(instance: Instance, padding: number?): { Player }
	local result = {}
	for _, player in ipairs(Players:GetPlayers()) do
		if ZoneUtil.playerInside(player, instance, padding) then
			table.insert(result, player)
		end
	end
	return result
end

-- Picks the part a ProximityPrompt can be parented to.
function ZoneUtil.getPromptParent(instance: Instance): Instance?
	if instance:IsA("BasePart") or instance:IsA("Attachment") then
		return instance
	elseif instance:IsA("Model") then
		if instance.PrimaryPart then
			return instance.PrimaryPart
		end
		return instance:FindFirstChildWhichIsA("BasePart", true)
	end
	return nil
end

function ZoneUtil.findTaggedAncestor(instance: Instance, tag: string): Instance?
	local current = instance.Parent
	while current and current ~= workspace do
		if current:HasTag(tag) then
			return current
		end
		current = current.Parent
	end
	return nil
end

function ZoneUtil.readAttribute(instance: Instance, name: string, default: any): any
	local value = instance:GetAttribute(name)
	if value == nil then
		return default
	end
	if default ~= nil and type(value) ~= type(default) then
		return default
	end
	return value
end

return ZoneUtil
