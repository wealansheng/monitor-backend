import { Controller, Get, Inject } from '@nestjs/common';

import { MONITOR_CONFIG } from './config/config.constants';
import { MonitorConfig } from './config/config.types';

/** 根路径健康检查：返回服务标识与当前使用的 ClickHouse 表清单。 */
@Controller()
export class AppController {
  constructor(@Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {}

  @Get()
  health(): Record<string, unknown> {
    const { database, tables } = this.config.clickhouse;
    return {
      service: 'monitor service',
      endpoint: 'POST /api/v1/monitor',
      storage: 'ClickHouse',
      tables: Object.values(tables).map((table) => `${database}.${table}`),
    };
  }
}
