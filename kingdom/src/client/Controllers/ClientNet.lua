--[[
	ClientNet
	Thin wrappers around the server's remotes. The client only ever REQUESTS
	actions; every result (XP, coins, items, ranks) is decided by the server.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Remotes = require(ReplicatedStorage.Kingdom.Shared.Remotes)

local ClientNet = {}

-- Returns ok, message, data. Never throws.
function ClientNet.Action(domain: string, verb: string, payload: { [string]: any }?): (boolean, string?, any)
	local remote = Remotes.get("Action") :: RemoteFunction
	local ok, success, message, data = pcall(remote.InvokeServer, remote, domain, verb, payload or {}, Remotes.newActionId())
	if not ok then
		return false, "The messenger got lost. Try again.", nil
	end
	return success == true, message, data
end

function ClientNet.Query(name: string, args: { [string]: any }?): any
	local remote = Remotes.get("Query") :: RemoteFunction
	local ok, result = pcall(remote.InvokeServer, remote, name, args or {})
	if not ok then
		return nil
	end
	return result
end

function ClientNet.Input(kind: string, payload: { [string]: any }?)
	local remote = Remotes.get("Input") :: RemoteEvent
	remote:FireServer(kind, payload or {})
end

function ClientNet.OnEvent(name: string, handler: (...any) -> ())
	local remote = Remotes.get(name) :: RemoteEvent
	return remote.OnClientEvent:Connect(handler)
end

return ClientNet
