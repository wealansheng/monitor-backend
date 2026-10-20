import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { NEST_APP_OPTIONS, setupApp } from './app.setup';
import { MONITOR_CONFIG } from './config/config.constants';
import { MonitorConfig } from './config/config.types';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, NEST_APP_OPTIONS);
  await setupApp(app);

  const config = app.get<MonitorConfig>(MONITOR_CONFIG);
  const { host, port } = config.app;
  await app.listen(port, host);

  logger.log(`服务已启动: http://${host}:${port}`);
  logger.log(`上报接口:   POST http://${host}:${port}/api/v1/monitor`);
  for (const table of Object.values(config.clickhouse.tables)) {
    logger.log(`数据表:     ${config.clickhouse.database}.${table}`);
  }

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.log(`收到 ${signal}，正在关闭服务...`);
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[startup] 服务启动失败:', message);
  process.exitCode = 1;
});
