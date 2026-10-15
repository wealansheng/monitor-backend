'use strict';

const { createClient } = require('@clickhouse/client');
const { loadConfig } = require('../src/config');
const { MonitorRepository } = require('../src/repositories/monitor.repository');

async function initialize() {
  const config = loadConfig();
  const client = createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.adminUsername,
    password: config.clickhouse.adminPassword,
  });
  const repository = new MonitorRepository({
    client,
    database: config.clickhouse.database,
    tables: config.clickhouse.tables,
  });

  try {
    await repository.initialize();
    console.log(`ClickHouse 初始化完成: ${config.clickhouse.database}`);
  } finally {
    await client.close();
  }
}

initialize().catch((error) => {
  console.error('[db:init] ClickHouse 初始化失败:', error.message);
  process.exitCode = 1;
});
