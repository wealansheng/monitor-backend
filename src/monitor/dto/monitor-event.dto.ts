/** 事件输入 DTO：使用声明式约束校验公共字段与各类事件字段。 */
import { IsIn, IsInt, IsNumber, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';

import { IsTruthy } from '../../common/validation/is-truthy.decorator';
import { UUID_PATTERN } from '../../common/validation/patterns';
import { EVENT_TYPES } from '../monitor.protocol';

/**
 * 事件字段校验 DTO。
 *
 * 校验消息与旧实现逐字保持一致，SDK 与告警规则都依赖这些文案。
 * 事件协议字段很多（三张表合计 60 余个），这些字段由 `buildEvent` 按白名单
 * 投影，因此这里只声明“需要校验”的字段，未声明的字段不会被丢弃。
 */

const EVENT_TYPE_MESSAGE =
  `event_type must be ${EVENT_TYPES.slice(0, -1).join(', ')}, ` +
  `or ${EVENT_TYPES[EVENT_TYPES.length - 1]}`;

/** 事件时间必须是正的 Unix 毫秒安全整数。 */
const TIMESTAMP_MESSAGE = 'timestamp must be a positive Unix millisecond integer';
/** 客户端发送时间出现时必须是正的 Unix 毫秒安全整数。 */
const SEND_TIME_MESSAGE = 'send_time must be a positive Unix millisecond integer';
/** 采样率出现时必须是 0–1 之间的数值。 */
const SAMPLE_RATE_MESSAGE = 'sample_rate must be a number between 0 and 1';

/** 仅在字段出现时校验（`undefined` 表示未上报）。 */
const whenPresent = (_object: unknown, value: unknown): boolean => value !== undefined;

/** 仅在事件类型匹配时校验。 */
const whenEventType = (eventType: string) => (object: MonitorEventDto): boolean =>
  object.event_type === eventType;

/** 普通事件字段约束：公共字段始终校验，专属字段按事件类型启用。 */
export class MonitorEventDto {
  /** 客户端事件 UUID；不作为服务端接收幂等键。 */
  @Matches(UUID_PATTERN, { message: 'event_id must be a UUID' })
  event_id: unknown;

  /** SDK 事件类型，使用协议白名单校验。 */
  @IsIn(EVENT_TYPES, { message: EVENT_TYPE_MESSAGE })
  event_type: unknown;

  /** 必需的应用隔离标识，拒绝仅含空白的值。 */
  @IsString({ message: 'app_id is required' })
  @Matches(/\S/, { message: 'app_id is required' })
  app_id: unknown;

  /** 可选项目名称，出现时必须为非空字符串。 */
  @ValidateIf(whenPresent)
  @IsString({ message: 'project_name must be a non-empty string' })
  @Matches(/\S/, { message: 'project_name must be a non-empty string' })
  project_name?: unknown;

  /** 事件发生时间，单位为 Unix 毫秒。 */
  @IsInt({ message: TIMESTAMP_MESSAGE })
  @Min(1, { message: TIMESTAMP_MESSAGE })
  @Max(Number.MAX_SAFE_INTEGER, { message: TIMESTAMP_MESSAGE })
  timestamp: unknown;

  /** 性能事件必填的指标名称。 */
  @ValidateIf(whenEventType('performance'))
  @IsTruthy({ message: 'metric_name is required for performance events' })
  metric_name?: unknown;

  /** 网络请求事件必填的请求地址。 */
  @ValidateIf(whenEventType('request'))
  @IsTruthy({ message: 'url and method are required for request events' })
  url?: unknown;

  /** 网络请求事件必填的 HTTP 方法。 */
  @ValidateIf(whenEventType('request'))
  @IsTruthy({ message: 'url and method are required for request events' })
  method?: unknown;

  /** 资源事件必填的资源地址。 */
  @ValidateIf(whenEventType('resource'))
  @IsTruthy({ message: 'resource_url is required for resource events' })
  resource_url?: unknown;

  /** 错误事件必填的错误类别。 */
  @ValidateIf(whenEventType('error'))
  @IsTruthy({ message: 'error_type is required for error events' })
  error_type?: unknown;

  /** 稳定性事件必填的问题类别。 */
  @ValidateIf(whenEventType('stability'))
  @IsTruthy({ message: 'issue_type is required for stability events' })
  issue_type?: unknown;

  /** 行为事件必填的动作名称。 */
  @ValidateIf(whenEventType('behavior'))
  @IsTruthy({ message: 'action is required for behavior events' })
  action?: unknown;

  /** 可选采样率，范围为 0–1。 */
  @ValidateIf(whenPresent)
  @IsNumber({}, { message: SAMPLE_RATE_MESSAGE })
  @Min(0, { message: SAMPLE_RATE_MESSAGE })
  @Max(1, { message: SAMPLE_RATE_MESSAGE })
  sample_rate?: unknown;

  /** 可选客户端发送时间，单位为 Unix 毫秒。 */
  @ValidateIf(whenPresent)
  @IsInt({ message: SEND_TIME_MESSAGE })
  @Min(1, { message: SEND_TIME_MESSAGE })
  @Max(Number.MAX_SAFE_INTEGER, { message: SEND_TIME_MESSAGE })
  send_time?: unknown;
}

/** 批量信封的公共元数据，在逐个事件之前先行校验。 */
export class MonitorBatchMetaDto {
  /** 可选采样率，范围为 0–1。 */
  @ValidateIf(whenPresent)
  @IsNumber({}, { message: SAMPLE_RATE_MESSAGE })
  @Min(0, { message: SAMPLE_RATE_MESSAGE })
  @Max(1, { message: SAMPLE_RATE_MESSAGE })
  sample_rate?: unknown;

  /** 可选客户端发送时间，单位为 Unix 毫秒。 */
  @ValidateIf(whenPresent)
  @IsInt({ message: SEND_TIME_MESSAGE })
  @Min(1, { message: SEND_TIME_MESSAGE })
  @Max(Number.MAX_SAFE_INTEGER, { message: SEND_TIME_MESSAGE })
  send_time?: unknown;
}

/**
 * 字段优先级。
 *
 * 旧实现按固定顺序逐项校验（公共字段 → 事件类型专属字段 → 批量元数据），
 * 这里显式排序，保证同时存在多个非法字段时报出的第一条与旧实现一致。
 */
export const MONITOR_FIELD_PRECEDENCE = [
  'event_id',
  'event_type',
  'app_id',
  'project_name',
  'timestamp',
  'metric_name',
  'url',
  'method',
  'resource_url',
  'error_type',
  'issue_type',
  'action',
  'sample_rate',
  'send_time',
] as const;
