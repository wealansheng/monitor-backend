'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { access, mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { SourceMapService } = require('../src/services/sourcemap.service');
const { MonitorRepository } = require('../src/repositories/monitor.repository');
const { uploadDirectory, prunePublicMaps } = require('../scripts/upload-sourcemaps');

const eventId = 'd6dd3d25-5a95-41ba-acf5-83ac856b1125';
const appId = 'web-portal';
const asset = 'https://cdn.example.com/assets/app.js';
const map = (source, mappings = 'AAAA') => ({ version: 3, file: 'app.js', sources: [source], names: [], mappings });

async function withService(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'monitor-sourcemaps-'));
  const state = { event: null };
  const repository = { async findError(requestApp, requestId) {
    assert.equal(requestApp, appId);
    assert.equal(requestId, eventId);
    return state.event;
  } };
  const service = new SourceMapService({ directory, repository });
  try { await callback(service, state); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function errorEvent(release, stack, errorType = 'js_error') {
  return { event_id: eventId, app_id: appId, release, error_type: errorType, message: 'boom', stack,
    page_url: 'https://site.example.com/page', filename: '', lineno: 0, colno: 0 };
}

test('query-time mapping isolates releases and handles V8 and Firefox frames', async () => {
  await withService(async (service, state) => {
    await service.upload({ app_id: appId, release: 'v1', kind: 'client', artifact: asset, map: map('src/old.ts') });
    await service.upload({ app_id: appId, release: 'v2', kind: 'client', artifact: asset, map: map('src/new.ts', 'AAKA') });
    state.event = errorEvent('v1', `TypeError: boom\n    at render (${asset}?cache=1:1:1)\nhandler@${asset}:1:1`, 'framework_error');
    const oldResult = await service.symbolicate(appId, eventId);
    assert.equal(oldResult.status, 'mapped');
    assert.equal(oldResult.frames.length, 2);
    assert.deepEqual(oldResult.frames.map((frame) => frame.original.source), ['src/old.ts', 'src/old.ts']);
    assert.equal(oldResult.frames[0].original.column, 1);

    state.event = errorEvent('v2', `Error: boom\n    at ${asset}:1:1`, 'promise_error');
    const newResult = await service.symbolicate(appId, eventId);
    assert.equal(newResult.frames[0].original.source, 'src/new.ts');
    assert.equal(newResult.frames[0].original.line, 6);
  });
});

test('late upload, partial mapping, missing release and empty stack keep original evidence', async () => {
  await withService(async (service, state) => {
    state.event = errorEvent('late', `Error: boom\n    at ${asset}:1:1\n    at other (https://cdn.example.com/other.js:2:3)`);
    const before = await service.symbolicate(appId, eventId);
    assert.equal(before.status, 'unmapped');
    assert.deepEqual(before.frames.map((frame) => frame.status), ['missing_map', 'missing_map']);
    await service.upload({ app_id: appId, release: 'late', kind: 'client', artifact: asset, map: map('src/late.ts') });
    const after = await service.symbolicate(appId, eventId);
    assert.equal(after.status, 'partial');
    assert.deepEqual(after.frames.map((frame) => frame.status), ['mapped', 'missing_map']);
    assert.equal(after.stack, state.event.stack);
    state.event.release = '';
    assert.equal((await service.symbolicate(appId, eventId)).frames[0].status, 'missing_release');
    state.event.stack = '';
    const empty = await service.symbolicate(appId, eventId);
    assert.equal(empty.reason, 'missing_stack');
    assert.deepEqual(empty.frames, []);
  });
});

test('window.onerror location is used when stack is unavailable', async () => {
  await withService(async (service, state) => {
    await service.upload({ app_id: appId, release: 'v1', kind: 'client', artifact: asset, map: map('src/fallback.ts') });
    state.event = { ...errorEvent('v1', ''), filename: asset, lineno: 1, colno: 1 };
    const result = await service.symbolicate(appId, eventId);
    assert.equal(result.status, 'mapped');
    assert.equal(result.frames[0].original.source, 'src/fallback.ts');
  });
});

test('Nuxt server frame uses build-relative artifact and ignores node internals', async () => {
  await withService(async (service, state) => {
    await service.upload({ app_id: appId, release: 'ssr-1', kind: 'server', artifact: 'chunks/pages/index.mjs', map: map('pages/index.vue') });
    state.event = errorEvent('ssr-1', 'Error: SSR failed\n    at render (file:///app/.output/server/chunks/pages/index.mjs:1:1)\n    at internal (node:internal/process/task_queues:95:5)', 'nuxt_ssr_error');
    const result = await service.symbolicate(appId, eventId);
    assert.equal(result.status, 'partial');
    assert.equal(result.frames[0].original.source, 'pages/index.vue');
    assert.equal(result.frames[1].status, 'unsupported_frame');
  });
});

test('upload validates maps and rejects conflicting release artifacts', async () => {
  await withService(async (service) => {
    const input = { app_id: appId, release: 'v1', kind: 'client', artifact: asset, map: map('src/app.ts') };
    assert.equal((await service.upload(input)).created, true);
    assert.equal((await service.upload(input)).created, false);
    await assert.rejects(service.upload({ ...input, map: map('src/other.ts') }), { statusCode: 409 });
    await assert.rejects(service.upload({ ...input, map: { version: 3 } }), { statusCode: 400 });
    await assert.rejects(service.upload({ ...input, kind: 'server', artifact: '../secret' }), { statusCode: 400 });
  });
});

test('admin routes require token and leave monitor ingestion unchanged', async () => {
  await withService(async (service, state) => {
    state.event = errorEvent('v1', `Error: boom\n    at ${asset}:1:1`);
    let received = false;
    const app = createApp({
      monitorService: { async receive() { received = true; return { eventId }; } },
      sourceMapService: service,
      config: {
        app: { maxBodySize: '5mb' },
        clickhouse: { database: 'test', tables: { performance: 'p', error: 'e', behavior: 'b' } },
        sourceMaps: { token: 'secret-token', maxBodySize: '1mb' },
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const route = `${base}/api/v1/monitor/errors/${eventId}/symbolication?app_id=${appId}`;
      assert.equal((await fetch(route)).status, 401);
      assert.equal((await fetch(`${base}/api/v1/sourcemaps`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })).status, 401);
      const upload = await fetch(`${base}/api/v1/sourcemaps`, {
        method: 'POST', headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId, release: 'v1', kind: 'client', artifact: asset, map: map('src/app.ts') }),
      });
      assert.equal(upload.status, 201);
      const mapped = await fetch(route, { headers: { authorization: 'Bearer secret-token' } });
      assert.equal(mapped.status, 200);
      assert.equal((await mapped.json()).frames[0].original.source, 'src/app.ts');
      const monitor = await fetch(`${base}/api/v1/monitor`, { method: 'POST', body: '{}' });
      assert.equal(monitor.status, 200);
      assert.equal(received, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('repository looks up one error with parameterized app and event IDs', async () => {
  let request;
  const repository = new MonitorRepository({
    client: { async query(options) { request = options; return { async json() { return [{ event_id: eventId }]; } }; } },
    database: 'weils_monitor',
    tables: { performance: 'p', error: 'frontend_error', behavior: 'b' },
  });
  const event = await repository.findError(appId, eventId);
  assert.equal(event.event_id, eventId);
  assert.deepEqual(request.query_params, { appId, eventId });
  assert.match(request.query, /FROM `weils_monitor`\.`frontend_error`/);
});

test('release script uploads built client maps and prunes the public copy', async () => {
  await withService(async (service, state) => {
    const buildDir = await mkdtemp(path.join(tmpdir(), 'monitor-build-'));
    const assetDir = path.join(buildDir, 'assets');
    await mkdir(assetDir);
    const mapFile = path.join(assetDir, 'app.js.map');
    await writeFile(mapFile, JSON.stringify(map('src/from-build.ts')));
    const app = createApp({
      monitorService: { async receive() { return {}; } },
      sourceMapService: service,
      config: {
        app: { maxBodySize: '5mb' },
        clickhouse: { database: 'test', tables: { performance: 'p', error: 'e', behavior: 'b' } },
        sourceMaps: { token: 'upload-token', maxBodySize: '1mb' },
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const count = await uploadDirectory({
        directory: buildDir, kind: 'client', baseUrl: 'https://cdn.example.com/',
        endpoint: `http://127.0.0.1:${server.address().port}`, appId, release: 'script-v1', token: 'upload-token',
      });
      assert.equal(count, 1);
      state.event = errorEvent('script-v1', 'Error: boom\n    at https://cdn.example.com/assets/app.js:1:1');
      assert.equal((await service.symbolicate(appId, eventId)).frames[0].original.source, 'src/from-build.ts');
      await prunePublicMaps(buildDir);
      await assert.rejects(access(mapFile), { code: 'ENOENT' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(buildDir, { recursive: true, force: true });
    }
  });
});
