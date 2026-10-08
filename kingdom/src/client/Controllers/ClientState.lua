--[[
	ClientState
	Mirror of the state the server replicates (StateService). Read-only from
	the client's point of view: changing it here changes nothing on the
	server.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local ClientNet = require(script.Parent.ClientNet)

local ClientState = {
	Player = {},
	Global = {},
	Changed = Signal.new("ClientStateChanged"), -- (scope, key, value)
}

function ClientState.Init()
	ClientNet.OnEvent("State", function(scope, delta)
		if type(delta) ~= "table" then
			return
		end
		local target = scope == "Global" and ClientState.Global or ClientState.Player
		for key, value in pairs(delta) do
			target[key] = value
			ClientState.Changed:Fire(scope, key, value)
		end
	end)
	task.spawn(function()
		for _ = 1, 10 do
			local snapshot = ClientNet.Query("StateSnapshot")
			if type(snapshot) == "table" then
				for key, value in pairs(snapshot.Global or {}) do
					ClientState.Global[key] = value
					ClientState.Changed:Fire("Global", key, value)
				end
				for key, value in pairs(snapshot.Player or {}) do
					ClientState.Player[key] = value
					ClientState.Changed:Fire("Player", key, value)
				end
				return
			end
			task.wait(2)
		end
	end)
end

function ClientState.Get(scope: string, key: string)
	local target = scope == "Global" and ClientState.Global or ClientState.Player
	return target[key]
end

return ClientState
