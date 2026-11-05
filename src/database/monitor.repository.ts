/** 普通事件持久层：按类别批量写入，提供有时间边界的工作台查询。 */
import { createHash, randomUUID } from 'node:crypto';
import { Between, DataSource } from 'typeorm';
import { boundedRange, retentionCutoff } from './retention';
import { MySqlConfig, TableCategory } from '../config/config.types';
import { normalizeRow, queryRows } from './data-source';
import { quoteIdentifier } from './schema';
import { ENTITY_NAMES } from './v1-schema';

/** 六类 SDK 事件映射到三张普通事件物理表，查询只访问必要类别。 */
const TABLE_BY_EVENT_TYPE = new Map<string, TableCategory>([
  ['error', 'error'], ['stability', 'error'], ['performance', 'performance'],
  ['request', 'performance'], ['resource', 'performance'], ['behavior', 'behavior'],
]);
/** 未指定事件类型时按此顺序查询各表。 */
const EVENT_TABLES: TableCategory[] = ['error', 'behavior', 'performance'];
/** 将不同表投影为统一列表列，保留原字段用于详情查询。 */
const EVENT_COLUMNS: Record<TableCategory, string> = {
  error: "event_id AS eventId, event_type AS eventType, timestamp, route, IF(message = '', issue_type, message) AS label, error_type AS detail",
  behavior: 'event_id AS eventId, event_type AS eventType, timestamp, route, action AS label, category AS detail',
  performance: "event_id AS eventId, event_type AS eventType, timestamp, route, IF(metric_name = '', url, metric_name) AS label, rating AS detail",
};

/** 工作台事件列表的轻量响应行，不包含内部自增主键。 */
export interface EventRow {
  eventId: string;
  eventType: string;
  timestamp: number;
  route: string;
  label: string;
  detail: string;
}

/** 源码定位所需的错误字段；JSON 字符串保持原协议形状。 */
export interface ErrorEventRow {
  event_id: string;
  app_id: string;
  release: string;
  error_type: string;
  message: string;
  stack: string;
  stack_frames?: string;
  filename: string;
  lineno: number;
  colno: number;
  page_url: string;
}

/** 概览聚合的应用、毫秒时间边界和趋势桶宽。 */
export interface DashboardOverviewParams {
  appId: string;
  from: number;
  to: number;
  bucket: number;
}

/** 概览查询各组聚合结果，由业务层整理为工作台响应。 */
export interface DashboardOverviewData {
  behaviorSummary: Record<string, unknown>;
  errorSummary: Record<string, unknown>;
  performanceSummary: Record<string, unknown>;
  timeline: Record<string, unknown>[];
  vitals: Record<string, unknown>[];
  errorTypes: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  routes: Record<string, unknown>[];
  recentEvents: EventRow[];
}

/** 事件分页的应用、范围、类别、关键词与分页边界。 */
export interface DashboardEventsParams {
  appId: string;
  from: number;
  to: number;
  eventType?: string;
  keyword: string;
  limit: number;
  offset: number;
}

/** 按 UUID 查询事件所需的应用及可选事件类别。 */
export interface DashboardEventParams {
  appId: string;
  eventId: string;
  eventType?: string;
}

/** 带物理类别标识的事件详情。 */
export interface DashboardEventDetail {
  category: TableCategory;
  event: Record<string, unknown>;
}

/** 补齐内部接收标识与 UTC 接收时间，并按原指纹输入规则计算 SHA-256。 */
export function prepareEventRows(category: TableCategory, events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.map(inputEvent => {
      const event: Record<string, unknown> = { ...inputEvent, ingest_id: inputEvent.ingest_id || randomUUID(), event_id: String(inputEvent.event_id).toLowerCase() };
      // 协议生成 UTC 时间字面量；显式转换为带 UTC 语义的 Date，避免 TypeORM 按本机时区解析。
      if (typeof event.received_at === 'string') {
        event.received_at = new Date(event.received_at.replace(' ', 'T') + 'Z');
      }
      if (category !== 'error') return event;
      // 优先使用 SDK 显式指纹，否则沿用错误类型、名称、消息、文件的既有输入规则。
      const input = event.fingerprint || ['error_type', 'name', 'message', 'filename'].map(key => event[key] ?? '').join('|');
      return { ...event, fingerprint_hash: createHash('sha256').update(String(input)).digest('hex') };
    });
}

