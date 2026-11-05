/** 通过数据库命名锁串行维护每日分区，并分批删除过期 Replay。 */
import { createHash } from 'node:crypto';
import type { DataSource, QueryRunner } from 'typeorm';
import type { MySqlConfig } from '../config/config.types';
import { DAY_MS, partitionDefinitions, retentionCutoff, utcDay } from './retention';
import { quoteIdentifier as q } from './schema';

/** 数据库返回的分区名称与上界；未来兜底上界为 MAXVALUE。 */
interface Partition { name: string; upperBound: string }
/** 在专用数据库连接持有命名锁期间维护分区和 Replay 过期数据。 */
export class PartitionMaintenance {
  constructor(private readonly source: DataSource, private readonly config: MySqlConfig) {}
  /** 持有按数据库隔离的 MySQL 命名锁；维护日分区后按每批 1000 行删除过期录制。 */
  async maintain(now = Date.now(), stopping = () => false): Promise<void> {
    // GET_LOCK 归属于连接，整个维护过程必须复用同一个 QueryRunner。
    const runner = this.source.createQueryRunner();
    const lock = 'monitor_partitions_'+createHash('sha256').update(this.config.database).digest('hex').slice(0,40);
    await runner.connect();
    let acquired = false;
    try {
      // 不等待其他实例持锁；当前轮跳过后，由下一小时的任务再尝试。
      const rows: { acquired: number }[] = await runner.query('SELECT GET_LOCK(?,0) AS acquired',[lock]);
      acquired = Number(rows[0]?.acquired) === 1;
      if (!acquired) return;
      for (const table of Object.values(this.config.tables)) {
        if (stopping()) return;
        await this.update(runner,table,now);
      }
      if (stopping()) return;
      const cutoff = retentionCutoff(this.config.retentionDays,now);
      // Replay 不分区，每次最多删除 1000 行，短批次表示本轮清理结束。
      while (!stopping()) {
        const result: { affectedRows: number } = await runner.query(
          `DELETE FROM ${q(this.config.recordTable)} WHERE started_at < ? ORDER BY started_at LIMIT 1000`,[cutoff]);
        if (result.affectedRows < 1000) break;
      }
    } finally {
      // 无论维护成功、失败或停止，都先释放命名锁，再归还池连接。
      try { if (acquired) await runner.query('SELECT RELEASE_LOCK(?)',[lock]); }
      finally { await runner.release(); }
    }
  }
  /** 按顺序读取当前表的有限分区元数据，用于识别日分区上界和兜底分区。 */
  private async partitions(runner: QueryRunner,table: string): Promise<Partition[]> {
    return runner.query(`SELECT PARTITION_NAME AS name, PARTITION_DESCRIPTION AS upperBound
      FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY PARTITION_ORDINAL_POSITION LIMIT 1024`,[table]);
  }
  /** 补齐保留窗口与未来分区，再删除上界不晚于截止时间的整体过期分区。 */
  private async update(runner: QueryRunner,table: string,now: number): Promise<void> {
    let parts = await this.partitions(runner,table);
    if (!parts[0]?.name) throw new Error(`Partition migration required for ${table}`);
    const cutoff = retentionCutoff(this.config.retentionDays,now);
    // 增大保留期时，首个覆盖负无穷的分区可能需要拆成历史兜底与独立日分区。
    const first = parts.find(part => part.upperBound !== 'MAXVALUE')!;
    const firstUpper = Number(first?.upperBound);
    if (first && firstUpper > cutoff+DAY_MS) {
      const definitions = [`PARTITION p_history_${cutoff} VALUES LESS THAN (${cutoff})`,
        ...partitionDefinitions(cutoff,firstUpper).map(def => 'PARTITION '+def)];
      await runner.query(`ALTER TABLE ${q(table)} REORGANIZE PARTITION ${q(first.name)} INTO (${definitions.join(',')})`);
      parts = await this.partitions(runner,table);
    }
    // 预建到当前日之后第八个零点，即覆盖当前日以及未来七个完整日。
    const finite = parts.filter(part => part.upperBound !== 'MAXVALUE');
    const lastUpper = Number(finite[finite.length-1]?.upperBound || cutoff);
    const future = utcDay(now)+8*DAY_MS;
    if (lastUpper < future) {
      // 停机跨越较久时用 catchup 分区承接过期范围，避免逐日补建大量已过期分区。
      const start = Math.max(lastUpper,cutoff);
      const definitions = [
        ...(lastUpper < cutoff ? [`PARTITION p_catchup_${cutoff} VALUES LESS THAN (${cutoff})`] : []),
        ...partitionDefinitions(start,future).map(def => 'PARTITION '+def),
        'PARTITION p_future VALUES LESS THAN MAXVALUE',
      ];
      await runner.query(`ALTER TABLE ${q(table)} REORGANIZE PARTITION p_future INTO (${definitions.join(',')})`);
      parts = await this.partitions(runner,table);
    }
    // 上界等于截止时间的分区整体过期；包含截止日的分区必须保留。
    const expired = parts.filter(part => part.upperBound !== 'MAXVALUE' && Number(part.upperBound) <= cutoff);
    if (expired.length) await runner.query(`ALTER TABLE ${q(table)} DROP PARTITION ${expired.map(part => q(part.name)).join(',')}`);
  }
}
