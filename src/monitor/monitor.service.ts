/** 普通事件接收服务：只生成内部信封并提交 Redis，不同步访问 MySQL。 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IngestionBuffer } from '../ingestion/ingestion-buffer.service';
import type { MonitorIngestPayload, MonitorRequestMeta } from './monitor.types';

/** 入口业务层只接收已校验事件，生成信封并等待 Redis 确认。 */
@Injectable()
export class MonitorService {
  constructor(private readonly buffer: IngestionBuffer) {}
  /** 为每次接收生成独立 UUID，展开事件信封后统一提交 Redis 缓冲。 */
  async receive(payload: MonitorIngestPayload, meta: MonitorRequestMeta): Promise<void> {
    const receivedAt = Date.now();
    await this.buffer.enqueue(payload.payloads.map(event => ({
      id: randomUUID(), receivedAt, kind: 'event', payload: event, meta,
    })));
  }
}
