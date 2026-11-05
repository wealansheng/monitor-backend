/** 全局数据库模块：由 Nest 管理 TypeORM 连接池与业务 Repository。 */
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { MONITOR_CONFIG } from '../config/config.constants';
import { MonitorConfig } from '../config/config.types';
import { DatabaseBootstrapService } from './database-bootstrap.service';
import { dataSourceOptions } from './data-source';
import { MonitorRepository } from './monitor.repository';

/** 全局数据库模块：由 Nest 管理 TypeORM 连接池与业务 Repository。 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot(), TypeOrmModule.forRootAsync({
    inject: [MONITOR_CONFIG],
    useFactory: (config: MonitorConfig) => ({
      ...dataSourceOptions(config.mysql), migrationsRun: config.mysql.autoMigrate, retryAttempts: 1,
    }),
  })],
  providers: [
    {
      provide: MonitorRepository, inject: [DataSource, MONITOR_CONFIG],
      useFactory: (source: DataSource, config: MonitorConfig) => new MonitorRepository(source, config.mysql),
    },
    DatabaseBootstrapService,
  ],
  exports: [TypeOrmModule, MonitorRepository],
})
export class DatabaseModule {}
