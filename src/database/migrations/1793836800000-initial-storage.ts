/** 首版版本化迁移：建立三类普通事件表与 Replay 分片表。 */
import { MigrationInterface, QueryRunner } from 'typeorm';
import { getSchemaStatements } from '../schema';
import { ENTITY_NAMES } from '../v1-schema';

/** 初始建表迁移；后续结构调整由独立版本负责。 */
export class InitialStorage1793836800000 implements MigrationInterface {
  readonly name = 'InitialStorage1793836800000';
  /** 以可配置表名执行固定首版建表语句。 */
  async up(queryRunner: QueryRunner): Promise<void> {
    const table = (name: keyof typeof ENTITY_NAMES) => queryRunner.connection.getMetadata(ENTITY_NAMES[name]).tableName;
    const config = { tables: { performance: table('performance'), error: table('error'), behavior: table('behavior') }, recordTable: table('record') };
    // MySQL DDL 隐式提交；IF NOT EXISTS 允许初始化中断后重试，已建表不会重复创建。
    for (const statement of getSchemaStatements(config)) await queryRunner.query(statement);
  }
  /** 禁止自动回退首版结构，需通过备份恢复，避免自动删除已有数据。 */
  async down(): Promise<void> {
    throw new Error('Initial storage migration cannot be reverted automatically; restore a backup instead.');
  }
}
