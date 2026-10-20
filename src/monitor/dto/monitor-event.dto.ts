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

const TIMESTAMP_MESSAGE = 'timestamp must be a positive Unix millisecond integer';
const SEND_TIME_MESSAGE = 'send_time must be a positive Unix millisecond integer';
const SAMPLE_RATE_MESSAGE = 'sample_rate must be a number between 0 and 1';

/** 仅在字段出现时校验（`undefined` 表示未上报）。 */
const whenPresent = (_object: unknown, value: unknown): boolean => value !== undefined;

/** 仅在事件类型匹配时校验。 */
const whenEventType = (eventType: string) => (object: MonitorEventDto): boolean =>
  object.event_type === eventType;

export class MonitorEventDto {
  @Matches(UUID_PATTERN, { message: 'event_id must be a UUID' })
  event_id: unknown;

  @IsIn(EVENT_TYPES, { message: EVENT_TYPE_MESSAGE })
  event_type: unknown;

  @IsString({ message: 'app_id is required' })
  @Matches(/\S/, { message: 'app_id is required' })
  app_id: unknown;

  @ValidateIf(whenPresent)
  @IsString({ message: 'project_name must be a non-empty string' })
  @Matches(/\S/, { message: 'project_name must be a non-empty string' })
  project_name?: unknown;

  @IsInt({ message: TIMESTAMP_MESSAGE })
  @Min(1, { message: TIMESTAMP_MESSAGE })
  @Max(Number.MAX_SAFE_INTEGER, { message: TIMESTAMP_MESSAGE })
  timestamp: unknown;

  @ValidateIf(whenEventType('performance'))
  @IsTruthy({ message: 'metric_name is required for performance events' })
  metric_name?: unknown;

  @ValidateIf(whenEventType('request'))
  @IsTruthy({ message: 'url and method are required for request events' })
  url?: unknown;

  @ValidateIf(whenEventType('request'))
  @IsTruthy({ message: 'url and method are required for request events' })
  method?: unknown;

  @ValidateIf(whenEventType('resource'))
  @IsTruthy({ message: 'resource_url is required for resource events' })
  resource_url?: unknown;

  @ValidateIf(whenEventType('error'))
  @IsTruthy({ message: 'error_type is required for error events' })
  error_type?: unknown;

  @ValidateIf(whenEventType('stability'))
  @IsTruthy({ message: 'issue_type is required for stability events' })
  issue_type?: unknown;

  @ValidateIf(whenEventType('behavior'))
  @IsTruthy({ message: 'action is required for behavior events' })
  action?: unknown;

  @ValidateIf(whenPresent)
  @IsNumber({}, { message: SAMPLE_RATE_MESSAGE })
  @Min(0, { message: SAMPLE_RATE_MESSAGE })
  @Max(1, { message: SAMPLE_RATE_MESSAGE })
  sample_rate?: unknown;

  @ValidateIf(whenPresent)
  @IsInt({ message: SEND_TIME_MESSAGE })
  @Min(1, { message: SEND_TIME_MESSAGE })
  @Max(Number.MAX_SAFE_INTEGER, { message: SEND_TIME_MESSAGE })
  send_time?: unknown;
}

/** 批量信封的公共元数据，在逐个事件之前先行校验。 */
export class MonitorBatchMetaDto {
  @ValidateIf(whenPresent)
  @IsNumber({}, { message: SAMPLE_RATE_MESSAGE })
  @Min(0, { message: SAMPLE_RATE_MESSAGE })
  @Max(1, { message: SAMPLE_RATE_MESSAGE })
  sample_rate?: unknown;

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
