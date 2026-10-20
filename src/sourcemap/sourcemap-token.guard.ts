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
 * Source Map 管理接口的令牌校验。
 *
 * 未配置 `SOURCEMAP_ADMIN_TOKEN` 时管理接口不对外存在，返回 404；
 * 令牌错误返回 401 `Unauthorized`。
 */
@Injectable()
export class SourceMapTokenGuard implements CanActivate {
  constructor(@Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const { token } = this.config.sourceMaps;
    if (!token) {
      throw new NotFoundException('Not Found');
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!matchesBearerToken(request.get('authorization'), token)) {
      throw new UnauthorizedException('Unauthorized');
    }
    return true;
  }
}
