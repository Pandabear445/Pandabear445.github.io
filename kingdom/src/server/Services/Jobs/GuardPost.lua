--[[
	GuardPost (job kind)
	Guard duty is active work, never "stand here for XP":
	  * Begin watch at a KingdomGuardPost (Job.Security permission).
	  * Patrol: visit KingdomPatrolPoint markers ("Check post"). Each new
	    point in a circuit pays XP; completing the circuit pays a bonus.
	    Points can be grouped per post with a matching "Route" attribute.
	  * Watch checks: at random intervals the guard is called back to the
	    post and must answer within WatchCheckWindow. Missing it is a mistake;
	    three misses end the shift.
	  * Leaving the post area (and the patrol route) for too long ends duty.
	Guards on duty raise the kingdom's Security need, and answered watch
	checks count as "defend" actions during bandit events.
]]

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")

local GuardPost = {}

local duty = {} -- [Player] = record
local patrolPoints = {} -- [Instance] = station

local function routeOf(instance: Instance): string
	local route = instance:GetAttribute("Route")
	return type(route) == "string" and route or ""
end

function GuardPost.Attach(ctx, instance: Instance, job)
	local station: any = {}
	local parent = (instance:IsA("BasePart") and instance) or ctx.PromptUtil.anchorFor(instance)
	station.Anchor = parent
	station.Prompt = ctx.PromptUtil.create(parent, {
		Name = "KingdomGuard",
		ActionText = "Begin watch",
		ObjectText = instance.Name,
		HoldDuration = 1.5,
		MaxDistance = 12,
		Permission = job.Permission,
	})
	ctx.PromptUtil.onTriggered(station.Prompt, function(player, held)
		if not ctx.PromptUtil.heldLongEnough(held, 1.5, ctx.Config.Session.HoldTolerance) then
			return
		end
		local record = duty[player]
		if record and record.post == station then
			GuardPost.Answer(ctx, player, record)
		elseif record then
			ctx:Feedback(player, false, "You are already on watch at another post.")
		else
			GuardPost.Begin(ctx, player, station)
		end
	end)
	station.EndPrompt = ctx.PromptUtil.create(parent, {
		Name = "KingdomGuardEnd",
		ActionText = "End watch",
		HoldDuration = 1,
		MaxDistance = 12,
		KeyCode = Enum.KeyCode.F,
		Audience = "OnDuty",
		UIOffset = Vector2.new(0, 60),
	})
	ctx.PromptUtil.onTriggered(station.EndPrompt, function(player)
		if duty[player] and duty[player].post == station then
			GuardPost.End(ctx, player, "You ended your watch.")
		end
	end)
	return station
end

function GuardPost.AfterAttach(ctx)
	local function addPoint(point: Instance)
		if patrolPoints[point] then
			return
		end
		local parent = (point:IsA("BasePart") and point) or ctx.PromptUtil.anchorFor(point)
		local prompt = ctx.PromptUtil.create(parent, {
			Name = "KingdomPatrol",
			ActionText = "Check post",
			ObjectText = point.Name,
			HoldDuration = 1.5,
			MaxDistance = 10,
			Audience = "OnDuty",
		})
		patrolPoints[point] = { anchor = parent, route = routeOf(point) }
		ctx.PromptUtil.onTriggered(prompt, function(player, held)
			if ctx.PromptUtil.heldLongEnough(held, 1.5, ctx.Config.Session.HoldTolerance) then
				GuardPost.Patrol(ctx, player, point)
			end
		end)
	end
	local tag = ctx.Config.Jobs.GuardDuty.PatrolTag
	for _, point in ipairs(CollectionService:GetTagged(tag)) do
		addPoint(point)
	end
	CollectionService:GetInstanceAddedSignal(tag):Connect(addPoint)
end

local function routePoints(post): { Instance }
	local route = routeOf(post.Instance)
	local list = {}
	for point, info in pairs(patrolPoints) do
		if point.Parent and (route == "" or info.route == route) then
			table.insert(list, point)
		end
	end
	return list
end

local function scheduleCheck(job, record)
	local range = job.WatchCheckInterval
	record.nextCheckAt = os.clock() + range[1] + math.random() * (range[2] - range[1])
	record.checkDeadline = nil
end

function GuardPost.Begin(ctx, player: Player, station)
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	if not ctx:HasCapacity(player, station.Instance, ctx:Attr(station.Instance, station.Job, "MaxWorkers", 2)) then
		ctx:Feedback(player, false, "This post is fully manned. Find another.")
		return
	end
	local record = {
		post = station,
		startedAt = os.clock(),
		visited = {},
		visitedCount = 0,
		missed = 0,
		awayFor = 0,
		answered = 0,
	}
	scheduleCheck(station.Job, record)
	duty[player] = record
	player:SetAttribute("KingdomOnDuty", true)
	ctx.Activity:MarkInteraction(player)
	local points = #routePoints(station)
	ctx.Notify:Notify(
		player,
		"Job",
		"On watch",
		points > 0 and string.format("Patrol %d checkpoints and answer watch calls at your post.", points)
			or "Answer watch calls at your post."
	)
