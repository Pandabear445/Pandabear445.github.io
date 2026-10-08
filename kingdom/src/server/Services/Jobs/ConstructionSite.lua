--[[
	ConstructionSite (job kind)
	Receive the order -> collect materials -> travel to the site -> build.

	KingdomConstruction marker attributes:
	  ProjectName     display name
	  RequiredWood / RequiredStone / RequiredIron   materials to deliver
	  WorkRequired    number of build actions (default 10)
	  AutoApproved    skip manager approval (default false)
	  FundingCost     treasury coins spent when approved (default 0)
	  Repeatable      reset after completion (default false)
	Children named "Scaffold" are hidden and "Completed" revealed on finish.

	A manager with Projects.Approve must approve the project first (or the
	Senate funds it). Building progress can never outrun delivered materials.
	The approving manager earns Management XP only when the project is
	actually completed.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)

local ConstructionSite = {}

local MATERIALS = { Wood = "RequiredWood", Stone = "RequiredStone", Iron = "RequiredIron" }

local function setRevealed(instance: Instance, name: string, visible: boolean)
	for _, child in ipairs(instance:GetDescendants()) do
		if child.Name == name then
			local parts = child:IsA("BasePart") and { child } or {}
			for _, descendant in ipairs(child:GetDescendants()) do
				if descendant:IsA("BasePart") then
					table.insert(parts, descendant)
				end
			end
			for _, part in ipairs(parts) do
				local original = part:GetAttribute("KingdomOriginalTransparency")
				if original == nil then
					original = part.Transparency
					part:SetAttribute("KingdomOriginalTransparency", original)
				end
				part.Transparency = visible and (original >= 1 and 0 or original) or 1
				part.CanCollide = visible
			end
		end
	end
end

local function required(station): { [string]: number }
	local needs = {}
	for resourceId, attribute in pairs(MATERIALS) do
		local amount = station.Instance:GetAttribute(attribute)
		if type(amount) == "number" and amount > 0 then
			needs[resourceId] = math.floor(amount)
		end
	end
	return needs
end

local function materialFraction(station): number
	local needs = required(station)
	local needed, delivered = 0, 0
	for resourceId, amount in pairs(needs) do
		needed += amount
		delivered += math.min(station.Delivered[resourceId] or 0, amount)
	end
	return needed > 0 and delivered / needed or 1
end

local function refresh(station)
	local name = station.Instance:GetAttribute("ProjectName") or station.Instance.Name
	local workRequired = station.Instance:GetAttribute("WorkRequired") or 10
	station.ApprovePrompt.Enabled = station.State == "Proposed"
	station.DeliverPrompt.Enabled = station.State == "Active" and materialFraction(station) < 1
	station.BuildPrompt.Enabled = station.State == "Active"
	local status
	if station.State == "Proposed" then
		status = "Awaiting approval"
	elseif station.State == "Active" then
		status = string.format("Materials %d%% · Work %d/%d", math.floor(materialFraction(station) * 100), station.Work, workRequired)
	else
		status = "Completed"
	end
	station.BuildPrompt.ObjectText = name .. " · " .. status
	station.DeliverPrompt.ObjectText = name
	station.ApprovePrompt.ObjectText = name
	station.Instance:SetAttribute("ProjectState", station.State)
	station.Instance:SetAttribute("ProjectProgress", station.Work / workRequired)
end

function ConstructionSite.Attach(ctx, instance: Instance, job)
	local station: any = {
		Instance = instance,
		Job = job,
		State = instance:GetAttribute("AutoApproved") == true and "Active" or "Proposed",
		Delivered = {},
		Work = 0,
		Contributors = {}, -- [userId] = work units
		ApprovedBy = nil,
	}
	local parent = (instance:IsA("BasePart") and instance) or ctx.PromptUtil.anchorFor(instance)
	station.Anchor = parent
	station.ApprovePrompt = ctx.PromptUtil.create(parent, {
		Name = "KingdomApprove",
		ActionText = "Approve project",
		HoldDuration = 1.5,
		MaxDistance = 14,
		Permission = "Projects.Approve",
		KeyCode = Enum.KeyCode.G,
		UIOffset = Vector2.new(0, 120),
	})
	station.DeliverPrompt = ctx.PromptUtil.create(parent, {
		Name = "KingdomSupply",
		ActionText = "Deliver materials",
		HoldDuration = 1.5,
		MaxDistance = 14,
		KeyCode = Enum.KeyCode.F,
		UIOffset = Vector2.new(0, 60),
	})
	station.BuildPrompt = ctx.PromptUtil.create(parent, {
		Name = "KingdomBuild",
		ActionText = "Build",
		HoldDuration = ctx:Attr(instance, job, "WorkDuration", 4),
		MaxDistance = 14,
		Permission = job.Permission,
	})
	ctx.PromptUtil.onTriggered(station.ApprovePrompt, function(player, held)
		if ctx.PromptUtil.heldLongEnough(held, 1.5, ctx.Config.Session.HoldTolerance) then
			local ok, message = ConstructionSite.Approve(ctx, station, player)
			ctx:Feedback(player, ok, message)
		end
	end)
	ctx.PromptUtil.onTriggered(station.DeliverPrompt, function(player, held)
		if ctx.PromptUtil.heldLongEnough(held, 1.5, ctx.Config.Session.HoldTolerance) then
			ConstructionSite.Deliver(ctx, player, station)
		end
	end)
	ctx.PromptUtil.onTriggered(station.BuildPrompt, function(player, held)
		ConstructionSite.Build(ctx, player, station, held)
	end)
	setRevealed(instance, "Completed", false)
	refresh(station)
	return station
end

-- byPlayer nil = approved by the Senate (GovernmentService).
function ConstructionSite.Approve(ctx, station, byPlayer: Player?)
	if station.State ~= "Proposed" then
		return false, "This project is not awaiting approval."
	end
	if byPlayer then
		if not ctx.Permission:Has(byPlayer, "Projects.Approve") then
			return false, "You cannot approve projects."
		end
		if ctx.ZoneUtil.playerDistance(byPlayer, station.Anchor) > 16 then
			return false, "Inspect the site in person to approve it."
		end
	end
	local cost = station.Instance:GetAttribute("FundingCost") or 0
	if cost > 0 and not ctx.Economy:TreasuryWithdraw(cost, "Construction") then
		return false, string.format("The treasury cannot fund this project (%d coins).", cost)
	end
	station.State = "Active"
	station.ApprovedBy = byPlayer and byPlayer.UserId or nil
	refresh(station)
	ctx.Audit:Log("Management", "ProjectApproved", { project = station.Instance.Name, by = byPlayer and byPlayer.UserId })
	ctx.Notify:Broadcast("Information", "Project approved", (station.Instance:GetAttribute("ProjectName") or station.Instance.Name) .. " needs builders and materials.")
	return true, "Project approved."
end

function ConstructionSite.Deliver(ctx, player: Player, station)
	if station.State ~= "Active" then
		return
	end
	if not ctx.Data:IsLoaded(player) or ctx.ZoneUtil.playerDistance(player, station.Anchor) > 16 then
		ctx:Feedback(player, false, "Get closer to the site.")
		return
	end
	local needs = required(station)
	local delivered, value = 0, 0
	for resourceId, amount in pairs(needs) do
		local missing = amount - (station.Delivered[resourceId] or 0)
		local have = ctx.Inventory:Count(player, resourceId)
		local give = math.min(missing, have)
		if give > 0 and ctx.Inventory:Remove(player, resourceId, give, "Construction") then
			ctx.Inventory:ConsumeTaint(player, resourceId, give)
			station.Delivered[resourceId] = (station.Delivered[resourceId] or 0) + give
			delivered += give
			value += give * ResourceConfig.Resources[resourceId].BaseValue
		end
	end
	if delivered == 0 then
		ctx:Feedback(player, false, "You carry none of the materials this site still needs.")
		return
	end
	station.Contributors[player.UserId] = (station.Contributors[player.UserId] or 0) + delivered * 0.25
	refresh(station)
	ctx:Complete(player, station, {
		category = "Contribution",
		xpOverride = math.min(math.ceil(value * 0.3), 200),
		wageOverride = 0,
		label = string.format("Delivered %d materials", delivered),
		units = delivered,
	})
end

function ConstructionSite.Build(ctx, player: Player, station, held: number)
	local job = station.Job
	if station.State ~= "Active" then
		return
	end
	if not ctx.PromptUtil.heldLongEnough(held, ctx:Attr(station.Instance, job, "WorkDuration", 4), ctx.Config.Session.HoldTolerance) then
		return
	end
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor, maxDistance = 18 })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	if not ctx:HasCapacity(player, station.Instance, ctx:Attr(station.Instance, job, "MaxWorkers", 8)) then
		ctx:Feedback(player, false, "Enough builders are here already.")
		return
	end
	local workRequired = station.Instance:GetAttribute("WorkRequired") or 10
	if (station.Work + 1) / workRequired > materialFraction(station) + 1e-6 then
		ctx:Feedback(player, false, "Not enough materials delivered to continue building.")
		return
	end
	local toolOk, efficiency, toolReason, tool = ctx.Inventory:UseTool(player, ctx:Attr(station.Instance, job, "RequiredTool", "Hammer"))
	if not toolOk then
		ctx:Feedback(player, false, toolReason)
		return
	end
	local progress = efficiency >= 1 and 1 or (math.random() < efficiency and 1 or 0)
	station.Work = math.min(workRequired, station.Work + progress)
	station.Contributors[player.UserId] = (station.Contributors[player.UserId] or 0) + 1
	ctx:Complete(player, station, { tool = tool, label = "Construction" })
	if station.Work >= workRequired then
		ConstructionSite.Finish(ctx, station)
	else
		refresh(station)
	end
