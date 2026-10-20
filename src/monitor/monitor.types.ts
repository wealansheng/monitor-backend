import { TableCategory } from '../config/config.types';

/** 上报协议中允许的六类事件。 */
export type EventType =
  | 'performance'
  | 'request'
  | 'resource'
  | 'error'
  | 'stability'
  | 'behavior';

/** 展开信封与字段别名之后的事件负载。 */
export type MonitorEventPayload = Record<string, unknown>;

/** 校验并解析完成的上报请求。 */
export interface MonitorIngestPayload {
  /** 是否来自 `events` 批量信封。 */
  isBatch: boolean;
  payloads: MonitorEventPayload[];
  /** 原始请求体字节数，用于响应回执。 */
  bytes: number;
}

/** 与请求相关、用于补充事件行的元信息。 */
export interface MonitorRequestMeta {
  ip: string;
  userAgent: string;
}

/** 单事件上报的回执。 */
export interface SingleEventReceipt {
  eventId: string;
  eventType: string;
  bytes: number;
}

/** 批量上报的回执。 */
export interface BatchEventReceipt {
  eventIds: string[];
  eventCount: number;
  bytes: number;
}

export type MonitorReceipt = SingleEventReceipt | BatchEventReceipt;

/** 事件类型到目标表的映射类型。 */
export type EventTableMap = Record<EventType, TableCategory>;
