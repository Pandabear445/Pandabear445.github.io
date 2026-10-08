--[[
	CraftStation (job kind)
	Kitchens, bakeries, mills, smokehouses, smelters, blacksmiths,
	apothecaries, tailors, woodsheds.

	One prompt per recipe ("Bake Bread"). Inputs come from the worker's
	inventory; any shortfall may be drawn from kingdom storage if their rank
	has Storage.Withdraw (limited per in-game hour). Outputs go into the
	worker's inventory and must be delivered to storage.

	Blacksmiths also run a REPAIR QUEUE: anyone can leave a damaged tool
	(paying a fee held in escrow); a smith works the queue, using iron, and
	the repaired tool returns to its owner (even after a rejoin).

	Marker attributes: Recipes ("Bread,Meal" to limit), XPReward, Wage,
	RequiredTool, MaxWorkers, QualityMultiplier, RequiredRank, ...
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ItemConfig = require(ReplicatedStorage.Kingdom.Config.ItemConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)

local CraftStation = {}

local function describe(items): string
	local parts = {}
	for resourceId, amount in pairs(items) do
		local def = ResourceConfig.Resources[resourceId]
		table.insert(parts, string.format("%d %s", amount, def and def.DisplayName or resourceId))
	end
	table.sort(parts)
	return table.concat(parts, ", ")
end

local function allowedRecipes(instance: Instance, job): { string }
	local filter = instance:GetAttribute("Recipes")
	local list = {}
	for recipeId in pairs(job.Recipes) do
		if type(filter) ~= "string" or filter == "" or string.find("," .. filter .. ",", "," .. recipeId .. ",", 1, true) then
			table.insert(list, recipeId)
		end
	end
	table.sort(list)
	return list
end

function CraftStation.Attach(ctx, instance: Instance, job)
	local station: any = { Queue = {} }
	local parent = (instance:IsA("BasePart") and instance) or ctx.PromptUtil.anchorFor(instance)
	station.Anchor = parent
	station.Prompts = {}
	for index, recipeId in ipairs(allowedRecipes(instance, job)) do
		if index > 4 then
			break -- keep the prompt stack readable; split recipes across markers
		end
		local recipe = job.Recipes[recipeId]
		local prompt = ctx.PromptUtil.create(parent, {
			Name = "KingdomCraft_" .. recipeId,
			ActionText = recipe.DisplayName or (job.DisplayName .. ": " .. recipeId),
			ObjectText = describe(recipe.Inputs),
			HoldDuration = recipe.Duration,
			MaxDistance = 12,
			Permission = ctx:Attr(instance, job, "RequiredPermission", job.Permission),
		})
		station.Prompts[recipeId] = prompt
		ctx.PromptUtil.onTriggered(prompt, function(player, held)
			CraftStation.Craft(ctx, player, station, recipeId, held)
		end)
	end
	if job.RepairQueue then
		CraftStation._setupRepairs(ctx, station, parent)
	end
	return station
end

function CraftStation.Craft(ctx, player: Player, station, recipeId: string, held: number)
	local job = station.Job
	local recipe = job.Recipes[recipeId]
	if not ctx.PromptUtil.heldLongEnough(held, recipe.Duration, ctx.Config.Session.HoldTolerance) then
		return
	end
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	if not ctx:HasCapacity(player, station.Instance, ctx:Attr(station.Instance, job, "MaxWorkers", 0)) then
		ctx:Feedback(player, false, "This station is busy.")
		return
	end

	-- Room for outputs first, so inputs are never consumed for nothing.
	for resourceId, amount in pairs(recipe.Outputs) do
		if ctx.Inventory:RoomFor(player, resourceId) < amount then
			ctx:Feedback(player, false, "Your pack is too full for the result. Deliver goods first.")
			return
		end
	end

	-- Split inputs between inventory and storage.
	local fromInventory, fromStorage = {}, {}
	for resourceId, amount in pairs(recipe.Inputs) do
		local have = ctx.Inventory:Count(player, resourceId)
		local useOwn = math.min(have, amount)
		if useOwn > 0 then
			fromInventory[resourceId] = useOwn
		end
		if amount - useOwn > 0 then
			fromStorage[resourceId] = amount - useOwn
		end
	end
	if next(fromStorage) then
		if not ctx.Resources:Has(fromStorage) then
			ctx:Feedback(player, false, "Missing ingredients: " .. describe(fromStorage) .. ".")
			return
		end
		if not ctx.Permission:Has(player, "Storage.Withdraw") then
			ctx:Feedback(player, false, "Bring the ingredients yourself: " .. describe(fromStorage) .. ".")
			return
		end
	end

	local toolId = recipe.Tool or ctx:Attr(station.Instance, job, "RequiredTool", "")
	local toolOk, efficiency, toolReason, tool = ctx.Inventory:UseTool(player, toolId)
	if not toolOk then
		ctx:Feedback(player, false, toolReason)
		return
	end
	if next(fromStorage) then
		local withdrawn, withdrawReason = ctx:TryWithdrawForWork(player, fromStorage, "Craft:" .. recipeId)
		if not withdrawn then
			ctx:Feedback(player, false, withdrawReason)
			return
		end
	end
	if not ctx.Inventory:RemoveItems(player, fromInventory, "Craft:" .. recipeId) then
		-- Inventory changed mid-craft: return what storage gave.
		for resourceId, amount in pairs(fromStorage) do
			ctx.Resources:Deposit(resourceId, amount, "CraftRefund")
		end
		ctx:Feedback(player, false, "Your ingredients changed. Try again.")
		return
	end

	local productivity = ctx:GetProductivity(player, station) * math.max(efficiency, 0.1)
	local yields = {}
	for resourceId, amount in pairs(recipe.Outputs) do
		-- Crafting never yields less than 1, but good conditions can add more.
		yields[resourceId] = math.max(1, ctx.ScaleYield(amount, math.min(productivity, 1.4)))
	end
	ctx:Complete(player, station, {
		xpShare = recipe.XPShare or 1,
		yields = yields,
		tool = tool,
		label = recipe.DisplayName or recipeId,
	})
end

-- Repair queue (blacksmiths) ------------------------------------------------------

local function mostWornTool(ctx, player: Player)
	local profile = ctx.Data:Get(player)
	if not profile then
		return nil, nil
	end
	local bestUid, best, worst = nil, nil, math.huge
	for uid, tool in pairs(profile.Inventory.Tools) do
		local fraction = tool.Durability / math.max(tool.Max, 1)
		if fraction < 0.6 and fraction < worst then
			bestUid, best, worst = uid, tool, fraction
		end
	end
	return bestUid, best
end

function CraftStation._setupRepairs(ctx, station, parent: Instance)
	local config = ItemConfig.Repair
	local request = ctx.PromptUtil.create(parent, {
		Name = "KingdomRepairRequest",
		ActionText = "Leave tool for repair",
		ObjectText = string.format("Fee %d coins", config.FeeCoins),
		HoldDuration = 1,
		MaxDistance = 12,
		UIOffset = Vector2.new(0, 60),
	})
	ctx.PromptUtil.onTriggered(request, function(player)
		CraftStation._requestRepair(ctx, player, station)
	end)
	local work = ctx.PromptUtil.create(parent, {
		Name = "KingdomRepairWork",
		ActionText = "Work repair queue",
		ObjectText = "0 waiting",
		HoldDuration = 5,
		MaxDistance = 12,
		Permission = station.Job and station.Job.Permission or "Job.Advanced",
		UIOffset = Vector2.new(0, 120),
	})
	station.RepairPrompt = work
	ctx.PromptUtil.onTriggered(work, function(player, held)
		CraftStation._workRepair(ctx, player, station, held)
	end)
end

local function refreshQueue(station)
	if station.RepairPrompt then
		station.RepairPrompt.ObjectText = string.format("%d waiting", #station.Queue)
	end
end

function CraftStation._requestRepair(ctx, player: Player, station)
	local config = ItemConfig.Repair
	if not ctx.Data:IsLoaded(player) or ctx.ZoneUtil.playerDistance(player, station.Anchor) > 14 then
		return
	end
	if #station.Queue >= config.MaxQueuePerStation then
		ctx:Feedback(player, false, "The repair queue is full.")
		return
	end
	local uid, tool = mostWornTool(ctx, player)
	if not uid or not tool then
		ctx:Feedback(player, false, "None of your tools need repair yet.")
		return
	end
	if not ctx.Economy:RemoveCoins(player, config.FeeCoins, "RepairFee") then
		ctx:Feedback(player, false, string.format("Repairs cost %d coins.", config.FeeCoins))
		return
	end
	local removed = ctx.Inventory:RemoveTool(player, uid, "RepairQueue")
	if not removed then
		ctx.Economy:AddCoins(player, config.FeeCoins, "RepairFeeRefund")
		return
	end
	-- Escrow lives in the owner's saved profile so nothing is lost on leave.
	local profile = ctx.Data:Get(player)
	local escrowId = ctx:NewSessionId()
	profile.Escrow[escrowId] = { Type = "Repair", Tool = removed, Fee = config.FeeCoins, Repaired = false }
	table.insert(station.Queue, { owner = player.UserId, escrowId = escrowId, tool = removed })
	refreshQueue(station)
	ctx:Feedback(player, true, string.format("Your %s is in the queue (#%d).", ctx:ToolDisplay(removed.Id), #station.Queue))
end

function CraftStation._workRepair(ctx, player: Player, station, held: number)
	local config = ItemConfig.Repair
	if not ctx.PromptUtil.heldLongEnough(held, 5, ctx.Config.Session.HoldTolerance) then
		return
	end
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	local entry = station.Queue[1]
	if not entry then
		ctx:Feedback(player, false, "No tools are waiting.")
		return
	end
	if entry.owner == player.UserId then
		ctx:Feedback(player, false, "Another smith must repair your own tools.")
		return
	end
	local iron = { Iron = config.IronPerRepair }
	if not ctx.Inventory:RemoveItems(player, iron, "Repair") then
		local withdrawn, withdrawReason = ctx:TryWithdrawForWork(player, iron, "Repair")
		if not withdrawn then
			ctx:Feedback(player, false, withdrawReason or "You need an iron ingot.")
			return
		end
	end
	local toolOk, _, toolReason, hammer = ctx.Inventory:UseTool(player, ctx:Attr(station.Instance, station.Job, "RequiredTool", "Hammer"))
	if not toolOk then
		ctx:Feedback(player, false, toolReason)
		return
	end
	table.remove(station.Queue, 1)
	refreshQueue(station)
	entry.tool.Durability = math.min(entry.tool.Max, entry.tool.Durability + entry.tool.Max * config.RestoreFraction)

	local owner = Players:GetPlayerByUserId(entry.owner)
	local fee = 0
	if owner and ctx.Data:Get(owner) then
		local escrow = ctx.Data:Get(owner).Escrow[entry.escrowId]
		fee = escrow and escrow.Fee or 0
		ctx.Data:Get(owner).Escrow[entry.escrowId] = nil
		ctx.Inventory:AddTool(owner, entry.tool.Id, entry.tool.Quality, entry.tool.Durability, "Repaired")
		ctx.Notify:Notify(owner, "Success", "Tool repaired", string.format("%s repaired your %s.", player.DisplayName, ctx:ToolDisplay(entry.tool.Id)))
	end
	if fee > 0 then
		ctx.Economy:AddCoins(player, fee, "RepairFee", true)
	end
	ctx:Complete(player, station, {
		xpOverride = config.XP,
		tool = hammer,
		label = "Repair",
	})
end

-- Owners returning: give back escrowed tools (repaired or not).
function CraftStation.OnPlayerJoin(ctx, player: Player)
	local profile = ctx.Data:Get(player)
	if not profile then
		return
	end
	local queued = {}
	for _, station in pairs(ctx._stations) do
		for _, entry in ipairs(station.Queue or {}) do
			queued[entry.escrowId] = true
		end
	end
	for escrowId, escrow in pairs(profile.Escrow) do
		if escrow.Type == "Repair" and not queued[escrowId] then
			profile.Escrow[escrowId] = nil
			ctx.Inventory:AddTool(player, escrow.Tool.Id, escrow.Tool.Quality, escrow.Tool.Durability, "EscrowReturn")
			if not escrow.Repaired and escrow.Fee then
				ctx.Economy:AddCoins(player, escrow.Fee, "RepairFeeRefund")
			end
		end
	end
end

-- Leaving: queued tools stay in the owner's escrow; remove them from queues
-- so the smith can't repair a tool whose owner is gone.
function CraftStation.Cancel(ctx, player: Player, reason: string)
	if reason ~= "Left" then
		return
	end
	for _, station in pairs(ctx._stations) do
		if station.Queue then
			for index = #station.Queue, 1, -1 do
				if station.Queue[index].owner == player.UserId then
					table.remove(station.Queue, index)
				end
			end
			refreshQueue(station)
		end
	end
end

return CraftStation
