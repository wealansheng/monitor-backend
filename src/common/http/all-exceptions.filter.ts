import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/** body-parser 抛出的错误形状。 */
interface BodyParserError {
  type?: string;
  statusCode?: number;
  status?: number;
  message?: string;
}

interface ResolvedError {
  status: number;
  message: string;
  /** 是否为未预期错误（需要写日志，并向客户端隐藏细节）。 */
  unexpected: boolean;
}

/**
 * Nest 内置的兜底 404 会抛出 `NotFoundException('Cannot GET /path')`，
 * 这里识别该形式并还原成项目统一的 `Not Found` 文案。
 */
const UNMATCHED_ROUTE_PATTERN = /^Cannot [A-Z]+ \//;

/**
 * 统一异常出口。
 *
 * 保持既有响应协议：始终返回 `{ ok: false, error: <消息> }`；
 * 5xx 只暴露 `Internal Server Error` 并记录日志；请求体超限统一返回 413。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('MonitorException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const resolved = this.resolve(exception);

    if (resolved.unexpected) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`请求处理失败: ${error.message}`, error.stack);
    }

    response.status(resolved.status).json({ ok: false, error: resolved.message });
  }

  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const message = this.messageOf(exception);
      return {
        status,
        // 未命中路由时保持与旧实现一致的文案。
        message: status === 404 && UNMATCHED_ROUTE_PATTERN.test(message) ? 'Not Found' : message,
        unexpected: status >= 500,
      };
    }

    const error = exception as BodyParserError | null | undefined;
    if (error?.type === 'entity.too.large') {
      return { status: 413, message: 'Payload too large', unexpected: false };
    }

    const status = this.statusOf(error);
    if (status < 500) {
      return { status, message: error?.message || 'Bad Request', unexpected: false };
    }

    return { status: 500, message: 'Internal Server Error', unexpected: true };
  }

  private statusOf(error: BodyParserError | null | undefined): number {
    if (typeof error?.statusCode === 'number') return error.statusCode;
    if (typeof error?.status === 'number') return error.status;
    return 500;
  }

  private messageOf(exception: HttpException): string {
    const payload = exception.getResponse();

    if (typeof payload === 'string') return payload;

    const message = (payload as { message?: unknown } | null)?.message;
    if (Array.isArray(message)) return String(message[0] ?? exception.message);
    if (typeof message === 'string') return message;

    return exception.message;
  }
}
