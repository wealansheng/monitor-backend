/** 普通事件模块：注册接收控制器、服务与上报校验管道。 */
import { Module } from '@nestjs/common';

import { MonitorController } from './monitor.controller';
import { MonitorIngestPipe } from './monitor-ingest.pipe';
import { MonitorService } from './monitor.service';

/** 普通事件模块：注册接收控制器、服务与上报校验管道。 */
@Module({
  controllers: [MonitorController],
  providers: [MonitorService, MonitorIngestPipe],
  exports: [MonitorService],
})
export class MonitorModule {}
