--[[
	PermissionConfig
	Every permission key the game checks. Code never compares rank names; it
	asks PermissionService:Has(player, "<key>"). Ranks grant keys in
	RankConfig. Unknown keys in RankConfig are reported at startup.
]]

local PermissionConfig = {}

PermissionConfig.Keys = {
	-- Jobs
	["Job.Basic"] = "Farming, logging, fishing, hunting, water, cleaning, hauling",
	["Job.Advanced"] = "Mining, cooking, milling, smelting, smithing, construction, trade",
	["Job.Security"] = "Guard posts, patrols and defence",
	["Job.Administration"] = "Ledger and record keeping at administration desks",

	-- Storage
	["Storage.Withdraw"] = "Withdraw materials from kingdom storage for work",
	["Storage.Audit"] = "Audit warehouses (slows spoilage)",

	-- Management
	["Manage.ViewDepartment"] = "See department dashboards for managed departments",
	["Manage.ViewWorkers"] = "See subordinate attendance, activity, location and performance",
	["Manage.AssignWorkers"] = "Assign subordinates to departments and work orders",
	["Manage.WorkOrders"] = "Create and cancel work orders",
	["Manage.Inspect"] = "Inspect departments in person",
	["Manage.Discipline"] = "Warn, fine and suspend subordinates",
	["Manage.RequestReplacement"] = "Broadcast staffing requests",
	["Manage.SetPriorities"] = "Set department priorities",
	["Manage.Departments"] = "Appoint department managers",

	-- Rank authority
	["Rank.Demote"] = "Demote a managed subordinate by one rank (logged, rate limited)",
	["Rank.Appoint"] = "Appoint a subordinate into an empty slot (MANUAL mode / vacancies)",
	["Rank.Remove"] = "Remove a managed subordinate to the bottom rank without a vote",

	-- Meetings
	["Meeting.Call"] = "Call an unscheduled meeting for subordinate ranks",

	-- Government
	["Government.Vote"] = "Vote on Senate proposals",
	["Government.Propose"] = "Create Senate proposals",
	["Government.SetTaxes"] = "Propose or set tax rates",
	["Government.Treasury"] = "Spend treasury funds on imports and projects",
	["Government.Veto"] = "Veto passed proposals (King)",
	["Projects.Approve"] = "Approve construction projects",

	-- Information
	["Kingdom.ViewStatus"] = "See kingdom needs",
	["Kingdom.ViewFull"] = "Full kingdom dashboard",
}

-- Dashboard detail levels used by ManagementService:GetDashboard.
PermissionConfig.DashboardLevels = {
	Personal = 1,
	Job = 2,
	Security = 3,
	Department = 4,
	Military = 5,
	Regional = 6,
	Kingdom = 7,
	Full = 8,
}

return PermissionConfig
