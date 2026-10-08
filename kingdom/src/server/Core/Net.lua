--[[
	Net (server)
	Owns every RemoteEvent / RemoteFunction. All client traffic passes through
	here, which guarantees for every endpoint:
	  * payload sanitizing (plain data only, bounded size and depth)
	  * per-player, per-endpoint rate limiting (token buckets)
	  * a global per-player request budget
	  * duplicate action protection (each Action carries a unique actionId;
	    replays return the original result instead of running twice)
	  * error isolation (a handler error returns a failure, never crashes)
	  * a readiness gate (no progression actions until data is loaded)

	Handlers receive (player, payload) and return (ok, message, data).
	Clients request; the server validates and decides.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Logger = require(ReplicatedStorage.Kingdom.Shared.Logger)
local Remotes = require(ReplicatedStorage.Kingdom.Shared.Remotes)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Check = require(script.Parent.Check)
local RateLimiter = require(script.Parent.RateLimiter)

local log = Logger.new("Net")

local Net = {}

Net.RateLimited = Signal.new("NetRateLimited") -- (player, endpoint)
Net.BadRequest = Signal.new("NetBadRequest") -- (player, endpoint, reason)

local remotes: { [string]: Instance } = {}
local actions = {}
local queries = {}
local inputs = {}
local limiters = {}
local globalLimiter = RateLimiter.new(25, 60) -- all requests per player
local recentActions: { [Player]: { ids: { [string]: any }, order: { string } } } = {}
local gate: ((Player) -> (boolean, string?))? = nil

local DEDUPE_MEMORY = 200

local function getLimiter(endpoint: string, rate: number, burst: number)
	local limiter = limiters[endpoint]
	if not limiter then
		limiter = RateLimiter.new(rate, burst)
		limiters[endpoint] = limiter
	end
	return limiter
end

local function rememberAction(player: Player, actionId: string, result)
	local memory = recentActions[player]
	if not memory then
		memory = { ids = {}, order = {} }
		recentActions[player] = memory
	end
	memory.ids[actionId] = result
	table.insert(memory.order, actionId)
	if #memory.order > DEDUPE_MEMORY then
		local old = table.remove(memory.order, 1)
		memory.ids[old] = nil
	end
end

local function admit(player: Player, endpoint: string, spec): (boolean, string?)
	if not globalLimiter:Check(player) then
		Net.RateLimited:Fire(player, "*")
		return false, "Slow down."
	end
	local limiter = getLimiter(endpoint, spec.rate, spec.burst)
	if not limiter:Check(player) then
		Net.RateLimited:Fire(player, endpoint)
		return false, "Slow down."
	end
	if not spec.allowUnloaded and gate then
		local ok, reason = gate(player)
		if not ok then
			return false, reason or "Your data is still loading."
		end
	end
	return true
end

local function runHandler(endpoint: string, handler, player: Player, payload)
	local ok, a, b, c = pcall(handler, player, payload)
	if not ok then
		log:Error("%s handler error for %s: %s", endpoint, player.Name, tostring(a))
		return false, "Something went wrong. Please try again.", nil
	end
	return a, b, c
end

function Net.Init()
	local root = ReplicatedStorage:WaitForChild("Kingdom")
	local folder = root:FindFirstChild(Remotes.FolderName)
	if folder then
		folder:Destroy() -- never trust pre-existing remotes
	end
	folder = Instance.new("Folder")
	folder.Name = Remotes.FolderName

	for _, name in ipairs(Remotes.Functions) do
		local remote = Instance.new("RemoteFunction")
		remote.Name = name
		remote.Parent = folder
		remotes[name] = remote
	end
	for _, name in ipairs(Remotes.Events) do
		local remote = Instance.new("RemoteEvent")
		remote.Name = name
		remote.Parent = folder
		remotes[name] = remote
	end
	folder.Parent = root

	local actionRemote = remotes.Action :: RemoteFunction
	actionRemote.OnServerInvoke = function(player, domain, verb, payload, actionId)
		if type(domain) ~= "string" or type(verb) ~= "string" then
			Net.BadRequest:Fire(player, "Action", "bad route")
			return false, "Invalid request."
		end
		local endpoint = domain .. "." .. verb
		local spec = actions[endpoint]
		if not spec then
			Net.BadRequest:Fire(player, endpoint, "unknown action")
			return false, "Unknown action."
		end
		local clean, valid = Check.payload(payload)
		if not valid then
			Net.BadRequest:Fire(player, endpoint, "malformed payload")
			return false, "Invalid request."
		end
		if spec.dedupe ~= false then
			if type(actionId) ~= "string" or #actionId < 4 or #actionId > 64 then
				Net.BadRequest:Fire(player, endpoint, "missing action id")
				return false, "Invalid request."
			end
			local memory = recentActions[player]
			if memory and memory.ids[actionId] ~= nil then
				return false, "Already processed."
			end
		end
		local admitted, reason = admit(player, endpoint, spec)
		if not admitted then
			return false, reason
		end
		if spec.dedupe ~= false then
			rememberAction(player, actionId, true)
		end
		return runHandler(endpoint, spec.handler, player, clean or {})
	end

	local queryRemote = remotes.Query :: RemoteFunction
	queryRemote.OnServerInvoke = function(player, name, args)
		if type(name) ~= "string" then
			return nil
		end
		local spec = queries[name]
		if not spec then
			Net.BadRequest:Fire(player, "Query." .. tostring(name), "unknown query")
			return nil
		end
		local clean, valid = Check.payload(args)
		if not valid then
			Net.BadRequest:Fire(player, "Query." .. name, "malformed args")
			return nil
		end
		local admitted = admit(player, "Query." .. name, spec)
		if not admitted then
			return nil
		end
		local ok, result = pcall(spec.handler, player, clean or {})
		if not ok then
			log:Error("query %s failed: %s", name, tostring(result))
			return nil
		end
		return result
	end

	local inputRemote = remotes.Input :: RemoteEvent
	inputRemote.OnServerEvent:Connect(function(player, kind, payload)
		if type(kind) ~= "string" then
			return
		end
		local spec = inputs[kind]
		if not spec then
			Net.BadRequest:Fire(player, "Input." .. tostring(kind), "unknown input")
			return
		end
		local clean, valid = Check.payload(payload)
		if not valid then
			Net.BadRequest:Fire(player, "Input." .. kind, "malformed payload")
			return
		end
		if not admit(player, "Input." .. kind, spec) then
			return
		end
		runHandler("Input." .. kind, spec.handler, player, clean or {})
	end)

	Players.PlayerRemoving:Connect(function(player)
		recentActions[player] = nil
		globalLimiter:Reset(player)
		for _, limiter in pairs(limiters) do
			limiter:Reset(player)
		end
	end)
end

export type EndpointOptions = {
	rate: number?, -- requests per second
	burst: number?,
	allowUnloaded: boolean?, -- allowed before player data is loaded
	dedupe: boolean?, -- Actions only (default true)
}

local function spec(handler, options)
	options = options or {}
	return {
		handler = handler,
		rate = options.rate or 2,
		burst = options.burst or 4,
		allowUnloaded = options.allowUnloaded,
		dedupe = options.dedupe,
	}
end

function Net.Action(domain: string, verb: string, options: EndpointOptions?, handler)
	local endpoint = domain .. "." .. verb
	assert(not actions[endpoint], "duplicate action " .. endpoint)
	actions[endpoint] = spec(handler, options)
end

function Net.Query(name: string, options: EndpointOptions?, handler)
	assert(not queries[name], "duplicate query " .. name)
	queries[name] = spec(handler, options)
end

function Net.Input(kind: string, options: EndpointOptions?, handler)
	assert(not inputs[kind], "duplicate input " .. kind)
	inputs[kind] = spec(handler, options)
end

function Net.SetGate(fn: (Player) -> (boolean, string?))
	gate = fn
end

function Net.Fire(remoteName: string, player: Player, ...)
	local remote = remotes[remoteName]
	if remote and remote:IsA("RemoteEvent") and player.Parent == Players then
		remote:FireClient(player, ...)
	end
end

function Net.FireAll(remoteName: string, ...)
	local remote = remotes[remoteName]
	if remote and remote:IsA("RemoteEvent") then
		remote:FireAllClients(...)
	end
end

return Net
