--[[
	Medieval Kingdom - server entry point.

	Boots every service in dependency order (Core/ServiceRegistry). A service
	that fails is disabled or degraded on its own; the rest of the kingdom
	keeps running. See docs/ARCHITECTURE.md.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Logger = require(ReplicatedStorage.Kingdom.Shared.Logger)
local Net = require(script.Parent.Core.Net)
local ServiceRegistry = require(script.Parent.Core.ServiceRegistry)

local log = Logger.new("Main")

-- Remotes exist before any service registers endpoints.
Net.Init()

local registry = ServiceRegistry.new()
registry:LoadFolder(script.Parent.Services)

local ok, err = pcall(registry.Boot, registry)
if not ok then
	log:Error("Kingdom failed to boot: %s", tostring(err))
	ReplicatedStorage.Kingdom:SetAttribute("BootFailed", true)
	return
end

ReplicatedStorage.Kingdom:SetAttribute("ServerReady", true)
log:Info("The kingdom is open.")
