--[[
	Kit
	Medieval UI building blocks: wood frames, parchment panels, stone, iron
	borders, wax-seal buttons. Modern enough to stay readable (clear fonts,
	contrast, scaling) without looking like a phone settings app.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local UIConfig = require(ReplicatedStorage.Kingdom.Config.UIConfig)

local Kit = {}

local C = UIConfig.Colors
Kit.Colors = C
Kit.Fonts = UIConfig.Fonts

-- Generic constructor: Kit.new("Frame", { Size = ... }, { children })
function Kit.new(className: string, props: { [string]: any }?, children: { Instance }?): any
	local instance = Instance.new(className)
	local parent
	for key, value in pairs(props or {}) do
		if key == "Parent" then
			parent = value
		else
			(instance :: any)[key] = value
		end
	end
	for _, child in ipairs(children or {}) do
		child.Parent = instance
	end
	if parent then
		instance.Parent = parent
	end
	return instance
end

local function corner(parent: Instance, radius: number?)
	Kit.new("UICorner", { CornerRadius = UDim.new(0, radius or 4), Parent = parent })
end

local function stroke(parent: Instance, color: Color3, thickness: number?)
	Kit.new("UIStroke", {
		Color = color,
		Thickness = thickness or 2,
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
		Parent = parent,
	})
end

local function gradient(parent: Instance, a: Color3, b: Color3, rotation: number?)
	Kit.new("UIGradient", {
		Color = ColorSequence.new(a, b),
		Rotation = rotation or 90,
		Parent = parent,
	})
end

function Kit.padding(parent: Instance, pixels: number)
	Kit.new("UIPadding", {
		PaddingTop = UDim.new(0, pixels),
		PaddingBottom = UDim.new(0, pixels),
		PaddingLeft = UDim.new(0, pixels),
		PaddingRight = UDim.new(0, pixels),
		Parent = parent,
	})
end

function Kit.list(parent: Instance, spacing: number?, horizontal: boolean?)
	return Kit.new("UIListLayout", {
		Padding = UDim.new(0, spacing or 4),
		FillDirection = horizontal and Enum.FillDirection.Horizontal or Enum.FillDirection.Vertical,
		SortOrder = Enum.SortOrder.LayoutOrder,
		VerticalAlignment = horizontal and Enum.VerticalAlignment.Center or Enum.VerticalAlignment.Top,
		Parent = parent,
	})
end

-- Styles: Parchment (content), Wood (frames/buttons), Stone (status), Iron
function Kit.style(frame: GuiObject, style: string)
	if style == "Wood" then
		frame.BackgroundColor3 = C.Wood
		gradient(frame, C.WoodLight, C.WoodDark, 90)
		stroke(frame, C.IronDark, 2)
	elseif style == "Stone" then
		frame.BackgroundColor3 = C.Stone
		gradient(frame, C.Stone, C.StoneDark, 90)
		stroke(frame, C.IronDark, 2)
	elseif style == "Iron" then
		frame.BackgroundColor3 = C.Iron
		gradient(frame, C.Iron, C.IronDark, 90)
		stroke(frame, C.StoneDark, 1)
	else
		frame.BackgroundColor3 = C.Parchment
		gradient(frame, C.Parchment, C.ParchmentDark, 90)
		stroke(frame, C.WoodDark, 2)
		local texture = UIConfig.Textures.Parchment
		if texture ~= "" then
			Kit.new("ImageLabel", {
				Name = "Texture",
				BackgroundTransparency = 1,
				Size = UDim2.fromScale(1, 1),
				Image = texture,
				ScaleType = Enum.ScaleType.Tile,
				TileSize = UDim2.fromOffset(128, 128),
				ImageTransparency = 0.6,
				ZIndex = frame.ZIndex,
				Parent = frame,
			})
		end
	end
	corner(frame, 4)
end

function Kit.Panel(props)
	local frame = Kit.new("Frame", {
		Name = props.Name or "Panel",
		Size = props.Size or UDim2.fromOffset(200, 100),
		Position = props.Position or UDim2.new(),
		AnchorPoint = props.AnchorPoint or Vector2.zero,
		AutomaticSize = props.AutomaticSize or Enum.AutomaticSize.None,
		LayoutOrder = props.LayoutOrder or 0,
		BorderSizePixel = 0,
		Visible = props.Visible ~= false,
		Parent = props.Parent,
	})
	Kit.style(frame, props.Style or "Parchment")
	if props.Padding ~= false then
		Kit.padding(frame, props.Padding or 8)
	end
	return frame
end

function Kit.Text(props)
	local style = props.Style
	local light = style == "Light"
	local label = Kit.new("TextLabel", {
		Name = props.Name or "Text",
		BackgroundTransparency = 1,
		Text = props.Text or "",
		Font = props.Font or (style == "Title" and UIConfig.Fonts.Title or style == "Heading" and UIConfig.Fonts.Heading or UIConfig.Fonts.Body),
		TextSize = props.TextSize or (style == "Title" and 28 or style == "Heading" and 20 or 15),
		TextColor3 = props.Color or (light and C.TextLight or C.Ink),
		TextXAlignment = props.Align or Enum.TextXAlignment.Left,
		TextYAlignment = props.AlignY or Enum.TextYAlignment.Center,
		TextWrapped = props.Wrap ~= false,
		RichText = props.Rich == true,
		Size = props.Size or UDim2.new(1, 0, 0, (props.TextSize or 15) + 6),
		AutomaticSize = props.AutomaticSize or Enum.AutomaticSize.None,
		LayoutOrder = props.LayoutOrder or 0,
		Position = props.Position or UDim2.new(),
		AnchorPoint = props.AnchorPoint or Vector2.zero,
		TextTransparency = props.Transparency or 0,
		Parent = props.Parent,
	})
	if light then
		label.TextStrokeTransparency = 0.6
	end
	return label
end

function Kit.Button(props)
	local button = Kit.new("TextButton", {
		Name = props.Name or "Button",
		Text = props.Text or "",
		Font = UIConfig.Fonts.Heading,
		TextSize = props.TextSize or 16,
		TextColor3 = props.TextColor or C.Gold,
		AutoButtonColor = false,
		Size = props.Size or UDim2.fromOffset(120, 32),
		Position = props.Position or UDim2.new(),
		AnchorPoint = props.AnchorPoint or Vector2.zero,
		LayoutOrder = props.LayoutOrder or 0,
		BorderSizePixel = 0,
		Parent = props.Parent,
	})
	Kit.style(button, props.Style or "Wood")
	if props.Danger then
		button.TextColor3 = C.TextLight
		button.BackgroundColor3 = C.Wax
		local grad = button:FindFirstChildOfClass("UIGradient")
		if grad then
			grad.Color = ColorSequence.new(C.Wax, Color3.fromRGB(100, 20, 22))
		end
	end
	local scale = Kit.new("UIScale", { Parent = button })
	button.MouseEnter:Connect(function()
		TweenService:Create(scale, TweenInfo.new(0.1), { Scale = 1.04 }):Play()
	end)
	button.MouseLeave:Connect(function()
		TweenService:Create(scale, TweenInfo.new(0.1), { Scale = 1 }):Play()
	end)
	if props.OnClick then
		button.Activated:Connect(function()
			props.OnClick(button)
		end)
	end
	return button
end

-- Wax seal (round) button, used for close.
function Kit.Seal(props)
	local seal = Kit.new("TextButton", {
		Name = props.Name or "Seal",
		Text = props.Text or "✕",
		Font = UIConfig.Fonts.Heading,
		TextSize = 18,
		TextColor3 = C.TextLight,
		BackgroundColor3 = C.Wax,
		AutoButtonColor = true,
		Size = UDim2.fromOffset(32, 32),
		Position = props.Position or UDim2.new(1, -6, 0, 6),
		AnchorPoint = props.AnchorPoint or Vector2.new(1, 0),
		Parent = props.Parent,
	})
	Kit.new("UICorner", { CornerRadius = UDim.new(1, 0), Parent = seal })
	stroke(seal, Color3.fromRGB(90, 15, 18), 2)
	if props.OnClick then
		seal.Activated:Connect(props.OnClick)
	end
	return seal
end

-- Progress bar. Returns frame with :Set(fraction, text?, color?)
function Kit.Bar(props)
	local frame = Kit.new("Frame", {
		Name = props.Name or "Bar",
		Size = props.Size or UDim2.new(1, 0, 0, 14),
		BackgroundColor3 = C.StoneDark,
		BorderSizePixel = 0,
		LayoutOrder = props.LayoutOrder or 0,
		Parent = props.Parent,
	})
	corner(frame, 3)
	stroke(frame, C.IronDark, 1)
	local fill = Kit.new("Frame", {
		Name = "Fill",
		Size = UDim2.fromScale(0, 1),
		BackgroundColor3 = props.Color or C.Good,
		BorderSizePixel = 0,
		Parent = frame,
	})
	corner(fill, 3)
	local label = Kit.new("TextLabel", {
		Name = "Label",
		BackgroundTransparency = 1,
		Size = UDim2.fromScale(1, 1),
		Font = UIConfig.Fonts.Numbers,
		TextSize = 11,
		TextColor3 = C.TextLight,
		TextStrokeTransparency = 0.5,
		Text = "",
		ZIndex = 2,
		Parent = frame,
	})
	local api = {}
	function api.Set(_, fraction: number, text: string?, color: Color3?)
		fraction = math.clamp(fraction or 0, 0, 1)
		TweenService:Create(fill, TweenInfo.new(0.3), { Size = UDim2.fromScale(fraction, 1) }):Play()
		if color then
			fill.BackgroundColor3 = color
		end
		label.Text = text or ""
	end
	api.Frame = frame
	if props.Value then
		api:Set(props.Value, props.Label)
	end
	return api
end

function Kit.Scroll(props)
	local scroll = Kit.new("ScrollingFrame", {
		Name = props.Name or "Scroll",
		Size = props.Size or UDim2.fromScale(1, 1),
		Position = props.Position or UDim2.new(),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		ScrollBarThickness = 6,
		ScrollBarImageColor3 = C.WoodDark,
		CanvasSize = UDim2.new(),
		AutomaticCanvasSize = Enum.AutomaticSize.Y,
		ScrollingDirection = Enum.ScrollingDirection.Y,
		LayoutOrder = props.LayoutOrder or 0,
		Parent = props.Parent,
	})
	Kit.list(scroll, props.Spacing or 4)
	Kit.new("UIPadding", { PaddingRight = UDim.new(0, 8), Parent = scroll })
	return scroll
end

function Kit.Row(props)
	local row = Kit.new("Frame", {
		Name = props.Name or "Row",
		Size = props.Size or UDim2.new(1, 0, 0, props.Height or 30),
		BackgroundTransparency = props.Background and 0 or 1,
		BackgroundColor3 = props.Background or C.ParchmentDark,
		BorderSizePixel = 0,
		LayoutOrder = props.LayoutOrder or 0,
		AutomaticSize = props.AutomaticSize or Enum.AutomaticSize.None,
		Parent = props.Parent,
	})
	if props.Background then
		corner(row, 3)
	end
	Kit.list(row, props.Spacing or 6, true)
	return row
end

function Kit.Input(props)
	local box = Kit.new("TextBox", {
		Name = props.Name or "Input",
		PlaceholderText = props.Placeholder or "",
		Text = props.Text or "",
		ClearTextOnFocus = false,
		Font = UIConfig.Fonts.Body,
		TextSize = 14,
		TextColor3 = C.Ink,
		PlaceholderColor3 = C.InkFaded,
		BackgroundColor3 = Color3.fromRGB(248, 238, 214),
		Size = props.Size or UDim2.fromOffset(160, 30),
		LayoutOrder = props.LayoutOrder or 0,
		TextXAlignment = Enum.TextXAlignment.Left,
		Parent = props.Parent,
	})
	corner(box, 3)
	stroke(box, C.WoodDark, 1)
	Kit.new("UIPadding", { PaddingLeft = UDim.new(0, 6), Parent = box })
	return box
end

-- Click to cycle through options. Returns button with :Get().
function Kit.Cycle(props)
	local options = props.Options
	local index = math.max(1, table.find(options, props.Value) or 1)
	local api = {}
	local button = Kit.Button({
		Text = (props.Prefix or "") .. tostring(options[index]),
		Size = props.Size or UDim2.fromOffset(150, 30),
		LayoutOrder = props.LayoutOrder,
		Parent = props.Parent,
		TextSize = 14,
		OnClick = function(self)
			index = index % #options + 1
			self.Text = (props.Prefix or "") .. tostring(options[index])
			if props.OnChange then
				props.OnChange(options[index])
			end
		end,
	})
	function api.Get()
		return options[index]
	end
	api.Button = button
	return api
end

-- Removes everything except layout objects.
function Kit.clear(container: Instance)
	for _, child in ipairs(container:GetChildren()) do
		if not child:IsA("UIListLayout") and not child:IsA("UIPadding") and not child:IsA("UIGridLayout") then
			child:Destroy()
		end
	end
end

function Kit.percentColor(fraction: number): Color3
	if fraction >= 0.7 then
		return C.Good
	elseif fraction >= 0.4 then
		return C.Warn
	end
	return C.Bad
end

return Kit
