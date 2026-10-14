'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorRepository } = require('../src/repositories/monitor.repository');

test('数据层创建表并写入 ClickHouse', async () => {
  let createQuery;
  let insertParams;
  const client = {
    async command({ query }) {
      createQuery = query;
    },
    async insert(params) {
      insertParams = params;
    },
  };
  const repository = new MonitorRepository({
    client,
    database: 'default',
    table: 'monitor_events',
  });

  await repository.initialize();
  await repository.insert({ event_id: 'id' });

  assert.match(createQuery, /CREATE TABLE IF NOT EXISTS `default`\.`monitor_events`/);
  assert.deepEqual(insertParams, {
    table: '`default`.`monitor_events`',
    values: [{ event_id: 'id' }],
    format: 'JSONEachRow',
  });
});
