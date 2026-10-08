--[[
	Client scenario: boots the server AND the client UI in one process
	(client remotes are wired straight to the server handlers) and opens
	every window / triggers every effect, failing on any runtime error.
]]


local function cpart(name, position, tags, attrs)
	local p = Instance.new("Part")
	p.Name = name
	p.Position = position
	p.Size = Vector3.new(6, 4, 6)
	for key, value in pairs(attrs or {}) do
		p:SetAttribute(key, value)
	end
	p.Parent = workspace
	for _, tag in ipairs(tags) do
		p:AddTag(tag)
	end
	return p
end
local warehouse = cpart("Warehouse", Vector3.new(0, 2, 0), { "KingdomStorage" }, { StorageType = "Food,General,Ore,Armory" })
cpart("Market", Vector3.new(0, 2, 30), { "KingdomMarket" })
local desk = cpart("Desk", Vector3.new(30, 2, 0), { "KingdomAdminDesk" })
local trade = cpart("TradePost", Vector3.new(-30, 2, 0), { "KingdomTradePost" })
cpart("Room", Vector3.new(0, 2, -60), { "KingdomMeetingRoom" }, { MeetingID = "*" })

Mock.print("\n== Boot server + client")
Mock.boot()
Sched.run(2)
local alice = Mock.addPlayer(201, "Alice")
Mock.addPlayer(202, "Bob")
Mock.setLocalPlayer(alice)
Sched.run(3)
Mock.bootClient()
Sched.run(3)

local gui = alice.PlayerGui:FindFirstChild("KingdomUI")
check("ScreenGui created", gui ~= nil)
local panel = gui and gui:FindFirstChild("SidePanel")
check("side panel created", panel ~= nil)
local clock = panel and panel:FindFirstChild("Clock")
check("clock shows time", clock and string.find(clock.Text, "AM") ~= nil, clock and clock.Text)
local rankLabel = panel and panel:FindFirstChild("Rank")
check("rank shown", rankLabel and string.find(rankLabel.Text, "Peasant") ~= nil, rankLabel and rankLabel.Text)

Mock.print("\n== Windows")
local client = game:GetService("StarterPlayer").StarterPlayerScripts.Kingdom
local App = Mock.require(client.UI.App)
local errors = #Mock.Errors
local warnings = #Mock.Warnings
for _, name in ipairs({ "Queue", "Kingdom", "Meetings", "Inventory", "Orders", "Management", "Government", "Market", "Career", "Store", "Admin" }) do
	App.Open(name)
	Sched.run(1)
	App.Tick()
	Sched.run(6)
	local window = App.Get(name)
	check("window " .. name .. " opens", window and window.Frame.Visible and window.Built)
	App.Close()
end
local uiWarnings = 0
for index = warnings + 1, #Mock.Warnings do
	if string.find(Mock.Warnings[index], "%[UI%]") or string.find(Mock.Warnings[index], "KingdomClient") then
		uiWarnings += 1
		Mock.print("    " .. Mock.Warnings[index])
	end
end
check("no window build/refresh failures", uiWarnings == 0, uiWarnings)
check("no runtime errors in windows", #Mock.Errors == errors, #Mock.Errors - errors)

Mock.print("\n== Effects")
-- Promotion via XP (server decides; the client shows the fanfare).
local ClientNet = Mock.require(client.Controllers.ClientNet)
local ok, message = ClientNet.Action("Admin", "Run", { command = "givexp me 300" })
check("client admin command", ok, message)
Sched.run(5)
check("promotion reached client state", alice:GetAttribute("KingdomRank") == "Worker", alice:GetAttribute("KingdomRank"))

-- Storage popup through the real prompt flow.
Mock.moveTo(alice, warehouse.Position + Vector3.new(0, 3, 0))
Sched.run(1)
Mock.firePrompt(Mock.findPrompt(warehouse, "Withdraw"), alice, 0)
Sched.run(1)
local storageWindow = App.Get("Storage")
check("storage popup opened", storageWindow and storageWindow.Frame.Visible)
App.Close()

-- Ledger quiz end-to-end: answer via the UI buttons.
Mock.moveTo(alice, desk.Position + Vector3.new(0, 3, 0))
Sched.run(6)
Mock.firePrompt(Mock.findPrompt(desk, "ledgers"), alice, 1.2)
Sched.run(0.5)
local quiz = gui.Overlay:FindFirstChild("Quiz")
-- Clerk work needs Job.Administration (Guard+), Alice is a Worker: refused.
check("quiz refused below rank", quiz == nil)

-- Trade ledger popup.
Mock.moveTo(alice, trade.Position + Vector3.new(0, 3, 0))
Sched.run(6)
Mock.firePrompt(Mock.findPrompt(trade, "caravan"), alice, 0.6)
Sched.run(0.5)
check("trade popup opened", App.Get("Trade").Frame.Visible)
App.Close()

-- Death screen.
ok, message = ClientNet.Action("Admin", "Run", { command = "kill me" })
Sched.run(1)
local deathScreen = gui.Overlay:FindFirstChild("DeathScreen")
check("death screen shown", deathScreen ~= nil)
Sched.run(30)
check("death screen cleared after respawn", gui.Overlay:FindFirstChild("DeathScreen") == nil)
check("rank shown as Peasant after death", string.find(panel.Rank.Text, "Peasant") ~= nil, panel.Rank.Text)

-- Lighting follows the clock.
local Lighting = game:GetService("Lighting")
Mock.require(client.Controllers.LightingController).Update()
check("lighting ClockTime follows kingdom clock", type(Lighting.ClockTime) == "number" and Lighting.ClockTime >= 7 and Lighting.ClockTime <= 22, Lighting.ClockTime)

-- Notifications render (server messages arrive as toasts / banners).
Mock.require(client.UI.Notifications).Show({ Kind = "Success", Title = "Test", Text = "Hello", Chat = true })
Mock.require(client.UI.Notifications).Show({ Kind = "Critical", Title = "Banner", Text = "Kingdom notice", Banner = true })
Sched.run(0.1)
local toasts = gui.Overlay:FindFirstChild("Toasts")
local banners = gui.Overlay:FindFirstChild("Banners")
check("toasts rendered", toasts ~= nil and #toasts:GetChildren() > 1)
check("banners rendered", banners ~= nil and #banners:GetChildren() > 1)

finish("Client scenario")
