import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { DashboardTokenGuard } from './dashboard-token.guard';
import { DashboardService } from './dashboard.service';
import { SourceMapModule } from '../sourcemap/sourcemap.module';

@Module({
  imports: [SourceMapModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardTokenGuard],
})
export class DashboardModule {}
