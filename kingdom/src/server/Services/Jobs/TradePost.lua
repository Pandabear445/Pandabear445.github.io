--[[
	TradePost (job kind)
	Merchants export surplus goods abroad for treasury income.

	"Load caravan" opens the export ledger (Effect "OpenTrade"); the merchant
	chooses a carried resource and amount (Job.Interact action = "Export").
	Revenue = market sell price x ExportPriceMultiplier (x event bonus).
	The merchant keeps MerchantCommission (minus trade tax); the rest is
	treasury trade income. Merchants usually withdraw surplus from the
	warehouse first, then haul it here.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Check = require(script.Parent.Parent.Parent.Core.Check)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)

local TradePost = {}

local exportBonus = 1

function TradePost.SetExportBonus(multiplier: number)
	exportBonus = multiplier
end

local function price(ctx, job, resourceId: string): number
	return math.max(1, math.floor(ctx.Economy:GetSellPrice(resourceId) * job.ExportPriceMultiplier * exportBonus + 0.5))
end

function TradePost.Attach(ctx, instance: Instance, job)
	local station: any = { LastExport = {} }
	local parent = (instance:IsA("BasePart") and instance) or ctx.PromptUtil.anchorFor(instance)
	station.Anchor = parent
	local prompt = ctx.PromptUtil.create(parent, {
		Name = "KingdomTrade",
		ActionText = "Load caravan",
		ObjectText = instance.Name,
		HoldDuration = 0.5,
		MaxDistance = 12,
		Permission = job.Permission,
	})
	ctx.PromptUtil.onTriggered(prompt, function(player)
		local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor, skipTravel = true })
		if not ok then
			ctx:Feedback(player, false, reason)
			return
		end
		local offers = {}
		for resourceId, count in pairs(ctx.Inventory:GetItems(player)) do
			local def = ResourceConfig.Resources[resourceId]
			if def and def.Category ~= "Seed" then
				table.insert(offers, { Resource = resourceId, Have = count, Price = price(ctx, job, resourceId) })
			end
		end
		ctx.Net.Fire("Effect", player, "OpenTrade", {
			Station = station.Id,
			Offers = offers,
			Commission = job.MerchantCommission,
			TradeTax = ctx.Economy:GetTax("Trade"),
			Bonus = exportBonus,
		})
	end)
	return station
end

function TradePost.HandleAction(ctx, player: Player, station, payload)
	local job = station.Job
	if payload.action ~= "Export" then
		return false, "Unknown action."
	end
	local resourceId = Check.key(payload.resource, ResourceConfig.Resources)
	local amount = Check.integer(payload.amount, 1, 200)
	if not resourceId or not amount then
		return false, "Invalid request."
	end
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor, skipTravel = true })
	if not ok then
		return false, reason or "Not here."
	end
	local last = station.LastExport[player]
	if last and os.clock() - last < job.LoadDuration then
		return false, "The caravan is still being loaded."
	end
	amount = math.min(amount, ctx.Inventory:Count(player, resourceId))
	if amount <= 0 or not ctx.Inventory:Remove(player, resourceId, amount, "Export") then
		return false, "You don't carry that."
	end
	ctx.Inventory:ConsumeTaint(player, resourceId, amount)
	station.LastExport[player] = os.clock()

	local revenue = price(ctx, job, resourceId) * amount
	local commission = math.floor(revenue * job.MerchantCommission)
	local tax = math.floor(commission * ctx.Economy:GetTax("Trade") + 0.5)
	ctx.Economy:TreasuryDeposit(revenue - commission, "Exports")
	if tax > 0 then
		ctx.Economy:TreasuryDeposit(tax, "TradeTax")
	end
	local net = ctx.Economy:AddCoins(player, commission - tax, "Commission", true)
	ctx:Complete(player, station, {
		category = "Contribution",
		xpOverride = math.min(math.ceil(revenue * job.XPPerValue), job.MaxXPPerExport),
		wageOverride = 0,
		units = amount,
		label = string.format("Exported %d %s", amount, ResourceConfig.Resources[resourceId].DisplayName),
		extra = { revenue = revenue },
	})
	return true, string.format("Sold abroad for %d coins (%d to you).", revenue, net)
end

return TradePost