end

function GuardPost.End(ctx, player: Player, message: string?)
	if not duty[player] then
		return
	end
	duty[player] = nil
	player:SetAttribute("KingdomOnDuty", false)
	ctx.Net.Fire("Effect", player, "WatchCheck", { Active = false })
	if message then
		ctx.Notify:Notify(player, "Job", "Watch ended", message)
	end
end

function GuardPost.Patrol(ctx, player: Player, point: Instance)
	local record = duty[player]
	if not record then
		ctx:Feedback(player, false, "Begin a watch at a guard post first.")
		return
	end
	local station = record.post
	local route = routeOf(station.Instance)
	local info = patrolPoints[point]
	if not info or (route ~= "" and info.route ~= route) then
		ctx:Feedback(player, false, "This checkpoint is not on your route.")
		return
	end
	if record.visited[point] then
		ctx:Feedback(player, false, "You already checked this point. Continue the circuit.")
		return
	end
	local ok, reason = ctx:Validate(player, station, { anchor = info.anchor, maxDistance = 12 })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	record.visited[point] = true
	record.visitedCount += 1
	local job = station.Job
	local total = #routePoints(station)
	local circuitDone = record.visitedCount >= total and total > 0
	local xp = job.PatrolXP + (circuitDone and job.CircuitBonusXP or 0)
	if circuitDone then
		record.visited = {}
		record.visitedCount = 0
	end
	ctx:Complete(player, station, {
		xpOverride = xp,
		wageShare = circuitDone and 1 or 0.3,
		label = circuitDone and "Patrol circuit complete" or string.format("Patrol %d/%d", record.visitedCount, total),
		extra = { patrol = true },
	})
end

function GuardPost.Answer(ctx, player: Player, record)
	if not record.checkDeadline then
		ctx:Feedback(player, true, "All quiet. Keep patrolling.")
		return
	end
	local station = record.post
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor, skipTravel = true })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	local remaining = record.checkDeadline - os.clock()
	local job = station.Job
	scheduleCheck(job, record)
	record.answered += 1
	ctx.Net.Fire("Effect", player, "WatchCheck", { Active = false })
	ctx:Complete(player, station, {
		skill = remaining > job.WatchCheckWindow * 0.5 and 0.15 or 0,
		label = "Watch call answered",
		extra = { defend = true },
	})
end

function GuardPost.RealTick(ctx)
	local now = os.clock()
	for player, record in pairs(duty) do
		if player.Parent ~= Players or not ctx.ZoneUtil.isAlive(player) then
			duty[player] = nil
		else
			local station = record.post
			local job = station.Job
			-- Watch calls.
			if record.checkDeadline then
				if now > record.checkDeadline then
					record.missed += 1
					scheduleCheck(job, record)
					ctx:Mistake(player, station, "You missed a watch call at your post!")
					ctx.Net.Fire("Effect", player, "WatchCheck", { Active = false })
					if record.missed >= 3 then
						GuardPost.End(ctx, player, "Relieved of duty after missing three watch calls.")
					end
				end
			elseif now >= record.nextCheckAt then
				record.checkDeadline = now + job.WatchCheckWindow
				ctx.Net.Fire("Effect", player, "WatchCheck", {
					Active = true,
					Seconds = job.WatchCheckWindow,
					Post = station.Instance.Name,
				})
			end
			-- Abandoning the post.
			local radius = ctx:Attr(station.Instance, job, "PostRadius", 30)
			local nearPost = ctx.ZoneUtil.playerDistance(player, station.Anchor) <= radius
			local nearRoute = false
			if not nearPost then
				for _, point in ipairs(routePoints(station)) do
					if ctx.ZoneUtil.playerDistance(player, point) <= 25 then
						nearRoute = true
						break
					end
				end
			end
			if nearPost or nearRoute then
				record.awayFor = 0
			else
				record.awayFor += 1
				if record.awayFor >= job.LeavePostGraceSeconds then
					GuardPost.End(ctx, player, "You left your post and route.")
				end
			end
		end
	end
end

function GuardPost.Cancel(ctx, player: Player)
	GuardPost.End(ctx, player, nil)
end

function GuardPost.CountOnDuty(): number
	local count = 0
	for player in pairs(duty) do
		if player.Parent == Players then
			count += 1
		end
	end
	return count
end

function GuardPost.IsOnDuty(_, player: Player): boolean
	return duty[player] ~= nil
end

function GuardPost.GetOnDuty(): { Player }
	local list = {}
	for player in pairs(duty) do
		table.insert(list, player)
	end
	return list
end

return GuardPost
