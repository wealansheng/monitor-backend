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
    table: config.clickhouse.table,
  });

  try {
    await client.command({
      query: `CREATE DATABASE IF NOT EXISTS \`${config.clickhouse.database}\``,
    });
    await repository.initialize();
    await client.command({
      query: `GRANT INSERT ON ${repository.qualifiedTable} TO \`${config.clickhouse.username}\``,
    });
    console.log(`ClickHouse 初始化完成: ${config.clickhouse.database}.${config.clickhouse.table}`);
    console.log(`已向用户 ${config.clickhouse.username} 授予 INSERT 权限`);
  } finally {
    await client.close();
  }
}

initialize().catch((error) => {
  console.error('[db:init] ClickHouse 初始化失败:', error.message);
  process.exitCode = 1;
});
