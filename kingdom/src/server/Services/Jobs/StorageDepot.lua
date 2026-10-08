--[[
	StorageDepot (job kind)
	Warehouses, granaries, ore yards, armories (KingdomStorage /
	KingdomWarehouse markers).

	  Deposit goods   carried resources matching the store's StorageType go
	                  into kingdom storage. Pays Contribution XP + a delivery
	                  wage from the treasury (based on value delivered).
	  Withdraw        ranks with Storage.Withdraw take materials for work
	                  (hourly limit). Withdrawn units are "tainted": putting
	                  them back earns nothing, so there is no XP loop.
	  Requisition     turn kingdom Tools/Weapons stock into a personal tool.
	  Audit stock     warehouse keepers slow spoilage for an in-game hour.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Check = require(script.Parent.Parent.Parent.Core.Check)
local ItemConfig = require(ReplicatedStorage.Kingdom.Config.ItemConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)

local StorageDepot = {}

local function types(ctx, station): { string }
	local list = ctx.Resources:GetMarkerTypes(station.Instance)
	if #list == 0 then
		return { "General" }
	end
	return list
end

function StorageDepot.Attach(ctx, instance: Instance, job)
	local station: any = { AuditReadyAt = 0 }
	local parent = (instance:IsA("BasePart") and instance) or ctx.PromptUtil.anchorFor(instance)
	station.Anchor = parent

	local deposit = ctx.PromptUtil.create(parent, {
		Name = "KingdomDeposit",
		ActionText = "Deposit goods",
		ObjectText = instance.Name,
		HoldDuration = 1.2,
		MaxDistance = 12,
	})
	ctx.PromptUtil.onTriggered(deposit, function(player, held)
		if ctx.PromptUtil.heldLongEnough(held, 1.2, ctx.Config.Session.HoldTolerance) then
			StorageDepot.Deposit(ctx, player, station)
		end
	end)

	local open = ctx.PromptUtil.create(parent, {
		Name = "KingdomWithdraw",
		ActionText = "Withdraw / Requisition",
		ObjectText = instance.Name,
		HoldDuration = 0,
		MaxDistance = 12,
		KeyCode = Enum.KeyCode.F,
		Permission = "Storage.Withdraw",
		UIOffset = Vector2.new(0, 60),
	})
	ctx.PromptUtil.onTriggered(open, function(player)
		StorageDepot.Open(ctx, player, station)
	end)

	local audit = ctx.PromptUtil.create(parent, {
		Name = "KingdomAudit",
		ActionText = "Audit stock",
		ObjectText = "Slows spoilage",
		HoldDuration = job.Audit.Duration,
		MaxDistance = 12,
		KeyCode = Enum.KeyCode.G,
		Permission = "Storage.Audit",
		UIOffset = Vector2.new(0, 120),
	})
	ctx.PromptUtil.onTriggered(audit, function(player, held)
		StorageDepot.Audit(ctx, player, station, held)
	end)
	return station
end

function StorageDepot.Deposit(ctx, player: Player, station)
	local job = station.Job
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor, skipTravel = true })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	local accepted = types(ctx, station)
	local items = ctx.Inventory:GetItems(player)
	local totalValue, totalUnits, returned = 0, 0, 0
	local deposited = {}
	local full = false
	for resourceId, count in pairs(items) do
		local def = ResourceConfig.Resources[resourceId]
		if def and table.find(accepted, def.StorageType) then
			local room = ctx.Resources:FreeSpaceFor(resourceId)
			local amount = math.min(count, room)
			if amount < count then
				full = true
			end
			if amount > 0 and ctx.Inventory:Remove(player, resourceId, amount, "Deposit") then
				local fresh, tainted = ctx.Inventory:ConsumeTaint(player, resourceId, amount)
				if fresh > 0 then
					ctx.Resources:Deposit(resourceId, fresh, "Delivery", player)
					totalValue += fresh * def.BaseValue
					totalUnits += fresh
					deposited[resourceId] = fresh
				end
				if tainted > 0 then
					ctx.Resources:Deposit(resourceId, tainted, "Return", player)
					returned += tainted
				end
			end
		end
	end
	if totalUnits == 0 and returned == 0 then
		ctx:Feedback(player, false, full and "This storage is full!" or "You carry nothing this storage accepts.")
		return
	end
	if totalUnits == 0 then
		ctx:Feedback(player, true, string.format("Returned %d units to storage.", returned))
		return
	end
	local profile = ctx.Data:Get(player)
	if profile then
		profile.Lifetime.Contributions += totalValue
	end
	ctx:Complete(player, station, {
		category = "Contribution",
		xpOverride = math.min(math.ceil(totalValue * job.XPPerValue), job.MaxXPPerDeposit),
		wageOverride = totalValue * job.WagePerValue,
		units = totalUnits,
		label = string.format("Delivered %d goods", totalUnits),
		extra = { deposited = deposited },
	})
	if full then
		ctx.Notify:Notify(player, "Warning", "Storage full", "Some goods did not fit. Managers: build or repair storage!")
	end
