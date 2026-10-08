--[[
	CombatService
	Server-validated melee combat and simple hostile NPCs (bandits, monsters).

	The client only says "I swung" (Input "Swing"). The server checks the
	equipped weapon, cooldown and durability, then finds targets in front of
	the character itself. Players are only valid targets when
	DeathConfig.PvP.Enabled (off by default: a kill erases a whole career).

	Hostiles are Models tagged "KingdomHostile" (spawned by events from
	ServerStorage.Kingdom.NPCs templates, or placed in the map). One shared
	loop drives all of them; there is no per-NPC script.
]]

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local DeathConfig = require(ReplicatedStorage.Kingdom.Config.DeathConfig)
local EventConfig = require(ReplicatedStorage.Kingdom.Config.EventConfig)
local ItemConfig = require(ReplicatedStorage.Kingdom.Config.ItemConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Net = require(script.Parent.Parent.Core.Net)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local CombatService = {
	Name = "CombatService",
	Dependencies = {
		"CharacterService",
		"InventoryService",
		"PermissionService",
		"ActivityService",
		"AuditService",
		"XPService",
		"DataService",
	},
}

local HOSTILE_TAG = "KingdomHostile"
local BRAIN_TICK = 0.5

function CombatService:Init()
	self._character = self:Use("CharacterService")
	self._inventory = self:Use("InventoryService")
	self._permission = self:Use("PermissionService")
	self._activity = self:Use("ActivityService")
	self._audit = self:Use("AuditService")
	self._xp = self:Use("XPService")
	self._data = self:Use("DataService")

	self.HostileDefeated = Signal.new("HostileDefeated") -- (killer?, model, kind)
	self._lastSwing = {}
	self._npcs = {}

	Net.Input("Swing", { rate = 3, burst = 4 }, function(player)
		self:_swing(player)
	end)

	for _, model in ipairs(CollectionService:GetTagged(HOSTILE_TAG)) do
		self:_registerHostile(model)
	end
	CollectionService:GetInstanceAddedSignal(HOSTILE_TAG):Connect(function(model)
		self:_registerHostile(model)
	end)
	Players.PlayerRemoving:Connect(function(player)
		self._lastSwing[player] = nil
	end)
end

function CombatService:Start()
	self.Registry:Every(self.Name, "brains", BRAIN_TICK, function()
		self:_brainTick()
	end)
end

-- Player attacks --------------------------------------------------------------

function CombatService:_equippedWeapon(player: Player)
	local character = player.Character
	local tool = character and character:FindFirstChildOfClass("Tool")
	local toolId = tool and tool:GetAttribute("KingdomTool")
	local def = toolId and ItemConfig.Get(toolId)
	if def and def.Weapon then
		return toolId, def
	end
	return nil, nil
end

function CombatService:_swing(player: Player)
	if not self._data:IsLoaded(player) or not ZoneUtil.isAlive(player) then
		return
	end
	local toolId, def = self:_equippedWeapon(player)
	if not toolId or not def then
		return
	end
	local now = os.clock()
	if self._lastSwing[player] and now - self._lastSwing[player] < def.Weapon.Cooldown * 0.9 then
		return
	end
	self._lastSwing[player] = now
	local ok, efficiency = self._inventory:UseTool(player, toolId)
	if not ok then
		return
	end
	self._activity:MarkInteraction(player)
	local root = ZoneUtil.getRoot(player)
	if not root then
		return
	end
	local damage = def.Weapon.Damage * math.max(efficiency, 0.4)
	local range = def.Weapon.Range
	local origin = root.Position
	local forward = root.CFrame.LookVector

	local function inArc(position: Vector3): boolean
		local offset = position - origin
		if offset.Magnitude > range then
			return false
		end
		return offset.Magnitude < 2 or forward:Dot(offset.Unit) > 0.35
	end

	-- NPC targets
	for model, npc in pairs(self._npcs) do
		local npcRoot = npc.root
		if npcRoot and npcRoot.Parent and npc.humanoid.Health > 0 and inArc(npcRoot.Position) then
			npc.lastAttacker = player
			npc.humanoid:TakeDamage(damage)
			if npc.humanoid.Health <= 0 then
				self:_onHostileDied(model, npc)
			end
			return
		end
	end

	-- Player targets (PvP is opt-in)
	if not DeathConfig.PvP.Enabled or not self._permission:Has(player, DeathConfig.PvP.RequiredPermission) then
		return
	end
	for _, other in ipairs(Players:GetPlayers()) do
		local otherRoot = other ~= player and ZoneUtil.getRoot(other)
		if otherRoot and ZoneUtil.isAlive(other) and inArc(otherRoot.Position) then
			self._character:Damage(other, damage, DeathConfig.Causes.Player, player)
			self._audit:Log("System", "PvPHit", { attacker = player.UserId, target = other.UserId, damage = damage })
			return
		end
	end
end

-- Hostile NPCs -------------------------------------------------------------------

function CombatService:_registerHostile(model: Instance)
	if not model:IsA("Model") or self._npcs[model] then
		return
	end
	local humanoid = model:FindFirstChildOfClass("Humanoid")
	local root = model:FindFirstChild("HumanoidRootPart")
	if not humanoid or not root or not root:IsA("BasePart") then
		return
	end
	local kind = model:GetAttribute("HostileType") or "Bandit"
	local stats = EventConfig.Hostiles[kind] or EventConfig.Hostiles.Bandit
	humanoid.MaxHealth = stats.Health
	humanoid.Health = stats.Health
	humanoid.WalkSpeed = stats.WalkSpeed
	self._npcs[model] = {
		humanoid = humanoid,
		root = root,
		kind = kind,
		stats = stats,
		lastAttack = 0,
		lastAttacker = nil,
	}
	humanoid.Died:Connect(function()
		local npc = self._npcs[model]
		if npc then
			self:_onHostileDied(model, npc)
		end
	end)
end

function CombatService:_onHostileDied(model: Instance, npc)
	if not self._npcs[model] then
		return
	end
	self._npcs[model] = nil
	local killer = npc.lastAttacker
	if killer and killer.Parent == Players then
		self._xp:Award(killer, "Job", npc.stats.XPOnKill or 20, { source = "Combat:" .. npc.kind, jobId = "GuardDuty" })
	end
	self._audit:Log("System", "HostileDefeated", { kind = npc.kind, killer = killer and killer.UserId })
	self.HostileDefeated:Fire(killer, model, npc.kind)
	task.delay(5, function()
		if model.Parent then
			model:Destroy()
		end
	end)
end

function CombatService:_brainTick()
	local now = os.clock()
	for model, npc in pairs(self._npcs) do
		if not model.Parent or npc.humanoid.Health <= 0 then
			self._npcs[model] = nil
		else
			local nearest, nearestDistance = nil, npc.stats.AggroRange
			for _, player in ipairs(Players:GetPlayers()) do
				local root = ZoneUtil.getRoot(player)
				if root and ZoneUtil.isAlive(player) then
					local distance = (root.Position - npc.root.Position).Magnitude
					if distance < nearestDistance then
						nearest, nearestDistance = player, distance
					end
				end
			end
			if nearest then
				local targetRoot = ZoneUtil.getRoot(nearest)
				if targetRoot then
					npc.humanoid:MoveTo(targetRoot.Position)
					if nearestDistance <= 5 and now - npc.lastAttack >= npc.stats.AttackCooldown then
						npc.lastAttack = now
						local cause = DeathConfig.Causes[npc.kind] or DeathConfig.Causes.Monster
						self._character:Damage(nearest, npc.stats.Damage, cause)
					end
				end
			end
		end
	end
end

-- Spawns hostiles from ServerStorage.Kingdom.NPCs.<template> at markers.
function CombatService:SpawnHostiles(template: string, count: number, spawnTag: string): { Model }
	local folder = ServerStorage:FindFirstChild("Kingdom")
	folder = folder and folder:FindFirstChild("NPCs")
	local source = folder and folder:FindFirstChild(template)
	local spawns = CollectionService:GetTagged(spawnTag)
	local spawned = {}
	if not source or not source:IsA("Model") or #spawns == 0 then
		return spawned
	end
	for i = 1, count do
		local marker = spawns[(i - 1) % #spawns + 1]
		local position = ZoneUtil.getPosition(marker)
		if position then
			local clone = source:Clone()
			clone:SetAttribute("HostileType", template)
			clone:PivotTo(CFrame.new(position + Vector3.new(math.random(-6, 6), 3, math.random(-6, 6))))
			clone.Parent = workspace
			clone:AddTag(HOSTILE_TAG)
			table.insert(spawned, clone)
		end
	end
	return spawned
end

function CombatService:CountHostiles(): number
	local count = 0
	for _ in pairs(self._npcs) do
		count += 1
	end
	return count
end

function CombatService:ClearHostiles()
	for model in pairs(self._npcs) do
		model:Destroy()
	end
	self._npcs = {}
end

return CombatService
