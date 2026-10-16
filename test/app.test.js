'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { MonitorService } = require('../src/services/monitor.service');

const config = {
  app: { maxBodySize: '32b' },
  clickhouse: {
    database: 'weils_monitor',
    tables: {
      performance: 'frontend_performance',
      error: 'frontend_error',
      behavior: 'frontend_behavior',
    },
  },
};

async function withServer(monitorService, callback, appConfig = config) {
  const server = createApp({ monitorService, config: appConfig }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /api/v1/monitor 接收数据并返回结果', async () => {
  let received;
  const monitorService = {
    async receive(data) {
      received = data;
      return { eventId: 'event-1', bytes: data.bytes };
    },
  };

  await withServer(monitorService, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/monitor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, eventId: 'event-1', bytes: 11 });
    assert.equal(received.raw, '{"ok":true}');
    assert.equal(received.contentType, 'application/json');
  });
});

test('空请求返回 400', async () => {
  await withServer({ receive: async () => assert.fail('不应调用业务层') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/monitor`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'Empty body' });
  });
});

test('超过限制的数据返回 413', async () => {
  await withServer({ receive: async () => assert.fail('不应调用业务层') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/monitor`, {
      method: 'POST',
      body: 'x'.repeat(33),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { ok: false, error: 'Payload too large' });
  });
});

test('POST /api/v1/monitor 接收批量信封并返回接收数量', async () => {
  const writes = [];
  const monitorService = new MonitorService({
    async insertMany(category, events) {
      writes.push({ category, events });
    },
  });
  const batchConfig = {
    ...config,
    app: { maxBodySize: '5mb' },
  };
  const payload = {
    app_id: 'web-portal',
    projectName: 'frontend-project',
    sample_rate: 1,
    sdk_version: '2.0.0',
    send_time: 1712345679999,
    events: [
      {
        event_id: 'd6dd3d25-5a95-41ba-acf5-83ac856b1125',
        event_type: 'behavior',
        timestamp: 1712345678901,
        action: 'click',
      },
    ],
  };

  await withServer(
    monitorService,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/monitor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.eventCount, 1);
      assert.deepEqual(body.eventIds, ['d6dd3d25-5a95-41ba-acf5-83ac856b1125']);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].category, 'behavior');
      assert.equal(writes[0].events[0].project_name, 'frontend-project');
      assert.equal(writes[0].events[0].sdk_version, '2.0.0');
    },
    batchConfig,
  );
});
