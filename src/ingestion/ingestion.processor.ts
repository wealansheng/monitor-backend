/** Bull 与手动刷新共用的消费者：在全局租约下批量写入，失败后保留数据重试。 */
import { Process, Processor } from '@nestjs/bull';
import { BeforeApplicationShutdown, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { IngestionBuffer } from './ingestion-buffer.service';
import { BatchWriter, databaseErrorCode } from './batch-writer.service';
import { INGEST_QUEUE } from './ingestion.types';
import type { FlushResult } from './ingestion.types';

/** 合并同实例触发；跨实例并发由 Redis 批次租约约束。 */
@Processor(INGEST_QUEUE)
export class IngestionProcessor implements BeforeApplicationShutdown {
  private readonly logger = new Logger(IngestionProcessor.name);
  private stopping = false;
  private running?: Promise<FlushResult>;

  constructor(private readonly buffer: IngestionBuffer, private readonly writer: BatchWriter) {}

  /** Bull 定时消费保留原有退避策略，失败指标和在途数据等待下一轮重试。 */
  @Process({ name: 'flush', concurrency: 1 })
  async flush(): Promise<void> {
    await this.run(false);
  }

  /** 手动触发新的消费时跳过失败退避时间，但不抢占其他实例的有效租约。 */
  flushNow(): Promise<FlushResult> {
    return this.run(true);
  }

  /** 共享进行中的任务，避免 HTTP、Bull 或多个手动请求在同实例并发消费。 */
  private run(forceRetry: boolean): Promise<FlushResult> {
    if (this.stopping) {
      return Promise.resolve({ batches: 0, written: 0, invalid: 0, expired: 0, failed: false });
    }
    if (this.running) return this.running;
    this.running = this.drain(forceRetry).finally(() => { this.running = undefined; });
    return this.running;
  }

  /** 循环领取、续租和提交；仅累计已成功确认的批次，不隐瞒数据库写入失败。 */
  private async drain(forceRetry: boolean): Promise<FlushResult> {
    const totals: FlushResult = { batches: 0, written: 0, invalid: 0, expired: 0, failed: false };
    while (!this.stopping) {
      const owner = randomUUID();
      const items = await this.buffer.claim(owner, forceRetry);
      if (!items.length) return totals;
      let lost = false;

      // 续租失败即视为所有权丢失，旧消费者不得确认被其他实例接管的批次。
      const heartbeat = setInterval(() => {
        void this.buffer.renew(owner).then(ok => { if (!ok) lost = true; }).catch(() => { lost = true; });
      }, 10000);
      heartbeat.unref();
      try {
        const result = await this.writer.write(items);
        // SQL 成功后仍需校验确认结果；租约丢失或确认失败时不累计本次确认量。
        if (lost || !await this.buffer.ack(owner, result)) return totals;
        totals.batches++;
        totals.written += result.written;
        totals.invalid += result.invalid;
        totals.expired += result.expired;
        if (result.invalid) this.logger.warn(`Discarded ${result.invalid} invalid buffered messages`);
      } catch (error) {
        // 不记录 SQL、载荷或连接密码；后台继续保留重试，手动接口可根据 failed 返回 503。
        this.logger.error(`Ingestion batch retained for retry: ${databaseErrorCode(error)}`);
        await this.buffer.fail(owner).catch(() => undefined);
        totals.failed = true;
        return totals;
      } finally {
        clearInterval(heartbeat);
      }
      // 连续处理多个批次时让出事件循环，降低对采集与查询请求的影响。
      await yieldLoop();
    }
    return totals;
  }

  /** 停止领取新批次，等待当前任务结束；未确认数据保留在 Redis 中供恢复。 */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.running;
  }
}
