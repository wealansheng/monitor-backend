'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/app');

const config = {
  app: { maxBodySize: '32b' },
  clickhouse: { database: 'default', table: 'monitor_events' },
};

async function withServer(monitorService, callback) {
  const server = createApp({ monitorService, config }).listen(0, '127.0.0.1');
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
