--[[
	GovernmentConfig
	The Senate (council), proposals/voting, discipline and petitions.
	No single player can instantly remove another; removals go through
	votes unless a rank holds the explicit Rank.Remove permission.
]]

local GovernmentConfig = {}

-- Ranks whose holders sit in the Senate (in addition to RankConfig Council).
GovernmentConfig.SenateRanks = { "King", "RoyalCouncil", "Duke" }

GovernmentConfig.Voting = {
	DurationGameMinutes = 30, -- 1.5 real minutes
	MinVoters = 2, -- below this many senators online, proposals cannot pass
	-- Required yes fraction of senators ONLINE when the vote closes.
	PassFraction = 0.6,
	KingVoteWeight = 2,
	KingCanVeto = true,
	-- A proposal may not target someone at or above this authority unless
	-- it is an impeachment of the King (which needs ImpeachFraction).
	MaxTargetOrderExclusive = 10,
	ImpeachKingFraction = 0.75,
	ProposerCooldownGameMinutes = 30,
	MaxOpenProposals = 6,
}

-- Proposal types and what they do.
GovernmentConfig.ProposalTypes = {
	Remove = { DisplayName = "Remove from office", NeedsTarget = true },
	Demote = { DisplayName = "Demote one rank", NeedsTarget = true },
	SetTax = { DisplayName = "Change a tax", NeedsTarget = false },
	ApproveProject = { DisplayName = "Fund a construction project", NeedsTarget = false },
	ImportFood = { DisplayName = "Import food", NeedsTarget = false },
	AcceptPetition = { DisplayName = "Accept a petition's demands", NeedsTarget = false },
	Pardon = { DisplayName = "Pardon (clear warnings & blocks)", NeedsTarget = true },
}

-- Direct rank actions (permission + CanManage required, always logged).
GovernmentConfig.DirectActions = {
	DemotesPerManagerPerGameDay = 2,
	RemovalsPerManagerPerGameDay = 1,
	RequireReason = true,
	MinReasonLength = 6,
}

GovernmentConfig.Discipline = {
	MaxFine = 100,
	FinePercentCap = 0.25, -- never more than this share of the target's coins
	MaxSuspensionGameMinutes = 120,
	WarningExpiresGameHours = 15, -- one in-game day
	ActionsPerManagerPerGameHour = 4,
	AutoDemotionRequestWarnings = 3, -- active warnings that create a Senate demotion proposal
	RequireReason = true,
	MinReasonLength = 6,
}

-- Player-driven protests. Only possible when morale is low; no player is
-- ever forced into a strike.
GovernmentConfig.Petitions = {
	Enabled = true,
	MaxMoraleToStart = 35,
	SignatureFraction = 0.35, -- of online non-council players
	MinSignatures = 3,
	DurationGameMinutes = 120,
	Demands = {
		LowerTaxes = { DisplayName = "Lower taxes", Effect = { TaxDelta = -0.05 } },
		PayWages = { DisplayName = "Pay our wages", Effect = { BonusPayPerSigner = 25 } },
		FeedUs = { DisplayName = "Feed the people", Effect = { ImportFood = 80 } },
		BetterConditions = { DisplayName = "Repair our workplaces", Effect = { RepairAll = 15 } },
	},
	StrikeEfficiencyPenaltyPerSigner = 0.05, -- department efficiency while striking
	AcceptedMoraleBonus = 12,
}

return GovernmentConfig
