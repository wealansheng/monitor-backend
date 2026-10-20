import { Module } from '@nestjs/common';

import { MonitorController } from './monitor.controller';
import { MonitorIngestPipe } from './monitor-ingest.pipe';
import { MonitorService } from './monitor.service';

@Module({
  controllers: [MonitorController],
  providers: [MonitorService, MonitorIngestPipe],
  exports: [MonitorService],
})
export class MonitorModule {}
