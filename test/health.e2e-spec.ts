/** 基础 HTTP 回归：验证健康信息、统一错误和管理接口关闭行为。 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createTestApp } from './support/test-app';

/** 验证服务基础路由。 */
describe('服务基础路由', () => {
  let app: NestExpressApplication;

  /** 建立本组用例的连接、样本与独立测试资源。 */
  beforeAll(async () => {
    app = await createTestApp();
  });

  /** 释放连接及本组创建的临时资源，保留共享服务中的其他数据。 */
  afterAll(async () => {
    await app.close();
  });

  /** 验证GET / 返回服务信息与数据表清单。 */
  it('GET / 返回服务信息与数据表清单', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.body).toEqual({
      service: 'monitor service',
      endpoint: 'POST /api/v1/monitor',
      storage: 'MySQL',
      tables: [
        'weils_monitor.frontend_performance',
        'weils_monitor.frontend_error',
        'weils_monitor.frontend_behavior',
        'weils_monitor.event_record',
      ],
    });
  });

  /** 验证未命中的路由返回 JSON 404。 */
  it('未命中的路由返回 JSON 404', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/unknown').expect(404);
    expect(response.body).toEqual({ ok: false, error: 'Not Found' });
  });

  /** 验证不暴露 x-powered-by。 */
  it('不暴露 x-powered-by', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  /** 验证未配置令牌时不启用管理接口。 */
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
