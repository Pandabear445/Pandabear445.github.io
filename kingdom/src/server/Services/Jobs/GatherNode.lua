--[[
	GatherNode (job kind)
	Mining, quarrying, logging, hunting, wells, cleaning.

	A node is a tagged Part/Model. The player must stand at the node (and
	inside its zone, e.g. KingdomMine / KingdomForest, when one contains it),
	hold the prompt for WorkDuration (timed by the server), have the tool,
	and the node must have uses left. Depleted nodes recover after Cooldown.

	A KingdomMine / KingdomForest zone without any nodes inside acts as one
	big node so a map can start simple.

	Marker attributes: ResourceReward, XPReward, Wage, RequiredTool,
	WorkDuration, Cooldown, NodeUses, YieldMin, YieldMax, MaxWorkers,
	QualityMultiplier, RequiredRank, RequiredPermission, RequiredDepartment
]]

local CollectionService = game:GetService("CollectionService")

local GatherNode = {}

local function findZone(ctx, instance: Instance, job): Instance?
	for _, zoneTag in ipairs(job.ZoneTags or {}) do
		local ancestor = ctx.ZoneUtil.findTaggedAncestor(instance, zoneTag)
		if ancestor then
			return ancestor
		end
		local position = ctx.ZoneUtil.getPosition(instance)
		if position then
			for _, zone in ipairs(CollectionService:GetTagged(zoneTag)) do
				if zone ~= instance and ctx.ZoneUtil.containsPoint(zone, position, 2) then
					return zone
				end
			end
		end
	end
	return nil
end

local function setVisible(instance: Instance, visible: boolean)
	local parts = {}
	if instance:IsA("BasePart") then
		table.insert(parts, instance)
	end
	for _, descendant in ipairs(instance:GetDescendants()) do
		if descendant:IsA("BasePart") and descendant.Name ~= "KingdomPromptAnchor" then
			table.insert(parts, descendant)
		end
	end
	for _, part in ipairs(parts) do
		local original = part:GetAttribute("KingdomOriginalTransparency")
		if original == nil then
			original = part.Transparency
			part:SetAttribute("KingdomOriginalTransparency", original)
		end
		part.Transparency = visible and original or math.max(original, 0.75)
	end
end

function GatherNode.Attach(ctx, instance: Instance, job, zoneOverride: Instance?)
	local station: any = {
		Zone = zoneOverride or findZone(ctx, instance, job),
		UsesLeft = ctx:Attr(instance, job, "NodeUses", 0),
		DepletedUntil = 0,
	}
	local parent = (instance:IsA("BasePart") and instance) or ctx.PromptUtil.anchorFor(instance)
	station.Anchor = parent
	local duration = ctx:Attr(instance, job, "WorkDuration", 3)
	local tool = ctx:Attr(instance, job, "RequiredTool", "")
	local object = job.DisplayName
	if tool ~= "" then
		object ..= " · needs " .. ctx:ToolDisplay(tool)
	end
	if job.Dangerous then
		object ..= " · DANGEROUS"
	end
	station.Prompt = ctx.PromptUtil.create(parent, {
		Name = "KingdomWork",
		ActionText = job.VerbText or "Work",
		ObjectText = object,
		HoldDuration = duration,
		MaxDistance = 12,
		Permission = ctx:Attr(instance, job, "RequiredPermission", job.Permission),
	})
	ctx.PromptUtil.onTriggered(station.Prompt, function(player, held)
		GatherNode.Work(ctx, player, station, held)
	end)
	return station
end

