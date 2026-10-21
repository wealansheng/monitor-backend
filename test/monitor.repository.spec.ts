import {
  ClickHouseClientPort,
  ClickHouseQueryParams,
} from '../src/database/clickhouse-client.port';
import { MonitorRepository } from '../src/database/monitor.repository';

const TABLES = {
  performance: 'frontend_performance',
  error: 'frontend_error',
  behavior: 'frontend_behavior',
};

/** 记录每次查询参数的客户端替身。 */
function createQueryCapture(rowsFor: (params: ClickHouseQueryParams) => unknown[]) {
  const queries: ClickHouseQueryParams[] = [];
  const client: ClickHouseClientPort = {
    command: async () => undefined,
    insert: async () => undefined,
    query: async (params: ClickHouseQueryParams) => {
      queries.push(params);
      return { json: async () => rowsFor(params) as never[] };
    },
    close: async () => undefined,
  };
  return { client, queries };
}

function createRepository(client: ClickHouseClientPort, database = 'weils_monitor') {
  return new MonitorRepository({ client, database, tables: TABLES });
}

describe('MonitorRepository', () => {
  it('创建表并批量写入 ClickHouse', async () => {
    const createQueries: string[] = [];
    let insertParams: Record<string, unknown> | undefined;
    const client: ClickHouseClientPort = {
      command: async ({ query }) => {
        createQueries.push(query);
      },
      insert: async (params) => {
        insertParams = params as unknown as Record<string, unknown>;
      },
      query: async () => ({ json: async () => [] }),
      close: async () => undefined,
    };
    const repository = createRepository(client);

    await repository.initialize();
    await repository.insertMany('error', [{ event_id: 'id-1' }, { event_id: 'id-2' }]);

    expect(createQueries).toHaveLength(16);
    expect(createQueries.some((query) => query.includes("ADD COLUMN IF NOT EXISTS stack_frames String DEFAULT '[]'"))).toBe(true);
    expect(createQueries[0]).toMatch(/CREATE DATABASE IF NOT EXISTS `weils_monitor`/);
    expect(createQueries[1]).toMatch(
      /CREATE TABLE IF NOT EXISTS `weils_monitor`\.`frontend_performance`/,
    );
    expect(
      createQueries.some((query) =>
        /CREATE TABLE IF NOT EXISTS `weils_monitor`\.`frontend_error`/.test(query),
      ),
    ).toBe(true);
    expect(
      createQueries.some((query) =>
        /CREATE TABLE IF NOT EXISTS `weils_monitor`\.`frontend_behavior`/.test(query),
      ),
    ).toBe(true);
    expect(
      createQueries.some((query) =>
        /ALTER TABLE `weils_monitor`\.`frontend_behavior`[\s\S]*ADD COLUMN IF NOT EXISTS sample_rate/.test(
          query,
        ),
      ),
    ).toBe(true);

    for (const table of ['frontend_performance', 'frontend_error', 'frontend_behavior']) {
      expect(
        createQueries.some(
          (query) =>
            query.includes(`CREATE TABLE IF NOT EXISTS \`weils_monitor\`.\`${table}\``) &&
            query.includes("project_name LowCardinality(String) DEFAULT ''"),
        ),
      ).toBe(true);
      expect(
        createQueries.some(
          (query) =>
            query.includes(`ALTER TABLE \`weils_monitor\`.\`${table}\``) &&
            query.includes("ADD COLUMN IF NOT EXISTS project_name LowCardinality(String) DEFAULT ''"),
        ),
      ).toBe(true);
    }

    expect(
      createQueries.some((query) =>
        /ALTER TABLE `weils_monitor`\.`frontend_performance`[\s\S]*MODIFY COLUMN start_time Float64/.test(
          query,
        ),
      ),
    ).toBe(true);

    expect(insertParams).toEqual({
      table: '`weils_monitor`.`frontend_error`',
      values: [{ event_id: 'id-1' }, { event_id: 'id-2' }],
      format: 'JSONEachRow',
      clickhouse_settings: {
        input_format_defaults_for_omitted_fields: 1,
      },
    });
  });

  it('事件分页查询下推类型过滤、支持关键字与总数', async () => {
    const { client, queries } = createQueryCapture((params) =>
      /count\(\) AS total/.test(params.query)
        ? [{ total: '7' }]
        : [{ eventId: 'e-1', eventType: 'error' }],
    );
    const repository = createRepository(client);

    const page = await repository.findDashboardEvents({
      appId: 'vue-example',
      from: 100,
      to: 200,
      eventType: 'error',
      keyword: '白屏',
      limit: 20,
      offset: 40,
    });

    expect(page).toEqual({ events: [{ eventId: 'e-1', eventType: 'error' }], total: 7 });
    expect(queries).toHaveLength(2);

    const [pageQuery, countQuery] = queries;
    expect(pageQuery.query).toMatch(/FROM `weils_monitor`\.`frontend_error`/);
    expect(pageQuery.query).not.toContain('frontend_behavior');
    expect(pageQuery.query).not.toContain('frontend_performance');
    expect(pageQuery.query).toMatch(/event_type = \{eventType:String\}/);
    expect(pageQuery.query).toMatch(/positionCaseInsensitiveUTF8/);
    expect(pageQuery.query).toMatch(/LIMIT \{limit:UInt32\} OFFSET \{offset:UInt32\}/);
    expect(pageQuery.query_params).toEqual({
      appId: 'vue-example',
      from: 100,
      to: 200,
      limit: 20,
      offset: 40,
      eventType: 'error',
      keyword: '白屏',
    });
    expect(countQuery.query).toMatch(/count\(\) AS total/);
    expect(countQuery.query).toMatch(/positionCaseInsensitiveUTF8/);
    expect(countQuery.query).not.toContain('LIMIT');

    queries.length = 0;
    await repository.findDashboardEvents({
      appId: 'portal',
      from: 1,
      to: 2,
      eventType: undefined,
      keyword: '',
      limit: 20,
      offset: 0,
    });
    expect(queries[0].query).toMatch(/frontend_error/);
    expect(queries[0].query).toMatch(/frontend_behavior/);
    expect(queries[0].query).toMatch(/frontend_performance/);
    expect(queries[0].query).not.toContain('event_type = {eventType:String}');
    expect(queries[0].query).not.toContain('positionCaseInsensitiveUTF8');

    await expect(
      repository.findDashboardEvents({
        appId: 'portal',
        from: 1,
        to: 2,
        eventType: 'click',
        keyword: '',
        limit: 1,
        offset: 0,
      }),
    ).rejects.toThrow(/不支持的事件类型/);
  });

  it('单条事件详情按候选表依次查找并返回所属表', async () => {
    const { client, queries } = createQueryCapture((params) =>
      params.query.includes('frontend_error') ? [] : [{ event_id: 'e-9', action: 'click' }],
    );
    const repository = createRepository(client);

    const found = await repository.findDashboardEvent({ appId: 'vue-example', eventId: 'e-9' });
    expect(queries).toHaveLength(2);
    expect(queries[0].query).toMatch(
      /SELECT \*, toString\(fingerprint_hash\) AS fingerprint_hash FROM `weils_monitor`\.`frontend_error`/,
    );
    expect(queries[1].query).toMatch(/SELECT \* FROM `weils_monitor`\.`frontend_behavior`/);
    expect(queries[1].query_params).toEqual({ appId: 'vue-example', eventId: 'e-9' });
    expect(found).toEqual({ category: 'behavior', event: { event_id: 'e-9', action: 'click' } });

    queries.length = 0;
    const typed = await repository.findDashboardEvent({
      appId: 'vue-example',
      eventId: 'e-9',
      eventType: 'performance',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toMatch(/`weils_monitor`\.`frontend_performance`/);
    expect(typed?.category).toBe('performance');

    queries.length = 0;
    const absent = await repository.findDashboardEvent({
      appId: 'vue-example',
      eventId: 'e-9',
      eventType: 'stability',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toMatch(/`weils_monitor`\.`frontend_error`/);
    expect(absent).toBeNull();
  });

  it('按应用与事件 ID 参数化查询单条错误事件', async () => {
    const { client, queries } = createQueryCapture(() => [{ event_id: 'e-1' }]);
    const repository = createRepository(client, 'weils_monitor');

    const event = await repository.findError('web-portal', 'e-1');

    expect(event).toEqual({ event_id: 'e-1' });
    expect(queries[0].query_params).toEqual({ appId: 'web-portal', eventId: 'e-1' });
    expect(queries[0].query).toMatch(/FROM `weils_monitor`\.`frontend_error`/);
  });
});
