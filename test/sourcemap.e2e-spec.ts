import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { ErrorEventRow, MonitorRepository } from '../src/database/monitor.repository';
import { SourceMapService } from '../src/sourcemap/sourcemap.service';
import { prunePublicMaps, uploadDirectory } from '../src/sourcemap/upload-sourcemaps.util';
import { createTestApp } from './support/test-app';
import { uploadSourceMaps } from '../src/upload-sourcemaps';

const eventId = 'd6dd3d25-5a95-41ba-acf5-83ac856b1125';
const appId = 'web-portal';
const token = 'secret-token';
const asset = 'https://cdn.example.com/assets/app.js';

const map = (source: string) => ({
  version: 3,
  file: 'app.js',
  sources: [source],
  names: [],
  mappings: 'AAAA',
});

const errorEvent: ErrorEventRow = {
  event_id: eventId,
  app_id: appId,
  release: 'v1',
  error_type: 'js_error',
  message: 'boom',
  stack: `Error: boom\n    at ${asset}:1:1`,
  page_url: 'https://site.example.com/page',
  filename: '',
  lineno: 0,
  colno: 0,
};

async function createTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe('Source Map 管理接口', () => {
  let app: NestExpressApplication;
  let directory: string;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('工作台令牌只读源码，不能上传 map，原始文件不可下载', async () => {
    directory = await createTemporaryDirectory('monitor-private-maps-');
    const findError = jest.fn(async (requestedApp: string) => requestedApp === appId ? errorEvent : null);
    app = await createTestApp({
      env: { SOURCEMAP_ADMIN_TOKEN: token, MONITOR_DASHBOARD_TOKEN: 'read-only', SOURCEMAP_DIR: directory },
      configure: (builder) => builder.overrideProvider(MonitorRepository).useValue({ findError }),
    });
    const upload = await request(app.getHttpServer()).post('/api/v1/sourcemaps')
      .set('Authorization', `Bearer ${token}`)
      .send({ app_id: appId, release: 'v1', kind: 'client', artifact: asset,
        map: { ...map('src/app.ts'), sourcesContent: ['throw new Error("boom")'] } }).expect(201);
    const route = `/api/v1/dashboard/errors/${eventId}/symbolication?app_id=${appId}`;
    await request(app.getHttpServer()).get(route).expect(401);
    await request(app.getHttpServer()).get(route).set('Authorization', `Bearer ${token}`).expect(401);
    expect(findError).not.toHaveBeenCalled();
    const result = await request(app.getHttpServer()).get(route).set('Authorization', 'Bearer read-only').expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.frames[0].context.lines).toEqual(['throw new Error("boom")']);
    await request(app.getHttpServer()).get(`/api/v1/dashboard/errors/${eventId}/symbolication?app_id=other`)
      .set('Authorization', 'Bearer read-only').expect(404);
    await request(app.getHttpServer()).post('/api/v1/sourcemaps').set('Authorization', 'Bearer read-only').send({}).expect(401);
    for (const location of ['/mapdata', '/mapdata/', '/mapdata/anything.json', '/assets/app.js.map']) {
      await request(app.getHttpServer()).get(location).set('Authorization', `Bearer ${token}`).expect(404);
    }
    expect(upload.body.created).toBe(true);
  });

  it('需要令牌，上传后即可还原错误堆栈，且不影响上报接口', async () => {
    directory = await createTemporaryDirectory('monitor-sourcemaps-admin-');
    app = await createTestApp({
      env: { SOURCEMAP_ADMIN_TOKEN: token, SOURCEMAP_DIR: directory },
      configure: (builder) =>
        builder.overrideProvider(MonitorRepository).useValue({
          findError: async () => errorEvent,
          insertMany: async () => undefined,
        }),
    });

    const symbolicationRoute = `/api/v1/monitor/errors/${eventId}/symbolication?app_id=${appId}`;

    await request(app.getHttpServer()).get(symbolicationRoute).expect(401);

    const unauthorized = await request(app.getHttpServer())
      .post('/api/v1/sourcemaps')
      .set('content-type', 'application/json')
      .send({})
      .expect(401);
    expect(unauthorized.body).toEqual({ ok: false, error: 'Unauthorized' });

    const upload = await request(app.getHttpServer())
      .post('/api/v1/sourcemaps')
      .set({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
      .send({ app_id: appId, release: 'v1', kind: 'client', artifact: asset, map: map('src/app.ts') })
      .expect(201);
    expect(upload.body).toMatchObject({ ok: true, created: true, release: 'v1' });

    const mapped = await request(app.getHttpServer())
      .get(symbolicationRoute)
      .set({ authorization: `Bearer ${token}` })
      .expect(200);
    expect(mapped.body.frames[0].original.source).toBe('src/app.ts');

    // 上报接口不受管理接口影响。
    const monitor = await request(app.getHttpServer())
      .post('/api/v1/monitor')
      .send({
        event_id: eventId,
        event_type: 'behavior',
        timestamp: 1712345678901,
        app_id: appId,
        action: 'click',
      })
      .expect(200);
    expect(monitor.body.ok).toBe(true);
  });

  it('上传接口区分空请求体与非法 JSON', async () => {
    directory = await createTemporaryDirectory('monitor-sourcemaps-body-');
    app = await createTestApp({
      env: { SOURCEMAP_ADMIN_TOKEN: token, SOURCEMAP_DIR: directory },
    });

    const empty = await request(app.getHttpServer())
      .post('/api/v1/sourcemaps')
      .set({ authorization: `Bearer ${token}` })
      .expect(400);
    expect(empty.body).toEqual({ ok: false, error: 'Empty body' });

    const malformed = await request(app.getHttpServer())
      .post('/api/v1/sourcemaps')
      .set({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
      .send('{')
      .expect(400);
    expect(malformed.body).toEqual({ ok: false, error: 'Invalid JSON body' });
  });
});

describe('sourcemaps:upload 脚本', () => {
  let app: NestExpressApplication;
  let directory: string;
  let buildDir: string;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  });

  it('客户端和服务端全部上传后才清理；上传失败保留 map 并向调用方抛错', async () => {
    directory = await createTemporaryDirectory('monitor-upload-command-');
    buildDir = await createTemporaryDirectory('monitor-upload-artifacts-');
    const clientDir = path.join(buildDir, 'public');
    const serverDir = path.join(buildDir, 'server');
    await mkdir(clientDir);
    await mkdir(serverDir);
    const clientMap = path.join(clientDir, 'app.js.map');
    const serverMap = path.join(serverDir, 'server.mjs.map');
    await writeFile(clientMap, JSON.stringify(map('src/client.ts')));
    // Invalid server map makes the second upload fail after the client upload succeeds.
    await writeFile(serverMap, JSON.stringify({ version: 2 }));
    app = await createTestApp({ env: { SOURCEMAP_ADMIN_TOKEN: token, SOURCEMAP_DIR: directory } });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const env = { SOURCEMAP_SERVER: `http://127.0.0.1:${port}`, SOURCEMAP_ADMIN_TOKEN: token,
      SOURCEMAP_APP_ID: appId, SOURCEMAP_RELEASE: 'command-v1', SOURCEMAP_CLIENT_DIR: clientDir,
      SOURCEMAP_SERVER_DIR: serverDir, SOURCEMAP_CLIENT_BASE_URL: 'https://cdn.example.com/' };
    await expect(uploadSourceMaps(env)).rejects.toThrow('HTTP 400');
    await expect(access(clientMap)).resolves.toBeUndefined();
    await expect(access(serverMap)).resolves.toBeUndefined();
    await writeFile(serverMap, JSON.stringify(map('src/server.ts')));
    expect(await uploadSourceMaps(env)).toBe(2);
    await expect(access(clientMap)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(serverMap)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('上传构建产物中的客户端 Source Map，并可清理公开副本', async () => {
    directory = await createTemporaryDirectory('monitor-sourcemaps-script-');
    buildDir = await createTemporaryDirectory('monitor-build-');

    const assetDir = path.join(buildDir, 'assets');
    await mkdir(assetDir);
    const mapFile = path.join(assetDir, 'app.js.map');
    await writeFile(mapFile, JSON.stringify(map('src/from-build.ts')));

    const state = { event: { ...errorEvent, release: 'script-v1' } as ErrorEventRow };
    app = await createTestApp({
      env: { SOURCEMAP_ADMIN_TOKEN: 'upload-token', SOURCEMAP_DIR: directory },
      configure: (builder) =>
        builder.overrideProvider(MonitorRepository).useValue({
          findError: async () => state.event,
          insertMany: async () => undefined,
        }),
    });

    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;

    const count = await uploadDirectory({
      directory: buildDir,
      kind: 'client',
      baseUrl: 'https://cdn.example.com/',
      endpoint: `http://127.0.0.1:${port}`,
      appId,
      release: 'script-v1',
      token: 'upload-token',
    });

    expect(count).toBe(1);

    const service = app.get(SourceMapService);
    const result = await service.symbolicate(appId, eventId);
    expect(result.frames[0].original?.source).toBe('src/from-build.ts');

    await prunePublicMaps(buildDir);
    await expect(access(mapFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('客户端上传缺少 baseUrl 时直接报错', async () => {
    buildDir = await createTemporaryDirectory('monitor-build-guard-');
    await writeFile(path.join(buildDir, 'app.js.map'), JSON.stringify(map('src/app.ts')));

    await expect(
      uploadDirectory({
        directory: buildDir,
        kind: 'client',
        endpoint: 'http://127.0.0.1:1',
        appId,
        release: 'v1',
        token: 'token',
      }),
    ).rejects.toThrow(/baseUrl is required/);
  });
});
