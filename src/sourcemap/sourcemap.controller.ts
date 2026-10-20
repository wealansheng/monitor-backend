import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { SourceMapService } from './sourcemap.service';
import { SourceMapTokenGuard } from './sourcemap-token.guard';

/**
 * 私有 Source Map 上传与错误还原查询。
 *
 * 上传请求体由 `registerRawBodyParsers` 以原始字节读取（只接受
 * `application/json`，上限由 `SOURCEMAP_MAX_BODY_SIZE` 控制），
 * 因此这里自行解析 JSON，以保留 `Empty body` / `Invalid JSON body` 提示。
 */
@Controller()
@UseGuards(SourceMapTokenGuard)
export class SourceMapController {
  constructor(private readonly sourceMapService: SourceMapService) {}

  @Post('api/v1/sourcemaps')
  async upload(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException('Empty body');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid JSON body');
    }

    const result = await this.sourceMapService.upload(payload);
    response.status(result.created ? 201 : 200);
    return { ok: true, ...result };
  }

  @Get('api/v1/monitor/errors/:eventId/symbolication')
  @Header('Cache-Control', 'no-store')
  async symbolicate(
    @Param('eventId') eventId: string,
    @Query('app_id') appId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.sourceMapService.symbolicate(appId, eventId);
    return { ok: true, ...result };
  }
}
