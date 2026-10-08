--[[
	RankConfig
	The kingdom hierarchy. Nothing about ranks is hard-coded elsewhere: add,
	remove, rename or resize ranks here.

	Field reference
	  Id                  unique key (used in saves; do not rename lightly)
	  DisplayName         shown in UI and announcements
	  Order               1 = lowest. Must be unique.
	  MaxSlots            maximum holders; nil = unlimited (bottom rank MUST be nil)
	  MinXP               eligibility floor for promotion INTO this rank.
	                      This is NOT a threshold that grants the rank; a slot
	                      must still be open and you must be first in line.
	  MinActivePlayers    HYBRID mode: rank is only filled when at least this
	                      many players are online (small servers keep leadership
	                      vacant). Keep these non-decreasing going upward.
	  PromotionCooldown   optional per-rank override of GameConfig cooldown
	  Permissions         PermissionConfig keys granted
	  ManageDepth         how many ranks below this one it manages (0 = none)
	  Departments         departments this rank may manage ("*" = all)
	  DashboardLevel      PermissionConfig.DashboardLevels name
	  PayMultiplier       multiplies job wages
	  XPMultiplier        multiplies earned XP (keep near 1 to protect the race)
	  Salary              coins per in-game day (paid only if the player worked)
	  Privileges          resource privileges
	    FreeMeals         free mess-hall meals per in-game day
	    MarketDiscount    0..1 discount on kingdom market purchases
	    WithdrawPerHour   max units withdrawn from storage per in-game hour
	  Meeting             meeting privileges
	    CanCall           may call unscheduled meetings
	    MaxSummonOrder    highest rank Order they may summon
	  Council             member of the Senate / Royal Council
	  ChatTag / Color     chat + nameplate role indicator
]]

local RankConfig = {}

local ALL_JOBS = { "Job.Basic", "Job.Advanced", "Job.Security", "Job.Administration" }

local function with(base, extra)
	local result = table.clone(base)
	for _, key in ipairs(extra) do
		table.insert(result, key)
	end
	return result
end

local MANAGER = with(ALL_JOBS, {
	"Storage.Withdraw",
	"Storage.Audit",
	"Kingdom.ViewStatus",
	"Manage.ViewDepartment",
	"Manage.ViewWorkers",
	"Manage.AssignWorkers",
	"Manage.WorkOrders",
	"Manage.Inspect",
	"Manage.Discipline",
	"Manage.RequestReplacement",
})

