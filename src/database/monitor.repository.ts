import { ClickHouseTables, TableCategory } from '../config/config.types';
import { ClickHouseClientPort } from './clickhouse-client.port';
import { getSchemaStatements, quoteIdentifier } from './schema';

/**
 * event_type 与目标表的对应关系：查询时据此跳过无关表。
 * 用 Map 而非对象字面量，避免 `toString` 之类的原型属性被误判为合法类型。
 */
const TABLE_BY_EVENT_TYPE = new Map<string, TableCategory>([
  ['error', 'error'],
  ['stability', 'error'],
  ['performance', 'performance'],
  ['request', 'performance'],
  ['resource', 'performance'],
  ['behavior', 'behavior'],
]);

const EVENT_TABLES: TableCategory[] = ['error', 'behavior', 'performance'];

/** 聚合查询可能返回空结果集，用空对象占位以便上层直接取值。 */
function firstRowOrEmpty<T>(rows: readonly T[]): T {
  return rows[0] ?? ({} as T);
}

/** MATERIALIZED 列不会出现在 SELECT * 里，错误表的聚类指纹需要显式取出。 */
const EVENT_DETAIL_EXTRA_COLUMNS: Record<TableCategory, string> = {
  error: ', toString(fingerprint_hash) AS fingerprint_hash',
  behavior: '',
  performance: '',
};

/** 三张表的事件行统一投影成同一组列，供 UNION ALL 使用。 */
const EVENT_COLUMNS: Record<TableCategory, string> = {
  error: `toString(event_id) AS eventId, event_type AS eventType, timestamp, route,
          if(message = '', issue_type, message) AS label, error_type AS detail`,
  behavior: `toString(event_id) AS eventId, event_type AS eventType, timestamp, route,
          action AS label, category AS detail`,
  performance: `toString(event_id) AS eventId, event_type AS eventType, timestamp, route,
          if(metric_name = '', url, metric_name) AS label, rating AS detail`,
};

export interface MonitorRepositoryOptions {
  recordTable?: string;
  client: ClickHouseClientPort;
  database: string;
  tables: ClickHouseTables;
}

export interface EventRow {
  eventId: string;
  eventType: string;
  timestamp: number;
  route: string;
  label: string;
  detail: string;
}

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

export interface DashboardOverviewParams {
  appId: string;
  from: number;
  to: number;
  bucket: number;
}

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

export interface DashboardEventsParams {
  appId: string;
  from: number;
  to: number;
  eventType?: string;
  keyword: string;
  limit: number;
  offset: number;
}

export interface DashboardEventParams {
  appId: string;
  eventId: string;
  eventType?: string;
}

export interface DashboardEventDetail {
  category: TableCategory;
  event: Record<string, unknown>;
}

export class MonitorRepository {
  private readonly client: ClickHouseClientPort;

  private readonly database: string;

  private readonly tables: ClickHouseTables;
  private readonly recordTable: string;

  private readonly qualifiedTables: Record<TableCategory, string>;

  constructor({ client, database, tables, recordTable = 'event_record' }: MonitorRepositoryOptions) {
    this.recordTable = recordTable;
    this.client = client;
    this.database = database;
    this.tables = tables;
    this.qualifiedTables = {
      performance: `${quoteIdentifier(database)}.${quoteIdentifier(tables.performance)}`,
      error: `${quoteIdentifier(database)}.${quoteIdentifier(tables.error)}`,
      behavior: `${quoteIdentifier(database)}.${quoteIdentifier(tables.behavior)}`,
    };
  }

  /** 建库、建表，并为已有表补充新增字段。 */
  async initialize(): Promise<void> {
    const statements = getSchemaStatements({ database: this.database, tables: this.tables, recordTable: this.recordTable });
    for (const query of statements) {
      await this.client.command({ query });
    }
  }

  async insertMany(category: TableCategory, events: Record<string, unknown>[]): Promise<void> {
    const table = this.qualifiedTables[category];
    if (!table) {
      throw new Error(`不支持的监控事件类型: ${category}`);
    }

    await this.client.insert({
      table,
      values: events,
      format: 'JSONEachRow',
      clickhouse_settings: {
        input_format_defaults_for_omitted_fields: 1,
      },
    });
  }

  async findError(appId: string, eventId: string): Promise<ErrorEventRow | null> {
    const rows = await this.dashboardQuery<ErrorEventRow>(
      `SELECT event_id, app_id, release, error_type, message, stack, stack_frames, filename, lineno, colno, page_url
        FROM ${this.qualifiedTables.error}
        WHERE app_id = {appId:String} AND event_id = {eventId:UUID}
        LIMIT 1`,
      { appId, eventId },
    );
    return rows[0] || null;
  }

