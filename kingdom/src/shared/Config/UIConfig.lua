--[[
	UIConfig
	Medieval theme: wood, stone, iron, parchment and wax seals, kept readable.
	Set texture ids (rbxassetid://...) to use your own art; empty strings use
	the built-in gradient/stroke styling.
]]

local UIConfig = {}

UIConfig.Fonts = {
	Title = Enum.Font.GrenzeGotisch,
	Heading = Enum.Font.Fondamento,
	Body = Enum.Font.Merriweather,
	Numbers = Enum.Font.Merriweather,
}

UIConfig.Colors = {
	Wood = Color3.fromRGB(74, 50, 32),
	WoodLight = Color3.fromRGB(110, 76, 48),
	WoodDark = Color3.fromRGB(44, 29, 19),
	Stone = Color3.fromRGB(88, 86, 82),
	StoneDark = Color3.fromRGB(52, 50, 48),
	Iron = Color3.fromRGB(140, 140, 146),
	IronDark = Color3.fromRGB(70, 70, 76),
	Parchment = Color3.fromRGB(236, 220, 186),
	ParchmentDark = Color3.fromRGB(205, 184, 142),
	Ink = Color3.fromRGB(46, 32, 22),
	InkFaded = Color3.fromRGB(100, 80, 60),
	Wax = Color3.fromRGB(150, 28, 32),
	Gold = Color3.fromRGB(214, 172, 66),
	TextLight = Color3.fromRGB(245, 234, 210),
	Good = Color3.fromRGB(86, 140, 70),
	Warn = Color3.fromRGB(196, 140, 40),
	Bad = Color3.fromRGB(170, 50, 40),
	Info = Color3.fromRGB(80, 110, 150),
}

UIConfig.NotificationColors = {
	Information = "Info",
	Success = "Good",
	Warning = "Warn",
	Critical = "Bad",
	Government = "Gold",
	Promotion = "Gold",
	Job = "WoodLight",
	Economy = "Gold",
	Meeting = "Info",
	Death = "Bad",
}

UIConfig.Textures = {
	Parchment = "",
	Wood = "",
	Stone = "",
	WaxSeal = "",
}

UIConfig.Sounds = {
	Promotion = "", -- rbxassetid of a fanfare
	Notification = "",
	Death = "",
	Bell = "", -- meeting bell
}

UIConfig.SidePanelWidth = 250
UIConfig.ToastSeconds = 5
UIConfig.MaxToasts = 5

return UIConfig
