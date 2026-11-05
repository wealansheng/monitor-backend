/** Source Map 模块：装配私有存储、查询和上传鉴权能力。 */
import { Module } from '@nestjs/common';

import { MONITOR_CONFIG } from '../config/config.constants';
import { MonitorConfig } from '../config/config.types';
import { MonitorRepository } from '../database/monitor.repository';
import { SourceMapController } from './sourcemap.controller';
import { SourceMapService } from './sourcemap.service';
import { SourceMapTokenGuard } from './sourcemap-token.guard';

/** Source Map 模块：装配私有存储、查询和上传鉴权能力。 */
@Module({
  controllers: [SourceMapController],
  providers: [
    SourceMapTokenGuard,
    {
      provide: SourceMapService,
      inject: [MONITOR_CONFIG, MonitorRepository],
      useFactory: (config: MonitorConfig, repository: MonitorRepository): SourceMapService =>
        new SourceMapService({ directory: config.sourceMaps.directory, repository }),
    },
  ],
  exports: [SourceMapService],
})
export class SourceMapModule {}