  /**
   * 构造事件明细的 UNION ALL 数据源。
   * 指定 eventType 时只扫描可能产生该类型的表，并把 event_type 条件下推。
   */
  buildEventSource({ eventType }: { eventType?: string } = {}): string {
    const mapped = eventType ? TABLE_BY_EVENT_TYPE.get(eventType) : undefined;
    if (eventType && !mapped) {
      throw new Error(`不支持的事件类型: ${eventType}`);
    }
    const categories: TableCategory[] = mapped ? [mapped] : EVENT_TABLES;

    const filters = [
      'app_id = {appId:String}',
      'timestamp >= {from:UInt64}',
      'timestamp <= {to:UInt64}',
    ];
    if (eventType) filters.push('event_type = {eventType:String}');
    const where = filters.join(' AND ');

    return categories
      .map(
        (category) =>
          `SELECT ${EVENT_COLUMNS[category]} FROM ${this.qualifiedTables[category]} WHERE ${where}`,
      )
      .join(' UNION ALL ');
  }

  async findDashboardApps(): Promise<Record<string, unknown>[]> {
    const { performance, error, behavior } = this.qualifiedTables;
    const records = `${quoteIdentifier(this.database)}.${quoteIdentifier(this.recordTable)}`;
    return this.dashboardQuery(`
      SELECT appId, argMax(projectName, latest) AS projectName,
        sum(events) AS events, max(latest) AS lastSeen
      FROM (
        SELECT app_id AS appId, any(project_name) AS projectName,
          count() AS events, max(timestamp) AS latest FROM ${performance} GROUP BY app_id
        UNION ALL
        SELECT app_id AS appId, any(project_name) AS projectName,
          count() AS events, max(timestamp) AS latest FROM ${error} GROUP BY app_id
        UNION ALL
        SELECT app_id AS appId, any(project_name) AS projectName,
          count() AS events, max(timestamp) AS latest FROM ${behavior} GROUP BY app_id
        UNION ALL
        SELECT app_id AS appId, any(JSONExtractString(metadata, 'project_name')) AS projectName,
          0 AS events, max(started_at) AS latest FROM ${records} GROUP BY app_id
      ) GROUP BY appId ORDER BY lastSeen DESC LIMIT 100
    `);
  }

  async findDashboardOverview({
    appId,
    from,
    to,
    bucket,
  }: DashboardOverviewParams): Promise<DashboardOverviewData> {
    const { performance, error, behavior } = this.qualifiedTables;
    const params = { appId, from, to, bucket };
    const filter =
      'app_id = {appId:String} AND timestamp >= {from:UInt64} AND timestamp <= {to:UInt64}';
    const [behaviorSummaryRows, errorSummaryRows, performanceSummaryRows,
      timeline, vitals, errorTypes, issues, routes, recentEvents] = await Promise.all([
      this.dashboardQuery(`SELECT countIf(action = 'page_view') AS pageViews,
        uniqExactIf(if(user_id = '', session_id, user_id), action = 'page_view' AND (user_id != '' OR session_id != '')) AS visitors,
        uniqExactIf(session_id, action = 'page_view' AND session_id != '') AS sessions
        FROM ${behavior} WHERE ${filter}`, params),
      this.dashboardQuery(`SELECT count() AS errors,
        countIf(event_type = 'stability') AS stabilityIssues
        FROM ${error} WHERE ${filter}`, params),
      this.dashboardQuery(`SELECT countIf(event_type = 'request') AS requests,
        countIf(event_type = 'request' AND success = 0) AS failedRequests
        FROM ${performance} WHERE ${filter}`, params),
      this.dashboardQuery(`SELECT bucket, sum(pageViews) AS pageViews, sum(errors) AS errors
        FROM (
          SELECT intDiv(timestamp, {bucket:UInt64}) * {bucket:UInt64} AS bucket,
            countIf(action = 'page_view') AS pageViews, 0 AS errors
            FROM ${behavior} WHERE ${filter} GROUP BY bucket
          UNION ALL
          SELECT intDiv(timestamp, {bucket:UInt64}) * {bucket:UInt64} AS bucket,
            0 AS pageViews, count() AS errors
            FROM ${error} WHERE ${filter} GROUP BY bucket
        ) GROUP BY bucket ORDER BY bucket`, params),
      this.dashboardQuery(`SELECT upper(metric_name) AS metric,
        count() AS samples, quantileTDigest(0.75)(value) AS p75,
        countIf(rating = 'good') AS good, countIf(rating = 'needs-improvement') AS needsImprovement,
        countIf(rating = 'poor') AS poor
        FROM ${performance} WHERE ${filter} AND event_type = 'performance'
          AND upper(metric_name) IN ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')
        GROUP BY metric ORDER BY metric`, params),
      this.dashboardQuery(`SELECT if(event_type = 'stability', issue_type, error_type) AS type,
        count() AS count FROM ${error} WHERE ${filter}
        GROUP BY type ORDER BY count DESC LIMIT 8`, params),
      this.dashboardQuery(`SELECT toString(fingerprint_hash) AS fingerprint,
        any(message) AS message, any(error_type) AS type,
        count() AS count, uniqExactIf(session_id, session_id != '') AS affectedSessions,
        max(timestamp) AS lastSeen
        FROM ${error} WHERE ${filter} GROUP BY fingerprint_hash
        ORDER BY count DESC LIMIT 8`, params),
      this.dashboardQuery(`SELECT if(route = '', page_url, route) AS route,
        count() AS pageViews,
        uniqExactIf(if(user_id = '', session_id, user_id), user_id != '' OR session_id != '') AS visitors
        FROM ${behavior} WHERE ${filter} AND action = 'page_view'
        GROUP BY route ORDER BY pageViews DESC LIMIT 8`, params),
      this.dashboardQuery<EventRow>(`SELECT eventId, eventType, timestamp, route, label, detail
        FROM (${this.buildEventSource({})})
        ORDER BY timestamp DESC LIMIT 20`, params),
    ]);
    return {
      behaviorSummary: firstRowOrEmpty(behaviorSummaryRows),
      errorSummary: firstRowOrEmpty(errorSummaryRows),
      performanceSummary: firstRowOrEmpty(performanceSummaryRows),
      timeline,
      vitals,
      errorTypes,
      issues,
      routes,
      recentEvents,
    };
  }

