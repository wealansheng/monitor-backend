/** 全局采集模块：分别配置 Bull 控制队列与有界载荷缓冲连接。 */
import { BullModule } from '@nestjs/bull';
import { Global, Logger, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { MONITOR_CONFIG } from '../config/config.constants';
import type { MonitorConfig } from '../config/config.types';
import { DashboardTokenGuard } from '../dashboard/dashboard-token.guard';
import { IngestionBuffer } from './ingestion-buffer.service';
import { BatchWriter } from './batch-writer.service';
import { IngestionProcessor } from './ingestion.processor';
import { IngestionLifecycle } from './ingestion-lifecycle.service';
import { IngestionController } from './ingestion.controller';
import { INGEST_QUEUE, INGEST_REDIS } from './ingestion.types';

/** 注册共享缓冲服务、Bull 队列和后台消费组件。 */
@Global()
@Module({
  imports: [BullModule.registerQueueAsync({
    name: INGEST_QUEUE, inject: [MONITOR_CONFIG],
    useFactory: (config: MonitorConfig) => ({
      // Bull 使用独立子前缀，应用 Lua 不访问或裁剪 Bull 内部队列键。
      prefix: `${config.redis.prefix}:bull`,
      redis: { host: config.redis.host, port: config.redis.port, password: config.redis.password,
        db: config.redis.db, connectTimeout: 3000 },
    }),
  })],
  controllers: [IngestionController],
  providers: [
    // 载荷连接禁用离线排队并设置短超时，Redis 不可用时让入口及时返回 503。
    { provide: INGEST_REDIS, inject: [MONITOR_CONFIG], useFactory: (config: MonitorConfig) => {
      const client = new Redis({ host: config.redis.host, port: config.redis.port, password: config.redis.password,
        db: config.redis.db, lazyConnect: true, enableOfflineQueue: false, commandTimeout: 2000,
        connectTimeout: 3000, maxRetriesPerRequest: 1, retryStrategy: count => Math.min(count*200,2000) });
      // 不记录可能包含凭据的驱动错误原文。
      client.on('error', () => new Logger('IngestionRedis').warn('Redis connection unavailable'));
      return client;
    } },
    IngestionBuffer, BatchWriter, IngestionProcessor, IngestionLifecycle, DashboardTokenGuard,
  ],
  exports: [IngestionBuffer],
})
export class IngestionModule {}
