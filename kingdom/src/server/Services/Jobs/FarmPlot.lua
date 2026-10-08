--[[
	FarmPlot (job kind)
	Farming as a real cycle:  Plant -> Water -> (grow) -> Harvest -> haul.

	A KingdomFarm marker is a field. Plots are either its children (BaseParts
	named "Plot..." or tagged KingdomFarmPlot) or, if it has none, PlotCount
	plots generated in a grid on top of the field.

	Growth runs on in-game minutes and depends on watering, weather (rain
	waters crops and boosts growth) and season. Ripe crops left too long rot
	and must be cleared. Plant/Water pay a share of the XP; the harvest pays
	the most and yields the crop + seeds into the worker's inventory.

	Field attributes: CropType (Wheat | Vegetables | Herbs), XPReward, Wage,
	MaxWorkers, PlotCount, QualityMultiplier, RequiredRank, ...
]]

local FarmPlot = {}

local PLOT_TAG = "KingdomFarmPlot"

local CROP_COLORS = {
	Wheat = Color3.fromRGB(222, 190, 90),
	Vegetables = Color3.fromRGB(230, 130, 50),
	Herbs = Color3.fromRGB(90, 160, 80),
}

local plots = {} -- every plot station (for the growth tick)

local function makeCrop(anchor: BasePart): BasePart
	local crop = Instance.new("Part")
	crop.Name = "Crop"
	crop.Anchored = true
	crop.CanCollide = false
	crop.CanQuery = false
	crop.Material = Enum.Material.Grass
	crop.Size = Vector3.new(0.4, 0.4, 0.4)
	crop.Transparency = 1
	crop.CFrame = anchor.CFrame
	crop.Parent = anchor
	return crop
end

local function updateVisual(plot)
	local crop = plot.Crop
	local base = plot.Anchor.CFrame
	if plot.State == "Empty" then
		crop.Transparency = 1
		return
	end
	crop.Transparency = 0
	local height
	if plot.State == "Rotten" then
		crop.Color = Color3.fromRGB(70, 50, 30)
		height = 0.8
	elseif plot.State == "Ripe" then
		crop.Color = CROP_COLORS[plot.CropType] or Color3.fromRGB(200, 180, 80)
		height = 2.6
	else
		crop.Color = plot.Watered and Color3.fromRGB(70, 140, 60) or Color3.fromRGB(120, 140, 70)
		height = 0.4 + 2 * plot.Progress
	end
	crop.Size = Vector3.new(1.6, height, 1.6)
	crop.CFrame = base * CFrame.new(0, height / 2, 0)
end

local function refreshPrompt(plot)
	local prompt = plot.Prompt
	local cropName = plot.CropType
	if plot.State == "Empty" then
		prompt.ActionText = "Plant " .. cropName
		prompt.HoldDuration = plot.Job.Steps.Plant.Duration
		prompt.Enabled = true
		prompt.ObjectText = "Farm plot · needs Hoe + Seeds"
	elseif plot.State == "Planted" then
		if plot.Watered then
			prompt.Enabled = false
		else
			prompt.Enabled = true
			prompt.ActionText = "Water crop"
			prompt.HoldDuration = plot.Job.Steps.Water.Duration
		end
		prompt.ObjectText = string.format("%s growing %d%%", cropName, math.floor(plot.Progress * 100))
	elseif plot.State == "Ripe" then
		prompt.Enabled = true
		prompt.ActionText = "Harvest"
		prompt.HoldDuration = plot.Job.Steps.Harvest.Duration
		prompt.ObjectText = cropName .. " · ripe"
	elseif plot.State == "Rotten" then
		prompt.Enabled = true
		prompt.ActionText = "Clear rotten crop"
		prompt.HoldDuration = 2
		prompt.ObjectText = "Rotten " .. cropName
	end
	updateVisual(plot)
end

