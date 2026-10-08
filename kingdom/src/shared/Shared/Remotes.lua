--[[
	Remotes
	Names of every network endpoint. The server creates them at startup in
	ReplicatedStorage.Kingdom.Remotes (server/Core/Net.lua).

	Clients only ever REQUEST actions. They never send XP, money, rank,
	inventory or completion results: the server decides all of those.

	  Action (RemoteFunction)  client -> server  (domain, verb, payload, actionId)
	  Query  (RemoteFunction)  client -> server  (name, args) read-only fetches
	  Input  (RemoteEvent)     client -> server  high-frequency input (combat)
	  State  (RemoteEvent)     server -> client  replicated player/kingdom state
	  Notify (RemoteEvent)     server -> client  notifications / announcements
	  Effect (RemoteEvent)     server -> client  visual + interactive effects
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Remotes = {}

Remotes.FolderName = "Remotes"

Remotes.Functions = { "Action", "Query" }
Remotes.Events = { "Input", "State", "Notify", "Effect" }

local cache = {}

-- Client helper: waits for a remote created by the server.
function Remotes.get(name: string): Instance
	if cache[name] then
		return cache[name]
	end
	local root = ReplicatedStorage:WaitForChild("Kingdom")
	local folder = root:WaitForChild(Remotes.FolderName)
	local remote = folder:WaitForChild(name)
	cache[name] = remote
	return remote
end

-- Unique action id for duplicate-reward protection.
local counter = 0
function Remotes.newActionId(): string
	counter += 1
	return string.format("%x-%x-%x", math.floor(os.clock() * 1000) % 0xFFFFFF, counter, math.random(0, 0xFFFF))
end

return Remotes
