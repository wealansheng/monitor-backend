'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorService } = require('../src/services/monitor.service');

test('业务层格式化 JSON 并调用数据层', async () => {
  let inserted;
  const repository = {
    async insert(event) {
      inserted = event;
    },
  };
  const service = new MonitorService(repository);

  const result = await service.receive({
    raw: '{"level":"error"}',
    bytes: 17,
    contentType: 'application/json',
    ip: '127.0.0.1',
    userAgent: 'test',
  });

  assert.equal(result.bytes, 17);
  assert.match(result.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(inserted.event_id, result.eventId);
  assert.equal(inserted.payload, '{\n  "level": "error"\n}');
  assert.equal(inserted.source_ip, '127.0.0.1');
});

test('业务层原样保留非 JSON 数据', async () => {
  let inserted;
  const service = new MonitorService({
    async insert(event) {
      inserted = event;
    },
  });

  await service.receive({
    raw: 'plain log',
    bytes: 9,
    contentType: 'text/plain',
    ip: '',
    userAgent: '',
  });

  assert.equal(inserted.payload, 'plain log');
});
