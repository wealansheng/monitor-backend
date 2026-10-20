import { Injectable } from '@nestjs/common';

import { TableCategory } from '../config/config.types';
import { MonitorRepository } from '../database/monitor.repository';
import { buildEvent, EVENT_TABLE } from './monitor.protocol';
import {
  EventType,
  MonitorIngestPayload,
  MonitorReceipt,
  MonitorRequestMeta,
} from './monitor.types';

/**
 * 上报业务逻辑：把已校验的事件负载投影成行、按目标表分组并写入 ClickHouse。
 *
 * 输入已经由 `MonitorIngestPipe` 完成解析与字段校验，因此这里只做映射与持久化，
 * 是同类型事件合并为一次写入的唯一点。
 */
@Injectable()
export class MonitorService {
  constructor(private readonly repository: MonitorRepository) {}

  async receive(payload: MonitorIngestPayload, meta: MonitorRequestMeta): Promise<MonitorReceipt> {
    const groupedEvents = new Map<TableCategory, Record<string, unknown>[]>();

    const events = payload.payloads.map((event) => {
      // event_type 已由 MonitorIngestPipe 校验为六种合法取值之一。
      const tableCategory = EVENT_TABLE[event.event_type as EventType];
      const row = buildEvent(tableCategory, event, meta);

      const tableEvents = groupedEvents.get(tableCategory) ?? [];
      tableEvents.push(row);
      groupedEvents.set(tableCategory, tableEvents);
      return row;
    });

    for (const [tableCategory, tableEvents] of groupedEvents) {
      await this.repository.insertMany(tableCategory, tableEvents);
    }

    if (!payload.isBatch) {
      const [first] = events;
      return {
        eventId: String(first.event_id),
        eventType: String(first.event_type),
        bytes: payload.bytes,
      };
    }

    return {
      eventIds: events.map((event) => String(event.event_id)),
      eventCount: events.length,
      bytes: payload.bytes,
    };
  }
}
