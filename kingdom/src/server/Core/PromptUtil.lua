--[[
	PromptUtil
	Server-created ProximityPrompts with server-side hold timing.

	Roblox fires ProximityPrompt.Triggered on the server, but we never trust
	that alone: the server records when the hold began and passes the real
	held time to the handler, which rejects anything shorter than the job's
	duration (HoldTolerance). Distance is re-checked by the job code.

	Prompts carry attributes the client uses only for display filtering
	(KingdomPermission / KingdomAudience); the server re-validates everything.
]]

local CollectionService = game:GetService("CollectionService")

local PromptUtil = {}

local PROMPT_TAG = "KingdomPrompt"

export type PromptOptions = {
	Name: string?,
	ActionText: string,
	ObjectText: string?,
	HoldDuration: number?,
	MaxDistance: number?,
	KeyCode: Enum.KeyCode?,
	Permission: string?, -- client-side visibility hint
	Audience: string?, -- "Manager" | "OnDuty" | "Admin" (client hint)
	Exclusivity: Enum.ProximityPromptExclusivity?,
	UIOffset: Vector2?,
}

function PromptUtil.create(parent: Instance, options: PromptOptions): ProximityPrompt
	local prompt = Instance.new("ProximityPrompt")
	prompt.Name = options.Name or ("Prompt_" .. options.ActionText)
	prompt.ActionText = options.ActionText
	prompt.ObjectText = options.ObjectText or ""
	prompt.HoldDuration = options.HoldDuration or 0
	prompt.MaxActivationDistance = options.MaxDistance or 10
	prompt.RequiresLineOfSight = false
	prompt.KeyboardKeyCode = options.KeyCode or Enum.KeyCode.E
	prompt.Exclusivity = options.Exclusivity or Enum.ProximityPromptExclusivity.OnePerButton
	if options.UIOffset then
		prompt.UIOffset = options.UIOffset
	end
	if options.Permission then
		prompt:SetAttribute("KingdomPermission", options.Permission)
	end
	if options.Audience then
		prompt:SetAttribute("KingdomAudience", options.Audience)
	end
	prompt:AddTag(PROMPT_TAG)
	prompt.Parent = parent
	return prompt
end

-- handler(player, heldSeconds) runs in its own thread with errors isolated.
function PromptUtil.onTriggered(prompt: ProximityPrompt, handler: (Player, number) -> ())
	-- Weak keys: departed players are collected without a PlayerRemoving
	-- connection per prompt (maps can have thousands of prompts).
	local holdStarted: { [Player]: number } = setmetatable({}, { __mode = "k" }) :: any
	prompt.PromptButtonHoldBegan:Connect(function(player)
		holdStarted[player] = os.clock()
	end)
	prompt.PromptButtonHoldEnded:Connect(function(player)
		-- Keep the start time briefly: Triggered fires right after HoldEnded.
		local started = holdStarted[player]
		task.delay(0.5, function()
			if holdStarted[player] == started then
				holdStarted[player] = nil
			end
		end)
	end)
	prompt.Triggered:Connect(function(player)
		local started = holdStarted[player]
		holdStarted[player] = nil
		local held = started and (os.clock() - started) or 0
		if prompt.HoldDuration <= 0 then
			held = math.huge
		end
		local ok, err = pcall(handler, player, held)
		if not ok then
			warn("[PromptUtil] handler error: " .. tostring(err))
		end
	end)
end

-- True when the server-measured hold covers the required duration.
function PromptUtil.heldLongEnough(held: number, required: number, tolerance: number): boolean
	if required <= 0 then
		return true
	end
	return held >= required * tolerance
end

-- Creates (or reuses) an invisible anchor part for prompts on zones/models.
function PromptUtil.anchorFor(instance: Instance, position: Vector3?): BasePart
	local existing = instance:FindFirstChild("KingdomPromptAnchor")
	if existing and existing:IsA("BasePart") then
		return existing
	end
	local anchor = Instance.new("Part")
	anchor.Name = "KingdomPromptAnchor"
	anchor.Size = Vector3.new(1, 1, 1)
	anchor.Transparency = 1
	anchor.Anchored = true
	anchor.CanCollide = false
	anchor.CanQuery = false
	anchor.CanTouch = false
	if position then
		anchor.Position = position
	elseif instance:IsA("BasePart") then
		anchor.Position = instance.Position
	elseif instance:IsA("Model") then
		local ok, cframe = pcall(function()
			return (instance :: Model):GetBoundingBox()
		end)
		anchor.Position = if ok then (cframe :: CFrame).Position else Vector3.zero
	end
	anchor.Parent = instance
	return anchor
end

function PromptUtil.tagged(): { Instance }
	return CollectionService:GetTagged(PROMPT_TAG)
end

return PromptUtil