end

function ConstructionSite.Finish(ctx, station)
	local job = station.Job
	station.State = "Completed"
	setRevealed(station.Instance, "Scaffold", false)
	setRevealed(station.Instance, "Completed", true)
	refresh(station)
	local total = 0
	for _, units in pairs(station.Contributors) do
		total += units
	end
	local name = station.Instance:GetAttribute("ProjectName") or station.Instance.Name
	for userId, units in pairs(station.Contributors) do
		local contributor = game:GetService("Players"):GetPlayerByUserId(userId)
		if contributor and total > 0 then
			ctx.XP:Award(contributor, "Contribution", job.CompletionXP * units / total, {
				source = "Project:" .. name,
				ignoreAFK = true,
			})
		end
	end
	ctx.Audit:Log("Management", "ProjectCompleted", { project = name, contributors = total })
	ctx.Notify:Announce("Success", "Project completed", name .. " has been completed!")
	ctx.StationEvent:Fire("ProjectCompleted", station, {
		ApprovedBy = station.ApprovedBy,
		Contributors = station.Contributors,
		Name = name,
	})
	if station.Instance:GetAttribute("Repeatable") == true then
		task.delay(120, function()
			station.State = station.Instance:GetAttribute("AutoApproved") == true and "Active" or "Proposed"
			station.Delivered = {}
			station.Work = 0
			station.Contributors = {}
			station.ApprovedBy = nil
			setRevealed(station.Instance, "Scaffold", true)
			setRevealed(station.Instance, "Completed", false)
			refresh(station)
		end)
	end
end

return ConstructionSite
