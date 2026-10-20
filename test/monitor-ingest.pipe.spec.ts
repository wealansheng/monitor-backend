import { MonitorIngestPipe } from '../src/monitor/monitor-ingest.pipe';

const EVENT_ID = '8a604b37-b7c8-4f26-9eeb-37d38b2d55f3';
const SECOND_EVENT_ID = 'd6dd3d25-5a95-41ba-acf5-83ac856b1125';

const pipe = new MonitorIngestPipe();
const body = (payload: unknown): Buffer => Buffer.from(JSON.stringify(payload));

describe('MonitorIngestPipe', () => {
  it('校验结构化帧，保留缺少位置的 native 帧，并拒绝非法行列号', async () => {
    const base = { event_id: EVENT_ID, event_type: 'error', error_type: 'js_error', timestamp: 1, app_id: 'a' };
    const frames = [{ filename: 'https://cdn.test/app.js', lineno: 2, colno: 3 }, { function_name: 'native', raw: 'at native' }];
    expect((await pipe.transform(body({ ...base, stack_frames: frames }))).payloads[0].stack_frames).toEqual(frames);
    for (const invalid of [null, {}, '[]', [null], [{ lineno: 0 }], [{ colno: 1.5 }], [{ filename: 2 }]]) {
      await expect(pipe.transform(body({ ...base, stack_frames: invalid }))).rejects.toThrow('stack_frames must be an array of valid stack frames');
    }
    await expect(pipe.transform(body({ events: [{ ...base, stack_frames: [{ colno: -1 }] }] })))
      .rejects.toThrow('events[0]: stack_frames');
  });
  it('解析单事件上报并回传原始字节数', async () => {
    const raw = body({
      event_id: EVENT_ID,
      event_type: 'behavior',
      timestamp: 1712345678901,
      app_id: 'web-portal',
      action: 'click',
    });

    const result = await pipe.transform(raw);

    expect(result.isBatch).toBe(false);
    expect(result.bytes).toBe(raw.length);
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0]).toMatchObject({ event_id: EVENT_ID, event_type: 'behavior' });
  });

  it('空请求体与非法 JSON 的处理', async () => {
    await expect(pipe.transform(Buffer.alloc(0))).rejects.toThrow('Empty body');
    await expect(pipe.transform(undefined)).rejects.toThrow('Empty body');
    await expect(pipe.transform(Buffer.from('{}'))).rejects.toThrow(
      'event_id must be a UUID',
    );
    await expect(pipe.transform(Buffer.from('{'))).rejects.toThrow('Invalid JSON body');
    await expect(pipe.transform(Buffer.from('[1,2]'))).rejects.toThrow(
      'JSON body must be an object',
    );
    await expect(pipe.transform(Buffer.from('null'))).rejects.toThrow(
      'JSON body must be an object',
    );
  });

  it('拒绝缺少公共必填字段的事件', async () => {
    await expect(pipe.transform(body({ event_type: 'behavior', action: 'click' }))).rejects.toThrow(
      'event_id must be a UUID',
    );
    await expect(
      pipe.transform(body({ event_id: EVENT_ID, event_type: 'behavior', action: 'click' })),
    ).rejects.toThrow('app_id is required');
    await expect(
      pipe.transform(
        body({ event_id: EVENT_ID, event_type: 'behavior', timestamp: 0, app_id: 'a', action: 'x' }),
      ),
    ).rejects.toThrow('timestamp must be a positive Unix millisecond integer');
    await expect(
      pipe.transform(
        body({ event_id: EVENT_ID, event_type: 'click', timestamp: 1, app_id: 'a' }),
      ),
    ).rejects.toThrow(
      'event_type must be performance, request, resource, error, stability, or behavior',
    );
  });

  it('拒绝无效的 project_name 且不写入数据层', async () => {
    await expect(
      pipe.transform(
        body({
          event_id: EVENT_ID,
          event_type: 'behavior',
          timestamp: 1712345678901,
          app_id: 'web-portal',
          project_name: '  ',
          action: 'click',
        }),
      ),
    ).rejects.toThrow('project_name must be a non-empty string');
  });

  it('按事件类型校验专属必填字段', async () => {
    const base = { event_id: EVENT_ID, timestamp: 1712345678901, app_id: 'web-portal' };

    await expect(pipe.transform(body({ ...base, event_type: 'performance' }))).rejects.toThrow(
      'metric_name is required for performance events',
    );
    await expect(pipe.transform(body({ ...base, event_type: 'request', url: 'u' }))).rejects.toThrow(
      'url and method are required for request events',
    );
    await expect(pipe.transform(body({ ...base, event_type: 'resource' }))).rejects.toThrow(
      'resource_url is required for resource events',
    );
    await expect(pipe.transform(body({ ...base, event_type: 'error' }))).rejects.toThrow(
      'error_type is required for error events',
    );
    await expect(pipe.transform(body({ ...base, event_type: 'stability' }))).rejects.toThrow(
      'issue_type is required for stability events',
    );
    await expect(pipe.transform(body({ ...base, event_type: 'behavior' }))).rejects.toThrow(
      'action is required for behavior events',
    );
  });

  it('拒绝非法的批量元数据与空 events', async () => {
    await expect(
      pipe.transform(body({ app_id: 'web-portal', sample_rate: 1.1, events: [{}] })),
    ).rejects.toThrow('sample_rate must be a number between 0 and 1');
    await expect(pipe.transform(body({ app_id: 'web-portal', events: [] }))).rejects.toThrow(
      'events must be a non-empty array',
    );
    await expect(pipe.transform(body({ app_id: 'web-portal', events: 'nope' }))).rejects.toThrow(
      'events must be a non-empty array',
    );
    await expect(
      pipe.transform(body({ app_id: 'web-portal', events: [{ event_id: EVENT_ID }], send_time: 0 })),
    ).rejects.toThrow('send_time must be a positive Unix millisecond integer');
  });

  it('批量信封元数据先于事件校验，事件错误带下标前缀', async () => {
    // 元数据非法时应先报元数据错误，且不带 events[i] 前缀。
    await expect(
      pipe.transform(body({ app_id: 'web-portal', sample_rate: 2, events: [{ event_id: 'bad' }] })),
    ).rejects.toThrow(/^sample_rate must be a number between 0 and 1$/);

    await expect(
      pipe.transform(body({ app_id: 'web-portal', events: [{ event_id: EVENT_ID }] })),
    ).rejects.toThrow('events[0]: event_type must be performance');

    await expect(
      pipe.transform(
        body({
          app_id: 'web-portal',
          events: [
            { event_id: EVENT_ID, event_type: 'behavior', timestamp: 1, action: 'click' },
            { event_id: 'not-a-uuid', event_type: 'behavior', timestamp: 2, action: 'click' },
          ],
        }),
      ),
    ).rejects.toThrow('events[1]: event_id must be a UUID');
  });

  it('字段校验顺序稳定：公共字段先于事件专属字段', async () => {
    // 同时缺少 event_id 与 error_type 时，应报 event_id。
    await expect(
      pipe.transform(body({ event_type: 'error', timestamp: 1, app_id: 'a' })),
    ).rejects.toThrow('event_id must be a UUID');

    // timestamp 属于公共字段，应先于 error_type 报出。
    await expect(
      pipe.transform(body({ event_id: EVENT_ID, event_type: 'error', timestamp: 0, app_id: 'a' })),
    ).rejects.toThrow('timestamp must be a positive Unix millisecond integer');
  });

  it('兼容 SDK 的字符串数值与字段别名', async () => {
    const result = await pipe.transform(
      body({
        event_id: EVENT_ID,
        event_type: 'resource',
        timestamp: '1712345678901',
        app_key: 'web-portal',
        resource_url: 'https://example.com/app.js',
        initiatorType: 'script',
        sample_rate: '0.5',
        sdk_verion: '2.0.0',
        send_time: '1712345679999',
      }),
    );

    const [payload] = result.payloads;
    expect(payload.app_id).toBe('web-portal');
    expect(payload.timestamp).toBe(1712345678901);
    expect(payload.initiator_type).toBe('script');
    expect(payload.sample_rate).toBe(0.5);
    expect(payload.sdk_version).toBe('2.0.0');
    expect(payload.send_time).toBe(1712345679999);
  });

  it('展开 data 包装并继承批量信封字段', async () => {
    const result = await pipe.transform(
      body({
        app_id: 'web-portal',
        projectName: 'envelope-project',
        events: [
          {
            event_id: EVENT_ID,
            event_type: 'behavior',
            timestamp: 1712345678901,
            action: 'click',
            data: { projectName: 'event-project' },
          },
          {
            event_id: SECOND_EVENT_ID,
            event_type: 'behavior',
            timestamp: 1712345678902,
            action: 'page_view',
          },
        ],
      }),
    );

    expect(result.isBatch).toBe(true);
    expect(result.payloads[0].project_name).toBe('event-project');
    expect(result.payloads[1].project_name).toBe('envelope-project');
    expect(result.payloads[0].data).toBeUndefined();
  });
});
