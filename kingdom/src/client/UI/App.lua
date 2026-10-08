--[[
	App
	Root ScreenGui, responsive scaling, toolbar and the window manager.
	Windows are modules in UI/Windows with:
	  Title, Size, Key (optional hotkey), Icon, Visible(fn -> bool)
	  Build(window)            create static content once
	  Refresh(window)          (re)load data when opened / periodically
	  RefreshSeconds           auto-refresh interval while open
]]

local Players = game:GetService("Players")
local UserInputService = game:GetService("UserInputService")

local Kit = require(script.Parent.Kit)

local App = {}

local player = Players.LocalPlayer
local windows = {}
local order = {}
local openId: string? = nil

function App.Init()
	local gui = Kit.new("ScreenGui", {
		Name = "KingdomUI",
		ResetOnSpawn = false,
		ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
		IgnoreGuiInset = false,
		Parent = player:WaitForChild("PlayerGui"),
	})
	App.Gui = gui
	local scale = Kit.new("UIScale", { Parent = gui })
	local function rescale()
		local camera = workspace.CurrentCamera
		local size = camera and camera.ViewportSize or Vector2.new(1280, 720)
		scale.Scale = math.clamp(math.min(size.X / 1280, size.Y / 760), 0.6, 1.15)
	end
	rescale()
	if workspace.CurrentCamera then
		workspace.CurrentCamera:GetPropertyChangedSignal("ViewportSize"):Connect(rescale)
	end

	App.Layer = function(name: string, zIndex: number)
		return Kit.new("Frame", {
			Name = name,
			BackgroundTransparency = 1,
			Size = UDim2.fromScale(1, 1),
			ZIndex = zIndex,
			Parent = gui,
		})
	end
	App.Windows = App.Layer("Windows", 20)
	App.Overlay = App.Layer("Overlay", 40)

	App.Toolbar = Kit.new("Frame", {
		Name = "Toolbar",
		BackgroundTransparency = 1,
		AnchorPoint = Vector2.new(0, 0.5),
		Position = UDim2.new(0, 10, 0.5, 0),
		Size = UDim2.fromOffset(120, 480),
		Parent = gui,
	})
	Kit.list(App.Toolbar, 6)

	UserInputService.InputBegan:Connect(function(input, processed)
		if processed or UserInputService:GetFocusedTextBox() then
			return
		end
		if input.KeyCode == Enum.KeyCode.Escape and openId then
			App.Close()
			return
		end
		for id, window in pairs(windows) do
			if window.Module.Key and input.KeyCode == window.Module.Key and App.IsAvailable(id) then
				App.Toggle(id)
				return
			end
		end
	end)
end

function App.IsAvailable(id: string): boolean
	local window = windows[id]
	if not window then
		return false
	end
	local visible = window.Module.Visible
	if visible then
		local ok, result = pcall(visible)
		return ok and result == true
	end
	return true
end

function App.Register(id: string, module)
	local frame = Kit.Panel({
		Name = id,
		Style = "Wood",
		Size = module.Size or UDim2.fromOffset(560, 460),
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5),
		Visible = false,
		Padding = 6,
		Parent = App.Windows,
	})
	Kit.Text({
		Name = "Title",
		Text = module.Title or id,
		Style = "Title",
		Color = Kit.Colors.Gold,
		Size = UDim2.new(1, -44, 0, 34),
		Parent = frame,
	}).TextStrokeTransparency = 0.5
	local body = Kit.Panel({
		Name = "Body",
		Style = "Parchment",
		Position = UDim2.fromOffset(0, 40),
		Size = UDim2.new(1, 0, 1, -40),
		Padding = 8,
		Parent = frame,
	})
	local window = {
		Id = id,
		Module = module,
		Frame = frame,
		Body = body,
		Built = false,
		LastRefresh = 0,
	}
	Kit.Seal({
		Parent = frame,
		Position = UDim2.new(1, 0, 0, 0),
		OnClick = function()
			App.Close()
		end,
	})
	windows[id] = window
	table.insert(order, id)

	local button = Kit.Button({
		Name = id,
		Text = (module.Icon and (module.Icon .. " ") or "") .. (module.Short or module.Title or id),
		Size = UDim2.fromOffset(120, 32),
		TextSize = 14,
		LayoutOrder = #order,
		Parent = App.Toolbar,
		OnClick = function()
			App.Toggle(id)
		end,
	})
	window.Button = button
	return window
end

function App.RefreshToolbar()
	for id, window in pairs(windows) do
		window.Button.Visible = App.IsAvailable(id) and not window.Module.Hidden
	end
end

function App.Open(id: string)
	local window = windows[id]
	if not window then
		return
	end
	if openId and openId ~= id then
		App.Close()
	end
	if not window.Built then
		window.Built = true
		local ok, err = pcall(window.Module.Build, window)
		if not ok then
			warn("[UI] build " .. id .. " failed: " .. tostring(err))
		end
	end
	window.Frame.Visible = true
	openId = id
	App.RefreshWindow(id)
end

function App.RefreshWindow(id: string)
	local window = windows[id]
	if window and window.Frame.Visible and window.Module.Refresh then
		window.LastRefresh = os.clock()
		task.spawn(function()
			local ok, err = pcall(window.Module.Refresh, window)
			if not ok then
				warn("[UI] refresh " .. id .. " failed: " .. tostring(err))
			end
		end)
	end
end

function App.Close()
	if openId and windows[openId] then
		windows[openId].Frame.Visible = false
	end
	openId = nil
end

function App.Toggle(id: string)
	if openId == id then
		App.Close()
	else
		App.Open(id)
	end
end

function App.IsOpen(id: string): boolean
	return openId == id
end

function App.Get(id: string)
	return windows[id]
end

-- Auto-refresh the open window.
function App.Tick()
	local window = openId and windows[openId]
	if window and window.Module.RefreshSeconds and os.clock() - window.LastRefresh >= window.Module.RefreshSeconds then
		App.RefreshWindow(window.Id)
	end
end

return App
