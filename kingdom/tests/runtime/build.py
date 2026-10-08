#!/usr/bin/env python3
"""Bundles the Rojo project + MockRoblox + a scenario into one Luau file.

Usage: python3 tests/runtime/build.py <sourcemap.json> <out.luau> <scenario files...>
The sourcemap comes from: rojo sourcemap default.project.json -o sourcemap.json
"""
import json, os, re, sys

root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sourcemap_path, out_path = sys.argv[1:3]
scenario_paths = sys.argv[3:]
tree = json.load(open(sourcemap_path))

out = []
mock = open(os.path.join(os.path.dirname(__file__), "MockRoblox.luau")).read()
out.append("local Mock = (function()\n" + mock + "\nend)()\ngame = Mock.game\n")
out.append("local __N = {}\nlocal __loaders = {}\nlocal __cache = {}\n")
out.append("""
local __realRequire = require
require = function(target)
	if type(target) == "table" and __loaders[target] then
		if __cache[target] == nil then
			local ok, result = xpcall(__loaders[target], debug.traceback, target)
			if not ok then
				error("require failed for " .. target:GetFullName() .. ": " .. tostring(result), 0)
			end
			__cache[target] = result == nil and true or result
		end
		return __cache[target]
	end
	return __realRequire(target)
end
""")

counter = [0]
def emit(node, parent_expr, skip_client):
    counter[0] += 1
    idx = counter[0]
    cls = node["className"]
    name = node["name"]
    if parent_expr is None:
        expr = "game"
    elif cls in ("ReplicatedStorage", "ServerScriptService", "StarterPlayer", "ServerStorage", "Workspace"):
        expr = f'game:GetService("{cls}")'
    else:
        out.append(f'__N[{idx}] = Instance.new("{cls}"); __N[{idx}].Name = {json.dumps(name)}; __N[{idx}].Parent = {parent_expr}\n')
        expr = f"__N[{idx}]"
    files = [f for f in node.get("filePaths", []) if f.endswith((".lua", ".luau"))]
    if files and cls in ("ModuleScript", "Script", "LocalScript"):
        src = open(os.path.join(root_dir, files[0])).read()
        src = re.sub(r"^export type", "type", src, flags=re.M)
        if cls == "Script":
            out.append(f"__N[{idx}].Disabled = false\n")
        out.append(f"__loaders[{expr}] = function(script)\n{src}\nend\n")
        if cls == "Script":
            out.append(f"Mock.ServerScripts = Mock.ServerScripts or {{}}; table.insert(Mock.ServerScripts, {expr})\n")
        if cls == "LocalScript":
            out.append(f"Mock.ClientScripts = Mock.ClientScripts or {{}}; table.insert(Mock.ClientScripts, {expr})\n")
    for child in node.get("children", []):
        if skip_client and child["className"] == "StarterPlayer":
            continue
        emit(child, expr, skip_client)

emit(tree, None, skip_client=os.environ.get("INCLUDE_CLIENT") != "1")
out.append("""
function Mock.boot()
	for _, scriptInstance in ipairs(Mock.ServerScripts or {}) do
		task.spawn(function()
			local ok, err = xpcall(__loaders[scriptInstance], debug.traceback, scriptInstance)
			if not ok then
				table.insert(Mock.Errors, err)
				Mock.print("  [ERROR] " .. tostring(err))
			end
		end)
	end
end
function Mock.bootClient()
	for _, scriptInstance in ipairs(Mock.ClientScripts or {}) do
		task.spawn(function()
			local ok, err = xpcall(__loaders[scriptInstance], debug.traceback, scriptInstance)
			if not ok then
				table.insert(Mock.Errors, err)
				Mock.print("  [ERROR] " .. tostring(err))
			end
		end)
	end
end
function Mock.require(instance)
	return require(instance)
end
""")
for scenario_path in scenario_paths:
    out.append(open(scenario_path).read() + "\n")
open(out_path, "w").write("".join(out))
print("bundle written:", out_path, sum(len(x) for x in out), "bytes")
