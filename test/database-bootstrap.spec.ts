/** 保留期维护测试：验证 UTC 边界、防重入、失败重试与关闭等待。 */
import { Logger } from '@nestjs/common';
import { DatabaseBootstrapService } from '../src/database/database-bootstrap.service';
import { PartitionMaintenance } from '../src/database/partition-maintenance';
import { retentionCutoff, DAY_MS, utcDay } from '../src/database/retention';
import { createDataSourceStub, createTestConfig } from './support/test-app';

/** 验证保留期维护的生命周期。 */
describe('retention lifecycle', () => {
  /** 检查并清理本用例状态，恢复模拟对象或隔离资源。 */
  afterEach(() => jest.restoreAllMocks());
  /** 验证 UTC 自然日截止时间，边界当天仍予以保留。 */
  it('uses UTC calendar retention and includes the boundary day', () => {
    const now = Date.parse('2026-11-05T15:30:00Z');
    expect(retentionCutoff(14,now)).toBe(Date.parse('2026-10-23T00:00:00Z'));
    expect(retentionCutoff(1,now)).toBe(utcDay(now));
    expect(retentionCutoff(14,now+DAY_MS)-retentionCutoff(14,now)).toBe(DAY_MS);
  });
  /** 验证维护任务不重入，关闭前等待当前任务结束。 */
  it('skips overlapping maintenance and waits before shutdown', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release=resolve;});
    const maintain = jest.spyOn(PartitionMaintenance.prototype,'maintain').mockReturnValue(pending);
    const service = new DatabaseBootstrapService(createDataSourceStub(),createTestConfig());
    const first = service.cleanup(123);
    expect(service.cleanup(124)).toBe(first);
    let done=false;
    const closing=service.beforeApplicationShutdown().then(()=>{done=true;});
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await Promise.all([first,closing]);
    await service.cleanup();
    expect(maintain).toHaveBeenCalledTimes(1);
  });
  /** 验证失败被记录，后续调用仍可再次维护。 */
  it('logs failed maintenance and retries later', async () => {
    const log=jest.spyOn(Logger.prototype,'error').mockImplementation(()=>undefined);
    const maintain=jest.spyOn(PartitionMaintenance.prototype,'maintain').mockRejectedValueOnce(new Error('offline')).mockResolvedValue();
    const service=new DatabaseBootstrapService(createDataSourceStub(),createTestConfig());
    await service.cleanup();
    await service.cleanup();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'));
    expect(maintain).toHaveBeenCalledTimes(2);
  });
});