function GatherNode.Work(ctx, player: Player, station, held: number)
	local job = station.Job
	local instance = station.Instance
	local duration = ctx:Attr(instance, job, "WorkDuration", 3)
	if not ctx.PromptUtil.heldLongEnough(held, duration, ctx.Config.Session.HoldTolerance) then
		return
	end
	local now = os.clock()
	if now < station.DepletedUntil then
		ctx:Feedback(player, false, "This spot is exhausted for now.")
		return
	end
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	local capacityKey = station.Zone or instance
	if not ctx:HasCapacity(player, capacityKey, ctx:Attr(instance, job, "MaxWorkers", 0)) then
		ctx:Feedback(player, false, "Too many workers here already. Try another workplace.")
		return
	end
	local toolOk, efficiency, toolReason, tool = ctx.Inventory:UseTool(player, ctx:Attr(instance, job, "RequiredTool", ""))
	if not toolOk then
		ctx:Feedback(player, false, toolReason)
		return
	end

	-- Deplete.
	local maxUses = ctx:Attr(instance, job, "NodeUses", 0)
	if maxUses > 0 then
		station.UsesLeft -= 1
		if station.UsesLeft <= 0 then
			station.DepletedUntil = now + ctx:Attr(instance, job, "Cooldown", 30)
			station.Prompt.Enabled = false
			if job.HideWhenDepleted then
				setVisible(instance, false)
			end
			task.delay(ctx:Attr(instance, job, "Cooldown", 30), function()
				if instance.Parent then
					station.UsesLeft = maxUses
					station.DepletedUntil = 0
					station.Prompt.Enabled = true
					setVisible(instance, true)
				end
			end)
		end
	end

	-- Yields.
	local productivity = ctx:GetProductivity(player, station) * math.max(efficiency, 0.1)
	local yields = {}
	local resource = ctx:Attr(instance, job, "ResourceReward", "")
	if resource ~= "" then
		local amount = math.random(ctx:Attr(instance, job, "YieldMin", 1), math.max(ctx:Attr(instance, job, "YieldMin", 1), ctx:Attr(instance, job, "YieldMax", 1)))
		yields[resource] = ctx.ScaleYield(amount, productivity)
	end
	for _, drop in ipairs(job.BonusDrops or {}) do
		if math.random() < drop.Chance * math.min(productivity, 1.5) then
			yields[drop.Resource] = (yields[drop.Resource] or 0) + math.random(drop.Min, drop.Max)
		end
	end

	-- Upkeep jobs repair the building they are in.
	if job.RepairsNearbyBuilding then
		local building = ctx.Buildings:FindBuilding(instance)
		if building then
			local current = building:GetAttribute("Condition") or 100
			ctx.Buildings:SetCondition(building, current + job.RepairsNearbyBuilding, "Cleaning")
		end
	end

	ctx:Complete(player, station, { yields = yields, tool = tool })

	-- Understandable danger: injuries are announced on the prompt.
	if job.Injury and math.random() < job.Injury.Chance then
		local damage = math.random(job.Injury.MinDamage, job.Injury.MaxDamage)
		ctx.Character:Damage(player, damage, job.Injury.Cause)
		ctx.Notify:Notify(player, "Warning", "Injured!", string.format("%s (-%d health). Rest or eat to recover.", job.Injury.Cause, damage))
	end
end

-- Zones with no nodes become a single node.
function GatherNode.AfterAttach(ctx)
	for _, job in pairs(ctx.Config.Jobs) do
		if job.Kind == "GatherNode" and job.ZoneAsNodeTag then
			for _, zone in ipairs(CollectionService:GetTagged(job.ZoneAsNodeTag)) do
				local hasNode = false
				for _, nodeTag in ipairs(job.Tags) do
					for _, node in ipairs(CollectionService:GetTagged(nodeTag)) do
						if node:IsDescendantOf(zone) or ctx.ZoneUtil.containsPoint(zone, ctx.ZoneUtil.getPosition(node) or Vector3.zero, 2) then
							hasNode = true
							break
						end
					end
					if hasNode then
						break
					end
				end
				if not hasNode and not zone:GetAttribute("KingdomStationId") then
					local station = GatherNode.Attach(ctx, zone, job, zone)
					ctx:RegisterStation(station, zone, job, "GatherNode")
				end
			end
		end
	end
end

return GatherNode
