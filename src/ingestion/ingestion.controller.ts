/** 受工作台令牌保护的缓冲状态查询与立即入库接口。 */
import { Controller, Get, Header, HttpCode, Post, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DashboardTokenGuard } from '../dashboard/dashboard-token.guard';
import { IngestionBuffer } from './ingestion-buffer.service';
import { IngestionProcessor } from './ingestion.processor';
import type { FlushResult } from './ingestion.types';

/** 手动入库最多等待 30 秒；到期只结束 HTTP 等待，不中断持有租约的数据库事务。 */
export const FLUSH_WAIT_MS = 30000;

/** 提供管理状态与主动刷新操作；作用域是当前监控键前缀下的全部应用。 */
@Controller('api/v1/dashboard')
@UseGuards(DashboardTokenGuard)
export class IngestionController {
  constructor(
    private readonly buffer: IngestionBuffer,
    private readonly processor: IngestionProcessor,
  ) {}

  /** 读取消费状态并禁止浏览器缓存，访问权限由工作台令牌守卫校验。 */
  @Get('ingestion')
  @Header('Cache-Control', 'no-store')
  async status(): Promise<Record<string, unknown>> {
    return { ok: true, ...await this.buffer.status() };
  }

  /** 直接唤起现有消费者并等待确认，不经过定时调度，仍遵守全局租约和批次上限。 */
  @Post('ingestion/flush')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async flush(@Res({ passthrough: true }) response: Response): Promise<Record<string, unknown>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      // 同实例复用进行中的消费任务；超时后该任务继续运行，避免取消已提交但尚未确认的批次。
      const result = await Promise.race([
        this.processor.flushNow(),
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), FLUSH_WAIT_MS);
          timer.unref();
        }),
      ]);
      if (result?.failed) {
        throw new ServiceUnavailableException('Ingestion flush failed; unconfirmed messages retained for retry');
      }

      // 空缓冲才返回已完成；其他实例持锁、新数据持续进入或等待超时均可返回尚未排空。
      const status = await this.buffer.status();
      const completed = result !== null && Number(status.depth) === 0 && Number(status.inflight) === 0;
      response.status(completed ? 200 : 202);
      return {
        ok: true,
        completed,
        processed: result === null ? null : this.processed(result),
        ...status,
      };
    } catch (error) {
      // Redis 或数据库的原始异常可能含连接信息，只向调用方暴露明确的服务不可用错误。
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Ingestion flush unavailable; unconfirmed messages retained for retry');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 返回本次共享消费任务已确认的处理量，不将内部失败标志混入处理统计。 */
  private processed(result: FlushResult): Omit<FlushResult, 'failed'> {
    const { batches, written, invalid, expired } = result;
    return { batches, written, invalid, expired };
  }
}
