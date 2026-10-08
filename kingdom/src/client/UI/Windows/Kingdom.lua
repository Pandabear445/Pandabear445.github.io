--[[
	Kingdom status window: needs (FOOD ████████░░ 82%), stage, morale,
	treasury and taxes, the hierarchy, active events, departments, stores
	and damaged buildings.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Format = require(ReplicatedStorage.Kingdom.Shared.Format)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)
local ClientState = require(script.Parent.Parent.Parent.Controllers.ClientState)
local Kit = require(script.Parent.Parent.Kit)

local Kingdom = {
	Title = "The Kingdom",
	Short = "Kingdom",
	Icon = "🏰",
	Key = Enum.KeyCode.K,
	Size = UDim2.fromOffset(640, 540),
	RefreshSeconds = 3,
}

local NEED_ORDER = { "Food", "Water", "Housing", "Security", "Tools", "Weapons", "Medicine", "Fuel", "Materials" }

function Kingdom.Build(window)
	window.Scroll = Kit.Scroll({ Parent = window.Body, Spacing = 6 })
end

local function section(parent: Instance, text: string, order: number)
	Kit.Text({ Text = text, Style = "Heading", TextSize = 19, LayoutOrder = order, Parent = parent })
end

function Kingdom.Refresh(window)
	local scroll = window.Scroll
	Kit.clear(scroll)
	local global = ClientState.Global
	local order = 0
	local function nextOrder()
		order += 1
		return order
	end

	local kingdom = global.Kingdom
	if kingdom then
		section(scroll, string.format("Stage: %s · Stability %s · Morale %d · Productivity %d%%", kingdom.Stage, Format.percent(kingdom.Stability), math.floor(kingdom.Morale), math.floor(kingdom.Productivity * 100)), nextOrder())
		for _, need in ipairs(NEED_ORDER) do
			local entry = kingdom.Needs and kingdom.Needs[need]
			if entry then
				local row = Kit.Row({ Height = 20, LayoutOrder = nextOrder(), Parent = scroll })
				Kit.Text({ Text = string.upper(entry.Name), Size = UDim2.fromOffset(190, 18), TextSize = 13, Parent = row, Font = Kit.Fonts.Heading })
				local bar = Kit.Bar({ Size = UDim2.fromOffset(360, 14), Parent = row })
				bar:Set(entry.Value, Format.bar(entry.Value) .. " " .. Format.percent(entry.Value), Kit.percentColor(entry.Value))
			end
		end
		Kit.Text({ Text = string.format("Population %d · Guards on duty %d", kingdom.Population or 0, kingdom.Guards or 0), TextSize = 13, LayoutOrder = nextOrder(), Parent = scroll })
	end

	local treasury = global.Treasury
	if treasury then
		section(scroll, "Treasury: " .. Format.number(treasury.Balance) .. " coins" .. (treasury.Low and " (LOW)" or ""), nextOrder())
		local taxes = {}
		for name, rate in pairs(treasury.Taxes or {}) do
			table.insert(taxes, string.format("%s %d%%", name, math.floor(rate * 100 + 0.5)))
		end
		table.sort(taxes)
		Kit.Text({
			Text = string.format("Taxes: %s\nLast hour: +%s / -%s", table.concat(taxes, " · "), Format.number(treasury.LastHourIncome or 0), Format.number(treasury.LastHourExpense or 0)),
			TextSize = 13,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.new(1, 0, 0, 0),
			LayoutOrder = nextOrder(),
			Parent = scroll,
		})
	end

	local events = global.Events
	if events and #events > 0 then
		section(scroll, "Kingdom Events", nextOrder())
		for _, event in ipairs(events) do
			Kit.Text({ Text = string.format("%s%s (%dm left)", event.Dangerous and "⚠ " or "", event.Name, event.MinutesLeft), Style = "Heading", TextSize = 15, LayoutOrder = nextOrder(), Parent = scroll })
			for _, objective in ipairs(event.Objectives) do
				local bar = Kit.Bar({ LayoutOrder = nextOrder(), Parent = scroll })
				bar:Set(objective.Target > 0 and objective.Progress / objective.Target or 0, string.format("%s %d/%d", objective.Text, objective.Progress, objective.Target))
			end
		end
	end

	local hierarchy = global.Hierarchy
	if hierarchy then
		section(scroll, "The Hierarchy", nextOrder())
		for index = #hierarchy, 1, -1 do
			local rank = hierarchy[index]
			local holders = rank.Holders and #rank.Holders > 0 and (" - " .. table.concat(rank.Holders, ", ")) or ""
			Kit.Text({
				Text = string.format("%s: %d / %s%s", rank.Name, rank.Count, rank.Max and tostring(rank.Max) or "∞", holders),
				TextSize = 13,
				LayoutOrder = nextOrder(),
				Parent = scroll,
			})
		end
	end

	local departments = global.Departments
	if departments then
		section(scroll, "Departments", nextOrder())
		for _, dept in ipairs(departments) do
			Kit.Text({
				Text = string.format(
					"%s %s - %d/%d active · production %d%% · efficiency %d%%%s",
					dept.Icon or "",
					dept.Name,
					dept.Active,
					dept.Required,
					math.floor(dept.Production * 100),
					math.floor(dept.Efficiency * 100),
					dept.Problems > 0 and string.format(" · %d problem(s)", dept.Problems) or ""
				),
				TextSize = 13,
				LayoutOrder = nextOrder(),
				Parent = scroll,
			})
		end
	end

	local resources = global.Resources
	if resources then
		section(scroll, "Royal Stores", nextOrder())
		local entries = {}
		for resourceId, amount in pairs(resources.Stock or {}) do
			local def = ResourceConfig.Resources[resourceId]
			if def and amount > 0 then
				local flow = resources.LastHour and resources.LastHour[resourceId]
				table.insert(entries, string.format("%s %s %d%s", def.Icon or "", def.DisplayName, amount, flow and string.format(" (+%d/-%d)", flow.P, flow.C) or ""))
			end
		end
		table.sort(entries)
		Kit.Text({ Text = table.concat(entries, "\n"), TextSize = 13, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), LayoutOrder = nextOrder(), Parent = scroll })
	end

	local buildings = global.Buildings
	if buildings and #buildings > 0 then
		section(scroll, "Buildings needing repair", nextOrder())
		local shown = 0
		for _, building in ipairs(buildings) do
			if building.Condition < 75 and shown < 10 then
				shown += 1
				Kit.Text({ Text = string.format("%s (%s) - %d%% %s", building.Name, building.Type, building.Condition, building.Band), TextSize = 13, LayoutOrder = nextOrder(), Parent = scroll })
			end
		end
		if shown == 0 then
			Kit.Text({ Text = "All buildings are in good condition.", TextSize = 13, LayoutOrder = nextOrder(), Parent = scroll })
		end
	end
end

return Kingdom
