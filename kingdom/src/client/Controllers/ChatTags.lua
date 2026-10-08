--[[
	ChatTags (client)
	Adds [KING] / [DUKE] / [GUARD] ... prefixes to chat messages. The tag is
	read from attributes the SERVER sets on each Player, so a client can't
	impersonate a rank in other people's chat (changing your own attribute
	locally only changes your own screen).
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TextChatService = game:GetService("TextChatService")

local GameConfig = require(ReplicatedStorage.Kingdom.Config.GameConfig)

local ChatTags = {}

local function escape(text: string): string
	return (string.gsub(text, "[<>&\"']", {
		["<"] = "&lt;",
		[">"] = "&gt;",
		["&"] = "&amp;",
		['"'] = "&quot;",
		["'"] = "&apos;",
	}))
end

function ChatTags.Init()
	if not GameConfig.Chat.ShowRankTags then
		return
	end
	TextChatService.OnIncomingMessage = function(message: TextChatMessage)
		local properties = Instance.new("TextChatMessageProperties")
		local source = message.TextSource
		if not source then
			return properties
		end
		local speaker = Players:GetPlayerByUserId(source.UserId)
		if not speaker then
			return properties
		end
		local tag = speaker:GetAttribute("KingdomChatTag")
		local color = speaker:GetAttribute("KingdomRankColor")
		if type(tag) == "string" and tag ~= "" then
			local hex = typeof(color) == "Color3" and color:ToHex() or "d6ac42"
			local title = speaker:GetAttribute("KingdomTitle")
			local suffix = ""
			if GameConfig.Chat.ShowTitles and type(title) == "string" and title ~= "" then
				suffix = " <i>" .. escape(title) .. "</i>"
			end
			properties.PrefixText = string.format('<font color="#%s">[%s]</font> %s%s', hex, escape(tag), message.PrefixText, suffix)
		end
		return properties
	end
end

return ChatTags
