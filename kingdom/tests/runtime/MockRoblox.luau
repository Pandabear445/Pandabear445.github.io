--[[
	MockRoblox
	A small, deterministic stand-in for the Roblox engine so the real
	server code can boot and run scenarios in the plain Luau CLI.
	It implements just enough: datatypes, a generic Instance tree with
	attributes/tags/events, the services the game uses, a virtual-time task
	scheduler, and in-memory DataStores. It is a test tool, not a game.
]]

--!nolint
local Mock = {}

---------------------------------------------------------------------------
-- Output capture
---------------------------------------------------------------------------
Mock.Warnings = {}
Mock.Errors = {}
local realPrint = print
Mock.Verbose = false
print = function(...)
	if Mock.Verbose then
		realPrint(...)
	end
end
warn = function(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[i] = tostring((select(i, ...)))
	end
	local text = table.concat(parts, " ")
	table.insert(Mock.Warnings, text)
	if Mock.Verbose or string.find(text, "ERROR") or string.find(text, "failed") or string.find(text, "error") then
		realPrint("  [warn] " .. text)
	end
end
Mock.print = realPrint

---------------------------------------------------------------------------
-- Virtual time + scheduler
---------------------------------------------------------------------------
local Sched = { now = 1000, seq = 0, queue = {} }
Mock.Sched = Sched

local function reportError(err, thread)
	local trace = debug.traceback(thread, tostring(err))
	table.insert(Mock.Errors, trace)
	realPrint("  [ERROR] " .. trace)
end

local function resume(thread, ...)
	if coroutine.status(thread) ~= "suspended" then
		return
	end
	local ok, err = coroutine.resume(thread, ...)
	if not ok then
		reportError(err, thread)
	end
end

local function schedule(at, thread, ...)
	Sched.seq += 1
	table.insert(Sched.queue, { at = at, seq = Sched.seq, thread = thread, args = table.pack(...) })
end

task = {}
function task.spawn(fnOrThread, ...)
	local thread = type(fnOrThread) == "thread" and fnOrThread or coroutine.create(fnOrThread)
	resume(thread, ...)
	return thread
end
function task.defer(fnOrThread, ...)
	local thread = type(fnOrThread) == "thread" and fnOrThread or coroutine.create(fnOrThread)
	schedule(Sched.now, thread, ...)
	return thread
end
function task.delay(seconds, fnOrThread, ...)
	local thread = type(fnOrThread) == "thread" and fnOrThread or coroutine.create(fnOrThread)
	schedule(Sched.now + (seconds or 0), thread, ...)
	return thread
end
function task.wait(seconds)
	local thread = coroutine.running()
	local start = Sched.now
	schedule(Sched.now + math.max(seconds or 0.03, 0.001), thread)
	coroutine.yield()
	return Sched.now - start
end
function task.cancel() end

-- Runs everything due within `seconds` of virtual time.
function Sched.run(seconds)
	local target = Sched.now + seconds
	while true do
		local bestIndex, best = nil, nil
		for index, entry in ipairs(Sched.queue) do
			if entry.at <= target and (not best or entry.at < best.at or (entry.at == best.at and entry.seq < best.seq)) then
				bestIndex, best = index, entry
			end
		end
		if not best then
			break
		end
		table.remove(Sched.queue, bestIndex)
		Sched.now = math.max(Sched.now, best.at)
		resume(best.thread, table.unpack(best.args, 1, best.args.n))
	end
	Sched.now = target
end

local realOs = os
local baseTime = 1700000000
os = setmetatable({
	clock = function()
		return Sched.now
	end,
	time = function(t)
		if t then
			return baseTime
		end
		return math.floor(baseTime + Sched.now)
	end,
}, { __index = realOs })

---------------------------------------------------------------------------
-- Datatypes
---------------------------------------------------------------------------
local typeofOriginal = typeof
typeof = function(value)
	if type(value) == "table" then
		local mt = getmetatable(value)
		if mt and mt.__type then
			return mt.__type
		end
	end
	return typeofOriginal(value)
end

Vector3 = {}
local V3 = { __type = "Vector3" }
local function v3(x, y, z)
	return setmetatable({ X = x or 0, Y = y or 0, Z = z or 0 }, V3)
end
V3.__index = function(self, key)
	if key == "Magnitude" then
		return math.sqrt(self.X ^ 2 + self.Y ^ 2 + self.Z ^ 2)
	elseif key == "Unit" then
		local m = math.sqrt(self.X ^ 2 + self.Y ^ 2 + self.Z ^ 2)
		if m == 0 then
			return v3(0, 0, 0)
		end
		return v3(self.X / m, self.Y / m, self.Z / m)
	elseif key == "x" then
		return self.X
	elseif key == "y" then
		return self.Y
	elseif key == "z" then
		return self.Z
	end
	return Vector3[key]
end
V3.__add = function(a, b)
	return v3(a.X + b.X, a.Y + b.Y, a.Z + b.Z)
end
V3.__sub = function(a, b)
	return v3(a.X - b.X, a.Y - b.Y, a.Z - b.Z)
end
V3.__mul = function(a, b)
	if type(a) == "number" then
		return v3(b.X * a, b.Y * a, b.Z * a)
	elseif type(b) == "number" then
		return v3(a.X * b, a.Y * b, a.Z * b)
	end
	return v3(a.X * b.X, a.Y * b.Y, a.Z * b.Z)
end
V3.__div = function(a, b)
	if type(b) == "number" then
		return v3(a.X / b, a.Y / b, a.Z / b)
	end
	return v3(a.X / b.X, a.Y / b.Y, a.Z / b.Z)
end
V3.__unm = function(a)
	return v3(-a.X, -a.Y, -a.Z)
end
V3.__eq = function(a, b)
	return a.X == b.X and a.Y == b.Y and a.Z == b.Z
end
V3.__tostring = function(a)
	return string.format("%g, %g, %g", a.X, a.Y, a.Z)
end
Vector3.new = v3
Vector3.zero = v3(0, 0, 0)
Vector3.one = v3(1, 1, 1)
Vector3.yAxis = v3(0, 1, 0)
function Vector3.Dot(a, b)
	return a.X * b.X + a.Y * b.Y + a.Z * b.Z
end
function Vector3.Lerp(a, b, t)
	return a + (b - a) * t
end

CFrame = {}
local CF = { __type = "CFrame" }
local function cf(p)
	return setmetatable({ Position = p }, CF)
end
CF.__index = function(self, key)
	if key == "p" then
		return self.Position
	elseif key == "LookVector" then
		return v3(0, 0, -1)
	elseif key == "RightVector" then
		return v3(1, 0, 0)
	elseif key == "UpVector" then
		return v3(0, 1, 0)
	elseif key == "X" then
		return self.Position.X
	elseif key == "Y" then
		return self.Position.Y
	elseif key == "Z" then
		return self.Position.Z
	end
	return CFrame[key]
end
CF.__mul = function(a, b)
	if getmetatable(b) == CF then
		return cf(a.Position + b.Position)
	end
	return a.Position + b
end
CF.__add = function(a, b)
	return cf(a.Position + b)
end
function CFrame.new(x, y, z)
	if type(x) == "table" then
		return cf(x)
	end
	return cf(v3(x or 0, y or 0, z or 0))
end
function CFrame.Angles()
	return cf(v3())
end
CFrame.identity = cf(v3())
function CFrame.PointToObjectSpace(self, point)
	return point - self.Position
end
function CFrame.PointToWorldSpace(self, point)
	return point + self.Position
end
function CFrame.Inverse(self)
	return cf(-self.Position)
end
function CFrame.lookAt(at)
	return cf(at)
end

Color3 = {}
local C3 = { __type = "Color3" }
C3.__index = Color3
C3.__eq = function(a, b)
	return a.R == b.R and a.G == b.G and a.B == b.B
end
function Color3.new(r, g, b)
	return setmetatable({ R = r or 0, G = g or 0, B = b or 0 }, C3)
end
function Color3.fromRGB(r, g, b)
	return Color3.new((r or 0) / 255, (g or 0) / 255, (b or 0) / 255)
end
function Color3.Lerp(a, b, t)
	return Color3.new(a.R + (b.R - a.R) * t, a.G + (b.G - a.G) * t, a.B + (b.B - a.B) * t)
end
function Color3.ToHex(self)
	return string.format("%02x%02x%02x", math.floor(self.R * 255 + 0.5), math.floor(self.G * 255 + 0.5), math.floor(self.B * 255 + 0.5))
end

local function opaque(typeName)
	local mt = { __type = typeName }
	mt.__index = mt
	return function(...)
		return setmetatable({ args = table.pack(...) }, mt)
	end
end
UDim = { new = opaque("UDim") }
UDim2 = { new = opaque("UDim2"), fromScale = opaque("UDim2"), fromOffset = opaque("UDim2") }
local V2 = { __type = "Vector2" }
V2.__index = V2
Vector2 = {
	new = function(x, y)
		return setmetatable({ X = x or 0, Y = y or 0 }, V2)
	end,
}
Vector2.zero = Vector2.new(0, 0)
NumberRange = { new = opaque("NumberRange") }
NumberSequence = { new = opaque("NumberSequence") }
ColorSequence = { new = opaque("ColorSequence") }
TweenInfo = { new = opaque("TweenInfo") }

local enumCache = {}
Enum = setmetatable({}, {
	__index = function(_, enumType)
		if not enumCache[enumType] then
			local items = {}
			enumCache[enumType] = setmetatable({}, {
				__index = function(_, itemName)
					if not items[itemName] then
						items[itemName] = setmetatable({ Name = itemName, EnumType = enumType }, {
							__type = "EnumItem",
							__tostring = function()
								return "Enum." .. enumType .. "." .. itemName
							end,
						})
					end
					return items[itemName]
				end,
			})
		end
		return enumCache[enumType]
	end,
})

---------------------------------------------------------------------------
-- Signals
---------------------------------------------------------------------------
local Signal = {}
Signal.__index = Signal
Signal.__type = "RBXScriptSignal"
function Signal.new()
	return setmetatable({ handlers = {} }, Signal)
end
function Signal:Connect(fn)
	local conn = { Connected = true, fn = fn }
	function conn.Disconnect()
		conn.Connected = false
	end
	table.insert(self.handlers, conn)
	return conn
end
function Signal:Once(fn)
	local conn
	conn = self:Connect(function(...)
		conn.Disconnect()
		fn(...)
	end)
	return conn
end
function Signal:Fire(...)
	for _, conn in ipairs(table.clone(self.handlers)) do
		if conn.Connected then
			task.spawn(conn.fn, ...)
		end
	end
end
function Signal:Wait()
	local thread = coroutine.running()
	self:Once(function(...)
		task.spawn(thread, ...)
	end)
	return coroutine.yield()
end
Mock.Signal = Signal

---------------------------------------------------------------------------
-- Instances
---------------------------------------------------------------------------
local EVENTS = {
	Changed = true, ChildAdded = true, ChildRemoved = true, DescendantAdded = true, Destroying = true,
	AncestryChanged = true, AttributeChanged = true, Triggered = true, PromptButtonHoldBegan = true,
	PromptButtonHoldEnded = true, Died = true, HealthChanged = true, StateChanged = true,
	CharacterAdded = true, CharacterRemoving = true, Activated = true, MouseEnter = true, MouseLeave = true,
	OnServerEvent = true, OnClientEvent = true, PlayerAdded = true, PlayerRemoving = true, Chatted = true,
	PlayerMembershipChanged = true, PromptGamePassPurchaseFinished = true, Heartbeat = true,
	RenderStepped = true, Stepped = true, FocusLost = true, Ended = true, InputBegan = true, Touched = true,
}

local IS_A = {
	BasePart = { Part = true, MeshPart = true, WedgePart = true, SpawnLocation = true, BasePart = true },
	GuiObject = { Frame = true, TextLabel = true, TextButton = true, TextBox = true, ImageLabel = true, ScrollingFrame = true },
	LuaSourceContainer = { Script = true, LocalScript = true, ModuleScript = true },
}

local DEFAULTS = {
	Name = "Instance", Transparency = 0, Anchored = false, CanCollide = true, Enabled = true,
	HoldDuration = 0, MaxActivationDistance = 10, Health = 100, MaxHealth = 100, WalkSpeed = 16,
	Gravity = 196.2, Size = Vector3.one, ActionText = "", ObjectText = "",
}

local Methods = {}
local InstanceMT = { __type = "Instance" }
local allTagged = {} -- tag -> set
local tagAdded = {}
local tagRemoved = {}
Mock.Instances = {}

local function signalFor(self, key)
	local signals = rawget(self, "__signals")
	if not signals[key] then
		signals[key] = Signal.new()
	end
	return signals[key]
end

InstanceMT.__index = function(self, key)
	local method = Methods[key]
	if method then
		return method
	end
	local props = rawget(self, "__props")
	local value = props[key]
	if value ~= nil then
		return value
	end
	if key == "Position" and props.CFrame then
		return props.CFrame.Position
	end
	if key == "CFrame" and props.Position then
		return CFrame.new(props.Position)
	end
	if EVENTS[key] then
		return signalFor(self, key)
	end
	for _, child in ipairs(rawget(self, "__children")) do
		if rawget(child, "__props").Name == key then
			return child
		end
	end
	local special = rawget(self, "__special")
	if special and special[key] ~= nil then
		return special[key]
	end
	if key == "Position" then
		return Vector3.zero
	elseif key == "CFrame" then
		return CFrame.new()
	end
	return DEFAULTS[key]
end

local function isInDataModel(inst)
	local current = inst
	while current do
		if current == Mock.game then
			return true
		end
		current = rawget(current, "__props").Parent
	end
	return false
end

local function fireTagAddedRecursive(inst)
	if not isInDataModel(inst) then
		return
	end
	for tag in pairs(rawget(inst, "__tags")) do
		if tagAdded[tag] then
			tagAdded[tag]:Fire(inst)
		end
	end
	for _, child in ipairs(rawget(inst, "__children")) do
		fireTagAddedRecursive(child)
	end
end

InstanceMT.__newindex = function(self, key, value)
	local props = rawget(self, "__props")
	if key == "Parent" then
		local old = props.Parent
		if old == value then
			return
		end
		if old then
			local siblings = rawget(old, "__children")
			local index = table.find(siblings, self)
			if index then
				table.remove(siblings, index)
			end
		end
		props.Parent = value
		if value then
			table.insert(rawget(value, "__children"), self)
			local signals = rawget(value, "__signals")
			if signals.ChildAdded then
				signals.ChildAdded:Fire(self)
			end
			fireTagAddedRecursive(self)
		end
		return
	end
	if key == "Position" then
		props.CFrame = CFrame.new(value)
		props.Position = nil
	elseif key == "CFrame" then
		props.CFrame = value
		props.Position = nil
	elseif key == "Health" then
		local old = props.Health or 100
		local max = props.MaxHealth or 100
		value = math.clamp(value, 0, max)
		props.Health = value
		if value ~= old then
			signalFor(self, "HealthChanged"):Fire(value)
		end
		if old > 0 and value <= 0 then
			signalFor(self, "Died"):Fire()
		end
		return
	else
		props[key] = value
	end
	local propertySignals = rawget(self, "__propSignals")
	if propertySignals[key] then
		propertySignals[key]:Fire()
	end
end

InstanceMT.__tostring = function(self)
	return rawget(self, "__props").Name
end

Instance = {}
function Instance.new(className, parent)
	local inst = setmetatable({
		__props = { ClassName = className, Name = className },
		__children = {},
		__attrs = {},
		__tags = {},
		__signals = {},
		__attrSignals = {},
		__propSignals = {},
	}, InstanceMT)
	if parent then
		inst.Parent = parent
	end
	table.insert(Mock.Instances, inst)
	return inst
end

function Methods.IsA(self, className)
	local own = self.ClassName
	if own == className or className == "Instance" then
		return true
	end
	local family = IS_A[className]
	return family ~= nil and family[own] == true
end
function Methods.GetChildren(self)
	return table.clone(rawget(self, "__children"))
end
function Methods.GetDescendants(self)
	local result = {}
	local function walk(inst)
		for _, child in ipairs(rawget(inst, "__children")) do
			table.insert(result, child)
			walk(child)
		end
	end
	walk(self)
	return result
end
function Methods.FindFirstChild(self, name, recursive)
	for _, child in ipairs(rawget(self, "__children")) do
		if child.Name == name then
			return child
		end
	end
	if recursive then
		for _, desc in ipairs(Methods.GetDescendants(self)) do
			if desc.Name == name then
				return desc
			end
		end
	end
	return nil
end
function Methods.WaitForChild(self, name)
	return Methods.FindFirstChild(self, name)
end
function Methods.FindFirstChildOfClass(self, className)
	for _, child in ipairs(rawget(self, "__children")) do
		if child.ClassName == className then
			return child
		end
	end
	return nil
end
function Methods.FindFirstChildWhichIsA(self, className, recursive)
	local list = recursive and Methods.GetDescendants(self) or rawget(self, "__children")
	for _, child in ipairs(list) do
		if child:IsA(className) then
			return child
		end
	end
	return nil
end
function Methods.FindFirstAncestor(self, name)
	local current = self.Parent
	while current do
		if current.Name == name then
			return current
		end
		current = current.Parent
	end
	return nil
end
function Methods.IsDescendantOf(self, ancestor)
	local current = rawget(self, "__props").Parent
	while current do
		if current == ancestor then
			return true
		end
		current = rawget(current, "__props").Parent
	end
	return false
end
function Methods.GetFullName(self)
	local parts = {}
	local current = self
	while current and current ~= Mock.game do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end
	return table.concat(parts, ".")
end
function Methods.GetAttribute(self, name)
	return rawget(self, "__attrs")[name]
end
function Methods.GetAttributes(self)
	return table.clone(rawget(self, "__attrs"))
end
function Methods.SetAttribute(self, name, value)
	local attrs = rawget(self, "__attrs")
	if attrs[name] == value then
		return
	end
	attrs[name] = value
	local signal = rawget(self, "__attrSignals")[name]
	if signal then
		signal:Fire()
	end
	local changed = rawget(self, "__signals").AttributeChanged
	if changed then
		changed:Fire(name)
	end
end
function Methods.GetAttributeChangedSignal(self, name)
	local signals = rawget(self, "__attrSignals")
	if not signals[name] then
		signals[name] = Signal.new()
	end
	return signals[name]
end
function Methods.GetPropertyChangedSignal(self, name)
	local signals = rawget(self, "__propSignals")
	if not signals[name] then
		signals[name] = Signal.new()
	end
	return signals[name]
end
function Methods.AddTag(self, tag)
	if rawget(self, "__tags")[tag] then
		return
	end
	rawget(self, "__tags")[tag] = true
	allTagged[tag] = allTagged[tag] or {}
	allTagged[tag][self] = true
	if tagAdded[tag] and isInDataModel(self) then
		tagAdded[tag]:Fire(self)
	end
end
function Methods.HasTag(self, tag)
	return rawget(self, "__tags")[tag] == true
end
function Methods.RemoveTag(self, tag)
	rawget(self, "__tags")[tag] = nil
	if allTagged[tag] then
		allTagged[tag][self] = nil
	end
end
function Methods.Destroy(self)
	local signals = rawget(self, "__signals")
	if signals.Destroying then
		signals.Destroying:Fire()
	end
	for _, child in ipairs(table.clone(rawget(self, "__children"))) do
		child:Destroy()
	end
	for tag in pairs(rawget(self, "__tags")) do
		if allTagged[tag] then
			allTagged[tag][self] = nil
		end
	end
	self.Parent = nil
end
function Methods.ClearAllChildren(self)
	for _, child in ipairs(table.clone(rawget(self, "__children"))) do
		child:Destroy()
	end
end
function Methods.Clone(self)
	local copy = Instance.new(self.ClassName)
	for key, value in pairs(rawget(self, "__props")) do
		if key ~= "Parent" then
			rawget(copy, "__props")[key] = value
		end
	end
	for key, value in pairs(rawget(self, "__attrs")) do
		rawget(copy, "__attrs")[key] = value
	end
	for tag in pairs(rawget(self, "__tags")) do
		copy:AddTag(tag)
	end
	for _, child in ipairs(rawget(self, "__children")) do
		child:Clone().Parent = copy
	end
	return copy
end
function Methods.GetBoundingBox(self)
	local parts = {}
	for _, desc in ipairs(Methods.GetDescendants(self)) do
		if desc:IsA("BasePart") then
			table.insert(parts, desc)
		end
	end
	if #parts == 0 then
		return CFrame.new(), Vector3.one
	end
	local minV = v3(math.huge, math.huge, math.huge)
	local maxV = v3(-math.huge, -math.huge, -math.huge)
	for _, part in ipairs(parts) do
		local p, s = part.Position, part.Size
		minV = v3(math.min(minV.X, p.X - s.X / 2), math.min(minV.Y, p.Y - s.Y / 2), math.min(minV.Z, p.Z - s.Z / 2))
		maxV = v3(math.max(maxV.X, p.X + s.X / 2), math.max(maxV.Y, p.Y + s.Y / 2), math.max(maxV.Z, p.Z + s.Z / 2))
	end
	return CFrame.new((minV + maxV) / 2), maxV - minV
end
function Methods.PivotTo(self, target)
	local root = Methods.FindFirstChild(self, "HumanoidRootPart")
	if root then
		local offset = target.Position - root.Position
		for _, desc in ipairs(Methods.GetDescendants(self)) do
			if desc:IsA("BasePart") then
				desc.Position = desc.Position + offset
			end
		end
	elseif self:IsA("BasePart") then
		self.CFrame = target
	end
end
function Methods.GetPivot(self)
	local root = Methods.FindFirstChild(self, "HumanoidRootPart")
	return root and root.CFrame or CFrame.new()
end
-- Humanoid
function Methods.TakeDamage(self, amount)
	self.Health = (self.Health or 100) - amount
end
function Methods.MoveTo() end
function Methods.GetState(self)
	return rawget(self, "__props").State or Enum.HumanoidStateType.Running
end
function Methods.ChangeState() end
-- Remotes
function Methods.FireClient(self, player, ...)
	table.insert(Mock.ClientEvents, { remote = self.Name, player = player, args = table.pack(...) })
	if Mock.LocalPlayer and player == Mock.LocalPlayer then
		self.OnClientEvent:Fire(...)
	end
end
function Methods.FireAllClients(self, ...)
	table.insert(Mock.ClientEvents, { remote = self.Name, player = "*", args = table.pack(...) })
	if Mock.LocalPlayer then
		self.OnClientEvent:Fire(...)
	end
end
-- Client -> server, in-process (the client harness plays Mock.LocalPlayer).
function Methods.InvokeServer(self, ...)
	local handler = rawget(self, "__props").OnServerInvoke
	if handler then
		return handler(Mock.LocalPlayer, ...)
	end
	return nil
end
function Methods.FireServer(self, ...)
	self.OnServerEvent:Fire(Mock.LocalPlayer, ...)
end
function Methods.GetFocusedTextBox()
	return nil
end
-- Player
function Methods.Kick(self, message)
	table.insert(Mock.Kicks, { player = self, message = message })
	Mock.removePlayer(self)
end
function Methods.LoadCharacter(self)
	Mock.spawnCharacter(self)
end
function Methods.GetRankInGroupAsync()
	return 0
end
function Methods.GetRankInGroup()
	return 0
end
-- Sounds / tweens / particles
function Methods.Play() end
function Methods.Stop() end
function Methods.Emit() end
Mock.ClientEvents = {}
Mock.Kicks = {}

---------------------------------------------------------------------------
-- DataModel & services
---------------------------------------------------------------------------
local game = Instance.new("DataModel")
Mock.game = game
rawget(game, "__props").Name = "Game"
rawget(game, "__props").JobId = "mock-job"
rawget(game, "__props").PlaceId = 1
rawget(game, "__props").CreatorType = Enum.CreatorType.User
rawget(game, "__props").CreatorId = 1

local services = {}
local function service(name, className)
	local inst = Instance.new(className or name)
	inst.Name = name
	inst.Parent = game
	services[name] = inst
	return inst
end

for _, name in ipairs({ "ReplicatedStorage", "ServerScriptService", "ServerStorage", "Lighting", "StarterPlayer", "SoundService", "GuiService" }) do
	service(name)
end

local workspaceInst = service("Workspace")
rawget(workspaceInst, "__props").Gravity = 196.2
workspace = workspaceInst
local camera = Instance.new("Camera")
camera.Name = "Camera"
rawget(camera, "__props").ViewportSize = Vector2.new(1280, 720)
camera.Parent = workspaceInst
rawget(workspaceInst, "__props").CurrentCamera = camera
function Methods.GetServerTimeNow()
	return Sched.now
end

-- Players
local Players = service("Players")
local playerList = {}
rawget(Players, "__props").CharacterAutoLoads = true
function Methods.GetPlayers(self)
	if self == Players then
		return table.clone(playerList)
	end
	return {}
end
function Methods.GetPlayerByUserId(self, userId)
	for _, player in ipairs(playerList) do
		if player.UserId == userId then
			return player
		end
	end
	return nil
end

function Mock.addPlayer(userId, name)
	local player = Instance.new("Player")
	rawget(player, "__props").Name = name
	rawget(player, "__props").DisplayName = name
	rawget(player, "__props").UserId = userId
	rawget(player, "__props").MembershipType = Enum.MembershipType.None
	Instance.new("Backpack", player).Name = "Backpack"
	Instance.new("PlayerGui", player).Name = "PlayerGui"
	table.insert(playerList, player)
	player.Parent = Players
	Players.PlayerAdded:Fire(player)
	return player
end

function Mock.setLocalPlayer(player)
	Mock.LocalPlayer = player
	rawget(Players, "__props").LocalPlayer = player
end

function Mock.removePlayer(player)
	local index = table.find(playerList, player)
	if not index then
		return
	end
	Players.PlayerRemoving:Fire(player)
	-- Roblox removes the player after PlayerRemoving handlers start.
	task.defer(function()
		local i = table.find(playerList, player)
		if i then
			table.remove(playerList, i)
		end
		if player.Character then
			player.Character:Destroy()
		end
		player.Parent = nil
	end)
end

function Mock.spawnCharacter(player)
	if player.Character then
		player.Character:Destroy()
	end
	local character = Instance.new("Model")
	character.Name = player.Name
	local root = Instance.new("Part", character)
	root.Name = "HumanoidRootPart"
	root.Position = Vector3.new(0, 5, 0)
	root.Size = Vector3.new(2, 2, 1)
	local head = Instance.new("Part", character)
	head.Name = "Head"
	head.Position = Vector3.new(0, 7, 0)
	local humanoid = Instance.new("Humanoid", character)
	humanoid.Name = "Humanoid"
	rawget(humanoid, "__props").Health = 100
	rawget(humanoid, "__props").MaxHealth = 100
	character.Parent = workspace
	rawget(player, "__props").Character = character
	player.CharacterAdded:Fire(character)
	return character
end

function Mock.moveTo(player, position)
	local character = player.Character
	if character then
		character:PivotTo(CFrame.new(position))
	end
end

-- CollectionService
local CollectionService = service("CollectionService")
function Methods.GetTagged(self, tag)
	local result = {}
	for inst in pairs(allTagged[tag] or {}) do
		if isInDataModel(inst) then
			table.insert(result, inst)
		end
	end
	return result
end
function Methods.GetInstanceAddedSignal(self, tag)
	tagAdded[tag] = tagAdded[tag] or Signal.new()
	return tagAdded[tag]
end
function Methods.GetInstanceRemovedSignal(self, tag)
	tagRemoved[tag] = tagRemoved[tag] or Signal.new()
	return tagRemoved[tag]
end

-- RunService
local RunService = service("RunService")
function Methods.IsStudio()
	return true
end
function Methods.IsServer()
	return true
end
function Methods.IsClient()
	return false
end

-- Stores (DataStore / Ordered / MemoryStore)
local Store = {}
Store.__index = Store
function Store.new(name)
	return setmetatable({ name = name, data = {}, writes = 0 }, Store)
end
local function deepCopy(value)
	if type(value) ~= "table" then
		return value
	end
	local mt = getmetatable(value)
	if mt then
		return value -- datatypes are immutable
	end
	local copy = {}
	for k, v in pairs(value) do
		copy[k] = deepCopy(v)
	end
	return copy
end
function Store:GetAsync(key)
	return deepCopy(self.data[key])
end
function Store:SetAsync(key, value)
	self.writes += 1
	self.data[key] = deepCopy(value)
end
function Store:UpdateAsync(key, transform)
	local result = transform(deepCopy(self.data[key]))
	if result ~= nil then
		self.writes += 1
		self.data[key] = deepCopy(result)
	end
	return deepCopy(result)
end
function Store:RemoveAsync(key)
	local old = self.data[key]
	self.data[key] = nil
	return old
end
function Store:IncrementAsync(key, delta)
	self.data[key] = (self.data[key] or 0) + delta
	return self.data[key]
end
local stores = {}
Mock.Stores = stores
local DataStoreService = service("DataStoreService")
function Methods.GetDataStore(self, name)
	stores[name] = stores[name] or Store.new(name)
	return stores[name]
end
function Methods.GetOrderedDataStore(self, name)
	stores["ordered:" .. name] = stores["ordered:" .. name] or Store.new(name)
	return stores["ordered:" .. name]
end
function Methods.GetRequestBudgetForRequestType()
	return 100
end
local MemoryStoreService = service("MemoryStoreService")
function Methods.GetHashMap(self, name)
	stores["memory:" .. name] = stores["memory:" .. name] or Store.new(name)
	return stores["memory:" .. name]
end
local MessagingService = service("MessagingService")
function Methods.SubscribeAsync() end
function Methods.PublishAsync() end

-- HttpService
local HttpService = service("HttpService")
local guidCounter = 0
function Methods.GenerateGUID()
	guidCounter += 1
	return string.format("guid-%06d", guidCounter)
end
local function encode(value, depth)
	depth = depth or 0
	local kind = typeof(value)
	if kind == "nil" then
		return "null"
	elseif kind == "boolean" or kind == "number" then
		return tostring(value)
	elseif kind == "string" then
		return '"' .. value:gsub('[%c"\\]', function(c)
			return string.format("\\u%04x", string.byte(c))
		end) .. '"'
	elseif kind == "table" then
		if depth > 20 then
			return "null"
		end
		local parts = {}
		if #value > 0 then
			for _, item in ipairs(value) do
				table.insert(parts, encode(item, depth + 1))
			end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		for k, v in pairs(value) do
			table.insert(parts, encode(tostring(k)) .. ":" .. encode(v, depth + 1))
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	return '"' .. tostring(value) .. '"'
end
function Methods.JSONEncode(self, value)
	return encode(value)
end
local function decode(text)
	local pos = 1
	local function skip()
		pos = string.find(text, "[^%s]", pos) or (#text + 1)
	end
	local parseValue
	local function parseString()
		pos += 1
		local parts = {}
		while true do
			local c = string.sub(text, pos, pos)
			if c == '"' then
				pos += 1
				break
			elseif c == "\\" then
				local nextChar = string.sub(text, pos + 1, pos + 1)
				if nextChar == "u" then
					table.insert(parts, utf8.char(tonumber(string.sub(text, pos + 2, pos + 5), 16)))
					pos += 6
				else
					local map = { n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" }
					table.insert(parts, map[nextChar] or nextChar)
					pos += 2
				end
			else
				table.insert(parts, c)
				pos += 1
			end
		end
		return table.concat(parts)
	end
	function parseValue()
		skip()
		local c = string.sub(text, pos, pos)
		if c == "{" then
			pos += 1
			local result = {}
			skip()
			if string.sub(text, pos, pos) == "}" then
				pos += 1
				return result
			end
			while true do
				skip()
				local key = parseString()
				skip()
				pos += 1 -- :
				result[key] = parseValue()
				skip()
				local sep = string.sub(text, pos, pos)
				pos += 1
				if sep == "}" then
					return result
				end
			end
		elseif c == "[" then
			pos += 1
			local result = {}
			skip()
			if string.sub(text, pos, pos) == "]" then
				pos += 1
				return result
			end
			while true do
				table.insert(result, parseValue())
				skip()
				local sep = string.sub(text, pos, pos)
				pos += 1
				if sep == "]" then
					return result
				end
			end
		elseif c == '"' then
			return parseString()
		elseif string.sub(text, pos, pos + 3) == "true" then
			pos += 4
			return true
		elseif string.sub(text, pos, pos + 4) == "false" then
			pos += 5
			return false
		elseif string.sub(text, pos, pos + 3) == "null" then
			pos += 4
			return nil
		end
		local numberText = string.match(text, "^-?[%d%.eE+-]+", pos)
		pos += #numberText
		return tonumber(numberText)
	end
	return parseValue()
end
function Methods.JSONDecode(self, text)
	return decode(text)
end

-- Marketplace / badges / chat / tweens
local MarketplaceService = service("MarketplaceService")
function Methods.UserOwnsGamePassAsync()
	return false
end
function Methods.PromptGamePassPurchase() end
function Methods.PromptProductPurchase() end
service("BadgeService")
function Methods.AwardBadge()
	return true
end
service("TextChatService")
local TweenService = service("TweenService")
function Methods.Create()
	return { Play = function() end, Cancel = function() end, Completed = Signal.new() }
end
service("UserInputService")

function Methods.GetService(self, name)
	if name == "Workspace" then
		return workspaceInst
	end
	local svc = services[name]
	if not svc then
		error("Mock has no service " .. name)
	end
	return svc
end
function Methods.BindToClose(self, fn)
	Mock.CloseHandlers = Mock.CloseHandlers or {}
	table.insert(Mock.CloseHandlers, fn)
end

-- globals
-- (the bundle assigns the global `game`)
Mock.Players = Players

---------------------------------------------------------------------------
-- Prompt helper: simulates a player holding a ProximityPrompt.
---------------------------------------------------------------------------
function Mock.firePrompt(prompt, player, heldSeconds)
	prompt.PromptButtonHoldBegan:Fire(player)
	Sched.run(heldSeconds or prompt.HoldDuration or 0)
	prompt.PromptButtonHoldEnded:Fire(player)
	prompt.Triggered:Fire(player)
	Sched.run(0.05)
end

function Mock.findPrompt(instance, actionText)
	for _, desc in ipairs(instance:GetDescendants()) do
		if desc.ClassName == "ProximityPrompt" and (not actionText or string.find(desc.ActionText, actionText, 1, true)) then
			return desc
		end
	end
	return nil
end

-- Remote helpers (server side).
function Mock.remote(name)
	return game:GetService("ReplicatedStorage").Kingdom.Remotes:FindFirstChild(name)
end
function Mock.action(player, domain, verb, payload)
	local remote = Mock.remote("Action")
	local result
	task.spawn(function()
		result = table.pack(remote.OnServerInvoke(player, domain, verb, payload or {}, "act-" .. tostring(Sched.now) .. math.random(1, 1e9)))
	end)
	Sched.run(0.1)
	if not result then
		return nil, "yielded"
	end
	return table.unpack(result, 1, result.n)
end
function Mock.query(player, name, args)
	local remote = Mock.remote("Query")
	local result
	task.spawn(function()
		result = remote.OnServerInvoke(player, name, args or {})
	end)
	Sched.run(0.1)
	return result
end

function Mock.notificationsFor(player, sinceIndex)
	local list = {}
	for index = sinceIndex or 1, #Mock.ClientEvents do
		local event = Mock.ClientEvents[index]
		if event.remote == "Notify" and (event.player == player or event.player == "*") then
			table.insert(list, event.args[1])
		end
	end
	return list
end

function Mock.effectsFor(player, kind)
	local list = {}
	for _, event in ipairs(Mock.ClientEvents) do
		if event.remote == "Effect" and event.player == player and (not kind or event.args[1] == kind) then
			table.insert(list, event.args[2])
		end
	end
	return list
end

return Mock
