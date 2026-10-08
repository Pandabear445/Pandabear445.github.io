--[[
	Effects (client)
	Handles server "Effect" events: promotion fanfare, the death screen,
	fishing bites, ledger quizzes, guard watch calls and the storage /
	trade / market popups. The client only displays and requests; the
	server judges timing and correctness.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local UserInputService = game:GetService("UserInputService")

local Format = require(ReplicatedStorage.Kingdom.Shared.Format)
local UIConfig = require(ReplicatedStorage.Kingdom.Config.UIConfig)
local ClientNet = require(script.Parent.ClientNet)
local App = require(script.Parent.Parent.UI.App)
local Kit = require(script.Parent.Parent.UI.Kit)
local Notifications = require(script.Parent.Parent.UI.Notifications)

local Effects = {}

local player = Players.LocalPlayer
local jobPanel
local fishing = nil
local quizFrame
local watchFrame
local deathFrame

local function playSound(key: string)
	local id = UIConfig.Sounds[key]
	if id and id ~= "" then
		local sound = Kit.new("Sound", { SoundId = id, Volume = 0.8, Parent = workspace.CurrentCamera })
		sound:Play()
		sound.Ended:Once(function()
			sound:Destroy()
		end)
	end
end

local function clearJobPanel()
	if jobPanel then
		jobPanel:Destroy()
		jobPanel = nil
	end
	fishing = nil
end

local function makeJobPanel(): Frame
	clearJobPanel()
	jobPanel = Kit.Panel({
		Name = "JobPanel",
		Style = "Wood",
		AnchorPoint = Vector2.new(0.5, 1),
		Position = UDim2.new(0.5, 0, 1, -110),
		Size = UDim2.fromOffset(340, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Padding = 10,
		Parent = App.Overlay,
	})
	Kit.list(jobPanel, 6).HorizontalAlignment = Enum.HorizontalAlignment.Center
	return jobPanel
end

-- Promotion ------------------------------------------------------------------------

function Effects.Promotion(data)
	playSound("Promotion")
	local frame = Kit.Panel({
		Style = "Wood",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.38),
		Size = UDim2.fromOffset(520, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Padding = 16,
		Parent = App.Overlay,
	})
	Kit.list(frame, 6).HorizontalAlignment = Enum.HorizontalAlignment.Center
	local scale = Kit.new("UIScale", { Scale = 0.3, Parent = frame })
	Kit.Text({ Text = "PROMOTED", Style = "Title", TextSize = 46, Align = Enum.TextXAlignment.Center, Color = Kit.Colors.Gold, Parent = frame }).TextStrokeTransparency = 0.3
	Kit.Text({
		Text = string.format("%s  →  %s", data.From or "?", data.To or "?"),
		Style = "Heading",
		TextSize = 26,
		Align = Enum.TextXAlignment.Center,
		Color = typeof(data.Color) == "Color3" and data.Color or Kit.Colors.TextLight,
		LayoutOrder = 1,
		Parent = frame,
	}).TextStrokeTransparency = 0.4
	local perks = { string.format("Salary: %d coins / day", data.Salary or 0), string.format("Pay multiplier: x%.2f", data.PayMultiplier or 1) }
	if (data.ManageDepth or 0) > 0 then
		table.insert(perks, "You now manage lower ranks - open Duties (N).")
	end
	if data.Council then
		table.insert(perks, "You sit in the Senate - open Senate (J).")
	end
	Kit.Text({ Text = table.concat(perks, "\n"), Style = "Light", TextSize = 16, Align = Enum.TextXAlignment.Center, LayoutOrder = 2, Parent = frame, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) })
	TweenService:Create(scale, TweenInfo.new(0.5, Enum.EasingStyle.Back), { Scale = 1 }):Play()
	task.delay(5, function()
		TweenService:Create(scale, TweenInfo.new(0.3), { Scale = 0 }):Play()
		task.wait(0.35)
		frame:Destroy()
	end)
end

-- Death ------------------------------------------------------------------------------

function Effects.Death(data)
	playSound("Death")
	clearJobPanel()
	if deathFrame then
		deathFrame:Destroy()
	end
	deathFrame = Kit.new("Frame", {
		Name = "DeathScreen",
		BackgroundColor3 = Color3.fromRGB(10, 6, 6),
		BackgroundTransparency = 1,
		Size = UDim2.fromScale(1, 1),
		ZIndex = 50,
		Parent = App.Overlay,
	})
	TweenService:Create(deathFrame, TweenInfo.new(1.2), { BackgroundTransparency = 0.15 }):Play()
	local column = Kit.new("Frame", {
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.45),
		Size = UDim2.fromOffset(640, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		ZIndex = 51,
		Parent = deathFrame,
	})
	Kit.list(column, 8).HorizontalAlignment = Enum.HorizontalAlignment.Center
	Kit.Text({ Text = data.Title or "YOU HAVE FALLEN", Style = "Title", TextSize = 64, Align = Enum.TextXAlignment.Center, Color = Color3.fromRGB(200, 40, 40), Parent = column }).TextStrokeTransparency = 0.2
	Kit.Text({
		Text = table.concat(data.Lines or {}, "\n"),
		Style = "Light",
		TextSize = 20,
		Align = Enum.TextXAlignment.Center,
		LayoutOrder = 1,
		AutomaticSize = Enum.AutomaticSize.Y,
		Size = UDim2.new(1, 0, 0, 0),
		Parent = column,
	})
	Kit.Text({
		Text = string.format("Cause: %s · Lost: %s and %s XP", tostring(data.Cause), tostring(data.PreviousRank), Format.number(data.PreviousXP or 0)),
		Style = "Light",
		TextSize = 16,
		Align = Enum.TextXAlignment.Center,
		Color = Color3.fromRGB(230, 170, 150),
		LayoutOrder = 2,
		Parent = column,
	})
	local lifetime = data.Lifetime or {}
	Kit.Text({
		Text = string.format(
			"Your legacy endures - Highest rank: %s · Highest XP: %s · Lifetime XP: %s · Deaths: %d\nLife #%d begins now.%s",
			tostring(lifetime.HighestRank),
			Format.number(lifetime.HighestXP or 0),
			Format.number(lifetime.LifetimeXP or 0),
			lifetime.Deaths or 0,
			data.Life or 1,
			data.Saved == false and "\n(Your fate is still being recorded...)" or ""
		),
		Style = "Light",
		TextSize = 15,
		Align = Enum.TextXAlignment.Center,
		LayoutOrder = 3,
		AutomaticSize = Enum.AutomaticSize.Y,
		Size = UDim2.new(1, 0, 0, 0),
		Parent = column,
	})
	local frame = deathFrame
	local function hide()
		if frame and frame.Parent then
			TweenService:Create(frame, TweenInfo.new(0.8), { BackgroundTransparency = 1 }):Play()
			for _, descendant in ipairs(frame:GetDescendants()) do
				if descendant:IsA("TextLabel") then
					TweenService:Create(descendant, TweenInfo.new(0.8), { TextTransparency = 1, TextStrokeTransparency = 1 }):Play()
				end
			end
			task.delay(0.9, function()
				frame:Destroy()
			end)
		end
	end
	player.CharacterAdded:Once(function()
		task.wait(2)
		hide()
	end)
	task.delay(20, hide)
end

-- Fishing -------------------------------------------------------------------------------

function Effects.FishingCast(data)
	local panel = makeJobPanel()
	fishing = { station = data.Station, session = data.Session, bite = false }
	Kit.Text({ Text = "Line cast... wait for a bite.", Style = "Light", TextSize = 18, Align = Enum.TextXAlignment.Center, Parent = panel })
	Kit.Text({ Text = "Reeling in early scares the fish away.", Style = "Light", TextSize = 13, Align = Enum.TextXAlignment.Center, LayoutOrder = 1, Parent = panel })
end

local function reel()
	if not fishing then
		return
	end
	local current = fishing
	clearJobPanel()
	task.spawn(function()
		local ok, message = ClientNet.Action("Job", "Interact", { station = current.station, action = "Reel", session = current.session })
		if not ok then
			Notifications.Result(false, message)
		end
	end)
end

function Effects.FishingBite(data)
	if not fishing or fishing.session ~= data.Session then
		return
	end
	fishing.bite = true
	local panel = makeJobPanel()
	fishing = { station = data.Station, session = data.Session, bite = true }
	Kit.Text({ Text = "A BITE!", Style = "Title", TextSize = 34, Align = Enum.TextXAlignment.Center, Color = Kit.Colors.Gold, Parent = panel })
	Kit.Button({ Text = "REEL IN  [Q]", Size = UDim2.fromOffset(220, 44), TextSize = 22, LayoutOrder = 1, Parent = panel, OnClick = reel })
end

function Effects.FishingEnd(data)
	clearJobPanel()
	if data.Reason and data.Reason ~= "" then
		Notifications.Toast("Warning", "Fishing", data.Reason, 3)
	end
end

-- Ledger quiz ------------------------------------------------------------------------------

function Effects.Quiz(data)
	if quizFrame then
		quizFrame:Destroy()
	end
	quizFrame = Kit.Panel({
		Name = "Quiz",
		Style = "Parchment",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5),
		Size = UDim2.fromOffset(460, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Padding = 14,
		Parent = App.Overlay,
	})
	local frame = quizFrame
	Kit.list(frame, 8)
	Kit.Text({ Text = "Royal Ledger", Style = "Title", TextSize = 28, Parent = frame })
	Kit.Text({ Text = data.Question, TextSize = 16, LayoutOrder = 1, Parent = frame, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) })
	local timer = Kit.Bar({ LayoutOrder = 2, Parent = frame, Color = Kit.Colors.Warn })
	for index, option in ipairs(data.Options or {}) do
		Kit.Button({
			Text = tostring(option),
			Size = UDim2.new(1, 0, 0, 34),
			LayoutOrder = 2 + index,
			Parent = frame,
			OnClick = function()
				frame:Destroy()
				task.spawn(function()
					local ok, message = ClientNet.Action("Job", "Interact", { station = data.Station, action = "Answer", session = data.Session, choice = index })
					if not ok then
						Notifications.Result(false, message)
					end
				end)
			end,
		})
	end
	local started = os.clock()
	task.spawn(function()
		while frame.Parent do
			local left = (data.Seconds or 20) - (os.clock() - started)
			if left <= 0 then
				frame:Destroy()
				break
			end
			timer:Set(left / (data.Seconds or 20), string.format("%ds", math.ceil(left)))
			task.wait(0.25)
		end
	end)
end

-- Guard watch call ------------------------------------------------------------------------------

function Effects.WatchCheck(data)
	if watchFrame then
		watchFrame:Destroy()
		watchFrame = nil
	end
	if not data.Active then
		return
	end
	playSound("Bell")
	watchFrame = Kit.Panel({
		Name = "WatchCall",
		Style = "Stone",
		AnchorPoint = Vector2.new(0.5, 0),
		Position = UDim2.new(0.5, 0, 0, 150),
		Size = UDim2.fromOffset(420, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		Padding = 10,
		Parent = App.Overlay,
	})
	local frame = watchFrame
	Kit.list(frame, 4)
	Kit.Text({ Text = "WATCH CALL!", Style = "Title", TextSize = 30, Color = Kit.Colors.Gold, Align = Enum.TextXAlignment.Center, Parent = frame })
	local label = Kit.Text({ Text = "", Style = "Light", TextSize = 15, Align = Enum.TextXAlignment.Center, LayoutOrder = 1, Parent = frame })
	local deadline = os.clock() + (data.Seconds or 25)
	task.spawn(function()
		while frame.Parent do
			local left = deadline - os.clock()
			if left <= 0 then
				break
			end
			label.Text = string.format("Answer at %s: %ds", tostring(data.Post), math.ceil(left))
			task.wait(0.25)
		end
		if frame.Parent then
			frame:Destroy()
		end
	end)
end

-- Init ---------------------------------------------------------------------------------------------

function Effects.Init(windows)
	ClientNet.OnEvent("Effect", function(kind, data)
		data = type(data) == "table" and data or {}
		if kind == "Promotion" then
			Effects.Promotion(data)
		elseif kind == "Death" then
			Effects.Death(data)
		elseif kind == "FishingCast" then
			Effects.FishingCast(data)
		elseif kind == "FishingBite" then
			Effects.FishingBite(data)
		elseif kind == "FishingEnd" then
			Effects.FishingEnd(data)
		elseif kind == "Quiz" then
			Effects.Quiz(data)
		elseif kind == "WatchCheck" then
			Effects.WatchCheck(data)
		elseif kind == "OpenStorage" then
			windows.Storage.Data = data
			App.Open("Storage")
		elseif kind == "OpenTrade" then
			windows.Trade.Data = data
			App.Open("Trade")
		elseif kind == "OpenMarket" then
			App.Open("Market")
		elseif kind == "JobCancelled" then
			clearJobPanel()
			if quizFrame then
				quizFrame:Destroy()
			end
		end
	end)
	UserInputService.InputBegan:Connect(function(input, processed)
		if processed or UserInputService:GetFocusedTextBox() then
			return
		end
		if input.KeyCode == Enum.KeyCode.Q and fishing and fishing.bite then
			reel()
		elseif input.KeyCode == Enum.KeyCode.Q and fishing and not fishing.bite then
			reel() -- reeling early is a (server-judged) mistake
		end
	end)
end

return Effects