/** 封装三类普通事件表的 ORM 写入与参数化查询。 */
export class MonitorRepository {
  private readonly tables: Record<TableCategory, string>;
  constructor(private readonly source: DataSource, private readonly config: MySqlConfig) {
    this.tables = Object.fromEntries(Object.entries(config.tables).map(([key, table]) =>
      [key, quoteIdentifier(table)])) as Record<TableCategory, string>;
  }

  /** 按指定表类别执行多值写入，仅对相同内部接收标识做无操作更新。 */
  async insertMany(category: TableCategory, events: Record<string, unknown>[]): Promise<void> {
    const entity = ENTITY_NAMES[category];
    if (!entity || !this.tables[category]) throw new Error(`不支持的监控事件类型: ${category}`);
    await this.source.getRepository(entity).createQueryBuilder().insert().values(prepareEventRows(category,events))
      .orUpdate(['ingest_id'], ['ingest_id','timestamp']).execute();
  }

  /** 在保留窗口内按应用和 UUID 查询一条错误，供源码定位使用。 */
  async findError(appId: string, eventId: string): Promise<ErrorEventRow | null> {
    const event = await this.source.getRepository(ENTITY_NAMES.error).findOne({
      where: { app_id: appId, event_id: eventId.toLowerCase(), timestamp: Between(retentionCutoff(this.config.retentionDays),Date.now()) },
      select: ['event_id', 'app_id', 'release', 'error_type', 'message', 'stack', 'stack_frames', 'filename', 'lineno', 'colno', 'page_url'],
    });
    return event ? normalizeRow<ErrorEventRow>(event) : null;
  }

  /** 将六类协议事件映射到三张物理表，未知类型直接拒绝。 */
  private categories(eventType?: string): TableCategory[] {
    const mapped = eventType ? TABLE_BY_EVENT_TYPE.get(eventType) : undefined;
    if (eventType && !mapped) throw new Error(`不支持的事件类型: ${eventType}`);
    return mapped ? [mapped] : EVENT_TABLES;
  }

  /** 为选中的物理表构造 UNION ALL，每个分支均带应用与时间条件。 */
  buildEventSource({ eventType }: { eventType?: string } = {}): string {
    const where = 'app_id = :appId AND timestamp >= :from AND timestamp <= :to'
      + (eventType ? ' AND event_type = :eventType' : '');
    return this.categories(eventType).map(category =>
      `SELECT ${EVENT_COLUMNS[category]} FROM ${this.tables[category]} WHERE ${where}`).join(' UNION ALL ');
  }

  /** 在有限保留窗口内汇总普通事件与 Replay 应用，最多返回 100 个应用。 */
  async findDashboardApps(): Promise<Record<string, unknown>[]> {
    const range = {from:retentionCutoff(this.config.retentionDays),to:Date.now()};
    // 每张表先统计应用计数并挑出最新行，再跨表合并；Replay 只贡献最近出现时间。
    const branches = EVENT_TABLES.map(category => `SELECT app_id AS appId, project_name AS projectName,
      COUNT(*) OVER (PARTITION BY app_id) AS events, timestamp AS lastSeen,
      ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY timestamp DESC, id DESC) AS rn
      FROM ${this.tables[category]} WHERE timestamp BETWEEN :from AND :to`);
    branches.push(`SELECT app_id AS appId, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.project_name')), '') AS projectName,
      0 AS events, started_at AS lastSeen,
      ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY started_at DESC, id DESC) AS rn
      FROM ${quoteIdentifier(this.config.recordTable)} WHERE started_at BETWEEN :from AND :to`);
    return this.query(`WITH candidates AS (${branches.join(' UNION ALL ')}),
      latest AS (SELECT appId, projectName, SUM(events) OVER (PARTITION BY appId) AS events,
        MAX(lastSeen) OVER (PARTITION BY appId) AS lastSeen,
        ROW_NUMBER() OVER (PARTITION BY appId ORDER BY lastSeen DESC, projectName) AS pick
        FROM candidates WHERE rn = 1)
      SELECT appId, projectName, events, lastSeen FROM latest WHERE pick = 1 ORDER BY lastSeen DESC, appId LIMIT 100`,range);
  }

