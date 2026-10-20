import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createTestApp } from './support/test-app';

describe('服务基础路由', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET / 返回服务信息与数据表清单', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.body).toEqual({
      service: 'monitor service',
      endpoint: 'POST /api/v1/monitor',
      storage: 'ClickHouse',
      tables: [
        'weils_monitor.frontend_performance',
        'weils_monitor.frontend_error',
        'weils_monitor.frontend_behavior',
      ],
    });
  });

  it('未命中的路由返回 JSON 404', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/unknown').expect(404);
    expect(response.body).toEqual({ ok: false, error: 'Not Found' });
  });

  it('不暴露 x-powered-by', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('未配置令牌时不启用管理接口', async () => {
    await request(app.getHttpServer()).get('/api/v1/dashboard/apps').expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/monitor/errors/d6dd3d25-5a95-41ba-acf5-83ac856b1125/symbolication?app_id=a`)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/sourcemaps')
      .set('content-type', 'application/json')
      .send({})
      .expect(404);
  });
});
