--[[
	AdminConfig (SERVER ONLY - never replicated to clients)
	Administrator access is completely separate from kingdom ranks.
]]

local AdminConfig = {}

-- Roblox user ids with full admin access.
AdminConfig.UserIds = {
	-- 12345678,
}

-- Optional: members of a group at or above a role rank are admins.
AdminConfig.Group = {
	Id = 0, -- 0 disables
	MinRole = 250,
}

-- The place owner (or group owner) is always an admin.
AdminConfig.OwnerIsAdmin = true

-- Anyone in Studio play-testing is an admin (never applies to live servers).
AdminConfig.StudioIsAdmin = true

-- Chat command prefix (e.g. "/k givexp me 500"). Admin panel works too.
AdminConfig.ChatPrefix = "/k"

-- Anti-cheat responses. Kicks only on extreme scores; never auto-ban.
AdminConfig.AntiCheat = {
	KickAtScore = 200, -- set to math.huge to never kick
	NotifyAdminsAtScore = 40,
	ScoreDecayPerMinute = 4,
}

return AdminConfig
