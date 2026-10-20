import { BadRequestException } from '@nestjs/common';

import { TableCategory } from '../config/config.types';
import {
  EventTableMap,
  EventType,
  MonitorEventPayload,
  MonitorRequestMeta,
} from './monitor.types';

/**
 * 上报协议适配层。
 *
 * 这里只做“协议形状”的归一化（JSON 解析、信封展开、别名映射、数值字段强制转换）
 * 与事件行的构造；字段合法性校验由 `MonitorEventDto` + `MonitorIngestPipe` 负责。
 */

/** event_type 到目标表的映射。 */
export const EVENT_TABLE: EventTableMap = {
  performance: 'performance',
  request: 'performance',
  resource: 'performance',
  error: 'error',
  stability: 'error',
  behavior: 'behavior',
};

/** 合法的事件类型，顺序用于错误提示。 */
export const EVENT_TYPES = Object.keys(EVENT_TABLE) as EventType[];

/** 三张表共有的字段。 */
const COMMON_FIELDS = [
  'app_id',
  'project_name',
  'release',
  'environment',
  'user_id',
  'session_id',
  'page_url',
  'route',
  'referrer',
  'network',
  'locale',
  'screen',
  'viewport',
  'sdk_version',
  'sample_rate',
  'send_time',
  'trace_id',
];

/** 各表独有的字段。 */
const TABLE_FIELDS: Record<TableCategory, string[]> = {
  performance: [
    'metric_name',
    'value',
    'rating',
    'start_time',
    'dns',
    'tcp',
    'ssl',
    'request',
    'response',
    'dom_ready',
    'load',
    'name',
    'initiator_type',
    'duration',
    'transfer_size',
    'encoded_body_size',
    'url',
    'method',
    'status_code',
    'request_size',
    'response_size',
    'success',
    'request_body',
    'response_body',
    'resource_url',
    'resource_type',
    'cached',
    'status',
  ],
  error: [
    'error_type',
    'message',
    'name',
    'stack',
    'stack_frames',
    'filename',
    'lineno',
    'colno',
    'component',
    'component_stack',
    'props',
    'reason',
    'resource_url',
    'resource_type',
    'tag_name',
    'url',
    'method',
    'status_code',
    'response_body',
    'duration',
    'breadcrumbs',
    'tags',
    'extra',
    'fingerprint',
    'issue_type',
    'blank_time',
    'root_node_count',
  ],
  behavior: [
    'action',
    'from_route',
    'to_route',
    'duration',
    'category',
    'properties',
  ],
};

/** 前端 SDK 的历史字段别名，统一映射到快照列名。 */
const FIELD_ALIASES: Record<string, string> = {
  projectName: 'project_name',
  initiatorType: 'initiator_type',
  transferSize: 'transfer_size',
  encodedBodySize: 'encoded_body_size',
  startTime: 'start_time',
  sdk_verion: 'sdk_version',
};

/** 需要序列化成 JSON 字符串再写入 ClickHouse 的字段。 */
const JSON_STRING_FIELDS = new Set([
  'stack_frames',
  'breadcrumbs',
  'extra',
  'props',
  'properties',
  'request_body',
  'response_body',
]);

/** ClickHouse `DateTime64(3)` 接受的字面量格式。 */
export function formatClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/** 解析原始请求体，失败时给出与旧实现一致的提示。 */
export function parsePayload(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('Invalid JSON body');
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new BadRequestException('JSON body must be an object');
  }
  return parsed as Record<string, unknown>;
}

/** 展开 `data` 包装、`app_key` 别名与 SDK 驼峰字段。 */
export function expandEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
  const nested = envelope.data;
  const payload: Record<string, unknown> =
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? { ...envelope, ...(nested as Record<string, unknown>) }
      : { ...envelope };
  delete payload.data;

  if (payload.app_id === undefined && payload.app_key !== undefined) {
    payload.app_id = payload.app_key;
  }
  for (const [source, target] of Object.entries(FIELD_ALIASES)) {
    if (payload[target] === undefined && payload[source] !== undefined) {
      payload[target] = payload[source];
    }
  }
  return payload;
}

