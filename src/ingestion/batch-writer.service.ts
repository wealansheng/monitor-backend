/** 批次写入器：在消费者中投影字段、计算指纹并按表事务写入。 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { MonitorConfig, TableCategory } from '../config/config.types';
import { MONITOR_CONFIG } from '../config/config.constants';
import { buildEvent, EVENT_TABLE } from '../monitor/monitor.protocol';
import { prepareEventRows } from '../database/monitor.repository';
import { retentionCutoff } from '../database/retention';
import { ENTITY_NAMES } from '../database/v1-schema';
import { recordRow } from '../records/records.repository';
import type { BatchResult, BufferedMessage } from './ingestion.types';

/** 已完成字段投影的待写行，按物理表类别分组。 */
interface Row { category: TableCategory | 'record'; value: Record<string, unknown> }
/** 只有确定的数据类错误才拆分隔离；连接、事务等暂时性故障必须保留整批重试。 */
const DATA_ERRORS = new Set(['ER_BAD_NULL_ERROR','ER_DATA_TOO_LONG','ER_TRUNCATED_WRONG_VALUE',
  'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD','WARN_DATA_TRUNCATED','ER_WARN_DATA_OUT_OF_RANGE','ER_INVALID_JSON_TEXT','ER_NET_PACKET_TOO_LARGE']);
/** 只提取数据库错误码或错误类型，避免把 SQL、载荷和连接凭据写入日志。 */
export function databaseErrorCode(error: unknown): string {
  const value = error as { code?: string; driverError?: { code?: string } };
  return value?.driverError?.code || value?.code || (error instanceof Error ? error.name : 'UnknownError');
}

/** 消费者批量写入服务：转换失败按条隔离，暂时性数据库故障交给外层重试。 */
@Injectable()
export class BatchWriter {
  constructor(private readonly source: DataSource, @Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {}
  /** 逐条解析并丢弃过期或非法信封，将有效数据按目标表投影后批量提交。 */
  async write(serialized: string[]): Promise<BatchResult> {
    const result: BatchResult = { written: 0, invalid: 0, expired: 0 };
    const rows: Row[] = [];
    const cutoff = retentionCutoff(this.config.mysql.retentionDays);
    // 在消费阶段完成字段投影、指纹及有效期检查，HTTP 入口不承担这些入库工作。
    for (const text of serialized) {
      try {
        const message = JSON.parse(text) as BufferedMessage;
        if (!message || typeof message.id !== 'string' || !Number.isSafeInteger(message.receivedAt)) throw new Error('Invalid envelope');
        const timestamp = Number(message.kind === 'record' ? message.payload.started_at : message.payload.timestamp);
        if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new Error('Invalid timestamp');
        // 使用事件或录制的发生时间判断过期，缓冲停留时间不会延长数据保留期。
        if (timestamp < cutoff) { result.expired++; continue; }
        if (message.kind === 'record') {
          rows.push({ category: 'record', value: recordRow(message.payload) });
        } else if (message.kind === 'event') {
          const category = EVENT_TABLE[String(message.payload.event_type) as keyof typeof EVENT_TABLE];
          if (!['error','performance','behavior'].includes(category)) throw new Error('Invalid category');
          const projected = buildEvent(category, message.payload, message.meta);
          projected.received_at = new Date(message.receivedAt);
          // 恢复重试必须复用最初接收 UUID，防止提交后确认前崩溃造成重复计数。
          projected.ingest_id = message.id;
          rows.push({ category, value: prepareEventRows(category, [projected])[0] });
        } else throw new Error('Invalid kind');
      } catch { result.invalid++; }
    }
    result.written = await this.persist(rows);
    result.invalid += rows.length - result.written;
    return result;
  }

  /** 正常批次在一个事务中最多写四张表；确定的数据错误通过二分拆分隔离坏行。 */
  private async persist(rows: Row[]): Promise<number> {
    if (!rows.length) return 0;
    try {
      // 正常混合批次在一个事务内按四张表合并，每类只执行一条多值 INSERT。
      await this.source.transaction(async manager => {
        for (const category of ['performance','error','behavior','record'] as const) {
          const values = rows.filter(row => row.category === category).map(row => row.value);
          if (!values.length) continue;
          await manager.getRepository(ENTITY_NAMES[category]).createQueryBuilder().insert().values(values)
            // 重复键只把幂等键更新为自身；Replay 不覆盖载荷，不同变体另存留证。
            .orUpdate(category === 'record' ? ['variant_hash'] : ['ingest_id'],
              category === 'record' ? ['app_id','record_id','chunk_index','variant_hash'] : ['ingest_id','timestamp'])
            .execute();
        }
      });
      return rows.length;
    } catch (error) {
      // 事务已回滚：确定的数据错误再二分定位；无法恢复的单行计入丢弃，其余行继续提交。
      if (!DATA_ERRORS.has(databaseErrorCode(error))) throw error;
      if (rows.length === 1) return 0;
      const middle = Math.floor(rows.length/2);
      return await this.persist(rows.slice(0,middle)) + await this.persist(rows.slice(middle));
    }
  }
}

