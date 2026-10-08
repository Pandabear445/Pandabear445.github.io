--[[
	Logger
	Tagged debug logging. Output format: [Tag] message

	Debug output is controlled by GameConfig.Debug:
	  Debug.Enabled       -> master switch for Debug() messages
	  Debug.Tags[tag]     -> per-tag override (true/false)
	Warnings and errors are always printed.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)

local Logger = {}
Logger.__index = Logger

local function debugEnabledFor(tag: string): boolean
	local debugConfig = GameConfig.Debug
	if not debugConfig then
		return false
	end
	local override = debugConfig.Tags and debugConfig.Tags[tag]
	if override ~= nil then
		return override
	end
	return debugConfig.Enabled == true
end

local function format(tag, message, ...)
	local ok, text = pcall(string.format, message, ...)
	if not ok then
		text = tostring(message)
	end
	return string.format("[%s] %s", tag, text)
end

function Logger.new(tag: string)
	return setmetatable({ Tag = tag }, Logger)
end

function Logger:Debug(message: string, ...)
	if debugEnabledFor(self.Tag) then
		print(format(self.Tag, message, ...))
	end
end

function Logger:Info(message: string, ...)
	print(format(self.Tag, message, ...))
end

function Logger:Warn(message: string, ...)
	warn(format(self.Tag, message, ...))
end

function Logger:Error(message: string, ...)
	-- Never throw from the logger; errors are reported, not raised.
	warn(format(self.Tag, "ERROR: " .. tostring(message), ...))
end

return Logger
