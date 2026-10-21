import { createClient } from '@clickhouse/client';
import { NestFactory } from '@nestjs/core';

import { AppConfigModule } from './config/app-config.module';
import { MONITOR_CONFIG } from './config/config.constants';
import { MonitorConfig } from './config/config.types';
import { MonitorRepository } from './database/monitor.repository';

/**
 * 建库建表脚本入口：`npm run db:init`。
 *
 * 使用 `CLICKHOUSE_ADMIN_USERNAME` / `CLICKHOUSE_ADMIN_PASSWORD` 连接，
 * 与上报服务使用的账号分开配置。
 */
async function initialize(): Promise<void> {
  const context = await NestFactory.createApplicationContext(AppConfigModule, {
    logger: ['error', 'warn'],
  });

  try {
    const config = context.get<MonitorConfig>(MONITOR_CONFIG);
    const client = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.adminUsername,
      password: config.clickhouse.adminPassword,
    });

    try {
      const repository = new MonitorRepository({
        client,
        database: config.clickhouse.database,
        tables: config.clickhouse.tables,
        recordTable: config.clickhouse.recordTable,
      });
      await repository.initialize();
      console.log(`ClickHouse 初始化完成: ${config.clickhouse.database}`);
    } finally {
      await client.close();
    }
  } finally {
    await context.close();
  }
}

initialize().catch((error: Error) => {
  console.error('[db:init] ClickHouse 初始化失败:', error.message);
  process.exitCode = 1;
});
