import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';

import { DashboardTokenGuard } from './dashboard-token.guard';
import { DashboardService } from './dashboard.service';
import { AppIdQueryDto, EventQueryDto, EventsQueryDto, OverviewQueryDto } from './dto/dashboard-query.dto';
import { SourceMapService } from '../sourcemap/sourcemap.service';

/**
 * 监控工作台只读聚合查询。
 * 令牌校验在守卫中完成，早于参数校验（未授权时返回 401，与旧实现一致）。
 */
@Controller('api/v1/dashboard')
@UseGuards(DashboardTokenGuard)
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly sourceMapService: SourceMapService,
  ) {}

  @Get('errors/:eventId/symbolication')
  @Header('Cache-Control', 'no-store')
  async symbolicate(
    @Param('eventId') eventId: string,
    @Query() query: AppIdQueryDto,
  ): Promise<Record<string, unknown>> {
    return { ok: true, ...(await this.sourceMapService.symbolicate(query.app_id, eventId)) };
  }

  @Get('apps')
  async apps(): Promise<Record<string, unknown>> {
    return { ok: true, ...(await this.dashboardService.apps()) };
  }

  @Get('overview')
  async overview(@Query() query: OverviewQueryDto): Promise<Record<string, unknown>> {
    const result = await this.dashboardService.overview({
      appId: query.app_id,
      hours: query.hours,
    });
    return { ok: true, ...result };
  }

  @Get('events')
  async events(@Query() query: EventsQueryDto): Promise<Record<string, unknown>> {
    const result = await this.dashboardService.events({
      appId: query.app_id,
      hours: query.hours,
      eventType: query.event_type,
      keyword: query.keyword ?? '',
      limit: query.limit,
      offset: query.offset,
    });
    return { ok: true, ...result };
  }

  @Get('event')
  async event(@Query() query: EventQueryDto): Promise<Record<string, unknown>> {
    const result = await this.dashboardService.event({
      appId: query.app_id,
      eventId: query.event_id,
      eventType: query.event_type,
    });
    return { ok: true, ...result };
  }
}
