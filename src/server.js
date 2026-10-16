'use strict';

const { createClient } = require('@clickhouse/client');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { MonitorRepository } = require('./repositories/monitor.repository');
const { MonitorService } = require('./services/monitor.service');
const { SourceMapService } = require('./services/sourcemap.service');
const { DashboardService } = require('./services/dashboard.service');

async function start() {
  const config = loadConfig();
  const client = createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.username,
    password: config.clickhouse.password,
  });
  const repository = new MonitorRepository({
    client,
    database: config.clickhouse.database,
    tables: config.clickhouse.tables,
  });

  if (config.clickhouse.autoMigrate) {
    await repository.initialize();
  } else {
    const result = await client.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    await result.json();
  }

  const monitorService = new MonitorService(repository);
  const sourceMapService = config.sourceMaps.token
    ? new SourceMapService({ directory: config.sourceMaps.directory, repository })
    : undefined;
  const dashboardService = config.dashboard.token ? new DashboardService(repository) : undefined;
  const app = createApp({ monitorService, sourceMapService, dashboardService, config });
  const server = app.listen(config.app.port, config.app.host, () => {
    console.log(`服务已启动: http://${config.app.host}:${config.app.port}`);
    console.log(`上报接口:   POST http://${config.app.host}:${config.app.port}/api/v1/monitor`);
    for (const table of Object.values(config.clickhouse.tables)) {
      console.log(`数据表:     ${config.clickhouse.database}.${table}`);
    }
  });

  async function shutdown(signal) {
    console.log(`\n收到 ${signal}，正在关闭服务...`);
    server.close(async () => {
      await client.close();
      process.exit(0);
    });
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module || require.main?.filename.endsWith('index.js')) {
  start().catch((error) => {
    console.error('[startup] 服务启动失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { start };
