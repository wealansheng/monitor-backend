import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

import { MONITOR_CONFIG } from '../config/config.constants';
import { MonitorConfig } from '../config/config.types';
import { ClickHouseClientPort } from './clickhouse-client.port';
import { CLICKHOUSE_CLIENT } from './database.constants';
import { MonitorRepository } from './monitor.repository';

/**
 * ClickHouse 连接的生命周期。
 *
 * 启动时按旧实现的行为检查连接（或按 `CLICKHOUSE_AUTO_MIGRATE` 建表补列），
 * 连接不可用时直接让启动失败；关闭时释放连接池。
 */
@Injectable()
export class DatabaseBootstrapService implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(CLICKHOUSE_CLIENT) private readonly client: ClickHouseClientPort,
    @Inject(MONITOR_CONFIG) private readonly config: MonitorConfig,
    private readonly repository: MonitorRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.clickhouse.autoMigrate) {
      await this.repository.initialize();
      return;
    }

    const result = await this.client.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    await result.json();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
