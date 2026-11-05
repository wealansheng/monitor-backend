/** Redis 缓冲访问层：封装容量限制、在途批次和消费指标。 */
import { Inject, Injectable, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import type { MonitorConfig } from '../config/config.types';
import { MONITOR_CONFIG } from '../config/config.constants';
import { ACK, CLAIM, ENQUEUE, FAIL, RENEW } from './buffer.scripts';
import { INGEST_REDIS } from './ingestion.types';
import type { BatchResult, BufferedMessage } from './ingestion.types';

/** 批次租约 30 秒；消费者每 10 秒续租，崩溃后由下一消费者恢复在途数据。 */
export const LEASE_MS = 30000;
/** 有界 Redis 缓冲门面：待处理与在途数据共同计入容量预算。 */
@Injectable()
export class IngestionBuffer {
  /** Lua 键顺序固定为待处理、在途、状态、指标、租约，均属于应用专用前缀。 */
  readonly keys: string[];
  constructor(@Inject(INGEST_REDIS) private readonly redis: Redis,
    @Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {
    this.keys = ['ready','inflight','state','stats','lease'].map(key => `${config.redis.prefix}:buffer:${key}`);
  }
  /** 以固定键顺序执行 Lua，将准入、字节统计与批次状态变更合为原子操作。 */
  private eval(script: string, ...args: (number | string)[]): Promise<unknown> {
    return this.redis.eval(script, this.keys.length, ...this.keys, ...args);
  }
  /** 先检查单请求预算，再由 Lua 淘汰最旧待处理数据并入队；Redis 失败返回 503。 */
  async enqueue(messages: BufferedMessage[]): Promise<void> {
    // 使用序列化后的 UTF-8 字节数核算，与 Lua string.len 的统计口径一致。
    const values = messages.map(value => JSON.stringify(value));
    if (values.length > this.config.ingestion.maxItems
      || values.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > this.config.ingestion.maxBytes) {
      throw new PayloadTooLargeException('Ingestion request exceeds buffer budget');
    }
    try {
      // Lua 返回负值区分请求自身超限与在途预算不足；后者不能通过淘汰在途数据解决。
      const result = Number(await this.eval(ENQUEUE, this.config.ingestion.maxItems, this.config.ingestion.maxBytes, ...values));
      if (result === -1) throw new PayloadTooLargeException('Ingestion request exceeds buffer budget');
      if (result < 0) throw new ServiceUnavailableException('Ingestion buffer is full');
    } catch (error) {
      if (error instanceof PayloadTooLargeException || error instanceof ServiceUnavailableException) throw error;
      // 隐藏 Redis 原始错误和认证信息，失败不回退为同步 MySQL 写入。
      throw new ServiceUnavailableException('Redis ingestion buffer unavailable');
    }
  }
  /** 领取有界批次并优先恢复在途数据；手动重试仅跳过退避时间，不绕过租约。 */
  async claim(owner: string, forceRetry = false): Promise<string[]> {
    return await this.eval(CLAIM, owner, this.config.ingestion.batchSize, this.config.ingestion.batchMaxBytes, LEASE_MS, forceRetry ? 1 : 0) as string[];
  }
  /** 仅当租约仍属于当前消费者时延长有效期，防止旧消费者占用新批次。 */
  async renew(owner: string): Promise<boolean> { return Number(await this.eval(RENEW, owner, LEASE_MS)) === 1; }
  /** 仅在 MySQL 提交成功后确认批次，校验所有者并扣除在途容量。 */
  async ack(owner: string, result: BatchResult): Promise<boolean> {
    return Number(await this.eval(ACK, owner, result.written, result.invalid, result.expired)) === 1;
  }
  /** 保留在途载荷，更新指数退避时间并释放租约，等待下次消费。 */
  async fail(owner: string): Promise<void> { await this.eval(FAIL, owner); }
  /** 读取积压、容量和累计指标；多次读取构成近似快照，不承诺跨键瞬时一致。 */
  async status(): Promise<Record<string, unknown>> {
    try {
      const [depth, active, state, counters, head, activeHead] = await Promise.all([
        this.redis.llen(this.keys[0]), this.redis.llen(this.keys[1]), this.redis.hgetall(this.keys[2]),
        this.redis.hgetall(this.keys[3]), this.redis.lindex(this.keys[0],0), this.redis.lindex(this.keys[1],0),
      ]);
      // 分别查看待处理及在途队首，估算整个缓冲最老消息的等待时长。
      const timestamps = [head, activeHead].filter((item): item is string => item !== null).map(item => {
        try { return Number((JSON.parse(item) as BufferedMessage).receivedAt); } catch { return Date.now(); }
      });
      return { depth, inflight: active, bytes: Number(state.bytes || 0),
        oldestAgeMs: timestamps.length ? Math.max(0, Date.now()-Math.min(...timestamps)) : 0,
        failures: Number(state.failures || 0), nextRetryAt: Number(state.nextRetryAt || 0),
        ...Object.fromEntries(['enqueued','written','droppedOverflow','droppedInvalid','droppedExpired','retries','lastFlushAt']
          .map(key => [key,Number(counters[key] || 0)])) };
    } catch { throw new ServiceUnavailableException('Redis ingestion buffer unavailable'); }
  }
}
