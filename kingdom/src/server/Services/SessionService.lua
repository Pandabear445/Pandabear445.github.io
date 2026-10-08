--[[
	SessionService
	Orchestrates joining and leaving in a fixed, safe order. Each step is
	isolated: one failing step is logged and the rest still run.

	JOIN
	  1. load data (session-locked)          4. place in hierarchy (bottom)
	  2. validate / repair fields             5. queue position published
	  3. temporary safe state until loaded    6. inventory, starter kit, escrow
	  7. permissions + admin flag             8. spawn character, welcome
	  Time, resources, meetings and events reach the client through the
	  StateService snapshot the client requests on startup.
	  If data cannot load the player stays in Safe Mode (can walk, cannot
	  progress) and steps 4+ run automatically once the data loads.

	LEAVE
	  1. stop active job                      5. remove from hierarchy -> cascade
	  2. roll back market escrow              6. departments/workforce update
	  3. release management assignments          (they read live players)
	  4. wait for any death reset to finish   7. final save + unlock
	  Managers are notified by ManagementService during step 3.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)

local SessionService = {
	Name = "SessionService",
	Dependencies = {
		"DataService",
		"PromotionService",
		"RankService",
		"InventoryService",
		"PermissionService",
		"CharacterService",
		"JobService",
		"MarketService",
		"ManagementService",
		"HousingService",
		"DeathService",
		"NotificationService",
		"XPService",
		"FoodService",
		"AuditService",
		"MonetizationService",
	},
}

function SessionService:Init()
	self._data = self:Use("DataService")
	self._promotion = self:Use("PromotionService")
	self._rank = self:Use("RankService")
	self._inventory = self:Use("InventoryService")
	self._permission = self:Use("PermissionService")
	self._character = self:Use("CharacterService")
	self._jobs = self:Use("JobService")
	self._market = self:Use("MarketService")
	self._management = self:Use("ManagementService")
	self._housing = self:Use("HousingService")
	self._death = self:Use("DeathService")
	self._notify = self:Use("NotificationService")
	self._xp = self:Use("XPService")
	self._food = self:Use("FoodService")
	self._audit = self:Use("AuditService")
	self._monetization = self:Use("MonetizationService")

	self.PlayerReady = Signal.new("PlayerReady") -- (player)
	self._ready = {}
	self._leaving = {}
end

function SessionService:Start()
	Players.PlayerAdded:Connect(function(player)
		self:_join(player)
	end)
	Players.PlayerRemoving:Connect(function(player)
		self:_leave(player)
	end)
	-- Data that loads late (Safe Mode recovery) finishes the join.
	self._data.Loaded:Connect(function(player)
		if not self._ready[player] and not self._leaving[player] then
			task.spawn(self._finishJoin, self, player)
		end
	end)
	for _, player in ipairs(Players:GetPlayers()) do
		task.spawn(self._join, self, player)
	end
end

function SessionService:_step(player: Player, label: string, fn: () -> ())
	local ok, err = pcall(fn)
	if not ok then
		self.Log:Error("%s step '%s' failed: %s", player.Name, label, tostring(err))
		self._audit:Log("System", "SessionStepFailed", { userId = player.UserId, step = label, error = tostring(err) })
	end
end

function SessionService:_join(player: Player)
	-- 1-3. Load (yields). Admin status is resolved early for the UI.
	self:_step(player, "admin", function()
		self._permission:IsAdmin(player)
	end)
	local profile = self._data:Load(player)
	if player.Parent ~= Players then
		return
	end
	if not profile then
		if self._data:IsSafeMode(player) then
			self._character:SpawnInitial(player)
			self._notify:Notify(
				player,
				"Critical",
				"Records unavailable",
				"The royal archive can't be reached. You can explore, but progress is paused until your records load. Nothing will be lost."
			)
		end
		return
	end
	-- Data.Loaded already fired and scheduled _finishJoin.
end

function SessionService:_finishJoin(player: Player)
	if self._ready[player] or player.Parent ~= Players then
		return
	end
	self._ready[player] = true

	-- 4-5. Hierarchy placement and queue position.
	self:_step(player, "hierarchy", function()
		self._promotion:OnPlayerJoin(player)
	end)
	-- 6. Inventory and anything owed from earlier sessions.
	self:_step(player, "starterKit", function()
		self._inventory:GiveStarterKit(player)
	end)
	self:_step(player, "marketEscrow", function()
		self._market:OnPlayerJoin(player)
	end)
	self:_step(player, "jobEscrow", function()
		self._jobs:OnPlayerJoin(player)
	end)
	self:_step(player, "housing", function()
		self._housing:OnPlayerJoin(player)
	end)
	-- 7. Permissions.
	self:_step(player, "permissions", function()
		self._permission:Publish(player)
	end)
	self:_step(player, "xp", function()
		self._xp:Publish(player)
	end)
	-- 8. Character and welcome.
	self:_step(player, "spawn", function()
		self._character:SpawnInitial(player)
	end)
	self:_step(player, "welcome", function()
		local rank = self._rank:GetRankDef(player)
		local profile = self._data:Get(player)
		local life = profile and profile.Life.Number or 1
		self._notify:Notify(
			player,
			"Information",
			"Welcome to the Kingdom",
			string.format("You are a %s (life #%d). Work at the kingdom's workplaces to earn XP and climb the ranks.", rank.DisplayName, life)
		)
	end)
	self._audit:Log("System", "Joined", { userId = player.UserId })
	self.PlayerReady:Fire(player)
end

function SessionService:_leave(player: Player)
	self._leaving[player] = true
	-- 1. Stop the active job (no rewards for unfinished work).
	self:_step(player, "jobs", function()
		self._jobs:CancelAll(player, "Left")
	end)
	-- 2. Roll back open market listings into the saved escrow.
	self:_step(player, "market", function()
		self._market:OnPlayerLeave(player)
	end)
	-- 3. Release management assignments, notify managers.
	self:_step(player, "management", function()
		self._management:OnPlayerLeave(player)
	end)
	-- 4. Never save over an in-progress death reset.
	local deadline = os.clock() + 15
	while self._death:IsProcessing(player) and os.clock() < deadline do
		task.wait(0.2)
	end
	-- 5. Hierarchy: server kingdoms vacate the slot and cascade.
	if self._ready[player] then
		self:_step(player, "hierarchy", function()
			self._promotion:OnPlayerLeave(player)
		end)
	end
	-- 7. Final save and session unlock.
	self:_step(player, "save", function()
		self._data:Release(player)
	end)
	self._audit:Log("System", "Left", { userId = player.UserId })
	self._ready[player] = nil
	self._leaving[player] = nil
end

function SessionService:IsReady(player: Player): boolean
	return self._ready[player] == true
end

return SessionService
