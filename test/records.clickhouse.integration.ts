import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from './support/test-app';
import { CLICKHOUSE_CLIENT } from '../src/database/database.constants';
import { ClickHouseClientPort } from '../src/database/clickhouse-client.port';
import { getSchemaStatements } from '../src/database/schema';
import { digest } from '../src/records/record.protocol';

/** Explicit opt-in integration command. Creates and removes only its unique scratch database. */
describe('real ClickHouse replay integration', () => {
  const database = `replay_test_${randomUUID().replaceAll('-', '')}`;
  let app: NestExpressApplication;
  let client: ClickHouseClientPort;
  let run: (query: string, params?: Record<string, unknown>, input?: string) => string;
  beforeAll(async () => {
    const local = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).map(line => line.split(/=(.*)/s).slice(0, 2)).filter(parts => parts[0]));
    run = (query, params = {}, input) => {
      try { return execFileSync('wsl', [
      '-d', process.env.REPLAY_CLICKHOUSE_WSL || 'Ubuntu', '--exec', '/home/administrator/.local/bin/clickhouse', 'client',
      '--user', local.CLICKHOUSE_USERNAME || 'root', '--password', local.CLICKHOUSE_PASSWORD || '123456', '--query', query,
      ...Object.entries(params).map(([key, value]) => `--param_${key}=${String(value)}`),
    ], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }); }
      catch (error) { throw new Error(`ClickHouse command failed: ${String((error as { stderr?: unknown }).stderr || 'No diagnostics').replaceAll(local.CLICKHOUSE_PASSWORD || '123456', '[redacted]')}`); }
    };
    client = {
      command: async ({ query }) => run(query),
      insert: async ({ table, values }) => run(`INSERT INTO ${table} FORMAT JSONEachRow`, {}, values.map(value => JSON.stringify(value)).join('\n')),
      query: async ({ query, query_params }) => ({ json: async <T>() => run(`${query} FORMAT JSONEachRow`, query_params).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T) }),
      close: async () => {},
    };
    const statements = getSchemaStatements({ database, tables: { performance: 'frontend_performance', error: 'frontend_error', behavior: 'frontend_behavior' } });
    for (const query of statements) await client.command({ query });
    app = await createTestApp({ env: { CLICKHOUSE_DATABASE: database, MONITOR_DASHBOARD_TOKEN: 'integration-token' },
      configure: builder => builder.overrideProvider(CLICKHOUSE_CLIENT).useValue(client) });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    if (run && /^replay_test_[a-f0-9]{32}$/.test(database)) run(`DROP DATABASE IF EXISTS ${database}`);
  });
  it('persists out-of-order multipart uploads, deduplicates retries and preserves conflicts after merge', async () => {
    const start = Date.now(); const recordId = randomUUID(); const errorId = randomUUID();
    const raw = JSON.stringify([{ type: 2, timestamp: start, data: { noise: randomBytes(300000).toString('base64') } }]);
    const payload = gzipSync(raw).toString('base64');
    const count = Math.ceil(payload.length / (256 * 1024));
    expect(count).toBeGreaterThan(1);
    const common = { app_id: 'integration', record_id: recordId, session_id: 'integration-session', user_id: 'visitor', route: '/checkout',
      started_at: start, ended_at: start + 1000, display_start: start, errors: [{ event_id: errorId, timestamp: start + 10 }],
      protocol_version: 1, rrweb_version: '2.1.7', encoding: 'gzip-base64', end_reason: 'window', context_missing: false,
      raw_bytes: Buffer.byteLength(raw), encoded_bytes: payload.length, checksum: digest(payload), chunk_count: count };
    const parts = Array.from({ length: count }, (_, chunk_index) => {
      const part = payload.slice(chunk_index * 256 * 1024, (chunk_index + 1) * 256 * 1024);
      return { ...common, chunk_index, chunk_checksum: digest(part), payload: part };
    });
    const http = app.getHttpServer();
    const get = (url: string) => request(http).get(`/api/v1/dashboard${url}`).query({ app_id: 'integration' }).set('Authorization', 'Bearer integration-token');
    await request(http).post('/api/v1/records').send(parts[1]).expect(200);
    expect((await get(`/records/${recordId}`).expect(200)).body.record.status).toBe('incomplete');
    for (const part of parts) await request(http).post('/api/v1/records').send(part).expect(200);
    await request(http).post('/api/v1/records').send(parts[0]).expect(200);
    const detail = (await get(`/records/${recordId}`).expect(200)).body.record;
    expect(detail.status).toBe('complete'); expect(detail.received_chunks).toBe(count);
    expect((await get('/records').expect(200)).body.total).toBe(1);
    expect((await get(`/errors/${errorId}/records`).expect(200)).body.records[0].record_id).toBe(recordId);
    const returned = (await get(`/records/${recordId}/chunks`).query({ limit: 16 }).expect(200)).body.chunks;
    expect(returned.map((part: any) => part.payload).join('')).toBe(payload);
    await request(http).get(`/api/v1/dashboard/records/${recordId}`).query({ app_id: 'different-app' }).set('Authorization', 'Bearer integration-token').expect(404);
    await request(http).post('/api/v1/records').send({ ...parts[0], route: '/conflict' }).expect(200);
    run(`OPTIMIZE TABLE ${database}.event_record FINAL`);
    expect((await get(`/records/${recordId}`).expect(200)).body.record.status).toBe('corrupt');
    expect((await get('/records').query({ route: '/checkout' }).expect(200)).body.records[0].status).toBe('corrupt');
    await get(`/records/${recordId}/chunks`).expect(409);
  }, 60_000);
  it('records with the SDK, persists in ClickHouse and plays from the dashboard error link in Chromium', async () => {
    const { chromium } = require('../../monitor-frontend/node_modules/@playwright/test');
    const children: ChildProcess[] = [];
    let browser: any;
    const startVite = (cwd: string, args: string[]) => {
      const child = spawn(process.execPath, [resolve(cwd, 'node_modules/vite/bin/vite.js'), ...args], { cwd, windowsHide: true, stdio: 'ignore' });
      children.push(child);
    };
    async function ready(url: string) {
      for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error(`Test server did not start: ${url}`);
    }
    try {
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      if (!address || typeof address === 'string') throw new Error('Test server has no TCP address');
      const origin = `http://127.0.0.1:${address.port}`;
      startVite(resolve('../weils-monitor/packages/replay'), ['--config', 'test/vite.config.ts']);
      startVite(resolve('../monitor-frontend'), ['--host', '127.0.0.1', '--port', '8877', '--strictPort']);
      await Promise.all([ready('http://127.0.0.1:5188/fixture.html'), ready('http://127.0.0.1:8877')]);
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('**/api/v1/**', async (route: any) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, timeout: 60_000 });
        await route.fulfill({ response });
      });
      await page.goto('http://127.0.0.1:5188/fixture.html');
      await page.waitForFunction(() => typeof (globalThis as any).beginMonitor === 'function');
      await page.evaluate(() => (globalThis as any).beginMonitor());
      await page.locator('#input').fill('do-not-store-this'); await page.locator('#input').blur();
      await page.locator('#mutate').click();
      const errorId = randomUUID();
      await page.evaluate((eventId: string) => (globalThis as any).monitor.report({ event_id: eventId, event_type: 'error', error_type: 'js_error', message: 'Browser integration error' }), errorId);
      await page.waitForFunction(() => (globalThis as any).statuses.some((status: any) => status.type === 'uploaded'), undefined, { timeout: 30_000 });
      await context.addInitScript(() => sessionStorage.setItem('weils-dashboard-token', 'integration-token'));
      await page.goto(`http://127.0.0.1:8877/events/${errorId}?type=error`);
      await page.getByRole('link', { name: /播放错误现场/ }).click({ timeout: 30_000 });
      await page.getByRole('button', { name: '播放回放' }).waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: '播放回放' }).click();
      await page.waitForTimeout(500);
      const content = await page.frameLocator('.replay-viewport iframe').locator('body').innerText();
      expect(content).toContain('DOM changed'); expect(content).not.toContain('blocked-secret');
      const input = await page.frameLocator('.replay-viewport iframe').locator('#input').inputValue();
      expect(input).not.toBe('do-not-store-this');
    } finally {
      await browser?.close();
      children.forEach(child => child.kill());
    }
  }, 120_000);
});
