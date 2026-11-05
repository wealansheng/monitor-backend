/** 管理工作台只读接口：应用、概览、事件与源码定位查询。 */
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

  /** 按应用和事件标识还原源码位置，沿用工作台只读权限。 */
  @Get('errors/:eventId/symbolication')
  @Header('Cache-Control', 'no-store')
  async symbolicate(
    @Param('eventId') eventId: string,
    @Query() query: AppIdQueryDto,
  ): Promise<Record<string, unknown>> {
    return { ok: true, ...(await this.sourceMapService.symbolicate(query.app_id, eventId)) };
  }

  /** 列出保留窗口内的应用摘要。 */
  @Get('apps')
  async apps(): Promise<Record<string, unknown>> {
    return { ok: true, ...(await this.dashboardService.apps()) };
  }

  /** 校验查询参数后返回当前应用的概览聚合。 */
  @Get('overview')
  async overview(@Query() query: OverviewQueryDto): Promise<Record<string, unknown>> {
    const result = await this.dashboardService.overview({
      appId: query.app_id,
      hours: query.hours,
    });
    return { ok: true, ...result };
  }

  /** 返回当前应用筛选后的事件分页。 */
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

  /** 按事件 UUID 与可选类型查询详情。 */
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
