--[[
	Notifications (client)
	Toasts (top right), kingdom banners (top centre), chat system lines and
	sounds for every NotificationService message.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local SoundService = game:GetService("SoundService")
local TextChatService = game:GetService("TextChatService")
local TweenService = game:GetService("TweenService")

local UIConfig = require(ReplicatedStorage.Kingdom.Config.UIConfig)
local ClientNet = require(script.Parent.Parent.Controllers.ClientNet)
local App = require(script.Parent.App)
local Kit = require(script.Parent.Kit)

local Notifications = {}

local toastHolder
local bannerHolder
local sounds = {}

local function colorFor(kind: string): Color3
	local key = UIConfig.NotificationColors[kind] or "Info"
	return Kit.Colors[key] or Kit.Colors.Info
end

local function playSound(key: string?)
	local id = key and UIConfig.Sounds[key]
	if not id or id == "" then
		return
	end
	local sound = sounds[key]
	if not sound then
		sound = Kit.new("Sound", { SoundId = id, Volume = 0.6, Parent = SoundService })
		sounds[key] = sound
	end
	sound:Play()
end

local function chatLine(text: string, color: Color3)
	local channels = TextChatService:FindFirstChild("TextChannels")
	local general = channels and channels:FindFirstChild("RBXGeneral")
	if general and general:IsA("TextChannel") then
		local hex = color:ToHex()
		pcall(general.DisplaySystemMessage, general, string.format('<font color="#%s">%s</font>', hex, text))
	end
end

function Notifications.Init()
	toastHolder = Kit.new("Frame", {
		Name = "Toasts",
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -12, 0, 12),
		Size = UDim2.fromOffset(320, 400),
		Parent = App.Overlay,
	})
	local layout = Kit.list(toastHolder, 6)
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Right

	bannerHolder = Kit.new("Frame", {
		Name = "Banners",
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(0.5, 0),
		Position = UDim2.new(0.5, 0, 0, 56),
		Size = UDim2.fromOffset(620, 200),
		Parent = App.Overlay,
	})
	Kit.list(bannerHolder, 6).HorizontalAlignment = Enum.HorizontalAlignment.Center

	ClientNet.OnEvent("Notify", function(message)
		if type(message) == "table" then
			Notifications.Show(message)
		end
	end)
end

function Notifications.Toast(kind: string, title: string, text: string?, duration: number?)
	local toast = Kit.Panel({
		Style = "Parchment",
		Size = UDim2.fromOffset(310, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Padding = 8,
		Parent = toastHolder,
	})
	Kit.list(toast, 2)
	local accent = Kit.new("Frame", {
		BackgroundColor3 = colorFor(kind),
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, 3),
		LayoutOrder = 0,
		Parent = toast,
	})
	local _ = accent
	Kit.Text({ Text = title, Style = "Heading", TextSize = 17, LayoutOrder = 1, Parent = toast, AutomaticSize = Enum.AutomaticSize.Y })
	if text and text ~= "" then
		Kit.Text({ Text = text, TextSize = 14, LayoutOrder = 2, Parent = toast, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) })
	end
	local children = toastHolder:GetChildren()
	local count = 0
	for _, child in ipairs(children) do
		if child:IsA("Frame") then
			count += 1
		end
	end
	if count > UIConfig.MaxToasts then
		for _, child in ipairs(children) do
			if child:IsA("Frame") and child ~= toast then
				child:Destroy()
				break
			end
		end
	end
	task.delay(duration or UIConfig.ToastSeconds, function()
		if toast.Parent then
			TweenService:Create(toast, TweenInfo.new(0.4), { BackgroundTransparency = 1 }):Play()
			task.wait(0.4)
			toast:Destroy()
		end
	end)
end

function Notifications.Banner(kind: string, title: string, text: string?, duration: number?)
	local banner = Kit.Panel({
		Style = kind == "Critical" and "Stone" or "Wood",
		Size = UDim2.fromOffset(600, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Padding = 10,
		Parent = bannerHolder,
	})
	Kit.list(banner, 4).HorizontalAlignment = Enum.HorizontalAlignment.Center
	Kit.Text({
		Text = title,
		Style = "Title",
		TextSize = 30,
		Align = Enum.TextXAlignment.Center,
		Color = kind == "Critical" and Color3.fromRGB(255, 120, 100) or Kit.Colors.Gold,
		AutomaticSize = Enum.AutomaticSize.Y,
		Parent = banner,
	}).TextStrokeTransparency = 0.4
	if text and text ~= "" then
		Kit.Text({
			Text = text,
			Style = "Light",
			TextSize = 17,
			Align = Enum.TextXAlignment.Center,
			AutomaticSize = Enum.AutomaticSize.Y,
			Size = UDim2.new(1, 0, 0, 0),
			LayoutOrder = 1,
			Parent = banner,
		})
	end
	task.delay(duration or 6, function()
		if banner.Parent then
			banner:Destroy()
		end
	end)
end

function Notifications.Show(message)
	local kind = message.Kind or "Information"
	if message.Banner then
		Notifications.Banner(kind, message.Title or "", message.Text, message.Duration)
	else
		Notifications.Toast(kind, message.Title or "", message.Text, message.Duration)
	end
	if message.Chat then
		local text = message.Title or ""
		if message.Text and message.Text ~= "" then
			text ..= ": " .. string.gsub(message.Text, "\n", " · ")
		end
		chatLine(text, colorFor(kind))
	end
	playSound(message.Sound or (message.Banner and "Notification" or nil))
end

-- Local feedback (results of the player's own requests).
function Notifications.Result(ok: boolean, message: string?)
	if message and message ~= "" then
		Notifications.Toast(ok and "Success" or "Warning", ok and "Done" or "Not possible", message, 3.5)
	end
end

return Notifications