  /** 在应用与时间范围内聚合概览，P75 使用窗口排序后的最近秩值。 */
  async findDashboardOverview(params: DashboardOverviewParams): Promise<DashboardOverviewData> {
    const { performance, error, behavior } = this.tables;
    const values = { ...params, ...boundedRange(this.config.retentionDays,params.from,params.to) };
    const filter = 'app_id = :appId AND timestamp >= :from AND timestamp <= :to';
    // 各组聚合并行执行，均复用同一应用及时间过滤，结果集合各自设置上限。
    const [behaviorSummary, errorSummary, performanceSummary, timeline, vitals, errorTypes, issues, routes, recentEvents] = await Promise.all([
      this.query(`SELECT COUNT(CASE WHEN action = 'page_view' THEN 1 END) AS pageViews,
        COUNT(DISTINCT CASE WHEN action = 'page_view' THEN NULLIF(IF(user_id = '', session_id, user_id), '') END) AS visitors,
        COUNT(DISTINCT CASE WHEN action = 'page_view' THEN NULLIF(session_id, '') END) AS sessions
        FROM ${behavior} WHERE ${filter} LIMIT 1`, values),
      this.query(`SELECT COUNT(*) AS errors, COUNT(CASE WHEN event_type = 'stability' THEN 1 END) AS stabilityIssues
        FROM ${error} WHERE ${filter} LIMIT 1`, values),
      this.query(`SELECT COUNT(CASE WHEN event_type = 'request' THEN 1 END) AS requests,
        COUNT(CASE WHEN event_type = 'request' AND success = 0 THEN 1 END) AS failedRequests
        FROM ${performance} WHERE ${filter} LIMIT 1`, values),
      this.query(`SELECT bucket, SUM(pageViews) AS pageViews, SUM(errors) AS errors FROM (
        SELECT FLOOR(timestamp / :bucket) * :bucket AS bucket,
          COUNT(CASE WHEN action = 'page_view' THEN 1 END) AS pageViews, 0 AS errors
          FROM ${behavior} WHERE ${filter} GROUP BY bucket
        UNION ALL
        SELECT FLOOR(timestamp / :bucket) * :bucket AS bucket, 0 AS pageViews, COUNT(*) AS errors
          FROM ${error} WHERE ${filter} GROUP BY bucket
        ) AS buckets GROUP BY bucket ORDER BY bucket LIMIT 10000`, values),
      // P75 取排序后第 ceil(样本数 × 0.75) 个值；id 为同值样本提供稳定顺序。
      this.query(`WITH ranked AS (
        SELECT UPPER(metric_name) AS metric, value, rating,
          ROW_NUMBER() OVER (PARTITION BY UPPER(metric_name) ORDER BY value, id) AS rn,
          COUNT(*) OVER (PARTITION BY UPPER(metric_name)) AS samples
        FROM ${performance} WHERE ${filter} AND event_type = 'performance'
          AND UPPER(metric_name) IN ('LCP', 'INP', 'CLS', 'FCP', 'TTFB'))
        SELECT metric, MAX(samples) AS samples,
          MAX(CASE WHEN rn = CEIL(samples * 0.75) THEN value END) AS p75,
          COUNT(CASE WHEN rating = 'good' THEN 1 END) AS good,
          COUNT(CASE WHEN rating = 'needs-improvement' THEN 1 END) AS needsImprovement,
          COUNT(CASE WHEN rating = 'poor' THEN 1 END) AS poor
        FROM ranked GROUP BY metric ORDER BY metric LIMIT 5`, values),
      this.query(`SELECT IF(event_type = 'stability', issue_type, error_type) AS type, COUNT(*) AS count
        FROM ${error} WHERE ${filter} GROUP BY type ORDER BY count DESC, type LIMIT 8`, values),
      this.query(`SELECT fingerprint_hash AS fingerprint, ANY_VALUE(message) AS message, ANY_VALUE(error_type) AS type,
        COUNT(*) AS count, COUNT(DISTINCT NULLIF(session_id, '')) AS affectedSessions, MAX(timestamp) AS lastSeen
        FROM ${error} WHERE ${filter} GROUP BY fingerprint_hash ORDER BY count DESC, fingerprint LIMIT 8`, values),
      this.query(`SELECT IF(route = '', page_url, route) AS route, COUNT(*) AS pageViews,
        COUNT(DISTINCT NULLIF(IF(user_id = '', session_id, user_id), '')) AS visitors
        FROM ${behavior} WHERE ${filter} AND action = 'page_view'
        GROUP BY IF(route = '', page_url, route) ORDER BY pageViews DESC, route LIMIT 8`, values),
      this.query<EventRow>(`SELECT eventId, eventType, timestamp, route, label, detail
        FROM (${this.buildEventSource()}) AS events ORDER BY timestamp DESC, eventId LIMIT 20`, values),
    ]);
    return {
      behaviorSummary: behaviorSummary[0] ?? {}, errorSummary: errorSummary[0] ?? {},
      performanceSummary: performanceSummary[0] ?? {}, timeline, vitals, errorTypes, issues, routes, recentEvents,
    };
  }

