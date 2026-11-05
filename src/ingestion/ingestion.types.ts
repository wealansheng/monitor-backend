/** 异步采集内部协议：缓冲信封、批次结果与依赖注入标识。 */
import type { MonitorEventPayload, MonitorRequestMeta } from '../monitor/monitor.types';
import type { RecordChunk } from '../records/record.protocol';

/** 每次接收分配独立标识；消费者重试复用该标识，SDK 重新上报则分配新标识。 */
export type BufferedMessage = {
  /** 服务端生成的接收 UUID，用于普通事件消费幂等。 */
  id: string;
  /** 服务端接收时间，单位毫秒，也用于计算最老等待时间。 */
  receivedAt: number;
} & (
  /** 普通事件保留入口载荷和请求上下文，由消费者完成表字段投影。 */
  { kind: 'event'; payload: MonitorEventPayload; meta: MonitorRequestMeta }
  /** Replay 在入口完成分片校验，消费者再计算入库变体摘要。 */
  | { kind: 'record'; payload: RecordChunk }
);

/** 批次确认时更新的处理计数；written 包括成功执行幂等重试的消息。 */
export interface BatchResult {
  /** 有效写入处理量，可能包括唯一键命中后的无操作更新。 */
  written: number;
  /** 因非法信封、字段转换或不可恢复数据错误而丢弃的数量。 */
  invalid: number;
  /** 因事件时间早于保留截止时间而丢弃的数量。 */
  expired: number;
}

/** Bull 控制队列名称，任务不保存日志载荷。 */
export const INGEST_QUEUE = 'monitor-ingestion';
/** 应用载荷缓冲使用的 Redis 长连接注入令牌。 */
export const INGEST_REDIS = Symbol('INGEST_REDIS');

/** 一次共享消费任务的累计结果；计数只包括成功确认的批次。 */
export interface FlushResult extends BatchResult {
  /** 已确认的批次数，沿用单批条数与字节限制。 */
  batches: number;
  /** 是否遇到写入或确认故障，手动接口据此返回 503。 */
  failed: boolean;
}
