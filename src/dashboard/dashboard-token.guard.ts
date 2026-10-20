import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { matchesBearerToken } from '../common/security/bearer-token.util';
import { MONITOR_CONFIG } from '../config/config.constants';
import { MonitorConfig } from '../config/config.types';

/**
 * 监控工作台只读接口的令牌校验。
 *
 * 未配置 `MONITOR_DASHBOARD_TOKEN` 时整个管理接口都不对外存在，
 * 因此返回 404 而不是 401，与旧实现“未配置则不挂载路由”的表现一致。
 */
@Injectable()
export class DashboardTokenGuard implements CanActivate {
  constructor(@Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const { token } = this.config.dashboard;
    if (!token) {
      throw new NotFoundException('Not Found');
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!matchesBearerToken(request.get('authorization'), token)) {
      throw new UnauthorizedException('Dashboard token required');
    }
    return true;
  }
}