  /** 以相同过滤条件并行查询分页结果和总数，关键词按字面包含匹配。 */
  async findDashboardEvents(params: DashboardEventsParams): Promise<{ events: EventRow[]; total: number }> {
    const values = {...params,...boundedRange(this.config.retentionDays,params.from,params.to)};
    const source = this.buildEventSource(params);
    // LOCATE 将百分号、下划线和反斜杠视为普通字符；LOWER 实现不区分大小写的字面包含匹配。
    const where = params.keyword ? "WHERE LOCATE(LOWER(:keyword), LOWER(CONCAT(label, ' ', route, ' ', detail))) > 0" : '';
    const [events, totals] = await Promise.all([
      this.query<EventRow>(`SELECT eventId, eventType, timestamp, route, label, detail FROM (${source}) AS events ${where}
        ORDER BY timestamp DESC, eventId LIMIT :limit OFFSET :offset`, values),
      this.query<{ total: number }>(`SELECT COUNT(*) AS total FROM (${source}) AS events ${where} LIMIT 1`, values),
    ]);
    return { events, total: totals[0]?.total ?? 0 };
  }

  /** 按可选类别逐表查找一条事件，强制应用隔离和保留期边界。 */
  async findDashboardEvent({ appId, eventId, eventType }: DashboardEventParams): Promise<DashboardEventDetail | null> {
    for (const category of this.categories(eventType)) {
      const where: Record<string, unknown> = { app_id: appId, event_id: eventId.toLowerCase(), timestamp: Between(retentionCutoff(this.config.retentionDays),Date.now()) };
      if (eventType) where.event_type = eventType;
      const event = await this.source.getRepository(ENTITY_NAMES[category]).findOne({ where });
      if (event) return { category, event: normalizeRow(event) };
    }
    return null;
  }

  /** 统一通过 TypeORM 驱动绑定参数并转换查询结果。 */
  private query<T = Record<string, unknown>>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
    return queryRows<T>(this.source, sql, params);
  }
}
