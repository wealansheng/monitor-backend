/** 真实 MySQL 集成：验证迁移、查询聚合、Replay 冲突与保留期清理。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { monitorConfiguration } from '../src/config/configuration';
import { dataSourceOptions, initializeDatabase } from '../src/database/data-source';
import { MonitorRepository } from '../src/database/monitor.repository';
import { quoteIdentifier } from '../src/database/schema';
import { RecordChunk, digest } from '../src/records/record.protocol';
import { RecordsRepository } from '../src/records/records.repository';
import { BatchWriter } from '../src/ingestion/batch-writer.service';
import { IngestionBuffer } from '../src/ingestion/ingestion-buffer.service';
import { PartitionMaintenance } from '../src/database/partition-maintenance';
import { retentionCutoff } from '../src/database/retention';
import { createTestApp, stubIngestion } from './support/test-app';
import { AppModule } from '../src/app.module';
import { MONITOR_CONFIG } from '../src/config/config.constants';
import { NEST_APP_OPTIONS, setupApp } from '../src/app.setup';

// 仅通过专用命令显式运行；创建随机临时库，清理时只允许删除本测试创建的库。
/** 验证独立临时库中的真实 MySQL 存储行为。 */
describe('real MySQL storage integration', () => {
  const database = `monitor_test_${randomUUID().replaceAll('-', '')}`;
  const config = monitorConfiguration({
    ...process.env, MYSQL_DATABASE: database, MYSQL_PERFORMANCE_TABLE: 'test_performance',
    MYSQL_ERROR_TABLE: 'test_error', MYSQL_BEHAVIOR_TABLE: 'test_behavior', MYSQL_RECORD_TABLE: 'test_record',
    MYSQL_AUTO_MIGRATE: 'false', MONITOR_DASHBOARD_TOKEN: 'integration-token',
  });
  let source: DataSource | undefined;
  let app: NestExpressApplication | undefined;
  let repository: MonitorRepository;
  let records: RecordsRepository;
  const now = Date.now();
  const auth = { Authorization: 'Bearer integration-token' };
  const event = (type: string, fields: Record<string, unknown> = {}) => ({
    app_id: 'integration', event_id: randomUUID(), event_type: type, timestamp: now, ...fields,
  });

  /** 建立本组用例的连接、样本与独立测试资源。 */
  beforeAll(async () => {
    await initializeDatabase(config.mysql);
    await initializeDatabase(config.mysql);
    source = new DataSource(dataSourceOptions({
      ...config.mysql, username: config.mysql.adminUsername, password: config.mysql.adminPassword,
    }));
    await source.initialize();
    app = await createTestApp({
      env: {
        ...process.env, MYSQL_DATABASE: database, MYSQL_PERFORMANCE_TABLE: 'test_performance',
        MYSQL_ERROR_TABLE: 'test_error', MYSQL_BEHAVIOR_TABLE: 'test_behavior', MYSQL_RECORD_TABLE: 'test_record',
        MYSQL_AUTO_MIGRATE: 'false', MONITOR_DASHBOARD_TOKEN: 'integration-token',
      },
      configure: builder => builder.overrideProvider(DataSource).useValue(source),
    });
    repository = app.get(MonitorRepository);
    records = app.get(RecordsRepository);
  }, 60000);

  /** 释放连接及本组创建的临时资源，保留共享服务中的其他数据。 */
  afterAll(async () => {
    await app?.close();
    if (source?.isInitialized) await source.destroy();
    // 初始化失败时可能没有可用连接，只有连接仍有效时才执行资源清理。
    const admin = new DataSource({
      ...dataSourceOptions(config.mysql), database: undefined, entities: [], migrations: [],
      username: config.mysql.adminUsername, password: config.mysql.adminPassword,
    });
    if (source && /^monitor_test_[a-f0-9]{32}$/.test(database)) {
      await admin.initialize();
      try { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`); }
      finally { await admin.destroy(); }
    }
  });

  /** 验证迁移可重复执行、同步关闭且索引完整。 */
  it('runs versioned migrations once, keeps synchronization disabled and has expected indexes', async () => {
    expect(dataSourceOptions(config.mysql).synchronize).toBe(false);
    expect(await source!.query('SELECT name FROM monitor_migrations')).toHaveLength(2);
    expect(await source!.runMigrations()).toEqual([]);
    const indexes: { Key_name: string }[] = await source!.query('SHOW INDEX FROM test_record');
    expect(indexes.some(index => index.Key_name === 'uq_record_variant')).toBe(true);
    const version = await source!.query('SELECT VERSION() AS version');
    console.info('Verified MySQL:', version[0].version);
  });

  /** 验证六类事件经过 HTTP 接收后的默认值与详情字段。 */
  it('persists all six event types through HTTP with defaults and compatible detail fields', async () => {
    const input = [
      event('performance', { metric_name: 'LCP', value: 100, start_time: 0.25 }),
      event('request', { url: '/api', method: 'POST', success: false, request_body: { test: 1 } }),
      event('resource', { resource_url: '/app.js', cached: true }),
      event('error', { error_type: 'js', message: '白屏_%\\ CAFÉ', tags: { version: 'v1' },
        stack_frames: [{ filename: 'app.js', lineno: 1, colno: 2 }], release: 'v1' }),
      event('stability', { issue_type: 'blank_screen' }),
      event('behavior', { action: 'page_view', route: '/checkout', session_id: 'session' }),
    ];
    await request(app!.getHttpServer()).post('/api/v1/monitor').send({ events: input }).expect(204);
    const messages = (app!.get(IngestionBuffer).enqueue as jest.Mock).mock.calls.flatMap(call=>call[0]);
    await new BatchWriter(source!,config).write(messages.map(message=>JSON.stringify(message)));
    (app!.get(IngestionBuffer).enqueue as jest.Mock).mockClear();
    for (const value of input) {
      const found = await repository.findDashboardEvent({
        appId: 'integration', eventId: value.event_id.toUpperCase(), eventType: value.event_type,
      });
      expect(found!.event.event_id).toBe(value.event_id);
      expect(found!.event.timestamp).toBe(now);
      expect(found!.event.id).toBeUndefined();
      expect(found!.event.environment).toBe('production');
      expect(found!.event.received_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      const receivedAt = new Date(String(found!.event.received_at).replace(' ', 'T') + 'Z').getTime();
      expect(Math.abs(receivedAt - Date.now())).toBeLessThan(30000);
    }
    const error = await repository.findDashboardEvent({ appId: 'integration', eventId: input[3].event_id });
    expect(error!.event.tags).toEqual({ version: 'v1' });
    expect(error!.event.stack_frames).toBe(JSON.stringify([{ filename: 'app.js', lineno: 1, colno: 2 }]));
    expect(error!.event.fingerprint_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await repository.findError('integration', input[3].event_id))!.release).toBe('v1');
    expect(await repository.findError('other-app', input[3].event_id)).toBeNull();
    expect(await repository.findDashboardEvent({ appId: 'integration', eventId: input[3].event_id, eventType: 'stability' })).toBeNull();
    const requestDetail = await repository.findDashboardEvent({ appId: 'integration', eventId: input[1].event_id });
    expect(requestDetail!.event.request_body).toBe('{"test":1}');
  });

  /** 验证中文与通配符字面搜索、大小写兼容、分页总数及跨应用隔离。 */
  it('handles literal Chinese/wildcard search, case folding, total counts, paging and app isolation', async () => {
    const base = { appId: 'integration', from: now - 1000, to: now + 1000, limit: 1, offset: 0, keyword: '白屏_%\\ café' };
    const found = await repository.findDashboardEvents(base);
    expect(found.total).toBe(1);
    expect(found.events[0].label).toContain('白屏');
    expect((await repository.findDashboardEvents({ ...base, keyword: "x' OR 1=1 --" })).total).toBe(0);
    expect((await repository.findDashboardEvents({ ...base, appId: 'other-app' })).total).toBe(0);
    const all = await repository.findDashboardEvents({ ...base, keyword: '' });
    expect(all.total).toBe(6);
    const next = await repository.findDashboardEvents({ ...base, keyword: '', offset: 1 });
    expect(next.events[0].eventId).not.toBe(all.events[0].eventId);
    expect((await repository.findDashboardEvents({ ...base, eventType: 'request', keyword: '' })).total).toBe(1);
  });

  /** 验证准确聚合、路由回退、指纹分组、P75 与数值响应类型。 */
  it('aggregates exact counts, route fallback, fingerprints, p75 and numeric response types', async () => {
    const metrics = [10, 20, 30, 40].map(value => event('performance', {
      app_id: 'statistics', metric_name: 'lcp', value, rating: value === 40 ? 'poor' : 'good',
    }));
    await repository.insertMany('performance', metrics);
    await repository.insertMany('performance', [event('request', { app_id: 'statistics', success: 0 })]);
    await repository.insertMany('behavior', [
      event('behavior', { app_id: 'statistics', action: 'page_view', user_id: 'u', session_id: 's', route: '', page_url: '/fallback' }),
      event('behavior', { app_id: 'statistics', action: 'page_view', user_id: 'u', session_id: 's2', route: '/fallback' }),
    ]);
    await repository.insertMany('error', [
      event('error', { app_id: 'statistics', error_type: 'js', message: 'same', session_id: 's' }),
      event('error', { app_id: 'statistics', error_type: 'js', message: 'same', session_id: 's2' }),
      event('stability', { app_id: 'statistics', issue_type: 'blank' }),
    ]);
    const stats = await repository.findDashboardOverview({ appId: 'statistics', from: now - 1000, to: now + 1000, bucket: 3600000 });
    expect(stats.behaviorSummary).toEqual({ pageViews: 2, visitors: 1, sessions: 2 });
    expect(stats.errorSummary).toEqual({ errors: 3, stabilityIssues: 1 });
    expect(stats.performanceSummary).toEqual({ requests: 1, failedRequests: 1 });
    expect(stats.vitals).toEqual([{ metric: 'LCP', samples: 4, p75: 30, good: 3, needsImprovement: 0, poor: 1 }]);
    expect(stats.routes).toEqual([{ route: '/fallback', pageViews: 2, visitors: 1 }]);
    expect(stats.issues.find(issue => issue.message === 'same')).toMatchObject({ count: 2, affectedSessions: 2 });
    expect(stats.timeline[0]).toMatchObject({ pageViews: 2, errors: 3 });
    expect(typeof stats.timeline[0].bucket).toBe('number');
    expect(stats.recentEvents).toHaveLength(10);
    const empty = await repository.findDashboardOverview({ appId: 'missing', from: now - 1, to: now + 1, bucket: 3600000 });
    expect(empty.behaviorSummary).toEqual({ pageViews: 0, visitors: 0, sessions: 0 });
    expect(empty.vitals).toEqual([]);
  });

  /** 生成具有真实 gzip 编码与摘要的多片录制，供乱序、去重和冲突测试复用。 */
  function recording(): RecordChunk[] {
    const started = now - 1000;
    const payload = gzipSync(randomBytes(300000)).toString('base64');
    const count = Math.ceil(payload.length / (256 * 1024));
    const base = {
      app_id: 'replay-only', project_name: 'Replay project', record_id: randomUUID(), session_id: 'replay-session', user_id: 'user',
      route: '/checkout', page_url: 'https://example.test', release: 'v1', environment: 'test', sdk_version: 'test',
      rrweb_version: '2.1.7', protocol_version: 1, encoding: 'gzip-base64', started_at: started,
      ended_at: now, display_start: started, errors: [{ event_id: randomUUID(), timestamp: started + 10 }],
      end_reason: 'window', context_missing: false, raw_bytes: 300000, encoded_bytes: payload.length,
      checksum: digest(payload), chunk_count: count,
    };
    return Array.from({ length: count }, (_, chunk_index) => {
      const part = payload.slice(chunk_index * 256 * 1024, (chunk_index + 1) * 256 * 1024);
      return { ...base, chunk_index, chunk_checksum: digest(part), payload: part };
    });
  }

  /** 验证 Replay 乱序、并发重试去重、分页筛选和仅含录制的应用。 */
  it('supports out-of-order chunks, concurrent retry deduplication, paging, filtering and replay-only apps', async () => {
    const chunks = recording();
    const first = chunks[0];
    await records.insert(chunks[1]);
    const stored = await source!.query('SELECT received_at FROM test_record WHERE record_id = ?', [first.record_id]);
    expect(Math.abs(stored[0].received_at.getTime() - Date.now())).toBeLessThan(30000);
    expect((await records.find(first.app_id, first.record_id))!.status).toBe('incomplete');
    await Promise.all(Array.from({ length: 8 }, () => records.insert(first)));
    expect((await records.find(first.app_id, first.record_id))!).toMatchObject({ status: 'complete', received_chunks: chunks.length });
    const result = await records.list({ appId: first.app_id, hours: 24, limit: 20, offset: 0, errorId: first.errors[0].event_id, route: '/checkout', sessionId: 'replay-session', userId: 'user' });
    expect(result.total).toBe(1);
    expect((await records.list({ appId: first.app_id, hours: 24, limit: 20, offset: 0, route: '/missing' })).total).toBe(0);
    expect((await records.chunks(first.app_id, first.record_id, 1, 0))[0].payload).toBe(first.payload);
    expect((await records.chunks(first.app_id, first.record_id, 1, 1))[0].payload).toBe(chunks[1].payload);
    expect((await records.chunks(first.app_id, first.record_id, 16, 0)).map(part => part.payload).join('')).toBe(chunks.map(part => part.payload).join(''));
    expect(await records.find('other-app', first.record_id)).toBeUndefined();
    expect((await repository.findDashboardApps()).find(value => value.appId === 'replay-only'))
      .toMatchObject({ projectName: 'Replay project', events: 0, lastSeen: first.started_at });

    await records.insert({ ...first, route: '/conflict' });
    expect((await records.find(first.app_id, first.record_id))!.status).toBe('corrupt');
    const filtered = await records.list({ appId: first.app_id, hours: 24, limit: 20, offset: 0, route: '/checkout' });
    expect(filtered.records[0].status).toBe('corrupt');
    await request(app!.getHttpServer()).get(`/api/v1/dashboard/records/${first.record_id}/chunks`)
      .query({ app_id: first.app_id }).set(auth).expect(409);
  });

  /** 验证摘要冲突证据保留，其他数据库错误继续抛出。 */
  it('preserves checksum conflict evidence and propagates non-duplicate database failures', async () => {
    const [first] = recording();
    await records.insert(first);
    await records.insert({ ...first, payload: 'different', chunk_checksum: digest('different') });
    expect((await records.find(first.app_id, first.record_id))!.status).toBe('corrupt');
    await expect(records.insert({ ...first, app_id: 'x'.repeat(129) })).rejects.toThrow();
  });

  /** 验证各表批量清理保留边界数据与新数据。 */
  it('deletes expiration batches using each policy while retaining boundary rows and fresh rows', async () => {
    const cleanupNow = now + 10000;
    for (const category of ['performance','error','behavior'] as const) {
      const boundary = retentionCutoff(config.mysql.retentionDays,cleanupNow);
      await repository.insertMany(category, Array.from({ length: 1001 }, () =>
        event(category, { app_id: 'retention', timestamp: boundary - 1 })));
      await repository.insertMany(category, [
        event(category, { app_id: 'retention', timestamp: boundary }),
        event(category, { app_id: 'retention', timestamp: boundary + 1 }),
      ]);
    }
    const [old] = recording();
    const boundary = retentionCutoff(config.mysql.retentionDays,cleanupNow);
    await records.insert({ ...old, app_id: 'retention', started_at: boundary - 1 });
    await records.insert({ ...old, app_id: 'retention', record_id: randomUUID(), started_at: boundary });
    await new PartitionMaintenance(source!,config.mysql).maintain(cleanupNow);
    for (const category of ['performance', 'error', 'behavior'] as const) {
      const rows = await source!.query(`SELECT timestamp FROM ${quoteIdentifier(config.mysql.tables[category])} WHERE app_id = ?`, ['retention']);
      expect(rows).toHaveLength(2);
    }
    expect((await source!.query('SELECT record_id FROM test_record WHERE app_id = ?', ['retention']))).toHaveLength(1);
  });

  /** 验证 SDK 重试仍追加，并稳定选取应用最新名称。 */
  it('keeps ordinary retries append-only and latest application names deterministic', async () => {
    const value = event('behavior', { app_id: 'names', project_name: 'old' });
    await repository.insertMany('behavior', [value, value]);
    await repository.insertMany('error', [event('error', { app_id: 'names', project_name: 'new', timestamp: now + 1 })]);
    expect((await repository.findDashboardApps()).find(row => row.appId === 'names')).toMatchObject({ projectName: 'new', events: 3, lastSeen: now + 1 });
  });

  /** 验证 Nest 管理真实连接池、自动迁移与关闭释放。 */
  it('starts the real Nest-managed connection, runs automatic migrations and closes the pool', async () => {
    const temporary = `monitor_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new DataSource({ ...dataSourceOptions(config.mysql), database: undefined, entities: [], migrations: [],
      username: config.mysql.adminUsername, password: config.mysql.adminPassword });
    await admin.initialize();
    let realApp: NestExpressApplication | undefined;
    let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>> | undefined;
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(temporary)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
      moduleRef = await stubIngestion(Test.createTestingModule({ imports: [AppModule] }))
        .overrideProvider(MONITOR_CONFIG).useValue({ ...config, mysql: { ...config.mysql,
          database: temporary, autoMigrate: true, username: config.mysql.adminUsername, password: config.mysql.adminPassword,
        } }).compile();
      realApp = moduleRef.createNestApplication<NestExpressApplication>(NEST_APP_OPTIONS);
      await setupApp(realApp);
      const connection = realApp.get(DataSource);
      expect(connection.isInitialized).toBe(true);
      expect(await connection.query('SELECT name FROM monitor_migrations')).toHaveLength(2);
      await request(realApp.getHttpServer()).get('/').expect(200).expect(response => {
        expect(response.body.storage).toBe('MySQL');
      });
      await realApp.close();
      expect(connection.isInitialized).toBe(false);
    } finally {
      if (realApp) await realApp.close();
      else await moduleRef?.close();
      if (/^monitor_test_[a-f0-9]{32}$/.test(temporary)) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(temporary)}`);
      await admin.destroy();
    }
  });
});
