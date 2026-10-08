--[[
	RateLimiter
	Token bucket per key. Used for every remote endpoint and for internal
	per-player limits (job actions, votes, discipline).
]]

local RateLimiter = {}
RateLimiter.__index = RateLimiter

-- rate: tokens refilled per second, burst: bucket size
function RateLimiter.new(rate: number, burst: number?)
	return setmetatable({
		Rate = rate,
		Burst = burst or math.max(1, math.ceil(rate)),
		_buckets = {},
	}, RateLimiter)
end

function RateLimiter:Check(key: any, cost: number?): boolean
	cost = cost or 1
	local now = os.clock()
	local bucket = self._buckets[key]
	if not bucket then
		bucket = { tokens = self.Burst, last = now }
		self._buckets[key] = bucket
	end
	bucket.tokens = math.min(self.Burst, bucket.tokens + (now - bucket.last) * self.Rate)
	bucket.last = now
	if bucket.tokens >= cost then
		bucket.tokens -= cost
		return true
	end
	return false
end

function RateLimiter:Reset(key: any)
	self._buckets[key] = nil
end

-- Remove all buckets whose key matches a predicate (e.g. a leaving player).
function RateLimiter:Purge(predicate: (any) -> boolean)
	for key in pairs(self._buckets) do
		if predicate(key) then
			self._buckets[key] = nil
		end
	end
end

return RateLimiter
