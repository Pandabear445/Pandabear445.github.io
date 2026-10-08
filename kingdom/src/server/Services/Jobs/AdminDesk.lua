--[[
	AdminDesk (job kind)
	Clerks keep the royal ledgers. "Process ledgers" presents a question
	built from the kingdom's REAL stock numbers; the clerk answers within
	AnswerSeconds. Correct (and quick) answers pay XP and boost the
	Government department; wrong answers are mistakes.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Check = require(script.Parent.Parent.Parent.Core.Check)
local ResourceConfig = require(ReplicatedStorage.Kingdom.Config.ResourceConfig)

local AdminDesk = {}

local pending = {} -- [Player] = quiz

local function shuffle(list)
	for i = #list, 2, -1 do
		local j = math.random(i)
		list[i], list[j] = list[j], list[i]
	end
	return list
end

local function makeQuestion(ctx)
	local ids = {}
	for id in pairs(ResourceConfig.Resources) do
		table.insert(ids, id)
	end
	local resourceId = ids[math.random(#ids)]
	local def = ResourceConfig.Resources[resourceId]
	local stock = ctx.Resources:GetStock(resourceId)
	local kind = math.random(3)
	local question, answer
	if kind == 1 then
		local incoming = math.random(5, 40)
		question = string.format("The ledger shows %d %s in storage. A cart delivers %d more. What is the new total?", stock, def.DisplayName, incoming)
		answer = stock + incoming
	elseif kind == 2 then
		local outgoing = math.random(1, math.max(1, math.min(stock, 30)))
		question = string.format("Storage holds %d %s. The kitchens take %d. How many remain?", stock, def.DisplayName, outgoing)
		answer = stock - outgoing
	else
		local units = math.random(2, 12)
		question = string.format("%s sells for %d coins each. What do %d cost?", def.DisplayName, def.BaseValue, units)
		answer = def.BaseValue * units
	end
	local options = { answer }
	local used = { [answer] = true }
	while #options < 4 do
		local wrong = math.max(0, answer + math.random(-12, 12))
		if not used[wrong] then
			used[wrong] = true
			table.insert(options, wrong)
		end
	end
	return question, answer, shuffle(options)
end

function AdminDesk.Attach(ctx, instance: Instance, job)
	local station: any = {}
	local parent = (instance:IsA("BasePart") and instance) or ctx.PromptUtil.anchorFor(instance)
	station.Anchor = parent
	local prompt = ctx.PromptUtil.create(parent, {
		Name = "KingdomLedger",
		ActionText = "Process ledgers",
		ObjectText = instance.Name,
		HoldDuration = 1,
		MaxDistance = 10,
		Permission = job.Permission,
	})
	ctx.PromptUtil.onTriggered(prompt, function(player, held)
		if not ctx.PromptUtil.heldLongEnough(held, 1, ctx.Config.Session.HoldTolerance) then
			return
		end
		if pending[player] then
			ctx:Feedback(player, false, "Finish the open ledger first.")
			return
		end
		local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor })
		if not ok then
			ctx:Feedback(player, false, reason)
			return
		end
		local cooldown = ctx:Attr(instance, job, "Cooldown", 4)
		if station.LastBy and station.LastBy[player] and os.clock() - station.LastBy[player] < cooldown then
			return
		end
		local question, answer, options = makeQuestion(ctx)
		local quiz = {
			id = ctx:NewSessionId(),
			station = station,
			answer = answer,
			options = options,
			askedAt = os.clock(),
		}
		pending[player] = quiz
		ctx.Activity:MarkInteraction(player)
		ctx.Net.Fire("Effect", player, "Quiz", {
			Station = station.Id,
			Session = quiz.id,
			Question = question,
			Options = options,
			Seconds = job.AnswerSeconds,
		})
	end)
	return station
end

function AdminDesk.HandleAction(ctx, player: Player, station, payload)
	if payload.action ~= "Answer" then
		return false, "Unknown action."
	end
	local quiz = pending[player]
	if not quiz or quiz.station ~= station or payload.session ~= quiz.id then
		return false, "No open ledger."
	end
	local choice = Check.integer(payload.choice, 1, 4)
	if not choice then
		return false, "Invalid answer."
	end
	pending[player] = nil
	station.LastBy = station.LastBy or {}
	station.LastBy[player] = os.clock()
	local job = station.Job
	local elapsed = os.clock() - quiz.askedAt
	if elapsed > job.AnswerSeconds + 1 then
		ctx:Mistake(player, station, "Too slow - the ledger was filed late.")
		return false, "Too slow."
	end
	if quiz.options[choice] ~= quiz.answer then
		ctx:Mistake(player, station, string.format("Wrong entry. The correct figure was %d.", quiz.answer))
		return false, "Incorrect."
	end
	local ok, reason = ctx:Validate(player, station, { anchor = station.Anchor, skipTravel = true })
	if not ok then
		return false, reason
	end
	local skill = elapsed < job.AnswerSeconds * 0.35 and 0.25 or (elapsed < job.AnswerSeconds * 0.7 and 0.1 or 0)
	ctx:Complete(player, station, { skill = skill, label = "Ledger" })
	return true, "Correct."
end

function AdminDesk.RealTick(ctx)
	local now = os.clock()
	for player, quiz in pairs(pending) do
		if player.Parent ~= Players then
			pending[player] = nil
		elseif now - quiz.askedAt > quiz.station.Job.AnswerSeconds + 2 then
			pending[player] = nil
			ctx:Mistake(player, quiz.station, "The ledger went unanswered.")
		end
	end
end

function AdminDesk.Cancel(_, player: Player)
	pending[player] = nil
end

return AdminDesk
