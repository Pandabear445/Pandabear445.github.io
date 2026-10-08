--[[
	Offline unit tests for the rank-slot / cascade rules.
	Run from the kingdom/ folder:   luau tests/HierarchyModel.spec.luau
]]

local HierarchyModel = require("../src/shared/Shared/HierarchyModel")

local passed, failed = 0, 0

local function test(name: string, fn: () -> ())
	local ok, err = pcall(fn)
	if ok then
		passed += 1
		print("  PASS  " .. name)
	else
		failed += 1
		print("  FAIL  " .. name .. "\n        " .. tostring(err))
	end
end

local function eq(actual, expected, label: string?)
	if actual ~= expected then
		error(string.format("%s: expected %s, got %s", label or "value", tostring(expected), tostring(actual)), 2)
	end
end

local RANKS = {
	{ Id = "Peasant", Order = 1, MaxSlots = nil },
	{ Id = "Worker", Order = 2, MaxSlots = 50 },
	{ Id = "Guard", Order = 3, MaxSlots = 25 },
	{ Id = "Knight", Order = 4, MaxSlots = 10 },
	{ Id = "Lord", Order = 5, MaxSlots = 5 },
	{ Id = "Duke", Order = 6, MaxSlots = 2 },
	{ Id = "King", Order = 7, MaxSlots = 1 },
}

local function model(settings)
	return HierarchyModel.new(RANKS, settings or { Mode = "CASCADE" })
end

local function place(m, state, id, rank, xp, t)
	m:Join(state, id, { xp = xp }, t or 0)
	state.m[tostring(id)].r = rank
	state.m[tostring(id)].t = t or 0
end

local function rankOf(state, id)
	return state.m[tostring(id)].r
end

local function countPromotions(events)
	local n = 0
	for _, e in ipairs(events) do
		if e.k == "Promoted" then
			n += 1
		end
	end
	return n
end

print("HierarchyModel")

test("bottom rank must be unlimited", function()
	local ok = pcall(HierarchyModel.new, {
		{ Id = "A", Order = 1, MaxSlots = 5 },
		{ Id = "B", Order = 2, MaxSlots = 1 },
	}, { Mode = "CASCADE" })
	eq(ok, false, "constructor should reject limited bottom rank")
end)

test("only the highest-XP member directly below is promoted", function()
	local m = model()
	local s = HierarchyModel.newState()
	-- Fill 10 knights, then 4 guards with known XP.
	for i = 1, 10 do
		place(m, s, 100 + i, "Knight", 1000)
	end
	place(m, s, 1, "Guard", 50000)
	place(m, s, 2, "Guard", 47000)
	place(m, s, 3, "Guard", 42000)
	place(m, s, 4, "Guard", 39000)
	-- Upper ranks full of other people so nothing else moves.
	for i = 1, 5 do
		place(m, s, 200 + i, "Lord", 1)
	end
	place(m, s, 301, "Duke", 1)
	place(m, s, 302, "Duke", 1)
	place(m, s, 400, "King", 1)

	m:Rebalance(s, 10)
	eq(rankOf(s, 1), "Guard", "no vacancy yet")

	local events = m:Leave(s, 105, 20)
	for _, e in ipairs(m:Rebalance(s, 20)) do
		table.insert(events, e)
	end
	eq(rankOf(s, 1), "Knight", "PlayerA promoted")
	eq(rankOf(s, 2), "Guard", "PlayerB stays Guard")
	local info = m:GetPosition(s, 2, 20)
	eq(info.Position, 1, "PlayerB is now first in line")
end)

test("XP below cannot overtake a rank holder", function()
	local m = model()
	local s = HierarchyModel.newState()
	for i = 1, 5 do
		place(m, s, 10 + i, "Lord", 30000)
	end
	for i = 1, 10 do
		place(m, s, 20 + i, "Knight", 1000)
	end
	place(m, s, 99, "Knight", 80000)
	-- Knight is over capacity by one for this test; make room first.
	s.m["30"] = nil
	place(m, s, 301, "Duke", 1)
	place(m, s, 302, "Duke", 1)
	place(m, s, 400, "King", 1)
	m:SetXP(s, 99, 999999, 5)
	local events = m:Rebalance(s, 5)
	eq(countPromotions(events), 0, "no promotions without a vacancy")
	eq(rankOf(s, 11), "Lord", "Lord keeps rank")
	eq(rankOf(s, 99), "Knight", "high-XP Knight waits")
end)

