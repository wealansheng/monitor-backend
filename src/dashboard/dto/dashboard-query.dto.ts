import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { UUID_PATTERN } from '../../common/validation/patterns';

/**
 * 监控工作台查询参数 DTO。
 *
 * 校验消息与旧实现逐字一致（前端与告警规则依赖这些文案）；
 * 范围计算与聚合仍在 `DashboardService` 中完成。
 */

const APP_ID_MESSAGE = 'app_id is required and must be at most 128 characters';
const HOURS_MESSAGE = 'hours must be 1, 6, 24, 72, or 168';
const EVENT_ID_MESSAGE = 'event_id must be a UUID';
const EVENT_TYPE_MESSAGE =
  'event_type must be one of error, stability, performance, request, resource, behavior';
const KEYWORD_MESSAGE = 'keyword must be a string';
const KEYWORD_LENGTH_MESSAGE = 'keyword must be at most 128 characters';
const LIMIT_MESSAGE = 'limit must be an integer between 1 and 100';
const OFFSET_MESSAGE = 'offset must be an integer between 0 and 100000';

export const DASHBOARD_HOURS = [1, 6, 24, 72, 168];
export const DASHBOARD_EVENT_TYPES = [
  'error',
  'stability',
  'performance',
  'request',
  'resource',
  'behavior',
];

export const DEFAULT_HOURS = 24;
export const DEFAULT_EVENT_LIMIT = 20;
export const MAX_EVENT_LIMIT = 100;
export const MAX_EVENT_OFFSET = 100000;
export const MAX_KEYWORD_LENGTH = 128;

/** 空值回退到默认值，其余一律 `Number(...)`（转换失败得到 NaN，交给 @IsInt 拦截）。 */
const toNumber =
  (fallback: number) =>
  ({ value }: TransformFnParams): unknown =>
    value === undefined || value === null || value === '' ? fallback : Number(value);

/** 空值与 `all` 都表示不限定类型。 */
const toEventType = ({ value }: TransformFnParams): unknown =>
  value === '' || value === 'all' ? undefined : value;

const toTrimmedKeyword = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

const toLowercase = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;

/** 三个查询接口都需要 app_id。 */
export class AppIdQueryDto {
  @IsString({ message: APP_ID_MESSAGE })
  @Matches(/\S/, { message: APP_ID_MESSAGE })
  @MaxLength(128, { message: APP_ID_MESSAGE })
  app_id: string;
}

export class OverviewQueryDto extends AppIdQueryDto {
  // 属性初始值处理“参数缺失”，@Transform 处理“参数存在但为空串”，两者共同给出默认值。
  @Transform(toNumber(DEFAULT_HOURS))
  @IsIn(DASHBOARD_HOURS, { message: HOURS_MESSAGE })
  hours: number = DEFAULT_HOURS;
}

export class EventsQueryDto extends OverviewQueryDto {
  @Transform(toEventType)
  @IsOptional()
  @IsIn(DASHBOARD_EVENT_TYPES, { message: EVENT_TYPE_MESSAGE })
  event_type?: string;

  @Transform(toTrimmedKeyword)
  @IsOptional()
  @IsString({ message: KEYWORD_MESSAGE })
  @MaxLength(MAX_KEYWORD_LENGTH, { message: KEYWORD_LENGTH_MESSAGE })
  keyword?: string;

  @Transform(toNumber(DEFAULT_EVENT_LIMIT))
  @IsInt({ message: LIMIT_MESSAGE })
  @Min(1, { message: LIMIT_MESSAGE })
  @Max(MAX_EVENT_LIMIT, { message: LIMIT_MESSAGE })
  limit: number = DEFAULT_EVENT_LIMIT;

  @Transform(toNumber(0))
  @IsInt({ message: OFFSET_MESSAGE })
  @Min(0, { message: OFFSET_MESSAGE })
  @Max(MAX_EVENT_OFFSET, { message: OFFSET_MESSAGE })
  offset: number = 0;
}

export class EventQueryDto extends AppIdQueryDto {
  @Transform(toLowercase)
  @Matches(UUID_PATTERN, { message: EVENT_ID_MESSAGE })
  event_id: string;

  @Transform(toEventType)
  @IsOptional()
  @IsIn(DASHBOARD_EVENT_TYPES, { message: EVENT_TYPE_MESSAGE })
  event_type?: string;
}
