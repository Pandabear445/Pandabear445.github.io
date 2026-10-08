--[[
	MonetizationService
	GamePasses, Developer Products and Roblox Premium benefits.

	Nothing purchasable touches the hierarchy: no ranks, no slots, no queue
	priority, no death protection. Benefits are cosmetic or quality of life
	(carry weight, storage, titles, nameplates, emotes, houses, private
	rooms). The optional JobXP boost is capped (GamepassConfig) and still
	limited by GameConfig.XPLimits.

	Security
	  * ownership is only ever checked server-side (UserOwnsGamePassAsync)
	  * ProcessReceipt is idempotent: PurchaseIds are stored in the profile
	    and saved BEFORE PurchaseGranted is returned
]]

local CollectionService = game:GetService("CollectionService")
local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GamepassConfig = require(ReplicatedStorage.Kingdom.Config.GamepassConfig)
local Net = require(script.Parent.Parent.Core.Net)

local MonetizationService = {
	Name = "MonetizationService",
	Dependencies = {
		"DataService",
		"XPService",
		"InventoryService",
		"NotificationService",
		"AuditService",
		"CharacterService",
		"EconomyService",
	},
}

local RECEIPT_MEMORY = 100

function MonetizationService:Init()
	self._data = self:Use("DataService")
	self._xp = self:Use("XPService")
	self._inventory = self:Use("InventoryService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")
	self._character = self:Use("CharacterService")
	self._economy = self:Use("EconomyService")

	self._owned = {} -- [Player] = { [passKey] = true }
	self._temporary = {} -- [Player] = { [cosmetic] = expiresAt }

	self._inventory:RegisterCarryBonus("Monetization", function(player)
		return self:_sumBenefit(player, "ExtraCarryWeight")
	end)
	self._inventory:RegisterStorageBonus("Monetization", function(player)
		return self:_sumBenefit(player, "ExtraPersonalStorage")
	end)
	self._xp:RegisterMultiplier("PurchasedBoost", function(player, category)
		if category ~= "Job" then
			return 1
		end
		return 1 + math.min(self:_sumBenefit(player, "JobXPBoost"), GamepassConfig.MaxPurchasedXPBoost)
	end)

	self._data.Loaded:Connect(function(player)
		self:RefreshOwnership(player)
	end)
	MarketplaceService.PromptGamePassPurchaseFinished:Connect(function(player, passId, purchased)
		if purchased then
			self._audit:Log("Market", "GamePassPurchased", { userId = player.UserId, passId = passId })
			self:RefreshOwnership(player)
		end
	end)
	Players.PlayerMembershipChanged:Connect(function(player)
		self:_applyBenefits(player)
	end)
	Players.PlayerRemoving:Connect(function(player)
		self._owned[player] = nil
		self._temporary[player] = nil
	end)
	self._character.Spawned:Connect(function(player)
		self:_applyCosmetics(player)
	end)

	MarketplaceService.ProcessReceipt = function(receipt)
		return self:_processReceipt(receipt)
	end

	Net.Query("Store", { rate = 0.5, burst = 2 }, function(player)
		return self:GetStoreView(player)
	end)
end

-- Ownership ----------------------------------------------------------------------

function MonetizationService:RefreshOwnership(player: Player)
	local owned = {}
	for key, pass in pairs(GamepassConfig.GamePasses) do
		if pass.Id and pass.Id > 0 then
			for _ = 1, 3 do
				local ok, result = pcall(MarketplaceService.UserOwnsGamePassAsync, MarketplaceService, player.UserId, pass.Id)
				if ok then
					owned[key] = result == true
					break
				end
				task.wait(1)
			end
		end
	end
	self._owned[player] = owned
	self:_applyBenefits(player)
end

function MonetizationService:IsPremium(player: Player): boolean
	return GamepassConfig.Premium.Enabled and player.MembershipType == Enum.MembershipType.Premium
end

function MonetizationService:_benefitSources(player: Player)
	local sources = {}
	for key, has in pairs(self._owned[player] or {}) do
		if has then
			table.insert(sources, GamepassConfig.GamePasses[key].Benefits)
		end
	end
	if self:IsPremium(player) then
		table.insert(sources, GamepassConfig.Premium.Benefits)
	end
	return sources
