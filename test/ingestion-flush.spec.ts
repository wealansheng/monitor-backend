/** 立即入库接口与消费者回归：覆盖权限、确认顺序、故障、互斥及 HTTP 等待上限。 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import request from 'supertest';
import { BatchWriter } from '../src/ingestion/batch-writer.service';
import { IngestionBuffer } from '../src/ingestion/ingestion-buffer.service';
import { FLUSH_WAIT_MS, IngestionController } from '../src/ingestion/ingestion.controller';
import { IngestionProcessor } from '../src/ingestion/ingestion.processor';
import type { FlushResult } from '../src/ingestion/ingestion.types';
import { createTestApp } from './support/test-app';

/** 创建独立模拟依赖，默认模拟空缓冲与已完成消费。 */
function dependencies() {
  const result: FlushResult = { batches: 0, written: 0, invalid: 0, expired: 0, failed: false };
  return {
    buffer: { status: jest.fn(async () => ({ depth: 0, inflight: 0, bytes: 0 })) },
    processor: { flushNow: jest.fn(async () => result) },
  };
}

/** HTTP 层只负责鉴权、等待与明确响应，不另建数据库写入通道。 */
describe('立即入库 HTTP 接口', () => {
  /** 未授权请求不得触发消费，也不得读取缓冲状态。 */
  it('缺少或错误令牌时返回 401，未启用管理接口时返回 404', async () => {
    const mocks = dependencies();
    const app = await createTestApp({
      env: { MONITOR_DASHBOARD_TOKEN: 'flush-token' },
      configure: builder => builder.overrideProvider(IngestionProcessor).useValue(mocks.processor)
        .overrideProvider(IngestionBuffer).useValue(mocks.buffer),
    });
    try {
      await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush').expect(401);
      await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush')
        .set('Authorization', 'Bearer wrong').expect(401);
      expect(mocks.processor.flushNow).not.toHaveBeenCalled();
      expect(mocks.buffer.status).not.toHaveBeenCalled();
    } finally { await app.close(); }

    const disabled = await createTestApp();
    try {
      await request(disabled.getHttpServer()).post('/api/v1/dashboard/ingestion/flush').expect(404);
    } finally { await disabled.close(); }
  });

  /** 成功必须经过消费完成与状态确认，POST 不使用 Nest 默认的 201。 */
  it('排空后返回 200、已确认处理量与最新状态，并禁止缓存', async () => {
    const mocks = dependencies();
    mocks.processor.flushNow.mockResolvedValue({ batches: 2, written: 501, invalid: 1, expired: 1, failed: false });
    const app = await createTestApp({
      env: { MONITOR_DASHBOARD_TOKEN: 'flush-token' },
      configure: builder => builder.overrideProvider(IngestionProcessor).useValue(mocks.processor)
        .overrideProvider(IngestionBuffer).useValue(mocks.buffer),
    });
    try {
      const response = await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush')
        .set('Authorization', 'Bearer flush-token').expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        ok: true, completed: true,
        processed: { batches: 2, written: 501, invalid: 1, expired: 1 },
        depth: 0, inflight: 0, bytes: 0,
      });
      expect(mocks.processor.flushNow).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  /** 其他实例持锁或仍有数据时明确返回未完成，不能误报全部落库。 */
  it('仍有在途数据时返回 202 和 completed=false', async () => {
    const mocks = dependencies();
    mocks.buffer.status.mockResolvedValue({ depth: 2, inflight: 1, bytes: 1024 });
    const app = await createTestApp({
      env: { MONITOR_DASHBOARD_TOKEN: 'flush-token' },
      configure: builder => builder.overrideProvider(IngestionProcessor).useValue(mocks.processor)
        .overrideProvider(IngestionBuffer).useValue(mocks.buffer),
    });
    try {
      const response = await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush')
        .set('Authorization', 'Bearer flush-token').expect(202);
      expect(response.body).toMatchObject({ ok: true, completed: false, depth: 2, inflight: 1 });
    } finally { await app.close(); }
  });

  /** 写入失败与原始驱动异常均不得包装为成功，也不暴露连接细节。 */
  it('数据库失败或 Redis 异常返回脱敏的 503', async () => {
    const mocks = dependencies();
    mocks.processor.flushNow.mockResolvedValueOnce({ batches: 0, written: 0, invalid: 0, expired: 0, failed: true })
      .mockRejectedValueOnce(new Error('private driver password and SQL'));
    const app = await createTestApp({
      env: { MONITOR_DASHBOARD_TOKEN: 'flush-token' },
      configure: builder => builder.overrideProvider(IngestionProcessor).useValue(mocks.processor)
        .overrideProvider(IngestionBuffer).useValue(mocks.buffer),
    });
    try {
      for (let index = 0; index < 2; index++) {
        const response = await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush')
          .set('Authorization', 'Bearer flush-token').expect(503);
        expect(response.body.ok).toBe(false);
        expect(response.text).not.toContain('private driver');
      }
      expect(mocks.buffer.status).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  /** 即使消费已结束，状态读取失败也不能承诺缓冲已排空。 */
  it('Redis 状态读取失败时返回 503', async () => {
    const mocks = dependencies();
    mocks.buffer.status.mockRejectedValue(new ServiceUnavailableException('Redis ingestion buffer unavailable'));
    const controller = new IngestionController(
      mocks.buffer as unknown as IngestionBuffer,
      mocks.processor as unknown as IngestionProcessor,
    );
    await expect(controller.flush({ status: jest.fn() } as unknown as Response))
      .rejects.toMatchObject({ status: 503 });
  });

  /** 使用虚拟计时验证超时，不等待真实 30 秒，也不取消后台正在运行的事务。 */
  it('等待 30 秒后返回 202，消费任务随后仍可完成', async () => {
    jest.useFakeTimers();
    try {
      const mocks = dependencies();
      let finish!: (value: FlushResult) => void;
      mocks.processor.flushNow.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      mocks.buffer.status.mockResolvedValue({ depth: 0, inflight: 1, bytes: 100 });
      const response = { status: jest.fn() };
      const controller = new IngestionController(
        mocks.buffer as unknown as IngestionBuffer,
        mocks.processor as unknown as IngestionProcessor,
      );
      const pending = controller.flush(response as unknown as Response);
      await jest.advanceTimersByTimeAsync(FLUSH_WAIT_MS);
      await expect(pending).resolves.toMatchObject({ ok: true, completed: false, processed: null, inflight: 1 });
      expect(response.status).toHaveBeenCalledWith(202);
      finish({ batches: 1, written: 1, invalid: 0, expired: 0, failed: false });
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});

/** 消费器行为测试验证手动路径继续使用原批次确认和全局锁协议。 */
describe('立即消费与后台消费共享任务', () => {
  /** 用有序批次和结果验证统计在 SQL 之后、Redis 确认成功后累计。 */
  it('跨批次处理并仅累计成功确认的结果', async () => {
    const order: string[] = [];
    const buffer = {
      claim: jest.fn().mockResolvedValueOnce(['first']).mockResolvedValueOnce(['second']).mockResolvedValue([]),
      renew: jest.fn(async () => true),
      ack: jest.fn(async () => { order.push('ack'); return true; }),
      fail: jest.fn(),
    };
    const writer = { write: jest.fn()
      .mockImplementationOnce(async () => { order.push('write'); return { written: 500, invalid: 0, expired: 0 }; })
      .mockImplementationOnce(async () => { order.push('write'); return { written: 1, invalid: 1, expired: 1 }; }) };
    const processor = new IngestionProcessor(buffer as unknown as IngestionBuffer, writer as unknown as BatchWriter);
    const result = await processor.flushNow();
    expect(result).toEqual({ batches: 2, written: 501, invalid: 1, expired: 1, failed: false });
    expect(order).toEqual(['write', 'ack', 'write', 'ack']);
    expect(buffer.claim.mock.calls.every(call => call[1] === true)).toBe(true);
    await processor.beforeApplicationShutdown();
  });

  /** HTTP 与 Bull 同时触发时共用一个 Promise，不重复执行写入。 */
  it('多个手动请求与后台触发共用同一消费任务', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const buffer = {
      claim: jest.fn().mockResolvedValueOnce(['row']).mockResolvedValue([]),
      renew: jest.fn(async () => true), ack: jest.fn(async () => true), fail: jest.fn(),
    };
    const writer = { write: jest.fn(async () => { await gate; return { written: 1, invalid: 0, expired: 0 }; }) };
    const processor = new IngestionProcessor(buffer as unknown as IngestionBuffer, writer as unknown as BatchWriter);
    const first = processor.flushNow();
    const second = processor.flushNow();
    const background = processor.flush();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(writer.write).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second, background]);
    expect(buffer.ack).toHaveBeenCalledTimes(1);
    await processor.beforeApplicationShutdown();
  });

  /** 确认所有者不匹配时不删除别人的批次，也不把 SQL 提交量误算为确认量。 */
  it('租约确认失败时停止领取并保留未确认统计', async () => {
    const buffer = {
      claim: jest.fn(async () => ['row']), renew: jest.fn(async () => true),
      ack: jest.fn(async () => false), fail: jest.fn(),
    };
    const writer = { write: jest.fn(async () => ({ written: 1, invalid: 0, expired: 0 })) };
    const processor = new IngestionProcessor(buffer as unknown as IngestionBuffer, writer as unknown as BatchWriter);
    expect(await processor.flushNow()).toMatchObject({ batches: 0, written: 0, failed: false });
    expect(buffer.claim).toHaveBeenCalledTimes(1);
    expect(buffer.fail).not.toHaveBeenCalled();
    await processor.beforeApplicationShutdown();
  });

  /** 暂时性写入故障登记重试并反馈失败，不执行 Redis 确认。 */
  it('SQL 故障保留批次并让手动调用获知失败', async () => {
    const buffer = {
      claim: jest.fn(async () => ['row']), renew: jest.fn(async () => true),
      ack: jest.fn(), fail: jest.fn(async () => undefined),
    };
    const writer = { write: jest.fn(async () => { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }); }) };
    const processor = new IngestionProcessor(buffer as unknown as IngestionBuffer, writer as unknown as BatchWriter);
    expect(await processor.flushNow()).toMatchObject({ failed: true, batches: 0, written: 0 });
    expect(buffer.fail).toHaveBeenCalledTimes(1);
    expect(buffer.ack).not.toHaveBeenCalled();
    await processor.beforeApplicationShutdown();
  });

  /** 虚拟时间模拟写入期间续租失败，验证即使 SQL 后续成功也不确认旧租约。 */
  it('续租丢失后不确认已被接管的批次', async () => {
    jest.useFakeTimers();
    try {
      let finish!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const buffer = {
        claim: jest.fn(async () => ['row']), renew: jest.fn(async () => false),
        ack: jest.fn(), fail: jest.fn(),
      };
      const writer = { write: jest.fn(async () => { await gate; return { written: 1, invalid: 0, expired: 0 }; }) };
      const processor = new IngestionProcessor(buffer as unknown as IngestionBuffer, writer as unknown as BatchWriter);
      const pending = processor.flushNow();
      await jest.advanceTimersByTimeAsync(10000);
      finish();
      expect(await pending).toMatchObject({ batches: 0, written: 0, failed: false });
      expect(buffer.renew).toHaveBeenCalledTimes(1);
      expect(buffer.ack).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await processor.beforeApplicationShutdown();
    } finally { jest.useRealTimers(); }
  });
});
