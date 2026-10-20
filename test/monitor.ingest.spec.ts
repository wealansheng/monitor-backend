import { MonitorRepository } from '../src/database/monitor.repository';
import { MonitorIngestPipe } from '../src/monitor/monitor-ingest.pipe';
import { MonitorService } from '../src/monitor/monitor.service';
import { MonitorRequestMeta } from '../src/monitor/monitor.types';

const EVENT_ID = '8a604b37-b7c8-4f26-9eeb-37d38b2d55f3';
const SECOND_EVENT_ID = 'd6dd3d25-5a95-41ba-acf5-83ac856b1125';
const META: MonitorRequestMeta = { ip: '127.0.0.1', userAgent: 'test-agent' };

interface Batch {
  category: string;
  events: Record<string, unknown>[];
}

/**
 * 走完整的「管道校验 → 服务映射 → 写入」链路，只把数据层替换成捕获替身，
 * 因此协议适配（别名、信封继承）与行投影都被真实覆盖。
 */
function createHarness() {
  const batches: Batch[] = [];
  const repository = {
    insertMany: async (category: string, events: Record<string, unknown>[]) => {
      batches.push({ category, events });
    },
  };
  const service = new MonitorService(repository as unknown as MonitorRepository);
  const pipe = new MonitorIngestPipe();

  const ingest = async (payload: unknown) => {
    const parsed = await pipe.transform(Buffer.from(JSON.stringify(payload)));
    const result = await service.receive(parsed, META);
    return result;
  };

  return { ingest, batches };
}

function onlyBatch(batches: Batch[]): Batch {
  expect(batches).toHaveLength(1);
  return batches[0];
}

