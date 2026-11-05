/** 工作台模块：装配查询接口、业务服务与访问令牌守卫。 */
import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { DashboardService } from './dashboard.service';
import { SourceMapModule } from '../sourcemap/sourcemap.module';

/** 工作台模块：装配查询接口、业务服务与访问令牌守卫。 */
@Module({
  imports: [SourceMapModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardTokenGuard],
})
export class DashboardModule {}
