/**
 * 应用缓冲专用 Lua 脚本：原子执行准入、淘汰、领取、续租与确认。
 * 所有脚本的 KEYS 顺序固定为：待处理 List、在途 List、状态 Hash、指标 Hash、租约键。
 * 这里只操作应用自有键，禁止裁剪或修改 Bull 的内部队列键。
 */

/** ARGV 依次为总条数上限、总字节上限、一个或多个序列化信封；负返回值表示拒绝。 */
export const ENQUEUE = `
-- 先计算整个请求的序列化字节数，单个请求自身超预算返回 -1。
local maxItems, maxBytes = tonumber(ARGV[1]), tonumber(ARGV[2])
local count, addedBytes = #ARGV - 2, 0
for i=3,#ARGV do addedBytes = addedBytes + string.len(ARGV[i]) end
if count > maxItems or addedBytes > maxBytes then return -1 end
-- 在途批次不能被淘汰；即使清空待处理仍容不下新请求时直接返回 -2。
local activeCount = redis.call('LLEN', KEYS[2])
local activeBytes = tonumber(redis.call('HGET', KEYS[3], 'inflightBytes') or '0')
if activeCount + count > maxItems or activeBytes + addedBytes > maxBytes then return -2 end
local bytes = tonumber(redis.call('HGET', KEYS[3], 'bytes') or '0')
local size = redis.call('LLEN', KEYS[1]) + activeCount
-- 只从待处理队首淘汰最旧项，同时扣减总字节并累计过载丢弃数量。
while size + count > maxItems or bytes + addedBytes > maxBytes do
  local old = redis.call('LPOP', KEYS[1])
  if not old then return -2 end
  bytes = bytes - string.len(old)
  size = size - 1
  redis.call('HSET', KEYS[3], 'bytes', bytes)
  redis.call('HINCRBY', KEYS[4], 'droppedOverflow', 1)
end
-- 分组 RPUSH 避免 unpack 参数过多；写入错误时只回滚本请求刚追加的元素。
-- 此前已执行的过载淘汰仍计入指标，Lua 脚本的运行时错误本身没有事务回滚能力。
local pushed = 0
for start=3,#ARGV,500 do
  local last = math.min(start+499,#ARGV)
  local result = redis.pcall('RPUSH', KEYS[1], unpack(ARGV,start,last))
  if type(result) == 'table' and result.err then
    for i=1,pushed do redis.call('RPOP', KEYS[1]) end
    return -2
  end
  pushed = pushed + last-start+1
end
-- 全部追加成功后才计入新消息预算与接收数量。
redis.call('HSET', KEYS[3], 'bytes', bytes+addedBytes)
redis.call('HINCRBY', KEYS[4], 'enqueued', count)
return count
`;

/** 使用 Redis 服务端时钟计算毫秒时间，避免多个消费者的本机时钟差异影响退避。 */
const clock = `local t = redis.call('TIME'); local now = tonumber(t[1])*1000 + math.floor(tonumber(t[2])/1000)`;

/** ARGV 为所有者标识、批次条数、目标字节数、租约毫秒数、手动重试标志；返回领取信封。 */
export const CLAIM = `
${clock}
-- 活跃租约始终优先；手动请求只能跳过失败退避，不能抢占其他消费者。
if redis.call('EXISTS', KEYS[5]) == 1 then return {} end
if ARGV[5] ~= '1' and tonumber(redis.call('HGET', KEYS[3], 'nextRetryAt') or '0') > now then return {} end
-- 旧消费者崩溃留下的在途数据优先恢复，不从待处理区另取一批。
if redis.call('LLEN', KEYS[2]) > 0 then
  redis.call('SET', KEYS[5], ARGV[1], 'PX', ARGV[4])
  return redis.call('LRANGE', KEYS[2], 0, -1)
end
local result, bytes = {}, 0
for i=1,tonumber(ARGV[2]) do
  local item = redis.call('LINDEX', KEYS[1], 0)
  if not item then break end
  -- 第一项可独自超过批次目标字节数，防止合法大元素永久停留在队首。
  if i > 1 and bytes + string.len(item) > tonumber(ARGV[3]) then break end
  -- 先写入在途再弹出待处理，写入失败时原始载荷仍在待处理队列。
  redis.call('RPUSH', KEYS[2], item)
  redis.call('LPOP', KEYS[1])
  bytes = bytes + string.len(item)
  redis.call('HSET', KEYS[3], 'inflightBytes', bytes)
  table.insert(result,item)
end
-- 转移不改变总字节预算；有实际批次才设置所有者租约。
if #result > 0 then redis.call('SET', KEYS[5], ARGV[1], 'PX', ARGV[4]) end
return result
`;

/** ARGV 为所有者标识与租约毫秒数；只有当前所有者可以续租。 */
export const RENEW = `
-- 租约已过期或被其他消费者接管时返回失败，不影响新消费者。
if redis.call('GET', KEYS[5]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[5], ARGV[2])
return 1
`;

/** ARGV 为所有者标识、有效处理量、非法丢弃量、过期丢弃量；仅在 SQL 提交后调用。 */
export const ACK = `
${clock}
-- 确认必须匹配仍有效的所有者，过期消费者不能删除被接管的在途批次。
if redis.call('GET', KEYS[5]) ~= ARGV[1] then return 0 end
local bytes = tonumber(redis.call('HGET', KEYS[3], 'inflightBytes') or '0')
-- 释放整个在途批次预算，清空连续失败和退避状态。
redis.call('HINCRBY', KEYS[3], 'bytes', -bytes)
redis.call('HSET', KEYS[3], 'inflightBytes', 0, 'failures', 0, 'nextRetryAt', 0)
redis.call('DEL', KEYS[2], KEYS[5])
-- 成功确认后统一累计处理指标，written 包括执行成功的幂等重试。
redis.call('HINCRBY', KEYS[4], 'written', ARGV[2])
redis.call('HINCRBY', KEYS[4], 'droppedInvalid', ARGV[3])
redis.call('HINCRBY', KEYS[4], 'droppedExpired', ARGV[4])
redis.call('HSET', KEYS[4], 'lastFlushAt', now)
return 1
`;

/** ARGV 为所有者标识；失败只释放租约并记录退避，不删除在途载荷。 */
export const FAIL = `
${clock}
if redis.call('GET', KEYS[5]) ~= ARGV[1] then return 0 end
-- 连续失败按 1、2、4、8、16、30 秒退避，最长等待 30 秒。
local failures = redis.call('HINCRBY', KEYS[3], 'failures', 1)
local delay = math.min(30000,1000*math.pow(2,math.min(failures-1,5)))
redis.call('HSET', KEYS[3], 'nextRetryAt', now+delay)
redis.call('HINCRBY', KEYS[4], 'retries', 1)
redis.call('DEL', KEYS[5])
return 1
`;
