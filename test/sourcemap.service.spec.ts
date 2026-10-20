import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ErrorEventRow, MonitorRepository } from '../src/database/monitor.repository';
import { SourceMapService } from '../src/sourcemap/sourcemap.service';
import { rejectedStatus } from './support/http-status';

const eventId = 'd6dd3d25-5a95-41ba-acf5-83ac856b1125';
const appId = 'web-portal';
const asset = 'https://cdn.example.com/assets/app.js';

const map = (source: string, mappings = 'AAAA') => ({
  version: 3,
  file: 'app.js',
  sources: [source],
  names: [],
  mappings,
});

function errorEvent(release: string, stack: string, errorType = 'js_error'): ErrorEventRow {
  return {
    event_id: eventId,
    app_id: appId,
    release,
    error_type: errorType,
    message: 'boom',
    stack,
    page_url: 'https://site.example.com/page',
    filename: '',
    lineno: 0,
    colno: 0,
  };
}

/** 每个用例独立的临时目录与仓库替身。 */
async function withService(
  callback: (
    service: SourceMapService,
    state: { event: ErrorEventRow | null },
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'monitor-sourcemaps-'));
  const state: { event: ErrorEventRow | null } = { event: null };
  const repository = {
    findError: async (requestApp: string, requestId: string) => {
      expect(requestApp).toBe(appId);
      expect(requestId).toBe(eventId);
      return state.event;
    },
  };
  const service = new SourceMapService({
    directory,
    repository: repository as unknown as MonitorRepository,
  });

  try {
    await callback(service, state);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('SourceMapService', () => {
  it('优先使用完整结构化栈，提取源码并保持列号从 1 开始', async () => {
    await withService(async (service, state) => {
      const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
      lines[5] = '<script>not executable</script>';
      await service.upload({ app_id: appId, release: 'v1', kind: 'client', artifact: asset,
        map: { ...map('src/app.ts', 'AAKE'), sourcesContent: [lines.join('\r\n')] } });
      state.event = { ...errorEvent('v1', 'Error: stale\n at https://wrong.test/x.js:1:1'),
        stack_frames: JSON.stringify([
          { filename: asset, lineno: 1, colno: 1, function_name: 'render' },
          { function_name: 'native', raw: 'at native' },
          { filename: asset, lineno: 1, colno: 1, function_name: 'caller' },
        ]) };
      const result = await service.symbolicate(appId, eventId);
      expect(result.status).toBe('partial');
      expect(result.frames.map((frame) => frame.label)).toEqual(['render', 'native', 'caller']);
      expect(result.frames[0].original).toMatchObject({ source: 'src/app.ts', line: 6, column: 3 });
      expect(result.frames[0].context).toEqual({ start_line: 1, lines: lines.slice(0, 11) });
      expect(result.frames[1].status).toBe('unsupported_frame');
      expect(result.stack).toContain('stale');
    });
  });

  it('源码片段截断文件边界，缺少 sourcesContent 时仍还原位置', async () => {
    await withService(async (service, state) => {
      for (const release of ['with-content', 'without-content']) {
        await service.upload({ app_id: appId, release, kind: 'client', artifact: asset,
          map: { ...map('src/a.ts'), ...(release === 'with-content' ? { sourcesContent: ['one\ntwo'] } : {}) } });
        state.event = errorEvent(release, `at ${asset}:1:1`);
        const result = await service.symbolicate(appId, eventId);
        expect(result.status).toBe('mapped');
        expect(result.frames[0].context).toEqual(release === 'with-content' ? { start_line: 1, lines: ['one', 'two'] } : undefined);
      }
    });
  });

  it('空或损坏的结构化字段可回退旧 stack；应用间不混用 map', async () => {
    await withService(async (service, state) => {
      await service.upload({ app_id: 'another-app', release: 'v1', kind: 'client', artifact: asset, map: map('src/private.ts') });
      for (const stack_frames of ['[]', '{broken', '[{"lineno":0}]']) {
        state.event = { ...errorEvent('v1', `at ${asset}:1:1`), stack_frames };
        const result = await service.symbolicate(appId, eventId);
        expect(result.frames[0].status).toBe('missing_map');
        expect(result.frames[0].generated?.filename).toBe(asset);
      }
    });
  });
  it('按 release 隔离映射，并兼容 V8 与 Firefox 帧格式', async () => {
    await withService(async (service, state) => {
      await service.upload({
        app_id: appId,
        release: 'v1',
        kind: 'client',
        artifact: asset,
        map: map('src/old.ts'),
      });
      await service.upload({
        app_id: appId,
        release: 'v2',
        kind: 'client',
        artifact: asset,
        map: map('src/new.ts', 'AAKA'),
      });

      state.event = errorEvent(
        'v1',
        `TypeError: boom\n    at render (${asset}?cache=1:1:1)\nhandler@${asset}:1:1`,
        'framework_error',
      );
      const oldResult = await service.symbolicate(appId, eventId);
      expect(oldResult.status).toBe('mapped');
      expect(oldResult.frames).toHaveLength(2);
      expect(oldResult.frames.map((frame) => frame.original?.source)).toEqual([
        'src/old.ts',
        'src/old.ts',
      ]);
      expect(oldResult.frames[0].original?.column).toBe(1);

      state.event = errorEvent('v2', `Error: boom\n    at ${asset}:1:1`, 'promise_error');
      const newResult = await service.symbolicate(appId, eventId);
      expect(newResult.frames[0].original?.source).toBe('src/new.ts');
      expect(newResult.frames[0].original?.line).toBe(6);
    });
  });

  it('晚到的上传、部分映射、缺失 release 与空堆栈都保留原始证据', async () => {
    await withService(async (service, state) => {
      const event = errorEvent(
        'late',
        `Error: boom\n    at ${asset}:1:1\n    at other (https://cdn.example.com/other.js:2:3)`,
      );
      state.event = event;

      const before = await service.symbolicate(appId, eventId);
      expect(before.status).toBe('unmapped');
      expect(before.frames.map((frame) => frame.status)).toEqual(['missing_map', 'missing_map']);

      await service.upload({
        app_id: appId,
        release: 'late',
        kind: 'client',
        artifact: asset,
        map: map('src/late.ts'),
      });

      const after = await service.symbolicate(appId, eventId);
      expect(after.status).toBe('partial');
      expect(after.frames.map((frame) => frame.status)).toEqual(['mapped', 'missing_map']);
      expect(after.stack).toBe(event.stack);

      event.release = '';
      expect((await service.symbolicate(appId, eventId)).frames[0].status).toBe('missing_release');

      event.stack = '';
      const empty = await service.symbolicate(appId, eventId);
      expect(empty.reason).toBe('missing_stack');
      expect(empty.frames).toEqual([]);
    });
  });

  it('没有堆栈时回退到 window.onerror 的定位信息', async () => {
    await withService(async (service, state) => {
      await service.upload({
        app_id: appId,
        release: 'v1',
        kind: 'client',
        artifact: asset,
        map: map('src/fallback.ts'),
      });
      state.event = { ...errorEvent('v1', ''), filename: asset, lineno: 1, colno: 1 };

      const result = await service.symbolicate(appId, eventId);
      expect(result.status).toBe('mapped');
      expect(result.frames[0].original?.source).toBe('src/fallback.ts');
    });
  });

  it('Nuxt 服务端帧按构建相对路径匹配，并忽略 node 内部帧', async () => {
    await withService(async (service, state) => {
      await service.upload({
        app_id: appId,
        release: 'ssr-1',
        kind: 'server',
        artifact: 'chunks/pages/index.mjs',
        map: map('pages/index.vue'),
      });
      state.event = errorEvent(
        'ssr-1',
        'Error: SSR failed\n    at render (file:///app/.output/server/chunks/pages/index.mjs:1:1)\n    at internal (node:internal/process/task_queues:95:5)',
        'nuxt_ssr_error',
      );

      const result = await service.symbolicate(appId, eventId);
      expect(result.status).toBe('partial');
      expect(result.frames[0].original?.source).toBe('pages/index.vue');
      expect(result.frames[1].status).toBe('unsupported_frame');
    });
  });

  it('上传校验 Source Map，并拒绝同一 release 的冲突产物', async () => {
    await withService(async (service) => {
      const input = {
        app_id: appId,
        release: 'v1',
        kind: 'client',
        artifact: asset,
        map: map('src/app.ts'),
      };

      expect((await service.upload(input)).created).toBe(true);
      expect((await service.upload(input)).created).toBe(false);

      expect(await rejectedStatus(service.upload({ ...input, map: map('src/other.ts') }))).toBe(409);
      expect(await rejectedStatus(service.upload({ ...input, map: { version: 3 } }))).toBe(400);
      expect(
        await rejectedStatus(service.upload({ ...input, kind: 'server', artifact: '../secret' })),
      ).toBe(400);
      expect(await rejectedStatus(service.upload({ ...input, artifact: 'not-a-url' }))).toBe(400);
      expect(await rejectedStatus(service.upload({ ...input, app_id: '  ' }))).toBe(400);
      expect(
        await rejectedStatus(service.upload({ ...input, release: undefined as unknown as string })),
      ).toBe(400);
    });
  });

  it('还原查询校验 app_id 与事件 ID', async () => {
    await withService(async (service) => {
      expect(await rejectedStatus(service.symbolicate('', eventId))).toBe(400);
      expect(await rejectedStatus(service.symbolicate(appId, 'not-a-uuid'))).toBe(400);
    });
  });
});