end

function MonetizationService:_sumBenefit(player: Player, key: string): number
	local total = 0
	for _, benefits in ipairs(self:_benefitSources(player)) do
		if type(benefits[key]) == "number" then
			total += benefits[key]
		end
	end
	return total
end

function MonetizationService:HasBenefit(player: Player, key: string): boolean
	for _, benefits in ipairs(self:_benefitSources(player)) do
		if benefits[key] then
			return true
		end
	end
	return false
end

function MonetizationService:OwnsPass(player: Player, passKey: string): boolean
	local owned = self._owned[player]
	return owned ~= nil and owned[passKey] == true
end

function MonetizationService:_applyBenefits(player: Player)
	local profile = self._data:Get(player)
	local cosmetics, emotes, titles = {}, {}, {}
	local nameplate = ""
	for _, benefits in ipairs(self:_benefitSources(player)) do
		if benefits.Cosmetic then
			table.insert(cosmetics, benefits.Cosmetic)
		end
		if benefits.Title then
			table.insert(titles, benefits.Title)
		end
		if benefits.NameplateStyle then
			nameplate = benefits.NameplateStyle
		end
		if benefits.Mount then
			table.insert(cosmetics, "Mount:" .. benefits.Mount)
		end
		for _, emote in ipairs(benefits.Emotes or {}) do
			table.insert(emotes, emote)
		end
	end
	if profile then
		for _, title in ipairs(profile.Titles or {}) do
			table.insert(titles, title)
		end
	end
	player:SetAttribute("KingdomCosmetics", table.concat(cosmetics, ","))
	player:SetAttribute("KingdomEmotes", table.concat(emotes, ","))
	player:SetAttribute("KingdomNameplateStyle", nameplate)
	if not player:GetAttribute("KingdomTitle") or player:GetAttribute("KingdomTitle") == "" then
		player:SetAttribute("KingdomTitle", titles[1] or "")
	end
	player:SetAttribute("KingdomTitles", table.concat(titles, ","))
	self._inventory:Publish(player)
	self:_applyCosmetics(player)
end

-- Cosmetics -----------------------------------------------------------------------

function MonetizationService:_applyCosmetics(player: Player)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not root then
		return
	end
	local active = {}
	for cosmetic in string.gmatch(tostring(player:GetAttribute("KingdomCosmetics") or ""), "[^,]+") do
		active[cosmetic] = true
	end
	for cosmetic, expiresAt in pairs(self._temporary[player] or {}) do
		if os.clock() < expiresAt then
			active[cosmetic] = true
		end
	end
	local existing = root:FindFirstChild("KingdomAura")
	if active.Aura and not existing then
		local attachment = Instance.new("Attachment")
		attachment.Name = "KingdomAura"
		local emitter = Instance.new("ParticleEmitter")
		emitter.Rate = 8
		emitter.Lifetime = NumberRange.new(1, 1.6)
		emitter.Speed = NumberRange.new(0.5, 1.5)
		emitter.LightEmission = 0.6
		emitter.Color = ColorSequence.new(Color3.fromRGB(240, 200, 90))
		emitter.Size = NumberSequence.new(0.3, 0)
		emitter.Parent = attachment
		attachment.Parent = root
	elseif not active.Aura and existing then
		existing:Destroy()
	end
end

function MonetizationService:_temporaryCosmetic(player: Player, cosmetic: string, seconds: number)
	local map = self._temporary[player] or {}
	self._temporary[player] = map
	map[cosmetic] = os.clock() + seconds
	self:_applyCosmetics(player)
	task.delay(seconds + 1, function()
		if player.Parent == Players then
			self:_applyCosmetics(player)
		end
	end)
end

