--[[
	AdminService
	Secure administration, completely separate from kingdom ranks.
	  * Only PermissionService:IsAdmin players (AdminConfig, server-only) can
	    run anything. Non-admin attempts are refused AND flagged.
	  * Commands run from the admin panel (Action "Admin.Run") or chat
	    ("/k <command> ..."). Every command is audit-logged.
	  * Developer simulations and bots route to TestingService.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local AdminConfig = require(ServerScriptService.Kingdom.Config.AdminConfig)
local ItemConfig = require(ReplicatedStorage.Kingdom.Config.ItemConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)
local ZoneUtil = require(script.Parent.Parent.Core.ZoneUtil)

local AdminService = {
	Name = "AdminService",
	Dependencies = {
		"PermissionService",
		"AuditService",
		"XPService",
		"PromotionService",
		"RankService",
		"DataService",
		"EconomyService",
		"ResourceService",
		"InventoryService",
		"CharacterService",
		"MeetingService",
		"BuildingService",
		"TimeService",
		"WeatherService",
		"EventService",
		"KingdomService",
		"AntiExploitService",
		"TestingService",
		"NotificationService",
	},
}

function AdminService:Init()
	self._permission = self:Use("PermissionService")
	self._audit = self:Use("AuditService")
	self._xp = self:Use("XPService")
	self._promotion = self:Use("PromotionService")
	self._rank = self:Use("RankService")
	self._data = self:Use("DataService")
	self._economy = self:Use("EconomyService")
	self._resources = self:Use("ResourceService")
	self._inventory = self:Use("InventoryService")
	self._character = self:Use("CharacterService")
	self._meetings = self:Use("MeetingService")
	self._buildings = self:Use("BuildingService")
	self._time = self:Use("TimeService")
	self._weather = self:Use("WeatherService")
	self._events = self:Use("EventService")
	self._kingdom = self:Use("KingdomService")
	self._antiExploit = self:Use("AntiExploitService")
	self._testing = self:Use("TestingService")
	self._notify = self:Use("NotificationService")

	self._commands = {}
	self:_defineCommands()

	Net.Action("Admin", "Run", { rate = 2, burst = 6 }, function(player, payload)
		if not self._permission:IsAdmin(player) then
			Net.BadRequest:Fire(player, "Admin.Run", "not admin")
			return false, "Unknown action."
		end
		local line = Check.string(payload.command, 300)
		if not line then
			return false, "Invalid command."
		end
		return self:Execute(player, line)
	end)
	Net.Query("AdminInfo", { rate = 1, burst = 3, allowUnloaded = true }, function(player, args)
		if not self._permission:IsAdmin(player) then
			return { IsAdmin = false }
		end
		local commands = {}
		for name, command in pairs(self._commands) do
			table.insert(commands, { Name = name, Usage = command.usage })
		end
		table.sort(commands, function(a, b)
			return a.Name < b.Name
		end)
		return {
			IsAdmin = true,
			Testing = self._testing.Enabled,
			Commands = commands,
			Logs = self._audit:Query({
				category = Check.string(args.category, 30),
				text = Check.string(args.text, 60),
				limit = 80,
			}),
			Suspicion = self._antiExploit:GetScores(),
		}
	end)

	local function hookChat(player: Player)
		player.Chatted:Connect(function(message)
			local prefix = AdminConfig.ChatPrefix .. " "
			if string.sub(message, 1, #prefix) == prefix and self._permission:IsAdmin(player) then
				local ok, result = self:Execute(player, string.sub(message, #prefix + 1))
				self._notify:Notify(player, ok and "Success" or "Warning", "Admin", result)
			end
		end)
	end
	Players.PlayerAdded:Connect(hookChat)
	for _, player in ipairs(Players:GetPlayers()) do
		hookChat(player)
	end
end

-- Helpers ------------------------------------------------------------------------

local function split(line: string): { string }
	local parts = {}
	for word in string.gmatch(line, "%S+") do
		table.insert(parts, word)
	end
	return parts
end

function AdminService:_findPlayer(admin: Player, query: string?): Player?
	if not query or query == "" or query == "me" then
		return admin
	end
	local userId = tonumber(query)
	if userId then
		return Players:GetPlayerByUserId(userId)
	end
	query = string.lower(query)
	for _, player in ipairs(Players:GetPlayers()) do
		if string.lower(player.Name) == query or string.lower(player.DisplayName) == query then
			return player
		end
	end
	for _, player in ipairs(Players:GetPlayers()) do
		if string.sub(string.lower(player.Name), 1, #query) == query or string.sub(string.lower(player.DisplayName), 1, #query) == query then
			return player
		end
	end
	return nil
end

local function rankByName(name: string?)
	if not name then
		return nil
	end
	for _, rank in ipairs(RankConfig.Ranks) do
		if string.lower(rank.Id) == string.lower(name) or string.lower(rank.DisplayName) == string.lower(name) then
			return rank
		end
	end
	return nil
end

local function resourceByName(name: string?): string?
	if not name then
		return nil
	end
	for id in pairs(ResourceConfig.Resources) do
		if string.lower(id) == string.lower(name) then
			return id
		end
	end
	return nil
end

function AdminService:Execute(admin: Player, line: string)
	local args = split(line)
	local name = string.lower(table.remove(args, 1) or "")
	local command = self._commands[name]
	if not command then
		return false, "Unknown command. Try 'help'."
	end
	self._audit:Log("Admin", "Command", { by = admin.UserId, command = line })
	local ok, success, message = pcall(command.run, admin, args)
	if not ok then
		return false, "Command error: " .. tostring(success)
	end
	return success, message or (success and "Done." or "Failed.")
end

function AdminService:_define(name: string, usage: string, run)
	self._commands[name] = { usage = usage, run = run }
end

-- Commands -------------------------------------------------------------------------

function AdminService:_defineCommands()
	self:_define("help", "help", function()
		local names = {}
		for commandName in pairs(self._commands) do
			table.insert(names, commandName)
		end
		table.sort(names)
		return true, table.concat(names, ", ")
	end)

	self:_define("givexp", "givexp <player> <amount> [Job|Management|Leadership|Contribution]", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		local amount = tonumber(args[2])
		if not target or not amount then
			return false, "Usage: givexp <player> <amount> [category]"
		end
		local awarded = self._xp:Award(target, args[3] or "Job", amount, { raw = true, source = "Admin" })
		return true, string.format("Gave %d XP to %s.", awarded, target.Name)
	end)

	self:_define("removexp", "removexp <player> <amount>", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		local amount = tonumber(args[2])
		if not target or not amount then
			return false, "Usage: removexp <player> <amount>"
		end
		local removed = self._xp:Remove(target, amount, "Admin")
		return true, string.format("Removed %d XP from %s.", removed, target.Name)
	end)

	self:_define("setrank", "setrank <player> <rank>", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		local rank = rankByName(args[2])
		if not target or not rank then
			return false, "Usage: setrank <player> <rank>"
		end
		local ok, err = self._promotion:SetRank(target, rank.Id, "Admin")
		return ok, ok and ("Set " .. target.Name .. " to " .. rank.DisplayName) or ("Failed: " .. tostring(err) .. " (demote a holder first if full)")
	end)

	self:_define("resetlife", "resetlife <player>  (death-style reset without dying)", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		if not target then
			return false, "No such player."
		end
		local profile = self._data:Get(target)
		self._xp:ResetLife(target, "Admin")
		self._promotion:ResetLife(target, "Admin", profile and profile.Life.Number or nil)
		self._data:SaveNow(target, "AdminResetLife")
		return true, "Reset " .. target.Name
	end)

	self:_define("wipe", "wipe <player> [keeplifetime]  (data reset, kicks)", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		if not target or target == admin and args[1] ~= "me" then
			return false, "Name a player explicitly."
		end
		self._data:ResetProfile(target, args[2] == "keeplifetime")
		task.delay(1, function()
			target:Kick("Your data was reset by an administrator. Please rejoin.")
		end)
		return true, "Wiped " .. target.Name
	end)

	self:_define("coins", "coins <player> <amount>  (negative removes)", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		local amount = tonumber(args[2])
		if not target or not amount then
			return false, "Usage: coins <player> <amount>"
		end
		if amount >= 0 then
			self._economy:AddCoins(target, amount, "Admin")
		else
			self._economy:RemoveCoins(target, math.min(-amount, self._economy:GetCoins(target)), "Admin")
		end
		return true, "Coins updated."
	end)

	self:_define("treasury", "treasury <amount>  (negative removes)", function(_, args)
		local amount = tonumber(args[1])
		if not amount then
			return false, "Usage: treasury <amount>"
		end
		if amount >= 0 then
			self._economy:TreasuryDeposit(amount, "Admin")
		else
			self._economy:TreasuryWithdraw(math.min(-amount, self._economy:GetTreasury()), "Admin")
		end
		return true, "Treasury: " .. self._economy:GetTreasury()
	end)

	self:_define("reseteconomy", "reseteconomy [players]", function(_, args)
		self._economy:ResetEconomy(args[1] == "players")
		return true, "Economy reset."
	end)

	self:_define("spawn", "spawn <resource> <amount>  (into kingdom storage)", function(_, args)
		local resourceId = resourceByName(args[1])
		local amount = tonumber(args[2])
		if not resourceId or not amount then
			return false, "Usage: spawn <resource> <amount>"
		end
		local accepted = self._resources:Deposit(resourceId, amount, "Admin")
		return true, string.format("Stored %d %s.", accepted, resourceId)
	end)

	self:_define("setstock", "setstock <resource> <amount>", function(_, args)
		local resourceId = resourceByName(args[1])
		local amount = tonumber(args[2])
		if not resourceId or not amount then
			return false, "Usage: setstock <resource> <amount>"
		end
		self._resources:SetStock(resourceId, amount, "Admin")
		return true, "Stock set."
	end)

	self:_define("resetresources", "resetresources", function()
		self._resources:ResetToStarting("Admin")
		return true, "Resources reset to starting stock."
	end)

	self:_define("give", "give <player> <resource> <amount>", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		local resourceId = resourceByName(args[2])
		local amount = tonumber(args[3])
		if not target or not resourceId or not amount then
			return false, "Usage: give <player> <resource> <amount>"
		end
		local added = self._inventory:Add(target, resourceId, amount, "Admin")
		self._inventory:AddTaint(target, resourceId, added)
		return true, string.format("Gave %d.", added)
	end)

	self:_define("tool", "tool <player> <tool> [Starter|Standard|Fine]", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		local toolId = if args[2] and ItemConfig.Get(args[2]) then args[2] else nil
		if not target or not toolId then
			return false, "Usage: tool <player> <tool> [quality]"
		end
		self._inventory:AddTool(target, toolId, args[3] or "Standard", nil, "Admin")
		return true, "Tool given."
	end)

	self:_define("tp", "tp <player> [destination player]", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		local destination = self:_findPlayer(admin, args[2] or "me")
		local root = destination and ZoneUtil.getRoot(destination)
		if not target or not root then
			return false, "Usage: tp <player> [to]"
		end
		self._character:Teleport(target, root.CFrame * CFrame.new(0, 0, 4), "Admin")
		return true, "Teleported."
	end)

	self:_define("kill", "kill <player>  (real death: XP/rank reset applies)", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		if not target then
			return false, "No such player."
		end
		self._character:Damage(target, 1e6, "Kingdom event")
		return true, "Killed " .. target.Name
	end)

	self:_define("heal", "heal <player>", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		local humanoid = target and ZoneUtil.getHumanoid(target)
		if humanoid then
			humanoid.Health = humanoid.MaxHealth
			return true, "Healed."
		end
		return false, "No such player."
	end)

	self:_define("kick", "kick <player> <reason>", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		if not target or target == admin then
			return false, "No such player."
		end
		target:Kick("Kicked by an administrator: " .. table.concat(args, " ", 2))
		return true, "Kicked."
	end)

	self:_define("ban", "ban <player|userId> <hours|perm> <reason>", function(admin, args)
		local target = self:_findPlayer(admin, args[1])
		local userId = target and target.UserId or tonumber(args[1])
		if not userId or userId == admin.UserId then
			return false, "Usage: ban <player|userId> <hours|perm> <reason>"
		end
		local hours = args[2] == "perm" and 0 or tonumber(args[2]) or 0
		local reason = table.concat(args, " ", 3)
		local ok = self._data:SetBan(userId, reason ~= "" and reason or "No reason", hours * 3600, admin.UserId)
		self._audit:Log("Admin", "Ban", { by = admin.UserId, target = userId, hours = hours, reason = reason })
		if target then
			target:Kick("You have been banned: " .. reason)
		end
		return ok, ok and "Banned." or "Ban could not be saved."
	end)

	self:_define("unban", "unban <userId>", function(admin, args)
		local userId = tonumber(args[1])
		if not userId then
			return false, "Usage: unban <userId>"
		end
		self._audit:Log("Admin", "Unban", { by = admin.UserId, target = userId })
		return self._data:RemoveBan(userId), "Unbanned."
	end)

	self:_define("startmeeting", "startmeeting <MeetingID>", function(_, args)
		local runId = args[1] and self._meetings:ForceStart(args[1])
		return runId ~= nil, runId and "Meeting started." or "Unknown meeting id."
	end)

	self:_define("endmeetings", "endmeetings", function()
		self._meetings:ForceEndAll()
		return true, "Meetings ended."
	end)

	self:_define("repairall", "repairall [amount]", function(_, args)
		self._buildings:RepairAll(tonumber(args[1]) or 100, "Admin")
		return true, "Buildings repaired."
	end)

	self:_define("damage", "damage <BuildingType|all> <amount>", function(_, args)
		local amount = tonumber(args[2]) or 25
		if args[1] == "all" then
			self._buildings:DamageAll(amount, "Admin")
		else
			self._buildings:DamageType(args[1] or "", amount, "Admin")
		end
		return true, "Damaged."
	end)

	self:_define("settime", "settime <hour 7-22>", function(_, args)
		local hour = tonumber(args[1])
		if not hour then
			return false, "Usage: settime <hour>"
		end
		self._time:SetHour(hour)
		return true, "Time set."
	end)

	self:_define("timespeed", "timespeed <multiplier>", function(_, args)
		self._time:SetSpeed(tonumber(args[1]) or 1)
		return true, "Time speed set."
	end)

	self:_define("pausetime", "pausetime <on|off>", function(_, args)
		self._time:SetPaused(args[1] ~= "off")
		return true, "Clock " .. (args[1] ~= "off" and "paused." or "running.")
	end)

	self:_define("weather", "weather <Clear|Rain|Storm|Fog|Snow> [hours]", function(_, args)
		local ok = self._weather:SetWeather(args[1] or "", tonumber(args[2]) or 2)
		return ok, ok and "Weather set." or "Unknown weather."
	end)

	self:_define("event", "event <EventId>", function(_, args)
		local run = args[1] and self._events:StartEvent(args[1])
		return run ~= nil, run and "Event started." or "Unknown or already active."
	end)

	self:_define("endevent", "endevent <EventId> [success]", function(_, args)
		for _, entry in ipairs(self._events:GetActive()) do
			if entry.Id == args[1] then
				self._events:EndEvent(entry.RunId, args[2] == "success")
				return true, "Event ended."
			end
		end
		return false, "Not active."
	end)

	self:_define("morale", "morale <delta>", function(_, args)
		self._kingdom:AddMorale(tonumber(args[1]) or 0, "Admin")
		return true, "Morale: " .. math.floor(self._kingdom:GetMorale())
	end)

	self:_define("need", "need <Need> <0-1> [minutes]", function(_, args)
		self._kingdom:OverrideNeed(args[1] or "", tonumber(args[2]) or 0, tonumber(args[3]) or 60)
		self._kingdom:Evaluate()
		return true, "Need overridden."
	end)

	self:_define("hierarchy", "hierarchy", function()
		local lines = {}
		local counts = self._rank:CountByRank()
		for _, rank in ipairs(RankConfig.Sorted()) do
			local queue = self._rank:GetQueue(rank.Id)
			local names = {}
			for index = 1, math.min(#queue, 5) do
				table.insert(names, string.format("%s(%d)", queue[index].n or queue[index].id, queue[index].x))
			end
			table.insert(lines, string.format("%s %d/%s: %s", rank.DisplayName, counts[rank.Id] or 0, rank.MaxSlots and tostring(rank.MaxSlots) or "inf", table.concat(names, ", ")))
		end
		return true, table.concat(lines, "\n")
	end)

	self:_define("resetkingdom", "resetkingdom  (resources, buildings, economy, hierarchy rebuild)", function()
		self._resources:ResetToStarting("AdminResetKingdom")
		self._buildings:RepairAll(100, "AdminResetKingdom")
		self._economy:ResetEconomy(false)
		self._testing:ClearBots()
		return true, "Kingdom reset."
	end)

	self:_define("sim", "sim <xp|promotion|demotion|foodshortage|meeting|restart|leave|vacancy|cascade|crisis|death> [arg]", function(admin, args)
		return self._testing:Simulate(admin, args[1] or "", args[2])
	end)

	self:_define("bot", "bot add <rank> <xp> [count] | bot kill <id> | bot killtop | bot populate | bot clear", function(_, args)
		local sub = args[1]
		if sub == "add" then
			local rank = rankByName(args[2])
			if not rank then
				return false, "Unknown rank."
			end
			return self._testing:AddBots(rank.Id, tonumber(args[3]) or 0, tonumber(args[4]) or 1)
		elseif sub == "kill" then
			return self._testing:KillMember(args[2] or "")
		elseif sub == "killtop" then
			return self._testing:KillTop()
		elseif sub == "populate" then
			return self._testing:PopulateKingdom()
		elseif sub == "clear" then
			return self._testing:ClearBots()
		end
		return false, "Usage: bot add|kill|killtop|populate|clear"
	end)
end

return AdminService
