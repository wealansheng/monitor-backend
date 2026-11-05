/** Replay HTTP 回归：验证缓冲回执、独立体积限制、鉴权及完整性状态。 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { ServiceUnavailableException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from './support/test-app';
import { IngestionBuffer } from '../src/ingestion/ingestion-buffer.service';
import { RecordsRepository } from '../src/records/records.repository';
import { digest, parseRecord } from '../src/records/record.protocol';

const appId = 'record-app';
/** 创建合法 Replay 分片样本，供 HTTP 协议用例覆盖不同异常场景。 */
function chunk() {
  const now = Date.now();
  const payload = gzipSync(JSON.stringify([{ type: 2, timestamp: now, data: {} }])).toString('base64');
  return { app_id: appId, project_name: 'record-test', session_id: 'session', user_id: '', record_id: randomUUID(),
    page_url: 'https://example.test', route: '/', release: 'test', environment: 'test', sdk_version: 'test', rrweb_version: '2.1.7',
    protocol_version: 1, encoding: 'gzip-base64', started_at: now, ended_at: now + 1000, display_start: now,
    errors: [{ event_id: randomUUID(), timestamp: now + 50 }], end_reason: 'window', context_missing: false,
    raw_bytes: 100, encoded_bytes: payload.length, checksum: digest(payload), chunk_count: 1, chunk_index: 0, chunk_checksum: digest(payload), payload };
}
/** 验证 Replay 采集与管理端 HTTP 协议。 */
describe('recording ingestion and management', () => {
  let app: NestExpressApplication;
  const enqueue = jest.fn(async (_chunk: unknown) => {});
  const repository = { list: jest.fn(async (_query: unknown) => ({ records: [], total: 0 })), find: jest.fn(), chunks: jest.fn() };
  /** 建立本组用例的连接、样本与独立测试资源。 */
  beforeAll(async () => {
    app = await createTestApp({ env: { MONITOR_DASHBOARD_TOKEN: 'record-token' }, configure: builder => builder.overrideProvider(RecordsRepository).useValue(repository).overrideProvider(IngestionBuffer).useValue({enqueue}) });
  });
  /** 释放连接及本组创建的临时资源，保留共享服务中的其他数据。 */
  afterAll(async () => { await app.close(); });
  /** 重置本用例状态，避免前一个用例的数据干扰。 */
  beforeEach(() => { enqueue.mockReset().mockResolvedValue(undefined); repository.list.mockClear(); repository.find.mockReset(); });
  /** 验证回执表示缓冲已接收，并允许完全相同的上传重试。 */
  it('acknowledges Redis admission and accepts identical retries', async () => {
    const value = chunk();
    for (let i = 0; i < 2; i++) {
      const result = await request(app.getHttpServer()).post('/api/v1/records').send(value).expect(200);
      expect(result.body).toEqual({ ok: true, record_id: value.record_id, chunk_index: 0, chunk_checksum: value.chunk_checksum });
    }
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
  /** 验证 Redis 失败时不返回成功回执。 */
  it('does not acknowledge Redis failures', async () => {
    enqueue.mockRejectedValueOnce(new ServiceUnavailableException('unavailable'));
    await request(app.getHttpServer()).post('/api/v1/records').send(chunk()).expect(503);
  });
  it.each([
    ['checksum', { chunk_checksum: '0'.repeat(64) }], ['range', { chunk_index: 1 }], ['encoding', { encoding: 'json' }],
    ['time', { ended_at: 1 }], ['error marker', { errors: [] }], ['identifier', { record_id: 'invalid' }],
  ])('rejects invalid %s', async (_label, fields) => {
    await request(app.getHttpServer()).post('/api/v1/records').send({ ...chunk(), ...fields }).expect(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
  /** 验证 Replay 独立的 512 KiB 请求体上限。 */
  it('enforces the independent 512KiB body limit', async () => {
    await request(app.getHttpServer()).post('/api/v1/records').send({ payload: 'x'.repeat(513 * 1024) }).expect(413);
  });
  /** 验证管理鉴权和必需的应用隔离参数。 */
  it('requires management authorization and app isolation parameters', async () => {
    await request(app.getHttpServer()).get('/api/v1/dashboard/records').query({ app_id: appId }).expect(401);
    await request(app.getHttpServer()).get('/api/v1/dashboard/records').set('Authorization', 'Bearer record-token').expect(400);
    const result = await request(app.getHttpServer()).get('/api/v1/dashboard/records')
      .set('Authorization', 'Bearer record-token').query({ app_id: appId, session_id: 'session' }).expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(repository.list.mock.calls[0][0]).toMatchObject({ appId, sessionId: 'session' });
  });
  /** 验证不存在、缺片与冲突录制的状态及载荷访问限制。 */
  it('returns missing, incomplete and corrupt recording states without payload access', async () => {
    const id = randomUUID(); const endpoint = `/api/v1/dashboard/records/${id}/chunks?app_id=${appId}`;
    await request(app.getHttpServer()).get(endpoint).set('Authorization', 'Bearer record-token').expect(404);
    for (const status of ['incomplete', 'corrupt']) {
      repository.find.mockResolvedValue({ record_id: id, status });
      await request(app.getHttpServer()).get(endpoint).set('Authorization', 'Bearer record-token').expect(409);
    }
    expect(repository.chunks).not.toHaveBeenCalled();
  });
  /** 验证多片 Base64 长度、填充与分片边界。 */
  it('validates multipart base64 boundaries', () => {
    const value = chunk();
    expect(() => parseRecord(Buffer.from(JSON.stringify({ ...value, encoded_bytes: 300000, chunk_count: 2 })))).toThrow();
  });
});
