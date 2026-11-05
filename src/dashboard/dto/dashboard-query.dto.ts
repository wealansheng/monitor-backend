/** 工作台查询参数 DTO：约束应用、时间范围、类型与分页上限。 */
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
/** 回看范围非法时沿用既有英文协议消息。 */
const HOURS_MESSAGE = 'hours must be 1, 6, 24, 72, or 168';
/** 事件 UUID 非法时沿用既有英文协议消息。 */
const EVENT_ID_MESSAGE = 'event_id must be a UUID';
/** 事件类型非法时的固定协议消息，不随中文注释改写。 */
const EVENT_TYPE_MESSAGE =
  'event_type must be one of error, stability, performance, request, resource, behavior';
/** 关键词类型错误的协议消息。 */
const KEYWORD_MESSAGE = 'keyword must be a string';
/** 关键词超过长度上限的协议消息。 */
const KEYWORD_LENGTH_MESSAGE = 'keyword must be at most 128 characters';
/** 单页大小必须在 1–100 之间。 */
const LIMIT_MESSAGE = 'limit must be an integer between 1 and 100';
/** 分页偏移必须在 0–100000 之间。 */
const OFFSET_MESSAGE = 'offset must be an integer between 0 and 100000';

/** 管理端兼容的固定回看小时选项，实际范围仍会裁剪到保留期。 */
export const DASHBOARD_HOURS = [1, 6, 24, 72, 168];
/** 六类 SDK 事件筛选白名单，物理存储仍归入三张普通表。 */
export const DASHBOARD_EVENT_TYPES = [
  'error',
  'stability',
  'performance',
  'request',
  'resource',
  'behavior',
];

/** 未传回看范围时默认查询最近 24 小时。 */
export const DEFAULT_HOURS = 24;
/** 未传分页大小时默认返回 20 条。 */
export const DEFAULT_EVENT_LIMIT = 20;
/** 单页最多 100 条，避免无界结果集。 */
export const MAX_EVENT_LIMIT = 100;
/** 偏移量上限，防止无限扩大的深分页请求。 */
export const MAX_EVENT_OFFSET = 100000;
/** 关键词最多 128 字符。 */
export const MAX_KEYWORD_LENGTH = 128;

/** 空值回退到默认值，其余一律 `Number(...)`（转换失败得到 NaN，交给 @IsInt 拦截）。 */
const toNumber =
  (fallback: number) =>
  ({ value }: TransformFnParams): unknown =>
    value === undefined || value === null || value === '' ? fallback : Number(value);

/** 空值与 `all` 都表示不限定类型。 */
const toEventType = ({ value }: TransformFnParams): unknown =>
  value === '' || value === 'all' ? undefined : value;

/** 仅裁剪字符串两端空白，其他类型交给 DTO 验证器拒绝。 */
const toTrimmedKeyword = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** 将字符串 UUID 规范为小写，非字符串继续交由验证器处理。 */
const toLowercase = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;

/** 三个查询接口都需要 app_id。 */
export class AppIdQueryDto {
  /** 必需的应用隔离标识，拒绝仅含空白的值。 */
  @IsString({ message: APP_ID_MESSAGE })
  @Matches(/\S/, { message: APP_ID_MESSAGE })
  @MaxLength(128, { message: APP_ID_MESSAGE })
  app_id: string;
}

/** 概览查询参数：继承应用标识，校验回看小时选项。 */
export class OverviewQueryDto extends AppIdQueryDto {
  // 属性初始值处理“参数缺失”，@Transform 处理“参数存在但为空串”，两者共同给出默认值。
  @Transform(toNumber(DEFAULT_HOURS))
  @IsIn(DASHBOARD_HOURS, { message: HOURS_MESSAGE })
  hours: number = DEFAULT_HOURS;
}

/** 事件列表参数：继承应用和范围，并限制类型、关键词及分页。 */
export class EventsQueryDto extends OverviewQueryDto {
  /** 可选事件筛选类型，空串或 all 视为不限定类别。 */
  @Transform(toEventType)
  @IsOptional()
  @IsIn(DASHBOARD_EVENT_TYPES, { message: EVENT_TYPE_MESSAGE })
  event_type?: string;

  /** 可选字面搜索关键词，去除两端空白后限制长度。 */
  @Transform(toTrimmedKeyword)
  @IsOptional()
  @IsString({ message: KEYWORD_MESSAGE })
  @MaxLength(MAX_KEYWORD_LENGTH, { message: KEYWORD_LENGTH_MESSAGE })
  keyword?: string;

  /** 单页返回数量，默认 20，最多 100。 */
  @Transform(toNumber(DEFAULT_EVENT_LIMIT))
  @IsInt({ message: LIMIT_MESSAGE })
  @Min(1, { message: LIMIT_MESSAGE })
  @Max(MAX_EVENT_LIMIT, { message: LIMIT_MESSAGE })
  limit: number = DEFAULT_EVENT_LIMIT;

  /** 分页偏移，默认 0，最多 100000。 */
  @Transform(toNumber(0))
  @IsInt({ message: OFFSET_MESSAGE })
  @Min(0, { message: OFFSET_MESSAGE })
  @Max(MAX_EVENT_OFFSET, { message: OFFSET_MESSAGE })
  offset: number = 0;
}

/** 事件详情参数：校验应用、事件 UUID 和可选事件类型。 */
export class EventQueryDto extends AppIdQueryDto {
  /** 客户端事件 UUID；不作为服务端接收幂等键。 */
  @Transform(toLowercase)
  @Matches(UUID_PATTERN, { message: EVENT_ID_MESSAGE })
  event_id: string;

  /** 可选事件筛选类型，空串或 all 视为不限定类别。 */
  @Transform(toEventType)
  @IsOptional()
  @IsIn(DASHBOARD_EVENT_TYPES, { message: EVENT_TYPE_MESSAGE })
  event_type?: string;
}
