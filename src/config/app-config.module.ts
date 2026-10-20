import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { MONITOR_CONFIG } from './config.constants';
import { ENV_FILE_PATH, monitorConfiguration } from './configuration';

/**
 * 全局配置模块。
 *
 * `ConfigModule.forRoot` 负责把仓库根目录的 `.env` 读入 `process.env`（已存在的
 * 进程环境变量优先，与本地开发约定一致）；`MONITOR_CONFIG` 则把环境变量整理成
 * 校验过的强类型对象，供全局注入。
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [ENV_FILE_PATH],
      expandVariables: false,
    }),
  ],
  providers: [
    {
      provide: MONITOR_CONFIG,
      useFactory: () => monitorConfiguration(),
    },
  ],
  exports: [MONITOR_CONFIG],
})
export class AppConfigModule {}
