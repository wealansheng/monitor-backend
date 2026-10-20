import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { MonitorRepository } from '../src/database/monitor.repository';
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

  afterEach(async () => {
    await app?.close();
  });

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
      .expect(200);

    expect(response.body).toEqual({
      ok: true,
      eventId: EVENT_ID,
      eventType: 'behavior',
      bytes: 11,
    });
    expect(receive).toHaveBeenCalledTimes(1);

    const [ingest, meta] = receive.mock.calls[0];
    expect(ingest.isBatch).toBe(false);
    expect(ingest.bytes).toBe(Buffer.byteLength(JSON.stringify(VALID_EVENT)));
    expect(ingest.payloads[0]).toMatchObject({ event_id: EVENT_ID, event_type: 'behavior' });
    expect(typeof meta.ip).toBe('string');
    expect(typeof meta.userAgent).toBe('string');
  });

  it('批量信封按目标表写入并返回接收数量', async () => {
    const insertMany = jest.fn(
      async (_category: string, _events: Record<string, unknown>[]) => undefined,
    );
    app = await createTestApp({
      configure: (builder) =>
        builder.overrideProvider(MonitorRepository).useValue({ insertMany }),
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/monitor')
      .send({
        app_id: 'web-portal',
        projectName: 'frontend-project',
        sample_rate: 1,
        sdk_version: '2.0.0',
        send_time: 1712345679999,
        events: [
          {
            event_id: EVENT_ID,
            event_type: 'behavior',
            timestamp: 1712345678901,
            action: 'click',
          },
        ],
      })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.eventCount).toBe(1);
    expect(response.body.eventIds).toEqual([EVENT_ID]);

    expect(insertMany).toHaveBeenCalledTimes(1);
    const [category, events] = insertMany.mock.calls[0];
    expect(category).toBe('behavior');
    expect(events[0].project_name).toBe('frontend-project');
    expect(events[0].sdk_version).toBe('2.0.0');
    expect(events[0].sample_rate).toBe(1);
    expect(events[0].event_id).toBe(EVENT_ID);
  });

  it('业务层校验失败时返回 400 且不写入数据', async () => {
    const insertMany = jest.fn(
      async (_category: string, _events: Record<string, unknown>[]) => undefined,
    );
    app = await createTestApp({
      configure: (builder) =>
        builder.overrideProvider(MonitorRepository).useValue({ insertMany }),
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/monitor')
      .send({ app_id: 'web-portal', events: [{ event_id: 'not-a-uuid' }] })
      .expect(400);

    expect(response.body).toEqual({
      ok: false,
      error: 'events[0]: event_id must be a UUID',
    });
    expect(insertMany).not.toHaveBeenCalled();
  });

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

  it('方法不匹配时返回统一的 404', async () => {
    app = await createTestApp();

    const response = await request(app.getHttpServer()).get('/api/v1/monitor').expect(404);
    expect(response.body).toEqual({ ok: false, error: 'Not Found' });
  });
});

describe('POST /api/v1/monitor（请求体上限 32b）', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ env: { MAX_BODY_SIZE: '32b' } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('空请求体返回 400', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/monitor').expect(400);
    expect(response.body).toEqual({ ok: false, error: 'Empty body' });
  });

  it('超过上限的请求体返回 413', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/monitor')
      .set('content-type', 'text/plain')
      .send('x'.repeat(33))
      .expect(413);
    expect(response.body).toEqual({ ok: false, error: 'Payload too large' });
  });
});
