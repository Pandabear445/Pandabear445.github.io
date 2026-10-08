--[[
	NotificationService
	One reusable path for every message a player sees.

	Kinds: Information, Success, Warning, Critical, Government, Promotion,
	       Job, Economy, Meeting, Death
	Options:
	  Banner  = true   big centered banner (kingdom-wide events)
	  Chat    = true   also posted as a system message in chat
	  Sound   = key    UIConfig.Sounds key
	  Duration= sec
]]

local Players = game:GetService("Players")

local Net = require(script.Parent.Parent.Core.Net)

local NotificationService = {
	Name = "NotificationService",
	Dependencies = {},
}

local VALID_KINDS = {
	Information = true,
	Success = true,
	Warning = true,
	Critical = true,
	Government = true,
	Promotion = true,
	Job = true,
	Economy = true,
	Meeting = true,
	Death = true,
}

export type Options = {
	Banner: boolean?,
	Chat: boolean?,
	Sound: string?,
	Duration: number?,
}

local function build(kind: string, title: string, text: string?, options)
	options = options or {}
	return {
		Kind = VALID_KINDS[kind] and kind or "Information",
		Title = title,
		Text = text or "",
		Banner = options.Banner == true,
		Chat = options.Chat == true,
		Sound = options.Sound,
		Duration = options.Duration,
		Time = os.time(),
	}
end

function NotificationService:Init() end

function NotificationService:Notify(player: Player, kind: string, title: string, text: string?, options: Options?)
	Net.Fire("Notify", player, build(kind, title, text, options))
end

function NotificationService:NotifyMany(players: { Player }, kind: string, title: string, text: string?, options: Options?)
	local message = build(kind, title, text, options)
	for _, player in ipairs(players) do
		Net.Fire("Notify", player, message)
	end
end

function NotificationService:Broadcast(kind: string, title: string, text: string?, options: Options?)
	Net.FireAll("Notify", build(kind, title, text, options))
end

-- Kingdom-wide announcement: banner + chat line.
function NotificationService:Announce(kind: string, title: string, text: string?, options)
	options = options or {}
	if options.Banner == nil then
		options.Banner = true
	end
	if options.Chat == nil then
		options.Chat = true
	end
	self:Broadcast(kind, title, text, options)
end

-- Sends to players matching a predicate.
function NotificationService:NotifyWhere(predicate: (Player) -> boolean, kind: string, title: string, text: string?, options: Options?)
	local message = build(kind, title, text, options)
	for _, player in ipairs(Players:GetPlayers()) do
		local ok, include = pcall(predicate, player)
		if ok and include then
			Net.Fire("Notify", player, message)
		end
	end
end

return NotificationService