export interface ExpandedEvents {
  isBatch: boolean;
  /** 批量信封的公共字段，单事件时为空对象。 */
  batchFields: Record<string, unknown>;
  payloads: MonitorEventPayload[];
}

/**
 * 把上报信封展开成待写入的事件负载列表。
 * 只负责结构判断（events 必须是非空数组），字段校验交给 DTO。
 */
export function expandEvents(envelope: Record<string, unknown>): ExpandedEvents {
  if (envelope.events === undefined) {
    return { isBatch: false, batchFields: {}, payloads: [expandEnvelope(envelope)] };
  }

  const events = envelope.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new BadRequestException('events must be a non-empty array');
  }

  const batchFields = expandEnvelope({
    app_id: envelope.app_id,
    app_key: envelope.app_key,
    project_name: envelope.project_name,
    projectName: envelope.projectName,
    sample_rate: envelope.sample_rate,
    sdk_version: envelope.sdk_version,
    sdk_verion: envelope.sdk_verion,
    send_time: envelope.send_time,
  });

  const payloads = events.map((event, index) => {
    if (event === null || Array.isArray(event) || typeof event !== 'object') {
      throw new BadRequestException(`events[${index}] must be an object`);
    }
    return { ...batchFields, ...expandEnvelope(event as Record<string, unknown>) };
  });

  return { isBatch: true, batchFields, payloads };
}

/**
 * 把数值型字段强制转换成数字。
 *
 * 旧实现允许 SDK 上报字符串形式的 `timestamp` / `send_time` / `sample_rate`
 * （先 `Number(...)` 再判断），这里保持同样的宽容度；转换失败会得到 `NaN`，
 * 随后被 DTO 校验拦下。
 */
export function coerceNumericFields(payload: Record<string, unknown>): void {
  if (payload.sample_rate !== undefined) payload.sample_rate = Number(payload.sample_rate);
  if (payload.send_time !== undefined) payload.send_time = Number(payload.send_time);
  if (payload.timestamp !== undefined) payload.timestamp = Number(payload.timestamp);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function normalizeJsonField(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function copyFields(
  event: Record<string, unknown>,
  payload: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (payload[field] !== undefined) {
      event[field] = JSON_STRING_FIELDS.has(field)
        ? normalizeJsonField(payload[field])
        : payload[field];
    }
  }
}

/** 把 `device` / `browser` / `os` / `target` 嵌套对象拍平成独立列。 */
function flattenClientFields(event: Record<string, unknown>, payload: Record<string, unknown>): void {
  const device = asRecord(payload.device);
  if (device) {
    event.device_type = device.type || '';
    event.device_model = device.model || '';
  }
  const browser = asRecord(payload.browser);
  if (browser) {
    event.browser_name = browser.name || '';
    event.browser_version = browser.version || '';
  }
  const os = asRecord(payload.os);
  if (os) {
    event.os_name = os.name || '';
    event.os_version = os.version || '';
  }
  const target = asRecord(payload.target);
  if (target) {
    event.target_selector = target.selector || '';
    event.target_text = target.text || '';
    event.target_tag = target.tag || '';
  }
}

/**
 * 按目标表把事件负载投影成一行 ClickHouse 记录。
 * 请求级字段（IP、User-Agent）由服务端补齐，不信任客户端上报。
 */
export function buildEvent(
  tableCategory: TableCategory,
  payload: MonitorEventPayload,
  meta: MonitorRequestMeta,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event_id: payload.event_id,
    event_type: payload.event_type,
    timestamp: payload.timestamp,
    received_at: formatClickHouseDateTime(new Date()),
    client_ip: meta.ip,
    user_agent: meta.userAgent,
  };

  copyFields(event, payload, COMMON_FIELDS);
  copyFields(event, payload, TABLE_FIELDS[tableCategory]);
  flattenClientFields(event, payload);

  // ClickHouse 侧是 UInt8，布尔值需要显式转换。
  if (event.success !== undefined) event.success = event.success ? 1 : 0;
  if (event.cached !== undefined) event.cached = event.cached ? 1 : 0;
  return event;
}
