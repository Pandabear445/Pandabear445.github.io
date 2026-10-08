--[[
	Signal
	Minimal, dependency-free event implementation used by every service.
	Handlers run in their own thread and errors are isolated so one faulty
	listener can never break the emitter or the other listeners.
]]

local Signal = {}
Signal.__index = Signal

export type Connection = {
	Connected: boolean,
	Disconnect: (self: Connection) -> (),
}

function Signal.new(name: string?)
	return setmetatable({
		_name = name or "Signal",
		_handlers = {},
	}, Signal)
end

function Signal:Connect(handler: (...any) -> ())
	local connection = {
		Connected = true,
		_handler = handler,
	}
	local handlers = self._handlers
	function connection.Disconnect(conn)
		if not conn.Connected then
			return
		end
		conn.Connected = false
		local index = table.find(handlers, conn)
		if index then
			table.remove(handlers, index)
		end
	end
	table.insert(handlers, connection)
	return connection
end

function Signal:Once(handler: (...any) -> ())
	local connection
	connection = self:Connect(function(...)
		connection:Disconnect()
		handler(...)
	end)
	return connection
end

local function runHandler(name, handler, ...)
	local ok, err = pcall(handler, ...)
	if not ok then
		warn(string.format("[Signal:%s] listener error: %s", name, tostring(err)))
	end
end

function Signal:Fire(...)
	-- Copy so listeners can disconnect while we iterate.
	local snapshot = table.clone(self._handlers)
	for _, connection in ipairs(snapshot) do
		if connection.Connected then
			task.spawn(runHandler, self._name, connection._handler, ...)
		end
	end
end

-- Fires synchronously in the current thread (still error isolated).
function Signal:FireSync(...)
	local snapshot = table.clone(self._handlers)
	for _, connection in ipairs(snapshot) do
		if connection.Connected then
			runHandler(self._name, connection._handler, ...)
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

function Signal:DisconnectAll()
	for _, connection in ipairs(table.clone(self._handlers)) do
		connection:Disconnect()
	end
end

return Signal
