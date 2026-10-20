import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, setupApp } from '../../src/app.setup';
import { MONITOR_CONFIG } from '../../src/config/config.constants';
import { monitorConfiguration } from '../../src/config/configuration';
import { MonitorConfig } from '../../src/config/config.types';
import { ClickHouseClientPort } from '../../src/database/clickhouse-client.port';
import { CLICKHOUSE_CLIENT } from '../../src/database/database.constants';

/** 最小可用的 ClickHouse 客户端替身：不产生任何网络访问。 */
export function createClickHouseStub(): ClickHouseClientPort {
  return {
    command: async () => undefined,
    insert: async () => undefined,
    query: async () => ({ json: async () => [] }),
    close: async () => undefined,
  };
}

/**
 * 显式构造测试配置，避免用例结果依赖仓库根目录的 `.env`。
 * 令牌默认留空，需要管理接口的用例再按需传入。
 */
export function createTestConfig(env: NodeJS.ProcessEnv = {}): MonitorConfig {
  return monitorConfiguration({
    HOST: '127.0.0.1',
    PORT: '8888',
    MONITOR_DASHBOARD_TOKEN: '',
    SOURCEMAP_ADMIN_TOKEN: '',
    ...env,
  });
}

export interface CreateTestAppOptions {
  env?: NodeJS.ProcessEnv;
  /** 追加 provider 覆盖，例如替换 MonitorRepository 或某个 Service。 */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/**
 * 构建与生产启动完全一致的应用实例。
 *
 * 复用 `setupApp`，因此原始体解析器、全局管道与异常过滤器、
 * 以及 404 兜底都与线上一致；ClickHouse 客户端被替换为替身。
 */
export async function createTestApp({
  env,
  configure,
}: CreateTestAppOptions = {}): Promise<NestExpressApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLICKHOUSE_CLIENT)
    .useValue(createClickHouseStub())
    .overrideProvider(MONITOR_CONFIG)
    .useValue(createTestConfig(env));

  const moduleRef = await (configure ? configure(builder) : builder).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(NEST_APP_OPTIONS);
  await setupApp(app);
  return app;
}
