/** 采集生命周期：检查共享 Redis、定时触发消费并有序释放连接。 */
import { InjectQueue } from '@nestjs/bull';
import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bull';
import type Redis from 'ioredis';
import type { MonitorConfig } from '../config/config.types';
import { MONITOR_CONFIG } from '../config/config.constants';
import { INGEST_QUEUE, INGEST_REDIS } from './ingestion.types';
import { IngestionProcessor } from './ingestion.processor';

/** 管理 Redis 启动检查、周期触发和消费连接的有序关闭。 */
@Injectable()
export class IngestionLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(IngestionLifecycle.name);
  private timer?: NodeJS.Timeout;
  private scheduling = false;
  private stopping = false;
  constructor(@Inject(INGEST_REDIS) private readonly redis: Redis,
    @InjectQueue(INGEST_QUEUE) private readonly queue: Queue,
    @Inject(MONITOR_CONFIG) private readonly config: MonitorConfig,
    private readonly processor: IngestionProcessor) {}
  /** 检查 Redis 版本与 noeviction 策略；记录内存及持久化现状，再启动刷新定时器。 */
  async onApplicationBootstrap(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
    await this.redis.ping();
    // 只有显式开启时才修改共享 Redis 的全局配置。
    if (process.env.REDIS_CONFIGURE_SERVER === 'true') {
      // 设置全实例内存预算，未配置时使用 512 MiB。
      await this.redis.config(
        'SET',
        'maxmemory',
        process.env.REDIS_MAXMEMORY || '512mb',
      );
      // 达到上限时拒绝新增写入，避免随机淘汰队列和 Session。
      await this.redis.config('SET', 'maxmemory-policy', 'noeviction');
      // 设置每秒同步磁盘，再开启 AOF 持久化。
      await this.redis.config('SET', 'appendfsync', 'everysec');
      await this.redis.config('SET', 'appendonly', 'yes');
    }
    // 共享实例只能检查不能擅自修改；noeviction 防止 Redis 随机淘汰缓冲或 Bull 内部键。
    const policy = await this.redis.config('GET','maxmemory-policy') as string[];
    if (policy[1] !== 'noeviction') throw new Error('Redis ingestion requires maxmemory-policy=noeviction; shared Redis settings are not changed automatically');
    const server = await this.redis.info('server');
    const version = server.match(/redis_version:([^\r\n]+)/)?.[1] || '';
    if (!/^\d+\./.test(version) || Number(version.split('.')[0]) < 5) throw new Error('Redis 5 or newer is required');
    // 只提示全局内存和 AOF 现状，持久化与实例预算由运维统一配置。
    const memory = await this.redis.info('memory');
    if (/maxmemory:0\r?\n/.test(memory)) this.logger.warn('Redis maxmemory is unlimited; configure a shared-instance memory ceiling separately');
    const persistence = await this.redis.info('persistence');
    if (/aof_enabled:0\r?\n/.test(persistence)) this.logger.warn('Redis AOF is disabled; recovery is limited to data retained by Redis');
    // 定时投递确保低流量也刷新；首轮立即触发，以恢复重启前遗留的在途批次。
    this.timer = setInterval(() => void this.schedule(),this.config.ingestion.flushIntervalMs);
    this.timer.unref();
    await this.schedule();
  }
  /** 只投递固定标识的空载荷控制任务，日志内容始终留在有界缓冲中。 */
  private async schedule(): Promise<void> {
    // 防止定时器在前一次投递尚未完成时重复请求 Redis。
    if (this.scheduling || this.stopping) return;
    this.scheduling = true;
    try {
      // 全局只保留一个小型控制任务；日志载荷仅存在有界 List，不重复存入 Bull。
      await this.queue.add('flush',{}, { jobId: 'flush', removeOnComplete: true, removeOnFail: true });
    } catch { this.logger.warn('Could not schedule ingestion flush; next interval will retry'); }
    finally { this.scheduling = false; }
  }
  /** 先停止触发并等待消费结束，再关闭 Bull 与原始 Redis 长连接。 */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    // 消费者先停再关连接，未确认的在途数据留待下次启动恢复。
    await this.processor.beforeApplicationShutdown();
    await this.queue.close();
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
