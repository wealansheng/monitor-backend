'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitorRepository } = require('../src/repositories/monitor.repository');

test('数据层创建表并写入 ClickHouse', async () => {
  const createQueries = [];
  let insertParams;
  const client = {
    async command({ query }) {
      createQueries.push(query);
    },
    async insert(params) {
      insertParams = params;
    },
  };
  const repository = new MonitorRepository({
    client,
    database: 'weils_monitor',
    tables: {
      performance: 'frontend_performance',
      error: 'frontend_error',
      behavior: 'frontend_behavior',
    },
  });

  await repository.initialize();
  await repository.insertMany('error', [{ event_id: 'id-1' }, { event_id: 'id-2' }]);

  assert.equal(createQueries.length, 11);
  assert.match(createQueries[0], /CREATE DATABASE IF NOT EXISTS `weils_monitor`/);
  assert.match(createQueries[1], /CREATE TABLE IF NOT EXISTS `weils_monitor`\.`frontend_performance`/);
  assert.ok(
    createQueries.some((query) =>
      /CREATE TABLE IF NOT EXISTS `weils_monitor`\.`frontend_error`/.test(query),
    ),
  );
  assert.ok(
    createQueries.some((query) =>
      /CREATE TABLE IF NOT EXISTS `weils_monitor`\.`frontend_behavior`/.test(query),
    ),
  );
  assert.ok(
    createQueries.some((query) =>
      /ALTER TABLE `weils_monitor`\.`frontend_behavior`[\s\S]*ADD COLUMN IF NOT EXISTS sample_rate/.test(
        query,
      ),
    ),
  );
  assert.ok(
    createQueries.some((query) =>
      /ALTER TABLE `weils_monitor`\.`frontend_performance`[\s\S]*MODIFY COLUMN start_time Float64/.test(
        query,
      ),
    ),
  );
  assert.deepEqual(insertParams, {
    table: '`weils_monitor`.`frontend_error`',
    values: [{ event_id: 'id-1' }, { event_id: 'id-2' }],
    format: 'JSONEachRow',
    clickhouse_settings: {
      input_format_defaults_for_omitted_fields: 1,
    },
  });
});
