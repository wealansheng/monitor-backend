import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { DashboardEventsParams, MonitorRepository } from '../src/database/monitor.repository';
import { createTestApp } from './support/test-app';

const TOKEN = 'secret-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const EVENT_ID = 'af5d9303-f5f4-41ad-b0ca-c1f2fa191c23';

const EMPTY_OVERVIEW = {
  behaviorSummary: {},
  errorSummary: {},
  performanceSummary: {},
  timeline: [],
  vitals: [],
  errorTypes: [],
  issues: [],
  routes: [],
  recentEvents: [],
};

describe('监控工作台聚合查询', () => {
  let app: NestExpressApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('要求令牌，并校验查询范围', async () => {
    app = await createTestApp({
      env: { MONITOR_DASHBOARD_TOKEN: TOKEN },
      configure: (builder) =>
        builder.overrideProvider(MonitorRepository).useValue({
          findDashboardApps: async () => [{ appId: 'portal' }],
          findDashboardOverview: async () => ({
            ...EMPTY_OVERVIEW,
            behaviorSummary: { pageViews: '12', visitors: '5', sessions: '6' },
            errorSummary: { errors: '2', stabilityIssues: '1' },
            performanceSummary: { requests: '8', failedRequests: '1' },
          }),
        }),
    });
    const base = '/api/v1/dashboard';

    const unauthorized = await request(app.getHttpServer()).get(`${base}/apps`).expect(401);
    expect(unauthorized.body).toEqual({ ok: false, error: 'Dashboard token required' });

    const badHours = await request(app.getHttpServer())
      .get(`${base}/overview?app_id=portal&hours=2`)
      .set(AUTH)
      .expect(400);
    expect(badHours.body).toEqual({ ok: false, error: 'hours must be 1, 6, 24, 72, or 168' });

    const missingApp = await request(app.getHttpServer())
      .get(`${base}/overview?hours=24`)
      .set(AUTH)
      .expect(400);
    expect(missingApp.body.error).toBe('app_id is required and must be at most 128 characters');

    const apps = await request(app.getHttpServer()).get(`${base}/apps`).set(AUTH).expect(200);
    expect(apps.body).toEqual({ ok: true, apps: [{ appId: 'portal' }] });

    const response = await request(app.getHttpServer())
      .get(`${base}/overview?app_id=portal&hours=24`)
      .set(AUTH)
      .expect(200);

    expect(response.body.summary).toEqual({
      pageViews: 12,
      visitors: 5,
      sessions: 6,
      errors: 2,
      stabilityIssues: 1,
      requests: 8,
      failedRequests: 1,
    });
    expect(response.body.hours).toBe(24);
    expect(response.body.appId).toBe('portal');
  });

  it('事件明细支持按类型、关键字与分页查询', async () => {
    const calls: DashboardEventsParams[] = [];
    app = await createTestApp({
      env: { MONITOR_DASHBOARD_TOKEN: TOKEN },
      configure: (builder) =>
        builder.overrideProvider(MonitorRepository).useValue({
          findDashboardEvents: async (params: DashboardEventsParams) => {
            calls.push(params);
            return { events: [{ eventId: 'e-1', eventType: 'error' }], total: 45 };
          },
        }),
    });
    const base = '/api/v1/dashboard';

    await request(app.getHttpServer()).get(`${base}/events?app_id=portal`).expect(401);

    const invalidType = await request(app.getHttpServer())
      .get(`${base}/events?app_id=portal&hours=24&event_type=click`)
      .set(AUTH)
      .expect(400);
    expect(invalidType.body.error).toMatch(/event_type/);

    await request(app.getHttpServer())
      .get(`${base}/events?app_id=portal&hours=24&limit=0`)
      .set(AUTH)
      .expect(400);

    await request(app.getHttpServer())
      .get(`${base}/events?app_id=portal&hours=2`)
      .set(AUTH)
      .expect(400);

    const response = await request(app.getHttpServer())
      .get(
        `${base}/events?app_id=portal&hours=24&event_type=error&keyword=%20%E7%99%BD%E5%B1%8F%20&limit=20&offset=20`,
      )
      .set(AUTH)
      .expect(200);

    expect(response.body).toMatchObject({
      eventType: 'error',
      keyword: '白屏',
      limit: 20,
      offset: 20,
      total: 45,
      hasMore: true,
    });
    expect(response.body.events).toHaveLength(1);

    const lastPage = await request(app.getHttpServer())
      .get(`${base}/events?app_id=portal&hours=24&offset=44`)
      .set(AUTH)
      .expect(200);
    expect(lastPage.body.hasMore).toBe(false);
    expect(lastPage.body.eventType).toBe('all');
    expect(lastPage.body.keyword).toBe('');

    // 空串参数（`?hours=&limit=&offset=`）应回退到默认值，而不是校验失败。
    const blankParams = await request(app.getHttpServer())
      .get(`${base}/events?app_id=portal&hours=&limit=&offset=&event_type=all`)
      .set(AUTH)
      .expect(200);
    expect(blankParams.body).toMatchObject({
      hours: 24,
      limit: 20,
      offset: 0,
      eventType: 'all',
      keyword: '',
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      appId: 'portal',
      eventType: 'error',
      keyword: '白屏',
      limit: 20,
      offset: 20,
    });
    expect(calls[1]).toMatchObject({
      appId: 'portal',
      eventType: undefined,
      keyword: '',
      limit: 20,
      offset: 44,
    });
    expect(calls[2]).toMatchObject({
      appId: 'portal',
      eventType: undefined,
      keyword: '',
      limit: 20,
      offset: 0,
    });
  });

  it('事件详情按 event_id 查询，并区分参数错误与未找到', async () => {
    const calls: Array<{ appId: string; eventId: string; eventType?: string }> = [];
    app = await createTestApp({
      env: { MONITOR_DASHBOARD_TOKEN: TOKEN },
      configure: (builder) =>
        builder.overrideProvider(MonitorRepository).useValue({
          findDashboardEvent: async (params: {
            appId: string;
            eventId: string;
            eventType?: string;
          }) => {
            calls.push(params);
            if (params.eventId === EVENT_ID) {
              return {
                category: 'error',
                event: {
                  event_id: EVENT_ID,
                  message: '来自演示页的 Vue 组件错误',
                  stack: 'at App.vue:1:1',
                },
              };
            }
            return null;
          },
        }),
    });
    const base = '/api/v1/dashboard';

    await request(app.getHttpServer())
      .get(`${base}/event?app_id=portal&event_id=${EVENT_ID}`)
      .expect(401);

    const invalidId = await request(app.getHttpServer())
      .get(`${base}/event?app_id=portal&event_id=not-a-uuid`)
      .set(AUTH)
      .expect(400);
    expect(invalidId.body.error).toMatch(/UUID/);

    await request(app.getHttpServer())
      .get(`${base}/event?app_id=portal&event_id=${EVENT_ID}&event_type=click`)
      .set(AUTH)
      .expect(400);

    await request(app.getHttpServer())
      .get(`${base}/event?app_id=portal&event_id=11111111-2222-3333-4444-555555555555`)
      .set(AUTH)
      .expect(404);

    const response = await request(app.getHttpServer())
      .get(`${base}/event?app_id=portal&event_id=${EVENT_ID}&event_type=error`)
      .set(AUTH)
      .expect(200);

    expect(response.body.appId).toBe('portal');
    expect(response.body.eventId).toBe(EVENT_ID);
    expect(response.body.category).toBe('error');
    expect(response.body.event.message).toBe('来自演示页的 Vue 组件错误');
    expect(calls.at(-1)?.eventType).toBe('error');
  });

  it('未配置令牌时管理接口返回 404', async () => {
    app = await createTestApp();

    await request(app.getHttpServer())
      .get('/api/v1/dashboard/apps')
      .set(AUTH)
      .expect(404);
  });
});