function MonetizationService:_fireworks(player: Player)
	local points = CollectionService:GetTagged("KingdomCelebrationPoint")
	local positions = {}
	for _, point in ipairs(points) do
		local cframe = point:IsA("BasePart") and point.CFrame or nil
		if cframe then
			table.insert(positions, cframe.Position)
		end
	end
	local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart")
	if #positions == 0 and root and root:IsA("BasePart") then
		table.insert(positions, root.Position + Vector3.new(0, 20, 0))
	end
	for _, position in ipairs(positions) do
		local part = Instance.new("Part")
		part.Anchored = true
		part.CanCollide = false
		part.Transparency = 1
		part.Size = Vector3.one
		part.Position = position + Vector3.new(0, 30, 0)
		local emitter = Instance.new("ParticleEmitter")
		emitter.Rate = 0
		emitter.Speed = NumberRange.new(20, 40)
		emitter.SpreadAngle = Vector2.new(180, 180)
		emitter.Lifetime = NumberRange.new(1.5, 2.5)
		emitter.LightEmission = 1
		emitter.Color = ColorSequence.new(Color3.fromRGB(255, 200, 80), Color3.fromRGB(255, 80, 80))
		emitter.Parent = part
		part.Parent = workspace
		for burst = 0, 4 do
			task.delay(burst * 0.8, function()
				emitter:Emit(80)
			end)
		end
		task.delay(8, function()
			part:Destroy()
		end)
	end
	self._notify:Announce("Success", "Celebration!", player.DisplayName .. " lights fireworks over the kingdom!", { Banner = false })
end

-- Developer products ----------------------------------------------------------------

function MonetizationService:_findProduct(productId: number)
	for key, product in pairs(GamepassConfig.Products) do
		if product.Id == productId and product.Id > 0 then
			return key, product
		end
	end
	return nil, nil
end

function MonetizationService:_processReceipt(receipt)
	local player = Players:GetPlayerByUserId(receipt.PlayerId)
	if not player then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	local profile = self._data:Get(player)
	if not profile then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	local purchaseId = tostring(receipt.PurchaseId)
	if profile.ProcessedReceipts[purchaseId] then
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end
	local key, product = self:_findProduct(receipt.ProductId)
	if not product then
		self._audit:Log("Market", "UnknownProduct", { userId = player.UserId, productId = receipt.ProductId })
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end

	local ok, err = pcall(function()
		if product.Handler == "Fireworks" then
			self:_fireworks(player)
		elseif product.Handler == "TemporaryCosmetic" then
			self:_temporaryCosmetic(player, product.Cosmetic, product.DurationSeconds or 1800)
		elseif product.Handler == "Donation" then
			if product.Title and not table.find(profile.Titles, product.Title) then
				table.insert(profile.Titles, product.Title)
			end
			if (product.TreasuryAmount or 0) > 0 then
				self._economy:TreasuryDeposit(product.TreasuryAmount, "Donation")
			end
			self._notify:Announce("Success", "A generous patron", player.DisplayName .. " has supported the kingdom!", { Banner = false })
			self:_applyBenefits(player)
		end
	end)
	if not ok then
		self.Log:Error("product %s failed: %s", tostring(key), tostring(err))
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end

	profile.ProcessedReceipts[purchaseId] = os.time()
	-- Keep the receipt table bounded (oldest removed first).
	local count, oldestId, oldestTime = 0, nil, math.huge
	for id, time in pairs(profile.ProcessedReceipts) do
		count += 1
		if time < oldestTime then
			oldestId, oldestTime = id, time
		end
	end
	if count > RECEIPT_MEMORY and oldestId then
		profile.ProcessedReceipts[oldestId] = nil
	end
	self._audit:Log("Market", "ProductGranted", { userId = player.UserId, product = key, purchaseId = purchaseId })
	if not self._data:SaveNow(player, "Receipt") then
		-- The grant is recorded in memory; Roblox will retry and we will
		-- answer Granted from the in-memory record.
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	return Enum.ProductPurchaseDecision.PurchaseGranted
end

function MonetizationService:GetStoreView(player: Player)
	local passes, products = {}, {}
	for key, pass in pairs(GamepassConfig.GamePasses) do
		if pass.Id > 0 then
			table.insert(passes, { Key = key, Id = pass.Id, Name = pass.DisplayName, Owned = self:OwnsPass(player, key) })
		end
	end
	for key, product in pairs(GamepassConfig.Products) do
		if product.Id > 0 then
			table.insert(products, { Key = key, Id = product.Id, Name = product.DisplayName })
		end
	end
	return { Passes = passes, Products = products, Premium = self:IsPremium(player) }
end

return MonetizationService
