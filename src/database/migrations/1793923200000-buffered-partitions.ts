/** 增量迁移：为旧数据补齐接收标识、幂等索引及普通事件日分区。 */
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { ENTITY_NAMES } from '../v1-schema';
import { initialPartitions } from '../retention';
import { quoteIdentifier as q } from '../schema';

/** 兼容已有数据的增量迁移，为异步重试幂等与按日保留建立结构。 */
export class BufferedPartitions1793923200000 implements MigrationInterface {
  readonly name = 'BufferedPartitions1793923200000';
  /** 分步补列、回填接收标识、调整索引并建立日分区，支持 DDL 中断后重跑。 */
  async up(runner: QueryRunner): Promise<void> {
    for (const category of ['performance','error','behavior'] as const) {
      const table = runner.connection.getMetadata(ENTITY_NAMES[category]).tableName;
      if (!await runner.hasColumn(table,'ingest_id')) await runner.query(`ALTER TABLE ${q(table)} ADD COLUMN ingest_id CHAR(36) NULL`);
      // MySQL DDL 隐式提交；逐步检查结构并只回填空标识，支持执行中断后重跑。
      // 每次回填 1000 行；相同 SDK 事件 UUID 的历史行也各自分配独立 ingest_id。
      for (;;) {
        const result: { affectedRows: number } = await runner.query(`UPDATE ${q(table)} SET ingest_id = UUID() WHERE ingest_id IS NULL LIMIT 1000`);
        if (result.affectedRows < 1000) break;
      }
      await runner.query(`ALTER TABLE ${q(table)} MODIFY COLUMN ingest_id CHAR(36) NOT NULL`);
      const indexes: { Key_name: string; Column_name: string }[] = await runner.query(`SHOW INDEX FROM ${q(table)}`);
      // MySQL 要求每个唯一键包含分区列，因此先调整主键，再添加消费幂等键。
      if (!indexes.some(index => index.Key_name === 'PRIMARY' && index.Column_name === 'timestamp')) {
        await runner.query(`ALTER TABLE ${q(table)} DROP PRIMARY KEY, ADD PRIMARY KEY (id,timestamp)`);
      }
      if (!indexes.some(index => index.Key_name === 'uq_ingest')) {
        await runner.query(`ALTER TABLE ${q(table)} ADD UNIQUE KEY uq_ingest (ingest_id,timestamp)`);
      }
      if (!indexes.some(index => index.Key_name === 'idx_app_type_time')) {
        await runner.query(`ALTER TABLE ${q(table)} ADD KEY idx_app_type_time (app_id(128),event_type,timestamp)`);
      }
      // 仅为尚未分区的普通表建立日分区；历史数据进入相应日分区或历史兜底。
      const partitions: { name: string | null }[] = await runner.query(
        'SELECT PARTITION_NAME AS name FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',[table]);
      if (!partitions[0]?.name) await runner.query(`ALTER TABLE ${q(table)} ${initialPartitions()}`);
    }
  }
  /** 该迁移涉及已清理分区，禁止自动回退，需通过备份恢复。 */
  async down(): Promise<void> {
    throw new Error('Partition migration cannot be reverted automatically; restore a backup instead.');
  }
}
