--[[
	Format
	Display helpers shared by server announcements and the client UI.
]]

local Format = {}

function Format.number(n): string
	n = math.floor((n or 0) + 0.5)
	local negative = n < 0
	local text = tostring(math.abs(n))
	local formatted = text:reverse():gsub("(%d%d%d)", "%1,"):reverse()
	if formatted:sub(1, 1) == "," then
		formatted = formatted:sub(2)
	end
	return (negative and "-" or "") .. formatted
end

function Format.duration(seconds): string
	seconds = math.max(0, math.floor(seconds or 0))
	local hours = seconds // 3600
	local minutes = (seconds % 3600) // 60
	if hours > 0 then
		return string.format("%dh %dm", hours, minutes)
	elseif minutes > 0 then
		return string.format("%dm %ds", minutes, seconds % 60)
	end
	return string.format("%ds", seconds)
end

-- 0..1 -> "████████░░"
function Format.bar(fraction, width): string
	width = width or 10
	local filled = math.clamp(math.floor((fraction or 0) * width + 0.5), 0, width)
	return string.rep("█", filled) .. string.rep("░", width - filled)
end

function Format.percent(fraction): string
	return string.format("%d%%", math.floor(math.clamp(fraction or 0, 0, 10) * 100 + 0.5))
end

-- Decimal in-game hour -> "8:42 AM"
function Format.clock(hour): string
	hour = hour or 0
	local totalMinutes = math.floor(hour * 60 + 1e-6)
	local h = (totalMinutes // 60) % 24
	local m = totalMinutes % 60
	local suffix = h >= 12 and "PM" or "AM"
	local displayHour = h % 12
	if displayHour == 0 then
		displayHour = 12
	end
	return string.format("%d:%02d %s", displayHour, m, suffix)
end

function Format.ordinal(n: number): string
	local suffix = "th"
	local lastTwo = n % 100
	if lastTwo < 11 or lastTwo > 13 then
		local last = n % 10
		if last == 1 then
			suffix = "st"
		elseif last == 2 then
			suffix = "nd"
		elseif last == 3 then
			suffix = "rd"
		end
	end
	return tostring(n) .. suffix
end

return Format
