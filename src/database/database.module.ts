import { Global, Module } from '@nestjs/common';
import { createClient } from '@clickhouse/client';

import { MONITOR_CONFIG } from '../config/config.constants';
import { MonitorConfig } from '../config/config.types';
import { ClickHouseClientPort } from './clickhouse-client.port';
import { CLICKHOUSE_CLIENT } from './database.constants';
import { DatabaseBootstrapService } from './database-bootstrap.service';
import { MonitorRepository } from './monitor.repository';

/**
 * 数据访问模块（全局）。
 *
 * 只在这里把配置和 `@clickhouse/client` 组装成可注入对象：
 * `MonitorRepository` 保持与框架无关，构造函数仍接收普通的配置对象，
 * 因此单元测试可以直接 `new MonitorRepository({ client, database, tables })`。
 */
@Global()
@Module({
  providers: [
    {
      provide: CLICKHOUSE_CLIENT,
      inject: [MONITOR_CONFIG],
      useFactory: (config: MonitorConfig): ClickHouseClientPort =>
        createClient({
          url: config.clickhouse.url,
          username: config.clickhouse.username,
          password: config.clickhouse.password,
        }),
    },
    {
      provide: MonitorRepository,
      inject: [CLICKHOUSE_CLIENT, MONITOR_CONFIG],
      useFactory: (client: ClickHouseClientPort, config: MonitorConfig): MonitorRepository =>
        new MonitorRepository({
          client,
          database: config.clickhouse.database,
          tables: config.clickhouse.tables,
          recordTable: config.clickhouse.recordTable,
        }),
    },
    DatabaseBootstrapService,
  ],
  exports: [CLICKHOUSE_CLIENT, MonitorRepository],
})
export class DatabaseModule {}
