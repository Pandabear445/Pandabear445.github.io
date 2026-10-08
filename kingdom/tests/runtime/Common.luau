-- Shared helpers for runtime scenarios (prepended by run.sh).
local Sched = Mock.Sched
local passed, failed = 0, 0
local function check(label, condition, detail)
	if condition then
		passed += 1
		Mock.print("  ok   " .. label)
	else
		failed += 1
		Mock.print("  FAIL " .. label .. (detail and ("  -> " .. tostring(detail)) or ""))
	end
end
local function section(name)
	Mock.print("\n== " .. name)
end
local function part(name, position, size, tags, attrs, parent)
	local p = Instance.new("Part")
	p.Name = name
	p.Position = position
	p.Size = size or Vector3.new(4, 4, 4)
	p.Anchored = true
	for key, value in pairs(attrs or {}) do
		p:SetAttribute(key, value)
	end
	p.Parent = parent or workspace
	for _, tag in ipairs(tags or {}) do
		p:AddTag(tag)
	end
	return p
end
local function model(name, tags, attrs)
	local m = Instance.new("Model")
	m.Name = name
	for key, value in pairs(attrs or {}) do
		m:SetAttribute(key, value)
	end
	m.Parent = workspace
	for _, tag in ipairs(tags or {}) do
		m:AddTag(tag)
	end
	return m
end
local wiggleSign = {}
local function wiggle(p)
	local root = p.Character and p.Character:FindFirstChild("HumanoidRootPart")
	if root then
		wiggleSign[p] = -(wiggleSign[p] or -1)
		root.Position = root.Position + Vector3.new(2 * wiggleSign[p], 0, 0)
	end
end
local function finish(name)
	Mock.print(string.format("\n%s: %d passed, %d failed, %d runtime errors", name, passed, failed, #Mock.Errors))
	if failed > 0 or #Mock.Errors > 0 then
		error(name .. " failed")
	end
end
local function svc(name)
	return Mock.require(game:GetService("ServerScriptService").Kingdom.Services[name])
end
