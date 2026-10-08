--[[
	FishingSpot (job kind)
	Cast -> wait for a bite -> react in time -> catch.

	1. Player holds "Cast line" at a KingdomFishing marker (needs a rod).
	2. The server picks a secret bite time and tells the client only when
	   the bite happens (Effect "FishingBite").
	3. The client sends Job.Interact { action = "Reel" } and the server checks
	   the timing against its own clock: too early = mistake, too late = the
	   fish escapes (mistake), fast reactions earn a skill bonus.
	The player must stay at the spot; walking away cancels the cast.
]]

local Players = game:GetService("Players")

local FishingSpot = {}

local casts = {} -- [Player] = cast

function FishingSpot.Attach(ctx, instance: Instance, job)
	local station: any = {}
	local parent = (instance:IsA("BasePart") and instance) or ctx.PromptUtil.anchorFor(instance)
	station.Anchor = parent
	station.Prompt = ctx.PromptUtil.create(parent, {
		Name = "KingdomFish",
		ActionText = "Cast line",
		ObjectText = "Fishing spot · needs Fishing Rod",
		HoldDuration = 0.6,
		MaxDistance = 14,
		Permission = ctx:Attr(instance, job, "RequiredPermission", job.Permission),
	})
	ctx.PromptUtil.onTriggered(station.Prompt, function(player)
		FishingSpot.Cast(ctx, player, station)
	end)
	return station
end

function FishingSpot.Cast(ctx, player: Player, station)
	local job = station.Job
	if casts[player] then
		ctx:Feedback(player, false, "Your line is already in the water.")
		return
	end
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor, maxDistance = 16 })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	if not ctx:HasCapacity(player, station.Instance, ctx:Attr(station.Instance, job, "MaxWorkers", 0)) then
		ctx:Feedback(player, false, "This spot is crowded. Find another.")
		return
	end
	local rod = ctx:Attr(station.Instance, job, "RequiredTool", "FishingRod")
	local uid = ctx.Inventory:GetBestTool(player, rod)
	if rod ~= "" and not uid then
		ctx:Feedback(player, false, "You need a working " .. ctx:ToolDisplay(rod) .. ".")
		return
	end
	local delayRange = job.BiteDelay
	local biteDelay = delayRange[1] + math.random() * (delayRange[2] - delayRange[1])
	local cast = {
		id = ctx:NewSessionId(),
		station = station,
		castAt = os.clock(),
		biteAt = os.clock() + biteDelay,
		window = job.ReelWindow,
		notified = false,
	}
	casts[player] = cast
	ctx.Activity:MarkInteraction(player)
	ctx.Net.Fire("Effect", player, "FishingCast", { Station = station.Id, Session = cast.id })
	-- The bite is timed precisely; reaction time is measured from the moment
	-- the server tells the client, so network/tick latency is not punished.
	task.delay(biteDelay, function()
		if casts[player] == cast and not cast.notified then
			cast.notified = true
			cast.notifiedAt = os.clock()
			ctx.Net.Fire("Effect", player, "FishingBite", { Station = station.Id, Session = cast.id, Window = cast.window })
		end
	end)
end

function FishingSpot.HandleAction(ctx, player: Player, station, payload)
	if payload.action ~= "Reel" then
		return false, "Unknown action."
	end
	local cast = casts[player]
	if not cast or cast.station ~= station or payload.session ~= cast.id then
		return false, "You are not fishing here."
	end
	casts[player] = nil
	local now = os.clock()
	local job = station.Job
	if not cast.notified or not cast.notifiedAt then
		ctx:Mistake(player, station, "Too early! You pulled the line before a bite.")
		return false, "Too early."
	end
	local reaction = now - cast.notifiedAt
	if reaction > cast.window then
		ctx:Mistake(player, station, "Too slow - the fish got away.")
		return false, "It got away."
	end
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor, maxDistance = 18, skipTravel = true })
	if not ok then
		return false, reason
	end
	local toolOk, efficiency, toolReason, tool = ctx.Inventory:UseTool(player, ctx:Attr(station.Instance, job, "RequiredTool", "FishingRod"))
	if not toolOk then
		return false, toolReason
	end
	local skill = 0
	if reaction <= job.PerfectReaction then
		skill = 0.3
	elseif reaction <= cast.window * 0.6 then
		skill = 0.12
	end
	local productivity = ctx:GetProductivity(player, station) * math.max(efficiency, 0.1)
	local minYield = ctx:Attr(station.Instance, job, "YieldMin", 1)
	local amount = math.random(minYield, math.max(minYield, ctx:Attr(station.Instance, job, "YieldMax", 2)))
	local resource = ctx:Attr(station.Instance, job, "ResourceReward", "Fish")
	ctx:Complete(player, station, {
		yields = { [resource] = math.max(ctx.ScaleYield(amount, productivity), 1) },
		skill = skill,
		tool = tool,
		label = skill >= 0.3 and "Perfect catch!" or "Fishing",
	})
	return true, "Caught!"
end

-- Bite notifications and abandoned casts (real-time tick).
function FishingSpot.RealTick(ctx)
	local now = os.clock()
	for player, cast in pairs(casts) do
		if player.Parent ~= Players then
			casts[player] = nil
		elseif ctx.ZoneUtil.playerDistance(player, cast.station.Anchor) > 22 or not ctx.ZoneUtil.isAlive(player) then
			casts[player] = nil
			ctx.Net.Fire("Effect", player, "FishingEnd", { Reason = "You walked away from your line." })
		elseif cast.notified and cast.notifiedAt and now > cast.notifiedAt + cast.window + 1.5 then
			casts[player] = nil
			ctx:Mistake(player, cast.station, "The fish got away.")
			ctx.Net.Fire("Effect", player, "FishingEnd", { Reason = "The fish got away." })
		end
	end
end

function FishingSpot.Cancel(ctx, player: Player)
	if casts[player] then
		casts[player] = nil
		ctx.Net.Fire("Effect", player, "FishingEnd", { Reason = "" })
	end
end

return FishingSpot
