/** 测试应用工厂：默认替换外部基础设施，集成测试可显式启用真实连接。 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getQueueToken } from '@nestjs/bull';
import { IngestionBuffer } from '../../src/ingestion/ingestion-buffer.service';
import { IngestionProcessor } from '../../src/ingestion/ingestion.processor';
import { IngestionLifecycle } from '../../src/ingestion/ingestion-lifecycle.service';
import { INGEST_QUEUE, INGEST_REDIS } from '../../src/ingestion/ingestion.types';
import { DatabaseBootstrapService } from '../../src/database/database-bootstrap.service';
import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, setupApp } from '../../src/app.setup';
import { MONITOR_CONFIG } from '../../src/config/config.constants';
import { monitorConfiguration } from '../../src/config/configuration';
import { MonitorConfig } from '../../src/config/config.types';
import { dataSourceOptions } from '../../src/database/data-source';

/**
 * 使用真实 MySQL 驱动展开参数，但全部网络读写均替换为测试替身。
 * 保留真实 MySQL 驱动的参数展开逻辑，同时替换所有网络读写。
 */
export function createDataSourceStub(): DataSource {
  const source = new DataSource(dataSourceOptions(createTestConfig().mysql));
  source.query = jest.fn(async (sql: string) => /^DELETE/.test(sql) ? { affectedRows: 0 } : []) as DataSource['query'];
  source.destroy = jest.fn(async () => undefined);
  return source;
}

/** 生成测试专用配置，默认关闭管理令牌并允许用例显式覆盖。 */
export function createTestConfig(env: NodeJS.ProcessEnv = {}): MonitorConfig {
  return monitorConfiguration({
    HOST: '127.0.0.1', PORT: '8888', MONITOR_DASHBOARD_TOKEN: '', SOURCEMAP_ADMIN_TOKEN: '', ...env,
  });
}

/** 测试应用选项：环境覆盖、依赖替换和真实基础设施开关。 */
export interface CreateTestAppOptions {
  realInfrastructure?: boolean;
  env?: NodeJS.ProcessEnv;
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/** 替换缓冲、Bull 与消费生命周期，保证普通 HTTP 测试不连接 Redis。 */
export function stubIngestion(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder.overrideProvider(INGEST_REDIS).useValue({})
    .overrideProvider(getQueueToken(INGEST_QUEUE)).useValue({close: async () => undefined})
    .overrideProvider(IngestionProcessor).useValue({
      // HTTP 刷新默认模拟已完成的空消费任务，专项测试可替换为真实消费者。
      flushNow: jest.fn(async () => ({ batches: 0, written: 0, invalid: 0, expired: 0, failed: false })),
    })
    .overrideProvider(IngestionLifecycle).useValue({})
    .overrideProvider(IngestionBuffer).useValue({enqueue: jest.fn(async () => undefined),status:async () => ({depth:0,inflight:0,bytes:0})});
}

/** 复用正式 HTTP 初始化流程，按选项决定使用替身还是真实基础设施。 */
export async function createTestApp({ env, configure, realInfrastructure }: CreateTestAppOptions = {}): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MONITOR_CONFIG).useValue(createTestConfig(env));
  if (!realInfrastructure) builder = stubIngestion(builder)
    .overrideProvider(DataSource).useValue(createDataSourceStub())
    .overrideProvider(DatabaseBootstrapService).useValue({cleanup:async () => undefined});
  const moduleRef = await (configure ? configure(builder) : builder).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(NEST_APP_OPTIONS);
  await setupApp(app);
  return app;
}
