/** 数据库初始化命令：使用管理员凭据建库并执行版本化迁移。 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from './config/app-config.module';
import { MONITOR_CONFIG } from './config/config.constants';
import { MonitorConfig } from './config/config.types';
import { initializeDatabase } from './database/data-source';

/** 执行建库迁移命令并释放连接；失败时设置命令退出状态。 */
async function initialize(): Promise<void> {
  const context = await NestFactory.createApplicationContext(AppConfigModule, { logger: ['error', 'warn'] });
  try {
    const config = context.get<MonitorConfig>(MONITOR_CONFIG);
    await initializeDatabase(config.mysql);
    console.log(`MySQL initialized: ${config.mysql.database}`);
  } finally { await context.close(); }
}
initialize().catch((error: Error) => {
  console.error('[db:init] MySQL initialization failed:', error.message);
  process.exitCode = 1;
});