RankConfig.Ranks = {
	{
		Id = "Peasant",
		DisplayName = "Peasant",
		Order = 1,
		MaxSlots = nil,
		MinXP = 0,
		MinActivePlayers = 0,
		Permissions = { "Job.Basic", "Kingdom.ViewStatus" },
		ManageDepth = 0,
		Departments = {},
		DashboardLevel = "Personal",
		PayMultiplier = 1.0,
		XPMultiplier = 1.0,
		Salary = 0,
		Privileges = { FreeMeals = 1, MarketDiscount = 0, WithdrawPerHour = 0 },
		Meeting = { CanCall = false, MaxSummonOrder = 0 },
		Council = false,
		ChatTag = "PEASANT",
		Color = Color3.fromRGB(150, 130, 100),
	},
	{
		Id = "Worker",
		DisplayName = "Worker",
		Order = 2,
		MaxSlots = 100,
		MinXP = 50,
		MinActivePlayers = 1,
		Permissions = { "Job.Basic", "Job.Advanced", "Kingdom.ViewStatus", "Storage.Withdraw" },
		ManageDepth = 0,
		Departments = {},
		DashboardLevel = "Job",
		PayMultiplier = 1.05,
		XPMultiplier = 1.0,
		Salary = 10,
		Privileges = { FreeMeals = 2, MarketDiscount = 0, WithdrawPerHour = 20 },
		Meeting = { CanCall = false, MaxSummonOrder = 0 },
		Council = false,
		ChatTag = "WORKER",
		Color = Color3.fromRGB(176, 148, 102),
	},
	{
		Id = "Guard",
		DisplayName = "Guard",
		Order = 3,
		MaxSlots = 50,
		MinXP = 300,
		MinActivePlayers = 2,
		Permissions = with(ALL_JOBS, { "Kingdom.ViewStatus", "Storage.Withdraw" }),
		ManageDepth = 0,
		Departments = {},
		DashboardLevel = "Security",
		PayMultiplier = 1.1,
		XPMultiplier = 1.0,
		Salary = 25,
		Privileges = { FreeMeals = 2, MarketDiscount = 0.02, WithdrawPerHour = 30 },
		Meeting = { CanCall = false, MaxSummonOrder = 0 },
		Council = false,
		ChatTag = "GUARD",
		Color = Color3.fromRGB(120, 140, 160),
	},
	{
		Id = "Sergeant",
		DisplayName = "Sergeant",
		Order = 4,
		MaxSlots = 25,
		MinXP = 1000,
		MinActivePlayers = 3,
		Permissions = MANAGER,
		ManageDepth = 3,
		Departments = { "Military", "Agriculture", "Mining", "Forestry", "Fishing", "Food" },
		DashboardLevel = "Department",
		PayMultiplier = 1.15,
		XPMultiplier = 1.0,
		Salary = 40,
		Privileges = { FreeMeals = 3, MarketDiscount = 0.04, WithdrawPerHour = 40 },
		Meeting = { CanCall = true, MaxSummonOrder = 3 },
		Council = false,
		ChatTag = "SERGEANT",
		Color = Color3.fromRGB(110, 150, 120),
	},
	{
		Id = "Knight",
		DisplayName = "Knight",
		Order = 5,
		MaxSlots = 15,
		MinXP = 2500,
		MinActivePlayers = 4,
		Permissions = with(MANAGER, { "Manage.SetPriorities", "Rank.Demote" }),
		ManageDepth = 4,
		Departments = "*",
		DashboardLevel = "Military",
		PayMultiplier = 1.2,
		XPMultiplier = 1.0,
		Salary = 60,
		Privileges = { FreeMeals = 3, MarketDiscount = 0.06, WithdrawPerHour = 60 },
		Meeting = { CanCall = true, MaxSummonOrder = 4 },
		Council = false,
		ChatTag = "KNIGHT",
		Color = Color3.fromRGB(170, 180, 200),
	},
	{
		Id = "KnightCommander",
		DisplayName = "Knight Commander",
		Order = 6,
		MaxSlots = 5,
		MinXP = 5000,
		MinActivePlayers = 5,
		Permissions = with(MANAGER, { "Manage.SetPriorities", "Manage.Departments", "Rank.Demote" }),
		ManageDepth = 5,
		Departments = "*",
		DashboardLevel = "Military",
		PayMultiplier = 1.25,
		XPMultiplier = 1.0,
		Salary = 80,
		Privileges = { FreeMeals = 4, MarketDiscount = 0.08, WithdrawPerHour = 80 },
		Meeting = { CanCall = true, MaxSummonOrder = 5 },
		Council = false,
		ChatTag = "COMMANDER",
		Color = Color3.fromRGB(190, 200, 220),
	},
	{
		Id = "Lord",
		DisplayName = "Lord",
		Order = 7,
		MaxSlots = 10,
		MinXP = 8000,
		MinActivePlayers = 6,
		Permissions = with(MANAGER, {
			"Manage.SetPriorities",
			"Manage.Departments",
			"Rank.Demote",
			"Projects.Approve",
		}),
		ManageDepth = 6,
		Departments = "*",
		DashboardLevel = "Regional",
		PayMultiplier = 1.3,
		XPMultiplier = 1.0,
		Salary = 110,
		Privileges = { FreeMeals = 4, MarketDiscount = 0.1, WithdrawPerHour = 120 },
		Meeting = { CanCall = true, MaxSummonOrder = 6 },
		Council = false,
		ChatTag = "LORD",
		Color = Color3.fromRGB(150, 110, 190),
	},
	{
		Id = "Duke",
		DisplayName = "Duke",
		Order = 8,
		MaxSlots = 5,
		MinXP = 12000,
		MinActivePlayers = 8,
		Permissions = with(MANAGER, {
			"Manage.SetPriorities",
			"Manage.Departments",
			"Rank.Demote",
			"Rank.Appoint",
			"Projects.Approve",
			"Government.Propose",
			"Kingdom.ViewFull",
		}),
		ManageDepth = 7,
		Departments = "*",
		DashboardLevel = "Kingdom",
		PayMultiplier = 1.35,
		XPMultiplier = 1.0,
		Salary = 150,
		Privileges = { FreeMeals = 5, MarketDiscount = 0.12, WithdrawPerHour = 200 },
		Meeting = { CanCall = true, MaxSummonOrder = 7 },
		Council = false,
		ChatTag = "DUKE",
		Color = Color3.fromRGB(200, 120, 90),
	},
	{
		Id = "RoyalCouncil",
		DisplayName = "Royal Council",
		Order = 9,
		MaxSlots = 3,
		MinXP = 18000,
		MinActivePlayers = 10,
		Permissions = with(MANAGER, {
			"Manage.SetPriorities",
			"Manage.Departments",
			"Rank.Demote",
			"Rank.Appoint",
			"Projects.Approve",
			"Government.Vote",
			"Government.Propose",
			"Government.SetTaxes",
			"Government.Treasury",
			"Kingdom.ViewFull",
		}),
		ManageDepth = 8,
		Departments = "*",
		DashboardLevel = "Kingdom",
		PayMultiplier = 1.4,
		XPMultiplier = 1.0,
		Salary = 200,
		Privileges = { FreeMeals = 6, MarketDiscount = 0.15, WithdrawPerHour = 300 },
		Meeting = { CanCall = true, MaxSummonOrder = 8 },
		Council = true,
		ChatTag = "COUNCIL",
		Color = Color3.fromRGB(80, 140, 200),
	},
	{
		Id = "King",
		DisplayName = "King",
		Order = 10,
		MaxSlots = 1,
		MinXP = 25000,
		MinActivePlayers = 12,
		Permissions = with(MANAGER, {
			"Manage.SetPriorities",
			"Manage.Departments",
			"Rank.Demote",
			"Rank.Appoint",
			"Rank.Remove",
			"Projects.Approve",
			"Government.Vote",
			"Government.Propose",
			"Government.SetTaxes",
			"Government.Treasury",
			"Government.Veto",
			"Kingdom.ViewFull",
		}),
		ManageDepth = 9,
		Departments = "*",
		DashboardLevel = "Full",
		PayMultiplier = 1.5,
		XPMultiplier = 1.0,
		Salary = 300,
		Privileges = { FreeMeals = 8, MarketDiscount = 0.2, WithdrawPerHour = 500 },
		Meeting = { CanCall = true, MaxSummonOrder = 9 },
		Council = true,
		ChatTag = "KING",
		Color = Color3.fromRGB(230, 190, 60),
	},
}

-- Lookup helpers (built once).
RankConfig.ById = {}
RankConfig.ByOrder = {}
for _, rank in ipairs(RankConfig.Ranks) do
	RankConfig.ById[rank.Id] = rank
	RankConfig.ByOrder[rank.Order] = rank
end

function RankConfig.Bottom()
	local lowest
	for _, rank in ipairs(RankConfig.Ranks) do
		if not lowest or rank.Order < lowest.Order then
			lowest = rank
		end
	end
	return lowest
end

function RankConfig.Top()
	local highest
	for _, rank in ipairs(RankConfig.Ranks) do
		if not highest or rank.Order > highest.Order then
			highest = rank
		end
	end
	return highest
end

function RankConfig.Get(rankId)
	return type(rankId) == "string" and RankConfig.ById[rankId] or nil
end

-- Sorted bottom -> top.
function RankConfig.Sorted()
	local list = table.clone(RankConfig.Ranks)
	table.sort(list, function(a, b)
		return a.Order < b.Order
	end)
	return list
end

return RankConfig
