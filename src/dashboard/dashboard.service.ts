/** 工作台业务层：限制查询时间范围，并将聚合结果整理为现有响应协议。 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MONITOR_CONFIG } from '../config/config.constants';
import type { MonitorConfig } from '../config/config.types';
import { boundedRange } from '../database/retention';

import { EventRow, MonitorRepository } from '../database/monitor.repository';

/** 一小时对应的毫秒数，用于回看窗口与趋势桶宽。 */
const HOUR_IN_MS = 60 * 60 * 1000;

/** MySQL 聚合结果以字符串返回计数，统一转成数字。 */
function number(value: unknown): number {
  return Number(value ?? 0);
}

/** 计算工作台查询范围，并裁剪到配置的保留窗口以内。 */
function rangeOf(rangeHours: number, days: number): { from: number; to: number } {
  const to = Date.now();
  return boundedRange(days,to - rangeHours * HOUR_IN_MS,to,to);
}

/** 工作台概览查询的内部参数形状。 */
export interface OverviewQuery {
  appId: string;
  hours: number;
}

/** 工作台事件列表的内部筛选与分页参数。 */
export interface EventsQuery {
  appId: string;
  hours: number;
  eventType?: string;
  keyword: string;
  limit: number;
  offset: number;
}

/** 工作台单事件查询参数。 */
export interface EventQuery {
  appId: string;
  eventId: string;
  eventType?: string;
}

/** 工作台顶部的浏览、用户、会话、错误与请求计数摘要。 */
export interface DashboardSummary {
  pageViews: number;
  visitors: number;
  sessions: number;
  errors: number;
  stabilityIssues: number;
  requests: number;
  failedRequests: number;
}

/** 工作台概览接口响应，包括范围、摘要和聚合明细。 */
export interface OverviewResult {
  appId: string;
  from: number;
  to: number;
  hours: number;
  summary: DashboardSummary;
  timeline: Record<string, unknown>[];
  vitals: Record<string, unknown>[];
  errorTypes: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  routes: Record<string, unknown>[];
  recentEvents: EventRow[];
}

/** 事件分页响应，包含总数和后续页信息。 */
export interface EventsResult {
  appId: string;
  from: number;
  to: number;
  hours: number;
  eventType: string;
  keyword: string;
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  events: EventRow[];
}

/**
 * 监控工作台聚合查询。
 *
 * 参数合法性由 `OverviewQueryDto` / `EventsQueryDto` / `EventQueryDto` 负责，
 * 这里只做时间范围计算、聚合结果整形与“事件不存在”的 404。
 */
@Injectable()
export class DashboardService {
  constructor(private readonly repository: MonitorRepository,
    @Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {}

  /** 将 Repository 的应用汇总整理为工作台响应。 */
  async apps(): Promise<{ apps: Record<string, unknown>[] }> {
    return { apps: await this.repository.findDashboardApps() };
  }

  /** 裁剪时间范围并组合摘要、趋势、性能指标与问题排行。 */
  async overview({ appId, hours }: OverviewQuery): Promise<OverviewResult> {
    const { from, to } = rangeOf(hours, this.config.mysql.retentionDays);
    const data = await this.repository.findDashboardOverview({
      appId,
      from,
      to,
      bucket: hours <= 24 ? HOUR_IN_MS : 6 * HOUR_IN_MS,
    });

    return {
      appId,
      from,
      to,
      hours,
      summary: {
        pageViews: number(data.behaviorSummary.pageViews),
        visitors: number(data.behaviorSummary.visitors),
        sessions: number(data.behaviorSummary.sessions),
        errors: number(data.errorSummary.errors),
        stabilityIssues: number(data.errorSummary.stabilityIssues),
        requests: number(data.performanceSummary.requests),
        failedRequests: number(data.performanceSummary.failedRequests),
      },
      timeline: data.timeline,
      vitals: data.vitals,
      errorTypes: data.errorTypes,
      issues: data.issues,
      routes: data.routes,
      recentEvents: data.recentEvents,
    };
  }

  /** 事件明细分页：服务端按类型与关键字过滤，不依赖最近 N 条的窗口。 */
  async events({
    appId,
    hours,
    eventType,
    keyword,
    limit,
    offset,
  }: EventsQuery): Promise<EventsResult> {
    const { from, to } = rangeOf(hours, this.config.mysql.retentionDays);
    const { events, total } = await this.repository.findDashboardEvents({
      appId,
      from,
      to,
      eventType,
      keyword,
      limit,
      offset,
    });

    return {
      appId,
      from,
      to,
      hours,
      eventType: eventType ?? 'all',
      keyword,
      limit,
      offset,
      total,
      hasMore: offset + events.length < total,
      events,
    };
  }

  /** 单条事件详情：返回该事件所在表的原始字段。 */
  async event({ appId, eventId, eventType }: EventQuery): Promise<{
    appId: string;
    eventId: string;
    category: string;
    event: Record<string, unknown>;
  }> {
    const found = await this.repository.findDashboardEvent({ appId, eventId, eventType });
    if (!found) {
      throw new NotFoundException('event not found');
    }

    return {
      appId,
      eventId,
      category: found.category,
      event: found.event,
    };
  }
}