  /** 事件明细分页查询：支持按类型、关键字过滤，并返回命中总数。 */
  async findDashboardEvents({
    appId,
    from,
    to,
    eventType,
    keyword,
    limit,
    offset,
  }: DashboardEventsParams): Promise<{ events: EventRow[]; total: number }> {
    const source = this.buildEventSource({ eventType });
    const params: Record<string, unknown> = { appId, from, to, limit, offset };
    if (eventType) params.eventType = eventType;

    const conditions: string[] = [];
    if (keyword) {
      conditions.push(
        "positionCaseInsensitiveUTF8(concat(label, ' ', route, ' ', detail), {keyword:String}) > 0",
      );
      params.keyword = keyword;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [events, totals] = await Promise.all([
      this.dashboardQuery<EventRow>(`SELECT eventId, eventType, timestamp, route, label, detail
        FROM (${source}) ${where}
        ORDER BY timestamp DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`, params),
      this.dashboardQuery<{ total: string }>(
        `SELECT count() AS total FROM (${source}) ${where}`,
        params,
      ),
    ]);
    return { events, total: Number(totals[0]?.total || 0) };
  }

  /**
   * 按 event_id 查找单条事件的完整字段。
   * 指定 eventType 时只查对应表，否则按 error → behavior → performance 依次查找。
   */
  async findDashboardEvent({
    appId,
    eventId,
    eventType,
  }: DashboardEventParams): Promise<DashboardEventDetail | null> {
    const mapped = eventType ? TABLE_BY_EVENT_TYPE.get(eventType) : undefined;
    if (eventType && !mapped) {
      throw new Error(`不支持的事件类型: ${eventType}`);
    }
    const categories: TableCategory[] = mapped ? [mapped] : EVENT_TABLES;

    for (const category of categories) {
      const rows = await this.dashboardQuery<Record<string, unknown>>(
        `SELECT *${EVENT_DETAIL_EXTRA_COLUMNS[category]} FROM ${this.qualifiedTables[category]}
          WHERE app_id = {appId:String} AND event_id = {eventId:UUID} LIMIT 1`,
        { appId, eventId },
      );
      if (rows[0]) return { category, event: rows[0] };
    }
    return null;
  }

  private async dashboardQuery<T = Record<string, unknown>>(
    query: string,
    queryParams: Record<string, unknown> = {},
  ): Promise<T[]> {
    const result = await this.client.query({
      query,
      query_params: queryParams,
      format: 'JSONEachRow',
    });
    return result.json<T>();
  }
}
