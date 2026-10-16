'use strict';

const { getSchemaStatements, quoteIdentifier } = require('../database/schema');

class MonitorRepository {
  constructor({ client, database, tables }) {
    this.client = client;
    this.database = database;
    this.tables = tables;
    this.qualifiedTables = Object.fromEntries(
      Object.entries(tables).map(([category, table]) => [
        category,
        `${quoteIdentifier(database)}.${quoteIdentifier(table)}`,
      ]),
    );
  }

  async initialize() {
    const statements = getSchemaStatements({ database: this.database, tables: this.tables });
    for (const query of statements) {
      await this.client.command({ query });
    }
  }

  async insert(category, event) {
    return this.insertMany(category, [event]);
  }

  async insertMany(category, events) {
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

  async findError(appId, eventId) {
    const result = await this.client.query({
      query: `SELECT event_id, app_id, release, error_type, message, stack, filename, lineno, colno, page_url
        FROM ${this.qualifiedTables.error}
        WHERE app_id = {appId:String} AND event_id = {eventId:UUID}
        LIMIT 1`,
      query_params: { appId, eventId },
      format: 'JSONEachRow',
    });
    const rows = await result.json();
    return rows[0] || null;
  }

  async dashboardQuery(query, queryParams = {}) {
    const result = await this.client.query({
      query,
      query_params: queryParams,
      format: 'JSONEachRow',
    });
    return result.json();
  }

  async findDashboardApps() {
    const { performance, error, behavior } = this.qualifiedTables;
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
      ) GROUP BY appId ORDER BY lastSeen DESC LIMIT 100
    `);
  }

  async findDashboardOverview({ appId, from, to, bucket }) {
    const { performance, error, behavior } = this.qualifiedTables;
    const params = { appId, from, to, bucket };
    const filter = 'app_id = {appId:String} AND timestamp >= {from:UInt64} AND timestamp <= {to:UInt64}';
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
      this.dashboardQuery(`SELECT eventId, eventType, timestamp, route, label, detail FROM (
        SELECT toString(event_id) AS eventId, event_type AS eventType, timestamp, route,
          if(message = '', issue_type, message) AS label, error_type AS detail
          FROM ${error} WHERE ${filter}
        UNION ALL
        SELECT toString(event_id) AS eventId, event_type AS eventType, timestamp, route,
          action AS label, category AS detail
          FROM ${behavior} WHERE ${filter}
        UNION ALL
        SELECT toString(event_id) AS eventId, event_type AS eventType, timestamp, route,
          if(metric_name = '', url, metric_name) AS label, rating AS detail
          FROM ${performance} WHERE ${filter}
      ) ORDER BY timestamp DESC LIMIT 20`, params),
    ]);
    return {
      behaviorSummary: behaviorSummaryRows[0] || {},
      errorSummary: errorSummaryRows[0] || {},
      performanceSummary: performanceSummaryRows[0] || {},
      timeline, vitals, errorTypes, issues, routes, recentEvents,
    };
  }
}

module.exports = { MonitorRepository };
