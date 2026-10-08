--[[
	PermissionService
	The only place that turns ranks into authority. Code asks:
	  Permission:Has(player, "Manage.WorkOrders")
	  Permission:CanManage(manager, target)
	  Permission:CanManageDepartment(player, "Agriculture")
	  Permission:IsAdmin(player)
	never "is this player a Knight?".

	Admin access is separate from kingdom ranks (AdminConfig, server only).
	Discipline suspensions temporarily remove job permissions.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local ServerScriptService = game:GetService("ServerScriptService")

local PermissionConfig = require(ReplicatedStorage.Kingdom.Config.PermissionConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local AdminConfig = require(ServerScriptService.Kingdom.Config.AdminConfig)

local PermissionService = {
	Name = "PermissionService",
	Dependencies = { "RankService", "DataService", "AuditService" },
}

function PermissionService:Init()
	self._rank = self:Use("RankService")
	self._data = self:Use("DataService")
	self._audit = self:Use("AuditService")
	self._adminCache = {}

	-- Pre-compute permission sets and report config typos.
	self._sets = {}
	for _, rank in ipairs(RankConfig.Ranks) do
		local set = {}
		for _, key in ipairs(rank.Permissions or {}) do
			if not PermissionConfig.Keys[key] then
				self.Log:Warn("RankConfig %s grants unknown permission '%s'", rank.Id, key)
			end
			set[key] = true
		end
		self._sets[rank.Id] = set
	end

	self._rank.PlayerRankChanged:Connect(function(player)
		self:Publish(player)
	end)
	Players.PlayerRemoving:Connect(function(player)
		self._adminCache[player] = nil
	end)
end

function PermissionService:Publish(player: Player)
	local rank = self._rank:GetRankDef(player)
	local keys = {}
	for key in pairs(self._sets[rank.Id] or {}) do
		if self:Has(player, key) then
			table.insert(keys, key)
		end
	end
	table.sort(keys)
	player:SetAttribute("KingdomPermissions", table.concat(keys, ","))
	player:SetAttribute("KingdomManageDepth", rank.ManageDepth or 0)
	player:SetAttribute("KingdomDashboardLevel", PermissionConfig.DashboardLevels[rank.DashboardLevel] or 1)
end

function PermissionService:IsSuspended(player: Player): (boolean, number)
	local profile = self._data:Get(player)
	if not profile then
		return false, 0
	end
	local untilTime = profile.Discipline.SuspendedUntil or 0
	return os.time() < untilTime, untilTime
end

function PermissionService:Has(player: Player, key: string): boolean
	local rank = self._rank:GetRankDef(player)
	local set = self._sets[rank.Id]
	if not set or not set[key] then
		return false
	end
	if string.sub(key, 1, 4) == "Job." and self:IsSuspended(player) then
		return false
	end
	return true
end

function PermissionService:GetRankOrder(target): number
	return self._rank:GetOrder(target)
end

-- True when manager's rank is above target's and within its ManageDepth.
function PermissionService:CanManage(manager: Player, target): boolean
	local managerRank = self._rank:GetRankDef(manager)
	local targetOrder = self._rank:GetOrder(target)
	local depth = managerRank.ManageDepth or 0
	return depth > 0 and managerRank.Order > targetOrder and managerRank.Order - targetOrder <= depth
end

function PermissionService:CanManageDepartment(player: Player, departmentId: string): boolean
	local rank = self._rank:GetRankDef(player)
	if (rank.ManageDepth or 0) <= 0 then
		return false
	end
	local departments = rank.Departments
	if departments == "*" then
		return true
	end
	return type(departments) == "table" and table.find(departments, departmentId) ~= nil
end

function PermissionService:GetDashboardLevel(player: Player): number
	local rank = self._rank:GetRankDef(player)
	return PermissionConfig.DashboardLevels[rank.DashboardLevel] or 1
end

function PermissionService:IsCouncil(player: Player): boolean
	return self._rank:GetRankDef(player).Council == true
end

-- Required rank check by rank Id (marker attribute RequiredRank).
function PermissionService:MeetsRank(player: Player, requiredRankId: string?): boolean
	if not requiredRankId or requiredRankId == "" then
		return true
	end
	local required = RankConfig.Get(requiredRankId)
	if not required then
		return true -- unknown rank names in markers never lock players out
	end
	return self._rank:GetOrder(player) >= required.Order
end

-- Administrators --------------------------------------------------------------

function PermissionService:IsAdmin(player: Player): boolean
	local cached = self._adminCache[player]
	if cached ~= nil then
		return cached
	end
	local isAdmin = false
	if table.find(AdminConfig.UserIds, player.UserId) then
		isAdmin = true
	elseif AdminConfig.StudioIsAdmin and RunService:IsStudio() then
		isAdmin = true
	elseif AdminConfig.OwnerIsAdmin and game.CreatorType == Enum.CreatorType.User and game.CreatorId == player.UserId then
		isAdmin = true
	elseif AdminConfig.Group.Id and AdminConfig.Group.Id > 0 then
		local ok, role = pcall(player.GetRankInGroupAsync, player, AdminConfig.Group.Id)
		isAdmin = ok and role >= AdminConfig.Group.MinRole
	end
	if not isAdmin and AdminConfig.OwnerIsAdmin and game.CreatorType == Enum.CreatorType.Group then
		local ok, role = pcall(player.GetRankInGroupAsync, player, game.CreatorId)
		isAdmin = ok and role == 255
	end
	self._adminCache[player] = isAdmin
	player:SetAttribute("KingdomAdmin", isAdmin)
	return isAdmin
end

return PermissionService
