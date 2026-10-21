import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppConfigModule } from './config/app-config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DatabaseModule } from './database/database.module';
import { MonitorModule } from './monitor/monitor.module';
import { SourceMapModule } from './sourcemap/sourcemap.module';
import { RecordsModule } from './records/records.module';

/**
 * 根模块。
 *
 * `DashboardModule` 与 `SourceMapModule` 始终挂载，但它们的守卫在对应令牌未配置时
 * 返回 404，等价于旧实现“未配置则不注册路由”的行为。
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, MonitorModule, DashboardModule, SourceMapModule, RecordsModule],
  controllers: [AppController],
})
export class AppModule {}
