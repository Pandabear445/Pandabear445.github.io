--[[
	Check
	Defensive validation for anything that arrives from a client.
	Every function returns the validated value or nil.
]]

local Check = {}

function Check.string(value, maxLength: number?, minLength: number?): string?
	if type(value) ~= "string" then
		return nil
	end
	if #value > (maxLength or 200) or #value < (minLength or 0) then
		return nil
	end
	if not utf8.len(value) then
		return nil
	end
	return value
end

function Check.number(value, min: number?, max: number?): number?
	if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
		return nil
	end
	if (min and value < min) or (max and value > max) then
		return nil
	end
	return value
end

function Check.integer(value, min: number?, max: number?): number?
	local n = Check.number(value, min, max)
	if n and math.floor(n) == n then
		return n
	end
	return nil
end

function Check.boolean(value): boolean?
	if type(value) == "boolean" then
		return value
	end
	return nil
end

-- value must be a key of the given table
function Check.key(value, lookup): string?
	if type(value) == "string" and lookup[value] ~= nil then
		return value
	end
	return nil
end

function Check.oneOf(value, options: { any })
	if table.find(options, value) then
		return value
	end
	return nil
end

function Check.userId(value): number?
	return Check.integer(value, -1e12, 1e13)
end

-- Deep sanitize a client payload: plain data only, bounded size.
local MAX_KEYS = 64
local MAX_DEPTH = 4

local function sanitize(value, depth: number)
	local kind = type(value)
	if kind == "nil" or kind == "boolean" then
		return value, true
	elseif kind == "number" then
		if value ~= value or value == math.huge or value == -math.huge then
			return nil, false
		end
		return value, true
	elseif kind == "string" then
		if #value > 1000 or not utf8.len(value) then
			return nil, false
		end
		return value, true
	elseif kind == "table" then
		if depth > MAX_DEPTH or getmetatable(value) ~= nil then
			return nil, false
		end
		local result, count = {}, 0
		for k, v in pairs(value) do
			count += 1
			if count > MAX_KEYS then
				return nil, false
			end
			local kt = type(k)
			if kt ~= "string" and kt ~= "number" then
				return nil, false
			end
			local clean, ok = sanitize(v, depth + 1)
			if not ok then
				return nil, false
			end
			result[k] = clean
		end
		return result, true
	end
	-- Instances, functions, userdata etc. are never accepted.
	return nil, false
end

function Check.payload(value): (any, boolean)
	return sanitize(value, 1)
end

return Check
