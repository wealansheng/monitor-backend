/** 普通事件采集端点：校验请求后进入异步缓冲，成功返回空的 204。 */
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { MonitorIngestPipe } from './monitor-ingest.pipe';
import { MonitorService } from './monitor.service';
import type { MonitorIngestPayload } from './monitor.types';

/**
 * 上报入口。
 *
 * 请求体由 `registerRawBodyParsers` 以原始字节读取，再交给 `MonitorIngestPipe`
 * 解析与校验，因此这里声明 `Buffer` 而非对象类型。
 */
@Controller('api/v1/monitor')
export class MonitorController {
  constructor(private readonly monitorService: MonitorService) {}

  /** 由管道完成协议校验，等待缓冲准入成功后返回 204。 */
  @Post()
  @HttpCode(204)
  async receive(
    @Body(MonitorIngestPipe) payload: MonitorIngestPayload,
    @Req() request: Request,
  ): Promise<void> {
    await this.monitorService.receive(payload, {
      ip: request.ip ?? '',
      userAgent: request.get('user-agent') ?? '',
    });
  }
}