describe('上报链路：校验通过后按字段规范写入', () => {
  it('将完整 stack_frames 序列化写入错误列，并保留 release 与原始 stack', async () => {
    const { ingest, batches } = createHarness();
    const frames = [{ filename: 'https://cdn.test/app.js', lineno: 1, colno: 9, function_name: 'render', raw: 'at render' }];
    await ingest({ event_id: EVENT_ID, event_type: 'error', error_type: 'promise_error',
      timestamp: 1712345678901, app_id: 'app', release: 'release-1', stack: 'original stack', stack_frames: frames });
    const row = onlyBatch(batches).events[0];
    expect(row.stack_frames).toBe(JSON.stringify(frames));
    expect(row.stack).toBe('original stack');
    expect(row.release).toBe('release-1');
  });
  it('性能事件展开客户端对象并补齐服务端字段', async () => {
    const { ingest, batches } = createHarness();

    const result = await ingest({
      event_id: EVENT_ID,
      event_type: 'performance',
      timestamp: 1712345678901,
      app_id: 'web-portal',
      project_name: 'monitor-console',
      metric_name: 'LCP',
      value: 1800,
      device: { type: 'mobile', model: 'iPhone 14' },
      browser: { name: 'Chrome', version: '120' },
      os: { name: 'iOS', version: '17' },
    });

    expect(result).toMatchObject({ eventId: EVENT_ID, eventType: 'performance' });
    const { category, events } = onlyBatch(batches);
    const [event] = events;

    expect(category).toBe('performance');
    expect(event.project_name).toBe('monitor-console');
    expect(event.metric_name).toBe('LCP');
    expect(event.device_type).toBe('mobile');
    expect(event.device_model).toBe('iPhone 14');
    expect(event.browser_name).toBe('Chrome');
    expect(event.os_name).toBe('iOS');
    expect(event.client_ip).toBe('127.0.0.1');
    expect(event.user_agent).toBe('test-agent');
    expect(event.received_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('request 与 resource 事件路由到性能表并兼容 SDK 驼峰字段', async () => {
    const { ingest, batches } = createHarness();

    await ingest({
      event_id: EVENT_ID,
      event_type: 'resource',
      timestamp: 1712345678901,
      app_key: 'web-portal',
      resource_url: 'https://example.com/app.js',
      initiatorType: 'script',
      startTime: 1303.5,
      transferSize: 102400,
      cached: true,
    });

    const { category, events } = onlyBatch(batches);
    expect(category).toBe('performance');
    expect(events[0].app_id).toBe('web-portal');
    expect(events[0].initiator_type).toBe('script');
    expect(events[0].start_time).toBe(1303.5);
    expect(events[0].transfer_size).toBe(102400);
    expect(events[0].cached).toBe(1);
  });

  it('错误事件路由到错误表并序列化 JSON 字段', async () => {
    const { ingest, batches } = createHarness();

    await ingest({
      event_id: EVENT_ID,
      event_type: 'error',
      timestamp: 1712345678901,
      app_id: 'web-portal',
      error_type: 'js_error',
      message: 'boom',
      breadcrumbs: [{ type: 'click', message: 'submit', timestamp: 1712345678000 }],
      extra: { userId: 'masked-user' },
    });

    const { category, events } = onlyBatch(batches);
    expect(category).toBe('error');
    expect(events[0].message).toBe('boom');
    expect(events[0].breadcrumbs).toBe(
      '[{"type":"click","message":"submit","timestamp":1712345678000}]',
    );
    expect(events[0].extra).toBe('{"userId":"masked-user"}');
  });

  it('行为事件展开 target 并序列化 properties', async () => {
    const { ingest, batches } = createHarness();

    await ingest({
      event_id: EVENT_ID,
      event_type: 'behavior',
      timestamp: 1712345678901,
      app_id: 'web-portal',
      action: 'click',
      target: { selector: '#submit-btn', text: '提交', tag: 'BUTTON' },
      properties: { product_id: 'p_123', price: 99.9 },
    });

    const { category, events } = onlyBatch(batches);
    expect(category).toBe('behavior');
    expect(events[0].target_selector).toBe('#submit-btn');
    expect(events[0].target_text).toBe('提交');
    expect(events[0].target_tag).toBe('BUTTON');
    expect(events[0].properties).toBe('{"product_id":"p_123","price":99.9}');
  });

  it('布尔字段转换为 ClickHouse 的 UInt8', async () => {
    const { ingest, batches } = createHarness();

    await ingest({
      event_id: EVENT_ID,
      event_type: 'request',
      timestamp: 1712345678901,
      app_id: 'web-portal',
      url: '/api/orders',
      method: 'GET',
      success: false,
      cached: false,
    });

    expect(batches[0].events[0].success).toBe(0);
    expect(batches[0].events[0].cached).toBe(0);
  });

  it('单事件把 projectName 写入 project_name 且不残留别名', async () => {
    const { ingest, batches } = createHarness();

    await ingest({
      app_id: 'web-portal',
      event_id: EVENT_ID,
      event_type: 'behavior',
      timestamp: 1712345678901,
      projectName: 'frontend-project',
      action: 'click',
    });

    const event = onlyBatch(batches).events[0];
    expect(event.project_name).toBe('frontend-project');
    expect(Object.hasOwn(event, 'projectName')).toBe(false);
  });
});

describe('上报链路：批量信封', () => {
  it('继承信封字段，并按目标表分别写入', async () => {
    const { ingest, batches } = createHarness();

    const result = await ingest({
      app_id: 'web-portal',
      project_name: 'default-project',
      sample_rate: 0.5,
      sdk_version: '2.0.0',
      send_time: 1712345679999,
      events: [
        {
          event_id: EVENT_ID,
          event_type: 'behavior',
          timestamp: 1712345678901,
          action: 'click',
          project_name: 'behavior-project',
          browser: { name: 'Chrome', version: '120' },
        },
        {
          event_id: SECOND_EVENT_ID,
          event_type: 'error',
          timestamp: 1712345678902,
          error_type: 'js_error',
          message: 'boom',
        },
      ],
    });

    expect(result).toMatchObject({
      eventIds: [EVENT_ID, SECOND_EVENT_ID],
      eventCount: 2,
    });

    expect(batches).toHaveLength(2);
    const behavior = batches.find((batch) => batch.category === 'behavior')!.events[0];
    const error = batches.find((batch) => batch.category === 'error')!.events[0];

    expect(behavior.app_id).toBe('web-portal');
    expect(behavior.project_name).toBe('behavior-project');
    expect(error.project_name).toBe('default-project');
    expect(behavior.sample_rate).toBe(0.5);
    expect(behavior.sdk_version).toBe('2.0.0');
    expect(behavior.send_time).toBe(1712345679999);
    expect(behavior.browser_name).toBe('Chrome');
  });

  it('同类批量事件合并为一次写入', async () => {
    const { ingest, batches } = createHarness();

    await ingest({
      app_id: 'web-portal',
      events: [
        { event_id: EVENT_ID, event_type: 'behavior', timestamp: 1712345678901, action: 'click' },
        {
          event_id: SECOND_EVENT_ID,
          event_type: 'behavior',
          timestamp: 1712345678902,
          action: 'page_view',
        },
      ],
    });

    expect(batches).toHaveLength(1);
    expect(batches[0].category).toBe('behavior');
    expect(batches[0].events).toHaveLength(2);
  });

  it('批量事件全部校验通过前不写入数据层', async () => {
    const { ingest, batches } = createHarness();

    await expect(
      ingest({
        app_id: 'web-portal',
        sample_rate: 0.5,
        events: [
          { event_id: EVENT_ID, event_type: 'behavior', timestamp: 1712345678901, action: 'click' },
          {
            event_id: 'not-a-uuid',
            event_type: 'behavior',
            timestamp: 1712345678902,
            action: 'click',
          },
        ],
      }),
    ).rejects.toThrow('events[1]: event_id must be a UUID');

    expect(batches).toHaveLength(0);
  });
});
