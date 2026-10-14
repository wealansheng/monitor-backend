'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorService } = require('../src/services/monitor.service');

const EVENT_ID = '8a604b37-b7c8-4f26-9eeb-37d38b2d55f3';

function requestData(payload) {
  const raw = JSON.stringify(payload);
  return {
    raw,
    bytes: Buffer.byteLength(raw),
    contentType: 'application/json',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
  };
}

function createCapturingService() {
  const captured = { batches: [] };
  const service = new MonitorService({
    async insertMany(category, events) {
      captured.batches.push({ category, events });
      captured.category = category;
      [captured.event] = events;
    },
  });
  return { service, captured };
}

test('性能事件按字段规范写入性能表并展开客户端对象', async () => {
  const { service, captured } = createCapturingService();
  const data = requestData({
    event_id: EVENT_ID,
    event_type: 'performance',
    timestamp: 1712345678901,
    app_id: 'web-portal',
    metric_name: 'LCP',
    value: 1800,
    device: { type: 'mobile', model: 'iPhone 14' },
    browser: { name: 'Chrome', version: '120' },
    os: { name: 'iOS', version: '17' },
  });

  const result = await service.receive(data);

  assert.equal(result.eventId, EVENT_ID);
  assert.equal(result.eventType, 'performance');
  assert.equal(captured.category, 'performance');
  assert.equal(captured.event.metric_name, 'LCP');
  assert.equal(captured.event.device_type, 'mobile');
  assert.equal(captured.event.browser_name, 'Chrome');
  assert.equal(captured.event.os_name, 'iOS');
  assert.equal(captured.event.client_ip, '127.0.0.1');
});

test('request 和 resource 事件路由到性能表并兼容 SDK 驼峰字段', async () => {
  const { service, captured } = createCapturingService();

  await service.receive(
    requestData({
      event_id: EVENT_ID,
      event_type: 'resource',
      timestamp: 1712345678901,
      app_key: 'web-portal',
      resource_url: 'https://example.com/app.js',
      initiatorType: 'script',
      startTime: 1303.5,
      transferSize: 102400,
      cached: true,
    }),
  );

  assert.equal(captured.category, 'performance');
  assert.equal(captured.event.app_id, 'web-portal');
  assert.equal(captured.event.initiator_type, 'script');
  assert.equal(captured.event.start_time, 1303.5);
  assert.equal(captured.event.transfer_size, 102400);
  assert.equal(captured.event.cached, 1);
});

test('错误和稳定性事件路由到错误表', async () => {
  const { service, captured } = createCapturingService();

  await service.receive(
    requestData({
      event_id: EVENT_ID,
      event_type: 'error',
      timestamp: 1712345678901,
      app_id: 'web-portal',
      error_type: 'js_error',
      message: 'boom',
      breadcrumbs: [{ type: 'click', message: 'submit', timestamp: 1712345678000 }],
      extra: { userId: 'masked-user' },
    }),
  );

  assert.equal(captured.category, 'error');
  assert.equal(captured.event.message, 'boom');
  assert.equal(
    captured.event.breadcrumbs,
    '[{"type":"click","message":"submit","timestamp":1712345678000}]',
  );
  assert.equal(captured.event.extra, '{"userId":"masked-user"}');
});

test('行为事件展开 target 并序列化 properties', async () => {
  const { service, captured } = createCapturingService();

  await service.receive(
    requestData({
      event_id: EVENT_ID,
      event_type: 'behavior',
      timestamp: 1712345678901,
      app_id: 'web-portal',
      action: 'click',
      target: { selector: '#submit-btn', text: '提交', tag: 'BUTTON' },
      properties: { product_id: 'p_123', price: 99.9 },
    }),
  );

  assert.equal(captured.category, 'behavior');
  assert.equal(captured.event.target_selector, '#submit-btn');
  assert.equal(captured.event.target_text, '提交');
  assert.equal(captured.event.target_tag, 'BUTTON');
  assert.equal(captured.event.properties, '{"product_id":"p_123","price":99.9}');
});

test('拒绝缺少公共必填字段的事件', async () => {
  const service = new MonitorService({
    async insertMany() {
      assert.fail('不应写入数据层');
    },
  });

  await assert.rejects(
    service.receive(requestData({ event_type: 'behavior', action: 'click' })),
    /event_id must be a UUID/,
  );
});

test('批量上报继承信封字段，并按目标表批量写入', async () => {
  const { service, captured } = createCapturingService();
  const secondEventId = 'd6dd3d25-5a95-41ba-acf5-83ac856b1125';
  const result = await service.receive(
    requestData({
      app_id: 'web-portal',
      sample_rate: 0.5,
      sdk_version: '2.0.0',
      send_time: 1712345679999,
      events: [
        {
          event_id: EVENT_ID,
          event_type: 'behavior',
          timestamp: 1712345678901,
          action: 'click',
          browser: { name: 'Chrome', version: '120' },
        },
        {
          event_id: secondEventId,
          event_type: 'error',
          timestamp: 1712345678902,
          error_type: 'js_error',
          message: 'boom',
        },
      ],
    }),
  );

  assert.deepEqual(result.eventIds, [EVENT_ID, secondEventId]);
  assert.equal(result.eventCount, 2);
  assert.equal(captured.batches.length, 2);
  const behavior = captured.batches.find((batch) => batch.category === 'behavior').events[0];
  assert.equal(behavior.app_id, 'web-portal');
  assert.equal(behavior.sample_rate, 0.5);
  assert.equal(behavior.sdk_version, '2.0.0');
  assert.equal(behavior.send_time, 1712345679999);
  assert.equal(behavior.browser_name, 'Chrome');
});

test('同类批量事件合并为一次 ClickHouse 写入', async () => {
  const { service, captured } = createCapturingService();
  await service.receive(
    requestData({
      app_id: 'web-portal',
      events: [
        {
          event_id: EVENT_ID,
          event_type: 'behavior',
          timestamp: 1712345678901,
          action: 'click',
        },
        {
          event_id: 'd6dd3d25-5a95-41ba-acf5-83ac856b1125',
          event_type: 'behavior',
          timestamp: 1712345678902,
          action: 'page_view',
        },
      ],
    }),
  );

  assert.equal(captured.batches.length, 1);
  assert.equal(captured.batches[0].category, 'behavior');
  assert.equal(captured.batches[0].events.length, 2);
});

test('批量事件全部校验通过前不写入', async () => {
  let insertCalls = 0;
  const service = new MonitorService({
    async insertMany() {
      insertCalls += 1;
    },
  });

  await assert.rejects(
    service.receive(
      requestData({
        app_id: 'web-portal',
        sample_rate: 0.5,
        events: [
          {
            event_id: EVENT_ID,
            event_type: 'behavior',
            timestamp: 1712345678901,
            action: 'click',
          },
          {
            event_id: 'not-a-uuid',
            event_type: 'behavior',
            timestamp: 1712345678902,
            action: 'click',
          },
        ],
      }),
    ),
    /events\[1\]: event_id must be a UUID/,
  );
  assert.equal(insertCalls, 0);
});

test('拒绝非法的批量元数据和空 events', async () => {
  const service = new MonitorService({
    async insertMany() {
      assert.fail('不应写入数据层');
    },
  });

  await assert.rejects(
    service.receive(requestData({ app_id: 'web-portal', sample_rate: 1.1, events: [{}] })),
    /sample_rate must be a number between 0 and 1/,
  );
  await assert.rejects(
    service.receive(requestData({ app_id: 'web-portal', events: [] })),
    /events must be a non-empty array/,
  );
});
