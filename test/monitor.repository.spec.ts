/** 事件持久层回归：验证参数化查询、指纹、数字转换和内部字段隐藏。 */
import { createHash } from 'node:crypto';
import { MonitorRepository } from '../src/database/monitor.repository';
import { createDataSourceStub, createTestConfig } from './support/test-app';
import { normalizeRow } from '../src/database/data-source';

/** 验证普通事件 Repository 的 SQL 与响应兼容。 */
describe('MySQL event repository', () => {
  /** 验证关键词中特殊字符按字面匹配，值参数绑定且仅查询选中类别。 */
  it('keeps keyword characters literal and values parameterized, scans only the selected category', async () => {
    const source = createDataSourceStub();
    const calls: { sql: string; params: unknown[] }[] = [];
    source.query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return sql.includes('COUNT(*) AS total') ? [{ total: '7' }] : [{ eventId: 'e', timestamp: '1712345678901' }];
    }) as typeof source.query;
    const repository = new MonitorRepository(source, createTestConfig().mysql);
    const keyword = "白屏_%'\\";
    const result = await repository.findDashboardEvents({
      appId: "app' OR 1=1", from: 1, to: 2, eventType: 'error', keyword, limit: 20, offset: 40,
    });
    expect(result).toEqual({ events: [{ eventId: 'e', timestamp: 1712345678901 }], total: 7 });
    expect(calls).toHaveLength(2);
    for (const { sql, params } of calls) {
      expect(sql).toContain('frontend_error');
      expect(sql).not.toContain('frontend_behavior');
      expect(sql).not.toContain(keyword);
      expect(sql).not.toContain("app' OR 1=1");
      expect(sql).toContain('LOCATE(LOWER(?)');
      expect(params).toEqual(expect.arrayContaining([keyword, "app' OR 1=1", 'error']));
    }
    expect(calls[1].sql).toContain('LIMIT 1');
    await expect(repository.findDashboardEvents({
      appId: 'a', from: 1, to: 2, eventType: 'toString', keyword: '', limit: 1, offset: 0,
    })).rejects.toThrow('不支持的事件类型');
  });

  /** 验证错误指纹输入规则，以及普通事件 UUID 重复仍追加。 */
  it('computes error fingerprints and retains duplicate ordinary event UUIDs', async () => {
    const source = createDataSourceStub();
    const insert = jest.fn(async (_rows: unknown) => undefined);
    const builder = {insert:()=>builder,values:(_rows:unknown)=>{insert(_rows);return builder;},orUpdate:()=>builder,execute:async()=>undefined};
    source.getRepository = jest.fn(() => ({ createQueryBuilder:()=>builder })) as unknown as typeof source.getRepository;
    const repository = new MonitorRepository(source, createTestConfig().mysql);
    const rows = [{ event_id: 'same', error_type: 'js', name: 'Error', message: 'failure', filename: 'app.js' },
      { event_id: 'same', fingerprint: 'custom' }];
    await repository.insertMany('error', rows);
    expect(insert.mock.calls[0]).toEqual([[
      { ...rows[0], ingest_id: expect.any(String), fingerprint_hash: createHash('sha256').update('js|Error|failure|app.js').digest('hex') },
      { ...rows[1], ingest_id: expect.any(String), fingerprint_hash: createHash('sha256').update('custom').digest('hex') },
    ]]);
  });

  /** 验证数值字段转换，不改变标识符、哈希与 JSON 字符串。 */
  it('normalizes numeric data without coercing identifiers, hashes or JSON strings', () => {
    expect(normalizeRow({ id: '9', timestamp: '9007199254740991', sample_rate: 0.2,
      fingerprint_hash: '0000123', event_id: '123', stack_frames: '[]', tags: '{"a":"b"}' }))
      .toEqual({ timestamp: Number.MAX_SAFE_INTEGER, sample_rate: 0.2,
        fingerprint_hash: '0000123', event_id: '123', stack_frames: '[]', tags: { a: 'b' } });
  });

  /** 验证详情依次查表并隐藏内部主键。 */
  it('searches event detail categories in order and never exposes the internal key', async () => {
    const source = createDataSourceStub();
    const findOne = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: '1', action: 'click', timestamp: '10' });
    source.getRepository = jest.fn(() => ({ findOne })) as unknown as typeof source.getRepository;
    const result = await new MonitorRepository(source, createTestConfig().mysql).findDashboardEvent({ appId: 'a', eventId: 'ABC' });
    expect(result).toEqual({ category: 'behavior', event: { action: 'click', timestamp: 10 } });
    expect(findOne.mock.calls[0][0].where).toMatchObject({ app_id: 'a', event_id: 'abc' });
    expect(findOne.mock.calls[0][0].where.timestamp).toBeDefined();
  });
});
