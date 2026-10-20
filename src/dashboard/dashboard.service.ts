import { Injectable, NotFoundException } from '@nestjs/common';

import { EventRow, MonitorRepository } from '../database/monitor.repository';

const HOUR_IN_MS = 60 * 60 * 1000;

/** ClickHouse 聚合结果以字符串返回计数，统一转成数字。 */
function number(value: unknown): number {
  return Number(value ?? 0);
}

function rangeOf(rangeHours: number): { from: number; to: number } {
  const to = Date.now();
  return { from: to - rangeHours * HOUR_IN_MS, to };
}

export interface OverviewQuery {
  appId: string;
  hours: number;
}

export interface EventsQuery {
  appId: string;
  hours: number;
  eventType?: string;
  keyword: string;
  limit: number;
  offset: number;
}

export interface EventQuery {
  appId: string;
  eventId: string;
  eventType?: string;
}

export interface DashboardSummary {
  pageViews: number;
  visitors: number;
  sessions: number;
  errors: number;
  stabilityIssues: number;
  requests: number;
  failedRequests: number;
}

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
  constructor(private readonly repository: MonitorRepository) {}

  async apps(): Promise<{ apps: Record<string, unknown>[] }> {
    return { apps: await this.repository.findDashboardApps() };
  }

  async overview({ appId, hours }: OverviewQuery): Promise<OverviewResult> {
    const { from, to } = rangeOf(hours);
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
    const { from, to } = rangeOf(hours);
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
