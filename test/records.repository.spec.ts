import { RecordsRepository } from '../src/records/records.repository';
import { createTestConfig, createClickHouseStub } from './support/test-app';
import { getSchemaStatements } from '../src/database/schema';

describe('recording storage', () => {
  it('preserves conflict variants in the merge key and creates the database first', () => {
    const config = createTestConfig();
    const statements = getSchemaStatements({ database: config.clickhouse.database, tables: config.clickhouse.tables, recordTable: 'custom_records' });
    expect(statements[0]).toContain('CREATE DATABASE');
    const ddl = statements.find(query => query.includes('`custom_records`'))!;
    expect(ddl).toContain('ReplacingMergeTree(received_at)');
    expect(ddl).toContain('chunk_index, variant_hash');
    expect(ddl).toContain('INTERVAL 30 DAY');
  });
  it.each([
    [2, 2, 1, 2, 'complete'], [1, 1, 1, 2, 'incomplete'], [2, 3, 1, 2, 'corrupt'], [2, 2, 2, 2, 'corrupt'],
  ])('identifies deduplicated completeness (%s/%s)', async (received, variants, metadata_versions, expected, status) => {
    const client = createClickHouseStub();
    client.query = jest.fn(async () => ({ json: async <T>() => [{ meta: '{}', received, variants, metadata_versions, expected }] as T[] }));
    const repository = new RecordsRepository(client, createTestConfig());
    const result = await repository.find('app', '81111111-1111-4111-8111-111111111111');
    expect(result?.status).toBe(status);
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining(' FINAL WHERE app_id = {appId:String}'), query_params: expect.objectContaining({ appId: 'app' }) }));
  });
});