local function generatePlots(field: Instance, count: number): { BasePart }
	local cframe, size = nil, nil
	if field:IsA("BasePart") then
		cframe, size = field.CFrame, field.Size
	elseif field:IsA("Model") then
		cframe, size = field:GetBoundingBox()
	end
	if not cframe or not size then
		return {}
	end
	local columns = math.max(1, math.ceil(math.sqrt(count * size.X / math.max(size.Z, 1))))
	local rows = math.max(1, math.ceil(count / columns))
	local folder = Instance.new("Folder")
	folder.Name = "KingdomPlots"
	folder.Parent = field
	local list = {}
	for i = 0, count - 1 do
		local column = i % columns
		local row = i // columns
		local x = (column + 0.5) / columns * size.X - size.X / 2
		local z = (row + 0.5) / rows * size.Z - size.Z / 2
		local anchor = Instance.new("Part")
		anchor.Name = "Plot" .. (i + 1)
		anchor.Size = Vector3.new(2.4, 0.2, 2.4)
		anchor.Anchored = true
		anchor.CanCollide = false
		anchor.Material = Enum.Material.Ground
		anchor.Color = Color3.fromRGB(92, 64, 40)
		anchor.CFrame = cframe * CFrame.new(x, size.Y / 2 + 0.1, z)
		anchor.Parent = folder
		table.insert(list, anchor)
	end
	return list
end

local function readCrop(anchor: Instance, default: string, job): string
	local value = anchor:GetAttribute("CropType")
	if type(value) == "string" and job.Crops[value] then
		return value
	end
	return default
end

-- Attach is called for each KingdomFarm field; it registers every plot.
function FarmPlot.Attach(ctx, field: Instance, job)
	local cropType = ctx:Attr(field, job, "CropType", "Wheat")
	if not job.Crops[cropType] then
		ctx.Log:Warn("Farm %s has unknown CropType %s; using Wheat", field:GetFullName(), cropType)
		cropType = "Wheat"
	end
	local anchors = {}
	for _, child in ipairs(field:GetDescendants()) do
		if child:IsA("BasePart") and (child:HasTag(PLOT_TAG) or string.sub(child.Name, 1, 4) == "Plot") then
			table.insert(anchors, child)
		end
	end
	if #anchors == 0 then
		anchors = generatePlots(field, ctx:Attr(field, job, "PlotCount", 8))
	end

	for _, anchor in ipairs(anchors) do
		local plot = {
			Field = field,
			Zone = field,
			AttrSource = field,
			Anchor = anchor,
			CropType = readCrop(anchor, cropType, job),
			State = "Empty",
			Progress = 0,
			Watered = false,
			RipeMinutes = 0,
		}
		plot.Crop = makeCrop(anchor)
		plot.Prompt = ctx.PromptUtil.create(anchor, {
			Name = "KingdomFarm",
			ActionText = "Plant",
			HoldDuration = 2,
			MaxDistance = 8,
			Permission = ctx:Attr(field, job, "RequiredPermission", job.Permission),
		})
		ctx:RegisterStation(plot, anchor, job, "FarmPlot")
		ctx.PromptUtil.onTriggered(plot.Prompt, function(player, held)
			FarmPlot.Interact(ctx, player, plot, held)
		end)
		refreshPrompt(plot)
		table.insert(plots, plot)
	end
	-- The field itself is not a separate station; plots are.
	return nil
end

