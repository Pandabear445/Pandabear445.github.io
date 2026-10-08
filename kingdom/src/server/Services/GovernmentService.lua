--[[
	GovernmentService
	The Senate / Royal Council, votes, direct rank authority and petitions.

	Senate        holders of Council ranks + GovernmentConfig.SenateRanks
	Proposals     Remove, Demote, SetTax, ApproveProject, ImportFood,
	              AcceptPetition, Pardon. Voting lasts DurationGameMinutes; a
	              proposal passes with PassFraction of the online Senate's
	              vote weight and at least MinVoters votes. The King's vote
	              counts double and (if configured) a King "no" vetoes.
	              Impeaching the King needs ImpeachKingFraction.
	Direct        Rank.Demote / Rank.Remove / Rank.Appoint holders may act on
	              players they manage, with reasons, daily limits and logs.
	Petitions     player-driven strikes when morale is low: players choose
	              to sign; enough signatures start a strike (department
	              efficiency falls) and put the demand to the Senate.
	Every removal/demotion triggers the normal promotion cascade.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local EconomyConfig = require(ReplicatedStorage.Kingdom.Config.EconomyConfig)
local GovernmentConfig = require(ReplicatedStorage.Kingdom.Config.GovernmentConfig)
local KingdomConfig = require(ReplicatedStorage.Kingdom.Config.KingdomConfig)
local RankConfig = require(ReplicatedStorage.Kingdom.Config.RankConfig)
local Signal = require(ReplicatedStorage.Kingdom.Shared.Signal)
local Check = require(script.Parent.Parent.Core.Check)
local Net = require(script.Parent.Parent.Core.Net)

local GovernmentService = {
	Name = "GovernmentService",
	Dependencies = {
		"RankService",
		"PromotionService",
		"PermissionService",
		"EconomyService",
		"NotificationService",
		"AuditService",
		"TimeService",
		"KingdomService",
		"DataService",
		"ResourceService",
		"DepartmentService",
		"JobService",
		"BuildingService",
		"XPService",
	},
}

function GovernmentService:Init()
	self._rank = self:Use("RankService")
	self._promotion = self:Use("PromotionService")
	self._permission = self:Use("PermissionService")
	self._economy = self:Use("EconomyService")
	self._notify = self:Use("NotificationService")
	self._audit = self:Use("AuditService")
	self._time = self:Use("TimeService")
	self._kingdom = self:Use("KingdomService")
	self._data = self:Use("DataService")
	self._resources = self:Use("ResourceService")
	self._depts = self:Use("DepartmentService")
	self._jobs = self:Use("JobService")
	self._buildings = self:Use("BuildingService")
	self._xp = self:Use("XPService")

	self.ProposalClosed = Signal.new("ProposalClosed") -- (proposal)
	self._proposals = {}
	self._petitions = {}
	self._proposerCooldown = {}
	self._directActions = {} -- [userId] = { day, demotes, removals }

	self._time.MinuteChanged:Connect(function()
		self:_tick()
	end)
	self:_registerRemotes()
end

-- Senate -----------------------------------------------------------------------------

function GovernmentService:IsSenator(player: Player): boolean
	local rank = self._rank:GetRankDef(player)
	return rank.Council == true or table.find(GovernmentConfig.SenateRanks, rank.Id) ~= nil
end

function GovernmentService:GetSenators(): { Player }
	local list = {}
	for _, player in ipairs(Players:GetPlayers()) do
		if self:IsSenator(player) then
			table.insert(list, player)
		end
	end
	return list
end

local function isKing(rankId: string): boolean
	return rankId == RankConfig.Top().Id
end

function GovernmentService:_weight(player: Player): number
	return isKing(self._rank:GetRankId(player)) and GovernmentConfig.Voting.KingVoteWeight or 1
end

-- Proposals ---------------------------------------------------------------------------

function GovernmentService:Propose(player: Player, proposalType: string, targetId: string?, params)
	local voting = GovernmentConfig.Voting
	local typeDef = GovernmentConfig.ProposalTypes[proposalType]
	if not typeDef then
		return false, "Unknown proposal."
	end
	if not self._permission:Has(player, "Government.Propose") then
		return false, "Only senators may make proposals."
	end
	local nowMinute = self._time:GetAbsoluteMinutes()
	local last = self._proposerCooldown[player.UserId]
	if last and nowMinute - last < voting.ProposerCooldownGameMinutes then
		return false, "You proposed something recently."
	end
	local open = 0
	for _, proposal in pairs(self._proposals) do
		if proposal.state == "Open" then
			open += 1
		end
	end
	if open >= voting.MaxOpenProposals then
		return false, "The Senate's agenda is full."
	end

	local proposal = {
		id = HttpService:GenerateGUID(false),
		type = proposalType,
		proposer = player.UserId,
		proposerName = player.DisplayName,
		target = nil,
		targetName = nil,
		params = {},
		votes = {},
		closesAt = nowMinute + voting.DurationGameMinutes,
		state = "Open" :: string,
		requiredFraction = voting.PassFraction,
	}

	if typeDef.NeedsTarget then
		local member = targetId and self._rank:GetMember(targetId)
		if not member then
			return false, "Choose a valid target."
		end
		if targetId == tostring(player.UserId) then
			return false, "You cannot target yourself."
		end
		local targetRank = RankConfig.Get(member.r)
		if not targetRank then
			return false, "Invalid target."
		end
		if targetRank.Order >= voting.MaxTargetOrderExclusive then
			if not (proposalType == "Remove" and isKing(member.r)) then
				return false, "That office cannot be targeted by this proposal."
			end
			proposal.requiredFraction = voting.ImpeachKingFraction
		end
		proposal.target = targetId
		proposal.targetName = self._rank:GetDisplayName(targetId)
		proposal.targetRank = targetRank.DisplayName
	end

	if proposalType == "SetTax" then
		local tax = Check.key(params.tax, EconomyConfig.Taxes)
		local rate = Check.number(params.rate, 0, 1)
		if not tax or not rate then
			return false, "Choose a tax and rate."
		end
		proposal.params = { tax = tax, rate = rate }
	elseif proposalType == "ImportFood" then
		local amount = Check.integer(params.amount, 10, EconomyConfig.Imports.MaxUnitsPerOrder)
		if not amount then
			return false, "Choose an amount."
		end
		proposal.params = { amount = amount, cost = self:_importCost(amount) }
	elseif proposalType == "ApproveProject" then
		local stationId = Check.string(params.station, 40)
		local station = stationId and self._jobs:GetStation(stationId)
		if not station or station.KindName ~= "ConstructionSite" or station.State ~= "Proposed" then
			return false, "Choose a proposed construction project."
		end
		proposal.params = { station = stationId, name = station.Instance:GetAttribute("ProjectName") or station.Instance.Name }
	elseif proposalType == "AcceptPetition" then
		local petition = self._petitions[Check.string(params.petition, 64) or ""]
		if not petition or petition.state ~= "Strike" then
			return false, "Choose an active strike petition."
		end
		proposal.params = { petition = petition.id, demand = petition.demand }
	end

	self._proposals[proposal.id] = proposal
	self._proposerCooldown[player.UserId] = nowMinute
	self._audit:Log("Government", "Proposed", { id = proposal.id, type = proposalType, by = player.UserId, target = proposal.target })
	self._notify:NotifyMany(self:GetSenators(), "Government", "Senate vote opened", self:_describe(proposal))
	return true, "Proposal opened for voting."
end

-- Proposals raised by the system on someone's behalf (discipline requests,
-- appeals, repeated warnings). They go to the Senate like any other.
function GovernmentService:CreateSystemProposal(proposalType: string, targetId: string, requestedBy: string)
	local typeDef = GovernmentConfig.ProposalTypes[proposalType]
	local member = self._rank:GetMember(targetId)
	if not typeDef or not member then
		return false, "Invalid request."
	end
	for _, existing in pairs(self._proposals) do
		if existing.state == "Open" and existing.type == proposalType and existing.target == targetId then
			return false, "The Senate is already considering this."
		end
	end
	local targetRank = RankConfig.Get(member.r)
	local voting = GovernmentConfig.Voting
	if targetRank and targetRank.Order >= voting.MaxTargetOrderExclusive and proposalType ~= "Pardon" then
		return false, "That office cannot be targeted."
	end
	local proposal = {
		id = HttpService:GenerateGUID(false),
		type = proposalType,
		proposer = 0,
		proposerName = requestedBy,
		target = targetId,
		targetName = self._rank:GetDisplayName(targetId),
		targetRank = targetRank and targetRank.DisplayName or "?",
		params = {},
		votes = {},
		closesAt = self._time:GetAbsoluteMinutes() + voting.DurationGameMinutes,
		state = "Open" :: string,
		requiredFraction = voting.PassFraction,
	}
	self._proposals[proposal.id] = proposal
	self._audit:Log("Government", "SystemProposal", { id = proposal.id, type = proposalType, target = targetId, by = requestedBy })
	self._notify:NotifyMany(self:GetSenators(), "Government", "Senate vote opened", self:_describe(proposal) .. " (requested by " .. requestedBy .. ")")
	return true, "Request sent to the Senate."
end

function GovernmentService:_importCost(amount: number): number
	local unit = self._economy:GetBuyPrice("PreservedFood")
	return math.ceil(unit * amount * EconomyConfig.Imports.PriceMultiplier)
end

function GovernmentService:_describe(proposal): string
	local typeDef = GovernmentConfig.ProposalTypes[proposal.type]
	local text = typeDef.DisplayName
	if proposal.targetName then
		text ..= ": " .. proposal.targetName .. " (" .. tostring(proposal.targetRank) .. ")"
	end
	if proposal.type == "SetTax" then
		text ..= string.format(": %s to %d%%", EconomyConfig.Taxes[proposal.params.tax].DisplayName, math.floor(proposal.params.rate * 100 + 0.5))
	elseif proposal.type == "ImportFood" then
		text ..= string.format(": %d rations for %d coins", proposal.params.amount, proposal.params.cost)
	elseif proposal.type == "ApproveProject" then
		text ..= ": " .. tostring(proposal.params.name)
	elseif proposal.type == "AcceptPetition" then
		local demand = GovernmentConfig.Petitions.Demands[proposal.params.demand]
		text ..= ": " .. (demand and demand.DisplayName or "")
	end
	return text
end

function GovernmentService:Vote(player: Player, proposalId: string?, yes: boolean)
	local proposal = proposalId and self._proposals[proposalId]
	if not proposal or proposal.state ~= "Open" then
		return false, "That vote is closed."
	end
	if not self:IsSenator(player) or not self._permission:Has(player, "Government.Vote") then
		return false, "Only senators vote."
	end
	if proposal.target == tostring(player.UserId) then
		return false, "You cannot vote on your own case."
	end
	if proposal.votes[player.UserId] ~= nil then
		return false, "You already voted."
	end
	proposal.votes[player.UserId] = yes
	self._audit:Log("Government", "Vote", { id = proposal.id, by = player.UserId, yes = yes })
	-- Close early when every senator present has voted.
	local all = true
	for _, senator in ipairs(self:GetSenators()) do
		if proposal.votes[senator.UserId] == nil and proposal.target ~= tostring(senator.UserId) then
			all = false
			break
		end
	end
	if all then
		self:_close(proposal)
	end
	return true, yes and "Voted YES." or "Voted NO."
end

function GovernmentService:_close(proposal)
	if proposal.state ~= "Open" then
		return
	end
	local voting = GovernmentConfig.Voting
	local yesWeight, totalWeight, voters = 0, 0, 0
	local kingVetoed = false
	for _, senator in ipairs(self:GetSenators()) do
		if proposal.target ~= tostring(senator.UserId) then
			local weight = self:_weight(senator)
			totalWeight += weight
			local vote = proposal.votes[senator.UserId]
			if vote ~= nil then
				voters += 1
				if vote then
					yesWeight += weight
				elseif isKing(self._rank:GetRankId(senator)) and voting.KingCanVeto then
					kingVetoed = true
				end
			end
		end
	end
	local passed = voters >= voting.MinVoters and totalWeight > 0 and yesWeight / totalWeight >= proposal.requiredFraction
	local impeachingKing = proposal.type == "Remove" and proposal.requiredFraction == voting.ImpeachKingFraction
	local outcome: string
	if passed and kingVetoed and not impeachingKing then
		outcome = "Vetoed"
	else
		outcome = passed and "Passed" or "Rejected"
	end
	proposal.state = outcome
	self._audit:Log("Government", "Closed", { id = proposal.id, state = outcome, yes = yesWeight, total = totalWeight })
	self._notify:Announce("Government", "Senate: " .. string.upper(outcome), self:_describe(proposal), { Banner = outcome == "Passed" })
	if outcome == "Passed" then
		local ok, err = pcall(self._execute, self, proposal)
		if not ok then
			self.Log:Error("executing proposal %s failed: %s", proposal.id, tostring(err))
		end
	end
	-- Small leadership reward for taking part in governance (once per vote).
	for userId in pairs(proposal.votes) do
		local voter = Players:GetPlayerByUserId(userId)
		if voter then
			self._xp:Award(voter, "Leadership", 10, { source = "SenateVote", ignoreAFK = true })
		end
	end
	self.ProposalClosed:Fire(proposal)
	task.delay(120, function()
		self._proposals[proposal.id] = nil
	end)
end

function GovernmentService:_execute(proposal)
	if proposal.type == "Remove" then
		self._promotion:Remove(proposal.target, { cause = "Impeached" })
	elseif proposal.type == "Demote" then
		self._promotion:Demote(proposal.target, { cause = "SenateDemotion" })
	elseif proposal.type == "SetTax" then
		self._economy:SetTax(proposal.params.tax, proposal.params.rate, "Senate")
	elseif proposal.type == "ImportFood" then
		self:_import(proposal.params.amount)
	elseif proposal.type == "ApproveProject" then
		local station = self._jobs:GetStation(proposal.params.station)
		local kind = station and require(script.Parent.Jobs.ConstructionSite)
		if kind then
			kind.Approve(self._jobs, station, nil)
		end
	elseif proposal.type == "AcceptPetition" then
		self:_acceptPetition(proposal.params.petition)
	elseif proposal.type == "Pardon" then
		self:_pardon(proposal.target)
	end
end

function GovernmentService:_import(amount: number)
	local cost = self:_importCost(amount)
	if not self._economy:TreasuryWithdraw(cost, "Imports") then
		self._notify:Announce("Warning", "Import failed", "The treasury could not pay for the food import.")
		return false
	end
	self._notify:Announce("Government", "Food import ordered", string.format("%d rations arrive soon.", amount))
	task.delay(self._time:GameMinutesToSeconds(EconomyConfig.Imports.ArrivalGameMinutes), function()
		local accepted = self._resources:Deposit("PreservedFood", amount, "Import")
		self._notify:Announce("Success", "Food import arrived", string.format("%d rations reached the granary.", accepted))
	end)
	return true
end

function GovernmentService:_pardon(targetId: string)
	self._rank:Run("Pardon", function(_, state)
		local member = state.m[targetId]
		if member then
			member.b = nil
		end
		return {}
	end)
	local player = Players:GetPlayerByUserId(tonumber(targetId) or 0)
	local profile = player and self._data:Get(player)
	if profile then
		profile.Discipline.Warnings = {}
		profile.Discipline.SuspendedUntil = 0
		self._notify:Notify(player, "Government", "Pardoned", "The Senate has pardoned you.")
	end
end

-- Direct authority ------------------------------------------------------------------------

function GovernmentService:_directBudget(player: Player)
	local day = self._time:GetDay()
	local record = self._directActions[player.UserId]
	if not record or record.day ~= day then
		record = { day = day, demotes = 0, removals = 0 }
		self._directActions[player.UserId] = record
	end
	return record
end

local function validReason(reason): string?
	local text = Check.string(reason, 200)
	if not text then
		return nil
	end
	if GovernmentConfig.DirectActions.RequireReason and #text < GovernmentConfig.DirectActions.MinReasonLength then
		return nil
	end
	return text
end

function GovernmentService:DirectDemote(actor: Player, target: Player?, reason)
	if not target then
		return false, "Choose a player."
	end
	local text = validReason(reason)
	if not text then
		return false, "A reason is required."
	end
	if not self._permission:Has(actor, "Rank.Demote") or not self._permission:CanManage(actor, target) then
		return false, "You have no authority over that player."
	end
	if self._rank:GetOrder(target) <= RankConfig.Bottom().Order then
		return false, "They already hold the lowest rank."
	end
	local budget = self:_directBudget(actor)
	if budget.demotes >= GovernmentConfig.DirectActions.DemotesPerManagerPerGameDay then
		return false, "You have used today's demotions. Ask the Senate."
	end
	budget.demotes += 1
	self._audit:Log("Government", "DirectDemote", { by = actor.UserId, target = target.UserId, reason = text })
	self._promotion:Demote(target, { cause = "Demoted by " .. actor.DisplayName })
	self._notify:Notify(target, "Government", "Demoted", string.format("%s demoted you: %s", actor.DisplayName, text))
	return true, "Demoted."
end

function GovernmentService:DirectRemove(actor: Player, target: Player?, reason)
	if not target then
		return false, "Choose a player."
	end
	local text = validReason(reason)
	if not text then
		return false, "A reason is required."
	end
	if not self._permission:Has(actor, "Rank.Remove") or not self._permission:CanManage(actor, target) then
		return false, "Removals require a Senate vote."
	end
	local budget = self:_directBudget(actor)
	if budget.removals >= GovernmentConfig.DirectActions.RemovalsPerManagerPerGameDay then
		return false, "You have used today's removal. Ask the Senate."
	end
	budget.removals += 1
	self._audit:Log("Government", "DirectRemove", { by = actor.UserId, target = target.UserId, reason = text })
	self._promotion:Remove(target, { cause = "Removed by " .. actor.DisplayName })
	self._notify:Announce("Government", "Removed from office", string.format("%s removed %s from office.", actor.DisplayName, target.DisplayName))
	return true, "Removed."
end

-- Appoint a subordinate into an EMPTY slot below your own rank (vacancies
-- that the automatic cascade cannot fill, or MANUAL mode).
function GovernmentService:Appoint(actor: Player, target: Player?, rankId: string?)
	if not target or not rankId or not RankConfig.Get(rankId) then
		return false, "Choose a player and rank."
	end
	if not self._permission:Has(actor, "Rank.Appoint") or not self._permission:CanManage(actor, target) then
		return false, "You have no authority to appoint that player."
	end
	if RankConfig.Get(rankId).Order >= self._rank:GetOrder(actor) then
		return false, "You can only appoint below your own rank."
	end
	if RankConfig.Get(rankId).Order <= self._rank:GetOrder(target) then
		return false, "Appointments must be promotions."
	end
	local ok, err = self._promotion:SetRank(target, rankId, "Appointed by " .. actor.DisplayName)
	if not ok then
		return false, err == "RankFull" and "That rank has no empty slot." or tostring(err)
	end
	self._audit:Log("Government", "Appoint", { by = actor.UserId, target = target.UserId, rank = rankId })
	return true, "Appointed."
end

-- Petitions / strikes ------------------------------------------------------------------------

function GovernmentService:StartPetition(player: Player, demand: string?)
	local config = GovernmentConfig.Petitions
	if not config.Enabled then
		return false, "Petitions are disabled."
	end
	if not demand or not config.Demands[demand] then
		return false, "Choose a demand."
	end
	if self._kingdom:GetMorale() > config.MaxMoraleToStart then
		return false, "Conditions are not bad enough for a strike."
	end
	if self:IsSenator(player) then
		return false, "Senators cannot strike against themselves."
	end
	for _, petition in pairs(self._petitions) do
		if petition.state ~= "Closed" and petition.demand == demand then
			return false, "A petition with that demand already exists. Sign it instead."
		end
	end
	local id = HttpService:GenerateGUID(false)
	self._petitions[id] = {
		id = id,
		demand = demand,
		starter = player.DisplayName,
		signers = { [player.UserId] = true },
		state = "Gathering",
		endsAt = self._time:GetAbsoluteMinutes() + config.DurationGameMinutes,
	}
	self._notify:Broadcast("Government", "Petition started", string.format("%s petitions: %s. Sign at the Government board.", player.DisplayName, config.Demands[demand].DisplayName))
	self._audit:Log("Government", "PetitionStarted", { by = player.UserId, demand = demand })
	return true, "Petition started."
end

function GovernmentService:SignPetition(player: Player, petitionId: string?)
	local petition = petitionId and self._petitions[petitionId]
	if not petition or petition.state == "Closed" then
		return false, "That petition is closed."
	end
	if self:IsSenator(player) then
		return false, "Senators cannot sign."
	end
	petition.signers[player.UserId] = true
	self:_checkPetition(petition)
	return true, "Signed."
end

function GovernmentService:_signerCount(petition): number
	local count = 0
	for userId in pairs(petition.signers) do
		if Players:GetPlayerByUserId(userId) then
			count += 1
		end
	end
	return count
end

function GovernmentService:_checkPetition(petition)
	local config = GovernmentConfig.Petitions
	local eligible = 0
	for _, player in ipairs(Players:GetPlayers()) do
		if not self:IsSenator(player) then
			eligible += 1
		end
	end
	local signers = self:_signerCount(petition)
	if petition.state == "Gathering" and signers >= math.max(config.MinSignatures, math.ceil(eligible * config.SignatureFraction)) then
		petition.state = "Strike"
		self._depts:SetStrikePenalty(nil, signers * config.StrikeEfficiencyPenaltyPerSigner)
		self._notify:Announce("Critical", "STRIKE!", string.format("%d workers strike: %s. The Senate must respond.", signers, config.Demands[petition.demand].DisplayName))
		self._audit:Log("Government", "StrikeStarted", { demand = petition.demand, signers = signers })
	elseif petition.state == "Strike" then
		self._depts:SetStrikePenalty(nil, signers * config.StrikeEfficiencyPenaltyPerSigner)
	end
end

function GovernmentService:_acceptPetition(petitionId: string)
	local petition = self._petitions[petitionId]
	if not petition or petition.state == "Closed" then
		return
	end
	local config = GovernmentConfig.Petitions
	local effect = config.Demands[petition.demand].Effect
	if effect.TaxDelta then
		for name in pairs(EconomyConfig.Taxes) do
			self._economy:SetTax(name, self._economy:GetTax(name) + effect.TaxDelta, "Petition")
		end
	end
	if effect.BonusPayPerSigner then
		for userId in pairs(petition.signers) do
			local player = Players:GetPlayerByUserId(userId)
			if player then
				self._economy:PayWage(player, effect.BonusPayPerSigner, "PetitionPay")
			end
		end
	end
	if effect.ImportFood then
		self:_import(effect.ImportFood)
	end
	if effect.RepairAll then
		self._buildings:RepairAll(effect.RepairAll, "Petition")
	end
	petition.state = "Closed"
	self._depts:SetStrikePenalty(nil, 0)
	self._kingdom:AddMorale(config.AcceptedMoraleBonus, "PetitionAccepted")
	self._notify:Announce("Success", "Strike ends", "The Senate accepted the workers' demands.")
end

function GovernmentService:_tick()
	local nowMinute = self._time:GetAbsoluteMinutes()
	for _, proposal in pairs(self._proposals) do
		if proposal.state == "Open" and nowMinute >= proposal.closesAt then
			self:_close(proposal)
		end
	end
	for id, petition in pairs(self._petitions) do
		if petition.state ~= "Closed" then
			self:_checkPetition(petition)
			if nowMinute >= petition.endsAt then
				petition.state = "Closed"
				self._depts:SetStrikePenalty(nil, 0)
				if self:_signerCount(petition) > 0 then
					self._kingdom:AddMorale(-KingdomConfig.Morale.UnpaidWagePenalty, "PetitionIgnored")
				end
			end
		elseif nowMinute >= petition.endsAt + 60 then
			self._petitions[id] = nil
		end
	end
end

-- Views & remotes ------------------------------------------------------------------------------

function GovernmentService:GetView(player: Player)
	local proposals = {}
	for _, proposal in pairs(self._proposals) do
		local yes, no = 0, 0
		for _, vote in pairs(proposal.votes) do
			if vote then
				yes += 1
			else
				no += 1
			end
		end
		table.insert(proposals, {
			Id = proposal.id,
			Text = self:_describe(proposal),
			Proposer = proposal.proposerName,
			State = proposal.state,
			Yes = yes,
			No = no,
			MyVote = proposal.votes[player.UserId],
			MinutesLeft = math.max(0, math.floor(proposal.closesAt - self._time:GetAbsoluteMinutes())),
			Required = proposal.requiredFraction,
		})
	end
	local petitions = {}
	for _, petition in pairs(self._petitions) do
		table.insert(petitions, {
			Id = petition.id,
			Demand = GovernmentConfig.Petitions.Demands[petition.demand].DisplayName,
			DemandId = petition.demand,
			Starter = petition.starter,
			Signers = self:_signerCount(petition),
			State = petition.state,
			Signed = petition.signers[player.UserId] == true,
		})
	end
	local senators = {}
	for _, senator in ipairs(self:GetSenators()) do
		table.insert(senators, { Name = senator.DisplayName, Rank = self._rank:GetRankDef(senator).DisplayName })
	end
	return {
		IsSenator = self:IsSenator(player),
		CanPropose = self._permission:Has(player, "Government.Propose"),
		CanVote = self._permission:Has(player, "Government.Vote"),
		Senators = senators,
		Proposals = proposals,
		Petitions = petitions,
		Morale = self._kingdom:GetMorale(),
		Taxes = self._economy:GetTaxes(),
		TaxDefs = EconomyConfig.Taxes,
	}
end

local function targetPlayer(value): Player?
	local userId = Check.userId(value)
	return userId and Players:GetPlayerByUserId(userId) or nil
end

function GovernmentService:_registerRemotes()
	Net.Query("Government", { rate = 1, burst = 3 }, function(player)
		return self:GetView(player)
	end)
	Net.Action("Government", "Propose", { rate = 0.2, burst = 2 }, function(player, payload)
		local proposalType = Check.key(payload.type, GovernmentConfig.ProposalTypes)
		if not proposalType then
			return false, "Unknown proposal."
		end
		local target = payload.target ~= nil and tostring(Check.userId(payload.target) or "") or nil
		return self:Propose(player, proposalType, target ~= "" and target or nil, type(payload.params) == "table" and payload.params or {})
	end)
	Net.Action("Government", "Vote", { rate = 1, burst = 3 }, function(player, payload)
		return self:Vote(player, Check.string(payload.proposal, 64), payload.yes == true)
	end)
	Net.Action("Government", "Demote", { rate = 0.2, burst = 1 }, function(player, payload)
		return self:DirectDemote(player, targetPlayer(payload.target), payload.reason)
	end)
	Net.Action("Government", "Remove", { rate = 0.2, burst = 1 }, function(player, payload)
		return self:DirectRemove(player, targetPlayer(payload.target), payload.reason)
	end)
	Net.Action("Government", "Appoint", { rate = 0.2, burst = 1 }, function(player, payload)
		return self:Appoint(player, targetPlayer(payload.target), Check.string(payload.rank, 40))
	end)
	Net.Action("Government", "SetTax", { rate = 0.2, burst = 1 }, function(player, payload)
		-- Direct tax changes need SetTax AND Treasury authority (King/Council);
		-- everyone else goes through a Senate proposal.
		if not (self._permission:Has(player, "Government.SetTaxes") and self._permission:Has(player, "Government.Veto")) then
			return false, "Propose tax changes to the Senate."
		end
		local tax = Check.key(payload.tax, EconomyConfig.Taxes)
		local rate = Check.number(payload.rate, 0, 1)
		if not tax or not rate then
			return false, "Invalid tax."
		end
		return self._economy:SetTax(tax, rate, player.DisplayName)
	end)
	Net.Action("Government", "StartPetition", { rate = 0.1, burst = 1 }, function(player, payload)
		return self:StartPetition(player, Check.key(payload.demand, GovernmentConfig.Petitions.Demands))
	end)
	Net.Action("Government", "SignPetition", { rate = 0.5, burst = 2 }, function(player, payload)
		return self:SignPetition(player, Check.string(payload.petition, 64))
	end)
end

return GovernmentService
