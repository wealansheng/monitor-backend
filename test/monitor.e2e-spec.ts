/** 普通事件 HTTP 回归：验证 204、缓冲接收、请求大小及非法输入。 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { IngestionBuffer } from '../src/ingestion/ingestion-buffer.service';
import { MonitorService } from '../src/monitor/monitor.service';
import { MonitorIngestPayload, MonitorRequestMeta } from '../src/monitor/monitor.types';
import { createTestApp } from './support/test-app';

const EVENT_ID = 'd6dd3d25-5a95-41ba-acf5-83ac856b1125';

const VALID_EVENT = {
  event_id: EVENT_ID,
  event_type: 'behavior',
  timestamp: 1712345678901,
  app_id: 'web-portal',
  action: 'click',
};

describe('POST /api/v1/monitor', () => {
  let app: NestExpressApplication;

  /** 检查并清理本用例状态，恢复模拟对象或隔离资源。 */
  afterEach(async () => {
    await app?.close();
  });

  /** 验证接收单事件上报并把解析结果交给业务层。 */
  it('接收单事件上报并把解析结果交给业务层', async () => {
    const receive = jest.fn(
      async (_payload: MonitorIngestPayload, _meta: MonitorRequestMeta) => ({
        eventId: EVENT_ID,
        eventType: 'behavior',
        bytes: 11,
      }),
    );
    app = await createTestApp({
      configure: (builder) =>
        builder.overrideProvider(MonitorService).useValue({ receive }),
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/monitor')
      .send(VALID_EVENT)
      .expect(204);

    expect(response.text).toBe('');
    expect(receive).toHaveBeenCalledTimes(1);

    const [ingest, meta] = receive.mock.calls[0];
    expect(ingest.isBatch).toBe(false);
    expect(ingest.bytes).toBe(Buffer.byteLength(JSON.stringify(VALID_EVENT)));
    expect(ingest.payloads[0]).toMatchObject({ event_id: EVENT_ID, event_type: 'behavior' });
    expect(typeof meta.ip).toBe('string');
    expect(typeof meta.userAgent).toBe('string');
  });

  /** 验证批量信封进入 Redis 缓冲，不直接写入数据库。 */
  it('批量信封进入 Redis 缓冲，不直接写入数据库', async () => {
    const enqueue=jest.fn(async (_messages: unknown[])=>undefined);
    app=await createTestApp({configure:builder=>builder.overrideProvider(IngestionBuffer).useValue({enqueue})});
    await request(app.getHttpServer()).post('/api/v1/monitor').send({app_id:'web-portal',projectName:'frontend-project',
      events:[{event_id:EVENT_ID,event_type:'behavior',timestamp:1712345678901,action:'click'}]}).expect(204);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toEqual([expect.objectContaining({kind:'event',
      payload:expect.objectContaining({app_id:'web-portal',project_name:'frontend-project'})})]);
  });

  /** 验证业务层校验失败时返回 400 且不写入数据。 */
  it('业务层校验失败时返回 400 且不写入数据', async () => {
    const enqueue = jest.fn(
      async (_messages: unknown[]) => undefined,
    );
    app = await createTestApp({
      configure: (builder) =>
        builder.overrideProvider(IngestionBuffer).useValue({ enqueue }),
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/monitor')
      .send({ app_id: 'web-portal', events: [{ event_id: 'not-a-uuid' }] })
      .expect(400);

    expect(response.body).toEqual({
      ok: false,
      error: 'events[0]: event_id must be a UUID',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  /** 验证非法 JSON 与非对象请求体。 */
  it('非法 JSON 与非对象请求体', async () => {
    app = await createTestApp();

    const malformed = await request(app.getHttpServer())
      .post('/api/v1/monitor')
      .set('content-type', 'application/json')
      .send('{"broken"')
      .expect(400);
    expect(malformed.body).toEqual({ ok: false, error: 'Invalid JSON body' });

    const array = await request(app.getHttpServer())
      .post('/api/v1/monitor')
      .set('content-type', 'application/json')
      .send('[1,2,3]')
      .expect(400);
    expect(array.body).toEqual({ ok: false, error: 'JSON body must be an object' });
  });

  /** 验证方法不匹配时返回统一的 404。 */
  it('方法不匹配时返回统一的 404', async () => {
    app = await createTestApp();

    const response = await request(app.getHttpServer()).get('/api/v1/monitor').expect(404);
    expect(response.body).toEqual({ ok: false, error: 'Not Found' });
  });
});

/** 验证POST /api/v1/monitor（请求体上限 32b）。 */
describe('POST /api/v1/monitor（请求体上限 32b）', () => {
  let app: NestExpressApplication;

  /** 建立本组用例的连接、样本与独立测试资源。 */
  beforeAll(async () => {
    app = await createTestApp({ env: { MAX_BODY_SIZE: '32b' } });
  });

  /** 释放连接及本组创建的临时资源，保留共享服务中的其他数据。 */
  afterAll(async () => {
    await app.close();
  });

  /** 验证空请求体返回 400。 */
  it('空请求体返回 400', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/monitor').expect(400);
    expect(response.body).toEqual({ ok: false, error: 'Empty body' });
  });

  /** 验证超过上限的请求体返回 413。 */
  it('超过上限的请求体返回 413', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/monitor')
      .set('content-type', 'text/plain')
      .send('x'.repeat(33))
      .expect(413);
    expect(response.body).toEqual({ ok: false, error: 'Payload too large' });
  });
});
