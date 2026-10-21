import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from './support/test-app';
import { RecordsRepository } from '../src/records/records.repository';
import { digest, parseRecord } from '../src/records/record.protocol';

const appId = 'record-app';
function chunk() {
  const now = Date.now();
  const payload = gzipSync(JSON.stringify([{ type: 2, timestamp: now, data: {} }])).toString('base64');
  return { app_id: appId, project_name: 'record-test', session_id: 'session', user_id: '', record_id: randomUUID(),
    page_url: 'https://example.test', route: '/', release: 'test', environment: 'test', sdk_version: 'test', rrweb_version: '2.1.7',
    protocol_version: 1, encoding: 'gzip-base64', started_at: now, ended_at: now + 1000, display_start: now,
    errors: [{ event_id: randomUUID(), timestamp: now + 50 }], end_reason: 'window', context_missing: false,
    raw_bytes: 100, encoded_bytes: payload.length, checksum: digest(payload), chunk_count: 1, chunk_index: 0, chunk_checksum: digest(payload), payload };
}
describe('recording ingestion and management', () => {
  let app: NestExpressApplication;
  const repository = { insert: jest.fn(async (_chunk: unknown) => {}), list: jest.fn(async (_query: unknown) => ({ records: [], total: 0 })), find: jest.fn(), chunks: jest.fn() };
  beforeAll(async () => {
    app = await createTestApp({ env: { MONITOR_DASHBOARD_TOKEN: 'record-token' }, configure: builder => builder.overrideProvider(RecordsRepository).useValue(repository) });
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { repository.insert.mockReset().mockResolvedValue(undefined); repository.list.mockClear(); repository.find.mockReset(); });
  it('acknowledges only after insertion and accepts identical retries', async () => {
    const value = chunk();
    for (let i = 0; i < 2; i++) {
      const result = await request(app.getHttpServer()).post('/api/v1/records').send(value).expect(200);
      expect(result.body).toEqual({ ok: true, record_id: value.record_id, chunk_index: 0, chunk_checksum: value.chunk_checksum });
    }
    expect(repository.insert).toHaveBeenCalledTimes(2);
  });
  it('does not acknowledge database failures', async () => {
    repository.insert.mockRejectedValueOnce(new Error('unavailable'));
    await request(app.getHttpServer()).post('/api/v1/records').send(chunk()).expect(500);
  });
  it.each([
    ['checksum', { chunk_checksum: '0'.repeat(64) }], ['range', { chunk_index: 1 }], ['encoding', { encoding: 'json' }],
    ['time', { ended_at: 1 }], ['error marker', { errors: [] }], ['identifier', { record_id: 'invalid' }],
  ])('rejects invalid %s', async (_label, fields) => {
    await request(app.getHttpServer()).post('/api/v1/records').send({ ...chunk(), ...fields }).expect(400);
    expect(repository.insert).not.toHaveBeenCalled();
  });
  it('enforces the independent 512KiB body limit', async () => {
    await request(app.getHttpServer()).post('/api/v1/records').send({ payload: 'x'.repeat(513 * 1024) }).expect(413);
  });
  it('requires management authorization and app isolation parameters', async () => {
    await request(app.getHttpServer()).get('/api/v1/dashboard/records').query({ app_id: appId }).expect(401);
    await request(app.getHttpServer()).get('/api/v1/dashboard/records').set('Authorization', 'Bearer record-token').expect(400);
    const result = await request(app.getHttpServer()).get('/api/v1/dashboard/records')
      .set('Authorization', 'Bearer record-token').query({ app_id: appId, session_id: 'session' }).expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(repository.list.mock.calls[0][0]).toMatchObject({ appId, sessionId: 'session' });
  });
  it('returns missing, incomplete and corrupt recording states without payload access', async () => {
    const id = randomUUID(); const endpoint = `/api/v1/dashboard/records/${id}/chunks?app_id=${appId}`;
    await request(app.getHttpServer()).get(endpoint).set('Authorization', 'Bearer record-token').expect(404);
    for (const status of ['incomplete', 'corrupt']) {
      repository.find.mockResolvedValue({ record_id: id, status });
      await request(app.getHttpServer()).get(endpoint).set('Authorization', 'Bearer record-token').expect(409);
    }
    expect(repository.chunks).not.toHaveBeenCalled();
  });
  it('validates multipart base64 boundaries', () => {
    const value = chunk();
    expect(() => parseRecord(Buffer.from(JSON.stringify({ ...value, encoded_bytes: 300000, chunk_count: 2 })))).toThrow();
  });
});