end

function StorageDepot.Open(ctx, player: Player, station)
	if ctx.ZoneUtil.playerDistance(player, station.Anchor) > 14 then
		return
	end
	local accepted = types(ctx, station)
	local stock = {}
	for resourceId, amount in pairs(ctx.Resources:GetAllStock()) do
		local def = ResourceConfig.Resources[resourceId]
		if def and table.find(accepted, def.StorageType) and amount > 0 then
			stock[resourceId] = amount
		end
	end
	local requisitions = {}
	for toolId, rule in pairs(ItemConfig.Requisition) do
		local def = ResourceConfig.Resources[rule.Stock]
		if def and table.find(accepted, def.StorageType) then
			table.insert(requisitions, { Tool = toolId, Stock = rule.Stock, Available = ctx.Resources:GetStock(rule.Stock) })
		end
	end
	ctx.Net.Fire("Effect", player, "OpenStorage", {
		Station = station.Id,
		Name = station.Instance.Name,
		Stock = stock,
		Requisitions = requisitions,
		CanWithdraw = ctx.Permission:Has(player, "Storage.Withdraw"),
	})
end

function StorageDepot.HandleAction(ctx, player: Player, station, payload)
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor, skipTravel = true })
	if not ok then
		return false, reason or "Not here."
	end
	if payload.action == "Withdraw" then
		local resourceId = Check.key(payload.resource, ResourceConfig.Resources)
		local amount = Check.integer(payload.amount, 1, 50)
		if not resourceId or not amount then
			return false, "Invalid request."
		end
		local def = ResourceConfig.Resources[resourceId]
		if not table.find(types(ctx, station), def.StorageType) then
			return false, "That isn't kept here."
		end
		amount = math.min(amount, ctx.Inventory:RoomFor(player, resourceId), ctx.Resources:GetStock(resourceId))
		if amount <= 0 then
			return false, "Nothing to take, or your pack is full."
		end
		local withdrawn, withdrawReason = ctx:TryWithdrawForWork(player, { [resourceId] = amount }, "Withdraw")
		if not withdrawn then
			return false, withdrawReason
		end
		local added = ctx.Inventory:Add(player, resourceId, amount, "Withdraw")
		ctx.Inventory:AddTaint(player, resourceId, added)
		if added < amount then
			ctx.Resources:Deposit(resourceId, amount - added, "Return")
		end
		ctx.Activity:MarkInteraction(player)
		return true, string.format("Took %d %s.", added, def.DisplayName)
	elseif payload.action == "Requisition" then
		local toolId = Check.key(payload.tool, ItemConfig.Requisition)
		if not toolId then
			return false, "Invalid tool."
		end
		if not ctx.Permission:Has(player, "Storage.Withdraw") then
			return false, "Your rank cannot requisition equipment."
		end
		if ctx.Inventory:GetBestTool(player, toolId) then
			return false, "You already have a working one."
		end
		local rule = ItemConfig.Requisition[toolId]
		if ctx.Resources:Withdraw(rule.Stock, 1, "Requisition:" .. toolId, player) < 1 then
			return false, "The armory has none. Blacksmiths must forge more."
		end
		ctx.Inventory:AddTool(player, toolId, rule.Quality, nil, "Requisition")
		return true, "Requisitioned a " .. ctx:ToolDisplay(toolId) .. "."
	end
	return false, "Unknown action."
end

function StorageDepot.Audit(ctx, player: Player, station, held: number)
	local job = station.Job
	if not ctx.PromptUtil.heldLongEnough(held, job.Audit.Duration, ctx.Config.Session.HoldTolerance) then
		return
	end
	if not ctx.Permission:Has(player, "Storage.Audit") then
		ctx:Feedback(player, false, "Only managers may audit storage.")
		return
	end
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	if os.clock() < station.AuditReadyAt then
		ctx:Feedback(player, false, "This storage was audited recently.")
		return
	end
	station.AuditReadyAt = os.clock() + job.Audit.Cooldown
	local untilMinute = ctx.Time:GetAbsoluteMinutes() + job.Audit.LastsGameMinutes
	for _, storageType in ipairs(types(ctx, station)) do
		ctx.Resources:SetDecayModifier(storageType, job.Audit.DecayReduction, untilMinute)
	end
	ctx:Complete(player, station, { xpOverride = job.Audit.XP, label = "Stock audit" })
end

return StorageDepot
