/** Replay 数据结构回归：验证可配置表名、变体唯一键和时间索引。 */
import { RecordsRepository } from '../src/records/records.repository';
import { createTestConfig, createDataSourceStub } from './support/test-app';
import { getSchemaStatements } from '../src/database/schema';

/** 验证 Replay 数据表结构。 */
describe('MySQL recording storage', () => {
  /** 验证自定义表名下的变体唯一约束与时间索引。 */
  it('has a variant unique key and timestamp indexes with configurable names', () => {
    const config = createTestConfig().mysql;
    const statements = getSchemaStatements({ ...config, recordTable: 'custom_records' });
    const ddl = statements.find(query => query.includes('`custom_records`'))!;
    expect(ddl).toContain('UNIQUE KEY `uq_record_variant` (`app_id`, `record_id`, `chunk_index`, `variant_hash`)');
    expect(ddl).toContain('KEY `idx_retention` (`started_at`)');
  });
  it.each([
    [2, 2, 1, 2, 'complete'], [1, 1, 1, 2, 'incomplete'], [2, 3, 1, 2, 'corrupt'], [2, 2, 2, 2, 'corrupt'],
  ])('identifies completeness (%s/%s)', async (received, variants, metadata_versions, expected, status) => {
    const source = createDataSourceStub();
    source.query = jest.fn(async () => [{
      meta: '{}', received: String(received), variants: String(variants),
      metadata_versions: String(metadata_versions), expected,
    }]) as typeof source.query;
    const result = await new RecordsRepository(source, createTestConfig()).find('app', '81111111-1111-4111-8111-111111111111');
    expect(result?.status).toBe(status);
    expect(result?.received_chunks).toBe(received);
  });
});