function FarmPlot.Interact(ctx, player: Player, plot, held: number)
	local job = plot.Job
	local stepName
	if plot.State == "Empty" then
		stepName = "Plant"
	elseif plot.State == "Planted" and not plot.Watered then
		stepName = "Water"
	elseif plot.State == "Ripe" then
		stepName = "Harvest"
	elseif plot.State == "Rotten" then
		stepName = "Clear"
	else
		return
	end
	local step = job.Steps[stepName] or { Duration = 2, XPShare = 0.1, WageShare = 0.1 }
	if not ctx.PromptUtil.heldLongEnough(held, step.Duration, ctx.Config.Session.HoldTolerance) then
		return
	end
	local ok, reason = ctx:Validate(player, plot, { anchor = plot.Anchor, maxDistance = 10 })
	if not ok then
		ctx:Feedback(player, false, reason)
		return
	end
	if not ctx:HasCapacity(player, plot.Field, ctx:Attr(plot.Field, job, "MaxWorkers", 0)) then
		ctx:Feedback(player, false, "This field has enough farmers. Try another field.")
		return
	end

	if stepName == "Plant" then
		local seeds = step.Consumes and step.Consumes.Seeds or 0
		if seeds > 0 and not ctx.Inventory:Remove(player, "Seeds", seeds, "Planting") then
			-- The kingdom supplies seed stock to its fields.
			if ctx.Resources:Withdraw("Seeds", seeds, "Planting", player) < seeds then
				ctx:Feedback(player, false, "No seeds! Harvests return seeds, or buy them at the market.")
				return
			end
		end
	end

	local toolOk, efficiency, toolReason, tool = ctx.Inventory:UseTool(player, step.Tool)
	if not toolOk then
		ctx:Feedback(player, false, toolReason)
		return
	end

	local yields = nil
	if stepName == "Plant" then
		plot.State = "Planted"
		plot.Progress = 0
		plot.Watered = ctx.Weather:WatersCrops()
		plot.PlantedBy = player.UserId
	elseif stepName == "Water" then
		plot.Watered = true
	elseif stepName == "Harvest" then
		local crop = job.Crops[plot.CropType]
		local productivity = ctx:GetProductivity(player, plot) * math.max(efficiency, 0.1)
		yields = {}
		for resourceId, range in pairs(crop.Yield) do
			local amount = math.random(range[1], range[2])
			if resourceId == "Seeds" then
				yields[resourceId] = amount
			else
				yields[resourceId] = ctx.ScaleYield(amount, productivity)
			end
		end
		plot.State = "Empty"
		plot.Progress = 0
		plot.Watered = false
	elseif stepName == "Clear" then
		plot.State = "Empty"
		plot.Progress = 0
	end
	refreshPrompt(plot)
	ctx:Complete(player, plot, {
		xpShare = step.XPShare,
		wageShare = step.WageShare,
		yields = yields,
		tool = tool,
		label = "Farming: " .. stepName,
	})
end

-- Growth runs once per in-game minute for every plot.
function FarmPlot.GameMinuteTick(ctx)
	local growth = ctx.Weather:GetGrowthMultiplier()
	local raining = ctx.Weather:WatersCrops()
	for index = #plots, 1, -1 do
		local plot = plots[index]
		if not plot.Anchor.Parent then
			table.remove(plots, index)
		else
			local job = plot.Job
			local crop = job.Crops[plot.CropType]
			local changed = false
			if plot.State == "Planted" then
				if raining and not plot.Watered then
					plot.Watered = true
					changed = true
				end
				local speed = growth * (plot.Watered and (1 + (crop.WateredSpeedup or 0)) or job.UnwateredGrowthMultiplier)
				local before = math.floor(plot.Progress * 10)
				plot.Progress = math.min(1, plot.Progress + speed / crop.GrowMinutes)
				if plot.Progress >= 1 then
					plot.State = "Ripe"
					plot.RipeMinutes = 0
					changed = true
				elseif math.floor(plot.Progress * 10) ~= before then
					changed = true
				end
			elseif plot.State == "Ripe" then
				plot.RipeMinutes += 1
				if plot.RipeMinutes >= job.RotAfterMinutes then
					plot.State = "Rotten"
					changed = true
				end
			end
			if changed then
				refreshPrompt(plot)
			end
		end
	end
end

function FarmPlot.CountRipe(): number
	local count = 0
	for _, plot in ipairs(plots) do
		if plot.State == "Ripe" then
			count += 1
		end
	end
	return count
end

return FarmPlot
