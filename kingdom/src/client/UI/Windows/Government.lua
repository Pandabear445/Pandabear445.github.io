--[[
	Senate window: open proposals and votes, making proposals (senators),
	petitions/strikes (citizens), and direct tax decrees (King).
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local GovernmentConfig = require(ReplicatedStorage.Kingdom.Config.GovernmentConfig)
local ClientNet = require(script.Parent.Parent.Parent.Controllers.ClientNet)
local Kit = require(script.Parent.Parent.Kit)
local Notifications = require(script.Parent.Parent.Notifications)

local Government = {
	Title = "The Senate",
	Short = "Senate",
	Icon = "⚖",
	Key = Enum.KeyCode.J,
	Size = UDim2.fromOffset(700, 560),
	RefreshSeconds = 4,
}

local function keys(map): { string }
	local list = {}
	for key in pairs(map) do
		table.insert(list, key)
	end
	table.sort(list)
	return list
end

local function act(domain: string, verb: string, payload, window)
	task.spawn(function()
		local ok, message = ClientNet.Action(domain, verb, payload)
		Notifications.Result(ok, message)
		Government.Refresh(window)
	end)
end

function Government.Build(window)
	local body = window.Body
	Kit.list(body, 6)
	window.Scroll = Kit.Scroll({ Size = UDim2.new(1, 0, 1, -112), LayoutOrder = 1, Parent = body, Spacing = 6 })

	local form = Kit.Panel({ Style = "Stone", Size = UDim2.new(1, 0, 0, 104), LayoutOrder = 2, Parent = body, Padding = 6 })
	window.Form = form
	Kit.list(form, 4)
	local row1 = Kit.Row({ Height = 30, Parent = form })
	local proposalType = Kit.Cycle({ Options = keys(GovernmentConfig.ProposalTypes), Prefix = "Propose: ", Size = UDim2.fromOffset(220, 28), Parent = row1 })
	local target = Kit.Input({ Placeholder = "Target UserId", Size = UDim2.fromOffset(130, 28), Parent = row1 })
	local tax = Kit.Cycle({ Options = { "Income", "Market", "Trade", "Food" }, Prefix = "Tax: ", Size = UDim2.fromOffset(130, 28), Parent = row1 })
	local value = Kit.Input({ Placeholder = "Rate % / amount / id", Size = UDim2.fromOffset(150, 28), Parent = row1 })
	local row2 = Kit.Row({ Height = 30, LayoutOrder = 1, Parent = form })
	Kit.Button({
		Text = "Submit proposal",
		Size = UDim2.fromOffset(160, 28),
		TextSize = 14,
		Parent = row2,
		OnClick = function()
			local kind = proposalType.Get()
			local raw = value.Text
			local params = {}
			if kind == "SetTax" then
				params = { tax = tax.Get(), rate = (tonumber(raw) or 0) / 100 }
			elseif kind == "ImportFood" then
				params = { amount = tonumber(raw) }
			elseif kind == "ApproveProject" then
				params = { station = raw }
			elseif kind == "AcceptPetition" then
				params = { petition = raw }
			end
			act("Government", "Propose", { type = kind, target = tonumber(target.Text), params = params }, window)
		end,
	})
	Kit.Button({
		Text = "Decree tax (King)",
		Size = UDim2.fromOffset(160, 28),
		TextSize = 14,
		Parent = row2,
		OnClick = function()
			act("Government", "SetTax", { tax = tax.Get(), rate = (tonumber(value.Text) or 0) / 100 }, window)
		end,
	})
	local demand = Kit.Cycle({ Options = keys(GovernmentConfig.Petitions.Demands), Prefix = "Petition: ", Size = UDim2.fromOffset(220, 28), Parent = row2 })
	Kit.Button({
		Text = "Start",
		Size = UDim2.fromOffset(70, 28),
		TextSize = 14,
		Parent = row2,
		OnClick = function()
			act("Government", "StartPetition", { demand = demand.Get() }, window)
		end,
	})
	Kit.Text({ Text = "Tip: player UserIds are shown in the Duties window. Petitions are only possible when morale is low.", Style = "Light", TextSize = 12, LayoutOrder = 2, Parent = form })
end

function Government.Refresh(window)
	local data = ClientNet.Query("Government")
	if type(data) ~= "table" then
		return
	end
	local scroll = window.Scroll
	Kit.clear(scroll)
	local order = 0
	local function nextOrder()
		order += 1
		return order
	end
	local senators = {}
	for _, senator in ipairs(data.Senators or {}) do
		table.insert(senators, senator.Name .. " (" .. senator.Rank .. ")")
	end
	Kit.Text({ Text = "Senate present: " .. (#senators > 0 and table.concat(senators, ", ") or "none"), TextSize = 14, LayoutOrder = nextOrder(), Parent = scroll, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) })
	local taxes = {}
	for name, rate in pairs(data.Taxes or {}) do
		table.insert(taxes, string.format("%s %d%%", name, math.floor(rate * 100 + 0.5)))
	end
	table.sort(taxes)
	Kit.Text({ Text = string.format("Morale %d · Taxes: %s", math.floor(data.Morale or 0), table.concat(taxes, " · ")), TextSize = 13, LayoutOrder = nextOrder(), Parent = scroll })

	Kit.Text({ Text = "Proposals", Style = "Heading", LayoutOrder = nextOrder(), Parent = scroll })
	if #(data.Proposals or {}) == 0 then
		Kit.Text({ Text = "The Senate has no business before it.", TextSize = 13, LayoutOrder = nextOrder(), Parent = scroll })
	end
	for _, proposal in ipairs(data.Proposals or {}) do
		local card = Kit.Panel({ Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, LayoutOrder = nextOrder(), Parent = scroll, Padding = 6 })
		Kit.list(card, 3)
		Kit.Text({ Text = proposal.Text, Style = "Heading", TextSize = 15, Parent = card, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) })
		Kit.Text({
			Text = string.format("By %s · %s · yes %d / no %d · needs %d%% · %d min left", proposal.Proposer, proposal.State, proposal.Yes, proposal.No, math.floor(proposal.Required * 100), proposal.MinutesLeft),
			TextSize = 13,
			LayoutOrder = 1,
			Parent = card,
		})
		if proposal.State == "Open" and data.CanVote and proposal.MyVote == nil then
			local row = Kit.Row({ Height = 28, LayoutOrder = 2, Parent = card })
			Kit.Button({ Text = "Vote YES", Size = UDim2.fromOffset(110, 26), TextSize = 13, Parent = row, OnClick = function()
				act("Government", "Vote", { proposal = proposal.Id, yes = true }, window)
			end })
			Kit.Button({ Text = "Vote NO", Danger = true, Size = UDim2.fromOffset(110, 26), TextSize = 13, Parent = row, OnClick = function()
				act("Government", "Vote", { proposal = proposal.Id, yes = false }, window)
			end })
		elseif proposal.MyVote ~= nil then
			Kit.Text({ Text = proposal.MyVote and "You voted YES." or "You voted NO.", TextSize = 13, LayoutOrder = 2, Parent = card })
		end
	end

	Kit.Text({ Text = "Petitions & strikes", Style = "Heading", LayoutOrder = nextOrder(), Parent = scroll })
	if #(data.Petitions or {}) == 0 then
		Kit.Text({ Text = "No petitions.", TextSize = 13, LayoutOrder = nextOrder(), Parent = scroll })
	end
	for _, petition in ipairs(data.Petitions or {}) do
		local row = Kit.Row({ Height = 28, LayoutOrder = nextOrder(), Parent = scroll })
		Kit.Text({ Text = string.format("%s · by %s · %d signers · %s · id %s", petition.Demand, petition.Starter, petition.Signers, petition.State, string.sub(petition.Id, 1, 8)), Size = UDim2.fromOffset(470, 26), TextSize = 13, Parent = row })
		if not petition.Signed and petition.State ~= "Closed" then
			Kit.Button({ Text = "Sign", Size = UDim2.fromOffset(70, 26), TextSize = 13, Parent = row, OnClick = function()
				act("Government", "SignPetition", { petition = petition.Id }, window)
			end })
		end
		if petition.State == "Strike" and data.CanPropose then
			Kit.Button({ Text = "Put to vote", Size = UDim2.fromOffset(100, 26), TextSize = 13, Parent = row, OnClick = function()
				act("Government", "Propose", { type = "AcceptPetition", params = { petition = petition.Id } }, window)
			end })
		end
	end
	window.Form.Visible = true
end

return Government