test("king death cascades one rung per rank", function()
	local m = model()
	local s = HierarchyModel.newState()
	place(m, s, "king", "King", 250000)
	place(m, s, "duke1", "Duke", 100000)
	place(m, s, "duke2", "Duke", 120000)
	for i = 1, 5 do
		place(m, s, "lord" .. i, "Lord", 50000 + i)
	end
	for i = 1, 10 do
		place(m, s, "knight" .. i, "Knight", 20000 + i)
	end
	for i = 1, 25 do
		place(m, s, "guard" .. i, "Guard", 5000 + i)
	end
	for i = 1, 50 do
		place(m, s, "worker" .. i, "Worker", 100 + i)
	end
	place(m, s, "peasant1", "Peasant", 99)

	local events = m:ResetLife(s, "king", 100, "Fall")
	for _, e in ipairs(m:Rebalance(s, 100)) do
		table.insert(events, e)
	end

	eq(rankOf(s, "king"), "Peasant", "dead king is a peasant")
	eq(s.m.king.x, 0, "dead king has 0 XP")
	eq(rankOf(s, "duke2"), "King", "highest-XP duke becomes king")
	eq(rankOf(s, "duke1"), "Duke", "other duke unchanged")
	eq(rankOf(s, "lord5"), "Duke", "highest lord -> duke")
	eq(rankOf(s, "knight10"), "Lord", "highest knight -> lord")
	eq(rankOf(s, "guard25"), "Knight", "highest guard -> knight")
	eq(rankOf(s, "worker50"), "Guard", "highest worker -> guard")
	eq(rankOf(s, "peasant1"), "Worker", "highest peasant -> worker")
	eq(countPromotions(events), 6, "six cascade promotions")

	-- The dead king is last in the peasant queue.
	local queue = m:GetQueue(s, "Peasant")
	eq(queue[#queue].id, "king", "dead king last in queue")
end)

test("rejoining after death keeps the reset (life mismatch voids stored rank)", function()
	local m = model({ Mode = "CASCADE" })
	local s = HierarchyModel.newState()
	m:Join(s, 7, { xp = 5000, life = 1 }, 0)
	s.m["7"].r = "Lord"
	-- Player leaves (global kingdom keeps the slot), dies elsewhere (life 2).
	m:Leave(s, 7, 10, true)
	local events = m:Join(s, 7, { xp = 0, life = 2, keepExisting = true }, 20)
	eq(rankOf(s, 7), "Peasant", "stored Lord rank voided")
	local sawVacancy = false
	for _, e in ipairs(events) do
		if e.k == "Vacancy" and e.rank == "Lord" then
			sawVacancy = true
		end
	end
	eq(sawVacancy, true, "vacancy emitted")
end)

test("new players join at the bottom", function()
	local m = model()
	local s = HierarchyModel.newState()
	place(m, s, "king", "King", 300000)
	m:Join(s, "newbie", { xp = 999999, savedRank = "Duke" }, 1)
	eq(rankOf(s, "newbie"), "Peasant", "joins at bottom despite XP")
end)

test("HYBRID gates: MinXP, population and cooldown stop a lone player rocketing up", function()
	local gated = {
		{ Id = "Peasant", Order = 1 },
		{ Id = "Worker", Order = 2, MaxSlots = 100, MinXP = 100, MinActivePlayers = 1 },
		{ Id = "Guard", Order = 3, MaxSlots = 50, MinXP = 500, MinActivePlayers = 1 },
		{ Id = "Knight", Order = 4, MaxSlots = 10, MinXP = 2000, MinActivePlayers = 6 },
		{ Id = "King", Order = 5, MaxSlots = 1, MinXP = 10000, MinActivePlayers = 10 },
	}
	local m = HierarchyModel.new(gated, { Mode = "HYBRID", PromotionCooldown = 60 })
	local s = HierarchyModel.newState()
	m:Join(s, "solo", { xp = 0 }, 0)
	eq(#m:Rebalance(s, 0), 0, "0 XP: nothing")
	m:SetXP(s, "solo", 50000, 1)
	m:Rebalance(s, 1)
	eq(rankOf(s, "solo"), "Worker", "one rung")
	m:Rebalance(s, 30)
	eq(rankOf(s, "solo"), "Worker", "cooldown holds")
	m:Rebalance(s, 62)
	eq(rankOf(s, "solo"), "Guard", "after cooldown")
	m:Rebalance(s, 500)
	eq(rankOf(s, "solo"), "Guard", "Knight needs 6 active players")
end)

test("CASCADE with no cooldown fills an empty kingdom one rung per pass", function()
	local m = model({ Mode = "CASCADE" })
	local s = HierarchyModel.newState()
	m:Join(s, "a", { xp = 10 }, 0)
	m:Rebalance(s, 0)
	eq(rankOf(s, "a"), "King", "lone player rises when rules permit")
end)

test("MANUAL never auto-promotes", function()
	local m = model({ Mode = "MANUAL" })
	local s = HierarchyModel.newState()
	m:Join(s, "a", { xp = 10 }, 0)
	eq(#m:Rebalance(s, 0), 0, "no events")
	eq(rankOf(s, "a"), "Peasant", "still bottom")
end)

test("HIGHEST_XP may skip rungs", function()
	local m = model({ Mode = "HIGHEST_XP" })
	local s = HierarchyModel.newState()
	place(m, s, "duke", "Duke", 100)
	place(m, s, "richpeasant", "Peasant", 99999)
	m:Rebalance(s, 0)
	eq(rankOf(s, "richpeasant"), "King", "highest XP anywhere below fills King")
end)

test("FIRST_PLAYER orders by seniority", function()
	local m = HierarchyModel.new({
		{ Id = "Peasant", Order = 1 },
		{ Id = "King", Order = 2, MaxSlots = 1 },
	}, { Mode = "FIRST_PLAYER" })
	local s = HierarchyModel.newState()
	m:Join(s, "first", { xp = 1 }, 0)
	m:Join(s, "second", { xp = 999 }, 1)
	m:Rebalance(s, 2)
	eq(rankOf(s, "first"), "King", "first joiner wins")
end)

test("demotion lands in highest open rank below and blocks re-promotion", function()
	local m = model({ Mode = "CASCADE", DemotionBlock = 600 })
	local s = HierarchyModel.newState()
	place(m, s, "king", "King", 1)
	place(m, s, "d1", "Duke", 1)
	place(m, s, "d2", "Duke", 1)
	for i = 1, 5 do
		place(m, s, "lord" .. i, "Lord", i)
	end
	place(m, s, "bigLord", "Lord", 1)
	s.m.lord5 = nil -- keep Lord at 5 with bigLord
	for i = 1, 10 do
		place(m, s, "k" .. i, "Knight", 100 + i)
	end
	place(m, s, "g1", "Guard", 50)
	s.m.bigLord.x = 1e6
	local events, err = m:Demote(s, "bigLord", 10)
	eq(err, nil, "no error")
	-- Knight is full so the demoted Lord lands at Guard (highest with room).
	eq(rankOf(s, "bigLord"), "Guard", "landed in highest open rank")
	for _, e in ipairs(m:Rebalance(s, 10)) do
		table.insert(events, e)
	end
	eq(rankOf(s, "k10"), "Lord", "highest knight filled the lord slot")
	eq(rankOf(s, "bigLord"), "Guard", "blocked from instant re-promotion despite XP")
	eq(rankOf(s, "g1"), "Knight", "guard filled knight slot")
end)

test("validate repairs over-capacity by moving newest arrivals down", function()
	local m = model()
	local s = HierarchyModel.newState()
	place(m, s, "old", "King", 1, 0)
	place(m, s, "new", "King", 1, 50)
	local events = m:Validate(s, 60)
	eq(rankOf(s, "old"), "King", "oldest keeps slot")
	eq(rankOf(s, "new"), "Duke", "newest moved down")
	eq(#events, 1, "one repair")
end)

test("global prune releases inactive slots and forgets idle peasants", function()
	local m = model({ Mode = "CASCADE", OnlineWindow = 120 })
	local s = HierarchyModel.newState()
	place(m, s, "away", "Lord", 10, 0)
	s.m.away.s = 0
	place(m, s, "idle", "Peasant", 0, 0)
	s.m.idle.s = 0
	local events = m:PruneStale(s, 100000, { releaseAfter = 3600, forgetBottomAfter = 600 })
	eq(s.m.idle, nil, "idle peasant dropped")
	eq(s.m.away, nil, "inactive lord released then dropped")
	local vacancy = false
	for _, e in ipairs(events) do
		if e.k == "Vacancy" then
			vacancy = true
		end
	end
	eq(vacancy, true, "vacancy emitted")
end)

test("offline members are skipped when RequireOnline", function()
	local m = model({ Mode = "CASCADE", OnlineWindow = 60 })
	local s = HierarchyModel.newState()
	place(m, s, "offlineDuke", "Duke", 1e6, 0)
	s.m.offlineDuke.o = false
	place(m, s, "onlineDuke", "Duke", 1, 0)
	s.m.onlineDuke.s = 100
	m:Rebalance(s, 100)
	eq(rankOf(s, "onlineDuke"), "King", "online duke promoted")
	eq(rankOf(s, "offlineDuke"), "Duke", "offline duke skipped")
end)

print(string.format("\n%d passed, %d failed", passed, failed))
if failed > 0 then
	error("tests failed")
end
