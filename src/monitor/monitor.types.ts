/** SDK 上报协议使用的事件、请求元数据与校验结果类型。 */
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
  /** 校验时记录的原始请求体字节数。 */
  bytes: number;
}

/** 与请求相关、用于补充事件行的元信息。 */
export interface MonitorRequestMeta {
  ip: string;
  userAgent: string;
}

/** 事件类型到目标表的映射类型。 */
export type EventTableMap = Record<EventType, TableCategory>;
