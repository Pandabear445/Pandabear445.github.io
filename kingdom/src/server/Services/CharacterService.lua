--[[
	CharacterService
	Character lifecycle and everything physical about a player:
	  * manual spawning (so a death reset is saved BEFORE the player respawns)
	  * death detection with a server-determined cause
	      damage tags (combat, monsters, events), fall damage, drowning,
	      KingdomHazard parts (fire, spikes, collapses)
	  * walk speed from registered modifiers (weather, sickness, load)
	  * server-built nameplates showing rank tags (cannot be impersonated)
	  * whitelisted server teleports (meetings, admin) for anti-cheat
]]

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DeathConfig = require(ReplicatedStorage.Kingdom.Config.DeathConfig)
local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)
local MeetingConfig = require(ReplicatedStorage.Kingdom.Config.MeetingConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local CharacterService = {
	Name = "CharacterService",
	Dependencies = { "DataService", "RankService", "ActivityService", "WeatherService", "AuditService" },
}

local BASE_WALK_SPEED = 16
local HAZARD_TAG = "KingdomHazard"
local HAZARD_TICK = 0.5

function CharacterService:Init()
	self._data = self:Use("DataService")
	self._rank = self:Use("RankService")
	self._activity = self:Use("ActivityService")
	self._weather = self:Use("WeatherService")
	self._audit = self:Use("AuditService")

	self.Spawned = Signal.new("CharacterSpawned") -- (player, character)
	self.Died = Signal.new("CharacterDied") -- (player, cause, position, attacker)

	self._tags = {} -- [Player] = { cause, attacker, time }
	self._lastDamaged = {}
	self._speedModifiers = {}
	self._respawnHolds = {}
	self._spawnOverrides = {}
	self._alive = {}

	Players.CharacterAutoLoads = false

	self:RegisterSpeedModifier("Weather", function()
		return self._weather:GetWalkSpeedMultiplier()
	end)

	Players.PlayerAdded:Connect(function(player)
		self:_watchPlayer(player)
	end)
	for _, player in ipairs(Players:GetPlayers()) do
		self:_watchPlayer(player)
	end
	Players.PlayerRemoving:Connect(function(player)
		self._tags[player] = nil
		self._lastDamaged[player] = nil
		self._respawnHolds[player] = nil
		self._spawnOverrides[player] = nil
		self._alive[player] = nil
	end)
end

function CharacterService:Start()
	self.Registry:Every(self.Name, "walkSpeed", 2, function()
		for _, player in ipairs(Players:GetPlayers()) do
			self:_applySpeed(player)
		end
	end)
	self.Registry:Every(self.Name, "hazards", HAZARD_TICK, function()
		self:_hazardTick()
	end)
end

function CharacterService:_watchPlayer(player: Player)
	player.CharacterAdded:Connect(function(character)
		self:_onCharacter(player, character)
	end)
	for _, attribute in ipairs({ "KingdomRank", "KingdomTitle", "KingdomRankColor" }) do
		player:GetAttributeChangedSignal(attribute):Connect(function()
			self:_updateNameplate(player)
		end)
	end
end

-- Spawning ---------------------------------------------------------------------

-- First spawn (called by SessionService once data has loaded or failed).
function CharacterService:SpawnInitial(player: Player)
	if player.Parent == Players and not player.Character then
		self:_spawn(player)
	end
end

function CharacterService:_spawn(player: Player)
	local ok, err = pcall(player.LoadCharacter, player)
	if not ok then
		self.Log:Warn("LoadCharacter failed for %s: %s", player.Name, tostring(err))
	end
end

-- DeathService holds respawn until the death reset is saved.
function CharacterService:HoldRespawn(player: Player, key: string)
	self._respawnHolds[player] = self._respawnHolds[player] or {}
	self._respawnHolds[player][key] = true
end

function CharacterService:ReleaseRespawn(player: Player, key: string)
	local holds = self._respawnHolds[player]
	if holds then
		holds[key] = nil
	end
end

function CharacterService:_scheduleRespawn(player: Player)
	task.spawn(function()
		task.wait(GameConfig.RespawnSeconds)
		local deadline = os.clock() + GameConfig.MaxRespawnWaitForDeathSave
		while player.Parent == Players and os.clock() < deadline do
			local holds = self._respawnHolds[player]
			if not holds or next(holds) == nil then
				break
			end
			task.wait(0.25)
		end
		self._respawnHolds[player] = nil
		if player.Parent == Players then
			self:_spawn(player)
		end
	end)
end

function CharacterService:SetSpawnOverride(player: Player, cframe: CFrame?)
	self._spawnOverrides[player] = cframe
end

function CharacterService:_onCharacter(player: Player, character: Model)
	local humanoid = character:WaitForChild("Humanoid", 10)
	if not humanoid or not humanoid:IsA("Humanoid") then
		return
	end
	self._alive[player] = true
	self._tags[player] = nil

	local override = self._spawnOverrides[player]
	if override then
		task.defer(function()
			self:Teleport(player, override, "HomeSpawn")
		end)
	end

	-- Fall damage: measure fall height between Freefall and Landed.
	local fallStartY: number? = nil
	humanoid.StateChanged:Connect(function(_, new)
		local root = character:FindFirstChild("HumanoidRootPart")
		if not root or not root:IsA("BasePart") then
			return
		end
		if new == Enum.HumanoidStateType.Freefall then
			fallStartY = root.Position.Y
		elseif new == Enum.HumanoidStateType.Landed and fallStartY then
			local height = fallStartY - root.Position.Y
			fallStartY = nil
			local config = DeathConfig.FallDamage
			if config.Enabled and height > 0 and not self._activity:IsTeleportAllowed(player) then
				local impact = math.sqrt(2 * workspace.Gravity * height)
				if impact > config.MinVelocity then
					self:Damage(player, (impact - config.MinVelocity) * config.DamagePerVelocity, DeathConfig.Causes.Fall)
				end
			end
		elseif new == Enum.HumanoidStateType.Swimming or new == Enum.HumanoidStateType.Running then
			fallStartY = nil
		end
	end)

	local lastHealth = humanoid.Health
	humanoid.HealthChanged:Connect(function(health)
		if health < lastHealth then
			self._lastDamaged[player] = os.clock()
		end
		lastHealth = health
	end)

	humanoid.Died:Connect(function()
		if not self._alive[player] then
			return
		end
		self._alive[player] = false
		local root = character:FindFirstChild("HumanoidRootPart")
		local position = root and root:IsA("BasePart") and root.Position or nil
		local cause, attacker = self:_determineCause(player, humanoid)
		self._audit:Log("Death", "Died", { userId = player.UserId, cause = cause, attacker = attacker and attacker.UserId })
		self.Died:Fire(player, cause, position, attacker)
		self:_scheduleRespawn(player)
	end)

	self:_buildNameplate(player, character)
	self:_applySpeed(player)
	self.Spawned:Fire(player, character)
end

-- Damage & causes ------------------------------------------------------------------

-- Records who/what is hurting the player, so a death is attributed correctly.
function CharacterService:TagDamage(player: Player, cause: string, attacker: Player?)
	self._tags[player] = { cause = cause, attacker = attacker, time = os.clock() }
	self._lastDamaged[player] = os.clock()
end

function CharacterService:Damage(player: Player, amount: number, cause: string, attacker: Player?)
	local humanoid = ZoneUtil.getHumanoid(player)
	if not humanoid or humanoid.Health <= 0 or amount <= 0 then
		return
	end
	self:TagDamage(player, cause, attacker)
	humanoid:TakeDamage(amount)
end

function CharacterService:_determineCause(player: Player, humanoid: Humanoid): (string, Player?)
	local tag = self._tags[player]
	if tag and os.clock() - tag.time <= DeathConfig.TagSeconds then
		return tag.cause, tag.attacker
	end
	local state = humanoid:GetState()
	if state == Enum.HumanoidStateType.Swimming then
		return DeathConfig.Causes.Drowning, nil
	end
	if state == Enum.HumanoidStateType.Freefall or state == Enum.HumanoidStateType.FallingDown then
		return DeathConfig.Causes.Fall, nil
	end
	return DeathConfig.Causes.Unknown, nil
end

function CharacterService:_hazardTick()
	local hazards = CollectionService:GetTagged(HAZARD_TAG)
	if #hazards == 0 then
		return
	end
	for _, player in ipairs(Players:GetPlayers()) do
		local root = ZoneUtil.getRoot(player)
		if root then
			for _, hazard in ipairs(hazards) do
				if hazard:GetAttribute("Enabled") ~= false and ZoneUtil.containsPoint(hazard, root.Position, 0) then
					local dps = ZoneUtil.readAttribute(hazard, "DamagePerSecond", 10)
					local hazardType = ZoneUtil.readAttribute(hazard, "HazardType", "Hazard")
					local cause = DeathConfig.Causes[hazardType] or ZoneUtil.readAttribute(hazard, "Cause", DeathConfig.Causes.Hazard)
					self:Damage(player, dps * HAZARD_TICK, cause)
					break
				end
			end
		end
	end
end

function CharacterService:IsProtected(player: Player): boolean
	if player:GetAttribute(MeetingConfig.Teleport.ProtectedAttribute) then
		return true
	end
	local character = player.Character
	if character and character:GetAttribute(MeetingConfig.Teleport.ProtectedAttribute) then
		return true
	end
	local last = self._lastDamaged[player]
	return last ~= nil and os.clock() - last < MeetingConfig.Teleport.CombatProtectionSeconds
end

-- Movement ------------------------------------------------------------------------

function CharacterService:RegisterSpeedModifier(name: string, fn: (Player) -> number)
	self._speedModifiers[name] = fn
end

function CharacterService:_applySpeed(player: Player)
	local humanoid = ZoneUtil.getHumanoid(player)
	if not humanoid or humanoid.Health <= 0 then
		return
	end
	local multiplier = 1
	for _, fn in pairs(self._speedModifiers) do
		local ok, value = pcall(fn, player)
		if ok and type(value) == "number" and value == value then
			multiplier *= value
		end
	end
	humanoid.WalkSpeed = BASE_WALK_SPEED * math.clamp(multiplier, 0.3, 2)
end

function CharacterService:GetMaxWalkSpeed(): number
	return BASE_WALK_SPEED * 2
end

function CharacterService:Teleport(player: Player, target: CFrame, reason: string)
	local character = player.Character
	if not character or not ZoneUtil.isAlive(player) then
		return false
	end
	self._activity:AllowTeleport(player, 4)
	character:PivotTo(target)
	self._audit:Log("System", "Teleport", { userId = player.UserId, reason = reason })
	return true
end

-- Nameplates -----------------------------------------------------------------------

function CharacterService:_buildNameplate(player: Player, character: Model)
	local head = character:WaitForChild("Head", 5)
	if not head or not head:IsA("BasePart") then
		return
	end
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if humanoid then
		humanoid.DisplayDistanceType = Enum.HumanoidDisplayDistanceType.None
	end
	local gui = Instance.new("BillboardGui")
	gui.Name = "KingdomNameplate"
	gui.Size = UDim2.fromOffset(220, 54)
	gui.StudsOffset = Vector3.new(0, 2.6, 0)
	gui.MaxDistance = 80
	gui.AlwaysOnTop = false
	gui.LightInfluence = 0

	local rankLabel = Instance.new("TextLabel")
	rankLabel.Name = "Rank"
	rankLabel.BackgroundTransparency = 1
	rankLabel.Size = UDim2.new(1, 0, 0.4, 0)
	rankLabel.Font = Enum.Font.Fondamento
	rankLabel.TextScaled = true
	rankLabel.TextStrokeTransparency = 0.4
	rankLabel.Parent = gui

	local nameLabel = Instance.new("TextLabel")
	nameLabel.Name = "PlayerName"
	nameLabel.BackgroundTransparency = 1
	nameLabel.Position = UDim2.fromScale(0, 0.4)
	nameLabel.Size = UDim2.new(1, 0, 0.6, 0)
	nameLabel.Font = Enum.Font.Merriweather
	nameLabel.TextScaled = true
	nameLabel.TextColor3 = Color3.fromRGB(245, 234, 210)
	nameLabel.TextStrokeTransparency = 0.3
	nameLabel.Parent = gui

	gui.Parent = head
	self:_updateNameplate(player)
end

function CharacterService:_updateNameplate(player: Player)
	local character = player.Character
	local head = character and character:FindFirstChild("Head")
	local gui = head and head:FindFirstChild("KingdomNameplate")
	if not gui then
		return
	end
	local rank = self._rank:GetRankDef(player)
	local rankLabel = gui:FindFirstChild("Rank") :: TextLabel?
	local nameLabel = gui:FindFirstChild("PlayerName") :: TextLabel?
	if rankLabel then
		rankLabel.Text = "[" .. (rank.ChatTag or rank.DisplayName) .. "]"
		rankLabel.TextColor3 = rank.Color or Color3.new(1, 1, 1)
	end
	if nameLabel then
		local title = player:GetAttribute("KingdomTitle")
		nameLabel.Text = player.DisplayName .. ((type(title) == "string" and title ~= "") and (" " .. title) or "")
	end
end

return CharacterService
