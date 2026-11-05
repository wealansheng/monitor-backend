/** 数据库启动检查与定时保留期维护，关闭时等待当前维护结束。 */
import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { MONITOR_CONFIG } from '../config/config.constants';
import type { MonitorConfig } from '../config/config.types';
import { PartitionMaintenance } from './partition-maintenance';

/** 启动检查数据库，并通过同实例互斥的定时任务维护保留期。 */
@Injectable()
export class DatabaseBootstrapService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(DatabaseBootstrapService.name);
  private running?: Promise<void>;
  private stopping = false;
  constructor(private readonly source: DataSource, @Inject(MONITOR_CONFIG) private readonly config: MonitorConfig) {}
  /** 确认数据库连接可用，并异步触发首次维护以免等待清理阻塞启动。 */
  async onApplicationBootstrap(): Promise<void> {
    await this.source.query('SELECT 1');
    void this.cleanup();
  }
  /** 每小时触发维护；同实例复用进行中的任务，失败只记日志并等待下次重试。 */
  @Cron('0 0 * * * *',{timeZone:'UTC'})
  cleanup(now = Date.now()): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    this.running = new PartitionMaintenance(this.source,this.config.mysql).maintain(now,()=>this.stopping)
      .catch((error: unknown) => this.logger.error(`MySQL retention maintenance failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.running = undefined; });
    return this.running;
  }
  /** 设置停止标志，并等待当前维护连接释放后结束关闭流程。 */
  async beforeApplicationShutdown(): Promise<void> { this.stopping = true; await this.running; }
}
