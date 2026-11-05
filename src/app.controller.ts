/** 服务基础路由：返回运行状态与四张业务表的配置。 */
import { Controller, Get, Inject } from '@nestjs/common';

import { MONITOR_CONFIG } from './config/config.constants';
import type { MonitorConfig } from './config/config.types';

/** 根路径健康检查：返回服务标识与当前使用的 MySQL 表清单。 */
@Controller()
export class AppController {
  constructor(@Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {}

  /** 返回服务信息、MySQL 存储类型和四类表名，不执行数据库写入。 */
  @Get()
  health(): Record<string, unknown> {
    const { database, tables, recordTable } = this.config.mysql;
    return {
      service: 'monitor service',
      endpoint: 'POST /api/v1/monitor',
      storage: 'MySQL',
      tables: [...Object.values(tables), recordTable].map((table) => `${database}.${table}`),
    };
  }
}
